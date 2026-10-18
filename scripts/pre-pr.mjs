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
//   revert    each new or changed vitest file is run at the head with every other change of the pull
//             request reverted to its base: a new test that passes there protects nothing
//             (CONTRIBUTING.md: a test must fail without its fix). Only tests new in this pull
//             request count; one that was already there passing is no news.
//
// Each check runs in a temporary worktree of its own commit, in one folder per run, so the person's
// checkout is never touched. `--exempt <check>=<reason>` leaves one check out and says why. The
// board's `open_pr` runs this and refuses with its findings (.centralu/apps/project-board, pre-pr.mjs).
//
//   node scripts/pre-pr.mjs [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--exempt <check>=<reason>]...
//                           [--remote <name>] [--no-fetch] [--json] [--run-id <id>]
//   node scripts/pre-pr.mjs --cleanup <run-id>     removes what a run that was killed left behind
//
// --head defaults to HEAD, --main to <remote>/main, --base (what the pull request merges into: a lower
// pull request's branch in a stack) to main. Unless --no-fetch, the remote is fetched first. The heads of
// the stack are the local and remote branches between main and the head, and each --stack ref (the
// board's open_pr fetches the stack under refs of its own and names them so).
// Exit 0 when nothing was found, 1 with findings, 2 when it could not check, 130 when interrupted.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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

// --- Running things ------------------------------------------------------------------------------

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' }

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}

const tail = (text, lines = 25) => String(text ?? '').trim().split('\n').slice(-lines).join('\n')

/** Runs a Node entry point of the worktree's own node_modules; answers { ok, out }. */
function nodeBin(dir, bin, args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'node_modules', bin), ...args], { cwd: dir, encoding: 'utf8', env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
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
   * installed, its node_modules folders are linked in (seconds, no network); otherwise pnpm installs
   * into the worktree. removeRun takes every link away before the worktree goes: a delete that
   * followed one would reach the checkout's own dependencies.
   */
  prepare(dir, root) {
    if (!sameText(join(root, 'node_modules', '.pnpm', 'lock.yaml'), join(dir, 'pnpm-lock.yaml'))) {
      pnpm(['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], dir)
      return
    }
    for (const rel of nodeModulesDirs(root)) {
      const at = join(dir, rel)
      if (!existsSync(join(at, '..')) || existsSync(at)) continue
      symlinkSync(join(root, rel), at, 'junction')
    }
  },
  tsc(dir) {
    return nodeBin(dir, 'typescript/bin/tsc', ['--noEmit', '-p', '.'])
  },
  depcruise(dir) {
    const r = nodeBin(dir, 'dependency-cruiser/bin/dependency-cruise.mjs', ['packages', 'apps', '--config', 'tooling/dependency-cruiser.cjs', '--output-type', 'json'])
    // It exits non-zero when a rule at error severity fails, with the JSON still on stdout
    const start = r.out.indexOf('{')
    return JSON.parse(r.out.slice(start))
  },
  vitest(dir, files) {
    const out = join(mkdtempSync(join(tmpdir(), 'cc-prepr-vitest-')), 'report.json')
    const data = mkdtempSync(join(tmpdir(), 'cc-prepr-data-'))
    try {
      // Failing tests exit non-zero, which is an answer here, not an error
      nodeBin(dir, 'vitest/vitest.mjs', ['run', '--reporter=json', `--outputFile=${out}`, ...files], { CC_DATA_DIR: data })
      return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
    } finally {
      rmSync(join(out, '..'), { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  },
}

// --- Worktrees, and taking them away again ---------------------------------------------------------

/** The checks a pull request can be exempted from, each with a reason. `main` is only ever a warning. */
export const CHECKS = ['tsc', 'orphans', 'store-step', 'revert']

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

/**
 * The open pull requests that add store steps, leaving out the stack's own (a head that is one of its
 * `commits`, or one of its branches' `names`). Only a pull request that touches {@link STEP_DIR} costs a full diff.
 */
function otherPrsAddingSteps({ gh, root, commits, names }) {
  const own = new Set(commits)
  const listed = JSON.parse(gh(['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,headRefName,headRefOid'], root))
  const others = []
  for (const pr of listed) {
    if (own.has(pr.headRefOid) || names.has(pr.headRefName)) continue
    const files = String(gh(['pr', 'diff', String(pr.number), '--name-only'], root)).split('\n')
    if (!files.some((f) => f.trim().startsWith(STEP_DIR))) continue
    const steps = stepsAddedByDiff(gh(['pr', 'diff', String(pr.number)], root))
    if (steps.length) others.push({ number: pr.number, title: pr.title, head: pr.headRefName, steps })
  }
  return others
}

/** Every run keeps its worktrees in one folder of the temporary folder, named after the run. */
export const RUN_PREFIX = 'cc-pre-pr-'
export const runDir = (id) => join(tmpdir(), `${RUN_PREFIX}${id}`)

/**
 * Removes every link (a symlink, or a junction on Windows) under `dir` down to `depth` levels,
 * without ever following one. The dependency links a worktree gets lead into the checkout's own
 * node_modules: a recursive delete that followed one would empty the checkout's dependencies.
 */
export function unlinkLinks(dir, depth = 3) {
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
    } else if (st.isDirectory() && depth > 1 && e.name !== '.git') {
      n += unlinkLinks(p, depth - 1)
    }
  }
  return n
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
    const wt = join(dir, e.name)
    try {
      unlinkLinks(wt)
      // A second look finds nothing, or nothing is removed: never a recursive delete with a link inside
      if (unlinkLinks(wt) !== 0) throw new Error('a link came back')
    } catch (err) {
      left.push(`${wt}: its dependency links could not be removed (${err.message}); remove the links, then the folder`)
      continue
    }
    try {
      git(root, ['worktree', 'remove', '--force', wt])
    } catch {
      rmSync(wt, { recursive: true, force: true })
    }
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
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(RUN_PREFIX)) continue
    const dir = join(tmpdir(), name)
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
export function prePr({ cwd = process.cwd(), head = 'HEAD', base, main, stack = [], remote = 'origin', fetch = true, exempt = {}, runId = `${process.pid}-${Date.now()}`, runners = realRunners, log = () => {}, stopped = () => false } = {}) {
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
  const answer = (heads) => ({ ok: findings.length === 0, findings, warnings, exempted, notes, heads: heads.map((h) => ({ sha: h.sha, names: h.names })), head: at.head })

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
  const worktree = (commit) => {
    const wt = join(dir, `wt-${++made}`)
    git(root, ['worktree', 'add', '--detach', '--quiet', wt, commit])
    runners.prepare(wt, root)
    return wt
  }
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
        const names = new Set(heads.flatMap((h) => h.names).flatMap((n) => [n, n.replace(`${remote}/`, ''), n.replace(/^refs\/centralu-pre-pr\/[^/]+\//, '')]))
        let others
        try {
          others = otherPrsAddingSteps({ gh: runners.gh, root, commits, names })
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
      if (!loose.length) notes.push(`${reverted.filter((t) => t.status !== 'passed').length} test(s) of ${tests.length} changed file(s) fail without the change; no new test passes without it.`)
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
    else if (a === '--stack' && value !== undefined) o.stack.push(argv[++i])
    else if (a === '--exempt' && value !== undefined && value.includes('=')) {
      const [check, ...why] = argv[++i].split('=')
      o.exempt[check] = why.join('=')
    } else throw new Error(`Unknown argument ${a}. Usage: pnpm pre-pr [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--exempt <check>=<reason>]... [--remote <name>] [--no-fetch] [--json] [--run-id <id>] | --cleanup <run-id>`)
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
