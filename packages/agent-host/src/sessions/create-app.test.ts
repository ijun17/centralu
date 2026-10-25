import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, ExternalAppInfo, NormalizedEvent, ProjectInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { DEFAULT_RARE_TIER, profileAllows, setRareTier } from './orchestrator-tools.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { linkDir } from '../link.test-helpers.js'

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
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
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
/** This test's `~/Centralu`: where a new app project goes by default (#1141) */
let home = ''
let events: NormalizedEvent[] = []

const appsDir = () => join(repo, ...PROJECT_APPS)
const create = (params: Record<string, unknown>) => rpc('apps.create', params) as Promise<{ app: ExternalAppInfo }>

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-create-app-')))
  repo = join(root, 'repo')
  dataRoot = join(root, 'data')
  vi.stubEnv('CC_DATA_DIR', dataRoot)
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new FakeAdapter('claude')]])
  events = []
  mgr = new SessionManager(store, adapters, (e) => events.push(e), () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  home = join(root, 'Centralu')
  mgr.useProjectsHome(() => home)
  mgr.prLookup = async () => null
  rt = new ExternalApps({ projects: () => store.projects.projectRoots(), dataRoot, reservedIds: ['control'] })
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

/*
 * These call the orchestrator's rare commands by their own names, as tools: the `resident` tier (#512). The
 * default tier serves them through centralu_run, to the same runners; command-tier.test.ts covers that door.
 */
beforeAll(() => setRareTier('resident'))
afterAll(() => setRareTier(DEFAULT_RARE_TIER))

describe('apps.create', () => {
  it('unpacks a template app into a trusted project, creates its data folder, and lists it — without starting it', async () => {
    const { app } = await create({ projectId, id: 'resource-search', name: 'Resource Search' })
    expect(app).toMatchObject({ appId: 'resource-search', projectId, name: 'Resource Search', status: 'stopped', home: 'show', error: null })
    expect(app.dir).toBe(join(appsDir(), 'resource-search'))
    expect(readdirSync(app.dir).sort()).toEqual(['.gitattributes', 'AGENTS.md', 'CLAUDE.md', 'centralu.app.json', 'runtime', 'server.mjs', 'ui'])
    expect(JSON.parse(readFileSync(join(app.dir, 'centralu.app.json'), 'utf8'))).toMatchObject({
      id: 'resource-search',
      name: 'Resource Search',
      description: 'Resource Search (a Centralu app)',
    })
    expect(existsSync(join(dataRoot, 'app-data', projectId, 'resource-search'))).toBe(true)
    expect(((await rpc('apps.list', {})) as ExternalAppInfo[]).map((a) => a.appId)).toEqual(['resource-search'])
    // The created app really starts — the first time it is needed
    const tools = await rt.tools({ projectId, appId: 'resource-search' })
    expect(tools.map((t) => t.name)).toEqual(['show', 'increment', 'reset'])
  })

  it('with no project, makes a new folder in ~/Centralu, writes the template there and registers it as a trusted project whose root is the app (#1141)', async () => {
    const { app } = await create({ projectId: null, id: 'timer', name: 'Timer', description: 'Counts down' })
    expect(app.dir).toBe(join(home, 'timer'))
    expect(readdirSync(app.dir)).toEqual(expect.arrayContaining(['centralu.app.json', 'server.mjs', 'ui', 'runtime']))
    const project = ((await rpc('projects.list', {})) as ProjectInfo[]).find((p) => p.path === app.dir)
    expect(project).toMatchObject({ name: 'timer', trusted: true })
    expect(app).toMatchObject({ appId: 'timer', projectId: project!.id, root: true, description: 'Counts down', trusted: true, status: 'stopped' })
    expect(events.some((e) => e.type === 'projects_changed')).toBe(true)
    // Nothing is left in the user folder, nor half made beside the new folder
    expect(existsSync(join(dataRoot, 'apps', 'timer'))).toBe(false)
    expect(readdirSync(home)).toEqual(['timer'])
  })

  it('with no project, puts the new folder in the parent the person chose, and refuses one that is not there', async () => {
    const parent = join(root, 'code')
    mkdirSync(parent)
    const { app } = await create({ projectId: null, id: 'notes', name: 'Notes', parent })
    expect(app.dir).toBe(join(parent, 'notes'))
    expect(app.root).toBe(true)
    await expect(create({ projectId: null, id: 'later', name: 'Later', parent: join(root, 'nowhere') })).rejects.toThrow(/There is no folder at/)
    expect(existsSync(join(root, 'nowhere'))).toBe(false)
  })

  it('does not create in an untrusted project — no folder appears either', async () => {
    await rpc('projects.setTrusted', { projectId, trusted: false })
    await expect(create({ projectId, id: 'notes', name: 'Notes' })).rejects.toThrow(/does not make apps in a project it does not trust/)
    expect(existsSync(join(repo, '.centralu'))).toBe(false)
  })

  it('refuses names it cannot use — a centralu or app- prefix, underscores, uppercase letters, a reserved id', async () => {
    const refused: Record<string, RegExp> = {
      'centralu-tools': /ids starting with "centralu" belong to Centralu itself/,
      'app-notes': /ids starting with "app-" are how apps attach to sessions/,
      'my_app': /lowercase letters, digits and hyphens \(up to 32\)/,
      'a__b': /lowercase letters, digits and hyphens \(up to 32\)/,
      Notes: /lowercase letters, digits and hyphens \(up to 32\)/,
      control: /that id is reserved/,
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
    // Even creating the same id twice — the second attempt is refused, and the first folder is left as it was
    const { app } = await create({ projectId: null, id: 'once', name: 'Once' })
    writeFileSync(join(app.dir, 'mine.txt'), 'the person wrote this')
    await expect(create({ projectId: null, id: 'once', name: 'Once' })).rejects.toThrow(/Something named "once" is already in/)
    expect(readFileSync(join(app.dir, 'mine.txt'), 'utf8')).toBe('the person wrote this')
    // A refused id writes no folder at all
    await expect(create({ projectId: null, id: 'app-x', name: 'X' })).rejects.toThrow(/ids starting with "app-"/)
    expect(readdirSync(home)).toEqual(['once'])
  })

  it('does not create if a project\'s .centralu is a link pointing outside its repository — writes nothing outside it', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    linkDir(outside, join(repo, '.centralu'))
    await expect(create({ projectId, id: 'escape', name: 'Escape' })).rejects.toThrow(/Could not make the app folder/)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('create_app (the orchestrator)', () => {
  it('names a project by its name to create through the same door, and a refusal returns its reason', async () => {
    const orch = await mgr.orchestrator()
    const name = store.projects.listProjects()[0]!.name
    const made = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'board', name: 'Board', project: name })
    expect(made.isError).toBeFalsy()
    expect(made.text).toContain(`Created the "Board" app (project, id board): ${join(appsDir(), 'board')}`)
    expect(existsSync(join(appsDir(), 'board', 'server.mjs'))).toBe(true)

    // Without a project it makes a folder and a project (#1141): only once the person allows create_project's card
    const card = () => {
      const pending = mgr.listSessions().find((s) => s.id === orch.id)?.pendingApproval
      return pending?.detail.kind === 'project_create' ? pending : undefined
    }
    const asked = mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'clock', name: 'Clock' })
    await eventually(() => !!card())
    expect(card()!.detail).toEqual({ kind: 'project_create', name: 'clock', path: join(home, 'clock') })
    expect(existsSync(join(home, 'clock'))).toBe(false)
    mgr.respondApproval(orch.id, card()!.requestId, 'allow')
    const user = await asked
    expect(user.text).toContain(`Created the "Clock" app (a new project of its own, id clock): ${join(home, 'clock')}`)
    const refused = mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'clock2', name: 'Clock' })
    await eventually(() => !!card())
    mgr.respondApproval(orch.id, card()!.requestId, 'deny')
    expect((await refused).text).toContain('The person did not approve it')
    expect(existsSync(join(home, 'clock2'))).toBe(false)

    const again = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'board', name: 'Board', project: name })
    expect(again).toMatchObject({ isError: true })
    expect(again.text).toContain('Could not create it — An app "board" already exists')
    const nowhere = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'x', name: 'X', project: 'no-such-project' })
    expect(nowhere.text).toBe('Could not create it — No such project: no-such-project')

    await rpc('projects.setTrusted', { projectId, trusted: false })
    const untrusted = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'later', name: 'Later', project: projectId })
    expect(untrusted.text).toContain('does not make apps in a project it does not trust')
  })

  it('only the orchestrator uses it — it is absent from the coordinating session\'s and the builder\'s profiles', () => {
    expect(profileAllows('orchestrator', 'create_app')).toBe(true)
    expect(profileAllows('builder', 'create_app')).toBe(false)
    expect(profileAllows('scoped', 'create_app')).toBe(false)
  })
})
