import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeExe, gitWrapper, removeFakeDir, rmFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import { fakeBrokerHost } from '../packages/agent-host/src/apps/external/test-helpers.js'
// @ts-expect-error — plain .mjs of a Centralu app
import { acknowledge, dueReposts, markReposted, noticeText, unacked, watchStart } from '../.centralu/apps/project-board/notice-acks.mjs'
import { fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
import { SLOW } from './test-timing.js'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { decideBefore, decideCi, emptyQueue, enqueue, pushEvent, supersededSuites, twinPassedSuites, quickLanded, handoffReason, lowerFailureCounts, noticeKey, dequeue, normalize, onlySupersededFailures, queueOrder, watchState } from '../.centralu/apps/project-board/queue.mjs'
// @ts-expect-error -- a plain .mjs module of the board app, without types
import { commandEnv, conflictPlan } from '../.centralu/apps/project-board/queue-conflict.mjs'
// @ts-expect-error -- a plain .mjs module of the board app, without types
import { pathMatches } from '../.centralu/apps/project-board/versions.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { evaluateChecks } from '../.centralu/apps/project-board/ci.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { latestRuns, queueBusy, takeLease, releaseLease } from '../.centralu/apps/project-board/queue-driver.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { attributeByPaths, carried, mainVerdict, nextStep, sortCommits } from '../.centralu/apps/project-board/main-guard.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { classifyRun, onFlakyList } from '../.centralu/apps/project-board/run-failure.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { batchCandidates, decideLanding, endBatch, formBatch, gathering, markBatchless, onlyCancelledByBatch, splitBatch } from '../.centralu/apps/project-board/batch.mjs'

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

  it('reruns failed jobs once per head only for an infrastructure failure; failing again needs attention, naming the job; a new head starts over', () => {
    const failing = checksOf([check('verify', 'success'), check('windows tests', 'failure', { jobId: '12' })])
    const timedOut = (attempt = 1, id = 900) => ({ [id]: { real: false, cause: 'timeout', job: { name: 'windows tests', id: '12' }, attempt } })
    const first = decideCi({ item: fresh(), pr: openPr(), checks: failing, runs: [run('failure')], failures: timedOut(), defaultBranch: 'main', now: NOW, ref })
    expect(first).toMatchObject({ action: { type: 'rerun', failedOnly: true } })
    expect(first.event).toContain('a job that hit its timeout')
    const after = fresh({ reruns: first.patch.reruns })
    // Still running its rerun
    expect(decideCi({ item: after, pr: openPr(), checks: failing, runs: [run(null, 2)], defaultBranch: 'main', now: NOW, ref })).toEqual({ state: 'ci' })
    const twice = decideCi({ item: after, pr: openPr(), checks: failing, runs: [run('failure', 2)], failures: timedOut(2), defaultBranch: 'main', now: NOW, ref })
    expect(twice).toMatchObject({ state: 'attention', reason: { kind: 'failed', job: { name: 'windows tests', id: '12' } } })
    expect(twice.reason.text).toContain('"windows tests" (job 12) failed twice')
    // Pushed again: the reruns belong to the old head, so the new head gets its own
    expect(decideCi({ item: after, pr: openPr({ headRefOid: SHA2 }), checks: failing, runs: [run('failure', 1, 901)], failures: timedOut(1, 901), defaultBranch: 'main', now: NOW, ref })).toMatchObject({ action: { type: 'rerun', runId: 901 } })
  })

  // The owner, 2026-10-19: 19 reruns on the queue's first day, most of them a test failing the same way again
  it('never reruns a test or build failure, also in a run CI cancelled because of it (fail fast): attention at once, naming the job', () => {
    const real = { 900: { real: true, cause: 'test', step: 'pnpm test', job: { name: 'verify', id: '11' }, attempt: 1 } }
    const failing = checksOf([check('verify', 'failure', { jobId: '11' }), check('windows tests', 'success')])
    const d = decideCi({ item: fresh(), pr: openPr(), checks: failing, runs: [run('failure')], failures: real, defaultBranch: 'main', now: NOW, ref })
    expect(d).toMatchObject({ state: 'attention', reason: { kind: 'failed', job: { name: 'verify', id: '11' } } })
    expect(d.action).toBeUndefined()
    expect(d.reason.text).toContain('"verify" (job 11) failed at c0ffee0 with a test or build failure (step "pnpm test")')
    // Fail fast: verify failed, CI cancelled the rest, and the run's conclusion is cancelled
    const failFast = checksOf([check('verify', 'failure', { jobId: '11' }), check('windows tests', 'cancelled')])
    const ff = decideCi({ item: fresh(), pr: openPr(), checks: failFast, runs: [run('cancelled')], failures: real, defaultBranch: 'main', now: NOW, ref })
    expect(ff).toMatchObject({ state: 'attention', reason: { kind: 'failed', job: { name: 'verify' } } })
    expect(ff.reason.text).toContain('CI cancelled the rest of run 900 (fail fast)')
    // Not read from its jobs for this attempt: the checks say a job failed, so no rerun either
    expect(decideCi({ item: fresh(), pr: openPr(), checks: failFast, runs: [run('cancelled', 2)], failures: real, defaultBranch: 'main', now: NOW, ref })).toMatchObject({ state: 'attention', reason: { kind: 'failed' } })
    // A run cancelled with no failed job is rerun, as before
    const cancelled = checksOf([check('verify', 'cancelled'), check('windows tests', 'cancelled')])
    expect(decideCi({ item: fresh(), pr: openPr(), checks: cancelled, runs: [run('cancelled')], defaultBranch: 'main', now: NOW, ref })).toMatchObject({ action: { type: 'rerun', failedOnly: false } })
  })

  it("tells a real failure from an infrastructure one by the run's jobs, their steps and what GitHub wrote on them", () => {
    const job = (name: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({ id: name.length, name, conclusion, steps: [], notes: [], ...extra })
    const failedStep = { steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'pnpm test', conclusion: 'failure' }] }
    const cancelledRun = { id: 1, attempt: 1, conclusion: 'cancelled' }
    const failedRun = { id: 1, attempt: 1, conclusion: 'failure' }
    // Fail fast: verify failed in a step, the rest cancelled → real, naming verify
    expect(classifyRun(cancelledRun, [job('e2e (webkit 1/5)', 'cancelled'), job('verify', 'failure', failedStep), job('changes', 'success')])).toMatchObject({ real: true, cause: 'test', step: 'pnpm test', job: { name: 'verify' } })
    // Cancelled with no failed job → infrastructure
    expect(classifyRun(cancelledRun, [job('verify', 'cancelled'), job('e2e (webkit 1/5)', 'cancelled')])).toMatchObject({ real: false, cause: 'cancelled' })
    // A job that hit its timeout: by its conclusion, or by GitHub's note on a cancelled or failed job
    expect(classifyRun(failedRun, [job('e2e (webkit 2/5)', 'timed_out')])).toMatchObject({ real: false, cause: 'timeout' })
    const timeoutNote = ['The job running on runner GitHub Actions 3 has exceeded the maximum execution time of 30 minutes.']
    expect(classifyRun(cancelledRun, [job('e2e (webkit 2/5)', 'cancelled', { notes: timeoutNote })])).toMatchObject({ real: false, cause: 'timeout', job: { name: 'e2e (webkit 2/5)' } })
    expect(classifyRun(failedRun, [job('e2e (webkit 2/5)', 'failure', { ...failedStep, notes: ["The action 'pnpm e2e' has timed out after 25 minutes."] })])).toMatchObject({ real: false, cause: 'timeout' })
    // A test's own timeout is a test failure
    expect(classifyRun(failedRun, [job('verify', 'failure', { ...failedStep, notes: ['Error: Test timed out in 5000ms.'] })])).toMatchObject({ real: true })
    // A lost runner
    const lost = ['The hosted runner: GitHub Actions 12 lost communication with the server. Anything in your workflow that terminates the runner process can cause this error.']
    expect(classifyRun(failedRun, [job('windows tests', 'failure', { notes: lost })])).toMatchObject({ real: false, cause: 'runner' })
    // On the known-flaky list (a pattern); a real failure beside an infrastructure one is real
    expect(classifyRun(failedRun, [job('e2e (webkit 3/5)', 'failure', failedStep)], { flaky: ['e2e (webkit *)'] })).toMatchObject({ real: false, cause: 'flaky' })
    expect(classifyRun(failedRun, [job('e2e (webkit 3/5)', 'failure', failedStep), job('verify', 'failure', failedStep)], { flaky: ['e2e (webkit *)'] })).toMatchObject({ real: true, job: { name: 'verify' } })
    expect(classifyRun(failedRun, [job('e2e (webkit 3/5)', 'timed_out'), job('verify', 'failure', failedStep)])).toMatchObject({ real: true, job: { name: 'verify' } })
    // Failed outside any step it reports, with nothing that names the runner: the session's to look at
    expect(classifyRun(failedRun, [job('verify', 'failure')])).toMatchObject({ real: true, cause: 'no-step' })
    expect(onFlakyList('e2e (webkit 3/5)', ['e2e (chromium *)', 'keeper e2e'])).toBe(false)
    expect(onFlakyList('keeper e2e', ['keeper e2e'])).toBe(true)
  })

  // 2026-10-21 (#1435): `Install WebKit` failed on a 403 from a package source, and the queue reverted reviewed work for it
  it("calls a job that failed in a step that sets it up an infrastructure failure, and one that failed in a test step a real one", () => {
    const failedRun = { id: 1, attempt: 1, conclusion: 'failure' }
    const steps = (failing: string, ...others: [string, string][]) => [
      { name: 'Set up job', conclusion: 'success' },
      ...others.map(([name, conclusion]) => ({ name, conclusion })),
      { name: failing, conclusion: 'failure' },
      { name: 'Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', conclusion: 'failure' },
    ]
    const job = (name: string, failing: string, notes: string[] = []) => ({ id: 31, name, conclusion: 'failure', steps: steps(failing), notes })
    for (const setup of ['Install WebKit', 'Install Chromium', 'Install Linux system dependencies', 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'Run pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413', 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'Run swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6', 'Set up job']) {
      expect(classifyRun(failedRun, [job('e2e (webkit 4/5)', setup)]), setup).toMatchObject({ real: false, cause: 'setup', step: setup, job: { name: 'e2e (webkit 4/5)' } })
    }
    // The first step that failed counts, not a later one (the upload that runs after a failure)
    expect(classifyRun(failedRun, [job('e2e (webkit 4/5)', 'pnpm e2e (shard 4/5)')])).toMatchObject({ real: true, cause: 'test', step: 'pnpm e2e (shard 4/5)' })
    expect(classifyRun(failedRun, [job('verify', 'Run pnpm verify')])).toMatchObject({ real: true, cause: 'test' })
    // An install is the runner's only when its log names the network or a package source
    expect(classifyRun(failedRun, [job('verify', 'Run pnpm install --frozen-lockfile')])).toMatchObject({ real: true, cause: 'test' })
    expect(classifyRun(failedRun, [job('verify', 'Run pnpm install --frozen-lockfile', [' First failure: ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/x: 503'])])).toMatchObject({ real: false, cause: 'setup' })
    // A real failure in another job makes the run real, naming that job
    expect(classifyRun(failedRun, [job('e2e (webkit 4/5)', 'Install WebKit'), job('verify', 'Run pnpm verify')])).toMatchObject({ real: true, job: { name: 'verify' } })
    // The pull request's own run is judged the same way: its setup failure is rerun once, a test failure is not
    const failing = checksOf([check('verify', 'failure'), check('windows tests', 'success')])
    const setup = { 900: classifyRun({ id: 900, attempt: 1, conclusion: 'failure' }, [job('verify', 'Install WebKit')]) }
    expect(decideCi({ item: fresh(), pr: openPr(), checks: failing, runs: [run('failure', 1, 900)], failures: setup, defaultBranch: 'main', now: NOW, ref })).toMatchObject({ state: 'ci', action: { type: 'rerun', runId: 900, failedOnly: true } })
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

  // #1346, 2026-10-19: #1304's head had two build runs created in the same second; in the newer one (39288595041)
  // `windows tests (vitest 1/2)` failed on a cleanup flake, while the same job of the other (39288594599) passed on a rerun
  it('counts a job as passed when it passed in its twin run of the same workflow, whatever their ids, times or attempts (#1346)', () => {
    const wf = (id: number, conclusion: string, suite: number, attempt = 1) => ({ id, workflow_id: 7, check_suite_id: suite, status: 'completed', conclusion, created_at: '2026-10-19T16:30:00Z', run_attempt: attempt })
    const job = (name: string, conclusion: string, suiteId: number) => ({ kind: 'run', name, status: 'completed', conclusion, suiteId })
    const runs = [wf(39288594599, 'success', 61, 2), wf(39288595041, 'failure', 62)]
    const checks = [job('verify', 'success', 61), job('windows tests (vitest 1/2)', 'success', 61), job('verify', 'success', 62), job('windows tests (vitest 1/2)', 'failure', 62)]
    expect([...twinPassedSuites(runs, checks)]).toEqual([62])
    expect(onlySupersededFailures(checks, runs)).toBe(true)
    // …and a batch member UNSTABLE from it lands (the superseded suites a batch's landing reads)
    expect([...supersededSuites(runs, checks)]).toContain(62)
    // The same job failing in both runs is a real failure
    const both = checks.map((c) => (c.name === 'windows tests (vitest 1/2)' ? { ...c, conclusion: 'failure' } : c))
    expect(twinPassedSuites([wf(39288594599, 'failure', 61), runs[1]], both).size).toBe(0)
    expect(onlySupersededFailures(both, [wf(39288594599, 'failure', 61), runs[1]])).toBe(false)
    // A twin of another workflow is no twin
    expect(twinPassedSuites([{ ...runs[0], workflow_id: 8 }, runs[1]], checks).size).toBe(0)
    // A skipped job is no twin: a quick or draft run skips the jobs a full run of the same workflow fails
    const skipped = checks.map((c) => (c.suiteId === 61 && c.name === 'windows tests (vitest 1/2)' ? { ...c, conclusion: 'skipped' } : c))
    expect(twinPassedSuites(runs, skipped).size).toBe(0)
    expect(onlySupersededFailures(skipped, runs)).toBe(false)
  })

  it('merges a green UNSTABLE head when only a cancelled duplicate or an older run of the CI workflow did not pass (#1015)', () => {
    const wf = (id: number, conclusion: string | null, created: string, suite: number) => ({ id, workflow_id: 7, check_suite_id: suite, status: conclusion ? 'completed' : 'in_progress', conclusion, created_at: created })
    const job = (conclusion: string | null, suiteId: number) => ({ kind: 'run', name: 'verify', status: conclusion ? 'completed' : 'in_progress', conclusion, suiteId })
    // #971: run 39008366931 passed, its duplicate 39008366932 was cancelled, both on one head
    const runs = [wf(931, 'success', '2026-10-17T05:00:00Z', 51), wf(932, 'cancelled', '2026-10-17T05:00:02Z', 52)]
    expect(onlySupersededFailures([job('success', 51), job('cancelled', 52)], runs)).toBe(true)
    // An older run that failed, made moot by a newer success
    expect(onlySupersededFailures([job('failure', 50), job('success', 51)], [wf(930, 'failure', '2026-10-17T04:00:00Z', 50), runs[0]])).toBe(true)
    // A newer run whose failed job passed in its twin is moot too (#1346); one that failed a job its twin did not run is not
    expect(onlySupersededFailures([job('success', 51), job('failure', 53)], [runs[0], wf(933, 'failure', '2026-10-17T06:00:00Z', 53)])).toBe(true)
    expect(onlySupersededFailures([job('success', 51), { ...job('failure', 53), name: 'lint' }], [runs[0], wf(933, 'failure', '2026-10-17T06:00:00Z', 53)])).toBe(false)
    // Not moot: a run still going, no success at all, a check of another workflow, a failed status
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

  it('puts a pull request queued again after a conflict at the front, and only then (#1182)', () => {
    const q = emptyQueue()
    enqueue(q, { repo: R, pr: 80, at: '2026-10-17T09:00:00Z' }, ref)
    const { item } = enqueue(q, { repo: R, pr: 81, at: '2026-10-17T09:05:00Z' }, ref)
    enqueue(q, { repo: R, pr: 80, at: '2026-10-17T09:10:00Z' }, ref)
    expect(q.items.map((i: any) => i.front ?? null)).toEqual([null, null])
    Object.assign(item, { state: 'attention', conflict: { head: SHA, at: '2026-10-17T09:06:00Z', outcome: 'handoff', files: ['a.ts'], reason: { kind: 'conflict', text: 'x' } } })
    enqueue(q, { repo: R, pr: 81, at: '2026-10-17T09:20:00Z' }, ref)
    expect(item).toMatchObject({ front: '2026-10-17T09:20:00Z', conflict: { at: '2026-10-17T09:06:00Z', outcome: 'again', reason: null } })
    expect([...q.items].sort(queueOrder).map((i: any) => i.pr)).toEqual([81, 80])
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

  it('batches a pull request fixed after a conflict first, before the older ones (#1182)', () => {
    const q = queueOf(waitingItem(1, A), waitingItem(2, B), waitingItem(3, C, 'queued', { front: '2026-10-17T11:00:00Z' }), waitingItem(4, 'd'.repeat(40), 'queued', { front: '2026-10-17T10:00:00Z' }))
    expect(batchCandidates(q, { max: 6 }).map((i: any) => i.pr)).toEqual([4, 3, 1, 2])
    expect(batchCandidates(q, { max: 1, tiers: true }).map((i: any) => i.pr)).toEqual([4])
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

  // queue/batch-89, 2026-10-19: #1264 alone, green, stayed in landing 20+ minutes; its head had two pull_request runs
  // created in the same second, one cancelled (a duplicate), so GitHub said UNSTABLE, and only the single path knew why
  it('lands an UNSTABLE member whose other failures are runs a successful one superseded, the batch\'s cancelled runs, or both; a real failure still waits', () => {
    const run = (conclusion: string | null, suiteId: number) => ({ kind: 'run', name: 'verify', status: conclusion ? 'completed' : 'queued', conclusion, suiteId })
    const unstable = openPr({ number: 1, headRefOid: A, mergeStateStatus: 'UNSTABLE' })
    // The same-second cancelled duplicate (suite 53) of a run that passed (suite 52)
    expect(landing({ pr: unstable, checks: [run('success', 52), run('cancelled', 53)], superseded: [53] })).toEqual({ do: 'merge' })
    // Without knowing it was superseded, it waits, as before
    expect(landing({ pr: unstable, checks: [run('success', 52), run('cancelled', 53)] })).toMatchObject({ do: 'wait' })
    // A batch-cancelled run (suite 51) and a duplicate together
    expect(landing({ pr: unstable, checks: [run('cancelled', 51), run('success', 52), run('cancelled', 53)], superseded: [53] })).toEqual({ do: 'merge' })
    // A real failure in another suite still waits, whatever else is moot
    expect(landing({ pr: unstable, checks: [run('success', 52), run('cancelled', 53), run('failure', 54)], superseded: [53] })).toMatchObject({ do: 'wait' })
    expect(onlyCancelledByBatch([run('failure', 54)], [51], [53])).toBe(false)
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
    expect(ci({ checks: failed, runs: [run('failure')], failures: { 900: { real: false, cause: 'runner', job: { name: 'verify', id: '5' }, attempt: 1 } } })).toMatchObject({ state: 'ci', action: { type: 'rerun', failedOnly: true } })
    // A test that failed in it is not rerun
    expect(ci({ checks: failed, runs: [run('failure')] })).toMatchObject({ state: 'attention', reason: { kind: 'failed' } })
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

  it('keeps a pull request that failed alone in a batch in attention, without rerunning its own run the batch cancelled', () => {
    const reason = { kind: 'failed', text: '#77 failed alone in batch queue/batch-3: "verify" failed.', job: { name: 'verify', id: '61' } }
    const cancelled = tiered([check(TIER, 'skipped'), check('verify', 'cancelled'), check('windows tests', 'cancelled')])
    const d = ci({ item: fresh({ alone: { head: SHA, text: reason.text, reason } }), checks: cancelled, runs: [run('cancelled')] })
    expect(d).toEqual({ state: 'attention', reason })
    // The same reason on the same head: one message, not one per poll
    expect(noticeKey(d.reason, SHA)).toBe('failed:' + SHA + ':61')
    // A new head is tried afresh: its cancelled run is rerun, and it is batched again
    expect(ci({ item: fresh({ alone: { head: SHA2, text: reason.text, reason } }), checks: cancelled, runs: [run('cancelled')] })).toMatchObject({ action: { type: 'rerun' } })
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

  // The owner, 2026-10-19: day one's batches averaged 1.25 pull requests, about 20 minutes each, one after another
  it('batches every ready item, whether its own quick run passed, still runs, waits or has not reported, four at most, those fixed after a conflict first', () => {
    const quick = (pr: number, head: string, extra: Record<string, unknown> = {}) =>
      waitingItem(pr, head, 'completed', { ci: { head, verdict: 'quick', runs: [{ id: 900 + pr, status: 'completed' }] }, ...extra })
    const D = 'd'.repeat(40)
    const q = queueOf(
      quick(1, A),
      waitingItem(2, B, 'in_progress'), // its quick run is going
      waitingItem(3, C), // its quick run waits for a runner
      waitingItem(4, D, 'queued', { ci: { head: D, verdict: 'none', runs: [] } }), // no run reported yet
      waitingItem(5, '5'.repeat(40), 'completed', { ci: { head: '5'.repeat(40), verdict: 'failing', runs: [{ id: 905, status: 'completed' }] } }), // its own CI failed
      quick(6, '6'.repeat(40), { front: '2026-10-17T10:30:00Z' }), // fixed after a conflict
      quick(7, '7'.repeat(40), { lowers: [70, 71] }), // a stack: one member
    )
    expect(batchCandidates(q, { max: 4, tiers: true }).map((i: any) => i.pr)).toEqual([6, 1, 2, 3])
    expect(batchCandidates(q, { max: 10, tiers: true }).map((i: any) => i.pr)).toEqual([6, 1, 2, 3, 4, 7])
    // Without tiers only those not started: their own run could land them
    expect(batchCandidates(q, { max: 10 }).map((i: any) => i.pr)).toEqual([3])
    // The project's batches take four
    expect(PROJECT.queue.batch.max).toBe(4)
  })

  it('waits a moment for one queued just now to be read, so pull requests queued together share a batch', () => {
    const now = Date.parse('2026-10-17T10:00:00Z')
    const q = queueOf(waitingItem(1, A), { repo: R, pr: 2, lowers: [], state: 'waiting', head: null, queuedAt: '2026-10-17T09:59:40Z' })
    expect(gathering(q, { repo: R, now, size: 1, max: 4 })).toBe(true)
    // Not for ever: queued over a minute ago and still not read (GitHub slow to say), the batch goes without it
    expect(gathering(q, { repo: R, now: now + 61_000, size: 1, max: 4 })).toBe(false)
    // Nor when the batch is full, or the other one is read already, needs attention or is in another repository
    expect(gathering(q, { repo: R, now, size: 4, max: 4 })).toBe(false)
    q.items[1].state = 'attention'
    expect(gathering(q, { repo: R, now, size: 1, max: 4 })).toBe(false)
    q.items[1].state = 'ci'
    q.items[1].repo = 'someone/else'
    expect(gathering(q, { repo: R, now, size: 1, max: 4 })).toBe(false)
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

const PROJECT = JSON.parse(readFileSync(join(REPO_ROOT, '.centralu/apps/project-board/project.json'), 'utf8'))
const LISTS = PROJECT.queue.conflicts as { mechanical: { files: string[]; run: string[][] }[]; never: string[] }
const MECHANICAL_FILES = [
  'pnpm-lock.yaml',
  'docs/generated/schema.md',
  'packages/agent-host/src/dev-services/store-migrations.golden.json',
  'packages/agent-host/src/dev-services/store-migrations-swap.golden.json',
  'apps/desktop/src-tauri/permissions/autogenerated/alert.toml',
  'tooling/lint-allowlist/packages-agent-host.txt',
]

describe('which conflicts the merge queue regenerates itself (#1182)', () => {
  it("regenerates only files on project.json's mechanical list, each command once and the lockfile first", () => {
    const plan = conflictPlan(MECHANICAL_FILES, LISTS)
    expect(plan.handoff).toBe(false)
    expect(plan.commands.map((c: string[]) => c.join(' '))).toEqual([
      'pnpm install --lockfile-only --ignore-scripts',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm docs:schema',
      'pnpm exec vitest run --update packages/agent-host/src/dev-services/store-migrations.test.ts',
      'pnpm bundle:host',
      'cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml',
      'pnpm lint:tighten',
      'pnpm exec vitest run tooling/type-aware-lint.test.ts',
    ])
    expect(conflictPlan(['pnpm-lock.yaml'], LISTS).commands).toEqual([['pnpm', 'install', '--lockfile-only', '--ignore-scripts']])
    // The lint allowlists (#1423): main's version, lowered by `pnpm lint:tighten`, then checked; nothing else is run for them
    expect(conflictPlan(['tooling/lint-allowlist/packages-ui.txt', 'tooling/lint-allowlist/e2e.txt'], LISTS)).toMatchObject({ handoff: false })
    expect(conflictPlan(['tooling/lint-allowlist/packages-ui.txt'], LISTS).commands.map((c: string[]) => c.join(' '))).toEqual([
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm lint:tighten',
      'pnpm exec vitest run tooling/type-aware-lint.test.ts',
    ])
    // A conflict in code beside an allowlist still goes to the author
    expect(conflictPlan(['tooling/lint-allowlist/packages-ui.txt', 'packages/ui/src/app.tsx'], LISTS)).toEqual({ handoff: true, never: [], other: ['packages/ui/src/app.tsx'] })
    // A clean merge GitHub called DIRTY: nothing to regenerate
    expect(conflictPlan([], LISTS)).toMatchObject({ handoff: false, commands: [] })
  })

  it('hands off the UX baseline and store migration steps always, and any file the list does not name', () => {
    expect(conflictPlan(['e2e/ux/baseline.json'], LISTS)).toEqual({ handoff: true, never: ['e2e/ux/baseline.json'], other: [] })
    const migration = 'packages/agent-host/src/dev-services/store/migrations/v55.ts'
    expect(conflictPlan(['pnpm-lock.yaml', migration, 'packages/agent-host/src/dev-services/store-migrations.golden.json'], LISTS)).toEqual({ handoff: true, never: [migration], other: [] })
    expect(conflictPlan(['packages/agent-host/src/dev-services/store/migrate-runner.ts'], LISTS).handoff).toBe(true)
    expect(conflictPlan(['pnpm-lock.yaml', 'packages/ui/src/app.tsx'], LISTS)).toEqual({ handoff: true, never: [], other: ['packages/ui/src/app.tsx'] })
    // Never wins over the mechanical list
    expect(conflictPlan(['e2e/ux/baseline.json'], { mechanical: [{ files: ['e2e/**'], run: [['x']] }], never: LISTS.never }).handoff).toBe(true)
    // An empty list regenerates nothing
    expect(conflictPlan(['pnpm-lock.yaml'], { mechanical: [], never: [] })).toEqual({ handoff: true, never: [], other: ['pnpm-lock.yaml'] })
  })

  it("names files and commands that exist in this repository, never a command it would have to guess", () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts
    for (const e of LISTS.mechanical) {
      for (const pattern of e.files) expect(conflictPlan(tracked, { mechanical: [{ files: [pattern], run: [] }], never: [] }).other.length, pattern).toBeLessThan(tracked.length)
      for (const argv of e.run) {
        expect(['pnpm', 'cargo']).toContain(argv[0])
        if (argv[0] === 'pnpm' && !['install', 'exec'].includes(argv[1]!)) expect(scripts[argv[1]!], argv.join(' ')).toBeTruthy()
        // An install runs no package scripts of the pull request's (#1182 review)
        if (argv[0] === 'pnpm' && argv[1] === 'install') expect(argv, argv.join(' ')).toContain('--ignore-scripts')
        for (const a of argv.filter((x) => /\.(ts|toml)$/.test(x))) expect(tracked, a).toContain(a)
      }
    }
    // Every never pattern names a tracked file
    for (const pattern of LISTS.never) expect(conflictPlan(tracked, { mechanical: [], never: [pattern] }).never.length, pattern).toBeGreaterThan(0)
  })

  it('runs the commands with only what they need from the environment, no token or key of the queue', () => {
    const env = commandEnv({ PATH: '/bin', Path: 'C:\\bin', HOME: '/h', TEMP: '/t', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', NPM_CONFIG__AUTHTOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', FAKE_GH_STATE: 'x', SOMETHING_NEW: 'x' })
    expect(env).toEqual({ PATH: '/bin', Path: 'C:\\bin', HOME: '/h', TEMP: '/t', CI: '1' })
  })

  it('hands a conflict to the author session with the exact instruction, or says no author session is recorded', () => {
    const pr = openPr({ headRefName: 'feat/b77' })
    const files = ['packages/ui/src/app.tsx']
    const to = handoffReason({ item: fresh({ author: 'writer' }), pr, files, why: 'Not mechanical.', ref })
    expect(to.reason).toMatchObject({ kind: 'conflict', files, relay: { to: 'writer', branch: 'feat/b77', text: 'Merge main into feat/b77 and push again; conflicted files: packages/ui/src/app.tsx.' } })
    expect(to.reason.text).toContain('Author session: writer. Relay this to it (the queue cannot message a session yet, #1173): "Merge main into feat/b77 and push again; conflicted files: packages/ui/src/app.tsx."')
    const none = handoffReason({ item: fresh({ author: null }), pr, files, why: 'Not mechanical.', ref })
    expect(none.reason.relay.to).toBeNull()
    expect(none.reason.text).toContain('No author session is recorded for #77 (queue_merge author). Start a session on its branch feat/b77 with this instruction: "Merge main into feat/b77')
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
} else if (args[0] === 'pr' && args[1] === 'ready') {
  // Ready for review, or back into a draft (--undo): GitHub says DRAFT for a draft's merge state
  const pr = st.prs[args[2]]
  const undo = args.includes('--undo')
  write([undo ? 'draft' : 'ready', args[2]])
  pr.isDraft = undo
  pr.mergeStateStatus = undo ? 'DRAFT' : 'CLEAN'
  save()
} else if (args[0] === 'pr' && args[1] === 'merge') {
  if (st.prs[args[2]] && st.prs[args[2]].isDraft) fail('Pull request #' + args[2] + ' is still a draft (HTTP 405)')
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
  if (args.includes('--head')) out(Object.values(st.prs ?? {}).filter((p) => p.headRefName === args[args.indexOf('--head') + 1]))
  else out((st.basedOn ?? {})[args[args.indexOf('--base') + 1]] ?? [])
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
  st.dispatched = [...(st.dispatched ?? []), { ref: body.ref, inputs: body.inputs ?? null }]
  // A probe the test answers by its branch: a finished run on whatever commit the branch holds in GitHub's stand-in
  const answer = (st.probeAnswers ?? {})[body.ref]
  if (answer) {
    const head = require('node:child_process').execFileSync('git', ['-C', st.origin, 'rev-parse', 'refs/heads/' + body.ref], { encoding: 'utf8' }).trim()
    st.branchRuns = { ...st.branchRuns, [body.ref]: [{ id: 7000 + st.dispatched.length, run_attempt: 1, head_sha: head, head_branch: body.ref, event: 'workflow_dispatch', status: 'completed', conclusion: answer, created_at: '2099-01-01T00:00:00Z' }] }
  }
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
} else if (path && path.startsWith(R + '/contents/')) {
  // A file the board reads from the repository (the pull request template): as the test gives it, else none
  const file = (st.files ?? {})[path.slice((R + '/contents/').length).split('?')[0]]
  if (file === undefined) fail('Not Found (HTTP 404)')
  out(file)
} else if (path && /\/check-runs\?/.test(path)) {
  out({ check_runs: (st.checks ?? {})[path.split('/')[4]] ?? [] })
} else if (path && /\/commits\/[^/]+\/status$/.test(path)) {
  out({ state: 'pending', statuses: [] })
} else if (path && path.includes('/actions/workflows/build.yml/runs?')) {
  // By commit (a pull request's, a batch's), else by branch (main's push runs, a bisect probe's): the main guard (#1259)
  const query = new URLSearchParams(path.split('?')[1])
  const runs = query.get('head_sha') ? ((st.runs ?? {})[query.get('head_sha')] ?? []) : ((st.branchRuns ?? {})[query.get('branch')] ?? [])
  out(args.includes('--slurp') ? [{ workflow_runs: runs }] : { workflow_runs: runs })
} else if (path && /\/actions\/runs\/\d+\/rerun(-failed-jobs)?$/.test(path) && st.rerunError) {
  fail(st.rerunError)
} else if (path && /\/actions\/runs\/\d+\/rerun(-failed-jobs)?$/.test(path)) {
  write([path.endsWith('failed-jobs') ? 'rerun-failed' : 'rerun', path.split('/')[5]])
} else if (path && /\/actions\/runs\/\d+\/jobs\?/.test(path)) {
  // A run's jobs and steps: as the test gives them, else its checks, a failed one failing in a step (a real failure)
  const id = Number(path.split('/')[5])
  if ((st.jobs ?? {})[id]) out({ jobs: st.jobs[id] })
  else {
    const runs = Object.values(st.runs ?? {}).flat().filter((r) => r.id === id)
    const run = runs.sort((a, b) => (b.run_attempt ?? 1) - (a.run_attempt ?? 1))[0]
    const checks = run ? ((st.checks ?? {})[run.head_sha] ?? []).filter((c) => (c.check_suite ?? {}).id === run.check_suite_id) : []
    out({ jobs: checks.map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, steps: c.conclusion === 'failure' ? [{ name: 'Set up job', conclusion: 'success' }, { name: 'pnpm test', conclusion: 'failure' }] : [] })) })
  }
} else if (path && /\/check-runs\/\d+\/annotations/.test(path)) {
  out((st.annotations ?? {})[path.split('/')[4]] ?? [])
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
} else if (path === R + '/pulls' && args.includes('POST')) {
  // A pull request the queue opens itself (the main guard's revert, #1259): open, and readable as any other
  const body = JSON.parse(stdin)
  const number = 600 + Object.keys(st.prs ?? {}).filter((n) => Number(n) >= 600).length
  st.prs = { ...st.prs, [number]: { number, title: body.title, body: body.body, state: 'OPEN', isDraft: body.draft === true, mergeable: 'MERGEABLE', mergeStateStatus: body.draft === true ? 'DRAFT' : 'CLEAN', labels: [], headRefOid: (st.prHeads ?? {})[body.head] ?? 'revert-' + number, headRefName: body.head, baseRefName: body.base, isCrossRepository: false, url: 'https://github.com/ijun17/centralu/pull/' + number, mergeCommit: null } }
  write(['pr-create', body.head, body.title])
  out({ number, html_url: 'https://github.com/ijun17/centralu/pull/' + number })
} else if (path && /\/issues\/\d+\/labels$/.test(path)) {
  const body = JSON.parse(stdin)
  write(['labels', path.split('/')[4], body.labels])
  out([])
} else if (path === R + '/issues' && args.includes('POST')) {
  const body = JSON.parse(stdin)
  st.issues = [...(st.issues ?? []), body]
  write(['issue', body.title])
  out({ number: 500 + st.issues.length, html_url: 'https://github.com/ijun17/centralu/issues/' + (500 + st.issues.length) })
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

// Waiting for the app trees can take a while on a loaded Windows machine: grace, kill, the process listing and
// a taskkill per leftover, past the default 10 s hook limit (#1312)
afterEach(async () => {
  // Until the app and what it left running have ended: they run Node from this folder and write in it
  await rt?.dispose({ awaitTree: true })
  rt = null
  // Without blocking the event loop while it retries; a folder Windows still holds is left to its temporary-folder cleanup (#1346)
  await removeFakeDir(root)
}, 30_000 * SLOW)

const FAST = { PROJECT_BOARD_QUEUE_TICK_MS: '50', PROJECT_BOARD_QUEUE_POLL_MS: '50' }
/**
 * Every git the tests and the app run here (#1346): no automatic maintenance. Since git 2.29 a commit, merge or fetch may
 * start a detached `git maintenance run --auto` that goes on working in the checkout after the command returns, which
 * kept a test's folder busy for its cleanup on Windows (`EBUSY ... rmdir …\\work`, as #503 saw for fixture repositories).
 */
const NO_GIT_MAINTENANCE = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' }
/** A server that polls only at its start: what a test drives or reads, nothing moves under it */
const IDLE_SERVER = { PROJECT_BOARD_QUEUE_TICK_MS: String(3_600_000) }
/**
 * Without two tiers of CI unless a test asks for them (TIERS): the queue as a repository without them runs it, every
 * green run a full one. The tiers this repository has (project.json ci.fullTier) have tests of their own below.
 */
const NO_TIERS = { PROJECT_BOARD_CI_FULL_TIER: '' }
/** Two tiers, landing only from a full run (`ci.landTier: full`), as before #1259 */
const TIERS = { PROJECT_BOARD_CI_FULL_TIER: 'full tier', PROJECT_BOARD_CI_LAND_TIER: 'full' }
/** Two tiers, landing after the fast tier (#1259, this repository's project.json) */
const FAST_LAND = { PROJECT_BOARD_CI_FULL_TIER: 'full tier', PROJECT_BOARD_CI_LAND_TIER: 'quick', PROJECT_BOARD_CI_QUICK_CHECKS: '["verify","windows tests"]' }
/** Two tiers, landing after the fast tier with this repository's own quick checks (project.json ci.quickChecks) */
const REAL_QUICK = { PROJECT_BOARD_CI_FULL_TIER: 'full tier', PROJECT_BOARD_CI_LAND_TIER: 'quick' }
/**
 * No checkout to merge a conflicting pull request in unless a test gives one (#1182): the queue would otherwise
 * merge in the checkout this app is committed in, whose remote is the real GitHub.
 */
const NO_CHECKOUT = { PROJECT_BOARD_QUEUE_CHECKOUT: '' }
/** No main guard unless a test asks for it (#1259): it reads main's runs on its own clock */
const NO_GUARD = { PROJECT_BOARD_QUEUE_GUARD: 'off' }

function runtime(state?: Gh, env: Record<string, string> = {}, path: string[] = []) {
  if (state) fake.setState(state)
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: fake.env({ ...FAST, ...NO_TIERS, ...NO_CHECKOUT, ...NO_GUARD, ...NO_GIT_MAINTENANCE, ...env }, path),
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
const notices = () => (queueOnDisk().events as { kind: string; notify: boolean; text: string; told?: boolean | 'failed'; repostedAt?: string; reposted?: 'failed' }[]).filter((e) => e.notify)

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

describe('the merge queue keeps the board app running while it has work (#1236)', { timeout: 60_000 * SLOW }, () => {
  it('is busy while an item waits or is in CI, or a batch has its end to do; not for an item needing attention, nor once all of it ended', () => {
    const q = emptyQueue()
    expect(queueBusy(q)).toBe(null)
    q.items.push({ ...fresh(), state: 'waiting' }, { ...fresh({ pr: 78 }), state: 'ci' }, { ...fresh({ pr: 79 }), state: 'attention' })
    expect(queueBusy(q)).toBe('merge queue, 2 items')
    // Only one needing attention left: it waits on a session, and does not keep the app running
    q.items[0].state = 'merged'
    q.items[1].state = 'closed'
    expect(queueBusy(q)).toBe(null)
    q.batches.push({ id: 1, state: 'landing', members: [{ pr: 77 }] })
    expect(queueBusy(q)).toBe('merge queue, a batch finishing')
  })

  it('holds busy from the moment a pull request is queued until it lands, and releases it then', async () => {
    const r = runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11), ghCheck('windows tests', 'success', 12)] }, runs: { [SHA]: [ghRun(null)] } }))
    const busy = () => r.list().find((a) => a.appId === 'project-board')?.busy
    await call('merge_queue')
    expect(busy()).toBeUndefined()
    expect((await call('queue_merge', { pr: 77, owner: 'tester' })).isError).toBe(false)
    await until(() => busy() === 'merge queue, 1 item', 'the hold')
    // CI finishes: it lands, and the queue has no work left
    patchGh((s) => {
      s.checks[SHA] = [ghCheck('verify', 'success', 11), ghCheck('windows tests', 'success', 12)]
      s.runs[SHA] = [ghRun('success')]
    })
    await until((x) => stateOf(x) === 'merged' && busy() === undefined, 'the landing and the release')
  })

  it('lets the hold go when the only item left needs attention', async () => {
    const cancelled = [ghCheck('verify', 'cancelled', 11), ghCheck('windows tests', 'success', 12)]
    const r = runtime(ghState({ checks: { [SHA]: cancelled }, runs: { [SHA]: [ghRun('cancelled')] }, on: { 'rerun:900': { runs: { [SHA]: [ghRun('cancelled', 2)] } } } }))
    const busy = () => r.list().find((a) => a.appId === 'project-board')?.busy
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until(() => busy() === 'merge queue, 1 item', 'the hold')
    await until((x) => stateOf(x) === 'attention' && busy() === undefined, 'attention and the release')
  })
})

describe('the merge queue posts its news into the session that queued (#1161 item 1)', { timeout: 60_000 * SLOW }, () => {
  /** The sessions told, as Centralu's session side receives them (a recording broker host) */
  function telling(fail: (sessionId: string) => string | null = () => null) {
    const told: { sessionId: string; text: string; appId: string }[] = []
    rt!.attachBrokerHost(
      fakeBrokerHost({
        appNotice: async (sessionId, text, app) => {
          const why = fail(sessionId)
          if (why) throw new Error(why)
          told.push({ sessionId, text, appId: app.appId })
        },
      }),
    )
    return told
  }

  it('a landing reaches the queuing session as a message, once, with no watch command; the answer says so', async () => {
    runtime(ghState())
    const told = telling()
    const q = await call('queue_merge', { pr: 77, owner: 'tester' })
    expect(q.data.told).toBe(true)
    expect(q.text).toContain('the queue posts its news into it as a message')
    // The watch command is still given, for a session that wants it
    expect(q.data.watch).toContain('merge-queue.mjs')
    await until((x) => stateOf(x) === 'merged', 'the merge')
    await until(() => told.length > 0, 'the notice')
    // Ticks go on (every 50 ms here) with nothing left to poll: a told message is not posted again
    await new Promise((r) => setTimeout(r, 500))
    expect(told).toEqual([{ sessionId: 's1', text: 'Merge queue: merged #77 (feat(apps): change 77) as abcdef1, "feat(apps): change 77 (#77)".', appId: 'project-board' }])
    expect(notices().map((e) => e.told)).toEqual([true])
    // A reader of merge_queue never sees the address
    expect(JSON.stringify((await call('merge_queue', { all: true })).data)).not.toContain('"to"')
  })

  it('needing attention reaches it too, once, with what to do', async () => {
    const cancelled = [ghCheck('verify', 'cancelled', 11), ghCheck('windows tests', 'success', 12)]
    runtime(ghState({ checks: { [SHA]: cancelled }, runs: { [SHA]: [ghRun('cancelled')] }, on: { 'rerun:900': { runs: { [SHA]: [ghRun('cancelled', 2)] } } } }))
    const told = telling()
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    await until(() => told.length > 0, 'the notice')
    await morePolls()
    expect(told).toHaveLength(1)
    expect(told[0]!.sessionId).toBe('s1')
    expect(told[0]!.text).toMatch(/^Merge queue: #77 \(feat\(apps\): change 77\) needs attention: cancelled\. .* Or take it out with unqueue\.\nAck it with the board app's ack tool once handled/)
  })

  it('a session that is gone is given up on after a few tries, not tried forever; the event stays for a watch command', async () => {
    runtime(ghState(), { PROJECT_BOARD_QUEUE_TELL_RETRY_MS: '1' })
    const told = telling(() => 'that session is gone')
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge')
    await until(() => notices()[0]?.told === 'failed', 'giving up')
    expect(told).toEqual([])
    expect(notices()).toHaveLength(1)
  })
})

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
    expect(n[0]!.text).toMatch(/^Merge queue: #77 \(feat\(apps\): change 77\) needs attention: cancelled\. #77: CI run 900 was cancelled again after one rerun at c0ffee0 \(cancelled, with no failed job\)\./)
  })

  it('reruns the failed jobs of a job that hit its timeout once; a test failing after it names the job and its first failure, once; a new head starts over and lands', async () => {
    const failing = [ghCheck('verify', 'success', 11), ghCheck('windows tests', 'failure', 12)]
    runtime(
      ghState({
        checks: { [SHA]: failing },
        runs: { [SHA]: [ghRun('failure')] },
        annotations: { '12': [{ message: 'The job running on runner GitHub Actions 3 has exceeded the maximum execution time of 30 minutes.' }] },
        // Its rerun fails in a test, which is not rerun
        on: { 'rerun-failed:900': { runs: { [SHA]: [ghRun('failure', 2)] }, annotations: { '12': [] } } },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('failed')
    await morePolls()
    expect(writes().map((w) => w[0])).toEqual(['rerun-failed'])
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).toContain('"windows tests" (job 12) failed at c0ffee0 with a test or build failure (step "pnpm test")')
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

  // The contract with CI: in a full run, a failed verify cancels the rest (fail fast), and the run's conclusion is cancelled
  it.each([
    ['failed', 'failure', 'success'],
    ['cancelled by fail fast', 'cancelled', 'cancelled'],
  ])('reruns nothing when verify fails in a test (run %s): attention at once, naming the job and its first failure', async (_what, conclusion, other) => {
    runtime(
      ghState({
        checks: { [SHA]: [ghCheck('verify', 'failure', 12), ghCheck('windows tests', other, 13)] },
        runs: { [SHA]: [ghRun(conclusion)] },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason).toMatchObject({ kind: 'failed', job: { name: 'verify', id: '12' } })
    await morePolls()
    expect(writes()).toEqual([])
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).toContain('"verify" (job 12) failed at c0ffee0 with a test or build failure (step "pnpm test")')
    expect(notices()[0]!.text).toContain('First failure: FAIL unit packages/x.test.ts > adds numbers')
    // Its jobs are read once for the run, not again every poll while it waits for the session
    expect(ghCalls().filter((a) => a.some((x) => /\/actions\/runs\/900\/jobs/.test(x)))).toHaveLength(1)
  })

  it('reruns once a job whose runner was lost, and lands it when the rerun passes', async () => {
    runtime(
      ghState({
        checks: { [SHA]: [ghCheck('verify', 'success', 11), ghCheck('windows tests', 'failure', 12)] },
        runs: { [SHA]: [ghRun('failure')] },
        jobs: { 900: [{ id: 11, name: 'verify', conclusion: 'success', steps: [] }, { id: 12, name: 'windows tests', conclusion: 'failure', steps: [{ name: 'pnpm test', conclusion: null }] }] },
        annotations: { '12': [{ message: 'The hosted runner: GitHub Actions 12 lost communication with the server.' }] },
        on: { 'rerun-failed:900': { runs: { [SHA]: [ghRun('success', 2)] }, checks: { [SHA]: green() } } },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge after the rerun')
    expect(writes().map((w) => w[0])).toEqual(['rerun-failed', 'merge', 'delete'])
  })

  it('tells the session once when a pull request goes DIRTY and the queue has no checkout to merge it in, and never merges it', async () => {
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }) } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls()
    expect(writes()).toEqual([])
    expect(notices().map((e) => e.text)).toEqual([
      'Merge queue: #77 (feat(apps): change 77) needs attention: conflict. #77 conflicts with main at c0ffee0. The queue has no checkout to merge it in. Author session: tester. Relay this to it (the queue cannot message a session yet, #1173): "Merge main into feat/b77 and push again; conflicted files: not known (GitHub says it conflicts)." The queue takes the new head by itself, at the front of the queue. Or take it out with unqueue.',
    ])
    const listed = await call('merge_queue')
    expect(listed.text).toContain('Merge queue: 1 need attention.')
    expect(listed.text).toContain('#77 feat(apps): change 77 — needs attention: conflict')
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
        annotations: { '12': [{ message: 'The job running on runner GitHub Actions 3 has exceeded the maximum execution time of 30 minutes.' }] },
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
    await rt!.dispose({ awaitTree: true })
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
    await rt!.dispose({ awaitTree: true })
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

// --- Conflicts (#1182): real git, a bare repository standing for GitHub's --------------------------

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...NO_GIT_MAINTENANCE }
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
const MIGRATION = 'packages/agent-host/src/dev-services/store/migrations/v55.ts'

type ConflictRepo = { work: string; origin: string; main: string; heads: Record<string, string> }

/**
 * A repository where each branch (`feat/b<N>`) and main changed the same files since they parted, so merging main
 * into the branch conflicts in exactly those files; each branch also has a file of its own. The checkout's remote is
 * GitHub's address, which git rewrites to `origin.git` (as rebase_stack's tests do), and it is left on a branch of its
 * own with uncommitted work, which nothing may touch.
 */
function conflictRepo(branches: Record<number, string[]>, { base = {}, branch = {} }: { base?: Record<string, string>; branch?: Record<string, string> } = {}): ConflictRepo {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  g(root, 'init', '-q', '--bare', '-b', 'main', origin)
  g(root, 'init', '-q', '-b', 'main', work)
  g(work, 'config', 'user.name', 'Tester')
  g(work, 'config', 'user.email', 'tester@example.test')
  g(work, 'config', 'commit.gpgsign', 'false')
  g(work, 'remote', 'add', 'origin', 'https://github.com/ijun17/centralu.git')
  g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/ijun17/centralu.git')
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
const appTmp = () => join(root, 'tmp')

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
    expect(told[0]!.text).toContain('Author session: writer. Relay this to it (the queue cannot message a session yet, #1173): "Merge main into feat/b77 and push again; conflicted files: pnpm-lock.yaml, src/app.ts."')
    expect((told[0] as any).relay).toEqual({ to: 'writer', branch: 'feat/b77', text: 'Merge main into feat/b77 and push again; conflicted files: pnpm-lock.yaml, src/app.ts.' })
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
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'merged', 'both to land on their own', BATCH_WAIT_MS)
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
 * quick tier; the queue lands it through a batch built on main and run in full (`ci.landTier: full`), or run on the quick
 * tier (`quick`, #1259), a batch of one included.
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
    await until((x) => stateOf(x) === 'merged', 'the merge', BATCH_WAIT_MS)
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
    await until((x) => stateOf(x) === 'merged', 'the merge', BATCH_WAIT_MS)
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
    await until(() => batchesOnDisk()[0]?.state === 'done', 'the batch to land', BATCH_WAIT_MS)
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
    await until((x) => stateOf(x, 77) === 'merged' && stateOf(x, 78) === 'attention', '#77 to land and #78 to need attention', BATCH_WAIT_MS)
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
    await until((x) => stateOf(x) === 'attention', 'attention', BATCH_WAIT_MS)
    await morePolls(4)
    const q = await call('merge_queue', { all: true })
    expect(q.data.queue[0].reason).toMatchObject({ kind: 'failed', job: { name: 'windows tests', id: '60002' } })
    // Told once, at once, with the batch's failing job and its first failure line
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).toContain('#77 failed alone in batch queue/batch-1, a full run of it on main at main0: "windows tests" (job 60002) failed at batch-c with a test or build failure')
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
    const q = await until((x) => stateOf(x) === state, state, BATCH_WAIT_MS)
    if (state === 'merged') expect(writes().map(short2)).toContain('close 76')
    else {
      expect(q.queue[0].reason.kind).toBe('lower-failed')
      expect(writes().map(short2)).not.toContain('merge 77')
    }
  })

  it('lands after the fast tier (#1259): the batch asks for the quick tier and lands from it, its full tier skipped', async () => {
    runtime(tieredState({ on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: fullChecks(6000, 'success', 'skipped') } } } }), FAST_LAND)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge', BATCH_WAIT_MS)
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
  ]

  it("lands a batch whose quick run passed while the full tier's jobs never reported, under ci.landTier quick", async () => {
    runtime(
      tieredState({ workflow: FULL_WORKFLOW, on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('success')] }, checks: { [ONE]: realQuick(6000) } } } }),
      REAL_QUICK,
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge', BATCH_WAIT_MS)
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
    await until((x) => stateOf(x) === 'attention', 'attention', BATCH_WAIT_MS)
    expect(writes().map(short2)).not.toContain('merge 77')
  })

  it('refuses to start landing after the fast tier with no quick check named (an empty ci.quickChecks)', async () => {
    runtime(tieredState(), { ...REAL_QUICK, PROJECT_BOARD_CI_QUICK_CHECKS: '[]' })
    await expect(call('merge_queue')).rejects.toThrow(/ci\.quickChecks must name the quick tier/)
  })

  it('still lands nothing from a red batch on the fast tier', async () => {
    runtime(tieredState({ on: { 'dispatch:queue/batch-1': { runs: { [ONE]: [oneRun('failure')] }, checks: { [ONE]: fullChecks(6000, 'failure', 'skipped') } } } }), FAST_LAND)
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention', BATCH_WAIT_MS)
    expect(writes().map(short2)).not.toContain('merge 77')
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
    for (const n of ['merge_when_green', 'queue_merge', 'rebase_stack', 'ci_status', 'read_failed_job', 'open_pr', 'comment', 'file_issue', 'release']) expect(named.has(n), n).toBe(true)
    // An auto-tier change goes to integrate, by its name (#1259 step 3)
    expect(first.text).toContain('hand it over with integrate')
  })
})

/** Runs the watch command with the fake gh on its PATH; answers its exit code and output. */
function watch(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WATCH, ...args], {
      env: fake.env({ ...FAST, ...NO_TIERS, ...NO_CHECKOUT }),
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
    await rt!.dispose({ awaitTree: true })
    rt = null
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
    await rt!.dispose({ awaitTree: true })
    rt = null
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
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  g(root, 'init', '-q', '--bare', '-b', 'main', origin)
  g(root, 'init', '-q', '-b', 'main', work)
  g(work, 'config', 'user.name', 'Tester')
  g(work, 'config', 'user.email', 'tester@example.test')
  g(work, 'config', 'commit.gpgsign', 'false')
  g(work, 'remote', 'add', 'origin', 'https://github.com/ijun17/centralu.git')
  g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/ijun17/centralu.git')
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

/** The queue file as the queue left it: the items given (a merged one that landed a commit, say) */
function seedQueue(items: Record<string, unknown>[]) {
  const dir = join(root, 'data', 'app-data', 'p1', 'project-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'merge-queue.json'), JSON.stringify({ version: 1, seq: 0, pause: null, items, events: [], batches: [], batchSeq: 0, batchOff: null }))
}

/** The queue landed `commit` (as #90, for another session): the guard watches main once the queue has landed something */
const landed = (commit: string) =>
  seedQueue([{ repo: R, pr: 90, lowers: [], owner: 'other', state: 'merged', commit, title: 'feat(apps): change 90', updatedAt: new Date().toISOString(), reruns: {} }])

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
    await new Promise((r) => setTimeout(r, 500))
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
    // Ticks go on, main still red on that commit: nothing is filed or said again
    await new Promise((r) => setTimeout(r, 1_000))
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
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the culprit', 60_000)
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
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the culprit', 60_000)
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
    await until(() => !!guardOnDisk().hunt?.endedAt, 'giving up', 60_000)
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
    await new Promise((r) => setTimeout(r, 1_000))
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
    await until(() => !!guardOnDisk().hunt?.endedAt, 'the bisect', 60_000)
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
    await call('merge_queue')
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

  it('never reverts a release bump: it says so, and opens nothing', async () => {
    const repo = mainRepo([{ subject: 'chore(release): 1.2.3 (#90)', files: ['packages/protocol/src/brand.ts'] }])
    guardRuntime(repo, redOn(repo, repo.shas[0]!))
    landedBump(repo.shas[0]!)
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reported', 'the report')
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', `revert/${repo.shas[0]!.slice(0, 12)}`], { cwd: repo.origin, env: GIT_ENV }).status).not.toBe(0)
    expect(issues()[0]!.body).toContain('#90 is a release bump, which the queue never reverts')
    expect(queueOnDisk().items.filter((i: any) => i.state !== 'merged')).toEqual([])
  })

  it('says to revert by hand when the revert does not apply to main any more, and opens nothing', async () => {
    const repo = mainRepo([
      { subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] },
      { subject: 'feat(ui): change 82 (#82)', files: ['packages/ui/src/a.ts'] },
    ])
    // Red on #81; #82 landed on it since, changing the same file, its own run still going
    guardRuntime(repo, { ...redOn(repo, repo.shas[0]!), branchRuns: { main: [{ ...mainRun(991, repo.shas[1]!, null), status: 'in_progress' }, mainRun(990, repo.shas[0]!, 'failure'), mainRun(980, repo.green, 'success')] } })
    landedBump(repo.shas[0]!, 81)
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reported', 'the report')
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()[0]!.body).toMatch(/The queue could not revert it: the reverse of [0-9a-f]{7} does not apply to main at/)
    expect(issues()[0]!.body).toContain('Revert it by hand.')
  })
})

/** The queue landed `commit` as #`pr` (the guard watches main once the queue has landed something) */
function landedBump(commit: string, pr = 90) {
  seedQueue([{ repo: R, pr, lowers: [], owner: 'other', state: 'merged', commit, title: `change ${pr}`, updatedAt: new Date().toISOString(), reruns: {} }])
}

/**
 * The log of the e2e (webkit 4/5) job on 2026-10-21 (#1435), as GitHub keeps it: the browser install failed because a package
 * source answered 403, then the artifact upload that runs after a failure complained too, and was the line quoted.
 */
const WEBKIT_INSTALL_LOG = readFileSync(join(REPO_ROOT, 'tooling/fixtures/ci-log-webkit-install-403.txt'), 'utf8')

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

  it('reruns the job once, and opens no revert, issue or notice when the rerun passes', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, redInSetup(repo, sha, { branchRuns: { main: [secondAttempt(sha, 'success'), mainRun(980, repo.green, 'success')] } }))
    await call('merge_queue')
    await until(() => guardOnDisk().green === sha, 'main green again')
    await new Promise((r) => setTimeout(r, 1_000))
    expect(reruns()).toEqual([['rerun-failed', '990']])
    expect(guardOnDisk().rerun).toMatchObject({ run: 990, attempt: 1 })
    expect(writes().filter((w) => w[0] === 'pr-create')).toEqual([])
    expect(issues()).toEqual([])
    expect(mainRedNotices()).toEqual([])
    expect(queueOnDisk().items.filter((i: any) => i.state !== 'merged')).toEqual([])
  })

  it('reports an infrastructure failure that fails the same way again, once, quoting the step that failed first, and reverts nothing', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, redInSetup(repo, sha, { branchRuns: { main: [secondAttempt(sha, 'failure'), mainRun(980, repo.green, 'success')] } }))
    await call('merge_queue')
    await until(() => issues().length > 0 && mainRedNotices().length > 0, 'the report')
    await new Promise((r) => setTimeout(r, 1_000))
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
    expect(issues()[0]!.body).toContain('failed the same way again after one rerun, so no commit is to blame. Nothing was reverted')
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

  it('reverts at once, with no rerun, a failure in a test step, and says it is a test failure', async () => {
    const repo = mainRepo([{ subject: 'feat(ui): change 81 (#81)', files: ['packages/ui/src/a.ts'] }])
    const sha = repo.shas[0]!
    seedQueue([{ repo: R, pr: 81, lowers: [], owner: 'tester', author: 'writer', state: 'merged', commit: sha, title: 'feat(ui): change 81', updatedAt: new Date().toISOString(), reruns: {} }])
    guardRuntime(repo, { branchRuns: { main: [mainRun(990, sha, 'failure'), mainRun(980, repo.green, 'success')] }, jobs: { 990: [failedJob(31, 'verify')] } })
    await call('merge_queue')
    await until(() => guardOnDisk().hunt?.outcome === 'reverting' && mainRedNotices().length > 0, 'the revert')
    expect(reruns()).toEqual([])
    expect(mainRedNotices()[0]!.text).toContain('verify failed at')
    expect(mainRedNotices()[0]!.text).toContain('(test failure)')
  })
})

describe('the main guard with overlapping failures, and when it acts again (#1259 review)', { timeout: 180_000 * SLOW }, () => {
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
    await until(() => guardOnDisk().hunt?.red === c && guardOnDisk().hunt?.endedAt, 'the second culprit', 60_000)
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
    await new Promise((r) => setTimeout(r, 500))
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
function integrateRepo(branches: Record<string, Record<string, string>>) {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  g(root, 'init', '-q', '--bare', '-b', 'main', origin)
  g(root, 'init', '-q', '-b', 'main', work)
  g(work, 'config', 'user.name', 'Tester')
  g(work, 'config', 'user.email', 'tester@example.test')
  g(work, 'config', 'commit.gpgsign', 'false')
  g(work, 'remote', 'add', 'origin', 'https://github.com/ijun17/centralu.git')
  g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/ijun17/centralu.git')
  const write = (f: string, text: string) => {
    mkdirSync(join(work, f, '..'), { recursive: true })
    writeFileSync(join(work, f), text)
  }
  for (const f of ['scripts/tier.mjs', '.centralu/tiers.json']) write(f, readFileSync(join(REPO_ROOT, f), 'utf8'))
  write('docs/guide.md', 'base\n')
  write('README.md', 'base\n')
  g(work, 'add', '-A')
  g(work, 'commit', '-q', '-m', 'base')
  const main = g(work, 'rev-parse', 'HEAD')
  const heads: Record<string, string> = {}
  for (const [name, files] of Object.entries(branches)) {
    g(work, 'checkout', '-q', '-b', name, main)
    for (const [f, text] of Object.entries(files)) write(f, text)
    g(work, 'add', '-A')
    if (Object.keys(files).length) g(work, 'commit', '-q', '-m', `change on ${name}`)
    heads[name] = g(work, 'rev-parse', 'HEAD')
  }
  g(work, 'checkout', '-q', '-b', 'mine', main)
  writeFileSync(join(work, 'README.md'), 'edited, not committed\n')
  g(work, 'push', '-q', 'origin', 'main', ...Object.keys(branches))
  return { work, origin, main, heads }
}

/** A later push to `branch` on GitHub's stand-in (made in a clone of the test's own): `files` added or changed */
function pushTo(repo: ReturnType<typeof integrateRepo>, branch: string, files: Record<string, string>) {
  const tmp = join(root, `push-${Date.now()}`)
  g(root, 'clone', '-q', '-b', branch, repo.origin, tmp)
  g(tmp, 'config', 'user.name', 'Tester')
  g(tmp, 'config', 'user.email', 'tester@example.test')
  g(tmp, 'config', 'commit.gpgsign', 'false')
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(tmp, f, '..'), { recursive: true })
    writeFileSync(join(tmp, f), text)
  }
  g(tmp, 'add', '-A')
  g(tmp, 'commit', '-q', '-m', `more on ${branch}`)
  g(tmp, 'push', '-q', 'origin', branch)
  return g(tmp, 'rev-parse', 'HEAD')
}

const TEMPLATE = readFileSync(join(REPO_ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
/** What a session hands over: the branch and the record's text */
const handOver = (branch: string, extra: Record<string, unknown> = {}) => ({ branch, title: 'docs(guide): say how the guide is read', why: 'The guide did not say it.', notExercised: 'Nothing', owner: 'writer', ...extra })
const integrateQuick = () => [ghCheck('full tier', 'skipped', 10), ghCheck('verify', 'success', 11), ghCheck('windows tests', 'success', 12)]
const integrateBatch = (suite: number) => [suiteCheck('full tier', 'skipped', suite * 10, suite), suiteCheck('verify', 'success', suite * 10 + 1, suite), suiteCheck('windows tests', 'success', suite * 10 + 2, suite)]

/** GitHub as the queue reads it: the record #600's head is the branch's, its own quick run green, a batch's quick run green */
function integrateRuntime(repo: ReturnType<typeof integrateRepo>, branch: string, patch: Gh = {}, tmpDir = appTmp()) {
  const head = repo.heads[branch]!
  const one = `batch-${head}`
  mkdirSync(appTmp(), { recursive: true })
  const tmp = { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir }
  return runtime(
    ghState({
      prs: {},
      prHeads: { [branch]: head },
      files: { '.github/PULL_REQUEST_TEMPLATE.md': TEMPLATE },
      checks: { [head]: integrateQuick() },
      runs: { [head]: [ghRun('success', 1, head, { head_branch: branch })] },
      on: { 'dispatch:queue/batch-1': { runs: { [one]: [ghRun('success', 1, one, { id: 950, head_branch: 'queue/batch-1', event: 'workflow_dispatch', check_suite_id: 6000 })] }, checks: { [one]: integrateBatch(6000) } } },
      ...patch,
    }),
    { ...FAST_LAND, PROJECT_BOARD_QUEUE_CHECKOUT: repo.work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig'), ...tmp },
    gitWrapper(fake.bin),
  )
}
const recordsOpened = () => writes().filter((w) => w[0] === 'pr-create')
const itemsOnDisk = () => (filesNamed(join(root, 'data'), 'merge-queue.json').length ? (queueOnDisk().items as any[]) : [])

describe('the integrator lands an auto-tier branch without a pull request from its session (#1259 step 3)', { timeout: 240_000 * SLOW }, () => {
  it('judges the branch itself, opens the record from the template labelled tier:auto, queues it for the session, and lands it after the quick tier', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n', 'docs/new.md': 'new\n' } })
    integrateRuntime(repo, 'docs/guide')
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.isError, r.text).toBe(false)
    expect(r.data).toMatchObject({ integrated: true, pr: 600, opened: true, tier: 'auto', owner: 'writer' })
    expect(r.text).toContain('Integrated docs/guide: Tier: auto')
    expect(r.text).toContain('Opened #600 as its record')
    // The record: from the template, its Verified the integrator's own Tier line, labelled tier:auto
    expect(recordsOpened()).toEqual([['pr-create', 'docs/guide', 'docs(guide): say how the guide is read']])
    expect(writes().filter((w) => w[0] === 'labels')).toEqual([['labels', '600', ['tier:auto']]])
    const body = gh().prs['600'].body as string
    expect(body).toContain('## Why\n\nThe guide did not say it.')
    expect(body).toMatch(/## Verified\n\nTier: auto, from `docs\/guide\.md` \(docs\), `docs\/new\.md` \(docs\)\. Judged by the integrator \(#1259 step 3\) from the diff of docs\/guide at [0-9a-f]{7} against main at [0-9a-f]{7}/)
    expect(body).toContain('## Not exercised\n\nNothing')
    expect(itemsOnDisk()).toMatchObject([{ pr: 600, owner: 'writer', author: 'writer', auto: { branch: 'docs/guide', head: repo.heads['docs/guide'], main: repo.main } }])
    // A draft, which GitHub, merge_when_green and every version of the queue refuse to merge: only this queue lands it
    expect(gh().prs['600']).toMatchObject({ isDraft: true, mergeStateStatus: 'DRAFT' })
    // Landed by the queue's own path: a batch of the quick tier, the squash, the branch deleted, the session told
    await until((x) => stateOf(x, 600) === 'merged', 'the record to land', BATCH_WAIT_MS)
    expect(gh().dispatched).toEqual([{ ref: 'queue/batch-1', inputs: { tier: 'quick' } }])
    expect(writes().map(short2)).toEqual(expect.arrayContaining(['merge 600', 'delete docs/guide']))
    const merge = writes().find((w) => w[0] === 'merge')!
    expect(merge[2]).toEqual(expect.arrayContaining(['--squash', '--match-head-commit', repo.heads['docs/guide']]))
    // Readied in the same step as the squash, never before
    const order = writes().map(short2)
    expect(order.filter((w) => w === 'ready 600')).toHaveLength(1)
    expect(order.indexOf('ready 600')).toBe(order.indexOf('merge 600') - 1)
    expect(notices().map((e) => e.text)).toEqual([expect.stringContaining('Merge queue: merged #600 (docs(guide): say how the guide is read)')])
    // The checkout it judged in: its branch, head and work as they were, and no ref of the integrator's left
    expect(g(repo.work, 'branch', '--show-current')).toBe('mine')
    expect(g(repo.work, 'status', '--porcelain')).toBe('M README.md')
    expect(g(repo.work, 'for-each-ref', 'refs/centralu-integrate')).toBe('')
  })

  it("refuses a branch that is not auto with the files and rules that put it there, judged by main's judge and rules, not the branch's", async () => {
    const repo = integrateRepo({
      'feat/code': { 'docs/guide.md': 'more\n', 'packages/ui/src/x.ts': 'export const x = 1\n' },
      // A branch that rewrites the judge to call everything auto, and the rules to make auto the fallback
      'docs/sneaky': {
        'scripts/tier.mjs': "console.log(JSON.stringify({ tier: 'auto', line: 'Tier: auto.', because: [], counts: { auto: 1 }, rulesFrom: process.argv[3] }))\n",
        '.centralu/tiers.json': readFileSync(join(REPO_ROOT, '.centralu/tiers.json'), 'utf8').replace('"fallback": "light"', '"fallback": "auto"'),
        'packages/ui/src/y.ts': 'export const y = 1\n',
      },
    })
    integrateRuntime(repo, 'feat/code')
    const light = await call('integrate', handOver('feat/code', { title: 'feat(ui): add x' }))
    expect(light.isError).toBe(true)
    expect(light.data).toMatchObject({ integrated: false, kind: 'tier', tier: 'light' })
    expect(light.text).toContain('Not integrated: feat/code: its tier is light, not auto.')
    expect(light.text).toContain('packages/ui/src/x.ts (no rule names it)')
    expect(light.text).toContain('Open a pull request (open_pr, after the review its tier asks for) and queue it (queue_merge).')
    const sneaky = await call('integrate', handOver('docs/sneaky'))
    expect(sneaky.isError).toBe(true)
    expect(sneaky.data).toMatchObject({ kind: 'tier', tier: 'deep' })
    expect(sneaky.text).toContain('.centralu/tiers.json (tier-rules)')
    expect(sneaky.text).toContain('scripts/tier.mjs (tier-rules)')
    // Nothing opened, labelled or queued
    expect(writes()).toEqual([])
    expect(itemsOnDisk()).toEqual([])
  })

  it("refuses a branch not on GitHub, one with nothing over main, a fork's, a title too long to squash, and an account without merge rights, before any write", async () => {
    const repo = integrateRepo({ 'docs/empty': {} })
    integrateRuntime(repo, 'docs/empty')
    const missing = await call('integrate', handOver('docs/nowhere'))
    expect(missing.data).toMatchObject({ integrated: false, kind: 'missing' })
    expect(missing.text).toContain('the branch docs/nowhere is not on GitHub. Push it first')
    expect((await call('integrate', handOver('docs/empty'))).data).toMatchObject({ kind: 'empty' })
    expect((await call('integrate', handOver('someone:docs/guide'))).data).toMatchObject({ kind: 'fork' })
    expect((await call('integrate', handOver('main'))).data).toMatchObject({ kind: 'input' })
    const long = await call('integrate', handOver('docs/empty', { title: `docs(guide): ${'a'.repeat(60)}` }))
    expect(long.data).toMatchObject({ kind: 'subject' })
    expect((await call('integrate', handOver('docs/empty', { notExercised: '' }))).data).toMatchObject({ kind: 'record' })
    patchGh((s) => (s.permissions = { push: true }))
    const contributor = await call('integrate', handOver('docs/empty'))
    expect(contributor.data).toMatchObject({ kind: 'permission' })
    expect(contributor.text).toContain('mark_ready')
    expect(writes()).toEqual([])
    expect(itemsOnDisk()).toEqual([])
  })

  it('takes the record already open from the branch when it is handed over again, and queues it again, never a second pull request', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    // Its own run still going: nothing lands while the test hands it over twice
    integrateRuntime(repo, 'docs/guide', { checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
    expect((await call('integrate', handOver('docs/guide'))).data).toMatchObject({ integrated: true, pr: 600, opened: true })
    // Marked ready by someone meanwhile (mark_ready, a person): the queue turns it back into a draft before anything else
    patchGh((s) => Object.assign(s.prs['600'], { isDraft: false, mergeStateStatus: 'CLEAN' }))
    await until(() => gh().prs['600'].isDraft === true, 'the record to be a draft again')
    expect(writes().map(short2)).toContain('draft 600')
    const again = await call('integrate', handOver('docs/guide'))
    expect(again.isError, again.text).toBe(false)
    expect(again.data).toMatchObject({ integrated: true, pr: 600, opened: false })
    expect(again.text).toContain('#600, open from it already, is its record')
    expect(again.text).toContain('queued it again')
    expect(recordsOpened()).toHaveLength(1)
    expect(itemsOnDisk().filter((i) => i.state !== 'merged').map((i) => i.pr)).toEqual([600])
  })

  it("judges from a temporary folder reached through a link, as macOS's /var is (/private/var)", async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    mkdirSync(appTmp(), { recursive: true })
    const link = join(root, 'tmp-link')
    symlinkSync(appTmp(), link, process.platform === 'win32' ? 'junction' : 'dir')
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', { checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} }, link)
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.isError, r.text).toBe(false)
    expect(r.data).toMatchObject({ integrated: true, tier: 'auto' })
    // Nothing of the judge's own left in the temporary folder
    expect(readdirSync(appTmp()).filter((f) => f.startsWith('centralu-integrate-'))).toEqual([])
  })

  it('refuses a pull request open from the branch that a label puts above auto, and turns one it takes into a draft', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    const open = ghPr(590, { headRefName: 'docs/guide', headRefOid: head, labels: [{ name: 'documentation' }, { name: 'tier:person' }] })
    integrateRuntime(repo, 'docs/guide', { prs: { '590': open }, checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
    const person = await call('integrate', handOver('docs/guide'))
    expect(person.data).toMatchObject({ integrated: false, kind: 'label', tier: 'person', pr: 590 })
    expect(person.text).toContain('#590, open from docs/guide, is labelled tier:person, and integrate lands only auto.')
    expect(writes()).toEqual([])
    // Without a tier label above auto it is the record, and a draft from then on
    patchGh((s) => (s.prs['590'].labels = [{ name: 'documentation' }]))
    const taken = await call('integrate', handOver('docs/guide'))
    expect(taken.data).toMatchObject({ integrated: true, pr: 590, opened: false })
    expect(writes().map(short2)).toEqual(['draft 590'])
    expect(gh().prs['590'].isDraft).toBe(true)
  })

  it('says to try again when GitHub cannot be reached to judge it, rather than calling it deep', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    integrateRuntime(repo, 'docs/guide')
    renameSync(repo.origin, `${repo.origin}.away`)
    const r = await call('integrate', handOver('docs/guide'))
    renameSync(`${repo.origin}.away`, repo.origin)
    expect(r.data).toMatchObject({ integrated: false, kind: 'retry' })
    expect(r.text).toContain('Nothing was written; integrate again in a moment.')
    expect(writes()).toEqual([])
  })

  it("refuses an answer of main's judge whose rules did not come from main", async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    pushTo(repo, 'main', { 'scripts/tier.mjs': "console.log(JSON.stringify({ tier: 'auto', line: 'Tier: auto.', because: [], counts: { auto: 1 }, rulesFrom: 'elsewhere' }))\n" })
    integrateRuntime(repo, 'docs/guide')
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.data).toMatchObject({ integrated: false, kind: 'tier', tier: 'deep' })
    expect(r.text).toContain('the rules were not read from main')
  })

  it.each([
    { name: 'GitHub refuses the squash', patch: { mergeError: 'GraphQL: Pull Request is not mergeable (HTTP 405)' }, merge: false, reason: 'refused' },
    { name: 'a rate limit stops it mid-way', patch: { mergeError: 'API rate limit exceeded for user ID 1. (HTTP 403)' }, merge: false, reason: null },
    { name: 'GitHub holds the squash (its own merge queue)', patch: { mergeNoop: true }, merge: true, reason: 'not-merged' },
  ])('turns the record back into a draft when $name after readying it', async ({ patch, merge, reason }) => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    integrateRuntime(repo, 'docs/guide', patch)
    await call('integrate', handOver('docs/guide'))
    await until(() => writes().some((w) => w[0] === 'draft' && w[1] === '600'), 'the record to be a draft again', BATCH_WAIT_MS)
    const order = writes().map(short2).filter((w) => /^(ready|merge|draft) 600$/.test(w))
    expect(order).toEqual(merge ? ['ready 600', 'merge 600', 'draft 600'] : ['ready 600', 'draft 600'])
    expect(gh().prs['600']).toMatchObject({ state: 'OPEN', isDraft: true })
    if (reason) {
      const q = await until((x) => stateOf(x, 600) === 'attention', 'attention')
      const item = q.queue.find((i: any) => i.pr === 600)
      expect(item.reason.kind).toBe(reason)
      if (reason === 'not-merged') expect(item.reason.text).toContain('it was turned back into a draft, which also stops what GitHub held')
    }
  })

  it('refuses where the queue does not batch with two tiers of CI: a draft record would have no gate', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    mkdirSync(appTmp(), { recursive: true })
    runtime(ghState({ prs: {}, files: { '.github/PULL_REQUEST_TEMPLATE.md': TEMPLATE } }), { ...NO_TIERS, PROJECT_BOARD_QUEUE_CHECKOUT: repo.work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig') }, gitWrapper(fake.bin))
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.data).toMatchObject({ integrated: false, kind: 'setup' })
    expect(r.text).toContain('does not batch with two tiers of CI')
    expect(writes()).toEqual([])
  })

  it("never takes a fork's open pull request whose branch has the same name as the record", async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', { prs: { '590': ghPr(590, { headRefName: 'docs/guide', isCrossRepository: true, headRefOid: SHA2 }) }, checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
    const r = await call('integrate', handOver('docs/guide'))
    expect(r.data).toMatchObject({ integrated: true, pr: 600, opened: true })
    expect(itemsOnDisk().map((i) => i.pr)).toEqual([600])
  })
})

describe('the queue judges an integrated change again on each new head and before it lands (#1259 step 3)', { timeout: 240_000 * SLOW }, () => {
  /** Its own run still going: nothing lands until the test says CI passed */
  const pending = (head: string) => ({ checks: { [head]: [ghCheck('verify', null, 11)] }, runs: { [head]: [ghRun(null, 1, head, { head_branch: 'docs/guide' })] }, on: {} })
  /**
   * CI passed on `head` (its own quick run), and a batch of it passes the quick tier: whenever its batch was started,
   * before this or after (it may have been batched while its own run was still going)
   */
  const passes = (s: Gh, head: string) => {
    const one = `batch-${head}`
    s.checks[head] = integrateQuick()
    s.runs[head] = [ghRun('success', 1, head, { head_branch: 'docs/guide' })]
    // The batch is queue/batch-1, or a later one when an earlier batch was dropped (its head moved): runs are read on its branch
    s.runs[one] = [1, 2, 3].map((n) => ghRun('success', 1, one, { id: 950 + n, head_branch: `queue/batch-${n}`, event: 'workflow_dispatch', check_suite_id: 6000 }))
    s.checks[one] = integrateBatch(6000)
  }
  const tierNotices = () => notices().filter((e) => e.kind === 'attention' && e.text.includes('needs attention: tier'))

  it('stops a head pushed after the hand-over that is no longer auto: attention for the session with the files, never batched or landed', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    expect((await call('integrate', handOver('docs/guide'))).data).toMatchObject({ integrated: true, pr: 600 })
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // The session pushes code to the same branch, and CI passes on it
    const code = pushTo(repo, 'docs/guide', { 'packages/ui/src/x.ts': 'export const x = 1\n' })
    patchGh((s) => {
      s.prs['600'].headRefOid = code
      passes(s, code)
    })
    await until((x) => stateOf(x, 600) === 'attention', 'attention', BATCH_WAIT_MS)
    const item = (await call('merge_queue')).data.queue.find((i: any) => i.pr === 600)
    expect(item.reason.kind).toBe('tier')
    expect(item.reason.text).toContain(`#600 was handed over with integrate as an auto-tier change, but at ${code.slice(0, 7)} its tier is now light, from packages/ui/src/x.ts (no rule names it).`)
    expect(item.reason.text).toContain('queue it with queue_merge')
    // Once, to the session that handed it over; the new head in no batch (the first one may have been), nothing landed
    await morePolls(3)
    expect(tierNotices()).toHaveLength(1)
    expect(writes().filter((w) => w[0] === 'merge-into' && w[1] === code)).toEqual([])
    expect(writes().map(short2)).not.toContain('merge 600')
    expect(itemsOnDisk()[0].tierAt).toMatchObject({ head: code, tier: 'light', main: repo.main })
  })

  it('judges it once more right before the squash, against main as it is then: rules main changed since make it deep, and it does not land', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // Main moves on after that judgment: its rules now call docs deep
    const rules = JSON.parse(readFileSync(join(REPO_ROOT, '.centralu/tiers.json'), 'utf8'))
    rules.rules.find((r: any) => r.id === 'docs').tier = 'deep'
    pushTo(repo, 'main', { '.centralu/tiers.json': `${JSON.stringify(rules, null, 2)}\n` })
    patchGh((s) => passes(s, head))
    await until((x) => stateOf(x, 600) === 'attention', 'attention', BATCH_WAIT_MS)
    // It was batched on the poll's judgment of its head, and stopped at the squash
    expect(gh().dispatched).toEqual([{ ref: 'queue/batch-1', inputs: { tier: 'quick' } }])
    expect(writes().map(short2)).not.toContain('merge 600')
    // No "Passed CI in the batch" status on a head that does not land
    expect(writes().filter((w) => w[0] === 'status')).toEqual([])
    expect(tierNotices().map((e) => e.text)).toEqual([expect.stringContaining(`but at ${head.slice(0, 7)} its tier is now deep, from docs/guide.md (docs)`)])
    // The judgment stays on the item for that head: polls do not try to land it again
    expect(itemsOnDisk()[0].tierAt).toMatchObject({ head, tier: 'deep' })
    await morePolls(2)
    expect(writes().filter((w) => w[0] === 'merge')).toEqual([])
  })

  it('retries a head it could not judge (GitHub out of reach) as a failed poll, tells nobody on a blip, and lands it once judged', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // A new auto head, read while GitHub's copy cannot be fetched
    const more = pushTo(repo, 'docs/guide', { 'docs/more.md': 'more\n' })
    renameSync(repo.origin, `${repo.origin}.away`)
    patchGh((s) => (s.prs['600'].headRefOid = more))
    await until(() => /the integrator could not judge #600/.test(itemsOnDisk()[0]?.lastError ?? ''), 'a poll that could not judge it')
    expect(stateOf((await call('merge_queue')).data, 600)).not.toBe('attention')
    expect(tierNotices()).toEqual([])
    // Back in reach, and CI passed: judged auto, and it lands
    renameSync(`${repo.origin}.away`, repo.origin)
    patchGh((s) => passes(s, more))
    await until((x) => stateOf(x, 600) === 'merged', 'the record to land', BATCH_WAIT_MS)
    expect(itemsOnDisk()[0].tierAt).toMatchObject({ head: more, tier: 'auto' })
    expect(notices().filter((e) => e.kind === 'attention')).toEqual([])
  })

  it('stops it when a person labels it above auto after the hand-over, whatever the judge said, and lands nothing', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    await until(() => itemsOnDisk()[0]?.head === head, 'the first poll of its head')
    // The owner raises it by hand, and CI passes
    patchGh((s) => {
      s.prs['600'].labels = [{ name: 'tier:auto' }, { name: 'tier:deep' }]
      passes(s, head)
    })
    await until((x) => stateOf(x, 600) === 'attention', 'attention', BATCH_WAIT_MS)
    const item = (await call('merge_queue')).data.queue.find((i: any) => i.pr === 600)
    expect(item.reason.kind).toBe('tier')
    expect(item.reason.text).toContain('#600 was handed over with integrate, but it is labelled tier:deep')
    await morePolls(2)
    expect(writes().map(short2)).not.toContain('merge 600')
    expect(writes().map(short2)).not.toContain('ready 600')
    expect(gh().prs['600'].isDraft).toBe(true)
  })

  it('lands a record as a pull request of its own tier only after it is taken out, marked ready and queued with queue_merge', async () => {
    const repo = integrateRepo({ 'docs/guide': { 'docs/guide.md': 'read it top down\n' } })
    const head = repo.heads['docs/guide']!
    integrateRuntime(repo, 'docs/guide', pending(head))
    await call('integrate', handOver('docs/guide'))
    expect(itemsOnDisk()[0].auto).toBeTruthy()
    // Still the integrator's: a draft, which queue_merge refuses like any draft
    const refused = await call('queue_merge', { pr: 600, owner: 'writer' })
    expect(refused.text).toContain('#600 is a draft')
    await call('unqueue', { pr: 600 })
    // Marked ready by the session (the fake's state is written whole by both sides: set it until it holds)
    let queued = { isError: true, text: '' }
    for (let i = 0; i < 20 && queued.isError; i++) {
      patchGh((st) => Object.assign(st.prs['600'], { isDraft: false, mergeStateStatus: 'CLEAN' }))
      queued = await call('queue_merge', { pr: 600, owner: 'writer' })
    }
    expect(queued.text).toContain('Queued #600')
    const item = itemsOnDisk().find((i) => i.state !== 'removed' && i.pr === 600)
    expect(item.auto).toBeUndefined()
    expect(item.tierAt).toBeUndefined()
    // Not the integrator's any more: never turned back into a draft
    await morePolls(2)
    expect(writes().map(short2)).not.toContain('draft 600')
  })
})

// --- Messages kept until their owner acknowledges them (#1351) --------------------------------------------------------

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
    await new Promise((r) => setTimeout(r, 1_000))
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
    rt = null
    const quiet = await watch(['watch', '--data', dir, '--owner', 'tester', '--minutes', '0.02'])
    expect(quiet.code).toBe(6)
    expect(quiet.out).not.toContain('needs attention')
  })
})
