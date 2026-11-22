import { LimitsFailure } from './failure.js'

/** Measured: Cursor's dashboard answers in about 0.7 s; a provider that holds the request must not hold the answer */
const ASK_MS = 5_000

export type FixedRequest = {
  method: 'GET' | 'POST'
  /** Carries the person's token: sent to `url`'s origin and nowhere else */
  headers: Readonly<Record<string, string>>
  body?: string
}

/**
 * One request with a person's token to an address fixed in code. A redirect is refused rather than followed, so the token
 * cannot be carried to another address. Every failure is a kind whose detail is `what`, the status or the error's name
 */
export async function askFixed(what: string, url: string, request: FixedRequest, fetchFn: typeof fetch = fetch): Promise<unknown> {
  let status: number
  let text: string
  try {
    const res = await fetchFn(url, { ...request, headers: { ...request.headers }, redirect: 'error', signal: AbortSignal.timeout(ASK_MS) })
    status = res.status
    text = await res.text()
  } catch (e) {
    throw new LimitsFailure('unreachable', `${what}: ${e instanceof Error ? e.name : 'failed'}`)
  }
  if (status === 401) throw new LimitsFailure('signed-out', `${what}: HTTP 401`)
  if (status >= 500) throw new LimitsFailure('unreachable', `${what}: HTTP ${status}`)
  if (status < 200 || status >= 300) throw new LimitsFailure('refused', `${what}: HTTP ${status}`)
  try {
    const answer: unknown = JSON.parse(text)
    return answer
  } catch {
    throw new LimitsFailure('unreadable', `${what}: not JSON`)
  }
}
