/**
 * The waits before reading or sending again what failed: the session list and a conversation page a reconnect re-reads,
 * and the workspace snapshot's save and read. A host that fails every try is not helped by being asked forever, and the
 * next reconnect or opening the conversation reads again.
 */
export const RETRY_MS = [1_000, 5_000, 30_000] as const

/**
 * Calls `read` until it succeeds, waiting the `RETRY_MS` steps between tries. `failed` runs after every failure
 * and `gaveUp` once the steps run out; `keepGoing` is asked after each wait. Null when it stopped without a read.
 */
export async function retryLadder<T>(
  read: () => Promise<T>,
  keepGoing: () => boolean,
  failed?: () => void,
  gaveUp?: () => void,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch {
      failed?.()
    }
    const wait = RETRY_MS[attempt]
    if (wait === undefined) {
      gaveUp?.()
      return null
    }
    await new Promise((r) => setTimeout(r, wait))
    if (!keepGoing()) return null
  }
}
