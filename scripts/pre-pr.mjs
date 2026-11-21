// The mechanical checks before a pull request opens (#1181): `pnpm pre-pr`.
//
// open_pr runs main's copy of this folder (`scripts/`, written out on its own, #1931): import nothing from outside `scripts/`.
//
// About a quarter of what reviewers sent back could have been caught by a machine before the pull
// request opened, and most merge-queue trouble was a branch that no longer fit main. So, on the
// commits a pull request carries (never the working tree, which a pull request does not carry):
//
//   main      a warning, never a refusal: the head does not contain main (the merge queue merges it in),
//             how far behind it is, and which files a merge would conflict on.
//   tier      never a refusal: the pull request's risk tier by the paths it changes over its base, by
//             main's .centralu/tiers.json (scripts/tier.mjs, #1259); deep when there are no rules or
//             they cannot be read. The board writes it into Verified and labels the pull request tier:<name>.
//
// Then the checks, cheapest first; a run stops after the first one that finds something and names the ones it did not run.
// `--only <check>` runs one (again after a fix); the whole run once more before the pull request. Each step's time is printed.
//
//   lint      `pnpm lint` on the files the branch changed: CI's run (type-aware rules, allowlists, the packages' type-assertion
//             ceilings) over fewer files. A finding in an untouched file is left to CI.
//   tsc       `tsc --noEmit` at every pull request head of the stack, oldest first: each branch tip
//             between main and the head, and the head. A lower pull request must build on its own,
//             since it lands on its own.
//   orphans   dependency-cruiser's `no-orphans` rule as an error, as `pnpm verify` has it.
//   deps      every other dependency-cruiser rule at error severity, as `pnpm depcruise` fails on them (a cycle, a layer rule).
//   repo-guards  the repository-wide guards tooling/guards.ts declares (doc references, the OS allowlist), at the head: they fail
//             on a file the branch did not touch. The declaration is read by scripts/pre-pr-guards.mjs with the head's own tsx.
//   store-step  a store step number this branch adds (a new `to: N,` under the migrations folder) that main
//             already has, or that another open pull request adds (#1203): two parallel changes picking the
//             same number each pass CI alone and clash only when the second lands. `gh` lists the open pull
//             requests; the stack's own are left out. The Assistant assigns the numbers; this is the backstop.
//   revert    each new or changed vitest file is run at the head with every other change of the pull
//             request reverted to its base: a new test that passes there protects nothing
//             (CONTRIBUTING.md: a test must fail without its fix). Only tests new in this pull
//             request count; one that was already there passing is no news. Which tests the base's
//             version of a file had is read first by a vitest pass that selects none, so it names them all, the skipped and
//             todo ones too (a test the pull request un-skips was there); the run then ends at the first new test that passes.
//   guards    never a refusal: when the branch changes a guard of tooling/guards.ts (its test, or a file it declares it reads),
//             each changed guard is run against every other open, non-draft pull request, its head merged with this branch, and the
//             ones it would fail are listed with the first line of the failure, as warnings (they go into Verified): a
//             guard that lands breaks a queued pull request otherwise. The author fixes those in the same change, or tells
//             their authors. Bounded: a time limit (--guards-limit), only the guards the branch changed, and a
//             pull request that does not merge cleanly (or needs other dependencies) is skipped and said so. One that
//             merges is started only with as much time left as the guards took in the revert check's run, since a run cut
//             off half way says nothing; the ones left are named, with the time a run needs and the time left.
//
// Each check runs in a temporary worktree of its own commit, in one folder per run, so the person's
// checkout is never touched. `--exempt <check>=<reason>` leaves one check out and says why. The
// board's `open_pr` runs this and refuses with its findings (.centralu/apps/project-board, pre-pr.mjs).
//
//   node scripts/pre-pr.mjs [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--exempt <check>=<reason>]...
//                           [--only <check>]... [--remote <name>] [--no-fetch] [--json] [--run-id <id>] [--limit <seconds>]
//                           [--guards-limit <seconds>]
//   node scripts/pre-pr.mjs --cleanup <run-id>     removes what a run that was killed left behind, and the guard refs of
//                                                  any run whose folder is gone
//
// --head defaults to HEAD, --main to <remote>/main, --base (what the pull request merges into: a lower
// pull request's branch in a stack) to main. Unless --no-fetch, the remote is fetched first. The heads of
// the stack are the local and remote branches between main and the head, and each --stack ref (the
// board's open_pr fetches the stack under refs of its own and names them so).
// Exit 0 when nothing was found, 1 with findings, 2 when it could not check, 130 when interrupted: a tool it started was ended by an
// interrupt (scripts/interrupts.mjs), or one reached it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, posix, resolve } from 'node:path'
import { endedByInterrupt, interruptsSoFar, runTool } from './interrupts.mjs'
import { isMain } from './is-main.mjs'
import { relFile, testKey } from './pre-pr-stop-reporter.mjs'
import { ENV, GUARD_REFS, canonical, git, mirrorModules, removeGuardRefs, removeRun, removeWorktree, runDir, sweepGuardRefs, sweepStale, unlinkLinks } from './pre-pr-worktrees.mjs'
import { tierOfChange, unjudged } from './tier.mjs'

// --- What a path is ------------------------------------------------------------------------------

/**
 * A file the tests own: a test, a test helper, a fixture, a UI scenario or ux task. The revert check keeps it, but for an e2e/
 * file a changed vitest test imports ({@link revertedChanges}). The rest of e2e/ (its config, reporters, engine choice) is code
 * vitest tests, so the revert check reverts it.
 */
export function isTestFile(path) {
  return /(?:^|\/)(?:fixtures|__tests__)\//.test(path) || /\.(?:test|spec)(?:-helpers)?\.[cm]?[jt]sx?$/.test(path) || /^e2e\/(?:.*\/)?[^/]+\.task\.ts$/.test(path)
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

/** dependency-cruiser's JSON: the error-severity violations other than no-orphans, one sentence each. */
export function depErrorsOf(cruise) {
  const lines = (cruise?.summary?.violations ?? [])
    .filter((v) => v?.rule?.severity === 'error' && v.rule.name !== 'no-orphans')
    .map((v) => {
      const path = v.cycle?.length ? [v.from, ...v.cycle.map((c) => c.name ?? c)].join(' -> ') : `${v.from}${v.to ? ` -> ${v.to}` : ''}`
      return `${path} breaks ${v.rule.name} (tooling/dependency-cruiser.cjs)`
    })
  return [...new Set(lines)].sort()
}

/** A file `pnpm lint` reads: what ESLint's configuration covers, by extension. */
export const isLintable = (path) => /\.[cm]?[jt]sx?$/.test(path)

/** vitest's JSON reporter: every test as `{ file, name, status }`, the file relative to `root` with `/`. */
export function vitestTests(report, root) {
  return (report?.testResults ?? []).flatMap((f) =>
    (f.assertionResults ?? []).map((t) => ({
      file: relFile(root, f.name),
      name: [...(t.ancestorTitles ?? []), t.title].join(' > '),
      status: t.status,
    })),
  )
}

/** Why a vitest pass left no report: it was stopped at the limit it was given (`timedOut`, from how it ended), or it did not start or crashed. */
export const noReport = (timedOut, limitMs) =>
  timedOut ? `vitest was stopped after ${Math.round(limitMs / 1000)} s, the most it was given, before it had finished` : 'vitest gave no report (it did not start, or crashed)'

/**
 * How long the slowest of a report's `files` took on its own; 0 when it holds none of them. The guards run in one vitest pass,
 * files side by side, so that is the least one pass takes. The span from the first starting to the last ending would count
 * everything that ran between them in the shared pass.
 */
export function filesRunMs(report, root, files) {
  return Math.max(0, ...(report?.testResults ?? []).filter((f) => files.includes(relFile(root, f.name))).map((f) => f.endTime - f.startTime || 0))
}

/** The tests that pass with the source changes reverted and were not in the base's version of their file. */
export function passingNewTests({ reverted, base }) {
  const before = new Set(base.map((t) => testKey(t.file, t.name)))
  return reverted.filter((t) => t.status === 'passed' && !before.has(testKey(t.file, t.name)))
}

// --- Running things ------------------------------------------------------------------------------

const tail = (text, lines = 25) => String(text ?? '').trim().split('\n').slice(-lines).join('\n')

/**
 * Runs a Node entry point of the worktree's own node_modules; answers { ok, out, timedOut }. `timeout` is in ms, 0 for none.
 * With a limit it runs under run-limited.mjs, which ends the entry point and everything it started at the limit (a plain
 * kill leaves vitest's workers running, to eat the time of the phases after it).
 */
export function nodeBin(worktree, bin, args, env = {}, timeout = 0) {
  const dir = canonical(worktree)
  const entry = [join(dir, 'node_modules', bin), ...args]
  const [file, argv] = timeout ? [process.execPath, [fileURLToPath(new URL('./run-limited.mjs', import.meta.url)), String(timeout), process.execPath, ...entry]] : [process.execPath, entry]
  try {
    const out = runTool(file, argv, { cwd: dir, encoding: 'utf8', env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
    return { ok: true, out, timedOut: false }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || String(e.message), timedOut: timeout > 0 && e.status === 124 }
  }
}

/** The lockfile a checkout's last `pnpm install` installed: pnpm's copy of it */
const INSTALLED_LOCK = 'node_modules/.pnpm/lock.yaml'

const sameText = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a, 'utf8').replace(/\r\n/g, '\n') === readFileSync(b, 'utf8').replace(/\r\n/g, '\n')

/**
 * The pnpm to install with: the one running `pnpm pre-pr` (npm_execpath), else `pnpm` on PATH. A
 * machine can have more than one, and the first on PATH need not be the version the repository pins.
 */
function pnpm(args, dir) {
  const self = process.env.npm_execpath
  const opts = { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }
  try {
    if (self && /pnpm/i.test(self)) return /\.[cm]?js$/.test(self) ? runTool(process.execPath, [self, ...args], opts) : runTool(self, args, opts)
    // pnpm is a .cmd on Windows, which only a shell starts; the arguments are fixed words
    return runTool('pnpm', args, { ...opts, shell: process.platform === 'win32' })
  } catch (e) {
    throw new Error(`pnpm ${args.join(' ')} failed in ${dir}:\n${tail(`${e.stdout ?? ''}${e.stderr ?? ''}`)}`)
  }
}

/** The real tools. Each takes a worktree (`gh`: the checkout, to run in); tests replace them. */
export const realRunners = {
  /** The change's tier: tierOfChange of scripts/tier.mjs, which starts git itself (tierOf reads how it ended) */
  tier: tierOfChange,
  /** Runs `gh` in the checkout; answers its stdout. */
  gh(args, dir) {
    try {
      return runTool('gh', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
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
    if (!sameText(join(root, INSTALLED_LOCK), join(dir, 'pnpm-lock.yaml'))) {
      if (linkOnly) return false
      pnpm(['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], dir)
      return
    }
    mirrorModules(root, dir)
  },
  tsc(dir, { timeoutMs = 0 } = {}) {
    // The heap `pnpm typecheck` gives tsc (package.json): Node's default is a quarter of the machine's memory, under what
    // tsc needs on a 7 GB macOS runner (0.1.0-beta.43's rehearsal)
    return nodeBin(dir, 'typescript/bin/tsc', ['--noEmit', '-p', '.'], { NODE_OPTIONS: `${ENV.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim() }, timeoutMs)
  },
  depcruise(dir) {
    const r = nodeBin(dir, 'dependency-cruiser/bin/dependency-cruise.mjs', ['packages', 'apps', '--config', 'tooling/dependency-cruiser.cjs', '--output-type', 'json'])
    // It exits non-zero when a rule at error severity fails, with the JSON still on stdout
    const start = r.out.indexOf('{')
    return JSON.parse(r.out.slice(start))
  },
  /**
   * The repository-wide guards a worktree declares (tooling/guards.ts), read by scripts/pre-pr-guards.mjs with the worktree's
   * tsx: `{ guards: [{ test, tests }] | null, changed: [test] }`, `changed` the ones the commits `from`..`to` change. Throws
   * when it cannot be read.
   */
  guards(dir, from, to) {
    const r = nodeBin(dir, 'tsx/dist/cli.mjs', [fileURLToPath(new URL('./pre-pr-guards.mjs', import.meta.url)), from, to])
    if (!r.ok) throw new Error(`${GUARDS_FILE} could not be read: ${tail(r.out, 5)}`)
    return JSON.parse(r.out.trim().split('\n').at(-1))
  },
  /** `pnpm lint <files>` (tooling/lint.ts); with no files, the whole repository. */
  lint(dir, files, { timeoutMs = 0 } = {}) {
    return nodeBin(dir, 'tsx/dist/cli.mjs', ['tooling/lint.ts', ...files], {}, timeoutMs)
  },
  /**
   * Runs vitest of the worktree with a data folder of its own; answers `{ report, timedOut }`: vitest's JSON report, or null when
   * it wrote none, and whether it was stopped at `timeoutMs`. Failing tests exit non-zero, which is an answer here, not an error.
   * With `namesOnly` no test runs: a name filter nothing matches leaves every test of the files in the report as skipped, the
   * skipped and todo ones too, in seconds where a run takes minutes. `testNamePattern` runs only the tests whose name it matches.
   * With `known` (`[{ file, name }]`) the run ends at the first test that passes and is not one of them (pre-pr-stop-reporter.mjs);
   * the tests it did not reach are in the report as pending. `env` is added to the run's environment.
   */
  vitest(dir, files, { timeoutMs = 0, namesOnly = false, testNamePattern, known, env = {} } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), 'cc-prepr-vitest-'))
    const out = join(tmp, 'report.json')
    const data = mkdtempSync(join(tmpdir(), 'cc-prepr-data-'))
    try {
      const pattern = namesOnly ? '(?!)' : testNamePattern
      const args = ['run', '--reporter=json', `--outputFile=${out}`, ...(pattern ? ['-t', pattern] : [])]
      const runEnv = { ...env, CC_DATA_DIR: data }
      if (known) {
        runEnv.CC_PRE_PR_KNOWN = join(tmp, 'known.json')
        writeFileSync(runEnv.CC_PRE_PR_KNOWN, JSON.stringify(known.map((t) => testKey(t.file, t.name))))
        args.push(`--reporter=${fileURLToPath(new URL('./pre-pr-stop-reporter.mjs', import.meta.url))}`)
      }
      const { timedOut } = nodeBin(dir, 'vitest/vitest.mjs', [...args, ...files], runEnv, timeoutMs)
      return { report: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null, timedOut }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  },
}

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
  const ask = 'The Assistant assigns store step numbers (CONTRIBUTING.md): ask for a free one and renumber, or exempt this check with the reason it stands.'
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

/** What `gh pr list` is asked of each open pull request: `files` holds at most 100, so `changedFiles` says whether it holds them all. */
const PR_FIELDS = 'number,title,headRefName,headRefOid,isDraft,changedFiles,files'

/** The files an open pull request changes: the list's, when it holds them all, else `gh pr diff --name-only`. */
function prFiles(gh, root, pr) {
  if (Array.isArray(pr.files) && pr.files.length === pr.changedFiles) return pr.files.map((f) => f.path)
  return String(gh(['pr', 'diff', String(pr.number), '--name-only'], root)).split('\n').map((f) => f.trim()).filter(Boolean)
}

/**
 * The open pull requests that add store steps, leaving out the stack's own (a head that is one of its
 * `commits`, or one of its branches' `names`). Only a pull request that touches {@link STEP_DIR} costs a full diff.
 */
function otherPrsAddingSteps({ gh, root, listed, commits, names }) {
  const others = []
  for (const pr of otherPrs(listed, commits, names)) {
    if (!prFiles(gh, root, pr).some((f) => f.startsWith(STEP_DIR))) continue
    const steps = stepsAddedByDiff(gh(['pr', 'diff', String(pr.number)], root))
    if (steps.length) others.push({ number: pr.number, title: pr.title, head: pr.headRefName, steps })
  }
  return others
}

// --- Guards against the open pull requests (the day-1 cost: a guard landed, a queued pull request broke) --------

/** The files that differ from `from` to `to` (commits), each `{ status, path }` with git's one-letter status; renames as a deletion and an addition. */
export function nameStatus(root, from, to) {
  const parts = git(root, ['diff', '--name-status', '--no-renames', '-z', from, to]).split('\0').filter(Boolean)
  const out = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] })
  return out
}

// vitest colours its messages: the escape character is what is stripped
// eslint-disable-next-line no-control-regex
const stripAnsi = (t) => String(t ?? '').replace(/\u001b\[[0-9;]*m/g, '')

/** How many lines of a failure's message a finding keeps: a guard's message names what it found, the stack does not. */
const DETAIL_LINES = 20

/**
 * The failures of a vitest JSON report as `{ file, name, line, detail }`: `line` the first line of the message, `detail` its
 * lines up to the stack, at most DETAIL_LINES. The JSON report carries no diff of what was expected and received: a failure says
 * what its assertion's message says (a guard names there what it found) and vitest's one line of what it expected.
 */
export function failuresOf(report, root) {
  const of = (m) => {
    const lines = stripAnsi(m).split('\n').map((l) => l.trimEnd())
    const end = lines.findIndex((l) => /^\s+at /.test(l))
    const detail = (end < 0 ? lines : lines.slice(0, end)).filter((l) => l.trim()).slice(0, DETAIL_LINES)
    return { line: detail[0]?.trim() ?? 'failed', detail }
  }
  return (report?.testResults ?? []).flatMap((f) => {
    const file = relFile(root, f.name)
    const tests = (f.assertionResults ?? []).filter((t) => t.status === 'failed')
    if (tests.length) return tests.map((t) => ({ file, name: [...(t.ancestorTitles ?? []), t.title].join(' > '), ...of(t.failureMessages?.[0]) }))
    // A file that did not load (or timed out) has no test of its own to fail
    return f.status === 'failed' ? [{ file, name: '', ...of(f.message) }] : []
  })
}

/** The most one pull request's guards may take, and the default for the whole check. */
export const GUARDS_PER_PR_MS = 5 * 60_000
export const GUARDS_LIMIT_MS = 10 * 60_000
/** The whole run's time: every phase draws from what is left of it. The board stops the script a little after (pre-pr.mjs there). */
export const TOTAL_LIMIT_MS = 25 * 60_000
/** The least time a phase needs to be worth starting; with less it is reported as not run, not cut off half way. */
export const PHASE_MIN_MS = 60_000

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
        // Only the tests that are the guards, when each says which: one pattern for the run, so each file's are kept below
        const testNamePattern = present.every((g) => g.tests) ? present.map((g) => g.tests).join('|') : undefined
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

/** Whether the test named `name` (as {@link vitestTests} names it) is one of the guard `g`'s: its pattern read as vitest's `-t` reads it */
const isGuardTest = (g, name) => !g.tests || new RegExp(g.tests).test(name.replaceAll(' > ', ' '))

/** A failure of {@link failuresOf} as a line names it: its file, and its test when it has one. */
const failureLabel = (f) => `${f.file}${f.name ? ` > ${f.name}` : ''}`

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

// --- The checks ----------------------------------------------------------------------------------

/** Where the repository-wide guards are declared, with the files each reads; read through scripts/pre-pr-guards.mjs */
const GUARDS_FILE = 'tooling/guards.ts'

/** `pnpm lint` on the files the branch changed. */
function lintStep(c) {
  const files = c.changed.filter((x) => x.status !== 'D' && isLintable(x.path)).map((x) => x.path)
  if (!files.length || c.outOfTime('lint', 'pnpm lint')) return
  // A command line has a limit (Windows': 32k): a change this wide is linted whole
  const some = files.join(' ').length > 20000 ? [] : files
  c.log(`pnpm lint on ${some.length || 'all'} file(s)`)
  const r = c.runners.lint(c.top(), some, { timeoutMs: c.left() })
  if (r.timedOut) c.notRun('lint', 'pnpm lint', 'out of time (stopped at the limit)')
  else if (!r.ok) c.findings.push({ check: 'lint', message: `pnpm lint fails on the changed files:\n${tail(r.out, 40)}` })
}

/** `tsc --noEmit` at every head of the stack, oldest first. */
function tscStep(c) {
  for (const h of c.heads) {
    c.check()
    const label = `${h.names.join(', ')} (${h.sha.slice(0, 10)})`
    const wt = h.sha === c.at.head ? c.top() : c.worktree(h.sha)
    if (c.outOfTime('tsc', `tsc at ${label}`)) continue
    c.log(`tsc at ${label}`)
    const r = c.runners.tsc(wt, { timeoutMs: c.left() })
    if (r.timedOut) c.notRun('tsc', `tsc at ${label}`, 'out of time (stopped at the limit)')
    else if (!r.ok) c.findings.push({ check: 'tsc', message: `tsc fails at ${label}; each pull request of a stack lands on its own and must build:\n${tail(r.out)}` })
  }
}

/** dependency-cruiser: its orphans, and its other errors. */
function depsStep(c) {
  c.log('dependency-cruiser')
  const cruise = c.runners.depcruise(c.top())
  if (c.want('orphans')) {
    for (const file of orphansOf(cruise)) {
      c.findings.push({ check: 'orphans', message: `${file} is imported by nothing (no-orphans): delete it, import it, or list it in tooling/dependency-cruiser.cjs with why.` })
    }
  }
  if (c.want('deps')) for (const message of depErrorsOf(cruise)) c.findings.push({ check: 'deps', message })
}

/** The guards {@link GUARDS_FILE} declares, at the head, against main as CI compares them. */
function repoGuardsStep(c) {
  const declared = c.declared()
  if (declared.error) {
    c.notRun('repo-guards', GUARDS_FILE, declared.error)
    return
  }
  if (!declared.guards) {
    // A branch older than the declaration has none to run; one that removed it would pass in silence
    if (existsAt(c.root, c.forkMain, GUARDS_FILE)) c.findings.push({ check: 'repo-guards', message: `${GUARDS_FILE} is not at this head, though it was where the branch left main: keep it, with the guards it declares.` })
    else c.notes.push(`No ${GUARDS_FILE} at this head: no repository-wide guard was run.`)
    return
  }
  for (const g of declared.guards) {
    c.check()
    if (!existsSync(join(c.top(), g.test))) {
      c.findings.push({ check: 'repo-guards', message: `${g.test} is not at this head, though ${GUARDS_FILE} declares it: keep it, or change the declaration with it.` })
      continue
    }
    if (c.outOfTime('repo-guards', g.test)) continue
    c.log(`${g.test}${g.tests ? ` (${g.tests})` : ''}`)
    const limitMs = Math.max(1000, c.left())
    const { report, timedOut } = c.runners.vitest(c.top(), [g.test], { timeoutMs: limitMs, testNamePattern: g.tests, env: { CC_LINT_BASE: c.at.main } })
    if (!report) {
      c.notRun('repo-guards', g.test, noReport(timedOut, limitMs))
      continue
    }
    const fails = failuresOf(report, c.top())
    for (const f of fails) c.findings.push({ check: 'repo-guards', message: `${failureLabel(f)} fails: ${f.detail.length > 1 ? `\n${f.detail.join('\n')}` : f.line}` })
    // A pattern that matches no test any more would pass in silence. By name: a test vitest filtered out and one skipped on this
    // system both read as skipped
    if (!vitestTests(report, c.top()).some((t) => isGuardTest(g, t.name))) {
      c.findings.push({ check: 'repo-guards', message: `${g.test}${g.tests ? ` has no test named like "${g.tests}"` : ' ran no test'}: ${GUARDS_FILE} declares a guard that is not there.` })
    }
  }
}

/** Whether `path` is a file at `commit`. */
function existsAt(root, commit, path) {
  try {
    git(root, ['cat-file', '-e', `${commit}:${path}`])
    return true
  } catch {
    return false
  }
}

/** A store step number this branch (the whole stack) adds over where it forked from main, that main or another open pull request has. */
function storeStepStep(c) {
  const added = stepsAddedByDiff(git(c.root, ['diff', '--no-renames', '-U0', c.forkMain, c.at.head, '--', STEP_DIR]))
  if (!added.length) return
  c.log(`Store step(s) ${added.join(', ')}: looking at main and the open pull requests`)
  let others
  try {
    others = otherPrsAddingSteps({ gh: c.runners.gh, root: c.root, listed: c.openPrs(), commits: c.commits, names: c.names })
  } catch (e) {
    throw new Error(`Store step(s) ${added.join(', ')} are new here, and the open pull requests could not be read (${e.message}). Run it where gh is logged in, or exempt store-step with the reason.`)
  }
  c.findings.push(...stepFindings({ added, onMain: stepsAt(c.root, c.at.main), others }))
}

/** The paths from the repository root a module's relative imports may name: `./x.js` is x.js, or x.ts, … */
function importedPaths(from, text) {
  return [...String(text).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].flatMap((m) => {
    const path = posix.join(posix.dirname(from), m[1])
    const stem = path.replace(/\.[cm]?[jt]sx?$/, '')
    return [path, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'].map((x) => stem + x)]
  })
}

/** The text of the file at `path` in `dir`, or null where there is none: an import's path as guessed (importedPaths) may name none, or a folder. */
function textIn(dir, path) {
  try {
    return readFileSync(join(dir, path), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null
    throw e
  }
}

/**
 * The changes (`{ status, path }`) the revert check puts back to the base: all but the tests' own files (isTestFile). A file under
 * e2e/ that a changed vitest file reaches through e2e/ imports, at any depth, goes back too, whatever it is: vitest runs nothing
 * under e2e/, so there it is what a test checks, not a test of its own. `read(path)` answers a file's text at the head, or null
 * where there is none.
 */
export function revertedChanges(changed, read) {
  const reached = new Set()
  const follow = (from) => {
    for (const path of importedPaths(from, read(from) ?? '')) {
      if (!path.startsWith('e2e/') || reached.has(path)) continue
      reached.add(path)
      follow(path)
    }
  }
  for (const x of changed) if (x.status !== 'D' && isVitestFile(x.path)) follow(x.path)
  return changed.filter((x) => !isTestFile(x.path) || (x.path.startsWith('e2e/') && reached.has(x.path)))
}

/**
 * The changed tests, at the head, with everything else the pull request changed put back to where it left its base. The base's
 * version of each changed file is asked first which tests it had, by a pass that runs none (it names the skipped and todo ones
 * too, so a test the pull request un-skips was there); then the run ends at the first test that passes and is not one of them.
 */
function revertStep(c) {
  const tests = c.changed.filter((x) => x.status !== 'D' && isVitestFile(x.path))
  if (!tests.length) {
    c.notes.push(`No new or changed vitest file against ${c.base}.`)
    return
  }
  if (c.outOfTime('revert', 'The changed tests')) return
  const top = c.top()
  // The guards check reads the head's declaration, which this step puts back to the base
  if (c.want('guards')) c.declared()
  const sources = revertedChanges(c.changed, (path) => textIn(top, path))
  c.log(`Running ${tests.length} test file(s) with ${sources.length} other change(s) reverted to ${c.base}`)
  for (const s of sources) {
    if (s.status === 'A') rmSync(join(top, s.path), { force: true })
    else git(top, ['checkout', c.fork, '--', s.path])
  }
  // The dependencies changed: the base's, installed (the links go first, so nothing installs through them)
  if (sources.some((s) => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/.test(s.path))) {
    unlinkLinks(top)
    c.runners.prepare(top, c.root)
  }
  // Answers the tests and the pass (see realRunners.vitest) and the limit it was given; the tests are null when vitest gave no report
  const run = (files, options = {}) => {
    c.check()
    // At least a second: an install before this may have used the time up, and a limit of 0 or less means none to the runner
    const limitMs = Math.max(1000, c.left())
    const pass = c.runners.vitest(top, files, { timeoutMs: limitMs, ...options })
    return { ...pass, limitMs, tests: pass.report ? vitestTests(pass.report, top) : null }
  }
  // A file that is new (added) has no base version to ask
  const existed = tests.filter((t) => t.status !== 'A').map((t) => t.path)
  let before = []
  let judged = tests.map((t) => t.path)
  if (existed.length) {
    for (const p of existed) git(top, ['checkout', c.fork, '--', p])
    const named = run(existed, { namesOnly: true })
    for (const p of existed) git(top, ['checkout', c.at.head, '--', p])
    if (!named.tests) {
      c.notRun('revert', `The base's version of ${existed.join(', ')}`, `${noReport(named.timedOut, named.limitMs)}, so no test was judged`)
      return
    }
    before = named.tests
    // A base file that does not load names none of its tests, so every test of it would count as new: it is left out
    for (const f of failuresOf(named.report, top).filter((x) => !x.name)) {
      judged = judged.filter((p) => p !== f.file)
      c.warnings.push({ check: 'revert', message: `${f.file}: its version at ${c.base} does not load with this pull request's other changes reverted (${f.line}), so which of its tests are new is not known: they were not judged.` })
    }
    if (!judged.length || c.outOfTime('revert', 'The changed tests')) return
  }
  const pass = run(judged, { known: before })
  c.revertReport = pass.report
  if (!pass.tests) {
    c.notRun('revert', `The changed tests (${judged.join(', ')})`, noReport(pass.timedOut, pass.limitMs))
    return
  }
  const loose = passingNewTests({ reverted: pass.tests, base: before })
  // The stop reporter ends the run only at a new passing test: tests left pending with none such means it and this file named
  // the tests differently, and the ones not run were not judged
  if (!loose.length && pass.tests.some((t) => t.status === 'pending')) {
    c.notRun('revert', `The changed tests (${judged.join(', ')})`, 'the run was ended early, yet no new test passed in it, so the tests it did not run were not judged')
    return
  }
  for (const t of loose) {
    c.findings.push({ check: 'revert', message: `${t.file}: "${t.name}" passes with this pull request's other changes reverted to ${c.base}, so it protects nothing. Make it fail without the change, or exempt the revert check with the reason it cannot.` })
  }
  // Failures, not "not passed": a skipped or todo test is neither, and a file that did not load fails with no test of its own
  if (!loose.length) c.notes.push(`${failuresOf(pass.report, top).length} test(s) of ${judged.length} changed file(s) fail without the change; no new test passes without it.`)
}

/**
 * Only a warning: the guards of {@link GUARDS_FILE} this branch (the whole stack) changes, against every open pull request,
 * merged in. A guard breaks another pull request through what that one adds, in files the guard's branch need not touch, so none
 * is passed over; a branch that changes no guard skips the step.
 */
function guardsStep(c) {
  const declared = c.declared()
  if (declared.error) {
    c.warnings.push({ check: 'guards', message: `No guard was run against the open pull requests: ${declared.error}` })
    return
  }
  const changed = (declared.guards ?? []).filter((g) => declared.changed.includes(g.test) && existsAt(c.root, c.at.head, g.test))
  const guards = changed.map((g) => g.test)
  if (!guards.length) {
    c.notes.push(`No guard of ${GUARDS_FILE} (its test, or a file it reads) is changed: not run against the open pull requests.`)
    return
  }
  if (c.outOfTime('guards', guards.join(', '))) return
  let prs
  try {
    prs = otherPrs(c.openPrs(), c.commits, c.names).filter((p) => !p.isDraft)
  } catch (e) {
    c.warnings.push({ check: 'guards', message: `${guards.join(', ')} could not be run against the open pull requests: they could not be read (${e.message}).` })
    return
  }
  const guardsMs = Math.min(c.guardsLimitMs, c.left())
  // How long the guards took in the revert check's run: the least one run of them needs
  const guardMs = c.revertReport ? filesRunMs(c.revertReport, c.top(), guards) : 0
  c.log(`Guard(s) ${guards.join(', ')}: against ${prs.length} open pull request(s), at most ${Math.round(guardsMs / 1000)} s`)
  const res = runGuards({ root: c.root, remote: c.remote, runId: c.runId, runners: c.runners, prs, head: c.at.head, guards: changed, makeWorktree: (commit) => c.worktree(commit, { linkOnly: true }), dropWorktree: (wt) => removeWorktree(wt, c.root), limitMs: guardsMs, now: c.now, log: c.log, check: c.check, needMs: guardMs, perPrMs: Math.max(GUARDS_PER_PR_MS, Math.ceil(guardMs * 1.5)) })
  c.warnings.push(...guardWarnings(res, guards))
  c.notes.push(`${guards.join(', ')} run against ${prs.length} open pull request(s): ${res.failing.length} would fail, ${res.skipped.length} skipped, ${res.unchecked.length} not reached.`)
}

/**
 * The steps of a run, in this order: the cheap ones first, so the common failure is known in seconds, and a run stops after the
 * first step that finds something. `checks` are the names an exemption and `--only` take; one dependency-cruiser run answers two.
 * The revert step puts the head's worktree back to the base: every step that reads the head comes before it, and it reads the
 * guards' declaration first for the guards step (c.declared).
 */
const STEPS = [
  { name: 'lint', checks: ['lint'], run: lintStep },
  { name: 'tsc', checks: ['tsc'], run: tscStep },
  { name: 'dependency-cruiser', checks: ['orphans', 'deps'], run: depsStep },
  { name: 'repo-guards', checks: ['repo-guards'], run: repoGuardsStep },
  { name: 'store-step', checks: ['store-step'], run: storeStepStep },
  { name: 'revert', checks: ['revert'], run: revertStep },
  { name: 'guards', checks: ['guards'], run: guardsStep },
]

/** Runs the steps of the checks `c` wants, each timed, until one finds something; then names the checks it did not run. */
function runSteps(c) {
  const steps = STEPS.filter((s) => s.checks.some(c.want))
  for (const [i, s] of steps.entries()) {
    c.check()
    const found = c.findings.length
    const started = c.now()
    s.run(c)
    // A tool an interrupt stopped fails like a finding: the interrupt is what is said, not that
    c.check()
    c.log(`${s.name}: ${Math.round((c.now() - started) / 1000)} s`)
    if (c.findings.length === found) continue
    const rest = steps.slice(i + 1).flatMap((x) => x.checks.filter(c.want))
    if (rest.length) c.notes.push(`Not run, since ${s.name} found something: ${rest.join(', ')}. Fix it, then run the one that failed with pnpm pre-pr --only <check>, and the whole run once more before the pull request.`)
    return
  }
}

/**
 * What each check held when a run found nothing, as a pull request's Verified names it; `heads` is how many heads tsc built, and
 * `warnings` the run's: the revert check's are the test files it left out, which its line must not claim.
 */
const PASSED = {
  lint: () => 'lint on the changed files',
  tsc: (heads) => `tsc at ${heads} head(s)`,
  orphans: () => 'no orphans',
  deps: () => 'no dependency errors',
  'repo-guards': () => 'the repository-wide guards',
  revert: (_heads, warnings) => {
    const leftOut = warnings.filter((w) => w.check === 'revert').length
    return `no new test passes without the change${leftOut ? `, in the test files judged (${leftOut} left out: see the warnings)` : ''}`
  },
}

/** The checks a pull request can be exempted from, each with a reason, and `--only` runs. `main` is only ever a warning. */
const CHECKS = STEPS.flatMap((s) => s.checks)

/**
 * The pull request's tier: never a refusal. The review it needs, from the paths it changes over its base, by main's rules;
 * when they cannot be read it is deep, with a warning, so a broken rules file never lets a change through unreviewed.
 */
function tierOf(root, at, warnings, runners) {
  try {
    const t = runners.tier({ root, base: at.base, head: at.head, rulesRef: at.main })
    return { name: t.tier, line: t.line, because: t.because.map((f) => f.path) }
  } catch (e) {
    // tier.mjs starts git on its own (the board runs it as one file): its tool's end is read here
    if (endedByInterrupt(e)) throw new Error('interrupted')
    const t = unjudged(`the tier could not be read: ${String(e.message).trim()}`)
    warnings.push({ check: 'tier', message: `The tier could not be read, so it is deep: ${e.message}` })
    return { name: t.tier, line: t.line, because: [] }
  }
}

/**
 * The warning, never a finding, for a head that does not contain main, or null: the merge queue merges main in anyway; what
 * matters is that a merge would not conflict.
 */
function mainWarning(root, at, head, main) {
  try {
    git(root, ['merge-base', '--is-ancestor', at.main, at.head])
    return null
  } catch {
    // not an ancestor: said below
  }
  const behind = git(root, ['rev-list', '--count', `${at.head}..${at.main}`]).trim()
  let conflicts = []
  try {
    git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', at.main, at.head])
  } catch (e) {
    // Exit 1: the tree's id, then one conflicted file a line
    conflicts = String(e.stdout ?? '').trim().split('\n').slice(1).filter(Boolean)
  }
  const merge = conflicts.length ? ` A merge conflicts in: ${conflicts.join(', ')}: rebase or merge before it lands.` : ''
  return { check: 'main', message: `${head} does not contain ${main}: ${behind} commit(s) behind. The merge queue merges it in; checked without it.${merge}` }
}

/**
 * Runs the checks; answers { ok, findings, warnings, exempted, notes, heads, head, tier }. A finding fails the run; a warning does
 * not. `exempt` maps a check of {@link CHECKS} to the reason it is not run; `only`, when not empty, names the checks to run.
 * `runners` replaces the tools (tests); `log` hears progress, and each step's time. A tool an interrupt ended (scripts/interrupts.mjs)
 * stops the run at the next check, with the error `interrupted`.
 */
export function prePr({ cwd = process.cwd(), head = 'HEAD', base, main, stack = [], remote = 'origin', fetch = true, exempt = {}, only = [], runId = `${process.pid}-${Date.now()}`, runners = realRunners, log = () => {}, guardsLimitMs = GUARDS_LIMIT_MS, limitMs = TOTAL_LIMIT_MS, now = Date.now } = {}) {
  const interruptsAtStart = interruptsSoFar()
  const root = resolve(git(cwd, ['rev-parse', '--show-toplevel']).trim())
  for (const check of [...only, ...Object.keys(exempt)]) if (!CHECKS.includes(check)) throw new Error(`No check is called ${check}; the checks are ${CHECKS.join(', ')}.`)
  for (const [check, why] of Object.entries(exempt)) {
    if (!String(why ?? '').trim()) throw new Error(`An exemption from ${check} needs its reason.`)
    if (only.includes(check)) throw new Error(`${check} is both run alone (--only) and exempted: one or the other.`)
  }
  const want = (check) => !Object.hasOwn(exempt, check) && (!only.length || only.includes(check))
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
  const deadline = now() + limitMs
  const left = () => deadline - now()
  /**
   * Says a check did not run (it must never read as passed). Every check but the guards is a finding then, so open_pr refuses
   * unless it is exempted with a reason, as for a failure; the guards are only ever a warning.
   */
  const notRun = (check, what, why) =>
    (check === 'guards' ? warnings : findings).push({ check, message: `${what}: not run: ${why}.${check === 'guards' ? '' : ` Run it again, or exempt ${check} with the reason it cannot run.`}` })
  /** True (and says so) when `what` cannot start with the time that is left. */
  const outOfTime = (check, what) => {
    if (left() >= PHASE_MIN_MS) return false
    notRun(check, what, `out of time (${Math.max(0, Math.round(left() / 1000))} s of the ${Math.round(limitMs / 1000)} s left)`)
    return true
  }
  let tier = null
  // `passed`: what the checks that ran held, when they found nothing; none when nothing was checked
  const answer = (heads, checked = true) => ({
    ok: findings.length === 0,
    findings,
    warnings,
    exempted,
    notes,
    passed: checked && !findings.length ? CHECKS.filter((k) => want(k) && Object.hasOwn(PASSED, k)).map((k) => PASSED[k](heads.length, warnings)) : [],
    heads: heads.map((h) => ({ sha: h.sha, names: h.names })),
    head: at.head,
    tier,
  })

  tier = tierOf(root, at, warnings, runners)
  const behind = mainWarning(root, at, head, main)
  if (behind) warnings.push(behind)

  const commits = git(root, ['rev-list', '--reverse', `${at.main}..${at.head}`]).split('\n').filter(Boolean)
  if (!commits.length) {
    notes.push(`${head} has no commits over ${main}: nothing to check.`)
    return answer([], false)
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
  let topWt = null
  // The head's worktree, made by the first step that reads it
  const top = () => (topWt ??= worktree(at.head))
  let declared = null
  // Against where the head left the base, not the base's tip: what the base gained since is not this pull request's
  const fork = git(root, ['merge-base', at.base, at.head]).trim()
  const forkMain = git(root, ['merge-base', at.main, at.head]).trim()
  let listed
  const c = {
    root, remote, base, at, runId, runners, log, now, guardsLimitMs, findings, warnings, notes, want, left, notRun, outOfTime, commits, worktree, fork,
    heads,
    top,
    forkMain,
    // The guards the head declares, and the ones the branch (the whole stack) changes; `{ error }` when they could not be read
    declared: () => {
      if (!declared) {
        const wt = top()
        try {
          declared = runners.guards(wt, forkMain, at.head)
        } catch (e) {
          declared = { error: String(e.message) }
        }
      }
      return declared
    },
    // What the pull request changes over its base
    changed: nameStatus(root, fork, at.head),
    // The open pull requests, read once for the checks that look at them
    openPrs: () => (listed ??= JSON.parse(runners.gh(['pr', 'list', '--state', 'open', '--limit', '500', '--json', PR_FIELDS], root))),
    names: new Set(heads.flatMap((h) => h.names).flatMap((n) => [n, n.replace(`${remote}/`, ''), n.replace(/^refs\/centralu-pre-pr\/[^/]+\//, '')])),
    check: () => {
      if (interruptsSoFar() > interruptsAtStart) throw new Error('interrupted')
    },
    revertReport: null,
  }
  try {
    runSteps(c)
  } finally {
    for (const l of removeRun(dir, root)) notes.push(`Left ${l}.`)
  }
  return answer(heads)
}

export function parseArgs(argv) {
  const o = { fetch: true, json: false, stack: [], exempt: {}, only: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = argv[i + 1]
    if (a === '--json') o.json = true
    else if (a === '--no-fetch') o.fetch = false
    else if (['--head', '--base', '--main', '--remote'].includes(a) && value !== undefined) o[a.slice(2)] = argv[++i]
    else if (a === '--run-id' && value !== undefined) o.runId = argv[++i]
    else if (a === '--cleanup' && value !== undefined) o.cleanup = argv[++i]
    else if (a === '--limit' && /^\d+$/.test(value ?? '')) o.limitMs = Number(argv[++i]) * 1000
    else if (a === '--guards-limit' && /^\d+$/.test(value ?? '')) o.guardsLimitMs = Number(argv[++i]) * 1000
    else if (a === '--stack' && value !== undefined) o.stack.push(argv[++i])
    else if (a === '--only' && value !== undefined) o.only.push(argv[++i])
    else if (a === '--exempt' && value !== undefined && value.includes('=')) {
      const [check, ...why] = argv[++i].split('=')
      o.exempt[check] = why.join('=')
    } else throw new Error(`Unknown argument ${a}. Usage: pnpm pre-pr [--head <ref>] [--base <ref>] [--main <ref>] [--stack <ref>]... [--exempt <check>=<reason>]... [--only <check>]... [--remote <name>] [--no-fetch] [--json] [--run-id <id>] [--limit <seconds>] [--guards-limit <seconds>] | --cleanup <run-id>`)
  }
  if (o.runId !== undefined && !/^[\w.-]+$/.test(o.runId)) throw new Error('--run-id takes letters, digits, ".", "_" and "-" only.')
  if (o.cleanup !== undefined && !/^[\w.-]+$/.test(o.cleanup)) throw new Error('--cleanup takes a run id: letters, digits, ".", "_" and "-" only.')
  return o
}

function main() {
  let o
  // Ctrl-C reaches the tool running now, which ends: the run knows the interrupt by that (prePr), removes its folder and exits.
  // Handled, the signal does not end this process first; the handler runs only once the synchronous run is over, which an
  // interrupt between two tools reaches as well
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => (process.exitCode = 130))
  try {
    o = parseArgs(process.argv.slice(2))
    if (o.cleanup !== undefined) {
      const root = resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim())
      const left = removeRun(runDir(o.cleanup), root)
      // Also what runs killed earlier left without a folder to find it by
      sweepGuardRefs(root)
      for (const l of left) console.error(`Left ${l}.`)
      process.exitCode = left.length ? 2 : 0
      return
    }
    const r = prePr({ ...o, log: (m) => process.stderr.write(`pre-pr: ${m}\n`) })
    if (o.json) process.stdout.write(`${JSON.stringify(r)}\n`)
    else {
      if (r.tier) console.log(r.tier.line)
      for (const n of r.notes) console.log(n)
      for (const x of r.exempted) console.log(`- [${x.check}] not run: ${x.reason}`)
      for (const w of r.warnings) console.log(`! [${w.check}] ${w.message}`)
      for (const f of r.findings) console.log(`✗ [${f.check}] ${f.message}`)
      console.log(r.ok ? `pre-pr: nothing found (${o.only.length ? `only ${o.only.join(', ')}` : `${r.heads.length} head(s) checked`}).` : `pre-pr: ${r.findings.length} finding(s).`)
    }
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    const interrupted = e.message === 'interrupted' || interruptsSoFar() > 0
    const message = interrupted ? 'interrupted' : e.message
    if (o?.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    else console.error(`pre-pr could not check: ${message}`)
    process.exitCode = interrupted ? 130 : 2
  }
}

if (isMain(import.meta.url)) main()
