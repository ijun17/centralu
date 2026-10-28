import { describe, expect, it } from 'vitest'
import { AcpNormalizer } from './normalize.js'
import type { SessionUpdate } from './wire.js'

const frame = (u: Record<string, unknown>) => u as unknown as SessionUpdate

describe('a call’s result', () => {
  it('reads the exit code the call reported before its end, though its last update carries none (#1562 review)', () => {
    const n = new AcpNormalizer('s')
    n.update(frame({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Run', kind: 'execute', status: 'pending', rawInput: { command: 'false' } }))
    n.update(frame({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress', rawOutput: { exitCode: 1, stdout: '', stderr: 'no' } }))
    const end = n.update(frame({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' }))
    expect(end).toEqual([expect.objectContaining({ type: 'tool_result', callId: 'c', ok: false })])
  })
})

describe('a call that ends with no output returned', () => {
  it('says the tool did not return the output, not that the command printed none (#1562 Mac re-check: 60 KB of output arrived as "")', async () => {
    const { fileURLToPath } = await import('node:url')
    const { loadRecording } = await import('../frames/replay.test-helpers.js')
    const recording = loadRecording(fileURLToPath(new URL('./recordings/cursor-agent-2026.10.22/big-output.jsonl', import.meta.url)))
    const n = new AcpNormalizer('s', 'Cursor')
    const results = recording.frames.flatMap((f) => {
      const msg = f.msg as { method?: string; params?: { update?: SessionUpdate } } | undefined
      return f.dir === 'in' && msg?.method === 'session/update' && msg.params?.update ? n.update(msg.params.update) : []
    })
    const result = results.find((e) => e.type === 'tool_result')
    expect(result).toMatchObject({ type: 'tool_result', ok: true, summary: '(Cursor did not return the output)' })
  })
})

/**
 * The text OpenCode 1.19.4 stored and streamed for its free model `big-pickle` (read in its own store and in
 * Centralu's, `smoke:opencode`, 2026-10-25): the model put its reasoning in the reply and closed it with `</think>`,
 * with no `<think>`, in each step of the first turn of a new session. The chunk boundaries are this test's own.
 */
const LEAKED: Array<[string, string]> = [
  ['msg-1', 'The user wants me to remember a code word, run a command, then say done. Simple.</th'],
  ['msg-1', 'ink>'],
  ['msg-2', '</think>'],
  ['msg-2', '\n\nCode word noted. Done.'],
  ['msg-3', '</think>heron'],
]

describe('a message’s text', () => {
  const said = (n: AcpNormalizer, chunks: Array<[string, string]>) =>
    chunks.flatMap(([messageId, text]) => n.update(frame({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }))).concat(n.endTurn())
  const text = (events: ReturnType<AcpNormalizer['endTurn']>, id: string) => events.filter((e) => e.type === 'message_delta' && e.messageId === id).map((e) => (e.type === 'message_delta' ? e.text : '')).join('')

  it('drops the `</think>` a model leaves where it put its reasoning in the reply, a tag split over chunks too', () => {
    const events = said(new AcpNormalizer('s'), LEAKED)
    expect(text(events, 'msg-1')).toBe('The user wants me to remember a code word, run a command, then say done. Simple.')
    expect(text(events, 'msg-2')).toBe('Code word noted. Done.')
    expect(text(events, 'msg-3')).toBe('heron')
  })

  it('keeps a tag the reply opened, a later one, and a text that only looked like the start of one', () => {
    const events = said(new AcpNormalizer('s'), [
      ['a', 'Write <think>x</think> to mark it.'],
      ['b', '</think>Use </think> to close.'],
      ['c', 'a </t'],
      ['c', 'able>'],
      ['d', 'ends with <'],
    ])
    expect(text(events, 'a')).toBe('Write <think>x</think> to mark it.')
    expect(text(events, 'b')).toBe('Use </think> to close.')
    expect(text(events, 'c')).toBe('a </table>')
    expect(text(events, 'd')).toBe('ends with <')
  })

  it('says a message’s held text before the next message’s (second review of PR 3)', () => {
    const events = said(new AcpNormalizer('s'), [['a', 'x </th'], ['b', 'next']])
    expect(events.map((e) => (e.type === 'message_delta' ? `${e.messageId}:${e.text}` : e.type))).toEqual(['a:x ', 'a:</th', 'b:next'])
  })
})

describe('files an edit marks', () => {
  const edit = (n: AcpNormalizer) =>
    n.update(frame({ sessionUpdate: 'tool_call', toolCallId: 'e', title: 'Edit a.txt', kind: 'edit', status: 'pending', rawInput: { path: '/w/a.txt' }, locations: [{ path: '/w/a.txt' }] }))

  it('marks them when the edit ends ok, not when it is announced (#843, as Claude and Codex)', () => {
    const n = new AcpNormalizer('s')
    expect(edit(n).map((e) => e.type)).toEqual(['tool_call'])
    const end = n.update(frame({ sessionUpdate: 'tool_call_update', toolCallId: 'e', status: 'completed' }))
    expect(end.map((e) => e.type)).toEqual(['tool_result', 'files_touched'])
    expect(end[1]).toMatchObject({ paths: ['/w/a.txt'] })
  })

  it('marks nothing for an edit the person refused', () => {
    const n = new AcpNormalizer('s')
    const start = edit(n)
    n.refuse('e')
    const end = [...start, ...n.update(frame({ sessionUpdate: 'tool_call_update', toolCallId: 'e', status: 'completed' }))]
    expect(end.map((e) => e.type)).toEqual(['tool_call', 'tool_result'])
  })

  it('marks nothing for an edit that failed', () => {
    const n = new AcpNormalizer('s')
    const end = [...edit(n), ...n.update(frame({ sessionUpdate: 'tool_call_update', toolCallId: 'e', status: 'failed' }))]
    expect(end.map((e) => e.type)).toEqual(['tool_call', 'tool_result'])
  })
})
