/**
 * The findings of the type-aware lint (#1339) that predate it, one list per package in tooling/lint-allowlist/.
 *
 * Each line says a file may hold up to so many findings of one rule: `<file> <rule> <count>`, sorted. A file
 * that holds more fails `pnpm lint` with all of them shown, as does any finding in a file or rule no line names.
 * One that holds fewer passes, so a change in flight never has to touch a list for fixing something. A list per
 * package keeps two changes from editing the same file unless they work on the same package.
 *
 * `pnpm lint:tighten` lowers the lines to what the files hold, and lists what moved: a finding over or outside the
 * lists takes what the same rule gave up elsewhere in that run (code moved to another file, a file renamed), never
 * more. tooling/type-aware-lint.test.ts holds every rule's total to main's, so no change can list more than main
 * had, by hand or by command.
 *
 * This module is the logic; tooling/lint.ts runs ESLint with it.
 */
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
  '# Written by `pnpm lint:tighten`, which lowers lines and moves a count along with moved code; no rule may total more than on main.',
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
 * Takes the findings the lists allow out of the results, in place, and says which files hold more than
 * theirs (those keep every finding of that rule, so the new one is among what is shown) and how many lines
 * could be lowered.
 */
export function applyAllowlist(root: string, results: ESLint.LintResult[], allow: Allowlist): { over: Over[]; loose: number } {
  const over: Over[] = []
  const counts = countFindings(root, results)
  let loose = 0
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
      if (count < max) loose++
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

/**
 * The lists after a run: each line lowered to what its file holds (away at zero, or when the file is gone), then
 * what moved listed. A finding over or outside the lists, in a file this run counted, takes what its rule gave up
 * in this run, file by file in order until none is left; no rule ends with more than it started with. A file this
 * run did not count keeps its lines.
 */
export function tighten(allow: Allowlist, found: Allowlist, counted: Set<string>, exists: (file: string) => boolean): Allowlist {
  const out: Allowlist = new Map()
  const freed = new Map<string, number>()
  for (const [file, rules] of allow) {
    const gone = !exists(file)
    const kept = new Map<string, number>()
    for (const [rule, max] of rules) {
      const n = gone ? 0 : counted.has(file) ? Math.min(max, found.get(file)?.get(rule) ?? 0) : max
      if (n < max) freed.set(rule, (freed.get(rule) ?? 0) + max - n)
      if (n > 0) kept.set(rule, n)
    }
    if (kept.size > 0) out.set(file, kept)
  }
  for (const [file, rules] of [...found].sort(byKey)) {
    if (!counted.has(file)) continue
    for (const [rule, n] of [...rules].sort(byKey)) {
      const listed = out.get(file)?.get(rule) ?? 0
      const moved = Math.min(n - listed, freed.get(rule) ?? 0)
      if (moved <= 0) continue
      freed.set(rule, (freed.get(rule) ?? 0) - moved)
      out.set(file, (out.get(file) ?? new Map<string, number>()).set(rule, listed + moved))
    }
  }
  return out
}

/** Sums a list per rule */
export function ruleTotals(allow: Allowlist): Map<string, number> {
  const out = new Map<string, number>()
  for (const rules of allow.values()) for (const [rule, n] of rules) out.set(rule, (out.get(rule) ?? 0) + n)
  return out
}

/**
 * How the lists compare with main's, line by line: the lines that are new or higher, and the rules whose total
 * grew. A new or higher line is a move when its rule's total did not grow (the count went down as much elsewhere);
 * a rule whose total grew is listing something new, which no change may do.
 */
export function compareWithBase(base: Allowlist, current: Allowlist): { raised: string[]; grown: string[] } {
  const raised: string[] = []
  for (const [file, rules] of [...current].sort(byKey)) {
    for (const [rule, n] of [...rules].sort(byKey)) {
      const was = base.get(file)?.get(rule) ?? 0
      if (n > was) raised.push(`${file} ${rule} ${n} (main: ${was})`)
    }
  }
  const before = ruleTotals(base)
  const grown = [...ruleTotals(current)]
    .filter(([rule, n]) => n > (before.get(rule) ?? 0))
    .sort(byKey)
    .map(([rule, n]) => `${rule}: ${n}, main ${before.get(rule) ?? 0}`)
  return { raised, grown }
}
