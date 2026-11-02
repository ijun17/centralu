/**
 * A time from the future is never fresh (#1623). A kept answer or row is stamped with the time it was read; when the clock
 * moved back since, that stamp is ahead of now and its age would be negative, which reads as "fresh" until the clock catches up.
 * One definition, used by the reader (`adapters/usage-read.ts`), the store (`saveLocalTotals`) and the model-list back-off (`sessions/tool-queries.ts`).
 */
export const isFromTheFuture = (at: number, now: number): boolean => at > now
