/**
 * What kind of failure an error's text describes, the only part of it that reaches another session's model (#1186
 * review). An error a turn ended with is its tool's text, and its tool's text can carry what a repository put there (a
 * hook's output, a CLI's result) or what a linked machine chose to send, so its words stay in the stored notice and
 * the session's own record, which read_session shows as data. The kinds are the ones a caller acts on differently: wait
 * and retry, wait for the limit, wait for the network, change what was asked, or read it.
 */
export type ErrorKind = 'overloaded' | 'usage limit' | 'network' | 'refused' | 'other'

const USAGE_LIMIT = /usage limit|rate.?limit|\b429\b|quota|limit reached|hit your limit|upgrade your plan to continue/i
const OVERLOADED = /overload|\b529\b|\b503\b|capacity|temporarily unavailable/i
const REFUSED = /refus|denied|not allowed|forbidden|\b403\b|permission/i

/**
 * A turn ended on the account's own five-hour or weekly limit, in the words Claude Code and Codex end such a turn with ("You've hit your session
 * limit · resets 1am", "Claude AI usage limit reached", Codex's "You've hit your usage limit"; #1415). Narrower than the `usage limit` kind,
 * which also names a per-minute 429 of an API key, a gateway's quota or another tool's plan: those are no limit that resets for the account,
 * so Centralu does not wait for one and continue
 */
export function isPlanLimit(message: string): boolean {
  return PLAN_LIMIT.test(message)
}

const PLAN_LIMIT = /hit your (?:\w+ ){0,2}limit\b|Claude AI usage limit reached/i

export function errorKind(message: string): ErrorKind {
  if (USAGE_LIMIT.test(message)) return 'usage limit'
  if (OVERLOADED.test(message)) return 'overloaded'
  // Before "refused": a network failure is often worded "connection refused"
  if (isNetworkFailure(message)) return 'network'
  if (REFUSED.test(message)) return 'refused'
  return 'other'
}

/** The kind as one word, for a fact the mailbox carries to another session (`usage_limit`): the shape of a field of its wake */
export function errorKindWord(message: string): string {
  return errorKind(message).replace(' ', '_')
}

/**
 * Which errors the network caused (#698), for why a turn did not run to its end (interruptions.ts). Tool-neutral: both adapters hand the
 * tool's own sentence on in `error.message`, so the words below are matched there rather than each adapter growing
 * its own field.
 *
 * Measured, the sentences a turn failed with after the tool's own retries:
 *
 *   Claude Code   "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"
 *                 "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"
 *                 "API Error: No response from API (waited 3m). If a proxy or gateway …"
 *                 "API Error: Connection lost while your computer was asleep"
 *                 "API Error: Your computer went to sleep mid-response. The response above may be incomplete."
 *                 (the real store, 2026-10-14/15; the CLI retried `api_retry` ten times, about three minutes, first)
 *   Codex         "stream disconnected before completion: failed to lookup address information: nodename nor servname
 *                 provided, or not known", "… Transport error: network error: error decoding response body",
 *                 "… Transport error: timeout", "Connection failed: error sending request"
 *                 (host.log, the reasons of `Reconnecting... n/5`; a turn that gives up ends with the last one)
 *
 * Read in the CLI itself (claude-agent-sdk 0.3.263's bundled CLI, the function that words a connection failure): after
 * "API Error: " it says "Connection lost while your computer was asleep", "No response from API", "Request timed out.
 * Check your internet connection and proxy settings", "Unable to connect to API. Check your internet connection",
 * "Connection dropped (ECONNRESET | EPIPE | ConnectionClosed | …)", "Connection refused — …", "Can't reach the API
 * server — …", "No internet route — …", "Unable to connect to API (<code>)"; and an error it does not recognise goes
 * out as its own message, so a bare "API Error: fetch failed" is the API call itself failing. "Unable to connect to
 * API: SSL …" is a certificate or proxy setting, not the network, and is left out.
 *
 * A 401, a 400 for a model, a usage limit and the like are not here: continuing would only fail again the same way.
 * The words are the API's own sentences, so a generic phrase ("connection closed", "network error") is matched only
 * inside one: a tool's own failure can say it about something else (an MCP server, a dev server it ran).
 */
const NETWORK_WORDS = [
  /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/,
  /API Error: (No response from API|Can't reach the API server|Connection (refused|lost|reset|error|dropped)|Request timed out|No internet route|fetch failed|Unable to connect to API(?!: SSL))/i,
  /computer (went to sleep|was asleep)/i,
  /stream disconnected before completion/i,
  /failed to lookup address information/i,
  /Connection failed: error sending request/i,
  /waiting for network/i,
]

/**
 * The tool's own sentence, without the end of the CLI's stderr a crash carries (`. stderr: …`, the SDK's and
 * `withStderrTail`'s): that tail is whatever the process printed last, and a word in it says nothing of this turn.
 */
export function failureSentence(message: string): string {
  return (message.split(/(?:^|[.\s])stderr:/)[0] ?? '').trim()
}

export function isNetworkFailure(message: string): boolean {
  const sentence = failureSentence(message)
  return NETWORK_WORDS.some((w) => w.test(sentence))
}
