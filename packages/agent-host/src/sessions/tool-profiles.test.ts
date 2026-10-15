import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RESERVED_APP_IDS, type AdapterCapabilities, type ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { codeIntelligenceOff, isAppAgent, readsOwnProject, toolBundleFor, toolProfileFor, type CodeIntelligenceFacts, type ToolProfileFacts } from './tool-profiles.js'

/** An ordinary session in a project, with the reader set on; each case overrides what makes it different */
const facts = (over: Partial<ToolProfileFacts> = {}): ToolProfileFacts => ({
  kind: 'worker', projectId: 'p1', appId: null, builder: false, sessionTools: true, ...over,
})

describe('toolProfileFor — which bundle a session gets (#69, #320)', () => {
  it('the orchestrator gets everything, whatever else its row says', () => {
    expect(toolProfileFor(facts({ kind: 'orchestrator', projectId: null }))).toBe('orchestrator')
    // Its kind decides; an app stamp, a builder slot or the Settings switch change nothing
    expect(toolProfileFor(facts({ kind: 'orchestrator', projectId: null, appId: 'a', builder: true, sessionTools: false }))).toBe('orchestrator')
  })

  it('a coordinator an older build left (#372) still wakes with the scoped bundle', () => {
    expect(toolProfileFor(facts({ kind: 'coordinator' }))).toBe('scoped')
    expect(toolProfileFor(facts({ kind: 'coordinator', appId: 'control', builder: true, sessionTools: false }))).toBe('scoped')
  })

  it("a builder session gets its app's check, in a project or in the user folder, even with the reader set off (M4 C-3)", () => {
    expect(toolProfileFor(facts({ appId: 'app-notes', builder: true }))).toBe('builder')
    expect(toolProfileFor(facts({ projectId: null, appId: 'app-notes', builder: true }))).toBe('builder')
    expect(toolProfileFor(facts({ appId: 'app-notes', builder: true, sessionTools: false }))).toBe('builder')
  })

  it('an ordinary session in a project gets the reader set (#320), including a worktree or delegated one that carries no app', () => {
    expect(toolProfileFor(facts())).toBe('reader')
  })

  it('an ordinary session gets nothing once "Let sessions look at their own project" is off', () => {
    expect(toolProfileFor(facts({ sessionTools: false }))).toBeNull()
  })

  it('a worker outside any project gets nothing', () => {
    expect(toolProfileFor(facts({ projectId: null }))).toBeNull()
  })

  it("an app's agent (M4 D-1) gets nothing: its answer goes back to the app, so it may not read the project's conversations", () => {
    expect(toolProfileFor(facts({ appId: 'app-notes' }))).toBeNull()
    // The switch does not open it either
    expect(toolProfileFor(facts({ appId: 'app-notes', sessionTools: true }))).toBeNull()
  })

  it('a row stamped by the removed control app (#372) is an ordinary session, not an app agent', () => {
    for (const reserved of RESERVED_APP_IDS) expect(toolProfileFor(facts({ appId: reserved }))).toBe('reader')
  })

  it('reads nothing about the tool or the preset: the facts have no such field, so Claude and Codex under safe, normal or auto share one answer', () => {
    const keys = Object.keys(facts()).sort()
    expect(keys).toEqual(['appId', 'builder', 'kind', 'projectId', 'sessionTools'])
  })
})

describe('isAppAgent and readsOwnProject', () => {
  it('an app agent is a worker with an app stamp that is not the builder', () => {
    expect(isAppAgent({ kind: 'worker', appId: 'app-notes', builder: false })).toBe(true)
    expect(isAppAgent({ kind: 'worker', appId: 'app-notes', builder: true })).toBe(false)
    expect(isAppAgent({ kind: 'worker', appId: null, builder: false })).toBe(false)
    expect(isAppAgent({ kind: 'orchestrator', appId: 'app-notes', builder: false })).toBe(false)
    for (const reserved of RESERVED_APP_IDS) expect(isAppAgent({ kind: 'worker', appId: reserved, builder: false })).toBe(false)
  })

  it('reads its own project only as a worker, in a project, not for an app, with the switch on', () => {
    expect(readsOwnProject(facts())).toBe(true)
    expect(readsOwnProject(facts({ kind: 'orchestrator' }))).toBe(false)
    expect(readsOwnProject(facts({ projectId: null }))).toBe(false)
    expect(readsOwnProject(facts({ appId: 'app-notes' }))).toBe(false)
    expect(readsOwnProject(facts({ sessionTools: false }))).toBe(false)
    // The builder is an ordinary worker to this question; the profile rule ranks it first
    expect(readsOwnProject(facts({ appId: 'app-notes', builder: true }))).toBe(true)
  })
})

describe('toolBundleFor — the object behind each profile', () => {
  const calls: string[] = []
  const sources = {
    orchestrator: () => (calls.push('orchestrator'), 'full' as const),
    scoped: (ids: string[]) => (calls.push(`scoped:${ids.join(',')}`), 'members' as const),
    reader: () => (calls.push('reader'), 'own-project' as const),
  }

  it.each<[ToolProfile, string, string]>([
    ['orchestrator', 'full', 'orchestrator'],
    ['builder', 'full', 'orchestrator'],
    ['scoped', 'members', 'scoped:s1,s2'],
    ['reader', 'own-project', 'reader'],
  ])('%s takes %s', (profile, bundle, source) => {
    calls.length = 0
    expect(toolBundleFor(profile, ['s1', 's2'], sources)).toBe(bundle)
    expect(calls).toEqual([source])
  })

  it('a coordinator with no members recorded sees an empty scope, not everything', () => {
    calls.length = 0
    toolBundleFor('scoped', null, sources)
    expect(calls).toEqual(['scoped:'])
  })

  it('no profile means no bundle, and no source is built', () => {
    calls.length = 0
    expect(toolBundleFor(null, null, sources)).toBeUndefined()
    expect(toolBundleFor(undefined, ['s1'], sources)).toBeUndefined()
    expect(calls).toEqual([])
  })
})

/**
 * The manager hands the adapter the answer this module gives, whichever tool runs the session and whichever
 * preset it runs under. A fake adapter per tool records what it was handed.
 */
describe('through the manager: the same profile under either tool and any preset', () => {
  class Adapter implements AgentAdapter {
    readonly descriptor: AgentAdapter['descriptor']
    readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
    }
    handed: CreateSessionOpts[] = []
    constructor(readonly tool: ToolName) {
      this.descriptor = { name: tool, label: tool, mark: 'X', install: 'x', login: 'x' }
    }
    async detect() {
      return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
    }
    async createSession(opts: CreateSessionOpts, _emit: EventSink): Promise<SessionHandle> {
      this.handed.push(opts)
      return { externalId: null, send() {}, respondApproval: () => true, interrupt() {}, async dispose() {} } as unknown as SessionHandle
    }
  }
  const world = () => {
    const claude = new Adapter('claude')
    const codex = new Adapter('codex')
    const mgr = new SessionManager(new Store(), new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', codex]]), () => {})
    return { mgr, adapters: { claude, codex } }
  }

  it.each(['claude', 'codex'] as const)('%s: an ordinary session is a reader and an app agent gets nothing, under safe, normal and auto', async (tool) => {
    const { mgr, adapters } = world()
    const project = await mgr.addProject(tmpdir())
    for (const permissionPreset of ['safe', 'normal', 'auto'] as const) {
      const s = await mgr.createSession({ projectId: project.id, cwd: project.path, tool, permissionPreset })
      expect(adapters[tool].handed.at(-1)?.toolProfile).toBe('reader')
      expect(mgr.toolProfileOf(s.id)).toBe('reader')
      // An app's agent (M4 D-1) runs under safe (app-agents.test.ts); the preset is not what takes its tools away
      const agent = await mgr.createSession({ projectId: project.id, cwd: project.path, tool, permissionPreset, appId: 'app-notes' })
      expect(adapters[tool].handed.at(-1)?.toolProfile).toBeUndefined()
      expect(adapters[tool].handed.at(-1)?.orchestratorTools).toBeUndefined()
      expect(mgr.toolProfileOf(agent.id)).toBeNull()
    }
  })

  it('the orchestrator is the orchestrator under either tool', async () => {
    for (const tool of ['claude', 'codex'] as const) {
      const { mgr, adapters } = world()
      mgr.configureOrchestrator(tool)
      const o = await mgr.orchestrator()
      expect(adapters[tool].handed.at(-1)?.toolProfile).toBe('orchestrator')
      expect(mgr.toolProfileOf(o.id)).toBe('orchestrator')
    }
  })
})

describe('codeIntelligenceOff — which sessions start without a language server (#686)', () => {
  const ci = (over: Partial<CodeIntelligenceFacts> = {}): CodeIntelligenceFacts => ({ kind: 'worker', appId: null, builder: false, askedBy: null, forkedFrom: null, ...over })

  it('a child starts without it: one start_agent started, a fork, an agent an app asked for', () => {
    expect(codeIntelligenceOff(ci({ askedBy: 'parent' }))).toBe(true)
    expect(codeIntelligenceOff(ci({ forkedFrom: 'busy', askedBy: 'requester' }))).toBe(true)
    // The orchestrator's fork has no askedBy (no project of its own): the copy alone makes it a child
    expect(codeIntelligenceOff(ci({ forkedFrom: 'busy' }))).toBe(true)
    expect(codeIntelligenceOff(ci({ appId: 'app-notes' }))).toBe(true)
  })

  it("its caller can keep it on for the task (start_agent's lsp: true); false is the default said aloud", () => {
    expect(codeIntelligenceOff(ci({ askedBy: 'parent', lsp: true }))).toBe(false)
    expect(codeIntelligenceOff(ci({ askedBy: 'parent', lsp: false }))).toBe(true)
  })

  it("sessions the person starts keep the person's own setting, whatever else they are", () => {
    expect(codeIntelligenceOff(ci())).toBe(false)
    expect(codeIntelligenceOff(ci({ lsp: false }))).toBe(false)
    expect(codeIntelligenceOff(ci({ kind: 'orchestrator' }))).toBe(false)
    // A builder session is the person's own work on their app, not an app's agent
    expect(codeIntelligenceOff(ci({ appId: 'app-notes', builder: true }))).toBe(false)
    // The removed control app's stamp is not an external app's agent (#372)
    expect(codeIntelligenceOff(ci({ appId: RESERVED_APP_IDS[0]! }))).toBe(false)
  })
})
