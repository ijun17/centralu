import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { AgentProcess } from '../contract.js'

/**
 * A small scriptable ACP agent for what a real tool cannot be made to send (docs/plans/acp-adapter.md §10.3): a process
 * that dies at a chosen point, an auth error, a load that is not found, compaction updates (no tool we run sends them
 * yet), a cancel it ignores. These frames are written by hand, and say so: the shapes follow ACP's schema, not a
 * recording. Everything a real tool can be made to do is a recording (`replay.test.ts`).
 */

export type Answer = { result: unknown } | { error: { code: number; message: string } } | { hold: true }

export type PeerScript = (method: string, params: Record<string, unknown>, peer: FakeAcpPeer) => Answer | Promise<Answer>

const idOf = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export class FakeAcpPeer extends EventEmitter implements AgentProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4343
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  /** Every frame the adapter sent, in order */
  readonly received: Record<string, unknown>[] = []
  private readonly held = new Map<string, (a: Answer) => void>()
  private readonly answers = new Map<string, (v: unknown) => void>()
  private nextId = 0
  private buffer = ''
  private ended = false
  private readonly sent: ((m: Record<string, unknown>) => void)[] = []

  constructor(private readonly script: PeerScript) {
    super()
    this.stdin.on('data', (d: Buffer) => {
      this.buffer += String(d)
      let n
      while ((n = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, n)
        this.buffer = this.buffer.slice(n + 1)
        if (line.trim()) void this.receive(JSON.parse(line) as Record<string, unknown>)
      }
    })
    this.stdin.on('finish', () => this.exit(0))
  }

  /** The methods the adapter has called, in order (notifications included) */
  methods(): string[] {
    return this.received.flatMap((m) => (typeof m.method === 'string' ? [m.method] : []))
  }

  /** Resolves when the adapter next sends a frame `pick` accepts (it may have already) */
  next(pick: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const seen = this.received.find(pick)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve) => {
      const check = (m: Record<string, unknown>) => {
        if (!pick(m)) return
        this.sent.splice(this.sent.indexOf(check), 1)
        resolve(m)
      }
      this.sent.push(check)
    })
  }

  private async receive(m: Record<string, unknown>): Promise<void> {
    this.received.push(m)
    for (const f of [...this.sent]) f(m)
    if (m.method === undefined && m.id !== undefined) {
      this.answers.get(idOf(m.id))?.(m.result ?? m.error)
      return
    }
    if (typeof m.method !== 'string') return
    const answer = await this.script(m.method, (m.params ?? {}) as Record<string, unknown>, this)
    if (m.id === undefined) return
    if ('hold' in answer) {
      this.held.set(m.method, (a) => this.reply(m.id, a))
      return
    }
    this.reply(m.id, answer)
  }

  /** Answers a request the script held (`{ hold: true }`), by method */
  release(method: string, answer: Answer): void {
    const r = this.held.get(method)
    this.held.delete(method)
    r?.(answer)
  }

  private reply(id: unknown, a: Answer): void {
    if ('hold' in a) return
    this.write({ jsonrpc: '2.0', id, ...a })
  }

  update(sessionId: string, update: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  }

  /** Asks the adapter, as the agent does (`session/request_permission`), and resolves with its answer */
  ask(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.answers.set(String(id), resolve)
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  write(m: Record<string, unknown>): void {
    if (!this.ended) this.stdout.write(`${JSON.stringify(m)}\n`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.ended) return
    this.ended = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    setImmediate(() => this.emit('exit', code, signal))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.exit(null, signal)
    return true
  }
}

/** The answers an agent gives that every scenario needs: initialize, a new session, a load */
export const INIT_RESULT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: {} },
  agentInfo: { name: 'fake', version: '0.0.1' },
}
