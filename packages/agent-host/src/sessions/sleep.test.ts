import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import type { SessionIdle } from '../idle.js'
import { createRpcHandler } from '../rpc.js'
import { ClaudeStreamNormalizer } from '../adapters/claude/normalize.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { SessionManager } from './manager.js'
import {
  DEFAULT_SLEEP_AFTER_MINUTES,
  parseSleepSetting,
  SessionSleeper,
  sleepDecision,
  sleepOverrideFrom,
  storedSleepSetting,
  type SleepSessions,
} from './sleep.js'

/**
 * Putting idle sessions to sleep (#568): a session quiet for the set time, holding nothing a person would lose, has
 * its process ended; the next message resumes it through `resumeSession`, as after a host restart.
 */

const IDLE: SessionIdle = { idle: true }
const MIN = 60_000

describe('the rule, as data', () => {
  const base = { live: true, supported: true, idle: IDLE, waitsOn: 0, quietFor: 15 * MIN, afterMs: 15 * MIN }

  it('sleeps a live, idle session of a tool that may sleep, once it has been quiet for the set time', () => {
    expect(sleepDecision(base)).toEqual({ sleep: true })
    expect(sleepDecision({ ...base, quietFor: 15 * MIN - 1 })).toEqual({ sleep: false, why: 'recent' })
  })

  it('keeps awake what a person would lose, and what is about to be answered', () => {
    for (const reason of ['turn', 'approval', 'question', 'background', 'background_unknown'] as const) {
      expect(sleepDecision({ ...base, idle: { idle: false, reason } })).toEqual({ sleep: false, why: reason })
    }
    expect(sleepDecision({ ...base, waitsOn: 1 })).toEqual({ sleep: false, why: 'waits_on' })
  })

  it('never with the setting off, a tool that may not sleep, or a session already asleep', () => {
    expect(sleepDecision({ ...base, afterMs: null })).toEqual({ sleep: false, why: 'off' })
    expect(sleepDecision({ ...base, supported: false })).toEqual({ sleep: false, why: 'unsupported' })
    expect(sleepDecision({ ...base, live: false })).toEqual({ sleep: false, why: 'not_live' })
  })

  it('reads the stored setting: 15 minutes by default, `off` never, anything unreadable the default', () => {
    expect(parseSleepSetting(null)).toBe(DEFAULT_SLEEP_AFTER_MINUTES)
    expect(DEFAULT_SLEEP_AFTER_MINUTES).toBe(15)
    expect(parseSleepSetting('off')).toBeNull()
    expect(parseSleepSetting('30')).toBe(30)
    for (const bad of ['', '0', '-5', '1.5', 'soon']) expect(parseSleepSetting(bad)).toBe(15)
    for (const m of [5, 60, null]) expect(parseSleepSetting(storedSleepSetting(m))).toBe(m)
    expect(sleepOverrideFrom('2000')).toBe(2000)
    for (const bad of [undefined, '', '0', 'x']) expect(sleepOverrideFrom(bad)).toBeNull()
  })
})

/** Sessions as the sleeper reads them, each settable */
function fakeSessions() {
  const rows = new Map<string, { s: SessionInfo; idle: SessionIdle; waitsOn: string[] }>()
  const slept: string[] = []
  const sessions: SleepSessions = {
    listSessions: () => [...rows.values()].map((r) => r.s),
    sessionIdle: (id) => rows.get(id)!.idle,
    waitsOn: (id) => rows.get(id)!.waitsOn,
    sleepSession: async (id) => {
      slept.push(id)
      rows.get(id)!.s = { ...rows.get(id)!.s, live: false }
      return true
    },
  }
  const add = (id: string, tool: ToolName = 'claude') =>
    rows.set(id, { s: { id, tool, live: true } as SessionInfo, idle: IDLE, waitsOn: [] })
  return { rows, sessions, slept, add }
}

describe('the sleeper', () => {
  let now = 0
  const clock = () => now

  it('puts a session to sleep once it has been quiet for the set time, counted from host start or its last event', async () => {
    now = 1_000
    const f = fakeSessions()
    f.add('a')
    f.add('b')
    const sleeper = new SessionSleeper({ sessions: f.sessions, canSleep: () => true, now: clock })
    now += 10 * MIN
    sleeper.observe({ type: 'message_delta', sessionId: 'b', role: 'assistant', text: 'still here' })
    now += 5 * MIN - 1
    expect(await sleeper.sweep()).toEqual([])
    now += 1
    expect(await sleeper.sweep()).toEqual(['a'])
    now += 10 * MIN
    expect(await sleeper.sweep()).toEqual(['b'])
    // Asleep is not slept again
    expect(await sleeper.sweep()).toEqual([])
    expect(f.slept).toEqual(['a', 'b'])
  })

  it('leaves busy sessions, sessions waiting on a child, and tools that may not sleep', async () => {
    now = 0
    const f = fakeSessions()
    f.add('turn')
    f.add('parent')
    f.add('codex', 'codex')
    f.rows.get('turn')!.idle = { idle: false, reason: 'turn' }
    f.rows.get('parent')!.waitsOn = ['child']
    const sleeper = new SessionSleeper({ sessions: f.sessions, canSleep: (tool) => tool === 'claude', now: clock })
    now += 60 * MIN
    expect(await sleeper.sweep()).toEqual([])
    expect(sleeper.decide(f.rows.get('codex')!.s)).toEqual({ sleep: false, why: 'unsupported' })
    f.rows.get('parent')!.waitsOn = []
    expect(await sleeper.sweep()).toEqual(['parent'])
  })

  it('follows the setting: saved when changed, off sleeps nothing, and an override replaces it', async () => {
    now = 0
    const f = fakeSessions()
    f.add('a')
    const saved: (number | null)[] = []
    const sleeper = new SessionSleeper({ sessions: f.sessions, canSleep: () => true, now: clock, readAfterMinutes: () => 30, writeAfterMinutes: (m) => saved.push(m) })
    expect(sleeper.policy()).toEqual({ afterMinutes: 30 })
    now += 20 * MIN
    expect(await sleeper.sweep()).toEqual([])
    expect(sleeper.setAfterMinutes(null)).toEqual({ afterMinutes: null })
    now += 600 * MIN
    expect(await sleeper.sweep()).toEqual([])
    sleeper.setAfterMinutes(5)
    expect(saved).toEqual([null, 5])
    expect(await sleeper.sweep()).toEqual(['a'])
    sleeper.stop()
    const fast = new SessionSleeper({ sessions: fakeSessions().sessions, canSleep: () => true, readAfterMinutes: () => 15, overrideMs: 2000 })
    expect(fast.afterMs()).toBe(2000)
  })
})

/*
 * The act, on the real manager: a fake agent whose process records being disposed, whose conversation has an id to
 * resume, and whose start and end a test can hold.
 */
class Handle implements SessionHandle {
  sent: string[] = []
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    public externalId: string | null,
    private readonly gate: () => Promise<void>,
  ) {}
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    await this.gate()
    this.disposed = true
  }
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  private disposeGate: Promise<void> | null = null
  private openDispose: (() => void) | null = null
  holdDispose() {
    this.disposeGate = new Promise((r) => (this.openDispose = r))
  }
  releaseDispose() {
    this.disposeGate = null
    this.openDispose?.()
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit, opts.resumeExternalId ?? `ext-${opts.sessionId}`, async () => {
      if (this.disposeGate) await this.disposeGate
    })
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

describe('a session put to sleep, on the manager', () => {
  let store: Store
  let adapter: Adapter
  let mgr: SessionManager
  let events: NormalizedEvent[]
  let rpc: ReturnType<typeof createRpcHandler>

  const build = (s: Store) => {
    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    const m = new SessionManager(s, adapters, (e) => events.push(e))
    return { m, rpc: createRpcHandler(m, adapters) }
  }

  beforeEach(() => {
    store = new Store()
    adapter = new Adapter()
    events = []
    ;({ m: mgr, rpc } = build(store))
  })
  afterEach(async () => {
    await mgr.disposeAll()
    store.close()
  })

  async function idleSession(): Promise<string> {
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    // One finished turn, so there is a conversation to resume
    await mgr.send(s.id, 'hello')
    adapter.last.emit({ type: 'message_delta', sessionId: s.id, role: 'assistant', text: 'hi' })
    adapter.last.emit({ type: 'turn_complete', sessionId: s.id })
    return s.id
  }
  const live = (id: string) => mgr.listSessions().find((s) => s.id === id)!.live

  it('ends the process, lists the session as asleep and says so; the next message resumes the same conversation', async () => {
    const id = await idleSession()
    const first = adapter.last
    expect(await mgr.sleepSession(id)).toBe(true)
    expect(first.disposed).toBe(true)
    expect(live(id)).toBe(false)
    expect(events).toContainEqual({ type: 'session_live', sessionId: id, live: false, reason: 'asleep' })

    await mgr.send(id, 'are you there?')
    expect(adapter.created).toHaveLength(2)
    expect(adapter.last.opts.resumeExternalId).toBe(`ext-${id}`)
    expect(adapter.last.sent).toEqual(['are you there?'])
    expect(first.sent).toEqual(['hello'])
    expect(live(id)).toBe(true)
    expect(events).toContainEqual({ type: 'session_live', sessionId: id, live: true })
  })

  it('refuses while anything a person would lose is held: a turn, an approval, background work', async () => {
    const id = await idleSession()
    const h = adapter.last
    h.emit({ type: 'state_change', sessionId: id, state: 'working' })
    expect(await mgr.sleepSession(id)).toBe(false)
    h.emit({ type: 'approval_request', sessionId: id, requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    expect(await mgr.sleepSession(id)).toBe(false)
    h.emit({ type: 'approval_resolved', sessionId: id, requestId: 'r1', decision: 'allow' })
    h.emit({ type: 'turn_complete', sessionId: id })
    h.emit({ type: 'background_tasks', sessionId: id, live: [{ id: 't1', kind: 'shell', description: 'npm run dev', status: 'running' }] })
    expect(await mgr.sleepSession(id)).toBe(false)
    expect(h.disposed).toBe(false)
    h.emit({ type: 'background_tasks', sessionId: id, live: [], ended: [{ id: 't1', kind: 'shell', description: 'npm run dev', status: 'completed' }] })
    expect(await mgr.sleepSession(id)).toBe(true)
  })

  it('a session whose /loop has scheduled its next wake-up stays awake until it is due, as the Claude adapter reports it', async () => {
    const id = await idleSession()
    const h = adapter.last
    // What the Claude adapter's stream makes of a /loop turn that ends by scheduling the next one
    const stream = new ClaudeStreamNormalizer(id)
    const turn = [
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 1200, reason: 'poll CI', prompt: '/loop poll CI' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] }, tool_use_result: { scheduledFor: Date.now() + 1_200_000 } },
    ]
    for (const m of turn) for (const e of stream.push(m)) h.emit(e)
    h.emit({ type: 'turn_complete', sessionId: id })
    expect(mgr.sessionIdle(id)).toEqual({ idle: false, reason: 'background' })
    expect(await mgr.sleepSession(id)).toBe(false)
    expect(h.disposed).toBe(false)
    // The loop stopped: it may sleep
    for (const m of [
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'w2', name: 'ScheduleWakeup', input: { stop: true } }] } },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w2', content: 'stopped' }] }, tool_use_result: { stopped: true } },
    ]) for (const e of stream.push(m)) h.emit(e)
    h.emit({ type: 'turn_complete', sessionId: id })
    expect(await mgr.sleepSession(id)).toBe(true)
  })

  it('a message arriving while the process is still going down waits for it, and starts exactly one new process', async () => {
    const id = await idleSession()
    adapter.holdDispose()
    const sleeping = mgr.sleepSession(id)
    const sent = mgr.send(id, 'quick question')
    await new Promise((r) => setTimeout(r, 20))
    // Not beside the old one
    expect(adapter.created).toHaveLength(1)
    adapter.releaseDispose()
    await Promise.all([sleeping, sent])
    expect(adapter.created).toHaveLength(2)
    expect(adapter.last.sent).toEqual(['quick question'])
    expect(live(id)).toBe(true)
  })

  it('stays asleep on the next host (a restart or a swap) and wakes there on a message', async () => {
    const id = await idleSession()
    await mgr.sleepSession(id)
    // The next host opens the same store; nothing of this one's carries over
    const next = build(store)
    expect(next.m.listSessions().find((s) => s.id === id)!.live).toBe(false)
    expect(adapter.created).toHaveLength(1)
    await next.m.send(id, 'back again')
    expect(adapter.last.opts.resumeExternalId).toBe(`ext-${id}`)
    expect(adapter.last.sent).toEqual(['back again'])
    await next.m.disposeAll()
  })

  it('the sleeper wired to the manager, as main.ts wires it: quiet sessions sleep, a session that spoke does not', async () => {
    let now = 0
    const a = await idleSession()
    const b = await idleSession()
    const sleeper = new SessionSleeper({ sessions: mgr, canSleep: (tool) => !!adapter.capabilities.sleep && tool === 'claude', now: () => now })
    for (const e of events) sleeper.observe(e)
    now += 15 * MIN
    adapter.created.find((h) => h.sessionId === b)!.emit({ type: 'session_title', sessionId: b, title: 'still in use', auto: true })
    sleeper.observe(events.at(-1)!)
    expect(await sleeper.sweep()).toEqual([a])
    expect([live(a), live(b)]).toEqual([false, true])
  })
})

describe('a parent and the agents it started (start_agent, #561)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    for (const a of w.adapters.values()) Object.assign(a.capabilities, { backgroundTasks: true, sleep: true })
  })
  afterEach(async () => {
    await w.dispose()
  })

  it('a parent stays awake while a child runs the turn it gave it, and may sleep once the child has answered; the child sleeps by the ordinary rule', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const parent = await w.callerSession()
    const r = await w.mgr.startAgent(parent, { task: 'write the parser', wait: false })
    expect(r).toMatchObject({ ok: true, state: 'working' })
    const child = r.ok ? r.sessionId : ''
    await w.until(() => !!w.adapters.get('claude')!.handles.get(child)?.sent.length)

    expect(w.mgr.waitsOn(parent)).toEqual([child])
    expect(await w.mgr.sleepSession(parent)).toBe(false)
    // The child is working: not idle
    expect(await w.mgr.sleepSession(child)).toBe(false)

    w.adapters.get('claude')!.handles.get(child)!.answer('Parser done.')
    // The report reaches the parent as a message, which runs a turn there; it ends
    await w.until(() => w.mgr.waitsOn(parent).length === 0)
    await new Promise((res) => setTimeout(res, 20))
    w.adapters.get('claude')!.handles.get(parent)!.event({ type: 'turn_complete', sessionId: parent })
    expect(await w.mgr.sleepSession(child)).toBe(true)
    expect(await w.mgr.sleepSession(parent)).toBe(true)
  })
})
