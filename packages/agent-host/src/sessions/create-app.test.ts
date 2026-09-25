import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, ExternalAppInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { profileAllows } from './orchestrator-tools.js'

/**
 * 새 앱 만들기 (M4 C-1b) — `apps.create` RPC와 오케스트레이터의 `create_app`이 같은 문을 지나는가, 그 문이
 * 무엇을 거절하는가. 진짜 저장소·신뢰·런타임·템플릿으로 본다. 어댑터만 가짜다.
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
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, _emit: EventSink) {
    this.seen.push(opts)
    return new Handle(opts.sessionId)
  }
}

let root = ''
let repo = ''
let dataRoot = ''
let store: Store
let rt: ExternalApps
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

const appsDir = () => join(repo, ...PROJECT_APPS)
const create = (params: Record<string, unknown>) => rpc('apps.create', params) as Promise<{ app: ExternalAppInfo }>

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-create-app-')))
  repo = join(root, 'repo')
  dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new FakeAdapter('claude')]])
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

describe('apps.create', () => {
  it('신뢰한 프로젝트에 템플릿 앱을 펼치고, 데이터 폴더를 만들고, 목록에 세운다 — 띄우지는 않는다', async () => {
    const { app } = await create({ projectId, id: 'resource-search', name: '리소스 검색' })
    expect(app).toMatchObject({ appId: 'resource-search', projectId, name: '리소스 검색', status: 'stopped', home: 'show', error: null })
    expect(app.dir).toBe(join(appsDir(), 'resource-search'))
    expect(readdirSync(app.dir).sort()).toEqual(['.gitattributes', 'AGENTS.md', 'CLAUDE.md', 'centralu.app.json', 'runtime', 'server.mjs', 'ui'])
    expect(JSON.parse(readFileSync(join(app.dir, 'centralu.app.json'), 'utf8'))).toMatchObject({
      id: 'resource-search',
      name: '리소스 검색',
      description: '리소스 검색 (a Centralu app)',
    })
    expect(existsSync(join(dataRoot, 'app-data', projectId, 'resource-search'))).toBe(true)
    expect(((await rpc('apps.list', {})) as ExternalAppInfo[]).map((a) => a.appId)).toEqual(['resource-search'])
    // 만든 앱은 진짜로 뜬다 — 처음 필요할 때
    const tools = await rt.tools({ projectId, appId: 'resource-search' })
    expect(tools.map((t) => t.name)).toEqual(['show', 'increment', 'reset'])
  })

  it('projectId가 null이면 사용자 폴더에 만든다', async () => {
    const { app } = await create({ projectId: null, id: 'timer', name: 'Timer', description: 'Counts down' })
    expect(app).toMatchObject({ appId: 'timer', projectId: null, description: 'Counts down', trusted: true })
    expect(app.dir).toBe(join(dataRoot, 'apps', 'timer'))
    expect(existsSync(join(dataRoot, 'app-data', '_user', 'timer'))).toBe(true)
  })

  it('신뢰하지 않은 프로젝트에는 만들지 않는다 — 폴더도 생기지 않는다', async () => {
    await rpc('projects.setTrusted', { projectId, trusted: false })
    await expect(create({ projectId, id: 'notes', name: 'Notes' })).rejects.toThrow(/does not make apps in a project it does not trust/)
    expect(existsSync(join(repo, '.centralu'))).toBe(false)
  })

  it('쓸 수 없는 이름은 거절한다 — centralu·app- 머리, 밑줄, 대문자, 내장 앱의 id', async () => {
    const refused: Record<string, RegExp> = {
      'centralu-tools': /ids starting with "centralu" belong to Centralu itself/,
      'app-notes': /ids starting with "app-" are how apps attach to sessions/,
      'my_app': /lowercase letters, digits and hyphens \(up to 32\)/,
      'a__b': /lowercase letters, digits and hyphens \(up to 32\)/,
      Notes: /lowercase letters, digits and hyphens \(up to 32\)/,
      control: /that is the id of a built-in app/,
    }
    for (const [id, why] of Object.entries(refused)) {
      await expect(create({ projectId, id, name: 'X' }), id).rejects.toThrow(why)
    }
    await expect(create({ projectId, id: 'ok', name: '  \n ' })).rejects.toThrow(/The app needs a name/)
    expect(existsSync(appsDir()) ? readdirSync(appsDir()) : []).toEqual([])
  })

  it('이미 있는 id는 덮어쓰지 않는다 — 멀쩡한 앱도, 매니페스트가 틀린 폴더도', async () => {
    plantApp(appsDir(), 'notes', { server: { command: 'node', args: ['mine.mjs'] } })
    mkdirSync(join(appsDir(), 'draft'))
    writeFileSync(join(appsDir(), 'draft', 'half-written.txt'), 'someone is working here')
    rt.refresh()
    await expect(create({ projectId, id: 'notes', name: 'Notes' })).rejects.toThrow(/An app "notes" already exists/)
    await expect(create({ projectId, id: 'draft', name: 'Draft' })).rejects.toThrow(/An app "draft" already exists/)
    expect(JSON.parse(readFileSync(join(appsDir(), 'notes', 'centralu.app.json'), 'utf8')).server.args).toEqual(['mine.mjs'])
    expect(readdirSync(join(appsDir(), 'draft'))).toEqual(['half-written.txt'])
    // 같은 id를 두 번 만들어도 두 번째는 거절된다
    await create({ projectId: null, id: 'once', name: 'Once' })
    await expect(create({ projectId: null, id: 'once', name: 'Once' })).rejects.toThrow(/An app "once" already exists/)
  })

  it('프로젝트의 .centralu가 저장소 밖을 가리키는 링크면 만들지 않는다 — 밖에 아무것도 쓰지 않는다', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(repo, '.centralu'))
    await expect(create({ projectId, id: 'escape', name: 'Escape' })).rejects.toThrow(/Could not make the app folder/)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('create_app (오케스트레이터)', () => {
  it('프로젝트를 이름으로 가리켜 같은 문으로 만들고, 거절은 이유를 돌려준다', async () => {
    const orch = await mgr.orchestrator()
    const name = store.listProjects()[0]!.name
    const made = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'board', name: 'Board', project: name })
    expect(made.isError).toBeFalsy()
    expect(made.text).toContain(`"Board" 앱을 만들었습니다 (프로젝트, id board): ${join(appsDir(), 'board')}`)
    expect(existsSync(join(appsDir(), 'board', 'server.mjs'))).toBe(true)

    const user = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'clock', name: 'Clock' })
    expect(user.text).toContain('(사용자 폴더, id clock)')

    const again = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'board', name: 'Board', project: name })
    expect(again).toMatchObject({ isError: true })
    expect(again.text).toContain('만들지 못했습니다 — An app "board" already exists')
    const nowhere = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'x', name: 'X', project: 'no-such-project' })
    expect(nowhere.text).toBe('만들지 못했습니다 — 그런 프로젝트가 없습니다: no-such-project')

    await rpc('projects.setTrusted', { projectId, trusted: false })
    const untrusted = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'later', name: 'Later', project: projectId })
    expect(untrusted.text).toContain('does not make apps in a project it does not trust')
  })

  it('오케스트레이터만 쓴다 — 매니저·조율 세션의 묶음에는 없다', () => {
    expect(profileAllows('orchestrator', 'create_app')).toBe(true)
    expect(profileAllows('manager', 'create_app')).toBe(false)
    expect(profileAllows('scoped', 'create_app')).toBe(false)
  })
})
