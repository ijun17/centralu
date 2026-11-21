import type {
  UiPreferences,
  UiPreferencesPatch,
  ThemeFileEntry,
  UpdateStatus,
  AgentVersions,
  ToolSetup,
  SleepPolicy,
  HostRequest,
} from '@cc/protocol/client'

/** Updates, agent versions, screen preferences and theme files. */
export type PreferencesSlice = {
  /** The data folder's `themes/` files (#312) as the host last read them; read again in full on `themes_changed`. */
  themeFiles: ThemeFileEntry[]
  /** Each theme file's last clean read: a file broken mid-edit keeps showing it instead of dropping to the preset. */
  lastGoodThemes: Record<string, ThemeFileEntry>
  refreshThemes(): Promise<void>
  /** This install against the registry (#43), owned by the host. `null` is not asked yet, not "up to date". */
  update: UpdateStatus | null
  /** Installed agent CLIs and the auto-move setting (#297), owned by the host; null until answered or from an older host. */
  agentVersions: AgentVersions | null
  /** Centralu's own install and sign-in of each tool here (`tool_setup`, #59); a tool not heard of has no entry */
  toolSetups: Partial<Record<string, ToolSetup>>
  /** When this host puts idle sessions to sleep (#568); null until it has answered, or when it is too old to know */
  sleepPolicy: SleepPolicy | null
  /**
   * Read at startup and seated here, not asked for on demand: a late answer would change a rule such as the send key
   * under the person's fingers.
   */
  prefs: UiPreferences
  /**
   * Limited-credential calls the host holds for the person's answer (#1405): another program asked for something that
   * cannot be undone. The host's last list, kept current by its events and read again after every reconnect.
   */
  hostRequests: HostRequest[]
  /** How many host request events this window has heard: a list read before the latest of them is not laid over it */
  hostRequestsHeard: number
  /** Reads the waiting requests again. Never throws; an older host that does not know them leaves the list as it was */
  refreshHostRequests(): Promise<void>
  /** The person's answer; a request no longer waiting is said in a toast, and the list is read again */
  answerHostRequest(requestId: string, decision: 'allow' | 'deny'): Promise<void>
  /** A failure stays on screen but is not thrown */
  checkUpdate(force?: boolean): Promise<void>
  setUpdateAuto(enabled: boolean): Promise<void>
  setUpdateAutoApply(enabled: boolean): Promise<void>
  /**
   * Reads the installed agent CLIs (#297). `force: false` is the window gaining focus: the host answers with a reading
   * from moments ago rather than reading again. Never throws; an older host that does not know it leaves this null.
   */
  checkAgentVersions(force?: boolean): Promise<void>
  setAgentAutoApply(enabled: boolean): Promise<void>
  /** Never throws; an older host leaves it null */
  loadSleepPolicy(): Promise<void>
  /** null: never */
  setSleepAfter(afterMinutes: number | null): Promise<void>
  /** Restarts every idle session on an older CLI on the installed one (#297) */
  applyAgentVersions(machine?: string | null): Promise<void>
  /** Sends only what changed, and seats the record the host returns: no optimistic update (docs/state-management.md §1). */
  setPrefs(patch: UiPreferencesPatch): Promise<void>
  /**
   * On `prefs_changed` and after a reconnect (#1306). Never throws. The notification switches are skipped while this
   * window's own change to them is on its way, or an older reading would overwrite its answer.
   */
  refreshPrefs(): Promise<void>
  /** Installs the new version; does not restart */
  applyUpdate(): Promise<void>
  /**
   * "Apply now" (#352): relaunches into the installed version; the keeper is told first and holds every agent through it.
   * Resolves with a refusal (keeper too old with background mode off, bundle not replaced), shown, or null once started.
   */
  applyUpdateNow(): Promise<string | null>
  /** An agent's "Apply now" (#665): answers with this window's checks and keeps the host's ticket; relaunches nothing */
  answerApplyRequest(requestId: string): Promise<void>
  /** The `update_apply_go` naming this window's ticket: checks again, runs `applyUpdateNow`, reports the outcome */
  runApplyRequest(requestId: string, ticket: string, unasked?: boolean): Promise<void>
}
