import type {
  AppCreated,
  AppToolResult,
  NewAppSpec,
} from '@cc/platform/ports'

/**
 * A single pinned view (M4 B-2) — an app opened from the sidebar. **It survives a focus change**:
 * going to look at a session and coming back leaves the same instance (same document, same view
 * state). It only comes down when closed or when the app disappears.
 *
 *   idle        Not opened yet (or the app has stopped and is waiting to be reopened). If the app
 *               can still be opened, the view opens.
 *   opening     The host is calling `home` — this covers the time the app takes to come up.
 *   open        The instance is up.
 *   failed      Failed to open — `error` says why.
 *   restarting  The person pressed "Restart" — the host is tearing the app down and clearing its
 *               state. When it finishes, it goes to `idle` and reopens.
 */
export type PinnedView = {
  key: string
  projectId: string | null
  appId: string
  /** A linked machine's user-folder app (#82): which machine. Absent for this computer's apps and for project apps */
  machine?: string | null
  phase: 'idle' | 'opening' | 'open' | 'failed' | 'restarting'
  instanceId: string | null
  toolInput: Record<string, unknown> | undefined
  toolResult: AppToolResult | undefined
  error: string | null
  /**
   * The app's code as of when this instance was opened (`ExternalAppInfo.codeStamp`, M4 C-4). If
   * the value in the app list differs from this, this view's HTML is stale — it is reopened
   * (`followAppCode`). `null` when unknown at open time; otherwise set to the first value learned.
   */
  codeStamp?: string | null
  /** When reopened with new code — the "Updated" badge in the header shows briefly */
  updatedAt?: number | null
  /**
   * The code changed again but it was not reopened automatically (it changed too often in too
   * short a span) — the person has to press to reopen it.
   */
  stale?: boolean
}

/**
 * A single in-conversation app view (M4 B-1) — a view that sits under a tool-call card. Its
 * lifetime is set by the host's `app_view` event (open → result/cancelled → closed).
 *
 *   live      The host has an instance open. If the card is on screen, its frame is drawn.
 *   closing   Being closed — teardown is sent to the drawn frame and its answer is awaited (per
 *             spec, this notice goes out **before** it comes down).
 *   parked    Only a placeholder stands. It says why it was parked (`reason`) and what can still
 *             be done (reopen, open the app).
 *
 * There is exactly one path to closing (`closeInlineView`): falling out of the virtual scroll, the
 * cap on live views, or the host closing it (the app disappeared, lost trust, or was impersonated),
 * or the frame failing to mount. Whoever closes it, teardown goes first.
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
  /** Ended without an answer — the view gets `tool-cancelled` with this reason instead of `tool-result` */
  cancelled?: string
  /** The view was not opened (impersonation blocked) — the reason. Such a view is given no way to reopen */
  rejected?: string
  /** Why it was parked as a placeholder */
  reason?: string
  /**
   * Whether the host holds this call's input and outcome so it can reopen **without calling the
   * tool again**. The host carries this in the outcome (`kept`). If reopening is refused this is
   * false, and the placeholder then offers only the path to open the app.
   */
  kept: boolean
  /** The order in which it came alive — the cap closes the longest-live view first (reopening gets a new number) */
  liveAt: number
  /** The app's code as of when it came alive — same meaning as the pinned view's field (`PinnedView.codeStamp`, M4 C-4) */
  codeStamp?: string | null
  /** When reopened with new code — the "Updated" badge on the title line shows briefly */
  updatedAt?: number
  /** The code changed again but it was not reopened automatically — the person has to press to reopen it */
  stale?: boolean
}

/** App views: pinned views, in-conversation views and the builder pane. */
export type AppViewsSlice = {
  /**
   * The builder session whose conversation is open beside a visible pinned view (M4 C-5,
   * `BuilderPane`) — a session that is on screen (`isOnScreen`). That session's turn ending is a
   * sweep, not a card. Set by opening a pinned view, and set to `null` when it closes or is hidden.
   */
  builderPaneSessionId: string | null
  setBuilderPane(sessionId: string | null): void
  /**
   * The app being viewed as a pinned view (M4 B-2). Stands on screen only while `view` is 'app'.
   * Not cleared by going to view something else — pressing the app's sidebar row again, and reviving
   * it, both return to the same place.
   */
  focusedApp: { projectId: string | null; appId: string; machine?: string | null } | null
  /** Open pinned views, in the order they were opened. Ones not visible stay alive too (`PinnedView`) */
  pinnedViews: PinnedView[]
  /**
   * In-conversation app views (M4 B-1) — session → (call id → view). Kept separate from cards
   * (`chat`): a view's lifetime is set by the host's `app_view`, and a live view must not disappear
   * even when the conversation history is re-read (`loadHistory`).
   */
  inlineViews: Record<string, Record<string, InlineView>>
  /** Bumped every time a drawn in-conversation view's frame comes or goes — the value itself carries no meaning (`registerInlineFrame`) */
  inlineFramesVersion: number
  /**
   * Closes an in-conversation view — the **single path to closing one**. Only closes a live view
   * (calling it twice counts as once). If a frame is drawn, teardown is sent first and its answer
   * awaited, then it is switched to a placeholder and the host is told to close the instance
   * (releasing the app; if the host already closed it, that close is a no-op).
   */
  closeInlineView(sessionId: string, callId: string, reason: string): Promise<void>
  /**
   * Reopens a closed view — without calling the tool again. Once the host returns the new instance
   * along with the input and outcome it was holding, the view receives them again per spec. If it
   * cannot be opened, the reason is left on the placeholder and reopening is withdrawn.
   */
  reopenInlineView(sessionId: string, callId: string): Promise<void>
  /**
   * Sends an app view's message into the conversation (M4 B-1, B-4) — called only after the person
   * has confirmed it. An in-conversation view sends to that conversation; a pinned view sends to
   * whichever conversation the person picked. Either way it is recorded as a message the app sent,
   * and the agent receives the app's text wrapped by the host.
   * @returns whether it was sent — a failure is reported as a toast
   */
  sendViewMessage(sessionId: string, instanceId: string, text: string): Promise<boolean>
  /**
   * Opens an app as a pinned view — creates its slot the first time, or goes to it if already open.
   *
   * `builder: true` opens its builder's conversation beside it too (`builderPaneFor`). That is how a view laid over a
   * panel — on the grid or the project screen — shows the builder: the panel has no room for the pane, so "Show the
   * conversation" goes to the app view through this same door the panel's Open uses.
   */
  openApp(projectId: string | null, appId: string, opts?: { builder?: boolean; machine?: string | null }): void
  /**
   * The pinned view key whose builder pane should open the next time that view is the one on screen (`openApp` with
   * `builder`) — the view opens it and clears this. Only this screen session's: not saved with the workspace.
   */
  builderPaneFor: string | null
  /** Clears `builderPaneFor` once the view it names has opened its builder pane */
  takeBuilderPaneFor(key: string): void
  /**
   * Gives the app a pinned view without going to it (#203). The project screen shows its apps' pinned views in its
   * panels, and this is the same entry `openApp` makes — so an app on the project screen and the same app opened from
   * the sidebar are one instance in one frame, and moving between them keeps the document.
   */
  ensurePinnedView(projectId: string | null, appId: string): void
  /**
   * Gives an app on the grid its view (#288), keyed `gridAppViewKey` — apart from the app's pinned view, so the grid
   * and the project screen each keep their own document. Does nothing if it already has one.
   */
  ensureGridAppView(projectId: string | null, appId: string, machine?: string | null): void
  /** Closes a pinned view from outside its own header (the project screen's ×) — teardown first, as every way down does */
  dismissPinnedView(key: string): Promise<void>
  /**
   * Leaves the app view without closing the view when the screen it goes back to shows the app anyway: its project's
   * screen, where the app is a panel (#203). Closing there would tear down the panel's view and open a new one at
   * once, losing whatever the person had in it. Returns whether it left; if not, the caller closes the view.
   */
  leavePinnedView(key: string): boolean
  /** Opens the slot's instance (the host calls `home`). Called by the view when the app can be opened */
  startPinnedView(key: string): Promise<void>
  /**
   * Releases the instance and returns the slot to idle — for when the app can no longer run
   * (it lost trust). The caller must call `AppFrame`'s teardown first. Once it can run again, the
   * view reopens it.
   */
  releasePinnedView(key: string): void
  /** Closes a pinned view — the caller must call teardown first. If it was being viewed, returns to the focus view */
  closeApp(key: string): void
  /**
   * Restarts the app and opens a fresh view (M4 B-6) — the "Restart" for a dead or stopped app, or a
   * view that failed to open. The caller calls teardown first. Releases the old instance, and reopens
   * (calls `home` fresh) **only after** the host has torn the app down and cleared its state.
   */
  restartApp(key: string): Promise<void>
  /**
   * Stops an app the person no longer wants running (#1236): an app keeping itself running for background work is
   * stopped with its view, if one is open, torn down and closed, so nothing on this screen starts it again. The host
   * stops the process (`apps.restart` never starts one); the next need does. From its sidebar row, Settings' app row or
   * its view; an app with no view has the first two.
   */
  stopApp(app: { key: string; appId: string; projectId: string | null; machine?: string | null }): Promise<void>
  /**
   * Reopens a pinned view with the app's new code (M4 C-4) — the slot stays put (same row, same
   * focus), only the instance is new. Sends teardown to the drawn frame first, releases the old
   * instance, and the view reopens (calls `home` with the new code). Called both when the store
   * notices the code changed (`followAppCode`) and when the person presses "Reload".
   */
  reloadPinnedView(key: string): Promise<void>
  /**
   * Reopens an in-conversation view with the app's new code (M4 C-4) — closes it after teardown, then
   * opens a new instance with that call's input and outcome that the host was holding (without
   * calling the tool again). If the host is not holding them, it stays closed.
   */
  reloadInlineView(sessionId: string, callId: string): Promise<void>
  /**
   * Creates a new app (M4 C-1, the "New app" window) — the host expands the template and sets up a
   * builder session. On success, the app takes its place in the list, its pinned view opens, and the
   * builder session appears in the sidebar. If the host refuses, its message is thrown as is (shown
   * in the window).
   */
  createApp(spec: NewAppSpec): Promise<AppCreated>
}
