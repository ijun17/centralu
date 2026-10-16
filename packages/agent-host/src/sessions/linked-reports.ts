import { applyBackgroundTasks, liveBackgroundTasks, type BackgroundTask, type NormalizedEvent } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { PAUSED_REPORT_SETTLE_MS, type ChildOwnership, type LinkedReport } from './child-ownership.js'

/** The work a report is about, as `deliverReport` words its first line (#721, #723) */
export type ReportWork =
  | { paused: readonly BackgroundTask[]; stoppable: boolean }
  | { settled: readonly BackgroundTask[] }
  | { linkLost: string; paused: readonly BackgroundTask[] }

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
  ): Promise<void>
}

/** A machine's event as the hub relays it to its windows (qualified, links.ts): only the fields read here */
export type LinkedEvent = {
  type: string
  sessionId?: unknown
  state?: unknown
  error?: { message?: string }
  machine?: unknown
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
 * first, it goes out saying so, since the hub would not see the work's end.
 */
export class LinkedReports {
  /**
   * Each linked session's background work, as its machine last listed it (`background_tasks`, which replaces the live
   * set each time). Kept for every session a machine relays, so work started before the orchestrator asked is known
   */
  private readonly tasks = new Map<string, BackgroundTask[]>()
  /** A paused report's wait for the turn the work's end may start, by qualified session id */
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly host: LinkedReportsHost) {}

  observe(e: LinkedEvent): void {
    if (e.type === 'machine_status') return this.linkChanged(e.machine)
    if (typeof e.sessionId !== 'string') return
    const sessionId = e.sessionId
    if (e.type === 'background_tasks' && Array.isArray(e.live)) {
      this.tasks.set(sessionId, applyBackgroundTasks(this.tasks.get(sessionId) ?? [], {
        live: e.live as BackgroundTask[],
        ...(Array.isArray(e.ended) ? { ended: e.ended as BackgroundTask[] } : {}),
        ...(e.clearEnded === true ? { clearEnded: true } : {}),
      }))
    }
    if (e.type === 'session_deleted') this.tasks.delete(sessionId)
    const wait = this.host.children.linkedReports.get(sessionId)
    if (!wait) return
    if (e.type === 'background_tasks') {
      if (wait.paused) this.settleLater(sessionId, wait)
      return
    }
    const busy = e.state === 'working' || e.state === 'waiting_approval'
    if (e.type === 'message_delta' || e.type === 'tool_call' || e.type === 'approval_request' || (e.type === 'state_change' && busy)) {
      wait.busy = true
      // A turn runs: its own end reports
      this.stopSettling(sessionId)
      return
    }
    const ended =
      e.type === 'turn_complete' || e.type === 'error' || e.type === 'limit_reached' || (e.type === 'state_change' && wait.busy && !busy)
    if (!ended) return
    // Only a turn that completed is paused: a failed or stopped one is reported as it ended (#698)
    const running = e.type === 'turn_complete' ? this.ownTasksRunning(sessionId) : []
    if (running.length) {
      const told = !!wait.paused
      const held = wait.paused ?? []
      wait.paused = [...held, ...running.filter((t) => !held.some((h) => h.id === t.id))]
      // A state the machine reports before the next turn starts is not that turn's end
      wait.busy = false
      if (!told) void this.report(sessionId, wait.orchestratorId, e, { paused: running, stoppable: false })
      return
    }
    this.drop(sessionId)
    void this.report(sessionId, wait.orchestratorId, e)
  }

  /** Every settle wait ends with the host: the next host has no linked report to settle (they live in memory) */
  dispose(): void {
    for (const timer of this.settling.values()) clearTimeout(timer)
    this.settling.clear()
  }

  /** The session's own background work its machine lists as running; a timer the tool holds is not work (#721) */
  private ownTasksRunning(sessionId: string): BackgroundTask[] {
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
      const settled = this.pausedTasksNow(sessionId, wait)
      this.drop(sessionId)
      void this.report(sessionId, wait.orchestratorId, { type: 'turn_complete' }, { settled })
    }, PAUSED_REPORT_SETTLE_MS)
    timer.unref?.()
    this.settling.set(sessionId, timer)
  }

  private stopSettling(sessionId: string): void {
    const timer = this.settling.get(sessionId)
    if (timer) clearTimeout(timer)
    this.settling.delete(sessionId)
  }

  private drop(sessionId: string): void {
    this.stopSettling(sessionId)
    this.host.children.dropLinkedReport(sessionId)
  }

  /**
   * A machine whose link is no longer connected: its events stop reaching the hub, so the work's end would never be
   * seen. A report paused over that work goes out now, saying so (as an ask's wait does, `observeLinkLoss`). What the
   * hub knew of the machine's work is dropped: it may change unseen, and work wrongly held running would hold the next
   * report for good. A turn in progress keeps its wait: its end may still be seen when the link is back.
   */
  private linkChanged(machine: unknown): void {
    const m = machine as { id?: unknown; name?: unknown; status?: unknown } | null
    if (!m || typeof m.id !== 'string' || m.status === 'connected') return
    const prefix = `${m.id}.`
    const name = typeof m.name === 'string' && m.name ? m.name : m.id
    for (const sessionId of [...this.tasks.keys()]) if (sessionId.startsWith(prefix)) this.tasks.delete(sessionId)
    for (const [sessionId, wait] of [...this.host.children.linkedReports]) {
      if (!sessionId.startsWith(prefix) || !wait.paused) continue
      this.drop(sessionId)
      void this.report(sessionId, wait.orchestratorId, { type: 'turn_complete' }, { linkLost: name, paused: wait.paused })
    }
  }

  private async report(sessionId: string, orchestratorId: string, ending: { type: string; error?: { message?: string } }, work?: ReportWork): Promise<void> {
    const reader = this.host.linkedReader
    if (!reader || !this.host.hasSession(orchestratorId)) return
    const about = reader.describe(sessionId) ?? { name: sessionId, project: '(unknown)' }
    // A machine whose link dropped cannot be read: its last answer went with the paused report, which says so
    const preview = work && 'linkLost' in work ? '(in the paused report before this one)' : await reader.lastWords(sessionId, 600).catch(() => '')
    await this.host.deliverReport(orchestratorId, sessionId, about.name, about.project, preview, ending as Pick<NormalizedEvent, 'type'>, work)
  }
}
