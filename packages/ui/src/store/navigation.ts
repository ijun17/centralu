import type { AppState, StoreGet, StoreSet } from './state.js'
import { step, type Screen } from './navHistory.js'
import { screenExists } from './screens.js'

/** True while `navigate` puts a recorded screen back, so `recordScreen` does not record it as a new visit */
export let navigating = false

function navigate(get: () => AppState, set: (partial: Partial<AppState>) => void, dir: -1 | 1): void {
  const st = get()
  const { history, screen } = step(st.nav, dir, (x) => screenExists(st, x))
  navigating = true
  try {
    if (history !== st.nav) set({ nav: history })
    if (!screen) return
    // Through the actions a click uses, so a screen comes back exactly as it opens
    if (screen.kind === 'settings') {
      st.toggleSettings(true)
      return
    }
    if (get().settingsOpen) st.toggleSettings(false)
    if (screen.kind === 'file' || screen.kind === 'git') {
      if (screen.under) show(st, screen.under)
      if (screen.kind === 'file') st.openFile(screen.path, screen.projectId, screen.sessionId)
      else if (screen.sub === 'history' && screen.sha) st.openCommit(screen.sha)
      else if (screen.sub === 'branches') st.openBranches()
      else st.openGit(screen.path ?? undefined, screen.staged ?? undefined)
      return
    }
    if (get().overlay) st.closeOverlay()
    show(st, screen)
  } finally {
    navigating = false
  }
}

function show(st: AppState, screen: Screen): void {
  switch (screen.kind) {
    case 'session':
      st.focusSession(screen.id)
      break
    case 'project':
      st.focusProject(screen.id)
      break
    case 'app':
      st.openApp(screen.projectId, screen.appId, { machine: screen.machine })
      break
    case 'grid':
    case 'assistant':
      st.setView(screen.kind)
      break
  }
}

type NavigationActions = Pick<AppState, 'focusProject' | 'setView' | 'goBack' | 'goForward'>

export const navigationActions = (set: StoreSet, get: StoreGet): NavigationActions => ({
  focusProject(id) {
    set(() => ({
      focusedProjectId: id,
      // Always, even for the project already focused: the click asks for the project screen
      focusedSessionId: null,
      // The project screen exists only in the focus lane (as in `focusSession`)
      view: 'focus',
      viewerPath: null,
      viewerProjectId: null,
      viewerSessionId: null,
      overlay: null,
    }))
    get().saveWorkspace()
  },

  setView(view) {
    // Picking a screen passes the intro (#63); a file or git page over the last one closes (owner, 2026-10-18)
    set({ view, introSeen: true, overlay: null })
    get().saveWorkspace()
  },

  goBack() {
    navigate(get, set, -1)
  },

  goForward() {
    navigate(get, set, 1)
  },
})
