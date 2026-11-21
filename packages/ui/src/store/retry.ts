/**
 * The waits before a failed read or save is tried again (docs/state-management.md §5). Not forever: the next reconnect
 * or opening the conversation reads again.
 */
export const RETRY_MS = [1_000, 5_000, 30_000] as const

/** `at` is the wait the next failure takes; shared by several ladders, it keeps the count across them */
export type RetrySteps = { at: number }

/** Null when it stopped without a read. `afterFailure`: the read already failed outside the ladder, so start with a wait. */
export async function retryLadder<T>(
  read: () => Promise<T>,
  keepGoing: () => boolean,
  failed?: () => void,
  gaveUp?: () => void,
  { steps = { at: 0 }, afterFailure = false }: { steps?: RetrySteps; afterFailure?: boolean } = {},
): Promise<T | null> {
  for (let skip = afterFailure; ; skip = false) {
    if (!skip) {
      try {
        return await read()
      } catch {
        failed?.()
      }
    }
    // Stopped while that read was out: its failure takes no step from the count a newer ladder shares
    if (!keepGoing()) return null
    const wait = RETRY_MS[steps.at]
    if (wait === undefined) {
      gaveUp?.()
      return null
    }
    steps.at++
    await new Promise((r) => setTimeout(r, wait))
    if (!keepGoing()) return null
  }
}
