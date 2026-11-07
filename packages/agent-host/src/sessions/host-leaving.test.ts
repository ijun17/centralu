import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'

/**
 * A host leaving while a process comes up or a turn ends (#839, item 7). Quitting (`disposeAll`) stops the processes it
 * holds, and a handle that arrives after that sweep is nobody's. A wake or a new session that came up then was
 * registered all the same and never stopped, and a deferred restart at a turn's end while the host left started a
 * process nobody would stop.
 */

class Handle implements SessionHandle {
  externalId: string | null
  disposed = false
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
  mgr = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', claude], ['claude-two' as ToolName, other]]), (e) => events.push(e), undefined, tmpdir())
  projectId = (await mgr.projectCreation.addProject(tmpdir())).id
})
afterEach(async () => {
  await mgr.tenure.disposeAll()
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
/** Starts the host quitting and holds it while its sweep stops a live session's process. The returned function lets it finish */
const leaveHeld = (live: Handle) => {
  let release!: () => void
  live.disposeGate = new Promise<void>((r) => (release = r))
  const leaving = mgr.tenure.disposeAll()
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
  it('a wake whose process comes up during a quit stops it, and does not register it', async () => {
    const id = await asleep()
    await session()
    const live = claude.last
    const release = holdNextStart()
    const waking = mgr.processes.resumeSession(id)
    const left = leaveHeld(live)
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

  it('a new session whose process comes up during a quit stops it, and is not created', async () => {
    const live = await session()
    const release = holdNextStart()
    const creating = mgr.createSession({ projectId, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })
    void creating.catch(() => {})
    const left = leaveHeld(claude.last)
    release()
    await expect(creating).rejects.toThrow(/restarting or quitting/)
    await left()
    expect(claude.created).toHaveLength(2)
    expect(claude.last.disposed).toBe(true)
    expect(store.sessions.listSessions().map((s) => s.id)).toEqual([live])
  })

  it('a turn that ends during a quit does not apply a deferred restart', async () => {
    const id = await session()
    const live = claude.last
    await mgr.inputs.send(id, 'work')
    // A model change mid-turn waits for the turn's end (#164)
    await mgr.updateSettings(id, { model: 'other' })
    const left = leaveHeld(live)
    // The turn ends while the host is stopping the process
    live.emit({ type: 'turn_complete', sessionId: id })
    await left()
    await new Promise((r) => setImmediate(r))
    expect(claude.created).toHaveLength(1)
  })

  it.each([
    ['a restart (the settings, a proposal)', (id: string) => mgr.processes.restartSession(id)],
    ['a tool switch', (id: string) => mgr.processes.switchTool(id, 'claude-two' as ToolName)],
  ] as const)('%s asked during a quit is refused, and starts no process', async (_, act) => {
    const id = await session()
    const live = claude.last
    const left = leaveHeld(live)
    await expect(act(id)).rejects.toThrow(/restarting or quitting/)
    await left()
    expect(live.disposed).toBe(true)
    expect(claude.created).toHaveLength(1)
  })

})
