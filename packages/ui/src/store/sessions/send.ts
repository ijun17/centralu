import type { SessionSummary } from '@cc/core'
import { formatBytes } from '../../app/format.js'
import type { AppState, Draft, StoreGet, StoreSet } from '../state.js'
import { EMPTY_DRAFT } from '../state.js'
import { ifSessionStill, omitKey } from '../patch.js'
import { trackWorkingSince } from '../sessionList.js'
import { nextChatKey, type ChatAttachment, type ChatItem } from '../transcript.js'

/**
 * What the composer sends: its draft, a file attached to it, and a message sent to a session, drawn at
 * once and taken back when it fails, or checked against the store after a reconnect when it is not
 * known whether it arrived (#173). A message to a session with one open question answers it.
 */

/** The attachment size cap. Above this, the app visibly freezes both during the base64 conversion and the WS send */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Bytes → base64.
 *
 * Appending one character at a time (`binary += String.fromCharCode(b)`) rebuilds the string from
 * scratch every time, freezing the app for tens of seconds even for a single screenshot (a few MB)
 * — the screen looks as if nothing is happening. This was in fact the reported symptom "file
 * attachment does not work." Processed in chunks instead.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

/**
 * What the composer's text becomes relative to an open question (#125, #174) — the composer's hint
 * text and `send` use **the same decision**. While the two were decided separately (the hint
 * text did not look at attachments), a person who attached a file was told to "write an answer," and
 * the text went to a new turn instead.
 *
 *  - `answer`: exactly one question, and no attachments — the text is that question's answer.
 *  - `drops`: a question is open but the text cannot be its answer. When one request has several
 *    questions, the card requires all of them answered, and a single line of text cannot say which
 *    one it answers, nor does an answer have room for an attachment. Sending it starts a new turn and
 *    the question is dropped.
 *  - `none`: no open question.
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

/** A message of unknown send status (#173) — bubble render key → what is needed to undo it. Cleared against the store after reconnecting */
type UnsureSend = {
  sessionId: string
  text: string
  attachments?: ChatAttachment[]
  prevState?: SessionSummary['state']
  prevInterruption?: SessionSummary['interruption']
}
const unsureSends = new Map<number, UnsureSend>()

/**
 * Undoes a message that failed to send — removes the bubble, returns the written text and
 * attachments to the composer, and returns "working" to its previous state.
 *
 * The written text goes back to the composer. The composer is cleared the instant a message is sent
 * (#38), so merely removing the bubble leaves the sentence **nowhere at all** — a toast reports the
 * failure but does not give the text back. If new text was written before the failure arrived, it is
 * not overwritten but prepended in front of it: in order, the failed message was written first.
 */
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

/** Prepends unsent text and attachments to that session's draft — text written in the meantime is not overwritten (in order, the failed message came first) */
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
 * Resolves messages of unknown send status after reconnecting (#173). Merging in the store's latest
 * page (`mergePage`) settles a message the host received into the stored row for that same sentence
 * — reconnect replay may already have confirmed it via `user_message` first. If it is still pending
 * even so, the host never received it, and it is undone at that point. It is also undone if history
 * could not be read at all — a message that could not be confirmed cannot be treated as sent.
 *
 * The remaining gap: if the host is in the middle of reviving a sleeping session and has not yet
 * stored the message, it arrives only after this has already undone it here.
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

/** The store's actions for what the composer sends */
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
      // An image draws its thumbnail immediately from the bytes just read — no round trip to the host is needed
      return saved.kind === 'image' ? { ...saved, data: b64 } : saved
    } catch (e) {
      set({ toast: `Could not attach: ${(e as Error).message}` })
      return null
    } finally {
      count(-1)
    }
  },

  async send(sessionId, text, attachments) {
    /*
     * **If a question is open, the composer's text is that question's answer, not a new turn.**
     *
     * This used to not check `pendingQuestions` at all. So sending text while a card was up cut off
     * the turn in progress, and an `AskUserQuestion` that never got an answer was cleaned up as
     * **a refused tool use** — the card vanished for no visible reason and the turn broke with
     * `error_during_execution` (an actual incident, 2026-09-23: the person only typed "can you ask
     * the question again?" and the question disappeared).
     *
     * Instead of blocking it, the intent is honored. Writing an answer by hand because none of the
     * options fit is a natural thing to do, and the card already has an "Other — write your own" slot.
     * The gesture and its meaning already agree.
     *
     * This is only done **when there is exactly one question.** With several questions in one
     * request, the card requires all of them answered (sending half lets the model invent the rest),
     * and a single line of text has no way to say which one it answers. It also steps aside when
     * there is an attachment — sending it as an answer would discard the attachment.
     */
    const open = get().sessions[sessionId]?.pendingQuestions ?? []
    const target = composerTarget(open, !!attachments?.length)
    if (target === 'answer' && text.trim()) {
      const only = open[0]!
      const landed = await get().answerQuestion(sessionId, only.requestId, [
        { question: only.questions[0]!.question, answers: [text.trim()] },
      ])
      /*
       * An answer that failed to land is put back into the composer (#180) — the same rule as a
       * normal send. The composer clears the instant it is sent, and an answer never leaves a bubble
       * in the conversation, so it cannot even be pulled back with the ↑ recall. If the question has
       * already gone (the host swapped it out), its card is dismissed too, and with nothing put back,
       * the written text would be nowhere at all. Putting it back never resends anything — if the
       * answer actually did land, the person just sees the card gone and can delete the text
       * themselves.
       */
      if (!landed) restoreDraft(set, sessionId, text, attachments)
      return
    }
    /*
     * The text cannot be an answer, but a question is open (#174) — sending it starts a new turn, and
     * a question left unanswered is cleaned up as a refused tool use, so its card disappears. The
     * composer's hint text says this before sending (`composerTarget`), and after sending, a line is
     * left in the conversation saying what was dropped — a card that vanishes with no explanation
     * would leave no trace that a question ever existed.
     */
    const dropped = target === 'drops' ? open.flatMap((q) => q.questions.map((x) => x.question)) : []

    const seq = nextChatKey()
    /*
     * Marked as "working" the instant it is sent.
     *
     * The host does send a `state_change`, but a sleeping session takes a few seconds to revive its
     * process, and the screen sits completely silent during that time — it is impossible to even tell
     * whether it was sent. What we already know is already settled: **it was sent, and an answer is
     * awaited.** A failure is undone below.
     */
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
        /*
          pending: I just drew this and have not yet gotten the host's confirmation.
          Once the host reports the same message via `user_message`, this item is settled into it —
          without this marker, the same message would be drawn twice.
        */
        chat: {
          ...s.chat,
          [sessionId]: [
            ...(s.chat[sessionId] ?? []),
            // Attachments are never mixed into `text` as a label (a 📎 name) — an image is drawn as a
            // real thumbnail, a file as a separate chip. `text` stays exactly what was sent, so
            // matching it against the `user_message` confirmation also relies on this (#75).
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
        /*
          The wait starts here, not when the host's first event lands. Waking a sleeping
          session can take seconds, and those seconds are the ones a person is staring at —
          counting from the host's reply would quietly undercount the worst waits.
        */
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      }
    })
    /*
     * A message to a sleeping session wakes it first (#568): the host resumes it before the message goes in. The
     * session reads as waking meanwhile, the same `resuming` a wake from the composer sets, so its line says so.
     */
    const waking = get().sessions[sessionId]?.live === false && !get().resuming[sessionId]
    if (waking) set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      // The bytes already live in a file on the host — the send only carries the path (carrying `data` would double the payload)
      await get().platform!.agents.send(
        sessionId,
        text,
        attachments?.map(({ data: _, ...a }) => a),
      )
      if (dropped.length) {
        const mark: ChatItem = { kind: 'mark', seq: nextChatKey(), text: droppedQuestionsText(dropped) }
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
          // Having sent successfully means the lock is gone — no reason to keep offering the fork option
          wakeLocked: omitKey(s.wakeLocked, sessionId),
        })),
      )
    } catch (err) {
      const e = err as Error & { code?: string }
      /*
       * **Unknown whether it was sent** (#173). If the socket drops, the client refuses a call that
       * never got an answer with `connection_lost` — but the host may already have received, stored
       * and broadcast that request (this is common when the connection drops while a sleeping session
       * is being revived). Reporting that as a failure and putting the text back would have the person
       * send it again, and the same instruction goes through twice. The bubble is instead left as
       * pending, and checked against the store after reconnecting (`settleUnsureSends`) — if it is
       * confirmed there, it was sent; if not, it is undone at that point.
       */
      if (e.code === 'connection_lost') {
        unsureSends.set(seq, { sessionId, text, attachments, prevState, prevInterruption })
        set({ toast: 'Connection lost while sending — checking whether it arrived once reconnected' })
        return
      }
      // Silently swallowing a send failure would leave the person standing there waiting for an
      // answer forever. The bubble that looks sent is removed and what to do is reported.
      // The host revives a sleeping session on its own before sending — reaching this point means reviving itself failed
      unsend(set, { seq, sessionId, text, attachments, prevState, prevInterruption }, e.message)
    } finally {
      if (waking) set((st) => ({ resuming: omitKey(st.resuming, sessionId) }))
    }
  },
})
