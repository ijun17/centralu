/**
 * What kind of failure an error's text describes, the only part of it that reaches another session's model (#1186): its words can carry a
 * hook's output or what a linked machine sent, so they stay in the stored notice and the session's record (docs/security-boundaries/inter-agent-content.md).
 * The kinds are the ones a caller acts on differently: wait and retry, wait for the limit, wait for the network, change what was asked, or read it.
 */
export type ErrorKind = 'overloaded' | 'usage limit' | 'network' | 'refused' | 'other'

const USAGE_LIMIT = /usage limit|rate.?limit|\b429\b|quota|limit reached|hit your limit|upgrade your plan to continue/i
const OVERLOADED = /overload|\b529\b|\b503\b|capacity|temporarily unavailable/i
const REFUSED = /refus|denied|not allowed|forbidden|\b403\b|permission/i

/**
 * A turn ended on the account's own five-hour or weekly limit, in the words Claude Code and Codex end such a turn with ("You've hit your session
 * limit · resets 1am", "Claude AI usage limit reached", Codex's "You've hit your usage limit"; #1415). Narrower than the `usage limit` kind: its
 * per-minute 429 of an API key, a gateway's quota or another tool's plan is no limit that resets for the account, so Centralu does not wait and continue
 */
export function isPlanLimit(message: string): boolean {
  return PLAN_LIMIT.test(message)
}

const PLAN_LIMIT = /hit your (?:\w+ ){0,2}limit\b|Claude AI usage limit reached/i

/**
 * When a limit's own words say it resets (#1415), for a stop that came with no reset in the tool's data: Codex's 429 ends a turn with "You've hit
 * your usage limit. … try again at 6:17 PM." (or "… try again at Oct 27th, 2026 6:17 PM." for a later day; measured on Codex 0.160.0, which sent
 * no `account/rateLimits/updated` before it), Claude Code's with "You've hit your session limit · resets 7:50pm". The time is the computer's own
 * clock's, as the CLI printed it on the same computer; one without a day is the next such time from `now`, the current minute included.
 */
export function planLimitResetAt(message: string, now: number): number | undefined {
  const m = RESET_WORDS.exec(message)
  if (!m) return undefined
  const [, month, day, year, hour, minute, half] = m
  // A 12-hour clock's: "13pm" or "6:75 PM" is no time, and the stop waits the slow retry instead
  if (Number(hour) < 1 || Number(hour) > 12 || Number(minute ?? 0) > 59) return undefined
  const h = (Number(hour) % 12) + (half?.toLowerCase() === 'p' ? 12 : 0)
  const min = Number(minute ?? 0)
  if (month && day && year) {
    const mi = MONTHS.indexOf(month.slice(0, 3).toLowerCase())
    if (mi < 0) return undefined
    return new Date(Number(year), mi, Number(day), h, min).getTime()
  }
  const at = new Date(now)
  at.setHours(h, min, 0, 0)
  // The stated minute itself is now, not tomorrow: a stop at 6:17:20 that says "6:17 PM" resets at once (the wait keeps a past reset at now, `continueAt`)
  if (at.getTime() <= now - 60_000) at.setDate(at.getDate() + 1)
  return at.getTime()
}

const RESET_WORDS = /(?:try again at|resets(?: at)?)\s+(?:([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

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
 * Which errors the network caused (#698), for why a turn did not run to its end (interruptions.ts); the words and their sources are the
 * `network` row of docs/agent-host/lifecycle/turn-endings-and-mail.md. Tool-neutral: both adapters hand the tool's sentence on in `error.message`.
 * Claude Code's were measured in the real store (2026-10-14/15, after the CLI's ten `api_retry`s, about three minutes) and read in
 * claude-agent-sdk 0.3.263's bundled CLI, which sends an error it does not recognise as its own message ("API Error: fetch failed" is the API
 * call failing). Codex's are the reasons of `Reconnecting... n/5` in host.log; a turn that gives up ends with the last one. A 401, a model's
 * 400 or a usage limit is left out (continuing would fail again the same way), and a generic phrase counts only inside the API's own sentences.
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

/** The tool's sentence without a crash's stderr tail (`. stderr: …`, the SDK's and `withStderrTail`'s): what the process printed last is not this turn */
export function failureSentence(message: string): string {
  return (message.split(/(?:^|[.\s])stderr:/)[0] ?? '').trim()
}

export function isNetworkFailure(message: string): boolean {
  const sentence = failureSentence(message)
  return NETWORK_WORDS.some((w) => w.test(sentence))
}
