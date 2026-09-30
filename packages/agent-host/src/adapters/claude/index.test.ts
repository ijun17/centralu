import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * When the CLI process disappears silently, the SDK stream can sometimes **just end** with no
 * exception at all. If the adapter says nothing at that point, the UI stays "working" forever and
 * the next message goes nowhere. This swaps the SDK for a fake that can be steered, so the test
 * only exercises that boundary — starting the real CLI would leave the test with no control over
 * when it actually dies.
 */
const control = vi.hoisted(() => ({
  endStream: () => {},
  failStream: (_err: Error) => {},
  /** The queries created, in creation order — used to check whether close was called and which query the usage window borrows. */
  queries: [] as { closed: boolean }[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const q = {
      closed: false,
      // eslint-disable-next-line require-yield -- a stream that ends without producing anything is exactly what this tests
      async *[Symbol.asyncIterator]() {
        // Ends without an exception when the test tells it to (as if the process disappeared), or throws (as if the SDK turned an error result into an exception).
        await new Promise<void>((resolve, reject) => {
          control.endStream = resolve
          control.failStream = reject
        })
      },
      interrupt: async () => {},
      close: () => {
        q.closed = true
      },
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
    control.queries.push(q)
    return q
  },
}))

const { ClaudeAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('when a claude stream ends without warning', () => {
  it('raises adapter_crashed — so the session does not get stuck on working (the same signal as codex\'s onExit)', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    control.endStream()
    await tick()

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        sessionId: 's1',
        error: expect.objectContaining({ code: 'adapter_crashed', retryable: true }),
      }),
    )
  })

  it('does not call it a crash when we ourselves closed it (the lesson from losing a day on codex)', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    await handle.dispose()
    control.endStream()
    await tick()

    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  /*
   * The old process of a swapped-out session (#157). If settings change after a stopped turn, the
   * old CLI ends carrying an error result, and the SDK turns that into a thrown exception. If that
   * exception surfaced as adapter_crashed, the manager would close a brand-new process by mistake.
   * Also, simply ending input is not enough — the CLI keeps running the turn it was already on, so
   * dispose has to actually terminate the process.
   */
  it('does not raise a crash even when the stream ends with an exception after closing, and terminates the process on close (#157)', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's4', cwd: '/tmp', permissionPreset: 'auto' },
      (e) => events.push(e),
    )
    const q = control.queries.at(-1)!

    await handle.dispose()
    expect(q.closed).toBe(true)
    control.failStream(new Error('Claude Code returned an error result: [ede_diagnostic] result_type=user'))
    await tick()

    expect(events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('the usage window only borrows a live query — it never holds on to a closed session\'s query (#157)', async () => {
    const adapter = new ClaudeAdapter()
    const older = await adapter.createSession({ sessionId: 's5', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const qOlder = control.queries.at(-1)!
    const newer = await adapter.createSession({ sessionId: 's6', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const qNewer = control.queries.at(-1)!
    expect(ClaudeAdapter.lastQuery).toBe(qNewer)

    // Even after the most recent session closes, as long as an older session is still alive, it is asked instead.
    await newer.dispose()
    expect(ClaudeAdapter.lastQuery).toBe(qOlder)
    await older.dispose()
    expect([...ClaudeAdapter.liveQueries]).not.toContain(qOlder)
  })

  /*
   * While the SDK is not pulling input (this is what a turn in progress looks like), a message
   * left in the queue goes unread by anyone once dispose runs. Because the UI already shows it as
   * sent (the manager records it first), silently dropping it would quietly create a "sent, but
   * the agent never saw it" state — the same kind of incident as the codex compact queue loss
   * (2026-09-02).
   */
  it('reports the loss when closing with a message still in the queue — staying silent would just reproduce the original bug', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's3', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    handle.send('an undelivered message')
    await handle.dispose()

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        sessionId: 's3',
        error: expect.objectContaining({ message: expect.stringContaining('not delivered') }),
      }),
    )
  })
})

/**
 * /goal does not exist in the headless SDK (measured 2026-09-07, smoke-goal.mts — zero
 * `active_goal` occurrences in the raw stream). If it is sent as-is, the model just role-plays a
 * goal — this checks that it is intercepted and answered with an honest one-liner instead.
 */
describe('claude /goal — an honest refusal of a feature the SDK does not have', () => {
  it('/goal never reaches the model, and is answered with one line of guidance plus turn completion', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's3', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    handle.send('/goal all tests green')
    await tick()
    expect(events.some((e) => e.type === 'message_delta' && /interactive Claude CLI/.test(e.text ?? ''))).toBe(true)
    expect(events.some((e) => e.type === 'turn_complete')).toBe(true)
    // There must be no transition to working toward the model — pretending to send it would be the worst outcome.
    expect(events.some((e) => e.type === 'state_change' && e.state === 'working')).toBe(false)

    // The match is narrow — a real message that merely starts with the letters "/goal" still goes through as-is.
    handle.send("/goal's syntax — what is it?")
    await tick()
    expect(events.some((e) => e.type === 'state_change' && e.state === 'working')).toBe(true)
    await handle.dispose()
    control.endStream()
  })
})
