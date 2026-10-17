import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeExe, linkNode, rmFakeDir, windowsSystemEnv } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { decideBefore, decideCi, emptyQueue, enqueue, noticeKey, dequeue } from '../.centralu/apps/project-board/queue.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { evaluateChecks } from '../.centralu/apps/project-board/ci.mjs'
// @ts-expect-error — plain .mjs of a Centralu app
import { takeLease, releaseLease } from '../.centralu/apps/project-board/queue-driver.mjs'

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
    expect(decideCi({ item: fresh(), pr: openPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), checks: GREEN(), defaultBranch: 'main', now: NOW, ref })).toEqual({ state: 'waiting' })
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
    } finally {
      rmFakeDir(dir)
    }
  })
})

// --- The app, against a fake gh ---------------------------------------------------------------------

/**
 * The fake gh: answers from a state file and logs every call. `on` holds changes applied when a write
 * happens (a rerun starts a new attempt, a merge marks the pull request merged), so a scenario moves
 * the way GitHub would.
 */
const FAKE_GH = String.raw`
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n')
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st))
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
  const pr = st.prs[args[2]]
  pr.state = 'MERGED'; pr.mergeCommit = { oid: 'abcdef1234567890abcdef1234567890abcdef12' }
  save()
} else if (args[0] === 'pr' && args[1] === 'close') {
  write(['close', args[2], args[args.indexOf('--comment') + 1]])
  st.prs[args[2]].state = 'CLOSED'
  save()
} else if (args[0] === 'pr' && args[1] === 'list') {
  out((st.basedOn ?? {})[args[args.indexOf('--base') + 1]] ?? [])
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
  out({ workflow_runs: (st.runs ?? {})[new URLSearchParams(path.split('?')[1]).get('head_sha')] ?? [] })
} else if (path && /\/actions\/runs\/\d+\/rerun(-failed-jobs)?$/.test(path)) {
  write([path.endsWith('failed-jobs') ? 'rerun-failed' : 'rerun', path.split('/')[5]])
} else if (path && /\/actions\/jobs\/\d+\/logs$/.test(path)) {
  out((st.logs ?? {})[path.split('/')[5]] ?? '')
} else if (path && path.includes('/compare/')) {
  out({ status: (st.compare ?? {})[path.split('/compare/')[1]] ?? 'ahead' })
} else if (path && args.includes('PATCH') && /\/pulls\/\d+$/.test(path)) {
  const body = JSON.parse(fs.readFileSync(0, 'utf8'))
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
})
const green = (at?: string) => [ghCheck('verify', 'success', 11, at), ghCheck('windows tests', 'success', 12, at)]
const ghRun = (conclusion: string | null, attempt = 1, sha = SHA) => ({ id: 900, run_attempt: attempt, head_sha: sha, status: conclusion === null ? 'in_progress' : 'completed', conclusion, created_at: '2026-10-17T08:00:00Z' })
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
let statePath = ''
let logPath = ''

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-project-board-queue-')))
  for (const d of ['bin', 'data', 'node']) mkdirSync(join(root, d))
  linkNode(join(root, 'node'))
  fakeExe(join(root, 'bin'), 'gh', FAKE_GH)
  statePath = join(root, 'gh-state.json')
  logPath = join(root, 'gh.log')
  writeFileSync(logPath, '')
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmFakeDir(root)
})

const PATH = () => `${join(root, 'bin')}${delimiter}${join(root, 'node')}`
const FAST = { PROJECT_BOARD_QUEUE_TICK_MS: '50', PROJECT_BOARD_QUEUE_POLL_MS: '50' }

function runtime(state?: Gh, env: Record<string, string> = {}) {
  if (state) writeFileSync(statePath, JSON.stringify(state))
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: { PATH: PATH(), HOME: root, ...windowsSystemEnv(), FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath, ...FAST, ...env },
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
const gh = (): Gh => JSON.parse(readFileSync(statePath, 'utf8'))
const patchGh = (fn: (s: Gh) => void) => {
  const s = gh()
  fn(s)
  writeFileSync(statePath, JSON.stringify(s))
}
const writes = (): any[][] => gh().writes ?? []
const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesNamed(join(dir, e.name), name) : e.name === name ? [join(dir, e.name)] : []))
}
const queueFile = () => filesNamed(join(root, 'data'), 'merge-queue.json')[0]!
const queueOnDisk = () => JSON.parse(readFileSync(queueFile(), 'utf8'))
const notices = () => (queueOnDisk().events as { kind: string; notify: boolean; text: string }[]).filter((e) => e.notify)

/** Polls until `ok` holds, through merge_queue (which also keeps the app awake), for at most 20 s. */
async function until(ok: (q: any) => boolean, what: string) {
  const end = Date.now() + 20_000
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

describe('the project board app: the merge queue', { timeout: 60_000 }, () => {
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

/**
 * #957: an agent with this app attached typed `gh pr merge` instead of using merge_when_green, because
 * deferred tools show only their names until searched. The descriptions carry the gh command each tool
 * replaces, so a search for the verb finds it, and help answers which tool for which task, on demand
 * (not in the server's instructions, which every session's cached prompt would carry, #512).
 */
describe('agents find the board tool for the gh command they would type', { timeout: 60_000 }, () => {
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
      env: { PATH: PATH(), HOME: root, ...windowsSystemEnv(), FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath, ...FAST },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const t = setTimeout(() => (child.kill(), reject(new Error(`watch did not end: ${out} ${err}`))), 30_000)
    child.on('close', (code) => (clearTimeout(t), resolve({ code, out, err })))
  })
}

const IDLE_SERVER = { PROJECT_BOARD_QUEUE_TICK_MS: String(3_600_000) }

describe('the watch command: the queuing session hears about its items', { timeout: 60_000 }, () => {
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
    expect(lines[2]).toMatch(/merge-queue\.mjs" watch --data ".+" --owner "tester" --after \d+$/)
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
