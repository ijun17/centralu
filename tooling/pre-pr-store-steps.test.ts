import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { prePr } from '../scripts/pre-pr.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { STEP_DIR, stepNumbers, stepsAddedByDiff } from '../scripts/pre-pr-store-steps.mjs'
import { fakeRunners, git, yieldBetweenTests } from './pre-pr.test-helpers.js'

yieldBetweenTests()

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
