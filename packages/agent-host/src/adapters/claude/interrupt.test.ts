import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
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
 * Stopped is said only once the CLI says so. `interrupt()` used to emit waiting_input/interrupted before the SDK's
 * interrupt had answered, so a rejected interrupt showed the turn as stopped while the CLI kept working, and the
 * "Could not stop" that followed came after a state the host had already left the turn by. Codex waits for its
 * `turn/completed`; Claude now waits for the interrupt's answer, within a bound.
 */
describe('a Stop Claude has not confirmed (interrupt)', () => {
  afterEach(() => {
    cli.interrupt = async () => undefined
  })
  const stoppedStates = (events: NormalizedEvent[]) =>
    events.filter((e) => e.type === 'state_change' && e.state === 'waiting_input' && e.reason === 'interrupted')

  it('says the turn stopped only after the interrupt answers', async () => {
    let confirm: () => void = () => {}
    cli.interrupt = () => new Promise((resolve) => (confirm = () => resolve(undefined)))
    const { handle, events } = await session()
    handle.send('do a long task')
    cli.push(delta('working on it'))
    await tick()
    handle.interrupt()
    await tick()
    expect(stoppedStates(events)).toEqual([])

    confirm()
    await tick()
    expect(stoppedStates(events)).toHaveLength(1)
    await handle.dispose()
  })

  it('a rejected interrupt keeps the turn running and says it could not stop', async () => {
    cli.interrupt = async () => {
      throw new Error('the control request was lost')
    }
    const { handle, events, errors } = await session()
    handle.send('do a long task')
    cli.push(delta('working on it'))
    await tick()
    handle.interrupt()
    await tick()

    expect(stoppedStates(events)).toEqual([])
    expect(errors().map((e) => e.type === 'error' && e.error.message)).toEqual(['Could not stop: the control request was lost'])
    // The CLI went on: its output still reads as the turn running, and its own ending is not taken for our stop
    cli.push(delta(' and more'))
    cli.push(interrupted)
    await tick()
    expect(events.some((e) => e.type === 'message_delta' && e.text === ' and more')).toBe(true)
    expect(errors()).toHaveLength(2)
    await handle.dispose()
  })

  it("the stopped turn's result confirms the stop when the interrupt's answer never comes", async () => {
    cli.interrupt = () => new Promise(() => {})
    const { handle, events, errors } = await session({ stopConfirmMs: 20 })
    handle.send('do a long task')
    cli.push(delta('working on it'))
    await tick()
    handle.interrupt()
    cli.push(interrupted)
    await vi.waitFor(() => expect(stoppedStates(events)).toHaveLength(1), { timeout: 5_000 * SLOW })
    // The bound has passed by now, and the turn it waited on is over: nothing says it could not stop
    await new Promise((r) => setTimeout(r, 60))
    expect(errors()).toEqual([])
    await handle.dispose()
  })

  it('a Stop pressed with no turn running is said at once, as before', async () => {
    cli.interrupt = () => new Promise(() => {})
    const { handle, events } = await session()
    handle.interrupt()
    expect(stoppedStates(events)).toHaveLength(1)
    await handle.dispose()
  })

  it('an interrupt that never answers is said to have failed once its bound passes, and a late answer still stops', async () => {
    let confirm: () => void = () => {}
    cli.interrupt = () => new Promise((resolve) => (confirm = () => resolve(undefined)))
    const { handle, events, errors } = await session({ stopConfirmMs: 20 })
    handle.send('do a long task')
    cli.push(delta('working on it'))
    await tick()
    handle.interrupt()

    await vi.waitFor(() => expect(errors()).toHaveLength(1), { timeout: 5_000 * SLOW })
    expect(errors()[0]).toMatchObject({ error: { message: expect.stringMatching(/^Could not stop: Claude Code did not confirm the stop/) } })
    expect(stoppedStates(events)).toEqual([])

    confirm()
    await tick()
    expect(stoppedStates(events)).toHaveLength(1)
    expect(errors()).toHaveLength(1)
    await handle.dispose()
  })
})
