import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults, type NormalizedEvent, type ProjectInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { returnAppFiles } from './apps/external/carry.js'
import { ExternalApps, MANIFEST_FILE } from './apps/external/runtime.js'
import { MANIFEST_VERSION } from './apps/external/manifest.js'
import { Store } from './dev-services/store.js'
import { ADOPTED_USER_APPS_KEY } from './dev-services/store/user-app-adoption.js'
import { createRpcHandler } from './rpc.js'
import { SessionManager } from './sessions/manager.js'
import type { AppSessionKey } from './sessions/session-apps.js'
import { removeTree, tempRoot } from './temp-dir.test-helpers.js'
import { SLOW } from '../../../tooling/test-timing.js'
import { UserAppAdoption, adoptedProjectOf, adoptedUserApp } from './user-app-adoption.js'

/**
 * Existing user-folder apps become projects in place (#1141, docs/plans/root-apps.md §4). Each item kept under the
 * old key `_user/notes` has a test of its own: after the move it is found under `<project id>/notes`, and what a
 * previous build reads by the old key is still there (a swap may hand back to it, docs/agent-host.md §5.1).
 */

let root = ''
let dataRoot = ''
let store: Store
let rt: ExternalApps
let mgr: SessionManager
let adoption: UserAppAdoption
let changed = 0

const OLD = '_user/notes'
const appDir = () => join(dataRoot, 'apps', 'notes')
const project = (): ProjectInfo | undefined => store.projects.listProjects().find((p) => p.path === appDir()) as ProjectInfo | undefined
const newKey = () => `${project()!.id}/notes`

function plantUserApp(id: string, over: Record<string, unknown> = {}): string {
  const dir = join(dataRoot, 'apps', id)
  mkdirSync(dir, { recursive: true })
  const manifest = { manifestVersion: MANIFEST_VERSION, id, name: `App ${id}`, version: '1.0.0', description: 'd', server: { command: 'node', args: ['server.mjs'] }, ...over }
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest))
  return dir
}

function session(id: string, over: Record<string, unknown> = {}): void {
  store.sessions.upsertSession({
    id, projectId: null, kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(), ...over,
  } as never)
}

const grant = (capability: string) => ({ capability, text: `may ${capability}`, decision: 'allow' as const, stamp: 'uses-1', decidedAt: 5 })

let emitted: NormalizedEvent[] = []
/** The builder's handle, live across the move (as one kept running across a host swap is): what its app attachment sees */
let liveBuilder: { current(): { server: string }[] } | null = null

function makeRuntime(): void {
  rt = new ExternalApps({
    projects: () => store.projects.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    adoptedUserApp: (appId, dir) => adoptedUserApp(store, appId, dir),
    adoptedProjectOf: (appId) => adoptedProjectOf(store, appId),
  })
  rt.refresh()
}

/**
 * As main.ts does it: the manager is made, and loads every session, before the adoption runs (once the host is ready).
 * So what the adoption moves in the store, the loaded sessions have to follow (`sessionsMovedToProject`)
 */
function startHost(): void {
  emitted = []
  mgr = new SessionManager(store, new Map<ToolName, AgentAdapter>(), (e) => emitted.push(e))
  mgr.useExternalApps(rt)
  adoption = new UserAppAdoption({ rt, store, sessionsMoved: (ids, pid) => mgr.sessionsMovedToProject(ids, pid), changed: () => changed++ })
}

beforeEach(async () => {
  root = tempRoot('cc-adopt-')
  dataRoot = join(root, 'data')
  mkdirSync(dataRoot)
  store = new Store()
  changed = 0
  plantUserApp('notes', { secrets: ['TOKEN'] })
  plantUserApp('helper')
  makeRuntime()

  // What a user-folder app had kept, under its old key
  mkdirSync(join(dataRoot, 'app-data', '_user', 'notes'), { recursive: true })
  writeFileSync(join(dataRoot, 'app-data', '_user', 'notes', 'state.json'), '{"count":7}')
  mkdirSync(join(dataRoot, 'app-logs', '_user'), { recursive: true })
  writeFileSync(join(dataRoot, 'app-logs', '_user', 'notes.log'), 'latest log\n')
  writeFileSync(join(dataRoot, 'app-logs', '_user', 'notes.log.1'), 'older log\n')
  mkdirSync(join(dataRoot, 'app-versions', '_user', 'notes', '100-abc'), { recursive: true })
  writeFileSync(join(dataRoot, 'app-versions', '_user', 'notes', '100-abc', 'meta.json'), JSON.stringify({ id: '100-abc', at: 100, stamp: 'abc', files: 1, bytes: 1, reason: 'started' }))
  rt.updateSecret({ projectId: null, appId: 'notes' }, 'TOKEN', 'secret-value')
  store.permissions.putAppPermission(OLD, null, grant('agent:claude'))
  store.permissions.putAppPermission('_user/helper', null, grant(`app:${OLD}`))
  store.appRuns.beginAppRun({
    id: 'run-1', projectId: null, appId: 'notes', kind: 'tool', tool: 'show', callerKind: 'view', callerSessionId: null, parentRunId: null,
    status: 'ok', durationMs: 3, argsDigest: 'd', argsSummary: '{}', error: null, createdAt: Date.now(), sessionId: null,
  })
  store.appRuns.keepAppRunFailure({ runId: 'run-1', projectId: null, appId: 'notes', args: '{}', result: null, createdAt: Date.now() }, 20)
  session('builder', { appId: 'notes' })
  session('trashed', { appId: 'notes' })
  await store.trash.trashSession('trashed', { projectId: null, projectName: null, projectPath: null, removeExternal: false, removeWorktree: false })
  store.settings.setAppSetting('apps.builders', JSON.stringify({ [OLD]: 'builder' }))
  store.settings.setAppSetting('session_apps:worker-1', JSON.stringify([{ projectId: null, appId: 'notes', server: 'app-notes', consent: 'none', at: 1 }]))
  store.grid.setGridView([{ kind: 'app', projectId: null, appId: 'notes', span: { cols: 2, rows: 1 } }])
  store.settings.setAppSetting('apps.viewPorts', JSON.stringify({ assigned: { [OLD]: 21234 }, retired: [] }))
  // The name the orchestrator has called it by (#1141): the same app keeps it under its new key
  session('orch', { kind: 'orchestrator' })
  store.settings.setAppSetting('session_app_names:orch', JSON.stringify({ [OLD]: 'app-notes', '_user/gone': 'app-gone' }))
  store.settings.saveWorkspace({ appSpans: { [OLD]: { cols: 3, rows: 2 } }, focusedApp: { projectId: null, appId: 'notes' } })
  // A half copy a host stopped mid-carry left beside its place
  mkdirSync(join(dataRoot, 'app-data', '_user', 'helper.carry-0b7c2e4a-1f3d-4c5b-9a8e-123456789abc'), { recursive: true })

  startHost()
  const hub = (mgr as unknown as { apps: { appsHub: { attach(k: AppSessionKey): { current(): { server: string }[] } } } }).apps.appsHub
  liveBuilder = hub.attach({ id: 'builder', kind: 'worker', projectId: null, builderOf: { projectId: null, appId: 'notes' } })
  expect(liveBuilder.current().map((x) => x.server)).toEqual(['app-notes'])
  // A running host has read the sessions' attachments already: what the adoption carries must not be hidden behind that read
  const access = (mgr as unknown as { apps: { appAccess: { attached(id: string): unknown[] } } }).apps.appAccess
  expect(access.attached('orch')).toEqual([])
  expect(await adoption.run()).toBe(2)
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  store.close()
  await removeTree(root)
})

describe('a user-folder app becomes a project in place', () => {
  it('its folder is registered as a trusted project, whose root app it is; the user folder no longer lists it', () => {
    expect(project()).toMatchObject({ path: appDir(), name: 'notes', trusted: true })
    expect(rt.list().find((a) => a.appId === 'notes')).toMatchObject({ projectId: project()!.id, root: true, dir: appDir(), status: 'stopped' })
    expect(rt.list().filter((a) => a.projectId === null)).toEqual([])
    expect(changed).toBe(1)
  })

  // The Delete project dialog tells such a project from an ordinary one by this (#1301): its folder moves to app-trash/ once nothing can restore it
  it('marks the projects it registered as folders of the user folder, and no other project', async () => {
    const ordinary = join(root, 'ordinary')
    mkdirSync(ordinary, { recursive: true })
    const door = createRpcHandler(mgr, new Map(), { externalApps: rt })
    await door('projects.add', { path: ordinary })
    const listed = (await door('projects.list', {})) as ProjectInfo[]
    expect(listed.find((x) => x.path === appDir())).toMatchObject({ name: 'notes', fromUserFolder: true })
    expect(listed.find((x) => x.name === 'helper')).toMatchObject({ fromUserFolder: true })
    expect(listed.find((x) => x.path === ordinary)).not.toHaveProperty('fromUserFolder')
    // A project added again at the folder, in another spelling, is marked too; one inside it is not (the dialog asks the host, below)
    const first = project()!.id
    await door('projects.delete', { projectId: first })
    store.projects.addProject({ id: 'again', path: join(dataRoot, 'apps', 'NOTES'), name: 'notes' })
    expect(((await door('projects.list', {})) as ProjectInfo[]).find((x) => x.id === 'again')).toMatchObject({ fromUserFolder: true })
    store.projects.addProject({ id: 'inside', path: join(appDir(), 'sub'), name: 'sub' })
    expect(((await door('projects.list', {})) as ProjectInfo[]).find((x) => x.id === 'inside')).not.toHaveProperty('fromUserFolder')
    // Deleted and given back, nothing of it is left to mark
    await door('projects.delete', { projectId: 'again' })
    expect(((await door('projects.list', {})) as ProjectInfo[]).find((x) => x.id === 'again')).toBeUndefined()
  })

  it('carries its data folder, and leaves the old one for a previous build', () => {
    expect(readFileSync(join(dataRoot, 'app-data', newKey(), 'state.json'), 'utf8')).toBe('{"count":7}')
    expect(existsSync(join(dataRoot, 'app-data', OLD, 'state.json'))).toBe(true)
  })

  it('carries its log and the older generation', () => {
    expect(readFileSync(join(dataRoot, 'app-logs', `${newKey()}.log`), 'utf8')).toBe('latest log\n')
    expect(readFileSync(join(dataRoot, 'app-logs', `${newKey()}.log.1`), 'utf8')).toBe('older log\n')
  })

  it('carries its kept versions', () => {
    expect(rt.snapshots({ projectId: project()!.id, appId: 'notes' }).map((s) => s.id)).toEqual(['100-abc'])
  })

  it('carries its secrets, and keeps the old entry', () => {
    expect(rt.list().find((a) => a.appId === 'notes')?.secrets).toEqual([{ name: 'TOKEN', set: true }])
    const file = JSON.parse(readFileSync(join(dataRoot, 'app-secrets.json'), 'utf8')) as Record<string, Record<string, string>>
    expect(file[newKey()]).toEqual({ TOKEN: 'secret-value' })
    expect(file[OLD]).toEqual({ TOKEN: 'secret-value' })
  })

  it('carries its grants, and the grants other apps hold to call it', () => {
    expect(store.permissions.listAppPermissions(newKey()).map((g) => g.capability)).toEqual(['agent:claude'])
    expect(store.permissions.listAppPermissions(OLD).map((g) => g.capability)).toEqual(['agent:claude'])
    expect(store.permissions.listAppPermissions(`${project2('helper')}/helper`).map((g) => g.capability).sort()).toEqual([`app:${OLD}`, `app:${newKey()}`].sort())
  })

  it('moves its run ledger and kept failures to the project', () => {
    const [run] = store.appRuns.listAppRuns(project()!.id, 'notes', 10)
    expect(run).toMatchObject({ id: 'run-1', projectId: project()!.id, failure: { args: '{}', result: null } })
    expect(store.appRuns.listAppRuns(null, 'notes', 10)).toEqual([])
  })

  it('moves its builder into the project, and the builder map names it under the new key; a session in the session archive stays there', async () => {
    expect(store.sessions.listSessions().find((s) => s.id === 'builder')?.projectId).toBe(project()!.id)
    expect(store.trash.isTrashed('trashed')).toBe(true)
    // This same host, which loaded the session before the move, finds it as the app's builder under the new key
    expect(mgr.appSessions.builderOf({ projectId: project()!.id, appId: 'notes' })?.id).toBe('builder')
    expect(mgr.listSessions().find((s) => s.id === 'builder')?.projectId).toBe(project()!.id)
    // And the windows hear of the move
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'session_created', sessionId: 'builder', session: expect.objectContaining({ projectId: project()!.id }) }))
    // Its handle, live across the move, is still given its own app, now the project's root app
    expect(liveBuilder!.current().map((x) => x.server)).toEqual(['app-notes'])
    // So asking for its builder stands no second one up
    expect(await mgr.appSessions.createAppBuilder({ projectId: project()!.id, appId: 'notes' })).toMatchObject({ id: 'builder' })
    expect(JSON.parse(store.settings.appSetting('apps.builders')!)).toEqual({ [OLD]: 'builder', [newKey()]: 'builder' })
  })

  it('rewrites the attachments sessions made to it', () => {
    expect(JSON.parse(store.settings.appSetting('session_apps:worker-1')!)).toEqual([
      { projectId: project()!.id, appId: 'notes', server: 'app-notes', consent: 'none', at: 1 },
    ])
  })

  it('moves its grid panel, span and all, to the new key', () => {
    expect(store.grid.listGridView()).toEqual([{ kind: 'app', projectId: project()!.id, appId: 'notes', span: { cols: 2, rows: 1 } }])
  })

  it('carries the names sessions have called it by, so the same app keeps its name and no other takes it', () => {
    expect(JSON.parse(store.settings.appSetting('session_app_names:orch')!)).toEqual({ [newKey()]: 'app-notes', '_user/gone': 'app-gone' })
  })

  // #1205: the orchestrator is given the user-folder apps, and attaches a root app when it needs one
  it('keeps it attached to the orchestrator that had it, under the name it called it by, as an attachment of its own', () => {
    expect(JSON.parse(store.settings.appSetting('session_apps:orch')!)).toEqual([
      { projectId: project()!.id, appId: 'notes', server: 'app-notes', consent: 'none', at: expect.any(Number) },
    ])
    const hub = (mgr as unknown as { apps: { appsHub: { refsFor(k: AppSessionKey): { server: string; ref: { projectId: string | null } }[] } } }).apps.appsHub
    // helper became a project too, and this orchestrator had never seen it: it finds it when it needs it
    expect(hub.refsFor({ id: 'orch', kind: 'orchestrator', projectId: null }).map((h) => [h.server, h.ref.projectId])).toEqual([['app-notes', project()!.id]])
  })

  it('keeps its view origin port, so its browser storage stays its own', () => {
    expect(JSON.parse(store.settings.appSetting('apps.viewPorts')!).assigned).toEqual({ [OLD]: 21234, [newKey()]: 21234 })
  })

  it("carries the window's span for it and the app it had open", () => {
    expect(store.settings.loadWorkspace()).toEqual({
      appSpans: { [OLD]: { cols: 3, rows: 2 }, [newKey()]: { cols: 3, rows: 2 } },
      focusedApp: { projectId: project()!.id, appId: 'notes' },
    })
  })

  it('runs once: again changes nothing, and a project the person deletes is not registered again', async () => {
    const before = { projects: store.projects.listProjects().length, adopted: store.settings.appSetting(ADOPTED_USER_APPS_KEY) }
    expect(await adoption.run()).toBe(0)
    expect(store.projects.listProjects()).toHaveLength(before.projects)
    await mgr.deleteProject(project()!.id)
    rt.refresh()
    expect(await adoption.run()).toBe(0)
    expect(project()).toBeUndefined()
    expect(rt.list().find((a) => a.appId === 'notes')).toBeUndefined()
    expect(store.settings.appSetting(ADOPTED_USER_APPS_KEY)).toBe(before.adopted)
  })

  it('a different folder made later under the same name is a new app, and is registered', async () => {
    await mgr.deleteProject(project()!.id)
    rmSync(appDir(), { recursive: true })
    plantUserApp('notes')
    rt.refresh()
    expect(await adoption.run()).toBe(1)
    expect(project()).toMatchObject({ trusted: true })
  })

  /*
   * #1152's full tier, on Linux: ext4 gives a folder made where one was just removed the same inode, and the same birth
   * time (a coarse clock; both measured under WSL), so a record bound to the folder's file id took the new folder for the
   * deleted project's and left it out. Windows and macOS do not hand the id out again at once, so the reuse is made here
   */
  it("a folder made later under the same name is new even when it has the old folder's file id, as on ext4", async () => {
    await mgr.deleteProject(project()!.id)
    // The deleted project's folder stays out
    rt.refresh()
    expect(await adoption.run()).toBe(0)
    rmSync(appDir(), { recursive: true })
    plantUserApp('notes')
    const record = JSON.parse(store.settings.appSetting(ADOPTED_USER_APPS_KEY)!) as Record<string, Record<string, unknown>>
    record.notes!.ino = statSync(appDir(), { bigint: true }).ino.toString()
    store.settings.setAppSetting(ADOPTED_USER_APPS_KEY, JSON.stringify(record))
    rt.refresh()
    expect(await adoption.run()).toBe(1)
    expect(project()).toMatchObject({ trusted: true })
  })

  /*
   * #1152's keeper e2e (macOS): a call by the old key `user/<id>` answered "There is no such app". Anything still holding
   * the old key (an older window during a swap, a stored name, a script) reaches the project's app
   */
  it('its old key user/<id> still reaches it, until its project is deleted', async () => {
    const old = { projectId: null, appId: 'notes' }
    const now = { projectId: project()!.id, appId: 'notes' }
    expect(rt.resolve(old)).toEqual(now)
    expect(rt.exists(old)).toBe(true)
    const out = await rt.call(old, 'echo', {}, { kind: 'view' })
    expect(out.error ?? '').not.toContain('no such app')
    expect(rt.runs(old).map((r) => r.id)).toEqual(rt.runs(now).map((r) => r.id))
    expect(rt.resolve({ projectId: null, appId: 'helper' })).toEqual({ projectId: store.projects.listProjects().find((p) => p.name === 'helper')!.id, appId: 'helper' })
    // Deleting the project ends it
    await mgr.deleteProject(now.projectId)
    rt.refresh()
    expect(rt.exists(old)).toBe(false)
    expect(rt.resolve(old)).toEqual(old)
  })

  it('one that appears later (an approved MCP server) follows, without a restart', async () => {
    adoption.watch()
    rt.installUserApp({ id: 'server-x', name: 'Server X', description: 'd', server: { command: 'npx', args: ['x'] } })
    await expect.poll(() => rt.list().find((a) => a.appId === 'server-x')?.root).toBe(true)
  })
})

/*
 * #1204: a deleted project that a user-folder app had become left its folder in `<data>/apps/`, listed nowhere (the
 * user folder skips adopted folders, no project points at it) and removable by nothing, with what it kept beside it.
 * It is given back once nothing in the session archive can restore the project: to `app-trash/`, as a removed user-folder app.
 */
/**
 * What deleting a project may do to its folder (#1301, `projects.deleteOutlook`): the Delete project dialog asks when it opens, with
 * the real-path matching the give-back uses, where the list's mark goes by spelling.
 */
describe('what deleting a project may do to its folder', () => {
  const door = (name: string, params: unknown) =>
    createRpcHandler(mgr, new Map(), { externalApps: rt, deleteOutlook: (id) => adoption.outlook(id) })(name as never, params)
  const outlook = async (projectId: string) => ((await door('projects.deleteOutlook', { projectId })) as { folder: string }).folder
  const gone = async () => {
    // The adopted project deleted: its builder is in the session archive, so the folder stays where it is
    await door('projects.delete', { projectId: project()!.id })
    expect(existsSync(appDir())).toBe(true)
  }

  it('may move the folder of the adopted project; an ordinary project, or one it does not know, leaves its folder alone', async () => {
    const ordinary = join(root, 'ordinary')
    mkdirSync(ordinary, { recursive: true })
    store.projects.addProject({ id: 'ordinary', path: ordinary, name: 'ordinary' })
    expect(await outlook(project()!.id)).toBe('may_move')
    expect(await outlook('ordinary')).toBe('stays')
    expect(await outlook('no-such-project')).toBe('stays')
  })

  it('answers "stays" without the call wired (a host that links nothing)', async () => {
    const bare = createRpcHandler(mgr, new Map(), { externalApps: rt })
    expect(await bare('projects.deleteOutlook' as never, { projectId: project()!.id })).toEqual({ folder: 'stays' })
  })

  it('counts a project added again through a junction or a link, which the list\'s mark by spelling does not find', async () => {
    await gone()
    const link = join(root, 'linked-notes')
    symlinkSync(appDir(), link, 'junction')
    store.projects.addProject({ id: 'linked', path: link, name: 'notes' })
    const listed = (await door('projects.list', {})) as ProjectInfo[]
    expect(listed.find((x) => x.id === 'linked')).not.toHaveProperty('fromUserFolder')
    expect(await outlook('linked')).toBe('may_move')
  })

  it('counts a project added again at the folder in another spelling', async () => {
    await gone()
    store.projects.addProject({ id: 'again', path: join(dataRoot, 'apps', 'NOTES'), name: 'notes' })
    expect(await outlook('again')).toBe('may_move')
  })

  it('leaves a project added again alone while the adopted project is still registered: deleting it cannot release the folder', async () => {
    store.projects.addProject({ id: 'again', path: join(dataRoot, 'apps', 'NOTES'), name: 'notes' })
    expect(await outlook('again')).toBe('stays')
  })

  it('says the folder around a project inside it may move once the adopted project is gone, and leaves it alone before', async () => {
    mkdirSync(join(appDir(), 'sub'), { recursive: true })
    store.projects.addProject({ id: 'inside', path: join(appDir(), 'sub'), name: 'sub' })
    expect(await outlook('inside')).toBe('stays')
    await gone()
    expect(await outlook('inside')).toBe('around_may_move')
  })

  // Not called an app folder: the give-back counts such a path as at the folder, but nothing says it is one
  it.runIf(process.platform === 'win32')('says it is not sure of a path it cannot resolve: a UNC path, a drive that is not there', async () => {
    await gone()
    store.projects.addProject({ id: 'share', path: '\\\\server\\share\\notes', name: 'notes' })
    expect(await outlook('share')).toBe('unsure')
    const letter = 'QRSTUVWXYZ'.split('').find((l) => !existsSync(`${l}:\\`))!
    store.projects.addProject({ id: 'unplugged', path: `${letter}:\\notes`, name: 'notes' })
    expect(await outlook('unplugged')).toBe('unsure')
  })

  it('does not mistake an unrelated project for one of an app folder before the adopted project is gone', async () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    store.projects.addProject({ id: 'elsewhere', path: elsewhere, name: 'elsewhere' })
    expect(await outlook('elsewhere')).toBe('stays')
    await gone()
    // The adopted project is gone, its folder waits in the session archive's hold: a project elsewhere is still not one of it
    expect(await outlook('elsewhere')).toBe('stays')
  })

  it('reads each adopted folder on its own: with two, the one whose project is gone decides for a project at it', async () => {
    const helper = store.projects.listProjects().find((p) => p.name === 'helper')!
    expect(await outlook(helper.id)).toBe('may_move')
    await gone()
    store.projects.addProject({ id: 'again', path: join(dataRoot, 'apps', 'NOTES'), name: 'notes' })
    expect(await outlook('again')).toBe('may_move')
    expect(await outlook(helper.id)).toBe('may_move')
  })

  it('leaves it alone when the folder is not the one the adoption recorded (another folder of that name)', async () => {
    const pid = project()!.id
    writeFileSync(join(appDir(), '.centralu', 'adopted'), 'someone-else')
    expect(await outlook(pid)).toBe('stays')
  })

  it('is routed to the machine of a project, as the delete is', async () => {
    const { ROUTES } = await import('./links/routes.js')
    expect(ROUTES['projects.deleteOutlook']).toEqual(ROUTES['projects.delete'])
  })
})

describe('a deleted project gives its folder back', () => {
  const adopted = () => JSON.parse(store.settings.appSetting(ADOPTED_USER_APPS_KEY) ?? '{}') as Record<string, unknown>
  const trashed = () => (existsSync(join(dataRoot, 'app-trash')) ? readdirSync(join(dataRoot, 'app-trash')) : [])
  const helperDir = () => join(dataRoot, 'apps', 'helper')
  const helperProject = () => store.projects.listProjects().find((p) => p.path === helperDir())!.id
  /** The doors that delete a project and delete all archived sessions, as main.ts wires them; `settling` is the give-back they started */
  let settling: Promise<void> = Promise.resolve()
  const door = (name: string, params: unknown) =>
    createRpcHandler(mgr, new Map(), { externalApps: rt, settleDeletedProjects: () => (settling = adoption.settle()) })(name as never, params)

  it('keeps it while a session of the project is in the session archive, so a restore finds it; gives it back, with its data, once none is', async () => {
    const pid = project()!.id
    // What the app wrote as the project's app, after its state was carried from the old key
    writeFileSync(join(dataRoot, 'app-data', pid, 'notes', 'state.json'), '{"count":9}')
    writeFileSync(join(dataRoot, 'app-logs', pid, 'notes.log'), 'project log\n')
    await door('projects.delete', { projectId: pid })
    await settling
    // The builder was archived with the project: restoring it needs the folder where it was
    expect(existsSync(join(appDir(), MANIFEST_FILE))).toBe(true)
    expect(adopted().notes).toBeDefined()
    expect(trashed()).toEqual([])
    // And it does: the project comes back under its id, with its root app
    const { project: back } = await mgr.trash.restoreSession('builder')
    expect(back).toMatchObject({ id: pid, path: appDir() })
    rt.refresh()
    expect(rt.list().find((a) => a.appId === 'notes')).toMatchObject({ projectId: pid, root: true })
    await door('projects.delete', { projectId: pid })
    await settling

    // A previous build served after a rollback and wrote under the old key only: this exists nowhere else
    writeFileSync(join(dataRoot, 'app-data', '_user', 'notes', 'rollback.json'), 'only here')
    await door('trash.purge', { sessionId: 'builder' })
    await settling
    expect(existsSync(appDir())).toBe(false)
    const entry = trashed().find((n) => /^notes-\d+$/.test(n))!
    expect(trashed().sort()).toEqual([entry, `${entry}-user-data`])
    expect(existsSync(join(dataRoot, 'app-trash', entry, MANIFEST_FILE))).toBe(true)
    expect(adopted().notes).toBeUndefined()
    // What it kept went back to the user-folder key, the project's copy in place of the one it was carried from
    expect(readFileSync(join(dataRoot, 'app-data', '_user', 'notes', 'state.json'), 'utf8')).toBe('{"count":9}')
    expect(readFileSync(join(dataRoot, 'app-logs', '_user', 'notes.log'), 'utf8')).toBe('project log\n')
    expect(existsSync(join(dataRoot, 'app-versions', '_user', 'notes', '100-abc', 'meta.json'))).toBe(true)
    expect(existsSync(join(dataRoot, 'app-data', pid))).toBe(false)
    expect(readdirSync(join(dataRoot, 'app-data', '_user')).filter((n) => n.includes('.carry-'))).toEqual([])
    // And nothing the old key held is gone: it is beside the folder, the logs and versions too, where no sweep looks
    const kept = join(dataRoot, 'app-trash', `${entry}-user-data`)
    expect(readFileSync(join(kept, 'app-data', 'notes', 'rollback.json'), 'utf8')).toBe('only here')
    expect(readFileSync(join(kept, 'app-data', 'notes', 'state.json'), 'utf8')).toBe('{"count":7}')
    expect(readFileSync(join(kept, 'app-logs', 'notes.log'), 'utf8')).toBe('latest log\n')
    expect(readFileSync(join(kept, 'app-logs', 'notes.log.1'), 'utf8')).toBe('older log\n')
    expect(existsSync(join(kept, 'app-versions', 'notes', '100-abc', 'meta.json'))).toBe(true)
    rt.sweepCarryLeftovers()
    expect(readFileSync(join(kept, 'app-data', 'notes', 'rollback.json'), 'utf8')).toBe('only here')

    // Put back into the user folder, it is a new project with its data
    renameSync(join(dataRoot, 'app-trash', entry), appDir())
    rt.refresh()
    expect(await adoption.run()).toBe(1)
    expect(project()!.id).not.toBe(pid)
    expect(readFileSync(join(dataRoot, 'app-data', project()!.id, 'notes', 'state.json'), 'utf8')).toBe('{"count":9}')
  })

  it('a project with nothing in the session archive gives it back when deleted; nothing comes back', async () => {
    const pid = helperProject()
    await door('projects.delete', { projectId: pid })
    await settling
    expect(existsSync(helperDir())).toBe(false)
    expect(trashed().filter((n) => /^helper-\d+$/.test(n))).toHaveLength(1)
    expect(adopted().helper).toBeUndefined()
    expect(await adoption.run()).toBe(0)
    expect(store.projects.listProjects().find((p) => p.id === pid || p.path === helperDir())).toBeUndefined()
  })

  it('keeps a folder the person added again as a project when the session archive is emptied, and gives it back once that project goes too', async () => {
    const pid = project()!.id
    await door('projects.delete', { projectId: pid })
    await settling
    // The person adds the folder again, spelled another way (Windows and macOS fold case): a new project there
    store.projects.addProject({ id: 'again', path: join(dataRoot, 'apps', 'NOTES'), name: 'notes' })
    await door('trash.empty', {})
    await settling
    expect(existsSync(join(appDir(), MANIFEST_FILE))).toBe(true)
    expect(adopted().notes).toBeDefined()
    expect(readFileSync(join(dataRoot, 'app-data', '_user', 'notes', 'state.json'), 'utf8')).toBe('{"count":7}')
    expect(trashed()).toEqual([])
    // That project deleted too, with nothing of either in the session archive: the folder is given back
    rt.refresh()
    await door('projects.delete', { projectId: 'again' })
    await settling
    expect(existsSync(appDir())).toBe(false)
    expect(trashed().filter((n) => /^notes-\d+$/.test(n))).toHaveLength(1)
  })

  it("a host stopped between setting the old copy aside and moving the project's in leaves both; the next return finishes", () => {
    const pid = project()!.id
    const keep = join(dataRoot, 'app-trash', 'notes-1-user-data')
    // As the first rename leaves them: the old key's copy set aside, the project's not moved yet
    mkdirSync(join(keep, 'app-data'), { recursive: true })
    renameSync(join(dataRoot, 'app-data', '_user', 'notes'), join(keep, 'app-data', 'notes'))
    writeFileSync(join(keep, 'app-data', 'notes', 'rollback.json'), 'only here')
    // The next start sweeps what interrupted carries left; the set-aside copy is not one of them
    rt.sweepCarryLeftovers()
    expect(readFileSync(join(keep, 'app-data', 'notes', 'rollback.json'), 'utf8')).toBe('only here')
    returnAppFiles(dataRoot, `${pid}/notes`, '_user/notes', join(dataRoot, 'app-trash', 'notes-2-user-data'))
    expect(readFileSync(join(dataRoot, 'app-data', '_user', 'notes', 'state.json'), 'utf8')).toBe('{"count":7}')
    expect(existsSync(join(dataRoot, 'app-data', pid))).toBe(false)
    expect(readFileSync(join(keep, 'app-data', 'notes', 'rollback.json'), 'utf8')).toBe('only here')
  })

  it('keeps a folder added again as a project through a link (a symbolic link, a junction)', async () => {
    const pid = project()!.id
    await door('projects.delete', { projectId: pid })
    await settling
    const link = join(root, 'linked-notes')
    symlinkSync(appDir(), link, 'junction')
    store.projects.addProject({ id: 'linked', path: link, name: 'notes' })
    await door('trash.empty', {})
    await settling
    expect(existsSync(join(appDir(), MANIFEST_FILE))).toBe(true)
    expect(adopted().notes).toBeDefined()
    expect(trashed()).toEqual([])
  })

  it('keeps a folder a project lives inside', async () => {
    const pid = project()!.id
    await door('projects.delete', { projectId: pid })
    await settling
    mkdirSync(join(appDir(), 'ui'))
    store.projects.addProject({ id: 'inside', path: join(appDir(), 'ui'), name: 'ui' })
    // A sibling whose name only starts the same is not inside it
    store.projects.addProject({ id: 'sibling', path: join(dataRoot, 'apps', 'notes-site'), name: 'notes-site' })
    await door('trash.empty', {})
    await settling
    expect(existsSync(join(appDir(), MANIFEST_FILE))).toBe(true)
    expect(trashed()).toEqual([])
    rt.refresh()
    await door('projects.delete', { projectId: 'inside' })
    await settling
    expect(existsSync(appDir())).toBe(false)
  })

  it.runIf(process.platform === 'win32')('keeps the folder while a project is on a drive that is not there now (a subst gone since a restart)', async () => {
    const pid = project()!.id
    await door('projects.delete', { projectId: pid })
    await settling
    const absent = 'QRSTUVWXYZ'.split('').find((d) => !existsSync(`${d}:\\`))!
    store.projects.addProject({ id: 'unplugged', path: `${absent}:\\notes`, name: 'notes' })
    await door('trash.empty', {})
    await settling
    expect(existsSync(join(appDir(), MANIFEST_FILE))).toBe(true)
    expect(trashed()).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('keeps the folder while a project path cannot be resolved (a link loop)', async () => {
    const pid = project()!.id
    await door('projects.delete', { projectId: pid })
    await settling
    const loop = join(root, 'loop')
    symlinkSync(loop, loop)
    store.projects.addProject({ id: 'looped', path: loop, name: 'loop' })
    await door('trash.empty', {})
    await settling
    expect(existsSync(join(appDir(), MANIFEST_FILE))).toBe(true)
    expect(trashed()).toEqual([])
  })

  it.runIf(process.platform === 'win32')('keeps the folder while a project is on a share, which is never resolved', async () => {
    const pid = project()!.id
    await door('projects.delete', { projectId: pid })
    await settling
    store.projects.addProject({ id: 'shared', path: '\\\\nowhere.invalid\\share\\notes', name: 'notes' })
    await door('trash.empty', {})
    await settling
    expect(existsSync(join(appDir(), MANIFEST_FILE))).toBe(true)
    expect(trashed()).toEqual([])
  })

  it('never touches a folder that is not the one the project was made from, nor what is kept for it', async () => {
    const pid = helperProject()
    mkdirSync(join(dataRoot, 'app-data', pid, 'helper'), { recursive: true })
    writeFileSync(join(dataRoot, 'app-data', pid, 'helper', 'state.json'), 'project data')
    await mgr.deleteProject(pid)
    rt.refresh()
    // Another folder of the same name, made by hand meanwhile, with data of its own: it carries no mark of the adoption
    rmSync(helperDir(), { recursive: true })
    plantUserApp('helper')
    writeFileSync(join(helperDir(), 'mine.txt'), 'keep me')
    mkdirSync(join(dataRoot, 'app-data', '_user', 'helper'), { recursive: true })
    writeFileSync(join(dataRoot, 'app-data', '_user', 'helper', 'state.json'), 'hand-made data')
    rt.refresh()
    expect(await adoption.run()).toBe(1)
    expect(readFileSync(join(helperDir(), 'mine.txt'), 'utf8')).toBe('keep me')
    expect(readFileSync(join(dataRoot, 'app-data', '_user', 'helper', 'state.json'), 'utf8')).toBe('hand-made data')
    expect(readFileSync(join(dataRoot, 'app-data', pid, 'helper', 'state.json'), 'utf8')).toBe('project data')
    expect(trashed()).toEqual([])
    // It became a project of its own
    expect(adopted().helper).toMatchObject({ projectId: helperProject() })
    expect(helperProject()).not.toBe(pid)
  })

  it('a give-back that fails is tried again while the host runs', async () => {
    const retrying = new UserAppAdoption({ rt, store, sessionsMoved: () => {}, changed: () => {}, retryMs: 20 })
    // The session archive folder cannot be made (a file holds its name): the folder cannot move, as one in use on Windows cannot
    writeFileSync(join(dataRoot, 'app-trash'), 'in the way')
    await mgr.deleteProject(helperProject())
    rt.refresh()
    expect(await retrying.run()).toBe(0)
    expect(existsSync(join(helperDir(), MANIFEST_FILE))).toBe(true)
    expect(adopted().helper).toBeDefined()
    rmSync(join(dataRoot, 'app-trash'))
    await expect.poll(() => existsSync(helperDir()), { timeout: 5000 * SLOW }).toBe(false)
    expect(adopted().helper).toBeUndefined()
  })

  it('does nothing before the host is ready; its first run, once ready, gives back what is waiting', async () => {
    // A new host on its way up: a swap may still hand back to the build serving now, so nothing moves yet
    const early = new UserAppAdoption({ rt, store, sessionsMoved: () => {}, changed: () => {} })
    await mgr.deleteProject(helperProject())
    rt.refresh()
    await early.settle()
    expect(existsSync(join(helperDir(), MANIFEST_FILE))).toBe(true)
    expect(adopted().helper).toBeDefined()
    // Ready: a project deleted before this build, or while the host was down, is given back by the first run
    expect(await early.run()).toBe(0)
    expect(existsSync(helperDir())).toBe(false)
    expect(adopted().helper).toBeUndefined()
  })
})

describe('what is not moved, and when', () => {
  it('a folder whose manifest names another id (a backup copy) or does not pass stays in the user folder, listed with its reason, and the log says so', async () => {
    plantUserApp('notes-copy', { id: 'notes' })
    plantUserApp('broken', { name: '' })
    rt.refresh()
    expect(await adoption.run()).toBe(0)
    expect(store.projects.listProjects().map((p) => p.name).sort()).toEqual(['helper', 'notes'])
    const left = rt.list().filter((a) => a.projectId === null)
    expect(left.map((a) => [a.appId, a.status])).toEqual([['broken', 'invalid'], ['notes-copy', 'invalid']])
    // One runnable app of the id, the one adopted
    expect(rt.list().filter((a) => a.appId === 'notes' && a.status !== 'invalid')).toHaveLength(1)
  })

  it('half copies an interrupted move left are swept', () => {
    expect(existsSync(join(dataRoot, 'app-data', '_user', 'helper.carry-0b7c2e4a-1f3d-4c5b-9a8e-123456789abc'))).toBe(false)
  })

  it('runs once the host is ready, where the steps a swap left for later run, not while it starts', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    const ready = main.indexOf('console.log(JSON.stringify({ ready: true')
    expect(ready).toBeGreaterThan(0)
    const runs = [...main.matchAll(/userAppAdoption\.run\(\)/g)].map((m) => m.index!)
    expect(runs.length).toBeGreaterThan(0)
    for (const at of runs) expect(at).toBeGreaterThan(ready)
  })
})

describe('an imported app the person never enabled', () => {
  it('becomes an untrusted project: it does not run until the person trusts it', async () => {
    const src = join(root, 'src', 'gift')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, MANIFEST_FILE), JSON.stringify({ manifestVersion: MANIFEST_VERSION, id: 'gift', name: 'Gift', version: '1', description: 'd', server: { command: 'node', args: ['x.mjs'] } }))
    const { token } = await rt.prepareImport(src)
    rt.commitImport(token, { enable: false })
    expect(rt.list().find((a) => a.appId === 'gift')?.status).toBe('unconfirmed')
    expect(await adoption.run()).toBe(1)
    const gift = rt.list().find((a) => a.appId === 'gift')!
    expect(gift).toMatchObject({ root: true, status: 'untrusted', trusted: false })
  })
})

/** The project a user-folder app became, by its app id */
function project2(id: string): string | undefined {
  return store.projects.listProjects().find((p) => p.path === join(dataRoot, 'apps', id))?.id
}
