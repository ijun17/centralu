import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { isTestFile, isVitestFile, nodeBin, parseArgs, prePr, stackHeads } from '../scripts/pre-pr.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { GUARD_REFS, removeRun, runDir, sweepStale } from '../scripts/pre-pr-worktrees.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { interruptsSoFar, runTool } from '../scripts/interrupts.mjs'
import { fakeRunners, git, GIT_ENV, gitIn, type Pass, recordedReport, tempDir, yieldBetweenTests } from './pre-pr.test-helpers.js'

/**
 * `pnpm pre-pr` (#1181): the checks run on real git repositories made here, with the tools replaced by fakes
 * (tooling/pre-pr.test-helpers.ts). What it reads in the tools' answers, the store step numbers and the guards against the open
 * pull requests are tested in files of their own (tooling/pre-pr-*.test.ts).
 */

yieldBetweenTests()

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
    const dir = tempDir('cc-prepr-maintenance-')
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
const DECLARED = `${JSON.stringify([{ test: 'tooling/doc-refs.test.ts', tests: 'holds|finds no reference' }, { test: 'tooling/os-layer.test.ts', tests: 'the allowlist' }])}\n`

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
    repo = tempDir('cc-prepr-test-template-')
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
    repo = tempDir('cc-prepr-test-')
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
      { files: ['tooling/doc-refs.test.ts'], o: expect.objectContaining({ testNamePattern: 'holds|finds no reference', env: { CC_LINT_BASE: main } }) },
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
    const deps = tempDir('cc-prepr-checkout-deps-')
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
    const deps = tempDir('cc-prepr-checkout-deps-')
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
      // Refs whose run folder is gone: --cleanup of any run takes those of a run, the board's too, whose process is gone. It keeps
      // those of a living process (its folder may be under another TMPDIR), of an id with no pid, and of a run with a folder
      const orphans = { dead: ['999997-1', 'board-999996-3'], kept: [`${process.pid}-1`, `gone-${process.pid}`] }
      for (const id of [...orphans.dead, ...orphans.kept]) git(repo, 'update-ref', `${GUARD_REFS}/${id}/22`, 'top')
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/pre-pr.mjs', import.meta.url)), '--cleanup', `killed-${process.pid}`], { cwd: repo, env: GIT_ENV })
      expect(existsSync(killed)).toBe(false)
      const keptRefs = orphans.kept.map((id) => `${GUARD_REFS}/${id}/22`)
      expect(guardRefs().split('\n').sort()).toEqual([`${GUARD_REFS}/dead-${process.pid}/21`, `${GUARD_REFS}/living-${process.pid}/21`, ...keptRefs].sort())
      for (const ref of keptRefs) git(repo, 'update-ref', '-d', ref)
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
    const deps = tempDir('cc-prepr-checkout-deps-')
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

describe('a tool that runs out of time is stopped with everything it started (#1816)', () => {
  it('ends the grandchild a timed-out entry point left behind, and says it ran out of time', async () => {
    const dir = tempDir('cc-prepr-limit-')
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
    const dir = tempDir('cc-prepr-group-')
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
