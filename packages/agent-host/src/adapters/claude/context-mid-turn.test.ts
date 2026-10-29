import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * A Claude session says its context while a turn runs (#1526). Through the real session: the CLI is faked, its `getContextUsage()`
 * answers with the size of the latest top-level request (as measured on CLI 2.1.296), and the test feeds the messages of a turn.
 */
const cli = vi.hoisted(() => ({ feed: null as null | ((m: unknown) => void), size: 0, asked: 0 }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const queue: unknown[] = []
    let wake: null | (() => void) = null
    cli.feed = (m) => {
      queue.push(m)
      wake?.()
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<unknown>> => {
          while (queue.length === 0) await new Promise<void>((r) => (wake = r))
          return { done: false, value: queue.shift() }
        },
      }),
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => {
        cli.asked++
        return { totalTokens: cli.size, maxTokens: 1_000_000, model: 'claude-opus-5', autoCompactThreshold: 967_000 }
      },
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')
const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}
const usage = (n: number) => ({ input_tokens: 3, cache_read_input_tokens: n - 3 - 10, cache_creation_input_tokens: 10, output_tokens: 5 })
const assistant = (n: number, parent: string | null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `m${n}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'x' }], stop_reason: null, usage: usage(n) }, session_id: 'x', uuid: `u${n}-${parent}` })
const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: '', session_id: 'x', total_cost_usd: 0, usage: {}, modelUsage: {} }

type Reading = Extract<NormalizedEvent, { type: 'context_update' }>
async function start() {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession({ sessionId: 'c1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
  await until(() => cli.feed !== null)
  const readings = () => events.filter((e): e is Reading => e.type === 'context_update')
  return { handle, readings }
}

describe('the context reading during a Claude turn', () => {
  it('has a reading from the first top-level request, before the turn has a result', async () => {
    cli.asked = 0
    cli.size = 19_301
    const { handle, readings } = await start()
    cli.feed?.(assistant(19_301, null))
    await until(() => readings().length > 0)
    expect(readings()).toEqual([expect.objectContaining({ used: 19_301, window: 1_000_000, exactness: 'exact', model: 'claude-opus-5' })])
    await handle.dispose()
  })

  it("does not read for a subagent's request, not even in a trailing read", async () => {
    cli.asked = 0
    cli.size = 50_000
    const { handle, readings } = await start()
    cli.feed?.(assistant(50_000, null))
    await until(() => readings().length === 1)
    // A subagent's prompt is its own: its request is not asked for, at once or when the gap has passed
    cli.size = 30_000
    cli.feed?.(assistant(30_000, 'toolu_sub'))
    await new Promise((r) => setTimeout(r, 2_300))
    expect(cli.asked).toBe(1)
    expect(readings().map((r) => r.used)).toEqual([50_000])
    await handle.dispose()
  })

  it('reads at most once in a burst of requests, and the end of the turn reading replaces it without going back', async () => {
    cli.asked = 0
    cli.size = 20_000
    const { handle, readings } = await start()
    cli.feed?.(assistant(20_000, null))
    await until(() => readings().length === 1)
    cli.size = 24_000
    for (const n of [21_000, 22_000, 23_000, 24_000]) cli.feed?.(assistant(n, null))
    await new Promise((r) => setTimeout(r, 100))
    expect(cli.asked).toBe(1)
    cli.feed?.(result)
    await until(() => readings().length === 2)
    expect(readings().map((r) => r.used)).toEqual([20_000, 24_000])
    // The trailing read for the burst was dropped by the turn's end: nothing older comes after the end's reading
    await new Promise((r) => setTimeout(r, 2_300))
    expect(readings().map((r) => r.used)).toEqual([20_000, 24_000])
    await handle.dispose()
  })
})
