import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { KILL_GRACE_MS, hasProcessGroups, killTree, noteGroups, stopGroup, stopTree, type KillOs, type LeftoverOs } from '../dev-services/kill-tree.js'
import { killHandle, spawnGrouped, sweepExited } from '../dev-services/grouped-child.js'
import { ExitAfterDrain } from '../exit-after-drain.js'
import { Tail } from '../stream-text.js'
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

/**
 * The guard a CLI that must end with the host starts behind (`AgentSpawnSpec.endsWithHost`, macOS and Linux): `sh` keeps a
 * reader on fd 3, a pipe whose other end only this host holds, and `exec`s the CLI in its place with fd 3 closed. The
 * kernel closes the host's end when the host goes, however it goes (SIGKILL included), and the reader then ends the whole
 * group (`kill -9 0`): the CLI, its MCP servers and the shells in its group. It needs no stdin's end to reach anyone.
 */
export const HOST_WATCH = '{ cat <&3 >/dev/null 2>&1; kill -9 0 2>/dev/null; } & exec "$@" 3<&-'

/** How often held helper groups are read again (`noteTree`) */
const GROUP_CHECK_MS = 2_000

/** The end of stderr kept for a failure message: the SDK only keeps it for processes it spawns itself */
const STDERR_TAIL = 8 * 1024

export class LocalAgentProcess extends EventEmitter implements AgentProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable | null
  killed = false
  private readonly tail = new Tail(STDERR_TAIL)
  /** The helper groups its tree had when last asked (`noteTree`) and that still have a member, swept once it has gone */
  private groups = new Set<number>()
  /** While groups are held: they are read again, so one that has emptied is dropped before its number is reused */
  private groupClock: ReturnType<typeof setInterval> | null = null
  private noting: Promise<void> | null = null
  /** Reported once the output has all arrived, so a reader never sees the exit before the last line */
  private readonly exitReport = new ExitAfterDrain(() => this.emit('exit', this.child.exitCode, this.child.signalCode))

  private constructor(
    private readonly child: ChildProcess,
    /** Taken just before the spawn (`spawnGrouped`): the Windows sweep matches what it left by creation time */
    private readonly spawnedAt: number,
    private readonly os: LocalProcessOs | undefined,
  ) {
    super()
    this.stdin = child.stdin!
    this.stdout = child.stdout!
    this.stderr = child.stderr
    // Always read: a CLI whose stderr nobody drains blocks once the pipe is full
    child.stderr?.on('data', (d: Buffer) => this.tail.push(d))
    child.stdin?.on('error', () => {})
    child.on('error', (e) => {
      this.emit('error', e)
      /*
       * A CLI that never started (no pid: not there, or refused outright, `notStarted`) also ends, after its 'error',
       * so whoever waits for 'exit' is not left waiting. Node itself sends a never-started process 'error' and 'close'
       * only, never 'exit' (measured: ENOENT on Windows and Linux).
       */
      if (child.pid === undefined) this.onExit()
    })
    child.once('exit', () => this.onExit())
  }

  static spawn(spec: LocalSpawnSpec, os?: LocalProcessOs): LocalAgentProcess {
    /*
     * A group of its own, which its helpers join. Not on Windows: there `detached` means a process
     * with no console, whose every console child opens a visible window (`spawnGrouped`).
     */
    let started: ReturnType<typeof spawnGrouped>
    try {
      const watched = !!spec.endsWithHost && hasProcessGroups(os?.platform)
      started = watched
        ? spawnGrouped('/bin/sh', ['-c', HOST_WATCH, 'centralu-agent', spec.command, ...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }, os?.platform)
        : spawnGrouped(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] }, os?.platform)
    } catch (err) {
      started = { child: notStarted(err as Error), spawnedAt: Date.now() }
    }
    const p = new LocalAgentProcess(started.child, started.spawnedAt, os)
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

  noteTree(): Promise<void> {
    const pid = this.child.pid
    if (pid === undefined || this.ended || !this.grouped) return Promise.resolve()
    this.noting ??= noteGroups(pid, this.groups, this.os?.platform)
      .then((groups) => {
        if (this.ended) return
        this.groups = groups
        if (groups.size === 0) this.stopGroupClock()
        else if (!this.groupClock) {
          this.groupClock = setInterval(() => void this.noteTree(), GROUP_CHECK_MS)
          this.groupClock.unref?.()
        }
      })
      .finally(() => {
        this.noting = null
      })
    return this.noting
  }

  private stopGroupClock(): void {
    if (this.groupClock) clearInterval(this.groupClock)
    this.groupClock = null
  }

  /** The end of what the CLI wrote to stderr */
  stderrTail(): string {
    return this.tail.text
  }

  private get ended(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null
  }

  /** Whether the CLI got a group of its own (`hasProcessGroups`) */
  private get grouped(): boolean {
    return hasProcessGroups(this.os?.platform)
  }

  /**
   * Stops the CLI and what it started (see the file header). TERM is the polite one, with KILL to
   * the survivors after `KILL_GRACE_MS`; KILL is at once. On Windows every signal is `taskkill /T /F`.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.ended || this.child.pid === undefined) return false
    this.killed = true
    if (!this.grouped || signal === 'SIGKILL') killTree(killHandle(this.child), 'SIGKILL', this.os)
    else if (signal === 'SIGTERM') stopTree(killHandle(this.child), KILL_GRACE_MS, () => !this.ended, this.os)
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
    // The host-watch pipe (`HOST_WATCH`) has nothing left to watch: its reader ends with what is left of the group
    const watch = this.child.stdio[3]
    if (watch && 'destroy' in watch) watch.destroy()
    this.sweep()
    if (!this.stdout.readableEnded) this.stdout.once('end', () => this.exitReport.drained())
    this.exitReport.exited(this.stdout.readableEnded)
  }

  /** What the CLI left running once it has exited, however it ended */
  private sweep(): void {
    const pid = this.child.pid
    if (pid === undefined) return
    // Groups of its own its helpers started (a shell, measured: Cursor's), which its group's sweep does not reach
    this.stopGroupClock()
    for (const g of this.groups) stopGroup(g, KILL_GRACE_MS)
    const root = { pid, spawnedAt: this.spawnedAt, exitedAt: Date.now() }
    void sweepExited(root, this.os?.platform, this.os?.listProcesses ? { listProcesses: this.os.listProcesses, taskkill: this.os.taskkill } : undefined).then((ended) => {
      if (ended.length > 0) console.error(`[agent] ended ${ended.length} process(es) pid ${pid} left running: ${ended.join(', ')}`)
    })
  }
}

/**
 * A process that never started, reporting why as an 'error' on the next tick, the way Node reports one that is not there
 * (ENOENT). Node throws instead for a command it refuses outright: a `.cmd` on Windows (EINVAL), a name with a NUL. That
 * throw reached the adapters' constructors (`CodexClient`), so a shim we could not read turned into a crash where a
 * missing CLI is a message (#849). Its streams take writes and end at once, as a dead process's pipes would.
 */
function notStarted(err: Error): ChildProcess {
  const stand = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  stdout.end()
  const stdin = new PassThrough()
  Object.assign(stand, { stdin, stdout, stderr: null, stdio: [stdin, stdout, null], pid: undefined, exitCode: null, signalCode: null, kill: () => false })
  process.nextTick(() => stand.emit('error', err))
  return stand
}

export function spawnLocalAgent(spec: LocalSpawnSpec, os?: LocalProcessOs): LocalAgentProcess {
  return LocalAgentProcess.spawn(spec, os)
}
