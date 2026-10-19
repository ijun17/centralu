import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dev-services/store.js'
import { scriptedAdapters } from '../links/scripted-agent.test-helpers.js'
import { createRpcHandler } from '../rpc.js'
import { agentDepthRefusal } from './agent-depth.js'
import { SessionManager } from './manager.js'

/**
 * What a machine answers a hub that starts a child there (#1038): its project's `origin` (`projects.origin`), by which
 * the hub finds its checkout of the caller's repository, and a new session kept at the agent depth the hub gives it
 * (`agents.createSession`'s `agentDepth`), so a child of a child stays within the setting on this machine too.
 */
let root: string
let store: Store
let mgr: SessionManager
let rpc: (method: string, params: unknown) => Promise<unknown>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-linked-start-')))
  store = new Store()
  const adapters = scriptedAdapters()
  mgr = new SessionManager(store, adapters, () => {})
  const handler = createRpcHandler(mgr, adapters)
  rpc = (method, params) => handler(method, params)
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function repo(name: string, origin: string | null): string {
  const dir = join(root, name)
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' })
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
  return dir
}

describe("a project's origin remote (#1038)", () => {
  it('is what git has for origin, and null with no origin or no repository', async () => {
    const withOrigin = (await rpc('projects.add', { path: repo('app', 'git@github.com:me/app.git') })) as { id: string }
    const noOrigin = (await rpc('projects.add', { path: repo('bare', null) })) as { id: string }
    const plain = join(root, 'plain')
    execFileSync('git', ['init', '-q', plain], { stdio: 'ignore' })
    rmSync(join(plain, '.git'), { recursive: true, force: true })
    const notRepo = (await rpc('projects.add', { path: plain })) as { id: string }
    expect(await rpc('projects.origin', { projectId: withOrigin.id })).toEqual({ origin: 'git@github.com:me/app.git' })
    expect(await rpc('projects.origin', { projectId: noOrigin.id })).toEqual({ origin: null })
    expect(await rpc('projects.origin', { projectId: notRepo.id })).toEqual({ origin: null })
  })
})

describe('a session another machine starts, at the depth it gives (#1038)', () => {
  it('keeps that depth as its own, so it starts agents here only as far as the setting allows', async () => {
    const project = (await rpc('projects.add', { path: repo('app', null) })) as { id: string; path: string }
    const child = (await rpc('agents.createSession', { projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal', agentDepth: 1 })) as { id: string }
    expect(store.settings.appSetting(`agent_depth:${child.id}`)).toBe('1')
    // The default setting lets only the person's own sessions start agents
    const host = { meta: new Map(mgr.listSessions().map((s) => [s.id, s])), children: { delegations: new Map() }, uiPreferences: () => mgr.uiPreferences(), store }
    expect(agentDepthRefusal(host, child.id, 'start agents')).toContain('1 level below')
    // One the person makes there has none
    const own = (await rpc('agents.createSession', { projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    expect(store.settings.appSetting(`agent_depth:${own.id}`)).toBeNull()
    expect(agentDepthRefusal(host, own.id, 'start agents')).toBeNull()
  })
})

/**
 * The preset a session another machine's start_agent starts here runs under (#1273): an `auto` caller's child runs
 * `auto` here only while this machine's "Allow auto from a linked computer" switch is on, and anything else keeps the
 * preset the hub gave, `normal` at most. The window's own start is not touched.
 */
describe('a session a linked computer starts, under the preset it carries (#1273)', () => {
  const create = async (more: Record<string, unknown>) => {
    const project = (await rpc('projects.add', { path: repo(`app-${Math.random().toString(36).slice(2)}`, null) })) as { id: string; path: string }
    return (await rpc('agents.createSession', { projectId: project.id, cwd: project.path, tool: 'claude', agentDepth: 1, ...more })) as { id: string; permissionPreset: string; startedFromHub?: boolean }
  }

  it("runs an auto caller's child under auto while the switch is on, says so to the hub, and marks it as started from there", async () => {
    expect(await rpc('host.hubAuto', {})).toEqual({ allowed: true })
    const child = await create({ permissionPreset: 'normal', fromHub: { callerPreset: 'auto' } })
    expect(child).toMatchObject({ permissionPreset: 'auto', startedFromHub: true })
    expect(store.settings.appSetting(`started_from_hub:${child.id}`)).toBe('true')
  })

  it('runs it under normal once the person turns the switch off, and says so to the hub', async () => {
    await rpc('prefs.set', { patch: { hubAuto: false } })
    expect(await rpc('host.hubAuto', {})).toEqual({ allowed: false })
    expect(await create({ permissionPreset: 'normal', fromHub: { callerPreset: 'auto' } })).toMatchObject({ permissionPreset: 'normal', startedFromHub: true })
  })

  // #1273 review (owner decision): the switch only restricts, so a damaged record reads as off, never as on
  it('reads a damaged record as off, and an absent switch as on', async () => {
    store.settings.setAppSetting('ui_preferences', 'not a json object')
    expect(await rpc('host.hubAuto', {})).toEqual({ allowed: false })
    expect(await create({ permissionPreset: 'normal', fromHub: { callerPreset: 'auto' } })).toMatchObject({ permissionPreset: 'normal' })
    store.settings.setAppSetting('ui_preferences', JSON.stringify({ hubAuto: 'yes' }))
    expect(await rpc('host.hubAuto', {})).toEqual({ allowed: false })
    store.settings.setAppSetting('ui_preferences', JSON.stringify({ sessionTools: true }))
    expect(await rpc('host.hubAuto', {})).toEqual({ allowed: true })
  })

  // #1273 review: a machine with no window of its own is set from the hub's Settings → Machines
  it('takes the switch from the hub, and answers it as it now reads', async () => {
    expect(await rpc('host.setHubAuto', { allowed: false })).toEqual({ allowed: false })
    expect(await rpc('host.hubAuto', {})).toEqual({ allowed: false })
    expect(mgr.uiPreferences().hubAuto).toBe(false)
    expect(await rpc('host.setHubAuto', { allowed: true })).toEqual({ allowed: true })
    expect(await create({ permissionPreset: 'normal', fromHub: { callerPreset: 'auto' } })).toMatchObject({ permissionPreset: 'auto' })
  })

  // #1273 review: the mark lives beside the row, and a session read back from the store lost it
  it('keeps the mark through a host restart and through the trash and back', async () => {
    const child = await create({ permissionPreset: 'normal', fromHub: { callerPreset: 'auto' } })
    await rpc('agents.deleteSession', { sessionId: child.id })
    const back = (await rpc('trash.restore', { sessionId: child.id })) as { session: { startedFromHub?: boolean } }
    expect(back.session.startedFromHub).toBe(true)
    expect(mgr.listSessions().find((s) => s.id === child.id)).toMatchObject({ permissionPreset: 'auto', startedFromHub: true })
    await mgr.disposeAll()
    mgr = new SessionManager(store, scriptedAdapters(), () => {})
    expect(mgr.listSessions().find((s) => s.id === child.id)).toMatchObject({ permissionPreset: 'auto', startedFromHub: true })
  })

  it("keeps a normal or safe caller's preset, never above normal, and leaves the window's own start alone", async () => {
    expect(await create({ permissionPreset: 'normal', fromHub: { callerPreset: 'normal' } })).toMatchObject({ permissionPreset: 'normal' })
    expect(await create({ permissionPreset: 'safe', fromHub: { callerPreset: 'safe' } })).toMatchObject({ permissionPreset: 'safe' })
    expect(await create({ permissionPreset: 'auto', fromHub: { callerPreset: 'normal' } })).toMatchObject({ permissionPreset: 'normal' })
    const own = await create({ permissionPreset: 'auto' })
    expect(own.permissionPreset).toBe('auto')
    expect(own.startedFromHub).toBeUndefined()
  })
})
