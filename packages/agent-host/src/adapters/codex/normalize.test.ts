import { describe, expect, it, vi } from 'vitest'
import { __resetWarningsForTest, approvalDetailFrom, CompactionMarks, normalizeNotification, toCodexDecision } from './normalize.js'

/**
 * A-2 contract tests. The fixtures are trimmed-down versions of protocol output **actually
 * recorded** during the M0 spike (docs/spikes/m0-findings.md). They must run without a real
 * process so CI can use them.
 */

const S = 'sess-1'
const n = (method: string, params?: unknown) => normalizeNotification(S, { method, params })

describe('streaming and tool calls', () => {
  it('agentMessage delta → message_delta', () => {
    expect(n('item/agentMessage/delta', { delta: 'hello' })).toEqual([
      { type: 'message_delta', sessionId: S, role: 'assistant', text: 'hello' },
    ])
  })

  it('an agentMessage chunk names its item, so the host can tell one message from the next (#212)', () => {
    expect(n('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'msg-1', delta: 'hello' })).toEqual([
      { type: 'message_delta', sessionId: S, role: 'assistant', text: 'hello', messageId: 'msg-1' },
    ])
    expect(n('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'hello', phase: 'commentary' } })).toEqual([
      { type: 'message_delta', sessionId: S, role: 'assistant', text: '', messageId: 'msg-1' },
    ])
  })

  /*
   * Reasoning summary (measured for #58). This stream only arrives when model_reasoning_summary
   * is turned on in the thread settings, and the measured shape is {itemId, delta, summaryIndex}.
   * The full summary text on the completed item is not emitted — it is text that already
   * streamed through the deltas.
   */
  it('reasoning summaryTextDelta → reasoning_delta', () => {
    expect(n('item/reasoning/summaryTextDelta', { itemId: 'rs-1', delta: '**Reviewing path constraints**', summaryIndex: 0 })).toEqual([
      { type: 'reasoning_delta', sessionId: S, text: '**Reviewing path constraints**' },
    ])
  })

  it('from the second paragraph on, the boundary becomes a blank line — there is nothing before the first paragraph', () => {
    expect(n('item/reasoning/summaryPartAdded', { itemId: 'rs-1', summaryIndex: 0 })).toEqual([])
    expect(n('item/reasoning/summaryPartAdded', { itemId: 'rs-1', summaryIndex: 1 })).toEqual([
      { type: 'reasoning_delta', sessionId: S, text: '\n\n' },
    ])
  })

  it('the reasoning item on completed stays silent too (it would duplicate the delta)', () => {
    expect(n('item/completed', { item: { type: 'reasoning', id: 'rs-1', summary: ['**Reviewing path constraints**'], content: [] } })).toEqual([])
  })

  /*
   * Plan progress (measured for #58, 2026-08-26). Measured shape: a full snapshot every time,
   * {threadId, turnId, explanation: null, plan: [{step, status}]}. A plan never arrives as an
   * item — this notification is the only path to the screen.
   */
  it('turn/plan/updated → plan_update (the snapshot, unchanged)', () => {
    expect(
      n('turn/plan/updated', {
        threadId: 't', turnId: 'u', explanation: null,
        plan: [
          { step: 'Set up', status: 'completed' },
          { step: 'Run the command', status: 'inProgress' },
          { step: 'Report', status: 'pending' },
        ],
      }),
    ).toEqual([
      {
        type: 'plan_update', sessionId: S,
        steps: [
          { text: 'Set up', status: 'completed' },
          { text: 'Run the command', status: 'inProgress' },
          { text: 'Report', status: 'pending' },
        ],
      },
    ])
  })

  it('an unknown plan status folds to pending — progress display must not die outright over one new status value', () => {
    const out = n('turn/plan/updated', { plan: [{ step: 'X', status: 'blocked?' }] })
    expect(out[0]).toMatchObject({ steps: [{ text: 'X', status: 'pending' }] })
  })

  it('an empty plan produces no event', () => {
    expect(n('turn/plan/updated', { plan: [] })).toEqual([])
  })

  // Output while a command is running (measured for #58): {threadId, turnId, itemId, delta}
  it('commandExecution outputDelta → tool_output_delta', () => {
    expect(n('item/commandExecution/outputDelta', { threadId: 't', turnId: 'u', itemId: 'exec-1', delta: 'tick 2\n' })).toEqual([
      { type: 'tool_output_delta', sessionId: S, callId: 'exec-1', text: 'tick 2\n' },
    ])
    expect(n('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: '' })).toEqual([])
  })

  it('the start of a commandExecution → tool_call (the full command text is the title)', () => {
    const out = n('item/started', {
      item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'npm test'", cwd: '/tmp' },
    })
    expect(out).toEqual([
      {
        type: 'tool_call',
        sessionId: S,
        callId: 'exec-1',
        summary: { tool: 'Bash', title: "/bin/zsh -lc 'npm test'", readOnly: false, paths: [] },
        input: { command: "/bin/zsh -lc 'npm test'", cwd: '/tmp' },
      },
    ])
  })

  it('a read-only command gives a collapse hint', () => {
    const out = n('item/started', { item: { type: 'commandExecution', id: 'e', command: "/bin/zsh -lc 'ls -la'" } })
    expect(out[0]).toMatchObject({ summary: { readOnly: true } })
  })

  it('fileChange completed → tool_result + files_touched (for conflict detection)', () => {
    const out = n('item/completed', {
      item: { type: 'fileChange', id: 'fc-1', status: 'completed', changes: [{ path: 'src/a.ts', diff: '+1' }] },
    })
    expect(out.map((e) => e.type)).toEqual(['tool_result', 'files_touched'])
    expect(out[1]).toMatchObject({ paths: ['src/a.ts'] })
  })

  it('a failed tool gets ok=false', () => {
    const out = n('item/completed', { item: { type: 'commandExecution', id: 'e', status: 'failed', output: 'error' } })
    expect(out[0]).toMatchObject({ type: 'tool_result', ok: false })
  })

  /*
   * An MCP call's answer is carried in a **different place** from commandExecution (result and
   * error). Because that place was not read, a failed MCP card was red with not a single
   * character of reason (dogfooding 2026-09-08: the same tool was succeeding in a neighboring
   * session).
   */
  /*
   * There was a case where a single differing argument name kept one session failing on its own
   * (dogfooding 2026-09-08: the call that worked used {message}, the one that failed used
   * {query}). With only the tool name on the card, the two look identical on screen.
   */
  it('an MCP call card shows arguments too — the argument is what distinguishes two calls of the same tool', () => {
    const out = n('item/started', {
      item: {
        type: 'mcpToolCall', id: 'm0', server: 'msw-mcp', tool: 'mlua_api_retriever',
        status: 'inProgress', arguments: { query: 'Struct' },
      },
    })
    expect(out[0]).toMatchObject({ type: 'tool_call' })
    expect((out[0] as { summary: { title: string } }).summary.title).toBe(
      'msw-mcp: mlua_api_retriever {query: Struct}',
    )
  })

  it('a long argument is trimmed — seeing the shape is enough, the full body is not needed', () => {
    const out = n('item/started', {
      item: {
        type: 'mcpToolCall', id: 'm4', server: 's', tool: 't', status: 'inProgress',
        arguments: { message: 'x'.repeat(200) },
      },
    })
    const title = (out[0] as { summary: { title: string } }).summary.title
    expect(title.length).toBeLessThan(120)
    expect(title).toContain('message: xxx')
    expect(title.endsWith('…}')).toBe(true)
  })

  it('an MCP failure carries a reason — an empty card says nothing', () => {
    const out = n('item/completed', {
      item: {
        type: 'mcpToolCall', id: 'm1', server: 'msw-mcp', tool: 'mlua_document_retriever',
        status: 'failed', error: { message: 'unexpected error' }, result: null,
      },
    })
    expect(out[0]).toMatchObject({ type: 'tool_result', ok: false, summary: 'unexpected error' })
  })

  it('an MCP success carries the answer body', () => {
    const out = n('item/completed', {
      item: {
        type: 'mcpToolCall', id: 'm2', server: 'msw-mcp', tool: 'mlua_api_retriever',
        status: 'completed', error: null,
        result: { content: [{ type: 'text', text: 'first line' }, { type: 'text', text: 'second line' }] },
      },
    })
    expect(out[0]).toMatchObject({ ok: true, summary: 'first line\nsecond line' })
  })

  it('when only a structured answer exists, that is carried instead', () => {
    const out = n('item/completed', {
      item: {
        type: 'mcpToolCall', id: 'm3', server: 's', tool: 't', status: 'completed',
        error: null, result: { content: [], structuredContent: { ok: 1 } },
      },
    })
    expect(out[0]).toMatchObject({ summary: '{"ok":1}' })
  })

  it('drops user-message and reasoning items (conversation-window noise)', () => {
    expect(n('item/started', { item: { type: 'userMessage', id: 'u' } })).toEqual([])
    expect(n('item/completed', { item: { type: 'reasoning', id: 'r' } })).toEqual([])
  })

  /*
   * Viewing an image (#40). Measured shape: {type:'imageView', id, path} — only the path arrives.
   * data must stay empty here (a pure function) since the adapter reads the file to fill it in.
   */
  it('imageView completed → message_image carrying only the path (no tool line is created)', () => {
    expect(n('item/started', { item: { type: 'imageView', id: 'iv', path: '/tmp/shot.png' } })).toEqual([])
    expect(n('item/completed', { item: { type: 'imageView', id: 'iv', path: '/tmp/shot.png' } })).toEqual([
      { type: 'message_image', sessionId: S, mime: '', data: '', path: '/tmp/shot.png' },
    ])
  })

  it('drops an imageView with no path (nothing to draw)', () => {
    expect(n('item/completed', { item: { type: 'imageView', id: 'iv' } })).toEqual([])
  })
})

/*
 * A tool call is kept whole (#221). The card's summary stays as it was — the first 2,000 characters of a result, the
 * paths of a file change — and the record goes in `output` and `input`. Shapes follow generated/v2/ThreadItem.ts.
 */
describe('the whole record of a tool call (#221)', () => {
  it('a result keeps its whole output, and the card still shows the first 2,000 characters', () => {
    const log = `${'building…\n'.repeat(400)}error: the conclusion is at the end`
    const [result] = n('item/completed', {
      item: { type: 'commandExecution', id: 'e', status: 'completed', command: 'npm run build', aggregatedOutput: log, exitCode: 1 },
    })
    expect(log.length).toBeGreaterThan(2000)
    expect(result).toMatchObject({ type: 'tool_result', summary: log.slice(0, 2000), output: log })
  })

  it('an MCP result keeps its whole text, and an empty result carries no output', () => {
    const text = 'x'.repeat(5000)
    const [mcp] = n('item/completed', {
      item: { type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'completed', result: { content: [{ type: 'text', text }] } },
    })
    expect(mcp).toMatchObject({ output: text })
    const [empty] = n('item/completed', { item: { type: 'fileChange', id: 'fc', status: 'completed', changes: [] } })
    expect(empty).not.toHaveProperty('output')
  })

  it('a file change keeps each file with its diff, where the card has only the paths', () => {
    const changes = [
      { path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'src/b.ts', kind: { type: 'add' }, diff: '+export {}' },
    ]
    const [call] = n('item/started', { item: { type: 'fileChange', id: 'fc', status: 'inProgress', changes } })
    expect(call).toMatchObject({ type: 'tool_call', summary: { title: 'src/a.ts, src/b.ts' }, input: { changes } })
  })

  it('a command keeps what was asked and none of how it went; an MCP call keeps its arguments', () => {
    const [cmd] = n('item/started', {
      item: {
        type: 'commandExecution', id: 'e', command: 'ls', cwd: '/repo', status: 'inProgress',
        aggregatedOutput: null, exitCode: null, durationMs: null, processId: 'pty-1',
      },
    })
    expect((cmd as { input?: unknown }).input).toEqual({ command: 'ls', cwd: '/repo' })
    const args = { query: 'boundaries', limit: 5 }
    const [mcp] = n('item/started', {
      item: { type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'inProgress', arguments: args, result: null, error: null },
    })
    expect((mcp as { input?: unknown }).input).toEqual({ server: 's', tool: 't', arguments: args })
  })
})

describe('state and gauges', () => {
  it('turn/completed → turn_complete', () => {
    expect(n('turn/completed', {})).toEqual([{ type: 'turn_complete', sessionId: S }])
  })

  /*
   * A failed turn arrives on the same notification (generated/v2/Turn.ts: status + error). While
   * we were dropping turn.* wholesale here, a turn that died with a 400 still went out as nothing
   * more than turn_complete, same as a successful one — the screen was left with an empty answer,
   * and the state stayed at "waiting for the person". The fixture is the shape of the real incident (#107).
   */
  it('a failed turn/completed → error (does not emit turn_complete)', () => {
    const out = n('turn/completed', {
      threadId: 't1',
      turn: {
        id: 'turn-7',
        items: [],
        status: 'failed',
        error: {
          message: "The 'opus[1m]' model is not supported",
          codexErrorInfo: 'badRequest',
          additionalDetails: 'invalid_request_error',
          misalignment: null,
        },
      },
    })
    expect(out).toEqual([
      {
        type: 'error',
        sessionId: S,
        error: {
          code: 'internal',
          message: "The 'opus[1m]' model is not supported\ninvalid_request_error",
          retryable: true,
        },
      },
    ])
  })

  /*
   * A failed turn arrives as both an `error` notification and a turn/completed(failed) (#168).
   * Measured (from a copy of the database): a single token-refresh failure left the same sentence
   * three times across two lines within the same second. We keep only one line, based on the
   * turn's own outcome. An error that will be retried is not a marker.
   */
  it('a failed turn leaves one marker line — an error notification tied to a turn is left to turn/completed(failed) (#168)', () => {
    const error = { message: 'Your access token could not be refreshed', codexErrorInfo: null, additionalDetails: null, misalignment: null }
    const failed = [
      ...n('error', { error, willRetry: false, threadId: 'th', turnId: 'turn-9' }),
      ...n('turn/completed', { threadId: 'th', turn: { id: 'turn-9', items: [], status: 'failed', error } }),
    ]
    expect(failed.filter((e) => e.type === 'error')).toHaveLength(1)
    // An error outside any turn has no outcome to defer to — it is emitted as-is
    expect(n('error', { error, willRetry: false, threadId: 'th', turnId: '' })).toHaveLength(1)
  })

  it('an error Codex will retry (willRetry) is not a failure marker but the retrying activity (#168)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // As codex-cli 0.153.4 sent it (2026-10-03): the attempt in `message`, the reason in `additionalDetails`
    const error = {
      message: 'Reconnecting... 1/2',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: 'stream disconnected before completion: stream closed before response.completed',
      misalignment: null,
    }
    expect(n('error', { error, willRetry: true, threadId: 'th', turnId: 'turn-1' })).toEqual([
      { type: 'activity', sessionId: S, activity: 'retrying' },
    ])
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('stream closed before response.completed'))
    spy.mockRestore()
  })

  it('an interrupted turn is not a failure — the person stopped it, and the conversation continues', () => {
    expect(n('turn/completed', { turn: { id: 't', status: 'interrupted', error: null } })).toEqual([
      { type: 'turn_complete', sessionId: S },
    ])
  })

  it('tokenUsage → usage_update (+ context_update when a window exists)', () => {
    const out = n('thread/tokenUsage/updated', {
      // `last` is required by ThreadTokenUsage and is what fills the window; `total` is the
      // thread's running spend and feeds usage_update only.
      tokenUsage: {
        total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, totalTokens: 120 },
        last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, totalTokens: 120 },
      },
      contextWindow: 1_000_000,
    })
    // Codex counts the 80 cached tokens inside its 100 input tokens; the protocol keeps them apart (TokenUsage)
    expect(out[0]).toMatchObject({ type: 'usage_update', tokens: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 80 } })
    expect(out[1]).toMatchObject({ type: 'context_update', used: 120, window: 1_000_000, exactness: 'exact' })
  })

  /*
   * A usage update is not the same as hitting a limit.
   *
   * Without this distinction, a codex session flipped to 'limited' right after its very first
   * tool call — even when the measured value was 27%. The spinning icon froze, dimmed, and a
   * nonexistent label got slapped on. The tool tells us directly through
   * `rateLimitReachedType`, and we simply were not looking at it.
   */
  it('nothing happens while the limit has not been hit yet — usage climbing is normal', () => {
    expect(
      n('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1787198872 },
          rateLimitReachedType: null,
        },
      }),
    ).toEqual([])
  })

  it('limit_reached only once it is actually hit (includes the weekly window and reset time)', () => {
    const out = n('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1787198872 },
        rateLimitReachedType: 'rate_limit_reached',
      },
    })
    expect(out[0]).toMatchObject({ type: 'limit_reached', usedPercent: 100, windowMins: 10080 })
    expect((out[0] as { resumeAt?: string }).resumeAt).toMatch(/^\d{4}-/)
  })

  it('a spend limit is a limit too', () => {
    const out = n('account/rateLimits/updated', {
      rateLimits: { primary: { usedPercent: 40 }, spendControlReached: true },
    })
    expect(out[0]).toMatchObject({ type: 'limit_reached' })
  })

  it('thread/name/updated → session_title (FR-18 automatic naming)', () => {
    expect(n('thread/name/updated', { name: 'auth refactor' })).toEqual([
      // auto:true — a name the tool made up on its own, so it never overwrites a name the person set (issue #5)
      { type: 'session_title', sessionId: S, title: 'auth refactor', auto: true },
    ])
  })

  /*
   * Codex streams compaction as a ThreadItem (generated/v2/ThreadItem.ts: `contextCompaction`).
   * Without filtering it out, it flows through itemSummary and creates a **fake tool-call line**
   * in the conversation. Measured on codex-cli 0.147.0, 0.153.4 and 0.160.0 (#303).
   */
  it('a compaction item is an activity, not a tool call', () => {
    expect(n('item/started', { item: { type: 'contextCompaction', id: 'i1' } })).toEqual([
      { type: 'activity', sessionId: S, activity: 'compacting' },
    ])
  })

  /*
   * #303: the completed item is the only sign of a finished compaction Codex sends (no `thread/compacted` on 0.147.0,
   * 0.153.4 or 0.160.0). The marker used to come only from that notification, so no Codex compaction left one.
   */
  it('a completed compaction item clears the activity and leaves the compaction marker', () => {
    expect(n('item/completed', { threadId: 't', turnId: 'u1', item: { type: 'contextCompaction', id: 'i1' } })).toEqual([
      { type: 'activity', sessionId: S, activity: null },
      { type: 'compaction', sessionId: S, failed: false },
    ])
  })

  /*
   * A review (/review -> the review/start RPC) is the same kind of thing — the measured shape
   * (from the real app-server): enteredReviewMode -> agentMessage (the full result streaming) ->
   * exitedReviewMode (with the full text on review). Without filtering the start/end items, they
   * become unidentifiable tool lines, and emitting exited's review again would append the result
   * that already arrived via agentMessage a second time.
   */
  it('the start-of-review item is activity=reviewing', () => {
    expect(n('item/started', { item: { type: 'enteredReviewMode', id: 'i1', review: 'current changes' } })).toEqual([
      { type: 'activity', sessionId: S, activity: 'reviewing' },
    ])
  })

  it('the end-of-review item only clears the activity, without emitting the result again (it already arrived via agentMessage)', () => {
    expect(n('item/completed', { item: { type: 'exitedReviewMode', id: 'i2', review: '- [P1] …' } })).toEqual([
      { type: 'activity', sessionId: S, activity: null },
    ])
    // Neither side (started/completed) becomes a tool line
    expect(n('item/completed', { item: { type: 'enteredReviewMode', id: 'i1' } })).toEqual([])
    expect(n('item/started', { item: { type: 'exitedReviewMode', id: 'i2' } })).toEqual([
      { type: 'activity', sessionId: S, activity: null },
    ])
  })

  /*
   * The name lives at the top level, but reading invocation.tool made every one of Codex's MCP
   * calls collapse into 'MCP' — there was no way to tell which tool was used from the
   * conversation window.
   */
  it('an MCP tool call shows the server and tool name', () => {
    const out = n('item/started', {
      item: { type: 'mcpToolCall', id: 'm1', server: 'centralu', tool: 'list_sessions', status: 'inProgress' },
    })
    expect(out[0]).toMatchObject({
      type: 'tool_call',
      summary: { tool: 'list_sessions', title: 'centralu: list_sessions' },
    })
  })

  it('thread/compacted → the compaction marker (FR-14), for a CLI that still sends it', () => {
    expect(n('thread/compacted', {})).toEqual([{ type: 'compaction', sessionId: S, failed: false }])
  })

  it('thread/goal/updated → a goal event (2026-09-07 — codex vocabulary carried through unchanged)', () => {
    const out = n('thread/goal/updated', {
      threadId: 't1',
      turnId: null,
      goal: { threadId: 't1', objective: 'build green', status: 'blocked', tokenBudget: 50000, tokensUsed: 1200, createdAt: 1, updatedAt: 2 },
    })
    expect(out).toEqual([
      { type: 'goal', sessionId: S, goal: { objective: 'build green', status: 'blocked', tokenBudget: 50000, tokensUsed: 1200 } },
    ])
  })

  it('thread/goal/cleared → goal:null (a clearing notification)', () => {
    expect(n('thread/goal/cleared', { threadId: 't1' })).toEqual([{ type: 'goal', sessionId: S, goal: null }])
  })

  it('an updated with status:complete is a clearing too — an achieved badge must not stay forever (dogfooding 2026-09-07)', () => {
    const out = n('thread/goal/updated', {
      threadId: 't1',
      turnId: null,
      goal: { threadId: 't1', objective: 'build green', status: 'complete', tokenBudget: null, tokensUsed: 900, createdAt: 1, updatedAt: 2 },
    })
    expect(out).toEqual([{ type: 'goal', sessionId: S, goal: null }])
  })

  it('drops an unknown notification silently (does not break as the protocol grows)', () => {
    expect(n('thread/realtime/audioDelta', { blob: 'x' })).toEqual([])
    expect(n('totally/new/method', {})).toEqual([])
  })
})

/*
 * #303: a compaction can have two signs, the completed item and the deprecated `thread/compacted`. Every measured CLI
 * sent only the item, but one that sends both must still leave one marker, in either order.
 */
describe('one compaction marker per compaction (CompactionMarks)', () => {
  const item = (turnId: string) => ({ method: 'item/completed', params: { turnId, item: { type: 'contextCompaction', id: 'c' } } })
  const notice = (turnId: string) => ({ method: 'thread/compacted', params: { threadId: 't', turnId } })

  it('admits the item alone (0.160.0) and the notice alone (a CLI that only sends that)', () => {
    const marks = new CompactionMarks()
    expect([marks.admit(item('u1')), marks.admit(notice('u2'))]).toEqual([true, true])
  })

  it('pairs the item and the notice of one turn, in either order', () => {
    const marks = new CompactionMarks()
    expect([marks.admit(item('u1')), marks.admit(notice('u1'))]).toEqual([true, false])
    expect([marks.admit(notice('u2')), marks.admit(item('u2'))]).toEqual([true, false])
  })

  it('keeps two compactions of one turn that each send only the item, and pairs per turn', () => {
    const marks = new CompactionMarks()
    expect([marks.admit(item('u1')), marks.admit(item('u1')), marks.admit(notice('u1')), marks.admit(notice('u1'))]).toEqual([
      true, true, false, false,
    ])
    // A notice for a turn whose item already found its partner is a compaction of its own
    expect(marks.admit(notice('u1'))).toBe(true)
  })
})

describe('approval request conversion (the basis for approving right from the banner)', () => {
  it('a command approval → kind=command (a shape the banner can approve directly)', () => {
    const d = approvalDetailFrom('item/commandExecution/requestApproval', {
      item: { command: 'npm run build', cwd: '/tmp/p' },
    })
    expect(d).toEqual({ kind: 'command', command: 'npm run build', cwd: '/tmp/p' })
  })

  it('a file-edit approval → kind=file_edit with the changes of the item it names (branches to "needs review" since the diff must be seen)', () => {
    const d = approvalDetailFrom(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'fc', startedAtMs: 1, reason: null, grantRoot: null },
      [
        { path: 'a.ts', diff: '+x' },
        { path: 'b.ts', diff: '-y' },
      ],
    )
    expect(d).toEqual({ kind: 'file_edit', path: 'a.ts', diffPreview: 'a.ts\n+x\n\nb.ts\n-y', multi: true })
  })

  it('a file-edit approval whose item is unknown says (no path) rather than an empty path (#169)', () => {
    const d = approvalDetailFrom('item/fileChange/requestApproval', { threadId: 't', turnId: 'u', itemId: 'gone', startedAtMs: 1 })
    expect(d).toEqual({ kind: 'file_edit', path: '(no path)', diffPreview: '', multi: false })
  })

  it('the older applyPatchApproval builds its card from fileChanges, keyed by path (#169)', () => {
    const d = approvalDetailFrom('applyPatchApproval', {
      conversationId: 't',
      callId: 'c',
      fileChanges: {
        'src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null },
        'src/new.ts': { type: 'add', content: 'export {}\n' },
      },
      reason: null,
      grantRoot: null,
    })
    expect(d).toEqual({
      kind: 'file_edit',
      path: 'src/a.ts',
      diffPreview: 'src/a.ts\n@@ -1 +1 @@\n-a\n+b\n\n\nsrc/new.ts\nexport {}\n',
      multi: true,
    })
  })

  it('an unknown approval kind becomes other (leaves the judgment to the person)', () => {
    expect(approvalDetailFrom('item/unknown/requestApproval', { x: 1 })).toMatchObject({ kind: 'other' })
  })
})

describe('approval decision mapping (the ones we use, out of the six confirmed in M0)', () => {
  it('allow, deny, always allow', () => {
    expect(toCodexDecision('allow')).toBe('accept')
    expect(toCodexDecision('deny')).toBe('decline')
    // The protocol has a value that maps exactly to "always allow, this session"
    expect(toCodexDecision('always')).toBe('acceptForSession')
  })

  /*
   * Regression: we read `contextWindow`, Codex sends `modelContextWindow`
   * (generated/v2/ThreadTokenUsage.ts). Nothing failed — `usage_update` still went out, so
   * tokens looked right and only the percentage was missing, while the adapter went on
   * declaring `contextUsage: 'exact'`. The shape below is copied from the generated type.
   */
  describe('the context window comes from modelContextWindow', () => {
    const notification = {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        tokenUsage: {
          // total is cumulative across the thread; last is this turn. They differ on purpose here.
          total: { totalTokens: 900000, inputTokens: 800000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100000, reasoningOutputTokens: 0 },
          last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
          modelContextWindow: 200000,
        },
      },
    }

    it('emits context_update so a percentage can be shown', () => {
      const events = n(notification.method, notification.params)
      const ctx = events.find((e) => e.type === 'context_update')
      // 1200 (this turn), not 900000 (everything the thread has spent)
      expect(ctx).toMatchObject({ used: 1200, window: 200000, exactness: 'exact' })
    })

    /*
     * Regression: reading `total` put the thread's running spend against a fixed window, and
     * the gauge reported 149,084% on a real session before anyone noticed.
     */
    it('a value larger than the window is a misread, not a reading, so it is not emitted', () => {
      __resetWarningsForTest()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const absurd = {
        ...notification,
        params: {
          ...notification.params,
          tokenUsage: { ...notification.params.tokenUsage, last: { ...notification.params.tokenUsage.last, totalTokens: 1_235_017_921 } },
        },
      }
      const events = n(absurd.method, absurd.params)
      expect(events.some((e) => e.type === 'context_update')).toBe(false)
      expect(events.some((e) => e.type === 'usage_update')).toBe(true)
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('when the window is missing, that fact is not buried silently', () => {
      __resetWarningsForTest()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const without = { ...notification, params: { ...notification.params, tokenUsage: { ...notification.params.tokenUsage, modelContextWindow: null } } }
      const events = n(without.method, without.params)
      expect(events.some((e) => e.type === 'context_update')).toBe(false)
      expect(events.some((e) => e.type === 'usage_update')).toBe(true)
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })
})
