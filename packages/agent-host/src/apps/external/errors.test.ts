import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppRef } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { fakeBrokerHost, until } from './test-helpers.js'

/**
 * Errors reach the builder — the host's half of it (M4 C-6). Failing to start, crashing, and a tool
 * failing are kept per app, and the host answers when asked. It does not send them on its own.
 * Exercised with real apps that use the template's runtime.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-errors-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const SESSION = { kind: 'session' as const, sessionId: 's1' }

function make() {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, maxFailures: 5, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

function app(id: string, server: string, manifest?: (m: Record<string, unknown>) => void): void {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name: `App ${id}`, description: id })
  writeFileSync(join(dir, 'server.mjs'), `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'\n${server}\n`)
  if (manifest) {
    const f = join(dir, 'centralu.app.json')
    const m = JSON.parse(readFileSync(f, 'utf8'))
    manifest(m)
    writeFileSync(f, JSON.stringify(m, null, 2))
  }
}
const tools = (body: string) => `serveStdio(() => {
  const server = new McpServer({ name: 'x', version: '0' }, { capabilities: { tools: {} } })
  ${body}
  return server
})`

describe('keeps recent errors per app', () => {
  it('failed to start — the reason and its stderr at the time', async () => {
    app('broken', `serveStdio(() => { throw new Error('forgot to define the tools') })`)
    const r = make()
    const t0 = Date.now()
    await expect(r.tools(ref('broken'))).rejects.toThrow()
    const { latest, recent } = r.errors(ref('broken'))
    expect(recent).toHaveLength(1)
    expect(latest).toMatchObject({ kind: 'start', tool: null, args: null, runId: null })
    expect(latest!.at).toBeGreaterThanOrEqual(t0)
    expect(latest!.message).not.toContain('--- stderr') // the reason and stderr are carried separately
    expect(latest!.stderr.join('\n')).toContain('forgot to define the tools')
    expect(latest!.text).toMatch(/^App App broken \(p1\/broken\): the app could not start \(\d{4}-/)
    expect(latest!.text).toContain('stderr (last lines):')
  })

  it('threw at the top level and ended — the shape it ended in is the reason', async () => {
    app('exits', `throw new Error('config.json is missing')`)
    const r = make()
    await expect(r.tools(ref('exits'))).rejects.toThrow()
    const { latest } = r.errors(ref('exits'))
    expect(latest).toMatchObject({ kind: 'start', message: 'exited before it was ready (code 1)' })
    expect(latest!.stderr.join('\n')).toContain('Error: config.json is missing')
  })

  it('a tool threw — which tool, with what arguments, and where (the stack is a line in server.mjs)', async () => {
    app('thrower', tools(`centralu.tool(server, 'save', { description: 'Save', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: false } }, async ({ text }) => {
    throw new Error('cannot save: ' + text)
  })`))
    const r = make()
    const out = await r.call(ref('thrower'), 'save', { text: 'hello' }, SESSION)
    expect(out.status).toBe('error')
    const latest = await until(() => r.errors(ref('thrower')).latest, (b) => !!b && b.stderr.some((l) => l.includes('server.mjs:')))
    expect(latest).toMatchObject({ kind: 'tool', tool: 'save', args: '{"text":"hello"}', runId: out.runId, message: 'cannot save: hello' })
    expect(latest!.stderr.join('\n')).toContain('[thrower] tool save threw: Error: cannot save: hello')
    expect(latest!.text).toContain('Tool: save\nArguments: {"text":"hello"}')
  })

  it('died mid-call — both the tool failure and the process ending are kept, and the most recent one is the ending', async () => {
    app('dies', tools(`centralu.tool(server, 'boom', { description: 'Dies', annotations: { readOnlyHint: true } }, async () => {
    console.error('about to run out of memory, pretending')
    process.exit(7)
  })`))
    const r = make()
    const out = await r.call(ref('dies'), 'boom', {}, SESSION)
    expect(out.status).toBe('error')
    const recent = await until(() => r.errors(ref('dies')).recent, (l) => l.some((b) => b.kind === 'crash'))
    const crash = recent.find((b) => b.kind === 'crash')!
    expect(crash.message).toBe('exited (code 7)')
    expect(crash.stderr).toContain('about to run out of memory, pretending')
    expect(recent.find((b) => b.kind === 'tool')).toMatchObject({ tool: 'boom' })
  })

  it('secrets stay out of the reason, the arguments and stderr alike', async () => {
    app(
      'secretive',
      tools(`centralu.tool(server, 'call_api', { description: 'Calls', inputSchema: z.object({ token: z.string() }), annotations: { readOnlyHint: true } }, async () => {
    console.error('using key ' + process.env.API_KEY)
    throw new Error('401 for key ' + process.env.API_KEY)
  })`),
      (m) => (m.secrets = ['API_KEY']),
    )
    const r = make()
    r.setSecret(ref('secretive'), 'API_KEY', 'sk-live-123456')
    await r.call(ref('secretive'), 'call_api', { token: 'sk-live-123456' }, SESSION)
    const latest = await until(() => r.errors(ref('secretive')).latest, (b) => !!b && b.stderr.some((l) => l.includes('using key')))
    expect(JSON.stringify(latest)).not.toContain('sk-live-123456')
    expect(latest!.message).toBe('401 for key [redacted:API_KEY]')
    expect(latest!.args).toBe('{"token":"[redacted:API_KEY]"}')
    expect(latest!.stderr).toContain('using key [redacted:API_KEY]')
  })

  it('a policy denial and a success are not errors — only the most recent ones are kept', async () => {
    app('mixed', tools(`centralu.tool(server, 'ok', { description: 'Fine', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'fine' }] }))
  centralu.tool(server, 'screen_only', { description: 'App only', annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['app'] } } }, async () => ({ content: [] }))
  centralu.tool(server, 'fail', { description: 'Fails', inputSchema: z.object({ n: z.number() }), annotations: { readOnlyHint: true } }, async ({ n }) => ({ content: [{ type: 'text', text: 'failure ' + n }], isError: true }))`))
    const r = make()
    expect((await r.call(ref('mixed'), 'ok', {}, SESSION)).status).toBe('ok')
    expect((await r.call(ref('mixed'), 'screen_only', {}, SESSION)).status).toBe('rejected')
    expect(r.errors(ref('mixed'))).toEqual({ latest: null, recent: [] })
    for (let n = 1; n <= 12; n++) await r.call(ref('mixed'), 'fail', { n }, SESSION)
    const { latest, recent } = r.errors(ref('mixed'))
    expect(recent).toHaveLength(10)
    expect(latest!.message).toBe('failure 12')
    expect(recent.at(-1)!.message).toBe('failure 3')
  })
})

describe('the bundle sent to the building session (C-6)', () => {
  it('the sent mark is set only once, survives the bundle being replaced when it re-captures stderr, and clearing it allows sending again', async () => {
    // one more line of stderr comes after the reply — this makes sure the code takes the path where
    // the bundle captures that line and gets **replaced with a new object**
    app('thrower', tools(`centralu.tool(server, 'save', { description: 'Save', annotations: { readOnlyHint: false } }, async () => {
    setTimeout(() => console.error('written after the reply'), 30)
    throw new Error('cannot save')
  })`))
    const r = make()
    await r.call(ref('thrower'), 'save', {}, SESSION)
    const at = r.errors(ref('thrower')).latest!.at
    expect(r.errors(ref('thrower')).latest?.sentAt).toBeNull()
    // right after the failure — sent 150ms before stderr is re-captured
    expect(r.markErrorSent(ref('thrower'), at)).toMatchObject({ kind: 'tool', at })
    expect(r.markErrorSent(ref('thrower'), at)).toBe('sent')
    await new Promise((res) => setTimeout(res, 300))
    expect(r.errors(ref('thrower')).latest).toMatchObject({ at, sentAt: expect.any(Number) })
    expect(r.errors(ref('thrower')).latest!.stderr.join('\n')).toContain('written after the reply')
    r.unmarkErrorSent(ref('thrower'), at)
    expect(r.errors(ref('thrower')).latest?.sentAt).toBeNull()
    expect(r.markErrorSent(ref('thrower'), at + 1)).toBeNull()
  })
})

describe('the list\'s lastErrorAt (C-6)', () => {
  it('even a read-only tool throwing updates the list\'s last-error time and wakes list listeners — it does not emit "changed"', async () => {
    app('reader', tools(`centralu.tool(server, 'get', { description: 'Read', annotations: { readOnlyHint: true } }, async () => {
    throw new Error('cannot read')
  })`))
    const changed: unknown[] = []
    rt = new ExternalApps({
      projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
      dataRoot,
      reservedIds: [],
      emitChanged: (ref) => changed.push(ref),
      timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, maxFailures: 5, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    })
    rt.refresh()
    await rt.tools(ref('reader'))
    const info = () => rt.list().find((a) => a.appId === 'reader')!
    expect(info().lastErrorAt).toBeUndefined()
    let heard = 0
    rt.onAppsChanged(() => void heard++)

    const out = await rt.call(ref('reader'), 'get', {}, SESSION)
    expect(out.status).toBe('error')
    await until(() => heard, (n) => n > 0)
    expect(info().lastErrorAt).toBe(rt.errors(ref('reader')).latest!.at)
    expect(changed).toEqual([])
  })
})

/**
 * A capability the person denied (D-4) — measured: a tool that stopped because the person pressed
 * Deny (or hit a remembered denial) showed up as an app error, complete with a stack trace and a
 * "Send to builder" button under the fixed screen. But the host already knows: the broker line
 * beneath that run got a `refused` from the person's answer. The bundle now carries that decision
 * — the screen states it plainly, and it is not sent to the building session
 * (builder-requests.test.ts).
 */
describe('a call stopped by a denied capability is not an app bug', () => {
  it('carries the decision whether it was a pressed Deny, a remembered denial, or the failure of an app that called the denied one — a real bug still comes through as itself', async () => {
    const summarize = `centralu.tool(server, 'summarize', { description: 'Sum up', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: 'text', text: String(await centralu.agent('sum up')) }],
  }))`
    app('notes', tools(summarize), (m) => (m.uses = { agent: true }))
    app(
      'board',
      tools(`centralu.tool(server, 'digest', { description: 'Digest', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: 'text', text: String(await centralu.callApp('notes', 'summarize')) }],
  }))
  centralu.tool(server, 'save', { description: 'Save', inputSchema: z.object({}), annotations: { readOnlyHint: false } }, async () => {
    throw new Error('disk full')
  })`),
      (m) => (m.uses = { apps: ['notes'] }),
    )
    const r = make()
    const asked: string[] = []
    // The person denies the agent, and allows board to call notes
    r.attachBrokerHost(fakeBrokerHost({ askCapability: async (q) => (asked.push(q.capability), q.capability.startsWith('agent:') ? 'deny' : 'allow') }))
    const denied = { appId: 'notes', projectId: 'p1', name: 'App notes', capability: 'agent:claude', text: 'run an agent (Claude Code) in a new session' }

    const first = await r.call(ref('notes'), 'summarize', {}, SESSION)
    expect(first.status).toBe('error')
    expect(r.errors(ref('notes')).latest).toMatchObject({ kind: 'tool', tool: 'summarize', runId: first.runId, denied })

    // A remembered denial — does not ask again, and it is the same decision
    const again = await r.call(ref('notes'), 'summarize', {}, SESSION)
    expect(asked).toEqual(['agent:claude'])
    expect(r.errors(ref('notes')).latest).toMatchObject({ runId: again.runId, denied })

    // board's failure from calling notes also has that denial as its reason
    const nested = await r.call(ref('board'), 'digest', {}, SESSION)
    expect(nested.status).toBe('error')
    expect(r.errors(ref('board')).latest).toMatchObject({ tool: 'digest', runId: nested.runId, denied })

    // A real bug is unchanged from before — no decision is attached
    const bug = await r.call(ref('board'), 'save', {}, SESSION)
    expect(bug.status).toBe('error')
    expect(r.errors(ref('board')).latest).toMatchObject({ tool: 'save', runId: bug.runId, denied: null })
  })
})
