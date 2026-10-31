import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { START_AGENT_SETUP_MS } from './start-agent-terms.js'
import { MemoryGate } from './memory-gate.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * A start_agent card the person has not answered outlives the call and the host (#673): the leaving host keeps the
 * request in the store's `agent_start_requests`, the next one raises the card again, and an approval there starts the
 * child with its report armed. A card hidden by the caller's own turn comes back when that turn ends.
 */

class FakeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  exitCode = null
  killed = false
  kill() {
    return true
  }
}

class Handle implements SessionHandle {
  externalId: string | null
  sent: string[] = []
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.externalId = opts.resumeExternalId ?? `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  /** The turn ends with this as its final text */
  answer(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
  /** Set by a test: the turn ends while the leaving host lets the process go */
  endOnDetach?: string
  async detach() {
    if (this.endOnDetach) this.answer(this.endOnDetach)
  }
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  handles = new Map<string, Handle>()
  readonly tool: ToolName = 'claude'
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit)
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-agent-start-')))
  events = []
})
afterEach(async () => {
  vi.useRealTimers()
  for (const mgr of hosts.splice(0)) await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'), { processes, keptSessions: kept })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, claude }
}

const card = (mgr: SessionManager, id: string) => {
  const p = mgr.listSessions().find((s) => s.id === id)?.pendingApproval
  return p?.detail.kind === 'agent_start' ? p : undefined
}
const children = (mgr: SessionManager, id: string) => mgr.listSessions().filter((s) => s.askedBy === id)

/** A `safe` session (which still asks in a trusted project) whose start_agent card stands */
async function asking(h: ReturnType<typeof host>) {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'safe' })).id
  const call = h.mgr.startAgent(parent, { task: 'long work', wait: false })
  await eventually(() => !!card(h.mgr, parent))
  return { parent, call, requestId: card(h.mgr, parent)!.requestId }
}

describe('a start_agent card nobody has answered yet (#673)', () => {
  it('is kept in the store while it stands, and gone once answered', async () => {
    const a = host()
    const { parent, call, requestId } = await asking(a)
    expect(store.children.listAgentStartRequests()).toEqual([expect.objectContaining({ requestId, callerSessionId: parent })])
    a.mgr.respondApproval(parent, requestId, 'allow')
    expect(await call).toMatchObject({ ok: true, state: 'working' })
    expect(store.children.listAgentStartRequests()).toEqual([])
  })

  it('outlives a host swap: the call answers "pending", the next host raises the card, and its approval starts the child with the report', async () => {
    const a = host()
    const { parent, call, requestId } = await asking(a)
    await a.mgr.detachAll()
    // Letting go is not the person's answer: the call says the request is still waiting, and nothing ended it
    expect(await call).toMatchObject({ ok: true, state: 'pending', sessionId: requestId })
    expect(store.children.listAgentStartRequests()).toEqual([expect.objectContaining({ requestId })])
    expect(store.messages.loadMessages(parent, 20).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('No agent was started'))).toEqual([])

    const b = host()
    expect(card(b.mgr, parent)?.requestId).toBe(requestId)
    // The conversation already has the card: raised again for the windows, it is not recorded a second time
    const raised = events.filter((e) => e.type === 'approval_request' && e.sessionId === parent)
    expect(raised).toHaveLength(2)
    expect(raised.map((e) => (e as { seq?: number }).seq != null)).toEqual([true, false])
    expect(await b.mgr.agentSession(parent, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: true, state: 'pending' })
    b.mgr.respondApproval(parent, requestId, 'allow')
    await eventually(() => children(b.mgr, parent).length === 1)
    const child = children(b.mgr, parent)[0]!.id
    await eventually(() => store.children.listReportMarks().length === 1)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])
    expect(store.children.listAgentStartRequests()).toEqual([])
    expect(b.claude.handles.get(child)!.sent[0]).toContain('long work')
  })

  it('a refusal under the next host is told to the caller as a message', async () => {
    const a = host()
    const { parent, requestId } = await asking(a)
    await a.mgr.detachAll()
    const b = host()
    b.mgr.respondApproval(parent, requestId, 'deny')
    await eventually(() => !!b.claude.handles.get(parent)?.sent.some((t) => t.includes(`start_agent request ${requestId} did not start a session`)))
    expect(children(b.mgr, parent)).toEqual([])
    expect(store.children.listAgentStartRequests()).toEqual([])
  })

  it('is dropped by the next host when the session that asked is gone', async () => {
    const a = host()
    const { parent, requestId } = await asking(a)
    await a.mgr.detachAll()
    // Another build trashed it meanwhile; the row this one left is all that remains
    store.children.putAgentStartRequest(requestId, 'no-such-session', { ...store.children.listAgentStartRequests()[0]!.request as object, callerId: 'no-such-session' })
    host()
    expect(store.children.listAgentStartRequests()).toEqual([])
    expect(card(hosts[1]!, parent)).toBeUndefined()
  })

  it('hidden by the caller\'s own turn after the call answered "pending", comes back when that turn ends', async () => {
    const a = host()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const project = await a.mgr.addProject(root)
    a.mgr.setProjectTrusted(project.id, true)
    const parent = (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'safe' })).id
    await a.mgr.send(parent, 'do the work, with a helper')
    const call = a.mgr.startAgent(parent, { task: 'long work', wait: false })
    for (let i = 0; i < 50 && !card(a.mgr, parent); i++) await vi.advanceTimersByTimeAsync(0)
    const requestId = card(a.mgr, parent)!.requestId
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
    expect(await call).toMatchObject({ ok: true, state: 'pending' })
    vi.useRealTimers()
    // The turn goes on: its next event clears the slot
    const h = a.claude.handles.get(parent)!
    h.send('next step')
    expect(card(a.mgr, parent)).toBeUndefined()
    h.answer('carried on alone for now')
    await eventually(() => card(a.mgr, parent)?.requestId === requestId)
    expect(a.mgr.listSessions().find((s) => s.id === parent)!.state).toBe('waiting_approval')
    a.mgr.respondApproval(parent, requestId, 'allow')
    await eventually(() => children(a.mgr, parent).length === 1)
    // No call waits on that card: the session goes back to where its turn left it, not to a "working" nothing ends
    expect(a.mgr.listSessions().find((s) => s.id === parent)!.state).toBe('waiting_input')
    expect(events.filter((e) => e.type === 'state_change' && e.sessionId === parent).at(-1)).toMatchObject({ state: 'waiting_input' })
  })

  it('withdrawn while raised between turns, the session goes back to its rest too', async () => {
    const a = host()
    const { parent, requestId } = await asking(a)
    await a.mgr.detachAll()
    const b = host()
    expect(b.mgr.listSessions().find((s) => s.id === parent)!.state).toBe('waiting_approval')
    expect(await b.mgr.agentSession(parent, { sessionId: requestId, action: 'stop' })).toMatchObject({ ok: true, state: 'stopped' })
    expect(card(b.mgr, parent)).toBeUndefined()
    expect(b.mgr.listSessions().find((s) => s.id === parent)!.state).toBe('idle')
  })
})

describe('a start allowed but waiting for memory (#686)', () => {
  it('outlives a host swap without a second card, and the next host starts it when memory recovers', async () => {
    let free = 512 * 1024 ** 2
    const gate = () => new MemoryGate({ read: async () => free, recheckMs: 20 })
    const a = host()
    a.mgr.useMemoryGate(gate())
    const { parent, call, requestId } = await asking(a)
    a.mgr.respondApproval(parent, requestId, 'allow')
    // Allowed on the card, then queued: the same handle, now waiting for memory
    expect(await call).toMatchObject({ ok: true, state: 'pending', sessionId: requestId, lowMemory: { floor: '2.0 GB' } })
    expect(store.children.listAgentStartRequests()).toEqual([expect.objectContaining({ requestId, request: expect.objectContaining({ allowed: true }) })])
    await a.mgr.detachAll()
    // Letting go ends the wait without starting anything, and keeps the request for the next host
    expect(children(a.mgr, parent)).toEqual([])
    expect(store.children.listAgentStartRequests()).toHaveLength(1)

    const b = host()
    b.mgr.useMemoryGate(gate())
    await new Promise((r) => setTimeout(r, 100))
    // The person already answered: no card again, and nothing starts while memory is short
    expect(card(b.mgr, parent)).toBeUndefined()
    expect(children(b.mgr, parent)).toEqual([])
    expect(await b.mgr.agentSession(parent, { sessionId: requestId, action: 'status' })).toMatchObject({ state: 'pending', lowMemory: { available: '512 MB', floor: '2.0 GB' } })
    free = 4 * 1024 ** 3
    await eventually(() => children(b.mgr, parent).length === 1)
    const child = children(b.mgr, parent)[0]!.id
    await eventually(() => store.children.listReportMarks().length === 1)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])
    expect(store.children.listAgentStartRequests()).toEqual([])
    expect(b.claude.handles.get(child)!.sent[0]).toContain('long work')
  })
})
