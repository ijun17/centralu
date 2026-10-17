import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * A host leaving while a process comes up or a turn ends (#839, item 7). Quitting (`disposeAll`) stops the processes it
 * holds, and handing over (`detachAll`) lets go of them for the next host; either way a handle that arrives after that
 * sweep is nobody's. A wake or a new session that came up then was registered all the same and never stopped; a
 * deferred restart at a turn's end during a handover stopped the process the keeper was keeping and started one nobody
 * kept; and a kept process offered while a wake was already under way was never used and never stopped.
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
  externalId: string | null
  disposed = false
  detached = false
  sent: string[] = []
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
  ) {
    this.externalId = `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  /** A test holds a quit's sweep here, so a start lands while it runs */
  disposeGate: Promise<void> = Promise.resolve()
  async dispose() {
    await this.disposeGate
    this.disposed = true
  }
  /** A test holds the release here to put a turn's end inside the handover */
  detachGate: Promise<void> = Promise.resolve()
  async detach() {
    await this.detachGate
    this.detached = true
  }
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  readonly tool: ToolName = 'claude'
  created: Handle[] = []
  /** Set by a test: the next process comes up only when it is released */
  gate: Promise<void> | null = null
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions() {
    return this.created.map((h) => ({ externalId: `ext-${h.sessionId}`, title: 'A conversation', updatedAt: Date.now() }))
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const gate = this.gate
    if (gate) await gate
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
let claude: Adapter
let mgr: SessionManager
let projectId: string

beforeEach(async () => {
  store = new Store()
  events = []
  claude = new Adapter()
  const other = Object.assign(new Adapter(), { tool: 'claude-two' as ToolName })
  mgr = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', claude], ['claude-two' as ToolName, other]]), (e) => events.push(e), undefined, tmpdir(), { processes })
  projectId = (await mgr.addProject(tmpdir())).id
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
})

/** Holds the adapter's next start until the returned function is called */
const holdNextStart = () => {
  let release!: () => void
  claude.gate = new Promise<void>((r) => (release = r))
  return () => {
    claude.gate = null
    release()
  }
}
const session = async () => (await mgr.createSession({ projectId, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })).id
/**
 * Starts the host leaving and holds it while it lets go of a live session's process: a quit's sweep, or a handover.
 * The returned function lets it finish.
 */
const leaveHeld = (live: Handle, leave: 'disposeAll' | 'detachAll') => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  live.disposeGate = gate
  live.detachGate = gate
  const leaving = mgr[leave]()
  return async () => {
    release()
    await leaving
  }
}
/** A session whose process went away, to be woken */
const asleep = async () => {
  const id = await session()
  claude.last.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'Ready.' })
  claude.last.emit({ type: 'error', sessionId: id, error: { code: 'adapter_crashed', message: 'the process exited', retryable: true } })
  return id
}

describe('a host leaving (#839)', () => {
  it.each(['disposeAll', 'detachAll'] as const)('a wake whose process comes up during %s stops it, and does not register it', async (leave) => {
    const id = await asleep()
    await session()
    const live = claude.last
    const release = holdNextStart()
    const waking = mgr.resumeSession(id)
    const left = leaveHeld(live, leave)
    release()
    const r = await waking
    await left()
    expect(r).toMatchObject({ resumed: false, reason: 'Centralu is restarting or quitting' })
    // The process the wake brought up, after the one that went away and the live one
    expect(claude.created).toHaveLength(3)
    expect(claude.last.sessionId).toBe(id)
    expect(claude.last.disposed).toBe(true)
    expect(mgr.listSessions().find((s) => s.id === id)?.live).toBe(false)
  })

  it.each(['disposeAll', 'detachAll'] as const)('a new session whose process comes up during %s stops it, and is not created', async (leave) => {
    const live = await session()
    const release = holdNextStart()
    const creating = mgr.createSession({ projectId, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })
    void creating.catch(() => {})
    const left = leaveHeld(claude.last, leave)
    release()
    await expect(creating).rejects.toThrow(/restarting or quitting/)
    await left()
    expect(claude.created).toHaveLength(2)
    expect(claude.last.disposed).toBe(true)
    expect(store.sessions.listSessions().map((s) => s.id)).toEqual([live])
  })

  it('a turn that ends during a handover does not apply a deferred restart', async () => {
    const id = await session()
    const kept = claude.last
    await mgr.send(id, 'work')
    // A model change mid-turn waits for the turn's end (#164)
    await mgr.updateSettings(id, { model: 'other' })
    let release!: () => void
    kept.detachGate = new Promise<void>((r) => (release = r))
    const leaving = mgr.detachAll()
    // The turn ends while the host is letting go of the process
    kept.emit({ type: 'turn_complete', sessionId: id })
    release()
    await leaving
    await new Promise((r) => setImmediate(r))
    expect(kept.disposed).toBe(false)
    expect(claude.created).toHaveLength(1)
  })

  it('a kept process offered while a wake is under way is stopped, not left running beside it', async () => {
    const id = await asleep()
    const release = holdNextStart()
    const waking = mgr.resumeSession(id)
    const kept = new FakeProcess()
    const adopting = mgr.adoptKept([{ sessionId: id, tool: 'claude', process: kept as unknown as AgentProcess }])
    release()
    await Promise.all([waking, adopting])
    expect(kept.kills).toEqual(['SIGTERM'])
    expect(claude.created.filter((h) => h.opts.processSource?.adopt)).toEqual([])
  })

  it('a kept process offered for a session already live is stopped', async () => {
    const id = await session()
    const kept = new FakeProcess()
    await mgr.adoptKept([{ sessionId: id, tool: 'claude', process: kept as unknown as AgentProcess }])
    expect(kept.kills).toEqual(['SIGTERM'])
    expect(claude.created).toHaveLength(1)
  })

  it.each([
    ['a restart (the settings, a proposal)', (id: string) => mgr.restartSession(id)],
    ['a tool switch', (id: string) => mgr.switchTool(id, 'claude-two' as ToolName)],
  ] as const)('%s asked during a handover is refused, and leaves the kept process alone', async (_, act) => {
    const id = await session()
    const kept = claude.last
    const left = leaveHeld(kept, 'detachAll')
    await expect(act(id)).rejects.toThrow(/restarting or quitting/)
    expect(kept.disposed).toBe(false)
    expect(claude.created).toHaveLength(1)
    await left()
    expect(kept.detached).toBe(true)
  })

})
