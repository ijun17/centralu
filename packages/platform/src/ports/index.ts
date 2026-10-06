import type {
  ProjectConsent,
  ProjectConsentKind,
  AdapterCapabilities,
  AppErrorBundle,
  AppReach,
  AppId,
  AppPermission,
  AppUsage,
  AppQuestion,
  AppReview,
  AppRun,
  AppVersions,
  ApprovalDecision,
  ApprovalScope,
  Attachment,
  CreateSessionParams,
  CommandInfo,
  ExternalAppInfo,
  ExternalSession,
  UpdateSettingsParams,
  UpdateSettingsResult,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  GridPanel,
  NormalizedEvent,
  ProjectInfo,
  SavedCommand,
  SessionInfo,
  StoredMessage,
  TrashedSession,
  UsageSnapshot,
  TerminalInfo,
  CommandRunInfo,
  ToolName,
  ToolStatus,
  ModelOption,
  QuestionAnswer,
  UiPreferences,
  UiPreferencesPatch,
  ThemeFileContent,
  ThemeFileEntry,
  UpdateStatus,
  AgentVersions,
} from '@cc/protocol'

/**
 * The Platform port (docs/platform-abstraction.md §2).
 * The only outside world ui knows about. The implementations (web/tauri/mock) know only the
 * apps entry point.
 *
 * Rules:
 *  - Every method returns a Promise (even a synchronous implementation — the signature stays
 *    stable even if it later moves to IPC)
 *  - Streams are unified as subscribe(handler): Unsubscribe
 *  - Input and output types all come from protocol. Implementation details (WS frames, invoke
 *    names) must not leak out
 */

export type Unsubscribe = () => void

export type PlatformError = {
  code: string
  message: string
  retryable: boolean
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'resync_required'

export interface AgentPort {
  createSession(params: CreateSessionParams): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** Saves a pasted image and returns its path (so base64 does not end up in the conversation record) */
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string): Promise<Attachment>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    /** The pattern that "always allow" targets (computed by core) */
    matcher?: string,
  ): Promise<void>
  /** Answers the options (AskUserQuestion) — the answer goes to the model as that tool's result */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /** Stops one background task the session listed as stoppable (#290); its ending arrives as an event */
  stopBackgroundTask(sessionId: string, taskId: string): Promise<void>
  /** Takes the ended background tasks off the session's list (#290) */
  clearBackgroundTasks(sessionId: string): Promise<void>
  /** Sidebar order (the person sets it by dragging). Sends the whole order at once */
  reorderSessions(projectId: string, orderedIds: string[]): Promise<SessionInfo[]>
  /**
   * The app's one and only orchestrator. **Calling it creates one if it does not exist.**
   * It does not belong to a project, so projectId is null.
   */
  orchestrator(): Promise<SessionInfo>
  /**
   * Returns it if it exists, and **does not create one if it does not** (#63). Used by
   * whichever screen is opening — creation happens in orchestrator(), at the moment the
   * person asks the first question (lazy startup).
   */
  orchestratorPeek(): Promise<SessionInfo | null>
  /** The tool the central orchestrator runs on (#63, the card choice on the intro screen). Only meaningful before it is created */
  configureOrchestrator(tool: ToolName): Promise<void>
  /**
   * Grid layout — sessions and apps, in order (#288). Adding, removing and reordering all come
   * through this one call; the answer is the list as stored (unknown sessions left out).
   */
  grid(): Promise<GridPanel[]>
  setGridView(panels: GridPanel[]): Promise<GridPanel[]>
  /** The models available to pick and each model's reasoning strength (what the tool reports through its official API) */
  models(tool: ToolName): Promise<{ supported: boolean; reason?: string; models: ModelOption[] }>
  /** Restarts only the agent attached to the session (the conversation stays as is) */
  restartSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /**
   * Moves the session to the trash (#204) — nothing is destroyed here; `TrashPort` is the way out.
   * `deleteWorktree` and `deleteExternal` choose what goes with it when it is deleted for good from the trash:
   * the worktree, and the tool's own conversation file (codex rollout, claude JSONL). Both stay until then.
   */
  deleteSession(sessionId: string, deleteWorktree?: boolean, deleteExternal?: boolean): Promise<void>
  /** The material needed to ask the person whether it is fine to delete. Null if it is not a worktree session */
  worktreeStatus(sessionId: string): Promise<{ path: string; branch: string; dirty: boolean; changedFiles: number } | null>
  /**
   * A dead-agent handoff record (#78) — the host creates it without calling that session's
   * tool. The host writes it to the notes location in the data folder and returns the
   * absolute path (#102, #142); text is for the preview.
   */
  exportHandoffRecord(sessionId: string, toTool?: ToolName): Promise<{ text: string; path: string }>
  /**
   * The note for a live handoff (#142) — the first human message after afterSeq (the last seq
   * right before the request) is the request, and the host puts the agent's last answer after
   * that in the same spot.
   * Null means "not yet": either a turn is running, or there is no answer.
   */
  exportHandoffNote(sessionId: string, afterSeq: number): Promise<{ text: string; path: string } | null>
  /** The orchestrator's list of proposed MCP servers (propose_mcp_server → the ones waiting for approval) */
  mcpProposals(): Promise<{ proposals: { name: string; command: string; args: string[]; why?: string }[] }>
  /** The person's answer to a proposal — if approved, the app registers it and restarts the orchestrator */
  resolveMcpProposal(name: string, approve: boolean): Promise<void>
  /** The orchestrator's list of proposed skills (#71 — propose_skill → the ones waiting for approval) */
  skillProposals(): Promise<{ proposals: { name: string; content: string; why?: string }[] }>
  /** The person's answer to a skill proposal — if approved, saves it to the DB and restarts the orchestrator */
  resolveSkillProposal(name: string, approve: boolean): Promise<void>
  /** The list of approved skills — viewed and deleted from Settings (a skill that cannot be deleted is worse than none) */
  orchestratorSkills(): Promise<{ skills: { name: string; content: string }[] }>
  deleteOrchestratorSkill(name: string): Promise<void>
  /**
   * Previous sessions the tool has kept (including ones created from the terminal).
   * If supported=false, a reason comes with it — even an older tool version does not block
   * "new session".
   */
  listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit?: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }>
  /**
   * Revives a dead session (FR-10). If resumed=false, a reason comes with it.
   * If `lockedElsewhere`, "fork and continue" can be offered without even reading the reason.
   */
  resumeSession(
    sessionId: string,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  /**
   * Forks off a locked conversation and continues it as this session.
   * Leaves the original as is — does not take away a conversation another app was using.
   */
  forkConversation(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /**
   * Switches the session's agent (claude ↔ codex).
   * **The conversation does not carry over** — the new tool does not know the old conversation.
   * The record stays in our own store.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<SessionInfo>
  /**
   * Changes model, permissions and reasoning strength mid-conversation (FR-7).
   * The fields are defined by the protocol — restating them here would let a later-added field
   * silently drop out.
   */
  updateSettings(sessionId: string, settings: Omit<UpdateSettingsParams, 'sessionId'>): Promise<UpdateSettingsResult>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string, seq: number): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  loadMessages(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  /**
   * The steps of the native subagent one card launched (#222), oldest first, paging forward from `afterSeq`. Asked only
   * when the person opens that card's steps — they are never part of `loadMessages`.
   */
  loadSubagentMessages(sessionId: string, parentCallId: string, afterSeq?: number, limit?: number): Promise<StoredMessage[]>
  capabilities(tool: ToolName): Promise<AdapterCapabilities>
  /**
   * This session's slash commands (skills).
   * ready=false does not mean "none" — it means the tool is not ready yet.
   */
  commands(sessionId: string): Promise<{ ready: boolean; commands: CommandInfo[] }>
  /** Account usage and limits (FR-9). Handles only subscription limits */
  usage(tool: ToolName): Promise<{ supported: boolean; reason?: string; usage: UsageSnapshot | null }>
  detect(): Promise<ToolStatus[]>
  /**
   * The agent CLIs installed now, and whether idle sessions move to a newer one by themselves (#297). `force: false`
   * (the window gaining focus) takes a reading from moments ago.
   */
  versions(force?: boolean): Promise<AgentVersions>
  /** "Move idle sessions to a newly installed agent CLI" on or off (#297) */
  setAutoApplyVersions(enabled: boolean): Promise<AgentVersions>
  /** Restarts every idle session that runs an older CLI on the installed one; the busy ones are listed (#297) */
  applyVersions(): Promise<{ restarted: string[]; busy: string[] }>
  /** Event stream — receives events from the moment of subscription onward */
  subscribe(handler: (event: NormalizedEvent) => void): Unsubscribe
  onConnectionChange(handler: (state: ConnectionState) => void): Unsubscribe
}

export interface ProjectPort {
  reorder(orderedIds: string[]): Promise<ProjectInfo[]>
  add(path: string): Promise<ProjectInfo>
  list(): Promise<ProjectInfo[]>
  gitStatus(projectId: string): Promise<ProjectInfo>
  /**
   * Delete a project and everything this app remembers about it.
   *
   * The folder is not this call's business — the OS trash belongs to the shell, so the
   * caller empties it first and only then removes the record. That order is forced: the
   * path lives in the row, so deleting the row first would leave nothing to point at.
   */
  remove(projectId: string): Promise<{ ok: true }>
  /**
   * Replace this project's saved shell commands, whole (issue #44).
   *
   * Adding and deleting come through the same door, as `reorder` above does: for a short
   * list a person edits by hand, "make it look like this" already states every edit.
   * What comes back is what was actually stored — the host drops blank entries, so it can
   * differ from what was sent.
   */
  setCommands(projectId: string, commands: SavedCommand[]): Promise<SavedCommand[]>
  /** Saves the worktree provisioning setup (#69). Null clears it */
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /**
   * Trusts or stops trusting this project (M4, decision 3). Trusting it lets this project's
   * apps run and its project settings be honored. Turning it off brings those apps down
   * immediately. Changes to the app list come separately, as `external_apps_changed`.
   */
  setTrusted(projectId: string, trusted: boolean): Promise<void>
  /**
   * Creates the worktree manager slot (#76). If it already exists, returns that slot and just
   * rewrites the trunk.
   * baseBranch is decided by the caller — inventing a default further down would silently
   * bake in the wrong trunk.
   */
  createWorktreeManager(projectId: string, baseBranch: string): Promise<SessionInfo>
}

/**
 * File tree and viewer (FR-5, FR-6 / C-1).
 * Lazy listing is the principle — reads only directories that have been opened (keeps it
 * light on large repositories).
 */
export interface FsPort {
  /** File search for `@` autocomplete (within the project only) */
  search(projectId: string, query: string, limit?: number): Promise<{ path: string; name: string }[]>
  /** Reads one level only. ignored are entries caught by .gitignore (reusing what git already reports) */
  listDir(projectId: string, relPath: string): Promise<FsEntry[]>
  /**
   * Replaces the whole set of watched directories (#34). The set expanded on screen is
   * exactly the watched set.
   * Changes arrive as `fs_changed` on the event stream — this call only registers.
   */
  watch(projectId: string, paths: string[]): Promise<{ watched: number }>
  readFile(projectId: string, relPath: string): Promise<FsFile>
  /** Resolve a project-relative path to the host-validated absolute path for native handoff. */
  resolve(projectId: string, relPath: string): Promise<{ path: string }>
  /**
   * Move an entry into another folder of the same project (#19, drag inside the tree).
   *
   * `toDir` is a folder (`''` is the project root), never a full path — the gesture is a
   * drop onto a row and the name never changes, which is also why renaming is not reachable
   * from here (out of scope for #19).
   *
   * **Never overwrites**: a destination that is already taken rejects, naming the
   * collision. `moved: false` means it landed where it already was — a miss, not a failure.
   */
  move(projectId: string, from: string, toDir: string): Promise<{ path: string; moved: boolean }>
  /**
   * Put a file dragged in from the desktop into the project (#19).
   *
   * Bytes, not a source path: the webview does not tell the page where a dropped file came
   * from, which is the same reason attachments already travel this way. So the original
   * stays where it was — the only direction that cannot destroy something outside the
   * project. Rejects rather than overwrite, like `move`.
   */
  importFile(projectId: string, toDir: string, name: string, dataBase64: string): Promise<{ path: string }>
  /**
   * Move to the OS trash (#18). **Not a delete** — that is the whole decision: the trash
   * stays reversible *after* the click, which is worth more than a dialog before it.
   *
   * `supported: false` comes with a reason the UI can show, the same shape `models()` uses.
   * A browser has no trash and cannot be given one.
   */
  trash(projectId: string, relPath: string): Promise<{ supported: boolean; reason?: string }>
  /** Show it in the desktop's file manager (#19). Unsupported in a browser, with a reason */
  reveal(projectId: string, relPath: string): Promise<{ supported: boolean; reason?: string }>
}

/** What it is calling about — this decides how strong the sound and the dock bounce are */
export type AlertKind = 'approval' | 'error' | 'done' | 'all_done'

export type FsEntry = { name: string; path: string; isDir: boolean; ignored: boolean }
export type FsFile = {
  text: string
  truncated: boolean
  binary: boolean
  bytes: number
  /** Raster image payload for the read-only viewer. Arbitrary binary files omit this. */
  image?: { mime: string; data: string }
  previewError?: string
}

export interface SystemPort {
  notify(title: string, body: string): Promise<void>
  /**
   * Calls out with sound and the dock icon.
   *
   * Kept separate from `notify` (the OS banner) because **the delivery path is different**.
   * The banner depends on notification permission and code signing, while this one depends
   * on neither. Since we measured the banner path being dead on macOS, this is the one that
   * actually reaches a person who has stepped away.
   */
  alert(kind: AlertKind, sound: boolean): Promise<void>
  setBadge(count: number): Promise<void>
  openInIde(path: string, line?: number): Promise<void>
  /**
   * Opens an http(s) address in the OS's default browser (#159). Used by terminal links and
   * links in app screens.
   *
   * Why this is not just `window.open` at every call site: in the desktop webview
   * (WKWebView), that opens nothing. Without a new-window handler, wry drops the request, and
   * no error is raised either. The address check (http(s) only) has already been done by the
   * caller. Throws if it cannot open.
   */
  openUrl(url: string): Promise<void>
  /** Directory picker. Desktop uses the native picker; web dev falls back to a path input (FR-19) */
  pickDirectory(): Promise<string | null>
  /**
   * Picks a single file (M4 E-3 — the .zip to import). Desktop uses the native picker
   * (filtered by extension); web dev falls back to a path input.
   * The host re-validates the chosen path — the picker's filtering is a convenience only.
   */
  pickFile(opts: { title: string; extensions: string[] }): Promise<string | null>
  /**
   * Listens for an app link (`centralu://app?url=…`, M4 E-4) the OS handed this app. If the
   * app was first launched by a link, that already-arrived link is also delivered once, right
   * at the moment of subscribing. A link is text written by someone else, so the receiver
   * validates it (`parseAppLink`). An implementation that does not receive links (web) never
   * calls this.
   * @returns unsubscribes
   */
  onAppLink(cb: (link: string) => void): () => void
  /**
   * Starts dragging the window from here (since we hid the title bar, we have to build our
   * own handle).
   * `data-tauri-drag-region` alone is not enough — that attribute has to be on the
   * **mousedown target itself**, so grabbing text inside the header breaks it. In practice
   * this showed up as "only works sometimes".
   * Does nothing on the web.
   */
  startWindowDrag(): Promise<void>
  /**
   * Tells the window which side of the theme is showing (#312).
   *
   * `scheme` is `null` to follow the OS. It is what the webview's `prefers-color-scheme`
   * answers with: a window held to one appearance reports that appearance to the page, so
   * System mode can only see the OS once the window stops being held. `background` is the
   * floor colour as a computed CSS colour, for the strip the window paints before or around the
   * page (the first frame, a resize).
   *
   * Does nothing on the web, where the browser already follows the OS.
   */
  setWindowAppearance(scheme: 'dark' | 'light' | null, background: string): Promise<void>
}

export type PlatformCapabilities = {
  osNotifications: boolean
  dockBadge: boolean
  globalShortcuts: boolean
  processSupervision: boolean
  openInIde: boolean
  /**
   * How many px the OS window controls occupy at the left edge of our own top bar.
   *
   * macOS puts the traffic lights *inside* the overlay title bar, so our bar has to
   * leave a hole for them; other desktops draw their decorations in a separate strip
   * and the bar owns the full width. This used to be a hardcoded `pl-[86px]` in the
   * header, which is the exact shape of leak this package exists to prevent: the number
   * is a fact about the window manager, not about the design. Asking for a width rather
   * than an OS name keeps ui free of platform checks.
   */
  windowControlsInset: number
  /**
   * What this machine's keyboard prints on the modifier keys we put on screen.
   *
   * Every shortcut handler already accepts `metaKey || ctrlKey`, so the keys have always
   * worked on Linux and Windows — only the labels lied, and they lied in 61 places because
   * `⌘` was written out at every call site. A symbol nobody's keyboard has is worse than
   * no hint at all: it tells you the app is not for you.
   *
   * Asking for the *labels* rather than for an OS name is the same trade as
   * `windowControlsInset` above, for the same reason: ui is the one package with no
   * platform implementation behind it, so an OS check there is invisible to every test we
   * run (`tooling/styles.test.ts` fails the build if one appears).
   *
   * `⇧` is deliberately absent — it is printed on those keyboards too, so there is nothing
   * to translate and no reason to make the port carry it.
   */
  shortcutKeys: ShortcutKeys
  /**
   * What this desktop calls the thing that shows you a file in a folder (#19).
   *
   * Same trade as `shortcutKeys` above: "Reveal in Finder" is the phrase everyone knows on
   * a Mac and a lie everywhere else, and ui is not allowed to ask which OS it is on — so it
   * asks for the *word* and prints it. Linux has no single answer (Nautilus, Dolphin,
   * Thunar…), so the generic phrase is the honest one there rather than a guess.
   */
  fileManagerName: string
  /**
   * Whether a frame's `dragend` reports where the drag ended in the top page's coordinates rather
   * than the frame's own (#308). The UI places an item dragged out of an app view by that point
   * (app-frame/dragRelay.ts), and the engines disagree: WebKit reports the frame's coordinates, as
   * the spec has it, Chromium (WebView2 on Windows) the page's. An engine fact, asked for here for
   * the same reason as the keyboard above: ui does not look at what it runs on (`engine.ts` has the
   * measurement).
   */
  frameDragEndInPage: boolean
}

/**
 * What the keyboard calls the two modifier keys, and what goes between them when a
 * combination is written as one chunk.
 *
 * Why `join` exists: a Mac writes them run together, like `⌘⇧A`, but carrying that rule over
 * as-is turns into `CtrlShiftA` on other keyboards. Running them together read fine only
 * because they were symbols; the moment they become names, a separator is needed — so the
 * side that knows the keyboard answers with it too.
 */
export type ShortcutKeys = {
  /** `⌘` here, `Ctrl` where there is no command key */
  mod: string
  /** `⌥` here, `Alt` elsewhere */
  alt: string
  /** What goes between keys when a combination is written as one string */
  join: string
}

/**
 * Git inspection and operations (FR-4, B-1 new).
 * The implementation lives in the host's dev-services — moving to git2 (Rust) is on hold
 * until measurement confirms it is a bottleneck.
 */
export interface GitPort {
  status(projectId: string): Promise<GitFileStatus[]>
  diff(projectId: string, path: string, staged?: boolean): Promise<GitDiff>
  log(projectId: string, limit?: number): Promise<GitCommit[]>
  commitDetail(projectId: string, sha: string): Promise<{ files: string[]; diff: string; truncated: boolean }>
  branches(projectId: string): Promise<GitBranch[]>
  /** Things git ignores (#76) — things a new worktree will not have; flagged as copy candidates */
  ignoredEntries(projectId: string): Promise<{ path: string; bytes: number | null }[]>
  /** With dryRun, only reports what would conflict (show it, do not block it) */
  checkout(projectId: string, branch: string, dryRun?: boolean): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  stage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  commit(projectId: string, message: string): Promise<{ ok: boolean; message?: string }>
  push(projectId: string): Promise<{ ok: boolean; message?: string }>
}

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
  focusedApp?: { projectId: string | null; appId: string } | null
  /** Whether the evidence panel (git/files) was open */
  panelOpen?: boolean
  /** What the evidence panel was showing — pre-#20 single-tab field, kept for old snapshots/builds */
  panelTab?: string
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
  /**
   * @deprecated The text size step (0..4) from before #312 step 5. The text size is a preference
   * now (`UiPreferences.textSize`); this is only read, once, to move an old value there.
   */
  textScale?: number
  /** @deprecated The tab structure was replaced by three lanes. Appears only when reading an old snapshot */
  tab?: string
}

/** Conversation search and approval-rule management (E-1, E-4) */
export interface SearchPort {
  messages(query: string, limit?: number): Promise<{ sessionId: string; seq: number; snippet: string }[]>
}

export interface ApprovalRulesPort {
  list(): Promise<
    {
      id: number
      scope: string
      matcher: string
      decision: string
      createdAt: number
      /** The rule's owner — projectId for project scope, sessionId for session scope (#183) */
      projectId?: string | null
      sessionId?: string | null
    }[]
  >
  remove(id: number): Promise<void>
}

/**
 * Cross-project consents (#371): the person's remembered "always" for one project reaching another — 'delegate'
 * (ask_project starts a session there) or 'apps' (its apps attach to the caller). Listed and revoked in Settings;
 * the host raises the question itself, as an approval card in the calling session.
 */
export interface ProjectConsentsPort {
  list(): Promise<ProjectConsent[]>
  /** The next reach from that project to that one asks again */
  revoke(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): Promise<void>
}

/**
 * The trash (#204). Deleting a session moves it here; these are the ways out, and they belong to the person
 * (Settings → Trash). Nothing here is emptied on its own, so `list` carries the total size.
 */
export interface TrashPort {
  list(): Promise<{ sessions: TrashedSession[]; bytes: number }>
  /** A trashed conversation, read-only — pages like `AgentPort.loadMessages` */
  read(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  /** Back as it was. `project` is set when its project had been deleted and restoring registered the folder again */
  restore(sessionId: string): Promise<{ session: SessionInfo; project: ProjectInfo | null }>
  /** Deletes one for good, with what the person chose to remove with it */
  purge(sessionId: string): Promise<void>
  /** Deletes all of them for good; one that fails stays in the trash and is reported */
  empty(): Promise<{ purged: number; failed: { sessionId: string; name: string; error: string }[] }>
}

/**
 * Updates for the app itself (issue #43).
 *
 * **Both checking and installing happen entirely on the other side (the host).** Asking the
 * registry and running `npm i -g` is something a browser cannot do, and more importantly,
 * leaving the check to the launcher means the stale copy already installed on the person's
 * machine is the one that answers — that stale copy's comparison being wrong is what #42 was.
 *
 * The port carries exactly one thing: status. The screen only needs to know "where are we
 * right now". Relaunching into what was installed is not this port's: only a desktop window
 * can do it, through `RelaunchPort` (#352).
 */
export interface UpdatePort {
  /** What is known right now. With `force`, asks the registry again (Settings' "Check now") */
  status(force?: boolean): Promise<UpdateStatus>
  /** Turns periodic checking on and off */
  setAuto(enabled: boolean): Promise<UpdateStatus>
  /** "Apply updates automatically when idle" on and off (#352); the host installs, the window applies */
  setAutoApply(enabled: boolean): Promise<UpdateStatus>
  /**
   * Installs the new version. **Only when the person clicks it.**
   *
   * Responds as soon as it starts — `npm i -g` routinely exceeds the RPC timeout, and a
   * contract that waits for it to finish would make an install that actually succeeded look
   * like a failure on screen. The rest arrives as events.
   */
  apply(): Promise<UpdateStatus>
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

/**
 * Project terminal.
 *
 * **Its identity is the cwd** — not the session. The same terminals carry over even when the
 * session changes within the same project, and a git worktree session automatically gets its
 * own terminal because its cwd is different.
 */
export interface TerminalPort {
  /** That project's terminal list (the screen is restored from history) */
  list(projectId: string): Promise<TerminalInfo[]>
  /** Opens one more terminal */
  create(projectId: string, cols: number, rows: number): Promise<TerminalInfo>
  /** Closes one terminal */
  close(terminalId: string): Promise<void>
  input(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  /** Restarts it when the shell hangs (the record stays) */
  restart(terminalId: string, cols: number, rows: number): Promise<TerminalInfo>
  onOutput(handler: (e: { terminalId: string; data: string }) => void): Unsubscribe
  onExit(handler: (e: { terminalId: string; exitCode: number | null }) => void): Unsubscribe
}

/**
 * Runner for frequently used commands (#60). A separate execution path from terminal tabs —
 * one process per command, one last-run log (for the lifetime of the host).
 * The output stream rides on terminal.onOutput/onExit as is (runId takes the place of
 * terminalId).
 */
export interface CommandRunPort {
  /** Runs it. If the same command is already running, kills it and starts fresh */
  run(projectId: string, command: string, cols: number, rows: number): Promise<CommandRunInfo>
  /** Stops the dev server. The log stays */
  stop(projectId: string, command: string): Promise<void>
  /** The status of commands that have run before (for the list badges) */
  state(projectId: string): Promise<CommandRunInfo[]>
  /** The last run, log included. Null if it has never run */
  log(projectId: string, command: string): Promise<(CommandRunInfo & { history: string }) | null>
  resize(projectId: string, command: string, cols: number, rows: number): Promise<void>
}

/**
 * Where to mount one app screen (M4 B-3). Created by the host. `url` contains a secret slot
 * that changes on every run. Never written to a log or the screen.
 */
export type AppViewFrame = {
  url: string
  /** The outer iframe's `allow` — only the capabilities the app declared and the host accepted */
  allow: string
  /** The CSP domains and permissions the host accepted. Reported to the screen as `hostCapabilities.sandbox` */
  sandbox: {
    csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] }
    permissions: Record<string, object>
  }
}

/**
 * **Which screen** a call from a screen came from. An app is identified by (project, id), so
 * projectId travels with it (`null` is a user-folder app). If instanceId is present, the host
 * checks it against that screen's app.
 */
export type AppCallOrigin = { projectId?: string | null; instanceId?: string }

/** The shape of an MCP `tools/call` response (exactly per spec — this layer only carries it) */
export type AppToolResult = {
  content: Record<string, unknown>[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/**
 * One pinned screen (M4 B-2) — the screen instance the host opened by calling the `home`
 * tool, plus that call's input (tool-input) and result (tool-result), which AppFrame sends
 * per spec.
 */
export type AppHomeView = {
  instanceId: string
  tool: string
  resourceUri: string
  toolInput: Record<string, unknown>
  toolResult: AppToolResult
  runId: string
}

/**
 * A reopened in-conversation screen (M4 B-1) — the new instance, plus that call's input and
 * outcome, which AppFrame resends per spec.
 * The result (`toolResult`) and cancellation (`cancelled`) are either one or the other (it
 * finished), or neither (it is still running).
 */
export type InlineViewReopened = {
  instanceId: string
  appId: AppId
  projectId: string | null
  tool: string
  toolInput: Record<string, unknown>
  toolResult?: AppToolResult
  cancelled?: string
}

/** One in-conversation screen the host is holding (M4 B-1) — without its body */
export type InlineViewKept = {
  callId: string
  appId: AppId
  projectId: string | null
  tool: string
  kept: boolean
  instanceId: string | null
}

/** The shape of an MCP `resources/read` response */
export type AppResourceResult = { contents: ({ uri: string } & Record<string, unknown>)[] } & Record<string, unknown>

/**
 * One new app (M4 C-1) — `projectId` null means a user-folder app. `tool` is the builder
 * session's tool; if absent the host picks one (the project's default tool, or the
 * orchestrator's tool for a user-folder app).
 */
export type NewAppSpec = { projectId: string | null; id: string; name: string; description?: string; tool?: ToolName }

/**
 * The created app and its builder session. If the session failed to start (no tool, or not
 * logged in yet), `builder` is null and `builderError` is the reason — the app has already
 * been created either way.
 */
export type AppCreated = { app: ExternalAppInfo; builder: SessionInfo | null; builderError?: string }

/**
 * A message to the builder session, sent from an app (M4 C-5). `instanceId` is the pinned
 * screen the person was viewing — the host writes which screen it came from into the header,
 * using that instance. Attachments are already saved under the builder session's id (the
 * same path the composer uses).
 */
export type BuilderAsk = {
  appId: AppId
  projectId: string | null
  text: string
  attachments?: Attachment[]
  instanceId?: string
}

/**
 * The external apps (M4) — discovery, their screens, and the calls those screens make.
 */
export interface AppsPort {
  /**
   * The address at which to mount an app screen (M4 B-3). `hostOrigin` is the origin
   * (`location.origin`) of the calling screen. The sandbox proxy exchanges messages only with
   * that origin.
   */
  viewFrame(appId: AppId, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }): Promise<AppViewFrame>
  /**
   * An app tool the screen calls (the bridge's `oncalltool`). The response is exactly the MCP
   * result the app gave (including `structuredContent`, `isError`, `_meta`). If the app could
   * not be reached, this is an `isError` result carrying a reason written by the host. Scope
   * (`app` only) and logging are handled by the host's mediation.
   */
  callTool(appId: AppId, tool: string, args: Record<string, unknown>, from?: AppCallOrigin): Promise<AppToolResult>
  /** The screen reads its own app's resource (the bridge's `onreadresource`) */
  readResource(appId: AppId, uri: string, from?: AppCallOrigin): Promise<AppResourceResult>
  /**
   * Every external app discovered, and its state (M4 A-8). Apps from an untrusted project and
   * broken apps come too, with a reason. When the list changes, the host broadcasts
   * `external_apps_changed`, and the receiver calls this again.
   */
  list(): Promise<ExternalAppInfo[]>
  /**
   * Opens a pinned screen (M4 B-2) — the host calls the manifest's `home` as the screen caller
   * and opens an instance. Fails with a reason if there is no home, the app did not declare a
   * screen, or the app could not be reached.
   */
  openView(appId: AppId, projectId: string | null): Promise<AppHomeView>
  /** Closes a pinned screen — releases the app it was holding. Passes quietly if it is already closed */
  closeView(instanceId: string): Promise<void>
  /**
   * Sends an app screen's `ui/message` into the conversation (M4 B-1·B-4) — called **only
   * after the person confirms**. The host masks the app behind the instance. For an
   * in-conversation screen it can only go to the conversation that screen stands in (the host
   * rejects it otherwise); for a pinned screen it goes to whichever conversation the person
   * chose. It is recorded in the conversation as a message the app sent
   * (`user_message.fromApp`), and the agent receives it wrapped in the app's own text.
   */
  sendViewMessage(sessionId: string, instanceId: string, text: string): Promise<void>
  /**
   * Reopens an in-conversation screen that had been collapsed (M4 B-1's "Reopen") — does not
   * call the tool again. The host returns a new instance plus the input and outcome it had
   * been holding. Fails with a reason if it is not holding one (in that case, opening the app
   * is the only path left).
   */
  reopenInlineView(sessionId: string, callId: string): Promise<InlineViewReopened>
  /**
   * The in-conversation screens the host is holding for one conversation (M4 B-1) — queried
   * when the reopen UI is setting up the placeholder for a past card. `kept` means it can be
   * reopened; if `instanceId` is present, it is an instance left open (the reopen UI closes it
   * to release the app).
   */
  inlineViews(sessionId: string): Promise<InlineViewKept[]>
  /**
   * Makes the app startable again (M4 B-6's "Restart") — clears consecutive failures and the
   * reason, and brings it down if it is up.
   * **Does not start it up**: whoever calls next (the screen that reopens it) starts it.
   */
  restart(appId: AppId, projectId: string | null): Promise<void>
  /**
   * One app's run history, most recent first (M4 B-7) — who (screen, session, app) called
   * which tool and how it ended. Arguments arrive only as a summary. The history is readable
   * even for an app whose folder is gone.
   */
  runs(appId: AppId, projectId: string | null, limit?: number): Promise<AppRun[]>
  /**
   * Deletes a user-folder app (M4 A-7) — its folder is moved to `app-trash/` in the data
   * folder, and the run history stays. The host rejects this for a project app (it is a file
   * in the repository, so git is where it gets collected).
   */
  remove(appId: AppId, projectId: string | null): Promise<void>
  /**
   * Creates a new app from a template (M4 C-1) — called by the "New app" window. The same
   * door as the orchestrator's `create_app`. The host validates the name, trust and any
   * existing id; a rejection carries the reason as the error message (the window stays open
   * as it was). Does not start the app.
   */
  create(spec: NewAppSpec): Promise<AppCreated>
  /** That app's builder session (M4 C-2) — null if there is none (never created, or deleted) */
  builder(appId: AppId, projectId: string | null): Promise<SessionInfo | null>
  /** Creates that app's builder session (M4 C-2) — returns the existing one if there already is one */
  createBuilder(appId: AppId, projectId: string | null, tool?: ToolName): Promise<SessionInfo>
  /**
   * "Fix this" (M4 C-5) — sends the message from the input line below an app screen to that
   * app's builder session. The host attaches a header noting which app and screen it came
   * from, and, if the app is stalled or the last run failed, that fact too. Rejects if there
   * is no builder session.
   * @returns the builder session the message went to
   */
  askBuilder(req: BuilderAsk): Promise<{ sessionId: string }>
  /**
   * One app's recent error bundles (M4 C-6) — moments the app failed to start, died, or a
   * tool failed. `latest` is what the screen displays. A bundle that has been sent to the
   * builder session carries `sentAt`.
   */
  errors(appId: AppId, projectId: string | null): Promise<{ latest: AppErrorBundle | null; recent: AppErrorBundle[] }>
  /**
   * Whether a session can use one app's tools right now, and if not, why (#308). Asked when an item
   * dragged out of that app's view lands in the session's composer: the link goes in either way, and
   * the composer says what would fix a session that cannot reach the app.
   */
  reach(sessionId: string, appId: AppId, projectId: string | null): Promise<AppReach>
  /**
   * Sends one error bundle (`at`) to that app's builder session (M4 C-6) — **only when the
   * person clicks it.** Each bundle goes only once (the host rejects a second attempt).
   */
  sendError(appId: AppId, projectId: string | null, at: number): Promise<{ sessionId: string }>
  /**
   * The capability questions still waiting for an answer, among the chains that started from
   * a screen (M4 D-4). The pinned screen draws that app's questions, and the app row in the
   * sidebar shows "waiting for an answer". Re-read when the host broadcasts
   * `external_app_questions_changed`. Questions from a chain that started in a session are
   * not here — they are that session's approval card (`capability`).
   */
  questions(): Promise<AppQuestion[]>
  /** Answers a capability question (M4 D-4) — the answer is remembered for that app and that capability. The host rejects it if the question is already closed */
  answerQuestion(questionId: string, decision: 'allow' | 'deny'): Promise<void>
  /** The remembered capability answers for one app (M4 D-4) */
  permissions(appId: AppId, projectId: string | null): Promise<AppPermission[]>
  /** Forgets one remembered answer (M4 D-4) — asks again the next time that capability is needed */
  forgetPermission(appId: AppId, projectId: string | null, capability: string): Promise<void>
  /** The agent usage one app has requested (M4 D-5) — the last day and the last 30 days */
  usage(appId: AppId, projectId: string | null): Promise<AppUsage>
  /**
   * Sets or changes (`value`) or deletes (`null`) one of the app's secrets (M4 E). The value
   * lives only in a 0600 file on the host — it never comes back in this response or in any
   * listing. The list (`list`) only says whether each declared name is present or absent.
   * Only names the manifest declares can be set, and a running app picks up the new value the
   * next time it needs it.
   */
  setSecret(appId: AppId, projectId: string | null, name: string, value: string | null): Promise<void>
  /**
   * Shares a project app with the person's other projects, or stops (#371 part A). Off by default;
   * a session in another project can then find and attach it, once the person allows that pair of
   * projects. Turning it off detaches it from every session that attached it.
   */
  setShared(appId: AppId, projectId: string, shared: boolean): Promise<void>
  /**
   * Prepares to import an app (M4 E-3) — the host copies the source (a folder on this
   * machine, a local .zip, or a .zip over https) into a staging area and returns what the
   * person should review. **It has not been admitted yet.** Rejections (a link pointing
   * outside, zip slip, exceeding the size limit, a colliding id) are thrown exactly as the
   * host states them.
   */
  importPrepare(source: string): Promise<{ token: string; review: AppReview }>
  /** Admits the app from staging — disabled. With `enable`, also records confirmation using the key (`reviewKey`) from the window the person reviewed. Does not start it */
  importCommit(token: string, opts: { enable: boolean; reviewKey?: string }): Promise<ExternalAppInfo>
  /** Cancels the import — clears the staging area */
  importCancel(token: string): Promise<void>
  /** The review window for an admitted app (M4 E-3) — an imported app not yet enabled, or one whose `server`/`uses` changed after being enabled. If it changed, `changed` is the declaration from when it was enabled */
  review(appId: AppId, projectId: string | null): Promise<AppReview>
  /** Enables an imported app — `reviewKey` is the key from the window the person reviewed. The host rejects it if the manifest changed in the meantime */
  enable(appId: AppId, projectId: string | null, reviewKey: string): Promise<ExternalAppInfo>
  /**
   * An app's versions (M4 E-1) — for a user-folder app, snapshots the host has kept (most
   * recent first, with `current` on the one matching the running code); for a project app,
   * the recent commits that touched that app's folder (git is the version history here,
   * read-only).
   */
  versions(appId: AppId, projectId: string | null): Promise<AppVersions>
  /**
   * Restores a user-folder app to a kept version (M4 E-1) — the host keeps a snapshot of the
   * current code as a version, then overwrites it and restarts with that code. The host
   * rejects this for a project app (git is where restoring happens there).
   */
  restoreVersion(appId: AppId, projectId: string | null, id: string): Promise<ExternalAppInfo>
}

/**
 * Leftover processes still running from our folders (requested by the person, 2026-09-07).
 *
 * A dev server an agent started with bash has neither its parent process nor its process
 * group tied to ours, so our shutdown procedure cannot catch it (measured). So instead of
 * killing it, we **show it** and let the person choose — if the app silently killed something
 * the person started by hand in the same folder, cleaning up an orphan would mean cutting off
 * someone else's work.
 */
export interface ProcessPort {
  strays(): Promise<{ pid: number; command: string; cwd: string }[]>
  stop(pids: number[]): Promise<{ stopped: number }>
}

/**
 * Background mode (#280): whether quitting the app leaves the agent host and its running sessions
 * going. Off by default; with it off, quitting stops them as it always did.
 *
 * Only a desktop app whose host is held by the keeper can offer this — the keeper is what
 * outlives the window. A platform that cannot leaves `Platform.background` undefined, and the
 * setting is not shown, rather than shown as a switch that does nothing.
 */
export interface BackgroundPort {
  get(): Promise<boolean>
  /** @returns the mode now in force */
  set(on: boolean): Promise<boolean>
}

/** Whether relaunching starts the update just installed (#352), and why not when it does not */
export type RelaunchCheck = {
  ready: boolean
  /** Why not, for the update line's tooltip */
  reason?: string
  /** The version a relaunch would start, when the bundle says */
  version?: string
}

/**
 * "Apply now" (#352): relaunching the window into the version the host just installed.
 *
 * Only a desktop app whose host is held by the keeper can offer this: the keeper is told first and
 * holds the host and every agent through the relaunch, whatever background mode says, and the new
 * window then switches the keeper and host to its build. A platform that cannot leaves
 * `Platform.relaunch` undefined, and the update line keeps saying "restart to finish".
 */
export interface RelaunchPort {
  /** Whether a relaunch now would start a different build than this window (the bundle on disk was replaced) */
  check(): Promise<RelaunchCheck>
  /** Announces the relaunch to the keeper, then relaunches. Rejects, saying why, when the agents could not be held */
  relaunch(): Promise<void>
  /**
   * Whether the host is running anything a person would lose (the keeper's activity report: a
   * session working or waiting, a terminal, a command), null while unknown. Called now and on every
   * change. What "Apply updates automatically when idle" waits for.
   * @returns unsubscribes
   */
  watchBusy(cb: (busy: boolean | null) => void): Unsubscribe
}

export interface Platform {
  agents: AgentPort
  apps: AppsPort
  projects: ProjectPort
  system: SystemPort
  git: GitPort
  fs: FsPort
  search: SearchPort
  rules: ApprovalRulesPort
  consents: ProjectConsentsPort
  trash: TrashPort
  workspace: WorkspacePort
  prefs: PreferencesPort
  themes: ThemesPort
  updates: UpdatePort
  terminal: TerminalPort
  commands: CommandRunPort
  processes: ProcessPort
  /** Present only where the host outlives the window (desktop, through the keeper — #280) */
  background?: BackgroundPort
  /** Present only in the desktop app with the keeper: relaunching into an installed update (#352) */
  relaunch?: RelaunchPort
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}
