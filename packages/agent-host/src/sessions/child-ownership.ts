import { randomUUID } from 'node:crypto'
import { errorMessage, TurnOrigin } from '@cc/protocol'
import type { ApprovalDetail, BackgroundTask, SessionInfo, StoredMessage } from '@cc/protocol'
import type { QueuedRequest, Store } from '../dev-services/store.js'
import type { AgentRunWait } from './app-agents.js'
import { inTurn } from '../idle.js'
import { readJsonObjects } from '../dev-services/store/json.js'
import { asObj, tryParseJson } from '../json-value.js'
import { HUB_SENDER } from './hub-sender.js'
import type { ThreadOrigin } from '../dev-services/store/mail.js'
import type { AnswerGiven } from '../mail/delegation.js'
import type { TurnSource, TurnStart } from '../mail/turns.js'

/**
 * How long a report held over a session's own background work (#721), here or on a linked machine (#723), waits, once
 * that work has ended with no turn running, for the turn its ending may start. Claude starts that turn within a second
 * of the task's end (its task-notification); a task the person stopped by hand starts none, and the report then goes
 * out with the last answer.
 */
export const PAUSED_REPORT_SETTLE_MS = 60_000

/** The tools a request can be queued through that this build delivers (#677); a row of another is left alone (#384) */
const QUEUED_VIA: ReadonlySet<string> = new Set<QueuedRequest['via']>(['ask_project', 'agent_session', 'send_to_session'])

/**
 * A start_agent request waiting on the person's card (#673), as stored in `agent_start_requests`: everything the start
 * needs once allowed, so a host that takes over after a swap or restart can raise the card again and start the child.
 */
export type AgentStartRequest = {
  requestId: string
  callerId: string
  projectId: string
  tool: string
  model?: string
  effort?: string
  worktreeBranch?: string
  task: string
  unchecked?: string
  /** start_agent's code intelligence choice (#686) */
  lsp?: boolean
  /** The name the child starts with (#861): the caller's, or one made from its task; absent for a worktree child named by its branch */
  name?: string
  /**
   * The start is allowed (by the card or the project's trust) and waits only for memory (#686): a host that takes it
   * over starts it when memory allows, without raising the card again
   */
  allowed?: true
  detail: Extract<ApprovalDetail, { kind: 'agent_start' }>
}

/** One such request while this host serves it (`ChildOwnership.agentStarts`) */
export type AgentStartRecord = {
  req: AgentStartRequest
  /** The call that raised it has answered "pending" (#673): how it ends is told to the caller as a message */
  detached: boolean
  ended?: { childId: string } | { error: string }
  /** Resolves when it ends (agent_session wait on the handle) */
  done: Promise<void>
  end: () => void
  /** Allowed, and queued until memory recovers (#686): what was read when it was queued */
  lowMemory?: LowMemory
  /** Ends the wait for memory, when the request ends another way (withdrawn, the caller deleted) */
  stopWaiting?: () => void
  /** The caller's waits on the handle now, ended when a handoff gives the request to another session (#693) */
  leaving?: Set<() => void>
}

/** A start queued for memory (#686), as the caller reads it */
export type LowMemory = { available: string; floor: string; maxWaitMinutes: number }

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
  /** A task that joined the person's running turn: caller cancellation must leave that turn alone. */
  joinedTurn?: boolean
  /** Ends only the caller's wait, keeping the target's receipt watcher and observers alive. */
  waitCancelled?: Promise<{ ok: false; error: string }>
  /** Ends the wait; interrupts only an assigned turn or an explicit stop of the target itself. */
  stop(why: string, targetStop?: boolean): void
  /** A child start_agent started in the caller's own project (#561), rather than ask_project's delegated session */
  agent?: boolean
  /** How many of the caller's calls are waiting on it right now (`awaitAgent`, `awaitDelegation`) */
  waiters?: number
  /** The owner's calls waiting on it now, ended when a handoff gives it to another session (#693) */
  leaving?: Set<() => void>
}

/** The store's record that a session's owed report is held over its own background work (#721), kept across a swap */
export const pausedReportKey = (sessionId: string) => `report_paused:${sessionId}`
/** A task a paused report waits on (#721), as kept in `report_paused:<session>` */
export type PausedTask = { id: string; description: string }
/** The tasks of a stored pause, or null when there is none (an unreadable value is a pause on nothing known) */
export function readPausedTasks(raw: string | null): PausedTask[] | null {
  if (raw === null) return null
  return readJsonObjects<PausedTask>(raw, (t) => typeof t.id === 'string' && typeof t.description === 'string')
}

/**
 * Whose a turn is (#1377): the person's (the person wrote while the session was at rest, or their message waited for
 * the turn), or the delegated work's (the caller's message, an app's or Centralu's, or the CLI starting it itself when
 * the work's background tasks end). `wrote`: the person wrote into a turn of the work; `added`: the person chose to add
 * their message to the task.
 */
export type TurnStarter = { by: 'person' | 'work'; wrote?: true; added?: true }
/**
 * A message given the tool (#1639, docs/plans/turn-starter.md): the input id and row it went in under (none in a test that gives no
 * row), whose it is, and `joined`: it is queued while a turn runs (given into it, or behind the input it opened from), which may take it in
 * at a tool round; `after`: it went in while a turn ran, to a tool that holds it for a turn after that one; `carried`: it went into a turn that
 * ended naming nothing (Codex), which took it in unless the next turn opens for it. `origin`: a hub's message (#1604)
 */
type Entry = { id?: string; seq?: number; by: 'person' | 'work'; added?: true; source: TurnSource; joined: boolean; after?: true; carried?: true; origin?: TurnOrigin }
/**
 * Where each session's messages given its tool stand (#1639), in `turn_inputs:<session>`: `spent`, the rows at or before it are done
 * with, and the held ones are the user rows after it that carry an `inputId`; and of the running turn, whether its opening was named, whether
 * the person took it over, and which held ids are `joined`, `after` or `carried`. Read back once per host, so a host that takes a kept session over
 * mid-turn decides as the one before would have
 */
export const turnInputsKey = (sessionId: string) => `turn_inputs:${sessionId}`
function readInputs(raw: string | null) {
  const p = raw === null ? {} : asObj(tryParseJson(raw))
  const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return { spent: typeof p.spent === 'number' ? p.spent : null, named: p.named === true, takenOver: p.takenOver === true, joined: ids(p.joined), after: ids(p.after), carried: ids(p.carried) }
}
/** The entry a user row is, when it went in under an input id (#1639): the person's when no one else is named on it */
function entryOf(row: StoredMessage): (Entry & { id: string }) | undefined {
  const p = asObj(row.payload)
  if (row.role !== 'user' || typeof p.inputId !== 'string') return undefined
  const work = p.from !== undefined || p.fromApp !== undefined || p.fromScript !== undefined
  const hub = TurnOrigin.safeParse({ seq: row.seq, from: p.from })
  return {
    id: p.inputId, seq: row.seq, by: work ? 'work' : 'person', ...(p.intent === 'task' ? { added: true as const } : {}),
    source: p.relayed === true ? 'report' : p.fromApp !== undefined ? 'app' : 'caller', joined: false,
    ...(hub.success && hub.data.from.sessionId === HUB_SENDER ? { origin: hub.data } : {}),
  }
}
/**
 * Whose a turn that ran for these messages is (#1377): the work's if any is (the work's instruction is in it), with the person's noted
 * (`wrote`, or `added` for "Add to the task"); else the person's. The source is the first of the work's
 */
function starterFor(ran: readonly Entry[]): { starter: TurnStarter; source: TurnSource } {
  const source = ran.find((e) => e.by === 'work')?.source ?? 'caller'
  if (ran.some((e) => e.added)) return { starter: { by: 'work', added: true }, source }
  if (!ran.some((e) => e.by === 'work')) return { starter: { by: 'person' }, source }
  return { starter: { by: 'work', ...(ran.some((e) => e.by === 'person') ? { wrote: true as const } : {}) }, source }
}
/** The store's record of the turn a session with an owed report is in (#1377), kept across a swap */
export const reportTurnKey = (sessionId: string) => `report_turn:${sessionId}`
/**
 * The hub's messages the tool holds (#1604), in `input_origins:<session>`: `[inputId, origin][]`. Written from the held entries (the ones
 * with an `origin`) for a build before #1639, which reads it during a swap; this build reads the entries. Removed in the release after
 * #1639 (add first, remove later). Its presence also marks a session a hub follows (`followedByHub`)
 */
export const inputOriginsKey = (sessionId: string) => `input_origins:${sessionId}`
const MAX_INPUT_ORIGINS = 64
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
/** The turn kept in `report_turn:<session>`: its known fields only (a build before #1639 kept a `pending` list beside them) */
function readTurn(raw: string | null): TurnStarter | null {
  const t = raw === null ? {} : asObj(tryParseJson(raw))
  if (t.by !== 'person' && t.by !== 'work') return null
  return { by: t.by, ...(t.wrote === true ? { wrote: true as const } : {}), ...(t.added === true ? { added: true as const } : {}) }
}

/** A delegated turn's link (#676): who gave the turn, and the cards it was already told of */
export type TurnOwner = { callerId: string; untilTurnEnd: boolean; told: Set<string>; turnId: string }

/**
 * A linked machine's session an orchestrator asked to hear about (#82 phase 4). `paused`: the session's own background
 * work a completed turn there ended with (#723); the report stays owed until a turn ends with none of it left.
 * `instruction`: the text of the instruction the wait was set for, while the machine has not yet been heard recording it
 * (#1082); until then nothing it relays is about that instruction's turn
 */
export type LinkedReport = {
  orchestratorId: string
  busy: boolean
  paused?: BackgroundTask[]
  instruction?: string
  /** Whose the turn running there is (#1377), and whose the next will be: from the message each started with. Memory only */
  turn?: TurnStarter
  next?: TurnStarter
  /** Whose the last turn there was: its last response is the person's answer when it was theirs */
  lastBy?: 'person' | 'work'
  /** When the person chose "Add to the task" for the message on its way to the machine (#1377): an older machine does not echo the choice */
  addNext?: number
}

/** What one owner change moves (`ChildOwnership.moveOwner`), as the session manager chose it */
export type OwnerMove = {
  /** The child sessions that move, in the order the handoff note lists them */
  sessions: readonly string[]
  /** Children a wait of the original had taken the report mark down for: the mark is owed to the new owner */
  armReports: readonly string[]
  /** The original's start_agent requests still open that move with it */
  starts: readonly AgentStartRecord[]
  /** Whether the requests the original queued move too (not for a removed original: the session archive drops them) */
  queued: boolean
}

type OwnershipStore = Pick<Store, 'children' | 'settings' | 'mailbox' | 'messages'>

/** The end of a turn of work the person owns, as the mailbox takes it (§8.1): Centralu's words, the session's own beside them, and where the thread goes */
export type PersonReportDraft = { outcome: string; body: string; answer?: string; error?: string; paused?: number; then: 'review' | 'running' }

/**
 * Who owns a child session's work (#428): the report a child owes and to whom, a report paused over the child's own
 * background work, the turn another session gave it, the requests held for it while it is busy, the delegations and
 * start requests a session made, and what a handoff gave away. Each change that has a store mirror writes it here, so
 * memory and store do not drift apart; reads go through the read-only maps.
 *
 * An owner change is one operation (`moveOwner`), so a handoff does not keep these maps in step by hand. Deciding what
 * moves, and the store's own transaction for it (`Store.moveChildren`), stay with the session manager, which knows the
 * sessions' state.
 */
export class ChildOwnership {
  /**
   * Session asked to be reported on completion -> orchestrator to notify (removed once notified). Mirrored in the
   * store's `report_marks` (v49, #646) through `markReport` / `clearReport`, so a host swap (#280) does not lose
   * "you will be told when it ends": the constructor reads the marks back for the sessions the keeper kept.
   */
  private readonly reports = new Map<string, string>()
  readonly awaitingReport: ReadonlyMap<string, string> = this.reports
  /**
   * An auto observer's own mid-turn note (#646), `<observer>><session>` -> the reader its receipt is held on. The
   * observer's `status` and `wait` read this, never the owner's delegation, until a read takes its settled outcome.
   */
  private readonly notes = new Map<string, { run: Delegation; waiters: number; told: boolean }>()
  readonly observerNotes: ReadonlyMap<string, { run: Delegation; waiters: number; told: boolean }> = this.notes
  /**
   * Reports held over the session's own background work (#721): a turn ended while work it started still ran, so the
   * work is paused, not over. The report stays owed in `awaitingReport` (its caller was told once that it paused) and
   * goes out at the end of a turn with none of that work left, or `PAUSED_REPORT_SETTLE_MS` after the work ended with
   * no turn following. Holds the tasks it paused on (each id and description, for how they ended and for `stop`).
   * Mirrored in the app setting `report_paused:<session>`, so a swap keeps it with the mark.
   */
  private readonly paused = new Map<string, PausedTask[]>()
  readonly pausedReports: ReadonlyMap<string, PausedTask[]> = this.paused
  /**
   * Whose the running turn is, by session (#1377): recorded when the turn starts from the message that started it, decided
   * at its end (`ChildReports.reportBackIfAwaited`). Mirrored in the app setting `report_turn:<session>` while a report is
   * owed, so a host that takes over a kept session mid-turn knows it. None recorded (a mark an older build wrote): the
   * work's, as every turn was.
   */
  private readonly starters = new Map<string, TurnStarter>()
  /** Turns the tool started by itself, no message behind them (`turnStarted`, #1576); memory only, a swap forgets it */
  private readonly cliTurns = new Set<string>()
  private readonly lastBy = new Map<string, 'person' | 'work'>()
  /** The messages given each session's tool that no turn has taken yet (#1639), oldest first; read back from the rows once per host (`held`) */
  private readonly entries = new Map<string, Entry[]>()
  /** The last row of each session's messages that are done with (`turn_inputs`'s `spent`) */
  private readonly spentAt = new Map<string, number>()
  /** Running turns the person took over (`takeTurn`): the tool's naming of the inputs does not give them back */
  private readonly takenOver = new Set<string>()
  /** Running turns whose opening input the tool named (`turnNamed`); one not named is decided again by the inputs its end names */
  private readonly named = new Set<string>()
  /** The settle timer of a paused report whose background work has ended (#721) */
  private readonly pausedSettles = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Delegated turns (#676): session -> the session that gave it the turn it is running, and the cards that session was
   * already told of. While the turn runs, its question cards go to that session as well as to the person, and its
   * approval cards are told to it (`routeCard`). Set when another session's work starts the turn (`ask_project` into a
   * session at rest, `start_agent`, `agent_session` send, `send_to_session` to a session at rest); never for work that
   * joins a turn the person started. Ends with the delegation's outcome, or with the turn (`untilTurnEnd`: a
   * `send_to_session` turn, or one a new host found in the store). Mirrored in the store's `delegated_turns` (v51) so
   * a host swap keeps the link while the kept session waits on a question.
   */
  private readonly turns = new Map<string, TurnOwner>()
  readonly turnOwners: ReadonlyMap<string, TurnOwner> = this.turns
  /**
   * Requests held for a busy session (#677, `ifBusy: "queue"`): session -> its queue, oldest first. Each goes in as a new
   * turn of its requester's when the session's running turn ends (`drainQueue`). Mirrored in the store's
   * `queued_requests` (v52), so a host swap keeps them.
   */
  private readonly queues = new Map<string, QueuedRequest[]>()
  readonly queued: ReadonlyMap<string, readonly QueuedRequest[]> = this.queues
  /**
   * The queued request being delivered now, per session (#684 review): it stays first in its queue, and its row stays
   * in the store marked `delivering_at`, until the session's turn actually starts (`onEvent`); only then is it taken
   * off. While it is here the session counts as busy and no other drain runs for it, so waking a sleeping session
   * cannot let a second request in, and a swap or crash mid-delivery leaves the row for the next host.
   */
  private readonly deliveries = new Map<string, string>()
  readonly delivering: ReadonlyMap<string, string> = this.deliveries
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
   * A linked machine's sessions whose turn the orchestrator asked to hear about (`reportBack`, #82 phase 4), by
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
  private delegatedHook: ((callerId: string, childId: string, origin: ThreadOrigin, task: string) => void) | undefined
  onDelegated(hook: ChildOwnership['delegatedHook']): void {
    this.delegatedHook = hook
  }

  /** The mailbox's count of the threads a session handed on in the work it does for `ownerId` that are still going (§6), set by the host when it has one */
  private waitingHook: ((ownerId: string, childId: string) => number) | undefined
  onWaitingOn(hook: ChildOwnership['waitingHook']): void {
    this.waitingHook = hook
  }

  /** How many threads `childId` handed on in the work it does for `ownerId` are still going; 0 with no mailbox. Never throws */
  waitingOn(ownerId: string, childId: string): number {
    if (!this.waitingHook) return 0
    try {
      return this.waitingHook(ownerId, childId)
    } catch (e) {
      console.error(`[mail] could not count the work ${childId.slice(0, 8)} handed on (${errorMessage(e)})`)
      return 0
    }
  }

  /**
   * The mailbox's way of keeping work the person owns (§8.1): a session a script or the RPC started with a first message. `started` writes it down
   * before the message goes in, `owes` says whether the person has work with the session whose turns are reported, `report` posts a turn's end in
   * the person's thread. Set by the host when it has a mailbox
   */
  private personWork:
    | { started(sessionId: string, text: string, fromScript?: { credential: string }): void; owes(sessionId: string): boolean; report(sessionId: string, draft: PersonReportDraft): boolean }
    | undefined
  onPersonWork(hooks: ChildOwnership['personWork']): void {
    this.personWork = hooks
  }

  /**
   * Whether the old report paths still owe `ownerId` a report of `childId` (docs/plans/mailbox.md §9.5, D18): they are the truth of an owed report
   * until M8, and the mail task rows follow them. A delegation not settled, a report mark, a queued request, a report paused over the child's own
   * work, a linked machine's report; for the person, their task with the child
   */
  oldOwes(ownerId: string, childId: string): boolean {
    if (ownerId === 'person') return this.personOwes(childId)
    if ([...this.runs.values()].some((d) => d.callerId === ownerId && d.sessionId === childId && !d.settled)) return true
    if (this.reports.get(childId) === ownerId) return true
    if ((this.queues.get(childId) ?? []).some((q) => q.callerSessionId === ownerId)) return true
    return this.linked.get(childId)?.orchestratorId === ownerId
  }

  /**
   * At startup, before the mailbox's hook is attached: how many tasks the child handed on in the work it does for the owner are still owed (§9.4),
   * from the store. Owed here is what a report mark the store holds still owes
   */
  private handedOnOwed(childId: string, ownerId: string, marks: readonly { sessionId: string; callerSessionId: string }[]): number {
    const idOf = (address: string) => address.slice(address.lastIndexOf('/') + 1)
    return this.store.mailbox.handedOnBySessions(ownerId, childId).filter((r) => marks.some((m) => m.sessionId === idOf(r.recipient) && m.callerSessionId === idOf(r.sender))).length
  }

  /** A script or the RPC starts `sessionId` with `text`: the person owns the work. Never throws */
  startedForPerson(sessionId: string, text: string, fromScript?: { credential: string }): void {
    try {
      this.personWork?.started(sessionId, text, fromScript)
    } catch (e) {
      console.error(`[mail] could not write down the work started in ${sessionId.slice(0, 8)} for the person (${errorMessage(e)})`)
    }
  }

  /** Whether the person has work with `sessionId` whose turn is reported to them; false with no mailbox. Never throws */
  personOwes(sessionId: string): boolean {
    try {
      return this.personWork?.owes(sessionId) ?? false
    } catch (e) {
      console.error(`[mail] could not read the work of the person in ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
      return false
    }
  }

  /** The end of a turn of work the person owns, in their thread; false when it was not taken. Never throws */
  reportedToPerson(sessionId: string, draft: PersonReportDraft): boolean {
    try {
      return this.personWork?.report(sessionId, draft) ?? false
    } catch (e) {
      console.error(`[mail] could not report the work of ${sessionId.slice(0, 8)} to the person (${errorMessage(e)})`)
      return false
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
   * `callerId` gave `childId` this task by `origin` and the host has delivered it: the mailbox writes it down, in step with the old path
   * (a thread the caller owns and the child is assigned, `running`). Never throws: the mailbox must not break a delegation
   */
  delegated(callerId: string, childId: string, origin: ThreadOrigin, task: string): void {
    if (callerId === childId || !this.delegatedHook) return
    try {
      this.delegatedHook(callerId, childId, origin, task)
    } catch (e) {
      console.error(`[mail] could not write down the work ${callerId.slice(0, 8)} gave ${childId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  /**
   * The owner of a turn the mailbox started in a session that already owes another owner a report (#1474): that turn is the work of the thread it
   * carries, so its end is reported to this owner, and the other mark and its pause are left as they are. Taken (once) as the turn ends
   */
  private readonly mailTurns = new Map<string, { ownerId: string }>()
  markMailTurn(sessionId: string, ownerId: string): void {
    this.mailTurns.set(sessionId, { ownerId })
  }
  /** The input was not taken: no turn started for `ownerId` */
  clearMailTurn(sessionId: string, ownerId: string): void {
    if (this.mailTurns.get(sessionId)?.ownerId === ownerId) this.mailTurns.delete(sessionId)
  }
  takeMailTurn(sessionId: string): { ownerId: string } | undefined {
    const turn = this.mailTurns.get(sessionId)
    this.mailTurns.delete(sessionId)
    return turn
  }

  /** A new mark is new work: a pause of the work before it is not this work's, nor one an older build left stored */
  markReport(sessionId: string, callerId: string): void {
    this.unpauseReport(sessionId)
    this.store.settings.deleteAppSetting(pausedReportKey(sessionId))
    this.reports.set(sessionId, callerId)
    this.store.children.setReportMark(sessionId, callerId)
    this.persistTurn(sessionId)
  }
  clearReport(sessionId: string): void {
    this.unpauseReport(sessionId)
    this.store.settings.deleteAppSetting(reportTurnKey(sessionId))
    this.lastBy.delete(sessionId)
    if (!this.reports.delete(sessionId)) return
    this.store.children.clearReportMark(sessionId)
  }
  /**
   * At startup (#646): the report marks of the sessions the keeper kept that still owe them, and nothing else. Returns
   * the marks of kept sessions that ended their turn during the swap, whose callers are told so (#1186)
   */
  restoreReports(sessions: ReadonlyMap<string, SessionInfo>, keptSessions: ReadonlySet<string> | undefined): { sessionId: string; callerSessionId: string }[] {
    const endedInSwap: { sessionId: string; callerSessionId: string }[] = []
    /*
     * "You will be told when it ends" survives a host swap (#646): the keeper kept the child's process and its turn is
     * still running, so it ends under this host, and the report it owes goes out from here. Any other mark is dropped
     * rather than left to name an unrelated later turn as "the assigned work finished" (#166): a session with no
     * process lost its turn with the old host, and a kept session already at rest finished its turn while the old host
     * was letting go (`handingOver` held that report back); its answer stays readable through agent_session.
     * A kept session at rest whose report was paused over its own background work (#721) still owes it: that work runs
     * on in the kept process, and the turn its ending starts ends under this host.
     */
    const marks = this.store.children.listReportMarks()
    for (const mark of marks) {
      const child = sessions.get(mark.sessionId)
      const kept = keptSessions?.has(mark.sessionId) && !!child && sessions.has(mark.callerSessionId)
      const paused = readPausedTasks(this.store.settings.appSetting(pausedReportKey(mark.sessionId)))
      if (kept && (inTurn(child.state) || paused)) {
        this.adoptReport(mark.sessionId, mark.callerSessionId, paused)
        continue
      }
      /*
       * A session at rest that waits for threads it handed on (§6) still owes the report: the work is the helpers', which are in the store, and
       * the turn their end starts ends under this host. It needs no process of its own (asleep, or the host was quit): the helper's report
       * wakes it. The mailbox's hook is not attached yet, so the store is asked
       */
      const waiting = child && sessions.has(mark.callerSessionId) && !inTurn(child.state) ? this.handedOnOwed(mark.sessionId, mark.callerSessionId, marks) : 0
      if (waiting > 0) {
        // What a process that is gone held (its background work) went with it
        if (!kept) this.store.settings.deleteAppSetting(pausedReportKey(mark.sessionId))
        this.adoptReport(mark.sessionId, mark.callerSessionId, kept ? paused : null)
        continue
      }
      if (child && keptSessions?.has(mark.sessionId)) {
        console.error(`[agent-host] report mark dropped: ${mark.sessionId.slice(0, 8)} ended its turn during the swap; its caller is told`)
        if (sessions.has(mark.callerSessionId)) endedInSwap.push(mark)
      }
      this.store.children.clearReportMark(mark.sessionId)
      this.store.settings.deleteAppSetting(pausedReportKey(mark.sessionId))
      this.store.settings.deleteAppSetting(reportTurnKey(mark.sessionId))
    }
    return endedInSwap
  }

  /** At startup (#676): the delegated turns of kept sessions still in them; any other row is dropped */
  restoreTurns(sessions: ReadonlyMap<string, SessionInfo>, keptSessions: ReadonlySet<string> | undefined): void {
    /*
     * A delegated turn's link survives the swap the same way (#676): a kept session still in the turn may be waiting on
     * a question its caller is to answer, and the kept CLI sends that card again to this host. With no delegation in
     * this host's memory, the link ends with the turn. Any other row is dropped: that turn is over.
     */
    for (const row of this.store.children.listDelegatedTurns()) {
      const s = sessions.get(row.sessionId)
      if (keptSessions?.has(row.sessionId) && !!s && inTurn(s.state) && sessions.has(row.callerSessionId)) {
        this.adoptTurn(row.sessionId, { callerId: row.callerSessionId, untilTurnEnd: true, told: new Set(row.told), turnId: row.turnId })
        continue
      }
      this.store.children.clearDelegatedTurn(row.sessionId)
    }
  }

  /** At startup (#677): every queued request whose session and requester still exist; `legacyOpenedByAuto` reads a row an older build wrote */
  restoreQueued(sessions: ReadonlyMap<string, SessionInfo>, legacyOpenedByAuto: (r: QueuedRequest) => boolean): void {
    /*
     * Queued requests (#677) outlive the host: the next one delivers them when the session's turn ends, or soon after
     * start for a session already at rest. A kept session waits for its adoption (`adoptKept`), so its first input
     * does not start a second process. A request whose session or requester is gone is dropped.
     */
    for (const r of this.store.children.listQueuedRequests()) {
      if (!sessions.has(r.sessionId) || !sessions.has(r.callerSessionId)) {
        this.store.children.removeQueuedRequest(r.id)
        continue
      }
      /*
       * Queued by a newer build through a tool this one does not know (#384): no gate here stands for it, so it is not
       * delivered, and not dropped either. The row stays for a build that knows the tool; the requests behind it go.
       */
      if (!QUEUED_VIA.has(r.via)) {
        console.error(`[agent-host] queued request ${r.id} to ${r.sessionId.slice(0, 8)} came through ${JSON.stringify(r.via)}, which this build cannot deliver; it is left for one that can`)
        continue
      }
      // A delivery the old host began and never saw start is delivered again (#684 review)
      if (r.deliveringAt) {
        console.error(`[agent-host] queued request ${r.id} to ${r.sessionId.slice(0, 8)} was being delivered at the swap; delivering it again`)
        this.store.children.markQueuedDelivering(r.id, null)
      }
      // A row an older build wrote does not say whether only `auto` let it through: an ask with no consent for the pair is read as such
      const openedByAuto = r.openedByAuto ?? legacyOpenedByAuto(r)
      this.adoptQueued({ ...r, deliveringAt: null, openedByAuto })
    }
  }

  /** A mark the previous host left, kept for a session the keeper kept (the store already holds it) */
  adoptReport(sessionId: string, callerId: string, paused: PausedTask[] | null): void {
    this.reports.set(sessionId, callerId)
    if (paused) this.paused.set(sessionId, paused)
    // The turn it was in when the last host stopped (#1377): the person's is not reported when it ends here
    const stored = readTurn(this.store.settings.appSetting(reportTurnKey(sessionId)))
    if (stored) this.starters.set(sessionId, stored)
  }
  /** Holds the session's owed report over its own background work (#721); the mark itself stays as it is */
  pauseReport(sessionId: string, running: readonly PausedTask[]): void {
    const held = this.paused.get(sessionId) ?? []
    const added = running.filter((t) => !held.some((h) => h.id === t.id)).map((t) => ({ id: t.id, description: t.description }))
    if (!this.paused.has(sessionId) || added.length) {
      const next = [...held, ...added]
      this.paused.set(sessionId, next)
      this.store.settings.setAppSetting(pausedReportKey(sessionId), JSON.stringify(next))
    }
  }
  unpauseReport(sessionId: string): void {
    this.stopSettling(sessionId)
    if (this.paused.delete(sessionId)) this.store.settings.deleteAppSetting(pausedReportKey(sessionId))
  }
  /**
   * A message goes into the session (#1377): the person's, or anyone else's (a caller's, an app's, Centralu's). At rest
   * (or where the tool holds it for a turn of its own) it is what the next turn starts from; into a running turn it joins
   * that turn: a person's into the work's is noted ("the person wrote during this turn"), into their own it is theirs.
   */
  noteMessage(sessionId: string, by: 'person' | 'work', inTurnNow: boolean, joinsRunningTurn: boolean, added = false, inputId?: string, source: TurnSource = 'caller', seq?: number): void {
    /*
     * Into a running turn: the tool may take it in at its next round, or run it as a turn of its own once this one ends (Claude folds a
     * queued input in only at a tool round, so a message sent while the final answer is written is a turn of its own). Which, is said at
     * the turn's end (`turnEnded`) by the inputs the turn took, or when the turn it runs as opens (`turnNamed`)
     */
    const joined = inTurnNow && joinsRunningTurn
    if (joined && !this.starters.has(sessionId)) this.starters.set(sessionId, { by: 'work' })
    const held = this.held(sessionId)
    if (inputId !== undefined && held.some((e) => e.id === inputId)) return
    held.push({ ...(inputId !== undefined ? { id: inputId } : {}), ...(seq !== undefined ? { seq } : {}), by, ...(added ? { added: true as const } : {}), source, joined, ...(inTurnNow && !joined ? { after: true as const } : {}) })
    this.save(sessionId)
    if (joined) this.persistTurn(sessionId)
  }
  /**
   * The session's held messages (#1639), read back the first time this host asks: every user row after `spent` with an input id, and the
   * running turn's state as the host before left it
   */
  private held(sessionId: string): Entry[] {
    let held = this.entries.get(sessionId)
    if (!held) {
      const kept = readInputs(this.store.settings.appSetting(turnInputsKey(sessionId)))
      held = kept.spent === null ? [] : this.store.messages.loadUserRowsFrom(sessionId, kept.spent).flatMap((row) => {
        const e = entryOf(row)
        return e ? [{ ...e, joined: kept.joined.has(e.id), ...(kept.after.has(e.id) ? { after: true as const } : {}), ...(kept.carried.has(e.id) ? { carried: true as const } : {}) }] : []
      })
      if (kept.spent !== null) this.spentAt.set(sessionId, kept.spent)
      if (kept.named) this.named.add(sessionId)
      if (kept.takenOver) this.takenOver.add(sessionId)
      this.entries.set(sessionId, held)
    }
    return held
  }
  /** The first `count` held messages are done with (#1639): the record moves past the last of their rows (`save` writes it). Returns them */
  private spend(sessionId: string, count: number): Entry[] {
    const gone = this.held(sessionId).splice(0, count)
    const last = Math.max(-1, ...gone.map((e) => e.seq ?? -1))
    if (last > (this.spentAt.get(sessionId) ?? -1)) this.spentAt.set(sessionId, last)
    return gone
  }
  /**
   * Writes `turn_inputs` (#1639). Before anything is spent, `spent` is the row before the first held one, so a host that takes over reads
   * them back. And `input_origins` for a build before #1639, from the hub's messages held, once the session has it
   */
  private save(sessionId: string): void {
    const held = this.held(sessionId)
    const spent = this.spentAt.get(sessionId) ?? Math.min(...held.map((e) => e.seq ?? Infinity)) - 1
    const ids = (which: (e: Entry) => boolean) => held.filter(which).flatMap((e) => e.id ?? [])
    const [joined, after, carried] = [ids((e) => e.joined), ids((e) => !!e.after), ids((e) => !!e.carried)]
    this.store.settings.setAppSetting(turnInputsKey(sessionId), JSON.stringify({
      ...(Number.isFinite(spent) ? { spent } : {}), ...(this.named.has(sessionId) ? { named: true } : {}), ...(this.takenOver.has(sessionId) ? { takenOver: true } : {}),
      ...(joined.length ? { joined } : {}), ...(after.length ? { after } : {}), ...(carried.length ? { carried } : {}),
    }))
    const hub = held.flatMap((e) => (e.origin && e.id !== undefined ? [[e.id, e.origin] as const] : []))
    if (hub.length || this.store.settings.appSetting(inputOriginsKey(sessionId)) !== null) this.store.settings.setAppSetting(inputOriginsKey(sessionId), JSON.stringify(hub.slice(-MAX_INPUT_ORIGINS)))
  }
  /** A hub's message was given to the tool as input `inputId`, stored as row `seq` (#1604): the turn the tool names it for says whose it is */
  noteInputOrigin(sessionId: string, inputId: string, origin: TurnOrigin): void {
    const entry = this.held(sessionId).find((e) => e.id === inputId)
    if (!entry) return
    entry.origin = origin
    this.save(sessionId)
  }
  /**
   * The tool holds no input for the session any more (#1604): its process ended or was replaced, or it was stopped. No turn begins for the messages given before, and none is named for them. Only the origins are dropped: the
   * words of the turn that ran stay readable
   */
  dropInputOrigins(sessionId: string): void {
    this.store.settings.deleteAppSetting(inputOriginsKey(sessionId))
    // And what decides whose a turn is (#1639): nothing given before starts a turn now
    this.spend(sessionId, this.held(sessionId).length)
    this.save(sessionId)
  }
  /**
   * The process that ran the session's turns is gone (#1604): it crashed, lost its conversation, or this host started with no
   * process for a session the last one left mid-turn. A turn it was in will never send its end, so it ends here: its words
   * are those said so far (or none), never the turn before's, and nothing it was given is run by anyone
   */
  processGone(sessionId: string): void {
    this.dropInputOrigins(sessionId)
    this.noteTurnEnd(sessionId)
  }
  /** The session is deleted: nothing kept for a hub that followed its turns is kept (`purgeSession` removes the same keys by their shape) */
  forgetTurns(sessionId: string): void {
    this.dropInputOrigins(sessionId)
    this.store.settings.deleteAppSetting(turnSpanKey(sessionId))
    this.store.settings.deleteAppSetting(turnInputsKey(sessionId))
    this.entries.delete(sessionId)
    this.spentAt.delete(sessionId)
    this.named.delete(sessionId)
    this.takenOver.delete(sessionId)
  }
  /** Whether a hub gives this session messages: nothing is kept of the turns of any other (#1604) */
  private followedByHub(sessionId: string): boolean {
    return this.store.settings.appSetting(turnSpanKey(sessionId)) !== null || this.store.settings.appSetting(inputOriginsKey(sessionId)) !== null
  }
  /** A turn began after row `seq` of the session's record: the turn's own text is every row after it (#1604) */
  noteTurnStart(sessionId: string, seq: number): void {
    if (!this.followedByHub(sessionId)) return
    this.store.settings.updateAppSetting(turnSpanKey(sessionId), (raw) => {
      const was = readTurnSpan(raw)
      const starts = [...startsOf(was), seq].slice(-TURN_STARTS_KEPT)
      return JSON.stringify({ latest: { since: seq }, ...(was.latest ? { previous: { since: was.latest.since } } : {}), starts })
    })
  }
  /** The turn ended: its words are settled, and the turn after it begins where they stop (`turnRows`) */
  private noteTurnEnd(sessionId: string): void {
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
  /** The mailbox's way of hearing that a turn started (§6), set by the host when it has one */
  private turnStartedHook: ((sessionId: string, turn: TurnStart) => void) | undefined
  onTurnStarted(hook: ChildOwnership['turnStartedHook']): void {
    this.turnStartedHook = hook
  }

  /**
   * The caller whose work a turn of this session is: the one whose turn it was given as (and who still has a delegation on it, or is owed its
   * report), else the one a report is owed to. A turn given with no report asked for (`reportBack: false`) is nobody's work to report
   */
  private workOwner(sessionId: string): string | undefined {
    const marked = this.reports.get(sessionId)
    const caller = this.turns.get(sessionId)?.callerId
    if (caller && (marked === caller || [...this.delegations.values()].some((d) => d.callerId === caller && d.sessionId === sessionId && !d.settled))) return caller
    return marked
  }

  /**
   * A turn starts (#1377, #1639): it is decided now, by the oldest message given before it, else it is the CLI's own (the work's background
   * tasks ended). Nothing is taken off yet: when the tool names the input the turn opened from, it is decided again (`turnNamed`)
   */
  turnStarted(sessionId: string): void {
    const held = this.held(sessionId)
    this.takenOver.delete(sessionId)
    this.named.delete(sessionId)
    // Every message held now may be what the turn opened from: none is in it yet
    for (const e of held) {
      e.joined = false
      delete e.after
    }
    const first = held.find((e) => !e.carried)
    this.decide(sessionId, first ? starterFor([first]) : undefined, false)
    this.save(sessionId)
  }
  /**
   * The tool names the inputs the turn opening now runs for (#1639, `SessionHandle.turnStartInputs`): ids, of which the last one held
   * decides it, and it ran for every message given up to that one (the tool runs inputs in order); ids none of which a message was given
   * under (a mail wake, a compact, a quiet note), or none at all (`[]`): the CLI's own. `null`: not an opening, nothing changes. A turn
   * the person took over stays theirs. The messages held after it are queued behind it, so it may take them in at a tool round (`personInTurn`).
   * Returns the hub's message it ran for, the last one named (#1604), said with the event that opens it
   */
  turnNamed(sessionId: string, inputs: readonly string[] | null | undefined): TurnOrigin | undefined {
    const held = this.held(sessionId)
    // Once per turn: the event that opens it names it
    if (inputs === null || inputs === undefined || this.named.has(sessionId)) return undefined
    const last = Math.max(-1, ...inputs.map((id) => held.findIndex((e) => e.id === id)))
    const isNamed = (e: Entry) => e.id !== undefined && inputs.includes(e.id)
    // A message carried from the turn before that this one did not open for went into that turn
    const ran = this.spend(sessionId, last + 1).filter((e) => !e.carried || isNamed(e))
    this.spendCarried(sessionId)
    const origin = ran.filter(isNamed).at(-1)?.origin
    // A turn this host did not see begin: what it ran for is done with, and nothing is decided
    if (this.starters.has(sessionId)) {
      this.named.add(sessionId)
      if (!this.takenOver.has(sessionId)) this.decide(sessionId, ran.length ? starterFor(ran) : undefined, true)
    }
    this.save(sessionId)
    return origin
  }
  /** The messages carried from the turn before (the oldest held) are done with */
  private spendCarried(sessionId: string): void {
    const held = this.held(sessionId)
    const kept = held.findIndex((e) => !e.carried)
    this.spend(sessionId, kept < 0 ? held.length : kept)
  }
  /** Records whose the running turn is (none: the CLI's own) and tells the mailbox; `again`: it was decided before, and is only told when it differs */
  private decide(sessionId: string, decided: { starter: TurnStarter; source: TurnSource } | undefined, again: boolean): void {
    const starter: TurnStarter = decided?.starter ?? { by: 'work' }
    const was = this.starters.get(sessionId)
    const same = was !== undefined && was.by === starter.by && !!was.wrote === !!starter.wrote && !!was.added === !!starter.added && this.cliTurns.has(sessionId) === !decided
    if (again && same) return
    this.starters.set(sessionId, starter)
    if (decided) this.cliTurns.delete(sessionId)
    else this.cliTurns.add(sessionId)
    this.persistTurn(sessionId)
    if (!this.turnStartedHook) return
    const ownerId = this.workOwner(sessionId)
    try {
      this.turnStartedHook(sessionId, { by: starter.by, added: !!starter.added, cli: !decided, source: decided?.source ?? 'caller', ...(ownerId ? { ownerId } : {}), ...(again ? { again: true as const } : {}) })
    } catch (e) {
      console.error(`[mail] could not record a turn of ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }
  /**
   * The turn ends (#1377): whose it was; none recorded reads as the work's. The record goes with it. `taken`: the inputs
   * the tool says the turn took in (`SessionHandle.turnInputs`); undefined when it takes in every message sent to a
   * running turn, null when it cannot tell. A message that was taken in joined this turn (a person's into the work's is
   * noted on it); one that was not is what the next turn starts from, and that turn is its sender's.
   */
  turnEnded(sessionId: string, taken?: readonly string[] | null, cut = false): TurnStarter {
    const held = this.held(sessionId)
    // A turn whose opening was not named (a card was up, or the tool answered it without a stream): the inputs it took that were held when it began say whose it was (#1639)
    if (!this.named.has(sessionId) && taken?.length) {
      const before = taken.filter((id) => held.some((e) => e.id === id && !e.joined))
      if (before.length) this.turnNamed(sessionId, before)
    }
    this.named.delete(sessionId)
    const starter: TurnStarter = { ...(this.starters.get(sessionId) ?? { by: 'work' as const }) }
    this.starters.delete(sessionId)
    this.cliTurns.delete(sessionId)
    this.takenOver.delete(sessionId)
    // The process went with the turn (`cut`): it holds none of the messages given it (#1604). Any other error or limit leaves the process, which can still run one it holds queued as the next turn
    if (cut) this.dropInputOrigins(sessionId)
    this.noteTurnEnd(sessionId)
    /*
     * The messages given (#1639): those up to the last the tool says the turn took joined it (the ones it opened from were spent when named),
     * a person's into the work's noted on it, whether given while it ran or held from before it; a tool that takes every message into the
     * running turn (Codex) took them all but those it holds for a turn after. The rest wait, queued, for the next turn. A tool that cannot
     * tell (a CLI before 2.1.289) or a turn that went with its process: all are done with, joined to no turn, so none claims a turn the CLI
     * runs on its own after
     */
    this.spendCarried(sessionId)
    const waiting = held.findIndex((e) => e.after || (taken === undefined && e.joined))
    const upto = cut || taken === null ? 0 : taken === undefined ? (waiting < 0 ? held.length : waiting) : Math.max(-1, ...taken.map((id) => held.findIndex((e) => e.id === id))) + 1
    const joinedIt = this.spend(sessionId, upto)
    // A tool that names nothing (Codex) took in what was given while the turn ran, unless it runs it as the next turn: carried to that turn's opening
    if (taken === undefined && !cut) for (const e of held) if (e.joined) joinedIt.push(Object.assign(e, { carried: true as const }))
    for (const p of joinedIt) {
      if (p.by !== 'person' || starter.by !== 'work') continue
      if (p.added) starter.added = true
      else starter.wrote = true
    }
    if (cut || taken === null) this.spend(sessionId, held.length)
    this.save(sessionId)
    this.lastBy.set(sessionId, starter.by)
    this.store.settings.deleteAppSetting(reportTurnKey(sessionId))
    return starter
  }
  /**
   * Whether the turn running is the paused work's continuing (#1576): the caller's report is held over the session's own
   * background work, and the turn the tool started when that work ended is the work's (`turnStarted`, no message began
   * it) with no person's message in it. That turn's end is the report the caller is owed, so it is the caller's too.
   * The one place that says so, as `reportBackIfAwaited` reads the same turn for its report
   */
  continuesPause(sessionId: string, callerId: string): boolean {
    if (this.reports.get(sessionId) !== callerId || !this.paused.has(sessionId)) return false
    // A turn the mailbox started for another owner's thread, or one given to another caller, is theirs
    const owner = this.turns.get(sessionId)?.callerId
    if ((owner && owner !== callerId) || (this.mailTurns.get(sessionId) && this.mailTurns.get(sessionId)?.ownerId !== callerId)) return false
    const starter = this.starters.get(sessionId)
    // Only the tool's own continuation: a message with a `from`, an app's or a script's also starts a 'work' turn, and is not it
    return this.cliTurns.has(sessionId) && starter?.by === 'work' && !this.personInTurn(sessionId)
  }
  /** Whether a person started the running turn or wrote into it, or their message is queued behind its named opening (#1576): a refusal says "the person may be using it" for no other */
  personInTurn(sessionId: string): boolean {
    const starter = this.starters.get(sessionId)
    const queued = (p: Entry) => p.joined || (this.named.has(sessionId) && !p.after && !p.carried)
    return starter?.by !== 'work' || !!starter.wrote || !!starter.added || this.held(sessionId).some((p) => p.by === 'person' && queued(p))
  }
  /** Whose the session's last turn was (#1377): its last response is the person's answer when it was theirs */
  lastTurnBy(sessionId: string): 'person' | 'work' | undefined {
    return this.lastBy.get(sessionId)
  }
  /** Whose the running turn is, when one is recorded */
  starterOf(sessionId: string): TurnStarter | undefined {
    return this.starters.get(sessionId)
  }
  /** The person took the session over (#1377): the running turn is theirs from here */
  takeTurn(sessionId: string): void {
    this.held(sessionId)
    if (this.starters.has(sessionId)) {
      this.takenOver.add(sessionId)
      this.starters.set(sessionId, { by: 'person' })
      this.persistTurn(sessionId)
      this.save(sessionId)
    }
  }
  /** Kept while a report is owed, for a host that takes the session over mid-turn */
  private persistTurn(sessionId: string): void {
    const s = this.starters.get(sessionId)
    if (s && this.reports.has(sessionId)) this.store.settings.setAppSetting(reportTurnKey(sessionId), JSON.stringify(s))
  }
  /** Starts a paused report's settle timer (#721); the session manager decides when, and what it does */
  settleAfter(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    this.pausedSettles.set(sessionId, timer)
  }
  /** Ends a paused report's settle timer, or forgets one that fired; with no session, every one */
  stopSettling(sessionId?: string): void {
    if (sessionId === undefined) {
      for (const timer of this.pausedSettles.values()) clearTimeout(timer)
      this.pausedSettles.clear()
      return
    }
    const timer = this.pausedSettles.get(sessionId)
    if (timer) clearTimeout(timer)
    this.pausedSettles.delete(sessionId)
  }

  ownTurn(sessionId: string, callerId: string, untilTurnEnd: boolean): void {
    const turnId = randomUUID()
    this.turns.set(sessionId, { callerId, untilTurnEnd, told: new Set(), turnId })
    this.store.children.setDelegatedTurn(sessionId, callerId, turnId)
  }
  /** Ends the link; with `callerId`, only that caller's (a later delegation by someone else is not cut) */
  releaseTurn(sessionId: string, callerId?: string): void {
    const owner = this.turns.get(sessionId)
    if (!owner || (callerId && owner.callerId !== callerId)) return
    this.turns.delete(sessionId)
    this.store.children.clearDelegatedTurn(sessionId)
  }
  /** A link the previous host left, kept for a session the keeper kept still in its turn (the store already holds it) */
  adoptTurn(sessionId: string, owner: TurnOwner): void {
    this.turns.set(sessionId, owner)
  }
  /** The turn's owner was told of a card (#676), once per card handle */
  markTurnTold(sessionId: string, handle: string): void {
    const owner = this.turns.get(sessionId)
    if (!owner) return
    owner.told.add(handle)
    this.store.children.setDelegatedTurnTold(sessionId, [...owner.told])
  }

  /** Holds a request for a busy session, last in its queue; returns its place */
  enqueue(r: QueuedRequest): number {
    const list = [...(this.queues.get(r.sessionId) ?? []), r]
    this.queues.set(r.sessionId, list)
    this.store.children.addQueuedRequest(r)
    return list.length
  }
  /** Marks a queued ask as resting on its requester's `auto` alone, here and in the store (#838) */
  markOpenedByAuto(r: QueuedRequest): void {
    if (r.openedByAuto === true) return
    r.openedByAuto = true
    this.store.children.markQueuedOpenedByAuto(r.id)
  }
  /** A request the previous host left, read back at startup (the store already holds it) */
  adoptQueued(r: QueuedRequest): void {
    this.queues.set(r.sessionId, [...(this.queues.get(r.sessionId) ?? []), r])
  }
  dropQueued(which: (r: QueuedRequest) => boolean): QueuedRequest[] {
    const dropped: QueuedRequest[] = []
    for (const [id, list] of [...this.queues]) {
      const now = this.deliveries.get(id)
      if (now && list.some((r) => r.id === now && which(r))) this.deliveries.delete(id)
      const keep = list.filter((r) => !which(r))
      for (const r of list) if (which(r)) { dropped.push(r); this.store.children.removeQueuedRequest(r.id) }
      if (keep.length) this.queues.set(id, keep)
      else this.queues.delete(id)
    }
    return dropped
  }
  /** A queued request goes in now (#684 review): the session is busy with it until its turn starts */
  startDelivering(sessionId: string, requestId: string): void {
    this.deliveries.set(sessionId, requestId)
    this.store.children.markQueuedDelivering(requestId, Date.now())
  }
  /** The session's turn started while a queued request was being delivered to it: that request is delivered (#684 review) */
  queuedTurnStarted(sessionId: string): void {
    const id = this.deliveries.get(sessionId)
    if (!id) return
    this.deliveries.delete(sessionId)
    this.dropQueued((x) => x.id === id)
  }

  setDelegation(key: string, d: Delegation): void {
    this.runs.set(key, d)
  }
  /** Drops the delegation under `key`; with `only`, only while that one is still there */
  dropDelegation(key: string, only?: Delegation): void {
    if (only && this.runs.get(key) !== only) return
    this.runs.delete(key)
  }
  setObserverNote(key: string, note: { run: Delegation; waiters: number; told: boolean }): void {
    this.notes.set(key, note)
  }
  /** Drops the note under `key`; with `only`, only while that one is still there */
  dropObserverNote(key: string, only?: { run: Delegation; waiters: number; told: boolean }): void {
    if (only && this.notes.get(key) !== only) return
    this.notes.delete(key)
  }
  /** The notes a session took as an observer, and the ones taken on it */
  dropObserverNotesOf(sessionId: string): void {
    for (const key of [...this.notes.keys()]) if (key.startsWith(`${sessionId}>`) || key.endsWith(`>${sessionId}`)) this.notes.delete(key)
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
   * Moves what `from` owns of the given children to `to`, in memory (#693, #738): their report marks, the marks a wait
   * had taken down (`armReports`), the turns `from` gave them, its delegations and observer notes on them (their keys
   * name the caller), the requests it queued (`queued`), linked machines' reports, and the start requests that made
   * them. `moveCards` runs next, for the cards that stand for the moving `starts`; then what moved is recorded as
   * handed over, and the original's calls still waiting on it are ended.
   *
   * The caller has already moved what is stored (`Store.moveChildren`) and the sessions' own `askedBy` and
   * `parentSessionId`. Nothing here awaits, so no event lands in the middle.
   */
  moveOwner(from: string, to: string, move: OwnerMove, moveCards: () => void): void {
    const { sessions, armReports, starts } = move
    const moving = new Set(sessions)
    for (const id of sessions) if (this.reports.get(id) === from) this.reports.set(id, to)
    for (const id of armReports) this.reports.set(id, to)
    for (const [id, owner] of this.turns) if (moving.has(id) && owner.callerId === from) owner.callerId = to
    // A delegation's key names its caller (`<caller>><child>`, `<caller>><project>><child>`)
    for (const [key, d] of [...this.runs]) {
      if (d.callerId !== from || !moving.has(d.sessionId)) continue
      this.runs.delete(key)
      d.callerId = to
      this.runs.set(to + key.slice(from.length), d)
    }
    for (const [key, n] of [...this.notes]) {
      if (!key.startsWith(`${from}>`) || !moving.has(key.slice(from.length + 1))) continue
      this.notes.delete(key)
      this.notes.set(`${to}>${key.slice(from.length + 1)}`, n)
    }
    if (move.queued) for (const list of this.queues.values()) for (const r of list) if (r.callerSessionId === from) r.callerSessionId = to
    for (const [id, wait] of this.linked) {
      if (wait.orchestratorId !== from || !moving.has(id)) continue
      wait.orchestratorId = to
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

