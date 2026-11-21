import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
import { NO_GIT_MAINTENANCE } from './git-fixture.test-helpers.js'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { failuresOf, guardWarnings, isTestFile, filesRunMs, isVitestFile, nodeBin, depErrorsOf, orphansOf, parseArgs, passingNewTests, prePr, realRunners, stackHeads, STEP_DIR, stepNumbers, stepsAddedByDiff, vitestTests } from '../scripts/pre-pr.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { GUARD_REFS, removeRun, runDir, sweepStale, unlinkLinks } from '../scripts/pre-pr-worktrees.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { interruptsSoFar, runTool } from '../scripts/interrupts.mjs'
import { GUARDS } from './guards.js'

/**
 * `pnpm pre-pr` (#1181): the checks run on real git repositories made here, with the tools (pnpm
 * install, tsc, dependency-cruiser, vitest) replaced by fakes that read the worktree they are given.
 * A fake test file is one line a test: `name :: file :: text`, passing when the file holds the text.
 */

/*
 * Much of this file is synchronous work (git, tsc and vitest through `execFileSync`) that holds the worker's event loop, and
 * vitest's worker gives up on the answer to a report after 60 s ("Timeout calling onTaskUpdate", tooling/vitest-stall-watch.ts).
 * On a loaded runner the file hit it with every test passing. The loop gets a turn after each test, so a report is answered
 * between tests and not only when the file ends.
 */
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

// No automatic maintenance: a commit starts a detached `git maintenance run --auto` that holds objects/maintenance.lock after the
// commit returns, and the copy of a template made right then (cpSync) meets the lock vanishing: ENOENT on its .git/objects
/** Git's empty tree: a diff from it holds every file */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C', ...NO_GIT_MAINTENANCE }
const gitIn = (env: NodeJS.ProcessEnv, cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env }).trim()
const git = (cwd: string, ...args: string[]) => gitIn(GIT_ENV, cwd, args)

type Report = { testResults: { name: string; status?: string; message?: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[] }
type Pass = { report: Report | null; timedOut: boolean }

/** A vitest JSON report recorded from a real run (tooling/fixtures/pre-pr), with `root` where the recording's checkout was */
const recordedReport = (name: string, root: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/pre-pr/${name}`, import.meta.url)), 'utf8').replaceAll('<root>', root.split('\\').join('/')))

/** Starts, with `start`, a real tool that SIGINT ends, as Ctrl-C ends it; throws what `start` throws for it */
const endedBySigint = (start: typeof execFileSync) => start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 1000, killSignal: 'SIGINT', stdio: 'ignore' })

/**
 * A real tool ended by SIGINT, as Ctrl-C ends it, started as pre-pr starts its tools; its runner answers a failure, as a real one
 * does. Node names the signal it sent on every system, though on Windows the end is TerminateProcess.
 */
function interruptedTool() {
  try {
    endedBySigint(runTool)
  } catch {
    // the failure every runner answers for it
  }
  return { ok: false, out: 'terminated', timedOut: false }
}

/**
 * `linkTo`: each worktree gets a real link (a junction on Windows) at src/node_modules to that folder,
 * as prepare's links into the checkout's dependencies are, so the clean-up is tested on the real thing.
 */
function fakeRunners(opts: { orphans?: string[]; cycle?: boolean; lintFails?: boolean; linkTo?: string } = {}) {
  const calls = { prepare: [] as string[], tsc: [] as string[], lint: [] as string[][], vitest: [] as string[][], names: [] as string[][], timeouts: [] as (number | undefined)[], known: [] as (string[] | undefined)[] }
  return {
    calls,
    runners: {
      tier: realRunners.tier,
      prepare: (dir: string) => {
        const sha = git(dir, 'rev-parse', 'HEAD')
        calls.prepare.push(sha)
        if (opts.linkTo) symlinkSync(opts.linkTo, join(dir, 'src', 'node_modules'), 'junction')
      },
      tsc: (dir: string, o?: { timeoutMs?: number }) => {
        calls.timeouts.push(o?.timeoutMs)
        calls.tsc.push(git(dir, 'rev-parse', 'HEAD'))
        return existsSync(join(dir, 'BROKEN')) ? { ok: false, out: 'src/a.ts(1,1): error TS2322: broken' } : { ok: true, out: '' }
      },
      depcruise: () => ({
        summary: {
          violations: [
            ...(opts.orphans ?? []).map((from) => ({ rule: { name: 'no-orphans', severity: 'warn' }, from })),
            ...(opts.cycle ? [{ rule: { name: 'no-circular', severity: 'error' }, from: 'src/a.mjs', to: 'src/b.mjs', cycle: [{ name: 'src/b.mjs' }, { name: 'src/a.mjs' }] }] : []),
            { rule: { name: 'not-to-unresolvable', severity: 'warn' }, from: 'src/x.ts' },
          ],
        },
      }),
      lint: (_dir: string, files: string[]) => {
        calls.lint.push(files)
        return opts.lintFails ? { ok: false, out: 'src/b.mjs\n  1:1  error  Unsafe type assertion  @typescript-eslint/no-unsafe-type-assertion' } : { ok: true, out: '' }
      },
      // The declaration (tooling/guards.ts) is JSON here, `[{ test, tests?, reads? }]`, where the real one is TypeScript that
      // scripts/pre-pr-guards.mjs reads; a guard is changed when the commits change its test or a file it reads
      guards: (dir: string, from: string, to: string) => {
        const file = join(dir, 'tooling', 'guards.ts')
        if (!existsSync(file)) return { guards: null, changed: [] }
        const declared = JSON.parse(readFileSync(file, 'utf8')) as { test: string; tests?: string; reads?: string[] }[]
        const paths = git(dir, 'diff', '--name-only', from, to).split('\n')
        return { guards: declared.map(({ test, tests }) => ({ test, tests })), changed: declared.filter((g) => [g.test, ...(g.reads ?? [])].some((f) => paths.includes(f))).map((g) => g.test) }
      },
      // A line `title :: file :: text` is a test that passes when the file holds the text; a fourth field `skip` makes it a skipped
      // one. With `namesOnly` none runs: every test is named, as skipped. With `known` the run ends at the first passing test not
      // among them, as pre-pr-stop-reporter.mjs ends it: the tests after it are pending. A line `does not load :: <message>` makes
      // the file one that does not load, as the real vitest reports it (a test below checks that)
      vitest: (dir: string, files: string[], o?: { timeoutMs?: number; namesOnly?: boolean; known?: { file: string; name: string }[] }): Pass => {
        calls.timeouts.push(o?.timeoutMs)
        ;(o?.namesOnly ? calls.names : calls.vitest).push(files)
        if (!o?.namesOnly) calls.known.push(o?.known?.map((t) => `${t.file} > ${t.name}`))
        let ended = false
        const unloaded = (file: string) => /^does not load :: (.*)$/m.exec(readFileSync(join(dir, file), 'utf8'))?.[1]
        return {
          timedOut: false,
          report: {
            testResults: files.map((file) => ({
              name: join(dir, file),
              ...(unloaded(file) ? { status: 'failed', message: unloaded(file) } : {}),
              assertionResults: unloaded(file) ? [] : readFileSync(join(dir, file), 'utf8')
                .split('\n')
                .filter((l) => l.includes(' :: '))
                .map((l) => {
                  const [title, target, text, skip] = l.split(' :: ').map((s) => s.trim()) as [string, string, string, string | undefined]
                  const ok = existsSync(join(dir, target)) && readFileSync(join(dir, target), 'utf8').includes(text)
                  const status = ended ? 'pending' : o?.namesOnly || skip ? 'skipped' : ok ? 'passed' : 'failed'
                  if (status === 'passed' && o?.known && !o.known.some((t) => t.file === file && t.name === title)) ended = true
                  return { ancestorTitles: [], title, status }
                }),
            })),
          },
        }
      },
    },
  }
}

describe('what pre-pr reads', () => {
  it.each([
    ['tooling/pre-pr.test.ts', true, true],
    ['packages/ui/src/x.test.tsx', true, true],
    ['tooling/fake-gh.test-helpers.ts', true, false],
    ['e2e/grid.spec.ts', true, false],
    ['e2e/ux/klm.test.ts', true, false],
    ['e2e/ux/core.task.ts', true, false],
    ['e2e/fixtures/usage-donut-gap.ts', true, false],
    // The harness is code vitest tests: reverted like any other
    ['e2e/flaky-report.ts', false, false],
    ['e2e/playwright.config.ts', false, false],
    ['tooling/fixtures/a.json', true, false],
    ['packages/ui/src/x.tsx', false, false],
    ['scripts/pre-pr.mjs', false, false],
  ])('%s: a test file %s, run by vitest %s', (path, test, vitest) => {
    expect(isTestFile(path)).toBe(test)
    expect(isVitestFile(path)).toBe(vitest)
  })

  it('finds the heads of a stack oldest first, one per commit, the head last', () => {
    const heads = stackHeads({
      commits: ['c1', 'c2', 'c3'],
      refs: [
        { sha: 'c2', name: 'origin/part-2' },
        { sha: 'c1', name: 'part-1' },
        { sha: 'c2', name: 'part-2' },
        { sha: 'old', name: 'merged-long-ago' },
      ],
      head: { sha: 'c3', name: 'HEAD' },
    })
    expect(heads).toEqual([
      { sha: 'c1', names: ['part-1'] },
      { sha: 'c2', names: ['origin/part-2', 'part-2'] },
      { sha: 'c3', names: ['HEAD'] },
    ])
  })

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

  it('reads its arguments, and refuses one it does not know', () => {
    expect(parseArgs(['--head', 'origin/x', '--base', 'origin/y', '--stack', 'a', '--stack', 'b', '--exempt', 'revert=a=b', '--run-id', '12-3', '--no-fetch', '--json', '--only', 'lint', '--only', 'tsc'])).toEqual({
      fetch: false, json: true, head: 'origin/x', base: 'origin/y', stack: ['a', 'b'], exempt: { revert: 'a=b' }, runId: '12-3', only: ['lint', 'tsc'],
    })
    expect(parseArgs(['--limit', '90', '--guards-limit', '30'])).toMatchObject({ limitMs: 90_000, guardsLimitMs: 30_000 })
    expect(() => parseArgs(['--skip'])).toThrow(/Unknown argument --skip/)
    expect(() => parseArgs(['--exempt', 'revert'])).toThrow(/Unknown argument --exempt/)
    expect(() => parseArgs(['--cleanup', '../x'])).toThrow(/--cleanup takes a run id/)
  })
})

/*
 * The templates below are copied right after their last commit. Since git 2.29 a commit starts `git maintenance run --auto`,
 * detached in newer versions: it takes .git/objects/maintenance.lock before it detaches and gives it up a moment after the
 * commit has returned, so a copy that lists .git/objects in that moment finds the file gone (macOS runs of this file, jobs
 * 127139809160 and 127151555492: `ENOENT ... .git/objects` from cpSync in a beforeEach, in the first test after a template
 * was built). git's trace shows the start whether or not the maintenance had anything to do, so this does not wait for the race.
 */
describe('the repositories this file builds', () => {
  it('start no background git maintenance when they commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-prepr-maintenance-'))
    try {
      const repo = join(dir, 'repo')
      mkdirSync(repo)
      git(repo, 'init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'a.txt'), 'a\n')
      git(repo, 'add', '-A')
      const trace = join(dir, 'trace.json')
      gitIn({ ...GIT_ENV, GIT_TRACE2_EVENT: trace }, repo, ['commit', '-q', '-m', 'main'])
      const started = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; argv?: string[] })
        .filter((e) => e.event === 'child_start').map((e) => (e.argv ?? []).join(' '))
      expect(started.filter((a) => a.includes('maintenance'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** The guards of the repositories below, as the fake reads them (fakeRunners) */
const DECLARED = `${JSON.stringify([{ test: 'tooling/doc-refs.test.ts' }, { test: 'tooling/os-layer.test.ts', tests: 'the allowlist' }])}\n`

describe('pre-pr on a stack of two pull requests', () => {
  let repo = ''
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const commit = (message: string) => {
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
  }
  const run = (over: Record<string, unknown> = {}, orphans?: string[], more: { cycle?: boolean; lintFails?: boolean } = {}) => {
    const fake = fakeRunners({ orphans, ...more })
    const result = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: fake.runners, ...over })
    return { ...result, calls: fake.calls }
  }

  // The repository every test starts from, built once and copied: the init and the commits per test were most of the setup
  let template = ''
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-prepr-test-template-'))
    git(repo, 'init', '-q', '-b', 'main')
    write('src/a.mjs', 'export const value = 1\n')
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\n')
    commit('main')
    // The lower pull request: a fix, a test that guards it, and one that guards nothing
    git(repo, 'checkout', '-q', '-b', 'lower')
    write('src/a.mjs', 'export const value = 2\n')
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nknows two :: src/a.mjs :: value = 2\nstill exports :: src/a.mjs :: export\n')
    commit('lower')
    // The top: a new module with a new test file, one test guarding it and one not
    git(repo, 'checkout', '-q', '-b', 'top')
    write('src/b.mjs', 'export const b = 1\n')
    write('src/b.test.mjs', 'has b :: src/b.mjs :: b = 1\nhas a :: src/a.mjs :: value\n')
    write('docs/b.md', 'b\n')
    commit('top')
    template = repo
  })

  afterAll(() => {
    rmSync(template, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-prepr-test-'))
    cpSync(template, repo, { recursive: true })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('asks the base which tests a changed file had before the run, and only of a file that is not new', () => {
    git(repo, 'checkout', '-q', '-b', 'solo', 'main')
    write('src/a.test.mjs', 'knows two :: src/a.mjs :: value = 2\n')
    write('src/c.test.mjs', 'has c :: src/c.mjs :: c\n')
    commit('solo')
    const solo = run({ head: 'solo' })
    expect(solo.calls.names).toEqual([['src/a.test.mjs']])
    expect(solo.calls.vitest).toEqual([['src/a.test.mjs', 'src/c.test.mjs']])
    // The run is given the base's tests, so it can end at the first new one that passes
    expect(solo.calls.known).toEqual([['src/a.test.mjs > keeps a value']])
    expect(solo.findings).toEqual([])
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nstill exports :: src/a.mjs :: export\n')
    commit('solo: a test that guards nothing')
    expect(run({ head: 'solo' }).findings.map((f: { message: string }) => f.message.split(' passes')[0])).toEqual(['src/a.test.mjs: "still exports"'])
  })

  it('stops at the first check that finds something, names the ones it did not run, and prints each step\'s time', () => {
    const logged: string[] = []
    const r = run({ log: (m: string) => logged.push(m) }, undefined, { lintFails: true })
    expect(r.findings.map((f: { check: string }) => f.check)).toEqual(['lint'])
    expect(r.calls.tsc).toEqual([])
    expect(r.calls.vitest).toEqual([])
    expect(r.notes).toContain('Not run, since lint found something: tsc, orphans, deps, repo-guards, store-step, revert, guards. Fix it, then run the one that failed with pnpm pre-pr --only <check>, and the whole run once more before the pull request.')
    expect(logged.filter((m) => /^lint: \d+ s$/.test(m))).toHaveLength(1)
    // Nothing found: every step runs, and each says its time
    const ok = run({ log: (m: string) => logged.push(m), exempt: { revert: 'x' } })
    expect(ok.ok).toBe(true)
    // What held, in the words the pull request's Verified gives it; the exempted check is not among them
    expect(ok.passed).toEqual(['lint on the changed files', 'tsc at 2 head(s)', 'no orphans', 'no dependency errors', 'the repository-wide guards'])
    expect(logged.filter((m) => /^[\w-]+: \d+ s$/.test(m)).map((m) => m.split(':')[0])).toEqual(['lint', 'lint', 'tsc', 'dependency-cruiser', 'repo-guards', 'store-step', 'guards'])
  })

  it('runs only the checks --only names, and none the run would stop on before them', () => {
    const r = run({ only: ['revert'] }, ['src/lonely.mjs'], { lintFails: true })
    expect(r.calls.lint).toEqual([])
    expect(r.calls.tsc).toEqual([])
    expect(r.findings.map((f: { check: string }) => f.check)).toEqual(['revert'])
    // Of the two checks one dependency-cruiser run answers, only the one named
    const orphans = run({ only: ['orphans'] }, ['src/lonely.mjs'], { cycle: true })
    expect(orphans.findings.map((f: { check: string }) => f.check)).toEqual(['orphans'])
    // tsc alone builds every head of the stack, and nothing else
    const tsc = run({ only: ['tsc'] })
    expect(tsc.calls.tsc).toHaveLength(2)
    expect(tsc.calls.lint).toEqual([])
    expect(tsc.ok).toBe(true)
    expect(() => run({ only: ['all'] })).toThrow('No check is called all; the checks are lint, tsc, orphans, deps, repo-guards, store-step, revert, guards.')
    expect(() => run({ only: ['lint'], exempt: { lint: 'x' } })).toThrow('lint is both run alone (--only) and exempted: one or the other.')
  })

  it('runs the repository-wide guards of every branch at the head, against main, and refuses what they fail', () => {
    const fake = fakeRunners()
    const calls: { files: string[]; o?: { testNamePattern?: string; env?: Record<string, string> } }[] = []
    // passing; the allowlist's tests skipped on this system; or doc-refs failing and the allowlist's tests renamed
    let state: 'passing' | 'skipped here' | 'failing' = 'passing'
    const failure = 'Error: a section that does not exist'
    let recorded = false
    const vitest = (dir: string, files: string[], o?: { testNamePattern?: string; env?: Record<string, string>; namesOnly?: boolean }) => {
      if (!files[0]?.startsWith('tooling/')) return fake.runners.vitest(dir, files, o)
      calls.push({ files, o })
      const docs = files[0] === 'tooling/doc-refs.test.ts'
      if (recorded && docs) return { timedOut: false, report: recordedReport('doc-refs-failing.json', dir) }
      const status = state === 'failing' && docs ? 'failed' : state !== 'passing' && !docs ? 'skipped' : 'passed'
      const ancestorTitles = docs ? ['refs'] : [state === 'failing' ? 'the list of files' : 'the allowlist']
      return { timedOut: false, report: { testResults: [{ name: join(dir, files[0]), status, assertionResults: [{ ancestorTitles, title: 'holds', status, failureMessages: [failure] }] }] } }
    }
    const guarded = (over: Record<string, unknown> = {}) => prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, vitest }, exempt: { revert: 'x' }, ...over })
    // A branch older than a guard has no file of it to run
    expect(guarded().ok).toBe(true)
    expect(calls).toEqual([])
    write('tooling/doc-refs.test.ts', 'x\n')
    write('tooling/os-layer.test.ts', 'x\n')
    write('tooling/guards.ts', DECLARED)
    commit('the guards')
    expect(guarded().ok).toBe(true)
    const main = git(repo, 'rev-parse', 'main')
    expect(calls).toEqual([
      { files: ['tooling/doc-refs.test.ts'], o: expect.objectContaining({ testNamePattern: undefined, env: { CC_LINT_BASE: main } }) },
      { files: ['tooling/os-layer.test.ts'], o: expect.objectContaining({ testNamePattern: 'the allowlist', env: { CC_LINT_BASE: main } }) },
    ])
    // Tests the pattern names that this system skips are there: nothing to say
    state = 'skipped here'
    expect(guarded().ok).toBe(true)
    // A failure is a finding; a pattern that no longer names a test is one too, not a pass
    state = 'failing'
    expect(guarded().findings.map((f: { check: string; message: string }) => [f.check, f.message])).toEqual([
      ['repo-guards', 'tooling/doc-refs.test.ts > refs > holds fails: Error: a section that does not exist'],
      ['repo-guards', 'tooling/os-layer.test.ts has no test named like "the allowlist": tooling/guards.ts declares a guard that is not there.'],
    ])
    expect(guarded({ exempt: { revert: 'x', 'repo-guards': 'a doc reference the next PR adds' } }).ok).toBe(true)
    // A real failing run (recorded): the finding is the guard's message, which names what it found, up to the stack
    recorded = true
    const [docs] = guarded().findings.map((f: { message: string }) => f.message)
    expect(docs).toBe(
      [
        'tooling/doc-refs.test.ts > guard/doc-refs > finds no reference to a section that is not there fails: ',
        'AssertionError: references to a section that is not there:',
        'docs/README.md:72: docs/architecture.md has no section 99',
        'docs/README.md:72: docs/releasing.md has no heading "No such heading"',
        ': expected [ …(2) ] to deeply equal []',
      ].join('\n'),
    )
  })

  it('says so when the branch removes a guard tooling/guards.ts declares, or the declaration main has', () => {
    const fake = fakeRunners()
    const vitest = (dir: string, files: string[], o?: { namesOnly?: boolean }) =>
      files[0]?.startsWith('tooling/')
        ? { timedOut: false, report: { testResults: [{ name: join(dir, files[0]), status: 'passed', assertionResults: [{ ancestorTitles: ['the allowlist'], title: 'holds', status: 'passed', failureMessages: [] }] }] } }
        : fake.runners.vitest(dir, files, o)
    const guarded = () => prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, vitest }, exempt: { revert: 'x' } })
    git(repo, 'checkout', '-q', 'main')
    write('tooling/doc-refs.test.ts', 'x\n')
    write('tooling/os-layer.test.ts', 'x\n')
    write('tooling/guards.ts', DECLARED)
    commit('main: the guards')
    git(repo, 'checkout', '-q', 'top')
    git(repo, 'merge', '-q', '--no-edit', 'main')
    expect(guarded().ok).toBe(true)
    git(repo, 'rm', '-q', 'tooling/os-layer.test.ts')
    commit('top: no os guard')
    expect(guarded().findings.map((f: { check: string; message: string }) => [f.check, f.message])).toEqual([
      ['repo-guards', 'tooling/os-layer.test.ts is not at this head, though tooling/guards.ts declares it: keep it, or change the declaration with it.'],
    ])
    git(repo, 'rm', '-q', 'tooling/guards.ts')
    commit('top: no declaration')
    expect(guarded().findings.map((f: { check: string; message: string }) => [f.check, f.message])).toEqual([
      ['repo-guards', 'tooling/guards.ts is not at this head, though it was where the branch left main: keep it, with the guards it declares.'],
    ])
  })

  it('counts a test that the base had skipped as already there, so un-skipping one is no news', () => {
    git(repo, 'checkout', '-q', '-b', 'unskip', 'main')
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nonce skipped :: src/a.mjs :: export :: skip\n')
    commit('unskip: a skipped test on main')
    git(repo, 'checkout', '-q', '-b', 'unskipped')
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nonce skipped :: src/a.mjs :: export\n')
    commit('unskipped: it runs now')
    const r = run({ head: 'unskipped', base: 'unskip' })
    expect(r.calls.names).toEqual([['src/a.test.mjs']])
    expect(r.findings.filter((f: { check: string }) => f.check === 'revert')).toEqual([])
    // A name the base's file did not have at all is new
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nonce skipped :: src/a.mjs :: export\nbrand new :: src/a.mjs :: export\n')
    commit('unskipped: and a new one')
    expect(run({ head: 'unskipped', base: 'unskip' }).findings.map((f: { message: string }) => f.message.split(' passes')[0])).toEqual(['src/a.test.mjs: "brand new"'])
  })

  it('refuses what it could not start for want of time, as it refuses a failure, and runs nothing then', () => {
    const r = run({ limitMs: 59_000 })
    expect(r.calls.tsc).toEqual([])
    expect(r.calls.vitest).toEqual([])
    // The first check cannot start, and the run stops there
    expect(r.findings.map((f: { check: string; message: string }) => [f.check, /: not run: out of time/.test(f.message)])).toEqual([['lint', true]])
    expect(r.ok).toBe(false)
    // An exempted check is left out, not reported as not run
    expect(run({ limitMs: 59_000, exempt: { tsc: 'x', lint: 'x', revert: 'x' } }).ok).toBe(true)
  })

  it('gives each phase what is left of the total', () => {
    const t = { now: 0 }
    const fake = fakeRunners()
    // Each tsc takes 100 s of the fake clock, out of 300 s
    const slow = { ...fake.runners, tsc: (dir: string, o?: { timeoutMs?: number }) => { t.now += 100_000; return fake.runners.tsc(dir, o) } }
    const r = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: slow, limitMs: 300_000, now: () => t.now })
    expect(r.ok).toBe(false)
    // Two tsc (300 s, then 200 s left) and the first vitest pass (100 s left)
    expect(fake.calls.timeouts).toEqual([300_000, 200_000, 100_000, 100_000])
  })

  it('gives the changed tests at least a second when an install before them used the time up: a limit of 0 or less would mean none', () => {
    git(repo, 'checkout', '-q', '-b', 'deps', 'top')
    write('package.json', '{}\n')
    commit('deps')
    const clock = { now: 0 }
    const fake = fakeRunners()
    const limits: (number | undefined)[] = []
    const prepared = new Set<string>()
    const runners = {
      ...fake.runners,
      // The revert check's install (the dependencies changed) is the second given to the head's worktree, and takes more than the whole time
      prepare: (dir: string) => {
        fake.runners.prepare(dir)
        if (prepared.has(dir)) clock.now = 400_000
        prepared.add(dir)
      },
      vitest: (dir: string, files: string[], o?: { timeoutMs?: number; namesOnly?: boolean }) => (limits.push(o?.timeoutMs), fake.runners.vitest(dir, files, o)),
    }
    prePr({ cwd: repo, head: 'deps', main: 'main', fetch: false, runners, limitMs: 300_000, now: () => clock.now })
    expect(limits[0]).toBe(1000)
  })

  it('does not judge the tests a run ended early left unrun, when no new test passed in it', () => {
    const fake = fakeRunners()
    // The stop reporter ended the run, yet no test it ran is a new pass to pre-pr: the two named the tests differently
    const vitest = (dir: string, files: string[], o?: { known?: { file: string; name: string }[]; namesOnly?: boolean }) => {
      const r = fake.runners.vitest(dir, files, o)
      if (o?.known) for (const f of r.report?.testResults ?? []) for (const t of f.assertionResults) if (t.status === 'passed') t.status = 'pending'
      return r
    }
    const r = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, vitest } })
    expect(r.findings.map((f: { message: string }) => f.message)).toEqual([expect.stringMatching(/^The changed tests \(src\/a\.test\.mjs, src\/b\.test\.mjs\): not run: the run was ended early, yet no new test passed in it/)])
  })

  it('does not judge a test when a vitest pass gave no report or a tool was stopped, and says so', () => {
    const fake = fakeRunners()
    const stopped = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, tsc: () => ({ ok: false, out: '', timedOut: true }) } })
    expect(stopped.findings.filter((f: { check: string }) => f.check === 'tsc').map((f: { message: string }) => f.message.split(': not run')[0]).length).toBe(2)
    expect(stopped.findings.filter((f: { message: string }) => /tsc fails/.test(f.message))).toEqual([])
    // The run of the changed tests: no report
    const named = (vitest: () => Pass) => ({ ...fake.runners, vitest: (dir: string, files: string[], o?: { namesOnly?: boolean }) => (o?.namesOnly ? fake.runners.vitest(dir, files, o) : vitest()) })
    const first = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: named(() => ({ report: null, timedOut: false })) })
    expect(first.findings.map((f: { check: string }) => f.check)).toEqual(['revert'])
    expect(first.findings[0].message).toMatch(/not run: vitest gave no report/)
    // ...and one that was stopped at the limit it was given says that, so the step that ran out is named. It is how the step ended
    // that tells, not the clock: a crash with the time used up reads as a crash
    const clock = { now: 0 }
    const limited = (timedOut: boolean) => named(() => ((clock.now = 300_000), { report: null, timedOut }))
    const outOfTime = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, limitMs: 300_000, now: () => clock.now, runners: limited(true) })
    expect(outOfTime.findings.map((f: { message: string }) => f.message)).toEqual([expect.stringMatching(/^The changed tests \(src\/a\.test\.mjs, src\/b\.test\.mjs\): not run: vitest was stopped after 300 s, the most it was given, before it had finished/)])
    clock.now = 0
    const crashed = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, limitMs: 300_000, now: () => clock.now, runners: limited(false) })
    expect(crashed.findings.map((f: { message: string }) => f.message)).toEqual([expect.stringMatching(/not run: vitest gave no report \(it did not start, or crashed\)/)])
    // The base's names: none, so no test is judged
    const second = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, vitest: (dir: string, files: string[], o?: { namesOnly?: boolean }) => (o?.namesOnly ? { report: null, timedOut: false } : fake.runners.vitest(dir, files, o)) } })
    expect(second.findings.map((f: { check: string; message: string }) => [f.check, /not run: vitest gave no report .*so no test was judged/.test(f.message)])).toEqual([['revert', true]])
  })

  it('reverts the e2e/ files a changed vitest test reaches through imports, as the code it checks, and keeps the e2e fixtures it does not', () => {
    git(repo, 'checkout', '-q', '-b', 'e2e', 'main')
    write('e2e/fixtures/gap.ts', "import { deep } from './deep.js'\nexport const gap = 2\n")
    write('e2e/fixtures/deep.ts', 'export const deep = 3\n')
    write('e2e/fixtures/other.ts', 'export const other = 2\n')
    write('src/gap.test.ts', "import { gap } from '../e2e/fixtures/gap.js'\nknows the gap :: e2e/fixtures/gap.ts :: gap = 2\nknows the deep :: e2e/fixtures/deep.ts :: deep = 3\nknows the other :: e2e/fixtures/other.ts :: other = 2\n")
    commit('e2e')
    expect(run({ head: 'e2e' }).findings.map((f: { message: string }) => f.message.split(' passes')[0])).toEqual(['src/gap.test.ts: "knows the other"'])
  })

  it('leaves out a changed file whose base version does not load, saying so: every test of it would count as new', () => {
    git(repo, 'checkout', '-q', '-b', 'base', 'main')
    write('src/a.test.mjs', 'does not load :: Error: Cannot find module ./helper.js\n')
    commit('base: a test of a helper this pull request renames')
    git(repo, 'checkout', '-q', '-b', 'renamed')
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nguards nothing :: src/a.mjs :: export\n')
    write('src/c.test.mjs', 'has c :: src/c.mjs :: c\n')
    write('src/c.mjs', 'export const c = 1\n')
    commit('renamed')
    const r = run({ head: 'renamed', base: 'base', main: 'base' })
    expect(r.calls.vitest).toEqual([['src/c.test.mjs']])
    expect(r.findings).toEqual([])
    expect(r.warnings.filter((w: { check: string }) => w.check === 'revert').map((w: { message: string }) => w.message)).toEqual([
      "src/a.test.mjs: its version at base does not load with this pull request's other changes reverted (Error: Cannot find module ./helper.js), so which of its tests are new is not known: they were not judged.",
    ])
    // Verified names the check as passed only for the files it judged
    expect(r.passed).toContain('no new test passes without the change, in the test files judged (1 left out: see the warnings)')
  })

  it('reports the first new test that passes with the other changes reverted, and none that fails or was there', () => {
    const r = run()
    // b.test.mjs's "has a" passes without the change too, but the run ended at the first
    expect(r.findings.filter((f: { check: string }) => f.check === 'revert').map((f: { message: string }) => f.message)).toEqual([
      'src/a.test.mjs: "still exports" passes with this pull request\'s other changes reverted to main, so it protects nothing. Make it fail without the change, or exempt the revert check with the reason it cannot.',
    ])
    // The changed files ran once, at the head's version; the base's version was only listed, to learn which tests were there
    expect(r.calls.vitest).toEqual([['src/a.test.mjs', 'src/b.test.mjs']])
    expect(r.calls.names).toEqual([['src/a.test.mjs']])
    expect(r.ok).toBe(false)
  })

  it('counts a failed test and a file that did not load as failing without the change, a skipped test as neither (#1806)', () => {
    const fake = fakeRunners()
    // The base's names load; the run, in the reverted tree, is the one below
    const vitest = (dir: string, files: string[], o?: { namesOnly?: boolean }) => o?.namesOnly ? fake.runners.vitest(dir, files, o) : ({
      timedOut: false,
      report: { testResults: files.map((file) => ({
        name: join(dir, file),
        status: file === 'src/a.test.mjs' ? 'failed' : 'passed',
        message: 'beforeAll threw',
        // The reverted tree: a.test.mjs did not load, so its tests are skipped; b.test.mjs has one failure and one skipped test
        assertionResults: file === 'src/a.test.mjs' ? [{ title: 'one', status: 'skipped' }, { title: 'two', status: 'skipped' }] : [{ title: 'x', status: 'failed', failureMessages: ['no'] }, { title: 'y', status: 'skipped' }, { title: 'z', status: 'todo' }],
      })) },
    })
    const r = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, vitest } })
    expect(r.notes).toContain('2 test(s) of 2 changed file(s) fail without the change; no new test passes without it.')
  })

  it('answers the pull request\'s risk tier by the paths it changes over its base (#1259)', () => {
    // No rules anywhere: nothing to judge by, so deep
    expect(run().tier).toMatchObject({ name: 'deep', because: [], line: expect.stringMatching(/^Tier: deep \(no \.centralu\/tiers\.json at /) })
    const rule = (id: string, tier: string, paths: string[]) => ({ id, tier, paths, why: id })
    write('.centralu/tiers.json', JSON.stringify({ tiers: ['auto', 'light', 'deep', 'person'], fallback: 'light', rules: [rule('docs', 'auto', ['docs/**']), rule('a', 'deep', ['src/a.mjs'])] }))
    commit('rules')
    // src/a.test.mjs tests src/a.mjs, so it is deep too
    expect(run().tier).toMatchObject({ name: 'deep', because: ['src/a.mjs', 'src/a.test.mjs'], line: expect.stringMatching(/^Tier: deep, from `src\/a\.mjs` \(a\)/) })
    // Over the lower pull request, the top changes no src/a.mjs
    expect(run({ base: 'lower' }).tier).toMatchObject({ name: 'light', because: ['.centralu/tiers.json', 'src/b.mjs', 'src/b.test.mjs'] })
  })

  it('answers deep, with a warning, when the rules cannot be read (#1259)', () => {
    write('.centralu/tiers.json', '{ not json')
    commit('broken rules')
    const r = run()
    expect(r.tier).toMatchObject({ name: 'deep', line: expect.stringMatching(/^Tier: deep \(the tier could not be read: \.centralu\/tiers\.json at .* is not JSON/) })
    expect(r.warnings.map((w: { check: string }) => w.check)).toContain('tier')
  })

  it('reverts only what the pull request changes over its base, in a stack', () => {
    const r = run({ base: 'lower' })
    expect(r.findings.map((f: { message: string }) => f.message.split(' passes')[0])).toEqual(['src/b.test.mjs: "has a"'])
    expect(r.calls.vitest).toEqual([['src/b.test.mjs']])
  })

  it('reverts to where the branch left its base, not to what the base has gained since', () => {
    // main makes the same fix after the branch forked: against main's tip the fix would be no change of the branch's
    git(repo, 'checkout', '-q', 'main')
    write('src/a.mjs', 'export const value = 2\n')
    commit('main fixes it too')
    git(repo, 'checkout', '-q', 'top')
    const r = run()
    expect(r.findings.filter((f: { check: string }) => f.check === 'revert').map((f: { message: string }) => f.message.split(' passes')[0])).toEqual(['src/a.test.mjs: "still exports"'])
    expect(r.warnings.some((f: { check: string }) => f.check === 'main')).toBe(true)
  })

  it('runs tsc at every head of the stack, and names the lower one that does not build alone', () => {
    git(repo, 'checkout', '-q', 'lower')
    write('BROKEN', 'x\n')
    commit('lower breaks')
    git(repo, 'checkout', '-q', 'top')
    git(repo, 'rebase', '-q', 'lower')
    git(repo, 'rm', '-q', 'BROKEN')
    commit('top repairs it')
    const r = run()
    const lower = git(repo, 'rev-parse', 'lower')
    const top = git(repo, 'rev-parse', 'top')
    expect(r.heads.map((h: { names: string[] }) => h.names[0])).toEqual(['lower', 'top'])
    expect(r.calls.tsc).toEqual([lower, top])
    // The head's worktree first: lint reads it before tsc
    expect(r.calls.prepare).toEqual([top, lower])
    const tsc = r.findings.filter((f: { check: string }) => f.check === 'tsc')
    expect(tsc).toHaveLength(1)
    expect(tsc[0].message).toContain(`tsc fails at lower (${lower.slice(0, 10)})`)
    expect(tsc[0].message).toContain('error TS2322: broken')
  })

  it('takes a head of the stack it is named, when no branch points there', () => {
    const lower = git(repo, 'rev-parse', 'lower')
    git(repo, 'update-ref', 'refs/centralu-pre-pr/lower', lower)
    git(repo, 'branch', '-q', '-D', 'lower')
    expect(run().calls.tsc).toEqual([git(repo, 'rev-parse', 'top')])
    const r = run({ stack: ['refs/centralu-pre-pr/lower'] })
    expect(r.calls.tsc).toEqual([lower, git(repo, 'rev-parse', 'top')])
    expect(r.heads[0].names).toEqual(['refs/centralu-pre-pr/lower'])
  })

  it('reports orphans as errors', () => {
    const r = run({}, ['src/lonely.mjs'])
    expect(r.findings.filter((f: { check: string }) => f.check === 'orphans').map((f: { message: string }) => f.message)).toEqual([
      'src/lonely.mjs is imported by nothing (no-orphans): delete it, import it, or list it in tooling/dependency-cruiser.cjs with why.',
    ])
  })

  it('refuses a dependency error that is not an orphan (a cycle), naming its path', () => {
    const r = run({}, undefined, { cycle: true })
    expect(r.findings.filter((f: { check: string }) => f.check === 'deps').map((f: { message: string }) => f.message)).toEqual([
      'src/a.mjs -> src/b.mjs -> src/a.mjs breaks no-circular (tooling/dependency-cruiser.cjs)',
    ])
    expect(run({ exempt: { deps: 'a cycle the next PR removes' } }, undefined, { cycle: true }).findings.some((f: { check: string }) => f.check === 'deps')).toBe(false)
  })

  it('lints the files the branch changed, none it deleted or that are not code, and refuses what lint refuses', () => {
    write('docs/c.md', 'c\n')
    rmSync(join(repo, 'src', 'a.test.mjs'))
    commit('a doc, and a test that goes')
    const ok = run()
    expect(ok.calls.lint).toEqual([['src/a.mjs', 'src/b.mjs', 'src/b.test.mjs']])
    const r = run({}, undefined, { lintFails: true })
    expect(r.findings.filter((f: { check: string }) => f.check === 'lint').map((f: { message: string }) => f.message)).toEqual([
      'pnpm lint fails on the changed files:\nsrc/b.mjs\n  1:1  error  Unsafe type assertion  @typescript-eslint/no-unsafe-type-assertion',
    ])
    const t = run({ exempt: { lint: 'lints in the next PR' } }, undefined, { lintFails: true })
    expect(t.calls.lint).toEqual([])
    expect(t.findings.some((f: { check: string }) => f.check === 'lint')).toBe(false)
  })

  it('warns, without refusing, when the head does not contain main, naming the files a merge would conflict on', () => {
    expect(run().warnings).toEqual([])
    git(repo, 'checkout', '-q', 'main')
    write('src/a.mjs', 'export const value = 3\n')
    commit('main moves on')
    git(repo, 'checkout', '-q', 'top')
    const r = run({ exempt: { revert: 'checked by hand' } })
    expect(r.warnings.map((f: { message: string }) => f.message)).toEqual(['top does not contain main: 1 commit(s) behind. The merge queue merges it in; checked without it. A merge conflicts in: src/a.mjs: rebase or merge before it lands.'])
    expect(r.findings).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('leaves out an exempted check, saying why, and runs the others', () => {
    const r = run({ exempt: { revert: 'The new test guards a Windows path this branch only documents.' } }, ['src/lonely.mjs'])
    expect(r.calls.vitest).toEqual([])
    expect(r.exempted).toEqual([{ check: 'revert', reason: 'The new test guards a Windows path this branch only documents.' }])
    expect(r.findings.map((f: { check: string }) => f.check)).toEqual(['orphans'])
    const t = run({ exempt: { tsc: 'a generated file is missing here', orphans: 'moved in the next PR' } })
    expect(t.calls.tsc).toEqual([])
    expect(t.findings.map((f: { check: string }) => f.check)).toEqual(['revert'])
    expect(() => run({ exempt: { revert: '  ' } })).toThrow('An exemption from revert needs its reason.')
    expect(() => run({ exempt: { main: 'x' } })).toThrow('No check is called main; the checks are lint, tsc, orphans, deps, repo-guards, store-step, revert, guards.')
  })

  it('knows an interrupt by how the tool it ended ended, and says that, not the failure the tool then gave', () => {
    const fake = fakeRunners()
    expect(() => prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, lint: interruptedTool } })).toThrow('interrupted')
    expect(fake.calls.tsc).toEqual([])
    // A tool that failed on its own is its check's finding, and the interrupt of an earlier run is not this one's
    const failed = () => {
      try {
        runTool(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' })
      } catch {
        // its failure, which the runner answers
      }
      return { ok: false, out: 'src/b.mjs: an error' }
    }
    expect(prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, lint: failed } }).findings.map((f: { check: string }) => f.check)).toEqual(['lint'])
  }, 60_000 * SLOW)

  it('knows an interrupt of the git the tier starts itself, not through runTool, by how it ended', () => {
    const fake = fakeRunners()
    expect(() => prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, tier: () => endedBySigint(execFileSync) } })).toThrow('interrupted')
    expect(fake.calls.lint).toEqual([])
  }, 60_000 * SLOW)

  it('stops when interrupted, and takes its worktrees and their links away without reaching through them', () => {
    const deps = mkdtempSync(join(tmpdir(), 'cc-prepr-checkout-deps-'))
    try {
      writeFileSync(join(deps, 'keep.js'), 'keep')
      let tscs = 0
      const fake = fakeRunners({ linkTo: deps })
      // The first head's tsc is interrupted
      const runners = { ...fake.runners, tsc: (dir: string) => (tscs++ === 0 ? interruptedTool() : fake.runners.tsc(dir)) }
      expect(() => prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners, runId: 'interrupted-test' })).toThrow('interrupted')
      expect(tscs).toBe(1)
      expect(existsSync(runDir('interrupted-test'))).toBe(false)
      expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
      expect(readFileSync(join(deps, 'keep.js'), 'utf8')).toBe('keep')
    } finally {
      rmSync(deps, { recursive: true, force: true })
    }
  }, 60_000 * SLOW)

  it.each<[string, number, boolean]>([
    ['exits 130, as a tool that caught SIGINT does', 130, true],
    ['exits 1', 1, false],
    ['exits 124, as run-limited.mjs does at its limit', 124, false],
    // Windows' exit status for Ctrl-C and Ctrl-Break; elsewhere a status is one byte
    ...(process.platform === 'win32' ? [["exits with Windows' status for Ctrl-C", 0xc000013a, true] as [string, number, boolean]] : []),
  ])('counts a real tool that %s as interrupted: %s', (_what, code, interrupted) => {
    const before = interruptsSoFar()
    expect(() => runTool(process.execPath, ['-e', `process.exit(${code})`], { stdio: 'ignore' })).toThrow()
    expect(interruptsSoFar() - before).toBe(interrupted ? 1 : 0)
  })

  it('does not count a tool its time limit killed as interrupted', () => {
    const before = interruptsSoFar()
    expect(() => runTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 1000, killSignal: 'SIGKILL', stdio: 'ignore' })).toThrow()
    expect(interruptsSoFar()).toBe(before)
  }, 60_000 * SLOW)

  it('cleans up after a run that was killed: by --cleanup, or by the next run once its process is gone', () => {
    const deps = mkdtempSync(join(tmpdir(), 'cc-prepr-checkout-deps-'))
    const root = git(repo, 'rev-parse', '--show-toplevel')
    const guardRefs = () => git(repo, 'for-each-ref', '--format=%(refname)', `${GUARD_REFS}/`)
    // What a killed run leaves: its folder, its owner, a registered worktree with a link into the checkout's dependencies, and
    // the head of a pull request it fetched for the guards
    const leave = (id: string, pid: number) => {
      const dir = runDir(id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid, root }))
      git(repo, 'worktree', 'add', '--detach', '-q', join(dir, 'wt-1'), 'top')
      symlinkSync(deps, join(dir, 'wt-1', 'src', 'node_modules'), 'junction')
      git(repo, 'update-ref', `${GUARD_REFS}/${id}/21`, 'top')
      return dir
    }
    try {
      writeFileSync(join(deps, 'keep.js'), 'keep')
      const killed = leave(`killed-${process.pid}`, 999_999)
      const dead = leave(`dead-${process.pid}`, 999_998)
      const living = leave(`living-${process.pid}`, process.pid)
      // A run's refs whose folder is gone: --cleanup of any run takes them too, and leaves those of a run with a folder
      git(repo, 'update-ref', `${GUARD_REFS}/gone-${process.pid}/22`, 'top')
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/pre-pr.mjs', import.meta.url)), '--cleanup', `killed-${process.pid}`], { cwd: repo, env: GIT_ENV })
      expect(existsSync(killed)).toBe(false)
      expect(guardRefs()).toBe([`${GUARD_REFS}/dead-${process.pid}/21`, `${GUARD_REFS}/living-${process.pid}/21`].join('\n'))
      // The checkout's own, the dead run's and the living one's
      expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(3)
      expect(readFileSync(join(deps, 'keep.js'), 'utf8')).toBe('keep')

      const swept = sweepStale(root, { isAlive: (pid: number) => pid === process.pid })
      expect(swept).toEqual([dead])
      expect(existsSync(living)).toBe(true)
      expect(guardRefs()).toBe(`${GUARD_REFS}/living-${process.pid}/21`)
      expect(readFileSync(join(deps, 'keep.js'), 'utf8')).toBe('keep')
      expect(removeRun(living, root)).toEqual([])
      expect(guardRefs()).toBe('')
      expect(readdirSync(deps)).toEqual(['keep.js'])
    } finally {
      rmSync(deps, { recursive: true, force: true })
    }
  })

  it('leaves the checkout as it was, and no worktree, run folder or link target touched', () => {
    const deps = mkdtempSync(join(tmpdir(), 'cc-prepr-checkout-deps-'))
    writeFileSync(join(deps, 'keep.js'), 'keep')
    write('uncommitted.txt', 'mine\n')
    const before = git(repo, 'status', '--porcelain')
    const fake = fakeRunners({ linkTo: deps })
    prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: fake.runners, runId: 'clean-test' })
    expect(existsSync(runDir('clean-test'))).toBe(false)
    expect(readFileSync(join(deps, 'keep.js'), 'utf8')).toBe('keep')
    rmSync(deps, { recursive: true, force: true })
    expect(git(repo, 'status', '--porcelain')).toBe(before)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('top')
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  it('passes a stack whose new tests all fail without their change', () => {
    git(repo, 'checkout', '-q', 'lower')
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nknows two :: src/a.mjs :: value = 2\n')
    commit('lower: only the guarding test')
    git(repo, 'checkout', '-q', 'top')
    git(repo, 'rebase', '-q', 'lower')
    write('src/b.test.mjs', 'has b :: src/b.mjs :: b = 1\n')
    commit('top: only the guarding test')
    const r = run()
    expect(r.findings).toEqual([])
    expect(r.ok).toBe(true)
  })
})

/**
 * A store step number is claimed by the first pull request to land; two branches picking the same number each
 * pass CI alone (#1203). The open pull requests are read through `gh`, here a fake that answers from a table.
 */
describe('pre-pr and store step numbers', () => {
  const step = (n: number) => `      {
        to: ${n},
        run: () => {},
      },
`
  const file = (...ns: number[]) => `export class Steps {
  steps() {
    return [
${ns.map(step).join('')}    ]
  }
}
`
  const diffAdding = (path: string, n: number) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,3 +1,7 @@
+      {
+        to: ${n},
+        run: () => {},
+      },
`
  let repo = ''
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const commit = (message: string) => {
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
  }
  type Pr = { number: number; title: string; headRefName: string; headRefOid: string; files: Record<string, string> }
  /** `gh pr list`, `gh pr diff --name-only` and `gh pr diff`, answered from these pull requests */
  const fakeGh = (prs: Pr[], calls: string[][] = []) => (args: string[]) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs.map(({ files: _f, ...pr }) => pr))
    const pr = prs.find((p) => String(p.number) === args[2])!
    if (args.includes('--name-only')) return Object.keys(pr.files).join('\n') + '\n'
    return Object.entries(pr.files).map(([path, n]) => (path.endsWith('.ts') ? diffAdding(path, Number(n)) : '')).join('')
  }
  const run = (over: Record<string, unknown> = {}, gh?: (args: string[]) => string) => {
    const fake = fakeRunners()
    return prePr({ cwd: repo, head: 'feat', main: 'main', fetch: false, runners: { ...fake.runners, gh }, ...over })
  }
  const stepFiles = (r: { findings: { check: string; message: string }[] }) => r.findings.filter((f) => f.check === 'store-step').map((f) => f.message)

  // The repository every test starts from, built once and copied: the init and the commits per test were most of the setup
  let template = ''
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-prepr-step-template-'))
    git(repo, 'init', '-q', '-b', 'main')
    write(`${STEP_DIR}v55.ts`, file(55, 56, 57))
    write(`${STEP_DIR}index.ts`, 'export const note = "a step is { to: 3, }"\n')
    commit('main')
    git(repo, 'checkout', '-q', '-b', 'feat')
    write(`${STEP_DIR}v58.ts`, file(58))
    commit('feat: step 58')
    template = repo
  })

  afterAll(() => {
    rmSync(template, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-prepr-step-'))
    cpSync(template, repo, { recursive: true })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('reads the numbers of a file, and the ones a diff adds and does not take away', () => {
    expect(stepNumbers(file(3, 4))).toEqual([3, 4])
    expect(stepNumbers('const to: number = 3\n')).toEqual([])
    const path = `${STEP_DIR}v60.ts`
    expect(stepsAddedByDiff(diffAdding(path, 60) + diffAdding('docs/x.ts', 61))).toEqual([60])
    // A step moved to another file is no new number
    expect(stepsAddedByDiff(diffAdding(path, 60) + `diff --git a/${STEP_DIR}old.ts b/${STEP_DIR}old.ts
-        to: 60,
`)).toEqual([])
  })

  it('passes a step number nothing else uses, and asks the open pull requests only for one it adds', () => {
    const calls: string[][] = []
    const unrelated = { number: 9, title: 'docs', headRefName: 'docs', headRefOid: 'a'.repeat(40), files: { 'README.md': '' } }
    const r = run({}, fakeGh([unrelated], calls))
    expect(stepFiles(r)).toEqual([])
    expect(r.ok).toBe(true)
    // The list, and the file names of the one pull request: no full diff of a pull request that touches no step
    expect(calls).toEqual([['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,headRefName,headRefOid,isDraft,changedFiles,files'], ['pr', 'diff', '9', '--name-only']])
    // A list that holds all of a pull request's files answers them without a diff
    calls.length = 0
    const listed = { ...unrelated, changedFiles: 1, files: [{ path: 'README.md' }] }
    expect(run({}, (args) => (calls.push(args), args[1] === 'list' ? JSON.stringify([listed]) : '')).ok).toBe(true)
    expect(calls.map((a) => a[1])).toEqual(['list'])
    // A branch that adds no step never calls gh
    git(repo, 'checkout', '-q', '-b', 'plain', 'main')
    write('docs/a.md', 'a\n')
    commit('plain')
    expect(run({ head: 'plain' }, () => { throw new Error('gh was called') }).ok).toBe(true)
  })

  it('refuses a step number main already has', () => {
    write(`${STEP_DIR}v57b.ts`, file(57))
    commit('feat: step 57 again')
    const r = run({}, fakeGh([]))
    expect(stepFiles(r)).toHaveLength(1)
    expect(stepFiles(r)[0]).toContain('Store step 57 is already on main (v55.ts). The Assistant assigns')
    expect(r.ok).toBe(false)
  })

  it('refuses a step number another open pull request adds, naming it, but not the stack own', () => {
    const feat = git(repo, 'rev-parse', 'HEAD')
    const other = { number: 12, title: 'feat(store): index the thing', headRefName: 'other', headRefOid: 'b'.repeat(40), files: { [`${STEP_DIR}v58.ts`]: '58' } }
    const elsewhere = { number: 13, title: 'feat(store): another', headRefName: 'else', headRefOid: 'c'.repeat(40), files: { [`${STEP_DIR}v59.ts`]: '59' } }
    // This branch's own pull request, open already: found by its commit, and by its branch
    const own = { number: 14, title: 'feat: step 58', headRefName: 'feat', headRefOid: feat, files: { [`${STEP_DIR}v58.ts`]: '58' } }
    const lower = { number: 15, title: 'lower', headRefName: 'old-name', headRefOid: feat, files: { [`${STEP_DIR}v58.ts`]: '58' } }
    const r = run({}, fakeGh([other, elsewhere, own, lower]))
    expect(stepFiles(r)).toHaveLength(1)
    expect(stepFiles(r)[0]).toContain('Store step 58 is also added by open pull request #12 "feat(store): index the thing" (other): whichever lands second conflicts.')
    expect(r.ok).toBe(false)
  })

  it('leaves the check out when exempted, saying why, without asking gh', () => {
    write(`${STEP_DIR}v57b.ts`, file(57))
    commit('feat: step 57 again')
    const r = run({ exempt: { 'store-step': 'the 57 of main is being renumbered in #1' } }, () => { throw new Error('gh was called') })
    expect(stepFiles(r)).toEqual([])
    expect(r.exempted).toEqual([{ check: 'store-step', reason: 'the 57 of main is being renumbered in #1' }])
    expect(r.ok).toBe(true)
  })

  it('says it could not read the open pull requests, rather than passing', () => {
    expect(() => run({}, () => { throw new Error('gh pr list failed: not logged in') })).toThrow('open pull requests could not be read (gh pr list failed: not logged in). Run it where gh is logged in, or exempt store-step with the reason.')
  })
})

/**
 * A repository-wide guard a branch adds is run against the open pull requests with the branch merged in, and
 * the ones it would fail are listed, as warnings: never a refusal. The pull requests' heads are served by a
 * real bare repository under refs/pull/N/head, as GitHub does; `gh` and vitest are fakes. The fake guard
 * `tooling/guard.test.ts` says `no <word> in <folder>` and fails when a file of the folder holds the word.
 */
describe('pre-pr and the guards a branch adds', () => {
  let repo = ''
  let bare = ''
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const commit = (message: string) => {
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
  }
  /** src/notes.txt with its first and last lines as given: the branch changes the first, a pull request the last, and they merge */
  const notes = (first: string, last: string) => `${[first, ...Array.from({ length: 8 }, (_, i) => `line ${i + 2}`), last].join('\n')}\n`
  /**
   * A pull request: a branch off main, served as refs/pull/N/head, listed with its files. It changes src/notes.txt, as the branch
   * does, unless `apart`
   */
  const openPr = (number: number, files: Record<string, string>, over: Record<string, unknown> = {}, apart = false) => {
    git(repo, 'checkout', '-q', '-b', `pr${number}`, 'main')
    for (const [path, text] of Object.entries(files)) write(path, text)
    if (!apart) write('src/notes.txt', notes('line 1', `pr ${number}`))
    commit(`pr ${number}`)
    git(repo, 'push', '-q', 'origin', `pr${number}:refs/pull/${number}/head`)
    const paths = git(repo, 'diff', '--name-only', 'main', 'HEAD').split('\n')
    const pr = { number, title: `pull request ${number}`, headRefName: `pr${number}`, headRefOid: git(repo, 'rev-parse', 'HEAD'), isDraft: false, changedFiles: paths.length, files: paths.map((path) => ({ path })), ...over }
    git(repo, 'checkout', '-q', 'feat')
    return pr
  }
  const GUARD = 'no banned in src :: src :: banned\n'
  const clock = { t: 0 }
  let step = 1000
  // How long a test file takes where it is not `step`
  const fileMs: Record<string, number> = {}
  const vitestCalls: string[][] = []
  const vitestPatterns: (string | undefined)[] = []
  const runners = (prs: unknown[], extra: Record<string, unknown> = {}) => {
    const fake = fakeRunners()
    return {
      ...fake.runners,
      gh: () => JSON.stringify(prs),
      // `needs-install` in a worktree: its dependencies would need an install, which a guard run does not do
      prepare: (dir: string, _root: string, options?: { linkOnly?: boolean }) => (options?.linkOnly && existsSync(join(dir, 'needs-install')) ? false : undefined),
      vitest: (dir: string, files: string[], options?: { testNamePattern?: string }) => {
        vitestCalls.push(files)
        vitestPatterns.push(options?.testNamePattern)
        // The files run side by side: the pass ends with the slowest
        const startTime = clock.t
        clock.t += Math.max(...files.map((f) => fileMs[f] ?? step))
        return {
          timedOut: false,
          report: {
          testResults: files.map((file) => ({
            name: join(dir, file),
            status: 'passed',
            startTime,
            endTime: startTime + (fileMs[file] ?? step),
            assertionResults: readFileSync(join(dir, file), 'utf8')
              .split('\n')
              .filter((l) => l.includes(' :: '))
              .map((l) => {
                const [title, folder, word] = l.split(' :: ').map((s) => s.trim()) as [string, string, string]
                const hit = readdirSync(join(dir, folder)).find((f) => readFileSync(join(dir, folder, f), 'utf8').includes(word))
                return { ancestorTitles: [], title, status: hit ? 'failed' : 'passed', failureMessages: hit ? [`AssertionError: ${folder}/${hit} holds "${word}"\n    at somewhere`] : [] }
              }),
          })),
          },
        }
      },
      ...extra,
    }
  }
  // The guards at the head are not what is under test here: their runs would take the clock's time
  const AT_HEAD = { 'repo-guards': 'the guards at the head are tested above' }
  const run = (rs: ReturnType<typeof runners>, over: Record<string, unknown> = {}) =>
    prePr({ cwd: repo, head: 'feat', main: 'main', remote: 'origin', fetch: false, runners: rs, now: () => clock.t, ...over, exempt: { revert: 'the fake guard is not what is under test', ...AT_HEAD, ...(over.exempt as object) } })
  const guardsOf = (r: { warnings: { check: string; message: string }[] }) => r.warnings.filter((w) => w.check === 'guards').map((w) => w.message)
  const noGh = () => {
    throw new Error('gh was called')
  }

  // The repository and its origin every test starts from, built once and copied (the init, the commit and the origin per test were most of the setup)
  let template = ''
  let templateBare = ''
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-prepr-guard-template-'))
    templateBare = mkdtempSync(join(tmpdir(), 'cc-prepr-bare-template-'))
    git(templateBare, 'init', '-q', '--bare')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', templateBare)
    write('src/a.txt', 'fine\n')
    write('src/notes.txt', notes('line 1', 'line 10'))
    commit('main')
    git(repo, 'checkout', '-q', '-b', 'feat')
    template = repo
  })

  afterAll(() => {
    rmSync(template, { recursive: true, force: true })
    rmSync(templateBare, { recursive: true, force: true })
  })

  beforeEach(() => {
    clock.t = 0
    step = 1000
    for (const f of Object.keys(fileMs)) delete fileMs[f]
    vitestCalls.length = 0
    vitestPatterns.length = 0
    // Each test copies the template's repository and its own origin: no test writes to another's
    repo = mkdtempSync(join(tmpdir(), 'cc-prepr-guard-'))
    bare = mkdtempSync(join(tmpdir(), 'cc-prepr-bare-'))
    cpSync(template, repo, { recursive: true })
    cpSync(templateBare, bare, { recursive: true })
    git(repo, 'remote', 'set-url', 'origin', bare)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  const addGuard = () => {
    write('tooling/guard.test.ts', GUARD)
    write('tooling/guards.ts', `${JSON.stringify([{ test: 'tooling/guard.test.ts' }])}\n`)
    write('src/notes.txt', notes('feat', 'line 10'))
    commit('feat: a guard')
  }
  /**
   * The guard with the fix it comes with: main has a banned word and the branch removes it, so the guard fails without the
   * branch, the revert check finds nothing, and the run goes on to the guards
   */
  const addGuardWithFix = () => {
    git(repo, 'checkout', '-q', 'main')
    write('src/old.txt', 'banned once\n')
    commit('main: a banned word')
    git(repo, 'checkout', '-q', 'feat')
    git(repo, 'reset', '-q', '--hard', 'main')
    rmSync(join(repo, 'src', 'old.txt'))
    addGuard()
  }

  it("reads the guards tooling/guards.ts declares, and the ones a range of commits changes, with the checkout's own tsx", () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const declared = GUARDS.map(({ test, tests }) => (tests ? { test, tests } : { test }))
    // From the empty tree every file is new, each guard's test with it
    expect(realRunners.guards(root, EMPTY_TREE, 'HEAD')).toEqual({ guards: declared, changed: GUARDS.map((g) => g.test) })
    expect(realRunners.guards(root, 'HEAD', 'HEAD')).toEqual({ guards: declared, changed: [] })
  }, 60_000 * SLOW)

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
    expect(guardWarnings({ failing: [], skipped: [], unchecked: [] }, ['a.test.ts'])).toEqual([])
  })

  it('lists the open pull requests the guard would fail, with the first failure line, and does not refuse', () => {
    addGuard()
    const bad = openPr(21, { 'src/bad.txt': 'a banned word\n' })
    const clean = openPr(22, { 'src/ok.txt': 'fine\n' })
    const draft = openPr(23, { 'src/bad.txt': 'a banned word\n' }, { isDraft: true })
    const own = { number: 25, title: 'this branch', headRefName: 'feat-renamed', headRefOid: git(repo, 'rev-parse', 'feat'), isDraft: false }
    const r = run(runners([bad, clean, draft, own]))
    expect(guardsOf(r)).toEqual(['#21 "pull request 21" (pr21) would fail tooling/guard.test.ts > no banned in src with this branch merged in: AssertionError: src/bad.txt holds "banned". Fix it in this change, or tell its author.'])
    // The guard ran against 21 and 22 only: not the draft, not this branch's own
    expect(vitestCalls).toEqual([['tooling/guard.test.ts'], ['tooling/guard.test.ts']])
    expect(r.notes).toContain('tooling/guard.test.ts run against 2 open pull request(s): 1 would fail, 0 skipped, 0 not reached.')
    expect(r.findings).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("holds a pull request only to each guard's own tests, as the head is held, and names them to vitest when every guard does", () => {
    const declare = (guards: object[], message: string) => {
      write('tooling/guards.ts', `${JSON.stringify(guards)}\n`)
      commit(message)
    }
    write('tooling/guard.test.ts', `${GUARD}no other in src :: src :: other\n`)
    write('tooling/plain.test.ts', 'no worse in src :: src :: worse\n')
    write('src/notes.txt', notes('feat', 'line 10'))
    declare([{ test: 'tooling/guard.test.ts', tests: 'banned' }], 'feat: a guard of one test')
    const pr = openPr(21, { 'src/bad.txt': 'banned and other\n' })
    const only = ['#21 "pull request 21" (pr21) would fail tooling/guard.test.ts > no banned in src with this branch merged in: AssertionError: src/bad.txt holds "banned". Fix it in this change, or tell its author.']
    expect(guardsOf(run(runners([pr])))).toEqual(only)
    expect(vitestPatterns).toEqual(['banned'])
    // With a guard of a whole file in the run, vitest runs every test of both: the other one's failure is not the guard's
    declare([{ test: 'tooling/guard.test.ts', tests: 'banned' }, { test: 'tooling/plain.test.ts' }], 'feat: a guard of a whole file')
    vitestPatterns.length = 0
    expect(guardsOf(run(runners([pr])))).toEqual(only)
    expect(vitestPatterns).toEqual([undefined])
  })

  it('runs the guard against a pull request that shares no file with the branch: the one it breaks need not', () => {
    addGuard()
    const apart = openPr(22, { 'src/bad2.txt': 'a banned word\n' }, {}, true)
    const r = run(runners([apart]))
    expect(vitestCalls).toEqual([['tooling/guard.test.ts']])
    expect(guardsOf(r)).toEqual([expect.stringMatching(/^#22 "pull request 22" \(pr22\) would fail/)])
  })

  it('runs nothing against the open pull requests when the branch changes no guard, and says so', () => {
    write('src/a.txt', 'mine\n')
    commit('feat: no guard')
    const r = run(runners([openPr(21, { 'src/bad.txt': 'a banned word\n' })], { gh: noGh }))
    expect(vitestCalls).toEqual([])
    expect(r.notes).toContain('No guard of tooling/guards.ts (its test, or a file it reads) is changed: not run against the open pull requests.')
  })

  it('runs a guard whose read file the branch changes, as if the branch changed the test', () => {
    write('tooling/os-layer.test.ts', GUARD)
    write('tooling/os-allowlist.txt', 'a\n')
    write('tooling/guards.ts', `${JSON.stringify([{ test: 'tooling/os-layer.test.ts', reads: ['tooling/os-allowlist.txt'] }])}\n`)
    commit('feat: the os guard')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'merge', '-q', '--ff-only', 'feat')
    git(repo, 'checkout', '-q', 'feat')
    write('tooling/os-allowlist.txt', 'a\nb\n')
    commit('feat: allow one more')
    run(runners([openPr(21, { 'src/p21.txt': 'fine\n' })]))
    expect(vitestCalls).toEqual([['tooling/os-layer.test.ts']])
  })

  it('skips a pull request that does not merge cleanly, or needs other dependencies, and says so', () => {
    addGuard()
    const conflicting = openPr(24, { 'tooling/guard.test.ts': 'no other in src :: src :: other\n' })
    const install = openPr(26, { 'needs-install': 'x\n' })
    const r = run(runners([conflicting, install]))
    expect(vitestCalls).toEqual([])
    expect(guardsOf(r)).toEqual([
      'tooling/guard.test.ts was not run against: #24 (does not merge cleanly with this branch (tooling/guard.test.ts)); #26 (its lockfile with this branch merged in is not the one this checkout last installed (node_modules/.pnpm/lock.yaml), and a guard run installs nothing; a pnpm install here may change that).',
    ])
    expect(r.ok).toBe(true)
  })

  it('does not start the guards with less time than they need', () => {
    addGuard()
    const r = run(runners([openPr(21, { 'src/p21.txt': 'fine\n' })]), { limitMs: 59_000, only: ['guards'] })
    expect(vitestCalls).toEqual([])
    expect(guardsOf(r)).toEqual(['tooling/guard.test.ts: not run: out of time (59 s of the 59 s left).'])
  })

  it('stops at its time limit and names the pull requests it did not reach', () => {
    addGuard()
    const prs = [21, 22, 26].map((n) => openPr(n, { [`src/p${n}.txt`]: 'fine\n' }))
    // Each guard run takes 1000 ms of the fake clock
    const r = run(runners(prs), { guardsLimitMs: 1500 })
    expect(vitestCalls).toHaveLength(2)
    expect(guardsOf(r)).toEqual(['tooling/guard.test.ts was not run against: #26 (time limit reached).'])
    expect(r.notes).toContain('tooling/guard.test.ts run against 3 open pull request(s): 0 would fail, 0 skipped, 1 not reached.')
  })

  it('tries the merge before the time, so a pull request that does not merge is not blamed on the clock', () => {
    addGuard()
    write('src/a.txt', 'mine\n')
    commit('feat: changes a file')
    const prs = [openPr(21, { 'src/p21.txt': 'fine\n' }), openPr(22, { 'src/a.txt': 'theirs\n' }), openPr(26, { 'src/p26.txt': 'fine\n' })]
    // #21 uses the guards' second; #22 would come after it, with no time left, and conflicts: it says so, where #26, that merges, says the time ran out
    const r = run(runners(prs), { guardsLimitMs: 1000 })
    expect(guardsOf(r)).toEqual(['tooling/guard.test.ts was not run against: #22 (does not merge cleanly with this branch (src/a.txt)); #26 (time limit reached).'])
  })

  it('caps the guards by what is left of the whole run, not only by their own limit', () => {
    addGuard()
    step = 31_000
    const prs = [21, 22, 26].map((n) => openPr(n, { [`src/p${n}.txt`]: 'fine\n' }))
    // 61.5 s in all: two runs of 31 s use it up, though the guards' own limit is ten minutes
    const r = run(runners(prs), { limitMs: 61_500 })
    expect(vitestCalls).toHaveLength(2)
    expect(guardsOf(r)).toEqual(['tooling/guard.test.ts was not run against: #26 (time limit reached).'])
  })

  // #1816: one run of project-board-queue.test.ts takes more than the five minutes a pull request was given, so the guards spent
  // their ten minutes cutting two runs off half way and learned nothing. The guards took as long in the revert check's run as one
  // run of them needs at the least: a pull request is started with that much time left or not at all, and given more than five minutes when it took more.
  const withRevert = (rs: ReturnType<typeof runners>, over: Record<string, unknown> = {}) =>
    prePr({ cwd: repo, head: 'feat', main: 'main', remote: 'origin', fetch: false, runners: rs, now: () => clock.t, exempt: AT_HEAD, ...over })

  it('starts a pull request only with as much time left as one run of the guards took, and says what was left', () => {
    addGuardWithFix()
    step = 30_000
    const prs = [21, 22, 26].map((n) => openPr(n, { [`src/p${n}.txt`]: 'fine\n' }))
    // 100 s in all: the revert check's run takes 30 s, and the guards have 70 s left. #21 runs (40 s left), #22 runs (10 s left), and #26 would be cut off
    const r = withRevert(runners(prs), { limitMs: 100_000 })
    expect(vitestCalls).toHaveLength(3)
    expect(guardsOf(r)).toEqual(['tooling/guard.test.ts was not run against: #26 (not started: a run takes about 30 s and 10 s were left).'])
  })

  it('sizes the guard runs by the guards, not by the slowest test the pull request changed', () => {
    addGuardWithFix()
    write('src/slow.test.mjs', 'slow :: src :: once\n')
    commit('feat: a slow test')
    step = 30_000
    fileMs['src/slow.test.mjs'] = 300_000
    const prs = [21, 22, 26].map((n) => openPr(n, { [`src/p${n}.txt`]: 'fine\n' }))
    // 370 s in all: the revert check's run takes 300 s, because of the slow test, and the guard file in it 30 s. The 70 s left hold
    // two runs of the guard (sized by the slow test, none would start; without the gate, all three would)
    const r = withRevert(runners(prs), { limitMs: 370_000 })
    expect(vitestCalls.filter((f) => f.length === 1 && f[0] === 'tooling/guard.test.ts')).toHaveLength(2)
    expect(guardsOf(r)).toEqual(['tooling/guard.test.ts was not run against: #26 (not started: a run takes about 30 s and 10 s were left).'])
  })

  it('gives a guard run more than five minutes when the changed tests took longer, and says when it was cut off', () => {
    addGuardWithFix()
    const prs = [openPr(21, { 'src/p21.txt': 'fine\n' })]
    const given: (number | undefined)[] = []
    // The revert check's run takes 400 s; the guards' run is stopped at the limit it is given
    const cutOff = (clockStep: number) => {
      let calls = 0
      return runners(prs, {
        vitest: (dir: string, files: string[], o?: { timeoutMs?: number }) => {
          if (calls++ === 0) {
            clock.t += clockStep
            return { timedOut: false, report: { testResults: files.map((file) => ({ name: join(dir, file), status: 'passed', startTime: 0, endTime: clockStep, assertionResults: [{ ancestorTitles: [], title: 'no banned in src', status: 'failed', failureMessages: ['src/old.txt holds "banned"'] }] })) } }
          }
          given.push(o?.timeoutMs)
          clock.t += o?.timeoutMs ?? 0
          return { report: null, timedOut: true }
        },
      })
    }
    const slow = withRevert(cutOff(400_000))
    expect(given).toEqual([600_000])
    expect(guardsOf(slow)).toEqual(['tooling/guard.test.ts was not run against: #21 (vitest was stopped after 600 s, the most it was given, before it had finished).'])
    // Quick tests keep the five minutes a pull request always had
    clock.t = 0
    given.length = 0
    const quick = withRevert(cutOff(1_000))
    expect(given).toEqual([300_000])
    expect(guardsOf(quick)[0]).toContain('vitest was stopped after 300 s')
  })

  it('asks nothing of GitHub when the branch changes no guard or the check is exempted, and leaves no ref behind', () => {
    write('src/x.txt', 'fine\n')
    commit('feat: not a guard')
    expect(run(runners([], { gh: noGh })).ok).toBe(true)
    addGuard()
    const r = run(runners([], { gh: noGh }), { exempt: { guards: 'a guard that only reads docs' } })
    expect(r.exempted.map((x: { check: string }) => x.check).sort()).toEqual(['guards', 'repo-guards', 'revert'])
    // gh unreadable: a warning, not a failure of the run
    const unreadable = run(
      runners([], {
        gh: () => {
          throw new Error('gh pr list failed: not logged in')
        },
      }),
    )
    expect(guardsOf(unreadable)).toEqual(['tooling/guard.test.ts could not be run against the open pull requests: they could not be read (gh pr list failed: not logged in).'])
    expect(unreadable.ok).toBe(true)
    const bad = openPr(21, { 'src/bad.txt': 'a banned word\n' })
    run(runners([bad]))
    expect(git(repo, 'for-each-ref', 'refs/centralu-pre-pr-guards')).toBe('')
  })
})

describe('a tool that runs out of time is stopped with everything it started (#1816)', () => {
  it('ends the grandchild a timed-out entry point left behind, and says it ran out of time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-prepr-limit-'))
    mkdirSync(join(dir, 'node_modules'))
    const pidFile = join(dir, 'pid')
    // The entry point starts a worker (as vitest does) and both then wait; the worker writes its pid
    writeFileSync(join(dir, 'node_modules', 'worker.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    writeFileSync(join(dir, 'node_modules', 'main.js'), `require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'worker.js')], { stdio: 'ignore' }); setInterval(() => {}, 1000)`)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      const r = nodeBin(dir, 'main.js', [], {}, 3000)
      expect(r.timedOut).toBe(true)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      // Gone, or about to be: the kill is asked for before the answer, the system finishes it
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r2) => setTimeout(r2, 100))
      expect(alive(pid)).toBe(false)
      // A tool that ends on its own is not timed out, and its failure is its own
      writeFileSync(join(dir, 'node_modules', 'bad.js'), 'process.exit(3)')
      expect(nodeBin(dir, 'bad.js', [], {}, 60_000)).toMatchObject({ ok: false, timedOut: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('is ended with its tool when the group it runs in is killed (the board cancelling pre-pr)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-prepr-group-'))
    const pidFile = join(dir, 'pid')
    writeFileSync(join(dir, 'worker.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    writeFileSync(join(dir, 'main.js'), `require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'worker.js')], { stdio: 'ignore' }); setInterval(() => {}, 1000)`)
    const { spawn } = await import('node:child_process')
    // Its own process group, as pre-pr's is when the board starts it
    const lead = spawn(process.execPath, [fileURLToPath(new URL('../scripts/run-limited.mjs', import.meta.url)), '600000', process.execPath, join(dir, 'main.js')], { detached: true, stdio: 'ignore' })
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100))
      const pid = Number(readFileSync(pidFile, 'utf8'))
      process.kill(-lead.pid!, 'SIGKILL')
      const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
      for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100))
      expect(alive()).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
