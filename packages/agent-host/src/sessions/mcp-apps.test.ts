import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { storeRunLedger } from '../app-run-ledger.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FIXTURE_APP } from './session-apps.test-helpers.js'

/**
 * 사람이 승인한 MCP 서버는 사용자 폴더의 화면 없는 앱이 된다 (M4 A-7, 결정 8).
 *
 * 예전에는 승인하면 서버가 app_settings(`orchestrator_mcp_servers`)에 적히고 오케스트레이터의 MCP 설정에
 * 날것으로 실렸다 — 호출은 중개도 기록도 지나지 않았고, 목록도 지우기도 없었다. 여기서는 진짜 저장소·
 * 진짜 런타임·진짜 앱 프로세스(픽스처)로 본다. 어댑터만 가짜다: 받은 옵션을 적어 두고, 붙은 앱은 그
 * 옵션의 `apps`(세션 붙이기)로 부른다 — 어댑터의 대리 서버가 부르는 것과 같은 문이다.
 */

class Handle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string) {}
  send() {}
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
}

class CapturingAdapter implements AgentAdapter {
  tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false,
  }
  seen: CreateSessionOpts[] = []
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, _emit: EventSink) {
    this.seen.push(opts)
    return new Handle(opts.sessionId)
  }
  last(): CreateSessionOpts {
    return this.seen.at(-1)!
  }
}

const LEGACY_KEY = 'orchestrator_mcp_servers'
const SERVER = { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] }

let root = ''
let dataRoot = ''
let repo = ''
let store: Store
let rt: ExternalApps
let adapter: CapturingAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>

/** 매니저와 런타임을 잇는다 — 옛 명부를 옮기는 것도 이 순간이다(host의 main과 같은 자리) */
function connect(): void {
  mgr.useExternalApps(rt)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcp-apps-')))
  dataRoot = join(root, 'data')
  repo = join(root, 'repo')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  store = new Store()
  adapter = new CapturingAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({
    projects: () => store.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    runs: storeRunLedger(store),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

const manifestPath = (id: string) => join(dataRoot, 'apps', id, 'centralu.app.json')
const readManifest = (id: string) => JSON.parse(readFileSync(manifestPath(id), 'utf8')) as Record<string, unknown>
const userApps = () => rt.list().filter((a) => a.projectId === null).map((a) => a.appId)
const attached = (o: CreateSessionOpts) => o.apps?.current().map((a) => a.server) ?? []
const tick = () => new Promise((r) => setTimeout(r, 20))

async function proposeAndApprove(name: string, server = SERVER, why?: string) {
  const orc = await mgr.orchestrator()
  const r = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', { name, ...server, ...(why ? { why } : {}) })
  expect(r.isError).toBeFalsy()
  return { orc, resolved: await mgr.resolveMcpProposal(name, true) }
}

describe('승인한 MCP 서버는 사용자 폴더의 앱이 된다 (A-7)', () => {
  it('제안은 아무것도 만들지 않고, 승인이 앱을 만들고 오케스트레이터를 재시작하며, 그 도구는 중개를 지나 기록된다', async () => {
    connect()
    const orc = await mgr.orchestrator()
    await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', { name: 'echoer', ...SERVER, why: '시험용 서버' })
    expect(mgr.mcpProposals().map((p) => p.name)).toEqual(['echoer'])
    // 제안 단계에서는 아무것도 없다
    expect(existsSync(join(dataRoot, 'apps', 'echoer'))).toBe(false)
    expect(userApps()).toEqual([])

    const before = adapter.seen.length
    expect(await mgr.resolveMcpProposal('echoer', true)).toEqual({ ok: true })
    expect(mgr.mcpProposals()).toEqual([])

    // 화면 없는 앱: 서버 명령만 있고 home이 없다. 앱은 뜨지 않은 채로 선다(처음 필요할 때 뜬다)
    const m = readManifest('echoer')
    expect(m).toMatchObject({ manifestVersion: 1, id: 'echoer', name: 'echoer', description: '시험용 서버', server: SERVER })
    expect(m).not.toHaveProperty('home')
    expect(rt.list().find((a) => a.appId === 'echoer')).toMatchObject({ projectId: null, status: 'stopped', trusted: true, error: null })
    // 예전 명부에는 적히지 않는다
    expect(store.appSetting(LEGACY_KEY)).toBeNull()

    // 오케스트레이터가 다시 떴고, 그 서버는 앱 대리 서버로 붙는다 — 날것으로 실리는 서버는 없다
    expect(adapter.seen.length).toBe(before + 1)
    const o = adapter.last()
    expect(o.sessionId).toBe(orc.id)
    expect(attached(o)).toEqual(['app-echoer'])
    expect(o).not.toHaveProperty('extraMcpServers')

    // 그 도구를 부르면 중개를 지나고, 호출자(이 오케스트레이터)와 함께 기록된다
    const out = await o.apps!.call('app-echoer', 'poke', { to: 3 })
    expect(out.isError).toBeFalsy()
    expect(out.content).toEqual([{ type: 'text', text: 'poked 3' }])
    expect(rt.runs({ projectId: null, appId: 'echoer' })).toEqual([
      expect.objectContaining({ tool: 'poke', status: 'ok', callerKind: 'session', callerSessionId: orc.id }),
    ])
  })

  it('거절은 제안만 걷는다 — 앱도 재시작도 없다', async () => {
    connect()
    const orc = await mgr.orchestrator()
    await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', { name: 'figma', command: 'npx', args: [] })
    const before = adapter.seen.length
    await mgr.resolveMcpProposal('figma', false)
    expect(mgr.mcpProposals()).toEqual([])
    expect(userApps()).toEqual([])
    expect(adapter.seen.length).toBe(before)
  })

  it('이미 있는 앱의 이름과 내장 앱의 이름으로는 제안할 수 없다 — 덮어쓰기가 곧 명령 바꿔치기다', async () => {
    connect()
    const { orc } = await proposeAndApprove('dup')
    const again = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', { name: 'dup', command: 'evil', args: [] })
    expect(again.isError).toBe(true)
    expect(readManifest('dup').server).toEqual(SERVER)

    const builtin = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', { name: 'control', command: 'npx', args: [] })
    expect(builtin.isError).toBe(true)
    expect(mgr.mcpProposals()).toEqual([])
  })

  it('승인하는 사이에 같은 id의 다른 앱이 생겼으면 덮어쓰지 않고 실패하며, 제안은 남는다', async () => {
    connect()
    const orc = await mgr.orchestrator()
    await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', { name: 'taken', command: 'npx', args: ['-y', 'x'] })
    plantApp(join(dataRoot, 'apps'), 'taken', { server: SERVER })
    const r = await mgr.resolveMcpProposal('taken', true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('taken')
    expect(readManifest('taken').server).toEqual(SERVER)
    expect(mgr.mcpProposals().map((p) => p.name)).toEqual(['taken'])
  })
})

describe('옛 명부의 승인된 서버를 옮긴다 (A-7)', () => {
  it('기동에서 한 번 옮기고, 다시 돌아도 같다 — 옮긴 항목만 옛 키에서 걷고 옮기지 못한 항목은 남긴다', async () => {
    const legacy = [
      { name: 'echoer', ...SERVER },
      // #93 이전에 승인된 이름 — 앱 id가 될 수 없다
      { name: 'centralu', command: 'npx', args: ['-y', 'whatever'] },
    ]
    store.setAppSetting(LEGACY_KEY, JSON.stringify(legacy))
    connect()
    expect(userApps()).toEqual(['echoer'])
    expect(readManifest('echoer')).toMatchObject({ id: 'echoer', server: SERVER })
    expect(JSON.parse(store.appSetting(LEGACY_KEY)!)).toEqual([{ name: 'centralu', command: 'npx', args: ['-y', 'whatever'] }])

    /*
     * 앱을 쓴 뒤 키를 걷기 전에 host가 죽었다고 치자 — 옛 키가 처음 그대로 남아 있다. 다음 기동은 같은
     * 항목을 다시 옮기려 하고, 그때 앱이 둘 생기거나 이미 옮긴 앱을 다시 쓰면 안 된다.
     */
    store.setAppSetting(LEGACY_KEY, JSON.stringify(legacy))
    const written = statSync(manifestPath('echoer')).mtimeMs
    const text = readFileSync(manifestPath('echoer'), 'utf8')
    await new Promise((r) => setTimeout(r, 30))
    connect()
    expect(userApps()).toEqual(['echoer'])
    expect(statSync(manifestPath('echoer')).mtimeMs).toBe(written)
    expect(readFileSync(manifestPath('echoer'), 'utf8')).toBe(text)
    expect(readdirSync(join(dataRoot, 'apps'))).toEqual(['echoer'])
    expect(JSON.parse(store.appSetting(LEGACY_KEY)!)).toEqual([{ name: 'centralu', command: 'npx', args: ['-y', 'whatever'] }])

    // 오케스트레이터는 옮긴 앱을 받고, 옛 항목은 어디에도 날것으로 실리지 않는다
    await mgr.orchestrator()
    expect(attached(adapter.last())).toEqual(['app-echoer'])
    expect(adapter.last()).not.toHaveProperty('extraMcpServers')
  })

  it('다 옮기면 옛 키가 사라진다', async () => {
    store.setAppSetting(LEGACY_KEY, JSON.stringify([{ name: 'echoer', ...SERVER }]))
    connect()
    expect(userApps()).toEqual(['echoer'])
    expect(store.appSetting(LEGACY_KEY)).toBeNull()
  })

  it('같은 id의 다른 앱이 이미 있으면 그 앱을 덮어쓰지 않고, 항목을 남긴다', async () => {
    plantApp(join(dataRoot, 'apps'), 'echoer', { server: SERVER })
    const mine = readFileSync(manifestPath('echoer'), 'utf8')
    const theirs = { name: 'echoer', command: 'npx', args: ['-y', 'other-server'] }
    store.setAppSetting(LEGACY_KEY, JSON.stringify([theirs]))
    connect()
    expect(readFileSync(manifestPath('echoer'), 'utf8')).toBe(mine)
    expect(JSON.parse(store.appSetting(LEGACY_KEY)!)).toEqual([theirs])
  })
})

describe('지우기 (apps.remove, A-7)', () => {
  it('사용자 폴더 앱을 지우면 목록과 오케스트레이터에서 떨어지고, 폴더는 app-trash로 간다', async () => {
    connect()
    const { orc } = await proposeAndApprove('echoer')
    const apps = adapter.last().apps!
    await apps.call('app-echoer', 'peek', {})
    let changed = 0
    apps.onChange(() => changed++)

    await rpc('apps.remove', { appId: 'echoer', projectId: null })

    expect(userApps()).toEqual([])
    expect(existsSync(join(dataRoot, 'apps', 'echoer'))).toBe(false)
    expect(readdirSync(join(dataRoot, 'app-trash'))).toEqual([expect.stringMatching(/^echoer-\d+$/)])
    // 붙어 있던 세션이 떼어 낸다 — Claude는 이 알림으로 서버 집합을 바꾼다
    await tick()
    expect(changed).toBeGreaterThan(0)
    expect(apps.current().map((a) => a.server)).toEqual([])
    // 도구 이름을 아는 쪽(다음 스레드를 기다리는 Codex)이 불러도 거절된다
    const late = await apps.call('app-echoer', 'poke', { to: 1 })
    expect(late.isError).toBe(true)
    expect(JSON.stringify(late.content)).toContain('not attached to this session')
    // 지운 앱의 기록은 남는다
    expect(rt.runs({ projectId: null, appId: 'echoer' })).toEqual([expect.objectContaining({ tool: 'peek', callerSessionId: orc.id })])
    // 같은 이름을 다시 제안할 수 있다
    const again = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', { name: 'echoer', ...SERVER })
    expect(again.isError).toBeFalsy()
  })

  it('프로젝트 앱은 지우지 않는다 — 저장소의 파일이라 거두는 자리는 git이다', async () => {
    connect()
    plantApp(join(repo, ...PROJECT_APPS), 'notes', { server: SERVER })
    const projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
    await expect(rpc('apps.remove', { appId: 'notes', projectId })).rejects.toThrow(/part of the project's repository/)
    expect(existsSync(join(repo, ...PROJECT_APPS, 'notes'))).toBe(true)
    expect(rt.list().map((a) => a.appId)).toEqual(['notes'])
  })
})
