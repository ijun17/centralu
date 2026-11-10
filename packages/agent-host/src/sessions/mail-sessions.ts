import type { NormalizedEvent } from '@cc/protocol'
import { errorMessage, isAssistantKind, needsAnswer } from '@cc/protocol'
import type { MailSessions, ReceiverState } from '../mail/delivery.js'
import type { AnswerGiven, ReportDraft, ReportedAs } from '../mail/delegation.js'
import { OLD_PATH_WAIT_MS, type HandedOverMessage, type StopWhy } from '../mail/messages.js'
import type { MailToolArgs } from '../mail/tool.js'
import type { TurnStart } from '../mail/turns.js'
import type { Asker } from '../mail/asked-by.js'
import type { HandOverScope } from '../dev-services/store/mailbox.js'
import type { ThreadOrigin } from '../dev-services/store/mail-types.js'
import type { PersonReportDraft } from './child-ownership.js'
import type { ChildReports } from './child-reports.js'
import type { DelegationHost } from './delegation-flow.js'
import type { DelegationCall, DelegationTarget } from './delegation-host.js'
import type { SessionEvents } from './session-events.js'
import type { SessionTools } from './session-tools.js'
import { seatHas } from './tool-seats.js'

/** What the mailbox hears from the manager (#1347): a session gone, a session that may now take mail, an event the guards count */
export type MailHooks = {
  sessionGone(sessionId: string): void
  /**
   * Whether a notice to `readerId` of `stoppedId`'s stop may quote the words of its latest turn (`MessageService.quotes`, security-boundaries.md):
   * the one rule every stop notice to a session quotes by. Nothing is quoted without it
   */
  quotes?(stoppedId: string, readerId: string): boolean
  /** A session stopped without answering (docs/plans/turn-owned-by-no-one.md §4.1): the senders of the questions it left unanswered are told once. Quiet: wakes no one */
  stopped?(sessionId: string, why: StopWhy, opts?: { quiet?: boolean; told?: readonly string[]; held?: readonly string[] }): void
  /** An older report path held by `stopped` (its `held`) ended: `told`, it really told `senderId` of the stop; else the stop notice tells it now */
  oldPathEnded?(sessionId: string, senderId: string, told: boolean): void
  /**
   * A handoff moves the original's mail to the successor (mailbox §7.7, `MessageService.handOver`): all of it for an original that goes, what
   * the children that moved sent it for one that stays (`senders`, session ids). Run inside the transaction of the children's move; it throws to undo both
   */
  handOver?(fromSessionId: string, toSessionId: string, which: HandOverScope): HandedOverMessage[]
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
  tool?(sessionId: string, args: MailToolArgs): Promise<{ text: string; isError?: boolean }>
  /** A session gave another one work by a tool the host delivered it by (§8.1): the mailbox writes it down */
  delegated?(callerId: string, childId: string, origin: ThreadOrigin, task: string): void
  /** How many threads a session handed on in the work it does for another are still going (§6) */
  waitingOn?(ownerId: string, childId: string): number
  /** A script or the RPC started a session with a first message: the work is the person's (§8.1) */
  personWork?: {
    started(sessionId: string, text: string, fromScript?: { credential: string }): void
    withdrawn(sessionId: string): void
    owes(sessionId: string): boolean
    report(sessionId: string, draft: PersonReportDraft): boolean
  }
  /** A session deleted the session that did work it gave (§3.3): a thread whose work was reported is closed */
  finishedWith?(callerId: string, childId: string): void
  /** A turn of delegated work ended, or the person took the session over (§6, §8.1): the report goes in the thread, and the mailbox tells the owner when it can */
  report?(ownerId: string, childId: string, draft: ReportDraft): ReportedAs
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

/**
 * What the mailbox's view of sessions reaches of the session manager (#1143), typed as the manager declares each member. The manager builds it
 * with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type MailSessionsHost = Pick<DelegationHost, 'adapters' | 'children' | 'closing' | 'handles' | 'meta' | 'store'> & {
  /** What a session's tool says and what goes into its conversation: the mail's delivery and its notes */
  readonly events: SessionEvents
  /** What a session is told of work it gave: the report path the mailbox takes over, and the words a stop notice quotes */
  readonly reports: ChildReports
  /** The tools a session receives: its profile, and what it may read */
  readonly tools: SessionTools
  /** A child this host started on a linked machine (`RemoteAgents.of`), with its name and machine as one name */
  linkedChild(sessionId: string): { name: string } | undefined
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

  /** Whether the old report paths still owe `ownerId` a report of `childId` (mailbox §9.5, D18) */
  oldOwes(ownerId: string, childId: string): boolean {
    return this.host.children.oldOwes(ownerId, childId)
  }

  /** Tells the mailbox a session stopped without answering (§4.1). Never throws: a stop is already over, and a notice must not undo it */
  mailStopped(sessionId: string, why: StopWhy, opts: { quiet?: boolean; told?: readonly string[]; held?: readonly string[] } = {}): void {
    // A host that is leaving writes nothing: its sessions are cut by the leaving, and the next host continues them or finds them marked (§4.1)
    if (this.host.closing) return
    try {
      this.hooks?.stopped?.(sessionId, why, opts)
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: its stop could not be told to the senders (${errorMessage(e)})`)
    }
  }

  /**
   * The older report paths of a stop whose notices `mailStopped` held for them (`held`), each resolving to the session it really told: once all have
   * ended, those they told are marked told and the rest get the stop notice (docs/plans/turn-owned-by-no-one.md §4.1)
   */
  mailStopTold(sessionId: string, held: readonly string[], sends: readonly Promise<string | undefined>[]): void {
    if (held.length === 0) return
    // A path that does not end within the wait counts as not having told: a double notice at worst, never none
    const bounded = sends.map((send) =>
      Promise.race([
        send,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), OLD_PATH_WAIT_MS)
          timer.unref?.()
        }),
      ]),
    )
    void Promise.allSettled(bounded).then((ended) => {
      const told = new Set(ended.flatMap((r) => (r.status === 'fulfilled' && r.value !== undefined ? [r.value] : [])))
      for (const who of held) this.mailOldPathEnded(sessionId, who, told.has(who))
    })
  }

  mailOldPathEnded(sessionId: string, senderId: string, told: boolean): void {
    try {
      this.hooks?.oldPathEnded?.(sessionId, senderId, told)
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: its stop could not be told to ${senderId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  useMail(hooks: MailHooks): void {
    this.hooks = hooks
    this.host.children.onDelegated(hooks.delegated ? (callerId, childId, origin, task) => hooks.delegated?.(callerId, childId, origin, task) : undefined)
    this.host.children.onWaitingOn(hooks.waitingOn ? (ownerId, childId) => hooks.waitingOn?.(ownerId, childId) ?? 0 : undefined)
    this.host.children.onPersonWork(hooks.personWork)
    this.host.children.onFinishedWith(hooks.finishedWith ? (callerId, childId) => hooks.finishedWith?.(callerId, childId) : undefined)
    this.host.reports.useMail(hooks.report ? (ownerId, childId, draft) => hooks.report?.(ownerId, childId, draft) ?? 'none' : undefined)
    this.host.reports.useQuotes(hooks.quotes ? (stoppedId, readerId) => hooks.quotes?.(stoppedId, readerId) === true : undefined)
    this.host.children.onAnswered(hooks.answered ? (callerId, childId, how) => hooks.answered?.(callerId, childId, how) : undefined)
    this.host.children.onTurnStarted(hooks.turnStarted ? (sessionId, turn) => hooks.turnStarted?.(sessionId, turn) : undefined)
  }

  /** How the mailbox's delivery reaches a session (#1347): whether it can take mail now, and the mail. See `MailSessions` (mail/delivery.ts) */
  mailSessions(): MailSessions {
    return {
      receiver: (id) => this.mailReceiver(id),
      deliver: async (id, input, late) => {
        /*
         * A turn the mail starts is the work of the thread it carries (§6): its end is reported to the thread's owner like any turn of work that
         * session gave, so a report is owed from here. A session already owing the same owner keeps its mark (the turn is that work's); one owing
         * another owner keeps that mark and its pause, and this turn is reported to its own owner when it ends (#1474). A mark or a note made
         * here goes if the input was not taken
         */
        const owner = input.quiet ? undefined : input.reportTo
        const known = owner !== undefined && this.host.meta.has(owner)
        const marked = known && !this.host.children.awaitingReport.has(id)
        const other = known && this.host.children.awaitingReport.has(id) && this.host.children.awaitingReport.get(id) !== owner
        if (marked) this.host.children.markReport(id, owner)
        if (other) this.host.children.markMailTurn(id, owner)
        const unmark = () => {
          if (marked && this.host.children.awaitingReport.get(id) === owner) this.host.children.clearReport(id)
          if (other) this.host.children.clearMailTurn(id, owner)
        }
        try {
          await this.host.events.deliverMail(id, input, { leaving: () => this.host.closing, atRest: () => this.mailReceiver(id).kind === 'ready', wanted: () => input.wanted?.() ?? true }, (e) => {
            unmark()
            late?.(e)
          })
        } catch (e) {
          unmark()
          throw e
        }
      },
      note: (id, text) => {
        if (this.host.meta.has(id)) this.host.events.onEvent({ type: 'notice', sessionId: id, level: 'info', from: 'Centralu', label: 'mail', text })
      },
    }
  }

  /** The session's report to `ownerId` is held over its own background work (`pausedReports`) */
  pausedFor(sessionId: string, ownerId: string): boolean {
    return this.host.children.awaitingReport.get(sessionId) === ownerId && this.host.children.pausedReports.has(sessionId)
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
    if (needsAnswer(m)) return { kind: 'busy', why: 'card' }
    switch (m.state) {
      case 'working':
        return { kind: 'busy', why: 'turn' }
      case 'limited':
        return { kind: 'busy', why: 'limited' }
      default: {
        const live = this.host.handles.has(id)
        return { kind: 'ready', live, quiet: live && this.host.adapters.get(m.tool)?.quietInput === true, auto: m.permissionPreset === 'auto' }
      }
    }
  }

  /** The words of the turn a stop cut, as a stop notice quotes them (`ChildReports.stoppedTurnAnswer`, at most 600 characters), or null when it said none */
  stoppedWords(sessionId: string): string | null {
    if (!this.host.meta.has(sessionId)) return null
    return this.host.reports.stoppedTurnAnswer(sessionId).preview || null
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
