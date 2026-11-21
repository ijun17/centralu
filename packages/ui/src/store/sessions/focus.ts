import { isAssistantKind } from '@cc/protocol/client'
import { APP_ARRIVAL_ID_PREFIX, appKeyOf, gridSessionIds, isAppArrivalId, isProposalId, nextWaitingSession } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { foldGroupsHiding } from '../foldGroups.js'
import { trimWindow, withoutClosedSteps } from '../historyPages.js'
import { omitKey } from '../patch.js'
import { assistantScreen } from '../assistant.js'
import { computeInbox, currentWaitingId } from '../inbox.js'

// `focusSession` is the one door a dozen call sites go through, so the rules of picking a session live there once.

/** Makes a second search for the same row a new navigation request. */
let searchTargetAt = 0

type FocusActions = Pick<
  AppState,
  | 'openSearchHit'
  | 'clearSearchTarget'
  | 'openWaiting'
  | 'openNextWaiting'
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
    // A proposal's card only stands on the Assistant's own screen, so `preferGrid` does not apply to it
    if (isProposalId(id)) void get().openAssistant()
    else if (isAppArrivalId(id)) {
      const key = id.slice(APP_ARRIVAL_ID_PREFIX.length)
      const arrival = get().appArrivals.find((a) => a.key === key)
      if (arrival) get().openApp(arrival.projectId, arrival.appId)
      get().dismissAppArrival(key)
    } else get().focusSession(id, opts)
  },

  openNextWaiting() {
    const next = nextWaitingSession(computeInbox(get()), currentWaitingId(get()))
    if (next) get().openWaiting(next)
  },

  focusSession(id, opts) {
    const prev = get().focusedSessionId
    const projectId = id ? get().sessions[id]?.projectId : undefined
    // A pick makes the session visible: with the grid open a sidebar click would seem to do nothing. Deselecting
    // (`null`) leaves the view alone. The Assistant gets its own screen: in 'focus' the evidence lane would come along
    // and its sidebar button would look unpressed (both decide by `view`).
    const onGrid = !!id && !!opts?.preferGrid && gridSessionIds(get().gridPanels).includes(id)
    const assistant = !!id && (id === get().assistantId || isAssistantKind(get().sessions[id]?.kind))
    // A picked session's folded project unfolds (#205) and stays so, as if by the arrow: re-folding on leaving would
    // be a row appearing and vanishing on its own. `reveal: false` only on a snapshot restore and a grid panel click.
    const picked = id ? get().sessions[id] : undefined
    const rowProject = picked?.projectId ?? null
    const reveal =
      opts?.reveal !== false && !!rowProject && get().foldedProjects.includes(rowProject)
    // The same for the group the row stands in (#666): the children of its parent, the sessions of its app
    if (picked && opts?.reveal !== false) {
      const listed = new Set(get().externalApps.map((a) => appKeyOf(a.projectId, a.appId, a.machine)))
      const hiding = foldGroupsHiding(picked, get().sessions, (x) => appKeyOf(x.projectId, x.appId!, x.machine), listed)
      const folded = get().prefs.foldedGroups
      if (hiding.some((k) => folded.includes(k))) get().setGroupsFolded(hiding, false)
    }
    // Any overlay goes: the new session's conversation must be visible
    set({
      focusedSessionId: id,
      overlay: null,
      // A composer asked to take the keyboard belongs to the session asked for, not the one shown now (#528)
      ...(get().composerFocusFor !== null && get().composerFocusFor !== id ? { composerFocusFor: null } : {}),
      ...(reveal ? { foldedProjects: get().foldedProjects.filter((p) => p !== rowProject) } : {}),
      // A pick from elsewhere (a mail, a notice, the waiting list) names the Assistant's session here (#1647), or its
      // screen would show the empty start over a conversation that exists
      ...(id && assistant && !onGrid && !picked?.machine ? assistantScreen(id) : {}),
      ...(id
        ? {
            // `preferGrid`, given only by GridView, is the one case the grid outranks the Assistant's own screen
            view: onGrid ? ('grid' as const) : assistant ? ('assistant' as const) : ('focus' as const),
          }
        : {}),
      ...(projectId ? { focusedProjectId: projectId } : {}),
    })
    get().saveWorkspace()

    // A session that lost focus is trimmed to the window (docs/state-management.md §4)
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
    const cur = get()
    /*
     * "Read" means a cursor exists (#79): rows alone may be events that arrived before the screen. The cursor is never
     * the top row's number, a render key and not the stored seq: that read the conversation twice (measured). Reading
     * is safe: `loadHistory` merges with the rows on screen (`mergePage`).
     */
    if (opts?.targetSeq !== undefined) {
      // Loading before the pane sees this session, or its first-open read races this page back to the newest message
      const targetSeq = opts.targetSeq
      set((s) => ({ history: { ...s.history, [id]: { oldestSeq: targetSeq, more: false, loading: true } } }))
      void get().loadHistoryAt(id, targetSeq)
    } else if (!cur.history[id]) void get().loadHistory(id)
    // Selecting does not wake a session (#568): reading should not start a 250 MB process. It wakes on send or when its
    // composer takes the keyboard; the resume, about 0.7 s (p50) on Claude, runs while the person types.
  },
})
