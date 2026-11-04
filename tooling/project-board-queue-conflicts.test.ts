import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeExe, gitWrapper } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { SLOW } from './test-timing.js'
import { g, GIT_ENV, githubStandIn } from './git-fixture.test-helpers.js'
// @ts-expect-error -- a plain .mjs module of the board app, without types
import { pathMatches } from '../.centralu/apps/project-board/versions.mjs'
import { SHA, SHA2, LISTS, MECHANICAL_FILES, ghCheck, green, ghRun, ghPr, ghState, root, fake, runtime, call, patchGh, writes, queueOnDisk, notices, until, stateOf, morePolls, appTmp } from './project-board-queue.test-helpers.js'

// --- Conflicts (#1182): real git, a bare repository standing for GitHub's --------------------------

const MIGRATION = 'packages/agent-host/src/dev-services/store/migrations/v55.ts'

type ConflictRepo = { work: string; origin: string; main: string; heads: Record<string, string> }

/**
 * A repository where each branch (`feat/b<N>`) and main changed the same files since they parted, so merging main
 * into the branch conflicts in exactly those files; each branch also has a file of its own. The checkout's remote is
 * GitHub's address, which git rewrites to `origin.git` (as rebase_stack's tests do), and it is left on a branch of its
 * own with uncommitted work, which nothing may touch.
 */
function conflictRepo(branches: Record<number, string[]>, { base = {}, branch = {} }: { base?: Record<string, string>; branch?: Record<string, string> } = {}): ConflictRepo {
  const { origin, work } = githubStandIn(root)
  const files = [...new Set(Object.values(branches).flat())]
  const write = (f: string, text: string) => {
    mkdirSync(join(work, f, '..'), { recursive: true })
    writeFileSync(join(work, f), text)
  }
  for (const f of files) write(f, 'base\n')
  write('README.md', 'base\n')
  for (const [f, text] of Object.entries(base)) write(f, text)
  g(work, 'add', '-A')
  g(work, 'commit', '-q', '-m', 'base')
  const heads: Record<string, string> = {}
  for (const [n, changed] of Object.entries(branches)) {
    g(work, 'checkout', '-q', '-b', `feat/b${n}`, 'main')
    for (const f of changed) write(f, `branch ${n}\n`)
    write(`own-${n}.txt`, `${n}\n`)
    for (const [f, text] of Object.entries(branch)) write(f, text)
    g(work, 'add', '-A')
    g(work, 'commit', '-q', '-m', `change ${n}`)
    heads[n] = g(work, 'rev-parse', 'HEAD')
  }
  g(work, 'checkout', '-q', 'main')
  for (const f of files) write(f, 'main moved\n')
  g(work, 'commit', '-q', '-am', 'main moves')
  const main = g(work, 'rev-parse', 'HEAD')
  g(work, 'push', '-q', 'origin', 'main', ...Object.keys(branches).map((n) => `feat/b${n}`))
  g(work, 'checkout', '-q', '-b', 'mine', main)
  writeFileSync(join(work, 'README.md'), 'edited, not committed\n')
  return { work, origin, main, heads }
}

/**
 * The stand-ins for the board's regeneration commands, each run as `node <script> …args <files>`:
 * - `regen` writes `regenerated <file>` into each file, and the names of its environment's variables to command-env.json;
 * - `fail` writes a line to stderr and exits 1;
 * - `push` first pushes `args` (`<checkout> <commit> <branch>`) to GitHub's stand-in, as an author pushing while the
 *   queue regenerates, then does what `regen` does.
 */
const SCRIPTS = {
  regen: [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(__ENV_OUT__, JSON.stringify(Object.keys(process.env)))',
    'for (const f of process.argv.slice(2)) writeFileSync(f, `regenerated ${f}\\n`)',
  ],
  fail: ["process.stderr.write('warming up\\nregeneration broke\\n')", 'process.exit(1)'],
  // What the command finds in node_modules: an outside package (ext) and a workspace package (ws)
  probe: [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "const read = (f) => { try { return readFileSync(f, 'utf8').trim() } catch { return 'none' } }",
    "for (const f of process.argv.slice(2)) writeFileSync(f, `ext=${read('packages/p/node_modules/ext/x.txt')} ws=${read('packages/p/node_modules/ws/v.txt')}\\n`)",
  ],
  push: [
    "import { execFileSync } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    'const [work, sha, branch, ...files] = process.argv.slice(2)',
    "execFileSync('git', ['-C', work, 'push', '-q', 'origin', `${sha}:refs/heads/${branch}`])",
    'for (const f of files) writeFileSync(f, `regenerated ${f}\\n`)',
  ],
}

/** The board's own lists (#1182), each mechanical entry regenerating with the test's `script` instead of its command. */
function testLists(script: keyof typeof SCRIPTS = 'regen', args: string[] = []) {
  const file = join(root, `${script}.mjs`)
  const body = SCRIPTS[script].map((l) => l.replace('__ENV_OUT__', JSON.stringify(join(root, 'command-env.json'))))
  writeFileSync(file, `${body.join('\n')}\n`)
  return JSON.stringify({
    mechanical: LISTS.mechanical.map((e) => ({ files: e.files, run: [[process.execPath, file, ...args, ...MECHANICAL_FILES.filter((f) => e.files.some((p) => pathMatches(p, f)))]] })),
    never: LISTS.never,
  })
}

/** The temporary folder the app sees: the test's own, so the queue's sweep of left-over worktrees looks only there */

function conflictRuntime(repo: ConflictRepo, prs: number[], { lists = testLists(), env = {} }: { lists?: string; env?: Record<string, string> } = {}) {
  const state = ghState({
    prs: Object.fromEntries(prs.map((n) => [String(n), ghPr(n, { headRefOid: repo.heads[n], mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' })])),
    checks: {},
    runs: {},
  })
  mkdirSync(appTmp(), { recursive: true })
  const tmp = { TMPDIR: appTmp(), TEMP: appTmp(), TMP: appTmp() }
  return runtime(state, { PROJECT_BOARD_QUEUE_CHECKOUT: repo.work, PROJECT_BOARD_QUEUE_CONFLICTS: lists, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig'), ...tmp, ...env }, gitWrapper(fake.bin))
}

/** A commit an author made on top of the branch's head (the same tree, a new commit), not pushed yet: the checkout is not touched */
const authorCommit = (repo: ConflictRepo, n: number) => g(repo.work, 'commit-tree', `${repo.heads[n]}^{tree}`, '-p', repo.heads[n]!, '-m', `author's fix ${n}`)
/** A workspace with a lockfile and two packages, p depending on q (a workspace package) and on an outside package */
const WORKSPACE = {
  '.gitignore': 'node_modules\n',
  'package.json': '{}\n',
  'pnpm-lock.yaml': 'lock v1\n',
  'packages/p/package.json': '{}\n',
  'packages/q/package.json': '{}\n',
  'packages/q/v.txt': 'base\n',
}

/**
 * The checkout installed as pnpm leaves it: `node_modules/.modules.yaml`, an outside package in the root's
 * node_modules, and p's node_modules linking q (the checkout's own copy) and that package.
 */
function installCheckout(repo: ConflictRepo) {
  const nm = join(repo.work, 'node_modules')
  mkdirSync(join(nm, 'marker'), { recursive: true })
  writeFileSync(join(nm, '.modules.yaml'), 'layoutVersion: 5\n')
  writeFileSync(join(nm, 'marker', 'x.txt'), 'from the checkout\n')
  mkdirSync(join(repo.work, 'packages/p/node_modules'), { recursive: true })
  symlinkSync(join(repo.work, 'packages/q'), join(repo.work, 'packages/p/node_modules/ws'), 'junction')
  symlinkSync(join(nm, 'marker'), join(repo.work, 'packages/p/node_modules/ext'), 'junction')
}

/** A `pnpm` on the app's PATH that records each call to pnpm-calls.jsonl and "installs" the outside package */
function fakePnpm() {
  const calls = join(root, 'pnpm-calls.jsonl')
  fakeExe(
    fake.bin,
    'pnpm',
    [
      "const fs = require('fs')",
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      "fs.mkdirSync('packages/p/node_modules/ext', { recursive: true })",
      "fs.writeFileSync('packages/p/node_modules/ext/x.txt', 'installed\\n')",
    ].join('\n'),
  )
  return () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
}

/** Lists where the schema doc is regenerated as the board's list does it: an install, then a command that needs node_modules */
const modulesLists = () => {
  testLists('probe')
  return JSON.stringify({ mechanical: [{ files: ['docs/generated/schema.md'], run: [['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], [process.execPath, join(root, 'probe.mjs'), 'docs/generated/schema.md']] }], never: LISTS.never })
}

/** The queue's own temporary folders left in the app's temporary folder */
const queueTmps = () => readdirSync(appTmp()).filter((f) => f.startsWith('centralu-queue-merge-'))

const tipOf = (repo: ConflictRepo, n: number) => g(repo.origin, 'rev-parse', `refs/heads/feat/b${n}`)
const conflictSteps = (pr = 77) => (queueOnDisk().events as any[]).filter((e) => e.kind === 'conflict' && e.pr === pr)
/** The person's checkout: its branch, head and changes, and no worktree or fetched ref left behind */
const untouched = (work: string) => ({
  branch: g(work, 'branch', '--show-current'),
  head: g(work, 'rev-parse', 'HEAD'),
  status: g(work, 'status', '--porcelain'),
  worktrees: g(work, 'worktree', 'list').split('\n').length,
  refs: g(work, 'for-each-ref', 'refs/centralu-queue'),
})

/**
 * #1221 on #1218 (2026-10-19): #77 stacked on #76; #76 lands as a squash, GitHub moves #77's base to main, and #77's
 * branch still carries #76's original commits, which conflict with their squash and what main did since (five files).
 * `ownConflict`: #77's own commit also changes a file main changed since, so even the rebase conflicts.
 */
function squashedStack({ ownConflict = false } = {}) {
  const repo = conflictRepo({ 90: ['other.txt'] })
  const { work } = repo
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']
  const write = (f: string, text: string) => {
    mkdirSync(join(work, f, '..'), { recursive: true })
    writeFileSync(join(work, f), text)
  }
  g(work, 'checkout', '-q', 'main')
  for (const f of files) write(f, 'base\n')
  g(work, 'add', ...files)
  g(work, 'commit', '-q', '-m', 'the files')
  const base = g(work, 'rev-parse', 'HEAD')
  g(work, 'checkout', '-q', '-b', 'feat/b76', base)
  for (const f of files) write(f, 'lower 76\n')
  g(work, 'add', ...files)
  g(work, 'commit', '-q', '-m', 'change 76')
  const lower = g(work, 'rev-parse', 'HEAD')
  g(work, 'checkout', '-q', '-b', 'feat/b77', lower)
  write('own-77.txt', '77\n')
  if (ownConflict) write('src/a.ts', 'top 77\n')
  g(work, 'add', 'own-77.txt', 'src/a.ts')
  g(work, 'commit', '-q', '-m', 'change 77')
  const top = g(work, 'rev-parse', 'HEAD')
  // main: #76 as one squash commit, then main changes the same files again
  g(work, 'checkout', '-q', 'main')
  g(work, 'merge', '-q', '--squash', 'feat/b76')
  g(work, 'commit', '-q', '-m', 'change 76 (#76)')
  for (const f of files) write(f, 'main after 76\n')
  g(work, 'add', ...files)
  g(work, 'commit', '-q', '-m', 'main moves on')
  const main = g(work, 'rev-parse', 'HEAD')
  g(work, 'push', '-q', '-f', 'origin', 'main', 'feat/b76', 'feat/b77')
  g(work, 'checkout', '-q', 'mine')
  return { ...repo, main, heads: { 76: lower, 77: top } as Record<string, string>, files }
}

/** #76 queued and landed by the queue first (green on its head), so the queue knows the head it landed */
async function landLower(repo: ConflictRepo) {
  patchGh((s) => {
    s.prs['76'] = ghPr(76, { headRefOid: repo.heads[76] })
    s.checks[repo.heads[76]!] = green()
    s.runs[repo.heads[76]!] = [ghRun('success', 1, repo.heads[76], { head_branch: 'feat/b76' })]
  })
  await call('queue_merge', { pr: 76, owner: 'tester' })
  await until((x) => stateOf(x, 76) === 'merged', '#76 to land')
}

describe('the merge queue resolves a conflict with main itself, or hands it to the author session (#1182)', { timeout: 120_000 * SLOW }, () => {
  it('rebases a pull request stacked on one it landed as a squash onto main without that one\'s commits, pushes it with a lease, and lands it once CI passed (#1221)', async () => {
    const repo = squashedStack()
    const before = untouched(repo.work)
    conflictRuntime(repo, [77])
    await landLower(repo)
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await until(() => conflictSteps().some((e) => e.step === 'push'), 'the rebase to be pushed')
    const tip = tipOf(repo, 77)
    // Its own commit only, on main: #76's original commit is gone, nothing merged, nothing conflicted
    expect(g(repo.origin, 'rev-list', '--parents', '-n', '1', tip).split(' ').slice(1)).toEqual([repo.main])
    expect(g(repo.origin, 'log', '-1', '--format=%s', tip)).toBe('change 77')
    expect(g(repo.origin, 'show', `${tip}:own-77.txt`)).toBe('77')
    expect(g(repo.origin, 'show', `${tip}:src/a.ts`)).toBe('main after 76')
    expect(spawnSync('git', ['merge-base', '--is-ancestor', repo.heads[76]!, tip], { cwd: repo.origin, env: GIT_ENV }).status).toBe(1)
    expect(untouched(repo.work)).toEqual(before)
    expect(queueTmps()).toEqual([])
    expect(conflictSteps().map((e) => [e.step, e.dropped ?? null, e.lease ?? null])).toEqual([
      ['rebase', 76, null],
      ['push', null, true],
    ])
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
    // Nothing lands from the rebased head until CI has passed on it
    expect(writes().filter((w) => w[0] === 'merge').map((w) => w[1])).toEqual(['76'])
    patchGh((s) => {
      Object.assign(s.prs['77'], { headRefOid: tip, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })
      s.checks[tip] = green('2026-10-17T09:00:00Z')
      s.runs[tip] = [ghRun('success', 1, tip)]
    })
    await until((x) => stateOf(x) === 'merged', 'the rebased head to land')
    expect(writes().find((w) => w[0] === 'merge' && w[1] === '77')![2]).toEqual(expect.arrayContaining(['--match-head-commit', tip]))
    expect(conflictSteps().at(-1)).toMatchObject({ step: 'fixed', by: 'queue' })
  })

  it('hands it off when the rebase without the landed one\'s commits conflicts too, saying how to rebase, and pushes nothing (#1221)', async () => {
    const repo = squashedStack({ ownConflict: true })
    conflictRuntime(repo, [77])
    await landLower(repo)
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
    expect(q.queue.find((i: any) => i.pr === 77).reason).toMatchObject({ kind: 'conflict', files: ['src/a.ts'], relay: { to: 'writer', branch: 'feat/b77' } })
    expect(tipOf(repo, 77)).toBe(repo.heads[77])
    const told = notices().filter((e) => e.kind === 'attention')
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain(`#76 landed as a squash, and feat/b77 still carries its original commits; the queue rebased feat/b77 onto main without them (git rebase --onto main ${repo.heads[76]!.slice(0, 7)}), and that conflicts too.`)
    expect((told[0] as any).relay.text).toBe(`Rebase feat/b77 onto main without #76's commits (git rebase --onto origin/main ${repo.heads[76]}), resolve the conflicts and push with --force-with-lease; conflicted files: src/a.ts.`)
    expect(conflictSteps().map((e) => e.step)).toEqual(['rebase', 'handoff'])
    expect(queueTmps()).toEqual([])
  })


  it('regenerates a conflict only in mechanical files, pushes the merge, and lands its new head once CI passed on it, with no attention', async () => {
    const repo = conflictRepo({ 77: ['pnpm-lock.yaml', 'docs/generated/schema.md'] })
    const before = untouched(repo.work)
    // The queue's own secrets, which code of the pull request must not see
    conflictRuntime(repo, [77], { env: { GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret', ANTHROPIC_API_KEY: 'key', SOME_PASSWORD: 'pw' } })
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await until(() => conflictSteps().some((e) => e.step === 'push'), 'the merge to be pushed')
    const tip = tipOf(repo, 77)
    const seen: string[] = JSON.parse(readFileSync(join(root, 'command-env.json'), 'utf8'))
    expect(seen.filter((k) => /TOKEN|KEY|PASSWORD|FAKE_GH|PROJECT_BOARD/i.test(k))).toEqual([])
    expect(seen.some((k) => k.toUpperCase() === 'PATH')).toBe(true)
    // What regenerating made of each file, against main's version, for a person to see
    expect(g(repo.origin, 'log', '-1', '--format=%b', tip)).toContain(`Regenerated, against main at ${repo.main.slice(0, 7)}:\n  docs/generated/schema.md +1 -1\n  pnpm-lock.yaml +1 -1`)
    // A merge of main into the branch, on top of the head the queue read: a fast-forward, never forced
    expect(g(repo.origin, 'rev-list', '--parents', '-n', '1', tip).split(' ').slice(1)).toEqual([repo.heads[77], repo.main])
    expect(g(repo.origin, 'show', `${tip}:pnpm-lock.yaml`)).toBe('regenerated pnpm-lock.yaml')
    expect(g(repo.origin, 'show', `${tip}:docs/generated/schema.md`)).toBe('regenerated docs/generated/schema.md')
    expect(g(repo.origin, 'show', `${tip}:own-77.txt`)).toBe('77')
    expect(g(repo.origin, 'log', '-1', '--format=%s', tip)).toBe('Merge main into feat/b77')
    expect(untouched(repo.work)).toEqual(before)
    // Nothing lands from the head the queue made until CI has passed on it
    expect(writes().filter((w) => w[0] === 'merge')).toEqual([])
    patchGh((s) => {
      Object.assign(s.prs['77'], { headRefOid: tip, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })
      s.checks[tip] = green('2026-10-17T09:00:00Z')
      s.runs[tip] = [ghRun('success', 1, tip)]
    })
    await until((x) => stateOf(x) === 'merged', 'the new head to land')
    expect(writes().find((w) => w[0] === 'merge')![2]).toEqual(expect.arrayContaining(['--match-head-commit', tip]))
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
    // Every step recorded with how long it took, for the daily metrics
    const steps = conflictSteps()
    expect(steps.map((e) => e.step)).toEqual(['merge', 'regenerate', 'push', 'fixed'])
    for (const e of steps) expect(typeof e.ms === 'number' && e.ms >= 0, JSON.stringify(e)).toBe(true)
    expect(steps[0]).toMatchObject({ files: ['docs/generated/schema.md', 'pnpm-lock.yaml'], notify: false })
    expect(steps[1]).toMatchObject({
      stat: [
        { file: 'docs/generated/schema.md', added: 1, removed: 1 },
        { file: 'pnpm-lock.yaml', added: 1, removed: 1 },
      ],
    })
    expect(steps[1].text).toContain('against main: docs/generated/schema.md +1 -1, pnpm-lock.yaml +1 -1.')
    expect(steps.find((e) => e.step === 'fixed')).toMatchObject({ by: 'queue' })
    expect(queueTmps()).toEqual([])
  })

  it('hands a conflict in code to the author session, once, with the exact instruction, and pushes nothing', async () => {
    const repo = conflictRepo({ 77: ['pnpm-lock.yaml', 'src/app.ts'] })
    const before = untouched(repo.work)
    conflictRuntime(repo, [77])
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
    expect(q.queue[0].reason).toMatchObject({ kind: 'conflict', files: ['pnpm-lock.yaml', 'src/app.ts'], relay: { to: 'writer', branch: 'feat/b77' } })
    await morePolls()
    expect(tipOf(repo, 77)).toBe(repo.heads[77])
    // Its worktree, its registration and the refs it fetched are gone on this path too
    expect(untouched(repo.work)).toEqual(before)
    expect(queueTmps()).toEqual([])
    const told = notices().filter((e) => e.kind === 'attention')
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain("src/app.ts is not on project.json's list of mechanical files (queue.conflicts.mechanical)")
    expect(told[0]!.text).toContain('Author session: writer. Relay this to it (it has not called this app, so the queue has no address to post to): "Merge main into feat/b77 and push again; conflicted files: pnpm-lock.yaml, src/app.ts."')
    expect((told[0] as any).relay).toEqual({ to: 'writer', branch: 'feat/b77', text: 'Merge main into feat/b77 and push again; conflicted files: pnpm-lock.yaml, src/app.ts.', route: 'relay' })
    expect(conflictSteps().map((e) => [e.step, e.by ?? null])).toEqual([
      ['merge', null],
      ['handoff', 'session'],
    ])
    // The author fixes it and pushes: the queue takes the new head, says the conflict is fixed, and lands it
    patchGh((s) => {
      Object.assign(s.prs['77'], { headRefOid: SHA2, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })
      s.checks[SHA2] = green('2026-10-17T09:00:00Z')
      s.runs[SHA2] = [ghRun('success', 1, SHA2)]
    })
    await until((x) => stateOf(x) === 'merged', 'the fixed head to land')
    expect(conflictSteps().at(-1)).toMatchObject({ step: 'fixed', by: 'session' })
  })

  it('lists a pull request fixed after a conflict and queued again first, before one queued before it', async () => {
    const repo = conflictRepo({ 77: ['src/app.ts'] })
    conflictRuntime(repo, [77])
    // Queued first, its own CI running
    patchGh((s) => {
      s.prs['78'] = ghPr(78, { headRefOid: SHA })
      s.checks[SHA] = [ghCheck('verify', null, 11)]
      s.runs[SHA] = [ghRun(null)]
    })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await until((x) => stateOf(x, 77) === 'attention', 'the hand-off')
    // The author pushes a fix, and it is queued again: first in line, not behind the one queued before it
    patchGh((s) => {
      Object.assign(s.prs['77'], { headRefOid: SHA2, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })
      s.checks[SHA2] = [ghCheck('verify', null, 11)]
      s.runs[SHA2] = [ghRun(null, 1, SHA2)]
    })
    await call('queue_merge', { pr: 77 })
    const q = await until((x) => stateOf(x, 77) === 'ci' && stateOf(x, 78) === 'ci', 'both in CI')
    expect(q.queue.map((i: any) => i.pr)).toEqual([77, 78])
    expect(q.queue[0].front).toEqual(expect.any(String))
    expect(q.queue[1].front).toBeNull()
  })

  // #1182 review: the queue only ever adds to the head it read, so it never replaces a commit somebody else pushed
  it('merges nothing into a branch that is not at the head GitHub reported, and pushes nothing over it', async () => {
    const repo = conflictRepo({ 77: ['pnpm-lock.yaml'] })
    // The author pushed again; GitHub has not caught up and still reports the old head as DIRTY
    const theirs = authorCommit(repo, 77)
    g(repo.work, 'push', '-q', 'origin', `${theirs}:refs/heads/feat/b77`)
    conflictRuntime(repo, [77])
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await morePolls(3)
    expect(tipOf(repo, 77)).toBe(theirs)
    expect(conflictSteps()).toEqual([])
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
    expect(stateOf((await call('merge_queue')).data)).toBe('waiting')
  })

  it('never forces its push: when the author pushes while it regenerates, git refuses the queue, which says nothing and takes their head', async () => {
    const repo = conflictRepo({ 77: ['pnpm-lock.yaml'] })
    const theirs = authorCommit(repo, 77)
    conflictRuntime(repo, [77], { lists: testLists('push', [repo.work, theirs, 'feat/b77']) })
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await until(() => conflictSteps().some((e) => e.step === 'superseded'), 'the refused push')
    // A forced push would have put the queue's merge over the author's commit
    expect(tipOf(repo, 77)).toBe(theirs)
    expect(conflictSteps().map((e) => e.step)).toEqual(['merge', 'regenerate', 'superseded'])
    expect(conflictSteps()[2]).toMatchObject({ tip: theirs })
    // GitHub still reports the old head for a while: no hand-off, no second try on it
    await morePolls(3)
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
    expect(conflictSteps()).toHaveLength(3)
    // GitHub shows the author's head: the queue goes on with it
    patchGh((s) => {
      Object.assign(s.prs['77'], { headRefOid: theirs, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' })
      s.checks[theirs] = green('2026-10-17T09:00:00Z')
      s.runs[theirs] = [ghRun('success', 1, theirs)]
    })
    await until((x) => stateOf(x) === 'merged', 'the author head to land')
    expect(writes().find((w) => w[0] === 'merge')![2]).toEqual(expect.arrayContaining(['--match-head-commit', theirs]))
    expect(conflictSteps().at(-1)).toMatchObject({ step: 'fixed', by: 'session' })
  })

  it('hands off a pull request GitHub calls DIRTY when main is merged into it already, instead of waiting for ever', async () => {
    const repo = conflictRepo({ 77: ['pnpm-lock.yaml'] })
    // A branch that has main in it already
    const ahead = g(repo.work, 'commit-tree', `${repo.main}^{tree}`, '-p', repo.main, '-m', 'on top of main')
    g(repo.work, 'push', '-q', 'origin', `+${ahead}:refs/heads/feat/b77`)
    repo.heads[77] = ahead
    conflictRuntime(repo, [77])
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
    expect(q.queue[0].reason.kind).toBe('conflict')
    expect(q.queue[0].reason.text).toContain(`GitHub says it conflicts, but main at ${repo.main.slice(0, 7)} is already merged into feat/b77, so the queue has nothing to push.`)
    expect(tipOf(repo, 77)).toBe(ahead)
  })

  it("links the checkout's node_modules and installs nothing when the lockfile is main's, workspace packages from the merged tree", async () => {
    const repo = conflictRepo({ 77: ['docs/generated/schema.md'] }, { base: WORKSPACE, branch: { 'packages/q/v.txt': 'branch\n' } })
    installCheckout(repo)
    const before = untouched(repo.work)
    const pnpmCalls = fakePnpm()
    conflictRuntime(repo, [77], { lists: modulesLists() })
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await until(() => conflictSteps().some((e) => e.step === 'push'), 'the merge to be pushed')
    // The outside package from the checkout, the workspace package as merged (the branch's, not the checkout's)
    expect(g(repo.origin, 'show', `${tipOf(repo, 77)}:docs/generated/schema.md`)).toBe('ext=from the checkout ws=branch')
    expect(pnpmCalls()).toEqual([])
    expect(conflictSteps().find((e) => e.step === 'regenerate')).toMatchObject({ modules: 'linked' })
    // Removing the worktree followed none of its links into the checkout
    expect(readFileSync(join(repo.work, 'node_modules/marker/x.txt'), 'utf8')).toBe('from the checkout\n')
    expect(readFileSync(join(repo.work, 'packages/q/v.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(repo.work, 'packages/p/node_modules/ws'))).toBe(true)
    expect(untouched(repo.work)).toEqual(before)
    expect(queueTmps()).toEqual([])
  })

  it('installs with --ignore-scripts, and links nothing, when the lockfile is not main\'s', async () => {
    const repo = conflictRepo({ 77: ['docs/generated/schema.md'] }, { base: WORKSPACE, branch: { 'pnpm-lock.yaml': 'lock v2\n' } })
    installCheckout(repo)
    const pnpmCalls = fakePnpm()
    conflictRuntime(repo, [77], { lists: modulesLists() })
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await until(() => conflictSteps().some((e) => e.step === 'push'), 'the merge to be pushed')
    expect(pnpmCalls()).toEqual([['install', '--frozen-lockfile', '--ignore-scripts']])
    expect(g(repo.origin, 'show', `${tipOf(repo, 77)}:docs/generated/schema.md`)).toBe('ext=installed ws=none')
    expect(conflictSteps().find((e) => e.step === 'regenerate')).toMatchObject({ modules: 'installed' })
    expect(readFileSync(join(repo.work, 'node_modules/marker/x.txt'), 'utf8')).toBe('from the checkout\n')
    expect(queueTmps()).toEqual([])
  })

  it('hands off a regeneration that fails, and leaves no worktree, registration or ref, sweeping those a killed run left', async () => {
    const repo = conflictRepo({ 77: ['pnpm-lock.yaml'] }, { base: { '.gitignore': 'node_modules\n' } })
    installCheckout(repo)
    const before = untouched(repo.work)
    // What a run killed half way left: a folder of an ended process, with a link into the checkout's
    // node_modules as a run that linked them leaves it, and one still registered as a worktree
    mkdirSync(join(appTmp(), 'centralu-queue-merge-999999999-left'), { recursive: true })
    writeFileSync(join(appTmp(), 'centralu-queue-merge-999999999-left', 'x'), 'x')
    symlinkSync(join(repo.work, 'node_modules'), join(appTmp(), 'centralu-queue-merge-999999999-left', 'node_modules'), 'junction')
    g(repo.work, 'worktree', 'add', '-q', '--detach', join(appTmp(), 'centralu-queue-merge-999999998-left'), repo.main)
    // git's own removal of a worktree follows a junction on Windows: this one must be unlinked first
    symlinkSync(join(repo.work, 'node_modules'), join(appTmp(), 'centralu-queue-merge-999999998-left', 'node_modules'), 'junction')
    g(repo.work, 'update-ref', 'refs/centralu-queue/0', repo.main)
    conflictRuntime(repo, [77], { lists: testLists('fail') })
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
    expect(q.queue[0].reason.text).toContain('could not regenerate pnpm-lock.yaml:')
    expect(q.queue[0].reason.text).toContain('failed (exit 1): regeneration broke. It pushed nothing.')
    expect(tipOf(repo, 77)).toBe(repo.heads[77])
    expect(untouched(repo.work)).toEqual(before)
    expect(queueTmps()).toEqual([])
    // The sweep removed the left link, not what it pointed at
    expect(readFileSync(join(repo.work, 'node_modules/marker/x.txt'), 'utf8')).toBe('from the checkout\n')
  })

  describe('a conflict in the lint allowlists only (#1423)', () => {
    const LIST = 'tooling/lint-allowlist/packages-agent-host.txt'
    /** A list that did not conflict, which `lint:tighten` lowers too when it is there */
    const OTHER = 'tooling/lint-allowlist/packages-ui.txt'
    /**
     * A `pnpm` on the app's PATH standing for the board's real commands: `lint:tighten` records the list it was given
     * (main's version) and lowers it; the allowlist check (`exec vitest run …`) fails when `allowlist-check-fails` is there.
     */
    function lintPnpm(checkFails: boolean) {
      const calls = join(root, 'pnpm-calls.jsonl')
      if (checkFails) writeFileSync(join(root, 'allowlist-check-fails'), 'x')
      fakeExe(
        fake.bin,
        'pnpm',
        [
          "const fs = require('fs')",
          `const rec = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + '\\n')`,
          'const args = process.argv.slice(2)',
          `if (args[0] === 'lint:tighten') {`,
          `  rec({ args, list: fs.readFileSync(${JSON.stringify(LIST)}, 'utf8'), base: process.env.CC_LINT_BASE })`,
          `  fs.writeFileSync(${JSON.stringify(LIST)}, 'tightened\\n')`,
          `  if (fs.existsSync(${JSON.stringify(OTHER)})) fs.writeFileSync(${JSON.stringify(OTHER)}, 'lowered\\n')`,
          `} else if (args[0] === 'exec') {`,
          `  rec({ args, list: fs.readFileSync(${JSON.stringify(LIST)}, 'utf8'), base: process.env.CC_LINT_BASE })`,
          `  if (fs.existsSync(${JSON.stringify(join(root, 'allowlist-check-fails'))})) { process.stderr.write('allowlist check failed: a line is higher than main\\n'); process.exit(1) }`,
          '} else rec({ args })',
        ].join('\n'),
      )
      return () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    }

    it("takes main's list, lowers it, runs the allowlist check, and pushes the merge once it passes", async () => {
      const repo = conflictRepo({ 77: [LIST] }, { base: { [OTHER]: 'file 1\n' } })
      const before = untouched(repo.work)
      const pnpmCalls = lintPnpm(false)
      // The board's own lists, so the commands are the configured ones
      conflictRuntime(repo, [77], { lists: JSON.stringify(LISTS) })
      await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
      await until(() => conflictSteps().some((e) => e.step === 'push'), 'the merge to be pushed')
      expect(pnpmCalls().map((c) => c.args.join(' '))).toEqual(['install --frozen-lockfile --ignore-scripts', 'lint:tighten', 'exec vitest run tooling/type-aware-lint.test.ts'])
      // lint:tighten started from main's version, not the branch's, and the check ran on what it wrote
      expect(pnpmCalls()[1].list).toBe('main moved\n')
      expect(pnpmCalls()[2].list).toBe('tightened\n')
      // The check compares with the main tip the queue just fetched, whatever refs the checkout has
      expect(pnpmCalls().slice(1).map((c) => c.base)).toEqual([repo.main, repo.main])
      const tip = tipOf(repo, 77)
      expect(g(repo.origin, 'show', `${tip}:${LIST}`)).toBe('tightened')
      // A list that did not conflict, lowered by lint:tighten, is in the commit and shown with the rest
      expect(g(repo.origin, 'show', `${tip}:${OTHER}`)).toBe('lowered')
      expect(g(repo.origin, 'log', '-1', '--format=%b', tip)).toContain(`The commands also changed ${OTHER}, which did not conflict.`)
      expect(g(repo.origin, 'log', '-1', '--format=%b', tip)).toContain(`${OTHER} +1 -1`)
      expect(conflictSteps().find((e) => e.step === 'regenerate')).toMatchObject({ files: [LIST], also: [OTHER] })
      expect(g(repo.origin, 'rev-list', '--parents', '-n', '1', tip).split(' ').slice(1)).toEqual([repo.heads[77], repo.main])
      expect(untouched(repo.work)).toEqual(before)
      expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
      expect(conflictSteps().map((e) => e.step)).toEqual(['merge', 'regenerate', 'push'])
      expect(queueTmps()).toEqual([])
    })

    it('hands the conflict to the author, pushing nothing, when the allowlist check fails', async () => {
      const repo = conflictRepo({ 77: [LIST] })
      const before = untouched(repo.work)
      const pnpmCalls = lintPnpm(true)
      conflictRuntime(repo, [77], { lists: JSON.stringify(LISTS) })
      await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
      const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
      expect(pnpmCalls().map((c) => c.args[0])).toEqual(['install', 'lint:tighten', 'exec'])
      expect(q.queue[0].reason).toMatchObject({ kind: 'conflict', files: [LIST], relay: { to: 'writer', branch: 'feat/b77' } })
      expect(q.queue[0].reason.text).toContain('failed (exit 1): allowlist check failed')
      expect(q.queue[0].reason.text).toContain('It pushed nothing.')
      await morePolls()
      expect(tipOf(repo, 77)).toBe(repo.heads[77])
      expect(untouched(repo.work)).toEqual(before)
      expect(queueTmps()).toEqual([])
      expect(notices().filter((e) => e.kind === 'attention')).toHaveLength(1)
    })

    it('hands a conflict in an allowlist and in code to the author without running anything', async () => {
      const repo = conflictRepo({ 77: [LIST, 'src/app.ts'] })
      const pnpmCalls = lintPnpm(false)
      conflictRuntime(repo, [77], { lists: JSON.stringify(LISTS) })
      await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
      const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
      expect(q.queue[0].reason.text).toContain("src/app.ts is not on project.json's list of mechanical files")
      expect(pnpmCalls()).toEqual([])
      expect(tipOf(repo, 77)).toBe(repo.heads[77])
    })
  })

  it('hands off a conflict in the UX baseline or a store migration step even beside mechanical files, and says when no author session is recorded', async () => {
    const repo = conflictRepo({ 77: ['e2e/ux/baseline.json', 'pnpm-lock.yaml'], 78: [MIGRATION, 'packages/agent-host/src/dev-services/store-migrations.golden.json'] })
    conflictRuntime(repo, [77, 78])
    await call('queue_merge', { pr: 77, owner: 'tester', author: 'writer' })
    await call('queue_merge', { pr: 78 })
    const q = await until((x) => stateOf(x, 77) === 'attention' && stateOf(x, 78) === 'attention', 'both hand-offs')
    expect(q.queue.map((i: any) => i.reason.kind)).toEqual(['conflict', 'conflict'])
    expect([tipOf(repo, 77), tipOf(repo, 78)]).toEqual([repo.heads[77], repo.heads[78]])
    const text = (pr: number) => notices().find((e: any) => e.kind === 'attention' && e.pr === pr)!.text
    expect(text(77)).toContain('e2e/ux/baseline.json is never regenerated (project.json queue.conflicts.never)')
    expect(text(78)).toContain(`${MIGRATION} is never regenerated (project.json queue.conflicts.never)`)
    expect(text(78)).toContain('No author session is recorded for #78 (queue_merge author). Start a session on its branch feat/b78 with this instruction: "Merge main into feat/b78 and push again; conflicted files: ')
  })
})

