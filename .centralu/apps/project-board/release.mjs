// release (#386 step 3): docs/releasing.md's procedure as code. rehearse → tag → approve, each a call that first
// checks everything it depends on and refuses with every reason at once, and without `confirm` only says what it
// would do. `status` reads where the release stands without changing anything, for an agent and for the screen.
//
// No file carries the release version (#1501): the build stamps it from the tag, and there is no bump. The next
// release is the next prerelease after the newest tag (or `version`), cut from the newest commit of main since that
// tag whose own push run of CI is fully green (or `commit`); `rehearse` dispatches the release workflow with that
// version as an input, `tag` pushes an annotated tag whose message is the notes, and `approve` reads only the tagged
// commit's own CI, which was green before it was tagged. `release_status` follows the newest tag until its release
// run has succeeded, then the next release.
//
// Everything is read fresh at the call: main and the tags from the remote, CI from GitHub. The person's checkout
// never moves: the tag is pushed by commit, never made locally. The checkout still has to be clean, for the reason
// release-npm.mts refuses a dirty tree: what ships and what the person has in front of them must not differ.
import { canMerge } from './ci.mjs'
import {
  changes,
  commitCount,
  deleteRemoteBranch,
  fetchRefs,
  filesAt,
  GitError,
  git,
  isAncestor,
  pushRef,
  remoteFor,
  remoteRefs,
  showFile,
  subjects,
  tagObject,
  topLevel,
  treeOf,
} from './git.mjs'
import { compareVersions, filesNamed, nextVersion, parseVersion, releaseNotes, sourceScheme } from './versions.mjs'
import { listSome, plural, short, sleep, span } from './util.mjs'
import { now as clock } from './clock.mjs'

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

const list = (xs) => listSome(xs, 6)

/** project.json `release`, with this repository's layout as the fallback for each part. */
export function releaseConfig(c = {}) {
  return {
    // `marker` and `name`: how `sourceScheme` (versions.mjs) tells a commit of the tag scheme from one that still declares the version
    source: {
      path: c.source?.path ?? 'packages/protocol/src/brand.ts',
      pattern: c.source?.pattern ?? "APP_VERSION = '([^']+)'",
      marker: c.source?.marker ?? String.raw`^(?:import|export) \{ APP_VERSION \} from '\./version\.generated(?:\.js)?';?$`,
      name: c.source?.name ?? 'APP_VERSION',
    },
    tagPrefix: c.tagPrefix ?? 'v',
    branchPrefix: c.branchPrefix ?? 'chore/release-',
    workflow: c.workflow ?? '.github/workflows/release.yml',
    environment: c.environment ?? 'npm-publish',
    rehearsalInputs: c.rehearsalInputs ?? { dry_run: 'true' },
    // The packages that must be on the registry before the shim's approval: every package.json these
    // name at the tagged commit, but the shim's own
    registry: { packages: c.registry?.packages ?? ['packaging/npm/*/package.json'], shim: c.registry?.shim ?? 'packaging/npm/centralu/package.json' },
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
  const tags = (await remoteRefs(root, remote, 'refs/tags/'))
    .filter((t) => t.name.startsWith(cfg.tagPrefix) && parseVersion(t.name.slice(cfg.tagPrefix.length)))
    .map((t) => ({ ...t, version: t.name.slice(cfg.tagPrefix.length) }))
    .sort((a, b) => compareVersions(b.version, a.version))
  // No file declares it (#1501): the release in view is the newest tag's until `nextRelease` picks the next one
  const version = tags[0]?.version ?? null
  const tag = version === null ? null : `${cfg.tagPrefix}${version}`
  const tagged = tags.find((t) => t.name === tag) ?? null
  const last = tags[0] ?? null
  let notes = []
  let notesFrom = null
  let lastSha = null
  if (last) {
    ;[lastSha] = await fetchRefs(root, remote, [`refs/tags/${last.name}`], space)
    if (await isAncestor(root, lastSha, tip)) {
      notesFrom = last.name
      notes = releaseNotes(await subjects(root, lastSha, tip))
    }
  }
  // `at`: the commit a release is cut from (`nextRelease` sets it); main's head until then
  return { root, remote, main, permissions: info.permissions, tip, version, tag, tagged, tags, last, lastSha, notes, notesFrom, after: [], at: tip, behind: 0 }
}

/** How many first-parent commits of main since the newest tag are looked through */
const WALK_LIMIT = 500

/**
 * Why `sha` cannot be released under the tag scheme, or null when it can: its `release.source` must be in the tag scheme by
 * `sourceScheme`, the same reading the release workflow's guard makes of it (#1501 review item 1).
 */
async function notTagScheme(s, cfg, sha) {
  const r = sourceScheme(await showFile(s.root, sha, cfg.source.path), cfg.source)
  if (r.scheme === 'tag') return null
  return r.scheme === 'brand' ? `still declares ${r.version} in ${cfg.source.path} (the brand scheme).` : `cannot be read for its scheme: ${cfg.source.path} ${r.problem}`
}

/** How many of main's newest commits since the last tag are asked for their CI, looking for a releasable one (#1501) */
const CANDIDATE_LOOK = 20

/** A commit's own push run of CI says it may be released: every required check reported and passed, and the full tier ran */
const releasable = (r) => r.verdict === 'green' && (r.tier === undefined || r.tier === 'full')

/**
 * The tag scheme's next release (#1501): the version, and the commit it is cut from. The version is `version`, or the
 * next prerelease after the newest tag; it must be after every tag and untagged. The commit is `commit`, or the newest
 * commit on main's first-parent history since the newest tag whose own push run of CI is fully green (its own
 * workflows' required checks, the full tier included); a batch's quick run on it does not count (`ciForRelease` reads
 * push runs only). Sets `s.version`, `s.tag`, `s.at`, `s.behind`, the notes (newest tag to the commit) and what landed
 * after it. Answers `{ problems, lines, nothing }`; `nothing`: no commit landed since the newest tag.
 */
async function nextRelease(s, cfg, ci, { version, commit } = {}) {
  const problems = []
  let want = null
  try {
    want = version !== undefined ? String(version).trim().replace(/^v/, '') : s.last ? nextVersion(s.last.version) : null
  } catch (e) {
    problems.push(`${e.message} (after ${s.last.name}, the newest release tag)`)
  }
  if (!want && !problems.length) problems.push('There is no release tag yet, so the next version cannot be counted from one; give version.')
  else if (want && !parseVersion(want)) problems.push(`"${want}" is not a version (major.minor.patch, with an optional -prerelease).`)
  else if (want) {
    if (s.tags.some((t) => t.version === want)) problems.push(`${cfg.tagPrefix}${want} is tagged already; a release tag is never moved.`)
    else if (s.last && compareVersions(want, s.last.version) <= 0) problems.push(`${want} is not after ${s.last.name}, the newest release tag.`)
  }
  s.version = want
  s.tag = want ? `${cfg.tagPrefix}${want}` : null
  s.tagged = null
  if (s.last && !s.notesFrom) {
    problems.push(`${s.last.name}, the newest release tag, is not on ${s.main}'s history, so what comes after it cannot be told.`)
    return { problems, lines: [], nothing: false }
  }
  const log = (await git(s.root, ['rev-list', '--first-parent', '-n', String(WALK_LIMIT), s.tip, ...(s.lastSha ? [`^${s.lastSha}`] : [])])).split('\n').filter(Boolean)
  if (!log.length) {
    problems.push(`Nothing landed on ${s.main} since ${s.last.name}; there is nothing to release.`)
    return { problems, lines: [], nothing: true }
  }
  let at = -1
  let evidence = null
  let why = null
  if (commit !== undefined) {
    const named = String(commit).trim()
    const sha = /^[0-9a-f]{4,40}$/i.test(named) ? await git(s.root, ['rev-parse', '--verify', '--quiet', `${named}^{commit}`]).then((t) => t.trim(), () => null) : null
    if (!sha) problems.push(`"${named}" is not a commit this checkout has; fetch ${s.remote} first, and give its id.`)
    else if ((at = log.indexOf(sha)) === -1) problems.push(`${short(sha)} is not a commit of ${s.main}'s history (first parents) after ${s.last?.name ?? 'the start'}, so it cannot be released.`)
    else if ((why = await notTagScheme(s, cfg, sha))) {
      problems.push(`${short(sha)} ${why}`)
      at = -1
    } else {
      evidence = await ci(sha, { own: true })
      if (!releasable(evidence)) problems.push(`CI on ${s.main} at ${short(sha)} is not fully green: ${evidence.verdict !== 'green' ? evidence.summary : "its run did not run the full tier (the full tier's check did not pass)"}.`)
    }
  } else {
    let first = null
    // A commit that still declares the version (from before the switch, or in a form that cannot be read) is passed over: the
    // guard refuses a tag on it, and its number would be spent on a tag that never publishes (#1501 review item 1)
    const looked = Math.min(log.length, CANDIDATE_LOOK)
    let passed = 0
    let reason = null
    for (let i = 0; i < looked; i++) {
      if ((why = await notTagScheme(s, cfg, log[i]))) {
        passed++
        reason ??= `${short(log[i])} ${why}`
        continue
      }
      const r = await ci(log[i], { own: true })
      first ??= { sha: log[i], r }
      if (releasable(r)) {
        at = i
        evidence = r
        break
      }
    }
    if (at === -1 && passed === looked)
      problems.push(`No commit of ${s.main} since ${s.last?.name ?? 'the start'} is under the tag scheme yet (looked at the newest ${plural(looked, 'commit')}; ${reason}). A tag on one would be refused by the release workflow's guard; wait for a commit after the switch.`)
    else if (at === -1)
      problems.push(
        `No commit of ${s.main} since ${s.last?.name ?? 'the start'} has a fully green push run of its own yet (looked at the newest ${plural(looked, 'commit')}${passed ? `, ${passed} of them still declaring the version` : ''}; ${first ? `${short(first.sha)}: ${first.r.summary}` : 'none read'}). Wait for ${s.main}'s CI, or name a commit.`,
      )
  }
  s.at = at === -1 ? s.tip : log[at]
  s.behind = Math.max(at, 0)
  if (s.lastSha) {
    s.notes = releaseNotes(await subjects(s.root, s.lastSha, s.at))
    s.after = s.at === s.tip ? [] : releaseNotes(await subjects(s.root, s.at, s.tip))
  }
  const lines = at === -1 || problems.length ? [] : [`CI: ${s.main}'s own push run on ${short(s.at)} is green, the full tier included.`]
  return { problems, lines, nothing: false }
}

/** The annotated tag's message under the tag scheme: the release notes, its only record (#1501, owner default 2026-10-24) */
function tagMessage(s) {
  const merged = s.notesFrom ? (s.notes.length ? [`Merged since ${s.notesFrom}:`, '', ...s.notes.map((n) => `- ${n}`)] : [`Nothing merged since ${s.notesFrom}.`]) : []
  return [`Centralu ${s.version}`, '', ...merged].join('\n')
}

/** Where the release commit stands against main, in words */
const standing = (s) => (s.at === s.tip ? `${s.main}'s head` : `${plural(s.behind, 'commit')} behind ${s.main} at ${short(s.tip)}`)

/** The checkout must be clean. Answers the problems. */
async function checkoutProblems(s) {
  const dirty = await changes(s.root)
  return dirty.length ? [`The checkout at ${s.root} has ${plural(dirty.length, 'uncommitted change')} (${list(dirty)}); commit or put them away first, so what is released is what is committed.`] : []
}

/**
 * Every publication approval judges the bytes under the immutable tag, not a later merge: the tagged commit's own CI
 * must be green, and no pull request's run stands for it. `later` says the CI may still turn green by itself
 * (pending, or not reported yet), which a waiting approve waits out.
 */
async function approvalCi(s, tagSha, ci) {
  // The required set of the tagged commit's own workflows: main's may name jobs it never had (#1035)
  const r = await ci(tagSha, { own: true })
  const lines = [`The tagged commit's own CI at ${short(tagSha)}: ${r.verdict}.`]
  const cancelled = (r.cancelledRuns ?? []).map((run) => `The build for ${tagSha} was cancelled${tagSha !== s.tip ? ' by a newer push' : ''}; re-run it: gh run rerun ${run.id} --repo ${s.repo}`)
  // Every build run on the commit completed and a required check is still missing: it never will report
  const stuck = !cancelled.length && r.verdict === 'pending' && r.settled && !r.running && r.missing?.length > 0
  const problems = cancelled.length
    ? cancelled
    : r.verdict === 'green'
      ? []
      : [
          `The tagged commit's own CI at ${short(tagSha)} must be green before npm-publish approval: ${r.summary}. PR evidence cannot authorize publication.`,
          ...(stuck ? [`Its build runs have all completed without reporting ${list(r.missing)}, so waiting will not bring them; look at the run, or re-run it.`] : []),
        ]
  return { problems, later: !cancelled.length && !stuck && (r.verdict === 'pending' || r.verdict === 'none'), lines: [...lines, ...cancelled] }
}

/**
 * Before the shim's approval: every other job of the run succeeded, and every package
 * `release.registry.packages` names (but the shim) is on the registry at this version, published from
 * the tagged commit. The workflow's `needs` and release-npm.mts check the same; this says it before the
 * approval rather than after it. `later`: what may still come by itself (a package not visible yet,
 * a registry that did not answer).
 */
async function shimGate(s, cfg, all, jobs, tagSha, version, registry) {
  // `final`: what does not mend itself (a failed job, a package from other code), so nothing to wait for
  const final = []
  const pending = []
  const others = all.filter((j) => !jobs.includes(j.name))
  const failed = others.filter((j) => j.status === 'completed' && j.conclusion !== 'success')
  const unfinished = others.filter((j) => j.status !== 'completed')
  if (failed.length) final.push(`Not every platform job succeeded (${list(failed.map((j) => `${j.name}: ${j.conclusion}`))}); the shim may not go out before all of them have.`)
  if (unfinished.length) pending.push(`Platform jobs still running: ${list(unfinished.map((j) => j.name))}.`)
  const names = []
  for (const path of filesNamed(cfg.registry.packages, await filesAt(s.root, tagSha)).filter((p) => p !== cfg.registry.shim)) {
    const name = JSON.parse((await showFile(s.root, tagSha, path)) ?? '{}').name
    if (name) names.push(name)
  }
  if (!names.length) final.push(`No package.json at ${short(tagSha)} matches project.json release.registry.packages, so the registry cannot be checked.`)
  const missing = []
  for (const name of names) {
    let p
    try {
      p = await registry(name, version)
    } catch (e) {
      pending.push(`The registry did not answer for ${name}@${version}: ${e.message}`)
      continue
    }
    if (p.state === 'absent') missing.push(name)
    else if (p.gitHead !== tagSha) final.push(`${name}@${version} is on the registry from ${p.gitHead ? short(p.gitHead) : 'an unknown commit'}, not from ${short(tagSha)}; the shim would pin other code. Bump to the next prerelease.`)
  }
  if (missing.length) pending.push(`Not on the registry at ${version} yet: ${list(missing)}.`)
  const problems = [...final, ...pending]
  return { problems, later: !final.length, lines: problems.length ? [] : [`Before the shim: every other job of the run succeeded, and the ${plural(names.length, 'package')} it needs are on the registry at ${version} from ${short(tagSha)}.`] }
}

/** A commit's tree, fetched by its id; null when the remote does not give it. */
async function remoteTree(s, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return null
  try {
    const [c] = await fetchRefs(s.root, s.remote, [sha], `refs/centralu-release/${process.pid}-${++calls}`)
    return await treeOf(s.root, c)
  } catch {
    return null
  }
}

/**
 * The rehearsals that count for the release commit, newest first: those on it, and those on its rehearsal branch
 * (`branchPrefix` + the version) at a commit with the same tree (#1035). A rehearsal on a later main commit does not count:
 * a different tree is not what will be tagged (#1350). Under the tag scheme the tree says nothing of the version (#1501):
 * a rehearsal counts for the version it was named after.
 */
async function rehearsalsFor(s, cfg, gh) {
  const file = workflowFile(cfg)
  const branch = `${cfg.branchPrefix}${s.version}`
  const onTip = await gh.workflowRuns(s.repo, file, { event: 'workflow_dispatch', headSha: s.at })
  const onBranch = (await gh.workflowRuns(s.repo, file, { event: 'workflow_dispatch', branch })).filter((r) => r.headBranch === branch && r.headSha !== s.at)
  const same = []
  if (onBranch.length) {
    const tree = await treeOf(s.root, s.at)
    const trees = new Map()
    for (const r of onBranch) {
      if (!trees.has(r.headSha)) trees.set(r.headSha, await remoteTree(s, r.headSha))
      if (trees.get(r.headSha) === tree) same.push(r)
    }
  }
  const at = (r) => Date.parse(r.createdAt ?? '') || 0
  return [...onTip, ...same].filter((r) => r.title === rehearsalTitle(s.version)).sort((a, b) => at(b) - at(a) || Number(b.id) - Number(a.id))
}

/** The name release.yml's `run-name` gives a rehearsal of `version` */
const rehearsalTitle = (version) => `rehearse ${version}`

/** Where a rehearsal ran, said against main's commit. */
const rehearsedOn = (s, r) => (r.headSha === s.at ? short(s.at) : `${short(r.headSha)} on ${r.headBranch}, the same tree as ${s.main} at ${short(s.at)}`)

/** What GitHub says about the release workflow's runs on main's commit (or its tree) and for the tag. */
async function runsFor(s, cfg, gh) {
  const file = workflowFile(cfg)
  // Only an untagged version is still rehearsed
  const rehearsals = s.tagged ? [] : await rehearsalsFor(s, cfg, gh)
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
  const after = s.after?.length ? [`Not in this release (merged after the release commit ${short(s.at)}, ${s.after.length}):`, ...s.after.map((n) => `- ${n}`)] : []
  return [...(s.notes.length ? [`Merged since ${s.notesFrom} (${s.notes.length}):`, ...s.notes.map((n) => `- ${n}`)] : [`Nothing merged since ${s.notesFrom}.`]), ...after]
}

// --- status -------------------------------------------------------------------------------------------

/** Whether the shim (`release.registry.shim` at `sha`) is on the registry at `version`; false when it cannot be told. */
async function shimPublished(s, cfg, registry, sha, version) {
  try {
    const name = JSON.parse((await showFile(s.root, sha, cfg.registry.shim)) ?? '{}').name
    return Boolean(name && registry) && (await registry(name, version)).state === 'present'
  } catch {
    return false
  }
}

/**
 * Under the tag scheme, whether the newest tag (`s.tagged`, before `nextRelease` moves on) is released: its release run
 * succeeded, or its shim is on the registry (a run GitHub no longer lists, a release published by hand). Until then status
 * follows it, and rehearse and tag refuse the next version, which the guard would refuse while it publishes (#1501 review item 4).
 */
async function newestTagDone(s, cfg, gh, registry) {
  const runs = await gh.workflowRuns(s.repo, workflowFile(cfg), { event: 'push', headSha: s.tagged.sha })
  return runs.some((r) => r.headBranch === s.tag && r.status === 'completed' && r.conclusion === 'success') || (await shimPublished(s, cfg, registry, s.tagged.sha, s.version))
}

/** The tag scheme's refusal while the newest tag is still being released; empty once it is done (or there is none). */
async function stillPublishing(s, cfg, gh, registry) {
  if (!s.tagged || (await newestTagDone(s, cfg, gh, registry))) return []
  return [`${s.tag}, the newest release tag, is not released yet: its release run has not succeeded and its shim is not on the registry. Finish it (release step approve) or abandon it first; the release workflow's guard refuses a newer tag until the previous version is on the registry.`]
}

/** Where the release stands and the next step. Read-only. */
export async function releaseStatus({ repo, dir, cfg, gh, ci, registry }) {
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const lines = []
  // Status follows the newest tag until its release run has succeeded, then the next release (#1501)
  let next = null
  if (!s.tagged || (await newestTagDone(s, cfg, gh, registry))) {
    if (s.tagged) lines.push(`${s.tag} is released.`)
    next = await nextRelease(s, cfg, ci)
  } else {
    // The release commit (#1350) is the tagged one once tagged
    s.at = s.tagged.sha
    s.behind = (await isAncestor(s.root, s.at, s.tip).catch(() => false)) ? await commitCount(s.root, `${s.at}..${s.tip}`).catch(() => 0) : 0
  }
  const evidence = next ? { problems: next.problems, lines: next.lines } : await approvalCi(s, s.tagged.sha, ci)
  if (s.tagged || (next && !next.problems.length)) lines.push(`Release commit: ${short(s.at)}, ${s.tagged ? 'tagged ' + s.tag + ', ' : ''}${standing(s)}.`)
  lines.push(...evidence.lines)
  const local = await checkoutProblems(s)
  lines.push(local.length ? `Checkout: ${local.join(' ')}` : `Checkout: clean.`)
  const runs = await runsFor(s, cfg, gh)
  const duplicates = await cancellableDuplicates(repo, runs.duplicates, gh)
  let phase
  const nothing = next?.nothing === true
  next = null
  if (nothing) {
    phase = 'released'
    next = `${s.last.name} is released; nothing landed on ${s.main} since.`
  } else if (s.tagged) {
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
      next = `${s.version} is released.`
    } else {
      phase = 'failed'
      lines.push(`Release run for ${s.tag}: ${runState(r)}${r.url ? `, ${r.url}` : ''}.`)
      next = 'Re-run the failed jobs of that run (docs/releasing.md, "When a job fails halfway").'
    }
  } else {
    phase = 'ready-to-tag'
    const rh = runs.rehearsal
    lines.push(rh ? `Rehearsal on ${rehearsedOn(s, rh)}: ${runState(rh)}${rh.url ? `, ${rh.url}` : ''}.` : `No rehearsal on ${short(s.at)} yet.`)
    next =
      rh?.conclusion === 'success'
        ? `Tag ${s.tag} with release step tag (confirm: true).`
        : rh && rh.status !== 'completed'
          ? 'Wait for the rehearsal; call release_status again.'
          : `Rehearse with release step rehearse (confirm: true), then tag ${s.tag}.`
  }
  if (evidence.problems.length && !nothing && (!s.tagged || !['released', 'failed'].includes(phase))) next = `${s.tagged ? 'Wait for green CI' : 'Not releasable yet'}: ${evidence.problems.join(' ')}`
  if (duplicates.length) {
    const safe = duplicates.filter((d) => d.safe)
    lines.push(`Duplicate release runs for ${s.tag}: ${duplicates.map((d) => d.run.url ?? d.run.id).join(', ')}.`)
    if (safe.length) lines.push(`Before anything publishes, cancel a duplicate with release step cancel_duplicate (run: ${safe[0].run.id}, confirm: true).`)
  }
  lines.push(...notesLines(s))
  const what = { tagged: `tagged ${s.tag}`, 'waiting-approval': `${s.tag} is waiting for approval`, publishing: `${s.tag} is being published`, released: `released as ${s.tag ?? s.last?.name}`, failed: `the ${s.tag} release run failed`, 'ready-to-tag': `not tagged yet (last release ${s.last?.name ?? 'none'})` }[phase]
  const summary = `${s.main} at ${short(s.tip)}: ${nothing ? `released as ${s.last.name}` : s.tagged ? what : `the next release is ${s.version ?? '(no version)'}${s.at !== s.tip ? ` from ${short(s.at)}, ${standing(s)}` : ''}, ${what}`}. Next: ${next}`
  return { summary, lines, phase, version: s.version, tag: s.tag, head: s.tip, releaseCommit: s.at, behind: s.behind, notes: s.notes, after: s.after, duplicates: duplicates.map((d) => ({ id: d.run.id, url: d.run.url, safeToCancel: d.safe })) }
}

// --- rehearse -----------------------------------------------------------------------------------------

const RUN_LOOKS = 5
const RUN_LOOK_MS = Number(process.env.PROJECT_BOARD_RUN_LOOK_MS) || 3_000

async function findRun(gh, repo, file, filter, match, after) {
  for (let i = 0; i < RUN_LOOKS; i++) {
    const run = (await gh.workflowRuns(repo, file, filter)).find((r) => match(r) && (!after || !r.createdAt || Date.parse(r.createdAt) >= after - 60_000))
    if (run) return run
    if (i < RUN_LOOKS - 1) await sleep(RUN_LOOK_MS)
  }
  return null
}

/**
 * The rehearsal: the release workflow by hand, with its dry-run input and the version. Builds and packs, publishes
 * nothing. The next version on the newest fully green commit since the newest tag (#1501).
 */
export async function rehearseRelease({ repo, dir, cfg, gh, ci, permissions, registry }, { version, commit, confirm = false }) {
  if (!canMerge(permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const publishing = await stillPublishing(s, cfg, gh, registry)
  const nr = await nextRelease(s, cfg, ci, { version, commit })
  const evidence = { problems: [...publishing, ...nr.problems], lines: nr.lines }
  const problems = [...evidence.problems]
  // Off main's head the workflow cannot be dispatched by commit: it runs on a branch at that commit, which must not hold another tree
  const branch = `${cfg.branchPrefix}${s.version}`
  let onBranch = null
  if (s.at !== s.tip) {
    onBranch = (await remoteRefs(s.root, s.remote, 'refs/heads/')).find((b) => b.name === branch) ?? null
    if (onBranch && onBranch.sha !== s.at && (await remoteTree(s, onBranch.sha)) !== (await treeOf(s.root, s.at)))
      problems.push(`The branch ${branch} on ${s.remote} (${short(onBranch.sha)}) holds another tree than the release commit ${short(s.at)}; delete it, then rehearse again.`)
  }
  if (problems.length) throw new ReleaseRefusal(problems)
  const file = workflowFile(cfg)
  const { rehearsal } = await runsFor(s, cfg, gh)
  if (rehearsal && (rehearsal.status !== 'completed' || rehearsal.conclusion === 'success'))
    return { summary: `A rehearsal on ${rehearsedOn(s, rehearsal)} ${runState(rehearsal)}${rehearsal.url ? `: ${rehearsal.url}` : ''}; not starting another.`, lines: evidence.lines, started: false, run: rehearsal.url }
  // The version is an input: nothing in the tree says it (#1501)
  const dispatched = { ...cfg.rehearsalInputs, version: s.version }
  const inputs = Object.entries(dispatched).map(([k, v]) => `${k}=${v}`).join(', ')
  if (!confirm)
    return {
      summary:
        s.at === s.tip
          ? `Ready to rehearse ${s.version} on ${s.main} at ${short(s.tip)} (${file} with ${inputs}; builds and packs, publishes nothing, asks no approval). Call again with confirm: true to start it.`
          : `Ready to rehearse ${s.version} on the release commit ${short(s.at)}, ${standing(s)} (${file} on ${branch}${onBranch ? '' : `, which is made at that commit`} with ${inputs}; builds and packs, publishes nothing, asks no approval). Call again with confirm: true to start it.`,
      lines: evidence.lines,
      started: false,
    }
  const at = clock()
  let ref = s.main
  if (s.at !== s.tip) {
    if (!onBranch) {
      try {
        await pushRef(s.root, s.remote, s.at, `refs/heads/${branch}`)
      } catch (e) {
        throw new ReleaseRefusal([`Pushing ${branch} at ${short(s.at)} failed, so no rehearsal was started: ${e.message}`])
      }
      evidence.lines.push(`Pushed ${short(s.at)} to ${branch} on ${s.remote}, to rehearse on.`)
    }
    ref = branch
  }
  await gh.dispatchWorkflow(repo, file, ref, dispatched)
  // On a leftover rehearsal branch the run's commit is the branch's, with the release commit's tree
  const run = await findRun(gh, repo, file, { event: 'workflow_dispatch', headSha: onBranch?.sha ?? s.at }, (r) => r.title === rehearsalTitle(s.version), at)
  return {
    summary: `Started the rehearsal of ${s.version} on ${short(s.at)}${s.at === s.tip ? '' : ` (${standing(s)}, on ${branch})`}${run?.url ? `: ${run.url}` : `; GitHub does not list the run yet, look at ${file}'s runs`}. Tag once it succeeds.`,
    lines: evidence.lines,
    started: true,
    run: run?.url ?? null,
  }
}

// --- tag ----------------------------------------------------------------------------------------------

/** The tag is the release: pushed on main's commit once everything says that commit is the one. */
export async function tagRelease({ repo, dir, cfg, gh, ci, permissions, registry }, { version, commit, skipRehearsal = false, confirm = false }) {
  if (!canMerge(permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  const problems = await checkoutProblems(s)
  // The version after the newest tag, on a commit of main since it whose own push run is fully green (#1501): the
  // guard of the release run checks the same descent and the registry again, for a tag pushed by hand too
  const publishing = await stillPublishing(s, cfg, gh, registry)
  const nr = await nextRelease(s, cfg, ci, { version, commit })
  const evidence = { problems: [...publishing, ...nr.problems], lines: nr.lines }
  problems.push(...evidence.problems)
  const located = !evidence.problems.length
  const { rehearsal } = await runsFor(s, cfg, gh)
  if (!skipRehearsal && !s.tagged && located) {
    if (!rehearsal) problems.push(`No rehearsal ran on ${short(s.at)} or on its rehearsal branch at the same tree: rehearse first (release step rehearse), or pass skipRehearsal: true to tag without one.`)
    else if (rehearsal.status !== 'completed') problems.push(`The rehearsal on ${rehearsedOn(s, rehearsal)} is still running${rehearsal.url ? ` (${rehearsal.url})` : ''}; tag once it succeeds.`)
    else if (rehearsal.conclusion !== 'success') problems.push(`The rehearsal on ${rehearsedOn(s, rehearsal)} ${runState(rehearsal)}${rehearsal.url ? ` (${rehearsal.url})` : ''}; fix that first, or pass skipRehearsal: true.`)
  }
  if (problems.length) throw new ReleaseRefusal(problems)

  const lines = [
    ...evidence.lines,
    `${s.at === s.tip ? `${s.main} at ${short(s.tip)}` : `The release commit ${short(s.at)} (${standing(s)})`}: CI green, after ${s.last?.name ?? 'no earlier release'}; the build stamps ${s.version} from the tag.`,
    skipRehearsal ? 'Rehearsal: skipped (skipRehearsal: true).' : `Rehearsal: succeeded on ${rehearsedOn(s, rehearsal)}${rehearsal?.url ? `, ${rehearsal.url}` : ''}.`,
    ...notesLines(s),
  ]
  if (!confirm)
    return {
      summary: `Ready to tag ${s.tag} on ${short(s.at)}${s.at === s.tip ? '' : ` (${standing(s)})`}; nothing pushed yet. The tag is the release: the workflow publishes after approval on ${cfg.environment}. Call again with confirm: true to push it.`,
      lines,
      tagged: false,
    }
  try {
    // An annotated tag: its message is the release notes, their only record (#1501). Made in the object store only, and pushed by id
    await pushRef(s.root, s.remote, await tagObject(s.root, s.at, s.tag, tagMessage(s)), `refs/tags/${s.tag}`)
  } catch (e) {
    throw new ReleaseRefusal([`Pushing ${s.tag} failed, so nothing was released: ${e.message}`])
  }
  lines.push(`Pushed ${s.tag} on ${short(s.at)} to ${s.remote}.`)
  // The branch `rehearse` made at the release commit has done its work; the tag keeps the commit
  const rehearsalBranch = `${cfg.branchPrefix}${s.version}`
  const made = (await remoteRefs(s.root, s.remote, 'refs/heads/').catch(() => [])).find((b) => b.name === rehearsalBranch)
  if (made?.sha === s.at) {
    try {
      await deleteRemoteBranch(s.root, s.remote, rehearsalBranch)
      lines.push(`Deleted ${rehearsalBranch} on ${s.remote}: it was made at the release commit only to rehearse on.`)
    } catch (e) {
      lines.push(`${rehearsalBranch} on ${s.remote} could not be deleted (${e.message}); it holds only the release commit, delete it by hand.`)
    }
  }
  const run = await findRun(gh, repo, workflowFile(cfg), { event: 'push', headSha: s.at }, (r) => r.headBranch === s.tag)
  return {
    summary: `Tagged ${s.tag} on ${short(s.at)}${s.at === s.tip ? '' : ` (${standing(s)})`}. ${run?.url ? `The release run: ${run.url}.` : `GitHub does not list the release run yet; look at ${workflowFile(cfg)}'s runs.`} It waits for approval on ${cfg.environment}: the platform jobs first, then the shim. Next: release step approve, or approve on GitHub.`,
    lines,
    tagged: true,
    run: run?.url ?? null,
  }
}

// --- approve ------------------------------------------------------------------------------------------

// approve with wait (#1035): how long it may wait for the gate by default and at most, and how often it
// reads it again. Centralu keeps the call alive while it reports progress (docs/apps.md §5).
const APPROVE_WAIT_MINUTES = 45
const APPROVE_WAIT_MAX_MINUTES = 60
// PROJECT_BOARD_CI_POLL_MS: for the tests only
const APPROVE_POLL_MS = Number(process.env.PROJECT_BOARD_CI_POLL_MS) || 30_000

/**
 * The environment approval of the tag's release run (owner decision, 2026-10-06: the maintainer's
 * agent drives the release end to end, approvals included, every step shown). Only that run, only the
 * configured environment, only what GitHub says this login may approve.
 */
export async function approveRelease(ctx, { version, comment, confirm = false, wait = false, waitMinutes }, { signal, progress = () => {} } = {}) {
  if (!canMerge(ctx.permissions)) throw new ReleaseRefusal([NOT_MAINTAINER])
  const waiting = wait && confirm
  const limitMs = Math.min(APPROVE_WAIT_MAX_MINUTES, Math.max(0, Number(waitMinutes ?? APPROVE_WAIT_MINUTES) || 0)) * 60_000
  const started = clock()
  const cancelled = { summary: 'Not approved: cancelled while waiting for the gate.', lines: [], approved: false, cancelled: true }
  // What the first read found (version, tagged commit, run): a wait approves only that, never what replaced it
  let pin = null
  for (let beat = 1; ; beat++) {
    const g = await approvalGate(ctx, version, pin)
    if (g.answer) return g.answer
    if (g.refuse) throw new ReleaseRefusal(g.refuse)
    pin = g.pin ?? pin
    if (g.ready) {
      const { run, pending, tag, what, last, lines } = g.ready
      if (!confirm) return { summary: `${tag}'s release run waits for approval on ${ctx.cfg.environment} (${what}); nothing approved yet. Call again with confirm: true to approve, or approve on GitHub: ${run.url}`, lines, approved: false, run: run.url }
      // A call cancelled while the gate was read last approves nothing
      if (signal?.aborted) return cancelled
      await ctx.gh.approveDeployments(ctx.repo, run.id, [...new Set(pending.map((p) => p.environmentId))], String(comment ?? '').trim() || `Approved through the project board's release tool for ${tag}.`)
      const after = waiting && beat > 1 ? ` after ${span(clock() - started)} of waiting for the gate` : ''
      return { summary: `Approved ${ctx.cfg.environment} for ${tag} (${what})${after}${run.url ? `: ${run.url}` : ''}.${last ? '' : ' The shim asks again once every platform job succeeds: approve with wait: true to approve it the moment it may go.'}`, lines, approved: true, run: run.url }
    }
    // Not yet: without waiting, answered as the step always has; waiting, read everything again later
    const { problems, answer, why } = g.later
    if (!waiting) {
      if (problems) throw new ReleaseRefusal(problems)
      return answer
    }
    if (clock() - started + APPROVE_POLL_MS > limitMs)
      return { summary: `Not approved: the gate did not pass within ${span(limitMs)} of waiting, so nothing was approved. Still: ${why} Call again with wait: true to wait longer, or look at the run.`, lines: problems ?? [], approved: false, timedOut: true, run: answer?.run ?? null }
    progress(beat, `Waiting to approve (${span(clock() - started)} so far): ${why}`)
    if (!(await sleep(APPROVE_POLL_MS, signal))) return cancelled
  }
}

/**
 * The approval's gate, read fresh: `answer` (nothing to approve, for good), `refuse` (problems that do
 * not mend themselves), `later` (not yet: what a plain call answers or refuses with, and what a
 * waiting one waits on) or `ready` (approve now). `pin`: the version, tagged commit and run an earlier
 * read of the same wait found; anything else now refuses. Each answer but `refuse` carries the pin.
 */
async function approvalGate({ repo, dir, cfg, gh, ci, registry }, version, pin) {
  const s = { repo, ...(await readState({ repo, dir, cfg, gh })) }
  // A tag pushed meanwhile changes the newest version, not the one this wait is for
  const want = pin ? pin.want : version !== undefined ? String(version).replace(/^v/, '') : s.version
  const tag = `${cfg.tagPrefix}${want}`
  const t = s.tags.find((x) => x.name === tag)
  if (!t) return { refuse: [`${tag} is not tagged; there is no release run to approve.`] }
  if (pin && t.sha !== pin.sha) return { refuse: [`${tag} moved from ${short(pin.sha)} to ${short(t.sha)} while waiting; nothing was approved. A release tag is never moved: look at what happened before approving anything.`] }
  const candidates = (await gh.workflowRuns(repo, workflowFile(cfg), { event: 'push', headSha: t.sha })).filter((r) => r.headBranch === tag)
  let run = candidates.find((r) => r.status !== 'completed') ?? candidates[0]
  for (const r of candidates.filter((x) => x.status !== 'completed')) if ((await gh.pendingDeployments(repo, r.id)).some((p) => p.environment === cfg.environment)) { run = r; break }
  if (!run) {
    const why = `GitHub lists no ${workflowFile(cfg)} run for ${tag} (${short(t.sha)}).`
    return { later: { problems: [why], why }, pin: { want, sha: t.sha, runId: null } }
  }
  if (pin?.runId && Number(run.id) !== Number(pin.runId)) return { refuse: [`The release run for ${tag} is now ${run.id}, not run ${pin.runId} this wait started on; nothing was approved. Look at both runs before approving.`] }
  const pinned = { want, sha: t.sha, runId: run.id }
  if (run.headSha !== t.sha) return { refuse: [`The run for ${tag} is on ${short(run.headSha)}, but ${tag} is ${short(t.sha)}.`] }
  if (run.status === 'completed') return { answer: { summary: `The release run for ${tag} ${runState(run)}${run.url ? `: ${run.url}` : ''}; nothing waits for approval.`, lines: [], approved: false, run: run.url } }
  const pending = (await gh.pendingDeployments(repo, run.id)).filter((p) => p.environment === cfg.environment)
  if (!pending.length) {
    const summary = `The release run for ${tag} is ${runState(run)}; nothing waits for approval on ${cfg.environment} now${run.url ? `: ${run.url}` : ''}.`
    return { later: { answer: { summary, lines: [], approved: false, run: run.url }, why: summary }, pin: pinned }
  }
  const cannot = pending.filter((p) => !p.canApprove)
  if (cannot.length) return { refuse: [`GitHub says this login may not approve ${cfg.environment} for this run${cannot[0].reviewers.length ? ` (reviewers: ${cannot[0].reviewers.join(', ')})` : ''}. Approve on GitHub: ${run.url}`] }
  // One read of the jobs decides which approval this is; GitHub may show the environment waiting
  // before it lists the job that waits on it
  const all = await gh.runJobs(repo, run.id)
  const jobs = all.filter((j) => j.status === 'waiting').map((j) => j.name)
  if (!jobs.length) {
    const why = `GitHub says the release run for ${tag} waits on ${cfg.environment} but lists no waiting job yet, so which approval it is cannot be told.`
    return { later: { problems: [why], why }, pin: pinned }
  }
  const what = list(jobs)
  const last = jobs.every((j) => /shim/i.test(j))
  const evidence = await approvalCi(s, t.sha, ci)
  const shim = last ? await shimGate(s, cfg, all, jobs, t.sha, want, registry) : { problems: [], later: true, lines: [] }
  const problems = [...evidence.problems, ...shim.problems]
  if (problems.length) return (evidence.problems.length && !evidence.later) || !shim.later ? { refuse: problems } : { later: { problems, why: problems.join(' ') }, pin: pinned }
  const lines = [...evidence.lines, ...shim.lines, `Waiting on ${cfg.environment}: ${what}.`, ...(last ? ['This is the shim: the last moment anything is reversible (docs/releasing.md).'] : [])]
  return { ready: { run, pending, tag, what, last, lines }, pin: pinned }
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
