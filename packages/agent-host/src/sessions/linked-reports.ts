import { stamped } from '../log-file.js'
import { applyBackgroundTasks, liveBackgroundTasks, type BackgroundTask, type NormalizedEvent } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { isQualifiedHubSender } from './hub-sender.js'
import { linkedTurnEnd, turnSince } from './linked-turn-end.js'
import { OWN_WORK_SETTLE_MS, type ChildOwnership, type LinkedReport, type TurnStarter } from './child-ownership.js'
import { IN_PAUSE_REPORT, MACHINE_UNREACHABLE, NO_WORDS } from './ask-project.js'
import { clipPreview } from './turn-answer.js'

/** The person's part in a turn a report tells of (#1377), and what Centralu did to it: an update cut it (#1966) */
export type ReportPart = { wrote?: true; cut?: true }

/** The work a report is about, as `deliverReport` words its first line (#721, #723) */
export type ReportWork =
  /** `update` (#1540): not the first pause but a later turn of the paused work, which ended with a new answer while that work still runs */
  | { paused: readonly BackgroundTask[]; stoppable: boolean; update?: true }
  | { settled: readonly BackgroundTask[] }
  | { linkLost: string; paused: readonly BackgroundTask[]; asRead?: true }
  /** The machine was removed from Centralu: `paused`, the work its turn ended with; absent, a turn still running */
  | { machineRemoved: string; paused?: readonly BackgroundTask[]; asRead?: true }

/** A later turn of work whose report is paused on the session's own background work, as a linked machine's report knows it (#1540) */
export type LaterTurn = {
  /** Centralu's own turn to compact the conversation */
  compaction?: boolean
  /** A message no session sent went into it: the person's, an app's or a script's. Such a turn may be theirs though it reads as the work's */
  othersWrote?: boolean
  /** The person wrote to the session since it owed the report: which of its turns are theirs cannot always be told, and their words are not the caller's */
  personWrote?: boolean
}

/**
 * Whether a later turn of paused work is an update its caller hears at once (#1540): one that said something of its own, in the work's own turn.
 * A turn with no words (a Monitor's look), Centralu's compaction, a turn others wrote into, and every turn once the person wrote to the session tell
 * nothing; the final report still comes when the work ends. A linked machine's children's rule, until mail crosses links (#1948 step 6); this host's
 * children answer with their last response (docs/plans/mailbox.md §10.6.3)
 */
export function isPauseUpdate(turn: LaterTurn, words: string): boolean {
  return !turn.compaction && !turn.othersWrote && !turn.personWrote && words.trim() !== ''
}

/**
 * What the linked machines' reports reach (#428): the manager's members they read, with getters for its fields, so
 * each is read when used, never kept.
 */
export type LinkedReportsHost = {
  readonly children: ChildOwnership
  readonly linkedReader: LinkedSessions | null
  /** Whether the session is still this host's: the Assistant a report goes to may have been deleted */
  hasSession(sessionId: string): boolean
  /** Shutting down or handing over: a report a wait would send now is the next host's, or nobody's */
  readonly closing: boolean
  deliverReport(
    assistantId: string,
    sessionId: string,
    name: string,
    project: string,
    preview: string,
    ending: Pick<NormalizedEvent, 'type'> & { error?: { message?: string } },
    work?: ReportWork,
    answerSeq?: number,
    part?: ReportPart,
  ): Promise<unknown>
  /**
   * Whether a report about this session may go now (#1038 review): a child start_agent started on a linked machine
   * answers by whose its turn is (`RemoteAgents.reportGate`): its caller's goes, another's (the person's on that
   * machine) is reported to nobody, and one the hub cannot tell yet stays owed until it can. Any other session's goes
   */
  reportGate?(sessionId: string): 'deliver' | 'withhold' | 'defer'
  /**
   * What a link lost over this session's paused report keeps (#1523): a child start_agent started keeps the report, as it follows its
   * work across the loss (`RemoteAgents`), so the link's return reads where it stands and its end is reported then; `turn` keeps the
   * turn running there too, the same turn, when an update that continues it there holds the link (#2164). Null: nothing is kept
   */
  keepsOverLoss?(sessionId: string): 'report' | 'turn' | null
}

/** What a report says of a turn besides its words (#1377, #1966): nothing, unless the person wrote into it, or an update cut it and it was continued (said by the machine's host) */
function partOf(turn: TurnStarter): ReportPart | undefined {
  return turn.wrote || turn.cut ? { ...(turn.wrote ? { wrote: true as const } : {}), ...(turn.cut ? { cut: true as const } : {}) } : undefined
}

/** Whose the turn was, as the machine's host said it on the event that ended it (#1377); undefined from a host that does not say. A host before #1948 may say `added`, which is not read */
function saidTurn(raw: unknown): TurnStarter | undefined {
  if (typeof raw !== 'object' || raw === null || !('by' in raw) || (raw.by !== 'person' && raw.by !== 'work')) return undefined
  return { by: raw.by, ...('wrote' in raw && raw.wrote === true ? { wrote: true as const } : {}), ...('cut' in raw && raw.cut === true ? { cut: true as const } : {}) }
}

/** Whether the machine's host said the turn was Centralu's own to compact the conversation (#1451), on the event that ended it */
function compacted(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && 'compaction' in raw && raw.compaction === true
}

/** Whether a relayed message was sent by this hub's Assistant: the machine records it as from `HUB_SENDER`, qualified */
function fromHub(from: unknown): boolean {
  return isQualifiedHubSender((from as { sessionId?: unknown } | null)?.sessionId)
}

/** A machine's event as the hub relays it to its windows (qualified, links.ts): only the fields read here */
export type LinkedEvent = {
  type: string
  sessionId?: unknown
  state?: unknown
  reason?: unknown
  error?: { message?: string }
  /** A card's request id (`approval_request`, `question_request`) */
  requestId?: unknown
  /** A message's number in its conversation (`user_message`) */
  seq?: unknown
  machine?: unknown
  machineId?: unknown
  text?: unknown
  from?: unknown
  /** Whose the turn was, on the event that ends it (#1377) */
  turn?: unknown
  /** The message a turn ran for, on the `state_change` that opens it, when the tool ran it after the turn it was sent into (#1604) */
  origin?: unknown
  /** What a turn that began with no message goes on with, on the `state_change` that opens it (#2164) */
  continues?: unknown
  /** An app's message (`user_message`): not the person's */
  fromApp?: unknown
  live?: unknown
  ended?: unknown
  clearEnded?: unknown
}

/**
 * The Assistant's reports from a linked machine's sessions (#82 phase 4, `reportBack` on `send_to_session`), and
 * the work a session there ends its turn with (#723).
 *
 * The end of a turn the Assistant waits on is its report, once, as this host's own sessions' reports were before #1948
 * step 3 (this host's are now the mailbox's, docs/plans/mailbox.md §10.6.3; this path stays until mail crosses links). A turn that **completes** while the session's own background work still runs there (the machine's
 * `background_tasks`, timers left out) is a pause, by the same rules as here (#721): the Assistant is told once that
 * the work paused, and the report stays owed until a turn ends with none of that work left. If the work ends and no turn
 * follows within `OWN_WORK_SETTLE_MS`, the report goes out with how each task ended; if the machine's link drops
 * or the machine is removed first, it goes out saying so, since the hub would not see the work's end.
 */
export class LinkedReports {
  /**
   * Each linked session's background work, as its machine last listed it: read whole from `sessions.list` each time the
   * link comes up (`machine_resync`), and changed by the relayed `background_tasks` (which replace the live set). Kept
   * for every session a machine relays, so work started before the Assistant asked is known
   */
  private readonly tasks = new Map<string, BackgroundTask[]>()
  /** When each session's list last changed, on `clock`: a machine's list read before that change does not undo it */
  private readonly changedAt = new Map<string, number>()
  private clock = 0
  /** A paused report's wait for the turn the work's end may start, by qualified session id */
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>()
  /** The machines' names, from their status, for a report after the machine is gone */
  private readonly machineNames = new Map<string, string>()
  /** What a waited-on session is called, kept while it can be read: a removed machine's mirror is gone */
  private readonly about = new Map<string, { name: string; project: string }>()
  /** Waits whose paused turn's answer the call that asked took (`oweAsker`): that turn's end is no update (#1540). They go with the wait */
  private readonly callTookTurn = new WeakSet<LinkedReport>()
  /** Waits whose session the person wrote to there since they began: no later turn is an update (#1540, `isPauseUpdate`) */
  private readonly personWrote = new WeakSet<LinkedReport>()

  constructor(private readonly host: LinkedReportsHost) {}

  observe(e: LinkedEvent): void {
    if (e.type === 'machine_status') return this.linkChanged(e.machine)
    if (e.type === 'machine_resync') return this.resync(e.machineId)
    if (typeof e.sessionId !== 'string') return
    const sessionId = e.sessionId
    if (e.type === 'background_tasks' && Array.isArray(e.live)) {
      this.tasks.set(sessionId, applyBackgroundTasks(this.tasks.get(sessionId) ?? [], {
        live: e.live as BackgroundTask[],
        ...(Array.isArray(e.ended) ? { ended: e.ended as BackgroundTask[] } : {}),
        ...(e.clearEnded === true ? { clearEnded: true } : {}),
      }))
      this.changedAt.set(sessionId, ++this.clock)
    }
    const wait = this.host.children.linkedReports.get(sessionId)
    if (e.type === 'session_deleted') {
      this.forget(sessionId)
      // Deleted there: its work went with it, and nobody is owed more of it (as a child trashed here)
      if (wait) this.drop(sessionId)
      return
    }
    if (!wait) return
    this.remember(sessionId)
    /*
     * Whose a turn there is (#1377), where the machine's host does not say it on the turn's end (`saidTurn`): the person's
     * message at rest makes the next turn theirs, and it is not reported; into the work's turn it is noted. It never closes the report.
     */
    if (e.type === 'user_message' && wait.instruction === undefined) this.messageSeen(wait, e)
    if (e.type === 'background_tasks') {
      if (wait.paused) this.settleLater(sessionId, wait)
      return
    }
    /*
     * A wait set for an instruction starts at that instruction (#1082). It is set before the send goes out, and a turn
     * end the machine sent before it recorded the instruction can still be on its way: a link relays one machine's
     * events in order, so what comes before the instruction's own `user_message` happened there before it, and is the
     * end of an earlier turn. From that message on, as before: a turn running there then takes the instruction as
     * mid-turn input and its end is the report, as a local session's is. A record that never comes (lost before it was
     * relayed) is not waited for past the send's answer (`sendToSession`, assistant-seat.ts).
     */
    if (wait.instruction !== undefined) {
      if (e.type === 'user_message' && e.text === wait.instruction && fromHub(e.from)) {
        delete wait.instruction
        // The turn that takes the instruction is the work's
        wait.next = { by: 'work' }
      }
      return
    }
    const step = linkedTurnEnd(wait.busy, e)
    if (step?.step === 'busy') {
      // Whose the turn is settles where it starts: the events after it (words, a tool, a card) are the same turn
      if (!wait.busy) {
        wait.turn = wait.next ?? { by: 'work' }
        delete wait.next
      }
      wait.busy = true
      // A turn runs: its own end reports
      this.stopSettling(sessionId)
      return
    }
    if (step?.step !== 'completed' && step?.step !== 'failed') return
    /*
     * The machine's host says whose the turn was (from the inputs the tool took in), and that is what is read. A host that
     * does not say (an older one) leaves the hub to its own reading of the messages and turn starts it saw
     */
    const turn = saidTurn(e.turn) ?? wait.turn ?? { by: 'work' as const }
    delete wait.turn
    wait.lastBy = turn.by
    // The person's own turn is reported to nobody and changes nothing of the report; paused work that ended meanwhile settles again
    if (turn.by === 'person') {
      wait.busy = false
      if (wait.paused) this.settleLater(sessionId, wait)
      return
    }
    // Whose turn ended (#1038 review): another's is reported to nobody; one the hub cannot tell yet stays owed
    const gate = this.gate(sessionId)
    /*
     * Held until whose it is can be told: the settling end (`settleLinkedTurn`) says nothing of the turn, so what the machine
     * said of it is kept for that end, and its report still says an update cut it (#2157). The turn has ended all the same: the next
     * one to start sets whose it is afresh, so what this one carried (its cut) is never a later turn's
     */
    if (gate === 'defer') {
      wait.turn = turn
      wait.busy = false
      return
    }
    if (gate === 'withhold') return this.drop(sessionId)
    // Only a turn that completed is paused: a failed or stopped one is reported as it ended (#698)
    const running = e.type === 'turn_complete' ? this.ownTasksRunning(sessionId) : []
    // The turn whose answer the asking call took (`oweAsker`): its end is told, and is no update
    const callTook = this.callTookTurn.delete(wait)
    if (running.length) {
      const told = !!wait.paused
      const held = wait.paused ?? []
      wait.paused = [...held, ...running.filter((t) => !held.some((h) => h.id === t.id))]
      // A state the machine reports before the next turn starts is not that turn's end
      wait.busy = false
      // Changed in place: set again, so what keeps it stored reads the pause (#1038)
      this.host.children.setLinkedReport(sessionId, wait)
      // Told already: a later turn with a new answer is an update, at once (#1540), by the rule this host's own children follow (`isPauseUpdate`)
      const later: LaterTurn | undefined = told ? { compaction: compacted(e.turn), othersWrote: !!turn.wrote, personWrote: this.personWrote.has(wait) } : undefined
      if (!(told && callTook)) void this.report(sessionId, wait.assistantId, e, { paused: running, stoppable: false, ...(told ? { update: true as const } : {}) }, undefined, partOf(turn), false, wait, later)
      return
    }
    this.drop(sessionId)
    void this.report(sessionId, wait.assistantId, e, undefined, undefined, partOf(turn))
  }

  /**
   * An ask_project task's turn there ended (#1457) with the session's own background work still running: the asker is
   * owed the work's last turn end, as the Assistant is for a `reportBack` send (#723). The call that asked answers with
   * this turn's words and says the work is paused, so this is the report kept for what follows, with no notice of its own
   * (`observe` finds it paused already and tells nobody). Returns the work it paused on, none when the turn is not one
   * to pause on (it did not complete, was the person's, the machine lists no such work, or an older machine does not list
   * its background tasks at all), the report is another session's, or the gate does not let this one through.
   */
  oweAsker(sessionId: string, callerId: string, ending: Pick<LinkedEvent, 'type' | 'turn'>): BackgroundTask[] {
    if (ending.type !== 'turn_complete' || saidTurn(ending.turn)?.by === 'person') return []
    const running = this.ownTasksRunning(sessionId)
    if (!running.length) return []
    const held = this.host.children.linkedReports.get(sessionId)
    if ((held && held.assistantId !== callerId) || this.gate(sessionId) !== 'deliver') return []
    this.stopSettling(sessionId)
    this.remember(sessionId)
    const wait: LinkedReport = { assistantId: callerId, busy: false, paused: [...running] }
    this.callTookTurn.add(wait)
    this.host.children.setLinkedReport(sessionId, wait)
    return running
  }

  /**
   * The asker's new task replaces the report it was owed for its earlier one (#721: new work from the same caller ends
   * the pause, and that run's own wait tells its end). Returns what puts the report back, for a send that fails; none when
   * the session owes the asker no paused report.
   */
  releaseAsker(sessionId: string, callerId: string): (() => void) | undefined {
    const held = this.host.children.linkedReports.get(sessionId)
    if (!held?.paused || held.assistantId !== callerId) return undefined
    this.drop(sessionId)
    return () => {
      if (this.host.children.linkedReports.has(sessionId)) return
      this.host.children.setLinkedReport(sessionId, held)
      this.restored(sessionId)
    }
  }

  /**
   * A message the machine took (#1377). Whose it is: a message with no source is the person's; the hub's instruction,
   * another session's and an app's are the work's. At rest it is what the next turn starts from; into a running turn it
   * joins it, noted when it is the person's into the work's. A choice an older machine relays on it (`intent`, before #1948) is not read
   */
  private messageSeen(wait: LinkedReport, e: LinkedEvent): void {
    const person = !e.from && !e.fromApp
    // A pause of this work sends no more updates (#1540, `isPauseUpdate`)
    if (person) this.personWrote.add(wait)
    if (wait.busy) {
      const running = wait.turn ?? { by: 'work' as const }
      wait.turn = running
      if (person && running.by === 'work') running.wrote = true
    } else if (wait.next) {
      if (person && wait.next.by === 'work') wait.next.wrote = true
    } else {
      wait.next = { by: person ? 'person' : 'work' }
    }
  }

  /**
   * A report `send_to_session` put back after its send failed (assistant-seat.ts): the events of the send's moment
   * went to the wait that send had set, so a paused report's settle wait starts again from what the hub knows now
   */
  restored(sessionId: string): void {
    const wait = this.host.children.linkedReports.get(sessionId)
    if (wait?.paused) this.settleLater(sessionId, wait)
  }

  /**
   * Every settle wait ends with the host. The next host settles only what a child start_agent started on a linked
   * machine is still owed (`RemoteAgents.restore`, #1038); the Assistant's linked reports live in memory
   */
  dispose(): void {
    for (const timer of this.settling.values()) clearTimeout(timer)
    this.settling.clear()
  }

  private gate(sessionId: string): 'deliver' | 'withhold' | 'defer' {
    return this.host.reportGate?.(sessionId) ?? 'deliver'
  }

  /** Each linked session's background work as its machine last listed it (`tasks`), for `pausedOnBackground` */
  tasksOf(sessionId: string): readonly BackgroundTask[] {
    return this.tasks.get(sessionId) ?? []
  }

  /** The session's own background work its machine lists as running; a timer the tool holds is not work (#721) */
  ownTasksRunning(sessionId: string): BackgroundTask[] {
    return liveBackgroundTasks(this.tasks.get(sessionId) ?? []).filter((t) => !t.timer)
  }

  /** The tasks a paused report waited on, as the machine lists them now: how each ended, or still running */
  private pausedTasksNow(sessionId: string, wait: LinkedReport): BackgroundTask[] {
    const listed = this.tasks.get(sessionId) ?? []
    return (wait.paused ?? []).map((t) => listed.find((l) => l.id === t.id) ?? { ...t, status: 'completed' as const })
  }

  /**
   * A paused report whose work has ended with no turn running there: the turn that ending starts reports it, and if
   * none starts within `OWN_WORK_SETTLE_MS` the report goes out as the work's end. Each change of the work starts
   * the wait again.
   */
  private settleLater(sessionId: string, wait: LinkedReport): void {
    this.stopSettling(sessionId)
    const quiet = () => this.host.children.linkedReports.get(sessionId) === wait && !wait.busy && this.ownTasksRunning(sessionId).length === 0
    if (!quiet() || this.host.closing) return
    const timer = setTimeout(() => {
      this.settling.delete(sessionId)
      if (!quiet() || this.host.closing) return
      console.error(stamped(`[links] ${sessionId}: its background work ended and no turn followed; reporting the work as ended`))
      this.settle(sessionId, wait)
    }, OWN_WORK_SETTLE_MS)
    timer.unref?.()
    this.settling.set(sessionId, timer)
  }

  /** The paused work ended with no turn after it: the report goes out with how each task ended */
  private settle(sessionId: string, wait: LinkedReport): void {
    // As a turn's end (#1038 review): another's work is reported to nobody; one the hub cannot tell yet waits again
    const gate = this.gate(sessionId)
    if (gate === 'defer') return this.settleLater(sessionId, wait)
    if (gate === 'withhold') return this.drop(sessionId)
    const settled = this.pausedTasksNow(sessionId, wait)
    this.drop(sessionId)
    void this.report(sessionId, wait.assistantId, { type: 'turn_complete' }, { settled }, undefined, undefined, wait.lastBy === 'person')
  }

  private stopSettling(sessionId: string): void {
    const timer = this.settling.get(sessionId)
    if (timer) clearTimeout(timer)
    this.settling.delete(sessionId)
  }

  private drop(sessionId: string): void {
    this.stopSettling(sessionId)
    this.host.children.dropLinkedReport(sessionId)
    this.about.delete(sessionId)
  }

  private forget(sessionId: string): void {
    this.tasks.delete(sessionId)
    this.changedAt.delete(sessionId)
  }

  private remember(sessionId: string): void {
    const about = this.host.linkedReader?.describe(sessionId)
    if (about) this.about.set(sessionId, about)
  }

  /**
   * A machine whose link is no longer connected: its events stop reaching the hub, so the work's end would never be
   * seen. A report paused over that work goes out now, saying so (as an ask's wait does, `observeLinkLoss`); one whose
   * work had already ended, waiting only for a turn to follow, goes out as settled. What the hub knew of the machine's
   * work is dropped: it may change unseen, and is read whole again when the link is back (`resync`). A turn in progress
   * keeps its wait: its end may still be seen when the link is back.
   */
  private linkChanged(machine: unknown): void {
    const m = machine as { id?: unknown; name?: unknown; status?: unknown } | null
    if (!m || typeof m.id !== 'string') return
    const name = typeof m.name === 'string' && m.name ? m.name : m.id
    this.machineNames.set(m.id, name)
    if (m.status === 'connected') return
    const prefix = `${m.id}.`
    for (const [sessionId, wait] of [...this.host.children.linkedReports]) {
      if (!sessionId.startsWith(prefix) || !wait.paused) continue
      if (this.settling.has(sessionId)) {
        this.settle(sessionId, wait)
        continue
      }
      const keeps = this.host.keepsOverLoss?.(sessionId) ?? null
      if (keeps) {
        // The turn it ran is out of sight now: its end is read when the link is back (`resync`), not waited for. One an update continues there stays the work's
        if (keeps === 'turn') continue
        wait.busy = false
        delete wait.turn
        continue
      }
      this.drop(sessionId)
      void this.report(sessionId, wait.assistantId, { type: 'turn_complete' }, { linkLost: name, paused: wait.paused }, undefined, undefined, false, wait)
    }
    for (const sessionId of [...this.tasks.keys()]) if (sessionId.startsWith(prefix)) this.forget(sessionId)
  }

  /**
   * A machine's link came up (its first, or again after a drop or the hub's start), or the machine was removed. A machine
   * resends its work only when it changes, so the hub reads every session's list whole now; a change relayed while
   * that read was out is newer and kept. A removed machine's waits will never end: each is reported, saying so.
   */
  private resync(machineId: unknown): void {
    const reader = this.host.linkedReader
    if (!reader || typeof machineId !== 'string') return
    if (!reader.machineLinked(machineId)) return this.removed(machineId)
    const asked = ++this.clock
    void reader.backgroundTasks(machineId).then((rows) => {
      if (!rows) return
      const prefix = `${machineId}.`
      const listed = new Set(rows.map((r) => r.sessionId))
      for (const id of [...this.tasks.keys()]) if (id.startsWith(prefix) && !listed.has(id) && (this.changedAt.get(id) ?? 0) < asked) this.forget(id)
      for (const row of rows) {
        if ((this.changedAt.get(row.sessionId) ?? 0) > asked) continue
        this.tasks.set(row.sessionId, row.tasks)
        this.changedAt.set(row.sessionId, ++this.clock)
        const wait = this.host.children.linkedReports.get(row.sessionId)
        if (wait?.paused) this.settleLater(row.sessionId, wait)
      }
    }, () => {})
  }

  private removed(machineId: string): void {
    const prefix = `${machineId}.`
    const name = this.machineNames.get(machineId) ?? machineId
    for (const [sessionId, wait] of [...this.host.children.linkedReports]) {
      if (!sessionId.startsWith(prefix)) continue
      const about = this.about.get(sessionId)
      this.drop(sessionId)
      void this.report(sessionId, wait.assistantId, { type: 'turn_complete' }, { machineRemoved: name, ...(wait.paused ? { paused: wait.paused } : {}) }, about, undefined, false, wait)
    }
    for (const sessionId of [...this.tasks.keys()]) if (sessionId.startsWith(prefix)) this.forget(sessionId)
    this.machineNames.delete(machineId)
  }

  private async report(
    sessionId: string,
    assistantId: string,
    ending: { type: string; error?: { message?: string }; turn?: unknown },
    work?: ReportWork,
    known?: { name: string; project: string },
    /** The person's part in the turn reported (#1377) */
    part?: ReportPart,
    /** The session's last turn was the person's (#1377): its last response is not the work's to report */
    theirs = false,
    /**
     * The wait the report is for. The pause's report leaves the words it read on it (`LinkedReport.read`); the report a lost link or a removed machine
     * sends instead of the work's end takes them from it, so they are that one pause's, for that asker, and die with the wait (`drop`)
     */
    wait?: LinkedReport,
    /** A pause's update (#1540): the later turn it is of, which goes only if `isPauseUpdate` says so of it and its words */
    later?: LaterTurn,
  ): Promise<void> {
    const reader = this.host.linkedReader
    if (!reader || !this.host.hasSession(assistantId)) return
    const about = reader.describe(sessionId) ?? known ?? this.about.get(sessionId) ?? { name: sessionId, project: '(unknown)' }
    // A machine that cannot be reached cannot be read: its last answer went with the paused report, which says so
    const unreachable = work && ('linkLost' in work || 'machineRemoved' in work)
    // What its pause's report read stands in for the words that cannot be read now, marked as read then; a turn still running has said nothing yet
    const kept = unreachable && work && 'paused' in work && work.paused ? wait?.read : undefined
    // Words of the turn go only through the gate (#1038 review); a report that the link or the machine went says no words
    if (!unreachable && this.gate(sessionId) !== 'deliver') return
    /*
     * A read that failed says so (#1186): an empty preview read as a turn that said nothing. A machine that could not
     * be reached says that, or where its last words were
     */
    const since = turnSince(ending)
    const words = unreachable || theirs ? null : await reader.lastWords(sessionId, 600, { turn: true, ...(since !== undefined ? { since } : {}) }).catch((e: Error) => ({ ok: false as const, error: e.message }))
    const preview =
      theirs ? "(not read: the last turn there was the person's; read_session shows it)"
      : !words ? (kept ? clipPreview(kept.preview, 600) : work && 'paused' in work && work.paused ? IN_PAUSE_REPORT : MACHINE_UNREACHABLE)
      // A turn that ended with nothing to say says so, rather than a preview that reads as an unread one (#1604)
      : words.ok ? (words.text === '' ? NO_WORDS : words.text)
      : `(its last response could not be read there: ${words.error})`
    // A pause's update is the turn's new answer (#1540): a turn that said nothing there, or could not be read, tells nothing
    if (later && !isPauseUpdate(later, words?.ok ? words.text : '')) return
    if (wait && words?.ok && words.text !== '' && work && 'paused' in work && 'stoppable' in work) wait.read = { preview: words.text, seq: words.seq ?? undefined }
    const seq = words?.ok ? (words.seq ?? undefined) : kept?.seq
    await this.host.deliverReport(assistantId, sessionId, about.name, about.project, preview, ending as Pick<NormalizedEvent, 'type'>, kept && unreachable ? { ...work, asRead: true } : work, seq, part)
  }
}
