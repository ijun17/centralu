/**
 * The type-aware lint (#1339) only ever gets stricter.
 *
 * eslint.config.js turned on rules that read types: no `any` flowing on from `JSON.parse` or a catch, no assertion
 * that narrows what nothing checked, no `x!`, no promise left floating. The findings that predate them are listed
 * per file in tooling/lint-allowlist/, and `pnpm lint` holds each file to its count (tooling/lint-allowlist.ts).
 *
 * What this adds, each a way around those counts that the #1343 review found open:
 *   - the lists against main's, line by line: a line may be new or higher only as a move (its rule's total did not
 *     grow), so a hand-written line or a regenerated list cannot list new findings; a fix needs no edit here;
 *   - no `eslint-disable` of a type-aware rule, and no comment that turns one off, anywhere they run;
 *   - every `as T` in shipped code counted (ASSERTIONS), the safe widening ones included, which no rule reports;
 *   - ESLint's threads capped, since each builds the whole program.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ALLOWLIST_DIR, LINT_OPTIONS, LISTABLE_RULES, compareWithBase, formatList, packageOf, parseList, parseLists, readAllowlist, type Allowlist } from './lint-allowlist.js'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Rules this change turned on, whose findings it lists for the first time (`pnpm exec tsx tooling/lint.ts
 * --record-all`), each with why. Main's lists cannot hold them yet, so their totals are not held to main's in that
 * one change; the next change takes its rule out of here again.
 */
const TURNED_ON: Record<string, string> = {}

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

/**
 * How far over ASSERTIONS a package may go: room for the safe assertions (a widening, `as unknown`) a change in
 * flight adds, so it does not have to edit this file; unsafe ones the lint reports per file. The changes that
 * remove assertions lower ASSERTIONS.
 */
const ASSERTION_ROOM = 10

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

const isTest = (file: string) => /\.test\.tsx?$/.test(file) || file.endsWith('test-helpers.ts')
const isSource = (file: string) => /\.(tsx?|mts)$/.test(file) && !file.endsWith('.d.ts') && !file.includes('/adapters/codex/generated/')

function filesUnder(dir: string): string[] {
  if (!existsSync(join(ROOT, dir))) return []
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .map((entry) => relative(ROOT, join(ROOT, dir, entry)).split(sep).join('/'))
    .filter((file) => !file.includes('/node_modules/') && isSource(file))
}

/** packages/*\/src and apps/*\/src: what ships */
function srcDirs(): string[] {
  return ['packages', 'apps'].flatMap((top) => readdirSync(join(ROOT, top)).map((name) => `${top}/${name}/src`))
}

/** Where the type-aware rules run (eslint.config.js `TYPED_FILES`) */
function typedFiles(): string[] {
  const scripts = readdirSync(join(ROOT, 'packages')).map((name) => `packages/${name}/scripts`)
  return [...srcDirs(), ...scripts, 'e2e', 'tooling'].flatMap(filesUnder)
}

/** The packages above their ceiling, with `room` over it allowed, and the numbers a ceiling could come down to */
function overAndUnder(actual: Record<string, number>, ceiling: Record<string, number>, room = 0) {
  const over = Object.entries(actual)
    .filter(([pkg, n]) => n > (ceiling[pkg] ?? 0) + room)
    .map(([pkg, n]) => `${pkg}: ${n}, ceiling ${(ceiling[pkg] ?? 0) + room}`)
  const under = Object.entries(ceiling)
    .filter(([pkg, n]) => (actual[pkg] ?? 0) < n)
    .map(([pkg]) => `${pkg}: ${actual[pkg] ?? 0}`)
  return { over, under }
}

// Built, so that this file's own examples are not comments the guard below reads
const D = 'eslint' + '-disable'
const E = 'eslint'

/**
 * Comments that would switch a type-aware rule off where they stand: an `eslint-disable` naming one, one naming no
 * rule (it switches every rule off), and a configuration comment (`/* eslint <rule>: off *\/`) naming one.
 */
function forbiddenComments(code: string): string[] {
  const out: string[] = []
  const directive = new RegExp(`\\/\\/\\s*${D}(?:-next-line|-line)?(?=\\s|$)([^\\n]*)|\\/\\*\\s*${D}(?:-next-line|-line)?(?=\\s|\\*)([\\s\\S]*?)\\*\\/`, 'gm')
  for (const m of code.matchAll(directive)) {
    const rules = (m[1] ?? m[2] ?? '').split('--')[0]?.split(/[\s,]+/).filter(Boolean) ?? []
    if (rules.length === 0) out.push(`${D} with no rule named: it switches the type-aware rules off too`)
    for (const rule of rules) if (LISTABLE_RULES.has(rule)) out.push(`${D} ${rule}`)
  }
  for (const m of code.matchAll(/\/\*\s*eslint\s+([\s\S]*?)\*\//g)) {
    for (const [, rule = ''] of (m[1] ?? '').matchAll(/([@\w/-]+)\s*:/g)) if (LISTABLE_RULES.has(rule)) out.push(`a configuration comment for ${rule}`)
  }
  return out
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/**
 * main's lists where this branch left it (the merge base with `CC_LINT_BASE`, origin/main by default), or why
 * there are none: no such history here (a shallow checkout), or no lists at all at that commit (before the change
 * that brought them, which is told by the module that reads them; once it is there, no list means none allowed).
 */
function mainLists(): { lists: Allowlist } | { none: string } {
  const ref = process.env.CC_LINT_BASE ?? 'origin/main'
  const base = git(['merge-base', 'HEAD', ref])?.trim()
  if (!base) return { none: `no merge base with ${ref} in this checkout` }
  if (git(['cat-file', '-e', `${base}:tooling/lint-allowlist.ts`]) === null) return { none: 'main has no lists yet; this change brings them' }
  const names = git(['ls-tree', '--name-only', `${base}:${ALLOWLIST_DIR}`]) ?? ''
  const texts = new Map<string, string>()
  for (const name of names.split('\n').filter((n) => n.endsWith('.txt'))) {
    const text = git(['show', `${base}:${ALLOWLIST_DIR}/${name}`])
    if (text === null) return { none: `could not read ${name} at ${base}` }
    texts.set(name, text)
  }
  return { lists: parseLists(texts) }
}

describe('type-aware lint (#1339)', () => {
  it('keeps every list sorted, one line per file and rule, in its own package', () => {
    const dir = join(ROOT, ALLOWLIST_DIR)
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
      const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n')
      expect(formatList(parseList(text, name)), `${ALLOWLIST_DIR}/${name} as \`pnpm lint:tighten\` writes it`).toBe(text)
    }
    // Throws for a line in another package's list
    expect(() => readAllowlist(ROOT)).not.toThrow()
  })

  it("lists no more of any rule than main's lists do: a new or higher line only as a move", () => {
    const main = mainLists()
    if ('none' in main) {
      // CI's verify job fetches main's history and sets CC_LINT_BASE, so there they have to be found
      const first = main.none.startsWith('main has no lists yet')
      if (!first) expect(process.env.CC_LINT_BASE, `main's lists: ${main.none}`).toBeUndefined()
      console.warn(`type-aware-lint.test.ts: not compared with main's lists (${main.none})`)
      return
    }
    const { raised, grown } = compareWithBase(main.lists, readAllowlist(ROOT))
    const growing = grown.filter((g) => !Object.keys(TURNED_ON).some((rule) => g.startsWith(`${rule}:`)))
    expect(
      growing,
      `${ALLOWLIST_DIR}/ lists more than main for these rules. Fix the new findings instead; moved code keeps its count ` +
        `(\`pnpm lint:tighten\`). New or higher lines:\n${raised.join('\n')}`,
    ).toEqual([])
  })

  it('turns no type-aware rule off with a comment', () => {
    const found = typedFiles().flatMap((file) => forbiddenComments(readFileSync(join(ROOT, file), 'utf8')).map((what) => `${file}: ${what}`))
    expect(found, 'check the value (a zod schema, a guard) instead of switching the rule off').toEqual([])
  })

  it('finds every comment that would switch a type-aware rule off, and only those', () => {
    expect(forbiddenComments(`// ${D}-next-line @typescript-eslint/no-non-null-assertion -- because`)).toHaveLength(1)
    expect(forbiddenComments(`/* ${D} no-console, @typescript-eslint/no-unsafe-member-access */`)).toHaveLength(1)
    expect(forbiddenComments(`x() // ${D}-line @typescript-eslint/no-unsafe-type-assertion`)).toHaveLength(1)
    expect(forbiddenComments(`/* ${D} */`)).toHaveLength(1)
    expect(forbiddenComments(`// ${D}-next-line`)).toHaveLength(1)
    expect(forbiddenComments(`/* ${E} @typescript-eslint/no-floating-promises: "off" */`)).toHaveLength(1)
    expect(forbiddenComments(`// ${D}-next-line no-control-regex\n/* ${D} @typescript-eslint/no-explicit-any -- raw frames */`)).toEqual([])
    expect(forbiddenComments(`const note = 'see ${D}d rules'`)).toEqual([])
  })

  it('runs ESLint on at most two threads', () => {
    // Each thread builds the whole program: six took 13.6 GB on a 12-thread PC, two 5.8 GB (#1343 review)
    expect(LINT_OPTIONS.concurrency).toBeLessThanOrEqual(2)
  })

  it(
    'keeps the count of type assertions in shipped code under its ceiling',
    () => {
      const actual: Record<string, number> = {}
      for (const file of srcDirs().flatMap(filesUnder).filter((f) => !isTest(f) && !f.endsWith('.mts'))) {
        const n = countAssertions(file, readFileSync(join(ROOT, file), 'utf8'))
        if (n > 0) actual[packageOf(file)] = (actual[packageOf(file)] ?? 0) + n
      }
      const { over, under } = overAndUnder(actual, ASSERTIONS, ASSERTION_ROOM)
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
    expect(overAndUnder({ a: 3, c: 2 }, { a: 2 }, 1)).toEqual({ over: ['c: 2, ceiling 1'], under: [] })
  })
})
