import type { NavHistory } from '../navHistory.js'

/** Which screen is showing, and back/forward between screens. */
export type NavigationSlice = {
  /** The screen shown; the focus view and the grid draw the same session state and hold none of their own. */
  view: 'focus' | 'grid' | 'assistant' | 'app'
  setView(view: 'focus' | 'grid' | 'assistant'): void
  /** docs/state-management.md §5a */
  nav: NavHistory
  /** The previous screen that still exists, if any (`navHistory.step`) */
  goBack(): void
  goForward(): void
}
