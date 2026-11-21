import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { recordUpdateCut, type UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { createRpcHandler } from '../rpc.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'
import { TurnContinue, UPDATE_SLOT_MS, UPDATE_WAKES_AT_ONCE } from './turn-continue.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'

/**
 * The sessions an update's stop left wake a few at a time (#1913): with forty sessions all forty woke together, each one's first request
 * re-reading its whole conversation. At most `UPDATE_WAKES_AT_ONCE` wait for their first answer at once, cut turns first, and none is left out.
 */

/** A tool whose turn answers only when the test says so: a note going in starts a turn and nothing more */
class Handle implements SessionHandle {
  externalId: string | null
  readonly sent: string[] = []
  constructor(
    readonly sessionId: string,
    opts: CreateSessionOpts,
    readonly emit: EventSink,
  ) {
    this.externalId = opts.resumeExternalId ?? `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  /** The first answer of the turn's model request */
  answer() {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: 'on it' })
  }
  finish() {
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval() {
    return true
  }
  interrupt() {
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
  }
  async dispose() {}
}

/** The conversations the tool keeps, across the hosts of one test's store: what a next host's resume finds */
const known = new Set<string>()

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  readonly handles = new Map<string, Handle>()
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions(): Promise<ExternalSessionSummary[]> {
    return [...known].map((externalId) => ({ externalId, title: 'x', updatedAt: Date.now() }))
  }
  launchSettingsFingerprint() {
    return 'v1'
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit)
    if (h.externalId) known.add(h.externalId)
    this.handles.set(opts.sessionId, h)
    return h
  }
}

const dirs: string[] = []
const dir = (prefix: string) => {
  const d = tempRoot(prefix)
  dirs.push(d)
  return d
}
const hosts: SessionManager[] = []
afterEach(async () => {
  for (const m of hosts.splice(0)) await m.tenure.disposeAll()
  for (const d of dirs.splice(0)) await removeTree(d)
})

function host(store: Store, folder: UpdateResumeFolder) {
  const adapter = new Adapter()
  const events: NormalizedEvent[] = []
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, { worktreeRoot: dir('wakes-data-'), updateResume: folder })
  hosts.push(mgr)
  const session = (id: string) => mgr.listSessions().find((s) => s.id === id)!
  return { mgr, adapter, events, session, rpc: createRpcHandler(mgr, adapters) }
}

/** A first host with `cut` sessions mid-turn and `idle` sessions at rest with a running task, stopped for an update; the next host over the same store */
async function updated(cut: number, idle: number) {
  const store = new Store()
  const folder = memoryUpdateFolder()
  const a = host(store, folder)
  const ids = { cut: [] as string[], idle: [] as string[] }
  for (let i = 0; i < cut + idle; i++) {
    const p = (await a.rpc('projects.add', { path: dir(`wakes-p${i}-`) })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: dir(`wakes-c${i}-`), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    await a.mgr.inputs.send(s.id, 'hello')
    const h = a.adapter.handles.get(s.id)!
    if (i < cut) {
      ids.cut.push(s.id)
      continue
    }
    h.emit({ type: 'background_tasks', sessionId: s.id, live: [{ id: `t${i}`, kind: 'shell', description: 'dev server', status: 'running' }] })
    h.finish()
    ids.idle.push(s.id)
  }
  a.mgr.tenure.stopForUpdate()
  await a.mgr.tenure.disposeAll()
  hosts.splice(hosts.indexOf(a.mgr), 1)
  return { store, folder, ids, all: [...ids.cut, ...ids.idle] }
}

/** The sessions of host `b` whose note went in and that have not answered yet */
const waking = (b: ReturnType<typeof host>, answered: Set<string>) => [...b.adapter.handles.values()].filter((h) => h.sent.length > 0 && !answered.has(h.sessionId))

/** The engine alone, on a host of plain maps: `n` sessions at rest that an update's stop left, each send handed at once */
function engine(n: number) {
  const meta = new Map<string, SessionInfo>()
  const sent: string[] = []
  const steps: string[] = []
  const engine = new TurnContinue({
    meta, leaving: () => false, compactTurn: () => false, running: () => true, settings: () => ({ network: true, limit: true }), reachable: async () => true,
    note: () => {}, changed: () => {}, waitEnded: () => {}, updateStep: (c, step) => void steps.push(`${c.sessionId}:${step}`),
    send: async (id, _note, gate) => {
      sent.push(id)
      if (gate.live()) gate.handed()
    },
  })
  const ids = Array.from({ length: n }, (_, i) => `s${i}`)
  for (const id of ids) meta.set(id, { id, state: 'idle' } as SessionInfo)
  engine.wakeAfterUpdate(ids.map((sessionId) => ({ sessionId, turn: false, stopped: null })))
  return { engine, meta, sent, steps, ids }
}

// Two hosts over one store and several sessions each: every wait is on an event, and the limit is the work's, scaled for a loaded machine (#2264)
describe('the sessions an update stopped wake a few at a time (#1913)', { timeout: 30_000 * SLOW }, () => {
  it(`never has more than ${UPDATE_WAKES_AT_ONCE} waiting for their first answer, cut turns first, and wakes every one in the end`, async () => {
    const { store, folder, ids, all } = await updated(2, 3)
    const b = host(store, folder)
    const answered = new Set<string>()
    const order: string[] = []
    let most = 0
    while (answered.size < all.length) {
      await eventually(() => waking(b, answered).length === Math.min(UPDATE_WAKES_AT_ONCE, all.length - answered.size))
      // A turn of the event loop more: nothing past the slots goes in meanwhile
      await new Promise((r) => setTimeout(r, 0))
      const now = waking(b, answered)
      most = Math.max(most, now.length)
      for (const h of now) if (!order.includes(h.sessionId)) order.push(h.sessionId)
      const first = now[0]!
      answered.add(first.sessionId)
      first.answer()
    }
    expect(most).toBe(UPDATE_WAKES_AT_ONCE)
    expect(order.slice(0, 2).sort()).toEqual([...ids.cut].sort())
    expect(new Set(order)).toEqual(new Set(all))
    // Each got its note once, and the lists are gone
    for (const id of all) expect(b.adapter.handles.get(id)!.sent).toHaveLength(1)
    await eventually(() => folder.files.size === 0)
  })

  it('frees a slot when the person stops a woken turn before it answered', async () => {
    const { store, folder, all } = await updated(0, UPDATE_WAKES_AT_ONCE + 1)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === UPDATE_WAKES_AT_ONCE)
    await b.rpc('agents.interrupt', { sessionId: waking(b, new Set())[0]!.sessionId })
    await eventually(() => all.every((id) => (b.adapter.handles.get(id)?.sent.length ?? 0) === 1))
  })

  it("keeps the slot over a resumed process's own turn end with no request: the burst is the note's request (engine)", async () => {
    const e = engine(UPDATE_WAKES_AT_ONCE + 1)
    await eventually(() => e.sent.length === UPDATE_WAKES_AT_ONCE && e.steps.filter((x) => x.endsWith(':sent')).length === UPDATE_WAKES_AT_ONCE)
    // Claude Code ends a turn of its own right after a resume, before the note's request (measured): not the wake's answer
    e.engine.observe({ type: 'turn_complete', sessionId: 's0' })
    expect(e.sent).toHaveLength(UPDATE_WAKES_AT_ONCE)
    // Its first answer is
    e.engine.observe({ type: 'usage_update', sessionId: 's0', tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    expect(e.sent).toEqual(e.ids)
  })

  it('counts the slots again when a wake ends at once inside the pump: a session gone first does not let a fourth in (engine)', async () => {
    const e = engine(UPDATE_WAKES_AT_ONCE + 2)
    e.meta.delete('s0')
    await eventually(() => e.steps.includes('s0:dropped') && e.sent.length === UPDATE_WAKES_AT_ONCE)
    await new Promise((r) => setTimeout(r, 0))
    expect(e.sent).toEqual(['s1', 's2', 's3'])
  })

  it("leaves a session at rest its note when the person presses Stop on it: only a cut turn's wait is ended (engine)", async () => {
    const e = engine(UPDATE_WAKES_AT_ONCE + 1)
    await eventually(() => e.sent.length === UPDATE_WAKES_AT_ONCE)
    expect(e.engine.cancel('s3')).toBe(null)
    e.engine.observe({ type: 'message_delta', sessionId: 's0', role: 'assistant', text: 'on it' })
    expect(e.sent).toEqual(e.ids)
  })

  it('drops a queued wake when its session goes to the trash, and lets the next one in (engine)', async () => {
    const e = engine(UPDATE_WAKES_AT_ONCE + 2)
    await eventually(() => e.sent.length === UPDATE_WAKES_AT_ONCE)
    e.engine.forget('s3')
    expect(e.steps).toContain('s3:dropped')
    e.engine.observe({ type: 'message_delta', sessionId: 's0', role: 'assistant', text: 'on it' })
    expect(e.sent).toEqual(['s0', 's1', 's2', 's4'])
  })

  it('gives a slot up when the woken session says nothing for UPDATE_SLOT_MS, its wake going on (engine)', async () => {
    vi.useFakeTimers()
    try {
      const e = engine(UPDATE_WAKES_AT_ONCE + 1)
      await vi.advanceTimersByTimeAsync(0)
      expect(e.sent).toHaveLength(UPDATE_WAKES_AT_ONCE)
      await vi.advanceTimersByTimeAsync(UPDATE_SLOT_MS - 1)
      expect(e.sent).toHaveLength(UPDATE_WAKES_AT_ONCE)
      await vi.advanceTimersByTimeAsync(1)
      expect(e.sent).toEqual(e.ids)
    } finally {
      vi.useRealTimers()
    }
  })

  it("sends a queued session's note at once when the person writes to it, outside the queue", async () => {
    const { store, folder, ids } = await updated(0, UPDATE_WAKES_AT_ONCE + 1)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === UPDATE_WAKES_AT_ONCE)
    const queued = ids.idle.find((id) => !b.adapter.handles.get(id)?.sent.length)!
    await b.mgr.inputs.send(queued, 'what was that?')
    const h = b.adapter.handles.get(queued)!
    await eventually(() => h.sent.length === 2)
    expect(h.sent.some((t) => t.includes('the update stopped the background work'))).toBe(true)
    expect(h.sent).toContain('what was that?')
  })

  it('takes a Stop on a queued session at rest, with no process yet, and still sends its note', async () => {
    const { store, folder, ids } = await updated(0, UPDATE_WAKES_AT_ONCE + 1)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === UPDATE_WAKES_AT_ONCE)
    const queued = ids.idle.find((id) => !b.adapter.handles.get(id))!
    await b.rpc('agents.interrupt', { sessionId: queued })
    for (const h of waking(b, new Set())) h.answer()
    await eventually(() => b.adapter.handles.get(queued)?.sent.length === 1)
  })

  it('lists a woken session again when a second update stops it before its first answer, and the next host notes it once', async () => {
    const { store, folder, ids, all } = await updated(1, 1)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === 2)
    // The resumed process ends a turn of its own before the note's request (measured): the session reads at rest, its list entry gone
    for (const h of waking(b, new Set())) h.finish()
    await eventually(() => all.every((id) => b.session(id).state !== 'working'))
    b.mgr.tenure.stopForUpdate()
    await b.mgr.tenure.disposeAll()
    const c = host(store, folder)
    await eventually(() => all.every((id) => c.adapter.handles.get(id)?.sent.length === 1))
    expect(c.adapter.handles.get(ids.cut[0]!)!.sent[0]).toContain('was updated while your turn was running')
    expect(c.adapter.handles.get(ids.idle[0]!)!.sent[0]).toContain('the update stopped the background work')
    for (const id of all) c.adapter.handles.get(id)!.answer()
    await eventually(() => folder.files.size === 0)
    for (const id of all) expect(c.adapter.handles.get(id)!.sent).toHaveLength(1)
  })

  it('ends the wait of a queued cut turn the person stops: at rest, not continued, and its list goes', async () => {
    const { store, folder, ids } = await updated(UPDATE_WAKES_AT_ONCE + 1, 0)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === UPDATE_WAKES_AT_ONCE)
    const queued = ids.cut.find((id) => !b.adapter.handles.get(id)?.sent.length)!
    expect(b.session(queued).state).toBe('working')
    await b.rpc('agents.interrupt', { sessionId: queued })
    expect(b.session(queued).state).not.toBe('working')
    for (const h of waking(b, new Set())) h.answer()
    await eventually(() => folder.files.size === 0)
    expect(b.adapter.handles.get(queued)?.sent ?? []).toEqual([])
  })

  it('does not continue a queued cut turn the person stopped when a second update stops the host before its slot came (#2264 review)', async () => {
    const { store, folder, ids } = await updated(UPDATE_WAKES_AT_ONCE + 2, 0)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === UPDATE_WAKES_AT_ONCE)
    const [stopped, queued] = ids.cut.filter((id) => !b.adapter.handles.get(id)?.sent.length)
    await b.rpc('agents.interrupt', { sessionId: stopped })
    // Dropped at once, not when a slot frees: the hello stops naming it, and its list entry is dealt with
    expect(b.mgr.tenure.updateContinued().map((c) => c.sessionId)).not.toContain(stopped)
    // The first update's list still stands (the other queued turn is not dealt with) and names the stopped one at its mark: a Stop writes no row
    b.mgr.tenure.stopForUpdate()
    await b.mgr.tenure.disposeAll()
    const c = host(store, folder)
    const goOn = ids.cut.filter((id) => id !== stopped)
    expect(goOn).toContain(queued)
    expect(c.session(stopped!).state).not.toBe('working')
    const answered = new Set<string>()
    while (answered.size < goOn.length) {
      await eventually(() => waking(c, answered).length > 0)
      for (const h of waking(c, answered)) {
        answered.add(h.sessionId)
        h.answer()
      }
    }
    expect(answered).toEqual(new Set(goOn))
    await eventually(() => folder.files.size === 0)
    expect(c.adapter.handles.get(stopped!)?.sent ?? []).toEqual([])
  })

  it('does not continue a woken entry the person stopped while it was queued, though its list still names others (#2264 re-check)', async () => {
    const { store, folder, all } = await updated(UPDATE_WAKES_AT_ONCE + 2, 0)
    // As a second update's stop left them: every turn woken before it and caught at rest before its first answer, listed `woken`
    folder.files.clear()
    for (const s of store.sessions.listSessions()) store.sessions.upsertSession({ ...s, state: 'waiting_input' })
    recordUpdateCut(folder, all.map((id) => ({ id, seq: store.messages.nextSeq(id) - 1, woken: true as const })))
    const c = host(store, folder)
    await eventually(() => waking(c, new Set()).length === UPDATE_WAKES_AT_ONCE)
    const [stopped, other] = all.filter((id) => !c.adapter.handles.get(id)?.sent.length)
    expect(c.session(stopped!).state).toBe('working')
    await c.rpc('agents.interrupt', { sessionId: stopped })
    // The other queued one is not dealt with, so its list stands: without the stopped one's entry
    expect(folder.turns()!.map((t) => t.id)).not.toContain(stopped)
    expect(folder.turns()!.map((t) => t.id)).toContain(other)
    // A plain quit now, before anything answered; the start after it
    await c.mgr.tenure.disposeAll()
    hosts.splice(hosts.indexOf(c.mgr), 1)
    const d = host(store, folder)
    await eventually(() => d.adapter.handles.get(other!)?.sent.length === 1)
    expect(d.adapter.handles.get(stopped!)?.sent ?? []).toEqual([])
    expect(d.session(stopped!).state).not.toBe('working')
  })

  it('does not continue a session in error from a woken entry, and deals with the entry (#2264 re-check)', async () => {
    const { store, folder, all } = await updated(2, 0)
    const [failed, fine] = all
    folder.files.clear()
    for (const s of store.sessions.listSessions()) store.sessions.upsertSession({ ...s, state: s.id === failed ? 'error' : 'waiting_input' })
    recordUpdateCut(folder, all.map((id) => ({ id, seq: store.messages.nextSeq(id) - 1, woken: true as const })))
    const c = host(store, folder)
    await eventually(() => c.adapter.handles.get(fine!)?.sent.length === 1)
    c.adapter.handles.get(fine!)!.answer()
    await eventually(() => folder.files.size === 0)
    expect(c.adapter.handles.get(failed!)?.sent ?? []).toEqual([])
    expect(c.session(failed!).state).toBe('error')
  })

  it('leaves the ones still queued to the host after a second update, which wakes them once', async () => {
    const { store, folder, ids } = await updated(0, UPDATE_WAKES_AT_ONCE + 2)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === UPDATE_WAKES_AT_ONCE)
    const woken = new Set(waking(b, new Set()).map((h) => h.sessionId))
    b.mgr.tenure.stopForUpdate()
    await b.mgr.tenure.disposeAll()
    const c = host(store, folder)
    // The ones woken before it were in their wake turn when it stopped them: that turn is cut, and continued first
    await eventually(() => [...woken].every((id) => c.adapter.handles.get(id)?.sent.length === 1))
    for (const id of woken) {
      expect(c.adapter.handles.get(id)!.sent[0]).toContain('was updated while your turn was running')
      c.adapter.handles.get(id)!.answer()
    }
    const rest = ids.idle.filter((id) => !woken.has(id))
    await eventually(() => rest.every((id) => c.adapter.handles.get(id)?.sent.length === 1))
    for (const id of rest) expect(c.adapter.handles.get(id)!.sent[0]).toContain('the update stopped the background work')
  })
})
