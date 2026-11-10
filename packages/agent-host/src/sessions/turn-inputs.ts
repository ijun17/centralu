import type { ApprovalDecision, ApprovalScope, Attachment, QuestionAnswer, SessionInfo } from '@cc/protocol'
import { alwaysAllowKey, sessionOnlyAlways } from '@cc/protocol'
import { rpcError } from '../rpc-error.js'
import { inTurn } from '../idle.js'
import type { AgentRunWait } from './app-agents.js'
import type { AppMessageSource, AppViewPlace } from './app-messages.js'
import type { AppSessions } from './app-sessions.js'
import type { ApprovalRules } from './approval-rules.js'
import type { DelegationHost } from './delegation-flow.js'
import type { HostCards } from './host-cards.js'
import type { MailSessionsHost } from './mail-sessions.js'
import type { SessionEventsHost } from './session-events.js'

/**
 * What a session's turn inputs reach of the session manager (#1143), typed as the manager declares each member. The manager builds it with
 * getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type TurnInputsHost = Pick<DelegationHost, 'children' | 'closing' | 'emit' | 'handles' | 'meta' | 'trashing'> &
  Pick<SessionEventsHost, 'overloadRetry' | 'reports' | 'requireHandle'> &
  Pick<MailSessionsHost, 'events'> & {
    /** The sessions an external app owns: a message of the person's makes an app's agent session theirs */
    readonly appSessions: AppSessions
    /** The cards the host raises in a session's approval slot, and the approvals already answered */
    readonly hostCards: HostCards
    /** The remembered "always allow" answers */
    readonly approvalRules: ApprovalRules
  }

/**
 * What goes into a session's turn from outside its tool: a message, an app's message or notice, an approval or an answer, a Stop, and the
 * waits that read a turn as it runs (an app's agent run, an observer). Moved out of the session manager as it was (#1143); what it reaches of
 * the manager is `TurnInputsHost`.
 */
export class TurnInputs {
  constructor(private readonly host: TurnInputsHost) {}

  /**
   * Agent sessions launched at an app's request that are **still waiting for an answer** (M4 D-1) —
   * session id -> the wait. Removed once the turn ends, fails or is canceled. After it finishes the
   * session stays in the list like any ordinary session (the archive feature was dropped — see the
   * comment on `runAppAgent`).
   */
  readonly agentRuns = new Map<string, AgentRunWait>()
  /** Temporary readers of a person's turn; they never own work or pin the calling session awake. */
  readonly turnObservers = new Map<string, Set<AgentRunWait>>()
  /** A queued note not yet taken, on the delegation's wait or an observer's own reader (#646): the session is not between turns */
  inputsHeld(sessionId: string): boolean {
    if (this.agentRuns.get(sessionId)?.waitingForInputs) return true
    for (const observer of this.turnObservers.get(sessionId) ?? []) if (observer.waitingForInputs) return true
    return false
  }

  /**
   * Sends a message.
   *
   * If there is no process, it is **resumed first and then sent.** It used to reply with "this
   * session is not running", which just pushes a machine-side problem onto the person — all the
   * person wants is to keep talking, and the means to continue (external_id) is already ours to use.
   */
  async send(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    /*
     * Who sent this (FR-11). Empty when the person sent it — that is the default, so no migration was
     * needed. Only the Assistant's send_to_session and a reportBack reply ever fill this in. The
     * screen uses it to draw "what the person said" and "what another session instructed" differently.
     */
    from?: { sessionId: string; name: string },
    /** The person's own typing, as the screen's composer sends it: the tool is told it is the person's (`InputOrigin`) */
    fromPerson = false,
    /** What the person chose for a delegation report the session owes (#1377); "just asking" unless they said */
    intent: 'ask' | 'task' | 'takeover' = 'ask',
    /** A script wrote it (the limited credential, §8.1): its words are not the person's, nor are its choices — no `origin: human`, no `intent` */
    fromScript?: { credential: string },
  ): Promise<void> {
    // The person wrote to it (#378): an app's agent session they wrote to becomes theirs
    if (!from && !fromScript) this.host.appSessions.noteTookPart(sessionId, 'wrote')
    // Only the person chooses what a message means for a report the session owes (#1377)
    const chosen = from || fromScript ? 'ask' : intent
    await this.host.events.deliver(sessionId, text, attachments, from, false, undefined, 'inline', undefined, undefined, undefined, fromPerson && !from && !fromScript, chosen, fromScript)
    /*
     * A person's message never closes a delegation report (#1377): its turn is theirs, and not reported, or the work's,
     * when they chose to add it. Only "take it over" closes it, and tells the caller once. After the delivery, so a
     * message that did not reach the session takes nothing over.
     */
    if (!from && chosen === 'takeover') {
      this.host.children.takeTurn(sessionId)
      void this.host.reports.personTookOver(sessionId)
    }
  }

  /**
   * Who waits for the session's work (#1377), for the composer's "Working for <caller>" choice: the session that holds
   * the delegation report it owes, here or (a linked session's, asked of this hub) on a machine. `null` when it owes none.
   */
  reportOwed(sessionId: string): { callerId: string; callerName: string } | null {
    const callerId = this.host.children.awaitingReport.get(sessionId) ?? this.host.children.linkedReports.get(sessionId)?.assistantId
    const caller = callerId ? this.host.meta.get(callerId) : undefined
    return callerId && caller ? { callerId, callerName: caller.name } : null
  }

  /**
   * An inline app view's `ui/message` (M4 B-1, B-4) — this is only reached after the person has
   * confirmed it (once RPC `apps.viewMessage` narrows the app and session down to an instance). It is
   * recorded in the conversation as a message the app sent, and reaches the agent wrapped as the app's text.
   */
  async sendFromApp(sessionId: string, text: string, app: AppMessageSource, place: AppViewPlace = 'inline'): Promise<void> {
    return this.host.events.deliver(sessionId, text, undefined, undefined, false, app, place)
  }

  /**
   * An app's notice into a session that called it (#1161 item 1, the broker's `notify`) — delivered as a report
   * arrives: recorded as the app's message and handed to the agent framed as the app's text (`appMessageFrame`
   * `notice`), waking the session if it is idle or asleep. Throws a reason the app reads when it cannot be delivered
   * now: while this host hands over or quits (the app tries again; the next host takes it), or once the session is gone.
   */
  async appNotice(sessionId: string, text: string, app: AppMessageSource): Promise<void> {
    if (this.host.closing) throw new Error('Centralu is restarting; post it again in a moment')
    if (!this.host.meta.has(sessionId) || this.host.trashing.has(sessionId)) throw new Error('that session is gone')
    return this.host.events.deliver(sessionId, text, undefined, undefined, false, app, 'notice')
  }

  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    matcher?: string,
  ): void {
    const m = this.host.meta.get(sessionId)

    // A card the host raised (M4 D-4, #371) — the adapter has never heard of this card, so it is resolved right here.
    // For a capability question "always allow" is treated as allow (the answer gets remembered regardless); a
    // cross-project consent keeps all three (always is the pair remembered)
    const ask = this.host.hostCards.hostAsks.get(requestId)
    if (ask && ask.sessionId === sessionId) {
      // A new project (#515) has nothing to remember either: "always" makes this one, as allow does. An update, an apply
      // and a handoff (#694) keep theirs for the asking session
      const keepsAlways = ask.detail.kind === 'project_access' || ask.detail.kind === 'agent_start' || sessionOnlyAlways(ask.detail)
      const answer = !keepsAlways && decision === 'always' ? 'allow' : decision
      // Starting agents (#561) has two always: this session (the card's default) or the whole project (⌥)
      this.host.hostCards.closeAsk(ask, answer, ask.detail.kind === 'agent_start' && answer === 'always' && scope === 'project' ? 'always_project' : answer)
      // The agent is still inside that tool call — if there are no other pending questions, it is working
      // again
      const after = this.host.meta.get(sessionId)
      if (after?.state === 'waiting_approval' && !after.pendingApproval && after.pendingQuestions.length === 0) {
        this.host.events.onEvent({ type: 'state_change', sessionId, state: 'working' })
      }
      return
    }

    /*
     * **Checks whether it actually landed, first.** If it did not land, no rule is recorded either —
     * remembering a command that was never even run as 'always allow' would let it pass silently the next
     * time.
     */
    /*
     * What "always" remembers is the host's own key for the card it answers (#838 review), not what the window sent: a
     * window from before #838 (during a swap) sends a command ending in `*`, or a flagged one, as its matcher, and the
     * adapter and the store would keep it. A matcher that is not the card's key remembers nothing; the call is allowed once.
     */
    const pending = m?.pendingApproval
    const key = pending?.requestId === requestId ? alwaysAllowKey(pending.detail) : ''
    const remembered = decision === 'always' && matcher !== undefined && key !== '' && matcher === key ? matcher : undefined
    const landed = this.host.requireHandle(sessionId).respondApproval(requestId, decision, scope, remembered)

    // This is a second response to a request that has already been answered — since the first response
    // already landed, this never broadcasts a denial or reports a failure (#158)
    if (!landed && this.host.hostCards.answeredApprovals.get(requestId) === sessionId) return
    if (landed) {
      const answered = this.host.hostCards.answeredApprovals
      answered.set(requestId, sessionId)
      // The oldest goes once more than 256 are kept
      const oldest = answered.keys().next()
      if (answered.size > 256 && !oldest.done) answered.delete(oldest.value)
    }

    if (!landed) {
      /*
       * No such request exists. Usually this means the process got swapped in the meantime (changing
       * the permission preset does this). The card on screen is already unanswerable, so it is
       * **removed first**, and only then is the error reported. Without removing it, an unresponsive
       * card that does nothing when clicked would just stay there.
       */
      this.host.emit({ type: 'approval_resolved', sessionId, requestId, decision: 'deny' })
      throw rpcError('That approval request is already gone (the agent restarted). The command was not run.', 'approval_gone')
    }

    // Persisting the rule (approval-rules.ts)
    // Only the card's own key (`remembered` above): an edit with no path has none (#428), so "(no path)" is never a rule
    if (decision === 'always' && m && remembered) this.host.approvalRules.rememberAlways(sessionId, m.projectId, scope, remembered)
  }

  /**
   * Answers a set of choices (AskUserQuestion).
   *
   * Keeps exactly what was learned from approvals — **if it did not land, it is never quietly treated
   * as a success.** Leaving an unanswerable card on screen recreates the same "clicking it does nothing"
   * state.
   */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void {
    const handle = this.host.requireHandle(sessionId)
    // Marked first: an answer the tool took and the mark lost would let a stop notice quote a turn that holds the person's answer (#1948)
    this.host.children.noteQuestionAnswered(sessionId)
    const landed = handle.answerQuestion?.(requestId, answers) ?? false
    if (!landed) {
      this.host.emit({ type: 'question_resolved', sessionId, requestId })
      throw rpcError('That question is already gone (the agent restarted). The answer was not delivered.', 'question_gone')
    }
  }

  interrupt(sessionId: string): void {
    // A turn waiting for the provider's capacity (#1693) has nothing running: the Stop is the end of the wait, and of the turn, even where no process is left to stop.
    // Once the retry's note is with the tool it runs a turn, which the Stop stops like any
    const took = this.host.overloadRetry.cancel(sessionId)
    const waiting = took === 'waiting' || took === 'sending'
    const handle = waiting ? this.host.handles.get(sessionId) : this.host.requireHandle(sessionId)
    // Receipt failures and ending events may be emitted synchronously by interrupt.
    const run = this.agentRuns.get(sessionId)
    if (run) run.stoppedByPerson = true
    for (const observer of this.turnObservers.get(sessionId) ?? []) observer.stoppedByPerson = true
    // A stop takes off what a hub gave the tool for turns to come (#1604): the tool drops what it still holds queued, and says it
    // was not delivered (#1640), so no turn runs for it after the Stop
    this.host.children.dropInputOrigins(sessionId)
    if (waiting) this.host.events.onEvent({ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' })
    else handle?.interrupt()
    // Stop reaches delegated work only while the caller waits. A note that joined the person's turn
    // only ends that caller's wait; work left running past the bound has its own Stop. Not "the person": a script, or a hub's agent
    // stopping a child of its on this machine, calls the same Stop (#1474 item 7)
    for (const d of this.host.children.delegations.values()) {
      if (d.callerId === sessionId && (d.waiters ?? 0) > 0) d.stop('your turn was stopped')
    }
  }

  /**
   * Whether a turn runs in the session for anyone (#677): its state says so, or a wait on it (an app's run, a
   * delegation) has not settled yet, which a turn that has not stepped into `working` already holds
   */
  turnRunning(m: SessionInfo): boolean {
    const run = this.agentRuns.get(m.id)
    return inTurn(m.state) || (!!run && !run.finished)
  }
}
