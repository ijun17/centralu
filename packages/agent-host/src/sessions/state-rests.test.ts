/**
 * The host's copy of a session's state at the edges of a turn (#428): what arrives after a turn ended, and a card
 * raised while no turn ran, must leave the session at rest, where the keeper, an update and sleep read it as idle and
 * the next start does not take it for a turn a quit stopped.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, Question, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, OrchestratorTools, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { hostBusy } from '../idle.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { FakeProcess } from './kept-host.test-helpers.js'
import { ASK_WINDOW_MS, CARD_RESTS_KEY } from './card-rest.js'
import { runOrchestratorTool } from './orchestrator-tools.js'

const QUESTION: Question[] = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }] }]

class Handle implements SessionHandle {
  externalId: string
  /** A background agent's card still open: closing the process releases it, as claude's `releaseAgents` does */
  backgroundCall: string | null = null
  /** A tool that does not announce its turn: the first thing it says is a card */
  quiet = false
  constructor(
    readonly sessionId: string,
    readonly emit: EventSink,
    readonly opts: CreateSessionOpts,
  ) {
    this.externalId = `ext-${sessionId}`
  }
  ev(e: Record<string, unknown> & { type: NormalizedEvent['type'] }) {
    this.emit({ sessionId: this.sessionId, ...e } as NormalizedEvent)
  }
  send() {
    if (!this.quiet) this.ev({ type: 'state_change', state: 'working' })
  }
  turn() {
    this.ev({ type: 'message_delta', role: 'assistant', text: 'done' })
    this.ev({ type: 'turn_complete' })
  }
  respondApproval(requestId: string) {
    this.ev({ type: 'approval_resolved', requestId, decision: 'allow' })
    return true
  }
  answerQuestion(requestId: string) {
    this.ev({ type: 'question_resolved', requestId })
    return true
  }
  interrupt() {}
  async detach() {}
  async dispose() {
    if (this.backgroundCall) this.ev({ type: 'tool_result', callId: this.backgroundCall, ok: false, summary: 'The session closed before this agent reported back' })
  }
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true,
  }
  handles = new Map<string, Handle>()
  readonly tool: ToolName = 'claude'
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, emit, opts)
    this.handles.set(opts.sessionId, h)
    return h
  }
}

const processes: AgentProcessHost = { spawn: () => new FakeProcess() as unknown as AgentProcess }

let store: Store
let root: string
let events: NormalizedEvent[]
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-state-rests-')))
  events = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const mgr of hosts.splice(0)) await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter()
  const mgr = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', claude]]), (e) => events.push(e), undefined, join(root, 'worktrees'), { processes, keptSessions: kept })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, claude }
}

async function session() {
  const a = host()
  const project = await a.mgr.addProject(root)
  const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
  const h = a.claude.handles.get(s.id)!
  const info = () => a.mgr.listSessions().find((x) => x.id === s.id)!
  const busy = () => hostBusy({ sessions: a.mgr.listSessions(), terminals: 0, commandRuns: 0 })
  return { ...a, s, h, info, busy }
}

describe('a session at rest stays at rest (#428)', () => {
  it('a tool result after the turn ended does not start one: idle to the keeper, an update and sleep', async () => {
    const { mgr, s, h, info, busy } = await session()
    h.turn()
    h.ev({ type: 'tool_result', callId: 'late', ok: false, summary: 'released' })
    expect(info().state).toBe('waiting_input')
    expect(busy()).toBe(false)
    expect(mgr.sessionIdle(s.id)).toEqual({ idle: true })
  })

  it('closing a process between turns with a background agent open leaves no "stopped by quit" for the next start', async () => {
    const a = await session()
    a.h.turn()
    a.h.backgroundCall = 'toolu_bg'
    await a.mgr.disposeAll()
    expect(store.sessions.listSessions().find((x) => x.id === a.s.id)?.state).toBe('waiting_input')

    const b = host()
    const after = b.mgr.listSessions().find((x) => x.id === a.s.id)!
    expect(after.state).toBe('waiting_input')
    expect(after.interruption ?? null).toBeNull()
  })

  it('a question answered while no turn ran goes back to the rest it was raised in, not to working', async () => {
    const { mgr, s, h, info, busy } = await session()
    h.turn()
    h.ev({ type: 'question_request', requestId: 'q1', questions: QUESTION })
    expect(info()).toMatchObject({ state: 'waiting_approval', pendingQuestions: [{ requestId: 'q1' }] })
    mgr.answerQuestion(s.id, 'q1', [{ question: 'Which?', answers: ['A'] }])
    expect(info()).toMatchObject({ state: 'waiting_input', pendingQuestions: [] })
    expect(events.at(-1)).toMatchObject({ type: 'state_change', sessionId: s.id, state: 'waiting_input' })
    expect(busy()).toBe(false)
  })

  it('so does an adapter approval raised between turns', async () => {
    const { mgr, s, h, info } = await session()
    h.turn()
    h.ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    mgr.respondApproval(s.id, 'r1', 'allow')
    expect(info()).toMatchObject({ state: 'waiting_input', pendingApproval: null })
  })

  it('inside a turn, an answered card goes back to work as before', async () => {
    const { mgr, s, h, info } = await session()
    h.send()
    h.ev({ type: 'question_request', requestId: 'q1', questions: QUESTION })
    mgr.answerQuestion(s.id, 'q1', [{ question: 'Which?', answers: ['A'] }])
    expect(info().state).toBe('working')
    // A turn that started while the card was open owns the session too: no rest is restored under it
    h.turn()
    h.ev({ type: 'question_request', requestId: 'q2', questions: QUESTION })
    h.ev({ type: 'message_delta', role: 'assistant', text: 'a new turn' })
    h.ev({ type: 'question_request', requestId: 'q3', questions: QUESTION })
    mgr.answerQuestion(s.id, 'q2', [{ question: 'Which?', answers: ['A'] }])
    mgr.answerQuestion(s.id, 'q3', [{ question: 'Which?', answers: ['A'] }])
    expect(info().state).toBe('working')
  })

  it('a card that comes first after input belongs to that turn, though the tool never said it began', async () => {
    const { mgr, s, h, info } = await session()
    h.turn()
    h.quiet = true
    await mgr.send(s.id, 'please approve')
    h.ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    mgr.respondApproval(s.id, 'r1', 'allow')
    // Its answer comes next: the session is still in that turn, not back at rest
    expect(info().state).toBe('working')
  })

  it('input the tool never took stops standing for a turn after a while', async () => {
    const { mgr, s, h, info } = await session()
    h.turn()
    h.quiet = true
    await mgr.send(s.id, 'a message the tool never acts on')
    // Long after, still no word from the tool: a card now is one between turns
    const later = Date.now() + ASK_WINDOW_MS + 1
    vi.spyOn(Date, 'now').mockReturnValue(later)
    h.ev({ type: 'question_request', requestId: 'q1', questions: QUESTION })
    mgr.answerQuestion(s.id, 'q1', [{ question: 'Which?', answers: ['A'] }])
    expect(info().state).toBe('waiting_input')
  })

  it('a state the host sets itself ends an asked-for turn the tool never spoke for', async () => {
    const { mgr, claude, s, h, info } = await session()
    h.turn()
    h.quiet = true
    await mgr.send(s.id, 'a message the tool never acts on')
    // A restart resumes the session at rest (`settleState`): the input before it is not a turn any more
    await mgr.restartSession(s.id)
    expect(info().state).toBe('idle')
    const fresh = claude.handles.get(s.id)!
    expect(fresh).not.toBe(h)
    fresh.ev({ type: 'question_request', requestId: 'q1', questions: QUESTION })
    mgr.answerQuestion(s.id, 'q1', [{ question: 'Which?', answers: ['A'] }])
    expect(info().state).toBe('idle')
  })

  it('a card standing over a host swap still closes back into its rest under the next host', async () => {
    const a = await session()
    a.h.turn()
    a.h.ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    await a.mgr.detachAll()

    // The keeper kept the process: the next host adopts it, still waiting_approval, and the tool raises the card again
    const b = host(new Set([a.s.id]))
    await b.mgr.adoptKept([{ sessionId: a.s.id, tool: 'claude', process: new FakeProcess() as unknown as AgentProcess }])
    const adopted = b.claude.handles.get(a.s.id)!
    adopted.ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    b.mgr.respondApproval(a.s.id, 'r1', 'allow')
    expect(b.mgr.listSessions().find((x) => x.id === a.s.id)?.state).toBe('waiting_input')
    expect(b.mgr.sessionIdle(a.s.id)).toEqual({ idle: true })
    expect(store.settings.appSetting(CARD_RESTS_KEY)).toBeNull()
  })

  it('a rest left for a process nobody adopted is dropped, and so is a deleted session\'s', async () => {
    const a = await session()
    a.h.turn()
    a.h.ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    expect(JSON.parse(store.settings.appSetting(CARD_RESTS_KEY)!)).toEqual({ [a.s.id]: 'waiting_input' })
    await a.mgr.trashSession(a.s.id)
    expect(store.settings.appSetting(CARD_RESTS_KEY)).toBeNull()

    const c = await session()
    c.h.turn()
    c.h.ev({ type: 'approval_request', requestId: 'r2', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    await c.mgr.detachAll()
    // Not kept: the process is gone with its card, and the next start forgets the rest
    host()
    expect(store.settings.appSetting(CARD_RESTS_KEY)).toBeNull()
  })

  it('a limit report does not take a session off the card it waits on', async () => {
    const { h, info } = await session()
    h.send()
    h.ev({ type: 'question_request', requestId: 'q1', questions: QUESTION })
    const since = info().waitingSince
    h.ev({ type: 'limit_reached', usedPercent: 100 })
    expect(info()).toMatchObject({ state: 'waiting_approval', waitingSince: since, limit: { usedPercent: 100 } })
    expect(since).not.toBeNull()
  })

  it('an agent reading the list is told the card is a question, not an approval', async () => {
    const { mgr, claude, h } = await session()
    const orch = await mgr.createSession({ projectId: null, cwd: root, tool: 'claude', permissionPreset: 'normal', kind: 'orchestrator' })
    const tools = claude.handles.get(orch.id)!.opts.orchestratorTools!
    h.send()
    h.ev({ type: 'question_request', requestId: 'q1', questions: QUESTION })
    expect((await tools.listSessions()).find((r) => r.sessionId === h.sessionId)).toMatchObject({ state: 'waiting_approval', waitingOn: 'question' })
    h.ev({ type: 'approval_request', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    expect((await tools.listSessions()).find((r) => r.sessionId === h.sessionId)?.waitingOn).toBeUndefined()
  })

  it('list_sessions prints an open question as one', async () => {
    const row = { sessionId: 'w1', name: 'Worker', project: 'p', state: 'waiting_approval', waitingOn: 'question' as const, tool: 'claude', preview: '' }
    const tools = { listSessions: async () => [row] } as unknown as OrchestratorTools
    const { text } = await runOrchestratorTool(tools, 'list_sessions', {}, { sessionId: 'o', profile: 'orchestrator' } as Parameters<typeof runOrchestratorTool>[3])
    expect(text).toContain('· claude · waiting on a question')
    expect(text).not.toContain('waiting_approval')
  })

  it('logs a transition it ignores, as the window does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { h, info } = await session()
    h.ev({ type: 'turn_complete' })
    expect(info().state).toBe('idle')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored turn_complete'))
  })
})
