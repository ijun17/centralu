import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * What the Claude adapter makes of the CLI's answers to the mailbox's inputs (#1347, docs/plans/mailbox.md §7.1, §7.6.2):
 * the answer to a quiet input (measured on CLI 2.1.296: a `result` 40 to 160 ms later with no turn run) is no finished turn, and a
 * wake that is tracked is taken when a turn runs for it, and failed when the process closes with it still queued.
 */
const wire = vi.hoisted(() => ({
  written: [] as Record<string, unknown>[],
  /** What the CLI says next; the test pushes, the adapter's stream reads */
  say: (_m: Record<string, unknown>) => {},
  /** While set, the CLI reads no further input: what is sent meanwhile waits in the adapter's queue */
  hold: null as Promise<void> | null,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    void (async () => {
      for await (const u of prompt) {
        wire.written.push(u)
        await wire.hold
      }
    })()
    const inbox: Record<string, unknown>[] = []
    let wake: (() => void) | null = null
    wire.say = (m) => {
      inbox.push(m)
      wake?.()
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<unknown>> => {
          while (inbox.length === 0) await new Promise<void>((r) => (wake = r))
          return { value: inbox.shift(), done: false }
        },
      }),
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [{ name: 'goal' }],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 20))

const init = { type: 'system', subtype: 'init', session_id: 'x', claude_code_version: '2.1.296', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'], slash_commands: ['goal'] }
const result = (uuids: string[]) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  user_message_uuids: uuids,
  modelUsage: { claude: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  total_cost_usd: 0.01,
})
const uuidOfLast = () => String(wire.written.at(-1)?.uuid)

async function session(events: NormalizedEvent[]) {
  wire.written.length = 0
  const handle = await new ClaudeAdapter().createSession({ sessionId: 'm1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
  handle.send('start', {})
  await tick()
  wire.say(init)
  await tick()
  return handle
}

describe('the answer to a quiet input', () => {
  it('is no finished turn and no second reading of the usage, and a result that also answers a real input still is one', async () => {
    const events: NormalizedEvent[] = []
    const handle = await session(events)
    // The first turn ends as any turn does
    wire.say(result([uuidOfLast()]))
    await tick()
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(1)
    events.length = 0

    handle.send('<centralu-mail/>', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    await tick()
    const quiet = uuidOfLast()
    wire.say(result([quiet]))
    await tick()
    expect(events.filter((e) => e.type === 'turn_complete' || e.type === 'usage_update')).toEqual([])

    // The same answer to a quiet input and a real one together ends a turn
    handle.send('quiet again', { quiet: true })
    handle.send('a real message', {})
    await tick()
    const ids = wire.written.slice(-2).map((m) => String(m.uuid))
    wire.say(result(ids))
    await tick()
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(1)
    await handle.dispose()
  })
})

describe('a quiet input the CLI ran a turn for', () => {
  it('is a turn: the session went to working and its result, naming only the quiet input, ends it (#1827)', async () => {
    const events: NormalizedEvent[] = []
    const handle = await session(events)
    wire.say(result([uuidOfLast()]))
    await tick()
    events.length = 0

    handle.send('<centralu-nudge/>', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    await tick()
    const quiet = uuidOfLast()
    wire.say({ type: 'assistant', user_message_uuid: quiet, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'carrying on' }] } })
    await tick()
    expect(events.filter((e) => e.type === 'state_change' && e.state === 'working')).toHaveLength(1)
    wire.say(result([quiet]))
    await tick()
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(1)

    // The next quiet input, answered with no turn behind it, is still no finished turn
    events.length = 0
    handle.send('<centralu-nudge/>', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    await tick()
    wire.say(result([uuidOfLast()]))
    await tick()
    expect(events.filter((e) => e.type === 'turn_complete' || e.type === 'usage_update')).toEqual([])
    await handle.dispose()
  })
})

describe('a turn the CLI runs on its own', () => {
  it('names no input, yet is a turn: working when its first output comes, ended by its result (#1830)', async () => {
    const events: NormalizedEvent[] = []
    const handle = await session(events)
    wire.say(result([uuidOfLast()]))
    await tick()
    events.length = 0

    // A background task ended: the CLI answers it by itself, with no input of ours to name
    wire.say({ type: 'assistant', message: { id: 'a9', role: 'assistant', content: [{ type: 'text', text: 'the task finished' }] } })
    await tick()
    expect(events.filter((e) => e.type === 'state_change' && e.state === 'working')).toHaveLength(1)
    wire.say(result([]))
    await tick()
    expect(events.filter((e) => e.type === 'turn_complete')).toHaveLength(1)
    await handle.dispose()
  })
})

describe('a wake that is tracked', () => {
  it('is taken when a turn runs for it, before that turn ends, and failed when the process closes with it still queued', async () => {
    const events: NormalizedEvent[] = []
    const handle = await session(events)
    wire.say(result([uuidOfLast()]))
    await tick()

    const seen: string[] = []
    const wakeIt = handle.sendTracked
    expect(wakeIt).toBeTypeOf('function')
    void handle.sendTracked!('wake', { accepted: () => seen.push('accepted'), complete: () => seen.push('complete'), fail: (e) => seen.push(`fail:${e.message}`) }, { origin: { kind: 'channel', server: 'centralu' } })
    await tick()
    expect(wire.written.at(-1)).toMatchObject({ origin: { kind: 'channel', server: 'centralu' } })
    expect(seen).toEqual([])
    const wakeUuid = uuidOfLast()
    wire.say({ type: 'assistant', user_message_uuid: wakeUuid, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'on it' }] } })
    await tick()
    expect(seen).toEqual(['accepted'])
    wire.say(result([wakeUuid]))
    await tick()
    expect(seen).toEqual(['accepted', 'complete'])

    // A second wake that the process never read: closed with it queued, the observer is told it failed
    void handle.sendTracked!('lost', { accepted: () => seen.push('accepted'), complete: () => seen.push('complete'), fail: () => seen.push('fail') })
    await tick()
    await handle.dispose()
    expect(seen.at(-1)).toBe('fail')
  })
})

describe('the inputs the CLI holds (`queuedInputs`, #2036)', () => {
  it('counts a message written and not yet named by a result, never a quiet note, so the host can send its own after them', async () => {
    const events: NormalizedEvent[] = []
    const handle = await session(events)
    // The first message is unanswered until a result names it
    expect(handle.queuedInputs?.()).toBe(1)
    wire.say(result([uuidOfLast()]))
    await tick()
    expect(handle.queuedInputs?.()).toBe(0)
    // A quiet note starts no turn and is no message
    handle.send('<centralu-nudge/>', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    await tick()
    expect(handle.queuedInputs?.()).toBe(0)
    // The person’s message sent during a turn waits until a turn answers it
    handle.send('a message of the person', { origin: { kind: 'human' } })
    await tick()
    expect(handle.queuedInputs?.()).toBe(1)
    wire.say(result([uuidOfLast()]))
    await tick()
    expect(handle.queuedInputs?.()).toBe(0)
    await handle.dispose()
  })

  it('counts only the messages in the adapter’s own queue, not a quiet note or a parent note waiting there while the CLI is not reading', async () => {
    const events: NormalizedEvent[] = []
    const handle = await session(events)
    wire.say(result([uuidOfLast()]))
    await tick()
    let release!: () => void
    wire.hold = new Promise<void>((r) => (release = r))
    // One message the CLI has read and is busy with; the rest wait in the queue behind it
    handle.send('being read', { origin: { kind: 'human' } })
    await tick()
    handle.send('<centralu-nudge/>', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    void handle.sendTracked?.('a parent note', undefined)
    handle.send('waiting for a turn', { origin: { kind: 'human' } })
    await tick()
    expect(handle.queuedInputs?.()).toBe(2)
    wire.hold = null
    release()
    await handle.dispose()
  })

  it('does not count for ever an input a result that named nothing answered: the next result that names a later input clears it', async () => {
    const events: NormalizedEvent[] = []
    const handle = await session(events)
    wire.say(result([uuidOfLast()]))
    await tick()
    handle.send('stopped before it was answered', { origin: { kind: 'human' } })
    await tick()
    const stale = uuidOfLast()
    expect(handle.queuedInputs?.()).toBe(1)
    // A Stop’s result names nothing
    wire.say(result([]))
    await tick()
    expect(handle.queuedInputs?.()).toBe(1)
    // The next message is answered by a result that names it: what was read before it is done
    handle.send('the next message', { origin: { kind: 'human' } })
    await tick()
    expect(handle.queuedInputs?.()).toBe(2)
    wire.say(result([uuidOfLast()]))
    await tick()
    expect(handle.queuedInputs?.()).toBe(0)
    expect(stale).not.toBe(uuidOfLast())
    await handle.dispose()
  })
})
