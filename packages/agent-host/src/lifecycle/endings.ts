import { appendFileSync } from 'node:fs'
import { MAX_LOG_BYTES, rotateIfLarge } from '../log-file.js'

/**
 * Every way the host process can be asked to end, and what each means (lessons HO5–HO7, HO10, HO15). The process is a
 * parameter: a test hands in an emitter
 */

type Listener = (...args: unknown[]) => void
export type ProcessLike = {
  on(event: string, listener: Listener): unknown
  off(event: string, listener: Listener): unknown
  exit(code: number): void
}

export type Stdin = {
  /** Set once the stream has been read to its end, and once it is closed: an `end` / `close` that came before a listener is not replayed */
  readonly readableEnded?: boolean
  readonly destroyed?: boolean
  resume(): unknown
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown
}

/*
 * SIGHUP too: a closing terminal sends it, often right after Ctrl+C's SIGINT, and with no listener its default ends the host on
 * the spot, without the shutdown (HO5)
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
type Signal = (typeof SIGNALS)[number]

/**
 * How long after a signal another is still the same request delivered twice (owner's decision on #504): the npm launcher
 * forwards the Ctrl+C the terminal also delivered, and a closing terminal sends SIGHUP right after SIGINT. Only a later one
 * forces the exit
 */
export const REPEAT_AFTER_MS = 1000

/** Whether a signal at `now` is a deliberate repeat of one at `first`, rather than the same one delivered twice */
function deliberateRepeat(first: number, now: number): boolean {
  return now - first >= REPEAT_AFTER_MS
}

/**
 * A signal before the shutdown exists is held, not obeyed (HO6): until a process has a listener the default ends it on the
 * spot, with no shutdown or WAL checkpoint, and the ready line goes out well before the real handlers (a Ctrl+C passed on as
 * soon as `centralu serve` read the ready line killed the host every time; 3 s later it shut down cleanly). Installed right
 * after the lock is taken; these only record the signal and `act` replaces them. **A second signal while still starting exits
 * at once with 1**, so a start that hangs can be stopped; one within `REPEAT_AFTER_MS` is the same request twice. No handler
 * ends the process on its own (HO5): handlers run in the order added, so an early `process.exit` would skip the real shutdown.
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
 * The host ends when its parent's pipe closes, only with `--watch-parent` (HO7): a supervisor keeps stdin open as a pipe, so
 * whatever the parent dies of the pipe closes (an exit hook alone left an orphaned host holding its port); a host from another
 * script has stdin on `/dev/null`, where EOF arrives at once, so "is stdin a TTY" cannot decide. The only parent-death signal
 * on Windows. The listeners are attached at the end of start-up, and a pipe's end is read even while paused, so a parent that
 * went before has already closed it and no event comes: a stream already ended or closed is the parent gone at once
 */
export function watchParent(enabled: boolean, stdin: Stdin, onGone: () => void): void {
  if (!enabled) return
  if (stdin.readableEnded || stdin.destroyed) return onGone()
  stdin.resume()
  stdin.on('end', onGone)
  stdin.on('close', onGone)
  stdin.on('error', onGone)
}

/**
 * Rejections are survived; uncaught exceptions end the host through its shutdown (HO10). Node ends the process on an unhandled
 * rejection, and this host is the parent of every session: one leaking rejection would cut off every unrelated session, with no
 * stderr in the packaged app to say why. A rejection is usually one request's problem, so it is logged loudly and survived;
 * after an uncaught exception state may be broken, so it is logged and the host leaves the normal way
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
 * Writes what `guardErrors` caught to stderr (host.log) and to `host-errors.log`, which keeps one previous generation like
 * host.log (HO4): it grew by hundreds of MB on a day of repeating rejections. A failure to write is never thrown again
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
 * Every ending, wired to the one shutdown (HO15). A signal, a crash and the parent going away are a stop, and nothing is handed
 * over: the host owns its children and stops them, and a crash or a vanished parent hands no open app views over (nothing is
 * known to start a next host, and the state that threw is not one to carry forward). `host.stop` (`serve --stop`) is a stop
 * too: `serve --stop` remembers the person's stop itself, and a hub's update stops through it.
 */
export function wireEndings(o: {
  proc: ProcessLike
  signals: { act(onSignal: () => void): void }
  leave: () => void
  /** Exit now, without finishing the shutdown */
  force: (why: string) => void
  record: (kind: string, err: unknown) => void
  stdin: Stdin
  watchParent: boolean
  log: (line: string) => void
  now?: () => number
}): { stopAsked: () => void } {
  guardErrors(o.proc, { record: o.record, onCrash: () => o.leave() })
  /*
   * A second signal while leaving is someone insisting (a second Ctrl+C on `centralu serve`): the host exits at once rather
   * than run a second ending. Not one within `REPEAT_AFTER_MS` of the first (the same request delivered twice): forcing on it
   * would skip the shutdown it asked for. Under the keeper a second TERM is its group TERM after the grace, followed by SIGKILL
   * anyway
   */
  let signalledAt: number | null = null
  const now = o.now ?? Date.now
  o.signals.act(() => {
    if (signalledAt !== null) {
      if (deliberateRepeat(signalledAt, now())) o.force('asked again while shutting down')
      return
    }
    signalledAt = now()
    o.leave()
  })
  watchParent(o.watchParent, o.stdin, () => {
    o.log('[agent-host] parent process exited; shutting down')
    o.leave()
  })
  return {
    stopAsked: () => o.leave(),
  }
}
