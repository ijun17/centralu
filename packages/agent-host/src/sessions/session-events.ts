import { randomUUID } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'
import type { Attachment, Interruption, NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import { applyBackgroundTasks, applySessionState, nextContext, nextStateFor } from '@cc/protocol'
import type { ToolQueriesHost } from './tool-queries.js'
import type { AgentProcess, SessionHandle } from '../adapters/contract.js'
import { gitHeadSha } from '../dev-services/git.js'
import { looksLikeGitCommit, parseCommitSha } from '../dev-services/git-attrib.js'
import { canonicalPath, isInside } from '../dev-services/path-guard.js'
import { inTurn } from '../idle.js'
import { rpcError } from '../rpc-error.js'
import { MailNotAtRest } from '../mail/delivery.js'
import { hubAskDepthKey } from './agent-depth.js'
import { ContextMeter } from './context-meter.js'
import { scriptMessageFrame } from './script-messages.js'
import { appMessageFrame, type AppMessageSource, type AppMessageVia } from './app-messages.js'
import type { ChildReports } from './child-reports.js'
import { HUB_SENDER, type DelegationHost } from './delegation-flow.js'
import { truncate } from './external-conversations.js'
import type { InterruptionWatch } from './interruption-watch.js'
import type { QueuedRequests } from './queued-requests.js'
import type { RoutedCards } from './routed-cards.js'
import type { SessionRecordHost } from './session-record.js'
import type { SessionStartsHost } from './session-start.js'
import type { SessionTrashHost } from './session-trash.js'
import type { WorktreeHost } from './worktree-sessions.js'

function untrustedSourceSessionNotification(sourceSessionId: string): string {
  return (
    '[Centralu] intersession message available.\n' +
    `sourceSessionId: ${sourceSessionId}\n` +
    'Use read_session(sourceSessionId) if you need the untrusted session transcript.'
  )
}

/**
 * What a session's events and inputs reach of the session manager (#428), typed as the manager declares each member.
 * The manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type SessionEventsHost = Pick<DelegationHost, 'agentRuns' | 'children' | 'cwdFor' | 'emit' | 'handles' | 'meta' | 'running' | 'store' | 'turnObservers'> &
  Pick<SessionRecordHost, 'cacheLedger' | 'modelWindows'> &
  Pick<ToolQueriesHost, 'usageRecorder'> & { usageFor: (tool: ToolName) => Promise<unknown> } &
  Pick<SessionTrashHost, 'hostCards' | 'record' | 'restartPolicy'> &
  Pick<WorktreeHost, 'cwdOf' | 'resuming'> &
  Pick<SessionStartsHost, 'appSessions' | 'apps' | 'cardRests' | 'launches' | 'openSession' | 'tools'> & {
    readonly cards: RoutedCards
    /** Whether the session's tool takes a message into the turn it is running, rather than holding it for the next (`midTurnInput`) */
    joinsRunningTurn(sessionId: string): boolean
    /** Sessions whose hub task's input is tracked (`sendFromHub`): its own turn takes the depth mark down, no other */
    readonly hubAskTurns: Set<string>
    readonly interruptions: InterruptionWatch
    /** Refuses a session whose worktree is being removed */
    notBeingRemoved: (sessionId: string) => void
    readonly queue: QueuedRequests
    readonly reports: ChildReports
    /** A session's live process, or `session_not_found` */
    requireHandle: (sessionId: string) => SessionHandle
    /** Something about a session changed that may let its mail go (#1347): it came to rest, a card was answered. Never throws */
    mailPoke: (sessionId: string) => void
    /** An event of a session, and whether it ended its turn: what the mail guards count (§7.9). Never throws */
    mailEvent: (e: NormalizedEvent, endedTurn: boolean) => void
    /** An event of a session, and whether it ended its turn: what compaction at a break reads (#1451, self-compaction.ts). Never throws */
    compactEvent: (e: NormalizedEvent, endedTurn: boolean) => void
    /** Whether the session's running turn is one Centralu started to compact it (#1451) */
    compactTurn: (sessionId: string) => boolean
    resumeSession: (sessionId: string, adopt?: AgentProcess) => Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  }

/**
 * What a session's tool says, received: kept on the session, stored, broadcast, and what its turn's end settles
 * (`onEvent`); a state the host states itself (`settleState`); the commits a tool call makes; and what goes into a
 * session's conversation (`deliver`). Moved out of the session manager as it was (#428); what it reaches of the
 * manager is `SessionEventsHost`.
 */
/** How long a tool may take to say it took a wake before it is taken as taken (it has not failed, and sending again could run the work twice) */
export const MAIL_ACCEPT_MS = 90_000

/**
 * Hands a wake to the tool and waits until the tool took it (docs/plans/mailbox.md §7.6.2): Codex when `turn/start` answers, Claude
 * when a turn runs for it, and a rejection or a process that closed with the wake still queued is a failure, so the mailbox keeps the
 * mail and tries again. A tool that cannot track its inputs (an older CLI) has taken it when the write returns, as before.
 *
 * A tool silent for `MAIL_ACCEPT_MS` counts as having taken it. If it fails the input after that (a CLI slow to start that closes with the
 * wake still queued, a Codex whose `turn/start` is rejected late) it never ran it, so `late` is told and the mailbox puts the mail
 * back; a failure after the tool took the input is not told, since sending it again could run the work twice.
 */
async function takeInput(handle: SessionHandle, text: string, late?: (e: Error) => void): Promise<void> {
  const origin = { kind: 'channel', server: 'centralu' } as const
  if (!handle.sendTracked) {
    handle.send(text, { origin })
    return
  }
  const tracked = handle.sendTracked.bind(handle)
  // 'counted': the wait ran out and the wake went on as taken, with the tool still silent
  let state: 'waiting' | 'counted' | 'taken' | 'failed' = 'waiting'
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (state !== 'waiting') return
      state = 'counted'
      console.error(`[mail] ${handle.sessionId.slice(0, 8)}: the tool has not said it took the wake in ${MAIL_ACCEPT_MS / 1000} s; counted as taken`)
      resolve()
    }, MAIL_ACCEPT_MS)
    timer.unref()
    const done = () => {
      clearTimeout(timer)
      state = 'taken'
      resolve()
    }
    const fail = (e: Error) => {
      clearTimeout(timer)
      const was = state
      if (was === 'waiting' || was === 'counted') state = 'failed'
      if (was === 'waiting') reject(e)
      else if (was === 'counted') late?.(e)
    }
    tracked(text, { accepted: done, complete: done, fail }, { origin }).then(done, fail)
  })
}

export class SessionEvents {
  /** The context figure during a turn, from each request's size (#1492, context-meter.ts) */
  private readonly meter = new ContextMeter()

  constructor(private readonly host: SessionEventsHost) {}

  /** Receive event -> update metadata -> persist message -> broadcast */
  onEvent(raw: NormalizedEvent, from: SessionHandle | null = null): void {
    const e = raw.type === 'files_touched' ? this.projectRelative(raw) : raw
    /*
     * **A message from a handle that has already been set aside is never accepted** (#157) — anything
     * not from the handle currently registered for that session is dropped. It never enters the crash
     * branch (does not close the new handle), and does not record either the text from the turn that
     * was winding down or its turn_complete.
     *
     * The only exception is a message that closes something showing on screen — the approval and
     * question cards, and the agent card, that a handle releases as it closes. Dropping those too
     * would leave the card stuck forever (see the comment on dispose). The manager calls the dispose
     * that produces that message **before** removing the handle, so a different message issued during
     * close (notice of a message that could not be sent) still arrives as a message from the
     * registered handle.
     */
    if (
      from &&
      e.sessionId &&
      this.host.handles.get(e.sessionId) !== from &&
      e.type !== 'approval_resolved' &&
      e.type !== 'question_resolved' &&
      e.type !== 'tool_result' &&
      e.type !== 'background_tasks'
    ) {
      return
    }
    /*
     * A set-aside handle's background work (#290) — only its endings are its to say. Its tasks went with its process,
     * and the live set belongs to the handle now registered, which a late empty set from the old one must not wipe.
     */
    if (from && e.type === 'background_tasks' && this.host.handles.get(e.sessionId) !== from) {
      const m = this.host.meta.get(e.sessionId)
      if (!m || !e.ended?.length) return
      return this.onEvent({ ...e, live: m.backgroundTasks.filter((t) => t.status === 'running') })
    }
    const unborn = e.sessionId && !this.host.meta.has(e.sessionId) ? this.host.record.unborn.get(e.sessionId) : undefined
    if (unborn) {
      unborn.push(e)
      return
    }
    if (e.type === 'subagent_event') {
      this.host.record.recordSubagentStep(e)
      return
    }
    // The tool's reading of the turn before, landing after this turn's own requests moved the figure, would put an older size over a newer one (#1492)
    if (e.type === 'context_update' && this.meter.stale(e)) {
      // The compaction rule still hears it: it decides a request on the size the turn ended at
      this.host.compactEvent(e, false)
      return
    }
    if (e.type === 'settings_changed' && e.by === 'tool') {
      this.host.record.recordToolSettings(e)
      return
    }
    // Text the tool repeats on every start (#304): one stored line per session is enough
    if (e.type === 'notice' && e.oncePerSession && e.sessionId && this.host.store.handoffs.hasNotice(e.sessionId, e.text)) return
    let seq: number | null = null
    /** This event ended the turn — how it ended (completed, error, canceled, limit) is stated by this event
     * itself */
    let endedTurn = false
    /** The session's interruption before this event (#698); `undefined` when the event belongs to no known session */
    let interruptionBefore: Interruption | null | undefined
    if (e.sessionId) {
      const m = this.host.meta.get(e.sessionId)
      if (m) {
        const handle = this.host.handles.get(e.sessionId)
        if (handle?.externalId && m.externalId !== handle.externalId) {
          m.externalId = handle.externalId
        }
        const wasBusy = inTurn(m.state)
        const before = m.state
        this.applyStateHint(e, m)
        this.host.cardRests.note(e, m.id, before)
        interruptionBefore = m.interruption ?? null
        this.host.interruptions.trackInterruption(e, m, wasBusy && !inTurn(m.state))
        // Heard from: an unknown background state is bounded by quiet, not by age (#648, `backgroundKnown`)
        if (this.host.restartPolicy.backgroundUnknown.has(m.id)) this.host.restartPolicy.backgroundUnknown.set(m.id, Date.now())
        /*
         * A builder session's turn ended (M4 C-4) — this is the moment to relaunch that app from its
         * files. It happens once, right here, rather than every time the app's folder changes: an app
         * mid-turn is code that is only half fixed. The runtime itself decides whether it actually
         * changed or whether a call is still in flight.
         */
        // The queued request being delivered started its turn (#684 review): only now is it off the queue and the store
        if (!wasBusy && inTurn(m.state)) this.host.children.queuedTurnStarted(m.id)
        // A turn starts (#1377): whose it is comes from the message it started with, else the CLI's own
        if (!wasBusy && inTurn(m.state)) this.host.children.turnStarted(m.id)
        /*
         * Or the tool refused it outright (#839): an error or a usage limit, and no turn starts. The request is done with
         * all the same, and this is its turn's end: its requester is told, the turn it owned is released, the next request
         * goes in. Left delivering, the session counted as busy for every requester and its queue never moved again. Only
         * once the input was handed to the process: one the tool reports while the session wakes for it (Codex's account-wide
         * limit, a crash) refuses nothing yet, and the input still goes in or the delivery fails on its own.
         */
        if (!wasBusy && !inTurn(m.state) && (e.type === 'error' || e.type === 'limit_reached') && this.host.children.delivering.has(m.id) && this.host.queue.queuedHandedIn.has(m.id)) {
          this.host.children.queuedTurnStarted(m.id)
          endedTurn = true
        }
        if (wasBusy && !inTurn(m.state)) {
          endedTurn = true
          const ref = this.host.appSessions.builderRefOf(m)
          if (ref) this.host.apps.appsHub?.rt.builderTurnEnded(ref)
        }
        // An image takes its row here too, in order; its file is written after (#40 part 2, #868: `persistImage`)
        seq = this.host.record.persistMessage(e, m)
        // Commit attribution (#50) — caught in passing whenever a git commit tool call goes by
        if (e.type === 'tool_call' || e.type === 'tool_result') this.observeCommit(e, m)
        this.host.store.sessions.upsertSession(m)
      }
      /*
       * **A dead process's handle is removed right on the spot.**
       *
       * Raising adapter_crashed while leaving the handle in place means send() would only check
       * handles.has, push onto an already-dead queue, and **the next message would silently
       * disappear** (until an explicit restart). Removing it means send()'s "resume if missing" path
       * becomes automatic recovery on its own.
       */
      /*
       * An adapter whose process went while its session was idle says so with `session_live` (false, asleep) instead of an
       * error (#1397): the handle is retired the same way, since nothing is behind it, and the next message resumes. Only
       * from the handle registered now: a set-aside handle's last word is not this session's.
       */
      if (e.type === 'session_live' && !e.live && e.reason === 'asleep' && from && this.host.handles.get(e.sessionId) === from) {
        void from.dispose().catch(() => {})
        this.host.handles.delete(e.sessionId)
        this.host.running.delete(e.sessionId)
      }
      // A lock error after a lazy resume handed the handle out (#168, item 5) leaves a handle with no thread — the same as a crash
      if (e.type === 'error' && (e.error.code === 'adapter_crashed' || e.error.code === 'conversation_locked')) {
        const dead = this.host.handles.get(e.sessionId)
        if (dead) {
          // Closed before it is removed — so a message issued during close (notice of an unsent message)
          // still arrives as a message from the registered handle (#157)
          void dead.dispose().catch(() => {})
          this.host.handles.delete(e.sessionId)
          this.host.running.delete(e.sessionId)
          // No process any more, and none coming by itself (#648): the windows stop showing it live
          this.host.emit({ type: 'session_live', sessionId: e.sessionId, live: false, reason: 'crashed' })
        }
      }
    }
    // An event that gets recorded carries its assigned in-session seq along with it — the basis for the UI's
    // unread tracking
    // Capture the answer before an event subscriber can send more input into this conversation.
    const run = e.sessionId ? this.host.agentRuns.get(e.sessionId) : undefined
    // A wait still reading this turn is owed its end (#698); one that settled earlier is left from a turn before
    const runOpen = !!run && !run.finished
    /*
     * A delegation nobody is waiting on now (ask_project or start_agent past its bound) owes its caller nothing until
     * it asks again; that caller is who hears of a stop. A call still waiting reads the stop itself.
     */
    const delegation = runOpen ? [...this.host.children.delegations.values()].find((d) => d.wait === run) : undefined
    const waited = runOpen && (!delegation || (delegation.waiters ?? 0) > 0)
    run?.onEvent(e)
    if (e.sessionId) for (const observer of this.host.turnObservers.get(e.sessionId) ?? []) observer.onEvent(e)
    /*
     * Whose the turn was (#1377), read once as it ends, from what the tool says it took in: said on the event that ends
     * it, so a hub that follows this host reads it rather than guessing. The person's own turn is reported to nobody
     */
    const owned = endedTurn && e.sessionId ? this.host.children.turnEnded(e.sessionId, this.host.handles.get(e.sessionId)?.turnInputs?.()) : undefined
    // A turn Centralu started to compact the conversation says so (#1451): the window raises no "done" for it
    const turnBy = e.sessionId && endedTurn && this.host.compactTurn(e.sessionId) ? { ...(owned ?? { by: 'work' as const }), compaction: true as const } : owned
    const said = turnBy && (e.type === 'turn_complete' || e.type === 'state_change' || e.type === 'error' || e.type === 'limit_reached') ? { ...e, turn: turnBy } : e
    this.host.emit(seq != null ? ({ ...said, seq } as NormalizedEvent) : said)
    this.closeIntoRest(e)
    // After the event that caused it, so a window reads the error first and the reason for it second (#698)
    const nowInterrupted = e.sessionId ? this.host.meta.get(e.sessionId)?.interruption ?? null : null
    if (e.sessionId && interruptionBefore !== undefined && nowInterrupted !== interruptionBefore) {
      this.host.emit({ type: 'interruption', sessionId: e.sessionId, interruption: nowInterrupted })
    }
    // Whether anyone is owed this turn's end: a report mark, or a delegation reading it (#698). Read before the report clears the mark
    const owed = endedTurn && !!e.sessionId && (this.host.children.awaitingReport.has(e.sessionId) || waited)
    /*
     * Reporting happens **no matter how the turn ends** (#166). It used to only consume the marker on
     * turn_complete, but two adapters do not emit turn_complete for a failed turn (emitting it there
     * too would end the state as "awaiting input" and hide the failure). So a failed run was never
     * reported, the marker stayed set, and a later, unrelated turn ended up reported as "it finished".
     */
    // A wait settled in an earlier turn holds that turn's answer, not this one's
    if (endedTurn && e.sessionId && !run?.tracksInputs) void this.host.reports.reportBackIfAwaited(e.sessionId, e, runOpen ? run?.completedAnswer : undefined, undefined, turnBy)
    // Work the person owns (a script or the RPC started the session with a first message) is reported to their Inbox when nobody else is owed it (§8.1)
    if (endedTurn && e.sessionId && !owed && !run?.tracksInputs) void this.host.reports.reportToPersonIfOwed(e.sessionId, e, runOpen ? run?.completedAnswer : undefined, turnBy)
    if (endedTurn && e.sessionId && !owed && turnBy?.by !== 'person') void this.host.reports.tellAskerOfInterruption(e.sessionId, delegation?.callerId)
    // A card in a delegated turn goes to the session that gave the turn too (#676); a turn-long link ends with the turn
    if ((e.type === 'question_request' || e.type === 'approval_request') && e.sessionId) this.host.cards.routeCard(e.sessionId, e.requestId, e.type === 'question_request' ? 'question' : 'approval')
    if (endedTurn && e.sessionId && this.host.children.turnOwners.get(e.sessionId)?.untilTurnEnd) this.host.children.releaseTurn(e.sessionId)
    // A hub's ask_project task ends with its turn, and the depth it gave the session with it (#838)
    if (endedTurn && e.sessionId && !this.host.hubAskTurns.has(e.sessionId) && this.host.store.settings.appSetting(hubAskDepthKey(e.sessionId)) !== null) this.host.store.settings.deleteAppSetting(hubAskDepthKey(e.sessionId))
    // The card slot is now empty — if a capability question was waiting, it is raised (D-4). Either the
    // adapter's card just closed, or a card that had been hiding ours just closed
    if (e.type === 'approval_resolved' && e.sessionId) this.host.hostCards.raiseHostAsks(e.sessionId)
    /*
     * A card still standing when the turn ends is raised again (#673): a start_agent request that answered "pending"
     * outlives the call, and the turn's own events cleared the slot meanwhile. An error is left showing; the card
     * comes back at the next turn's end
     */
    if (endedTurn && e.sessionId && this.host.meta.get(e.sessionId)?.state !== 'error') this.host.hostCards.raiseHostAsks(e.sessionId)
    // Applies a setting that changed mid-turn now (#164) — if it was reverted in between there is no drift,
    // so nothing happens
    // A commit call still unanswered when its turn ends never will be: interrupted, or its process gone (#392)
    if (endedTurn && e.sessionId) this.forgetCommits(e.sessionId)
    if (endedTurn && e.sessionId) this.host.restartPolicy.applyDeferredRestart(e.sessionId)
    // A turn ended, a card was answered or a state was stated: the mail it was holding may go (#1347)
    // Counted before anything is poked: a delivery it lets go must see the turn that just ended
    if (e.sessionId) this.host.mailEvent(e, endedTurn)
    if (e.sessionId) this.host.compactEvent(e, endedTurn)
    // A request of the turn moves the context figure before the turn's end brings the tool's reading (#1492)
    const meta = e.sessionId ? this.host.meta.get(e.sessionId) : undefined
    const estimate = meta ? this.meter.observe(e, meta) : null
    if (estimate) this.onEvent(estimate)
    if (e.sessionId && (endedTurn || e.type === 'state_change' || e.type === 'approval_resolved' || e.type === 'question_resolved')) this.host.mailPoke(e.sessionId)
    // A deferred restart also waits for the session's background work (#648): the moment it ends is a boundary too
    if (e.type === 'background_tasks' && e.sessionId) this.host.restartPolicy.applyDeferredRestart(e.sessionId)
    // A paused report's work may just have ended (#721)
    if (e.type === 'background_tasks' && e.sessionId && this.host.children.pausedReports.has(e.sessionId)) this.host.reports.settlePausedReport(e.sessionId)
  }

  /** A state hint, for storage: the core reducer's rules on the host's copy (`applySessionState`, protocol session-state.ts) */
  applyStateHint(e: NormalizedEvent, m: SessionInfo): void {
    const from = m.state
    // An illegal transition is ignored and logged, as the window does (docs/state-management.md §2)
    if (applySessionState(m, e, Date.now()).illegal) console.warn(`[agent-host] ignored ${e.type} for ${m.id.slice(0, 8)}: ${from} cannot go to ${nextStateFor(e)}`)
    this.trackLiveFacts(e, m)
  }

  /**
   * An adapter's card raised between turns closes back into that rest once answered (#428), as the host's own cards do
   * (`restAfterCard`, host-cards.ts): without `onEvent`, since no turn ended (no report, no deferred restart).
   */
  private closeIntoRest(e: NormalizedEvent): void {
    const m = e.sessionId ? this.host.meta.get(e.sessionId) : undefined
    const rest = m ? this.host.cardRests.restAfter(e, m) : null
    if (!m || rest === null) return
    this.settleState(m, { type: 'state_change', sessionId: m.id, state: rest })
  }

  /**
   * A state the host itself states (a resume, a tool change, a card's rest): through the same rules as an event, so the
   * stored copy is what the window makes of the same `state_change` (#428), then stored and broadcast. Not `onEvent`:
   * no turn ended.
   */
  settleState(m: SessionInfo, change: Extract<NormalizedEvent, { type: 'state_change' }>): void {
    // The host has said what the state is: no card rest or asked-for turn of before stands over it
    this.host.cardRests.forget(m.id)
    this.applyStateHint(change, m)
    this.host.store.sessions.upsertSession(m)
    this.host.emit(change)
    // At rest by a statement, not a turn's end that `onEvent` would see: a request queued for it goes in now (#677)
    if (!inTurn(m.state) && this.host.children.queued.has(m.id)) this.host.queue.scheduleDrain(m.id)
    this.host.mailPoke(m.id)
  }

  /**
   * Records the **live facts** in metadata that a reconnected UI needs to pick back up.
   *
   * While SessionInfo had none of these fields, a UI that disconnected and came back received only
   * state=waiting_approval, and **had no payload to draw the approval card with** — with no requestId
   * either, it could not even respond. These are never put in the DB (upsert does not know these
   * fields) — if the host restarts, they really are gone. The context reading is the exception (#48,
   * store v17). The cards, the activity and the limit are set with the
   * state they belong to (`applySessionState`, protocol session-state.ts); these are the rest.
   */
  private trackLiveFacts(e: NormalizedEvent, m: SessionInfo): void {
    switch (e.type) {
      case 'usage_update': {
        m.usage = e.tokens
        const counted = e.request && this.host.cacheLedger.record(m.tool, m.id, e.request, undefined, m.model)
        if (e.request && counted) this.host.usageRecorder.request({ sessionId: m.id, projectId: m.projectId, tool: m.tool, model: m.model ?? undefined }, e.request, counted)
        break
      }
      case 'turn_complete':
        // A turn end is when a window has just moved: read the limits (at most every couple of minutes) for the history
        this.host.usageRecorder.turnEnded(m.tool, (tool) => this.host.usageFor(tool))
        break
      case 'context_update':
        m.context = nextContext(m.context, e)
        // An estimate from a request (#1492) is no reading of the model's window: the tool's own readings say that
        if (e.exactness !== 'estimate') this.host.modelWindows.note(m, e.window, e.model)
        break
      case 'conversation_reset':
        // The old conversation's reading no longer describes anything (#304); the tool reports the new one when the turn ends
        m.context = nextContext(m.context, e)
        this.host.cacheLedger.note(m.id, 'compaction')
        break
      case 'compaction':
        // The size it came out at, until the tool's next reading (#1282); stored with the session like any reading
        m.context = nextContext(m.context, e)
        // The conversation the next request sends begins with a summary the cache has never seen (§6.1)
        this.host.cacheLedger.note(m.id, 'compaction')
        break
      case 'goal':
        // The goal (2026-09-07) is a live field too — after a restart, the tool tells us again (codex fetches
        // it on resume)
        m.goal = e.goal
        break
      case 'background_tasks':
        // The same merge the UI's reducer and the mock run (#290), so a reconnect reads back what the screen showed
        m.backgroundTasks = applyBackgroundTasks(m.backgroundTasks, e)
        /*
         * Kept for the host that may adopt this process (#648). Only the tool's own full list settles what an adopted
         * process holds: a level built from an ending or a `/loop` timer says nothing of a shell this host never saw,
         * and recording it would hand the next host a list it takes as complete.
         */
        if (e.snapshot) this.host.restartPolicy.backgroundUnknown.delete(m.id)
        if (!this.host.restartPolicy.backgroundUnknown.has(m.id)) this.host.launches.rememberBackgroundTasks(m)
        break
      case 'agent_version':
        // What the process says it runs (#297) replaces what was assumed when it started
        m.agentVersion = e.version
        break
    }
  }

  /** A tool_call's callId -> the session that call's `git commit` belonged to (#50) */
  private pendingCommits = new Map<string, string>()

  forgetCommits(sessionId: string): void {
    for (const [callId, sid] of this.pendingCommits) if (sid === sessionId) this.pendingCommits.delete(callId)
  }

  /**
   * Commit attribution with no hooks involved (#50). An agent's commit happens through a tool call,
   * and its output already sits in this stream — the hash is picked up from the `[branch abc1234]`
   * line, and if the output got truncated, the current HEAD is that commit. Nothing is written to the
   * repository itself (decided 2026-08-23).
   */
  observeCommit(e: Extract<NormalizedEvent, { type: 'tool_call' | 'tool_result' }>, m: SessionInfo): void {
    if (e.type === 'tool_call') {
      if (looksLikeGitCommit(e.summary.title)) this.pendingCommits.set(e.callId, m.id)
      return
    }
    const sid = this.pendingCommits.get(e.callId)
    if (!sid) return
    this.pendingCommits.delete(e.callId)
    const projectId = m.projectId
    if (!e.ok || !projectId) return
    const sha = parseCommitSha(e.summary)
    if (sha) {
      this.host.store.sessions.recordCommit(projectId, sha, sid)
      return
    }
    void gitHeadSha(this.host.cwdOf(projectId))
      .then((head) => head && this.host.store.sessions.recordCommit(projectId, head, sid))
      .catch(() => {})
  }

  /**
   * The body of send() — takes one more flag for **whether this is an instruction or a relay** (#120).
   *
   * While the gate only looked at the sender's profile, a report from a manager or coordinator just
   * passed straight through. That is because what a profile answers is "can this message be trusted
   * as an instruction", not "is this someone else's words". A report **is someone else's words no
   * matter who relays it**, so it is flagged right where the relaying happens. This flag is never
   * exposed on send(), which anything else can call — a boundary that can be flipped on by accident
   * is not a boundary.
   */
  async deliver(
    sessionId: string,
    text: string,
    attachments: Attachment[] | undefined,
    from: { sessionId: string; name: string } | undefined,
    /** Is this a body carrying over someone else's conversation (the report path)? An instruction is false —
     * it must be the original text */
    relayed: boolean,
    /** If this message came from an inline app view, that app (M4 B-1). Reaches the agent wrapped as the
     * app's text */
    fromApp?: AppMessageSource,
    /**
     * Which route the app's text came through — an inline view's message (B-1), a pinned view's
     * message (it came from outside the conversation, B-4), or work the app asked for (D-1) each get
     * a different header (`appMessageFrame`)
     */
    fromAppVia: AppMessageVia = 'inline',
    sendInput?: (handle: SessionHandle, text: string) => void,
    /**
     * What the message rests on, read once the session is awake and before anything is written: a reason refuses it.
     * A wake or a restart waited out here takes seconds, and the trust a task was let through on can go meanwhile.
     */
    stillAllowed?: () => string | null,
    /**
     * For a relayed message, what the agent reads instead of the bare wake (#1186): the words Centralu wrote about the
     * other session, never that session's own (`ChildReports.tellSession`'s `forModel`). The rest of the input, a
     * line Centralu adds once (`rootAppsNotice`), goes with it as with any other text
     */
    relayedText?: string,
    /**
     * The person typed this themselves (the composer, a slash command, Continue): the tool is told so. Never set for a
     * message that has a source, or for words Centralu framed (a report, an app's notice, a builder request). Not stamped
     * either when Centralu puts a line of its own in front of it (`rootAppsNotice`, once).
     */
    fromPerson = false,
    /** What the person chose for a delegation report the session owes (#1377); the default is "just asking" */
    intent: 'ask' | 'task' | 'takeover' = 'ask',
    /**
     * A script wrote this (a call with the limited credential, `label` from the connection, §8.1): stored and shown as the script's, handed to
     * the session under Centralu's header (`scriptMessageFrame`), never stamped as the person's and never naming the session. Set by the
     * host from the connection, not from a field of the call
     */
    fromScript?: { credential: string },
  ): Promise<void> {
    const restarting = this.host.restartPolicy.deferredRestarts.get(sessionId)
    if (restarting) await restarting
    const m = this.host.openSession(sessionId)

    /*
     * A wake in progress is waited out, through the same call as the send that woke it (#839): its process is registered
     * before the catch-up, and the message that woke it goes in only after that. Going straight to the process, a second
     * send overtook it.
     */
    if (this.host.resuming.has(sessionId) && this.host.handles.has(sessionId)) await this.host.resumeSession(sessionId)
    if (!this.host.handles.has(sessionId)) {
      const r = await this.host.resumeSession(sessionId)
      if (!r.resumed) {
        throw rpcError(`Could not resume the conversation: ${r.reason ?? 'unknown reason'}`, 'session_not_found')
      }
    }
    const refused = stillAllowed?.()
    if (refused) throw rpcError(refused)

    this.host.notBeingRemoved(sessionId)
    const h = this.host.requireHandle(sessionId)
    // A message from the person is always a message boundary — continuing after an interrupt means everything
    // before it is one chunk (#66)
    this.host.record.closeStream(sessionId)
    const seq = this.host.store.messages.nextSeq(sessionId)
    this.host.store.messages.appendMessages([
      {
        sessionId,
        seq,
        role: 'user',
        kind: 'text',
        // An attachment is part of the message too — only its path is kept (D-1), and loadMessages loads the
        // image bytes back in
        payload: { text, ...(from ? { from } : {}), ...(fromApp ? { fromApp } : {}), ...(fromScript ? { fromScript } : {}), ...(attachments?.length ? { attachments } : {}) },
        ts: Date.now(),
      },
    ])
    m.lastSeq = seq
    m.lastReadSeq = seq // Something we sent counts as read
    // A session's name is never coined from a message an app or another session sent (ask_project's task, a
    // parent's note, an orchestrator's instruction, #646) — the name always comes from the person's own words
    if (m.autoNamed && m.name === 'New session' && !fromApp && !from && !fromScript) {
      m.name = truncate(text)
      this.host.emit({ type: 'session_title', sessionId, title: m.name, auto: true })
    }
    this.host.store.sessions.upsertSession(m)
    /*
     * **Announces that a message was added.**
     *
     * This never used to be announced. The UI was the only place that ever produced a user message,
     * so the UI drawing its own was enough. That assumption broke once the orchestrator became a
     * second producer — an injected message was saved, but it never showed up on screen at all.
     */
    this.host.emit({
      type: 'user_message',
      sessionId,
      seq,
      text,
      ...(from ? { from } : {}),
      ...(fromApp ? { fromApp } : {}),
      ...(fromScript ? { fromScript } : {}),
      ...(!from && !fromApp && !fromScript && intent !== 'ask' ? { intent } : {}),
      // A message the host injected (an app's composer, C-5) only ever surfaces on screen through this event
      // — attachments have to ride along too, or the bubble is incomplete
      ...(attachments?.length ? { attachments } : {}),
    })
    /*
     * The one place that swaps a vendor adapter's input for a sourceSessionId wake — there are two branches.
     *  - A relayed body: someone else's words no matter who sent them. Swapped unconditionally.
     *  - A lower-privilege instruction with a known source: swapped only when it is going to a target
     *    that has tools. An instruction between tool profiles, and an ordinary worker instruction, must
     *    stay the original text (#90).
     * Raw provenance stays in the store/UI, and the relayed body is only ever read as observation data via
     * read_session.
     */
    const adapterText =
      fromApp ? appMessageFrame(fromApp, text, fromAppVia)
      // A script's text reaches the session as the script's, quoted under Centralu's header (§8.1)
      : fromScript ? scriptMessageFrame(fromScript.credential, text)
      // A hub's orchestrator directs as this host's own does (`sendFromHub`)
      : relayed && from && relayedText !== undefined ? relayedText
      : from && (relayed || (this.host.tools.directs(sessionId) && !this.host.tools.directs(from.sessionId) && from.sessionId !== HUB_SENDER))
        ? untrustedSourceSessionNotification(from.sessionId)
        : attachments?.length
          ? `${text}\n\n${attachments.map((a) => `@${a.path}`).join('\n')}`
          : text
    // An orchestrator that had root apps attached reads once why their names are gone (#1205); never stored or shown
    const notice = this.host.apps.rootAppsNotice(sessionId)
    const input = notice ? `[Centralu] ${notice}\n\n${adapterText}` : adapterText
    // Whose turn this message makes, or joins (#1377): only the person's own message (no source) is theirs
    const joins = inTurn(m.state) && this.host.joinsRunningTurn(sessionId)
    // Named, so the turn that ends can say whether it took this message in (`SessionHandle.turnInputs`)
    const inputId = joins ? randomUUID() : undefined
    this.host.children.noteMessage(sessionId, !from && !fromApp && !fromScript ? 'person' : 'work', inTurn(m.state), this.host.joinsRunningTurn(sessionId), intent === 'task', inputId, relayed ? 'report' : fromApp ? 'app' : 'caller')
    // A turn is asked for now, whether or not the tool announces it before its first card (`CardRests`)
    this.host.cardRests.turnAsked(sessionId)
    if (sendInput) sendInput(h, input)
    // Not with a line of Centralu's in front of it: that message is not only the person's words
    else if (fromPerson && !notice) h.send(input, { origin: { kind: 'human' }, ...(inputId ? { id: inputId } : {}) })
    else h.send(input, inputId ? { id: inputId } : undefined)
    // It takes messages again: what could not be told it before goes in now (#1186)
    this.host.reports.deliverHeld(sessionId)
  }

  /**
   * The mailbox's delivery to a session (#1347, docs/plans/mailbox.md §7.1): the wake frame, as the CLI's input stamped as the
   * channel of Centralu, and a compact line in the conversation (§9.2). Never a message of the person's: no user row is written,
   * so nothing in the conversation reads as them. `quiet` goes into a live process without a turn; otherwise the session is woken
   * (resumed if it sleeps), as a message to it is. Throws when the tool does not take it, and the mailbox tries again
   */
  async deliverMail(
    sessionId: string,
    input: { text: string; quiet: boolean; line: string },
    gate: { leaving(): boolean; atRest(): boolean } = { leaving: () => false, atRest: () => true },
    late?: (e: Error) => void,
  ): Promise<void> {
    // Asked again after every wait and right before the send: what was true when the delivery began may not be (§4.2, §7.1)
    const clear = () => {
      if (gate.leaving()) throw rpcError('Centralu is restarting: the mail waits for the next host')
      if (!gate.atRest()) throw new MailNotAtRest()
    }
    const restarting = this.host.restartPolicy.deferredRestarts.get(sessionId)
    if (restarting) await restarting
    this.host.openSession(sessionId)
    if (input.quiet) {
      const handle = this.host.handles.get(sessionId)
      if (!handle) throw rpcError('The session is not running: quiet mail waits for its next wake')
      clear()
      handle.send(input.text, { origin: { kind: 'channel', server: 'centralu' }, quiet: true })
    } else {
      // A wake in progress is waited out, then the session is woken if it sleeps, as for any message (#839)
      if (this.host.resuming.has(sessionId) && this.host.handles.has(sessionId)) await this.host.resumeSession(sessionId)
      if (!this.host.handles.has(sessionId)) {
        const r = await this.host.resumeSession(sessionId)
        if (!r.resumed) throw rpcError(`Could not resume the conversation: ${r.reason ?? 'unknown reason'}`, 'session_not_found')
      }
      // The host started to leave while the session was waking, or the person started a turn in it: the mail waits, and this sends nothing
      clear()
      this.host.notBeingRemoved(sessionId)
      const handle = this.host.requireHandle(sessionId)
      this.host.record.closeStream(sessionId)
      // A turn is asked for now, whether or not the tool announces it before its first card (`CardRests`)
      this.host.cardRests.turnAsked(sessionId)
      await takeInput(handle, input.text, late)
    }
    // After the tool took it, so the line is never about a delivery that did not happen; before the answer it starts
    this.onEvent({ type: 'notice', sessionId, level: 'info', from: 'Centralu', label: 'mail', text: input.line })
  }

  /**
   * Centralu's own compact command (#1451): the tool's `/compact` as a turn of its own, in no one's name and with no user row,
   * so nothing in the conversation reads as the person. Only a live process takes it; the caller has checked the session is at
   * rest or has just ended its turn.
   */
  sendCompact(sessionId: string, text: string): void {
    const handle = this.host.handles.get(sessionId)
    if (!handle) throw rpcError('The session is not running')
    this.host.record.closeStream(sessionId)
    // A turn is asked for now, whether or not the tool announces it before its first card (`CardRests`)
    this.host.cardRests.turnAsked(sessionId)
    handle.send(text)
  }

  /**
   * Turns a touched file into a path relative to the project (#185).
   *
   * The tool gives an absolute path (Claude's `file_path`, Codex's `fileChange`). Entries in the file
   * tree use paths relative to the project, so left as-is the "edited by agent" indicator never
   * matched anything at all. Anything that already came as a relative path is read relative to the
   * folder the session runs in. A path outside the project (a worktree session's own files, a
   * settings file in the home directory) is discarded — that file does not exist in the project tree,
   * and marking a different file that happens to share the same relative path would be a lie.
   */
  private projectRelative(e: Extract<NormalizedEvent, { type: 'files_touched' }>): NormalizedEvent {
    const m = this.host.meta.get(e.sessionId)
    let root: string
    try {
      if (!m?.projectId) return { ...e, paths: [] }
      root = this.host.cwdOf(m.projectId)
    } catch {
      return { ...e, paths: [] }
    }
    const base = this.host.cwdFor(m)
    // Both sides canonical (#428): a tool names its files under the real path of a root kept through a link (macOS's
    // `/tmp` is `/private/tmp`), and compared as written they fell outside and were dropped
    const rootReal = canonicalPath(root)
    const paths = new Set<string>()
    for (const p of e.paths) {
      const target = canonicalPath(resolve(base, p))
      const rel = relative(rootReal, target)
      if (!rel || !isInside(rootReal, target)) continue
      // git and the screen both speak in POSIX separators (#47) — so does a tree entry's path
      paths.add(rel.replaceAll(sep, '/'))
    }
    return { ...e, paths: [...paths] }
  }
}
