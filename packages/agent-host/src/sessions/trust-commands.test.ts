import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORCHESTRATOR_CHANGE, type ProjectInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { MANIFEST_VERSION } from '../apps/external/manifest.js'
import { ExternalApps, MANIFEST_FILE } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { CrossAdapter } from './cross-project.test-helpers.js'
import { commandsFor, profileAllows, RARE_TIERS } from './orchestrator-tools.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The orchestrator's trust commands (#1219, third slice). Each makes the window's own call through the real RPC handler
 * on a real store, so the host checks it as it checks the window. Widening trust waits for the person's card, which
 * names exactly what changes and is checked again after Allow; narrowing acts at once.
 */
const COMMANDS = ['list_projects', 'set_project_trust'] as const
type Command = (typeof COMMANDS)[number]

let root: string
let store: Store
let mgr: SessionManager
let rt: ExternalApps
let rpc: (method: string, params: unknown) => Promise<unknown>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-trust-')))
  mkdirSync(join(root, 'data'))
  store = new Store()
  rt = new ExternalApps({ projects: () => store.projects.projectRoots(), dataRoot: join(root, 'data'), reservedIds: ['control'] })
  const agents = new Map<ToolName, CrossAdapter>([['claude', new CrossAdapter('claude')]]) as unknown as Map<ToolName, AgentAdapter>
  mgr = new SessionManager(store, agents, () => {})
  mgr.useExternalApps(rt)
  const handler = createRpcHandler(mgr, agents, { externalApps: rt })
  rpc = (method, params) => handler(method, params)
  mgr.useWindowRpc(rpc)
  rt.refresh()
})
afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function manifest(dir: string, id: string, over: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, MANIFEST_FILE),
    JSON.stringify({ manifestVersion: MANIFEST_VERSION, id, name: `App ${id}`, version: '1.0.0', description: `What ${id} does`, server: { command: 'node', args: ['s.mjs'] }, ...over }),
  )
}

/** A project registered as the window registers one (untrusted), optionally an app itself */
async function project(name: string, opts: { app?: Record<string, unknown> } = {}): Promise<ProjectInfo> {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (opts.app) manifest(dir, name.toLowerCase(), opts.app)
  const p = (await rpc('projects.add', { path: dir })) as ProjectInfo
  rt.refresh()
  return p
}
const projects = async () => (await rpc('projects.list', {})) as ProjectInfo[]
const trusted = async (id: string) => (await projects()).find((p) => p.id === id)?.trusted

/** The trust card standing in a session, if one is */
function card(sessionId: string) {
  const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
  const d = pending?.detail
  return d?.kind === 'other' && d.about === ORCHESTRATOR_CHANGE ? { requestId: pending!.requestId, text: d.raw } : undefined
}

function run(orcId: string, command: Command, args: Record<string, unknown> = {}) {
  return mgr.runOrchestratorTool(orcId, 'centralu_run', { command, args })
}

/** Runs a command whose card the person answers; the card's question and the answer */
async function answered(orcId: string, command: Command, args: Record<string, unknown>, decision: 'allow' | 'deny', whileStanding?: () => Promise<void>) {
  const call = run(orcId, command, args)
  await eventually(() => !!card(orcId))
  const question = card(orcId)!.text
  await whileStanding?.()
  mgr.respondApproval(orcId, card(orcId)!.requestId, decision)
  return { question, r: await call }
}

describe('list_projects', () => {
  it('lists each project with its id, folder and trust, and says when there is none', async () => {
    const orc = await mgr.orchestrator()
    expect((await run(orc.id, 'list_projects')).text).toBe('No project is registered. add_project and create_project make one.')
    const a = await project('Alpha')
    const b = await project('Beta')
    await rpc('projects.setTrusted', { projectId: b.id, trusted: true })
    const r = await run(orc.id, 'list_projects')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('2 projects (set_project_trust changes trust):')
    expect(r.text).toContain(`- "Alpha" [${a.id}]: "${a.path.replace(/\\/g, '\\\\')}"; untrusted`)
    expect(r.text).toContain(`- "Beta" [${b.id}]: "${b.path.replace(/\\/g, '\\\\')}"; trusted`)
  })
})

describe('set_project_trust', () => {
  it("asks before trusting, naming the folder and each app with what it may ask for, and trusts it once allowed", async () => {
    const p = await project('Notes', { app: { uses: { agent: true, host: ['sessions.list'] } } })
    manifest(join(p.path, '.centralu', 'apps', 'helper'), 'helper')
    rt.refresh()
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'set_project_trust', { project: 'notes', trusted: true }, 'allow')
    expect(question).toContain(`Trust the project "Notes" at "${p.path.replace(/\\/g, '\\\\')}"?`)
    expect(question).toContain("Trusting lets this project's apps run and its settings apply")
    expect(question).toContain('Its 2 apps:')
    expect(question).toContain('- "App notes" [notes]: What notes does')
    expect(question).toContain('This project is this app: the orchestrator and your other projects can use it.')
    expect(question).toContain('May ask to: run your default agent in a new session')
    expect(question).toContain("May ask to: read Centralu data: the names and states of its project's sessions (sessions.list)")
    expect(question).toContain('- "App helper" [helper]: What helper does')
    expect(question).toContain('Asks for nothing beyond its own tools.')
    expect(r.isError).toBeFalsy()
    expect(r.text).toBe(`"Notes" [${p.id}] is trusted now: its apps may run and its settings apply.`)
    expect(await trusted(p.id)).toBe(true)
  })

  it('trusts nothing when the person denies it', async () => {
    const p = await project('Denied')
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'deny')
    expect(question).toContain('It has no app.')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('The person did not approve it, so nothing was trusted.')
    expect(await trusted(p.id)).toBe(false)
  })

  it('takes trust away at once, with no card, and says what that does', async () => {
    const p = await project('Gamma')
    await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_project_trust', { project: 'Gamma', trusted: false })
    expect(card(orc.id)).toBeUndefined()
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(`"Gamma" [${p.id}] is untrusted now: its apps stop`)
    expect(await trusted(p.id)).toBe(false)
  })

  it('says nothing changed when the project already is as asked, with no card', async () => {
    const p = await project('Same')
    const orc = await mgr.orchestrator()
    expect((await run(orc.id, 'set_project_trust', { project: 'Same', trusted: false })).text).toBe(`"Same" [${p.id}] is already untrusted; nothing changed.`)
    expect(card(orc.id)).toBeUndefined()
  })

  it('refuses an unknown name, and one two projects share (naming their ids), before any card', async () => {
    const one = await project('Twin')
    mkdirSync(join(root, 'other', 'Twin'), { recursive: true })
    const two = (await rpc('projects.add', { path: join(root, 'other', 'Twin') })) as ProjectInfo
    const orc = await mgr.orchestrator()
    const unknown = await run(orc.id, 'set_project_trust', { project: 'Nobody', trusted: true })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toBe('Nothing changed: No project is called "Nobody"; list_projects names them.')
    const both = await run(orc.id, 'set_project_trust', { project: 'twin', trusted: true })
    expect(both.isError).toBe(true)
    expect(both.text).toContain(`2 projects are called "twin": `)
    expect(both.text).toContain(one.id)
    expect(both.text).toContain(two.id)
    expect(card(orc.id)).toBeUndefined()
    expect(await trusted(one.id)).toBe(false)
  })

  it('refuses arguments the window would not take, by name', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_project_trust', { project: 'x', trusted: 'yes' })
    expect(r.isError).toBe(true)
    const extra = await run(orc.id, 'set_project_trust', { project: 'x', trusted: true, shared: true })
    expect(extra.isError).toBe(true)
  })

  describe('checked again after Allow', () => {
    it('trusts nothing when the project was removed while the card stood', async () => {
      const p = await project('Gone')
      const orc = await mgr.orchestrator()
      const { r } = await answered(orc.id, 'set_project_trust', { project: 'Gone', trusted: true }, 'allow', async () => {
        await rpc('projects.delete', { projectId: p.id })
      })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('was removed while the card stood, so nothing was trusted.')
      expect((await projects()).find((x) => x.id === p.id)).toBeUndefined()
    })

    it('trusts nothing when the project gained an app while the card stood: it is not what the card named', async () => {
      const p = await project('Grows')
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, 'set_project_trust', { project: 'Grows', trusted: true }, 'allow', async () => {
        manifest(join(p.path, '.centralu', 'apps', 'pulled'), 'pulled', { uses: { agent: true } })
        rt.refresh()
      })
      expect(question).toContain('It has no app.')
      expect(r.isError).toBe(true)
      expect(r.text).toContain('changed while the card stood, so it is not what the card named and nothing was trusted.')
      expect(await trusted(p.id)).toBe(false)
    })

    it('trusts nothing when what an app may ask for changed while the card stood', async () => {
      const p = await project('Asks', { app: { uses: {} } })
      const orc = await mgr.orchestrator()
      const { r } = await answered(orc.id, 'set_project_trust', { project: 'Asks', trusted: true }, 'allow', async () => {
        manifest(p.path, 'asks', { uses: { agent: true } })
        rt.refresh()
      })
      expect(r.isError).toBe(true)
      expect(await trusted(p.id)).toBe(false)
    })

    it('says so when the person trusted it in the window while the card stood', async () => {
      const p = await project('Raced')
      const orc = await mgr.orchestrator()
      const { r } = await answered(orc.id, 'set_project_trust', { project: 'Raced', trusted: true }, 'allow', async () => {
        await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
      })
      expect(r.isError).toBeFalsy()
      expect(r.text).toContain('was trusted while the card stood; nothing more changed.')
    })
  })
})

describe('who may run them', () => {
  it('are found through centralu_commands', async () => {
    const orc = await mgr.orchestrator()
    const found = (await mgr.runOrchestratorTool(orc.id, 'centralu_commands', { query: 'trust' })).text
    for (const name of COMMANDS) expect(found, name).toContain(`- ${name}:`)
  })

  it('only the orchestrator, as rare commands in the default tier; no other seat in any tier', () => {
    for (const name of COMMANDS) {
      expect(commandsFor('orchestrator', 'commands')).toContain(name)
      for (const tier of RARE_TIERS) {
        for (const profile of ['scoped', 'builder', 'reader'] as const) {
          expect(profileAllows(profile, name, tier), `${profile} ${tier} ${name}`).toBe(false)
        }
      }
    }
  })

  it("refuses an ordinary session's calls by name and through centralu_run, and trusts nothing", async () => {
    const p = await project('Safe')
    await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    const caller = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const target = await project('Target')
    for (const name of COMMANDS) {
      const args = { project: target.id, trusted: true }
      await expect(mgr.runOrchestratorTool(caller.id, name, args), name).rejects.toThrow(`Not a tool of this session: ${name}`)
      await expect(mgr.runOrchestratorTool(caller.id, 'centralu_run', { command: name, args }), name).rejects.toThrow(/Not a tool of this session/)
    }
    expect(await trusted(target.id)).toBe(false)
  })
})
