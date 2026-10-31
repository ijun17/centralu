import type {
  UiPreferences,
  UiPreferencesPatch,
  ThemeFileContent,
  ThemeFileEntry,
} from '@cc/protocol/client'

/** Workspace snapshot (C-3) — returns to the place being viewed even after the window is closed and reopened */
export type WorkspaceSnapshot = {
  focusedSessionId?: string | null
  /**
   * Which of the three views was showing — focus, grid, or orchestrator. Restoring the
   * focused session without this landed a person who quit from the grid back in the focus
   * view: the *session* came back but the *way of looking* did not, which reads as the app
   * forgetting. Loosely typed like panelLayout: a snapshot is a file, the UI validates.
   */
  view?: string
  /**
   * The app being viewed as a pinned screen (M4 B-2) — what was being viewed when `view` was
   * 'app'. An app is identified by (project, id). If that app is not in the list when
   * restoring (its folder is gone), this is silently skipped.
   */
  focusedApp?: { projectId: string | null; appId: string; machine?: string | null } | null
  /** Whether the evidence panel (git/files) was open */
  panelOpen?: boolean
  /**
   * The panel's tab arrangement (#20): vertically stacked groups, each an ordered tab
   * list plus its active tab. One arrangement for the whole app — the panel is a way
   * of looking, not project state. Loosely typed here on purpose: a snapshot is a file
   * on disk, and the UI sanitizes whatever comes back (store/panelLayout.ts).
   */
  panelLayout?: { tabs: string[]; active: string }[]
  /** The share the top group takes up (0.15–0.85). Only meaningful when there are two groups — the split ratio is also part of the way of looking */
  panelSplit?: number
  /** Evidence panel width (px) */
  panelWidth?: number
  /** Session list width (px) */
  sidebarWidth?: number
}

/**
 * Custom themes as files (#312): `<data>/themes/<id>.json`, read, written and watched by the host.
 *
 * The list arrives whole (a handful of small files); a change to the folder — from Settings, an
 * editor or an agent — arrives as `themes_changed` on the event stream, and the screen refetches.
 */
export interface ThemesPort {
  list(): Promise<ThemeFileEntry[]>
  /** Writes a theme file atomically; `id` null creates one named after the theme */
  save(id: string | null, content: ThemeFileContent): Promise<ThemeFileEntry>
  /** Copies a theme file from a path on disk into the folder (Import) */
  importFile(path: string): Promise<ThemeFileEntry>
  /** Moves a theme file to the OS trash. Only the desktop app has a trash. */
  remove(id: string): Promise<{ supported: boolean; reason?: string }>
  /** Shows a theme file in the file manager (Export: the file is already a file) */
  reveal(id: string): Promise<{ supported: boolean; reason?: string }>
}

/**
 * Screen preferences (UiPreferences).
 *
 * **Deliberately kept separate from the workspace snapshot.** The snapshot is "what was
 * placed where" and is fine to overwrite wholesale on the way out; preferences are "what this
 * person chose" and must never be overwritten that way. Mixing them into one blob would make
 * every place that saves layout also save preferences, and if even one of those places is
 * holding a stale value, the chosen setting silently reverts.
 */
export interface PreferencesPort {
  /** Once at startup. On failure the caller fills in defaults — this never blocks the app */
  load(): Promise<UiPreferences>
  /** Writes only what changed. What comes back is the whole thing after it was recorded */
  save(patch: UiPreferencesPatch): Promise<UiPreferences>
}

export interface WorkspacePort {
  save(snapshot: WorkspaceSnapshot): Promise<void>
  load(): Promise<WorkspaceSnapshot | null>
}
