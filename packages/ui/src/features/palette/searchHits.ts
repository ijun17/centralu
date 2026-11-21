/**
 * Conversation-search hits with the query they answer (#1143 U15): until the answer comes, the rows are an earlier
 * query's, and Enter would open a "fo" hit for "foz". As in the composer's `@` list (`autocompleteState.ts`), stale rows
 * may stay on screen, but a key never picks one.
 */
export type FoundHits<T> = { query: string; list: T[] }

export const NO_HITS: FoundHits<never> = { query: '', list: [] }

/** Whether the hits on screen answer what is typed in the box */
export function hitsAnswer(found: FoundHits<unknown>, typed: string): boolean {
  return found.query === typed.trim()
}

/** Whether Enter may open this row: a hit from an earlier query waits for the answer to the current one */
export function enterMayOpen(row: { kind: string }, fresh: boolean): boolean {
  return row.kind !== 'message' || fresh
}
