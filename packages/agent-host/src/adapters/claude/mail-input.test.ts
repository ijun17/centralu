import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * What the Claude adapter writes to the CLI for the mailbox's delivery (#1347, docs/plans/mailbox.md §7.1): the input is stamped
 * `channel` from `centralu`, and mail that must not wake is `shouldQuery: false` and starts no turn: the session stays at rest.
 */
const wire = vi.hoisted(() => ({ messages: [] as Record<string, unknown>[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    void (async () => {
      for await (const u of prompt) wire.messages.push(u)
    })()
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [{ name: 'goal' }],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 10))
const textOf = (m: Record<string, unknown>) => (m.message as { content: { text: string }[] }).content[0]?.text

describe('mail written to the CLI', () => {
  it('is stamped as the channel of Centralu; a wake starts a turn like any message, quiet mail starts none', async () => {
    wire.messages.length = 0
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'm1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
    handle.send('<centralu-mail/>', { origin: { kind: 'channel', server: 'centralu' } })
    await tick()
    expect(wire.messages).toHaveLength(1)
    expect(wire.messages[0]).toMatchObject({ origin: { kind: 'channel', server: 'centralu' } })
    expect('shouldQuery' in wire.messages[0]!).toBe(false)
    expect(events.some((e) => e.type === 'state_change' && e.state === 'working')).toBe(true)
    // And quiet mail behind it is told of without a turn of its own
    handle.send('<centralu-mail quiet/>', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    await tick()
    expect(wire.messages[1]).toMatchObject({ origin: { kind: 'channel', server: 'centralu' }, shouldQuery: false })
    await handle.dispose()
  })

  it('goes in without a turn when it must not wake: shouldQuery false, and the session does not start working', async () => {
    wire.messages.length = 0
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'm2', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
    handle.send('<centralu-mail/>', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    await tick()
    expect(wire.messages).toHaveLength(1)
    expect(wire.messages[0]).toMatchObject({ origin: { kind: 'channel', server: 'centralu' }, shouldQuery: false })
    expect(textOf(wire.messages[0]!)).toBe('<centralu-mail/>')
    expect(events.some((e) => e.type === 'state_change' && e.state === 'working')).toBe(false)
    await handle.dispose()
  })

  it('a quiet input leaves a message behind it a turn of its own, and the person’s stamp alone', async () => {
    wire.messages.length = 0
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'm3', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    handle.send('quiet', { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    handle.send('hello', { origin: { kind: 'human' } })
    await tick()
    expect(wire.messages.map((m) => [textOf(m), m.origin, 'shouldQuery' in m])).toEqual([
      ['quiet', { kind: 'channel', server: 'centralu' }, true],
      ['hello', { kind: 'human' }, false],
    ])
    await handle.dispose()
  })

  it('the adapter says it takes quiet input; a tool that does not say so does not', () => {
    expect(new ClaudeAdapter().quietInput).toBe(true)
  })
})
