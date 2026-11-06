import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type { NormalizedEvent } from '@cc/protocol'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'

/**
 * Plays a recording (docs/plans/acp-adapter.md §10.2) into an adapter as its tool: each line the adapter writes is
 * matched against the next recorded outgoing one, then the recorded incoming lines up to the next outgoing one are
 * written back. What "the same frame" means is the protocol's (`FrameCodec`): JSON-RPC (ACP) matches by method and
 * rewrites answer ids; a stream-json CLI's lines match by their `type`. Tool-neutral, like the recorder. A recording holds every process a scenario started, one after another, each ended by its `exit`.
 * Nothing waits on a clock: a frame goes out when the adapter has sent what precedes it.
 */

type Rec = { t: number; dir: 'in' | 'out' | 'exit'; msg?: Record<string, unknown>; code?: number | null; signal?: string | null }

export type Recording = { header: Record<string, unknown>; frames: Rec[] }

export function loadRecording(path: string): Recording {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const [head, ...frames] = lines
  return { header: (head?.header ?? {}) as Record<string, unknown>, frames: frames as Rec[] }
}

/** The recordings under `root`: one folder per tool version, with the scenarios recorded in it and each one's file */
export function recordedFolders(root: string): { dir: string; names: string[]; file(name: string): string }[] {
  return readdirSync(root).map((dir) => ({
    dir,
    names: readdirSync(join(root, dir)).map((f) => f.replace(/\.jsonl$/, '')),
    file: (name) => join(root, dir, `${name}.jsonl`),
  }))
}

/** The folder of the newest tool version under `root`, of those that hold `scenario` if one is named: a re-recording on a version bump replaces the old one */
export function newestVersion(root: string, scenario?: string): string {
  const numbers = (dir: string) => dir.replace(/^[a-z-]+-/, '').split('.').map(Number)
  const newer = (a: string, b: string) => numbers(a).reduce((order, n, i) => order || n - (numbers(b)[i] ?? 0), 0)
  return recordedFolders(root)
    .filter((f) => scenario === undefined || f.names.includes(scenario))
    .map((f) => f.dir)
    .sort(newer)
    .at(-1)!
}

/** A new folder for a replay to run in, and the way to take it away */
export function temporaryFolder(prefix: string): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
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
  /**
   * Whether the lines the adapter sends with nothing from the tool between them may come in another order than recorded.
   * They are sent from separate asynchronous paths (an answer to the tool's request, a context query, a Stop), so their
   * order differs between runs; what a line is answered with does not depend on it
   */
  readonly unordered?: (sent: Record<string, unknown>) => boolean
  /**
   * A query the adapter makes when it likes, not because the tool said something (Claude: a context reading, sent when
   * the previous one has been answered, so how many go out and where depends on timing). Neither it nor its answer is
   * played from the recording: the adapter is answered with the recording's first answer to one
   */
  readonly probe?: {
    is(line: Record<string, unknown>): boolean
    /** Whether `line` answers one of the recorded probes `asked` (by their ids) */
    answers(line: Record<string, unknown>, asked: Set<string>): boolean
    requestId(line: Record<string, unknown>): string
    /** The answer to `asked`, made from a recorded one */
    answer(asked: Record<string, unknown>, recorded: Record<string, unknown>): Record<string, unknown>
  }
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

/**
 * Codex's app-server: JSON-RPC as ACP's, with the recorded `<cwd>` read as the folder the replay runs in (a path in an
 * answer, a file change, a command's output). `cwd`: that folder. `ignoreParams`: parameters of a request that are not compared, for a
 * a thread's `thread/start` or `thread/resume`, for a recording whose values are not the replay's (the bridge's address and credential in
 * `config`, the tools' instructions in `developerInstructions`: words that change with the build); a test asserts what it needs of them
 */
export const codexCodec = (cwd: string, opts: { ignoreParams?: readonly string[] } = {}): FrameCodec => {
  /** The id a run makes up for an input (`clientUserMessageId`), which the app-server says back on the input's item */
  const ownId = (params: unknown): string | undefined => {
    const id = (params as { clientUserMessageId?: unknown } | undefined)?.clientUserMessageId
    return typeof id === 'string' ? id : undefined
  }
  // The ignored parameters are a thread's own (`thread/start`, `thread/resume`): the same name in another request is compared
  const withoutOwnId = (params: unknown, method: string): unknown =>
    params && typeof params === 'object'
      ? Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'clientUserMessageId' && !(opts.ignoreParams?.includes(k) && (method === 'thread/start' || method === 'thread/resume'))))
      : params
  return {
    match(sent, want, ids) {
      const recorded = inFolder(want, cwd)
      const problem = jsonRpcCodec.match(sent, recorded, ids)
      if (problem || typeof recorded.method !== 'string') return problem
      // A request is also the same by what it asks for (the launch policy, the text, the model), not by its method alone
      if (!isDeepStrictEqual(withoutOwnId(sent.params ?? null, recorded.method), withoutOwnId(recorded.params ?? null, recorded.method))) {
        return `the adapter sent ${recorded.method} with ${JSON.stringify(sent.params)} where the recording sends ${JSON.stringify(recorded.params)}`
      }
      const mine = ownId(sent.params)
      const theirs = ownId(recorded.params)
      if (mine && theirs) ids.set(theirs, mine)
      else if (mine || theirs) return `the adapter sent ${recorded.method} ${mine ? 'with' : 'without'} an input id where the recording ${mine ? 'has none' : 'has one'}`
      return null
    },
    rewrite(incoming, ids) {
      const swap = (v: unknown): unknown => {
        if (typeof v === 'string') return ids.get(v) ?? v
        if (Array.isArray(v)) return v.map(swap)
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]))
        return v
      }
      return inFolder(swap(jsonRpcCodec.rewrite(incoming, ids)), cwd) as Record<string, unknown>
    },
  }
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/**
 * Claude Code's stream-json (what the SDK speaks to the CLI): a line matches by its `type`, and further by what it asks or
 * answers: a control request by its `subtype`, the answer to the CLI's request (an approval, a hook) by its request id and
 * its verdict, a user message by its content. The ids the SDK and the adapter make up for themselves (a request id, an
 * input's uuid) differ per run, so each is mapped to the recorded one and the CLI's later references to it are rewritten.
 * `cwd`: the folder the session runs in, which the recording's `<cwd>` stands for. `hostAnswers`: the recording was made through a
 * real host, whose tools answered the CLI's calls to Centralu's server (`mcp_message`); the replay has no host, so what those
 * answers hold (the tools' list and descriptions, their words) is not compared, only that the adapter answers.
 */
export const streamJsonCodec = (cwd: string, opts: { hostAnswers?: boolean } = {}): FrameCodec => ({
  // Two inputs of the person are in the order they were sent; the lines around them are not
  unordered: (line) => line.type !== 'user',
  probe: {
    is: (line) => line.type === 'control_request' && record(line.request).subtype === 'get_context_usage',
    answers: (line, asked) => line.type === 'control_response' && asked.has(String(record(line.response).request_id)),
    requestId: (line) => String(line.request_id),
    answer: (asked, recorded) => ({ ...recorded, response: { ...record(recorded.response), request_id: asked.request_id } }),
  },
  match(sent, want, ids) {
    if (sent.type !== want.type) return `the adapter sent ${describeLine(sent)} where the recording sends ${describeLine(want)}`
    if (want.type === 'control_request') {
      if (!isDeepStrictEqual(sent.request, inFolder(want.request, cwd))) return `the adapter sent ${JSON.stringify(sent.request)} where the recording sends ${JSON.stringify(inFolder(want.request, cwd))}`
      if (typeof want.request_id === 'string' && typeof sent.request_id === 'string') ids.set(want.request_id, sent.request_id)
    } else if (want.type === 'control_response') {
      if (opts.hostAnswers && record(record(want.response).response).mcp_response !== undefined) {
        return record(record(sent.response).response).mcp_response === undefined ? `the adapter answered ${JSON.stringify(sent)} where the recording answers a call to Centralu's server` : null
      }
      if (!isDeepStrictEqual(sent.response, inFolder(want.response, cwd))) return `the adapter answered ${JSON.stringify(sent)} where the recording answers ${JSON.stringify(want)}`
    } else if (want.type === 'user') {
      if (!isDeepStrictEqual(sent.message, want.message)) return `the adapter sent the message ${JSON.stringify(sent.message)} where the recording sends ${JSON.stringify(want.message)}`
      if (typeof want.uuid === 'string' && typeof sent.uuid === 'string') ids.set(want.uuid, sent.uuid)
    }
    return null
  },
  rewrite(incoming, ids) {
    const swap = (v: unknown): unknown => {
      if (typeof v === 'string') return ids.get(v) ?? inFolder(v, cwd)
      if (Array.isArray(v)) return v.map(swap)
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]))
      return v
    }
    return swap(incoming) as Record<string, unknown>
  },
})

/** A recorded value as it reads in the folder the replay runs in: its `<cwd>` is that folder */
export function inFolder<T>(v: T, cwd: string): T {
  if (typeof v === 'string') return v.split('<cwd>').join(cwd) as T
  if (Array.isArray(v)) return v.map((x) => inFolder(x, cwd)) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inFolder(x, cwd)])) as T
  return v
}

/** What is wrong with the calls' order: a result before its call, a call announced twice, a call with no result or two */
export function callOrder(events: readonly NormalizedEvent[]): string[] {
  const wrong: string[] = []
  const called = new Set<string>()
  const results = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'tool_call') {
      if (called.has(e.callId)) wrong.push(`${e.callId}: announced twice`)
      called.add(e.callId)
    }
    if (e.type !== 'tool_result') continue
    if (!called.has(e.callId)) wrong.push(`${e.callId}: a result before its call`)
    results.set(e.callId, (results.get(e.callId) ?? 0) + 1)
  }
  for (const id of called) if (results.get(id) !== 1) wrong.push(`${id}: ${results.get(id) ?? 0} results`)
  return wrong
}

/** The events of one type, typed */
export const of = <T extends NormalizedEvent['type']>(events: readonly NormalizedEvent[], type: T) => events.filter((e): e is Extract<NormalizedEvent, { type: T }> => e.type === type)

const describeLine = (m: Record<string, unknown>): string => {
  const subtype = record(m.request).subtype ?? m.subtype
  return typeof subtype === 'string' ? `${String(m.type)} ${subtype}` : String(m.type)
}

/** `onProblem`: told of each problem as it happens, for a host that no test is waiting on to read `state.problems` after */
export function replaySpawner(recording: Recording, codec: FrameCodec = jsonRpcCodec, onProblem?: (problem: string) => void): { spawn: (spec: AgentSpawnSpec) => AgentProcess; state: ReplayState; peers: ReplayPeer[] } {
  let cursor = 0
  const frames = recording.frames
  const peers: ReplayPeer[] = []
  const state: ReplayState = { problems: [], left: () => frames.length - cursor, spawned: 0 }
  if (onProblem) {
    const push = state.problems.push.bind(state.problems)
    state.problems.push = (...found) => (found.forEach(onProblem), push(...found))
  }
  const probe = codec.probe
  const asked = new Set(probe ? frames.flatMap((f) => (f.dir === 'out' && f.msg && probe.is(f.msg) ? [probe.requestId(f.msg)] : [])) : [])
  const answer = probe ? frames.find((f) => f.dir === 'in' && f.msg && probe.answers(f.msg, asked))?.msg : undefined
  const take = (): Rec[] => {
    const end = frames.findIndex((f, i) => i >= cursor && f.dir === 'exit')
    const stop = end < 0 ? frames.length : end + 1
    const segment = frames.slice(cursor, stop)
    cursor = stop
    return probe ? segment.filter((f) => !f.msg || (f.dir === 'out' ? !probe.is(f.msg) : !probe.answers(f.msg, asked))) : segment
  }
  return {
    spawn: () => {
      state.spawned++
      const peer = new ReplayPeer(take(), state.problems, codec, answer)
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
  /** The methods of the lines the adapter has sent, in order (an answer to the tool's request is `answer`): what a test asserts the adapter did */
  readonly sent: string[] = []
  /** The lines themselves, as the adapter wrote them */
  readonly lines: Record<string, unknown>[] = []
  /** Told of each mismatch as it happens, so a test can fail with it instead of waiting out a stalled step */
  onProblem: ((problem: string) => void) | undefined
  private readonly ids = new Map<string, string | number>()
  private buffer = ''
  private ended = false

  constructor(
    private readonly frames: Rec[],
    private readonly problems: string[],
    private readonly codec: FrameCodec = jsonRpcCodec,
    /** A recorded answer to a probe, for the ones the adapter makes (`FrameCodec.probe`) */
    private readonly probeAnswer?: Record<string, unknown>,
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

  /** What the replay waits for next, for a failure message */
  waitingFor(): string {
    const next = this.frames[this.i]
    return next ? describeRec(next) : 'nothing more'
  }

  private received(msg: Record<string, unknown>): void {
    if (this.codec.probe?.is(msg)) {
      // A recording that holds no answer to one (the tool ended first) leaves the adapter's query unanswered, as the tool did
      if (this.probeAnswer) this.say(`${JSON.stringify(this.codec.probe.answer(msg, this.probeAnswer))}\n`)
      return
    }
    this.sent.push(typeof msg.method === 'string' ? msg.method : 'answer')
    this.lines.push(msg)
    const expected = this.frames[this.i]
    if (!expected || expected.dir !== 'out' || !expected.msg) {
      this.problem(`the adapter sent ${describe(msg)} where the recording has ${expected ? describeRec(expected) : 'nothing more'}`)
      return
    }
    let problem = this.codec.match(msg, expected.msg, this.ids)
    // The run of lines recorded with nothing from the tool between them: the line may be any of them
    for (let j = this.i + 1; problem && this.codec.unordered?.(msg) && this.frames[j]?.dir === 'out' && this.frames[j]!.msg && this.codec.unordered(this.frames[j]!.msg!); j++) {
      if (this.codec.match(msg, this.frames[j]!.msg!, this.ids)) continue
      this.frames.splice(this.i, 0, ...this.frames.splice(j, 1))
      problem = null
    }
    if (problem) {
      this.problem(problem)
      return
    }
    this.i++
    this.pump()
  }

  private problem(text: string): void {
    this.problems.push(text)
    this.onProblem?.(text)
  }

  /**
   * A line to the adapter. Never within the call that wrote the line it answers: a pipe delivers after the write returned, and a
   * client registers its wait for an answer after writing the request (Codex's does), so an answer in the same call is lost
   */
  private say(line: string): void {
    queueMicrotask(() => this.stdout.write(line))
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
      this.say(`${JSON.stringify(msg)}\n`)
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return
    this.ended = true
    // The recorded frames of this process that the adapter never reached are dropped with it
    if (this.frames[this.i]?.dir === 'exit') this.i++
    this.exitCode = code
    this.signalCode = signal
    queueMicrotask(() => this.stdout.end())
    setImmediate(() => this.emit('exit', code, signal))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.finish(null, signal)
    return true
  }
}

const describe = (m: Record<string, unknown>) => (typeof m.method === 'string' ? `${m.method}` : typeof m.type === 'string' ? describeLine(m) : `an answer to ${String(m.id)}`)
const describeRec = (r: Rec) => (r.dir === 'exit' ? 'the process ending' : r.msg ? `${r.dir === 'in' ? 'incoming' : 'outgoing'} ${describe(r.msg)}` : r.dir)
