import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { handoffNotePath, writeHandoffNote } from '../dev-services/handoff-notes.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { readOff, readShared } from './app-access.js'
import { SessionManager } from './manager.js'
import { CapturingAdapter as BaseAdapter, FIXTURE_APP } from './session-apps.test-helpers.js'
import { fixtureGit, removeTree, tempRoot } from '../temp-dir.test-helpers.js'

/**
 * Another project's app tools through the manager (#371 part A) — the sharing RPC, the three tools
 * as a session's agent calls them (`runCentraluTool`, the stdio bridge's door; Claude's in-process
 * server runs the same function), and the app reached through Centralu's `app` tool, on every CLI at
 * once with nothing restarted (#2231). A real store, real trust and a real app; only the adapter is fake.
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

class CapturingAdapter extends BaseAdapter {
  override descriptor = { name: 'x', label: 'X', mark: 'X', install: 'x', login: 'x' }
  /** The apps each session had when its tool started, read inside the start as a real adapter reads them (its instructions name an app's help, #957) */
  startServers = new Map<string, string[] | undefined>()
  /** The next start throws, after the manager has built the session's apps */
  failNext = false
  failedId = ''
  protected override handle(opts: CreateSessionOpts) {
    this.startServers.set(opts.sessionId, servers(opts))
    if (this.failNext) {
      this.failNext = false
      this.failedId = opts.sessionId
      throw new Error('the tool did not start')
    }
    return new Handle(opts.sessionId)
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
  fixtureGit(root, ['init', '-q', '-b', 'main', dir])
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  fixtureGit(dir, ['add', '.'])
  fixtureGit(dir, ['commit', '-qm', 'init'])
  return dir
}

const servers = (o: CreateSessionOpts) => o.apps?.current().map((a) => a.server)
const tool = (sessionId: string, name: string, args: Record<string, unknown> = {}) => mgr.runCentraluTool(sessionId, name, args)
/** One app tool called the way the session's agent calls it: through Centralu's `app` tool (#2231) */
const call = (sessionId: string, app: string, name: string, args: Record<string, unknown> = {}) => tool(sessionId, 'app', { action: 'call', app, tool: name, args })

beforeEach(async () => {
  root = tempRoot('cc-app-access-')
  const dataRoot = join(root, 'data')
  vi.stubEnv('CC_DATA_DIR', dataRoot)
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
  rt = new ExternalApps({ projects: () => store.projects.projectRoots(), dataRoot, reservedIds: ['control'], shared: (ref) => readShared(store.settings, ref), off: (ref) => readOff(store.settings, ref) })
  mgr.apps.useExternalApps(rt, { toolListWaitMs: 10_000 })
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  alpha = ((await rpc('projects.add', { path: a })) as { id: string }).id
  beta = ((await rpc('projects.add', { path: b })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId: alpha, trusted: true })
  await rpc('projects.setTrusted', { projectId: beta, trusted: true })
})

/** The person allowed alpha → beta "always" before — for the tests about what attaching does, not about asking */
const allowedBefore = () => store.permissions.setProjectConsent(alpha, beta, 'apps')

/** The consent card up in a session, if any (part B's card, `project_access`) */
const card = (sessionId: string) => {
  const p = mgr.listSessions().find((x) => x.id === sessionId)?.pendingApproval
  return p && p.detail.kind === 'project_access' ? { requestId: p.requestId, detail: p.detail } : undefined
}

afterEach(async () => {
  await mgr.tenure.disposeAll()
  await rt.dispose()
  await removeTree(root)
})

const create = async (projectId: string, t: ToolName) =>
  (await rpc('agents.createSession', { projectId, cwd: join(root, projectId === alpha ? 'alpha' : 'beta'), tool: t })) as SessionInfo

describe('sharing an app (apps.setShared)', () => {
  /*
   * An untrusted project's apps attach nowhere, auto included (owner, #1141): #603 opened them to an auto session; it no
   * longer does for apps. The caller under auto may still reach out from its untrusted project, to a trusted one's app
   */
  it.each(['claude', 'codex'] as const)('%s: auto does not attach or call an untrusted project\'s app, from any caller', async (cli) => {
    const s = await mgr.createSession({ projectId: alpha, cwd: join(root, 'alpha'), tool: cli, permissionPreset: 'auto' })
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    await rpc('projects.setTrusted', { projectId: alpha, trusted: false })
    await rpc('projects.setTrusted', { projectId: beta, trusted: false })
    rt.refresh()
    expect(rt.list().find((a) => a.appId === 'board')?.status).toBe('untrusted')
    expect((await tool(s.id, 'find_apps')).text).not.toContain('beta/board')
    const result = await mgr.runCentraluTool(s.id, 'attach_app', { app: 'beta/board' })
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('not trusted') })
    expect(card(s.id)).toBeUndefined()
    expect(mgr.consents.projectConsents()).toEqual([])
    // Nor is it run for that session, by any name
    expect((await rt.call({ projectId: beta, appId: 'board' }, 'peek', {}, { kind: 'session', sessionId: s.id })).status).toBe('rejected')
  })

  it('auto keeps an existing attachment after remembered consent is revoked, until its own preset changes', async () => {
    const s = await create(alpha, 'claude')
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    expect((await tool(s.id, 'attach_app', { app: 'beta/board' })).isError).toBeFalsy()
    await mgr.updateSettings(s.id, { permissionPreset: 'auto' })
    mgr.consents.revokeProjectConsent(alpha, beta, 'apps')
    expect(servers(claude.last())).toContain('app-board')
    expect((await call(s.id, 'board', 'peek')).isError).toBe(false)
    await mgr.updateSettings(s.id, { permissionPreset: 'normal' })
    expect(servers(claude.last())).not.toContain('app-board')
  })

  it.each(['safe', 'normal'] as const)('%s still refuses untrusted callers and target apps', async (preset) => {
    const s = await mgr.createSession({ projectId: alpha, cwd: join(root, 'alpha'), tool: 'claude', permissionPreset: preset })
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    await rpc('projects.setTrusted', { projectId: beta, trusted: false })
    rt.refresh()
    expect((await tool(s.id, 'attach_app', { app: 'beta/board' })).isError).toBe(true)
    await rpc('projects.setTrusted', { projectId: alpha, trusted: false })
    expect((await tool(s.id, 'find_apps')).isError).toBe(true)
    expect(card(s.id)).toBeUndefined()
  })

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

describe('an app off on this computer (apps.setOff, #1938, docs/plans/remote-hub.md §13.7)', () => {
  it("is taken from its own project's sessions and from one that attached it, refused by name, and given back when on", async () => {
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const own = await create(beta, 'claude')
    const ownOpts = claude.last()
    const other = await create(alpha, 'codex')
    await tool(other.id, 'attach_app', { app: 'beta/board' })
    const otherOpts = codex.last()
    expect([servers(ownOpts), servers(otherOpts)]).toEqual([['app-board'], ['app-board']])
    expect((await call(own.id, 'board', 'peek')).isError).toBe(false)

    await rpc('apps.setOff', { appId: 'board', projectId: beta, off: true })
    expect(store.settings.appSetting(`app_off:${beta}/board`)).toBe('1')
    await waitFor(() => servers(ownOpts)!.length === 0 && servers(otherOpts)!.length === 0)
    expect(rt.list().find((a) => a.appId === 'board')).toMatchObject({ status: 'stopped', off: true })
    expect((await call(own.id, 'board', 'peek')).isError).toBe(true)
    expect(await rpc('apps.reach', { sessionId: own.id, appId: 'board', projectId: beta })).toEqual({ reachable: false, reason: 'app-unusable', status: 'off' })
    // Not offered to attach either, and asked for by name, the agent is told who can turn it on
    expect((await tool(other.id, 'find_apps')).text).not.toContain('beta/board')
    expect((await tool(other.id, 'attach_app', { app: 'beta/board' })).text).toContain('turned off on this computer')
    // Its own project's session is told the same, not that the app is attached already
    expect((await tool(own.id, 'attach_app', { app: 'beta/board' })).text).toContain('turned off on this computer')
    // Nothing above started it again
    expect(rt.list().find((a) => a.appId === 'board')?.status).toBe('stopped')

    await rpc('apps.setOff', { appId: 'board', projectId: beta, off: false })
    expect(store.settings.appSetting(`app_off:${beta}/board`)).toBeNull()
    await waitFor(() => servers(ownOpts)!.length === 1 && servers(otherOpts)!.length === 1)
    expect((await call(own.id, 'board', 'peek')).isError).toBe(false)
    await expect(rpc('apps.setOff', { appId: 'nope', projectId: beta, off: true })).rejects.toThrow(/No such app/)
  })
})

describe('attaching from a session (find_apps, attach_app, detach_app)', () => {
  it.each(['claude', 'codex'] as const)("%s: the app is the session's at once through the app tool, with nothing restarted, and leaves on detach_app", async (cli) => {
    const adapter = cli === 'claude' ? claude : codex
    allowedBefore()
    const s = await create(alpha, cli)
    const o = adapter.last()
    expect((await tool(s.id, 'find_apps')).text).toContain('No app can be attached')

    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    expect((await tool(s.id, 'find_apps')).text).toContain('- beta/board · project "beta"')

    const attached = await tool(s.id, 'attach_app', { app: 'beta/board' })
    expect(attached.isError).toBeFalsy()
    expect(attached.text).toContain('Attached: beta/board as "board".')
    expect(attached.text).toContain('poke')
    expect(attached.text).toContain('app(action="call", app="board", tool=…, args={…})')
    expect(servers(o)).toEqual(['app-board'])
    expect((await tool(s.id, 'app', { action: 'list' })).text).toContain('- board: ')
    expect((await call(s.id, 'board', 'peek')).isError).toBe(false)
    // Nothing was restarted for it
    expect(adapter.seen).toHaveLength(1)

    expect((await tool(s.id, 'detach_app', { app: 'beta/board' })).text).toBe('Detached beta/board: calls to "board" are refused from now on.')
    expect(servers(o)).toEqual([])
    expect(await call(s.id, 'board', 'peek')).toMatchObject({ isError: true, text: expect.stringContaining('This session has no app named "board"') })
    expect(adapter.seen).toHaveLength(1)
  })

  it("a session in a project that is not trusted cannot attach, and a call by an attached app's name is refused once sharing goes off", async () => {
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    await tool(s.id, 'attach_app', { app: 'beta/board' })
    expect((await call(s.id, 'board', 'peek')).isError).toBe(false)

    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: false })
    await waitFor(() => !servers(claude.last())!.includes('app-board'))
    expect((await call(s.id, 'board', 'peek')).isError).toBe(true)

    await rpc('projects.setTrusted', { projectId: alpha, trusted: false })
    expect((await tool(s.id, 'find_apps')).text).toContain('not trusted')
  })

  /*
   * #382 took attached apps away when the switch "Let sessions look at other sessions" went off. The switch is gone (owner
   * decision 2026-10-20, always on): an "off" an older window sends leaves what is attached, "once" and "always" alike
   */
  it('an "off" an older window sends for the session tools leaves attached apps, "once" and "always" alike', async () => {
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const once = await create(alpha, 'claude')
    const pending = tool(once.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(once.id))
    mgr.inputs.respondApproval(once.id, card(once.id)!.requestId, 'allow')
    expect((await pending).text).toContain('Attached: beta/board')
    const onceOpts = claude.last()
    // The person says "always" for the pair afterwards, in another session of the same project
    const always = await create(alpha, 'claude')
    const asked = tool(always.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(always.id))
    mgr.inputs.respondApproval(always.id, card(always.id)!.requestId, 'always')
    await asked
    const alwaysOpts = claude.last()
    expect([servers(onceOpts), servers(alwaysOpts)]).toEqual([['app-board'], ['app-board']])

    await rpc('prefs.set', { patch: { sessionTools: false } })
    expect([servers(onceOpts), servers(alwaysOpts)]).toEqual([['app-board'], ['app-board']])
    expect((await call(once.id, 'board', 'peek')).isError).toBeFalsy()
  })

  it('an attachment survives the session being restarted (resume)', async () => {
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    await tool(s.id, 'attach_app', { app: 'beta/board' })
    await mgr.processes.restartSession(s.id)
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
    mgr.inputs.respondApproval(s.id, card(s.id)!.requestId, 'always')
    expect((await pending).text).toContain('Attached: beta/board')
    const first = claude.last()
    expect(servers(first)).toEqual(['app-board'])

    // Another session of the same project: no card
    const t = await create(alpha, 'claude')
    expect((await tool(t.id, 'attach_app', { app: 'beta/board' })).text).toContain('Attached: beta/board')
    expect(card(t.id)).toBeUndefined()

    // Revoked in Settings: both sessions lose the app — at once, not at the app's next change of state
    await waitFor(() => rt.list().find((x) => x.appId === 'board')?.status === 'running')
    await rpc('projectConsents.revoke', { fromProjectId: alpha, toProjectId: beta, kind: 'apps' })
    expect(servers(first)).toEqual([])
    expect(servers(claude.last())).toEqual([])
    expect((await call(s.id, 'board', 'peek')).isError).toBe(true)
  })

  it('a denial attaches nothing and is not remembered — the next attempt asks again', async () => {
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    const pending = tool(s.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(s.id))
    mgr.inputs.respondApproval(s.id, card(s.id)!.requestId, 'deny')
    const r = await pending
    expect(r.isError).toBe(true)
    expect(r.text).toContain('did not allow')
    expect(servers(claude.last())).toEqual([])
    expect(store.permissions.getProjectConsent(alpha, beta, 'apps')).toBeNull()
    void tool(s.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(s.id))
  })
})

describe('a handoff carries the attached apps (#1638)', () => {
  /** The handoff as the window does it: the note on disk, then the successor created from the original */
  async function handOff(from: SessionInfo, t: ToolName, removesOriginal = false) {
    await writeHandoffNote(alpha, from.id, 'NOTE BODY')
    return mgr.createSession({
      projectId: alpha, cwd: join(root, 'alpha'), tool: t, permissionPreset: 'normal', initialPrompt: 'You are taking over.',
      handoff: { from: 'Planner', note: 'NOTE BODY', fromSessionId: from.id, ...(removesOriginal ? { removesOriginal: true } : {}) },
    })
  }

  async function withTwoApps(t: ToolName) {
    plantApp(join(root, 'beta', ...PROJECT_APPS), 'ledger', { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } })
    rt.refresh()
    allowedBefore()
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    await rpc('apps.setShared', { appId: 'ledger', projectId: beta, shared: true })
    const s = await create(alpha, t)
    expect((await tool(s.id, 'attach_app', { app: 'beta/board' })).isError).toBeFalsy()
    expect((await tool(s.id, 'attach_app', { app: 'beta/ledger' })).isError).toBeFalsy()
    return s
  }

  it.each(['claude', 'codex'] as const)('%s: the successor starts with both apps, their tools callable, the original keeps its own, and the note lists them', async (cli) => {
    const adapter = cli === 'claude' ? claude : codex
    const s = await withTwoApps(cli)
    const original = adapter.last()
    const heir = await handOff(s, cli)

    const opened = adapter.last()
    expect(opened.sessionId).toBe(heir.id)
    // What the tool read while it started, not what a count says afterwards: the session is not known to the host yet then
    expect(adapter.startServers.get(heir.id)).toEqual(['app-board', 'app-ledger'])
    expect(servers(opened)).toEqual(['app-board', 'app-ledger'])
    expect((await call(heir.id, 'ledger', 'peek')).isError).toBe(false)
    // A copy: the original keeps its own, and detaching there leaves the successor's alone
    expect(servers(original)).toEqual(['app-board', 'app-ledger'])
    expect((await tool(s.id, 'detach_app', { app: 'beta/board' })).isError).toBeFalsy()
    expect(servers(opened)).toEqual(['app-board', 'app-ledger'])
    const note = readFileSync(handoffNotePath(alpha, s.id), 'utf8')
    expect(note).toContain('The previous session had these apps attached.')
    expect(note).toContain('- app "beta/board" — attached to you too — handle: app-board. Its tools are yours under that server name.')
    expect(note).toContain('- app "beta/ledger" — attached to you too — handle: app-ledger.')
    expect(note).not.toContain('not attached to you')
  })

  it('when the original is removed, the successor holds the apps under its own trust', async () => {
    const s = await withTwoApps('claude')
    const heir = await handOff(s, 'claude', true)
    await mgr.trash.trashSession(s.id)
    expect(claude.startServers.get(heir.id)).toEqual(['app-board', 'app-ledger'])
    // Revoking the pair's consent takes them from the successor as from any session that attached them
    await rpc('projectConsents.revoke', { fromProjectId: alpha, toProjectId: beta, kind: 'apps' })
    await waitFor(() => servers(claude.last())!.length === 0)
    expect(mgr.listSessions().some((x) => x.id === heir.id)).toBe(true)
  })

  /** An app the person allowed once, for this session's attachment (#382), on a session that is `normal` */
  async function withOnceApp() {
    await rpc('apps.setShared', { appId: 'board', projectId: beta, shared: true })
    const s = await create(alpha, 'claude')
    const pending = tool(s.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(s.id))
    mgr.inputs.respondApproval(s.id, card(s.id)!.requestId, 'allow')
    expect((await pending).text).toContain('Attached: beta/board')
    return s
  }

  it('does not copy an "Allow once" answer to the successor of an original that stays: the note says to attach it again, and the person is asked there', async () => {
    const s = await withOnceApp()
    const heir = await handOff(s, 'claude')

    expect(claude.startServers.get(heir.id)).toEqual([])
    expect(store.settings.appSetting(`session_apps:${heir.id}`)).toBeNull()
    const note = readFileSync(handoffNotePath(alpha, s.id), 'utf8')
    expect(note).toContain('- app "beta/board" — not attached to you — handle: beta/board. It does not carry over')
    expect(note).toContain('attach it again with attach_app, where the person is asked')
    expect(note).not.toContain('attached to you too')
    // Attaching it there asks the person
    const again = tool(heir.id, 'attach_app', { app: 'beta/board' })
    await waitFor(() => !!card(heir.id))
    mgr.inputs.respondApproval(heir.id, card(heir.id)!.requestId, 'deny')
    expect((await again).isError).toBe(true)
    // The original keeps its own
    expect(servers(claude.seen.find((o) => o.sessionId === s.id)!)).toEqual(['app-board'])
  })

  it('copies an "Allow once" answer when the original goes: it is a move', async () => {
    const s = await withOnceApp()
    const heir = await handOff(s, 'claude', true)
    await mgr.trash.trashSession(s.id)

    expect(claude.startServers.get(heir.id)).toEqual(['app-board'])
    expect((await call(heir.id, 'board', 'peek')).isError).toBe(false)
    expect(readFileSync(handoffNotePath(alpha, s.id), 'utf8')).toContain('- app "beta/board" — attached to you too — handle: app-board.')
  })

  it('a start that fails after the copy leaves no row of the successor', async () => {
    const s = await withTwoApps('claude')
    claude.failNext = true
    await expect(handOff(s, 'claude')).rejects.toThrow('the tool did not start')
    expect(claude.failedId).not.toBe('')
    // The copy was made and counted when the tool started, then the start failed
    expect(claude.startServers.get(claude.failedId)).toEqual(['app-board', 'app-ledger'])
    expect(store.settings.appSetting(`session_apps:${claude.failedId}`)).toBeNull()
    // The original's own are as they were
    expect(store.settings.appSetting(`session_apps:${s.id}`)).not.toBeNull()
  })
})

async function waitFor(ok: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
