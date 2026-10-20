import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ESLint, Linter } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
import {
  ALLOWLIST_DIR,
  addedSince,
  applyAllowlist,
  baseCommit,
  compareWithBase,
  countedFiles,
  countFindings,
  disabledFindings,
  formatList,
  lintFailed,
  lintHints,
  mainLists,
  otherErrors,
  renamesSince,
  parseList,
  readAllowlist,
  tighten,
  writeAllowlist,
  type Allowlist,
} from './lint-allowlist.js'

const ROOT = join(tmpdir(), 'lint-allowlist-root')
const REPO = fileURLToPath(new URL('..', import.meta.url))
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
  it('passes a file that holds fewer than its line: two changes that each fix one there must not fail together', () => {
    // Each change tightened inbox.ts 3 to 2; merged, the file holds 1 and the line says 2 (#1343 review, LOW 3)
    const results = [result('packages/a/src/inbox.ts', [message(BANG)])]
    const { over, loose } = applyAllowlist(ROOT, results, list([['packages/a/src/inbox.ts', BANG, 2]]))
    expect(over).toEqual([])
    expect(loose).toHaveLength(1)
    expect(lintFailed({ errorsLeft: results[0]?.errorCount ?? 0, disabled: 0, recording: false, othersLeft: 0 })).toBe(false)
  })

  it('says a line is above what its file holds only for a file whose findings are known', () => {
    const broken = { ...result('packages/a/src/x.ts', [{ ...message(null), fatal: true }]), fatalErrorCount: 1 }
    expect(applyAllowlist(ROOT, [broken], list([['packages/a/src/x.ts', UNSAFE, 3]])).loose).toEqual([])
  })

  it('takes out the findings of a file within its count', () => {
    const results = [result('packages/a/src/x.ts', [message(UNSAFE), message(UNSAFE), message(null, 1)])]
    const { over, loose } = applyAllowlist(ROOT, results, list([['packages/a/src/x.ts', UNSAFE, 3]]))
    expect(over).toEqual([])
    expect(loose).toEqual([{ file: 'packages/a/src/x.ts', rule: UNSAFE, count: 2, allowed: 3 }])
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
  const found = list([['a.ts', UNSAFE, 2], ['b.ts', UNSAFE, 5], ['c.ts', BANG, 3]])
  const { allow: tightened, moves } = tighten(allow, found, new Set(['a.ts', 'b.ts', 'c.ts']), (file) => file !== 'gone.ts')

  it('lowers a line to what its file holds, and drops it at zero', () => {
    expect(tightened.get('a.ts')).toEqual(new Map([[UNSAFE, 2]]))
  })

  it("drops a missing file's lines and keeps the lines of a file not linted this time", () => {
    expect(tightened.has('gone.ts')).toBe(false)
    expect(tightened.get('other.ts')).toEqual(new Map([[UNSAFE, 4]]))
  })

  it('lends no count freed in one file to a finding in another (#1343 review)', () => {
    // a.ts and gone.ts gave up UNSAFE and BANG: b.ts keeps its line, c.ts stays unlisted, nothing moved
    expect(tightened.get('b.ts')).toEqual(new Map([[UNSAFE, 2]]))
    expect(tightened.has('c.ts')).toBe(false)
    expect(moves).toEqual([])
    // The review's probe: a `!` fixed in core, a new one in ui
    const probe = tighten(
      list([['packages/core/src/machines/vscode.ts', BANG, 2]]),
      list([['packages/core/src/machines/vscode.ts', BANG, 1], ['packages/ui/src/app/useLoad.ts', BANG, 1]]),
      new Set(['packages/core/src/machines/vscode.ts', 'packages/ui/src/app/useLoad.ts']),
      () => true,
    )
    expect(probe.allow).toEqual(list([['packages/core/src/machines/vscode.ts', BANG, 1]]))
  })

  it("moves a renamed file's lines to its new path, no more than it holds, and says so", () => {
    const renamed = tighten(
      list([['old.ts', UNSAFE, 2], ['old.ts', BANG, 3]]),
      list([['new.ts', UNSAFE, 2], ['new.ts', BANG, 1]]),
      new Set(['new.ts']),
      (file) => file === 'new.ts',
      [{ from: 'old.ts', to: 'new.ts' }],
    )
    expect(renamed.allow).toEqual(list([['new.ts', UNSAFE, 2], ['new.ts', BANG, 1]]))
    expect(renamed.moves).toEqual([
      { from: 'old.ts', to: 'new.ts', rule: UNSAFE, count: 2 },
      { from: 'old.ts', to: 'new.ts', rule: BANG, count: 1 },
    ])
  })

  it('counts only the files whose findings are known: not one that failed to parse, or one ESLint ignored', () => {
    const broken = { ...result('packages/a/src/broken.ts', [{ ...message(null), fatal: true }]), fatalErrorCount: 1 }
    const ignored = result('packages/a/src/ignored.ts', [{ ...message(null, 1), message: 'File ignored because of a matching ignore pattern.' }])
    const counted = countedFiles(ROOT, [broken, ignored, result('packages/a/src/fine.ts', [])])
    expect([...counted]).toEqual(['packages/a/src/fine.ts'])
    // So a file that does not parse for now keeps its lines
    const kept = tighten(list([['packages/a/src/broken.ts', UNSAFE, 2]]), list([['packages/a/src/fine.ts', UNSAFE, 2]]), counted, () => true).allow
    expect(kept).toEqual(list([['packages/a/src/broken.ts', UNSAFE, 2]]))
  })

  it('adds no line', () => {
    expect(tighten(new Map(), found, new Set(['a.ts', 'b.ts']), () => true).allow.size).toBe(0)
  })
})

describe("the lists against main's", () => {
  const main = list([
    ['a.ts', UNSAFE, 2],
    ['b.ts', UNSAFE, 1],
  ])

  it('let a line go down or away, or stay above its file', () => {
    expect(compareWithBase(main, list([['a.ts', UNSAFE, 1]]))).toEqual([])
    expect(compareWithBase(main, main)).toEqual([])
  })

  it('refuse a line listed by hand, by a regenerated list, or with a count freed elsewhere (#1343 review)', () => {
    // A finding fixed in a.ts does not pay for one in c.ts, though the rule's total is the same
    expect(compareWithBase(main, list([['a.ts', UNSAFE, 1], ['b.ts', UNSAFE, 1], ['c.ts', UNSAFE, 1]]))).toEqual([`c.ts ${UNSAFE} 1 (main: 0)`])
    // Fixed and tightened on main, then listed by hand later
    expect(compareWithBase(list([['a.ts', UNSAFE, 1]]), list([['a.ts', UNSAFE, 1], ['clock.ts', BANG, 1]]))).toEqual([`clock.ts ${BANG} 1 (main: 0)`])
    expect(compareWithBase(main, list([['a.ts', UNSAFE, 3], ['b.ts', UNSAFE, 1]]))).toEqual([`a.ts ${UNSAFE} 3 (main: 2)`])
  })

  it('give a file this change adds nothing, even where main has a stale line for a file once deleted there (#1343 review)', () => {
    const stale = list([['P.ts', UNSAFE, 5]])
    expect(compareWithBase(stale, list([['P.ts', UNSAFE, 5]]), [], ['P.ts'])).toEqual([`P.ts ${UNSAFE} 5 (main: 0)`])
    // A file that was there all along keeps its line
    expect(compareWithBase(stale, list([['P.ts', UNSAFE, 5]]), [], [])).toEqual([])
    // A rename onto that path brings its own lines, not the stale ones on top
    expect(compareWithBase(list([['a.ts', UNSAFE, 1], ['P.ts', UNSAFE, 5]]), list([['P.ts', UNSAFE, 6]]), [{ from: 'a.ts', to: 'P.ts' }])).toEqual([
      `P.ts ${UNSAFE} 6 (main: 1)`,
    ])
  })

  it("let a renamed file's lines follow it, and only those, and not twice", () => {
    const renames = [{ from: 'b.ts', to: 'c.ts' }]
    expect(compareWithBase(main, list([['a.ts', UNSAFE, 2], ['c.ts', UNSAFE, 1]]), renames)).toEqual([])
    expect(compareWithBase(main, list([['c.ts', UNSAFE, 2]]), renames)).toEqual([`c.ts ${UNSAFE} 2 (main: 1)`])
    // A deleted (renamed-away) file's line left behind lends nothing: it is compared with nothing
    expect(compareWithBase(main, list([['b.ts', UNSAFE, 1], ['c.ts', UNSAFE, 1]]), renames)).toEqual([`b.ts ${UNSAFE} 1 (main: 0)`])
  })
})

describe("main's lists", () => {
  let repo = ''
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const commit = (message: string) => {
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')
  }
  /** A repository whose main has the module and a list, and a branch off it */
  function setUp(): string {
    repo = mkdtempSync(join(tmpdir(), 'lint-main-'))
    git(repo, 'init', '-q', '-b', 'main')
    write('README', 'before the lists\n')
    commit('before')
    write('tooling/lint-allowlist.ts', '// the module\n')
    write(`${ALLOWLIST_DIR}/packages-a.txt`, formatList(list([['packages/a/src/x.ts', UNSAFE, 2]])))
    const withLists = commit('lists')
    git(repo, 'checkout', '-q', '-b', 'feature')
    return withLists
  }

  it('are read at the merge base, also when main moved on and HEAD is a merge of the two (a pull request)', () => {
    const base = setUp()
    write(`${ALLOWLIST_DIR}/packages-a.txt`, formatList(list([['packages/a/src/x.ts', UNSAFE, 3]])))
    commit('raise on the branch')
    git(repo, 'checkout', '-q', 'main')
    write('later.txt', 'main moved on\n')
    commit('main later')
    git(repo, 'checkout', '-q', 'feature')
    // What lists more than main is told apart from what main has
    const onBranch = mainLists(repo, 'main')
    expect(onBranch).toEqual({ kind: 'lists', base, lists: list([['packages/a/src/x.ts', UNSAFE, 2]]) })
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'main')
    expect(mainLists(repo, 'main')).toMatchObject({ kind: 'lists', lists: list([['packages/a/src/x.ts', UNSAFE, 2]]) })
  }, 60_000 * SLOW)

  it('are read at the parent when HEAD is main itself (a push to main)', () => {
    const base = setUp()
    git(repo, 'checkout', '-q', 'main')
    write(`${ALLOWLIST_DIR}/packages-a.txt`, formatList(list([['packages/a/src/x.ts', UNSAFE, 1]])))
    commit('lower on main')
    expect(mainLists(repo, 'main')).toEqual({ kind: 'lists', base, lists: list([['packages/a/src/x.ts', UNSAFE, 2]]) })
  }, 60_000 * SLOW)

  it('are none before the module existed, and empty once it does and every list is gone', () => {
    setUp()
    git(repo, 'checkout', '-q', 'main')
    const before = git(repo, 'rev-parse', 'HEAD~1')
    git(repo, 'checkout', '-q', '-b', 'old', before)
    write('x.txt', 'a change before the lists\n')
    commit('old branch')
    expect(mainLists(repo, 'main')).toEqual({ kind: 'before-lists', base: before })
    git(repo, 'checkout', '-q', 'main')
    rmSync(join(repo, ALLOWLIST_DIR), { recursive: true })
    const empty = commit('every list fixed')
    git(repo, 'checkout', '-q', '-b', 'after')
    write('y.txt', 'a change after\n')
    commit('after branch')
    expect(mainLists(repo, 'main')).toEqual({ kind: 'lists', base: empty, lists: new Map() })
  }, 60_000 * SLOW)

  it("tell a pull request's renames and added files from its merge commit, not main's (a merge ref)", () => {
    setUp()
    write('packages/a/src/mine.ts', 'export const m = 1\nexport const n = 2\nexport const o = 3\n')
    write('packages/a/src/theirs.ts', 'export const t = 1\nexport const u = 2\nexport const v = 3\n')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'checkout', '-q', 'feature', '--', '.')
    commit('both files on main')
    git(repo, 'checkout', '-q', 'feature')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'main')
    git(repo, 'mv', 'packages/a/src/mine.ts', 'packages/a/src/mine-renamed.ts')
    write('packages/a/src/new.ts', 'export const added = 1\n')
    commit('the branch renames one and adds one')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'mv', 'packages/a/src/theirs.ts', 'packages/a/src/theirs-renamed.ts')
    commit('main renames another after the branch point')
    git(repo, 'checkout', '-q', 'feature')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'main')
    const base = baseCommit(repo, 'main')
    expect(base).toBe(git(repo, 'rev-parse', 'main'))
    expect(renamesSince(repo, base ?? '')).toEqual([{ from: 'packages/a/src/mine.ts', to: 'packages/a/src/mine-renamed.ts' }])
    expect(addedSince(repo, base ?? '')).toEqual(['packages/a/src/new.ts'])
  }, 60_000 * SLOW)

  it('tell the renames since the base, committed or only staged, and nothing else as one', () => {
    const base = setUp()
    write('packages/a/src/old.ts', 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
    write('packages/a/src/kept.ts', 'export const k = 1\n')
    commit('two files')
    const withFiles = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'mv', 'packages/a/src/old.ts', 'packages/a/src/new.ts')
    commit('rename')
    expect(renamesSince(repo, withFiles)).toEqual([{ from: 'packages/a/src/old.ts', to: 'packages/a/src/new.ts' }])
    git(repo, 'mv', 'packages/a/src/kept.ts', 'packages/a/src/moved.ts')
    expect(renamesSince(repo, withFiles)).toEqual([
      { from: 'packages/a/src/kept.ts', to: 'packages/a/src/moved.ts' },
      { from: 'packages/a/src/old.ts', to: 'packages/a/src/new.ts' },
    ])
    // A new file is not a rename
    expect(renamesSince(repo, base)?.some((r) => r.to === 'packages/a/src/new.ts')).toBe(false)
  }, 60_000 * SLOW)

  it('are not there to read in a shallow checkout without main', () => {
    setUp()
    const clone = mkdtempSync(join(tmpdir(), 'lint-main-clone-'))
    try {
      git(clone, 'clone', '-q', '--depth', '1', '--branch', 'feature', `file://${repo.split('\\').join('/')}`, 'c')
      expect(mainLists(join(clone, 'c'), 'origin/main')).toMatchObject({ kind: 'no-base' })
    } finally {
      rmSync(clone, { recursive: true, force: true })
    }
  }, 60_000 * SLOW)
})

describe('the lint run', () => {
  it('exits 2 on a crash, apart from findings (1), so the weekly job can tell them apart', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', join(REPO, 'tooling/lint.ts'), '--no-such-option'], { cwd: REPO, encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('--no-such-option')
  }, 60_000 * SLOW)

  it('fails on what is left or an eslint-disable; --record-all only on what it could not list', () => {
    const run = { errorsLeft: 0, disabled: 0, recording: false, othersLeft: 0 }
    expect(lintFailed(run)).toBe(false)
    expect(lintFailed({ ...run, errorsLeft: 1 })).toBe(true)
    expect(lintFailed({ ...run, disabled: 1 })).toBe(true)
    expect(lintFailed({ ...run, recording: true, errorsLeft: 0, othersLeft: 0 })).toBe(false)
    expect(lintFailed({ ...run, recording: true, othersLeft: 1 })).toBe(true)
  })

  it('names errorMessage for `(e as Error)`, eslint --fix for an unnecessary assertion, and lint:tighten for moved code', () => {
    const asError = { ...message(UNSAFE), message: "Unsafe type assertion: type 'Error' is more narrow than the original type" }
    const hints = lintHints([asError, message('@typescript-eslint/no-unnecessary-type-assertion')]).join('\n')
    expect(hints).toContain('errorMessage(e)')
    expect(hints).toContain('eslint --fix')
    expect(hints).toContain('pnpm lint:tighten')
    expect(lintHints([message('no-console')])).toEqual([])
  })

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
