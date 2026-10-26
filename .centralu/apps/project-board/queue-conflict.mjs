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
// A pull request stacked on one this queue has just landed as a squash (#1221 on #1218, 2026-10-19):
// GitHub moves its base to the default branch, but its branch still carries the lower's original
// commits, which conflict with their own squash on the default branch. Merging the default branch in
// cannot fix that. So when the branch contains the head of a pull request the queue landed (and the
// default branch does not: it was squashed), the queue rebases the branch onto the default branch
// without those commits (`git rebase --onto <default> <landed head>`) and pushes with a lease on the
// head it read (`--force-with-lease`: refused when the branch moved since, as the merge's push is). The
// owner asked for that push (2026-10-19); it is the only one the queue forces. Only a rebase that
// itself conflicts is handed off.
//
// Every step answers how long it took, for the queue's events (the daily metrics count conflicts the
// queue handled without a person).
import { execFile } from './system.mjs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { GitError, fetchRefs, git, remoteFor, topLevel } from './git.mjs'
import { pathMatches } from './versions.mjs'
import { listSome, short } from './util.mjs'

/** Where fetched refs land for a moment (git.mjs fetchRefs): one driver at a time, so names never collide. */
const REF_SPACE = 'refs/centralu-queue'
/** A worktree folder's name starts so, then the pid that made it: a sweep removes those of processes gone */
const TMP_PREFIX = 'centralu-queue-merge-'
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
 * The environment a regeneration command gets (#1182 review). The commands run code of the pull
 * request (its package scripts, its build.rs, its tests) on the queue's computer, so they get only
 * what finding programs, a home and a temporary folder needs, and none of the queue's own
 * variables: no GH_TOKEN or GITHUB_TOKEN, no API keys, nothing Centralu passes its apps. An allow
 * list, so a secret under a name nobody thought of is not passed either.
 */
const COMMAND_ENV = new Set(
  [
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'SYSTEMDRIVE',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'USER',
    'LOGNAME',
    'SHELL',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'RUSTUP_TOOLCHAIN',
    'PNPM_HOME',
    'COREPACK_HOME',
  ].map((k) => k.toUpperCase()),
)
export function commandEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (COMMAND_ENV.has(k.toUpperCase()) && v !== undefined) out[k] = v
  out.CI = '1'
  return out
}

/** Whether the process `pid` still runs (a folder of one that does may be in use). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** A link to a folder: a junction on Windows (no privilege needed), a symbolic link elsewhere */
const LINK = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * Removes every link (symbolic link or junction) under `dir` without following it, descending only
 * into real folders (#1182 review): a recursive removal that followed the links `mirrorModules`
 * makes would delete the checkout's own node_modules. Skips `.git` and the `.pnpm` store of an
 * install made in the worktree, whose links point inside it.
 */
export async function dropLinks(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    const st = await lstat(path).catch(() => null)
    if (!st) continue
    if (st.isSymbolicLink()) await unlink(path).catch(() => rmdir(path).catch(() => {}))
    else if (st.isDirectory() && name !== '.git' && name !== '.pnpm') await dropLinks(path)
  }
}

/**
 * Whether the merged tree's lockfile is the default branch's and the one the checkout installed:
 * then the checkout's node_modules are the merged tree's, and nothing needs installing. The checkout
 * must have been installed (pnpm's `node_modules/.modules.yaml`).
 */
async function sameLock(root, tmp, mainTip) {
  try {
    await lstat(join(root, 'node_modules', '.modules.yaml'))
    const [merged, main, checkout] = await Promise.all([
      git(tmp, ['hash-object', 'pnpm-lock.yaml']),
      git(tmp, ['rev-parse', `${mainTip}:pnpm-lock.yaml`]),
      git(root, ['hash-object', 'pnpm-lock.yaml']),
    ])
    return merged.trim() === main.trim() && main.trim() === checkout.trim()
  } catch {
    return false
  }
}

/**
 * Gives the worktree the checkout's node_modules without installing (#1182 review): pnpm's
 * node_modules of the root and of each workspace package are mirrored as real folders of links.
 * A link to a package of the workspace points at that package in the worktree (the merged source,
 * not the checkout's own); any other link, to the store or a folder, at what it is in the checkout.
 * Plain files (pnpm's state) are copied. Answers how many folders were mirrored.
 */
export async function mirrorModules(root, tmp) {
  const rootReal = await realpath(root)
  const inWorkspace = (target) => {
    const rel = relative(rootReal, target)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('node_modules') ? rel : null
  }
  const link = async (target, path) => {
    try {
      await symlink(target, path, LINK)
    } catch {
      // A link to a file (a junction cannot be one): its copy does
      await copyFile(target, path).catch(() => {})
    }
  }
  const mirror = async (src, dst) => {
    await mkdir(dst, { recursive: true })
    for (const name of await readdir(src)) {
      const s = join(src, name)
      const d = join(dst, name)
      const st = await lstat(s)
      if (st.isSymbolicLink()) {
        const target = await realpath(s).catch(() => null)
        if (!target) continue
        const rel = inWorkspace(target)
        await link(rel ? join(tmp, rel) : target, d)
      } else if (st.isDirectory()) {
        // A scope holds links of its own, which may be workspace packages
        if (name.startsWith('@')) await mirror(s, d)
        else await link(s, d)
      } else if (st.isFile()) await copyFile(s, d)
    }
  }
  const packages = (await git(tmp, ['ls-files', '-z', '--', 'package.json', '*/package.json']))
    .split('\0')
    .filter((p) => p && !p.split('/').includes('node_modules'))
    .map((p) => dirname(p))
  let count = 0
  for (const dir of new Set(packages)) {
    const src = join(root, dir, 'node_modules')
    const st = await lstat(src).catch(() => null)
    if (!st?.isDirectory()) continue
    await mirror(src, join(tmp, dir, 'node_modules'))
    count += 1
  }
  return count
}

/**
 * What a run killed half way leaves (#1182 review): its worktree folder in the temporary folder, its
 * registration in the checkout, refs it fetched. Removed at the start of each run: the folders of
 * processes that have ended, and this one's (it runs one merge at a time), the registrations git no
 * longer finds, and every fetched ref (one driver at a time holds the queue). Best effort.
 */
export async function sweep(root, base = tmpdir()) {
  const names = await readdir(base).catch(() => [])
  for (const name of names.filter((n) => n.startsWith(TMP_PREFIX))) {
    const pid = Number(name.slice(TMP_PREFIX.length).split('-')[0])
    if (pid !== process.pid && alive(pid)) continue
    const path = join(base, name)
    // Its links first: neither git nor the removal below may follow one into the checkout
    await dropLinks(path)
    await git(root, ['worktree', 'remove', '--force', path]).catch(() => {})
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }
  await git(root, ['worktree', 'prune']).catch(() => {})
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)', REF_SPACE]).catch(() => '')).split('\n').filter(Boolean)
  for (const r of refs) await git(root, ['update-ref', '-d', r]).catch(() => {})
}

/** `git diff --numstat` lines as `{ file, added, removed }` (null counts for a binary file). */
const numstat = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...f] = l.split('\t')
      return { file: f.join('\t'), added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) }
    })
export const statLine = (s) => `${s.file} ${s.added === null ? '(binary)' : `+${s.added} -${s.removed}`}`

/**
 * Runs one command of the list in `cwd`, without a shell, with `commandEnv`. On Windows a command that is a `.cmd`
 * shim (pnpm, npx) cannot be started that way, so one that is not found is tried once more through
 * cmd.exe, with its arguments quoted; the list is project.json's, never input from outside.
 */
function run(cwd, argv, timeoutMs, extraEnv = {}) {
  const once = (file, args, extra = {}) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...commandEnv(), ...extraEnv }, ...extra }, (error, stdout, stderr) => {
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

/** Whether `a` is an ancestor of `b` in `dir` (false when either is not there). */
async function isAncestor(dir, a, b) {
  try {
    await git(dir, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch {
    return false
  }
}

/**
 * The pull request the queue landed as a squash whose original commits `branchTip` still carries: of
 * `landed` (`{ pr, head }`, the queue's merged items), those whose head is in the branch and not in the
 * default branch (squashed, not merged), the nearest one (the others are under it). Null when none.
 */
export async function landedUnder(dir, landed, branchTip, mainTip) {
  let best = null
  for (const l of landed ?? []) {
    if (!l?.head || l.head === branchTip) continue
    if (!(await isAncestor(dir, l.head, branchTip)) || (await isAncestor(dir, l.head, mainTip))) continue
    if (!best || (await isAncestor(dir, best.head, l.head))) best = l
  }
  return best
}

/**
 * Rebases the branch (checked out detached in `tmp` at `branchTip`) onto the default branch without
 * the commits of `under`, the pull request the queue landed as a squash, and pushes it with a lease on
 * `branchTip`. Answers as mergeMain does; `steps` gain `rebase` (`dropped`: that pull request, `files`
 * when it conflicted) and `push` (`lease: true`).
 */
async function restack({ root, tmp, remote, branch, branchTip, mainTip, defaultBranch, under, renew, clock, steps, handoff }) {
  const started = clock()
  const how = `git rebase --onto ${defaultBranch} ${short(under.head)}`
  try {
    await git(tmp, [...HOOKS_OFF, 'rebase', '--onto', mainTip, under.head])
  } catch (e) {
    const files = (await git(tmp, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean)
    await git(tmp, ['rebase', '--abort']).catch(() => {})
    if (!files.length) throw e
    steps.push({ step: 'rebase', ms: clock() - started, files, dropped: under.pr, onto: mainTip })
    return handoff(
      `#${under.pr} landed as a squash, and ${branch} still carries its original commits; the queue rebased ${branch} onto ${defaultBranch} without them (${how}), and that conflicts too. It pushed nothing.`,
      files,
      `Rebase ${branch} onto ${defaultBranch} without #${under.pr}'s commits (git rebase --onto origin/${defaultBranch} ${under.head}), resolve the conflicts and push with --force-with-lease; conflicted files: ${files.join(', ')}.`,
    )
  }
  const sha = (await git(tmp, ['rev-parse', 'HEAD'])).trim()
  steps.push({ step: 'rebase', ms: clock() - started, files: [], dropped: under.pr, onto: mainTip, sha })
  if (sha === mainTip) return handoff(`#${under.pr} landed as a squash, and once its commits are dropped from ${branch} (${how}) nothing of its own is left. It pushed nothing; close it if it is done.`)
  if (!renew()) return { outcome: 'yielded' }
  const pushing = clock()
  try {
    // A lease on the head that was read: refused when the branch moved since (its author pushed)
    await git(root, ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${branchTip}`, remote, `${sha}:refs/heads/${branch}`])
  } catch (e) {
    const [tip] = await fetchRefs(root, remote, [`refs/heads/${branch}`], REF_SPACE).catch(() => [null])
    if (tip && tip !== branchTip) {
      steps.push({ step: 'superseded', ms: clock() - pushing, sha, tip })
      return { outcome: 'superseded', tip, files: [], steps }
    }
    return handoff(`The queue rebased ${branch} onto ${defaultBranch} without #${under.pr}'s commits (${how}), but pushing ${short(sha)} failed: ${e.message}`)
  }
  steps.push({ step: 'push', ms: clock() - pushing, sha, lease: true })
  return { outcome: 'pushed', sha, files: [], steps, dropped: under.pr }
}

/**
 * Merges `defaultBranch` into the pull request's branch and, when the conflicts are mechanical,
 * regenerates them, commits and pushes. `pr` is what GitHub said (`headRefName`, `headRefOid`);
 * `dir` a checkout of `repo`; `conflicts` the lists (`mechanical`, `never`, `timeoutMs`); `renew`
 * answers whether this is still the driver (asked before the push). Answers one of:
 * - `{ outcome: 'pushed', sha, files, steps }`: the merge is on the branch now;
 * - `{ outcome: 'handoff', files, why, steps }`: nothing pushed, and why, for the author session;
 * - `{ outcome: 'moved' }`: the branch is not at the head GitHub reported (look again next poll);
 * - `{ outcome: 'superseded', tip, steps }`: the push was refused because the branch moved while the
 *   queue worked (its author pushed first): nothing to tell, the queue takes that head;
 * - `{ outcome: 'yielded' }`: another driver holds the queue now; nothing pushed.
 * `steps` are `{ step, ms, … }`: `merge` (with the conflicted files), `regenerate` (the commands,
 * and `stat`: each regenerated file's lines added and removed against the default branch's version),
 * `push` (the commit), `superseded`.
 */
export async function mergeMain({ repo, pr, defaultBranch, dir, conflicts, renew, landed = [], clock = Date.now }) {
  const branch = pr.headRefName
  const steps = []
  const handoff = (why, files = [], instruction = null) => ({ outcome: 'handoff', files, why, steps, ...(instruction ? { instruction } : {}) })
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
  await sweep(root)
  try {
    const [mainTip, branchTip] = await fetchRefs(root, remote, [`refs/heads/${defaultBranch}`, `refs/heads/${branch}`], REF_SPACE)
    // GitHub and the remote can disagree for a moment after a push: read it again on the next poll
    if (branchTip !== pr.headRefOid) return { outcome: 'moved' }
    tmp = await mkdtemp(join(tmpdir(), `${TMP_PREFIX}${process.pid}-`))
    await git(root, [...HOOKS_OFF, 'worktree', 'add', '--detach', '--quiet', tmp, branchTip])
    // Stacked on a pull request the queue landed as a squash: its old commits go, not main comes in
    const under = await landedUnder(tmp, landed, branchTip, mainTip)
    if (under) return await restack({ root, tmp, remote, branch, branchTip, mainTip, defaultBranch, under, renew, clock, steps, handoff })
    const message = `Merge ${defaultBranch} into ${branch}`
    let files = []
    try {
      await git(tmp, [...HOOKS_OFF, 'merge', '--no-ff', '--no-edit', '-m', message, mainTip])
    } catch (e) {
      files = (await git(tmp, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
      if (!files.length) throw e
    }
    // "Already up to date": the default branch is in the branch already, yet GitHub says it conflicts.
    // There is nothing to push, and waiting for a new head would wait forever: a session looks at it
    if (!files.length && (await git(tmp, ['rev-parse', 'HEAD'])).trim() === branchTip)
      return handoff(`GitHub says it conflicts, but ${defaultBranch} at ${short(mainTip)} is already merged into ${branch}, so the queue has nothing to push. Look at the pull request on GitHub.`)
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
      // node_modules, decided once the lockfile is regenerated (#1182 review): the merged lockfile is
      // main's and the checkout's, so the checkout's node_modules are linked and no install runs; or
      // it is not, and the list's installs run, with --ignore-scripts (a native module may then be
      // missing, and its command fails: handed off)
      let modules = null
      const prepare = async () => {
        if (modules) return
        modules = 'installed'
        if (!(await sameLock(root, tmp, mainTip))) return
        try {
          await mirrorModules(root, tmp)
          modules = 'linked'
        } catch {
          await dropLinks(tmp)
        }
      }
      for (const argv of plan.commands) {
        const install = argv[0] === 'pnpm' && argv[1] === 'install'
        const lockfileOnly = install && argv.includes('--lockfile-only')
        if (!lockfileOnly) await prepare()
        if (install && !lockfileOnly && modules === 'linked') continue
        try {
          // CC_LINT_BASE: the lint allowlist check compares with main's lists at the tip just fetched (#1423), not an `origin/main` the checkout may not have
          await run(tmp, argv, timeoutMs, { CC_LINT_BASE: mainTip })
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
      // What regenerating made of each file, against the default branch's version: a golden approved
      // without a person is at least visible to one (the commit and the queue's event both say it)
      // Files the commands changed that did not conflict (`pnpm lint:tighten` lowers every allowlist the merged tree no longer
      // needs, #1423) are in the commit too, so they are shown with the rest
      const extra = named.filter((p) => !files.includes(p))
      const stat = numstat(await git(tmp, ['diff', '--cached', '--numstat', '--no-renames', mainTip, '--', ...files, ...extra]))
      const body = [
        `The merge queue merged ${defaultBranch} and regenerated ${listSome(files, 6)} with ${plan.commands.map(commandLine).join(', ')} (project.json queue.conflicts.mechanical, #1182).${extra.length ? ` The commands also changed ${listSome(extra, 6)}, which did not conflict.` : ''}`,
        '',
        `Regenerated, against ${defaultBranch} at ${short(mainTip)}:`,
        ...(stat.length ? stat.map((x) => `  ${statLine(x)}`) : ['  no change']),
      ].join('\n')
      await git(tmp, [...HOOKS_OFF, 'commit', '--quiet', '-F', '-'], { input: `${message}\n\n${body}\n` })
      steps.push({ step: 'regenerate', ms: clock() - regenerating, files, ...(extra.length ? { also: extra } : {}), commands: plan.commands.map(commandLine), stat, modules })
    }
    sha = (await git(tmp, ['rev-parse', 'HEAD'])).trim()
    if (!renew()) return { outcome: 'yielded' }
    const pushing = clock()
    try {
      // Never forced: a fast-forward of the head that was read, refused when the branch moved since
      await git(root, ['push', '--quiet', remote, `${sha}:refs/heads/${branch}`])
    } catch (e) {
      // Refused because the branch moved meanwhile (its author pushed first): that head is the news
      const [tip] = await fetchRefs(root, remote, [`refs/heads/${branch}`], REF_SPACE).catch(() => [null])
      if (tip && tip !== branchTip) {
        steps.push({ step: 'superseded', ms: clock() - pushing, sha, tip })
        return { outcome: 'superseded', tip, files, steps }
      }
      return handoff(`The queue merged ${defaultBranch} into ${branch} itself${files.length ? ' and regenerated the mechanical files' : ''}, but pushing ${short(sha)} failed: ${e.message}`, files)
    }
    steps.push({ step: 'push', ms: clock() - pushing, sha })
    return { outcome: 'pushed', sha, files, steps }
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    return handoff(`The queue could not merge ${defaultBranch} into ${branch} itself: ${e.message}`)
  } finally {
    if (tmp) {
      // The links into the checkout's node_modules go first, unfollowed
      await dropLinks(tmp)
      await git(root, ['worktree', 'remove', '--force', tmp]).catch(() => {})
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      await git(root, ['worktree', 'prune']).catch(() => {})
    }
  }
}
