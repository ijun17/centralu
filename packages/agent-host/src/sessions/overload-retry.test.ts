import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, InputObserver, SessionHandle } from '../adapters/contract.js'
import { SERVER_OVERLOADED } from '../adapters/overloaded.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'
import { isCentraluNote, RETRY_NOTE } from '../adapters/input-receipts.js'
import { DELAYS_MS } from './overload-retry.js'

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
  /** Set by a test: the next person's message is refused */
  refuseSend = false
  /** Set by `slowTake`: the tool is slow to say it took an input */
  sendTracked?: (text: string, observer?: InputObserver) => Promise<void>
  private pending: { fail(e: Error): void } | null = null
  send(text: string) {
    if (this.refuseSend && text !== RETRY_NOTE) throw new Error('the tool refused the message')
    this.sent.push(text)
    // As the tool does: the input starts a turn
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  /** The tool holds the next tracked input (Codex says it took one only when its turn is named: up to 90 s): returns what makes it take it */
  slowTake(): () => void {
    let take = () => {}
    this.sendTracked = (text) => {
      this.send(text)
      return new Promise<void>((resolve, reject) => {
        take = resolve
        this.pending = { fail: reject }
      })
    }
    return () => take()
  }
  /** The tool turns the input it holds down on its own (not for a stop) */
  refuseHeld(e: Error) {
    this.pending?.fail(e)
    this.pending = null
  }
  respondApproval() {
    return true
  }
  interrupt() {
    this.stops++
    // As the tool does: the input it had not taken fails with the stop
    this.pending?.fail(new Error('The parent note was stopped before it finished'))
    this.pending = null
  }
  async dispose() {}
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  /** Set by a test: the tool cannot be started, so a message that has to wake the session is refused */
  failCreate = false
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
    if (this.failCreate) throw new Error('the tool will not start')
    const h = new Handle(opts.sessionId, emit)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

const dir = tempRoot('overload-retry-')
let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  store = new Store()
  events = []
  leavingAtError = []
})
afterEach(() => {
  vi.useRealTimers()
})

/** Whether the host was already marked as leaving when each error was said (a quit names a turn's end by that) */
let leavingAtError: boolean[]

function host() {
  const adapter = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr: SessionManager = new SessionManager(
    store,
    adapters,
    (e) => {
      events.push(e)
      if (e.type === 'error') leavingAtError.push(mgr.tenure.disposing)
    },
    undefined,
    dir,
  )
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

describe('a turn the provider ended for want of capacity (#1693)', () => {
  it('stays in its turn, says when it is retried, and is continued after the wait through Centralu’s channel', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    // Not ended: no error, still working, and the line says what happens
    expect(errors(id)).toHaveLength(0)
    expect(a.session(id).state).toBe('working')
    expect(retryLines(id)).toHaveLength(1)
    expect(retryLines(id)[0]!.text).toMatch(/not your usage limit.*in 30 seconds \(retry 1 of 4\)/)
    expect(a.adapter.last.sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] - 1)
    expect(a.adapter.last.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.adapter.last.sent).toEqual([RETRY_NOTE])
    expect(a.session(id).state).toBe('working')
  })

  it('waits longer each time, and once the retries are spent the error ends the turn, saying how often it was retried', async () => {
    const { a, id } = await working()
    for (let i = 0; i < DELAYS_MS.length; i++) {
      a.adapter.last.emit(overloaded(id))
      expect(retryLines(id)).toHaveLength(i + 1)
      expect(retryLines(id)[i]!.text).toContain(`(retry ${i + 1} of ${DELAYS_MS.length})`)
      // The wait in words a person reads: 30 seconds, then whole minutes (never `120 s`)
      expect(retryLines(id)[i]!.text).toContain(`in ${['30 seconds', '2 minutes', '5 minutes', '10 minutes'][i]} (retry`)
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
    expect(retryLines(id).at(-1)!.text).toContain('in 30 seconds (retry 1 of 4)')
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
    await a.mgr.inputs.send(id, 'try again yourself')
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(a.adapter.last.sent).toEqual(['try again yourself'])
  })

  it('a host that quits during the wait ends the turn with the error it stood in for, and no later host sends anything', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await a.mgr.tenure.disposeAll()
    expect(errors(id)).toHaveLength(1)
    expect(errors(id)[0]!.error.message).toContain('Selected model is at capacity')
    expect(errors(id)[0]!.error.message).toMatch(/going to retry this turn, but it restarted first/)
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(a.adapter.last.sent).toHaveLength(0)
    const b = host()
    expect(b.session(id).state).toBe('error')
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(b.adapter.created).toHaveLength(0)
  })

  it('the note is sent only while the retry stands, even when a restart is waited out between the time and the tool', async () => {
    // A restart under way holds every input (`deferredRestarts`): the note is on its way, not yet handed to the tool
    const hold = async (id: string, a: Awaited<ReturnType<typeof working>>['a']) => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      ;(a.mgr as unknown as { restartPolicy: { deferredRestarts: Map<string, Promise<void>> } }).restartPolicy.deferredRestarts.set(id, gate)
      await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
      return release
    }
    {
      // Stop while it waits: the Stop ends the turn (it did not find the retry any more), and nothing is sent after
      const { a, id } = await working()
      a.adapter.last.emit(overloaded(id))
      const release = await hold(id, a)
      await a.rpc('agents.interrupt', { sessionId: id })
      expect(a.session(id).state).toBe('waiting_input')
      release()
      await vi.advanceTimersByTimeAsync(1)
      expect(a.adapter.last.sent).toHaveLength(0)
    }
    {
      // A message of the person's meanwhile: theirs goes in, the note does not
      const { a, id } = await working()
      a.adapter.last.emit(overloaded(id))
      const release = await hold(id, a)
      const sending = a.mgr.inputs.send(id, 'try again yourself')
      release()
      await sending
      await vi.advanceTimersByTimeAsync(1)
      expect(a.adapter.last.sent).toEqual(['try again yourself'])
    }
  })

  describe('once the note is with the tool, the turn is the tool’s', () => {
    /** The retry's note is handed to a tool that has not said it took it yet */
    async function handed() {
      const { a, id } = await working()
      const take = a.adapter.last.slowTake()
      a.adapter.last.emit(overloaded(id))
      await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
      expect(a.adapter.last.sent).toEqual([RETRY_NOTE])
      return { a, id, take }
    }

    it('a Stop stops the tool’s turn too, and ends nothing else', async () => {
      const { a, id } = await handed()
      await a.rpc('agents.interrupt', { sessionId: id })
      expect(a.adapter.last.stops).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(errors(id)).toHaveLength(0)
    })

    it('a message of the person’s joins that turn: when the tool refuses it, the turn is not ended by the retry', async () => {
      const { a, id, take } = await handed()
      a.adapter.last.refuseSend = true
      await expect(a.mgr.inputs.send(id, 'try again yourself')).rejects.toThrow('refused')
      expect(errors(id)).toHaveLength(0)
      expect(a.session(id).state).toBe('working')
      take()
      await vi.advanceTimersByTimeAsync(1)
      expect(errors(id)).toHaveLength(0)
    })

    it('a message of the person’s joined it: the note refused afterwards is not a failure of theirs', async () => {
      const { a, id } = await handed()
      await a.mgr.inputs.send(id, 'try again yourself')
      a.adapter.last.refuseHeld(new Error('the tool turned the note down'))
      await vi.advanceTimersByTimeAsync(1)
      expect(errors(id)).toHaveLength(0)
      expect(a.session(id).state).toBe('working')
    })

    it('a message of the person’s starts the count over, as it does for a retry that waits', async () => {
      const { a, id, take } = await handed()
      await a.mgr.inputs.send(id, 'try again yourself')
      take()
      await vi.advanceTimersByTimeAsync(1)
      a.adapter.last.emit(overloaded(id))
      expect(retryLines(id).at(-1)!.text).toContain('(retry 1 of 4)')
    })

    it('a host that leaves ends nothing for it: the tool’s turn leaves as any turn does', async () => {
      const { a, id } = await handed()
      await a.mgr.tenure.disposeAll()
      expect(errors(id)).toHaveLength(0)
      expect(a.session(id).state).toBe('working')
    })
  })

  it('a host that leaves says the turn’s end before it is marked as leaving: the end is the provider’s error, not a stop of the quit’s', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    await a.mgr.tenure.disposeAll()
    expect(errors(id)).toHaveLength(1)
    expect(leavingAtError).toEqual([false])
  })

  it('a message of the person’s that is refused leaves no turn waiting for nothing: the error ends it', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    ;(a.mgr as unknown as { handles: Map<string, unknown> }).handles.delete(id)
    a.adapter.failCreate = true
    await expect(a.mgr.inputs.send(id, 'hello', undefined, undefined)).rejects.toThrow()
    expect(errors(id)).toHaveLength(1)
    expect(errors(id)[0]!.error.message).toMatch(/message to the session came first and was not delivered/)
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(a.adapter.created).toHaveLength(1)
  })

  it('a session with no process at the time ends with the error and a reason, not in a turn that never goes on', async () => {
    const { a, id } = await working()
    a.adapter.last.emit(overloaded(id))
    ;(a.mgr as unknown as { handles: Map<string, unknown> }).handles.delete(id)
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
    expect(errors(id)).toHaveLength(1)
    expect(errors(id)[0]!.error.message).toMatch(/could not retry the turn: the session has no process left/)
    expect(a.session(id).state).toBe('error')
  })

  it('the note is one of Centralu’s own: read back from a tool’s history it is never the person’s message', () => {
    expect(isCentraluNote(RETRY_NOTE)).toBe(true)
    expect(RETRY_NOTE).toContain('Check what already happened before repeating a step.')
    expect(isCentraluNote('The model provider’s servers were at capacity, please wait')).toBe(false)
  })
})
