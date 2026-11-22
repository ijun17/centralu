import { formatCount } from '../app/format.js'
import {
  subagentStepRow,
  type Attachment,
  type MailDelivered,
  type NormalizedEvent,
  type StoredMessage,
  type SubagentStep,
  type ToolSummary,
} from '@cc/protocol/client'
import {
  agentStartQuestion,
  centraluUpdateQuestion,
  projectAccessQuestion,
  projectCreateQuestion,
} from '@cc/core'

// A conversation's rows, built by one set of rules from live events (`appendChat`) and stored history
// (`messagesToChat`), so both paths draw the same screen. Pure; the store wires it in.

/**
 * `data` only draws the thumbnail; storage and transfer go by path. Sending fills it from the bytes at hand; after a
 * restart the host supplies it in `loadMessages`.
 */
export type ChatAttachment = Attachment & { data?: string }

export type ChatItem =
  /**
   * pending: drawn before the host's `user_message` confirmed it. from: sent by another session, not the person (FR-11).
   * attachments: kept apart from the text, so what is drawn and what was sent never differ (#75).
   */
  (
    | {
        kind: 'user'
        seq: number
        text: string
        attachments?: ChatAttachment[]
        pending?: boolean
        from?: { sessionId: string; name: string }
        /** Sent by an in-conversation app view (apps-plan B-1): the person sent it, the app wrote it */
        fromApp?: { appId: string; projectId: string | null; name: string }
        /** A first message a script wrote, drawn as the script's */
        fromScript?: { credential: string }
      }
    | { kind: 'assistant'; seq: number; text: string }
    /** Only codex gives reasoning text (#58); claude's thinking shows only as the session's thinkingTokens */
    | { kind: 'reasoning'; seq: number; text: string }
    // An agent's image (#40), a file under attachments/ (500MB cap); with `data` empty, `note` says why
    | { kind: 'image'; seq: number; mime: string; data: string; path?: string; name?: string; note?: string }
    /** live: the output's tail while running, dropped once `result` holds it all (#58). callId: see `ownerOf`. */
    | {
        kind: 'tool'
        seq: number
        tool: string
        title: string
        /** The files the call names, so the card can link them */
        paths?: string[]
        /** A call to one of Centralu's own servers (#730), drawn apart from the rest */
        centralu?: ToolSummary['centralu']
        callId?: string
        result?: string
        ok?: boolean
        live?: string
      }
    | { kind: 'approval'; seq: number; requestId: string; summary: string; decision?: string }
    /**
     * A fact about the conversation, not part of it (a compaction point). `mark` comes from the event (#2338), never
     * guessed from the words; `notice` is a tool's notice the host made readable (#342).
     */
    | { kind: 'mark'; seq: number; text: string; mark: MarkKind; notice?: NoticeLine; pickModel?: true }
  ) & {
    /**
     * The host's number for the stored row (`messages.seq`, #79), not `seq`, the render key shared across sessions. The
     * history cursor and the merge go only by this: a leaked render key appends the conversation twice. Absent on rows
     * never stored; a merged message carries its first chunk's number, as `loadMessages` does.
     */
    storedSeq?: number
    /** Epoch ms: the stored `ts`, or when a live row arrived; a live answer's moves with each chunk, so it reads as finished */
    at?: number
  }

/**
 * One render key counter (React and virtual-scroll key) for every session. It must never overlap an item read back
 * from the store, or two items draw in one spot: `bumpChatKeysAbove` pushes it past each.
 */
let chatSeq = 0

export function nextChatKey(): number {
  return ++chatSeq
}

export function bumpChatKeysAbove(items: { seq: number }[]): void {
  for (const it of items) if (it.seq > chatSeq) chatSeq = it.seq
}

/**
 * By `callId` (#98): a background agent's card stays open while its parent uses other tools, so position would misattach.
 * Measured 2026-09-25: no `callId` collision within a session across 44,140 `tool_call` rows (28,517 claude, 15,623 codex).
 */
function ownerOf(items: ChatItem[], callId: string): number {
  return callId ? items.findIndex((i) => i.kind === 'tool' && i.callId === callId) : -1
}

const stored = (seq: number | undefined): { storedSeq?: number } =>
  seq === undefined ? {} : { storedSeq: seq }

/**
 * A history page can arrive before an event for the same row (a pen replay), which would draw it twice (#79). Not for
 * streaming chunks, which repeat their number by design.
 */
function holds(items: ChatItem[], seq: number | undefined): boolean {
  return seq !== undefined && items.some((i) => i.storedSeq === seq)
}

/**
 * A different stored number is a different message (#77): every chunk carries its row's number, and two replies with no
 * human message between would otherwise run into one paragraph. An unnumbered side still appends.
 */
function continues<K extends 'assistant' | 'reasoning'>(
  last: ChatItem | undefined,
  kind: K,
  seq: number | undefined,
): last is Extract<ChatItem, { kind: K }> {
  return last?.kind === kind && (seq === undefined || last.storedSeq === undefined || last.storedSeq === seq)
}

/**
 * One copy per streaming delta (docs/state-management.md §4): a focused conversation can hold thousands of rows (2,200
 * in docs/spikes/2026-10-memory-heavy-store.md).
 */
function replaceAt(items: ChatItem[], index: number, item: ChatItem): ChatItem[] {
  const next = items.slice()
  next[index] = item
  return next
}

/** A tool call's row, the same whether it arrived live or was read back (`appendChat`, `pushStored`) */
function toolItem(
  seq: number,
  storedSeq: { storedSeq?: number },
  callId: string | undefined,
  summary: { tool: string; title: string; paths?: string[]; centralu?: ToolSummary['centralu'] },
): ChatItem {
  return {
    kind: 'tool',
    seq,
    ...storedSeq,
    tool: summary.tool,
    title: summary.title,
    ...(summary.paths?.length ? { paths: summary.paths } : {}),
    ...(summary.centralu ? { centralu: summary.centralu } : {}),
    ...(callId ? { callId } : {}),
  }
}

function appendText(items: ChatItem[], kind: 'assistant' | 'reasoning', e: { seq?: number; text: string }): ChatItem[] {
  const last = items[items.length - 1]
  if (continues(last, kind, e.seq)) {
    // A message whose first chunk came unnumbered takes the first number learned
    return replaceAt(items, items.length - 1, {
      ...last,
      text: last.text + e.text,
      ...(last.storedSeq === undefined ? stored(e.seq) : {}),
    })
  }
  // As the host's record (`persistMessage`): an empty chunk starts no item, or it is a bubble with nothing in it (#2447)
  if (!e.text) return items
  return [...items, { kind, seq: ++chatSeq, ...stored(e.seq), text: e.text }]
}

export function appendChat(items: ChatItem[], e: NormalizedEvent): ChatItem[] {
  switch (e.type) {
    case 'message_delta':
      return appendText(items, 'assistant', e)
    case 'reasoning_delta':
      // A chunk with no text (claude's token estimate) belongs to session state (`thinkingTokens`), not the conversation
      return e.text ? appendText(items, 'reasoning', { seq: e.seq, text: e.text }) : items
    case 'tool_call':
      if (holds(items, e.seq)) return items
      return [...items, toolItem(++chatSeq, stored(e.seq), e.callId, e.summary)]
    case 'message_image':
      // Matched by number (#868): the host's row holds a path, not bytes, so a re-read cannot pair it by content
      if (holds(items, e.seq)) return items
      return [
        ...items,
        {
          kind: 'image',
          seq: ++chatSeq,
          ...stored(e.seq),
          mime: e.mime,
          data: e.data,
          path: e.path,
          name: e.name,
          note: e.note,
        },
      ]
    case 'tool_result': {
      // Its own call's row (#98), the same rule as `messagesToChat`
      const real = ownerOf(items, e.callId)
      if (real === -1) return items
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      return replaceAt(items, real, { ...target, result: e.summary, ok: e.ok, live: undefined })
    }
    // Never onto a closed row: its result holds the whole output. Only the tail shows what is coming out now (#58).
    case 'tool_output_delta': {
      const real = ownerOf(items, e.callId)
      if (real === -1) return items
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      if (target.result !== undefined) return items
      const live = ((target.live ?? '') + e.text).slice(-4000)
      return replaceAt(items, real, { ...target, live })
    }
    case 'approval_request':
      // The host re-raises a capability card once the card over it closes (apps-plan D-4); it has a row already
      if (
        items.some(
          (it) => it.kind === 'approval' && it.requestId === e.requestId && it.decision === undefined,
        )
      )
        return items
      if (holds(items, e.seq)) return items
      return [
        ...items,
        {
          kind: 'approval',
          seq: ++chatSeq,
          ...stored(e.seq),
          requestId: e.requestId,
          summary:
            e.detail.kind === 'command'
              ? e.detail.command
              : e.detail.kind === 'file_edit'
                ? e.detail.path
                : e.detail.kind === 'capability'
                  ? `${e.detail.app.name} wants to ${e.detail.text}`
                  : e.detail.kind === 'project_access'
                    ? projectAccessQuestion(e.detail)
                    : e.detail.kind === 'project_create'
                      ? projectCreateQuestion(e.detail)
                      : e.detail.kind === 'project_add'
                        ? e.detail.text
                      : e.detail.kind === 'agent_start'
                        ? agentStartQuestion(e.detail)
                        : e.detail.kind === 'centralu_update'
                          ? centraluUpdateQuestion(e.detail)
                          : e.detail.raw,
        },
      ]
    case 'approval_resolved':
      return items.map((it) =>
        it.kind === 'approval' && it.requestId === e.requestId ? { ...it, decision: e.decision } : it,
      )
    case 'user_message': {
      /*
       * Confirms the person's pending bubble by the text as sent (#75), or draws another sender's message, which has no
       * other way on screen. One from another session, an app or a script never confirms a pending bubble (FR-11): its
       * origin mark would be absorbed. A history page may have confirmed it already (#79).
       */
      if (holds(items, e.seq)) return items
      const idx =
        e.from || e.fromApp || e.fromScript ? -1 : items.findIndex((i) => i.kind === 'user' && i.pending && i.text === e.text)
      if (idx === -1)
        return [
          ...items,
          {
            kind: 'user',
            seq: ++chatSeq,
            storedSeq: e.seq,
            text: e.text,
            ...(e.from ? { from: e.from } : {}),
            ...(e.fromApp ? { fromApp: e.fromApp } : {}),
            ...(e.fromScript ? { fromScript: e.fromScript } : {}),
            // Host-inserted (apps-plan C-5): a path and a name only; image bytes come with a history re-read
            ...(e.attachments?.length ? { attachments: e.attachments } : {}),
          },
        ]
      return items.map((it, i) =>
        i === idx ? { ...(it as Extract<ChatItem, { kind: 'user' }>), pending: false, storedSeq: e.seq } : it,
      )
    }
    case 'history_synced':
      // The actual content already went into the store — the screen re-reads it outside `dispatchEvent`
      return items
    case 'compaction':
      // Only the model's context was folded; the mark shows where, so one can read back past it
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), ...markerParts(e) }]
    case 'handoff':
      // The note's full text stays in the stored payload (#102)
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), ...markerParts(e) }]
    // A fresh conversation inside the session and a tool's notice: one quiet line each (#304)
    case 'conversation_reset':
    case 'notice':
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), ...markerParts(e) }]
    // A failed turn stays in the conversation (#107): a state change alone reads as nothing having happened
    case 'error':
      // Matched by number like every stored row (#161)
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), ...markerParts(e) }]
    default:
      return items
  }
}

/** A failure must not read as success; how much it shrank hints when the next compaction comes */
function compactionText(e: Extract<NormalizedEvent, { type: 'compaction' }>): string {
  if (e.failed) return `Compaction failed — ${e.reason ?? 'unknown reason'}`
  if (e.before != null && e.after != null) {
    return `Context compacted here · ${formatCount(e.before)} → ${formatCount(e.after)}`
  }
  return 'Earlier messages were compacted here'
}

/** Never the note itself (#102): it can run to megabytes, and the successor's first message carries a preview */
function handoffText(e: Extract<NormalizedEvent, { type: 'handoff' }>): string {
  return `Handed off from "${e.from}" — the note is kept with this session`
}

/** The model knows nothing above this line, the record does: why the line exists (#304) */
function resetText(e: Extract<NormalizedEvent, { type: 'conversation_reset' }>): string {
  return e.trigger === 'clear'
    ? 'Conversation cleared — the agent remembers nothing above this line'
    : 'The agent started a new conversation here — it remembers nothing above this line'
}

/** The stored marker kinds this build can word (`markerText`) */
const KNOWN_MARKERS: ReadonlySet<string> = new Set([
  'compaction',
  'handoff',
  'error',
  'conversation_reset',
  'notice',
])

/** The live and restored paths must never word the same marker differently */
function markerText(
  e: Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>,
): string {
  switch (e.type) {
    case 'handoff':
      return handoffText(e)
    case 'error':
      return errorText(e)
    case 'conversation_reset':
      return resetText(e)
    // The tool's own sentence as is (#304); a readable notice leads with who and what (#342)
    case 'notice': {
      const line = noticeLine(e)
      if (!line) return e.text
      if (line.mail) return line.body
      const shown = audienceShown(line)
      return [line.head, shown && audienceText(shown)].filter(Boolean).join(' · ') + `: ${line.body}`
    }
    default:
      return compactionText(e)
  }
}

/**
 * Two notices can read alike while only one is the person's to act on (#342), so the line says who and what (`head`),
 * whose (`audience`), and the host's plain explanation with the tool's own words (`original`) one click away.
 */
export type NoticeLine = {
  /** "Codex · config warning" */
  head: string
  audience?: 'you' | 'centralu'
  body: string
  summary?: string
  items?: string[]
  hint?: string
  /** Absent when the tool's words are the line itself */
  original?: string
  from: string
  /** A line Centralu's mail left: drawn as the mail capsule, with no head (#2332) */
  mail?: true
  /** What a delivery's line folds open to (#2333); absent from an older host's line and an older row */
  delivered?: MailDelivered[]
}

/** null for a notice stored before #342: it reads as its text alone */
function noticeLine(e: Extract<NormalizedEvent, { type: 'notice' }>): NoticeLine | null {
  if (!e.from) return null
  // A row stored before #2332 starts with the ✉ the host wrote then; the capsule's icon stands for it now (the old comma stays)
  if (e.from === 'Centralu' && e.label === 'mail') return { head: '', from: e.from, body: e.text.replace(/^✉\s*/, ''), mail: true, ...(e.mail?.length ? { delivered: e.mail } : {}) }
  return {
    head: e.label ? `${e.from} · ${e.label}` : e.from,
    from: e.from,
    body: e.summary ?? e.text,
    ...(e.audience ? { audience: e.audience } : {}),
    ...(e.summary ? { summary: e.summary, original: e.text } : {}),
    ...(e.items?.length ? { items: e.items } : {}),
    ...(e.hint ? { hint: e.hint } : {}),
  }
}

export function audienceText(a: 'you' | 'centralu'): string {
  return a === 'you' ? 'for you' : 'for Centralu'
}

/**
 * null for Centralu's notice for Centralu: "for Centralu" adds nothing to its speaker (owner, 2026-11-18). One answer
 * for the capsule and the copied text.
 */
export function audienceShown(n: Pick<NoticeLine, 'audience' | 'from'>): 'you' | 'centralu' | null {
  if (!n.audience) return null
  return n.audience === 'centralu' && n.from === 'Centralu' ? null : n.audience
}

/** For the icon (#2338): `failed` draws a dashed box, every other kind a capsule; the window adds `notice` lines too */
export type MarkKind = 'compaction' | 'handoff' | 'reset' | 'notice' | 'failed'

function markKind(e: Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>): MarkKind {
  if (e.type === 'error' || (e.type === 'compaction' && e.failed)) return 'failed'
  return e.type === 'conversation_reset' ? 'reset' : e.type
}

function markerParts(
  e: Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>,
): {
  text: string
  mark: MarkKind
  notice?: NoticeLine
  pickModel?: true
} {
  const notice = e.type === 'notice' ? noticeLine(e) : null
  const line = { text: markerText(e), mark: markKind(e) }
  if (e.type === 'error' && refusedModel(e)) return { ...line, pickModel: true }
  return notice ? { ...line, notice } : line
}

/** The host marks a refused model in `error.data` (#1369) */
function refusedModel(e: Extract<NormalizedEvent, { type: 'error' }>): string | null {
  const data: unknown = e.error.data
  if (typeof data !== 'object' || data === null || !('reason' in data) || data.reason !== 'model_rejected') return null
  return 'model' in data && typeof data.model === 'string' ? data.model : null
}

/** The tool's own sentence as is: rewording it would erase the cause (#107) */
function errorText(e: Extract<NormalizedEvent, { type: 'error' }>): string {
  // No turn was running: the conversation could not be opened at all (#168)
  if (e.error.code === 'conversation_locked') return `Could not open this conversation — ${e.error.message}`
  // Trying again cannot help; picking another model can, and the row offers it (#1369)
  if (refusedModel(e)) return `The agent could not finish this turn — ${e.error.message} Pick another model for this session to continue.`
  return `The agent could not finish this turn — ${e.error.message}`
}

/** A live subagent step as the stored row the host would read back (#222) — the same shape `messagesToChat` draws */
export function subagentRow(sessionId: string, seq: number, step: SubagentStep): StoredMessage {
  return { sessionId, seq, ...subagentStepRow(step), payload: step, ts: Date.now() }
}

export function messagesToChat(msgs: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of msgs) {
    const before = items.length
    pushStored(items, m)
    for (let k = before; k < items.length; k++) items[k] = stampSaid(items[k]!, m.ts)
  }
  return items
}

export function stampSaid(item: ChatItem, at: number): ChatItem {
  return { ...item, at }
}

function pushStored(items: ChatItem[], m: StoredMessage): void {
  {
    if (m.kind === 'text' && m.role === 'user') {
      const p = m.payload as {
        text?: string
        from?: { sessionId: string; name: string }
        fromApp?: { appId: string; projectId: string | null; name: string }
        fromScript?: { credential: string }
        attachments?: ChatAttachment[]
      }
      items.push({
        kind: 'user',
        seq: m.seq,
        storedSeq: m.seq,
        text: String(p?.text ?? ''),
        ...(p?.from ? { from: p.from } : {}),
        ...(p?.fromApp ? { fromApp: p.fromApp } : {}),
        ...(p?.fromScript ? { fromScript: p.fromScript } : {}),
        ...(p?.attachments?.length ? { attachments: p.attachments } : {}),
      })
    } else if (m.kind === 'text' || m.kind === 'reasoning') {
      // One row is one message (#77), the rule live's `continues` follows
      const e = m.payload as { text?: string }
      items.push({
        kind: m.kind === 'text' ? 'assistant' : 'reasoning',
        seq: m.seq,
        storedSeq: m.seq,
        text: e.text ?? '',
      })
    } else if (m.kind === 'marker') {
      // The stored payload is the event itself
      const e = m.payload as Extract<
        NormalizedEvent,
        { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }
      >
      // A kind a newer host stored is left out: drawn as a known kind, it would be worded wrongly
      if (typeof e.type !== 'string' || !KNOWN_MARKERS.has(e.type)) return
      items.push({ kind: 'mark', seq: m.seq, storedSeq: m.seq, ...markerParts(e) })
    } else if (m.kind === 'tool_call') {
      const e = m.payload as {
        callId?: string
        summary?: { tool: string; title: string; paths?: string[]; centralu?: ToolSummary['centralu'] }
      }
      if (e.summary) items.push(toolItem(m.seq, { storedSeq: m.seq }, e.callId, e.summary))
    } else if (m.kind === 'tool_result') {
      // Onto its own call's row (#98); with the call outside this page it is dropped, as a new row would invent a message
      const e = m.payload as { callId?: string; summary?: string; ok?: boolean }
      const i = ownerOf(items, e.callId ?? '')
      const it = items[i]
      if (it?.kind === 'tool') items[i] = { ...it, result: e.summary ?? '', ok: e.ok }
    } else if (m.kind === 'image') {
      // The host reads the persisted file again for the bytes (#40)
      const e = m.payload as { mime?: string; data?: string; path?: string; name?: string; note?: string }
      items.push({
        kind: 'image',
        seq: m.seq,
        storedSeq: m.seq,
        mime: e.mime ?? '',
        data: e.data ?? '',
        path: e.path,
        name: e.name,
        note: e.note,
      })
    }
  }
}
