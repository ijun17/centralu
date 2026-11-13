import { relative, resolve, sep } from 'node:path'
import type { Attachment, Interruption, NormalizedEvent, SessionInfo, ToolName, TurnOrigin } from '@cc/protocol'
import { CONTINUE_WORDS, applyBackgroundTasks, applySessionState, nextContext, nextStateFor } from '@cc/protocol'
import type { ToolQueriesHost } from './tool-queries.js'
import type { SessionHandle } from '../adapters/contract.js'
import { centraluInputId } from '../adapters/input-receipts.js'
import { gitHeadSha } from '../dev-services/git.js'
import { looksLikeGitCommit, parseCommitSha } from '../dev-services/git-attrib.js'
import { canonicalPath, isInside } from '../dev-services/path-guard.js'
import { inTurn } from '../idle.js'
import { rpcError } from '../rpc-error.js'
import { MailNotAtRest, MailWithdrawn, type MailInput } from '../mail/delivery.js'
import { takeInput } from './mail-accept.js'
import type { StopTold, StopWhy } from '../mail/stop-notices.js'
import type { TurnInputs } from '../mail/delivery.js'
import { heldToContinue, stopOf } from './interruptions.js'
import { hubAskDepthKey } from './agent-depth.js'
import { ContextMeter } from './context-meter.js'
import { scriptMessageFrame } from './script-messages.js'
import { appMessageFrame, type AppMessageSource, type AppMessageVia } from './app-messages.js'
import type { ChildReports } from './child-reports.js'
import { type DelegationHost } from './delegation-flow.js'
import { isHubSender } from './hub-sender.js'
import { truncate } from './external-conversations.js'
import { labelOf } from './transcript-view.js'
import type { InterruptionWatch } from './interruption-watch.js'
import type { TurnContinue } from './turn-continue.js'
import type { RoutedCards } from './routed-cards.js'
import type { SessionRecordHost } from './session-record.js'
import type { SessionStartsHost } from './session-start.js'
import type { SessionTrashHost } from './session-trash.js'
import type { WorktreeHost } from './worktree-sessions.js'
import type { SelfCompaction } from './self-compaction.js'

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
    /** Whether the session's tool reads the context size with every request, so a turn needs no estimate of it (`contextAtRequest`) */
    contextAtRequest(sessionId: string): boolean
    /** Sessions whose hub task's input is tracked (`sendFromHub`): its own turn takes the depth mark down, no other */
    readonly hubAskTurns: Set<string>
    readonly interruptions: InterruptionWatch
    /** A stopped turn waiting for its cause to clear to be continued (turn-continue.ts) */
    readonly turnContinue: TurnContinue
    /** Refuses a session whose worktree is being removed */
    notBeingRemoved: (sessionId: string) => void
    readonly reports: ChildReports
    /** A session's live process, or `session_not_found` */
    requireHandle: (sessionId: string) => SessionHandle
    /** Something about a session changed that may let its mail go (#1347): it came to rest, a card was answered. Never throws */
    mailPoke: (sessionId: string) => void
    /** An event of a session, and whether it ended its turn: what the mail guards count (§7.9). Never throws */
    mailEvent: (e: NormalizedEvent, endedTurn: boolean) => void
    /**
     * A turn ended without finishing, and why: the senders of what it left unanswered, and the session that started it, are told once
     * (`StopNotices.sessionStopped`), except `told`, whom it already reached. Never throws
     */
    mailStopped: (sessionId: string, why: StopWhy, opts: StopTold) => void
    /** A turn ended as a turn does: the sessions whose requests it carried are answered (S12, `MailHooks.requestTurnEnded`). Never throws */
    mailRequestTurnEnded: (sessionId: string) => void
    /** What the tool said of the mail given it, at a turn's end or opening (`MailDelivery.turnInputs`). Never throws */
    mailTurnInputs: (sessionId: string, turn: TurnInputs) => void
    /** An event of a session, and whether it ended its turn: what compaction at a break reads (#1451, self-compaction.ts). Never throws */
    compactEvent: (e: NormalizedEvent, endedTurn: boolean) => void
    /** Whether the session's running turn is one Centralu started to compact it (#1451) */
    readonly selfCompaction: Pick<SelfCompaction, 'compactTurn' | 'stepOpens'>
    resumeSession: (sessionId: string) => Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  }

/**
 * What a session's tool says, received: kept on the session, stored, broadcast, and what its turn's end settles
 * (`onEvent`); a state the host states itself (`settleState`); the commits a tool call makes; and what goes into a
 * session's conversation (`deliver`). Moved out of the session manager as it was (#428); what it reaches of the
 * manager is `SessionEventsHost`.
 */
export class SessionEvents {
  /** The context figure during a turn, from each request's size (#1492, context-meter.ts) */
  private readonly meter = new ContextMeter()

  constructor(private readonly host: SessionEventsHost) {}

  /** Receive event -> update metadata -> persist message -> broadcast */
  onEvent(raw: NormalizedEvent, from: SessionHandle | null = null): void {
    let e = raw.type === 'files_touched' ? this.projectRelative(raw) : raw
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
    // A turn the provider ended because its servers are at capacity is not ended yet: a retry is waited for (#1693, turn-continue.ts)
    if (e.type === 'error') e = this.host.turnContinue.hold(e)
    if (e.sessionId) this.host.turnContinue.observe(e)
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
    // What the tool read is against the window it reports; what the screen and the agent are told is against the model's (#1553)
    if (e.type === 'context_update' && e.exactness !== 'estimate') e = this.shareOf(e)
    if (e.type === 'settings_changed' && e.by === 'tool') {
      this.host.record.recordToolSettings(e)
      return
    }
    // Text the tool repeats on every start (#304): one stored line per session is enough
    if (e.type === 'notice' && e.oncePerSession && e.sessionId && this.host.store.handoffs.hasNotice(e.sessionId, e.text)) return
    let seq: number | null = null
    /** This event ended the turn — how it ended (completed, error, canceled, limit) is stated by this event itself */
    let endedTurn = false
    let started: TurnOrigin | undefined
    /** This event opened a turn that goes on with the work of the turn before, after a compaction (#2164) */
    let continues = false
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
        // A stop the network or a usage limit made waits to be continued, stored with the interruption below (#1415)
        this.host.turnContinue.armAfter(e, m, wasBusy && !inTurn(m.state))
        // Heard from: an unknown background state is bounded by quiet, not by age (#648, `backgroundKnown`)
        if (this.host.restartPolicy.backgroundUnknown.has(m.id)) this.host.restartPolicy.backgroundUnknown.set(m.id, Date.now())
        /*
         * A builder session's turn ended (M4 C-4) — this is the moment to relaunch that app from its
         * files. It happens once, right here, rather than every time the app's folder changes: an app
         * mid-turn is code that is only half fixed. The runtime itself decides whether it actually
         * changed or whether a call is still in flight.
         */
        // A turn starts (#1377): a first guess at whose it is, from the message it started with, else the CLI's own
        if (!wasBusy && inTurn(m.state)) {
          continues = this.host.selfCompaction.stepOpens(m.id)
          this.host.children.turnStarted(m.id)
          // Its own text is every row after the last one stored now (#1604): what a hub reads of it is that, not the turn before's
          this.host.children.noteTurnStart(m.id, m.lastSeq)
        }
        /*
         * The message the tool ran this turn for, when a sender gave it (#1604): said on the event that opens the turn. Not
         * only when this host saw the session go from rest to work: a message given at rest has the session working already
         * when the tool opens the turn it runs for an earlier one (a note sent into the turn before, which that turn did not
         * read). The tool names the input only on the event that opens the turn, so no other event says one
         */
        if (e.type === 'state_change' && e.state === 'working') {
          const named = handle?.turnStartInputs?.()
          // Whose the turn is, decided by the inputs the tool names it opened from (#1639); and the hub's message it ran for
          started = this.host.children.turnNamed(m.id, named)
          // Mail a turn before did not take and this one opens for is this turn's (docs/plans/mailbox.md §10.6.3)
          if (named?.length) this.host.mailTurnInputs(m.id, { opened: named })
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
        // The tool said it is idle, so a turn the session still reads as running had its end lost, and no process is left to send one (#1829).
        // Not a card of the host's own (#673): it was raised between turns, needs no process, and closes into its own rest
        const m = this.host.meta.get(e.sessionId)
        const hostCard = !!m?.pendingApproval && this.host.hostCards.hostAsks.has(m.pendingApproval.requestId)
        if (m && inTurn(m.state) && !hostCard) this.onEvent({ type: 'state_change', sessionId: e.sessionId, state: 'waiting_input' })
      }
      // A lock error after a lazy resume handed the handle out (#168, item 5) leaves a handle with no thread — the same as a crash
      if (e.type === 'error' && (e.error.code === 'adapter_crashed' || e.error.code === 'conversation_locked')) {
        const dead = this.host.handles.get(e.sessionId)
        if (dead) {
          // Closed before it is removed — so a message issued during close (notice of an unsent message) still arrives as a message from the registered handle (#157)
          void dead.dispose().catch(() => {})
          this.host.handles.delete(e.sessionId)
          this.host.running.delete(e.sessionId)
          // No process any more, and none coming by itself (#648): the windows stop showing it live
          this.host.emit({ type: 'session_live', sessionId: e.sessionId, live: false, reason: 'crashed' })
        }
      }
    }
    // An event that gets recorded carries its assigned in-session seq along with it — the basis for the UI's unread tracking
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
     * Whose the turn was (#1377), read once as it ends, from the rows of what the tool says it took in: said on the event that ends
     * it, so a hub that follows this host reads it rather than guessing (`LinkedReports`). The person's own turn is reported to nobody
     */
    // The process went with the turn (a crash, a lost conversation): it runs none of the messages given it after. Any other error or limit leaves it, and a message it holds queued can still run (#1604)
    const processWent = e.type === 'error' && (e.error.code === 'adapter_crashed' || e.error.code === 'conversation_locked')
    const taken = endedTurn && e.sessionId ? this.host.handles.get(e.sessionId)?.turnInputs?.() : undefined
    const owned = endedTurn && e.sessionId ? this.host.children.turnEnded(e.sessionId, taken) : undefined
    // A turn Centralu started to compact the conversation says so (#1451): the window raises no "done" for it
    const turnBy = e.sessionId && endedTurn && this.host.selfCompaction.compactTurn(e.sessionId) ? { ...(owned ?? { by: 'work' as const }), compaction: true as const } : owned
    // Where it began (#1812), when kept: a hub reads this turn's words by it, though the next one has begun or ended by then
    const since = turnBy && e.sessionId ? this.host.children.turnRows(e.sessionId)?.after : undefined
    const turnSaid = turnBy && (e.type === 'turn_complete' || e.type === 'state_change' || e.type === 'error' || e.type === 'limit_reached') ? { ...e, turn: since === undefined ? turnBy : { ...turnBy, since } } : e
    // What the turn it opens ran for, or goes on with (#2164), said with it so a hub that follows this host reads whose it is (#1604)
    const said = e.type === 'state_change' && (started || continues) ? { ...turnSaid, ...(started ? { origin: started } : {}), ...(continues ? { continues: 'compaction' as const } : {}) } : turnSaid
    this.host.emit(seq != null ? ({ ...said, seq } as NormalizedEvent) : said)
    this.closeIntoRest(e)
    // After the event that caused it, so a window reads the error first and the reason for it second (#698)
    const nowInterrupted = e.sessionId ? this.host.meta.get(e.sessionId)?.interruption ?? null : null
    if (e.sessionId && interruptionBefore !== undefined && nowInterrupted !== interruptionBefore) {
      this.host.emit({ type: 'interruption', sessionId: e.sessionId, interruption: nowInterrupted })
    }
    /*
     * A turn that ends without finishing leaves the questions delivered into it unanswered: their senders are told once (docs/plans/turn-owned-by-no-one.md
     * §4.1). Not the turn Centralu started to compact the conversation, and not a turn Centralu is continuing (an update's cut, #1975): that end is not the work's.
     * Told so no matter how the turn ends (#166): two adapters emit no turn_complete for a failed turn
     */
    // The mail given into the turn that it did not take waits in the tool for a turn after, and is not this turn's (§10.6.3); one whose process went took all with it
    if (endedTurn && e.sessionId) this.host.mailTurnInputs(e.sessionId, { took: processWent ? undefined : taken })
    const workEnded = endedTurn && !!e.sessionId && !this.host.selfCompaction.compactTurn(e.sessionId)
    // The end of a turn an update cut, before its Continue is in, is not the work's stop: the continued turn's end answers
    const stopWhy = workEnded && e.sessionId && !this.host.restartPolicy.continuingTurns.has(e.sessionId) ? stopOf(e, nowInterrupted) : null
    if (stopWhy && e.sessionId) {
      this.host.reports.turnStopped(e.sessionId)
      // A stop Centralu waits to continue is told when the wait ends (#1415: told once, when the work continues)
      const held = heldToContinue(nowInterrupted)
      this.host.mailStopped(e.sessionId, stopWhy, { ...this.stopTold(e.sessionId, waited, delegation?.callerId), ...(held ? { held } : {}) })
    } else if (workEnded && e.sessionId) {
      // It ended as a turn does: the requests it carried are answered (S12), and at rest its last response answers the tasks it did not reply to
      // (docs/plans/mailbox.md §10.6.3). A call still waiting reads its own answer as it returns, which marks the report read (`answerRecorder`)
      this.host.mailRequestTurnEnded(e.sessionId)
      this.host.reports.turnEndedAtRest(e.sessionId, !!owned?.cut)
    }
    // A card goes to the givers of the session's open work too (#676, docs/plans/mailbox.md §10.6.4); one that is gone takes back a notice not given yet
    if ((e.type === 'question_request' || e.type === 'approval_request') && e.sessionId) this.host.cards.routeCard(e.sessionId, e.requestId, e.type === 'question_request' ? 'question' : 'approval')
    if ((endedTurn || e.type === 'question_resolved' || e.type === 'approval_resolved') && e.sessionId) this.host.cards.cardsEnded(e.sessionId)
    // A hub's ask_project task ends with its turn, and the depth it gave the session with it (#838)
    if (endedTurn && e.sessionId) this.endHubAsk(e.sessionId)
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
    const estimate = meta ? this.meter.observe(e, meta, this.host.contextAtRequest(meta.id)) : null
    if (estimate) this.onEvent(estimate)
    if (e.sessionId && (endedTurn || e.type === 'state_change' || e.type === 'approval_resolved' || e.type === 'question_resolved')) this.host.mailPoke(e.sessionId)
    // A deferred restart also waits for the session's background work (#648): the moment it ends is a boundary too
    if (e.type === 'background_tasks' && e.sessionId) this.host.restartPolicy.applyDeferredRestart(e.sessionId)
    // The session's own background work may just have ended (#721): at rest, its last response answers once settled
    if (e.type === 'background_tasks' && e.sessionId) this.host.reports.settleAtRest(e.sessionId)
  }

  /**
   * The tool's reading of the context, as the rest of the host and the screens see it (#1553): `window` is the model's full window
   * (`ModelWindows.shareWindow`), `capped` says it is not known, `compactAt` is where the adapter says the session's process compacts. The reading
   * itself is what `ModelWindows` learns the model's window from, so it is noted first, against the window the tool reported. An
   * estimate from a request (#1492) is no reading of the model's window and carries what the last reading did (`ContextMeter`).
   */
  /** Who already knows of this stop: a call still waiting, which read the end itself (`told`); and the session that gave the turn or started it */
  private stopTold(id: string, waited: boolean, caller: string | undefined): StopTold {
    const asker = caller ?? this.host.meta.get(id)?.askedBy ?? undefined
    if (!asker || !this.host.meta.has(asker)) return { starter: null }
    return { ...(waited ? { told: [asker] } : {}), starter: asker }
  }

  private shareOf(e: Extract<NormalizedEvent, { type: 'context_update' }>): NormalizedEvent {
    const m = this.host.meta.get(e.sessionId)
    if (!m) return e
    this.host.modelWindows.note(m, e.window, e.model)
    const { window, capped } = this.host.modelWindows.shareWindow(m, e.window)
    // The adapter's point, where the process really compacts; one not under the window says nothing (a window that shrank since the start)
    const { compactAt: said, ...rest } = e
    const compactAt = said !== undefined && said > 0 && said < window ? said : null
    return { ...rest, window, ...(capped ? { capped: true } : {}), ...(compactAt !== null ? { compactAt } : {}) }
  }

  /** A state hint, for storage: the core reducer's rules on the host's copy (`applySessionState`, protocol session-state.ts) */
  /**
   * A hub's ask_project task ends with its turn, and the depth it gave the session with it (#838): taken down at every end of a turn, here
   * and by a turn the host ends itself (`HostTenure.turnLostInSwap`, #2020). Not while the task's own input is tracked: its end is
   * the one that takes the mark (`LinkedHost.sendFromHub`)
   */
  endHubAsk(sessionId: string): void {
    const key = hubAskDepthKey(sessionId)
    if (!this.host.hubAskTurns.has(sessionId) && this.host.store.settings.appSetting(key) !== null) this.host.store.settings.deleteAppSetting(key)
  }

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
   * What goes into a session's conversation (`deliverNow`), after a continue waiting for its cause to clear (turn-continue.ts: an overloaded
   * provider, the network, a usage limit) is taken away: a message into the session carries the work on itself, and wins over a retry note on its way (a restart waited out
   * while it is sent). Taken away first, before any wait: the retry's own send checks it right before it hands the note to the tool.
   * If the message is then refused, the turn it was meant to carry on is over, and the error the retry stood in for ends it.
   */
  async deliver(...args: Parameters<SessionEvents['deliverNow']>): Promise<void> {
    const [sessionId, text, , from, relayed, fromApp] = args
    // The person's own Continue (the inbox's, the header's Continue now): told as the work going on once it went in, as the stop if it did not
    const continued = text === CONTINUE_WORDS && !from && !relayed && !fromApp ? this.host.turnContinue.personContinues(sessionId) : null
    const held = this.host.turnContinue.supersede(sessionId)
    try {
      await this.deliverNow(...args)
    } catch (e) {
      continued?.(false)
      if (held !== null) this.host.turnContinue.lost(sessionId, held)
      throw e
    }
    continued?.(true)
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
  async deliverNow(
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
    /** `inputId`: the name this message goes in under when it joins a running turn, for the tool to name it back (`turnInputs`, `turnStartInputs`) */
    sendInput?: (handle: SessionHandle, text: string, inputId?: string) => void,
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
    // Every message goes in named, so the tool says which turn runs it (#1639, `turnStartInputs`, `turnInputs`), with Centralu's mark as every
    // input the adapter names itself, so its line reads back as one Centralu wrote (`centraluInputId`)
    const inputId = centraluInputId()
    this.host.store.messages.appendMessages([
      {
        sessionId,
        seq,
        role: 'user',
        kind: 'text',
        // An attachment is part of the message too — only its path is kept (D-1), and loadMessages loads the
        // image bytes back in
        // The input id it goes in under and whether it is a report (#1639): the record of whose a turn it starts is.
        // `byPerson`: sent from the window (the composer, or the handoff prompt and Continue text the person's click sends), the one mark a request's citation accepts (docs/plans/cited-requests.md §3)
        payload: { text, ...(from ? { from } : {}), ...(fromApp ? { fromApp } : {}), ...(fromScript ? { fromScript } : {}), ...(fromPerson ? { byPerson: true } : {}), ...(attachments?.length ? { attachments } : {}), inputId, ...(relayed ? { relayed: true } : {}) },
        ts: Date.now(),
      },
    ])
    m.lastSeq = seq
    m.lastReadSeq = seq // Something we sent counts as read
    // A session's name is never coined from a message an app or another session sent (ask_project's task, a
    // parent's note, an Assistant's instruction, #646) — the name always comes from the person's own words
    if (m.autoNamed && m.name === 'New session' && !fromApp && !from && !fromScript) {
      m.name = truncate(text)
      this.host.emit({ type: 'session_title', sessionId, title: m.name, auto: true })
    }
    this.host.store.sessions.upsertSession(m)
    /*
     * **Announces that a message was added.**
     *
     * This never used to be announced. The UI was the only place that ever produced a user message,
     * so the UI drawing its own was enough. That assumption broke once the Assistant became a
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
      // A hub's Assistant directs as this host's own does (`sendFromHub`)
      : relayed && from && relayedText !== undefined ? relayedText
      : from && (relayed || (this.host.tools.directs(sessionId) && !this.host.tools.directs(from.sessionId) && !isHubSender(from.sessionId)))
        ? untrustedSourceSessionNotification(from.sessionId)
        : attachments?.length
          ? `${text}\n\n${attachments.map((a) => `@${a.path}`).join('\n')}`
          : text
    const { input, notice } = this.withRootAppsNotice(sessionId, adapterText)
    // A turn is asked for now, whether or not the tool announces it before its first card (`CardRests`)
    this.host.cardRests.turnAsked(sessionId)
    if (sendInput) sendInput(h, input, inputId)
    // Not with a line of Centralu's in front of it: that message is not only the person's words
    else if (fromPerson && !notice) h.send(input, { origin: { kind: 'human' }, id: inputId })
    else h.send(input, { id: inputId })
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
    /** `label`: the conversation line's kind (`mail` when absent); an update's continued turn says `update` (#1618) */
    input: { text: string; quiet: boolean; line: string; label?: string; skipLine?: () => boolean; shown?: MailInput['shown']; id?: string },
    gate: { leaving(): boolean; atRest(): boolean; wanted?(): boolean } = { leaving: () => false, atRest: () => true },
    late?: (e: Error) => void,
  ): Promise<void> {
    // Asked again after every wait and right before the send: what was true when the delivery began may not be (§4.2, §7.1)
    const clear = () => {
      if (gate.leaving()) throw rpcError('Centralu is restarting: the mail waits for the next host')
      if (!gate.atRest()) throw new MailNotAtRest()
      if (gate.wanted && !gate.wanted()) throw new MailWithdrawn()
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
      await takeInput(handle, this.withRootAppsNotice(sessionId, input.text).input, late, input.id)
    }
    /*
     * A Continue the tool took as a second update's stop began (#1626 review) is left to the host after it: that stop lists
     * the turn again and the host after continues it with a note and a line of its own, so the conversation shows one
     * Continue. Only for that stop: a person's quit or a swap lists nothing, so its line is the row that carries the
     * conversation past the mark of the list still standing, and it is written. Only for the update's note: a mail the tool
     * took stays recorded by its line, which is its only trace
     */
    if (input.skipLine?.()) return
    // After the tool took it, so neither is about a delivery that did not happen; before the answer it starts. A delegated task shows as its
    // sender's message, as its direct send does (owner, #1948 option B), and a card's notice as from its session, as before mail (§10.6.4); the line
    // stays for the rest of the mail
    const shown = !input.quiet && input.shown !== undefined && this.showSent(sessionId, input.shown)
    if (!shown || !input.shown?.alone) this.onEvent({ type: 'notice', sessionId, level: 'info', from: 'Centralu', label: input.label ?? 'mail', text: input.line })
  }

  /**
   * A delegated task or a card's notice the mailbox gave, written in the receiver's conversation as its sender's message (`deliverMail`): stored and shown, never
   * sent to the tool, which read the mail frame. `mail`: no turn bookkeeping reads it as an input of its own (`ChildOwnership.held`). False when the
   * sender is not here to be named: the line says it then
   */
  private showSent(sessionId: string, task: { senderId: string; text: string }): boolean {
    const sender = this.host.meta.get(task.senderId)
    const m = this.host.meta.get(sessionId)
    if (!sender || !m) return false
    const from = { sessionId: sender.id, name: labelOf(this.host.store.messages, sender) }
    const seq = this.host.store.messages.nextSeq(sessionId)
    this.host.store.messages.appendMessages([{ sessionId, seq, role: 'user', kind: 'text', payload: { text: task.text, from, mail: true }, ts: Date.now() }])
    m.lastSeq = seq
    m.lastReadSeq = seq
    this.host.store.sessions.upsertSession(m)
    this.host.emit({ type: 'user_message', sessionId, seq, text: task.text, from })
    return true
  }

  /** An Assistant that had root apps attached reads once why their names are gone (#1205), before its first input that starts a turn, a message or mail; never stored or shown */
  private withRootAppsNotice(sessionId: string, text: string): { input: string; notice: string | null } {
    const notice = this.host.apps.rootAppsNotice(sessionId)
    return { input: notice ? `[Centralu] ${notice}\n\n${text}` : text, notice }
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
    handle.send(text, { compact: true })
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
