import { applyBackgroundTasks, liveBackgroundTasks, type BackgroundTask, type NormalizedEvent } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { HUB_SENDER } from './hub-sender.js'
import { linkedTurnEnd } from './linked-turn-end.js'
import { PAUSED_REPORT_SETTLE_MS, type ChildOwnership, type LinkedReport } from './child-ownership.js'

/** The work a report is about, as `deliverReport` words its first line (#721, #723) */
export type ReportWork =
  | { paused: readonly BackgroundTask[]; stoppable: boolean }
  | { settled: readonly BackgroundTask[] }
  | { linkLost: string; paused: readonly BackgroundTask[] }
  /** The machine was removed from Centralu: `paused`, the work its turn ended with; absent, a turn still running */
  | { machineRemoved: string; paused?: readonly BackgroundTask[] }
  /** Its turn ended while the host was handed over (#1186): whether that turn was the work given is not known */
  | { swapped: true }

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
  ): Promise<void>
  /**
   * Whether a report about this session may go now (#1038 review): a child start_agent started on a linked machine
   * answers by whose its turn is (`RemoteAgents.reportGate`): its caller's goes, another's (the person's on that
   * machine) is reported to nobody, and one the hub cannot tell yet stays owed until it can. Any other session's goes
   */
  reportGate?(sessionId: string): 'deliver' | 'withhold' | 'defer'
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
      if (e.type === 'user_message' && e.text === wait.instruction && fromHub(e.from)) delete wait.instruction
      return
    }
    const step = linkedTurnEnd(wait.busy, e)
    if (step?.step === 'busy') {
      wait.busy = true
      // A turn runs: its own end reports
      this.stopSettling(sessionId)
      return
    }
    if (step?.step !== 'completed' && step?.step !== 'failed') return
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
      if (!told) void this.report(sessionId, wait.orchestratorId, e, { paused: running, stoppable: false })
      return
    }
    this.drop(sessionId)
    void this.report(sessionId, wait.orchestratorId, e)
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

  /** The paused work ended with no turn after it: the report goes out with how each task ended */
  private settle(sessionId: string, wait: LinkedReport): void {
    // As a turn's end (#1038 review): another's work is reported to nobody; one the hub cannot tell yet waits again
    const gate = this.gate(sessionId)
    if (gate === 'defer') return this.settleLater(sessionId, wait)
    if (gate === 'withhold') return this.drop(sessionId)
    const settled = this.pausedTasksNow(sessionId, wait)
    this.drop(sessionId)
    void this.report(sessionId, wait.orchestratorId, { type: 'turn_complete' }, { settled })
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
    ending: { type: string; error?: { message?: string } },
    work?: ReportWork,
    known?: { name: string; project: string },
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
    const words = unreachable ? null : await reader.lastWords(sessionId, 600).catch((e: Error) => ({ ok: false as const, error: e.message }))
    const preview =
      !words ? (work && 'paused' in work && work.paused ? '(in the paused report before this one)' : '(not read: its machine could not be reached)')
      : words.ok ? words.text
      : `(its last response could not be read there: ${words.error})`
    const seq = words?.ok && words.seq !== null ? words.seq : undefined
    await this.host.deliverReport(orchestratorId, sessionId, about.name, about.project, preview, ending as Pick<NormalizedEvent, 'type'>, work, seq)
  }
}
