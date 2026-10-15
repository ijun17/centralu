import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, LinkedSessions, OrchestratorTools, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { ChildOwnership } from './child-ownership.js'
import { orchestratorToolsFor, type OrchestratorSeatHost } from './orchestrator-seat.js'

/*
 * The orchestrator tools over a host of fakes (#428): the scope each seat sees, and the ownership a send leaves. The
 * session manager's tests (orchestrator, coordinator, linked hub) run the same tools over the real manager.
 */

let store: Store
let meta: Map<string, SessionInfo>
let children: ChildOwnership
let host: OrchestratorSeatHost
let linked: LinkedSessions | null

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name: id, kind: 'worker', projectId: 'p1', tool: 'claude', state: 'idle', ...extra }) as SessionInfo

beforeEach(() => {
  store = new Store()
  meta = new Map([
    ['orch', session('orch', { kind: 'orchestrator', projectId: null, name: 'Orchestrator' })],
    ['a', session('a')],
    ['b', session('b', { projectId: 'p2' })],
  ])
  children = new ChildOwnership(store)
  linked = null
  host = {
    store,
    meta,
    children,
    proposals: { proposeMcpServer: vi.fn(), proposeSkill: vi.fn() },
    linkedReader: () => linked,
    emit: vi.fn(),
    updateCentraluAsked: vi.fn(),
    updateSettings: vi.fn(),
    createSession: vi.fn(),
    firstTool: vi.fn(),
    rename: vi.fn(),
    send: vi.fn(async () => {}),
    routedCards: vi.fn(() => []),
    answerRoutedCard: vi.fn(),
    busyForCaller: vi.fn(() => false),
    busyAnswer: vi.fn(),
    busyChoices: vi.fn(() => []),
    enqueue: vi.fn(),
    forkFor: vi.fn(),
    autoBoundaryOpen: vi.fn(() => true),
    createProjectAsked: vi.fn(),
    createProjectOnMachine: vi.fn(),
    builderRefOf: vi.fn(() => null),
    checkApp: vi.fn(),
    createApp: vi.fn(),
  }
})
afterEach(() => store.close())

describe('the scope of a seat', () => {
  it('the orchestrator lists every session but itself', async () => {
    const tools = orchestratorToolsFor(host, 'orch')
    expect((await tools.listSessions()).map((s) => s.sessionId)).toEqual(['a', 'b'])
  })

  it('a coordinator sees only its members, and is told so for anyone else', async () => {
    const tools = orchestratorToolsFor(host, 'orch', ['b'])
    expect((await tools.listSessions()).map((s) => s.sessionId)).toEqual(['b'])
    expect(await tools.sendToSession('a', 'hi')).toEqual({ ok: false, error: 'Not a member of this coordinating session: a' })
  })

  it("a project's reader view is its own project; a session with no project sees nothing", async () => {
    expect((await orchestratorToolsFor(host, 'a', undefined, true).listSessions()).map((s) => s.sessionId)).toEqual([])
    meta.set('a2', session('a2'))
    expect((await orchestratorToolsFor(host, 'a', undefined, true).listSessions()).map((s) => s.sessionId)).toEqual(['a2'])
    meta.set('loose', session('loose', { projectId: null }))
    expect(await orchestratorToolsFor(host, 'orch', undefined, true).listSessions()).toEqual([])
  })

  it('never reads or sends to itself', async () => {
    const tools = orchestratorToolsFor(host, 'orch')
    expect(await tools.readSession('orch')).toEqual({ ok: false, error: 'Does not read itself' })
    expect(await tools.sendToSession('orch', 'x')).toEqual({ ok: false, error: 'Cannot send to itself' })
  })
})

describe('what a send leaves', () => {
  it('a session at rest runs the turn this seat gave it, and owes the report asked for', async () => {
    const r = await orchestratorToolsFor(host, 'orch').sendToSession('a', 'do it', true)
    expect(r).toEqual({ ok: true })
    expect(host.send).toHaveBeenCalledWith('a', 'do it', undefined, { sessionId: 'orch', name: 'Orchestrator' })
    expect(children.turnOwners.get('a')?.callerId).toBe('orch')
    expect(children.awaitingReport.get('a')).toBe('orch')
  })

  it('a send that fails lets go of the turn it took', async () => {
    host.send = vi.fn(async () => {
      throw new Error('no process')
    })
    expect(await orchestratorToolsFor(host, 'orch').sendToSession('a', 'do it', true)).toEqual({ ok: false, error: 'no process' })
    expect(children.turnOwners.has('a')).toBe(false)
    expect(children.awaitingReport.has('a')).toBe(false)
  })

  it('a new instruction without a report drops this seat’s earlier request', async () => {
    children.markReport('a', 'orch')
    await orchestratorToolsFor(host, 'orch').sendToSession('a', 'again')
    expect(children.awaitingReport.has('a')).toBe(false)
  })

  it("a linked machine's session keeps the earlier report request when the send there fails", async () => {
    const send = vi.fn(async () => ({ ok: false as const, error: 'machine away' }))
    linked = { machineOf: (id: string) => (id === 'm1/x' ? 'm1' : null), send } as unknown as LinkedSessions
    children.setLinkedReport('m1/x', { orchestratorId: 'other', busy: true })
    expect(await orchestratorToolsFor(host, 'orch').sendToSession('m1/x', 'hi', true)).toEqual({ ok: false, error: 'machine away' })
    expect(send).toHaveBeenCalledWith('m1/x', 'hi', 'Orchestrator')
    expect(children.linkedReports.get('m1/x')).toEqual({ orchestratorId: 'other', busy: true })
    // A coordinator does not reach the machines: the same id is just not one of its sessions
    expect(await orchestratorToolsFor(host, 'orch', ['a']).sendToSession('m1/x', 'hi')).toEqual({ ok: false, error: 'Not a member of this coordinating session: m1/x' })
  })
})

describe('over the real manager', () => {
  /** The smallest adapter a session can be created with: a process that only records what it is sent */
  class Adapter implements AgentAdapter {
    readonly tool: ToolName = 'claude'
    descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
    readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
    }
    async detect() {
      return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
    }
    async createSession(opts: CreateSessionOpts, _emit: EventSink): Promise<SessionHandle> {
      return { sessionId: opts.sessionId, externalId: `ext-${opts.sessionId}`, send() {}, respondApproval: () => true, interrupt() {}, async dispose() {} }
    }
  }

  it('reads the sessions as they are now, after the person reorders them (#757 review)', async () => {
    const real = new Store()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', new Adapter()]])
    const mgr = new SessionManager(real, adapters, () => {})
    const rpc = createRpcHandler(mgr, adapters)
    try {
      const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
      const create = async () => ((await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }).id
      const orch = await create()
      const a = await create()
      const tools = (mgr as unknown as { orchestratorToolsFor(id: string): OrchestratorTools }).orchestratorToolsFor(orch)
      mgr.reorderSessions(p.id, [a, orch])
      const b = await create()
      expect((await tools.listSessions()).map((s) => s.sessionId).sort()).toEqual([a, b].sort())
    } finally {
      await mgr.disposeAll()
      real.close()
    }
  })
})
