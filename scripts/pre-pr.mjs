// The mechanical checks before a pull request opens (#1181): `pnpm pre-pr`.
//
// About a quarter of what reviewers sent back could have been caught by a machine before the pull
// request opened, and most merge-queue trouble was a branch that no longer fit main. So, on the
// commits a pull request carries (never the working tree, which a pull request does not carry):
//
//   main      the head contains main (rebased on it, or main merged in); if not, how far behind it is
//             and which files would conflict. The head's own build below is then main's too.
//   tsc       `tsc --noEmit` at every pull request head of the stack, oldest first: each branch tip
//             between main and the head, and the head. A lower pull request must build on its own,
//             since it lands on its own.
//   orphans   dependency-cruiser's `no-orphans` rule as an error (in `pnpm verify` it only warns).
//   revert    each new or changed vitest file is run at the head with every other change of the pull
//             request reverted to its base: a new test that passes there protects nothing
//             (CONTRIBUTING.md: a test must fail without its fix). Only tests new in this pull
//             request count; one that was already there passing is no news.
//
// Each check runs in a temporary worktree of its own commit, with its own `pnpm install` (offline
// when the store has it), so the person's checkout is never touched. The board's `open_pr` runs this
// and refuses with its findings (.centralu/apps/project-board, contribute-tools.mjs).
//
//   node scripts/pre-pr.mjs [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--remote <name>] [--no-fetch] [--json]
//
// --head defaults to HEAD, --main to <remote>/main, --base (what the pull request merges into: a lower
// pull request's branch in a stack) to main. Unless --no-fetch, the remote is fetched first. The heads of
// the stack are the local and remote branches between main and the head, and each --stack ref (the
// board's open_pr fetches the stack under refs of its own and names them so).
// Exit 0 when nothing was found, 1 with findings, 2 when it could not check.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
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

/** The real tools. Each takes a worktree; tests replace them. */
export const realRunners = {
  /**
   * Gives a worktree its dependencies; answers what undoes it. When the worktree's lockfile is the one
   * the checkout installed, its node_modules folders are linked in (seconds, no network); otherwise
   * pnpm installs into the worktree. The links are removed before the worktree is: removing a
   * worktree with a link still in it could reach through into the checkout's own dependencies.
   */
  prepare(dir, root) {
    if (!sameText(join(root, 'node_modules', '.pnpm', 'lock.yaml'), join(dir, 'pnpm-lock.yaml'))) {
      pnpm(['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], dir)
      return () => {}
    }
    const links = []
    for (const rel of nodeModulesDirs(root)) {
      const at = join(dir, rel)
      if (!existsSync(join(at, '..')) || existsSync(at)) continue
      symlinkSync(join(root, rel), at, 'junction')
      links.push(at)
    }
    return () => {
      for (const at of links) unlinkSync(at)
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
    const out = join(mkdtempSync(join(tmpdir(), 'cc-pre-pr-vitest-')), 'report.json')
    const data = mkdtempSync(join(tmpdir(), 'cc-pre-pr-data-'))
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

// --- The checks ----------------------------------------------------------------------------------

/**
 * Runs every check; answers { ok, findings: [{ check, message }], notes, heads }. `runners` replaces
 * the tools (tests); `log` hears progress.
 */
export function prePr({ cwd = process.cwd(), head = 'HEAD', base, main, stack = [], remote = 'origin', fetch = true, runners = realRunners, log = () => {} } = {}) {
  const root = resolve(git(cwd, ['rev-parse', '--show-toplevel']).trim())
  main ??= `${remote}/main`
  base ??= main
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
  const notes = []
  const short = (s) => s.slice(0, 10)

  // main: the head contains it, or the files a merge would conflict on
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
    findings.push({
      check: 'main',
      message: `${head} does not contain ${main}: ${behind} commit(s) behind. Rebase on it or merge it, then check again.${conflicts.length ? ` A merge conflicts in: ${conflicts.join(', ')}.` : ''}`,
    })
  }

  const commits = git(root, ['rev-list', '--reverse', `${at.main}..${at.head}`]).split('\n').filter(Boolean)
  if (!commits.length) {
    notes.push(`${head} has no commits over ${main}: nothing to check.`)
    return { ok: findings.length === 0, findings, notes, heads: [] }
  }
  const refs = git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', `refs/remotes/${remote}`])
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, l.indexOf(' ')), name: l.slice(l.indexOf(' ') + 1) }))
    .filter((r) => !r.name.endsWith('/HEAD'))
  for (const name of stack) refs.push({ sha: sha(name), name })
  const heads = stackHeads({ commits, refs, head: { sha: at.head, name: head } })

  // Each worktree: its directory, and what undoes its dependencies (links into the checkout)
  const trees = []
  const worktree = (commit) => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-pre-pr-'))
    git(root, ['worktree', 'add', '--detach', '--quiet', dir, commit])
    const t = { dir, release: () => {} }
    trees.push(t)
    t.release = runners.prepare(dir, root)
    return t
  }
  const removeTree = (t) => {
    trees.splice(trees.indexOf(t), 1)
    try {
      t.release()
    } catch (e) {
      // Never remove a worktree a link may still be in: that could reach the checkout's own files
      notes.push(`Left ${t.dir} in place: its dependency links could not be removed (${e.message}). Remove the links, then the folder.`)
      return
    }
    try {
      git(root, ['worktree', 'remove', '--force', t.dir])
    } catch {
      rmSync(t.dir, { recursive: true, force: true })
    }
  }
  try {
    let top = null
    for (const h of heads) {
      const label = `${h.names.join(', ')} (${short(h.sha)})`
      log(`tsc at ${label}`)
      const t = worktree(h.sha)
      const r = runners.tsc(t.dir)
      if (!r.ok) findings.push({ check: 'tsc', message: `tsc fails at ${label}; each pull request of a stack lands on its own and must build:\n${tail(r.out)}` })
      if (h.sha === at.head) top = t
      else removeTree(t)
    }

    log('dependency-cruiser, orphans as errors')
    for (const file of orphansOf(runners.depcruise(top.dir))) {
      findings.push({ check: 'orphans', message: `${file} is imported by nothing (no-orphans): delete it, import it, or list it in tooling/dependency-cruiser.cjs with why.` })
    }

    // revert: the changed tests, at the head, with everything else the pull request changed put back
    // Against where the head left the base, not the base's tip: what the base gained since is not this pull request's
    const fork = git(root, ['merge-base', at.base, at.head]).trim()
    const changed = git(root, ['diff', '--name-status', '--no-renames', '-z', fork, at.head])
      .split('\0')
      .filter(Boolean)
      .reduce((acc, part, i, all) => (i % 2 === 0 ? [...acc, { status: part[0], path: all[i + 1] }] : acc), [])
    const tests = changed.filter((c) => c.status !== 'D' && isVitestFile(c.path))
    if (!tests.length) {
      notes.push(`No new or changed vitest file against ${base}.`)
    } else {
      const sources = changed.filter((c) => !isTestFile(c.path))
      log(`Running ${tests.length} test file(s) with ${sources.length} other change(s) reverted to ${base}`)
      for (const c of sources) {
        if (c.status === 'A') rmSync(join(top.dir, c.path), { force: true })
        else git(top.dir, ['checkout', fork, '--', c.path])
      }
      // The dependencies changed: the base's, installed (the links go first, so nothing installs through them)
      if (sources.some((c) => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/.test(c.path))) {
        top.release()
        top.release = () => {}
        top.release = runners.prepare(top.dir, root)
      }
      const run = (files) => {
        const report = runners.vitest(top.dir, files)
        if (!report) notes.push(`vitest gave no report for ${files.join(', ')}.`)
        return vitestTests(report, top.dir)
      }
      const reverted = run(tests.map((t) => t.path))
      const existed = tests.filter((t) => t.status !== 'A').map((t) => t.path)
      for (const p of existed) git(top.dir, ['checkout', fork, '--', p])
      const before = existed.length ? run(existed) : []
      const loose = passingNewTests({ reverted, base: before })
      for (const t of loose) {
        findings.push({ check: 'revert', message: `${t.file}: "${t.name}" passes with this pull request's other changes reverted to ${base}, so it protects nothing. Make it fail without the change, or say in the pull request why it cannot.` })
      }
      if (!loose.length) notes.push(`${reverted.filter((t) => t.status !== 'passed').length} test(s) of ${tests.length} changed file(s) fail without the change; no new test passes without it.`)
    }
  } finally {
    for (const t of [...trees]) removeTree(t)
    git(root, ['worktree', 'prune'])
  }
  return { ok: findings.length === 0, findings, notes, heads: heads.map((h) => ({ sha: h.sha, names: h.names })), head: at.head }
}

export function parseArgs(argv) {
  const o = { fetch: true, json: false, stack: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--no-fetch') o.fetch = false
    else if (['--head', '--base', '--main', '--remote'].includes(a) && argv[i + 1] !== undefined) o[a.slice(2)] = argv[++i]
    else if (a === '--stack' && argv[i + 1] !== undefined) o.stack.push(argv[++i])
    else throw new Error(`Unknown argument ${a}. Usage: pnpm pre-pr [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--remote <name>] [--no-fetch] [--json]`)
  }
  return o
}

function main() {
  let o
  try {
    o = parseArgs(process.argv.slice(2))
    const r = prePr({ ...o, log: (m) => process.stderr.write(`pre-pr: ${m}\n`) })
    if (o.json) process.stdout.write(`${JSON.stringify(r)}\n`)
    else {
      for (const n of r.notes) console.log(n)
      for (const f of r.findings) console.log(`✗ [${f.check}] ${f.message}`)
      console.log(r.ok ? `pre-pr: nothing found (${r.heads.length} head(s) checked).` : `pre-pr: ${r.findings.length} finding(s).`)
    }
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    if (o?.json) process.stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`)
    else console.error(`pre-pr could not check: ${e.message}`)
    process.exitCode = 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
