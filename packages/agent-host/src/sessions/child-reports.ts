import type { BackgroundTask, NormalizedEvent, SessionInfo } from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
  liveBackgroundTasks,
} from '@cc/protocol'
import { inTurn } from '../idle.js'
import { errorKind } from './error-kind.js'
import { PAUSED_REPORT_SETTLE_MS } from './child-ownership.js'
import { type DelegationHost, taskList } from './delegation-flow.js'
import type { ReportWork } from './linked-reports.js'
import type { QueuedRequestsHost } from './queued-requests.js'
import type { RestartHost } from './restart-policy.js'
import { labelOf, previewOf } from './transcript-view.js'
import { clipPreview, lastResponseSeq } from './turn-answer.js'
import { cleanUpLine } from './tool-answers.js'
import { namedCall } from './tool-seats.js'
import type { RoutedCardsHost } from './routed-cards.js'
import { agentState, cleanUpDue, ownAgents } from './own-agents.js'

/**
 * How a report's first line names the session's own background work and its machine. The stored report names them
 * (`STORED`); what reaches the model only counts the tasks and says "its machine" (`FOR_MODEL`, #1186): a task's
 * description is the session's own words, and a name can carry a line of its own, so neither goes in (#120)
 */
type Naming = { tasks: (tasks: readonly BackgroundTask[], status?: boolean) => string; machine: (machine: string) => string }
const STORED: Naming = { tasks: taskList, machine: (m) => frameField(m) }
const FOR_MODEL: Naming = {
  tasks: (tasks, status) => {
    const n = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`
    if (!status) return n
    const done = tasks.filter((t) => t.status === 'completed').length
    return done === tasks.length ? `${n}, all completed` : `${n}, ${done} completed`
  },
  machine: () => 'its machine',
}

/** The first line of a report held over the session's own background work (#721) */
function pausedReportLine(running: readonly BackgroundTask[], stop: string | undefined, name: Naming = STORED): string {
  return (
    `[Centralu] The assigned work paused: its turn ended while its own background work is still running (${name.tasks(running)}). ` +
    'If that work is a server or watcher it leaves running, the answer below may be its final one. ' +
    'A final report follows only if that work ends' +
    (stop ? `; ${stop} on it stops that work and ends the wait.\n` : '.\n')
  )
}
/**
 * The first line of a linked machine's paused report whose link dropped before the work ended (#723): the hub cannot see
 * that end, so the report goes out now
 */
function linkLostReportLine(machine: string, paused: readonly BackgroundTask[], name: Naming = STORED): string {
  return (
    `[Centralu] The assigned work paused on its own background work (${name.tasks(paused)}), and the link to ${name.machine(machine)} dropped before that work ended, ` +
    'so its end will not be reported. It may still be running there; read the session once the link is back.\n'
  )
}
/** The first line of a linked machine's report whose machine was removed before the work ended (#723) */
function machineRemovedReportLine(machine: string, paused: readonly BackgroundTask[] | undefined, name: Naming = STORED): string {
  const which = name === STORED ? `its machine ${name.machine(machine)}` : 'its machine'
  return (
    (paused
      ? `[Centralu] The assigned work paused on its own background work (${name.tasks(paused)}), and ${which} was removed from Centralu before that work ended`
      : `[Centralu] The assigned work's machine${name === STORED ? ` ${name.machine(machine)}` : ''} was removed from Centralu before its turn ended`) +
    ', so its end will not be reported.\n'
  )
}
/**
 * The first line of a report whose session ended its turn while one host handed over to the next (#646, #1186): the
 * leaving host held the report back, and the next one found the session at rest. That is the assigned turn's end
 * nearly always, but a turn that had not started yet looks the same, so it is not called finished.
 */
function swappedReportLine(): string {
  return (
    '[Centralu] The assigned work\'s session ended a turn while Centralu was restarting, so that end was not followed. ' +
    'It is most likely the end of the work you gave it; check its last response before relying on it.\n'
  )
}
/** The first line of a paused report settled with no turn after its work ended (#721): how that work ended */
function settledReportLine(tasks: readonly BackgroundTask[], name: Naming = STORED): string {
  const clean = tasks.every((t) => t.status === 'completed')
  return (
    `[Centralu] The assigned work's background work ended (${name.tasks(tasks, true)}) and no turn followed` +
    (clean ? '; its last answer is below.\n' : ', so the work may not have finished; its last answer is below.\n')
  )
}

/**
 * What a child's reports reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type ChildReportsHost = Pick<DelegationHost, 'children' | 'deliver' | 'disposing' | 'handingOver' | 'meta' | 'store' | 'trashing'> &
  Pick<RoutedCardsHost, 'toolProfileOf'> &
  Pick<RestartHost, 'inputsHeld'> &
  Pick<QueuedRequestsHost, 'projectRow'>

/**
 * What a session is told in its conversation about work it gave (#166, #698, #721): the report of a turn it is owed,
 * held over the child's own background work and settled when that work ends, the stop of a turn nobody was owed, and
 * the one guarded way of telling a session anything. Moved out of the session manager as it was (#428); what it
 * reaches of the manager is `ChildReportsHost`.
 */
export class ChildReports {
  constructor(private readonly host: ChildReportsHost) {}

  /** Holds the session's owed report over its own background work (#721); the mark itself stays as it is */
  pauseReport(sessionId: string, running: readonly BackgroundTask[]): void {
    this.host.children.pauseReport(sessionId, running)
    this.settlePausedReport(sessionId)
  }
  stopSettlingPausedReports(): void {
    this.host.children.stopSettling()
  }
  /**
   * The background work the session's tool lists as running, which a turn ending now does not end (#721). A timer the
   * tool holds (`/loop`, a scheduled prompt) is not work: a report is not held for it, or a loop would hold it for good
   */
  ownTasksRunning(sessionId: string): BackgroundTask[] {
    const m = this.host.meta.get(sessionId)
    return m ? liveBackgroundTasks(m.backgroundTasks).filter((t) => !t.timer) : []
  }
  /** The tasks a paused report waited on, as the session lists them now: how each ended, or still running (#721) */
  pausedTasksNow(sessionId: string): BackgroundTask[] {
    const listed = this.host.meta.get(sessionId)?.backgroundTasks ?? []
    return (this.host.children.pausedReports.get(sessionId) ?? []).map((t) =>
      listed.find((l) => l.id === t.id) ?? { id: t.id, kind: 'other' as const, description: t.description, status: 'completed' as const })
  }
  /**
   * A paused report whose background work has ended with no turn running (#721): the turn that ending starts ends the
   * work and reports it. If none starts within `PAUSED_REPORT_SETTLE_MS` (a task the person stopped, a tool that
   * starts no turn for it), the report goes out as the work's end with the last answer. Each change of the work starts
   * the wait again; a turn running when it is up reports at its own end.
   */
  settlePausedReport(sessionId: string): void {
    this.host.children.stopSettling(sessionId)
    if (this.host.disposing || this.host.handingOver) return
    const quiet = () => {
      const m = this.host.meta.get(sessionId)
      return this.host.children.pausedReports.has(sessionId) && !!m && !inTurn(m.state) && !this.host.inputsHeld(sessionId) && !this.host.children.delivering.has(sessionId) &&
        this.ownTasksRunning(sessionId).length === 0
    }
    if (!quiet()) return
    const timer = setTimeout(() => {
      this.host.children.stopSettling(sessionId)
      if (!quiet() || this.host.handingOver || this.host.disposing) return
      console.error(`[sessions] ${sessionId.slice(0, 8)}: its background work ended and no turn followed; reporting the work as ended`)
      void this.reportBackIfAwaited(sessionId, { type: 'turn_complete', sessionId }, undefined, this.pausedTasksNow(sessionId))
    }, PAUSED_REPORT_SETTLE_MS)
    timer.unref?.()
    this.host.children.settleAfter(sessionId, timer)
  }
  /**
   * Notifies the orchestrator when the work it assigned finishes — **the other half of "one window".**
   *
   * Without this, giving the instruction happens in one window and seeing the result means going to
   * that session. That leaves exactly the pain of hopping between windows in place — the thing this
   * was built to remove in the first place.
   *
   * Pushing a notification is risky, so it only ever happens **when it was asked for**:
   *  - Only work that had reportBack turned on when it was assigned comes back this way
   *  - Once notified, the marker is cleared. Otherwise that session would wake the orchestrator on
   *    every turn it runs on its own afterward — which would become a loop of waking each other
   *  - **Except at a turn that ends with the session's own background work still running** (#721): a child that
   *    backgrounded its `pnpm verify` and ended its turn "waiting for verify" has not finished. Its caller is told once
   *    that the work paused, the marker stays, and the turn that work's ending starts reports the end. The turns that
   *    keep it are its own work's, never a loop between sessions: a report does not start the reporting session's turn
   */
  async reportBackIfAwaited(
    sessionId: string,
    ending: NormalizedEvent,
    answer?: string,
    /** The paused work's tasks, ended with no turn after them (#721): the report says how they ended */
    settled?: readonly BackgroundTask[],
  ): Promise<void> {
    const orchestratorId = this.host.children.awaitingReport.get(sessionId)
    if (!orchestratorId || this.host.handingOver) return
    // Only a turn that completed is paused: a failed or stopped one is reported as it ended (#698)
    const running = ending.type === 'turn_complete' && !settled ? this.ownTasksRunning(sessionId) : []
    const paused = running.length > 0
    const toldPaused = paused && this.host.children.pausedReports.has(sessionId)
    if (paused) this.pauseReport(sessionId, running)
    else this.host.children.clearReport(sessionId)
    if (toldPaused) return

    const target = this.host.meta.get(sessionId)
    if (!target || !this.host.meta.has(orchestratorId)) return

    /*
     * The store and UI keep identifying information and a preview of the last response, as before.
     * What reaches the adapter's input is transformed by deliver(relayed) into a wake with no body —
     * the same whether the reporting side is a manager or a coordinator (#120). In other words, the
     * raw report is record/screen provenance, and the vendor turn is the trust boundary.
     */
    const { name, project } = this.reportedAs(target)
    const work = paused ? { paused: running, stoppable: target.askedBy === orchestratorId } : settled ? { settled } : undefined
    await this.deliverReport(orchestratorId, sessionId, name, project, answer !== undefined ? clipPreview(answer, 600) : previewOf(this.host.store.messages, sessionId, 600), ending, work, this.answerSeq(sessionId))
  }

  /** Where the session's last response starts, as its preview reads it (#1186): the report names the read that shows it */
  private answerSeq(sessionId: string): number | undefined {
    return lastResponseSeq(this.host.store.messages.loadMessages(sessionId, 50)) ?? undefined
  }

  /**
   * How a report names the session it is about, and its project: as read_session lists it (`labelOf`), so a resumed
   * conversation is not named by its compaction summary's first line. The two report paths used to name it each, and
   * a finished turn's report used the raw name.
   */
  reportedAs(m: SessionInfo): { name: string; project: string } {
    const project = m.projectId ? (this.host.projectRow(m.projectId)?.name ?? '(project no longer exists)') : '(none)'
    return { name: labelOf(this.host.store.messages, m), project }
  }

  /** A session as Centralu's word names it to another (`reportedAs`), or its id once it is gone */
  nameOf(sessionId: string): string {
    const m = this.host.meta.get(sessionId)
    return m ? this.reportedAs(m).name : sessionId
  }

  /**
   * A session start_agent started stopped in a turn nobody was owed a report of (#698): on 2026-10-15 the internet
   * dropped twice, and children's turns their CLI had opened itself (a Monitor firing) ended in a network error. Their
   * asker had been told of the work it gave and heard nothing of these; the children sat in `error` until the person
   * sent "continue" by hand. The asker is told once per stopped turn, through the same report: a further report needs
   * another turn, so two sessions cannot wake each other in a loop.
   */
  async tellAskerOfInterruption(sessionId: string, requester?: string): Promise<void> {
    const m = this.host.meta.get(sessionId)
    const stop = m?.interruption
    // The session that gave the turn (an ask_project, a delegation past its bound), else the one that started it
    const asker = requester ?? m?.askedBy ?? undefined
    if (!m || !asker || asker === sessionId || !stop || stop.reason === 'reconnecting' || this.host.handingOver) return
    /*
     * **Not a requester a quit stopped** (#698). It waits for the person's Continue under its own "stopped" line; a
     * notice would resume it and start a model turn with nobody there (at launch, when the same quit cut it), and that
     * turn would clear its own mark before the person saw it. Once continued, its children's rows say they stopped.
     */
    const askerInfo = this.host.meta.get(asker)
    if (!askerInfo || askerInfo.interruption?.reason === 'quit') return
    console.error(`[sessions] ${sessionId.slice(0, 8)} stopped (${stop.reason}) in a turn no report was owed for; telling ${asker.slice(0, 8)}, which started it`)
    const { name, project } = this.reportedAs(m)
    await this.deliverReport(asker, sessionId, name, project, previewOf(this.host.store.messages, sessionId, 600), { type: stop.reason === 'network' ? 'error' : 'state_change' }, undefined, this.answerSeq(sessionId))
  }

  /**
   * A report a host swap held back (#646, #1186): its session ended a turn while the old host let go, and the mark the
   * store kept is dropped at start (`restoreReports`), so a later turn is never reported as the work. The caller is
   * told once, here, that a turn ended and where to read it; it used to hear nothing.
   */
  async tellTurnEndedInSwap(sessionId: string, callerId: string): Promise<void> {
    const m = this.host.meta.get(sessionId)
    if (!m || !this.host.meta.has(callerId) || this.host.handingOver) return
    const { name, project } = this.reportedAs(m)
    await this.deliverReport(callerId, sessionId, name, project, previewOf(this.host.store.messages, sessionId, 600), { type: 'turn_complete' }, { swapped: true }, this.answerSeq(sessionId))
  }

  /** Reports the end of a turn the orchestrator asked to hear about, as one message in its session (#166) */
  async deliverReport(
    orchestratorId: string,
    sessionId: string,
    name: string,
    project: string,
    preview: string,
    ending: Pick<NormalizedEvent, 'type'> & { error?: { message?: string } },
    /**
     * The session's own background work (#721): `paused`, what its turn ended with (the report is still owed, and
     * `stoppable` when the caller can stop it with agent_session); `settled`, the paused work's tasks that ended with no
     * turn after them; `linkLost`, a linked machine's paused work whose link dropped before it ended (#723);
     * `machineRemoved`, a linked machine removed before the work or its turn ended
     */
    work?: ReportWork,
    /** Where its last response starts in its conversation, when it is read here: the read the model is pointed to (#1186) */
    answerSeq?: number,
  ): Promise<void> {
    /*
     * How it ended is stated on the first line (#166) — writing a failed run as "it finished" makes
     * both the person and the orchestrator read it as a success. On failure, the error message is
     * included too. The error is not the agent's last response, so it never shows up in the preview.
     */
    /*
     * A turn cut short by the network or by its tool is not a failure of the work (#698): it continues where it stopped
     * once it is sent a message, and nothing else will continue it. Said first, so the caller does not redo the work.
     */
    const stop = this.host.meta.get(sessionId)?.interruption
    const cutShort = stop?.reason === 'network' || stop?.reason === 'interrupted' || stop?.reason === 'quit'
    const outcomeOf = (name: Naming) =>
      work && 'swapped' in work ? swappedReportLine()
      : work && 'machineRemoved' in work ? machineRemovedReportLine(work.machineRemoved, work.paused, name)
      : work && 'linkLost' in work ? linkLostReportLine(work.linkLost, work.paused, name)
      : work && 'paused' in work ? pausedReportLine(work.paused, work.stoppable ? this.agentCall(orchestratorId, { action: 'stop' }) : undefined, name)
      : work && 'settled' in work ? settledReportLine(work.settled, name)
      : stop?.reason === 'network' ? `[Centralu] The assigned work stopped before finishing: a network error ended its turn.\n`
      : stop?.reason === 'interrupted' ? `[Centralu] The assigned work stopped before finishing: its tool interrupted the turn.\n`
      : stop?.reason === 'quit' ? `[Centralu] The assigned work stopped before finishing: Centralu quit or restarted during its turn.\n`
      : ending.type === 'error' ? `[Centralu] The assigned work failed.\n`
      : ending.type === 'limit_reached' ? `[Centralu] The assigned work stopped after hitting a usage limit.\n`
      : ending.type === 'turn_complete' ? `[Centralu] The assigned work finished.\n`
      : `[Centralu] The assigned work stopped before finishing.\n`
    const outcome = outcomeOf(STORED)
    const message = stop?.detail ?? (ending.type === 'error' ? String(ending.error?.message ?? '') : '')
    const failure = message ? `Error: ${message.slice(0, 600)}\n\n` : ''
    const resume = cutShort
      ? `It keeps its conversation: send it a message to go on${stop?.reason === 'network' ? ', once the network is back' : ''}, the same one the person's Continue sends: "Continue where you stopped. Check what already happened before repeating a step."\n`
      : ''
    const cleanUp = !work && !stop && ending.type === 'turn_complete' ? this.cleanUpWords(orchestratorId, sessionId) : ''
    const read = `read_session(sessionId="${sessionId}"${answerSeq !== undefined ? `, around=${answerSeq}` : ''})`
    await this.tellSession(
      orchestratorId,
      outcome +
        `Session: ${frameField(name)}\n` +
        `id: ${sessionId}\n` +
        `Project: ${frameField(project)}\n\n` +
        failure +
        resume +
        `Last response:\n${preview || '(no content)'}\n\n` +
        `If you need more, you can read that session's recent conversation with read_session.` +
        cleanUp,
      // A report is not the person's own words either (FR-11) — the reporting session is tagged as its
      // source
      { sessionId, name },
      true,
      /*
       * What the model reads (#1186): how the work ended, the session's id, the kind of its tool's error, how to go on,
       * and the read that shows its last response and that error. Nothing the reported session, its tool, its machine or
       * a name could have written goes in (#120): not its last response, its error's words, its name, its project's or
       * its tasks' descriptions; read_session lists the names by id.
       * It used to read only "intersession message available", so a failed run, a usage limit and the way to continue
       * reached the store and the screen and never the model.
       */
      outcomeOf(FOR_MODEL) +
        `id: ${sessionId}\n\n` +
        (message ? `Its tool's error, by kind: ${stop?.reason === 'network' ? 'network' : errorKind(message)}. Its words are its tool's, not Centralu's, so they are not repeated here: ${read} shows them.\n\n` : '') +
        resume +
        `Its last response is that session's own words, so it is not repeated here: ${read} reads it${preview ? '' : ' (it had none)'}.` +
        cleanUp,
    )
  }

  /**
   * A finished child's report to the session that started it (#690): the line that names deleting it once its answer is
   * used, and how many of its other children have finished too. Asked why fourteen finished children were left, a parent
   * said it had forgotten the last step. Only for its own start_agent child: a report on another session (a
   * send_to_session, an ask_project) is of a session it does not delete.
   */
  private cleanUpWords(parentId: string, childId: string): string {
    const child = this.host.meta.get(childId)
    if (!child || !cleanUpDue(child, parentId)) return ''
    // Counted as agent_session list counts them (own-agents.ts), so the number matches what list shows
    const others = ownAgents(this.host, parentId).filter((s) => s.id !== childId && agentState(this.host, s) === 'finished').length
    return (
      `\n${cleanUpLine(childId, this.agentCall(parentId, { sessionId: childId, action: 'delete' }))}` +
      (others ? `\n${others} other finished session${others === 1 ? '' : 's'} you started remain${others === 1 ? 's' : ''}: ${this.agentCall(parentId, { action: 'list' })} shows them.` : '')
    )
  }

  /**
   * An agent_session call a report names, in the form its receiver calls it (#850): the orchestrator reaches agent_session
   * only through centralu_run in the `commands` tier, where the bare call it would copy from the report is refused. A
   * seat without the tool keeps the bare form the reports always named.
   */
  private agentCall(receiverId: string, args: Record<string, string>): string {
    return namedCall(this.host.toolProfileOf(receiverId), 'agent_session', args)
  }

  /**
   * Tells a session something in its conversation (#428): a report, or Centralu's word on a request, a note or a queued
   * request that did not go. Never while this host is leaving. Handing over, a report whose mark the store keeps is the
   * next host's to give (#646); one held only in memory (a linked machine's, #723) and a notice like these are dropped
   * in that window, as anything said then would be. Quitting, the next start tells what the quit cut (#698), where a
   * word now would read "failed" and could wake a sleeping session on the way out. Never to a session that is gone, and it never throws: the session may be asleep
   * or deleted, and a notice must not destabilize the host. The four ways of telling each kept their own guard, and
   * the report and a queued request's had none.
   *
   * `relayed`: the text is about another session (`from`), stored and shown as from it. What the model reads is
   * `forModel`, the words Centralu wrote, with the source's id (#1186): every such text is Centralu's but a report's
   * last response, which the report leaves out of `forModel` (#120). The model used to read only "intersession message
   * available" for all of them, so a note that was not delivered, a card waiting on it or a link that dropped never
   * reached it.
   *
   * A notice that could not be delivered (a session that cannot be woken: its tool fails to start) is kept, said in the
   * log, and delivered once the session takes a message again (`deliverHeld`, #1186); it used to be dropped without a
   * word. Kept in memory only: a host swap in between loses it, as before.
   */
  async tellSession(sessionId: string, text: string, from: { sessionId: string; name: string }, relayed: boolean, forModel: string = text): Promise<void> {
    if (this.host.handingOver || this.host.disposing || !this.host.meta.has(sessionId)) return
    const modelText = `${forModel}\nsourceSessionId: ${from.sessionId}`
    try {
      await this.host.deliver(sessionId, text, undefined, from, relayed, undefined, 'inline', relayed ? (h) => h.send(modelText) : undefined)
    } catch (e) {
      // The session may be asleep or deleted — a notice must not destabilize the host
      if (this.host.handingOver || this.host.disposing || !this.host.meta.has(sessionId)) return
      const list = this.held.get(sessionId) ?? []
      if (list.length >= HELD_NOTICES_MAX) list.shift()
      list.push({ text, from, relayed, forModel })
      this.held.set(sessionId, list)
      console.error(`[sessions] ${sessionId.slice(0, 8)}: a notice about ${from.sessionId.slice(0, 8)} could not be delivered (${(e as Error).message}); kept for its next message`)
    }
  }

  /** Notices that could not be delivered, by the session they are for (`tellSession`) */
  private readonly held = new Map<string, { text: string; from: { sessionId: string; name: string }; relayed: boolean; forModel: string }[]>()

  /** The session was deleted: the notices kept for it go with it (#1186 review) */
  forgetHeld(sessionId: string): void {
    this.held.delete(sessionId)
  }

  /** The session took a message: the notices kept for it go in now, oldest first, each told as it was (#1186) */
  deliverHeld(sessionId: string): void {
    const list = this.held.get(sessionId)
    if (!list) return
    this.held.delete(sessionId)
    void (async () => {
      for (const n of list) await this.tellSession(sessionId, n.text, n.from, n.relayed, n.forModel)
    })()
  }
}

/** The most notices kept for one session that could not be woken: the oldest goes first past it */
const HELD_NOTICES_MAX = 20
