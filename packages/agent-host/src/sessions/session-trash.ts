import { restoreWorktreeRecovery, stageWorktreeRecoveryRemoval, worktreeRecoveryBytes, type WorktreeRecovery } from '../dev-services/worktree-recovery.js'
import type { ChildOwnership } from './child-ownership.js'
import type { SessionAppsHub } from './session-apps.js'
import type { AgentRunWait } from './app-agents.js'
import { basename } from 'node:path'
import { rm } from 'node:fs/promises'
import { isOrchestratorAgentFolder } from './orchestrator-home.js'
import { plainQuoted } from './tool-answers.js'
import { existsSync, statSync } from 'node:fs'
import {
  isInTurn,
  type NormalizedEvent,
  type PermissionPreset,
  type ProjectInfo,
  type SessionInfo,
  type StoredMessage,
  type TrashedRun,
  type SubagentStepsHeld,
  type TrashedSession,
  type TrashedSubagentSteps,
  type ToolName,
} from '@cc/protocol'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import { gitWorktreeRemove } from '../dev-services/git-worktree.js'
import { attachmentBytes, clearAttachments } from '../dev-services/attachments.js'
import { withHubMark } from './hub-preset.js'
import { handoffNoteBytes } from '../dev-services/handoff-notes.js'
import { codeIntelligenceKey } from './tool-profiles.js'
import { type DelegationFlow, agentStartPersonText } from './delegation-flow.js'
import type { RestartPolicy } from './restart-policy.js'
import type { WorktreeSessions } from './worktree-sessions.js'
import type { HostCards } from './host-cards.js'
import type { SessionRecord } from './session-record.js'
import { rpcError } from '../rpc-error.js'
import type { SubagentStepsRow } from '../dev-services/store/subagent-steps.js'

/**
 * What the trash reaches of the session manager (#428), typed as the manager declares each member. The manager builds
 * it with getters for its fields, so each is read when used, never kept; `quitNotices`, which a deletion filters, is
 * written back through a setter.
 */
export type SessionTrashHost = {
  readonly adapters: Map<string, AgentAdapter>
  readonly agentRuns: Map<string, AgentRunWait>
  readonly appsHub: SessionAppsHub | null
  readonly children: ChildOwnership
  readonly delegationFlow: DelegationFlow
  readonly emit: (e: NormalizedEvent) => void
  forgetCommits: (sessionId: string) => void
  /** The rest a card of it was raised in, if one is remembered (`CardRests`) */
  forgetCardRest: (sessionId: string) => void
  /** Notices kept for it because it could not be woken (#1186) */
  forgetHeldNotices: (sessionId: string) => void
  gitTrust: (projectId: string | null) => { trusted: boolean; }
  readonly handles: Map<string, SessionHandle>
  handoffHeir: (sessionId: string) => string | null
  readonly hostCards: HostCards
  loadMessages: (sessionId: string, limit: number, beforeSeq?: number) => Promise<StoredMessage[]>
  readonly meta: Map<string, SessionInfo>
  moveChildren: (from: string, to: string, scope: 'live' | 'all' | 'removed') => unknown
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  readonly prCheckedAt: Map<string, number>
  projectInfo: (id: string, path: string) => Promise<ProjectInfo>
  quitNotices: { sessionId: string; requester: string; swapped?: true }[]
  readonly readGrants: Map<string, Set<string>>
  readonly record: SessionRecord
  readonly recoveryRepair: Promise<void>
  readonly restartPolicy: RestartPolicy
  /** A wake or a resume under way (`SessionManager.resuming`): the session is about to take a turn */
  readonly resuming: ReadonlyMap<string, unknown>
  /** A queued note not yet taken by the session (`SessionManager.inputsHeld`) */
  inputsHeld: (sessionId: string) => boolean
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  stopWatchingReconnect: (sessionId: string) => void
  readonly store: Store
  sweepOrphanHandoffNotes: (projectId?: string) => Promise<void>
  readonly turnObservers: Map<string, Set<AgentRunWait>>
  untilWakeWithdrawn: (sessionId: string, why: string) => Promise<void>
  readonly updateApplyConsents: Set<string>
  readonly updateConsents: Set<string>
  readonly worktrees: WorktreeSessions
}

/**
 * A session's way to the trash and back (#428): deleting it once even when asked twice, with what it held let go;
 * listing and reading the trash; restoring a session; purging one or all, with a worktree's recovery folder. Moved out
 * of the session manager as it was; what it reaches of the manager is `SessionTrashHost`.
 */
export class SessionTrash {
  constructor(private readonly host: SessionTrashHost) {}

  readonly trashing = new Map<string, Promise<void>>()
  /**
   * The host's own deletes under way (`trashIf`), and whether a delete somebody asked for joined one (#378 review): a
   * joined delete is the person's, so the session stays in the trash instead of being purged after it, and the tool's
   * conversation file stays unless they asked for it to go
   */
  private readonly hostDeletes = new Map<string, { joined: { removeExternal: boolean } | null }>()

  /**
   * Moves a session to the trash (#204) — what deleting a session means now. Nothing is destroyed: the process
   * stops, and the session leaves every list (sidebar, inbox, palette, grid, search, the agents' session tools and
   * the apps' `sessions.list`, all of which read `meta` or filter the trash in the store). Its rows, attachments,
   * handoff note, the tool's conversation file and its worktree stay until the person deletes it for good in
   * Settings (`purgeSession`).
   *
   * @param removeWorktree remove the worktree **when it is purged**. The default is to keep it — hours
   * of an agent's work can be sitting there. It stays registered with git and in place while the session is
   * in the trash:
   * moving a worktree folder leaves git's record pointing at nothing (`git worktree list` calls it prunable, and
   * `git worktree prune` or a `gc` then drops it), and Claude files a conversation by its working directory, so the
   * restored session would not find its own history either.
   * @param removeExternal delete the tool's conversation file **when it is purged**. It stays where the tool keeps
   * it while the session is in the trash: the file is the tool's, in the tool's layout, and only the tool's own
   * delete knows that layout (the Claude SDK's `deleteSession`). Left in place it is also a second way back — the
   * tool, and **+ → Past conversations**, still have it.
   */
  async trashSession(sessionId: string, removeWorktree = false, removeExternal = false, recovery?: WorktreeRecovery, fromCleanup = false): Promise<void> {
    await this.trashShared(sessionId, removeWorktree, removeExternal, recovery, fromCleanup)
  }

  /**
   * A delete the host makes on its own (#378: a finished app-agent session), moved to the trash only if `onlyIf` says
   * so. It is asked at the last moment, with nothing of the session touched yet and nothing awaited from there until
   * the session has left `meta`, so no message, wake or card can come in between; false keeps the session as it is.
   * Such a delete never withdraws a wake (`onlyIf` is there to refuse a waking session), and never rides on a delete
   * already under way: that one is the person's, and keeps the session in the trash. A delete that rides on this one is
   * the person's too, for the same reason.
   * @returns `moved` when this call moved the session to the trash and nobody asked for a delete meanwhile, `joined`
   * when it moved it and a delete somebody asked for joined it (the session then stays in the trash), false when it
   * stays where it was
   */
  async trashIf(sessionId: string, removeExternal: boolean, onlyIf: () => boolean): Promise<'moved' | 'joined' | false> {
    if (this.trashing.has(sessionId)) return false
    const own: { joined: { removeExternal: boolean } | null } = { joined: null }
    this.hostDeletes.set(sessionId, own)
    try {
      if (!(await this.trashShared(sessionId, false, removeExternal, undefined, false, onlyIf))) return false
    } finally {
      if (this.hostDeletes.get(sessionId) === own) this.hostDeletes.delete(sessionId)
    }
    if (!own.joined) return 'moved'
    // The file goes only when the person asked for it too: the host's choice was made for a session nobody wanted
    if (removeExternal && !own.joined.removeExternal) this.host.store.trash.keepConversationFile(sessionId)
    return 'joined'
  }

  private async trashShared(
    sessionId: string,
    removeWorktree: boolean,
    removeExternal: boolean,
    recovery: WorktreeRecovery | undefined,
    fromCleanup: boolean,
    onlyIf?: () => boolean,
  ): Promise<boolean> {
    /*
     * A restore or a purge still running (#839): a restore makes the session live only at its end, so a delete now found
     * no session, told the windows it was gone, and the restore then brought it back behind that word
     */
    if (this.trashBusy.has(sessionId)) throw rpcError('That session is already being restored or deleted')
    const pending = this.trashing.get(sessionId)
    if (pending) {
      /*
       * A worktree cleanup cannot ride on a delete that started first (#647): that one writes a trash record without
       * the recovery snapshot, and removing the worktree after it would leave nothing a restore could bring back.
       */
      if (recovery || fromCleanup) throw rpcError('The session is already being deleted without its recovery snapshot')
      // The person's own delete, which keeps the session in the trash: not the host's to purge after it (`trashIf`)
      if (onlyIf) return false
      // Joined, not moved by this call: only `trashIf` reads the answer, and it never joins. A host delete it joins
      // becomes this one, which keeps the session in the trash (`hostDeletes`)
      const host = this.hostDeletes.get(sessionId)
      if (host) host.joined = { removeExternal: (host.joined?.removeExternal ?? false) || removeExternal }
      await pending
      return false
    }
    // The first request owns the options; concurrent sidebar/agent deletes share its result.
    let moved = false
    const deleting = this.trashSessionOnce(sessionId, removeWorktree, removeExternal, recovery, fromCleanup, onlyIf).then((m) => {
      moved = m
    })
    this.trashing.set(sessionId, deleting)
    try {
      await deleting
    } finally {
      this.trashing.delete(sessionId)
    }
    return moved
  }

  /**
   * Whether the session is at rest at this moment: no turn running or about to start (a wake, a restart, a note held for it),
   * no card on it, no background job running, no app waiting on its answer. Read with nothing awaited, in the step that moves it
   * (`trashIfQuiet`), so a message the person sent a moment ago keeps it
   */
  isQuiet(sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    if (!m) return false
    if (isInTurn(m.state) || m.pendingApproval || m.pendingQuestions.length > 0) return false
    if (m.backgroundTasks.some((t) => t.status === 'running')) return false
    const run = this.host.agentRuns.get(sessionId)
    if (run && !run.finished) return false
    if (this.host.resuming.has(sessionId) || this.host.restartPolicy.deferredRestarts.has(sessionId) || this.host.inputsHeld(sessionId)) return false
    return (this.host.children.queued.get(sessionId)?.length ?? 0) === 0
  }

  /**
   * A delete the orchestrator asked for (#1219), decided here at the last moment, as `trashIf`'s is: the session moves only if
   * it is still at rest in the very step that moves it, nothing awaited between (`isQuiet`). Unlike `trashIf` it is the
   * person's kind of delete: it never purges, and a delete already under way is the one that stands. False: it stayed where it was
   */
  trashIfQuiet(sessionId: string, also: () => boolean = () => true): Promise<boolean> {
    return this.trashShared(sessionId, false, false, undefined, false, () => this.isQuiet(sessionId) && also())
  }

  /**
   * What moving the session to the trash drops that restoring does not bring back, in words for a card (see the lines of
   * `trashSessionOnce` that let go of what the session held): a caller waiting for its report, work it waits on, reports its
   * children owe it, the start_agent cards it raised, what the person allowed it to read or start
   */
  lossesOf(sessionId: string): string[] {
    const c = this.host.children
    const name = (id: string) => plainQuoted(this.host.meta.get(id)?.name ?? id, 60)
    const out: string[] = []
    const caller = c.awaitingReport.get(sessionId)
    if (caller) out.push(`${name(caller)} is waiting for the report of the work it gave this session; that report will not come.`)
    const waiting = [...c.delegations.values()].filter((d) => d.sessionId === sessionId && !d.settled)
    if (waiting.length) out.push(`${waiting.length === 1 ? 'A session is' : `${waiting.length} sessions are`} waiting for its answer (${[...new Set(waiting.map((d) => name(d.callerId)))].join(', ')}); the answer will not come.`)
    const owe = [...c.awaitingReport].filter(([, to]) => to === sessionId).length
    if (owe) out.push(`${owe === 1 ? 'A session it started owes' : `${owe} sessions it started owe`} it a report; ${owe === 1 ? 'it' : 'they'} will not be told, and the report is dropped.`)
    const asked = [...c.delegations.values()].filter((d) => d.callerId === sessionId && !d.settled)
    if (asked.length) out.push(`It waits on ${asked.length === 1 ? 'a session' : `${asked.length} sessions`} of other projects it asked; the wait and what the person allowed for it are dropped.`)
    const starts = [...c.agentStarts.values()].filter((r) => r.req.callerId === sessionId).length
    if (starts) out.push(`${starts === 1 ? 'A start_agent card it raised is' : `${starts} start_agent cards it raised are`} withdrawn.`)
    const run = this.host.agentRuns.get(sessionId)
    if (run && !run.finished) out.push('An app is waiting for its answer; that wait ends with an error.')
    if (this.host.readGrants.get(sessionId)?.size || this.host.delegationFlow.starts.agentConsents.has(sessionId)) {
      out.push('What the person allowed it (reading other sessions, starting agents) is dropped; a restored session asks again.')
    }
    return out
  }

  private async trashSessionOnce(
    sessionId: string,
    removeWorktree: boolean,
    removeExternal: boolean,
    recovery?: WorktreeRecovery,
    fromCleanup = false,
    onlyIf?: () => boolean,
  ): Promise<boolean> {
    if (this.host.worktrees.worktreeCleanup.has(sessionId) && !recovery && !fromCleanup) throw rpcError('The session worktree is being removed')
    const m = this.host.meta.get(sessionId)
    if (!m) {
      // Already in the trash, or never here: nothing to move. Say it is gone anyway, so a screen holding a stale row lets go
      this.host.emit({ type: 'session_deleted', sessionId })
      return false
    }
    /*
     * A session with worktree children used to be undeletable while one was unmerged (#69): a worktree whose manager
     * disappeared was an orphan nobody saw. Since #561 a child is an ordinary session that outlives the session that
     * started it: deleted, the parent leaves its children in the sidebar on their own, each with its worktree, its
     * branch and a "started by a session no longer here" mark, so nothing is hidden and nothing pins the parent.
     */
    /*
     * A tool that cannot delete its conversation file is refused now, not when the trash is emptied: the person
     * choosing it is here, and "the file stays" is worth hearing before the dialog closes rather than as a purge
     * that fails later.
     */
    const externalId = m.externalId ?? m.importedFrom
    if (removeExternal && externalId && !this.host.adapters.get(m.tool)?.deleteExternalConversation) {
      throw rpcError(`${m.tool} does not support deleting its conversation file`)
    }
    /*
     * If a wake is in progress, it is withdrawn and this waits for it to finish (#163). It used to
     * not wait — a wake would place a handle on the deleted session and rewrite the row, the deleted
     * session would come back on the next startup, and if the wake had started from a send, the
     * agent would go on to execute the message that had just been sent.
     */
    if (!onlyIf) await this.host.untilWakeWithdrawn(sessionId, 'The session was deleted while waking')
    /*
     * The host's own delete (#378 review) is decided here, with nothing awaited from this line until the session has left
     * `meta` below (a handle to dispose is one `onlyIf` refuses): a person's message, a wake or a card either came before
     * it and keeps the session, or finds the session gone. Checked earlier, a message in between woke the session and the
     * delete then cancelled that wake, and the message was lost.
     */
    if (onlyIf && !onlyIf()) return false
    /*
     * A handoff's original that goes (#738): what it still has (settled children, and anything it started after a
     * handoff that kept it) goes to the session that inherited its handoff, before the teardown below lets go of it. A
     * handoff whose window said the original goes next moved everything already, and this finds nothing. The move is
     * its own transaction ahead of the trash's: a crash between them leaves the children on the heir and the original
     * standing, one owner either way.
     */
    const heir = this.host.handoffHeir(sessionId)
    if (heir) this.host.moveChildren(sessionId, heir, 'removed')
    // A session an app was waiting on an answer from (M4 D-1) — the wait is ended along with a reason.
    // Leaving it unended would hang the app's call forever with no answer
    const agentRun = this.host.agentRuns.get(sessionId)
    if (agentRun) {
      agentRun.deleted = true
      agentRun.fail(new Error('the person deleted the agent session before it answered'))
    }
    for (const observer of this.host.turnObservers.get(sessionId) ?? []) observer.fail(new Error('the person deleted the session before it answered'))
    // What this session asked other projects to do (#371): nobody is left to read the answer. The delegated session
    // keeps its turn — it is that project's own session now, and the person may want what it is doing — but the wait
    // and the grants go
    for (const [key, d] of this.host.children.delegations) {
      if (d.callerId !== sessionId) continue
      this.host.children.dropDelegation(key)
      if (this.host.agentRuns.get(d.sessionId) === d.wait) this.host.agentRuns.delete(d.sessionId)
    }
    this.host.readGrants.delete(sessionId)
    this.host.delegationFlow.starts.agentConsents.delete(sessionId)
    // Its children on linked machines (#1038 review): nobody is left to report to; they stay on their machines
    this.host.delegationFlow.remote.forgetCaller(sessionId)
    // What a handoff gave away from it, or to it, or the given work itself (#693)
    this.host.children.forgetHandedOver(sessionId)
    // Its start_agent requests (#673): a standing card is withdrawn, with a line saying so if the session is restored
    for (const rec of [...this.host.children.agentStarts.values()]) {
      if (rec.req.callerId !== sessionId) continue
      this.host.delegationFlow.starts.withdrawAgentStart(rec.req.requestId, 'The session that asked was deleted.', agentStartPersonText(rec.req, 'deleted'))
      this.host.children.dropAgentStart(rec.req.requestId)
    }
    this.host.updateConsents.delete(sessionId)
    this.host.updateApplyConsents.delete(sessionId)
    // A capability question raised on this session has nowhere left to be answered (D-4) — it is ended with
    // no answer (the window does not remember it, just declines)
    for (const ask of [...this.host.hostCards.hostAsks.values()]) {
      if (ask.sessionId !== sessionId) continue
      this.host.hostCards.hostAsks.delete(ask.requestId)
      ask.resolve(null)
    }
    const handle = this.host.handles.get(sessionId)
    if (handle) {
      await handle.dispose().catch(() => {})
      this.host.handles.delete(sessionId)
    }
    // Its process is gone with it, and a restored session starts a new one (#648)
    this.host.restartPolicy.forgetBackground(sessionId)
    /*
     * The message being streamed is written out, not dropped (#66 used to drop it, because the rows were about to go).
     * The rows now stay, and a trashed conversation that stops mid-sentence is not the one that was deleted. Written
     * before the trash step, so its index row is dropped with the rest.
     */
    this.host.record.closeStream(sessionId)
    let project: { name: string; path: string } | undefined
    if (m.projectId) project = this.host.store.projects.listProjects().find((p) => p.id === m.projectId)
    this.host.running.delete(sessionId)
    this.host.restartPolicy.restartAfterTurn.delete(sessionId)
    this.host.restartPolicy.trustRestartNotice.delete(sessionId)
    // A deleted session's branch is never asked about again (#392: one entry per worktree session ever made)
    this.host.prCheckedAt.delete(sessionId)
    // Kept until its turn ends, which a deleted session's never does (#392)
    this.host.restartPolicy.appsRestartAfterTurn.delete(sessionId)
    this.host.children.clearReport(sessionId)
    // Nobody is left to tell: the reports its children owed it go too
    for (const [child, caller] of [...this.host.children.awaitingReport]) if (caller === sessionId) this.host.children.clearReport(child)
    // Requests held for it, or that it made, go too (#677)
    this.host.children.dropQueued((r) => r.sessionId === sessionId || r.callerSessionId === sessionId)
    // The same for a delegated turn's link (#676), either way
    this.host.children.releaseTurn(sessionId)
    for (const [child, owner] of [...this.host.children.turnOwners]) if (owner.callerId === sessionId) this.host.children.releaseTurn(child)
    this.host.children.dropObserverNotesOf(sessionId)
    this.host.forgetCommits(sessionId)
    this.host.forgetCardRest(sessionId)
    this.host.forgetHeldNotices(sessionId)
    this.host.stopWatchingReconnect(sessionId)
    this.host.quitNotices = this.host.quitNotices.filter((n) => n.sessionId !== sessionId && n.requester !== sessionId)
    this.host.meta.delete(sessionId)
    await this.host.store.trash.trashSession(sessionId, {
      projectId: m.projectId,
      projectName: project?.name ?? null,
      projectPath: project?.path ?? null,
      removeExternal: removeExternal && !!externalId,
      removeWorktree: removeWorktree && !!m.worktree,
      ...(recovery ? { recovery } : {}),
    })
    // Tears down this session's inline app views (M4 B-1) — releases whatever app it was holding onto. A
    // restored conversation reopens them from its history
    this.host.appsHub?.sessionGone(sessionId)
    this.host.emit({ type: 'session_deleted', sessionId })
    return true
  }

  /** Only one trash operation per session at a time — a purge racing a restore would restore half of a deleted session */
  private readonly trashBusy = new Set<string>()

  private async trashOp<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    // A delete still running counts (#839): the session is in the trash before its last steps, which would undo a restore
    if (this.trashBusy.has(sessionId) || this.trashing.has(sessionId) || this.host.worktrees.worktreeCleanup.has(sessionId)) {
      throw rpcError('That session is already being restored or deleted')
    }
    this.trashBusy.add(sessionId)
    try {
      return await run()
    } finally {
      this.trashBusy.delete(sessionId)
    }
  }

  /**
   * The trash as Settings lists it (#204), with the records of deleted app-agent sessions (#378), the subagent steps moved
   * there without their session (#418), and the total it takes on this machine
   */
  async listTrash(): Promise<{ sessions: TrashedSession[]; runs: TrashedRun[]; bytes: number; subagentSteps: TrashedSubagentSteps[] }> {
    const projects = new Map(this.host.store.projects.listProjects().map((p) => [p.id, p]))
    const sessions = await Promise.all(
      this.host.store.trash.listTrash().map(async (r): Promise<TrashedSession> => {
        const { record } = r
        const live = record.projectId ? projects.get(record.projectId) : undefined
        const files =
          (await attachmentBytes(r.id).catch(() => 0)) +
          (await worktreeRecoveryBytes(r.id).catch(() => 0)) +
          (record.projectId ? await handoffNoteBytes(record.projectId, r.id).catch(() => 0) : 0)
        return {
          id: r.id,
          name: r.name,
          tool: r.tool,
          project: record.projectId
            ? {
                id: record.projectId,
                name: live?.name ?? record.projectName ?? record.projectId,
                path: live?.path ?? record.projectPath,
                exists: !!live,
              }
            : null,
          deletedAt: r.deletedAt,
          messages: r.messages,
          bytes: r.bytes + files,
          conversationFile: !r.hasConversationFile ? 'none' : record.removeExternal ? 'remove' : 'keep',
          // Only a worktree still on disk is listed — the merged-worktree cleanup removes the folder before the trash is emptied
          worktree: r.worktree && existsSync(r.worktree.path) ? { ...r.worktree, remove: record.removeWorktree } : null,
        }
      }),
    )
    const runs = this.host.store.keptRuns.listKeptRuns().map((r): TrashedRun => ({
      runId: r.runId,
      app: { id: r.appId, name: r.appName, projectId: r.projectId, projectName: r.projectId ? (projects.get(r.projectId)?.name ?? r.projectName) : null },
      sessionName: r.sessionName,
      tool: r.tool,
      status: r.status,
      startedAt: r.startedAt,
      keptAt: r.keptAt,
      durationMs: r.durationMs,
      tokens: r.tokens,
      requestPreview: r.requestPreview,
      messages: r.messages,
      bytes: r.bytes,
    }))
    const subagentSteps = this.host.store.subagentSteps.listTrashed().map((r) => ({ ...subagentStepsHeld(r), deletedAt: r.deletedAt }))
    const bytes = [...sessions, ...runs, ...subagentSteps].reduce((a, x) => a + x.bytes, 0)
    return { sessions, runs, bytes, subagentSteps }
  }

  /** An app-agent run's record, read-only (#378): its request, answer and structured output, and a page of its conversation */
  readTrashedRun(runId: string, limit: number, beforeSeq?: number): { request: string; answer: string; output?: unknown; messages: StoredMessage[] } {
    const r = this.host.store.keptRuns.readKeptRun(runId, limit, beforeSeq)
    if (!r) throw rpcError(`Not in the trash: ${runId}`, 'session_not_found')
    const output = r.output === null ? undefined : (() => { try { return JSON.parse(r.output) as unknown } catch { return r.output } })()
    return { request: r.request, answer: r.answer, ...(output !== undefined ? { output } : {}), messages: r.messages }
  }

  /** Deletes app-agent run records for good (#378), only from Settings like a trashed session */
  purgeTrashedRuns(runIds: readonly string[]): { purged: number } {
    return { purged: this.host.store.keptRuns.purgeKeptRuns(runIds) }
  }

  /** A trashed conversation, read-only (#204). Live sessions are read through `loadMessages`, not here */
  async readTrashed(sessionId: string, limit: number, beforeSeq?: number): Promise<StoredMessage[]> {
    if (!this.host.store.trash.isTrashed(sessionId)) {
      throw rpcError(`Not in the trash: ${sessionId}`, 'session_not_found')
    }
    return this.host.loadMessages(sessionId, limit, beforeSeq)
  }

  /**
   * Brings a session back from the trash as it was (#204): same id, same messages, same rules, its commit links and
   * app runs still pointing at it, its search index rebuilt.
   *
   * Where it goes when its project was deleted meanwhile: the folder is registered again **under the same id**, so
   * everything keyed by that id lines up again — the worktree folder (`<worktrees>/<project id>/<session id>`), the
   * handoff notes (`<data>/handoff/<project id>/`), the commit links and app runs that stayed with the session. If
   * the folder is registered already under another id, it goes there. If the folder is gone too, it refuses and
   * says where the folder was: a project session without its folder cannot run, and it stays readable in the trash.
   *
   * A live-only state (working, waiting for approval) comes back idle, as it does after a restart: there is no
   * process behind it. Other states come back as they were, so one that was waiting for the person is in the inbox again.
   */
  async restoreSession(sessionId: string): Promise<{ session: SessionInfo; project: ProjectInfo | null }> {
    return this.trashOp(sessionId, async () => {
      await this.host.recoveryRepair
      const t = this.host.store.trash.trashedSession(sessionId)
      if (!t) throw rpcError(`Not in the trash: ${sessionId}`, 'session_not_found')
      const { record } = t
      let projectId: string | null = null
      let registered: ProjectInfo | null = null
      if (record.projectId) {
        const projects = this.host.store.projects.listProjects()
        const home =
          projects.find((p) => p.id === record.projectId) ??
          (record.projectPath ? projects.find((p) => p.path === record.projectPath) : undefined)
        if (home) {
          projectId = home.id
        } else if (record.projectPath && existsSync(record.projectPath) && statSync(record.projectPath).isDirectory()) {
          this.host.store.projects.addProject({
            id: record.projectId,
            path: record.projectPath,
            name: record.projectName ?? basename(record.projectPath),
          })
          projectId = record.projectId
          registered = await this.host.projectInfo(projectId, record.projectPath)
        } else {
          throw rpcError(`Its project was deleted and its folder is gone${record.projectPath ? ` (${record.projectPath})` : ''} — put the folder back, then restore`)
        }
      } else if (t.session.kind === 'orchestrator' && this.host.store.sessions.orchestratorId()) {
        // Two central orchestrators would answer the same questions; the app has one (FR-11)
        throw rpcError('Another orchestrator is in place — the app runs one at a time')
      }
      let recovered: { branch: string; notice: string } | undefined
      if (record.recovery && t.session.worktree && projectId) {
        const repo = this.host.store.projects.listProjects().find((p) => p.id === projectId)!.path
        recovered = await restoreWorktreeRecovery(sessionId, repo, t.session.worktree.path, t.session.worktree.branch, record.recovery, this.host.gitTrust(projectId))
      }
      const back = await this.host.store.trash.restoreSession(sessionId, projectId)
      if (!back) throw rpcError(`Not in the trash: ${sessionId}`, 'session_not_found')
      const fixed = isInTurn(back.state) ? { ...back, state: 'idle' as const, waitingSince: null } : back
      if (recovered && fixed.worktree) fixed.worktree = { ...fixed.worktree, branch: recovered.branch }
      if (fixed !== back || recovered) this.host.store.sessions.upsertSession(fixed)
      // Started from a linked computer (#1273): its mark is kept beside the row until the purge, and comes back with it
      this.host.meta.set(sessionId, withHubMark(this.host.store.settings, fixed))
      const session = { ...this.host.meta.get(sessionId)!, live: false }
      this.host.emit({ type: 'session_created', sessionId, session })
      if (recovered) this.host.onEvent({ type: 'notice', sessionId, level: 'info', from: 'Centralu', label: 'worktree recovery', text: recovered.notice })
      return { session, project: registered }
    })
  }

  /**
   * Deletes a session in the trash for good (#204) — only the person, only from Settings. The agents' tools and the
   * apps' broker have no path here; the RPC is the only caller.
   *
   * Order: the tool's conversation file first, when the person chose it. If that fails the purge stops and the
   * session stays in the trash — answering "deleted" while the original lives is the worst outcome (a person
   * believes 550MB is gone). It is skipped when a live session holds the same conversation (it was pulled back
   * from Past conversations meanwhile): deleting it would take that session's history. Then the worktree, when
   * chosen (a failure does not stop the purge — its folder is plain files the person can still remove). Then our
   * rows, and last the recovery files, the attachments and the handoff note, which have to outlive the rows that
   * point at them.
   */
  async purgeSession(sessionId: string): Promise<void> {
    return this.trashOp(sessionId, async () => {
      await this.host.recoveryRepair
      const t = this.host.store.trash.trashedSession(sessionId)
      if (!t) throw rpcError(`Not in the trash: ${sessionId}`, 'session_not_found')
      const { session: s, record } = t
      const cwd = this.host.store.sessions.sessionCwd(sessionId) ?? s.worktree?.path ?? record.projectPath
      const externalId = s.externalId ?? s.importedFrom
      if (record.removeExternal && externalId) {
        const held = [...this.host.meta.values()].some(
          (x) => x.tool === s.tool && (x.externalId === externalId || x.importedFrom === externalId),
        )
        if (!held) {
          const adapter = this.host.adapters.get(s.tool)
          if (!adapter?.deleteExternalConversation) {
            throw rpcError(`${s.tool} does not support deleting its conversation file`)
          }
          if (!cwd) throw rpcError('The folder this conversation ran in is unknown')
          await adapter.deleteExternalConversation(externalId, cwd)
        }
      }
      if (record.removeWorktree && s.worktree && record.projectPath) {
        /*
         * Removed with force — reaching this point means the person was told "there are uncommitted
         * changes" and answered delete anyway. Without force, git would refuse and nothing would ever
         * get removed at all.
         */
        /*
         * A removal that fails stops the purge, and the entry stays to be tried again (#841 item 6): swallowed, the
         * record went and the folder stayed, with nothing left in Centralu that knew of it. A folder already gone is
         * what was asked for.
         */
        const path = s.worktree.path
        const repo = record.projectPath
        await gitWorktreeRemove(repo, path, true).catch((e: Error) => {
          if (!existsSync(path)) return
          // The project folder moved or went (#990 review): git has no repository to remove it from, and only the person can
          if (!existsSync(repo)) {
            throw rpcError(`The project folder ${repo} is not there any more (moved or deleted), so git cannot remove its worktree at ${path}. It stays in the trash: delete that folder yourself, then delete this entry again.`)
          }
          throw rpcError(`Could not remove the worktree at ${path}: ${e.message.trim()}. It stays in the trash; remove the folder or fix the cause, then delete it again.`)
        })
      }
      /*
       * The recovery files go only once the rows are gone (#647): cleared first, a failed database step would leave
       * a trash entry nothing can restore. Set aside before, so a folder that cannot be removed still stops the
       * purge while the entry is retryable; put back when the rows stay.
       */
      const recoveryRemoval = await stageWorktreeRecoveryRemoval(sessionId)
      try {
        await this.host.store.trash.purgeSession(sessionId)
        this.host.restartPolicy.forgetBackground(sessionId)
        this.host.store.settings.deleteAppSetting(codeIntelligenceKey(sessionId))
      } catch (e) {
        // Not swallowed: the folder left aside carries the session id, and the next start puts it back (#647)
        await recoveryRemoval.abort().catch((cause: Error) => console.error(`[trash] recovery files of ${sessionId.slice(0, 8)} could not be put back after a failed purge and stay aside until the next start: ${cause.message}`))
        throw e
      }
      await recoveryRemoval.commit().catch(() => {})
      await clearAttachments(sessionId).catch(() => {})
      // An orchestrator's child worked in a folder of its own (#853, #994 review), which goes with it
      if (cwd && isOrchestratorAgentFolder(cwd)) {
        await rm(cwd, { recursive: true, force: true }).catch((e: Error) => console.error(`[trash] the folder of ${sessionId.slice(0, 8)} could not be removed: ${e.message}`))
      }
      /*
       * Sweeps up the handoff note that lost its purpose along with this session (#106). It matters
       * that this runs **after** the row is gone — the session that was just deleted must not still
       * appear to be holding on to its own note. The note the deleted session had inherited (under its
       * predecessor's name) is also caught in this same pass.
       */
      if (record.projectId) await this.host.sweepOrphanHandoffNotes(record.projectId).catch(() => {})
    })
  }

  /**
   * Deletes every session in the trash for good. One that fails stays and is reported; the rest go on. The app-agent run
   * records (#378) are the window's to delete by id (`purgeTrashedRuns`), so a linked machine's are never emptied unseen.
   */
  async emptyTrash(): Promise<{ purged: number; failed: { sessionId: string; name: string; error: string }[] }> {
    let purged = 0
    const failed: { sessionId: string; name: string; error: string }[] = []
    for (const r of this.host.store.trash.listTrash()) {
      try {
        await this.purgeSession(r.id)
        purged++
      } catch (e) {
        failed.push({ sessionId: r.id, name: r.name, error: (e as Error).message })
      }
    }
    return { purged, failed }
  }

  // ── A session's subagent steps, in the trash without it (#418) ──
  //
  // The steps of the subagents a session launched (#222) can be most of what it holds, and the session may be one in
  // use. They go to the trash on their own and come back under their cards; deleting them for good is the trash's rule,
  // as for a session: only the person, from Settings, one at a time or by emptying the trash.

  /** One move, restore or purge of a session's subagent steps at a time */
  private readonly subagentBusy = new Set<string>()

  private async subagentOp<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    if (this.subagentBusy.has(sessionId)) throw rpcError("That session's subagent steps are already being moved")
    this.subagentBusy.add(sessionId)
    try {
      return await run()
    } finally {
      this.subagentBusy.delete(sessionId)
    }
  }

  /** What each live session's subagent steps take, largest first; Settings lists them beside the trash */
  subagentUsage(): { sessions: SubagentStepsHeld[] } {
    return { sessions: this.host.store.subagentSteps.listHeld().map(subagentStepsHeld) }
  }

  /** Moves a live session's subagent steps to the trash; the conversation and its launch cards stay */
  async trashSubagentSteps(sessionId: string): Promise<{ steps: number; bytes: number }> {
    if (!this.host.meta.has(sessionId) || this.trashing.has(sessionId)) throw sessionGone()
    return this.subagentOp(sessionId, async () => {
      const moved = await this.host.store.subagentSteps.trash(sessionId)
      if (!moved) throw sessionGone()
      return moved
    })
  }

  /** Puts a session's trashed subagent steps back under their cards */
  async restoreSubagentSteps(sessionId: string): Promise<void> {
    return this.subagentOp(sessionId, async () => {
      if (!(await this.host.store.subagentSteps.restore(sessionId))) throw this.notInTrash(sessionId)
    })
  }

  /**
   * Deletes a session's trashed subagent steps for good, those moved there at or before `upTo` (the `deletedAt` the
   * window listed); the session, the steps under its cards and steps moved to the trash since stay
   */
  async purgeSubagentSteps(sessionId: string, upTo: number): Promise<void> {
    return this.subagentOp(sessionId, async () => {
      if (!(await this.host.store.subagentSteps.purge(sessionId, upTo))) throw this.notInTrash(sessionId)
    })
  }

  /** The refusal for steps not in the trash, naming the session as the person knows it, never by its id */
  private notInTrash(sessionId: string) {
    const name = this.host.meta.get(sessionId)?.name
    return rpcError(`No subagent steps of ${name ? `“${name}”` : 'that session'} are in the trash`, 'session_not_found')
  }

  /** How many of one launch card's steps are in the trash */
  subagentTrashed(sessionId: string, parentCallId: string): { steps: number } {
    return { steps: this.host.store.subagentSteps.trashedOf(sessionId, parentCallId) }
  }
}

/** A session that is not live (gone, or in the trash itself): said without its id, which means nothing on screen */
function sessionGone() {
  return rpcError('That session is no longer here: it was deleted, or is in the trash', 'session_not_found')
}

/** A row of `SubagentStepRecords` as the protocol says it */
function subagentStepsHeld(r: SubagentStepsRow): SubagentStepsHeld {
  return {
    sessionId: r.sessionId,
    name: r.name,
    tool: r.tool as ToolName,
    project: r.projectId ? { id: r.projectId, name: r.projectName ?? r.projectId } : null,
    runs: r.runs,
    steps: r.steps,
    bytes: r.bytes,
  }
}
