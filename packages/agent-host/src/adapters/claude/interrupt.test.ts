import { afterEach, describe, expect, it, vi } from 'vitest'
import { STOP_NOT_CONFIRMED_LABEL, transition, type NormalizedEvent, type SessionState } from '@cc/protocol'
import { SLOW } from '../../../../../tooling/test-timing.js'

/**
 * What Stop leaves behind (#168). The CLI closes an interrupted turn with an
 * `error_during_execution` result — if that result is treated as a failure marker, a turn the
 * person stopped on purpose gets recorded as "Turn failed". If the stop happens mid-write, the
 * assistant message for that chunk never arrives, and the "body already went out as deltas" flag
 * that got set at that point must not also cause the next turn's whole-response message to be
 * dropped.
 *
 * The SDK is swapped for a fake, and the test pushes the CLI's messages in one by one to run the
 * whole of the adapter's loop.
 */
const cli = vi.hoisted(() => {
  const inbox: unknown[] = []
  let wake: (() => void) | null = null
  return {
    /** What the SDK's interrupt answers; a test replaces it, `afterEach` puts back the one that confirms at once */
    interrupt: async (): Promise<unknown> => undefined,
    push(m: unknown) {
      inbox.push(m)
      wake?.()
      wake = null
    },
    async *stream() {
      for (;;) {
        while (inbox.length > 0) yield inbox.shift()
        await new Promise<void>((r) => (wake = r))
      }
    },
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => cli.stream(),
    interrupt: () => cli.interrupt(),
    close: () => {},
    supportedCommands: async () => [],
    getContextUsage: async () => undefined,
  }),
}))

const { ClaudeAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 5))
const delta = (text: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
})
const interrupted = { type: 'result', subtype: 'error_during_execution', is_error: true, modelUsage: {} }

async function session(options: ConstructorParameters<typeof ClaudeAdapter>[0] = {}) {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter(options).createSession(
    { sessionId: 's1', cwd: '/tmp', permissionPreset: 'auto' },
    (e) => events.push(e),
  )
  return { handle, events, errors: () => events.filter((e) => e.type === 'error') }
}

describe('stopping a turn in Claude (#168)', () => {
  it('does not leave an interrupted error_during_execution as a failure — the same ending for another reason is still a failure', async () => {
    const { handle, events, errors } = await session()
    handle.send('do a long task')
    cli.push(delta('working on it'))
    await tick()
    handle.interrupt()
    cli.push(interrupted)
    await tick()

    expect(errors()).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' })

    // The same ending for a turn that was not stopped is a failure — the flag is only consumed once.
    handle.send('again')
    cli.push(interrupted)
    await tick()
    expect(errors()).toHaveLength(1)
    await handle.dispose()
  })

  it('pressing Stop on an idle session does not swallow a real failure on the next turn', async () => {
    const { handle, errors } = await session()
    handle.interrupt()
    handle.send('do it')
    cli.push(interrupted)
    await tick()
    expect(errors()).toHaveLength(1)
    await handle.dispose()
  })

  it('a whole-response message on the next turn still shows up in the UI, even after stopping mid-write', async () => {
    const { handle, events } = await session()
    handle.send('write something long')
    cli.push(delta('half-written text'))
    await tick()
    handle.interrupt()
    cli.push(interrupted) // The assistant message for the partial block never arrives.
    await tick()

    // A whole-response message that arrives without any deltas (e.g., a local response like /usage).
    handle.send('/usage')
    cli.push({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Usage 42%' }] } })
    await tick()
    expect(events.some((e) => e.type === 'message_delta' && e.text === 'Usage 42%')).toBe(true)
    await handle.dispose()
  })
})

/**
 * Stopped is said only once the CLI says so (#1060). `interrupt()` used to emit waiting_input/interrupted before the
 * SDK's interrupt had answered, so a rejected interrupt showed the turn as stopped while the CLI kept working. A Stop
 * that has not taken effect is a notice, not an error: an error moves the session to `error`, which ends the turn for
 * the host, and the confirmation that may still come (`waiting_input`) is not a move `error` allows. So the states are
 * read through the state machine itself (`transition`), as the host and the window apply them.
 */
describe('a Stop Claude has not confirmed (interrupt)', () => {
  afterEach(() => {
    cli.interrupt = async () => undefined
  })
  const stoppedStates = (events: NormalizedEvent[]) =>
    events.filter((e) => e.type === 'state_change' && e.state === 'waiting_input' && e.reason === 'interrupted')
  /** The session's state after these events, from idle, through the shared state machine; an illegal move is a failure */
  const stateOf = (events: NormalizedEvent[]): SessionState => {
    let state: SessionState = 'idle'
    for (const e of events) {
      const step = transition(state, e)
      expect(step.illegal, `${e.type} from ${state}`).toBe(false)
      state = step.state
    }
    return state
  }
  const stopNotices = (events: NormalizedEvent[]) =>
    events.flatMap((e) => (e.type === 'notice' && e.label === STOP_NOT_CONFIRMED_LABEL ? [e.text] : []))
  /** A turn running: sent, and the model's first words arrived */
  async function running(options: ConstructorParameters<typeof ClaudeAdapter>[0] = {}) {
    const s = await session(options)
    s.handle.send('do a long task')
    cli.push(delta('working on it'))
    await tick()
    expect(stateOf(s.events)).toBe('working')
    return s
  }

  it('says the turn stopped only after the interrupt answers', async () => {
    let confirm: () => void = () => {}
    cli.interrupt = () => new Promise((resolve) => (confirm = () => resolve(undefined)))
    const { handle, events } = await running()
    handle.interrupt()
    await tick()
    expect(stateOf(events)).toBe('working')

    confirm()
    await tick()
    expect(stateOf(events)).toBe('waiting_input')
    expect(stoppedStates(events)).toHaveLength(1)
    await handle.dispose()
  })

  it('a rejected interrupt keeps the turn working, says why in a notice, and its own ending is its own', async () => {
    cli.interrupt = async () => {
      throw new Error('the control request was lost')
    }
    const { handle, events, errors } = await running()
    handle.interrupt()
    await tick()

    expect(stateOf(events)).toBe('working')
    expect(errors()).toEqual([])
    expect(stopNotices(events)).toEqual(['Could not stop: the control request was lost. The turn is still running.'])
    // The CLI went on, and the turn's ending is not taken for our stop: an error_during_execution is a failure again
    cli.push(delta(' and more'))
    cli.push(interrupted)
    await tick()
    expect(errors()).toHaveLength(1)
    expect(stateOf(events)).toBe('error')
    await handle.dispose()
  })

  it("the stopped turn's result confirms the stop when the interrupt's answer never comes", async () => {
    cli.interrupt = () => new Promise(() => {})
    const { handle, events } = await running({ stopConfirmMs: 20 })
    handle.interrupt()
    cli.push(interrupted)
    await vi.waitFor(() => expect(stoppedStates(events)).toHaveLength(1), { timeout: 5_000 * SLOW })
    // The bound has passed by now, and the turn it waited on is over: nothing says it could not stop
    await new Promise((r) => setTimeout(r, 60))
    expect(stopNotices(events)).toEqual([])
    expect(stateOf(events)).toBe('waiting_input')
    await handle.dispose()
  })

  it('a Stop pressed with no turn running is said at once, as before', async () => {
    cli.interrupt = () => new Promise(() => {})
    const { handle, events } = await session()
    handle.interrupt()
    expect(stoppedStates(events)).toHaveLength(1)
    await handle.dispose()
  })

  it('an interrupt that never answers is said in a notice once its bound passes; the turn stays working, and a late answer still stops it', async () => {
    let confirm: () => void = () => {}
    cli.interrupt = () => new Promise((resolve) => (confirm = () => resolve(undefined)))
    const { handle, events, errors } = await running({ stopConfirmMs: 20 })
    handle.interrupt()

    await vi.waitFor(() => expect(stopNotices(events)).toHaveLength(1), { timeout: 5_000 * SLOW })
    expect(stopNotices(events)[0]).toMatch(/^Claude Code has not confirmed the stop after \d+ s\. The turn is still running\.$/)
    expect(errors()).toEqual([])
    expect(stateOf(events)).toBe('working')

    confirm()
    await tick()
    expect(stateOf(events)).toBe('waiting_input')
    expect(stoppedStates(events)).toHaveLength(1)
    await handle.dispose()
  })

  it('a second Stop joins the first: one bound, and two answers say stopped once', async () => {
    const answers: (() => void)[] = []
    cli.interrupt = () => new Promise((resolve) => answers.push(() => resolve(undefined)))
    const { handle, events } = await running({ stopConfirmMs: 10_000 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      handle.interrupt()
      vi.advanceTimersByTime(6_000)
      handle.interrupt()
      expect(answers).toHaveLength(2)
      // 10 s after the first Stop: had the second started the bound again, nothing would be said for 6 s more
      vi.advanceTimersByTime(4_001)
      expect(stopNotices(events)).toHaveLength(1)
      // And no second bound runs behind it: a timer of the second Stop's own would speak at 16 s
      vi.advanceTimersByTime(6_500)
      expect(stopNotices(events)).toHaveLength(1)
      expect(stateOf(events)).toBe('working')
    } finally {
      vi.useRealTimers()
    }
    for (const answer of answers) answer()
    await tick()
    expect(stoppedStates(events)).toHaveLength(1)
    expect(stopNotices(events)).toHaveLength(1)
    await handle.dispose()
  })

  it('a Stop pressed after the bound was said starts it again, and an answer to the first still stops the turn', async () => {
    const answers: (() => void)[] = []
    cli.interrupt = () => new Promise((resolve) => answers.push(() => resolve(undefined)))
    const { handle, events } = await running({ stopConfirmMs: 10_000 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      handle.interrupt()
      vi.advanceTimersByTime(10_001)
      expect(stopNotices(events)).toHaveLength(1)
      // Pressed again: the window says "Stopping…" again, so the bound has to be said again if nothing answers
      handle.interrupt()
      vi.advanceTimersByTime(9_000)
      expect(stopNotices(events)).toHaveLength(1)
      vi.advanceTimersByTime(1_001)
      expect(stopNotices(events)).toHaveLength(2)
      expect(stateOf(events)).toBe('working')
    } finally {
      vi.useRealTimers()
    }
    answers[0]!()
    await tick()
    expect(stoppedStates(events)).toHaveLength(1)
    expect(stateOf(events)).toBe('waiting_input')
    await handle.dispose()
  })

  it.each([
    ['a failed result', [{ type: 'result', subtype: 'error_max_turns', is_error: true, modelUsage: {} }]],
    [
      'a usage limit',
      [
        { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 2_000_000_000, rateLimitType: 'five_hour' } },
        { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'limit reached', modelUsage: {} },
      ],
    ],
  ])('a turn that ends in %s while a Stop waits ends as it did: no stopped after it, no notice later', async (_name, ending) => {
    cli.interrupt = () => new Promise(() => {})
    const { handle, events } = await running({ stopConfirmMs: 20 })
    handle.interrupt()
    for (const m of ending) cli.push(m)
    await tick()
    // stateOf fails on an illegal move: waiting_input after error or limited would be one
    expect(['error', 'limited']).toContain(stateOf(events))
    expect(stoppedStates(events)).toEqual([])
    await new Promise((r) => setTimeout(r, 60))
    expect(stopNotices(events)).toEqual([])
    expect(stoppedStates(events)).toEqual([])
    await handle.dispose()
  })

  it("a refusal of one Stop is not the verdict while another Stop's interrupt may still land", async () => {
    const pending: { resolve: () => void; reject: (e: Error) => void }[] = []
    cli.interrupt = () => new Promise((resolve, reject) => pending.push({ resolve: () => resolve(undefined), reject }))
    const { handle, events } = await running()
    handle.interrupt()
    handle.interrupt()
    pending[0]!.reject(new Error('busy'))
    await tick()
    expect(stopNotices(events)).toEqual([])
    pending[1]!.resolve()
    await tick()
    expect(stateOf(events)).toBe('waiting_input')
    await handle.dispose()
  })
})
