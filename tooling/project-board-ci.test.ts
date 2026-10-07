import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import {
  decideMerge,
  evaluateChecks,
  firstFailure,
  matchKnownFailure,
  squashMessage,
  stripAttribution,
  summarizeDescription,
  workflowCheckNames,
  // @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
} from '../.centralu/apps/project-board/ci.mjs'

/**
 * ci_status and merge_when_green of the project board app (#386). First the decisions as pure
 * functions (ci.mjs), then the app itself, run by the real external-app runtime against a fake `gh`
 * on PATH that answers the REST and `gh pr` calls the tools make and records every merge it is asked
 * for. No real pull request is ever merged here.
 *
 * Why the rule matters: on 2026-10-05 a merge script read "no checks reported yet" as "nothing
 * pending, nothing failed" and merged #380 before its CI had started.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

type Check = { kind: 'run'; name: string; status: string; conclusion: string | null; id?: number; jobId?: string | null; at?: string } | { kind: 'status'; name: string; state: string }
const run = (name: string, conclusion: string | null, extra: Partial<Check> = {}): Check => ({
  kind: 'run',
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  ...extra,
} as Check)

const REQUIRED = ['linux-x64', 'verify', 'windows tests']
const allPassed = () => REQUIRED.map((n) => run(n, 'success'))
const openPr = { number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'main' }
const maintainer = { admin: false, maintain: true, push: true }

describe('which checks a workflow requires', () => {
  it("reads this repository's build workflow as the check names CI reports, matrix rows filled in", () => {
    const text = readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8')
    const w = workflowCheckNames(text)
    // The names `gh pr checks` showed for #415, without the discord-notify job, plus the content
    // verifier's two rows (#440)
    expect([...w.names].sort()).toEqual(['content verify (macos-14)', 'content verify (ubuntu-24.04)', 'darwin-arm64', 'keeper e2e', 'linux-arm64', 'linux-x64', 'verify', 'windows tests', 'windows-x64'])
    expect(w.unresolved).toEqual([])
  })

  it('skips script blocks and comments, multiplies matrix axes, and names what it cannot work out', () => {
    const w = workflowCheckNames(
      [
        'on: [pull_request]',
        'jobs:',
        '  test:',
        "    name: 'test ${{ matrix.os }} node ${{ matrix.node }}'",
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu, macos]',
        '        node:',
        '          - 20',
        '          - 22',
        '    steps:',
        '      - run: |',
        '          name: not-a-job',
        '          echo hi',
        '  # old:',
        '  #   name: commented out',
        '  lint:',
        '    runs-on: ubuntu-latest # name: nothing',
        '  odd:',
        '    name: ${{ github.event_name }} build',
      ].join('\n'),
    )
    expect(w.names).toEqual(['test ubuntu node 20', 'test ubuntu node 22', 'test macos node 20', 'test macos node 22', 'lint'])
    expect(w.unresolved).toEqual(['odd'])
  })
})

describe('what the reported checks add up to', () => {
  it('is green only when every required check is reported and passed', () => {
    const r = evaluateChecks({ required: REQUIRED, reported: [...allPassed(), run('notify', 'failure')] })
    expect(r.verdict).toBe('green')
    expect(r.counts).toEqual({ passed: 3, failed: 0, pending: 0, missing: 0, total: 3 })
    // A check outside the required set is shown, not counted
    expect(r.others.map((o: { name: string; state: string }) => `${o.name} ${o.state}`)).toEqual(['notify failed'])
  })

  it('never calls no reported checks green, with or without a required set (#380)', () => {
    expect(evaluateChecks({ required: null, reported: [] }).verdict).toBe('none')
    expect(evaluateChecks({ required: REQUIRED, reported: [] }).verdict).toBe('none')
    const d = decideMerge({ permissions: maintainer, pr: openPr, checks: evaluateChecks({ required: null, reported: [] }) })
    expect(d.action).toBe('wait')
    expect(d.reason).toBe('No checks are reported for its head commit yet, and no checks is not green.')
  })

  it('waits for a required check that is not reported yet, even when everything reported passed', () => {
    const r = evaluateChecks({ required: REQUIRED, reported: [run('linux-x64', 'success'), run('verify', 'success')] })
    expect(r.verdict).toBe('pending')
    expect(r.rows.find((x: { name: string }) => x.name === 'windows tests').state).toBe('missing')
    expect(decideMerge({ permissions: maintainer, pr: openPr, checks: r }).reason).toBe('Required checks still to pass: windows tests (not reported yet).')
  })

  it('is pending while a required check runs, and failing as soon as one fails', () => {
    expect(evaluateChecks({ required: REQUIRED, reported: [run('linux-x64', null), run('verify', 'success'), run('windows tests', 'success')] }).verdict).toBe('pending')
    const failing = evaluateChecks({ required: REQUIRED, reported: [run('linux-x64', null), run('verify', 'failure'), run('windows tests', 'success')] })
    expect(failing.verdict).toBe('failing')
    for (const c of ['cancelled', 'timed_out', 'action_required', 'startup_failure']) {
      expect(evaluateChecks({ required: ['verify'], reported: [run('verify', c)] }).verdict).toBe('failing')
    }
    // Skipped and neutral pass, as they do for GitHub's own required checks
    expect(evaluateChecks({ required: ['verify', 'lint'], reported: [run('verify', 'skipped'), run('lint', 'neutral')] }).verdict).toBe('green')
  })

  it('counts the newest report of a rerun check', () => {
    const reported = [run('verify', 'failure', { id: 1, at: '2026-10-05T08:00:00Z' }), run('verify', 'success', { id: 2, at: '2026-10-05T09:00:00Z' })]
    expect(evaluateChecks({ required: ['verify'], reported }).verdict).toBe('green')
    expect(evaluateChecks({ required: ['verify'], reported: [...reported].reverse() }).verdict).toBe('green')
  })

  it('counts commit statuses, and with an incomplete required set every reported check', () => {
    expect(evaluateChecks({ required: ['ci/legacy'], reported: [{ kind: 'status', name: 'ci/legacy', state: 'pending' }] }).verdict).toBe('pending')
    expect(evaluateChecks({ required: ['ci/legacy'], reported: [{ kind: 'status', name: 'ci/legacy', state: 'error' }] }).verdict).toBe('failing')
    const r = evaluateChecks({ required: ['verify'], reported: [run('verify', 'success'), run('test (ubuntu)', 'failure')], alsoReported: true })
    expect(r.verdict).toBe('failing')
  })
})

describe('whether to merge', () => {
  const green = () => evaluateChecks({ required: REQUIRED, reported: allPassed() })

  it('merges a green, mergeable, open pull request for a maintainer or an admin', () => {
    expect(decideMerge({ permissions: maintainer, pr: openPr, checks: green() }).action).toBe('merge')
    expect(decideMerge({ permissions: { admin: true }, pr: openPr, checks: green() }).action).toBe('merge')
  })

  it('refuses an account without maintain or admin, whatever CI says', () => {
    for (const permissions of [{ push: true, triage: true, pull: true }, {}, undefined]) {
      const d = decideMerge({ permissions, pr: openPr, checks: green() })
      expect(d.action).toBe('refuse')
      expect(d.kind).toBe('permission')
    }
  })

  it('refuses a draft, a closed pull request, a failing one and one with conflicts, and waits on mergeability', () => {
    expect(decideMerge({ permissions: maintainer, pr: { ...openPr, isDraft: true }, checks: green() }).kind).toBe('draft')
    expect(decideMerge({ permissions: maintainer, pr: { ...openPr, state: 'MERGED' }, checks: green() }).reason).toBe('PR #7 is merged, not open.')
    const failing = evaluateChecks({ required: REQUIRED, reported: [...allPassed().slice(1), run('linux-x64', 'failure')] })
    expect(decideMerge({ permissions: maintainer, pr: openPr, checks: failing })).toMatchObject({ action: 'refuse', kind: 'failing' })
    expect(decideMerge({ permissions: maintainer, pr: { ...openPr, mergeable: 'CONFLICTING' }, checks: green() })).toMatchObject({ action: 'refuse', kind: 'conflict' })
    expect(decideMerge({ permissions: maintainer, pr: { ...openPr, mergeable: 'UNKNOWN' }, checks: green() })).toMatchObject({ action: 'wait', kind: 'mergeable' })
  })
})

describe('the squash commit message', () => {
  const description = [
    '<!--',
    '  Keep this short.',
    '-->',
    '',
    '## Why',
    '',
    '<!-- The problem -->',
    'A merge script merged #380 before CI started.',
    '',
    '## What changed',
    '',
    '- ci_status and merge_when_green.',
    '',
    '## Verified',
    '',
    'pnpm verify passed.',
    '',
    '## Not exercised',
    '',
    'The packaged app.',
    '',
    '## Closes',
    '',
    'Refs #386',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    '',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
  ].join('\n')

  it("summarizes the PR template's Why, What changed and Closes, without comments or attribution", () => {
    expect(squashMessage({ number: 42, title: 'feat(apps): merge when green', description })).toEqual({
      subject: 'feat(apps): merge when green (#42)',
      body: 'A merge script merged #380 before CI started.\n\n- ci_status and merge_when_green.\n\nRefs #386',
    })
  })

  it("uses the caller's body, also without attribution lines", () => {
    const body = 'Why it changed.\n\nco-authored-by: Someone <a@b.c>\nGenerated with Codex\n\nRefs #386\n  Co-Authored-By: Claude <noreply@anthropic.com>'
    expect(squashMessage({ number: 42, title: 'fix: x', body, description })).toEqual({ subject: 'fix: x (#42)', body: 'Why it changed.\n\nRefs #386' })
    // A line that only mentions the words keeps them
    expect(stripAttribution('The code generated with this tool is checked.')).toBe('The code generated with this tool is checked.')
  })

  it('uses a description without the template headings whole', () => {
    expect(summarizeDescription('Just one paragraph.\n\nCo-Authored-By: x')).toBe('Just one paragraph.\n\nCo-Authored-By: x')
    expect(squashMessage({ number: 1, title: 't', description: 'Just one paragraph.\n\nCo-Authored-By: x' }).body).toBe('Just one paragraph.')
  })
})

const ESC = '\u001b'
const stamp = (l: string) => `2026-10-05T08:13:20.6455432Z ${l}`
const VITEST_LOG = [
  '##[group]Run pnpm test',
  `${ESC}[32m   ✓${ESC}[39m an idle app stops > with no call in progress  904ms`,
  `${ESC}[31m   ×${ESC}[39m the shutdown rule (S-5)${ESC}[2m > ${ESC}[22meven a descendant left by an app that ended cleanly on its own is collected — its entire group is ended 814ms`,
  `${ESC}[31m     → EBUSY: resource busy or locked, rmdir 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cc-apps-life-Zx81Qa\\proj\\.centralu\\apps\\parent'${ESC}[39m`,
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  ` ${ESC}[41m FAIL ${ESC}[49m  app-runtime  packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected — its entire group is ended`,
  "Error: EBUSY: resource busy or locked, rmdir 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cc-apps-life-Zx81Qa\\proj\\.centralu\\apps\\parent'",
  '##[error]Process completed with exit code 1.',
]
  .map(stamp)
  .join('\n')

// Shaped like #368: code blocks with the failure lines, inline code for test names
const KNOWN = [
  '### 1. keeper e2e: a swap target\'s host copy missing',
  '```',
  '  FAIL the keeper and the host both end on build C',
  "Error: Cannot find module '/tmp/ckh-O0htlN/hosts/handoff-C/main.mjs'",
  '```',
  '### 2. windows tests: EBUSY removing an app folder',
  '```',
  'packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected — its entire group is ended',
  "EBUSY: resource busy or locked, rmdir '…\\cc-apps-life-…\\proj\\.centralu\\apps\\parent'",
  '```',
  '`keeper::handoff::tests::output_held_for_no_reader_reaches_the_next_keepers_reader` failed once.',
].join('\n')

describe("a failed job's log", () => {
  it('gives the first failing test line and its error, without colour codes or timestamps', () => {
    expect(firstFailure(VITEST_LOG)).toEqual({
      line: 'FAIL app-runtime packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected — its entire group is ended',
      error: "Error: EBUSY: resource busy or locked, rmdir 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cc-apps-life-Zx81Qa\\proj\\.centralu\\apps\\parent'",
    })
  })

  it('reads the keeper scripts, cargo test, and a log with no test failure', () => {
    const keeper = ['  ok   the switch is accepted', '  FAIL the keeper and the host both end on build C', '[keeper] handoff: rolled back', 'node:internal/modules/cjs/loader:1433', "Error: Cannot find module '/tmp/ckh-tDIrRv/hosts/handoff-C/main.mjs'"]
    expect(firstFailure(keeper.map(stamp).join('\n'))).toEqual({ line: 'FAIL the keeper and the host both end on build C', error: "Error: Cannot find module '/tmp/ckh-tDIrRv/hosts/handoff-C/main.mjs'" })
    const cargo = [
      'test keeper::handoff::tests::output_held_for_no_reader_reaches_the_next_keepers_reader ... FAILED',
      'failures:',
      '---- keeper::handoff::tests::output_held_for_no_reader_reaches_the_next_keepers_reader stdout ----',
      "thread 'keeper::handoff::tests::output_held_for_no_reader_reaches_the_next_keepers_reader' panicked at src/keeper/handoff.rs:900:5:",
      'lost or doubled lines across the handoff',
    ]
    expect(firstFailure(cargo.join('\n')).error).toBe(
      "thread 'keeper::handoff::tests::output_held_for_no_reader_reaches_the_next_keepers_reader' panicked at src/keeper/handoff.rs:900:5: lost or doubled lines across the handoff",
    )
    expect(firstFailure(['##[error]Unable to resolve action actions/checkout', '##[error]Process completed with exit code 1.'].map(stamp).join('\n'))).toEqual({
      line: null,
      error: 'Unable to resolve action actions/checkout',
    })
  })

  it('says when the known-failures issue quotes the failure, across temp-folder names, and not otherwise', () => {
    expect(matchKnownFailure(firstFailure(VITEST_LOG), KNOWN)).toBe(
      'packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected…',
    )
    expect(matchKnownFailure({ line: null, error: "Error: Cannot find module '/tmp/ckh-Ab12Cd/hosts/handoff-C/main.mjs'" }, KNOWN)).toBe(
      "Error: Cannot find module '/tmp/ckh-O0htlN/hosts/handoff-C/main.mjs'",
    )
    expect(matchKnownFailure({ line: 'test keeper::handoff::tests::output_held_for_no_reader_reaches_the_next_keepers_reader ... FAILED', error: null }, KNOWN)).toBe(
      'keeper::handoff::tests::output_held_for_no_reader_reaches_the_next_keepers_reader',
    )
    expect(matchKnownFailure({ line: 'FAIL unit packages/core/src/x.test.ts > adds numbers', error: 'AssertionError: expected 3 to be 4' }, KNOWN)).toBe(null)
    expect(matchKnownFailure({ line: null, error: "Error: Cannot find module '/tmp/ckh-Ab12Cd/hosts/handoff-B/other.mjs'" }, KNOWN)).toBe(null)
  })
})

// --- The app, against a fake gh ---------------------------------------------------------------------

const ref: AppRef = { projectId: 'p1', appId: 'project-board' }
const agent: AppCaller = { kind: 'session', sessionId: 's1' }

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n')
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st))
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
const fail = (msg) => { process.stderr.write('gh: ' + msg + '\n'); process.exit(1) }
const R = 'repos/ijun17/centralu'
const path = args[0] === 'api' ? args.filter((a) => a.startsWith('repos/'))[0] : null
// One step of a sequence per read: the last one stays
const step = (key) => { const seq = st[key]; const v = seq[0]; if (seq.length > 1) { seq.shift(); save() } return v }
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = { ...st.pr }
  if (st.heads) pr.headRefOid = step('heads')
  if (st.merged) Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: 'abcdef1234567890' } })
  out(pr)
} else if (args[0] === 'pr' && args[1] === 'merge') {
  st.merges = [...(st.merges ?? []), args]
  if (st.mergeError) fail(st.mergeError)
  st.merged = true
  save()
} else if (args[0] === 'issue' && args[1] === 'view') {
  out({ body: st.issue, comments: [], state: 'OPEN' })
} else if (path === R) {
  out({ permissions: st.permissions, default_branch: 'main' })
} else if (path === R + '/branches/main/protection/required_status_checks') {
  fail('Branch not protected (HTTP 404)')
} else if (path === R + '/rules/branches/main') {
  out([])
} else if (path && path.startsWith(R + '/contents/.github/workflows/build.yml')) {
  if (!st.workflow) fail('Not Found (HTTP 404)')
  out(st.workflow)
} else if (path && /\/check-runs\?/.test(path)) {
  out({ total_count: 0, check_runs: step('checkRuns') })
} else if (path && /\/commits\/[^/]+\/status$/.test(path)) {
  out({ state: 'pending', statuses: [] })
} else if (path && /\/actions\/jobs\/\d+\/logs$/.test(path)) {
  out(st.logs[path.split('/')[5]] ?? '')
} else if (args[0] === 'api' && args.includes('DELETE')) {
  st.deleted = [...(st.deleted ?? []), path]
  save()
} else fail('fake gh: unexpected call ' + JSON.stringify(args) + ' (HTTP 400)')
`

const WORKFLOW = ['jobs:', '  verify:', '    name: verify', '  windows-tests:', '    name: windows tests', '  bundle:', '    name: ${{ matrix.target }}', '    strategy:', '      matrix:', '        include:', '          - target: linux-x64', ''].join('\n')
const ghRun = (name: string, conclusion: string | null, id: number) => ({
  id,
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  html_url: `https://github.com/ijun17/centralu/actions/runs/1/job/${id}`,
  started_at: '2026-10-05T08:00:00Z',
  app: { slug: 'github-actions' },
})
const green = () => [ghRun('verify', 'success', 11), ghRun('windows tests', 'success', 12), ghRun('linux-x64', 'success', 13), ghRun('notify', 'success', 14)]
const PR_BODY = '## Why\n\nBecause.\n\n## What changed\n\nThings.\n\n## Not exercised\n\nNothing.\n\n## Closes\n\nRefs #386\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>'

function ghState(patch: Record<string, unknown> = {}) {
  return {
    permissions: { admin: true, maintain: true, push: true },
    pr: {
      number: 77,
      title: 'feat(apps): merge when green',
      body: PR_BODY,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      headRefOid: 'c0ffee0000000000000000000000000000000000',
      headRefName: 'feat/merge-when-green',
      baseRefName: 'main',
      isCrossRepository: false,
      url: 'https://github.com/ijun17/centralu/pull/77',
      mergeCommit: null,
    },
    workflow: WORKFLOW,
    checkRuns: [green()],
    logs: { '12': VITEST_LOG },
    issue: KNOWN,
    ...patch,
  }
}

let root = ''
let rt: ExternalApps | null = null
let statePath = ''
let logPath = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-project-board-ci-')))
  for (const d of ['bin', 'data', 'node']) mkdirSync(join(root, d))
  symlinkSync(process.execPath, join(root, 'node', 'node'))
  writeFileSync(join(root, 'bin', 'gh'), FAKE_GH)
  chmodSync(join(root, 'bin', 'gh'), 0o755)
  statePath = join(root, 'gh-state.json')
  logPath = join(root, 'gh.log')
  writeFileSync(logPath, '')
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmSync(root, { recursive: true, force: true })
})

function runtime(state: Record<string, unknown>, timing: { callTimeoutMs?: number } = {}) {
  writeFileSync(statePath, JSON.stringify(state))
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: { PATH: `${join(root, 'bin')}:${join(root, 'node')}`, HOME: root, FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath, PROJECT_BOARD_CI_POLL_MS: '250' },
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 5_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  return rt
}

async function call(name: string, args: Record<string, unknown>, progress?: string[]) {
  const out = await rt!.call(ref, name, args, agent, progress ? { onProgress: (m) => progress.push(m) } : {})
  if (!out.result) throw new Error(`${name} did not answer: ${out.status} ${out.error}`)
  return { text: resultText(out.result), isError: out.result.isError === true, data: out.result.structuredContent as Record<string, unknown> }
}
const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
const merges = () => (JSON.parse(readFileSync(statePath, 'utf8')) as { merges?: string[][] }).merges ?? []

// The fake gh is a node script reached through PATH joined with `:`, like the board's test (#14)
describe.skipIf(process.platform === 'win32')('the project board app: ci_status and merge_when_green', { timeout: 30_000 }, () => {
  it('passes check with ci_status as a read and merge_when_green as a change, both for agents only', async () => {
    const r = await runtime(ghState()).check(ref)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.text).toContain('ci_status — reads, model')
    expect(r.text).toContain('merge_when_green — changes, model')
  })

  it('reports the required checks of a pull request compactly, with the first failing test and the known flake it matches', async () => {
    runtime(ghState({ checkRuns: [[ghRun('verify', 'success', 11), ghRun('windows tests', 'failure', 12), ghRun('notify', 'success', 14)]] }))
    const r = await call('ci_status', { pr: 77 })
    expect(r.isError).toBe(false)
    expect(r.text).toBe(
      [
        'PR #77 at c0ffee0: failing. Required (build.yml on main): 1 of 3 passed, 1 failed, 1 not reported yet.',
        'windows tests: failed',
        'linux-x64: not reported yet',
        'Passed: verify.',
        'Not required: notify passed.',
        'Failures:',
        "windows tests (job 12): FAIL app-runtime packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected — its entire group is ended | Error: EBUSY: resource busy or locked, rmdir 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cc-apps-life-Zx81Qa\\proj\\.centralu\\apps\\parent' | known intermittent failure? #368 quotes \"packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected…\"",
      ].join('\n'),
    )
    expect(r.data.verdict).toBe('failing')
    // Read-only: nothing merged, nothing deleted
    expect(ghCalls().filter((a) => a[1] === 'merge' || a.includes('DELETE'))).toEqual([])
  })

  it('refuses to merge for an account without maintain or admin, before reading anything else', async () => {
    runtime(ghState({ permissions: { admin: false, maintain: false, push: true } }))
    const r = await call('merge_when_green', { pr: 77 })
    expect(r.isError).toBe(true)
    expect(r.data.outcome).toBe('refused')
    expect(r.text).toContain('no maintain or admin permission')
    expect(ghCalls()).toEqual([['api', 'repos/ijun17/centralu']])
  })

  it('does not merge while no checks are reported, and says so', async () => {
    // The #380 mistake: CI had not started, and "nothing pending, nothing failed" was read as green
    runtime(ghState({ checkRuns: [[]] }))
    const r = await call('merge_when_green', { pr: 77 })
    expect(r.isError).toBe(false)
    expect(r.data.outcome).toBe('pending')
    expect(r.text.split('\n')[0]).toBe('Not merged yet: No checks are reported for its head commit yet, and no checks is not green. Call again later, or with wait: true to wait for them.')
    expect(merges()).toEqual([])
  })

  it('does not merge while no checks are reported even with no required set to go on', async () => {
    // No branch protection and no workflow file: every reported check counts, and none is not green
    runtime(ghState({ workflow: null, checkRuns: [[]] }))
    const bare = await call('merge_when_green', { pr: 77 })
    expect(bare.data.outcome).toBe('pending')
    expect(bare.text.split('\n')[0]).toBe('Not merged yet: No checks are reported for its head commit yet, and no checks is not green. Call again later, or with wait: true to wait for them.')
    expect(merges()).toEqual([])
  })

  it('refuses a failing pull request with the failure, and merges nothing', async () => {
    runtime(ghState({ checkRuns: [[ghRun('verify', 'success', 11), ghRun('windows tests', 'failure', 12), ghRun('linux-x64', null, 13)]] }))
    const r = await call('merge_when_green', { pr: 77, wait: true })
    expect(r.isError).toBe(true)
    expect(r.data.outcome).toBe('refused')
    expect(r.text.split('\n')[0]).toBe('Not merged: A required check failed.')
    expect(r.text).toContain('windows tests (job 12): FAIL app-runtime packages/agent-host/src/apps/external/lifecycle.test.ts')
    expect(merges()).toEqual([])
  })

  it('waits until every required check is reported and passed, keeping the call alive, then squash-merges once with a clean message', async () => {
    // Nothing, then some running, then green. The call deadline (2.5 s) is shorter than the wait (11
    // polls of 250 ms at least): only the progress notifications keep the call open.
    const some = [ghRun('verify', 'success', 11)]
    const running = [ghRun('verify', 'success', 11), ghRun('windows tests', null, 12), ghRun('linux-x64', 'success', 13)]
    runtime(ghState({ checkRuns: [[], [], [], [], some, some, some, running, running, running, running, green()] }), { callTimeoutMs: 2_500 })
    const progress: string[] = []
    const started = Date.now()
    const r = await call('merge_when_green', { pr: '#77', wait: true }, progress)
    expect(Date.now() - started).toBeGreaterThan(2_500)
    expect(r.isError).toBe(false)
    // Merged after the read that was green, not at the first one where everything reported had passed
    expect(ghCalls().filter((a) => a.some((x) => x.includes('/check-runs?')))).toHaveLength(12)
    expect(r.data).toMatchObject({ outcome: 'merged', merged: true, commit: 'abcdef1234567890', subject: 'feat(apps): merge when green (#77)' })
    expect(r.text.split('\n')[0]).toBe('Merged PR #77 (squash) as abcdef1: "feat(apps): merge when green (#77)".')
    expect(progress.length).toBeGreaterThanOrEqual(3)
    expect(progress[0]).toMatch(/^Waiting for PR #77 \(0 s so far\): No checks are reported/)
    expect(merges()).toEqual([
      ['pr', 'merge', '77', '-R', 'ijun17/centralu', '--squash', '--match-head-commit', 'c0ffee0000000000000000000000000000000000', '--subject', 'feat(apps): merge when green (#77)', '--body', 'Because.\n\nThings.\n\nRefs #386'],
    ])
    expect(ghCalls().flat()).not.toContain('--auto')
    expect(ghCalls().flat()).not.toContain('--delete-branch')
  })

  it("takes the caller's body, deletes the branch only when asked and never a fork's", async () => {
    runtime(ghState())
    const r = await call('merge_when_green', { pr: 77, body: 'Short body.\n\nCo-Authored-By: Claude <noreply@anthropic.com>', deleteBranch: true })
    expect(r.data.outcome).toBe('merged')
    expect(merges()[0]!.at(-1)).toBe('Short body.')
    expect(r.text.split('\n')[0]).toContain('Deleted branch feat/merge-when-green.')
    expect(ghCalls().filter((a) => a.includes('DELETE'))).toEqual([['api', '-X', 'DELETE', 'repos/ijun17/centralu/git/refs/heads/feat/merge-when-green']])

    await rt!.dispose()
    writeFileSync(logPath, '')
    const fork = ghState()
    fork.pr = { ...fork.pr, isCrossRepository: true }
    runtime(fork)
    const f = await call('merge_when_green', { pr: 77, deleteBranch: true })
    expect(f.text.split('\n')[0]).toContain('Branch feat/merge-when-green not deleted: it is in a fork.')
    expect(ghCalls().filter((a) => a.includes('DELETE'))).toEqual([])
  })

  it('stops waiting when the head moves, and reports a merge GitHub refused', async () => {
    runtime(ghState({ checkRuns: [[]], heads: ['c0ffee0000000000000000000000000000000000', 'c0ffee0000000000000000000000000000000000', 'beef000000000000000000000000000000000000'] }))
    const moved = await call('merge_when_green', { pr: 77, wait: true })
    expect(moved.isError).toBe(true)
    expect(moved.text).toBe('Not merged: its head moved from c0ffee0 to beef000 while waiting, so the checks waited on are not the ones that count. Call again to wait on the new commit.')
    expect(merges()).toEqual([])

    await rt!.dispose()
    runtime(ghState({ mergeError: 'Pull request is not mergeable: the base branch policy prohibits the merge.' }))
    const refused = await call('merge_when_green', { pr: 77 })
    expect(refused.isError).toBe(true)
    expect(refused.text.split('\n')[0]).toBe('Not merged: GitHub refused the merge: Pull request is not mergeable: the base branch policy prohibits the merge.')
  })

  it('waits only as long as it is allowed to, then says what is still pending', async () => {
    runtime(ghState({ checkRuns: [[ghRun('verify', null, 11)]] }))
    // 0.02 min = 1.2 s: a few 250 ms polls
    const r = await call('merge_when_green', { pr: 77, wait: true, waitMinutes: 0.02 })
    expect(r.isError).toBe(false)
    expect(r.data.outcome).toBe('timeout')
    expect(r.text.split('\n')[0]).toMatch(/^Not merged: still not green after \d+ s of waiting \(limit 1 s\)\. Required checks still to pass: verify, windows tests \(not reported yet\), linux-x64 \(not reported yet\)\.$/)
    expect(merges()).toEqual([])
  })
})
