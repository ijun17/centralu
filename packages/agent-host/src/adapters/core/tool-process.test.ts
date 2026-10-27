import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProcess } from '../contract.js'
import { frameRecorder } from '../frames/recorder.js'
import { CodexClient } from '../codex/client.js'
import { tapProcess } from './tool-process.js'

/** The frame tap (docs/plans/session-core.md §6.1): it records the lines a process is written and writes, and changes none */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-tap-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

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

const asProc = (p: FakeProc) => p as unknown as AgentProcess
type Entry = { dir: string; line?: string; msg?: { code: number | null; sig: string | null } }
const recorded = (sessionId: string): Entry[] =>
  readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith(`${sessionId}.`))!), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry)
const lines = (entries: Entry[]) => entries.filter((e) => e.dir !== 'exit').map((e) => `${e.dir}:${e.line}`)
const settle = () => new Promise((r) => setImmediate(r))

describe('the frame tap', () => {
  it('records every line both ways in the order they happened, and the exit', async () => {
    const proc = new FakeProc()
    tapProcess(asProc(proc), frameRecorder('s1', { CC_RECORD_FRAMES: dir }))
    const seen: string[] = []
    proc.stdout.on('data', (d: Buffer) => seen.push(String(d)))

    proc.stdin.write('{"id":1}\n')
    proc.stdout.write('{"id":1,"result":1}\n')
    proc.stdin.write('{"id":2}\n')
    proc.stdout.write('{"method":"n"}\n{"method":"m"}\n')
    await settle()
    proc.emit('exit', 3, null)

    const entries = recorded('s1')
    expect(lines(entries)).toEqual(['out:{"id":1}', 'in:{"id":1,"result":1}', 'out:{"id":2}', 'in:{"method":"n"}', 'in:{"method":"m"}'])
    expect(entries.at(-1)).toMatchObject({ dir: 'exit', msg: { code: 3, sig: null } })
    expect(seen.join('')).toBe('{"id":1,"result":1}\n{"method":"n"}\n{"method":"m"}\n')
  })

  it('does not drop, join or reorder a line that arrives in pieces, or a character split between chunks', async () => {
    const proc = new FakeProc()
    tapProcess(asProc(proc), frameRecorder('s2', { CC_RECORD_FRAMES: dir }))
    const bytes = Buffer.from('{"t":"한글 ✓"}\n')
    proc.stdout.write(bytes.subarray(0, 8)) // inside the first Korean character
    proc.stdout.write(bytes.subarray(8, 14))
    proc.stdout.write(bytes.subarray(14))
    proc.stdin.write('{"a":')
    proc.stdin.write('1}\n{"b":2}\n')
    await settle()

    const entries = lines(recorded('s2'))
    // The two directions are read on different ticks; each keeps its own order
    expect(entries.filter((l) => l.startsWith('out:'))).toEqual(['out:{"a":1}', 'out:{"b":2}'])
    expect(entries.filter((l) => l.startsWith('in:'))).toEqual(['in:{"t":"한글 ✓"}'])
  })

  it('leaves what the wire writes and reads as it was, with its callbacks and results', async () => {
    const proc = new FakeProc()
    const tapped = tapProcess(asProc(proc), frameRecorder('s3', { CC_RECORD_FRAMES: dir }))
    expect(tapped).toBe(asProc(proc))
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
    expect(lines(recorded('s3'))).toEqual(['out:{"x":1}', 'out:{"y":2}', 'out:{"z":3}', 'in:a', 'in: b'])
  })

  it('is not there when recording is off: the process and its stdin are untouched', () => {
    const proc = new FakeProc()
    const write = proc.stdin.write
    expect(tapProcess(asProc(proc), frameRecorder('s4', {}))).toBe(asProc(proc))
    expect(proc.stdin.write).toBe(write)
    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.listenerCount('exit')).toBe(0)
  })
})

describe('Codex records through the tap', () => {
  const saved = process.env.CC_RECORD_FRAMES
  afterEach(() => {
    if (saved === undefined) delete process.env.CC_RECORD_FRAMES
    else process.env.CC_RECORD_FRAMES = saved
  })

  it('writes the app-server’s lines both ways to the session’s file, with the client still answering', async () => {
    process.env.CC_RECORD_FRAMES = dir
    const proc = new FakeProc()
    const client = new CodexClient({ onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} }, { process: asProc(proc), sessionId: 'codex-s' })
    const answer = client.request('thread/start', { a: 1 })
    await settle()
    const sent = JSON.parse(Buffer.concat(proc.written).toString().trim()) as { id: string }
    proc.stdout.write(`${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`)
    await expect(answer).resolves.toEqual({ ok: true })
    proc.emit('exit', 0, null)

    const entries = recorded('codex-s')
    expect(lines(entries)).toEqual([`out:${JSON.stringify({ id: sent.id, method: 'thread/start', params: { a: 1 } })}`, `in:${JSON.stringify({ id: sent.id, result: { ok: true } })}`])
    expect(entries.at(-1)?.dir).toBe('exit')
  })
})
