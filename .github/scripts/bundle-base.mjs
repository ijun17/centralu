// Fetches main's bundle record for build.yml's `verify` job (#1181, tooling/bundle-budget.ts).
//
// Every `verify` run uploads the size of the app's JS as the `bundle-size` artifact, and every run
// first downloads the newest one a run on main uploaded, which styles.test.ts compares with. The
// same steps run on every event: the audit of build.yml (docs/releasing.md, "Workflow event audit")
// lets a pull request's run stand for main's only when no job branches on the event, so main is
// picked here by the artifact's own run, never by the event this run belongs to.
//
//   node .github/scripts/bundle-base.mjs <folder>   (GH_TOKEN and GH_REPO set; gh on PATH)
//
// No record (none uploaded yet, or all expired) is not an error: the test says it did not compare.
// GitHub failing to answer is one, so a run that could not look does not pass as one that compared.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const ARTIFACT = 'bundle-size'

/**
 * The newest unexpired `bundle-size` artifact uploaded by a run on `branch` of this repository
 * itself. A fork's pull request can come from a branch named main too: its head repository differs.
 * The artifacts API lists the newest first; sorted again here so nothing rests on that.
 */
export function pickMainArtifact(artifacts, branch = 'main') {
  return [...(artifacts ?? [])]
    .filter((a) => a?.name === ARTIFACT && !a.expired && a.workflow_run?.head_branch === branch)
    .filter((a) => a.workflow_run.head_repository_id === a.workflow_run.repository_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null
}

function main() {
  const dir = process.argv[2]
  const repo = process.env.GH_REPO
  if (!dir || !repo) throw new Error('usage: GH_REPO=<owner/name> node .github/scripts/bundle-base.mjs <folder>')
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const listed = JSON.parse(gh(['api', `repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=100`]))
  const found = pickMainArtifact(listed.artifacts)
  if (!found) {
    console.log(`No ${ARTIFACT} artifact from a run on main: the bundle is not compared this time.`)
    return
  }
  gh(['run', 'download', String(found.workflow_run.id), '--repo', repo, '--name', ARTIFACT, '--dir', dir])
  console.log(`main's bundle record: run ${found.workflow_run.id}, commit ${found.workflow_run.head_sha}.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
