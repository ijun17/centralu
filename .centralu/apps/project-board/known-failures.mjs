// The known intermittent failures issue (project.json ci.knownFailuresIssue) for a local e2e run (e2e/flaky-report.ts),
// read and matched as ci_status reads and matches it (ci-tools.mjs): one list and one matcher, so a failure a local run
// sets apart is one CI's would.
import { matchKnownFailure } from './ci.mjs'
import { CI, config } from './config.mjs'
import { readIssueText } from './github.mjs'

/**
 * Which of `failures` (each `{ line, error }`, `line` as CI's log names the test) the issue quotes: `{ issue, closed,
 * quotes }`, a quote or null for each (a closed issue is still read, and `closed` says so); or `{ why }` it could not be read.
 */
export async function knownFailureQuotes(failures) {
  if (!CI.knownFailures) return { why: 'project.json names no ci.knownFailuresIssue' }
  try {
    const { text, state } = await readIssueText(config.repository, CI.knownFailures)
    return { issue: CI.knownFailures, closed: state === 'CLOSED', quotes: failures.map((f) => matchKnownFailure(f, text)) }
  } catch (e) {
    return { why: `#${CI.knownFailures} could not be read: ${String(e?.message ?? e).trim().replace(/\.$/, '')}` }
  }
}
