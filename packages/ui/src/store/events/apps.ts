import type { NormalizedEvent } from '@cc/protocol'
import type { StoreGet, StoreSet } from '../state.js'
import { externalAppKey } from '../appKeys.js'
import { applyAppView, capInlineViews, codeStampOf } from '../apps.js'

/**
 * External apps' events: their state, runs, list and capability questions (app-wide, before the
 * session guard), and an in-conversation view's `app_view` (a session's). True when the event was
 * one of these.
 */
export function appEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  /*
   * An external app's tool call finished (M4 A-4 → B-5). Not re-read here. An external app's state
   * lives in the app process, and re-reading it is the open view's own job, through its state tool.
   * The store only counts, and that app's open `AppFrame`s turn this count's change into a single
   * notification.
   */
  if (e.type === 'external_app_state_changed') {
    const key = externalAppKey(e.projectId, e.appId)
    const by = e.cause?.kind === 'view' ? (e.cause.instanceId ?? null) : null
    set((s) => ({
      externalAppChanges: { ...s.externalAppChanges, [key]: (s.externalAppChanges[key] ?? 0) + 1 },
      externalAppChangedBy: { ...s.externalAppChangedBy, [key]: by },
    }))
    return true
  }

  // An external app's run history changed (M4 D-6) — only counted. That app's runs panel re-reads on this count's change. The view never hears this
  if (e.type === 'external_app_runs_changed') {
    const key = externalAppKey(e.projectId, e.appId)
    set((s) => ({ externalAppRunChanges: { ...s.externalAppRunChanges, [key]: (s.externalAppRunChanges[key] ?? 0) + 1 } }))
    return true
  }

  // An external app's slot or state changed (M4 A-8) — since what changed is not carried, the whole list is re-read
  if (e.type === 'external_apps_changed') {
    void get().refreshExternalApps()
    return true
  }

  // A capability question was created or closed (M4 D-4) — same coarseness, the whole list is re-read
  if (e.type === 'external_app_questions_changed') {
    void get().refreshAppQuestions()
    return true
  }
  return false
}

/** An in-conversation app view's event (M4 B-1), for a session. True when the event was one */
export function appViewEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet): boolean {
  /*
   * An in-conversation app view (M4 B-1). Lives separate from cards — the view finds its own spot
   * by the card's id. Recorded even before the session is registered: it takes its place under the
   * card the instant the card is drawn.
   */
  if (e.type === 'app_view') {
    const was = get().inlineViews[sessionId]?.[e.callId]
    set((s) => ({ inlineViews: { ...s.inlineViews, [sessionId]: applyAppView(s.inlineViews[sessionId], e) } }))
    // The host closed a live view — send teardown, then close it
    if ((e.phase === 'closed' || e.phase === 'rejected') && was?.state === 'live') {
      void get().closeInlineView(sessionId, e.callId, e.reason ?? 'This view was closed')
    }
    if (e.phase === 'open') {
      // The code this view was opened with (C-4) — if the list's fingerprint differs from this, it is stale HTML (`followAppCode`)
      const codeStamp = codeStampOf(get().externalApps, e.projectId, e.appId, get().sessions[sessionId]?.machine)
      set((s) => {
        const cur = s.inlineViews[sessionId]?.[e.callId]
        return cur?.state === 'live' ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [e.callId]: { ...cur, codeStamp } } } } : {}
      })
      capInlineViews(get, sessionId, e.callId)
    }
    return true
  }
  return false
}
