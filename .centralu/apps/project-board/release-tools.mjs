// The release: release_status and release.
import { z } from './runtime/centralu-app-runtime.mjs'
import { pathInput } from './board.mjs'
import { ciLines, progress } from './ci-tools.mjs'
import { evaluateChecks, ranTier, workflowCheckNames } from './ci.mjs'
import { APP_DIR, CI, config } from './config.mjs'
import { openPr } from './contribute-tools.mjs'
import { activeJobs, approveDeployments, cancelWorkflowRun, dispatchWorkflow, pendingDeployments, prsWithHead, readRepo, readRequired, readWorkflowChecks, runJobs, workflowRuns } from './github.mjs'
import { answering, serially } from './handlers.mjs'
import { approveRelease, bumpRelease, cancelDuplicateRelease, guarded, rehearseRelease, releaseConfig, ReleaseRefusal, releaseStatus, tagRelease } from './release.mjs'
import { asError, linesAnswer } from './reply.mjs'
import { BUMPS } from './versions.mjs'

// --- The release (#386 step 3) ------------------------------------------------------------------------
// docs/releasing.md as code: release.mjs holds the procedure, versions.mjs the version rules, and
// project.json `release` the repository's own layout (where the version is declared, which files carry
// it, the tag prefix, the workflow and its environment).
const RELEASE = releaseConfig(config.release)

/**
 * Release CI: only configured workflow suites, on the exact commit and source event. `own`: the
 * required set from that commit's own workflows rather than main's (an approval judges the tagged
 * commit, whose run reports the jobs its workflow had). `settled`: every build run on it completed,
 * so a check still missing will never report. `tier`: whether the full tier of CI ran, when the
 * required set names its check (a skipped job counts as passed, so a quick run is green on it).
 */
async function ciForRelease(repo, sha, { pr, own = false } = {}) {
  const { defaultBranch } = await readRepo(repo)
  const req = await readRequired(repo, defaultBranch, CI.workflows, workflowCheckNames, undefined, own ? { at: sha } : {})
  const { reported, runs } = await readWorkflowChecks(repo, sha, { workflows: CI.workflows, event: pr ? 'pull_request' : 'push', ...(pr ? { pr } : { branch: defaultBranch }) })
  const checks = evaluateChecks({ required: req.names, reported, alsoReported: req.unresolved.length > 0 })
  const cancelledRuns = runs.filter((r) => r.status === 'completed' && r.conclusion === 'cancelled')
  const settled = runs.length > 0 && runs.every((r) => r.status === 'completed')
  const missing = checks.rows.filter((r) => r.state === 'missing').map((r) => r.name)
  const running = checks.rows.some((r) => r.state === 'pending')
  const tier = CI.fullTier && req.names.includes(CI.fullTier) ? ranTier(checks, CI.fullTier) : 'full'
  return { cancelledRuns, tier, verdict: cancelledRuns.length ? 'failing' : checks.verdict, settled, missing, running, required: checks.rows.map((r) => r.name), workflows: CI.workflows, summary: cancelledRuns.length ? `Build run ${cancelledRuns.map((r) => r.id).join(', ')} cancelled` : ciLines(defaultBranch, sha, req, checks).summary }
}

// PROJECT_BOARD_NPM_REGISTRY: for the tests only, which answer from a local server
const NPM_REGISTRY = String(process.env.PROJECT_BOARD_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')

/** `name@version` on the registry: absent (404), or present with the commit npm recorded. Throws when it did not answer. */
async function npmVersion(name, version) {
  const r = await fetch(`${NPM_REGISTRY}/${String(name).replace('/', '%2f')}/${encodeURIComponent(version)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (r.status === 404) return { state: 'absent' }
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const v = await r.json()
  return { state: 'present', gitHead: typeof v.gitHead === 'string' ? v.gitHead : null }
}

/** open_pr's own code, answering whether it went and what it said. */
async function openPrResult(args) {
  const a = await openPr(args)
  const s = a.structuredContent ?? {}
  return { ok: !a.isError && s.ok !== false, text: a.content?.[0]?.text ?? s.summary ?? '', number: s.number ?? null, url: s.url ?? null }
}

const RELEASE_STEPS = { bump: bumpRelease, rehearse: rehearseRelease, tag: tagRelease, approve: approveRelease, cancel_duplicate: cancelDuplicateRelease }
const RELEASE_GH = { activeJobs, readRepo, prsWithHead, workflowRuns, runJobs, pendingDeployments, approveDeployments, dispatchWorkflow, cancelWorkflowRun }

async function release(args, step, call) {
  const repo = config.repository
  const ctx = { repo, dir: args.path ?? APP_DIR, cfg: RELEASE, gh: RELEASE_GH, ci: (sha, options) => ciForRelease(repo, sha, options), openPr: openPrResult, registry: npmVersion }
  try {
    if (step === 'status') {
      const r = await guarded(() => releaseStatus(ctx))
      return linesAnswer(r.summary, [['lines', '', r.lines]], { ok: true, phase: r.phase, version: r.version, tag: r.tag, head: r.head, releaseCommit: r.releaseCommit, behind: r.behind, notes: r.notes, after: r.after, duplicates: r.duplicates })
    }
    // Who is asking comes first, as for merging: a contributor's agent gets no further
    ctx.permissions = (await readRepo(repo)).permissions
    const { summary, lines, ...rest } = await guarded(() => RELEASE_STEPS[step](ctx, args, { signal: call?.mcpReq?.signal, progress: (n, message) => progress(call, n, message) }))
    return linesAnswer(summary, [['lines', '', lines]], { ok: !rest.partial, step, ...rest })
  } catch (e) {
    if (!(e instanceof ReleaseRefusal)) throw e
    const n = e.problems.length
    return asError(linesAnswer(`Release ${step} refused (${n === 1 ? 'one reason' : `${n} reasons`}); nothing was pushed, tagged, started or approved.`, [['problems', '', e.problems]], { ok: false, step }))
  }
}

const releaseStep = answering((args, call) => release(args, args.step, call), (args) => `Release ${args.step} stopped: `)
const releaseStepSerially = serially(releaseStep)

export const tools = {
  // The release. The status is for agents and the screen (the header's "Release" dialog); the steps
  // are for agents, each refusing with every reason at once and doing nothing without confirm.
  release_status: {
    config: {
      title: 'Where the release stands',
      description:
        "Instead of gh release view / gh run list: where this repository's release stands, read fresh: the version main declares and whether it is tagged, CI on main, the rehearsal on main's commit, the tag's release run and the environment approvals it waits on, what merged since the last release (the release notes draft), and the next step. Changes nothing.",
      inputSchema: z.object({ path: pathInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: answering((args) => release(args, 'status')),
  },

  release: {
    config: {
      title: 'Release: bump, rehearse, tag, approve',
      description:
        "Instead of gh release create, git tag and gh workflow run by hand: docs/releasing.md as steps, maintainer only (maintain or admin on the repository). Each step checks everything first and refuses with every reason, changing nothing; without confirm: true it only says what it would do. bump: needs a clean checkout on main at GitHub's main, CI green and the current version released; moves every file in project.json release.versionFiles from main's version to version (or the next by bump, default prerelease), refuses when a listed file lacks the version or an unlisted file carries it, commits in a temporary index, pushes chore/release-<version> and opens the pull request from the template with the merged list as the notes draft; warns (never refuses) when other builds' jobs hold most of release.runners. rehearse: starts the release workflow with its dry-run input on the release commit; while main's version is released, on the open bump PR's branch instead (no CI needed; the PR's head must be on main's head and carry its version consistently), so it runs beside the PR's CI. The release commit (#1350) is the bump's own squash commit on main, found by walking main's history back to the commit that declared main's version, not main's head: what lands on main after it does not matter (a rehearsal on it runs from a branch at that commit when main has moved on). rehearse and tag may use the merged bump PR's green checks when the release commit is its squash commit with the identical tree, and required jobs do not depend on the event; failing CI on the release commit always blocks. Both report the CI evidence used. tag: needs a clean checkout (on any branch: the tag is pushed by commit from GitHub's history), CI green on the release commit, main's version untagged and after the last tag, and a successful rehearsal on that commit or on its bump branch at a commit with the same tree (the bump PR's rehearsal, after the squash), or skipRehearsal: true; pushes the tag on the release commit and answers the release run. A later commit that changes the version (a newer bump) refuses it. commit: another commit of main's history that carries the version (main's head among them). approve: requires the tagged commit's own green CI (no PR fallback; unrelated newer main commits do not gate publication), then approves the tag's release run on its environment (npm-publish), only what GitHub says this login may approve; before the shim's approval also every other job of the run succeeded and every package the shim needs is on the registry at the version from the tagged commit; the shim's approval is the last reversible moment. approve with wait: true (and confirm) waits until that gate passes, up to waitMinutes, and approves the moment it does; a gate that cannot pass by itself (failed CI or job, a package from other code) still refuses at once.",
      inputSchema: z.object({
        step: z.enum(['bump', 'rehearse', 'tag', 'approve', 'cancel_duplicate']),
        confirm: z.boolean().optional().describe('Do it; default false (check and say what it would do)'),
        version: z.string().optional().describe('bump: the new version (default: the next by bump). rehearse: which open bump PR, when several. tag, approve: the version expected (default main\'s)'),
        bump: z.enum(BUMPS).optional().describe('bump: which part to count up when version is not given; default prerelease'),
        notes: z.string().max(4000).optional().describe('bump: one or two sentences on what this release ships, for the pull request; the list of merged changes is added'),
        closes: z.string().optional().describe('bump: the pull request\'s Closes line, e.g. "Refs #82"'),
        commit: z.string().optional().describe("rehearse, tag: a commit of main's history carrying main's version, instead of the bump's own squash commit (default)"),
        skipRehearsal: z.boolean().optional().describe('tag: tag without a successful rehearsal on the commit; default false'),
        comment: z.string().max(1000).optional().describe('approve: the comment GitHub keeps with the approval'),
        wait: z.boolean().optional().describe('approve, with confirm: wait until the gate passes and approve the moment it does (up to waitMinutes); default false'),
        waitMinutes: z.number().positive().max(60).optional().describe('approve with wait: how many minutes to wait at most; default 45'),
        run: z.number().int().positive().optional().describe('cancel_duplicate: the duplicate run id to cancel'),
        path: pathInput,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    // A waiting approve holds no other write of the board up; it reads everything again before it approves
    handler: (args, call) => (args.step === 'approve' && args.wait && args.confirm ? releaseStep(args, call) : releaseStepSerially(args, call)),
  },
}
