import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
 * Codex의 앱 다리를 **다리째** 본다 (M4 A-5) — 진짜 다리 프로세스, 진짜 host WS 서버, 진짜 매니저와
 * 런타임과 앱. Codex 자리에는 테스트가 서서 stdio로 MCP를 말한다.
 *
 * Codex를 쓰지 않는 이유: 로그아웃 상태라 실행할 수 없다(플랜 S-3). 그래서 "Codex가 이 다리를
 * 띄우고 tools/list·tools/call을 보낸다"는 가정이고, 여기서 보는 것은 그 뒤 — 다리가 host의 세션
 * 문을 지나 런타임의 한 길에 닿는가 — 다.
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

/** 핸들만 세워 주는 어댑터 — 세션이 살아 있어야 다리의 문이 열린다 */
class NullAdapter implements AgentAdapter {
  tool: ToolName = 'codex'
  descriptor = { name: 'codex', label: 'Codex', mark: 'X', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: true,
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

/** 다리 하나를 띄우고 Codex처럼 말을 건다 */
function bridge(sessionId: string, appServer: string) {
  const child = spawn(process.execPath, [bridgePath()], {
    env: { ...process.env, CC_HOST_URL: `ws://127.0.0.1:${port}`, CC_HOST_TOKEN: TOKEN, CC_SESSION_ID: sessionId, CC_APP_SERVER: appServer },
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
  plantApp(join(proj, ...PROJECT_APPS), 'notes', { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } })
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

describe('앱 다리 — Codex 자리에서 본 끝에서 끝', () => {
  it('다리의 tools/list는 host가 준 에이전트 도구를 주석째 그대로 내놓는다', async () => {
    const s = await worker()
    const { request } = bridge(s.id, 'app-notes')
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0' } })
    expect(init.result).toMatchObject({ serverInfo: { name: 'app-notes' }, capabilities: { tools: {} } })

    const list = await request('tools/list')
    const tools = (list.result as { tools: { name: string; annotations?: unknown }[] }).tools
    expect(tools.map((t) => t.name)).not.toContain('app_only')
    expect(tools.find((t) => t.name === 'peek')?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false })
  })

  it('다리의 tools/call은 그 세션을 호출자로 런타임에 닿고 기록된다', async () => {
    const s = await worker()
    const { request } = bridge(s.id, 'app-notes')
    await request('initialize', {})
    const out = await request('tools/call', { name: 'poke', arguments: { to: 5 } })
    expect(out.result).toMatchObject({ content: [{ type: 'text', text: 'poked 5' }], isError: false })
    expect(rt.runs({ projectId, appId: 'notes' }).map((r) => [r.tool, r.callerKind, r.callerSessionId])).toEqual([['poke', 'session', s.id]])
  })

  it('그 세션에 붙지 않은 앱의 다리는 아무것도 부르지 못한다 — 판정은 다리가 아니라 host가 한다', async () => {
    const s = await worker()
    // 사용자 폴더의 앱은 오케스트레이터에게만 붙는다
    const { request } = bridge(s.id, 'app-helper')
    await request('initialize', {})
    const list = await request('tools/list')
    expect(list.error?.message).toContain('이 세션에 붙은 앱이 아닙니다')
    const out = await request('tools/call', { name: 'peek', arguments: {} })
    expect(out.result).toMatchObject({ isError: true })
    expect(rt.runs({ projectId: null, appId: 'helper' })).toEqual([])
  })

  it('살아 있는 핸들이 없는 세션의 이름으로는 부를 수 없다', async () => {
    const { request } = bridge('00000000-0000-4000-8000-000000000000', 'app-notes')
    await request('initialize', {})
    const out = await request('tools/call', { name: 'peek', arguments: {} })
    expect(out.result).toMatchObject({ isError: true })
    expect(JSON.stringify(out.result)).toContain('실행 중이 아닙니다')
  })
})
