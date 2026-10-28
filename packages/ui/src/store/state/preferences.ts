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
  /**
   * The theme files in the data folder's `themes/` (#312), as the host last read them —
   * re-read in full on `themes_changed` (a save from Settings, an editor, an agent).
   */
  themeFiles: ThemeFileEntry[]
  /**
   * The last version of each theme file that read cleanly. A file someone is halfway through
   * editing comes back broken; the screen keeps showing this version of it until it reads again,
   * rather than dropping to the preset mid-edit.
   */
  lastGoodThemes: Record<string, ThemeFileEntry>
  refreshThemes(): Promise<void>
  /**
   * Where this install stands relative to the registry (issue #43).
   *
   * **Owned entirely by the host** — not a single field here is computed. Both checking and
   * installing happen on that side; this value is only the seat where the result lands once it
   * arrives. `null` means it has not even been asked yet (before connecting), not "it is up to
   * date."
   */
  update: UpdateStatus | null
  /**
   * The agent CLIs installed on this machine, and whether idle sessions move to a newer one by themselves (#297).
   * Owned by the host like `update`; null until the host has answered, or when it is too old to know.
   */
  agentVersions: AgentVersions | null
  /** Where Centralu's own install and sign-in of a tool stands on this computer (`tool_setup`, #59); a tool not heard of has no entry */
  toolSetups: Partial<Record<string, ToolSetup>>
  /** When this host puts idle sessions to sleep (#568); null until it has answered, or when it is too old to know */
  sleepPolicy: SleepPolicy | null
  /**
   * What this person has chosen about the screen (protocol's `UiPreferences`).
   *
   * **Fetched once at startup and seated here.** Letting the consumer (the composer) ask on demand
   * would mean it runs on defaults while the answer is late, and the rule changes out from under
   * the person's fingers — if the send key changed that way, the message would already be sent by
   * the time it did.
   */
  prefs: UiPreferences
  /**
   * The calls of the limited credential waiting for the person (#1405): a program that is not this window asked for
   * something that cannot be undone, and the host holds it until the person answers. Owned by the host; this is the
   * last list it gave, kept current by its events and read again after every reconnect.
   */
  hostRequests: HostRequest[]
  /** How many host request events this window has heard: a list read before the latest of them is not laid over it */
  hostRequestsHeard: number
  /** Reads the waiting requests again. Never throws; an older host that does not know them leaves the list as it was */
  refreshHostRequests(): Promise<void>
  /** The person's answer; a request no longer waiting is said in a toast, and the list is read again */
  answerHostRequest(requestId: string, decision: 'allow' | 'deny'): Promise<void>
  /** Checks right now (the settings button). A failure stays on screen but is not thrown */
  checkUpdate(force?: boolean): Promise<void>
  /** Turns periodic checking on and off */
  setUpdateAuto(enabled: boolean): Promise<void>
  /** "Apply updates automatically when idle" on and off (#352) */
  setUpdateAutoApply(enabled: boolean): Promise<void>
  /**
   * Reads the installed agent CLIs (#297). `force: false` is the window gaining focus: the host answers with a reading
   * from moments ago rather than reading again. Never throws; an older host that does not know it leaves this null.
   */
  checkAgentVersions(force?: boolean): Promise<void>
  /** "Move idle sessions to a newly installed agent CLI" on and off (#297) */
  setAgentAutoApply(enabled: boolean): Promise<void>
  /** Reads when idle sessions go to sleep (#568). Never throws; an older host leaves it null */
  loadSleepPolicy(): Promise<void>
  /** "Put idle sessions to sleep after" (#568); null never */
  setSleepAfter(afterMinutes: number | null): Promise<void>
  /** Restarts every idle session that runs an older CLI on the installed one (#297) — the header's action */
  applyAgentVersions(machine?: string | null): Promise<void>
  /**
   * Changes screen settings — sends **only what changed**.
   *
   * The screen seats the record the host hands back as is (not an optimistic update): if a setting
   * that failed to be recorded is only turned on in the screen, the next time it is turned on it is
   * quietly back where it started.
   */
  setPrefs(patch: UiPreferencesPatch): Promise<void>
  /**
   * Reads the preferences again (#1306): on `prefs_changed`, when another window or the orchestrator changed one, and after a
   * reconnect. Never throws. The notification switches come with them, except while this window's own change to them is on
   * its way (its answer would otherwise be overwritten by an older reading).
   */
  refreshPrefs(): Promise<void>
  /** Installs the new version. **Does not restart** — it tells the person and stops when done */
  applyUpdate(): Promise<void>
  /**
   * "Apply now" (#352): relaunches the desktop window into the installed version. The keeper is
   * told first and holds every agent through it. A refusal (the keeper too old to hold on with
   * background mode off, the bundle not replaced) is shown, never silent. Resolves with that refusal, or null once the
   * relaunch started.
   */
  applyUpdateNow(): Promise<string | null>
  /**
   * An agent's "Apply now" (#665): answers an `update_apply_request` with this window's checks, and keeps the ticket
   * the host gives back. Nothing relaunches here
   */
  answerApplyRequest(requestId: string): Promise<void>
  /** The `update_apply_go` naming this window's ticket: checks again, runs `applyUpdateNow`, reports the outcome */
  runApplyRequest(requestId: string, ticket: string, unasked?: boolean): Promise<void>
}
