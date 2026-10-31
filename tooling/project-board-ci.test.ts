import { runInNewContext } from 'node:vm'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import {
  decideMerge,
  evaluateChecks,
  failingStepText,
  cleanLog,
  firstFailure,
  failureLineIndex,
  matchKnownFailure,
  ranTier,
  squashMessage,
  stripAttribution,
  summarizeDescription,
  workflowCheckNames,
  workflowEventJobs,
  // @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
} from '../.centralu/apps/project-board/ci.mjs'
import { endLeftoverFakes, fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
import { SLOW } from './test-timing.js'

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
    // verifier's two rows (#440), the keeper's Linux job (#350) and the host's tests on the remote's pinned Node
    // (remote-hub.md §10.9), and the e2e suite's WebKit and Chromium shards with the report that merges them, and the
    // job that says which of them a commit needs (their stand-ins report the same names), and the Windows unit
    // tests' two shards beside `windows tests` (#1035), and the fail fast that cancels a manual run after verify (#1222), and the host's tests on macOS (#1704)
    expect([...w.names].sort()).toEqual([
      'changes',
      'content verify (macos-15)',
      'content verify (ubuntu-24.04)',
      'darwin-arm64',
      'e2e (chromium 1/5)',
      'e2e (chromium 2/5)',
      'e2e (chromium 3/5)',
      'e2e (chromium 4/5)',
      'e2e (chromium 5/5)',
      'e2e (webkit 1/5)',
      'e2e (webkit 2/5)',
      'e2e (webkit 3/5)',
      'e2e (webkit 4/5)',
      'e2e (webkit 5/5)',
      'e2e report',
      'fail fast',
      'full tier',
      'host tests, remote Node (ubuntu-24.04)',
      'host tests, remote Node (windows-2022)',
      'keeper e2e',
      'keeper e2e (linux)',
      'linux-arm64',
      'linux-x64',
      'macos tests',
      'ux tasks',
      'verify',
      'windows tests',
      'windows tests (vitest 1/2)',
      'windows tests (vitest 2/2)',
      'windows-x64',
    ])
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

/*
 * Two tiers of CI (2026-10-18): a pull request runs the quick tier, and a skipped job counts as passed, so a quick run
 * is green on every check it reports. Nothing lands from it: only a run where the full tier's check passed counts.
 */
describe('which tier of CI ran on a commit', () => {
  const TIER = 'full tier'
  const of = (...reported: Check[]) => evaluateChecks({ required: [...REQUIRED, TIER], reported })

  it("is full only when the full tier's check ran and passed, quick when it was skipped, and unknown until it reports", () => {
    expect(ranTier(of(run(TIER, 'success'), ...allPassed()), TIER)).toBe('full')
    expect(ranTier(of(run(TIER, 'skipped'), run('verify', 'success')), TIER)).toBe('quick')
    expect(ranTier(of(run('verify', 'success')), TIER)).toBeNull()
    expect(ranTier(of(run(TIER, null)), TIER)).toBeNull()
    // A commit status of that name is not the job
    expect(ranTier(of({ kind: 'status', name: TIER, state: 'success' }), TIER)).toBeNull()
    // The newest report counts: a full run on the branch after its quick run
    expect(ranTier(of(run(TIER, 'skipped', { at: '2026-10-18T01:00:00Z', id: 1 }), run(TIER, 'success', { at: '2026-10-18T02:00:00Z', id: 2 })), TIER)).toBe('full')
    // Outside the required set (branch protection that does not name it) it still counts
    expect(ranTier(evaluateChecks({ required: REQUIRED, reported: [run(TIER, 'skipped'), ...allPassed()] }), TIER)).toBe('quick')
    // A repository without tiers runs everything every time
    expect(ranTier(of(run('verify', 'success')), null)).toBe('full')
  })

  it('merges nothing that ran only the quick tier, though every check it reports passed', () => {
    const quickRun = of(run(TIER, 'skipped'), ...allPassed())
    expect(quickRun.verdict).toBe('green')
    const d = decideMerge({ permissions: maintainer, pr: { ...openPr, headRefName: 'feat/x' }, checks: quickRun, fullTier: TIER })
    expect(d).toMatchObject({ action: 'refuse', kind: 'quick-tier' })
    expect(d.reason).toContain('gh workflow run build.yml --ref feat/x')
    // Its full tier's jobs not reported yet: still refused, since a quick run never reports them
    expect(decideMerge({ permissions: maintainer, pr: openPr, checks: of(run(TIER, 'skipped'), run('verify', 'success')), fullTier: TIER })).toMatchObject({ action: 'refuse', kind: 'quick-tier' })
    // Green on a required set that does not name it, the check not reported: waits for it
    const unnamed = evaluateChecks({ required: REQUIRED, reported: allPassed() })
    expect(decideMerge({ permissions: maintainer, pr: openPr, checks: unnamed, fullTier: TIER })).toMatchObject({ action: 'wait' })
    expect(decideMerge({ permissions: maintainer, pr: openPr, checks: of(run(TIER, 'success'), ...allPassed()), fullTier: TIER }).action).toBe('merge')
    // Without tiers, as before
    expect(decideMerge({ permissions: maintainer, pr: openPr, checks: unnamed }).action).toBe('merge')
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
  it('quotes the Tauri bundling error ahead of the generic exit-code annotation', () => {
    const error = 'failed to bundle project: error running bundle_dmg.sh: `failed to run /tmp/bundle/dmg/bundle_dmg.sh`'
    const log = ['Bundling Centralu_aarch64.dmg', 'Running bundle_dmg.sh', error, '##[error]Process completed with exit code 1.']
    expect(firstFailure(log.map(stamp).join('\n'))).toEqual({ line: null, error })
  })

  // 2026-10-21 (#1435): the browser install failed on a 403 from a package source; the artifact upload that runs after a
  // failure then said "No files were found", and that was the line quoted as the first failure
  it('quotes the first error line of the step that failed first, not the upload that runs after a failure', () => {
    const log = readFileSync(join(REPO_ROOT, 'tooling/fixtures/ci-log-webkit-install-403.txt'), 'utf8')
    expect(firstFailure(log)).toEqual({
      line: null,
      error: 'E: Failed to fetch https://packages.microsoft.com/ubuntu/24.04/prod/dists/noble/InRelease 403 Forbidden [IP: 13.107.246.40 443]',
    })
    // A step that failed with nothing but its exit code says that, and a later step's error is not quoted instead
    const bare = ['##[group]Run pnpm lint', 'src/a.ts', '##[error]Process completed with exit code 1.', '##[group]Run actions/upload-artifact@x', '##[error]No files were found with the provided path: blob-report.']
    expect(firstFailure(bare.map(stamp).join('\n'))).toEqual({ line: null, error: 'Process completed with exit code 1.' })
    // An action that failed before any command ran: its own error
    expect(firstFailure(['##[group]Run actions/checkout@x', '##[error]fatal: could not read Username'].map(stamp).join('\n'))).toEqual({ line: null, error: 'fatal: could not read Username' })
  })

  // 2026-10-24 (#1507): the runner was shut down under e2e (chromium 1/5) of the release bump; the tests it stopped
  // under were reported failed after the shutdown line, and the first of them was quoted as the failure
  it("never names a test the runner's shutdown cut short: the shutdown is the failure", () => {
    const log = readFileSync(join(REPO_ROOT, 'tooling/fixtures/ci-log-runner-shutdown.txt'), 'utf8')
    const error = 'The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.'
    expect(firstFailure(log)).toEqual({ line: null, error })
    expect(cleanLog(log).join('\n')).not.toContain('archive.spec.ts:281')
    // A test that failed before the shutdown is still the first failure
    const before = ['  ✘   3 [app] › e2e/a.spec.ts:5:1 › opens (1.0s)', ...cleanLog(log).slice(-4)].join('\n')
    expect(firstFailure(before).line).toContain('e2e/a.spec.ts:5:1')
  })

  // Only the runner's own line cuts: a test that prints the same words (reading the fixture above, say) and then really fails
  // keeps its failure and its quote
  it("cuts a log only at the runner's own shutdown line, followed by its cancellation; the same words in a test's output cut nothing", () => {
    const said = '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.'
    const tail = [' FAIL  unit  packages/a/a.test.ts > prints a log > is read', 'AssertionError: expected 1 to be 2', '##[error]Process completed with exit code 1.']
    const logOf = (...lines: string[]) => lines.map(stamp).join('\n')
    const whole = (log: string) => cleanLog(log).length === log.split('\n').length
    for (const printed of [`    ${said}`, `+ ${said}`, `  at ${said}`]) {
      const log = logOf('##[group]Run pnpm test', printed, ...tail)
      expect(whole(log), printed).toBe(true)
      expect(firstFailure(log).line, printed).toContain('packages/a/a.test.ts')
    }
    // At the start of a line, as a test that logs it prints it, but the step was not cancelled: it failed on its own
    const bare = logOf('##[group]Run pnpm test', said, ...tail)
    expect(whole(bare)).toBe(true)
    expect(firstFailure(bare).line).toContain('packages/a/a.test.ts')
    // Another case, or another words, is not the runner's
    expect(whole(logOf('##[group]Run pnpm test', said.replace('The runner', 'the runner'), ...tail, '##[error]The operation was canceled.'))).toBe(true)
    // The runner's own line cuts at the last one before the cancellation, whatever a test printed at the start of a line earlier
    const both = logOf('##[group]Run pnpm e2e', said, '  ✓   1 [app] › e2e/a.spec.ts:5:1 › opens (1.0s)', said, '  ✘   2 [app] › e2e/a.spec.ts:9:1 › closes (1.0s)', '##[error]The operation was canceled.')
    expect(cleanLog(both)).toHaveLength(4)
    expect(cleanLog(both).at(-1)).toBe(said)
  })

  it('gives every line of the step that failed first, warnings included, and nothing of the steps after it', () => {
    const log = ['##[group]Run pnpm install', 'W: Could not connect to a mirror', 'E: Unable to locate package x', '##[error]Process completed with exit code 1.', '##[group]Run actions/upload-artifact@x', '##[error]No files were found'].map(stamp).join('\n')
    expect(failingStepText(log)).toBe(['##[group]Run pnpm install', 'W: Could not connect to a mirror', 'E: Unable to locate package x', '##[error]Process completed with exit code 1.'].join('\n'))
    expect(failingStepText('nothing failed here')).toBe('')
  })

  it('keeps a bundling error that follows a failed test marker', () => {
    const error = 'failed to bundle project: error running bundle_dmg.sh'
    expect(firstFailure(['FAIL bundle smoke', error].map(stamp).join('\n'))).toEqual({ line: 'FAIL bundle smoke', error })
  })

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

/** How the fake gh answers (fake-gh.test-helpers.ts gives it args, stdin, st and save, and logs each call) */
const FAKE_GH = String.raw`
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
} else if (args[0] === 'pr' && args[1] === 'ready') {
  st.readied = [...(st.readied ?? []), args[2]]
  st.pr.isDraft = false
  save()
} else if (path === R + '/issues/77/comments' && args.includes('POST')) {
  const body = JSON.parse(stdin).body
  st.comments = [...(st.comments ?? []), body]
  save()
  out({ id: 5, node_id: 'IC_5', html_url: 'https://github.com/ijun17/centralu/pull/77#issuecomment-5', user: { login: 'contributor' }, created_at: '2026-10-17T10:00:00Z', body })
} else if (args[0] === 'issue' && args[1] === 'view') {
  out({ body: st.issue, comments: [], state: 'OPEN' })
} else if (path === R) {
  out({ permissions: st.permissions, default_branch: 'main' })
} else if (path === R + '/branches/main/protection/required_status_checks') {
  fail('Branch not protected (HTTP 404)')
} else if (path === R + '/rules/branches/main') {
  out([])
} else if (path && path.startsWith(R + '/contents/.github/workflows/build.yml')) {
  // The base branch's workflow, or the pull request head's when the state gives one
  const text = path.endsWith('?ref=main') ? st.workflow : (st.headWorkflow ?? st.workflow)
  if (!text) fail('Not Found (HTTP 404)')
  out(text)
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
// A full run: the full tier's check passed (project.json ci.fullTier, build.yml's `full tier` job)
const green = () => [ghRun('full tier', 'success', 10), ghRun('verify', 'success', 11), ghRun('windows tests', 'success', 12), ghRun('linux-x64', 'success', 13), ghRun('notify', 'success', 14)]
// A pull request's quick run: what it ran passed, the full tier's check skipped, the full tier's jobs not reported
const quick = () => [ghRun('full tier', 'skipped', 10), ghRun('verify', 'success', 11)]
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
let gh: FakeGh

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-project-board-ci-')))
  mkdirSync(join(root, 'data'))
  gh = fakeGh(root, FAKE_GH)
})

// Waiting for the app trees can take a while on a loaded Windows machine: grace, kill, the process listing and
// a taskkill per leftover, past the default 10 s hook limit (#1312)
afterEach(async () => {
  // Until the app and what it left running have ended: they run Node from this folder and write in it
  await rt?.dispose({ awaitTree: true })
  rt = null
  await removeFakeDir(root)
}, 30_000 * SLOW)

// A gh that the app was starting when the test ended its tree stays suspended on Windows, for ever (fake-gh.test-helpers.ts)
afterAll(() => {
  endLeftoverFakes()
}, 60_000 * SLOW)

function runtime(state: Record<string, unknown>) {
  gh.setState(state)
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: gh.env({}),
    // The product's probe and call limits: a shorter one only adds a way to fail under load (#368)
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

async function call(name: string, args: Record<string, unknown>, progress?: string[]) {
  const out = await rt!.call(ref, name, args, agent, progress ? { onProgress: (m) => progress.push(m) } : {})
  if (!out.result) throw new Error(`${name} did not answer: ${out.status} ${out.error}`)
  return { text: resultText(out.result), isError: out.result.isError === true, data: out.result.structuredContent as Record<string, unknown> }
}
const ghCalls = () => gh.calls().map((c) => c.args)
const merges = () => gh.state<{ merges?: string[][] }>().merges ?? []

describe('the project board app: ci_status and merge_when_green', { timeout: 30_000 * SLOW }, () => {
  it('passes check with ci_status as a read and merge_when_green as a change, both for agents only', async () => {
    const r = await runtime(ghState()).check(ref)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.text).toContain('ci_status — reads, model')
    expect(r.text).toContain('merge_when_green — changes, model')
    expect(r.text).toContain('mark_ready — changes, model')
  })

  it('reports the required checks of a pull request compactly, with the first failing test and the known flake it matches', async () => {
    runtime(ghState({ checkRuns: [[ghRun('verify', 'success', 11), ghRun('windows tests', 'failure', 12), ghRun('notify', 'success', 14)]] }))
    const r = await call('ci_status', { pr: 77 })
    expect(r.isError).toBe(false)
    expect(r.text).toBe(
      [
        'PR #77 at c0ffee0: failing — 1/3 passed, 1 failed, 1 not reported yet.',
        'windows tests: failed',
        'linux-x64: not reported yet',
        'Failures:',
        "windows tests (job 12): FAIL app-runtime packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected — its entire group is ended | Error: EBUSY: resource busy or locked, rmdir 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cc-apps-life-Zx81Qa\\proj\\.centralu\\apps\\parent' | known intermittent failure? #368 quotes \"packages/agent-host/src/apps/external/lifecycle.test.ts > the shutdown rule (S-5) > even a descendant left by an app that ended cleanly on its own is collected…\"",
      ].join('\n'),
    )
    expect(r.data.verdict).toBe('failing')
    // Read-only: nothing merged, nothing deleted
    expect(ghCalls().filter((a) => a[1] === 'merge' || a.includes('DELETE'))).toEqual([])
  })

  it('keeps green checks to one short line unless detail is full', async () => {
    runtime(ghState())
    const short = await call('ci_status', { pr: 77 })
    expect(short.text.split('\n')).toHaveLength(1)
    expect(short.text).toBe('PR #77 at c0ffee0: green — 3/3 passed.')
    expect(short.data.checks).toEqual([])
    const full = await call('ci_status', { pr: 77, detail: 'full' })
    expect(full.text).toContain('Passed: verify, windows tests, linux-x64.')
    expect(full.text).toContain('Required: build.yml on main.')
    expect(full.text).toContain('Not required: full tier passed, notify passed.')
  })

  it('finds the Windows Vitest failure and its diff beyond setup-node noise (#587)', async () => {
    const recorded = JSON.parse(readFileSync(new URL('./fixtures/project-board/windows-vitest.json', import.meta.url), 'utf8'))
    runtime(ghState({ logs: { '12': recorded.lines.join('\r\n') } }))
    const r = await call('read_failed_job', { job: 12 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('FAIL unit packages/agent-host/src/adapters/codex/sandbox.test.ts')
    expect(r.text).toContain('safe start: includes the common git dir and network only for auto')
    expect(r.text).toContain('AssertionError: expected')
    expect(r.text).toContain('- Expected')
    expect(r.text).toContain('+ Received')
    expect(r.text).toContain('RUNNER~1')
    expect(r.text).toContain('runneradmin')
    expect(r.text).not.toContain('setup-node')
    expect(r.text).not.toContain('2026-10-12T')
    expect(r.text).not.toContain('\u001b')
    expect((r.data.log as string[]).length).toBeLessThanOrEqual(40)
  })

  it.each([
    { runner: 'Playwright', progress: '  ✘  1 [chromium] › example.spec.ts:5:1 › opens the dialog',
      detail: ['  1) [chromium] › example.spec.ts:5:1 › opens the dialog', '    Error: locator was not visible', '    Expected: visible', '    Received: hidden'] },
    { runner: 'Cargo', progress: 'test module::opens_dialog ... FAILED',
      detail: ['---- module::opens_dialog stdout ----', "thread 'module::opens_dialog' panicked at src/lib.rs:4:5:", 'assertion failed: visible', 'left: false', 'right: true'] },
    { runner: 'Cargo panic without a stdout header', progress: 'test module::opens_dialog ... FAILED',
      detail: ["thread 'module::opens_dialog' (42) panicked at src/lib.rs:4:5:", 'assertion failed: visible', 'left: false', 'right: true'] },
  ])('reads the $runner detail instead of distant progress output', async ({ progress, detail }) => {
    const log = [progress, ...Array.from({ length: 60 }, () => 'passing test'), ...detail]
    runtime(ghState({ logs: { '12': log.map(stamp).join('\n') } }))
    const r = await call('read_failed_job', { job: 12 })
    for (const line of detail) expect(r.text).toContain(line.trim())
    expect(r.text).not.toContain(progress.trim())
    expect(r.data.startLine).toBe(54)
  })

  it('reads only the useful part of a failed job log', async () => {
    const prefix = Array.from({ length: 60 }, () => stamp('setup noise')).join('\n')
    const suffix = Array.from({ length: 60 }, () => stamp('cleanup noise')).join('\n')
    runtime(ghState({ logs: { '12': [prefix, VITEST_LOG, suffix].join('\n') } }))
    const r = await call('read_failed_job', { job: 12 })
    expect(r.isError).toBe(false)
    expect(r.data.startLine).toBe(58)
    expect(r.data.log).toHaveLength(40)
    expect(r.text).toContain('FAIL app-runtime packages/agent-host/src/apps/external/lifecycle.test.ts')
    expect(r.text).toContain('Error: EBUSY:')
    expect(r.text).not.toContain('\u001b')
    expect(r.text).not.toContain('2026-10-05T')
    expect(r.text).not.toContain('undefined')
  })

  it('finds the Tauri bundle failure after misleading setup output', async () => {
    const error = 'failed to bundle project: error running bundle_dmg.sh: `failed to run /tmp/bundle/dmg/bundle_dmg.sh`'
    const log = ['Downloading error-chain', ...Array.from({ length: 60 }, () => 'setup noise'), error, '##[error]Process completed with exit code 1.']
    runtime(ghState({ logs: { '12': log.map(stamp).join('\n') } }))
    const r = await call('read_failed_job', { job: 12 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain(error)
    expect(r.text).toContain('failure near line 62')
    expect(r.text).not.toContain('Downloading error-chain')
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
    expect(r.text.split('\n')[0]).toBe('Not merged yet: No checks are reported for its head commit yet, and no checks is not green. Call again later (queue_merge merges once green).')
    expect(merges()).toEqual([])
  })

  it('does not merge while no checks are reported even with no required set to go on', async () => {
    // No branch protection and no workflow file: every reported check counts, and none is not green
    runtime(ghState({ workflow: null, checkRuns: [[]] }))
    const bare = await call('merge_when_green', { pr: 77 })
    expect(bare.data.outcome).toBe('pending')
    expect(bare.text.split('\n')[0]).toBe('Not merged yet: No checks are reported for its head commit yet, and no checks is not green. Call again later (queue_merge merges once green).')
    expect(merges()).toEqual([])
  })

  it('refuses a failing pull request with the failure, and merges nothing', async () => {
    runtime(ghState({ checkRuns: [[ghRun('verify', 'success', 11), ghRun('windows tests', 'failure', 12), ghRun('linux-x64', null, 13)]] }))
    const r = await call('merge_when_green', { pr: 77 })
    expect(r.isError).toBe(true)
    expect(r.data.outcome).toBe('refused')
    expect(r.text.split('\n')[0]).toBe('Not merged: A required check failed.')
    expect(r.text).toContain('windows tests (job 12): FAIL app-runtime packages/agent-host/src/apps/external/lifecycle.test.ts')
    expect(merges()).toEqual([])
  })

  it('counts a job the pull request itself adds as required, so its failure blocks the merge (#445)', async () => {
    // #445 added a "content verify" job; read from main only, it was "not required" for that very pull request
    const headWorkflow = WORKFLOW + ['  content:', '    name: content verify', ''].join('\n')
    runtime(ghState({ headWorkflow, checkRuns: [[...green(), ghRun('content verify', 'failure', 15)]] }))
    const status = await call('ci_status', { pr: 77 })
    expect(status.data.verdict).toBe('failing')
    expect(status.text).toContain('plus 1 job the pull request adds')
    const r = await call('merge_when_green', { pr: 77 })
    expect(r.isError).toBe(true)
    expect(r.text.split('\n')[0]).toBe('Not merged: A required check failed.')
    expect(merges()).toEqual([])
  })

  it('merges nothing whose own run was the quick tier, and says how it lands', async () => {
    runtime(ghState({ checkRuns: [quick()] }))
    const r = await call('merge_when_green', { pr: 77 })
    expect(r.isError).toBe(true)
    expect(r.data).toMatchObject({ outcome: 'refused', kind: 'quick-tier' })
    const first = r.text.split('\n')[0]
    expect(first).toContain('ran only the quick tier of CI')
    expect(first).toContain('queue_merge')
    expect(merges()).toEqual([])
  })

  it('cannot make a check optional by removing its job in the pull request', async () => {
    const headWorkflow = ['jobs:', '  verify:', '    name: verify', ''].join('\n')
    runtime(ghState({ headWorkflow, checkRuns: [[ghRun('verify', 'success', 11), ghRun('windows tests', 'failure', 12), ghRun('linux-x64', 'success', 13)]] }))
    const r = await call('merge_when_green', { pr: 77 })
    expect(r.text.split('\n')[0]).toBe('Not merged: A required check failed.')
    expect(merges()).toEqual([])
  })

  it('answers pending at once while checks run, and squash-merges once with a clean message when green', async () => {
    const running = [ghRun('verify', 'success', 11), ghRun('windows tests', null, 12), ghRun('linux-x64', 'success', 13)]
    runtime(ghState({ checkRuns: [running, green()] }))
    const pending = await call('merge_when_green', { pr: '#77' })
    expect(pending.data.outcome).toBe('pending')
    expect(merges()).toEqual([])
    const r = await call('merge_when_green', { pr: '#77' })
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ outcome: 'merged', merged: true, commit: 'abcdef1234567890', subject: 'feat(apps): merge when green (#77)' })
    expect(r.text.split('\n')[0]).toBe('Merged PR #77 (squash) as abcdef1: "feat(apps): merge when green (#77)".')
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
    // Remote only (#715): `gh pr merge --delete-branch` also removes the local branch, and the worktree that holds it
    expect(ghCalls().flat()).not.toContain('--delete-branch')
    expect(ghCalls().flat()).not.toContain('-d')

    await rt!.dispose({ awaitTree: true })
    gh.clearCalls()
    const fork = ghState()
    fork.pr = { ...fork.pr, isCrossRepository: true }
    runtime(fork)
    const f = await call('merge_when_green', { pr: 77, deleteBranch: true })
    expect(f.text.split('\n')[0]).toContain('Branch feat/merge-when-green not deleted: it is in a fork.')
    expect(ghCalls().filter((a) => a.includes('DELETE'))).toEqual([])
  })

  it('reports a merge GitHub refused', async () => {
    runtime(ghState({ mergeError: 'Pull request is not mergeable: the base branch policy prohibits the merge.' }))
    const refused = await call('merge_when_green', { pr: 77 })
    expect(refused.isError).toBe(true)
    expect(refused.text.split('\n')[0]).toBe('Not merged: GitHub refused the merge: Pull request is not mergeable: the base branch policy prohibits the merge.')
  })
})

describe('failure excerpt fallbacks', () => {
  it.each(['× failing test', '✗ failing test', 'AssertionError: mismatch', 'Error: build failed', '##[error]process failed'])(
    'ignores setup prose before %s', (marker) => {
      expect(failureLineIndex(['fail-on-cache-miss: false', 'retry on error', marker, 'later'])).toBe(2)
    },
  )
  it('reports no marker for setup alone', () => {
    expect(failureLineIndex(['fail-on-cache-miss: false', 'retry on error'])).toBe(-1)
  })
})

describe('failure excerpts across runners', () => {
  const summaries = ['FAIL unit example.test.ts > fails', '  1) [chromium] › example.spec.ts:5:1 › fails', '---- example::fails stdout ----', "thread 'example::fails' panicked at src/lib.rs:4:5:", 'src/main.ts(1,1): error TS1234: bad type', '  1:2 error bad lint', 'failed to bundle project: error running bundle_dmg.sh']
  it.each(summaries)('takes %s when it is the first detailed failure in log order', (first) => {
    expect(failureLineIndex(['setup', first, ...summaries.filter((line) => line !== first)])).toBe(1)
  })
})

describe('release CI event audit', () => {
  it('finds no event-dependent jobs in the release CI workflow', () => {
    const jobs = workflowEventJobs(readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8'))
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.every((j: { reason: string | null }) => j.reason === null)).toBe(true)
  })

  it.each(["    if: github.event_name == 'push'", '    steps:\n      - run: |\n          if [ "$GITHUB_EVENT_NAME" = push ]; then echo check; fi', '    env:\n      BRANCH: ${{ github.ref }}'])('requires main for event-dependent job content: %s', (body) => {
    expect(workflowEventJobs(`on:\n  push:\n  pull_request:\njobs:\n  verify:\n${body}\n`)).toEqual([
      { names: ['verify'], unresolved: [], reason: 'uses event or branch context' },
    ])
  })
})


it('documents that called scripts need manual event review in both release guides', () => {
  const workflow = 'on:\n  push:\n  pull_request:\njobs:\n  verify:\n    steps:\n      - run: node scripts/check.mjs\n'
  expect(workflowEventJobs(workflow)[0].reason).toBeNull()
  for (const file of ['docs/releasing.md', 'docs/releasing.ko.md']) {
    const doc = readFileSync(join(REPO_ROOT, file), 'utf8')
    expect(doc).toContain('The automated event audit does not follow scripts called by workflow steps')
    expect(doc).toContain('Those need manual\nreview for event-dependent behavior')
  }
})


it('keeps release bump builds out of the concurrency group cancelled by ordinary main pushes', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8')
  const template = /^ {2}group: (.+)$/m.exec(workflow)![1]!
  const group = (message: string, sha: string, event = 'push', ref = 'refs/heads/main') => template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => String(runInNewContext(expression, {
    github: { ref, sha, event_name: event, event: { head_commit: { message } } },
    startsWith: (text: string, prefix: string) => text.startsWith(prefix),
    format: (text: string, value: string) => text.replace('{0}', value),
  })))
  expect(group('fix(ui): one', 'a')).toBe(group('fix(ui): two', 'b'))
  expect(group('chore(release): next (#900)', 'a')).not.toBe(group('fix(ui): two', 'b'))
  expect(group('chore(release): next (#900)', 'a')).not.toBe(group('chore(release): later (#901)', 'b'))
  expect(group('chore(release): next', 'a', 'pull_request', 'refs/pull/900/merge')).toBe(group('chore(release): next', 'b', 'pull_request', 'refs/pull/900/merge'))
})

/**
 * #386, merge policy (owner, 2026-10-05): merging is the maintainer's act, and "for a contributor,
 * the end of the flow is mark_ready". merge_when_green and queue_merge refuse without maintain or
 * admin and told the agent to mark the PR ready, but no tool did it, so agents typed gh pr ready.
 */
describe('the project board app: mark_ready', { timeout: 30_000 * SLOW }, () => {
  const state = (patch: Record<string, unknown> = {}) => {
    const s = ghState({ permissions: { push: true }, ...patch })
    ;(s.pr as Record<string, unknown>).isDraft = true
    return s
  }
  const written = () => gh.state<{ readied?: string[]; comments?: string[] }>()

  it('marks a draft ready for review for a contributor once nothing required failed, and says the maintainer merges', async () => {
    runtime(state())
    const r = await call('mark_ready', { pr: 77 })
    expect(r.isError).toBe(false)
    expect(r.text.split('\n')[0]).toBe('Marked PR #77 ready for review. The maintainer merges it (merge_when_green or queue_merge).')
    expect(r.data).toMatchObject({ ready: true, marked: true, verdict: 'green' })
    expect(written().readied).toEqual(['77'])
    expect(written().comments).toBeUndefined()
    // Ready already: nothing to change, and it says so
    const again = await call('mark_ready', { pr: 77 })
    expect(again.text.split('\n')[0]).toBe('PR #77 was ready for review already. The maintainer merges it (merge_when_green or queue_merge).')
    expect(written().readied).toEqual(['77'])
  })

  it('refuses while a required check failed, naming it, and changes nothing', async () => {
    runtime(state({ checkRuns: [[ghRun('verify', 'success', 11), ghRun('windows tests', 'failure', 12), ghRun('linux-x64', 'success', 13)]] }))
    const r = await call('mark_ready', { pr: 77 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Not marked ready: a required check failed.')
    expect(r.text).toContain('windows tests: failed')
    expect(written().readied).toBeUndefined()
  })

  it('leaves the note for the maintainer with the CI line, while checks still run; a note that breaks the public text rules stops it first', async () => {
    runtime(state({ checkRuns: [[ghRun('verify', null, 11), ghRun('windows tests', 'success', 12), ghRun('linux-x64', 'success', 13)]] }))
    const bad = await call('mark_ready', { pr: 77, note: '리뷰 부탁드립니다' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/^Not marked ready: The note /)
    expect(written().readied).toBeUndefined()
    const r = await call('mark_ready', { pr: 77, note: 'Ready: the Windows path is not exercised.' })
    expect(r.isError).toBe(false)
    expect(r.text.split('\n')[0]).toBe('Marked PR #77 ready for review, and left the note. CI is pending, not green yet; it goes on meanwhile. The maintainer merges it (merge_when_green or queue_merge).')
    expect(written().comments).toEqual(['Ready: the Windows path is not exercised.\n\nPR #77 at c0ffee0: pending — 2/3 passed, 1 pending.'])
  })
})
