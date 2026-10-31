import { describe, expect, it, vi } from 'vitest'
import { fakeClaudeSdkWire } from './claude-sdk-fake.test-helpers.js'

/**
 * What the Claude adapter writes to the CLI's stdin for an input: the SDK says an absent `origin` is unattributed and
 * "fails closed at strict `isHuman()` trust gates", and a host wrapping keyboard input must stamp `{ kind: 'human' }`
 * itself. The adapter stamps what the host says is the person's (`send(text, { origin })`), and nothing else.
 */
const wire = vi.hoisted(() => ({ messages: [] as Record<string, unknown>[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => fakeClaudeSdkWire(wire.messages))

const { ClaudeAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 10))

const start = (id: string) => new ClaudeAdapter().createSession({ sessionId: id, cwd: '/tmp', permissionPreset: 'normal' }, () => {})
const textOf = (m: Record<string, unknown>) => ((m.message as { content: { text: string }[] }).content[0]!.text)

describe('the origin on a user message written to the CLI', () => {
  it('is human for what the host says the person typed, a slash command included', async () => {
    wire.messages.length = 0
    const handle = await start('o1')
    handle.send('hello', { origin: { kind: 'human' } })
    handle.send('/compact', { origin: { kind: 'human' } })
    await tick()
    expect(wire.messages.map((m) => [textOf(m), m.origin])).toEqual([
      ['hello', { kind: 'human' }],
      ['/compact', { kind: 'human' }],
    ])
    await handle.dispose()
  })

  it('is absent for any other input, as before', async () => {
    wire.messages.length = 0
    const handle = await start('o2')
    handle.send('[Centralu] The assigned work finished.')
    await tick()
    expect(wire.messages).toHaveLength(1)
    expect('origin' in wire.messages[0]!).toBe(false)
    await handle.dispose()
  })

  it('keeps the order and the stamps of a person\'s message and another message sent behind each other', async () => {
    wire.messages.length = 0
    const handle = await start('o3')
    handle.send('from a report')
    handle.send('from the person', { origin: { kind: 'human' } })
    handle.send('from an app')
    await tick()
    expect(wire.messages.map((m) => [textOf(m), 'origin' in m ? m.origin : null])).toEqual([
      ['from a report', null],
      ['from the person', { kind: 'human' }],
      ['from an app', null],
    ])
    await handle.dispose()
  })

  it('survives the /goal gate, which holds a message until the command list answers', async () => {
    wire.messages.length = 0
    const handle = await start('o4')
    handle.send('/goal all tests pass', { origin: { kind: 'human' } })
    handle.send('then this one', { origin: { kind: 'human' } })
    await tick()
    expect(wire.messages.map((m) => [textOf(m), m.origin])).toEqual([
      ['/goal all tests pass', { kind: 'human' }],
      ['then this one', { kind: 'human' }],
    ])
    await handle.dispose()
  })
})
