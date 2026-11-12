/**
 * The waits before reading or sending again what failed: the session list and a conversation page a reconnect re-reads,
 * and the workspace snapshot's save and read. A host that fails every try is not helped by being asked forever, and the
 * next reconnect or opening the conversation reads again.
 */
export const RETRY_MS = [1_000, 5_000, 30_000] as const

/** How far up the ladder a read is: `at` is the wait its next failure takes. Handed to several ladders, it keeps the count across them */
export type RetrySteps = { at: number }

/**
 * Calls `read` until it succeeds, waiting the `RETRY_MS` steps between tries. `failed` runs after every failure
 * and `gaveUp` once the steps run out; `keepGoing` is asked after each failure and each wait. Null when it stopped without a read.
 *
 * `steps` is the count of waits already taken (a caller that resets it on success starts over from the first wait).
 * `afterFailure` says the read already failed once, outside the ladder, so it starts with the wait instead of a try.
 */
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
    // Stopped while that read was out: its failure is nobody's, and takes no step from the count a newer ladder shares
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
