/**
 * The wide surface over the conversation (`null`: nothing covers it); `git` with a `path` opens that file's diff first.
 * `pick` counts opens: the change list beside the view stays clickable (#15), so a second click on the same row is a
 * second instruction with identical fields, told apart only by a number that moves.
 */
export type Overlay =
  | { kind: 'viewer' }
  | {
      kind: 'git'
      path?: string | null
      /** Which group was clicked — a partially staged file appears in both groups (#160) */
      staged?: boolean
      sha?: string | null
      sub?: 'changes' | 'history' | 'branches'
      pick: number
    }
  | null

/** A button on a toast. `run` is called at most once: pressing it puts the toast away */
export type ToastAction = { label: string; run: () => void }

/** Layers over the screen: overlay, inbox, palette, usage, settings, the file viewer and the toast. */
export type LayersSlice = {
  /** Dismissed with Escape; the conversation under it keeps its scroll position. */
  overlay: Overlay
  inboxOpen: boolean
  toast: string | null
  /**
   * The one action a toast carries (#1512), e.g. "Undo" on an archive. A toast said without an action clears it
   * (`stampToasts`), so a later failure never shows an old Undo.
   */
  toastAction: ToastAction | null
  /**
   * Counts every toast said (`stampToasts`), the same words again included (#842): the toast's timer restarts on it,
   * so a failure said twice in a row does not vanish early.
   */
  toastAt: number
  /** A project-relative path. */
  viewerPath: string | null
  /**
   * The file's project, when the opener said so (#182): in a WKWebView a button click does not move focus, so a grid
   * panel's file link would otherwise open in the focused panel's project. `null` follows focus.
   */
  viewerProjectId: string | null
  /** The session whose folder (worktree) the file is read through (#1209); `null` reads the project's own folder. */
  viewerSessionId: string | null
  paletteOpen: boolean
  /**
   * Screen-covering layers open now (#158, `useOpenLayer`): their open state is local to each component. The approval
   * card's y/n/a keys check it, so y on a "Delete this session?" window does not approve a command behind it.
   */
  openLayers: number
  /** The usage modal (FR-9) */
  usageOpen: boolean
  settingsOpen: boolean
  /** Opens Settings on one category, e.g. Machines from a machine's badge in the sidebar */
  settingsRequest: { category: string; at: number } | null
  openSettingsAt(category: string): void
  /** `projectId` defaults to the focused session's project; `sessionId` reads from that session's worktree (#1209). */
  openFile(path: string, projectId?: string | null, sessionId?: string | null): void
  /** Reveals a conversation's file link in Finder, under the link's project and session folder (#1209). */
  revealFile(path: string, projectId?: string | null, sessionId?: string | null): Promise<void>
  /** `staged` picks the diff's side; without it, the path's first entry. */
  openGit(path?: string, staged?: boolean): void
  openCommit(sha: string): void
  openBranches(): void
  closeOverlay(): void
  toggleInbox(open?: boolean): void
  togglePalette(open?: boolean): void
  toggleUsage(open?: boolean): void
  toggleSettings(open?: boolean): void
  setToast(msg: string | null, action?: ToastAction): void
}
