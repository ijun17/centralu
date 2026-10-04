import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * A host restart under the keeper (#280 step 2), seen by the session manager: the leaving host lets
 * go of its sessions without stopping them, and the next host re-attaches to the same processes
 * and finds the sessions as they were.
 */

class FakeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  exitCode = null
  killed = false
  kills: string[] = []
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(signal)
    return true
  }
}

class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  disposed = false
  detached = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
  ) {
    if (opts.resumeExternalId) this.externalId = opts.resumeExternalId
  }
  send() {}
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    this.disposed = true
  }
  async detach() {
    // Output still on its way while the process is released is recorded by the leaving host
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: 'last words before the restart' })
    this.detached = true
  }
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  created: Handle[] = []
  listed = 0
  constructor(readonly tool: ToolName) {}
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions() {
    this.listed++
    return []
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

const processes: AgentProcessHost = { spawn: () => new FakeProcess() as unknown as AgentProcess }

let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  store = new Store()
  events = []
})

function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter('claude')
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, tmpdir(), { processes, keptSessions: kept })
  return { mgr, claude, rpc: createRpcHandler(mgr, adapters) }
}

async function workingSession(h: ReturnType<typeof host>): Promise<string> {
  const p = (await h.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await h.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  const handle = h.claude.last
  handle.emit({ type: 'state_change', sessionId: s.id, state: 'working' })
  // The orchestrator's tool was called and the host died before it answered
  handle.emit({ type: 'tool_call', sessionId: s.id, callId: 'call-lost', summary: { tool: 'mcp__centralu__list_sessions', title: 'list', readOnly: true, paths: [] } })
  handle.emit({ type: 'tool_call', sessionId: s.id, callId: 'call-done', summary: { tool: 'Bash', title: 'ls', readOnly: false, paths: [] } })
  handle.emit({ type: 'tool_result', sessionId: s.id, callId: 'call-done', ok: true, summary: 'a' })
  return s.id
}

describe('a host restart under the keeper', () => {
  it('the leaving host lets go of its sessions without stopping them and keeps their state', async () => {
    const a = host()
    const id = await workingSession(a)
    expect(a.claude.last.opts.processSource).toBeDefined()
    await a.mgr.detachAll()
    expect(a.claude.last.detached).toBe(true)
    expect(a.claude.last.disposed).toBe(false)
    expect(store.listSessions().find((s) => s.id === id)!.state).toBe('working')
    const texts = store.loadMessages(id, 50).map((r) => JSON.stringify(r.payload))
    expect(texts.some((t) => t.includes('last words before the restart'))).toBe(true)
  })

  it('the next host re-attaches the kept process and the session stays live and working', async () => {
    const a = host()
    const id = await workingSession(a)
    await a.mgr.detachAll()

    const b = host(new Set([id]))
    expect(b.mgr.listSessions().find((s) => s.id === id)!.state).toBe('working')
    const kept = new FakeProcess() as unknown as AgentProcess
    await b.mgr.adoptKept([{ sessionId: id, tool: 'claude', process: kept }])
    const handle = b.claude.last
    expect(handle.opts.processSource?.adopt?.process).toBe(kept)
    expect(handle.opts.resumeExternalId).toBe('ext-1')
    // Only the call without a result is handed on: the adapter knows which of those died with the old host
    expect(handle.opts.processSource?.adopt?.openCalls).toEqual([{ callId: 'call-lost', tool: 'mcp__centralu__list_sessions' }])
    const s = b.mgr.listSessions().find((x) => x.id === id)!
    expect(s.live).toBe(true)
    expect(s.state).toBe('working')
    expect(events.some((e) => e.type === 'state_change' && e.sessionId === id && e.reason === 'reattached')).toBe(true)
    // A running process proves its conversation exists: the tool is not asked
    expect(b.claude.listed).toBe(0)
  })

  /** Without the keeper's list the startup reset turns the running session idle — today's rule for a host with no keeper */
  it('a session with no kept process is still reset to idle at startup', async () => {
    const a = host()
    const id = await workingSession(a)
    await a.mgr.detachAll()
    const b = host()
    expect(b.mgr.listSessions().find((s) => s.id === id)!.state).toBe('idle')
  })

  it('a kept process whose session is gone is stopped — nobody could address it', async () => {
    const b = host()
    const kept = new FakeProcess()
    await b.mgr.adoptKept([{ sessionId: 'deleted', tool: 'claude', process: kept as unknown as AgentProcess }])
    expect(kept.kills).toEqual(['SIGTERM'])
    expect(b.claude.created).toHaveLength(0)
  })
})
