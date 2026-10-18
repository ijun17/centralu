import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import { fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
import { SLOW } from './test-timing.js'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { decideBefore, decideCi, emptyQueue, enqueue, lowerFailureCounts, noticeKey, dequeue, normalize, onlySupersededFailures, watchState } from '../.centralu/apps/project-board/queue.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { evaluateChecks } from '../.centralu/apps/project-board/ci.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { latestRuns, takeLease, releaseLease } from '../.centralu/apps/project-board/queue-driver.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { batchCandidates, decideLanding, endBatch, formBatch, markBatchless, onlyCancelledByBatch, splitBatch } from '../.centralu/apps/project-board/batch.mjs'

/**
 * The project board app's merge queue (#956): queue_merge, merge_queue, unqueue, the driver that runs
 * in the app's server, and the watch command a session runs in the background. First the decisions
 * as pure functions (queue.mjs), then the app run by the real external-app runtime against a fake `gh`
 * on PATH that answers what the queue reads and records every write it is asked for. Nothing here
 * reaches GitHub, and no real pull request is merged.
 *
 * Why: during the round-4 refactor a detached shell loop did this. When pull requests went DIRTY it
 * could only write a log line, and nothing moved for three and a half hours.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const WATCH = join(REPO_ROOT, '.centralu/apps/project-board/bin/merge-queue.mjs')
const R = 'ijun17/centralu'
const ref = (_repo: string, n: number) => `#${n}`
const SHA = 'c0ffee0000000000000000000000000000000000'
const SHA2 = 'beef000000000000000000000000000000000000'

// --- The decisions ---------------------------------------------------------------------------------

type Row = { name: string; status: string; conclusion: string | null; id?: number; jobId?: string; kind: 'run'; at?: string }
const check = (name: string, conclusion: string | null, extra: Partial<Row> = {}): Row => ({ kind: 'run', name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, ...extra })
const checksOf = (rows: Row[]) => evaluateChecks({ required: ['verify', 'windows tests'], reported: rows })
const GREEN = () => checksOf([check('verify', 'success'), check('windows tests', 'success')])
const openPr = (extra: Record<string, unknown> = {}) => ({
  number: 77,
  title: 'feat(apps): a merge queue',
  body: '',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: SHA,
  headRefName: 'feat/queue',
  baseRefName: 'main',
  ...extra,
})
const fresh = (extra: Record<string, unknown> = {}) => ({ repo: R, pr: 77, lowers: [], owner: 'me', state: 'ci', head: SHA, reruns: {}, noCiSince: null, ...extra })
const NOW = Date.parse('2026-10-17T10:00:00Z')
const run = (conclusion: string | null, attempt = 1, id = 900) => ({ id, attempt, status: conclusion === null ? 'in_progress' : 'completed', conclusion })
const maintainer = { maintain: true }

describe('what the merge queue decides for one poll', () => {
  it('merges only a green, CLEAN, open pull request for a maintainer, and never a draft', () => {
    expect(decideCi({ item: fresh(), pr: openPr(), checks: GREEN(), defaultBranch: 'main', now: NOW, ref })).toMatchObject({ action: { type: 'merge' } })
    expect(decideBefore({ item: fresh(), permissions: { push: true }, pr: openPr(), ref })).toMatchObject({ state: 'attention', reason: { kind: 'permission' } })
    expect(decideBefore({ item: fresh(), permissions: maintainer, pr: openPr({ isDraft: true }), ref })).toMatchObject({ state: 'attention', reason: { kind: 'draft' } })
    expect(decideBefore({ item: fresh(), permissions: maintainer, pr: openPr({ mergeStateStatus: 'DIRTY' }), ref })).toMatchObject({ state: 'attention', reason: { kind: 'dirty' } })
    expect(decideBefore({ item: fresh(), permissions: maintainer, pr: openPr(), ref })).toBe(null)
    // Not green is never merged: pending, nothing reported, failing
    expect(decideCi({ item: fresh(), pr: openPr(), checks: checksOf([check('verify', null), check('windows tests', 'success')]), defaultBranch: 'main', now: NOW, ref }).action).toBeUndefined()
    expect(decideCi({ item: fresh(), pr: openPr(), checks: checksOf([]), defaultBranch: 'main', now: NOW, ref }).action).toBeUndefined()
    // GitHub still working out mergeability, or BEHIND / BLOCKED
    expect(decideCi({ item: fresh(), pr: openPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), checks: GREEN(), defaultBranch: 'main', now: NOW, ref })).toMatchObject({ state: 'waiting' })
    expect(decideCi({ item: fresh(), pr: openPr({ mergeStateStatus: 'BEHIND' }), checks: GREEN(), defaultBranch: 'main', now: NOW, ref }).reason.kind).toBe('behind')
    expect(decideCi({ item: fresh(), pr: openPr({ mergeStateStatus: 'BLOCKED' }), checks: GREEN(), defaultBranch: 'main', now: NOW, ref }).reason.kind).toBe('blocked')
  })

  it('reruns a cancelled run once per head, and asks for attention when it is cancelled again', () => {
    const cancelled = checksOf([check('verify', 'cancelled'), check('windows tests', 'success')])
    const first = decideCi({ item: fresh(), pr: openPr(), checks: cancelled, runs: [run('cancelled')], defaultBranch: 'main', now: NOW, ref })
    expect(first).toMatchObject({ state: 'ci', action: { type: 'rerun', runId: 900, failedOnly: false } })
    const after = fresh({ reruns: first.patch.reruns })
    // Asked for, not started yet: wait, do not ask again
    expect(decideCi({ item: after, pr: openPr(), checks: cancelled, runs: [run('cancelled')], defaultBranch: 'main', now: NOW + 60_000, ref })).toEqual({ state: 'ci' })
    const again = decideCi({ item: after, pr: openPr(), checks: cancelled, runs: [run('cancelled', 2)], defaultBranch: 'main', now: NOW + 600_000, ref })
    expect(again).toMatchObject({ state: 'attention', reason: { kind: 'cancelled' } })
    expect(again.action).toBeUndefined()
  })

  it('reruns failed jobs once per head; failing again needs attention, naming the job; a new head starts over', () => {
    const failing = checksOf([check('verify', 'success'), check('windows tests', 'failure', { jobId: '12' })])
    const first = decideCi({ item: fresh(), pr: openPr(), checks: failing, runs: [run('failure')], defaultBranch: 'main', now: NOW, ref })
    expect(first).toMatchObject({ action: { type: 'rerun', failedOnly: true } })
    const after = fresh({ reruns: first.patch.reruns })
    // Still running its rerun
    expect(decideCi({ item: after, pr: openPr(), checks: failing, runs: [run(null, 2)], defaultBranch: 'main', now: NOW, ref })).toEqual({ state: 'ci' })
    const twice = decideCi({ item: after, pr: openPr(), checks: failing, runs: [run('failure', 2)], defaultBranch: 'main', now: NOW, ref })
    expect(twice).toMatchObject({ state: 'attention', reason: { kind: 'failed', job: { name: 'windows tests', id: '12' } } })
    expect(twice.reason.text).toContain('"windows tests" (job 12) failed twice')
    // Pushed again: the reruns belong to the old head, so the new head gets its own
    expect(decideCi({ item: after, pr: openPr({ headRefOid: SHA2 }), checks: failing, runs: [run('failure', 1, 901)], defaultBranch: 'main', now: NOW, ref })).toMatchObject({ action: { type: 'rerun', runId: 901 } })
  })

  it('lands a stack through its top: retargets it from a lower branch, refuses another base, and keeps the subject within 72', () => {
    const top = openPr({ baseRefName: 'feat/lower' })
    expect(decideCi({ item: fresh({ lowers: [76] }), pr: top, checks: GREEN(), defaultBranch: 'main', lowerBranches: ['feat/lower'], now: NOW, ref })).toMatchObject({ action: { type: 'retarget', base: 'main' } })
    expect(decideCi({ item: fresh(), pr: top, checks: GREEN(), defaultBranch: 'main', lowerBranches: [], now: NOW, ref }).reason.kind).toBe('base')
    const long = openPr({ title: `feat(apps): ${'x'.repeat(70)}` })
    expect(decideCi({ item: fresh(), pr: long, checks: GREEN(), defaultBranch: 'main', now: NOW, ref }).reason.kind).toBe('subject')
  })

  it('merges only on CLEAN: UNSTABLE, HAS_HOOKS and UNKNOWN wait, and say so after a while', () => {
    for (const mergeStateStatus of ['UNSTABLE', 'HAS_HOOKS', 'UNKNOWN']) {
      const first = decideCi({ item: fresh(), pr: openPr({ mergeStateStatus }), checks: GREEN(), defaultBranch: 'main', now: NOW, ref })
      expect(first, mergeStateStatus).toMatchObject({ state: 'waiting', patch: { uncleanSince: new Date(NOW).toISOString() } })
      expect(first.action, mergeStateStatus).toBeUndefined()
      const later = decideCi({ item: fresh(first.patch), pr: openPr({ mergeStateStatus }), checks: GREEN(), defaultBranch: 'main', now: NOW + 31 * 60_000, ref })
      expect(later, mergeStateStatus).toMatchObject({ state: 'attention', reason: { kind: 'not-clean' } })
    }
  })

  it('merges a green UNSTABLE head when only a cancelled duplicate or an older run of the CI workflow did not pass (#1015)', () => {
    const wf = (id: number, conclusion: string | null, created: string, suite: number) => ({ id, workflow_id: 7, check_suite_id: suite, status: conclusion ? 'completed' : 'in_progress', conclusion, created_at: created })
    const job = (conclusion: string | null, suiteId: number) => ({ kind: 'run', name: 'verify', status: conclusion ? 'completed' : 'in_progress', conclusion, suiteId })
    // #971: run 39008366931 passed, its duplicate 39008366932 was cancelled, both on one head
    const runs = [wf(931, 'success', '2026-10-17T05:00:00Z', 51), wf(932, 'cancelled', '2026-10-17T05:00:02Z', 52)]
    expect(onlySupersededFailures([job('success', 51), job('cancelled', 52)], runs)).toBe(true)
    // An older run that failed, made moot by a newer success
    expect(onlySupersededFailures([job('failure', 50), job('success', 51)], [wf(930, 'failure', '2026-10-17T04:00:00Z', 50), runs[0]])).toBe(true)
    // Not moot: a newer failure, a run still going, no success at all, a check of another workflow, a failed status
    expect(onlySupersededFailures([job('success', 51), job('failure', 53)], [runs[0], wf(933, 'failure', '2026-10-17T06:00:00Z', 53)])).toBe(false)
    expect(onlySupersededFailures([job('success', 51), job(null, 53)], [runs[0], wf(933, null, '2026-10-17T06:00:00Z', 53)])).toBe(false)
    expect(onlySupersededFailures([job('cancelled', 52)], [runs[1]])).toBe(false)
    expect(onlySupersededFailures([job('success', 51), job('failure', 70)], runs)).toBe(false)
    expect(onlySupersededFailures([job('success', 51), { kind: 'status', name: 'x', state: 'failure' }], runs)).toBe(false)
    // decideCi: UNSTABLE merges only with that proof
    const unstable = openPr({ mergeStateStatus: 'UNSTABLE' })
    expect(decideCi({ item: fresh(), pr: unstable, checks: GREEN(), defaultBranch: 'main', supersededOnly: true, now: NOW, ref })).toMatchObject({ action: { type: 'merge' } })
    expect(decideCi({ item: fresh(), pr: unstable, checks: GREEN(), defaultBranch: 'main', supersededOnly: false, now: NOW, ref })).toMatchObject({ state: 'waiting' })
  })

  it('says when a required check never reports, once nothing else is running (a renamed job, a path-filtered workflow)', () => {
    const missing = checksOf([check('verify', 'success')])
    const first = decideCi({ item: fresh(), pr: openPr(), checks: missing, runs: [run('success')], defaultBranch: 'main', now: NOW, ref })
    expect(first).toMatchObject({ state: 'ci', patch: { missingSince: new Date(NOW).toISOString() } })
    const later = decideCi({ item: fresh(first.patch), pr: openPr(), checks: missing, runs: [run('success')], defaultBranch: 'main', now: NOW + 21 * 60_000, ref })
    expect(later).toMatchObject({ state: 'attention', reason: { kind: 'missing-check' } })
    expect(later.reason.text).toContain('"windows tests"')
    // While a check still runs, the missing one may simply not have started: no clock
    const running = checksOf([check('verify', null)])
    expect(decideCi({ item: fresh(first.patch), pr: openPr(), checks: running, runs: [run(null)], defaultBranch: 'main', now: NOW + 21 * 60_000, ref })).toMatchObject({ state: 'ci', patch: { missingSince: null } })
  })

  it('counts a pull request found merged as landed only when it merged into the default branch', () => {
    expect(decideBefore({ item: fresh(), permissions: maintainer, pr: openPr({ state: 'MERGED' }), defaultBranch: 'main', ref })).toEqual({ state: 'merged', landed: true })
    expect(decideBefore({ item: fresh(), permissions: maintainer, pr: openPr({ state: 'MERGED', baseRefName: 'feat/low' }), defaultBranch: 'main', ref })).toEqual({ state: 'merged', landed: false })
  })

  it('says a head with no CI run at all needs attention only after 15 minutes', () => {
    const none = checksOf([])
    const first = decideCi({ item: fresh(), pr: openPr(), checks: none, runs: [], defaultBranch: 'main', now: NOW, ref })
    expect(first).toMatchObject({ state: 'ci', patch: { noCiSince: new Date(NOW).toISOString() } })
    expect(decideCi({ item: fresh(first.patch), pr: openPr(), checks: none, runs: [], defaultBranch: 'main', now: NOW + 16 * 60_000, ref }).reason.kind).toBe('no-ci')
  })

  it('keeps a pull request in one item only, and the key of a message changes with the reason, the head and the job', () => {
    const q = emptyQueue()
    enqueue(q, { repo: R, pr: 80, lowers: [79], at: 'x' }, ref)
    expect(enqueue(q, { repo: R, pr: 79, at: 'x' }, ref).error).toBe('#79 is already queued under #80.')
    expect(enqueue(q, { repo: R, pr: 81, lowers: [79], at: 'x' }, ref).error).toBe('#79 is already queued with #80.')
    q.items[0].state = 'attention'
    q.items[0].reason = { kind: 'refused', text: 'x' }
    expect(enqueue(q, { repo: R, pr: 80, lowers: [], at: 'x' }, ref).replaced).toBe(true)
    // Queued again: looked at afresh
    expect(q.items[0]).toMatchObject({ state: 'waiting', reason: null, noticeKey: null, lowers: [] })
    expect(dequeue(q, { repo: R, pr: 80, at: 'x' }, ref)?.pr).toBe(80)
    expect(dequeue(q, { repo: R, pr: 80, at: 'x' }, ref)).toBe(null)
    const k = noticeKey({ kind: 'failed', job: { id: '12' } }, SHA)
    expect(noticeKey({ kind: 'failed', job: { id: '12' } }, SHA)).toBe(k)
    expect(noticeKey({ kind: 'failed', job: { id: '13' } }, SHA)).not.toBe(k)
    expect(noticeKey({ kind: 'failed', job: { id: '12' } }, SHA2)).not.toBe(k)
  })

  it('starts the clocks and the failure count again when an item is queued again, and keeps its reruns and owner', () => {
    const q = emptyQueue()
    const { item } = enqueue(q, { repo: R, pr: 80, owner: 'first', at: 'x' }, ref)
    const spent = { cancelled: { run: 900, attempt: 1, at: 'x' } }
    Object.assign(item, { state: 'attention', reason: { kind: 'not-clean', text: 'x' }, noCiSince: 'a', missingSince: 'b', uncleanSince: 'c', errors: 2, reruns: spent })
    enqueue(q, { repo: R, pr: 80, at: 'y' }, ref)
    // Without this, queued again after "not CLEAN for 30 minutes" it said so again at once
    expect(q.items[0]).toMatchObject({ state: 'waiting', owner: 'first', noCiSince: null, missingSince: null, uncleanSince: null, errors: 0, reruns: spent })
  })

  it("records the PR's author session, and keeps it when queued again without one (#1182)", () => {
    const q = emptyQueue()
    const { item } = enqueue(q, { repo: R, pr: 80, owner: 'integrator', author: 'writer', at: 'x' }, ref)
    expect(item).toMatchObject({ owner: 'integrator', author: 'writer' })
    enqueue(q, { repo: R, pr: 80, at: 'y' }, ref)
    expect(q.items[0]).toMatchObject({ owner: 'integrator', author: 'writer' })
    enqueue(q, { repo: R, pr: 80, author: 'fixer', at: 'z' }, ref)
    expect(q.items[0].author).toBe('fixer')
    expect(enqueue(q, { repo: R, pr: 81, at: 'z' }, ref).item.author).toBeNull()
  })

  it("reruns the PR's own pull_request run when a push run shares its commit, and reads an old file without lowers", () => {
    const pr = { headRefName: 'feat/queue' }
    const push = { id: 1, run_attempt: 1, event: 'push', head_branch: 'feat/queue', status: 'completed', conclusion: 'failure', created_at: '2026-10-17T09:00:00Z', workflow_id: 7 }
    const pull = { id: 2, run_attempt: 1, event: 'pull_request', head_branch: 'feat/queue', status: 'completed', conclusion: 'failure', created_at: '2026-10-17T08:00:00Z', workflow_id: 7 }
    expect(latestRuns([push, pull], pr).map((r: { id: number }) => r.id)).toEqual([2])
    expect(latestRuns([push], pr).map((r: { id: number }) => r.id)).toEqual([1])
    expect(normalize({ items: [{ repo: R, pr: 1, state: 'ci' }] }).items[0]).toMatchObject({ lowers: [], reruns: {} })
  })

  /*
   * A lower's failed run against the run that proved its top (#1066): #1072 failed under #1075 on a real Windows bug, after
   * anything that proved the top; #1039's failure under #1040 came hours before #1040's green run on a newer main.
   */
  it("stops a stack on a lower's failure only when it is at least as new as the run that proved the top", () => {
    const lowerRun = (conclusion: string | null, createdAt: string | null) => ({ status: conclusion ? 'completed' : 'in_progress', conclusion, createdAt })
    const proved = '2026-10-17T15:00:00Z'
    // #1072: failed after the top's proof (or at the same time)
    expect(lowerFailureCounts(lowerRun('failure', '2026-10-17T18:12:16Z'), proved)).toBe(true)
    expect(lowerFailureCounts(lowerRun('failure', proved), proved)).toBe(true)
    expect(lowerFailureCounts(lowerRun('timed_out', '2026-10-17T18:00:00Z'), proved)).toBe(true)
    // #1039: failed before it, on an older main the top's run has outlived
    expect(lowerFailureCounts(lowerRun('failure', '2026-10-17T11:58:33Z'), proved)).toBe(false)
    // Not a failure, or not finished
    for (const c of ['success', 'cancelled', 'skipped', null]) expect(lowerFailureCounts(lowerRun(c, '2026-10-17T18:00:00Z'), proved)).toBe(false)
    // Not knowing either time, a failure counts
    expect(lowerFailureCounts(lowerRun('failure', '2026-10-17T11:58:33Z'), null)).toBe(true)
    expect(lowerFailureCounts(lowerRun('failure', null), proved)).toBe(true)
  })

  it('lets one driver hold the queue at a time, until it lets go or goes quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-queue-lease-'))
    try {
      expect(takeLease(dir, 'server:1', NOW)).toBe(true)
      expect(takeLease(dir, 'watch:2', NOW + 1_000)).toBe(false)
      expect(takeLease(dir, 'server:1', NOW + 2_000)).toBe(true)
      // Quiet past the lease (killed, asleep): the next one takes over
      expect(takeLease(dir, 'watch:2', NOW + 2_000 + 3 * 60_000 + 1)).toBe(true)
      releaseLease(dir, 'server:1') // not its lease any more: nothing happens
      expect(takeLease(dir, 'server:1', NOW + 2_000 + 3 * 60_000 + 2)).toBe(false)
      releaseLease(dir, 'watch:2')
      expect(takeLease(dir, 'server:1', NOW + 2_000 + 3 * 60_000 + 3)).toBe(true)
      // A holder killed before it let go (its pid is gone) holds nothing, however fresh its lease
      writeFileSync(join(dir, 'merge-queue.lease.json'), JSON.stringify({ holder: 'server:dead', pid: deadPid(), until: new Date(NOW + 60 * 60_000).toISOString() }))
      expect(takeLease(dir, 'watch:3', NOW)).toBe(true)
    } finally {
      rmFakeDir(dir)
    }
  })
})

// --- Batches (#962): the decisions ----------------------------------------------------------------------

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
/** A queued item whose own CI was read on its head: its runs in `status`. */
const waitingItem = (pr: number, head: string, status = 'queued', extra: Record<string, unknown> = {}) => ({
  repo: R,
  pr,
  lowers: [],
  owner: 'me',
  state: 'ci',
  head,
  reruns: {},
  queuedAt: `2026-10-17T09:0${pr % 10}:00Z`,
  ci: { head, verdict: 'pending', runs: [{ id: 900 + pr, status }] },
  ...extra,
})
const queueOf = (...items: any[]) => ({ ...emptyQueue(), items })
const greenBatch = () => {
  const q = queueOf(waitingItem(1, A), waitingItem(2, B))
  const b = formBatch(q, q.items, { at: 'x', ref })
  Object.assign(b, {
    state: 'landing',
    base: { sha: 'm0', tree: 'T0' },
    steps: [
      { pr: 1, head: A, sha: 's1', tree: 'T1' },
      { pr: 2, head: B, sha: 's2', tree: 'T2' },
    ],
    cancelled: [{ pr: 1, run: 901, suite: 51 }],
  })
  return { q, b }
}
const landing = (extra: Record<string, unknown> = {}) => {
  const { q, b } = greenBatch()
  return decideLanding({ b, step: b.steps[0], pr: openPr({ number: 1, headRefOid: A }), item: q.items[0], mainTree: 'T0', prevTree: 'T0', defaultBranch: 'main', subject: 'fix: x (#1)', subjectMax: 72, now: NOW, ref, ...extra })
}

describe('what the merge queue decides for a batch (#962)', () => {
  it('batches only items whose own CI has not started, never one sent back from a batch on the same head, the oldest first', () => {
    const q = queueOf(
      waitingItem(3, C),
      waitingItem(1, A),
      waitingItem(2, B, 'in_progress'), // its own run is going: cancelling it would throw work away
      waitingItem(4, 'd'.repeat(40), 'queued', { batchless: 'd'.repeat(40) }),
      waitingItem(5, 'e'.repeat(40), 'queued', { ci: { head: 'f'.repeat(40), verdict: 'pending', runs: [{ id: 1, status: 'queued' }] } }), // read on an older head
      waitingItem(6, '6'.repeat(40), 'queued', { state: 'attention' }),
      waitingItem(7, '7'.repeat(40), 'queued', { ci: { head: '7'.repeat(40), verdict: 'green', runs: [{ id: 2, status: 'completed' }] } }),
    )
    expect(batchCandidates(q, { max: 6 }).map((i: any) => i.pr)).toEqual([1, 3])
    expect(batchCandidates(q, { max: 1 }).map((i: any) => i.pr)).toEqual([1])
    // A new head is not the one sent back
    q.items[3].head = '9'.repeat(40)
    q.items[3].ci.head = q.items[3].head
    expect(batchCandidates(q, { max: 6 }).map((i: any) => i.pr)).toEqual([1, 3, 4])
  })

  it('takes batch members out of the items the queue polls on their own, and gives them back when it ends', () => {
    const q = queueOf(waitingItem(1, A, 'queued', { nextAt: '2026-10-17T09:00:00Z' }), waitingItem(2, B, 'queued', { nextAt: '2026-10-17T09:00:00Z' }))
    const b = formBatch(q, q.items, { at: 'x', ref })
    expect(b).toMatchObject({ branch: 'queue/batch-1', state: 'building', members: [{ pr: 1, head: A }, { pr: 2, head: B }] })
    expect(q.items.map((i: any) => i.batch)).toEqual([1, 1])
    // A file whose batch is gone (by hand, an older build) gives its items back
    const reread = normalize({ ...q, batches: [] })
    expect(reread.items.map((i: any) => i.batch)).toEqual([undefined, undefined])
    // Given back, they are batchable again only once their own poll has read them: a batch that keeps
    // failing to build would otherwise be formed again at once, every tick, and no item polled
    endBatch(q, b, 'dropped', { at: 'y', batchless: false })
    expect(q.items.map((i: any) => [i.batch, i.nextAt])).toEqual([
      [undefined, 'y'],
      [undefined, 'y'],
    ])
    expect(batchCandidates(q, { max: 6 })).toEqual([])
  })

  it('splits a red batch in halves: a half of two or more is tried again, one left alone goes back to its own CI', () => {
    const q = queueOf(waitingItem(1, A), waitingItem(2, B), waitingItem(3, C))
    const b = formBatch(q, q.items, { at: 'x', ref })
    b.state = 'ci'
    b.steps = q.items.map((i: any) => ({ pr: i.pr, head: i.head, sha: `s${i.pr}`, tree: `T${i.pr}` }))
    const made = splitBatch(q, b, { at: 'y', ref })
    expect(b.state).toBe('failed')
    expect(made.map((x: any) => x.members.map((m: any) => m.pr))).toEqual([[1, 2]])
    expect(q.items.map((i: any) => [i.pr, i.batch ?? null, i.batchless ?? null])).toEqual([
      [1, 2, null],
      [2, 2, null],
      [3, null, C],
    ])
  })

  it('keeps the runs a batch cancelled for the members of the batches split or re-formed from it', () => {
    const q = queueOf(waitingItem(1, A), waitingItem(2, B), waitingItem(3, C), waitingItem(4, '4'.repeat(40)))
    const b = formBatch(q, q.items, { at: 'x', ref })
    b.state = 'ci'
    b.steps = q.items.map((i: any) => ({ pr: i.pr, head: i.head, sha: `s${i.pr}`, tree: `T${i.pr}` }))
    b.cancelled = q.items.map((i: any) => ({ pr: i.pr, run: 900 + i.pr, suite: 50 + i.pr }))
    const made = splitBatch(q, b, { at: 'y', ref })
    // Without them, a half's members were UNSTABLE from runs it did not know, and waited 30 minutes
    expect(made.map((x: any) => x.cancelled.map((c: any) => c.run))).toEqual([
      [901, 902],
      [903, 904],
    ])
  })

  it('lets the watch command say "Nothing left queued" only once a batch with its pull requests has finished', () => {
    const q = queueOf(waitingItem(1, A, 'queued', { owner: 'me', state: 'merged' }), waitingItem(2, B, 'queued', { owner: 'other' }))
    q.events = [{ seq: 5, notify: true, owner: 'me', kind: 'merged', text: 'merged #1' }]
    q.seq = 5
    const b = formBatch(q, [q.items[0]], { at: 'x', ref })
    b.state = 'landing'
    // Its last member landed; the batch's end (the branch, the tree check and its notice) is still to come
    expect(watchState(q, { owner: 'me', after: 0 })).toMatchObject({ batchPending: true, done: false })
    b.state = 'done'
    expect(watchState(q, { owner: 'me', after: 0 })).toMatchObject({ batchPending: false, done: true, news: [{ text: 'merged #1' }] })
    // Something still queued: news ends it at once, as before
    b.state = 'landing'
    expect(watchState(q, { owner: null, after: 0 })).toMatchObject({ done: true })
    expect(watchState(q, { owner: 'other', after: 0 })).toMatchObject({ news: [], done: false })
  })

  it('lands a member only while main has the tree the batch had before it, in order, and on its own head', () => {
    expect(landing()).toEqual({ do: 'merge' })
    // Something else landed on main: the batch's tree is not what this member would land on
    expect(landing({ mainTree: 'Tx' })).toMatchObject({ do: 'stop' })
    expect(landing({ pr: openPr({ number: 1, headRefOid: C }) })).toMatchObject({ do: 'stop', text: expect.stringContaining('head moved') })
    expect(landing({ item: null })).toMatchObject({ do: 'stop', text: '#1 left the queue before it landed' })
    expect(landing({ pr: openPr({ number: 1, headRefOid: A, isDraft: true }) })).toMatchObject({ do: 'stop' })
    expect(landing({ pr: openPr({ number: 1, headRefOid: A, mergeStateStatus: 'BLOCKED' }) })).toMatchObject({ do: 'stop', text: expect.stringContaining('BLOCKED') })
    expect(landing({ subject: 'x'.repeat(73) })).toMatchObject({ do: 'stop' })
    // Found merged with the batch's tree after it: a driver stopped before writing it down
    expect(landing({ pr: openPr({ number: 1, headRefOid: A, state: 'MERGED' }), mainTree: 'T1' })).toEqual({ do: 'landed' })
    expect(landing({ pr: openPr({ number: 1, headRefOid: A, state: 'MERGED' }), mainTree: 'Tx' })).toMatchObject({ do: 'stop' })
    // A stack's top moves onto main first
    expect(landing({ pr: openPr({ number: 1, headRefOid: A, baseRefName: 'feat/low' }), lowerBranches: ['feat/low'] })).toEqual({ do: 'retarget', base: 'main' })
  })

  it('lands an UNSTABLE member only when every check that did not pass is a run the batch cancelled', () => {
    const run = (conclusion: string | null, suiteId: number) => ({ kind: 'run', name: 'verify', status: conclusion ? 'completed' : 'queued', conclusion, suiteId })
    expect(onlyCancelledByBatch([run('cancelled', 51), run('success', 52)], [51])).toBe(true)
    expect(onlyCancelledByBatch([run('cancelled', 53)], [51])).toBe(false) // cancelled by someone else
    expect(onlyCancelledByBatch([run('failure', 52)], [51])).toBe(false)
    expect(onlyCancelledByBatch([run(null, 52)], [51])).toBe(false) // still to run
    expect(onlyCancelledByBatch([{ kind: 'status', name: 'x', state: 'failure' }], [51])).toBe(false)
    const unstable = openPr({ number: 1, headRefOid: A, mergeStateStatus: 'UNSTABLE' })
    expect(landing({ pr: unstable, checks: [run('cancelled', 51)] })).toEqual({ do: 'merge' })
    const waits = landing({ pr: unstable, checks: [run('failure', 52)] })
    expect(waits).toMatchObject({ do: 'wait' })
    // …and says so in time, instead of waiting for ever
    const { q, b } = greenBatch()
    b.uncleanSince = waits.patch.uncleanSince
    expect(decideLanding({ b, step: b.steps[0], pr: unstable, item: q.items[0], mainTree: 'T0', prevTree: 'T0', defaultBranch: 'main', checks: [run('failure', 52)], subject: 's', subjectMax: 72, now: NOW + 31 * 60_000, ref })).toMatchObject({ do: 'stop' })
  })
})

/*
 * Two tiers of CI (project.json ci.fullTier, 2026-10-18): a pull request's own run is the quick tier, and a skipped
 * job counts as passed, so that run alone is green on every check it reports. Nothing lands from it: an item lands from
 * a batch, run in full (a batch of one included), or from a full run on its own head.
 */
describe('what the merge queue decides with two tiers of CI', () => {
  const TIER = 'full tier'
  const tiered = (rows: Row[]) => evaluateChecks({ required: ['verify', 'windows tests', TIER, 'e2e (webkit 1/5)'], reported: rows })
  // What a quick run reports: the full tier's check skipped, the full tier's matrix jobs not at all
  const QUICK = () => tiered([check(TIER, 'skipped'), check('verify', 'success'), check('windows tests', 'success')])
  const FULL = () => tiered([check(TIER, 'success'), check('verify', 'success'), check('windows tests', 'success'), check('e2e (webkit 1/5)', 'success')])
  const ci = (extra: Record<string, unknown> = {}) =>
    decideCi({ item: fresh(), pr: openPr(), checks: QUICK(), runs: [run('success')], defaultBranch: 'main', now: NOW, ref, fullTier: TIER, canBatch: true, ...extra })

  it('never merges a head whose own run was the quick tier: it waits for a batch, which runs the full tier', () => {
    expect(QUICK().verdict).toBe('pending') // a quick run never reports the full tier's jobs
    expect(ci()).toEqual({ state: 'ci', quick: true, patch: { noCiSince: null, missingSince: null } })
    // Every check it reports passed, the required set naming none of the full tier's jobs: still not a merge
    const allReported = evaluateChecks({ required: ['verify', TIER], reported: [check(TIER, 'skipped'), check('verify', 'success')] })
    expect(allReported.verdict).toBe('green')
    expect(ci({ checks: allReported })).toMatchObject({ state: 'ci', quick: true })
    expect(ci({ checks: allReported }).action).toBeUndefined()
    // An older workflow that has no such check, its run finished: not proven full either
    expect(ci({ checks: evaluateChecks({ required: ['verify'], reported: [check('verify', 'success')] }) })).toMatchObject({ quick: true })
    // A full run on its own head merges, as before
    expect(ci({ checks: FULL() })).toMatchObject({ state: 'ci', action: { type: 'merge' } })
    // Without tiers, the same green run merges
    expect(ci({ checks: allReported, fullTier: null })).toMatchObject({ action: { type: 'merge' } })
  })

  it('reruns a quick run that failed, and waits while one still runs', () => {
    const failed = tiered([check(TIER, 'skipped'), check('verify', 'failure', { jobId: '5' }), check('windows tests', 'success')])
    expect(ci({ checks: failed, runs: [run('failure')] })).toMatchObject({ state: 'ci', action: { type: 'rerun', failedOnly: true } })
    const going = tiered([check(TIER, 'skipped'), check('verify', 'success'), check('windows tests', null)])
    expect(ci({ checks: going, runs: [run(null)] })).toEqual({ state: 'ci', patch: { noCiSince: null, missingSince: null } })
  })

  it('asks the session when the queue cannot batch it, or its batch of one ended without landing it', () => {
    const fork = ci({ canBatch: false, pr: openPr({ isCrossRepository: true }) })
    expect(fork).toMatchObject({ state: 'attention', reason: { kind: 'full-tier' } })
    expect(fork.reason.text).toContain("a fork's pull request")
    expect(fork.reason.text).toContain('gh workflow run build.yml --ref feat/queue')
    const alone = ci({ item: fresh({ alone: { head: SHA, text: 'Batch queue/batch-4: required check "verify" failed twice.' } }) })
    expect(alone).toMatchObject({ state: 'attention', reason: { kind: 'full-tier' } })
    expect(alone.reason.text).toContain('its batch of one ended without landing it: Batch queue/batch-4: required check "verify" failed twice.')
    // On a new head it is batched again
    expect(ci({ item: fresh({ alone: { head: SHA2, text: 'x' } }) })).toMatchObject({ state: 'ci', quick: true })
  })

  it('batches items whose quick tier passed, one at a time when one was sent back, and never one alone again on its head', () => {
    const quick = (pr: number, head: string, extra: Record<string, unknown> = {}) =>
      waitingItem(pr, head, 'completed', { ci: { head, verdict: 'quick', runs: [{ id: 900 + pr, status: 'completed' }] }, ...extra })
    const q = queueOf(quick(2, B), quick(1, A), waitingItem(3, C))
    expect(batchCandidates(q, { max: 6, tiers: true }).map((i: any) => i.pr)).toEqual([1, 2, 3])
    // Without tiers a finished run is no candidate: it lands on its own
    expect(batchCandidates(q, { max: 6 }).map((i: any) => i.pr)).toEqual([3])
    // Sent back from a batch on its head: alone, when it is the oldest; left for later otherwise
    q.items[1].batchless = A
    expect(batchCandidates(q, { max: 6, tiers: true }).map((i: any) => i.pr)).toEqual([1])
    q.items[1].batchless = null
    q.items[0].batchless = B
    expect(batchCandidates(q, { max: 6, tiers: true }).map((i: any) => i.pr)).toEqual([1, 3])
    // Its batch of one ended without landing it: not on this head (#2, sent back and now the oldest, goes alone)
    q.items[1].alone = { head: A, text: 'x' }
    expect(batchCandidates(q, { max: 6, tiers: true }).map((i: any) => i.pr)).toEqual([2])
    q.items[0].alone = { head: B, text: 'x' }
    expect(batchCandidates(q, { max: 6, tiers: true }).map((i: any) => i.pr)).toEqual([3])
  })

  it('marks the one member of a batch of one that ended without landing it, with why, and no member of a larger batch', () => {
    const q = queueOf(waitingItem(1, A), waitingItem(2, B), waitingItem(3, C))
    const one = formBatch(q, [q.items[0]], { at: 'x', ref })
    endBatch(q, one, 'dropped', { at: 'y', why: 'it failed.' })
    expect(q.items[0]).toMatchObject({ batchless: A, alone: { head: A, text: 'it failed.' } })
    const two = formBatch(q, [q.items[1], q.items[2]], { at: 'x', ref })
    endBatch(q, two, 'dropped', { at: 'y', why: 'it failed.' })
    expect(q.items.slice(1).map((i: any) => [i.batchless, i.alone ?? null])).toEqual([
      [B, null],
      [C, null],
    ])
    // Given back without blame (the batch could not start): nothing marked
    const again = formBatch(q, [q.items[1]], { at: 'x', ref })
    endBatch(q, again, 'dropped', { at: 'y', batchless: false, why: 'x' })
    expect(q.items[1].alone).toBeUndefined()
    // One that conflicts alone in its batch: marked too, or it would conflict again batch after batch
    markBatchless(q, R, [3], 'it conflicts with main.')
    expect(q.items[2].alone).toEqual({ head: C, text: 'it conflicts with main.' })
    // Queued again, it is tried afresh
    const { item } = enqueue(q, { repo: R, pr: 1, at: 'z' })
    expect(item.alone).toBeUndefined()
  })
})

/** The pid of a process that has ended. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

// --- The app, against a fake gh ---------------------------------------------------------------------

/**
 * The fake gh: answers from a state file and logs every call. `on` holds changes applied when a write
 * happens (a rerun starts a new attempt, a merge marks the pull request merged), so a scenario moves
 * the way GitHub would.
 */
const FAKE_GH = String.raw`
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
const fail = (msg) => { process.stderr.write('gh: ' + msg + '\n'); process.exit(1) }
const R = 'repos/ijun17/centralu'
const path = args[0] === 'api' ? args.filter((a) => a.startsWith('repos/'))[0] : null
const write = (w) => { st.writes = [...(st.writes ?? []), w]; const patch = st.on && st.on[w[0] + ':' + w[1]]; if (patch) for (const [k, v] of Object.entries(patch)) st[k] = { ...st[k], ...v }; save() }
if (st.rateLimited) fail('API rate limit exceeded for user ID 1. (HTTP 403)')
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = st.prs[args[2]]
  if (!pr) fail('Could not resolve to a PullRequest with the number of ' + args[2] + '.')
  out(pr)
} else if (args[0] === 'pr' && args[1] === 'merge') {
  if (st.mergeError) fail(st.mergeError)
  write(['merge', args[2], args])
  // GitHub's own merge queue: gh exits 0 and nothing is merged yet
  if (st.mergeNoop) process.exit(0)
  const pr = st.prs[args[2]]
  pr.state = 'MERGED'; pr.mergeCommit = { oid: 'abcdef1234567890abcdef1234567890abcdef12' }
  // main moves to the squash: its tree is the head merged onto main (the batch's tree for it), unless drifted
  st.main = { sha: 'main-' + args[2], tree: st.mainDrift ? 'tree-drift' : 'tree-' + pr.headRefOid }
  save()
} else if (args[0] === 'pr' && args[1] === 'close') {
  write(['close', args[2], args[args.indexOf('--comment') + 1]])
  st.prs[args[2]].state = 'CLOSED'
  save()
} else if (args[0] === 'pr' && args[1] === 'list') {
  out((st.basedOn ?? {})[args[args.indexOf('--base') + 1]] ?? [])
} else if (path === R + '/commits/main') {
  if (st.mainError) fail('Not Found (HTTP 404)')
  const m = st.main ?? { sha: 'main0', tree: 'tree-main0' }
  out({ sha: m.sha, commit: { tree: { sha: m.tree } } })
} else if (path === R + '/git/refs' && args.includes('POST')) {
  const body = JSON.parse(stdin)
  if ((st.refs ?? []).includes(body.ref)) fail('Reference already exists (HTTP 422)')
  write(['branch', body.ref.replace('refs/heads/', ''), body.sha])
  out({ ref: body.ref })
} else if (path === R + '/merges') {
  const body = JSON.parse(stdin)
  write(['merge-into', body.head, body.base])
  if ((st.conflicts ?? []).includes(body.head)) fail('Merge conflict (HTTP 409)')
  if ((st.mergeErrors ?? []).includes(body.head)) fail('Not Found (HTTP 404)')
  out({ sha: 'batch-' + body.head, commit: { tree: { sha: 'tree-' + body.head } } })
} else if (path && path.endsWith('/actions/workflows/build.yml/dispatches')) {
  const body = JSON.parse(stdin)
  if (st.dispatchError) fail(st.dispatchError)
  write(['dispatch', body.ref])
} else if (path && /\/actions\/runs\/\d+\/cancel$/.test(path)) {
  if (st.cancelError) fail(st.cancelError)
  write(['cancel', path.split('/')[5]])
} else if (path && path.includes('/statuses/')) {
  const body = JSON.parse(stdin)
  write(['status', path.split('/statuses/')[1], body.state, body.context, body.description])
  out({ id: 1, state: body.state })
} else if (path === R) {
  out({ permissions: st.permissions, default_branch: 'main' })
} else if (path && path.includes('/protection/required_status_checks')) {
  fail('Branch not protected (HTTP 404)')
} else if (path && path.startsWith(R + '/rules/branches/')) {
  out([])
} else if (path && path.startsWith(R + '/contents/.github/workflows/build.yml')) {
  out(st.workflow)
} else if (path && /\/check-runs\?/.test(path)) {
  out({ check_runs: (st.checks ?? {})[path.split('/')[4]] ?? [] })
} else if (path && /\/commits\/[^/]+\/status$/.test(path)) {
  out({ state: 'pending', statuses: [] })
} else if (path && path.includes('/actions/workflows/build.yml/runs?')) {
  const runs = (st.runs ?? {})[new URLSearchParams(path.split('?')[1]).get('head_sha')] ?? []
  out(args.includes('--slurp') ? [{ workflow_runs: runs }] : { workflow_runs: runs })
} else if (path && /\/actions\/runs\/\d+\/rerun(-failed-jobs)?$/.test(path) && st.rerunError) {
  fail(st.rerunError)
} else if (path && /\/actions\/runs\/\d+\/rerun(-failed-jobs)?$/.test(path)) {
  write([path.endsWith('failed-jobs') ? 'rerun-failed' : 'rerun', path.split('/')[5]])
} else if (path && /\/actions\/jobs\/\d+\/logs$/.test(path)) {
  out((st.logs ?? {})[path.split('/')[5]] ?? '')
} else if (path && path.includes('/compare/')) {
  out({ status: (st.compare ?? {})[path.split('/compare/')[1]] ?? 'ahead' })
} else if (path && args.includes('PATCH') && /\/pulls\/\d+$/.test(path)) {
  const body = JSON.parse(stdin)
  write(['base', path.split('/')[4], body.base])
  st.prs[path.split('/')[4]].baseRefName = body.base
  save()
  out({ number: Number(path.split('/')[4]) })
} else if (path && args.includes('DELETE')) {
  write(['delete', path.split('/heads/')[1]])
} else fail('fake gh: unexpected call ' + JSON.stringify(args) + ' (HTTP 400)')
`

const WORKFLOW = ['jobs:', '  verify:', '    name: verify', '  windows-tests:', '    name: windows tests', ''].join('\n')
const ghCheck = (name: string, conclusion: string | null, id: number, at = '2026-10-17T08:00:00Z') => ({
  id,
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  html_url: `https://github.com/${R}/actions/runs/900/job/${id}`,
  started_at: at,
  app: { slug: 'github-actions' },
  check_suite: { id: 5000 },
})
const green = (at?: string) => [ghCheck('verify', 'success', 11, at), ghCheck('windows tests', 'success', 12, at)]
const ghRun = (conclusion: string | null, attempt = 1, sha = SHA, extra: Record<string, unknown> = {}) => ({
  id: 900,
  run_attempt: attempt,
  head_sha: sha,
  head_branch: 'feat/b77',
  event: 'pull_request',
  check_suite_id: 5000,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  created_at: '2026-10-17T08:00:00Z',
  ...extra,
})
const ghPr = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `feat(apps): change ${number}`,
  body: '## Why\n\nBecause.\n\n## Closes\n\nRefs #956\n\nCo-Authored-By: Someone <x@example.com>',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: SHA,
  headRefName: `feat/b${number}`,
  baseRefName: 'main',
  isCrossRepository: false,
  url: `https://github.com/${R}/pull/${number}`,
  mergeCommit: null,
  ...extra,
})
type Gh = Record<string, any>
const ghState = (patch: Gh = {}): Gh => ({
  permissions: { admin: false, maintain: true, push: true },
  prs: { '77': ghPr(77) },
  workflow: WORKFLOW,
  checks: { [SHA]: green() },
  runs: { [SHA]: [ghRun('success')] },
  logs: { '12': 'FAIL unit packages/x.test.ts > adds numbers\nAssertionError: expected 3 to be 4' },
  ...patch,
})

const appRef: AppRef = { projectId: 'p1', appId: 'project-board' }
const agent: AppCaller = { kind: 'session', sessionId: 's1' }
let root = ''
let rt: ExternalApps | null = null
let fake: FakeGh

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-project-board-queue-')))
  mkdirSync(join(root, 'data'))
  fake = fakeGh(root, FAKE_GH)
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmFakeDir(root)
})

const FAST = { PROJECT_BOARD_QUEUE_TICK_MS: '50', PROJECT_BOARD_QUEUE_POLL_MS: '50' }
/** A server that polls only at its start: what a test drives or reads, nothing moves under it */
const IDLE_SERVER = { PROJECT_BOARD_QUEUE_TICK_MS: String(3_600_000) }
/**
 * Without two tiers of CI unless a test asks for them (TIERS): the queue as a repository without them runs it, every
 * green run a full one. The tiers this repository has (project.json ci.fullTier) have tests of their own below.
 */
const NO_TIERS = { PROJECT_BOARD_CI_FULL_TIER: '' }
const TIERS = { PROJECT_BOARD_CI_FULL_TIER: 'full tier' }

function runtime(state?: Gh, env: Record<string, string> = {}) {
  if (state) fake.setState(state)
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: fake.env({ ...FAST, ...NO_TIERS, ...env }),
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const out = await rt!.call(appRef, name, args, agent)
  if (!out.result) throw new Error(`${name} did not answer: ${out.status} ${out.error}`)
  return { text: resultText(out.result), isError: out.result.isError === true, data: out.result.structuredContent as any }
}
/** The fake gh's state (written whole by both sides, so never read half written) */
const gh = (): Gh => fake.state<Gh>()
const patchGh = (fn: (s: Gh) => void) => fake.patchState<Gh>(fn)
const writes = (): any[][] => gh().writes ?? []
const ghCalls = () => fake.calls().map((c) => c.args)
function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesNamed(join(dir, e.name), name) : e.name === name ? [join(dir, e.name)] : []))
}
const queueFile = () => filesNamed(join(root, 'data'), 'merge-queue.json')[0]!
const queueOnDisk = () => JSON.parse(readFileSync(queueFile(), 'utf8'))
const notices = () => (queueOnDisk().events as { kind: string; notify: boolean; text: string }[]).filter((e) => e.notify)

/** Polls until `ok` holds, through merge_queue (which also keeps the app awake), for at most `ms` (20 s). */
async function until(ok: (q: any) => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms * SLOW
  for (;;) {
    const q = (await call('merge_queue', { all: true })).data
    if (ok(q)) return q
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(q)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const stateOf = (q: any, pr = 77) => q.queue.find((i: any) => i.pr === pr)?.state
/** Waits for the queue to read the pull request `n` more times (a poll each), rather than for a time. */
async function morePolls(n = 2) {
  const reads = () => ghCalls().filter((a) => a[0] === 'pr' && a[1] === 'view').length
  const target = reads() + n
  await until(() => reads() >= target, `${n} more polls`)
}

describe('the project board app: the merge queue', { timeout: 60_000 * SLOW }, () => {
  it('passes check, with queue_merge and unqueue as changes and merge_queue as a read', async () => {
    const r = await runtime(ghState()).check(appRef)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    expect(r.text).toContain('queue_merge — changes, model')
    expect(r.text).toContain('merge_queue — reads, model+app')
    expect(r.text).toContain('unqueue — changes, model+app')
  })

  it('merges a green pull request on its own: squash on the head it read, "Title (#N)", no attribution, branch deleted, and says so', async () => {
    runtime(ghState())
    const q = await call('queue_merge', { pr: 77, owner: 'tester' })
    expect(q.isError).toBe(false)
    expect(q.data.owner).toBe('tester')
    expect(q.data.watch).toContain('merge-queue.mjs')
    expect(q.data.watch).toContain('--owner tester')
    await until((x) => stateOf(x) === 'merged', 'the merge')
    const merges = writes().filter((w) => w[0] === 'merge')
    expect(merges).toHaveLength(1)
    const args = merges[0]![2] as string[]
    expect(args).toEqual(expect.arrayContaining(['--squash', '--match-head-commit', SHA, '--subject', 'feat(apps): change 77 (#77)']))
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--delete-branch')
    expect(args[args.indexOf('--body') + 1]).not.toMatch(/Co-Authored-By/i)
    expect(writes().filter((w) => w[0] === 'delete')).toEqual([['delete', 'feat/b77']])
    expect(notices().map((e) => e.text)).toEqual(['Merge queue: merged #77 (feat(apps): change 77) as abcdef1, "feat(apps): change 77 (#77)".'])
  })

  it('lands a stack through its top: moves its base to main first, then closes the lower as landed and deletes both branches', async () => {
    runtime(
      ghState({
        prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2 }), '77': ghPr(77, { baseRefName: 'feat/low', mergeStateStatus: 'CLEAN' }) },
        compare: { [`${SHA2}...${SHA}`]: 'ahead' },
      }),
    )
    expect((await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })).isError).toBe(false)
    await until((x) => stateOf(x) === 'merged', 'the stack to land')
    const order = writes().map((w) => w.slice(0, 2).join(' '))
    expect(order).toEqual(['base 77', 'merge 77', 'delete feat/b77', 'close 76', 'delete feat/low'])
    expect(writes().find((w) => w[0] === 'close')).toEqual(['close', '76', 'Landed in #77, which merged this stack as one commit.'])
    expect(notices().at(-1)!.text).toContain('Closed #76 as landed in it.')
  })

  /*
   * #1066, seen twice on 2026-10-18: the queue stopped #1040 and #1026 with `lower-failed`, because their lowers #1039 and
   * #1023 still carried a failed run from hours before, against an older main, for a test main had since fixed. Each top
   * had a green run on a head containing its lowers' heads: CI tests the whole tree, so that run is the evidence.
   */
  it("lands a stack on its top's green run over a lower's old failed run, the lower a draft that runs no CI", async () => {
    runtime(
      ghState({
        prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2, isDraft: true }), '77': ghPr(77, { baseRefName: 'main' }) },
        runs: {
          [SHA]: [ghRun('success')],
          // The lower's latest run: failed hours before the top's green one
          [SHA2]: [ghRun('failure', 1, SHA2, { id: 990, head_branch: 'feat/low', created_at: '2026-10-17T02:00:00Z' })],
        },
        compare: { [`${SHA2}...${SHA}`]: 'ahead' },
      }),
    )
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the stack to land')
    expect(writes().map((w) => w.slice(0, 2).join(' '))).toEqual(['merge 77', 'delete feat/b77', 'close 76', 'delete feat/low'])
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
  })

  // #1072 under #1075, 2026-10-18: a real bug (a Windows 8.3 short-name temp path) the lower failed on after the top's run
  it("lands no stack whose lower failed after the run that proved the top, and lands it once that lower passes", async () => {
    runtime(
      ghState({
        prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2, isDraft: true }), '77': ghPr(77, { baseRefName: 'main' }) },
        runs: {
          // The top's green run, then the lower's failed one an hour later
          [SHA]: [ghRun('success', 1, SHA, { created_at: '2026-10-17T08:00:00Z' })],
          [SHA2]: [ghRun('failure', 1, SHA2, { id: 990, head_branch: 'feat/low', created_at: '2026-10-17T09:00:00Z' })],
        },
        compare: { [`${SHA2}...${SHA}`]: 'ahead' },
      }),
    )
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('lower-failed')
    expect(notices().at(-1)!.text).toContain('#76, under #77, has a CI run 990 on its head beef000 that failed after the run that proved #77 (started 2026-10-17 08:00 UTC)')
    expect(writes()).toEqual([])
    // Fixed and rerun: no failure, so the top's green run lands the stack
    patchGh((s) => (s.runs[SHA2] = [ghRun('success', 2, SHA2, { id: 990, head_branch: 'feat/low', created_at: '2026-10-17T09:00:00Z' })]))
    await until((x) => stateOf(x) === 'merged', 'the stack to land')
    expect(writes().map((w) => w.slice(0, 2).join(' '))).toEqual(['merge 77', 'delete feat/b77', 'close 76', 'delete feat/low'])
  })

  it('lands no stack whose top does not contain a lower\'s head', async () => {
    runtime(ghState({ prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2 }), '77': ghPr(77) }, compare: { [`${SHA2}...${SHA}`]: 'diverged' } }))
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('stack')
    expect(writes()).toEqual([])
  })

  it('reruns a cancelled run once, then asks the queuing session for attention once, and never merges it', async () => {
    const cancelled = [ghCheck('verify', 'cancelled', 11), ghCheck('windows tests', 'success', 12)]
    runtime(
      ghState({
        checks: { [SHA]: cancelled },
        runs: { [SHA]: [ghRun('cancelled')] },
        // The rerun starts a second attempt, which is cancelled too
        on: { 'rerun:900': { runs: { [SHA]: [ghRun('cancelled', 2)] } } },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    // Several more polls, and still one message
    await morePolls()
    expect(writes().map((w) => w[0])).toEqual(['rerun'])
    const n = notices()
    expect(n).toHaveLength(1)
    expect(n[0]!.text).toMatch(/^Merge queue: #77 \(feat\(apps\): change 77\) needs attention: cancelled\. #77: CI run 900 was cancelled again after one rerun at c0ffee0\./)
  })

  it('reruns failed jobs once; failing again names the job and its first failure, once; a new head starts over and lands', async () => {
    const failing = [ghCheck('verify', 'success', 11), ghCheck('windows tests', 'failure', 12)]
    runtime(
      ghState({
        checks: { [SHA]: failing },
        runs: { [SHA]: [ghRun('failure')] },
        on: { 'rerun-failed:900': { runs: { [SHA]: [ghRun('failure', 2)] } } },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('failed')
    await morePolls()
    expect(writes().map((w) => w[0])).toEqual(['rerun-failed'])
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).toContain('required check "windows tests" (job 12) failed twice at c0ffee0')
    expect(notices()[0]!.text).toContain('First failure: FAIL unit packages/x.test.ts > adds numbers')
    // The session fixes it and pushes: the queue takes the new head and lands it
    patchGh((s) => {
      s.prs['77'].headRefOid = SHA2
      s.checks[SHA2] = green('2026-10-17T09:00:00Z')
      s.runs[SHA2] = [ghRun('success', 1, SHA2)]
    })
    await until((x) => stateOf(x) === 'merged', 'the new head to land')
    expect(writes().find((w) => w[0] === 'merge')![2]).toEqual(expect.arrayContaining(['--match-head-commit', SHA2]))
  })

  it('tells the session once when a pull request goes DIRTY, and never merges it', async () => {
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }) } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls()
    expect(writes()).toEqual([])
    expect(notices().map((e) => e.text)).toEqual([
      'Merge queue: #77 (feat(apps): change 77) needs attention: dirty. #77 conflicts with main (GitHub: DIRTY) at c0ffee0. Rebase it onto main and push (rebase_stack if the PR under it merged); the queue takes the new head by itself. Or take it out with unqueue.',
    ])
    const listed = await call('merge_queue')
    expect(listed.text).toContain('Merge queue: 1 need attention.')
    expect(listed.text).toContain('#77 feat(apps): change 77 — needs attention: dirty')
  })

  it('keeps the first owner when the PR is queued again without one, so its watch command still hears about it', async () => {
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }) } }))
    const first = await call('queue_merge', { pr: 77, owner: 'tester' })
    expect(first.data.owner).toBe('tester')
    const again = await call('queue_merge', { pr: 77 })
    expect(again.text).toMatch(/^Queued again #77 .*, for tester\./)
    expect(again.data.owner).toBe('tester')
    expect(again.data.watch).toContain('--owner tester')
    expect(queueOnDisk().items.map((i: any) => i.owner)).toEqual(['tester'])
    // A new owner given replaces it
    expect((await call('queue_merge', { pr: 77, owner: 'orchestrator' })).data.owner).toBe('orchestrator')
  })

  it("records the PR's author session: the one given, else the caller's own (its owner), else none (#1182)", async () => {
    runtime(ghState({ prs: { '77': ghPr(77), '78': ghPr(78), '79': ghPr(79) }, checks: {}, runs: {} }), IDLE_SERVER)
    const given = await call('queue_merge', { pr: 77, owner: 'integrator', author: 'writer' })
    expect(given.data).toMatchObject({ owner: 'integrator', author: 'writer' })
    expect(given.text).toContain('Author session: writer.')
    expect((await call('queue_merge', { pr: 78, owner: 'integrator' })).data.author).toBe('integrator')
    const none = await call('queue_merge', { pr: 79 })
    expect(none.data.author).toBeNull()
    expect(none.text).toContain('No author session recorded (give author to name it).')
    expect(queueOnDisk().items.map((i: any) => [i.pr, i.author])).toEqual([
      [77, 'writer'],
      [78, 'integrator'],
      [79, null],
    ])
    const listed = (await call('merge_queue')).data.queue.map((i: any) => [i.pr, i.author]).sort((x: any, y: any) => x[0] - y[0])
    expect(listed).toEqual([
      [77, 'writer'],
      [78, 'integrator'],
      [79, null],
    ])
  })

  it('refuses to queue for an account without maintain or admin, a draft, or a PR stacked on a branch not given as a lower', async () => {
    runtime(ghState({ permissions: { push: true } }))
    const r = await call('queue_merge', { pr: 77 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('no maintain or admin permission')
    patchGh((s) => {
      s.permissions = { maintain: true }
      s.prs['77'].isDraft = true
    })
    expect((await call('queue_merge', { pr: 77 })).text).toBe('Not queued: #77 is a draft; mark it ready for review first.')
    patchGh((s) => {
      s.prs['77'].isDraft = false
      s.prs['77'].baseRefName = 'feat/other'
    })
    expect((await call('queue_merge', { pr: 77 })).text).toContain('#77 is based on feat/other, not main: give the PRs under it as lowers')
    expect(writes()).toEqual([])
  })

  it('stops for a draft or a permission lost after queuing, and backs off on a rate limit', async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11)] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    patchGh((s) => (s.prs['77'].isDraft = true))
    await until((x) => stateOf(x) === 'attention', 'attention for the draft')
    expect(notices().at(-1)!.text).toContain('needs attention: draft')
    patchGh((s) => (s.rateLimited = true))
    await until((x) => x.pause?.kind === 'rate', 'the pause')
    const before = ghCalls().length
    await new Promise((r) => setTimeout(r, 500))
    // Paused: no more calls to GitHub while it lasts (at least a minute)
    expect(ghCalls().length).toBe(before)
    expect((await call('merge_queue')).text).toMatch(/Paused until \d\d:\d\d:\d\d UTC: GitHub's rate limit was reached/)
    expect(writes()).toEqual([])
  })

  it('takes an item out on unqueue, and changes nothing on GitHub', async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11)] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const r = await call('unqueue', { pr: '#77' })
    expect(r.text).toBe('Took #77 out of the merge queue; nothing on GitHub changed.')
    expect((await call('unqueue', { pr: 77 })).isError).toBe(true)
    expect(writes()).toEqual([])
  })

  it('asks GitHub once for a rerun it refuses, and tells the session, instead of asking every minute', async () => {
    runtime(
      ghState({
        checks: { [SHA]: [ghCheck('verify', 'success', 11), ghCheck('windows tests', 'failure', 12)] },
        runs: { [SHA]: [ghRun('failure')] },
        rerunError: 'Unable to retry this workflow run because it was created over a month ago (HTTP 403)',
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('rerun-refused')
    await morePolls()
    expect(ghCalls().filter((a) => a.some((x) => /\/rerun(-failed-jobs)?$/.test(x)))).toHaveLength(1)
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).toContain('created over a month ago')
  })

  it('tells the session once when it can no longer read a queued pull request, after three tries', async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11)] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    patchGh((s) => delete s.prs['77'])
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('error')
    await morePolls()
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).toContain('#77 is not a pull request this GitHub login can see')
    expect(writes()).toEqual([])
  })

  it('closes no lower when the top is found merged into another branch than main', async () => {
    runtime(
      ghState({
        prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2 }), '77': ghPr(77, { baseRefName: 'feat/low' }) },
        checks: { [SHA]: [ghCheck('verify', null, 11)] },
      }),
    )
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    // Someone merged the top into the lower's branch by hand
    patchGh((s) => Object.assign(s.prs['77'], { state: 'MERGED', mergeCommit: { oid: 'abcdef1234567890abcdef1234567890abcdef12' } }))
    await until((x) => stateOf(x) === 'merged', 'the item to end')
    expect(writes()).toEqual([])
    expect(notices().at(-1)!.text).toContain('into feat/low, not main')
    expect(notices().at(-1)!.text).toContain('left #76 open')
  })

  it('lands nothing when gh pr merge exits without merging (a GitHub merge queue), and cleans up once GitHub merges it', async () => {
    runtime(
      ghState({
        prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2 }), '77': ghPr(77) },
        mergeNoop: true,
      }),
    )
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('not-merged')
    await morePolls()
    expect(writes().map((w) => w[0])).toEqual(['merge'])
    patchGh((s) => Object.assign(s.prs['77'], { state: 'MERGED', mergeCommit: { oid: 'abcdef1234567890abcdef1234567890abcdef12' } }))
    await until((x) => stateOf(x) === 'merged', 'the merge GitHub made')
    expect(writes().map((w) => w.slice(0, 2).join(' '))).toEqual(['merge 77', 'delete feat/b77', 'close 76', 'delete feat/low'])
  })

  it("keeps the top's branch when another open pull request is based on it", async () => {
    runtime(ghState({ basedOn: { 'feat/b77': [{ number: 90 }] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(writes().map((w) => w[0])).toEqual(['merge'])
    expect(notices().at(-1)!.text).toContain('kept feat/b77: #90 is based on it')
  })

  it('counts only the CI workflow\'s checks, not a same-named check from another workflow', async () => {
    const release = { ...ghCheck('verify', 'failure', 31, '2026-10-17T09:30:00Z'), check_suite: { id: 7000 } }
    runtime(ghState({ checks: { [SHA]: [...green(), release] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
  })

  it('lands a green PR GitHub calls UNSTABLE because of a cancelled duplicate run on its head, and waits when something else failed (#1015)', async () => {
    const twoRuns = (extra: Gh = {}) =>
      ghState({
        prs: { '77': ghPr(77, { mergeStateStatus: 'UNSTABLE' }) },
        // #971: the run that passed and its cancelled duplicate, started after the base moved to main
        runs: { [SHA]: [ghRun('success', 1, SHA, { id: 931, workflow_id: 7, check_suite_id: 5000 }), ghRun('cancelled', 1, SHA, { id: 932, workflow_id: 7, check_suite_id: 5001, created_at: '2026-10-17T08:00:02Z' })] },
        checks: { [SHA]: [...green('2026-10-17T08:01:00Z'), { ...ghCheck('verify', 'cancelled', 21, '2026-10-17T08:00:30Z'), check_suite: { id: 5001 } }, { ...ghCheck('windows tests', 'cancelled', 22, '2026-10-17T08:00:30Z'), check_suite: { id: 5001 } }] },
        ...extra,
      })
    runtime(twoRuns())
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    expect(writes().filter((w) => w[0] === 'merge')[0]![2]).toEqual(expect.arrayContaining(['--match-head-commit', SHA]))
    // Nothing rerun: the duplicate's checks are moot, not a reason to spend a run
    expect(writes().filter((w) => w[0].startsWith('rerun'))).toEqual([])
    await rt!.dispose()
    rt = null
    // A failed check that is not the duplicate's (another workflow's) still keeps it waiting
    rmFakeDir(join(root, 'data'))
    mkdirSync(join(root, 'data'))
    const base = twoRuns()
    runtime({ ...base, checks: { [SHA]: [...base.checks[SHA], { ...ghCheck('lint pr title', 'failure', 31, '2026-10-17T08:02:00Z'), check_suite: { id: 7000 } }] } })
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'waiting', 'it to wait')
    await morePolls(3)
    expect(writes().filter((w) => w[0] === 'merge')).toEqual([])
    expect(stateOf((await call('merge_queue')).data)).toBe('waiting')
  })

  it('keeps the queue in the data folder across a restart of the app, and carries on', async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11), ghCheck('windows tests', null, 12)] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'ci', 'CI')
    await rt!.dispose()
    rt = null
    expect(queueOnDisk().items.map((i: any) => [i.pr, i.state])).toEqual([[77, 'ci']])
    patchGh((s) => (s.checks[SHA] = green('2026-10-17T09:00:00Z')))
    runtime()
    await until((x) => stateOf(x) === 'merged', 'the merge after the restart')
    expect(writes().filter((w) => w[0] === 'merge')).toHaveLength(1)
  })
})

// --- Batches (#962), against the fake gh -----------------------------------------------------------------

/** A check of one run (its check suite), for a batch's run or a PR's own. */
const suiteCheck = (name: string, conclusion: string | null, id: number, suite: number, status?: string) => ({ ...ghCheck(name, conclusion, id), check_suite: { id: suite }, ...(status ? { status } : {}) })
const ownRun = (pr: number, head: string, id: number, suite: number, conclusion: string | null = null, attempt = 1) =>
  ghRun(conclusion, attempt, head, { id, head_branch: `feat/b${pr}`, check_suite_id: suite, ...(conclusion === null ? { status: 'queued' } : {}) })
const ownChecks = (suite: number, conclusion: string | null) => [
  suiteCheck('verify', conclusion, suite * 10 + 1, suite, conclusion === null ? 'queued' : undefined),
  suiteCheck('windows tests', conclusion, suite * 10 + 2, suite, conclusion === null ? 'queued' : undefined),
]
/** The batch branch's head after A then B are merged into it (the fake's merges answer `batch-<head>`). */
const BATCH_HEAD = `batch-${B}`
const batchRun = (conclusion: string | null, attempt = 1) => ghRun(conclusion, attempt, BATCH_HEAD, { id: 950, head_branch: 'queue/batch-1', event: 'workflow_dispatch', check_suite_id: 6000, html_url: `https://github.com/${R}/actions/runs/950` })
const batchChecks = (conclusion: string) => [suiteCheck('verify', 'success', 61, 6000), suiteCheck('windows tests', conclusion, 62, 6000)]
/** #77 at A and #78 at B, their own runs queued behind others; CI on the batch passes. */
const batchState = (patch: Gh = {}) =>
  ghState({
    prs: { '77': ghPr(77, { headRefOid: A, mergeStateStatus: 'UNSTABLE' }), '78': ghPr(78, { headRefOid: B, mergeStateStatus: 'UNSTABLE' }) },
    runs: { [A]: [ownRun(77, A, 901, 5001)], [B]: [ownRun(78, B, 902, 5002)] },
    checks: { [A]: ownChecks(5001, null), [B]: ownChecks(5002, null) },
    on: {
      'cancel:901': { runs: { [A]: [ownRun(77, A, 901, 5001, 'cancelled')] }, checks: { [A]: ownChecks(5001, 'cancelled') } },
      'cancel:902': { runs: { [B]: [ownRun(78, B, 902, 5002, 'cancelled')] }, checks: { [B]: ownChecks(5002, 'cancelled') } },
      'dispatch:queue/batch-1': { runs: { [BATCH_HEAD]: [batchRun('success')] }, checks: { [BATCH_HEAD]: batchChecks('success') } },
    },
    ...patch,
  })
const batchesOnDisk = () => (queueOnDisk().batches ?? []) as any[]
const batchEvents = () => (queueOnDisk().events as { kind: string; text: string }[]).filter((e) => e.kind === 'batch').map((e) => e.text)
const short2 = (w: any[]) => w.slice(0, 2).join(' ')
/** A batch is many gh calls, each a process of its own: wait on events, with bounds generous for a loaded machine. */
const BATCH_WAIT_MS = 90_000

describe('the merge queue batches pull requests waiting for CI into one run (#962)', { timeout: 240_000 * SLOW }, () => {
  it('builds queue/batch-1 from main, runs CI on it once, cancels their own waiting runs, and lands each in order on the tested tree', async () => {
    runtime(batchState())
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'merged', 'both to land', BATCH_WAIT_MS)
    await until(() => batchesOnDisk()[0]?.state === 'done', 'the batch to end', BATCH_WAIT_MS)
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

  it('splits a red batch: two go back to their own CI, whose cancelled runs are rerun, and land from there', async () => {
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
          'rerun-failed:950': { runs: { [BATCH_HEAD]: [batchRun('failure', 2)] } },
          'rerun:901': landsAlone(77, A, 901, 5001),
          'rerun:902': landsAlone(78, B, 902, 5002),
        },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'merged', 'both to land on their own', BATCH_WAIT_MS)
    const order = writes().map(short2)
    expect(order.slice(0, 7)).toEqual(['branch queue/batch-1', `merge-into ${A}`, `merge-into ${B}`, 'dispatch queue/batch-1', 'cancel 901', 'cancel 902', 'rerun-failed 950'])
    expect(order).toContain('delete queue/batch-1')
    expect(order.filter((w) => w.startsWith('rerun ')).sort()).toEqual(['rerun 901', 'rerun 902'])
    // Never landed from the red batch: no batch status on either head
    expect(order.filter((w) => w.startsWith('status'))).toEqual([])
    expect(batchesOnDisk().map((b) => b.state)).toEqual(['failed'])
    expect(batchEvents().some((t) => t.includes('failed twice') && t.includes('Split'))).toBe(true)
    // Not batched again on the same heads
    expect(batchesOnDisk()).toHaveLength(1)
  })

  it('stops landing when main is not the tree the batch had before the next one, and sends that one back to its own CI', async () => {
    runtime(batchState({ mainDrift: true }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'stopped', 'the batch to stop', BATCH_WAIT_MS)
    await until(() => writes().some((w) => short2(w) === 'rerun 902'), "#78's own run to be rerun", BATCH_WAIT_MS)
    const order = writes().map(short2)
    expect(order).toContain('merge 77')
    expect(order).not.toContain('merge 78')
    expect(order).not.toContain(`status ${B}`)
    expect(batchEvents().at(-1)).toMatch(/^Batch queue\/batch-1: stopped before #78: main is not the tree the batch had before #78 \(something else landed\)\. #78 goes back to its own CI \(#77 landed\)\.$/)
    const q = await call('merge_queue', { all: true })
    expect(q.data.queue.find((i: any) => i.pr === 78)).toMatchObject({ state: 'ci', batch: null })
  })

  it('makes no batch for an hour when CI cannot be started on it, and cancels none of their own runs', async () => {
    runtime(batchState({ dispatchError: "Workflow does not have 'workflow_dispatch' trigger (HTTP 422)" }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped', BATCH_WAIT_MS)
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
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped', BATCH_WAIT_MS)
    const readAt = (q: any, pr: number) => q.queue.find((i: any) => i.pr === pr).updatedAt as string
    for (const [first, last] of [
      [77, 78],
      [78, 77],
    ] as const) {
      // The view that shows the state is the one asserted on
      const q = await until((x) => readAt(x, last) > readAt(x, first), `#${last} to be read after #${first}`, BATCH_WAIT_MS)
      expect(q.queue.map((i: any) => i.pr)).toEqual([77, 78])
    }
  })

  it('makes no batch again with one that conflicts, when too few are left to batch', async () => {
    runtime(batchState({ conflicts: [B] }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped', BATCH_WAIT_MS)
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
    await until(() => writes().some((w) => short2(w) === 'dispatch queue/batch-2'), 'the next batch to start', BATCH_WAIT_MS)
    expect(writes().map(short2).slice(0, 4)).toEqual(['branch queue/batch-2', `merge-into ${A}`, `merge-into ${B}`, 'dispatch queue/batch-2'])
    expect(writes().map(short2)).not.toContain('delete queue/batch-1')
    expect(batchEvents().filter((t) => t.includes('queue/batch-1 could not be made'))).toHaveLength(1)
  })

  it('never deletes the batch branch when it ends after three errors before the queue made it', async () => {
    runtime(batchState({ mainError: true }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'error', 'the batch to end in errors', BATCH_WAIT_MS)
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
    await until(() => queueOnDisk().pause?.kind === 'rate', 'the pause', BATCH_WAIT_MS)
    expect(batchesOnDisk()[0].cancelled.map((c: any) => [c.pr, c.run, c.suite])).toEqual([[77, 901, 5001]])
  })

  it('leaves out one GitHub will not merge into the batch (not a conflict), and never batches it again on that head', async () => {
    runtime(batchState({ mergeErrors: [B] }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until(() => batchesOnDisk()[0]?.state === 'dropped', 'the batch to be dropped', BATCH_WAIT_MS)
    await morePolls(6)
    expect(batchesOnDisk()).toHaveLength(1)
    expect(queueOnDisk().items.find((i: any) => i.pr === 78).batchless).toBe(B)
    expect(batchEvents().find((t) => t.includes('would not merge'))).toContain('GitHub would not merge #78 into it')
  })

  it("batches neither a fork's pull request nor a release bump", async () => {
    const base = batchState()
    runtime(
      batchState({
        prs: {
          ...base.prs,
          '78': ghPr(78, { headRefOid: B, mergeStateStatus: 'UNSTABLE', isCrossRepository: true }),
          '79': ghPr(79, { headRefOid: C, mergeStateStatus: 'UNSTABLE', headRefName: 'chore/release-9.9.9-beta.1', title: 'chore(release): 9.9.9-beta.1' }),
        },
        runs: { ...base.runs, [C]: [ownRun(79, C, 903, 5003)] },
        checks: { ...base.checks, [C]: ownChecks(5003, null) },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await call('queue_merge', { pr: 79, owner: 'tester' })
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
    await until(() => batchesOnDisk()[0]?.state === 'landing' || batchesOnDisk()[0]?.state === 'done', 'the batch to pass', BATCH_WAIT_MS)
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
 * quick tier; the queue lands it through a batch built on main and run in full, a batch of one included.
 */
describe('the merge queue lands only from a full run, with two tiers of CI', { timeout: 240_000 * SLOW }, () => {
  /** A pull request's own quick run: finished and green on what it ran, the full tier's check skipped. */
  const quickChecks = (conclusion = 'success') => [ghCheck('full tier', 'skipped', 10), ghCheck('verify', conclusion, 11), ghCheck('windows tests', 'success', 12)]
  const fullChecks = (suite: number, conclusion = 'success', tier = 'success') => [
    suiteCheck('full tier', tier, suite * 10, suite),
    suiteCheck('verify', 'success', suite * 10 + 1, suite),
    suiteCheck('windows tests', conclusion, suite * 10 + 2, suite),
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
    await until((x) => stateOf(x) === 'merged', 'the merge', BATCH_WAIT_MS)
    await until(() => batchesOnDisk()[0]?.state === 'done', 'the batch to end', BATCH_WAIT_MS)
    // Its own run had finished: nothing to cancel, and it lands on the head the batch tested
    expect(writes().map(short2)).toEqual(['branch queue/batch-1', `merge-into ${SHA}`, 'dispatch queue/batch-1', `status ${SHA}`, 'merge 77', 'delete feat/b77', 'delete queue/batch-1'])
    expect(writes().find((w) => w[0] === 'status')).toEqual(['status', SHA, 'success', 'merge-queue', 'Passed CI in queue/batch-1'])
    expect(notices().map((e) => e.text)).toEqual(['Merge queue: merged #77 (feat(apps): change 77) as abcdef1, "feat(apps): change 77 (#77)". Tested in batch queue/batch-1 with nothing else.'])
  })

  it('lands nothing when the batch of one fails, and tells the session why', async () => {
    runtime(
      tieredState({
        on: {
          'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('failure')] }, checks: { [ONE]: fullChecks(6000, 'failure') } },
          'rerun-failed:950': { runs: { [ONE]: [oneRun('failure', 2)] } },
        },
      }),
      TIERS,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention', BATCH_WAIT_MS)
    await morePolls(4)
    const q = await call('merge_queue', { all: true })
    expect(q.data.queue[0].reason.kind).toBe('full-tier')
    expect(notices().at(-1)!.text).toContain('its batch of one ended without landing it: Batch queue/batch-1: required check "windows tests" (job 60002) failed twice')
    expect(writes().map(short2)).toEqual(['branch queue/batch-1', `merge-into ${SHA}`, 'dispatch queue/batch-1', 'rerun-failed 950', 'delete queue/batch-1'])
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
    const q = await until((x) => stateOf(x) === state, state, BATCH_WAIT_MS)
    if (state === 'merged') expect(writes().map(short2)).toContain('close 76')
    else {
      expect(q.queue[0].reason.kind).toBe('lower-failed')
      expect(writes().map(short2)).not.toContain('merge 77')
    }
  })

  it('lands nothing from a batch whose run did not run the full tier', async () => {
    runtime(tieredState({ on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: fullChecks(6000, 'success', 'skipped') } } } }), TIERS)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention', BATCH_WAIT_MS)
    expect(notices().at(-1)!.text).toContain('passed without running the full tier')
    expect(writes().map(short2)).not.toContain('merge 77')
    expect(batchesOnDisk().map((b) => b.state)).toEqual(['dropped'])
  })

  it('lands a full run on its own head without a batch (a release bump), and tells the session about a fork it cannot batch', async () => {
    runtime(
      tieredState({
        prs: {
          '77': ghPr(77, { headRefName: 'chore/release-9.9.9-beta.1', title: 'chore(release): 9.9.9-beta.1' }),
          '78': ghPr(78, { headRefOid: B, isCrossRepository: true }),
        },
        runs: { [SHA]: [ghRun('success')], [B]: [ownRun(78, B, 902, 5002, 'success')] },
        checks: { [SHA]: fullChecks(5000), [B]: quickChecks().map((c) => ({ ...c, check_suite: { id: 5002 } })) },
      }),
      TIERS,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'tester' })
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'attention', 'the bump to land and the fork to need attention', BATCH_WAIT_MS)
    expect(writes().map(short2)).toEqual(['merge 77', 'delete chore/release-9.9.9-beta.1'])
    expect(batchesOnDisk()).toEqual([])
    expect(notices().find((e) => e.text.includes('#78'))!.text).toContain("ran only the quick tier of CI")
  })
})

/**
 * #957: an agent with this app attached typed `gh pr merge` instead of using merge_when_green, because
 * deferred tools show only their names until searched. The descriptions carry the gh command each tool
 * replaces, so a search for the verb finds it, and help answers which tool for which task, on demand
 * (not in the server's instructions, which every session's cached prompt would carry, #512).
 */
describe('agents find the board tool for the gh command they would type', { timeout: 60_000 * SLOW }, () => {
  it('names the gh command each tool replaces in its description, and help lists only tools that exist, the same text every time', async () => {
    runtime(ghState())
    const tools = await rt!.tools(appRef)
    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? ''
    const expected: Record<string, string> = {
      merge_when_green: 'Instead of gh pr merge',
      queue_merge: 'gh pr merge and gh run rerun',
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
    for (const n of ['merge_when_green', 'queue_merge', 'rebase_stack', 'ci_status', 'read_failed_job', 'open_pr', 'comment', 'file_issue', 'release']) expect(named.has(n), n).toBe(true)
  })
})

/** Runs the watch command with the fake gh on its PATH; answers its exit code and output. */
function watch(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WATCH, ...args], {
      env: fake.env({ ...FAST, ...NO_TIERS }),
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const t = setTimeout(() => (child.kill(), reject(new Error(`watch did not end: ${out} ${err}`))), 30_000 * SLOW)
    child.on('close', (code) => (clearTimeout(t), resolve({ code, out, err })))
  })
}

describe('the watch command: the queuing session hears about its items', { timeout: 60_000 * SLOW }, () => {
  it('drives the queue while the app is stopped, and exits 3 with the attention message for its owner only', async () => {
    // This app's server polls only at its start here, so the watch command is what drives the queue
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY' }), '78': ghPr(78, { mergeStateStatus: 'DIRTY' }) } }), IDLE_SERVER)
    const mine = await call('queue_merge', { pr: 77, owner: 'tester' })
    await call('queue_merge', { pr: 78, owner: 'someone else' })
    // The app goes away (Centralu stops an idle one)
    await rt!.dispose()
    rt = null
    const dir = queueFile().replace(/[\\/]merge-queue\.json$/, '')
    expect(mine.data.watch).toContain(dir.includes(' ') ? `"${dir}"` : dir)
    const r = await watch(['watch', '--data', dir, '--owner', 'tester', '--after', String(mine.data.seq)])
    expect(r.code).toBe(3)
    const lines = r.out.trim().split('\n')
    expect(lines[0]).toMatch(/^Merge queue: #77 \(feat\(apps\): change 77\) needs attention: dirty\./)
    expect(r.out).not.toContain('#78')
    expect(lines[1]).toBe('1 still queued for tester. To hear about them, run again in the background:')
    // Quoted only where the shell needs it, as queue_merge's own command is
    expect(lines[2]).toMatch(/merge-queue\.mjs"? watch --data "?.+"? --owner tester --after \d+$/)
    // Its lease is let go: the next driver need not wait for it
    expect(filesNamed(dir, 'merge-queue.lease.json')).toEqual([])
  })

  it('exits 0 with the merge, and 6 when nothing happens before its deadline', async () => {
    runtime(ghState(), IDLE_SERVER)
    const q = await call('queue_merge', { pr: 77, owner: 'tester' })
    await rt!.dispose()
    rt = null
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
    await rt!.dispose()
    rt = null
    const quiet = await watch(['watch', '--data', dir, '--owner', 'tester', '--after', String(p.data.seq), '--minutes', '0.01'])
    expect(quiet.code).toBe(6)
    expect(quiet.out).toContain('No news in 0.01 minutes.')
    expect((await watch(['watch'])).code).toBe(2)
  })
})
