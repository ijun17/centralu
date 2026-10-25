import type { Attachment, PermissionPreset, CreateSessionParams, SessionInfo, MessageImage, ToolName } from '@cc/protocol'
import { DEFAULT_AUTO_COMPACT, isRecord, oneLineText, sessionLiveDefaults, SUBAGENT_STEPS_PAGE, wireSegments } from '@cc/protocol'
import type { AgentPort, SendIntent } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'
import type { ExternalSessionsMock } from './external-sessions.js'
import type { TrashMock } from './trash.js'
import { putInOrder } from './projects.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** A name coined from a person's words, as the host cuts it (`truncate`, external-conversations.ts): one line, 40 characters (#999) */
const autoName = (text: string) => oneLineText(text, 40)

/**
 * Whether git would take `name` as a branch (`git check-ref-format --branch`), which the host asks git itself
 * (`gitValidBranchName`). The rules git applies to a branch name, written out for the mock that has no git.
 */
export function validBranchName(name: string): boolean {
  if (!name || name === '@' || name.startsWith('-')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  return wireSegments(name).every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** The session port's everyday operations: creating, sending, settings, resuming, listing and reading */
export class SessionsMock {
  /** For tests: sessions to make unresumable */
  readonly unresumable = new Set<string>()
  readonly savedAttachments: Attachment[] = []
  readonly sentAttachments: Attachment[] = []
  /** For tests: every message sent, with the choice it carried for a report the session owes (#1377) */
  readonly sentIntents: { sessionId: string; text: string; intent: SendIntent | undefined }[] = []
  /** For tests and the demo: sessions that owe a delegation report, and to whom (#1377) */
  readonly reportsOwed = new Map<string, { callerId: string; callerName: string }>()
  /** The mock's disk is memory — this is where the bytes the real thing re-reads from an attachments/ file are recovered from */
  readonly attachmentData = new Map<string, string>()
  /** For tests: sessions asked to restart */
  restarted: string[] = []

  /** For tests: the last createSession parameters (to check the chosen values were actually delivered) */
  lastCreateParams: CreateSessionParams | null = null
  /** For tests: every createSession parameter — if two are born at once, "the last one" cannot tell who got what */
  readonly createParamsLog: CreateSessionParams[] = []
  /** The handle that lets a test create "a worktree with uncommitted changes" */
  mockWorktreeDirty = false
  /**
   * For tests: what `messages.image` answers, by the path the reply wrote. A path not here is "not found", as on a host
   * whose disk does not have it; whether a reply names it is the host's to check (agent-host message-image tests).
   */
  readonly messageImages = new Map<string, MessageImage>()
  readonly messageImageCalls: { sessionId: string; path: string }[] = []
  /** Every `resumeSession` call, by session (#568: selecting or viewing a session does not wake it) */
  resumeCalls: string[] = []
  /** How long a wake takes, so the screen's "waking" state can be seen (#568); 0 by default */
  wakeDelayMs = 0
  /** Wakes a sleeping session the way the host does (#568): after the resume, `live` and its event */
  private async wakeUp(sessionId: string): Promise<void> {
    if (this.wakeDelayMs > 0) await new Promise((r) => setTimeout(r, this.wakeDelayMs))
    const s = this.store.sessions.get(sessionId)
    if (!s || s.live) return
    s.live = true
    this.emit({ type: 'session_live', sessionId, live: true })
  }
  readonly agents: Pick<AgentPort, 'createSession' | 'saveAttachment' | 'send' | 'reportOwed' | 'reorderSessions' | 'switchTool' | 'worktreeStatus' | 'autoCompact' | 'deleteSession' | 'archiveIfAtRest' | 'updateSettings' | 'restartSession' | 'resumeSession' | 'forkConversation' | 'rename' | 'markRead' | 'listSessions' | 'loadMessages' | 'messageImage' | 'loadSubagentMessages' | 'subagentTrashed'> = {
    createSession: async (params: CreateSessionParams) => {
      this.lastCreateParams = params
      this.createParamsLog.push(params)
      if (params.worktree) this.checkWorktree(params)
      const id = `mock-session-${this.clock.next()}`
      const worktree = params.worktree
        ? {
            path: `/mock/worktrees/${id}`,
            branch: params.worktreeBranch?.trim() || `centralu/${id.slice(-8)}`,
          }
        : null
      /*
       * The same rule as the real thing (#561 part 3): a worktree session the person makes stands on its own; the
       * worktree manager it used to hang under was folded into ordinary sessions.
       */
      const parentSessionId: string | null = null
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
          (params.initialPrompt ? autoName(params.initialPrompt) : undefined) ??
          worktree?.branch ??
          'New session',
        autoNamed: !params.worktreeBranch?.trim(),
        state: 'idle',
        lastReadSeq: 0,
        lastSeq: 0,
        createdAt: this.clock.now(),
        waitingSince: null,
        live: true,
        model: params.model ?? null,
        permissionPreset: params.permissionPreset ?? 'normal',
        importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
        ...sessionLiveDefaults(),
      }
      if (params.resumeExternalId) info.externalId = params.resumeExternalId
      this.store.sessions.set(id, info)
      // The same rule as the real thing: the last tool chosen becomes that project's default (manager.createSession)
      const owner = this.projectStore.list.find((p) => p.id === params.projectId)
      if (owner && owner.defaultTool !== params.tool) {
        owner.defaultTool = params.tool
        // Every window's project shows its default, as the host tells them (session-start.ts)
        this.emit({ type: 'projects_changed' })
      }
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
        const history = this.externalSessionsMock.externalHistory.get(params.resumeExternalId) ?? []
        for (const h of history) {
          const seq = (this.store.messages.get(id)?.length ?? 0) + 1
          this.store.pushMessage({
            sessionId: id,
            seq,
            role: h.role,
            kind: 'text',
            payload: { text: h.text },
            ts: this.clock.now(),
          })
          info.lastSeq = seq
          info.lastReadSeq = seq
        }
        const firstUser = history.find((h) => h.role === 'user')
        const listed = this.externalSessionsMock.externalSessions.sessions.find((s) => s.externalId === params.resumeExternalId)
        if (listed) info.name = listed.title
        else if (firstUser) info.name = autoName(firstUser.text)
      }
      /*
       * The same rule as the real thing (#102): an inherited note is not kept as the first
       * message but as a **marker**. If the mock skips this, "the note survives even if the
       * file is lost" becomes a contract that only holds on screen.
       */
      if (params.handoff) {
        const seq = (this.store.messages.get(id)?.length ?? 0) + 1
        const { from, note } = params.handoff
        this.store.pushMessage({
          sessionId: id,
          seq,
          role: 'system',
          kind: 'marker',
          payload: { type: 'handoff', sessionId: id, seq, from, note },
          ts: this.clock.now(),
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
        this.emit({ type: 'user_message', sessionId: id, seq: (this.store.messages.get(id)?.length ?? 0) + 1, text: params.initialPrompt })
        info.lastReadSeq = info.lastSeq
        if (info.autoNamed && info.name === 'New session') {
          info.name = autoName(params.initialPrompt)
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
    reportOwed: async (sessionId: string) => this.reportsOwed.get(sessionId) ?? null,
    send: async (sessionId: string, text: string, attachments?: Attachment[], intent?: SendIntent) => {
      if (attachments?.length) this.sentAttachments.push(...attachments)
      this.sentIntents.push({ sessionId, text, intent })
      // As the host: taking the session over closes the report it owed
      if (intent === 'takeover') this.reportsOwed.delete(sessionId)
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
      // The same rule as the host: if it is asleep, revive it and then send (automatic resume)
      if (!s.live) {
        if (this.unresumable.has(sessionId)) {
          throw mockError('Could not resume the conversation: this session cannot be resumed', 'session_not_found')
        }
        await this.wakeUp(sessionId)
      }
      const seq = (this.store.messages.get(sessionId)?.length ?? 0) + 1
      if (s.autoNamed && s.name === 'New session') {
        s.name = autoName(text)
        this.emit({ type: 'session_title', sessionId, title: s.name, auto: true })
      }
      /*
       * The same rule as the real thing (manager.send, #999): the message is recorded and announced as `user_message`,
       * attachments riding along, so every window (and the store's handling of the event) sees it. `emit` records it.
       */
      this.emit({ type: 'user_message', sessionId, seq, text, ...(attachments?.length ? { attachments } : {}) })
      // Attachments also stay in the payload, and image bytes are re-loaded from "disk" (a map, here), as loadMessages does
      const row = this.store.messages.get(sessionId)?.at(-1)
      if (row && attachments?.length) {
        const stored = attachments.map((a) => (a.kind === 'image' && this.attachmentData.has(a.path) ? { ...a, data: this.attachmentData.get(a.path) } : a))
        row.payload = { ...(isRecord(row.payload) ? row.payload : {}), attachments: stored }
      }
      s.lastReadSeq = s.lastSeq
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    /*
     * The same rule as the real thing (manager.reorderSessions, #999): the order is one across projects, so only the
     * slots this project's sessions hold take the new order, and every other session stays where it was. A session
     * missing from the list stays at the end of this project's, as it was.
     */
    reorderSessions: async (projectId: string, orderedIds: string[]) => {
      const all = [...this.store.sessions.values()]
      const mine = putInOrder(all.filter((s) => s.projectId === projectId), orderedIds)
      let k = 0
      const next = all.map((s) => (s.projectId === projectId ? (mine[k++] ?? s) : s))
      this.store.sessions = new Map(next.map((s) => [s.id, s] as const))
      return next.map((s) => ({ ...s }))
    },
    switchTool: async (sessionId: string, tool: ToolName) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
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
      this.store.sessions.set(sessionId, next)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'tool_changed' })
      return next
    },
    // The mock keeps no model windows or preferences: the default setting, and a session with a context reading counts as read
    autoCompact: async (sessionId: string) => {
      const c = DEFAULT_AUTO_COMPACT
      const window = this.store.sessions.get(sessionId)?.context?.window ?? null
      return { controlled: c.controlled, share: c.share, tokens: c.controlled && window ? Math.round(window * c.share) : null }
    },
    /** Fakes a worktree in the mock too — the UI needs to be able to test "ask, then delete" */
    worktreeStatus: async (sessionId: string) => {
      const s = this.store.sessions.get(sessionId)
      if (!s?.worktree) return null
      return { ...s.worktree, dirty: this.mockWorktreeDirty, changedFiles: this.mockWorktreeDirty ? 2 : 0 }
    },
    // Moves it to the session archive (#204) — the tool's file and the worktree wait there until it is deleted for good
    deleteSession: async (sessionId: string, deleteWorktree = false, deleteExternal = false) => {
      // Already in the session archive, or never here: the host says it is gone anyway, so a screen holding a stale row lets go (#999)
      if (!this.store.sessions.has(sessionId)) return this.emit({ type: 'session_deleted', sessionId })
      this.trashMock.moveToTrash(sessionId, deleteWorktree, deleteExternal)
    },
    // The host's own rule is not in the mock: a session an agent started stands for "something it holds would be lost" (#1512)
    archiveIfAtRest: async (sessionId: string, deleteExternal = false) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) return { archived: false as const, asks: [] }
      if (s.askedBy) return { archived: false as const, asks: ['A session it started owes it a report; it will not be told, and the report is dropped.'] }
      this.trashMock.moveToTrash(sessionId, false, deleteExternal)
      return { archived: true as const }
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
      const sess = this.store.sessions.get(sessionId)
      if (!sess) throw mockError('Session not found', 'session_not_found')
      if (s.model !== undefined) sess.model = s.model
      if (s.effort !== undefined) sess.effort = s.effort
      if (s.verbosity !== undefined) sess.verbosity = s.verbosity
      if (s.serviceTier !== undefined) sess.serviceTier = s.serviceTier
      if (s.permissionPreset) sess.permissionPreset = s.permissionPreset
      /*
       * The same rule as the real thing (manager.updateSettings, #69, #107, #719, #999): the model and effort chosen last
       * become the project's default under this session's tool, and another window hears of it when they changed.
       */
      const at = sess.projectId ? this.projectStore.list.findIndex((p) => p.id === sess.projectId) : -1
      const owner = at === -1 ? undefined : this.projectStore.list[at]
      if ((s.model !== undefined || s.effort !== undefined) && owner) {
        const before = owner.defaultModels[sess.tool]
        // A new object, as setTrusted swaps one in: the screen may hold the one `add` returned, and must learn of this only from the event
        this.projectStore.list[at] = { ...owner, defaultModels: { ...owner.defaultModels, [sess.tool]: { model: sess.model, effort: sess.effort } } }
        if ((before?.model ?? null) !== (sess.model || null) || (before?.effort ?? null) !== (sess.effort || null)) this.emit({ type: 'projects_changed' })
      }
      // The same rule as the real thing (#659): every client hears about a saved change, the caller included
      this.emit({
        type: 'settings_changed',
        sessionId,
        model: sess.model,
        effort: sess.effort,
        verbosity: sess.verbosity,
        serviceTier: sess.serviceTier,
        permissionPreset: sess.permissionPreset,
        person: true,
      })
      return { ...sess }
    },
    restartSession: async (sessionId: string) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
      this.restarted.push(sessionId)
      if (this.unresumable.has(sessionId)) {
        return { session: { ...s }, resumed: false, reason: 'This session cannot be resumed' }
      }
      s.live = true
      return { session: { ...s }, resumed: true }
    },
    resumeSession: async (sessionId: string) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
      this.resumeCalls.push(sessionId)
      if (this.unresumable.has(sessionId)) {
        return { session: { ...s }, resumed: false, reason: 'This session cannot be resumed' }
      }
      if (!s.live) await this.wakeUp(sessionId)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: { ...s }, resumed: true }
    },
    /** Forks off a locked conversation — pointing at a copy makes it the same as if the lock had come off */
    forkConversation: async (sessionId: string) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
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
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError(`Session not found: ${sessionId}`, 'session_not_found')
      // One line, as the host keeps a name (manager.rename, #838)
      const next = oneLineText(name)
      if (!next) throw mockError('Session name cannot be empty')
      s.name = next
      s.autoNamed = false
      this.emit({ type: 'session_title', sessionId, title: next, auto: false })
    },
    markRead: async (sessionId: string, seq: number) => {
      const s = this.store.sessions.get(sessionId)
      if (s) s.lastReadSeq = Math.max(s.lastReadSeq, seq)
    },
    listSessions: async () => [...this.store.sessions.values()].map((s) => ({ ...s })),
    loadMessages: async (sessionId: string, limit = 200, beforeSeq?: number) => {
      const all = this.store.messages.get(sessionId) ?? []
      const filtered = beforeSeq ? all.filter((m) => m.seq < beforeSeq) : all
      return filtered.slice(-limit)
    },
    messageImage: async (sessionId: string, path: string): Promise<MessageImage> => {
      this.messageImageCalls.push({ sessionId, path })
      return this.messageImages.get(path) ?? { ok: false, reason: 'not_found', message: `There is no file at ${path}` }
    },
    loadSubagentMessages: async (sessionId: string, parentCallId: string, afterSeq = 0, limit = SUBAGENT_STEPS_PAGE) => {
      this.store.subagentReads += 1
      const key = `${sessionId} ${parentCallId}`
      const all = this.store.subagentMessages.get(key) ?? []
      // Steps in the session archive (#418) are not read under their card
      return all.filter((m) => m.seq > afterSeq && !this.store.subagentTrashedAt.has(`${key} ${m.seq}`)).slice(0, limit)
    },
    subagentTrashed: async (sessionId: string, parentCallId: string) => {
      const key = `${sessionId} ${parentCallId}`
      const all = this.store.subagentMessages.get(key) ?? []
      return { steps: all.filter((m) => this.store.subagentTrashedAt.has(`${key} ${m.seq}`)).length }
    },
  }

  /**
   * The host's refusals for a worktree session, in its order and words (worktree-sessions.ts createWorktree, #999):
   * the project has to be a repository git can read, trusted (checking out runs the repository's hooks and filters,
   * #407), and the branch asked for has to be one git takes.
   */
  private checkWorktree(params: CreateSessionParams): void {
    const p = this.projectStore.list.find((x) => x.id === params.projectId)
    const refuse = (message: string) => mockError(message)
    if (!p?.git?.isRepo || p.git.denied) {
      throw refuse(p?.git?.denied ? 'Cannot read this git repository — grant folder access and try again' : 'Worktrees need a git repository. This directory is not one.')
    }
    if (!p.trusted) {
      throw refuse("Worktree sessions need a trusted project: checking out runs the repository's hooks and filters. Trust the project first.")
    }
    const requested = params.worktreeBranch?.trim()
    if (requested && !validBranchName(requested)) throw refuse(`Not a valid branch name: ${requested}`)
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly store: SessionStore,
    private readonly projectStore: ProjectStore,
    private readonly externalSessionsMock: ExternalSessionsMock,
    private readonly trashMock: TrashMock,
  ) {}
}
