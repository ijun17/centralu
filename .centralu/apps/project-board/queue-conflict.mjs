// The merge queue's conflicts (#1182): a queued pull request that conflicts with the default branch.
// Before, the queue stopped the item and said so; a person or the queuing session merged main by
// hand, and the item then waited again behind everything queued since (#1091 conflicted three times).
//
// Now the queue merges the default branch into the pull request's branch itself, in a temporary
// worktree of the checkout this app is committed in (as rebase_stack does, so the person's checkout
// is never touched). When every conflicted file is one project.json lists as mechanical
// (`queue.conflicts.mechanical`: files a command regenerates, such as the lockfile or a golden file),
// it takes the default branch's version of each, runs the commands the list gives, commits the merge
// and pushes it, never forced: the push is a fast-forward of the head the queue read, refused if the
// branch moved. The pushed commit is a new head, so CI runs on it again before anything lands. A file
// on `queue.conflicts.never` (decided by the owner: the UX baseline, store migration steps and their
// numbers) is never regenerated, whatever the mechanical list says; any other conflict is handed to
// the pull request's author session (queue.mjs handoffReason).
//
// Every step answers how long it took, for the queue's events (the daily metrics count conflicts the
// queue handled without a person).
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitError, fetchRefs, git, remoteFor, topLevel } from './git.mjs'
import { pathMatches } from './versions.mjs'
import { listSome, short } from './util.mjs'

/** Where fetched refs land for a moment (git.mjs fetchRefs): one driver at a time, so names never collide. */
const REF_SPACE = 'refs/centralu-queue'
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null']
// A conflict marker left in a file a command was meant to regenerate (not `=======`: a Markdown heading's underline)
const MARKER = /^(?:<{7}|>{7})(?: |$)/m

const matches = (patterns, path) => (patterns ?? []).some((p) => pathMatches(p, path))
export const commandLine = (argv) => argv.join(' ')

/**
 * What to do with a merge's conflicted `files`, by the lists (`mechanical`: `{ files, run }` entries;
 * `never`: patterns). Answers `{ handoff: false, entries, commands }` when every file is named by a
 * mechanical entry and none is on `never` (no files at all: nothing to regenerate), else
 * `{ handoff: true, never, other }`: the files on `never`, and those no entry names.
 */
export function conflictPlan(files, { mechanical = [], never = [] } = {}) {
  const barred = files.filter((f) => matches(never, f))
  const other = files.filter((f) => !barred.includes(f) && !mechanical.some((e) => matches(e.files, f)))
  if (barred.length || other.length) return { handoff: true, never: barred, other }
  const entries = mechanical.filter((e) => files.some((f) => matches(e.files, f)))
  // Each command once, in the list's order: the lockfile is regenerated before an install needs it
  const seen = new Set()
  const commands = []
  for (const argv of entries.flatMap((e) => e.run ?? [])) {
    const key = JSON.stringify(argv)
    if (!seen.has(key)) (seen.add(key), commands.push(argv))
  }
  return { handoff: false, entries, commands }
}

/** Why the files of a plan that hands off are not the queue's to regenerate, in words. */
export function planWhy(plan) {
  const parts = []
  if (plan.never.length) parts.push(`${listSome(plan.never, 6)} ${plan.never.length === 1 ? 'is' : 'are'} never regenerated (project.json queue.conflicts.never)`)
  if (plan.other.length) parts.push(`${listSome(plan.other, 6)} ${plan.other.length === 1 ? 'is' : 'are'} not on project.json's list of mechanical files (queue.conflicts.mechanical)`)
  return parts.join('; ')
}

/**
 * Runs one command of the list in `cwd`, without a shell. On Windows a command that is a `.cmd`
 * shim (pnpm, npx) cannot be started that way, so one that is not found is tried once more through
 * cmd.exe, with its arguments quoted; the list is project.json's, never input from outside.
 */
function run(cwd, argv, timeoutMs) {
  const once = (file, args, extra = {}) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1' }, ...extra }, (error, stdout, stderr) => {
        if (!error) return resolve()
        error.stderr = String(stderr ?? '')
        error.stdout = String(stdout ?? '')
        reject(error)
      })
    })
  const [file, ...args] = argv
  return once(file, args).catch((e) => {
    if (process.platform !== 'win32' || !['ENOENT', 'EINVAL'].includes(e.code)) throw e
    const quoted = argv.map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a}"`)).join(' ')
    return once(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], { windowsVerbatimArguments: true })
  })
}

const lastLine = (s) =>
  String(s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? ''

/** A command that failed, in one line: how, and the last line it wrote. */
function failure(argv, e, timeoutMs) {
  if (e.killed) return `${commandLine(argv)} did not finish within ${Math.round(timeoutMs / 60_000)} minutes`
  if (e.code === 'ENOENT') return `${argv[0]} was not found`
  const said = lastLine(e.stderr) || lastLine(e.stdout)
  return `${commandLine(argv)} failed (exit ${e.code ?? '?'})${said ? `: ${said.length > 200 ? `${said.slice(0, 199)}…` : said}` : ''}`
}

/**
 * Merges `defaultBranch` into the pull request's branch and, when the conflicts are mechanical,
 * regenerates them, commits and pushes. `pr` is what GitHub said (`headRefName`, `headRefOid`);
 * `dir` a checkout of `repo`; `conflicts` the lists (`mechanical`, `never`, `timeoutMs`); `renew`
 * answers whether this is still the driver (asked before the push). Answers one of:
 * - `{ outcome: 'pushed', sha, files, steps }`: the merge is on the branch now;
 * - `{ outcome: 'handoff', files, why, steps }`: nothing pushed, and why, for the author session;
 * - `{ outcome: 'moved' }`: the branch is not at the head GitHub reported (look again next poll);
 * - `{ outcome: 'yielded' }`: another driver holds the queue now; nothing pushed.
 * `steps` are `{ step, ms, … }`: `merge` (with the conflicted files), `regenerate` (the commands),
 * `push` (the commit).
 */
export async function mergeMain({ repo, pr, defaultBranch, dir, conflicts, renew, clock = Date.now }) {
  const branch = pr.headRefName
  const steps = []
  const handoff = (why, files = []) => ({ outcome: 'handoff', files, why, steps })
  if (!dir) return handoff('The queue has no checkout to merge it in.')
  let root
  try {
    root = await topLevel(dir)
  } catch (e) {
    return handoff(`The queue could not merge ${defaultBranch} into it itself: ${dir} is not a git checkout (${e.message}).`)
  }
  const remote = await remoteFor(root, repo)
  if (!remote) return handoff(`The queue could not merge ${defaultBranch} into it itself: the checkout at ${root} has no remote for github.com/${repo}.`)
  let tmp = null
  const started = clock()
  try {
    const [mainTip, branchTip] = await fetchRefs(root, remote, [`refs/heads/${defaultBranch}`, `refs/heads/${branch}`], REF_SPACE)
    // GitHub and the remote can disagree for a moment after a push: read it again on the next poll
    if (branchTip !== pr.headRefOid) return { outcome: 'moved' }
    tmp = await mkdtemp(join(tmpdir(), 'centralu-queue-merge-'))
    await git(root, [...HOOKS_OFF, 'worktree', 'add', '--detach', '--quiet', tmp, branchTip])
    const message = `Merge ${defaultBranch} into ${branch}`
    let files = []
    try {
      await git(tmp, [...HOOKS_OFF, 'merge', '--no-ff', '--no-edit', '-m', message, mainTip])
    } catch (e) {
      files = (await git(tmp, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
      if (!files.length) throw e
    }
    steps.push({ step: 'merge', ms: clock() - started, files, main: mainTip })
    const plan = conflictPlan(files, conflicts)
    if (plan.handoff) {
      await git(tmp, ['merge', '--abort']).catch(() => {})
      return handoff(`The queue merged ${defaultBranch} into ${branch} itself, and pushed nothing: ${planWhy(plan)}.`, files)
    }
    let sha
    if (files.length) {
      const regenerating = clock()
      // The default branch's version of each, then the commands regenerate them from the merged sources
      for (const f of files) {
        await git(tmp, ['checkout', '--theirs', '--', f]).catch(() => git(tmp, ['rm', '--quiet', '--', f]))
      }
      const timeoutMs = conflicts.timeoutMs ?? 30 * 60_000
      for (const argv of plan.commands) {
        try {
          await run(tmp, argv, timeoutMs)
        } catch (e) {
          await git(tmp, ['merge', '--abort']).catch(() => {})
          return handoff(`The queue merged ${defaultBranch} into ${branch} itself and could not regenerate ${listSome(files, 6)}: ${failure(argv, e, timeoutMs)}. It pushed nothing.`, files)
        }
      }
      // Only what the list names, or what conflicted: anything else a command wrote stays behind
      const changed = (await git(tmp, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']))
        .split('\0')
        .filter(Boolean)
        .map((l) => l.slice(3))
      const named = changed.filter((p) => files.includes(p) || plan.entries.some((e) => matches(e.files, p)))
      if (named.length) await git(tmp, ['add', '-A', '--', ...named])
      const left = (await git(tmp, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
      const marked = []
      for (const f of files) {
        const text = await readFile(join(tmp, f), 'utf8').catch(() => '')
        if (MARKER.test(text)) marked.push(f)
      }
      if (left.length || marked.length) {
        await git(tmp, ['merge', '--abort']).catch(() => {})
        return handoff(`The queue merged ${defaultBranch} into ${branch} itself and ran ${plan.commands.map(commandLine).join(', ')}, but ${listSome([...new Set([...left, ...marked])], 6)} still conflict${left.length + marked.length === 1 ? 's' : ''}. It pushed nothing.`, files)
      }
      const body = `The merge queue merged ${defaultBranch} and regenerated ${listSome(files, 6)} with ${plan.commands.map(commandLine).join(', ')} (project.json queue.conflicts.mechanical, #1182).`
      await git(tmp, [...HOOKS_OFF, 'commit', '--quiet', '-F', '-'], { input: `${message}\n\n${body}\n` })
      steps.push({ step: 'regenerate', ms: clock() - regenerating, files, commands: plan.commands.map(commandLine) })
    }
    sha = (await git(tmp, ['rev-parse', 'HEAD'])).trim()
    if (!renew()) return { outcome: 'yielded' }
    const pushing = clock()
    try {
      // Never forced: a fast-forward of the head that was read, refused when the branch moved since
      await git(root, ['push', '--quiet', remote, `${sha}:refs/heads/${branch}`])
    } catch (e) {
      return handoff(`The queue merged ${defaultBranch} into ${branch} itself${files.length ? ' and regenerated the mechanical files' : ''}, but pushing ${short(sha)} failed: ${e.message}`, files)
    }
    steps.push({ step: 'push', ms: clock() - pushing, sha })
    return { outcome: 'pushed', sha, files, steps }
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    return handoff(`The queue could not merge ${defaultBranch} into ${branch} itself: ${e.message}`)
  } finally {
    if (tmp) {
      await git(root, ['worktree', 'remove', '--force', tmp]).catch(() => {})
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      await git(root, ['worktree', 'prune']).catch(() => {})
    }
  }
}
