import { errorMessage } from '@cc/protocol'
import { isObj } from '../json-value.js'
import { ensureToolPath } from '../env-path.js'
import { usesShippedConpty } from '../os.js'
import type { CommandTag, TerminalTag } from '../keeper/tags.js'
import { KILL_GRACE_MS, killTree, stopTree } from './kill-tree.js'

/**
 * One pty and the output it left, as a terminal tab (`terminal.ts`) and a command run (`commands.ts`) both hold one
 * (#428): the start, the output kept and sent, the exit, and the tree stopped.
 *
 * **A failure is said, never silent.** An empty black screen with no message leaves no way to know the cause: a start
 * that fails, node-pty not loading included, is written to the output, sent, and followed by an exit with no code. A
 * terminal whose node-pty did not load used to send nothing at all, and its screen waited for a shell that never came.
 */

/** Only the part of node-pty's surface we actually use (native types are never exported outward) */
export type Pty = {
  pid?: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /** Lets go of the pty and leaves the shell running — only a pty the keeper owns can (#280 step 2) */
  detach?(): Promise<void>
}
/**
 * node-pty, or the keeper's pty service with the same surface (#280 step 2, `keeper/keeper-pty.ts`).
 * The spawn options also carry a `tag`, which node-pty ignores and the keeper stores for the next host.
 */
/** Whether a loaded module has what `PtyModule` asks of node-pty: a `spawn` */
export function isPtyModule(m: unknown): m is PtyModule {
  return isObj(m) && typeof m.spawn === 'function'
}

export type PtyModule = {
  spawn(file: string, args: string[] | string, opts: Record<string, unknown>): Pty
}

/** A program and its arguments, as node-pty takes them. A string is a ready-made Windows command line, passed verbatim */
export type ShellLaunch = { file: string; args: string[] | string }

export type PtyStreamSink = (e: { terminalId: string; data?: string; exitCode?: number | null }) => void

/**
 * The output cap. Once exceeded, the oldest part is dropped. A single build log commonly reaches tens of MB, and
 * holding all of it would fill the host's memory with logs instead of conversation.
 */
export const PTY_OUTPUT_BYTES = 256 * 1024

export type PtyStart = {
  cols: number
  rows: number
  cwd: string
  /** What the next host needs to take this pty over from the keeper (ignored by node-pty) */
  tag: TerminalTag | CommandTag
}

export class PtySlot {
  pty: Pty | null = null
  output = ''

  constructor(
    /** The stream the screen follows: a terminal's id, a run's id */
    readonly streamId: string,
    private readonly emit: PtyStreamSink,
    /** The pty ended (its exit code), after the slot let go of it */
    private readonly onExit: (exitCode: number | null) => void = () => {},
  ) {}

  get alive(): boolean {
    return this.pty !== null
  }

  append(data: string): void {
    this.output += data
    if (this.output.length > PTY_OUTPUT_BYTES) this.output = this.output.slice(this.output.length - PTY_OUTPUT_BYTES)
  }

  /** Says a failure in the output and on screen, and ends the stream (see the file header) */
  fail(text: string): void {
    this.append(text)
    this.emit({ terminalId: this.streamId, data: text })
    this.emit({ terminalId: this.streamId, exitCode: null })
  }

  /**
   * Starts what `launch` names in a new pty. It is asked once PATH has the login shell's folders (`ensureToolPath`),
   * since it may look a program up there. `failure` words what went wrong: node-pty not loading (`load`), or the spawn
   */
  start(load: () => PtyModule, launch: () => ShellLaunch, opts: PtyStart, failure: (stage: 'load' | 'spawn', message: string) => string): void {
    let mod: PtyModule
    try {
      mod = load()
    } catch (err) {
      return this.fail(failure('load', errorMessage(err)))
    }
    // A GUI app never inherits the login shell's PATH (a problem already run into when creating a session)
    ensureToolPath()
    try {
      const handle = spawnPty(mod, launch(), {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        tag: opts.tag,
      })
      this.wire(handle)
    } catch (err) {
      this.fail(failure('spawn', errorMessage(err)))
    }
  }

  /** Follows `handle`: a new one, or one the keeper kept for this host */
  wire(handle: Pty): void {
    this.pty = handle
    handle.onData((data) => {
      // The last output an old pty spits out after a restart is discarded — it must never mix into the new one's
      if (this.pty !== handle) return
      this.append(data)
      this.emit({ terminalId: this.streamId, data })
    })
    handle.onExit(({ exitCode }) => {
      // Whoever owns the slot now: an old pty that ended after a restart holds as much as any other (#849)
      releaseEnded(handle)
      /*
       * **This clears the slot only when it is still that slot's owner.**
       *
       * When a restart kills the old pty, its onExit arrives late — **after** the new pty has
       * already taken the slot. Unconditionally clearing it would mark the just-launched
       * new shell as dead, turning restart into a button that kills the terminal forever.
       */
      if (this.pty !== handle) return
      this.pty = null
      this.onExit(exitCode ?? null)
      this.emit({ terminalId: this.streamId, exitCode: exitCode ?? null })
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // it may be in the process of dying — a resize failure is no reason to lose the terminal or the run
    }
  }

  /**
   * Politely, with SIGTERM to the tree; if it has not died within the grace period, SIGKILL (`kill-tree.ts`). Once its
   * exit arrives the slot lets go of it, and the second shot excludes the shell itself (a reaped number) and fires only
   * at **the surviving descendants** (#149).
   */
  stop(): void {
    const handle = this.pty
    if (handle) stopTree(handle, KILL_GRACE_MS, () => this.pty === handle)
  }

  /**
   * Lets go of the pty and stops its tree: this handle is being discarded, so once the grace period passes it is an
   * unconditional SIGKILL. Its last output and exit are no longer this slot's.
   */
  discard(): void {
    const handle = this.pty
    this.pty = null
    if (handle) stopTree(handle, KILL_GRACE_MS, () => true)
  }

  /** The host is going: SIGKILL to the whole tree, with no process left to wait out a grace period for */
  kill(): void {
    if (this.pty) killTree(this.pty, 'SIGKILL')
  }

  /** Lets go of the pty and leaves it running — only a pty the keeper owns can (#280 step 2) */
  detach(): Promise<void> | undefined {
    return this.pty?.detach?.()
  }
}

/**
 * Starts `launch` in a pty from `mod`.
 *
 * **Windows (#849): on the ConPTY node-pty ships (`useConptyDll`), not the one in Windows** (`usesShippedConpty`). With
 * Windows' own, every tab and every command left a `conhost.exe` (~7 MB) running until the host exited: node-pty forgets
 * the pseudoconsole once its shell has ended, so nothing ever closes it, and the tree kill ends the shell before
 * node-pty's own kill could (measured on Windows 11). The shipped one (`conpty/OpenConsole.exe`) ends with its shell,
 * and node-pty's kill of it goes through the process handle instead of a pid listed from the console (#857). A host
 * whose bundle lacks `conpty.dll` falls back to Windows' own, with a line on stderr, rather than leave every terminal
 * dead.
 */
export function spawnPty(mod: PtyModule, launch: ShellLaunch, opts: Record<string, unknown>, shipped: boolean = usesShippedConpty()): Pty {
  if (!shipped) return mod.spawn(launch.file, launch.args, opts)
  try {
    return mod.spawn(launch.file, launch.args, { ...opts, useConptyDll: true })
  } catch (err) {
    // Only a missing or unloadable DLL: any other failure would fail the same way again
    if (!/conpty\.dll/i.test(errorMessage(err))) throw err
    console.error(`[pty] ${errorMessage(err)}; using the console of Windows instead`)
    return mod.spawn(launch.file, launch.args, opts)
  }
}

/** node-pty's Windows pty agent, as far as `releaseEnded` reaches into it (node-pty 1.1.0, lib/windowsPtyAgent.js) */
type WindowsPtyAgent = {
  _inSocket?: { destroy?: () => void }
  _outSocket?: { destroy?: () => void }
  _conoutSocketWorker?: { _worker?: { terminate?: () => Promise<number> } }
}

/** The agent a Windows pty holds, if it holds an object there; every part of it is checked again where it is used */
function windowsAgentOf(handle: Pty): WindowsPtyAgent | undefined {
  const agent: unknown = Reflect.get(handle, '_agent')
  return isObj(agent) ? agent : undefined
}

let warnedInternals = false

/**
 * Lets go of what node-pty keeps for a Windows pty whose shell has ended (#849): node-pty does not.
 *
 * On Windows node-pty 1.1.0 holds, per pty, the input pipe (`_inSocket`), the output socket and a worker thread that
 * copies the console's output to it (`_conoutSocketWorker`). Its exit handler frees none of them with the ConPTY it
 * ships (`useConptyDll`), and its `kill()` ends the worker only after one more output event, which never comes once
 * the pty has ended. Measured on Windows 11 with real ptys, 20 per round: every one that had ended kept a thread, 17
 * handles and 21 MB of private memory in the host until it exited. Destroying both sockets and terminating the worker
 * here brings that back to the baseline.
 *
 * These are node-pty's private fields, so each is checked before it is touched. A pty that has none (macOS and Linux,
 * the keeper's, a test's) is left alone; one that looks like node-pty's Windows pty but lacks them says so once on
 * stderr, and is left as node-pty leaves it: never a throw on the way out of a terminal.
 */
export function releaseEnded(handle: Pty): void {
  const agent = windowsAgentOf(handle)
  if (!agent) {
    if (handle.constructor?.name === 'WindowsTerminal') warnInternals('no _agent')
    return
  }
  const worker = agent._conoutSocketWorker?._worker
  const missing = [
    typeof agent._inSocket?.destroy !== 'function' && '_inSocket',
    typeof agent._outSocket?.destroy !== 'function' && '_outSocket',
    typeof worker?.terminate !== 'function' && '_conoutSocketWorker._worker',
  ].filter(Boolean)
  if (missing.length > 0) warnInternals(`no ${missing.join(', ')}`)
  try {
    agent._inSocket?.destroy?.()
    agent._outSocket?.destroy?.()
    void worker?.terminate?.().catch(() => {})
  } catch (err) {
    warnInternals(errorMessage(err))
  }
}

function warnInternals(what: string): void {
  if (warnedInternals) return
  warnedInternals = true
  console.error(`[pty] node-pty's Windows pty is not shaped as expected (${what}): an ended terminal may keep a thread and its pipes until the host exits`)
}
