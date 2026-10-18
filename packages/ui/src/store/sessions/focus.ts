import { appKeyOf, gridSessionIds, isProposalId } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { foldGroupsHiding } from '../foldGroups.js'
import { sidebarProjectOf } from '../sidebarTree.js'
import { trimWindow, withoutClosedSteps } from '../historyPages.js'
import { omitKey } from '../patch.js'

/**
 * Picking the session the person looks at: `focusSession`, the one door a dozen call sites go
 * through, and the doors that lead to it (a search hit, the next waiting item).
 */

/** Makes a second search for the same row a new navigation request. */
let searchTargetAt = 0

/** The store's actions that pick the session the person looks at */
type FocusActions = Pick<
  AppState,
  | 'openSearchHit'
  | 'clearSearchTarget'
  | 'openWaiting'
  | 'focusSession'
>

export const focusActions = (set: StoreSet, get: StoreGet): FocusActions => ({
  openSearchHit(sessionId, seq) {
    const at = ++searchTargetAt
    set((s) => ({ searchTargets: { ...s.searchTargets, [sessionId]: { seq, at } } }))
    get().focusSession(sessionId, { targetSeq: seq })
  },

  clearSearchTarget(sessionId, at) {
    set((s) => {
      if (s.searchTargets[sessionId]?.at !== at) return {}
      return { searchTargets: omitKey(s.searchTargets, sessionId) }
    })
  },

  openWaiting(id, opts) {
    // A proposal's card only stands on the orchestrator's own screen, so `preferGrid` does not apply to it
    if (isProposalId(id)) void get().openOrchestrator()
    else get().focusSession(id, opts)
  },

  focusSession(id, opts) {
    const prev = get().focusedSessionId
    const projectId = id ? get().sessions[id]?.projectId : undefined
    /*
     * Picking a session **must make that session visible.**
     *
     * With the grid left open, clicking a different session in the sidebar left the screen
     * unchanged: what was picked had changed but what was visible had not, so to the person who
     * clicked, nothing appeared to happen. This lives here because there are a dozen call sites
     * (sidebar, inbox, palette, approval banner, …) — attaching it at each call site means one of
     * them eventually gets missed.
     *
     * Deselecting (`null`) leaves the view untouched, because that is not "look at this."
     */
    /*
     * **The orchestrator goes to its own screen, not 'focus'** (a dogfooding bug).
     *
     * Turning on `view: 'focus'` unconditionally here meant clicking the orchestrator from the top
     * bar's "waiting for response" list opened the orchestrator's conversation **inside the frame of
     * the session screen.** Two symptoms came from that: the right-hand evidence lane came along
     * (`App`'s `hasEvidenceLane` decides by `view` — the orchestrator has no repository to view), and
     * the sidebar's orchestrator button looked unpressed (`active` also decides by `view`).
     *
     * The fix belongs here for the same reason as the comment above: this function has a dozen call
     * sites (inbox, notification card, palette, approval banner, shortcuts, …). Even one of them
     * meeting the orchestrator reproduces the same symptom, so the decision has to live in this one
     * place, not at each caller.
     */
    // If the session is already on the grid, the grid is the destination (see the `preferGrid` comment above)
    const onGrid = !!id && !!opts?.preferGrid && gridSessionIds(get().gridPanels).includes(id)
    const orchestrator = !!id && (id === get().orchestratorId || get().sessions[id]?.kind === 'orchestrator')
    /*
     * If the picked session's project is folded, it is unfolded (#205) — a picked session must also
     * be visible in the sidebar. The inbox, palette, notification card, next-waiting (⌘⇧A) and
     * new-session all pass through this door, so the decision lives here alone (same reason as
     * `view` above: a dozen call sites).
     *
     * **What gets unfolded is remembered** — the same as if the person had unfolded it with the
     * arrow. A path that unfolds briefly and re-folds on leaving was considered and rejected. That
     * would require a second, off-screen piece of state to decide "when to fold it back," and a
     * person cannot predict that moment — a row appearing and disappearing on its own is exactly why
     * unfolding on hover was rejected too. Remembering it means the arrow always states exactly what
     * is on screen, and reopening the app returns to exactly what was last seen.
     *
     * `reveal: false` happens in exactly two places: restoring a snapshot (a fold left there was also
     * left by the person) and clicking a grid panel (the session is already visible in its panel, and
     * if typing into a panel unfolded its project every time, folding would be pointless).
     */
    // The row stands under the project the sidebar puts it in (`sidebarProjectOf`): a child started on another machine
    // stands under its parent's project, not under its own, so that is the fold to open (#1038)
    const picked = id ? get().sessions[id] : undefined
    const rowProject = picked ? sidebarProjectOf(picked, get().sessions) : null
    const reveal =
      opts?.reveal !== false && !!rowProject && get().foldedProjects.includes(rowProject)
    // The same for the group the row stands in (#666): the children of its parent, the sessions of its app
    if (picked && opts?.reveal !== false) {
      const listed = new Set(get().externalApps.map((a) => appKeyOf(a.projectId, a.appId, a.machine)))
      const hiding = foldGroupsHiding(picked, get().sessions, (x) => appKeyOf(x.projectId, x.appId!, x.machine), listed)
      const folded = get().prefs.foldedGroups
      if (hiding.some((k) => folded.includes(k))) get().setGroupsFolded(hiding, false)
    }
    // Switching sessions clears any overlay — the new session's conversation must be visible first
    set({
      focusedSessionId: id,
      overlay: null,
      // A composer asked to take the keyboard belongs to the session asked for, not the one shown now (#528)
      ...(get().composerFocusFor !== null && get().composerFocusFor !== id ? { composerFocusFor: null } : {}),
      ...(reveal ? { foldedProjects: get().foldedProjects.filter((p) => p !== rowProject) } : {}),
      ...(id
        ? {
            /*
             * The orchestrator can be placed on the grid too. If clicking its panel's composer or
             * notification got hijacked into the dedicated screen, "view side by side" would break
             * immediately. `preferGrid` is only ever the explicit intent `GridView` gives, so it is
             * the only case where the grid outranks the dedicated screen. A normal pick, like from
             * the sidebar or the palette, still goes to the orchestrator's dedicated screen.
             */
            view: onGrid ? ('grid' as const) : orchestrator ? ('orchestrator' as const) : ('focus' as const),
          }
        : {}),
      ...(projectId ? { focusedProjectId: projectId } : {}),
    })
    get().saveWorkspace()

    // Messages of a session that lost focus are trimmed (docs/state-management.md §4).
    // Holding all of ten sessions × hundreds of turns each would blow the §7.1 memory target.
    // The summary (state, unread, preview) stays intact, so the sidebar and inbox remain accurate.
    if (prev && prev !== id) {
      const items = get().chat[prev]
      const trimmed = items && trimWindow(items)
      if (trimmed) {
        set((s) => ({
          chat: { ...s.chat, [prev]: trimmed.items },
          history: {
            ...s.history,
            [prev]: { oldestSeq: trimmed.oldestSeq, more: trimmed.oldestSeq > 1, loading: false },
          },
          subagentSteps: withoutClosedSteps(s.subagentSteps, prev),
        }))
      }
    }

    if (!id) return
    void get().markRead(id)
    // If the session's conversation has not been read yet, load it from storage (history survives even a host restart)
    const cur = get()
    /*
     * "Read" means **a cursor exists** (#79). Having conversation rows does not mean it was read —
     * if an event arrives before the screen does (a session the host created in the background, like
     * an app's requested agent, or an event replayed by the initial connection), only rows appear.
     *
     * Before this (09-09), such a session's cursor used to be set from the top row on screen. The
     * reasoning was that re-reading could wipe out a still-streaming message or an optimistically
     * drawn first prompt. But that number was the render key: a stored 8-line session ended up with a
     * cursor of 48, so "earlier conversation" appended the whole conversation a second time (measured
     * 2026-09-25), and whenever the key was lower than the stored number, the entire middle went
     * missing. Now that `loadHistory` merges with history rather than clearing the screen's rows
     * (`mergePage`), it is always safe to read.
     */
    if (opts?.targetSeq !== undefined) {
      // Mark the cursor as loading before the pane observes this session. Otherwise its ordinary
      // first-open read races this targeted page and lands us back at the newest message.
      const targetSeq = opts.targetSeq
      set((s) => ({ history: { ...s.history, [id]: { oldestSeq: targetSeq, more: false, loading: true } } }))
      void get().loadHistoryAt(id, targetSeq)
    } else if (!cur.history[id]) void get().loadHistory(id)
    /*
     * Selecting a session no longer wakes it (#568). Its process starts when the person sends to it or its composer takes
     * the keyboard: reading an old conversation should not start a 250 MB process that the host puts back to sleep in
     * 15 minutes. The resume this used to hide costs about 0.7 s (p50) on Claude, and it runs while the person types.
     */
  },
})
