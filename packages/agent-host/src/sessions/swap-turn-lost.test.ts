import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * A swap while a session's turn runs, on a tool whose adapter cannot take a running turn over (ACP: it ends the kept
 * process and opens the conversation again in a new one, #1562 review). The turn is over, and the session must say so
 * as a quit does: idle, with the quit mark and its line, not `working` forever with a Stop that does nothing.
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
  externalId: string | null = 'ext-1'
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    readonly takesOverTurn: boolean | undefined,
  ) {}
  send() {}
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {}
  async detach() {}
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  constructor(private readonly takesOverTurn: boolean | undefined) {}
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions(): Promise<ExternalSessionSummary[]> {
    return [{ externalId: 'ext-1', title: 'x', updatedAt: Date.now() }]
  }
  launchSettingsFingerprint() {
    return 'v1'
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit, this.takesOverTurn)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

const processes: AgentProcessHost = { spawn: () => new FakeProcess() }

let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  store = new Store()
  events = []
})

function host(takesOverTurn: boolean | undefined, kept: ReadonlySet<string> = new Set()) {
  const adapter = new Adapter(takesOverTurn)
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, tmpdir(), { processes, keptSessions: kept })
  const session = (id: string) => mgr.listSessions().find((s) => s.id === id)!
  return { mgr, adapter, session, rpc: createRpcHandler(mgr, adapters) }
}

/** A session mid-turn on the first host, which then leaves for a swap; the next host adopts its process */
async function swapMidTurn(takesOverTurn: boolean | undefined, hubGave = false) {
  const a = host(takesOverTurn)
  const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  a.adapter.last.emit({ type: 'state_change', sessionId: s.id, state: 'working' })
  // A hub gave it a note for the turn to come, and the turn it was in began after row 1 (#1604)
  if (hubGave) {
    store.settings.setAppSetting(`input_origins:${s.id}`, JSON.stringify([['note-1', { seq: 2, from: { sessionId: '_hub-orchestrator', name: 'Parent' } }]]))
    store.settings.setAppSetting(`turn_span:${s.id}`, JSON.stringify({ latest: { since: 1 } }))
  }
  await a.mgr.detachAll()
  const b = host(takesOverTurn, new Set([s.id]))
  await b.mgr.adoptKept([{ sessionId: s.id, tool: 'claude', process: new FakeProcess() }])
  return { b, id: s.id }
}

describe('a swap mid-turn (#1562 review)', () => {
  it('ends the turn as a quit does when the adapter reopened the conversation instead of taking the turn over', async () => {
    const { b, id } = await swapMidTurn(false)
    expect(b.session(id)).toMatchObject({ state: 'idle', live: true, interruption: { reason: 'quit' } })
    expect(events.some((e) => e.type === 'notice' && e.sessionId === id && /Centralu quit or restarted/.test(e.text))).toBe(true)
  })

  it('closes the turn a hub follows and takes off what it was given: the process that held them is gone', async () => {
    const { id } = await swapMidTurn(false, true)
    expect(store.settings.appSetting(`input_origins:${id}`)).toBeNull()
    expect(JSON.parse(store.settings.appSetting(`turn_span:${id}`)!)).toEqual({ latest: { since: 1, ended: true } })
  })

  it('keeps both for an adapter that took the process over as it was: the turn goes on', async () => {
    const { id } = await swapMidTurn(undefined, true)
    expect(store.settings.appSetting(`input_origins:${id}`)).not.toBeNull()
    expect(JSON.parse(store.settings.appSetting(`turn_span:${id}`)!)).toEqual({ latest: { since: 1 } })
  })

  it('keeps the turn running for an adapter that took the process over as it was', async () => {
    const { b, id } = await swapMidTurn(undefined)
    expect(b.session(id).state).toBe('working')
    expect(b.session(id).interruption ?? null).toBeNull()
  })
})
