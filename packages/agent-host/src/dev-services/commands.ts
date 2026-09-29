import { createRequire } from 'node:module'
import { ensureToolPath } from '../env-path.js'
import { shellPath } from './terminal.js'
import { KILL_GRACE_MS, killTree, stopTree } from './kill-tree.js'

/**
 * The runner for frequently used commands (#60).
 *
 * **Separate from a terminal tab.** This used to type a saved command into the first terminal's
 * PTY, which meant a one-shot build and a long-running dev server both ended up parked in a
 * terminal tab. Here, every command launches its own process and gets its own log for output —
 * there is no need to tell one-shot apart from long-running: if it does not end, output keeps
 * streaming, and once it ends, a log with an exit code is what is left.
 *
 * The owner's decisions (2026-08-26):
 *   - the log only lasts while the host is alive (one, the most recent run per command)
 *   - running the same command again kills the old one and starts fresh
 *   - different commands are allowed to run at the same time (one process per command)
 *
 * Output rides the **same frame lane** as a terminal (pushTerminal — runId takes terminalId's
 * place). The reason this does not also go through the event log (the seq ring buffer) is the
 * same as for a terminal: the volume of output is a different order of magnitude.
 */

const require = createRequire(import.meta.url)

type Pty = {
  /** The child pid node-pty gave us — the target for a group kill. A pty child is the leader of a new session, so pgid == pid */
  pid?: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): Pty }

/** The same cap as a terminal — a single build log commonly reaches tens of MB */
const LOG_BYTES = 256 * 1024

export type CommandRun = {
  command: string
  /** A new id per run — what the screen uses to switch which stream it follows */
  runId: string
  running: boolean
  exitCode: number | null
  startedAt: number
  history: string
}

type Entry = {
  cwd: string
  command: string
  runId: string
  pty: Pty | null
  buffer: string
  exitCode: number | null
  startedAt: number
}

export type CommandSink = (e: { terminalId: string; data?: string; exitCode?: number | null }) => void

export class CommandRunner {
  /** One, the most recent run, per (cwd, command) */
  private entries = new Map<string, Entry>()
  private counter = 0

  constructor(private emit: CommandSink) {}

  private key(cwd: string, command: string): string {
    return `${cwd}\u0000${command}`
  }

  /**
   * Politely, with SIGTERM; if it has not died within the grace period, SIGKILL.
   *
   * How the tree is found lives in kill-tree.ts — terminal tabs have the same problem, so it is
   * solved in one place. Once onExit arrives, e.pty clears, and the second shot excludes the shell
   * itself (a reaped number) and fires only at **the surviving descendants** (#149).
   */
  private stopEntry(e: Entry): void {
    const handle = e.pty
    if (!handle) return
    stopTree(handle, KILL_GRACE_MS, () => e.pty === handle)
  }

  /** Runs the command. If the same command is already running, kills it and starts fresh (the owner's decision) */
  run(cwd: string, command: string, cols = 100, rows = 30): CommandRun {
    const existing = this.entries.get(this.key(cwd, command))
    if (existing) this.stopEntry(existing)

    const entry: Entry = {
      cwd,
      command,
      runId: `run-${++this.counter}`,
      pty: null,
      buffer: '',
      exitCode: null,
      startedAt: Date.now(),
    }
    this.entries.set(this.key(cwd, command), entry)
    this.start(entry, cols, rows)
    return this.toRun(entry)
  }

  /** The other side of the button that turns off a dev server. The log survives — an exit is a result too */
  stop(cwd: string, command: string): void {
    const e = this.entries.get(this.key(cwd, command))
    if (e) this.stopEntry(e)
  }

  /**
   * Stops every run in a directory and forgets it when its project is removed (#177). This is the
   * same tree kill as Stop. History is discarded too, so re-adding the same folder never brings
   * back a pre-deletion run on the list.
   */
  stopCwd(cwd: string): void {
    for (const [key, e] of this.entries) {
      if (e.cwd !== cwd) continue
      this.stopEntry(e)
      this.entries.delete(key)
    }
  }

  /** The state of every command ever run in that directory (for the list's badges — the log is left out) */
  state(cwd: string): Omit<CommandRun, 'history'>[] {
    const out: Omit<CommandRun, 'history'>[] = []
    for (const e of this.entries.values()) {
      if (e.cwd !== cwd) continue
      const { history: _history, ...rest } = this.toRun(e)
      out.push(rest)
    }
    return out
  }

  /** One command's most recent run — log included. null if it was never run */
  log(cwd: string, command: string): CommandRun | null {
    const e = this.entries.get(this.key(cwd, command))
    return e ? this.toRun(e) : null
  }

  resize(cwd: string, command: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    try {
      this.entries.get(this.key(cwd, command))?.pty?.resize(cols, rows)
    } catch {
      // it may be in the process of dying — a resize failure is no reason to lose the run
    }
  }

  disposeAll(): void {
    // the app is shutting down — there is no process left to wait out a grace period for. An orphaned dev server is the worst case, so this goes straight to SIGKILL
    for (const e of this.entries.values()) if (e.pty) killTree(e.pty, 'SIGKILL')
    this.entries.clear()
  }

  /** A test substitutes this (the same reason as terminal.ts) */
  protected loadPty(): PtyModule {
    return require('node-pty') as PtyModule
  }

  private toRun(e: Entry): CommandRun {
    return {
      command: e.command,
      runId: e.runId,
      running: !!e.pty,
      exitCode: e.exitCode,
      startedAt: e.startedAt,
      history: e.buffer,
    }
  }

  private start(e: Entry, cols: number, rows: number): void {
    let pty: PtyModule
    try {
      pty = this.loadPty()
    } catch (err) {
      this.append(e, `Could not run: ${(err as Error).message}\r\n`)
      this.emit({ terminalId: e.runId, exitCode: null })
      return
    }

    // A GUI app never inherits the login shell's PATH (the same precaution as a terminal)
    ensureToolPath()

    try {
      /*
       * Runs through a login shell with -lc: the user's aliases and PATH survive intact. The
       * reason this is a PTY is color — launched over a pipe, most tools print with color turned
       * off, and for a dev server's log, color is what makes it readable.
       */
      const handle = pty.spawn(shellPath(), ['-lc', e.command], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: e.cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      })
      e.pty = handle
      handle.onData((data) => {
        // The old process's last output after a rerun is discarded — it must never mix into the new log
        if (e.pty !== handle) return
        this.append(e, data)
        this.emit({ terminalId: e.runId, data })
      })
      handle.onExit(({ exitCode }) => {
        if (e.pty !== handle) return
        e.pty = null
        e.exitCode = exitCode ?? null
        this.emit({ terminalId: e.runId, exitCode: exitCode ?? null })
      })
    } catch (err) {
      // this never fails silently — an empty log with no message leaves no way to know the cause
      const msg = `Could not run: ${(err as Error).message}\r\n`
      this.append(e, msg)
      this.emit({ terminalId: e.runId, data: msg })
      this.emit({ terminalId: e.runId, exitCode: null })
    }
  }

  private append(e: Entry, data: string): void {
    e.buffer += data
    if (e.buffer.length > LOG_BYTES) e.buffer = e.buffer.slice(e.buffer.length - LOG_BYTES)
  }
}
