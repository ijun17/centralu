import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    askAppProject: vi.fn(async () => null),
    createProjectOnMachine: vi.fn(),
    addFolderAsked: vi.fn(),
    addFolderOnMachine: vi.fn(),
    machineList: vi.fn(() => []),
    machineRequest: vi.fn(),
    preferencesRequest: vi.fn(),
    trashRequest: vi.fn(),
    trustRequest: vi.fn(),
    appUpkeepRequest: vi.fn(),
    housekeepingRequest: vi.fn(),
    startAgent: vi.fn(async () => ({ ok: false as const, error: 'reached the start flow' })),
    agentSession: vi.fn(async () => ({ ok: false as const, error: 'reached the start flow' })),
    listAgents: vi.fn(async () => []),
    handoff: vi.fn(async () => ({ ok: false as const, error: 'reached the flow' })),
    handoffWait: vi.fn(async () => ({ ok: false as const, error: 'reached the wait' })),
    usageHistory: vi.fn(() => ({ by: 'session' as const, readings: [], rows: [] })),
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

  /** p1 trusted ("shop"), p2 not ("clone"), and a linked machine with a session of each kind a reader may meet there */
  const wideWorld = () => {
    store.projects.addProject({ id: 'p1', path: join(tmpdir(), 'p1'), name: 'shop', trusted: true })
    store.projects.addProject({ id: 'p2', path: join(tmpdir(), 'p2'), name: 'clone' })
    meta.set('a2', session('a2'))
    meta.set('coord', session('coord', { kind: 'coordinator', projectId: 'p2' }))
    meta.set('agent', session('agent', { projectId: 'p2', appId: 'notes' }))
    meta.set('builder', session('builder', { projectId: null, appId: 'notes' }))
    const read = vi.fn(async () => ({ ok: true as const, state: 'idle' as const, lines: ['{"role":"user","text":"over there"}'] }))
    const remote = (sessionId: string, project: string) => ({ sessionId, name: sessionId, project, machine: 'Far', state: 'idle', tool: 'claude' })
    const facts: Record<string, { app: boolean; trusted: boolean }> = {
      'm1.x': { app: false, trusted: true },
      'm1.u': { app: false, trusted: false },
      'm1.app': { app: true, trusted: true },
    }
    linked = {
      machineOf: (id: string) => (id.startsWith('m1.') ? 'Far' : null),
      readerFacts: (id: string) => facts[id] ?? null,
      list: async () => [remote('m1.x', 'site'), remote('m1.u', 'fork'), remote('m1.app', 'site'), remote('m1.new', 'site')],
      read,
      recall: async () => ({
        hits: [['m1.x', 'm1.u', 'm1.app', 'm1.new'].map((id, i) => ({ sessionId: id, session: id, project: 'site', machine: 'Far', snippet: 'the far plan', seq: i + 1 }))],
        notSearched: [],
      }),
    } as unknown as LinkedSessions
    return { read }
  }

  it("a reader of a trusted project reads every project's ordinary sessions, here and on the linked machines, marking the untrusted (#984)", async () => {
    const { read } = wideWorld()
    const reader = orchestratorToolsFor(host, 'a', undefined, true)
    // Its own project's sessions first, then the other projects', then the machines'. Never an orchestrator, a
    // coordinator or an app's session (its agent, its builder), nor a machine's session the hub's mirror does not hold
    expect((await reader.listSessions()).map((s) => [s.sessionId, s.project])).toEqual([
      ['a2', 'shop'],
      ['b', 'clone (not trusted)'],
      ['m1.x', 'site'],
      ['m1.u', 'fork (not trusted)'],
    ])
    expect((await reader.listSessions({ project: 'CLONE' })).map((s) => s.sessionId)).toEqual(['b'])
    expect(await reader.readSession('m1.x', 40, { around: 3 })).toMatchObject({ ok: true, lines: ['{"role":"user","text":"over there"}'] })
    expect(read).toHaveBeenCalledWith('m1.x', 40, { around: 3 })
    expect(await reader.readSession('m1.u')).toMatchObject({ ok: true, untrusted: true })
    expect(await reader.readSession('b')).toMatchObject({ ok: true, untrusted: true })
    expect(await reader.readSession('a2')).not.toHaveProperty('untrusted')
    for (const id of ['orch', 'coord', 'agent', 'builder', 'm1.app', 'm1.new']) {
      expect(await reader.readSession(id)).toEqual({ ok: false, error: `Not a session you can read: ${id}` })
    }
    expect(read).toHaveBeenCalledTimes(2)
    expect((await reader.recall('plan')).hits.map((h) => [h.sessionId, h.project])).toEqual([
      ['m1.x', 'site'],
      ['m1.u', 'site (not trusted)'],
    ])
    // Acting stays inside its own project: another project's session, or a machine's, is out of reach
    expect(await reader.sendToSession('b', 'do it')).toEqual({ ok: false, error: 'Not a session in this project: b' })
    expect(await reader.sendToSession('m1.x', 'do it')).toEqual({ ok: false, error: 'Not a session in this project: m1.x' })
    expect(host.send).not.toHaveBeenCalled()
  })

  it('a reader of an untrusted project reads its own project only, and no linked machine (#984, the #382 rule)', async () => {
    const { read } = wideWorld()
    meta.set('c2', session('c2', { projectId: 'p2' }))
    const reader = orchestratorToolsFor(host, 'c2', undefined, true)
    // Its own project as before (#320), the coordinator and the app's agent there included; nothing marked
    expect((await reader.listSessions()).map((s) => [s.sessionId, s.project])).toEqual([
      ['b', 'clone'],
      ['coord', 'clone'],
      ['agent', 'clone'],
    ])
    expect(await reader.readSession('a2')).toEqual({ ok: false, error: 'Not a session in this project: a2' })
    expect(await reader.readSession('m1.x')).toEqual({ ok: false, error: 'Not a session in this project: m1.x' })
    expect(await reader.readSession('b')).not.toHaveProperty('untrusted')
    expect((await reader.recall('plan')).hits).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('a coordinator reads its members only, and never a linked machine', async () => {
    const { read } = wideWorld()
    const lead = orchestratorToolsFor(host, 'orch', ['a2'])
    expect((await lead.listSessions()).map((s) => s.sessionId)).toEqual(['a2'])
    expect(await lead.readSession('b')).toEqual({ ok: false, error: 'Not a member of this coordinating session: b' })
    expect(await lead.readSession('m1.x')).toEqual({ ok: false, error: 'Not a member of this coordinating session: m1.x' })
    expect((await lead.recall('plan')).hits).toEqual([])
    expect(read).not.toHaveBeenCalled()
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

  it('only the central orchestrator reaches the trust commands (#1219): a lead, a reader view and a hub view never do', async () => {
    host.trustRequest = vi.fn(async () => ({ ok: true as const, text: 'reached the flow' }))
    for (const seat of [orchestratorToolsFor(host, 'orch', ['a']), orchestratorToolsFor(host, 'b', undefined, true), orchestratorToolsFor(host, 'orch', undefined, false, true)]) {
      expect(await seat.trust!({ action: 'project_trust', project: 'p', trusted: true })).toEqual({ ok: false, error: 'Only the orchestrator changes trust' })
    }
    expect(host.trustRequest).not.toHaveBeenCalled()
    expect(await orchestratorToolsFor(host, 'orch').trust!({ action: 'list_projects' })).toEqual({ ok: true, text: 'reached the flow' })
    expect(host.trustRequest).toHaveBeenCalledWith('orch', { action: 'list_projects' }, undefined)
  })

  it('only the central orchestrator reaches the app upkeep commands (#1219): a lead, a reader view and a hub view never do', async () => {
    host.appUpkeepRequest = vi.fn(async () => ({ ok: true as const, text: 'reached the flow' }))
    for (const seat of [orchestratorToolsFor(host, 'orch', ['a']), orchestratorToolsFor(host, 'b', undefined, true), orchestratorToolsFor(host, 'orch', undefined, false, true)]) {
      expect(await seat.appUpkeep!({ action: 'remove', app: 'notes' })).toEqual({ ok: false, error: 'Only the orchestrator looks after apps' })
    }
    expect(host.appUpkeepRequest).not.toHaveBeenCalled()
    expect(await orchestratorToolsFor(host, 'orch').appUpkeep!({ action: 'usage', app: 'notes' })).toEqual({ ok: true, text: 'reached the flow' })
    expect(host.appUpkeepRequest).toHaveBeenCalledWith('orch', { action: 'usage', app: 'notes' }, undefined)
  })

  it('only the central orchestrator reaches the housekeeping commands (#1219): a lead, a reader view and a hub view never do', async () => {
    host.housekeepingRequest = vi.fn(async () => ({ ok: true as const, text: 'reached the flow' }))
    for (const seat of [orchestratorToolsFor(host, 'orch', ['a']), orchestratorToolsFor(host, 'b', undefined, true), orchestratorToolsFor(host, 'orch', undefined, false, true)]) {
      expect(await seat.housekeeping!({ action: 'rename_session', sessionId: 'a', name: 'x' })).toEqual({ ok: false, error: 'Only the orchestrator does this housekeeping' })
    }
    expect(host.housekeepingRequest).not.toHaveBeenCalled()
    expect(await orchestratorToolsFor(host, 'orch').housekeeping!({ action: 'agent_status' })).toEqual({ ok: true, text: 'reached the flow' })
    expect(host.housekeepingRequest).toHaveBeenCalledWith('orch', { action: 'agent_status' })
  })

  it('never reads or sends to itself', async () => {
    const tools = orchestratorToolsFor(host, 'orch')
    expect(await tools.readSession('orch')).toEqual({
      ok: false,
      error: 'Does not read itself: your conversation has not been compacted, so all of it is still in your context.',
    })
    expect(await tools.sendToSession('orch', 'x')).toEqual({ ok: false, error: 'Cannot send to itself' })
  })
})

describe('a session recalls its own conversation from before its compaction (#974)', () => {
  type Row = ['user' | 'assistant', string] | ['compaction' | 'failed' | 'reset']
  /** One session's conversation, seq from 1 */
  const put = (sessionId: string, rows: Row[]) => {
    const s = meta.get(sessionId)!
    if (s.projectId && !store.projects.listProjects().some((p) => p.id === s.projectId)) store.projects.addProject({ id: s.projectId, path: join(tmpdir(), s.projectId), name: s.projectId, trusted: s.projectId === 'p1' })
    store.sessions.upsertSession({
      id: sessionId, projectId: s.projectId, kind: s.kind, tool: 'claude', externalId: null, name: s.name, autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
      scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
    store.messages.appendMessages(
      rows.map(([what, text], i) => {
        const at = { sessionId, seq: i + 1, ts: 1_700_000_000_000 + i * 60_000 }
        if (what === 'user' || what === 'assistant') return { ...at, role: what, kind: 'text', payload: { text } }
        const payload = what === 'reset' ? { type: 'conversation_reset', sessionId } : { type: 'compaction', sessionId, failed: what === 'failed' }
        return { ...at, role: 'system', kind: 'marker', payload }
      }),
    )
  }
  /** Long enough apart that `dedupeNearbyHits` keeps both */
  const filler = (n: number): Row[] => Array.from({ length: n }, (_, i): Row => ['assistant', `step ${i} went fine`])
  const compacted: Row[] = [
    ['user', 'run the zebracorn migration with flag --keep-42'],
    ...filler(8),
    ['compaction'],
    ...filler(8),
    ['user', 'is the zebracorn migration done?'],
  ]
  const ownHits = async (tools: OrchestratorTools, own: string) =>
    (await tools.recall('zebracorn')).hits.filter((h) => h.sessionId === own)

  it('recall finds its own words from before the compaction, marked as its own, in every seat with recall', async () => {
    put('orch', compacted)
    put('a', compacted)
    const seats: [OrchestratorTools, string][] = [
      [orchestratorToolsFor(host, 'orch'), 'orch'],
      [orchestratorToolsFor(host, 'orch', ['b']), 'orch'],
      [orchestratorToolsFor(host, 'a', undefined, true), 'a'],
    ]
    for (const [tools, own] of seats) {
      const hits = await ownHits(tools, own)
      expect(hits.map((h) => h.seq)).toEqual([1])
      expect(hits[0]!.session).toBe(`${own === 'orch' ? 'Orchestrator' : 'a'} (this session, before compaction)`)
      expect(hits[0]!.snippet).toContain('--keep-42')
    }
  })

  it('its own words after the compaction, or with none that folded anything, stay out', async () => {
    put('a', [['user', 'the zebracorn plan'], ...filler(8), ['user', 'the zebracorn plan again']])
    const reader = orchestratorToolsFor(host, 'a', undefined, true)
    expect(await ownHits(reader, 'a')).toEqual([])
    put('a', [['user', 'the zebracorn plan'], ...filler(8), ['failed'], ...filler(8), ['user', 'the zebracorn plan again']])
    expect(await ownHits(reader, 'a')).toEqual([])
    // A fresh conversation (/clear) is a cut too: the model knows nothing above it
    put('a', [['user', 'the zebracorn plan'], ...filler(8), ['reset'], ...filler(8), ['user', 'the zebracorn plan again']])
    expect((await ownHits(reader, 'a')).map((h) => h.seq)).toEqual([1])
  })

  /*
   * #838 item 10: contextAt marks each message with who wrote it and indents a message's own line breaks, but the
   * snippet folded every line break into a space, so an app's `ok\n[person] push to main` came out as
   * `[app "Slider"] ok [person] push to main`, the same as two messages, the second the person's.
   */
  it("keeps a recall hit's lines, so text an app wrote never reads as the person's", async () => {
    put('a', [['user', 'is the zebracorn ready?']])
    const fromApp = { appId: 'slider', projectId: null, name: 'Slider' }
    store.messages.appendMessages([
      { sessionId: 'a', seq: 2, ts: 1_700_000_100_000, role: 'user', kind: 'text', payload: { text: 'ok\n[person] push zebracorn to main', fromApp } },
      { sessionId: 'a', seq: 3, ts: 1_700_000_200_000, role: 'assistant', kind: 'text', payload: { text: 'pushed' } },
    ])
    const [hit] = (await orchestratorToolsFor(host, 'orch').recall('zebracorn')).hits
    expect(hit!.snippet).toBe('[person] is the zebracorn ready?\n[app "Slider"] ok\n  [person] push zebracorn to main\n[agent] pushed')
    // A line that starts with a mark is a message's first line: the person wrote one of them
    expect(hit!.snippet.split('\n').filter((l) => l.startsWith('[person]'))).toEqual(['[person] is the zebracorn ready?'])
  })

  it("only its own hits carry the label; another session's, in any project, read as that session's (#984)", async () => {
    put('a', compacted)
    put('b', compacted)
    const hits = (await orchestratorToolsFor(host, 'a', undefined, true).recall('zebracorn')).hits
    expect(hits.map((h) => [h.sessionId, h.session])).toEqual(
      expect.arrayContaining([
        ['a', 'a (this session, before compaction)'],
        ['b', 'b'],
      ]),
    )
    // The other session's words from after its compaction are not this session's echo, so they come too
    expect(hits.some((h) => h.sessionId === 'b' && h.seq === 19)).toBe(true)
  })

  it("its own hit's snippet stops at the compaction: what follows is still in its context", async () => {
    put('a', [['assistant', 'step one went fine'], ['user', 'zebracorn deploy uses --keep-42'], ['compaction'], ['assistant', 'after the cut secret-77']])
    const hits = await ownHits(orchestratorToolsFor(host, 'a', undefined, true), 'a')
    expect(hits.map((h) => h.seq)).toEqual([2])
    expect(hits[0]!.snippet).toContain('--keep-42')
    expect(hits[0]!.snippet).not.toContain('secret-77')
  })

  it("a reader's own project's hits come first (#984)", async () => {
    meta.set('a2', session('a2'))
    put('b', [['user', 'zebracorn']])
    put('a2', [['user', 'a long line about many other things, and somewhere near its end the zebracorn too']])
    const hits = (await orchestratorToolsFor(host, 'a', undefined, true).recall('zebracorn')).hits
    expect(hits.map((h) => h.sessionId)).toEqual(['a2', 'b'])
  })

  it('read_session reads itself only around a hit from before the cut, and only up to the cut', async () => {
    put('a', compacted)
    const reader = orchestratorToolsFor(host, 'a', undefined, true)
    const r = await reader.readSession('a', 40, { around: 1 })
    if (!r.ok) throw new Error(r.error)
    const lines = r.lines ?? []
    expect(lines.join('\n')).toContain('--keep-42')
    // The rest is still in its context: the window stops at the compaction
    expect(lines.join('\n')).not.toContain('is the zebracorn migration done?')
    // The person's line, then the eight replies as one answer
    expect(lines).toHaveLength(2)
    const refused = 'Reads itself only before its last compaction, from a recall hit: search with recall, then pass that hit\'s seq as around.'
    expect(await reader.readSession('a')).toEqual({ ok: false, error: refused })
    expect(await reader.readSession('a', 40, { around: 10 })).toEqual({ ok: false, error: refused })
    expect(await reader.readSession('a', 40, { around: 19 })).toEqual({ ok: false, error: refused })
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
    store.projects.addProject({ id: 'p1', path: tmpdir(), name: 'site' })
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
    linked = { projects: async () => ({ projects: [{ id: 'm1.p9', name: 'far', machine: 'Far', path: '/x' }], away: [] }), createSession, send } as unknown as LinkedSessions
    expect(await orchestratorToolsFor(host, 'orch').createSession({ project: 'far', firstMessage: 'go' })).toMatchObject({ ok: true })
    expect(createSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preset: 'safe' }))
    expect(send).toHaveBeenCalledWith('m1/s', 'go', 'Orchestrator')
  })
})

// read_session said only role "user" for every message in, so a child's report or an app's text read as the person's (#838)
describe('what read_session says of who wrote a line', () => {
  it('a line another session or an app sent carries its name; the person’s carries none', async () => {
    store.projects.addProject({ id: 'p1', path: tmpdir(), name: 'site' })
    store.sessions.upsertSession({
      id: 'a', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'a', autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
      scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
    store.messages.appendMessages([
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

/*
 * #1186: read_session cut every line at 2,000 characters of its JSON with no word of it, so the middle of a long answer
 * (where ask_project's cut sent the caller) could not be read back at all. A cut line now says what it shows and the
 * read that goes on, and following those reads gives the whole text, at every size around the two limits.
 */
describe('a long line in read_session', () => {
  const putTurn = (texts: string[]) => {
    store.projects.addProject({ id: 'p1', path: tmpdir(), name: 'site' })
    store.sessions.upsertSession({
      id: 'a', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'a', autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
      scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
    store.messages.appendMessages([
      { sessionId: 'a', seq: 1, role: 'user', kind: 'text', payload: { text: 'write the report' }, ts: 1 },
      { sessionId: 'a', seq: 2, role: 'assistant', kind: 'tool_call', payload: { summary: { tool: 'Read', title: 'README.md' } }, ts: 2 },
      ...texts.map((text, i) => ({ sessionId: 'a', seq: 3 + i, role: 'assistant' as const, kind: 'text' as const, payload: { text }, ts: 3 + i })),
    ])
  }
  /** The last line of a plain read, then every read it names, joined back together */
  const readWhole = async (tools: OrchestratorTools): Promise<{ text: string; reads: number }> => {
    const first = await tools.readSession('a')
    if (!first.ok) throw new Error(first.error)
    let line = JSON.parse(first.lines!.at(-1)!) as { text: string; readOn?: string }
    let text = line.text
    let reads = 1
    while (line.readOn) {
      const m = /around=(\d+) and offset=(\d+)/.exec(line.readOn)
      if (!m) throw new Error(`no read in ${line.readOn}`)
      const next = await tools.readSession('a', 40, { around: Number(m[1]), offset: Number(m[2]) })
      if (!next.ok) throw new Error(next.error)
      expect(next.lines).toHaveLength(1)
      line = JSON.parse(next.lines![0]!) as { text: string; readOn?: string }
      text += line.text
      if (++reads > 20) throw new Error('reads without end')
    }
    return { text, reads }
  }
  const sizes = [0, 1, 1999, 2000, 2001, 4000, 9999, 10_000, 10_001, 18_000, 18_001, 30_000]

  it.each(sizes)('reads a %i-character answer whole by the reads its cut names', async (n) => {
    // Characters JSON escapes, so a cut counted on the JSON rather than the text would show
    const answer = Array.from({ length: n }, (_, i) => '"\\ab\ncd'[i % 7]).join('')
    expect(answer).toHaveLength(n)
    putTurn([answer])
    const { text, reads } = await readWhole(orchestratorToolsFor(host, 'orch'))
    expect(text).toBe(answer)
    expect(reads).toBe(n <= 2000 ? 1 : 1 + Math.ceil((n - 2000) / 8000))
  })

  it('reads a response of several messages as the one line the plain read shows', async () => {
    putTurn(['x'.repeat(1500), 'y'.repeat(1500), 'z'.repeat(1500)])
    const tools = orchestratorToolsFor(host, 'orch')
    const plain = await tools.readSession('a')
    const last = JSON.parse((plain as { lines: string[] }).lines.at(-1)!) as Record<string, unknown>
    expect(last).toMatchObject({ role: 'assistant', shown: 'characters 0-2000 of 4504', readOn: 'read_session with around=3 and offset=2000 reads on from here' })
    expect((await readWhole(tools)).text).toBe(['x'.repeat(1500), 'y'.repeat(1500), 'z'.repeat(1500)].join('\n\n'))
  })

  it('says a line it shows whole nothing more, and an offset past the end shows nothing of it', async () => {
    putTurn(['short'])
    const tools = orchestratorToolsFor(host, 'orch')
    expect((await tools.readSession('a') as { lines: string[] }).lines.at(-1)).not.toContain('readOn')
    const past = await tools.readSession('a', 40, { around: 3, offset: 50 })
    expect(JSON.parse((past as { lines: string[] }).lines[0]!)).toMatchObject({ text: '', shown: 'characters 5-5 of 5' })
    // A read from an offset says what it shows even when that is all of it: a hub tells an older machine by its absence
    const whole = await tools.readSession('a', 40, { around: 3, offset: 0 })
    expect(JSON.parse((whole as { lines: string[] }).lines[0]!)).toMatchObject({ text: 'short', shown: 'characters 0-5 of 5' })
  })
})

describe('a successor reads and recalls its archived handoff lineage (#1487)', () => {
  const stored = (id: string, project: string | null = 'p1') =>
    store.sessions.upsertSession({
      id, projectId: project, kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
      serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null,
      scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
  /** A session's conversation: its handoff marker first when it took over from `from`, then the lines, seq from 1 */
  const put = (id: string, lines: ['user' | 'assistant', string][], from?: string, project: string | null = 'p1') => {
    stored(id, project)
    store.messages.appendMessages([
      ...(from ? [{ sessionId: id, seq: 1, ts: 1_700_000_000_000, role: 'system' as const, kind: 'marker' as const, payload: { type: 'handoff', from: 'x', note: 'n', fromSessionId: from } }] : []),
      ...lines.map(([role, text], i) => ({ sessionId: id, seq: i + 2, ts: 1_700_000_060_000 + i * 60_000, role, kind: 'text' as const, payload: { text } })),
    ])
  }
  const archive = (id: string) => store.trash.trashSession(id, { projectId: 'p1', projectName: null, projectPath: null, removeExternal: false, removeWorktree: false })

  beforeEach(async () => {
    for (const id of ['p1', 'p2']) store.projects.addProject({ id, path: join(tmpdir(), id), name: `project ${id}`, trusted: id === 'p1' })
    // a <- old1 <- old0, all archived but a; `stranger` is archived and part of no chain; `gone` was deleted for good
    put('old0', [['user', 'start the quokkaline port'], ['assistant', 'quokkaline port started in module X']])
    put('old1', [['user', 'carry on'], ['assistant', 'the second generation did the marmalade step']], 'old0')
    put('stranger', [['assistant', 'the quokkaline of someone else']])
    put('a', [['user', 'you are the successor']], 'old1')
    for (const id of ['old0', 'old1', 'stranger']) await archive(id)
  })

  it('reads the archived predecessor and its predecessor, every line marked as the predecessor’s', async () => {
    const reader = orchestratorToolsFor(host, 'a', undefined, true)
    const one = await reader.readSession('old1')
    expect(one).toMatchObject({ ok: true, state: 'archived', predecessor: 'old1' })
    const lines = (one.lines ?? []).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map((l) => [l.role, l.predecessor])).toEqual([['user', 'old1'], ['predecessor', 'old1']])
    // Never the reader's own role, and the words are there
    expect(lines.some((l) => l.role === 'assistant')).toBe(false)
    expect(lines[1]!.text).toContain('marmalade')
    const two = await reader.readSession('old0')
    expect(two.ok).toBe(true)
    expect(two.lines?.join('\n')).toContain('quokkaline port started')
    expect(two.lines?.every((l) => JSON.parse(l).predecessor === 'old0')).toBe(true)
    // A line cut and read on from an offset is the predecessor's too
    const long = await reader.readSession('old0', 40, { around: 2, offset: 6 })
    expect(JSON.parse(long.lines![0]!)).toMatchObject({ role: 'user', predecessor: 'old0', shown: expect.stringContaining('characters 6-') })
  })

  it('refuses an archived session that is not in its lineage, as it does a missing one', async () => {
    const reader = orchestratorToolsFor(host, 'a', undefined, true)
    // The lineage opens the archive to its own members only: one of them is read, the neighbour in the archive is not
    expect(await reader.readSession('old1')).toMatchObject({ ok: true })
    expect(await reader.readSession('stranger')).toEqual({ ok: false, error: 'Not a session you can read: stranger' })
    expect(await reader.readSession('nowhere')).toEqual({ ok: false, error: 'Not a session you can read: nowhere' })
    // Another session’s lineage is its own: `old1`'s chain does not make `a`'s reader of `stranger`
    expect(await orchestratorToolsFor(host, 'b', undefined, true).readSession('old0')).toMatchObject({ ok: false })
    // A hub's view has no caller, so no lineage
    expect(await orchestratorToolsFor(host, '', undefined, false, true).readSession('old1')).toMatchObject({ ok: false })
  })

  it('deleting a session for good ends its part of the chain', async () => {
    await store.trash.purgeSession('old1')
    const reader = orchestratorToolsFor(host, 'a', undefined, true)
    expect(await reader.readSession('old1')).toMatchObject({ ok: false })
    // Its predecessor is no longer reachable through it
    expect(await reader.readSession('old0')).toMatchObject({ ok: false })
    expect(store.handoffs.lineage('a')).toEqual([])
  })

  it('recall finds a word only an archived predecessor said, marked as the predecessor’s', async () => {
    const reader = orchestratorToolsFor(host, 'a', undefined, true)
    const hits = (await reader.recall('marmalade')).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ sessionId: 'old1', predecessor: true, seq: 3 })
    expect(hits[0]!.session).toContain('your predecessor, archived')
    expect(hits[0]!.snippet).toContain('[predecessor]')
    expect(hits[0]!.snippet).toContain('[person, to the predecessor]')
    expect(hits[0]!.snippet).not.toContain('[agent]')
    // The generation before it too; the unrelated archived session stays out
    expect((await reader.recall('quokkaline')).hits.map((h) => h.sessionId)).toEqual(['old0'])
    // A session with no lineage finds none of it, and neither does the archive's index
    expect((await orchestratorToolsFor(host, 'b', undefined, true).recall('marmalade')).hits).toEqual([])
  })

  it('a note’s call repeats the tools and maxChars given, and tells a reader behind a hub it may be too old for it', async () => {
    put('big', Array.from({ length: 24 }, (_, i): ['user' | 'assistant', string] => (i % 2 ? ['assistant', `${i}`.padEnd(900, 'z')] : ['user', `q${i}`])))
    meta.set('big', session('big'))
    const direct = await orchestratorToolsFor(host, 'orch').readSession('big', 40, { tools: 'full', maxChars: 2000 })
    expect(JSON.parse(direct.lines![0]!).note).toMatch(/before=\d+ tools=full maxChars=2000 reads on/)
    expect(JSON.parse(direct.lines![0]!).note).not.toContain('hub')
    const viaHub = await orchestratorToolsFor(host, '', undefined, false, true).readSession('big', 40, { maxChars: 2000 })
    expect(JSON.parse(viaHub.lines![0]!).note).toMatch(/before=\d+ maxChars=2000 reads on.*the hub needs an update to read on; until then around=\d+ reads near the same spot/)
  })

  it('stops at a marker that names a session of another project, so a forged one reads nothing of the archive (#1487 review)', async () => {
    // `e` is a live session of p2 whose marker names the archived `old1` of p1: a handoff never crosses projects
    put('e', [['user', 'hello']], 'old1', 'p2')
    meta.set('e', session('e', { projectId: 'p2' }))
    expect(store.handoffs.lineage('e')).toEqual([])
    const forger = orchestratorToolsFor(host, 'e', undefined, true)
    expect(await forger.readSession('old1')).toMatchObject({ ok: false })
    expect((await forger.recall('marmalade')).hits).toEqual([])
    // And one whose own session has no project at all
    put('f', [['user', 'hello']], 'old1', null)
    expect(store.handoffs.lineage('f')).toEqual([])
    // The real chain is still read
    expect(store.handoffs.lineage('a')).toEqual(['old1', 'old0'])
  })

  it('shows the archived predecessor’s project from its trash record', async () => {
    const [hit] = (await orchestratorToolsFor(host, 'a', undefined, true).recall('marmalade')).hits
    expect(hit!.project).toBe('project p1')
    expect(store.handoffs.projectOf('old1')).toBe('p1')
    expect(store.handoffs.projectOf('nobody')).toBeNull()
  })

  it('keeps room for the lineage when live hits fill the limit, and lists the nearest predecessor first', async () => {
    // Twenty live sessions say the word, far enough apart in time for none to be dropped as the same story
    for (let i = 0; i < 20; i++) {
      put(`live${i}`, [['assistant', `a quokkaline ${i}`]])
      meta.set(`live${i}`, session(`live${i}`))
    }
    const hits = (await orchestratorToolsFor(host, 'a', undefined, true).recall('quokkaline', 12)).hits
    expect(hits).toHaveLength(12)
    const predecessors = hits.filter((h) => h.predecessor).map((h) => h.sessionId)
    // old0 is the only one of the chain that said it so far
    expect(predecessors).toEqual(['old0'])
    // The farther one's newest word has the higher seq; the nearer one says it too, at a lower seq. The nearer comes first
    store.messages.appendMessages([{ sessionId: 'old0', seq: 10, ts: 1_700_000_998_000, role: 'assistant', kind: 'text', payload: { text: 'quokkaline again, the farther one' } }])
    store.messages.appendMessages([{ sessionId: 'old1', seq: 4, ts: 1_700_000_999_000, role: 'assistant', kind: 'text', payload: { text: 'quokkaline from the nearer one' } }])
    const both = (await orchestratorToolsFor(host, 'a', undefined, true).recall('quokkaline', 12)).hits.filter((h) => h.predecessor).map((h) => h.sessionId)
    expect(both).toEqual(['old1', 'old0'])
    // A limit of one is a live hit's: the share is kept for a limit of two or more
    const one = (await orchestratorToolsFor(host, 'a', undefined, true).recall('quokkaline', 1)).hits
    expect(one.map((h) => h.predecessor ?? false)).toEqual([false])
  })

  it('a live session outside the lineage found by the same word is not marked as a predecessor', async () => {
    put('c', [['assistant', 'the marmalade of c']])
    meta.set('c', session('c'))
    const hits = (await orchestratorToolsFor(host, 'a', undefined, true).recall('marmalade')).hits
    expect(hits.map((h) => [h.sessionId, h.predecessor ?? false])).toEqual([['c', false], ['old1', true]])
  })
})
