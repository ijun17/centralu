import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
import { NO_GIT_MAINTENANCE } from './git-fixture.test-helpers.js'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { failuresOf, guardFiles, guardWarnings, isGuardTest, isTestFile, filesRunMs, isVitestFile, mirrorModules, nodeBin, nodeModulesDirs, depErrorsOf, orphansOf, parseArgs, passingNewTests, prePr, realRunners, removeRun, runDir, stackHeads, STEP_DIR, stepNumbers, stepsAddedByDiff, sweepStale, unlinkLinks, vitestTests } from '../scripts/pre-pr.mjs'

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
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C', ...NO_GIT_MAINTENANCE }
const gitIn = (env: NodeJS.ProcessEnv, cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env }).trim()
const git = (cwd: string, ...args: string[]) => gitIn(GIT_ENV, cwd, args)

type Report = { testResults: { name: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[] }
type Pass = { report: Report | null; timedOut: boolean }

/**
 * `linkTo`: each worktree gets a real link (a junction on Windows) at src/node_modules to that folder,
 * as prepare's links into the checkout's dependencies are, so the clean-up is tested on the real thing.
 */
function fakeRunners(opts: { orphans?: string[]; cycle?: boolean; lintFails?: boolean; linkTo?: string } = {}) {
  const calls = { prepare: [] as string[], tsc: [] as string[], lint: [] as string[][], vitest: [] as string[][], names: [] as string[][], timeouts: [] as (number | undefined)[] }
  return {
    calls,
    runners: {
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
      // A line `title :: file :: text` is a test that passes when the file holds the text; a fourth field `skip` makes it a skipped
      // one. With `namesOnly` none runs: every test is named, as skipped
      vitest: (dir: string, files: string[], o?: { timeoutMs?: number; namesOnly?: boolean }): Pass => {
        calls.timeouts.push(o?.timeoutMs)
        ;(o?.namesOnly ? calls.names : calls.vitest).push(files)
        return {
          timedOut: false,
          report: {
            testResults: files.map((file) => ({
              name: join(dir, file),
              assertionResults: readFileSync(join(dir, file), 'utf8')
                .split('\n')
                .filter((l) => l.includes(' :: '))
                .map((l) => {
                  const [title, target, text, skip] = l.split(' :: ').map((s) => s.trim()) as [string, string, string, string | undefined]
                  const ok = existsSync(join(dir, target)) && readFileSync(join(dir, target), 'utf8').includes(text)
                  return { ancestorTitles: [], title, status: o?.namesOnly || skip ? 'skipped' : ok ? 'passed' : 'failed' }
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
      const named = realRunners.vitest(dir, ['names.test.ts'], { timeoutMs: 60_000 * SLOW, namesOnly: true })
      expect(named.timedOut).toBe(false)
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

  it('mirrors the checkout\'s dependencies into a worktree with the same lockfile, workspace packages pointing at the worktree, and unlinks them without touching the checkout (#1254)', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-prepr-deps-'))
    try {
      const root = join(base, 'checkout')
      const tree = join(base, 'worktree')
      for (const dir of ['node_modules/.pnpm', 'node_modules/left-pad', 'packages/ui/node_modules/react', 'packages/ui/node_modules/@cc', 'packages/core/src']) mkdirSync(join(root, dir), { recursive: true })
      for (const dir of ['packages/ui', 'packages/core/src']) mkdirSync(join(tree, dir), { recursive: true })
      writeFileSync(join(root, 'node_modules/left-pad/index.js'), 'keep')
      writeFileSync(join(root, 'node_modules/.modules.yaml'), 'layoutVersion: 5\n')
      // A link to a file: a junction cannot be one, and Windows makes it without a word
      writeFileSync(join(root, 'node_modules/.pnpm/shim.txt'), 'a file')
      let fileLink = true
      try {
        symlinkSync(join(root, 'node_modules/.pnpm/shim.txt'), join(root, 'node_modules/shim.txt'), 'file')
      } catch {
        fileLink = false // Windows without the privilege for a file link
      }
      writeFileSync(join(root, 'packages/ui/node_modules/react/index.js'), 'keep')
      writeFileSync(join(root, 'packages/core/src/x.ts'), 'checkout')
      writeFileSync(join(tree, 'packages/core/src/x.ts'), 'worktree')
      // How pnpm links a workspace package: a link inside a scope folder, to the package's folder
      symlinkSync(join(root, 'packages/core'), join(root, 'packages/ui/node_modules/@cc/core'), 'junction')
      writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\r\n')
      expect(nodeModulesDirs(root)).toEqual(['node_modules', 'packages/ui/node_modules'])
      realRunners.prepare(tree, root)
      expect(readFileSync(join(tree, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(tree, 'node_modules/left-pad/index.js'), 'utf8')).toBe('keep')
      // pnpm's state names the checkout's store: a pnpm install into the worktree would trust it
      expect(existsSync(join(tree, 'node_modules/.modules.yaml'))).toBe(false)
      if (fileLink) expect(readFileSync(join(tree, 'node_modules/shim.txt'), 'utf8')).toBe('a file')
      // The workspace package is the worktree's own, whichever way it is reached: no path back into the checkout
      expect(readFileSync(join(tree, 'packages/ui/node_modules/@cc/core/src/x.ts'), 'utf8')).toBe('worktree')
      expect(realpathSync.native(join(tree, 'packages/ui/node_modules/@cc/core'))).toBe(realpathSync.native(join(tree, 'packages/core')))
      // Everything else leads to the checkout's own dependencies
      expect(realpathSync.native(join(tree, 'packages/ui/node_modules/react'))).toBe(realpathSync.native(join(root, 'packages/ui/node_modules/react')))
      // .pnpm, left-pad, react and @cc/core; the copy of a file is not a link
      expect(unlinkLinks(tree)).toBe(4)
      expect(existsSync(join(tree, 'node_modules/left-pad'))).toBe(false)
      expect(existsSync(join(tree, 'packages/ui/node_modules/@cc/core'))).toBe(false)
      expect(unlinkLinks(tree)).toBe(0)
      // The revert check takes the links away and prepares again, over the folders they leave: all of it back
      realRunners.prepare(tree, root)
      expect(readFileSync(join(tree, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(tree, 'packages/ui/node_modules/@cc/core/src/x.ts'), 'utf8')).toBe('worktree')
      expect(unlinkLinks(tree)).toBe(4)
      rmSync(tree, { recursive: true, force: true })
      expect(readFileSync(join(root, 'node_modules/left-pad/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(root, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(root, 'packages/core/src/x.ts'), 'utf8')).toBe('checkout')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('leaves out a workspace package the worktree does not have, and a node_modules it has no place for', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-prepr-deps-'))
    try {
      const root = join(base, 'checkout')
      const tree = join(base, 'worktree')
      for (const dir of ['node_modules', 'packages/ui/node_modules/@cc', 'packages/gone', 'packages/old/node_modules/z']) mkdirSync(join(root, dir), { recursive: true })
      mkdirSync(join(tree, 'packages/ui'), { recursive: true })
      symlinkSync(join(root, 'packages/gone'), join(root, 'packages/ui/node_modules/@cc/gone'), 'junction')
      expect(mirrorModules(root, tree)).toBe(2)
      expect(readdirSync(join(tree, 'packages/ui/node_modules/@cc'))).toEqual([])
      expect(existsSync(join(tree, 'packages/old'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  /**
   * The failure itself (#1254): a class declared in the worktree, and the same file reached through the checkout's
   * link to the workspace package. Seen on macOS (/var -> /private/var) and on the Windows runner (a temporary folder
   * named RUNNER~1 on one side, runneradmin on the other); tsc follows the links the same way on Windows here.
   * `reach` is the way the caller names the two folders: tsc must see one spelling of each.
   */
  function typeChecks(prefix: string, reach: (base: string) => { root: string; tree: string }): void {
    const base = mkdtempSync(join(tmpdir(), prefix))
    const { root, tree } = reach(base)
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      const sources: Record<string, string> = {
        'tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true, strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' }, include: ['packages/*/src'] }),
        'packages/core/package.json': JSON.stringify({ name: '@cc/core', version: '0.0.0', type: 'module', exports: { '.': './src/index.ts' } }),
        'packages/core/src/index.ts': 'export class Clock { private ticks = 0; now() { return this.ticks } }\n',
        // Both ways in, as apps/web does: a package name, and a relative path to the same sources
        'packages/ui/src/index.ts': "import { Clock } from '@cc/core'\nimport { Clock as Same } from '../../core/src/index'\nexport const clock: Same = new Clock()\n",
      }
      for (const dir of [root, tree]) {
        for (const [file, text] of Object.entries(sources)) {
          mkdirSync(dirname(join(dir, file)), { recursive: true })
          writeFileSync(join(dir, file), text)
        }
      }
      mkdirSync(join(root, 'node_modules/.pnpm'), { recursive: true })
      mkdirSync(join(root, 'packages/ui/node_modules/@cc'), { recursive: true })
      symlinkSync(join(here, '..', 'node_modules', 'typescript'), join(root, 'node_modules/typescript'), 'junction')
      symlinkSync(join(root, 'packages/core'), join(root, 'packages/ui/node_modules/@cc/core'), 'junction')
      writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      realRunners.prepare(tree, root)
      const result = realRunners.tsc(tree)
      expect(result.out).toBe('')
      expect(result.ok).toBe(true)
      // And again after the revert check's unlink and prepare: typescript is still there to run
      unlinkLinks(tree)
      realRunners.prepare(tree, root)
      expect(realRunners.tsc(tree)).toEqual({ ok: true, out: '', timedOut: false })
    } finally {
      // Links first: `typescript` in both folders leads into this repository's own node_modules, which no delete may follow
      unlinkLinks(tree)
      unlinkLinks(root)
      rmSync(realpathSync.native(base), { recursive: true, force: true })
    }
  }

  // The temporary folder as the system hands it out: on the Windows runner that is the 8.3 short form, on macOS /var
  const plain = (base: string) => ({ root: join(base, 'checkout'), tree: join(base, 'worktree') })

  it('type-checks a worktree whose workspace package is reached both by path and by name as one declaration', { timeout: 60_000 * SLOW }, () => {
    typeChecks('cc-prepr-tsc-', plain)
  })

  // A folder named by two spellings is two folders to tsc, wherever the second spelling comes from. On Windows a child
  // keeps the spelling of the folder it was started in, so a link to the folder is a second spelling there; elsewhere the
  // system resolves a working folder, and this only shows that a caller's link is harmless
  it('type-checks a worktree and a checkout that the caller names through a link to their folder', { timeout: 60_000 * SLOW }, () => {
    typeChecks('cc-prepr-alias-', (base) => {
      mkdirSync(join(base, 'real'))
      const alias = join(base, 'alias')
      symlinkSync(join(base, 'real'), alias, 'junction')
      mkdirSync(join(alias, 'checkout'))
      mkdirSync(join(alias, 'worktree'))
      return { root: join(alias, 'checkout'), tree: join(alias, 'worktree') }
    })
  })

  // The Windows runner's temporary folder (RUNNER~1 in the user's profile): the same folder in its 8.3 short form
  it.skipIf(process.platform !== 'win32')('type-checks a worktree and a checkout that the caller names in the 8.3 short form of their folder', { timeout: 60_000 * SLOW }, (ctx) => {
    // realpathSync.native writes the long name out (the plain one keeps a short name as it was given)
    const shortOf = (dir: string) => execSync(`for %I in ("${realpathSync.native(dir)}") do @echo %~sI`, { encoding: 'utf8', shell: 'cmd.exe' }).trim()
    const probe = mkdtempSync(join(tmpdir(), 'cc-prepr-probe-'))
    const has83 = shortOf(probe).toLowerCase() !== realpathSync.native(probe).toLowerCase()
    rmSync(probe, { recursive: true })
    // A volume with 8.3 names switched off (a Dev Drive) has none to give
    if (!has83) ctx.skip()
    typeChecks('cc-prepr-short-', (base) => {
      mkdirSync(join(base, 'checkout'))
      mkdirSync(join(base, 'worktree'))
      const short = shortOf(base)
      expect(realpathSync.native(short).toLowerCase()).toBe(realpathSync.native(base).toLowerCase())
      return { root: join(short, 'checkout'), tree: join(short, 'worktree') }
    })
  })

  it('reads its arguments, and refuses one it does not know', () => {
    expect(parseArgs(['--head', 'origin/x', '--base', 'origin/y', '--stack', 'a', '--stack', 'b', '--exempt', 'revert=a=b', '--run-id', '12-3', '--no-fetch', '--json'])).toEqual({
      fetch: false, json: true, head: 'origin/x', base: 'origin/y', stack: ['a', 'b'], exempt: { revert: 'a=b' }, runId: '12-3',
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

  it('asks the base only about a changed file that is not new and has a passing test', () => {
    // Every test of the file fails without the change: the first pass already decides
    git(repo, 'checkout', '-q', '-b', 'solo', 'main')
    write('src/a.test.mjs', 'knows two :: src/a.mjs :: value = 2\n')
    commit('solo')
    const solo = run({ head: 'solo' })
    expect(solo.calls.vitest).toEqual([['src/a.test.mjs']])
    expect(solo.calls.names).toEqual([])
    expect(solo.findings).toEqual([])
    // One that passes asks, and its new test is named
    write('src/a.test.mjs', 'keeps a value :: src/a.mjs :: value\nstill exports :: src/a.mjs :: export\n')
    commit('solo: a test that guards nothing')
    const loose = run({ head: 'solo' })
    expect(loose.calls.vitest).toEqual([['src/a.test.mjs']])
    expect(loose.calls.names).toEqual([['src/a.test.mjs']])
    expect(loose.findings.map((f: { message: string }) => f.message.split(' passes')[0])).toEqual(['src/a.test.mjs: "still exports"'])
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
    expect(r.findings.map((f: { check: string; message: string }) => [f.check, /: not run: out of time/.test(f.message)])).toEqual([['tsc', true], ['tsc', true], ['lint', true], ['revert', true]])
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
    const runners = {
      ...fake.runners,
      // The revert check's install (the dependencies changed) comes after the lint check, and takes more than the whole time
      prepare: (dir: string) => {
        fake.runners.prepare(dir)
        if (fake.calls.lint.length) clock.now = 400_000
      },
      vitest: (dir: string, files: string[], o?: { timeoutMs?: number; namesOnly?: boolean }) => (limits.push(o?.timeoutMs), fake.runners.vitest(dir, files, o)),
    }
    prePr({ cwd: repo, head: 'deps', main: 'main', fetch: false, runners, limitMs: 300_000, now: () => clock.now })
    expect(limits[0]).toBe(1000)
  })

  it('does not judge a test when a vitest pass gave no report or a tool was stopped, and says so', () => {
    const fake = fakeRunners()
    const stopped = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, tsc: () => ({ ok: false, out: '', timedOut: true }) } })
    expect(stopped.findings.filter((f: { check: string }) => f.check === 'tsc').map((f: { message: string }) => f.message.split(': not run')[0]).length).toBe(2)
    expect(stopped.findings.filter((f: { message: string }) => /tsc fails/.test(f.message))).toEqual([])
    // The first pass: no report
    const first = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, vitest: () => ({ report: null, timedOut: false }) } })
    expect(first.findings.map((f: { check: string }) => f.check)).toEqual(['revert'])
    expect(first.findings[0].message).toMatch(/not run: vitest gave no report/)
    // ...and one that was stopped at the limit it was given says that, so the step that ran out is named. It is how the step ended
    // that tells, not the clock: a crash with the time used up reads as a crash
    const clock = { now: 0 }
    const limited = (timedOut: boolean) => ({ ...fake.runners, vitest: () => ((clock.now = 300_000), { report: null, timedOut }) })
    const outOfTime = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, limitMs: 300_000, now: () => clock.now, runners: limited(true) })
    expect(outOfTime.findings.map((f: { message: string }) => f.message)).toEqual([expect.stringMatching(/^The changed tests \(src\/a\.test\.mjs, src\/b\.test\.mjs\): not run: vitest was stopped after 300 s, the most it was given, before it had finished/)])
    clock.now = 0
    const crashed = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, limitMs: 300_000, now: () => clock.now, runners: limited(false) })
    expect(crashed.findings.map((f: { message: string }) => f.message)).toEqual([expect.stringMatching(/not run: vitest gave no report \(it did not start, or crashed\)/)])
    // The base's names: none, and no test of the first pass looks new
    const second = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: { ...fake.runners, vitest: (dir: string, files: string[], o?: { namesOnly?: boolean }) => (o?.namesOnly ? { report: null, timedOut: false } : fake.runners.vitest(dir, files, o)) } })
    expect(second.findings.map((f: { check: string; message: string }) => [f.check, /not run: vitest gave no report .*so no test was judged/.test(f.message)])).toEqual([['revert', true]])
  })

  it('reports each new test that passes with the other changes reverted, and none that fails or was there', () => {
    const r = run()
    expect(r.findings.filter((f: { check: string }) => f.check === 'revert').map((f: { message: string }) => f.message)).toEqual([
      'src/a.test.mjs: "still exports" passes with this pull request\'s other changes reverted to main, so it protects nothing. Make it fail without the change, or exempt the revert check with the reason it cannot.',
      'src/b.test.mjs: "has a" passes with this pull request\'s other changes reverted to main, so it protects nothing. Make it fail without the change, or exempt the revert check with the reason it cannot.',
    ])
    // The changed files ran once, at the head's version; the base's version was only listed, to learn which tests were there
    expect(r.calls.vitest).toEqual([['src/a.test.mjs', 'src/b.test.mjs']])
    expect(r.calls.names).toEqual([['src/a.test.mjs']])
    expect(r.ok).toBe(false)
  })

  it('counts a failed test and a file that did not load as failing without the change, a skipped test as neither (#1806)', () => {
    const fake = fakeRunners()
    const vitest = (dir: string, files: string[]) => ({
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
    expect(r.findings.filter((f: { check: string }) => f.check === 'revert').map((f: { message: string }) => f.message.split(' passes')[0])).toEqual(['src/a.test.mjs: "still exports"', 'src/b.test.mjs: "has a"'])
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
    expect(r.calls.prepare).toEqual([lower, top])
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
    expect(t.findings.map((f: { check: string }) => f.check)).toEqual(['revert', 'revert'])
    expect(() => run({ exempt: { revert: '  ' } })).toThrow('An exemption from revert needs its reason.')
    expect(() => run({ exempt: { main: 'x' } })).toThrow('No check is called main; the checks are tsc, orphans, deps, lint, store-step, guards, revert.')
  })

  it('stops when interrupted, and takes its worktrees and their links away without reaching through them', () => {
    const deps = mkdtempSync(join(tmpdir(), 'cc-prepr-checkout-deps-'))
    try {
      writeFileSync(join(deps, 'keep.js'), 'keep')
      let tscs = 0
      const fake = fakeRunners({ linkTo: deps })
      const runners = { ...fake.runners, tsc: (dir: string) => (tscs++, fake.runners.tsc(dir)) }
      expect(() => prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners, runId: 'interrupted-test', stopped: () => tscs > 0 })).toThrow('interrupted')
      expect(tscs).toBe(1)
      expect(existsSync(runDir('interrupted-test'))).toBe(false)
      expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
      expect(readFileSync(join(deps, 'keep.js'), 'utf8')).toBe('keep')
    } finally {
      rmSync(deps, { recursive: true, force: true })
    }
  })

  it('cleans up after a run that was killed: by --cleanup, or by the next run once its process is gone', () => {
    const deps = mkdtempSync(join(tmpdir(), 'cc-prepr-checkout-deps-'))
    const root = git(repo, 'rev-parse', '--show-toplevel')
    // What a killed run leaves: its folder, its owner, a registered worktree with a link into the checkout's dependencies
    const leave = (id: string, pid: number) => {
      const dir = runDir(id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid, root }))
      git(repo, 'worktree', 'add', '--detach', '-q', join(dir, 'wt-1'), 'top')
      symlinkSync(deps, join(dir, 'wt-1', 'src', 'node_modules'), 'junction')
      return dir
    }
    try {
      writeFileSync(join(deps, 'keep.js'), 'keep')
      const killed = leave(`killed-${process.pid}`, 999_999)
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/pre-pr.mjs', import.meta.url)), '--cleanup', `killed-${process.pid}`], { cwd: repo, env: GIT_ENV })
      expect(existsSync(killed)).toBe(false)
      expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
      expect(readFileSync(join(deps, 'keep.js'), 'utf8')).toBe('keep')

      const dead = leave(`dead-${process.pid}`, 999_998)
      const living = leave(`living-${process.pid}`, process.pid)
      const swept = sweepStale(root, { isAlive: (pid: number) => pid === process.pid })
      expect(swept).toEqual([dead])
      expect(existsSync(living)).toBe(true)
      expect(readFileSync(join(deps, 'keep.js'), 'utf8')).toBe('keep')
      expect(removeRun(living, root)).toEqual([])
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
    expect(calls).toEqual([['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,headRefName,headRefOid,isDraft'], ['pr', 'diff', '9', '--name-only']])
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
    expect(stepFiles(r)[0]).toContain('Store step 57 is already on main (v55.ts). The orchestrator assigns')
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
  /** A pull request: a branch off main, served as refs/pull/N/head */
  const openPr = (number: number, files: Record<string, string>, over: Record<string, unknown> = {}) => {
    git(repo, 'checkout', '-q', '-b', `pr${number}`, 'main')
    for (const [path, text] of Object.entries(files)) write(path, text)
    commit(`pr ${number}`)
    git(repo, 'push', '-q', 'origin', `pr${number}:refs/pull/${number}/head`)
    const pr = { number, title: `pull request ${number}`, headRefName: `pr${number}`, headRefOid: git(repo, 'rev-parse', 'HEAD'), isDraft: false, ...over }
    git(repo, 'checkout', '-q', 'feat')
    return pr
  }
  const GUARD = 'no banned in src :: src :: banned\n'
  const clock = { t: 0 }
  let step = 1000
  // How long a test file takes where it is not `step`
  const fileMs: Record<string, number> = {}
  const vitestCalls: string[][] = []
  const runners = (prs: unknown[], extra: Record<string, unknown> = {}) => {
    const fake = fakeRunners()
    return {
      ...fake.runners,
      gh: () => JSON.stringify(prs),
      // `needs-install` in a worktree: its dependencies would need an install, which a guard run does not do
      prepare: (dir: string, _root: string, options?: { linkOnly?: boolean }) => (options?.linkOnly && existsSync(join(dir, 'needs-install')) ? false : undefined),
      vitest: (dir: string, files: string[]) => {
        vitestCalls.push(files)
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
  const run = (rs: ReturnType<typeof runners>, over: Record<string, unknown> = {}) =>
    prePr({ cwd: repo, head: 'feat', main: 'main', remote: 'origin', fetch: false, runners: rs, now: () => clock.t, ...over, exempt: { revert: 'the fake guard is not what is under test', ...(over.exempt as object) } })
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
    commit('feat: a guard')
  }

  it('knows a repository-wide guard when the branch adds one', () => {
    expect(isGuardTest('tooling/brand.test.ts')).toBe(true)
    expect(isGuardTest('tooling/fixtures/x.test.ts')).toBe(false)
    expect(isGuardTest('tooling/guard.mjs')).toBe(false)
    expect(isGuardTest('packages/ui/src/a.test.ts', "const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT })")).toBe(true)
    expect(isGuardTest('packages/ui/src/a.test.ts', 'mkdirSync(dir, { recursive: true })')).toBe(false)
    expect(isGuardTest('packages/ui/src/a.test.ts', '// pre-pr: guard\n')).toBe(true)
    expect(isGuardTest('e2e/a.test.ts', "execFileSync('git', ['ls-files'], { cwd: ROOT })")).toBe(false)
    addGuard()
    write('src/b.test.ts', 'plain\n')
    commit('feat: a plain test')
    expect(guardFiles(repo, git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', 'HEAD'))).toEqual(['tooling/guard.test.ts'])
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
      { file: 'tooling/a.test.ts', name: 'g > one', line: 'Error: boom' },
      { file: 'tooling/b.test.ts', name: '', line: 'Cannot find module ./x' },
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

  it('skips a pull request that does not merge cleanly, or needs other dependencies, and says so', () => {
    addGuard()
    const conflicting = openPr(24, { 'tooling/guard.test.ts': 'no other in src :: src :: other\n' })
    const install = openPr(26, { 'needs-install': 'x\n' })
    const r = run(runners([conflicting, install]))
    expect(vitestCalls).toEqual([])
    expect(guardsOf(r)).toEqual([
      'tooling/guard.test.ts was not run against: #24 (does not merge cleanly with this branch (tooling/guard.test.ts)); #26 (needs other dependencies than this checkout has (a different lockfile)).',
    ])
    expect(r.ok).toBe(true)
  })

  it('does not start the guards with less time than they need', () => {
    addGuard()
    const r = run(runners([openPr(21, { 'src/p21.txt': 'fine\n' })]), { limitMs: 59_000 })
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
    prePr({ cwd: repo, head: 'feat', main: 'main', remote: 'origin', fetch: false, runners: rs, now: () => clock.t, ...over })

  it('starts a pull request only with as much time left as one run of the guards took, and says what was left', () => {
    addGuard()
    step = 30_000
    const prs = [21, 22, 26].map((n) => openPr(n, { [`src/p${n}.txt`]: 'fine\n' }))
    // 100 s in all: the revert check's run takes 30 s, and the guards have 70 s left. #21 runs (40 s left), #22 runs (10 s left), and #26 would be cut off
    const r = withRevert(runners(prs), { limitMs: 100_000 })
    expect(vitestCalls).toHaveLength(3)
    expect(guardsOf(r)).toEqual(['tooling/guard.test.ts was not run against: #26 (not started: a run takes about 30 s and 10 s were left).'])
  })

  it('sizes the guard runs by the guards, not by the slowest test the pull request changed', () => {
    addGuard()
    write('src/slow.test.mjs', 'slow :: src :: nothing-here\n')
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
    addGuard()
    const prs = [openPr(21, { 'src/p21.txt': 'fine\n' })]
    const given: (number | undefined)[] = []
    // The revert check's run takes 400 s; the guards' run is stopped at the limit it is given
    const cutOff = (clockStep: number) => {
      let calls = 0
      return runners(prs, {
        vitest: (dir: string, files: string[], o?: { timeoutMs?: number }) => {
          if (calls++ === 0) {
            clock.t += clockStep
            return { timedOut: false, report: { testResults: files.map((file) => ({ name: join(dir, file), status: 'passed', startTime: 0, endTime: clockStep, assertionResults: [{ ancestorTitles: [], title: 'no banned in src', status: 'passed' }] })) } }
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
    expect(r.exempted.map((x: { check: string }) => x.check).sort()).toEqual(['guards', 'revert'])
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
