/**
 * The type-aware lint (#1339) only ever gets stricter.
 *
 * eslint.config.js turned on rules that read types: no `any` flowing on from `JSON.parse` or a catch, no assertion
 * that narrows what nothing checked, no `x!`, no promise left floating. The findings that predate them are listed
 * per file in tooling/lint-allowlist/, and `pnpm lint` holds each file to its count (tooling/lint-allowlist.ts).
 *
 * Those lists can be written by a command (`--record-all`), so they could also grow by a line, quietly, inside a
 * large diff. CEILING caps each package's total, and ASSERTIONS caps every `as T` in shipped code, the safe
 * widening ones included, which the lint does not report. Both only fail above their number, so a change in
 * flight never has to edit them; the change that fixes findings lowers them (the warning gives the numbers).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ALLOWLIST_DIR, formatList, packageOf, parseList, readAllowlist, totals } from './lint-allowlist.js'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The most each package's list may allow in total; lower these as findings are fixed, never raise one */
const CEILING: Record<string, number> = {
  'apps/desktop': 12,
  'apps/web': 4,
  e2e: 66,
  'packages/agent-host': 1948,
  'packages/core': 16,
  'packages/platform': 59,
  'packages/protocol': 43,
  'packages/ui': 749,
  tooling: 19,
}

/** The most type assertions (`x as T`, `<T>x`; not `as const`) each package's src may hold outside its tests */
const ASSERTIONS: Record<string, number> = {
  'apps/desktop': 4,
  'apps/web': 6,
  'packages/agent-host': 775,
  'packages/core': 5,
  'packages/platform': 37,
  'packages/protocol': 21,
  'packages/ui': 260,
}

function countAssertions(file: string, text: string): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  let n = 0
  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const asConst = ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === 'const'
      if (!asConst) n++
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return n
}

const isShipped = (file: string) =>
  /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith('test-helpers.ts') && !file.endsWith('.d.ts') && !file.includes('/adapters/codex/generated/')

function shippedFiles(): string[] {
  const out: string[] = []
  for (const top of ['packages', 'apps']) {
    for (const name of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, name, 'src')
      if (!existsSync(src)) continue
      for (const entry of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
        const file = relative(ROOT, join(src, entry)).split(sep).join('/')
        if (isShipped(file)) out.push(file)
      }
    }
  }
  return out
}

/** The packages above their ceiling, and the numbers a ceiling could come down to */
function overAndUnder(actual: Record<string, number>, ceiling: Record<string, number>) {
  const over = Object.entries(actual)
    .filter(([pkg, n]) => n > (ceiling[pkg] ?? 0))
    .map(([pkg, n]) => `${pkg}: ${n}, ceiling ${ceiling[pkg] ?? 0}`)
  const under = Object.entries(ceiling)
    .filter(([pkg, n]) => (actual[pkg] ?? 0) < n)
    .map(([pkg]) => `${pkg}: ${actual[pkg] ?? 0}`)
  return { over, under }
}

describe('type-aware lint (#1339)', () => {
  it('keeps every list sorted, one line per file and rule, in its own package', () => {
    const dir = join(ROOT, ALLOWLIST_DIR)
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n')
      expect(formatList(parseList(text, name)), `${ALLOWLIST_DIR}/${name} as \`pnpm lint:tighten\` writes it`).toBe(text)
    }
    // Throws for a line in another package's list
    expect(() => readAllowlist(ROOT)).not.toThrow()
  })

  it('allows no package more findings than its ceiling', () => {
    const actual = Object.fromEntries([...totals(readAllowlist(ROOT))].map(([pkg, rules]) => [pkg, [...rules.values()].reduce((a, b) => a + b, 0)]))
    const { over, under } = overAndUnder(actual, CEILING)
    expect(over, `${ALLOWLIST_DIR}/ allows more than CEILING: fix the findings instead of listing them`).toEqual([])
    if (under.length > 0) console.warn(`type-aware-lint.test.ts: CEILING can come down to ${under.join(', ')}`)
  })

  it(
    'keeps the count of type assertions in shipped code under its ceiling',
    () => {
      const actual: Record<string, number> = {}
      for (const file of shippedFiles()) {
        const n = countAssertions(file, readFileSync(join(ROOT, file), 'utf8'))
        if (n > 0) actual[packageOf(file)] = (actual[packageOf(file)] ?? 0) + n
      }
      const { over, under } = overAndUnder(actual, ASSERTIONS)
      expect(over, 'type assertions per package: check the value (a zod schema, a guard) instead of asserting its type').toEqual([])
      if (under.length > 0) console.warn(`type-aware-lint.test.ts: ASSERTIONS can come down to ${under.join(', ')}`)
    },
    30_000 * SLOW,
  )

  it('counts what it says it counts', () => {
    expect(countAssertions('x.ts', 'const a = b as string; const c = <number>d; const e = f as unknown as G')).toBe(4)
    expect(countAssertions('x.ts', "const a = ['x'] as const; // b as string\nconst s = 'c as D'")).toBe(0)
    expect(countAssertions('x.tsx', 'const a = <div>{b as string}</div>')).toBe(1)
  })

  it('reports a package over its ceiling, and only that', () => {
    expect(overAndUnder({ a: 3, b: 1, c: 2 }, { a: 2, b: 2 })).toEqual({ over: ['a: 3, ceiling 2', 'c: 2, ceiling 0'], under: ['b: 1'] })
  })
})
