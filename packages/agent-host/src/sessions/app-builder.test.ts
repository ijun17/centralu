import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, ExternalAppInfo, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/**
 * 앱의 만드는 세션 (M4 C-2) — 앱을 만들면 함께 서고, 그 앱의 것으로 찾아지며, 역할문을 들고 다닌다.
 * 진짜 저장소·신뢰·런타임·템플릿. 어댑터만 가짜다: 받은 옵션(cwd·역할문)을 적어 두는 것이 이 테스트가 보는 것이다.
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

class FakeAdapter implements AgentAdapter {
  constructor(readonly tool: ToolName) {}
  descriptor = { name: 'x', label: 'X', mark: 'X', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false,
  }
  seen: CreateSessionOpts[] = []
  fail = false
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, _emit: EventSink) {
    if (this.fail) throw new Error(`${this.tool} is not logged in`)
    this.seen.push(opts)
    return new Handle(opts.sessionId)
  }
  last(): CreateSessionOpts {
    return this.seen.at(-1)!
  }
}

let root = ''
let repo = ''
let dataRoot = ''
let store: Store
let rt: ExternalApps
let claude: FakeAdapter
let codex: FakeAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

type Created = { app: ExternalAppInfo; builder: SessionInfo | null; builderError?: string }
const create = (params: Record<string, unknown>) => rpc('apps.create', params) as Promise<Created>

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-builder-')))
  repo = join(root, 'repo')
  dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  store = new Store()
  claude = new FakeAdapter('claude')
  codex = new FakeAdapter('codex')
  const adapters = new Map<ToolName, AgentAdapter>([
    ['claude', claude],
    ['codex', codex],
  ])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot, reservedIds: ['control'] })
  rt.refresh()
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

describe('앱을 만들면 만드는 세션이 선다', () => {
  it('프로젝트 앱: cwd는 프로젝트 뿌리, 앱 칸은 그 앱, 역할문이 앱의 자리와 규칙을 말한다', async () => {
    const { app, builder } = await create({ projectId, id: 'notes', name: 'Team notes' })
    expect(builder).toMatchObject({ projectId, appId: 'notes', kind: 'worker', tool: 'claude', name: 'Team notes · builder', autoNamed: false, permissionPreset: 'normal' })
    const o = claude.last()
    expect(o.cwd).toBe(repo)
    expect(o.systemPromptAppend).toBe(builder!.roleAppend)
    const role = builder!.roleAppend!
    expect(role).toContain('너는 Centralu 앱 "Team notes"(id notes)을 만드는 세션이다')
    expect(role).toContain(`앱 폴더: ${join('.centralu', 'apps', 'notes')}/ (${app.dir})`)
    for (const rule of ['runtime/은 Centralu가 만든 생성물이다', 'npm install', '"__"', 'readOnlyHint', "visibility: ['app']", 'centralu.readJson/writeJson', 'AGENTS.md']) {
      expect(role, rule).toContain(rule)
    }
  })

  it('사용자 폴더 앱: cwd가 앱 폴더이고 프로젝트가 없다', async () => {
    const { app, builder } = await create({ projectId: null, id: 'timer', name: 'Timer' })
    expect(builder).toMatchObject({ projectId: null, appId: 'timer', kind: 'worker' })
    expect(claude.last().cwd).toBe(app.dir)
    expect(app.dir).toBe(join(dataRoot, 'apps', 'timer'))
    expect(builder!.roleAppend).toContain(`네 작업 폴더가 곧 앱 폴더다: ${app.dir}`)
  })

  it('도구는 부른 쪽이 고르고, 안 고르면 프로젝트의 기본 도구다', async () => {
    const picked = await create({ projectId, id: 'one', name: 'One', tool: 'codex' })
    expect(picked.builder!.tool).toBe('codex')
    expect(codex.seen).toHaveLength(1)
    // 방금 고른 도구가 프로젝트의 기본값이 됐다 (세션 만들기의 규칙) — 고르지 않은 다음 앱은 그것을 받는다
    const defaulted = await create({ projectId, id: 'two', name: 'Two' })
    expect(defaulted.builder!.tool).toBe('codex')
  })

  it('되살려도 역할문이 다시 실린다', async () => {
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    claude.seen = []
    await mgr.restartSession(builder!.id)
    expect(claude.seen).toHaveLength(1)
    expect(claude.last().systemPromptAppend).toBe(builder!.roleAppend)
    expect(claude.last().cwd).toBe(repo)
  })

  it('세션이 서지 못해도 앱은 남고, 이유가 돌아오고, 그 앱의 만드는 세션은 없다', async () => {
    claude.fail = true
    const r = await create({ projectId, id: 'notes', name: 'Notes' })
    expect(r.app.appId).toBe('notes')
    expect(r.builder).toBeNull()
    expect(r.builderError).toContain('claude is not logged in')
    expect(await rpc('apps.builder', { appId: 'notes', projectId })).toBeNull()
    claude.fail = false
    const later = (await rpc('apps.createBuilder', { appId: 'notes', projectId })) as SessionInfo
    expect(later).toMatchObject({ appId: 'notes', projectId })
  })
})

describe('그 앱의 만드는 세션으로 찾아진다', () => {
  it('apps.builder가 그 세션을 돌려주고, 세우기는 앱마다 하나다', async () => {
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    await create({ projectId: null, id: 'notes', name: 'Notes (mine)' })
    expect(((await rpc('apps.builder', { appId: 'notes', projectId })) as SessionInfo).id).toBe(builder!.id)
    // 사용자 폴더의 같은 id는 다른 앱이다 — 만드는 세션도 따로다
    const userBuilder = (await rpc('apps.builder', { appId: 'notes', projectId: null })) as SessionInfo
    expect(userBuilder.id).not.toBe(builder!.id)
    expect(userBuilder.projectId).toBeNull()
    const again = (await rpc('apps.createBuilder', { appId: 'notes', projectId })) as SessionInfo
    expect(again.id).toBe(builder!.id)
  })

  it('만드는 세션을 지우면 없는 것이 되고, 다시 세울 수 있다', async () => {
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    await rpc('agents.deleteSession', { sessionId: builder!.id })
    expect(await rpc('apps.builder', { appId: 'notes', projectId })).toBeNull()
    const fresh = (await rpc('apps.createBuilder', { appId: 'notes', projectId })) as SessionInfo
    expect(fresh.id).not.toBe(builder!.id)
    expect(((await rpc('apps.builder', { appId: 'notes', projectId })) as SessionInfo).id).toBe(fresh.id)
  })

  it('손으로 만든 앱에도 세울 수 있고, 신뢰하지 않은 프로젝트의 앱에는 세우지 않는다', async () => {
    plantApp(join(repo, ...PROJECT_APPS), 'handmade', { server: { command: 'node', args: ['server.mjs'] } })
    rt.refresh()
    const b = (await rpc('apps.createBuilder', { appId: 'handmade', projectId })) as SessionInfo
    expect(b).toMatchObject({ appId: 'handmade', name: 'App handmade · builder' })
    await rpc('projects.setTrusted', { projectId, trusted: false })
    plantApp(join(repo, ...PROJECT_APPS), 'other', { server: { command: 'node', args: ['server.mjs'] } })
    rt.refresh()
    await expect(rpc('apps.createBuilder', { appId: 'other', projectId })).rejects.toThrow(/신뢰하지 않은 프로젝트의 앱에는 만드는 세션을 두지 않습니다/)
    await expect(rpc('apps.createBuilder', { appId: 'ghost', projectId })).rejects.toThrow(/그런 앱이 없습니다/)
  })

  it('create_app은 만든 세션을 알려 주며 다음 일을 그 세션에 넘기라고 한다', async () => {
    const orch = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'board', name: 'Board', project: projectId })
    const b = (await rpc('apps.builder', { appId: 'board', projectId })) as SessionInfo
    expect(r.text).toContain(`만드는 세션: Board · builder [${b.id}] — 무엇을 만들지 send_to_session으로 그 세션에 시키세요`)
  })
})
