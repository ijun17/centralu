import { applyBackgroundTasks, type BackgroundTask } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'

/** What the linked machines' work mirror reaches (#428): the manager's reader, with a getter, so it is read when used, never kept */
export type LinkedReportsHost = {
  readonly linkedReader: LinkedSessions | null
}

/** A machine's event as the hub relays it to its windows (qualified, links.ts): only the fields read here and by `RemoteAgents.observe` */
export type LinkedEvent = {
  type: string
  sessionId?: unknown
  machine?: unknown
  machineId?: unknown
  live?: unknown
  ended?: unknown
  clearEnded?: unknown
}

/**
 * Each linked machine's session's own background work, as its machine lists it (#723): what agent_session list and an ask_project answer read of a
 * session there (`agentLook`, a pause). Its reports are that machine's, by mail (#1948 step 6). The machine resends its work only when it changes, so
 * the list is read whole each time the link comes up, and dropped while it is down, when it may change unseen
 */
export class LinkedReports {
  /**
   * Each linked session's background work, as its machine last listed it: read whole from `sessions.list` each time the
   * link comes up (`machine_resync`), and changed by the relayed `background_tasks` (which replace the live set)
   */
  private readonly tasks = new Map<string, BackgroundTask[]>()
  /** When each session's list last changed, on `clock`: a machine's list read before that change does not undo it */
  private readonly changedAt = new Map<string, number>()
  private clock = 0

  constructor(private readonly host: LinkedReportsHost) {}

  observe(e: LinkedEvent): void {
    if (e.type === 'machine_status') return this.linkChanged(e.machine)
    if (e.type === 'machine_resync') return this.resync(e.machineId)
    if (typeof e.sessionId !== 'string') return
    if (e.type === 'session_deleted') return this.forget(e.sessionId)
    if (e.type !== 'background_tasks' || !Array.isArray(e.live)) return
    this.tasks.set(e.sessionId, applyBackgroundTasks(this.tasks.get(e.sessionId) ?? [], {
      live: e.live as BackgroundTask[],
      ...(Array.isArray(e.ended) ? { ended: e.ended as BackgroundTask[] } : {}),
      ...(e.clearEnded === true ? { clearEnded: true } : {}),
    }))
    this.changedAt.set(e.sessionId, ++this.clock)
  }

  /** Each linked session's background work as its machine last listed it */
  tasksOf(sessionId: string): readonly BackgroundTask[] {
    return this.tasks.get(sessionId) ?? []
  }

  private forget(sessionId: string): void {
    this.tasks.delete(sessionId)
    this.changedAt.delete(sessionId)
  }

  /** A machine whose link is no longer connected: what the hub knew of its work may change unseen, and is read whole again when the link is back */
  private linkChanged(machine: unknown): void {
    const m = machine as { id?: unknown; status?: unknown } | null
    if (!m || typeof m.id !== 'string' || m.status === 'connected') return
    this.forgetMachine(m.id)
  }

  /**
   * A machine's link came up (its first, or again after a drop or the hub's start), or the machine was removed. A machine
   * resends its work only when it changes, so the hub reads every session's list whole now; a change relayed while
   * that read was out is newer and kept
   */
  private resync(machineId: unknown): void {
    const reader = this.host.linkedReader
    if (!reader || typeof machineId !== 'string') return
    if (!reader.machineLinked(machineId)) return this.forgetMachine(machineId)
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
      }
    }, () => {})
  }

  private forgetMachine(machineId: string): void {
    for (const sessionId of [...this.tasks.keys()]) if (sessionId.startsWith(`${machineId}.`)) this.forget(sessionId)
  }
}
