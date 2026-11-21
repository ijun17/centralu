import type { PanelGroup, PanelTab } from '../panelLayout.js'

/** The shape of the workspace: file tree, evidence panel, sidebar folds. */
export type LayoutSlice = {
  /**
   * Expanded file-tree folders per project (#16): an open folder is a fact about the code, shared by the project's sessions.
   * Not persisted: after a relaunch stale paths would expand into nothing or cost a listDir each on first paint,
   * and the snapshot is written through with no debounce, so persisting it would be an RPC per folder click.
   */
  expandedDirs: Record<string, string[]>
  /**
   * Whether the file tree shows what `.gitignore` hides (#17). On by default: the file looked for is often an untracked one.
   * Global and in the workspace snapshot, like the panel's shape: a way of looking belongs to the person.
   */
  showIgnored: boolean
  /** Whether the evidence lane (git, files) is open: evidence beside the conversation, not a tab that replaces it. */
  panelOpen: boolean
  /** The tab arrangement (#20): one group is the everyday panel, two the split. Global, in the workspace snapshot. */
  panelLayout: PanelGroup[]
  /** The top group's share of a two-group split (0.15–0.85), in the snapshot. */
  panelSplit: number
  panelWidth: number
  sidebarWidth: number
  /**
   * Projects whose session list is folded (#205), in the workspace snapshot. Only the name row's arrow folds:
   * the name opens the project screen (#206). A folded row reports its waiting sessions (`FoldSummary`).
   */
  foldedProjects: string[]
  toggleProjectFold(projectId: string): void
  /**
   * Folds or unfolds a sidebar group (#666): a session's children, or an app's sessions. Kept in `prefs.foldedGroups`,
   * not the snapshot. The screen changes at once; a failed save is said in a toast and undone.
   */
  setGroupsFolded(keys: string[], folded: boolean): void
  /**
   * Forgets folds of groups that are gone (#666), so they do not fill the preference's cap and push out live ones.
   * A key it cannot judge (another machine's, maybe only unlinked) stays. See `deadFoldKeys`.
   */
  pruneFoldedGroups(): void
  /** Unfolds only this project and folds all the rest (#205). */
  foldOtherProjects(projectId: string): void
  saveWorkspace(): void
  togglePanel(open?: boolean): void
  /** Opens the panel too: what was picked must be visible. */
  setPanelTab(tab: PanelTab): void
  /** Takes the output of panelLayout.ts's pure functions; the store only wires and persists (docs/state-management.md §2). */
  setPanelLayout(groups: PanelGroup[]): void
  setPanelSplit(share: number): void
  setPanelWidth(px: number): void
  setSidebarWidth(px: number): void
  toggleDir(projectId: string, path: string): void
  setShowIgnored(show: boolean): void
}
