import type { PermissionPreset, RebuildCause, SessionInfo, ToolName } from '@cc/protocol'
import { errorMessage } from '@cc/protocol'
import type { EventSink, SessionHandle } from '../adapters/contract.js'
import { inTurn, sessionIdle, type SessionIdle } from '../idle.js'
import { rpcError, sessionNotFound } from '../rpc-error.js'
import type { DelegationHost } from './delegation-flow.js'
import type { LaunchRecordsHost } from './launch-records.js'
import type { MailSessionsHost } from './mail-sessions.js'
import type { OrchestratorSlotHost } from './orchestrator-slot.js'
import type { SessionEventsHost } from './session-events.js'
import type { SessionRecordHost } from './session-record.js'
import { freshStartKey, type SessionStarts, type SessionStartsHost } from './session-start.js'
import type { SessionTrashHost } from './session-trash.js'
import { sessionDemands, unfitError } from './tool-fit.js'
import type { TurnInputs } from './turn-inputs.js'
import type { WorktreeHost } from './worktree-sessions.js'

/**
 * What a session's processes reach of the session manager (#1143), typed as the manager declares each member. The manager builds it with
 * getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type SessionProcessesHost = Pick<DelegationHost, 'adapters' | 'children' | 'cwdFor' | 'emit' | 'handles' | 'meta' | 'store'> &
  Pick<SessionStartsHost, 'externals' | 'openSession' | 'worktrees'> &
  Pick<SessionTrashHost, 'record' | 'restartPolicy'> &
  Pick<SessionRecordHost, 'modelWindows' | 'sessionOf'> &
  Pick<SessionEventsHost, 'notBeingRemoved'> &
  Pick<MailSessionsHost, 'events'> &
  Pick<LaunchRecordsHost, 'settingFilesFor'> &
  Pick<OrchestratorSlotHost, 'refusal'> &
  Pick<WorktreeHost, 'projectTrusted'> & {
    /** A session's process brought up, for a new session or a wake (session-start.ts) */
    readonly starts: Pick<SessionStarts, 'doResumeSession'>
    /** A note the delegation's wait or an observer has not taken yet holds the session in its turn (turn-inputs.ts) */
    readonly inputs: Pick<TurnInputs, 'inputsHeld'>
    /** Refuses a process swap while the host lets its sessions go (#839) */
    refuseWhileLettingGo: () => void
  }

/**
 * A session's process: woken (one wake at a time), forked, switched to another tool, put to sleep, restarted, and whether it is idle enough
 * for that. Moved out of the session manager as it was (#1143); what it reaches of the manager is `SessionProcessesHost`.
 */
export class SessionProcesses {
  constructor(private readonly host: SessionProcessesHost) {}

  /**
   * **The configuration the currently running process actually holds.**
   *
   * This can differ from meta (the value shown on screen). Permissions and model are fixed when the
   * tool is launched, so a mismatch can arise where the screen changes to "auto" but the process
   * keeps running with the old configuration. In that state, picking "auto" again does nothing,
   * because compared against meta nothing changed (dogfooding: "it shows auto selected but keeps
   * asking anyway"). So the comparison baseline is always this map, not meta.
   */
  readonly running = new Map<
    string,
    { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset }
  >()
  /**
   * Session currently being resumed -> its promise.
   *
   * If send() arrives twice at once, both see "no process" and each starts its own resume — two
   * processes come up, whichever lands in the handle map later wins, and the one that came up first
   * is orphaned forever without a dispose. So only one resume runs per session, and the rest wait on
   * its promise.
   */
  readonly resuming = new Map<
    string,
    Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  >()
  /** Session whose process is being ended to put it to sleep (#568) -> that ending; a resume waits for it */
  readonly sleeping = new Map<string, Promise<void>>()
  /**
   * Session waiting for a wake to finish so it can be deleted or have its tool switched -> the reason
   * (#163). That wake steps back without placing a handle — the waiting request came first. A send
   * that had joined the wake and was waiting is also not sent.
   */
  readonly leaving = new Map<string, string>()
  /**
   * Resumes an existing session (FR-10). The path for continuing a conversation after the host is
   * turned off and back on.
   *
   * The process is gone, but external_id and the conversation record remain in the store. If the
   * adapter's resume succeeds, the same conversation continues; if it fails, it does **not die
   * quietly** — it is reported with `resumable: false`, so the UI can offer "view history + new
   * session".
   */
  /**
   * `lockedElsewhere` is **a signal, not a sentence.**
   *
   * If the reason were only given as a sentence, the UI would have to pattern-match that sentence
   * back with a regex — a contract that silently breaks the moment the wording changes. The fact
   * that another side holds this conversation is raised as its own flag, so the screen can decide
   * whether to offer "fork and continue" independent of the exact wording.
   */
  async resumeSession(
    sessionId: string,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }> {
    // If it is already being resumed, wait on that same promise — if each caller started its own, two
    // processes would come up
    // A session going to sleep right now (#568) is resumed once its process is gone, never beside it
    const going = this.sleeping.get(sessionId)
    if (going) await going
    const inflight = this.resuming.get(sessionId)
    if (inflight) return inflight
    const p = this.host.starts.doResumeSession(sessionId).finally(() => this.resuming.delete(sessionId))
    this.resuming.set(sessionId, p)
    return p
  }

  /** Says in the conversation that the restart in progress applies a change of the project's trust (#663) */
  noticeTrustRestart(sessionId: string): void {
    if (!this.host.restartPolicy.trustRestartNotice.delete(sessionId)) return
    const m = this.host.meta.get(sessionId)
    if (!m || !this.host.handles.has(sessionId)) return
    const text = this.host.projectTrusted(m.projectId)
      ? "Restarted the agent to apply this project's new trust: it now reads the project's own settings and instruction files (CLAUDE.md, AGENTS.md)."
      : "Restarted the agent to apply this project's removed trust: it now reads only your own settings, not the project's files."
    this.host.events.onEvent({ type: 'notice', sessionId, level: 'info', from: 'Centralu', label: 'restart', text })
  }

  /**
   * **Forks off** from a locked conversation and continues in this session instead.
   *
   * The original is left untouched — a conversation another app was using is never taken away. Only
   * this session's externalId is changed to point at the new copy, and then it is resumed. Someone
   * reaching this point has already seen "already open elsewhere" and chosen this themselves, so it
   * is never asked again.
   *
   * Our store's conversation record is not touched at all. What the person sees on screen stays
   * exactly as it was, and only what happens from here on piles up in the copy.
   */
  async forkConversation(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    const m = this.host.openSession(sessionId)

    const source = m.externalId ?? m.importedFrom
    if (!source) {
      return { session: m, resumed: false, reason: 'This session has no conversation to fork from' }
    }

    const adapter = this.host.adapters.get(m.tool)
    if (!adapter?.forkConversation) {
      // If it cannot do this, say so — quietly doing nothing is far worse
      return { session: m, resumed: false, reason: `${m.tool} cannot fork a conversation` }
    }

    const tool = m.tool
    try {
      const forked = await adapter.forkConversation(source, this.host.cwdFor(m))
      // Deleted or switched while the tool forked (#839): the copy read before is not written back
      if (this.host.meta.get(sessionId) !== m || m.tool !== tool) return { session: m, resumed: false, reason: 'The session was deleted or switched tools while its conversation was forked' }
      m.externalId = forked
      this.host.store.sessions.upsertSession(m)
    } catch (err) {
      return { session: m, resumed: false, reason: errorMessage(err) }
    }

    return this.resumeSession(sessionId)
  }

  /** Withdraws an in-progress wake and waits for it to finish (leaving) — called first by delete and
   * tool-switch (#163) */
  async untilWakeWithdrawn(sessionId: string, why: string): Promise<void> {
    const waking = this.resuming.get(sessionId)
    if (!waking) return
    this.leaving.set(sessionId, why)
    try {
      await waking.catch(() => {})
    } finally {
      this.leaving.delete(sessionId)
    }
  }

  /**
   * The event sink handed to an adapter — **it carries which handle sent it** (#157).
   *
   * Every handle used to receive the same callback, so the manager could only look at the session id
   * and read an event as coming from "whichever handle is currently registered". When a settings
   * change swapped the process, a late message from the old handle (text from a turn that was
   * winding down, a late adapter_crashed) would be attributed to the new handle, and a late crash
   * would tear down the freshly launched process. A message that arrives before a handle has been
   * placed (before `own`) has no known owner yet, so it is still received the same way as now.
   */
  handleSink(): { sink: EventSink; own: (h: SessionHandle) => void } {
    let handle: SessionHandle | null = null
    return {
      sink: (e) => this.host.events.onEvent(e, handle),
      own: (h) => {
        handle = h
      },
    }
  }

  /** Why `tool` cannot run this session as its next launch would, under `preset` (its own by default), or null (`tool-fit.ts`) */
  toolRefusal(m: SessionInfo, tool: ToolName = m.tool, preset: PermissionPreset = m.permissionPreset): string | null {
    return this.host.refusal(tool, sessionDemands(m, this.host.settingFilesFor(m), preset))
  }

  /**
   * Switches a session's agent (claude <-> codex).
   *
   * **Context does not carry over.** externalId is the tool's own conversation id (Claude's
   * session_id, Codex's threadId). Switching only the tool and carrying that id over would hand codex
   * Claude's UUID — so it is **cut off right here.**
   *
   * All that is lost is 'the thread to resume from' — the conversation record itself stays exactly as
   * it is in our own store. The old tool's conversation also stays inside that tool, reachable again
   * through '+ -> Past conversations'.
   *
   * A session is a slot, and the agent is a tool — the slot (name, order, history, grid panel) is left
   * untouched, and only the tool underneath it is swapped.
   */
  async switchTool(sessionId: string, tool: ToolName): Promise<SessionInfo> {
    this.host.notBeingRemoved(sessionId)
    this.host.refuseWhileLettingGo()
    const m = this.host.sessionOf(sessionId)
    if (m.tool === tool) return { ...m, live: this.host.handles.has(sessionId) }

    const adapter = this.host.adapters.get(tool)
    if (!adapter) throw rpcError(`Unknown tool: ${tool}`, 'tool_not_installed')
    // Before anything is let go: a session switched to a tool that cannot run it would refuse every send after
    const refused = this.toolRefusal(m, tool)
    if (refused) throw unfitError(refused)

    /*
     * Checks whether the new tool is usable before switching to it.
     * Swapping without checking first would leave the old process already dead while the new one
     * fails to come up — a spot with no way back and no idea why.
     */
    const d = await adapter.detect()
    if (!d.installed || !d.loggedIn) {
      throw rpcError(`Cannot use ${tool}: ${d.detail}`, 'tool_not_installed')
    }
    /*
     * Read again after each wait (#839): a session deleted meanwhile is not written back from the copy read before it
     * (its row in the session archive took the new tool), nor one another switch moved first
     */
    const from = m.tool
    const stillHere = () => {
      if (this.host.meta.get(sessionId) !== m) throw sessionNotFound(sessionId)
      if (m.tool !== from) throw rpcError(`The session switched to ${m.tool} meanwhile`)
    }
    stillHere()

    const old = this.host.handles.get(sessionId)
    if (old) {
      await old.dispose().catch(() => {})
      stillHere()
      this.host.handles.delete(sessionId)
      this.running.delete(sessionId)
      // The message in progress ends here — kept and indexed (#66), but only once the old process is gone, so its
      // last deltas grow the open row instead of opening a second one (#213, restartSession's comment)
      this.host.record.closeStream(sessionId)
      this.endTurnWithProcess(sessionId)
    }

    m.tool = tool
    // The new tool knows nothing about the old conversation. Carrying the thread over would attach the wrong
    // conversation
    m.externalId = null
    m.importedFrom = null
    /*
     * **The model and its dependent settings are also let go together.**
     *
     * Measured (smoke-switch-tool): switching a session that had sonnet picked on claude over to
     * codex brings the process up, but the first turn dies with a 400 —
     *   "The 'sonnet' model is not supported when using Codex with a ChatGPT account."
     * Clearing the model and doing the same thing works fine. In other words, this is not a feature
     * that does not work — a value with meaning only to one tool was being carried across to another.
     *
     * A model id is a tool's own vocabulary — 'sonnet' and 'gpt-5.6-terra' are not two names for the
     * same slot, they are words that do not exist in each other's dictionary. effort also has
     * different ranges (claude goes up to max, codex up to high), and verbosity/serviceTier are
     * codex-only entirely. So these are not values to carry over but **values to pick fresh**, and
     * null means "that tool's default".
     *
     * The permission preset is kept: safe/normal/auto is a policy the person sets, not the tool, and
     * both adapters implement it with the same meaning.
     */
    m.model = null
    m.effort = null
    m.verbosity = null
    m.serviceTier = null
    /*
     * Everything up to here is the old tool's conversation — the boundary is recorded (the guard in
     * doResumeSession reads it). Without recording it, "there is history but no id to resume from"
     * would look like an accident, and the session just switched would refuse to wake on the next
     * startup, saying it "lost its resume id".
     */
    // The boundary is recorded as **the store's last seq**, not the in-memory lastSeq, which can lag
    // behind (there is a path where a row that came in as an event never passes through meta) — even
    // one row of drift would make the guard read it as "lost", and the session just switched would
    // fail to wake
    this.host.store.settings.setAppSetting(freshStartKey(m.id), String(this.host.store.messages.loadMessages(m.id, 1)[0]?.seq ?? 0))
    /*
     * The broadcast state is also written into meta (#163). It used to only broadcast idle while
     * saving meta as working, so a screen that reconnected and the orchestrator's list_sessions both
     * saw an interrupted turn as "still working" (the settings tool refused that session outright).
     */
    this.host.events.settleState(m, { type: 'state_change', sessionId, state: 'idle', reason: 'tool_changed' })

    // The new process only comes up once it is addressed (the same rule as resumeSession — launching it here
    // would run a tool that might never even be used)
    return { ...m, live: false }
  }

  /**
   * Whether the session is fully idle (#290, #297): its process can be swapped without losing work. The rule is
   * `sessionIdle` in idle.ts; this adds what only the manager knows, whether a process runs and whether its tool
   * reports background work.
   */
  sessionIdle(sessionId: string): SessionIdle {
    if (this.host.worktrees.worktreeCleanupBlocks(sessionId)) return { idle: false, reason: 'turn' }
    const m = this.host.sessionOf(sessionId)
    if (this.host.inputs.inputsHeld(sessionId)) return { idle: false, reason: 'turn' }
    return sessionIdle(m, {
      running: this.host.handles.has(sessionId),
      // An adopted process whose work the previous host did not record is as silent as a tool that cannot report (#648)
      reportsBackground: !!this.host.adapters.get(m.tool)?.capabilities.backgroundTasks && this.host.restartPolicy.backgroundKnown(sessionId),
    })
  }

  /**
   * The sessions whose running work this one waits on (#568, the sleep rule in sleep.ts): a child it started with
   * `start_agent`, or a session handling its ask_project task, while the turn it gave them runs, and a session that owes
   * it a report (`reportBack`, `awaitingReport`). Their answer is about to come back to it. A report held over the
   * child's own background work (#721) counts only while the child is in a turn: that work may run for minutes or
   * for good (a dev server), and the report wakes the caller when it comes.
   */
  waitsOn(sessionId: string): string[] {
    const ids = new Set<string>()
    for (const d of this.host.children.delegations.values()) if (d.callerId === sessionId && !d.settled) ids.add(d.sessionId)
    for (const [child, caller] of this.host.children.awaitingReport) {
      // A child paused on its own background work (#721) does not hold its caller awake: its report wakes it
      const at = this.host.meta.get(child)
      if (caller === sessionId && at && (!this.host.children.pausedReports.has(child) || inTurn(at.state))) ids.add(child)
    }
    /*
     * A session it owns (#561 part 3): a child it started, or a worktree session a former worktree manager held (store
     * v48), while a turn runs there. A former manager sent its work with send_to_session, so no delegation stands for
     * it; it is still the parent's work, about to be read back through agent_session
     */
    for (const s of this.host.meta.values()) {
      if (s.askedBy === sessionId && s.projectId === this.host.meta.get(sessionId)?.projectId && inTurn(s.state)) ids.add(s.id)
    }
    return [...ids]
  }

  /**
   * Puts an idle session to sleep (#568): its process ends, the session stays, and the next message, or a screen
   * waking it, resumes the conversation through `resumeSession`. The policy (when) is sleep.ts; this is only the act,
   * refused unless the session is still fully idle at this moment. The handle leaves the map first, so a message
   * arriving meanwhile starts a resume, and that resume waits for this process to be gone (`sleeping`).
   */
  async sleepSession(sessionId: string): Promise<boolean> {
    const h = this.host.handles.get(sessionId)
    if (!h || this.resuming.has(sessionId) || this.host.restartPolicy.deferredRestarts.has(sessionId) || this.sleeping.has(sessionId) || this.leaving.has(sessionId)) return false
    if (!this.sessionIdle(sessionId).idle || this.waitsOn(sessionId).length > 0) return false
    this.host.handles.delete(sessionId)
    this.running.delete(sessionId)
    // No process to adopt any more: its compaction ceiling is of no use to a later host (#1376)
    this.host.modelWindows.forget(sessionId)
    this.host.emit({ type: 'session_live', sessionId, live: false, reason: 'asleep' })
    const going = (async () => {
      await h.dispose().catch(() => {})
      // As a restart does: what the process wrote is ours, and its open row closes (restartSession)
      this.host.externals.stampExternalSynced(sessionId)
      this.host.record.closeStream(sessionId)
    })()
    this.sleeping.set(sessionId, going)
    try {
      await going
    } finally {
      this.sleeping.delete(sessionId)
    }
    return true
  }

  /**
   * Restarts only the agent (an extension of FR-10).
   * Creating a new session when a tool has become unresponsive breaks the conversation — this swaps only the
   * process.
   */
  async restartSession(
    sessionId: string,
    /** What made the restart, for the cache's rebuild cause (§6.1); a plain new process when absent */
    cause?: RebuildCause,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    this.host.notBeingRemoved(sessionId)
    this.host.refuseWhileLettingGo()
    if (cause) {
      this.host.restartPolicy.restartReasons.set(sessionId, cause)
      if (cause === 'launch_settings') console.error(`[sessions] restarting ${sessionId}: launch settings changed or previously unrecorded`)
    }
    // Applying a deferred settings change (#164) is also done by this same restart, and so is an app set's (#371)
    this.host.restartPolicy.restartAfterTurn.delete(sessionId)
    this.host.restartPolicy.appsRestartAfterTurn.delete(sessionId)
    this.host.restartPolicy.definitionsRestartAfterTurn.delete(sessionId)
    this.host.restartPolicy.launchSettingsRestartAfterTurn.delete(sessionId)
    this.noticeTrustRestart(sessionId)
    // A restart for any reason ends a wait for background work: whatever it was holding is applied now (#648)
    this.host.restartPolicy.clearBackgroundHold(sessionId)
    const h = this.host.handles.get(sessionId)
    if (h) {
      this.host.restartPolicy.noticeBackgroundStopped(sessionId, cause)
      await h.dispose().catch(() => {})
      // Stamped **after** dispose finishes — so even the outgoing process's last flush falls inside the
      // marker
      this.host.externals.stampExternalSynced(sessionId)
      this.host.handles.delete(sessionId)
      this.running.delete(sessionId)
      /*
       * The dying process's last words are kept (#66), and the message closes only now (#213). Closed before the
       * dispose, the handle was still registered while it went down, so its last deltas opened a second row: one
       * reply stored as two, cut mid-word. While it goes down its deltas grow the open row; once it is unregistered,
       * anything later is dropped (#157). No await between here and the new handle, so the new process starts its own row.
       */
      this.host.record.closeStream(sessionId)
      this.endTurnWithProcess(sessionId)
    }
    /*
     * A process was dropped and no new one took its place (#648): every window is told, as a sleep tells it. Before
     * this, a restart the host itself started (a definitions or launch-settings refresh, a CLI move) that failed left
     * the windows showing the session live, so the screen's wake stepped back and the person learnt only when a send
     * failed. The answer below still names the reason to whoever asked.
     */
    const dropped = (reason: string) => {
      if (!h || this.host.handles.has(sessionId)) return
      console.error(`[sessions] restart of ${sessionId.slice(0, 8)} did not bring a process up: ${reason}`)
      this.host.emit({ type: 'session_live', sessionId, live: false, reason: 'restart_failed' })
    }
    const r = await this.resumeSession(sessionId).catch((err: Error) => {
      dropped(err.message)
      throw err
    })
    if (!r.resumed) dropped(r.reason ?? 'unknown')
    return r
  }

  /**
   * A turn its process took with it (#839): a restart or a tool switch disposed the process mid-turn. Claude's dispose
   * says nothing of the turn, and the new process is stated `idle` by the host (`settleState`), which no wait reads as
   * a turn's end. So the turn ends here as a Stop ends it, through `onEvent`: a delegation on it settles as stopped and
   * frees its place under the agent limit, its caller is told, the turn's owner and the queue are released. Called
   * once the old handle is gone, so a turn end the old process did send is not repeated.
   */
  endTurnWithProcess(sessionId: string): void {
    const m = this.host.meta.get(sessionId)
    if (m && inTurn(m.state)) this.host.events.onEvent({ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' })
  }
}
