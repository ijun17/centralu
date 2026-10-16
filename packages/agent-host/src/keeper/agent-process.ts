import type { Socket } from 'node:net'
import { constants } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { Tail } from '../stream-text.js'
import type { ChildExit, KeeperChildren, KeptChild } from './children-client.js'
import { HeldChild } from './held-child.js'
import type { AgentTag } from './tags.js'

/**
 * An agent process the keeper holds, shaped like the `ChildProcess` the adapters already use
 * (#280 step 2). It satisfies both the Agent SDK's `SpawnedProcess` (`spawnClaudeCodeProcess`) and
 * what `CodexClient` reads: `stdin`, `stdout`, `stderr`, `pid`, `exitCode`, `signalCode`,
 * `killed`, `kill()`, and the `exit` / `error` events.
 *
 * The difference from a child of this host is what leaving means:
 *
 * - `kill()` is a request to the keeper for the CLI's whole process group (its helpers with it), and
 *   it is **never sent while the host is leaving**. The
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

/** The end of stderr kept for a failure message, as `local-process.ts` keeps it */
const STDERR_TAIL = 8 * 1024

export class KeeperAgentProcess extends HeldChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  private out: Socket | null = null
  private err: Socket | null = null
  private queued: { chunk: Buffer; cb: (e?: Error | null) => void }[] = []
  private readonly tail = new Tail(STDERR_TAIL)

  private constructor(keeper: KeeperChildren, child: Promise<KeptChild>) {
    super(keeper)
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => this.writeIn(chunk, cb),
      final: (cb) => this.endIn(cb),
    })
    // A write after the child is gone is not worth a crash of the host
    this.stdin.on('error', () => {})
    /*
     * Always read, as a child of this host's stderr is: the end is what says why it failed, and nobody else may read
     * it (the SDK reads it only when asked to). What the keeper buffered while no host was attached comes first.
     */
    this.stderr.on('data', (d: Buffer) => this.tail.push(d))
    this.begin(child, ['out', 'err'])
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

  protected attached([out, err]: Socket[]): void {
    this.out = out!
    this.err = err!
    out!.pipe(this.stdout)
    err!.pipe(this.stderr)
    for (const q of this.queued.splice(0)) out!.write(q.chunk, q.cb)
  }

  /** The end of what the CLI wrote to stderr */
  stderrTail(): string {
    return this.tail.text
  }

  protected failed(e: Error): void {
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

  protected override noteExit(exit: ChildExit): void {
    this.exitCode = exit.code
    this.signalCode = exit.signal !== null ? (SIGNAL_NAMES.get(exit.signal) ?? 'SIGTERM') : null
  }

  protected exited(): void {
    this.emit('exit', this.exitCode, this.signalCode)
  }

  /**
   * Signals the CLI's whole process group, not its pid alone. The keeper started the CLI in a session
   * of its own, so the group is the CLI and the helpers it started (a language server and its
   * `tsserver`, MCP servers, shells), and nothing else. A CLI that dies of the signal without stopping
   * them, or is KILLed, no longer leaves them running under launchd/init. The keeper also sweeps the
   * group once the CLI has exited (`keeper/children/mod.rs`, `Sweep`).
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.gone || hostLeaving) return false
    this.killed = true
    this.signalChild(signal, true, 'an agent')
    return true
  }

  protected override detachedStreams(): void {
    this.err?.destroy()
  }
}
