import { SessionInfo, parseTolerant, type NormalizedEvent } from '@cc/protocol/client'
import { sessionPanelId, withPanel } from '@cc/core'
import type { StoreGet, StoreSet } from '../state.js'
import { forgetSessions, liveEventWatchers, replayPendingEvents, sessionFromInfo } from '../sessionList.js'

export function sessionEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet): boolean {
  // A conversation continued in the tool's own terminal is in the store already: re-read whole, not mixed in by row
  if (e.type === 'history_synced') {
    void get().loadHistory(sessionId)
    return true
  }

  // A setting another hand changed gets a toast, or the menu shows a value nobody chose (#30)
  if (e.type === 'settings_changed') {
    const cur0 = get().sessions[sessionId]
    if (!cur0) return true
    const what = [
      e.model !== cur0.model ? `model ${e.model ?? 'default'}` : null,
      e.effort !== cur0.effort ? `effort ${e.effort ?? 'default'}` : null,
      e.verbosity !== cur0.verbosity ? `verbosity ${e.verbosity ?? 'default'}` : null,
      (e.serviceTier ?? null) !== cur0.serviceTier ? `speed ${e.serviceTier ?? 'default'}` : null,
      e.permissionPreset && e.permissionPreset !== cur0.permissionPreset ? `permissions ${e.permissionPreset}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId]!,
          model: e.model,
          effort: e.effort,
          verbosity: e.verbosity,
          serviceTier: e.serviceTier ?? null,
          // Absent on a tool's own switch and from a host older than #659: the value held stays
          permissionPreset: e.permissionPreset ?? s.sessions[sessionId]!.permissionPreset,
        },
      },
      // No toast for the tool's own switch (its notice says it, #304) or a client's change (its own toast says it, #659)
      ...(what && e.by !== 'tool' && !e.person ? { toast: `Assistant changed ${cur0.name}: ${what}` } : {}),
    }))
    // A list still out must not write back over these, even a change back to the value it asked with (#642)
    for (const touched of liveEventWatchers) {
      const fields = touched.get(sessionId)
      if (fields) for (const k of ['model', 'effort', 'verbosity', 'serviceTier', 'permissionPreset'] as const) fields.add(k)
    }
    return true
  }
  return false
}

export function sessionListEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet): boolean {
  /*
   * The only notice of a session the host created itself (#69); without it, its penned events would wait until a
   * reconnect. One created through an RPC is already registered by its response.
   */
  if (e.type === 'session_created') {
    // Read as the session list reads it (#384): a value a newer host invented costs that value, not the session
    const s = parseTolerant(SessionInfo, e.session) as SessionInfo | undefined
    const ok = typeof s === 'object' && s !== null && typeof s.id === 'string'
    // Said again when the host moved a held session into a project (#1141): only the project is taken
    const held = ok ? get().sessions[s.id] : undefined
    if (ok && held && held.projectId !== s.projectId) {
      const projectId = s.projectId
      set((st) => {
        const cur = st.sessions[s.id]
        return cur ? { sessions: { ...st.sessions, [cur.id]: { ...cur, projectId } } } : {}
      })
      return true
    }
    if (ok && !held) {
      set((st) => ({ sessions: { ...st.sessions, [s.id]: sessionFromInfo(s) } }))
      replayPendingEvents(get)
    }
    return true
  }

  // A handoff moved a child (#693, #1475); an unknown session comes with its owner in the list, so this is not penned
  if (e.type === 'session_owner') {
    set((s) => {
      const cur = s.sessions[sessionId]
      if (!cur) return {}
      return { sessions: { ...s.sessions, [sessionId]: { ...cur, askedBy: e.askedBy, parentSessionId: e.parentSessionId } } }
    })
    return true
  }

  // A deletion means the session is gone, so it does not run through the reducer
  if (e.type === 'session_deleted') {
    const panelId = sessionPanelId(sessionId)
    const wasPanel = Object.values(get().projectPanels).some((saved) => saved.panels?.includes(panelId))
    set((s) => {
      const sessions = { ...s.sessions }
      delete sessions[sessionId]
      // docs/state-management.md "Project panel membership": only this event removes it
      const projectPanels = Object.fromEntries(Object.entries(s.projectPanels).map(([pid, saved]) => [
        pid, saved.panels?.includes(panelId) ? withPanel([], saved, panelId, false) : saved,
      ]))
      return { sessions, ...forgetSessions(s, new Set([sessionId])), projectPanels }
    })
    if (wasPanel) get().saveWorkspace()
    get().pruneFoldedGroups()
    return true
  }
  return false
}
