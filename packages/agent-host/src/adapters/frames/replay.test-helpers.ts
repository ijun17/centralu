import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'

/**
 * Plays a recording (docs/plans/acp-adapter.md §10.2) into an adapter as its tool: each line the adapter writes is
 * matched against the next recorded outgoing one, then the recorded incoming lines up to the next outgoing one are
 * written back. What "the same frame" means is the protocol's (`FrameCodec`): JSON-RPC (ACP) matches by method and
 * rewrites answer ids; a stream-json CLI's lines match by their `type`. Tool-neutral, like the recorder. A recording holds every process a scenario started, one after another, each ended by its `exit`.
 * Nothing waits on a clock: a frame goes out when the adapter has sent what precedes it.
 */

/**
 * One recorded line. `in`, `out` and `exit` are what `ReplayPeer` plays; a CLI recorded at its three pipes (`agy`) also holds `err` (a stderr
 * line), `gate` (a hook request and the answer), `spawn` (the arguments a process started with) and `note` (what the recorder did), which only a
 * test that reads the recording itself looks at
 */
export type Rec = { t: number; dir: 'in' | 'out' | 'exit' | 'err' | 'gate' | 'spawn' | 'note'; msg?: Record<string, unknown>; code?: number | null; signal?: string | null; text?: string; args?: string[] }

export type Recording = { header: Record<string, unknown>; frames: Rec[] }

export function loadRecording(path: string): Recording {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const [head, ...frames] = lines
  return { header: (head?.header ?? {}) as Record<string, unknown>, frames: frames as Rec[] }
}

/** What went wrong in a replay; a test asserts it stays empty and that every frame was used */
export type ReplayState = { problems: string[]; left(): number; spawned: number }

const idOf = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

/** What "the same frame" means for one protocol */
export type FrameCodec = {
  /** Null when `sent` is the recorded outgoing frame, else why not; `ids` maps recorded ids to the adapter's own */
  match(sent: Record<string, unknown>, recorded: Record<string, unknown>, ids: Map<string, string | number>): string | null
  /** A recorded incoming frame as it is written to the adapter */
  rewrite(incoming: Record<string, unknown>, ids: Map<string, string | number>): Record<string, unknown>
}

/** JSON-RPC 2.0 (ACP): a request or notification by its method, an answer to the tool's request by its id and result */
export const jsonRpcCodec: FrameCodec = {
  match(sent, want, ids) {
    if (typeof want.method === 'string') {
      if (sent.method !== want.method) return `the adapter sent ${describe(sent)} where the recording sends ${describe(want)}`
      if (want.id !== undefined && (typeof sent.id === 'string' || typeof sent.id === 'number')) ids.set(idOf(want.id), sent.id)
      return null
    }
    if (idOf(sent.id) !== idOf(want.id) || !isDeepStrictEqual(sent.result ?? null, want.result ?? null)) {
      return `the adapter answered ${JSON.stringify(sent)} where the recording answers ${JSON.stringify(want)}`
    }
    return null
  },
  rewrite(incoming, ids) {
    const msg = { ...incoming }
    if (msg.id !== undefined && msg.method === undefined) msg.id = ids.get(idOf(msg.id)) ?? msg.id
    return msg
  },
}

/** JSON lines with a `type` (a stream-json CLI): the same type, the rest as the tool chose */
export const jsonLinesCodec: FrameCodec = {
  match: (sent, want) => (sent.type === want.type ? null : `the adapter sent ${String(sent.type)} where the recording sends ${String(want.type)}`),
  rewrite: (incoming) => incoming,
}

export function replaySpawner(recording: Recording, codec: FrameCodec = jsonRpcCodec): { spawn: (spec: AgentSpawnSpec) => AgentProcess; state: ReplayState; peers: ReplayPeer[] } {
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
      const peer = new ReplayPeer(take(), state.problems, codec)
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
    private readonly codec: FrameCodec = jsonRpcCodec,
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
    const problem = this.codec.match(msg, expected.msg, this.ids)
    if (problem) {
      this.problems.push(problem)
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
      const msg = this.codec.rewrite(f.msg ?? {}, this.ids)
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
