/**
 * The findings of the type-aware lint (#1339) that predate it, one list per package in tooling/lint-allowlist/.
 *
 * Each line says how many findings of one rule a file may hold: `<file> <rule> <count>`, sorted. A file that holds
 * more fails `pnpm lint` with all of them shown, as does any finding in a file or rule no line names. A file that
 * holds fewer, or a line whose file is gone, passes (`lintFailed` says why); `pnpm lint:tighten` and a weekly job
 * lower such lines. A list per package keeps two changes from editing the same file unless they work on the same
 * package.
 *
 * A count moves only with a file git sees renamed (`tighten`, `alongRenames`); code moved into another file is a new
 * finding there. tooling/type-aware-lint.test.ts compares the lists with main's (`mainLists`, `compareWithBase`):
 * no line may be new or higher but a renamed file's own, so no change can list a new finding, by hand or by command,
 * and a stale line cannot lend its count to anything.
 *
 * This module is the logic; tooling/lint.ts runs ESLint with it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'

export const ALLOWLIST_DIR = 'tooling/lint-allowlist'

/**
 * How ESLint runs. Two threads, not one per core: every thread builds the whole TypeScript program, and on a
 * 12-thread PC six of them took 13.6 GB for 34.6 s where two took 5.8 GB for 36.9 s (#1343 review), with several
 * agents' `pnpm verify` running at once. No cache: ESLint's keys a file on its own content, and a type-aware
 * finding can come from a type another file changed.
 */
export const LINT_OPTIONS = { concurrency: 2 } as const satisfies ESLint.Options

/** The options tooling/lint.ts creates ESLint with */
export const eslintOptions = (cwd: string): ESLint.Options => ({ cwd, ...LINT_OPTIONS })

/**
 * The rules a line may name: the type-aware ones eslint.config.js turned on (#1339). Any other rule's
 * findings were already errors before, and stay errors everywhere.
 */
export const LISTABLE_RULES: ReadonlySet<string> = new Set([
  ...tseslint.configs.recommendedTypeCheckedOnly.flatMap((c) => Object.keys(c.rules ?? {})).filter((r) => r.startsWith('@typescript-eslint/')),
  '@typescript-eslint/consistent-type-assertions',
  '@typescript-eslint/no-non-null-assertion',
  '@typescript-eslint/no-unsafe-type-assertion',
])

const HEADER = [
  '# Type-aware lint findings that predate the rules (#1339): <file> <rule> <count>, one per line, sorted.',
  '# Lowered by `pnpm lint:tighten`, which also moves a file\'s lines along a rename git sees; no line may be new or higher than main\'s.',
]

/** file → rule → how many findings it may hold */
export type Allowlist = Map<string, Map<string, number>>

/** packages/<name> and apps/<name> by name, anything else by its top folder (tooling, e2e) */
export function packageOf(file: string): string {
  const [top = '', name = ''] = file.split('/')
  return top === 'packages' || top === 'apps' ? `${top}/${name}` : top
}

/** The list a package's lines are in: packages/agent-host → packages-agent-host.txt */
export const listFileOf = (pkg: string) => `${pkg.replace('/', '-')}.txt`

export function parseList(text: string, name: string): Allowlist {
  const out: Allowlist = new Map()
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const m = /^(\S+) (\S+) ([1-9]\d*)$/.exec(line)
    if (!m) throw new Error(`${name}:${i + 1}: expected "<file> <rule> <count>", got "${line}"`)
    const [, file = '', rule = '', count = ''] = m
    if (!LISTABLE_RULES.has(rule)) throw new Error(`${name}:${i + 1}: ${rule} is not a type-aware rule; its findings cannot be listed`)
    const rules = out.get(file) ?? new Map<string, number>()
    if (rules.has(rule)) throw new Error(`${name}:${i + 1}: ${file} ${rule} is listed twice`)
    out.set(file, rules.set(rule, Number(count)))
  })
  return out
}

/** One package's list as written: the header, then a sorted line per file and rule */
export function formatList(allow: Allowlist): string {
  const lines: string[] = []
  const byName = <T>([a]: [string, T], [b]: [string, T]) => (a < b ? -1 : a > b ? 1 : 0)
  for (const [file, rules] of [...allow].sort(byName)) {
    if (/\s/.test(file)) throw new Error(`cannot list "${file}": a list line holds no spaces`)
    for (const [rule, count] of [...rules].sort(byName)) lines.push(`${file} ${rule} ${count}`)
  }
  return [...HEADER, ...lines].join('\n') + '\n'
}

/** The lists from their files' texts, by file name; throws for a line in another package's list */
export function parseLists(texts: ReadonlyMap<string, string>): Allowlist {
  const out: Allowlist = new Map()
  for (const [name, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const [file, rules] of parseList(text, name)) {
      if (listFileOf(packageOf(file)) !== name) throw new Error(`${name}: ${file} belongs in ${listFileOf(packageOf(file))}`)
      out.set(file, rules)
    }
  }
  return out
}

export function readAllowlist(root: string): Allowlist {
  const dir = join(root, ALLOWLIST_DIR)
  if (!existsSync(dir)) return new Map()
  const names = readdirSync(dir).filter((n) => n.endsWith('.txt'))
  return parseLists(new Map(names.map((n) => [n, readFileSync(join(dir, n), 'utf8')])))
}

/** Writes every package's list, and removes the list of a package with nothing left */
export function writeAllowlist(root: string, allow: Allowlist): void {
  const dir = join(root, ALLOWLIST_DIR)
  mkdirSync(dir, { recursive: true })
  const byList = new Map<string, Allowlist>()
  for (const [file, rules] of allow) {
    const name = listFileOf(packageOf(file))
    const list = byList.get(name) ?? new Map<string, Map<string, number>>()
    byList.set(name, list.set(file, rules))
  }
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
    if (!byList.has(name)) rmSync(join(dir, name))
  }
  for (const [name, list] of byList) writeFileSync(join(dir, name), formatList(list))
}

/** A result's path as the lists write it: relative to the root, with forward slashes */
export const relativeFile = (root: string, filePath: string) => relative(root, filePath).split(sep).join('/')

/** Errors per file and rule, of the rules a line may name (fatal parse errors have no rule) */
export function countFindings(root: string, results: ESLint.LintResult[]): Allowlist {
  const out: Allowlist = new Map()
  for (const result of results) {
    const rules = new Map<string, number>()
    for (const m of result.messages) if (m.severity === 2 && m.ruleId && LISTABLE_RULES.has(m.ruleId)) rules.set(m.ruleId, (rules.get(m.ruleId) ?? 0) + 1)
    if (rules.size > 0) out.set(relativeFile(root, result.filePath), rules)
  }
  return out
}

/** Errors no line may name: other rules', and files that failed to parse */
export function otherErrors(results: ESLint.LintResult[]): number {
  return results.reduce((n, r) => n + r.messages.filter((m) => m.severity === 2 && !(m.ruleId && LISTABLE_RULES.has(m.ruleId))).length, 0)
}

/**
 * The files whose findings these results fully count, so `tighten` may lower their lines: not one that failed to
 * parse (its findings are unknown, not zero) or one ESLint ignored.
 */
export function countedFiles(root: string, results: ESLint.LintResult[]): Set<string> {
  const ignored = (r: ESLint.LintResult) => r.messages.some((m) => m.ruleId === null && m.severity === 1 && m.message.startsWith('File ignored'))
  return new Set(results.filter((r) => r.fatalErrorCount === 0 && !ignored(r)).map((r) => relativeFile(root, r.filePath)))
}

export type Disabled = { file: string; line: number; rule: string }

/**
 * Findings of a type-aware rule that an `eslint-disable` comment hid. Such a comment would skip the lists and every
 * check on them (#1343 review), so `pnpm lint` fails on it: read the value through a guard instead.
 */
export function disabledFindings(root: string, results: ESLint.LintResult[]): Disabled[] {
  const out: Disabled[] = []
  for (const r of results) {
    for (const m of r.suppressedMessages) {
      if (m.ruleId && LISTABLE_RULES.has(m.ruleId) && m.suppressions.some((s) => s.kind === 'directive')) {
        out.push({ file: relativeFile(root, r.filePath), line: m.line, rule: m.ruleId })
      }
    }
  }
  return out
}

export type Over = { file: string; rule: string; count: number; allowed: number }

/**
 * Takes the findings the lists allow out of the results, in place, and says which files hold more than theirs
 * (those keep every finding of that rule, so the new one is among what is shown) and which lines are above what
 * their file holds now (`loose`), of the files whose findings these results fully count.
 */
export function applyAllowlist(root: string, results: ESLint.LintResult[], allow: Allowlist): { over: Over[]; loose: Over[] } {
  const over: Over[] = []
  const loose: Over[] = []
  const counts = countFindings(root, results)
  const counted = countedFiles(root, results)
  for (const result of results) {
    const file = relativeFile(root, result.filePath)
    const listed = allow.get(file)
    if (!listed) continue
    const found = counts.get(file) ?? new Map<string, number>()
    const allowed = new Set<string>()
    for (const [rule, max] of listed) {
      const count = found.get(rule) ?? 0
      if (count > max) over.push({ file, rule, count, allowed: max })
      else allowed.add(rule)
      if (count < max && counted.has(file)) loose.push({ file, rule, count, allowed: max })
    }
    result.messages = result.messages.filter((m: Linter.LintMessage) => !(m.severity === 2 && m.ruleId && allowed.has(m.ruleId)))
    recount(result)
  }
  return { over, loose }
}

function recount(result: ESLint.LintResult): void {
  const errors = result.messages.filter((m) => m.severity === 2)
  const warnings = result.messages.filter((m) => m.severity === 1)
  result.errorCount = errors.length
  result.fatalErrorCount = errors.filter((m) => m.fatal).length
  result.fixableErrorCount = errors.filter((m) => m.fix).length
  result.warningCount = warnings.length
  result.fixableWarningCount = warnings.filter((m) => m.fix).length
}

const byKey = <T>([a]: [string, T], [b]: [string, T]) => (a < b ? -1 : a > b ? 1 : 0)

/** A file git sees renamed (`git diff -M`): the only way a count moves from one file to another */
export type Rename = { from: string; to: string }

/**
 * The lists as they read after these renames: each old path's lines become its new path's. A rename's new path was not
 * there before (git pairs a rename onto no existing path), so a line the lists still hold for it is a stale one, left
 * by a file once deleted there: it is replaced, never added to (#1343 review).
 */
export function alongRenames(allow: Allowlist, renames: readonly Rename[]): Allowlist {
  const out: Allowlist = new Map([...allow].map(([file, rules]) => [file, new Map(rules)]))
  for (const { to } of renames) out.delete(to)
  for (const { from, to } of renames) {
    const moved = allow.get(from)
    out.delete(from)
    if (moved) out.set(to, new Map(moved))
  }
  return out
}

export type Move = { from: string; to: string; rule: string; count: number }

/**
 * The lists after a run: a renamed file's lines follow it to its new path (`moves`, which `pnpm lint:tighten`
 * prints), then each line is lowered to what its file holds, or taken away at zero or when its file is gone. A file
 * this run did not count keeps its lines. Nothing else is ever raised or added: code moved into another file is a new
 * finding there, and a count freed in one file is not credit for another (#1343 review).
 */
export function tighten(
  allow: Allowlist,
  found: Allowlist,
  counted: Set<string>,
  exists: (file: string) => boolean,
  renames: readonly Rename[] = [],
): { allow: Allowlist; moves: Move[] } {
  const moved = alongRenames(allow, renames)
  const out: Allowlist = new Map()
  for (const [file, rules] of moved) {
    if (!exists(file)) continue
    const kept = new Map<string, number>()
    for (const [rule, max] of rules) {
      const n = counted.has(file) ? Math.min(max, found.get(file)?.get(rule) ?? 0) : max
      if (n > 0) kept.set(rule, n)
    }
    if (kept.size > 0) out.set(file, kept)
  }
  const moves: Move[] = []
  for (const { from, to } of renames) {
    for (const [rule, was] of allow.get(from) ?? []) {
      const count = Math.min(was, out.get(to)?.get(rule) ?? 0)
      if (count > 0) moves.push({ from, to, rule, count })
    }
  }
  return { allow: out, moves }
}

/**
 * The lines that list more than main's lists do, after main's are carried along this change's renames: any new or
 * higher line that is not a renamed file's own lines under its new name. A file this change adds holds nothing, even
 * where main still has a stale line for a file once deleted at that path. No change may list a new finding.
 */
export function compareWithBase(base: Allowlist, current: Allowlist, renames: readonly Rename[] = [], added: readonly string[] = []): string[] {
  const expected = alongRenames(base, renames)
  for (const file of added) expected.delete(file)
  const raised: string[] = []
  for (const [file, rules] of [...current].sort(byKey)) {
    for (const [rule, n] of [...rules].sort(byKey)) {
      const was = expected.get(file)?.get(rule) ?? 0
      if (n > was) raised.push(`${file} ${rule} ${n} (main: ${was})`)
    }
  }
  return raised
}

const runGit = (root: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/**
 * The commit this branch left main at: the merge base of HEAD and `ref`, or HEAD's first parent when HEAD is on main
 * itself (a push to main, compared with what it landed on). null when this checkout cannot tell (no such history).
 */
export function baseCommit(root: string, ref: string): string | null {
  const head = runGit(root, 'rev-parse', 'HEAD')?.trim()
  const mergeBase = runGit(root, 'merge-base', 'HEAD', ref)?.trim()
  if (!head || !mergeBase) return null
  return mergeBase === head ? (runGit(root, 'rev-parse', '--verify', '--quiet', 'HEAD^1')?.trim() ?? null) : mergeBase
}

/** The files added since `base` (not renamed), in the working tree; null when git cannot tell */
export function addedSince(root: string, base: string): string[] | null {
  const out = runGit(root, 'diff', '--name-only', '-M', '--diff-filter=A', base, '--')
  return out === null ? null : out.split('\n').filter(Boolean)
}

/**
 * The files renamed since `base`, as git detects them in the working tree (`git diff -M`); null when git cannot tell.
 * A file moved without `git mv` or `git add` is not in the diff, so it is no rename: its count stays behind.
 */
export function renamesSince(root: string, base: string): Rename[] | null {
  const out = runGit(root, 'diff', '--name-status', '-M', '--diff-filter=R', base, '--')
  if (out === null) return null
  return out
    .split('\n')
    .map((line) => /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line))
    .flatMap((m) => (m?.[1] && m[2] ? [{ from: m[1], to: m[2] }] : []))
}

/** Where main's lists come from, or why there are none to compare with */
export type MainLists =
  | { kind: 'lists'; base: string; lists: Allowlist }
  | { kind: 'before-lists'; base: string }
  | { kind: 'no-base'; why: string }
  | { kind: 'unreadable'; why: string }

/**
 * main's lists where this branch left it: at the merge base of HEAD and `ref`, or at HEAD's first parent when HEAD
 * is on main itself (a push to main, compared with what it landed on). `before-lists` is a base older than this
 * module, from before the lists existed; once it is there, a missing list means nothing is allowed. Reads trees and
 * the lists' files only, so a clone without file contents (`filter: blob:none`) fetches just those.
 */
export function mainLists(root: string, ref: string): MainLists {
  const git = (...args: string[]) => runGit(root, ...args)
  const base = baseCommit(root, ref)
  if (!base) return { kind: 'no-base', why: `no merge base with ${ref} in this checkout (or HEAD is ${ref} and its parent is not here)` }
  const module = git('ls-tree', '--name-only', base, '--', 'tooling/lint-allowlist.ts')
  if (module === null) return { kind: 'unreadable', why: `could not read the tree of ${base}` }
  if (module.trim() === '') return { kind: 'before-lists', base }
  const names = git('ls-tree', '--name-only', base, '--', `${ALLOWLIST_DIR}/`)
  if (names === null) return { kind: 'unreadable', why: `could not read ${ALLOWLIST_DIR}/ at ${base}` }
  const texts = new Map<string, string>()
  for (const path of names.split('\n').filter((n) => n.endsWith('.txt'))) {
    const text = git('show', `${base}:${path}`)
    if (text === null) return { kind: 'unreadable', why: `could not read ${path} at ${base}` }
    texts.set(path.slice(ALLOWLIST_DIR.length + 1), text)
  }
  return { kind: 'lists', base, lists: parseLists(texts) }
}

/** What `pnpm lint` adds under ESLint's report about the type-aware findings left, as lines */
export function lintHints(left: readonly Linter.LintMessage[]): string[] {
  const typeAware = left.filter((m) => m.ruleId?.startsWith('@typescript-eslint/'))
  if (typeAware.length === 0) return []
  return [
    'Type-aware findings (#1339). Fix new code; the lists hold only what predates the rules.',
    '  A renamed file: `pnpm lint:tighten` moves its lines to the new path. Code moved into another file is a new finding there.',
    ...(typeAware.some((m) => /type 'Error'/.test(m.message)) ? ["  `(e as Error).message`: errorMessage(e) from '@cc/protocol'."] : []),
    ...(typeAware.some((m) => m.ruleId === '@typescript-eslint/no-unnecessary-type-assertion') ? ['  An assertion a type made unnecessary: `pnpm exec eslint --fix <files>` takes it out.'] : []),
    '  Data from outside the process (JSON.parse, a file, a socket, a stream): a zod schema or a narrowing guard, never `as`.',
  ]
}

/**
 * Whether a run failed: errors left (a file over its line, or a finding no line names) or an eslint-disable of a
 * type-aware rule. A line above what its file holds, or for a file that is gone, is not a failure: two changes that
 * each fix one finding of a file would otherwise fail together in a queue batch, and a change that only fixes things
 * would have to edit a list. `pnpm lint:tighten` and the weekly tighten job lower such lines, and no change can raise
 * one again (tooling/type-aware-lint.test.ts).
 */
export function lintFailed(o: { errorsLeft: number; disabled: number; recording: boolean; othersLeft: number }): boolean {
  if (o.recording) return o.othersLeft > 0 || o.disabled > 0
  return o.errorsLeft > 0 || o.disabled > 0
}
