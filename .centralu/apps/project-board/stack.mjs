// rebase_stack (#386 step 2): move a stacked pull request onto its base branch after the pull
// request under it was squash-merged. On 2026-10-05 a queued rebase used a base commit the branch no
// longer had, because the lower pull request had been restacked meanwhile; it was stopped by hand.
//
// The procedure reads everything fresh at the call: both pull requests from GitHub, their commits
// from the remote. It replays only the upper pull request's own commits (those after the lower one's
// last head) onto the lower one's merge commit, in a temporary worktree, so the person's checkout is
// never touched. Before anything is pushed it confirms the change is the one CI tested (the same
// patch), and says whether the tree is the tested tree too. Pushing is a second call (`push: true`),
// with a lease on the head that was read, then the base moves to the lower one's base.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitError, changedFiles, commitCount, fetchRefs, git, isAncestor, patchId, remoteFor, topLevel, treeOf } from './git.mjs'
import { listSome, plural, short } from './util.mjs'

/** A refusal: nothing was pushed or changed. */
export class StackRefusal extends Error {}

const listFiles = (files) => listSome(files, 8)

/**
 * `gh`: { readPr, prsWithHead, setPrBase, openPrsOnBase } (github.mjs). `ref(n)` writes a pull request's number the
 * way the board does. Answers { summary, lines, pushed, rebased, sameTree }.
 */
export async function rebaseStack({ repo, pr, lower: lowerNumber, dir, push = false }, gh, ref = (n) => `#${n}`) {
  const refuse = (why) => {
    throw new StackRefusal(why)
  }
  const upper = await gh.readPr(repo, pr)
  const U = ref(upper.number)
  if (upper.state !== 'OPEN') refuse(`${U} is ${String(upper.state).toLowerCase()}; only an open pull request is restacked.`)
  if (upper.isCrossRepository) refuse(`${U}'s branch is in a fork; restack it there.`)

  let lower
  if (lowerNumber !== undefined) lower = await gh.readPr(repo, lowerNumber)
  else {
    const [below] = await gh.prsWithHead(repo, upper.baseRefName)
    if (!below)
      refuse(
        `${U} is not stacked: its base ${upper.baseRefName} is not the branch of a pull request. If GitHub already moved its base after the pull request under it was merged, name that one with lower.`,
      )
    lower = await gh.readPr(repo, below.number)
  }
  const L = ref(lower.number)
  if (lower.number === upper.number) refuse(`${U} cannot be stacked on itself.`)
  if (lower.state !== 'MERGED') refuse(`${L} (${lower.headRefName}) is not merged yet (${String(lower.state).toLowerCase()}); restack ${U} after it is.`)
  const squash = lower.mergeCommit?.oid
  if (!squash) refuse(`GitHub gives no merge commit for ${L}.`)
  const base = lower.baseRefName
  const lowerHead = lower.headRefOid
  const tested = upper.headRefOid
  const branch = upper.headRefName

  const root = await topLevel(dir).catch((e) => refuse(`${dir} is not a git checkout (${e.message}).`))
  const remote = await remoteFor(root, repo)
  if (!remote) refuse(`The checkout at ${root} has no remote for github.com/${repo}. Give path: a checkout of it.`)
  // What the remote has now, by name: the base, the upper branch, and the lower one's last head, which
  // GitHub keeps under refs/pull/N/head after its branch is deleted
  const [baseTip, upperTip, lowerTip] = await fetchRefs(root, remote, [`refs/heads/${base}`, `refs/heads/${branch}`, `refs/pull/${lower.number}/head`])
  if (upperTip !== tested) refuse(`${U}'s branch ${branch} is at ${short(upperTip)} on ${remote}, but GitHub reported ${short(tested)}: it moved while this ran. Call again.`)
  if (lowerTip !== lowerHead) refuse(`${L}'s last head is ${short(lowerHead)} on GitHub but ${short(lowerTip)} on ${remote}. Call again in a moment.`)
  if (!(await isAncestor(root, squash, baseTip))) refuse(`${L}'s merge commit ${short(squash)} is not on ${base}.`)
  if (!(await isAncestor(root, lowerHead, tested)))
    refuse(
      `${U} (${short(tested)}) does not contain ${L}'s last head ${short(lowerHead)}: it was built on an older version of ${L}, which changed after. Replaying from here would carry ${L}'s old commits along. Rebase ${branch} onto ${short(lowerHead)} by hand first, or redo it on ${base}.`,
    )

  const own = await commitCount(root, `${lowerHead}..${tested}`)
  const lines = []
  let rebased = tested
  let sameTree = true
  // Merged with a merge commit or rebased in: its commits are on the base already, nothing to replay
  const alreadyIn = await isAncestor(root, lowerHead, baseTip)
  const tmp = alreadyIn ? null : await mkdtemp(join(tmpdir(), 'centralu-restack-'))
  try {
    if (alreadyIn) lines.push(`${L}'s commits are on ${base} as they are (not squashed), so ${U} needs no rebase, only its base moved.`)
    else {
      // Hooks are off for these two: a checkout or rebase hook belongs to the person's own work, not a scratch copy
      await git(root, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', tmp, tested])
      try {
        await git(tmp, ['-c', 'core.hooksPath=/dev/null', 'rebase', '--quiet', '--onto', squash, lowerHead])
      } catch (e) {
        const files = await git(tmp, ['diff', '--name-only', '--diff-filter=U']).then((t) => t.split('\n').filter(Boolean)).catch(() => [])
        await git(tmp, ['rebase', '--abort']).catch(() => {})
        refuse(
          files.length
            ? `Replaying ${U}'s ${plural(own, 'commit')} on ${L}'s merge commit ${short(squash)} conflicts in ${listFiles(files)}. Nothing was pushed; resolve it by hand.`
            : `Replaying ${U}'s commits on ${short(squash)} failed: ${e.message} Nothing was pushed.`,
        )
      }
      rebased = (await git(tmp, ['rev-parse', 'HEAD'])).trim()
      // The change is the one tested: the same patch from the merge commit as from the lower one's last head
      const [before, after] = await Promise.all([patchId(root, lowerHead, tested), patchId(root, squash, rebased)])
      if (before !== after)
        refuse(`After replaying, ${U}'s change from ${short(squash)} is not the change tested from ${short(lowerHead)}. Nothing was pushed; look at it by hand.`)
      lines.push(`Replayed ${plural(own, 'commit')} of ${U} from ${short(lowerHead)} (${L}'s last head) onto ${short(squash)} (${L}'s merge commit on ${base}): ${short(tested)} → ${short(rebased)}. The change is the one tested.`)
      sameTree = (await treeOf(root, tested)) === (await treeOf(root, rebased))
      if (sameTree) lines.push(`The tree is the tested tree: CI's result for ${short(tested)} holds for ${short(rebased)}.`)
      else {
        const files = await changedFiles(root, tested, rebased)
        const onlyBase = (await patchId(root, tested, rebased)) === (await patchId(root, lowerHead, squash))
        lines.push(
          `The tree is not the tested tree: it differs in ${plural(files.length, 'file')} (${listFiles(files)}), ${onlyBase ? `exactly what ${base} had at the merge that ${L}'s last head did not` : `and not only by what ${base} had at the merge`}. CI has to pass on ${short(rebased)} before it is merged.`,
        )
      }
    }
    if (!push) {
      const next = alreadyIn ? `Call again with push: true to move its base to ${base}.` : `Call again with push: true to push it (only while ${branch} is still ${short(tested)}) and move its base to ${base}.`
      return { summary: `${U} can be restacked onto ${base}; nothing pushed yet. ${next}`, lines, pushed: false, rebased, sameTree }
    }
    if (!alreadyIn) {
      try {
        await git(root, ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${tested}`, remote, `${rebased}:refs/heads/${branch}`])
      } catch (e) {
        refuse(`Pushing ${branch} failed, so nothing changed: ${e.message}${/stale info|rejected/.test(e.message) ? ' It moved on the remote after it was read; call again.' : ''}`)
      }
      lines.push(`Pushed ${short(rebased)} to ${branch} on ${remote}, where it was ${short(tested)}.`)
    }
    if (upper.baseRefName !== base) {
      try {
        await gh.setPrBase(repo, upper.number, base)
        lines.push(`Moved ${U}'s base from ${upper.baseRefName} to ${base}.`)
      } catch (e) {
        lines.push(`${alreadyIn ? '' : 'Pushed, but '}${U}'s base could not be moved to ${base}: ${e.message}`)
        return { summary: `${U} restacked, but its base is still ${upper.baseRefName}.`, lines, pushed: !alreadyIn, rebased, sameTree, partial: true }
      }
    } else lines.push(`${U}'s base is already ${base}.`)
    // A stack's lowers are drafts and run no CI (#1066): one nothing is stacked on any more is its stack's top
    if (upper.isDraft && gh.openPrsOnBase && !(await gh.openPrsOnBase(repo, branch)).length)
      lines.push(`${U} is a draft, and no open pull request is based on ${branch}: if it is its stack's top now, mark it ready for review (mark_ready, or gh pr ready ${upper.number}) so CI runs on it.`)
    return { summary: `${U} restacked onto ${base}${alreadyIn ? '' : ` at ${short(rebased)}`}.`, lines, pushed: !alreadyIn, rebased, sameTree }
  } catch (e) {
    if (e instanceof StackRefusal || !(e instanceof GitError)) throw e
    throw new StackRefusal(`${e.message} Nothing was pushed.`)
  } finally {
    if (tmp) {
      await git(root, ['worktree', 'remove', '--force', tmp]).catch(() => {})
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      await git(root, ['worktree', 'prune']).catch(() => {})
    }
  }
}
