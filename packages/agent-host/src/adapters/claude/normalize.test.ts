/**
 * Contract tests (T3-2): without the real SDK, this checks against fixtures of the actual message
 * shapes observed during the spike. If the SDK's format changes, this is what breaks first.
 */
import { describe, expect, it, vi } from 'vitest'
import { ClaudeStreamNormalizer, approvalDetail, normalizeMessage, toolSummary } from './normalize.js'

const SID = 's1'
const n = (msg: unknown) => normalizeMessage(msg, SID)

describe('streaming deltas', () => {
  it('stream_event content_block_delta → message_delta', () => {
    const out = n({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    })
    expect(out).toEqual([{ type: 'message_delta', sessionId: SID, role: 'assistant', text: 'hello' }])
  })

  /*
   * Thinking (measured in #58): the body is always "" (encrypted), and only an
   * `estimated_tokens` increment arrives. So only the fact of progress (`estTokens`) becomes an
   * event — an empty delta is still nothing at all.
   */
  it('a thinking_delta\'s token estimate becomes a reasoning_delta', () => {
    const out = n({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 150 } },
    })
    expect(out).toEqual([{ type: 'reasoning_delta', sessionId: SID, estTokens: 150 }])
  })

  it('if thinking ever arrives with text, it flows through as-is', () => {
    const out = n({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'let us work out the path', estimated_tokens: 10 } },
    })
    expect(out).toEqual([{ type: 'reasoning_delta', sessionId: SID, text: 'let us work out the path', estTokens: 10 }])
  })

  it('ignores a delta with no content', () => {
    expect(n({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } })).toEqual([])
  })
})

/*
 * A body that arrives with no deltas (dogfooding: "the CC usage skill's message isn't showing
 * up?").
 *
 * An answer the CLI synthesizes locally, like /usage, produces zero stream_events and one
 * whole-body assistant message (measured — 0 deltas, a 1,046-character body). Rendering the body
 * only from deltas means the command ran but the answer never shows up in the UI at all.
 * Conversely, emitting it again on a turn that was streamed appends the same text twice — the
 * `textStreamed` flag is the fork in that road.
 */
describe('an assistant body that arrives with no deltas', () => {
  const assistant = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Usage: 18%' }] },
  }

  it('emits the whole body as a message_delta when there were no deltas — this is the path /usage\'s answer takes', () => {
    const events = normalizeMessage(assistant, SID, { textStreamed: false })
    expect(events).toContainEqual({ type: 'message_delta', sessionId: SID, role: 'assistant', text: 'Usage: 18%' })
  })

  it('does not emit a body again once it already went out as deltas — appearing twice would be a new bug', () => {
    const events = normalizeMessage(assistant, SID, { textStreamed: true })
    expect(events.filter((e) => e.type === 'message_delta')).toEqual([])
  })

  it('local command output (system/local_command_output) is also a body — the same generalized channel', () => {
    const events = normalizeMessage(
      { type: 'system', subtype: 'local_command_output', content: 'command output content' },
      SID,
    )
    expect(events).toContainEqual({ type: 'message_delta', sessionId: SID, role: 'assistant', text: 'command output content' })
  })

  it('active_goal becomes a goal event (2026-09-07 — the judgment behind /goal\'s Stop hook)', () => {
    const events = normalizeMessage(
      {
        type: 'active_goal',
        value: { condition: 'all tests pass', iterations: 3, set_at: 1, tokens_at_start: 10, last_reason: '2 failures' },
        session_id: 'x',
      },
      SID,
    )
    expect(events).toEqual([
      {
        type: 'goal',
        sessionId: SID,
        goal: { objective: 'all tests pass', status: 'active', iterations: 3, reason: '2 failures' },
      },
    ])
  })

  it('active_goal with value=null is a clear notification (including having been achieved)', () => {
    const events = normalizeMessage({ type: 'active_goal', value: null }, SID)
    expect(events).toEqual([{ type: 'goal', sessionId: SID, goal: null }])
  })
})

describe('tool calls (the actual shape from the spike)', () => {
  it('a Bash tool_use becomes a tool_call, with the full command text as its title', () => {
    const out = n({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run build' } }] },
    })
    expect(out[0]).toMatchObject({ type: 'tool_call', callId: 'tu1', summary: { tool: 'Bash', title: 'npm run build', readOnly: false } })
  })

  it('a Write tool_use becomes a tool_call plus files_touched (for conflict detection)', () => {
    const out = n({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/tmp/hello.txt', content: 'hi' } }] },
    })
    expect(out.map((e) => e.type)).toEqual(['tool_call', 'files_touched'])
    expect(out[1]).toMatchObject({ type: 'files_touched', paths: ['/tmp/hello.txt'] })
  })

  it('Read does not count as touching a file — it emits no files_touched (#185)', () => {
    const out = n({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] },
    })
    expect(out.map((e) => e.type)).toEqual(['tool_call'])
  })

  it('a read-only tool is marked readOnly (card-collapsing policy)', () => {
    expect(toolSummary('Read', { file_path: '/a.ts' }).readOnly).toBe(true)
    expect(toolSummary('Bash', { command: 'ls' }).readOnly).toBe(false)
  })

  it('tool_result decides ok', () => {
    const out = n({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'M0_SPIKE_OK' }] } })
    expect(out[0]).toMatchObject({ type: 'tool_result', callId: 'tu1', ok: true, summary: 'M0_SPIKE_OK' })
    const err = n({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'nope', is_error: true }] } })
    expect(err[0]).toMatchObject({ ok: false })
  })

  /*
   * An image carried in a tool result (#40). The measured shape (from a Read of an image file):
   * content: [{type:'image', source:{type:'base64', data, media_type}}]
   */
  it('a tool_result\'s image block becomes a message_image (the measured shape)', () => {
    const out = n({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [{ type: 'image', source: { type: 'base64', data: 'aWJs', media_type: 'image/png' } }],
          },
        ],
      },
    })
    // The tool line stays as-is (what actually ran), and the image comes out separately.
    expect(out[0]).toMatchObject({ type: 'tool_result', callId: 'tu1' })
    expect(out[1]).toEqual({ type: 'message_image', sessionId: 's1', mime: 'image/png', data: 'aWJs' })
  })

  it('an image that is too large explains why instead of rendering it', () => {
    const big = 'a'.repeat(11_000_001)
    const out = n({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'image', source: { type: 'base64', data: big, media_type: 'image/png' } }] },
        ],
      },
    })
    const img = out.find((e) => e.type === 'message_image')
    expect(img).toMatchObject({ data: '', note: expect.stringContaining('too large') })
  })

  it('a non-base64 image source becomes a visible failure (#58 — it used to vanish silently)', () => {
    const out = n({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
      },
    })
    const img = out.find((e) => e.type === 'message_image')
    expect(img).toMatchObject({ data: '', note: expect.stringContaining('url') })
  })
})

describe('normalizing an approval request (input to the banner\'s judgment)', () => {
  it('Bash becomes command (in-place banner approval is possible)', () => {
    expect(approvalDetail('Bash', { command: 'npm test' }, '/p')).toEqual({ kind: 'command', command: 'npm test', cwd: '/p' })
  })

  it('Write/Edit become file_edit (a diff needs to be shown)', () => {
    const d = approvalDetail('Edit', { file_path: '/a.ts', new_string: 'const a = 1' }, '/p')
    expect(d).toMatchObject({ kind: 'file_edit', path: '/a.ts', diffPreview: 'const a = 1', multi: false })
  })

  it('everything else becomes other', () => {
    expect(approvalDetail('WebFetch', { url: 'http://x' }, '/p').kind).toBe('other')
  })
})

describe('a limit (M0 finding: rate_limit_event)', () => {
  it('no event when allowed', () => {
    expect(n({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1786750200 } })).toEqual([])
  })

  /*
   * These three are all the SDK ever says ('allowed' | 'allowed_warning' | 'rejected'). This test
   * used to pass using `status: 'blocked'`, a value that **does not exist** — so nobody noticed
   * that the `!== 'allowed'` check was also swallowing `allowed_warning`. Making up a tool's own
   * vocabulary only means the test protects our own imagination.
   */
  it('a warning is not a limit — no event for allowed_warning', () => {
    expect(n({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1786750200, rateLimitType: 'five_hour' } })).toEqual([])
  })

  it('rejected produces limit_reached, with the reset time converted to ISO', () => {
    const out = n({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1786750200, rateLimitType: 'five_hour' } })
    expect(out[0]).toMatchObject({ type: 'limit_reached', resumeAt: new Date(1786750200 * 1000).toISOString(), windowMins: 300 })
  })
})

describe('the result message (usage, context, completion)', () => {
  const RESULT = {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.0078,
    modelUsage: {
      'claude-haiku-4-5-20251001': {
        inputTokens: 18, outputTokens: 186, cacheReadInputTokens: 54830,
        cacheCreationInputTokens: 697, contextWindow: 200000,
      },
    },
  }

  it('does not compute context usage from modelUsage (it accumulates, and would exceed the window)', () => {
    /*
     * `modelUsage` is a session-wide accumulation. Re-reading the cache adds to it every turn, so
     * summing it here makes the ratio run away the more turns pile up — measured as "context
     * 533%". What is currently in the window is known by the SDK's own `getContextUsage()`, which
     * the adapter asks and emits from.
     */
    expect(n(RESULT).find((e) => e.type === 'context_update')).toBeUndefined()
  })

  it('carries usage and cost', () => {
    const u = n(RESULT).find((e) => e.type === 'usage_update')
    expect(u).toMatchObject({ tokens: { outputTokens: 186, costUsd: 0.0078 } })
  })

  /*
   * A single turn can involve more than one model (M4 D-5). Measured (an app-requested agent,
   * real Claude): the record panel showed "1.1k tokens" on every run, with log lines of 1108/13
   * and 1038/16, while the model actually seen in the CLI log (Opus) used 200/363 output tokens
   * against 24k-80k cache input tokens. The first entry in `modelUsage` was the small titling
   * model. The shape here is exactly that run — the small model arrives first.
   */
  it('usage sums every model in modelUsage — the main model\'s own share is not dropped even when the small model arrives first', () => {
    const u = n({
      ...RESULT,
      total_cost_usd: 0.4163,
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 1108, outputTokens: 13, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          webSearchRequests: 0, costUSD: 0.0012, contextWindow: 200000, maxOutputTokens: 32000,
        },
        'claude-opus-4-7': {
          inputTokens: 9, outputTokens: 363, cacheReadInputTokens: 80412, cacheCreationInputTokens: 4213,
          webSearchRequests: 0, costUSD: 0.4151, contextWindow: 200000, maxOutputTokens: 32000,
        },
      },
    }).find((e) => e.type === 'usage_update')
    expect(u).toMatchObject({ tokens: { inputTokens: 1117, outputTokens: 376, cacheReadTokens: 80412, cacheCreationTokens: 4213, costUsd: 0.4163 } })
  })

  it('ends with turn_complete on success', () => {
    expect(n(RESULT).at(-1)).toEqual({ type: 'turn_complete', sessionId: SID })
  })

  it('emits an error on failure', () => {
    const out = n({ ...RESULT, subtype: 'error_max_turns', is_error: true, result: 'max turns exceeded' })
    expect(out.at(-1)).toMatchObject({ type: 'error', error: { code: 'internal', message: 'max turns exceeded' } })
  })

  /*
   * A turn answered with a schema (M4 D-1, an app-requested agent). The fixture is a measured
   * ending (SDK 0.3.263, CLI 2.1.282, haiku): the model answered in text first, "Red and
   * yellow.", and the structured output existed only in this ending — `result` is that JSON as
   * text, `structured_output` is the value.
   */
  it('moves structured output to turn_complete.output — it is not in the text', () => {
    const out = n({ ...RESULT, result: '{"colors":["red","yellow"]}', structured_output: { colors: ['red', 'yellow'] } })
    expect(out.at(-1)).toEqual({ type: 'turn_complete', sessionId: SID, output: { colors: ['red', 'yellow'] } })
  })

  it('is an error when structured output never manages to match — not a blank ending, and carries the reason if there is one', () => {
    // The shape of a failed ending (sdk.d.ts SDKResultError): no `result`, only `errors`.
    const bare = n({ ...RESULT, subtype: 'error_max_structured_output_retries', is_error: true, errors: [] })
    expect(bare.at(-1)).toMatchObject({ type: 'error', error: { message: 'Turn failed: error_max_structured_output_retries' } })
    const said = n({ ...RESULT, subtype: 'error_max_structured_output_retries', is_error: true, errors: ['output did not match the schema'] })
    expect(said.at(-1)).toMatchObject({ type: 'error', error: { message: 'output did not match the schema' } })
  })
})

/*
 * The fixture is not made up — it is the actual message a probe observed. The observed ordering:
 * status:'compacting' → (39.1 seconds) → status:null (+compact_result) → compact_boundary
 */
describe('compaction — saying what is currently happening', () => {
  it('reports activity when compaction starts (must be distinguishable from waiting for a response)', () => {
    expect(n({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([
      { type: 'activity', sessionId: SID, activity: 'compacting' },
    ])
  })

  it('has no activity during an ordinary request', () => {
    expect(n({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual([
      { type: 'activity', sessionId: SID, activity: null },
    ])
  })

  it('does not swallow a compaction failure — records the reason as well', () => {
    const out = n({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'Not enough messages to compact.',
    })
    expect(out).toEqual([
      { type: 'activity', sessionId: SID, activity: null },
      { type: 'compaction', sessionId: SID, failed: true, reason: 'Not enough messages to compact.' },
    ])
  })

  it('compact_boundary becomes a marker (Claude never had this marker until now)', () => {
    const out = n({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 25485, post_tokens: 3686, duration_ms: 39099 },
    })
    expect(out).toEqual([{ type: 'compaction', sessionId: SID, failed: false, before: 25485, after: 3686 }])
  })
})

describe('an unknown message is ignored silently', () => {
  it.each([
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'thinking_tokens' },
    { type: 'future_message_type' },
  ])('%o', (msg) => {
    expect(n(msg)).toEqual([])
  })
})

/**
 * Thinking that streamed is not repeated from the finished message (2026-09-30).
 *
 * Measured in a live session: a message that thought and then called a tool, with no text in between, stored
 * its thinking twice in one row ("...진행해보겠습니다.\n\n...진행해보겠습니다.\n\n") and showed it twice.
 * The thinking streamed as `thinking_delta`s, then the finished assistant message carried the same block, and
 * the only guard was `textStreamed`, which a message without text never set.
 */
describe('streamed thinking is not repeated from the finished message', () => {
  const THOUGHT = 'Looking at why the click did not register after the permission was granted.\n\n'
  const thinkingDelta = {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THOUGHT } },
  }
  const finished = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: THOUGHT, signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  }
  const reasoningText = (events: { type: string; text?: string }[]) =>
    events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text ?? '').join('')

  it('a message that streamed its thinking and then called a tool shows that thinking once', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    const events = [...stream.push(thinkingDelta), ...stream.push(finished)]
    expect(reasoningText(events)).toBe(THOUGHT)
    expect(events.some((e) => e.type === 'tool_call')).toBe(true)
  })

  it('thinking that never streamed still comes out of the finished message', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    expect(reasoningText(stream.push(finished))).toBe(THOUGHT)
  })

  it('the next message starts counting again, so its own unstreamed thinking is not lost', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.push(thinkingDelta)
    stream.push(finished)
    expect(reasoningText(stream.push(finished))).toBe(THOUGHT)
  })

  it('encrypted thinking, which streams only token estimates, does not count as streamed', () => {
    const stream = new ClaudeStreamNormalizer(SID)
    stream.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 40 } },
    })
    expect(reasoningText(stream.push(finished))).toBe(THOUGHT)
  })
})

/*
 * A tool call is kept whole (#221). The card's summary stays as it was — a result's first 300 characters, a file
 * edit's path — and the record goes in `output` and `input`.
 */
describe('the whole record of a tool call (#221)', () => {
  const resultOf = (content: unknown, extra: Record<string, unknown> = {}) =>
    n({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] }, ...extra })[0] as {
      summary: string
      output?: string
    }

  it('a result keeps its whole output, and the card still shows the first 300 characters', () => {
    const log = `${'compiling…\n'.repeat(100)}error TS2322: the conclusion is at the end`
    const result = resultOf(log)
    expect(log.length).toBeGreaterThan(300)
    expect(result.summary).toBe(log.slice(0, 300))
    expect(result.output).toBe(log)
  })

  it('a result made of blocks keeps their text and a tool reference, and leaves the images out', () => {
    const result = resultOf([
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', data: 'aWJs', media_type: 'image/png' } },
      { type: 'text', text: 'second' },
      { type: 'tool_reference', tool_name: 'WebFetch' },
    ])
    expect(result.output).toBe('first\nsecond\n{"type":"tool_reference","tool_name":"WebFetch"}')
    expect(result.output).not.toContain('aWJs')
    // An image alone leaves nothing to keep
    expect(resultOf([{ type: 'image', source: { type: 'base64', data: 'aWJs', media_type: 'image/png' } }])).not.toHaveProperty('output')
  })

  it('a Write keeps its content and an Edit both sides, where the card has only the path', () => {
    const write = { file_path: '/repo/a.ts', content: 'export const a = 1\n'.repeat(50) }
    const edit = { file_path: '/repo/b.ts', old_string: 'old line', new_string: 'new line', replace_all: false }
    const out = n({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'w', name: 'Write', input: write },
          { type: 'tool_use', id: 'e', name: 'Edit', input: edit },
        ],
      },
    }).filter((e) => e.type === 'tool_call')
    expect(out).toMatchObject([
      { callId: 'w', summary: { title: 'Write: /repo/a.ts' }, input: write },
      { callId: 'e', summary: { title: 'Edit: /repo/b.ts' }, input: edit },
    ])
  })

  it('a finished foreground agent keeps its whole report, not the head the card shows', () => {
    const report = `## Findings\n\n${'A long paragraph of the report. '.repeat(40)}\n\nThe conclusion is at the end.`
    const result = resultOf([{ type: 'text', text: `[Subagent hand-back] The text below is the final report…\n\n${report}` }], {
      tool_use_result: { status: 'completed', agentId: 'a1', content: [{ type: 'text', text: report }], totalToolUseCount: 3, totalDurationMs: 4000 },
    })
    expect(result.summary).toBe(`3 tool uses · 4s\n\n${report}`.slice(0, 300))
    expect(result.output).toBe(`3 tool uses · 4s\n\n${report}`)
  })

  it('a finished background agent keeps its whole report, which its task_notification carries in summary', () => {
    const report = `${'The background agent reports at length. '.repeat(20)}Done.`
    const stream = new ClaudeStreamNormalizer(SID)
    stream.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'bg', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
      tool_use_result: { status: 'async_launched', agentId: 'a2' },
    })
    const [done] = stream.push({
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'bg',
      status: 'completed',
      summary: report,
      usage: { tool_uses: 2, duration_ms: 9000 },
    }) as { summary: string; output?: string }[]
    expect(done?.summary).toBe(`2 tool uses · 9s\n\n${report}`.slice(0, 300))
    expect(done?.output).toBe(`2 tool uses · 9s\n\n${report}`)
  })
})

describe('unmapped message types (#58)', () => {
  const unmappedLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('unmapped message type'))

  it('says a type nothing maps once per session in host.log, and nothing for known types', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const one = new ClaudeStreamNormalizer('aaaaaaaa-1')
      // What /clear sends (measured, CLI 2.1.282): nothing maps it, so it is said once however often it comes
      one.push({ type: 'conversation_reset', new_conversation_id: 'c1', trigger: 'clear' })
      one.push({ type: 'conversation_reset', new_conversation_id: 'c2', trigger: 'clear' })
      one.push({ type: 'system', subtype: 'informational', content: 'heads up', level: 'warning' })
      // Mapped, and ignored on purpose: no line
      one.push({ type: 'system', subtype: 'init', session_id: 'x' })
      one.push({ type: 'system', subtype: 'task_started', task_id: 't' })
      one.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
      // Another session has not said it yet
      new ClaudeStreamNormalizer('bbbbbbbb-2').push({ type: 'conversation_reset', new_conversation_id: 'c3' })
      expect(unmappedLines(spy)).toEqual([
        '[claude] aaaaaaaa unmapped message type: conversation_reset',
        '[claude] aaaaaaaa unmapped message type: system/informational',
        '[claude] bbbbbbbb unmapped message type: conversation_reset',
      ])
    } finally {
      spy.mockRestore()
    }
  })
})
