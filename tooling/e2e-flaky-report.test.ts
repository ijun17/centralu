import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Suite, TestCase } from '@playwright/test/reporter'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import FlakyReporter, { failedTests, flakyLines, flakySummary, flakyTests, knownFailureLines, knownFailures } from '../e2e/flaky-report.js'

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
  async function run(env: Record<string, string>, tests: TestCase[]) {
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
    await r.onEnd({ status: 'passed' } as never)
    const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return null } }
    return { lines: log.mock.calls.map((c) => String(c[0])), output: read(out), summary: read(summary) }
  }

  it('in a shard: annotates each flaky test, writes the summary and sets flaky=true for `e2e report`', async () => {
    const r = await run({ GITHUB_ACTIONS: 'true' }, [flaky])
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatch(/^::warning file=.*grid\.spec\.ts,line=12,title=flaky e2e test::/)
    expect(r.output).toBe('flaky=true\n')
    expect(r.summary).toContain('### 1 e2e test(s) passed only on retry\n')
  })

  it('in `e2e report`: the summary alone, under the engine, since the shards annotated already', async () => {
    const r = await run({ GITHUB_ACTIONS: 'true', E2E_FLAKY_LABEL: 'chromium' }, [flaky])
    expect(r.lines).toEqual([])
    expect(r.output).toBeNull()
    expect(r.summary).toContain('passed only on retry (chromium)')
  })

  it('writes nothing for a run without a flaky test, and nothing to GitHub files outside GitHub Actions', async () => {
    expect(await run({ GITHUB_ACTIONS: 'true' }, [testCase('steady', 'expected', [{ status: 'passed' }])])).toEqual({ lines: [], output: null, summary: null })
    const local = await run({ GITHUB_ACTIONS: '' }, [flaky])
    expect(local.lines[0]).toBe('[e2e] 1 test(s) failed, then passed on retry (flaky): fix them')
    expect(local.output).toBeNull()
    expect(local.summary).toBeNull()
  })
})

describe('the failures of a local run that the known intermittent failures issue lists', () => {
  const broken = testCase('opens a cell', 'unexpected', [{ status: 'failed', message: '\x1b[31mError: page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:5174/\x1b[39m' }])
  const own = testCase('renames a session', 'unexpected', [{ status: 'failed', message: 'Error: expect(received).toBe(expected)' }])

  it('are the ones Playwright calls failed, not the flaky or the passing ones', () => {
    expect(failedTests([broken, flaky, testCase('steady', 'expected', [{ status: 'passed' }])], ROOT).map((t) => t.title)).toEqual(['app › grid.spec.ts › grid › opens a cell'])
    // Named as CI's log names it, which the issue quotes
    expect(failedTests([broken], ROOT)[0]?.heading).toBe('[app] › e2e/grid.spec.ts:12:3 › grid › opens a cell')
  })

  /** The issue as `gh issue view --json body,comments,state` answers it, and what the fake gh was asked; the board's project.json names it */
  const BOARD = join(import.meta.dirname, '../.centralu/apps/project-board')
  const project: unknown = JSON.parse(readFileSync(join(BOARD, 'project.json'), 'utf8'))
  const NUMBER = typeof project === 'object' && project !== null && 'ci' in project && typeof project.ci === 'object' && project.ci !== null && 'knownFailuresIssue' in project.ci ? project.ci.knownFailuresIssue : null
  const REPO = typeof project === 'object' && project !== null && 'repository' in project ? project.repository : null
  const ENTRY = '```\npage.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:...\n```'
  function boardGh(issue: { body?: string; comments?: string[]; state?: string } | { fail: string }) {
    const dir = mkdtempSync(join(tmpdir(), 'cc-known-failures-'))
    dirs.push(dir)
    const state = join(dir, 'issue.json')
    writeFileSync(state, JSON.stringify(issue))
    writeFileSync(join(dir, 'asked.json'), '[]')
    // Answered in this process by the board's system.mjs, which reads PROJECT_BOARD_FAKE_PROGRAMS once, at the board's first import
    vi.stubEnv('PROJECT_BOARD_FAKE_PROGRAMS', FAKE)
    vi.stubEnv('FLAKY_REPORT_ISSUE', state)
    return () => JSON.parse(readFileSync(join(dir, 'asked.json'), 'utf8')) as unknown
  }
  const FAKE = join(mkdtempSync(join(tmpdir(), 'cc-fake-programs-')), 'fake.mjs')
  writeFileSync(
    FAKE,
    `import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
export function gh(args, { env }) {
  const asked = join(dirname(env.FLAKY_REPORT_ISSUE), 'asked.json')
  writeFileSync(asked, JSON.stringify([...JSON.parse(readFileSync(asked, 'utf8')), args]))
  const issue = JSON.parse(readFileSync(env.FLAKY_REPORT_ISSUE, 'utf8'))
  if (issue.fail) return { code: 1, stdout: '', stderr: issue.fail }
  return { code: 0, stdout: JSON.stringify({ body: issue.body, comments: (issue.comments ?? []).map((body) => ({ body })), state: issue.state ?? 'OPEN' }), stderr: '' }
}
`,
  )
  afterAll(() => rmSync(dirname(FAKE), { recursive: true, force: true }))

  it("are set apart with the quote they match, read and matched by the board as ci_status does, the issue's comments included", async () => {
    expect(typeof NUMBER).toBe('number')
    // The entries are comments on the issue; a main guard note is no judgement and is left out (github.mjs readIssueText)
    const asked = boardGh({ body: 'Known intermittent failures.', comments: ['<!-- main-guard note -->\n- [app] › e2e/grid.spec.ts:12:3 › grid › renames a session', ENTRY] })
    const failed = failedTests([broken, own], ROOT)
    const known = await knownFailures(failed)
    expect(asked()).toEqual([['issue', 'view', String(NUMBER), '-R', REPO, '--json', 'body,comments,state']])
    expect(knownFailureLines(failed, known)).toEqual([
      `[e2e] 1 of 2 failure(s) are known intermittent ones (#${String(NUMBER)}):`,
      '[e2e]   e2e/grid.spec.ts:12 app › grid.spec.ts › grid › opens a cell: matches "page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:..."',
    ])
    expect(knownFailureLines([], known)).toEqual([])
    // By CI's name of the test alone, as the issue lists one whose error varies
    boardGh({ body: '', comments: ['- [app] › e2e/grid.spec.ts:12:3 › grid › renames a session'] })
    expect(knownFailureLines(failedTests([own], ROOT), await knownFailures(failedTests([own], ROOT)))[0]).toBe(`[e2e] 1 of 1 failure(s) are known intermittent ones (#${String(NUMBER)}):`)
  })

  it('say so when the issue is closed, and when none of the failures is in it', async () => {
    boardGh({ body: ENTRY, state: 'CLOSED' })
    const failed = failedTests([broken], ROOT)
    expect(knownFailureLines(failed, await knownFailures(failed))[0]).toBe(`[e2e] 1 of 1 failure(s) are known intermittent ones (#${String(NUMBER)}, closed):`)
    boardGh({ body: ENTRY })
    const own1 = failedTests([own], ROOT)
    expect(knownFailureLines(own1, await knownFailures(own1))).toEqual([`[e2e] none of the 1 failure(s) is a known intermittent one (#${String(NUMBER)})`])
  })

  it('are none when the issue cannot be read, and the run says why in what gh said', async () => {
    boardGh({ fail: 'error connecting to api.github.com\nmore' })
    const failed = failedTests([broken], ROOT)
    const [line] = knownFailureLines(failed, await knownFailures(failed))
    expect(line).toBe(`[e2e] known-failures list unavailable: #${String(NUMBER)} could not be read: GitHub could not be reached (error connecting to api.github.com). Check the network, then refresh; no failure is set apart`)
  })

  it("are none, and the run says why, when the board's reader is missing or answers something else", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-known-failures-'))
    dirs.push(dir)
    const failed = failedTests([broken], ROOT)
    writeFileSync(join(dir, 'none.mjs'), 'export const other = 1\n')
    expect(await knownFailures(failed, join(dir, 'none.mjs'))).toEqual({ why: 'none.mjs exports no knownFailureQuotes' })
    writeFileSync(join(dir, 'odd.mjs'), "export const knownFailureQuotes = async () => ({ issue: 368, closed: false, quotes: ['a', 'b'] })\n")
    expect(await knownFailures(failed, join(dir, 'odd.mjs'))).toEqual({ why: 'the board answered something else' })
    writeFileSync(join(dir, 'throws.mjs'), "export const knownFailureQuotes = async () => { throw new Error('no project.json') }\n")
    expect(knownFailureLines(failed, await knownFailures(failed, join(dir, 'throws.mjs')))).toEqual(["[e2e] known-failures list unavailable: the board's known-failures reader failed (no project.json); no failure is set apart"])
    expect(await knownFailures(failed, join(dir, 'missing.mjs'))).toMatchObject({ why: expect.stringContaining("the board's known-failures reader failed") })
  })
})
