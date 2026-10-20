import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ESLint, Linter } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { ALLOWLIST_DIR, applyAllowlist, formatList, parseList, readAllowlist, tighten, writeAllowlist, type Allowlist } from './lint-allowlist.js'

const ROOT = join(tmpdir(), 'lint-allowlist-root')
const UNSAFE = '@typescript-eslint/no-unsafe-type-assertion'
const BANG = '@typescript-eslint/no-non-null-assertion'

const message = (ruleId: string | null, severity: 1 | 2 = 2): Linter.LintMessage => ({ ruleId, severity, message: ruleId ?? 'parse', line: 1, column: 1 })

function result(file: string, messages: Linter.LintMessage[]): ESLint.LintResult {
  return {
    filePath: join(ROOT, file),
    messages,
    suppressedMessages: [],
    errorCount: messages.filter((m) => m.severity === 2).length,
    fatalErrorCount: 0,
    warningCount: messages.filter((m) => m.severity === 1).length,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  }
}

const list = (entries: [string, string, number][]): Allowlist => {
  const out: Allowlist = new Map()
  for (const [file, rule, n] of entries) out.set(file, (out.get(file) ?? new Map<string, number>()).set(rule, n))
  return out
}

describe('the lists', () => {
  it('read one finding count per line, skipping the header', () => {
    const text = `# header\n\npackages/a/src/x.ts ${UNSAFE} 2\npackages/a/src/x.ts ${BANG} 1\n`
    expect(parseList(text, 'packages-a.txt')).toEqual(list([['packages/a/src/x.ts', UNSAFE, 2], ['packages/a/src/x.ts', BANG, 1]]))
  })

  it('refuse a line that is not "<file> <rule> <count>", a zero, or the same file and rule twice', () => {
    expect(() => parseList('packages/a/src/x.ts 2', 'l.txt')).toThrow('l.txt:1')
    expect(() => parseList(`packages/a/src/x.ts ${UNSAFE} 0`, 'l.txt')).toThrow('l.txt:1')
    expect(() => parseList(`a.ts ${UNSAFE} 1\na.ts ${UNSAFE} 2`, 'l.txt')).toThrow('listed twice')
  })

  it('are written sorted by file, then rule', () => {
    const text = formatList(list([['b.ts', UNSAFE, 1], ['a.ts', UNSAFE, 3], ['a.ts', BANG, 2]]))
    expect(text.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([`a.ts ${BANG} 2`, `a.ts ${UNSAFE} 3`, `b.ts ${UNSAFE} 1`])
    expect(formatList(parseList(text, 'l.txt'))).toBe(text)
  })
})

describe('applying the lists', () => {
  it('takes out the findings of a file within its count', () => {
    const results = [result('packages/a/src/x.ts', [message(UNSAFE), message(UNSAFE), message(null, 1)])]
    const { over, loose } = applyAllowlist(ROOT, results, list([['packages/a/src/x.ts', UNSAFE, 3]]))
    expect(over).toEqual([])
    expect(loose).toBe(1)
    expect(results[0]?.messages.map((m) => m.severity)).toEqual([1])
    expect(results[0]?.errorCount).toBe(0)
    expect(results[0]?.warningCount).toBe(1)
  })

  it('keeps every finding of a file over its count, so the new one is shown', () => {
    const results = [result('packages/a/src/x.ts', [message(UNSAFE), message(UNSAFE), message(BANG)])]
    const { over } = applyAllowlist(ROOT, results, list([['packages/a/src/x.ts', UNSAFE, 1], ['packages/a/src/x.ts', BANG, 1]]))
    expect(over).toEqual([{ file: 'packages/a/src/x.ts', rule: UNSAFE, count: 2, allowed: 1 }])
    expect(results[0]?.messages.map((m) => m.ruleId)).toEqual([UNSAFE, UNSAFE])
    expect(results[0]?.errorCount).toBe(2)
  })

  it('leaves a rule or a file no line names, and a parse error, alone', () => {
    const results = [result('packages/a/src/x.ts', [message(BANG), message(null)]), result('packages/a/src/y.ts', [message(UNSAFE)])]
    applyAllowlist(ROOT, results, list([['packages/a/src/x.ts', UNSAFE, 1]]))
    expect(results.map((r) => r.errorCount)).toEqual([2, 1])
  })
})

describe('tightening the lists', () => {
  const allow = list([
    ['a.ts', UNSAFE, 3],
    ['a.ts', BANG, 1],
    ['b.ts', UNSAFE, 2],
    ['gone.ts', UNSAFE, 1],
    ['other.ts', UNSAFE, 4],
  ])
  const found = list([['a.ts', UNSAFE, 2], ['b.ts', UNSAFE, 5]])
  const tightened = tighten(allow, found, new Set(['a.ts', 'b.ts']), (file) => file !== 'gone.ts')

  it('lowers a line to what its file holds, and drops it at zero', () => {
    expect(tightened.get('a.ts')).toEqual(new Map([[UNSAFE, 2]]))
  })

  it('never raises a line', () => {
    expect(tightened.get('b.ts')).toEqual(new Map([[UNSAFE, 2]]))
  })

  it("drops a missing file's lines and keeps the lines of a file not linted this time", () => {
    expect(tightened.has('gone.ts')).toBe(false)
    expect(tightened.get('other.ts')).toEqual(new Map([[UNSAFE, 4]]))
  })

  it('never adds a line', () => {
    expect(tighten(new Map(), found, new Set(['a.ts', 'b.ts']), () => true).size).toBe(0)
  })
})

describe('the lists on disk', () => {
  let root = ''
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('are one file per package, and a package with nothing left loses its file', () => {
    root = mkdtempSync(join(tmpdir(), 'lint-allowlist-'))
    writeAllowlist(root, list([['packages/a/src/x.ts', UNSAFE, 1], ['apps/b/src/y.ts', BANG, 2], ['tooling/z.ts', UNSAFE, 1]]))
    expect(readdirSync(join(root, ALLOWLIST_DIR)).sort()).toEqual(['apps-b.txt', 'packages-a.txt', 'tooling.txt'])
    expect(readAllowlist(root)).toEqual(list([['apps/b/src/y.ts', BANG, 2], ['packages/a/src/x.ts', UNSAFE, 1], ['tooling/z.ts', UNSAFE, 1]]))

    writeAllowlist(root, list([['packages/a/src/x.ts', UNSAFE, 1]]))
    expect(readdirSync(join(root, ALLOWLIST_DIR))).toEqual(['packages-a.txt'])
  })

  it("refuse a line in another package's list", () => {
    root = mkdtempSync(join(tmpdir(), 'lint-allowlist-'))
    mkdirSync(join(root, ALLOWLIST_DIR), { recursive: true })
    writeFileSync(join(root, ALLOWLIST_DIR, 'packages-a.txt'), `packages/b/src/x.ts ${UNSAFE} 1\n`)
    expect(() => readAllowlist(root)).toThrow('belongs in packages-b.txt')
  })
})
