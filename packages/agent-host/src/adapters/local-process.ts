import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, type Writable } from 'node:stream'
import { KILL_GRACE_MS, hasProcessGroups, killTree, noteGroups, stopGroup, stopTree, type KillOs, type LeftoverOs } from '../dev-services/kill-tree.js'
import { killHandle, spawnGrouped, sweepLeftovers, tracked, type GroupedChild } from '../dev-services/grouped-child.js'
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

/** The lookup that comes first in `HOST_WATCH` (see the comment below it): what Node's spawn would have raised, said on fd 4 */
export const FIND_CLI =
  // A name with a slash is tested here, not looked up: `command -v` answers differently for a file that cannot be run
  // (macOS's sh fails where dash prints the path), and Node says ENOENT for none, EACCES for a folder or a file not runnable
  'case $1 in */*) [ -e "$1" ] || { echo enoent >&4; exit 127; }; ' +
  'if [ -d "$1" ] || [ ! -x "$1" ]; then echo eacces >&4; exit 126; fi;; ' +
  // A bare name is looked up on PATH as libuv does, not with `command -v`, which differs by shell too: dash 0.5.11 (Ubuntu
  // 22.04) prints the first file of that name, runnable or not, and without a folder when an empty entry found it; 0.5.12
  // skips one that cannot be run. The first runnable file runs, so says nothing; else a match that cannot be run is
  // EACCES and nothing is ENOENT. An empty entry, and a PATH set but empty, is the folder it starts in (`/dev/null` ends the
  // list so a trailing empty one is not split away). `exec` then searches the same PATH and skips what cannot be run, as libuv does.
  '*) (IFS=:; set -f; e=2; for d in ${PATH+$PATH:}/dev/null; do f=${d:-.}/$1; if [ -f "$f" ] && [ -x "$f" ]; then exit 0; fi; ' +
  '[ -e "$f" ] && e=1; done; exit $e); case $? in 1) echo eacces >&4; exit 126;; 2) echo enoent >&4; exit 127;; esac;; esac; '

/**
 * The guard a CLI that must end with the host starts behind (`AgentSpawnSpec.endsWithHost`, macOS and Linux): `sh` keeps a
 * reader on fd 3, a pipe whose other end only this host holds, and `exec`s the CLI in its place with fd 3 closed. The
 * kernel closes the host's end when the host goes, however it goes (SIGKILL included), and the reader then ends the whole
 * group (`kill -9 0`): the CLI, its MCP servers and the shells in its group. It needs no stdin's end to reach anyone.
 * Before that it ends the helper groups a shell the CLI starts in a group of its own lives in, and what that shell runs:
 * those of the CLI's descendants then (`watchTreeGroups`, read by parent links when the pipe closes, so a command
 * started a moment before the host died is reached too; #1562 Mac re-check), and those the host told it of on the pipe
 * (`+<pgid>` noted, `-<pgid>` dropped once empty, `noteTree`), which reach a helper whose shell has gone.
 *
 * Before all that the shell looks the CLI up itself (`FIND_CLI`) and says on fd 4 what Node's spawn would have raised, `enoent`
 * or `eacces`; the host turns it into the same 'error' (`LocalAgentProcess.readStatus`). fd 4 is closed by the `exec`, so a
 * CLI that starts says nothing.
 */
export const HOST_WATCH =
  FIND_CLI +
  '{ g=; while read -r l; do case $l in +*) g="$g ${l#+}";; -*) n=; for p in $g; do [ "$p" = "${l#-}" ] || n="$n $p"; done; g=$n;; esac; done; ' +
  'for p in $g $(' +
  watchTreeGroups() +
  '); do kill -9 -"$p" 2>/dev/null; done; kill -9 0 2>/dev/null; } <&3 >/dev/null 2>&1 4>&- & exec "$@" 3<&- 4>&-'

/**
 * The process groups of the CLI's descendants, its own aside, as the watch reads them: `$$` in the watch's subshell is the
 * CLI's pid (the `sh` that `exec`ed it)
 */
function watchTreeGroups(): string {
  return (
    'ps -A -o pid= -o ppid= -o pgid= 2>/dev/null | awk -v r="$$" \'{ p[$1] = $2; g[$1] = $3 } END { d[r] = 1; ' +
    'do { c = 0; for (k in p) if (!(k in d) && (p[k] in d)) { d[k] = 1; c = 1 } } while (c); ' +
    'for (k in d) if (g[k] != g[r] && g[k] > 1) print g[k] }\''
  )
}

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
  private readonly status: Promise<void>
  /** Reported once the output has all arrived, so a reader never sees the exit before the last line */
  private readonly exitReport = new ExitAfterDrain(() => this.emit('exit', this.child.exitCode, this.child.signalCode))

  private constructor(
    private readonly child: ChildProcess,
    /** Its start and exit times (`spawnGrouped`): the Windows sweep matches what it left by creation time */
    private readonly started: GroupedChild,
    private readonly os: LocalProcessOs | undefined,
    private readonly spec: AgentSpawnSpec,
  ) {
    super()
    this.stdin = child.stdin!
    this.stdout = child.stdout!
    this.stderr = child.stderr
    // Always read: a CLI whose stderr nobody drains blocks once the pipe is full
    child.stderr?.on('data', (d: Buffer) => this.tail.push(d))
    child.stdin?.on('error', () => {})
    // The host-watch pipe: a write after its reader has gone is no error of the host's
    child.stdio[3]?.on('error', () => {})
    this.status = this.readStatus(child.stdio[4])
    child.on('error', (e) => {
      this.emit('error', e)
      /*
       * A CLI that never started (no pid: not there, or refused outright, `notStarted`) also ends, after its 'error',
       * so whoever waits for 'exit' is not left waiting. Node itself sends a never-started process 'error' and 'close'
       * only, never 'exit' (measured: ENOENT on Windows and Linux).
       */
      if (child.pid === undefined) this.onExit()
    })
    // The shell's word on a CLI it could not start comes before the exit is reported
    child.once('exit', () => void this.status.then(() => this.onExit()))
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
        ? spawnGrouped('/bin/sh', ['-c', HOST_WATCH, 'centralu-agent', spec.command, ...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] }, os?.platform)
        : spawnGrouped(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] }, os?.platform)
    } catch (err) {
      started = tracked(notStarted(err as Error), Date.now())
    }
    const p = new LocalAgentProcess(started.child, started, os, spec)
    if (spec.signal) {
      if (spec.signal.aborted) p.kill('SIGTERM')
      else spec.signal.addEventListener('abort', () => p.kill('SIGTERM'), { once: true })
    }
    return p
  }

  /**
   * What the shell behind the watch said before it started the CLI (`FIND_CLI`, on fd 4): a CLI it could not find or run is
   * an 'error' as Node's spawn gives, not an exit code. Settles once fd 4 has ended, which the `exec` or the shell's exit does
   */
  private readStatus(pipe: Readable | Writable | null | undefined): Promise<void> {
    if (!(pipe instanceof Readable)) return Promise.resolve()
    const r = pipe
    let said = ''
    r.on('data', (d: Buffer) => (said += d.toString()))
    return new Promise((resolve) => {
      const done = () => {
        const code = said.includes('enoent') ? 'ENOENT' : said.includes('eacces') ? 'EACCES' : null
        if (code) this.emit('error', startError(code, this.spec))
        resolve()
      }
      r.once('end', done)
      r.once('error', () => resolve())
    })
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
        this.tellWatch(this.groups, groups)
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

  /**
   * The host watch (`HOST_WATCH`) is told each helper group as it is noted and as it is dropped, so a host killed outright
   * still ends them: they are in groups of their own, which the watch's own `kill -9 0` does not reach (#1562 Mac re-check:
   * Cursor's `zsh -c` and its `sleep 300` outlived a SIGKILLed host)
   */
  private tellWatch(before: ReadonlySet<number>, after: ReadonlySet<number>): void {
    const watch = this.child.stdio[3]
    if (!watch || !('write' in watch) || watch.destroyed) return
    const lines = [...[...after].filter((g) => !before.has(g)).map((g) => `+${g}`), ...[...before].filter((g) => !after.has(g)).map((g) => `-${g}`)]
    if (lines.length) watch.write(lines.join('\n') + '\n')
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
    void sweepLeftovers(this.started, this.os?.platform, this.os?.listProcesses ? { listProcesses: this.os.listProcesses, taskkill: this.os.taskkill } : undefined).then((ended) => {
      if (ended.length > 0) console.error(`[agent] ended ${ended.length} process(es) pid ${pid} left running: ${ended.join(', ')}`)
    })
  }
}

/** The error Node's spawn gives for a program that is not there (`ENOENT`) or cannot be run (`EACCES`) */
function startError(code: 'ENOENT' | 'EACCES', spec: AgentSpawnSpec): Error {
  const errno = code === 'ENOENT' ? -2 : -13
  return Object.assign(new Error(`spawn ${spec.command} ${code}`), { code, errno, syscall: `spawn ${spec.command}`, path: spec.command, spawnargs: spec.args })
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
