import { randomUUID } from 'node:crypto'
import { errorMessage, TurnOrigin } from '@cc/protocol'
import type { BackgroundTask, SessionInfo, StoredMessage } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import type { AgentRunWait } from './app-agents.js'
import { inTurn } from '../idle.js'
import { readJsonObjects } from '../dev-services/store/json.js'
import { asObj, tryParseJson } from '../json-value.js'
import { isHubSender } from './hub-sender.js'
import type { ThreadOrigin } from '../dev-services/store/mail-types.js'
import type { AnswerGiven, PersonReportDraft } from '../mail/delegation.js'
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
 * The store's record that the person's report of work they own (#1463) is held over the session's own background work (#721), kept across a restart.
 * A build before #1948 step 3 also kept a caller's in `report_paused:<session>`; it is not read (docs/plans/mailbox.md §10.6.3)
 */
export const personPausedKey = (sessionId: string) => `person_report_paused:${sessionId}`
/** A task a paused report waits on (#721), as kept in `person_report_paused:<session>` */
export type PausedTask = { id: string; description: string }
/** The tasks of a stored pause, or null when there is none (an unreadable value is a pause on nothing known) */
export function readPausedTasks(raw: string | null): PausedTask[] | null {
  if (raw === null) return null
  return readJsonObjects<PausedTask>(raw, (t) => typeof t.id === 'string' && typeof t.description === 'string')
}

/**
 * Whose a turn is (#1377): the person's (the person wrote while the session was at rest, or their message waited for
 * the turn), or the delegated work's (the caller's message, an app's or Centralu's, or the CLI starting it itself when
 * the work's background tasks end). `wrote`: the person wrote into a turn of the work. `cut`: an update of Centralu cut the
 * turn and Centralu continued it (#1966): its end says so.
 */
export type TurnStarter = { by: 'person' | 'work'; wrote?: true; cut?: true }
/**
 * A message given the tool (#1639, docs/plans/turn-starter.md): the input id and row it went in under (none in a test that gives no
 * row), whose it is, and `joined`: it is queued while a turn runs (given into it, or behind the input it opened from), which may take it in
 * at a tool round; `after`: it went in while a turn ran, to a tool that holds it for a turn after that one; `carried`: it went into a turn that
 * ended naming nothing (Codex), which took it in unless the next turn opens for it. `origin`: a hub's message (#1604)
 */
type Entry = { id?: string; seq?: number; by: 'person' | 'work'; source: TurnSource; joined: boolean; after?: true; carried?: true; origin?: TurnOrigin }
/**
 * Where each session's messages given its tool stand (#1639), in `turn_inputs:<session>`: `spent`, the rows at or before it are done
 * with, and the held ones are the user rows after it that carry an `inputId`; and of the running turn, whether its opening was named, and
 * each held id that is `joined`, `after` or `carried` (`marks`). Read back once per host, so a host that takes a kept session over mid-turn
 * decides as the one before would have. A build before #1948 also kept `takenOver` (the person took the turn over); it is not read
 */
export const turnInputsKey = (sessionId: string) => `turn_inputs:${sessionId}`
function readInputs(raw: string | null) {
  const p = raw === null ? {} : asObj(tryParseJson(raw))
  const marks: Record<string, unknown> = asObj(p.marks)
  return { spent: typeof p.spent === 'number' ? p.spent : null, named: p.named === true, marks }
}
/** The entry a user row is, when it went in under an input id (#1639): the person's when no one else is named on it */
function entryOf(row: StoredMessage): (Entry & { id: string }) | undefined {
  const p = asObj(row.payload)
  if (row.role !== 'user' || typeof p.inputId !== 'string') return undefined
  const work = p.from !== undefined || p.fromApp !== undefined || p.fromScript !== undefined
  const hub = TurnOrigin.safeParse({ seq: row.seq, from: p.from })
  return {
    id: p.inputId, seq: row.seq, by: work ? 'work' : 'person',
    source: p.relayed === true ? 'report' : p.fromApp !== undefined ? 'app' : 'caller', joined: false,
    ...(hub.success && isHubSender(hub.data.from.sessionId) ? { origin: hub.data } : {}),
  }
}
/**
 * Whose a turn that ran for these messages is (#1377): the work's if any is (the work's instruction is in it), with the person's noted
 * (`wrote`); else the person's. The source is the first of the work's
 */
function starterFor(ran: readonly Entry[]): { starter: TurnStarter; source: TurnSource } {
  const source = ran.find((e) => e.by === 'work')?.source ?? 'caller'
  if (!ran.some((e) => e.by === 'work')) return { starter: { by: 'person' }, source }
  return { starter: { by: 'work', ...(ran.some((e) => e.by === 'person') ? { wrote: true as const } : {}) }, source }
}
/** The store's record of whose the turn a session is in is (#1377), kept across a swap and read by the next start for a turn a quit cut (#1946) */
export const reportTurnKey = (sessionId: string) => `report_turn:${sessionId}`
/**
 * The hub's messages the tool holds (#1604), in `input_origins:<session>`: `[inputId, origin][]`. Written from the held entries (the ones
 * with an `origin`) for a build before #1639, which reads it during a swap; this build reads the entries. Removed in the release after
 * #1639 (add first, remove later).
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
/** The turn kept in `report_turn:<session>`: its known fields only (a build before #1639 kept a `pending` list beside them) */
function readTurn(raw: string | null): TurnStarter | null {
  const t = raw === null ? {} : asObj(tryParseJson(raw))
  if (t.by !== 'person' && t.by !== 'work') return null
  return { by: t.by, ...(t.wrote === true ? { wrote: true as const } : {}) }
}

/** A delegated turn's link (#676): who gave the turn, and the cards it was already told of */
export type TurnOwner = { callerId: string; untilTurnEnd: boolean; told: Set<string>; turnId: string }

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
 * Who owns a child session's work (#428): the turn another session gave it, the person's report paused over its own background work, the
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
   * The person's report of work they own (#1463) held over the session's own background work (#721): a turn ended while work it started still ran.
   * Holds the tasks it paused on, mirrored in `person_report_paused:<session>` so a restart keeps it
   */
  private readonly personPaused = new Map<string, PausedTask[]>()
  readonly personPausedReports: ReadonlyMap<string, PausedTask[]> = this.personPaused
  /**
   * Whose the running turn is, by session (#1377): recorded when the turn starts from the message that started it, decided
   * at its end. Mirrored in the app setting `report_turn:<session>`, so a host that takes over a kept session mid-turn knows it.
   * None recorded: the work's.
   */
  private readonly starters = new Map<string, TurnStarter>()
  /** Turns the tool started by itself, no message behind them (`turnStarted`, #1576); memory only, a swap forgets it */
  private readonly cliTurns = new Set<string>()
  /** Sessions whose running turn an update cut and Centralu continued (#1966): the turn's end carries it, once. Memory only */
  private readonly continuedCuts = new Set<string>()
  private readonly lastBy = new Map<string, 'person' | 'work'>()
  /** The messages given each session's tool that no turn has taken yet (#1639), oldest first; read back from the rows once per host (`held`) */
  private readonly entries = new Map<string, Entry[]>()
  /** The last row of each session's messages that are done with (`turn_inputs`'s `spent`) */
  private readonly spentAt = new Map<string, number>()
  /** Running turns whose opening input the tool named (`turnNamed`); one not named is decided again by the inputs its end names */
  private readonly named = new Set<string>()
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
   * owes an answer), or the receivers of its own (`from`, whose answer it waits for). None with no mailbox. Never throws
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
   * before the message goes in, `owes` says whether the person has work with the session whose turns are reported, `report` posts a turn's end in
   * the person's thread. Set by the host when it has a mailbox
   */
  private personWork:
    | { started(sessionId: string, text: string, fromScript?: { credential: string }): void; withdrawn(sessionId: string): void; owes(sessionId: string): boolean; report(sessionId: string, draft: PersonReportDraft): boolean }
    | undefined
  onPersonWork(hooks: ChildOwnership['personWork']): void {
    this.personWork = hooks
  }

  /**
   * A new session's first message `text`, sent by `send`. A script's (`fromScript`) is work the person owns, written down first; when
   * `send` throws, no turn will come of it and the person's task is withdrawn (#1463) before the error goes on
   */
  firstMessage(sessionId: string, text: string, fromScript: { credential: string } | undefined, send: () => void): void {
    if (!fromScript) return send()
    this.personCall('write down the work for the person started in', sessionId, undefined, (w) => w.started(sessionId, text, fromScript))
    try {
      send()
    } catch (e) {
      this.personCall('withdraw the work for the person started in', sessionId, undefined, (w) => w.withdrawn(sessionId))
      throw e
    }
  }

  /** Whether the person has work with `sessionId` whose turn is reported to them; false with no mailbox. Never throws */
  personOwes(sessionId: string): boolean {
    return this.personCall('read the work of the person in', sessionId, false, (w) => w.owes(sessionId))
  }

  /** The end of a turn of work the person owns, in their thread; false when it was not taken. Never throws */
  reportedToPerson(sessionId: string, draft: PersonReportDraft): boolean {
    return this.personCall('report to the person the work of', sessionId, false, (w) => w.report(sessionId, draft))
  }

  /** A call into the mailbox's person work: what it gives without a mailbox, or when it failed, which is logged */
  private personCall<T>(what: string, sessionId: string, none: T, call: (w: NonNullable<ChildOwnership['personWork']>) => T): T {
    try {
      return this.personWork ? call(this.personWork) : none
    } catch (e) {
      console.error(`[mail] could not ${what} ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
      return none
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

  /**
   * At startup (#1463): the person's paused reports, all read back. Returns the ones whose work went with the last host's process (any but the
   * sessions whose turn goes on under this host), to be reported as ended
   */
  restorePersonPaused(sessions: ReadonlyMap<string, SessionInfo>, goingOn: ReadonlySet<string>): string[] {
    for (const id of sessions.keys()) {
      const tasks = readPausedTasks(this.store.settings.appSetting(personPausedKey(id)))
      if (tasks) this.personPaused.set(id, tasks)
    }
    return [...this.personPaused.keys()].filter((id) => !goingOn.has(id))
  }

  /** At startup (#676): the delegated turns of the sessions whose turn goes on under this host (`goingOn`); any other row is dropped */
  restoreTurns(sessions: ReadonlyMap<string, SessionInfo>, goingOn: ReadonlySet<string>): void {
    /*
     * A delegated turn's link survives an update the same way (#676, #1618): the turn an update cut is continued here, and
     * may ask its caller again. With no delegation in this host's memory, the link ends with the turn. Any other row is
     * dropped: that turn is over.
     */
    for (const row of this.store.children.listDelegatedTurns()) {
      const s = sessions.get(row.sessionId)
      if (goingOn.has(row.sessionId) && !!s && inTurn(s.state) && sessions.has(row.callerSessionId)) {
        this.adoptTurn(row.sessionId, { callerId: row.callerSessionId, untilTurnEnd: true, told: new Set(row.told), turnId: row.turnId })
        continue
      }
      this.store.children.clearDelegatedTurn(row.sessionId)
    }
  }

  /**
   * The turn a session was in when the last host stopped (#1377), owed a report or not (#1946): the person's is reported to nobody
   * when it ends here, nor told to its asker when it ends cut
   */
  adoptStarter(sessionId: string): void {
    const stored = this.recordedTurn(sessionId)
    if (stored) this.starters.set(sessionId, stored)
  }
  /** Holds the person's report of work they own over the session's own background work (#721, #1463) */
  pausePersonReport(sessionId: string, running: readonly PausedTask[]): void {
    const held = this.personPaused.get(sessionId) ?? []
    const added = running.filter((t) => !held.some((h) => h.id === t.id)).map((t) => ({ id: t.id, description: t.description }))
    if (!this.personPaused.has(sessionId) || added.length) {
      const next = [...held, ...added]
      this.personPaused.set(sessionId, next)
      this.store.settings.setAppSetting(personPausedKey(sessionId), JSON.stringify(next))
    }
  }
  unpausePersonReport(sessionId: string): void {
    if (this.personPaused.delete(sessionId)) this.store.settings.deleteAppSetting(personPausedKey(sessionId))
  }
  /**
   * A message goes into the session (#1377): the person's, or anyone else's (a caller's, an app's, Centralu's). At rest
   * (or where the tool holds it for a turn of its own) it is what the next turn starts from; into a running turn it joins
   * that turn: a person's into the work's is noted ("the person wrote during this turn"), into their own it is theirs.
   */
  noteMessage(sessionId: string, by: 'person' | 'work', inTurnNow: boolean, joinsRunningTurn: boolean, inputId?: string, source: TurnSource = 'caller', seq?: number): void {
    /*
     * Into a running turn: the tool may take it in at its next round, or run it as a turn of its own once this one ends (Claude folds a
     * queued input in only at a tool round, so a message sent while the final answer is written is a turn of its own). Which, is said at
     * the turn's end (`turnEnded`) by the inputs the turn took, or when the turn it runs as opens (`turnNamed`)
     */
    const joined = inTurnNow && joinsRunningTurn
    if (joined && !this.starters.has(sessionId)) this.starters.set(sessionId, { by: 'work' })
    const held = this.held(sessionId)
    const mark = { joined, ...(inTurnNow && !joined ? { after: true as const } : {}) }
    // A host that just took the session over read this message back from the row already stored: the same entry, marked as given now
    const kept = inputId !== undefined ? held.find((e) => e.id === inputId) : undefined
    if (kept) Object.assign(kept, mark)
    else held.push({ ...(inputId !== undefined ? { id: inputId } : {}), ...(seq !== undefined ? { seq } : {}), by, source, ...mark })
    this.save(sessionId)
    if (joined) this.persistTurn(sessionId)
  }
  /**
   * The session's held messages (#1639), read back the first time this host asks: every user row after `spent` with an input id, and the
   * running turn's state as the host before left it. This build gives every user row an input id except two: the first prompt (the first
   * row, before any message) and the words read back from the tool's own record (`transcript`, which a late catch-up can store after a
   * message just given; skipped). Any other user row without one was written by a build before #1639 after a rollback, which ran the
   * session: what was given before it is done with. A delegated task the mailbox gave (`mail`) shows as its sender's row and is skipped too: the
   * tool took it as mail. With no `turn_inputs` at all, a build before #1639 left the session (`legacyHeld`)
   */
  private held(sessionId: string): Entry[] {
    let held = this.entries.get(sessionId)
    if (!held) {
      const raw = this.store.settings.appSetting(turnInputsKey(sessionId))
      const kept = readInputs(raw)
      let spent = kept.spent
      held = spent === null && raw === null ? this.legacyHeld(sessionId) : []
      for (const row of spent === null ? [] : this.store.messages.loadUserRowsFrom(sessionId, spent)) {
        const e = entryOf(row)
        const mark = e && kept.marks[e.id]
        if (e) held.push({ ...e, joined: mark === 'joined', ...(mark === 'after' || mark === 'carried' ? { [mark]: true as const } : {}) })
        else if (asObj(row.payload).transcript !== true && asObj(row.payload).mail !== true) [held, spent] = [[], row.seq]
      }
      if (spent !== null) this.spentAt.set(sessionId, spent)
      if (kept.named) this.named.add(sessionId)
      this.entries.set(sessionId, held)
    }
    return held
  }
  /**
   * What a build before #1639 left of the messages its session's tool holds (an upgrade swap; read once, removed with `input_origins`): the
   * running turn's `pending` in `report_turn` (given into it), and the hub's messages in `input_origins`. Its rows carry no input id
   */
  private legacyHeld(sessionId: string): Entry[] {
    const listed = tryParseJson(this.store.settings.appSetting(inputOriginsKey(sessionId)) ?? '[]')
    const items: unknown[] = Array.isArray(listed) ? listed : []
    const hub = items.flatMap((e) => {
      const pair: unknown[] = Array.isArray(e) ? e : []
      const [id, given] = pair
      const origin = TurnOrigin.safeParse(given)
      return typeof id === 'string' && origin.success ? [{ id, seq: origin.data.seq, origin: origin.data }] : []
    })
    const turn = asObj(tryParseJson(this.store.settings.appSetting(reportTurnKey(sessionId)) ?? '{}'))
    // The turn running was decided by the build before, at its start
    if (turn.by === 'person' || turn.by === 'work') this.named.add(sessionId)
    const given: Entry[] = (Array.isArray(turn.pending) ? turn.pending.map(asObj) : []).flatMap((p) => p.by !== 'person' && p.by !== 'work' ? [] : [{
      ...(typeof p.id === 'string' ? { id: p.id, ...hub.find((h) => h.id === p.id) } : {}), by: p.by,
      source: p.source === 'app' || p.source === 'report' ? p.source : 'caller', joined: true,
    }])
    const atRest: Entry[] = hub.filter((h) => !given.some((g) => g.id === h.id)).map((h) => ({ ...h, by: 'work', source: 'caller', joined: false }))
    return [...atRest, ...given]
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
    const marks = Object.fromEntries(held.flatMap((e) => {
      const mark = e.carried ? 'carried' : e.after ? 'after' : e.joined ? 'joined' : undefined
      return mark && e.id !== undefined ? [[e.id, mark]] : []
    }))
    this.store.settings.setAppSetting(turnInputsKey(sessionId), JSON.stringify({
      ...(Number.isFinite(spent) ? { spent } : {}), ...(this.named.has(sessionId) ? { named: true } : {}),
      ...(Object.keys(marks).length ? { marks } : {}),
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
   * are those said so far (or none), never the turn before's, and nothing it was given is run by anyone. Returns whose that turn
   * was, as the host before recorded it (#1946); none recorded reads as the work's, as at any turn's end
   */
  processGone(sessionId: string): TurnStarter {
    this.dropInputOrigins(sessionId)
    this.noteTurnEnd(sessionId)
    const turn = this.recordedTurn(sessionId) ?? { by: 'work' }
    this.store.settings.deleteAppSetting(reportTurnKey(sessionId))
    return turn
  }
  /** Whose the turn running is, as the store keeps it (`persistTurn`): what a host that did not see it begin reads (#1946) */
  private recordedTurn(sessionId: string): TurnStarter | null {
    return readTurn(this.store.settings.appSetting(reportTurnKey(sessionId)))
  }
  /** The session is deleted: nothing kept of its turns (for a hub that followed them, whose work they were, the person's paused report) is kept (`purgeSession` removes the same keys by their shape) */
  forgetTurns(sessionId: string): void {
    this.dropInputOrigins(sessionId)
    this.store.settings.deleteAppSetting(turnSpanKey(sessionId))
    this.store.settings.deleteAppSetting(turnInputsKey(sessionId))
    this.store.settings.deleteAppSetting(questionAnsweredKey(sessionId))
    this.entries.delete(sessionId)
    this.spentAt.delete(sessionId)
    this.named.delete(sessionId)
    this.lastBy.delete(sessionId)
    this.unpausePersonReport(sessionId)
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
   * A turn starts (#1377, #1639): it is decided now, by the oldest message given before it, else it is the CLI's own (the work's background
   * tasks ended). Nothing is taken off yet: when the tool names the input the turn opened from, it is decided again (`turnNamed`)
   */
  turnStarted(sessionId: string): void {
    const held = this.held(sessionId)
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
   * under (a mail wake, a compact, a quiet note), or none at all (`[]`): the CLI's own. `null`: not an opening, nothing changes.
   * The messages held after it are queued behind it, so it may take them in at a tool round.
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
      this.decide(sessionId, ran.length ? starterFor(ran) : undefined, true)
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
    const same = was !== undefined && was.by === starter.by && !!was.wrote === !!starter.wrote && this.cliTurns.has(sessionId) === !decided
    if (again && same) return
    this.starters.set(sessionId, starter)
    if (decided) this.cliTurns.delete(sessionId)
    else this.cliTurns.add(sessionId)
    this.persistTurn(sessionId)
    if (!this.turnStartedHook) return
    // The caller whose turn it was given as (#676): the turn is the work of the task it gave
    const ownerId = this.turns.get(sessionId)?.callerId
    try {
      this.turnStartedHook(sessionId, { by: starter.by, cli: !decided, source: decided?.source ?? 'caller', ...(ownerId ? { ownerId } : {}), ...(again ? { again: true as const } : {}) })
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
    if (this.continuedCuts.delete(sessionId)) starter.cut = true
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
    if (starter.by === 'work' && joinedIt.some((p) => p.by === 'person')) starter.wrote = true
    if (cut || taken === null) this.spend(sessionId, held.length)
    this.save(sessionId)
    this.lastBy.set(sessionId, starter.by)
    this.store.settings.deleteAppSetting(reportTurnKey(sessionId))
    return starter
  }
  /** Whose the session's last turn was (#1377): its last response is the person's answer when it was theirs */
  lastTurnBy(sessionId: string): 'person' | 'work' | undefined {
    return this.lastBy.get(sessionId)
  }
  /** The turn running was cut by an update and continued (#1966): its report says so in one line */
  noteContinuedCut(sessionId: string): void {
    this.continuedCuts.add(sessionId)
  }
  /** The Continue did not go in after all: the turn's end is a stopped turn's, not a continued one's */
  dropContinuedCut(sessionId: string): void {
    this.continuedCuts.delete(sessionId)
  }
  /** Whose the running turn is, when one is recorded */
  starterOf(sessionId: string): TurnStarter | undefined {
    return this.starters.get(sessionId)
  }
  /** Kept for a host that takes the session over mid-turn, and for the next start when a quit cuts the turn (#1946) */
  private persistTurn(sessionId: string): void {
    const s = this.starters.get(sessionId)
    const value = s && JSON.stringify(s)
    if (value && this.store.settings.appSetting(reportTurnKey(sessionId)) !== value) this.store.settings.setAppSetting(reportTurnKey(sessionId), value)
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
   * Moves what `from` owns of the given children to `to`, in memory (#693, #738): the turns `from` gave them, its delegations and observer notes on them (their keys
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
    for (const [id, owner] of this.turns) if (moving.has(id) && owner.callerId === from) owner.callerId = to
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

