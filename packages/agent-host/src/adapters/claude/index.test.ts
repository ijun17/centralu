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
  /** Hands the latest query's stream one CLI message. */
  push: (_msg: unknown) => {},
  /** The queries created, in creation order — used to check whether close was called and which query the usage window borrows. */
  queries: [] as { closed: boolean }[],
  /** What the next query's `supportedCommands()` answers with — the CLI's command list. */
  commands: (async () => []) as () => Promise<{ name: string }[]>,
  /** The texts the CLI read from the input stream, in order. */
  inputs: [] as string[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: { text: string }[] } }> }) => {
    void (async () => {
      for await (const u of prompt) control.inputs.push(u.message.content[0]!.text)
    })()
    const commands = control.commands
    const q = {
      closed: false,
      async *[Symbol.asyncIterator]() {
        // Yields what the test pushes; ends without an exception when told to (as if the process disappeared), or throws (as if the SDK turned an error result into an exception).
        const pending: unknown[] = []
        let ended = false
        let failure: Error | null = null
        let wake = () => {}
        control.endStream = () => {
          ended = true
          wake()
        }
        control.failStream = (err) => {
          failure = err
          wake()
        }
        control.push = (msg) => {
          pending.push(msg)
          wake()
        }
        for (;;) {
          while (pending.length > 0) yield pending.shift()
          if (failure) throw failure
          if (ended) return
          await new Promise<void>((r) => (wake = r))
        }
      },
      interrupt: async () => {},
      close: () => {
        q.closed = true
      },
      supportedCommands: () => commands(),
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

  it('reads usage from an older live session when the newest cannot answer, and logs which one failed (#481)', async () => {
    const adapter = new ClaudeAdapter()
    const older = await adapter.createSession({ sessionId: 's481a', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const qOlder = control.queries.at(-1)! as unknown as Record<string, unknown>
    const newer = await adapter.createSession({ sessionId: 's481b', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const qNewer = control.queries.at(-1)! as unknown as Record<string, unknown>
    const KEY = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
    qNewer[KEY] = () => Promise.reject(new Error('still re-attaching'))
    qOlder[KEY] = () => Promise.resolve({ subscription_type: 'max', rate_limits: { limits: [{ kind: 'weekly_all', percent: 95 }] } })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const usage = await adapter.listUsage()
      expect(usage.windows).toMatchObject([{ id: 'weekly_all', percent: 95 }])
      expect(logged.mock.calls.flat().join('\n')).toContain('session s481b could not read usage (1 of 2): still re-attaching')
    } finally {
      logged.mockRestore()
      await newer.dispose()
      await older.dispose()
    }
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
 * /goal goes to the CLI when the CLI offers it (2026-10-03). On 2026-09-07 the headless path had no
 * goal, and a /goal sent as text only made the model role-play the hook, so it was refused here. The
 * installed CLI 2.1.282 runs it through query() (measured: `goal` in supportedCommands() and in the
 * init message's slash_commands, "Goal set: …" from the CLI itself, the Stop hook keeping the turn
 * going). The decision is by capability: an older CLI that does not list it still gets the refusal.
 */
describe('claude /goal — passed through when the CLI offers it, refused when it does not', () => {
  const COND = 'the file done.txt exists'
  const start = async (sessionId: string, extra: Record<string, unknown> = {}) => {
    const events: NormalizedEvent[] = []
    control.inputs = []
    const handle = await new ClaudeAdapter().createSession(
      { sessionId, cwd: '/tmp', permissionPreset: 'normal', ...extra },
      (e) => events.push(e),
    )
    await tick()
    return { events, handle }
  }
  const synthetic = (text: string) => ({
    type: 'assistant',
    message: { id: `local-${text.length}`, model: '<synthetic>', content: [{ type: 'text', text }] },
  })
  const modelCall = (id: string, text: string) => [
    { type: 'stream_event', event: { type: 'message_start', message: { id } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    { type: 'assistant', message: { id, model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text }] } },
  ]
  const result = { type: 'result', subtype: 'success', is_error: false }
  const goals = (events: NormalizedEvent[]) => events.flatMap((e) => (e.type === 'goal' ? [e.goal] : []))
  const turnEnds = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'turn_complete').length

  it('a CLI that lists goal gets the command itself — no refusal, no turn completed on its behalf', async () => {
    control.commands = async () => [{ name: 'compact' }, { name: 'goal' }]
    const { events, handle } = await start('g1')

    handle.send(`/goal ${COND}`)
    await tick()
    expect(control.inputs).toEqual([`/goal ${COND}`])
    expect(events).toContainEqual({ type: 'state_change', sessionId: 'g1', state: 'working' })
    expect(events.some((e) => e.type === 'message_delta')).toBe(false)
    expect(turnEnds(events)).toBe(0)
    await handle.dispose()
  })

  it('a CLI that does not list goal gets the honest one-liner and nothing reaches it; a message that only starts with "/goal" still goes', async () => {
    control.commands = async () => [{ name: 'compact' }]
    const { events, handle } = await start('g2')

    handle.send(`/goal ${COND}`)
    await tick()
    expect(control.inputs).toEqual([])
    expect(events.some((e) => e.type === 'message_delta' && /does not offer \/goal/.test(e.text))).toBe(true)
    expect(turnEnds(events)).toBe(1)
    expect(events.some((e) => e.type === 'state_change' && e.state === 'working')).toBe(false)

    handle.send("/goal's syntax — what is it?")
    await tick()
    expect(control.inputs).toEqual(["/goal's syntax — what is it?"])
    await handle.dispose()
  })

  it('the init message\'s slash_commands decides it too', async () => {
    control.commands = async () => []
    const { handle } = await start('g3')
    control.push({ type: 'system', subtype: 'init', session_id: 'x', slash_commands: ['goal', 'usage'] })
    await tick()

    handle.send(`/goal ${COND}`)
    await tick()
    expect(control.inputs).toEqual([`/goal ${COND}`])
    await handle.dispose()
  })

  it('a /goal sent before the command list answers waits for it, and what is sent after it does not overtake it', async () => {
    let answer: (list: { name: string }[]) => void = () => {}
    control.commands = () => new Promise((r) => (answer = r))
    const { handle } = await start('g4')

    handle.send(`/goal ${COND}`)
    handle.send('and then this')
    await tick()
    expect(control.inputs).toEqual([])
    answer([{ name: 'goal' }])
    await tick()
    expect(control.inputs).toEqual([`/goal ${COND}`, 'and then this'])
    await handle.dispose()
  })

  it('a refused /goal typed mid-turn does not complete the turn the CLI is still running', async () => {
    control.commands = async () => []
    const { events, handle } = await start('g5')

    handle.send('do the work')
    handle.send(`/goal ${COND}`)
    await tick()
    expect(events.some((e) => e.type === 'message_delta' && /does not offer \/goal/.test(e.text))).toBe(true)
    expect(turnEnds(events)).toBe(0)

    control.push(result)
    await tick()
    expect(turnEnds(events)).toBe(1)
    await handle.dispose()
  })

  it('the Stop hook keeping the agent going: one turn end at the one result, the badge follows set → lap → met, and a message sent meanwhile goes out', async () => {
    control.commands = async () => [{ name: 'goal' }]
    const { events, handle } = await start('g6')

    handle.send(`/goal ${COND}`)
    await tick()
    control.push(synthetic(`Goal set: ${COND}`))
    for (const m of modelCall('msg_1', 'Checked; not there yet.')) control.push(m)
    control.push({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: `Stop hook feedback:\n[${COND}]: The file does not exist.` }] },
    })
    await tick()
    expect(goals(events)).toEqual([
      { objective: COND, status: 'active' },
      { objective: COND, status: 'active', iterations: 1, reason: 'The file does not exist.' },
    ])
    // The CLI is still working on the goal: nothing says the turn is over
    expect(turnEnds(events)).toBe(0)
    expect(events.some((e) => e.type === 'state_change' && e.state !== 'working')).toBe(false)

    handle.send('also add a newline at the end')
    await tick()
    expect(control.inputs).toEqual([`/goal ${COND}`, 'also add a newline at the end'])

    for (const m of modelCall('msg_2', 'Created done.txt.')) control.push(m)
    control.push(result)
    await tick()
    expect(turnEnds(events)).toBe(1)
    expect(goals(events).at(-1)).toBeNull()
    await handle.dispose()
  })

  it('a resumed process is handed the goal the host knew, so a met goal still clears the badge', async () => {
    control.commands = async () => [{ name: 'goal' }]
    const { events, handle } = await start('g7', {
      resumeExternalId: 'conv-1',
      knownGoal: { objective: COND, status: 'active', iterations: 2 },
    })

    handle.send('keep going')
    for (const m of modelCall('msg_1', 'Created done.txt.')) control.push(m)
    control.push(result)
    await tick()
    expect(goals(events)).toEqual([null])
    await handle.dispose()
  })
})

describe('the CLI version a Claude process runs (#297)', () => {
  it('reports the init message’s claude_code_version once per process, though init comes again with every query', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'v1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
    control.push({ type: 'system', subtype: 'init', session_id: 'x', claude_code_version: '2.1.289' })
    control.push({ type: 'system', subtype: 'init', session_id: 'x', claude_code_version: '2.1.289' })
    await tick()
    expect(events.filter((e) => e.type === 'agent_version')).toEqual([{ type: 'agent_version', sessionId: 'v1', version: '2.1.289' }])
    await handle.dispose()
  })
})
