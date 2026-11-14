import { afterEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import type { UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { createRpcHandler } from '../rpc.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'
import { UPDATE_WAKES_AT_ONCE } from './turn-continue.js'
import { eventually } from '../../../../tooling/test-timing.js'

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
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, dir('wakes-data-'), { updateResume: folder })
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

describe('the sessions an update stopped wake a few at a time (#1913)', () => {
  it(`never has more than ${UPDATE_WAKES_AT_ONCE} waiting for their first answer, cut turns first, and wakes every one in the end`, async () => {
    const { store, folder, ids, all } = await updated(2, 6)
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

  it('frees a slot when a woken turn ends without an answer (the person stops it, or it fails)', async () => {
    const { store, folder, all } = await updated(0, UPDATE_WAKES_AT_ONCE + 1)
    const b = host(store, folder)
    await eventually(() => waking(b, new Set()).length === UPDATE_WAKES_AT_ONCE)
    const first = waking(b, new Set())[0]!
    first.finish()
    await eventually(() => all.every((id) => (b.adapter.handles.get(id)?.sent.length ?? 0) === 1))
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
