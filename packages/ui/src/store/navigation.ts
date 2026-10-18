import type { AppState, StoreGet, StoreSet } from './state.js'
import { step, type Screen } from './navHistory.js'
import { screenExists } from './screens.js'

/**
 * Which screen the window shows: picking the project screen or a view, and going back and forward
 * through the screens history recorded (#374).
 */

/** True while `navigate` puts a recorded screen back, so `recordScreen` does not record it as a new visit */
export let navigating = false

function navigate(get: () => AppState, set: (partial: Partial<AppState>) => void, dir: -1 | 1): void {
  const st = get()
  const { history, screen } = step(st.nav, dir, (x) => screenExists(st, x))
  navigating = true
  try {
    if (history !== st.nav) set({ nav: history })
    if (!screen) return
    /*
     * Through the same doors a click uses, so a screen comes back exactly as it opens: a session unfolds its
     * project, an app gets its pinned view, Settings opens on the category it was left on.
     */
    if (screen.kind === 'settings') {
      st.toggleSettings(true)
      return
    }
    if (get().settingsOpen) st.toggleSettings(false)
    // A file or the git screen: the screen it was opened over first, then the page over it
    if (screen.kind === 'file' || screen.kind === 'git') {
      if (screen.under) show(st, screen.under)
      if (screen.kind === 'file') st.openFile(screen.path, screen.projectId)
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

/** Puts a plain screen on through the door a click uses */
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
    case 'orchestrator':
      st.setView(screen.kind)
      break
  }
}

/** The store's actions that change the screen and step through its history */
type NavigationActions = Pick<AppState, 'focusProject' | 'setView' | 'goBack' | 'goForward'>

export const navigationActions = (set: StoreSet, get: StoreGet): NavigationActions => ({
  /** Selects only the project — git, files and the viewer can be viewed without picking a session */
  focusProject(id) {
    set(() => ({
      focusedProjectId: id,
      /*
       * Picking a project **always** releases session focus — the click was made to see the project
       * screen. This used to release it only when a *different* project was picked, so clicking that
       * same project's name while already viewing one of its sessions left the session in place,
       * looking as if nothing had happened (user report 2026-09-28). The only callers are the
       * sidebar's name and the palette when it picks a project with no session — both want the
       * project screen.
       */
      focusedSessionId: null,
      // The project screen exists only in the focus lane — what the person picked must be shown (the same
      // rule as `focusSession`). This combination actually arose once onboarding started opening the
      // orchestrator view first (#63) (caught by e2e).
      view: 'focus',
      viewerPath: null,
      viewerProjectId: null,
      overlay: null,
    }))
    get().saveWorkspace()
  },

  setView(view) {
    /*
     * Picking a screen = having passed the intro (#63).
     *
     * A person who clicks the grid or the orchestrator from the sidebar beside the intro screen is
     * saying "enough explaining, I want to use the app." If that click did not change the screen, the
     * button would look broken; hiding the button instead would force reading the intro — squarely
     * against this onboarding's premise of never forcing a conversation.
     */
    // Another screen is another page: a file or the git screen open over the last one closes (owner, 2026-10-18)
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
