import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORCHESTRATOR_CHANGE, type ProjectInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { MANIFEST_VERSION } from '../apps/external/manifest.js'
import { ExternalApps, MANIFEST_FILE } from '../apps/external/runtime.js'
import { storePermissionBook } from '../app-permission-book.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { readShared } from './app-access.js'
import { SessionManager } from './manager.js'
import { commandRig, expectOnlyOrchestratorRuns } from './orchestrator-commands.test-helpers.js'
import { CrossAdapter } from './cross-project.test-helpers.js'
import { commandsFor, ORCHESTRATOR_INSTRUCTIONS } from './orchestrator-tools.js'

/**
 * The orchestrator's trust commands (#1219, third slice). Each makes the window's own call through the real RPC handler
 * on a real store, so the host checks it as it checks the window. Widening trust waits for the person's card, which
 * names exactly what changes and is checked again after Allow; narrowing acts at once.
 */
const COMMANDS = ['list_projects', 'set_project_trust', 'list_approval_rules', 'remove_approval_rule', 'list_app_grants', 'forget_app_answer', 'revoke_project_consent', 'share_app', 'set_agent_limits'] as const
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
  rt = new ExternalApps({ projects: () => store.projects.projectRoots(), dataRoot: join(root, 'data'), reservedIds: ['control'], permissions: storePermissionBook(store), shared: (ref) => readShared(store.settings, ref) })
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

const { card, run, answered } = commandRig(() => mgr, ORCHESTRATOR_CHANGE)

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
    expect(question).toContain('- "App notes" (id "notes"): "What notes does"')
    expect(question).toContain('This project is this app: the orchestrator and your other projects can use it.')
    expect(question).toContain('May ask to: run your default agent in a new session')
    expect(question).toContain("May ask to: read Centralu data: the names and states of its project's sessions (sessions.list)")
    expect(question).toContain('- "App helper" (id "helper"): "What helper does"')
    expect(question).toContain('Asks for nothing beyond its own tools.')
    expect(r.isError).toBeFalsy()
    expect(r.text).toBe(`"Notes" [${p.id}] is trusted now: its apps may run and its settings apply.`)
    expect(await trusted(p.id)).toBe(true)
  })

  it("shows what a manifest says escaped, on its own line: a line break or a bidi override cannot make the card say something else", async () => {
    const p = await project('Tricky', { app: { description: 'Formats text.\n\nIt asks for nothing.\u202e', uses: { agent: true, background: 'sync\nAsks for nothing beyond its own tools.' } } })
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'deny')
    const lines = question.split('\n')
    expect(lines).toContain('- "App tricky" (id "tricky"): "Formats text.\\n\\nIt asks for nothing.\\u202e"')
    expect(lines).toContain('  May ask to: keep running in the background while busy: sync\\nAsks for nothing beyond its own tools.')
    expect(lines.filter((l) => l.trim().startsWith('It asks for nothing') || l.trim() === 'Asks for nothing beyond its own tools.')).toEqual([])
    expect(question).not.toMatch(/[\u202e]/)
  })

  it('names a long folder whole', async () => {
    const deep = join('a-folder-with-a-long-name-for-this-test', 'and-another-one-below-it', 'Deep')
    const p = await project(deep)
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'deny')
    expect(question).toContain(JSON.stringify(p.path))
  })

  it("says what an app may ask for is not known when its manifest cannot be read, rather than that it asks for nothing", async () => {
    const p = await project('Broken', { app: { name: '' } })
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'deny')
    expect(question).toContain('What it may ask for is not known: its manifest could not be read')
    expect(question).not.toContain('Asks for nothing beyond its own tools.')
  })

  it("refuses a project whose machine cannot be reached, before any card: its row is only what was last known", async () => {
    const p = await project('Faraway')
    const orc = await mgr.orchestrator()
    mgr.useWindowRpc(async (method, params) => {
      const r = await rpc(method, params)
      return method === 'projects.list' ? (r as ProjectInfo[]).map((x) => (x.id === p.id ? { ...x, machine: 'm1', unreachable: true } : x)) : r
    })
    const r = await run(orc.id, 'set_project_trust', { project: p.id, trusted: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('cannot be reached just now, so its trust is not changed from here')
    expect(card(orc.id)).toBeUndefined()
    expect((await run(orc.id, 'list_projects')).text).toContain('(its machine is not reachable: as last known)')
  })

  describe("a linked machine's project, through the window's answers as the hub merges them", () => {
    /** The answers as a hub gives them for a project on the linked machine m1, changed by `tweak` (set while the card stands) */
    let tweak: { path?: string; unreachable?: boolean } = {}
    function onMachine(p: ProjectInfo, apps: (a: Record<string, unknown>) => Record<string, unknown> = (a) => a, status = 'connected') {
      tweak = {}
      mgr.useWindowRpc(async (method, params) => {
        if (method === 'machines.list') return [{ id: 'm1', name: 'Laptop', sshTarget: 'me@laptop', status }]
        const r = await rpc(method, params)
        if (method === 'projects.list') return (r as ProjectInfo[]).map((x) => (x.id === p.id ? { ...x, machine: 'm1', ...(tweak.path ? { path: tweak.path } : {}), ...(tweak.unreachable ? { unreachable: true } : {}) } : x))
        if (method === 'apps.list') return (r as Record<string, unknown>[]).map((a) => (a.projectId === p.id ? apps({ ...a, machine: 'm1' }) : a))
        return r
      })
    }

    it('says its apps are as that machine listed them, and what an app asks for is not known when the machine did not say', async () => {
      const p = await project('Remote', { app: { uses: { agent: true } } })
      manifest(join(p.path, '.centralu', 'apps', 'quiet'), 'quiet')
      rt.refresh()
      onMachine(p, (a) => (a.appId === 'remote' ? (({ uses: _u, ...rest }) => rest)(a) : a))
      const orc = await mgr.orchestrator()
      const { question } = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'deny')
      expect(question).toContain('on the linked machine "Laptop"')
      expect(question).toContain('Its 2 apps, as its machine listed them just now:')
      expect(question).toContain('What it may ask for is not known: its machine did not say (it runs an older Centralu).')
      // One the machine said asks for nothing (an empty declaration) is said so
      expect(question).toContain('Asks for nothing beyond its own tools.')
    })

    it('asks the machine for its apps alone, and says it has none only when the machine said so', async () => {
      const p = await project('Empty')
      onMachine(p)
      const orc = await mgr.orchestrator()
      const { question } = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'deny')
      expect(question).toContain('It has no app, as its machine listed them just now.')
    })

    it('refuses before any card when the machine could not list its apps: the card could not name what trusting covers', async () => {
      const p = await project('Silent', { app: { uses: { agent: true } } })
      onMachine(p)
      const inner = mgr as unknown as { trustFlow: { rpc: (m: string, q: unknown) => Promise<unknown> } }
      const routed = inner.trustFlow.rpc
      mgr.useWindowRpc(async (method, params) => {
        if (method === 'apps.list' && (params as { machine?: string }).machine === 'm1') throw new Error('the machine dropped the call')
        return routed(method, params)
      })
      const orc = await mgr.orchestrator()
      const r = await run(orc.id, 'set_project_trust', { project: p.id, trusted: true })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('could not be listed just now (its machine did not answer for them), so its trust is not changed from here')
      expect(card(orc.id)).toBeUndefined()
      expect(await trusted(p.id)).toBe(false)
    })

    it('trusts nothing when its folder changed, or its machine could not be reached, while the card stood', async () => {
      const p = await project('Moving')
      onMachine(p)
      const orc = await mgr.orchestrator()
      const moved = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'allow', async () => {
        tweak.path = join(root, 'elsewhere')
      })
      expect(moved.r.isError).toBe(true)
      expect(moved.r.text).toContain('is not in the folder the card named any more, so nothing was trusted.')
      onMachine(p)
      const away = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'allow', async () => {
        tweak.unreachable = true
      })
      expect(away.r.isError).toBe(true)
      expect(away.r.text).toContain('could not be reached after the card was answered, so nothing was trusted.')
      expect(await trusted(p.id)).toBe(false)
    })

    it('the lists say which machines are not connected, so they do not read as complete', async () => {
      const p = await project('Seen')
      onMachine(p, (a) => a, 'unreachable')
      const orc = await mgr.orchestrator()
      const rules = await run(orc.id, 'list_approval_rules')
      expect(rules.text).toContain('No approval rule was listed.')
      expect(rules.text).toContain('Not listed: the rules kept on "Laptop", which is not connected just now.')
      expect((await run(orc.id, 'list_app_grants')).text).toContain('Not listed: the apps and answers kept on "Laptop", which is not connected just now.')
      expect((await run(orc.id, 'list_projects')).text).toContain('Not listed: the projects on "Laptop", which is not connected just now.')
    })

    it('a list says when the linked machines could not be read at all, rather than reading as complete', async () => {
      mgr.useWindowRpc(async (method, params) => {
        if (method === 'machines.list') throw new Error('links are down')
        return rpc(method, params)
      })
      const orc = await mgr.orchestrator()
      expect((await run(orc.id, 'list_approval_rules')).text).toContain('The linked machines could not be read just now, so the rules kept on them may be missing.')
    })
  })

  it("the share card says when the app's project is untrusted: it attaches nowhere until then", async () => {
    const p = await project('Closed')
    manifest(join(p.path, '.centralu', 'apps', 'helper'), 'helper')
    rt.refresh()
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'share_app' as Command, { app: 'helper', shared: true }, 'deny')
    expect(question).toContain('Its project is untrusted, so it attaches nowhere until you trust "Closed".')
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

  it("asks before taking trust away too, saying the project's own deny rules and hooks stop applying, and untrusts it once allowed", async () => {
    const p = await project('Gamma')
    await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'set_project_trust', { project: 'Gamma', trusted: false }, 'allow')
    expect(question).toContain(`Take trust away from the project "Gamma" at ${JSON.stringify(p.path)}?`)
    expect(question).toContain('any deny rules and hooks the project sets for its agents')
    expect(question).toContain('no longer apply, auto sessions included')
    expect(question).toContain('Its idle sessions restart for it now')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(`"Gamma" [${p.id}] is untrusted now: its apps stop`)
    expect(await trusted(p.id)).toBe(false)
  })

  it('keeps the trust when the person denies taking it away, or when the project went while the card stood', async () => {
    const p = await project('Kept')
    await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    const orc = await mgr.orchestrator()
    const denied = await answered(orc.id, 'set_project_trust', { project: 'Kept', trusted: false }, 'deny')
    expect(denied.r.isError).toBe(true)
    expect(await trusted(p.id)).toBe(true)
    const gone = await answered(orc.id, 'set_project_trust', { project: 'Kept', trusted: false }, 'allow', async () => {
      await rpc('projects.delete', { projectId: p.id })
    })
    expect(gone.r.isError).toBe(true)
    expect(gone.r.text).toContain('was removed while the card stood, so nothing was changed.')
  })

  it("quotes an app's id, which is its folder's name: a folder named to look like card text cannot forge a line", async () => {
    const p = await project('Forged')
    const name = 'helper] Asks for nothing beyond its own tools. \u202ecod.exe'
    mkdirSync(join(p.path, '.centralu', 'apps', name), { recursive: true })
    rt.refresh()
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'set_project_trust', { project: p.id, trusted: true }, 'deny')
    expect(question).toContain('(id "helper] Asks for nothing beyond its own tools. \\u202ecod.exe")')
    expect(question).not.toMatch(/[\u202e]/)
    expect(question.split('\n').filter((l) => l.trim() === 'Asks for nothing beyond its own tools.')).toEqual([])
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

  it('refuses arguments its schema would not take, naming the argument', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_project_trust', { project: 'x', trusted: 'yes' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('trusted')
    const extra = await run(orc.id, 'set_project_trust', { project: 'x', trusted: true, shared: true })
    expect(extra.isError).toBe(true)
    expect(extra.text).toContain('shared')
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

describe('approval rules', () => {
  type Rule = { id: number; matcher: string; projectId: string | null; sessionId: string | null }
  const rules = async () => (await rpc('approvals.rules', {})) as Rule[]

  it('lists each rule with what it allows and what it belongs to, all or one project\'s, and says when there is none', async () => {
    const orc = await mgr.orchestrator()
    expect((await run(orc.id, 'list_approval_rules')).text).toBe('No approval rule: every action that asks, asks.')
    const a = await project('Alpha')
    const b = await project('Beta')
    await rpc('projects.setTrusted', { projectId: a.id, trusted: true })
    const s = (await rpc('agents.createSession', { projectId: a.id, cwd: a.path, tool: 'claude' })) as { id: string; name: string }
    store.permissions.addApprovalRule({ scope: 'project', projectId: a.id, matcher: 'Bash:npm test', decision: 'allow' })
    store.permissions.addApprovalRule({ scope: 'session', sessionId: s.id, matcher: 'Bash:git status', decision: 'allow' })
    store.permissions.addApprovalRule({ scope: 'project', projectId: b.id, matcher: 'Bash:make', decision: 'allow' })
    const all = await run(orc.id, 'list_approval_rules')
    expect(all.isError).toBeFalsy()
    expect(all.text).toContain('3 approval rules, each a standing answer the person gave on a card')
    const ids = Object.fromEntries((await rules()).map((r) => [r.matcher, r.id]))
    expect(all.text).toContain(`- [${ids['Bash:npm test']}] allow "Bash:npm test" for the project "Alpha" [${a.id}], since `)
    expect(all.text).toContain(`- [${ids['Bash:git status']}] allow "Bash:git status" for the session "${s.name}" [${s.id}], since `)
    const onlyB = await run(orc.id, 'list_approval_rules', { project: 'Beta' })
    expect(onlyB.text).toContain('1 approval rule of "Beta"')
    expect(onlyB.text).toContain('"Bash:make"')
    expect(onlyB.text).not.toContain('npm test')
    expect((await run(orc.id, 'list_approval_rules', { project: 'Nobody' })).isError).toBe(true)
  })

  it('removes a rule at once, with no card, through the window\'s call, naming what it was', async () => {
    const a = await project('Alpha')
    store.permissions.addApprovalRule({ scope: 'project', projectId: a.id, matcher: 'Bash:npm test', decision: 'allow' })
    store.permissions.addApprovalRule({ scope: 'project', projectId: a.id, matcher: 'Bash:npm run lint', decision: 'allow' })
    const [one] = (await rules()).filter((r) => r.matcher === 'Bash:npm test')
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'remove_approval_rule', { id: one!.id })
    expect(card(orc.id)).toBeUndefined()
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(`Removed the approval rule [${one!.id}] allow "Bash:npm test" for the project "Alpha"`)
    expect(r.text).toContain('That action asks again from now on')
    expect((await rules()).map((x) => x.matcher)).toEqual(['Bash:npm run lint'])
  })

  it('refuses an id no rule has, removing nothing', async () => {
    const a = await project('Alpha')
    store.permissions.addApprovalRule({ scope: 'project', projectId: a.id, matcher: 'Bash:npm test', decision: 'allow' })
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'remove_approval_rule', { id: 987654 })
    expect(r.isError).toBe(true)
    expect(r.text).toBe('Nothing changed: No approval rule has the id 987654; list_approval_rules shows them.')
    expect(await rules()).toHaveLength(1)
  })

  it('has no command that adds or widens a rule', () => {
    expect(commandsFor('orchestrator', 'commands').filter((n) => /rule/.test(n))).toEqual(['list_approval_rules', 'remove_approval_rule'])
  })
})

describe('app grants', () => {
  const answer = (decision: 'allow' | 'deny', capability = 'agent:claude') => ({ capability, text: `may ${capability}`, decision, stamp: 's', decidedAt: Date.UTC(2026, 9, 1) })
  type App = { appId: string; projectId: string | null; shared?: boolean }
  const app = async (appId: string) => ((await rpc('apps.list', {})) as App[]).find((a) => a.appId === appId)!
  /** A trusted project with an inner app (`.centralu/apps/<id>`), which is what can be shared */
  async function inner(projectName: string, appId: string, over: Record<string, unknown> = {}): Promise<ProjectInfo> {
    const p = await project(projectName)
    manifest(join(p.path, '.centralu', 'apps', appId), appId, over)
    await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    rt.refresh()
    return p
  }

  it('lists each app with its trust, sharing and the remembered answers, and the consents between projects', async () => {
    const a = await inner('Alpha', 'helper')
    const b = await project('Beta', { app: {} })
    store.permissions.putAppPermission(`${a.id}/helper`, a.id, answer('allow'))
    store.permissions.putAppPermission(`${a.id}/helper`, a.id, answer('deny', 'app:other'))
    store.permissions.setProjectConsent(b.id, a.id, 'apps')
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'list_app_grants')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(`- "App helper" (id "helper") of the project "Alpha": trusted; not shared`)
    expect(r.text).toContain('  Allowed: "agent:claude" ("may agent:claude"), since 2026-10-01')
    expect(r.text).toContain('  Denied: "app:other" ("may app:other"), since 2026-10-01')
    expect(r.text).toContain(`- "App beta" (id "beta") of the project "Beta": untrusted; reached through its project's trust`)
    expect(r.text).toContain('1 remembered consent of one project reaching another')
    expect(r.text).toContain(`- "Beta" [${b.id}] may attach the apps of "Alpha" [${a.id}], since `)
    const one = await run(orc.id, 'list_app_grants', { app: 'helper' })
    expect(one.text).toContain('1 app,')
    expect(one.text).not.toContain('Beta')
  })

  it('forgets one remembered answer at once, with no card, so it asks again', async () => {
    const a = await inner('Alpha', 'helper')
    store.permissions.putAppPermission(`${a.id}/helper`, a.id, answer('allow'))
    store.permissions.putAppPermission(`${a.id}/helper`, a.id, answer('allow', 'app:other'))
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'forget_app_answer', { app: 'App helper', capability: 'agent:claude' })
    expect(card(orc.id)).toBeUndefined()
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('Forgot the answer allowing "agent:claude" for "App helper" (id "helper") of the project "Alpha"')
    expect(store.permissions.listAppPermissions(`${a.id}/helper`).map((x) => x.capability)).toEqual(['app:other'])
    const none = await run(orc.id, 'forget_app_answer', { app: 'helper', capability: 'agent:claude' })
    expect(none.isError).toBe(true)
    expect(none.text).toContain('has no remembered answer for "agent:claude"')
  })

  it('revokes a remembered consent at once, with no card', async () => {
    const a = await project('Alpha')
    const b = await project('Beta')
    store.permissions.setProjectConsent(b.id, a.id, 'delegate')
    store.permissions.setProjectConsent(b.id, a.id, 'apps')
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'revoke_project_consent', { from: 'Beta', to: a.id, kind: 'delegate' })
    expect(card(orc.id)).toBeUndefined()
    expect(r.isError).toBeFalsy()
    expect(r.text).toBe('Revoked: "Beta" may no longer start sessions in "Alpha" unasked; the next time it does, the person is asked again.')
    expect(store.permissions.listProjectConsents().map((c) => c.kind)).toEqual(['apps'])
    const none = await run(orc.id, 'revoke_project_consent', { from: 'Beta', to: 'Alpha', kind: 'agents' })
    expect(none.isError).toBe(true)
  })

  it('asks before sharing a project app, naming what it may ask for, and shares it once allowed; stops sharing at once', async () => {
    await inner('Alpha', 'helper', { uses: { agent: true } })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'share_app', { app: 'helper', shared: true }, 'allow')
    expect(question).toContain('Share the app "App helper" (id "helper") of the project "Alpha" with your other projects?')
    expect(question).toContain('after you allow that pair of projects once')
    expect(question).toContain('It may ask to: run your default agent in a new session')
    expect(r.isError).toBeFalsy()
    expect((await app('helper')).shared).toBe(true)
    const off = await run(orc.id, 'share_app', { app: 'helper', shared: false })
    expect(card(orc.id)).toBeUndefined()
    expect(off.text).toContain('is not shared any more')
    expect((await app('helper')).shared).toBeFalsy()
  })

  it('shares nothing when the person denies it', async () => {
    await inner('Alpha', 'helper')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'share_app', { app: 'helper', shared: true }, 'deny')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('nothing was shared')
    expect((await app('helper')).shared).toBeFalsy()
  })

  it('refuses a root app, which follows its project\'s trust, before any card', async () => {
    await project('Rooted', { app: {} })
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'share_app', { app: 'rooted', shared: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("is its project's root app: it is reached through its project's trust")
    expect(card(orc.id)).toBeUndefined()
  })

  it('shares nothing when what the app may ask for changed while the card stood', async () => {
    const p = await inner('Alpha', 'helper')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'share_app', { app: 'helper', shared: true }, 'allow', async () => {
      manifest(join(p.path, '.centralu', 'apps', 'helper'), 'helper', { uses: { agent: true } })
      rt.refresh()
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('changed while the card stood, so it is not what the card named and nothing was shared.')
    expect((await app('helper')).shared).toBeFalsy()
  })

  it('shares nothing when the app was removed while the card stood', async () => {
    const p = await inner('Alpha', 'helper')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'share_app', { app: 'helper', shared: true }, 'allow', async () => {
      rmSync(join(p.path, '.centralu', 'apps', 'helper'), { recursive: true, force: true })
      rt.refresh()
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('was removed while the card stood, so nothing was shared.')
  })
})

describe('set_agent_limits', () => {
  type Prefs = { agentCeiling?: number | null; agentDepth?: number }
  const prefs = async () => (await rpc('prefs.get', {})) as Prefs

  it('asks before any change, naming each limit as it is and as it becomes, and changes them once allowed', async () => {
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'set_agent_limits', { agentCeiling: 8, agentDepth: 2 }, 'allow')
    expect(question).toContain('Change the limits on what agents may do?')
    expect(question).toContain('- Running agents per project: by preset (auto unlimited, otherwise 4) → 8.')
    expect(question).toContain('- Levels of sessions that may start agents: 1 → 2.')
    expect(question).not.toContain('look at other sessions')
    expect(question).not.toContain('read-only tools')
    expect(r.isError).toBeFalsy()
    expect(r.text).toBe('Changed: Running agents per project 8; Levels of sessions that may start agents 2. A session reads them when it starts or calls a tool.')
    expect(await prefs()).toMatchObject({ agentCeiling: 8, agentDepth: 2 })
  })

  it('asks for a change that narrows too, and changes nothing when the person denies it', async () => {
    await rpc('prefs.set', { patch: { agentDepth: 2 } })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'set_agent_limits', { agentDepth: 1 }, 'deny')
    expect(question).toContain('- Levels of sessions that may start agents: 2 → 1.')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('The person did not approve it, so nothing was changed.')
    expect((await prefs()).agentDepth).toBe(2)
  })

  it('has no field for "let sessions look at other sessions", which is not a setting any more (2026-10-20): refused by name', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_agent_limits', { sessionTools: false })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('sessionTools')
    expect(card(orc.id)).toBeUndefined()
    expect(((await rpc('prefs.get', {})) as { sessionTools: boolean }).sessionTools).toBe(true)
  })

  it('puts the ceiling back to the preset\'s own with "preset"', async () => {
    await rpc('prefs.set', { patch: { agentCeiling: 0 } })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'set_agent_limits', { agentCeiling: 'preset' }, 'allow')
    expect(question).toContain('- Running agents per project: unlimited → by preset (auto unlimited, otherwise 4).')
    expect(r.isError).toBeFalsy()
    expect((await prefs()).agentCeiling ?? null).toBeNull()
  })

  it('asks nothing when the limits already are as asked', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_agent_limits', { agentCeiling: 'preset', agentDepth: 1 })
    expect(card(orc.id)).toBeUndefined()
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('The limits already are as asked')
  })

  it('refuses a value the window would not take, before any card', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_agent_limits', { agentDepth: 4 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('agentDepth')
    expect(card(orc.id)).toBeUndefined()
    expect((await run(orc.id, 'set_agent_limits', {})).isError).toBe(true)
    expect((await prefs()).agentDepth ?? 1).toBe(1)
  })

  it('changes nothing when the person changed a limit in Settings while the card stood', async () => {
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'set_agent_limits', { agentDepth: 3 }, 'allow', async () => {
      await rpc('prefs.set', { patch: { agentDepth: 2 } })
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Levels of sessions that may start agents changed while the card stood')
    expect((await prefs()).agentDepth).toBe(2)
  })

  it('is the one way: set_preferences still has no field for them, and get_preferences names this command', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'centralu_run', { command: 'set_preferences', args: { agentDepth: 3 } })
    expect(r.isError).toBe(true)
    expect((await prefs()).agentDepth ?? 1).toBe(1)
    expect((await mgr.runOrchestratorTool(orc.id, 'centralu_run', { command: 'get_preferences', args: {} })).text).toContain('set_agent_limits changes them')
  })
})

describe('who may run them', () => {
  it('are found through centralu_commands with the words the instructions give', async () => {
    const orc = await mgr.orchestrator()
    const query = /centralu_commands "([^"]+)"/.exec(ORCHESTRATOR_INSTRUCTIONS.split('\n').find((l) => l.startsWith('More commands'))!)![1]
    const found = (await mgr.runOrchestratorTool(orc.id, 'centralu_commands', { query })).text
    for (const name of COMMANDS) expect(found, name).toContain(`- ${name}:`)
    // The machine commands are found by the same words
    expect(found).toContain('- add_machine:')
  })

  it('only the orchestrator, as rare commands in the default tier; no other seat in any tier', () => {
    expectOnlyOrchestratorRuns(COMMANDS)
  })

  it("refuses an ordinary session's calls by name and through centralu_run, and trusts nothing", async () => {
    const p = await project('Safe')
    await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    const caller = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const target = await project('Target')
    store.permissions.addApprovalRule({ scope: 'project', projectId: target.id, matcher: 'Bash:npm test', decision: 'allow' })
    const ruleId = ((await rpc('approvals.rules', {})) as { id: number }[])[0]!.id
    for (const name of COMMANDS) {
      const args = name.includes('rule')
        ? { id: ruleId }
        : name === 'share_app'
          ? { app: 'x', shared: true }
          : name === 'forget_app_answer'
            ? { app: 'x', capability: 'agent:claude' }
            : name === 'set_agent_limits'
              ? { agentDepth: 3 }
              : name === 'revoke_project_consent'
              ? { from: target.id, to: p.id, kind: 'apps' }
              : { project: target.id, trusted: true }
      await expect(mgr.runOrchestratorTool(caller.id, name, args), name).rejects.toThrow(`Not a tool of this session: ${name}`)
      await expect(mgr.runOrchestratorTool(caller.id, 'centralu_run', { command: name, args }), name).rejects.toThrow(/Not a tool of this session/)
    }
    expect(await trusted(target.id)).toBe(false)
    expect((await rpc('approvals.rules', {})) as unknown[]).toHaveLength(1)
    expect(((await rpc('prefs.get', {})) as { agentDepth?: number }).agentDepth ?? 1).toBe(1)
    // What the ordinary session was refused, the orchestrator does (listing asks nothing)
    const orc = await mgr.orchestrator()
    const listed = await run(orc.id, 'list_projects')
    expect(listed.isError).toBeFalsy()
    expect(listed.text).toContain(`"Target" [${target.id}]`)
  })
})
