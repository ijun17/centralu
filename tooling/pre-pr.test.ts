import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { isTestFile, isVitestFile, nodeModulesDirs, orphansOf, parseArgs, passingNewTests, prePr, realRunners, stackHeads, vitestTests } from '../scripts/pre-pr.mjs'

/**
 * `pnpm pre-pr` (#1181): the checks run on real git repositories made here, with the tools (pnpm
 * install, tsc, dependency-cruiser, vitest) replaced by fakes that read the worktree they are given.
 * A fake test file is one line a test: `name :: file :: text`, passing when the file holds the text.
 */

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV }).trim()

type Report = { testResults: { name: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[] }

function fakeRunners(opts: { orphans?: string[] } = {}) {
  const calls = { prepare: [] as string[], release: [] as string[], tsc: [] as string[], vitest: [] as string[][] }
  return {
    calls,
    runners: {
      prepare: (dir: string) => {
        const sha = git(dir, 'rev-parse', 'HEAD')
        calls.prepare.push(sha)
        return () => calls.release.push(sha)
      },
      tsc: (dir: string) => {
        calls.tsc.push(git(dir, 'rev-parse', 'HEAD'))
        return existsSync(join(dir, 'BROKEN')) ? { ok: false, out: 'src/a.ts(1,1): error TS2322: broken' } : { ok: true, out: '' }
      },
      depcruise: () => ({
        summary: { violations: [...(opts.orphans ?? []).map((from) => ({ rule: { name: 'no-orphans' }, from })), { rule: { name: 'not-to-unresolvable' }, from: 'src/x.ts' }] },
      }),
      vitest: (dir: string, files: string[]): Report => {
        calls.vitest.push(files)
        return {
          testResults: files.map((file) => ({
            name: join(dir, file),
            assertionResults: readFileSync(join(dir, file), 'utf8')
              .split('\n')
              .filter((l) => l.includes(' :: '))
              .map((l) => {
                const [title, target, text] = l.split(' :: ').map((s) => s.trim()) as [string, string, string]
                const ok = existsSync(join(dir, target)) && readFileSync(join(dir, target), 'utf8').includes(text)
                return { ancestorTitles: [], title, status: ok ? 'passed' : 'failed' }
              }),
          })),
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

  it('links the checkout\'s dependencies into a worktree with the same lockfile, and unlinks them without touching the checkout', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-pre-pr-deps-'))
    try {
      const root = join(base, 'checkout')
      const tree = join(base, 'worktree')
      for (const dir of ['node_modules/.pnpm', 'node_modules/left-pad', 'packages/ui/node_modules/react', 'packages/core']) mkdirSync(join(root, dir), { recursive: true })
      for (const dir of ['packages/ui', 'packages/core']) mkdirSync(join(tree, dir), { recursive: true })
      writeFileSync(join(root, 'node_modules/left-pad/index.js'), 'keep')
      writeFileSync(join(root, 'packages/ui/node_modules/react/index.js'), 'keep')
      writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\r\n')
      expect(nodeModulesDirs(root)).toEqual(['node_modules', 'packages/ui/node_modules'])
      const release = realRunners.prepare(tree, root)
      expect(readFileSync(join(tree, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
      release()
      expect(existsSync(join(tree, 'node_modules'))).toBe(false)
      expect(existsSync(join(tree, 'packages/ui/node_modules'))).toBe(false)
      rmSync(tree, { recursive: true, force: true })
      expect(readFileSync(join(root, 'node_modules/left-pad/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(root, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('reads its arguments, and refuses one it does not know', () => {
    expect(parseArgs(['--head', 'origin/x', '--base', 'origin/y', '--stack', 'a', '--stack', 'b', '--no-fetch', '--json'])).toEqual({ fetch: false, json: true, head: 'origin/x', base: 'origin/y', stack: ['a', 'b'] })
    expect(() => parseArgs(['--skip'])).toThrow(/Unknown argument --skip/)
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
  const run = (over: Record<string, unknown> = {}, orphans?: string[]) => {
    const fake = fakeRunners({ orphans })
    const result = prePr({ cwd: repo, head: 'top', main: 'main', fetch: false, runners: fake.runners, ...over })
    return { ...result, calls: fake.calls }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-pre-pr-test-'))
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
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports each new test that passes with the other changes reverted, and none that fails or was there', () => {
    const r = run()
    expect(r.findings.filter((f: { check: string }) => f.check === 'revert').map((f: { message: string }) => f.message)).toEqual([
      'src/a.test.mjs: "still exports" passes with this pull request\'s other changes reverted to main, so it protects nothing. Make it fail without the change, or say in the pull request why it cannot.',
      'src/b.test.mjs: "has a" passes with this pull request\'s other changes reverted to main, so it protects nothing. Make it fail without the change, or say in the pull request why it cannot.',
    ])
    // The changed file ran at the head's version, then at the base's to learn which tests were there
    expect(r.calls.vitest).toEqual([['src/a.test.mjs', 'src/b.test.mjs'], ['src/a.test.mjs']])
    expect(r.ok).toBe(false)
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
    expect(r.findings.some((f: { check: string }) => f.check === 'main')).toBe(true)
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
    // Every worktree's dependencies are undone before it goes
    expect(r.calls.release).toEqual([lower, top])
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

  it('says when the head does not contain main, and which files a merge would conflict on', () => {
    expect(run().findings.some((f: { check: string }) => f.check === 'main')).toBe(false)
    git(repo, 'checkout', '-q', 'main')
    write('src/a.mjs', 'export const value = 3\n')
    commit('main moves on')
    git(repo, 'checkout', '-q', 'top')
    const main = run().findings.filter((f: { check: string }) => f.check === 'main')
    expect(main.map((f: { message: string }) => f.message)).toEqual(['top does not contain main: 1 commit(s) behind. Rebase on it or merge it, then check again. A merge conflicts in: src/a.mjs.'])
  })

  it('leaves the checkout as it was, and no worktree behind', () => {
    write('uncommitted.txt', 'mine\n')
    const before = git(repo, 'status', '--porcelain')
    run()
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
