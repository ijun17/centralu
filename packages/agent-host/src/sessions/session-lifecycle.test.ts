import { beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'

/**
 * Races in the session lifecycle — cases where something else lands **in the middle of** swapping
 * a process out or waking one up.
 *
 * The fake adapter hands the test two things: an event sink per handle (`emit`) — to make a
 * discarded handle speak late — and a `createSession` that can be held — to create a window
 * during which the session is still waking up.
 */
class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  sent: string[] = []
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    private readonly onDispose: () => void = () => {},
  ) {}
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  /** What the process still says while it goes down, after dispose began and before it finished (#213) */
  lastWords: (() => void) | null = null
  async dispose() {
    this.disposed = true
    if (this.lastWords) {
      await new Promise((r) => setTimeout(r, 0))
      this.lastWords()
    }
    this.onDispose()
  }
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  created: Handle[] = []
  /** The process holding a resumed conversation — from the moment it starts coming up until it closes (mimics Codex's write lock) */
  locked = new Set<string>()
  /** The options createSession received, recorded **before** it holds — so the test knows the moment waking passed its options along */
  asked: CreateSessionOpts[] = []
  /** When set, createSession holds until `release()` is called — the window during which a session is waking up */
  gate: Promise<void> | null = null
  private open: (() => void) | null = null
  constructor(readonly tool: ToolName) {}
  hold() {
    this.gate = new Promise((r) => (this.open = r))
  }
  release() {
    this.gate = null
    this.open?.()
  }
  async deleteExternalConversation(externalId: string) {
    if (this.locked.has(externalId)) throw new Error('thread already has an active writer')
  }
  get last() {
    return this.created.at(-1)!
  }
  /** When set, detect holds until `openDetect()` — the window while a tool switch is confirming */
  detectGate: Promise<void> | null = null
  openDetect: (() => void) | null = null
  async detect() {
    if (this.detectGate) await this.detectGate
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    this.asked.push(opts)
    const holds = opts.resumeExternalId
    if (holds) this.locked.add(holds)
    if (this.gate) await this.gate
    const h = new Handle(opts.sessionId, opts, emit, () => holds && this.locked.delete(holds))
    if (opts.resumeExternalId) h.externalId = opts.resumeExternalId
    this.created.push(h)
    return h
  }
}

let store: Store
let claude: Adapter
let codex: Adapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  store = new Store()
  claude = new Adapter('claude')
  codex = new Adapter('codex')
  events = []
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', codex]])
  mgr = new SessionManager(store, adapters, (e) => events.push(e))
  rpc = createRpcHandler(mgr, adapters)
})

async function newSession(preset: 'safe' | 'normal' | 'auto' = 'normal'): Promise<string> {
  const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: preset })) as {
    id: string
  }
  return s.id
}

/** Spins the event loop until the condition holds — waits for the manager's await chain to reach the fake adapter */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(ok()).toBe(true)
}

const texts = (sessionId: string) =>
  store.loadMessages(sessionId, 100).map((r) => JSON.stringify(r.payload))

describe('a swapped-out process speaking late (#157)', () => {
  it('keeps the new handle even if the old handle raises adapter_crashed after a restart, and does not record the old turn\'s text or its end', async () => {
    const id = await newSession()
    const old = claude.last
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'the front part of the old turn' })
    // The person stopped the turn (the issue's order of events: Stop → change settings)
    old.emit({ type: 'state_change', sessionId: id, state: 'waiting_input', reason: 'interrupted' })

    // Changing settings swaps the process out
    await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    const fresh = claude.last
    expect(fresh).not.toBe(old)
    expect(old.disposed).toBe(true)

    // The old process finishes emitting the turn it was in the middle of, then dies carrying an error result
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'late text from the old process' })
    old.emit({ type: 'turn_complete', sessionId: id })
    old.emit({
      type: 'error',
      sessionId: id,
      error: { code: 'adapter_crashed', message: 'Claude Code returned an error result: x', retryable: true },
    })

    expect(fresh.disposed).toBe(false)
    expect(mgr.isLive(id)).toBe(true)
    expect(events.some((e) => e.type === 'error' && e.error.code === 'adapter_crashed')).toBe(false)
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false)
    expect(texts(id).some((t) => t.includes('late text from the old process'))).toBe(false)

    // The new handle's own crash is still handled the same way as before — the guard did not block the crash branch entirely
    fresh.emit({ type: 'error', sessionId: id, error: { code: 'adapter_crashed', message: 'gone', retryable: true } })
    expect(fresh.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
  })

  it('still takes an approval card released by a discarded handle as it closes — so no card is left stuck', async () => {
    const id = await newSession('safe')
    const old = claude.last
    old.emit({ type: 'approval_request', sessionId: id, requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    expect(mgr.listSessions().find((s) => s.id === id)!.pendingApproval?.requestId).toBe('r1')

    await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    old.emit({ type: 'approval_resolved', sessionId: id, requestId: 'r1', decision: 'deny' })

    expect(mgr.listSessions().find((s) => s.id === id)!.pendingApproval ?? null).toBe(null)
  })
})

/*
 * A reply cut by replacing the process (#213). The manager closed the open message before it awaited the old
 * process's dispose, and the old handle was still registered while it went down — so the dying process's last
 * deltas opened a second row. One reply was stored as two, cut mid-word ("커|밋" in the owner's store).
 */
describe('A reply cut by replacing the process stays one row (#213)', () => {
  const replies = (sessionId: string) =>
    store
      .loadMessages(sessionId, 100)
      .filter((r) => r.role === 'assistant')
      .map((r) => (r.payload as { text: string }).text)

  it.each([
    ['a restart', (id: string) => rpc('agents.restartSession', { sessionId: id })],
    ['a tool switch', (id: string) => rpc('agents.switchTool', { sessionId: id, tool: 'codex' })],
    ['shutting down', () => mgr.disposeAll()],
  ])("the dying process's last delta during %s grows the open row", async (_, replace) => {
    const id = await newSession()
    const old = claude.last
    await rpc('agents.send', { sessionId: id, text: 'commit it' })
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'I will com' })
    let spoke = false
    old.lastWords = () => {
      spoke = true
      old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'mit it now' })
    }

    await replace(id)

    expect(spoke).toBe(true)
    expect(replies(id)).toEqual(['I will commit it now'])
    // Closed and indexed once, whole — not the first half
    expect(store.searchMessages('commit it now', 10).some((h) => h.sessionId === id)).toBe(true)
  })

  it('a shutdown cut short before the processes are down still leaves what was said so far on disk (#66)', async () => {
    const id = await newSession()
    const old = claude.last
    await rpc('agents.send', { sessionId: id, text: 'commit it' })
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'I will com' })
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'mit' }) // held in memory, under the flush bar

    const closing = mgr.disposeAll()
    // The supervisor may kill the host here, while the processes are still going down
    expect(replies(id)).toEqual(['I will commit'])
    await closing
  })

  it("the replacing process's first delta starts its own row, and the old process's words after it is gone are dropped", async () => {
    const id = await newSession()
    const old = claude.last
    await rpc('agents.send', { sessionId: id, text: 'commit it' })
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'I will com' })
    old.lastWords = () => old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'mit it' })

    await rpc('agents.restartSession', { sessionId: id })
    const fresh = claude.last
    expect(fresh).not.toBe(old)
    fresh.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'Resumed.' })
    old.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: ' too late' })

    expect(replies(id)).toEqual(['I will commit it', 'Resumed.'])
  })
})

/*
 * Settings changed while waking up (#162). Waking reads settings and hands them to the process,
 * then waits for the process — a large Codex conversation can take a dozen-plus seconds. If
 * permissions were switched to safe during that wait, the UI and the store said safe while the
 * process actually ran with auto, and picking safe again did nothing because the manager's record
 * (running) already said safe.
 */
describe('a setting changed while waking or restarting still reaches the process (#162)', () => {
  it('leaves a process that ends up running with safe if it is switched to safe while an asleep auto session is waking', async () => {
    const id = await newSession('auto')
    await mgr.disposeAll() // an asleep session (the same state as a host restart)
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id })
    await until(() => claude.asked.length > asked)
    expect(claude.asked.at(-1)!.permissionPreset).toBe('auto') // waking has already passed auto along

    const changing = rpc('agents.updateSettings', { sessionId: id, permissionPreset: 'safe' })
    claude.release()
    await waking
    await changing

    expect(mgr.isLive(id)).toBe(true)
    expect(claude.last.disposed).toBe(false)
    expect(claude.last.opts.permissionPreset).toBe('safe')
  })

  it('a second change that arrives while a restart is running also reaches the process', async () => {
    const id = await newSession('auto')
    claude.hold()
    const asked = claude.asked.length
    const first = rpc('agents.updateSettings', { sessionId: id, effort: 'high' })
    await until(() => claude.asked.length > asked)

    const second = rpc('agents.updateSettings', { sessionId: id, permissionPreset: 'safe' })
    claude.release()
    await first
    await second

    expect(mgr.isLive(id)).toBe(true)
    expect(claude.last.disposed).toBe(false)
    expect(claude.last.opts).toMatchObject({ effort: 'high', permissionPreset: 'safe' })
  })
})

/*
 * A report the orchestrator asked for (#166). Neither adapter emits turn_complete for a failed
 * turn, only error — so the manager, which used to report only on turn_complete, never reported
 * the failure, and the leftover flag then reported an unrelated later turn as "finished."
 */
describe('a report goes exactly once, however the turn ends (#166)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const handleOf = (id: string) => claude.created.filter((h) => h.sessionId === id).at(-1)!

  async function setup() {
    const worker = await newSession()
    const orc = await mgr.orchestrator()
    const tools = claude.asked.find((o) => o.sessionId === orc.id)!.orchestratorTools!
    /** The reports stored in the orchestrator's conversation — the text the UI and the record read */
    const reports = () =>
      store
        .loadMessages(orc.id, 100)
        .map((r) => r.payload as { text?: string; from?: { sessionId: string } })
        .filter((p) => p.from?.sessionId === worker)
        .map((p) => p.text ?? '')
    return { worker, tools, w: handleOf(worker), reports }
  }

  it('sends one failure report for a failed turn, and does not report the unrelated turn after it', async () => {
    const { worker, tools, w, reports } = await setup()
    await tools.sendToSession(worker, 'fix the build', true)
    w.emit({ type: 'error', sessionId: worker, error: { code: 'internal', message: 'API Error: 400 bad model', retryable: true } })
    await tick()

    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toContain('failed')
    expect(reports()[0]).toContain('API Error: 400 bad model')
    expect(reports()[0]).not.toContain('finished')

    // A turn the person spoke to directly, and a turn assigned without asking for a report, are not reported
    await rpc('agents.send', { sessionId: worker, text: 'something asked directly' })
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tools.sendToSession(worker, 'keep it quiet', false)
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tick()
    expect(reports()).toHaveLength(1)
  })

  it('clears the previous report request when assigned again without one — the new instruction replaces it', async () => {
    const { worker, tools, w, reports } = await setup()
    await tools.sendToSession(worker, 'let me know when it is done', true)
    await tools.sendToSession(worker, 'no, do this instead', false)
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tick()
    expect(reports()).toEqual([])
  })

  it('reports a finished turn as "finished," as before', async () => {
    const { worker, tools, w, reports } = await setup()
    await tools.sendToSession(worker, 'let me know when it is done', true)
    w.emit({ type: 'turn_complete', sessionId: worker })
    await tick()
    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toContain('finished')
  })
})

/*
 * A session deleted or switched to another tool while waiting (#163). Waking used to wait for the
 * process and then seat the handle and rewrite the row without checking whether the session still
 * existed or was still the same tool.
 */
describe('deleting or switching tools while a session is waking up (#163)', () => {
  async function sleeping() {
    const id = await newSession()
    await mgr.disposeAll()
    return id
  }
  const listed = () => store.listSessions().map((x) => x.id)

  it('a session deleted while waking does not come back to life, and the process that just came up is closed', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id }) as Promise<{ resumed: boolean }>
    await until(() => claude.asked.length > asked)
    const deleting = rpc('agents.deleteSession', { sessionId: id })
    claude.release()
    expect((await waking).resumed).toBe(false)
    await deleting

    expect(listed()).not.toContain(id)
    expect(claude.last.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
    // It does not come back even after the host restarts
    const again = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', claude]]), () => {})
    expect(again.listSessions().map((x) => x.id)).not.toContain(id)
  })

  it('when also deleting the tool-side conversation, it deletes after the waking process has closed — not blocked by the lock', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id })
    await until(() => claude.asked.length > asked)
    const deleting = rpc('agents.deleteSession', { sessionId: id, deleteExternal: true })
    claude.release()
    await waking
    await deleting

    expect(listed()).not.toContain(id)
  })

  it('if waking was started from a send, the agent of a deleted session never receives that message', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const sending = rpc('agents.send', { sessionId: id, text: 'rm the old build dir' })
    const failed = sending.then(() => null, (e: Error) => e)
    await until(() => claude.asked.length > asked)
    const deleting = rpc('agents.deleteSession', { sessionId: id })
    claude.release()
    await deleting

    expect(await failed).toBeInstanceOf(Error)
    expect(claude.last.sent).toEqual([])
    expect(listed()).not.toContain(id)
  })

  it('switching tools while waking leaves no process of the old tool behind', async () => {
    const id = await sleeping()
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id }) as Promise<{ resumed: boolean }>
    await until(() => claude.asked.length > asked)
    const switching = rpc('agents.switchTool', { sessionId: id, tool: 'codex' })
    claude.release()
    await waking
    await switching

    expect(claude.last.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
    const m = mgr.listSessions().find((x) => x.id === id)!
    expect(m.tool).toBe('codex')
    expect(m.externalId).toBe(null)
  })

  it('a wake started while a tool switch is confirming also does not seat the old tool\'s handle', async () => {
    const id = await sleeping()
    codex.detectGate = new Promise((r) => (codex.openDetect = r))
    const switching = rpc('agents.switchTool', { sessionId: id, tool: 'codex' })
    claude.hold()
    const asked = claude.asked.length
    const waking = rpc('agents.resumeSession', { sessionId: id }) as Promise<{ resumed: boolean }>
    await until(() => claude.asked.length > asked) // the wake still comes up with claude at this point
    codex.openDetect!()
    await switching
    claude.release()

    expect((await waking).resumed).toBe(false)
    expect(claude.last.disposed).toBe(true)
    expect(mgr.isLive(id)).toBe(false)
    expect(mgr.listSessions().find((x) => x.id === id)!.externalId).toBe(null)
  })

  it('switching tools mid-turn leaves meta and the store as idle too — not only the broadcast', async () => {
    const id = await newSession()
    await rpc('agents.send', { sessionId: id, text: 'a long job' })
    expect(mgr.listSessions().find((x) => x.id === id)!.state).toBe('working')

    await rpc('agents.switchTool', { sessionId: id, tool: 'codex' })
    expect(mgr.listSessions().find((x) => x.id === id)!.state).toBe('idle')
    expect(store.listSessions().find((x) => x.id === id)!.state).toBe('idle')
  })

  it('a worktree session deleted while checking its PR does not leave behind a row with no id', async () => {
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    const internals = mgr as unknown as { meta: Map<string, { worktree: unknown }> }
    internals.meta.get(s.id)!.worktree = { path: tmpdir(), branch: 'centralu/x', base: 'main' }
    mgr.prLookup = async () => {
      await rpc('agents.deleteSession', { sessionId: s.id })
      return { number: 7, state: 'merged', url: 'u', headOid: 'abc' }
    }

    await mgr.refreshMergedWorktrees(p.id)
    expect(mgr.listSessions().every((x) => typeof x.id === 'string')).toBe(true)
    expect(internals.meta.has(s.id)).toBe(false)
  })
})

/*
 * Changing settings mid-turn (#164). Neither adapter applies settings live, so changing a setting
 * used to swap the process out immediately — the running turn vanished, while the UI still said
 * "(from next turn)."
 */
describe('a setting changed mid-turn is applied once the turn ends (#164)', () => {
  it('does not bring the process down while working, and swaps it for one with the new settings once the turn ends', async () => {
    const id = await newSession()
    const running = claude.last
    await rpc('agents.send', { sessionId: id, text: 'a long job' })

    const r = (await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })) as { applied?: string }
    expect(r.applied).toBe('after_turn')
    expect(running.disposed).toBe(false)
    expect(claude.last).toBe(running)

    running.emit({ type: 'turn_complete', sessionId: id })
    await until(() => claude.last !== running)
    expect(running.disposed).toBe(true)
    expect(claude.last.opts.effort).toBe('high')
  })

  it('does not cut off a turn waiting on approval either — applies the change once the turn ends, even if it ends with an error', async () => {
    const id = await newSession('safe')
    const running = claude.last
    running.emit({ type: 'approval_request', sessionId: id, requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })

    const r = (await rpc('agents.updateSettings', { sessionId: id, permissionPreset: 'auto' })) as { applied?: string }
    expect(r.applied).toBe('after_turn')
    expect(running.disposed).toBe(false)

    running.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: 'API Error: 500', retryable: true } })
    await until(() => claude.last !== running)
    expect(claude.last.opts.permissionPreset).toBe('auto')
  })

  it('an idle session is swapped right away, and the response says so', async () => {
    const id = await newSession()
    const r = (await rpc('agents.updateSettings', { sessionId: id, effort: 'high' })) as { applied?: string }
    expect(r.applied).toBe('restarted')
    expect(claude.last.opts.effort).toBe('high')
  })
})

/*
 * An old conversation outside the list (#165). The "is it still in the tool" check before waking
 * only looked at the latest 200 conversations the tool gave back — a conversation older than the
 * 201st was blocked with "no record," even with a perfectly intact file, and pressing again just
 * returned the same 200.
 */
describe('when a tool\'s list is full, being absent from the list does not mean it is gone (#165)', () => {
  class Listing extends Adapter {
    rows: { externalId: string; updatedAt: number }[] = []
    failWith: string | null = null
    async listExternalSessions(_cwd: string, limit: number) {
      return this.rows.slice(0, limit).map((r) => ({ ...r, title: r.externalId, messageCount: 1 }))
    }
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      if (this.failWith && opts.resumeExternalId) throw new Error(this.failWith)
      return super.createSession(opts, emit)
    }
  }
  let listing: Listing

  beforeEach(() => {
    listing = new Listing('claude')
    const adapters = new Map<ToolName, AgentAdapter>([['claude', listing]])
    mgr = new SessionManager(store, adapters, (e) => events.push(e))
    rpc = createRpcHandler(mgr, adapters)
  })

  /** n conversations newer than this session's conversation (ext-1) */
  const newer = (n: number) => Array.from({ length: n }, (_, i) => ({ externalId: `newer-${i}`, updatedAt: 1_000_000 - i }))

  it('wakes a conversation even 250 newer conversations behind it', async () => {
    const id = await newSession()
    await mgr.disposeAll()
    listing.rows = newer(250)

    const r = (await rpc('agents.resumeSession', { sessionId: id })) as { resumed: boolean; reason?: string }
    expect(r.reason).toBeUndefined()
    expect(r.resumed).toBe(true)
  })

  it('when the list really is complete, still says "no record," as before', async () => {
    const id = await newSession()
    await mgr.disposeAll()
    listing.rows = newer(3)

    const r = (await rpc('agents.resumeSession', { sessionId: id })) as { resumed: boolean; reason?: string }
    expect(r.resumed).toBe(false)
    expect(r.reason).toMatch(/has no record of this conversation/)
  })

  it('when resuming fails for a different reason, returns the real error even with a full list', async () => {
    const id = await newSession()
    await mgr.disposeAll()
    listing.rows = newer(250)
    listing.failWith = 'API Error: 529 overloaded'

    const r = (await rpc('agents.resumeSession', { sessionId: id })) as { resumed: boolean; reason?: string }
    expect(r.resumed).toBe(false)
    expect(r.reason).toContain('529 overloaded')
  })
})
