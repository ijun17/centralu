import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults, type ProjectInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { ExternalApps, MANIFEST_FILE } from './apps/external/runtime.js'
import { MANIFEST_VERSION } from './apps/external/manifest.js'
import { Store } from './dev-services/store.js'
import { ADOPTED_USER_APPS_KEY } from './dev-services/store/user-app-adoption.js'
import { SessionManager } from './sessions/manager.js'
import { removeTree, tempRoot } from './temp-dir.test-helpers.js'
import { UserAppAdoption, adoptedUserApp } from './user-app-adoption.js'

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

function makeRuntime(): void {
  rt = new ExternalApps({
    projects: () => store.projects.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    adoptedUserApp: (appId, dir) => adoptedUserApp(store, appId, dir),
  })
  rt.refresh()
  mgr.useExternalApps(rt)
  adoption = new UserAppAdoption({ rt, store, addProject: (path, opts) => mgr.addProject(path, opts), changed: () => changed++ })
}

beforeEach(async () => {
  root = tempRoot('cc-adopt-')
  dataRoot = join(root, 'data')
  mkdirSync(dataRoot)
  store = new Store()
  mgr = new SessionManager(store, new Map<ToolName, AgentAdapter>(), () => {})
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
  store.settings.saveWorkspace({ appSpans: { [OLD]: { cols: 3, rows: 2 } }, focusedApp: { projectId: null, appId: 'notes' } })

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

  it('moves its builder into the project, and the builder map names it under the new key; a session in the trash stays there', () => {
    expect(store.sessions.listSessions().find((s) => s.id === 'builder')?.projectId).toBe(project()!.id)
    expect(store.trash.isTrashed('trashed')).toBe(true)
    // The next host start finds it as the app's builder, under the app's new key
    const next = new SessionManager(store, new Map<ToolName, AgentAdapter>(), () => {})
    expect(next.builderOf({ projectId: project()!.id, appId: 'notes' })?.id).toBe('builder')
    void next.disposeAll()
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

  it('one that appears later (an approved MCP server) follows, without a restart', async () => {
    adoption.watch()
    rt.installUserApp({ id: 'server-x', name: 'Server X', description: 'd', server: { command: 'npx', args: ['x'] } })
    await expect.poll(() => rt.list().find((a) => a.appId === 'server-x')?.root).toBe(true)
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
