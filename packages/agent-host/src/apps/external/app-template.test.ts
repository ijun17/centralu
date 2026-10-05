import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveBroker, type BrokerHandler } from './broker.js'
import { ExternalApps, resultText, type AgentRunRequest, type AppRef, type BrokerHost } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { StreamTransport } from './stream-transport.js'
import { fakeBrokerHost, until } from './test-helpers.js'

/**
 * The app template and its runtime (M4 C-1) — exercised by starting a template-scaffolded app with a
 * **real `node`.**
 *
 * This checks the product's template against what spike S-6 already passed (it starts with no
 * install) and against what tripped up an agent back then (a start-up error returned nothing but
 * -32603, with not a single line on stderr, and the stack trace inside the bundled runtime was
 * unreadable).
 */

const BUILD_SCRIPT = fileURLToPath(new URL('../../../scripts/build-app-runtime.mjs', import.meta.url))

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps | null = null

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-template-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmSync(root, { recursive: true, force: true })
})

/** Expands the template into a project app's location — the same function creation (C-1b) uses */
function scaffold(id: string, name = 'Counter'): string {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name, description: `${name} app` })
  return dir
}

function runtime(timing: Record<string, number> = {}) {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  return rt
}
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })

/** A server.mjs that uses the template runtime — used to replace the template's own when building a broken or special-purpose app */
const serverUsing = (body: string) => `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'
${body}
`

describe('the expanded template starts with node alone', () => {
  it('a clean copy — no node_modules or package.json above it, an environment of PATH alone — answers the tool list and keeps state in the data folder', async () => {
    const dir = scaffold('counter')
    // Only if there is no trace of an install anywhere above this copy is "no install" actually true
    const above: string[] = []
    for (let d = dir; ; d = dirname(d)) {
      for (const f of ['node_modules', 'package.json']) if (existsSync(join(d, f))) above.push(join(d, f))
      if (d === dirname(d)) break
    }
    expect(above).toEqual([])
    const src = readFileSync(join(dir, 'server.mjs'), 'utf8')
    const bare = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!).filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
    expect(bare).toEqual([])

    const data = join(root, 'app-data')
    const connect = async () => {
      const c = new Client({ name: 'host', version: '0' }, { versionNegotiation: { mode: 'auto' } })
      await c.connect(new StdioClientTransport({ command: 'node', args: ['--enable-source-maps', 'server.mjs'], cwd: dir, env: { PATH: process.env.PATH!, CENTRALU_APP_DATA: data }, stderr: 'pipe' }))
      return c
    }
    const c = await connect()
    const tools = (await c.listTools()).tools
    expect(tools.map((t) => t.name)).toEqual(['show', 'increment', 'reset'])
    const show = tools.find((t) => t.name === 'show')!
    expect(show._meta).toMatchObject({ ui: { resourceUri: 'ui://counter/index.html' } })
    expect(show.annotations).toMatchObject({ readOnlyHint: true })
    expect(tools.find((t) => t.name === 'reset')!._meta).toMatchObject({ ui: { visibility: ['app'] } })

    const read = await c.readResource({ uri: 'ui://counter/index.html' })
    const html = (read.contents[0] as { text: string }).text
    expect(read.contents[0]!.mimeType).toBe('text/html;profile=mcp-app')
    // The bridge was injected — the placeholder tag is gone
    expect(html).toContain('McpApp')
    expect(html).not.toContain('centralu:mcp-app.js"></script>')
    expect(html).toContain('centralu/notifications/changed')

    expect((await c.callTool({ name: 'increment', arguments: { by: 2 } })).structuredContent).toEqual({ count: 2 })
    await c.close()
    // State lives in the data folder, not the app folder — it survives even after restarting
    expect(JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))).toEqual({ count: 2 })
    expect(readdirSync(dir).sort()).toEqual(['.gitattributes', 'AGENTS.md', 'CLAUDE.md', 'centralu.app.json', 'runtime', 'server.mjs', 'ui'])
    const again = await connect()
    expect((await again.callTool({ name: 'show', arguments: {} })).structuredContent).toEqual({ count: 2 })
    await again.close()
  })

  it('the expanded folder fills in the name, marks itself as a build artifact, and keeps the runtime byte for byte', () => {
    const dir = scaffold('notes', 'Team <Notes> "board"')
    const manifest = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8'))
    expect(manifest).toMatchObject({ id: 'notes', name: 'Team <Notes> "board"', home: 'show' })
    expect(readFileSync(join(dir, 'ui', 'index.html'), 'utf8')).toContain('<title>Team &lt;Notes&gt; &quot;board&quot;</title>')
    expect(readFileSync(join(dir, 'server.mjs'), 'utf8')).toContain("const UI = 'ui://notes/index.html'")
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toMatch(/^# Team <Notes> "board" — a Centralu app/)
    expect(readFileSync(join(dir, '.gitattributes'), 'utf8')).toContain('runtime/** linguist-generated=true -diff')
    for (const f of ['centralu-app-runtime.mjs', 'centralu-app-runtime.mjs.map', 'mcp-app.js', 'THIRD_PARTY_LICENSES.txt']) {
      expect(readFileSync(join(dir, 'runtime', f)).equals(readFileSync(join(appTemplateDir(), 'runtime', f)))).toBe(true)
    }
    // No file is left with a placeholder still in it
    const leftovers = ['server.mjs', 'AGENTS.md', 'ui/index.html', 'centralu.app.json'].filter((f) => readFileSync(join(dir, f), 'utf8').includes('{{'))
    expect(leftovers).toEqual([])
  })
})

describe('a broken app states the reason', () => {
  it('a server.mjs that throws while registering tools — the error is recorded on stderr, and the app stops holding that reason', async () => {
    const dir = scaffold('broken')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'broken', version: '0' }, { capabilities: { tools: {} } })
  throw new Error('boom while registering tools')
})`),
    )
    const r = runtime()
    for (let i = 0; i < 3; i++) await expect(r.tools(ref('broken'))).rejects.toThrow(/boom while registering tools/)
    const info = r.list().find((a) => a.appId === 'broken')!
    expect(info.status).toBe('failed')
    expect(info.error).toContain('--- stderr (last lines) ---')
    expect(info.error).toContain('the server could not start — setting up the server threw')
    expect(info.error).toContain('boom while registering tools')
    // An error in the app's own code is recorded as file:line
    expect(info.error).toMatch(/server\.mjs:\d+/)
  })

  it('a server.mjs that throws at the top level — the reason is that it ended before it was ready, and that error', async () => {
    const dir = scaffold('toplevel')
    writeFileSync(join(dir, 'server.mjs'), serverUsing(`throw new Error('cannot read my config')`))
    const r = runtime({ maxFailures: 1 })
    await expect(r.tools(ref('toplevel'))).rejects.toThrow(/exited before it was ready/)
    const info = r.list().find((a) => a.appId === 'toplevel')!
    expect(info.status).toBe('failed')
    expect(info.error).toContain('cannot read my config')
  })

  it('even an error inside the bundled runtime is read back under its original file name (source maps)', async () => {
    scaffold('mapped')
    // The state file in the data folder is corrupt — the error happens inside the runtime's readJson
    const data = join(dataRoot, 'app-data', 'p1', 'mapped')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'state.json'), '{ not json')
    const r = runtime({ maxFailures: 1 })
    await expect(r.tools(ref('mapped'))).rejects.toThrow()
    const error = r.list().find((a) => a.appId === 'mapped')!.error!
    expect(error).toContain('is not valid JSON')
    // The original file is named by its path on disk, so with the OS separator (vendored\centralu\… on Windows)
    expect(error).toMatch(/vendored[\\/]centralu[\\/]centralu\.mjs:\d+/)
    // The line that threw is also printed as its original line — a bundled single line (hundreds of characters) never eats a whole slot of the stderr tail
    expect(error).toContain('throw new Error(`centralu.readJson:')
    expect(error).not.toContain('centralu-app-runtime.mjs')
  })
})

describe('the helper', () => {
  it('accepts a screen-less tool too — whether or not it has an input schema', async () => {
    const dir = scaffold('plain')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'plain', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'add', { description: 'Add', inputSchema: z.object({ a: z.number(), b: z.number() }), annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }))
  centralu.tool(server, 'ping', { description: 'Ping', annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  return server
})`),
    )
    const r = runtime()
    expect((await r.tools(ref('plain'))).map((t) => t.name)).toEqual(['add', 'ping'])
    const add = await r.call(ref('plain'), 'add', { a: 2, b: 3 }, { kind: 'session', sessionId: 's1' })
    expect([add.status, resultText(add.result!)]).toEqual(['ok', '5'])
    const ping = await r.call(ref('plain'), 'ping', {}, { kind: 'session', sessionId: 's1' })
    expect([ping.status, resultText(ping.result!)]).toEqual(['ok', 'pong'])
  })

  it('centralu.agent relays the desk\'s denial verbatim — in both the tool\'s failure result and stderr (an app that never declared it)', async () => {
    const dir = scaffold('asker')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'asker', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'summarize', { description: 'Summarize', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: await centralu.agent('summarize: ' + text, { schema: { type: 'object' } }) }] }))
  centralu.tool(server, 'ask_other', { description: 'Ask another app', annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: String(await centralu.callApp('other', 'echo', { text: 'hi' })) }] }))
  return server
})`),
    )
    const r = runtime()
    const out = await r.call(ref('asker'), 'summarize', { text: 'hello' }, { kind: 'session', sessionId: 's1' })
    expect(out.status).toBe('error')
    expect(resultText(out.result!)).toBe(
      'centralu.agent() failed: run_agent refused: this app did not declare "uses": { "agent": … } in centralu.app.json — an app may run an agent only if its manifest says so',
    )
    const other = await r.call(ref('asker'), 'ask_other', {}, { kind: 'session', sessionId: 's1' })
    expect(resultText(other.result!)).toContain('centralu.callApp("other", "echo") failed: call_app refused: "other" is not in this app\'s "uses.apps"')
    const log = readFileSync(join(dataRoot, 'app-logs', 'p1', 'asker.log'), 'utf8')
    expect(log).toContain('[centralu] centralu.agent() failed: run_agent refused: this app did not declare')
  })
})

/**
 * The helper that requests an agent (M4 D-1) — the path from the template's `centralu.agent()` to the
 * desk. The body of it (a session) is the host's core's job, so here a fake host receives it instead.
 * The session side is exercised with a real manager in sessions/app-agents.test.ts.
 */
describe('centralu.agent (D-1)', () => {
  const asker = (id: string, uses: unknown) => {
    const dir = scaffold(id)
    const manifest = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8'))
    writeFileSync(join(dir, 'centralu.app.json'), JSON.stringify({ ...manifest, uses }, null, 2))
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: '${id}', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'summarize', { description: 'Summarize', inputSchema: z.object({ text: z.string(), tool: z.string().optional(), schema: z.boolean().optional() }), annotations: { readOnlyHint: true } },
    async ({ text, tool, schema }) => {
      const answer = await centralu.agent('summarize: ' + text, { ...(tool ? { tool } : {}), ...(schema ? { schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } : {}) })
      return typeof answer === 'string' ? { content: [{ type: 'text', text: answer }] } : { content: [{ type: 'text', text: 'json' }], structuredContent: answer }
    })
  return server
})`),
    )
    return dir
  }

  it('a declaring app\'s request reaches the host\'s agent, and with a schema, validated JSON comes back as structuredContent', async () => {
    asker('asker', { agent: true })
    const seen: AgentRunRequest[] = []
    const r = runtime()
    const host: BrokerHost = fakeBrokerHost({
      runAgent: async (req) => {
        seen.push(req)
        return req.schema ? { sessionId: 's-agent', text: 'Here you go.', output: { summary: 'short' } } : { sessionId: 's-agent', text: 'A short summary.' }
      },
    })
    r.attachBrokerHost(host)
    const plain = await r.call(ref('asker'), 'summarize', { text: 'hello' }, { kind: 'session', sessionId: 's1' })
    expect([plain.status, resultText(plain.result!)]).toEqual(['ok', 'A short summary.'])
    const json = await r.call(ref('asker'), 'summarize', { text: 'hello', schema: true }, { kind: 'session', sessionId: 's1' })
    expect([json.status, json.result!.structuredContent]).toEqual(['ok', { summary: 'short' }])
    expect(seen.map((q) => [q.app, q.appName, q.tool, q.prompt, q.schema ?? null])).toEqual([
      [ref('asker'), 'Counter', 'claude', 'summarize: hello', null],
      [ref('asker'), 'Counter', 'claude', 'summarize: hello', { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }],
    ])
  })

  it('an answer that does not match the schema is never handed to the app — states the reason and the answer received', async () => {
    asker('asker', { agent: true })
    const r = runtime()
    r.attachBrokerHost(fakeBrokerHost({ runAgent: async () => ({ sessionId: 's', text: '', output: { summary: 42 } }) }))
    const out = await r.call(ref('asker'), 'summarize', { text: 'x', schema: true }, { kind: 'session', sessionId: 's1' })
    expect(out.status).toBe('error')
    expect(resultText(out.result!)).toContain("centralu.agent() failed: run_agent: the agent's answer does not match the schema")
    expect(resultText(out.result!)).toContain('The answer was: {"summary":42}')
  })

  it('only tools the declaration allows — true allows only the default agent, a list allows only what it names', async () => {
    asker('any', { agent: true })
    asker('listed', { agent: ['codex'] })
    const tools: string[] = []
    const r = runtime()
    r.attachBrokerHost(fakeBrokerHost({ runAgent: async (req) => (tools.push(req.tool), { sessionId: 's', text: `ran on ${req.tool}` }) }))
    const s1 = { kind: 'session' as const, sessionId: 's1' }
    const byName = await r.call(ref('any'), 'summarize', { text: 'x', tool: 'codex' }, s1)
    expect(resultText(byName.result!)).toContain('run_agent refused: this app declared "agent": true, which lets it use the person\'s default agent (claude) only')
    expect(resultText((await r.call(ref('listed'), 'summarize', { text: 'x', tool: 'codex' }, s1)).result!)).toBe('ran on codex')
    // If the default tool (claude) is not in the list, a request naming no tool falls back to the list's first tool — it never resolves outside the declaration
    expect(resultText((await r.call(ref('listed'), 'summarize', { text: 'x' }, s1)).result!)).toBe('ran on codex')
    const outside = await r.call(ref('listed'), 'summarize', { text: 'x', tool: 'claude' }, s1)
    expect(resultText(outside.result!)).toContain('run_agent refused: claude is not in this app\'s "uses.agent" (codex)')
    expect(tools).toEqual(['codex', 'codex'])
  })

  /**
   * A long-running request — the helper gives up after IDLE_MS of silence. The host's keepalive
   * notification resets that timer, and the helper relays that same beat up as progress on the call it
   * is handling (so the host → app call is not cut off either). The test shortens IDLE_MS.
   */
  const longRun = async (keepaliveMs: number) => {
    const dir = asker('waiter', { agent: true })
    const child = spawn('node', ['server.mjs'], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe', 'overlapped'], // as the host spawns it (app-process.ts)
      env: { PATH: process.env.PATH!, CENTRALU_BROKER_IDLE_MS: '400' },
    })
    const fd3 = child.stdio[3] as Socket
    const slow: BrokerHandler = () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: 'text', text: 'finally done' }] }), 1_200))
    const closeBroker = serveBroker(fd3, { openRun: () => new AbortController().signal, note: () => {}, refused: () => {} }, slow, { keepaliveMs })
    const relayed: unknown[] = []
    try {
      const c = new Client({ name: 'host', version: '0' }, { versionNegotiation: { mode: 'auto' } })
      await c.connect(new StreamTransport(child.stdout!, child.stdin!, { pid: child.pid ?? null }))
      const r = await c.callTool(
        { name: 'summarize', arguments: { text: 'long' }, _meta: { 'centralu/runId': 'run_test' } },
        { onprogress: (p) => relayed.push(p) },
      )
      return { text: resultText(r as never), relayed }
    } finally {
      closeBroker()
      fd3.destroy()
      // Waited for: the app's working directory is its folder, which Windows will not delete while the process runs (#14)
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }

  it('while the host is sending a beat, this waits even past the cap, and relays that beat up to the caller', async () => {
    const { text, relayed } = await longRun(100)
    expect(text).toBe('finally done')
    expect(relayed.length).toBeGreaterThan(3)
  })

  it('a host → app call also survives past its own cap — a beat the helper relays up resets the host\'s timer too', async () => {
    asker('asker', { agent: true })
    // Shortens the cap on a host → app call to 0.8 seconds, while the agent takes 2 seconds
    const r = runtime({ callTimeoutMs: 800, brokerKeepaliveMs: 100 })
    r.attachBrokerHost(
      fakeBrokerHost({ runAgent: () => new Promise((resolve) => setTimeout(() => resolve({ sessionId: 's', text: 'slow but done' }), 2_000)) }),
    )
    const out = await r.call(ref('asker'), 'summarize', { text: 'x' }, { kind: 'session', sessionId: 's1' })
    expect([out.status, out.error, out.result && resultText(out.result)]).toEqual(['ok', null, 'slow but done'])
  })

  it('if the host stays silent, the helper gives up at the cap and states the reason', async () => {
    const { text } = await longRun(60_000)
    expect(text).toMatch(/^centralu\.agent\(\) failed: Centralu said nothing about run_agent for 0\.4s/)
  })
})

describe('the shutdown promise (S-5)', () => {
  it('even an app that has used the broker once ends when stdin closes — even if the host never closes fd 3', async () => {
    const dir = scaffold('closer')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'closer', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'ask', { description: 'Ask', annotations: { readOnlyHint: true } }, async () => {
    try { return { content: [{ type: 'text', text: String(await centralu.agent('x')) }] } } catch (e) { return { content: [{ type: 'text', text: e.message }] } }
  })
  return server
})`),
    )
    const child = spawn('node', ['server.mjs'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe', 'overlapped'], env: { PATH: process.env.PATH! } })
    const fd3 = child.stdio[3] as Socket
    // A real broker server on fd 3, playing the host's part — answers that any run id is open, and the desk answers with one line
    const closeBroker = serveBroker(fd3, { openRun: () => new AbortController().signal, note: () => {}, refused: () => {} }, async () => ({
      content: [{ type: 'text', text: 'the agent answered' }],
    }))
    let exited = false
    child.on('exit', () => (exited = true))
    try {
      const c = new Client({ name: 'host', version: '0' }, { versionNegotiation: { mode: 'auto' } })
      await c.connect(new StreamTransport(child.stdout!, child.stdin!, { pid: child.pid ?? null }))
      const r = await c.callTool({ name: 'ask', arguments: {}, _meta: { 'centralu/runId': 'run_test' } })
      expect(resultText(r as never)).toBe('the agent answered')

      // Closes only stdin — fd 3 is left open on the host side
      child.stdin!.end()
      await until(() => exited, (x) => x, 3_000)
    } finally {
      closeBroker()
      fd3.destroy()
      if (!exited) child.kill('SIGKILL')
    }
  })
})

describe('the repository\'s own script rebuilds the runtime byte for byte', () => {
  it('the committed runtime = the current source bundled with the version-pinned tool (MIT only)', () => {
    const out = execFileSync(process.execPath, [BUILD_SCRIPT, '--check'], { encoding: 'utf8' })
    expect(out).toContain('up to date')
    const licenses = readFileSync(join(appTemplateDir(), 'runtime', 'THIRD_PARTY_LICENSES.txt'), 'utf8')
    const heads = [...licenses.matchAll(/^==== (.+) \((.+)\) ====$/gm)].map((m) => m[2])
    expect(heads.length).toBeGreaterThan(3)
    expect(new Set(heads)).toEqual(new Set(['MIT']))
  })
})
