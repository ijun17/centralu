import type { NormalizedEvent } from '@cc/protocol'
import type { AppCaller, AppRef } from './apps/external/runtime.js'

type AppChanged = Extract<NormalizedEvent, { type: 'external_app_state_changed' }>

/**
 * The window that collects one app's "changed" notifications into one at its end, so one app's broadcast cannot exceed 4 per
 * second; the view that made the change sees the result at once, as the call's answer
 */
export const APP_CHANGE_WINDOW_MS = 250

/**
 * The external app "changed" broadcast: collects the runtime's `emitChanged` per app and emits `external_app_state_changed`.
 * The last line of defense against a loop: an open view that hears a notification calls the tool again, and if that fires
 * another it loops (measured, 65acb43: a template view called `show` about 700 times a second, 2035 run-record lines in 3 s). A
 * read-only tool does not notify (runtime) and a view does not hear its own change (AppFrame), but an app that left the
 * annotation off a read tool lets two views volley. It lives in the host because the flood starts here, and at 700 a second the
 * 2000-slot event log would push out a session's events in 3 s, so a reconnecting UI would reload everything. The `cause` is
 * kept only when every notification in the window shares it; mixed, a view could mistake someone else's change for its own and
 * show a stale value. main.ts and the tests share it
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
 * The broadcast that an app's run record changed: collects `emitRunsChanged` per app through the same window and emits
 * `external_app_runs_changed`; no view wakes, only the run panel listens, and the same 4 per second bound keeps the event log
 * from being pushed out
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
