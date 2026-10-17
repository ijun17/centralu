// Whether a tagged release run may skip `pnpm verify` (#1042, owner decision 2026-10-18).
//
// `pnpm verify` ran in every platform job and in the shim of every release run: about 13 minutes of
// a tagged run, after the rehearsal had run the very same checks on the very same files minutes
// before. The rehearsal stays the place verify runs on macOS, ubuntu-22.04 and arm64; a tag push
// skips it only when a rehearsal passed on the same tree. `guard` asks GitHub here, rather than
// trusting the board's word that one ran, so a tag pushed by hand cannot skip anything.
//
// What counts: a completed, successful run of release.yml started by workflow_dispatch (a rehearsal
// never skips verify: only a tag push asks this), on a commit whose tree is the tagged commit's.
// The workflow file is part of that tree, so the rehearsal ran these same jobs. Anything GitHub does
// not answer, or answers otherwise, runs verify: the safe answer is the one that costs minutes.
//
// In the workflow: node scripts/release-rehearsal.mjs   (GITHUB_TOKEN with actions: read)

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WORKFLOW = 'release.yml'

/**
 * The newest successful rehearsal on `tree`, or null. `api(path)` answers GitHub's REST JSON for a
 * path under https://api.github.com/.
 */
export async function rehearsalFor({ repo, tree, api }) {
  const page = await api(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&status=success&per_page=100`)
  const trees = new Map()
  for (const r of page?.workflow_runs ?? []) {
    if (r.event !== 'workflow_dispatch' || r.status !== 'completed' || r.conclusion !== 'success' || !r.head_sha) continue
    if (!trees.has(r.head_sha)) trees.set(r.head_sha, (await api(`repos/${repo}/git/commits/${r.head_sha}`))?.tree?.sha ?? null)
    if (trees.get(r.head_sha) === tree) return r
  }
  return null
}

/** What the guard writes: `skip_verify`, and the line that says why. Never throws. */
export async function decide({ event, repo, tree, api }) {
  if (event !== 'push') return { skip: false, why: 'Not a tag push: verify runs, as in every rehearsal.' }
  try {
    const r = await rehearsalFor({ repo, tree, api })
    if (r) return { skip: true, why: `Rehearsal run ${r.id} (${r.html_url ?? ''}) passed on ${String(r.head_sha).slice(0, 7)}, the same tree as this tag: verify is skipped.` }
    return { skip: false, why: 'No successful rehearsal on this tree: verify runs.' }
  } catch (e) {
    return { skip: false, why: `GitHub did not answer which rehearsals ran (${e?.message ?? e}): verify runs.` }
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  const api = async (path) => {
    const r = await fetch(`https://api.github.com/${path}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } })
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path.split('?')[0]}`)
    return r.json()
  }
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  const { skip, why } = await decide({ event: process.env.GITHUB_EVENT_NAME, repo, tree, api })
  console.log(why)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip_verify=${skip}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n- \`pnpm verify\`: ${why}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
