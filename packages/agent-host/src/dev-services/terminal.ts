import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { ensureToolPath, whichTool } from '../env-path.js'
import { KILL_GRACE_MS, killTree, stopTree } from './kill-tree.js'
import { idNumber, type TerminalTag } from '../keeper/tags.js'

/**
 * The project terminal (M2.7).
 *
 * **A terminal's identity is its cwd.** Not the session.
 *   - Switching sessions within the same project keeps the same terminal going (a requirement)
 *   - When a git worktree session eventually exists, it has a different cwd and so automatically
 *     gets its own terminal (one rule satisfies both, with no separate branch needed)
 *
 * Restoring the screen is the **host's own scrollback's** job. Whether the UI moves a tab or the
 * window is closed and reopened, reattaching receives the whole output so far — a terminal that
 * got reset on reattach would be useless.
 */

const require = createRequire(import.meta.url)

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
export type PtyModule = {
  spawn(file: string, args: string[] | string, opts: Record<string, unknown>): Pty
}

/** A terminal a previous host left running in the keeper, to be taken over at startup */
export type KeptTerminal = { id: string; cwd: string; pty: Pty; cols: number; rows: number }

/**
 * The scrollback cap. Once exceeded, the oldest part is dropped.
 * A single build log commonly reaches tens of MB, and holding all of it would fill the host's
 * memory with logs instead of conversation.
 */
const SCROLLBACK_BYTES = 256 * 1024

export type TerminalHandle = {
  id: string
  cwd: string
  /** The name shown on screen (Terminal 1, Terminal 2…) */
  title: string
  history(): string
  alive: boolean
}

type Entry = {
  id: string
  cwd: string
  title: string
  pty: Pty | null
  buffer: string
  cols: number
  rows: number
}

export type TerminalSink = (e: { terminalId: string; data?: string; exitCode?: number | null }) => void

export class TerminalService {
  /** One directory can have several terminals. Their order is the order they stack on screen */
  private byCwd = new Map<string, Entry[]>()
  private byId = new Map<string, Entry>()
  private counter = 0

  constructor(
    private emit: TerminalSink,
    /** Where ptys come from. Absent: node-pty, with the master in this host */
    private ptys?: PtyModule,
  ) {}

  /**
   * Takes over the terminals a previous host left running in the keeper (#280 step 2). Each keeps its
   * id, so a screen that still shows it finds it again, and the keeper replays its last output, which
   * becomes the scrollback here. New ids continue after the highest one taken over.
   */
  adopt(kept: readonly KeptTerminal[]): void {
    const sorted = [...kept].sort((a, b) => idNumber(a.id) - idNumber(b.id))
    for (const k of sorted) {
      if (this.byId.has(k.id)) continue
      const siblings = this.byCwd.get(k.cwd) ?? []
      const entry: Entry = { id: k.id, cwd: k.cwd, title: `Terminal ${siblings.length + 1}`, pty: null, buffer: '', cols: k.cols, rows: k.rows }
      siblings.push(entry)
      this.byCwd.set(k.cwd, siblings)
      this.byId.set(entry.id, entry)
      this.counter = Math.max(this.counter, idNumber(k.id))
      this.wire(entry, k.pty)
    }
  }

  /**
   * The host is leaving and the keeper keeps the shells (#280 step 2): let go of every pty without
   * signalling anything. The next host takes them over with `adopt`.
   */
  async detachAll(): Promise<void> {
    await Promise.allSettled([...this.byId.values()].map((e) => e.pty?.detach?.()))
    this.byCwd.clear()
    this.byId.clear()
  }

  /** That directory's terminal list. Switching sessions leaves this list untouched */
  list(cwd: string): TerminalHandle[] {
    return (this.byCwd.get(cwd) ?? []).map((e) => this.toHandle(e))
  }

  /** Opens one more terminal */
  create(cwd: string, cols: number, rows: number): TerminalHandle {
    const siblings = this.byCwd.get(cwd) ?? []
    const entry: Entry = {
      id: `term-${++this.counter}`,
      cwd,
      // Numbered by position — deleting and recreating still continues 1, 2, 3
      title: `Terminal ${siblings.length + 1}`,
      pty: null,
      buffer: '',
      cols,
      rows,
    }
    siblings.push(entry)
    this.byCwd.set(cwd, siblings)
    this.byId.set(entry.id, entry)
    this.start(entry, cols, rows)
    return this.toHandle(entry)
  }

  /** Closes one terminal (kills the shell and discards its history) */
  close(terminalId: string): void {
    const e = this.byId.get(terminalId)
    if (!e) return
    /*
     * The whole tree, as Stop and restart do. A hang-up to the shell alone ended the shell, but a dev
     * server started from it is in a group of its own (job control) and one that ignores HUP was left
     * running with its port. The tree is taken while the shell is still there (once it has gone, its
     * children are no longer under it); then the shell gets the hang-up a closing terminal sends, which
     * an interactive shell ends on (it ignores TERM).
     */
    const handle = e.pty
    if (handle) {
      stopTree(handle, KILL_GRACE_MS, () => e.pty === handle)
      if (process.platform !== 'win32') {
        try {
          handle.kill()
        } catch {
          // already gone
        }
      }
    }
    this.byId.delete(terminalId)
    const siblings = (this.byCwd.get(e.cwd) ?? []).filter((x) => x.id !== terminalId)
    if (siblings.length === 0) this.byCwd.delete(e.cwd)
    else {
      // Renumbers the rest — deleting number 2 and leaving 1 and 3 would confuse anyone counting
      siblings.forEach((x, i) => (x.title = `Terminal ${i + 1}`))
      this.byCwd.set(e.cwd, siblings)
    }
  }

  input(terminalId: string, data: string): void {
    this.byId.get(terminalId)?.pty?.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const e = this.byId.get(terminalId)
    if (e) this.doResize(e, cols, rows)
  }

  /** Relaunches only the shell when it goes unresponsive. The history is kept — it is the clue to what led to this */
  restart(terminalId: string, cols: number, rows: number): TerminalHandle | null {
    const e = this.byId.get(terminalId)
    if (!e) return null
    // Killing only the shell leaves whatever is running under it behind — kill it as a whole tree
    // (kill-tree.ts). This handle is being discarded here, so once the grace period passes it is
    // an unconditional SIGKILL.
    if (e.pty) stopTree(e.pty, KILL_GRACE_MS, () => true)
    e.pty = null
    this.append(e, '\r\n[2m— shell restarted —[0m\r\n')
    this.start(e, cols, rows)
    return this.toHandle(e)
  }

  /**
   * Closes every terminal in a directory when its project is removed (#177). The history is
   * discarded too — re-adding the same folder must never bring back a terminal from before
   * deletion.
   *
   * Ends by the same rule as the Stop button: SIGTERM to the tree, then SIGKILL to whatever
   * survives the grace period. This gives a dev server room to release its port and lock file on
   * its own. Unlike an app shutdown (disposeAll), the host is still alive here, so there is time to
   * fire the second shot.
   */
  closeCwd(cwd: string): void {
    for (const e of this.byCwd.get(cwd) ?? []) {
      const handle = e.pty
      if (handle) stopTree(handle, KILL_GRACE_MS, () => e.pty === handle)
      this.byId.delete(e.id)
    }
    this.byCwd.delete(cwd)
  }

  /**
   * The app shuts down. **SIGKILL to the whole tree** — there is no process left to wait out a
   * grace period for.
   *
   * This used to be `pty.kill()`: SIGHUP to one shell pid. A dev server launched from an
   * interactive shell gets its own process group, and a server that handles HUP itself survived
   * unchanged — the exact symptom of a port still held after the app was closed (measured
   * 2026-09-07).
   */
  /** Open terminals with a live shell — counted by the keeper's idle rule (#280, keeper-link.ts) */
  liveCount(): number {
    let n = 0
    for (const e of this.byId.values()) if (e.pty) n++
    return n
  }

  disposeAll(): void {
    for (const e of this.byId.values()) if (e.pty) killTree(e.pty, 'SIGKILL')
    this.byCwd.clear()
    this.byId.clear()
  }

  /**
   * Loads the native PTY module.
   * Kept as a method so a test can substitute it — launching a real shell would leave a test
   * at the mercy of the environment (shell configuration, login scripts), blurring what is
   * actually being verified.
   */
  protected loadPty(): PtyModule {
    return this.ptys ?? (require('node-pty') as PtyModule)
  }

  private toHandle(e: Entry): TerminalHandle {
    return { id: e.id, cwd: e.cwd, title: e.title, history: () => e.buffer, alive: !!e.pty }
  }

  private doResize(e: Entry, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    e.cols = cols
    e.rows = rows
    try {
      e.pty?.resize(cols, rows)
    } catch {
      // it may be in the process of dying — a resize failure is no reason to lose the terminal
    }
  }

  private start(e: Entry, cols: number, rows: number): void {
    e.cols = cols
    e.rows = rows

    let pty: PtyModule
    try {
      pty = this.loadPty()
    } catch (err) {
      this.append(e, `\r\n[2mCould not open terminal: ${(err as Error).message}[0m\r\n`)
      return
    }

    // A GUI app never inherits the login shell's PATH (a problem already run into when creating a session)
    ensureToolPath()

    try {
      const shell = interactiveShell()
      const handle = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: e.cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        // What the next host needs to take this terminal over from the keeper (ignored by node-pty)
        tag: { kind: 'terminal', id: e.id, cwd: e.cwd } satisfies TerminalTag,
      })
      this.wire(e, handle)
    } catch (err) {
      // this never fails silently — an empty black screen with no message leaves no way to know the cause
      const msg = `\r\n[2mCould not start shell: ${(err as Error).message}[0m\r\n`
      this.append(e, msg)
      this.emit({ terminalId: e.id, data: msg })
      this.emit({ terminalId: e.id, exitCode: null })
    }
  }

  private wire(e: Entry, handle: Pty): void {
    e.pty = handle
    handle.onData((data) => {
      // The last output the old shell spits out after a restart is discarded — it must never mix into the new shell's screen
      if (e.pty !== handle) return
      this.append(e, data)
      this.emit({ terminalId: e.id, data })
    })
    handle.onExit(({ exitCode }) => {
      /*
       * **This clears the slot only when it is still that slot's owner.**
       *
       * When restart() kills the old pty, its onExit arrives late — **after** the new pty has
       * already taken the slot. Unconditionally setting e.pty = null would mark the just-launched
       * new shell as dead, turning restart into a button that kills the terminal forever.
       */
      if (e.pty !== handle) return
      e.pty = null
      this.emit({ terminalId: e.id, exitCode: exitCode ?? null })
    })
  }

  private append(e: Entry, data: string): void {
    e.buffer += data
    if (e.buffer.length > SCROLLBACK_BYTES) {
      e.buffer = e.buffer.slice(e.buffer.length - SCROLLBACK_BYTES)
    }
  }
}

/** A program and its arguments, as node-pty takes them. A string is a ready-made Windows command line, passed verbatim */
export type ShellLaunch = { file: string; args: string[] | string }

type ShellEnv = Record<string, string | undefined>

function systemFolder(env: ShellEnv): string {
  return win32.join(env.SystemRoot || 'C:\\Windows', 'System32')
}

/**
 * The shell a terminal tab runs.
 *
 * On macOS and Linux, the person's login shell with `-l`, so their PATH, aliases and prompt are
 * there. **Windows (#14)** has no login shell: PowerShell 7 (`pwsh`) when it is installed, else
 * the Windows PowerShell every Windows ships. Never with `-l` — Windows PowerShell 5.1 has no such
 * parameter, takes the first unknown argument as the start of `-Command`, runs `-l`, fails and
 * exits, so the tab died at once.
 */
export function interactiveShell(
  platform: NodeJS.Platform = process.platform,
  env: ShellEnv = process.env,
  find: (name: string) => string | null = (name) => whichTool(name),
): ShellLaunch {
  if (platform !== 'win32') return { file: shellPath(), args: ['-l'] }
  const pwsh = find('pwsh')
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] }
  return { file: win32.join(systemFolder(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] }
}

/**
 * How a project command (the Run button) runs.
 *
 * macOS and Linux: the login shell with `-lc`. **Windows (#14)**: `cmd.exe /d /s /c "<command>"`,
 * which is what npm runs package scripts with and what Node's `shell: true` does. Not PowerShell:
 * there `npm` resolves to `npm.ps1` first, which the default execution policy refuses to run, and
 * `powershell -lc` did not run the command at all (the same `-l` parse as above). `/d` skips the
 * AutoRun registry hook; `/s` makes cmd strip exactly the outer quotes and run the rest as typed.
 * The command line is handed to node-pty as a string so nothing re-quotes it.
 */
export function commandShell(command: string, platform: NodeJS.Platform = process.platform, env: ShellEnv = process.env): ShellLaunch {
  if (platform !== 'win32') return { file: shellPath(), args: ['-lc', command] }
  return { file: env.ComSpec || win32.join(systemFolder(env), 'cmd.exe'), args: `/d /s /c "${command}"` }
}

/** The shell the user normally uses (macOS and Linux). This is what keeps their aliases and prompt showing up as-is */
export function shellPath(): string {
  const fromEnv = process.env.SHELL
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
}

/** Home directory notation — for the fallback display when there is no prompt */
export function shortCwd(cwd: string): string {
  const home = homedir()
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}
