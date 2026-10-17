import { describe, expect, it, afterEach } from 'vitest'
import {
  __setSessionApiForTest,
  forkClaudeSession,
  listClaudeSessions,
  readClaudeHistory,
  UNSUPPORTED as CLAUDE_UNSUPPORTED,
} from './claude/history.js'
import {
  HISTORY_PAGE_TURNS,
  isUnknownMethod,
  readThreadHistory,
  threadListToSummaries,
  turnsToHistory,
  UNSUPPORTED as CODEX_UNSUPPORTED,
} from './codex/history.js'
import { normalizeMessage } from './claude/normalize.js'
import { normalizeNotification } from './codex/normalize.js'
import { cleanTitle, stripInjectedBlocks } from './history-text.js'

/**
 * Loading a previous session only ever reads through **each tool's official API** (parsing a
 * transcript file is forbidden). So there are two things to guard here:
 *   1. that the conversion from the response into a conversation is correct
 *   2. that facing an older tool version backs off **without crashing**, leaving a reason behind
 */

afterEach(() => __setSessionApiForTest(undefined))

describe('claude — SDK forkSession (#677)', () => {
  it('copies the conversation under a new id, from the folder the original ran in', async () => {
    const calls: unknown[] = []
    __setSessionApiForTest({
      listSessions: async () => [],
      forkSession: async (id, o) => {
        calls.push([id, o])
        return { sessionId: 'new-id' }
      },
    })
    expect(await forkClaudeSession('old-id', '/work/app')).toBe('new-id')
    expect(calls).toEqual([['old-id', { dir: '/work/app' }]])
  })

  it('says so when the SDK cannot fork, or forks without a new id, rather than continuing the original', async () => {
    __setSessionApiForTest({ listSessions: async () => [] })
    await expect(forkClaudeSession('old-id', '/work/app')).rejects.toThrow('cannot fork')
    __setSessionApiForTest({ listSessions: async () => [], forkSession: async () => ({}) })
    await expect(forkClaudeSession('old-id', '/work/app')).rejects.toThrow('no session id')
  })
})

describe('claude — SDK listSessions/getSessionMessages', () => {
  it('carries the list into summaries (title priority: user-set -> summary -> first prompt)', async () => {
    __setSessionApiForTest({
      listSessions: async () => [
        { sessionId: 'a', customTitle: 'Refactor', summary: 's', firstPrompt: 'f', lastModified: 1000, gitBranch: 'main' },
        { sessionId: 'b', summary: 'Only a summary is set', lastModified: 2000 },
        { sessionId: 'c', firstPrompt: 'Only the first prompt', lastModified: 3000, createdAt: 500 },
        { sessionId: 'd', lastModified: 4000 },
        { summary: 'Dropped without an id' },
      ],
    })
    const out = await listClaudeSessions('/p', 10)
    expect(out.map((s) => [s.externalId, s.title])).toEqual([
      ['a', 'Refactor'],
      ['b', 'Only a summary is set'],
      ['c', 'Only the first prompt'],
      ['d', 'Untitled session'],
    ])
    expect(out[0]).toMatchObject({ updatedAt: 1000, branch: 'main' })
    expect(out[2]!.createdAt).toBe(500)
  })

  /*
   * #843: an imported conversation used to keep only a tool's name, as a line of the model's words (`Bash`), where a
   * watched one showed the call and its output. The rows are read by the live normalizer now, so each call and result
   * is the event the same message gives live. Shapes as getSessionMessages gives them (SDK 0.3.263: `type`, `message`).
   */
  it('reads tool calls and their results back as the live normalizer reads the same messages (#843)', async () => {
    const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Building' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pnpm build' } }] } }
    const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'exit 0' }], is_error: false }] } }
    __setSessionApiForTest({
      listSessions: async () => [],
      getSessionMessages: async () => [
        { type: 'user', message: { content: [{ type: 'text', text: 'Fix the build' }] } },
        call,
        result,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it' }] } },
        { type: 'system', message: { content: 'compact boundary' } },
      ],
    })
    const live = [...normalizeMessage(call, ''), ...normalizeMessage(result, '')].filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
    expect(live.map((e) => e.type)).toEqual(['tool_call', 'tool_result'])
    expect(await readClaudeHistory('s', '/p', 100)).toEqual([
      { role: 'user', text: 'Fix the build' },
      { role: 'assistant', text: 'Building' },
      { role: 'system', event: live[0] },
      { role: 'system', event: live[1] },
      { role: 'assistant', text: 'Fixed it' },
    ])
    expect(live[0]).toMatchObject({ callId: 'tu1', summary: { tool: 'Bash', title: 'pnpm build' }, input: { command: 'pnpm build' } })
    expect(live[1]).toMatchObject({ callId: 'tu1', ok: true, summary: 'exit 0' })
  })

  it('strips blocks the tool injected and keeps only the person\'s own words', async () => {
    __setSessionApiForTest({
      listSessions: async () => [],
      getSessionMessages: async () => [
        { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
        { type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
        { type: 'user', message: { content: 'Caveat: The messages below were generated by the user' } },
        { type: 'user', message: { content: '<ide_opened_file>a.ts</ide_opened_file>\n\nTake a look at this too' } },
        { type: 'user', message: { content: 'This is really my message' } },
      ],
    })
    expect(await readClaudeHistory('s', '/p', 100)).toEqual([
      { role: 'user', text: 'Take a look at this too' },
      { role: 'user', text: 'This is really my message' },
    ])
  })

  it("keeps a compaction as a marker, where its summary was, rather than as the person's words (#843)", async () => {
    __setSessionApiForTest({
      listSessions: async () => [],
      getSessionMessages: async () => [
        { type: 'user', message: { role: 'user', content: 'Start the work' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] } },
        {
          type: 'user',
          message: {
            role: 'user',
            content:
              'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request',
          },
        },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing' }] } },
      ],
    })
    expect(await readClaudeHistory('s', '/p', 100)).toEqual([
      { role: 'user', text: 'Start the work' },
      { role: 'assistant', text: 'Working on it' },
      { role: 'system', event: { type: 'compaction', sessionId: '', failed: false } },
      { role: 'assistant', text: 'Continuing' },
    ])
  })

  it('an older SDK (missing the function) leaves a reason instead of throwing', async () => {
    __setSessionApiForTest(null)
    await expect(listClaudeSessions('/p', 10)).rejects.toThrow(CLAUDE_UNSUPPORTED)
    await expect(readClaudeHistory('s', '/p', 10)).rejects.toThrow(CLAUDE_UNSUPPORTED)
  })

  it('does not break even when the response is not an array', async () => {
    __setSessionApiForTest({
      listSessions: async () => null as never,
      getSessionMessages: async () => undefined as never,
    })
    expect(await listClaudeSessions('/p', 10)).toEqual([])
    expect(await readClaudeHistory('s', '/p', 10)).toEqual([])
  })
})

describe('codex — thread/list · thread/read', () => {
  it('carries the thread list into summaries (converts a second-based timestamp to ms)', () => {
    const out = threadListToSummaries(
      [
        { id: 't1', preview: 'Fix the tests', updatedAt: 1_700_000_000, createdAt: 1_699_999_000, cwd: '/p' },
        { id: 't2', recencyAt: 1_700_000_500, cwd: '/p' },
        { id: 't3', preview: 'A different folder', cwd: '/other' }, // Filtered on our side even if the server did not filter it
        { preview: 'No id', cwd: '/p' },
      ],
      '/p',
    )
    expect(out).toEqual([
      { externalId: 't1', title: 'Fix the tests', updatedAt: 1_700_000_000_000, createdAt: 1_699_999_000_000 },
      { externalId: 't2', title: 'Untitled session', updatedAt: 1_700_000_500_000, createdAt: undefined },
    ])
  })

  /*
   * #843: every item but the words is read by the live normalizer, as if it had started and completed while the app
   * watched, so a command leaves its card as it does live, and an item kind Codex adds later leaves the card it would
   * leave live. Reasoning is not part of a conversation read back. Item shapes from generated/v2/ThreadItem.ts.
   */
  it('reads the words, and every other item as the live normalizer reads it (#843)', () => {
    const command = { type: 'commandExecution', id: 'c1', command: 'pnpm test', cwd: '/p', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 }
    const future = { type: 'future_item_type', id: 'f1', title: 'does not crash even though it is unknown' }
    const out = turnsToHistory(
      [
        {
          startedAt: 1_700_000_000,
          items: [
            { type: 'userMessage', content: [{ type: 'input_text', text: 'Run the tests' }] },
            { type: 'reasoning', summary: ['thinking'], content: [] },
            command,
            { type: 'agentMessage', text: 'All tests passed' },
            future,
          ],
        },
      ],
      100,
    )
    const live = (item: object) =>
      ['item/started', 'item/completed']
        .flatMap((method) => normalizeNotification('', { method, params: { item } }))
        .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
        .map((event) => ({ role: 'system', event, ts: 1_700_000_000_000 }))
    expect(out).toEqual([
      { role: 'user', text: 'Run the tests', ts: 1_700_000_000_000 },
      ...live(command),
      { role: 'assistant', text: 'All tests passed', ts: 1_700_000_000_000 },
      ...live(future),
    ])
    expect(out[1]).toMatchObject({ event: { type: 'tool_call', callId: 'c1', summary: { tool: 'Bash', title: 'pnpm test' }, input: { command: 'pnpm test', cwd: '/p' } } })
    expect(out[2]).toMatchObject({ event: { type: 'tool_result', callId: 'c1', ok: true, summary: 'ok' } })
  })

  /*
   * #303: the shape thread/read gave on codex-cli 0.160.0 (scripts/probe-codex-compaction.mts, 2026-10-04). A manual
   * compaction is a turn of its own holding only the item; an automatic one opens the turn that triggered it, ahead
   * of its userMessage. Without this the marker a live compaction leaves was missing from every imported conversation.
   */
  it('keeps a compaction as a marker, where it ran (manual and automatic)', () => {
    const out = turnsToHistory(
      [
        { startedAt: 1, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'ready?' }] }, { type: 'agentMessage', text: 'ready' }] },
        { startedAt: 2, items: [{ type: 'contextCompaction', id: 'c1' }] },
        {
          startedAt: 3,
          items: [
            { type: 'contextCompaction', id: 'c2' },
            { type: 'userMessage', content: [{ type: 'text', text: 'and now?' }] },
            { type: 'agentMessage', text: 'after' },
          ],
        },
      ],
      100,
    )
    expect(out).toEqual([
      { role: 'user', text: 'ready?', ts: 1000 },
      { role: 'assistant', text: 'ready', ts: 1000 },
      { role: 'system', event: { type: 'compaction', sessionId: '', failed: false }, ts: 2000 },
      { role: 'system', event: { type: 'compaction', sessionId: '', failed: false }, ts: 3000 },
      { role: 'user', text: 'and now?', ts: 3000 },
      { role: 'assistant', text: 'after', ts: 3000 },
    ])
  })

  it('keeps the most recent conversation past the limit (trims the older side)', () => {
    const turns = [
      {
        items: Array.from({ length: 10 }, (_, i) => ({ type: 'agentMessage', text: `m${i}` })),
      },
    ]
    expect(turnsToHistory(turns, 3).map((m) => (m.role === 'system' ? m.event.type : m.text))).toEqual(['m7', 'm8', 'm9'])
  })

  it("counts the words and compactions toward the limit; a turn's tool rows ride along, an older turn's are cut (#843)", () => {
    const turn = (i: number) => ({
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: `q${i}` }] },
        { type: 'commandExecution', id: `c${i}`, command: 'ls', status: 'completed', aggregatedOutput: 'a' },
        { type: 'agentMessage', text: `a${i}` },
      ],
    })
    const lines = (n: number) =>
      turnsToHistory([turn(0), turn(1), turn(2)], n).map((m) => (m.role === 'system' ? `${m.event.type}:${(m.event as { callId?: string }).callId}` : m.text))
    expect(lines(3)).toEqual(['a1', 'q2', 'tool_call:c2', 'tool_result:c2', 'a2'])
    expect(lines(4)).toEqual(['q1', 'tool_call:c1', 'tool_result:c1', 'a1', 'q2', 'tool_call:c2', 'tool_result:c2', 'a2'])
    expect(lines(0)).toEqual([])
    expect(lines(100)).toHaveLength(12)
  })

  it('gives an empty conversation when turns is missing or malformed', () => {
    expect(turnsToHistory(undefined, 10)).toEqual([])
    expect(turnsToHistory([null, { items: 'not an array' }], 10)).toEqual([])
    expect(threadListToSummaries(undefined, '/p')).toEqual([])
  })

  it('recognizes an older codex\'s "unknown method" response', () => {
    expect(isUnknownMethod(new Error('Method not found'))).toBe(true)
    expect(isUnknownMethod(new Error('JSON-RPC error -32601'))).toBe(true)
    expect(isUnknownMethod(new Error('unknown method thread/list'))).toBe(true)
    // A real failure must not be hidden as "unsupported" — the user needs to see the actual cause
    expect(isUnknownMethod(new Error('EACCES: permission denied'))).toBe(false)
    expect(CODEX_UNSUPPORTED).toMatch(/update/)
  })
})

describe('stripping injected blocks (measured: a title once came out as <system_instruction>)', () => {
  it('strips only the block and keeps the person\'s words that follow it', () => {
    expect(
      stripInjectedBlocks('<ide_opened_file>The user opened /a/b.ts</ide_opened_file>\n\nFix this file'),
    ).toBe('Fix this file')
    expect(stripInjectedBlocks('before\n<system-reminder>background info</system-reminder>\nafter')).toBe('before\n\nafter')
  })

  it('with no closing tag, treats everything from that point on as machine text', () => {
    expect(stripInjectedBlocks('real question\n<system_instruction>\nYou are working inside…')).toBe('real question')
  })

  it('an empty string once stripped means nothing is left — the caller drops that line', () => {
    expect(stripInjectedBlocks('<command-name>/clear</command-name>')).toBe('')
    expect(stripInjectedBlocks('Caveat: The messages below were generated by the user')).toBe('')
  })

  it('a title keeps only the first line after stripping, and is trimmed if too long', () => {
    expect(cleanTitle('<system_instruction>You are working inside Conductor</system_instruction>\nworktree question')).toBe(
      'worktree question',
    )
    expect(cleanTitle('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`)
    expect(cleanTitle('<command-name>/clear</command-name>')).toBe('')
  })

  it('leaves angle-bracket text the model actually wrote untouched', () => {
    expect(stripInjectedBlocks('<div>this is about code</div>')).toBe('<div>this is about code</div>')
  })
})

/*
 * Codex history without full-history hydration (#342). Measured (codex-cli 0.160.0, gpt-5.6-luna, 2026-10-05): on a
 * paginated thread `thread/read` with turns answered 1,205 KB in one line and sent a deprecationNotice; `thread/turns/list`
 * pages newest first with `nextCursor`, and `itemsView: 'full'` carries the same items, `contextCompaction` included
 * (`summary` left it out). The fake below pages a thread the same way.
 */
describe('codex history read in pages (#342)', () => {
  /** A thread of `n` turns, oldest first: each a question and an answer, with a manual compaction as turn 5 */
  const thread = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i === 5
        ? { id: `t${i}`, startedAt: i, status: 'completed', items: [{ type: 'contextCompaction', id: 'c' }] }
        : {
            id: `t${i}`,
            startedAt: i,
            status: 'completed',
            items: [
              { type: 'userMessage', content: [{ type: 'text', text: `q${i}` }] },
              { type: 'commandExecution', command: 'seq 1 40000', aggregatedOutput: '…' },
              { type: 'agentMessage', text: `a${i}` },
            ],
          },
    )

  /** An app-server that pages `turns` newest first, as 0.160.0 does; `calls` records what was asked */
  function pager(turns: unknown[], opts: { pages?: boolean; read?: boolean } = {}) {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const request = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'thread/turns/list') {
        if (opts.pages === false) throw new Error('JSON-RPC error -32601: Method not found')
        const newest = [...turns].reverse()
        const from = typeof params.cursor === 'string' ? Number(params.cursor) : 0
        const size = Number(params.limit)
        const data = newest.slice(from, from + size)
        return { data, nextCursor: from + size < newest.length ? String(from + size) : null, backwardsCursor: null }
      }
      if (method === 'thread/read' && opts.read !== false) return { thread: { id: 'x', turns: params.includeTurns ? turns : [] } }
      throw new Error('JSON-RPC error -32601: Method not found')
    }
    return { request, calls }
  }

  it('reads the newest pages until it has the lines it needs, and gives what the whole read gave', async () => {
    const turns = thread(40)
    const { request, calls } = pager(turns)
    // Two lines a turn: this many lines need a page and a half, so two pages, not all of them
    const limit = 3 * HISTORY_PAGE_TURNS
    const out = await readThreadHistory(request, 'x', limit)
    expect(out).toEqual(turnsToHistory(turns, limit))
    expect(calls.map((c) => c.method)).toEqual(['thread/turns/list', 'thread/turns/list'])
    expect(calls[0]!.params).toEqual({ threadId: 'x', limit: HISTORY_PAGE_TURNS, sortDirection: 'desc', itemsView: 'full' })
    expect(calls[1]!.params).toMatchObject({ cursor: String(HISTORY_PAGE_TURNS) })
    expect(calls.some((c) => c.method === 'thread/read')).toBe(false)
  })

  it('keeps the compaction marker where it ran, across pages, and reads to the first turn when asked for more', async () => {
    const turns = thread(23)
    const { request, calls } = pager(turns)
    const out = await readThreadHistory(request, 'x', 600)
    expect(out).toEqual(turnsToHistory(turns, 600))
    expect(out.filter((m) => m.role === 'system' && m.event.type === 'compaction')).toEqual([
      { role: 'system', event: { type: 'compaction', sessionId: '', failed: false }, ts: 5000 },
    ])
    expect(calls).toHaveLength(Math.ceil(23 / HISTORY_PAGE_TURNS))
  })

  it('reads the whole thread the old way on a Codex without thread/turns/list', async () => {
    const turns = thread(12)
    const { request, calls } = pager(turns, { pages: false })
    expect(await readThreadHistory(request, 'x', 200)).toEqual(turnsToHistory(turns, 200))
    expect(calls.map((c) => c.method)).toEqual(['thread/turns/list', 'thread/read'])
    expect(calls[1]!.params).toEqual({ threadId: 'x', includeTurns: true })
  })

  it('a Codex with neither says why; a thread no message reached is empty; another failure is thrown', async () => {
    await expect(readThreadHistory(pager([], { pages: false, read: false }).request, 'x', 10)).rejects.toThrow(CODEX_UNSUPPORTED)
    const notYet = async () => {
      throw new Error('thread 01a1 is not materialized yet; thread/turns/list is unavailable before first user message')
    }
    expect(await readThreadHistory(notYet, 'x', 10)).toEqual([])
    const broken = async () => {
      throw new Error('no rollout found for thread id x')
    }
    await expect(readThreadHistory(broken, 'x', 10)).rejects.toThrow('no rollout found')
  })
})
