import { describe, expect, it } from 'vitest'
import { differs, firstDifference, replaySpawner, streamJsonCodec, type OwnAnswers, type Recording } from './replay.test-helpers.js'

/**
 * How a replay reports that the adapter sent what the recording does not have (#2068): at once, naming the recording, its line
 * and the JSON path that differs, not as a step that waits out its timeout; and what Centralu writes itself is checked against
 * the code, not the recording. The replays of each tool use these; this checks them on lines made for it.
 */

describe('where two lines differ', () => {
  it('names the JSON path, down through objects and arrays', () => {
    expect(firstDifference({ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'y' }] } })).toEqual({ path: 'a.b[1].c', want: 'x', sent: 'y' })
    expect(firstDifference({ a: 1 }, { a: 1, extra: true })).toEqual({ path: 'extra', want: undefined, sent: true })
    expect(firstDifference([1, 2], [1])).toEqual({ path: '[1]', want: 2, sent: undefined })
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull()
  })

  it('says both values, and what the line is compared with', () => {
    expect(differs('the message', { text: 'b' }, { text: 'a' })).toBe('the message: first difference at text: the recording has "a", the adapter sent "b"')
    expect(differs('the tools', [], [{ name: 't' }], 'the code')).toBe('the tools: first difference at [0]: the code has {"name":"t"}, the adapter sent nothing')
  })
})

const recording = (frames: Recording['frames']): Recording => ({ name: 'tool-1/scenario.jsonl', header: {}, frames })

describe('a replay that sees a mismatch', () => {
  it('fails at once with where it is, and goes on to nothing', async () => {
    const { spawn, state } = replaySpawner(
      recording([
        { t: 0, dir: 'out', msg: { type: 'user', message: { role: 'user', content: 'hello' } }, line: 2 },
        { t: 1, dir: 'in', msg: { type: 'result' }, line: 3 },
      ]),
      streamJsonCodec('/work'),
    )
    const peer = spawn({ command: 'tool', args: [], env: {} })
    peer.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'goodbye' } })}\n`)
    await expect(state.failed).rejects.toThrow('tool-1/scenario.jsonl line 2: the message: first difference at content: the recording has "hello", the adapter sent "goodbye"')
    expect(state.problems).toHaveLength(1)
    expect(state.waitingFor()).toBe('outgoing user')
  })
})

describe('the answers Centralu writes itself', () => {
  const asks = (id: string, method: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: 'centralu', message: { method } } })
  const answer = (id: string, result: unknown) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { mcp_response: { jsonrpc: '2.0', id: 1, result } } } })
  const own: OwnAnswers = { server: 'centralu', check: (method, result) => (JSON.stringify(result) === JSON.stringify({ tools: ['now'] }) ? null : `${method} is not what the code makes`) }

  /** The codec asked for the CLI's request, then shown the adapter's answer to it against a recorded one */
  const compare = (sent: unknown, recorded: unknown) => {
    const codec = streamJsonCodec('/work', own)
    const ids = new Map<string, string | number>()
    codec.rewrite(asks('rid-4', 'tools/list'), ids)
    return codec.match(sent as Record<string, unknown>, recorded as Record<string, unknown>, ids)
  }

  it('are compared with the code, whatever the recording holds', () => {
    expect(compare(answer('rid-4', { tools: ['now'] }), answer('rid-4', { tools: ['long ago'] }))).toBeNull()
    expect(compare(answer('rid-4', { tools: ['now'] }), answer('rid-4', 'nothing like a list'))).toBeNull()
  })

  it('fail when the code does not make them, and when the rest of the line is not the recorded one', () => {
    expect(compare(answer('rid-4', { tools: ['other'] }), answer('rid-4', { tools: ['now'] }))).toBe('the adapter’s answer to tools/list: tools/list is not what the code makes')
    expect(compare(answer('rid-4', { tools: ['now'] }), { ...answer('rid-4', {}), response: { ...answer('rid-4', {}).response, subtype: 'error' } })).toMatch(/first difference at subtype: the recording has "error", the adapter sent "success"/)
  })

  it('leave the answers to the CLI’s other requests compared with the recording', () => {
    const codec = streamJsonCodec('/work', own)
    const ids = new Map<string, string | number>()
    codec.rewrite(asks('rid-7', 'tools/call'), ids)
    expect(codec.match(answer('rid-7', { content: 'b' }) as never, answer('rid-7', { content: 'a' }) as never, ids)).toMatch(/first difference at response\.mcp_response\.result\.content: the recording has "a", the adapter sent "b"/)
  })
})
