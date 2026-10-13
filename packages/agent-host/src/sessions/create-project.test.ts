import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { projectsHome } from '../dev-services/project-folder.js'
import { CrossAdapter } from './cross-project.test-helpers.js'

/**
 * Making a new project (#515): `projects.create` from a dialog, and the orchestrator's create_project behind an approval
 * card. Every folder here is under a temp root; the "home" is a folder in it handed to the manager, so nothing is
 * ever made in the home of whoever runs the tests.
 */
let root: string
let home: string
let centralu: string
let store: Store
let claude: CrossAdapter
let events: NormalizedEvent[]
let mgr: SessionManager
let rpc: (method: string, params: unknown) => Promise<unknown>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-newproj-')))
  // A home with nothing in it yet: `~/Centralu` is made on first use
  home = join(root, 'home')
  mkdirSync(home)
  centralu = join(home, 'Centralu')
  store = new Store()
  events = []
  claude = new CrossAdapter('claude')
  const adapters = new Map<ToolName, CrossAdapter>([['claude', claude]])
  const agents = adapters as unknown as Map<ToolName, AgentAdapter>
  mgr = new SessionManager(store, agents, (e) => events.push(e))
  mgr.useProjectsHome(() => projectsHome(process.platform, home, { USERPROFILE: home }))
  const handler = createRpcHandler(mgr, agents)
  rpc = (method, params) => handler(method, params)
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** The card raised in a session, when it is a new-project card */
function card(sessionId: string) {
  const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
  return pending?.detail.kind === 'project_create' ? { requestId: pending.requestId, detail: pending.detail } : undefined
}

describe('projects.create', () => {
  it('makes an empty folder in ~/Centralu, making ~/Centralu when it is missing, and registers it', async () => {
    const info = (await rpc('projects.create', { name: 'game' })) as { id: string; name: string; path: string }
    expect(info.path).toBe(join(centralu, 'game'))
    expect(info.name).toBe('game')
    expect(readdirSync(info.path)).toEqual([])
    // No git init: the folder is not a repository
    expect(existsSync(join(info.path, '.git'))).toBe(false)
    expect(((await rpc('projects.list', {})) as { id: string }[]).map((p) => p.id)).toEqual([info.id])
    expect(events.some((e) => e.type === 'projects_changed')).toBe(true)
  })

  it('registers an empty folder as trusted, so its first session reads the project settings (#655)', async () => {
    const info = (await rpc('projects.create', { name: 'game' })) as { id: string; path: string; trusted: boolean }
    expect(info.trusted).toBe(true)
    expect(store.projectRoots().find((p) => p.id === info.id)?.trusted).toBe(true)
    const s = (await rpc('agents.createSession', { projectId: info.id, cwd: info.path, tool: 'claude' })) as { id: string }
    // `projectTrusted: true` is what makes the Claude adapter leave `settingSources` unset (project and local files read)
    expect(claude.handles.get(s.id)?.opts.projectTrusted).toBe(true)
  })

  it('registering a folder already in the list leaves its trust as it was (#655)', async () => {
    const dir = join(root, 'existing')
    mkdirSync(dir)
    const added = (await rpc('projects.add', { path: dir })) as { id: string; trusted: boolean }
    expect(added.trusted).toBe(false)
    await rpc('projects.setTrusted', { projectId: added.id, trusted: true })
    expect(((await rpc('projects.add', { path: dir })) as { trusted: boolean }).trusted).toBe(true)
    await rpc('projects.setTrusted', { projectId: added.id, trusted: false })
    expect(((await rpc('projects.add', { path: dir })) as { trusted: boolean }).trusted).toBe(false)
  })

  it('makes it in a parent given as a full path, which has to be a folder already', async () => {
    const parent = join(root, 'code')
    mkdirSync(parent)
    const info = (await rpc('projects.create', { name: 'site', parent })) as { path: string }
    expect(info.path).toBe(join(parent, 'site'))
    expect(existsSync(info.path)).toBe(true)

    await expect(rpc('projects.create', { name: 'x', parent: join(root, 'nowhere') })).rejects.toThrow(/no folder at/i)
    expect(existsSync(join(root, 'nowhere'))).toBe(false)
    await expect(rpc('projects.create', { name: 'x', parent: 'code' })).rejects.toThrow(/full path/)
  })

  it('never reuses what is there: a folder, a file or a broken link of that name is refused, and left as it was', async () => {
    mkdirSync(centralu)
    mkdirSync(join(centralu, 'taken'))
    writeFileSync(join(centralu, 'taken', 'keep.txt'), 'mine')
    writeFileSync(join(centralu, 'notes'), 'a file')
    symlinkSync(join(root, 'gone'), join(centralu, 'dangling'))
    await expect(rpc('projects.create', { name: 'taken' })).rejects.toThrow(/already in/)
    await expect(rpc('projects.create', { name: 'notes' })).rejects.toThrow(/already in/)
    await expect(rpc('projects.create', { name: 'dangling' })).rejects.toThrow(/already in/)
    expect(existsSync(join(root, 'gone'))).toBe(false)
    expect(readdirSync(join(centralu, 'taken'))).toEqual(['keep.txt'])
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
  })

  it('refuses a name that is not one folder name', async () => {
    for (const name of ['', '..', 'a/b', '../up', 'nul', 'CON.txt']) {
      await expect(rpc('projects.create', { name }), name).rejects.toThrow()
    }
    expect(existsSync(centralu)).toBe(false)
  })

  it('is refused without a parent on a host that was given no default location — a test never writes in a real home', async () => {
    const bare = new SessionManager(store, new Map(), () => {})
    await expect(bare.createProject('x')).rejects.toThrow(/no default location/)
    await bare.disposeAll()
  })

  it('previews where the folder would go, and why it would be refused, without making anything', async () => {
    expect(await rpc('projects.createPreview', { name: '' })).toEqual({ parent: centralu, path: null, error: null })
    expect(await rpc('projects.createPreview', { name: 'game' })).toEqual({ parent: centralu, path: join(centralu, 'game'), error: null })
    expect(((await rpc('projects.createPreview', { name: 'a/b' })) as { error: string }).error).toMatch(/one folder/)
    expect(existsSync(centralu)).toBe(false)
  })
})

describe('create_project (the orchestrator)', () => {
  it.each(['auto', 'safe', 'normal'] as const)('%s: create_project follows the caller preset on every call', async (preset) => {
    const orc = await mgr.orchestrator()
    await mgr.updateSettings(orc.id, { permissionPreset: preset })
    for (const name of ['first', 'second']) {
      const call = mgr.runOrchestratorTool(orc.id, 'create_project', { name })
      if (preset !== 'auto') {
        await until(() => !!card(orc.id))
        expect(existsSync(join(centralu, name))).toBe(false)
        mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'deny')
      }
      const result = await call
      expect(result.isError === true).toBe(preset !== 'auto')
      expect(existsSync(join(centralu, name))).toBe(preset === 'auto')
      expect(card(orc.id)).toBeUndefined()
    }
  })

  it('raises a card with the full path, makes nothing until the person approves, then makes and registers it', async () => {
    const orc = await mgr.orchestrator()
    const call = mgr.runOrchestratorTool(orc.id, 'create_project', { name: 'shop' })
    await until(() => !!card(orc.id))
    expect(card(orc.id)!.detail).toEqual({ kind: 'project_create', name: 'shop', path: join(centralu, 'shop') })
    expect(mgr.listSessions().find((s) => s.id === orc.id)?.state).toBe('waiting_approval')
    // Nothing exists while the card stands
    expect(existsSync(join(centralu, 'shop'))).toBe(false)
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])

    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    const r = await call
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(JSON.stringify(join(centralu, 'shop')))
    expect(existsSync(join(centralu, 'shop'))).toBe(true)
    const listed = (await rpc('projects.list', {})) as { id: string; path: string }[]
    expect(listed.map((p) => p.path)).toEqual([join(centralu, 'shop')])
    expect(r.text).toContain(`[${listed[0]!.id}]`)
    expect(events.some((e) => e.type === 'projects_changed')).toBe(true)
  })

  it('makes nothing when the person denies it', async () => {
    const orc = await mgr.orchestrator()
    const call = mgr.runOrchestratorTool(orc.id, 'create_project', { name: 'shop' })
    await until(() => !!card(orc.id))
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'deny')
    const r = await call
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/did not approve/)
    expect(existsSync(join(centralu, 'shop'))).toBe(false)
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
  })

  it('refuses a taken name before any card, and a name taken while the card stood, after it', async () => {
    mkdirSync(join(centralu, 'old'), { recursive: true })
    const orc = await mgr.orchestrator()
    const early = await mgr.runOrchestratorTool(orc.id, 'create_project', { name: 'old' })
    expect(early.isError).toBe(true)
    expect(early.text).toMatch(/already in/)
    expect(card(orc.id)).toBeUndefined()

    const call = mgr.runOrchestratorTool(orc.id, 'create_project', { name: 'late' })
    await until(() => !!card(orc.id))
    mkdirSync(join(centralu, 'late'))
    writeFileSync(join(centralu, 'late', 'keep.txt'), 'mine')
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'allow')
    const r = await call
    expect(r.isError).toBe(true)
    expect(readdirSync(join(centralu, 'late'))).toEqual(['keep.txt'])
    expect((await rpc('projects.list', {})) as unknown[]).toEqual([])
  })

  it('withdraws the card when the call is stopped, and makes nothing', async () => {
    const orc = await mgr.orchestrator()
    const stop = new AbortController()
    const tools = (mgr as unknown as { orchestratorToolsFor(id: string): { createProject: (s: { name: string }, signal?: AbortSignal) => Promise<{ ok: boolean }> } }).orchestratorToolsFor(orc.id)
    const call = tools.createProject({ name: 'shop' }, stop.signal)
    await until(() => !!card(orc.id))
    stop.abort()
    expect((await call).ok).toBe(false)
    expect(card(orc.id)).toBeUndefined()
    expect(existsSync(join(centralu, 'shop'))).toBe(false)
  })

  it('"always" on the card makes this one folder and remembers nothing', async () => {
    const orc = await mgr.orchestrator()
    const call = mgr.runOrchestratorTool(orc.id, 'create_project', { name: 'one' })
    await until(() => !!card(orc.id))
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'always')
    expect((await call).isError).toBeFalsy()
    const second = mgr.runOrchestratorTool(orc.id, 'create_project', { name: 'two' })
    // Asked again: nothing was remembered
    await until(() => !!card(orc.id))
    mgr.respondApproval(orc.id, card(orc.id)!.requestId, 'deny')
    expect((await second).isError).toBe(true)
    expect(existsSync(join(centralu, 'two'))).toBe(false)
  })
})
