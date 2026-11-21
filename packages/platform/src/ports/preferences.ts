import type {
  UiPreferences,
  UiPreferencesPatch,
  ThemeFileContent,
  ThemeFileEntry,
} from '@cc/protocol/client'

export type WorkspaceSnapshot = {
  focusedSessionId?: string | null
  /**
   * focus, grid or assistant: restoring the session in another view reads as the app forgetting. Loosely typed like
   * panelLayout: a snapshot is a file, the UI validates.
   */
  view?: string
  /** When `view` was 'app' (M4 B-2); skipped on restore when the app is gone */
  focusedApp?: { projectId: string | null; appId: string; machine?: string | null } | null
  panelOpen?: boolean
  /**
   * Stacked groups, each tabs plus its active one (#20); one for the whole app, as a way of looking, not project state.
   * Loosely typed: the UI sanitizes it (store/panelLayout.ts).
   */
  panelLayout?: { tabs: string[]; active: string }[]
  /** The top group's share (0.15–0.85), with two groups */
  panelSplit?: number
  panelWidth?: number
  sidebarWidth?: number
}

/**
 * `<data>/themes/<id>.json`, read, written and watched by the host (#312). A change from anywhere comes as
 * `themes_changed`, and the screen reads the whole list again.
 */
export interface ThemesPort {
  list(): Promise<ThemeFileEntry[]>
  /** Atomic; `id` null creates one named after the theme */
  save(id: string | null, content: ThemeFileContent): Promise<ThemeFileEntry>
  importFile(path: string): Promise<ThemeFileEntry>
  /** To the OS trash; only the desktop app has one */
  remove(id: string): Promise<{ supported: boolean; reason?: string }>
  /** In the file manager; this is Export */
  reveal(id: string): Promise<{ supported: boolean; reason?: string }>
}

/**
 * Separate from the workspace snapshot on purpose: the snapshot is overwritten whole on the way out, and a stale
 * preference saved along with it would silently revert the person's choice.
 */
export interface PreferencesPort {
  /** On failure the caller uses defaults; never blocks the app */
  load(): Promise<UiPreferences>
  /** Writes only what changed; answers the whole record */
  save(patch: UiPreferencesPatch): Promise<UiPreferences>
}

export interface WorkspacePort {
  save(snapshot: WorkspaceSnapshot): Promise<void>
  load(): Promise<WorkspaceSnapshot | null>
}
