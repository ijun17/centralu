// Kept separate from the CLI so long waits and retry boundaries can use a simulated clock.
export const DEFAULT_TIMEOUT_MS = 90 * 60_000
const REGISTRATION_GRACE_MS = 2 * 60_000
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
const needsAction = (r) => ['waiting', 'action_required'].includes(r.status) || r.conclusion === 'action_required'
const cancelled = (r) => (r.conclusion ?? r.state) === 'cancelled'

class WaitTimeout extends Error {}

/** Exit codes: 0 passed, 1 failed, 2 error, 3 approval, 4 empty, 5 cancelled, 6 timeout. */
export async function waitForChecks({ repo, ref, number, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 30_000 }, {
  gh,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
}) {
  let label = ref ? `${repo}@${ref}` : `${repo}#${number}`
  const started = now()
  const deadline = started + timeoutMs
  const finish = (code, message) => ({ code, message: `${label}: ${message}` })
  const remaining = () => {
    const left = deadline - now()
    if (left <= 0) throw new WaitTimeout()
    return left
  }
  const pause = async (ms) => {
    await sleep(Math.min(ms, remaining()))
    remaining()
  }
  const request = async (args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await gh(args, { timeoutMs: remaining() })
        remaining()
        return JSON.parse(result)
      } catch (error) {
        remaining()
        if (attempt === RETRY_DELAYS_MS.length) throw error
        const delay = Math.min(RETRY_DELAYS_MS[attempt], remaining())
        onRetry(`${label}: gh failed (${error.message}); retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s.`)
        await pause(delay)
      }
    }
  }
  const runsForHead = async (sha) => (await request(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '--paginate', '--slurp']))
    .flatMap((page) => page.workflow_runs ?? [])
  const cancellation = async (workflows, sha) => {
    for (const run of workflows.filter(cancelled)) {
      if (!run.head_branch || !run.workflow_id || !run.run_number) continue
      // Runs are newest first; supersession needs only the recent runs of this workflow,
      // not every run ever made on a long-lived branch such as main.
      const { workflow_runs: newer = [] } = await request([
        'api', `repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(run.head_branch)}&per_page=20`,
      ])
      if (newer.some((candidate) => candidate.workflow_id === run.workflow_id
        && candidate.event === run.event && candidate.head_branch === run.head_branch
        && candidate.head_repository?.id === run.head_repository?.id
        && candidate.run_number > run.run_number && typeof candidate.head_sha === 'string' && candidate.head_sha !== sha)) {
        return finish(5, 'superseded by a newer push (cancelled).')
      }
    }
    return finish(5, 'cancelled (no newer push confirmed).')
  }

  try {
    const pinnedSha = ref ? (await request(['api', `repos/${repo}/commits/${encodeURIComponent(ref)}`])).sha : null
    if (ref) label = `${label} (${pinnedSha.slice(0, 7)})`
    let registrationSha
    let registrationStarted
    for (;;) {
      remaining()
      const sha = pinnedSha ?? (await request(['pr', 'view', String(number), '-R', repo, '--json', 'headRefOid'])).headRefOid
      if (sha !== registrationSha) {
        registrationSha = sha
        registrationStarted = now()
      }
      const workflows = await runsForHead(sha)
      const blocked = workflows.find(needsAction)
      if (blocked) return finish(3, `approval/action required: ${blocked.name ?? 'workflow'} (${blocked.status === 'completed' ? blocked.conclusion : blocked.status})${blocked.html_url ? ` — ${blocked.html_url}` : ''}.`)
      // Read checks only after workflows settle, except when no workflow has registered yet.
      // That case needs a check snapshot too before the registration grace can declare it empty.
      if (workflows.some((run) => run.status !== 'completed')) {
        await pause(pollMs)
        continue
      }
      const runs = await request(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`])
      const statuses = await request(['api', `repos/${repo}/commits/${sha}/status`])
      const checks = [...(runs.check_runs ?? []), ...(statuses.statuses ?? [])]
      if (!workflows.length && now() - registrationStarted < REGISTRATION_GRACE_MS) {
        await pause(Math.min(pollMs, REGISTRATION_GRACE_MS - (now() - registrationStarted)))
        continue
      }
      if (!workflows.length && !checks.length) return finish(4, 'nothing to wait for: no workflow runs or checks after the 2-minute registration grace period.')
      if (checks.some(needsAction)) return finish(3, 'approval/action required by a check (action_required).')
      const stopped = workflows.filter((run) => cancelled(run) && !workflows.some((other) =>
        other.workflow_id === run.workflow_id && other.event === run.event && other.head_branch === run.head_branch
        && other.head_repository?.id === run.head_repository?.id
        && (other.run_number > run.run_number || (other.run_number === run.run_number && other.run_attempt > run.run_attempt))))
      if (stopped.length || checks.some(cancelled)) return await cancellation(stopped, sha)
      if (!checks.length) {
        await pause(pollMs)
        continue
      }
      const pending = checks.filter((c) => !['completed', 'success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'error', 'action_required'].includes(c.status ?? c.state))
      if (pending.length) {
        await pause(pollMs)
        continue
      }
      const failed = checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? c.state))
      return finish(failed.length ? 1 : 0, `${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; ${failed.length} failed` : ''}.`)
    }
  } catch (error) {
    return error instanceof WaitTimeout
      ? finish(6, `timed out after ${timeoutMs / 60_000} minutes waiting for workflows/checks.`)
      : finish(2, error.message)
  }
}
