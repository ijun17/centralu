/** What `pnpm pre-pr` reads in its tools' answers (scripts/pre-pr-reports.mjs): vitest's JSON report, recorded or from a real run, and dependency-cruiser's. */
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { realRunners } from '../scripts/pre-pr.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { depErrorsOf, failuresOf, filesRunMs, orphansOf, passingNewTests, vitestTests } from '../scripts/pre-pr-reports.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { canonical, unlinkLinks } from '../scripts/pre-pr-worktrees.mjs'
import { recordedReport, yieldBetweenTests } from './pre-pr.test-helpers.js'

yieldBetweenTests()

describe("what pre-pr reads in its tools' answers", () => {
  it('reads the errors dependency-cruiser gives other than orphans, once each', () => {
    const v = (name: string, severity: string, from: string, extra = {}) => ({ rule: { name, severity }, from, ...extra })
    expect(depErrorsOf({ summary: { violations: [v('no-orphans', 'error', 'o.ts'), v('x', 'warn', 'w.ts'), v('core-no-io', 'error', 'a.ts', { to: 'node:fs' }), v('core-no-io', 'error', 'a.ts', { to: 'node:fs' }), v('no-circular', 'error', 'a.ts', { cycle: [{ name: 'b.ts' }, { name: 'a.ts' }] })] } })).toEqual([
      'a.ts -> b.ts -> a.ts breaks no-circular (tooling/dependency-cruiser.cjs)',
      'a.ts -> node:fs breaks core-no-io (tooling/dependency-cruiser.cjs)',
    ])
    expect(depErrorsOf({})).toEqual([])
  })

  it('reads orphans at any severity, and nothing else', () => {
    expect(orphansOf({ summary: { violations: [{ rule: { name: 'no-orphans' }, from: 'b.ts' }, { rule: { name: 'no-orphans' }, from: 'a.ts' }, { rule: { name: 'x' }, from: 'c.ts' }] } })).toEqual(['a.ts', 'b.ts'])
    expect(orphansOf({})).toEqual([])
  })

  it('names a test by its describe blocks and reports only a new one that passes', () => {
    const root = join(tmpdir(), 'r')
    const tests = vitestTests({ testResults: [{ name: join(root, 'a', 'x.test.ts'), assertionResults: [{ ancestorTitles: ['outer'], title: 'one', status: 'passed' }, { ancestorTitles: [], title: 'two', status: 'failed' }, { ancestorTitles: [], title: 'three', status: 'passed' }] }] }, root)
    expect(tests[0]).toEqual({ file: 'a/x.test.ts', name: 'outer > one', status: 'passed' })
    expect(passingNewTests({ reverted: tests, base: [{ file: 'a/x.test.ts', name: 'three', status: 'passed' }] })).toEqual([tests[0]])
  })

  it('names a file from a root given by another spelling of its folder, as vitest reports it by its real path', () => {
    // A link stands in for a Windows temporary folder's 8.3 name: both reach the folder vitest names by its real path
    const base = mkdtempSync(join(tmpdir(), 'cc-prepr-spelling-'))
    try {
      mkdirSync(join(base, 'real'))
      symlinkSync(join(base, 'real'), join(base, 'link'), 'junction')
      const name = join(canonical(join(base, 'real')), 'a', 'x.test.ts')
      const report = { testResults: [{ name, status: 'failed', message: 'no', startTime: 1, endTime: 5, assertionResults: [{ ancestorTitles: [], title: 'one', status: 'failed', failureMessages: ['no'] }] }] }
      const root = join(base, 'link')
      expect(vitestTests(report, root).map((t: { file: string }) => t.file)).toEqual(['a/x.test.ts'])
      expect(failuresOf(report, root).map((f: { file: string }) => f.file)).toEqual(['a/x.test.ts'])
      expect(filesRunMs(report, root, ['a/x.test.ts'])).toBe(4)
    } finally {
      unlinkLinks(base)
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('names the tests of a file with the real vitest without running one, the skipped and todo ones too', () => {
    // A folder of its own that reaches this checkout's dependencies, so no test file lands among the repository's
    const dir = mkdtempSync(join(tmpdir(), 'cc-prepr-names-'))
    try {
      symlinkSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'), join(dir, 'node_modules'), 'junction')
      writeFileSync(
        join(dir, 'names.test.ts'),
        [
          "import { describe, expect, it } from 'vitest'",
          "it('runs', () => { throw new Error('ran') })",
          "it.skip('is skipped', () => {})",
          "it.todo('is todo')",
          "it.runIf(false)('is not run here', () => {})",
          "describe.skip('a skipped block', () => { it('inside', () => {}) })",
          "describe('a block', () => { it('inside too', () => expect(1).toBe(1)) })",
          '',
        ].join('\n'),
      )
      // And one that does not load, as a base file may not with the pull request's test helpers: a failure of the file, no test
      writeFileSync(join(dir, 'broken.test.ts'), "import { gone } from './gone.js'\nimport { it } from 'vitest'\nit('uses it', () => gone())\n")
      const named = realRunners.vitest(dir, ['names.test.ts', 'broken.test.ts'], { timeoutMs: 60_000 * SLOW, namesOnly: true })
      expect(named.timedOut).toBe(false)
      expect(failuresOf(named.report, dir)).toEqual([{ file: 'broken.test.ts', name: '', line: expect.stringContaining('gone.js'), detail: expect.any(Array) }])
      const tests = vitestTests(named.report, dir)
      expect(tests.map((t: { name: string }) => t.name).sort()).toEqual(['a block > inside too', 'a skipped block > inside', 'is not run here', 'is skipped', 'is todo', 'runs'])
      // None ran: the first would have failed
      expect(new Set(tests.map((t: { status: string }) => t.status))).toEqual(new Set(['skipped']))
      expect(vitestTests(null, dir)).toEqual([])
    } finally {
      unlinkLinks(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000 * SLOW)

  it('ends a real vitest run at the first passing test that is not known, the rest left pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-prepr-stop-'))
    try {
      symlinkSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'), join(dir, 'node_modules'), 'junction')
      const later = Array.from({ length: 5 }, (_, i) => `  it('later ${i}', async () => { await new Promise((r) => setTimeout(r, 500)); expect(1).toBe(2) })`)
      writeFileSync(
        join(dir, 'stop.test.ts'),
        ["import { describe, expect, it } from 'vitest'", "describe('g', () => {", "  it('known', () => expect(1).toBe(1))", "  it('new', () => expect(1).toBe(1))", ...later, '})', ''].join('\n'),
      )
      const r = realRunners.vitest(dir, ['stop.test.ts'], { timeoutMs: 60_000 * SLOW, known: [{ file: 'stop.test.ts', name: 'g > known' }] })
      const status = Object.fromEntries(vitestTests(r.report, dir).map((t: { name: string; status: string }) => [t.name, t.status]))
      expect(status['g > known']).toBe('passed')
      expect(status['g > new']).toBe('passed')
      // The test running when the run is ended may finish; the ones after it never start
      expect(Object.values(status).filter((v) => v === 'pending').length).toBeGreaterThanOrEqual(3)
      // Without `known` nothing ends the run
      const all = realRunners.vitest(dir, ['stop.test.ts'], { timeoutMs: 60_000 * SLOW })
      expect(vitestTests(all.report, dir).filter((t: { status: string }) => t.status === 'pending')).toEqual([])
    } finally {
      unlinkLinks(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000 * SLOW)

  it('reads how long the slowest of some files of a report took on its own, not the span the shared pass took around them', () => {
    const root = join(tmpdir(), 'r')
    // a ran at the start and b at the end of a long pass: the span is 44 s, a pass of the two together takes the slower's 7 s
    const report = { testResults: [{ name: join(root, 'a.test.ts'), startTime: 1000, endTime: 5000 }, { name: join(root, 'b.test.ts'), startTime: 38_000, endTime: 45_000 }, { name: join(root, 'c.test.ts'), startTime: 0, endTime: 50_000 }] }
    expect(filesRunMs(report, root, ['a.test.ts', 'b.test.ts'])).toBe(7000)
    expect(filesRunMs(report, root, ['a.test.ts'])).toBe(4000)
    expect(filesRunMs(report, root, ['other.test.ts'])).toBe(0)
    expect(filesRunMs(null, root, ['a.test.ts'])).toBe(0)
    // A file with no time in the report counts for nothing, not for NaN (which no gate and no limit would take as a number)
    expect(filesRunMs({ testResults: [{ name: join(root, 'a.test.ts'), startTime: 1000 }, { name: join(root, 'b.test.ts'), startTime: 0, endTime: 3000 }] }, root, ['a.test.ts', 'b.test.ts'])).toBe(3000)
  })

  it('reads the first line of a failure, or of a file that did not load', () => {
    const root = join(tmpdir(), 'r')
    const report = {
      testResults: [
        { name: join(root, 'tooling', 'a.test.ts'), status: 'failed', assertionResults: [{ ancestorTitles: ['g'], title: 'one', status: 'failed', failureMessages: ['\u001b[31mError: boom\u001b[39m\n  at x'] }, { ancestorTitles: [], title: 'two', status: 'passed', failureMessages: [] }] },
        { name: join(root, 'tooling', 'b.test.ts'), status: 'failed', message: 'Cannot find module ./x', assertionResults: [] },
      ],
    }
    expect(failuresOf(report, root)).toEqual([
      { file: 'tooling/a.test.ts', name: 'g > one', line: 'Error: boom', detail: ['Error: boom'] },
      { file: 'tooling/b.test.ts', name: '', line: 'Cannot find module ./x', detail: ['Cannot find module ./x'] },
    ])
    // A real report (recorded): vitest's JSON has no diff, so what a failure says is the guard's message, which names what it found
    expect(failuresOf(recordedReport('os-allowlist-failing.json', root), root)).toEqual([
      {
        file: 'tooling/os-layer.test.ts',
        name: 'the allowlist > says no more than is true: every listed file exists and still touches the OS, and every such file is listed',
        line: 'AssertionError: tooling/os-allowlist.txt is not what `tsx tooling/os-tests.ts --offenders` prints. Listed, but gone or no longer touching the OS: packages/protocol/src/index.ts. Touching the OS, not listed: none: expected { …(2) } to deeply equal { extra: [], missing: [] }',
        detail: [expect.stringMatching(/^AssertionError: /)],
      },
      {
        file: 'tooling/os-layer.test.ts',
        name: "the allowlist > lists nothing main's list does not: no new line but a file git sees renamed",
        line: "AssertionError: tooling/os-allowlist.txt lists more than main's (packages/protocol/src/index.ts): put the new code behind the OS layer instead (docs/plans/os-layer.md): expected [ 'packages/protocol/src/index.ts' ] to deeply equal []",
        detail: [expect.stringMatching(/^AssertionError: /)],
      },
    ])

  })
})
