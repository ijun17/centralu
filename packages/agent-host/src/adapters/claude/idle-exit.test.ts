import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * A Claude process that goes while nothing is in flight is asleep, not crashed (#1397, owner decision Q1 on #1654), as Codex and
 * ACP say it: a logout, a shutdown or a kill lands on idle sessions too, and the next message resumes the conversation. An exit
 * with a turn open, an input not yet answered, or before the CLI said anything is still a crash.
 */
const wire = vi.hoisted(() => ({
  say: (_m: Record<string, unknown>) => {},
  end: () => {},
  fail: (_err: Error) => {},
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    void (async () => {
      for await (const _ of prompt) void _
    })()
    const inbox: Record<string, unknown>[] = []
    let ended = false
    let failure: Error | null = null
    let wake = () => {}
    wire.say = (m) => {
      inbox.push(m)
      wake()
    }
    wire.end = () => {
      ended = true
      wake()
    }
    wire.fail = (err) => {
      failure = err
      wake()
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (inbox.length > 0) yield inbox.shift()
          if (failure) throw failure
          if (ended) return
          await new Promise<void>((r) => (wake = r))
        }
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 20))

const init = { type: 'system', subtype: 'init', session_id: 'conv-1', claude_code_version: '2.1.296', slash_commands: [], capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] }
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', user_message_uuids: [] }

async function session(events: NormalizedEvent[]) {
  return new ClaudeAdapter().createSession({ sessionId: 'i1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
}

/** A session whose one turn ran and ended: the CLI is up and nothing is in flight */
async function idleAfterTurn(events: NormalizedEvent[]) {
  const handle = await session(events)
  handle.send('hello')
  await tick()
  wire.say(init)
  wire.say(result)
  await tick()
  return handle
}

const asleep = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'session_live' && !e.live && e.reason === 'asleep')
const crashes = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'error' && e.error.code === 'adapter_crashed')
/** Waits for how the exit was said, either way, rather than for a fixed time */
const exitSaid = (events: NormalizedEvent[]) => vi.waitFor(() => expect(asleep(events).length + crashes(events).length).toBeGreaterThan(0))

describe('a Claude process that exits on its own', () => {
  it('is asleep when its stream ends with nothing in flight: no crash', async () => {
    const events: NormalizedEvent[] = []
    await idleAfterTurn(events)
    wire.end()
    await exitSaid(events)
    expect(asleep(events)).toHaveLength(1)
    expect(crashes(events)).toHaveLength(0)
  })

  it('is asleep when the SDK throws for an idle exit too, whatever the exit code', async () => {
    const events: NormalizedEvent[] = []
    await idleAfterTurn(events)
    wire.fail(new Error('Claude Code process exited with code 143'))
    await exitSaid(events)
    expect(asleep(events)).toHaveLength(1)
    expect(crashes(events)).toHaveLength(0)
  })

  it('is a crash with a turn open', async () => {
    const events: NormalizedEvent[] = []
    const handle = await idleAfterTurn(events)
    handle.send('another')
    await tick()
    wire.fail(new Error('Claude Code process exited with code 1'))
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  it('is a crash with a quiet input read but not answered: it is lost with the process', async () => {
    const events: NormalizedEvent[] = []
    const handle = await idleAfterTurn(events)
    void handle.nudge!('a note')
    await tick()
    wire.end()
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  it('is a crash with a tracked input its result did not name: it waits for an answer the process took along', async () => {
    const events: NormalizedEvent[] = []
    const handle = await idleAfterTurn(events)
    const done = handle.sendTracked!('a parent note')
    await tick()
    wire.say(result)
    await tick()
    wire.end()
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
    await expect(done).rejects.toThrow()
  })

  it('is a crash with background work still running: it goes with the process', async () => {
    const events: NormalizedEvent[] = []
    await idleAfterTurn(events)
    wire.say({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'sh-1', task_type: 'local_bash', description: 'npm run dev' }] })
    await tick()
    wire.end()
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })

  it('is a crash before the CLI said anything: it may never have started', async () => {
    const events: NormalizedEvent[] = []
    await session(events)
    wire.fail(new Error('Claude Code process exited with code 1'))
    await exitSaid(events)
    expect(crashes(events)).toHaveLength(1)
    expect(asleep(events)).toHaveLength(0)
  })
})
