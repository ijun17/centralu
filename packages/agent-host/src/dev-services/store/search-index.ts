/**
 * The kinds of message the search index holds (#221): what the person and the agent said, and the agent's reasoning.
 *
 * Tool calls are not in it, and neither are their results. Until #221 the index took whatever text a payload's shape
 * offered, and a tool call's `summary.title` is a whole Bash command: on a copy of the real store (2026-09-30) 55,131
 * of the 81,816 index rows were tool calls, 22.7M of the 29.2M indexed characters, and the index was 124.5MiB of a
 * 236.2MiB file — half the file spent on finding a session by what it typed, while what the commands printed was never
 * searchable at all. The owner chose to drop them and keep every tool call whole in the store instead (#221).
 *
 * Decided by the message's kind, not by what the payload happens to carry: a field added to a tool payload — or a
 * payload of a new kind — cannot slip into the index unless someone adds its kind here.
 */
export const INDEXED_KINDS: ReadonlySet<string> = new Set(['text', 'reasoning'])

/** The text a message puts in the search index; '' puts none */
export function indexedText(kind: string, payload: string): string {
  if (!INDEXED_KINDS.has(kind)) return ''
  try {
    const p = JSON.parse(payload) as Record<string, unknown>
    return typeof p.text === 'string' ? p.text : ''
  } catch {
    return ''
  }
}
