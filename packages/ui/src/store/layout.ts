import { appKeyOf, gridPanelKey, sanitizeGridPanels, withPanelSpan } from '@cc/core'
import type { AppState, Overlay, StoreGet, StoreSet } from './state.js'
import { activateTab } from './panelLayout.js'
import { FOLDED_GROUPS_MAX, deadFoldKeys, sameKeys } from './foldGroups.js'
import { gridAppViewKey } from './appKeys.js'
import { omitKey } from './patch.js'

/**
 * How the window is arranged: the evidence panel and the lane widths, the wide surface over the
 * conversation, the layers and dialogs opened over the screen, the sidebar's folds and the project
 * screens' arrangements, the grid's panels, a conversation's scroll position, and the window's focus.
 */

/**
 * One higher than the last one opened. Coming from outside git resets it to 1 — panels opened
 * in between are appended fresh.
 */
const nextPick = (o: Overlay): number => (o?.kind === 'git' ? o.pick : 0) + 1

/** Limits on the evidence panel's width. Too narrow kills the path; too wide kills the conversation */
export const PANEL_MIN = 260
export const PANEL_MAX = 900
export const PANEL_DEFAULT = 340

/** Width of the session list (observation lane) */
/** The height "history" takes up in the git tab. "Changes" gets the rest */

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 240

/**
 * The minimum width the conversation lane must keep.
 *
 * Without this, stretching both side panels squeezes the center down to zero and beyond, pushing
 * the whole layout past the window edge so the entire screen scrolls horizontally (this actually
 * happened during dogfooding). Worse, in that state the handle position calculation goes wrong,
 * creating feedback where dragging it makes it grow larger still.
 */
export const CENTER_MIN = 360

/**
 * Clamps to the width that can actually fit inside the window.
 *
 * Why `zoom` is needed (for overall text size): the layout width is in zoom coordinates, while
 * `window.innerWidth` is in **real pixels**. Without dividing by it, the available width gets
 * inflated at higher zoom and the layout is pushed past the window edge. The minimum width, on
 * the other hand, is **pinned to real pixels** — if it were allowed to grow with the zoom level up
 * to the point where the panel could be narrowed, raising the zoom in a narrow window would let
 * the panel eat the whole screen (per a dogfooding request: the minimum width stays fixed).
 */
function fitWidth(px: number, minReal: number, max: number, otherLane: number, zoom = 1): number {
  const winW = (typeof window === 'undefined' ? 1280 : window.innerWidth) / zoom
  const available = winW - otherLane - CENTER_MIN / zoom
  return Math.min(max, Math.max(Math.round(minReal / zoom), Math.round(Math.min(px, available))))
}

/** The newest save of the folded groups (#666): an older one that fails must not undo what a later one is saving */
let foldSaveSeq = 0

/** The store's actions for how the window is arranged */
type LayoutActions = Pick<
  AppState,
  | 'setBuilderPane'
  | 'setAppFocused'
  | 'dismissNotices'
  | 'togglePanel'
  | 'setPanelTab'
  | 'setPanelLayout'
  | 'setPanelWidth'
  | 'setPanelSplit'
  | 'setSidebarWidth'
  | 'openFile'
  | 'revealFile'
  | 'openGit'
  | 'openCommit'
  | 'openBranches'
  | 'closeOverlay'
  | 'toggleInbox'
  | 'togglePalette'
  | 'askComposerFocus'
  | 'toggleUsage'
  | 'toggleSettings'
  | 'openSettingsAt'
  | 'openImport'
  | 'closeImport'
  | 'requestSettingsMenu'
  | 'setStickToBottom'
  | 'setScrollAnchor'
  | 'toggleDir'
  | 'setShowIgnored'
  | 'toggleProjectFold'
  | 'setGroupsFolded'
  | 'pruneFoldedGroups'
  | 'foldOtherProjects'
  | 'arrangeProject'
  | 'setAppSpan'
  | 'setGridPanelSpan'
  | 'setGridPanels'
  | 'setToast'
>

export const layoutActions = (set: StoreSet, get: StoreGet): LayoutActions => ({
  setBuilderPane(sessionId) {
    if (get().builderPaneSessionId !== sessionId) set({ builderPaneSessionId: sessionId })
  },

  setAppFocused(focused) {
    /*
     * **Only the false→true edge.** `onVisibility` fires once at mount while `appFocused`
     * is already true and `attach` has just fetched every project — refreshing on every
     * call would repeat that fetch for no new information. Focus and visibilitychange also
     * both fire for a single alt-tab; the debounce would collapse those anyway, but there
     * is no reason to arm two timers to learn one thing.
     */
    const returning = focused && !get().appFocused
    set({ appFocused: focused })
    /*
     * Coming back to the window is the only signal we get for work done **outside** the app
     * (issue #41): a commit typed in a terminal, a rebase, a `git clean`. Nothing in here
     * watched it happen, so no project is more suspect than another and all of them are
     * re-measured — refreshing only the focused one would leave every other sidebar row
     * exactly as stale as before, which is the bug.
     */
    if (returning) for (const id of Object.keys(get().projects)) get().refreshProjectGit(id)
    // The same signal for an agent CLI updated in a terminal (#297): the host reads the installed versions again
    if (returning) void get().checkAgentVersions(false)
  },

  dismissNotices(sessionIds) {
    if (sessionIds.length === 0) return
    const drop = new Set(sessionIds)
    set((s) => {
      const kept = s.notices.filter((n) => !drop.has(n.sessionId))
      // Leave it as is when nothing changed — putting in a new array reruns any effect watching this
      return kept.length === s.notices.length ? {} : { notices: kept }
    })
  },

  togglePanel(open) {
    set((s) => ({ panelOpen: open ?? !s.panelOpen }))
    get().saveWorkspace()
  },

  setPanelTab(tab) {
    set((s) => ({ panelLayout: activateTab(s.panelLayout, tab), panelOpen: true }))
    get().saveWorkspace()
  },

  setPanelLayout(panelLayout) {
    set({ panelLayout })
    get().saveWorkspace()
  },

  setPanelWidth(px) {
    const s = get()
    const sidebar = s.panelOpen ? s.sidebarWidth : s.sidebarWidth
    set({ panelWidth: fitWidth(px, PANEL_MIN, PANEL_MAX, sidebar, s.prefs.textSize) })
    get().saveWorkspace()
  },

  setPanelSplit(share) {
    // If one group drops below 15%, only the tab strip remains and it reads as "gone" — a floor is set
    const clamped = Math.min(0.85, Math.max(0.15, share))
    if (clamped === get().panelSplit) return
    set({ panelSplit: clamped })
    get().saveWorkspace()
  },

  setSidebarWidth(px) {
    const s = get()
    // If the panel is collapsed, it only occupies a 32px strip
    const panel = s.panelOpen ? s.panelWidth : 32
    set({ sidebarWidth: fitWidth(px, SIDEBAR_MIN, SIDEBAR_MAX, panel, s.prefs.textSize) })
    get().saveWorkspace()
  },

  openFile(path, projectId, sessionId) {
    set({ viewerPath: path, viewerProjectId: projectId ?? null, viewerSessionId: sessionId ?? null, overlay: { kind: 'viewer' } })
  },

  /*
   * Opens Finder from a right-click. The path arrives with the same credentials as a file link
   * (relative to the currently viewed session's project), and goes through the same port as the file
   * tree's reveal — a failure is loud with the same wording as the tree's.
   */
  async revealFile(path, from, sessionId) {
    const s = get()
    const projectId = from ?? (s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null)
    if (!projectId || !s.platform) return
    // The file manager is this computer's; a file on a linked machine is not in it (#82)
    const machine = s.projects[projectId]?.machine
    if (machine) {
      set({ toast: `${path} is on ${s.machines[machine]?.name ?? machine}, not on this computer` })
      return
    }
    try {
      const res = await s.platform.fs.reveal(projectId, path, sessionId ?? undefined)
      if (!res.supported) set({ toast: res.reason ?? 'Showing files is not available here' })
    } catch (e) {
      set({ toast: `Could not show ${path}: ${(e as Error).message}` })
    }
  },

  openGit(path, staged) {
    // The tab is recorded explicitly — clicking a changed file while viewing history must return to changes
    set((s) => ({ overlay: { kind: 'git', path: path ?? null, staged, sub: 'changes', pick: nextPick(s.overlay) } }))
  },

  openCommit(sha) {
    set((s) => ({ overlay: { kind: 'git', sha, sub: 'history', pick: nextPick(s.overlay) } }))
  },

  openBranches() {
    set((s) => ({ overlay: { kind: 'git', sub: 'branches', pick: nextPick(s.overlay) } }))
  },

  closeOverlay() {
    set({ overlay: null })
  },

  toggleInbox(open) {
    set((s) => ({ inboxOpen: open ?? !s.inboxOpen }))
  },

  togglePalette(open) {
    set((s) => ({ paletteOpen: open ?? !s.paletteOpen }))
  },

  askComposerFocus(sessionId) {
    set({ composerFocusFor: sessionId })
  },

  toggleUsage(open) {
    set((s) => ({ usageOpen: open ?? !s.usageOpen }))
  },

  toggleSettings(open) {
    set((s) => ({ settingsOpen: open ?? !s.settingsOpen }))
  },

  openSettingsAt(category) {
    set({ settingsOpen: true, settingsRequest: { category, at: Date.now() } })
  },

  openImport(source = '', fromLink = false) {
    // `at` is needed so a new link arriving at an already-open window still makes the window stand up again for that link (a request to open the same window twice)
    set({ importDialog: { source, fromLink, at: Date.now() }, settingsOpen: false })
  },

  closeImport() {
    set({ importDialog: null })
  },

  requestSettingsMenu(sessionId) {
    set({ settingsMenuRequest: { sessionId, at: Date.now() } })
  },

  setStickToBottom(sessionId, sticking) {
    set((s) => {
      // Scrolling fires this by the dozen; only a change is worth a new state object
      if ((s.stickToBottom[sessionId] ?? true) === sticking) return {}
      // Sticking is the default, so it is recorded by *not* being recorded — that way the
      // map only ever holds the sessions someone has actually scrolled away from
      if (sticking) return { stickToBottom: omitKey(s.stickToBottom, sessionId) }
      return { stickToBottom: { ...s.stickToBottom, [sessionId]: false } }
    })
  },

  setScrollAnchor(sessionId, anchor) {
    set((s) => {
      if (!anchor) {
        // Left at the bottom — if the previous anchor were left behind, arriving next time would go to that old spot
        if (!(sessionId in s.scrollAnchor)) return {}
        return { scrollAnchor: omitKey(s.scrollAnchor, sessionId) }
      }
      const cur = s.scrollAnchor[sessionId]
      if (cur && cur.seq === anchor.seq && cur.offset === anchor.offset) return {}
      return { scrollAnchor: { ...s.scrollAnchor, [sessionId]: anchor } }
    })
  },

  toggleDir(projectId, path) {
    set((s) => {
      const cur = s.expandedDirs[projectId] ?? []
      /*
        Closing a folder leaves its children in the list on purpose. "As you left it" means
        the whole shape comes back when you open the parent again, not just its first row.
      */
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
      return { expandedDirs: { ...s.expandedDirs, [projectId]: next } }
    })
  },

  setShowIgnored(show) {
    set({ showIgnored: show })
    get().saveWorkspace()
  },

  toggleProjectFold(projectId) {
    set((s) => ({
      foldedProjects: s.foldedProjects.includes(projectId)
        ? s.foldedProjects.filter((id) => id !== projectId)
        : [...s.foldedProjects, projectId],
    }))
    get().saveWorkspace()
  },

  setGroupsFolded(keys, folded) {
    const before = get().prefs.foldedGroups
    const next = folded
      ? [...before, ...keys.filter((k, i) => !before.includes(k) && keys.indexOf(k) === i)].slice(-FOLDED_GROUPS_MAX)
      : before.filter((k) => !keys.includes(k))
    if (sameKeys(next, before)) return
    set((s) => ({ prefs: { ...s.prefs, foldedGroups: next } }))
    const platform = get().platform
    if (!platform) return
    const mine = ++foldSaveSeq
    platform.prefs.save({ foldedGroups: next }).catch((e: unknown) => {
      /*
       * Undone only when this is still the newest save and the list is still what it wrote: a later fold has its own
       * save in flight, and its state must not be rolled back by this one's failure. Compared by value, not identity:
       * a reconnect reads the preferences again and hands the screen a new array with the same keys.
       */
      if (mine === foldSaveSeq && sameKeys(get().prefs.foldedGroups, next)) {
        set((s) => ({ prefs: { ...s.prefs, foldedGroups: before } }))
      }
      set({ toast: `Could not save that: ${(e as Error).message}` })
    })
  },

  pruneFoldedGroups() {
    const s = get()
    // An empty app list may be a read that failed; it names no app, so it must not condemn every app's fold
    const apps = s.externalApps.length > 0 ? new Set(s.externalApps.map((a) => appKeyOf(a.projectId, a.appId, a.machine))) : null
    const dead = deadFoldKeys(s.prefs.foldedGroups, s.sessions, apps)
    if (dead.length > 0) get().setGroupsFolded(dead, false)
  },

  foldOtherProjects(projectId) {
    set((s) => ({ foldedProjects: Object.keys(s.projects).filter((id) => id !== projectId) }))
    get().saveWorkspace()
  },

  arrangeProject(projectId, next) {
    set((s) => ({ projectPanels: { ...s.projectPanels, [projectId]: next } }))
    get().saveWorkspace()
  },

  setAppSpan(projectId, appId, span, machine) {
    const key = appKeyOf(projectId, appId, machine)
    set((s) => {
      const { [key]: _old, ...rest } = s.appSpans
      return { appSpans: span ? { ...rest, [key]: span } : rest }
    })
    get().saveWorkspace()
  },

  async setGridPanelSpan(key, span) {
    await get().setGridPanels(withPanelSpan(get().gridPanels, key, span))
  },

  /**
   * Saves the whole arrangement (adding, removing and reordering all arrive as this one action).
   *
   * The screen changes first and the save follows — if a dropped panel waited for a round trip to
   * the server before settling into place, the hand would feel like it stumbled. A failure reverts to
   * whatever the host says is true.
   */
  async setGridPanels(panels) {
    const platform = get().platform
    if (!platform) return
    const before = get().gridPanels
    /*
     * An app panel taken off the grid closes its view, teardown first — the project screen's × rule (#288). Here
     * rather than at the grid's ×, so every way a panel leaves the list (the ×, a test, a future caller) takes its view
     * with it instead of leaving a frame alive behind a screen that no longer shows it. The view is not inside the
     * panel (it is laid over it from PinnedApps), so the panel leaving first does not cut teardown off: the frame stays
     * in the document, hidden, until `dismissPinnedView` has had its answer.
     */
    const kept = new Set(panels.map(gridPanelKey))
    for (const p of before) {
      if (p.kind === 'app' && !kept.has(gridPanelKey(p))) void get().dismissPinnedView(gridAppViewKey(p.projectId, p.appId, p.machine))
    }
    set({ gridPanels: panels })
    try {
      set({ gridPanels: sanitizeGridPanels(await platform.agents.setGridView(panels)) })
    } catch (e) {
      set({ gridPanels: before, toast: `Could not save layout: ${(e as Error).message}` })
    }
  },

  setToast(toast, action) {
    set({ toast, toastAction: toast === null ? null : (action ?? null) })
  },
})
