import { errorMessage, TurnOrigin } from '@cc/protocol'
import type { BackgroundTask, StoredMessage } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import type { AgentRunWait } from './app-agents.js'
import { asObj, tryParseJson } from '../json-value.js'
import { isHubSender } from './hub-sender.js'
import type { ThreadOrigin } from '../dev-services/store/mail-types.js'
import type { AnswerGiven } from '../mail/delegation.js'
import type { TurnSource, TurnStart } from '../mail/turns.js'
import type { AgentStartRecord } from './agent-start-record.js'

/**
 * How long a session whose own background work (#721) ended with no turn running, here or on a linked machine (#723), waits for the turn that
 * work's end may start before its last response answers (docs/plans/mailbox.md §10.6.3). Claude starts that turn within a second of the task's end
 * (its task-notification); a task the person stopped by hand starts none, and the last response then answers.
 */
export const OWN_WORK_SETTLE_MS = 60_000

/** One ask_project call's work in the target project (#371 part B) — see `ChildOwnership.delegations` */
export type Delegation = {
  callerId: string
  /** The delegated session, in the target project */
  sessionId: string
  target: { id: string; name: string; path: string }
  wait: AgentRunWait
  /** The turn's outcome, never rejecting */
  outcome: Promise<{ ok: true; answer?: string } | { ok: false; error: string }>
  readonly settled: boolean
  /** What the delegated session waits on, when it waits on the person */
  notice(): string | undefined
  /** Ends the wait and interrupts the turn */
  stop(why: string): void
  /** A child start_agent started in the caller's own project (#561), rather than ask_project's delegated session */
  agent?: boolean
  /** How many of the caller's calls are waiting on it right now (`awaitAgent`, `awaitDelegation`) */
  waiters?: number
  /** The owner's calls waiting on it now, ended when a handoff gives it to another session (#693) */
  leaving?: Set<() => void>
}

/**
 * Whose a turn is (#1377): the person's (it ran for the person's own messages), or the work's (a caller's message, an app's or
 * Centralu's, or none: the CLI's own). A turn belongs to no one (docs/plans/mailbox.md §10.6.3); this survives only as what a hub is
 * told of a turn's end (`LinkedReports`) and the mailbox's `mail_turns.started_by`. `wrote`: the person's message went into a turn of
 * the work. `cut`: an update of Centralu cut the turn and Centralu continued it (#1966): its end says so.
 */
export type TurnStarter = { by: 'person' | 'work'; wrote?: true; cut?: true }
/** A message given the tool, as its user row keeps it (#1639): the input id it went in under, whose it is, and a hub's message's origin (#1604) */
type Entry = { id: string; by: 'person' | 'work'; source: TurnSource; origin?: TurnOrigin; from?: string }
/**
 * The entry a user row is, when it went in under an input id (#1639): the person's when no one else is named on it. A first prompt and the
 * words read back from the tool's own record (`transcript`) carry none
 */
function entryOf(row: StoredMessage): Entry | undefined {
  const p = asObj(row.payload)
  if (row.role !== 'user' || typeof p.inputId !== 'string') return undefined
  const work = p.from !== undefined || p.fromApp !== undefined || p.fromScript !== undefined
  const hub = TurnOrigin.safeParse({ seq: row.seq, from: p.from })
  const from = asObj(p.from).sessionId
  return {
    id: p.inputId, by: work ? 'work' : 'person', source: p.relayed === true ? 'report' : p.fromApp !== undefined ? 'app' : 'caller',
    ...(hub.success && isHubSender(hub.data.from.sessionId) ? { origin: hub.data } : {}),
    ...(typeof from === 'string' ? { from } : {}),
  }
}
/**
 * Whose a turn is, as the mailbox is told it (`TurnStart`): `cli`, it ran for no message (a mail wake, a compact, the CLI on its own); `from`, the
 * session whose message of the work it ran for
 */
type Decided = { turn: TurnStarter; cli: boolean; source: TurnSource; from?: string }
/**
 * Whose a turn that ran for these messages is (#1377): the work's if any is (the work's instruction is in it), with the person's noted
 * (`wrote`), and its source the first of the work's; else the person's; none, the CLI's own (the work's)
 */
function starterFor(ran: readonly Entry[]): Decided {
  const work = ran.find((e) => e.by === 'work')
  if (!work) return ran.length ? { turn: { by: 'person' }, cli: false, source: 'caller' } : { turn: { by: 'work' }, cli: true, source: 'caller' }
  return { turn: { by: 'work', ...(ran.some((e) => e.by === 'person') ? { wrote: true as const } : {}) }, cli: false, source: work.source, ...(work.from ? { from: work.from } : {}) }
}
/**
 * Where the turns of a session a hub gives messages began (#1604), in `turn_span:<session>`, kept in the store because a hub
 * reads a turn's words after the turn: by then the next one may have begun, and a host that takes the session over after a
 * swap must know where the running turn began. `latest`: the row the last turn that began began after, and whether it has
 * ended; `previous`: the same for the turn before it. `starts` (#1812): the rows the last turns began after, oldest first, up to
 * `TURN_STARTS_KEPT`, so a turn a hub reads after more than one turn has followed it ends where the next began. Kept beside
 * `latest` and `previous`, which a build before it reads; a list that does not end at `latest` (that build wrote the span
 * since) is not read
 */
export const turnSpanKey = (sessionId: string) => `turn_span:${sessionId}`
const TURN_STARTS_KEPT = 8
/**
 * The last row stored when a question card of the session was last answered (#1948), in `question_answered:<session>`: the answer goes
 * to the tool and is stored nowhere else, so a stop notice that quotes the turn knows the turn took the person's answer in
 */
export const questionAnsweredKey = (sessionId: string) => `question_answered:${sessionId}`
type TurnSpan = { latest?: { since: number; ended?: true }; previous?: { since: number }; starts?: readonly number[] }
function readTurnSpan(raw: string | null): TurnSpan {
  if (raw === null) return {}
  const p = asObj(tryParseJson(raw))
  const [l, before] = [asObj(p.latest), asObj(p.previous)]
  const latest = typeof l.since === 'number' ? { since: l.since, ...(l.ended === true ? { ended: true as const } : {}) } : undefined
  const previous = typeof before.since === 'number' ? { since: before.since } : undefined
  const listed: unknown[] = Array.isArray(p.starts) ? p.starts : []
  const starts = listed.filter((s): s is number => typeof s === 'number')
  const kept = latest && starts.length === listed.length && starts.at(-1) === latest.since
  return { ...(latest ? { latest } : {}), ...(previous ? { previous } : {}), ...(kept ? { starts } : {}) }
}
/** The turn starts a span keeps, oldest first: its list, or the two a build before it kept */
function startsOf(span: TurnSpan): readonly number[] {
  return span.starts ?? [span.previous?.since, span.latest?.since].filter((s): s is number => s !== undefined)
}
/**
 * A linked machine's session an Assistant asked to hear about (#82 phase 4). `paused`: the session's own background
 * work a completed turn there ended with (#723); the report stays owed until a turn ends with none of it left.
 * `instruction`: the text of the instruction the wait was set for, while the machine has not yet been heard recording it
 * (#1082); until then nothing it relays is about that instruction's turn
 */
export type LinkedReport = {
  assistantId: string
  busy: boolean
  paused?: BackgroundTask[]
  instruction?: string
  /** Whose the turn running there is (#1377), and whose the next will be: from the message each started with. Memory only */
  turn?: TurnStarter
  next?: TurnStarter
  /** Whose the last turn there was: its last response is the person's answer when it was theirs */
  lastBy?: 'person' | 'work'
  /** The last response the report of this pause read (#1186): a report a lost link sends in its place carries it, marked as read then. Memory only */
  read?: { preview: string; seq: number | undefined }
}

/** What one owner change moves (`ChildOwnership.moveOwner`), as the session manager chose it */
export type OwnerMove = {
  /** The child sessions that move, in the order the handoff note lists them */
  sessions: readonly string[]
  /** The original's start_agent requests still open that move with it */
  starts: readonly AgentStartRecord[]
}

type OwnershipStore = Pick<Store, 'children' | 'settings' | 'mailbox' | 'messages'>

/**
 * Who owns a child session's work (#428): the turn another session gave it, the
 * delegations and start requests a session made, and what a handoff gave away. What a session owes the sessions that gave it work is the
 * mailbox's open tasks (`openTasks`, docs/plans/mailbox.md §10.6.3). Each change that has a store mirror writes it here, so
 * memory and store do not drift apart; reads go through the read-only maps.
 *
 * An owner change is one operation (`moveOwner`), so a handoff does not keep these maps in step by hand. Deciding what
 * moves, and the store's own transaction for it (`Store.moveChildren`), stay with the session manager, which knows the
 * sessions' state.
 */
export class ChildOwnership {
  /**
   * Whose the running turn is, by session (#1377): guessed as it starts (`turnStarted`), decided by the inputs the tool names (`turnNamed`),
   * read at its end. Memory only: a host that takes a session over mid-turn reads its turn as the work's
   */
  private readonly starters = new Map<string, Decided>()
  /** Sessions whose running turn an update cut and Centralu continued (#1966): the turn's end carries it, once. Memory only */
  private readonly continuedCuts = new Set<string>()
  /** Running turns whose opening input the tool named (`turnNamed`); one not named is decided by the inputs its end names */
  private readonly named = new Set<string>()
  /**
   * ask_project's delegations still owed to their caller (#371 part B) — `<caller session>><target project>><target session>` -> the
   * delegation. One per chosen session at a time: a second task while the first runs is refused, and a call with no task waits
   * on this one. Removed once the caller has read the outcome; an outcome nobody comes back for goes with the caller.
   */
  private readonly runs = new Map<string, Delegation>()
  readonly delegations: ReadonlyMap<string, Delegation> = this.runs
  /**
   * start_agent requests whose card stands or stood (#673) — request id -> the request. A card is no longer withdrawn
   * when the call's bound passes: the call answers "pending" with the request id as a handle, the card stays until the
   * person answers, and an approval starts the child then. Mirrored in the store's `agent_start_requests` while it
   * stands, so the next host raises it again (`resumeAgentStart`). Kept after it ends, for agent_session on the handle,
   * until the caller goes.
   */
  private readonly starts = new Map<string, AgentStartRecord>()
  readonly agentStarts: ReadonlyMap<string, AgentStartRecord> = this.starts
  /**
   * What a handoff gave away (#693): child session or start request id -> the original and the session that took over.
   * An original that stays (a handoff that keeps it) and asks about one of them is told where it went, rather than "not
   * a session this session started". Live only, like the delegations it explains; goes when either session is deleted.
   */
  private readonly given = new Map<string, { from: string; to: string }>()
  readonly handedOver: ReadonlyMap<string, { from: string; to: string }> = this.given
  /**
   * A linked machine's sessions whose turn the Assistant asked to hear about (`reportBack`, #82 phase 4), by
   * qualified id. `busy` is whether that turn was seen working yet, so a state the machine reports before the turn
   * starts (the session waking) is not taken for its end.
   */
  private readonly linked = new Map<string, LinkedReport>()
  readonly linkedReports: ReadonlyMap<string, LinkedReport> = this.linked
  /**
   * Told of each change to a linked report (#1038): a child start_agent started on a linked machine keeps what it is
   * owed in its stored record (`RemoteAgents`), so a restarted hub still reports its end
   */
  private linkedChanged: ((sessionId: string) => void) | undefined

  constructor(private readonly store: OwnershipStore) {}

  /** The mailbox's way of hearing that a session gave another one work (docs/plans/mailbox.md §8.1), set by the host when it has one */
  private delegatedHook: ((callerId: string, childId: string, origin: ThreadOrigin, task: string) => (() => void) | undefined) | undefined
  onDelegated(hook: ChildOwnership['delegatedHook']): void {
    this.delegatedHook = hook
  }

  /** The mailbox's open tasks between a session and others (docs/plans/mailbox.md §10.6.3), set by the host when it has one */
  private openTasksHook: ((sessionId: string, side: 'to' | 'from') => string[]) | undefined
  onOpenTasks(hook: ChildOwnership['openTasksHook']): void {
    this.openTasksHook = hook
  }

  /**
   * The sessions with a task open between them and `sessionId` (delivered, not settled, not released): the senders of its tasks (`to`, whom it
   * owes an answer; `PERSON` for the person's own work), or the receivers of its own (`from`, whose answer it waits for). None with no mailbox.
   * Never throws
   */
  openTasks(sessionId: string, side: 'to' | 'from'): string[] {
    try {
      return this.openTasksHook?.(sessionId, side) ?? []
    } catch (e) {
      console.error(`[mail] could not read the tasks open with ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
      return []
    }
  }

  /**
   * The mailbox's way of keeping work the person owns (§8.1): a session a script or the RPC started with a first message. `started` writes it down
   * before the message goes in, `withdrawn` takes it back when the message could not go in. The task is answered as any task is (mailbox.md §10.6.3).
   * Set by the host when it has a mailbox
   */
  private personWork: { started(sessionId: string, text: string, fromScript?: { credential: string }): void; withdrawn(sessionId: string): void } | undefined
  onPersonWork(hooks: ChildOwnership['personWork']): void {
    this.personWork = hooks
  }

  /**
   * A new session's first message `text`, sent by `send`. A script's (`fromScript`) is work the person owns, written down first; when
   * `send` throws, no turn will come of it and the person's task is withdrawn (#1463) before the error goes on
   */
  firstMessage(sessionId: string, text: string, fromScript: { credential: string } | undefined, send: () => void): void {
    if (!fromScript) return send()
    this.personCall('write down the work for the person started in', sessionId, (w) => w.started(sessionId, text, fromScript))
    try {
      send()
    } catch (e) {
      this.personCall('withdraw the work for the person started in', sessionId, (w) => w.withdrawn(sessionId))
      throw e
    }
  }

  /** A call into the mailbox's person work, none without a mailbox; a failure is logged */
  private personCall(what: string, sessionId: string, call: (w: NonNullable<ChildOwnership['personWork']>) => void): void {
    try {
      if (this.personWork) call(this.personWork)
    } catch (e) {
      console.error(`[mail] could not ${what} ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  /** The mailbox's way of hearing that a session is done with work it gave (it deletes the session that did it), set by the host when it has one */
  private finishedHook: ((callerId: string, childId: string) => void) | undefined
  onFinishedWith(hook: ChildOwnership['finishedHook']): void {
    this.finishedHook = hook
  }

  /** `callerId` is done with what `childId` did for it, and deletes the session: a thread whose work was reported is closed. Never throws */
  finishedWith(callerId: string, childId: string): void {
    if (callerId === childId || !this.finishedHook) return
    try {
      this.finishedHook(callerId, childId)
    } catch (e) {
      console.error(`[mail] could not close the work ${childId.slice(0, 8)} did for ${callerId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  /** The mailbox's way of hearing that a call returned the answer of work it gave (§8.1), set by the host when it has one */
  private answeredHook: ((callerId: string, childId: string, how?: AnswerGiven) => void) | undefined
  onAnswered(hook: ChildOwnership['answeredHook']): void {
    this.answeredHook = hook
  }

  /**
   * A call of `callerId` returned what `childId` answered (`how`: it finished with this text, or its turn failed with this reason), or
   * read where it stands without one: the reports the mailbox holds for the caller are settled, and the thread is reported on by the call.
   * Never throws
   */
  answered(callerId: string, childId: string, how?: AnswerGiven): void {
    if (callerId === childId || !this.answeredHook) return
    try {
      this.answeredHook(callerId, childId, how)
    } catch (e) {
      console.error(`[mail] could not settle what ${callerId.slice(0, 8)} read of ${childId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  /**
   * `callerId` gave `childId` this task by `origin`, delivered by the host: the mailbox writes it down, in step with the old path
   * (a thread the caller owns and the child is assigned, `running`). Returns how to withdraw it, for a task written before its words go in
   * (start_agent's) that could not go in. Neither throws: the mailbox must not break a delegation
   */
  delegated(callerId: string, childId: string, origin: ThreadOrigin, task: string): () => void {
    if (callerId === childId || !this.delegatedHook) return () => {}
    try {
      const withdraw = this.delegatedHook(callerId, childId, origin, task)
      return () => {
        try {
          withdraw?.()
        } catch (e) {
          console.error(`[mail] could not withdraw the work ${callerId.slice(0, 8)} gave ${childId.slice(0, 8)} (${errorMessage(e)})`)
        }
      }
    } catch (e) {
      console.error(`[mail] could not write down the work ${callerId.slice(0, 8)} gave ${childId.slice(0, 8)} (${errorMessage(e)})`)
      return () => {}
    }
  }

  /** The session is deleted: nothing kept of its turns (for a hub that followed them) is kept (`purgeSession` removes the same keys by their shape) */
  forgetTurns(sessionId: string): void {
    this.store.settings.deleteAppSetting(turnSpanKey(sessionId))
    this.store.settings.deleteAppSetting(questionAnsweredKey(sessionId))
    this.starters.delete(sessionId)
    this.named.delete(sessionId)
  }
  /**
   * A turn began after row `seq` of the session's record: the turn's own text is every row after it (#1604). Kept for every session, not only
   * one a hub follows: a stop notice quotes the stopped turn's words, never the turn before's (#1946)
   */
  noteTurnStart(sessionId: string, seq: number): void {
    this.store.settings.updateAppSetting(turnSpanKey(sessionId), (raw) => {
      const was = readTurnSpan(raw)
      const starts = [...startsOf(was), seq].slice(-TURN_STARTS_KEPT)
      return JSON.stringify({ latest: { since: seq }, ...(was.latest ? { previous: { since: was.latest.since } } : {}), starts })
    })
  }
  /**
   * The turn ended: its words are settled, and the turn after it begins where they stop (`turnRows`). Also where the process that ran the
   * turn is gone (#1604): this host started with no process for a session the last one left mid-turn, so that turn never sends its end, and
   * its words are those said so far (or none), never the turn before's
   */
  noteTurnEnd(sessionId: string): void {
    const key = turnSpanKey(sessionId)
    const raw = this.store.settings.appSetting(key)
    if (raw === null || readTurnSpan(raw).latest?.ended) return
    this.store.settings.updateAppSetting(key, (current) => {
      const was = readTurnSpan(current)
      return was.latest ? JSON.stringify({ ...was, latest: { ...was.latest, ended: true } }) : (current ?? '{}')
    })
  }
  /**
   * The rows of the last turn that ended, when this session's turns were seen to begin (#1604): the latest when it has ended,
   * else the one before it up to where the latest began (a hub reads a turn's end after the next one has begun). A turn that
   * ended with nothing to say has no words, and never the turn before's. None recorded (a turn from before this build, a
   * session no hub gives messages): undefined. `since` (#1812): the turn that began after that row, the one a hub was told
   * ended, up to where the next began. A row that is not a start kept (one more than `TURN_STARTS_KEPT` turns ago, or a span a
   * build before it wrote) reads as with none: the last turn that ended
   */
  turnRows(sessionId: string, since?: number): { after: number; through?: number } | undefined {
    const span = readTurnSpan(this.store.settings.appSetting(turnSpanKey(sessionId)))
    const kept = startsOf(span)
    if (since !== undefined && kept.includes(since)) {
      const next = kept.find((s) => s > since)
      return next === undefined ? { after: since } : { after: since, through: next }
    }
    if (span.latest?.ended) return { after: span.latest.since }
    if (span.latest && span.previous) return { after: span.previous.since, through: span.latest.since }
    return span.latest ? { after: span.latest.since } : undefined
  }
  /** The rows of the turn that began last, ended or not (#1946): the turn a stop cut, though an update's continue runs on in it */
  latestTurnRows(sessionId: string): { after: number } | undefined {
    const since = readTurnSpan(this.store.settings.appSetting(turnSpanKey(sessionId))).latest?.since
    return since === undefined ? undefined : { after: since }
  }
  /** A question card of the session was answered (#1948): the answer went to the tool, into the turn running (`latestTurnInputs`) */
  noteQuestionAnswered(sessionId: string): void {
    this.store.settings.setAppSetting(questionAnsweredKey(sessionId), String(this.store.messages.nextSeq(sessionId) - 1))
  }
  /**
   * Who gave each thing that may have entered the session's latest turn (#1948): every user row stored since the turn before it began (every
   * row, with no turn before), as the session id that sent it, or null for one no session sent (the person, an app, a script, a relayed report,
   * words read back from the tool's own record), and a null for a question card answered since. The turn before's own rows count too. Mail
   * given in leaves no user row (the mailbox has those) but a delegated task's, which names its sender (`SessionEvents.deliverMail`). No turn seen
   * to begin: one null
   */
  latestTurnInputs(sessionId: string): (string | null)[] {
    const span = readTurnSpan(this.store.settings.appSetting(turnSpanKey(sessionId)))
    if (!span.latest) return [null]
    const from = span.previous?.since ?? 0
    const answered = Number(this.store.settings.appSetting(questionAnsweredKey(sessionId)) ?? NaN)
    const rows = this.store.messages.loadUserRowsFrom(sessionId, from).map((row) => {
      const p = asObj(row.payload)
      const sender = asObj(p.from).sessionId
      // Only a session's own message names it (`from`): the person's, an app's, a script's and the tool's own record's rows name none
      return typeof sender === 'string' && p.relayed !== true ? sender : null
    })
    return answered >= from ? [...rows, null] : rows
  }
  /** The mailbox's way of hearing that a turn started (§6), set by the host when it has one */
  private turnStartedHook: ((sessionId: string, turn: TurnStart) => void) | undefined
  onTurnStarted(hook: ChildOwnership['turnStartedHook']): void {
    this.turnStartedHook = hook
  }

  /**
   * Whose a turn is is read from the store's user rows (#1639, docs/plans/turn-starter.md "After #1948 step 3"): each message given the tool is a
   * user row with its input id. These are the session's entries after row `after`, or, with `inputs`, the ones among them the tool named
   */
  private entries(sessionId: string, after: number, inputs?: readonly string[]): Entry[] {
    return this.store.messages.loadUserRowsFrom(sessionId, after).flatMap((row) => {
      const e = entryOf(row)
      return e && (!inputs || inputs.includes(e.id)) ? [e] : []
    })
  }
  /**
   * The entries the tool named, looked up from the oldest turn start kept: a message given that many turns ago is no longer run. Every row while
   * fewer are kept: a message given before the first turn begins is before every start
   */
  private namedEntries(sessionId: string, inputs: readonly string[]): Entry[] {
    const kept = startsOf(readTurnSpan(this.store.settings.appSetting(turnSpanKey(sessionId))))
    return this.entries(sessionId, kept.length < TURN_STARTS_KEPT ? 0 : (kept[0] ?? 0), inputs)
  }

  /**
   * A turn starts (#1377): a first guess until the tool names its inputs (`turnNamed`). The message the newest row is, when it is one (given at
   * rest, after every row the turns before wrote), else the CLI's own (a mail wake, a compact, the work's background tasks ended)
   */
  turnStarted(sessionId: string): void {
    this.named.delete(sessionId)
    this.decide(sessionId, starterFor(this.entries(sessionId, this.store.messages.nextSeq(sessionId) - 2)), false)
  }
  /**
   * The tool names the inputs the turn opening now runs for (#1639, `SessionHandle.turnStartInputs`), once per turn: the rows given under them
   * decide it (`starterFor`); none (a mail wake, a compact, a quiet note, `[]`): the CLI's own. `null`: not an opening, nothing changes.
   * Returns the hub's message it ran for, the last one named (#1604), said with the event that opens it
   */
  turnNamed(sessionId: string, inputs: readonly string[] | null | undefined): TurnOrigin | undefined {
    if (inputs === null || inputs === undefined || this.named.has(sessionId)) return undefined
    this.named.add(sessionId)
    const ran = this.namedEntries(sessionId, inputs)
    this.decide(sessionId, starterFor(ran), true)
    return ran.at(-1)?.origin
  }
  /** Records whose the running turn is and tells the mailbox; `again`: it was guessed before, and is only told when it differs */
  private decide(sessionId: string, decided: Decided, again: boolean): void {
    const was = this.starters.get(sessionId)
    if (again && was && was.turn.by === decided.turn.by && !!was.turn.wrote === !!decided.turn.wrote && was.cli === decided.cli) return
    this.starters.set(sessionId, decided)
    if (!this.turnStartedHook) return
    // The session whose request the turn runs for: the message it opened with names it, else a delegation still running there gave it (its first prompt)
    const ownerId = decided.from ?? [...this.runs.values()].find((d) => d.sessionId === sessionId && !d.settled)?.callerId
    try {
      this.turnStartedHook(sessionId, { by: decided.turn.by, cli: decided.cli, source: decided.source, ...(ownerId ? { ownerId } : {}), ...(again ? { again: true as const } : {}) })
    } catch (e) {
      console.error(`[mail] could not record a turn of ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }
  /**
   * The turn ends (#1377): whose it was, kept nowhere after. `taken`: the inputs the tool says the turn took in (`SessionHandle.turnInputs`);
   * undefined when it takes in every message sent to a running turn, null when it cannot tell. A turn whose opening was not named (a card was
   * up, the tool answered without a stream, or this host did not see it begin) is decided by them. `wrote`: a person's message went into the
   * work's turn, one the tool names as taken, or with `taken` undefined, one given after the turn began
   */
  turnEnded(sessionId: string, taken?: readonly string[] | null): TurnStarter {
    if (!this.named.has(sessionId) && taken?.length) this.turnNamed(sessionId, taken)
    this.named.delete(sessionId)
    const turn: TurnStarter = { ...(this.starters.get(sessionId)?.turn ?? { by: 'work' as const }) }
    this.starters.delete(sessionId)
    if (this.continuedCuts.delete(sessionId)) turn.cut = true
    const began = this.latestTurnRows(sessionId)?.after
    const joined = taken ? this.namedEntries(sessionId, taken) : taken === undefined && began !== undefined ? this.entries(sessionId, began) : []
    if (turn.by === 'work' && joined.some((e) => e.by === 'person')) turn.wrote = true
    this.noteTurnEnd(sessionId)
    return turn
  }
  /** The turn running was cut by an update and continued (#1966): its report says so in one line */
  noteContinuedCut(sessionId: string): void {
    this.continuedCuts.add(sessionId)
  }
  /** The Continue did not go in after all: the turn's end is a stopped turn's, not a continued one's */
  dropContinuedCut(sessionId: string): void {
    this.continuedCuts.delete(sessionId)
  }

  setDelegation(key: string, d: Delegation): void {
    this.runs.set(key, d)
  }
  /** Drops the delegation under `key`; with `only`, only while that one is still there */
  dropDelegation(key: string, only?: Delegation): void {
    if (only && this.runs.get(key) !== only) return
    this.runs.delete(key)
  }

  addAgentStart(rec: AgentStartRecord): void {
    this.starts.set(rec.req.requestId, rec)
  }
  dropAgentStart(requestId: string): void {
    this.starts.delete(requestId)
  }

  /** A start_agent call whose request a handoff gave away made its child (#693): the child is the new owner's */
  recordHandedOver(id: string, from: string, to: string): void {
    this.given.set(id, { from, to })
  }
  /** What a handoff gave away from the session, or to it, or the given work itself */
  forgetHandedOver(sessionId: string): void {
    for (const [id, h] of [...this.given]) if (id === sessionId || h.from === sessionId || h.to === sessionId) this.given.delete(id)
  }

  /** Set again with the same report after changing it in place, so its listener reads the change */
  setLinkedReport(sessionId: string, wait: LinkedReport): void {
    this.linked.set(sessionId, wait)
    this.linkedChanged?.(sessionId)
  }
  dropLinkedReport(sessionId: string): void {
    if (this.linked.delete(sessionId)) this.linkedChanged?.(sessionId)
  }
  onLinkedReportChange(listener: (sessionId: string) => void): void {
    this.linkedChanged = listener
  }

  /**
   * Moves what `from` owns of the given children to `to`, in memory (#693, #738): its delegations and observer notes on them (their keys
   * name the caller), linked machines' reports, and the start requests that made
   * them. `moveCards` runs next, for the cards that stand for the moving `starts`; then what moved is recorded as
   * handed over, and the original's calls still waiting on it are ended.
   *
   * The caller has already moved what is stored (`Store.moveChildren`) and the sessions' own `askedBy` and
   * `parentSessionId`. Nothing here awaits, so no event lands in the middle.
   */
  moveOwner(from: string, to: string, move: OwnerMove, moveCards: () => void): void {
    const { sessions, starts } = move
    const moving = new Set(sessions)
    // A delegation's key names its caller (`<caller>><child>`, `<caller>><project>><child>`)
    for (const [key, d] of [...this.runs]) {
      if (d.callerId !== from || !moving.has(d.sessionId)) continue
      this.runs.delete(key)
      d.callerId = to
      this.runs.set(to + key.slice(from.length), d)
    }
    for (const [id, wait] of this.linked) {
      if (wait.assistantId !== from || !moving.has(id)) continue
      wait.assistantId = to
      this.linkedChanged?.(id)
    }
    // A start that already made its child: its handle follows the child
    for (const r of this.starts.values()) if (r.req.callerId === from && r.ended && 'childId' in r.ended && moving.has(r.ended.childId)) r.req.callerId = to
    moveCards()
    /*
     * The original learns what it no longer follows (#693 review): a handoff can keep it, and its next agent_session or
     * ask_project about one of these says where it went. Its calls still waiting on one of them end now, with that
     * answer, so the result is read once, by the new session.
     */
    for (const id of [...sessions, ...starts.map((r) => r.req.requestId)]) this.given.set(id, { from, to })
    for (const r of starts) if (!r.detached) r.detached = true
    for (const d of this.runs.values()) if (d.callerId === to && moving.has(d.sessionId)) for (const leave of [...(d.leaving ?? [])]) leave()
    for (const r of starts) for (const leave of [...(r.leaving ?? [])]) leave()
  }
}

