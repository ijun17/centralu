import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { SERVER_OVERLOADED } from '../adapters/overloaded.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { tempRoot } from '../temp-dir.test-helpers.js'
import { FakeProcess } from './kept-host.test-helpers.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { DELAYS_MS, RETRY_NOTE } from './overload-retry.js'

/**
 * A turn the provider ends because its servers are at capacity is retried by the host (#1693): the session stays in its
 * turn, a line says when the next try is, and after the wait the turn is continued through Centralu's channel. The turns
 * of the issue had run 14 to 44 minutes, so the wait grows and the tries are few.
 */

/** The error Codex's adapter sends for `codexErrorInfo: "serverOverloaded"` (`turnError`) */
const overloaded = (sessionId: string): NormalizedEvent => ({
  type: 'error',
  sessionId,
  error: { code: 'internal', message: 'Selected model is at capacity. Please try a different model.', retryable: true, data: { reason: SERVER_OVERLOADED } },
})

class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  constructor(
    readonly sessionId: string,
    readonly emit: EventSink,
  ) {}
  readonly sent: string[] = []
  stops = 0
  send(text: string) {
    this.sent.push(text)
    // As the tool does: the input starts a turn
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return true
  }
  interrupt() {
    this.stops++
  }
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
    const h = new Handle(opts.sessionId, emit)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

const processes: AgentProcessHost = { spawn: () => new FakeProcess() }

const dir = tempRoot('overload-retry-')
let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  store = new Store()
  events = []
})
afterEach(() => {
  vi.useRealTimers()
})

function host(kept: ReadonlySet<string> = new Set()) {
  const adapter = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, dir, { processes, keptSessions: kept })
  const session = (id: string) => mgr.listSessions().find((s) => s.id === id)!
  return { mgr, adapter, session, rpc: createRpcHandler(mgr, adapters) }
}

/** A session in a turn on a first host */
async function working() {
  const a = host()
  const p = (await a.rpc('projects.add', { path: dir })) as { id: string }
  const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  a.adapter.last.emit({ type: 'state_change', sessionId: s.id, state: 'working' })
  return { a, id: s.id }
}

const retryLines = (id: string) => events.filter((e) => e.type === 'notice' && e.sessionId === id && e.label === 'retry') as Extract<NormalizedEvent, { type: 'notice' }>[]
const errors = (id: string) => events.filter((e) => e.type === 'error' && e.sessionId === id) as Extract<NormalizedEvent, { type: 'error' }>[]
const key = (id: string) => `overload_retry:${id}`

describe('a turn the provider ended for want of capacity (#1693)', () => {
  it('stays in its turn, says when it is retried, and is continued after the wait through Centralu’s channel', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    // Not ended: no error, still working, and the line says what happens
    expect(errors(id)).toHaveLength(0)
    expect(a.session(id).state).toBe('working')
    expect(retryLines(id)).toHaveLength(1)
    expect(retryLines(id)[0]!.text).toMatch(/not your usage limit.*in 30 s \(retry 1 of 4\)/)
    expect(a.adapter.last.sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] - 1)
    expect(a.adapter.last.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.adapter.last.sent).toEqual([RETRY_NOTE])
    expect(a.session(id).state).toBe('working')
    expect(store.settings.appSetting(key(id))).toBeNull()
  })

  it('waits longer each time, and once the retries are spent the error ends the turn, saying how often it was retried', async () => {
    const { a, id } = await working()
    for (let i = 0; i < DELAYS_MS.length; i++) {
      a.adapter.last.emit(overloaded(id))
      expect(retryLines(id)).toHaveLength(i + 1)
      expect(retryLines(id)[i]!.text).toContain(`(retry ${i + 1} of ${DELAYS_MS.length})`)
      await vi.advanceTimersByTimeAsync(DELAYS_MS[i]!)
      expect(a.adapter.last.sent).toHaveLength(i + 1)
    }
    expect(errors(id)).toHaveLength(0)
    a.adapter.last.emit(overloaded(id))
    expect(errors(id)).toHaveLength(1)
    expect(errors(id)[0]!.error.message).toContain('Selected model is at capacity')
    expect(errors(id)[0]!.error.message).toContain('retried this turn 4 times')
    expect(a.session(id).state).toBe('error')
    // Nothing is waiting any more
    await vi.advanceTimersByTimeAsync(DELAYS_MS[3] * 2)
    expect(a.adapter.last.sent).toHaveLength(4)
  })

  it('starts the count over once the turn finishes', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
    a.adapter.last.emit({ type: 'turn_complete', sessionId: id })
    a.adapter.last.emit({ type: 'state_change', sessionId: id, state: 'working' })
    a.adapter.last.emit(overloaded(id))
    expect(retryLines(id).at(-1)!.text).toContain('in 30 s (retry 1 of 4)')
  })

  it.each([
    ['a usage limit', { code: 'internal', message: 'You hit your usage limit', retryable: true }],
    ['any other error', { code: 'internal', message: 'stream disconnected before completion', retryable: true }],
  ] as const)('does not retry %s', async (_, error) => {
    const { a, id } = await working()
    a.adapter.last.emit({ type: 'error', sessionId: id, error })
    expect(errors(id)).toHaveLength(1)
    expect(retryLines(id)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(a.adapter.last.sent).toHaveLength(0)
  })

  it('is cancelled by the person’s Stop: the turn ends stopped, and nothing is sent when the time comes', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await a.rpc('agents.interrupt', { sessionId: id })
    expect(a.session(id)).toMatchObject({ state: 'waiting_input' })
    expect(events.some((e) => e.type === 'state_change' && e.sessionId === id && e.state === 'waiting_input' && e.reason === 'interrupted')).toBe(true)
    expect(store.settings.appSetting(key(id))).toBeNull()
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(a.adapter.last.sent).toHaveLength(0)
    // The tool had no turn to stop
    expect(a.adapter.last.stops).toBe(0)
    // A new turn of the person's starts the count from none
    a.adapter.last.emit({ type: 'state_change', sessionId: id, state: 'working' })
    a.adapter.last.emit(overloaded(id))
    expect(retryLines(id).at(-1)!.text).toContain('(retry 1 of 4)')
  })

  it('is cancelled by a message of the person’s, which carries the work on', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await a.mgr.send(id, 'try again yourself')
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(a.adapter.last.sent).toEqual(['try again yourself'])
  })

  it('a host swap during the wait: the next host waits out what is left, and sends it once', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await vi.advanceTimersByTimeAsync(10_000)
    await a.mgr.detachAll()
    // The leaving host sends nothing, and the wait stays stored for the next
    expect(store.settings.appSetting(key(id))).not.toBeNull()
    const b = host(new Set([id]))
    await b.mgr.adoptKept([{ sessionId: id, tool: 'claude', process: new FakeProcess() }])
    expect(b.session(id).state).toBe('working')
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] - 10_000 - 1)
    expect(b.adapter.last.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(b.adapter.last.sent).toEqual([RETRY_NOTE])
    await vi.advanceTimersByTimeAsync(DELAYS_MS[3])
    expect(b.adapter.last.sent).toHaveLength(1)
    expect(a.adapter.last.sent).toHaveLength(0)
  })

  it('two hosts holding the same wait send it once between them', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    // The next host starts while this one still serves (a swap): both have a timer on the one record
    const b = host(new Set([id]))
    await b.mgr.adoptKept([{ sessionId: id, tool: 'claude', process: new FakeProcess() }])
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
    expect(a.adapter.last.sent.length + b.adapter.last.sent.length).toBe(1)
  })

  it('a start after the time passed long ago does not continue the person’s turn: it is a turn a quit cut', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await a.mgr.disposeAll()
    await vi.advanceTimersByTimeAsync(11 * 60_000 + DELAYS_MS[0])
    const b = host()
    expect(b.session(id)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    expect(store.settings.appSetting(key(id))).toBeNull()
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
    expect(b.adapter.created).toHaveLength(0)
  })

  it('a start soon after continues it even where no process was kept: the session wakes for the note and stays in its turn', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await a.mgr.disposeAll()
    const b = host()
    expect(b.session(id).state).toBe('working')
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
    await vi.waitFor(() => expect(b.adapter.last?.sent).toEqual([RETRY_NOTE]))
    expect(b.session(id).state).toBe('working')
  })
})
