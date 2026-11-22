import { errorMessage } from '@cc/protocol/client'
import { appKeyOf, gridPanelKey, sanitizeGridPanels, withPanelSpan } from '@cc/core'
import type { AppState, Overlay, StoreGet, StoreSet } from './state.js'
import { activateTab } from './panelLayout.js'
import { FOLDED_GROUPS_MAX, deadFoldKeys, sameKeys } from './foldGroups.js'
import { gridAppViewKey } from './appKeys.js'
import { omitKey } from './patch.js'
import { machineNameOf } from './names.js'

// Coming from outside git resets it to 1
const nextPick = (o: Overlay): number => (o?.kind === 'git' ? o.pick : 0) + 1

export const PANEL_MIN = 260
export const PANEL_MAX = 900
export const PANEL_DEFAULT = 340

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 240

// Without it, two wide side lanes push the layout past the window edge, and a drag handle then grows as it is dragged
const CENTER_MIN = 360

/**
 * What the conversation keeps in a window too narrow for the side lanes (#1561), which give way first. Real pixels.
 * Lower than CENTER_MIN, which is what a drag leaves while there is room.
 */
export const CENTER_FLOOR = 300

/**
 * The sidebar's CSS minimum: SIDEBAR_MIN while the window leaves CENTER_FLOOR beside it, then less (#2362). Two fixed
 * minimums would push the conversation past the window's right edge below their sum. `100%` is the lanes' row, the window.
 */
export const sidebarFloor = (zoom: number): string => `min(${SIDEBAR_MIN / zoom}px, 100% - ${CENTER_FLOOR / zoom}px)`

/**
 * The layout is in zoom coordinates and `innerWidth` in real pixels, so the room is divided by `zoom`; the minimum
 * stays in real pixels, or zooming a narrow window lets the panel eat the screen.
 */
function fitWidth(px: number, minReal: number, max: number, otherLane: number, zoom = 1): number {
  const winW = (typeof window === 'undefined' ? 1280 : window.innerWidth) / zoom
  const available = winW - otherLane - CENTER_MIN / zoom
  return Math.min(max, Math.max(Math.round(minReal / zoom), Math.round(Math.min(px, available))))
}

// The newest save of the folded groups (#666): an older one that fails must not undo a later one
let foldSaveSeq = 0

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
    // Only the false→true edge: `onVisibility` fires at mount, and focus and visibilitychange both fire for one alt-tab
    const returning = focused && !get().appFocused
    set({ appFocused: focused })
    // The only signal of work done outside the app (#41), on any project, so every one is measured again
    if (returning) for (const id of Object.keys(get().projects)) get().refreshProjectGit(id)
    // Or an agent CLI updated in a terminal (#297)
    if (returning) void get().checkAgentVersions(false)
  },

  dismissNotices(sessionIds) {
    if (sessionIds.length === 0) return
    const drop = new Set(sessionIds)
    set((s) => {
      const kept = s.notices.filter((n) => !drop.has(n.sessionId))
      // A new array would rerun every effect watching it
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
    set({ panelWidth: fitWidth(px, PANEL_MIN, PANEL_MAX, s.sidebarWidth, s.prefs.textSize) })
    get().saveWorkspace()
  },

  setPanelSplit(share) {
    // Below 15% only the tab strip remains, which reads as gone
    const clamped = Math.min(0.85, Math.max(0.15, share))
    if (clamped === get().panelSplit) return
    set({ panelSplit: clamped })
    get().saveWorkspace()
  },

  setSidebarWidth(px) {
    const s = get()
    // A collapsed panel is a 32px strip
    const panel = s.panelOpen ? s.panelWidth : 32
    set({ sidebarWidth: fitWidth(px, SIDEBAR_MIN, SIDEBAR_MAX, panel, s.prefs.textSize) })
    get().saveWorkspace()
  },

  openFile(path, projectId, sessionId) {
    set({ viewerPath: path, viewerProjectId: projectId ?? null, viewerSessionId: sessionId ?? null, overlay: { kind: 'viewer' } })
  },

  // A path relative to the viewed session's project, as a file link's; through the file tree's port and wording
  async revealFile(path, from, sessionId) {
    const s = get()
    const projectId = from ?? (s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null)
    if (!projectId || !s.platform) return
    // The file manager is this computer's; a file on a linked machine is not in it (#82)
    const machine = s.projects[projectId]?.machine
    if (machine) {
      set({ toast: `${path} is on ${machineNameOf(s.machines, machine)}, not on this computer` })
      return
    }
    try {
      const res = await s.platform.fs.reveal(projectId, path, sessionId ?? undefined)
      if (!res.supported) set({ toast: res.reason ?? 'Showing files is not available here' })
    } catch (e) {
      set({ toast: `Could not show ${path}: ${errorMessage(e)}` })
    }
  },

  openGit(path, staged) {
    // Explicit: a changed file clicked while viewing history returns to changes
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
    // `at`: a new link reaching an open dialog still brings it up again for that link
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
      // Sticking is the default and is not recorded: the map holds only sessions scrolled away from
      if (sticking) return { stickToBottom: omitKey(s.stickToBottom, sessionId) }
      return { stickToBottom: { ...s.stickToBottom, [sessionId]: false } }
    })
  },

  setScrollAnchor(sessionId, anchor) {
    set((s) => {
      if (!anchor) {
        // Left at the bottom: an old anchor kept would be where the next visit lands
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
      // Closing a folder keeps its children's entries, so reopening it brings the whole shape back
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
      // Undone only if still the newest save and list; by value, since a reconnect hands over a new array of the same keys
      if (mine === foldSaveSeq && sameKeys(get().prefs.foldedGroups, next)) {
        set((s) => ({ prefs: { ...s.prefs, foldedGroups: before } }))
      }
      set({ toast: `Could not save that: ${errorMessage(e)}` })
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

  // The screen changes first, so a dropped panel does not wait a round trip; a failure reverts
  async setGridPanels(panels) {
    const platform = get().platform
    if (!platform) return
    const before = get().gridPanels
    /*
     * An app panel leaving the grid by any path closes its view, teardown first (#288). The view is laid over the panel
     * (PinnedApps), not in it, so it stays hidden in the document until `dismissPinnedView` is answered.
     */
    const kept = new Set(panels.map(gridPanelKey))
    for (const p of before) {
      if (p.kind === 'app' && !kept.has(gridPanelKey(p))) void get().dismissPinnedView(gridAppViewKey(p.projectId, p.appId, p.machine))
    }
    set({ gridPanels: panels })
    try {
      set({ gridPanels: sanitizeGridPanels(await platform.agents.setGridView(panels)) })
    } catch (e) {
      set({ gridPanels: before, toast: `Could not save layout: ${errorMessage(e)}` })
    }
  },

  setToast(toast, action) {
    set({ toast, toastAction: toast === null ? null : (action ?? null) })
  },
})
