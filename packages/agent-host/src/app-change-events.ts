import type { NormalizedEvent } from '@cc/protocol'
import type { AppCaller, AppRef } from './apps/external/runtime.js'

type AppChanged = Extract<NormalizedEvent, { type: 'external_app_state_changed' }>

/**
 * The window that collects one app's "changed" notifications. Notifications that arrive within
 * the window go out as one, at the end of the window — so one app's broadcast can never exceed 4
 * per second. To a person this looks like an update lagging by a beat, while the view that made
 * the change itself sees the result immediately, as the call's answer.
 */
export const APP_CHANGE_WINDOW_MS = 250

/**
 * The external app "changed" broadcast (M4 B-5) — collects the runtime's `emitChanged` per app
 * and emits `external_app_state_changed`.
 *
 * **This is the last line of defense.** An open view that receives a notification calls the app's
 * tool again, and if that call fires another notification, it becomes a loop. Measured (65acb43):
 * a single template view called `show` about 700 times per second (2035 run-record lines in 3
 * seconds). The loop is meant to be broken earlier, by two prior layers — a read-only tool does
 * not notify (the runtime), and a view does not hear the change it caused itself (AppFrame). But
 * for an app that left the annotation off a read tool, two views of the same app (the fixed view
 * and a view not in a conversation) can hear each other's re-reads and volley back and forth. When
 * collected here, that volley also cannot exceed 4 per second for one app.
 *
 * Why this lives in the host rather than the UI store: this is where the flood originates. Stopping
 * it here protects every window, every view, and the run panel (RunsPanel re-reads the record on
 * every signal) all at once. And the broadcast accumulates in the host's event log (a 2000-slot
 * ring buffer) — at 700 per second, the session's events would all be pushed out within 3 seconds,
 * so a reconnecting UI could not pick up where it left off and would have to reload everything.
 *
 * While collecting, the cause (`cause`) is kept only when every notification in the window shares
 * the same cause. If they are mixed, it is dropped — if someone mistook a notification mixed with
 * someone else's change for their own and skipped it, that view would show a stale value.
 *
 * main.ts and the tests share this same function (the same arrangement as `app-list-events.ts`).
 * The seam the tests run through is the same seam the host uses.
 */
export function broadcastAppChanges(send: (e: AppChanged) => void, windowMs = APP_CHANGE_WINDOW_MS) {
  const pending = new Map<string, { ref: AppRef; cause: AppCaller | null; timer: NodeJS.Timeout }>()
  return {
    emit(ref: AppRef, cause: AppCaller | null = null): void {
      const key = JSON.stringify([ref.projectId, ref.appId])
      const open = pending.get(key)
      if (open) {
        if (!sameCause(open.cause, cause)) open.cause = null
        return
      }
      const timer = setTimeout(() => {
        const w = pending.get(key)
        pending.delete(key)
        if (w) send({ type: 'external_app_state_changed', appId: w.ref.appId, projectId: w.ref.projectId, ...(w.cause ? { cause: w.cause } : {}) })
      }, windowMs)
      timer.unref()
      pending.set(key, { ref, cause, timer })
    },
    dispose(): void {
      for (const w of pending.values()) clearTimeout(w.timer)
      pending.clear()
    },
  }
}

type AppRunsChanged = Extract<NormalizedEvent, { type: 'external_app_runs_changed' }>

/**
 * The broadcast that an external app's run record changed (M4 D-6) — collects the runtime's
 * `emitRunsChanged` per app through the same window and emits `external_app_runs_changed`. A
 * signal that does not wake any view: only the run panel listens. The reason for collecting it is
 * the same as above — even with a view calling dozens of times per second, one app's broadcast
 * stays at 4 per second, and it does not push the host's event log (ring buffer) out.
 */
export function broadcastAppRuns(send: (e: AppRunsChanged) => void, windowMs = APP_CHANGE_WINDOW_MS) {
  const pending = new Map<string, NodeJS.Timeout>()
  return {
    emit(ref: AppRef): void {
      const key = JSON.stringify([ref.projectId, ref.appId])
      if (pending.has(key)) return
      const timer = setTimeout(() => {
        pending.delete(key)
        send({ type: 'external_app_runs_changed', appId: ref.appId, projectId: ref.projectId })
      }, windowMs)
      timer.unref()
      pending.set(key, timer)
    },
    dispose(): void {
      for (const t of pending.values()) clearTimeout(t)
      pending.clear()
    },
  }
}

const sameCause = (a: AppCaller | null, b: AppCaller | null): boolean => a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b)
