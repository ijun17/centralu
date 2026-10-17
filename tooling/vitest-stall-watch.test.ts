import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { StallWatch, type Stall } from './vitest-stall-watch.js'
import { SLOW } from './test-timing.js'

/*
 * The stall watch (#368): vitest's worker gives up on its own messages after 60 s, so a test that holds the event loop
 * for about a minute failed a whole Windows run with "Timeout calling onTaskUpdate", naming no test.
 */
describe('the stall watch', () => {
  function watch(at: { now: number }) {
    const reports: Stall[] = []
    const w = new StallWatch({ now: () => at.now, where: () => 'here', everyMs: 1_000, reportMs: 15_000, failMs: 45_000, report: (s) => reports.push(s) })
    return { w, reports }
  }

  it('says nothing about ticks that come on time, or a little late', () => {
    const at = { now: 0 }
    const { w, reports } = watch(at)
    for (let i = 0; i < 10; i++) {
      at.now += 1_000 + 900
      w.tick()
    }
    expect(reports).toEqual([])
    expect(w.take()).toBeUndefined()
  })

  it('reports a long hold with where it happened, and fails the test only for one near the limit', () => {
    const at = { now: 0 }
    const { w, reports } = watch(at)
    at.now += 1_000 + 20_000
    w.tick()
    expect(reports).toEqual([{ ms: 20_000, where: 'here' }])
    expect(w.take()).toBeUndefined()
    at.now += 1_000 + 50_000
    w.tick()
    expect(w.take()).toEqual({ ms: 50_000, where: 'here' })
    // Once per test
    expect(w.take()).toBeUndefined()
  })

  it('counts a hold that ends with the test, before the next tick', () => {
    const at = { now: 0 }
    const { w } = watch(at)
    at.now += 47_000
    expect(w.take()?.ms).toBe(46_000)
  })
})

describe('the stall watch in a test run', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  it('fails the test that held its loop, by name, and not one that gave the loop turns', async () => {
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--project', 'unit', '--maxWorkers=1', 'tooling/fixtures/stall/stall-probe.test.ts'],
        { cwd: root, timeout: 50_000 * SLOW, env: { ...process.env, CC_STALL_PROBE: '1', CC_STALL_REPORT_MS: '1000', CC_STALL_FAIL_MS: '1500', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } },
        (_e, stdout, stderr) => resolve({ code: child.exitCode, text: `${stdout}\n${stderr}` }),
      )
    })
    expect(out.code).toBe(1)
    expect(out.text).toMatch(/held for \d+\.\d s at once in "holds the loop" \(tooling[/\\]fixtures[/\\]stall[/\\]stall-probe\.test\.ts\)/)
    expect(out.text).toMatch(/held for \d+\.\d s at once in "holds the loop with its timers faked"/)
    expect(out.text).not.toMatch(/in "gives the loop a turn/)
    expect(out.text).toMatch(/Tests {2}2 failed \| 1 passed/)
  }, 60_000 * SLOW)
})
