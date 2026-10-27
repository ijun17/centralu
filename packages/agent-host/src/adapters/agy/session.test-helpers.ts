import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { pathsOf } from '../../os.js'
import { gateAddress } from '../../swap-control.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { FrontDoorGates } from '../../transport/gate-door.js'
import { deriveHttpSecret } from '../../transport/http.js'
import { HostServer } from '../../transport/server.js'
import type { AgentProcess, AgentSpawnSpec, CreateSessionOpts, SessionHandle } from '../contract.js'
import { loadRecording, type Rec } from '../frames/replay.test-helpers.js'
import { AgyAdapter } from './index.js'
import { gateSources } from './gate-path.js'
import { gateAnswer } from './gate-answer.mjs'
import { agyFiles, nodeExecutable } from './host-files.js'

const { join } = pathsOf()

/**
 * A scripted `agy` for the session tests: a process whose frames come from a recording (or from frames written in the same
 * shape, `Rec`) and whose gate calls go to the host through the real route, with the hook's own `gateAnswer` and Node's
 * `fetch`. It behaves as measured where a test depends on it: it ignores SIGINT while a hook call waits (antigravity-adapter.md
 * §1.5), and says "interrupted" only once SIGINT came.
 */

export const TOKEN = 'test-token-for-the-agy-session'

/** The processes of a recording, one segment per `spawn`, each up to and including its `exit` */
export function segmentsOf(path: string): Rec[][] {
  const out: Rec[][] = []
  for (const f of loadRecording(path).frames) {
    if (f.dir === 'spawn') out.push([])
    out.at(-1)?.push(f)
  }
  return out
}

/** Frames written by hand, in the recordings' shape */
export const spawnFrame: Rec = { t: 0, dir: 'spawn', args: [] }
export const userFrame: Rec = { t: 0, dir: 'out', msg: { event: 'user', message: { content: '' } } }
export const frame = (msg: Record<string, unknown>): Rec => ({ t: 0, dir: 'in', msg })
export const exitFrame = (code = 0): Rec => ({ t: 0, dir: 'exit', code, signal: null })
export const init = (id: string): Rec => frame({ event: 'init', conversation_id: id, init: {} })
export const stepDone = (id: string, index: number, text: string): Rec =>
  frame({ event: 'step_update', step_update: { conversation_id: id, step_index: index, state: 'DONE', step_type: 'agent_response', text_delta: text } })
export const success = (id: string, response: string): Rec => frame({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response, num_turns: 1 } })
export const commandCall = (id: string, index: number, command: string): Rec[] => [
  frame({ event: 'step_update', step_update: { conversation_id: id, step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: command } } } }),
  { t: 0, dir: 'gate', msg: { input: { conversationId: id, stepIdx: index, toolCall: { name: 'run_command', args: { CommandLine: command } }, workspacePaths: [] } } },
  frame({ event: 'step_update', step_update: { conversation_id: id, step_index: index, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: command }, output: 'ok' } } }),
]

export class FakeAgy extends EventEmitter implements AgentProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  /** The hook's answers, in order, to the calls this process made */
  readonly answers: { decision: string; reason?: string }[] = []
  /** The signals it was sent, with the events the session had emitted when each came */
  readonly signals: { signal: string; events: number }[] = []
  private i = 0
  private buffer = ''
  private hookWaiting = false
  private sigint = false
  private onSigint: (() => void) | null = null
  private ended = false
  private playing = false

  constructor(
    readonly spec: AgentSpawnSpec,
    private readonly frames: Rec[],
    private readonly seen: () => number,
  ) {
    super()
    this.stdin.on('data', (d: Buffer) => {
      this.buffer += String(d)
      for (let n = this.buffer.indexOf('\n'); n >= 0; n = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, n)
        this.buffer = this.buffer.slice(n + 1)
        if (line.trim()) void this.received()
      }
    })
    this.stdin.on('finish', () => this.finish(0, null))
  }

  /** Inputs written and not yet answered: one may arrive while the last turn's frames are still being played */
  private pending = 0

  private async received(): Promise<void> {
    this.pending++
    if (this.playing) return
    this.playing = true
    try {
      while (this.pending > 0 && !this.ended) {
        while (this.frames[this.i] && this.frames[this.i]?.dir !== 'out') this.i++
        if (!this.frames[this.i]) return
        this.i++
        this.pending--
        await this.play()
      }
    } finally {
      this.playing = false
    }
  }

  private async play(): Promise<void> {
    while (this.i < this.frames.length && !this.ended) {
      const f = this.frames[this.i]!
      if (f.dir === 'out') return
      this.i++
      await new Promise((r) => setImmediate(r))
      if (this.ended) return
      if (f.dir === 'exit') return this.finish(f.code ?? null, (f.signal as NodeJS.Signals | null) ?? null)
      if (f.dir === 'err') {
        // "interrupted" is what a SIGINT makes it print
        if (/^error: interrupted/.test(f.text ?? '')) await this.untilSigint()
        this.stderr.write(`${f.text ?? ''}\n`)
      } else if (f.dir === 'in') {
        if (f.msg?.event === 'result' && f.msg.result && String((f.msg.result as { error?: unknown }).error) === 'interrupted') await this.untilSigint()
        this.stdout.write(`${JSON.stringify(f.msg)}\n`)
      } else if (f.dir === 'gate') {
        this.hookWaiting = true
        const answer = await gateAnswer({ env: { ...this.spec.env, CC_GATE_RETRY_MS: '1' }, input: JSON.stringify(f.msg?.input), fetch: globalThis.fetch })
        this.hookWaiting = false
        this.answers.push(answer)
      }
    }
  }

  private untilSigint(): Promise<void> {
    return this.sigint ? Promise.resolve() : new Promise((r) => (this.onSigint = r))
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return
    this.ended = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('exit', code, signal))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.signals.push({ signal, events: this.seen() })
    if (signal === 'SIGINT') {
      // `agy` does not act on SIGINT while a hook waits: it is acted on once the hook has its answer
      this.sigint = true
      const go = () => {
        this.onSigint?.()
        this.onSigint = null
      }
      if (this.hookWaiting) {
        const wait = setInterval(() => {
          if (!this.hookWaiting) {
            clearInterval(wait)
            go()
          }
        }, 5)
        wait.unref()
      } else go()
      return true
    }
    this.finish(null, signal)
    return true
  }
}

/** The spawner that hands the next segment to each process the session starts */
export function fakeAgyProcesses(segments: Rec[][], seen: () => number) {
  const procs: FakeAgy[] = []
  return {
    procs,
    spawn: (spec: AgentSpawnSpec): AgentProcess => {
      const frames = segments[procs.length]
      if (!frames) throw new Error(`the script has no segment for process ${procs.length + 1}`)
      const proc = new FakeAgy(spec, frames, seen)
      procs.push(proc)
      return proc
    },
  }
}

export type TestHost = {
  dataDir: string
  home: string
  cwd: string
  gates: FrontDoorGates
  server: HostServer
  port: number
  close(): Promise<void>
}

/** A host on a temp folder: the real front door with its gate route, and the person's `agy` settings where a test writes them */
export async function startHost(dirs?: { dataDir: string; home: string; cwd: string }): Promise<TestHost> {
  const root = dirs ? null : tempRoot('agy-session-')
  const d = dirs ?? { dataDir: join(root!, 'data'), home: join(root!, 'home'), cwd: join(root!, 'work') }
  for (const p of Object.values(d)) await agyFiles.mkdir(p, { recursive: true })
  const at: { port?: number } = {}
  const gates = new FrontDoorGates({ url: (id) => gateAddress(undefined, at.port, id), redact: () => [TOKEN] })
  const server = new HostServer({ port: 0, token: TOKEN, onRpc: () => Promise.resolve({}), http: { secret: deriveHttpSecret(TOKEN), routes: [] }, gate: gates })
  at.port = await server.listen()
  return { ...d, gates, server, port: at.port, close: async () => (await server.close(), root ? removeTree(root) : undefined) }
}

/** The adapter a host would register, over a scripted `agy` */
export function agyAdapter(host: TestHost, spawn: (spec: AgentSpawnSpec) => AgentProcess, stopConfirmMs?: number): AgyAdapter {
  return new AgyAdapter(
    { find: () => ({ command: 'agy', args: [] }), run: () => Promise.resolve({ stdout: '', stderr: '' }), supported: () => true },
    { gates: () => host.gates, dataDir: host.dataDir, home: host.home, files: agyFiles, node: nodeExecutable, gateSources },
    spawn,
    stopConfirmMs,
  )
}

export type Run = { events: NormalizedEvent[]; session: SessionHandle; of(type: NormalizedEvent['type']): NormalizedEvent[] }

export async function startSession(adapter: AgyAdapter, host: TestHost, over: Partial<CreateSessionOpts> & { preset?: PermissionPreset } = {}): Promise<Run> {
  const events: NormalizedEvent[] = []
  const { preset, ...rest } = over
  const session = await adapter.createSession({ sessionId: 's1', cwd: host.cwd, model: 'gemini-3.8-flash-low', permissionPreset: preset ?? 'normal', ...rest }, (e) => events.push(e))
  return { events, session, of: (type) => events.filter((e) => e.type === type) }
}

export async function until(pred: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 600 && !pred(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!pred()) throw new Error(`timed out waiting for ${what}`)
}
