// The other open pull requests `pnpm pre-pr` (scripts/pre-pr.mjs) looks at, and the guards a branch changes run against each of
// them merged with it: a guard that lands breaks a queued pull request otherwise.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { failureLabel, failuresOf, isGuardTest, noReport, tail } from './pre-pr-reports.mjs'
import { GUARD_REFS, INSTALLED_LOCK, git, removeGuardRefs } from './pre-pr-worktrees.mjs'

/** The open pull requests that are not the stack's own: a head that is one of its `commits`, or one of its branches' `names`. */
export function otherPrs(listed, commits, names) {
  const own = new Set(commits)
  return listed.filter((pr) => !own.has(pr.headRefOid) && !names.has(pr.headRefName))
}

/** What `gh pr list` is asked of each open pull request: `files` holds at most 100, so `changedFiles` says whether it holds them all. */
const PR_FIELDS = 'number,title,headRefName,headRefOid,isDraft,changedFiles,files'

/** The files an open pull request changes: the list's, when it holds them all, else `gh pr diff --name-only`. */
export function prFiles(gh, root, pr) {
  if (Array.isArray(pr.files) && pr.files.length === pr.changedFiles) return pr.files.map((f) => f.path)
  return String(gh(['pr', 'diff', String(pr.number), '--name-only'], root)).split('\n').map((f) => f.trim()).filter(Boolean)
}

/** The open pull requests, as `gh pr list` answers them in the checkout `root`. */
export const listOpenPrs = (gh, root) => JSON.parse(gh(['pr', 'list', '--state', 'open', '--limit', '500', '--json', PR_FIELDS], root))

/** The most one pull request's guards may take, and the default for the whole check. */
export const GUARDS_PER_PR_MS = 5 * 60_000
export const GUARDS_LIMIT_MS = 10 * 60_000

/**
 * Runs `guards` (as the head declares them: `{ test, tests }`) against each of `prs` (open, not the stack's own) with this branch
 * merged in: a commit of the pull request's head and `head`, made from a merge that did not conflict. Answers
 * `{ failing, skipped, unchecked }`; never throws for one pull request's trouble. `makeWorktree(commit)`
 * answers a worktree, or null when its dependencies would need an install. `needMs` is how long one run of the guards is known to
 * take: a pull request that merges is not started with less time than that left, since a run cut off half way says nothing and
 * costs all of it; it is listed as not reached, with why. `perPrMs` is the most one run may take.
 */
export function runGuards({ root, remote, runId, runners, prs, head, guards, makeWorktree, dropWorktree, limitMs, now, log, check, needMs = 0, perPrMs = GUARDS_PER_PR_MS }) {
  const failing = []
  const skipped = []
  const unchecked = []
  const deadline = now() + limitMs
  const space = `${GUARD_REFS}/${runId}`
  const ident = { GIT_AUTHOR_NAME: 'pre-pr', GIT_AUTHOR_EMAIL: 'pre-pr@localhost', GIT_COMMITTER_NAME: 'pre-pr', GIT_COMMITTER_EMAIL: 'pre-pr@localhost' }
  try {
    try {
      git(root, ['fetch', '--no-tags', '--quiet', remote, ...prs.map((p) => `+refs/pull/${p.number}/head:${space}/${p.number}`)])
    } catch (e) {
      return { failing, skipped: prs.map((p) => ({ pr: p, why: `its head could not be fetched (${tail(e.stderr ?? e.message, 1)})` })), unchecked }
    }
    for (const pr of prs) {
      check()
      let wt = null
      try {
        const theirs = git(root, ['rev-parse', '--verify', `${space}/${pr.number}^{commit}`]).trim()
        let tree
        try {
          tree = git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', theirs, head]).split('\n')[0].trim()
        } catch (e) {
          const files = String(e.stdout ?? '').trim().split('\n').slice(1).filter(Boolean)
          skipped.push({ pr, why: files.length ? `does not merge cleanly with this branch (${files.slice(0, 5).join(', ')})` : 'could not be merged with this branch' })
          continue
        }
        const timeLeft = deadline - now()
        if (timeLeft < Math.max(needMs, 1)) {
          unchecked.push({ pr, why: timeLeft > 0 ? `not started: a run takes about ${Math.round(needMs / 1000)} s and ${Math.round(timeLeft / 1000)} s were left` : 'time limit reached' })
          continue
        }
        const commit = git(root, ['commit-tree', tree, '-p', theirs, '-p', head, '-m', `pre-pr guards: #${pr.number} with this branch`], ident).trim()
        wt = makeWorktree(commit)
        if (!wt) {
          skipped.push({ pr, why: `its lockfile with this branch merged in is not the one this checkout last installed (${INSTALLED_LOCK}), and a guard run installs nothing; a pnpm install here may change that` })
          continue
        }
        const present = guards.filter((g) => existsSync(join(wt, g.test)))
        if (!present.length) continue
        log(`guards against #${pr.number}`)
        const timeoutMs = Math.max(1000, Math.min(perPrMs, deadline - now()))
        // Only the tests that are the guards: one pattern for the run, so each file's are kept below
        const testNamePattern = present.map((g) => g.tests).join('|')
        const { report, timedOut } = runners.vitest(wt, present.map((g) => g.test), { timeoutMs, testNamePattern })
        if (!report) {
          skipped.push({ pr, why: noReport(timedOut, timeoutMs) })
          continue
        }
        // A file that did not load fails every guard of it
        const fails = failuresOf(report, wt).filter((f) => !f.name || present.some((g) => g.test === f.file && isGuardTest(g, f.name)))
        if (fails.length) failing.push({ pr, failures: fails })
      } catch (e) {
        if (String(e.message) === 'interrupted') throw e
        skipped.push({ pr, why: `could not be checked (${tail(e.message, 1)})` })
      } finally {
        if (wt) dropWorktree(wt)
      }
    }
  } finally {
    removeGuardRefs(root, runId)
  }
  return { failing, skipped, unchecked }
}

/** The warnings for a {@link runGuards} answer: one for each pull request it would fail, one for what was not checked. */
export function guardWarnings({ failing, skipped, unchecked }, guards) {
  const warnings = failing.map(({ pr, failures }) => {
    const first = failures[0]
    const more = failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''
    return { check: 'guards', message: `#${pr.number} "${pr.title}" (${pr.headRefName}) would fail ${failureLabel(first)} with this branch merged in: ${first.line}${more}. Fix it in this change, or tell its author.` }
  })
  const left = [...skipped, ...unchecked].map(({ pr, why }) => `#${pr.number} (${why})`)
  if (left.length) warnings.push({ check: 'guards', message: `${guards.join(', ')} was not run against: ${left.join('; ')}.` })
  return warnings
}
