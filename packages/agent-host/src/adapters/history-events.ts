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
  return events.filter(isHistoryEvent).map((event) => ({ role: 'system', event, ...(ts !== undefined ? { ts } : {}) }))
}

/**
 * Whether a line counts toward an import's limit: the words, and a compaction, as before tool rows were read back
 * (#843). A tool call and its result ride along with the turn they belong to, so a conversation full of tool calls
 * still brings back as many of its turns.
 */
export const countsAsLine = (h: HistoryMessage): boolean => h.role !== 'system' || h.event.type === 'compaction'

/** The newest `limit` lines that count, with the events among and after them; what came before the oldest of them is cut */
export function lastLines(lines: readonly HistoryMessage[], limit: number): HistoryMessage[] {
  if (limit <= 0) return []
  let counted = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (countsAsLine(lines[i]!) && ++counted === limit) return lines.slice(i)
  }
  return [...lines]
}
