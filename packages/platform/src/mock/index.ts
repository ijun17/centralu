import type {
  AppPermission,
  AppUsage,
  AppQuestion,
  AppReview,
  AppVersions,
  AdapterCapabilities,
  AppErrorBundle,
  AppRun,
  Attachment,
  BuilderRequestFacts,
  PermissionPreset,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalScope,
  CreateSessionParams,
  ExternalAppInfo,
  ExternalSession,
  NormalizedEvent,
  ProjectInfo,
  SavedCommand,
  SessionInfo,
  StoredMessage,
  UsageSnapshot,
  ToolName,
  ToolStatus,
  QuestionAnswer,
  UiPreferences,
  UiPreferencesPatch,
  UpdateStatus,
} from '@cc/protocol'
import {
  APP_VERSION,
  builderErrorFrame,
  builderRequestFrame,
  newAppIdProblem,
  isNewerVersion,
  parseUiPreferences,
  osPathBaseName,
  sessionLiveDefaults,
  wireBaseName,
  wireJoin,
  wireSegments,
} from '@cc/protocol'
import type {
  AgentPort,
  AlertKind,
  AppCallOrigin,
  AppCreated,
  BuilderAsk,
  AppHomeView,
  AppResourceResult,
  AppToolResult,
  AppViewFrame,
  ConnectionState,
  FsEntry,
  FsFile,
  InlineViewKept,
  InlineViewReopened,
  NewAppSpec,
  Platform,
  PreferencesPort,
  ProjectPort,
  SystemPort,
  TerminalPort,
  Unsubscribe,
  UpdatePort,
  WorkspaceSnapshot,
} from '../ports/index.js'

/**
 * The in-memory implementation (docs/platform-abstraction.md §6).
 * Tests and Playwright use this — the ports are not mocked ad hoc with a mocking library
 * (that would split the contract apart).
 */

/**
 * The ids of built-in apps — the same list as the host's `reservedIds` (HOST_APPS). An
 * external app cannot take one of these names (`apps.invoke` uses it to decide which side to
 * call). The mock cannot import the host's registry, so it is written out here as one line.
 */
const MOCK_BUILTIN_APPS: readonly string[] = ['control']

export type MockOptions = {
  /** A deterministic clock — for testing elapsed waiting time */
  now?: () => number
}

export class MockPlatform implements Platform {
  private projectsList: ProjectInfo[] = []
  sessions = new Map<string, SessionInfo>()
  private gridPanels: string[] = []
  /** Messages saved per session — left open so a test can build a "session with an already-long history" */
  messages = new Map<string, StoredMessage[]>()
  /** The row of text currently streaming, per session — the very row inside `messages` (growing it also grows the record) */
  private streams = new Map<string, StoredMessage>()
  private handlers = new Set<(e: NormalizedEvent) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private idc = 0
  private now: () => number

  /** For tests: the value the directory picker will return */
  nextPickedDirectory: string | null = '/tmp/picked'
  /** The value the file picker will return (M4 E-3 — the .zip to import). Null means the person cancelled */
  nextPickedFile: string | null = '/tmp/picked.zip'
  /** What the file picker was asked to filter by */
  readonly pickedFileAsks: { title: string; extensions: string[] }[] = []
  /** The side that listens for app links (M4 E-4) — `openAppLink` hands one over like the OS would */
  private readonly appLinkListeners = new Set<(link: string) => void>()
  /** As if the OS handed this app a link (M4 E-4, called by e2e) — passes it through raw, unfiltered by the shell */
  openAppLink(link: string): void {
    for (const l of this.appLinkListeners) l(link)
  }
  /** The orchestrator tool chosen on the intro screen (#63) — the real thing writes it to app_settings */
  orchestratorTool: ToolName = 'claude'
  /** For tests: sessions to make unresumable */
  readonly unresumable = new Set<string>()
  /** Session ids deleted via deleteExternal — the observation point for whether "really delete" was actually delivered */
  readonly externallyDeleted: string[] = []
  /** Proposed MCP servers waiting for approval (filled in by tests) */
  readonly mcpProposalList: { name: string; command: string; args: string[]; why?: string }[] = []
  /** Approved proposal names — the observation point for whether an approval click was actually delivered */
  readonly mcpApproved: string[] = []
  /** Proposed skills waiting for approval (#71 — filled in by tests) */
  readonly skillProposalList: { name: string; content: string; why?: string }[] = []
  /** Approved skills — the observation point for whether approving/deleting was actually delivered */
  readonly skillList: { name: string; content: string }[] = []
  readonly notifications: { title: string; body: string }[] = []
  readonly opened: { path: string; line?: number }[] = []
  /** Addresses opened in the outside browser (#159) — tests check that terminal and app-screen links pass through this door */
  readonly openedUrls: string[] = []
  badge = 0
  /** For tests: how many times projects.gitStatus was asked — an eye on whether debouncing is working (issue #41) */
  gitStatusCalls = 0
  /** For tests: which project a file was read from and shown for — an eye on whether the grid's neighboring-panel link goes to its own project (#182) */
  readonly fileOps: { op: 'read' | 'reveal'; projectId: string; path: string }[] = []
  /** For tests: which diff was asked for — an eye on whether the group is right for a partially staged file (#160) */
  readonly gitDiffCalls: { path: string; staged: boolean }[] = []
  /** The record of trust turned on and off — tests check "it only asks, it does not send" (M4) */
  readonly trustCalls: { projectId: string; trusted: boolean }[] = []

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  readonly capabilities = {
    osNotifications: true,
    dockBadge: true,
    globalShortcuts: false,
    processSupervision: false,
    openInIde: true,
    // A browser has no window controls to leave room for, and E2E runs against this
    // mock — so the header it measures starts at the window edge.
    windowControlsInset: 0,
    // This mock has no OS to ask. Settles on the Mac notation as the answer — both development
    // and e2e run on a Mac, and guessing the keyboard here would make the result depend on
    // whatever machine the test happens to run on.
    shortcutKeys: { mod: '⌘', alt: '⌥', join: '' },
    // Same reason: settles on the Mac name as the answer — guessing the machine e2e runs on
    // would make what gets written on screen vary from test to test.
    fileManagerName: 'Finder',
  }

  /** The channel through which tests inject events */
  emit(event: NormalizedEvent): void {
    let out = event
    /*
     * An in-conversation screen (M4 B-1). Like the host: remembers the instance as belonging
     * to that conversation (apps.viewMessage), and holds onto the input and outcome to return
     * when reopened (apps.inlineReopen). If the outcome arrives as `kept: false`, the host
     * discarded it — the mock discards it too.
     */
    if (event.type === 'app_view') {
      const key = `${event.sessionId} ${event.callId}`
      const rec = this.inlineRecords.get(key)
      if (event.phase === 'open' && event.instanceId) {
        this.inlineInstances.set(event.instanceId, { sessionId: event.sessionId, appId: event.appId, projectId: event.projectId })
        this.inlineRecords.set(key, {
          appId: event.appId,
          projectId: event.projectId,
          tool: event.tool,
          toolInput: event.toolInput ?? {},
          instanceId: event.instanceId,
        })
      } else if (event.phase === 'closed' && rec) {
        rec.instanceId = null
      } else if (event.phase === 'result' && rec) {
        if (event.kept === false) this.inlineRecords.delete(key)
        else rec.toolResult = event.toolResult as AppToolResult
      } else if (event.phase === 'cancelled' && rec) {
        if (event.kept === false) this.inlineRecords.delete(key)
        else rec.cancelled = event.reason ?? ''
      } else if (event.phase === 'rejected') {
        this.inlineRecords.delete(key)
      }
    }
    if (event.sessionId) {
      const s = this.sessions.get(event.sessionId)
      if (s) {
        if (event.type === 'approval_request') {
          s.state = 'waiting_approval'
          s.waitingSince ??= this.now()
          s.pendingApproval = { requestId: event.requestId, detail: event.detail }
        } else if (event.type === 'approval_resolved') {
          if (s.pendingApproval?.requestId === event.requestId) s.pendingApproval = null
        } else if (event.type === 'question_request') {
          /*
           * The same rule as the real thing (manager.trackLiveFacts): a live question
           * **stays on the session**. Only emitting it as an event would make the card
           * disappear on every path that re-fetches the list (reconnect, refresh) — if it
           * stays in the real thing but disappears only in the mock, that difference shows up
           * on screen only.
           */
          s.state = 'waiting_input'
          s.waitingSince ??= this.now()
          s.pendingQuestions = [...s.pendingQuestions, { requestId: event.requestId, questions: event.questions }]
        } else if (event.type === 'question_resolved') {
          s.pendingQuestions = s.pendingQuestions.filter((q) => q.requestId !== event.requestId)
        } else if (event.type === 'turn_complete') {
          s.state = 'waiting_input'
          s.waitingSince ??= this.now()
        } else if (event.type === 'message_delta' || event.type === 'tool_call') {
          s.state = 'working'
          s.waitingSince = null
        } else if (event.type === 'worktree_merged') {
          // The same rule as the real thing (#69): must stay in the list after a reconnect too
          s.worktreeMerged = true
        } else if (event.type === 'worktree_pr') {
          // The same rule as the real thing (#76 stage 3): the PR state also stays in the list after a reconnect
          s.worktreePr = event.pr
        } else if (event.type === 'context_update') {
          /*
           * The same rule as the real thing (the host): context usage **stays on the session**
           * (issue #48).
           *
           * While the mock was only emitting this, the gauge reverted to `—` on every path
           * that re-fetches the list (app restart, reconnect) — the real thing holds onto the
           * value, so if this spot is left empty, e2e passes a state the real thing could
           * never produce as normal.
           */
          s.context = { used: event.used, window: event.window, exactness: event.exactness }
        }
        /*
         * The same rule as the real thing (the host): an event that stays in the record gets a
         * seq within the session and carries it in the broadcast. The UI's unread tracking
         * (lastSeq) trusts only this seq — if the mock does not carry it, a bug that the real
         * thing would catch slips by quietly in tests only.
         */
        const kind =
          event.type === 'tool_call'
            ? ('tool_call' as const)
            : event.type === 'tool_result'
              ? ('tool_result' as const)
              : event.type === 'approval_request' || event.type === 'approval_resolved'
                ? ('approval' as const)
                : event.type === 'message_delta'
                  ? ('text' as const)
                  : // A reasoning summary (#58) — the same rule as the real thing: recorded only when text is carried
                    event.type === 'reasoning_delta' && event.text
                    ? ('reasoning' as const)
                    : // A message that came in from outside (FR-11). The real payload is {text, from}, and the event
                      // holds both of them as-is, so restoring it (messagesToChat) brings back the same screen
                      event.type === 'user_message'
                      ? ('text' as const)
                      : event.type === 'compaction'
                        ? ('marker' as const)
                        : // Images persist too (#40, second pass). The real thing has a file plus a path, but the
                          // mock's disk is memory — leaving the bytes as-is in the payload lets loadMessages restore
                          // the same screen as the real thing
                          event.type === 'message_image'
                          ? ('image' as const)
                          : null
        /*
         * An in-conversation app screen (M4 B-1) — like the real thing, records only open and rejected, with no
         * body (manager.persistMessage). A reopened screen sets up its placeholder from this.
         */
        if (event.type === 'app_view' && (event.phase === 'open' || event.phase === 'rejected')) {
          const seq = (this.messages.get(s.id)?.length ?? 0) + 1
          const { type, sessionId, callId, appId, projectId, tool, phase, reason } = event
          this.pushMessage({
            sessionId: s.id,
            seq,
            role: 'system',
            kind: 'app_view',
            payload: { type, sessionId, callId, appId, projectId, tool, phase, ...(reason ? { reason } : {}) },
            ts: this.now(),
          })
          s.lastSeq = seq
          out = { ...event, seq } as NormalizedEvent
        }
        /*
         * A streaming message is gathered into one row — the same rule as the real thing (host
         * persistMessage, #66). A chunk of the same kind grows the open row and carries that
         * row's number. A different row (a tool, a human message — pushMessage) or the end of
         * a turn closes it. Making a new row per chunk would give each chunk a different
         * number, and a screen that splits messages by number (#77) would draw one message as
         * broken up chunk by chunk.
         */
        const streamKind =
          event.type === 'message_delta' ? 'text' : event.type === 'reasoning_delta' && event.text ? 'reasoning' : null
        const piece = streamKind ? ((event as { text?: string }).text ?? '') : ''
        const run = this.streams.get(s.id)
        if (streamKind && run?.kind === streamKind) {
          run.payload = { ...(run.payload as object), text: String((run.payload as { text?: string }).text ?? '') + piece }
          s.lastSeq = run.seq
          out = { ...event, seq: run.seq } as NormalizedEvent
        } else {
          const closes =
            streamKind !== null ||
            event.type === 'turn_complete' ||
            event.type === 'error' ||
            (event.type === 'state_change' && event.state !== 'working')
          if (closes) this.streams.delete(s.id)
          // Does not start a row with an empty chunk — like the real thing, does not carry a number either
          if (kind && !(streamKind && !piece)) {
            const row: StoredMessage = {
              sessionId: s.id,
              seq: (this.messages.get(s.id)?.length ?? 0) + 1,
              role:
                event.type === 'message_delta' || event.type === 'reasoning_delta'
                  ? 'assistant'
                  : event.type === 'user_message'
                    ? 'user'
                    : 'system',
              kind,
              payload: event,
              ts: this.now(),
            }
            this.pushMessage(row)
            if (streamKind) this.streams.set(s.id, row)
            s.lastSeq = row.seq
            out = { ...event, seq: row.seq } as NormalizedEvent
          }
        }
      }
    }
    for (const h of this.handlers) h(out)
  }

  private pushMessage(m: StoredMessage): void {
    this.streams.delete(m.sessionId) // A new row is the end of whatever was streaming — if it is the first row of a stream, emit reopens it
    const arr = this.messages.get(m.sessionId) ?? []
    arr.push(m)
    this.messages.set(m.sessionId, arr)
  }

  setConnectionState(s: ConnectionState): void {
    for (const h of this.connHandlers) h(s)
  }

  /** The fake git state tests manipulate */
  gitState: {
    files: GitFileStatus[]
    diffs: Record<string, string>
    commits: GitCommit[]
    branches: GitBranch[]
    dirty: string[]
    /**
     * The keys (path or sha) of the diffs to report as truncated.
     *
     * The real host gives only the first part and sets truncated once it crosses the cap
     * (400,000 characters). While the mock always returned false, a test for "the truncation
     * notice does not appear" **could not possibly fail** (#121). Taking a key rather than
     * faking it by length: a test should be able to draw that state without having to build a
     * 400KB string.
     */
    truncated: string[]
    /** Things git ignores (#76) — the list the setup window offers as copy candidates */
    ignored: { path: string; bytes: number | null }[]
    lastCommitMessage?: string
    pushed: boolean
  } = { files: [], diffs: {}, commits: [], branches: [], dirty: [], truncated: [], ignored: [], pushed: false }

  readonly savedAttachments: Attachment[] = []
  readonly sentAttachments: Attachment[] = []
  /** The mock's disk is memory — this is where the bytes the real thing re-reads from an attachments/ file are recovered from */
  readonly attachmentData = new Map<string, string>()

  /** The fake file tree tests manipulate */
  fsState: { entries: Record<string, FsEntry[]>; files: Record<string, string> } = { entries: {}, files: {} }
  /** The set of watched paths registered via fs.watch (#34) — tests check what the screen asked to watch */
  watchedDirs = new Map<string, string[]>()

  /** For tests: search and rule state */
  searchResults: { sessionId: string; seq: number; snippet: string }[] = []
  rulesList: {
    id: number
    scope: string
    matcher: string
    decision: string
    createdAt: number
    projectId?: string | null
    sessionId?: string | null
  }[] = []

  readonly search = {
    messages: async (query: string) => this.searchResults.filter((r) => r.snippet.includes(query)),
  }

  readonly rules = {
    list: async () => [...this.rulesList],
    remove: async (id: number) => {
      this.rulesList = this.rulesList.filter((r) => r.id !== id)
    },
  }

  /**
   * The trash (#204), with the host's rules: deleting moves a session here with its messages, and nothing chosen in
   * the dialog happens until it is deleted for good — only then does `externallyDeleted` record the tool's file.
   */
  readonly trashBin = new Map<
    string,
    {
      session: SessionInfo
      messages: StoredMessage[]
      deletedAt: number
      project: { id: string; name: string; path: string } | null
      removeExternal: boolean
      removeWorktree: boolean
    }
  >()

  private moveToTrash(sessionId: string, removeWorktree: boolean, removeExternal: boolean): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const p = session.projectId ? this.projectsList.find((x) => x.id === session.projectId) : undefined
    this.trashBin.set(sessionId, {
      session: { ...session, live: false },
      messages: this.messages.get(sessionId) ?? [],
      deletedAt: this.now(),
      project: p ? { id: p.id, name: p.name, path: p.path } : null,
      removeExternal: removeExternal && !!(session.externalId ?? session.importedFrom),
      removeWorktree: removeWorktree && !!session.worktree,
    })
    this.sessions.delete(sessionId)
    this.messages.delete(sessionId)
    this.gridPanels = this.gridPanels.filter((id) => id !== sessionId)
    this.emit({ type: 'session_deleted', sessionId })
  }

  readonly trash = {
    list: async () => {
      const sessions = [...this.trashBin.values()]
        .sort((a, b) => b.deletedAt - a.deletedAt)
        .map(({ session: s, messages, deletedAt, project, removeExternal, removeWorktree }) => {
          const live = project ? this.projectsList.find((x) => x.id === project.id) : undefined
          const hasFile = !!(s.externalId ?? s.importedFrom)
          return {
            id: s.id,
            name: s.name,
            tool: s.tool,
            project: project ? { id: project.id, name: live?.name ?? project.name, path: live?.path ?? project.path, exists: !!live } : null,
            deletedAt,
            messages: messages.length,
            bytes: messages.reduce((n, m) => n + JSON.stringify(m.payload).length, 0),
            conversationFile: (!hasFile ? 'none' : removeExternal ? 'remove' : 'keep') as 'none' | 'remove' | 'keep',
            worktree: s.worktree ? { path: s.worktree.path, branch: s.worktree.branch, remove: removeWorktree } : null,
          }
        })
      return { sessions, bytes: sessions.reduce((n, s) => n + s.bytes, 0) }
    },
    read: async (sessionId: string, limit = 200, beforeSeq?: number) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw Object.assign(new Error(`Not in the trash: ${sessionId}`), { code: 'session_not_found' })
      const filtered = beforeSeq ? t.messages.filter((m) => m.seq < beforeSeq) : t.messages
      return filtered.slice(-limit)
    },
    restore: async (sessionId: string) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw Object.assign(new Error(`Not in the trash: ${sessionId}`), { code: 'session_not_found' })
      let registered: ProjectInfo | null = null
      let projectId: string | null = null
      if (t.project) {
        const home =
          this.projectsList.find((x) => x.id === t.project!.id) ?? this.projectsList.find((x) => x.path === t.project!.path)
        if (home) projectId = home.id
        else {
          // The mock has no disk: the folder is always there, so the project is registered again under its id
          const p: ProjectInfo = {
            id: t.project.id, path: t.project.path, name: t.project.name, defaultTool: 'claude', defaultModels: {},
            commands: [], worktreeSetup: null, worktreeManager: null, trusted: false,
            git: { branch: 'main', changedFiles: 0, isRepo: true },
          }
          this.projectsList.push(p)
          projectId = p.id
          registered = this.withGit(p)
        }
      }
      const live = ['working', 'waiting_approval'].includes(t.session.state)
      const session: SessionInfo = { ...t.session, projectId, ...(live ? { state: 'idle' as const, waitingSince: null } : {}) }
      this.trashBin.delete(sessionId)
      this.sessions.set(sessionId, session)
      this.messages.set(sessionId, t.messages)
      this.emit({ type: 'session_created', sessionId, session: { ...session } })
      return { session: { ...session }, project: registered }
    },
    purge: async (sessionId: string) => {
      const t = this.trashBin.get(sessionId)
      if (!t) throw Object.assign(new Error(`Not in the trash: ${sessionId}`), { code: 'session_not_found' })
      // The same rule as the host: if removing the original was specified, that fact stays on the record (a point tests verify)
      if (t.removeExternal) this.externallyDeleted.push(sessionId)
      this.trashBin.delete(sessionId)
    },
    empty: async () => {
      const ids = [...this.trashBin.keys()]
      for (const id of ids) await this.trash.purge(id)
      return { purged: ids.length, failed: [] }
    },
  }

  /** For tests: what was sent to the trash and what was opened in the file manager (#18/#19) */
  readonly trashed: string[] = []
  readonly revealed: string[] = []

  /**
   * A path that goes outside the root gets rejected **in the mock too**.
   *
   * This is a spot it would have been tempting to skip, on the theory that a mock with no real
   * filesystem needs no check either. Then "cannot touch outside the project" would become a
   * rule that exists only in the real thing, and the difference would be invisible to e2e (the
   * browser's mock) forever — the contract test actually caught this having split here.
   * Decidable from the string alone: count segments, and going outside is whatever makes the
   * depth negative after stepping down through a `..`.
   *
   * The segments come from `wireSegments` rather than from a `/` written here (#47). Reading the
   * separator out of the protocol instead of assuming it is what makes this check the *same*
   * check the host runs: both sides now name one encoding, so a path that means two things on
   * two machines cannot mean the right thing here and the wrong thing there.
   */
  private requireInside(rel: string): void {
    const fail = () => {
      throw Object.assign(new Error('Path is outside the project'), { code: 'internal' })
    }
    if (rel.startsWith('/')) fail()
    let depth = 0
    for (const seg of wireSegments(rel)) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') depth -= 1
      else depth += 1
      if (depth < 0) fail()
    }
  }

  /** `a/b/c.ts` → `a/b` (the root is `''`) — since the mock's entries are grouped by parent path */
  private parentOf(path: string): string {
    const cut = path.lastIndexOf('/')
    return cut < 0 ? '' : path.slice(0, cut)
  }

  /**
   * Detaches one entry from the mock. If it is a folder, everything under it — the listing and
   * the files — comes along. In the real thing, moving a folder takes what is inside it along
   * too, so if the mock moved only the shell, "it moved, but the inside is empty" would become
   * a kind of difference that happens **only in the mock**.
   */
  private detach(path: string): FsEntry | null {
    const parent = this.parentOf(path)
    const siblings = this.fsState.entries[parent] ?? []
    const entry = siblings.find((e) => e.path === path)
    if (!entry) return null
    this.fsState.entries[parent] = siblings.filter((e) => e.path !== path)
    return entry
  }

  /** What comes along when moving or deleting — the sub-listing and file contents */
  private takeSubtree(path: string): { entries: Record<string, FsEntry[]>; files: Record<string, string> } {
    const under = (p: string) => p === path || p.startsWith(`${path}/`)
    const entries: Record<string, FsEntry[]> = {}
    const files: Record<string, string> = {}
    for (const [dir, list] of Object.entries(this.fsState.entries)) {
      if (!under(dir)) continue
      entries[dir] = list
      delete this.fsState.entries[dir]
    }
    for (const [file, text] of Object.entries(this.fsState.files)) {
      if (!under(file)) continue
      files[file] = text
      delete this.fsState.files[file]
    }
    return { entries, files }
  }

  /** The handoff note placed in the host's data folder (#142) — path → text. Not mixed with project files (fsState) */
  handoffNotes = new Map<string, string>()

  private placeHandoffNote(s: SessionInfo, text: string): string {
    const path = `/mock-data/handoff/${s.projectId}/${s.id}.md`
    this.handoffNotes.set(path, text)
    return path
  }

  /**
   * Lays one file down in the mock and builds **the whole path up to it** (#104).
   *
   * In the real thing, the host creates the parent folders before writing. If the mock only
   * planted the content, that file would be readable but `trash` would fail to find it in the
   * listing and reject it — a spot where the mock becomes stricter than the real thing, and
   * handoff cleanup would fail only in the mock. When a test needs to fake "the agent left a
   * note," it should also come in through this door, so nobody has to rediscover that trap on
   * their own.
   */
  placeFile(path: string, text: string): void {
    this.fsState.files[path] = text
    const segs = wireSegments(path).filter(Boolean)
    for (let i = 0; i < segs.length; i++) {
      const here = wireJoin(...segs.slice(0, i + 1))
      const parent = wireJoin(...segs.slice(0, i))
      const list = this.fsState.entries[parent] ?? []
      if (list.some((e) => e.path === here)) continue
      this.fsState.entries[parent] = [
        ...list,
        { name: segs[i]!, path: here, isDir: i < segs.length - 1, ignored: false },
      ]
    }
  }

  readonly fs = {
    search: async (_projectId: string, query: string, limit = 20) => {
      // The mock does not fake real fuzzy matching — what is being verified is the UI flow
      const all = Object.values(this.fsState.entries)
        .flat()
        .filter((e) => !e.isDir)
      const q = query.toLowerCase()
      return all
        .filter((e) => e.path.toLowerCase().includes(q))
        .slice(0, limit)
        .map((e) => ({ path: e.path, name: e.name }))
    },
    listDir: async (_projectId: string, path: string) => this.fsState.entries[path] ?? [],
    // Only records the watch set — tests check the screen's reaction by emitting fs_changed directly
    watch: async (projectId: string, paths: string[]) => {
      this.watchedDirs.set(projectId, [...paths])
      return { watched: paths.length }
    },
    readFile: async (projectId: string, path: string): Promise<FsFile> => {
      this.fileOps.push({ op: 'read', projectId, path })
      return {
        text: this.fsState.files[path] ?? '',
        truncated: false,
        binary: false,
        bytes: (this.fsState.files[path] ?? '').length,
      }
    },
    resolve: async (_projectId: string, path: string) => {
      this.requireInside(path)
      return { path: `/mock-project/${path}` }
    },
    /**
     * Follows **the same rejection rules** as the real thing (the host's `moveEntry`): if the
     * spot is taken, it does not move and names what it collided with; a folder cannot be put
     * inside itself; and dropping something back where it already was is `moved: false`, not a
     * failure. If the mock were more forgiving than the real thing, e2e would stay green while
     * the actual app behaved differently.
     */
    move: async (_projectId: string, from: string, toDir: string) => {
      this.requireInside(from)
      this.requireInside(toDir)
      const name = wireBaseName(from)
      const path = wireJoin(toDir, name)
      if (path === from) return { path, moved: false }
      if (path.startsWith(`${from}/`)) {
        throw Object.assign(new Error(`Cannot move ${name} into itself`), { code: 'internal' })
      }
      if ((this.fsState.entries[toDir] ?? []).some((e) => e.path === path)) {
        throw Object.assign(new Error(`${path} already exists — nothing was moved`), { code: 'internal' })
      }
      const entry = this.detach(from)
      if (!entry) throw Object.assign(new Error(`${from} is no longer there`), { code: 'internal' })
      const sub = this.takeSubtree(from)
      const rekey = (p: string) => path + p.slice(from.length)
      for (const [dir, list] of Object.entries(sub.entries)) {
        this.fsState.entries[rekey(dir)] = list.map((e) => ({ ...e, path: rekey(e.path) }))
      }
      for (const [file, text] of Object.entries(sub.files)) this.fsState.files[rekey(file)] = text
      this.fsState.entries[toDir] = [...(this.fsState.entries[toDir] ?? []), { ...entry, path }]
      return { path, moved: true }
    },
    importFile: async (_projectId: string, toDir: string, name: string, dataBase64: string) => {
      this.requireInside(toDir)
      // Uses only the last segment of the name — the same rule as the real thing, so even if a
      // path sneaks in mixed into the name, it cannot escape the destination
      const leaf = wireBaseName(name)
      const path = wireJoin(toDir, leaf)
      if ((this.fsState.entries[toDir] ?? []).some((e) => e.path === path)) {
        throw Object.assign(new Error(`${path} already exists — nothing was written`), { code: 'internal' })
      }
      this.fsState.entries[toDir] = [
        ...(this.fsState.entries[toDir] ?? []),
        { name: leaf, path, isDir: false, ignored: false },
      ]
      this.fsState.files[path] = atob(dataBase64)
      return { path }
    },
    trash: async (_projectId: string, path: string) => {
      this.requireInside(path)
      /*
       * The project root (`'.'`) is **not an entry** in the listing — entries are the things
       * inside the root. In the real thing, the host's resolveExisting stats the root and lets
       * it through (it is a real folder), so rejecting it here as "no such entry" would make
       * the mock **stricter** than the real thing — the path of deleting the whole project
       * folder would end up blocked in e2e only.
       */
      if (wireSegments(path).every((seg) => seg === '' || seg === '.')) {
        this.fsState.entries = {}
        this.fsState.files = {}
        this.trashed.push(path)
        return { supported: true }
      }
      if (!this.detach(path))
        throw Object.assign(new Error(`${path} is no longer there`), { code: 'internal' })
      this.takeSubtree(path)
      this.trashed.push(path)
      return { supported: true }
    },
    reveal: async (projectId: string, path: string) => {
      this.requireInside(path)
      this.revealed.push(path)
      this.fileOps.push({ op: 'reveal', projectId, path })
      return { supported: true }
    },
  }

  readonly git = {
    status: async (_projectId: string) => [...this.gitState.files],
    diff: async (_projectId: string, path: string, staged?: boolean): Promise<GitDiff> => {
      this.gitDiffCalls.push({ path, staged: staged ?? false })
      return {
        diff: this.gitState.diffs[path] ?? '',
        truncated: this.gitState.truncated.includes(path),
        binary: false,
      }
    },
    log: async (_projectId: string, limit = 50) => this.gitState.commits.slice(0, limit),
    commitDetail: async (_projectId: string, sha: string) => ({
      files: [`file-${sha}.ts`],
      diff: this.gitState.diffs[sha] ?? '',
      truncated: this.gitState.truncated.includes(sha),
    }),
    branches: async (_projectId: string) => [...this.gitState.branches],
    ignoredEntries: async (_projectId: string) => [...this.gitState.ignored],
    checkout: async (_projectId: string, branch: string, dryRun?: boolean) => {
      if (dryRun) return { ok: this.gitState.dirty.length === 0, conflicts: [...this.gitState.dirty] }
      this.gitState.branches = this.gitState.branches.map((b) => ({ ...b, current: b.name === branch }))
      return { ok: true, conflicts: [] }
    },
    stage: async (_projectId: string, paths: string[], unstage?: boolean) => {
      this.gitState.files = this.gitState.files.map((f) =>
        paths.includes(f.path) ? { ...f, staged: !unstage } : f,
      )
    },
    commit: async (_projectId: string, message: string) => {
      this.gitState.lastCommitMessage = message
      this.gitState.files = this.gitState.files.filter((f) => !f.staged)
      return { ok: true }
    },
    push: async (_projectId: string) => {
      this.gitState.pushed = true
      return { ok: true }
    },
  }

  /** For tests: usage (supported=false also reproduces "could not fetch it") */
  usageState: { supported: boolean; reason?: string; usage: UsageSnapshot | null } = {
    supported: true,
    usage: { plan: 'max', windows: [], daily: [] },
  }

  /** For tests: the slash command list (ready=false also reproduces "the tool is not ready yet") */
  commandState: { ready: boolean; commands: { name: string; description: string; argumentHint: string }[] } =
    {
      ready: true,
      commands: [],
    }

  /** For tests: sessions asked to restart */
  restarted: string[] = []

  /** For tests: the last createSession parameters (to check the chosen values were actually delivered) */
  lastCreateParams: CreateSessionParams | null = null
  /** For tests: every createSession parameter — if two are born at once, "the last one" cannot tell who got what */
  readonly createParamsLog: CreateSessionParams[] = []
  /** The handle that lets a test create "a worktree with uncommitted changes" */
  mockWorktreeDirty = false

  /** For tests: previous sessions the tool pretends to have. supported=false also reproduces an older tool version */
  externalSessions: { supported: boolean; reason?: string; sessions: ExternalSession[] } = {
    supported: true,
    sessions: [],
  }
  /** The previous conversation of a session chosen to be imported (externalId → list of lines) */
  externalHistory = new Map<string, { role: 'user' | 'assistant'; text: string }[]>()

  /** App state (#81) — the mock's disk is memory. The same rule as the real thing: broadcasts on write */
  appDocs = new Map<string, unknown>()
  appDisabled = new Set<string>()
  readonly apps = {
    state: async (appId: string) => ({
      doc: this.appDocs.get(appId) ?? null,
      enabled: !this.appDisabled.has(appId),
    }),
    setState: async (appId: string, doc: unknown) => {
      this.appDocs.set(appId, doc)
      this.emit({ type: 'app_state_changed', appId } as NormalizedEvent)
    },
    setEnabled: async (appId: string, enabled: boolean) => {
      if (enabled) this.appDisabled.delete(appId)
      else this.appDisabled.add(appId)
      this.emit({ type: 'app_state_changed', appId } as NormalizedEvent)
    },
    /**
     * The person calling an app tool directly (#81). The mock's disk is memory — the real
     * logic of the host's app is covered by the host's unit tests, and this is just the
     * minimal fake that e2e needs.
     */
    invoke: async (appId: string, name: string, args: Record<string, unknown>) => {
      this.lastInvoke = { appId, name, args }
      if (name === 'control_create_task') {
        const members = (args.memberSessionIds as string[]) ?? []
        const id = `coord-${++this.idc}`
        const title = String(args.title ?? 'Task')
        this.sessions.set(id, {
          id, projectId: null, kind: 'coordinator', tool: 'claude', externalId: null,
          name: title, autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0,
          createdAt: this.now(), waitingSince: null, live: true, model: null, effort: 'high',
          verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null,
          worktree: null, parentSessionId: null, scopeSessionIds: members, roleAppend: '(mock role)',
          // The same rule as the real thing (#81): the owning app is the registered id of the app that called the tool — an app cannot make one up
          appId,
          ...sessionLiveDefaults(),
        })
        this.emit({ type: 'session_created', sessionId: id, session: this.sessions.get(id) } as NormalizedEvent)
        const doc = (this.appDocs.get(appId) as { tasks?: unknown[] } | undefined) ?? {}
        const tasks = [
          ...((doc.tasks as unknown[]) ?? []),
          { id: `t-${this.idc}`, title, goal: String(args.goal ?? ''), members, coordinatorId: id, status: 'active', createdAt: this.now() },
        ]
        this.appDocs.set(appId, { ...doc, tasks })
        this.emit({ type: 'app_state_changed', appId } as NormalizedEvent)
        return { text: `Created the task "${title}"` }
      }
      return { text: `mock: ${name}` }
    },
    /**
     * The app screen (M4 B-3). There is no host in the mock, so no address can be constructed.
     * A test plugs in a function that starts the real host's proxy and supplies an address here
     * (e2e/app-frame.spec.ts). If nothing is plugged in, there is no screen.
     */
    viewFrame: async (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => {
      if (!this.viewFrameProvider) throw new Error('This app view is not open')
      return this.viewFrameProvider(appId, instanceId, opts)
    },
    /**
     * A tool call from a screen — recorded, and answered with whatever a test plugged in. The
     * default answer echoes back what was called. Keeps the same contract as web. projectId
     * always travels along (null if absent, and never leaks through a built-in app's door), and
     * the answer is exactly the shape of MCP result the app gave (`apps.invoke`'s `result`).
     */
    callTool: async (appId: string, tool: string, args: Record<string, unknown>, from?: AppCallOrigin) => {
      const origin: AppCallOrigin = { ...from, projectId: from?.projectId ?? null }
      this.appToolCalls.push({ appId, tool, args, from: origin })
      if (this.appToolHandler) return this.appToolHandler(appId, tool, args, origin)
      return { content: [{ type: 'text', text: `mock: ${tool}` }], structuredContent: { appId, tool, args } }
    },
    readResource: async (appId: string, uri: string, from?: AppCallOrigin) => {
      this.appResourceReads.push({ appId, uri, from: from ?? {} })
      const found = this.appResources.get(`${appId} ${uri}`)
      if (!found) throw new Error(`No resource ${uri} in app ${appId}`)
      return found
    },
    // Like the host, carries the time of the most recent error bundle (M4 C-6) — a test supplies the mock's bundles (appErrors)
    list: async (): Promise<ExternalAppInfo[]> =>
      structuredClone(this.externalAppList).map((a) => {
        const at = this.appErrors.get(`${a.projectId ?? '_user'}/${a.appId}`)?.[0]?.at
        return at === undefined ? a : { ...a, lastErrorAt: at }
      }),
    /**
     * A pinned screen (M4 B-2). The mock has neither an app process nor a ViewHost. A test
     * plugs in a function that opens an instance from the real ViewHost (e2e/apps.spec.ts). If
     * nothing is plugged in, this just records the call and fabricates an instance with an
     * empty result.
     */
    openView: async (appId: string, projectId: string | null): Promise<AppHomeView> => {
      this.openedViews.push({ appId, projectId })
      const v: AppHomeView = this.openViewProvider
        ? await this.openViewProvider(appId, projectId)
        : {
            instanceId: `mock-view-${++this.idc}`,
            tool: 'home',
            resourceUri: `ui://${appId}/home`,
            toolInput: {},
            toolResult: { content: [{ type: 'text', text: 'mock home' }] },
            runId: `mock-run-${this.idc}`,
          }
      // Like the host's ViewHost, holds which app and screen the instance belongs to — "this came from that screen" is checked against this
      this.pinnedInstances.set(v.instanceId, { appId, projectId, uri: v.resourceUri })
      return v
    },
    closeView: async (instanceId: string) => {
      this.closedViews.push(instanceId)
      // If it was an in-conversation screen, that record's instance also closes — like the host, the record (input, outcome) stays
      for (const rec of this.inlineRecords.values()) if (rec.instanceId === instanceId) rec.instanceId = null
    },
    /**
     * A message from an app screen (M4 B-1·B-4). Like the real thing: an in-conversation
     * screen only accepts one for the conversation it belongs to, a pinned screen accepts
     * whichever conversation the person chose, and it is recorded in the conversation as a
     * message the app sent (`fromApp`). Wrapping it in the shape the agent receives is the
     * host's job (manager's appMessageFrame), so here it just records what came in.
     */
    sendViewMessage: async (sessionId: string, instanceId: string, text: string) => {
      // Like the real thing: an in-conversation screen only to that conversation, a pinned screen to whichever the person chose (the app is decided by the instance)
      const inline = this.inlineInstances.get(instanceId)
      if (inline && inline.sessionId !== sessionId) throw new Error('This app view is not open in that conversation')
      const owner = inline ?? this.pinnedInstances.get(instanceId)
      if (!owner) throw new Error('This app view is not open')
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      const name = this.externalAppList.find((a) => a.appId === owner.appId && a.projectId === owner.projectId)?.name ?? owner.appId
      const fromApp = { appId: owner.appId, projectId: owner.projectId, name }
      this.viewMessages.push({ sessionId, instanceId, text })
      this.emit({ type: 'user_message', sessionId, seq: (this.messages.get(sessionId)?.length ?? 0) + 1, text, fromApp })
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    /**
     * Reopens a collapsed in-conversation screen (M4 B-1). Like the real thing: does not call
     * the tool again, and returns the held input and outcome with a new instance. The instance
     * is built by whatever a test plugged in (the real ViewHost). Rejects with the same wording
     * as the host if nothing is being held. The mock does not enforce the size cap — that is
     * the host's job, and its test lives in agent-host.
     */
    /** Like the real thing: the screens held for this conversation, without their bodies. The mock has already discarded an outcome that was too large (an outcome that arrived as `kept: false`) */
    inlineViews: async (sessionId: string): Promise<InlineViewKept[]> =>
      [...this.inlineRecords.entries()]
        .filter(([key]) => key.startsWith(`${sessionId} `))
        .map(([key, rec]) => ({
          callId: key.slice(sessionId.length + 1),
          appId: rec.appId,
          projectId: rec.projectId,
          tool: rec.tool,
          kept: true,
          instanceId: rec.instanceId,
        })),
    reopenInlineView: async (sessionId: string, callId: string): Promise<InlineViewReopened> => {
      this.reopenedViews.push({ sessionId, callId })
      const rec = this.inlineRecords.get(`${sessionId} ${callId}`)
      if (!rec) throw new Error("This view's result is no longer kept. Open the app instead")
      const instanceId = this.inlineInstanceProvider
        ? await this.inlineInstanceProvider(rec.appId, rec.projectId)
        : `mock-inline-${++this.idc}`
      this.inlineInstances.set(instanceId, { sessionId, appId: rec.appId, projectId: rec.projectId })
      rec.instanceId = instanceId
      return {
        instanceId,
        appId: rec.appId,
        projectId: rec.projectId,
        tool: rec.tool,
        toolInput: rec.toolInput,
        ...(rec.toolResult ? { toolResult: rec.toolResult } : {}),
        ...(rec.cancelled !== undefined ? { cancelled: rec.cancelled } : {}),
      }
    },
    /**
     * Like the real thing: clears the reason of an app that was stalled or dead, sets it up as
     * a resting app (`stopped`), then broadcasts the list. Does not start it — whichever screen
     * opens next does that.
     */
    /** Like the real thing: only deletes a user-folder app (rejects a project app), then broadcasts the list */
    remove: async (appId: string, projectId: string | null) => {
      if (projectId !== null) throw new Error("A project app is part of the project's repository — remove it there")
      const at = this.externalAppList.findIndex((a) => a.appId === appId && a.projectId === null)
      if (at === -1) throw new Error(`There is no such app: user/${appId}`)
      this.externalAppList.splice(at, 1)
      this.removedApps.push(appId)
      this.emit({ type: 'external_apps_changed' })
    },
    runs: async (appId: string, projectId: string | null, limit = 100): Promise<AppRun[]> => {
      this.appRunReads++
      if (this.appRunsProvider) return structuredClone(await this.appRunsProvider(appId, projectId, limit))
      return structuredClone((this.appRuns.get(`${projectId ?? '_user'}/${appId}`) ?? []).slice(0, limit))
    },
    restart: async (appId: string, projectId: string | null) => {
      this.restarts.push({ appId, projectId })
      const a = this.externalAppList.find((x) => x.appId === appId && x.projectId === projectId)
      if (!a) throw new Error(`There is no such app: ${projectId ?? 'user'}/${appId}`)
      if (a.status === 'failed' || a.status === 'crashed' || a.status === 'running') Object.assign(a, { status: 'stopped', error: null })
      this.emit({ type: 'external_apps_changed' })
    },
    /**
     * A new app (M4 C-1). Like the real thing (`ExternalApps.createApp` →
     * `SessionManager.createAppBuilder`): rejects using the same checks (protocol's
     * `newAppIdProblem`, built-in app ids, trust, an existing id) — the rejection wording is
     * exactly the host's, and a test checks that the window shows it as-is — then adds it to
     * the list, broadcasts, and creates the builder session. The app stays even if the session
     * fails to start.
     */
    create: async (spec: NewAppSpec): Promise<AppCreated> => {
      this.createdApps.push(structuredClone(spec))
      const idProblem = newAppIdProblem(spec.id)
      if (idProblem) throw new Error(`"${spec.id}" cannot be an app id — ${idProblem}`)
      if (MOCK_BUILTIN_APPS.includes(spec.id)) throw new Error(`"${spec.id}" cannot be an app id — that is the id of a built-in app — pick another`)
      const name = spec.name.replace(/\s+/g, ' ').trim()
      if (!name) throw new Error('The app needs a name')
      let dir = `/mock/data/apps/${spec.id}`
      if (spec.projectId !== null) {
        const project = this.projectsList.find((p) => p.id === spec.projectId)
        if (!project) throw new Error(`There is no such project: ${spec.projectId}`)
        if (!project.trusted) {
          throw new Error('Centralu does not make apps in a project it does not trust — an app is code that runs on this machine, so trust the project first')
        }
        dir = `${project.path}/.centralu/apps/${spec.id}`
      }
      if (this.externalAppList.some((a) => a.appId === spec.id && a.projectId === spec.projectId)) {
        throw new Error(`An app "${spec.id}" already exists (${dir}) — use another id`)
      }
      const app: ExternalAppInfo = {
        appId: spec.id,
        projectId: spec.projectId,
        dir,
        name,
        version: '0.1.0',
        description: spec.description?.replace(/\s+/g, ' ').trim() || `${name} (a Centralu app)`,
        // The template's home tool — the same name as the real template (app-template/centralu.app.json)
        home: 'show',
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
      }
      this.externalAppList.push(app)
      this.emit({ type: 'external_apps_changed' })
      try {
        return { app: structuredClone(app), builder: await this.apps.createBuilder(spec.id, spec.projectId, spec.tool) }
      } catch (e) {
        return { app: structuredClone(app), builder: null, builderError: (e as Error).message }
      }
    },
    builder: async (appId: string, projectId: string | null): Promise<SessionInfo | null> => {
      const id = this.appBuilders.get(`${projectId ?? '_user'}/${appId}`)
      const s = id ? this.sessions.get(id) : undefined
      return s ? structuredClone(s) : null
    },
    /**
     * The builder session (M4 C-2). Like the real thing: one per app (returns the existing one
     * if there is one), never created for an untrusted app, and if no tool is chosen, uses the
     * project's default tool (the orchestrator's tool for a user-folder app). The session fails
     * to start if that tool is absent or not logged in. The name is a human-chosen "<app> ·
     * builder", and the session's app slot is that app. Broadcasts `session_created` on
     * creation.
     */
    createBuilder: async (appId: string, projectId: string | null, tool?: ToolName): Promise<SessionInfo> => {
      const key = `${projectId ?? '_user'}/${appId}`
      const have = this.appBuilders.get(key)
      if (have && this.sessions.has(have)) return structuredClone(this.sessions.get(have)!)
      const app = this.externalAppList.find((a) => a.appId === appId && a.projectId === projectId)
      if (!app) throw new Error(`There is no such app: ${projectId ?? 'user'}/${appId}`)
      if (!app.trusted) {
        throw new Error('Centralu does not give a builder to an app in a project it does not trust — trust the project, and the app can start and be tested')
      }
      const project = projectId ? this.projectsList.find((p) => p.id === projectId) : undefined
      const chosen = tool ?? (project ? project.defaultTool : this.orchestratorTool) ?? 'claude'
      const detected = this.detected.find((t) => t.name === chosen)
      if (!detected?.installed || !detected.loggedIn) {
        throw new Error(`Could not start ${chosen} session: ${detected?.detail ?? `${chosen} is not installed`}`)
      }
      const id = `mock-session-${++this.idc}`
      const info: SessionInfo = {
        id,
        projectId,
        kind: 'worker',
        tool: chosen,
        externalId: `ext-${id}`,
        name: `${app.name ?? appId} · builder`,
        autoNamed: false,
        state: 'idle',
        lastReadSeq: 0,
        lastSeq: 0,
        createdAt: this.now(),
        waitingSince: null,
        live: true,
        model: null,
        effort: null,
        verbosity: null,
        serviceTier: null,
        permissionPreset: 'normal',
        importedFrom: null,
        worktree: null,
        parentSessionId: null,
        scopeSessionIds: null,
        roleAppend: `(mock builder role for ${appId})`,
        appId,
        ...sessionLiveDefaults(),
      }
      this.sessions.set(id, info)
      this.appBuilders.set(key, id)
      // The same rule as the real thing: creating a session sets that project's default tool (manager.createSession)
      if (project) project.defaultTool = chosen
      this.emit({ type: 'session_created', sessionId: id, session: structuredClone(info) })
      return structuredClone(info)
    },
    /**
     * "Fix this" (M4 C-5). Like the real thing (builder-requests.ts): rejects with the same
     * wording, and builds the header with **the same function** (protocol's
     * `builderRequestFrame`), from facts the mock knows — the app listing (name, stopped
     * state), the instance (screen), the run history (the front of `appRuns`, as filled in by
     * a test). The message built that way stands as a human message in the builder session's
     * conversation.
     */
    askBuilder: async (req: BuilderAsk): Promise<{ sessionId: string }> => {
      this.builderAsks.push(structuredClone(req))
      const text = req.text.trim()
      if (!text && !req.attachments?.length) throw new Error('Write what to change, or attach a screenshot')
      const info = this.externalAppList.find((a) => a.appId === req.appId && a.projectId === req.projectId)
      if (!info) throw new Error('This app no longer exists')
      const builderId = this.appBuilders.get(`${req.projectId ?? '_user'}/${req.appId}`)
      if (!builderId || !this.sessions.has(builderId)) throw new Error('This app has no builder session yet. Start one, then ask again')
      const facts: BuilderRequestFacts = {
        app: { appId: info.appId, name: info.name ?? info.appId },
        screen: null,
        stopped: info.status === 'crashed' || info.status === 'failed' ? { status: info.status, reason: info.error } : null,
        latestRun: null,
      }
      if (req.instanceId) {
        const inst = this.pinnedInstances.get(req.instanceId)
        if (!inst || inst.appId !== req.appId || inst.projectId !== req.projectId) {
          throw new Error("That view is not open for this app. Reopen the app's view and ask again")
        }
        facts.screen = { tool: info.home ?? '(no home tool)', resourceUri: inst.uri }
      }
      const last = this.appRuns.get(`${req.projectId ?? '_user'}/${req.appId}`)?.[0]
      if (last && last.status !== 'ok') facts.latestRun = { tool: last.tool, callerKind: last.callerKind, status: last.status, error: last.error }
      this.deliverToBuilder(builderId, builderRequestFrame(facts, text), req.attachments)
      return { sessionId: builderId }
    },
    /** Error bundles (M4 C-6) — a test fills `appErrors` (most recent first). A sent bundle carries `sentAt`, like the host */
    errors: async (appId: string, projectId: string | null): Promise<{ latest: AppErrorBundle | null; recent: AppErrorBundle[] }> => {
      this.errorReads++
      const key = `${projectId ?? '_user'}/${appId}`
      const recent = (this.appErrors.get(key) ?? []).map((b) => ({ ...structuredClone(b), sentAt: this.errorsSent.get(`${key}\n${b.kind}\n${b.at}`) ?? null }))
      return { latest: recent[0] ?? null, recent }
    },
    /**
     * Sends an error bundle to the builder session (M4 C-6). Like the real thing
     * (builder-requests.ts): rejects with the same wording, sends each bundle only once
     * (recording comes first), and builds the shape sent to the agent with **the same
     * function** (`builderErrorFrame`).
     */
    sendError: async (appId: string, projectId: string | null, at: number): Promise<{ sessionId: string }> => {
      this.errorSends.push({ appId, projectId, at })
      // So a test can hold "sending" open — checking meanwhile whether the screen accepts a second click
      if (this.sendErrorGate) await this.sendErrorGate
      const key = `${projectId ?? '_user'}/${appId}`
      const info = this.externalAppList.find((a) => a.appId === appId && a.projectId === projectId)
      if (!info) throw new Error('This app no longer exists')
      const builderId = this.appBuilders.get(key)
      if (!builderId || !this.sessions.has(builderId)) throw new Error('This app has no builder session yet. Start one, then send the error')
      const bundle = (this.appErrors.get(key) ?? []).find((b) => b.at === at)
      if (!bundle) throw new Error('This error is no longer kept. If it happens again, send the new one')
      const sentKey = `${key}\n${bundle.kind}\n${bundle.at}`
      if (this.errorsSent.has(sentKey)) throw new Error('This error was already sent to the builder')
      this.errorsSent.set(sentKey, this.now())
      this.deliverToBuilder(builderId, builderErrorFrame({ appId, name: info.name ?? appId }, bundle.text))
      return { sessionId: builderId }
    },
    // A capability question (M4 D-4) — like the real thing: reads the list, and on an answer removes it from the list and broadcasts. Rejects a closed question
    questions: async (): Promise<AppQuestion[]> => structuredClone(this.appQuestionList),
    answerQuestion: async (questionId: string, decision: 'allow' | 'deny') => {
      const at = this.appQuestionList.findIndex((q) => q.id === questionId)
      if (at === -1) throw new Error('That question is no longer open — it timed out, or the app stopped waiting')
      this.appQuestionList.splice(at, 1)
      this.answeredQuestions.push({ questionId, decision })
      this.emit({ type: 'external_app_questions_changed' })
      this.questionWaiters.get(questionId)?.(decision)
      this.questionWaiters.delete(questionId)
    },
    permissions: async (appId: string, projectId: string | null): Promise<AppPermission[]> =>
      structuredClone(this.appPermissions.get(`${projectId ?? '_user'}/${appId}`) ?? []),
    forgetPermission: async (appId: string, projectId: string | null, capability: string) => {
      const key = `${projectId ?? '_user'}/${appId}`
      this.appPermissions.set(key, (this.appPermissions.get(key) ?? []).filter((p) => p.capability !== capability))
      this.forgottenPermissions.push({ appId, projectId, capability })
    },
    // Agent usage (M4 D-5) — a test fills this in. If absent, 0, like the host
    usage: async (appId: string, projectId: string | null): Promise<AppUsage> =>
      structuredClone(
        this.appUsage.get(`${projectId ?? '_user'}/${appId}`) ?? {
          day: { runs: 0, durationMs: 0, tokens: null },
          month: { runs: 0, durationMs: 0, tokens: null },
        },
      ),
    /**
     * A secret (M4 E). Like the real thing (`ExternalApps.updateSecret`): only lets in a
     * declared name (the list's `secrets`), rejects an empty value with the same wording, and
     * carries only present/absent in the listing before broadcasting. Deleting does not need
     * to mask the name. What was received is recorded to `secretWrites` so a test can see it —
     * whether the value stays out of the screen (the DOM) is checked separately by a test.
     */
    setSecret: async (appId: string, projectId: string | null, name: string, value: string | null): Promise<void> => {
      const a = this.externalAppList.find((x) => x.appId === appId && x.projectId === projectId)
      if (!a) throw new Error(`There is no such app: ${projectId ?? 'user'}/${appId}`)
      const slot = a.secrets?.find((s) => s.name === name)
      if (value !== null) {
        if (!slot) throw new Error(`This app does not declare a secret named ${name}`)
        if (value.length === 0) throw new Error('Enter a value, or clear the secret instead')
      }
      this.secretWrites.push({ appId, projectId, name, value })
      if (slot) slot.set = value !== null
      this.emit({ type: 'external_apps_changed' })
    },
    /**
     * Import (M4 E-3). The mock has no filesystem — for each source, a test plugs in the
     * review window the host would return (`importSources`) or a rejection wording
     * (`importRefusals`). Like the real thing (`AppHandover`): preparing does not admit it (it
     * is not in the list yet); admitting it stands it up disabled (`unconfirmed`); and
     * "admit and enable" or enabling only accepts the key from the window the person reviewed.
     * The rejection wording is exactly the host's.
     */
    importPrepare: async (source: string): Promise<{ token: string; review: AppReview }> => {
      this.importPrepares.push(source)
      const refusal = this.importRefusals.get(source)
      if (refusal) throw new Error(refusal)
      const review = this.importSources.get(source)
      if (!review) throw new Error(`Nothing to import at ${source}`)
      if (this.externalAppList.some((a) => a.appId === review.appId && a.projectId === null)) {
        throw new Error(`An app with the id "${review.appId}" is already in your apps. Remove it first, or change the id in its manifest`)
      }
      const token = `mock-import-${++this.idc}`
      this.stagedImports.set(token, structuredClone(review))
      return { token, review: structuredClone(review) }
    },
    importCommit: async (token: string, opts: { enable: boolean; reviewKey?: string }): Promise<ExternalAppInfo> => {
      const review = this.stagedImports.get(token)
      if (!review) throw new Error('This import is no longer waiting (it was cancelled, or 30 minutes passed). Review it again')
      if (opts.enable && opts.reviewKey !== review.reviewKey) throw new Error('What would be enabled is not what you reviewed. Review it again')
      this.stagedImports.delete(token)
      const at = this.now()
      const app: ExternalAppInfo = {
        appId: review.appId,
        projectId: null,
        dir: `/mock/data/apps/${review.appId}`,
        name: review.name,
        version: review.version,
        description: review.description,
        home: review.home,
        trusted: true,
        status: opts.enable ? 'stopped' : 'unconfirmed',
        error: opts.enable ? null : 'This app was imported and is not enabled yet. Review what it runs, then enable it',
        warnings: [],
        imported: { source: review.source, at, confirmedAt: opts.enable ? at : null },
        ...(review.secrets.length ? { secrets: review.secrets.map((name) => ({ name, set: false })) } : {}),
      }
      this.externalAppList.push(app)
      this.appReviews.set(`_user/${review.appId}`, review)
      this.importCommits.push({ token, enable: opts.enable, appId: review.appId })
      this.emit({ type: 'external_apps_changed' })
      return structuredClone(app)
    },
    importCancel: async (token: string): Promise<void> => {
      this.stagedImports.delete(token)
      this.importCancels.push(token)
    },
    review: async (appId: string, projectId: string | null): Promise<AppReview> => {
      const r = this.appReviews.get(`${projectId ?? '_user'}/${appId}`)
      if (!r) throw new Error(`No app named "${appId}" in your apps`)
      return structuredClone(r)
    },
    enable: async (appId: string, projectId: string | null, reviewKey: string): Promise<ExternalAppInfo> => {
      const a = this.externalAppList.find((x) => x.appId === appId && x.projectId === projectId)
      const r = this.appReviews.get(`${projectId ?? '_user'}/${appId}`)
      if (!a) throw new Error(`No app named "${appId}" in your apps`)
      if (!a.imported || !r) throw new Error('This app was not imported, so it needs no enabling')
      if (r.reviewKey !== reviewKey) throw new Error('This app changed since you reviewed it. Review it again')
      Object.assign(a, { status: 'stopped', error: null, imported: { ...a.imported, confirmedAt: this.now() } })
      this.enabledApps.push(appId)
      this.emit({ type: 'external_apps_changed' })
      return structuredClone(a)
    },
    /**
     * An app's versions (M4 E-1) — a test fills `appVersions`. If not filled, like the host: an
     * empty snapshot list for a user-folder app, an empty commit list for a project app.
     * Restoring rejects a project app like the real thing, and makes the chosen version the
     * current one, then broadcasts the list.
     */
    versions: async (appId: string, projectId: string | null): Promise<AppVersions> => {
      const v = this.appVersions.get(`${projectId ?? '_user'}/${appId}`)
      if (v) return structuredClone(v)
      return projectId === null ? { kind: 'snapshots', snapshots: [] } : { kind: 'git', repo: true, commits: [] }
    },
    restoreVersion: async (appId: string, projectId: string | null, id: string): Promise<ExternalAppInfo> => {
      if (projectId !== null) throw new Error("A project app's versions are its git history; restore it with git")
      const key = `_user/${appId}`
      const v = this.appVersions.get(key)
      const a = this.externalAppList.find((x) => x.appId === appId && x.projectId === null)
      if (!a || !v || v.kind !== 'snapshots' || !v.snapshots.some((s) => s.id === id)) throw new Error('That version is no longer kept')
      for (const s of v.snapshots) s.current = s.id === id
      this.restoredVersions.push({ appId, id })
      this.emit({ type: 'external_apps_changed' })
      return structuredClone(a)
    },
  }
  /** Setting or clearing a secret that reached the host (M4 E) — tests check what went to which app under which name */
  readonly secretWrites: { appId: string; projectId: string | null; name: string; value: string | null }[] = []
  /** Import source → the review window the host would return (M4 E-3). A test plugs this in — the mock does not read folders or zips */
  readonly importSources = new Map<string, AppReview>()
  /** Source → the host's rejection wording (M4 E-3) — tests check whether the window shows that wording as-is */
  readonly importRefusals = new Map<string, string>()
  /** A prepared import (token → review window), and an admitted app's review window (`(project ?? _user)/app`) */
  private readonly stagedImports = new Map<string, AppReview>()
  readonly appReviews = new Map<string, AppReview>()
  /** What reached the host — sources prepared, admissions (whether enabled), cancellations, apps enabled */
  readonly importPrepares: string[] = []
  readonly importCommits: { token: string; enable: boolean; appId: string }[] = []
  readonly importCancels: string[] = []
  readonly enabledApps: string[] = []
  /** An app's versions (M4 E-1) — the key is `(project ?? _user)/app`. A test fills this in: keeping a version is the runtime's job */
  readonly appVersions = new Map<string, AppVersions>()
  /** Restores that reached the host — tests check they only arrive after confirmation */
  readonly restoredVersions: { appId: string; id: string }[] = []
  /** An app's error bundles (M4 C-6) — the key is `(project ?? _user)/app`, most recent first. A test fills this in: making a bundle is the runtime's job */
  readonly appErrors = new Map<string, Omit<AppErrorBundle, 'sentAt'>[]>()
  /**
   * As if the host just picked up a new error bundle — puts it in front and broadcasts the
   * list (the list's `lastErrorAt` changes). The same thing the real runtime does when it
   * records a bundle: a read-only tool's failure does not emit "changed," so this is the
   * screen's only signal.
   */
  recordAppError(appId: string, projectId: string | null, bundle: Omit<AppErrorBundle, 'sentAt'>): void {
    const key = `${projectId ?? '_user'}/${appId}`
    this.appErrors.set(key, [bundle, ...(this.appErrors.get(key) ?? [])])
    this.emit({ type: 'external_apps_changed' })
  }
  /** Sent bundle → time sent — only once, like the host */
  private readonly errorsSent = new Map<string, number>()
  /** "Send to builder" calls that reached the host — empty before a click, one after */
  readonly errorSends: { appId: string; projectId: string | null; at: number }[] = []
  /** How many times a bundle has been read — tests check it is re-read when "changed" arrives */
  errorReads = 0
  /** If set, sendError waits on this — lets a test check the screen while a send is in progress */
  sendErrorGate: Promise<void> | null = null
  /** What the "New app" window sent to the host — tests check what the window chose (id, name, tool) */
  readonly createdApps: NewAppSpec[] = []
  /** A pinned screen's instance → its app and screen (recorded by `openView`). Same as what the host's ViewHost knows as an instance */
  readonly pinnedInstances = new Map<string, { appId: string; projectId: string | null; uri: string }>()
  /** What the input line below an app screen sent to the host (M4 C-5) — tests check what was sent, from which screen, with what attached */
  readonly builderAsks: BuilderAsk[] = []
  /**
   * Puts a message into the builder session — like the host's `deliver`: records it, carries
   * attachments by path, and notifies the screen with `user_message` (a message the host
   * injected was not already drawn by the UI). The receiving session starts working.
   */
  private deliverToBuilder(sessionId: string, text: string, attachments?: Attachment[]): void {
    const s = this.sessions.get(sessionId)
    if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
    s.live = true
    // emit records it and assigns a seq, like the host (the same path as sendViewMessage)
    this.emit({ type: 'user_message', sessionId, seq: (this.messages.get(sessionId)?.length ?? 0) + 1, text, ...(attachments?.length ? { attachments } : {}) })
    this.emit({ type: 'state_change', sessionId, state: 'working' })
  }
  /** App → builder session (M4 C-2). The key is `(project ?? _user)/app` — the same shape as the real registry (APP_BUILDERS_KEY) */
  readonly appBuilders = new Map<string, string>()
  /**
   * A capability question from a chain that started at a screen (M4 D-4) — a test sets one up
   * with `askAppQuestion`. Broadcasts like the host, and when an answer comes in, resolves
   * whichever side was waiting on that question (a test-supplied `appToolHandler`). This is how
   * "answering resumes the stalled screen's call" is checked over a real path.
   */
  appQuestionList: AppQuestion[] = []
  readonly answeredQuestions: { questionId: string; decision: 'allow' | 'deny' }[] = []
  private questionWaiters = new Map<string, (d: 'allow' | 'deny') => void>()
  /** Remembered answers (M4 D-4) — the key is `(project ?? _user)/app`. A test fills this in */
  readonly appPermissions = new Map<string, AppPermission[]>()
  /** Agent usage (M4 D-5) — the key is `(project ?? _user)/app`. A test fills this in */
  readonly appUsage = new Map<string, AppUsage>()
  readonly forgottenPermissions: { appId: string; projectId: string | null; capability: string }[] = []
  /** Scenario helper: the host sets up a capability question — returns a promise that resolves once an answer arrives (used from Playwright) */
  askAppQuestion(q: AppQuestion): Promise<'allow' | 'deny'> {
    this.appQuestionList.push(structuredClone(q))
    this.emit({ type: 'external_app_questions_changed' })
    return new Promise((resolve) => this.questionWaiters.set(q.id, resolve))
  }
  /** An answer given on an approval card — tests check which card got which click */
  readonly approvalAnswers: { sessionId: string; requestId: string; decision: ApprovalDecision }[] = []
  /** Apps asked to restart — tests check whether the Restart button reached the host */
  readonly restarts: { appId: string; projectId: string | null }[] = []
  /**
   * Run history (M4 B-7) — the key is `(project ?? _user)/app`. A test fills this in (most
   * recent first). Like the host, this only reads and never creates: making a record is the
   * runtime's one and only path, and its test lives in agent-host.
   */
  readonly appRuns = new Map<string, AppRun[]>()
  /** How many times the history has been read — tests check it is re-read when "changed" arrives */
  appRunReads = 0
  /** If set, history is read from here instead — a test plugs in the real runtime's history (`ExternalApps.runs`) */
  appRunsProvider: ((appId: string, projectId: string | null, limit: number) => AppRun[] | Promise<AppRun[]>) | null = null
  /** A deleted user-folder app — tests check it only reaches the host after confirmation */
  readonly removedApps: string[] = []
  /** Pinned screens opened and instances closed — tests check "how many times opened," "released on close" */
  readonly openedViews: { appId: string; projectId: string | null }[] = []
  readonly closedViews: string[] = []
  /** An in-conversation screen's instance → its conversation and app (M4 B-1) — recorded when broadcasting `app_view`'s open */
  readonly inlineInstances = new Map<string, { sessionId: string; appId: string; projectId: string | null }>()
  /** Messages an in-conversation screen sent into the conversation — tests check these only reach here after the person confirms */
  readonly viewMessages: { sessionId: string; instanceId: string; text: string }[] = []
  /** An in-conversation screen's input and outcome — held like the host, and returned when reopened. The key is the `session callId` pair */
  readonly inlineRecords = new Map<
    string,
    {
      appId: string
      projectId: string | null
      tool: string
      toolInput: Record<string, unknown>
      toolResult?: AppToolResult
      cancelled?: string
      /** The open instance — null once closed (the record stays) */
      instanceId: string | null
    }
  >()
  /** Reopened screens — tests check whether "Reopen" reached the host */
  readonly reopenedViews: { sessionId: string; callId: string }[] = []
  /** The side that builds a new instance when reopening (a test plugs in the real ViewHost) */
  inlineInstanceProvider: ((appId: string, projectId: string | null) => string | Promise<string>) | null = null
  openViewProvider: ((appId: string, projectId: string | null) => Promise<AppHomeView>) | null = null
  /** External apps discovered (M4 A-8) — a test fills this in with `setExternalApps`. The mock's discovery is this array */
  externalAppList: ExternalAppInfo[] = []
  /** Like the host: changes the list and broadcasts `external_apps_changed` */
  setExternalApps(list: ExternalAppInfo[]): void {
    this.externalAppList = structuredClone(list)
    this.emit({ type: 'external_apps_changed' })
  }
  lastInvoke: { appId: string; name: string; args: Record<string, unknown> } | null = null
  /** The side that builds a screen's address (a test plugs this in) */
  viewFrameProvider:
    | ((appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => Promise<AppViewFrame>)
    | null = null
  /** Tools called from a screen — tests check what went out under which app's name */
  readonly appToolCalls: { appId: string; tool: string; args: Record<string, unknown>; from: AppCallOrigin }[] = []
  appToolHandler: ((appId: string, tool: string, args: Record<string, unknown>, from: AppCallOrigin) => AppToolResult | Promise<AppToolResult>) | null =
    null
  /** `${appId} ${uri}` → the read result */
  readonly appResources = new Map<string, AppResourceResult>()
  readonly appResourceReads: { appId: string; uri: string; from: AppCallOrigin }[] = []

  /** The detected tools — kept outside so a test can build "a tool that is not logged in" */
  detected: ToolStatus[] = [
    {
      name: 'claude',
      label: 'Claude Code',
      mark: 'C',
      install: 'npm i -g @anthropic-ai/claude-code',
      login: 'claude auth login',
      installed: true,
      loggedIn: true,
      detail: 'mock 2.1.0',
    },
    {
      name: 'codex',
      label: 'Codex',
      mark: 'X',
      install: 'npm i -g @openai/codex',
      login: 'codex login',
      installed: true,
      loggedIn: true,
      detail: 'mock codex',
    },
  ]

  /**
   * The "leftover process" list a test plants — the real thing finds these with ps and lsof,
   * but the mock only fakes that spot (what is being verified is the shutdown flow, not
   * process detection; the detection rules are covered by the host's unit tests).
   */
  strayProcesses: { pid: number; command: string; cwd: string }[] = []

  readonly processes = {
    strays: async () => [...this.strayProcesses],
    stop: async (pids: number[]) => {
      const before = this.strayProcesses.length
      this.strayProcesses = this.strayProcesses.filter((s) => !pids.includes(s.pid))
      return { stopped: before - this.strayProcesses.length }
    },
  }

  readonly agents: AgentPort = {
    createSession: async (params: CreateSessionParams) => {
      this.lastCreateParams = params
      this.createParamsLog.push(params)
      const id = `mock-session-${++this.idc}`
      const worktree = params.worktree
        ? {
            path: `/mock/worktrees/${id}`,
            branch: params.worktreeBranch?.trim() || `centralu/${id.slice(-8)}`,
          }
        : null
      /*
       * The same rule as the real thing (#69, manager.managerFor): a worktree session stands
       * under a manager from the moment it is born. The manager is an ordinary session with
       * children, and if there is none, only a row is created (live=false — the process is
       * born when someone speaks to it).
       */
      let parentSessionId: string | null = null
      if (worktree && params.projectId) {
        const projectId = params.projectId
        const owner = this.projectsList.find((p) => p.id === projectId)
        /*
         * The lookup order is also exactly the real thing's (#76): where the project points →
         * relationship → create. Skipping the first branch here once made a second manager
         * stand up next to one already created (e2e caught it) — if the mock is lazier than
         * the real thing, the contract splits on screen only.
         */
        const seated = owner?.worktreeManager && this.sessions.get(owner.worktreeManager.sessionId)
        const withKids = new Set([...this.sessions.values()].map((x) => x.parentSessionId).filter(Boolean))
        let mgr: SessionInfo | undefined =
          seated ||
          [...this.sessions.values()].find(
            (x) => x.projectId === projectId && !x.worktree && withKids.has(x.id),
          )
        if (!mgr) {
          const mgrId = `mock-manager-${++this.idc}`
          mgr = {
            id: mgrId,
            projectId: params.projectId,
            kind: 'worker',
            tool: params.tool,
            externalId: null,
            name: 'Worktree manager',
            autoNamed: false,
            state: 'idle',
            lastReadSeq: 0,
            lastSeq: 0,
            createdAt: this.now(),
            waitingSince: null,
            live: false,
            model: null,
            effort: null,
            verbosity: null,
            serviceTier: null,
            permissionPreset: 'normal',
            importedFrom: null,
            worktree: null,
            parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
            ...sessionLiveDefaults(),
          }
          this.sessions.set(mgrId, mgr)
          this.emit({ type: 'session_created', sessionId: mgrId, session: mgr })
        }
        // Whether found through the relationship or just created, has the project point to it too (the real thing's self-healing)
        if (owner)
          owner.worktreeManager = { sessionId: mgr.id, baseBranch: owner.worktreeManager?.baseBranch ?? '' }
        parentSessionId = mgr.id
      }
      const info: SessionInfo = {
        id,
        projectId: params.projectId,
        kind: 'worker',
        scopeSessionIds: null,
        roleAppend: null,
        appId: null,
        tool: params.tool,
        externalId: `ext-${id}`,
        worktree,
        parentSessionId,
        effort: params.effort ?? null,
        verbosity: params.verbosity ?? null,
        serviceTier: params.serviceTier ?? null,
        /*
         * The same rule as the real thing (#69): if the person set the branch name, that name
         * is the session name and the automatic name does not overwrite it. If they did not,
         * it **starts** as the automatic branch name — this used to be 'New session' here, and
         * in the worktree panel it was unreadable which row was which branch.
         */
        name:
          (params.worktreeBranch?.trim() || undefined) ??
          params.initialPrompt?.slice(0, 40) ??
          worktree?.branch ??
          'New session',
        autoNamed: !params.worktreeBranch?.trim(),
        state: 'idle',
        lastReadSeq: 0,
        lastSeq: 0,
        createdAt: this.now(),
        waitingSince: null,
        live: true,
        model: params.model ?? null,
        permissionPreset: params.permissionPreset ?? 'normal',
        importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
        ...sessionLiveDefaults(),
      }
      if (params.resumeExternalId) info.externalId = params.resumeExternalId
      this.sessions.set(id, info)
      // The same rule as the real thing: the last tool chosen becomes that project's default (manager.createSession)
      const owner = this.projectsList.find((p) => p.id === params.projectId)
      if (owner) owner.defaultTool = params.tool
      /*
       * The same order as the real thing (#172): once the host creates a session, it broadcasts
       * `session_created` first, and only after broadcasting the handoff marker and the first
       * prompt does it respond. While the mock skipped this, an event arriving before
       * registration would be held and replayed after the response, and a defect where the
       * response overwrites the screen's conversation was masked on the mock only.
       */
      this.emit({ type: 'session_created', sessionId: id, session: structuredClone(info) })
      // Import: restores a previous conversation already marked as read (the same rule as the host's importHistory)
      if (params.importHistory && params.resumeExternalId) {
        const history = this.externalHistory.get(params.resumeExternalId) ?? []
        for (const h of history) {
          const seq = (this.messages.get(id)?.length ?? 0) + 1
          this.pushMessage({
            sessionId: id,
            seq,
            role: h.role,
            kind: 'text',
            payload: { text: h.text },
            ts: this.now(),
          })
          info.lastSeq = seq
          info.lastReadSeq = seq
        }
        const firstUser = history.find((h) => h.role === 'user')
        const listed = this.externalSessions.sessions.find((s) => s.externalId === params.resumeExternalId)
        if (listed) info.name = listed.title
        else if (firstUser) info.name = firstUser.text.slice(0, 40)
      }
      /*
       * The same rule as the real thing (#102): an inherited note is not kept as the first
       * message but as a **marker**. If the mock skips this, "the note survives even if the
       * file is lost" becomes a contract that only holds on screen.
       */
      if (params.handoff) {
        const seq = (this.messages.get(id)?.length ?? 0) + 1
        const { from, note } = params.handoff
        this.pushMessage({
          sessionId: id,
          seq,
          role: 'system',
          kind: 'marker',
          payload: { type: 'handoff', sessionId: id, seq, from, note },
          ts: this.now(),
        })
        info.lastSeq = seq
        this.emit({ type: 'handoff', sessionId: id, seq, from })
      }
      if (params.initialPrompt) {
        /*
         * The same rule as the real thing (#172): the first prompt is recorded and broadcast as
         * `user_message` before the response goes out. The ordinary `send` does not send an
         * acknowledgement (that is the mock's contract), so here it notifies directly like the
         * host — emit records it and assigns the number.
         */
        this.emit({ type: 'user_message', sessionId: id, seq: (this.messages.get(id)?.length ?? 0) + 1, text: params.initialPrompt })
        info.lastReadSeq = info.lastSeq
        if (info.autoNamed && info.name === 'New session') {
          info.name = params.initialPrompt.slice(0, 40)
          this.emit({ type: 'session_title', sessionId: id, title: info.name, auto: true })
        }
        this.emit({ type: 'state_change', sessionId: id, state: 'working' })
      }
      return info
    },
    saveAttachment: async (_sessionId: string, name: string, mime: string, dataBase64: string) => {
      const att = {
        kind: mime.startsWith('image/') ? ('image' as const) : ('file' as const),
        path: `/tmp/att/${name}`,
        name,
        mime,
        bytes: dataBase64.length,
      }
      this.savedAttachments.push(att)
      this.attachmentData.set(att.path, dataBase64)
      return att
    },
    send: async (sessionId: string, text: string, attachments?: Attachment[]) => {
      if (attachments?.length) this.sentAttachments.push(...attachments)
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      // The same rule as the host: if it is asleep, revive it and then send (automatic resume)
      if (!s.live) {
        if (this.unresumable.has(sessionId)) {
          throw Object.assign(
            new Error('Could not resume the conversation: this session cannot be resumed'),
            {
              code: 'session_not_found',
            },
          )
        }
        s.live = true
      }
      const seq = (this.messages.get(sessionId)?.length ?? 0) + 1
      // The same rule as the real thing: attachments also stay in the payload, and image bytes are re-loaded from "disk" (a map, here)
      const stored = attachments?.map((a) =>
        a.kind === 'image' && this.attachmentData.has(a.path)
          ? { ...a, data: this.attachmentData.get(a.path) }
          : a,
      )
      this.pushMessage({
        sessionId,
        seq,
        role: 'user',
        kind: 'text',
        payload: { text, ...(stored?.length ? { attachments: stored } : {}) },
        ts: this.now(),
      })
      s.lastSeq = seq
      s.lastReadSeq = seq
      if (s.autoNamed && s.name === 'New session') {
        s.name = text.slice(0, 40)
        this.emit({ type: 'session_title', sessionId, title: s.name, auto: true })
      }
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    respondApproval: async (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
      _scope?: ApprovalScope,
    ) => {
      this.approvalAnswers.push({ sessionId, requestId, decision })
      this.emit({ type: 'approval_resolved', sessionId, requestId, decision })
      /*
       * A capability-question card (M4 D-4, set up by the host with a `cap-` prefix) is not an
       * adapter's card — once the host receives an answer, the waiting app's call resumes, and
       * the agent gets that tool's result and finishes the turn. The mock fakes that resumption.
       */
      if (requestId.startsWith('cap-')) {
        this.emit({ type: 'state_change', sessionId, state: 'working' })
        this.emit({
          type: 'message_delta',
          sessionId,
          role: 'assistant',
          text: decision === 'deny' ? 'The app was not allowed to go on.' : 'The app went on and finished.',
        })
      }
      this.emit({ type: 'turn_complete', sessionId })
    },
    answerQuestion: async (sessionId: string, requestId: string, answers: QuestionAnswer[]) => {
      this.emit({ type: 'question_resolved', sessionId, requestId })
      // It has to be possible to confirm on screen what came back (a display with no delivered answer would be only half done)
      this.emit({
        type: 'message_delta',
        sessionId,
        role: 'assistant',
        text: `Answer received: ${answers.map((a) => a.answers.join('+')).join(' | ')}`,
      })
      this.emit({ type: 'turn_complete', sessionId })
    },
    reorderSessions: async (projectId: string, orderedIds: string[]) => {
      const mine = [...this.sessions.values()].filter((s) => s.projectId === projectId)
      const rank = new Map(orderedIds.map((id, i) => [id, i]))
      mine.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
      const others = [...this.sessions.entries()].filter(([, s]) => s.projectId !== projectId)
      this.sessions = new Map([...others, ...mine.map((s) => [s.id, s] as const)])
      return [...this.sessions.values()]
    },
    switchTool: async (sessionId: string, tool: ToolName) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      /*
       * The same rule as the real thing: switching tools breaks the thread to resume, and
       * **also drops the model and its attached settings** (a rule confirmed by measurement —
       * see the comment on manager.switchTool: keeping 'sonnet' while switching to codex kills
       * the first turn with a 400). The worktree is a fact about the directory, so it is
       * unaffected by the tool.
       */
      const next = {
        ...s,
        tool,
        externalId: null,
        importedFrom: null,
        live: false,
        model: null,
        effort: null,
        verbosity: null,
        serviceTier: null,
      }
      this.sessions.set(sessionId, next)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'tool_changed' })
      return next
    },
    orchestrator: async () => {
      // The same rule as the real thing: creates one on the spot if there is none. Does not belong to a project
      const found = [...this.sessions.values()].find((x) => x.projectId === null)
      if (found) return found
      const id = `orc-${++this.idc}`
      const info = {
        // The same rule as the real thing: the tool follows the choice on the intro screen (#63)
        id,
        projectId: null,
        kind: 'orchestrator' as const,
        tool: this.orchestratorTool,
        externalId: null,
        name: 'Orchestrator',
        autoNamed: false,
        state: 'idle' as const,
        lastReadSeq: 0,
        lastSeq: 0,
        createdAt: this.now(),
        waitingSince: null,
        live: true,
        model: null,
        effort: null,
        verbosity: null,
        serviceTier: null,
        permissionPreset: 'normal' as const,
        importedFrom: null,
        worktree: null,
        parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
        ...sessionLiveDefaults(),
      }
      this.sessions.set(id, info)
      return info
    },
    // The same rule as the real thing (#63): opening the screen only asks — creating it is orchestrator()'s job, at the first question
    orchestratorPeek: async () => [...this.sessions.values()].find((x) => x.projectId === null) ?? null,
    configureOrchestrator: async (tool: ToolName) => {
      this.orchestratorTool = tool
    },
    grid: async () => [...this.gridPanels],
    setGridView: async (sessionIds: string[]) => {
      this.gridPanels = sessionIds.filter((id) => this.sessions.has(id))
      return [...this.gridPanels]
    },
    models: async (tool: ToolName) => ({
      supported: true,
      models:
        tool === 'codex'
          ? [
              // Exactly the measured shape: tiers exist only on the big model (priority = Fast, 1.5x)
              {
                id: 'gpt-5.6-terra',
                label: 'gpt-5.6-terra',
                efforts: ['low', 'medium', 'high'],
                defaultEffort: 'medium',
                tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
              },
              {
                id: 'gpt-5.6-terra-mini',
                label: 'gpt-5.6-terra-mini',
                efforts: [],
                defaultEffort: null,
                tiers: [],
              },
            ]
          : [
              {
                id: 'sonnet',
                label: 'Sonnet',
                efforts: ['low', 'medium', 'high', 'xhigh'],
                defaultEffort: null,
                tiers: [],
              },
              {
                id: 'opus',
                label: 'Opus',
                efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultEffort: null,
                tiers: [],
              },
              {
                id: 'fable',
                label: 'Fable',
                efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
                defaultEffort: null,
                tiers: [],
              },
              { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, tiers: [] },
            ],
    }),
    interrupt: async (sessionId: string) => {
      this.emit({ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' })
    },
    /**
     * A dead-agent handoff record (#78) — gives deterministic text carrying the session name,
     * like the real thing. **Placed in the notes location**, like the real thing (#102, #142):
     * the two modes converging on one location is the contract of this feature. The location
     * is the host's data folder, so it is not placed in the mock's project files (fsState).
     */
    exportHandoffRecord: async (sessionId: string, toTool?: ToolName) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
      const text = `# CentralU Handoff Record (automatic)\n\npredecessor "${s.name}" (${s.tool}${toTool ? ` → ${toTool}` : ''}) — mock record for ${sessionId}`
      return { text, path: this.placeHandoffNote(s, text) }
    },
    /**
     * The note for a live handoff (#142) — the same rule as the real thing: the first human
     * message after afterSeq is the request, and the note is the **last** assistant message
     * before the next human message. The mock also gathers a message into one row (emit), so
     * the last row is exactly the last message.
     */
    exportHandoffNote: async (sessionId: string, afterSeq: number) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
      if (s.state === 'working' || s.state === 'waiting_approval') return null
      let note = ''
      let asked = false
      for (const r of this.messages.get(sessionId) ?? []) {
        if (r.seq <= afterSeq) continue
        if (r.role === 'user') {
          if (asked) break
          asked = true
          continue
        }
        if (asked && r.role === 'assistant' && r.kind === 'text') note = (r.payload as { text?: string }).text ?? ''
      }
      note = note.trim()
      return note ? { text: note, path: this.placeHandoffNote(s, note) } : null
    },
    /** Fakes a worktree in the mock too — the UI needs to be able to test "ask, then delete" */
    worktreeStatus: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s?.worktree) return null
      return { ...s.worktree, dirty: this.mockWorktreeDirty, changedFiles: this.mockWorktreeDirty ? 2 : 0 }
    },
    mcpProposals: async () => ({ proposals: [...this.mcpProposalList] }),
    resolveMcpProposal: async (name: string, approve: boolean) => {
      const at = this.mcpProposalList.findIndex((p) => p.name === name)
      if (at === -1) throw Object.assign(new Error(`No pending proposal named "${name}"`), { code: 'internal' })
      const [hit] = this.mcpProposalList.splice(at, 1)
      if (approve) this.mcpApproved.push(hit!.name)
    },
    skillProposals: async () => ({ proposals: [...this.skillProposalList] }),
    resolveSkillProposal: async (name: string, approve: boolean) => {
      const at = this.skillProposalList.findIndex((p) => p.name === name)
      if (at === -1) throw Object.assign(new Error(`No pending skill proposal named "${name}"`), { code: 'internal' })
      const [hit] = this.skillProposalList.splice(at, 1)
      if (approve) this.skillList.push({ name: hit!.name, content: hit!.content })
    },
    orchestratorSkills: async () => ({ skills: [...this.skillList] }),
    deleteOrchestratorSkill: async (name: string) => {
      const at = this.skillList.findIndex((s) => s.name === name)
      if (at === -1) throw Object.assign(new Error(`No skill named "${name}"`), { code: 'internal' })
      this.skillList.splice(at, 1)
    },
    // Moves it to the trash (#204) — the tool's file and the worktree wait there until it is deleted for good
    deleteSession: async (sessionId: string, deleteWorktree = false, deleteExternal = false) => {
      this.moveToTrash(sessionId, deleteWorktree, deleteExternal)
    },
    updateSettings: async (
      sessionId: string,
      s: {
        model?: string | null
        effort?: string | null
        verbosity?: string | null
        serviceTier?: string | null
        permissionPreset?: PermissionPreset
      },
    ) => {
      const sess = this.sessions.get(sessionId)
      if (!sess) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      if (s.model !== undefined) sess.model = s.model
      if (s.effort !== undefined) sess.effort = s.effort
      if (s.verbosity !== undefined) sess.verbosity = s.verbosity
      if (s.serviceTier !== undefined) sess.serviceTier = s.serviceTier
      if (s.permissionPreset) sess.permissionPreset = s.permissionPreset
      return { ...sess }
    },
    restartSession: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      this.restarted.push(sessionId)
      if (this.unresumable.has(sessionId)) {
        return { session: { ...s }, resumed: false, reason: 'This session cannot be resumed' }
      }
      s.live = true
      return { session: { ...s }, resumed: true }
    },
    resumeSession: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      if (this.unresumable.has(sessionId)) {
        return { session: { ...s }, resumed: false, reason: 'This session cannot be resumed' }
      }
      s.live = true
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: { ...s }, resumed: true }
    },
    /** Forks off a locked conversation — pointing at a copy makes it the same as if the lock had come off */
    forkConversation: async (sessionId: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('Session not found'), { code: 'session_not_found' })
      this.unresumable.delete(sessionId)
      s.live = true
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: { ...s }, resumed: true }
    },
    /*
      Returns a failure as a failure — the same rule as the host (manager.rename).
      Passing it through silently would mean "renamed, but the list stayed the same" cannot be
      reproduced in the mock, turning it into the kind of bug that only surfaces in the actual app.
    */
    rename: async (sessionId: string, name: string) => {
      const s = this.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
      const next = name.trim()
      if (!next) throw Object.assign(new Error('Session name cannot be empty'), { code: 'internal' })
      s.name = next
      s.autoNamed = false
      this.emit({ type: 'session_title', sessionId, title: next, auto: false })
    },
    markRead: async (sessionId: string, seq: number) => {
      const s = this.sessions.get(sessionId)
      if (s) s.lastReadSeq = Math.max(s.lastReadSeq, seq)
    },
    listSessions: async () => [...this.sessions.values()].map((s) => ({ ...s })),
    loadMessages: async (sessionId: string, limit = 200, beforeSeq?: number) => {
      const all = this.messages.get(sessionId) ?? []
      const filtered = beforeSeq ? all.filter((m) => m.seq < beforeSeq) : all
      return filtered.slice(-limit)
    },
    listExternalSessions: async (_projectId: string, tool: ToolName, _limit = 30) => {
      // The same rule as the host: the original held by a session that is not hidden is "already open"
      const known = new Map<string, string>()
      for (const s of this.sessions.values()) {
        if (s.tool !== tool) continue
        for (const key of [s.importedFrom, s.externalId]) {
          if (key && !known.has(key)) known.set(key, s.id)
        }
      }
      return {
        ...this.externalSessions,
        sessions: this.externalSessions.sessions
          .filter((s) => s.tool === tool)
          .map((s) => ({
            ...s,
            imported: known.has(s.externalId),
            importedAs: known.get(s.externalId) ?? null,
          })),
      }
    },
    commands: async (_sessionId: string) => ({ ...this.commandState }),
    usage: async (_tool: ToolName) => ({ ...this.usageState }),
    capabilities: async (tool: ToolName): Promise<AdapterCapabilities> => ({
      approvals: true,
      contextUsage: 'exact',
      resume: true,
      autoTitle: true,
      attachments: ['image', 'file'],
      // The same shape as the real thing: only codex has a response-length knob (#54) — the UI draws its row from this array
      verbosities: tool === 'codex' ? ['low', 'medium', 'high'] : [],
      // The same shape as the real thing: only codex has a writer lock (the UI does not read this yet, but the shape follows the real thing)
      exclusiveWriter: tool === 'codex',
    }),
    detect: async () => this.detected,
    subscribe: (handler: (e: NormalizedEvent) => void): Unsubscribe => {
      this.handlers.add(handler)
      return () => this.handlers.delete(handler)
    },
    onConnectionChange: (handler: (s: ConnectionState) => void): Unsubscribe => {
      this.connHandlers.add(handler)
      return () => this.connHandlers.delete(handler)
    },
  }

  /**
   * When returning a project, **recounts the change count from gitState** (issue #41).
   *
   * On the real host, the sidebar's number and the git panel's listing are two readings of
   * the same single `git status`. If the mock held the number separately, a test that changes
   * the file list would leave the number stale — an inconsistency the real thing could never
   * produce, and the contract this file's header lays out.
   */
  private withGit(p: ProjectInfo): ProjectInfo {
    return p.git ? { ...p, git: { ...p.git, changedFiles: this.gitState.files.length } } : { ...p }
  }

  readonly projects: ProjectPort = {
    reorder: async (orderedIds: string[]) => {
      const rank = new Map(orderedIds.map((id, i) => [id, i]))
      this.projectsList.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
      return [...this.projectsList]
    },
    add: async (path: string) => {
      const existing = this.projectsList.find((p) => p.path === path)
      if (existing) return existing
      /*
       * The name is the directory's last segment under **either** separator (#47).
       *
       * This one is not a wire path — a project's directory is native, and it is the one string
       * that arrives here still spelled the way its own machine spells it. The host names the
       * project with `basename` from `node:path`, which reads `\` on Windows; reading only `/`
       * here meant the mock would have called a project `C:\Users\me\proj` while the host called
       * it `proj`, and e2e — which only ever runs the mock — would have stayed green about it.
       */
      const info: ProjectInfo = {
        id: `mock-project-${++this.idc}`,
        path,
        name: osPathBaseName(path) || path,
        defaultTool: 'claude',
        // Default model and strength per tool (#107) — empty for a new project that has never had anything chosen
        defaultModels: {},
        commands: [],
        worktreeSetup: null,
        worktreeManager: null,
        // A newly registered project starts untrusted — the same as the real thing (M4, decision 3)
        trusted: false,
        git: { branch: 'main', changedFiles: 0, isRepo: true },
      }
      this.projectsList.push(info)
      return info
    },
    /**
     * Trust (M4). Like the real thing, that project's app list follows along: the runtime
     * re-scans when trust changes, standing an untrusted project's apps as `untrusted` and a
     * trusted one's as resting (`stopped`). If the mock skips this, e2e would pass green on a
     * screen where clicking "Trust" still leaves the app blocked.
     */
    setTrusted: async (projectId: string, trusted: boolean) => {
      const at = this.projectsList.findIndex((x) => x.id === projectId)
      if (at === -1) throw Object.assign(new Error(`Project not found: ${projectId}`), { code: 'internal' })
      // Swaps in a new object — the screen holds onto the object `add` returned as-is, so mutating it would let a value that never crossed the wire leak into the screen (the real thing's response is always a new object)
      this.projectsList[at] = { ...this.projectsList[at]!, trusted }
      this.trustCalls.push({ projectId, trusted })
      const mine = this.externalAppList.filter((a) => a.projectId === projectId)
      if (mine.length === 0) return
      for (const a of mine) {
        a.trusted = trusted
        if (!trusted && a.status !== 'invalid') Object.assign(a, { status: 'untrusted', error: null })
        else if (trusted && a.status === 'untrusted') a.status = 'stopped'
      }
      this.emit({ type: 'external_apps_changed' })
    },
    list: async () => this.projectsList.map((p) => this.withGit(p)),
    gitStatus: async (projectId: string) => {
      this.gitStatusCalls++
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      return this.withGit(p)
    },
    /*
     * Removes things in the same order as the real thing: deletes sessions one by one, firing
     * `session_deleted` for each, then drops the project. The screen clears its list from that
     * event, so if the mock silently deleted only the project, e2e would be left with ghost
     * sessions in the sidebar. The sessions go to the trash (#204), marked to keep
     * the tool's files and worktrees, as the host does.
     */
    remove: async (projectId: string) => {
      const at = this.projectsList.findIndex((x) => x.id === projectId)
      if (at === -1) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      for (const s of [...this.sessions.values()].filter((s) => s.projectId === projectId)) {
        this.moveToTrash(s.id, false, false)
      }
      this.projectsList.splice(at, 1)
      return { ok: true as const }
    },
    /**
     * The registered shell commands (issue #44).
     *
     * **Strips blank lines exactly like the host.** If the mock were more forgiving than the
     * real thing, e2e would stay green while the actual app behaved differently — the contract
     * this file's header lays out.
     */
    setCommands: async (projectId: string, commands: SavedCommand[]) => {
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      p.commands = commands.flatMap((c): SavedCommand[] => {
        const command = c.command.trim()
        if (!command) return []
        const label = c.label?.trim()
        return [{ command, ...(label ? { label } : {}) }]
      })
      return [...p.commands]
    },
    // The same rule as the real thing (#69): an empty setup lays down as null — a mock that is more forgiving would split the contract apart
    setWorktreeSetup: async (projectId: string, setup: { command: string; copyFiles: string[] } | null) => {
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      const clean = setup
        ? { command: setup.command.trim(), copyFiles: setup.copyFiles.map((f) => f.trim()).filter(Boolean) }
        : null
      p.worktreeSetup = clean && (clean.command || clean.copyFiles.length) ? clean : null
    },
    /*
     * The same rule as the real thing (#76): there is one slot per project, and calling this
     * again **only rewrites the trunk**. The manager row is born as the worktree session's
     * parent, so this also creates it as a process-less row (live:false) — if the mock created
     * a live session, the screen would get ahead of the real thing.
     */
    createWorktreeManager: async (projectId: string, baseBranch: string) => {
      const p = this.projectsList.find((x) => x.id === projectId)
      if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      const branch = baseBranch.trim()
      if (!branch)
        throw Object.assign(new Error('Pick the branch worktrees should fork from'), { code: 'internal' })
      const seated = p.worktreeManager && this.sessions.get(p.worktreeManager.sessionId)
      if (seated) {
        p.worktreeManager = { sessionId: seated.id, baseBranch: branch }
        return { ...seated }
      }
      const id = `mock-session-${++this.idc}`
      const manager: SessionInfo = {
        id,
        projectId,
        kind: 'worker',
        tool: p.defaultTool ?? this.detected[0]?.name ?? 'claude',
        externalId: null,
        name: 'Worktree manager',
        autoNamed: false,
        state: 'idle',
        lastReadSeq: 0,
        lastSeq: 0,
        createdAt: this.now(),
        waitingSince: null,
        live: false,
        model: null,
        effort: null,
        verbosity: null,
        serviceTier: null,
        permissionPreset: 'normal',
        importedFrom: null,
        worktree: null,
        parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
        ...sessionLiveDefaults(),
      }
      this.sessions.set(id, manager)
      p.worktreeManager = { sessionId: id, baseBranch: branch }
      this.emit({ type: 'session_created', sessionId: id, session: manager })
      return { ...manager }
    },
  }

  /**
   * The mock terminal. Does not spawn a real shell — it fakes only **the property of being
   * bound to a cwd**, since what is being verified is "does the same terminal carry over when
   * the session changes," not the shell itself.
   */
  terminalState: {
    byCwd: Map<string, { id: string; title: string; history: string; alive: boolean }[]>
    input: { terminalId: string; data: string }[]
    resized: { terminalId: string; cols: number; rows: number }[]
    closed: string[]
  } = { byCwd: new Map(), input: [], resized: [], closed: [] }
  private termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  private termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()

  /** For tests: makes a terminal produce some output */
  emitTerminal(terminalId: string, data: string): void {
    for (const [, list] of this.terminalState.byCwd) {
      for (const t of list) if (t.id === terminalId) t.history += data
    }
    for (const h of this.termHandlers) h({ terminalId, data })
  }

  /** For tests: the shell has died — an exit that is not a command run (runId) rides the same lane */
  emitTerminalExit(terminalId: string, exitCode: number | null): void {
    for (const [, list] of this.terminalState.byCwd) {
      for (const t of list) if (t.id === terminalId) t.alive = false
    }
    for (const h of this.termExitHandlers) h({ terminalId, exitCode })
  }

  private cwdOf(projectId: string): string {
    return this.projectsList.find((p) => p.id === projectId)?.path ?? projectId
  }

  readonly terminal: TerminalPort = {
    list: async (projectId: string) => {
      const cwd = this.cwdOf(projectId)
      return (this.terminalState.byCwd.get(cwd) ?? []).map((t) => ({
        terminalId: t.id,
        cwd,
        title: t.title,
        history: t.history,
        alive: t.alive,
      }))
    },
    create: async (projectId: string) => {
      const cwd = this.cwdOf(projectId)
      const list = this.terminalState.byCwd.get(cwd) ?? []
      const t = {
        id: `mock-term-${++this.idc}`,
        title: `Terminal ${list.length + 1}`,
        history: '',
        alive: true,
      }
      list.push(t)
      this.terminalState.byCwd.set(cwd, list)
      return { terminalId: t.id, cwd, title: t.title, history: t.history, alive: true }
    },
    close: async (terminalId: string) => {
      this.terminalState.closed.push(terminalId)
      for (const [cwd, list] of this.terminalState.byCwd) {
        const next = list.filter((t) => t.id !== terminalId)
        if (next.length === list.length) continue
        next.forEach((t, i) => (t.title = `Terminal ${i + 1}`))
        if (next.length === 0) this.terminalState.byCwd.delete(cwd)
        else this.terminalState.byCwd.set(cwd, next)
      }
    },
    input: async (terminalId: string, data: string) => {
      this.terminalState.input.push({ terminalId, data })
    },
    resize: async (terminalId: string, cols: number, rows: number) => {
      this.terminalState.resized.push({ terminalId, cols, rows })
    },
    restart: async (terminalId: string) => {
      for (const [cwd, list] of this.terminalState.byCwd) {
        for (const t of list) {
          if (t.id !== terminalId) continue
          t.alive = true
          return { terminalId: t.id, cwd, title: t.title, history: t.history, alive: true }
        }
      }
      throw Object.assign(new Error('Terminal not found'), { code: 'internal' })
    },
    onOutput: (h: (e: { terminalId: string; data: string }) => void) => {
      this.termHandlers.add(h)
      return () => this.termHandlers.delete(h)
    },
    onExit: (h: (e: { terminalId: string; exitCode: number | null }) => void) => {
      this.termExitHandlers.add(h)
      return () => this.termExitHandlers.delete(h)
    },
  }

  /** Run state for frequently used commands (#60). The key is the same (projectId, command) pair as the real thing */
  commandRuns = new Map<
    string,
    {
      command: string
      runId: string
      running: boolean
      exitCode: number | null
      startedAt: number
      history: string
    }
  >()
  private runKey(projectId: string, command: string): string {
    return `${projectId}\u0000${command}`
  }
  /** For tests: a running command produces output (goes out on the same lane as the terminal) */
  emitCommandOutput(projectId: string, command: string, data: string): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r) return
    r.history += data
    for (const h of this.termHandlers) h({ terminalId: r.runId, data })
  }
  /** For tests: a run finishes — the outcome of a one-shot command */
  exitCommand(projectId: string, command: string, exitCode: number): void {
    const r = this.commandRuns.get(this.runKey(projectId, command))
    if (!r || !r.running) return
    r.running = false
    r.exitCode = exitCode
    for (const h of this.termExitHandlers) h({ terminalId: r.runId, exitCode })
  }

  // The same contract as the real thing (#60): one last run per command, a re-run kills and replaces it, and the log lives as long as the run does
  readonly commands = {
    run: async (projectId: string, command: string, _cols: number, _rows: number) => {
      const r = {
        command,
        runId: `mock-run-${++this.idc}`,
        running: true,
        exitCode: null as number | null,
        startedAt: this.now(),
        history: '',
      }
      this.commandRuns.set(this.runKey(projectId, command), r)
      const { history: _h, ...rest } = r
      return rest
    },
    stop: async (projectId: string, command: string) => {
      // In the real thing, onExit comes after kill — the mock produces that outcome immediately (130 = the SIGINT convention)
      this.exitCommand(projectId, command, 130)
    },
    state: async (projectId: string) => {
      const out = []
      for (const [k, r] of this.commandRuns) {
        if (!k.startsWith(`${projectId}\u0000`)) continue
        const { history: _h, ...rest } = r
        out.push(rest)
      }
      return out
    },
    log: async (projectId: string, command: string) => {
      const r = this.commandRuns.get(this.runKey(projectId, command))
      return r ? { ...r } : null
    },
    resize: async () => {},
  }

  readonly system: SystemPort = {
    notify: async (title: string, body: string) => {
      this.notifications.push({ title, body })
    },
    alert: async (kind: AlertKind, sound: boolean) => {
      this.alerts.push({ kind, sound })
    },
    setBadge: async (count: number) => {
      this.badge = count
    },
    openInIde: async (path: string, line?: number) => {
      this.opened.push({ path, line })
    },
    openUrl: async (url: string) => {
      this.openedUrls.push(url)
    },
    startWindowDrag: async () => {
      // The number of times the window drag started — a test needs to be able to see "tried to move a panel, but the app window moved instead"
      this.windowDrags++
    },
    pickDirectory: async () => this.nextPickedDirectory,
    pickFile: async (opts: { title: string; extensions: string[] }) => {
      this.pickedFileAsks.push(opts)
      return this.nextPickedFile
    },
    onAppLink: (cb: (link: string) => void) => {
      this.appLinkListeners.add(cb)
      return () => void this.appLinkListeners.delete(cb)
    },
  }

  /** How many times a window drag started (checked from Playwright) */
  windowDrags = 0

  /** The record of calls made with sound and the dock — this one has to ring even if the banner is dead */
  alerts: { kind: AlertKind; sound: boolean }[] = []

  /** Public so tests can look inside */
  workspaceSnapshot: WorkspaceSnapshot | null = null

  /**
   * The snapshot also survives a reload through localStorage when the page has one
   * (issue #20). The real host keeps it on disk, so "the arrangement survives a
   * relaunch" is only testable against this mock if the mock's snapshot outlives the
   * page too. Unit tests run in node, where touching `localStorage` throws — the
   * try/catch keeps the in-memory field serving them alone, exactly as before.
   */
  readonly workspace = {
    save: async (s: WorkspaceSnapshot) => {
      this.workspaceSnapshot = s
      try {
        localStorage.setItem('cc-mock-workspace', JSON.stringify(s))
      } catch {
        /* node, or storage denied — the in-memory copy still works */
      }
    },
    load: async (): Promise<WorkspaceSnapshot | null> => {
      if (this.workspaceSnapshot) return this.workspaceSnapshot
      try {
        const raw = localStorage.getItem('cc-mock-workspace')
        return raw ? (JSON.parse(raw) as WorkspaceSnapshot) : null
      } catch {
        return null
      }
    },
  }

  /** Public so tests can look inside — and set it up without going through the port */
  uiPrefs: UiPreferences = parseUiPreferences(undefined)

  /**
   * Screen preferences (UiPreferences).
   *
   * Also kept in localStorage, for the same reason as the snapshot: the real thing keeps it
   * in a DB, so "the chosen values survive a restart" is this app's promise, and if the mock
   * died before the page did, a test running in a browser could never see that promise at
   * all. localStorage throws in node, so it just falls out of the try/catch and the
   * in-memory copy answers as it always did.
   */
  readonly prefs: PreferencesPort = {
    load: async () => {
      try {
        const raw = localStorage.getItem('cc-mock-prefs')
        if (raw) this.uiPrefs = parseUiPreferences(JSON.parse(raw))
      } catch {
        /* node, or storage denied — the in-memory copy still works */
      }
      return { ...this.uiPrefs }
    },
    // The same rule as the real thing: leaves an unwritten field untouched, and returns the whole thing after it was recorded
    save: async (patch: UiPreferencesPatch) => {
      this.uiPrefs = { ...this.uiPrefs, ...patch }
      try {
        localStorage.setItem('cc-mock-prefs', JSON.stringify(this.uiPrefs))
      } catch {
        /* node, or storage denied — the in-memory copy still works */
      }
      return { ...this.uiPrefs }
    },
  }

  /**
   * For tests: the version the registry pretends to hold as `latest` (issue #43).
   * Null means it could not be reached — different from "this is the latest version."
   */
  registryVersion: string | null = null

  /** For tests: `npm i -g` fails (it is never actually run) */
  updateFails: string | null = null

  private updateStatus: UpdateStatus = {
    current: APP_VERSION,
    latest: null,
    newer: false,
    auto: true,
    phase: 'idle',
    error: null,
    checkedAt: null,
  }

  /**
   * App updates (issue #43).
   *
   * **Follows the same rules as the real thing.** Two in particular: the comparison uses
   * protocol's own (`isNewerVersion` — if the mock made up its own rule, a split between the
   * two would be invisible), and installing responds **before it finishes** and sends the rest
   * as events. It is also part of the contract here that `npm i -g` is not merely faked but
   * never actually run at all — a test must never touch the machine.
   */
  readonly updates: UpdatePort = {
    status: async (force = false) => {
      // Same as the real thing: if automatic checking is off, it asks nowhere until the person clicks
      if (!force && !this.updateStatus.auto) return { ...this.updateStatus }
      if (!force && this.updateStatus.checkedAt !== null) return { ...this.updateStatus }
      if (this.updateStatus.phase === 'updating' || this.updateStatus.phase === 'restart_required') {
        return { ...this.updateStatus }
      }
      return this.runUpdateCheck()
    },
    setAuto: async (enabled: boolean) => {
      if (this.updateStatus.auto === enabled) return { ...this.updateStatus }
      this.setUpdateStatus({ auto: enabled })
      // Someone who just turned it on is asking right now — not six hours from now
      return enabled ? this.runUpdateCheck() : { ...this.updateStatus }
    },
    apply: async () => {
      if (this.updateStatus.phase === 'updating') return { ...this.updateStatus }
      const latest = this.updateStatus.latest
      if (!this.updateStatus.newer || !latest) {
        this.setUpdateStatus({ phase: 'failed', error: 'There is no newer version to install' })
        return { ...this.updateStatus }
      }
      this.setUpdateStatus({ phase: 'updating', error: null })
      /*
       * The end is announced **after** the response is given. Installing routinely exceeds
       * the RPC timeout, and the real thing behaves the same way, so "installing → please
       * restart" only ever arrives as an event.
       */
      setTimeout(() => {
        if (this.updateFails) this.setUpdateStatus({ phase: 'failed', error: this.updateFails })
        else this.setUpdateStatus({ phase: 'restart_required', error: null })
      }, 0)
      return { ...this.updateStatus }
    },
  }

  private runUpdateCheck(): UpdateStatus {
    if (this.registryVersion === null) {
      // Could not reach it — leaves what was found out last time untouched (the same rule as the real thing)
      this.setUpdateStatus({ phase: 'idle', error: 'Could not reach the registry — check the network' })
      return { ...this.updateStatus }
    }
    this.setUpdateStatus({
      latest: this.registryVersion,
      newer: isNewerVersion(this.registryVersion, this.updateStatus.current),
      phase: 'idle',
      error: null,
      checkedAt: this.now(),
    })
    return { ...this.updateStatus }
  }

  private setUpdateStatus(patch: Partial<UpdateStatus>): void {
    this.updateStatus = { ...this.updateStatus, ...patch }
    this.emit({ type: 'update_status', status: { ...this.updateStatus } })
  }

  /** Scenario helper: makes it as if the registry got a new version (used from Playwright) */
  offerUpdate(version: string): void {
    this.registryVersion = version
    this.runUpdateCheck()
  }

  async dispose(): Promise<void> {
    this.handlers.clear()
    this.connHandlers.clear()
  }

  /** Scenario helper: creates an approval request (used from Playwright) */
  requestApproval(sessionId: string, detail: ApprovalDetail, requestId = `req-${++this.idc}`): string {
    this.emit({ type: 'approval_request', sessionId, requestId, detail })
    return requestId
  }
}

export function createMockPlatform(opts?: MockOptions): MockPlatform {
  return new MockPlatform(opts)
}
