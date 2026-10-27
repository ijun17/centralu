// The integrator (#1259 step 3): a change whose risk tier is auto lands without its session opening a
// pull request. The session pushes a branch made from main and hands it over (`integrate`,
// queue-tools.mjs); the integrator judges the tier itself, opens a pull request as the record, and
// queues it, so the merge queue lands it on its own path: kept on main (conflicts as for any item), the
// fast gate (a batch's quick tier), the squash "Title (#N)", the session's notices, the main guard.
//
// The judge: never the session's word, nor its checkout. Main and the branch are fetched from GitHub
// into the queue's checkout (refs of its own, removed again; the checkout's branches and work are not
// touched), and main's own scripts/tier.mjs runs with main's .centralu/tiers.json over what the branch
// adds since it left main. A judge or rules missing on main, a branch not on GitHub, or anything else
// that keeps the change from being judged answers deep, so it is refused, never let through.
import { execFile } from './system.mjs'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchRefs, git, GitError, remoteFor, remoteHas, showFile, topLevel } from './git.mjs'
import { GitHubError } from './github.mjs'
import { short } from './util.mjs'

/** main's judge and rules (#1259 step 2) */
export const TIER_SCRIPT = 'scripts/tier.mjs'
export const TIER_RULES = '.centralu/tiers.json'
/** How long main's judge may take over one change */
const JUDGE_MS = 60_000

/** A change that could not be judged: deep, with why (the session hears it as the reason it is refused). */
const unjudged = (why, extra = {}) => ({ tier: 'deep', unjudged: why, line: `Tier: deep (${why}).`, because: [], counts: {}, ...extra })

/**
 * Runs main's judge (its text, `script`) in the checkout `root`: its JSON answer, or `{ failed }` with what it said.
 * From a real path: the judge runs its main only when its own URL is the path it was started by, and Node gives the
 * URL of the real path, so through a link (macOS's /var is /private/var) it would print nothing at all.
 */
async function runJudge(root, script, base, head) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'centralu-integrate-')))
  try {
    const file = join(tmp, 'tier.mjs')
    await writeFile(file, script)
    const { stdout, stderr, error } = await new Promise((resolve) => {
      execFile(process.execPath, [file, '--base', base, '--head', head, '--json'], { cwd: root, timeout: JUDGE_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, out, err) =>
        resolve({ stdout: String(out ?? ''), stderr: String(err ?? ''), error }),
      )
    })
    try {
      return JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
    } catch {
      const said = stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
      return { failed: `it exited ${error?.code ?? 0}${said ? `: ${said.slice(0, 200)}` : ' and printed no answer'}` }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The tier of what `branch` adds over `defaultBranch`, both as GitHub has them now, judged by main's
 * judge and rules in the checkout `dir`. `head`: the commit to judge when it is not the branch's tip
 * (a head the queue read a moment ago; it must be in what was fetched). Answers `{ tier, line,
 * because, counts, main, head, files }`, `unjudged` (why) when it is deep for want of a judgment, and
 * `missing` when the branch is not on GitHub.
 */
export async function judgeBranch({ dir, repo, branch, defaultBranch, head: want = null }) {
  if (!dir) return unjudged('the integrator has no checkout to judge it in (project.json queue.conflicts.checkout)', { setup: true })
  let root
  try {
    root = await topLevel(dir)
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    return unjudged(`${dir} is not a git checkout (${e.message})`, { setup: true })
  }
  const remote = await remoteFor(root, repo)
  if (!remote) return unjudged(`the checkout at ${root} has no remote for github.com/${repo}`, { setup: true })
  // A space of its own per call: the tool and a driver may judge at once
  const space = `refs/centralu-integrate/${process.pid}-${randomBytes(3).toString('hex')}`
  let main
  try {
    ;[main] = await fetchRefs(root, remote, [`refs/heads/${defaultBranch}`], `${space}/main`)
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    return unjudged(`${defaultBranch} could not be fetched (${e.message})`, { retry: true })
  }
  // Not there is the session's to fix; anything else (no network, GitHub down) is worth a try again. Which one is
  // git's exit code (`remoteHas`), never the text it printed
  let there
  try {
    there = await remoteHas(root, remote, `refs/heads/${branch}`)
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    return unjudged(`the branch ${branch} could not be looked up (${e.message})`, { retry: true, main })
  }
  if (!there) return unjudged(`the branch ${branch} is not on GitHub`, { missing: true, main })
  let tip
  try {
    ;[tip] = await fetchRefs(root, remote, [`refs/heads/${branch}`], `${space}/head`)
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    // There a moment ago: gone since, or a failure of the moment; either way, judged again on the next try
    return unjudged(`the branch ${branch} could not be fetched (${e.message})`, { retry: true, main })
  }
  let head = tip
  if (want && want !== tip) {
    // Read a moment ago and moved since: judged only if what was fetched holds it
    try {
      await git(root, ['cat-file', '-e', `${want}^{commit}`])
      head = want
    } catch {
      return unjudged(`${short(want)} is no longer on ${branch} (now ${short(tip)})`, { main, head: want })
    }
  }
  const script = await showFile(root, main, TIER_SCRIPT)
  if (script === null) return unjudged(`${defaultBranch} at ${short(main)} has no ${TIER_SCRIPT}`, { main, head })
  if ((await showFile(root, main, TIER_RULES)) === null) return unjudged(`${defaultBranch} at ${short(main)} has no ${TIER_RULES}`, { main, head })
  const r = await runJudge(root, script, main, head)
  if (r.failed || typeof r.tier !== 'string') return unjudged(`${defaultBranch}'s ${TIER_SCRIPT} gave no answer (${r.failed ?? 'no tier in it'})`, { main, head })
  // The rules must be main's: a judge that fell back to the branch's own would let a change judge itself
  if (r.unjudged || r.rulesFrom !== main) return unjudged(r.unjudged ?? `the rules were not read from ${defaultBranch}`, { main, head })
  const files = Object.values(r.counts ?? {}).reduce((a, b) => a + b, 0)
  return { tier: r.tier, line: r.line, because: r.because ?? [], counts: r.counts ?? {}, main, head, files }
}

/** The files that put a change at its tier, for a refusal: `path (rules)` each, at most `max`. */
export function becauseLines(j, max = 12) {
  const lines = (j.because ?? []).slice(0, max).map((f) => `${f.path} (${f.mode ?? (f.rules?.length ? f.rules.join(', ') : 'no rule names it')}${f.tests ? `, as the test of ${f.tests}` : ''})`)
  const more = (j.because ?? []).length - lines.length
  return more > 0 ? [...lines, `and ${more} more`] : lines
}

const LABEL_TIERS = ['auto', 'light', 'deep', 'person']

/**
 * The highest tier a person or open_pr gave a pull request by its labels (tier:<name>), or null when it has none. Never
 * taken as lower than the judge's: a label only raises (#1259 review). An unknown tier:<name> is deep.
 */
export function labelTier(labels) {
  const names = (labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((l) => typeof l === 'string' && l.startsWith('tier:'))
  if (!names.length) return null
  return names.map((l) => (LABEL_TIERS.includes(l.slice(5)) ? l.slice(5) : 'deep')).reduce((a, b) => (LABEL_TIERS.indexOf(b) > LABEL_TIERS.indexOf(a) ? b : a))
}

/** Why a judged change is not the integrator's, in one sentence, and the normal path. */
export function notAutoText(j, branch) {
  const why = j.unjudged ? `it could not be judged: ${j.unjudged}, so it counts as deep` : `its tier is ${j.tier}, not auto`
  return `${branch}: ${why}. Only an auto-tier change (docs, fixture data, UI assets: .centralu/tiers.json) lands through integrate. Open a pull request (open_pr, after the review its tier asks for) and queue it (queue_merge).`
}

/** The record's Verified: the integrator's Tier line, from where, and how it lands. */
export function recordVerified(j, { branch, defaultBranch, owner, verified }) {
  return [
    String(verified ?? '').trim(),
    `${j.line} Judged by the integrator (#1259 step 3) from the diff of ${branch} at ${short(j.head)} against ${defaultBranch} at ${short(j.main)}, with ${defaultBranch}'s ${TIER_SCRIPT} and ${TIER_RULES}.`,
    `Handed over with the board's integrate${owner ? ` by ${owner}` : ''}: this pull request is the record. The merge queue lands it after the fast gate (a batch's quick tier on ${defaultBranch}, and the heavy jobs too when the batch changes the screen); an auto-tier change gets no review beyond the checks.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Why the queue does not land an integrated item at `head` (#1259 step 3): `j` is judgeBranch's answer for it, not
 * auto. As attention (kind `tier`) for the session that handed it over, with the files and what to do.
 */
export function tierReason(n, j, { branch, head }) {
  const files = becauseLines(j, 6)
  const why = j.unjudged ? `it could not be judged (${j.unjudged}), so it counts as deep` : `its tier is now ${j.tier}${files.length ? `, from ${files.join(', ')}` : ''}`
  return {
    kind: 'tier',
    text: `${n} was handed over with integrate as an auto-tier change, but at ${short(head)} ${why}. The queue lands nothing through integrate that is not auto. Take what is not auto out of ${branch} and push (the queue judges the new head), or take it out (unqueue), get the review its tier asks for, mark it ready and queue it with queue_merge, which lands it as a pull request of its tier.`,
  }
}

/**
 * Why the queue does not land an integrated item a label puts above auto (#1259 review): a tier:<name> label set by a
 * person (or open_pr) only raises, so the judge's auto does not outrank it. Null when its labels say auto or nothing.
 */
export function labelReason(n, labels) {
  const labelled = labelTier(labels)
  if (!labelled || labelled === 'auto') return null
  return { kind: 'tier', text: `${n} was handed over with integrate, but it is labelled tier:${labelled}, and the queue lands nothing through integrate above auto. Take the label off if it was wrong, or take it out (unqueue), get the review its tier asks for, mark it ready and queue it with queue_merge, which lands it as a pull request of its tier.` }
}

/**
 * An integrated item's head judged (#1259 step 3), as the queue keeps it on the item (`tierAt`): the head and main it
 * was judged at, the tier and its line, and the attention reason when it is not auto. One that could not be judged (a
 * fetch that failed, the branch gone, no checkout) throws, so the queue counts it as any failure to read an item: it
 * tries again, lands nothing meanwhile, and tells the session only after three in a row, not on a blip.
 */
export async function judgeHead({ dir, repo, n, pr, defaultBranch }) {
  const j = pr.isCrossRepository
    ? unjudged(`${n} is a fork's pull request, which integrate never lands`)
    : await judgeBranch({ dir, repo, branch: pr.headRefName, defaultBranch, head: pr.headRefOid })
  if (j.unjudged) throw new GitHubError('github', `the integrator could not judge ${n} at ${short(pr.headRefOid)}: ${j.unjudged}.`)
  const reason = j.tier === 'auto' ? null : tierReason(n, j, { branch: pr.headRefName, head: pr.headRefOid })
  return { head: pr.headRefOid, main: j.main ?? null, tier: j.tier, line: j.line, reason }
}
