import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, type AdapterCapabilities, type SessionInfo, type ToolName } from '@cc/protocol'
import { storeRunLedger } from '../../app-run-ledger.js'
import { ExternalApps } from '../../apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from '../../apps/external/test-helpers.js'
import { Store } from '../../dev-services/store.js'
import { createRpcHandler } from '../../rpc.js'
import { SessionManager } from '../../sessions/manager.js'
import { FIXTURE_APP } from '../../sessions/session-apps.test-helpers.js'
import { HostServer } from '../../transport/server.js'
import type { AgentAdapter, CreateSessionOpts, SessionHandle } from '../contract.js'
import { bridgeAddress } from '../../keeper-control.js'
import { bridgeToken } from '../../transport/bridge-token.js'
import { bridgePath } from '../bridge-path.js'
import { AcpSession } from '../acp/session.js'

/**
 * Tests the stdio bridge Codex and ACP agents reach Centralu through, **as a whole bridge**, for apps (#2231) — a real bridge
 * process, a real host WS server, a real manager, runtime and app. In Codex's spot, the test itself stands in and speaks MCP
 * over stdio.
 *
 * Why Codex itself is not used: what is checked is what happens once Codex starts this bridge and sends tools/list and
 * tools/call — whether an `app` call passes through the host's session gate, its card, and reaches the one path into the
 * runtime.
 */

class Handle implements SessionHandle {
  externalId = 'ext'
  constructor(readonly sessionId: string) {}
  send() {}
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
}

/** An adapter that only stands up a handle — the bridge's gate only opens for a live session */
class NullAdapter implements AgentAdapter {
  constructor(readonly tool: ToolName = 'codex') {}
  descriptor = { name: 'codex', label: 'Codex', mark: 'X', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: true, backgroundTasks: false,
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts) {
    if (opts.centraluBridge) handedBridge.set(opts.sessionId, opts.centraluBridge)
    return new Handle(opts.sessionId)
  }
}

const TOKEN = 'bridge-test-token-0123'
/** What the manager handed the adapter to start each session's bridge with */
const handedBridge = new Map<string, { url: string; token: string }>()
let root = ''
let store: Store
let rt: ExternalApps
let mgr: SessionManager
let server: HostServer
let port = 0
/** The host's RPC handler, called directly: what the person's own app can do */
let call: (method: string, params: unknown) => Promise<unknown>
let projectId = ''
let bridges: ChildProcessWithoutNullStreams[] = []
/** A gate file that releases the `hold` tool */
let gate = ''

/**
 * Starts one bridge and speaks to it as if it were Codex. It holds the credential the adapter was
 * handed for that session (one made the same way for a session that never started).
 */
function bridge(sessionId: string, env: Record<string, string> = {}) {
  const credential = handedBridge.get(sessionId)?.token ?? bridgeToken(TOKEN, sessionId)
  const child = spawn(process.execPath, [bridgePath()], {
    env: { ...process.env, CC_HOST_URL: `ws://127.0.0.1:${port}`, CC_BRIDGE_TOKEN: credential, CC_SESSION_ID: sessionId, ...env },
  })
  bridges.push(child)
  const got: { id?: number; result?: Record<string, unknown>; error?: { message: string } }[] = []
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += String(chunk)
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) got.push(JSON.parse(line))
    }
  })
  let id = 0
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const my = ++id
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`)
    return (await until(() => got.find((m) => m.id === my), (m) => m !== undefined, 15_000))!
  }
  return { request }
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-bridge-')))
  const proj = join(root, 'proj')
  const dataRoot = join(root, 'data')
  vi.stubEnv('CC_DATA_DIR', dataRoot)
  mkdirSync(proj)
  mkdirSync(dataRoot)
  gate = join(root, 'notes.gate')
  plantApp(join(proj, ...PROJECT_APPS), 'notes', { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach', '--gate', gate] } })
  plantApp(join(dataRoot, 'apps'), 'helper', { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } })

  store = new Store()
  // `opencode` stands for an ACP agent, which reaches Centralu's tools through the same bridge (#2231)
  const adapters = new Map<ToolName, AgentAdapter>([['codex', new NullAdapter()], ['opencode', new NullAdapter('opencode')]])
  // The host's own wiring (main.ts): each session's bridge gets its own credential, not TOKEN
  mgr = new SessionManager(store, adapters, () => {}, (sessionId) => bridgeAddress(undefined, port, TOKEN, sessionId))
  rt = new ExternalApps({ projects: () => store.projects.projectRoots(), dataRoot, reservedIds: ['control'], runs: storeRunLedger(store) })
  mgr.apps.useExternalApps(rt)
  const rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  call = (m, p) => rpc(m as never, p)
  server = new HostServer({ port: 0, token: TOKEN, onRpc: (m, p) => rpc(m as never, p) })
  port = await server.listen()
  projectId = ((await rpc('projects.add', { path: proj })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
})

afterEach(async () => {
  for (const b of bridges) b.kill()
  bridges = []
  handedBridge.clear()
  await mgr.tenure.disposeAll()
  await rt.dispose()
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

const worker = async (permissionPreset: 'normal' | 'auto' = 'normal', tool: ToolName = 'codex') =>
  (await mgr.createSession({ projectId, cwd: root, tool, permissionPreset })) as SessionInfo

/** An `app` call as Codex sends it through the bridge */
const appCall = (app: string, tool: string, args: Record<string, unknown> = {}) => ({ name: 'app', arguments: { action: 'call', app, tool, args } })

describe("the bridge — apps through Centralu's app tool, end to end, seen from Codex's own spot (#2231)", () => {
  it("the bridge's tool list has the app tool, and listing one app gives its agent tools with the read-only mark", async () => {
    const s = await worker()
    const { request } = bridge(s.id)
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0' } })
    expect(init.result).toMatchObject({ serverInfo: { name: 'centralu' }, capabilities: { tools: {} } })
    const list = await request('tools/list')
    expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain('app')
    const notes = await request('tools/call', { name: 'app', arguments: { action: 'list', app: 'notes' } })
    const text = JSON.stringify(notes.result)
    expect(text).toContain('peek (reads)')
    expect(text).not.toContain('app_only')
  })

  it("an app call reaches the runtime with that session as the caller, is logged, and comes back as the app's own result", async () => {
    const s = await worker('auto')
    const { request } = bridge(s.id)
    await request('initialize', {})
    const out = await request('tools/call', appCall('notes', 'poke', { to: 5 }))
    expect(out.result).toMatchObject({ content: [{ type: 'text', text: 'poked 5' }], isError: false })
    expect(rt.runs({ projectId, appId: 'notes' }).map((r) => [r.tool, r.callerKind, r.callerSessionId])).toEqual([['poke', 'session', s.id]])
  })

  it("an app the session does not have cannot be called — the host decides this, not the bridge", async () => {
    const s = await worker('auto')
    const { request } = bridge(s.id)
    await request('initialize', {})
    // A user-folder app is only the Assistant's
    const out = await request('tools/call', appCall('helper', 'peek'))
    expect(out.result).toMatchObject({ isError: true })
    expect(JSON.stringify(out.result)).toContain('This session has no app named \\"helper\\"')
    expect(rt.runs({ projectId: null, appId: 'helper' })).toEqual([])
  })

  it('cannot call under the name of a session the host does not have', async () => {
    const { request } = bridge('00000000-0000-4000-8000-000000000000')
    await request('initialize', {})
    const out = await request('tools/call', appCall('notes', 'peek'))
    expect(out.result).toMatchObject({ isError: true })
    expect(rt.runs({ projectId, appId: 'notes' })).toEqual([])
  })

  it("under normal, a write asks the person with the host's card in the session; their Allow runs it, and a read never asks", async () => {
    const s = await worker()
    const { request } = bridge(s.id)
    await request('initialize', {})
    expect((await request('tools/call', appCall('notes', 'peek'))).result).toMatchObject({ isError: false })
    const pending = request('tools/call', appCall('notes', 'poke', { to: 4 }))
    const card = await until(() => mgr.listSessions().find((x) => x.id === s.id)?.pendingApproval, (c) => c !== undefined && c !== null, 10_000)
    expect(card!.detail).toMatchObject({ kind: 'other', raw: expect.stringContaining('notes: poke {"to":4}') })
    expect(rt.runs({ projectId, appId: 'notes' }).map((r) => r.tool)).toEqual(['peek'])
    await call('agents.respondApproval', { sessionId: s.id, requestId: card!.requestId, decision: 'allow' })
    expect((await pending).result).toMatchObject({ content: [{ type: 'text', text: 'poked 4' }], isError: false })
  })
})

/**
 * An ACP agent (opencode, gemini and the like) is given Centralu's tools through this same bridge, so since #2231 it reaches
 * the project's apps as Codex does, under the same host gate and the same presets. Its handle cannot say whether the person
 * bypasses approvals (`AcpSession` has no `bypassesApprovals`), so under `normal` its writes ask.
 */
describe('the bridge — an ACP agent reaches apps through the same host gate and card (#2231)', () => {
  it('under normal, its write raises the host card and runs only on Allow; a Deny runs nothing', async () => {
    expect('bypassesApprovals' in AcpSession.prototype).toBe(false)
    const s = await worker('normal', 'opencode')
    const { request } = bridge(s.id)
    await request('initialize', {})
    const denied = request('tools/call', appCall('notes', 'poke', { to: 6 }))
    const card = await until(() => mgr.listSessions().find((x) => x.id === s.id)?.pendingApproval, (c) => c !== undefined && c !== null, 10_000)
    await call('agents.respondApproval', { sessionId: s.id, requestId: card!.requestId, decision: 'deny' })
    expect((await denied).result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'The person denied this call. Nothing ran.' }] })
    expect(rt.runs({ projectId, appId: 'notes' })).toEqual([])
  })
})

/** Speaks to the host directly over WebSocket with `token`, the way any other process could */
async function rawClient(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: { kind: string; id?: string; ok?: boolean; error?: { message: string } }[] = []
  ws.on('message', (d) => frames.push(JSON.parse(String(d))))
  await new Promise<void>((r) => ws.once('open', () => r()))
  ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION }))
  let n = 0
  return {
    rpc: async (method: string, params: unknown) => {
      const id = `c${++n}`
      ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
      return (await until(() => frames.find((f) => f.kind === 'res' && f.id === id), (f) => f !== undefined, 5_000))!
    },
    close: () => ws.close(),
  }
}

/**
 * The bridge's credential (#382, owner question 4). The bridge's environment can be read by any
 * process of the same user (`ps eww`, measured on macOS 27.0.1), so this is what such a process
 * would get by reading it.
 */
describe("the bridge — its credential opens only its own session's bridge calls (#382)", () => {
  it("the adapter is handed a credential that is not the host's token, and a bridge holding it reaches the app", async () => {
    const s = await worker('auto')
    const handed = handedBridge.get(s.id)!
    expect(handed.token).not.toContain(TOKEN)
    const { request } = bridge(s.id)
    await request('initialize', {})
    const out = await request('tools/call', appCall('notes', 'poke', { to: 3 }))
    expect(out.result).toMatchObject({ content: [{ type: 'text', text: 'poked 3' }], isError: false })
  })

  it("a bridge holding one session's credential cannot call as another session", async () => {
    const a = await worker('auto')
    const b = await worker('auto')
    const { request } = bridge(b.id, { CC_BRIDGE_TOKEN: handedBridge.get(a.id)!.token })
    await request('initialize', {})
    const out = await request('tools/call', appCall('notes', 'poke', { to: 1 }))
    expect(out.result).toMatchObject({ isError: true })
    expect(JSON.stringify(out.result)).toContain('for another session')
    expect(rt.runs({ projectId, appId: 'notes' })).toEqual([])
  })

  it("cannot set its session's preset to auto or change a project's trust, nor call the removed app bridge methods", async () => {
    const s = await worker()
    const stolen = await rawClient(handedBridge.get(s.id)!.token)
    const preset = await stolen.rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })
    const trust = await stolen.rpc('projects.setTrusted', { projectId, trusted: false })
    const old = await stolen.rpc('apps.sessionCall', { sessionId: s.id, server: 'app-notes', name: 'poke', args: { to: 1 } })
    stolen.close()
    expect(preset).toMatchObject({ ok: false, error: { message: expect.stringContaining('cannot call agents.updateSettings') } })
    expect(trust).toMatchObject({ ok: false, error: { message: expect.stringContaining('cannot call projects.setTrusted') } })
    expect(old).toMatchObject({ ok: false })
    const sessions = (await call('sessions.list', {})) as SessionInfo[]
    expect(sessions.find((x) => x.id === s.id)?.permissionPreset).toBe('normal')
    const projects = (await call('projects.list', {})) as { id: string; trusted: boolean }[]
    expect(projects.find((p) => p.id === projectId)?.trusted).toBe(true)
    expect(rt.runs({ projectId, appId: 'notes' })).toEqual([])
  })
})
