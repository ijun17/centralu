import type {
  AppCreated,
  AppToolResult,
  NewAppSpec,
} from '@cc/platform/ports'

/**
 * A pinned view (M4 B-2, docs/apps/views.md "Pinned, in the main area"): survives a focus change, comes down only when
 * closed or when the app goes. `opening`: the host is calling `home`; `restarting`: the host tears the app down and
 * clears its state, then it goes to `idle` and reopens.
 */
export type PinnedView = {
  key: string
  projectId: string | null
  appId: string
  /** A linked machine's user-folder app (#82); absent for this computer's apps and for project apps */
  machine?: string | null
  phase: 'idle' | 'opening' | 'open' | 'failed' | 'restarting'
  instanceId: string | null
  toolInput: Record<string, unknown> | undefined
  toolResult: AppToolResult | undefined
  error: string | null
  /**
   * `ExternalAppInfo.codeStamp` when opened (M4 C-4); a different one in the app list reopens it (`followAppCode`).
   * `null` when unknown at open time, then the first value learned.
   */
  codeStamp?: string | null
  /** Reopened with new code: the header's "Updated" badge shows briefly */
  updatedAt?: number | null
  /** The code changed too often to reopen automatically; the person reopens it. */
  stale?: boolean
}

/**
 * A view under a tool-call card (M4 B-1, docs/apps/views.md "Inline, under the tool card"), its lifetime set by the
 * host's `app_view`. `closing`: teardown sent to the drawn frame, its answer awaited before it comes down; `parked`: a
 * placeholder with the `reason`. Every close goes through `closeInlineView`.
 */
export type InlineView = {
  /** Discovery must not close an instance while its reopen answer is being recovered. */
  reopening?: boolean
  callId: string
  appId: string
  projectId: string | null
  tool: string
  state: 'live' | 'closing' | 'parked'
  instanceId: string | null
  toolInput?: Record<string, unknown>
  toolResult?: AppToolResult
  /** Ended without an answer: the view gets `tool-cancelled` with this reason */
  cancelled?: string
  /** Why the view was not opened (impersonation blocked); it gets no way to reopen */
  rejected?: string
  reason?: string
  /** The host holds the call's input and outcome, so it reopens without calling the tool; false offers only "Open app". */
  kept: boolean
  /** Order of coming alive: the cap closes the oldest first; a reopen gets a new number */
  liveAt: number
  /** As `PinnedView.codeStamp` */
  codeStamp?: string | null
  /** Reopened with new code: the title line's "Updated" badge shows briefly */
  updatedAt?: number
  /** As `PinnedView.stale` */
  stale?: boolean
}

/** App views: pinned views, in-conversation views and the builder pane. */
export type AppViewsSlice = {
  /** The builder session open beside a visible pinned view (M4 C-5, `BuilderPane`): on screen, so its turn end is a sweep. */
  builderPaneSessionId: string | null
  setBuilderPane(sessionId: string | null): void
  /** On screen only while `view` is 'app'; kept when another view is shown, so going back returns to it. */
  focusedApp: { projectId: string | null; appId: string; machine?: string | null } | null
  /** In opening order; hidden ones stay alive too */
  pinnedViews: PinnedView[]
  /** session → call id → view, apart from `chat`: a live view survives the history being read again (`loadHistory`). */
  inlineViews: Record<string, Record<string, InlineView>>
  /** Raised when a drawn inline view's frame comes or goes (`registerInlineFrame`); the value carries no meaning */
  inlineFramesVersion: number
  /**
   * The one way an inline view closes; only a live one, so twice counts once. Teardown first (awaited when a frame is
   * drawn), then the placeholder, then the host closes the instance (a no-op if it already did).
   */
  closeInlineView(sessionId: string, callId: string, reason: string): Promise<void>
  /** Without calling the tool: the host replays the held input and outcome. A failure leaves its reason and no reopen. */
  reopenInlineView(sessionId: string, callId: string): Promise<void>
  /**
   * A view's message, after the person confirmed it (M4 B-1, B-4): an inline view's to its conversation, a pinned view's
   * to the one picked. Returns whether it was sent; a failure is toasted.
   */
  sendViewMessage(sessionId: string, instanceId: string, text: string): Promise<boolean>
  /**
   * `builder: true` opens the builder's conversation beside it (`builderPaneFor`), `runs: true` its Runs panel
   * (`runsPanelFor`): how a grid or project-screen panel, with no room for either, shows them.
   */
  openApp(projectId: string | null, appId: string, opts?: { builder?: boolean; runs?: boolean; machine?: string | null }): void
  /** The pinned view that opens its builder pane when next on screen (`openApp` with `builder`); not saved. */
  builderPaneFor: string | null
  takeBuilderPaneFor(key: string): void
  /** Like `builderPaneFor`, for the Runs panel */
  runsPanelFor: string | null
  takeRunsPanelFor(key: string): void
  /** Without going to it (#203): the project screen's panel and the sidebar's open share one instance and document. */
  ensurePinnedView(projectId: string | null, appId: string): void
  /** Keyed `gridAppViewKey` (#288), apart from the pinned view, so the grid keeps its own document. Idempotent. */
  ensureGridAppView(projectId: string | null, appId: string, machine?: string | null): void
  /** From outside its header (the project screen's ×), teardown first */
  dismissPinnedView(key: string): Promise<void>
  /**
   * Leaves without closing when the screen behind shows the app as a panel anyway (#203), keeping its document.
   * Returns whether it left; if not, the caller closes the view.
   */
  leavePinnedView(key: string): boolean
  /** The host calls `home`; the view calls this when the app can be opened */
  startPinnedView(key: string): Promise<void>
  /** Back to idle when the app can no longer run (lost trust); the caller tears down `AppFrame` first. */
  releasePinnedView(key: string): void
  /** The caller tears down first. If it was on screen, returns to the focus view */
  closeApp(key: string): void
  /** "Restart" (M4 B-6); the caller tears down first. Reopens only after the host has torn down the app and its state. */
  restartApp(key: string): Promise<void>
  /**
   * Stops an app kept running for background work (#1236), its view torn down and closed so nothing here starts it
   * again. The host stops the process (`apps.restart` never starts one); the next need starts it.
   */
  stopApp(app: { key: string; appId: string; projectId: string | null; machine?: string | null }): Promise<void>
  /** New code, same slot (M4 C-4): teardown first, then a new instance. From `followAppCode` and "Reload". */
  reloadPinnedView(key: string): Promise<void>
  /** New code (M4 C-4): closed after teardown, reopened from the host's held input and outcome, or left closed. */
  reloadInlineView(sessionId: string, callId: string): Promise<void>
  /** "New app" (M4 C-1): the host expands the template and starts a builder session. A refusal is thrown as is. */
  createApp(spec: NewAppSpec): Promise<AppCreated>
}
