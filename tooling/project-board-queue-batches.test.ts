import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitWrapper, removeFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { fakeBrokerHost } from '../packages/agent-host/src/apps/external/test-helpers.js'
// @ts-expect-error — plain .mjs of a Centralu app
import { acknowledge, dueReposts, markReposted, noticeText, unacked, watchStart } from '../.centralu/apps/project-board/notice-acks.mjs'
import { SLOW } from './test-timing.js'
import { g, githubStandIn } from './git-fixture.test-helpers.js'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { emptyQueue, pushEvent, quickLanded, normalize, watchState } from '../.centralu/apps/project-board/queue.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { evaluateChecks } from '../.centralu/apps/project-board/ci.mjs'
import { REPO_ROOT, R, SHA, SHA2, A, B, C, type Row, check, NOW, ghCheck, ghRun, ghPr, type Gh, ghState, root, rt, fake, IDLE_SERVER, TIERS, NO_BATCH, FAST_LAND, REAL_QUICK, runtime, call, gh, patchGh, writes, queueFile, queueOnDisk, notices, until, polls, stateOf, morePolls, suiteCheck, ownRun, ownChecks, BATCH_HEAD, batchRun, batchChecks, batchState, batchesOnDisk, batchEvents, short2, watch, seedQueue, itemsOnDisk, appTmp, forgetApp } from './project-board-queue.test-helpers.js'

describe('the merge queue batches pull requests waiting for CI into one run (#962)', { timeout: 240_000 * SLOW }, () => {
  it('builds queue/batch-1 from main, runs CI on it once, cancels their own waiting runs, and lands each in order on the tested tree', async () => {
    runtime(batchState())
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'merged', 'both to land')
    await until(() => batchesOnDisk()[0]?.state === 'done', 'the batch to end')
    expect(writes().map(short2)).toEqual([
      'branch queue/batch-1',
      `merge-into ${A}`,
      `merge-into ${B}`,
      'dispatch queue/batch-1',
      'cancel 901',
      'cancel 902',
      `status ${A}`,
      'merge 77',
      'delete feat/b77',
      `status ${B}`,
      'merge 78',
      'delete feat/b78',
      'delete queue/batch-1',
    ])
    // The branch starts at main, each head is merged into it, and CI runs on the branch
    expect(writes()[0]).toEqual(['branch', 'queue/batch-1', 'main0'])
    expect(writes()[1]).toEqual(['merge-into', A, 'queue/batch-1'])
    // Each lands as its own squash on the head the batch tested, and says where it was tested
    const merges = writes().filter((w) => w[0] === 'merge')
    expect(merges[0]![2]).toEqual(expect.arrayContaining(['--squash', '--match-head-commit', A, '--subject', 'feat(apps): change 77 (#77)']))
    expect(merges[1]![2]).toEqual(expect.arrayContaining(['--match-head-commit', B]))
    expect(writes().find((w) => w[0] === 'status')).toEqual(['status', A, 'success', 'merge-queue', 'Passed CI in queue/batch-1 with #78'])
    expect(notices().map((e) => e.text)).toEqual([
      'Merge queue: merged #77 (feat(apps): change 77) as abcdef1, "feat(apps): change 77 (#77)". Tested in batch queue/batch-1 with #78.',
      'Merge queue: merged #78 (feat(apps): change 78) as abcdef1, "feat(apps): change 78 (#78)". Tested in batch queue/batch-1 with #77.',
    ])
    expect(batchEvents().at(-1)).toBe('Batch queue/batch-1: landed #77, #78; main at main-78 is the tree CI tested.')
    // One CI run for the two: no rerun of their own cancelled runs
    expect(writes().filter((w) => w[0].startsWith('rerun'))).toEqual([])
  })

  it('splits a red batch at once, without rerunning a test failure: two go back to their own CI, whose cancelled runs are rerun, and land from there', async () => {
    const landsAlone = (pr: number, head: string, id: number, suite: number) => ({
      runs: { [head]: [ownRun(pr, head, id, suite, 'success', 2)] },
      checks: { [head]: ownChecks(suite, 'success') },
      prs: { [String(pr)]: ghPr(pr, { headRefOid: head, mergeStateStatus: 'CLEAN' }) },
    })
    const base = batchState()
    runtime(
      batchState({
        on: {
          ...base.on,
          'dispatch:queue/batch-1': { runs: { [BATCH_HEAD]: [batchRun('failure')] }, checks: { [BATCH_HEAD]: batchChecks('failure') } },
          'rerun:901': landsAlone(77, A, 901, 5001),
          'rerun:902': landsAlone(78, B, 902, 5002),
        },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'merged', 'both to land on their own')
    const order = writes().map(short2)
    expect(order.slice(0, 6)).toEqual(['branch queue/batch-1', `merge-into ${A}`, `merge-into ${B}`, 'dispatch queue/batch-1', 'cancel 901', 'cancel 902'])
    expect(order).not.toContain('rerun-failed 950')
    expect(order).toContain('delete queue/batch-1')
    expect(order.filter((w) => w.startsWith('rerun ')).sort()).toEqual(['rerun 901', 'rerun 902'])
    // Never landed from the red batch: no batch status on either head
    expect(order.filter((w) => w.startsWith('status'))).toEqual([])
    expect(batchesOnDisk().map((b) => b.state)).toEqual(['failed'])
    expect(batchEvents().some((t) => t.includes('"windows tests" (job 62) failed at batch-b') && t.includes('test or build failure') && t.includes('Split'))).toBe(true)
    // Not batched again on the same heads
    expect(batchesOnDisk()).toHaveLength(1)
  })

  // #1548: main moving is not the member's fault. Without tiers a batch needs two, so the one left cannot be batched again
  // and goes back to its own CI as before, but unmarked; with tiers it is batched again (the tests below)
  it('stops landing when main is not the tree the batch had before the next one, and sends that one back to its own CI without blaming it', async () => {
    runtime(batchState({ mainDrift: true }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'stopped', 'the batch to stop')
    await until(() => writes().some((w) => short2(w) === 'rerun 902'), "#78's own run to be rerun")
    const order = writes().map(short2)
    expect(order).toContain('merge 77')
    expect(order).not.toContain('merge 78')
    expect(order).not.toContain(`status ${B}`)
    expect(batchEvents()).toContain('Batch queue/batch-1: stopped before #78: main is not the tree the batch had before #78 (something else landed) (#77 landed). That is no fault of #78: it is tested again on the new main.')
    expect(batchEvents().at(-1)).toBe('Batch queue/batch-1: #78 goes on with its own CI. Too few are left to form a batch.')
    const q = await call('merge_queue', { all: true })
    expect(q.data.queue.find((i: any) => i.pr === 78)).toMatchObject({ state: 'ci', batch: null })
    // Not blamed: not kept out of a batch on its head, and no message to its session
    expect(queueOnDisk().items.find((i: any) => i.pr === 78).batchless).toBeUndefined()
    expect(queueOnDisk().items.find((i: any) => i.pr === 78).alone).toBeUndefined()
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
  })

  it('makes no batch for an hour when CI cannot be started on it, and cancels none of their own runs', async () => {
    runtime(batchState({ dispatchError: "Workflow does not have 'workflow_dispatch' trigger (HTTP 422)" }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped')
    await morePolls(4)
    expect(writes().map(short2)).toEqual(['branch queue/batch-1', `merge-into ${A}`, `merge-into ${B}`, 'delete queue/batch-1'])
    expect(queueOnDisk().batchOff.reason).toContain("does not have 'workflow_dispatch' trigger")
    expect(batchesOnDisk()).toHaveLength(1)
    const q = await call('merge_queue')
    expect(q.data.queue.map((i: any) => [i.pr, i.state, i.batch])).toEqual([
      [77, 'ci', null],
      [78, 'ci', null],
    ])
  })

  // The flake of job 117380827558: the list was ordered by when each item was last read, so which of #77 and #78 came
  // first depended on which poll came last. Waits for the state that made it fail: #78 read after #77.
  it('lists the queue in the order it was made, whichever item was read last', async () => {
    runtime(batchState({ dispatchError: "Workflow does not have 'workflow_dispatch' trigger (HTTP 422)" }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped')
    const readAt = (q: any, pr: number) => q.queue.find((i: any) => i.pr === pr).updatedAt as string
    for (const [first, last] of [
      [77, 78],
      [78, 77],
    ] as const) {
      // The view that shows the state is the one asserted on
      const q = await until((x) => readAt(x, last) > readAt(x, first), `#${last} to be read after #${first}`)
      expect(q.queue.map((i: any) => i.pr)).toEqual([77, 78])
    }
  })

  it('makes no batch again with one that conflicts, when too few are left to batch', async () => {
    runtime(batchState({ conflicts: [B] }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped')
    await morePolls(6)
    // Without marking it, the same two were batched again after their next poll, and conflicted again
    expect(batchesOnDisk()).toHaveLength(1)
    expect(writes().map(short2)).toEqual(['branch queue/batch-1', `merge-into ${A}`, `merge-into ${B}`, 'delete queue/batch-1'])
    expect(queueOnDisk().items.find((i: any) => i.pr === 78).batchless).toBe(B)
  })

  it('never deletes a batch branch it did not make, and carries on with the next name', async () => {
    runtime(batchState({ refs: ['refs/heads/queue/batch-1'] }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => writes().some((w) => short2(w) === 'dispatch queue/batch-2'), 'the next batch to start')
    expect(writes().map(short2).slice(0, 4)).toEqual(['branch queue/batch-2', `merge-into ${A}`, `merge-into ${B}`, 'dispatch queue/batch-2'])
    expect(writes().map(short2)).not.toContain('delete queue/batch-1')
    expect(batchEvents().filter((t) => t.includes('queue/batch-1 could not be made'))).toHaveLength(1)
  })

  it('never deletes the batch branch when it ends after three errors before the queue made it', async () => {
    runtime(batchState({ mainError: true }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'error', 'the batch to end in errors')
    await morePolls(4)
    expect(writes().map(short2)).toEqual([])
    // Not batched again on those heads, batch after batch
    expect(batchesOnDisk()).toHaveLength(1)
  })

  it('writes down each run it cancels before cancelling it', async () => {
    runtime(batchState({ cancelError: 'API rate limit exceeded for user ID 1. (HTTP 403)' }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    // The cancel call fails (a rate limit pauses the queue): the run is on the batch's list all the same
    await until(() => queueOnDisk().pause?.kind === 'rate', 'the pause')
    expect(batchesOnDisk()[0].cancelled.map((c: any) => [c.pr, c.run, c.suite])).toEqual([[77, 901, 5001]])
  })

  it('leaves out one GitHub will not merge into the batch (not a conflict), and never batches it again on that head', async () => {
    runtime(batchState({ mergeErrors: [B] }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped')
    await morePolls(6)
    expect(batchesOnDisk()).toHaveLength(1)
    expect(queueOnDisk().items.find((i: any) => i.pr === 78).batchless).toBe(B)
    expect(batchEvents().find((t) => t.includes('would not merge'))).toContain('GitHub would not merge #78 into it')
  })

  // #1961: the answer to POST /merges was lost after GitHub merged the member. Counted as refused, it stayed in the branch,
  // and the batch went on with a tree the member was in and CI's verdict covered, landing the rest from a tree no run saw
  describe('when the answer to a write on the batch branch is lost (#1961)', () => {
    // A second run in one test: a new fake GitHub and a new queue file
    const fresh = async (state: Gh) => {
      await rt?.dispose({ awaitTree: true })
      forgetApp()
      await removeFakeDir(join(root, 'data'))
      mkdirSync(join(root, 'data'))
      runtime(state)
    }
    const landsBoth = async () => {
      await call('queue_merge', { pr: 77, owner: 'tester' })
      await call('queue_merge', { pr: 78, owner: 'tester' })
      await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'merged', 'both to land')
      await until(() => batchesOnDisk()[0]?.state === 'done', 'the batch to end')
    }

    it('counts the member merged when the branch moved, and builds, tests and lands the batch with it', async () => {
      runtime(batchState({ intoLost: [A] }))
      await landsBoth()
      expect(writes().map(short2).slice(0, 4)).toEqual(['branch queue/batch-1', `merge-into ${A}`, `merge-into ${B}`, 'dispatch queue/batch-1'])
      expect(batchesOnDisk()[0].steps).toEqual([
        { pr: 77, head: A, sha: `batch-${A}`, tree: `tree-${A}` },
        { pr: 78, head: B, sha: `batch-${B}`, tree: `tree-${B}` },
      ])
      expect(batchEvents().filter((t) => t.includes('would not merge'))).toEqual([])
      expect(batchEvents().at(-1)).toBe('Batch queue/batch-1: landed #77, #78; main at main-78 is the tree CI tested.')
      // The head of the branch was read once, for the one lost answer
      expect(gh().headReads).toBe(1)
    })

    it('drops the batch when the branch cannot be read afterwards, and goes on with none of it', async () => {
      runtime(batchState({ intoLost: [A], headLost: { n: 1 } }))
      await call('queue_merge', { pr: 77, owner: 'tester' })
      await call('queue_merge', { pr: 78, owner: 'tester' })
      await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped')
      // Nothing after the unknown merge was built on the branch, nothing was started on it, and nobody was blamed
      expect(writes().map(short2).slice(0, 3)).toEqual(['branch queue/batch-1', `merge-into ${A}`, 'delete queue/batch-1'])
      expect(batchEvents().find((t) => t.includes('was lost'))).toMatch(/GitHub's answer to merging #77 into it was lost .*, and the branch could not be read afterwards/)
      expect(queueOnDisk().items.some((i: any) => i.batchless)).toBe(false)
      // No new batch for a few minutes, so a GitHub that keeps failing is not built against in a loop
      expect(queueOnDisk().batchOff.reason).toContain('EOF')
      await morePolls(6)
      expect(batchesOnDisk()).toHaveLength(1)
    })

    it('drops the batch, blaming no one, when the branch did not move (the answer was lost before GitHub merged it, or GitHub is still at it)', async () => {
      runtime(batchState({ intoDropped: [B] }))
      await call('queue_merge', { pr: 77, owner: 'tester' })
      await call('queue_merge', { pr: 78, owner: 'tester' })
      await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped')
      expect(writes().map(short2).slice(0, 4)).toEqual(['branch queue/batch-1', `merge-into ${A}`, `merge-into ${B}`, 'delete queue/batch-1'])
      expect(queueOnDisk().items.some((i: any) => i.batchless)).toBe(false)
      expect(batchEvents().find((t) => t.includes('was lost'))).toContain("GitHub's answer to merging #78 into it was lost")
      expect(gh().headReads).toBe(1)
      // The same failure again does not rebuild the batch within that time: one branch made, one merge tried, no more
      await morePolls(6)
      expect(batchesOnDisk()).toHaveLength(1)
      expect(writes().filter((w) => w[0] === 'branch')).toHaveLength(1)
      expect(queueOnDisk().batchOff.until > new Date().toISOString()).toBe(true)
      // A refusal GitHub answered (a 404) is not read back: it said no, and the member is kept out of a batch on that head
      await fresh(batchState({ mergeErrors: [B] }))
      await call('queue_merge', { pr: 77, owner: 'tester' })
      await call('queue_merge', { pr: 78, owner: 'tester' })
      await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped')
      expect(queueOnDisk().items.find((i: any) => i.pr === 78).batchless).toBe(B)
      expect(gh().headReads ?? 0).toBe(0)
    })
  })

  it("does not batch a fork's pull request", async () => {
    const base = batchState()
    runtime(
      batchState({
        prs: {
          ...base.prs,
          '78': ghPr(78, { headRefOid: B, mergeStateStatus: 'UNSTABLE', isCrossRepository: true }),
        },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await morePolls(9)
    expect(batchesOnDisk()).toEqual([])
    expect(writes()).toEqual([])
  })

  it('leaves out one that conflicts with the ones before it, and batches the rest', async () => {
    const base = batchState()
    runtime(
      batchState({
        prs: { ...base.prs, '79': ghPr(79, { headRefOid: C, mergeStateStatus: 'UNSTABLE' }) },
        runs: { ...base.runs, [C]: [ownRun(79, C, 903, 5003)] },
        checks: { ...base.checks, [C]: ownChecks(5003, null) },
        conflicts: [C],
      }),
      { PROJECT_BOARD_QUEUE_BATCH_MIN: '3' },
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 79, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'landing' || batchesOnDisk()[0]?.state === 'done', 'the batch to pass')
    const order = writes().map(short2)
    expect(order.slice(0, 7)).toEqual(['branch queue/batch-1', `merge-into ${A}`, `merge-into ${C}`, `merge-into ${B}`, 'dispatch queue/batch-1', 'cancel 901', 'cancel 902'])
    // Its own run is left to run, and it is not batched again on that head
    expect(order).not.toContain('cancel 903')
    const item = queueOnDisk().items.find((i: any) => i.pr === 79)
    expect(item).toMatchObject({ state: 'ci', batchless: C })
    expect(item.batch).toBeUndefined()
    expect(batchEvents().find((t) => t.includes('conflicted'))).toContain('#79 conflicted with the ones before, and goes on with its own CI.')
  })
})

/*
 * Two tiers of CI (this repository's project.json): what lands, lands from a full run. A pull request's own run is the
 * quick tier; the queue lands it through a batch built on main and run in full (`ci.landTier: full`), or run on the quick
 * tier (`quick`, #1259), a batch of one included.
 */
describe('the merge queue lands only from a full run, with two tiers of CI', { timeout: 240_000 * SLOW }, () => {
  /** A pull request's own quick run: finished and green on what it ran, the full tier's check skipped. */
  const quickChecks = (conclusion = 'success') => [ghCheck('full tier', 'skipped', 10), ghCheck('verify', conclusion, 11), ghCheck('windows tests', 'success', 12), ghCheck('macos tests', 'success', 13)]
  const fullChecks = (suite: number, conclusion = 'success', tier = 'success') => [
    suiteCheck('full tier', tier, suite * 10, suite),
    suiteCheck('verify', 'success', suite * 10 + 1, suite),
    suiteCheck('windows tests', conclusion, suite * 10 + 2, suite),
    suiteCheck('macos tests', 'success', suite * 10 + 3, suite),
  ]
  const ONE = `batch-${SHA}`
  const oneRun = (conclusion: string | null, attempt = 1) => ghRun(conclusion, attempt, ONE, { id: 950, head_branch: 'queue/batch-1', event: 'workflow_dispatch', check_suite_id: 6000 })
  const tieredState = (patch: Gh = {}) =>
    ghState({
      checks: { [SHA]: quickChecks() },
      on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: fullChecks(6000) } } },
      ...patch,
    })

  it('lands a pull request whose own run was the quick tier through a batch of one, never from that run', async () => {
    runtime(tieredState(), TIERS)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    await until(() => batchesOnDisk()[0]?.state === 'done', 'the batch to end')
    // Its own run had finished: nothing to cancel, and it lands on the head the batch tested
    expect(writes().map(short2)).toEqual(['branch queue/batch-1', `merge-into ${SHA}`, 'dispatch queue/batch-1', `status ${SHA}`, 'merge 77', 'delete feat/b77', 'delete queue/batch-1'])
    expect(writes().find((w) => w[0] === 'status')).toEqual(['status', SHA, 'success', 'merge-queue', 'Passed the full tier of CI in queue/batch-1'])
    expect(notices().map((e) => e.text)).toEqual(['Merge queue: merged #77 (feat(apps): change 77) as abcdef1, "feat(apps): change 77 (#77)". Tested in batch queue/batch-1 with nothing else, in the full tier.'])
  })

  // #1593 (#1586, 2026-10-26): its quick tier passed, the queue put it in batch-225 alone, the full tier ran for about 30 minutes,
  // and the batch stopped at landing: "squash subject is over 72 characters"
  describe('a squash subject over 72 characters (#1593)', () => {
    const LONG = `feat(apps): ${'x'.repeat(55)}` // 73 characters with " (#77)"
    const FITS = `feat(apps): ${'x'.repeat(54)}`
    const queued = (extra: Record<string, unknown> = {}) => ({
      repo: R,
      pr: 77,
      lowers: [],
      owner: 'tester',
      author: 'tester',
      state: 'ci',
      title: FITS,
      queuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reruns: {},
      ...extra,
    })

    it('puts no batch together with it: attention subject at its poll, and once the title fits it lands through a batch, with no new push', async () => {
      // Queued with a title that fit, then edited: the quick tier is green on its head
      seedQueue([queued()])
      runtime(tieredState({ prs: { '77': ghPr(77, { title: LONG }) } }), TIERS)
      await until((x) => stateOf(x) === 'attention', 'attention')
      expect(queueOnDisk().items[0].reason).toMatchObject({ kind: 'subject' })
      // When it began, for how long the board app is kept polling it
      expect(Date.parse(queueOnDisk().items[0].attentionAt)).toBeGreaterThan(0)
      expect(notices().map((e) => e.text).join(' ')).toContain('the squash subject "' + LONG + ' (#77)" is 73 characters, over 72')
      await morePolls(3)
      // Polled again, never batched, nothing touched on GitHub
      expect(writes()).toEqual([])
      expect(batchesOnDisk()).toEqual([])
      patchGh((st) => (st.prs['77'] = ghPr(77, { title: FITS })))
      await until((x) => stateOf(x) === 'merged', 'the merge')
      expect(writes().map(short2)).toContain('branch queue/batch-1')
      expect(writes().map(short2)).toContain('merge 77')
      expect(gh().prs['77'].headRefOid).toBe(SHA)
    })

    it('makes no batch of it while its quick tier still runs, as it is a candidate then (a batch made and dropped every tick before)', async () => {
      const going = [ghCheck('full tier', 'skipped', 10), ghCheck('verify', null, 11), ghCheck('windows tests', null, 12)]
      seedQueue([queued()])
      runtime(tieredState({ prs: { '77': ghPr(77, { title: LONG }) }, checks: { [SHA]: going }, runs: { [SHA]: [ghRun(null)] } }), TIERS)
      await until((x) => stateOf(x) === 'attention', 'attention')
      expect(queueOnDisk().items[0].reason).toMatchObject({ kind: 'subject' })
      await morePolls(3)
      expect(queueOnDisk().batchSeq).toBe(0)
      expect(batchesOnDisk()).toEqual([])
      expect(writes()).toEqual([])
    })

    it('sends a member back at the batch build when its title was edited after the poll that made it a candidate', async () => {
      // Read as a candidate on its head (verdict quick), the title longer by the time the batch is built
      seedQueue([queued({ head: SHA, ci: { head: SHA, verdict: 'quick', runs: [{ id: 900, status: 'completed' }], batchable: true } })])
      runtime(tieredState({ prs: { '77': ghPr(77, { title: LONG }) } }), TIERS)
      await until((x) => stateOf(x) === 'attention', 'attention')
      expect(queueOnDisk().items[0].reason).toMatchObject({ kind: 'subject' })
      // No branch was made for it, no CI started
      expect(writes().map(short2).filter((w) => w.startsWith('branch') || w.startsWith('dispatch'))).toEqual([])
      expect(gh().dispatched ?? []).toEqual([])
    })

    it('refuses to queue a pull request whose squash subject is over 72 characters, with nothing queued and nothing written', async () => {
      runtime(tieredState({ prs: { '77': ghPr(77, { title: LONG }) } }), TIERS)
      const r = await call('queue_merge', { pr: 77, owner: 'tester' })
      expect(r.isError).toBe(true)
      expect(r.data).toMatchObject({ queued: false, kind: 'subject', subject: true })
      expect(r.text).toContain(`Not queued: the squash subject "${LONG} (#77)" is 73 characters, over 72. Shorten the title.`)
      expect(itemsOnDisk()).toEqual([])
      expect(writes()).toEqual([])
      // At 72 it queues
      patchGh((st) => (st.prs['77'] = ghPr(77, { title: FITS })))
      expect((await call('queue_merge', { pr: 77, owner: 'tester' })).isError).toBe(false)
    })

    it('does not call another refusal subject when the title is only one of the reasons', async () => {
      runtime(tieredState({ prs: { '77': ghPr(77, { title: LONG, isDraft: true }) } }), TIERS)
      const r = await call('queue_merge', { pr: 77, owner: 'tester' })
      expect(r.data).toMatchObject({ queued: false, kind: 'refused', subject: true })
      expect(r.text).toContain('is a draft')
      expect(r.text).toContain('is 73 characters, over 72')
      expect(itemsOnDisk()).toEqual([])
    })

    it("judges a stack's top, whose title is the squash subject, and not its lowers", async () => {
      runtime(tieredState({ prs: { '76': ghPr(76, { title: LONG }), '77': ghPr(77, { title: FITS, baseRefName: 'feat/b76' }) } }), TIERS)
      expect((await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })).isError).toBe(false)
      await call('unqueue', { pr: 77 })
      patchGh((st) => (st.prs['77'] = ghPr(77, { title: LONG, baseRefName: 'feat/b76' })))
      const top = await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
      expect(top.data).toMatchObject({ queued: false, kind: 'subject' })
    })
  })

  // queue/batch-89, 2026-10-19: the batch went green, then sat in landing because its member's head was UNSTABLE from a
  // cancelled duplicate of its own quick run (created in the same second); after 30 minutes it went back and looped
  it('lands a batch member GitHub calls UNSTABLE because of a cancelled duplicate of its own run on its head', async () => {
    // Both runs created in the same second; the duplicate's checks were cancelled before the passing run's finished
    const at = '2026-10-17T08:01:00Z'
    const own = [ghCheck('full tier', 'skipped', 10, at), ghCheck('verify', 'success', 11, at), ghCheck('windows tests', 'success', 12, at)]
    const dup = [{ ...ghCheck('verify', 'cancelled', 21, '2026-10-17T08:00:30Z'), check_suite: { id: 5001 } }, { ...ghCheck('windows tests', 'cancelled', 22, '2026-10-17T08:00:30Z'), check_suite: { id: 5001 } }]
    runtime(
      tieredState({
        prs: { '77': ghPr(77, { mergeStateStatus: 'UNSTABLE' }) },
        runs: {
          [SHA]: [ghRun('success', 1, SHA, { id: 900, workflow_id: 7, check_suite_id: 5000 }), ghRun('cancelled', 1, SHA, { id: 901, workflow_id: 7, check_suite_id: 5001 })],
        },
        checks: { [SHA]: [...own, ...dup] },
      }),
      TIERS,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(writes().map(short2)).toContain('merge 77')
    expect(writes().filter((w) => w[0].startsWith('rerun'))).toEqual([])
  })

  // #1346: batch 114 (#1304) waited out UNSTABLE for 30 minutes: the newer of two same-second runs failed a job (a
  // cleanup flake) that the other run passed on a rerun; neither cancelled nor older, so it was not counted as moot
  it("lands a batch member GitHub calls UNSTABLE because a duplicate run failed a job its twin passed (#1346)", async () => {
    const own = [ghCheck('full tier', 'skipped', 10, '2026-10-17T08:00:00Z'), ghCheck('verify', 'success', 11, '2026-10-17T08:00:00Z'), ghCheck('windows tests', 'success', 12, '2026-10-17T08:20:00Z')]
    const dup = [
      { ...ghCheck('full tier', 'skipped', 20, '2026-10-17T08:00:00Z'), check_suite: { id: 5001 } },
      { ...ghCheck('verify', 'success', 21, '2026-10-17T08:00:00Z'), check_suite: { id: 5001 } },
      { ...ghCheck('windows tests', 'failure', 22, '2026-10-17T08:05:00Z'), check_suite: { id: 5001 } },
    ]
    runtime(
      tieredState({
        prs: { '77': ghPr(77, { mergeStateStatus: 'UNSTABLE' }) },
        runs: {
          // The same second; the failing one has the higher id, the passing one passed on its second attempt
          [SHA]: [ghRun('success', 2, SHA, { id: 900, workflow_id: 7, check_suite_id: 5000 }), ghRun('failure', 1, SHA, { id: 901, workflow_id: 7, check_suite_id: 5001 })],
        },
        checks: { [SHA]: [...own, ...dup] },
      }),
      TIERS,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(writes().map(short2)).toContain('merge 77')
  })

  it('batches four ready pull requests in one run, its quick run still going or finished, cancels what still runs, and lands them in order', async () => {
    const H = (n: number) => `${n}`.repeat(40).slice(0, 40)
    const quickOf = (n: number, going: boolean) => [
      suiteCheck('full tier', 'skipped', n * 10, 5000 + n),
      suiteCheck('verify', 'success', n * 10 + 1, 5000 + n),
      suiteCheck('windows tests', going ? null : 'success', n * 10 + 2, 5000 + n),
    ]
    const own = (n: number, going: boolean) => ownRun(n, H(n), 900 + n, 5000 + n, going ? null : 'success', 1)
    const going = (n: number) => ({ ...own(n, true), status: 'in_progress' })
    const prs = [77, 78, 79, 80, 81]
    const full = (suite: number) => [suiteCheck('full tier', 'success', suite * 10, suite), suiteCheck('verify', 'success', suite * 10 + 1, suite), suiteCheck('windows tests', 'success', suite * 10 + 2, suite)]
    const batchRunOf = (k: number, head: string) => ghRun('success', 1, head, { id: 950 + k, head_branch: `queue/batch-${k}`, event: 'workflow_dispatch', check_suite_id: 6000 + k })
    runtime(
      ghState({
        prs: Object.fromEntries(prs.map((n) => [String(n), ghPr(n, { headRefOid: H(n), mergeStateStatus: n === 78 ? 'UNSTABLE' : 'CLEAN' })])),
        runs: Object.fromEntries(prs.map((n) => [H(n), [n === 78 ? going(n) : own(n, false)]])),
        checks: Object.fromEntries(prs.map((n) => [H(n), quickOf(n, n === 78)])),
        on: {
          'cancel:978': { runs: { [H(78)]: [{ ...own(78, false), conclusion: 'cancelled' }] }, checks: { [H(78)]: quickOf(78, false).map((c) => (c.name === 'windows tests' ? { ...c, conclusion: 'cancelled' } : c)) } },
          'dispatch:queue/batch-1': { runs: { [`batch-${H(80)}`]: [batchRunOf(1, `batch-${H(80)}`)] }, checks: { [`batch-${H(80)}`]: full(6001) } },
        },
      }),
      { ...TIERS, PROJECT_BOARD_QUEUE_BATCH_MIN: '4' },
    )
    // Five queued in a row (a batch starts at four here, so none goes alone before the rest are queued)
    for (const n of prs) await call('queue_merge', { pr: n, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'done', 'the batch to land')
    const order = writes().map(short2)
    expect(order.slice(0, 7)).toEqual(['branch queue/batch-1', `merge-into ${H(77)}`, `merge-into ${H(78)}`, `merge-into ${H(79)}`, `merge-into ${H(80)}`, 'dispatch queue/batch-1', 'cancel 978'])
    // One run for the four; each lands as its own squash, in order; the fifth waits for the next batch
    expect(order.filter((w) => w.startsWith('merge ')).map((w) => w.slice(6))).toEqual(['77', '78', '79', '80'])
    expect(batchesOnDisk().map((b) => [b.members.map((m: any) => m.pr), b.state])).toEqual([[[77, 78, 79, 80], 'done']])
    expect(['waiting', 'ci']).toContain(queueOnDisk().items.find((i: any) => i.pr === 81).state)
    expect(queueOnDisk().items.find((i: any) => i.pr === 81).batch).toBeUndefined()
    expect(order.filter((w) => w.startsWith('rerun'))).toEqual([])
  })

  it('bisects a red batch: the half that passes lands, the pull request that fails alone gets attention at once, nothing rerun', async () => {
    const H = (n: number) => `${n}`.repeat(40).slice(0, 40)
    const quickOf = (n: number) => [suiteCheck('full tier', 'skipped', n * 10, 5000 + n), suiteCheck('verify', 'success', n * 10 + 1, 5000 + n), suiteCheck('windows tests', 'success', n * 10 + 2, 5000 + n)]
    const runOf = (k: number, head: string, conclusion: string) => ghRun(conclusion, 1, head, { id: 950 + k, head_branch: `queue/batch-${k}`, event: 'workflow_dispatch', check_suite_id: 6000 + k })
    // #78 breaks the full tier: the batch of both fails, and so does #78 alone (the merges answer `batch-<last head>`)
    const ran = (k: number, last: number, ok: boolean) => ({
      runs: { [`batch-${H(last)}`]: [runOf(k, `batch-${H(last)}`, ok ? 'success' : 'failure')] },
      checks: { [`batch-${H(last)}`]: fullChecks(6000 + k, ok ? 'success' : 'failure') },
    })
    runtime(
      ghState({
        prs: { '77': ghPr(77, { headRefOid: H(77) }), '78': ghPr(78, { headRefOid: H(78) }) },
        runs: { [H(77)]: [ownRun(77, H(77), 977, 5077, 'success')], [H(78)]: [ownRun(78, H(78), 978, 5078, 'success')] },
        checks: { [H(77)]: quickOf(77), [H(78)]: quickOf(78) },
        logs: { '60032': 'FAIL e2e window.spec.ts > opens the window\nError: expected 1 window, got 0' },
        on: { 'dispatch:queue/batch-1': ran(1, 78, false), 'dispatch:queue/batch-2': ran(2, 77, true), 'dispatch:queue/batch-3': ran(3, 78, false) },
      }),
      { ...TIERS, PROJECT_BOARD_QUEUE_BATCH_MIN: '2' },
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'attention', '#77 to land and #78 to need attention')
    expect(batchesOnDisk().map((b) => [b.members.map((m: any) => m.pr), b.state])).toEqual([
      [[77, 78], 'failed'],
      [[77], 'done'],
      [[78], 'failed'],
    ])
    const order = writes().map(short2)
    expect(order.filter((w) => w.startsWith('merge ') || w.startsWith('rerun'))).toEqual(['merge 77'])
    const told = notices().filter((e) => e.kind === 'attention')
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain('#78 failed alone in batch queue/batch-3')
    expect(told[0]!.text).toContain('"windows tests" (job 60032) failed at batch-7 with a test or build failure')
    expect(told[0]!.text).toContain('First failure: FAIL e2e window.spec.ts > opens the window')
    await morePolls(4)
    // Not batched again on its head, and still one message
    expect(batchesOnDisk()).toHaveLength(3)
    expect(notices().filter((e) => e.kind === 'attention')).toHaveLength(1)
  })

  it('lands nothing when the batch of one fails, and tells the session why', async () => {
    runtime(
      tieredState({
        on: {
          'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('failure')] }, checks: { [ONE]: fullChecks(6000, 'failure') } },
        },
        logs: { '60002': 'FAIL e2e full.spec.ts > the full tier\nError: expected the window' },
      }),
      TIERS,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls(4)
    const q = await call('merge_queue', { all: true })
    expect(q.data.queue[0].reason).toMatchObject({ kind: 'failed', job: { name: 'windows tests', id: '60002' } })
    // Told once, at once, with the batch's failing job and its first failure line
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).toContain('#77 failed alone in batch queue/batch-1, a run of the full tier on main at main0: "windows tests" (job 60002) failed at batch-c with a test or build failure')
    expect(notices()[0]!.text).toContain('First failure: FAIL e2e full.spec.ts > the full tier')
    expect(writes().map(short2)).toEqual(['branch queue/batch-1', `merge-into ${SHA}`, 'dispatch queue/batch-1', 'delete queue/batch-1'])
    // Not batched again on this head, batch after batch
    expect(batchesOnDisk()).toHaveLength(1)
  })

  // A batch's run proves the top as its own run would: a lower that failed before it is outlived, one after it is evidence
  it.each([
    ['before', '2026-10-17T07:00:00Z', 'merged'],
    ['after', '2026-10-17T09:00:00Z', 'attention'],
  ])("lands a stack's top from its batch over a lower that failed %s the batch's run, or stops for it", async (_when, failedAt, state) => {
    runtime(
      tieredState({
        prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2, isDraft: true }), '77': ghPr(77) },
        runs: { [SHA]: [ghRun('success')], [SHA2]: [ghRun('failure', 1, SHA2, { id: 990, head_branch: 'feat/low', created_at: failedAt })] },
        compare: { [`${SHA2}...${SHA}`]: 'ahead' },
        on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: fullChecks(6000) } } },
      }),
      TIERS,
    )
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    const q = await until((x) => stateOf(x) === state, state)
    if (state === 'merged') expect(writes().map(short2)).toContain('close 76')
    else {
      expect(q.queue[0].reason.kind).toBe('lower-failed')
      expect(writes().map(short2)).not.toContain('merge 77')
    }
  })

  it('lands after the fast tier (#1259): the batch asks for the quick tier and lands from it, its full tier skipped', async () => {
    runtime(tieredState({ on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: fullChecks(6000, 'success', 'skipped') } } } }), FAST_LAND)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(gh().dispatched).toEqual([{ ref: 'queue/batch-1', inputs: { tier: 'quick' } }])
    expect(writes().map(short2)).toContain('merge 77')
  })

  /*
   * queue/batch-98, 2026-10-19: under ci.landTier quick the batch's run (the quick tier) passed, and the batch stopped
   * with "required checks … never reported": the required set is the whole workflow's, and a quick run never reports
   * the full tier's jobs (a matrix job left out reports no check of its name at all)
   */
  const FULL_WORKFLOW = [
    'jobs:',
    '  changes:',
    '    name: changes',
    '  full-tier:',
    '    name: full tier',
    '  verify:',
    '    name: verify',
    '  windows-unit-1:',
    '    name: windows tests (vitest 1/2)',
    '  windows-unit-2:',
    '    name: windows tests (vitest 2/2)',
    '  keeper:',
    '    name: keeper e2e',
    '  host-remote:',
    '    name: host tests, remote Node',
    '',
  ].join('\n')
  /** What a batch's quick run reports: the quick tier's checks (this repository's names), the full tier's skipped */
  const realQuick = (suite: number, verify = 'success') => [
    suiteCheck('changes', 'success', suite * 10 + 5, suite),
    suiteCheck('full tier', 'skipped', suite * 10, suite),
    suiteCheck('verify', verify, suite * 10 + 1, suite),
    suiteCheck('windows tests (vitest 1/2)', 'success', suite * 10 + 2, suite),
    suiteCheck('windows tests (vitest 2/2)', 'success', suite * 10 + 3, suite),
    suiteCheck('macos tests', 'success', suite * 10 + 4, suite),
  ]

  it("lands a batch whose quick run passed while the full tier's jobs never reported, under ci.landTier quick", async () => {
    runtime(
      tieredState({ workflow: FULL_WORKFLOW, on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: realQuick(6000) } } } }),
      REAL_QUICK,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(writes().map(short2)).toContain('merge 77')
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
  })

  it('lands a quick batch run only with the full tier check reported as skipped, and every run concluded well', () => {
    const checks = (rows: Row[]) => evaluateChecks({ required: ['full tier', 'verify', 'windows tests', 'keeper e2e'], reported: rows })
    const quickRows = [check('full tier', 'skipped'), check('verify', 'success'), check('windows tests', 'success')]
    const ok = [{ status: 'completed', conclusion: 'success' }]
    const named = ['verify', 'windows tests']
    expect(quickLanded(checks(quickRows), ok, 'full tier', named)).toBe(true)
    // No full tier check at all: not known to be the quick tier
    expect(quickLanded(checks(quickRows.slice(1)), ok, 'full tier', named)).toBe(false)
    // A run that concluded badly on a check outside the required rows
    expect(quickLanded(checks(quickRows), [{ status: 'completed', conclusion: 'failure' }], 'full tier', named)).toBe(false)
    // A quick-tier failure, or a run still going
    expect(quickLanded(checks([check('full tier', 'skipped'), check('verify', 'failure'), check('windows tests', 'success')]), ok, 'full tier', named)).toBe(false)
    expect(quickLanded(checks(quickRows), [{ status: 'in_progress', conclusion: null }], 'full tier', named)).toBe(false)
    // No quick check named: nothing lands from a quick run
    expect(quickLanded(checks(quickRows), ok, 'full tier', [])).toBe(false)
  })

  // RVAP review of #1311: quickGreen ignores a check that never reported, so a quick tier that did not run would land
  it("lands a quick batch run only when each of the quick tier's named checks reported and succeeded", () => {
    const required = ['changes', 'full tier', 'verify', 'windows tests (vitest 1/2)', 'windows tests (vitest 2/2)', 'linux-x64', 'e2e (webkit 1/5)', 'keeper e2e']
    const named = ['changes', 'verify', 'windows tests (vitest *)']
    const ok = [{ status: 'completed', conclusion: 'success' }]
    const all = [check('changes', 'success'), check('full tier', 'skipped'), check('verify', 'success'), check('windows tests (vitest 1/2)', 'success'), check('windows tests (vitest 2/2)', 'success')]
    const lands = (rows: Row[]) => quickLanded(evaluateChecks({ required, reported: rows }), ok, 'full tier', named)
    // batch-98: every quick check passed, the full tier's jobs never reported
    expect(lands(all)).toBe(true)
    // verify never reported
    expect(lands(all.filter((c) => c.name !== 'verify'))).toBe(false)
    // one Windows shard never reported
    expect(lands(all.filter((c) => c.name !== 'windows tests (vitest 2/2)'))).toBe(false)
    // only changes, and the full tier skipped
    expect(lands([check('changes', 'success'), check('full tier', 'skipped')])).toBe(false)
    // a quick check skipped: not a pass for a landing
    expect(lands(all.map((c) => (c.name === 'verify' ? check('verify', 'skipped') : c)))).toBe(false)
  })

  it("lands nothing from a batch whose quick run failed, the full tier's jobs unreported as well", async () => {
    runtime(
      tieredState({ workflow: FULL_WORKFLOW, on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('failure')] }, checks: { [ONE]: realQuick(6000, 'failure') } } } }),
      REAL_QUICK,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    expect(writes().map(short2)).not.toContain('merge 77')
  })

  it('refuses to start landing after the fast tier with no quick check named (an empty ci.quickChecks)', async () => {
    runtime(tieredState(), { ...REAL_QUICK, PROJECT_BOARD_CI_QUICK_CHECKS: '[]' })
    await expect(call('merge_queue')).rejects.toThrow(/ci\.quickChecks must name the quick tier/)
  })

  it('still lands nothing from a red batch on the fast tier', async () => {
    runtime(tieredState({ on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('failure')] }, checks: { [ONE]: fullChecks(6000, 'failure', 'skipped') } } } }), FAST_LAND)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    expect(writes().map(short2)).not.toContain('merge 77')
  })

  it('lands nothing from a batch whose run did not run the full tier', async () => {
    runtime(tieredState({ on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: fullChecks(6000, 'success', 'skipped') } } } }), TIERS)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    expect(notices().at(-1)!.text).toContain('passed without running the full tier')
    expect(writes().map(short2)).not.toContain('merge 77')
    expect(batchesOnDisk().map((b) => b.state)).toEqual(['dropped'])
  })

  it('lands a full run on its own head with batches off, and tells the session about a fork it cannot batch', async () => {
    runtime(
      tieredState({
        prs: {
          '77': ghPr(77, { headRefName: 'feat/unbatched', title: 'feat(x): unbatched' }),
          '78': ghPr(78, { headRefOid: B, isCrossRepository: true }),
        },
        runs: { [SHA]: [ghRun('success')], [B]: [ownRun(78, B, 902, 5002, 'success')] },
        checks: { [SHA]: fullChecks(5000), [B]: quickChecks().map((c) => ({ ...c, check_suite: { id: 5002 } })) },
      }),
      NO_BATCH,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'attention', 'the full run to land and the fork to need attention')
    expect(writes().map(short2)).toEqual(['merge 77', 'delete feat/unbatched'])
    expect(batchesOnDisk()).toEqual([])
    expect(notices().find((e) => e.text.includes('#78'))!.text).toContain("ran only the quick tier of CI")
  })
})

/*
 * #1548: a batch that stops only because main moved while it ran (the release bump #1545 landed outside the queue
 * while batch-209 tested #1542) rebatches its members on the new main, and tells no session, up to a cap per head.
 */
describe('the merge queue batches a pull request again when main moved under its batch (#1548)', { timeout: 240_000 * SLOW }, () => {
  const quickChecks = [ghCheck('full tier', 'skipped', 10), ghCheck('verify', 'success', 11), ghCheck('windows tests', 'success', 12), ghCheck('macos tests', 'success', 13)]
  const fullChecks = (suite: number) => [suiteCheck('full tier', 'success', suite * 10, suite), suiteCheck('verify', 'success', suite * 10 + 1, suite), suiteCheck('windows tests', 'success', suite * 10 + 2, suite), suiteCheck('macos tests', 'success', suite * 10 + 3, suite)]
  const ONE = `batch-${SHA}`
  /** Batch `k`'s green full run on a one-member batch */
  const runOf = (k: number) => ghRun('success', 1, ONE, { id: 950 + k, head_branch: `queue/batch-${k}`, event: 'workflow_dispatch', check_suite_id: 6000 + k })
  /** CI starts on batch `k` (a green run), and main moves meanwhile: a merge outside the queue, as the release bump #1545 */
  const movesAt = (k: number) => ({ [`dispatch:queue/batch-${k}`]: { runs: { [ONE]: [runOf(k)] }, checks: { [ONE]: fullChecks(6000 + k) }, main: { sha: `main-moved-${k}`, tree: `tree-moved-${k}` } } })
  const oneState = (on: Gh) => ghState({ checks: { [SHA]: quickChecks }, on })
  const told = () => notices().filter((e) => e.kind === 'attention')

  // The case of batch-209, 2026-10-26: its member waited for a session, and the run was lost
  it('tests a batch of one again on the new main, with no alone mark and no message, and lands it', async () => {
    runtime(oneState({ ...movesAt(1), 'dispatch:queue/batch-2': { runs: { [ONE]: [runOf(2)] }, checks: { [ONE]: fullChecks(6002) } } }), TIERS)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    await until(() => batchesOnDisk().length === 2 && batchesOnDisk()[1].state === 'done', 'the second batch to end')
    expect(batchesOnDisk().map((b) => [b.branch, b.members.map((m: any) => m.pr), b.state])).toEqual([
      ['queue/batch-1', [77], 'stopped'],
      ['queue/batch-2', [77], 'done'],
    ])
    expect(batchEvents().some((t) => t.startsWith('Batch queue/batch-1: stopped before #77: main is not the tree the batch had before #77 (something else landed). That is no fault of #77: it is tested again on the new main.'))).toBe(true)
    expect(batchEvents().some((t) => t === 'Batch queue/batch-2: #77 was in queue/batch-1, which stopped because main moved; it is batched again on it (restart 1 of 3).')).toBe(true)
    // Never blamed, never told: the next batch is formed from the stop itself, with no round through its own CI
    expect(queueOnDisk().items[0].alone).toBeUndefined()
    expect(queueOnDisk().items[0].batchless).toBeUndefined()
    expect(told()).toEqual([])
    expect(notices().map((e) => e.kind)).toEqual(['merged'])
    expect(writes().map(short2)).toEqual([
      'branch queue/batch-1',
      `merge-into ${SHA}`,
      'dispatch queue/batch-1',
      'delete queue/batch-1',
      'branch queue/batch-2',
      `merge-into ${SHA}`,
      'dispatch queue/batch-2',
      `status ${SHA}`,
      'merge 77',
      'delete feat/b77',
      'delete queue/batch-2',
    ])
  })

  it('tests it again at most three times on one head, then tells its session as before, once', async () => {
    runtime(oneState({ ...movesAt(1), ...movesAt(2), ...movesAt(3), ...movesAt(4) }), TIERS)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls(4)
    expect(batchesOnDisk().map((b) => [b.branch, b.state])).toEqual([
      ['queue/batch-1', 'stopped'],
      ['queue/batch-2', 'stopped'],
      ['queue/batch-3', 'stopped'],
      ['queue/batch-4', 'stopped'],
    ])
    expect(batchEvents().filter((t) => t.includes('is batched again on it (restart'))).toHaveLength(3)
    expect(told()).toHaveLength(1)
    expect(told()[0]!.text).toContain("#77 passed the quick tier of CI, and lands only from a full run, but its batch of one ran the full tier and ended without landing it: batch queue/batch-4 stopped before #77: main is not the tree the batch had before #77 (something else landed).")
    expect(told()[0]!.text).toContain('It was batched again 3 times on this head already, and main moved under each batch.')
    expect(queueOnDisk().items[0]).toMatchObject({ state: 'attention', moved: { head: SHA, n: 3 }, alone: { head: SHA, tier: 'full' } })
    expect(writes().map(short2)).not.toContain('merge 77')
    // Not formed again on this head
    expect(batchesOnDisk()).toHaveLength(4)
  })

  it('tests the members not landed again together, in a new batch, when main moved after the first landed', async () => {
    const H = (n: number) => `${n}`.repeat(40).slice(0, 40)
    const quickOf = (n: number) => [suiteCheck('full tier', 'skipped', n * 10, 5000 + n), suiteCheck('verify', 'success', n * 10 + 1, 5000 + n), suiteCheck('windows tests', 'success', n * 10 + 2, 5000 + n)]
    const batchRunOf = (k: number, head: string) => ghRun('success', 1, head, { id: 950 + k, head_branch: `queue/batch-${k}`, event: 'workflow_dispatch', check_suite_id: 6000 + k })
    const last = `batch-${H(79)}`
    // #77 lands from the first batch; main then has another tree than the batch had before #78: something else landed
    runtime(
      ghState({
        mainDrift: [77],
        prs: { '77': ghPr(77, { headRefOid: H(77) }), '78': ghPr(78, { headRefOid: H(78) }), '79': ghPr(79, { headRefOid: H(79) }) },
        runs: { [H(77)]: [ownRun(77, H(77), 977, 5077, 'success')], [H(78)]: [ownRun(78, H(78), 978, 5078, 'success')], [H(79)]: [ownRun(79, H(79), 979, 5079, 'success')] },
        checks: { [H(77)]: quickOf(77), [H(78)]: quickOf(78), [H(79)]: quickOf(79) },
        on: {
          'dispatch:queue/batch-1': { runs: { [last]: [batchRunOf(1, last)] }, checks: { [last]: fullChecks(6001) } },
          // The second batch holds #78 and #79 only: its last merge answers `batch-<79's head>` again
          'dispatch:queue/batch-2': { runs: { [last]: [batchRunOf(2, last)] }, checks: { [last]: fullChecks(6002) } },
        },
      }),
      { ...TIERS, PROJECT_BOARD_QUEUE_BATCH_MIN: '3' },
    )
    for (const n of [77, 78, 79]) await call('queue_merge', { pr: n, owner: 'tester' })
    await until((x) => [77, 78, 79].every((n) => stateOf(x, n) === 'merged'), 'all three to land')
    await until(() => batchesOnDisk()[1]?.state === 'done', 'the second batch to end')
    expect(batchesOnDisk().map((b) => [b.members.map((m: any) => m.pr), b.state])).toEqual([
      [[77, 78, 79], 'stopped'],
      [[78, 79], 'done'],
    ])
    expect(told()).toEqual([])
    expect(queueOnDisk().items.map((i: any) => [i.pr, i.alone ?? null, i.batchless ?? null])).toEqual([
      [77, null, null],
      [78, null, null],
      [79, null, null],
    ])
    expect(writes().map(short2).filter((w) => w.startsWith('merge ')).map((w) => w.slice(6))).toEqual(['77', '78', '79'])
  })
})

/*
 * #1538: a batch that holds a change to the screen runs the heavy jobs (the e2e shards, chromium and webkit) before it
 * lands; the other batches land after the fast tier. Which files change the screen is .github/scripts/ci-changes.mjs's
 * to say, read from the default branch: the real script is on the fake main here.
 */
describe('the merge queue runs the heavy jobs before landing a batch that changes the screen (#1538)', { timeout: 240_000 * SLOW }, () => {
  const CI_CHANGES = readFileSync(join(REPO_ROOT, '.github/scripts/ci-changes.mjs'), 'utf8')
  const SCREEN = { judge: '.github/scripts/ci-changes.mjs', checks: ['e2e (webkit *)', 'e2e (chromium *)'], steps: ['pnpm e2e (shard *)'], inputs: { tier: 'full', everything: 'false' } }
  const ENV = { ...REAL_QUICK, PROJECT_BOARD_CI_SCREEN: JSON.stringify(SCREEN) }
  const WORKFLOW_E2E = [
    'jobs:',
    ...['changes', 'full tier', 'verify', 'windows tests (vitest 1/2)', 'windows tests (vitest 2/2)', 'e2e (webkit 1/1)', 'e2e (chromium 1/1)'].flatMap((n, i) => [`  j${i}:`, `    name: ${n}`]),
    '',
  ].join('\n')
  const ONE = `batch-${SHA}`
  /** What a batch's run reports: the fast tier's checks, and on a full run the full tier's and the e2e shards of both browsers */
  const reports = (suite: number, { full = true, e2e = 'success', verify = 'success' }: { full?: boolean; e2e?: string | null; verify?: string } = {}) => [
    suiteCheck('changes', 'success', suite * 10 + 5, suite),
    suiteCheck('full tier', full ? 'success' : 'skipped', suite * 10, suite),
    suiteCheck('verify', verify, suite * 10 + 1, suite),
    suiteCheck('windows tests (vitest 1/2)', 'success', suite * 10 + 2, suite),
    suiteCheck('windows tests (vitest 2/2)', 'success', suite * 10 + 3, suite),
    suiteCheck('macos tests', 'success', suite * 10 + 4, suite),
    ...(full ? [suiteCheck('e2e (webkit 1/1)', e2e, suite * 10 + 6, suite), suiteCheck('e2e (chromium 1/1)', e2e, suite * 10 + 7, suite)] : []),
  ]
  const batchRun = (conclusion: string | null) => ghRun(conclusion, 1, ONE, { id: 950, head_branch: 'queue/batch-1', event: 'workflow_dispatch', check_suite_id: 6000 })
  const state = (reported: any[], patch: Gh = {}, conclusion: string | null = 'success') =>
    ghState({
      workflow: WORKFLOW_E2E,
      files: { '.github/scripts/ci-changes.mjs': CI_CHANGES },
      checks: { [SHA]: [ghCheck('full tier', 'skipped', 10), ghCheck('verify', 'success', 11), ghCheck('windows tests (vitest 1/2)', 'success', 12)] },
      on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [batchRun(conclusion)] }, checks: { [ONE]: reported } } },
      ...patch,
    })
  const told = () => notices().filter((e) => e.kind === 'attention')

  it('runs the full tier with the heavy jobs for a batch that changes the screen, waits for them, and lands it, saying the tier it ran', async () => {
    // The shards are still running when CI first reads the run
    runtime(state(reports(6000, { e2e: null }), { batchFiles: ['docs/a.md', 'packages/ui/src/App.tsx'] }, null), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'ci', 'the batch to run')
    expect(gh().dispatched).toEqual([{ ref: 'queue/batch-1', inputs: { tier: 'full', everything: 'false' } }])
    await morePolls(6)
    // Required and awaited: nothing lands while the shards run
    expect(writes().map(short2)).not.toContain('merge 77')
    expect(batchesOnDisk()[0]).toMatchObject({ state: 'ci', tier: 'full', tierWhy: 'it changes the screen (packages/ui/src/App.tsx)' })
    expect((await call('merge_queue')).data.batches[0].line).toBe('Batch queue/batch-1: #77 — CI at batch-c, the full tier')
    patchGh((s) => {
      s.runs[ONE] = [batchRun('success')]
      s.checks[ONE] = reports(6000)
    })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(batchEvents().some((t) => t.includes('CI started on batch-c, to run the full tier: it changes the screen (packages/ui/src/App.tsx).'))).toBe(true)
    expect(batchEvents().some((t) => t.includes('passed CI (run 950, the full tier)'))).toBe(true)
    expect(writes().find((w) => w[0] === 'status')).toEqual(['status', SHA, 'success', 'merge-queue', 'Passed the full tier of CI in queue/batch-1'])
    expect(notices().map((e) => e.text)).toEqual(['Merge queue: merged #77 (feat(apps): change 77) as abcdef1, "feat(apps): change 77 (#77)". Tested in batch queue/batch-1 with nothing else, in the full tier.'])
  })

  // All the checks are done a moment before GitHub marks the run completed (a normal window). The first version dropped the
  // batch there: a lost full run, and its session told the batch of one ended without landing it
  it('waits for the run to be completed when every check has reported, instead of dropping the batch', async () => {
    runtime(state(reports(6000), { batchFiles: ['packages/ui/src/App.tsx'] }, null), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'ci', 'the batch to run')
    await morePolls(6)
    expect(batchesOnDisk()).toHaveLength(1)
    expect(batchesOnDisk()[0]).toMatchObject({ state: 'ci', tier: 'full' })
    expect(told()).toEqual([])
    expect(writes().map(short2)).not.toContain('merge 77')
    expect(gh().dispatched).toHaveLength(1)
    // GitHub marks the run completed: it lands from that run
    patchGh((s) => {
      s.runs[ONE] = [batchRun('success')]
    })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(gh().dispatched).toHaveLength(1)
    expect(told()).toEqual([])
  })

  // build.yml's e2e-chromium-skipped reports a check named like a real shard and succeeds, when the branch's own classify
  // says only documents changed. A name alone cannot tell it from the shard: the job's step that runs the scenarios can
  it('does not take the stand-in of a left-out shard for the shard that was to run, though it reports success under its name', async () => {
    runtime(state(reports(6000), { batchFiles: ['packages/ui/src/App.tsx'], standIns: ['e2e (chromium 1/1)'] }), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    expect(writes().map(short2)).not.toContain('merge 77')
    expect(told()).toHaveLength(1)
    expect(told()[0]!.text).toContain('not every heavy job (e2e (webkit *), e2e (chromium *)) was reported, succeeded and ran its scenarios (the step pnpm e2e (shard *))')
  })

  it('lands a batch that changes nothing the UI scenarios see from the fast tier, as before, saying so', async () => {
    runtime(state(reports(6000, { full: false }), { batchFiles: ['docs/a.md', 'tooling/x.test.ts', 'packages/ui/src/App.test.tsx', '.centralu/apps/project-board/queue.mjs'] }), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(gh().dispatched).toEqual([{ ref: 'queue/batch-1', inputs: { tier: 'quick' } }])
    expect(batchesOnDisk()[0]).toMatchObject({ tier: 'quick', tierWhy: 'it changes nothing the UI scenarios see (4 files)' })
    expect(batchEvents().some((t) => t.includes('to run the fast tier: it changes nothing the UI scenarios see (4 files).'))).toBe(true)
    expect(notices()[0]!.text).toContain('Tested in batch queue/batch-1 with nothing else, in the fast tier.')
  })

  it.each([
    ['a renamed file counts under both names', [{ filename: 'docs/moved.md', previous_filename: 'packages/ui/src/old.tsx' }]],
    ['the host', ['packages/agent-host/src/sessions/x.ts']],
    ['the protocol', ['packages/protocol/src/messages.ts']],
    ['the scenarios themselves', ['e2e/some.spec.ts']],
    ['the build config', ['pnpm-lock.yaml']],
  ])('counts %s as a change to the screen', async (_what, batchFiles) => {
    runtime(state(reports(6000), { batchFiles }), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(gh().dispatched[0].inputs).toEqual({ tier: 'full', everything: 'false' })
  })

  it('does not land a batch that changes the screen from a run where a heavy job was skipped, or never reported: it tells the session', async () => {
    runtime(state(reports(6000, { e2e: 'skipped' }), { batchFiles: ['packages/ui/src/App.tsx'] }), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    expect(writes().map(short2)).not.toContain('merge 77')
    expect(told()).toHaveLength(1)
    expect(told()[0]!.text).toContain('its batch of one ran the full tier and ended without landing it: batch queue/batch-1: its run passed, but not every heavy job (e2e (webkit *), e2e (chromium *)) was reported, succeeded and ran its scenarios (the step pnpm e2e (shard *)), and it changes the screen (packages/ui/src/App.tsx), so nothing lands from it.')
  })

  it('does not land a batch that changes the screen from a run that was only the fast tier, whatever CI ran', async () => {
    const quickWorkflow = ['jobs:', ...['changes', 'full tier', 'verify', 'windows tests (vitest 1/2)', 'windows tests (vitest 2/2)'].flatMap((n, i) => [`  j${i}:`, `    name: ${n}`]), ''].join('\n')
    runtime(state(reports(6000, { full: false }), { batchFiles: ['packages/ui/src/App.tsx'], workflow: quickWorkflow }), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    expect(writes().map(short2)).not.toContain('merge 77')
    expect(told()[0]!.text).toContain('its run passed without running the full tier (the "full tier" check did not pass), and nothing lands from less (it changes the screen (packages/ui/src/App.tsx))')
  })

  it('tells the session which tier a batch of one failed in', async () => {
    runtime(state(reports(6000, { e2e: 'failure' }), { batchFiles: ['packages/ui/src/App.tsx'], logs: { '60006': 'FAIL e2e window.spec.ts > opens the window\nError: expected 1 window' } }, 'failure'), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    expect(told()).toHaveLength(1)
    expect(told()[0]!.text).toContain('#77 failed alone in batch queue/batch-1, a run of the full tier on main at main0')
    expect(writes().map(short2)).not.toContain('merge 77')
  })

  it.each([
    ['the judge is not on main', { files: {} }, 'ci-changes.mjs is not on main'],
    ['the judge does not answer', { files: { '.github/scripts/ci-changes.mjs': 'process.exit(3)' } }, 'it could not be told whether it changes the screen'],
    ['GitHub lists too many files to be sure', { batchFiles: Array.from({ length: 300 }, (_, i) => `docs/${i}.md`) }, 'the files it changes are not known'],
  ])('runs the heavy jobs for a batch it cannot judge: %s', async (_what, patch: Gh, why) => {
    runtime(state(reports(6000), { batchFiles: ['docs/a.md'], ...patch }), ENV)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(gh().dispatched[0].inputs).toEqual({ tier: 'full', everything: 'false' })
    expect(batchesOnDisk()[0].tierWhy).toContain(why)
  })

  it('keeps running the full tier for every batch under ci.landTier full, and asks for nothing more', async () => {
    runtime(state(reports(6000), { batchFiles: ['docs/a.md'] }), { ...TIERS, PROJECT_BOARD_CI_SCREEN: JSON.stringify(SCREEN) })
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(gh().dispatched[0].inputs).toBeNull()
    expect(batchesOnDisk()[0]).toMatchObject({ tier: 'full', tierWhy: null })
  })
})

/**
 * #957: an agent with this app attached typed `gh pr merge` instead of using queue_merge, because
 * deferred tools show only their names until searched. The descriptions carry the gh command each tool
 * replaces, so a search for the verb finds it, and help answers which tool for which task, on demand
 * (not in the server's instructions, which every session's cached prompt would carry, #512).
 */

describe("the merge queue keeps its messages until their owner acknowledges them (#1351)", { timeout: 90_000 * SLOW }, () => {
  /** A queue with messages for two owners, and an event that is not a message */
  function mailbox() {
    const q = emptyQueue()
    const at = (m: number) => new Date(NOW + m * 60_000).toISOString()
    pushEvent(q, { repo: R, pr: 77, owner: 'tester' }, { kind: 'attention', text: '#77 needs attention: dirty.', notify: true, at: at(0) })
    pushEvent(q, { repo: R, pr: 78, owner: 'tester' }, { kind: 'merged', text: 'merged #78.', notify: true, at: at(1) })
    pushEvent(q, { repo: R, pr: 79, owner: 'other' }, { kind: 'attention', text: '#79 needs attention: failed.', notify: true, at: at(2) })
    pushEvent(q, { repo: R, pr: 80, owner: 'tester' }, { kind: 'queued', text: '#80 queued.', at: at(3) })
    return q
  }
  const seqs = (list: { seq: number }[]) => list.map((e) => e.seq)

  it('keeps a message that needs attention unacknowledged for its owner, however far a watch has read, until it is acknowledged', () => {
    const q = mailbox()
    pushEvent(q, { repo: R, pr: 81, owner: 'tester' }, { kind: 'attention', text: '#81 needs attention: dirty.', notify: true, at: new Date(NOW).toISOString() })
    expect(seqs(unacked(q, 'tester'))).toEqual([1, 5])
    // An event before a watch's --after is still listed, and a watch without --after starts at the oldest
    expect(watchState(q, { owner: 'tester', after: 5 }).news).toEqual([])
    expect(seqs(unacked(q, 'tester'))).toEqual([1, 5])
    expect(watchStart(q, 'tester')).toBe(0)
    expect(seqs(watchState(q, { owner: 'tester', after: watchStart(q, 'tester') }).news)).toEqual([1, 2, 5])
    // Acknowledged by seq, then every one up to a seq; another owner's are untouched
    expect(acknowledge(q, 'tester', { seqs: [1], at: 'x' })).toBe(1)
    expect(seqs(unacked(q, 'tester'))).toEqual([5])
    expect(acknowledge(q, 'tester', { upTo: 9, at: 'x' })).toBe(1)
    expect(unacked(q, 'tester')).toEqual([])
    expect(seqs(unacked(q, 'other'))).toEqual([3])
    // What was acknowledged is no news to a watch, and a watch with nothing left starts at the end
    expect(seqs(watchState(q, { owner: 'tester', after: 0 }).news)).toEqual([2])
    expect(watchStart(q, 'tester')).toBe(q.seq)
  })

  it('counts a landing or another message for information as acknowledged once posted, and never lists it', () => {
    const q = mailbox()
    // The landing (#78) is not listed, before or after it is posted
    expect(seqs(unacked(q))).toEqual([1, 3])
    expect(seqs(watchState(q, { owner: 'tester', after: 0 }).news)).toEqual([1, 2])
    // Posted into its session: no news to a watch any more; one needing attention stays, posted or not
    for (const e of q.events) Object.assign(e, { told: true, toldAt: new Date(NOW).toISOString() })
    expect(seqs(watchState(q, { owner: 'tester', after: 0 }).news)).toEqual([1])
    expect(seqs(unacked(q))).toEqual([1, 3])
    // Only one needing attention says how to acknowledge it
    expect(noticeText(q.events[0])).toBe(`#77 needs attention: dirty.\nAck it with the board app's ack tool once handled: ack({ owner: "tester", seqs: [1] }) (merge_queue lists what is unacknowledged).`)
    expect(noticeText(q.events[1])).toBe('merged #78.')
  })

  it('acknowledges nothing for an empty or blank owner, rather than every owner\'s', () => {
    const q = mailbox()
    for (const owner of ['', ' ', '\t']) expect(acknowledge(q, owner, { upTo: 99, at: 'x' })).toBe(0)
    expect(seqs(unacked(q))).toEqual([1, 3])
  })

  it('posts a message that needs attention again once, when it is still unacknowledged 30 minutes after it was posted', () => {
    const q = mailbox()
    const told = (seq: number, m: number) => Object.assign(q.events.find((e: { seq: number }) => e.seq === seq), { told: true, toldAt: new Date(NOW + m * 60_000).toISOString() })
    // Not posted yet (Centralu down, or still trying): no repost before its first post, however old
    expect(dueReposts(q, NOW + 120 * 60_000)).toEqual([])
    told(1, 0)
    // Posted late, 60 minutes after it was said: 30 minutes from then, not at once
    told(3, 60)
    expect(dueReposts(q, NOW + 29 * 60_000)).toEqual([])
    expect(seqs(dueReposts(q, NOW + 61 * 60_000))).toEqual([1])
    markReposted(q, 1, 'x')
    expect(dueReposts(q, NOW + 89 * 60_000)).toEqual([])
    expect(seqs(dueReposts(q, NOW + 91 * 60_000))).toEqual([3])
    acknowledge(q, 'other', { seqs: [3], at: 'x' })
    expect(dueReposts(q, NOW + 120 * 60_000)).toEqual([])
  })

  it('counts what a queue file from before acknowledging already said as acknowledged, and keeps new ones', () => {
    // A file written before #1351: no acksFrom, its messages never acknowledged, one told long ago
    const old = mailbox() as Record<string, unknown> & { events: Record<string, unknown>[] }
    delete old.acksFrom
    Object.assign(old.events[0]!, { told: true, toldAt: new Date(NOW).toISOString() })
    const q = normalize(JSON.parse(JSON.stringify(old)))
    expect(unacked(q)).toEqual([])
    expect(dueReposts(q, NOW + 120 * 60_000)).toEqual([])
    expect(watchStart(q, 'tester')).toBe(q.seq)
    // What it says from now on is kept, and stays so once written and read again
    pushEvent(q, { repo: R, pr: 81, owner: 'tester' }, { kind: 'attention', text: '#81 needs attention.', notify: true, at: new Date(NOW).toISOString() })
    expect(seqs(unacked(normalize(JSON.parse(JSON.stringify(q))), 'tester'))).toEqual([5])
  })

  it('keeps no message that has no owner to acknowledge it', () => {
    const q = mailbox()
    // Needing attention, with no owner (an item queued by hand with none)
    pushEvent(q, { repo: R, pr: 81, owner: null }, { kind: 'attention', text: '#81 needs attention.', notify: true, at: new Date(NOW).toISOString() })
    expect(seqs(unacked(q))).toEqual([1, 3])
    expect(watchStart(q)).toBe(0)
  })

  it('lists them first in merge_queue for their owner, acks them with ack, and posts one again into its session once', async () => {
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY' }) } }), { PROJECT_BOARD_QUEUE_REPOST_MS: '400', PROJECT_BOARD_QUEUE_TELL_RETRY_MS: '1' })
    const told: string[] = []
    rt!.attachBrokerHost(fakeBrokerHost({ appNotice: async (_sessionId, text) => void told.push(text) }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    // Posted once, with how to acknowledge it; then once more, 400 ms on (30 minutes in the product), and no more
    await until(() => told.length >= 2, 'the repost')
    await polls(11)
    expect(told).toHaveLength(2)
    expect(told[0]).toMatch(/needs attention: conflict\.[\s\S]*Ack it with the board app's ack tool once handled: ack\(\{ owner: "tester", seqs: \[\d+\] \}\)/)
    expect(told[1]).toMatch(/^Merge queue: still not acknowledged after \d+ minutes: Merge queue: #77/)
    // merge_queue lists it first for its owner
    const listed = await call('merge_queue', { owner: 'tester' })
    expect(listed.text.split('\n')[1]).toMatch(/^1 message not acknowledged by tester; act on each, then ack\(\{ owner, seqs \}\)/)
    expect(listed.data.unacked).toHaveLength(1)
    const seq = listed.data.unacked[0].seq
    expect((await call('merge_queue', { owner: 'someone else' })).data.unacked).toEqual([])
    // Without an owner, only how many and whose
    expect((await call('merge_queue', {})).text.split('\n')[1]).toBe('1 message not acknowledged, for tester (1); merge_queue({ owner }) lists them.')
    // A blank owner is refused, and acknowledges nobody's
    const blank = await call('ack', { owner: ' ', upTo: 999 })
    expect(blank.isError).toBe(true)
    expect(blank.text).toBe('Nothing acknowledged: give the owner you queued with.')
    expect((await call('merge_queue', { owner: 'tester' })).data.unacked).toHaveLength(1)
    // Acknowledged: gone from the list
    const acked = await call('ack', { owner: 'tester', seqs: [seq] })
    expect(acked.text).toBe('Acknowledged 1 message for tester; 0 still not acknowledged.')
    expect((await call('merge_queue', { owner: 'tester' })).data.unacked).toEqual([])
  })

  it('tries a repost Centralu did not take again, as a first post, and records it posted only once it is', async () => {
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY' }) } }), { PROJECT_BOARD_QUEUE_REPOST_MS: '400', PROJECT_BOARD_QUEUE_TELL_RETRY_MS: '1' })
    const told: string[] = []
    let refused = 0
    rt!.attachBrokerHost(
      fakeBrokerHost({
        appNotice: async (_sessionId, text) => {
          // Centralu restarting: the first two reposts are not taken
          if (text.startsWith('Merge queue: still not acknowledged') && refused < 2) {
            refused += 1
            throw new Error('Centralu is restarting')
          }
          told.push(text)
        },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until(() => told.length >= 2, 'the repost, taken on the third try')
    expect(refused).toBe(2)
    expect(told[1]).toMatch(/^Merge queue: still not acknowledged after \d+ minutes: /)
    // Recorded once taken (written just after the post), and not as given up on
    await until(() => Boolean(notices().find((e) => e.kind === 'attention')?.repostedAt), 'the repost recorded')
    expect(notices().find((e) => e.kind === 'attention')?.reposted).toBeUndefined()
  })

  it('replays what was not acknowledged to a watch restarted with no --after, and not once acknowledged', async () => {
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY' }) } }), IDLE_SERVER)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const dir = queueFile().replace(/[\\/]merge-queue\.json$/, '')
    // The message is said while nobody watches (a watch run once and gone)
    const first = await watch(['watch', '--data', dir, '--owner', 'tester'])
    expect(first.code).toBe(3)
    // A watch started again with no --after hears it again: it is not acknowledged
    const again = await watch(['watch', '--data', dir, '--owner', 'tester', '--minutes', '0.05'])
    expect(again.code).toBe(3)
    expect(again.out).toMatch(/^Merge queue: #77 \(feat\(apps\): change 77\) needs attention: conflict\./)
    const seq = (await call('merge_queue', { owner: 'tester' })).data.unacked[0].seq
    await call('ack', { owner: 'tester', seqs: [seq] })
    await rt!.dispose()
    forgetApp()
    const quiet = await watch(['watch', '--data', dir, '--owner', 'tester', '--minutes', '0.02'])
    expect(quiet.code).toBe(6)
    expect(quiet.out).not.toContain('needs attention')
  })
})

/*
 * #1509 item 4: what the queue used to tell a session to do by hand, it does. The app against the fake `gh`, with a queue
 * file seeded the way `queue_merge` writes it (the notice address of the queuing session on the item) and `opened-prs.json`
 * as `open_pr` writes it (the notice address of the session that opened the pull request).
 */

describe('the merge queue does by itself what it told a session to do by hand (#1509 item 4)', { timeout: 120_000 * SLOW }, () => {
  const dataDir = () => join(root, 'data', 'app-data', 'p1', 'project-board')
  const seedOpened = (opened: Record<string, unknown>) => {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(join(dataDir(), 'opened-prs.json'), JSON.stringify(opened))
  }
  const item = (extra: Record<string, unknown> = {}) => ({
    repo: R,
    pr: 77,
    lowers: [],
    owner: 'tester',
    author: 'tester',
    notice: 'addr-tester',
    state: 'ci',
    title: 'feat(apps): change 77',
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reruns: {},
    ...extra,
  })
  const events = () => queueOnDisk().events as { kind: string; notify: boolean; text: string; to?: string }[]
  const dirty = () => ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }) } })
  const opened = (notice: string, draft = false) => ({ [`${R}#77`]: { notice, draft, at: new Date().toISOString() } })

  describe('a conflict it cannot fix goes to the author session', () => {
    it('posts it into the author session itself when that session opened the pull request through open_pr, and tells the queuing session it did', async () => {
      seedQueue([item({ author: 'writer' })])
      seedOpened(opened('addr-writer'))
      runtime(dirty())
      await until((x) => stateOf(x) === 'attention', 'the hand-off')
      const attention = events().filter((e) => e.kind === 'attention')
      expect(attention).toHaveLength(1)
      expect(attention[0]!.to).toBe('addr-tester')
      expect(attention[0]!.text).toContain('Author session: the session that opened it (queue_merge named writer as its author). The queue is posting this into it itself, so relay it only if it does not answer: "Merge main into feat/b77 and push again')
      expect(attention[0]!.text).not.toContain('Relay this to it')
      const posted = events().filter((e) => e.kind === 'handoff')
      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatchObject({ notify: true, to: 'addr-writer', owner: null })
      expect(posted[0]!.text).toBe('Merge queue: #77 (feat(apps): change 77) is your pull request and it conflicts with main: Merge main into feat/b77 and push again; conflicted files: not known (GitHub says it conflicts).')
      // Once per head
      await morePolls()
      expect(events().filter((e) => e.kind === 'handoff')).toHaveLength(1)
      // A reader of merge_queue never sees an address
      expect(JSON.stringify((await call('merge_queue', { all: true })).data)).not.toContain('addr-')
    })

    it('says so, and posts nothing else, when the queuing session is the one that opened it', async () => {
      seedQueue([item()])
      seedOpened(opened('addr-tester'))
      runtime(dirty())
      await until((x) => stateOf(x) === 'attention', 'the hand-off')
      expect(events().filter((e) => e.kind === 'handoff')).toEqual([])
      const attention = events().find((e) => e.kind === 'attention')!
      expect(attention.text).toContain('#77 is your own pull request (author session: tester): fix it in this session: "Merge main into feat/b77')
    })

    it('says the same when no author was named at queue time, and the event names the session it went to', async () => {
      seedQueue([item({ author: null })])
      seedOpened(opened('addr-tester'))
      runtime(dirty())
      await until((x) => stateOf(x) === 'attention', 'the hand-off')
      const attention = events().find((e) => e.kind === 'attention')!
      expect(attention.text).toContain('#77 is your own pull request: fix it in this session: "Merge main into feat/b77')
      expect(attention.text).not.toContain('No author session is recorded')
      expect(events().find((e) => e.kind === 'conflict' && e.text.includes('handed to'))!.text).toContain('conflict handed to the session that queued it, its author')
    })

    it('still asks the queuing session to relay it when the author never called this app, so the queue has no address for it', async () => {
      seedQueue([item({ author: 'writer' })])
      runtime(dirty())
      await until((x) => stateOf(x) === 'attention', 'the hand-off')
      expect(events().filter((e) => e.kind === 'handoff')).toEqual([])
      expect(events().find((e) => e.kind === 'attention')!.text).toContain('Author session: writer. Relay this to it (it has not called this app, so the queue has no address to post to)')
    })
  })

  describe('a draft', () => {
    it('is marked ready by the queue when the session that queued it opened it through open_pr as a draft, and lands when green', async () => {
      seedQueue([item()])
      seedOpened(opened('addr-tester', true))
      runtime(ghState({ prs: { '77': ghPr(77, { isDraft: true, mergeStateStatus: 'DRAFT' }) } }))
      await until((x) => stateOf(x) === 'merged', 'the merge')
      expect(writes().map((w) => w[0])).toEqual(['ready', 'merge', 'delete'])
      expect(events().find((e) => e.kind === 'action')!.text).toContain('was opened as a draft by the session queuing it; the queue marked it ready for review')
    })

    it.each([
      ['it was ready once since, and a person turned it back into a draft to hold it', { [`${R}#77`]: { notice: 'addr-tester', draft: true, readied: true, at: new Date().toISOString() } }, {}],
      ['another session opened it', opened('addr-someone-else', true), {}],
      ['it was opened ready and a person (or open_pr, for a stack) made it a draft since', opened('addr-tester', false), {}],
      ['a pull request is stacked on its branch: it is a stack lower', opened('addr-tester', true), { basedOn: { 'feat/b77': [{ number: 78 }] } }],
      ['the app did not open it', {}, {}],
    ])('is left to its session when %s: a draft may be a hold', async (_why, record, more) => {
      seedQueue([item()])
      seedOpened(record)
      runtime(ghState({ prs: { '77': ghPr(77, { isDraft: true, mergeStateStatus: 'DRAFT' }) }, ...more }))
      const q = await until((x) => stateOf(x) === 'attention', 'attention')
      expect(q.queue[0].reason.kind).toBe('draft')
      // The queuing session is told, not left waiting on a draft it did not make (#1673)
      expect(events().filter((e) => e.kind === 'attention' && e.notify).map((e) => e.text)).toEqual([expect.stringContaining('#77 is a draft, and the queue never merges a draft')])
      await morePolls()
      expect(writes()).toEqual([])
    })
  })

  describe('a draft, remembered once it was ready', () => {
    const recordOf = () => JSON.parse(readFileSync(join(dataDir(), 'opened-prs.json'), 'utf8'))[`${R}#77`]

    it('is written down when the queue marks it ready, so a person who turns it back into a draft is not undone', async () => {
      seedQueue([item()])
      seedOpened(opened('addr-tester', true))
      runtime(ghState({ prs: { '77': ghPr(77, { isDraft: true, mergeStateStatus: 'DRAFT' }) } }))
      await until((x) => stateOf(x) === 'merged', 'the merge')
      expect(writes().map((w) => w[0])).toEqual(['ready', 'merge', 'delete'])
      expect(recordOf()).toMatchObject({ notice: 'addr-tester', draft: true, readied: true })
    })

    it('is written down when it is seen ready without the queue (the session marked it itself)', async () => {
      seedQueue([item()])
      seedOpened(opened('addr-tester', true))
      runtime(ghState())
      await until((x) => stateOf(x) === 'merged', 'the merge')
      expect(writes().map((w) => w[0])).toEqual(['merge', 'delete'])
      expect(recordOf()).toMatchObject({ notice: 'addr-tester', draft: true, readied: true })
    })

    it('is not written for a pull request that was opened ready: there is nothing to hold', async () => {
      seedQueue([item()])
      seedOpened(opened('addr-tester', false))
      runtime(ghState())
      await until((x) => stateOf(x) === 'merged', 'the merge')
      expect(recordOf().readied).toBeUndefined()
    })
  })

  describe('a pull request the queue cannot batch', () => {
    const quick = [ghCheck('full tier', 'skipped', 10), ghCheck('verify', 'success', 11), ghCheck('windows tests', 'success', 12)]
    const unbatched = (extra: Record<string, unknown> = {}) =>
      ghState({
        prs: { '77': ghPr(77, { headRefName: 'feat/unbatched', title: 'feat(x): unbatched', ...extra }) },
        checks: { [SHA]: quick },
        runs: { [SHA]: [ghRun('success')] },
      })

    it('has the full tier started on its branch, once, when it passed only the quick tier', async () => {
      seedQueue([item({ title: 'feat(x): unbatched' })])
      runtime(unbatched(), NO_BATCH)
      await until(() => writes().some((w) => w[0] === 'dispatch'), 'the dispatch')
      await morePolls()
      expect(writes().filter((w) => w[0] === 'dispatch')).toEqual([['dispatch', 'feat/unbatched']])
      expect(gh().dispatched).toEqual([{ ref: 'feat/unbatched', inputs: null }])
      expect(events().find((e) => e.kind === 'action')!.text).toContain('started the full tier on feat/unbatched')
      expect(queueOnDisk().items[0].fullDispatch).toMatchObject({ head: SHA })
    })

    it('writes the dispatch down before asking for it, so a call the network cuts off is not repeated into a second run', async () => {
      seedQueue([item({ title: 'feat(x): unbatched' })])
      runtime(
        ghState({
          prs: { '77': ghPr(77, { headRefName: 'feat/unbatched', title: 'feat(x): unbatched' }) },
          checks: { [SHA]: quick },
          runs: { [SHA]: [ghRun('success')] },
          // gh cannot reach GitHub at the dispatch: the queue pauses, and the item remembers it was asked for on this head
          dispatchError: 'dial tcp: lookup api.github.com: no such host',
        }),
        NO_BATCH,
      )
      await until(() => queueOnDisk().pause?.kind === 'network', 'the pause')
      expect(queueOnDisk().items[0].fullDispatch).toMatchObject({ head: SHA })
      expect(queueOnDisk().items[0].fullDispatch.refused).toBeUndefined()
    })

    it("does not run a fork's branch here: it still asks its session", async () => {
      seedQueue([item()])
      runtime(unbatched({ isCrossRepository: true }), NO_BATCH)
      await until((x) => stateOf(x) === 'attention', 'attention')
      expect(writes()).toEqual([])
      expect(queueOnDisk().items[0].reason.kind).toBe('full-tier')
    })
  })

  describe('a stack top whose lower merged', () => {
    /** `up` (#77) is based on `low` (#76), which was squash-merged into main; origin.git stands for GitHub */
    function restackable({ lowerMerged = true }: { lowerMerged?: boolean } = {}) {
      const { origin, work } = githubStandIn(root)
      const commit = (file: string, text: string, message: string) => {
        writeFileSync(join(work, file), text)
        g(work, 'add', file)
        g(work, 'commit', '-q', '-m', message)
        return g(work, 'rev-parse', 'HEAD')
      }
      commit('a.txt', 'a\n', 'base')
      g(work, 'checkout', '-q', '-b', 'low')
      const low = commit('b.txt', '1\n', 'low 1')
      g(work, 'checkout', '-q', '-b', 'up')
      const up = commit('c.txt', 'u\n', 'up 1')
      g(work, 'checkout', '-q', 'main')
      g(work, 'merge', '-q', '--squash', 'low')
      g(work, 'commit', '-q', '-m', 'low (#76)')
      const squash = g(work, 'rev-parse', 'HEAD')
      g(work, 'push', '-q', 'origin', 'main', 'low', 'up', `${low}:refs/pull/76/head`)
      g(work, 'checkout', '-q', '-b', 'mine', squash)
      return { work, origin, low, up, squash, lowerMerged }
    }
    const stackState = (s: ReturnType<typeof restackable>) =>
      ghState({
        prs: {
          '76': ghPr(76, { headRefName: 'low', headRefOid: s.low, state: s.lowerMerged ? 'MERGED' : 'OPEN', mergeCommit: s.lowerMerged ? { oid: s.squash } : null }),
          '77': ghPr(77, { headRefName: 'up', headRefOid: s.up, baseRefName: 'low', mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }),
        },
      })
    const stackRuntime = (s: ReturnType<typeof restackable>) => {
      mkdirSync(appTmp(), { recursive: true })
      const tmp = { TMPDIR: appTmp(), TEMP: appTmp(), TMP: appTmp() }
      return runtime(stackState(s), { PROJECT_BOARD_QUEUE_CHECKOUT: s.work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig'), ...tmp }, gitWrapper(fake.bin))
    }

    it("is restacked onto the lower one's merge commit and pushed with a lease, as rebase_stack would, with nobody told to run it", async () => {
      const s = restackable()
      seedQueue([item()])
      stackRuntime(s)
      await until(() => events().some((e) => e.kind === 'conflict'), 'the restack')
      const pushed = g(s.work, '--git-dir', s.origin, 'rev-parse', 'refs/heads/up')
      expect(pushed).not.toBe(s.up)
      // Replayed onto the squash commit: its parent is the lower one's merge commit, and it holds the upper one's own change only
      expect(g(s.work, '--git-dir', s.origin, 'rev-parse', `${pushed}^`)).toBe(s.squash)
      expect(g(s.work, '--git-dir', s.origin, 'show', `${pushed}:c.txt`)).toBe('u')
      expect(writes().map((w) => w[0])).toContain('base')
      const step = events().find((e) => e.kind === 'conflict')!
      expect(step.text).toContain('restacked onto the merge commit of the pull request under it, as rebase_stack would')
      expect(events().filter((e) => e.kind === 'attention')).toEqual([])
      // The person's checkout is as it was
      expect(g(s.work, 'branch', '--show-current')).toBe('mine')
    })

    it('hands it to its author as before when the pull request under it has not merged', async () => {
      const s = restackable({ lowerMerged: false })
      seedQueue([item({ author: 'writer' })])
      stackRuntime(s)
      const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
      expect(g(s.work, '--git-dir', s.origin, 'rev-parse', 'refs/heads/up')).toBe(s.up)
      expect(q.queue[0].reason.kind).toBe('conflict')
      expect(q.queue[0].reason.text).toContain('Restacking it was tried and refused')
    })

    it("pushes with a lease on the head it read, in a checkout whose own record of the branch is old (a single-branch clone's)", async () => {
      const s = restackable()
      // Fetching the branch does not refresh a record this clone does not track: a bare --force-with-lease would expect the old head
      g(s.work, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')
      g(s.work, 'update-ref', 'refs/remotes/origin/up', s.low)
      seedQueue([item()])
      stackRuntime(s)
      await until(() => events().some((e) => e.kind === 'conflict'), 'the restack')
      const pushed = g(s.work, '--git-dir', s.origin, 'rev-parse', 'refs/heads/up')
      expect(pushed).not.toBe(s.up)
      expect(g(s.work, '--git-dir', s.origin, 'rev-parse', `${pushed}^`)).toBe(s.squash)
      expect(events().filter((e) => e.kind === 'attention')).toEqual([])
    })

    it('does not overwrite a push that lands after the queue read the branch: the lease refuses it and the author is told', async () => {
      const s = restackable()
      // The author's push arrives between the queue's read and its own push (git runs this hook just before it sends anything), and
      // the person's own fetch in this checkout moves its record of the remote branch to match: a bare --force-with-lease would trust
      // that record and overwrite the author, where a lease on the head the queue tested refuses
      const hook = join(s.work, '.git', 'hooks', 'pre-push')
      const slash = (p: string) => p.replace(/\\/g, '/')
      writeFileSync(hook, `#!/bin/sh\ngit --git-dir="${slash(s.origin)}" update-ref refs/heads/up ${s.low}\ngit update-ref refs/remotes/origin/up ${s.low}\n`, { mode: 0o755 })
      seedQueue([item({ author: 'writer' })])
      stackRuntime(s)
      const q = await until((x) => stateOf(x) === 'attention', 'the hand-off')
      // The author's head stands: nothing of the queue's was forced over it
      expect(g(s.work, '--git-dir', s.origin, 'rev-parse', 'refs/heads/up')).toBe(s.low)
      expect(q.queue[0].reason.kind).toBe('conflict')
      expect(q.queue[0].reason.text).toContain('Pushing up failed')
    })

    it('does not hand a restack to its author when the remote cannot be reached: the network pauses the queue, as any lost network does', async () => {
      const s = restackable()
      // GitHub's stand-in is gone: nothing listens there
      g(s.work, 'config', '--replace-all', `url.http://127.0.0.1:9/gone.git.insteadOf`, 'https://github.com/ijun17/centralu.git')
      g(s.work, 'config', '--unset-all', `url.${s.origin}.insteadOf`)
      seedQueue([item({ author: 'writer' })])
      stackRuntime(s)
      await until(() => queueOnDisk().pause?.kind === 'network', 'the pause')
      const it = queueOnDisk().items[0]
      expect(it.state).not.toBe('attention')
      expect(it.lastError).toContain('could not reach the remote while restacking')
      expect(events().filter((e) => e.kind === 'attention' || e.kind === 'handoff')).toEqual([])
    })
  })
})

