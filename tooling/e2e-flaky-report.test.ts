import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Suite, TestCase } from '@playwright/test/reporter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FlakyReporter, { flakyLines, flakySummary, flakyTests } from '../e2e/flaky-report.js'

/*
 * e2e/flaky-report.ts: in CI a failed test runs once more (e2e/playwright.config.ts `retries`), and one that passes
 * then must be named on the run, not counted as green (2026-10-19, the owner's decision).
 */

const ROOT = join(tmpdir(), 'repo')

function testCase(title: string, outcome: ReturnType<TestCase['outcome']>, results: Array<{ status: string; message?: string }> = []): TestCase {
  return {
    outcome: () => outcome,
    location: { file: join(ROOT, 'e2e', 'grid.spec.ts'), line: 12, column: 3 },
    titlePath: () => ['', 'app', 'grid.spec.ts', 'grid', title],
    results: results.map((r) => ({ status: r.status, error: r.message ? { message: r.message } : undefined, errors: r.message ? [{ message: r.message }] : [] })),
  } as unknown as TestCase
}

const flaky = testCase('opens a cell', 'flaky', [
  { status: 'failed', message: '\x1b[31mError: expect(locator).toBeVisible() failed\x1b[39m\n\nLocator: x' },
  { status: 'passed' },
])

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the tests that passed only on retry', () => {
  it('are the ones Playwright calls flaky, with where they are and why the first attempt failed', () => {
    const tests = flakyTests([flaky, testCase('steady', 'expected', [{ status: 'passed' }]), testCase('broken', 'unexpected', [{ status: 'failed', message: 'e' }, { status: 'failed', message: 'e' }])], ROOT)
    expect(tests).toEqual([{ file: 'e2e/grid.spec.ts', line: 12, title: 'app › grid.spec.ts › grid › opens a cell', error: 'Error: expect(locator).toBeVisible() failed' }])
  })

  it('say the first attempt ended without an error message when it timed out or was interrupted', () => {
    const [t] = flakyTests([testCase('slow', 'flaky', [{ status: 'timedOut' }, { status: 'passed' }])], ROOT)
    expect(t!.error).toBe('the first attempt ended timedOut')
  })

  it('are an annotation each on GitHub Actions, escaped, and plain lines elsewhere', () => {
    const t = { file: 'e2e/a,b.spec.ts', line: 3, title: 'app › a: b', error: '50% done\nmore' }
    expect(flakyLines([t], true)).toEqual(['::warning file=e2e/a%2Cb.spec.ts,line=3,title=flaky e2e test::app › a: b failed, then passed on retry: fix it. First attempt: 50%25 done%0Amore'])
    expect(flakyLines([t], false)).toEqual(['[e2e] 1 test(s) failed, then passed on retry (flaky): fix them', '[e2e]   e2e/a,b.spec.ts:3 app › a: b: 50% done\nmore'])
    expect(flakyLines([], true)).toEqual([])
  })

  it('are a table in the job summary, under the engine name when one is given', () => {
    const t = { file: 'e2e/a.spec.ts', line: 3, title: 'a | b', error: 'boom' }
    const table = flakySummary([t], 'webkit')
    expect(table).toContain('### 1 e2e test(s) passed only on retry (webkit)')
    expect(table).toContain('| a \\| b | `e2e/a.spec.ts:3` | boom |')
    expect(flakySummary([])).toBe('')
  })
})

describe('the reporter', () => {
  function run(env: Record<string, string>, tests: TestCase[]) {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-report-'))
    dirs.push(dir)
    const out = join(dir, 'output')
    const summary = join(dir, 'summary')
    vi.stubEnv('GITHUB_OUTPUT', out)
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary)
    vi.stubEnv('E2E_FLAKY_LABEL', '')
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = new FlakyReporter()
    r.onBegin({}, { allTests: () => tests } as unknown as Suite)
    r.onEnd({ status: 'passed' } as never)
    const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return null } }
    return { lines: log.mock.calls.map((c) => String(c[0])), output: read(out), summary: read(summary) }
  }

  it('in a shard: annotates each flaky test, writes the summary and sets flaky=true for `e2e report`', () => {
    const r = run({ GITHUB_ACTIONS: 'true' }, [flaky])
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatch(/^::warning file=.*grid\.spec\.ts,line=12,title=flaky e2e test::/)
    expect(r.output).toBe('flaky=true\n')
    expect(r.summary).toContain('### 1 e2e test(s) passed only on retry\n')
  })

  it('in `e2e report`: the summary alone, under the engine, since the shards annotated already', () => {
    const r = run({ GITHUB_ACTIONS: 'true', E2E_FLAKY_LABEL: 'chromium' }, [flaky])
    expect(r.lines).toEqual([])
    expect(r.output).toBeNull()
    expect(r.summary).toContain('passed only on retry (chromium)')
  })

  it('writes nothing for a run without a flaky test, and nothing to GitHub files outside GitHub Actions', () => {
    expect(run({ GITHUB_ACTIONS: 'true' }, [testCase('steady', 'expected', [{ status: 'passed' }])])).toEqual({ lines: [], output: null, summary: null })
    const local = run({ GITHUB_ACTIONS: '' }, [flaky])
    expect(local.lines[0]).toBe('[e2e] 1 test(s) failed, then passed on retry (flaky): fix them')
    expect(local.output).toBeNull()
    expect(local.summary).toBeNull()
  })
})
