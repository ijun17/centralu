import type { NormalizedEvent } from '@cc/protocol'
import type { HistoryEvent, HistoryMessage } from './contract.js'

/** The session id a history line's event carries until the host stores it under the session's own (`HistoryEvent`) */
export const HISTORY_SESSION = ''

const isHistoryEvent = (e: NormalizedEvent): e is HistoryEvent => e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'compaction'

/**
 * The lines a live normalizer's events leave in an imported conversation (#843): its tool calls, their results and its
 * compactions, as the rows they leave live. Its text is read by each reader (the person's words have injected blocks
 * stripped, and the model's are whole messages, not deltas). Its thinking, usage, plan, images and activity are not
 * part of a conversation read back: the record a person reads is what was said and what was done.
 */
export function historyEvents(events: readonly NormalizedEvent[], ts?: number): HistoryMessage[] {
  return events.filter(isHistoryEvent).map((event) => ({ role: 'system', event: withinOutput(event), ...(ts !== undefined ? { ts } : {}) }))
}

/**
 * How much of a tool's answer a result read back keeps as its record (#843 review). Live, the whole answer is the
 * record (#221), written as it comes, one call at a time. An import writes every call it reads in one go, and a busy
 * thread's commands can answer megabytes each; the card itself shows the first 2,000 characters either way.
 */
export const HISTORY_OUTPUT_CHARS = 20_000

/** The most tool rows (calls and results) one import or catch-up stores: the newest calls are kept whole (see `lastLines`) */
export const HISTORY_TOOL_ROWS = 400

function withinOutput(e: HistoryEvent): HistoryEvent {
  if (e.type !== 'tool_result' || !e.output || e.output.length <= HISTORY_OUTPUT_CHARS) return e
  return { ...e, output: `${e.output.slice(0, HISTORY_OUTPUT_CHARS)}\n… (the rest was not read back: ${e.output.length} characters in all)` }
}

/**
 * Whether a line counts toward an import's limit: the words, and a compaction, as before tool rows were read back
 * (#843). A tool call and its result ride along with the turn they belong to, so a conversation full of tool calls
 * still brings back as many of its turns.
 */
export const countsAsLine = (h: HistoryMessage): boolean => h.role !== 'system' || h.event.type === 'compaction'

/**
 * The newest `limit` lines that count, with the events among and after them; what came before the oldest of them is
 * cut. Of those events, the newest calls' rows are kept up to `HISTORY_TOOL_ROWS`, a call's and its result's together;
 * older calls leave no card (their turn's words stay).
 */
export function lastLines(lines: readonly HistoryMessage[], limit: number): HistoryMessage[] {
  if (limit <= 0) return []
  let from = 0
  let counted = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (countsAsLine(lines[i]!) && ++counted === limit) {
      from = i
      break
    }
  }
  const kept = lines.slice(from)
  const calls = new Set<string>()
  let rows = 0
  for (let i = kept.length - 1; i >= 0; i--) {
    const id = callIdOf(kept[i]!)
    if (id === null) continue
    if (!calls.has(id)) {
      if (rows >= HISTORY_TOOL_ROWS) continue
      calls.add(id)
    }
    rows++
  }
  return kept.filter((h) => {
    const id = callIdOf(h)
    return id === null || calls.has(id)
  })
}

const callIdOf = (h: HistoryMessage): string | null =>
  h.role === 'system' && (h.event.type === 'tool_call' || h.event.type === 'tool_result') ? h.event.callId : null
