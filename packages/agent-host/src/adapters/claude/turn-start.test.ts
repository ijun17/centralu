import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * Input the CLI starts no turn for (#2377). The fake CLI does what CLI 2.1.296 was measured to do (SDK 0.3.263, 2026-11-21): it sends a
 * turn's `init` only when it reads an input, never at start, and an input whose id it has already read starts nothing and is never
 * answered. What it does with each new input is the test's (`cli.answer`): by default its receipt and a turn for it alone. A Stop
 * cancels what `cli.cancelled` names
 */
type Input = { uuid: string; message: { content: { text: string }[] } }
const cli = vi.hoisted(() => ({
  version: '2.1.296',
  read: [] as Input[],
  answer: null as null | ((input: Input, say: (m: unknown) => void) => void),
  cancelled: [] as string[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<Input> }) => {
    const out: unknown[] = []
    let wake: (() => void) | null = null
    const say = (m: unknown) => {
      out.push(m)
      wake?.()
      wake = null
    }
    const init = { type: 'system', subtype: 'init', claude_code_version: cli.version, capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] }
    void (async () => {
      for await (const input of prompt) {
        if (cli.read.some((r) => r.uuid === input.uuid)) continue
        cli.read.push(input)
        if (cli.answer) cli.answer(input, say)
        else {
          say({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'queued' })
          say(init)
          say({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: input.uuid, message: { id: `m-${input.uuid}`, role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
          say({ type: 'result', subtype: 'success', is_error: false, result: 'done', user_message_uuid: input.uuid, user_message_uuids: [input.uuid], modelUsage: {} })
        }
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (out.length > 0) yield out.shift()
          await new Promise<void>((r) => (wake = r))
        }
      },
      interrupt: async () => ({ cancelled: cli.cancelled.splice(0), still_queued: [] }),
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')
const { isCentraluInputId } = await import('../input-receipts.js')
const { TURN_START_MS } = await import('./turn-start.js')

const RACE = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.'

/** `agentVersion`: the version the host knows the process runs before it says (`CreateSessionOpts.agentVersion`) */
async function session(id: string, agentVersion?: string) {
  cli.read.length = 0
  const events: NormalizedEvent[] = []
  const opts = { sessionId: id, cwd: '/tmp', permissionPreset: 'auto' as const, ...(agentVersion ? { agentVersion } : {}) }
  const handle = await new ClaudeAdapter({ retryDelay: () => 10 }).createSession(opts, (e) => events.push(e))
  return { handle, events }
}

/** A session whose CLI has run a turn to its end, so its init said what it sends */
async function ran(id: string) {
  const s = await session(id)
  await s.handle.sendTracked!('hello')
  await vi.waitFor(() => expect(s.events.at(-1)).toMatchObject({ type: 'turn_complete' }))
  return s
}

afterEach(() => {
  cli.answer = null
  cli.version = '2.1.296'
  vi.useRealTimers()
})

describe('a turn that lost the sign-in refresh race goes again under an id the CLI has not read (#2377)', () => {
  it('runs, and its end answers the input by the input’s own id', async () => {
    const { handle, events } = await session('race')
    // The first read loses the race, as the CLI writes it; whatever comes after runs
    cli.answer = (input, say) => {
      cli.answer = null
      say({ type: 'system', subtype: 'init', claude_code_version: cli.version, capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] })
      say({ type: 'assistant', parent_tool_use_id: null, error: 'server_error', message: { id: 'race', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: RACE }] } })
      say({ type: 'result', subtype: 'success', is_error: true, result: RACE, user_message_uuids: [input.uuid], modelUsage: {} })
    }
    await handle.sendTracked!('the task')
    expect(cli.read).toHaveLength(2)
    expect(cli.read[1]!.uuid).not.toBe(cli.read[0]!.uuid)
    expect(isCentraluInputId(cli.read[1]!.uuid)).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn_complete' })
    expect(handle.queuedInputs!()).toBe(0)
    await handle.dispose()
  })

  it('a Stop while the resent message waits in the CLI says it was not delivered', async () => {
    const { handle, events } = await ran('race-stop')
    cli.answer = (input, say) => {
      // The resend: the CLI holds it, and the Stop cancels it by the id it was sent under
      cli.answer = (resent) => cli.cancelled.push(resent.uuid)
      say({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'queued' })
      say({ type: 'system', subtype: 'init', claude_code_version: cli.version, capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] })
      say({ type: 'assistant', parent_tool_use_id: null, error: 'server_error', message: { id: 'race', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: RACE }] } })
      say({ type: 'result', subtype: 'success', is_error: true, result: RACE, user_message_uuids: [input.uuid], modelUsage: {} })
    }
    handle.send('hello again', { origin: { kind: 'human' } })
    await vi.waitFor(() => expect(cli.cancelled).toHaveLength(1))
    handle.interrupt()
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error' && /^1 message\(s\) were still queued/.test(e.error.message))).toBe(true))
    expect(handle.queuedInputs!()).toBe(0)
    await handle.dispose()
  })
})

describe('input the CLI starts no turn for (#2377)', () => {
  it('a tracked input is failed after the wait, and the session does not stay working', async () => {
    vi.useFakeTimers()
    const { handle, events } = await ran('silent-tracked')
    cli.answer = () => {}
    const sent = handle.sendTracked!('the task')
    const failed = expect(sent).rejects.toThrow(/started no turn/)
    await vi.advanceTimersByTimeAsync(TURN_START_MS - 1)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { retryable: true } })
    expect(handle.queuedInputs!()).toBe(0)
    await handle.dispose()
  })

  it('the person’s input is said not delivered', async () => {
    vi.useFakeTimers()
    const { handle, events } = await ran('silent-person')
    cli.answer = () => {}
    handle.send('hello', { origin: { kind: 'human' } })
    await vi.advanceTimersByTimeAsync(TURN_START_MS)
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { message: expect.stringMatching(/^1 message\(s\) got no turn from Claude Code/) } })
    expect(handle.queuedInputs!()).toBe(0)
    await handle.dispose()
  })

  it('a long turn is left alone once the CLI said it read the input, its init still to come (an MCP server connecting)', async () => {
    vi.useFakeTimers()
    const { handle, events } = await ran('in-time')
    // The delivery receipt the CLI says before anything else, then nothing for longer than the wait
    cli.answer = (input, say) => say({ type: 'command_lifecycle', command_uuid: input.uuid, state: 'queued' })
    const sent = handle.sendTracked!('the task')
    await vi.advanceTimersByTimeAsync(TURN_START_MS * 2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(handle.queuedInputs!()).toBe(1)
    await handle.dispose()
    await sent.catch(() => {})
  })

  it('a late receipt for the input before it does not end the wait', async () => {
    vi.useFakeTimers()
    const { handle, events } = await ran('stale')
    const before = cli.read[0]!.uuid
    cli.answer = (_input, say) => say({ type: 'command_lifecycle', command_uuid: before, state: 'completed' })
    const sent = handle.sendTracked!('the task')
    const failed = expect(sent).rejects.toThrow(/started no turn/)
    await vi.advanceTimersByTimeAsync(TURN_START_MS)
    await failed
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    await handle.dispose()
  })

  it('a CLI not known to send the receipt is not waited for: an input it read is never given back to run twice', async () => {
    vi.useFakeTimers()
    cli.version = '2.1.280'
    const { handle, events } = await ran('older')
    cli.answer = () => {}
    handle.send('hello again', { origin: { kind: 'human' } })
    await vi.advanceTimersByTimeAsync(TURN_START_MS * 2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    await handle.dispose()
  })
})

describe('the first input of a new process (#2377)', () => {
  it('a resumed process of a version known to send the receipt, which drops its first input, has it given back after the wait', async () => {
    vi.useFakeTimers()
    const { handle, events } = await session('resumed-dropped', cli.version)
    cli.answer = () => {}
    const sent = handle.sendTracked!('the wake')
    const failed = expect(sent).rejects.toThrow(/started no turn/)
    await vi.advanceTimersByTimeAsync(TURN_START_MS)
    await failed
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { retryable: true } })
    expect(handle.queuedInputs!()).toBe(0)
    await handle.dispose()
  })

  it('one of an unknown version is not waited for before its init says', async () => {
    vi.useFakeTimers()
    const { handle, events } = await session('unknown-version')
    cli.answer = () => {}
    handle.send('hello', { origin: { kind: 'human' } })
    await vi.advanceTimersByTimeAsync(TURN_START_MS * 2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    await handle.dispose()
  })

  it('is tracked before the CLI’s first init: taken when a turn names it, not when written', async () => {
    const { handle } = await session('first')
    let taken = false
    let named: (() => void) | undefined
    cli.answer = (input, say) => {
      say({ type: 'system', subtype: 'init', claude_code_version: cli.version, capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] })
      named = () => say({ type: 'result', subtype: 'success', is_error: false, result: 'done', user_message_uuids: [input.uuid], modelUsage: {} })
    }
    expect(handle.sendTracked).toBeDefined()
    const sent = handle.sendTracked!('the wake', { accepted: () => (taken = true), complete: () => {}, fail: () => {} })
    await vi.waitFor(() => expect(named).toBeDefined())
    await new Promise((r) => setTimeout(r, 10))
    expect(taken).toBe(false)
    named!()
    await sent
    expect(taken).toBe(true)
    await handle.dispose()
  })

  it('a CLI whose init says it cannot track took it when written, and is sent untracked after', async () => {
    cli.version = '2.1.200'
    const { handle } = await session('old')
    // An older CLI names no inputs in its result
    cli.answer = (_input, say) => {
      say({ type: 'system', subtype: 'init', claude_code_version: cli.version })
      say({ type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: {} })
    }
    await handle.sendTracked!('the wake')
    expect(handle.sendTracked).toBeUndefined()
    await handle.dispose()
  })
})
