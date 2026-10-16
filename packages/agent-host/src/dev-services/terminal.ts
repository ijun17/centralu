import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { whichTool } from '../env-path.js'
import { commandInterpreter, systemTool } from '../os.js'
import { PtySlot, type Pty, type PtyModule, type PtyStreamSink, type ShellLaunch } from './pty-slot.js'
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

export type { Pty, PtyModule } from './pty-slot.js'

/** A terminal a previous host left running in the keeper, to be taken over at startup */
export type KeptTerminal = { id: string; cwd: string; pty: Pty; cols: number; rows: number }

export type TerminalHandle = {
  id: string
  cwd: string
  /** The name shown on screen (Terminal 1, Terminal 2…) */
  title: string
  history(): string
  alive: boolean
}

/** A terminal: its shell's pty and scrollback (`PtySlot`, whose cap is the scrollback's), and what the screen shows */
type Entry = {
  id: string
  cwd: string
  title: string
  slot: PtySlot
  cols: number
  rows: number
}

export type TerminalSink = PtyStreamSink

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
      const entry = this.entry(k.id, k.cwd, `Terminal ${siblings.length + 1}`, k.cols, k.rows)
      siblings.push(entry)
      this.byCwd.set(k.cwd, siblings)
      this.byId.set(entry.id, entry)
      this.counter = Math.max(this.counter, idNumber(k.id))
      entry.slot.wire(k.pty)
    }
  }

  /**
   * The host is leaving and the keeper keeps the shells (#280 step 2): let go of every pty without
   * signalling anything. The next host takes them over with `adopt`.
   */
  async detachAll(): Promise<void> {
    await Promise.allSettled([...this.byId.values()].map((e) => e.slot.detach()))
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
    // Numbered by position — deleting and recreating still continues 1, 2, 3
    const entry = this.entry(`term-${++this.counter}`, cwd, `Terminal ${siblings.length + 1}`, cols, rows)
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
    const handle = e.slot.pty
    if (handle) {
      e.slot.stop()
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
    this.byId.get(terminalId)?.slot.write(data)
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
    // an unconditional SIGKILL (`PtySlot.discard`).
    e.slot.discard()
    e.slot.append('\r\n\x1b[2m— shell restarted —\x1b[0m\r\n')
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
      e.slot.stop()
      this.byId.delete(e.id)
    }
    this.byCwd.delete(cwd)
  }

  /** Open terminals with a live shell — counted by the keeper's idle rule (#280, keeper-link.ts) */
  liveCount(): number {
    let n = 0
    for (const e of this.byId.values()) if (e.slot.alive) n++
    return n
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
  disposeAll(): void {
    for (const e of this.byId.values()) e.slot.kill()
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

  private entry(id: string, cwd: string, title: string, cols: number, rows: number): Entry {
    return { id, cwd, title, slot: new PtySlot(id, this.emit), cols, rows }
  }

  private toHandle(e: Entry): TerminalHandle {
    return { id: e.id, cwd: e.cwd, title: e.title, history: () => e.slot.output, alive: e.slot.alive }
  }

  private doResize(e: Entry, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    e.cols = cols
    e.rows = rows
    e.slot.resize(cols, rows)
  }

  private start(e: Entry, cols: number, rows: number): void {
    e.cols = cols
    e.rows = rows
    e.slot.start(
      () => this.loadPty(),
      () => interactiveShell(),
      { cols, rows, cwd: e.cwd, tag: { kind: 'terminal', id: e.id, cwd: e.cwd } satisfies TerminalTag },
      // this never fails silently — an empty black screen with no message leaves no way to know the cause
      (stage, message) => `\r\n\x1b[2m${stage === 'load' ? 'Could not open terminal' : 'Could not start shell'}: ${message}\x1b[0m\r\n`,
    )
  }
}

export type { ShellLaunch } from './pty-slot.js'

type ShellEnv = Record<string, string | undefined>

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
  return { file: systemTool(['WindowsPowerShell', 'v1.0', 'powershell.exe'], env), args: ['-NoLogo'] }
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
  return { file: commandInterpreter(env), args: `/d /s /c "${command}"` }
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
