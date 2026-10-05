import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalAppInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { ExternalApps } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import { createRpcHandler } from './rpc.js'

/**
 * The external app RPC door (M4 A) — observed from the exact spot the webview actually knocks on.
 *
 * The runtime tests (apps/external/*.test.ts) run against a fake project list. Here, a real store
 * and manager are wired in, to check that the path where trust **is written to the store and the
 * runtime reads it back** is actually connected — both sides can be green on their own while the
 * wire between them is broken.
 */

let fixture = ''
let projRoot = ''
let store: Store
let rt: ExternalApps
let rpc: ReturnType<typeof createRpcHandler>

const list = async () => (await rpc('apps.list', {})) as ExternalAppInfo[]

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-rpc-')))
  projRoot = join(fixture, 'proj')
  mkdirSync(join(fixture, 'data'))
  mkdirSync(projRoot)
  plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
  // One app that actually comes up — knocks all the way through the mediation RPC door
  plantApp(join(projRoot, ...PROJECT_APPS), 'live', {
    server: { command: process.execPath, args: [fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url)), '--mode', 'mediation'] },
  })

  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(store, adapters, () => {})
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(fixture, 'data'), reservedIds: ['control'] })
  rt.refresh()
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
})

afterEach(async () => {
  await rt.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('external app RPC — trust', () => {
  it('an app from a newly registered project stands in the list untrusted, and follows trust being turned on and off', async () => {
    expect(await list()).toEqual([])
    const { id, trusted } = (await rpc('projects.add', { path: projRoot })) as { id: string; trusted: boolean }
    // The value that decides whether the view asks about trust — a newly registered project comes
    // in as "no"
    expect(trusted).toBe(false)

    expect((await list()).filter((a) => a.appId === 'notes').map((a) => [a.appId, a.projectId, a.status])).toEqual([['notes', id, 'untrusted']])

    await rpc('projects.setTrusted', { projectId: id, trusted: true })
    expect(store.projectRoots()[0]?.trusted).toBe(true)
    // The value the project menu's trust toggle reads — also carried into the list
    expect(((await rpc('projects.list', {})) as { id: string; trusted: boolean }[]).map((p) => [p.id, p.trusted])).toEqual([[id, true]])
    expect((await list()).find((a) => a.appId === 'notes')?.status).toBe('stopped')

    await rpc('projects.setTrusted', { projectId: id, trusted: false })
    expect((await list()).find((a) => a.appId === 'notes')?.status).toBe('untrusted')

    await rpc('projects.delete', { projectId: id })
    expect(await list()).toEqual([])
  })

  it('apps.restart only reaches discovered apps — a nonexistent app is rejected with its name', async () => {
    const { id } = (await rpc('projects.add', { path: projRoot })) as { id: string }
    await expect(rpc('apps.restart', { appId: 'notes', projectId: id })).resolves.toEqual({ ok: true })
    await expect(rpc('apps.restart', { appId: 'ghost', projectId: id })).rejects.toThrow(/There is no such app: .*\/ghost/)
  })

  it('setting trust on a nonexistent project does not silently succeed', async () => {
    await expect(rpc('projects.setTrusted', { projectId: 'nope', trusted: true })).rejects.toThrow(/Project not found/)
  })
})

describe('external app RPC — apps.invoke', () => {
  it("given a projectId, it routes through external app mediation — the caller is the view, and the app's answer is carried through as is", async () => {
    const { id } = (await rpc('projects.add', { path: projRoot })) as { id: string }
    await rpc('projects.setTrusted', { projectId: id, trusted: true })

    const ok = (await rpc('apps.invoke', { appId: 'live', projectId: id, name: 'app_only', args: {} })) as Record<string, unknown>
    expect(ok).toMatchObject({ text: 'app_only ran', isError: false, status: 'ok', result: { content: [{ type: 'text', text: 'app_only ran' }] } })
    expect(ok.runId).toMatch(/^run_/)

    // A tool not open to the view — the host does not send it to the app and states the reason
    const refused = (await rpc('apps.invoke', { appId: 'live', projectId: id, name: 'model_only', args: {} })) as Record<string, unknown>
    expect(refused).toMatchObject({ status: 'rejected', isError: true })
    expect(refused.text).toContain('visibility')
    expect(refused.result).toBeUndefined()
  })

  it("with no projectId the call goes to the user folder — the retired control app's tools are gone (#97)", async () => {
    await expect(rpc('apps.invoke', { appId: 'control', name: 'control_notify', args: { text: 'x' } })).rejects.toThrow(
      /There is no such app: user\/control/,
    )
    // The retired state calls still answer, so a window from an older build gets a well-formed reply
    await rpc('apps.setState', { appId: 'control', doc: { notifies: [] } })
    expect(await rpc('apps.state', { appId: 'control' })).toEqual({ doc: { notifies: [] }, enabled: true })
  })
})
