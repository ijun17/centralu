import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MachineInfo, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { CrossAdapter } from './cross-project.test-helpers.js'
import { commandsFor, profileAllows, RARE_TIERS } from './orchestrator-tools.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The orchestrator's add_project and list_machines (#1220), on this computer: a folder that already exists becomes a
 * project only after the person's card, which shows what was found there; a missing path, a file or an existing
 * project is refused before any card; Allow registers it as the sidebar's Add project does. The linked-machine side is
 * in links/links.test.ts, with two real hosts.
 */
let root: string
let store: Store
let events: NormalizedEvent[]
let mgr: SessionManager
let rpc: (method: string, params: unknown) => Promise<unknown>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-addproj-')))
  store = new Store()
  events = []
  const adapters = new Map<ToolName, CrossAdapter>([['claude', new CrossAdapter('claude')]])
  const agents = adapters as unknown as Map<ToolName, AgentAdapter>
  mgr = new SessionManager(store, agents, (e) => events.push(e))
  const handler = createRpcHandler(mgr, agents)
  rpc = (method, params) => handler(method, params)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The add-folder card standing in a session, if one is */
function card(sessionId: string) {
  const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
  return pending?.detail.kind === 'project_add' ? { requestId: pending.requestId, detail: pending.detail } : undefined
}

/** add_project as the orchestrator reaches it in the default tier: a command behind centralu_run */
function addProject(orcId: string, args: Record<string, unknown>) {
  return mgr.runOrchestratorTool(orcId, 'centralu_run', { command: 'add_project', args })
}

function gitRepo(path: string, origin?: string): string {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', path])
  if (origin) execFileSync('git', ['-C', path, 'remote', 'add', 'origin', origin])
  return path
}

describe('add_project on this computer', () => {
  it('shows the card with the path, that it is a folder, and the git repository with its origin; nothing is added before Allow', async () => {
    const site = gitRepo(join(root, 'code', 'site'), 'git@github.com:me/site.git')
    const orc = await mgr.orchestrator()
    const call = addProject(orc.id, { path: site })
    await eventually(() => !!card(orc.id))
    expect(card(orc.id)!.detail).toEqual({
      kind: 'project_add',
      name: 'site',
      path: site,
      exists: true,
      folder: true,
      git: true,
      origin: 'git@github.com:me/site.git',
      text: `Add the existing folder ${site} as the project site? It is a git repository (origin git@github.com:me/site.git).`,
    })
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])

    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    const r = await call
    expect(r.isError).toBeFalsy()
    const listed = (await rpc('projects.list', {})) as { id: string; path: string; name: string; trusted: boolean }[]
    expect(listed.map((p) => [p.path, p.name, p.trusted])).toEqual([[site, 'site', false]])
    expect(r.text).toContain(`[${listed[0]!.id}]`)
    expect(r.text).toContain(JSON.stringify(site))
    // The windows hear which project it is, to ask about its trust as the sidebar's Add project does
    expect(events).toContainEqual({ type: 'projects_changed', added: listed[0]!.id })
  })

  it('registers it exactly as the sidebar does: the same spelling and trust that projects.add gives the same folder', async () => {
    const plain = join(root, 'Plain')
    mkdirSync(plain)
    const orc = await mgr.orchestrator()
    // A trailing separator, as a person or a model may type it
    const call = addProject(orc.id, { path: `${plain}/` })
    await eventually(() => !!card(orc.id))
    expect(card(orc.id)!.detail).toMatchObject({ path: plain, git: false, origin: null })
    expect(card(orc.id)!.detail.text).toContain('not a git repository')
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    expect((await call).isError).toBeFalsy()
    const [added] = (await rpc('projects.list', {})) as { id: string; path: string; trusted: boolean }[]
    // The sidebar's call for the same folder finds that project, as it would one it had added itself
    expect(await rpc('projects.add', { path: plain })).toMatchObject({ id: added!.id, path: added!.path, trusted: false })
  })

  it('adds nothing when the person denies it', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const orc = await mgr.orchestrator()
    const call = addProject(orc.id, { path: plain })
    await eventually(() => !!card(orc.id))
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'deny')
    const r = await call
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/did not approve/)
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
    expect(events.some((e) => e.type === 'projects_changed')).toBe(false)
  })

  it('refuses a missing path, a file, a folder already a project and a path that is not full, each before any card', async () => {
    writeFileSync(join(root, 'notes.txt'), 'a file')
    const kept = join(root, 'kept')
    mkdirSync(kept)
    await rpc('projects.add', { path: kept })
    const orc = await mgr.orchestrator()
    for (const [path, reason] of [
      [join(root, 'nowhere'), /Nothing is at/],
      [join(root, 'notes.txt'), /is a file, not a folder/],
      [kept, /already the project "kept"/],
      ['code/site', /full path/],
    ] as const) {
      const r = await addProject(orc.id, { path })
      expect(r.isError, path).toBe(true)
      expect(r.text, path).toMatch(reason)
      expect(card(orc.id), path).toBeUndefined()
    }
    expect(((await rpc('projects.list', {})) as unknown[]).length).toBe(1)
  })

  it('asks under auto too: an existing folder is never added without the person', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const orc = await mgr.orchestrator()
    await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
    const call = addProject(orc.id, { path: plain })
    await eventually(() => !!card(orc.id))
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'deny')
    expect((await call).isError).toBe(true)
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
  })

  it('reads the folder again after Allow: one gone while the card stood is not added', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const orc = await mgr.orchestrator()
    const call = addProject(orc.id, { path: plain })
    await eventually(() => !!card(orc.id))
    rmSync(plain, { recursive: true })
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    const r = await call
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/changed while the card stood/)
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
  })

  it("reads ~ as this machine's home", async () => {
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
    const site = join(root, 'Desktop', 'site')
    mkdirSync(site, { recursive: true })
    const orc = await mgr.orchestrator()
    const call = addProject(orc.id, { path: '~/Desktop/site' })
    await eventually(() => !!card(orc.id))
    expect(card(orc.id)!.detail.path).toBe(site)
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'deny')
    await call
  })

  it('refuses a machine that is not linked, before any card', async () => {
    const orc = await mgr.orchestrator()
    const r = await addProject(orc.id, { path: root, machine: 'laptop' })
    expect(r).toEqual({ text: 'No project was added: No machine is linked to this computer; leave machine out', isError: true })
    expect(card(orc.id)).toBeUndefined()
  })
})

describe('list_machines', () => {
  const machine = (over: Partial<MachineInfo>): MachineInfo =>
    ({
      id: 'm1',
      name: 'laptop',
      sshTarget: 'laptop',
      shell: 'posix',
      wslDistro: null,
      command: null,
      status: 'connected',
      error: null,
      versions: null,
      lastConnectedAt: null,
      localPort: null,
      sameLocalPort: false,
      hostStarted: null,
      install: null,
      operation: null,
      autostart: null,
      elevated: null,
      autoReconnect: true,
      connect: 'at_start',
      ...over,
    }) as MachineInfo

  it('lists each machine machines.list answers: name, status, OS and shell, and whether it reconnects by itself', async () => {
    const list = [
      machine({ id: 'm1', name: 'laptop', shell: 'powershell', status: 'connected' }),
      machine({ id: 'm2', name: 'pi', shell: 'posix', status: 'unreachable', autostart: { on: true, how: 'systemd', linger: true } }),
      machine({ id: 'm3', name: 'studio', shell: 'wsl', wslDistro: 'Ubuntu', status: 'disconnected', autoReconnect: false, connect: 'when_needed' }),
    ]
    mgr.useMachineList(() => list)
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'centralu_run', { command: 'list_machines', args: {} })
    expect(r.isError).toBeFalsy()
    expect(r.text.split('\n').slice(0, 3)).toEqual([
      '- "laptop" [m1]: connected; Windows, PowerShell; auto reconnect on',
      '- "pi" [m2]: unreachable; Linux, Unix shell; auto reconnect on',
      '- "studio" [m3]: disconnected; Linux in WSL (Ubuntu) on Windows; auto reconnect off (only the person connects it again)',
    ])
  })

  it('says when no machine is linked', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'centralu_run', { command: 'list_machines', args: {} })
    expect(r.text).toMatch(/No machine is linked/)
  })
})

describe('who may call them', () => {
  it('only the orchestrator, as rare commands in the default tier; no other seat in any tier', () => {
    for (const name of ['add_project', 'list_machines']) {
      expect(commandsFor('orchestrator', 'commands')).toContain(name)
      for (const tier of RARE_TIERS) {
        for (const profile of ['scoped', 'builder', 'reader'] as const) {
          expect(profileAllows(profile, name, tier), `${profile} ${tier} ${name}`).toBe(false)
          expect(commandsFor(profile, tier), `${profile} ${tier}`).not.toContain(name)
        }
      }
    }
  })

  it("runs for the orchestrator, and refuses an ordinary session's call by name and through centralu_run", async () => {
    const dir = join(root, 'proj')
    mkdirSync(dir)
    const project = (await rpc('projects.add', { path: dir })) as { id: string }
    await rpc('projects.setTrusted', { projectId: project.id, trusted: true })
    const s = (await rpc('agents.createSession', { projectId: project.id, cwd: dir, tool: 'claude' })) as { id: string }
    const other = join(root, 'other')
    mkdirSync(other)
    await expect(mgr.runOrchestratorTool(s.id, 'add_project', { path: other })).rejects.toThrow(/Not a tool of this session: add_project/)
    await expect(mgr.runOrchestratorTool(s.id, 'list_machines', {})).rejects.toThrow(/Not a tool of this session: list_machines/)
    await expect(mgr.runOrchestratorTool(s.id, 'centralu_run', { command: 'add_project', args: { path: other } })).rejects.toThrow(/Not a tool of this session/)
    expect(card(s.id)).toBeUndefined()
    expect(((await rpc('projects.list', {})) as unknown[]).length).toBe(1)
    // The same calls from the orchestrator run: its card stands, and the machine list answers
    const orc = await mgr.orchestrator()
    const call = addProject(orc.id, { path: other })
    await eventually(() => !!card(orc.id))
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'deny')
    expect((await call).isError).toBe(true)
    expect((await mgr.runOrchestratorTool(orc.id, 'centralu_run', { command: 'list_machines', args: {} })).isError).toBeFalsy()
  })
})
