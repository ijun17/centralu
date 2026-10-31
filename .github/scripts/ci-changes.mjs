// Which of build.yml's jobs a commit needs: its tier, then the files it changes (2026-10-17, tiers 2026-10-18).
//
// About 25 jobs run per push and the free plan runs about 20 at once, so runs queue one behind
// another. Two tiers (the owner's decision of 2026-10-18):
//
//   quick   a pull request: `changes`, `verify`, the Windows unit tests and the macOS tests, the jobs that catch most
//           problems cheaply. Every other job is left out, and reports nothing.
//   full    everything else: a commit already on main, a manual run (workflow_dispatch: a person
//           asking for it on a branch, or the main guard's bisect). Inside the full tier the files still leave out what they cannot affect.
//           A manual run that asks for the quick tier (input `tier: quick`) runs the quick tier
//           instead (#1259): the merge queue's batches, unless it is on main.
//   none    a draft pull request (#1066): `changes` alone. A stack's lower PRs are drafts
//           (CONTRIBUTING.md): the top's run, and the merge queue's batch, are what prove the
//           stack, and a lower's own run only queued behind them. Marked ready for review (a lower
//           that became a top), it runs the quick tier again.
//
// What lands on what (#1259, the owner's decision of 2026-10-19): the merge queue lands a pull request
// after the fast tier, its own quick run and its batch's quick run on what lands
// (.centralu/apps/project-board/batch.mjs, project.json `ci.landTier`); the full tier runs on main after
// it lands, and a red main is bisected and reverted (the board's main guard). The full tier's `full tier`
// job is how the two are told apart: it passes only on a full run.
//
// Inside the full tier, this answers on $GITHUB_OUTPUT what each group of jobs reads:
//
//   bundle      the product's sources (anything but documents and tests): the four bundles
//   host        the product's sources outside the window (packages/ui, core, platform, apps/web), and
//               the few test inputs the keeper's Rust tests read (HOST_TEST_INPUTS): the keeper end to
//               end, macOS and Linux, and the content verifier. The host shares only protocol with the
//               window (docs/architecture.md §2), and none of them read any other test
//   host_tests  anything but documents outside the window and e2e/: the host's tests on the Node
//               remotes run (packages/agent-host, packages/protocol, tooling/launcher-)
//   code        anything but documents: the UI scenarios in Chromium and the UX tasks
//
// Each is `true` or `false` on a full run (`false` runs the job's stand-in, which reports its checks
// as passed), and `off` on a quick one (neither runs). `fail_fast` (2026-10-19, the owner's decision) is `true` on a
// manual run alone, the merge queue's batches: there a failed `verify` cancels the rest of the run (build.yml's
// `fail fast` job), since no other job can make that run land. `false` on every other run, and on a manual run that is on main, or
// whose files are not known. `full` is `true` on a full run: the jobs every
// full run has (the WebKit UI scenarios, the Windows lint and types, the `full tier` job), and `off`
// on a quick one. `quick` is `true` on both: `verify`, the Windows unit tests and the macOS tests; `off`, with every
// other answer, for a draft.
//
// Which files: everything a commit adds to main. A commit already on main (a push to main, every
// commit of a rebase merge) runs everything: per-commit filtering, with newer pushes cancelling
// older runs, could leave main green without a bundle ever built for a host change. Any other
// commit (a pull request's merge commit, a batch, a branch) is compared with its merge-base with
// main, whatever the pull request's base branch is: a pull request stacked on another one is judged
// by the whole stack, since the merge queue lands a stack on the top pull request's checks alone.
// Renames count as a deletion and an addition (--no-renames), so moving a host file into docs/ is a
// host change.
//
// One fact comes from the event, and only after everything else is decided: whether a pull request is
// a draft (`pull_request.draft` in $GITHUB_EVENT_PATH). Whether a commit is on main is a fact of the
// history, and a manual run is the one with the `everything` input set. When main or the merge-base is not in the checkout, everything runs.
//
// Local check: node .github/scripts/ci-changes.mjs   (prints the answer; GITHUB_OUTPUT unset)

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Documents: read by people and by `verify`'s tests, never built into anything */
const DOCS = [/^docs\//, /^[^/]+\.md$/, /^\.github\/ISSUE_TEMPLATE\//, /^\.github\/PULL_REQUEST_TEMPLATE\.md$/]
/** Tests and what only tests run: no bundle includes them */
const TESTS = [/\.test\.(ts|tsx|mts|mjs)$/, /\.test-helpers\.(ts|mts)$/, /^e2e\//, /^tooling\//, /^vitest\.config\.ts$/]
/**
 * Tests' inputs outside the product that the host jobs' tests read: the keeper's Rust tests take them in with
 * `include_str!`, and only the keeper jobs run those. So a change to one alone runs the host jobs (and the host's
 * tests, which read them too), though no bundle carries it.
 */
const HOST_TEST_INPUTS = [/^tooling\/fixtures\/node-floor\.json$/]
/** The window: what the host, the keeper and the content verifier never load */
const WINDOW = [/^packages\/(ui|core|platform)\//, /^apps\/web\//]
/** The product the UI scenarios start and speak to besides the window: the host and the protocol between them */
const HOST_PRODUCT = [/^packages\/(agent-host|protocol)\//]
/**
 * What the UI scenarios render or read from outside the window and the host (2026-10-26, #1538, found by walking what
 * `e2e/` and `apps/web` import or name; tooling/build-workflow.test.ts walks it again, so a new such file that is not
 * listed here or above fails there): the desktop shell's TypeScript that the harness pages mount (`apps/desktop/src`),
 * the two shell files the scenarios read as text, the project board's screen and its bundled runtime that fixtures
 * serve in a real frame, the script that runs every dev server (`.centralu/tiers.json`, e2e-harness, counts it), and
 * the one test helper a scenario's second host runs (`e2e/fixtures/linked-host-main.ts`), a test file that is
 * still part of what the scenarios exercise.
 */
const SCREEN_INPUTS = [
  /^packages\/agent-host\/src\/links\/scripted-agent\.test-helpers\.ts$/,
  /^apps\/desktop\/src\//,
  /^apps\/desktop\/src-tauri\/(tauri\.conf\.json|src\/traffic_lights\.rs)$/,
  /^\.centralu\/apps\/project-board\/(ui\/|runtime\/mcp-app\.js$)/,
  /^scripts\/e2e-web-server\.mjs$/,
]
/** What the builds, the type checker or CI itself read, wherever it sits: a change to one runs everything */
const EVERYTHING = [
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)package\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /(^|\/)vite\.config\.[cm]?[jt]s$/,
  /^\.github\/(workflows|scripts|actions)\//,
]
const matches = (patterns, file) => patterns.some((p) => p.test(file))
const ALL = { bundle: true, host: true, host_tests: true, code: true }
/** The groups a file list answers; the order of the outputs. */
const GROUPS = Object.keys(ALL)

/** What a list of changed files needs. `null` (the files are not known) needs everything. */
export function classify(files) {
  if (files === null || files.some((f) => matches(EVERYTHING, f))) return { ...ALL }
  const nonDocs = files.filter((f) => !matches(DOCS, f))
  const product = nonDocs.filter((f) => !matches(TESTS, f))
  return {
    bundle: product.length > 0,
    host: product.some((f) => !matches(WINDOW, f)) || nonDocs.some((f) => matches(HOST_TEST_INPUTS, f)),
    host_tests: nonDocs.some((f) => !matches(WINDOW, f) && !f.startsWith('e2e/')),
    code: nonDocs.length > 0,
  }
}

/**
 * The files of a change that can alter what the UI scenarios (e2e, both browsers) see (2026-10-26, #1538): the part of
 * `code` that is behaviour. The window and the host and protocol it talks to, outside their tests, and what the
 * scenarios otherwise render or read (`SCREEN_INPUTS`); the scenarios and
 * their fixtures (`e2e/`) themselves; and whatever makes `classify` run everything (the builds, the lockfile, CI
 * itself). Not documents, and not a unit test or a tool's own tests (`tooling/`): those are in `code`, but no
 * scenario can see them. `null` when the files are not known.
 *
 * This is the one definition of "a change to the screen". The merge queue does not keep a path list of its own: it
 * asks this function, read from the default branch (`node .github/scripts/ci-changes.mjs --screen`, the files as a JSON
 * list on stdin), when it decides how far a batch is tested before it lands (project.json `ci.screen`). A test holds
 * it inside `code`: a change that reaches the screen is always one the UI scenarios run for.
 */
export function screenFiles(files) {
  if (files === null) return null
  return files.filter((f) => !matches(DOCS, f) && (matches(EVERYTHING, f) || f.startsWith('e2e/') || matches(SCREEN_INPUTS, f) || (!matches(TESTS, f) && (matches(WINDOW, f) || matches(HOST_PRODUCT, f)))))
}

/** Whether a change reaches the screen (see `screenFiles`); files that are not known are taken to. */
export const screenChanged = (files) => screenFiles(files)?.length !== 0

/**
 * The tier of a run (see the header), with why. `onMain`: HEAD is already on main. `dispatch`: a
 * manual run (the workflow_dispatch input `everything` is set, true or false). `files`: what HEAD adds
 * to main, or null when that is not known. `draft`: the run is a draft pull request's, which is
 * asked last.
 */
export function tierOf({ files, onMain = false, dispatch = false, dispatchTier = 'full', draft = false }) {
  if (onMain) return { tier: 'full', why: 'the commit is on main' }
  // A manual run that asks for the quick tier (#1259): the merge queue's batch
  if (dispatch && dispatchTier === 'quick' && files !== null) {
    return { tier: 'quick', why: 'a manual run that asked for the quick tier, as the merge queue starts for a batch' }
  }
  if (dispatch) return { tier: 'full', why: 'a manual run (workflow_dispatch)' }
  if (files === null) return { tier: 'full', why: 'the changed files are not known' }
  if (draft) return { tier: 'none', why: "a draft pull request, as a stack's lower PRs are: nothing runs until it is marked ready for review" }
  return { tier: 'quick', why: 'a pull request: the full tier runs in the merge queue' }
}

/** The answers build.yml's jobs read, as strings: see the header. */
export function outputs(tier, needs) {
  const full = tier === 'full'
  return { quick: tier === 'none' ? 'off' : 'true', full: full ? 'true' : 'off', ...Object.fromEntries(GROUPS.map((g) => [g, full ? String(needs[g]) : 'off'])) }
}

/**
 * Whether a failed `verify` cancels the rest of the run (see the header): a manual run (`dispatch`) off main whose
 * files are known. Everything else keeps every job running to its end.
 */
export function failFastOf({ files, onMain = false, dispatch = false }) {
  return dispatch && !onMain && files !== null
}

/** Whether the event that started the run is a draft pull request's ($GITHUB_EVENT_PATH). Unreadable: not a draft. */
export function draftOf(eventPath) {
  if (!eventPath) return false
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'))?.pull_request?.draft === true
  } catch {
    return false
  }
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * The files HEAD adds to `main` (see the header), with why. `files` is null when everything should run: HEAD is
 * already on main (`onMain`), or main or the merge-base is not in this checkout.
 */
export function changedFiles(cwd = process.cwd(), main = 'origin/main') {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `${main}^{commit}`])
  } catch {
    return { files: null, why: `${main} is not in this checkout` }
  }
  try {
    git(cwd, ['merge-base', '--is-ancestor', 'HEAD', main])
    return { files: null, onMain: true, why: `HEAD is on ${main}` }
  } catch {
    // Not on main: compared with where it left main
  }
  let base
  try {
    base = git(cwd, ['merge-base', 'HEAD', main]).trim()
  } catch {
    return { files: null, why: `HEAD shares no history with ${main} here` }
  }
  const out = git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'])
  return { files: out.split('\0').filter(Boolean), why: `against its merge-base with ${main}, ${base.slice(0, 12)}` }
}

/** `--screen`: the merge queue's question (see `screenFiles`). Reads a JSON list of file names on stdin, answers `{ screen, file, count }`. */
function screenMain() {
  const files = JSON.parse(readFileSync(0, 'utf8'))
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) throw new Error('a JSON list of file names was expected on stdin')
  const hits = screenFiles(files)
  console.log(JSON.stringify({ screen: hits.length > 0, file: hits[0] ?? null, count: files.length }))
}

function main() {
  if (process.argv.includes('--screen')) return screenMain()
  // A manual run sets the workflow_dispatch input; a push or a pull request leaves it empty
  const dispatch = process.env.EVERYTHING === 'true' || process.env.EVERYTHING === 'false'
  const changed = changedFiles()
  // The tier a manual run asks for (input `tier`, empty elsewhere): `quick` for the merge queue's batches (#1259)
  const dispatchTier = process.env.DISPATCH_TIER === 'quick' ? 'quick' : 'full'
  const { tier, why } = tierOf({ files: changed.files, onMain: changed.onMain === true, dispatch, dispatchTier, draft: !dispatch && draftOf(process.env.GITHUB_EVENT_PATH) })
  // A manual run builds everything unless it asks otherwise (`everything` unticked)
  const files = process.env.EVERYTHING === 'true' ? null : changed.files
  const failFast = failFastOf({ files: changed.files, onMain: changed.onMain === true, dispatch })
  const lines = [...Object.entries(outputs(tier, classify(files))).map(([k, v]) => `${k}=${v}`), `fail_fast=${failFast}`]
  console.log(`The ${tier} tier: ${why}.`)
  if (failFast) console.log('A failed verify cancels the rest of this run (a manual run).')
  if (tier === 'full') console.log(files === null ? `Every job runs: ${process.env.EVERYTHING === 'true' ? 'a manual run asked for everything' : changed.why}.` : `${files.length} changed file(s), ${changed.why}:\n${files.map((f) => `  ${f}`).join('\n')}`)
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
