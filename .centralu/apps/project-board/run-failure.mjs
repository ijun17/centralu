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
/** What GitHub writes on a job (or a step) that ran out of time. */
// GitHub's own words only: a test's own "timed out in 5000ms" is a test failure
export const TIMEOUT_NOTE = /has exceeded the maximum execution time of \d+ minutes|The action '[^']*' has timed out after \d+ minutes/i
/** What GitHub writes on a job whose runner went away. */
export const LOST_RUNNER_NOTE = /lost communication with the server|runner has received a shutdown signal|hosted runner encountered an error|runner .{0,80}(?:did not connect|is offline|was lost|has been deprovisioned)/i

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
 * steps: [{ name, conclusion }], notes: [annotation messages] }`. Answers `{ real, cause, step? }`;
 * `cause` is `test` (a step failed), `no-step` (failed outside any step it reports), `timeout`,
 * `runner`, `flaky` or `cancelled`.
 */
export function jobFailure(job, { flaky = [] } = {}) {
  if (!job || job.conclusion == null || OK.has(job.conclusion)) return null
  const notes = (job.notes ?? []).join('\n')
  if (job.conclusion === 'timed_out' || TIMEOUT_NOTE.test(notes)) return { real: false, cause: 'timeout' }
  if (LOST_RUNNER_NOTE.test(notes)) return { real: false, cause: 'runner' }
  if (job.conclusion === 'cancelled') return { real: false, cause: 'cancelled' }
  if (onFlakyList(job.name, flaky)) return { real: false, cause: 'flaky' }
  const step = (job.steps ?? []).find((s) => s.conclusion === 'failure')
  // Failed, and no reason to call it the runner's: the session's to look at, never rerun blind
  return { real: true, cause: step ? 'test' : 'no-step', step: step?.name ?? null }
}

/**
 * Why a finished run did not pass: `{ real, cause, job, step?, attempt }`, `job` `{ name, id }` the
 * job to name. Real when any job failed for real (a cancelled run included: fail fast); else
 * infrastructure (the first of timeout, runner, flaky, then cancelled). A run with no failed job and
 * a conclusion other than cancelled (a workflow file GitHub would not start) is real.
 */
export function classifyRun(run, jobs, { flaky = [] } = {}) {
  const seen = (jobs ?? []).map((j) => ({ j, f: jobFailure(j, { flaky }) })).filter((x) => x.f)
  const pick = (x) => ({ real: x.f.real, cause: x.f.cause, step: x.f.step ?? null, job: { name: x.j.name, id: x.j.id != null ? String(x.j.id) : null }, attempt: run.attempt ?? 1 })
  const real = seen.find((x) => x.f.real)
  if (real) return pick(real)
  for (const cause of ['timeout', 'runner', 'flaky', 'cancelled']) {
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
  flaky: 'a job on the known-flaky list',
  cancelled: 'cancelled, with no failed job',
}
