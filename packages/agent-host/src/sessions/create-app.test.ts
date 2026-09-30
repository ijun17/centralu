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
 * Creating a new app (M4 C-1b) — whether the `apps.create` RPC and the orchestrator's `create_app`
 * go through the same door, and what that door refuses. Checked with a real store, real trust, a
 * real runtime and a real template. Only the adapter is fake.
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
  it('unpacks a template app into a trusted project, creates its data folder, and lists it — without starting it', async () => {
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
    // The created app really starts — the first time it is needed
    const tools = await rt.tools({ projectId, appId: 'resource-search' })
    expect(tools.map((t) => t.name)).toEqual(['show', 'increment', 'reset'])
  })

  it('creates it in the user folder when projectId is null', async () => {
    const { app } = await create({ projectId: null, id: 'timer', name: 'Timer', description: 'Counts down' })
    expect(app).toMatchObject({ appId: 'timer', projectId: null, description: 'Counts down', trusted: true })
    expect(app.dir).toBe(join(dataRoot, 'apps', 'timer'))
    expect(existsSync(join(dataRoot, 'app-data', '_user', 'timer'))).toBe(true)
  })

  it('does not create in an untrusted project — no folder appears either', async () => {
    await rpc('projects.setTrusted', { projectId, trusted: false })
    await expect(create({ projectId, id: 'notes', name: 'Notes' })).rejects.toThrow(/does not make apps in a project it does not trust/)
    expect(existsSync(join(repo, '.centralu'))).toBe(false)
  })

  it('refuses names it cannot use — a centralu or app- prefix, underscores, uppercase letters, a built-in app\'s id', async () => {
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

  it('does not overwrite an existing id — neither an intact app nor a folder with an invalid manifest', async () => {
    plantApp(appsDir(), 'notes', { server: { command: 'node', args: ['mine.mjs'] } })
    mkdirSync(join(appsDir(), 'draft'))
    writeFileSync(join(appsDir(), 'draft', 'half-written.txt'), 'someone is working here')
    rt.refresh()
    await expect(create({ projectId, id: 'notes', name: 'Notes' })).rejects.toThrow(/An app "notes" already exists/)
    await expect(create({ projectId, id: 'draft', name: 'Draft' })).rejects.toThrow(/An app "draft" already exists/)
    expect(JSON.parse(readFileSync(join(appsDir(), 'notes', 'centralu.app.json'), 'utf8')).server.args).toEqual(['mine.mjs'])
    expect(readdirSync(join(appsDir(), 'draft'))).toEqual(['half-written.txt'])
    // Even creating the same id twice — the second attempt is refused
    await create({ projectId: null, id: 'once', name: 'Once' })
    await expect(create({ projectId: null, id: 'once', name: 'Once' })).rejects.toThrow(/An app "once" already exists/)
  })

  it('does not create if a project\'s .centralu is a link pointing outside its repository — writes nothing outside it', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(repo, '.centralu'))
    await expect(create({ projectId, id: 'escape', name: 'Escape' })).rejects.toThrow(/Could not make the app folder/)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('create_app (the orchestrator)', () => {
  it('names a project by its name to create through the same door, and a refusal returns its reason', async () => {
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

  it('only the orchestrator uses it — it is absent from the manager\'s and the coordinating session\'s profiles', () => {
    expect(profileAllows('orchestrator', 'create_app')).toBe(true)
    expect(profileAllows('manager', 'create_app')).toBe(false)
    expect(profileAllows('scoped', 'create_app')).toBe(false)
  })
})
