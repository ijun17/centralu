import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ESLint, Linter } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWLIST_DIR,
  applyAllowlist,
  compareWithBase,
  countedFiles,
  countFindings,
  disabledFindings,
  formatList,
  otherErrors,
  parseList,
  readAllowlist,
  tighten,
  writeAllowlist,
  type Allowlist,
} from './lint-allowlist.js'

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

  it('name only the type-aware rules, which were not errors before', () => {
    expect(() => parseList('packages/a/src/x.ts react-hooks/rules-of-hooks 1', 'l.txt')).toThrow('not a type-aware rule')
    expect(() => parseList('packages/a/src/x.ts @typescript-eslint/no-explicit-any 1', 'l.txt')).toThrow('not a type-aware rule')
    const results = [result('packages/a/src/x.ts', [message('boundaries/element-types'), message(UNSAFE)])]
    expect(countFindings(ROOT, results)).toEqual(list([['packages/a/src/x.ts', UNSAFE, 1]]))
  })

  it('refuse a path with a space, which a line could not hold', () => {
    expect(() => formatList(list([['packages/a/src/my file.ts', UNSAFE, 1]]))).toThrow('my file.ts')
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
  const found = list([['a.ts', UNSAFE, 2], ['b.ts', UNSAFE, 5], ['c.ts', BANG, 3], ['d.ts', '@typescript-eslint/no-floating-promises', 1]])
  const tightened = tighten(allow, found, new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']), (file) => file !== 'gone.ts')

  it('lowers a line to what its file holds, and drops it at zero', () => {
    expect(tightened.get('a.ts')).toEqual(new Map([[UNSAFE, 2]]))
  })

  it("drops a missing file's lines and keeps the lines of a file not linted this time", () => {
    expect(tightened.has('gone.ts')).toBe(false)
    expect(tightened.get('other.ts')).toEqual(new Map([[UNSAFE, 4]]))
  })

  it('moves what a rule gave up to where its findings went, never more, and never to another rule', () => {
    // a.ts and gone.ts gave up two of UNSAFE: b.ts holds three more than its line, and takes those two
    expect(tightened.get('b.ts')).toEqual(new Map([[UNSAFE, 4]]))
    // a.ts gave up one of BANG: c.ts, unlisted, takes it
    expect(tightened.get('c.ts')).toEqual(new Map([[BANG, 1]]))
    // Nothing gave up a floating promise
    expect(tightened.has('d.ts')).toBe(false)
    const total = (l: Allowlist, rule: string) => [...l.values()].reduce((n, r) => n + (r.get(rule) ?? 0), 0)
    for (const rule of [UNSAFE, BANG]) expect(total(tightened, rule)).toBeLessThanOrEqual(total(allow, rule))
  })

  it('moves the lines of a renamed file to its new path', () => {
    const renamed = tighten(list([['old.ts', UNSAFE, 2]]), list([['new.ts', UNSAFE, 2]]), new Set(['new.ts']), (file) => file === 'new.ts')
    expect(renamed).toEqual(list([['new.ts', UNSAFE, 2]]))
  })

  it('counts only the files whose findings are known: not one that failed to parse, or one ESLint ignored', () => {
    const broken = { ...result('packages/a/src/broken.ts', [{ ...message(null), fatal: true }]), fatalErrorCount: 1 }
    const ignored = result('packages/a/src/ignored.ts', [{ ...message(null, 1), message: 'File ignored because of a matching ignore pattern.' }])
    const counted = countedFiles(ROOT, [broken, ignored, result('packages/a/src/fine.ts', [])])
    expect([...counted]).toEqual(['packages/a/src/fine.ts'])
    // So a file that does not parse for now keeps its lines, and gives up nothing to move elsewhere
    const kept = tighten(list([['packages/a/src/broken.ts', UNSAFE, 2]]), list([['packages/a/src/fine.ts', UNSAFE, 2]]), counted, () => true)
    expect(kept).toEqual(list([['packages/a/src/broken.ts', UNSAFE, 2]]))
  })

  it('adds no line when nothing was given up', () => {
    expect(tighten(new Map(), found, new Set(['a.ts', 'b.ts']), () => true).size).toBe(0)
  })
})

describe("the lists against main's", () => {
  const main = list([
    ['a.ts', UNSAFE, 2],
    ['b.ts', UNSAFE, 1],
  ])

  it('let a line go down or away', () => {
    expect(compareWithBase(main, list([['a.ts', UNSAFE, 1]]))).toEqual({ raised: [], grown: [] })
  })

  it('let a count move to another file when the rule does not total more', () => {
    const moved = compareWithBase(main, list([['a.ts', UNSAFE, 1], ['b.ts', UNSAFE, 1], ['c.ts', UNSAFE, 1]]))
    expect(moved).toEqual({ raised: [`c.ts ${UNSAFE} 1 (main: 0)`], grown: [] })
  })

  it('refuse a line listed by hand or by a regenerated list, wherever it is (#1343 review)', () => {
    // The review's case: one fixed and tightened on main, then a new finding listed by hand later
    const later = compareWithBase(list([['a.ts', UNSAFE, 1]]), list([['a.ts', UNSAFE, 1], ['clock.ts', BANG, 1]]))
    expect(later.grown).toEqual([`${BANG}: 1, main 0`])
    expect(compareWithBase(main, list([['a.ts', UNSAFE, 3], ['b.ts', UNSAFE, 1]])).grown).toEqual([`${UNSAFE}: 4, main 3`])
  })
})

describe('the lint run', () => {
  it('names a finding of a type-aware rule an eslint-disable comment hid, not one of another rule or a file-level suppression', () => {
    const hidden = (ruleId: string, kind: string) => ({ ...message(ruleId), line: 7, suppressions: [{ kind, justification: '' }] })
    const r = { ...result('packages/a/src/x.ts', []), suppressedMessages: [hidden(BANG, 'directive'), hidden('no-console', 'directive'), hidden(UNSAFE, 'file')] }
    expect(disabledFindings(ROOT, [r])).toEqual([{ file: 'packages/a/src/x.ts', line: 7, rule: BANG }])
  })

  it('counts the errors --record-all cannot list: other rules, and files that failed to parse', () => {
    const results = [result('packages/a/src/x.ts', [message(UNSAFE), message('@typescript-eslint/no-unused-vars'), message(null), message('no-console', 1)])]
    expect(otherErrors(results)).toBe(2)
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
