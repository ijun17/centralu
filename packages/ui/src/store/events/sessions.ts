import { SessionInfo, parseTolerant, type NormalizedEvent } from '@cc/protocol'
import { initialSession, sessionPanelId, withPanel } from '@cc/core'
import type { StoreGet, StoreSet } from '../state.js'
import { forgetSessions, liveEventWatchers, liveFactsOf, replayPendingEvents } from '../sessionList.js'

/**
 * A session's own life, apart from its conversation: its history caught up from outside, its
 * settings changed by another hand, and the session created, handed to a new owner or deleted. True
 * when the event was one of these.
 */

/** `history_synced` and `settings_changed`, which come before the notices (`dispatchEvent`) */
export function sessionEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet): boolean {
  /*
   * The host caught up on a conversation continued from outside (through the tool's own
   * terminal). Its content already went into the store, so the screen is re-read whole — replaying
   * events row by row here could mix in with the part we already knew.
   */
  if (e.type === 'history_synced') {
    void get().loadHistory(sessionId)
    return true
  }

  /*
   * The orchestrator changed this session's settings (#30).
   *
   * The toast is the point — if a setting changed by a hand other than the person's quietly seeped
   * into the screen, the next person to open the menu would be baffled by a value they never chose.
   * The value is a snapshot, so it is overwritten as is.
   */
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
          // Absent on a tool's own switch and on frames from before #659: the value held stays
          permissionPreset: e.permissionPreset ?? s.sessions[sessionId]!.permissionPreset,
        },
      },
      /*
       * A switch the agent tool made by itself (#304) updates the model shown without a toast: the tool's notice in
       * the conversation already says what changed and why, and a toast would interrupt for something that needs
       * nothing from the person. The same for a change a client made through `agents.updateSettings` (#659): the
       * caller's own toast says what it did, and the values here are the ones it chose.
       */
      ...(what && e.by !== 'tool' && !e.person ? { toast: `Orchestrator changed ${cur0.name}: ${what}` } : {}),
    }))
    /*
     * Fields a list that is still out must not write back over (#642): the merge keeps a value that differs from the
     * one it asked with, but a change that lands back on that value would otherwise read as no change at all.
     */
    for (const touched of liveEventWatchers) {
      const fields = touched.get(sessionId)
      if (fields) for (const k of ['model', 'effort', 'verbosity', 'serviceTier', 'permissionPreset'] as const) fields.add(k)
    }
    return true
  }
  return false
}

/** `session_created`, `session_owner` and `session_deleted` */
export function sessionListEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet): boolean {
  /*
   * The only notice for a session the host created on its own (#69) — the orchestrator's
   * `create_session`, or a manager set up by worktree adoption. Without this, such a session did
   * not appear until after a reconnect, and any event that arrived before that stayed stuck in the
   * holding pen forever (its release condition was "once registered," and nothing was there to
   * register it). A session created through an RPC is already registered by its response, so this
   * is silently discarded for that case.
   */
  if (e.type === 'session_created') {
    // Read as the session list reads it (#384): a value a newer host invented costs that value, not the session
    const s = parseTolerant(SessionInfo, e.session) as SessionInfo | undefined
    if (typeof s === 'object' && s !== null && typeof s.id === 'string' && !get().sessions[s.id]) {
      set((st) => ({
        sessions: {
          ...st.sessions,
          [s.id]: {
            ...initialSession({
              id: s.id,
              projectId: s.projectId,
              kind: s.kind,
              appId: s.appId,
              askedBy: s.askedBy ?? null,
              forkedFrom: s.forkedFrom ?? null,
              name: s.name,
              tool: s.tool,
              model: s.model,
              effort: s.effort,
              verbosity: s.verbosity,
              serviceTier: s.serviceTier,
              permissionPreset: s.permissionPreset,
              worktree: s.worktree,
              parentSessionId: s.parentSessionId,
              merged: s.worktreeMerged,
              pr: s.worktreePr,
              goal: s.goal,
            }),
            autoNamed: s.autoNamed,
            state: s.state,
                live: s.live,
            lastSeq: s.lastSeq,
            lastReadSeq: s.lastReadSeq,
            waitingSince: s.waitingSince,
            ...liveFactsOf(s),
          },
        },
      }))
      // If there are events held from before registration, now is the moment to replay them
      replayPendingEvents(get)
    }
    return true
  }

  /*
   * A handoff moved a live child to the session that took over (#693): the sidebar hangs it there now. A session
   * not known here comes with its owner in the list, so the event is not held for it.
   */
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
      // List omission on reconnect is ambiguous; only this explicit deletion signal removes membership.
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
