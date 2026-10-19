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

/*
 * SIGHUP too: a terminal that closes sends it, often right after the SIGINT of a Ctrl+C, and with no
 * listener its default ends the host on the spot, without the shutdown (HO5).
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
type Signal = (typeof SIGNALS)[number]

/**
 * How long after a signal another one is still the same request delivered twice, not a person
 * asking again (owner's decision on #504, 2026-10-12). One request often arrives as two: the npm
 * launcher forwards the Ctrl+C that the terminal also delivered to the host directly, and a closing
 * terminal sends SIGHUP right after SIGINT. Only a signal later than this forces the exit.
 */
export const REPEAT_AFTER_MS = 1000

/** Whether a signal at `now` is a deliberate repeat of one at `first`, rather than the same one delivered twice */
function deliberateRepeat(first: number, now: number): boolean {
  return now - first >= REPEAT_AFTER_MS
}

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
 * that hangs can still be stopped from the terminal; one within `REPEAT_AFTER_MS` of the first is the
 * same request delivered twice and changes nothing.
 *
 * No handler here or anywhere else ends the process on its own (HO5): handlers run in the order
 * they were added, and an early `process.exit` in one used to mean the real shutdown never ran.
 */
export function holdSignals(
  proc: ProcessLike,
  log: (line: string) => void,
  now: () => number = Date.now,
): { act(onSignal: () => void): void } {
  let pending: Signal | null = null
  let pendingAt = 0
  const hold = (sig: Signal) => {
    if (pending) {
      // A later one while still starting is someone insisting on a start that hangs: obey it
      if (deliberateRepeat(pendingAt, now())) return proc.exit(1)
      return
    }
    pending = sig
    pendingAt = now()
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
 * - the keeper's `stop` on the child service, and `host.stop` (`centralu serve --stop`): a stop. The keeper's is the
 *   person quitting Centralu here, said first through `quit` (#1143: a linked hub then starts no host here by itself).
 *   `host.stop` is not: `serve --stop` remembers the person's stop itself, and a hub's update stops through it too.
 */
export function wireEndings(o: {
  proc: ProcessLike
  signals: { act(onSignal: () => void): void }
  heldChildren: boolean
  leave: (mode: LeaveMode, handOver: boolean) => void
  /** Exit now, without finishing the shutdown */
  force: (why: string) => void
  record: (kind: string, err: unknown) => void
  stdin: Stdin
  watchParent: boolean
  log: (line: string) => void
  now?: () => number
  /** The keeper stops this host for good: the person quit Centralu here (lifecycle/stopped-mark.ts `markQuit`) */
  quit?: () => void
}): { stopAsked: () => void; keeperStop: () => void } {
  const mode = signalMode(o.heldChildren)
  guardErrors(o.proc, { record: o.record, onCrash: () => o.leave(mode, false) })
  /*
   * A second signal while leaving is someone insisting (a second Ctrl+C on `centralu serve`): the
   * host exits at once rather than run a second, different ending. Not one within `REPEAT_AFTER_MS`
   * of the first: that is the same request delivered twice (the launcher's forward and the
   * terminal's own, or SIGHUP right after SIGINT), and forcing on it would skip the shutdown it asked
   * for. Under the keeper a second TERM is its group TERM after the grace, followed by SIGKILL anyway.
   */
  let signalledAt: number | null = null
  const now = o.now ?? Date.now
  o.signals.act(() => {
    if (signalledAt !== null) {
      if (deliberateRepeat(signalledAt, now())) o.force('asked again while shutting down')
      return
    }
    signalledAt = now()
    o.leave(mode, mode === 'detach')
  })
  watchParent(o.watchParent, o.stdin, () => {
    o.log('[agent-host] parent process exited; shutting down')
    o.leave(mode, false)
  })
  return {
    stopAsked: () => o.leave('stop', false),
    // No next host to hand the views to
    keeperStop: () => {
      o.quit?.()
      o.leave('stop', false)
    },
  }
}
