import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { tokensOf } from './normalize.js'
import { digest, RECORDINGS, replay } from './replay.test-helpers.js'
import { parseLine } from './stream.js'

/**
 * The wire over the recorded runs (docs/plans/antigravity-adapter.md §10.2): every recording of every version is played into
 * `AgyWire` line by line, and what comes out is what the person would have seen. These are `agy` 1.4.7 and 1.4.8 as they ran;
 * the cases a recording cannot give are in `wire.test.ts`, said there to be written by hand.
 */
// The names of the recordings, as the bundler finds them (the files are read by `loadRecording`)
const FOUND = Object.keys(import.meta.glob('./recordings/*/*.jsonl', { query: '?url' })).flatMap((k) => {
  const m = /([^/]+)\/([^/]+)$/.exec(k)
  return m?.[1] && m[2] ? [[m[1], m[2]] as const] : []
})
const VERSIONS = [...new Set(FOUND.map(([v]) => v))]
// `commands` is `agy -p /usage` and the like: no stream, no wire
const files = (v: string) => FOUND.filter(([d, f]) => d === v && f !== 'commands.jsonl').map(([, f]) => f)
const path = (v: string, name: string) => `${RECORDINGS}/${v}/${name}.jsonl`
/** Recordings whose Stop was sent by the recorder without a note: right after the input */
const STOPPED = (name: string) => name.startsWith('interrupt')
const tokenTotals = (events: readonly NormalizedEvent[]) => events.flatMap((e) => (e.type === 'usage_update' ? [e.tokens.inputTokens + e.tokens.outputTokens] : []))

describe('every recording', () => {
  for (const v of VERSIONS) {
    for (const f of files(v)) {
      const name = f.replace(/\.jsonl$/, '')
      it(`${v}/${name}: the launch and the input are what the recording ran, every call ends, and the reading only grows`, () => {
        const r = replay(path(v, name), { stopAfterInput: STOPPED(name) })
        expect(r.problems).toEqual([])
        const called = r.events.filter((e) => e.type === 'tool_call').map((e) => e.callId)
        const ended = r.events.filter((e) => e.type === 'tool_result').map((e) => e.callId)
        expect(ended.sort()).toEqual(called.sort())
        const totals = tokenTotals(r.events)
        expect(totals).toEqual([...totals].sort((a, b) => a - b))
      })
    }
  }

  it('the last reading of a run is the total its last result reports', () => {
    let compared = 0
    for (const v of VERSIONS) {
      for (const f of files(v)) {
        const r = replay(`${RECORDINGS}/${v}/${f}`, { stopAfterInput: STOPPED(f) })
        const results = r.recording.frames.flatMap((x) => {
          const frame = x.dir === 'in' ? parseLine(JSON.stringify(x.msg)) : null
          return frame?.event === 'result' ? [frame.result] : []
        })
        const last = results.at(-1)
        const reading = r.events.findLast((e): e is Extract<NormalizedEvent, { type: 'usage_update' }> => e.type === 'usage_update')
        if (!last?.usage || tokensOf(last.usage).inputTokens === 0) continue
        compared++
        expect(reading?.tokens, `${v}/${f}`).toEqual(tokensOf(last.usage))
      }
    }
    expect(compared).toBeGreaterThan(10)
  })
})

describe('tokens', () => {
  it('subagent: thinking tokens are part of the output, not on top of it (the total is input + output)', () => {
    const r = replay(path('agy-1.4.7', 'subagent'))
    expect(r.events.findLast((e) => e.type === 'usage_update')).toMatchObject({ tokens: { inputTokens: 21957, outputTokens: 381 } })
    expect(r.events.find((e) => e.type === 'usage_update')).toMatchObject({ request: { inputTokens: 6878, outputTokens: 211 } })
  })
})

describe('a plain turn and a tool call', () => {
  for (const v of VERSIONS) {
    if (!files(v).includes('tool.jsonl')) continue
    it(`${v}/tool: the call is announced at its step, ends ok, and the answer follows with the model call's usage`, () => {
      const r = replay(path(v, 'tool'))
      expect(digest(r.events)).toEqual([
        expect.stringMatching(/^usage 68\d\d\+0c\/\d+ request 68\d\d\/\d+$/),
        'call conv-1:2 Bash: echo gate-ok',
        'ok conv-1:2',
        'text conv-1:3 "gate-"',
        'text conv-1:3 "ok"',
        'text conv-1:3 "\\n"',
        expect.stringMatching(/^usage 13\d{3}\+0c\/\d+ request 69\d\d\/3$/),
      ])
      expect(r.ends).toEqual([{ how: 'complete' }])
      expect(r.externalIds).toEqual(['conv-1'])
      expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, output: 'Command exited with code 0.\n\nCommand output:\ngate-ok\r\n' })
    })
  }

  it('basic: the streamed text is one message, and a bare newline after it stays in it', () => {
    const r = replay(path('agy-1.4.7', 'basic'))
    const texts = r.events.filter((e) => e.type === 'message_delta')
    expect(texts.map((e) => e.messageId)).toEqual(['conv-1:1', 'conv-1:1'])
    expect(texts.map((e) => e.text).join('')).toBe('pineapple\n')
  })

  it('queued: the two inputs are two turns of one process, each ended by its own result', () => {
    const r = replay(path('agy-1.4.7', 'queued'))
    expect(r.ends).toEqual([{ how: 'complete' }, { how: 'complete' }])
    expect(r.events.filter((e) => e.type === 'message_delta').map((e) => e.messageId)).toEqual(['conv-1:1', 'conv-1:1', 'conv-1:3', 'conv-1:3'])
    expect(r.openAtExit).toEqual([false])
  })
})

describe('files touched', () => {
  it('edit: the file is marked once the write ended ok, not when it was announced', () => {
    const lines = digest(replay(path('agy-1.4.7', 'edit')).events)
    const at = lines.indexOf('call conv-1:2 Edit: <cwd>/notes.txt')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(lines.slice(at, at + 3)).toEqual(['call conv-1:2 Edit: <cwd>/notes.txt', 'ok conv-1:2', 'files <cwd>/notes.txt'])
  })

  it('a command a hook refused is a failed call and marks nothing', () => {
    for (const v of ['agy-1.4.7', 'agy-1.4.8']) {
      const r = replay(path(v, 'gate-deny'))
      expect(digest(r.events)).toContain('failed conv-1:2')
      expect(r.events.some((e) => e.type === 'files_touched')).toBe(false)
    }
  })
})

describe('the gate and the stream name a call the same way', () => {
  it('hook-empty runs the command, as the recording says (the gate prints something on every path)', () => {
    for (const v of ['agy-1.4.7', 'agy-1.4.8']) {
      expect(digest(replay(path(v, 'hook-empty')).events)).toContain('ok conv-1:2')
    }
  })

  it('subagent: the start ends its call at once; the child is seen only at the gate, never as a call of the stream', () => {
    const r = replay(path('agy-1.4.7', 'subagent'))
    const calls = r.events.filter((e) => e.type === 'tool_call')
    expect(calls.map((e) => [e.callId, e.summary.tool, e.summary.title])).toEqual([['conv-1:2', 'invoke_subagent', 'Command Runner']])
    const done = r.events.find((e) => e.type === 'tool_result')
    expect(done).toMatchObject({ callId: 'conv-1:2', ok: true })
    const output = done?.type === 'tool_result' ? (done.output ?? '') : ''
    expect(output).toContain('Command Runner')
    expect(output).toContain('echo from-child')
    // The child's run_command and send_message passed the gate with its own conversation id
    expect(r.childGates).toEqual(['conv-2:2', 'conv-2:4'])
    expect(r.events.some((e) => 'callId' in e && e.callId.startsWith('conv-2'))).toBe(false)
  })
})

describe('Stop', () => {
  it('interrupt: the partial answer is kept, the turn ends interrupted by us, and the next process resumes the conversation', () => {
    const r = replay(path('agy-1.4.7', 'interrupt'), { stopAfterInput: true })
    expect(r.ends).toEqual([{ how: 'interrupted', byUs: true }, { how: 'complete' }])
    expect(r.events.filter((e) => e.type === 'message_delta').map((e) => e.text)[0]).toBe('1\n2\n3\n4\n5\n6\n7\n8')
    // The second spawn's `--conversation conv-1` is checked against `launchArgs` by the replay (no problem)
    expect(r.problems).toEqual([])
    expect(r.externalIds).toEqual(['conv-1', 'conv-1'])
  })

  it('an interrupt the wire was not told of is the tool stopping the turn itself', () => {
    const r = replay(path('agy-1.4.7', 'interrupt'))
    expect(r.ends[0]).toEqual({ how: 'interrupted', byUs: false })
  })

  for (const [v, name] of [
    ['agy-1.4.7', 'interrupt-gate-held'],
    ['agy-1.4.8', 'interrupt-gate'],
  ] as const) {
    it(`${v}/${name}: the call a gate held ends failed with the turn`, () => {
      const r = replay(path(v, name), { stopAfterInput: true })
      expect(r.ends).toEqual([{ how: 'interrupted', byUs: true }])
      expect(digest(r.events)).toContain('failed conv-1:2')
    })
  }

  it('die: the process killed mid-turn leaves the turn open for the core, and the resumed one goes on from the same reading', () => {
    const r = replay(path('agy-1.4.7', 'die'))
    expect(r.openAtExit).toEqual([true, false])
    expect(r.ends).toEqual([{ how: 'complete' }, { how: 'complete' }])
    // The second process opens at the first one's total, not at nothing: the host keeps the last reading as it is
    expect(tokenTotals(r.events)).toEqual([6856, 13936])
  })
})

describe('the conversation to resume', () => {
  for (const v of ['agy-1.4.7', 'agy-1.4.8']) {
    it(`${v}/unknown-id: the warning stops the process and says the conversation is not there; nothing of its new one is the session's`, () => {
      const r = replay(path(v, 'unknown-id'))
      expect(r.stops).toBe(1)
      expect(r.notFound).toBe(1)
      expect(r.events).toEqual([])
      expect(r.ends).toEqual([])
      expect(r.externalIds).toEqual([])
    })
  }
})

describe('login', () => {
  it('logged out: the turn fails as "not logged in", not as an internal error', () => {
    const r = replay(path('agy-1.4.7', 'logged-out'))
    expect(r.ends).toHaveLength(1)
    expect(r.ends[0]).toMatchObject({ how: 'failed', error: { code: 'not_logged_in', retryable: false } })
  })
})
