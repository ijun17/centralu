import { afterEach, describe, expect, it, vi } from 'vitest'
import { digest } from './replay.test-helpers.js'
import { AgyWire, type WireOutput } from './wire.js'

/**
 * What a recording cannot give: frames no run produced (a cached token count, a refused action, an `AGY_ERROR` line, a step
 * type the CLI does not have yet) and the order of things that happen once. **Every frame here is written by hand**, from the
 * shapes in `recordings/`, and says so; the recordings' own cases are in `replay.test.ts`.
 */
const step = (s: Record<string, unknown>): string => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', ...s } })
const init = (id = 'c1'): string => JSON.stringify({ event: 'init', conversation_id: id, init: { model: 'm' } })
const result = (r: Record<string, unknown>): string => JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', ...r } })
const usage = (input: number, output: number, cache = 0, thinking = 0) => ({ input_tokens: input, output_tokens: output, thinking_tokens: thinking, cache_read_tokens: cache })

function wire(resume: string | null = null) {
  const w = new AgyWire({ sessionId: 's1', resume })
  const seen: WireOutput[] = []
  const feed = (line: string) => {
    const o = w.stdout(line)
    seen.push(o)
    return o
  }
  return { w, feed, seen }
}

afterEach(() => vi.restoreAllMocks())

describe('tokens', () => {
  it('a cached part of the input is a cache read, not input (assumed: agy counts it in input_tokens), and thinking is already in the output', () => {
    const { feed } = wire()
    feed(init())
    const o = feed(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: usage(1000, 25, 400, 5) }))
    expect(o.events).toMatchObject([{ type: 'usage_update', tokens: { inputTokens: 600, cacheReadTokens: 400, outputTokens: 25 }, request: { inputTokens: 600, cacheReadTokens: 400, outputTokens: 25 } }])
  })

  it('a reading counts the calls of the turn on top of the conversation total, and the result replaces the sum with its total', () => {
    const { w, feed } = wire()
    feed(init())
    w.startTurn('go')
    feed(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: usage(100, 10) }))
    const second = feed(step({ step_index: 3, state: 'DONE', step_type: 'agent_response', usage: usage(150, 20) }))
    expect(second.events).toMatchObject([{ tokens: { inputTokens: 250, outputTokens: 30 }, request: { inputTokens: 150 } }])
    // agy's total is what the conversation has used, which can be more than this turn's calls alone
    const end = feed(result({ usage: usage(1250, 30) }))
    expect(end.events).toMatchObject([{ type: 'usage_update', tokens: { inputTokens: 1250, outputTokens: 30 } }])
    expect(end.events[0]).not.toHaveProperty('request')
  })

  it('a retry flag from one AGY_ERROR line is for that turn only', () => {
    const { w, feed } = wire()
    feed(init())
    w.stderr('AGY_ERROR: {"retryable":true}')
    expect(feed(result({ status: 'ERROR', error: 'a' })).turnEnded).toMatchObject({ error: { retryable: true } })
    expect(feed(result({ status: 'ERROR', error: 'b' })).turnEnded).toMatchObject({ error: { retryable: false } })
  })

  it('a result with no usage of its own leaves the calls\' sum as the reading', () => {
    const { w, feed } = wire()
    feed(init())
    w.startTurn('go')
    feed(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: usage(100, 10) }))
    expect(feed(result({})).events).toEqual([])
    w.startTurn('again')
    const o = feed(step({ step_index: 3, state: 'DONE', step_type: 'agent_response', usage: usage(120, 5) }))
    expect(o.events).toMatchObject([{ tokens: { inputTokens: 220, outputTokens: 15 } }])
  })

  it('a result that only repeats the reading the process started from sends nothing', () => {
    const w = new AgyWire({ sessionId: 's1', resume: 'c1', usageBefore: { inputTokens: 500, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    w.stdout(init('c1'))
    expect(w.stdout(result({ usage: usage(500, 7) })).events).toEqual([])
    expect(w.stdout(result({ usage: usage(520, 7) })).events).toMatchObject([{ type: 'usage_update', tokens: { inputTokens: 520 } }])
  })

  it('a model call that reports nothing makes no reading', () => {
    const { feed } = wire()
    feed(init())
    expect(feed(step({ step_index: 1, state: 'DONE', step_type: 'agent_response' })).events).toEqual([])
  })
})

describe('steps', () => {
  it('a bare newline that ends a model call that only called tools is not a message', () => {
    const { feed } = wire()
    feed(init())
    expect(feed(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' })).events).toEqual([])
  })

  it('a call is announced once however many frames say it is running, and a result alone announces it first', () => {
    const { feed } = wire()
    feed(init())
    const active = step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } })
    expect(digest(feed(active).events)).toEqual(['call c1:2 Bash: ls'])
    expect(feed(active).events).toEqual([])
    const late = step({ step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/a/b' }, output: 'x' } })
    expect(digest(feed(late).events)).toEqual(['call c1:4 Read: /a/b', 'ok c1:4'])
  })

  it('an edit that ended in error marks no file; one that ended ok marks every path it names', () => {
    const { feed } = wire()
    feed(init())
    feed(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'replace_file_content', tool_info: { parameters: { TargetFile: '/w/a.ts' } } }))
    const failed = feed(step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'replace_file_content', tool_info: { error: { type: 'TOOL_ERROR', message: 'tool call denied by pre-tool hook: no' } } }))
    expect(digest(failed.events)).toEqual(['failed c1:2'])
    expect(failed.events[0]).toMatchObject({ output: 'tool call denied by pre-tool hook: no' })
    feed(step({ step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: '/w/b.ts' } } }))
    const ok = feed(step({ step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { output: 'done' } }))
    expect(digest(ok.events)).toEqual(['ok c1:4', 'files /w/b.ts'])
  })

  it('a step of a conversation other than the process\'s is named by its own, so a child\'s step cannot take its parent\'s call', () => {
    const { feed } = wire()
    feed(init())
    feed(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'a' } } }))
    const child = feed(step({ conversation_id: 'c2', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'b' } } }))
    expect(digest(child.events)).toEqual(['call c2:2 Bash: b'])
  })

  it('a tool the card has no name for reads as its own', () => {
    const { feed } = wire()
    feed(init())
    const o = feed(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'browser_click_element', tool_info: { parameters: {} } }))
    expect(digest(o.events)).toEqual(['call c1:2 browser_click_element: browser_click_element'])
  })
})

describe('the turn and the process', () => {
  it('a turn is open from the input to its result, and the input is the stream-json line', () => {
    const { w, feed } = wire()
    expect(w.turnOpen).toBe(false)
    expect(JSON.parse(w.startTurn('hi'))).toEqual({ event: 'user', message: { content: 'hi' } })
    expect(w.turnOpen).toBe(true)
    feed(init())
    feed(result({}))
    expect(w.turnOpen).toBe(false)
  })

  it('the exit closes the calls the process left open, so no card spins', () => {
    const { w, feed } = wire()
    feed(init())
    feed(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'sleep 9' } } }))
    expect(digest(w.exit().events)).toEqual(['failed c1:2'])
  })

  it('an interrupted result after a Stop is ours once; a later one is not', () => {
    const { w, feed } = wire()
    feed(init())
    w.startTurn('a')
    w.stopRequested()
    expect(feed(result({ status: 'ERROR', error: 'interrupted' })).turnEnded).toEqual({ how: 'interrupted', byUs: true })
    w.startTurn('b')
    expect(feed(result({ status: 'ERROR', error: 'interrupted' })).turnEnded).toEqual({ how: 'interrupted', byUs: false })
  })

  it('a failed turn says agy\'s error; an AGY_ERROR line before it decides whether to retry', () => {
    const { w, feed } = wire()
    feed(init())
    expect(feed(result({ status: 'ERROR', error: 'model not found' })).turnEnded).toEqual({ how: 'failed', error: { code: 'internal', message: 'Antigravity: model not found', retryable: false } })
    w.stderr('AGY_ERROR: {"status":"UNAVAILABLE","retryable":true,"id":"e1"}')
    expect(feed(result({ status: 'ERROR', error: 'try later' })).turnEnded).toMatchObject({ how: 'failed', error: { retryable: true } })
  })

  it('what agy refused in spite of the gate is a notice naming it', () => {
    const { feed } = wire()
    feed(init())
    const o = feed(result({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }))
    expect(o.events).toMatchObject([{ type: 'notice', level: 'warning', text: 'Antigravity refused: RunCommand.' }])
  })
})

describe('resume', () => {
  it('an init with the conversation asked for is the session\'s id and goes on', () => {
    const { feed } = wire('c1')
    expect(feed(init('c1'))).toEqual({ events: [], externalId: 'c1' })
  })

  it('an init with another id stops the process and says the conversation is not there; its steps and result are dropped', () => {
    const { feed } = wire('c1')
    expect(feed(init('c9'))).toEqual({ events: [], stop: true, sessionNotFound: true })
    expect(feed(step({ conversation_id: 'c9', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'lost' }))).toEqual({ events: [] })
    expect(feed(result({ conversation_id: 'c9' }))).toEqual({ events: [] })
  })

  it('the warning that comes before init already says it, so the process is stopped before it can run the turn', () => {
    const { w, feed } = wire('c1')
    expect(w.stderr('warning: conversation "c1" not found')).toEqual({ events: [], stop: true, sessionNotFound: true })
    // The init that follows is the new conversation's and is not the session's
    expect(feed(init('c9'))).toEqual({ events: [] })
  })

  it('a warning that names another conversation is not ours', () => {
    const { w } = wire('c1')
    expect(w.stderr('warning: conversation "c7" not found')).toEqual({ events: [] })
  })

  it('a new conversation has nothing to check', () => {
    const { w, feed } = wire(null)
    expect(w.stderr('warning: conversation "c1" not found')).toEqual({ events: [] })
    expect(feed(init('anything')).externalId).toBe('anything')
  })
})

describe('what agy may add', () => {
  it('an unknown step type, event or line maps to nothing and is logged once', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { feed } = wire()
    feed(init())
    for (let i = 0; i < 3; i++) {
      expect(feed(step({ step_index: 1, state: 'DONE', step_type: 'compaction' })).events).toEqual([])
      expect(feed(JSON.stringify({ event: 'keep_alive' })).events).toEqual([])
      expect(feed('not json').events).toEqual([])
    }
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('compaction'), expect.stringContaining('keep_alive'), expect.stringContaining('(not JSON)')])
  })

  it('a known event whose shape changed is unknown, not a crash', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { feed } = wire()
    expect(feed(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool' } })).events).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
  })
})
