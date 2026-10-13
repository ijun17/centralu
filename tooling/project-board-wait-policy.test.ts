import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { waitForChecks } from '../.centralu/apps/project-board/wait-checks.mjs'

const SHA = 'abc1234000000000000000000000000000000000'
const DONE = { status: 'completed', conclusion: 'success' }
const CANCELLED = { status: 'completed', conclusion: 'cancelled', workflow_id: 44, head_branch: 'fix/x', head_repository: { id: 1 }, event: 'push', run_number: 1, head_sha: SHA }
type Call = { args: string[]; at: number; timeoutMs: number }
type Reply = (call: Call, calls: Call[]) => unknown

async function run(reply: Reply = () => undefined, options: Record<string, unknown> = {}) {
  let elapsed = 0
  const calls: Call[] = []
  const retries: string[] = []
  const result: { code: number; message: string } = await waitForChecks({ repo: 'o/r', ref: 'main', ...options }, {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms
      // Makes a missing deadline fail a test instead of spinning forever on a fake clock.
      if (elapsed > 100 * 60_000) throw new Error('test clock exceeded its guard')
    },
    gh: async (args: string[], { timeoutMs }: { timeoutMs: number }) => {
      const call = { args, at: elapsed, timeoutMs }
      calls.push(call)
      const answer = reply(call, calls)
      if (answer !== undefined) return JSON.stringify(answer)
      if (args[0] === 'pr') return JSON.stringify({ headRefOid: SHA })
      if (args[1]?.includes('/actions/runs?')) return JSON.stringify([{ workflow_runs: [DONE] }])
      if (args[1]?.includes('/check-runs?')) return JSON.stringify({ check_runs: [DONE] })
      if (args[1]?.endsWith('/status')) return JSON.stringify({ statuses: [] })
      return JSON.stringify({ sha: SHA })
    },
    onRetry: (message: string) => retries.push(message),
  })
  return { ...result, elapsed, calls, retries }
}

const workflows = (args: string[]) => args[1]?.includes('/actions/runs?head_sha=')
const checks = (args: string[]) => args[1]?.includes('/check-runs?')

describe('wait-checks terminal states and deadline', () => {
  it.each([
    { status: 'waiting', name: 'release', html_url: 'https://github.com/o/r/actions/runs/7' },
    { status: 'action_required', name: 'fork CI' },
    { status: 'completed', conclusion: 'action_required', name: 'fork CI' },
  ])('reports approval/action required for $name ($status)', async (blocked) => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [DONE, blocked] }] : undefined)
    expect(r.code).toBe(3)
    expect(r.message).toContain(`approval/action required: ${blocked.name}`)
    expect(r.elapsed).toBe(0)
    expect(r.calls.some((c) => checks(c.args))).toBe(false)
  })

  it('reports action_required from a check too', async () => {
    const r = await run(({ args }) => checks(args) ? { check_runs: [{ status: 'completed', conclusion: 'action_required' }] } : undefined)
    expect(r.code).toBe(3)
    expect(r.message).toContain('action_required')
  })

  it('reports nothing to wait for only after two minutes with no workflows, checks, or statuses', async () => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [] }] : checks(args) ? { check_runs: [] } : undefined)
    expect(r.code).toBe(4)
    expect(r.message).toContain('nothing to wait for')
    expect(r.elapsed).toBe(120_000)
    expect(r.calls.filter((c) => workflows(c.args)).map((c) => c.at)).toEqual([0, 30_000, 60_000, 90_000, 120_000])
  })

  it.each([0, 30_000, 60_000, 90_000, 119_999, 120_000, 120_001])('allows workflows to register at %s ms through the grace boundary', async (visibleAt) => {
    const r = await run(({ args, at }) => at < visibleAt
      ? workflows(args) ? [{ workflow_runs: [] }] : checks(args) ? { check_runs: [] } : undefined
      : undefined)
    expect(r.code).toBe(visibleAt <= 120_000 ? 0 : 4)
  })

  it('gives a new pull request head its own registration grace without resetting the deadline', async () => {
    const r = await run(({ args, at }) => args[0] === 'pr' ? { headRefOid: at < 120_000 ? SHA : 'new-head' }
      : workflows(args) ? [{ workflow_runs: at < 120_000 ? [{ status: 'in_progress' }] : [] }]
        : checks(args) ? { check_runs: [] } : undefined, { ref: null, number: 77, timeoutMs: 300_000 })
    expect(r.code).toBe(4)
    expect(r.elapsed).toBe(240_000)
    expect(r.calls.at(-1)?.timeoutMs).toBe(60_000)
  })

  it('can finish external checks after the grace even without Actions workflows', async () => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [] }] : undefined)
    expect(r.code).toBe(0)
    expect(r.elapsed).toBe(120_000)
  })

  it('does not label an external pending status as nothing to wait for', async () => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [] }]
      : checks(args) ? { check_runs: [] } : args[1]?.endsWith('/status') ? { statuses: [{ state: 'pending' }] } : undefined,
    { timeoutMs: 125_000 })
    expect(r.code).toBe(6)
    expect(r.elapsed).toBe(125_000)
  })

  it('defaults to a 90-minute deadline even for a workflow that never completes', async () => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [{ status: 'in_progress' }] }] : undefined)
    expect(r.code).toBe(6)
    expect(r.message).toContain('timed out after 90 minutes')
    expect(r.elapsed).toBe(90 * 60_000)
  })

  it.each([1, 29_999, 30_000, 30_001, 60_000, 65_000, 120_000, 125_000])('caps sleeps and subprocess timeouts at a %s ms deadline', async (timeoutMs) => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [{ status: 'queued' }] }] : undefined, { timeoutMs })
    expect(r.code).toBe(6)
    expect(r.elapsed).toBe(timeoutMs)
    for (const call of r.calls) expect(call.timeoutMs).toBe(timeoutMs - call.at)
  })
})

describe('cancelled workflow runs', () => {
  it('looks up supersession with one unpaginated page of the workflow, even on a branch with thousands of runs', async () => {
    const r = await run(({ args }) => {
      if (workflows(args)) return [{ workflow_runs: [CANCELLED] }]
      if (args[1]?.includes('/runs?branch=')) {
        const page = { total_count: 10_000, workflow_runs: [{ ...CANCELLED, run_number: 2, head_sha: 'def5678' }] }
        return args.includes('--slurp') ? [page] : page
      }
    })
    expect(r.calls.filter((c) => c.args[1]?.includes('branch='))).toEqual([
      expect.objectContaining({ args: ['api', 'repos/o/r/actions/workflows/44/runs?branch=fix%2Fx&per_page=20'] }),
    ])
    expect(r.code).toBe(5)
    expect(r.message).toContain('superseded by a newer push (cancelled)')
    expect(r.calls.filter((c) => workflows(c.args))).toEqual([
      expect.objectContaining({ args: ['api', `repos/o/r/actions/runs?head_sha=${SHA}&per_page=100`, '--paginate', '--slurp'] }),
    ])
  })

  it.each([true, false])('distinguishes a newer push from an unconfirmed cancellation (newer: %s)', async (newer) => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [CANCELLED] }]
      : args[1]?.includes('/actions/workflows/44/runs?branch=') ? { workflow_runs: newer ? [{ ...CANCELLED, run_number: 2, head_sha: 'def5678' }] : [] }
        : checks(args) ? { check_runs: [{ status: 'completed', conclusion: 'cancelled' }] } : undefined)
    expect(r.code).toBe(5)
    expect(r.message).toContain(newer ? 'superseded by a newer push (cancelled)' : 'cancelled (no newer push confirmed)')
    expect(r.message).not.toContain('failed')
    expect(r.calls.filter((c) => c.args[1] === 'repos/o/r/commits/main')).toHaveLength(1)
  })

  it('detects a cancelled workflow even if its only registered check passed', async () => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [CANCELLED] }]
      : args[1]?.includes('/actions/workflows/44/runs?branch=') ? { workflow_runs: [{ ...CANCELLED, run_number: 2, head_sha: 'def5678' }] } : undefined)
    expect(r.code).toBe(5)
    expect(r.message).toContain('superseded by a newer push (cancelled)')
  })

  it.each([
    { run_number: 1 }, { head_sha: SHA }, { event: 'workflow_dispatch' },
    { workflow_id: 45 }, { head_branch: 'other' }, { head_repository: { id: 2 } },
  ])('does not infer supersession from an unrelated run: %j', async (different) => {
    const r = await run(({ args }) => workflows(args) ? [{ workflow_runs: [CANCELLED] }]
      : args[1]?.includes('/actions/workflows/44/runs?branch=') ? { workflow_runs: [{ ...CANCELLED, run_number: 2, head_sha: 'def5678', ...different }] } : undefined)
    expect(r.code).toBe(5)
    expect(r.message).not.toContain('superseded')
  })

  it('ignores an old cancelled run once its replacement on the same SHA succeeds', async () => {
    const r = await run(({ args }) => workflows(args)
      ? [{ workflow_runs: [CANCELLED, { ...CANCELLED, run_number: 2, conclusion: 'success' }] }] : undefined)
    expect(r.code).toBe(0)
  })
})

describe('GitHub retries', () => {
  it.each([1, 2, 3])('recovers after %s failed gh calls with exponential backoff', async (failures) => {
    let tries = 0
    const r = await run(({ args }) => {
      if (workflows(args) && ++tries <= failures) throw new Error('HTTP 502 Bad Gateway')
    })
    expect(r.code).toBe(0)
    expect(r.retries).toHaveLength(failures)
    expect(r.retries[0]).toContain('HTTP 502 Bad Gateway')
    expect(r.calls.filter((c) => workflows(c.args)).map((c) => c.at)).toEqual([0, 1_000, 3_000, 7_000].slice(0, failures + 1))
  })

  it('exits 2 with the GitHub error after the initial call and three retries', async () => {
    const r = await run(({ args }) => { if (workflows(args)) throw new Error('HTTP 502 Bad Gateway') })
    expect(r.code).toBe(2)
    expect(r.message).toContain('HTTP 502 Bad Gateway')
    expect(r.calls.filter((c) => workflows(c.args))).toHaveLength(4)
    expect(r.elapsed).toBe(7_000)
  })

  it('bounds retry backoff by the overall deadline', async () => {
    const r = await run(() => { throw new Error('HTTP 502 Bad Gateway') }, { timeoutMs: 1_500 })
    expect(r.code).toBe(6)
    expect(r.elapsed).toBe(1_500)
    expect(r.calls.map((c) => c.at)).toEqual([0, 1_000])
  })

  it('retries ref resolution and check reads, not only the workflow endpoint', async () => {
    const seen = new Set<string>()
    const r = await run(({ args }) => {
      if (!seen.has(args[1]!)) { seen.add(args[1]!); throw new Error('HTTP 502 Bad Gateway') }
    })
    expect(r.code).toBe(0)
    expect(r.retries).toHaveLength(4)
  })
})
