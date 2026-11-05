import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { fakeBrokerHost } from '../packages/agent-host/src/apps/external/test-helpers.js'
import { SLOW } from './test-timing.js'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { decideBefore, decideCi, emptyQueue, enqueue, supersededSuites, twinPassedSuites, screenLanded, shardsComplete, unexpandedSkip, handoffReason, authorRoute, resetFor, lowerFailureCounts, noticeKey, dequeue, normalize, onlySupersededFailures, queueOrder, watchState, longSubject } from '../.centralu/apps/project-board/queue.mjs'
// @ts-expect-error -- a plain .mjs module of the board app, without types
import { commandEnv, conflictPlan, sweep } from '../.centralu/apps/project-board/queue-conflict.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { evaluateChecks } from '../.centralu/apps/project-board/ci.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { writeJsonAtomic } from '../.centralu/apps/project-board/util.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { latestRuns, LEASE_MS, queueBusy, takeLease, releaseLease } from '../.centralu/apps/project-board/queue-driver.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { classifyRun, looksLikeNetworkError, onFlakyList } from '../.centralu/apps/project-board/run-failure.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { GitError, isNetworkFailure } from '../.centralu/apps/project-board/git.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { GitHubError, isOutage } from '../.centralu/apps/project-board/github.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { batchCandidates, batchLine, decideLanding, dispatchInputs, endBatch, formBatch, gateGreen, gathering, heavyRan, markBatchless, MOVED_CAP, needsFull, onlyCancelledByBatch, rebatchAfterMove, splitBatch, tierToRun } from '../.centralu/apps/project-board/batch.mjs'
import { removeTree } from '../packages/agent-host/src/temp-dir.test-helpers.js'
import { REPO_ROOT, R, SHA, SHA2, A, B, C, type Row, check, NOW, PROJECT, LISTS, MECHANICAL_FILES, deadPid, ghCheck, green, ghRun, ghPr, type Gh, ghState, appRef, root, rt, IDLE_SERVER, runtime, call, patchGh, writes, ghCalls, filesNamed, queueOnDisk, notices, pollUntil, until, polls, stateOf, morePolls, itemsOnDisk, forgetApp } from './project-board-queue.test-helpers.js'


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

const ref = (_repo: string, n: number) => `#${n}`

// --- The decisions ---------------------------------------------------------------------------------

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

  // #1527: a batch cancelled the run (at that attempt) when it was built; that is the queue's doing, not the pull request's failure
  it('reruns a run the queue cancelled for a batch every time, without using up the rerun of the head', () => {
    const cancelled = checksOf([check('verify', 'cancelled'), check('windows tests', 'success')])
    const decide = (item: Record<string, unknown>, attempt: number, now = NOW) => decideCi({ item, pr: openPr(), checks: cancelled, runs: [run('cancelled', attempt)], defaultBranch: 'main', now, ref })
    // Its own cancel at attempt 1 was rerun once; a batch then cancelled attempt 2
    const spent = { cancelled: { run: 900, attempt: 1, at: new Date(NOW).toISOString() } }
    const ours = decide(fresh({ reruns: spent, queueCancelled: [{ run: 900, attempt: 2 }] }), 2)
    expect(ours).toMatchObject({ state: 'ci', action: { type: 'rerun', runId: 900, failedOnly: false, kind: 'queue' } })
    expect(ours.event).toContain('cancelled by the merge queue for a batch')
    expect(ours.patch.reruns.cancelled).toEqual(spent.cancelled)
    // Cancelled by a batch again at attempt 3: rerun again
    const twice = decide(fresh({ reruns: ours.patch.reruns, queueCancelled: [{ run: 900, attempt: 2 }, { run: 900, attempt: 3 }] }), 3, NOW + 600_000)
    expect(twice).toMatchObject({ action: { type: 'rerun', kind: 'queue' } })
    // A cancel the queue did not make (another attempt, another head) is counted as before
    expect(decide(fresh({ reruns: spent, queueCancelled: [{ run: 900, attempt: 1 }] }), 2, NOW + 600_000)).toMatchObject({ state: 'attention', reason: { kind: 'cancelled' } })
    expect(decide(fresh({ head: 'old', reruns: {}, queueCancelled: [{ run: 900, attempt: 2 }] }), 2)).toMatchObject({ action: { kind: 'cancelled' } })
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

  // 2026-11-05: GitHub began to write a limit as "20m0s", not "20 minutes". Runs 42041432265 and 42053421100 lost jobs to their limit
  // (a windows test step, an apt install) and were reported "cancelled, with no failed job": the note was not read
  it("reads GitHub's limit notes in both wordings, and says which step the limit ended: setup is the runner's, a test step is named", () => {
    const job = (name: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({ id: name.length, name, conclusion, steps: [], notes: [], ...extra })
    const cancelledRun = { id: 1, attempt: 1, conclusion: 'cancelled' }
    const failedRun = { id: 1, attempt: 1, conclusion: 'failure' }
    const ended = (name: string) => ({ steps: [{ name: 'Set up job', conclusion: 'success' }, { name, conclusion: 'cancelled' }] })
    for (const note of ['The job has exceeded the maximum execution time of 20m0s', 'The job has exceeded the maximum execution time of 1h0m0s', 'The job has exceeded the maximum execution time of 20 minutes', 'The job has exceeded the maximum execution time of 1 minute']) {
      expect(classifyRun(cancelledRun, [job('keeper e2e (linux)', 'cancelled', { ...ended('Install Linux system dependencies'), notes: [note, 'The operation was canceled.'] })]), note).toMatchObject({ real: false, cause: 'timeout', inSetup: true, step: 'Install Linux system dependencies' })
    }
    // A step's own limit, in the new wording too
    expect(classifyRun(failedRun, [job('keeper e2e (linux)', 'failure', { steps: [{ name: 'Install Linux system dependencies', conclusion: 'failure' }], notes: ["The action 'Install Linux system dependencies' has timed out after 8m0s."] })])).toMatchObject({ real: false, cause: 'timeout', inSetup: true })
    // A test step: still not the commit's fault by itself (a rerun), but named, and not "cancelled with no failed job"
    const hit = classifyRun(cancelledRun, [job('host tests, remote Node (windows-2022)', 'cancelled', { ...ended('pnpm test (host, protocol, launcher)'), notes: ['The job has exceeded the maximum execution time of 20m0s', 'The operation was canceled.'] })])
    expect(hit).toMatchObject({ real: false, cause: 'timeout', inSetup: false, step: 'pnpm test (host, protocol, launcher)' })
    // A run a newer push cancelled says only that
    expect(classifyRun(cancelledRun, [job('host tests, remote Node (windows-2022)', 'cancelled', { ...ended('pnpm test (host, protocol, launcher)'), notes: ['The operation was canceled.'] })])).toMatchObject({ real: false, cause: 'cancelled', step: null })
    // The queue: rerun once, the event names the step; the second time it is a timeout in that step, not "cancelled again"
    const checks = checksOf([check('verify', 'success'), check('windows tests', 'cancelled', { jobId: '12' })])
    const first = decideCi({ item: fresh(), pr: openPr(), checks, runs: [run('cancelled')], failures: { 900: hit }, defaultBranch: 'main', now: NOW, ref })
    expect(first).toMatchObject({ action: { type: 'rerun', failedOnly: false } })
    expect(first.event).toContain('in step "pnpm test (host, protocol, launcher)"')
    const again = decideCi({ item: fresh({ reruns: first.patch.reruns }), pr: openPr(), checks, runs: [run('cancelled', 2)], failures: { 900: { ...hit, attempt: 2 } }, defaultBranch: 'main', now: NOW + 600_000, ref })
    expect(again).toMatchObject({ state: 'attention', reason: { kind: 'timeout', job: { name: 'host tests, remote Node (windows-2022)' } } })
    expect(again.reason.text).toContain('hit its time limit again')
    expect(again.reason.text).toContain('in step "pnpm test (host, protocol, launcher)"')
    expect(again.reason.text).not.toContain('cancelled')
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
    expect(classifyRun(failedRun, [job('e2e (webkit 2/5)', 'failure', { steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'pnpm e2e', conclusion: 'failure' }], notes: ["The action 'pnpm e2e' has timed out after 25 minutes."] })])).toMatchObject({ real: false, cause: 'timeout' })
    // The annotation of an earlier step with continue-on-error (the first try of the browser install, which GitHub marks a success)
    // is left on a job that goes on: when the tests then fail for real, that is the tests', not a timeout (#1503, review of #1505)
    const firstTry = ["The action 'Install WebKit system libraries' has timed out after 3 minutes."]
    const testsFailed = { steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Install WebKit system libraries', conclusion: 'success' }, { name: 'Install WebKit system libraries, second try', conclusion: 'skipped' }, { name: 'pnpm e2e (shard 1/5)', conclusion: 'failure' }] }
    expect(classifyRun(failedRun, [job('e2e (webkit 1/5)', 'failure', { ...testsFailed, notes: firstTry })])).toMatchObject({ real: true, cause: 'test', step: 'pnpm e2e (shard 1/5)' })
    expect(classifyRun(cancelledRun, [job('e2e (webkit 1/5)', 'failure', { ...testsFailed, notes: firstTry })])).toMatchObject({ real: true })
    // ...while the same annotation on the step that did end the job still reads as a timeout in setup
    const secondTry = { steps: [{ name: 'Install WebKit system libraries', conclusion: 'success' }, { name: 'Install WebKit system libraries, second try', conclusion: 'failure' }] }
    expect(classifyRun(failedRun, [job('e2e (webkit 1/5)', 'failure', { ...secondTry, notes: [...firstTry, "The action 'Install WebKit system libraries, second try' has timed out after 3 minutes."] })])).toMatchObject({ real: false, cause: 'timeout', inSetup: true, step: 'Install WebKit system libraries, second try' })
    // The job's own limit is the job's whoever the earlier steps were
    expect(classifyRun(cancelledRun, [job('e2e (webkit 1/5)', 'cancelled', { ...testsFailed, steps: testsFailed.steps.map((x) => (x.name.startsWith('pnpm') ? { ...x, conclusion: 'cancelled' } : x)), notes: [...firstTry, 'The job has exceeded the maximum execution time of 25 minutes.'] })])).toMatchObject({ real: false, cause: 'timeout', inSetup: false })
    // A step that only keeps the results (an upload named for it, a post step) failing alone is the service's, not a test's: 2026-11-03, `Upload the test times` after every test passed
    const stored = (name: string) => ({ steps: [{ name: 'pnpm test', conclusion: 'success' }, { name, conclusion: 'failure' }] })
    for (const name of ['Upload the test times', 'Post Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'])
      expect(classifyRun(failedRun, [job('macos tests', 'failure', stored(name))])).toMatchObject({ real: false, cause: 'storage', step: name })
    // An upload that is a check on the commit (`if-no-files-found: error`, to fail a build that bundled nothing) is not named so, and stays the commit's
    expect(classifyRun(failedRun, [job('windows-x64', 'failure', stored('Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9'))])).toMatchObject({ real: true, cause: 'test' })
    expect(classifyRun(failedRun, [job('macos tests', 'failure', { steps: [{ name: 'pnpm test', conclusion: 'failure' }, { name: 'Upload the test times', conclusion: 'failure' }] })])).toMatchObject({ real: true, cause: 'test', step: 'pnpm test' })
    // A test's own timeout is a test failure
    expect(classifyRun(failedRun, [job('verify', 'failure', { ...failedStep, notes: ['Error: Test timed out in 5000ms.'] })])).toMatchObject({ real: true })
    // #1503: the step the limit ended says where. e2e (webkit 1/5) of 2026-10-23: the job's limit hit inside `Install WebKit`
    // (the step is 'cancelled', the tests 'skipped'); a step's own limit marks that step 'failure'. Both are setup; the tests' step is not
    const inStep = (name: string, conclusion: string) => ({ steps: [{ name: 'Set up job', conclusion: 'success' }, { name, conclusion }, { name: 'pnpm e2e (shard 1/5)', conclusion: name.startsWith('pnpm') ? conclusion : 'skipped' }] })
    expect(classifyRun(cancelledRun, [job('e2e (webkit 1/5)', 'cancelled', { ...inStep('Install WebKit', 'cancelled'), notes: timeoutNote })])).toMatchObject({ real: false, cause: 'timeout', inSetup: true, step: 'Install WebKit' })
    expect(classifyRun(failedRun, [job('e2e (webkit 1/5)', 'failure', { ...inStep("Install WebKit system libraries, second try", 'failure'), notes: ["The action 'Install WebKit system libraries, second try' has timed out after 3 minutes."] })])).toMatchObject({ real: false, cause: 'timeout', inSetup: true, step: "Install WebKit system libraries, second try" })
    expect(classifyRun(cancelledRun, [job('e2e (webkit 1/5)', 'cancelled', { ...inStep('pnpm e2e (shard 1/5)', 'cancelled'), notes: timeoutNote })])).toMatchObject({ real: false, cause: 'timeout', inSetup: false })
    expect(classifyRun(cancelledRun, [job('e2e (webkit 1/5)', 'timed_out')])).toMatchObject({ real: false, cause: 'timeout', inSetup: false })
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
  it('tells a network or package-source failure from a commit\'s by the text of the step, a status only as a status', () => {
    for (const text of [
      'E: Failed to fetch https://packages.microsoft.com/ubuntu/24.04/prod/dists/noble/InRelease  403  Forbidden [IP: 13.107.246.40 443]',
      "E: The repository 'https://packages.microsoft.com/ubuntu/24.04/prod noble InRelease' is no longer signed.",
      'W: Could not connect to archive.ubuntu.com:80 (91.189.91.82), connection timed out',
      'E: Unable to connect to archive.ubuntu.com:http:',
      'E: Failed to fetch http://archive.ubuntu.com/x.deb  Hash Sum mismatch',
      'E: The repository is not signed.',
      "fatal: unable to access 'https://github.com/x/y/': The requested URL returned error: 502",
      'Error: Download failure, code=1',
      'Warning: Cache service responded with 503',
      'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/x: Response Error: HTTP 503',
      'Request failed with status 429',
      'info: could not download file from https://static.rust-lang.org/x',
      'getaddrinfo EAI_AGAIN registry.npmjs.org',
    ])
      expect(looksLikeNetworkError(text), text).toBe(true)
    for (const text of [
      'E: Failed to fetch http://archive.ubuntu.com/pool/w/libwebkit.deb  404  Not Found [IP: 91.189.91.82 80]',
      'E: Unable to locate package libwebkit-nope',
      'Error: Playwright version 1.99.0 not found',
      // A number in a version or a file name is not a status
      'Installing playwright 2.403.1',
      'Unpacking foo_1.429-1_amd64.deb',
      'Error: Installation process exited with code: 100',
      // Every line of a step whose apt answered 404 for a package it asked for, as the guard reads it: none is the network
      [
        'Err:7 http://archive.ubuntu.com/ubuntu noble/universe amd64 libwebkit2gtk-9.9-0 amd64 9.9.1',
        '  404  Not Found [IP: 91.189.91.82 80]',
        'E: Failed to fetch http://archive.ubuntu.com/ubuntu/pool/universe/w/webkit2gtk/libwebkit2gtk-9.9-0_9.9.1_amd64.deb  404  Not Found [IP: 91.189.91.82 80]',
        'Failed to install browsers',
        '##[error]Process completed with exit code 1.',
      ].join('\n'),
      '',
    ])
      expect(looksLikeNetworkError(text), text).toBe(false)
  })

  // The restack pauses the queue and tries again for these; a failure that says the same next time goes to the author
  it('tells git being unable to reach the remote from git being refused by it: only the first is tried again', () => {
    const git = (stderr: string) => new GitError(`git failed: ${stderr}`, stderr, 128)
    for (const stderr of [
      "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
      "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443 after 21034 ms: Couldn't connect to server",
      "fatal: unable to access 'https://github.com/x/y.git/': Connection timed out after 300001 milliseconds",
      "fatal: unable to access 'https://github.com/x/y.git/': Recv failure: Connection reset by peer",
      "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 502",
      "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 429",
      'error: RPC failed; curl 56 Recv failure: Connection was reset\nfatal: the remote end hung up unexpectedly',
      'ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.',
      'fatal: early EOF',
    ])
      expect(isNetworkFailure(git(stderr)), stderr).toBe(true)
    for (const stderr of [
      "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403",
      "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 404",
      "fatal: unable to access 'https://github.com/x/y.git/': SSL certificate problem: unable to get local issuer certificate",
      "fatal: unable to access 'https://github.com/x/y.git/': SSL: no alternative certificate subject name matches target host name 'github.com'",
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights',
      "fatal: Authentication failed for 'https://github.com/x/y.git/'",
      'error: failed to push some refs to x\nhint: Updates were rejected because the tip of your current branch is behind',
      'error: cannot lock ref: is at abc but expected def',
    ])
      expect(isNetworkFailure(git(stderr)), stderr).toBe(false)
    // Not a git failure at all
    expect(isNetworkFailure(new Error('Could not resolve host'))).toBe(false)
  })

  it("calls a job that failed in a step that sets it up an infrastructure failure, and one that failed in a test step a real one", () => {
    const failedRun = { id: 1, attempt: 1, conclusion: 'failure' }
    const steps = (failing: string, ...others: [string, string][]) => [
      { name: 'Set up job', conclusion: 'success' },
      ...others.map(([name, conclusion]) => ({ name, conclusion })),
      { name: failing, conclusion: 'failure' },
      { name: 'Run actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', conclusion: 'failure' },
    ]
    const job = (name: string, failing: string, notes: string[] = []) => ({ id: 31, name, conclusion: 'failure', steps: steps(failing), notes })
    for (const setup of ['Install WebKit', 'Install Chromium', 'Install Linux system dependencies', 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'Run pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413', 'Run ./.github/actions/setup', 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'Run swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6', 'Set up job']) {
      expect(classifyRun(failedRun, [job('e2e (webkit 4/5)', setup)]), setup).toMatchObject({ real: false, cause: 'setup', step: setup, job: { name: 'e2e (webkit 4/5)' } })
    }
    // The first step that failed counts, not a later one (the upload that runs after a failure)
    expect(classifyRun(failedRun, [job('e2e (webkit 4/5)', 'pnpm e2e (shard 4/5)')])).toMatchObject({ real: true, cause: 'test', step: 'pnpm e2e (shard 4/5)' })
    expect(classifyRun(failedRun, [job('verify', 'Run pnpm verify')])).toMatchObject({ real: true, cause: 'test' })
    // An install is the runner's only when its log names the network or a package source
    expect(classifyRun(failedRun, [job('verify', 'Run pnpm install --frozen-lockfile')])).toMatchObject({ real: true, cause: 'test' })
    const install = (log: string) => ({ ...job('verify', 'Run pnpm install --frozen-lockfile'), log })
    expect(classifyRun(failedRun, [install(' First failure: ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/x: 503')])).toMatchObject({ real: false, cause: 'setup' })
    expect(classifyRun(failedRun, [install(' First failure: ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/x: Not Found - 404')])).toMatchObject({ real: true, cause: 'test' })
    // tauri's bundle step is the runner's only when its line says the download failed (#2004), not for a 404 or its own tools failing
    const bundle = (log: string, notes: string[] = []) => ({ ...job('linux-arm64', 'Build bundle', notes), log })
    for (const error of ['http status: 504', 'timeout: global', 'io: Connection reset by peer (os error 104)', 'io: failed to lookup address information: Temporary failure in name resolution'])
      expect(classifyRun(failedRun, [bundle(` First failure: failed to bundle project: \`${error}\``)]), error).toMatchObject({ real: false, cause: 'setup', step: 'Build bundle' })
    for (const log of [' First failure: failed to bundle project: `http status: 404`', ' First failure: failed to bundle project: `failed to run linuxdeploy`', '']) expect(classifyRun(failedRun, [bundle(log)]), log).toMatchObject({ real: true, cause: 'test' })
    // A warning beside the failure says nothing: a cache that could not restore, a request that timed out and was retried
    expect(classifyRun(failedRun, [bundle(' First failure: error: could not compile `centralu`', ['Failed to restore: connect ETIMEDOUT 10.0.0.1:443'])])).toMatchObject({ real: true, cause: 'test' })
    expect(classifyRun(failedRun, [bundle(' First failure: failed to bundle project: `failed to run linuxdeploy`', ['The request timed out and was retried'])])).toMatchObject({ real: true, cause: 'test' })
    // The log's line is no GitHub word for a timeout or a lost runner: a test that says so is still a test failure
    expect(classifyRun(failedRun, [install(' First failure: Error: has exceeded the maximum execution time of 20 minutes')])).toMatchObject({ real: true })
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
    expect(normalize({ items: [{ repo: R, pr: 1, state: 'ci' }] }).items[0]).toMatchObject({ lowers: [], reruns: {}, queueCancelled: [] })
    // A hand-edited list of the runs the queue cancelled (#1527) reads as one, and a poll on it does not throw
    const edited = normalize({ items: [{ repo: R, pr: 77, state: 'ci', head: SHA, queueCancelled: 'run 900' }, { repo: R, pr: 78, state: 'ci', queueCancelled: [null, { run: 900, attempt: 2 }] }] }).items
    expect(edited.map((i: { queueCancelled: unknown }) => i.queueCancelled)).toEqual([[], [{ run: 900, attempt: 2 }]])
    const cancelled = checksOf([check('verify', 'cancelled'), check('windows tests', 'success')])
    expect(decideCi({ item: edited[0], pr: openPr(), checks: cancelled, runs: [run('cancelled')], defaultBranch: 'main', now: NOW, ref })).toMatchObject({ action: { type: 'rerun', kind: 'cancelled' } })
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

  it('writes a JSON file whole, and leaves no temporary file behind when it cannot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-atomic-'))
    try {
      writeJsonAtomic(join(dir, 'a.json'), { a: 1 }, 2)
      expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('{\n  "a": 1\n}\n')
      writeJsonAtomic(join(dir, 'b.json'), { b: 1 })
      expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('{"b":1}\n')
      // The rename onto a folder fails
      mkdirSync(join(dir, 'c.json'))
      expect(() => writeJsonAtomic(join(dir, 'c.json'), { c: 1 })).toThrow()
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sweeps a left-over worktree folder whose name carries no process id', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-sweep-'))
    try {
      mkdirSync(join(base, 'centralu-queue-merge-notapid-1'))
      mkdirSync(join(base, 'unrelated'))
      await sweep(base, base)
      expect(readdirSync(base)).toEqual(['unrelated'])
    } finally {
      await removeTree(base)
    }
  })

  it('lets one driver hold the queue at a time, until it lets go or goes quiet', async () => {
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
      // A lease that names no process cannot be told gone: it holds until it goes quiet
      for (const pid of [undefined, 0]) {
        writeFileSync(join(dir, 'merge-queue.lease.json'), JSON.stringify({ holder: 'server:old', pid, until: new Date(NOW + 60 * 60_000).toISOString() }))
        expect(takeLease(dir, 'watch:4', NOW)).toBe(false)
      }
    } finally {
      await removeTree(dir)
    }
  })
})

// --- Batches (#962): the decisions ----------------------------------------------------------------------

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

  // #1593: #1586's title made a 73-character subject; its quick tier passed, the queue batched it, the batch ran the whole
  // full tier and then refused it at landing. The subject is judged before a batch can take it
  describe('a squash subject over 72 characters (#1593)', () => {
    // `feat(apps): ` is 12 characters and ` (#77)` 6: a 54-character rest makes 72, a 55-character one 73
    const titled = (rest: number) => openPr({ title: `feat(apps): ${'x'.repeat(rest)}` })
    const subjectOf = (rest: number) => `feat(apps): ${'x'.repeat(rest)} (#77)`

    it('keeps a quick-tier-green pull request out of a batch with attention subject, and lets it go on by itself once the title fits', () => {
      const long = ci({ pr: titled(55) })
      expect(long).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
      expect(long.quick).toBeUndefined()
      expect(long.reason.text).toContain(subjectOf(55))
      expect(long.reason.text).toContain('is 73 characters, over 72. Shorten the PR title; the queue carries on by itself (the board app keeps polling it for 6 hours')
      // Not a batch candidate while it holds: a batch takes items in `ci` only
      const q = queueOf({ ...fresh({ state: long.state, ci: { head: SHA, verdict: 'quick', runs: [], batchable: true } }) })
      expect(batchCandidates(q, { max: 4, tiers: true })).toEqual([])
      // The title shortened, with no new push: the next poll takes it as it always did
      expect(ci({ pr: titled(54) })).toEqual({ state: 'ci', quick: true, patch: { noCiSince: null, missingSince: null } })
      expect(ci({ pr: titled(54) }).reason).toBeUndefined()
    })

    it('judges it before a batch of one that ended without landing it, a queue that cannot batch, and a handed-over record', () => {
      const alone = fresh({ alone: { head: SHA, text: 'Batch queue/batch-4: required check "verify" failed twice.' } })
      expect(ci({ pr: titled(55), item: alone })).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
      expect(ci({ pr: titled(55), canBatch: false })).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
      // A fork's pull request and a release bump are never batched; the long subject is still the first thing said
      expect(ci({ pr: openPr({ title: `feat(apps): ${'x'.repeat(55)}`, isCrossRepository: true }), canBatch: false })).toMatchObject({ reason: { kind: 'subject' } })
      expect(ci({ pr: titled(55), item: fresh({ auto: { branch: 'docs/x' } }) })).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
      expect(ci({ pr: titled(54), item: fresh({ auto: { branch: 'docs/x' } }) })).toMatchObject({ state: 'ci', quick: true })
    })

    it('counts the subject in characters (code points), not UTF-16 units or bytes', () => {
      // 54 characters in the title, each outside the Basic Multilingual Plane: 72 characters, 126 UTF-16 units
      const emoji = openPr({ title: `feat(apps): ${'😀'.repeat(54)}` })
      expect(ci({ pr: emoji })).toMatchObject({ state: 'ci', quick: true })
      expect(ci({ pr: openPr({ title: `feat(apps): ${'😀'.repeat(55)}` }) })).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
      // Korean syllables are one character each too
      expect(ci({ pr: openPr({ title: `feat(apps): ${'가'.repeat(54)}` }) })).toMatchObject({ quick: true })
      expect(longSubject(openPr({ title: `feat(apps): ${'x'.repeat(54)}` }))).toBeNull()
      expect(longSubject(titled(55))).toEqual({ subject: subjectOf(55), length: 73 })
    })

    // The first review of #1593: judged only once the quick tier was green, a title that was too long while its quick run
    // still went was a batch candidate (batchCandidates takes pending ones), and a batch was made and dropped every tick
    it('judges it while the quick tier still runs or has not reported, since a batch takes those too, and before a failure or a rerun', () => {
      const going = tiered([check(TIER, 'skipped'), check('verify', 'success'), check('windows tests', null)])
      expect(ci({ pr: titled(55), checks: going, runs: [run(null)] })).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
      expect(ci({ pr: titled(54), checks: going, runs: [run(null)] })).toEqual({ state: 'ci', patch: { noCiSince: null, missingSince: null } })
      expect(ci({ pr: titled(55), checks: tiered([]), runs: [] })).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
      const failed = tiered([check(TIER, 'skipped'), check('verify', 'failure', { jobId: '5' }), check('windows tests', 'success')])
      expect(ci({ pr: titled(55), checks: failed, runs: [run('failure')], failures: { 900: { real: false, cause: 'runner', job: { name: 'verify', id: '5' }, attempt: 1 } } })).toMatchObject({ state: 'attention', reason: { kind: 'subject' } })
    })
  })

  // #1509 item 4: what the attention above told a session to type (gh workflow run build.yml --ref <branch>), the queue does
  it('starts the full tier itself on a branch of this repository it cannot batch, once per head, and says so when no full run reports', () => {
    const first = ci({ canBatch: false })
    expect(first).toMatchObject({ state: 'ci', action: { type: 'dispatch-full', branch: 'feat/queue' }, patch: { fullDispatch: { head: SHA } } })
    expect(first.event).toContain('started the full tier on feat/queue')
    const sentAt = (minutesAgo: number) => fresh({ fullDispatch: { head: SHA, at: new Date(NOW - minutesAgo * 60_000).toISOString() } })
    // Started: it waits for that run, and does not start another
    expect(ci({ canBatch: false, item: sentAt(2) })).toEqual({ state: 'ci', patch: { noCiSince: null, missingSince: null } })
    // Nothing reported in 15 minutes: the session hears it, with the command for doing it by hand
    const late = ci({ canBatch: false, item: sentAt(20) })
    expect(late).toMatchObject({ state: 'attention', reason: { kind: 'full-tier' } })
    expect(late.reason.text).toContain('no full run has reported on c0ffee0 in 15 minutes')
    expect(late.reason.text).toContain('gh workflow run build.yml --ref feat/queue')
    // GitHub refused to start it: said, and not flipped back to waiting on the next poll
    expect(ci({ canBatch: false, item: fresh({ fullDispatch: { head: SHA, at: new Date(NOW - 60_000).toISOString(), refused: 'Workflow does not have workflow_dispatch trigger' } }) })).toMatchObject({ state: 'attention', reason: { kind: 'full-tier' } })
    // Started for another head: on this one it starts again
    expect(ci({ canBatch: false, item: fresh({ fullDispatch: { head: SHA2, at: new Date(NOW).toISOString() } }) })).toMatchObject({ action: { type: 'dispatch-full' } })
    // A fork's branch is never run here
    expect(ci({ canBatch: false, pr: openPr({ isCrossRepository: true }) })).toMatchObject({ state: 'attention', reason: { kind: 'full-tier' } })
    // A new head forgets what was started for the old one
    expect(resetFor(fresh({ fullDispatch: { head: SHA, at: 'x' } }), SHA2)).toMatchObject({ head: SHA2, fullDispatch: null })
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

/*
 * A batch that stops only because main moved while it ran (a release bump landed outside the queue) is not its members'
 * fault: they are batched again on the new main, with no `alone` and no message, at most MOVED_CAP times per head (#1548).
 */
describe('a batch stopped because main moved is batched again, not sent to its own CI (#1548)', () => {
  const stoppedBatch = (heads: string[], landed = 0) => {
    const q = queueOf(...heads.map((h, i) => waitingItem(i + 1, h)))
    const b = formBatch(q, q.items, { at: 'x', ref })
    Object.assign(b, { state: 'landing', tier: 'quick', base: { sha: 'm0', tree: 'T0' }, steps: q.items.map((i: any) => ({ pr: i.pr, head: i.head, sha: `s${i.pr}`, tree: `T${i.pr}` })), landed })
    for (const it of q.items.slice(0, landed)) {
      it.state = 'merged'
      delete it.batch
    }
    endBatch(q, b, 'stopped', { at: 'y', batchless: false, why: 'main moved' })
    return { q, b }
  }
  const again = (q: any, b: any, extra: Record<string, unknown> = {}) => rebatchAfterMove(q, b, { at: 'z', ref, min: 1, why: 'Batch queue/batch-1 stopped before #1: main is not the tree.', defaultBranch: 'main', ...extra })

  it('puts a batch of one into a new batch, without blaming it: no alone, no batchless, no message to a session', () => {
    const { q, b } = stoppedBatch([A])
    const made = again(q, b)
    expect(made.members).toEqual([{ pr: 1, head: A }])
    expect(q.items[0]).toMatchObject({ batch: made.id, moved: { head: A, n: 1 } })
    expect(q.items[0].alone).toBeUndefined()
    expect(q.items[0].batchless).toBeUndefined()
    expect(q.events.filter((e: any) => e.notify)).toEqual([])
    expect(q.events.at(-1).text).toBe('Batch queue/batch-2: #1 was in queue/batch-1, which stopped because main moved; it is batched again on it (restart 1 of 3).')
  })

  it('batches those not landed again together, in order, and not the ones that landed', () => {
    const { q, b } = stoppedBatch([A, B, C], 1)
    const made = again(q, b)
    expect(made.members.map((m: any) => m.pr)).toEqual([2, 3])
    expect(q.items.map((i: any) => [i.pr, i.state, i.batch ?? null, i.moved?.n ?? 0])).toEqual([
      [1, 'merged', null, 0],
      [2, 'ci', made.id, 1],
      [3, 'ci', made.id, 1],
    ])
  })

  it('stops after MOVED_CAP restarts on one head: then the batch of one is told to its session as before', () => {
    const first = stoppedBatch([A])
    const q = first.q
    let b = first.b
    for (let n = 1; n <= MOVED_CAP; n++) {
      const made = again(q, b)
      expect(made, `restart ${n}`).not.toBeNull()
      expect(q.items[0].moved.n).toBe(n)
      Object.assign(made, { state: 'landing', tier: 'quick', base: { sha: 'm0', tree: 'T0' }, steps: [{ pr: 1, head: A, sha: 's1', tree: 'T1' }], landed: 0 })
      endBatch(q, made, 'stopped', { at: 'y', batchless: false, why: 'main moved' })
      b = made
    }
    expect(again(q, b)).toBeNull()
    // The count stays on the item: a pull request past the cap that lost it would get fresh restarts on the same head
    expect(q.items[0].moved).toEqual({ head: A, n: MOVED_CAP })
    expect(q.items[0]).toMatchObject({ batchless: A, alone: { head: A, tier: 'quick' } })
    expect(q.items[0].batch).toBeUndefined()
    expect(q.items[0].alone.text).toContain('stopped before #1')
    expect(q.items[0].alone.text).toContain(`batched again ${MOVED_CAP} times on this head already, and main moved under each batch`)
    expect(q.events.filter((e: any) => e.notify)).toEqual([])
    // Its next poll says it, as for any batch of one that ended without landing it, and names the tier it ran
    const d = decideCi({ item: { ...q.items[0], head: A }, pr: openPr({ headRefOid: A }), checks: evaluateChecks({ required: ['verify'], reported: [check('verify', 'success')] }), runs: [run('success')], defaultBranch: 'main', now: NOW, ref, fullTier: 'full tier', canBatch: true, landTier: 'quick' })
    expect(d.reason.kind).toBe('full-tier')
    expect(d.reason.text).toContain("lands from its batch's run (the fast tier, or the full tier when the batch changes the screen), but its batch of one ran the fast tier and ended without landing it: Batch queue/batch-1 stopped before #1")
  })

  it('counts restarts per head: a pull request pushed again starts over, and so does one queued again', () => {
    const { q, b } = stoppedBatch([A])
    q.items[0].moved = { head: A, n: MOVED_CAP }
    q.items[0].head = B
    expect(again(q, b)).not.toBeNull()
    expect(q.items[0].moved).toEqual({ head: B, n: 1 })
    q.items[0].moved = { head: B, n: MOVED_CAP }
    expect(enqueue(q, { repo: R, pr: 1, at: 'z' }).item.moved).toBeUndefined()
  })

  it('past the cap, one of several goes on with its own CI without blame, the others are batched again', () => {
    const { q, b } = stoppedBatch([A, B])
    q.items[0].moved = { head: A, n: MOVED_CAP }
    const made = again(q, b)
    expect(made.members.map((m: any) => m.pr)).toEqual([2])
    // Not alone: it was one of two, and the other was not at fault either; kept out of a batch with others on this head
    expect(q.items[0]).toMatchObject({ batchless: A })
    expect(q.items[0].alone).toBeUndefined()
    expect(q.events.at(-1).text).toContain('#1 used its 3 restarts and goes on with its own CI')
  })

  it('forms no batch of one without tiers: what is left goes back to its own CI, unmarked', () => {
    const { q, b } = stoppedBatch([A, B], 1)
    expect(again(q, b, { min: 2 })).toBeNull()
    expect(q.items[1]).toMatchObject({ state: 'ci' })
    expect(q.items[1].batchless).toBeUndefined()
    expect(q.items[1].alone).toBeUndefined()
    expect(q.items[1].moved).toBeUndefined()
  })

  it('tells a stop caused by main moving from any other stop', () => {
    expect(landing({ mainTree: 'Tx' })).toMatchObject({ do: 'stop', moved: true })
    for (const stop of [landing({ pr: openPr({ number: 1, headRefOid: C }) }), landing({ item: null }), landing({ pr: openPr({ number: 1, headRefOid: A, isDraft: true }) }), landing({ subject: 'x'.repeat(73) })]) {
      expect(stop).toMatchObject({ do: 'stop' })
      expect(stop.moved).toBeUndefined()
    }
  })
})

/*
 * A batch that holds a change to the screen runs the heavy jobs (the e2e shards, both browsers) before it lands; the
 * other batches land after the fast tier (the owner, 2026-10-26, #1538).
 */
describe('which tier a batch must run before it lands, and what lands from a run (#1538)', () => {
  const names = ['changes', 'full tier', 'verify', 'windows tests (vitest 1/2)', 'e2e (webkit 1/2)', 'e2e (webkit 2/2)', 'e2e (chromium 1/2)', 'e2e (chromium 2/2)']
  const E2E = ['e2e (webkit *)', 'e2e (chromium *)']
  const SCREEN = { judge: 'x', checks: E2E, steps: ['pnpm e2e (shard *)'], inputs: { tier: 'full', everything: 'false' } }
  const rows = (over: Record<string, string> = {}) => names.filter((n) => over[n] !== 'absent').map((n) => check(n, over[n] ?? 'success'))
  const checksOf2 = (over: Record<string, string> = {}) => evaluateChecks({ required: names, reported: rows(over) })
  const finished = [{ status: 'completed', conclusion: 'success' }]
  /** The jobs of a run in which every heavy job ran its scenarios, as GitHub lists them with their steps */
  const realJobs = () => [
    ...['webkit', 'chromium'].flatMap((b) => [1, 2].map((n) => ({ name: `e2e (${b} ${n}/2)`, conclusion: 'success', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: `pnpm e2e (shard ${n}/2)`, conclusion: 'success' }] }))),
    { name: 'verify', steps: [{ name: 'Set up job', conclusion: 'success' }] },
  ]
  const gate = (over: Record<string, string>, extra: Record<string, unknown> = {}) =>
    gateGreen({ full: true, landTier: 'quick', checks: checksOf2(over), runs: finished, fullTier: 'full tier', screen: SCREEN, jobs: realJobs(), ...extra })

  it('runs the fast tier, the full tier when the batch changes the screen or cannot be judged, and says so in what it starts the workflow with', () => {
    const inputs = { tier: 'full', everything: 'false' }
    expect(tierToRun({ tiers: true, landTier: 'quick', judged: 'quick' })).toBe('quick')
    expect(tierToRun({ tiers: true, landTier: 'quick', judged: 'full' })).toBe('full')
    // Batches not judged: the fast tier. The full tier landing: always full. No tiers: none
    expect(tierToRun({ tiers: true, landTier: 'quick', judged: null })).toBe('quick')
    expect(tierToRun({ tiers: true, landTier: 'full', judged: 'quick' })).toBe('full')
    expect(tierToRun({ tiers: false, landTier: 'quick', judged: 'full' })).toBeNull()
    expect(dispatchInputs({ tiers: true, landTier: 'quick', tier: 'quick', screenInputs: inputs })).toEqual({ tier: 'quick' })
    expect(dispatchInputs({ tiers: true, landTier: 'quick', tier: 'full', screenInputs: inputs })).toEqual(inputs)
    expect(dispatchInputs({ tiers: true, landTier: 'full', tier: 'full', screenInputs: inputs })).toBeUndefined()
    expect(dispatchInputs({ tiers: false, landTier: 'quick', tier: null, screenInputs: inputs })).toBeUndefined()
    expect(needsFull({ tiers: true, landTier: 'quick', b: { tier: 'quick' } })).toBe(false)
    expect(needsFull({ tiers: true, landTier: 'quick', b: { tier: 'full' } })).toBe(true)
    // A batch from before the field existed (an older board's, a watch command that ran for days) is not known to be quiet:
    // it counts as changing the screen, under either landing tier
    expect(needsFull({ tiers: true, landTier: 'quick', b: {} })).toBe(true)
    expect(needsFull({ tiers: true, landTier: 'quick', b: { tier: null } })).toBe(true)
    expect(needsFull({ tiers: true, landTier: 'full', b: {} })).toBe(true)
    expect(needsFull({ tiers: false, landTier: 'full', b: { tier: 'full' } })).toBe(false)
  })

  it('lands a batch that changes the screen only from a run where the full tier passed and every heavy job was reported and succeeded', () => {
    expect(gate({})).toEqual({ lands: true })
    // The run was the quick tier: the heavy jobs never ran
    expect(gate({ 'full tier': 'skipped', 'e2e (webkit 1/2)': 'absent', 'e2e (webkit 2/2)': 'absent', 'e2e (chromium 1/2)': 'absent', 'e2e (chromium 2/2)': 'absent' })).toEqual({ drop: 'tier' })
    // The full tier's check is still to come
    expect(gateGreen({ full: true, landTier: 'quick', checks: checksOf2({ 'full tier': 'absent' }), runs: [{ status: 'in_progress', conclusion: null }], fullTier: 'full tier', screen: SCREEN })).toEqual({ wait: true })
    // Skipped, left out by the files, or never reported: not a pass for a heavy job
    expect(gate({ 'e2e (chromium 1/2)': 'skipped' })).toEqual({ drop: 'heavy' })
    expect(gate({ 'e2e (webkit 1/2)': 'skipped' })).toEqual({ drop: 'heavy' })
    expect(gate({ 'e2e (webkit 1/2)': 'absent' })).toEqual({ drop: 'heavy' })
    expect(gate({ 'e2e (webkit 1/2)': 'failure' })).toEqual({ drop: 'heavy' })
    // A run that concluded badly on something outside the required rows
    expect(gate({}, { runs: [{ status: 'completed', conclusion: 'failure' }] })).toEqual({ drop: 'heavy' })
    // The batches that need no full run are not asked for any of it
    expect(gate({ 'full tier': 'skipped' }, { full: false })).toEqual({ lands: true })
    // Landing only from the full tier (landTier full) asks for the full tier, and for no heavy job by name
    expect(gate({ 'e2e (webkit 1/2)': 'skipped' }, { landTier: 'full', screen: null })).toEqual({ lands: true })
    expect(gate({ 'full tier': 'skipped' }, { landTier: 'full', screen: null })).toEqual({ drop: 'tier' })
  })

  // All the checks are done a moment before GitHub marks the run completed: a normal window. The first version dropped the
  // batch there (a lost full run, and a false "alone" for its session): it waits, as it does for a check still to come
  it('waits while the run is not completed, though every check has reported', () => {
    const inProgress = [{ status: 'in_progress', conclusion: null }]
    expect(gate({}, { runs: inProgress })).toEqual({ wait: true })
    expect(gate({}, { runs: [...finished, ...inProgress] })).toEqual({ wait: true })
    // Once it is completed it lands (or not) on what it reported
    expect(gate({}, { runs: finished })).toEqual({ lands: true })
    expect(gate({ 'e2e (chromium 1/2)': 'skipped' }, { runs: finished })).toEqual({ drop: 'heavy' })
    // A run that never completes does not land: only waiting, never landing, from a run in progress
    expect(gate({ 'e2e (chromium 1/2)': 'skipped' }, { runs: inProgress })).not.toHaveProperty('lands')
  })

  // The stand-in of a shard the files left out reports a check of the shard's own name and succeeds (build.yml,
  // e2e-chromium-skipped: it only echoes). The branch decides `code` with its own ci-changes.mjs, main's decides the screen, so a
  // change that breaks `classify` can switch the real shards off and leave the stand-ins to pass
  it('does not take the stand-in of a left-out shard for the shard: the job must have run the scenarios', () => {
    const standIn = { name: 'e2e (chromium 1/2)', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run echo "Only documents changed (.github/scripts/ci-changes.mjs)"', conclusion: 'success' }] }
    const jobs = realJobs().map((j) => (j.name === standIn.name ? standIn : j))
    // Every check reports success, by the names alone
    expect(gate({}, { jobs: null })).toEqual({ jobs: true })
    expect(gate({}, { jobs })).toEqual({ drop: 'heavy' })
    expect(heavyRan(realJobs(), SCREEN)).toBe(true)
    expect(heavyRan(jobs, SCREEN)).toBe(false)
    // A shard whose scenarios step failed or was skipped is no pass, nor is a browser with no job at all
    expect(heavyRan(realJobs().map((j) => (j.name === 'e2e (webkit 1/2)' ? { ...j, steps: [{ name: 'pnpm e2e (shard 1/2)', conclusion: 'skipped' }] } : j)), SCREEN)).toBe(false)
    expect(heavyRan(realJobs().filter((j) => !j.name.includes('chromium')), SCREEN)).toBe(false)
    // One stand-in among real shards of the same browser is still a hole
    expect(heavyRan(realJobs().map((j) => (j.name === 'e2e (webkit 2/2)' ? { ...standIn, name: j.name } : j)), SCREEN)).toBe(false)
  })

  /*
   * queue/batch-220 (#1562, run 40247598237, 2026-10-26): all ten shards ran their scenarios and passed, and the batch was
   * dropped. build.yml's stand-in for the Chromium shards (e2e-chromium-skipped) is skipped on every run where the shards
   * run, and GitHub reports a matrix job skipped before its matrix was expanded under its unexpanded name,
   * `e2e (chromium ${{ matrix.shard }}/${{ matrix.shards }})`, which `e2e (chromium *)` matches. Its job list, as recorded:
   */
  const RUN_220 = JSON.parse(readFileSync(join(REPO_ROOT, 'tooling/fixtures/project-board/run-40247598237-jobs.json'), 'utf8')) as { jobs: { name: string; status: string; conclusion: string; steps: { name: string; conclusion: string | null }[] }[] }
  const REAL_SCREEN = JSON.parse(readFileSync(join(REPO_ROOT, '.centralu/apps/project-board/project.json'), 'utf8')).ci.screen
  const template = (n: string) => n.includes('${{')
  const SHARD = /^e2e \((webkit|chromium) \d+\/\d+\)$/
  /** The run's checks: the required set is the workflow's jobs with their matrix filled in (no unexpanded name), every job reported */
  const checks220 = (jobs = RUN_220.jobs) => evaluateChecks({ required: RUN_220.jobs.map((j) => j.name).filter((n) => !template(n)), reported: jobs.map((j) => check(j.name, j.conclusion)) })
  const gate220 = (jobs = RUN_220.jobs) => gateGreen({ full: true, landTier: 'quick', checks: checks220(jobs), runs: finished, fullTier: 'full tier', screen: REAL_SCREEN, jobs })

  it('lands the batch of run 40247598237: a stand-in skipped under its unexpanded matrix name is not a shard', () => {
    // What was recorded: every shard of both browsers ran its scenarios, and the stand-in was skipped under its template name
    expect(RUN_220.jobs.filter((j) => SHARD.test(j.name))).toHaveLength(10)
    expect(RUN_220.jobs.find((j) => j.name === 'e2e (chromium ${{ matrix.shard }}/${{ matrix.shards }})')).toMatchObject({ conclusion: 'skipped', steps: [] })
    expect(screenLanded(checks220(), finished, 'full tier', REAL_SCREEN.checks)).toBe(true)
    expect(heavyRan(RUN_220.jobs, REAL_SCREEN)).toBe(true)
    expect(gate220()).toEqual({ lands: true })
  })

  it('still wants every shard of the matrix build.yml declares, with the stand-in ignored', () => {
    // The shard count is build.yml's (`shards: [M]`, `shard: [1..M]`), and the job names carry it
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8')
    for (const browser of ['webkit', 'chromium']) {
      const job = yml.split(/\n(?= {2}[\w-]+:\n)/).find((block) => block.includes(`name: e2e (${browser} \${{ matrix.shard }}/\${{ matrix.shards }})`) && !block.includes("if: needs.changes.outputs.code == 'false'"))!
      const count = Number(/shards: \[(\d+)\]/.exec(job)![1])
      expect(RUN_220.jobs.filter((j) => j.name.startsWith(`e2e (${browser} `) && !template(j.name)).map((j) => j.name).sort()).toEqual(Array.from({ length: count }, (_, i) => `e2e (${browser} ${i + 1}/${count})`))
    }
    const without = (name: string) => RUN_220.jobs.filter((j) => j.name !== name)
    const patched = (name: string, over: object) => RUN_220.jobs.map((j) => (j.name === name ? { ...j, ...over } : j))
    // A shard GitHub never created is a hole, though every job reported succeeded
    expect(heavyRan(without('e2e (webkit 3/5)'), REAL_SCREEN)).toBe(false)
    expect(screenLanded(checks220(without('e2e (webkit 3/5)')), finished, 'full tier', REAL_SCREEN.checks)).toBe(false)
    // Also with no stand-in in the list at all: only the count says a shard is missing
    const noStandIn = without('e2e (chromium ${{ matrix.shard }}/${{ matrix.shards }})').filter((j) => j.name !== 'e2e (webkit 3/5)')
    expect(heavyRan(noStandIn, REAL_SCREEN)).toBe(false)
    expect(screenLanded(evaluateChecks({ required: ['full tier'], reported: noStandIn.map((j) => check(j.name, j.conclusion)) }), finished, 'full tier', REAL_SCREEN.checks)).toBe(false)
    // A shard whose scenarios were skipped, a shard skipped under its real name, a stand-in that ran: none is a pass
    expect(heavyRan(patched('e2e (chromium 2/5)', { steps: [{ name: 'pnpm e2e (shard 2/5)', conclusion: 'skipped' }] }), REAL_SCREEN)).toBe(false)
    expect(gate220(patched('e2e (chromium 2/5)', { conclusion: 'skipped' }))).toEqual({ drop: 'heavy' })
    expect(gate220(patched('e2e (chromium ${{ matrix.shard }}/${{ matrix.shards }})', { conclusion: 'success', steps: [{ name: 'Run echo "Only documents changed"', conclusion: 'success' }] }))).toEqual({ drop: 'heavy' })
    // Only the stand-ins: the shards were left out, whatever their names
    expect(gate220(RUN_220.jobs.filter((j) => !SHARD.test(j.name)))).toEqual({ drop: 'heavy' })
    // Shard numbers of two counts, or one past the count
    expect(shardsComplete(['e2e (webkit 1/2)', 'e2e (webkit 2/2)'])).toBe(true)
    expect(shardsComplete(['e2e (webkit 1/2)', 'e2e (webkit 2/3)'])).toBe(false)
    expect(shardsComplete(['e2e (webkit 1/2)', 'e2e (webkit 3/2)'])).toBe(false)
    expect(shardsComplete(['keeper e2e'])).toBe(true)
    expect(unexpandedSkip('e2e (chromium ${{ matrix.shard }}/${{ matrix.shards }})', 'skipped')).toBe(true)
    expect(unexpandedSkip('e2e (chromium ${{ matrix.shard }}/${{ matrix.shards }})', 'success')).toBe(false)
    expect(unexpandedSkip('e2e (chromium 1/5)', 'skipped')).toBe(false)
  })

  it('names the tier a batch ran in its line, and the tier of a batch of one that ended without landing in the session\'s message', () => {
    const { b } = greenBatch()
    b.state = 'ci'
    b.head = 'a1b2c3d4e5f6'
    expect(batchLine(b, ref)).toBe('Batch queue/batch-1: #1, #2 — CI at a1b2c3d')
    b.tier = 'full'
    expect(batchLine(b, ref)).toBe('Batch queue/batch-1: #1, #2 — CI at a1b2c3d, the full tier')
    b.state = 'landing'
    b.tier = 'quick'
    expect(batchLine(b, ref)).toBe('Batch queue/batch-1: #1, #2 — green (the fast tier); landed 0 of 2')
    const q = queueOf(waitingItem(1, A))
    const one = formBatch(q, q.items, { at: 'x', ref })
    one.tier = 'full'
    endBatch(q, one, 'dropped', { at: 'y', why: 'it failed.' })
    expect(q.items[0].alone).toEqual({ head: A, text: 'it failed.', tier: 'full' })
    const d = decideCi({ item: { ...q.items[0], head: A }, pr: openPr({ headRefOid: A }), checks: evaluateChecks({ required: ['verify'], reported: [check('verify', 'success')] }), runs: [run('success')], defaultBranch: 'main', now: NOW, ref, fullTier: 'full tier', canBatch: true, landTier: 'quick' })
    expect(d.reason.text).toContain('its batch of one ran the full tier and ended without landing it: it failed.')
    // Without tiers or an older record, the text is as it was
    expect(decideCi({ item: fresh({ alone: { head: SHA, text: 'x' } }), pr: openPr(), checks: evaluateChecks({ required: ['verify'], reported: [check('verify', 'success')] }), runs: [run('success')], defaultBranch: 'main', now: NOW, ref, fullTier: 'full tier', canBatch: true }).reason.text).toContain('lands only from a full run, but its batch of one ended without landing it: x')
  })
})

// The queue as a state machine, driven for real against a model of GitHub: tooling/project-board-queue-model.test.ts


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
      'pnpm os:tighten',
      'pnpm exec vitest run tooling/os-layer.test.ts',
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
    expect(to.reason.text).toContain('Author session: writer. Relay this to it (it has not called this app, so the queue has no address to post to): "Merge main into feat/b77 and push again; conflicted files: packages/ui/src/app.tsx."')
    // Where the instruction goes (#1509 item 4): this session when it is the author, the author's own session when it opened the pull request through open_pr
    const own = handoffReason({ item: fresh({ author: 'me', owner: 'me' }), pr, files, why: 'Not mechanical.', ref, route: 'self' })
    expect(own.reason.text).toContain('#77 is your own pull request (author session: me): fix it in this session: "Merge main into feat/b77')
    // The text names the session the queue posts to: the one that opened it, not the one queue_merge named when that is another
    const direct = handoffReason({ item: fresh({ author: 'writer' }), pr, files, why: 'Not mechanical.', ref, route: 'direct' })
    expect(direct.reason.text).toContain('Author session: the session that opened it (queue_merge named writer as its author). The queue is posting this into it itself, so relay it only if it does not answer: "Merge main into feat/b77')
    expect(direct.reason.relay).toMatchObject({ route: 'direct', to: 'the session that opened it' })
    // No author named, but the opener is known: still posted to it
    expect(handoffReason({ item: fresh({ author: null }), pr, files, why: 'Not mechanical.', ref, route: 'direct' }).reason.text).toContain('Author session: the session that opened it. The queue is posting this into it itself')
    // The queuing session opened it and no author was named: not "no author session is recorded"
    const mine = handoffReason({ item: fresh({ author: null, owner: 'me' }), pr, files, why: 'Not mechanical.', ref, route: 'self' })
    expect(mine.reason.text).toContain('#77 is your own pull request: fix it in this session: "Merge main into feat/b77')
    expect(mine.reason.text).not.toContain('No author session is recorded')
    expect(mine.reason.relay).toMatchObject({ route: 'self', to: 'me' })
    // ... or another was named, which this route does not use: said beside it, not as "fix it in this session" for that one
    expect(handoffReason({ item: fresh({ author: 'writer', owner: 'me' }), pr, files, why: 'Not mechanical.', ref, route: 'self' }).reason.text).toContain('#77 is your own pull request (queue_merge named writer as its author): fix it in this session')
    // authorRoute: the session that opened it through open_pr decides; failing that, an author who is the owner
    expect(authorRoute(fresh({ notice: 'a', author: 'writer' }), { notice: 'a' })).toEqual({ route: 'self', to: 'a' })
    expect(authorRoute(fresh({ notice: 'a', author: 'writer' }), { notice: 'b' })).toEqual({ route: 'direct', to: 'b' })
    expect(authorRoute(fresh({ notice: 'a', author: 'me', owner: 'me' }), null)).toEqual({ route: 'self', to: 'a' })
    expect(authorRoute(fresh({ notice: 'a', author: 'writer', owner: 'me' }), null)).toEqual({ route: 'relay', to: null })
    const none = handoffReason({ item: fresh({ author: null }), pr, files, why: 'Not mechanical.', ref })
    expect(none.reason.relay.to).toBeNull()
    expect(none.reason.text).toContain('No author session is recorded for #77 (queue_merge author). Start a session on its branch feat/b77 with this instruction: "Merge main into feat/b77')
  })
})

describe('the wait for the queue (#1571)', () => {
  it('goes on through polls that each take longer than any time limit it once had, and names the state it last saw when it is never reached', async () => {
    // Every read of the clock is 90 s after the one before: a poll that runs the guard under load, many times over
    let clock = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 90_000))
    try {
      let polls = 0
      const step = async () => ({ n: ++polls })
      expect(await pollUntil(step, (x) => x.n === 3, 'the third poll')).toEqual({ n: 3 })
      await expect(pollUntil(step, () => false, 'a state never reached', 5)).rejects.toThrow('not after 6 polls: a state never reached: {"n":9}')
    } finally {
      now.mockRestore()
    }
  })

  it('fails with the state it saw, not as a bare timeout, when the test has little of its own limit left', async () => {
    const step = async () => ({ n: 1 })
    await expect(pollUntil(step, () => false, 'a slow state', 400, performance.now() + 5_000)).rejects.toThrow('not after 1 polls: a slow state: {"n":1}')
  })
})
/** `n` more polls of the queue (each 100 ms later on its clock), for a test that checks nothing more happens */
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

  // #1593: attention `subject` waits for a title edit, which only a poll sees; the other attentions wait for a push or a person
  it('is busy for an item in attention `subject` for six hours from when it began, and not for another attention', () => {
    const q = emptyQueue()
    const began = '2026-10-26T10:00:00.000Z'
    const at = (hours: number) => Date.parse(began) + hours * 3_600_000
    q.items.push({ ...fresh(), state: 'attention', reason: { kind: 'subject', text: 'x' }, attentionAt: began }, { ...fresh({ pr: 78 }), state: 'attention', reason: { kind: 'failed', text: 'x' }, attentionAt: began })
    expect(queueBusy(q, at(1))).toBe('merge queue, 1 item')
    expect(queueBusy(q, at(5.9))).toBe('merge queue, 1 item')
    expect(queueBusy(q, at(6.1))).toBe(null)
    // An item from an older file has no time: not held
    delete q.items[0].attentionAt
    expect(queueBusy(q, at(1))).toBe(null)
    // Shortened, it is back in CI: busy as any item in CI
    q.items[0].state = 'ci'
    expect(queueBusy(q, at(1))).toBe('merge queue, 1 item')
  })

  it("writes the lease on the system clock, which another process shares, not on the queue's stepped one (#1656)", async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11)] }, runs: { [SHA]: [ghRun(null)] } }))
    // 200 steps of 100 ms: a lease written on the stepped clock would end 20 s later than one written on the system's
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await polls(200)
    const lease = JSON.parse(readFileSync(filesNamed(join(root, 'data'), 'merge-queue.lease.json')[0]!, 'utf8'))
    expect(Math.abs(Date.parse(lease.until) - LEASE_MS - Date.now())).toBeLessThan(6_000)
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
    // More polls with nothing left to poll: a told message is not posted again
    await polls(6)
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
  // What every test here relies on (FAST): the queue moves when a test reads it, one poll a read, and not in between
  it('moves one poll per merge_queue read, and none between reads', async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11), ghCheck('windows tests', 'success', 12)] }, runs: { [SHA]: [ghRun(null)] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const reads = () => ghCalls().filter((a) => a[0] === 'pr' && a[1] === 'view').length
    await until((x) => stateOf(x) === 'ci', 'in CI')
    const counts = [reads()]
    for (let i = 0; i < 5; i++) {
      await call('merge_queue', { all: true })
      counts.push(reads())
    }
    expect(counts.slice(1).map((n, i) => n - counts[i]!)).toEqual([1, 1, 1, 1, 1])
    // Nothing moves while nobody reads: no timer ticks (the one wait here, for a timer that must not fire; a 50 ms one would)
    const before = reads()
    await new Promise((r) => setTimeout(r, 200))
    expect(reads()).toBe(before)
  })

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

  // 2026-10-24 (#1507, run 40063018693, job 120780406901): the runner was shut down under e2e (chromium 1/5) of the release
  // bump. GitHub's only note on the job is "The operation was canceled."; its step says failure; the log holds the shutdown
  // line and, after it, the tests the shutdown cut short
  const SHUTDOWN_LOG = readFileSync(join(REPO_ROOT, 'tooling/fixtures/ci-log-runner-shutdown.txt'), 'utf8')
  const shutDown = (extra: Record<string, unknown> = {}) =>
    ghState({
      checks: { [SHA]: [ghCheck('verify', 'success', 11), ghCheck('windows tests', 'failure', 12)] },
      runs: { [SHA]: [ghRun('failure')] },
      jobs: { 900: [{ id: 11, name: 'verify', conclusion: 'success', steps: [] }, { id: 12, name: 'windows tests', conclusion: 'failure', steps: [{ name: 'pnpm e2e --shard=1/5', conclusion: 'failure' }] }] },
      annotations: { '12': [{ message: 'The operation was canceled.' }] },
      logs: { '12': SHUTDOWN_LOG },
      ...extra,
    })

  it('reruns once a job the runner shut down under, though only the log says so, and lands it when the rerun passes', async () => {
    runtime(shutDown({ on: { 'rerun-failed:900': { runs: { [SHA]: [ghRun('success', 2)] }, checks: { [SHA]: green() } } } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge after the rerun')
    expect(writes().map((w) => w[0])).toEqual(['rerun-failed', 'merge', 'delete'])
  })

  it('asks for attention when the shutdown happens again after the rerun, and names no test the shutdown cut short', async () => {
    runtime(shutDown({ on: { 'rerun-failed:900': { runs: { [SHA]: [ghRun('failure', 2)] }, annotations: { '12': [{ message: 'The operation was canceled.' }] } } } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls()
    expect(writes().map((w) => w[0])).toEqual(['rerun-failed'])
    expect(q.queue[0].reason).toMatchObject({ kind: expect.stringMatching(/failed|failing/) })
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.text).not.toContain('archive.spec.ts')
    expect(notices()[0]!.text).toContain('shutdown signal')
  })

  // The log is read for the shutdown line only when the cancellation is all GitHub wrote on the job (`every`): a job that
  // also carries another note failed for that, and the cancellation is CI's, the fail-fast kind
  it('does not read the log for a shutdown when the job has another note beside the cancellation: a failed step is attention at once, not a rerun', async () => {
    runtime(shutDown({ annotations: { '12': [{ message: 'The operation was canceled.' }, { message: 'Process completed with exit code 1.' }] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls()
    expect(writes()).toEqual([])
    expect(q.queue[0].reason.kind).toMatch(/failed|failing/)
  })

  // 2026-11-05 (#2004, job 127240544856, queue/batch-429): `tauri build` got a 504 fetching AppRun for the AppImage. The
  // annotation is only "Process completed with exit code 1.", so the log's line is what tells the network from the commit
  it('reruns once a bundle that failed fetching a tool it builds with, and lands it when the rerun passes', async () => {
    const log = ['##[group]Run pnpm --filter @cc/desktop exec tauri build', ' Downloading https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-aarch64', 'failed to bundle project: `http status: 504`', '       Error failed to bundle project: `http status: 504`', '##[error]Process completed with exit code 1.'].join('\n')
    runtime(
      shutDown({
        jobs: { 900: [{ id: 12, name: 'linux-arm64', conclusion: 'failure', steps: [{ name: 'Build bundle', conclusion: 'failure' }] }] },
        annotations: { '12': [{ message: 'Process completed with exit code 1.' }] },
        logs: { '12': log },
        on: { 'rerun-failed:900': { runs: { [SHA]: [ghRun('success', 2)] }, checks: { [SHA]: green() } } },
      }),
    )
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge after the rerun')
    expect(writes().map((w) => w[0])).toEqual(['rerun-failed', 'merge', 'delete'])
  })

  // The job carries only the runner's cancellation note, so jobNotes reads the log; each log below has a line that looks
  // like the runner's and is not, and each of the three rules (start of line, exact case, cancellation after it) is the
  // only thing that tells it apart
  const said = '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.'
  const failure = [' FAIL  unit  packages/a/a.test.ts > prints a log > is read', '##[error]Process completed with exit code 1.']
  it.each([
    ['a test printed it, indented', ['##[group]Run pnpm test', `    ${said}`, ...failure, '##[error]The operation was canceled.']],
    ['a test printed it in another case, at the start of a line', ['##[group]Run pnpm test', said.replace('The runner has received', 'the runner has received'), ...failure, '##[error]The operation was canceled.']],
    ['the line is the runner\'s but nothing says the step was cancelled after it', ['##[group]Run pnpm test', said, ...failure]],
  ])("does not take a look-alike for the runner's shutdown (%s)", async (_why, lines) => {
    const printed = lines.join('\n')
    runtime(shutDown({ logs: { '12': printed } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls()
    expect(writes()).toEqual([])
    expect(q.queue[0].reason.kind).toMatch(/failed|failing/)
  })

  it('tells the session once when a pull request goes DIRTY and the queue has no checkout to merge it in, and never merges it', async () => {
    runtime(ghState({ prs: { '77': ghPr(77, { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }) } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention')
    await morePolls()
    expect(writes()).toEqual([])
    expect(notices().map((e) => e.text)).toEqual([
      'Merge queue: #77 (feat(apps): change 77) needs attention: conflict. #77 conflicts with main at c0ffee0. The queue has no checkout to merge it in. #77 is your own pull request (author session: tester): fix it in this session: "Merge main into feat/b77 and push again; conflicted files: not known (GitHub says it conflicts)." The queue takes the new head by itself, at the front of the queue. Or take it out with unqueue.',
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
    await polls(6)
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

  // 2026-11-06 (#1993): one check-runs read answered HTTP 500 three polls running, and the item went to attention
  // "could not be read or acted on 3 times in a row", though the same read answered fine moments later
  it('pauses and backs off on GitHub answering HTTP 500, and never counts it against the item', async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11)] } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    patchGh((s) => (s.checksError = 'HTTP 500: Internal Server Error (https://api.github.com/repos/ijun17/centralu/commits/c0ffee/check-runs?per_page=100&page=1)'))
    const q = await until((x) => x.pause?.kind === 'outage', 'the pause')
    expect(q.queue[0].state).not.toBe('attention')
    expect(q.queue[0].errors ?? 0).toBe(0)
    const before = ghCalls().length
    await polls(6)
    // Paused: nothing asked of GitHub for a while, so three failures cannot pile up
    expect(ghCalls().length).toBe(before)
    expect((await call('merge_queue')).text).toMatch(/Paused until \d\d:\d\d:\d\d UTC: GitHub answered repos\/ijun17\/centralu\/commits\/c0ffee0000000000000000000000000000000000\/check-runs with: HTTP 500/)
    expect(notices()).toHaveLength(0)
    expect(writes()).toEqual([])
  })

  // The queue pauses for each outage (1, 2, 4, 8, 15 minutes); a clock that steps 20 minutes a poll is past each pause at the next one
  it('tells the session once after a 5xx that one pull request meets every time, six pauses running, not before', async () => {
    runtime(ghState({ checks: { [SHA]: [ghCheck('verify', null, 11)] } }), { PROJECT_BOARD_QUEUE_STEP_MS: String(20 * 60_000) })
    await call('queue_merge', { pr: 77, owner: 'tester' })
    patchGh((s) => (s.checksError = 'HTTP 502: Bad Gateway (https://api.github.com/repos/ijun17/centralu/commits/c0ffee/check-runs?per_page=100&page=1)'))
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason.kind).toBe('error')
    // Six polls failed with the 5xx, none was a strike before: not "3 times in a row"
    expect(q.queue[0].reason.text).toContain('could not be read or acted on 6 times in a row')
    await morePolls()
    expect(notices()).toHaveLength(1)
  })

  // A 4xx stays the item's strike: three of them reach attention ('tells the session once when it can no longer read a queued pull request, after three tries')
  it('reads an outage from what GitHub answered, not from the item: a 5xx, a dropped connection and what FATAL names, never a 4xx', () => {
    const e = (kind: string, opts: object = {}) => new GitHubError(kind, 'x', opts)
    expect(isOutage(e('github', { status: 500 }))).toBe(true)
    expect(isOutage(e('github', { status: 503 }))).toBe(true)
    // A dropped connection (gh's "EOF") on a write, but not a refusal that printed no status: GraphQL's words for `gh pr ready` carry none
    expect(isOutage(new GitHubError('github', 'GitHub refused to turn #7 into a draft: Post "https://api.github.com/graphql": EOF', { lost: true }))).toBe(true)
    expect(isOutage(new GitHubError('github', 'GitHub refused to turn #7 into a draft: GraphQL: Pull request is not ready (convertPullRequestToDraft)', { lost: true }))).toBe(false)
    for (const kind of ['network', 'rate', 'auth', 'gh-missing']) expect(isOutage(e(kind))).toBe(true)
    for (const status of [0, 404, 409, 422]) expect(isOutage(e('github', { status })), String(status)).toBe(false)
    expect(isOutage(e('not-found', { status: 404 }))).toBe(false)
    expect(isOutage(new Error('boom'))).toBe(false)
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

  it('reads the pull request back when gh pr merge fails on the connection: merged at the head it read is a landing, not a refusal (#1958)', async () => {
    const EOF = 'Post "https://api.github.com/graphql": EOF'
    const fresh = async (state: Gh) => {
      await rt?.dispose({ awaitTree: true })
      forgetApp()
      await removeFakeDir(join(root, 'data'))
      mkdirSync(join(root, 'data'))
      runtime(state)
    }
    runtime(ghState({ prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2 }), '77': ghPr(77) }, mergeLost: EOF }))
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge GitHub made')
    expect(writes().map((w) => w.slice(0, 2).join(' '))).toEqual(['merge 77', 'delete feat/b77', 'close 76', 'delete feat/low'])
    // Never a refusal, not even for one poll: the owner is told it landed, not that GitHub refused it
    expect(notices().map((e) => e.text).join(' ')).not.toContain('refused')
    expect(notices().at(-1)!.text).toContain('merged #77')
    expect(notices().at(-1)!.text).not.toContain('merged before this poll')
    // Nothing merged: still a refusal, with what gh said
    await fresh(ghState({ mergeError: EOF }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    const q = await until((x) => stateOf(x) === 'attention', 'attention')
    expect(q.queue[0].reason).toMatchObject({ kind: 'refused' })
    expect(q.queue[0].reason.text).toContain('EOF')
    expect(writes()).toEqual([])
    // Merged at a head the queue did not read (a push and a merge by hand in between): not the squash it asked for
    await fresh(ghState({ mergeLost: EOF, mergedAt: SHA2 }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'attention', 'attention for a merge at another head')
    expect(itemsOnDisk()[0]!.reason).toMatchObject({ kind: 'refused' })
    // The read-back is lost too: nobody knows whether it merged, so no refusal; the next poll reads it and finds it merged
    await fresh(ghState({ mergeLost: EOF, on: { 'merge:77': { viewLost: { n: 1 } } } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge found on the next poll')
    expect(notices().map((e) => e.text).join(' ')).not.toContain('refused')
    // gh said yes and the read-back is lost: GitHub was never asked, so it is not 'not-merged' either (a batch would drop, a record be re-drafted)
    await fresh(ghState({ on: { 'merge:77': { viewLost: { n: 1 } } } }))
    await call('queue_merge', { pr: 77, owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the merge found on the next poll')
    expect(notices().map((e) => e.text).join(' ')).not.toContain('does not show it merged')
    expect(writes().map((w) => w[0])).toEqual(['merge', 'delete'])
  })

  it('counts a lower closed when gh lost the answer to the close, and deletes its branch', async () => {
    runtime(
      ghState({
        prs: { '76': ghPr(76, { headRefName: 'feat/low', headRefOid: SHA2 }), '77': ghPr(77, { baseRefName: 'feat/low' }) },
        compare: { [`${SHA2}...${SHA}`]: 'ahead' },
        closeLost: 'Post "https://api.github.com/graphql": EOF',
      }),
    )
    await call('queue_merge', { pr: 77, lowers: [76], owner: 'tester' })
    await until((x) => stateOf(x) === 'merged', 'the stack to land')
    expect(writes().map((w) => w.slice(0, 2).join(' '))).toEqual(['base 77', 'merge 77', 'delete feat/b77', 'close 76', 'delete feat/low'])
    expect(notices().at(-1)!.text).toContain('Closed #76 as landed in it.')
    expect(notices().at(-1)!.text).not.toContain('could not close')
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
    forgetApp()
    // A failed check that is not the duplicate's (another workflow's) still keeps it waiting
    await removeTree(join(root, 'data'))
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
    forgetApp()
    expect(queueOnDisk().items.map((i: any) => [i.pr, i.state])).toEqual([[77, 'ci']])
    patchGh((s) => (s.checks[SHA] = green('2026-10-17T09:00:00Z')))
    runtime()
    await until((x) => stateOf(x) === 'merged', 'the merge after the restart')
    expect(writes().filter((w) => w[0] === 'merge')).toHaveLength(1)
  })
})

// --- Batches (#962), against the fake gh -----------------------------------------------------------------

