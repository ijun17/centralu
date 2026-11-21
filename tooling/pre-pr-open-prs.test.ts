import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { prePr, realRunners } from '../scripts/pre-pr.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { guardWarnings } from '../scripts/pre-pr-open-prs.mjs'
import { fakeRunners, git, tempDir, yieldBetweenTests } from './pre-pr.test-helpers.js'
import { GUARDS } from './guards.js'

yieldBetweenTests()

/** Git's empty tree: a diff from it holds every file */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

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
    repo = tempDir('cc-prepr-guard-template-')
    templateBare = tempDir('cc-prepr-bare-template-')
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
    repo = tempDir('cc-prepr-guard-')
    bare = tempDir('cc-prepr-bare-')
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
    write('tooling/guards.ts', `${JSON.stringify([{ test: 'tooling/guard.test.ts', tests: 'banned' }])}\n`)
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
    // None failing and none left: no warning
    expect(guardWarnings({ failing: [], skipped: [], unchecked: [] }, ['a.test.ts'])).toEqual([])
  })

  it("holds a pull request only to each guard's own tests, as the head is held, and names them all to vitest", () => {
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
    // Two guards' patterns in one run: a test one names in its own file only, so the other file's "other" is no guard of it
    declare([{ test: 'tooling/guard.test.ts', tests: 'banned' }, { test: 'tooling/plain.test.ts', tests: 'worse|other' }], 'feat: a second guard')
    vitestPatterns.length = 0
    expect(guardsOf(run(runners([pr])))).toEqual(only)
    expect(vitestPatterns).toEqual(['banned|worse|other'])
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
    write('tooling/guards.ts', `${JSON.stringify([{ test: 'tooling/os-layer.test.ts', tests: 'banned', reads: ['tooling/os-allowlist.txt'] }])}\n`)
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
