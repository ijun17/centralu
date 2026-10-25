import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'

/**
 * Plays a recording (docs/plans/acp-adapter.md §10.2) into the adapter as the agent: each frame the adapter writes is
 * matched against the next recorded outgoing one (same method; an answer to the agent's request with the same result),
 * then the recorded incoming frames up to the next outgoing one are written back, with the ids of answers rewritten to
 * the adapter's own. A recording holds every process a scenario started, one after another, each ended by its `exit`.
 * Nothing waits on a clock: a frame goes out when the adapter has sent what precedes it.
 */

type Rec = { t: number; dir: 'in' | 'out' | 'exit'; msg?: Record<string, unknown>; code?: number | null; signal?: string | null }

export type Recording = { header: Record<string, unknown>; frames: Rec[] }

export function loadRecording(path: string): Recording {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const [head, ...frames] = lines
  return { header: (head?.header ?? {}) as Record<string, unknown>, frames: frames as Rec[] }
}

/** What went wrong in a replay; a test asserts it stays empty and that every frame was used */
export type ReplayState = { problems: string[]; left(): number; spawned: number }

export function replaySpawner(recording: Recording): { spawn: (spec: AgentSpawnSpec) => AgentProcess; state: ReplayState; peers: ReplayPeer[] } {
  let cursor = 0
  const frames = recording.frames
  const peers: ReplayPeer[] = []
  const state: ReplayState = { problems: [], left: () => frames.length - cursor, spawned: 0 }
  const take = (): Rec[] => {
    const end = frames.findIndex((f, i) => i >= cursor && f.dir === 'exit')
    const stop = end < 0 ? frames.length : end + 1
    const segment = frames.slice(cursor, stop)
    cursor = stop
    return segment
  }
  return {
    spawn: () => {
      state.spawned++
      const peer = new ReplayPeer(take(), state.problems)
      peers.push(peer)
      return peer
    },
    state: {
      get problems() {
        return state.problems
      },
      left: () => frames.length - cursor + peers.reduce((n, p) => n + p.left(), 0),
      get spawned() {
        return state.spawned
      },
    },
    peers,
  }
}

export class ReplayPeer extends EventEmitter implements AgentProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  private i = 0
  private readonly ids = new Map<string, string | number>()
  private buffer = ''
  private ended = false

  constructor(
    private readonly frames: Rec[],
    private readonly problems: string[],
  ) {
    super()
    this.stdin.on('data', (d: Buffer) => {
      this.buffer += String(d)
      let n
      while ((n = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, n)
        this.buffer = this.buffer.slice(n + 1)
        if (line.trim()) this.received(JSON.parse(line) as Record<string, unknown>)
      }
    })
    this.stdin.on('finish', () => this.finish(0, null))
    setImmediate(() => this.pump())
  }

  left(): number {
    return this.frames.length - this.i
  }

  private received(msg: Record<string, unknown>): void {
    const expected = this.frames[this.i]
    if (!expected || expected.dir !== 'out' || !expected.msg) {
      this.problems.push(`the adapter sent ${describe(msg)} where the recording has ${expected ? describeRec(expected) : 'nothing more'}`)
      return
    }
    const want = expected.msg
    if (typeof want.method === 'string') {
      if (msg.method !== want.method) {
        this.problems.push(`the adapter sent ${describe(msg)} where the recording sends ${describe(want)}`)
        return
      }
      if (want.id !== undefined) this.ids.set(String(want.id), msg.id as string | number)
    } else if (String(msg.id) !== String(want.id) || !isDeepStrictEqual(msg.result ?? null, want.result ?? null)) {
      this.problems.push(`the adapter answered ${JSON.stringify(msg)} where the recording answers ${JSON.stringify(want)}`)
      return
    }
    this.i++
    this.pump()
  }

  private pump(): void {
    while (this.i < this.frames.length && !this.ended) {
      const f = this.frames[this.i]!
      if (f.dir === 'out') return
      this.i++
      if (f.dir === 'exit') {
        this.finish(f.code ?? null, (f.signal as NodeJS.Signals | null) ?? null)
        return
      }
      const msg = { ...f.msg }
      if (msg.id !== undefined && msg.method === undefined) msg.id = this.ids.get(String(msg.id)) ?? msg.id
      this.stdout.write(`${JSON.stringify(msg)}\n`)
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return
    this.ended = true
    // The recorded frames of this process that the adapter never reached are dropped with it
    if (this.frames[this.i]?.dir === 'exit') this.i++
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    setImmediate(() => this.emit('exit', code, signal))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.finish(null, signal)
    return true
  }
}

const describe = (m: Record<string, unknown>) => (typeof m.method === 'string' ? `${m.method}` : `an answer to ${String(m.id)}`)
const describeRec = (r: Rec) => (r.dir === 'exit' ? 'the process ending' : r.msg ? `${r.dir === 'in' ? 'incoming' : 'outgoing'} ${describe(r.msg)}` : r.dir)
