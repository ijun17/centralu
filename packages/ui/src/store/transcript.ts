import type { Attachment, NormalizedEvent, StoredMessage, SubagentStep } from '@cc/protocol'
import { projectAccessQuestion } from '@cc/core'

/**
 * The conversation transcript — the rows a session's conversation draws, and the pure rules that
 * build them from live events (`appendChat`) and from stored history (`messagesToChat`). Nothing
 * here touches the zustand store; the store wires these in (docs/state-management.md §2).
 */

/**
 * An attachment plus the bytes needed to display it.
 *
 * `data` is used only to render the image thumbnail — storage and transfer always go through the
 * path (D-1). When sending, the just-read bytes are already at hand, so they are filled in
 * without a round trip; after a restart, the host supplies the file again from `loadMessages`
 * (the same rule as the agent images in #40).
 */
export type ChatAttachment = Attachment & { data?: string }

export type ChatItem = (
  /**
   * pending: the UI drew this optimistically and has not yet gotten the host's confirmation
   * (`user_message`).
   * from: a message that another session sent, not the person (FR-11 — orchestrator instructions,
   * worker reports).
   */
  /**
   * attachments: things sent along with it. Images are drawn as real thumbnails (the successor to
   * the 📎 label — back when the label was mixed into the text, what was drawn and what was sent
   * could differ, causing a double render, #75).
   */
  | {
      kind: 'user'
      seq: number
      text: string
      attachments?: ChatAttachment[]
      pending?: boolean
      from?: { sessionId: string; name: string }
      /** A message sent by an in-conversation app view (M4 B-1) — the person chose to send it, but the app wrote it */
      fromApp?: { appId: string; projectId: string | null; name: string }
    }
  | { kind: 'assistant'; seq: number; text: string }
  /** A reasoning summary (#58). Only codex gives text — claude's thinking shows only through the session's thinkingTokens */
  | { kind: 'reasoning'; seq: number; text: string }
  /*
   * An image the agent produced (#40). Persisted as a file (under attachments/, referenced by path,
   * 500MB cap). If `data` is empty, `note` says why (failures are shown, not hidden).
   */
  | { kind: 'image'; seq: number; mime: string; data: string; path?: string; note?: string }
  /**
   * live: the tail of output while running (#58, codex outputDelta). Discarded once `result` comes
   * in — the full output lives in `result`.
   * callId: the name by which the result/output finds its own row (#98) — falls back to the old
   * positional rule (`ownerOf`) when absent.
   */
  | {
      kind: 'tool'
      seq: number
      tool: string
      title: string
      readOnly: boolean
      callId?: string
      result?: string
      ok?: boolean
      live?: string
    }
  | { kind: 'approval'; seq: number; requestId: string; summary: string; decision?: string }
  /**
   * A boundary marker for the conversation (e.g. a compaction point). A fact about the conversation, not part of it.
   * `notice` is there when the line is a tool's notice the host made readable (#342); `text` is then its one-line form.
   */
  | { kind: 'mark'; seq: number; text: string; notice?: NoticeLine }
) & {
  /**
   * The **number within the session** the host assigned when it stored this row (the store's
   * `messages.seq`, #79).
   *
   * This is a different number from `seq`. `seq` is the React key, and live items get theirs from
   * `chatSeq`, which is shared across all sessions. The history cursor (`history.oldestSeq`) and the
   * merge of history with live items go **only by this number**. If the render key were to leak
   * into the cursor, `loadOlder` would start reading from the wrong place: the first time the
   * session for an app's requested agent was opened, a stored 8-line session ended up with a
   * cursor of 48, and the whole conversation got appended a second time (measured 2026-09-25).
   *
   * Absent on rows that are never stored (like `message_image`, whose event carries no number, or
   * an optimistic message before confirmation). A merged message carries the number of its first chunk
   * — the same rule the host's `loadMessages` uses.
   */
  storedSeq?: number
}

/**
 * The render key counter for live conversation items. ONE counter shared by every session — see
 * `ChatItem.storedSeq` for why it must never stand in for a stored number.
 */
let chatSeq = 0

/** The next render key for a live conversation item */
export function nextChatKey(): number {
  return ++chatSeq
}

/** Pushes the counter up so it always uses a number bigger than any item brought in from the store */
export function bumpChatKeysAbove(items: { seq: number }[]): void {
  for (const it of items) if (it.seq > chatSeq) chatSeq = it.seq
}

/**
 * The **tool row that owns** this result or live output (#98).
 *
 * Found by `callId`. This used to be found by position — a result went to "the oldest open row," and
 * live output to "the last open row." That was because a row did not carry a `callId`, and while only
 * one thing was ever open at a time, position and ownership were the same thing. A background agent's
 * card breaks that: it stays open the whole time its parent uses a different tool, so the positional
 * rule ended up **attaching the parent's Bash result to the agent card**, and routed the agent's
 * steps to the parent's open Bash card — reproducing on screen exactly the "mixed together with no
 * way to tell who did what" the issue described.
 *
 * A row with a `callId` only ever receives its own. The old positional rule is used only among rows
 * with no `callId` at all — kept for the shape of an older fixture that carries the call and its
 * result separately. Measured: across 44,140 `tool_call` rows in the store (28,517 claude, 15,623
 * codex), `callId` has never once collided within a single session (2026-09-25).
 */
function ownerOf(items: ChatItem[], callId: string, fallback: 'oldest' | 'latest'): number {
  if (callId) {
    const mine = items.findIndex((i) => i.kind === 'tool' && i.callId === callId)
    if (mine !== -1) return mine
  }
  const open = (i: ChatItem | undefined) => i?.kind === 'tool' && i.callId === undefined && i.result === undefined
  if (fallback === 'oldest') return items.findIndex(open)
  for (let i = items.length - 1; i >= 0; i--) if (open(items[i])) return i
  return -1
}

/** Carries the stored number the host sent along onto the item (#79) — omitted when there is none */
const stored = (seq: number | undefined): { storedSeq?: number } => (seq === undefined ? {} : { storedSeq: seq })

/**
 * Does this hold a row with this stored number already (#79)?
 *
 * If a history page arrives first and an event for the same row follows (replaying an event held in
 * the pen), the same message would appear twice. Rows with the same stored number are the same row.
 * Used only for events where one row is one item. A streaming chunk carrying the same number more
 * than once is normal, so it is not filtered here.
 */
function holds(items: ChatItem[], seq: number | undefined): boolean {
  return seq !== undefined && items.some((i) => i.storedSeq === seq)
}

/**
 * Does this chunk continue the last item's message (#77) — **a different stored number means a
 * different message.**
 *
 * The host groups a message's chunks into one row (#66) and carries that row's number on every
 * chunk. So chunks of the same message share a number, while a new reply with no human message in
 * between (a background task finished, a question card was answered) arrives under a new number.
 * While this only checked the kind and appended blindly, two such messages ran together into one
 * paragraph with no gap ("…still running.All six reviews are in."). History (`messagesToChat`) also
 * counts one row as one item — both paths draw the same screen this way.
 *
 * The unnumbered side is still appended: an unstored empty chunk (arrives with no number), and a
 * message that started with no number (its empty chunk arrived first).
 */
function continues<K extends 'assistant' | 'reasoning'>(
  last: ChatItem | undefined,
  kind: K,
  seq: number | undefined,
): last is Extract<ChatItem, { kind: K }> {
  return last?.kind === kind && (seq === undefined || last.storedSeq === undefined || last.storedSeq === seq)
}

/**
 * The conversation with one row replaced: one copy of the list, every other row the same object (#364).
 *
 * Streaming replaces a row per delta, and the focused conversation can hold thousands of rows after reading back
 * through history (2,200 in the spike, docs/spikes/2026-10-memory-heavy-store.md). The delta paths used to copy the
 * list twice (`slice(0, -1)` and a spread) or build it with `map` and a closure per row; a list has to be new for the
 * screen to see the change, but once is enough.
 */
function replaceAt(items: ChatItem[], index: number, item: ChatItem): ChatItem[] {
  const next = items.slice()
  next[index] = item
  return next
}

/** Converts an event to a conversation item (a streaming delta is appended to the same message's item — `continues`) */
export function appendChat(items: ChatItem[], e: NormalizedEvent): ChatItem[] {
  switch (e.type) {
    case 'message_delta': {
      const last = items[items.length - 1]
      if (continues(last, 'assistant', e.seq)) {
        // A message that started with no number (its unstored empty chunk arrived first) receives the first number learned
        return replaceAt(items, items.length - 1, { ...last, text: last.text + e.text, ...(last.storedSeq === undefined ? stored(e.seq) : {}) })
      }
      return [...items, { kind: 'assistant', seq: ++chatSeq, ...stored(e.seq), text: e.text }]
    }
    case 'reasoning_delta': {
      // A chunk with no text (claude's token estimate) belongs to session state (`thinkingTokens`), not the conversation
      if (!e.text) return items
      const last = items[items.length - 1]
      if (continues(last, 'reasoning', e.seq)) {
        return replaceAt(items, items.length - 1, { ...last, text: last.text + e.text, ...(last.storedSeq === undefined ? stored(e.seq) : {}) })
      }
      return [...items, { kind: 'reasoning', seq: ++chatSeq, ...stored(e.seq), text: e.text }]
    }
    case 'tool_call':
      if (holds(items, e.seq)) return items
      return [
        ...items,
        {
          kind: 'tool',
          seq: ++chatSeq,
          ...stored(e.seq),
          tool: e.summary.tool,
          title: e.summary.title,
          readOnly: e.summary.readOnly,
          ...(e.callId ? { callId: e.callId } : {}),
        },
      ]
    case 'message_image':
      return [
        ...items,
        { kind: 'image', seq: ++chatSeq, mime: e.mime, data: e.data, path: e.path, note: e.note },
      ]
    case 'tool_result': {
      /*
       * A result attaches to **its own call's row** (#98 — `ownerOf`). Among rows with no `callId`,
       * that is the longest-open row (2026-09-12): last-wins had swapped the results of two calls
       * opened back to back. Restoration (`messagesToChat`) uses the same rule — the same screen must
       * never end up pairing things differently across the two paths.
       */
      const real = ownerOf(items, e.callId, 'oldest')
      if (real === -1) return items
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      // `live` is discarded here — the full completed output has already arrived as `result`, so the chunk's job is done
      return replaceAt(items, real, { ...target, result: e.summary, ok: e.ok, live: undefined })
    }
    /*
     * Live output while running (#58). Attaches to its own call's row (`ownerOf`) — having several
     * calls open at once actually happens: a background agent's card stays open the whole time its
     * parent uses a different tool, and that agent's own steps arrive through this same path (#98).
     * Never attached to an already-closed row — its result already carries the whole output. Only the
     * tail is kept: what needs showing is "what is coming out right now," not the full text.
     */
    case 'tool_output_delta': {
      const real = ownerOf(items, e.callId, 'latest')
      if (real === -1) return items
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      if (target.result !== undefined) return items
      const live = ((target.live ?? '') + e.text).slice(-4000)
      return replaceAt(items, real, { ...target, live })
    }
    case 'approval_request':
      /*
       * The same card stands again — when the host re-raises a capability question's card (M4 D-4)
       * after whatever other card was covering it closes. The conversation already has one row for
       * it: this never draws a second one.
       */
      if (items.some((it) => it.kind === 'approval' && it.requestId === e.requestId && it.decision === undefined)) return items
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
                    : e.detail.raw,
        },
      ]
    case 'approval_resolved':
      return items.map((it) =>
        it.kind === 'approval' && it.requestId === e.requestId ? { ...it, decision: e.decision } : it,
      )
    case 'user_message': {
      /*
       * If I sent it, it is already drawn — this only confirms it.
       * If someone else sent it (the orchestrator's `send_to_session`), this is the only path by
       * which it appears on screen at all. Before this branch existed, an injected message was only
       * stored, never shown.
       *
       * A message carrying `from` is excluded from confirmation matching (FR-11) — if the person
       * happened to have the same sentence sitting pending, the orchestrator's instruction would be
       * absorbed into that bubble and its origin marker would quietly disappear. Matching by text is
       * an assumption that only holds among my own messages.
       */
      /*
       * The match is made against **the text as sent** (#75). Back when attachments were mixed into
       * `text` as a 📎 label, what was drawn and what was sent differed, so confirmation never lined
       * up and a second bubble was appended (discovered on codex). Now that attachments are a
       * separate field, `text` is exactly the text sent — this identity is what this match relies on.
       */
      // A message sent by an app (M4 B-1) is also excluded from the human message's confirmation match — its origin marker must never be absorbed into a human bubble
      // Already confirmed by the merge with history (#79) — a history page arrived before this event
      if (holds(items, e.seq)) return items
      const idx = e.from || e.fromApp ? -1 : items.findIndex((i) => i.kind === 'user' && i.pending && i.text === e.text)
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
            // Attachments of a message inserted by the host (M4 C-5) — only a path and a name. Image bytes come when history is re-read
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
      // Only the model's own context was folded — our record stays intact. Where it was folded must
      // be shown so someone can read back past that point
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), text: compactionText(e) }]
    case 'handoff':
      // Where this session came from (#102). The note's full text lives only in the stored payload — this is a single line
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), text: handoffText(e) }]
    // A fresh conversation inside the session (#304) and what the tool wanted read (#304): one quiet line each
    case 'conversation_reset':
    case 'notice':
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), ...markerParts(e) }]
    /*
     * A failed turn is also kept in the conversation (#107).
     *
     * An error used to only change state and pass through. So a turn that died with a 400 was
     * indistinguishable on screen from **nothing having happened at all** — an empty reply, and
     * "waiting for a human." What happened must be visible in the transcript: the session badge
     * recovers once the next turn starts, but even then the person still has no idea why.
     */
    case 'error':
      // A session's error is recorded as a marker row and carries its number (#161) — matched by number like every other stored row
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), text: errorText(e) }]
    default:
      return items
  }
}

/**
 * What to write on the compaction marker.
 *
 * "Compacted" alone is not enough. The worst case is a failure that looks like a success, and
 * how much it shrank tells someone roughly when the next compaction might come (only when the tool
 * reports it).
 */
export function compactionText(e: Extract<NormalizedEvent, { type: 'compaction' }>): string {
  if (e.failed) return `Compaction failed — ${e.reason ?? 'unknown reason'}`
  if (e.before != null && e.after != null) {
    return `Context compacted here · ${fmtTokens(e.before)} → ${fmtTokens(e.after)}`
  }
  return 'Earlier messages were compacted here'
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/**
 * What to write on the handoff marker (#102).
 *
 * The note's full text is never drawn here — it can run to megabytes, and the successor's first
 * message already carries a preview. What this states is the single fact that "this session
 * continues that one," and the full text is kept in the record alongside that fact.
 */
export function handoffText(e: Extract<NormalizedEvent, { type: 'handoff' }>): string {
  return `Handed off from "${e.from}" — the note is kept with this session`
}

/**
 * The line a fresh conversation leaves (#304). What matters is that the model no longer knows anything above it — the
 * record does, which is why the line exists at all.
 */
export function resetText(e: Extract<NormalizedEvent, { type: 'conversation_reset' }>): string {
  return e.trigger === 'clear'
    ? 'Conversation cleared — the agent remembers nothing above this line'
    : 'The agent started a new conversation here — it remembers nothing above this line'
}

/** The stored marker kinds this build can word (`markerText`) */
const KNOWN_MARKERS: ReadonlySet<string> = new Set(['compaction', 'handoff', 'error', 'conversation_reset', 'notice'])

/** One stored or live marker's line — the live and restored paths must never word the same marker differently */
export function markerText(e: Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>): string {
  switch (e.type) {
    case 'handoff':
      return handoffText(e)
    case 'error':
      return errorText(e)
    case 'conversation_reset':
      return resetText(e)
    // The tool's own sentence, as is (#304) — the same rule as an error's. A readable notice leads with who and what (#342)
    case 'notice': {
      const line = noticeLine(e)
      if (!line) return e.text
      return [line.head, line.audience && audienceText(line.audience)].filter(Boolean).join(' · ') + ` — ${line.body}`
    }
    default:
      return compactionText(e)
  }
}

/**
 * The readable parts of a tool's notice (#342), for the line that draws it. The owner saw two Codex notices in a row
 * that read like the same kind of problem: one about the person's own `config.toml`, one about how Centralu loads
 * history, which they can do nothing about. So the line says who is speaking and what kind of notice it is
 * (`head`), whose it is to act on (`audience`), and for a notice the host recognized, a plain explanation (`summary`,
 * `items`, `hint`) with the tool's own words (`original`) one click away.
 */
export type NoticeLine = {
  /** "Codex · config warning" */
  head: string
  audience?: 'you' | 'centralu'
  /** What the line says after who and what: the plain explanation, or the tool's own text when there is none */
  body: string
  summary?: string
  items?: string[]
  hint?: string
  /** The tool's own words, shown on demand when there is a summary; absent when they are the line itself */
  original?: string
  /** Who said `original`, for the control that shows it */
  from: string
}

/** A notice's readable parts, or null for one the host did not place (stored before #342): it reads as its text alone */
export function noticeLine(e: Extract<NormalizedEvent, { type: 'notice' }>): NoticeLine | null {
  if (!e.from) return null
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

/** Whose notice it is to act on, in the words the line uses (#342) */
export function audienceText(a: 'you' | 'centralu'): string {
  return a === 'you' ? 'for you' : 'for Centralu'
}

/** A marker's text, and for a readable notice its parts — the live and restored paths build the row the same way */
function markerParts(e: Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>): {
  text: string
  notice?: NoticeLine
} {
  const notice = e.type === 'notice' ? noticeLine(e) : null
  return notice ? { text: markerText(e), notice } : { text: markerText(e) }
}

/** A failed turn's one line (#107) — carries the tool's own sentence as is. Rewording it into our own words would erase the cause */
export function errorText(e: Extract<NormalizedEvent, { type: 'error' }>): string {
  // No turn was running — the conversation could not be opened at all (#168, item 5)
  if (e.error.code === 'conversation_locked') return `Could not open this conversation — ${e.error.message}`
  return `The agent could not finish this turn — ${e.error.message}`
}

/** A live subagent step as the stored row the host would read back (#222) — the same shape `messagesToChat` draws */
export function subagentRow(sessionId: string, seq: number, step: SubagentStep): StoredMessage {
  const kind = step.type === 'message_delta' ? 'text' : step.type === 'reasoning_delta' ? 'reasoning' : step.type
  return { sessionId, seq, role: kind === 'text' || kind === 'reasoning' ? 'assistant' : 'system', kind, payload: step, ts: Date.now() }
}

/** Message restoration (on restart, or switching sessions) */
export function messagesToChat(msgs: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of msgs) {
    if (m.kind === 'text' && m.role === 'user') {
      const p = m.payload as {
        text?: string
        from?: { sessionId: string; name: string }
        fromApp?: { appId: string; projectId: string | null; name: string }
        attachments?: ChatAttachment[]
      }
      items.push({
        kind: 'user',
        seq: m.seq,
        storedSeq: m.seq,
        text: String(p?.text ?? ''),
        ...(p?.from ? { from: p.from } : {}),
        ...(p?.fromApp ? { fromApp: p.fromApp } : {}),
        // Attachment restoration — image bytes (`data`) come from the host reading the file inside `loadMessages`
        ...(p?.attachments?.length ? { attachments: p.attachments } : {}),
      })
    } else if (m.kind === 'text' || m.kind === 'reasoning') {
      // One row is one message (#77) — neighboring rows are different replies and are never merged (the same rule as live's `continues`)
      const e = m.payload as { text?: string }
      items.push({ kind: m.kind === 'text' ? 'assistant' : 'reasoning', seq: m.seq, storedSeq: m.seq, text: e.text ?? '' })
    } else if (m.kind === 'marker') {
      // The stored payload is the event itself — live and restored paths must never produce different wording
      const e = m.payload as Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>
      /*
       * A marker kind this build does not know (one a newer host stored) is left out. It used to be drawn as a
       * compaction, the only marker there was at first — so a #304 notice read back by an older window would have said
       * "Earlier messages were compacted here".
       */
      if (typeof e.type === 'string' && !KNOWN_MARKERS.has(e.type)) continue
      items.push({ kind: 'mark', seq: m.seq, storedSeq: m.seq, ...markerParts(e) })
    } else if (m.kind === 'tool_call') {
      const e = m.payload as { callId?: string; summary?: { tool: string; title: string; readOnly: boolean } }
      if (e.summary)
        items.push({
          kind: 'tool',
          seq: m.seq,
          storedSeq: m.seq,
          tool: e.summary.tool,
          title: e.summary.title,
          readOnly: e.summary.readOnly,
          ...(e.callId ? { callId: e.callId } : {}),
        })
    } else if (m.kind === 'tool_result') {
      /*
       * A restored tool card also **carries its output** (2026-09-12, surfaced in a demo scene).
       *
       * The host keeps `tool_call` and `tool_result` as separate rows, but only the `tool_call` branch
       * existed here. So reopening a session left the card with only its title, its output gone
       * completely — a screen that had only ever been visible to whoever watched it live. The
       * attachment rule is the same as live's (`appendChat`): **its own call's row** (`ownerOf`, #98)
       * — among old-shaped rows with no `callId`, the longest-open row with no result yet.
       *
       * If no match is found (a page boundary put its `tool_call` outside this batch), it is silently
       * dropped — attaching an ownerless output to the conversation as a new row would invent a
       * message that never existed. Attaching it to someone else's open card would also invent one:
       * the positional rule would grab whatever background agent card happened to occupy that spot.
       */
      const e = m.payload as { callId?: string; summary?: string; ok?: boolean }
      const i = ownerOf(items, e.callId ?? '', 'oldest')
      const it = items[i]
      if (it?.kind === 'tool') items[i] = { ...it, result: e.summary ?? '', ok: e.ok }
    } else if (m.kind === 'image') {
      // An image is persisted (#40, second pass) — the host resends the bytes by reading the file again
      const e = m.payload as { mime?: string; data?: string; path?: string; note?: string }
      items.push({
        kind: 'image',
        seq: m.seq,
        storedSeq: m.seq,
        mime: e.mime ?? '',
        data: e.data ?? '',
        path: e.path,
        note: e.note,
      })
    }
  }
  return items
}
