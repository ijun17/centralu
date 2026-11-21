// The known intermittent failures issue (project.json ci.knownFailuresIssue): its one reader, for ci_status (ci-tools.mjs)
// and for a local e2e run (e2e/flaky-report.ts), so a failure a local run sets apart is one CI's would.
import { matchKnownFailure } from './ci.mjs'
import { CI, config } from './config.mjs'
import { readIssueText } from './github.mjs'

/**
 * The issue, read (body and comments, without the main guard's notes, from the board's repository): `{ issue, closed,
 * quote }`, `quote(failure)` the line of it that names `failure` (`{ line, error }`, `line` as CI's log names the test) or
 * null. A closed issue is still read, and `closed` says so. Throws what readIssueText throws; needs ci.knownFailuresIssue.
 */
export async function readKnownFailures() {
  const { text, state } = await readIssueText(config.repository, CI.knownFailures)
  return { issue: CI.knownFailures, closed: state === 'CLOSED', quote: (failure) => matchKnownFailure(failure, text) }
}

/** Which of `failures` the issue quotes: `{ issue, closed, quotes }`, a quote or null for each; or `{ why }` it could not be read. */
export async function knownFailureQuotes(failures) {
  if (!CI.knownFailures) return { why: 'project.json names no ci.knownFailuresIssue' }
  try {
    const { issue, closed, quote } = await readKnownFailures()
    return { issue, closed, quotes: failures.map(quote) }
  } catch (e) {
    return { why: `#${CI.knownFailures} could not be read: ${String(e?.message ?? e).trim().replace(/\.$/, '')}` }
  }
}
