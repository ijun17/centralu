/**
 * The `guard/*` lint rules (tooling/eslint-guards.js): guards that were unit tests reading every source file of a
 * folder (#1606). Each is tried on virtual files: what it reports, what only looks like it, which files it reads, and
 * the exception lines (tooling/guard-exceptions.js) that let a file through.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { guardLinter, virtualFileLinter } from './eslint-virtual.test-helpers.js'
import { ARCHIVE_ALLOWED, EXCEPTIONS } from './guard-exceptions.js'
import { guardConfigs, guards } from './eslint-guards.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = guardLinter()
const NL = '\n'

type Hit = { rule: string; line: number }

/** What the guard rules report in `code`, linted as the file at `file` */
async function hits(file: string, code: string): Promise<Hit[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file), warnIgnored: false })
  return (result?.messages ?? []).filter((m) => m.ruleId?.startsWith('guard/')).map((m) => ({ rule: m.ruleId!.slice('guard/'.length), line: m.line }))
}
const lines = async (file: string, code: string, rule?: string) => (await hits(file, code)).filter((h) => !rule || h.rule === rule).map((h) => h.line)

/** `code` reports on each of `at`; and the same file with `positive` after it reports only that line (so a case that is not reported fails without the rule) */
async function quiet(file: string, rule: string, code: string, positive: string) {
  const all = await lines(file, code + NL + positive, rule)
  expect(all).toEqual([code.split(NL).length + 1])
}

describe('guard/no-hand-split', () => {
  const file = 'packages/agent-host/src/x.ts'
  it.each([
    ["p.split('/')"],
    ['parts.join("/")'],
    ['p.split(`/`)'],
    ["a.b.split('/').pop()"],
    ["p.split( '/' )"],
    ["p?.split('/')"],
  ])('reports %s', async (code) => {
    expect(await lines(file, code, 'no-hand-split')).toEqual([1])
  })
  it.each([
    ["text.split('\\n')"],
    ['name.split(/[-:_/]/)'],
    ["p.split('/', 2)"],
    ['p.split(sep)'],
    ["// p.split('/') is what this forbids"],
    ["const s = 'p.split(\"/\")'"],
    ["split('/')"],
  ])('does not report %s', async (code) => {
    await quiet(file, 'no-hand-split', code, "p.split('/')")
  })
  it('reads the shipped sources of every package, not tests and not other roots, and lets the protocol path module through', async () => {
    const code = "p.split('/')"
    const found = Object.fromEntries(
      await Promise.all(
        ['packages/ui/src/x.tsx', 'packages/protocol/src/x.ts', 'packages/protocol/src/paths.ts', 'packages/agent-host/src/x.test.ts', 'apps/web/src/x.ts', 'packages/ui/src/x.test.tsx'].map(async (f) => [f, await lines(f, code, 'no-hand-split')] as const),
      ),
    )
    expect(found).toEqual({ 'packages/ui/src/x.tsx': [1], 'packages/protocol/src/x.ts': [1], 'packages/protocol/src/paths.ts': [], 'packages/agent-host/src/x.test.ts': [], 'apps/web/src/x.ts': [], 'packages/ui/src/x.test.tsx': [] })
  })
})

describe('guard/ui-no-os', () => {
  const file = 'packages/ui/src/x.tsx'
  it.each([
    ['process.platform'],
    ['navigator.platform'],
    ['navigator.userAgentData'],
    ['window.navigator.platform'],
    ["navigator['platform']"],
    ['const isMac = true'],
    ['if (isMac) {}'],
    ['const a = <Kbd isMac />'],
    ["const s = { 'isMac': true }"],
    ["const a = x['isMac']"],
  ])('reports %s', async (code) => {
    expect(await lines(file, code, 'ui-no-os')).toHaveLength(1)
  })
  it.each([['const platform = ports.platform'], ['// process.platform is read in the host'], ["const s = 'navigator'"], ['isMacLike()'], ['const { platform } = ports'], ["const s = 'isMac'"]])('does not report %s', async (code) => {
    await quiet(file, 'ui-no-os', code, 'navigator.platform')
  })
  it('reads the UI package, tests included, and nothing else', async () => {
    const found = Object.fromEntries(await Promise.all(['packages/ui/src/x.test.tsx', 'apps/web/src/x.ts', 'packages/core/src/x.ts'].map(async (f) => [f, await lines(f, 'navigator.platform', 'ui-no-os')] as const)))
    expect(found).toEqual({ 'packages/ui/src/x.test.tsx': [1], 'apps/web/src/x.ts': [], 'packages/core/src/x.ts': [] })
  })
})

describe('guard/ui-no-key-glyphs', () => {
  const file = 'packages/ui/src/x.tsx'
  it.each([["const a = '⌘K'"], ['const a = `${x}⌥`'], ['const a = <kbd>⌘</kbd>'], ['const a = /⌘/'], ['const a = <div title="⌥ Option" />']])('reports %s', async (code) => {
    expect(await lines(file, code, 'ui-no-key-glyphs')).toEqual([1])
  })
  it.each([['// ⌘A copies'], ['/* ⌘ */ const a = 1'], ['const a = <div>{/* ⌘ */}</div>'], ["const a = '⇧'"]])('does not report %s', async (code) => {
    await quiet(file, 'ui-no-key-glyphs', code, "const k = '⌘'")
  })
  it('reads shipped UI sources, not the tests that pin the Mac notation', async () => {
    expect(await lines('packages/ui/src/app/shortcut.test.ts', "const k = '⌘'", 'ui-no-key-glyphs')).toEqual([])
    expect(await lines('packages/ui/src/app/shortcut.ts', "const k = '⌘'", 'ui-no-key-glyphs')).toEqual([1])
  })
})

describe('guard/ui-type-scale', () => {
  const file = 'packages/ui/src/features/x.tsx'
  it.each([
    ["const c = 'text-[9px]'"],
    ["const c = 'text-[0.7rem] font-mono'"],
    ["const c = 'leading-[18px]'"],
    ['const c = `leading-[1.5] ${x}`'],
    ['const c = <p className="text-[11px]" />'],
    ['const s = { fontSize: 12 }'],
    ["const s = { fontSize: '12px' }"],
    ['const s = { fontSize: `12px` }'],
    ["const s = { 'fontSize': 12 }"],
    ['const s = { fontSize: 13 as const }'],
    ["const s = { fontSize: 1.5 + 'rem' }"],
    ['const c = `text-[${size}px] flex`'],
    ['const c = `leading-[${h}px]`'],
  ])('reports %s', async (code) => {
    expect(await lines(file, code, 'ui-type-scale')).toEqual([1])
  })
  it.each([
    ["const c = 'text-[var(--ink)]'"],
    ["const c = 'text-[#fff]'"],
    ["const c = 'text-sm leading-tight'"],
    ["const c = 'context-[9px]'"],
    ['const s = { fontSize: size }'],
    ['const s = { fontSize: `${n}px` }'],
    ['const c = `text-[${color}]`'],
    ["// 'text-[9px]' is what the scale forbids"],
  ])('does not report %s', async (code) => {
    await quiet(file, 'ui-type-scale', code, "const c = 'text-[9px]'")
  })
  it('lets the two listed sizes through in their files, and says when one is gone', async () => {
    const code = "const c = 'leading-[18px]'"
    expect(await lines('packages/ui/src/features/viewer/CodeViewer.tsx', code, 'ui-type-scale')).toEqual([])
    // Another size in that file is a finding; the listed one is no longer there, so the line is stale too
    expect(await lines('packages/ui/src/features/viewer/CodeViewer.tsx', "const c = 'leading-[19px]'", 'ui-type-scale')).toEqual([1, 1])
    expect(await lines('packages/ui/src/features/git/GitPanel.tsx', code, 'ui-type-scale')).toEqual([1, 1])
  })
  it('reads the three roots a screen is drawn from, not their tests', async () => {
    const code = "const c = 'text-[9px]'"
    const found = Object.fromEntries(
      await Promise.all(['apps/web/src/x.tsx', 'apps/desktop/src/x.ts', 'packages/ui/src/x.test.tsx', 'packages/core/src/x.ts'].map(async (f) => [f, await lines(f, code, 'ui-type-scale')] as const)),
    )
    expect(found).toEqual({ 'apps/web/src/x.tsx': [1], 'apps/desktop/src/x.ts': [1], 'packages/ui/src/x.test.tsx': [], 'packages/core/src/x.ts': [] })
  })
})

describe('guard/ui-radius-scale', () => {
  const file = 'packages/ui/src/features/x.tsx'
  it.each([
    ['<div className="rounded-[14px] border" />'],
    ["const c = 'rounded-t-[14px] rounded-br-[3px]'"],
    ['<span className="[&_.keycap]:rounded-[5px]" />'],
    ['const s = { borderRadius: 6 }'],
    ["const s = { 'borderRadius': '6px' }"],
    ['const c = `rounded-[${r}px]`'],
    ['const c = `flex rounded-t-[${r}px] ${x}`'],
  ])('reports %s', async (code) => {
    expect((await lines(file, code, 'ui-radius-scale')).length).toBeGreaterThan(0)
  })
  it.each([['<div className="rounded-bubble rounded-t-field rounded-full rounded-md" />'], ["const c = 'rounded-lg'"], ['const s = { border: "var(--radius-md)" }'], ['// rounded-[14px]']])('does not report %s', async (code) => {
    await quiet(file, 'ui-radius-scale', code, "const c = 'rounded-[14px]'")
  })
  it('reads screens, not the shared components or the stylesheet', async () => {
    const code = "const c = 'rounded-[14px]'"
    const found = Object.fromEntries(
      await Promise.all(['packages/ui/src/components/Button.tsx', 'packages/ui/src/styles/x.ts', 'packages/ui/src/features/x.tsx', 'apps/web/src/x.tsx'].map(async (f) => [f, await lines(f, code, 'ui-radius-scale')] as const)),
    )
    expect(found).toEqual({ 'packages/ui/src/components/Button.tsx': [], 'packages/ui/src/styles/x.ts': [], 'packages/ui/src/features/x.tsx': [1], 'apps/web/src/x.tsx': [1] })
  })
  it('lets a listed file hold its count: more than the list fails with every one, fewer says the line is stale', async () => {
    const listed = 'packages/ui/src/features/session/SessionView.tsx'
    expect(await lines(listed, "const c = 'rounded-[14px]'", 'ui-radius-scale')).toEqual([])
    expect(await lines(listed, "const c = 'rounded-[14px] rounded-[3px]'", 'ui-radius-scale')).toEqual([1, 1])
    expect(await lines(listed, 'const c = 1', 'ui-radius-scale')).toEqual([1])
  })
})

describe('guard/hidden-children', () => {
  const file = 'packages/agent-host/src/x.ts'
  const imports = "import { execFile, spawn as start, type ChildProcess } from 'node:child_process'" + NL + "import { promisify } from 'node:util'" + NL
  const found = (body: string) => lines(file, imports + body, 'hidden-children')

  it.each([
    ["start('git', ['status'], { cwd })"],
    ["execFile('du', ['-sk'], { cwd }, (err) => {})"],
    ["const run = promisify(execFile)" + NL + "await run('ps', ['-A'], { timeout: 5000 })"],
    ["const run = promisify(execFile)" + NL + "const again = promisify(run)" + NL + "again('ps')"],
    ["start('ssh', args, {" + NL + "  env," + NL + "  stdio: 'pipe'," + NL + '})'],
    ["start('git', [], { cwd, windowsHide: false })"],
    ["start('git', [], { cwd, windowsHide: false as const })"],
    ["const opts = { windowsHide: true }" + NL + "start('git', [], opts)"],
  ])('reports a start without windowsHide: %s', async (body) => {
    expect(await found(body)).toHaveLength(1)
  })

  it.each([
    ["start('git', ['status'], { cwd, windowsHide: true })"],
    ["execFile('git', [], {" + NL + '  cwd,' + NL + '  windowsHide: true,' + NL + '}, () => {})'],
    ["const hide = true" + NL + "start('git', [], { windowsHide: hide })"],
    ["start('git', [], { ...base, windowsHide: true })"],
    // A method of the same name, a name that is not from child_process, and a file that imports nothing from it
    ["/x/.exec(line); db.exec('BEGIN'); keeper.spawn({ kind: 'pty' })"],
  ])('does not report %s', async (body) => {
    expect(await found(body)).toEqual([])
    expect(await found(body + NL + "start('git')")).toHaveLength(1)
  })

  it('does not report a function of the same name that is not from child_process', async () => {
    expect(await lines(file, "const exec = (a: string) => a" + NL + "exec('x')", 'hidden-children')).toEqual([])
    expect(await lines(file, "import { exec } from './mine.js'" + NL + "exec('x')", 'hidden-children')).toEqual([])
  })

  it.each([
    ["import * as cp from 'node:child_process'" + NL + "cp.spawn('git', [])"],
    ["import cp from 'child_process'" + NL + "cp.execFile('git', [])"],
    ["import cp, { spawn } from 'node:child_process'"],
    ["const cp = require('node:child_process')"],
    ["import cp = require('node:child_process')"],
    ["const { spawn } = await import('child_process')"],
  ])('reports a way of reaching child_process that cannot be followed to its calls: %s', async (source) => {
    expect(await lines(file, source, 'hidden-children')).toHaveLength(1)
  })
  it('does not report a type import', async () => {
    await quiet(file, 'hidden-children', "import type { ChildProcess } from 'node:child_process'", "const cp = require('node:child_process')")
  })

  it('reads a .cjs file too, as CommonJS', async () => {
    expect(await lines('packages/agent-host/src/x.cjs', "const cp = require('node:child_process')", 'hidden-children')).toEqual([1])
  })

  it('reads the host sources, not its tests or fixtures', async () => {
    // Plain JavaScript: the .mjs and .cjs files are not parsed as TypeScript
    const code = "import { spawn as start } from 'node:child_process'" + NL + "start('git')"
    const result = Object.fromEntries(
      await Promise.all(
        ['packages/agent-host/src/adapters/codex/orchestrator-bridge.mjs', 'packages/agent-host/src/x.test.ts', 'packages/agent-host/src/x.test-helpers.ts', 'packages/agent-host/src/apps/external/test-fixtures/app.mjs', 'packages/ui/src/x.ts'].map(
          async (f) => [f, await lines(f, code, 'hidden-children')] as const,
        ),
      ),
    )
    expect(result).toEqual({
      'packages/agent-host/src/adapters/codex/orchestrator-bridge.mjs': [2],
      'packages/agent-host/src/x.test.ts': [],
      'packages/agent-host/src/x.test-helpers.ts': [],
      'packages/agent-host/src/apps/external/test-fixtures/app.mjs': [],
      'packages/ui/src/x.ts': [],
    })
  })
})

describe('guard/git-start', () => {
  const file = 'packages/agent-host/src/sessions/x.ts'
  it.each([
    ["spawn(programPath('git'), ['status'])"],
    ["await exec(programPath( 'git' ), args)"],
    ["execFileSync('git', ['status'])"],
    ['spawn("git.exe", [])'],
    ["cp.execFileSync('git', ['status'])"],
    ['spawnSync(`git`, [])'],
    ["programPath(`git`)"],
    ["spawn('git' as string, [])"],
    ["execFile('git' as const, [])"],
  ])('reports %s', async (code) => {
    expect(await lines(file, code, 'git-start')).toEqual([1])
  })
  it.each([["exec(programPath('gh'), ['pr', 'view'])"], ["spawn('gitk')"], ["run('git', args)"], ["// execFile('git')"], ["const s = \"execFile('git')\""]])('does not report %s', async (code) => {
    await quiet(file, 'git-start', code, "execFileSync('git')")
  })
  it('lets git-exec.ts and the remote installer through, and reads tests no more than the old guard did', async () => {
    const code = "execFileSync('git')"
    expect(await lines('packages/agent-host/src/dev-services/git-exec.ts', code, 'git-start')).toEqual([])
    expect(await lines('packages/agent-host/src/links/remote-install.mjs', code, 'git-start')).toEqual([])
    expect(await lines('packages/agent-host/src/links/other.mjs', code, 'git-start')).toEqual([1])
    expect(await lines('packages/agent-host/src/sessions/x.test.ts', code, 'git-start')).toEqual([])
  })
})

describe('guard/no-hand-coded-error', () => {
  const file = 'packages/agent-host/src/x.ts'
  it.each([
    ["throw Object.assign(new Error('Gone'), { code: 'internal' })"],
    ['throw Object.assign(' + NL + '  new Error(' + NL + '    `Gone (${a}) now`,' + NL + '  ),' + NL + "  { code: 'internal' }," + NL + ')'],
    ["Object.assign(new Error('x'), { retryable: true, code: 'session_not_found' })"],
    ["Object.assign(new Error('x'), { 'code': 'internal' })"],
    ["Object.assign(new Error('x'), { code: 'internal' } as const)"],
    ["Object.assign(new Error('x'), { code: 'internal' } satisfies Coded)"],
    ["Object.assign(new Error('x') as Coded, { code: 'internal' as const })"],
  ])('reports %s', async (code) => {
    expect(await lines(file, code, 'no-hand-coded-error')).toHaveLength(1)
  })
  it.each([
    ["Object.assign(new Error(`Git exited with ${code}`), { code, stderr })"],
    ["Object.assign(new Error('gh was stopped'), { code: 'ABORT_ERR' })"],
    ["Object.assign(base, { code: 'internal' })"],
    ["Object.assign(new Error('x'), props)"],
    ["rpcError('x', 'internal')"],
  ])('does not report %s', async (code) => {
    await quiet(file, 'no-hand-coded-error', code, "Object.assign(new Error('x'), { code: 'internal' })")
  })
  it('reads the host and the mock, and lets the two builders through', async () => {
    const code = "Object.assign(new Error('x'), { code: 'internal' })"
    const found = Object.fromEntries(
      await Promise.all(
        ['packages/agent-host/src/rpc-error.ts', 'packages/agent-host/src/sessions/x.ts', 'packages/platform/src/mock/mock-error.ts', 'packages/platform/src/mock/x.ts', 'packages/platform/src/web/x.ts', 'packages/agent-host/src/x.test.ts'].map(
          async (f) => [f, await lines(f, code, 'no-hand-coded-error')] as const,
        ),
      ),
    )
    expect(found).toEqual({
      'packages/agent-host/src/rpc-error.ts': [],
      'packages/agent-host/src/sessions/x.ts': [1],
      'packages/platform/src/mock/mock-error.ts': [],
      'packages/platform/src/mock/x.ts': [1],
      'packages/platform/src/web/x.ts': [],
      'packages/agent-host/src/x.test.ts': [],
    })
  })
})

describe('guard/purge-callers and guard/subagent-purge-callers', () => {
  it.each([
    ['guard purge', 'packages/agent-host/src/sessions/x.ts', 'mgr.purgeSession(id)', 'purge-callers'],
    ['guard empty', 'packages/agent-host/src/x.ts', 'this.store.emptyTrash()', 'purge-callers'],
    ['subagent steps', 'packages/agent-host/src/sessions/x.ts', 'mgr.purgeSubagentSteps(id, 0)', 'subagent-purge-callers'],
    ['store steps', 'packages/agent-host/src/sessions/x.ts', 'this.host.store.subagentSteps.purge(id)', 'subagent-purge-callers'],
    ['a call on a call', 'packages/agent-host/src/sessions/x.ts', 'getManager().purgeSession(id)', 'purge-callers'],
  ])('reports %s in a file that is not listed', async (_what, file, code, rule) => {
    expect(await lines(file, code, rule)).toEqual([1])
  })
  it.each([
    ["a computed string", "mgr['purgeSession'](id)"],
    ['a template string', 'mgr[`purgeSession`](id)'],
    ['an optional call', 'mgr?.purgeSession(id)'],
    ['a non-null receiver', 'mgr!.purgeSession(id)'],
    ['a reference kept', 'const f = mgr.purgeSession'],
    ['bind', 'mgr.purgeSession.bind(mgr)(id)'],
    ['call', 'mgr.purgeSession.call(mgr, id)'],
    ['apply', 'mgr.purgeSession.apply(mgr, [id])'],
    ['a destructured method', 'const { purgeSession } = mgr; purgeSession(id)'],
    ['a destructured method, renamed', 'const { purgeSession: purge } = mgr; purge(id)'],
    ['a destructured string key', "const { 'purgeSession': purge } = mgr; purge(id)"],
    ['a computed destructured key', "const { ['purgeSession']: purge } = mgr; purge(id)"],
    ['a destructuring assignment', 'let purge; ({ purgeSession: purge } = mgr)'],
    ['a destructured parameter', 'const f = ({ purgeSession }: M) => purgeSession(id)'],
    ['a nested destructuring', 'const { trash: { purgeSession } } = mgr'],
    ['Reflect.get', "Reflect.get(mgr, 'purgeSession')"],
    ['a name kept in a variable', "const key = 'purgeSession'; mgr[key](id)"],
    ['the emptying', "mgr['emptyTrash']()"],
  ])('reports %s', async (_what, code) => {
    expect(await lines('packages/agent-host/src/sessions/x.ts', code, 'purge-callers')).not.toEqual([])
  })
  it.each([
    ['a destructured method of the store', 'const { purge } = this.host.store.subagentSteps; purge(id, 0)'],
    ['a destructured, renamed method of the store', 'const { purge: p } = store.subagentSteps; p(id, 0)'],
    ['a computed method of the store', "this.host.store.subagentSteps['purge'](id, 0)"],
    ['bind on the store', 'store.subagentSteps.purge.bind(store.subagentSteps)(id, 0)'],
    ['a nested destructuring of the store', 'const { subagentSteps: { purge } } = store'],
    ['the steps kept, then called', 'const { subagentSteps } = store; subagentSteps.purge(id, 0)'],
    ['the steps purge by name', "mgr['purgeSubagentSteps'](id, 0)"],
    ['the steps purge, destructured', 'const { purgeSubagentSteps } = mgr'],
  ])('reports %s for the subagent steps', async (_what, code) => {
    expect(await lines('packages/agent-host/src/sessions/x.ts', code, 'subagent-purge-callers')).not.toEqual([])
  })
  it('does not report a method that is only named, defined, typed or mentioned', async () => {
    const file = 'packages/agent-host/src/sessions/x.ts'
    const only = [
      "// mgr.purgeSession(id) is the RPC's",
      'class A { purgeSession(id: string) {} }',
      'const o = { purgeSession: (id: string) => id }',
      "const q = { 'purgeSession': 1, ['emptyTrash']: 2 }",
      'interface I { purgeSession(id: string): void; emptyTrash: () => void }',
      "type T = Parameters<M['purgeSession']>",
      "type P = Pick<M, 'purgeSession' | 'emptyTrash'>",
      'const { purge } = other',
      'const { purgeSession2 } = mgr',
      'mgr.purgeSessions(id)',
      "const s = 'purgeSessions'",
      'other.purge(id)',
      'const { purge: p } = something.subagentSteps2',
    ]
    for (const code of only) await quiet(file, 'purge-callers', code, 'mgr.purgeSession(id)')
    await quiet(file, 'subagent-purge-callers', 'other.purge(id)' + NL + 'const { purge } = other' + NL + 'type S = Pick<M, "purgeSubagentSteps">', 'store.subagentSteps.purge(id, 0)')
  })
  it('counts a reference of any spelling against the listed ones of the file (#204)', async () => {
    const rpc = 'packages/agent-host/src/rpc.ts'
    const listed = 'mgr.emptyTrash()' + NL + 'mgr.purgeSession(id)'
    expect(await lines(rpc, listed, 'purge-callers')).toEqual([])
    // The same receiver spelled another way is the same listed reference; a second one of that receiver is a finding, and so is a kind the file does not list
    expect(await lines(rpc, "mgr.emptyTrash()" + NL + "mgr['purgeSession'](id)", 'purge-callers')).toEqual([])
    expect(await lines(rpc, listed + NL + 'mgr.purgeSession.bind(mgr)(id)', 'purge-callers')).toEqual([2, 3])
    expect(await lines(rpc, listed + NL + 'const { purgeSession } = mgr', 'purge-callers')).toEqual([3])
    expect(await lines(rpc, listed + NL + "const k = 'purgeSession'", 'purge-callers')).toEqual([3])
  })
  it('lets a listed file make the calls listed for it, and no others', async () => {
    const rpc = 'packages/agent-host/src/rpc.ts'
    expect(await lines(rpc, 'mgr.emptyTrash()' + NL + 'mgr.purgeSession(id)', 'purge-callers')).toEqual([])
    // Another receiver in the same file is a finding
    expect(await lines(rpc, 'mgr.emptyTrash()' + NL + 'mgr.purgeSession(id)' + NL + 'other.purgeSession(id)', 'purge-callers')).toEqual([3])
    // A listed call that is no longer made says so
    expect(await lines(rpc, 'mgr.emptyTrash()', 'purge-callers')).toEqual([1])
  })
  it('lets a listed call be made as many times as listed: a second identical call is a finding (#204)', async () => {
    const manager = 'packages/agent-host/src/sessions/manager.ts'
    const once = ['self.purgeSession(id)', 'this.trash.emptyTrash()', 'this.trash.purgeSession(id)'].join(NL)
    expect(await lines(manager, once, 'purge-callers')).toEqual([])
    // The listed line did not make it free: the second call is reported, with the first (the finding is a count, not a place)
    expect(await lines(manager, once + NL + 'this.trash.purgeSession(other)', 'purge-callers')).toEqual([3, 4])
    expect(await lines('packages/agent-host/src/rpc.ts', 'mgr.emptyTrash()' + NL + 'mgr.purgeSession(a)' + NL + 'mgr.purgeSession(b)', 'purge-callers')).toEqual([2, 3])
    expect(await lines('packages/agent-host/src/sessions/manager.ts', 'this.trash.purgeSubagentSteps(a)' + NL + 'this.trash.purgeSubagentSteps(b)', 'subagent-purge-callers')).toEqual([1, 2])
  })
  it('reads the host sources, not its tests', async () => {
    expect(await lines('packages/agent-host/src/sessions/x.test.ts', 'mgr.purgeSession(id)', 'purge-callers')).toEqual([])
    expect(await lines('packages/agent-host/src/x.tsx', 'mgr.purgeSession(id)', 'purge-callers')).toEqual([1])
  })
})

describe('guard/import-boundary', () => {
  const apps = 'packages/agent-host/src/apps/x.ts'
  const external = 'packages/agent-host/src/apps/external/x.ts'
  it.each([
    ["import { a } from '../sessions/manager.js'"],
    ["import type { A } from '../sessions/manager.js'"],
    ["export { a } from '../sessions/manager.js'"],
    ["export * from '../sessions/manager.js'"],
    ["const m = await import('../sessions/manager.js')"],
    ["const m = require('../sessions/manager.js')"],
    ["import '../sessions/setup.js'"],
    ["import m = require('../sessions/manager.js')"],
    ["type M = import('../sessions/manager.js').Manager"],
    ["type M = typeof import('../sessions/manager.js')"],
  ])('reports, in the app runtime, %s', async (code) => {
    expect(await lines(apps, code, 'import-boundary')).toEqual([1])
  })
  it.each([["import { a } from '../dev-services/store.js'"], ["import { a } from './sessionsLike.js'"], ["import { a } from '@cc/protocol'"], ["// import { a } from '../sessions/manager.js'"]])('does not report, in the app runtime, %s', async (code) => {
    await quiet(apps, 'import-boundary', code, "import { a } from '../sessions/manager.js'")
  })
  it.each([
    ["import { a } from '../../sessions/manager.js'"],
    ["import { a } from '../../adapters/claude/x.js'"],
    ["import { a } from '../../dev-services/store.js'"],
    ["const m = await import('../../dev-services/terminal.js')"],
    ["type T = import('../../dev-services/terminal.js').Terminal"],
  ])('reports, in the external app runtime, %s', async (code) => {
    expect(await lines(external, code, 'import-boundary')).toEqual([1])
  })
  it.each([
    ["import { a } from '../../dev-services/watch.js'"],
    ["import { a } from '../../dev-services/path-guard.js'"],
    ["import { a } from '../../dev-services/kill-tree.js'"],
    ["import { a } from '../../dev-services/grouped-child.js'"],
    ["import { a } from '../../dev-services/data-folder.js'"],
    ["import { a } from '../contract.js'"],
  ])('lets the external app runtime borrow %s', async (code) => {
    await quiet(external, 'import-boundary', code, "import { a } from '../../dev-services/store.js'")
  })
  it('reads the app runtime, tests included, and nothing outside it', async () => {
    const code = "import { a } from '../sessions/manager.js'"
    expect(await lines('packages/agent-host/src/apps/x.test.ts', code, 'import-boundary')).toEqual([1])
    expect(await lines('packages/agent-host/src/rpc.ts', code, 'import-boundary')).toEqual([])
    // Outside external/, dev-services is not the boundary's business
    expect(await lines(apps, "import { a } from '../dev-services/store.js'", 'import-boundary')).toEqual([])
  })
})

describe('guard/no-tool-names', () => {
  const file = 'packages/protocol/src/x.ts'
  it.each([["export const a = 'claude'"], ["export type T = 'codex' | 'other'"], ['export const claude = 1'], ['export const a = `use Codex`'], ['export const a = /claude/i'], ["export const o = { codex: 1 }"], ["export const a = 'Claude Code'"], ['export class A { #claude = 1 }'], ['export class A { m() { return this.#codex } }']])('reports %s', async (code) => {
    expect((await lines(file, code, 'no-tool-names')).length).toBeGreaterThan(0)
  })
  it.each([['// claude and codex are named in this comment'], ['/** The adapters (claude, codex) introduce themselves */ export const a = 1'], ['export const claudeCode = 1'], ["export const a = 'cursor-agent'"]])('does not report %s', async (code) => {
    await quiet(file, 'no-tool-names', code, "export const a = 'claude'")
  })
  it('reads the protocol sources, not their tests, and no other package', async () => {
    const code = "export const a = 'claude'"
    expect(await lines('packages/protocol/src/x.test.ts', code, 'no-tool-names')).toEqual([])
    expect(await lines('packages/protocol/src/deep/x.ts', code, 'no-tool-names')).toEqual([1])
    expect(await lines('packages/agent-host/src/x.ts', code, 'no-tool-names')).toEqual([])
  })
})

describe('guard/no-sleeps', () => {
  const file = 'packages/agent-host/src/adapters/frames/x.test.ts'
  it.each([['setTimeout(() => {}, 10)'], ['await sleep(10)'], ['await delay(5)'], ['await page.waitForTimeout(5)'], ['vi.advanceTimersByTime(100)'], ['await vi.advanceTimersToNextTimerAsync()'], ['globalThis.setTimeout(f, 1)'], ["await page['waitForTimeout'](5)"], ['await page[`waitForTimeout`](5)']])('reports %s', async (code) => {
    expect((await lines(file, code, 'no-sleeps')).length).toBeGreaterThan(0)
  })
  it.each([['// setTimeout(f, 1) is what waiting for time looks like'], ["const s = 'sleep(1)'"], ['await vi.waitFor(() => ok)'], ['clearTimeout(t)'], ['const sleepy = 1']])('does not report %s', async (code) => {
    await quiet(file, 'no-sleeps', code, 'await sleep(1)')
  })
  it('reads the frame-replayed adapters tests only', async () => {
    const code = 'await sleep(1)'
    const found = Object.fromEntries(
      await Promise.all(
        ['packages/agent-host/src/adapters/acp/x.test.ts', 'packages/agent-host/src/adapters/cursor-agent/x.test.ts', 'packages/agent-host/src/adapters/codex/x.test.ts', 'packages/agent-host/src/adapters/acp/sub/x.test.ts', 'packages/agent-host/src/adapters/frames/x.ts'].map(
          async (f) => [f, await lines(f, code, 'no-sleeps')] as const,
        ),
      ),
    )
    expect(found).toEqual({
      'packages/agent-host/src/adapters/acp/x.test.ts': [1],
      'packages/agent-host/src/adapters/cursor-agent/x.test.ts': [1],
      'packages/agent-host/src/adapters/codex/x.test.ts': [],
      'packages/agent-host/src/adapters/acp/sub/x.test.ts': [],
      'packages/agent-host/src/adapters/frames/x.ts': [],
    })
  })
})

describe('the guard rules as a set', () => {
  it('has every rule switched on somewhere, and names no rule that is not there', () => {
    const on = new Set(guardConfigs.flatMap((c) => Object.entries(c.rules).filter(([, level]) => level !== 'off').map(([r]) => r.slice('guard/'.length))))
    // `type-assertions` counts for tooling/lint.ts, which turns it on itself (ASSERTION_RULE in lint-allowlist.ts)
    expect([...on].sort()).toEqual(Object.keys(guards.rules).sort())
    for (const rule of Object.keys(EXCEPTIONS)) expect(Object.keys(guards.rules), rule).toContain(rule)
  })

  it('is a pass of its own that reads no comment as configuration, and the main configuration holds none of these rules', async () => {
    const pass = await eslint.calculateConfigForFile(join(ROOT, 'packages/agent-host/src/x.test.ts'))
    expect(pass?.linterOptions?.noInlineConfig).toBe(true)
    const main = await virtualFileLinter().calculateConfigForFile(join(ROOT, 'packages/agent-host/src/x.test.ts'))
    for (const rule of Object.keys(main?.rules ?? {})) expect(/^(guard|test-env|test-limits)\//.test(rule), rule).toBe(false)
    // And the pass holds these rules only, in every file kind it reads
    for (const file of ['packages/agent-host/src/x.ts', 'packages/ui/src/x.tsx', 'packages/protocol/src/x.ts', 'packages/agent-host/src/x.test.ts', 'e2e/x.ts', 'packages/agent-host/src/x.cjs']) {
      const rules = Object.keys((await eslint.calculateConfigForFile(join(ROOT, file)))?.rules ?? {})
      expect(rules.length, file).toBeGreaterThan(0)
      for (const rule of rules) expect(/^(guard|test-env|test-limits)\//.test(rule), `${file} ${rule}`).toBe(true)
    }
  })

  it('ignores the build output of an app or a package, and reads a source folder that happens to be named dist', async () => {
    const built = ['apps/web/dist/x.js', 'apps/desktop/dist/assets/x.js', 'packages/ui/dist/x.js', 'packages/agent-host/dist/sessions/x.js']
    const source = ['packages/agent-host/src/dist/x.ts', 'packages/ui/src/features/dist/Panel.tsx', 'apps/web/src/dist/x.ts', 'packages/agent-host/src/sessions/dist/x.mjs', 'e2e/dist/x.ts']
    for (const linter of [eslint, virtualFileLinter()]) {
      for (const file of built) expect(await linter.isPathIgnored(join(ROOT, file)), file).toBe(true)
      for (const file of source) expect(await linter.isPathIgnored(join(ROOT, file)), file).toBe(false)
    }
    // And a guard finds what is in such a source folder
    expect(await lines('packages/agent-host/src/dist/x.ts', "execFileSync('git')", 'git-start')).toEqual([1])
  })

  it('reads a file named test-helpers.ts as a source, as the tests it replaced did: only x.test-helpers.ts is a helper', async () => {
    const source = 'packages/agent-host/src/apps/external/test-helpers.ts'
    const helper = 'packages/agent-host/src/apps/external/zip.test-helpers.ts'
    const probes: [string, string][] = [
      ['hidden-children', "import { spawn } from 'node:child_process'" + NL + "spawn('du')"],
      ['git-start', "execFileSync('git')"],
      ['no-hand-coded-error', "Object.assign(new Error('x'), { code: 'internal' })"],
      ['purge-callers', 'mgr.purgeSession(id)'],
      ['subagent-purge-callers', 'mgr.purgeSubagentSteps(id, 0)'],
    ]
    for (const [rule, code] of probes) {
      expect((await lines(source, code, rule)).length, `${rule} in test-helpers.ts`).toBeGreaterThan(0)
      expect(await lines(helper, code, rule), `${rule} in zip.test-helpers.ts`).toEqual([])
    }
  })

  // The ways a comment was found to switch a rule off (the review of #1620): none of them does anything in the pass
  describe('cannot be switched off by a comment', () => {
    const host = 'packages/agent-host/src/x.mjs'
    const spawnGit = ["import { spawn } from 'node:child_process'", "spawn('git', ['x'])"].join(NL)
    const cases: [string, string, string, Record<string, number[]>][] = [
      ['a configuration comment naming two rules, in an .mjs', host, ['/* eslint guard/hidden-children: off, guard/git-start: off */', spawnGit].join(NL), { 'hidden-children': [3], 'git-start': [3] }],
      ['a quoted rule name', host, ['/* eslint "guard/git-start": "off" */', spawnGit].join(NL), { 'hidden-children': [3], 'git-start': [3] }],
      ['an eslint-disable of the whole file', host, ['/* eslint-disable */', spawnGit].join(NL), { 'hidden-children': [3], 'git-start': [3] }],
      ['an eslint-disable-next-line', host, ["import { spawn } from 'node:child_process'", '// eslint-disable-next-line guard/git-start, guard/hidden-children', "spawn('git', ['x'])"].join(NL), { 'hidden-children': [3], 'git-start': [3] }],
      ['an eslint-disable-line', host, ["import { spawn } from 'node:child_process'", "spawn('git', ['x']) // eslint-disable-line guard/git-start, guard/hidden-children"].join(NL), { 'hidden-children': [2], 'git-start': [2] }],
      ['an eslint-disable of a rule in a .cjs, the main pass reads none of', 'packages/agent-host/src/x.cjs', ['/* eslint-disable guard/hidden-children */', "const cp = require('node:child_process')"].join(NL), { 'hidden-children': [2] }],
      ['a JSX comment', 'packages/ui/src/x.tsx', ['export const A = () => (', '  <div className="text-[13px]">', '    {/* eslint guard/ui-type-scale: off */}', '  </div>', ')'].join(NL), { 'ui-type-scale': [2] }],
      ['a comment just before a closing brace', 'packages/agent-host/src/x.ts', ['function f(p: string) {', "  p.split('/')", '  /* eslint guard/no-hand-split: off */', '}'].join(NL), { 'no-hand-split': [2] }],
      ['a comment just before a closing bracket', 'packages/agent-host/src/x.ts', ['const a = [', "  p.split('/'),", '  /* eslint guard/no-hand-split: off */', ']'].join(NL), { 'no-hand-split': [2] }],
      ['a comment at the end of the file', 'packages/agent-host/src/x.ts', ["p.split('/')", '/* eslint guard/no-hand-split: off */'].join(NL), { 'no-hand-split': [1] }],
    ]
    it.each(cases)('%s', async (_what, file, code, expected) => {
      const [result] = await eslint.lintText(code, { filePath: join(ROOT, file), warnIgnored: false })
      const found: Record<string, number[]> = {}
      for (const m of result?.messages ?? []) if (m.ruleId?.startsWith('guard/')) (found[m.ruleId.slice('guard/'.length)] ??= []).push(m.line)
      expect(found).toEqual(expected)
      expect(result?.suppressedMessages).toEqual([])
    })
  })

  it('has exceptions that only shrink, each a tracked file with its reason', () => {
    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split(NL))
    let count = 0
    for (const [rule, files] of Object.entries(EXCEPTIONS)) {
      for (const [file, entry] of Object.entries(files)) {
        count++
        expect(tracked.has(file), `${rule}: ${file} is a tracked file`).toBe(true)
        const reasons = typeof entry.reason === 'string' ? { '': entry.reason } : entry.reason
        for (const [kind, reason] of Object.entries(reasons)) expect(reason.length, `${rule}: ${file} ${kind} says why`).toBeGreaterThan(10)
        if (entry.count !== undefined) expect(entry.count, `${rule}: ${file}`).toBeGreaterThan(0)
        // One reason for each kind of finding the file is let through for, when the reasons are told apart
        if (entry.counts) {
          if (typeof entry.reason !== 'string') expect(Object.keys(reasons).sort(), `${rule}: ${file}`).toEqual(Object.keys(entry.counts).sort())
          for (const n of Object.values(entry.counts)) expect(n).toBeGreaterThan(0)
        }
      }
    }
    // A ceiling: lowered when a line goes, never raised (#1606, #1607)
    expect(count).toBeLessThanOrEqual(37)
    expect(ARCHIVE_ALLOWED.length).toBeLessThanOrEqual(11)
    for (const a of ARCHIVE_ALLOWED) expect(a.why.length, a.text).toBeGreaterThan(10)
  })
})
