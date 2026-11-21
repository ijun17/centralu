/** A time from the future is never fresh: once the clock moved back, a stamp ahead of now would read as fresh until it catches up (#1623) */
export const isFromTheFuture = (at: number, now: number): boolean => at > now
