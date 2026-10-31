// Why a CI run failed, as a pure function: a real failure (a test or a build broke) or an
// infrastructure one (a run cancelled with no failed job, a job that hit its timeout, a lost runner,
// a job on the known-flaky list). The merge queue reruns only the second kind (queue.mjs decideRun).
//
// Why (the owner, 2026-10-19, after measuring the queue's first day): every failed run was rerun once,
// whatever failed. 19 reruns that day, most of them a test that failed the same way again, each one a
// full CI run the next batch waited behind. A test or build failure is the session's to fix, at once.
//
// The contract with CI (two sessions worked on the two sides at once): in a full-tier run, when the
// `verify` job fails, CI cancels the rest of the run at once (fail fast), so the run's conclusion is
// "cancelled". The run's jobs say why: a job that failed in one of its steps is a real failure, even
// in a cancelled run; jobs cancelled beside it are not. GitHub's job conclusions and step results
// (`/actions/runs/{id}/jobs`) and the job's annotations (`/check-runs/{id}/annotations`, where GitHub
// writes "exceeded the maximum execution time" and "lost communication with the server") tell them apart.

const OK = new Set(['success', 'neutral', 'skipped'])

/**
 * The steps that set a job up, by the names GitHub gives them in `/actions/runs/{id}/jobs` (#1435): provisioning the
 * runner, checking out, setting up pnpm or Node, a toolchain or a cache, downloading an artifact, installing the
 * system libraries or a browser. A job that fails in one of these failed before any test or build of the commit ran:
 * the runner's or a package source's failure (2026-10-21: packages.microsoft.com answered 403 to `playwright install
 * --with-deps webkit`), not the code's.
 */
const SETUP_STEP = [
  /^Set up job$/i,
  /^Initialize containers$/i,
  /^Run actions\/(?:checkout|setup-[\w-]+|cache|download-artifact)@/i,
  /^Run pnpm\/action-setup@/i,
  /^Run \.\/\.github\/actions\/setup$/i, // build.yml's composite of the pnpm and Node setup: GitHub lists it as one step
  /^Run (?:dtolnay\/rust-toolchain|swatinem\/rust-cache)@/i,
  /^(?:Install|Set up) .*\b(?:WebKit|Chromium|Firefox|browsers?|Playwright|system dependencies)\b/i,
]
/** A step that fetches packages: a setup step only when the failure names the network or a package source */
const INSTALL_STEP = /^Run (?:pnpm|npm|yarn) (?:install|ci|i)\b/i
const FETCH_NOTE = /ERR_PNPM_(?:META_)?FETCH_(?!4\d\d)|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\bE: Failed to fetch|Could not resolve host|\b(?:502|503|504)\b.{0,40}(?:Bad Gateway|Service Unavailable|Gateway Time-?out)/i

/**
 * What the text of a failing step says when the network or a package source is what failed (#1450 review): a refused or
 * forbidden request, a gateway error, a timeout, a name that does not resolve, a mirror out of step. A status counts
 * only as a status ("403 Forbidden", "HTTP 403", "status 429", "returned error: 502", "responded with 503"), never as a
 * number inside a version or a path (2.403.1, foo_1.429-1.deb). Not `E: Failed to fetch` alone: apt writes that for a
 * 404 too, a package the commit asked for that is not there. A false "network" costs an issue while main stays red; a
 * false "not the network" blames a commit that did nothing.
 */
const NETWORK_LINE = [
  /\b(?:403|429)\s+(?:Forbidden|Too Many)/i,
  /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|returned error:|responded with|error code)\s*:?\s*(?:403|429|5\d\d)\b/i,
  /\b50[0-4]\s+(?:Internal|Bad Gateway|Service|Gateway)/i,
  /\bForbidden\b|Too Many Requests|Bad Gateway|Service Unavailable|Gateway Time-?out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i,
  /could not (?:resolve|connect|download)|unable to connect|failed to connect|temporary failure|network is unreachable|connection (?:reset|refused|timed out)|timed out|early EOF|RPC failed/i,
  /Hash Sum mismatch|(?:is not|no longer) signed|Download failure/i,
]
export const looksLikeNetworkError = (text) => NETWORK_LINE.some((re) => re.test(String(text ?? '')))

/** Whether a step with this name, failing with these notes, is part of setting the job up, not of its work. */
export const isSetupStep = (name, notes = '') => SETUP_STEP.some((re) => re.test(String(name ?? ''))) || (INSTALL_STEP.test(String(name ?? '')) && FETCH_NOTE.test(notes))
// GitHub's own words only: a test's own "timed out in 5000ms" is a test failure
const JOB_LIMIT_NOTE = /has exceeded the maximum execution time of \d+ minutes/i
const STEP_LIMIT_NOTE = /The action '(.*)' has timed out after \d+ minutes/gi
/** What GitHub writes on a job whose runner went away. */
const SHUTDOWN_NOTE = /runner has received a shutdown signal/i
export const LOST_RUNNER_NOTE = /lost communication with the server|runner has received a shutdown signal|hosted runner encountered an error|runner .{0,80}(?:did not connect|is offline|was lost|has been deprovisioned)/i

/**
 * The line a job's log holds when its runner was stopped under it (#1507): `##[error]The runner has received a shutdown
 * signal. This can happen when the runner service is stopped, or a manually started runner is canceled.` GitHub writes
 * no such note on the job: its annotation is only "The operation was canceled.", and the job's step says `failure`, so
 * this is the one place the cause is. Everything the log says after this line was cut short by it: the tests the
 * runner stopped under are reported failed (`✘ 117 …`), though nothing of the commit failed (job 120780406901, run
 * 40063018693, `e2e (chromium 1/5)` of the release bump #1506, tooling/fixtures/ci-log-runner-shutdown.txt).
 *
 * Only the runner's own line counts: at the start of the line (a test that prints the line indents it, or quotes it in a
 * diff), and followed by the `##[error]The operation was canceled.` that the cancelled step ends with (`shutdownAt`).
 * A test that only prints the text, then really fails, keeps its failure.
 */
export const RUNNER_SHUTDOWN = /^##\[error\]The runner has received a shutdown signal/
/** The line a cancelled step ends with: the runner's word, after the shutdown line, that it was this which ended the job */
const STEP_CANCELED = /^##\[error\]The operation was canceled\.?\s*$/

/** Where the runner's own shutdown line is in a log's lines (colour codes and timestamps already off), or -1: the last one before the step's cancellation. */
export function shutdownAt(lines) {
  const end = lines.findLastIndex((l) => STEP_CANCELED.test(l))
  return end < 0 ? -1 : lines.slice(0, end).findLastIndex((l) => RUNNER_SHUTDOWN.test(l))
}
/** What GitHub writes on a job a shutdown cut short: the only thing its annotations say, and the cue to read the log for the rest */
export const CANCELED_NOTE = /^The operation was canceled\.?$/i

/** Whether a job's name is on the known-flaky list: exact names, `*` for any run of characters. */
export function onFlakyList(name, list = []) {
  return list.some((p) => {
    const s = String(p)
    if (!s.includes('*')) return s === name
    return new RegExp(`^${s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(String(name))
  })
}

/**
 * Why one job did not pass, or null when it did (or has not finished). `job`: `{ name, conclusion,
 * steps: [{ name, conclusion }], notes: [annotation messages], log?: the failing line of its log }`. Only `notes`, GitHub's
 * own words, say a timeout or a lost runner; the log's line only tells a failed install step's network error from a lockfile's. Answers `{ real, cause, step? }`;
 * `cause` is `test` (a step failed), `no-step` (failed outside any step it reports), `timeout` (`inSetup`, with its `step`, when the step the limit ended set the job up, #1503),
 * `runner`, `setup` (its first failed step set the job up, #1435), `flaky` or `cancelled`.
 */
export function jobFailure(job, { flaky = [] } = {}) {
  if (!job || job.conclusion == null || OK.has(job.conclusion)) return null
  const notes = (job.notes ?? []).join('\n')
  // The step the limit ended (#1503): GitHub marks the step that was running when the job ran out of time 'cancelled'
  // (e2e (webkit 1/5), 2026-10-23: `Install WebKit` cancelled at 893 s, the tests skipped), and one that ran out of its own
  // `timeout-minutes` 'failure'. In a step that sets the job up, nothing of the commit ran: the mirror was slow.
  const ended = (job.steps ?? []).find((s) => s.conclusion === 'cancelled' || s.conclusion === 'failure')
  // A step's own limit counts only when its annotation names the step that ended the job. A step with `continue-on-error`
  // (the first try of the browser install) that ran out of time leaves the same annotation on a job that goes on, and on
  // to fail in its tests: that failure is the tests', not a timeout (#1503, review of #1505, job 120762088185).
  const limitedSteps = [...notes.matchAll(STEP_LIMIT_NOTE)].map((m) => m[1])
  const stepLimit = limitedSteps.length > 0 && (!(job.steps ?? []).length || (ended != null && limitedSteps.includes(ended.name)))
  if (job.conclusion === 'timed_out' || JOB_LIMIT_NOTE.test(notes) || stepLimit) {
    if (ended && isSetupStep(ended.name, notes)) return { real: false, cause: 'timeout', step: ended.name, inSetup: true }
    return { real: false, cause: 'timeout' }
  }
  // `shutdown`: the runner was stopped under the job. A lost connection is the network's; a shutdown can be a commit that exhausted the runner's memory or disk (the main guard hunts the second time)
  if (LOST_RUNNER_NOTE.test(notes)) return { real: false, cause: 'runner', ...(SHUTDOWN_NOTE.test(notes) ? { shutdown: true } : {}) }
  if (job.conclusion === 'cancelled') return { real: false, cause: 'cancelled' }
  if (onFlakyList(job.name, flaky)) return { real: false, cause: 'flaky' }
  const step = (job.steps ?? []).find((s) => s.conclusion === 'failure')
  // The first step that failed set the job up (#1435): nothing of the commit ran. A later step that failed after it
  // (an artifact upload that runs on failure) says nothing more.
  if (step && isSetupStep(step.name, `${notes}\n${job.log ?? ''}`)) return { real: false, cause: 'setup', step: step.name }
  // Failed, and no reason to call it the runner's: the session's to look at, never rerun blind
  return { real: true, cause: step ? 'test' : 'no-step', step: step?.name ?? null }
}

/**
 * Why a finished run did not pass: `{ real, cause, job, step?, attempt }`, `job` `{ name, id }` the
 * job to name. Real when any job failed for real (a cancelled run included: fail fast); else
 * infrastructure (the first of timeout, runner, setup, flaky, then cancelled). A run with no failed job and
 * a conclusion other than cancelled (a workflow file GitHub would not start) is real.
 */
export function classifyRun(run, jobs, { flaky = [] } = {}) {
  const seen = (jobs ?? []).map((j) => ({ j, f: jobFailure(j, { flaky }) })).filter((x) => x.f)
  const pick = (x) => ({ real: x.f.real, cause: x.f.cause, step: x.f.step ?? null, inSetup: x.f.inSetup === true, shutdown: x.f.shutdown === true, job: { name: x.j.name, id: x.j.id != null ? String(x.j.id) : null }, attempt: run.attempt ?? 1 })
  const real = seen.find((x) => x.f.real)
  if (real) return pick(real)
  for (const cause of ['timeout', 'runner', 'setup', 'flaky', 'cancelled']) {
    const x = seen.find((y) => y.f.cause === cause)
    if (x) return pick(x)
  }
  return { real: run.conclusion !== 'cancelled', cause: run.conclusion === 'cancelled' ? 'cancelled' : 'no-job', step: null, job: null, attempt: run.attempt ?? 1 }
}

/** Words for a cause, in attention texts and events. */
export const CAUSE_TEXT = {
  test: 'a test or build failure',
  'no-step': 'a failure outside any step',
  'no-job': 'a run GitHub did not start any job of',
  timeout: 'a job that hit its timeout',
  runner: 'a lost runner',
  setup: 'a failure in a setup step',
  flaky: 'a job on the known-flaky list',
  cancelled: 'cancelled, with no failed job',
}
