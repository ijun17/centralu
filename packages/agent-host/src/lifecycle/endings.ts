import { appendFileSync } from 'node:fs'
import { MAX_LOG_BYTES, rotateIfLarge } from '../log-file.js'
import { signalMode, type LeaveMode } from './shutdown.js'

/**
 * Every way the host process can be asked to end, and what each one means (lessons HO5–HO7,
 * HO10, HO15). The process is a parameter, so a test can hand in an emitter and send it signals.
 */

type Listener = (...args: unknown[]) => void
export type ProcessLike = {
  on(event: string, listener: Listener): unknown
  off(event: string, listener: Listener): unknown
  exit(code: number): void
}

export type Stdin = {
  resume(): unknown
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const
type Signal = (typeof SIGNALS)[number]

/**
 * A signal that arrives before the shutdown exists is held, not obeyed (HO6, #82, #390).
 *
 * Until a process has a listener for SIGINT or SIGTERM the kernel's default applies, which ends it
 * on the spot: no shutdown, no WAL checkpoint, and whatever it had started already left behind. The
 * ready line goes out well before the real handlers are attached (the services start in between),
 * and `centralu serve` measured the gap: a Ctrl+C passed on as soon as the ready line was read
 * killed the host by SIGINT every time, while the same signal 3 s later shut it down cleanly.
 *
 * Installed right after the lock is taken. These only record the signal; `act` replaces them and
 * runs the one that came. **A second signal while still starting exits at once with 1**, so a start
 * that hangs can still be stopped from the terminal.
 *
 * No handler here or anywhere else ends the process on its own (HO5): handlers run in the order
 * they were added, and an early `process.exit` in one used to mean the real shutdown never ran.
 */
export function holdSignals(proc: ProcessLike, log: (line: string) => void): { act(onSignal: () => void): void } {
  let pending: Signal | null = null
  const hold = (sig: Signal) => {
    // A second one while still starting is someone insisting on a start that hangs: obey it
    if (pending) return proc.exit(1)
    pending = sig
    log(`[agent-host] ${sig} while starting; shutting down once started (send it again to stop now)`)
  }
  for (const sig of SIGNALS) proc.on(sig, hold as Listener)
  return {
    act(onSignal) {
      for (const sig of SIGNALS) {
        proc.on(sig, onSignal as Listener)
        proc.off(sig, hold as Listener)
      }
      // One that came while starting: the same ending it would have had, now that there is one
      if (pending) onSignal()
    },
  }
}

/**
 * The host ends when its parent's pipe closes, and only when asked to watch it (HO7).
 *
 * A supervisor keeps the host's stdin open as a pipe, so whatever the parent dies of (a crash,
 * SIGKILL) the pipe closes and EOF arrives; an exit hook alone left an orphaned host holding its
 * port (8cc60ff0). **Only with `--watch-parent`**: a host started by some other script has stdin on
 * `/dev/null`, where EOF arrives at once, and deciding by "is stdin a TTY" made such a host end
 * itself (M1.5 defect 4). On Windows this is the only parent-death signal there is.
 */
export function watchParent(enabled: boolean, stdin: Stdin, onGone: () => void): void {
  if (!enabled) return
  stdin.resume()
  stdin.on('end', onGone)
  stdin.on('close', onGone)
  stdin.on('error', onGone)
}

/**
 * Rejections are survived; uncaught exceptions end the host through its shutdown (HO10).
 *
 * Node ends the process on an unhandled rejection, and this host is the parent of every session:
 * one rejection leaking while a project was added cut off every unrelated session, and the
 * packaged app had no stderr to say why (df8ad446). A rejection is usually one request's problem,
 * so it is logged loudly and survived. After an uncaught exception state may be broken: it is
 * logged, then the host leaves the normal way.
 */
export function guardErrors(
  proc: ProcessLike,
  o: { record: (kind: string, err: unknown) => void; onCrash: () => void },
): void {
  proc.on('unhandledRejection', ((reason: unknown) => o.record('Unhandled rejection', reason)) as Listener)
  proc.on('uncaughtException', ((err: unknown) => {
    o.record('Uncaught exception', err)
    o.onCrash()
  }) as Listener)
}

/**
 * Writes what `guardErrors` caught to stderr (host.log) and to `host-errors.log`, which keeps one
 * previous generation like host.log (HO4): on a day when rejections repeat it grew by hundreds of MB.
 * A failure to write is never thrown again.
 */
export function crashRecorder(
  path: string,
  log: (line: string) => void,
  maxBytes: number = MAX_LOG_BYTES,
): (kind: string, err: unknown) => void {
  return (kind, err) => {
    const detail = (err as Error)?.stack ?? String(err)
    log(`[agent-host] ${kind} ${detail}`)
    try {
      rotateIfLarge(path, maxBytes)
      appendFileSync(path, `[${new Date().toISOString()}] ${kind}: ${detail}\n`)
    } catch {
      // If even the log cannot be written, stderr is the last resort
    }
  }
}

/**
 * Every ending, wired to the one shutdown (HO15).
 *
 * - a signal, a crash and the parent going away: `signalMode`, a detach exactly when the keeper's
 *   child service holds the children. A signal under it is a restart, and the next host takes the
 *   open app views over; a crash or a vanished parent hands nothing over (nothing is known to start
 *   a next host, and the state that threw is not one to carry forward);
 * - the keeper's `stop` on the child service, and `host.stop` (`centralu serve --stop`): a stop.
 */
export function wireEndings(o: {
  proc: ProcessLike
  signals: { act(onSignal: () => void): void }
  heldChildren: boolean
  leave: (mode: LeaveMode, handOver: boolean) => void
  record: (kind: string, err: unknown) => void
  stdin: Stdin
  watchParent: boolean
  log: (line: string) => void
}): { stopAsked: () => void; keeperStop: () => void } {
  const mode = signalMode(o.heldChildren)
  guardErrors(o.proc, { record: o.record, onCrash: () => o.leave(mode, false) })
  o.signals.act(() => o.leave(mode, mode === 'detach'))
  watchParent(o.watchParent, o.stdin, () => {
    o.log('[agent-host] parent process exited; shutting down')
    o.leave(mode, false)
  })
  return {
    stopAsked: () => o.leave('stop', false),
    // No next host to hand the views to
    keeperStop: () => o.leave('stop', false),
  }
}
