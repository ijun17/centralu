import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FrameRecorder } from '../frames/recorder.js'
import { CodexClient } from '../codex/client.js'
import { tapProcess } from './tool-process.js'

/** The frame tap (docs/plans/session-core.md §6.1): it records the lines a process is written and writes, and changes none */

/** What the recorder was given, in order: `in:<line>`, `out:<line>` and `exit:<code>` */
const log: string[] = []
const recorder: FrameRecorder = {
  frame: (direction, line) => log.push(`${direction}:${line}`),
  exit: (code, signal) => log.push(`exit:${code ?? signal}`),
}
let sessions: string[] = []
vi.mock('../frames/recorder.js', () => ({
  frameRecorder: (sessionId: string) => {
    sessions.push(sessionId)
    return recorder
  },
}))
beforeEach(() => {
  log.length = 0
  sessions = []
})

class FakeProc extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killed = false
  kill = () => true
  /** What reached the process's end of stdin, byte for byte */
  readonly written: Buffer[] = []
  constructor() {
    super()
    this.stdin.on('data', (d: Buffer) => this.written.push(d))
  }
}

const settle = () => new Promise((r) => setImmediate(r))
const direction = (prefix: string) => log.filter((l) => l.startsWith(prefix))

describe('the frame tap', () => {
  it('records every line both ways in the order they happened, and the exit', async () => {
    const proc = new FakeProc()
    tapProcess(proc, recorder)
    const seen: string[] = []
    proc.stdout.on('data', (d: Buffer) => seen.push(String(d)))

    proc.stdin.write('{"id":1}\n')
    proc.stdout.write('{"id":1,"result":1}\n')
    await settle()
    proc.stdin.write('{"id":2}\n')
    proc.stdout.write('{"method":"n"}\n{"method":"m"}\n')
    await settle()
    proc.emit('exit', 3, null)

    expect(log).toEqual(['out:{"id":1}', 'in:{"id":1,"result":1}', 'out:{"id":2}', 'in:{"method":"n"}', 'in:{"method":"m"}', 'exit:3'])
    expect(seen.join('')).toBe('{"id":1,"result":1}\n{"method":"n"}\n{"method":"m"}\n')
  })

  it('does not drop, join or reorder a line that arrives in pieces, or a character split between chunks', async () => {
    const proc = new FakeProc()
    tapProcess(proc, recorder)
    const bytes = Buffer.from('{"t":"한글 ✓"}\n')
    proc.stdout.write(bytes.subarray(0, 8)) // inside the first Korean character
    proc.stdout.write(bytes.subarray(8, 14))
    proc.stdout.write(bytes.subarray(14))
    proc.stdin.write('{"a":')
    proc.stdin.write('1}\n{"b":2}\n')
    await settle()

    expect(direction('out:')).toEqual(['out:{"a":1}', 'out:{"b":2}'])
    expect(direction('in:')).toEqual(['in:{"t":"한글 ✓"}'])
  })

  it('leaves what the wire writes and reads as it was, with its callbacks and results', async () => {
    const proc = new FakeProc()
    expect(tapProcess(proc, recorder)).toBe(proc)
    const got: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => got.push(d))
    let called = 0
    for (const chunk of ['{"x":1}\n', Buffer.from('\n{"y":2}\n'), '{"z":3}\n']) expect(proc.stdin.write(chunk, () => called++)).toBe(true)
    proc.stdout.write(Buffer.from('a\r\n\n b\n'))
    await settle()

    expect(Buffer.concat(proc.written).toString()).toBe('{"x":1}\n\n{"y":2}\n{"z":3}\n')
    expect(called).toBe(3)
    expect(Buffer.concat(got).toString()).toBe('a\r\n\n b\n')
    // A blank line is not a frame
    expect(direction('out:')).toEqual(['out:{"x":1}', 'out:{"y":2}', 'out:{"z":3}'])
    expect(direction('in:')).toEqual(['in:a', 'in: b'])
  })

  it('is not there when recording is off: the process and its stdin are untouched', () => {
    const proc = new FakeProc()
    const write = proc.stdin.write
    expect(tapProcess(proc, undefined)).toBe(proc)
    expect(proc.stdin.write).toBe(write)
    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.listenerCount('exit')).toBe(0)
  })
})

describe('Codex records through the tap', () => {
  it('records the app-server’s lines both ways under the session, with the client still answering', async () => {
    const proc = new FakeProc()
    const client = new CodexClient({ onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} }, { process: proc, sessionId: 'codex-s' })
    const answer = client.request('thread/start', { a: 1 })
    await settle()
    const sent = JSON.parse(Buffer.concat(proc.written).toString().trim())
    proc.stdout.write(`${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`)
    await expect(answer).resolves.toEqual({ ok: true })
    proc.emit('exit', 0, null)

    expect(sessions).toEqual(['codex-s'])
    expect(log).toEqual([`out:${JSON.stringify({ id: sent.id, method: 'thread/start', params: { a: 1 } })}`, `in:${JSON.stringify({ id: sent.id, result: { ok: true } })}`, 'exit:0'])
  })

  it('records nothing for a client that serves no session', () => {
    new CodexClient({ onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} }, { process: new FakeProc() })
    expect(sessions).toEqual([])
  })
})
