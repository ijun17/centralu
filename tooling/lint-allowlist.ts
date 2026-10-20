/**
 * The findings of the type-aware lint (#1339) that predate it, one list per package in tooling/lint-allowlist/.
 *
 * Each line says a file may hold up to so many findings of one rule: `<file> <rule> <count>`, sorted. A file
 * that holds more fails `pnpm lint` with all of them shown, as does any finding in a file or rule no line names.
 * One that holds fewer passes: lowering the counts is `pnpm lint:tighten`, run by the change that fixes them, so
 * other changes in flight never have to touch these lists. A list per package keeps two changes from editing
 * the same file unless they work on the same package.
 *
 * This module is the logic; tooling/lint.ts runs ESLint with it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ESLint, Linter } from 'eslint'

export const ALLOWLIST_DIR = 'tooling/lint-allowlist'

const HEADER = [
  '# Type-aware lint findings that predate the rules (#1339): <file> <rule> <count>, one per line, sorted.',
  '# Only ever lower these, with `pnpm lint:tighten`; fix a new finding instead of listing it.',
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
    for (const [rule, count] of [...rules].sort(byName)) lines.push(`${file} ${rule} ${count}`)
  }
  return [...HEADER, ...lines].join('\n') + '\n'
}

export function readAllowlist(root: string): Allowlist {
  const dir = join(root, ALLOWLIST_DIR)
  const out: Allowlist = new Map()
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.txt')).sort()) {
    for (const [file, rules] of parseList(readFileSync(join(dir, name), 'utf8'), name)) {
      if (listFileOf(packageOf(file)) !== name) throw new Error(`${name}: ${file} belongs in ${listFileOf(packageOf(file))}`)
      out.set(file, rules)
    }
  }
  return out
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

/** Errors per file and rule (fatal parse errors have no rule and are never listed) */
export function countFindings(root: string, results: ESLint.LintResult[]): Allowlist {
  const out: Allowlist = new Map()
  for (const result of results) {
    const rules = new Map<string, number>()
    for (const m of result.messages) if (m.severity === 2 && m.ruleId) rules.set(m.ruleId, (rules.get(m.ruleId) ?? 0) + 1)
    if (rules.size > 0) out.set(relativeFile(root, result.filePath), rules)
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

/**
 * The lists lowered to what the linted files hold: a line goes down to its file's count, or away at zero or
 * when its file is gone. A file that was not linted this time keeps its lines. Nothing is ever raised or added.
 */
export function tighten(allow: Allowlist, found: Allowlist, linted: Set<string>, exists: (file: string) => boolean): Allowlist {
  const out: Allowlist = new Map()
  for (const [file, rules] of allow) {
    if (!exists(file)) continue
    const kept = new Map<string, number>()
    for (const [rule, max] of rules) {
      const n = linted.has(file) ? Math.min(max, found.get(file)?.get(rule) ?? 0) : max
      if (n > 0) kept.set(rule, n)
    }
    if (kept.size > 0) out.set(file, kept)
  }
  return out
}

/** Sums a list per package and rule */
export function totals(allow: Allowlist): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const [file, rules] of allow) {
    const pkg = out.get(packageOf(file)) ?? new Map<string, number>()
    for (const [rule, n] of rules) pkg.set(rule, (pkg.get(rule) ?? 0) + n)
    out.set(packageOf(file), pkg)
  }
  return out
}
