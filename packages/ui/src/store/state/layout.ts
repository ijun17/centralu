import type { PanelGroup, PanelTab } from '../panelLayout.js'

/** The shape of the workspace: file tree, evidence panel, sidebar folds. */
export type LayoutSlice = {
  /**
   * Which folders are expanded in the file tree — **per project** (issue #16).
   *
   * The tree rows used to hold this themselves, so it went away with the component: moving
   * between sessions collapsed everything and you dug down the same path again. Third time
   * we have made this mistake (drafts, the elapsed count, this).
   *
   * Per project, not per session, and the difference is not an accident. A draft is
   * something *you* were saying to *one* agent, so it belongs to that session. An expanded
   * folder is a fact about **the code** — `src/features/session` is where the work is no
   * matter which of that project's sessions you happen to be reading. Two sessions on the
   * same repo want the same tree open; two projects almost never do.
   *
   * **Not persisted, deliberately.** The complaint was "every time", and every time meant
   * every session switch — dozens an hour. A relaunch happens once a day, and it is exactly
   * the moment the tree is most likely to be wrong: branches moved, folders were deleted,
   * a worktree came and went. Restoring yesterday's paths would either quietly expand into
   * nothing or fire a listDir per stale path on first paint, which is the cost the lazy
   * tree exists to avoid. There is a mechanical reason too: the workspace snapshot is one
   * layout record written straight through to the host with no debounce, so persisting this
   * would mean an RPC per folder click. If a relaunch turns out to hurt, it can move there
   * later — but it should arrive as its own decision, not as a side effect of this one.
   */
  expandedDirs: Record<string, string[]>
  /**
   * Whether the file tree shows what `.gitignore` hides (issue #17).
   *
   * **Defaults to on.** It used to default to off, and that was the wrong way round for a
   * tree you open to *look at a file*: the file you want is often exactly the one git does
   * not track — a `.env`, a build artefact you are checking, a local note. A tree that
   * silently omits it does not read as filtered, it reads as "that file is not there", and
   * the toggle that would explain it is one line of small text you were not looking at.
   *
   * Still a toggle rather than always-on, because of *what* is behind it: not a curiosity
   * or two but `node_modules`, `dist`, `.next` — thousands of entries that sort in among
   * `src`. Whoever finds that unusable turns it off once, and it stays off. Shown rows read
   * in ink-faint, since "the repo does not track this" is background information, not urgency.
   *
   * **Global, and remembered** — unlike expanded folders, which belong to their project.
   * That difference is the point: an open folder is a fact about a repo, while this is a
   * way of looking, and a way of looking belongs to the person. It sits with panelOpen and
   * panelTab in the workspace snapshot for the same reason, and unlike a folder click it is
   * flipped rarely, so a write per flip costs nothing.
   */
  showIgnored: boolean
  /**
   * Whether the evidence lane (git, files) is open.
   * Why it is a panel and not a tab: git status is not a screen that **replaces** the conversation,
   * it is **evidence** for what the conversation claims. Grouping things that are not alternatives
   * to each other into tabs produces "where do I see that?" (this actually came up during
   * dogfooding).
   */
  panelOpen: boolean
  /**
   * The tab arrangement (#20): groups stacked vertically, each an ordered tab list
   * plus its active tab. One group is the everyday panel; two is the split. Global —
   * one arrangement for the whole app, not per project — and carried in the workspace
   * snapshot, because the panel's shape is a way of looking, and a way of looking
   * belongs to the person (the same call as showIgnored, #17).
   */
  panelLayout: PanelGroup[]
  /**
   * The **share the top group takes** of the two vertically split groups (0.15–0.85, per a
   * dogfooding request). Meaningless with a single group. A fixed 50/50 split could not capture the
   * actual use of "the terminal can be narrow, but the diff needs to be wide" — the split ratio is
   * also a way of viewing, so it is carried in the snapshot.
   */
  panelSplit: number
  /**
   * Width of the evidence panel (px). Using the terminal makes people want to widen it, so it must be
   * adjustable
   */
  panelWidth: number
  /** Width of the session list (px) */
  sidebarWidth: number
  /**
   * Projects whose session list is folded (#205, user request 2026-09-28 — the sidebar got crowded
   * as projects grew in number).
   *
   * Remembered per project and carried in the workspace snapshot — the sidebar is a way of viewing
   * the whole app, and a way of viewing belongs to the person (the same call as `showIgnored`, #17).
   * The only door to folding is the arrow on the name row: the name is where the project screen is
   * opened from (#206), so doubling it as the fold control would always put one of the two purposes
   * at odds with the other.
   *
   * Folding does not hide the signal — the name row instead reports the number of sessions waiting
   * (the sidebar's `FoldSummary`).
   */
  foldedProjects: string[]
  /** Folds or unfolds that project's session rows (#205) */
  toggleProjectFold(projectId: string): void
  /**
   * Folds or unfolds a sidebar group (#666): the children a session started, or the sessions an app owns.
   * Kept in the screen preferences (`prefs.foldedGroups`, `foldGroupsHiding` names the keys), not the workspace
   * snapshot: it is a way of looking, and it survives a restart the same way the other preferences do. The screen
   * changes at once; the save follows, and a failed one is said in a toast and undone.
   */
  setGroupsFolded(keys: string[], folded: boolean): void
  /**
   * Forgets the folds of groups that no longer exist (#666): a deleted session's children, a removed app's sessions.
   * Left in, they would crowd the preference's cap and, past it, push out folds that are still in use. Runs where
   * something can have gone: a deletion, a list read again, a project removed, the first attach. A key it cannot
   * judge (another machine's, which may just be unlinked for now) stays. See `deadFoldKeys`.
   */
  pruneFoldedGroups(): void
  /**
   * Opens whatever hides these sessions' rows in the sidebar, without picking one (#1416): each one's project and the
   * groups its row stands in (`foldGroupsHiding`). The parent's pointer to what it handed to another machine uses it
   * before it scrolls to them.
   */
  revealSessions: (ids: readonly string[]) => void
  /** Unfolds only this project and folds all the rest (#205) — for focusing on one in a single move */
  foldOtherProjects(projectId: string): void
  saveWorkspace(): void
  togglePanel(open?: boolean): void
  /** Picking a tab opens the panel even if it was collapsed — what you picked must be visible */
  setPanelTab(tab: PanelTab): void
  /**
   * Replace the tab arrangement (#20). Callers hand in the output of the pure functions
   * in panelLayout.ts (moveTab / splitTab / …) — the store only wires and persists, per
   * docs/state-management.md §2.
   */
  setPanelLayout(groups: PanelGroup[]): void
  setPanelSplit(share: number): void
  setPanelWidth(px: number): void
  setSidebarWidth(px: number): void
  /** Open or close a folder in the file tree. The project owns it, not the session (#16) */
  toggleDir(projectId: string, path: string): void
  /** Show or hide what .gitignore hides (#17) */
  setShowIgnored(show: boolean): void
}
