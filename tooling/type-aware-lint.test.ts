/**
 * The type-aware lint (#1339) only ever gets stricter.
 *
 * eslint.config.js turned on rules that read types: no `any` flowing on from `JSON.parse` or a catch, no assertion
 * that narrows what nothing checked, no `x!`, no promise left floating. The findings that predate them are listed
 * per file in tooling/lint-allowlist/, and `pnpm lint` holds each file to its count (tooling/lint-allowlist.ts).
 *
 * What this adds, each a way around those counts that the #1343 review found open:
 *   - the lists against main's, line by line: no line may be new or higher but a file's own lines under the new
 *     path git sees it renamed to, so a hand-written line, a regenerated list or a count freed elsewhere cannot list
 *     a new finding; CI's verify job gives it main's history (and fails without it), elsewhere it says when it could
 *     not compare;
 *   - the weekly job that lowers stale lines (a line above its file is not a lint failure, see `lintFailed`);
 *   - no `eslint-disable` of a type-aware rule, and no comment that turns one off, anywhere they run;
 *   - every `as T` in shipped code counted (ASSERTIONS), the safe widening ones included, which no rule reports;
 *   - ESLint's threads capped, since each builds the whole program.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  ALLOWLIST_DIR,
  LISTABLE_RULES,
  addedSince,
  compareWithBase,
  eslintOptions,
  formatList,
  mainLists,
  packageOf,
  parseList,
  readAllowlist,
  renamesSince,
} from './lint-allowlist.js'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Rules this change turned on, whose findings it lists for the first time (`pnpm exec tsx tooling/lint.ts
 * --record-all`), each with why. Main's lists cannot hold them yet, so their lines are not compared with main's in
 * that one change; the next change takes its rule out of here again.
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
  // Other test files make and remove folders in the tree while this one walks it: a folder gone mid-walk is walked again
  for (let attempt = 1; ; attempt++) {
    try {
      return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
        .map((entry) => relative(ROOT, join(ROOT, dir, entry)).split(sep).join('/'))
        .filter((file) => !file.includes('/node_modules/') && isSource(file))
    } catch (e) {
      if (attempt >= 3 || !isGone(e)) throw e
    }
  }
}

/** A file or folder that went away (or cannot be read) between being listed and being read */
const isGone = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY'].includes(String(e.code))

/** A file's text, or null when it went away (or cannot be read) since it was listed */
function readIfThereOf(file: string, read: (file: string) => string): string | null {
  try {
    return read(file)
  } catch (e) {
    if (isGone(e)) return null
    throw e
  }
}
const readIfThere = (file: string) => readIfThereOf(file, (f) => readFileSync(join(ROOT, f), 'utf8'))

/**
 * The comments that switch a type-aware rule off, in these files. Only a file whose text names `eslint` can hold one,
 * so only those are parsed (a few dozen of some two thousand); a file that went away since it was listed is passed
 * by, as other test files make and remove files in the tree while this runs.
 */
function scanComments(files: readonly string[], read: (file: string) => string | null, check: (file: string, code: string) => string[]): string[] {
  return files.flatMap((file) => {
    const code = read(file)
    if (code === null || !code.includes(E)) return []
    return check(file, code).map((what) => `${file}: ${what}`)
  })
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

/** The comments of a file, as the compiler finds them: not text inside a string or a template */
function commentsOf(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const seen = new Set<number>()
  const out: string[] = []
  const take = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue
      seen.add(r.pos)
      out.push(code.slice(r.pos, r.end))
    }
  }
  const visit = (node: ts.Node) => {
    take(ts.getLeadingCommentRanges(code, node.getFullStart()))
    take(ts.getTrailingCommentRanges(code, node.getEnd()))
    ts.forEachChild(node, visit)
  }
  visit(source)
  take(ts.getLeadingCommentRanges(code, source.endOfFileToken.getFullStart()))
  return out
}

/**
 * Comments that would switch a type-aware rule off where they stand: an `eslint-disable` naming one, one naming no
 * rule (it switches every rule off), and a configuration comment (`/* eslint <rule>: off *\/`) naming one.
 */
function forbiddenComments(file: string, code: string): string[] {
  const out: string[] = []
  for (const comment of commentsOf(file, code)) {
    const body = comment.startsWith('//') ? comment.slice(2) : comment.slice(2, -2)
    const directive = new RegExp(`^\\s*${D}(?:-next-line|-line)?(?=\\s|$)([\\s\\S]*)$`).exec(body)
    if (directive) {
      const rules = (directive[1] ?? '').split('--')[0]?.split(/[\s,]+/).filter(Boolean) ?? []
      if (rules.length === 0) out.push(`${D} with no rule named: it switches the type-aware rules off too`)
      for (const rule of rules) if (LISTABLE_RULES.has(rule)) out.push(`${D} ${rule}`)
      continue
    }
    const config = new RegExp(`^\\s*${E}\\s+([\\s\\S]*)$`).exec(body)
    if (config && comment.startsWith('/*')) {
      for (const [, rule = ''] of (config[1] ?? '').matchAll(/([@\w/-]+)\s*:/g)) if (LISTABLE_RULES.has(rule)) out.push(`a configuration comment for ${rule}`)
    }
  }
  return out
}

/** The steps of build.yml's verify job, as text */
function verifyJob(): string {
  const workflow = readFileSync(join(ROOT, '.github/workflows/build.yml'), 'utf8')
  const start = workflow.indexOf('\n  verify:\n')
  const end = workflow.indexOf('\n  fail-fast:\n')
  return workflow.slice(start, end)
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

  it(
    "lists nothing main's lists do not: no new or higher line but a renamed file's own",
    () => {
      const main = mainLists(ROOT, process.env.CC_LINT_BASE ?? 'origin/main')
      if (main.kind === 'before-lists') {
        console.warn(`type-aware-lint.test.ts: main has no lists yet at ${main.base}; this change brings them`)
        return
      }
      if (main.kind !== 'lists') {
        // CI's verify job fetches main's history and sets CC_LINT_BASE: there, main's lists have to be read
        expect(process.env.CC_LINT_BASE, `main's lists: ${main.why}`).toBeUndefined()
        console.warn(`type-aware-lint.test.ts: not compared with main's lists (${main.why})`)
        return
      }
      const renames = renamesSince(ROOT, main.base)
      const added = addedSince(ROOT, main.base)
      expect(renames, `the renames since ${main.base}`).not.toBeNull()
      expect(added, `the files added since ${main.base}`).not.toBeNull()
      const raised = compareWithBase(main.lists, readAllowlist(ROOT), renames ?? [], added ?? []).filter((line) => !Object.keys(TURNED_ON).some((rule) => line.includes(` ${rule} `)))
      expect(
        raised,
        `${ALLOWLIST_DIR}/ lists more than main's lists: fix the new findings instead. Only a file git sees renamed takes ` +
          'its lines along (`pnpm lint:tighten`); code moved into another file is a new finding there.',
      ).toEqual([])
    },
    60_000 * SLOW,
  )

  it('has a weekly job lower stale lines in one pull request, with no dependency code where the write token is', () => {
    // A line above its file is not a lint failure (lintFailed), so something has to lower it
    const workflow = readFileSync(join(ROOT, '.github/workflows/lint-tighten.yml'), 'utf8')
    expect(workflow).toMatch(/schedule:\s*\n(\s*#.*\n)*\s*- cron:/)
    expect(workflow).toMatch(/^permissions: \{\}$/m)
    const tighten = workflow.slice(workflow.indexOf('\n  tighten:\n'), workflow.indexOf('\n  open:\n'))
    const open = workflow.slice(workflow.indexOf('\n  open:\n'))
    // The job that installs and runs repository code reads only, and its checkout keeps no token (#1343 review)
    expect(tighten).toMatch(/pnpm install/)
    expect(tighten).toMatch(/contents: read/)
    expect(tighten).not.toMatch(/: write/)
    expect(tighten).toMatch(/persist-credentials: false/)
    // Findings on main (1) do not stop it; a crash (2, tooling/lint-crash.ts) fails it
    expect(tighten).toMatch(/pnpm lint:tighten \|\| rc=\$\?/)
    expect(tighten).toMatch(/if \[ "\$rc" -gt 1 \]; then/)
    // The job with the write token runs nothing installed and nothing from the repository
    expect(open).toMatch(/contents: write/)
    expect(open).not.toMatch(/\bpnpm\b|\bnpm\b|\bnode\b|\btsx\b/)
    // One branch, one pull request: a week not yet landed is updated, not doubled
    expect(open).toMatch(/branch='lint-tighten\/weekly'/)
    expect(open).toMatch(/gh pr list --head "\$branch" --state open/)
  })

  it("is given main's history and made to compare in CI's verify job", () => {
    const job = verifyJob()
    expect(job).toMatch(/fetch-depth: 0/)
    expect(job).toMatch(/filter: blob:none/)
    expect(job).toMatch(/CC_LINT_BASE: origin\/main/)
    // Main's bundle is measured in the same checkout when no record of it is found: that fetch must not make it shallow
    expect(readFileSync(join(ROOT, '.github/scripts/bundle-base.mjs'), 'utf8')).toMatch(/--is-shallow-repository/)
  })

  it(
    'turns no type-aware rule off with a comment',
    () => {
      const found = scanComments(typedFiles(), readIfThere, forbiddenComments)
      expect(found, 'check the value (a zod schema, a guard) instead of switching the rule off').toEqual([])
    },
    30_000 * SLOW,
  )

  it('passes by a file that went away while it scanned, and parses only files that name eslint', () => {
    const texts: Record<string, string> = { 'a.ts': `// ${D}-next-line @typescript-eslint/no-unsafe-call\nconst a = 1`, 'b.ts': 'const b = 1' }
    const parsed: string[] = []
    const read = (file: string) => {
      if (file === 'gone.ts') return readIfThereOf(file, () => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      })
      return texts[file] ?? null
    }
    const check = (file: string, code: string) => {
      parsed.push(file)
      return forbiddenComments(file, code)
    }
    expect(scanComments(['a.ts', 'gone.ts', 'b.ts'], read, check)).toEqual([`a.ts: ${D} @typescript-eslint/no-unsafe-call`])
    expect(parsed).toEqual(['a.ts'])
    // Anything else that fails the read still fails the scan
    expect(() => readIfThereOf('x.ts', () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }) })).toThrow('EISDIR')
  })

  it('finds every comment that would switch a type-aware rule off, and only those', () => {
    const f = (code: string) => forbiddenComments('x.ts', code)
    expect(f(`// ${D}-next-line @typescript-eslint/no-non-null-assertion -- because\nconst a = 1`)).toHaveLength(1)
    expect(f(`/* ${D} no-console, @typescript-eslint/no-unsafe-member-access */\nconst a = 1`)).toHaveLength(1)
    expect(f(`// ${D}-next-line no-console,@typescript-eslint/no-unsafe-call\nconst a = 1`)).toHaveLength(1)
    expect(f(`x() // ${D}-line @typescript-eslint/no-unsafe-type-assertion`)).toHaveLength(1)
    expect(f(`/* ${D} */\nconst a = 1`)).toHaveLength(1)
    expect(f(`const a = 1\n// ${D}-next-line`)).toHaveLength(1)
    expect(f(`/* ${E} @typescript-eslint/no-floating-promises: "off" */\nconst a = 1`)).toHaveLength(1)
    expect(f(`// ${D}-next-line no-control-regex\n/* ${D} @typescript-eslint/no-explicit-any -- raw frames */\nconst a = 1`)).toEqual([])
    expect(f(`/* eslint-enable @typescript-eslint/no-non-null-assertion */\nconst a = 1`)).toEqual([])
    // Text in a string or a template is not a comment
    expect(f(`const a = '// ${D}-next-line @typescript-eslint/no-unsafe-call'\nconst b = \`/* ${D} */\``)).toEqual([])
    expect(f(`// see the ${D} rule\nconst a = 1`)).toEqual([])
  })

  it('runs ESLint on at most two threads', () => {
    // Each thread builds the whole program: six took 13.6 GB on a 12-thread PC, two 5.8 GB (#1343 review)
    expect(eslintOptions(ROOT).concurrency).toBeLessThanOrEqual(2)
    expect(readFileSync(join(ROOT, 'tooling/lint.ts'), 'utf8')).toMatch(/new ESLint\(eslintOptions\(ROOT\)\)/)
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
