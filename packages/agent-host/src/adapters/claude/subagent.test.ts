import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * A subagent's messages arrive mixed into the parent's own stream (#98).
 *
 * The order and shape here are exactly as measured (scripts/probe-subagent-stream.mts, CLI
 * 2.1.282, 2026-09-25). While a parent that launched a background agent is streaming text:
 *
 *   stream_event text_delta ×27  parent=null
 *   assistant parent=toolu_…   [thinking]              ← subagent
 *   stream_event text_delta ×17  parent=null
 *   assistant parent=toolu_…   [tool_use Bash]         ← subagent
 *   stream_event text_delta ×32  parent=null
 *   assistant parent=null      [text, 946 characters]  ← the parent's own body
 *   result
 *   user      parent=toolu_…   [tool_result]          ← keeps going while the parent is idle
 *   assistant parent=toolu_…   [text "I am done."]     ← arrives even without forwardSubagentText
 *   system/task_notification {tool_use_id, status, summary, usage}
 *
 * The dogfooding symptom comes straight out of this ordering: the parent's own paragraph gets cut
 * mid-word by someone else's tool call (split across `남았` / Bash / `는지`), and the subagent's
 * full report shows up once as the parent's own answer and once again as the parent's summary —
 * "the answer appears twice".
 *
 * The SDK is swapped for a fake and this runs **the whole of the adapter's loop** — the flag that
 * tracks whether the body already went out as deltas (`textStreamed`) lives in that loop, and this
 * ordering is exactly what trips it.
 */
const script = vi.hoisted(() => ({ messages: [] as unknown[], release: () => {}, options: {} as Record<string, unknown> }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    script.options = args.options ?? {}
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script.messages) yield m
        // The adapter treats a closed stream as the CLI having died — this holds it open until the test closes it.
        await new Promise<void>((r) => (script.release = r))
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

const AGENT = 'toolu_015K5NBc2gup8ch4DVP7XQCD'
const SUB_1 = 'toolu_01GUgRASrjyeyDCL13txAFdC'
const SUB_2 = 'toolu_01BbrkvPiSVUQag9pc8X8DZC'
const SUB_EDIT = 'toolu_01EditBySubagent00000000'

const delta = (text: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
})
const parentText = (text: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 12, output_tokens: 34 } },
})
/** A subagent's own assistant message — the usage numbers are deliberately odd values, so they are distinguishable from the parent's. */
const sub = (content: unknown[]) => ({
  type: 'assistant',
  parent_tool_use_id: AGENT,
  message: { role: 'assistant', content, usage: { input_tokens: 99_999, output_tokens: 77_777 } },
})
const subResult = (id: string, text: string) => ({
  type: 'user',
  parent_tool_use_id: AGENT,
  subagent_type: 'general-purpose',
  task_description: 'Research the build',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
})
const result = { type: 'result', subtype: 'success', modelUsage: {} }

const REPORT =
  'I checked all 13 items against official docs and source code. Several of the assumptions do not hold, ' +
  'most importantly on the boundaries test.'

const FIRST = '별도 작업이라 범위에서 뺐고, 결과 보고에 어디에 이름이 남았'
const SECOND = '는지 적게 했습니다.'
const LATER = 'The investigation is back.'

/** The measured ordering: the parent launches a background agent, and that agent works interleaved with the parent's own stream. */
const backgroundRun = [
  { type: 'system', subtype: 'init', session_id: 'ext-1' },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: AGENT,
          name: 'Agent',
          input: { description: 'Research the build', subagent_type: 'general-purpose', prompt: '…', run_in_background: true },
        },
      ],
    },
  },
  {
    type: 'system',
    subtype: 'task_started',
    task_id: 'a19ec1fdf94e35cfc',
    tool_use_id: AGENT,
    description: 'Research the build',
    subagent_type: 'general-purpose',
    is_backgrounded: true,
    spawn_depth: 1,
    task_type: 'local_agent',
  },
  {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: AGENT,
          content: [
            {
              type: 'text',
              text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a19ec1fdf94e35cfc',
            },
          ],
        },
      ],
    },
    tool_use_result: {
      isAsync: true,
      status: 'async_launched',
      agentId: 'a19ec1fdf94e35cfc',
      description: 'Research the build',
      prompt: '…',
      outputFile: '/private/tmp/claude-501/x/tasks/a19ec1fdf94e35cfc.output',
    },
  },
  delta(FIRST),
  sub([{ type: 'thinking', thinking: '' }]),
  sub([{ type: 'tool_use', id: SUB_1, name: 'Bash', input: { command: "sed -n '56,200p' tooling/boundaries.test.ts" } }]),
  {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'a19ec1fdf94e35cfc',
    tool_use_id: AGENT,
    description: 'Running sed',
    usage: { total_tokens: 12138, tool_uses: 1, duration_ms: 2473 },
    last_tool_name: 'Bash',
  },
  delta(SECOND),
  parentText(FIRST + SECOND),
  result,
  // The parent's turn has ended — the subagent keeps working.
  subResult(SUB_1, "describe('ui layer boundary', () => {"),
  sub([{ type: 'tool_use', id: SUB_2, name: 'Grep', input: { pattern: 'boundaries' } }]),
  subResult(SUB_2, 'tooling/boundaries.test.ts'),
  sub([{ type: 'tool_use', id: SUB_EDIT, name: 'Edit', input: { file_path: '/repo/tooling/boundaries.test.ts', old_string: 'a', new_string: 'b' } }]),
  subResult(SUB_EDIT, 'ok'),
  sub([{ type: 'text', text: REPORT }]),
  { type: 'system', subtype: 'task_updated', task_id: 'a19ec1fdf94e35cfc', patch: { status: 'completed', end_time: 1 } },
  {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'a19ec1fdf94e35cfc',
    tool_use_id: AGENT,
    status: 'completed',
    output_file: '/private/tmp/claude-501/x/tasks/a19ec1fdf94e35cfc.output',
    summary: REPORT,
    usage: { total_tokens: 13620, tool_uses: 3, duration_ms: 134_000 },
  },
  // The parent opens a new turn once it receives the notification (measured: system/init arrives again).
  { type: 'system', subtype: 'init', session_id: 'ext-1' },
  delta(LATER),
  parentText(LATER),
  result,
]

async function run(messages: unknown[]): Promise<NormalizedEvent[]> {
  script.messages = messages
  const events: NormalizedEvent[] = []
  const adapter = new ClaudeAdapter()
  const handle = await adapter.createSession({ sessionId: 's1', cwd: '/repo', permissionPreset: 'auto' }, (e) => events.push(e))
  await new Promise((r) => setTimeout(r, 20))
  await handle.dispose()
  script.release()
  return events
}

const texts = (events: NormalizedEvent[]) =>
  events.flatMap((e) => (e.type === 'message_delta' ? [e.text] : [])).join('')

describe('a subagent\'s messages are not the parent\'s conversation (#98)', () => {
  it('the parent\'s text is the parent\'s alone — a subagent\'s report does not leak into the parent\'s answer', async () => {
    const events = await run(backgroundRun)
    expect(texts(events)).toBe(FIRST + SECOND + LATER)
  })

  it('the parent\'s tool calls are the parent\'s alone — a subagent\'s calls and results add no lines to the conversation', async () => {
    const events = await run(backgroundRun)
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { callId: string }).callId)).toEqual([AGENT])
    expect(
      events.filter((e) => e.type === 'tool_result' && [SUB_1, SUB_2, SUB_EDIT].includes(e.callId)),
    ).toEqual([])
  })

  it('one chunk of the parent\'s text is not split by someone else\'s event — `남았` / Bash / `는지` never happens again', async () => {
    const events = await run(backgroundRun)
    const first = events.findIndex((e) => e.type === 'message_delta' && e.text === FIRST)
    const second = events.findIndex((e) => e.type === 'message_delta' && e.text === SECOND)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    // Between the two chunks, there must be no event at all that adds a line to the conversation.
    const between = events.slice(first + 1, second).map((e) => e.type)
    expect(between.filter((t) => t === 'tool_call' || t === 'tool_result' || t === 'message_delta')).toEqual([])
  })

  it('a subagent\'s usage does not overwrite the parent\'s own usage', async () => {
    const events = await run(backgroundRun)
    const usage = events.filter((e) => e.type === 'usage_update').map((e) => e.tokens.inputTokens)
    expect(usage).not.toContain(99_999)
  })
})

describe('a subagent\'s work attaches to the Agent card that launched it (#98)', () => {
  it('every step goes to that card\'s live output — who did it is recorded by callId', async () => {
    const events = await run(backgroundRun)
    const live = events
      .filter((e) => e.type === 'tool_output_delta' && e.callId === AGENT)
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(live).toContain("sed -n '56,200p' tooling/boundaries.test.ts")
    expect(live).toContain('Grep: boundaries')
    expect(live).toContain('Edit: /repo/tooling/boundaries.test.ts')
  })

  it('a file edited by a subagent still counts as touched by this session (conflict detection, highlighting)', async () => {
    const events = await run(backgroundRun)
    expect(events).toContainEqual({ type: 'files_touched', sessionId: 's1', paths: ['/repo/tooling/boundaries.test.ts'] })
  })

  it('a background agent\'s card closes exactly once, when it finishes — carrying the report\'s opening and the step count', async () => {
    const events = await run(backgroundRun)
    const results = events.filter((e) => e.type === 'tool_result' && e.callId === AGENT)
    expect(results).toHaveLength(1)
    const [done] = results as Extract<NormalizedEvent, { type: 'tool_result' }>[]
    expect(done?.ok).toBe(true)
    expect(done?.summary).toContain('3 tool uses')
    expect(done?.summary).toContain('I checked all 13 items')
    // Text meant only for the model ("never quote…") never lands on the person's card.
    expect(done?.summary).not.toContain('Async agent launched')
    // It closes after the notification arrives, not at the moment it was launched.
    const notified = events.findIndex((e) => e.type === 'tool_output_delta' && e.text.includes('Edit:'))
    expect(events.indexOf(done!)).toBeGreaterThan(notified)
  })

  /*
   * On the storage side, the tool_result that closes a card marks a chunk boundary (manager
   * persistMessage) — emitting it while the parent is mid-write splits the parent's paragraph
   * into two rows. In a dogfooding session that ran three agents side by side, the parent was
   * writing an update about a different agent at the exact moment one of the agents finished.
   */
  it('does not cut the parent\'s text even when an agent finishes mid-write — the card closes only after the chunk closes', async () => {
    const notification = backgroundRun.find((m) => (m as { subtype?: string }).subtype === 'task_notification')
    const events = await run([
      ...backgroundRun.slice(0, 4), // init, the Agent call, task_started, the launch result
      delta('The local investigation is back too. A Codex'),
      notification,
      delta(' session quietly refuses when an app tool is called.'),
      parentText('The local investigation is back too. A Codex session quietly refuses when an app tool is called.'),
      result,
    ])
    const kinds = events.map((e) => (e.type === 'tool_result' ? `result:${e.callId}` : e.type))
    const lastDelta = kinds.lastIndexOf('message_delta')
    const closed = kinds.indexOf(`result:${AGENT}`)
    expect(closed).toBeGreaterThan(lastDelta)
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1)
  })

  it('does not leave a card open if the session closes before the agent reports back — the agent vanished along with the process', async () => {
    // Launches it, takes one step, and ends with no notification.
    const events = await run(backgroundRun.slice(0, 7))
    const results = events.filter((e) => e.type === 'tool_result' && e.callId === AGENT)
    expect(results).toEqual([
      { type: 'tool_result', sessionId: 's1', callId: AGENT, ok: false, summary: 'The session closed before this agent reported back' },
    ])
  })

  it('the card\'s title is the work handed to the agent — "Agent" alone does not say what the card is for', async () => {
    const events = await run(backgroundRun)
    const call = events.find((e) => e.type === 'tool_call')
    expect(call).toMatchObject({ callId: AGENT, summary: { tool: 'Agent', title: 'Research the build' } })
  })
})

describe('the parent body\'s duplicate-prevention flag belongs to the parent (#98)', () => {
  /*
   * A body already sent out as deltas is not emitted again from the assistant message
   * (`textStreamed`). That flag is cleared every time an assistant message arrives — if a
   * subagent's own assistant message lands between the parent's last delta and the parent's
   * body, the flag gets cleared early, before the parent's body arrives, and the parent's whole
   * text is appended a second time.
   */
  it('the parent\'s text is emitted once even when a subagent message lands between its last delta and its body', async () => {
    const events = await run([
      { type: 'system', subtype: 'init', session_id: 'ext-1' },
      delta("the parent's "),
      delta('paragraph'),
      sub([{ type: 'tool_use', id: SUB_1, name: 'Bash', input: { command: 'ls' } }]),
      parentText("the parent's paragraph"),
      result,
    ])
    expect(texts(events)).toBe("the parent's paragraph")
  })
})

/*
 * Replayed from rows the store held twice (found 2026-09-30). Five assistant text rows read X+X, written on
 * 2026-09-16 and 2026-09-25 by hosts built before the fix above. The order and the message shapes come from the
 * parent's and the agents' transcripts at those times. The text is replaced, except the CLI's own limit notice.
 */
describe('replayed from the replies stored twice (#98)', () => {
  it('a background agent thinking while the parent streams its answer does not make the parent say it again', async () => {
    // 2026-09-25 13:35:01: the parent thought, streamed a paragraph, and called Bash; an agent's thinking-only
    // message arrived 0.25s before the parent's own body (the same on 2026-09-16 16:22:35, 0.4s before)
    const events = await run([
      ...backgroundRun.slice(0, 4), // init, the Agent call, task_started, the launch result
      result,
      { type: 'system', subtype: 'init', session_id: 'ext-1' },
      delta('The screen groundwork is done too (five commits). '),
      delta('It was built on main from before the runtime merged, so first, how large the conflict is.'),
      sub([{ type: 'thinking', thinking: '' }]),
      parentText(
        'The screen groundwork is done too (five commits). It was built on main from before the runtime merged, so first, how large the conflict is.',
      ),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_parentGitStatus', name: 'Bash', input: { command: 'git status --short' } }] },
      },
    ])
    expect(texts(events)).toBe(
      'The screen groundwork is done too (five commits). It was built on main from before the runtime merged, so first, how large the conflict is.',
    )
  })

  /*
   * 2026-09-25 19:44:50, 19:45:04 and 19:45:46: three background agents hit the session limit one after another.
   * Each agent's turn ended in the CLI's own notice (a synthetic assistant message, `error: 'rate_limit'`, no
   * deltas). Its task notification then woke the parent, and the parent's turn hit the same limit and got the
   * same notice. Both went out whole into one open row, once per agent.
   */
  it('the parent says the session limit once when its background agent hit it first', async () => {
    const LIMIT = "You've hit your session limit · resets 7:50pm"
    const notice = (parent: string | null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      error: 'rate_limit',
      message: {
        model: '<synthetic>',
        role: 'assistant',
        type: 'message',
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        content: [{ type: 'text', text: LIMIT }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    const events = await run([
      ...backgroundRun.slice(0, 4), // init, the Agent call, task_started, the launch result
      result,
      notice(AGENT),
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'a19ec1fdf94e35cfc',
        tool_use_id: AGENT,
        status: 'failed',
        output_file: '/private/tmp/claude-501/x/tasks/a19ec1fdf94e35cfc.output',
        summary: `Agent "Research the build" failed: Agent terminated early due to an API error: ${LIMIT} (error type rate_limit, HTTP 429)`,
        usage: { total_tokens: 91_204, tool_uses: 57, duration_ms: 1_734_000 },
      },
      { type: 'system', subtype: 'init', session_id: 'ext-1' },
      notice(null),
      { type: 'result', subtype: 'success', is_error: true, result: LIMIT, modelUsage: {} },
    ])
    expect(texts(events)).toBe(LIMIT)
    // The agent's card closes as failed, and the parent's turn ends on the limit
    expect(events.filter((e) => e.type === 'tool_result' && e.callId === AGENT)).toMatchObject([{ ok: false }])
    expect(events.filter((e) => e.type === 'error')).toMatchObject([{ error: { message: LIMIT } }])
  })
})

describe('a foreground agent\'s result (#98)', () => {
  /*
   * In the foreground case, the Agent call's tool_result is itself the completion. Its body
   * begins with text meant for the model ("[Subagent hand-back] The text below…"), and the SDK
   * says what should be shown to the person should be drawn from tool_use_result instead
   * (sdk.d.ts SDKUserMessage.tool_use_result).
   */
  it('the card carries the report and the step count — not the preamble meant for the model', async () => {
    const events = await run([
      { type: 'system', subtype: 'init', session_id: 'ext-1' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: AGENT, name: 'Agent', input: { description: 'probe fg', prompt: '…' } }] },
      },
      sub([{ type: 'tool_use', id: SUB_1, name: 'Bash', input: { command: 'echo sub-one' } }]),
      subResult(SUB_1, 'sub-one'),
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: AGENT,
              content: [{ type: 'text', text: "[Subagent hand-back] The text below is the final report of a subagent this session started.\n\nI'm done." }],
            },
          ],
        },
        tool_use_result: {
          status: 'completed',
          agentId: 'a567ed393c31c63e1',
          agentType: 'general-purpose',
          prompt: '…',
          content: [{ type: 'text', text: "I'm done." }],
          totalToolUseCount: 1,
          totalDurationMs: 4096,
          totalTokens: 14521,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
        },
      },
      result,
    ])
    const results = events.filter((e) => e.type === 'tool_result') as Extract<NormalizedEvent, { type: 'tool_result' }>[]
    expect(results.map((r) => r.callId)).toEqual([AGENT])
    expect(results[0]?.summary).toContain('1 tool use')
    expect(results[0]?.summary).toContain("I'm done.")
    expect(results[0]?.summary).not.toContain('[Subagent hand-back]')
  })
})

describe('what a subagent did is kept under the card that launched it (#222)', () => {
  const steps = (events: NormalizedEvent[], parent = AGENT) =>
    events.flatMap((e) => (e.type === 'subagent_event' && e.parentCallId === parent ? [e.step] : []))

  it('every step is tagged with the launch call: its calls with their input, their results with their output, its text', async () => {
    const events = await run(backgroundRun)
    expect(steps(events)).toEqual([
      {
        type: 'tool_call', sessionId: 's1', callId: SUB_1,
        summary: { tool: 'Bash', title: "sed -n '56,200p' tooling/boundaries.test.ts", readOnly: false, paths: [] },
        input: { command: "sed -n '56,200p' tooling/boundaries.test.ts" },
      },
      { type: 'tool_result', sessionId: 's1', callId: SUB_1, ok: true, summary: "describe('ui layer boundary', () => {", output: "describe('ui layer boundary', () => {" },
      { type: 'tool_call', sessionId: 's1', callId: SUB_2, summary: { tool: 'Grep', title: 'Grep: boundaries', readOnly: true, paths: [] }, input: { pattern: 'boundaries' } },
      { type: 'tool_result', sessionId: 's1', callId: SUB_2, ok: true, summary: 'tooling/boundaries.test.ts', output: 'tooling/boundaries.test.ts' },
      {
        type: 'tool_call', sessionId: 's1', callId: SUB_EDIT,
        summary: { tool: 'Edit', title: 'Edit: /repo/tooling/boundaries.test.ts', readOnly: false, paths: ['/repo/tooling/boundaries.test.ts'] },
        input: { file_path: '/repo/tooling/boundaries.test.ts', old_string: 'a', new_string: 'b' },
      },
      { type: 'tool_result', sessionId: 's1', callId: SUB_EDIT, ok: true, summary: 'ok', output: 'ok' },
      // Its encrypted thinking ("") is not a step; its closing text is
      { type: 'message_delta', sessionId: 's1', role: 'assistant', text: REPORT },
    ])
  })

  it('a subagent\'s readable thinking is kept as its reasoning', async () => {
    const events = await run([
      ...backgroundRun.slice(0, 4),
      sub([{ type: 'thinking', thinking: 'Look at the boundaries test first.' }]),
      result,
    ])
    expect(steps(events)).toEqual([{ type: 'reasoning_delta', sessionId: 's1', text: 'Look at the boundaries test first.' }])
  })

  it('an agent launched by a subagent keeps its steps under its own card, inside the first one\'s', async () => {
    const NESTED = 'toolu_01NestedAgent0000000000'
    const events = await run([
      ...backgroundRun.slice(0, 4),
      sub([{ type: 'tool_use', id: NESTED, name: 'Agent', input: { description: 'Look deeper', prompt: '…' } }]),
      {
        type: 'assistant',
        parent_tool_use_id: NESTED,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_deep', name: 'Bash', input: { command: 'pwd' } }] },
      },
      result,
    ])
    expect(steps(events).map((s) => (s.type === 'tool_call' ? s.callId : s.type))).toEqual([NESTED])
    expect(steps(events, NESTED).map((s) => (s.type === 'tool_call' ? s.callId : s.type))).toEqual(['toolu_deep'])
  })

  it('the live line per step on the card stays', async () => {
    const events = await run(backgroundRun)
    const at = events.findIndex((e) => e.type === 'subagent_event' && e.step.type === 'tool_call' && e.step.callId === SUB_2)
    expect(events[at - 1]).toEqual({ type: 'tool_output_delta', sessionId: 's1', callId: AGENT, text: 'Grep: boundaries\n' })
  })

  it('asks the SDK for the subagent\'s text and thinking, not only its tool blocks', async () => {
    await run([result])
    expect(script.options.forwardSubagentText).toBe(true)
  })
})
