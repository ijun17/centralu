import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import {
  KILL_GRACE_MS,
  collectOrphansWindows,
  killTree,
  stopGroup,
  stopTree,
  type KillOs,
  type KillablePty,
  type LeftoverOs,
} from '../dev-services/kill-tree.js'
import type { AgentProcess, AgentSpawnSpec } from './contract.js'

/**
 * An agent CLI this host starts itself: the path without a keeper (Windows, `pnpm dev`, e2e, a debug
 * app, or a keeper whose child service did not answer). Under a keeper the CLI is the keeper's child
 * instead (`keeper/agent-process.ts`).
 *
 * The point is what stopping it ends. An agent CLI starts helpers of its own: Claude Code's LSP
 * tool runs `typescript-language-server`, which runs `tsserver` (one reached 3.4 GB); MCP servers from
 * the user's config; shells. A CLI that ends without stopping them, because it was KILLed after a
 * timeout, crashed, or just does not clean up, used to leave them running under launchd/init: the SDK
 * and `CodexClient` only ever signalled the CLI's own pid.
 *
 * - **macOS and Linux.** The CLI leads a process group of its own (`detached`), so its helpers are
 *   in that group and not in the host's. Stopping it is `kill-tree.ts`'s two shots: TERM to every
 *   group in its tree, then KILL to whatever of that tree is still there after the grace. After the
 *   CLI has exited, however it ended, its group is swept once more (`stopGroup`), which reaches the
 *   helpers that outlived it: they are no longer under it in `ps`, but they are still in its group,
 *   whose number is not reused while anyone is in it. The host's own group is never a target.
 * - **Windows** has no groups. Stopping it is `taskkill /T /F` on its tree, one forceful shot, as
 *   the SDK's and Node's own kill already were. After it has exited, what it left running is found
 *   by parent links and creation times and ended the same way (`collectOrphansWindows`).
 *
 * Its surface is the `ChildProcess` subset adapters use (`AgentProcess`), so it is what both the
 * Agent SDK's `spawnClaudeCodeProcess` and `CodexClient` take.
 */

/** What this needs from the OS, as a parameter so the Windows path can be tested on any OS */
export type LocalProcessOs = KillOs & Pick<LeftoverOs, 'listProcesses'>

export type LocalSpawnSpec = AgentSpawnSpec & {
  /** The SDK passes one: aborting it stops the process, as `spawn`'s own `signal` option would */
  signal?: AbortSignal
}

/** How long an exit waits for the last of stdout before it is reported anyway */
const EXIT_AFTER_OUTPUT_MS = 1000
/** The end of stderr kept for a failure message: the SDK only keeps it for processes it spawns itself */
const STDERR_TAIL = 8 * 1024

export class LocalAgentProcess extends EventEmitter implements AgentProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable | null
  killed = false
  private tail = ''
  private exitReported = false
  private readonly spawnedAt = Date.now()

  private constructor(
    private readonly child: ChildProcess,
    private readonly os: LocalProcessOs | undefined,
  ) {
    super()
    this.stdin = child.stdin!
    this.stdout = child.stdout!
    this.stderr = child.stderr
    // Always read: a CLI whose stderr nobody drains blocks once the pipe is full
    child.stderr?.on('data', (d: Buffer) => {
      this.tail = (this.tail + d.toString('utf8')).slice(-STDERR_TAIL)
    })
    child.stdin?.on('error', () => {})
    child.on('error', (e) => this.emit('error', e))
    child.once('exit', () => this.onExit())
  }

  static spawn(spec: LocalSpawnSpec, os?: LocalProcessOs): LocalAgentProcess {
    const platform = os?.platform ?? process.platform
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      /*
       * A group of its own, which its helpers join. Not on Windows: there `detached` means a process
       * with no console, whose every console child opens a visible window (app-process.ts).
       */
      detached: platform !== 'win32',
      windowsHide: true,
    })
    const p = new LocalAgentProcess(child, os)
    if (spec.signal) {
      if (spec.signal.aborted) p.kill('SIGTERM')
      else spec.signal.addEventListener('abort', () => p.kill('SIGTERM'), { once: true })
    }
    return p
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get exitCode(): number | null {
    return this.child.exitCode
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode
  }

  /** The end of what the CLI wrote to stderr */
  stderrTail(): string {
    return this.tail
  }

  private get ended(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null
  }

  private get platform(): NodeJS.Platform {
    return this.os?.platform ?? process.platform
  }

  private handle(): KillablePty {
    return { pid: this.child.pid, kill: (s?: string) => void this.child.kill(s as NodeJS.Signals | undefined) }
  }

  /**
   * Stops the CLI and what it started (see the file header). TERM is the polite one, with KILL to
   * the survivors after `KILL_GRACE_MS`; KILL is at once. On Windows every signal is `taskkill /T /F`.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.ended || this.child.pid === undefined) return false
    this.killed = true
    if (this.platform === 'win32' || signal === 'SIGKILL') killTree(this.handle(), 'SIGKILL', this.os)
    else if (signal === 'SIGTERM') stopTree(this.handle(), KILL_GRACE_MS, () => !this.ended, this.os)
    else {
      try {
        process.kill(-this.child.pid, signal)
      } catch {
        this.child.kill(signal)
      }
    }
    return true
  }

  private onExit(): void {
    this.sweep()
    // Reported once the output has all arrived, so a reader never sees the exit before the last line
    const report = () => {
      if (this.exitReported) return
      this.exitReported = true
      this.emit('exit', this.child.exitCode, this.child.signalCode)
    }
    if (this.stdout.readableEnded) return report()
    this.stdout.once('end', report)
    setTimeout(report, EXIT_AFTER_OUTPUT_MS).unref()
  }

  /** What the CLI left running once it has exited, however it ended */
  private sweep(): void {
    const pid = this.child.pid
    if (pid === undefined) return
    if (this.platform !== 'win32') return stopGroup(pid, KILL_GRACE_MS)
    const root = { pid, spawnedAt: this.spawnedAt, exitedAt: Date.now() }
    void collectOrphansWindows(root, this.os?.listProcesses ? { listProcesses: this.os.listProcesses, taskkill: this.os.taskkill } : undefined)
      .then((ended) => {
        if (ended.length > 0) console.error(`[agent] ended ${ended.length} process(es) pid ${pid} left running: ${ended.join(', ')}`)
      })
      .catch(() => {})
  }
}

export function spawnLocalAgent(spec: LocalSpawnSpec, os?: LocalProcessOs): LocalAgentProcess {
  return LocalAgentProcess.spawn(spec, os)
}
