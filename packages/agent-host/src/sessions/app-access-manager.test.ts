import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, ExternalAppInfo, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { readShared } from './app-access.js'
import { SessionManager } from './manager.js'
import { FIXTURE_APP } from './session-apps.test-helpers.js'

/**
 * Another project's app tools through the manager (#371 part A) — the sharing RPC, the three tools
 * as a session's agent calls them (`runOrchestratorTool`, the Codex bridge's door; Claude's in-process
 * server runs the same function), and what each kind of agent is given: Claude follows the attached
 * set live, a Codex thread is restarted through resume when the turn ends. A real store, real trust
 * and a real app; only the adapter is fake.
 */

class Handle implements SessionHandle {
  externalId = 'ext-1'
  constructor(
    readonly sessionId: string,
    fixedServers: boolean,
  ) {
    // A Codex thread answers whether it has a server; a Claude session follows its set and leaves this out
    if (fixedServers) this.appAttachment = () => 'attached'
  }
  appAttachment?: () => 'attached'
  send() {}
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
}

class CapturingAdapter implements AgentAdapter {
  descriptor = { name: 'x', label: 'X', mark: 'X', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  seen: CreateSessionOpts[] = []
  emits: EventSink[] = []
  constructor(readonly tool: ToolName) {}
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    this.seen.push(opts)
    this.emits.push(emit)
    return new Handle(opts.sessionId, this.tool === 'codex')
  }
  last(): CreateSessionOpts {
    return this.seen.at(-1)!
  }
}

let root = ''
let store: Store
let rt: ExternalApps
let claude: CapturingAdapter
let codex: CapturingAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let alpha = ''
let beta = ''

function repo(name: string): string {
  const dir = join(root, name)
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { cwd: root })
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const servers = (o: CreateSessionOpts) => o.apps?.current().map((a) => a.server)
const tool = (sessionId: string, name: string, args: Record<string, unknown> = {}) => mgr.runOrchestratorTool(sessionId, name, args)

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-access-')))
  const dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  const a = repo('alpha')
  const b = repo('beta')
  const app = { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } }
  plantApp(join(b, ...PROJECT_APPS), 'board', app)

  store = new Store()
  claude = new CapturingAdapter('claude')
  codex = new CapturingAdapter('codex')
  const adapters = new Map<ToolName, AgentAdapter>([
    ['claude', claude],
    ['codex', codex],
  ])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot, reservedIds: ['control'], shared: (ref) => readShared(store, ref) })
  mgr.useExternalApps(rt, { toolListWaitMs: 10_000 })
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  alpha = ((await rpc('projects.add', { path: a })) as { id: string }).id
  beta = ((await rpc('projects.add', { path: b })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId: alpha, trusted: true })
  await rpc('projects.setTrusted', { projectId: beta, trusted: true })
})

/** The person allowed alpha → beta "always" before — for the tests about what attaching does, not about asking */
const allowedBefore = () => store.setProjectConsent(alpha, beta, 'apps')

/** The consent card up in a session, if any (part B's card, `project_access`) */
const card = (sessionId: string) => {
  const p = mgr.listSessions().find((x) => x.id === sessionId)?.pendingApproval
  return p && p.detail.kind === 'project_access' ? { requestId: p.requestId, detail: p.detail } : undefined
}

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

const create = async (projectId: string, t: ToolName) =>
  (await rpc('agents.createSession', { projectId, cwd: join(root, projectId === alpha ? 'alpha' : 'beta'), tool: t })) as SessionInfo

describe('sharing an app (apps.setShared)', () => {
  it('is off by default, shows in the app list when on, and is refused for an app that does not exist', async () => {
    const board = () => (rt.list() as ExternalAppInfo[]).find((x) => x.appId === 'board')!
    expect(board().shared).toBeUndefined()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    expect(board().shared).toBe(true)
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: false })
    expect(board().shared).toBeUndefined()
    await expect(rpc('apps.setShared', { appId: 'nope', projectId: beta, shared: true })).rejects.toThrow(/No such app/)
  })
})

describe('attaching from a session (find_apps, attach_app, detach_app)', () => {
  it("Claude: the app's tools join the live session at once, and leave on detach_app", async () => {
    allowedBefore()
    const s = await create(alpha, 'claude')
    const o = claude.last()
    expect((await tool(s.id, 'find_apps')).text).toContain('No app can be attached')

    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    expect((await tool(s.id, 'find_apps')).text).toContain('- beta/board · project "beta"')

    // What Claude's adapter listens to (syncApps → setMcpServers), not only what a fresh count says. The app is
    // started first, so its tool list arriving cannot be what the adapter hears
    await rt.tools({ projectId: beta, appId: 'board' })
    await waitFor(() => rt.list().find((x) => x.appId === 'board')?.status === 'running')
    let heard = 0
    o.apps!.onChange(() => heard++)
    const attached = await tool(s.id, 'attach_app', { app: 'beta/board' })
    expect(attached.isError).toBeFalsy()
    expect(heard).toBe(1)
    expect(attached.text).toContain('mcp__app-board__poke')
    expect(attached.text).toContain('Its tools are available now.')
    expect(servers(o)).toEqual(['app-board'])
    // Nothing was restarted for it
    expect(claude.seen).toHaveLength(1)

    expect((await tool(s.id, 'detach_app', { app: 'beta/board' })).text).toBe('Detached beta/board: the app-board tools are gone.')
    expect(servers(o)).toEqual([])
    expect(heard).toBe(2)
  })

  it('Codex: the thread is restarted through resume when the turn ends, and then has the app', async () => {
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'codex')
    const emit = codex.emits.at(-1)!
    emit({ type: 'state_change', sessionId: s.id, state: 'working' })

    const attached = await tool(s.id, 'attach_app', { app: 'beta/board' })
    expect(attached.text).toContain('the tools are there from the next turn')
    // Not in the middle of the turn — the call that asked is still running
    expect(codex.seen).toHaveLength(1)

    emit({ type: 'state_change', sessionId: s.id, state: 'waiting_input' })
    await waitFor(() => codex.seen.length === 2)
    expect(codex.last().resumeExternalId).toBe('ext-1')
    expect(servers(codex.last())).toEqual(['app-board'])
  })

  it("a session in a project that is not trusted cannot attach, and a call by an attached app's name is refused once sharing goes off", async () => {
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    await tool(s.id, 'attach_app', { app: 'beta/board' })
    const apps = claude.last().apps!
    expect((await apps.call('app-board', 'peek', {})).isError).toBe(false)

    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: false })
    await waitFor(() => !servers(claude.last())!.includes('app-board'))
    expect((await apps.call('app-board', 'peek', {})).isError).toBe(true)

    await rpc('projects.setTrusted', { projectId: alpha, trusted: false })
    expect((await tool(s.id, 'find_apps')).text).toContain('not trusted')
  })

  /*
   * #382: the switch "Let sessions look at their own project" stops the set at once, and detach_app is part of that
   * set — so an app attached through it has to go with it, or the session keeps tools it can no longer detach.
   */
  it('turning the session tools off in Settings takes attached apps away at once; turning them on brings them back', async () => {
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    await tool(s.id, 'attach_app', { app: 'beta/board' })
    const o = claude.last()
    expect(servers(o)).toEqual(['app-board'])
    let heard = 0
    o.apps!.onChange(() => heard++)

    await rpc('prefs.set', { patch: { sessionTools: false } })
    // What the adapter hears (Claude's syncApps), and a call by the old name (a Codex thread still holding it)
    expect(heard).toBe(1)
    expect(servers(o)).toEqual([])
    expect((await o.apps!.call('app-board', 'peek', {})).isError).toBe(true)

    await rpc('prefs.set', { patch: { sessionTools: true } })
    expect(servers(o)).toEqual(['app-board'])
  })

  it('an attachment survives the session being restarted (resume)', async () => {
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    await tool(s.id, 'attach_app', { app: 'beta/board' })
    await mgr.restartSession(s.id)
    expect(claude.seen).toHaveLength(2)
    expect(servers(claude.last())).toEqual(['app-board'])
  })
})

describe('consent per pair of projects, through the card', () => {
  it('asks once in the calling session; "always" covers the next session of that project, and revoking it detaches the app', async () => {
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    const pending = tool(s.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(s.id))
    expect(card(s.id)!.detail).toMatchObject({ access: 'apps', from: { id: alpha }, to: { id: beta }, app: { appId: 'board' } })
    // Not attached while the person has not answered
    expect(servers(claude.last())).toEqual([])
    mgr.respondApproval(s.id, card(s.id)!.requestId, 'always')
    expect((await pending).text).toContain('Attached: beta/board')
    const first = claude.last()
    expect(servers(first)).toEqual(['app-board'])

    // Another session of the same project: no card
    const t = await create(alpha, 'claude')
    expect((await tool(t.id, 'attach_app', { app: 'beta/board' })).text).toContain('Attached: beta/board')
    expect(card(t.id)).toBeUndefined()

    // Revoked in Settings: both sessions lose the app — at once, not at the app's next change of state
    await waitFor(() => rt.list().find((x) => x.appId === 'board')?.status === 'running')
    // What the adapter hears (Claude's syncApps listens here), not only what a fresh count says
    let heard = 0
    first.apps!.onChange(() => heard++)
    await rpc('projectConsents.revoke', { fromProjectId: alpha, toProjectId: beta, kind: 'apps' })
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toBe(1)
    expect(servers(first)).toEqual([])
    expect(servers(claude.last())).toEqual([])
  })

  it('a denial attaches nothing and is not remembered — the next attempt asks again', async () => {
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    const pending = tool(s.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(s.id))
    mgr.respondApproval(s.id, card(s.id)!.requestId, 'deny')
    const r = await pending
    expect(r.isError).toBe(true)
    expect(r.text).toContain('did not allow')
    expect(servers(claude.last())).toEqual([])
    expect(store.getProjectConsent(alpha, beta, 'apps')).toBeNull()
    void tool(s.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(s.id))
  })
})

async function waitFor(ok: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
