import type { StoreApi } from 'zustand'
import type {
  AppQuestion,
  ToolStatus,
  CommandRunInfo,
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  NormalizedEvent,
  SavedCommand,
  PermissionPreset,
  ProjectInfo,
  GitSource,
  QuestionAnswer,
  StoredMessage,
  ToolName,
  UiPreferences,
  UiPreferencesPatch,
  ThemeFileEntry,
  UpdateStatus,
  AgentVersions,
  SleepPolicy,
  HostActivity,
  MachineInfo,
  MachineProbe,
  RemoteShell,
  SshHostList,
  SessionInfo,
} from '@cc/protocol'
import type { NotifyPolicy, ProjectArrangement, SessionSummary } from '@cc/core'
import type { AppCreated, AppToolResult, ConnectionState, NewAppSpec, Platform } from '@cc/platform/ports'
import type { PanelGroup, PanelTab } from './panelLayout.js'
import type { NavHistory } from './navHistory.js'
import type { ChatAttachment, ChatItem } from './transcript.js'

/**
 * The store's state and actions as one type (`AppState`), and the shapes of what it holds. The store
 * (`useStore`, store.ts) builds it; the modules split out of store.ts (#428) import these types from
 * here rather than from the store, so none of them depends on the store itself. Those that hold
 * actions take the store's `set` and `get` (`StoreSet`, `StoreGet`).
 */

/** The store's own `set` and `get`, as the modules holding its actions receive them */
export type StoreSet = StoreApi<AppState>['setState']
export type StoreGet = StoreApi<AppState>['getState']

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

/**
 * A single thing that happened off screen.
 *
 * `sessionId` is the identity — if the same session finishes again, the card is updated rather
 * than added. That way one busy session cannot crowd out the rest, and the card count never
 * exceeds the session count.
 */
export type Notice = {
  sessionId: string
  /** `agent_start`: the session asks to start another agent (#673), left as a card even while the app is in front */
  kind: 'done' | 'approval' | 'error' | 'agent_start'
  /** The session's name at that moment — kept as written even if the session is renamed later */
  name: string
  at: number
}

/** Not yet sent. The text and attachments move together — binding only one to the session leaves
 * the pair half fixed */
export type Draft = { text: string; attachments: ChatAttachment[] }
export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

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

/**
 * One launch card's subagent steps on screen (#222).
 *
 *   open     the section is expanded
 *   rows     the steps read so far, oldest first, by their number within the launch (`seq`)
 *   more     the host has more past `rows` than one page carried; live steps wait for those to be read
 *   loading  a page is being read
 *   error    why the last read failed, shown in place of the steps
 */
export type SubagentSteps = { open: boolean; rows: StoredMessage[]; more: boolean; loading: boolean; error: string | null }

export type AppState = {
  platform: Platform | null
  connection: ConnectionState
  /**
   * How many times the connection came back to a host that could not replay what was missed
   * (`resync_required`) — in practice another host lifetime: a restart, or a build switch behind
   * the keeper's front door (#280). An open app view asks for its address again on every change
   * (AppFrame): the new host may serve it at another address, or not at all.
   */
  hostResyncs: number
  projects: Record<string, ProjectInfo>
  /**
   * How many times, per project, we have heard "the working tree may have moved" (#160). Bumped
   * by one each time `refreshProjectGit` actually goes and asks. The evidence panel's change list,
   * history and collapsed strip hold their own lists, so they never heard a re-read that only
   * updated `project.git` (the sidebar's summary) — they now subscribe to this counter and re-read
   * together on turn end, window focus, approval, and branch switch.
   */
  gitEpoch: Record<string, number>
  sessions: Record<string, SessionSummary>
  /**
   * Which agent tools this machine has, as the host reports them.
   *
   * The screens that draw a row per tool used to read a `TOOL_META` constant compiled into
   * `@cc/protocol`, which meant the set of tools was fixed at build time and a new adapter
   * could not appear without editing the protocol. It arrives over the wire now, so it has
   * to be held somewhere every screen can reach — the chips in the sidebar need the label
   * and the mark synchronously, once per row.
   */
  tools: ToolStatus[]
  chat: Record<string, ChatItem[]>
  /**
   * Text not yet sent — kept **per session**.
   *
   * It used to be held by the composer component itself. That binds the text to the screen's spot
   * rather than to the session: switching sessions in the focus view reuses the same component, so
   * text written for A was still sitting in B's composer — sending it as is would **go to the
   * wrong session** (confirmed by measurement). Conversely, in the grid, which swaps out
   * components, the text vanished along with the unmounted component.
   *
   * Not put in the store's persisted snapshot. It is not heavy enough to need to survive the app
   * being closed and reopened.
   */
  drafts: Record<string, Draft>
  /**
   * Whether a conversation was left standing at its newest line — **per session** (#31).
   *
   * The flag used to be a ref inside the chat stream, so it was born `true` with every
   * mount, and the grid mounts and unmounts panels as you move around: look at another
   * session, come back, and the panel had decided for itself that you were at the bottom.
   * Fourth time state that belongs to the work has been kept by the view instead (drafts,
   * the elapsed count, expanded folders, this).
   *
   * Per session, and that is the opposite call from expanded folders (#16) on purpose. An
   * open folder is a fact about *the code*, so every session on that repo wants it; where
   * you are in a conversation is a fact about *that conversation*, and you read one at a
   * time.
   *
   * **What is kept is "were you at the bottom", not the offset.** A pixel `scrollTop`
   * restored into a virtualiser that has not measured its rows yet lands *near* the right
   * place — which is the symptom #31 reported, not a cure for it. The bottom needs no
   * measurements to be reachable: it is wherever the content ends.
   *
   * Absent means yes: a conversation nobody has scrolled starts at its newest line. Not
   * persisted — where you had scrolled to is not worth surviving the app closing.
   */
  stickToBottom: Record<string, boolean>
  /**
   * When a conversation was left somewhere other than the bottom, **which row and where in it** it
   * was showing (#61).
   *
   * The comment above, that no pixel offset is kept, is still true — pinning a raw `scrollTop` into
   * a virtualizer that has not yet measured its rows lands only *near* the right place. But that
   * conclusion had been read as "keep nothing at all," and the result was that any conversation not
   * at the bottom restarted from the top every time it was reopened (#61's "the scroll jumps to
   * the top").
   *
   * So what is kept is not a pixel but a **row**: the `seq` of the item spanning the top of the
   * screen, and the offset within that item. `seq` is a fact independent of measurement, so it
   * still points at the same row after remeasuring, and the remaining few pixels are re-fit every
   * frame while rows are being measured.
   *
   * Absent when the conversation was at the bottom — `stickToBottom` already says that, and the
   * bottom needs no measurement to be reached. Not persisted: how far one had read is not worth
   * carrying past the app closing.
   */
  scrollAnchor: Record<string, { seq: number; offset: number }>
  /**
   * When the turn a session is currently running started — the instant, per session.
   *
   * The "Waiting for response" line used to take `Date.now()` on mount and count up from
   * there, so switching views restarted the clock: a turn three minutes old read as if it
   * had just begun (issue #23). The component was holding the wrong half. **Elapsed time is
   * derived; the start instant is the fact.** Keeping the instant here means the count is
   * recomputed rather than resumed, and nothing depends on a component staying alive.
   *
   * Not `waitingSince`, which sounds like the same thing and is the opposite one: that is
   * when the session started waiting for *a human* (approval, input, error), and the
   * reducer sets it to null the moment a session goes back to `working` — precisely when
   * this line is on screen. Two clocks, because there are two directions of waiting.
   *
   * Not persisted. A turn does not survive the app closing.
   */
  workingSince: Record<string, number>
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
   * Whether to keep the composer folded in grid panels (user request, 2026-09-10).
   *
   * When on, each panel's composer stays folded down to **only the rounded card's top edge**, and
   * rises to **float over** the conversation when the mouse is over the bottom of the panel. The
   * conversation's height does not change, so the row being read is not pushed around. When off, it
   * stays expanded at all times, as before.
   */
  foldComposer: boolean
  focusedSessionId: string | null
  /** Git, files and the viewer belong to the project — they must be viewable without a session */
  focusedProjectId: string | null
  /**
   * The project whose session-creation window is open (`null` means closed).
   *
   * This used to be local state on the sidebar panel, and was lifted into the store because **the
   * first-run screen needs to open this window.** The moment a project is created, the first-run
   * screen disappears (`App` branches on whether any project exists), so the only way for that
   * screen to hand off its next step is to reserve a window that will stand somewhere else, in
   * place of the screen that is about to disappear.
   */
  newSessionFor: string | null
  /**
   * A worktree suggestion from the manager (#69). Set by `propose_worktree_session`, and consumed
   * when that project's new-session window opens — the window comes up with the worktree toggle on
   * and the branch name filled in. The reason it is keyed to the project: letting it bleed into
   * another project's window would contaminate the suggestion.
   */
  /**
   * A queue (dogfooding for #69): when the manager suggested two branches back to back, a single
   * slot meant only the last one survived — the first suggestion had to be typed by hand after
   * reading the name off the conversation. Each time the window opens, it consumes that project's
   * oldest suggestion (FIFO).
   */
  worktreeProposals: { projectId: string; branch: string }[]
  /**
   * The orchestrator's MCP server suggestion (`propose_mcp_server` → the person's one-click approval
   * → the app registers it and restarts the orchestrator). The list here is a copy; the host holds
   * the truth.
   */
  mcpProposals: { name: string; command: string; args: string[]; why?: string }[]
  refreshMcpProposals(): Promise<void>
  /**
   * How many times, per external app, we have heard "the state changed" (M4 B-5). Keyed by
   * `externalAppKey`. The size of the value carries no meaning — only **the fact that it changed**
   * does. An open `AppFrame` reads this as `changeSignal` and sends the view
   * `centralu/notifications/changed`. Counted even when the app is not in the list. The store does
   * not know the external app list, and missing a signal while waiting for the list is worse.
   */
  externalAppChanges: Record<string, number>
  /**
   * The view instance whose call caused the last bump to that app's counter — only when the change
   * came from a call the view itself made, otherwise `null` (`external_app_state_changed.cause`).
   * `AppFrame` does not notify when the counter went up by exactly one and that one was its own.
   */
  externalAppChangedBy: Record<string, string | null>
  /**
   * How many times, per external app, we have heard "a row shown in the runs panel started or
   * finished" (M4 D-6, `external_app_runs_changed`). Keyed by `externalAppKey`. Read only by the
   * runs panel (`RunsPanel`) — it does not reach the view. Calls to read-only tools, and the chains
   * they start, also arrive here.
   */
  externalAppRunChanges: Record<string, number>
  /**
   * Discovered external apps and their state (M4 A-8) — a copy of the host's `apps.list`. The host
   * holds the source of truth: this is never edited here, only re-read in full when
   * `external_apps_changed` arrives. The list every screen reads (status, scope) is built from it by
   * `app-catalog.ts`.
   */
  externalApps: ExternalAppInfo[]
  refreshExternalApps(): Promise<void>
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
   * Capability questions for chains started from a view (M4 D-4) — a copy of the host's
   * `apps.questions`. Re-read in full when `external_app_questions_changed` arrives, and on
   * reconnect. A question stands on the pinned view of the app that started the chain (`origin`),
   * and that app's sidebar row carries a badge. Questions for chains started from a session are not
   * here — they are that session's approval card instead.
   */
  appQuestions: AppQuestion[]
  /** How many times the questions changed — the signal for wherever remembered answers are shown (the runs panel) to re-read */
  appQuestionsVersion: number
  /** How many times a remembered cross-project consent was added or revoked (#371) — Settings re-reads its list on it */
  projectConsentsVersion: number
  refreshAppQuestions(): Promise<void>
  /** Answers a capability question — a failure (the question is already closed) is reported as a toast and the list is re-read */
  answerAppQuestion(questionId: string, decision: 'allow' | 'deny'): Promise<void>
  /**
   * Removes an app from the user folder (M4 A-7). The list follows from the host's broadcast. The
   * caller is confirmed first.
   * @returns whether it was removed — a failure is reported as a toast
   */
  /** `machine`: a linked machine's user-folder app (#82), removed on that machine and nowhere else */
  removeUserApp(appId: string, machine?: string | null): Promise<boolean>
  /**
   * Shares a project app with the person's other projects, or stops (#371 part A). The list follows
   * from the host's broadcast; a failure is reported as a toast.
   */
  setAppShared(projectId: string, appId: string, shared: boolean): Promise<void>
  resolveMcpProposal(name: string, approve: boolean): Promise<void>
  /** The orchestrator's skill suggestion (#71) — the same suggest-then-one-click-approve rail */
  skillProposals: { name: string; content: string; why?: string }[]
  refreshSkillProposals(): Promise<void>
  resolveSkillProposal(name: string, approve: boolean): Promise<void>
  /**
   * Whether the new-session window opens with the worktree checkbox on (#69). Turned on by the `+`
   * on the manager's row, because a session created under a manager defaults to a worktree session.
   * Turning it off in the window is free (a preset, not a requirement).
   */
  newSessionWorktree: boolean
  /** The initial branch name for the new-session window (#69) — filled by a suggestion. An empty string means none */
  newSessionBranch: string
  /**
   * The oldest history point currently on screen, per session.
   * Conversation the model has forgotten to compaction still survives in our store, so this is
   * where reading further back starts from.
   */
  history: Record<string, { oldestSeq: number; more: boolean; loading: boolean }>
  /**
   * The steps of a native subagent, per session and launch card (#222) — present once the person has opened that
   * card's steps, and only then read from the host. Kept here rather than in the card, so a card the virtual list
   * detaches and draws again comes back as it was left (open, loaded), not collapsed and reading again.
   */
  subagentSteps: Record<string, Record<string, SubagentSteps>>
  /** Opens or closes a launch card's steps; the first opening reads them */
  toggleSubagentSteps(sessionId: string, callId: string): void
  /** Reads the next page of a launch card's steps */
  loadMoreSubagentSteps(sessionId: string, callId: string): Promise<void>
  /**
   * The session currently being woken up.
   *
   * Picking a session **wakes it immediately.** It used to wake on send, which piles the whole
   * process-startup time onto the time between turning the app on and the first response. Worse, a
   * sleeping session has no process to ask, so it cannot even hand back its slash-skill list. The
   * act of picking already means "I am about to use this session," so preparation starts right then.
   */
  resuming: Record<string, boolean>
  /**
   * **Why** waking it failed.
   *
   * This used to fail silently ("it will retry when sending anyway"). But the screen read "sending a
   * message will resume it automatically" while it actually would not resume, and the person had no
   * way to find out why (pointed out during dogfooding). No silent failures — the reason is written
   * right there.
   */
  wakeError: Record<string, string>
  /**
   * Whether waking it failed **because another side is holding it**.
   *
   * This is never decided by pattern-matching the reason text with a regex — the moment the wording
   * changes, that check breaks silently. The host sends this down as its own separate signal, and it
   * is simply carried as is. Only when this is true is "split off and continue" offered (that is the
   * only case where that path is actually open).
   */
  wakeLocked: Record<string, boolean>
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
  /** Unfolds only this project and folds all the rest (#205) — for focusing on one in a single move */
  foldOtherProjects(projectId: string): void
  /**
   * Explicit ordered panel lists per project (#604), kept in the workspace snapshot.
   * Availability filters drawing; explicit session deletion removes membership. Deleting a
   * project drops its entry. Legacy order/hidden fields remain for the previous build.
   */
  projectPanels: Record<string, ProjectArrangement>
  /** Writes one project's arrangement whole and saves the snapshot */
  arrangeProject(projectId: string, next: ProjectArrangement): void
  /**
   * The person's span for each app's panel on the grid (#306), keyed by `appKeyOf` — Settings → Apps. The default for
   * every placement of that app that has no span of its own (from the panel's top bar), and ahead of the app's own
   * recommendation (core's `resolveGridSpan`). An app with no entry takes its recommendation, else 1 × 1.
   *
   * Kept in the workspace snapshot, like `projectPanels`: a way of looking that only this UI reads, about an app the
   * host's tables do not key (a user-folder app has no project). The choice for one placement is on the placement
   * itself, in the host's grid table, because it goes when the panel goes.
   */
  appSpans: Record<string, GridSpan>
  /** Sets or clears (`null`) the person's span for an app, and saves the snapshot */
  setAppSpan(projectId: string | null, appId: string, span: GridSpan | null, machine?: string | null): void
  /**
   * Sets or clears (`null`) the span of one app panel on the grid, keyed by core's `gridPanelKey` — the panel's top bar
   * (#306). Saved with the grid, like a move.
   */
  setGridPanelSpan(key: string, span: GridSpan | null): Promise<void>
  /**
   * Per-project command run state — a projection of the host's `commands.state` (#60, moved into
   * the terminal panel). The host's buffer holds the log body; this only holds the facts a badge
   * needs to read (is it running, what did it end with). Why this lives in the store: "it is
   * running" is not only the run window's own concern, it is a fact the tab badge and the collapsed
   * strip must read too — the gap this piece exists to close is that leaving a dev server on and
   * moving away left no trace of it visible anywhere. Keyed projectId → command → last run.
   */
  commandRuns: Record<string, Record<string, CommandRunInfo>>
  /**
   * The wide surface. Code and diffs cannot be read in a 360px panel.
   * It covers the conversation and is dismissed with Escape — coming back, the conversation still
   * has its scroll position intact.
   */
  overlay: Overlay
  inboxOpen: boolean
  toast: string | null
  appFocused: boolean
  /**
   * The session that just finished responding — the trigger for one sweep of the screen.
   * `at` is kept alongside it because the sweep must fire **every time**, even when the same session
   * finishes twice in a row (it is used as a key).
   */
  completion: { sessionId: string; at: number } | null
  /**
   * Things that happened off screen — notification cards that pile up in the top right.
   *
   * **They do not disappear on their own.** An OS banner is dismissed after a few seconds, so
   * anything that arrived while the person was away is already gone by the time they get back. That
   * is the part a banner cannot cover for this app, so this stays. There are exactly three ways it is
   * dismissed: seeing that session, clicking the card to go there, or pressing ×.
   *
   * Only one is kept per session. If one busy session filled the screen, the rest would get buried.
   */
  notices: Notice[]
  /** The file the code viewer is showing (a project-relative path) */
  viewerPath: string | null
  /**
   * Which project that file belongs to — only when the side that opened it said so (#182). A file
   * link in the grid carries its own panel's project. Picking from the focused session, in a WKWebView
   * where a button click does not move focus, meant a link in an adjacent panel opened the same
   * relative path in the focused panel's project instead. `null` follows focus, as before.
   */
  viewerProjectId: string | null
  paletteOpen: boolean
  /**
   * The number of windows currently open (#158) — raised when a screen-covering layer like `Modal`
   * or the command window opens and lowered when it closes (`useOpenLayer`). A window's open state
   * is usually local state on that component, so the store has no other way to know. Without the
   * approval card's y/n/a checking this value, pressing y to confirm a "Delete this session?" window
   * had let through a command hidden behind it.
   */
  openLayers: number
  /**
   * Approval requests that have had a response sent but not yet answered (#158) — `inFlightKey(sessionId, requestId)`
   * → `true`. Keyed by the session too (#683 review): a request id is unique only within a session's process, so two
   * sessions can hold the same one, and an answer in one must not be dropped as a repeat of the other's. If a second input arrives on the same card (two key presses, the card and the rail)
   * before the first response's result reaches the screen, the second response became a "vanished
   * request" and recorded a command that had already run as denied.
   */
  approvalsInFlight: Record<string, true>
  /**
   * The number of attachments currently uploading, per session (#180). A chip only enters the draft
   * once the host has finished storing it, and sending during that window sent only the text —
   * the chip that finished later attached itself to the draft afterward and rode along with the next
   * message. The composer refuses to send while this value is above zero.
   */
  uploading: Record<string, number>
  /** The usage modal (FR-9) */
  usageOpen: boolean
  settingsOpen: boolean
  /**
   * A request to open the session settings menu (model, effort, permissions) (2026-09-07, the
   * `/model` GUI command). The menu's open state is local state on `SessionSettings` — this only
   * carries the signal. `at` is needed so that requesting the same session twice in a row still
   * opens it each time.
   */
  settingsMenuRequest: { sessionId: string; at: number } | null
  /**
   * The session whose composer takes the keyboard next (#528): set where the next thing the person
   * does is type to that session (a session picked in the palette, one just created), and spent by
   * that composer once nothing covers it (`composerFocusAnswer`). Like `settingsMenuRequest`, a
   * signal, not a state of the screen. Showing another session withdraws it (`focusSession`), so a
   * request never lands later in a session the person has left.
   */
  composerFocusFor: string | null
  notifyPolicy: NotifyPolicy
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
  /** When this host puts idle sessions to sleep (#568); null until it has answered, or when it is too old to know */
  sleepPolicy: SleepPolicy | null
  /**
   * The machines this computer's host is linked to (#82, docs/plans/remote-hub.md), by id, in the
   * order the host lists them. Each row is replaced whole by its `machine_status`. Empty with no
   * links, and with a host from before them.
   */
  machines: Record<string, MachineInfo>
  /** The agent CLIs installed on each linked machine (#297 per machine), read when a remote session's header asks */
  machineAgentVersions: Record<string, AgentVersions>
  refreshMachines(): Promise<void>
  /**
   * The recovery `machine_resync` asks for, scoped to one machine (#82): re-read the session and
   * project lists and replace that machine's rows only, re-read the conversations of its sessions
   * that are open, and wake only its sessions that were live and are not now. Every other machine's
   * rows, and this computer's, are left exactly as they are.
   */
  recoverMachine(machineId: string): Promise<void>
  addMachine(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null; command?: string | null }): Promise<MachineInfo>
  /**
   * The hosts of the ssh config of the computer the host runs on (#514), for the Add machine dialog.
   * Null when the host cannot say (an older host): the dialog then asks for a target by hand
   */
  machineSshHosts(): Promise<SshHostList | null>
  /** What runs at the other end of a target, asked over one BatchMode ssh (#514); null when the host cannot ask */
  probeMachine(sshTarget: string): Promise<MachineProbe | null>
  removeMachine(machineId: string): Promise<void>
  reconnectMachine(machineId: string): Promise<void>
  acceptMachineVersions(machineId: string): Promise<void>
  /**
   * Installs, updates, rolls back or removes the Centralu this computer installs on a machine
   * (docs/plans/remote-hub.md §10.5). True when it was done; a refusal or failure is a toast in the
   * host's words (an update that did not take says which version runs there now)
   */
  changeMachineInstall(machineId: string, kind: 'install' | 'update' | 'rollback' | 'uninstall'): Promise<boolean>
  /** Starts a machine's host at boot, or stops doing that (plan §10.4); false (with a toast) when it was refused */
  setMachineAutostart(machineId: string, on: boolean): Promise<boolean>
  /** What would stop on a machine if its host stopped now, for the update prompt; null when unknown */
  machineActivity(machineId: string): Promise<HostActivity | null>
  checkMachineAgentVersions(machineId: string, force?: boolean): Promise<void>
  /** Opens Settings on one category, e.g. Machines from a machine's badge in the sidebar */
  settingsRequest: { category: string; at: number } | null
  openSettingsAt(category: string): void
  /**
   * What this person has chosen about the screen (protocol's `UiPreferences`).
   *
   * **Fetched once at startup and seated here.** Letting the consumer (the composer) ask on demand
   * would mean it runs on defaults while the answer is late, and the rule changes out from under
   * the person's fingers — if the send key changed that way, the message would already be sent by
   * the time it did.
   */
  prefs: UiPreferences

  attach(platform: Platform): Promise<void>
  dispatchEvent(e: NormalizedEvent): void
  /**
   * Show a session.
   *
   * `preferGrid` is for the doors that alerts open (the inbox, the "done" cards): if the
   * session already has a panel on the grid, go there instead of replacing the grid with
   * one big pane. You put it on the grid to watch it; an alert about it is not a reason to
   * take the other panels off the screen. Deliberate navigation — the sidebar, the palette —
   * leaves this off: picking a row means "give me that one, large".
   *
   * `reveal: false` keeps a folded project folded (#205). Every other door unfolds the
   * session's project, so the row it lands on is visible; see `focusSession` for the two
   * callers that pass it.
   */
  focusSession(id: string | null, opts?: { preferGrid?: boolean; reveal?: boolean; targetSeq?: number }): void
  /**
   * Goes to one thing that waits on the person (#703): a session, or a pending orchestrator proposal (an id from
   * `isProposalId`), whose card stands on the orchestrator's screen. The waiting list and "next waiting" use it.
   */
  openWaiting(id: string, opts?: { preferGrid?: boolean }): void
  /** Opens a search result at its stored conversation row. */
  openSearchHit(sessionId: string, seq: number): void
  /** The search result the conversation is currently holding in sight, by session. */
  searchTargets: Record<string, { seq: number; at: number }>
  /** A reader moved away from a search result, so it no longer needs emphasis. */
  clearSearchTarget(sessionId: string, at: number): void
  focusProject(id: string): void
  setAppFocused(focused: boolean): void
  /**
   * The builder session whose conversation is open beside a visible pinned view (M4 C-5,
   * `BuilderPane`) — a session that is on screen (`isOnScreen`). That session's turn ending is a
   * sweep, not a card. Set by opening a pinned view, and set to `null` when it closes or is hidden.
   */
  builderPaneSessionId: string | null
  setBuilderPane(sessionId: string | null): void
  /** Dismisses notification cards (× pressed, or that session was seen) */
  dismissNotices(sessionIds: string[]): void
  /**
   * Reads one page of the newest history, merges it with the conversation on screen, and sets the
   * cursor (#79, `mergePage`). The same path serves a session opened for the first time, a re-read
   * that catches up on a conversation continued elsewhere (`history_synced`), and a resync that
   * fills a gap — there used to be a separate `force` that swapped in only for re-reads. Now, within
   * a page's range, history is always the source of truth.
   */
  loadHistory(sessionId: string): Promise<void>
  /** Reads the page containing a search result instead of only the newest history page. */
  loadHistoryAt(sessionId: string, seq: number): Promise<void>
  /** Prepends older conversation (the way to read conversation from before a compaction) */
  loadOlder(sessionId: string): Promise<void>
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
  /**
   * Opens a file in the wide overlay (the common entry point for the file tree and the git panel).
   * If `projectId` is given, the file belongs to that project — otherwise the focused session's project
   */
  openFile(path: string, projectId?: string | null): void
  /** Right-click on a file link in the conversation — reveals it in Finder under the link's own project (or the currently viewed session's project if none is given) */
  revealFile(path: string, projectId?: string | null): Promise<void>
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
  /** Asks the session's composer to take the keyboard (#528, `composerFocusFor`); `null` withdraws the request */
  askComposerFocus(sessionId: string | null): void
  toggleUsage(open?: boolean): void
  toggleSettings(open?: boolean): void
  /**
   * The app-import window (M4 E-3) — opened by the sidebar's Import and by deep links (E-4).
   * `source` is the origin to pre-fill in the window (the deep link's address), and `fromLink`
   * tells the window it was "opened by a link." The window reads or downloads nothing until the
   * person presses Review.
   */
  importDialog: { source: string; fromLink: boolean; at: number } | null
  openImport(source?: string, fromLink?: boolean): void
  closeImport(): void
  /** The `/model` GUI command — opens that session's settings menu (model, effort, permissions) */
  requestSettingsMenu(sessionId: string): void
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
  runApplyRequest(requestId: string, ticket: string): Promise<void>
  setNotifyPolicy(p: NotifyPolicy): void
  /** Attaches something not yet sent to a session (removed if it is empty) */
  setDraft(sessionId: string, draft: Draft): void
  /** Remember whether the conversation was left at its newest line (#31) */
  setStickToBottom(sessionId: string, sticking: boolean): void
  /** Records the row that was showing when it was left (#61). `null` clears it — meaning it was at the bottom */
  setScrollAnchor(sessionId: string, anchor: { seq: number; offset: number } | null): void
  /** Open or close a folder in the file tree. The project owns it, not the session (#16) */
  toggleDir(projectId: string, path: string): void
  /** Show or hide what .gitignore hides (#17) */
  setShowIgnored(show: boolean): void
  setFoldComposer(fold: boolean): void
  setToast(msg: string | null): void
  /** Opens/closes the session-creation window (`null` closes it) */
  openNewSession(projectId: string | null, opts?: { worktree?: boolean }): void
  /**
   * Starts a session in the project at once, with what the project remembers (its last tool, and that tool's model and
   * effort: `createSession` reads them), and gives the new session's composer the keyboard (#543). A remembered tool that
   * is logged out gives way to one that is not (the dialog's rule); when none can run, or the host refuses, the options
   * window opens instead and states why: a one-click start must never end in "nothing happened".
   */
  startSessionNow(projectId: string): Promise<void>
  /**
   * Sets the project's worktree trunk (#76). It was chosen when making the worktree manager, which was folded into
   * ordinary sessions (#561 part 3); a failure is thrown back to the dialog, which keeps it in place (#180).
   */
  setWorktreeTrunk(projectId: string, baseBranch: string): Promise<void>

  /** `machine`: a folder on that linked machine, its path in that machine's terms (#82) */
  addProject(path: string, machine?: string | null): Promise<ProjectInfo>
  /**
   * Makes a new project (#515): an empty folder `name` in `parent` (that machine's Desktop when absent), made by the
   * host of `machine` (this computer's when absent), then registered as `addProject` registers one. With `source`, a
   * clone of that repository instead of an empty folder.
   */
  createProject(name: string, parent?: string, machine?: string | null, source?: GitSource): Promise<ProjectInfo>
  /** Re-reads the project list for projects the host made on its own (#515, `projects_changed`) */
  refreshProjects(): Promise<void>
  /**
   * A project just registered whose trust is still being asked about (M4, decision 3). Asked
   * **once**, at registration — answering or dismissing it clears it. Nothing is blocked while it
   * is being asked (it stands under that project in the sidebar): right after registering there is
   * also a path where the new-session window pops up immediately, and stacking a window on a window
   * would leave both half-read. A project left unanswered stays untrusted, and can be changed at any
   * time from the project menu.
   */
  trustAsk: string | null
  answerTrustAsk(trust: boolean): Promise<void>
  /**
   * Turns trust on and off. The app list follows from the host's broadcast
   * (`external_apps_changed`).
   *
   * A session already running receives trust only when a session comes up (#92, the manager's
   * `projectTrusted`) — a changed trust setting takes effect only from the next time that session
   * restarts or resumes. That fact is stated in a single line **only when there is a running
   * session**. Saying it when there is none would be a warning about nothing, and not saying it when
   * there is one would let the person believe that turning off trust changed those sessions too, at
   * that instant.
   */
  setProjectTrusted(projectId: string, trusted: boolean): Promise<void>
  /**
   * Delete a project — the record here, and optionally the folder on disk.
   *
   * Two calls, in this order and not the other: the trash first, the record second. The
   * path is only known from the record, so removing it first would leave nothing to point
   * the trash at; and if the trash refuses (a browser has none), nothing has been deleted
   * yet and the whole thing stops with the reason. The reverse order can lose the folder
   * *and* the history in the failure case, which is the one case that matters.
   */
  deleteProject(projectId: string, deleteFiles: boolean): Promise<void>
  /**
   * Ask for this project's git status again, debounced (issue #41).
   *
   * `project.git` was measured once, at attach, and never again — so the sidebar's changed
   * count was a snapshot from app start that an agent's edits and commits never moved.
   * Everything that shows git for a project reads that one field, so this writes back
   * there rather than growing a second, parallel copy for the sidebar.
   *
   * Returns nothing and is safe to call from anywhere: the call is a *hint* that the tree
   * may have moved, not a request the caller waits on.
   */
  refreshProjectGit(projectId: string): void
  /**
   * Changing a repository on purpose, from inside the app (issue #49).
   *
   * #41 gave the sidebar three ways to hear that a tree moved — a turn ending, an approval
   * granted, the window regaining focus — and every one of them is a *guess* that something
   * probably happened elsewhere. The git panel then went straight to `platform.git` and told
   * only itself, so **committing, the one change we make deliberately and know about, was the
   * only one the sidebar never heard**. The count sat on its old value until an unrelated
   * signal happened to fire.
   *
   * So the writes come through here and the refresh is part of the operation rather than
   * something each call site has to remember. Reads stay on `platform.git`: a panel asking
   * for its own file list or a diff is nobody else's business, and routing those through the
   * store would put a debounce in front of a list that has to repaint on the click.
   *
   * `push` is deliberately absent. It moves nothing the sidebar shows — `ProjectInfo['git']`
   * is branch, changed count and is-repo, with no ahead/behind — so a refresh after it would
   * be a status call whose answer can only be identical.
   */
  gitStage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  gitCommit(projectId: string, message: string): Promise<{ ok: boolean; message?: string }>
  /** Switching branch is the one of these that moves the **name** the sidebar shows, not the count */
  gitCheckout(
    projectId: string,
    branch: string,
  ): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  /**
   * Replace this project's saved shell commands (issue #44).
   * Adding one and deleting one both arrive here as "the list is this now".
   */
  setProjectCommands(projectId: string, commands: SavedCommand[]): Promise<void>
  /** Saves the worktree provisioning setup (#69) — called from the new-session window's worktree section */
  saveWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /** Reads the host's run ledger — when the evidence panel views a project, so a running command stays visible even after just reloading the UI */
  loadCommandRuns(projectId: string): Promise<void>
  /** Runs a saved command (#44 → #60). If the same command is already running, the host kills it and starts fresh */
  runCommand(projectId: string, command: string): Promise<void>
  /** Stops a dev server — the outcome comes back through `terminal.onExit` and is recorded in `commandRuns`. The log survives */
  stopCommand(projectId: string, command: string): Promise<void>
  createSession(
    projectId: string,
    opts?: {
      tool?: ToolName
      model?: string
      /** When given, this value is used instead of the project default — used to carry a dying session's settings whole through a handoff */
      effort?: string
      verbosity?: string
      serviceTier?: string
      permissionPreset?: PermissionPreset
      initialPrompt?: string
      /** An inherited handoff note — enters as a marker in the record, not as the first message (#102) */
      handoff?: { from: string; note: string; fromSessionId?: string }
      /** Resumes a previous session the tool already had (including a conversation created in a terminal) */
      resumeExternalId?: string
      importHistory?: boolean
      /** Runs only this session in a git worktree (FR-2 option) */
      worktree?: boolean
      /** The worktree branch name (#69). If empty, the host uses an automatic name */
      worktreeBranch?: string
      /** Where to branch off from. If empty, the project's trunk, or if there is none, the current HEAD */
      worktreeBase?: string
    },
  ): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: ChatAttachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<ChatAttachment | null>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'always',
    scope?: 'session' | 'project',
  ): Promise<void>
  /** Whether the answer reached the host — `false` means a toast was shown (an answer from the composer has `send` put the text back, #180) */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<boolean>
  interrupt(sessionId: string): Promise<void>
  /** Stops one background task (#290). A refusal or failure is a toast — silence would read as stopped */
  stopBackgroundTask(sessionId: string, taskId: string): Promise<void>
  /** Takes the ended background tasks off the session's list (#290) */
  clearBackgroundTasks(sessionId: string): Promise<void>
  /** Hides from the list / brings back (the record survives) */
  /** Restarts only the agent (the conversation stays as is) */
  restartSession(sessionId: string): Promise<boolean>
  /** Moves the session to the trash (#204); the two flags say what goes with it when it is deleted for good */
  deleteSession(sessionId: string, deleteWorktree?: boolean, deleteExternal?: boolean): Promise<void>
  /**
   * Brings a session back from the trash (#204). A project its restore registered again is added here, and asked
   * about trust as a newly added one is. Returns an error message, or null when it is back.
   */
  restoreFromTrash(sessionId: string): Promise<string | null>
  /**
   * Hands off and starts fresh (a dogfooding request — the way out of the 7-13 second resume delay
   * on an old codex thread). The dying session writes a handoff note → the new session starts from
   * that note → the old session (by default) is **actually** deleted, all the way down to the tool's
   * own original. Destruction comes last: nothing is deleted until the new session is successfully
   * up.
   *
   * tool: can also hand off to a different agent (the note is plain text, so it does not care which
   * tool reads it). Defaults to the current tool. Switching tools does not carry over the model,
   * effort, verbosity or speed — those are all tool-specific values, and handing codex's model name
   * to claude would fail right at session creation.
   * deleteOld: defaults to true. Turning it off leaves the old session standing — a branch, not a
   * switch.
   */
  /**
   * mode 'record' (default since #694; #78 made it for a session whose service was cut off): asks the
   * agent nothing and has the host build the note straight from the store's own transcript. 'agent':
   * the departing session writes the note. deleteOld's default follows the mode: kept for 'record'.
   */
  handoffSession(
    sessionId: string,
    opts?: { tool?: ToolName; deleteOld?: boolean; mode?: 'agent' | 'record' },
  ): Promise<void>
  updateSessionSettings(
    sessionId: string,
    s: {
      model?: string | null
      effort?: string | null
      verbosity?: string | null
      serviceTier?: string | null
      permissionPreset?: PermissionPreset
    },
  ): Promise<void>
  resumeSession(sessionId: string): Promise<boolean>
  /**
   * Switches a session's agent (claude ↔ codex).
   * **The conversation does not carry over** — the caller must tell the person that beforehand.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<void>
  /** Wakes a session the instant it is picked (so we do not wait for the first response) */
  wake(sessionId: string): Promise<void>
  /**
   * Branches off a locked conversation and continues it.
   * The only way out that does not require going elsewhere to close another app — the original is
   * left as is.
   */
  forkConversation(sessionId: string): Promise<void>
  /**
   * Recovery after reconnecting. Merges the host's session list into the store (sessions created,
   * changed or deleted while disconnected), and revives sessions that were running (when the host
   * dies, its processes die with it). If `resync` is true, event replay was not possible — the
   * conversation being viewed is also re-read from the store.
   */
  recoverAfterReconnect(resync?: boolean): Promise<void>
  /** Sidebar order (set by the person dragging) */
  reorderProjects(orderedIds: string[]): Promise<void>
  reorderSessions(projectId: string, orderedIds: string[]): Promise<void>
  /**
   * The grid.
   *
   * `view` is the value that picks one screen — the focus view and the grid only show **the same
   * session state** differently, so they never hold separate session data, only a different way of
   * viewing it. (That way, changing a model in the grid follows through to the sidebar and the focus
   * view too.)
   */
  /**
   * What is being viewed right now.
   *   focus        a single session (default)
   *   grid         the grid — controlling by eye
   *   orchestrator the orchestrator — controlling by talking
   */
  view: 'focus' | 'grid' | 'orchestrator' | 'app'
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
  /** The orchestrator session id (`null` if never created — the screen shows an empty conversation plus suggested questions) */
  orchestratorId: string | null
  /** A session is being created for the first question (#63) — a flag so the empty screen does not look dead */
  orchestratorWaking: boolean
  /**
   * Whether the intro screen (orchestrator plus tool cards) has been passed (#63).
   * Kept in the workspace snapshot — this screen appears exactly once, on first run.
   */
  introSeen: boolean
  /** The grid's panels, sessions and apps, in order (#288) — as stored by the host, unknown ones included (GridView leaves those out) */
  gridPanels: GridPanel[]
  setView(view: 'focus' | 'grid' | 'orchestrator'): void
  /**
   * Back and forward between screens, like a web browser (#374). Every screen change is recorded by one subscriber
   * at the bottom of this file (`recordScreen`), whichever action made it, so a new way of jumping somewhere gets
   * history without doing anything. Not saved: a restart begins a fresh history at the screen it restores.
   */
  nav: NavHistory
  /** Shows the previous screen that still exists; nothing when there is none (`navHistory.step`) */
  goBack(): void
  goForward(): void
  /**
   * Opens the orchestrator **screen**. Does not create a session (#63, deferred startup) — attaches
   * to one if it already exists, otherwise an empty conversation waits for the first question.
   * `askOrchestrator` is what creates it.
   */
  openOrchestrator(): Promise<void>
  /**
   * Asks the orchestrator something. **If there is no session, one is created at this moment** —
   * both the suggested-question cards and the empty screen's composer go through this door (#63).
   */
  /** Whether the first message reached the orchestrator — `false` means it was never born (the caller puts the text back, #180) */
  askOrchestrator(text: string): Promise<boolean>
  /** Passes the intro screen (#63): records the tool choice with the host, and goes to the orchestrator screen */
  completeIntro(tool: ToolName): Promise<void>
  /**
   * Saves the grid's panels whole — adding, removing and reordering are all this one call. An app panel no longer in
   * the list has its view closed, teardown first, as the project screen's × does.
   */
  setGridPanels(panels: GridPanel[]): Promise<void>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string): Promise<void>
}
