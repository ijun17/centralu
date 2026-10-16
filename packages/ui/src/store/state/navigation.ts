import type { NavHistory } from '../navHistory.js'

/** Which screen is showing, and back/forward between screens. */
export type NavigationSlice = {
  /**
   * The grid.
   *
   * `view` is the value that picks one screen — the focus view and the grid only show **the same
   * session state** differently, so they never hold separate session data, only a different way of
   * viewing it. (That way, changing a model in the grid follows through to the sidebar and the focus
   * view too.)
   */
  /**
   * What is being viewed right now.
   *   focus        a single session (default)
   *   grid         the grid — controlling by eye
   *   orchestrator the orchestrator — controlling by talking
   */
  view: 'focus' | 'grid' | 'orchestrator' | 'app'
  setView(view: 'focus' | 'grid' | 'orchestrator'): void
  /**
   * Back and forward between screens, like a web browser (#374). Every screen change is recorded by one subscriber
   * at the bottom of this file (`recordScreen`), whichever action made it, so a new way of jumping somewhere gets
   * history without doing anything. Not saved: a restart begins a fresh history at the screen it restores.
   */
  nav: NavHistory
  /** Shows the previous screen that still exists; nothing when there is none (`navHistory.step`) */
  goBack(): void
  goForward(): void
}
