import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, SessionInfo, ToolName } from '@cc/protocol'
import { storeRunLedger } from '../../app-run-ledger.js'
import { ExternalApps } from '../../apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from '../../apps/external/test-helpers.js'
import { Store } from '../../dev-services/store.js'
import { createRpcHandler } from '../../rpc.js'
import { SessionManager } from '../../sessions/manager.js'
import { FIXTURE_APP } from '../../sessions/session-apps.test-helpers.js'
import { HostServer } from '../../transport/server.js'
import type { AgentAdapter, CreateSessionOpts, SessionHandle } from '../contract.js'
import { bridgePath } from './bridge-path.js'

/**
 * Tests Codex's app bridge **as a whole bridge** (M4 A-5) — a real bridge process, a real host WS
 * server, a real manager, runtime and app. In Codex's spot, the test itself stands in and speaks
 * MCP over stdio.
 *
 * Why Codex itself is not used: it cannot be run while logged out (plan S-3). So it is assumed
 * that "Codex starts this bridge and sends tools/list/tools/call," and what is checked here is
 * what happens after that — whether the bridge passes through the host's session gate and reaches
 * the one path into the runtime.
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
  tool: ToolName = 'codex'
  descriptor = { name: 'codex', label: 'Codex', mark: 'X', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: true, backgroundTasks: false,
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts) {
    return new Handle(opts.sessionId)
  }
}

const TOKEN = 'bridge-test-token-0123'
let root = ''
let store: Store
let rt: ExternalApps
let mgr: SessionManager
let server: HostServer
let port = 0
let projectId = ''
let bridges: ChildProcessWithoutNullStreams[] = []
/** A gate file that releases the `hold` tool */
let gate = ''

/** Starts one bridge and speaks to it as if it were Codex */
function bridge(sessionId: string, appServer: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [bridgePath()], {
    env: { ...process.env, CC_HOST_URL: `ws://127.0.0.1:${port}`, CC_HOST_TOKEN: TOKEN, CC_SESSION_ID: sessionId, CC_APP_SERVER: appServer, ...env },
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
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(proj)
  mkdirSync(dataRoot)
  gate = join(root, 'notes.gate')
  plantApp(join(proj, ...PROJECT_APPS), 'notes', { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach', '--gate', gate] } })
  plantApp(join(dataRoot, 'apps'), 'helper', { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } })

  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['codex', new NullAdapter()]])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: `ws://127.0.0.1:${port}`, token: TOKEN }))
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot, reservedIds: ['control'], runs: storeRunLedger(store) })
  mgr.useExternalApps(rt)
  const rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  server = new HostServer({ port: 0, token: TOKEN, onRpc: (m, p) => rpc(m as never, p) })
  port = await server.listen()
  projectId = ((await rpc('projects.add', { path: proj })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
})

afterEach(async () => {
  for (const b of bridges) b.kill()
  bridges = []
  await mgr.disposeAll()
  await rt.dispose()
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

const worker = async () =>
  (await mgr.createSession({ projectId, cwd: root, tool: 'codex', permissionPreset: 'normal' })) as SessionInfo

describe('app bridge — end to end, seen from Codex\'s own spot', () => {
  it("the bridge's tools/list surfaces the agent tools the host gave, annotations and all, unchanged", async () => {
    const s = await worker()
    const { request } = bridge(s.id, 'app-notes')
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0' } })
    expect(init.result).toMatchObject({ serverInfo: { name: 'app-notes' }, capabilities: { tools: {} } })

    const list = await request('tools/list')
    const tools = (list.result as { tools: { name: string; annotations?: unknown }[] }).tools
    expect(tools.map((t) => t.name)).not.toContain('app_only')
    expect(tools.find((t) => t.name === 'peek')?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false })
  })

  it("the bridge's tools/call reaches the runtime with that session as the caller, and is logged", async () => {
    const s = await worker()
    const { request } = bridge(s.id, 'app-notes')
    await request('initialize', {})
    const out = await request('tools/call', { name: 'poke', arguments: { to: 5 } })
    expect(out.result).toMatchObject({ content: [{ type: 'text', text: 'poked 5' }], isError: false })
    expect(rt.runs({ projectId, appId: 'notes' }).map((r) => [r.tool, r.callerKind, r.callerSessionId])).toEqual([['poke', 'session', s.id]])
  })

  it('the bridge of an app not attached to that session cannot call anything — the host decides this, not the bridge', async () => {
    const s = await worker()
    // A user-folder app is only attached to the orchestrator
    const { request } = bridge(s.id, 'app-helper')
    await request('initialize', {})
    const list = await request('tools/list')
    expect(list.error?.message).toContain('This app is not attached to this session')
    const out = await request('tools/call', { name: 'peek', arguments: {} })
    expect(out.result).toMatchObject({ isError: true })
    expect(rt.runs({ projectId: null, appId: 'helper' })).toEqual([])
  })

  it('cannot call under the name of a session with no live handle', async () => {
    const { request } = bridge('00000000-0000-4000-8000-000000000000', 'app-notes')
    await request('initialize', {})
    const out = await request('tools/call', { name: 'peek', arguments: {} })
    expect(out.result).toMatchObject({ isError: true })
    expect(JSON.stringify(out.result)).toContain('it is not running')
  })
})

/**
 * Tests a long-running call across the whole bridge. The product's own value (240 seconds) is
 * checked on the host side with a fake clock (long-calls.test.ts). Here, the value the bridge
 * carries is shrunk to 1 second and run end to end **with a real clock**: Codex's spot -> the
 * bridge -> the host's session gate -> returning early -> run_status.
 */
describe('app bridge — a long-running call', () => {
  it('once the wait time the bridge carries is exceeded, a run id comes back first, and the result is followed up through run_status', async () => {
    const s = await worker()
    const { request } = bridge(s.id, 'app-notes', { CC_APP_WAIT_MS: '1000' })
    await request('initialize', {})
    const first = await request('tools/call', { name: 'hold', arguments: {} })
    const runId = (first.result as { structuredContent: { runId: string; status: string } }).structuredContent.runId
    expect(first.result).toMatchObject({ isError: false, structuredContent: { status: 'running' } })
    expect(runId).toMatch(/^run_/)

    const running = await request('tools/call', { name: 'run_status', arguments: { run_id: runId } })
    expect(running.result).toMatchObject({ structuredContent: { runId, status: 'running' } })

    writeFileSync(gate, '')
    await until(() => rt.runs({ projectId, appId: 'notes' }).find((r) => r.id === runId)?.status, (st) => st === 'ok', 10_000)
    const done = await request('tools/call', { name: 'run_status', arguments: { run_id: runId } })
    expect(done.result).toMatchObject({ isError: false, structuredContent: { runId, status: 'ok' } })
    expect(JSON.stringify(done.result)).toContain('released')
  })
})
