/**
 * The wide surface that covers the conversation. `null` means nothing is covering it.
 *  - viewer: a single file (`viewerPath`)
 *  - git: the whole of changes, history and branches. If `path` is given, it opens that file's
 *    diff first
 *
 * `pick` counts opens instead of naming one. The wide view now outlives the click that made
 * it — the change list beside it is no longer covered (#15), so it keeps being clicked while
 * the view is up. That makes "open this file" an **event**, not a state: two clicks on the
 * same row are two instructions, and the fields below are identical for both. Without a
 * number that moves, the second one is indistinguishable from no click at all.
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
  /**
   * The wide surface. Code and diffs cannot be read in a 360px panel.
   * It covers the conversation and is dismissed with Escape — coming back, the conversation still
   * has its scroll position intact.
   */
  overlay: Overlay
  inboxOpen: boolean
  toast: string | null
  /**
   * The one action a toast carries (#1512): "Undo" on an archive. It lives as long as the toast and no longer: every write
   * that says a toast without an action clears it (`stampToasts`), so a later failure never shows an old Undo.
   */
  toastAction: ToastAction | null
  /**
   * Counts every toast said, the same words again included (#842 item 14). The toast's timer restarts on it: keyed on
   * the words alone, a failure said twice in a row did not restart it, and the second one vanished early or at once.
   * Raised by the store's `set` whenever a write says a toast (`stampToasts`), so no caller has to remember it.
   */
  toastAt: number
  /** The file the code viewer is showing (a project-relative path) */
  viewerPath: string | null
  /**
   * Which project that file belongs to — only when the side that opened it said so (#182). A file
   * link in the grid carries its own panel's project. Picking from the focused session, in a WKWebView
   * where a button click does not move focus, meant a link in an adjacent panel opened the same
   * relative path in the focused panel's project instead. `null` follows focus, as before.
   */
  viewerProjectId: string | null
  /**
   * The session whose folder that file is in, when a session's file link opened it (#1209): its worktree, read through
   * the session (`fs.readFile`'s `sessionId`). A worktree session's link used to open the main checkout's copy. `null`
   * reads the project's own folder, as the file tree and the git panel do.
   */
  viewerSessionId: string | null
  paletteOpen: boolean
  /**
   * The number of windows currently open (#158) — raised when a screen-covering layer like `Modal`
   * or the command window opens and lowered when it closes (`useOpenLayer`). A window's open state
   * is usually local state on that component, so the store has no other way to know. Without the
   * approval card's y/n/a checking this value, pressing y to confirm a "Delete this session?" window
   * had let through a command hidden behind it.
   */
  openLayers: number
  /** The usage modal (FR-9) */
  usageOpen: boolean
  settingsOpen: boolean
  /** Opens Settings on one category, e.g. Machines from a machine's badge in the sidebar */
  settingsRequest: { category: string; at: number } | null
  openSettingsAt(category: string): void
  /**
   * Opens a file in the wide overlay (the common entry point for the file tree and the git panel).
   * If `projectId` is given, the file belongs to that project — otherwise the focused session's project.
   * `sessionId`: the file is in that session's folder (its worktree), as a session's file link says (#1209)
   */
  openFile(path: string, projectId?: string | null, sessionId?: string | null): void
  /**
   * Right-click on a file link in the conversation — reveals it in Finder under the link's own project (or the currently
   * viewed session's project if none is given), in the link's session's folder when it names one (#1209)
   */
  revealFile(path: string, projectId?: string | null, sessionId?: string | null): Promise<void>
  /**
   * Opens the full git screen (changes, history, branches) as an overlay. If `path` is given, opens
   * that file's diff first. `staged` says which side the diff is — if not given, opens that path's
   * first entry.
   */
  openGit(path?: string, staged?: boolean): void
  /** Expands a single commit in the wide space (a diff cannot be read in 340px) */
  openCommit(sha: string): void
  /** The branch-switching screen */
  openBranches(): void
  closeOverlay(): void
  toggleInbox(open?: boolean): void
  togglePalette(open?: boolean): void
  toggleUsage(open?: boolean): void
  toggleSettings(open?: boolean): void
  setToast(msg: string | null, action?: ToastAction): void
}
