import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import type { BusyAnswer, IfBusy } from '../adapters/contract.js'
import { cardOrTurn, errorMessage, isAssistantKind } from '@cc/protocol'
import type { MailSessions, ReceiverState } from '../mail/delivery.js'
import type { AnswerGiven } from '../mail/delegation.js'
import type { CardHooks } from '../mail/card-notices.js'
import type { HandedOverMessage } from '../mail/messages.js'
import type { StopTold, StopWhy, WaitEnd } from '../mail/stop-notices.js'
import type { MailToolArgs, MailToolResult } from '../mail/tool.js'
import type { TurnStart } from '../mail/turns.js'
import type { TurnInputs } from '../mail/delivery.js'
import type { Asker } from '../mail/asked-by.js'
import type { HandOverScope } from '../dev-services/store/mailbox.js'
import type { ThreadOrigin } from '../dev-services/store/mail-types.js'
import type { ChildReports, SessionLastResponse } from './child-reports.js'
import type { DelegationFlow, DelegationHost } from './delegation-flow.js'
import type { DelegationCall, DelegationTarget, SendOrigin } from './delegation-host.js'
import type { SelfCompaction } from './self-compaction.js'
import type { SessionEvents } from './session-events.js'
import type { SessionTools } from './session-tools.js'
import { seatHas } from './tool-seats.js'
import { agentCallsFor } from './centralu-tools.js'
import { agentRunText } from './tool-answers.js'

/** What the mailbox hears from the manager (#1347): a session gone, a session that may now take mail, an event the guards count */
export type MailHooks = {
  sessionGone(sessionId: string): void
  /** A session stopped without answering (docs/plans/mailbox.md "The stop notice"): the senders of the questions it left unanswered are told once */
  stopped?(sessionId: string, why: StopWhy, opts?: StopTold): void
  /** The wait of a stop Centralu continues by itself ended, continued or not (#1415): who the stop's notice was held from hears it once */
  waitEnded?(sessionId: string, why: 'limit' | 'network', starter: string | null, end: WaitEnd): void
  /** This host leaves, with these sessions in a turn: what an earlier build that may take over reads of their open tasks is written (`leaveForEarlierBuild`) */
  leaving?(inTurn: readonly string[]): void
  /**
   * A handoff moves the original's mail to the successor (mailbox §7.7, §10.6.5, `MessageService.handOver`): all of it for an original that goes, what
   * the children that moved sent it for one that stays (`senders`, session ids), and the tasks it gave the `children` that move. Run inside the
   * transaction of the children's move; it throws to undo both
   */
  handOver?(fromSessionId: string, toSessionId: string, which: HandOverScope, children: readonly string[]): HandedOverMessage[]
  /** What `handOver` would give the successor of an original that goes, read only: the archive preview says it (#1574) */
  handOverPreview?(fromSessionId: string, toSessionId: string): HandedOverMessage[]
  /** The first lines of the messages waiting for the session's answer and of the tasks it owes a report of, which `sessionGone` settles (#1512) */
  openWork?(sessionId: string): { unanswered: string[]; owed: string[] }
  /** A session went through `count` compaction cycles in the hour (`compact_self` with `then`, #2024): the person gets one warning, the mailbox's, once per clock hour */
  compactCycles?(sessionId: string, count: number): void
  /** Mail that wakes the session waits for it (due or not yet): its turn is coming, and a note of the host's (`compact_self`'s `then`) follows it */
  waiting?(sessionId: string): boolean
  sessionChanged(sessionId: string): void
  sessionEvent?(e: NormalizedEvent, endedTurn: boolean): void
  /** The `mail` tool of a session */
  tool?(sessionId: string, args: MailToolArgs, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }>
  /** A child on a linked machine is gone with notes the hub held for it (#2114): they are released with its other mail, and their sender told */
  linkedGone?(childId: string, callerId: string, notes: readonly string[]): void
  /** A session gave another one work by a tool the host delivers it by (§8.1): the mailbox writes it down. Returns how to withdraw it, when it could not go in */
  delegated?(callerId: string, childId: string, origin: ThreadOrigin, task: string): () => void
  /** A send to a session that cannot take it now: a task from the caller, not delivered yet (docs/plans/mailbox.md §10.6.2); returns its id */
  sendTask?(callerId: string, childId: string, origin: ThreadOrigin, task: string): string
  /** The caller's tasks to the session that are not delivered yet are withdrawn (`agent_session stop`); how many */
  withdrawTasks?(callerId: string, childId: string): number
  /** A script or the RPC started a session with a first message: the work is the person's (§8.1), a task answered as any task is */
  personWork?: {
    started(sessionId: string, text: string, fromScript?: { credential: string }): void
    withdrawn(sessionId: string): void
  }
  /** A session deleted the session that did work it gave (§3.3): a thread whose work was reported is closed */
  finishedWith?(callerId: string, childId: string): void
  /** A session at rest answers the tasks it did not reply to with its last response (docs/plans/mailbox.md §10.6.3); `body` is for a session id, or null for the person */
  lastResponse?(sessionId: string, last: SessionLastResponse): void
  /** A watch on the session waits for its rest: a turn of it ended since the watch was set (docs/plans/mailbox.md §18.3), so settling at rest tells it */
  watchedAtRest?(sessionId: string): boolean
  /** The sessions with a task open between them and the session (delivered, not settled, not released): its tasks' senders (`to`, `PERSON` for the person's), or its own tasks' receivers (`from`) */
  openTasks?(sessionId: string, side: 'to' | 'from'): string[]
  /** A session's cards and the givers of its open work (docs/plans/mailbox.md §10.6.4) */
  cards?: CardHooks
  /** What the tool said of the inputs given it (`MailDelivery.turnInputs`): which the turn that ended took, or which the turn opening runs for */
  turnInputs?(sessionId: string, turn: TurnInputs): void
  /** The Assistant's turn ended as a turn does: each session whose request it carried is told what it gets back, and those requests are settled (S12, §7.6) */
  requestTurnEnded?(assistantId: string): void
  /** A call returned the answer of work a session gave another, or read where it stands (§8.1): the reports waiting for the caller are settled */
  answered?(callerId: string, childId: string, how?: AnswerGiven): void
  /** A turn started that the mailbox did not start: whose it is and the thread it belongs to (§6) */
  turnStarted?(sessionId: string, turn: TurnStart): void
  /** The Assistant's role is a new session's (mailbox §7.7, D15): mail sent to the role and not settled goes to it, delivered afresh */
  roleMoved?(toSessionId: string): void
  /** The session whose request the Assistant's turn is, if a session asked for it (#1447, §9.7): its steps that change something ask the person, naming it */
  askedBy?(assistantId: string): Asker | null
  /** §7.4: a delegation from `callerId` out of its untrusted project is refused. Returns S15 (the whole `Refused (untrusted_project): …` text) after the mailbox wrote the record S16 is built from, or null when it may go */
  refusesDelegation?(callerId: string, target: DelegationTarget, call: DelegationCall): string | null
}

const NO_CARDS: CardHooks = { givers: () => ({ givers: [], answerer: null }), turn: () => 0, tell: () => null, ended: () => {} }

/**
 * What the mailbox's view of sessions reaches of the session manager (#1143), typed as the manager declares each member. The manager builds it
 * with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type MailSessionsHost = Pick<DelegationHost, 'adapters' | 'agentRuns' | 'children' | 'closing' | 'handles' | 'meta' | 'store'> & {
  /** What a session's tool says and what goes into its conversation: the mail's delivery and its notes */
  readonly events: SessionEvents
  /** What a session is told of work it gave: the report path the mailbox takes over, and the words a stop notice quotes */
  readonly reports: ChildReports
  /** The tools a session receives: its profile, and what it may read */
  readonly tools: SessionTools
  /** A send to a session the caller gives work (`AgentSessionActions.sendWork`), or null for plain mail */
  readonly delegationFlow: Pick<DelegationFlow, 'actions'>
  /** A child this host started on a linked machine (`RemoteAgents.of`), with its name and machine as one name */
  linkedChild(sessionId: string): { name: string } | undefined
  /** Whether the session's tool takes a message into the turn it is running, rather than holding it for the next (`midTurnInput`) */
  joinsRunningTurn(sessionId: string): boolean
  /** A compact Centralu sent and that is not over, during which no mail joins a turn */
  readonly selfCompaction: Pick<SelfCompaction, 'compacts'>
}

/**
 * The mailbox's view of the sessions (#1347): the hooks it hears the manager through, whether a session can take mail now and the
 * delivery into it, the stop notices, and the seat rules its policy reads. Moved out of the session manager as it was (#1143); what it
 * reaches of the manager is `MailSessionsHost`.
 */
export class MailSessionsView {
  constructor(private readonly host: MailSessionsHost) {}

  /** What the mailbox asks of the sessions (#1347): set once by the host, null in a manager that has no mailbox */
  hooks: MailHooks | null = null

  /** A child this host started on a linked machine, by its name there (#2067): mail refuses it as elsewhere, not as gone */
  onLinkedMachine(sessionId: string): { name: string } | undefined {
    return this.host.linkedChild(sessionId)
  }

  /**
   * A child this host started on a linked machine is gone, with notes its caller had the hub hold for it (#2114): they were not given, and the
   * stop notice tells the caller so, as of any task a gone session leaves. Never throws: the child is gone already
   */
  linkedChildGone(childId: string, callerId: string, notes: readonly string[]): void {
    if (this.host.closing) return
    try {
      this.hooks?.linkedGone?.(childId, callerId, notes)
    } catch (e) {
      console.error(`[mail] ${childId.slice(0, 8)}: the notes held for it could not be told to ${callerId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  /** Tells the mailbox a session stopped without answering (§4.1). Never throws: a stop is already over, and a notice must not undo it */
  mailStopped(sessionId: string, why: StopWhy, opts: StopTold = {}): void {
    // A host that is leaving writes nothing: its sessions are cut by the leaving, and the next host continues them or finds them marked (§4.1)
    if (this.host.closing) return
    try {
      this.hooks?.stopped?.(sessionId, why, opts)
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: its stop could not be told to the senders (${errorMessage(e)})`)
    }
  }

  /** Tells the mailbox the wait of a stop Centralu continues by itself ended (`MailHooks.waitEnded`). Never throws: the wait is over already */
  mailWaitEnded(sessionId: string, why: 'limit' | 'network', starter: string | null, end: WaitEnd): void {
    if (this.host.closing) return
    try {
      this.hooks?.waitEnded?.(sessionId, why, starter, end)
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: the end of its wait could not be told to the senders (${errorMessage(e)})`)
    }
  }

  /** This host leaves (`HostTenure.disposeAll`): the sessions still in a turn, for an earlier build that may take over (`MailHooks.leaving`). Never throws */
  mailLeaving(inTurn: readonly string[]): void {
    try {
      this.hooks?.leaving?.(inTurn)
    } catch (e) {
      console.error(`[mail] the marks for an earlier build could not be written (${errorMessage(e)})`)
    }
  }

  /** A session at rest answers its open tasks with its last response (`MailHooks.lastResponse`). Never throws: a turn's end must not fail for it */
  mailLastResponse(sessionId: string, last: SessionLastResponse): void {
    try {
      this.hooks?.lastResponse?.(sessionId, last)
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: its last response could not answer its tasks (${errorMessage(e)})`)
    }
  }

  /** Whether a watch waits for the session's rest (`MailHooks.watchedAtRest`). Never throws */
  mailWatchedAtRest(sessionId: string): boolean {
    try {
      return this.hooks?.watchedAtRest?.(sessionId) === true
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: its watches could not be read (${errorMessage(e)})`)
      return false
    }
  }

  /** The Assistant's turn ended as a turn does (`MailHooks.requestTurnEnded`). Never throws */
  mailRequestTurnEnded(assistantId: string): void {
    try {
      this.hooks?.requestTurnEnded?.(assistantId)
    } catch (e) {
      console.error(`[mail] the end of the Assistant's turn could not be told to its askers (${errorMessage(e)})`)
    }
  }

  /** A session this start found at rest answers its open tasks once settled (`ChildReports.settleAtRest`) */
  settleAtRest(sessionId: string): void {
    this.host.reports.settleAtRest(sessionId)
  }

  /** What the tool said of the mail given it at a turn's end or opening (`MailHooks.turnInputs`). Never throws: a turn must not fail for it */
  mailTurnInputs(sessionId: string, turn: TurnInputs): void {
    try {
      this.hooks?.turnInputs?.(sessionId, turn)
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: what its turn took of its mail could not be filed (${errorMessage(e)})`)
    }
  }

  useMail(hooks: MailHooks): void {
    this.hooks = hooks
    this.host.children.onDelegated(hooks.delegated ? (callerId, childId, origin, task) => hooks.delegated?.(callerId, childId, origin, task) : undefined)
    this.host.children.onPersonWork(hooks.personWork)
    this.host.children.onOpenTasks(hooks.openTasks ? (id, side) => hooks.openTasks?.(id, side) ?? [] : undefined)
    this.host.children.onFinishedWith(hooks.finishedWith ? (callerId, childId) => hooks.finishedWith?.(callerId, childId) : undefined)
    this.host.children.onAnswered(hooks.answered ? (callerId, childId, how) => hooks.answered?.(callerId, childId, how) : undefined)
    this.host.children.onTurnStarted(hooks.turnStarted ? (sessionId, turn) => hooks.turnStarted?.(sessionId, turn) : undefined)
  }

  /** How the mailbox's delivery reaches a session (#1347): whether it can take mail now, and the mail. See `MailSessions` (mail/delivery.ts) */
  mailSessions(): MailSessions {
    return {
      receiver: (id) => this.mailReceiver(id),
      deliver: async (id, input, late) => {
        await this.host.events.deliverMail(id, input, { leaving: () => this.host.closing, atRest: () => this.takesAsPlanned(id, input.joins === true), wanted: () => input.wanted?.() ?? true }, late)
      },
      note: (id, text) => {
        if (this.host.meta.has(id)) this.host.events.onEvent({ type: 'notice', sessionId: id, level: 'info', from: 'Centralu', label: 'mail', text })
      },
    }
  }

  /**
   * Whether a notice from Centralu goes into the session's process now without a wake: a live process of a tool that takes quiet input (Claude), in or out
   * of a turn, in a host that is not leaving. Codex starts a turn for any input, and a session that sleeps has no process: for those the notice waits as mail
   * for the session's next mail (`MailPerson.close`)
   */
  tellsMailNow(sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    return !!m && !this.host.closing && this.host.handles.has(sessionId) && this.host.adapters.get(m.tool)?.quietInput === true
  }

  /** Puts a notice from Centralu into the session's process, quietly (`tellsMailNow`). It stops nothing: the person's close tells a session its work is not wanted, and the session decides */
  async tellMailNow(sessionId: string, text: string): Promise<void> {
    try {
      await this.host.events.deliverMail(sessionId, { text: `[Centralu] ${text}`, quiet: true, line: '✉ Centralu told it the person closed its work' })
    } catch (e) {
      console.error(`[mail] could not tell ${sessionId.slice(0, 8)} that the person closed its work (${errorMessage(e)}); the notice goes with its next mail`)
      throw e
    }
  }

  /** Whether a session can be told of mail now, and how (`ReceiverState`, mail/delivery.ts) */
  mailReceiver(id: string): ReceiverState {
    const m = this.host.meta.get(id)
    if (!m) return { kind: 'gone' }
    // A host that is leaving tells nobody anything: the next one delivers (§4.2)
    if (this.host.closing) return { kind: 'busy', why: 'turn' }
    // A card is standing: mail is never taken as its answer (§7.1). `waiting_input` is not one: it is the state a turn ends in
    // ("awaiting input", protocol session-state.ts), a session ready for its next message; a question raises `waiting_approval`
    // The session's own background work does not hold mail back (`cardOrTurn`): the message starts its next turn
    const busy = cardOrTurn(m)
    const live = this.host.handles.has(id)
    const quiet = live && this.host.adapters.get(m.tool)?.quietInput === true
    // In a turn its tool takes input into, mail joins that turn (docs/plans/mailbox.md §10.6.2); not while a compact Centralu sent is not over
    if (busy === 'turn' && live && this.host.joinsRunningTurn(id) && !this.host.selfCompaction.compacts(id)) return { kind: 'ready', live, quiet, auto: m.permissionPreset === 'auto', joins: true }
    if (busy !== null) return { kind: 'busy', why: busy === 'turn' ? 'turn' : 'card' }
    if (m.state === 'limited') return { kind: 'busy', why: 'limited' }
    return { kind: 'ready', live, quiet, auto: m.permissionPreset === 'auto' }
  }

  /** The session can be given a turn of its own now: at rest with no card or limit standing, in a host that is not leaving (asleep, it is woken) */
  takesTurn(id: string): boolean {
    return this.takesAsPlanned(id, false)
  }

  /**
   * Whether a send from another session reaches it now as a turn it starts (docs/plans/mailbox.md §10.6.2): it takes a turn (`takesTurn`), no run another
   * session waits on is going there, and no mail that wakes it is waiting, which goes first. Otherwise the send goes as mail (`mailTask`)
   */
  takesSendNow(id: string): boolean {
    const run = this.host.agentRuns.get(id)
    return this.takesTurn(id) && !(run && !run.finished) && this.hooks?.waiting?.(id) !== true
  }

  /** `MailToolHost.work` (#1948): the answer worded as agent_session's are for the caller's seat, or null for plain mail */
  async work(callerId: string, target: string, text: string, ifBusy: IfBusy | undefined, signal?: AbortSignal): Promise<MailToolResult | null> {
    const r = await this.host.delegationFlow.actions.sendWork(callerId, target, text, ifBusy, signal)
    return r && agentCallsFor(this.host.tools.toolProfileOf(callerId) ?? 'human', agentRunText(r))
  }

  /** A send to a session that cannot take it now: a task from the caller, which the delivery gives it as a turn of its own once it is free (§10.6.2) */
  mailTask(callerId: string, target: SessionInfo, origin: SendOrigin, text: string): Extract<BusyAnswer, { state: 'mailed' }> | { error: string } {
    const hooks = this.hooks
    if (!hooks?.sendTask || !this.canReadMail(target.id)) return { error: `"${target.name}" is busy and takes no mail: send to it once it is at rest.` }
    try {
      return { state: 'mailed', sessionId: target.id, sessionName: target.name, messageId: hooks.sendTask(callerId, target.id, origin, text) }
    } catch (e) {
      return { error: `Could not send it to "${target.name}": ${errorMessage(e)}` }
    }
  }

  /** A session's cards and the givers of its open work (`MailHooks.cards`); no giver without a mailbox */
  get cards(): CardHooks {
    return this.hooks?.cards ?? NO_CARDS
  }

  /** The caller's tasks to the session that are not delivered yet, withdrawn (`agent_session stop`); how many */
  withdrawTasks(callerId: string, sessionId: string): number {
    return this.hooks?.withdrawTasks?.(callerId, sessionId) ?? 0
  }

  /** The session still takes mail as the delivery planned it: woken at rest, or joining its turn. Otherwise the mail waits (`MailNotAtRest`) and is planned again */
  private takesAsPlanned(id: string, joins: boolean): boolean {
    const r = this.mailReceiver(id)
    return r.kind === 'ready' && (r.joins === true) === joins
  }

  /** A session whose seat cannot read mail is told of a stop the old way (`ChildReports.relayStop`, mailbox.md §10.6.3) */
  relayStop(receiverId: string, stoppedId: string, why: StopWhy, told: () => void): void {
    this.host.reports.relayStop(receiverId, stoppedId, why, told)
  }

  /** The words of the turn a stop cut, as a stop notice quotes them (`ChildReports.turnWords`, at most 600 characters), or null when it said none */
  stoppedWords(sessionId: string): string | null {
    if (!this.host.meta.has(sessionId)) return null
    return this.host.reports.turnWords(sessionId).preview || null
  }

  /**
   * Whether the session's seat has the mail tool (§9.1, `seatHas`). This is the receive rule (who may be written to, and who
   * is woken by mail, and told of a child's report by mail), and it does not look at the process: a process the keeper handed over after a
   * swap is still the session's, and mail is for the session
   */
  canReadMail(sessionId: string): boolean {
    return seatHas(this.host.tools.toolProfileOf(sessionId), 'mail')
  }

  /** The seat rules of the mailbox's policy (`mailRelations`): who has the mail tool, and who has it as a command of the Assistant's `centralu_run` */
  mailSeats(assistantHasMailCommand: () => boolean): { mailTool(id: string): boolean; mailCommand(id: string): boolean } {
    return {
      mailTool: (id) => this.canReadMail(id),
      mailCommand: (id) => this.host.tools.toolProfileOf(id) === 'assistant' && assistantHasMailCommand(),
    }
  }

  /**
   * Why sessions may not ask the Assistant now, or null when they may (§9.7, #1447). A request is run with every step that is not a read behind the
   * person's card; that needs the Assistant's tool to put each step of its own to the host (`gatesSteps`). Where it cannot, a request could have
   * the Assistant run a command or write a file unasked, so it is not taken
   */
  assistantAsks(): string | null {
    const assistant = [...this.host.meta.values()].find((m) => isAssistantKind(m.kind))
    if (!assistant || this.host.adapters.get(assistant.tool)?.capabilities.gatesSteps === true) return null
    return 'the Assistant runs on a tool that cannot ask the person for each step of a request yet, so a session cannot ask it: write to the person instead'
  }

  /** `ChildOwnership.latestTurnInputs`: who gave what may have entered the session's latest turn, which a stop notice quotes only to its one asker */
  turnInputs(sessionId: string): (string | null)[] {
    return this.host.children.latestTurnInputs(sessionId)
  }

  /** `SessionTools.readsSession`: what a stop notice may quote of a session to another */
  readsSession(readerId: string, targetId: string): boolean {
    return this.host.tools.readsSession(readerId, targetId)
  }
}
