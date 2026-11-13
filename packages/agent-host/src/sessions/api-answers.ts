/** How long the host waits for a tool's API to answer before it counts it as unreachable */
const ANSWER_MS = 10_000

/**
 * Whether anything answers at `url` now (#1415, #2238): the network is back for a tool when its API host answers at all. A HEAD with no
 * credentials, so it spends nothing of the person's quota; any HTTP status counts, a failed lookup, connection or a timeout does not
 */
export async function apiAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(ANSWER_MS) })
    return true
  } catch {
    return false
  }
}
