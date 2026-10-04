import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { constants } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import type { ChildExit, KeeperChildren, KeptChild } from './children-client.js'
import type { AgentTag } from './tags.js'

/**
 * An agent process the keeper holds, shaped like the `ChildProcess` the adapters already use
 * (#280 step 2). It satisfies both the Agent SDK's `SpawnedProcess` (`spawnClaudeCodeProcess`) and
 * what `CodexClient` reads: `stdin`, `stdout`, `stderr`, `pid`, `exitCode`, `signalCode`,
 * `killed`, `kill()`, and the `exit` / `error` events.
 *
 * The difference from a child of this host is what leaving means:
 *
 * - `kill()` is a request to the keeper, and it is **never sent while the host is leaving**. The
 *   SDK kills every process it spawned when its owner exits (`process.on('exit')`); under the
 *   keeper an exit is a restart, and the agent must outlive it. A stop kills explicitly, before the
 *   host exits.
 * - `stdin.end()` (the SDK's graceful close, codex's EOF that removes its thread lock, #57) is a
 *   keeper `close_stdin` request, never just the end of a socket.
 * - `detach()` releases the process without stopping it: the keeper sends the rest of the current
 *   line, ends the stream, and buffers for the next host.
 */

/** Set as the host process exits. Registered at load, so it runs before the SDK's own exit hook. */
let hostLeaving = false
process.once('exit', () => {
  hostLeaving = true
})

const SIGNAL_NAMES = new Map<number, NodeJS.Signals>(
  Object.entries(constants.signals).map(([name, n]) => [n, name as NodeJS.Signals]),
)

export type SpawnSpec = { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> }

/** How long an exit waits for the last of stdout before it is reported anyway */
const EXIT_AFTER_OUTPUT_MS = 1000
/** How long a detach waits for the keeper to end the stream */
const DETACH_WAIT_MS = 2000

export class KeeperAgentProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  /** The keeper's id for this child, once the spawn has answered */
  childId: string | null = null
  private out: Socket | null = null
  private err: Socket | null = null
  private detached = false
  private exitReported = false
  private exitTimer: NodeJS.Timeout | null = null
  private outEnded = false
  private queued: { chunk: Buffer; cb: (e?: Error | null) => void }[] = []
  private readonly ready: Promise<void>

  private constructor(
    private keeper: KeeperChildren,
    child: Promise<KeptChild>,
  ) {
    super()
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => this.writeIn(chunk, cb),
      final: (cb) => this.endIn(cb),
    })
    // A write after the child is gone is not worth a crash of the host
    this.stdin.on('error', () => {})
    this.ready = this.start(child)
  }

  /** Asks the keeper to spawn the process. Returns at once, as `spawn()` does; a failure arrives as `error`. */
  static spawn(keeper: KeeperChildren, spec: SpawnSpec, tag: AgentTag): KeeperAgentProcess {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(spec.env)) if (typeof v === 'string') env[k] = v
    return new KeeperAgentProcess(
      keeper,
      keeper.spawn({ kind: 'pipes', cmd: spec.command, args: spec.args, cwd: spec.cwd ?? process.cwd(), env, tag }),
    )
  }

  /** Takes over a process the keeper already holds (spawned by a previous host). */
  static adopt(keeper: KeeperChildren, child: KeptChild): KeeperAgentProcess {
    return new KeeperAgentProcess(keeper, Promise.resolve(child))
  }

  private async start(childP: Promise<KeptChild>): Promise<void> {
    let child: KeptChild
    try {
      child = await childP
    } catch (e) {
      return this.fail(e as Error)
    }
    this.childId = child.id
    this.pid = child.pid
    this.keeper.on('exit', this.onChildExit)
    this.keeper.once('lost', this.onLost)
    let out: Socket
    let err: Socket
    try {
      ;[out, err] = await Promise.all([this.keeper.attach(child.id, 'out'), this.keeper.attach(child.id, 'err')])
    } catch (e) {
      return this.fail(e as Error)
    }
    if (this.detached) {
      out.destroy()
      err.destroy()
      return
    }
    this.out = out
    this.err = err
    out.pipe(this.stdout)
    err.pipe(this.stderr)
    out.on('end', () => {
      this.outEnded = true
      if (this.exitCode !== null || this.signalCode !== null) this.reportExit()
    })
    out.on('error', () => {})
    err.on('error', () => {})
    const known = child.exit ?? this.keeper.exitOf(child.id)
    if (known) this.recordExit(known)
    for (const q of this.queued.splice(0)) out.write(q.chunk, q.cb)
  }

  private fail(e: Error): void {
    process.nextTick(() => {
      if (this.listenerCount('error') > 0) this.emit('error', e)
      else console.error('[keeper] agent process failed:', e.message)
      this.stdout.end()
      this.stderr.end()
    })
  }

  private writeIn(chunk: Buffer, cb: (e?: Error | null) => void): void {
    if (this.detached) return cb()
    if (!this.out) {
      this.queued.push({ chunk, cb })
      return
    }
    this.out.write(chunk, cb)
  }

  private endIn(cb: (e?: Error | null) => void): void {
    if (this.detached || hostLeaving) return cb()
    void this.ready
      .then(() => (this.childId && !this.detached ? this.keeper.closeStdin(this.childId) : undefined))
      .then(
        () => cb(),
        () => cb(),
      )
  }

  private onChildExit = (id: string, exit: ChildExit): void => {
    if (id === this.childId) this.recordExit(exit)
  }

  /** The keeper is gone, and with it the pipes this process wrote to: it cannot be alive. */
  private onLost = (): void => {
    if (this.detached || this.exitCode !== null || this.signalCode !== null) return
    this.recordExit({ code: null, signal: constants.signals.SIGHUP })
  }

  private recordExit(exit: ChildExit): void {
    this.exitCode = exit.code
    this.signalCode = exit.signal !== null ? (SIGNAL_NAMES.get(exit.signal) ?? 'SIGTERM') : null
    // Reported once the output has all arrived, so a reader never sees the exit before the last line
    if (this.outEnded || !this.out) return this.reportExit()
    this.exitTimer ??= setTimeout(() => this.reportExit(), EXIT_AFTER_OUTPUT_MS)
  }

  private reportExit(): void {
    if (this.exitReported || this.detached) return
    this.exitReported = true
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.keeper.off('exit', this.onChildExit)
    this.keeper.off('lost', this.onLost)
    this.emit('exit', this.exitCode, this.signalCode)
    // Its output is all here: the keeper's record has nothing more to give anyone
    if (this.childId) void this.keeper.release(this.childId).catch(() => {})
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.detached || hostLeaving || this.exitCode !== null || this.signalCode !== null) return false
    this.killed = true
    void this.ready
      .then(() => (this.childId ? this.keeper.signal(this.childId, signal) : undefined))
      .catch((e: Error) => console.error(`[keeper] could not signal ${this.childId ?? 'an agent'}: ${e.message}`))
    return true
  }

  /**
   * Lets go of the process and leaves it running for the next host. Output that arrives until the
   * keeper ends the stream is still delivered to `stdout`, so whoever reads it keeps reading until
   * this resolves.
   */
  async detach(): Promise<void> {
    if (this.detached) return
    this.detached = true
    this.keeper.off('exit', this.onChildExit)
    this.keeper.off('lost', this.onLost)
    if (this.exitTimer) clearTimeout(this.exitTimer)
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, DETACH_WAIT_MS))])
    const out = this.out
    if (!out) return
    await new Promise<void>((resolve) => {
      if (out.readableEnded || out.destroyed) return resolve()
      const t = setTimeout(resolve, DETACH_WAIT_MS)
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      out.once('end', done)
      out.once('close', done)
      out.end()
    })
    out.destroy()
    this.err?.destroy()
  }
}
