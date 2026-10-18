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
