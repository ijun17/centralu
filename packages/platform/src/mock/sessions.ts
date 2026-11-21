import type { Attachment, PermissionPreset, CreateSessionParams, SessionInfo, MessageImage, ToolName } from '@cc/protocol/client'
import { DEFAULT_AUTO_COMPACT, isRecord, oneLineText, SUBAGENT_STEPS_PAGE, wireSegments } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import { mockSessionInfo } from './session-info.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'
import type { ExternalSessionsMock } from './external-sessions.js'
import type { TrashMock } from './trash.js'
import { putInOrder } from './projects.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** A name cut from a person's words as the host cuts it (`truncate`, external-conversations.ts, #999) */
const autoName = (text: string) => oneLineText(text, 40)
/** What the mock host says an archive would lose for a session an agent started: it owes that agent a report (#1512) */
const MOCK_LOSS = 'A session it started owes it a report; it will not be told, and the report is dropped.'

/** `git check-ref-format --branch`'s rules, which the host asks git itself (`gitValidBranchName`) */
function validBranchName(name: string): boolean {
  if (!name || name === '@' || name.startsWith('-')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  return wireSegments(name).every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** The session port's everyday operations: creating, sending, settings, resuming, listing and reading */
export class SessionsMock {
  readonly unresumable = new Set<string>()
  readonly savedAttachments: Attachment[] = []
  readonly sentAttachments: Attachment[] = []
  /** The bytes the host re-reads from an attachments/ file; the mock's disk is memory */
  readonly attachmentData = new Map<string, string>()
  restarted: string[] = []

  lastCreateParams: CreateSessionParams | null = null
  /** Every call: when two are born at once, "the last one" cannot tell who got what */
  readonly createParamsLog: CreateSessionParams[] = []
  mockWorktreeDirty = false
  /**
   * By the path the reply wrote; a path not here is "not found". Whether a reply names it is the host's check
   * (agent-host message-image tests).
   */
  readonly messageImages = new Map<string, MessageImage>()
  readonly messageImageCalls: { sessionId: string; path: string }[] = []
  /** Selecting or viewing a session does not wake it (#568) */
  resumeCalls: string[] = []
  /** So the screen's "waking" state can be seen (#568) */
  wakeDelayMs = 0
  /** As the host (#568): `live` and its event after the resume */
  private async wakeUp(sessionId: string): Promise<void> {
    if (this.wakeDelayMs > 0) await new Promise((r) => setTimeout(r, this.wakeDelayMs))
    const s = this.store.sessions.get(sessionId)
    if (!s || s.live) return
    s.live = true
    this.emit({ type: 'session_live', sessionId, live: true })
  }
  readonly agents: Pick<AgentPort, 'createSession' | 'saveAttachment' | 'send' | 'reorderSessions' | 'switchTool' | 'worktreeStatus' | 'autoCompact' | 'deleteSession' | 'archiveIfAtRest' | 'archiveLosses' | 'updateSettings' | 'restartSession' | 'resumeSession' | 'forkConversation' | 'rename' | 'markRead' | 'clearError' | 'stopContinue' | 'listSessions' | 'loadMessages' | 'messageImage' | 'loadSubagentMessages' | 'subagentTrashed'> = {
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
      // As the host (#561): a worktree session the person makes has no parent
      const parentSessionId: string | null = null
      const info: SessionInfo = mockSessionInfo({
        id,
        projectId: params.projectId,
        tool: params.tool,
        externalId: `ext-${id}`,
        worktree,
        parentSessionId,
        effort: params.effort ?? null,
        verbosity: params.verbosity ?? null,
        serviceTier: params.serviceTier ?? null,
        /*
         * As the host (#69): a branch name the person set is the name, kept from the automatic one. Else it starts as
         * the automatic branch: with a fixed 'New session' the worktree panel cannot tell its rows apart.
         */
        name:
          (params.worktreeBranch?.trim() || undefined) ??
          (params.initialPrompt ? autoName(params.initialPrompt) : undefined) ??
          worktree?.branch ??
          'New session',
        autoNamed: !params.worktreeBranch?.trim(),
        createdAt: this.clock.now(),
        model: params.model ?? null,
        permissionPreset: params.permissionPreset ?? 'normal',
        importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
      })
      if (params.resumeExternalId) info.externalId = params.resumeExternalId
      this.store.sessions.set(id, info)
      // As session-start.ts `personsPick`: the tool picked becomes the project's default
      const owner = this.projectStore.list.find((p) => p.id === params.projectId)
      if (owner && owner.defaultTool !== params.tool) {
        owner.defaultTool = params.tool
        // Every window's project shows its default, as the host tells them (session-start.ts)
        this.emit({ type: 'projects_changed' })
      }
      /*
       * The host's order (#172): `session_created`, the handoff marker and the first prompt, then the response.
       * Otherwise early events replay after the response and hide, on the mock only, a response overwriting the screen.
       */
      this.emit({ type: 'session_created', sessionId: id, session: structuredClone(info) })
      // As the host's importHistory: the previous conversation comes back already read
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
      // As the host (#102): an inherited note is a marker, not the first message, so it survives a lost file
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
        // As the host (#172): the first prompt goes out as `user_message` before the response; emit records it
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
    send: async (sessionId: string, text: string, attachments?: Attachment[]) => {
      if (attachments?.length) this.sentAttachments.push(...attachments)
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
      // As the host: a sleeping session is woken, then sent to
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
      // As manager.send (#999): `user_message` with its attachments, so every window sees it; emit records it
      this.emit({ type: 'user_message', sessionId, seq, text, ...(attachments?.length ? { attachments } : {}) })
      // Attachments stay in the payload with image bytes from "disk" (a map here), as loadMessages gives them
      const row = this.store.messages.get(sessionId)?.at(-1)
      if (row && attachments?.length) {
        const stored = attachments.map((a) => (a.kind === 'image' && this.attachmentData.has(a.path) ? { ...a, data: this.attachmentData.get(a.path) } : a))
        row.payload = { ...(isRecord(row.payload) ? row.payload : {}), attachments: stored }
      }
      s.lastReadSeq = s.lastSeq
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    /*
     * As SessionLayout.reorderSessions (#999): one order across projects, so only this project's slots take the new
     * order; a session missing from the list stays at the end of this project's.
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
       * As manager.switchTool: the thread to resume and the model with its settings go (measured: 'sonnet' kept on
       * codex fails the first turn with a 400). The worktree belongs to the directory and stays.
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
    // No model windows or preferences in the mock: the default, sized by the session's context reading
    autoCompact: async (sessionId: string) => {
      const c = DEFAULT_AUTO_COMPACT
      const window = this.store.sessions.get(sessionId)?.context?.window ?? null
      return { controlled: c.controlled, share: c.share, tokens: c.controlled && window ? Math.round(window * c.share) : null }
    },
    /** A fake worktree, so the UI's "ask, then delete" can be tested */
    worktreeStatus: async (sessionId: string) => {
      const s = this.store.sessions.get(sessionId)
      if (!s?.worktree) return null
      return { ...s.worktree, dirty: this.mockWorktreeDirty, changedFiles: this.mockWorktreeDirty ? 2 : 0 }
    },
    // Moves it to the session archive (#204) — the tool's file and the worktree wait there until it is deleted for good
    deleteSession: async (sessionId: string, deleteWorktree = false, deleteExternal = false) => {
      // Archived or never here: the host says it is gone anyway, so a stale row lets go (#999)
      if (!this.store.sessions.has(sessionId)) return this.emit({ type: 'session_deleted', sessionId })
      this.trashMock.moveToTrash(sessionId, deleteWorktree, deleteExternal)
    },
    // Not the host's rule: a session an agent started stands for "something it holds would be lost" (#1512)
    archiveIfAtRest: async (sessionId: string, deleteExternal = false) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) return { archived: false as const, asks: [] }
      if (s.askedBy) return { archived: false as const, asks: [MOCK_LOSS] }
      this.trashMock.moveToTrash(sessionId, false, deleteExternal)
      return { archived: true as const }
    },
    // Read only, by the same rule (#1595)
    archiveLosses: async (sessionId: string) => (this.store.sessions.get(sessionId)?.askedBy ? [MOCK_LOSS] : []),
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
      // As manager.updateSettings (#69, #107, #719, #999): the last model and effort become the tool's project default
      const at = sess.projectId ? this.projectStore.list.findIndex((p) => p.id === sess.projectId) : -1
      const owner = at === -1 ? undefined : this.projectStore.list[at]
      if ((s.model !== undefined || s.effort !== undefined) && owner) {
        const before = owner.defaultModels[sess.tool]
        // A new object, as in setTrusted: the screen learns of it only from the event
        this.projectStore.list[at] = { ...owner, defaultModels: { ...owner.defaultModels, [sess.tool]: { model: sess.model, effort: sess.effort } } }
        if ((before?.model ?? null) !== (sess.model || null) || (before?.effort ?? null) !== (sess.effort || null)) this.emit({ type: 'projects_changed' })
      }
      // As the host (#659): every client hears of a saved change, the caller included
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
    // As manager.rename: a failure is reported, so "renamed, but the list stayed" shows on the mock too
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
    stopContinue: async (sessionId: string) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw new Error(`No session ${sessionId}`)
      const i = s.interruption
      if (!i?.autoContinue) return { stopped: false }
      const { autoContinue: _, ...stop } = i
      s.interruption = stop
      this.emit({ type: 'interruption', sessionId, interruption: stop })
      return { stopped: true }
    },
    clearError: async (sessionId: string, seq: number) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw new Error(`No session ${sessionId}`)
      s.lastReadSeq = Math.max(s.lastReadSeq, seq)
      const newer = s.state === 'error' && s.lastSeq > seq
      if (s.state !== 'error' || newer) return { cleared: false, newer }
      s.state = 'idle'
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'error_cleared' })
      return { cleared: true, newer: false }
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
   * The host's refusals in its order and words (worktree-sessions.ts createWorktree, #999). Trust is required because
   * checking out runs the repository's hooks and filters (#407).
   */
  private checkWorktree(params: CreateSessionParams): void {
    const p = this.projectStore.list.find((x) => x.id === params.projectId)
    const refuse = (message: string) => mockError(message)
    if (!p?.git?.isRepo || p.git.denied) {
      throw refuse(p?.git?.denied ? 'Cannot read this git repository — grant folder access and try again' : 'Worktrees need a git repository. This directory is not one.')
    }
    if (!p.trusted) {
      throw refuse(`Project "${p.name}" is not trusted, so checking out a worktree is refused — trust it from the project menu.`)
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
