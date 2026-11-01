import { applyBackgroundTasks, liveBackgroundTasks, type BackgroundTask, type NormalizedEvent } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { HUB_SENDER } from './hub-sender.js'
import { linkedTurnEnd, turnSince } from './linked-turn-end.js'
import { PAUSED_REPORT_SETTLE_MS, type ChildOwnership, type LinkedReport, type TurnStarter } from './child-ownership.js'
import { NO_WORDS } from './ask-project.js'

/** The work a report is about, as `deliverReport` words its first line (#721, #723) */
export type ReportWork =
  | { paused: readonly BackgroundTask[]; stoppable: boolean }
  | { settled: readonly BackgroundTask[] }
  | { linkLost: string; paused: readonly BackgroundTask[] }
  /** The machine was removed from Centralu: `paused`, the work its turn ended with; absent, a turn still running */
  | { machineRemoved: string; paused?: readonly BackgroundTask[] }
  /** Its turn ended while the host was handed over (#1186): whether that turn was the work given is not known */
  | { swapped: true }
  /** The person wrote to the session on its machine while the report was paused (#1342): its later turns are theirs */
  | { tookOver: true; paused: readonly BackgroundTask[] }
  /** Its turn ended while threads it handed on are still going (§6): the work is paused on them, and the report stays owed */
  | { waitingOn: number }
  /**
   * An update of Centralu on its machine cut its turn, and the next host continued it (#1618): not its end. `owed`: the report
   * is still owed, and the continued turn's end is it
   */
  | { resumed: true; owed: boolean }

/**
 * What the linked machines' reports reach (#428): the manager's members they read, with getters for its fields, so
 * each is read when used, never kept.
 */
export type LinkedReportsHost = {
  readonly children: ChildOwnership
  readonly linkedReader: LinkedSessions | null
  /** Whether the session is still this host's: the orchestrator a report goes to may have been deleted */
  hasSession(sessionId: string): boolean
  /** Shutting down or handing over: a report a wait would send now is the next host's, or nobody's */
  readonly closing: boolean
  deliverReport(
    orchestratorId: string,
    sessionId: string,
    name: string,
    project: string,
    preview: string,
    ending: Pick<NormalizedEvent, 'type'> & { error?: { message?: string } },
    work?: ReportWork,
    answerSeq?: number,
    part?: { wrote?: true; added?: true },
  ): Promise<void>
  /**
   * Whether a report about this session may go now (#1038 review): a child start_agent started on a linked machine
   * answers by whose its turn is (`RemoteAgents.reportGate`): its caller's goes, another's (the person's on that
   * machine) is reported to nobody, and one the hub cannot tell yet stays owed until it can. Any other session's goes
   */
  reportGate?(sessionId: string): 'deliver' | 'withhold' | 'defer'
}

/** How long the hub's own note of "Add to the task" waits for the message it is about to be relayed (#1377) */
const ADD_NEXT_MS = 15_000

/** What a report says of the person's part in a turn (#1377): nothing, unless they wrote into it or added to the task */
function partOf(turn: { wrote?: true; added?: true }): { wrote?: true; added?: true } | undefined {
  return turn.wrote || turn.added ? { ...(turn.wrote ? { wrote: true as const } : {}), ...(turn.added ? { added: true as const } : {}) } : undefined
}

/** Whose the turn was, as the machine's host said it on the event that ended it (#1377); undefined from a host that does not say */
function saidTurn(raw: unknown): TurnStarter | undefined {
  if (typeof raw !== 'object' || raw === null || !('by' in raw) || (raw.by !== 'person' && raw.by !== 'work')) return undefined
  return { by: raw.by, ...('wrote' in raw && raw.wrote === true ? { wrote: true as const } : {}), ...('added' in raw && raw.added === true ? { added: true as const } : {}) }
}

/** Whether a relayed message was sent by this hub's orchestrator: the machine records it as from `HUB_SENDER`, qualified */
function fromHub(from: unknown): boolean {
  const id = (from as { sessionId?: unknown } | null)?.sessionId
  return typeof id === 'string' && id.endsWith(`.${HUB_SENDER}`)
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
  /** The person's choice for a report the session owes (`user_message`, #1377) */
  intent?: unknown
  /** Whose the turn was, on the event that ends it (#1377) */
  turn?: unknown
  /** The message a turn ran for, on the `state_change` that opens it, when the tool ran it after the turn it was sent into (#1604) */
  origin?: unknown
  /** An app's message (`user_message`): not the person's */
  fromApp?: unknown
  live?: unknown
  ended?: unknown
  clearEnded?: unknown
}

/**
 * The orchestrator's reports from a linked machine's sessions (#82 phase 4, `reportBack` on `send_to_session`), and
 * the work a session there ends its turn with (#723).
 *
 * The end of a turn the orchestrator waits on is its report, once, as `reportBackIfAwaited` does for this host's own
 * sessions. A turn that **completes** while the session's own background work still runs there (the machine's
 * `background_tasks`, timers left out) is a pause, by the same rules as here (#721): the orchestrator is told once that
 * the work paused, and the report stays owed until a turn ends with none of that work left. If the work ends and no turn
 * follows within `PAUSED_REPORT_SETTLE_MS`, the report goes out with how each task ended; if the machine's link drops
 * or the machine is removed first, it goes out saying so, since the hub would not see the work's end.
 */
export class LinkedReports {
  /**
   * Each linked session's background work, as its machine last listed it: read whole from `sessions.list` each time the
   * link comes up (`machine_resync`), and changed by the relayed `background_tasks` (which replace the live set). Kept
   * for every session a machine relays, so work started before the orchestrator asked is known
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
     * A turn belongs to whoever started it (#1377), as a local one does (`ChildOwnership.noteMessage`): the person's
     * message at rest makes the next turn theirs, and it is not reported; into the work's turn it is noted. Only their
     * choice to take the session over closes the report.
     */
    if (e.type === 'user_message' && wait.instruction === undefined && this.messageSeen(sessionId, wait, e)) return
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
     * relayed) is not waited for past the send's answer (`sendToSession`, orchestrator-seat.ts).
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
      wait.busy = true
      wait.turn = wait.next ?? { by: 'work' }
      delete wait.next
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
    if (gate === 'defer') return
    if (gate === 'withhold') return this.drop(sessionId)
    // Only a turn that completed is paused: a failed or stopped one is reported as it ended (#698)
    const running = e.type === 'turn_complete' ? this.ownTasksRunning(sessionId) : []
    if (running.length) {
      const told = !!wait.paused
      const held = wait.paused ?? []
      wait.paused = [...held, ...running.filter((t) => !held.some((h) => h.id === t.id))]
      // A state the machine reports before the next turn starts is not that turn's end
      wait.busy = false
      // Changed in place: set again, so what keeps it stored reads the pause (#1038)
      this.host.children.setLinkedReport(sessionId, wait)
      if (!told) void this.report(sessionId, wait.orchestratorId, e, { paused: running, stoppable: false }, undefined, partOf(turn))
      return
    }
    this.drop(sessionId)
    void this.report(sessionId, wait.orchestratorId, e, undefined, undefined, partOf(turn))
  }

  /**
   * An ask_project task's turn there ended (#1457) with the session's own background work still running: the asker is
   * owed the work's last turn end, as the orchestrator is for a `reportBack` send (#723). The call that asked answers with
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
    if ((held && held.orchestratorId !== callerId) || this.gate(sessionId) !== 'deliver') return []
    this.stopSettling(sessionId)
    this.remember(sessionId)
    this.host.children.setLinkedReport(sessionId, { orchestratorId: callerId, busy: false, paused: [...running] })
    return running
  }

  /**
   * The asker's new task replaces the report it was owed for its earlier one (#721: new work from the same caller ends
   * the pause, and that run's own wait tells its end). Returns what puts the report back, for a send that fails; none when
   * the session owes the asker no paused report.
   */
  releaseAsker(sessionId: string, callerId: string): (() => void) | undefined {
    const held = this.host.children.linkedReports.get(sessionId)
    if (!held?.paused || held.orchestratorId !== callerId) return undefined
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
   * joins it, noted when it is the person's into the work's. The person's choice rides on it (`intent`): `takeover` closes
   * the report (`tookOver`), `task` adds it to the work. Returns whether the event is settled here.
   */
  private messageSeen(sessionId: string, wait: LinkedReport, e: LinkedEvent): boolean {
    const person = !e.from && !e.fromApp
    // A takeover the gate does not let through (not yet told whose the turn is) is only a message of the person's
    if (person && e.intent === 'takeover' && this.tookOver(sessionId, wait)) return true
    // The choice rides on the relayed message from a machine that echoes it; the hub also noted it as the call went out
    const added = person && (e.intent === 'task' || (wait.addNext !== undefined && Date.now() - wait.addNext < ADD_NEXT_MS))
    if (person) delete wait.addNext
    if (wait.busy) {
      const running = wait.turn ?? { by: 'work' as const }
      wait.turn = running
      if (person && running.by === 'work') running[added ? 'added' : 'wrote'] = true
    } else if (wait.next) {
      if (person && wait.next.by === 'work') wait.next[added ? 'added' : 'wrote'] = true
    } else {
      wait.next = added ? { by: 'work', added: true } : { by: person ? 'person' : 'work' }
    }
    return false
  }

  /**
   * A report `send_to_session` put back after its send failed (orchestrator-seat.ts): the events of the send's moment
   * went to the wait that send had set, so a paused report's settle wait starts again from what the hub knows now
   */
  restored(sessionId: string): void {
    const wait = this.host.children.linkedReports.get(sessionId)
    if (wait?.paused) this.settleLater(sessionId, wait)
  }

  /**
   * Every settle wait ends with the host. The next host settles only what a child start_agent started on a linked
   * machine is still owed (`RemoteAgents.restore`, #1038); the orchestrator's linked reports live in memory
   */
  dispose(): void {
    for (const timer of this.settling.values()) clearTimeout(timer)
    this.settling.clear()
  }

  private gate(sessionId: string): 'deliver' | 'withhold' | 'defer' {
    return this.host.reportGate?.(sessionId) ?? 'deliver'
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
   * none starts within `PAUSED_REPORT_SETTLE_MS` the report goes out as the work's end. Each change of the work starts
   * the wait again.
   */
  private settleLater(sessionId: string, wait: LinkedReport): void {
    this.stopSettling(sessionId)
    const quiet = () => this.host.children.linkedReports.get(sessionId) === wait && !wait.busy && this.ownTasksRunning(sessionId).length === 0
    if (!quiet() || this.host.closing) return
    const timer = setTimeout(() => {
      this.settling.delete(sessionId)
      if (!quiet() || this.host.closing) return
      console.error(`[links] ${sessionId}: its background work ended and no turn followed; reporting the work as ended`)
      this.settle(sessionId, wait)
    }, PAUSED_REPORT_SETTLE_MS)
    timer.unref?.()
    this.settling.set(sessionId, timer)
  }

  /**
   * The person wrote to the session there while its report was paused (#1342): the wait ends, the orchestrator is told
   * once, and none of the session's later turns is reported to it. Only where the report may go now (`gate`): a child
   * start_agent started has its own rule for the person's turns (`RemoteAgents`, which reads the event first)
   */
  private tookOver(sessionId: string, wait: LinkedReport): boolean {
    if (this.gate(sessionId) !== 'deliver') return false
    const paused = this.pausedTasksNow(sessionId, wait)
    const known = this.about.get(sessionId)
    this.drop(sessionId)
    void this.report(sessionId, wait.orchestratorId, { type: 'turn_complete' }, { tookOver: true, paused }, known)
    return true
  }

  /**
   * The person's choice for the message a call to a linked machine's session carries (#1377). The hub routes the call, so
   * it knows the choice before the machine does and does not depend on the machine echoing it: an older host strips the
   * field it does not know, and the choice would silently become "Just asking". Returns what to do when the call ends:
   * "Take it over" closes the wait once the machine took the message, "Add to the task" is dropped if it did not.
   */
  choosing(sessionId: string, intent: unknown): ((delivered: boolean) => void) | undefined {
    if (intent !== 'task' && intent !== 'takeover') return undefined
    const wait = this.host.children.linkedReports.get(sessionId)
    if (!wait) return undefined
    if (intent === 'task') {
      const at = Date.now()
      wait.addNext = at
      return (delivered) => {
        if (!delivered && wait.addNext === at) delete wait.addNext
      }
    }
    return (delivered) => {
      if (delivered && this.host.children.linkedReports.get(sessionId) === wait) this.tookOver(sessionId, wait)
    }
  }

  /** The paused work ended with no turn after it: the report goes out with how each task ended */
  private settle(sessionId: string, wait: LinkedReport): void {
    // As a turn's end (#1038 review): another's work is reported to nobody; one the hub cannot tell yet waits again
    const gate = this.gate(sessionId)
    if (gate === 'defer') return this.settleLater(sessionId, wait)
    if (gate === 'withhold') return this.drop(sessionId)
    const settled = this.pausedTasksNow(sessionId, wait)
    this.drop(sessionId)
    void this.report(sessionId, wait.orchestratorId, { type: 'turn_complete' }, { settled }, undefined, undefined, wait.lastBy === 'person')
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
      this.drop(sessionId)
      void this.report(sessionId, wait.orchestratorId, { type: 'turn_complete' }, { linkLost: name, paused: wait.paused })
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
      void this.report(sessionId, wait.orchestratorId, { type: 'turn_complete' }, { machineRemoved: name, ...(wait.paused ? { paused: wait.paused } : {}) }, about)
    }
    for (const sessionId of [...this.tasks.keys()]) if (sessionId.startsWith(prefix)) this.forget(sessionId)
    this.machineNames.delete(machineId)
  }

  private async report(
    sessionId: string,
    orchestratorId: string,
    ending: { type: string; error?: { message?: string }; turn?: unknown },
    work?: ReportWork,
    known?: { name: string; project: string },
    /** The person's part in the turn reported (#1377) */
    part?: { wrote?: true; added?: true },
    /** The session's last turn was the person's (#1377): its last response is not the work's to report */
    theirs = false,
  ): Promise<void> {
    const reader = this.host.linkedReader
    if (!reader || !this.host.hasSession(orchestratorId)) return
    const about = reader.describe(sessionId) ?? known ?? this.about.get(sessionId) ?? { name: sessionId, project: '(unknown)' }
    // A machine that cannot be reached cannot be read: its last answer went with the paused report, which says so
    const unreachable = work && ('linkLost' in work || 'machineRemoved' in work)
    // Words of the turn go only through the gate (#1038 review); a report that the link or the machine went says no words
    if (!unreachable && this.gate(sessionId) !== 'deliver') return
    /*
     * A read that failed says so (#1186): an empty preview read as a turn that said nothing. A machine that could not
     * be reached says that, or where its last words were
     */
    // Nor its words once the person has taken it over: what is there now is not the assigned work's
    const tookOver = (!!work && 'tookOver' in work) || theirs
    const since = turnSince(ending)
    const words = unreachable || tookOver ? null : await reader.lastWords(sessionId, 600, { turn: true, ...(since !== undefined ? { since } : {}) }).catch((e: Error) => ({ ok: false as const, error: e.message }))
    const preview =
      theirs && !(work && 'tookOver' in work) ? "(not read: the last turn there was the person's; read_session shows it)"
      : tookOver ? "(not read: the conversation there is the person's now; read_session shows it)"
      : !words ? (work && 'paused' in work && work.paused ? '(in the paused report before this one)' : '(not read: its machine could not be reached)')
      // A turn that ended with nothing to say says so, rather than a preview that reads as an unread one (#1604)
      : words.ok ? (words.text === '' ? NO_WORDS : words.text)
      : `(its last response could not be read there: ${words.error})`
    const seq = words?.ok && words.seq !== null ? words.seq : undefined
    await this.host.deliverReport(orchestratorId, sessionId, about.name, about.project, preview, ending as Pick<NormalizedEvent, 'type'>, work, seq, part)
  }
}
