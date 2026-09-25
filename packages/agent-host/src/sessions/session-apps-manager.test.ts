import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FIXTURE_APP } from './session-apps.test-helpers.js'

/**
 * 매니저가 세션을 띄울 때 결정 4대로 앱을 넘기는가 (M4 A-5) — 진짜 저장소·신뢰·워크트리로 본다.
 * 어댑터만 가짜다: 받은 옵션을 적어 두는 것이 이 테스트가 보는 전부다.
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

let root = ''
let repo = ''
let store: Store
let rt: ExternalApps
let adapter: CapturingAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

const servers = (o: CreateSessionOpts) => o.apps?.current().map((a) => a.server)
const create = (extra: Record<string, unknown> = {}) =>
  rpc('agents.createSession', { projectId, cwd: repo, tool: 'claude', ...extra }) as Promise<SessionInfo>

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-mgr-')))
  repo = join(root, 'repo')
  const dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  const app = { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } }
  plantApp(join(repo, ...PROJECT_APPS), 'notes', app)
  plantApp(join(dataRoot, 'apps'), 'helper', app)

  store = new Store()
  adapter = new CapturingAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot, reservedIds: ['control'] })
  mgr.useExternalApps(rt)
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('매니저가 넘기는 앱 (결정 4)', () => {
  it('일반 워커는 자기 프로젝트의 외부 앱을 받는다 — 내장 앱 도구는 지금처럼 받지 않는다', async () => {
    await create()
    const o = adapter.last()
    expect(servers(o)).toEqual(['app-notes'])
    expect(o.orchestratorTools).toBeUndefined()
    expect(o.toolProfile).toBeUndefined()
    // host로 돌아오는 길은 받는다 — Codex의 앱 다리가 이 주소로 돌아온다
    expect(o.orchestratorBridge).toEqual({ url: 'ws://127.0.0.1:5999', token: 'tok' })
  })

  it('워크트리 세션은 워크트리에서 뜨되, 프로젝트 뿌리의 앱을 받는다', async () => {
    const s = await create({ worktree: true })
    const o = adapter.last()
    expect(o.cwd).toBe(s.worktree?.path)
    expect(o.cwd).not.toBe(repo)
    expect(servers(o)).toEqual(['app-notes'])
  })

  it('신뢰하지 않은 프로젝트의 세션은 앱을 받지 않는다', async () => {
    await rpc('projects.setTrusted', { projectId, trusted: false })
    await create()
    expect(servers(adapter.last())).toEqual([])
  })

  it('오케스트레이터는 사용자 폴더의 앱만 받고, 내장 도구도 그대로 받는다', async () => {
    await mgr.orchestrator()
    const o = adapter.last()
    expect(servers(o)).toEqual(['app-helper'])
    expect(o.orchestratorTools).toBeDefined()
  })

  it('되살릴 때도 붙인다 — 프로세스를 갈아 끼운 세션이 앱을 잃지 않는다', async () => {
    const s = await create()
    adapter.seen = []
    await mgr.restartSession(s.id)
    expect(adapter.seen).toHaveLength(1)
    expect(servers(adapter.last())).toEqual(['app-notes'])
  })
})
