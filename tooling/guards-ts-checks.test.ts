/**
 * The second set of `guard/*` lint rules (tooling/eslint-guards-ts.js): guards that were unit tests parsing every source
 * file of a folder with the TypeScript API (#1607). Each is tried on virtual files, as tooling/guards-checks.test.ts does
 * for the first set.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ARCHIVE_ALLOWED } from './guard-exceptions.js'
import { archiveUses, ASSERTIONS, assertionsOf, assertionTotals, lintFailed, overAndUnder, tightenAssertions, unusedArchiveEntries } from './lint-allowlist.js'
import { guardLinter, virtualFileLinter } from './eslint-virtual.test-helpers.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = guardLinter()
const NL = '\n'
// Built, so that this file's own examples are not comments the rule below reads
const D = 'eslint' + '-disable'
const E = 'eslint'

async function lines(file: string, code: string, rule: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file), warnIgnored: false })
  return (result?.messages ?? []).filter((m) => m.ruleId === `guard/${rule}`).map((m) => m.line)
}
async function messages(file: string, code: string, rule: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file), warnIgnored: false })
  return (result?.messages ?? []).filter((m) => m.ruleId === `guard/${rule}`).map((m) => m.message)
}
/** `code` is quiet, and the same file with `positive` after it reports only that line (so a case that is not reported fails without the rule) */
async function quiet(file: string, rule: string, code: string, positive: string) {
  expect(await lines(file, code + NL + positive, rule)).toEqual([code.split(NL).length + 1])
}

describe('guard/archive-wording', () => {
  const file = 'packages/ui/src/features/x.tsx'
  it.each([
    ["const a = 'Moved to the trash'"],
    ['const a = `${x} went to the trash`'],
    ['const a = <p>Empty trash…</p>'],
    ['const a = <button title="Move to trash" />'],
    ["const a = { label: 'Trashed items' }"],
  ])('reports %s', async (code) => {
    expect(await lines(file, code, 'archive-wording')).toEqual([1])
  })
  it.each([
    [`// the trash${NL}const a = 1`],
    ['const a = <i data-testid="trash-list" />'],
    ['const a = <i data-testid={`trash-row-${id}`} />'],
    ['const trash = 1'],
    ["import { x } from './trash.js'"],
    ["export { y } from './trash.js'"],
    ["type A = 'trash' | 'x'"],
    ["const a = 'the session archive'"],
  ])('does not report %s', async (code) => {
    await quiet(file, 'archive-wording', code, "const a = 'trash'")
  })
  it('lets the allowed part of a text through and not the rest of it', async () => {
    const tree = 'packages/ui/src/features/files/FileTree.tsx'
    expect(await lines(tree, "const a = 'Move to Trash'", 'archive-wording')).toEqual([])
    expect(await lines(tree, "const a = 'Move to Trash, or empty the trash'", 'archive-wording')).toEqual([1])
    const host = 'packages/agent-host/src/apps/external/x.ts'
    expect(await lines(host, "const a = 'its folder is in app-trash/'", 'archive-wording')).toEqual([])
    expect(await lines(host, "const a = 'its folder is in app-trash/, not in the trash'", 'archive-wording')).toEqual([1])
    const store = 'packages/agent-host/src/dev-services/store/x.ts'
    expect(await lines(store, "const q = 'UPDATE sessions SET trash = ? WHERE id = ?'", 'archive-wording')).toEqual([])
    expect(await lines(store, "const q = 'UPDATE sessions SET trash = ? -- the trash'", 'archive-wording')).toEqual([1])
  })
  it('says which entries a run used, so that pnpm lint can tell one no file uses', async () => {
    const run = async (files: Record<string, string>) => {
      const results = await Promise.all(Object.entries(files).map(async ([file, code]) => (await eslint.lintText(code, { filePath: join(ROOT, file), warnIgnored: false }))[0]!))
      return archiveUses(results)
    }
    const index = (text: string) => ARCHIVE_ALLOWED.findIndex((a) => a.text === text)
    const tree = index('\\bto (the )?Trash\\b')
    const bin = index('\\bapp-trash\\b')
    expect(tree).toBeGreaterThanOrEqual(0)
    expect(bin).toBeGreaterThanOrEqual(0)
    // An entry for one file is used by that file's text; one for many files by any file's
    const used = await run({ 'packages/ui/src/features/files/FileTree.tsx': "const a = 'Move to Trash'", 'packages/agent-host/src/apps/external/x.ts': "const a = 'its folder is in app-trash/'" })
    expect(used.has(tree)).toBe(true)
    expect(used.has(bin)).toBe(true)
    // The file renamed (the entry's path matches nothing) or no longer saying it: the entry is used by no file
    const gone = await run({ 'packages/ui/src/features/files/FileTreeRenamed.tsx': "const a = 'Move to Trash'", 'packages/agent-host/src/x.ts': 'const a = 1' })
    expect(gone.has(tree)).toBe(false)
    expect(gone.has(bin)).toBe(false)
    expect(unusedArchiveEntries(gone).some((line) => line.includes('the OS bin that "Move to Trash" in the file tree uses'))).toBe(true)
    expect(unusedArchiveEntries(new Set(ARCHIVE_ALLOWED.keys()))).toEqual([])
    // A run that finds an unused entry fails, as one over an assertion ceiling does
    expect(lintFailed({ errorsLeft: 0, disabled: 0, recording: false, othersLeft: 0, archiveStale: 1 })).toBe(true)
    expect(lintFailed({ errorsLeft: 0, disabled: 0, recording: false, othersLeft: 0, archiveStale: 0 })).toBe(false)
  })
  it('does not show the uses as findings: they are warnings the run takes out', async () => {
    const [result] = await eslint.lintText("const a = 'Move to Trash'", { filePath: join(ROOT, 'packages/ui/src/features/files/FileTree.tsx'), warnIgnored: false })
    expect(result?.messages.map((m) => [m.ruleId, m.severity])).toEqual([['guard/archive-allowed-used', 1]])
    archiveUses(result ? [result] : [])
    expect(result?.messages).toEqual([])
    expect(result?.warningCount).toBe(0)
  })
  it('reads the texts of the four packages, and not tests or helpers', async () => {
    const code = "const a = 'trash'"
    const found = Object.fromEntries(
      await Promise.all(
        ['packages/ui/src/x.ts', 'packages/platform/src/x.ts', 'packages/protocol/src/x.ts', 'packages/agent-host/src/x.ts', 'packages/ui/src/x.test.tsx', 'packages/agent-host/src/x.test-helpers.ts', 'packages/core/src/x.ts', 'apps/web/src/x.ts'].map(
          async (f) => [f, await lines(f, code, 'archive-wording')] as const,
        ),
      ),
    )
    expect(found).toEqual({
      'packages/ui/src/x.ts': [1],
      'packages/platform/src/x.ts': [1],
      'packages/protocol/src/x.ts': [1],
      'packages/agent-host/src/x.ts': [1],
      'packages/ui/src/x.test.tsx': [],
      'packages/agent-host/src/x.test-helpers.ts': [],
      'packages/core/src/x.ts': [],
      'apps/web/src/x.ts': [],
    })
  })
})

describe('guard/hand-made-looks', () => {
  const file = 'packages/ui/src/features/x.tsx'
  const looks = async (code: string) => (await messages(file, code, 'hand-made-looks')).map((m) => /draws the (\w+) look/.exec(m)?.[1])

  it('a framed button: a <button> with border and a radius', async () => {
    expect(await looks('const a = <button className="rounded-md border border-line px-2 text-xs">x</button>')).toEqual(['button'])
    expect(await looks('const a = <button className={`rounded-lg border ${on ? "a" : "b"}`}>x</button>')).toEqual(['button'])
    // A border only on hover, one side only, or no radius is not the framed button
    expect(await looks('const a = <button className="rounded-md hover:border px-2">x</button>')).toEqual([])
    expect(await looks('const a = <button className="rounded-md border-b border-line">x</button>')).toEqual([])
    expect(await looks('const a = <button className="border border-line">x</button>')).toEqual([])
    expect(await looks('const a = <div className="rounded-md border border-line">x</div>')).toEqual([])
  })
  it('reads a class string through a let or var of the same file too, as the old scan followed any name', async () => {
    expect(await looks('let cls = "rounded-md border px-2"' + NL + 'const A = () => <button className={cls}>x</button>')).toEqual(['button'])
    expect(await looks('var cls = "rounded-md border px-2"' + NL + 'const A = () => <button className={cls}>x</button>')).toEqual(['button'])
  })
  it('reads a class string through a const of the same file and through every branch of a ternary', async () => {
    expect(await looks('const cls = "rounded-md border px-2"' + NL + 'const A = () => <button className={cls}>x</button>')).toEqual(['button'])
    expect(await looks('const A = () => <button className={on ? "rounded-md" : "border"}>x</button>')).toEqual(['button'])
    expect(await looks('const a = <button className={cn("rounded-md", on && "border")}>x</button>')).toEqual(['button'])
  })
  it('a framed text field: an <input> with a border, unless it is a swatch or a box to tick', async () => {
    expect(await looks('const a = <input className="w-full rounded-md border border-line" />')).toEqual(['input'])
    expect(await looks('const a = <input type="text" className="border" />')).toEqual(['input'])
    expect(await looks('const a = <input type="color" className="h-5 w-8 rounded-sm border" />')).toEqual([])
    expect(await looks('const a = <input type="checkbox" className="border" />')).toEqual([])
    expect(await looks('const a = <input className="min-w-0 flex-1 bg-transparent outline-none" />')).toEqual([])
  })
  it('a small caps label: text-2xs with uppercase, on any element', async () => {
    expect(await looks('const a = <h3 className="readout text-2xs uppercase text-ink-faint">x</h3>')).toEqual(['badge'])
    expect(await looks('const a = <span className="text-2xs text-ink-faint">x</span>')).toEqual([])
    expect(await looks('const a = <span className="text-xs uppercase">x</span>')).toEqual([])
  })
  it('a capsule: rounded-full with a border, on any element', async () => {
    expect(await looks('const a = <span className="flex h-7 rounded-full border px-2.5">x</span>')).toEqual(['capsule'])
    expect(await looks('const a = <span className="size-2 rounded-full bg-ink">x</span>')).toEqual([])
  })
  it('does not count the shared components themselves at their call sites', async () => {
    await quiet(file, 'hand-made-looks', 'const a = <Button variant="quiet" className="mt-2">x</Button>' + NL + 'const b = <TextInput size="sm" className="w-full" />', 'const c = <span className="rounded-full border">x</span>')
  })
  it('names the component to use, and reads the screens, not the shared components or tests', async () => {
    const code = 'const a = <span className="rounded-full border">x</span>'
    expect(await messages(file, code, 'hand-made-looks')).toEqual([expect.stringContaining('Pill (components/Pill.tsx)')])
    const found = Object.fromEntries(
      await Promise.all(['packages/ui/src/components/Pill.tsx', 'packages/ui/src/features/x.test.tsx', 'packages/ui/src/features/y.tsx', 'apps/web/src/x.tsx'].map(async (f) => [f, await lines(f, code, 'hand-made-looks')] as const)),
    )
    expect(found).toEqual({ 'packages/ui/src/components/Pill.tsx': [], 'packages/ui/src/features/x.test.tsx': [], 'packages/ui/src/features/y.tsx': [1], 'apps/web/src/x.tsx': [] })
  })
  it('lets a listed file hold its counts: more fails with every one of that kind, fewer says the line is stale', async () => {
    // GridButton.tsx: one framed button (a sidebar tile). A framed button is not a capsule unless it is rounded-full
    const intro = 'packages/ui/src/features/sidebar/GridButton.tsx'
    const one = 'const a = <button className="rounded-md border">x</button>'
    expect(await lines(intro, one, 'hand-made-looks')).toEqual([])
    expect(await lines(intro, one + NL + one, 'hand-made-looks')).toEqual([1, 2])
    expect(await messages(intro, 'const a = 1', 'hand-made-looks')).toEqual([expect.stringContaining('lists 1 button here, 0 found')])
    // A kind that is not listed for the file is not let through
    expect(await lines(intro, one + NL + 'const b = <span className="rounded-md border uppercase text-2xs">x</span>', 'hand-made-looks')).toEqual([2])
  })
})

describe('guard/type-assertions', () => {
  const count = async (file: string, code: string) => (await lines(file, code, 'type-assertions')).length
  it('counts what it says it counts', async () => {
    const file = 'packages/core/src/x.ts'
    expect(await count(file, 'const a = b as string; const c = <number>d; const e = f as unknown as G')).toBe(4)
    expect(await count(file, "const a = ['x'] as const; // b as string" + NL + "const s = 'c as D'")).toBe(0)
    expect(await count('packages/ui/src/x.tsx', 'const a = <div>{b as string}</div>')).toBe(1)
  })
  it('counts shipped code only', async () => {
    const code = 'const a = b as string'
    expect(await count('packages/core/src/x.test.ts', code)).toBe(0)
    expect(await count('packages/core/src/x.test-helpers.ts', code)).toBe(0)
    expect(await count('e2e/x.ts', code)).toBe(0)
    expect(await count('apps/web/src/x.ts', code)).toBe(1)
    // An .mts source counts too, as the old counter read it
    expect(await count('packages/agent-host/src/x.mts', code)).toBe(1)
  })
  it('cannot be hidden by a comment: twelve assertions stay twelve', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `const a${i} = b as string`).join(NL)
    const file = 'packages/ui/src/x.ts'
    expect(await count(file, twelve)).toBe(12)
    for (const comment of ['/* eslint guard/type-assertions: off */', '/* eslint-disable guard/type-assertions */', '/* eslint-disable */', '/* eslint "guard/type-assertions": "off" */']) {
      const [result] = await eslint.lintText(comment + NL + twelve, { filePath: join(ROOT, file), warnIgnored: false })
      expect(result?.messages.filter((m) => m.ruleId === 'guard/type-assertions'), comment).toHaveLength(12)
      expect(result?.suppressedMessages, comment).toEqual([])
      // The run's total, as tooling/lint.ts takes it
      expect(assertionTotals(ROOT, result ? [result] : []), comment).toEqual({ 'packages/ui': 12 })
    }
    // Also with the comment in the middle of a JSX child, and the assertions in JSX
    const jsx = ['export const A = () => (', '  <div>', '    {/* eslint guard/type-assertions: off */}', '    {x as string}{y as string}', '  </div>', ')'].join(NL)
    expect(await count('packages/ui/src/x.tsx', jsx)).toBe(2)
  })
  it('totals the findings of a run by package and takes them out of what it shows', () => {
    const message = (ruleId: string) => ({ ruleId, severity: 1, message: 'm', line: 1, column: 1 })
    const result = (file: string, ruleIds: string[]) => ({ filePath: join(ROOT, file), messages: ruleIds.map(message), suppressedMessages: [], errorCount: 0, fatalErrorCount: 0, warningCount: ruleIds.length, fixableErrorCount: 0, fixableWarningCount: 0, usedDeprecatedRules: [] })
    const results = [result('packages/ui/src/a.ts', ['guard/type-assertions', 'guard/type-assertions', 'no-console']), result('packages/ui/src/b.ts', ['guard/type-assertions']), result('apps/web/src/c.ts', ['guard/type-assertions'])]
    expect(assertionTotals(ROOT, results as never)).toEqual({ 'packages/ui': 3, 'apps/web': 1 })
    expect(results[0]?.messages.map((m) => m.ruleId)).toEqual(['no-console'])
    expect(results[0]?.warningCount).toBe(1)
    expect(results[1]?.messages).toEqual([])
  })
  it('reports a package over its ceiling, with no room, and only that', () => {
    expect(overAndUnder({ a: 3, b: 1, c: 2 }, { a: 2, b: 2 })).toEqual({ over: ['a: 3, ceiling 2', 'c: 2, ceiling 0'], under: ['b: 1'] })
    // One over fails: the ceiling is what the package holds
    expect(overAndUnder({ a: 2 }, { a: 2 })).toEqual({ over: [], under: [] })
    expect(overAndUnder({ a: 3 }, { a: 2 }).over).toEqual(['a: 3, ceiling 2'])
    expect(Object.keys(ASSERTIONS).length).toBe(7)
  })
  it("holds the ceilings at what the packages hold today, with no room above them", () => {
    // Today's counts: pnpm lint says where they can come down, and fails one over
    expect(ASSERTIONS).toEqual({ 'apps/desktop': 4, 'apps/web': 6, 'packages/agent-host': 529, 'packages/core': 1, 'packages/platform': 3, 'packages/protocol': 0, 'packages/ui': 255 })
    expect(readFileSync(join(ROOT, 'tooling/lint-allowlist.ts'), 'utf8')).not.toMatch(/ASSERTION_ROOM/)
  })
  it('lowers a ceiling to what its package holds, as pnpm lint:tighten writes it, and never raises one', () => {
    const source = ["export const ASSERTIONS: Readonly<Record<string, number>> = {", "  'packages/ui': 5,", "  'a/b': 3,", "  'c/d': 2,", '}', "export const OTHER = { 'packages/ui': 9 }"].join(NL)
    const lowered = tightenAssertions(source, { 'packages/ui': 4, 'a/b': 3, 'c/d': 7 })
    expect(lowered).toBe(source.replace("'packages/ui': 5", "'packages/ui': 4"))
    // A package that holds none comes down to 0; nothing else in the module is touched
    expect(tightenAssertions(source, {})).toContain("  'a/b': 0,")
    expect(tightenAssertions(source, {})).toContain("OTHER = { 'packages/ui': 9 }")
    // The module's own ceilings, held at what the packages hold, stay as they are
    const own = readFileSync(join(ROOT, 'tooling/lint-allowlist.ts'), 'utf8')
    expect(tightenAssertions(own, ASSERTIONS)).toBe(own)
  })
  it('reads the ceilings out of a copy of lint-allowlist.ts, as the compare with main needs', () => {
    const source = ["export const ASSERTIONS: Readonly<Record<string, number>> = {", "  'packages/ui': 5,", "  'a/b': 3,", '}'].join(NL)
    expect(assertionsOf(source)).toEqual({ 'packages/ui': 5, 'a/b': 3 })
    expect(assertionsOf('nothing here')).toBeNull()
    // The module itself says what it says
    expect(assertionsOf(readFileSync(join(ROOT, 'tooling/lint-allowlist.ts'), 'utf8'))).toEqual(ASSERTIONS)
  })
})

describe('guard/no-rule-switch-comments', () => {
  // A .tsx file, so that a JSX comment parses
  const file = 'packages/ui/src/x.tsx'
  const found = async (code: string) => {
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, file), warnIgnored: false })
    // The pass reads no comment as configuration: nothing, not even a blanket eslint-disable, hides the finding
    expect(result?.suppressedMessages).toEqual([])
    return (result?.messages ?? []).filter((m) => m.ruleId === 'guard/no-rule-switch-comments').map((m) => m.line)
  }
  it.each([
    [`// ${D}-next-line @typescript-eslint/no-non-null-assertion -- because${NL}const a = 1`],
    [`/* ${D} no-console, @typescript-eslint/no-unsafe-member-access */${NL}const a = 1`],
    [`// ${D}-next-line no-console,@typescript-eslint/no-unsafe-call${NL}const a = 1`],
    [`x() // ${D}-line @typescript-eslint/no-unsafe-type-assertion`],
    [`/* ${D} */${NL}const a = 1`],
    [`const a = 1${NL}// ${D}-next-line`],
    [`/* ${E} @typescript-eslint/no-floating-promises: "off" */${NL}const a = 1`],
    [`/* ${E} "@typescript-eslint/no-floating-promises": "off" */${NL}const a = 1`],
    // In a JSX child, and as the last thing before a closing brace or bracket
    [`const a = <div>{/* ${D} @typescript-eslint/no-unsafe-call */}</div>`],
    [`function f() {${NL}  g()${NL}  /* ${E} @typescript-eslint/no-floating-promises: off */${NL}}`],
    [`const a = [${NL}  1,${NL}  // ${D}-next-line @typescript-eslint/no-unsafe-call${NL}]`],
    [`const a = { b: 1 /* ${D} @typescript-eslint/no-unsafe-member-access */ }`],
  ])('reports %s', async (code) => {
    expect((await found(code)).length).toBeGreaterThan(0)
  })
  it.each([
    [`// ${D}-next-line no-control-regex${NL}/* ${D} @typescript-eslint/no-explicit-any -- raw frames */${NL}const a = 1`],
    ['/* eslint-enable @typescript-eslint/no-non-null-assertion */' + NL + 'const a = 1'],
    // Text in a string or a template is not a comment
    [`const a = '// ${D}-next-line @typescript-eslint/no-unsafe-call'${NL}const b = \`/* ${D} */\``],
    [`// see the ${D} rule${NL}const a = 1`],
    [`/* ${E} no-console: off */${NL}const a = 1`],
  ])('does not report %s', async (code) => {
    expect(await found(code + NL + `// ${D} @typescript-eslint/no-unsafe-call`)).toEqual([code.split(NL).length + 1])
  })
  it('cannot switch itself off; a comment naming a rule of the pass fails the main pass, which has no such rule', async () => {
    const code = ['/* eslint guard/no-rule-switch-comments: off */', `// ${D}-next-line @typescript-eslint/no-unsafe-call`, 'f()'].join(NL)
    expect(await found(code)).toEqual([2])
    const [main] = await virtualFileLinter().lintText(code, { filePath: join(ROOT, file), warnIgnored: false })
    expect(main?.messages.filter((m) => m.severity === 2 && m.line === 1).map((m) => m.message)).toEqual([expect.stringContaining('was not found')])
  })
  it('reads the files the type-aware rules run in', async () => {
    const code = `// ${D}-next-line @typescript-eslint/no-unsafe-call${NL}const a = 1`
    const result = Object.fromEntries(
      await Promise.all(
        ['packages/ui/src/x.tsx', 'apps/web/src/x.ts', 'e2e/x.ts', 'tooling/x.ts', 'packages/agent-host/scripts/x.mts', 'scripts/x.mjs'].map(async (f) => [f, (await lines(f, code, 'no-rule-switch-comments')).length] as const),
      ),
    )
    expect(result).toEqual({ 'packages/ui/src/x.tsx': 1, 'apps/web/src/x.ts': 1, 'e2e/x.ts': 1, 'tooling/x.ts': 1, 'packages/agent-host/scripts/x.mts': 1, 'scripts/x.mjs': 0 })
  })
})

describe('guard/protocol-type-copies', () => {
  const file = 'packages/agent-host/src/x.ts'
  it.each([
    ['type GitCommit = { sha: string }'],
    ['export interface FsEntry { name: string }'],
    ['declare type HostBuild = string'],
    ['export type SessionActivity = "idle"'],
    [`namespace N {${NL}  interface ProjectConsent {}${NL}}`],
  ])('reports %s', async (code) => {
    expect((await lines(file, code, 'protocol-type-copies')).length).toBe(1)
  })
  it.each([
    ["import type { GitCommit } from '@cc/protocol'"],
    ["export type { GitCommit } from '@cc/protocol'"],
    ['type MineOnly = { a: 1 }'],
    ['// type GitCommit = {}'],
    ["const a = 'type GitCommit = {}'"],
    ['const GitCommit = 1'],
  ])('does not report %s', async (code) => {
    await quiet(file, 'protocol-type-copies', code, 'type GitCommit = { sha: string }')
  })
  it('reads a declaration file too, as the old test did', async () => {
    expect(await lines('packages/agent-host/src/x.d.ts', 'export interface GitCommit { a: 1 }', 'protocol-type-copies')).toEqual([1])
  })
  it('reads the host and the platform, not the protocol itself or their tests', async () => {
    const code = 'type GitCommit = { sha: string }'
    const result = Object.fromEntries(
      await Promise.all(
        ['packages/agent-host/src/x.ts', 'packages/platform/src/x.ts', 'packages/protocol/src/x.ts', 'packages/ui/src/x.ts', 'packages/agent-host/src/x.test.ts', 'packages/agent-host/src/x.test-helpers.ts'].map(
          async (f) => [f, await lines(f, code, 'protocol-type-copies')] as const,
        ),
      ),
    )
    expect(result).toEqual({
      'packages/agent-host/src/x.ts': [1],
      'packages/platform/src/x.ts': [1],
      'packages/protocol/src/x.ts': [],
      'packages/ui/src/x.ts': [],
      'packages/agent-host/src/x.test.ts': [],
      'packages/agent-host/src/x.test-helpers.ts': [],
    })
  })
  it('knows the names the protocol exports', async () => {
    // A rule that read no names would pass forever
    for (const name of ['GitCommit', 'FsEntry', 'HostBuild', 'SessionActivity', 'ProjectConsent']) expect(await lines(file, `type ${name} = string`, 'protocol-type-copies'), name).toEqual([1])
  })
})
