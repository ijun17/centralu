import { errorMessage } from '@cc/protocol/client'
import type { SessionSummary } from '@cc/core'
import { formatBytes } from '../../app/format.js'
import type { AppState, Draft, StoreGet, StoreSet } from '../state.js'
import { EMPTY_DRAFT } from '../state.js'
import { ifSessionStill, omitKey } from '../patch.js'
import { trackWorkingSince } from '../sessionList.js'
import { nextChatKey, type ChatAttachment, type ChatItem } from '../transcript.js'

/** Above this the app visibly freezes in the base64 conversion and the WS send */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** In chunks: one character at a time rebuilds the string each time, freezing the app for tens of seconds on a screenshot */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

/**
 * One decision for the composer's hint and `send` (#125, #174). `answer`: exactly one question and no attachment.
 * `drops`: the text cannot answer the open question (several questions, which the card needs all of, or an attachment);
 * sending starts a new turn and drops it. `none`: no open question.
 */
export function composerTarget(
  open: SessionSummary['pendingQuestions'],
  hasAttachments: boolean,
): 'answer' | 'drops' | 'none' {
  if (open.length === 0) return 'none'
  return open.length === 1 && open[0]!.questions.length === 1 && !hasAttachments ? 'answer' : 'drops'
}

/** A line left in the conversation for a question dropped by a new turn (#174) */
export function droppedQuestionsText(questions: string[]): string {
  const quoted = questions.map((q) => `"${q}"`).join(', ')
  return questions.length === 1
    ? `Question dropped — this message started a new turn instead of answering ${quoted}`
    : `Questions dropped — this message started a new turn instead of answering ${quoted}`
}

/** A message of unknown send status (#173), by bubble render key; settled after reconnecting */
type UnsureSend = {
  sessionId: string
  text: string
  attachments?: ChatAttachment[]
  prevState?: SessionSummary['state']
  prevInterruption?: SessionSummary['interruption']
}
const unsureSends = new Map<number, UnsureSend>()

/** The text goes back to the composer, which cleared on send (#38): without it the sentence would be nowhere */
function unsend(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  u: UnsureSend & { seq: number },
  reason: string,
): void {
  set((s) => {
    const sessions =
      s.sessions[u.sessionId] && u.prevState
        ? {
            ...s.sessions,
            [u.sessionId]: {
              ...s.sessions[u.sessionId]!,
              state: u.prevState,
              interruption: u.prevInterruption ?? null,
            },
          }
        : s.sessions
    const drafts = draftsWith(s.drafts, u.sessionId, u.text, u.attachments)
    return {
      chat: { ...s.chat, [u.sessionId]: (s.chat[u.sessionId] ?? []).filter((i) => i.seq !== u.seq) },
      drafts,
      // Nothing is left to wait for, so the "working" indicator comes down too
      sessions,
      // ...and the clock we started above stops with it, so a later turn cannot inherit it
      workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      toast: `Could not send: ${reason}`,
    }
  })
}

/** Text written meanwhile is kept after it: the failed message came first */
function draftsWith(
  drafts: Record<string, Draft>,
  sessionId: string,
  text: string,
  attachments?: ChatAttachment[],
): Record<string, Draft> {
  const cur = drafts[sessionId] ?? EMPTY_DRAFT
  return {
    ...drafts,
    [sessionId]: {
      text: cur.text ? `${text}\n${cur.text}` : text,
      attachments: [...(attachments ?? []), ...cur.attachments],
    },
  }
}

function restoreDraft(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  sessionId: string,
  text: string,
  attachments?: ChatAttachment[],
): void {
  set((s) => (s.sessions[sessionId] ? { drafts: draftsWith(s.drafts, sessionId, text, attachments) } : {}))
}

/**
 * After reconnecting (#173), merging the latest page (`mergePage`) settles a message the host received; one still
 * pending, or with history unreadable, is undone. The gap left: a session still reviving may store it after.
 */
export async function settleUnsureSends(
  get: () => AppState,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
): Promise<void> {
  const mine = [...unsureSends].filter(([, u]) => get().sessions[u.sessionId])
  for (const [seq] of [...unsureSends]) if (!mine.some(([s]) => s === seq)) unsureSends.delete(seq)
  for (const id of new Set(mine.map(([, u]) => u.sessionId))) await get().loadHistory(id)
  for (const [seq, u] of mine) {
    unsureSends.delete(seq)
    const item = get().chat[u.sessionId]?.find((i) => i.seq === seq)
    if (item?.kind === 'user' && item.pending) unsend(set, { ...u, seq }, 'Connection lost')
  }
}

type SendActions = Pick<AppState, 'setDraft' | 'dismissKeptDraft' | 'attachFile' | 'send'>

export const sendActions = (set: StoreSet, get: StoreGet): SendActions => ({
  setDraft(sessionId, draft) {
    set((s) => {
      // An empty draft is never kept — otherwise leftovers pile up even as sessions get deleted
      if (!draft.text && draft.attachments.length === 0) {
        if (!(sessionId in s.drafts)) return {}
        const { [sessionId]: _gone, ...rest } = s.drafts
        return { drafts: rest }
      }
      return { drafts: { ...s.drafts, [sessionId]: draft } }
    })
  },

  dismissKeptDraft(sessionId) {
    set((s) => (s.keptDrafts.some((d) => d.sessionId === sessionId) ? { keptDrafts: s.keptDrafts.filter((d) => d.sessionId !== sessionId) } : {}))
  },

  /** Saves a file that came in through paste or drag to the host, and receives its attachment info (FR-13) */
  async attachFile(sessionId, file) {
    const platform = get().platform
    if (!platform) return null
    if (file.size > MAX_ATTACHMENT_BYTES) {
      set({ toast: `${file.name} is too large (max ${formatBytes(MAX_ATTACHMENT_BYTES)})` })
      return null
    }
    const count = (d: number) =>
      set((s) => {
        const n = (s.uploading[sessionId] ?? 0) + d
        const { [sessionId]: _was, ...rest } = s.uploading
        return { uploading: n > 0 ? { ...rest, [sessionId]: n } : rest }
      })
    count(1)
    try {
      const buf = await file.arrayBuffer()
      const b64 = toBase64(new Uint8Array(buf))
      const saved = await platform.agents.saveAttachment(
        sessionId,
        file.name,
        file.type || 'application/octet-stream',
        b64,
      )
      // The thumbnail draws from the bytes just read, with no round trip
      return saved.kind === 'image' ? { ...saved, data: b64 } : saved
    } catch (e) {
      set({ toast: `Could not attach: ${errorMessage(e)}` })
      return null
    } finally {
      count(-1)
    }
  },

  async send(sessionId, text, attachments) {
    /*
     * With one open question the text is its answer: a new turn would end an unanswered `AskUserQuestion` as a refused
     * tool use (`error_during_execution`), and the card's "Other" slot already means this. Not with several questions
     * (sending half lets the model invent the rest) or an attachment (an answer would discard it).
     */
    const open = get().sessions[sessionId]?.pendingQuestions ?? []
    const target = composerTarget(open, !!attachments?.length)
    if (target === 'answer' && text.trim()) {
      const only = open[0]!
      const landed = await get().answerQuestion(sessionId, only.requestId, [
        { question: only.questions[0]!.question, answers: [text.trim()] },
      ])
      // A failed answer goes back to the composer (#180): an answer leaves no bubble to recall. Nothing is resent.
      if (!landed) restoreDraft(set, sessionId, text, attachments)
      return
    }
    // The new turn drops the open question's card (#174), so a line says what was dropped
    const dropped = target === 'drops' ? open.flatMap((q) => q.questions.map((x) => x.question)) : []

    const seq = nextChatKey()
    // Working from the instant it is sent: a sleeping session takes seconds to revive, silent meanwhile. A failure is
    // undone below.
    const prevState = get().sessions[sessionId]?.state
    // A new turn is also the end of whatever stopped the last one (#698), as the reducer's own move to working says
    const prevInterruption = get().sessions[sessionId]?.interruption ?? null
    set((s) => {
      const sessions = s.sessions[sessionId]
        ? {
            ...s.sessions,
            [sessionId]: { ...s.sessions[sessionId]!, state: 'working' as const, interruption: null },
          }
        : s.sessions
      return {
        // `pending` until the host's `user_message` settles it, or the message would draw twice
        chat: {
          ...s.chat,
          [sessionId]: [
            ...(s.chat[sessionId] ?? []),
            // Attachments never go into `text`: it stays what was sent, which the confirmation matches on (#75)
            {
              kind: 'user',
              seq,
              text,
              ...(attachments?.length ? { attachments } : {}),
              pending: true,
              at: Date.now(),
            },
          ],
        },
        sessions,
        // The wait starts here: counting from the host's reply would undercount the waits of a waking session
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      }
    })
    // The host wakes a sleeping session before the message goes in (#568); it reads as waking (`resuming`) meanwhile
    const waking = get().sessions[sessionId]?.live === false && !get().resuming[sessionId]
    if (waking) set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      // The bytes are already in a file on the host: only the path goes
      await get().platform!.agents.send(
        sessionId,
        text,
        attachments?.map(({ data: _, ...a }) => a),
      )
      if (dropped.length) {
        const mark: ChatItem = { kind: 'mark', seq: nextChatKey(), text: droppedQuestionsText(dropped), mark: 'notice' }
        set((s) => {
          const items = s.chat[sessionId] ?? []
          const at = items.findIndex((i) => i.seq === seq)
          return at < 0
            ? {}
            : { chat: { ...s.chat, [sessionId]: [...items.slice(0, at), mark, ...items.slice(at)] } }
        })
      }
      // A successful send means the sleeping session was revived (the host resumes it on its own)
      set(
        ifSessionStill(sessionId, (s, cur) => ({
          sessions: cur.live ? s.sessions : { ...s.sessions, [sessionId]: { ...cur, live: true } },
          wakeError: omitKey(s.wakeError, sessionId),
          // Sent, so no lock: the fork offer goes
          wakeLocked: omitKey(s.wakeLocked, sessionId),
          wakeErrorSaid: omitKey(s.wakeErrorSaid, sessionId),
        })),
      )
    } catch (err) {
      const e = err as Error & { code?: string }
      // Unknown whether it was sent (#173): the host may have stored it (common mid-revive), and putting the text back
      // would send it twice. Left pending for `settleUnsureSends`.
      if (e.code === 'connection_lost') {
        unsureSends.set(seq, { sessionId, text, attachments, prevState, prevInterruption })
        set({ toast: 'Connection lost while sending — checking whether it arrived once reconnected' })
        return
      }
      // Said and undone, or the person waits forever; a sleeping session's failed revive lands here too
      unsend(set, { seq, sessionId, text, attachments, prevState, prevInterruption }, e.message)
    } finally {
      if (waking) set((st) => ({ resuming: omitKey(st.resuming, sessionId) }))
    }
  },
})
