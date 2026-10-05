import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcMethods, type AdapterCapabilities, type ExternalAppInfo, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { until } from '../apps/external/test-helpers.js'
import { SessionManager } from './manager.js'

/**
 * An app's building session (M4 C-2) — it stands up together with the app when the app is
 * created, is found by that app's identity, and carries a role prompt around. The store, trust,
 * runtime and template are all real; only the adapter is fake — what this test checks is the
 * options it received (cwd, role prompt).
 */

class Handle implements SessionHandle {
  // A different conversation per session — if it were the same, resuming would be blocked with "another session already holds that conversation"
  readonly externalId: string
  /** The words sent to this session's agent — empty if nobody sent anything */
  readonly sent: string[] = []
  constructor(readonly sessionId: string) {
    this.externalId = `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
  }
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
  /** The event sink received per session — the test emits turns in place of the tool */
  sinks = new Map<string, EventSink>()
  handles = new Map<string, Handle>()
  fail = false
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    if (this.fail) throw new Error(`${this.tool} is not logged in`)
    this.seen.push(opts)
    this.sinks.set(opts.sessionId, emit)
    const h = new Handle(opts.sessionId)
    this.handles.set(opts.sessionId, h)
    return h
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
  rt = new ExternalApps({
    projects: () => store.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    // The same seam as the host's main (C-4) — the manager knows whether the building session is mid-turn
    builderBusy: (ref) => mgr.builderBusy(ref),
    timing: { turnEndDebounceMs: 50, reloadQuietMs: 300 },
  })
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

describe('creating an app stands up its building session', () => {
  it('a project app: cwd is the project root, the app panel is that app, and the role prompt states the app\'s place and rules', async () => {
    const { app, builder } = await create({ projectId, id: 'notes', name: 'Team notes' })
    expect(builder).toMatchObject({ projectId, appId: 'notes', kind: 'worker', tool: 'claude', name: 'Team notes · builder', autoNamed: false, permissionPreset: 'normal' })
    const o = claude.last()
    expect(o.cwd).toBe(repo)
    expect(o.systemPromptAppend).toBe(builder!.roleAppend)
    const role = builder!.roleAppend!
    expect(role).toContain('You are the session that builds the Centralu app "Team notes" (id notes)')
    expect(role).toContain(`App folder: ${join('.centralu', 'apps', 'notes')}/ (${app.dir})`)
    for (const rule of ['runtime/ is a build product Centralu generates', 'npm install', '"__"', 'readOnlyHint', "visibility: ['app']", 'centralu.readJson/writeJson', 'AGENTS.md']) {
      expect(role, rule).toContain(rule)
    }
  })

  it('a user-folder app: cwd is the app folder, and there is no project', async () => {
    const { app, builder } = await create({ projectId: null, id: 'timer', name: 'Timer' })
    expect(builder).toMatchObject({ projectId: null, appId: 'timer', kind: 'worker' })
    expect(claude.last().cwd).toBe(app.dir)
    expect(app.dir).toBe(join(dataRoot, 'apps', 'timer'))
    expect(builder!.roleAppend).toContain(`Your working folder is the app folder: ${app.dir}`)
  })

  it('the caller picks the tool, and the project\'s default tool is used if none is picked', async () => {
    const picked = await create({ projectId, id: 'one', name: 'One', tool: 'codex' })
    expect(picked.builder!.tool).toBe('codex')
    expect(codex.seen).toHaveLength(1)
    // The tool just picked became the project's default (the session-creation rule) — the next app with none picked receives it
    const defaulted = await create({ projectId, id: 'two', name: 'Two' })
    expect(defaulted.builder!.tool).toBe('codex')
  })

  it('the role prompt is loaded again even after a resume', async () => {
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    claude.seen = []
    await mgr.restartSession(builder!.id)
    expect(claude.seen).toHaveLength(1)
    expect(claude.last().systemPromptAppend).toBe(builder!.roleAppend)
    expect(claude.last().cwd).toBe(repo)
  })

  it('if the session fails to start, the app still exists, the reason comes back, and that app has no building session', async () => {
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

describe('it is found by that app\'s building session', () => {
  it('apps.builder returns that session, and there is one building session per app', async () => {
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    await create({ projectId: null, id: 'notes', name: 'Notes (mine)' })
    expect(((await rpc('apps.builder', { appId: 'notes', projectId })) as SessionInfo).id).toBe(builder!.id)
    // The same id in the user folder is a different app — it has its own building session too
    const userBuilder = (await rpc('apps.builder', { appId: 'notes', projectId: null })) as SessionInfo
    expect(userBuilder.id).not.toBe(builder!.id)
    expect(userBuilder.projectId).toBeNull()
    const again = (await rpc('apps.createBuilder', { appId: 'notes', projectId })) as SessionInfo
    expect(again.id).toBe(builder!.id)
  })

  it('deleting the building session makes it nonexistent, and it can be stood up again', async () => {
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    await rpc('agents.deleteSession', { sessionId: builder!.id })
    expect(await rpc('apps.builder', { appId: 'notes', projectId })).toBeNull()
    const fresh = (await rpc('apps.createBuilder', { appId: 'notes', projectId })) as SessionInfo
    expect(fresh.id).not.toBe(builder!.id)
    expect(((await rpc('apps.builder', { appId: 'notes', projectId })) as SessionInfo).id).toBe(fresh.id)
  })

  it('can be stood up for a hand-made app too, but not for an app in an untrusted project', async () => {
    plantApp(join(repo, ...PROJECT_APPS), 'handmade', { server: { command: 'node', args: ['server.mjs'] } })
    rt.refresh()
    const b = (await rpc('apps.createBuilder', { appId: 'handmade', projectId })) as SessionInfo
    expect(b).toMatchObject({ appId: 'handmade', name: 'App handmade · builder' })
    await rpc('projects.setTrusted', { projectId, trusted: false })
    plantApp(join(repo, ...PROJECT_APPS), 'other', { server: { command: 'node', args: ['server.mjs'] } })
    rt.refresh()
    await expect(rpc('apps.createBuilder', { appId: 'other', projectId })).rejects.toThrow(/does not give a builder to an app in a project it does not trust/)
    await expect(rpc('apps.createBuilder', { appId: 'ghost', projectId })).rejects.toThrow(/There is no such app/)
  })

  it('create_app names the session it created and says to hand off what comes next to that session', async () => {
    const orch = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orch.id, 'create_app', { id: 'board', name: 'Board', project: projectId })
    const b = (await rpc('apps.builder', { appId: 'board', projectId })) as SessionInfo
    expect(r.text).toContain(`Building session: Board · builder [${b.id}] — send_to_session it what to build`)
  })
})

describe('a building session tries out its own app (C-3)', () => {
  const servers = (o: CreateSessionOpts) => o.apps?.current().map((a) => a.server)

  it('a project app\'s building session: the project\'s apps attach, and the tool profile is check alone', async () => {
    plantApp(join(repo, ...PROJECT_APPS), 'other', { server: { command: 'node', args: ['server.mjs'] } })
    rt.refresh()
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    const o = claude.last()
    expect(servers(o)).toEqual(['app-notes', 'app-other'])
    expect(o.toolProfile).toBe('builder')
    expect(o.orchestratorTools).toBeDefined()
    expect(o.orchestratorBridge).toEqual({ url: 'ws://127.0.0.1:5999', token: 'tok' })
    expect(mgr.toolProfileOf(builder!.id)).toBe('builder')
    // The list the bridge (Codex) asks for is the same profile
    const tools = (await rpc('orchestrator.tools', { sessionId: builder!.id })) as { name: string }[]
    expect(tools.map((t) => t.name)).toEqual(['check'])
    await expect(mgr.runOrchestratorTool(builder!.id, 'list_sessions', {})).rejects.toThrow(/Not a tool of this session: list_sessions/)
  })

  it('a user-folder app\'s building session: only its own app attaches (other user-folder apps belong to the orchestrator)', async () => {
    await create({ projectId: null, id: 'helper', name: 'Helper' })
    const { builder } = await create({ projectId: null, id: 'timer', name: 'Timer' })
    expect(servers(claude.last())).toEqual(['app-timer'])
    // Still the same after a resume
    claude.seen = []
    expect((await mgr.restartSession(builder!.id)).resumed).toBe(true)
    expect(servers(claude.last())).toEqual(['app-timer'])
    expect(claude.last().toolProfile).toBe('builder')
    // Actually calls the attached app's tool — the template's increment
    const out = await claude.last().apps!.call('app-timer', 'increment', { by: 2 })
    expect(out.structuredContent).toEqual({ count: 2 })
  })

  it('check returns a report on checking its own app — a session cannot pick another', async () => {
    const { builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    const viaSession = await mgr.runOrchestratorTool(builder!.id, 'check', { app: 'someone-else' })
    expect(viaSession.isError).toBeFalsy()
    expect(viaSession.text).toMatch(new RegExp(`^check ${projectId.slice(0, 8)}/notes: passed`))
    // The bridge (Codex) path goes through the same door
    const viaBridge = (await rpc('orchestrator.tool', { sessionId: builder!.id, name: 'check', args: {} })) as { text: string }
    expect(viaBridge.text).toContain('show — reads, model+app, screen ui://notes/index.html')
    // apps.check, called by the UI, is the same decision
    const viaRpc = (await rpc('apps.check', { appId: 'notes', projectId })) as { ok: boolean; findings: unknown[] }
    expect(viaRpc).toMatchObject({ ok: true, findings: [] })
  })

  it('the orchestrator and an ordinary session have no check', async () => {
    const orch = await mgr.orchestrator()
    expect(((await rpc('orchestrator.tools', { sessionId: orch.id })) as { name: string }[]).map((t) => t.name)).not.toContain('check')
    const worker = (await rpc('agents.createSession', { projectId, cwd: repo, tool: 'claude' })) as SessionInfo
    // An ordinary session has the reader set (#320) — read-only, and no check in it
    expect(mgr.toolProfileOf(worker.id)).toBe('reader')
    expect(claude.last().toolProfile).toBe('reader')
    expect(((await rpc('orchestrator.tools', { sessionId: worker.id })) as { name: string }[]).map((t) => t.name)).not.toContain('check')
    await expect(mgr.runOrchestratorTool(worker.id, 'check', {})).rejects.toThrow(/Not a tool of this session/)
  })
})

describe('the app restarts at the end of its building session\'s turn (C-4)', () => {
  it('a change made mid-turn waits, and is picked up with the new code once the turn ends (turn_complete)', async () => {
    const { app, builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    const ref = { projectId, appId: 'notes' }
    await rt.tools(ref)
    const emit = claude.sinks.get(builder!.id)!
    emit({ type: 'state_change', sessionId: builder!.id, state: 'working' })
    expect(mgr.builderBusy(ref)).toBe(true)
    const server = join(app.dir, 'server.mjs')
    writeFileSync(
      server,
      readFileSync(server, 'utf8').replace(
        '  return server\n})',
        "  centralu.tool(server, 'added', { description: 'New', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))\n  return server\n})",
      ),
    )
    rt.refresh()
    await new Promise((r) => setTimeout(r, 600))
    expect(rt.knownTools(ref)!.map((t) => t.name)).not.toContain('added')
    // Waiting on approval also counts as mid-turn
    emit({ type: 'approval_request', sessionId: builder!.id, requestId: 'r1', detail: { kind: 'command', command: 'ls' } } as never)
    expect(mgr.builderBusy(ref)).toBe(true)
    emit({ type: 'state_change', sessionId: builder!.id, state: 'working' })
    emit({ type: 'turn_complete', sessionId: builder!.id })
    expect(mgr.builderBusy(ref)).toBe(false)
    await until(() => rt.knownTools(ref)?.map((t) => t.name) ?? [], (names) => names.includes('added'))
  })
})

describe('an error is not automatically sent to the building session (C-6)', () => {
  it('even when an app\'s tool fails, nothing reaches the building session — apps.errors surfaces the batch instead', async () => {
    const { app, builder } = await create({ projectId, id: 'notes', name: 'Notes' })
    const server = join(app.dir, 'server.mjs')
    writeFileSync(server, readFileSync(server, 'utf8').replace('      state.count += by\n', "      throw new Error('increment is broken')\n"))
    const out = await rt.call({ projectId, appId: 'notes' }, 'increment', { by: 1 }, { kind: 'view' })
    expect(out.status).toBe('error')
    const errors = RpcMethods['apps.errors'].result.parse(await rpc('apps.errors', { appId: 'notes', projectId }))
    expect(errors.latest).toMatchObject({ kind: 'tool', tool: 'increment', args: '{"by":1}', message: 'increment is broken' })
    expect(errors.latest!.text).toContain('App Notes (')
    await new Promise((r) => setTimeout(r, 300))
    expect(claude.handles.get(builder!.id)!.sent).toEqual([])
  })
})
