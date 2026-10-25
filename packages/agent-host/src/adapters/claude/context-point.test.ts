import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * The context reading a Claude session sends at a turn's end carries the point the CLI says it compacts at, for a process Centralu's
 * control started (#1553). Through the real session: the CLI is faked, its `getContextUsage()` answers, a `result` ends a turn.
 */
const cli = vi.hoisted(() => ({ results: 0, release: null as null | (() => void) }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    let sent = false
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            if (sent) return
            // One turn's result, once the test lets it
            cli.release = () => {
              sent = true
              resolve({ done: false, value: { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: '', session_id: 'x', total_cost_usd: 0, usage: {}, modelUsage: {} } })
            }
          }),
      }),
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => ({ totalTokens: 100_000, maxTokens: 633_000, model: 'claude-opus-5', autoCompactThreshold: 600_000 }),
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}

async function reading(opts: Record<string, unknown>): Promise<Extract<NormalizedEvent, { type: 'context_update' }> | undefined> {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession({ sessionId: 'c1', cwd: '/tmp', permissionPreset: 'normal', ...opts }, (e) => events.push(e))
  await until(() => cli.release !== null)
  cli.release?.()
  cli.release = null
  await until(() => events.some((e) => e.type === 'context_update'))
  await handle.dispose()
  return events.find((e): e is Extract<NormalizedEvent, { type: 'context_update' }> => e.type === 'context_update')
}

describe('the context reading a Claude session sends', () => {
  it("carries the CLI's own threshold when Centralu's control started the process, and none for a process it did not start to compact", async () => {
    expect(await reading({ autoCompactTokens: 600_000 })).toMatchObject({ used: 100_000, window: 633_000, compactAt: 600_000 })
    // The CLI reports a threshold whether or not anyone set it
    const plain = await reading({})
    expect(plain).toMatchObject({ used: 100_000, window: 633_000 })
    expect(plain).not.toHaveProperty('compactAt')
  })
})
