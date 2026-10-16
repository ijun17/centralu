import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionLiveDefaults, type AdapterCapabilities, type SessionInfo, type ToolName } from '@cc/protocol'
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
    linkedReportRestored: vi.fn(),
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
    handoff: vi.fn(async () => ({ ok: false as const, error: 'reached the flow' })),
    handoffWait: vi.fn(async () => ({ ok: false as const, error: 'reached the wait' })),
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

  it('only the central orchestrator reaches a handoff, of a session on this computer in its view (#694)', async () => {
    const central = orchestratorToolsFor(host, 'orch')
    expect(await central.handoffSession!({ sessionId: 'orch' })).toEqual({ ok: false, error: 'An orchestrator does not hand itself off; the person does that.' })
    expect(await central.handoffSession!({ sessionId: 'nobody' })).toEqual({ ok: false, error: 'Not a session this app manages: nobody' })
    // A lead, a project's reader view and a hub's view of this host never reach the flow, even for a session they see
    for (const seat of [orchestratorToolsFor(host, 'orch', ['a']), orchestratorToolsFor(host, 'b', undefined, true), orchestratorToolsFor(host, 'orch', undefined, false, true)]) {
      expect(await seat.handoffSession!({ sessionId: 'a' })).toEqual({ ok: false, error: 'Only the orchestrator hands sessions off' })
    }
    // A linked machine's session is handed off there
    linked = { machineOf: (id: string) => (id === 'far' ? { id: 'm1', name: 'Far' } : null) } as unknown as LinkedSessions
    expect(await central.handoffSession!({ sessionId: 'far' })).toEqual({ ok: false, error: 'That session runs on a linked machine; hand it off there.' })
    expect(host.handoff).not.toHaveBeenCalled()
    expect(await central.handoffSession!({ sessionId: 'a', mode: 'agent', instructions: 'go on' })).toEqual({ ok: false, error: 'reached the flow' })
    expect(host.handoff).toHaveBeenCalledWith('orch', meta.get('a'), { mode: 'agent', instructions: 'go on' }, undefined)
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

describe("two sends to a linked machine's session at once (#839)", () => {
  /** A linked machine whose sends answer when the test says, in any order */
  const machine = () => {
    const answers: ((r: { ok: true } | { ok: false; error: string }) => void)[] = []
    linked = {
      machineOf: (id: string) => (id === 'far' ? { id: 'm1', name: 'Far' } : null),
      send: () => new Promise((r) => answers.push(r)),
    } as unknown as LinkedSessions
    return answers
  }

  it("a send that fails puts back only what it replaced: the other call's report request stays", async () => {
    const answers = machine()
    const tools = orchestratorToolsFor(host, 'orch')
    const first = tools.sendToSession('far', 'first', true)
    const second = tools.sendToSession('far', 'second', true)
    const asked = children.linkedReports.get('far')
    // The second went out after the first; the first fails, the second goes in
    answers[0]!({ ok: false, error: 'the link dropped' })
    answers[1]!({ ok: true })
    expect(await first).toMatchObject({ ok: false })
    expect(await second).toEqual({ ok: true })
    expect(children.linkedReports.get('far')).toBe(asked)
    expect(host.linkedReportRestored).not.toHaveBeenCalled()
  })

  it('two sends that both fail, the first failing first, put back the request that was there before either', async () => {
    const answers = machine()
    const tools = orchestratorToolsFor(host, 'orch')
    const original = { orchestratorId: 'orch', busy: false }
    children.setLinkedReport('far', original)
    const first = tools.sendToSession('far', 'first', true)
    const second = tools.sendToSession('far', 'second', true)
    answers[0]!({ ok: false, error: 'the link dropped' })
    expect(await first).toMatchObject({ ok: false })
    answers[1]!({ ok: false, error: 'the link dropped' })
    expect(await second).toMatchObject({ ok: false })
    expect(children.linkedReports.get('far')).toBe(original)
  })

  it('a send without a report drops only the request it found, not one another call set meanwhile', async () => {
    const answers = machine()
    const tools = orchestratorToolsFor(host, 'orch')
    children.setLinkedReport('far', { orchestratorId: 'orch', busy: false })
    const plain = tools.sendToSession('far', 'no report needed', false)
    const reported = tools.sendToSession('far', 'tell me', true)
    const asked = children.linkedReports.get('far')
    answers[1]!({ ok: true })
    answers[0]!({ ok: true })
    await Promise.all([plain, reported])
    expect(children.linkedReports.get('far')).toBe(asked)
  })
})

/*
 * create_session (#838): the new session never runs above the seat's own permissions, and its first message is the
 * seat's, not the person's. It was `normal` whatever the seat ran under, with the instruction stored as the person's.
 */
describe('a session the orchestrator creates', () => {
  const created = (id: string) => ({ ...session(id), permissionPreset: 'safe' }) as SessionInfo

  beforeEach(() => {
    store.addProject({ id: 'p1', path: tmpdir(), name: 'site' })
    host.createSession = vi.fn(async () => created('new'))
    host.firstTool = vi.fn(() => 'claude' as ToolName)
  })

  it('a safe seat creates a safe session, and its first message is marked as the seat’s', async () => {
    meta.set('orch', { ...meta.get('orch')!, permissionPreset: 'safe' })
    expect(await orchestratorToolsFor(host, 'orch').createSession({ project: 'site', firstMessage: 'do it' })).toMatchObject({ ok: true })
    expect(host.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionPreset: 'safe' }))
    expect(host.send).toHaveBeenCalledWith('new', 'do it', undefined, { sessionId: 'orch', name: 'Orchestrator' })
  })

  it('a normal seat creates a normal session, and an auto seat still no more than normal', async () => {
    for (const [seat, expected] of [['normal', 'normal'], ['auto', 'normal']] as const) {
      meta.set('orch', { ...meta.get('orch')!, permissionPreset: seat })
      await orchestratorToolsFor(host, 'orch').createSession({ project: 'site' })
      expect(host.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ permissionPreset: expected }))
    }
  })

  it('on a linked machine, the same cap goes with the request', async () => {
    meta.set('orch', { ...meta.get('orch')!, permissionPreset: 'safe' })
    const createSession = vi.fn(async () => ({ ok: true as const, sessionId: 'm1/s', name: 's' }))
    const send = vi.fn(async () => ({ ok: true as const }))
    linked = { findProjects: async () => [{ id: 'm1.p9', name: 'far', machine: 'Far', path: '/x' }], createSession, send } as unknown as LinkedSessions
    expect(await orchestratorToolsFor(host, 'orch').createSession({ project: 'far', firstMessage: 'go' })).toMatchObject({ ok: true })
    expect(createSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preset: 'safe' }))
    expect(send).toHaveBeenCalledWith('m1/s', 'go', 'Orchestrator')
  })
})

// read_session said only role "user" for every message in, so a child's report or an app's text read as the person's (#838)
describe('what read_session says of who wrote a line', () => {
  it('a line another session or an app sent carries its name; the person’s carries none', async () => {
    store.addProject({ id: 'p1', path: tmpdir(), name: 'site' })
    store.upsertSession({
      id: 'a', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'a', autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
      scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
    store.appendMessages([
      { sessionId: 'a', seq: 1, role: 'user', kind: 'text', payload: { text: 'mine' }, ts: 1 },
      { sessionId: 'a', seq: 2, role: 'user', kind: 'text', payload: { text: 'report', from: { sessionId: 'w', name: 'Worker' } }, ts: 2 },
      { sessionId: 'a', seq: 3, role: 'user', kind: 'text', payload: { text: 'view', fromApp: { appId: 's', projectId: null, name: 'Slider' } }, ts: 3 },
    ])
    const r = await orchestratorToolsFor(host, 'orch').readSession('a')
    const lines = (r as { lines: string[] }).lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map(({ text, from, fromApp }) => ({ text, from, fromApp }))).toEqual([
      { text: 'mine', from: undefined, fromApp: undefined },
      { text: 'report', from: 'Worker', fromApp: undefined },
      { text: 'view', from: undefined, fromApp: 'Slider' },
    ])
  })
})
