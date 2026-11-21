import type { NormalizedEvent } from '@cc/protocol/client'
import { appKeyOf } from '@cc/core'
import type { StoreGet, StoreSet } from '../state.js'
import { applyAppView, capInlineViews, codeStampOf, patchInlineView } from '../apps.js'

export function appEvent(e: NormalizedEvent, set: StoreSet): boolean {
  // Only counted: the app's state lives in its process, and its open `AppFrame`s re-read it on the count's change
  if (e.type === 'external_app_state_changed') {
    const key = appKeyOf(e.projectId, e.appId)
    const by = e.cause?.kind === 'view' ? (e.cause.instanceId ?? null) : null
    set((s) => ({
      externalAppChanges: { ...s.externalAppChanges, [key]: (s.externalAppChanges[key] ?? 0) + 1 },
      externalAppChangedBy: { ...s.externalAppChangedBy, [key]: by },
    }))
    return true
  }

  // Only counted: the app's runs panel re-reads on the count's change; the view never hears it
  if (e.type === 'external_app_runs_changed') {
    const key = appKeyOf(e.projectId, e.appId)
    set((s) => ({ externalAppRunChanges: { ...s.externalAppRunChanges, [key]: (s.externalAppRunChanges[key] ?? 0) + 1 } }))
    return true
  }
  return false
}

export function appViewEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet): boolean {
  // Kept apart from cards, even before the session is registered: the view finds its card by id once it is drawn
  if (e.type === 'app_view') {
    const was = get().inlineViews[sessionId]?.[e.callId]
    set((s) => ({ inlineViews: { ...s.inlineViews, [sessionId]: applyAppView(s.inlineViews[sessionId], e) } }))
    if ((e.phase === 'closed' || e.phase === 'rejected') && was?.state === 'live') {
      void get().closeInlineView(sessionId, e.callId, e.reason ?? 'This view was closed')
    }
    if (e.phase === 'open') {
      // A list fingerprint that later differs from this marks the view's HTML stale (`followAppCode`)
      const codeStamp = codeStampOf(get().externalApps, e.projectId, e.appId, get().sessions[sessionId]?.machine)
      patchInlineView(set, sessionId, e.callId, { codeStamp }, true)
      capInlineViews(get, sessionId, e.callId)
    }
    return true
  }
  return false
}
