import { isNetworkFailure } from './interruptions.js'

/**
 * What kind of failure an error's text describes, the only part of it that reaches another session's model (#1186
 * review). An error a turn ended with is its tool's text, and its tool's text can carry what a repository put there (a
 * hook's output, a CLI's result) or what a linked machine chose to send, so its words stay in the stored notice and
 * the session's own record, which read_session shows as data. The kinds are the ones a caller acts on differently: wait
 * and retry, wait for the limit, wait for the network, change what was asked, or read it.
 */
export type ErrorKind = 'overloaded' | 'usage limit' | 'network' | 'refused' | 'other'

const USAGE_LIMIT = /usage limit|rate.?limit|\b429\b|quota|limit reached|hit your limit/i
const OVERLOADED = /overload|\b529\b|\b503\b|capacity|temporarily unavailable/i
const REFUSED = /refus|denied|not allowed|forbidden|\b403\b|permission/i

export function errorKind(message: string): ErrorKind {
  if (USAGE_LIMIT.test(message)) return 'usage limit'
  if (OVERLOADED.test(message)) return 'overloaded'
  // Before "refused": a network failure is often worded "connection refused"
  if (isNetworkFailure(message)) return 'network'
  if (REFUSED.test(message)) return 'refused'
  return 'other'
}
