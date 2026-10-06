import type { SessionInfo, StoredMessage } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'

/**
 * The read side of a session's transcript that the manager turns into labels, previews,
 * recall context and orchestrator memory. Only reads stored messages, so it needs no more of
 * the store than this.
 */
export type MessageReader = Pick<Store, 'loadMessages' | 'loadMessagesFrom'>

/**
 * How much past conversation to hand a new orchestrator (line count and line length).
 *
 * This text is appended to the system prompt, so it has a budget. Include everything and
 * regaining context spends all of it; include too little and "what were we talking about" is
 * lost. 40 lines x 600 characters leaves the trunk of the last few turns — if detail is needed,
 * recall searches our store.
 */
const MEMORY_MESSAGES = 40
const MEMORY_LINE_CHARS = 600

/**
 * Budget for restoring the area around a recall hit (#66) — measured in **characters**, not count.
 *
 * When a row was a delta, 120 rows were a sentence or two, but once a row is a message, 120 rows
 * can be hundreds of thousands of characters — a single recall could burn through the
 * orchestrator's whole context. So it fills starting from the messages nearest the target point,
 * with a per-message cap and an overall budget.
 */
const CONTEXT_SPAN_MSGS = 8
const CONTEXT_MSG_CHARS = 600
const CONTEXT_CHARS = 4000

function payloadHasFrom(payload: unknown): boolean {
  return payload !== null && typeof payload === 'object' && 'from' in payload
}

function payloadText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || !('text' in payload)) return ''
  const text = payload.text
  return typeof text === 'string' ? text : String(text ?? '')
}

/**
 * A name a person can actually **tell sessions apart by.**
 *
 * A session that has gone through compaction ends up with the same name every time: "This session
 * is being continued from a previous…" (the compaction summary becomes the first user message, and
 * the auto-name just picks that up). During dogfooding, four sessions in list_sessions all shared
 * the same title — it is barely disambiguated today by the project name, but **two sessions in the
 * same project still cannot be told apart.** The orchestrator must never guess in that case, so it
 * would have had to keep asking the person every single time.
 *
 * In that case, **the first real instruction** is used as the name instead of the title. It says
 * what the session is actually doing far better than the title ever could.
 */
export function labelOf(reader: MessageReader, s: SessionInfo): string {
  if (!/^This session is being continued|^Caveat: The messages below/i.test(s.name)) return s.name
  // Since this is measured in messages, 100 is plenty (#66) — 400 messages was a correction from the days
  // rows were deltas
  const rows = reader.loadMessages(s.id, 100)
  for (const r of rows) {
    if (r.kind !== 'text' || r.role !== 'user') continue
    const t = ((r.payload as { text?: string }).text ?? '').trim()
    // Skips the compaction summary itself — that is exactly what ruined the name in the first place
    if (!t || /^This session is being continued|^Caveat:/i.test(t)) continue
    const one = t.replace(/\s+/g, ' ').slice(0, 60)
    return `${one}${t.length > 60 ? '…' : ''} (resumed session)`
  }
  return `${s.name.slice(0, 40)}…`
}

/**
 * Restores the conversation **around that spot.**
 *
 * The budget is measured in **characters**, not count (#66). When a row was a delta, 120 rows was a
 * sentence or two, plenty — but once a row is a message, the same count can be hundreds of thousands
 * of characters, and a single recall could burn through the orchestrator's whole context. So it
 * alternates (before, after), filling from the messages nearest the target point, and stops at a
 * per-message cap and an overall budget.
 */
export function contextAt(reader: MessageReader, sessionId: string, seq: number): string {
  // seq+1: toward the front, including the target row itself, and then toward the back
  const before = reader.loadMessages(sessionId, CONTEXT_SPAN_MSGS, seq + 1)
  const after = reader.loadMessagesFrom(sessionId, seq, CONTEXT_SPAN_MSGS)
  const nearFirst: StoredMessage[] = []
  const b = [...before].reverse()
  for (let i = 0; i < Math.max(b.length, after.length); i++) {
    if (b[i]) nearFirst.push(b[i]!)
    if (after[i]) nearFirst.push(after[i]!)
  }
  let budget = CONTEXT_CHARS
  const chosen: StoredMessage[] = []
  for (const r of nearFirst) {
    if (r.kind !== 'text') continue
    const t = ((r.payload as { text?: string }).text ?? '').slice(0, CONTEXT_MSG_CHARS)
    if (!t) continue
    if (budget < t.length) break
    budget -= t.length
    chosen.push(r)
  }
  chosen.sort((x, y) => x.seq - y.seq)
  const parts: string[] = []
  for (const r of chosen) {
    const t = ((r.payload as { text?: string }).text ?? '').slice(0, CONTEXT_MSG_CHARS)
    // A person's message marks the boundary — mixing up who said what would only cause confusion
    parts.push(r.role === 'user' ? `\n[person] ${t}\n` : t)
  }
  return parts.join('')
}

/** When it last moved — used to tell which session's conversation is happening right now */
export function lastActiveOf(reader: MessageReader, sessionId: string): string | undefined {
  const rows = reader.loadMessages(sessionId, 1)
  const ts = rows[rows.length - 1]?.ts
  return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : undefined
}

/** The timestamp of that spot — needed to order conversations across several sessions */
export function timeOf(reader: MessageReader, sessionId: string, seq: number): string | undefined {
  const rows = reader.loadMessages(sessionId, 1, seq + 1)
  const ts = rows[0]?.ts
  return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : undefined
}

export function previewOf(reader: MessageReader, sessionId: string, maxChars = 120): string {
  // Reading is in units of merged messages (#66) — finding the last response no longer needs hundreds of
  // rows
  const rows = reader.loadMessages(sessionId, 30)
  const parts: string[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    const isAssistantText = r.kind === 'text' && r.role === 'assistant'
    if (isAssistantText) {
      parts.unshift((r.payload as { text?: string }).text ?? '')
      continue
    }
    // Hitting a different kind after collection has started means this is the start of that response
    if (parts.length > 0) break
    // If nothing has been collected yet, tool calls and the like are skipped to find the response before
    // them
    const title = (r.payload as { summary?: { title?: string } }).summary?.title
    if (r.kind === 'tool_call' && title && rows.every((x) => x.role !== 'assistant')) {
      return title.slice(0, maxChars)
    }
  }
  const text = parts.join('').trim()
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

/**
 * **Hands past memory over** to a freshly born orchestrator.
 *
 * Switching tools splits off a new process, and that tool's context disappears with it — the screen
 * still shows the conversation from yesterday exactly as it was, while the party on the other end
 * knows none of it. For a worker session, "started a new conversation" is an honest description, but
 * the orchestrator is the app's one and only **standing counterpart.** Losing its memory is losing
 * the relationship itself, so this has to be handled differently.
 *
 * Since that conversation still exists in our own store, a summary of it is appended to the new
 * process's system prompt. This is not a resume — it is a **handoff**: it cannot restore it word for
 * word, but it hands over what was being talked about.
 *
 * **Only the person's own words and its own answers go in.** Tool results (the body of another
 * session pulled in through read_session or recall) are excluded: opening a path where text a worker
 * wrote gets promoted into a system prompt would recreate exactly the channel from lower privilege
 * to higher privilege (the same reason orchestrator-home.ts turns off folder documents).
 */
export function orchestratorMemory(reader: MessageReader, sessionId: string): string {
  const rows = reader.loadMessages(sessionId, MEMORY_MESSAGES)
  const lines: string[] = []
  for (const m of rows) {
    if (m.kind !== 'text') continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (payloadHasFrom(m.payload)) continue
    const text = payloadText(m.payload).trim()
    if (!text) continue
    lines.push(`${m.role === 'user' ? 'Person' : 'Me'}: ${text.slice(0, MEMORY_LINE_CHARS)}`)
  }
  if (lines.length === 0) return ''
  return [
    '',
    '# Past conversation (before this process started)',
    'A summary pulled from the record of this app. The context disappeared when the tool changed, but the conversation continues —',
    'do not act like this is a first meeting; look further with recall if needed.',
    ...lines,
  ].join('\n')
}
