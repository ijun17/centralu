/**
 * The palette's conversation-search hits, with the query they answer (#1143 U15).
 *
 * The answer to a search arrives after the person typed more. The rows on screen are the previous query's hits until
 * it does, and Enter on one of those opens something that does not match what is in the box: type "fo", see its hits,
 * type "foz" and press Enter before the answer, and a "fo" hit opened when nothing else matched "foz". The composer's
 * `@` list has the same rule (`autocompleteState.ts`): stale rows may stay on screen, but a key never picks one.
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
