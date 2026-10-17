// Which of build.yml's jobs a commit needs: its tier, then the files it changes (2026-10-17, tiers 2026-10-18).
//
// About 25 jobs run per push and the free plan runs about 20 at once, so runs queue one behind
// another. Two tiers (the owner's decision of 2026-10-18):
//
//   quick   a pull request: `changes`, `verify` and the Windows unit tests, the jobs that catch most
//           problems cheaply. Every other job is left out, and reports nothing.
//   full    everything else: a commit already on main, a manual run (workflow_dispatch: the merge
//           queue's batches, or a person asking for it on a branch), and a release bump's pull
//           request. Inside the full tier the files still leave out what they cannot affect.
//   none    a draft pull request (#1066): `changes` alone. A stack's lower PRs are drafts
//           (CONTRIBUTING.md): the top's run, and the merge queue's batch, are what prove the
//           stack, and a lower's own run only queued behind them. Marked ready for review (a lower
//           that became a top), it runs the quick tier again.
//
// Nothing lands on the quick tier alone: the merge queue lands a pull request only from a full run
// on what lands, a batch built on main (.centralu/apps/project-board/batch.mjs) or a full run on its
// own head. The full tier's `full tier` job is how it tells the two apart: it passes only on a full run.
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
// as passed), and `off` on a quick one (neither runs). `full` is `true` on a full run: the jobs every
// full run has (the WebKit UI scenarios, the Windows lint and types, the `full tier` job), and `off`
// on a quick one. `quick` is `true` on both: `verify` and the Windows unit tests; `off`, with every
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
// history, and a manual run is the one with the `everything` input set. A release bump changes the
// file that declares the version, which makes its pull request a full run of every job, as main's
// is, draft or not, so the release script's audit still holds (docs/releasing.md, "Workflow event
// audit"). When main or the merge-base is not in the checkout, everything runs.
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
/**
 * The file that declares the version (project.json `release.source.path`, which a test holds this to):
 * a pull request that changes it is a release bump, whose checks the release reads (docs/releasing.md).
 */
export const VERSION_SOURCE = 'packages/protocol/src/brand.ts'

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
 * The tier of a run (see the header), with why. `onMain`: HEAD is already on main. `dispatch`: a
 * manual run (the workflow_dispatch input `everything` is set, true or false). `files`: what HEAD adds
 * to main, or null when that is not known. `draft`: the run is a draft pull request's, which is
 * asked last: a release bump runs in full, a draft or not.
 */
export function tierOf({ files, onMain = false, dispatch = false, draft = false }) {
  if (onMain) return { tier: 'full', why: 'the commit is on main' }
  if (dispatch) return { tier: 'full', why: 'a manual run (workflow_dispatch), as the merge queue starts for a batch' }
  if (files === null) return { tier: 'full', why: 'the changed files are not known' }
  if (files.includes(VERSION_SOURCE)) return { tier: 'full', why: `it changes ${VERSION_SOURCE}, as a release bump does` }
  if (draft) return { tier: 'none', why: "a draft pull request, as a stack's lower PRs are: nothing runs until it is marked ready for review" }
  return { tier: 'quick', why: 'a pull request: the full tier runs in the merge queue' }
}

/** The answers build.yml's jobs read, as strings: see the header. */
export function outputs(tier, needs) {
  const full = tier === 'full'
  return { quick: tier === 'none' ? 'off' : 'true', full: full ? 'true' : 'off', ...Object.fromEntries(GROUPS.map((g) => [g, full ? String(needs[g]) : 'off'])) }
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

function main() {
  // A manual run sets the workflow_dispatch input; a push or a pull request leaves it empty
  const dispatch = process.env.EVERYTHING === 'true' || process.env.EVERYTHING === 'false'
  const changed = changedFiles()
  const { tier, why } = tierOf({ files: changed.files, onMain: changed.onMain === true, dispatch, draft: !dispatch && draftOf(process.env.GITHUB_EVENT_PATH) })
  // A manual run builds everything unless it asks otherwise (`everything` unticked)
  const files = process.env.EVERYTHING === 'true' ? null : changed.files
  const lines = Object.entries(outputs(tier, classify(files))).map(([k, v]) => `${k}=${v}`)
  console.log(`The ${tier} tier: ${why}.`)
  if (tier === 'full') console.log(files === null ? `Every job runs: ${process.env.EVERYTHING === 'true' ? 'a manual run asked for everything' : changed.why}.` : `${files.length} changed file(s), ${changed.why}:\n${files.map((f) => `  ${f}`).join('\n')}`)
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
