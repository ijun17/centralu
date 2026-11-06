import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitWrapper } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { SLOW } from './test-timing.js'
import { g, GIT_ENV, githubStandIn } from './git-fixture.test-helpers.js'
// @ts-expect-error — plain .mjs of a Centralu app
import { attributeByPaths, carried, cleanGreen, earlierFlakes, mainVerdict, nextStep, passedAfterBlame, sortCommits } from '../.centralu/apps/project-board/main-guard.mjs'
import { REPO_ROOT, R, SHA, ghCheck, ghRun, ghPr, type Gh, ghState, appRef, root, rt, fake, IDLE_SERVER, NO_TIERS, FAST_LAND, runtime, call, gh, patchGh, writes, ghCalls, filesNamed, queueFile, queueOnDisk, notices, until, polls, stateOf, short2, watch, seedQueue, landed, itemsOnDisk, appTmp, forgetApp } from './project-board-queue.test-helpers.js'

describe('agents find the board tool for the gh command they would type', { timeout: 60_000 * SLOW }, () => {
  it('names the gh command each tool replaces in its description, and help lists only tools that exist, the same text every time', async () => {
    runtime(ghState())
    const tools = await rt!.tools(appRef)
    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? ''
    const expected: Record<string, string> = {
      queue_merge: 'gh pr merge and gh run rerun',
      integrate: 'Instead of open_pr and queue_merge (gh pr create, gh pr merge)',
      merge_queue: 'Instead of gh pr list / gh run list',
      rebase_stack: 'Instead of git rebase --onto',
      ci_status: 'Instead of gh pr checks',
      read_failed_job: 'Instead of gh run view --log-failed',
      open_pr: 'Instead of gh pr create',
      comment: 'Instead of gh pr comment / gh issue comment',
      file_issue: 'Instead of gh issue create',
      release: 'Instead of gh release create',
    }
    for (const [name, words] of Object.entries(expected)) expect(description(name), name).toContain(words)
    const first = await call('help')
    expect(first.isError).toBe(false)
    expect((await call('help')).text).toBe(first.text)
    const named = new Set([...first.text.matchAll(/\b([a-z]+(?:_[a-z]+)+|help|comment|release)\b/g)].map((m) => m[1]!))
    const names = new Set(tools.map((t) => t.name))
    expect([...named].filter((n) => !names.has(n))).toEqual([])
    for (const n of ['queue_merge', 'rebase_stack', 'ci_status', 'read_failed_job', 'open_pr', 'comment', 'file_issue', 'release']) expect(named.has(n), n).toBe(true)
    // An auto-tier change goes to integrate, by its name (#1259 step 3)
    expect(first.text).toContain('hand it over with integrate')
  })
})

describe('the watch command: the queuing session hears about its items', { timeout: 60_000 * SLOW }, () => {
  it('drives the queue while the app is stopped, and exits 3 with the attention message for its owner only', async () => {
    // This app's server polls only at its start here, so the watch command is what drives the queue
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY' }), '78': ghPr(78, { mergeStateStatus: 'DIRTY' }) } }), IDLE_SERVER)
    const mine = await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'someone else' })
    // The app goes away (Centralu stops an idle one)
    await rt!.dispose({ awaitTree: true })
    forgetApp()
    const dir = queueFile().replace(/[\\/]merge-queue\.json$/, '')
    expect(mine.data.watch).toContain(dir.includes(' ') ? `"${dir}"` : dir)
    const r = await watch(['watch', '--data', dir, '--owner', 'tester', '--after', String(mine.data.seq)])
    expect(r.code).toBe(3)
    const lines = r.out.trim().split('\n')
    expect(lines[0]).toMatch(/^Merge queue: #77 \(feat\(apps\): change 77\) needs attention: conflict\./)
    expect(r.out).not.toContain('#78')
    // How to acknowledge it, or it stays listed (#1351)
    expect(lines[1]).toMatch(/^Ack it with the board app's ack tool once handled: ack\(\{ owner: "tester", seqs: \[\d+\] \}\)/)
    expect(lines[2]).toBe('1 still queued for tester. To hear about them, run again in the background:')
    // Quoted only where the shell needs it, as queue_merge's own command is
    expect(lines[3]).toMatch(/merge-queue\.mjs"? watch --data "?.+"? --owner tester --after \d+$/)
    // Its lease is let go: the next driver need not wait for it
    expect(filesNamed(dir, 'merge-queue.lease.json')).toEqual([])
  })

  it('exits 0 with the merge, and 6 when nothing happens before its deadline', async () => {
    runtime(ghState(), IDLE_SERVER)
    const q = await call('queue_merge', { pr: 77, owner: 'tester' })
    await rt!.dispose({ awaitTree: true })
    forgetApp()
    const dir = queueFile().replace(/[\\/]merge-queue\.json$/, '')
    const r = await watch(['watch', '--data', dir, '--owner', 'tester', '--after', String(q.data.seq)])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Merge queue: merged #77')
    expect(r.out).toContain('Nothing left queued.')
    expect(writes().filter((w) => w[0] === 'merge')).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'merge')[0]![2]).toEqual(expect.arrayContaining(['--match-head-commit', SHA]))

    patchGh((s) => (s.prs['78'] = ghPr(78)))
    patchGh((s) => (s.checks[SHA] = [ghCheck('verify', null, 11)]))
    runtime(undefined, IDLE_SERVER)
    const p = await call('queue_merge', { pr: 78, owner: 'tester' })
    await rt!.dispose({ awaitTree: true })
    forgetApp()
    const quiet = await watch(['watch', '--data', dir, '--owner', 'tester', '--after', String(p.data.seq), '--minutes', '0.01'])
    expect(quiet.code).toBe(6)
    expect(quiet.out).toContain('No news in 0.01 minutes.')
    expect((await watch(['watch'])).code).toBe(2)
  })
})

// --- The main guard (#1259): main's full runs after landing on the fast tier --------------------------

/**
 * Main as the guard finds it: a green commit, then `commits` (each changing its files), the last one red; pushed to a
 * bare repository standing for GitHub's, which the checkout fetches from (as the conflict tests' checkout does).
 */
function mainRepo(commits: { subject: string; files: string[] }[]) {
  const { origin, work } = githubStandIn(root)
  writeFileSync(join(work, 'README.md'), 'base\n')
  g(work, 'add', '-A')
  g(work, 'commit', '-q', '-m', 'green base')
  const green = g(work, 'rev-parse', 'HEAD')
  const shas: string[] = []
  for (const c of commits) {
    for (const f of c.files) {
      mkdirSync(join(work, f, '..'), { recursive: true })
      writeFileSync(join(work, f), `${c.subject}\n`)
    }
    g(work, 'add', '-A')
    g(work, 'commit', '-q', '-m', c.subject)
    shas.push(g(work, 'rev-parse', 'HEAD'))
  }
  g(work, 'push', '-q', 'origin', 'main')
  return { work, origin, green, shas }
}

/** A push run of build.yml on main (`id`, its commit, how it ended), long before any test runs */
const mainRun = (id: number, sha: string, conclusion: string | null) => ({ ...ghRun(conclusion, 1, sha, { id, head_branch: 'main', event: 'push' }), created_at: '2026-10-17T08:00:00Z' })
/** A bisect probe's run, made after the probe started (any time from now on) */
const probeRun = (id: number, sha: string, conclusion: string) => ({ ...ghRun(conclusion, 1, sha, { id, head_branch: `queue/bisect-${sha.slice(0, 12)}`, event: 'workflow_dispatch' }), created_at: '2099-01-01T00:00:00Z' })
const failedJob = (id: number, name: string) => ({ id, name, status: 'completed', conclusion: 'failure', steps: [{ name: 'pnpm test', conclusion: 'failure' }] })


function guardRuntime(repo: ReturnType<typeof mainRepo>, state: Gh, env: Record<string, string> = {}) {
  mkdirSync(appTmp(), { recursive: true })
  const tmp = { TMPDIR: appTmp(), TEMP: appTmp(), TMP: appTmp() }
  return runtime(
    ghState(state),
    {
      ...FAST_LAND,
      PROJECT_BOARD_QUEUE_GUARD: 'on',
      PROJECT_BOARD_QUEUE_GUARD_MS: '50',
      PROJECT_BOARD_QUEUE_CHECKOUT: repo.work,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig'),
      ...tmp,
      ...env,
    },
    gitWrapper(fake.bin),
  )
}
/** The guard's state in the queue file; none before the queue first writes it */
const guardOnDisk = () => (filesNamed(join(root, 'data'), 'merge-queue.json').length ? (queueOnDisk().guard ?? {}) : {})
const issues = (): { title: string; body: string }[] => gh().issues ?? []
const mainRedNotices = () => notices().filter((e) => e.kind === 'main-red') as unknown as { kind: string; text: string; owner: string | null }[]

describe('the main guard finds what broke main after it landed (#1259)', { timeout: 120_000 * SLOW }, () => {
  it("reads every main run: the newest red over an older green, the newest green over an older red, and counts the unfinished", () => {
    const r = (id: number, sha: string, status: string, conclusion: string | null) => ({ id, headSha: sha, status, conclusion })
    expect(mainVerdict([r(4, 'd', 'in_progress', null), r(3, 'c', 'completed', 'failure'), r(2, 'b', 'completed', 'failure'), r(1, 'a', 'completed', 'success')])).toMatchObject({ green: 'a', red: { id: 3 }, unfinished: 1 })
    expect(mainVerdict([r(3, 'c', 'completed', 'success'), r(2, 'b', 'completed', 'failure'), r(1, 'a', 'queued', null)])).toMatchObject({ green: 'c', red: null, unfinished: 1 })
  })

  it('suspects by paths only a commit wholly inside them, the only one touching them; and a suspect is blamed only between a green and a red probe', () => {
    const c = (sha: string, files: string[]) => ({ sha, files })
    const paths = { 'keeper e2e': ['apps/desktop/', 'pnpm-lock.yaml'] }
    expect(attributeByPaths([c('a', ['docs/x.md']), c('b', ['apps/desktop/k.rs'])], ['keeper e2e (linux)'], paths)).toBe('b')
    // It also changed something outside the paths, or another commit touches them too, or a failed job has none: no suspect
    expect(attributeByPaths([c('a', ['docs/x.md']), c('b', ['apps/desktop/k.rs', 'packages/ui/a.ts'])], ['keeper e2e'], paths)).toBe(null)
    expect(attributeByPaths([c('a', ['pnpm-lock.yaml']), c('b', ['apps/desktop/k.rs'])], ['keeper e2e'], paths)).toBe(null)
    expect(attributeByPaths([c('a', ['docs/x.md']), c('b', ['apps/desktop/k.rs'])], ['keeper e2e', 'verify'], paths)).toBe(null)
    const commits = ['a', 'b', 'c', 'd'].map((sha) => c(sha, []))
    const confirm = { index: 2, how: 'by paths' }
    expect(nextStep({ commits, good: -1, bad: 3, confirm })).toMatchObject({ index: 1 })
    expect(nextStep({ commits, good: 1, bad: 3, confirm })).toMatchObject({ index: 2 })
    expect(nextStep({ commits, good: 1, bad: 2, confirm })).toMatchObject({ culprit: commits[2], how: expect.stringContaining('confirmed') })
    expect(nextStep({ commits, good: -1, bad: 1, confirm })).toEqual({ refuted: true })
    expect(nextStep({ commits, good: 2, bad: 3, confirm })).toEqual({ refuted: true })
  })

  it('reads nothing of main while the queue has landed nothing', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    guardRuntime(repo, { branchRuns: { main: [mainRun(990, repo.shas[0]!, 'failure'), mainRun(980, repo.green, 'success')] } })
    await call('merge_queue')
    await polls(6)
    expect(ghCalls().some((a) => a.join(' ').includes('event=push'))).toBe(false)
    expect(issues()).toEqual([])
  })

  it('the only commit since the last green one is the culprit: an issue with the failure, and its session is told once', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', state: 'merged', commit: repo.shas[0], title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, repo.shas[0]!, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      logs: { '31': 'FAIL unit packages/ui/src/a.test.ts > renders\nAssertionError: expected 1 to be 2' },
    })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the issue and the notice')
    expect(issues()[0]!.title).toBe('Main is red since #81 feat(ui): change 81')
    expect(issues()[0]!.body).toContain('the only commit since the last green one')
    expect(issues()[0]!.body).toContain('FAIL unit packages/ui/src/a.test.ts > renders')
    expect(mainRedNotices()).toHaveLength(1)
    expect(mainRedNotices()[0]!.owner).toBe('tester')
    expect(mainRedNotices()[0]!.text).toContain('Merge queue: main went red after #81 (feat(ui): change 81 (#81)) landed: verify failed at')
    // More polls, main still red on that commit: nothing is filed or said again
    await polls(11)
    expect(issues()).toHaveLength(1)
    expect(mainRedNotices()).toHaveLength(1)
    expect(guardOnDisk().hunt).toMatchObject({ red: repo.shas[0], outcome: 'reverting', culprit: { sha: repo.shas[0] } })
    // No bisect: the only candidate needs no probe (a batch for the revert the queue lands is its own run)
    expect((gh().dispatched ?? []).filter((d: { ref: string }) => d.ref.startsWith('queue/bisect-'))).toEqual([])
  })

  /** A probe's branch, and a dispatch of it answered with a finished run on its commit */
  const probe = (sha: string) => `queue/bisect-${sha.slice(0, 12)}`
  const answers = (list: [string, string, number][]) =>
    Object.fromEntries(list.map(([sha, conclusion, id]) => [`dispatch:${probe(sha)}`, { branchRuns: { [probe(sha)]: [probeRun(id, sha, conclusion)] } }]))
  const keeperRepo = () =>
    mainRepo([
      { subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] },
      { subject: 'fix(desktop): change 82 (#82)', files: ['apps/desktop/src-tauri/src/keeper.rs'] },
      { subject: 'docs: change 83 (#83)', files: ['docs/a.md'] },
    ])

  it("suspects the one commit touching the failed job's paths, and blames it only once the full tier passed before it and failed on it", async () => {
    const repo = keeperRepo()
    const [c1, c2] = repo.shas as [string, string, string]
    landed(repo.shas[2]!)
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, repo.shas[2]!, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'keeper e2e (linux)')] },
      on: answers([
        [c1, 'success', 991],
        [c2, 'failure', 992],
      ]),
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the culprit')
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c2, how: expect.stringMatching(/touches the paths of keeper e2e \(linux\), confirmed: the full tier passed on the commit before it and failed on it/) })
    expect(gh().dispatched.map((d: { ref: string }) => d.ref)).toEqual([probe(c1), probe(c2)])
    expect(issues()[0]!.title).toBe('Main is red since #82 fix(desktop): change 82')
  })

  it('bisects when the suspect by paths is refuted: the commit before it failed too', async () => {
    const repo = keeperRepo()
    const [c1] = repo.shas as [string, string, string]
    landed(repo.shas[2]!)
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, repo.shas[2]!, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'keeper e2e (linux)')] },
      on: answers([[c1, 'failure', 991]]),
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the culprit')
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c1, how: expect.stringContaining('bisected') })
    expect(guardOnDisk().hunt.refuted).toContain('touches the paths of keeper e2e (linux)')
    expect(issues()[0]!.title).toBe('Main is red since #81 feat(ui): change 81')
  })

  it("gives up on a bisect whose probe's run does not finish, and says so in the issue", async () => {
    const repo = mainRepo(['81', '82', '83'].map((n) => ({ subject: `feat(apps): change ${n} (#${n})`, files: [`packages/a${n}.ts`] })))
    landed(repo.shas[2]!)
    guardRuntime(
      repo,
      { branchRuns: { main: [mainRun(990, repo.shas[2]!, 'failure'), mainRun(980, repo.green, 'success')] }, jobs: { 990: [failedJob(31, 'verify')] } },
      { PROJECT_BOARD_QUEUE_PROBE_MS: '300' },
    )
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'giving up')
    expect(guardOnDisk().hunt.culprit ?? null).toBe(null)
    expect(issues()[0]!.body).toContain("(a bisect step) had not finished after")
    // The first probe, the middle of three: the first commit
    expect(writes().map(short2)).toContain(`delete ${probe(repo.shas[0]!)}`)
  })

  it("holds landing while more of main's full runs than allowed are unfinished, and lands once they finish", async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    landed(repo.shas[0]!)
    const going = (id: number) => ({ ...mainRun(id, repo.shas[0]!, null), status: 'in_progress' })
    guardRuntime(repo, { branchRuns: { main: [going(994), going(993), going(992), mainRun(980, repo.green, 'success')] } }, { PROJECT_BOARD_QUEUE_MAX_MAIN_RUNS: '2', ...NO_TIERS })
    await call('merge_queue')
    await until(() => guardOnDisk().unfinished === 3, 'the count')
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const held = await call('merge_queue')
    expect(held.text).toContain("Landing held: 3 of main's full runs unfinished (at most 2, #1259).")
    await polls(11)
    expect(writes().map(short2)).not.toContain('merge 77')
    patchGh((s) => (s.branchRuns.main = [going(994), mainRun(993, repo.shas[0]!, 'success'), mainRun(992, repo.shas[0]!, 'success'), mainRun(980, repo.green, 'success')]))
    await until((x) => stateOf(x) === 'merged', 'the landing')
  })

  it('bisects otherwise: the full tier on the middle commit, then on the next, and the culprit is the first that fails', async () => {
    const repo = mainRepo(['81', '82', '83', '84'].map((n) => ({ subject: `feat(apps): change ${n} (#${n})`, files: [`packages/a${n}.ts`] })))
    const [, c2, c3, c4] = repo.shas as [string, string, string, string]
    const probe = (sha: string) => `queue/bisect-${sha.slice(0, 12)}`
    landed(c4)
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, c4, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      on: {
        [`dispatch:${probe(c2)}`]: { branchRuns: { [probe(c2)]: [probeRun(991, c2, 'success')] } },
        [`dispatch:${probe(c3)}`]: { branchRuns: { [probe(c3)]: [probeRun(992, c3, 'failure')] } },
      },
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the bisect')
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c3, how: expect.stringContaining('bisected') })
    expect(gh().dispatched).toEqual([
      { ref: probe(c2), inputs: { tier: 'full' } },
      { ref: probe(c3), inputs: { tier: 'full' } },
    ])
    expect(writes().map(short2)).toEqual(expect.arrayContaining([`branch ${probe(c2)}`, `delete ${probe(c2)}`, `branch ${probe(c3)}`, `delete ${probe(c3)}`]))
    expect(issues()[0]!.title).toBe('Main is red since #83 feat(apps): change 83')
  })

  it('does nothing while main is green, and keeps the app running while main has a run going', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const going = { ...mainRun(990, repo.shas[0]!, null), status: 'in_progress' }
    landed(repo.shas[0]!)
    const r = guardRuntime(repo, { branchRuns: { main: [going, mainRun(980, repo.green, 'success')] } })
    const busy = () => r.list().find((a) => a.appId === 'project-board')?.busy
    await call('merge_queue')
    await until(() => guardOnDisk().green === repo.green && busy() === "main guard, waiting for main's full run", 'the hold')
    patchGh((s) => (s.branchRuns.main = [mainRun(990, repo.shas[0]!, 'success'), mainRun(980, repo.green, 'success')]))
    await until(() => guardOnDisk().green === repo.shas[0] && busy() === undefined, 'green and the release')
    expect(issues()).toEqual([])
  })
})

describe('the main guard reverts what broke main, at the front of the queue (#1259)', { timeout: 120_000 * SLOW }, () => {
  const redOn = (repo: ReturnType<typeof mainRepo>, sha: string) => ({
    branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
    jobs: { 990: [failedJob(31, 'verify')] },
  })

  it('reverts the culprit in a pull request on main, queued at the front for the session that queued it, and says so', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const culprit = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: culprit, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, redOn(repo, culprit))
    // Stopped at the poll that reverts: the next one would read the revert's own CI
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    // The revert: on main's tip, undoing exactly the culprit (its file gone again), and nothing in the checkout moved
    const branch = `revert/${culprit.slice(0, 12)}`
    const tip = g(repo.origin, 'rev-parse', branch)
    expect(g(repo.origin, 'rev-parse', `${tip}^`)).toBe(culprit)
    expect(g(repo.origin, 'rev-parse', `${tip}^{tree}`)).toBe(g(repo.origin, 'rev-parse', `${repo.green}^{tree}`))
    expect(g(repo.work, 'status', '--porcelain')).toBe('')
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([['pr-create', branch, 'revert: feat(ui): change 81']])
    const item = queueOnDisk().items.find((i: any) => i.pr === 600)
    expect(item).toMatchObject({ state: 'waiting', owner: 'tester', author: 'writer', title: 'revert: feat(ui): change 81' })
    expect(item.front).toBeTruthy()
    expect(mainRedNotices()[0]!.text).toContain('Reverted it in #600, queued at the front of the merge queue; it lands after the fast tier.')
    expect(issues()[0]!.body).toContain('Reverted it in #600')
    expect(guardOnDisk().hunt.revert).toMatchObject({ pr: 600, branch })
  })

  // The release no longer makes a bump commit (#1143), so nothing about a commit's title or files exempts it from the revert
  it('finds a chore(release) commit that changes brand.ts as the culprit and reverts it like any other', async () => {
    const subject = 'chore(release): 1.2.3 (#81)'
    const file = 'packages/protocol/src/brand.ts'
    const repo = mainRepo([{ subject, files: [file] }])
    const culprit = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: culprit, title: subject.replace(/ \(#81\)$/, ''), updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, redOn(repo, culprit))
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    const branch = `revert/${culprit.slice(0, 12)}`
    const tip = g(repo.origin, 'rev-parse', branch)
    expect(g(repo.origin, 'rev-parse', `${tip}^`)).toBe(culprit)
    // The green tree is restored
    expect(g(repo.origin, 'rev-parse', `${tip}^{tree}`)).toBe(g(repo.origin, 'rev-parse', `${repo.green}^{tree}`))
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([['pr-create', branch, `revert: ${subject.replace(/ \(#81\)$/, '')}`]])
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: culprit })
    expect(guardOnDisk().hunt.revert).toMatchObject({ pr: 600, branch })
    expect(issues()[0]!.body).toContain('Reverted it in #600')
    expect(issues()[0]!.body).not.toContain('release bump')
    expect(mainRedNotices()[0]!.text).not.toContain('release bump')
  })

  it('says to revert by hand when the revert does not apply to main any more, and opens nothing', async () => {
    const repo = mainRepo([
      { subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] },
      { subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/a.ts'] },
    ])
    // Red on #81; #82 landed on it since, changing the same file, its own run still going
    guardRuntime(repo, { ...redOn(repo, repo.shas[0]!), branchRuns: { main: [{ ...mainRun(991, repo.shas[1]!, null), status: 'in_progress' }, mainRun(990, repo.shas[0]!, 'failure'), mainRun(980, repo.green, 'success')] } })
    landedPr(repo.shas[0]!, 81)
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reported', 'the report')
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()[0]!.body).toMatch(/The queue could not revert it: the reverse of [0-9a-f]{7} does not apply to main at/)
    expect(issues()[0]!.body).toContain('Revert it by hand.')
  })
})

/** The queue landed `commit` as #`pr` (the guard watches main once the queue has landed something) */
function landedPr(commit: string, pr = 90) {
  seedQueue([{ repo: R, pr, lowers: [], owner: 'other', state: 'merged', commit, title: `change ${pr}`, updatedAt: new Date().toISOString(), reruns: {} }])
}

/**
 * The log of the e2e (webkit 4/5) job on 2026-10-21 (#1435), as GitHub keeps it: the browser install failed because a package
 * source answered 403, then the artifact upload that runs after a failure complained too, and was the line quoted.
 */
const WEBKIT_INSTALL_LOG = readFileSync(join(REPO_ROOT, 'tooling/fixtures/ci-log-webkit-install-403.txt'), 'utf8')
/** The artifact upload of `macos tests` on 2026-11-03 (job 125945853592): it kept the test times, and GitHub's artifact service could not be reached */
const UPLOAD_ENOTFOUND_LOG = readFileSync(join(REPO_ROOT, 'tooling/fixtures/ci-log-artifact-upload-enotfound.txt'), 'utf8')

describe("the main guard does not revert a commit for the runner's own failure (#1435)", { timeout: 120_000 * SLOW }, () => {
  /** e2e (webkit 4/5) as it ended on 2026-10-21: the browser install failed, the test step never ran, the upload that runs after a failure failed too */
  const webkitJob = (id: number) => ({
    id,
    name: 'e2e (webkit 4/5)',
    status: 'completed',
    conclusion: 'failure',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', conclusion: 'success' },
      { name: 'Run pnpm install --frozen-lockfile', conclusion: 'success' },
      { name: 'Install WebKit', conclusion: 'failure' },
      { name: 'pnpm e2e (shard 4/5)', conclusion: 'skipped' },
      { name: 'Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', conclusion: 'failure' },
    ],
  })
  const secondAttempt = (sha: string, conclusion: string) => ({ ...mainRun(990, sha, conclusion), run_attempt: 2 })
  const quoted = 'E: Failed to fetch https://packages.microsoft.com/ubuntu/24.04/prod/dists/noble/InRelease 403 Forbidden [IP: 13.107.246.40 443]'
  /** Main red on `sha`'s run 990, a setup failure; `rerun` is what GitHub shows once the job was rerun */
  const redInSetup = (repo: ReturnType<typeof mainRepo>, sha: string, rerun: Gh) => ({
    branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
    jobs: { 990: [webkitJob(31)] },
    logs: { '31': WEBKIT_INSTALL_LOG },
    on: { 'rerun-failed:990': rerun },
  })
  const reruns = () => writes().filter((w) => w[0] === 'rerun-failed')

  // 2026-11-03: every test step of `macos tests` passed; only the artifact upload that keeps the test times failed ("Failed to
  // FinalizeArtifact ... ENOTFOUND"). It was read as a test failure: the only commit since the last green one was blamed and a revert opened.
  // The job is rerun first, as for any failure; the commit was hunted when the upload failed again (here one that changed the lockfile, which a failed setup step would hunt).
  it('reports a job whose only failed step is the upload that keeps the test times, failing again after the rerun, and reverts nothing', async () => {
    const repo = mainRepo([{ subject: 'chore(deps): bump a package (#81)', files: ['pnpm-lock.yaml'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    const ok = (name: string) => ({ name, conclusion: 'success' })
    const macosJob = {
      id: 33,
      name: 'macos tests',
      status: 'completed',
      conclusion: 'failure',
      steps: [
        ok('Set up job'),
        ok('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'),
        ok('Run ./.github/actions/setup'),
        ok('Run pnpm install --frozen-lockfile'),
        ok('Say which Node runs the tests'),
        { name: 'pnpm test (the tests that touch the OS)', conclusion: 'skipped' },
        ok('pnpm test (host, protocol, launcher)'),
        ok('Say which test files took longest'),
        { name: 'Upload the test times', conclusion: 'failure' },
        ok('Post Run ./.github/actions/setup'),
        ok('Post Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'),
        ok('Complete job'),
      ],
    }
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [macosJob] },
      logs: { '33': UPLOAD_ENOTFOUND_LOG },
      on: { 'rerun-failed:990': { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await polls(11)
    expect(reruns()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(queueOnDisk().items.filter((i: any) => i.state !== 'merged')).toEqual([])
    expect(issues()[0]!.title).toBe(`Main is red at ${sha.slice(0, 7)}: an infrastructure failure, not reverted`)
    expect(issues()[0]!.body).toContain('The step that failed first: "Upload the test times"')
    expect(guardOnDisk().hunt).toMatchObject({ red: sha, kind: 'infrastructure', outcome: 'reported' })
  })

  it('reports an infrastructure failure that fails the same way again, once, quoting the step that failed first, and reverts nothing', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, redInSetup(repo, sha, { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } }))
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await polls(11)
    expect(reruns()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(queueOnDisk().items.filter((i: any) => i.state !== 'merged')).toEqual([])
    expect(issues()).toHaveLength(1)
    expect(issues()[0]!.title).toBe(`Main is red at ${sha.slice(0, 7)}: an infrastructure failure, not reverted`)
    expect(issues()[0]!.body).toContain('Kind of failure: **infrastructure failure**')
    expect(issues()[0]!.body).toContain('The step that failed first: "Install WebKit"')
    // The first error line of the step that failed first, not the artifact upload's "No files were found"
    expect(issues()[0]!.body).toContain(quoted)
    expect(issues()[0]!.body).not.toContain('No files were found')
    expect(issues()[0]!.body).toContain('failed the same way again after one rerun. None of the 1 commit since the last green one changed what the setup installs')
    expect(issues()[0]!.body).toContain('Nothing was reverted')
    expect(mainRedNotices()).toHaveLength(1)
    expect(mainRedNotices()[0]!.text).toContain('an infrastructure failure, not a commit')
    expect(mainRedNotices()[0]!.text).toContain('e2e (webkit 4/5) failed at')
    expect(mainRedNotices()[0]!.text).toContain('(infrastructure failure)')
    expect(mainRedNotices()[0]!.text).not.toContain('No files were found')
    expect(guardOnDisk().hunt).toMatchObject({ red: sha, kind: 'infrastructure', step: 'Install WebKit', outcome: 'reported' })
  })

  it('reverts the culprit, saying it is a test failure, when the rerun fails inside the test steps', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    const testFailure = { id: 32, name: 'e2e (webkit 4/5)', status: 'completed', conclusion: 'failure', steps: webkitJob(32).steps.map((s) => (s.name === 'Install WebKit' ? { ...s, conclusion: 'success' } : s.name === 'pnpm e2e (shard 4/5)' ? { ...s, conclusion: 'failure' } : s)) }
    guardRuntime(repo, {
      ...redInSetup(repo, sha, { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] }, jobs: { 990: [testFailure] }, logs: { '32': '##[group]Run pnpm e2e\nFAIL e2e/a.spec.ts > opens\nError: expected 1 to be 2\n##[error]Process completed with exit code 1.' } }),
    })
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    expect(reruns()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'pr-create')).toHaveLength(1)
    expect(issues()[0]!.title).toBe('Main is red since #81 feat(ui): change 81')
    expect(issues()[0]!.body).toContain('Kind of failure: **test failure**')
    expect(mainRedNotices()[0]!.text).toContain('e2e (webkit 4/5) failed at')
    expect(mainRedNotices()[0]!.text).toContain('(test failure)')
    expect(guardOnDisk().hunt).toMatchObject({ kind: 'test', outcome: 'reverting' })
  })

  // #1503: three e2e shards ran out of time inside `playwright install` (a slow mirror). GitHub ends the job 'cancelled' and writes
  // the reason only in its annotation, which the guard did not read for a cancelled job, so the second one looked like a plain
  // cancel and was hunted like a test failure
  const outOfTime = (id: number, inStep: string) => ({
    ...webkitJob(id),
    conclusion: 'cancelled',
    steps: webkitJob(id).steps.map((s) => (s.name === inStep ? { ...s, conclusion: 'cancelled' } : s.name === 'Install WebKit' ? { ...s, conclusion: 'success' } : s.name.startsWith('Run actions/upload') ? { ...s, conclusion: 'skipped' } : s)),
  })
  // #1507: the runner shut down under a job's tests; only the log says so. The first time it is the runner's, and the job is rerun.
  const SHUTDOWN_FIXTURE = readFileSync(join(REPO_ROOT, 'tooling/fixtures/ci-log-runner-shutdown.txt'), 'utf8')
  const cutShort = (id: number, name: string) => ({ id, name, status: 'completed', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'pnpm e2e (shard 1/5)', conclusion: 'failure' }] })

  it('hunts and reverts the commit when the runner is shut down under the same job again after the rerun: it can be the commit that exhausts the runner', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [cutShort(31, 'e2e (chromium 1/5)')] },
      annotations: { '31': [{ message: 'The operation was canceled.' }] },
      logs: { '31': SHUTDOWN_FIXTURE },
      on: { 'rerun-failed:990': { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    // Once: the first shutdown is the runner's, the second on the same job is looked into as a test failure
    expect(reruns()).toEqual([['rerun-failed', '990']])
    expect(writes().filter((w) => w[0] === 'pr-create')).toHaveLength(1)
    expect(guardOnDisk().hunt).toMatchObject({ red: sha, kind: 'test', cause: 'runner', outcome: 'reverting' })
    // The quote is the shutdown, not a test the shutdown cut short
    expect(JSON.stringify(guardOnDisk().hunt)).not.toContain('archive.spec.ts')
  })

  it('only reports a shutdown that hits another job on the rerun: it is not the same job failing again, and nothing is reverted', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }, { subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/b.ts'] }])
    const sha = repo.shas[1]!
    seedQueue([{ repo: R, pr: 82, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 82', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [cutShort(31, 'e2e (chromium 1/5)')] },
      annotations: { '31': [{ message: 'The operation was canceled.' }], '32': [{ message: 'The operation was canceled.' }] },
      logs: { '31': SHUTDOWN_FIXTURE, '32': SHUTDOWN_FIXTURE },
      on: { 'rerun-failed:990': { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] }, jobs: { 990: [cutShort(32, 'e2e (chromium 2/5)')] } } },
    })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await polls(11)
    expect(reruns()).toEqual([['rerun-failed', '990']])
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()).toHaveLength(1)
    expect(issues()[0]!.title).toBe(`Main is red at ${sha.slice(0, 7)}: an infrastructure failure, not reverted`)
    expect(issues()[0]!.body).toContain('a lost runner')
    expect(issues()[0]!.body).not.toContain('archive.spec.ts')
    expect(guardOnDisk().hunt).toMatchObject({ red: sha, kind: 'infrastructure', cause: 'runner', outcome: 'reported' })
  })

  const limitNote = { '31': [{ message: 'The job has exceeded the maximum execution time of 15 minutes.' }] }

  it('reruns a job that ran out of time in the browser install once, then reports it and reverts nothing when no commit changed what the setup installs', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    const stalled = outOfTime(31, 'Install WebKit')
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [stalled] },
      annotations: limitNote,
      logs: { '31': '##[group]Run pnpm exec playwright install --with-deps webkit\nGet:97 http://azure.archive.ubuntu.com/ubuntu noble/universe amd64 freepats all 20060219-4build1 [5400 kB]' },
      on: { 'rerun-failed:990': { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await polls(11)
    expect(reruns()).toEqual([['rerun-failed', '990']])
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(queueOnDisk().items.filter((i: any) => i.state !== 'merged')).toEqual([])
    expect(issues()).toHaveLength(1)
    expect(issues()[0]!.title).toBe(`Main is red at ${sha.slice(0, 7)}: an infrastructure failure, not reverted`)
    expect(issues()[0]!.body).toContain('Kind of failure: **infrastructure failure**')
    expect(issues()[0]!.body).toContain('step "Install WebKit" in e2e (webkit 4/5): a job that hit its timeout')
    expect(issues()[0]!.body).toContain('Nothing was reverted')
    expect(guardOnDisk().hunt).toMatchObject({ red: sha, kind: 'infrastructure', cause: 'timeout', step: 'Install WebKit', outcome: 'reported' })
  })

  it('hunts the commit that changed what the setup installs when the install runs out of time again after a rerun (a change that makes it hang)', async () => {
    const repo = mainRepo([{ subject: 'ci: add a system library (#81)', files: ['.github/workflows/build.yml'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'ci: add a system library', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [outOfTime(31, 'Install WebKit')] },
      annotations: limitNote,
      logs: { '31': '##[group]Run pnpm exec playwright install --with-deps webkit\nGet:97 http://azure.archive.ubuntu.com/ubuntu noble/universe amd64 freepats all 20060219-4build1 [5400 kB]' },
      on: { 'rerun-failed:990': { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    expect(reruns()).toHaveLength(1)
    expect(guardOnDisk().hunt).toMatchObject({ kind: 'setup', touched: [sha.slice(0, 7)], step: 'Install WebKit', outcome: 'reverting' })
  })

  it('still hunts and reverts a commit when the job ran out of time in the tests, after one rerun', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    const hung = outOfTime(31, 'pnpm e2e (shard 4/5)')
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [hung] },
      annotations: limitNote,
      logs: { '31': '##[group]Run pnpm e2e\n  ✓ e2e/a.spec.ts opens' },
      on: { 'rerun-failed:990': { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    expect(reruns()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'pr-create')).toHaveLength(1)
    expect(guardOnDisk().hunt).toMatchObject({ kind: 'test', outcome: 'reverting' })
  })

  /** The install step failing for a reason of the commit's, not the network: a package that is not there */
  const UNKNOWN_PACKAGE_LOG = [
    '2026-10-21T04:11:03.5000000Z ##[group]Run pnpm exec playwright install --with-deps webkit',
    '2026-10-21T04:11:03.5300000Z ##[endgroup]',
    '2026-10-21T04:11:07.9000000Z E: Unable to locate package libwebkit-nope',
    '2026-10-21T04:11:08.0000000Z Failed to install browsers',
    '2026-10-21T04:11:08.0200000Z ##[error]Process completed with exit code 1.',
    '2026-10-21T04:11:08.6000000Z ##[error]No files were found with the provided path: blob-report. No artifacts will be uploaded.',
  ].join('\n')

  it('hunts a commit that changed what the setup installs when the setup fails again for a reason that is not the network, and says it is a setup failure', async () => {
    const repo = mainRepo([{ subject: 'build(deps): bump playwright (#81)', files: ['pnpm-lock.yaml'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'build(deps): bump playwright', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, { ...redInSetup(repo, sha, { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } }), logs: { '31': UNKNOWN_PACKAGE_LOG } })
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    expect(reruns()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'pr-create')).toHaveLength(1)
    expect(issues()[0]!.body).toContain('Kind of failure: **setup failure, after a rerun**')
    expect(issues()[0]!.body).toContain(`changed what it installs: ${sha.slice(0, 7)}`)
    expect(issues()[0]!.body).toContain('E: Unable to locate package libwebkit-nope')
    expect(mainRedNotices()[0]!.text).toContain('(setup failure, after a rerun)')
    expect(guardOnDisk().hunt).toMatchObject({ kind: 'setup', step: 'Install WebKit', touched: [sha.slice(0, 7)] })
  })

  it('reads every line of the failing step for the network, not only its first error line (warnings come first in a real outage)', async () => {
    const repo = mainRepo([{ subject: 'build(deps): bump playwright (#81)', files: ['pnpm-lock.yaml'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'build(deps): bump playwright', updatedAt: new Date().toISOString(), reruns: {} }])
    const log = [
      '2026-10-21T04:11:03.5000000Z ##[group]Run pnpm exec playwright install --with-deps webkit',
      '2026-10-21T04:11:03.5300000Z ##[endgroup]',
      '2026-10-21T04:11:06.0000000Z W: Could not connect to archive.ubuntu.com:80 (91.189.91.82), connection timed out',
      '2026-10-21T04:11:07.9000000Z E: Unable to locate package libwebkit2gtk-4.1-0',
      '2026-10-21T04:11:08.0000000Z Failed to install browsers',
      '2026-10-21T04:11:08.0200000Z ##[error]Process completed with exit code 1.',
    ].join('\n')
    guardRuntime(repo, { ...redInSetup(repo, sha, { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } }), logs: { '31': log } })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await polls(11)
    // The first error line is "E: Unable to locate package": only the warning before it says the network
    expect(issues()[0]!.body).toContain('E: Unable to locate package')
    expect(issues()[0]!.body).toContain('Its failing step names the network or a package source')
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
  })

  it('blames no commit for a setup failure that names the network, whatever the commits since the last green one changed (the 2026-10-21 403)', async () => {
    const repo = mainRepo([{ subject: 'build(deps): bump playwright (#81)', files: ['pnpm-lock.yaml'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'build(deps): bump playwright', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, redInSetup(repo, sha, { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } }))
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await polls(11)
    expect(reruns()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()[0]!.title).toBe(`Main is red at ${sha.slice(0, 7)}: an infrastructure failure, not reverted`)
    expect(issues()[0]!.body).toContain(`Its failing step names the network or a package source, so none of the 1 commit that changed what the setup installs (${sha.slice(0, 7)}) is blamed`)
    expect(queueOnDisk().items.filter((i: any) => i.state !== 'merged')).toEqual([])
  })

  it('does not rerun two overlapping red runs for each other for ever: each run is rerun once, then reported', async () => {
    const repo = mainRepo([
      { subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] },
      { subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/b.ts'] },
    ])
    const [s1, s2] = repo.shas as [string, string]
    landedPr(s2, 82)
    const at = (id: number, sha: string, conclusion: string | null, attempt: number) => ({ ...mainRun(id, sha, conclusion), run_attempt: attempt, ...(conclusion === null ? { status: 'in_progress' } : {}) })
    const green = mainRun(980, repo.green, 'success')
    // A rerun in progress is not red, so main's newest red is the other run; each rerun then ends red again
    guardRuntime(repo, {
      branchRuns: { main: [at(991, s2, 'failure', 1), at(990, s1, 'failure', 1), green] },
      jobs: { 990: [webkitJob(31)], 991: [webkitJob(32)] },
      logs: { '31': WEBKIT_INSTALL_LOG, '32': WEBKIT_INSTALL_LOG },
      on: {
        'rerun-failed:991': { branchRuns: { main: [at(991, s2, null, 2), at(990, s1, 'failure', 1), green] } },
        'rerun-failed:990': { branchRuns: { main: [at(991, s2, 'failure', 2), at(990, s1, null, 2), green] } },
      },
    })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await polls(16)
    expect(reruns().map((w) => w[1]).sort()).toEqual(['990', '991'])
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(Object.keys(guardOnDisk().reruns).sort()).toEqual(['990', '991'])
  })

  it('reports it, and reverts nothing, when GitHub refuses to rerun the job', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, { ...redInSetup(repo, sha, {}), rerunError: 'Unable to retry this workflow run because it was created over a month ago (HTTP 403)' })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    expect(issues()[0]!.body).toContain('GitHub refused to rerun the job')
    expect(issues()[0]!.title).toBe(`Main is red at ${sha.slice(0, 7)}: an infrastructure failure, not reverted`)
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(mainRedNotices()).toHaveLength(1)
  })

  it('reports it, and reverts nothing, when the rerun has not started after the time allowed', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    // GitHub took the request and showed nothing new: the run stays at its first attempt
    guardRuntime(repo, redInSetup(repo, sha, {}), { PROJECT_BOARD_QUEUE_RERUN_STUCK_MS: '300' })
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    expect(reruns()).toHaveLength(1)
    expect(issues()[0]!.body).toMatch(/the rerun asked for at \d\d:\d\d UTC has not started/)
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
  })
})

/*
 * The culprit test runs the guard through three hunts, each poll a burst of processes. Idle it takes 5 s; next to 24 to 48
 * busy loops on 12 cores it took 76 to 176 s (#1571), so 180 s left no margin. The limit is 600 s, about 3.4 times the worst
 * seen; the waits inside end on the poll count, and name their state, long before it.
 */
describe('the main guard with overlapping failures, and when it acts again (#1259 review)', { timeout: 600_000 * SLOW }, () => {
  it('finds a second culprit that landed after the first, probing its commit without the first, and never blames a known one or a revert again', async () => {
    const repo = mainRepo([
      { subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] },
      { subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/b.ts'] },
    ])
    const [a, c] = repo.shas as [string, string]
    seedQueue([
      { repo: R, pr: 81, lowers: [], owner: 'tester', state: 'merged', commit: a, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} },
      { repo: R, pr: 82, lowers: [], owner: 'writer', state: 'merged', commit: c, title: 'feat(ui): change 82', updatedAt: new Date().toISOString(), reruns: {} },
    ])
    const going = { ...mainRun(992, c, null), status: 'in_progress' }
    guardRuntime(repo, {
      origin: repo.origin,
      branchRuns: { main: [going, mainRun(991, a, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 991: [failedJob(31, 'verify')], 992: [failedJob(32, 'verify')] },
      // #82 without #81 still fails: it is a culprit of its own
      probeAnswers: { [`queue/bisect-${c.slice(0, 12)}`]: 'failure' },
    })
    await call('merge_queue')
    // #81's run failed first: the only commit since the last green one, reverted in #600
    await until(() => guardOnDisk().hunt?.culprit?.sha === a && guardOnDisk().hunt?.endedAt, 'the first culprit')
    expect(guardOnDisk().known).toEqual([{ sha: a, subject: 'feat(ui): change 81 (#81)', pr: 600 }])
    // #82's run fails while that is under way: not dropped, the next hunt, with #81 out of the candidates
    patchGh((s) => (s.branchRuns.main = [mainRun(992, c, 'failure'), mainRun(991, a, 'failure'), mainRun(980, repo.green, 'success')]))
    await until(() => guardOnDisk().hunt?.red === c && guardOnDisk().hunt?.endedAt, 'the second culprit')
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c, how: expect.stringContaining('bisected') })
    // Its commit was probed without #81: a commit on #82 with #81's change taken out
    const probeBranch = `queue/bisect-${c.slice(0, 12)}`
    const probed = g(repo.origin, 'rev-parse', probeBranch)
    expect(g(repo.origin, 'rev-parse', `${probed}^`)).toBe(c)
    expect(spawnSync('git', ['cat-file', '-e', `${probed}:packages/ui/src/a.ts`], { cwd: repo.origin, env: GIT_ENV }).status).not.toBe(0)
    expect(g(repo.origin, 'show', `${probed}:packages/ui/src/b.ts`)).toBe('feat(ui): change 82 (#82)')
    expect(writes().filter((w) => w[0] === 'pr-create').map((w) => w[2])).toEqual(['revert: feat(ui): change 81', 'revert: feat(ui): change 82'])
    expect(issues().map((i) => i.title)).toEqual(['Main is red since #81 feat(ui): change 81', 'Main is red since #82 feat(ui): change 82'])

    // #81's revert lands, and main is red on it (as #82 still is): nothing is left but known culprits and their reverts
    g(repo.work, 'revert', '--no-edit', a)
    g(repo.work, 'commit', '-q', '--amend', '-m', 'revert: feat(ui): change 81 (#600)')
    const rv = g(repo.work, 'rev-parse', 'HEAD')
    g(repo.work, 'push', '-q', 'origin', 'main')
    patchGh((s) => (s.branchRuns.main = [mainRun(993, rv, 'failure'), mainRun(992, c, 'failure'), mainRun(991, a, 'failure'), mainRun(980, repo.green, 'success')]))
    await until(() => guardOnDisk().hunt?.red === rv && guardOnDisk().hunt?.endedAt, 'the third red')
    expect(guardOnDisk().hunt.outcome).toBe('explained')
    await polls(6)
    expect(issues()).toHaveLength(2)
    expect(writes().filter((w) => w[0] === 'pr-create')).toHaveLength(2)
  })

  it('acts again without a second revert or issue: a revert branch and pull request an earlier try made are used as they are', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const culprit = repo.shas[0]!
    const branch = `revert/${culprit.slice(0, 12)}`
    // An earlier try pushed the revert and opened #640, then stopped before the issue
    g(repo.work, 'checkout', '-q', '-b', 'earlier', culprit)
    g(repo.work, 'revert', '--no-edit', culprit)
    const earlier = g(repo.work, 'rev-parse', 'HEAD')
    g(repo.work, 'push', '-q', 'origin', `${earlier}:refs/heads/${branch}`)
    landed(culprit)
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, culprit, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      prs: { '77': ghPr(77), '640': ghPr(640, { headRefName: branch, headRefOid: earlier, title: 'revert: feat(ui): change 81' }) },
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the act')
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()).toHaveLength(1)
    expect(guardOnDisk().hunt.revert).toMatchObject({ pr: 640, branch })
    expect(queueOnDisk().items.find((i: any) => i.pr === 640)).toMatchObject({ state: expect.any(String), front: expect.any(String) })
    expect(g(repo.origin, 'rev-parse', branch)).toBe(earlier)
  })

  it('keeps known culprits and their reverts out of the candidates, and knows what a commit still carries', () => {
    const c = (sha: string, subject: string) => ({ sha, subject, files: [] })
    const listed = [c('a', 'feat: a (#81)'), c('b', 'feat: b (#82)'), c('r', 'revert: feat: a (#600)'), c('d', 'feat: d (#83)')]
    const known = [{ sha: 'a', subject: 'feat: a (#81)', pr: 600 }]
    const { all, commits } = sortCommits(listed, known)
    expect(commits.map((x: { sha: string }) => x.sha)).toEqual(['b', 'd'])
    // b landed after a and before its revert: it carries a; d is after the revert: it does not
    expect(carried(all, known, 1)).toEqual(['a'])
    expect(carried(all, known, 3)).toEqual([])
    // Not reverted at all (a release bump, say): every later commit carries it
    expect(carried(all, [{ sha: 'a', subject: '', pr: null }], 3)).toEqual(['a'])
  })
})

// --- The integrator (#1259 step 3): an auto-tier branch lands without its session opening a pull request ------

/**
 * Main as GitHub has it, with this repository's judge and rules (scripts/tier.mjs, .centralu/tiers.json) and a doc,
 * and `branches` made from it, each adding or changing its files; pushed to a bare repository standing for GitHub's,
 * which the queue's checkout fetches from. The checkout itself is left on a branch of its own with work not committed.
 */

describe('the main guard does not blame a commit for a bisect probe the runner broke (#1453)', { timeout: 120_000 * SLOW }, () => {
  const probe = (sha: string) => `queue/bisect-${sha.slice(0, 12)}`
  const installFailure = (id: number) => ({
    id,
    name: 'e2e (webkit 4/5)',
    status: 'completed',
    conclusion: 'failure',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Install WebKit', conclusion: 'failure' },
      { name: 'pnpm e2e (shard 4/5)', conclusion: 'skipped' },
    ],
  })
  const attempt2 = (sha: string, conclusion: string) => ({ ...probeRun(991, sha, conclusion), run_attempt: 2 })
  const rerunsOf = () => writes().filter((w) => w[0] === 'rerun-failed')
  const setup = (second: string) => {
    const repo = mainRepo(['81', '82', '83', '84'].map((n) => ({ subject: `feat(apps): change ${n} (#${n})`, files: [`packages/a${n}.ts`] })))
    const [, c2, c3, c4] = repo.shas as [string, string, string, string]
    landed(c4)
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, c4, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')], 991: [installFailure(41)] },
      logs: { '41': WEBKIT_INSTALL_LOG },
      on: {
        [`dispatch:${probe(c2)}`]: { branchRuns: { [probe(c2)]: [probeRun(991, c2, 'failure')] } },
        'rerun-failed:991': { branchRuns: { [probe(c2)]: [attempt2(c2, second)] } },
        [`dispatch:${probe(c3)}`]: { branchRuns: { [probe(c3)]: [probeRun(992, c3, 'failure')] }, jobs: { 992: [failedJob(42, 'verify')] } },
      },
    })
    return { c2, c3 }
  }

  it('ends the hunt with an issue and no revert when a probe fails in Install WebKit twice', async () => {
    const { c2 } = setup('failure')
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt && issues().length > 0, 'the report', 60_000)
    await polls(11)
    // Main's own red run (a test failure) is rerun first, then the probe's
    expect(rerunsOf()).toEqual([['rerun-failed', '990'], ['rerun-failed', '991']])
    expect(guardOnDisk().hunt.culprit).toBeUndefined()
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()).toHaveLength(1)
    expect(issues()[0]!.body).toContain(`the full tier's run on ${c2.slice(0, 7)} (a bisect step) failed in`)
    expect(issues()[0]!.body).toContain('the same way again after one rerun')
    expect(gh().dispatched).toEqual([{ ref: probe(c2), inputs: { tier: 'full' } }])
  })

  it('keeps a probe red that times out in a test step, so a commit that makes a test hang is still found', async () => {
    const repo = mainRepo(['81', '82', '83', '84'].map((n) => ({ subject: String.raw`feat(apps): change ${n} (#${n})`, files: [`packages/a${n}.ts`] })))
    const [c1, c2, , c4] = repo.shas as [string, string, string, string]
    landed(c4)
    const hang = { id: 41, name: 'verify', status: 'completed', conclusion: 'timed_out', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run pnpm verify', conclusion: 'cancelled' }] }
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, c4, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')], 991: [hang] },
      on: {
        [`dispatch:${probe(c2)}`]: { branchRuns: { [probe(c2)]: [probeRun(991, c2, 'timed_out')] } },
        [`dispatch:${probe(c1)}`]: { branchRuns: { [probe(c1)]: [probeRun(992, c1, 'success')] } },
      },
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the bisect', 60_000)
    // Main's own red run (a test failure) is rerun; the probe is not
    expect(rerunsOf()).toEqual([['rerun-failed', '990']])
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c2 })
  })

  it('reads the rerun of a probe that passes, and goes on bisecting; a probe that fails in a test step is red', async () => {
    const { c3 } = setup('success')
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the bisect', 60_000)
    expect(rerunsOf()).toEqual([['rerun-failed', '990'], ['rerun-failed', '991']])
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c3, how: expect.stringContaining('bisected') })
  })
})

/*
 * A red is a run whose failed jobs fail again when only they are rerun (#1496). On 2026-10-23 a flaky test failed once on a
 * commit that did not touch it, the hunt bisected a pass on the commit before and that one failure, and the queue opened a revert
 * of reviewed work. Main's red run is rerun once, and a pass makes it green. A failure that keeps passing its rerun is a break
 * after all (it fails now and then, or the rerun finds what the first attempt left behind), and a probe that fails in a test is red
 * on that failure: one that had to fail twice would be passed over for a break that fails half of its runs.
 */
describe('the main guard blames a commit only for a test that fails again on a rerun (#1496)', { timeout: 120_000 * SLOW }, () => {
  const again = (id: number, sha: string, conclusion: string, probeBranch?: string) => ({ ...(probeBranch ? probeRun(id, sha, conclusion) : mainRun(id, sha, conclusion)), run_attempt: 2 })
  const flakyLog = 'FAIL unit tooling/fake-gh.test.ts > the shared fake gh > reads the state whole while the fake is rewriting it\nAssertionError: expected [ \'Unexpected end of JSON input\' ] to deeply equal []'
  const reruns = () => writes().filter((w) => w[0] === 'rerun-failed')
  const comments = (): { issue: number; body: string }[] => gh().comments ?? []

  it("leaves main alone when the failed job passes on its rerun, and says on the known failures issue, once, that it was intermittent", async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }, { subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/b.ts'] }])
    const sha = repo.shas[1]!
    seedQueue([{ repo: R, pr: 82, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 82', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      logs: { '31': flakyLog },
      on: { 'rerun-failed:990': { branchRuns: { main: [again(990, sha, 'success'), mainRun(980, repo.green, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => guardOnDisk().green === sha && comments().length > 0, 'main green again, and the note')
    await polls(11)
    expect(reruns()).toEqual([['rerun-failed', '990']])
    // No hunt, no probe, no revert, no issue, nothing told to the session that landed it
    expect(gh().dispatched ?? []).toEqual([])
    expect(writes().filter((w) => w[0] === 'pr-create' || w[0] === 'issue')).toEqual([])
    expect(issues()).toEqual([])
    expect(mainRedNotices()).toEqual([])
    expect(guardOnDisk().hunt ?? null).toBe(null)
    expect(comments()).toHaveLength(1)
    expect(comments()[0]).toMatchObject({ issue: 368, body: expect.stringContaining(`Intermittent failure: verify failed on main at ${sha.slice(0, 7)}`) })
    expect(comments()[0]!.body).toContain('reads the state whole while the fake is rewriting it')
    expect(comments()[0]!.body).toContain('nothing was reverted')
  })

  it('goes on to find the culprit when the failed job fails again, rerunning it once and no more', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }, { subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/b.ts'] }])
    const [c1, c2] = repo.shas as [string, string]
    landed(c2)
    const probe = (sha: string) => `queue/bisect-${sha.slice(0, 12)}`
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, c2, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      logs: { '31': flakyLog },
      on: { [`dispatch:${probe(c1)}`]: { branchRuns: { [probe(c1)]: [probeRun(991, c1, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the culprit')
    expect(reruns()).toEqual([['rerun-failed', '990']])
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c2 })
    expect(comments()).toEqual([])
  })

  it('keeps a bisect probe red on its first test failure, without a rerun: a break that fails half the time must not be passed over', async () => {
    const repo = mainRepo(['81', '82', '83', '84'].map((n) => ({ subject: `feat(apps): change ${n} (#${n})`, files: [`packages/a${n}.ts`] })))
    const [, c2, , c4] = repo.shas as [string, string, string, string]
    const probe = (sha: string) => `queue/bisect-${sha.slice(0, 12)}`
    landed(c4)
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, c4, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')], 991: [failedJob(41, 'verify')], 992: [failedJob(42, 'verify')] },
      on: {
        [`dispatch:${probe(c2)}`]: { branchRuns: { [probe(c2)]: [probeRun(991, c2, 'failure')] } },
        [`dispatch:${probe(repo.shas[0]!)}`]: { branchRuns: { [probe(repo.shas[0]!)]: [probeRun(992, repo.shas[0]!, 'success')] } },
      },
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the culprit')
    // Main's own red run is rerun once and fails again; neither probe is rerun
    expect(reruns()).toEqual([['rerun-failed', '990']])
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c2, how: expect.stringContaining('bisected') })
  })

  // A flake the guard marked: the run's record in `guard.reruns`, as `noteFlakes` leaves it once the rerun passed
  const marked = (sha: string, line: string) => ({ attempt: 1, at: '2026-10-17T08:00:00Z', what: 'x', shutdown: false, jobs: ['verify'], test: true, sha, url: null, line, flaked: true })
  const line = flakyLog.split('\n')[0]!

  it('hunts a failure that passed its rerun twice lately, from before the first of them, without another rerun, and says so', async () => {
    const repo = mainRepo(['81', '82', '83'].map((n) => ({ subject: `feat(apps): change ${n} (#${n})`, files: [`packages/a${n}.ts`] })))
    const [c1, c2, c3] = repo.shas as [string, string, string]
    const probe = (sha: string) => `queue/bisect-${sha.slice(0, 12)}`
    landed(c3, { reruns: { '985': marked(c2, line), '975': marked(c1, line) } })
    guardRuntime(repo, {
      // Runs 985 and 975 failed, passed their reruns, and are green now: the last run that never failed is the base
      branchRuns: { main: [mainRun(990, c3, 'failure'), mainRun(985, c2, 'success'), mainRun(975, c1, 'success'), mainRun(970, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')], 991: [failedJob(41, 'verify')], 992: [failedJob(42, 'verify')] },
      logs: { '31': flakyLog },
      on: {
        // The red commit itself first: it fails again, so the failure is bisected
        [`dispatch:${probe(c3)}`]: { branchRuns: { [probe(c3)]: [probeRun(992, c3, 'failure')] } },
        [`dispatch:${probe(c1)}`]: { branchRuns: { [probe(c1)]: [probeRun(991, c1, 'failure')] } },
      },
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt && issues().length > 0, 'the culprit')
    expect(reruns()).toEqual([])
    // The two flakes are spent on this hunt: the next failure of the test is counted from one
    expect(Object.values(guardOnDisk().reruns).map((r: any) => r.counted)).toEqual([true, true])
    // The first commit of the three, not the last one alone (the range started at the green run 985 would have blamed #83)
    expect(guardOnDisk().hunt.culprit).toMatchObject({ sha: c1, how: expect.stringContaining('bisected') })
    expect(guardOnDisk().hunt.green).toBe(repo.green)
    expect(issues()[0]!.body).toContain('The same test failed 3 times on main within its last 20 runs')
  })

  it('reports a test failure whose rerun failed in setup as neither confirmed nor cleared, and hunts nothing', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    const installFailure = { id: 41, name: 'verify', status: 'completed', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Install WebKit', conclusion: 'failure' }, { name: 'pnpm test', conclusion: 'skipped' }] }
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      logs: { '31': flakyLog, '41': WEBKIT_INSTALL_LOG },
      // The rerun's attempt fails in a step that sets the job up, before any test ran
      on: { 'rerun-failed:990': { branchRuns: { main: [again(990, sha, 'failure'), mainRun(980, repo.green, 'success')] }, jobs: { 990: [installFailure] } } },
    })
    await call('merge_queue')
    await until(() => issues().length > 0, 'the report')
    expect(reruns()).toEqual([['rerun-failed', '990']])
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(guardOnDisk().hunt.culprit).toBeUndefined()
    expect(issues()[0]!.body).toContain('neither confirmed nor cleared')
    expect(issues()[0]!.body).toContain(line)
    expect(issues()[0]!.body).toContain('Nothing was reverted')
  })

  it('runs the red commit itself before blaming a failure that was counted, and blames nothing when it passes', async () => {
    const repo = mainRepo(['81', '82', '83'].map((n) => ({ subject: `feat(apps): change ${n} (#${n})`, files: [`packages/a${n}.ts`] })))
    const [c1, c2, c3] = repo.shas as [string, string, string]
    const probe = (sha: string) => `queue/bisect-${sha.slice(0, 12)}`
    landed(c3, { reruns: { '985': marked(c2, line), '975': marked(c1, line) } })
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, c3, 'failure'), mainRun(985, c2, 'success'), mainRun(975, c1, 'success'), mainRun(970, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      logs: { '31': flakyLog },
      on: { [`dispatch:${probe(c3)}`]: { branchRuns: { [probe(c3)]: [probeRun(991, c3, 'success')] } } },
    })
    await call('merge_queue')
    await until(() => !!guardOnDisk().hunt?.endedAt && issues().length > 0, 'the report')
    // Only the red commit was run: no bisect, no culprit, no revert
    expect(gh().dispatched).toHaveLength(1)
    expect(guardOnDisk().hunt.culprit).toBeUndefined()
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()[0]!.body).toContain('it is intermittent')
    expect(issues()[0]!.body).toContain('No commit is blamed')
  })

  it('counts a failure only by the test it names, and by the whole of its name', () => {
    const runs = Array.from({ length: 25 }, (_, i) => ({ id: 1000 - i }))
    const flake = (text: string, extra = {}) => ({ flaked: true, jobs: ['verify'], line: text, ...extra })
    const earlier = (reruns: Record<string, unknown>, text: string) => earlierFlakes({ reruns, runs, names: ['verify'], line: ` First failure: ${text}` })
    const same = 'FAIL unit tooling/a.test.ts > waits 5s for the lock'
    expect(earlier({ 999: flake(`${same} 120ms`) }, `${same} 133ms`)).toEqual(['999'])
    // Another test whose name has a duration in it is another test
    expect(earlier({ 999: flake('FAIL unit tooling/a.test.ts > waits 5s for the other 120ms') }, `${same} 133ms`)).toEqual([])
    // A step's bare error names no test: two of them are not the same failure
    const bare = 'Process completed with exit code 1.'
    expect(earlier({ 999: flake(bare), 998: flake(bare) }, bare)).toEqual([])
    // A flake a hunt has counted is spent
    expect(earlier({ 999: flake(same, { counted: true }), 998: flake(same) }, same)).toEqual(['998'])
    // Only the newest 20 of main's runs count: 981 is the 20th, 980 is outside
    expect(earlier({ 981: flake(same) }, same)).toEqual(['981'])
    expect(earlier({ 980: flake(same) }, same)).toEqual([])
  })

  it('starts the hunt at the newest clean green run older than the window, else the oldest one', () => {
    const run = (id: number, conclusion = 'success') => ({ id, status: 'completed', conclusion, headSha: `sha${id}` })
    const runs = Array.from({ length: 24 }, (_, i) => run(1000 - i))
    // Runs 980 and older are outside the 20 newest; 979 passed after a rerun, so it is not clean
    expect(cleanGreen({ runs, reruns: { 980: { flaked: true } } })).toBe('sha979')
    expect(cleanGreen({ runs, reruns: {} })).toBe('sha980')
    // A list no longer than the window: its oldest clean run
    expect(cleanGreen({ runs: runs.slice(0, 5), reruns: {} })).toBe('sha996')
    expect(cleanGreen({ runs: [run(1, 'failure')], reruns: {} })).toBeNull()
  })

  it('reports a failure it could not confirm, and reverts nothing, when GitHub refuses the rerun', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      rerunError: 'Unable to retry this workflow run because it was created over a month ago (HTTP 403)',
    })
    await call('merge_queue')
    await until(() => issues().length > 0, 'the report')
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()[0]!.body).toContain('it is a test failure')
    expect(issues()[0]!.body).toContain('GitHub refused to rerun the job')
    expect(issues()[0]!.body).toContain('Nothing was reverted')
  })
})


describe("the main guard takes back its revert and issue when the run it blamed passes on a rerun (#2082)", { timeout: 120_000 * SLOW }, () => {
  const rerunPassed = (id: number, sha: string, attempt: number) => ({ ...mainRun(id, sha, 'success'), run_attempt: attempt })
  const stateOfIssue = (n: number) => (gh().issueStates ?? {})[n]
  const closes = () => writes().filter((w) => w[0] === 'close')
  const mainGreenNotices = () => notices().filter((e) => e.kind === 'main-green')

  /** A guard that blamed #82, the only commit since the last green one (its rerun failed too), reverted it in #600 and filed #501; the guard is then waiting for the next run */
  async function blamed() {
    const repo = mainRepo([{ subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/b.ts'] }])
    const c2 = repo.shas[0]!
    seedQueue([{ repo: R, pr: 82, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: c2, title: 'feat(ui): change 82', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, {
      branchRuns: { main: [mainRun(990, c2, 'failure'), mainRun(980, repo.green, 'success')] },
      jobs: { 990: [failedJob(31, 'verify')] },
      logs: { '31': 'FAIL unit tooling/a.test.ts > a test' },
    })
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    return { repo, c2 }
  }

  it('closes the revert (out of the queue first) and the issue, each with the reason, and tells the session that queued the commit', async () => {
    const { repo, c2 } = await blamed()
    expect(guardOnDisk().hunt).toMatchObject({ run: 990, attempt: 2, issue: 501, revert: { pr: 600 } })
    // A person reruns the run; the same job passes
    patchGh((s) => (s.branchRuns = { main: [rerunPassed(990, c2, 3), mainRun(980, repo.green, 'success')] }))
    await until(() => !!guardOnDisk().hunt?.retracted?.done || guardOnDisk().hunt === null, 'the retraction')
    await polls(8)
    // Closed once each, with the reason; the revert is gone from the queue and was never announced as closed without merging
    expect(closes()).toEqual([['close', '600', expect.stringContaining('passed when its jobs were run again (attempt 3)')]])
    expect(stateOfIssue(501)).toEqual({ state: 'closed', state_reason: 'not_planned' })
    expect(gh().comments.filter((c: { issue: number }) => c.issue === 501)).toHaveLength(1)
    expect(gh().comments.find((c: { issue: number }) => c.issue === 501).body).toContain('the failure was intermittent')
    expect(itemsOnDisk().some((i: { pr: number }) => i.pr === 600)).toBe(false)
    expect(notices().filter((e) => e.kind === 'closed')).toEqual([])
    // The session that queued it hears that main is green: once
    expect(mainGreenNotices()).toHaveLength(1)
    expect(mainGreenNotices()[0]).toMatchObject({ owner: 'tester', text: expect.stringContaining(`main is green again at ${c2.slice(0, 7)}`) })
    expect(guardOnDisk().hunt ?? null).toBe(null)
    expect(guardOnDisk().green).toBe(c2)
  })

  it('leaves a revert that already landed alone, and only comments on the issue, which stays open', async () => {
    const { repo, c2 } = await blamed()
    patchGh((s) => {
      s.prs['600'].state = 'MERGED'
      s.branchRuns = { main: [rerunPassed(990, c2, 3), mainRun(980, repo.green, 'success')] }
    })
    const onIssue = () => (gh().comments ?? []).filter((c: { issue: number }) => c.issue === 501)
    await until(() => onIssue().length > 0, 'the comment')
    await polls(8)
    expect(closes()).toEqual([])
    expect(stateOfIssue(501)).toBeUndefined()
    expect(onIssue()).toHaveLength(1)
    expect(onIssue()[0].body).toContain('had already landed')
  })

  it('closes nothing while the run is still failing, when only a newer run passed, or when the red run is another one', async () => {
    const { repo, c2 } = await blamed()
    const hunt = guardOnDisk().hunt
    // A newer run passing says nothing about the run that was blamed: the commit may be what it fixed
    patchGh((s) => (s.branchRuns = { main: [mainRun(995, 'a'.repeat(40), 'success'), mainRun(990, c2, 'failure'), mainRun(980, repo.green, 'success')] }))
    await polls(10)
    expect(closes()).toEqual([])
    expect(stateOfIssue(501)).toBeUndefined()
    expect(mainGreenNotices()).toEqual([])
    const run = (over: object) => ({ id: 990, status: 'completed', conclusion: 'success', attempt: 3, ...over })
    expect(passedAfterBlame({ hunt, runs: [run({ conclusion: 'failure' })] })).toBeNull()
    expect(passedAfterBlame({ hunt, runs: [run({ status: 'in_progress', conclusion: null })] })).toBeNull()
    expect(passedAfterBlame({ hunt, runs: [run({ attempt: 2 })] })).toBeNull()
    expect(passedAfterBlame({ hunt, runs: [run({ id: 991 })] })).toBeNull()
    expect(passedAfterBlame({ hunt: { ...hunt, retracted: { done: 'x' } }, runs: [run({})] })).toBeNull()
    expect(passedAfterBlame({ hunt: { ...hunt, endedAt: undefined }, runs: [run({})] })).toBeNull()
    expect(passedAfterBlame({ hunt, runs: [run({})] })).toMatchObject({ id: 990 })
  })
})
