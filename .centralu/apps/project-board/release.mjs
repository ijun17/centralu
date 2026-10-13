// release (#386 step 3): docs/releasing.md's procedure as code. bump → rehearse → tag → approve, each
// a call that first checks everything it depends on and refuses with every reason at once, and without
// `confirm` only says what it would do. `status` reads where the release stands without changing
// anything, for an agent and for the screen.
//
// Everything is read fresh at the call: main and the tags from the remote, CI from GitHub. The person's
// checkout never moves: the bump is committed in a temporary index (git.mjs commitFiles) and pushed
// from there, and the tag is pushed by commit, never made locally. The checkout still has to be clean
// and on main as GitHub has it, for the reason release-npm.mts refuses a dirty tree: what ships and
// what the person has in front of them must not differ.
//
// The version lives in one declaration (`release.source` in project.json, brand.ts here); the files
// that carry it are `release.versionFiles`. A bump changes each of them and refuses when one does not
// carry the version, or when any non-exempt text file of the repository still carries it and is
// not on the list: a file nobody listed is caught at the bump, not at the release.
import { canMerge } from './ci.mjs'
import {
  changes,
  commitFiles,
  currentBranch,
  fetchRefs,
  filesAt,
  filesHolding,
  GitError,
  head,
  isAncestor,
  pushRef,
  remoteFor,
  remoteRefs,
  showFile,
  subjects,
  topLevel,
} from './git.mjs'
import { bumpText, compareVersions, declaredVersion, filesNamed, nextVersion, parseVersion, releaseNotes, versionLines } from './versions.mjs'

/** A refusal: nothing was pushed, tagged, started or approved. */
export class ReleaseRefusal extends Error {
  constructor(problems) {
    super(problems.join(' '))
    this.problems = problems
  }
}

// Releases are maintainer-only, like merging (#386, merge policy); checked before anything else
export const NOT_MAINTAINER =
  "The GitHub account gh is logged in as has no maintain or admin permission on this repository, and releasing is the maintainer's act (#386). Nothing was changed."

const short = (sha) => String(sha ?? '?').slice(0, 7)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const list = (xs, max = 6) => `${xs.slice(0, max).join(', ')}${xs.length > max ? ` and ${xs.length - max} more` : ''}`

/** project.json `release`, with this repository's layout as the fallback for each part. */
export function releaseConfig(c = {}) {
  return {
    source: { path: c.source?.path ?? 'packages/protocol/src/brand.ts', pattern: c.source?.pattern ?? "APP_VERSION = '([^']+)'" },
    versionFiles: c.versionFiles ?? [],
    ignore: c.ignore ?? [],
    tagPrefix: c.tagPrefix ?? 'v',
    branchPrefix: c.branchPrefix ?? 'chore/release-',
    workflow: c.workflow ?? '.github/workflows/release.yml',
    environment: c.environment ?? 'npm-publish',
    rehearsalInputs: c.rehearsalInputs ?? { dry_run: 'true' },
  }
}

const workflowFile = (cfg) => cfg.workflow.split('/').pop()
let calls = 0

/**
 * Where things stand, read fresh: main's commit on the remote, the version it declares, the release
 * tags, the last release and what merged since it. Needs no clean checkout; changes nothing.
 */
async function readState({ repo, dir, cfg, gh }) {
  const root = await topLevel(dir).catch((e) => {
    throw new ReleaseRefusal([`${dir} is not a git checkout (${e.message}).`])
  })
  const remote = await remoteFor(root, repo)
  if (!remote) throw new ReleaseRefusal([`The checkout at ${root} has no remote for github.com/${repo}. Give path: a checkout of it.`])
  const info = await gh.readRepo(repo)
  const main = info.defaultBranch
  // Fetched under a name of this call's own, removed again: no ref of the person's moves
  const space = `refs/centralu-release/${process.pid}-${++calls}`
  const [tip] = await fetchRefs(root, remote, [`refs/heads/${main}`], space)
  const source = await showFile(root, tip, cfg.source.path)
  const version = source === null ? null : declaredVersion(source, cfg.source.pattern)
  if (!version) throw new ReleaseRefusal([`${main} at ${short(tip)} declares no version: ${cfg.source.path} ${source === null ? 'is missing' : `has nothing matching ${cfg.source.pattern}`} (project.json release.source).`])
  if (!parseVersion(version)) throw new ReleaseRefusal([`${cfg.source.path} declares "${version}", which is not a version.`])
  const tags = (await remoteRefs(root, remote, 'refs/tags/'))
    .filter((t) => t.name.startsWith(cfg.tagPrefix) && parseVersion(t.name.slice(cfg.tagPrefix.length)))
    .map((t) => ({ ...t, version: t.name.slice(cfg.tagPrefix.length) }))
    .sort((a, b) => compareVersions(b.version, a.version))
  const tag = `${cfg.tagPrefix}${version}`
  const tagged = tags.find((t) => t.name === tag) ?? null
  const last = tags[0] ?? null
  let notes = []
  let notesFrom = null
  if (last) {
    const [lastSha] = await fetchRefs(root, remote, [`refs/tags/${last.name}`], space)
    if (await isAncestor(root, lastSha, tip)) {
      notesFrom = last.name
      notes = releaseNotes(await subjects(root, lastSha, tip))
    }
  }
  return { root, remote, main, permissions: info.permissions, tip, version, tag, tagged, tags, last, notes, notesFrom }
}

/** The checkout must be clean, on main, and at main's commit on the remote. Answers the problems. */
async function checkoutProblems(s) {
  const problems = []
  const dirty = await changes(s.root)
  if (dirty.length) problems.push(`The checkout at ${s.root} has ${plural(dirty.length, 'uncommitted change')} (${list(dirty)}); commit or put them away first, so what is released is what is committed.`)
  const branch = await currentBranch(s.root)
  if (branch !== s.main) problems.push(`The checkout at ${s.root} is on ${branch ? `branch ${branch}` : 'no branch (detached)'}, not ${s.main}; switch to ${s.main} first.`)
  else {
    const at = await head(s.root)
    if (at !== s.tip) {
      const behind = await isAncestor(s.root, at, s.tip).catch(() => false)
      problems.push(
        behind
          ? `The checkout's ${s.main} (${short(at)}) is behind ${s.main} on ${s.remote} (${short(s.tip)}); pull first.`
          : `The checkout's ${s.main} (${short(at)}) has commits ${s.main} on ${s.remote} (${short(s.tip)}) does not; a release is cut from what GitHub has.`,
      )
    }
  }
  return problems
}

/** CI on main's commit must be green: every required check reported and passed. */
async function ciProblems(s, ci) {
  const r = await ci(s.tip)
  return r.verdict === 'green' ? [] : [`CI on ${s.main} at ${short(s.tip)} is not green: ${r.summary}`]
}

/** The version files main carries, the bumped text of each, and every problem with them. */
async function versionFiles(s, cfg, from, to) {
  const all = await filesAt(s.root, s.tip)
  const named = filesNamed(cfg.versionFiles, all)
  const problems = []
  if (!named.length) problems.push('project.json release.versionFiles names no file of the repository.')
  if (!named.includes(cfg.source.path)) problems.push(`${cfg.source.path}, where the version is declared, is not in project.json release.versionFiles.`)
  const files = {}
  const counts = {}
  for (const path of named) {
    const text = await showFile(s.root, s.tip, path)
    const r = bumpText(text ?? '', from, to ?? from)
    if (!r.count) problems.push(`${path} is in release.versionFiles but does not carry "${from}"; it fell behind, or the list is wrong.`)
    files[path] = r.text
    counts[path] = r.count
  }
  // A file that carries the version and is not listed would keep the old one after the bump
  const holding = await filesHolding(s.root, s.tip, [from])
  for (const p of holding.filter((p) => !named.includes(p) && !filesNamed(cfg.ignore, [p]).length)) {
    for (const line of versionLines(await showFile(s.root, s.tip, p), from))
      problems.push(`${p}:${line} carries "${from}" but is not in project.json release.versionFiles; derive it from the version source, or add it to release.ignore if it intentionally pins a version.`)
  }
  return { named, files, counts, problems }
}

/** What GitHub says about the release workflow's runs on main's commit and for the tag. */
async function runsFor(s, cfg, gh) {
  const file = workflowFile(cfg)
  const rehearsals = await gh.workflowRuns(s.repo, file, { event: 'workflow_dispatch', headSha: s.tip })
  const candidates = s.tagged ? (await gh.workflowRuns(s.repo, file, { event: 'push', headSha: s.tagged.sha })).filter((r) => r.headBranch === s.tag) : []
  const active = candidates.filter((r) => r.status !== 'completed')
  // A run GitHub says is waiting on the release environment is the one a maintainer can act on;
  // duplicate pushes otherwise leave several active runs for one tag, newest first from the API.
  let release = active[0] ?? candidates[0] ?? null
  let waiting = null
  for (const r of active) {
    const pending = await gh.pendingDeployments(s.repo, r.id)
    if (pending.some((p) => p.environment === cfg.environment)) {
      release = r
      waiting = pending
      break
    }
  }
  return { rehearsal: rehearsals[0] ?? null, release, duplicates: release ? candidates.filter((r) => r.id !== release.id) : [], waiting }
}

async function cancellableDuplicates(repo, duplicates, gh) {
  const rows = []
  for (const r of duplicates.filter((x) => x.status !== 'completed')) {
    const jobs = await gh.runJobs(repo, r.id)
    rows.push({ run: r, safe: !jobs.some((j) => /publish/i.test(j.name) && j.status === 'completed' && j.conclusion === 'success') })
  }
  return rows
}

const runState = (r) => (r.status === 'completed' ? (r.conclusion === 'success' ? 'succeeded' : `ended ${r.conclusion}`) : r.status === 'waiting' ? 'waiting for approval' : r.status.replace(/_/g, ' '))

function notesLines(s) {
  if (!s.notesFrom) return s.last ? [`${s.last.name} is not on ${s.main}, so what merged since cannot be listed.`] : ['No release tag yet.']
  return s.notes.length ? [`Merged since ${s.notesFrom} (${s.notes.length}):`, ...s.notes.map((n) => `- ${n}`)] : [`Nothing merged since ${s.notesFrom}.`]
}

// --- status -------------------------------------------------------------------------------------------

/** Where the release stands and the next step. Read-only. */
export async function releaseStatus({ repo, dir, cfg, gh, ci }) {
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const lines = []
  const verdict = await ci(s.tip)
  lines.push(`CI on ${s.main} at ${short(s.tip)}: ${verdict.verdict}.`)
  const local = await checkoutProblems(s)
  lines.push(local.length ? `Checkout: ${local.join(' ')}` : `Checkout: clean, on ${s.main} at ${short(s.tip)}.`)
  const runs = await runsFor(s, cfg, gh)
  const duplicates = await cancellableDuplicates(repo, runs.duplicates, gh)
  let phase
  let next
  if (s.tagged) {
    const r = runs.release
    if (!r) {
      phase = 'tagged'
      next = `No release run for ${s.tag} yet; GitHub starts one on the tag push. Look at ${workflowFile(cfg)} on GitHub if none shows.`
    } else if (r.status !== 'completed') {
      const pending = runs.waiting ?? (await gh.pendingDeployments(repo, r.id))
      const waiting = pending.filter((p) => p.environment === cfg.environment)
      phase = waiting.length ? 'waiting-approval' : 'publishing'
      lines.push(`Release run for ${s.tag}: ${runState(r)}${r.url ? `, ${r.url}` : ''}.`)
      if (waiting.length) {
        const jobs = (await gh.runJobs(repo, r.id)).filter((j) => j.status === 'waiting').map((j) => j.name)
        lines.push(`Waiting for approval on ${cfg.environment}${jobs.length ? `: ${list(jobs)}` : ''}.`)
        next = `Approve with release step approve (confirm: true), or on GitHub: ${r.url}`
      } else next = 'Wait for the run; call release_status again.'
    } else if (r.conclusion === 'success') {
      phase = 'released'
      lines.push(`Release run for ${s.tag}: succeeded${r.url ? `, ${r.url}` : ''}.`)
      next = s.notes.length ? `${s.version} is released. ${plural(s.notes.length, 'change')} since: bump with release step bump.` : `${s.version} is released; nothing merged since.`
    } else {
      phase = 'failed'
      lines.push(`Release run for ${s.tag}: ${runState(r)}${r.url ? `, ${r.url}` : ''}.`)
      next = 'Re-run the failed jobs of that run (docs/releasing.md, "When a job fails halfway").'
    }
  } else {
    phase = 'ready-to-tag'
    const rh = runs.rehearsal
    lines.push(rh ? `Rehearsal on ${short(s.tip)}: ${runState(rh)}${rh.url ? `, ${rh.url}` : ''}.` : `No rehearsal on ${short(s.tip)} yet.`)
    next =
      rh?.conclusion === 'success'
        ? `Tag ${s.tag} with release step tag (confirm: true).`
        : rh && rh.status !== 'completed'
          ? 'Wait for the rehearsal; call release_status again.'
          : `Rehearse with release step rehearse (confirm: true), then tag ${s.tag}.`
  }
  if (duplicates.length) {
    const safe = duplicates.filter((d) => d.safe)
    lines.push(`Duplicate release runs for ${s.tag}: ${duplicates.map((d) => d.run.url ?? d.run.id).join(', ')}.`)
    if (safe.length) lines.push(`Before anything publishes, cancel a duplicate with release step cancel_duplicate (run: ${safe[0].run.id}, confirm: true).`)
  }
  lines.push(...notesLines(s))
  const summary = `${s.main} at ${short(s.tip)} carries ${s.version}: ${
    { tagged: `tagged ${s.tag}`, 'waiting-approval': `${s.tag} is waiting for approval`, publishing: `${s.tag} is being published`, released: `released as ${s.tag}`, failed: `the ${s.tag} release run failed`, 'ready-to-tag': `not tagged yet (last release ${s.last?.name ?? 'none'})` }[phase]
  }. Next: ${next}`
  return { summary, lines, phase, version: s.version, tag: s.tag, head: s.tip, notes: s.notes, duplicates: duplicates.map((d) => ({ id: d.run.id, url: d.run.url, safeToCancel: d.safe })) }
}

// --- bump ---------------------------------------------------------------------------------------------

const wrap = (text, width = 72) => {
  const out = []
  let line = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > width) (out.push(line), (line = ''))
    line = line ? `${line} ${w}` : w
  }
  if (line) out.push(line)
  return out.join('\n')
}

/**
 * The bump pull request: every version file moved from main's version to the next, committed on
 * `chore/release-<next>` and opened with the template filled. `openPr` is the board's own (with
 * `dryRun` it only checks), so the pull request is held to the same rules as any other.
 */
export async function bumpRelease({ repo, dir, cfg, gh, ci, openPr, permissions }, { version, bump, notes, closes, confirm = false }) {
  if (!canMerge(permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const problems = [...(await checkoutProblems(s)), ...(await ciProblems(s, ci))]
  if (!s.tagged) problems.push(`${s.version} on ${s.main} is not released yet (no tag ${s.tag}); release it (release step tag) before bumping past it.`)
  let next = null
  try {
    next = version !== undefined ? String(version).replace(/^v/, '') : nextVersion(s.version, bump ?? 'prerelease')
    if (!parseVersion(next)) throw new Error(`"${version}" is not a version (major.minor.patch, with an optional -prerelease).`)
  } catch (e) {
    problems.push(e.message)
    next = null
  }
  if (next) {
    if (compareVersions(next, s.version) <= 0) problems.push(`${next} is not after ${s.version}, the version on ${s.main}.`)
    if (s.last && compareVersions(next, s.last.version) <= 0) problems.push(`${next} is not after ${s.last.name}, the latest release tag.`)
    if (s.tags.some((t) => t.name === `${cfg.tagPrefix}${next}`)) problems.push(`${cfg.tagPrefix}${next} is tagged already.`)
  }
  const branch = next ? `${cfg.branchPrefix}${next}` : null
  if (branch) {
    if ((await remoteRefs(s.root, s.remote, 'refs/heads/')).some((b) => b.name === branch)) problems.push(`The branch ${branch} exists on ${s.remote} already; a bump for ${next} was started. Look at its pull request, or delete the branch.`)
    const open = (await gh.prsWithHead(repo, branch)).filter((p) => p.state === 'OPEN')
    if (open.length) problems.push(`Pull request #${open[0].number} for ${branch} is open already.`)
  }
  const vf = await versionFiles(s, cfg, s.version, next)
  problems.push(...vf.problems)

  const title = `chore(release): ${next}`
  const merged = s.notesFrom ? (s.notes.length ? [`Merged since ${s.notesFrom}:`, '', ...s.notes.map((n) => `- ${n}`)] : [`Nothing merged since ${s.notesFrom}.`]) : []
  const pr = {
    title,
    head: branch,
    base: s.main,
    why: [String(notes ?? '').trim() || `Ship what merged since ${s.notesFrom ?? 'the last release'}.`, ...(merged.length ? ['', ...merged] : [])].join('\n'),
    whatChanged: `The version ${s.version} → ${next} in ${vf.named.map((p) => `\`${p}\``).join(', ')}.`,
    verified: `The release tool's checks on ${s.main} at ${short(s.tip)}: CI green, every file in release.versionFiles carried ${s.version} and now carries ${next}, and no other tracked text file outside release.ignore carries ${s.version}, including embedded references. \`tooling/brand.test.ts\` runs on this pull request.`,
    usability: 'n/a',
    notExercised: `The release workflow, until ${cfg.tagPrefix}${next} is tagged.`,
    closes: String(closes ?? '').trim() || 'No issue: a release.',
  }
  if (!problems.length) {
    const check = await openPr({ ...pr, dryRun: true })
    if (!check.ok) problems.push(`The pull request would be refused: ${check.text}`)
  }
  if (problems.length) throw new ReleaseRefusal(problems)

  const message = `${title}\n\n${wrap(`The version ${s.version} → ${next} in ${vf.named.join(', ')}.`)}\n`
  const changed = Object.entries(vf.counts).map(([p, n]) => `${p}: ${plural(n, 'place')}`)
  const lines = [`${s.version} → ${next} in ${plural(vf.named.length, 'file')}:`, ...changed.map((c) => `- ${c}`)]
  if (!confirm)
    return {
      summary: `Ready to bump ${s.version} → ${next} on ${s.main} at ${short(s.tip)}, as ${branch}; nothing pushed yet. Call again with confirm: true to push the branch and open the pull request.`,
      lines: [...lines, ...notesLines(s)],
      next,
      pushed: false,
    }
  const commit = await commitFiles(s.root, s.tip, vf.files, message)
  try {
    await pushRef(s.root, s.remote, commit, `refs/heads/${branch}`)
  } catch (e) {
    throw new ReleaseRefusal([`Pushing ${branch} failed, so nothing changed on GitHub: ${e.message}`])
  }
  lines.push(`Pushed ${short(commit)} to ${branch} on ${s.remote}.`)
  const opened = await openPr(pr)
  if (!opened.ok) return { summary: `Pushed ${branch}, but the pull request was not opened: ${opened.text}`, lines, next, pushed: true, partial: true }
  lines.push(opened.text)
  return {
    summary: `Opened the bump to ${next}: ${opened.url ?? `#${opened.number}`}. Merge it once CI is green (merge_when_green), then rehearse and tag.`,
    lines,
    next,
    pushed: true,
    number: opened.number,
    url: opened.url,
  }
}

// --- rehearse -----------------------------------------------------------------------------------------

const RUN_LOOKS = 5
const RUN_LOOK_MS = Number(process.env.PROJECT_BOARD_RUN_LOOK_MS) || 3_000
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

async function findRun(gh, repo, file, filter, match, after) {
  for (let i = 0; i < RUN_LOOKS; i++) {
    const run = (await gh.workflowRuns(repo, file, filter)).find((r) => match(r) && (!after || !r.createdAt || Date.parse(r.createdAt) >= after - 60_000))
    if (run) return run
    if (i < RUN_LOOKS - 1) await pause(RUN_LOOK_MS)
  }
  return null
}

/** The rehearsal: the release workflow by hand on main, with its dry-run input. Builds and packs, publishes nothing. */
export async function rehearseRelease({ repo, dir, cfg, gh, ci, permissions }, { confirm = false }) {
  if (!canMerge(permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const problems = [...(await ciProblems(s, ci))]
  if (s.tagged) problems.push(`${s.version} is released already (${s.tag}); bump first.`)
  const vf = await versionFiles(s, cfg, s.version)
  problems.push(...vf.problems)
  if (problems.length) throw new ReleaseRefusal(problems)
  const file = workflowFile(cfg)
  const { rehearsal } = await runsFor(s, cfg, gh)
  if (rehearsal && (rehearsal.status !== 'completed' || rehearsal.conclusion === 'success'))
    return { summary: `A rehearsal on ${short(s.tip)} ${runState(rehearsal)}${rehearsal.url ? `: ${rehearsal.url}` : ''}; not starting another.`, lines: [], started: false, run: rehearsal.url }
  const inputs = Object.entries(cfg.rehearsalInputs).map(([k, v]) => `${k}=${v}`).join(', ')
  if (!confirm)
    return {
      summary: `Ready to rehearse ${s.version} on ${s.main} at ${short(s.tip)} (${file} with ${inputs}; builds and packs, publishes nothing, asks no approval). Call again with confirm: true to start it.`,
      lines: [],
      started: false,
    }
  const at = Date.now()
  await gh.dispatchWorkflow(repo, file, s.main, cfg.rehearsalInputs)
  const run = await findRun(gh, repo, file, { event: 'workflow_dispatch', headSha: s.tip }, () => true, at)
  return {
    summary: `Started the rehearsal of ${s.version} on ${short(s.tip)}${run?.url ? `: ${run.url}` : `; GitHub does not list the run yet, look at ${file}'s runs`}. Tag once it succeeds.`,
    lines: [],
    started: true,
    run: run?.url ?? null,
  }
}

// --- tag ----------------------------------------------------------------------------------------------

/** The tag is the release: pushed on main's commit once everything says that commit is the one. */
export async function tagRelease({ repo, dir, cfg, gh, ci, permissions }, { version, skipRehearsal = false, confirm = false }) {
  if (!canMerge(permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const problems = [...(await checkoutProblems(s)), ...(await ciProblems(s, ci))]
  if (version !== undefined && String(version).replace(/^v/, '') !== s.version) problems.push(`${s.main} at ${short(s.tip)} carries ${s.version}, not ${String(version).replace(/^v/, '')}; merge its bump first.`)
  if (s.tagged) problems.push(`${s.tag} is tagged already${s.tagged.sha === s.tip ? '' : ` (on ${short(s.tagged.sha)})`}; a release tag is never moved. Bump to the next version instead.`)
  else if (s.last && compareVersions(s.version, s.last.version) <= 0) problems.push(`${s.version} is not after ${s.last.name}, the latest release tag.`)
  const vf = await versionFiles(s, cfg, s.version)
  problems.push(...vf.problems)
  const { rehearsal } = await runsFor(s, cfg, gh)
  if (!skipRehearsal && !s.tagged) {
    if (!rehearsal) problems.push(`No rehearsal ran on ${short(s.tip)}: rehearse first (release step rehearse), or pass skipRehearsal: true to tag without one.`)
    else if (rehearsal.status !== 'completed') problems.push(`The rehearsal on ${short(s.tip)} is still running${rehearsal.url ? ` (${rehearsal.url})` : ''}; tag once it succeeds.`)
    else if (rehearsal.conclusion !== 'success') problems.push(`The rehearsal on ${short(s.tip)} ${runState(rehearsal)}${rehearsal.url ? ` (${rehearsal.url})` : ''}; fix that first, or pass skipRehearsal: true.`)
  }
  if (problems.length) throw new ReleaseRefusal(problems)

  const lines = [
    `${s.main} at ${short(s.tip)}: CI green, every version file carries ${s.version}.`,
    skipRehearsal ? 'Rehearsal: skipped (skipRehearsal: true).' : `Rehearsal: succeeded${rehearsal?.url ? `, ${rehearsal.url}` : ''}.`,
    ...notesLines(s),
  ]
  if (!confirm)
    return {
      summary: `Ready to tag ${s.tag} on ${short(s.tip)}; nothing pushed yet. The tag is the release: the workflow publishes after approval on ${cfg.environment}. Call again with confirm: true to push it.`,
      lines,
      tagged: false,
    }
  try {
    await pushRef(s.root, s.remote, s.tip, `refs/tags/${s.tag}`)
  } catch (e) {
    throw new ReleaseRefusal([`Pushing ${s.tag} failed, so nothing was released: ${e.message}`])
  }
  lines.push(`Pushed ${s.tag} on ${short(s.tip)} to ${s.remote}.`)
  const run = await findRun(gh, repo, workflowFile(cfg), { event: 'push', headSha: s.tip }, (r) => r.headBranch === s.tag)
  return {
    summary: `Tagged ${s.tag} on ${short(s.tip)}. ${run?.url ? `The release run: ${run.url}.` : `GitHub does not list the release run yet; look at ${workflowFile(cfg)}'s runs.`} It waits for approval on ${cfg.environment}: the platform jobs first, then the shim. Next: release step approve, or approve on GitHub.`,
    lines,
    tagged: true,
    run: run?.url ?? null,
  }
}

// --- approve ------------------------------------------------------------------------------------------

/**
 * The environment approval of the tag's release run (owner decision, 2026-10-06: the maintainer's
 * agent drives the release end to end, approvals included, every step shown). Only that run, only the
 * configured environment, only what GitHub says this login may approve.
 */
export async function approveRelease({ repo, dir, cfg, gh, permissions }, { version, comment, confirm = false }) {
  if (!canMerge(permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const want = version !== undefined ? String(version).replace(/^v/, '') : s.version
  const tag = `${cfg.tagPrefix}${want}`
  const t = s.tags.find((x) => x.name === tag)
  if (!t) throw new ReleaseRefusal([`${tag} is not tagged; there is no release run to approve.`])
  const candidates = (await gh.workflowRuns(repo, workflowFile(cfg), { event: 'push', headSha: t.sha })).filter((r) => r.headBranch === tag)
  let run = candidates.find((r) => r.status !== 'completed') ?? candidates[0]
  for (const r of candidates.filter((x) => x.status !== 'completed')) if ((await gh.pendingDeployments(repo, r.id)).some((p) => p.environment === cfg.environment)) { run = r; break }
  if (!run) throw new ReleaseRefusal([`GitHub lists no ${workflowFile(cfg)} run for ${tag} (${short(t.sha)}).`])
  if (run.headSha !== t.sha) throw new ReleaseRefusal([`The run for ${tag} is on ${short(run.headSha)}, but ${tag} is ${short(t.sha)}.`])
  if (run.status === 'completed') return { summary: `The release run for ${tag} ${runState(run)}${run.url ? `: ${run.url}` : ''}; nothing waits for approval.`, lines: [], approved: false, run: run.url }
  const pending = (await gh.pendingDeployments(repo, run.id)).filter((p) => p.environment === cfg.environment)
  if (!pending.length) return { summary: `The release run for ${tag} is ${runState(run)}; nothing waits for approval on ${cfg.environment} now${run.url ? `: ${run.url}` : ''}.`, lines: [], approved: false, run: run.url }
  const cannot = pending.filter((p) => !p.canApprove)
  if (cannot.length) throw new ReleaseRefusal([`GitHub says this login may not approve ${cfg.environment} for this run${cannot[0].reviewers.length ? ` (reviewers: ${cannot[0].reviewers.join(', ')})` : ''}. Approve on GitHub: ${run.url}`])
  const jobs = (await gh.runJobs(repo, run.id)).filter((j) => j.status === 'waiting').map((j) => j.name)
  const what = jobs.length ? list(jobs) : 'the waiting jobs'
  const last = jobs.length > 0 && jobs.every((j) => /shim/i.test(j))
  const lines = [`Waiting on ${cfg.environment}: ${what}.`, ...(last ? ['This is the shim: the last moment anything is reversible (docs/releasing.md).'] : [])]
  if (!confirm) return { summary: `${tag}'s release run waits for approval on ${cfg.environment} (${what}); nothing approved yet. Call again with confirm: true to approve, or approve on GitHub: ${run.url}`, lines, approved: false, run: run.url }
  await gh.approveDeployments(repo, run.id, [...new Set(pending.map((p) => p.environmentId))], String(comment ?? '').trim() || `Approved through the project board's release tool for ${tag}.`)
  return { summary: `Approved ${cfg.environment} for ${tag} (${what})${run.url ? `: ${run.url}` : ''}.${last ? '' : ' The shim asks again once every platform job succeeds.'}`, lines, approved: true, run: run.url }
}

/** Cancel only an extra tag run whose publish job has not succeeded. */
export async function cancelDuplicateRelease({ repo, dir, cfg, gh, permissions }, { version, run, confirm = false }) {
  if (!canMerge(permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const want = version !== undefined ? String(version).replace(/^v/, '') : s.version
  const tag = `${cfg.tagPrefix}${want}`
  const t = s.tags.find((x) => x.name === tag)
  if (!t) throw new ReleaseRefusal([`${tag} is not tagged; there is no release run to cancel.`])
  const runs = (await gh.workflowRuns(repo, workflowFile(cfg), { event: 'push', headSha: t.sha })).filter((r) => r.headBranch === tag && r.status !== 'completed')
  if (runs.length < 2) throw new ReleaseRefusal([`There is no duplicate active release run for ${tag}.`])
  let selected = runs[0]
  for (const r of runs) if ((await gh.pendingDeployments(repo, r.id)).some((p) => p.environment === cfg.environment)) { selected = r; break }
  const target = runs.find((r) => Number(r.id) === Number(run))
  if (!target) throw new ReleaseRefusal([`Run ${run} is not an active release run for ${tag}.`])
  if (target.id === selected.id) throw new ReleaseRefusal([`Run ${target.id} is the release run selected for ${tag}, not a duplicate.`])
  const jobs = await gh.runJobs(repo, target.id)
  if (jobs.some((j) => /publish/i.test(j.name) && j.status === 'completed' && j.conclusion === 'success')) throw new ReleaseRefusal([`Run ${target.id} has already published; it is not cancelled.`])
  if (!confirm) return { summary: `Ready to cancel duplicate run ${target.id} for ${tag}; no publish job succeeded. Call again with confirm: true to cancel it.`, lines: [], cancelled: false, run: target.url }
  await gh.cancelWorkflowRun(repo, target.id)
  return { summary: `Cancelled duplicate run ${target.id} for ${tag}${target.url ? `: ${target.url}` : ''}.`, lines: [], cancelled: true, run: target.url }
}

/** Git failures become refusals: nothing was released. */
export async function guarded(fn) {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof GitError) throw new ReleaseRefusal([e.message])
    throw e
  }
}
