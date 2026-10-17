// Which of build.yml's jobs a commit needs, from the files it changes (2026-10-17).
//
// About 25 jobs run per push and the free plan runs about 20 at once, so runs queue one behind
// another, and a change to documents, tests or the window alone still built every bundle and ran the
// keeper and the host's tests. This answers on $GITHUB_OUTPUT what each group of jobs reads:
//
//   bundle      the product's sources (anything but documents and tests): the four bundles
//   host        the product's sources outside the window (packages/ui, core, platform, apps/web):
//               the keeper end to end, macOS and Linux, and the content verifier. The host shares
//               only protocol with the window (docs/architecture.md §2), and none of them read a test
//   host_tests  anything but documents outside the window and e2e/: the host's tests on the Node
//               remotes run (packages/agent-host, packages/protocol, tooling/launcher-)
//   code        anything but documents: the UI scenarios in Chromium and the UX tasks
//
// `verify`, the `windows tests` jobs and the WebKit UI scenarios do not ask: they run on every commit (their
// tests read documents too; WebKit on every pull request is the owner's decision of 2026-10-11).
//
// Which files: everything a commit adds to main. A commit already on main (a push to main, every
// commit of a rebase merge) runs everything: per-commit filtering, with newer pushes cancelling
// older runs, could leave main green without a bundle ever built for a host change. Any other
// commit (a pull request's merge commit) is compared with its merge-base with main, whatever the
// pull request's base branch is: a pull request stacked on another one is judged by the whole stack,
// since the merge queue lands a stack on the top pull request's checks alone. Renames count as a
// deletion and an addition (--no-renames), so moving a host file into docs/ is a host change.
//
// Nothing here reads the event: whether a commit is on main is a fact of the history. A release
// bump's pull request changes version files of the product, which run everything, as main does, so
// the release script's audit still holds (docs/releasing.md, "Workflow event audit"). When main or
// the merge-base is not in the checkout, everything runs.
//
// Local check: node .github/scripts/ci-changes.mjs   (prints the answer; GITHUB_OUTPUT unset)

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Documents: read by people and by `verify`'s tests, never built into anything */
const DOCS = [/^docs\//, /^[^/]+\.md$/, /^\.github\/ISSUE_TEMPLATE\//, /^\.github\/PULL_REQUEST_TEMPLATE\.md$/]
/** Tests and what only tests run: no bundle includes them */
const TESTS = [/\.test\.(ts|tsx|mts|mjs)$/, /\.test-helpers\.(ts|mts)$/, /^e2e\//, /^tooling\//, /^vitest\.config\.ts$/]
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

const matches = (patterns, file) => patterns.some((p) => p.test(file))
const ALL = { bundle: true, host: true, host_tests: true, code: true }

/** What a list of changed files needs. `null` (the files are not known) needs everything. */
export function classify(files) {
  if (files === null || files.some((f) => matches(EVERYTHING, f))) return { ...ALL }
  const nonDocs = files.filter((f) => !matches(DOCS, f))
  const product = nonDocs.filter((f) => !matches(TESTS, f))
  return {
    bundle: product.length > 0,
    host: product.some((f) => !matches(WINDOW, f)),
    host_tests: nonDocs.some((f) => !matches(WINDOW, f) && !f.startsWith('e2e/')),
    code: nonDocs.length > 0,
  }
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * The files HEAD adds to `main` (see the header), with why. `files` is null when everything should run: HEAD is
 * already on main, or main or the merge-base is not in this checkout.
 */
export function changedFiles(cwd = process.cwd(), main = 'origin/main') {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `${main}^{commit}`])
  } catch {
    return { files: null, why: `${main} is not in this checkout` }
  }
  try {
    git(cwd, ['merge-base', '--is-ancestor', 'HEAD', main])
    return { files: null, why: `HEAD is on ${main}` }
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
  // A manual run builds everything unless it asks otherwise (workflow_dispatch's `everything` input)
  const { files, why } = process.env.EVERYTHING === 'true' ? { files: null, why: 'a manual run asked for everything' } : changedFiles()
  const needs = classify(files)
  const lines = Object.entries(needs).map(([k, v]) => `${k}=${v}`)
  console.log(files === null ? `Everything runs: ${why}.` : `${files.length} changed file(s), ${why}:\n${files.map((f) => `  ${f}`).join('\n')}`)
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
