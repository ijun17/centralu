import type { EventSink } from '../contract.js'

/** The ceiling for a background resume — the same value as the manager's step limit (150s). Past this, it is considered stuck */
const BACKGROUND_RESUME_CAP_MS = 150_000

/** What the watchdog uses of the session it belongs to */
export type ResumeWatchHost = {
  readonly sessionId: string
  emit: EventSink
  closed(): boolean
  /** The thread came up */
  ready: Promise<void>
  /** The messages sent meanwhile, as a note for the error (`CodexSession.unsentNote`) */
  unsentNote(): string
  dispose(): Promise<void>
}

/**
 * The watchdog for a background resume (lazy resume only). If resume fails or exceeds the
 * ceiling after the handle has already been handed out, we cannot just go quietly to sleep — we
 * raise adapter_crashed so the manager retires the handle and the "resend if missing" automatic
 * recovery path can kick in.
 */
export function watchBackgroundResume(host: ResumeWatchHost): void {
  const timer = setTimeout(() => {
    if (host.closed()) return
    host.emit({
      type: 'error',
      sessionId: host.sessionId,
      error: {
        code: 'adapter_crashed',
        message: `Resuming codex did not finish within ${BACKGROUND_RESUME_CAP_MS / 1000}s${host.unsentNote()}`,
        retryable: true,
      },
    })
    void host.dispose().catch(() => {})
  }, BACKGROUND_RESUME_CAP_MS)
  host.ready.then(
    () => clearTimeout(timer),
    (e: Error & { code?: string }) => {
      clearTimeout(timer)
      if (host.closed()) return
      /*
       * A lock error keeps its code (#168, item 5). Arriving here instead of inside the 3-second
       * window used to turn it into adapter_crashed, so the screen could not offer "continue in
       * a fork". Measured on 0.153.4: a second app-server resuming a held thread is refused with
       * -32600 "thread <id> already has an active writer" in 35 ms to 1.3 s, so this is rare,
       * but a slow start can push it past the window.
       *
       * Messages sent meanwhile were never delivered (send stays quiet about them, so the
       * failure is said once): the person is told, since the screen shows them as sent.
       */
      const note = host.unsentNote()
      const locked = e.code === 'conversation_locked'
      host.emit({
        type: 'error',
        sessionId: host.sessionId,
        error: { code: locked ? 'conversation_locked' : 'adapter_crashed', message: e.message + note, retryable: true },
      })
      void host.dispose().catch(() => {})
    },
  )
}
