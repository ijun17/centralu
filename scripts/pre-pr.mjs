// The mechanical checks before a pull request opens (#1181): `pnpm pre-pr`.
//
// About a quarter of what reviewers sent back could have been caught by a machine before the pull
// request opened, and most merge-queue trouble was a branch that no longer fit main. So, on the
// commits a pull request carries (never the working tree, which a pull request does not carry):
//
//   main      a warning, never a refusal: the head does not contain main (the merge queue merges it in),
//             how far behind it is, and which files a merge would conflict on.
//   tsc       `tsc --noEmit` at every pull request head of the stack, oldest first: each branch tip
//             between main and the head, and the head. A lower pull request must build on its own,
//             since it lands on its own.
//   orphans   dependency-cruiser's `no-orphans` rule as an error (in `pnpm verify` it only warns).
//   store-step  a store step number this branch adds (a new `to: N,` under the migrations folder) that main
//             already has, or that another open pull request adds (#1203): two parallel changes picking the
//             same number each pass CI alone and clash only when the second lands. `gh` lists the open pull
//             requests; the stack's own are left out. The orchestrator assigns the numbers; this is the backstop.
//   guards    never a refusal: when the branch adds or changes a repository-wide guard test (a tooling/*.test.ts, or
//             a test that scans the whole repository), each changed guard is run against every other open,
//             non-draft pull request's head merged with this branch, and the ones it would fail are listed with
//             the first line of the failure, as warnings (they go into Verified). Each day's guards broke a
//             queued pull request an hour after landing; the author fixes those in the same change, or tells
//             their authors. Bounded: a time limit (--guards-limit), only the guards the branch changed, and a
//             pull request that does not merge cleanly (or needs other dependencies) is skipped and said so.
//   revert    each new or changed vitest file is run at the head with every other change of the pull
//             request reverted to its base: a new test that passes there protects nothing
//             (CONTRIBUTING.md: a test must fail without its fix). Only tests new in this pull
//             request count; one that was already there passing is no news.
//   tier      never a refusal: the pull request's risk tier by the paths it changes over its base, by
//             main's .centralu/tiers.json (scripts/tier.mjs, #1259); deep when there are no rules or
//             they cannot be read. The board writes it into Verified and labels the pull request tier:<name>.
//
// Each check runs in a temporary worktree of its own commit, in one folder per run, so the person's
// checkout is never touched. `--exempt <check>=<reason>` leaves one check out and says why. The
// board's `open_pr` runs this and refuses with its findings (.centralu/apps/project-board, pre-pr.mjs).
//
//   node scripts/pre-pr.mjs [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--exempt <check>=<reason>]...
//                           [--remote <name>] [--no-fetch] [--json] [--run-id <id>] [--guards-limit <seconds>]
//   node scripts/pre-pr.mjs --cleanup <run-id>     removes what a run that was killed left behind
//
// --head defaults to HEAD, --main to <remote>/main, --base (what the pull request merges into: a lower
// pull request's branch in a stack) to main. Unless --no-fetch, the remote is fetched first. The heads of
// the stack are the local and remote branches between main and the head, and each --stack ref (the
// board's open_pr fetches the stack under refs of its own and names them so).
// Exit 0 when nothing was found, 1 with findings, 2 when it could not check, 130 when interrupted.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMain } from './is-main.mjs'
import { tierOfChange, unjudged } from './tier.mjs'

// --- What a path is ------------------------------------------------------------------------------

/** A file the tests own: a test, a test helper, a fixture, the UI scenarios. Never reverted. */
export function isTestFile(path) {
  return /(?:^|\/)(?:e2e|fixtures|__tests__)\//.test(path) || /\.(?:test|spec)(?:-helpers)?\.[cm]?[jt]sx?$/.test(path)
}

/** A file vitest runs (vitest.config.ts: everything but e2e/). */
export function isVitestFile(path) {
  return /\.test\.[cm]?[jt]sx?$/.test(path) && !/(?:^|\/)e2e\//.test(path)
}

// --- Reading the tools' answers --------------------------------------------------------------------

/**
 * The pull request heads of a stack, oldest first: every ref whose tip is one of `commits` (the
 * commits from main to the head, oldest first), and the head itself last. Refs on one commit are one head.
 */
export function stackHeads({ commits, refs, head }) {
  const at = new Map(commits.map((sha, i) => [sha, i]))
  const by = new Map()
  for (const r of refs) {
    if (!at.has(r.sha)) continue
    if (!by.has(r.sha)) by.set(r.sha, { sha: r.sha, names: [] })
    if (!by.get(r.sha).names.includes(r.name)) by.get(r.sha).names.push(r.name)
  }
  if (!by.has(head.sha)) by.set(head.sha, { sha: head.sha, names: [] })
  if (!by.get(head.sha).names.includes(head.name)) by.get(head.sha).names.unshift(head.name)
  return [...by.values()].sort((a, b) => (at.get(a.sha) ?? Infinity) - (at.get(b.sha) ?? Infinity))
}

/** dependency-cruiser's JSON: the files no-orphans names, whatever severity the config gives it. */
export function orphansOf(cruise) {
  return [...new Set((cruise?.summary?.violations ?? []).filter((v) => v?.rule?.name === 'no-orphans').map((v) => v.from))].sort()
}

/** vitest's JSON reporter: every test as `{ file, name, status }`, the file relative to `root` with `/`. */
export function vitestTests(report, root) {
  return (report?.testResults ?? []).flatMap((f) =>
    (f.assertionResults ?? []).map((t) => ({
      file: relative(root, f.name).split('\\').join('/'),
      name: [...(t.ancestorTitles ?? []), t.title].join(' > '),
      status: t.status,
    })),
  )
}

/** The tests that pass with the source changes reverted and were not in the base's version of their file. */
export function passingNewTests({ reverted, base }) {
  const before = new Set(base.map((t) => `${t.file}\0${t.name}`))
  return reverted.filter((t) => t.status === 'passed' && !before.has(`${t.file}\0${t.name}`))
}

/** The tests that failed: a skipped or todo test is neither passing nor failing. */
export const failedTests = (tests) => tests.filter((t) => t.status === 'failed')

// --- Running things ------------------------------------------------------------------------------

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' }

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}

/**
 * A path as the file system names it: links followed, and on Windows the 8.3 short names
 * (`RUNNER~1`) written out. tsc compares files by the path it reached them by, so one folder reached by two
 * spellings (a temporary folder named in its short form, and a link's target in its long form) is two
 * folders and one class has two declarations (#1254). A path that does not exist is answered as it is.
 */
export function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

const tail = (text, lines = 25) => String(text ?? '').trim().split('\n').slice(-lines).join('\n')

/** Runs a Node entry point of the worktree's own node_modules; answers { ok, out }. */
function nodeBin(worktree, bin, args, env = {}, timeout = 0) {
  const dir = canonical(worktree)
  try {
    const out = execFileSync(process.execPath, [join(dir, 'node_modules', bin), ...args], { cwd: dir, encoding: 'utf8', timeout, env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || String(e.message) }
  }
}

/** The folders named node_modules in a checkout: its root's and each workspace package's (two levels down). */
export function nodeModulesDirs(root) {
  const found = []
  const walk = (rel, depth) => {
    if (existsSync(join(root, rel, 'node_modules'))) found.push(rel ? `${rel}/node_modules` : 'node_modules')
    if (depth === 2) return
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(rel ? `${rel}/${e.name}` : e.name, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/** A link to a folder: a junction on Windows (no privilege needed), a symbolic link elsewhere */
const FOLDER_LINK = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * Gives a worktree the checkout's installed dependencies without installing (#1254): each node_modules
 * folder of the checkout (see {@link nodeModulesDirs}) is mirrored as a real folder of links, and a link
 * that leads to a package of the workspace points at that package in the worktree, not in the checkout.
 * Linking the folder itself, as this once did, made tsc follow `@cc/platform` back to the checkout's
 * sources while the worktree's own files stayed where they are: one class with two declarations, and
 * `Types have separate declarations of a private property`. Any other link (pnpm's store, a plain
 * folder) points at what it is in the checkout; plain files (pnpm's state) are not given. A folder of the
 * checkout that the worktree has no place for is left out, as is a workspace package the worktree lacks.
 * Running it again over what is there (after the links were taken away) fills in what is missing.
 * Answers how many folders were mirrored. removeWorktree takes every link away before the worktree goes.
 */
export function mirrorModules(root, worktree, folders = nodeModulesDirs(root)) {
  // Every path below is the file system's own spelling of it, whatever way the caller named the folders (canonical)
  const rootReal = canonical(root)
  const dir = canonical(worktree)
  const inWorkspace = (target) => {
    const rel = relative(rootReal, target)
    return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.split(sep).includes('node_modules') ? rel : null
  }
  const link = (target, path) => {
    let st
    try {
      st = statSync(target)
    } catch {
      return // dangling: nothing to give
    }
    // A junction cannot lead to a file (on Windows it is made without a word, and reads as nothing): a copy does
    if (st.isDirectory()) symlinkSync(target, path, FOLDER_LINK)
    else if (st.isFile()) copyFileSync(target, path)
  }
  const mirror = (src, dst) => {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, e.name)
      const d = join(dst, e.name)
      const isLink = lstatSync(s).isSymbolicLink()
      // A scope (@cc, @types) holds links of its own, which may be workspace packages
      if (!isLink && e.isDirectory() && e.name.startsWith('@')) {
        mirror(s, d)
        continue
      }
      // What is there already stays: prepare runs again after the links were taken away (the revert check),
      // which leaves these folders, and their scopes, as real and empty ones
      if (lstatSync(d, { throwIfNoEntry: false })) continue
      if (isLink) {
        let target
        try {
          target = realpathSync.native(s)
        } catch {
          continue
        }
        const rel = inWorkspace(target)
        if (!rel) link(target, d)
        else if (existsSync(join(dir, rel))) link(join(dir, rel), d)
      } else if (e.isDirectory()) link(s, d)
      // A plain file is pnpm's state (.modules.yaml, naming the checkout's store): not copied, since a
      // pnpm install into the worktree would trust it and tsc, vitest and dependency-cruiser do not read it
    }
  }
  let n = 0
  for (const rel of folders) {
    const at = join(dir, rel)
    if (!existsSync(dirname(at))) continue
    mirror(join(rootReal, rel), at)
    n++
  }
  return n
}

const sameText = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a, 'utf8').replace(/\r\n/g, '\n') === readFileSync(b, 'utf8').replace(/\r\n/g, '\n')

/**
 * The pnpm to install with: the one running `pnpm pre-pr` (npm_execpath), else `pnpm` on PATH. A
 * machine can have more than one, and the first on PATH need not be the version the repository pins.
 */
function pnpm(args, dir) {
  const self = process.env.npm_execpath
  const opts = { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }
  try {
    if (self && /pnpm/i.test(self)) return /\.[cm]?js$/.test(self) ? execFileSync(process.execPath, [self, ...args], opts) : execFileSync(self, args, opts)
    // pnpm is a .cmd on Windows, which only a shell starts; the arguments are fixed words
    return execFileSync('pnpm', args, { ...opts, shell: process.platform === 'win32' })
  } catch (e) {
    throw new Error(`pnpm ${args.join(' ')} failed in ${dir}:\n${tail(`${e.stdout ?? ''}${e.stderr ?? ''}`)}`)
  }
}

/** The real tools. Each takes a worktree (`gh`: the checkout, to run in); tests replace them. */
export const realRunners = {
  /** Runs `gh` in the checkout; answers its stdout. */
  gh(args, dir) {
    try {
      return execFileSync('gh', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
    } catch (e) {
      throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${tail(`${e.stderr ?? ''}${e.message}`, 3)}`)
    }
  },
  /**
   * Gives a worktree its dependencies. When the worktree's lockfile is the one the checkout
   * installed, its node_modules folders are mirrored with links (seconds, no network; workspace packages stay the worktree's own); otherwise pnpm installs
   * into the worktree. removeRun takes every link away before the worktree goes: a delete that
   * followed one would reach the checkout's own dependencies. With `linkOnly`, a worktree whose lockfile
   * differs is not installed (minutes, for each of many pull requests): answers false.
   */
  prepare(dir, root, { linkOnly = false } = {}) {
    if (!sameText(join(root, 'node_modules', '.pnpm', 'lock.yaml'), join(dir, 'pnpm-lock.yaml'))) {
      if (linkOnly) return false
      pnpm(['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], dir)
      return
    }
    mirrorModules(root, dir)
  },
  tsc(dir) {
    // The heap `pnpm typecheck` gives tsc (package.json): Node's default is a quarter of the machine's memory, under what
    // tsc needs on a 7 GB macOS runner (0.1.0-beta.43's rehearsal)
    return nodeBin(dir, 'typescript/bin/tsc', ['--noEmit', '-p', '.'], { NODE_OPTIONS: `${ENV.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim() })
  },
  depcruise(dir) {
    const r = nodeBin(dir, 'dependency-cruiser/bin/dependency-cruise.mjs', ['packages', 'apps', '--config', 'tooling/dependency-cruiser.cjs', '--output-type', 'json'])
    // It exits non-zero when a rule at error severity fails, with the JSON still on stdout
    const start = r.out.indexOf('{')
    return JSON.parse(r.out.slice(start))
  },
  vitest(dir, files, { timeoutMs = 0 } = {}) {
    const out = join(mkdtempSync(join(tmpdir(), 'cc-prepr-vitest-')), 'report.json')
    const data = mkdtempSync(join(tmpdir(), 'cc-prepr-data-'))
    try {
      // Failing tests exit non-zero, which is an answer here, not an error
      nodeBin(dir, 'vitest/vitest.mjs', ['run', '--reporter=json', `--outputFile=${out}`, ...files], { CC_DATA_DIR: data }, timeoutMs)
      return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
    } finally {
      rmSync(join(out, '..'), { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  },
}

// --- Worktrees, and taking them away again ---------------------------------------------------------

/** The checks a pull request can be exempted from, each with a reason. `main` is only ever a warning. */
export const CHECKS = ['tsc', 'orphans', 'store-step', 'guards', 'revert']

// --- Store step numbers (#1203) ----------------------------------------------------------------------

/** Where the store's migration steps are written: each step is a `to: N,` line of one of these files. */
export const STEP_DIR = 'packages/agent-host/src/dev-services/store/migrations/'
const STEP_LINE = /^[ \t]*to:[ \t]*(\d+)[ \t]*,/

/** The step numbers a file's text declares. */
export function stepNumbers(text) {
  return [...String(text).matchAll(new RegExp(STEP_LINE.source, 'gm'))].map((m) => Number(m[1]))
}

/**
 * The step numbers a unified diff adds under {@link STEP_DIR}: a `to: N,` line added and not removed again
 * in the same diff (a step moved to another file, or reformatted, is not a new number).
 */
export function stepsAddedByDiff(diff) {
  const added = new Set()
  const removed = new Set()
  let inSteps = false
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) inSteps = line.slice(line.lastIndexOf(' b/') + 3).startsWith(STEP_DIR)
    else if (inSteps && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      const m = STEP_LINE.exec(line.slice(1))
      if (m) (line[0] === '+' ? added : removed).add(Number(m[1]))
    }
  }
  return [...added].filter((n) => !removed.has(n)).sort((a, b) => a - b)
}

/**
 * The findings for the step numbers a branch adds: one for each that main already has, and for each that
 * another open pull request adds. `onMain` maps a number to the file that declares it; `others` is
 * `[{ number, title, head, steps }]`.
 */
export function stepFindings({ added, onMain, others }) {
  const findings = []
  const ask = 'The orchestrator assigns store step numbers (CONTRIBUTING.md): ask for a free one and renumber, or exempt this check with the reason it stands.'
  for (const n of added) {
    if (onMain.has(n)) findings.push({ check: 'store-step', message: `Store step ${n} is already on main (${onMain.get(n)}). ${ask}` })
    for (const pr of others) {
      if (pr.steps.includes(n)) findings.push({ check: 'store-step', message: `Store step ${n} is also added by open pull request #${pr.number} "${pr.title}" (${pr.head}): whichever lands second conflicts. ${ask}` })
    }
  }
  return findings
}

/** The number to file of each step under {@link STEP_DIR} at a commit. */
function stepsAt(root, commit) {
  const found = new Map()
  let out = ''
  try {
    out = git(root, ['grep', '-n', '-E', '^[[:space:]]*to:[[:space:]]*[0-9]+[[:space:]]*,', commit, '--', STEP_DIR])
  } catch {
    return found // git grep exits 1 when nothing matches
  }
  for (const l of out.split('\n').filter(Boolean)) {
    const [path, , ...text] = l.slice(commit.length + 1).split(':')
    const m = STEP_LINE.exec(text.join(':'))
    if (m) found.set(Number(m[1]), path.slice(STEP_DIR.length))
  }
  return found
}

/** The open pull requests that are not the stack's own: a head that is one of its `commits`, or one of its branches' `names`. */
export function otherPrs(listed, commits, names) {
  const own = new Set(commits)
  return listed.filter((pr) => !own.has(pr.headRefOid) && !names.has(pr.headRefName))
}

/**
 * The open pull requests that add store steps, leaving out the stack's own (a head that is one of its
 * `commits`, or one of its branches' `names`). Only a pull request that touches {@link STEP_DIR} costs a full diff.
 */
function otherPrsAddingSteps({ gh, root, listed, commits, names }) {
  const others = []
  for (const pr of otherPrs(listed, commits, names)) {
    const files = String(gh(['pr', 'diff', String(pr.number), '--name-only'], root)).split('\n')
    if (!files.some((f) => f.trim().startsWith(STEP_DIR))) continue
    const steps = stepsAddedByDiff(gh(['pr', 'diff', String(pr.number)], root))
    if (steps.length) others.push({ number: pr.number, title: pr.title, head: pr.headRefName, steps })
  }
  return others
}

// --- Guards against the open pull requests (the day-1 cost: a guard landed, a queued pull request broke) --------

/** A test that scans the whole repository: a derived path up from the test's folder, and a walk or a `git ls-files`. */
const REPO_SCAN = /ls-files|readdirSync\([^)]*recursive:\s*true|globSync|\bwalk\w*\(/
const REPO_ROOT = /REPO_ROOT|repoRoot|\bROOT\b|'\.\.\/\.\.|"\.\.\/\.\./
/** A file can say it is one: `pre-pr: guard` anywhere in it. */
const GUARD_MARK = /pre-pr: guard/

/** A repository-wide guard: a test under tooling/, a test that scans the repository from its root, or one that says so. */
export function isGuardTest(path, text = '') {
  if (!isVitestFile(path)) return false
  return /^tooling\/[^/]+\.test\.[cm]?[jt]sx?$/.test(path) || GUARD_MARK.test(text) || (REPO_SCAN.test(text) && REPO_ROOT.test(text))
}

/** The guard files a branch adds or changes over `from` (a commit), read at `to`. */
export function guardFiles(root, from, to) {
  const parts = git(root, ['diff', '--name-status', '--no-renames', '-z', from, to]).split('\0').filter(Boolean)
  const guards = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const path = parts[i + 1]
    if (parts[i][0] === 'D' || !isVitestFile(path)) continue
    let text = ''
    try {
      text = git(root, ['show', `${to}:${path}`])
    } catch {
      continue
    }
    if (isGuardTest(path, text)) guards.push(path)
  }
  return guards
}

// vitest colours its messages: the escape character is what is stripped
// eslint-disable-next-line no-control-regex
const stripAnsi = (t) => String(t ?? '').replace(/\u001b\[[0-9;]*m/g, '')

/** The failures of a vitest JSON report as `{ file, name, line }`, `line` the first line of the message. */
export function failuresOf(report, root) {
  const firstLine = (m) => stripAnsi(m).split('\n').map((l) => l.trim()).find(Boolean) ?? 'failed'
  return (report?.testResults ?? []).flatMap((f) => {
    const file = relative(root, f.name).split('\\').join('/')
    const tests = (f.assertionResults ?? []).filter((t) => t.status === 'failed')
    if (tests.length) return tests.map((t) => ({ file, name: [...(t.ancestorTitles ?? []), t.title].join(' > '), line: firstLine(t.failureMessages?.[0]) }))
    // A file that did not load (or timed out) has no test of its own to fail
    return f.status === 'failed' ? [{ file, name: '', line: firstLine(f.message) }] : []
  })
}

/** The most one pull request's guards may take, and the default for the whole check. */
export const GUARDS_PER_PR_MS = 5 * 60_000
export const GUARDS_LIMIT_MS = 10 * 60_000

/**
 * Runs `guards` (files of this branch) against each of `prs` (open, not the stack's own) with this branch
 * merged in: a commit of the pull request's head and `head`, made from a merge that did not conflict. Answers
 * `{ failing, skipped, unchecked }`; never throws for one pull request's trouble. `makeWorktree(commit)`
 * answers a worktree, or null when its dependencies would need an install.
 */
export function runGuards({ root, remote, runId, runners, prs, head, guards, makeWorktree, dropWorktree, limitMs, now, log, check }) {
  const failing = []
  const skipped = []
  const unchecked = []
  const deadline = now() + limitMs
  const space = `refs/centralu-pre-pr-guards/${runId}`
  const ident = { GIT_AUTHOR_NAME: 'pre-pr', GIT_AUTHOR_EMAIL: 'pre-pr@localhost', GIT_COMMITTER_NAME: 'pre-pr', GIT_COMMITTER_EMAIL: 'pre-pr@localhost' }
  try {
    try {
      git(root, ['fetch', '--no-tags', '--quiet', remote, ...prs.map((p) => `+refs/pull/${p.number}/head:${space}/${p.number}`)])
    } catch (e) {
      return { failing, skipped: prs.map((p) => ({ pr: p, why: `its head could not be fetched (${tail(e.stderr ?? e.message, 1)})` })), unchecked }
    }
    for (const pr of prs) {
      check()
      if (now() >= deadline) {
        unchecked.push(pr)
        continue
      }
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
        const commit = git(root, ['commit-tree', tree, '-p', theirs, '-p', head, '-m', `pre-pr guards: #${pr.number} with this branch`], ident).trim()
        wt = makeWorktree(commit)
        if (!wt) {
          skipped.push({ pr, why: 'needs other dependencies than this checkout has (a different lockfile)' })
          continue
        }
        const present = guards.filter((g) => existsSync(join(wt, g)))
        if (!present.length) continue
        log(`guards against #${pr.number}`)
        const report = runners.vitest(wt, present, { timeoutMs: Math.max(1000, Math.min(GUARDS_PER_PR_MS, deadline - now())) })
        if (!report) {
          skipped.push({ pr, why: 'vitest gave no report (it ran out of time, or did not start)' })
          continue
        }
        const fails = failuresOf(report, wt)
        if (fails.length) failing.push({ pr, failures: fails })
      } catch (e) {
        if (String(e.message) === 'interrupted') throw e
        skipped.push({ pr, why: `could not be checked (${tail(e.message, 1)})` })
      } finally {
        if (wt) dropWorktree(wt)
      }
    }
  } finally {
    for (const pr of prs) {
      try {
        git(root, ['update-ref', '-d', `${space}/${pr.number}`])
      } catch {
        // never made, or already gone
      }
    }
  }
  return { failing, skipped, unchecked }
}

/** The warnings for a {@link runGuards} answer: one for each pull request it would fail, one for what was not checked. */
export function guardWarnings({ failing, skipped, unchecked }, guards) {
  const warnings = failing.map(({ pr, failures }) => {
    const first = failures[0]
    const more = failures.length > 1 ? ` (and ${failures.length - 1} more)` : ''
    return { check: 'guards', message: `#${pr.number} "${pr.title}" (${pr.headRefName}) would fail ${first.file}${first.name ? ` > ${first.name}` : ''} with this branch merged in: ${first.line}${more}. Fix it in this change, or tell its author.` }
  })
  const left = [...skipped.map(({ pr, why }) => `#${pr.number} (${why})`), ...unchecked.map((pr) => `#${pr.number} (time limit reached)`)]
  if (left.length) warnings.push({ check: 'guards', message: `${guards.join(', ')} was not run against: ${left.join('; ')}.` })
  return warnings
}

/** Every run keeps its worktrees in one folder of the temporary folder, named after the run. */
export const RUN_PREFIX = 'cc-pre-pr-'
export const runDir = (id) => join(canonical(tmpdir()), `${RUN_PREFIX}${id}`)

/**
 * Removes every link (a symlink, or a junction on Windows) under `dir` down to `depth` levels,
 * without ever following one. The dependency links a worktree gets lead into the checkout's own
 * node_modules: a recursive delete that followed one would empty the checkout's dependencies. The
 * default reaches the deepest of them: packages/ui/node_modules/@cc/core, five levels down (see
 * {@link mirrorModules}). A `.pnpm` folder is a real one only where pnpm installed into the worktree,
 * and its links lead inside it: they are left to the removal of the folder.
 */
export function unlinkLinks(dir, depth = 5) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let n = 0
  for (const e of entries) {
    const p = join(dir, e.name)
    let st
    try {
      st = lstatSync(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      unlinkSync(p)
      n++
    } else if (st.isDirectory() && depth > 1 && e.name !== '.git' && e.name !== '.pnpm') {
      n += unlinkLinks(p, depth - 1)
    }
  }
  return n
}

/** Takes one worktree of a run away, links first. Answers what went wrong, or null. */
export function removeWorktree(wt, root) {
  try {
    unlinkLinks(wt)
    // A second look finds nothing, or nothing is removed: never a recursive delete with a link inside
    if (unlinkLinks(wt) !== 0) throw new Error('a link came back')
  } catch (err) {
    return `${wt}: its dependency links could not be removed (${err.message}); remove the links, then the folder`
  }
  try {
    git(root, ['worktree', 'remove', '--force', wt])
  } catch {
    rmSync(wt, { recursive: true, force: true })
  }
  return null
}

/**
 * Takes a run's folder away: the links in each worktree first, then the worktree (through git, so
 * the checkout forgets it), then the folder. Safe on a run that died halfway: it reads nothing but
 * the folder. Answers what it could not remove.
 */
export function removeRun(dir, root) {
  const left = []
  if (!existsSync(dir)) return left
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('wt-')) continue
    const problem = removeWorktree(join(dir, e.name), root)
    if (problem) left.push(problem)
  }
  if (!left.length) rmSync(dir, { recursive: true, force: true })
  try {
    git(root, ['worktree', 'prune'])
  } catch {
    // the checkout may be gone; nothing of it to forget then
  }
  return left
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Removes the folders of earlier runs on this checkout whose process is gone (killed, or the machine slept through a timeout). */
export function sweepStale(root, { isAlive = alive } = {}) {
  const swept = []
  const temp = canonical(tmpdir())
  for (const name of readdirSync(temp)) {
    if (!name.startsWith(RUN_PREFIX)) continue
    const dir = join(temp, name)
    let owner
    try {
      owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'))
    } catch {
      continue
    }
    if (resolve(owner.root ?? '') !== resolve(root) || isAlive(owner.pid)) continue
    if (!removeRun(dir, root).length) swept.push(dir)
  }
  return swept
}

// --- The checks ----------------------------------------------------------------------------------

/**
 * Runs every check; answers { ok, findings, warnings, exempted, notes, heads, head }. A finding fails
 * the run; a warning does not. `exempt` maps a check of {@link CHECKS} to the reason it is not run.
 * `runners` replaces the tools (tests); `log` hears progress; `stopped()` says the run was interrupted.
 */
export function prePr({ cwd = process.cwd(), head = 'HEAD', base, main, stack = [], remote = 'origin', fetch = true, exempt = {}, runId = `${process.pid}-${Date.now()}`, runners = realRunners, log = () => {}, stopped = () => false, guardsLimitMs = GUARDS_LIMIT_MS, now = Date.now } = {}) {
  const root = resolve(git(cwd, ['rev-parse', '--show-toplevel']).trim())
  for (const [check, why] of Object.entries(exempt)) {
    if (!CHECKS.includes(check)) throw new Error(`No check is called ${check}; the checks are ${CHECKS.join(', ')}.`)
    if (!String(why ?? '').trim()) throw new Error(`An exemption from ${check} needs its reason.`)
  }
  const skip = (check) => Object.hasOwn(exempt, check)
  main ??= `${remote}/main`
  base ??= main
  for (const dir of sweepStale(root)) log(`Removed ${dir}, left by a run that did not finish`)
  if (fetch) {
    log(`Fetching ${remote}`)
    git(root, ['fetch', '--quiet', '--no-tags', remote])
  }
  const sha = (ref) => {
    try {
      return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim()
    } catch {
      throw new Error(`${ref} is not a commit here.`)
    }
  }
  const at = { head: sha(head), base: sha(base), main: sha(main) }
  const findings = []
  const warnings = []
  const notes = []
  const exempted = Object.entries(exempt).map(([check, reason]) => ({ check, reason: String(reason).trim() }))
  const short = (s) => s.slice(0, 10)
  let tier = null
  const answer = (heads) => ({ ok: findings.length === 0, findings, warnings, exempted, notes, heads: heads.map((h) => ({ sha: h.sha, names: h.names })), head: at.head, tier })

  // tier: never a refusal. The review this pull request needs, from the paths it changes over its base, by main's
  // rules; when it cannot be read it is deep, so a broken rules file never lets a change through unreviewed
  try {
    const t = tierOfChange({ root, base: at.base, head: at.head, rulesRef: at.main })
    tier = { name: t.tier, line: t.line, because: t.because.map((f) => f.path) }
  } catch (e) {
    const t = unjudged(`the tier could not be read: ${String(e.message).trim()}`)
    tier = { name: t.tier, line: t.line, because: [] }
    warnings.push({ check: 'tier', message: `The tier could not be read, so it is deep: ${e.message}` })
  }

  // main: a warning, not a finding. The merge queue merges main in anyway; what matters is that a merge would not conflict
  let containsMain = true
  try {
    git(root, ['merge-base', '--is-ancestor', at.main, at.head])
  } catch {
    containsMain = false
  }
  if (!containsMain) {
    const behind = git(root, ['rev-list', '--count', `${at.head}..${at.main}`]).trim()
    let conflicts = []
    try {
      git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', at.main, at.head])
    } catch (e) {
      // Exit 1: the tree's id, then one conflicted file a line
      conflicts = String(e.stdout ?? '').trim().split('\n').slice(1).filter(Boolean)
    }
    warnings.push({
      check: 'main',
      message: `${head} does not contain ${main}: ${behind} commit(s) behind. The merge queue merges it in; checked without it.${conflicts.length ? ` A merge conflicts in: ${conflicts.join(', ')}: rebase or merge before it lands.` : ''}`,
    })
  }

  const commits = git(root, ['rev-list', '--reverse', `${at.main}..${at.head}`]).split('\n').filter(Boolean)
  if (!commits.length) {
    notes.push(`${head} has no commits over ${main}: nothing to check.`)
    return answer([])
  }
  const refs = git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', `refs/remotes/${remote}`])
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, l.indexOf(' ')), name: l.slice(l.indexOf(' ') + 1) }))
    .filter((r) => !r.name.endsWith('/HEAD'))
  for (const name of stack) refs.push({ sha: sha(name), name })
  const heads = stackHeads({ commits, refs, head: { sha: at.head, name: head } })

  // The run's folder, with who owns it, so a run that dies halfway is cleaned up by the next (sweepStale) or by --cleanup
  const dir = runDir(runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'owner.json'), `${JSON.stringify({ pid: process.pid, root })}\n`)
  let made = 0
  const worktree = (commit, options) => {
    const wt = join(dir, `wt-${++made}`)
    git(root, ['worktree', 'add', '--detach', '--quiet', wt, commit])
    if (runners.prepare(wt, root, options) === false) {
      removeWorktree(wt, root)
      return null
    }
    return wt
  }
  // The open pull requests, read once for the checks that look at them
  let listed
  const openPrs = () =>
    (listed ??= JSON.parse(runners.gh(['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,headRefName,headRefOid,isDraft'], root)))
  const names = new Set(heads.flatMap((h) => h.names).flatMap((n) => [n, n.replace(`${remote}/`, ''), n.replace(/^refs\/centralu-pre-pr\/[^/]+\//, '')]))
  const check = () => {
    if (stopped()) throw new Error('interrupted')
  }
  try {
    let top = ''
    for (const h of skip('tsc') ? heads.filter((x) => x.sha === at.head) : heads) {
      check()
      const label = `${h.names.join(', ')} (${short(h.sha)})`
      const wt = worktree(h.sha)
      if (h.sha === at.head) top = wt
      if (skip('tsc')) continue
      log(`tsc at ${label}`)
      const r = runners.tsc(wt)
      if (!r.ok) findings.push({ check: 'tsc', message: `tsc fails at ${label}; each pull request of a stack lands on its own and must build:\n${tail(r.out)}` })
    }

    check()
    if (!skip('orphans')) {
      log('dependency-cruiser, orphans as errors')
      for (const file of orphansOf(runners.depcruise(top))) {
        findings.push({ check: 'orphans', message: `${file} is imported by nothing (no-orphans): delete it, import it, or list it in tooling/dependency-cruiser.cjs with why.` })
      }
    }

    // store-step: the numbers this branch (the whole stack) adds over where it forked from main
    if (!skip('store-step')) {
      const forkMain = git(root, ['merge-base', at.main, at.head]).trim()
      const added = stepsAddedByDiff(git(root, ['diff', '--no-renames', '-U0', forkMain, at.head, '--', STEP_DIR]))
      if (added.length) {
        log(`Store step(s) ${added.join(', ')}: looking at main and the open pull requests`)
        let others
        try {
          others = otherPrsAddingSteps({ gh: runners.gh, root, listed: openPrs(), commits, names })
        } catch (e) {
          throw new Error(`Store step(s) ${added.join(', ')} are new here, and the open pull requests could not be read (${e.message}). Run it where gh is logged in, or exempt store-step with the reason.`)
        }
        findings.push(...stepFindings({ added, onMain: stepsAt(root, at.main), others }))
      }
    }

    // revert: the changed tests, at the head, with everything else the pull request changed put back.
    // Against where the head left the base, not the base's tip: what the base gained since is not this pull request's
    const fork = git(root, ['merge-base', at.base, at.head]).trim()
    const changed = git(root, ['diff', '--name-status', '--no-renames', '-z', fork, at.head])
      .split('\0')
      .filter(Boolean)
      .reduce((acc, part, i, all) => (i % 2 === 0 ? [...acc, { status: part[0], path: all[i + 1] }] : acc), [])
    const tests = changed.filter((c) => c.status !== 'D' && isVitestFile(c.path))
    if (skip('revert')) {
      // nothing: the exemption and its reason are in the answer
    } else if (!tests.length) {
      notes.push(`No new or changed vitest file against ${base}.`)
    } else {
      check()
      const sources = changed.filter((c) => !isTestFile(c.path))
      log(`Running ${tests.length} test file(s) with ${sources.length} other change(s) reverted to ${base}`)
      for (const c of sources) {
        if (c.status === 'A') rmSync(join(top, c.path), { force: true })
        else git(top, ['checkout', fork, '--', c.path])
      }
      // The dependencies changed: the base's, installed (the links go first, so nothing installs through them)
      if (sources.some((c) => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/.test(c.path))) {
        unlinkLinks(top)
        runners.prepare(top, root)
      }
      const run = (files) => {
        check()
        const report = runners.vitest(top, files)
        if (!report) notes.push(`vitest gave no report for ${files.join(', ')}.`)
        return vitestTests(report, top)
      }
      const reverted = run(tests.map((t) => t.path))
      const existed = tests.filter((t) => t.status !== 'A').map((t) => t.path)
      for (const p of existed) git(top, ['checkout', fork, '--', p])
      const before = existed.length ? run(existed) : []
      const loose = passingNewTests({ reverted, base: before })
      for (const t of loose) {
        findings.push({ check: 'revert', message: `${t.file}: "${t.name}" passes with this pull request's other changes reverted to ${base}, so it protects nothing. Make it fail without the change, or exempt the revert check with the reason it cannot.` })
      }
      if (!loose.length) notes.push(`${failedTests(reverted).length} test(s) of ${tests.length} changed file(s) fail without the change; no new test passes without it.`)
    }

    // guards: only a warning. The guards this branch adds or changes, against the open pull requests with it merged in
    if (!skip('guards')) {
      check()
      const guards = guardFiles(root, git(root, ['merge-base', at.main, at.head]).trim(), at.head)
      if (guards.length) {
        let prs
        try {
          prs = otherPrs(openPrs(), commits, names).filter((p) => !p.isDraft)
        } catch (e) {
          warnings.push({ check: 'guards', message: `${guards.join(', ')} could not be run against the open pull requests: they could not be read (${e.message}).` })
        }
        if (prs) {
          log(`Guard(s) ${guards.join(', ')}: against ${prs.length} open pull request(s), at most ${Math.round(guardsLimitMs / 1000)} s`)
          const res = runGuards({ root, remote, runId, runners, prs, head: at.head, guards, makeWorktree: (commit) => worktree(commit, { linkOnly: true }), dropWorktree: (wt) => removeWorktree(wt, root), limitMs: guardsLimitMs, now, log, check })
          warnings.push(...guardWarnings(res, guards))
          notes.push(`${guards.join(', ')} run against ${prs.length} open pull request(s): ${res.failing.length} would fail, ${res.skipped.length} skipped, ${res.unchecked.length} not reached.`)
        }
      }
    }
  } finally {
    for (const left of removeRun(dir, root)) notes.push(`Left ${left}.`)
  }
  return answer(heads)
}

export function parseArgs(argv) {
  const o = { fetch: true, json: false, stack: [], exempt: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = argv[i + 1]
    if (a === '--json') o.json = true
    else if (a === '--no-fetch') o.fetch = false
    else if (['--head', '--base', '--main', '--remote'].includes(a) && value !== undefined) o[a.slice(2)] = argv[++i]
    else if (a === '--run-id' && value !== undefined) o.runId = argv[++i]
    else if (a === '--cleanup' && value !== undefined) o.cleanup = argv[++i]
    else if (a === '--guards-limit' && /^\d+$/.test(value ?? '')) o.guardsLimitMs = Number(argv[++i]) * 1000
    else if (a === '--stack' && value !== undefined) o.stack.push(argv[++i])
    else if (a === '--exempt' && value !== undefined && value.includes('=')) {
      const [check, ...why] = argv[++i].split('=')
      o.exempt[check] = why.join('=')
    } else throw new Error(`Unknown argument ${a}. Usage: pnpm pre-pr [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--exempt <check>=<reason>]... [--remote <name>] [--no-fetch] [--json] [--run-id <id>] [--guards-limit <seconds>] | --cleanup <run-id>`)
  }
  if (o.runId !== undefined && !/^[\w.-]+$/.test(o.runId)) throw new Error('--run-id takes letters, digits, ".", "_" and "-" only.')
  if (o.cleanup !== undefined && !/^[\w.-]+$/.test(o.cleanup)) throw new Error('--cleanup takes a run id: letters, digits, ".", "_" and "-" only.')
  return o
}

function main() {
  let o
  // Ctrl-C reaches the tool running now, which fails; then the run's folder is removed and it exits
  let interrupted = false
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => (interrupted = true))
  try {
    o = parseArgs(process.argv.slice(2))
    if (o.cleanup !== undefined) {
      const root = resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim())
      const left = removeRun(runDir(o.cleanup), root)
      for (const l of left) console.error(`Left ${l}.`)
      process.exitCode = left.length ? 2 : 0
      return
    }
    const r = prePr({ ...o, log: (m) => process.stderr.write(`pre-pr: ${m}\n`), stopped: () => interrupted })
    if (o.json) process.stdout.write(`${JSON.stringify(r)}\n`)
    else {
      if (r.tier) console.log(r.tier.line)
      for (const n of r.notes) console.log(n)
      for (const x of r.exempted) console.log(`- [${x.check}] not run: ${x.reason}`)
      for (const w of r.warnings) console.log(`! [${w.check}] ${w.message}`)
      for (const f of r.findings) console.log(`✗ [${f.check}] ${f.message}`)
      console.log(r.ok ? `pre-pr: nothing found (${r.heads.length} head(s) checked).` : `pre-pr: ${r.findings.length} finding(s).`)
    }
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    const message = interrupted ? 'interrupted' : e.message
    if (o?.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    else console.error(`pre-pr could not check: ${message}`)
    process.exitCode = interrupted ? 130 : 2
  }
}

if (isMain(import.meta.url)) main()
