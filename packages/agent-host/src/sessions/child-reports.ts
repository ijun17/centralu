import type { BackgroundTask, NormalizedEvent, SessionInfo } from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
  liveBackgroundTasks,
} from '@cc/protocol'
import { inTurn } from '../idle.js'
import { agentLook, errorMessage, SHUTDOWN_WORDS } from '@cc/protocol'
import { errorKind } from './error-kind.js'
import { wentWithItsProcess } from './interruptions.js'
import { PERSON_TURN_ENDED, TURN_ENDED } from '../mail/delegation.js'
import type { LastResponse } from '../mail/last-response.js'
import type { StopWhy } from '../mail/stop-notices.js'
import { asObj, str } from '../json-value.js'
import { OWN_WORK_SETTLE_MS } from './child-ownership.js'
import { type DelegationHost, taskList } from './delegation-flow.js'
import type { ReportPart, ReportWork } from './linked-reports.js'
import type { ProjectRegistry } from './project-registry.js'
import { MACHINE_UNREACHABLE } from './ask-project.js'
import { labelOf, previewOf } from './transcript-view.js'
import { clipPreview, lastResponse, lastResponseSeq } from './turn-answer.js'
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

/**
 * The first line of a report held over the session's own background work (#721). `update` (#1540): not the first pause but a later turn of
 * the paused work, which ended with a new answer while that work still runs. `listed`: the call that names each task, for the model, which
 * reads them counted (#1186)
 */
function pausedReportLine(running: readonly BackgroundTask[], stop: string | undefined, name: Naming = STORED, update = false, listed?: string): string {
  return (
    (update
      ? `[Centralu] An update on the assigned work, which is still paused: a later turn ended with a new answer while its own background work is still running (${name.tasks(running)}). `
      : `[Centralu] The assigned work paused: its turn ended while its own background work is still running (${name.tasks(running)}). `) +
    (listed ? `${listed} names each of them. ` : '') +
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
/** A turn an update cut and Centralu continued (#1966): whoever it answers heard nothing of the cut, so its end says so */
const CUT_CONTINUED = 'An update of Centralu cut this turn and Centralu continued it.\n'

/** What a report says of the person's part in the turn it reports (#1377): Centralu's own words, never the person's */
export function personPartLine(turn: ReportPart | undefined): string {
  // An update cut the turn and Centralu continued it (#1966): its parent heard nothing of the cut, so the end says so
  const centralu = turn?.cut ? CUT_CONTINUED : ''
  if (turn?.wrote) return `${centralu}The person wrote in this session during this turn.\n`
  return centralu
}
/** The first line of a linked machine's paused report settled with no turn after its work ended (#721, #723): how that work ended */
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
export type ChildReportsHost = Pick<DelegationHost, 'children' | 'deliver' | 'disposing' | 'meta' | 'selfCompaction' | 'store' | 'trashing'> &
  Pick<RoutedCardsHost, 'toolProfileOf'> & {
    /** A session at rest answers its open tasks with its last response (`MailSessionsView.mailLastResponse`) */
    mailLastResponse(sessionId: string, last: SessionLastResponse): void
  } &
  Pick<ProjectRegistry, 'projectRow'>

/**
 * A last response as the session side words it (`MailHooks.lastResponse`): Centralu's words for a session that gave the work, by its id, or for the person
 * (null). `relay`: the same answer told in the conversation of a session whose seat cannot read mail, as the relayed report it always had (`deliverReport`);
 * `told` once it went in
 */
export type SessionLastResponse = Omit<LastResponse, 'body' | 'answers'> & { body: (receiverId: string | null) => string; relay: (receiverId: string, told: () => void) => void }

/**
 * What a session's turn's end tells the sessions and the person that gave it work (#166, #698, #721, docs/plans/mailbox.md §10.6.3): its last response
 * answers the tasks it did not reply to once it is at rest, or settled after its own background work ended; the report of a linked machine's child,
 * and the one guarded way of telling a session anything. Moved out of the session manager as it was (#428); what it reaches of the
 * manager is `ChildReportsHost`.
 */
export class ChildReports {
  constructor(private readonly host: ChildReportsHost) {}

  /** The settle timer of a session whose own background work ended with no turn running (`settleAtRest`) */
  private readonly settles = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions whose turn an update cut and Centralu continued (#1966), ended when they were not at rest: the answer that follows says so. Memory only */
  private readonly cutsUntold = new Set<string>()

  /**
   * A turn ended as a turn does (not a stop, not Centralu's compaction or continue): a session at rest answers each task it did not reply to with its
   * last response (§10.6.3), but mail the tool holds queued for a turn after, which that turn answers. One whose own background work runs is not at
   * rest: that work's end does it (`settleAtRest`). `cut`: an update cut the turn and Centralu continued it (#1966), said by the answer that follows,
   * this one or a later one. Never throws
   */
  turnEndedAtRest(sessionId: string, cut = false): void {
    if (cut) this.cutsUntold.add(sessionId)
    this.answerAtRest(sessionId, true)
  }

  /** A turn stopped: its stop notice releases what the session owed, so a cut kept from a turn before is no later answer's to tell (#1966) */
  turnStopped(sessionId: string): void {
    this.cutsUntold.delete(sessionId)
  }

  /**
   * `stoppedId`'s stop, told to a session whose seat cannot read mail as it was before #1948 step 3 (`StopNoticeOptions.relayToMailless`, mailbox.md §10.6.3): the
   * relayed report in the words for that ending (`deliverReport`): failed with the kind of its error, the usage limit, else how its interruption says it
   * stopped. `told` once it went in. Never throws
   */
  relayStop(receiverId: string, stoppedId: string, why: StopWhy, told: () => void): void {
    const m = this.host.meta.get(stoppedId)
    if (!m) return
    try {
      const { name, project } = this.reportedAs(m)
      const { preview, seq } = this.turnWords(stoppedId)
      const error = why === 'error' ? this.host.store.messages.loadMessages(stoppedId, 50).findLast((r) => r.role === 'system' && asObj(r.payload).type === 'error') : undefined
      const ending = why === 'error' ? { type: 'error' as const, error: { message: str(asObj(asObj(error?.payload).error).message) } } : { type: why === 'limit' ? ('limit_reached' as const) : ('state_change' as const) }
      void this.deliverReport(receiverId, stoppedId, name, project, preview, ending, undefined, seq, undefined, told)
    } catch (e) {
      console.error(`[mail] ${stoppedId.slice(0, 8)}: its stop could not be told to ${receiverId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  /**
   * The session's own background work changed, or this host started: once that work is over and no turn runs, the turn its end may start (Claude starts
   * one within a second) answers; if none starts within `OWN_WORK_SETTLE_MS`, its last response answers the tasks no stop released (#721), the
   * person's own work's too. Only for a session with something to answer
   */
  settleAtRest(sessionId: string): void {
    this.stopSettling(sessionId)
    const m = this.host.meta.get(sessionId)
    if (this.host.disposing || !m || inTurn(m.state) || this.ownTasksRunning(sessionId).length > 0) return
    if (this.host.children.openTasks(sessionId, 'to').length === 0) return
    const timer = setTimeout(() => {
      this.settles.delete(sessionId)
      const now = this.host.meta.get(sessionId)
      if (this.host.disposing || !now || inTurn(now.state) || this.ownTasksRunning(sessionId).length > 0) return
      this.answerAtRest(sessionId, false)
    }, OWN_WORK_SETTLE_MS)
    timer.unref?.()
    this.settles.set(sessionId, timer)
  }

  /** Ends a settle timer; with no session, every one (the host is leaving) */
  stopSettling(sessionId?: string): void {
    for (const [id, timer] of [...this.settles]) {
      if (sessionId !== undefined && id !== sessionId) continue
      clearTimeout(timer)
      this.settles.delete(id)
    }
  }

  /**
   * The session's last response answers its open tasks, when it is at rest (`agentLook`: finished): the words of its last turn, which ran them (a
   * call's run reads every turn since it began, so it is not the answer), else its last response before it
   */
  private answerAtRest(sessionId: string, released: boolean): void {
    const m = this.host.meta.get(sessionId)
    // A turn that asked to compact with a next step is not the work's end: the step's turn goes on with it (#2164)
    if (this.host.disposing || !m || agentLook(m) !== 'finished' || this.host.selfCompaction.goesOn(sessionId)) return
    try {
      const { preview: words, seq } = this.turnWords(sessionId)
      const writtenAt = seq === undefined ? undefined : this.host.store.messages.loadMessages(sessionId, 200).find((r) => r.seq === seq)?.ts
      const cut = this.cutsUntold.delete(sessionId)
      this.host.mailLastResponse(sessionId, {
        body: (receiverId) => this.lastResponseWords(receiverId, sessionId, words !== '', seq, cut),
        relay: (receiverId, told) => {
          const { name, project } = this.reportedAs(m)
          void this.deliverReport(receiverId, sessionId, name, project, words, { type: 'turn_complete' }, undefined, seq, cut ? { cut: true } : undefined, told)
        },
        ...(words ? { answer: words } : {}),
        ...(writtenAt !== undefined ? { writtenAt } : {}),
        released,
      })
    } catch (e) {
      console.error(`[mail] ${sessionId.slice(0, 8)}: its last response could not answer its tasks (${errorMessage(e)})`)
    }
  }

  /**
   * Centralu's words beside a last response, for the session that gave the work, in its form of the calls named. The person (`null`) reads one line, and
   * the cut's when there was one: the window shows the last response itself
   */
  private lastResponseWords(receiverId: string | null, childId: string, answered: boolean, seq: number | undefined, cut: boolean): string {
    if (receiverId === null) return cut ? `${PERSON_TURN_ENDED}\n${CUT_CONTINUED.trimEnd()}` : PERSON_TURN_ENDED
    const read = `read_session(sessionId="${childId}"${seq !== undefined ? `, around=${seq}` : ''})`
    return (
      `${TURN_ENDED}\nid: ${childId}\n${cut ? CUT_CONTINUED : ''}\n` +
      (answered
        ? `Its last response is that session's own words: it is the message above in this thread, and ${read} reads more.`
        : `It wrote no response: ${read} shows its turn.`) +
      this.cleanUpWords(receiverId, childId)
    )
  }

  /** The background work the session's tool lists as running, which a turn ending now does not end (#721). A timer the tool holds (`/loop`, a scheduled prompt) is not work: a report is not held for it, or a loop would hold it for good */
  ownTasksRunning(sessionId: string): BackgroundTask[] {
    const m = this.host.meta.get(sessionId)
    return m ? liveBackgroundTasks(m.backgroundTasks).filter((t) => !t.timer) : []
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
   * The words of the session's latest turn: those it said so far, or none, never the turn before's (#1604, #1946). A stop notice quotes them for the turn
   * a stop cut; a last response is them (§10.6.3). A turn not seen to begin (one an older build ran) reads as the session's preview does
   */
  turnWords(sessionId: string): { preview: string; seq: number | undefined } {
    const span = this.host.children.latestTurnRows(sessionId)
    if (!span) return { preview: previewOf(this.host.store.messages, sessionId, 600), seq: this.answerSeq(sessionId) }
    const rows = this.host.store.messages.loadMessages(sessionId, 200)
    return { preview: clipPreview(lastResponse(rows, span), 600), seq: lastResponseSeq(rows, span) ?? undefined }
  }

  /**
   * Reports the end of a turn as one relayed message in the session told (#166): a linked machine's session the Assistant asked to hear about (#82
   * phase 4), and the last response that answers a task of a session whose seat cannot read mail (`SessionLastResponse.relay`, mailbox.md §10.6.3)
   */
  async deliverReport(
    assistantId: string,
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
    /** The person's part in the turn reported (#1377): they wrote into it; and an update's part in it (#1966) */
    part?: ReportPart,
    /** Told once the report went in, now or from the held notices (`tellSession`) */
    told?: () => void,
  ): Promise<boolean> {
    /*
     * How it ended is stated on the first line (#166) — writing a failed run as "it finished" makes
     * both the person and the Assistant read it as a success. On failure, the error message is
     * included too. The error is not the agent's last response, so it never shows up in the preview.
     */
    /*
     * A turn cut short by the network or by its tool is not a failure of the work (#698): it continues where it stopped
     * once it is sent a message, and nothing else will continue it. Said first, so the caller does not redo the work.
     */
    const stop = this.host.meta.get(sessionId)?.interruption
    const cutShort = stop?.reason === 'network' || stop?.reason === 'interrupted' || wentWithItsProcess(stop)
    const outcomeOf = (name: Naming) =>
      work && 'machineRemoved' in work ? machineRemovedReportLine(work.machineRemoved, work.paused, name)
      : work && 'linkLost' in work ? linkLostReportLine(work.linkLost, work.paused, name)
      : work && 'paused' in work
        ? pausedReportLine(
            work.paused,
            work.stoppable ? this.agentCall(assistantId, { action: 'stop' }) : undefined,
            name,
            work.update === true,
            // The model reads the tasks counted (#1186): the call that names each, where the caller may make it
            name === FOR_MODEL && work.stoppable ? this.agentCall(assistantId, { action: 'status' }) : undefined,
          )
      : work && 'settled' in work ? settledReportLine(work.settled, name)
      : stop?.reason === 'network' ? `[Centralu] The assigned work stopped before finishing: a network error ended its turn.\n`
      : stop?.reason === 'interrupted' ? `[Centralu] The assigned work stopped before finishing: its tool interrupted the turn.\n`
      : stop?.reason === 'quit' ? `[Centralu] The assigned work stopped before finishing: Centralu quit or restarted during its turn.\n`
      : stop?.reason === 'shutdown' ? `[Centralu] The assigned work stopped before finishing: ${SHUTDOWN_WORDS} during its turn.\n`
      : ending.type === 'error' ? `[Centralu] The assigned work failed.\n`
      : ending.type === 'limit_reached' ? `[Centralu] The assigned work stopped after hitting a usage limit.\n`
      : ending.type === 'turn_complete' ? `${TURN_ENDED}\n`
      : `[Centralu] The assigned work stopped before finishing.\n`
    const outcome = outcomeOf(STORED) + personPartLine(part)
    const message = stop?.detail ?? (ending.type === 'error' ? String(ending.error?.message ?? '') : '')
    const failure = message ? `Error: ${message.slice(0, 600)}\n\n` : ''
    const resume = cutShort
      ? `It keeps its conversation: send it a message to go on${stop?.reason === 'network' ? ', once the network is back' : ''}, the same one the person's Continue sends: "Continue where you stopped. Check what already happened before repeating a step."\n`
      : ''
    const cleanUp = !work && !stop && ending.type === 'turn_complete' ? this.cleanUpWords(assistantId, sessionId) : ''
    const read = `read_session(sessionId="${sessionId}"${answerSeq !== undefined ? `, around=${answerSeq}` : ''})`
    const kind = message ? (stop?.reason === 'network' ? 'network' : errorKind(message)) : undefined
    // Its words as they were last read, before its machine went out of reach (#1186): said, so they are not taken for the turn's end
    const asRead = !!work && ('linkLost' in work || 'machineRemoved' in work) && work.asRead === true
    const asReadWords = asRead ? ', as it was last read there, before its machine went out of reach' : ''
    /*
     * What the model reads (#1186): how the work ended, the session's id, the kind of its tool's error, how to go on, and the read that shows
     * its last response and that error. Nothing the reported session, its tool, its machine or a name could have written goes in (#120): not
     * its last response, its error's words, its name, its project's or its tasks' descriptions; read_session lists the names by id.
     * It used to read only "intersession message available", so a failed run, a usage limit and the way to continue reached the store and the
     * screen and never the model. The thread's report is these words too: the mailbox shows it under Centralu's name
     */
    const forModel =
      outcomeOf(FOR_MODEL) + personPartLine(part) +
      `id: ${sessionId}\n\n` +
      (kind ? `Its tool's error, by kind: ${kind}. Its words are its tool's, not Centralu's, so they are not repeated here: ${read} shows them.\n\n` : '') +
      resume +
      (preview === MACHINE_UNREACHABLE
          ? `Its last response could not be read: its machine could not be reached. ${read} reads it once that machine is back.`
        : `Its last response${asReadWords} is that session's own words, so it is not repeated here: ${read} reads it${preview ? '' : ' (it had none)'}.`) +
      cleanUp
    const stored =
      outcome +
      `Session: ${frameField(name)}\n` +
      `id: ${sessionId}\n` +
      `Project: ${frameField(project)}\n\n` +
      failure +
      resume +
      `Last response${asReadWords}:\n${preview || '(no content)'}\n\n` +
      `If you need more, you can read that session's recent conversation with read_session.` +
      cleanUp
    // A linked machine's child has no task in this host's mailbox (§14), and a seat without the mail tool reads no mail: the relayed message is how
    // either is told (#1948 step 6 moves the first to mail)
    return this.tellSession(
      assistantId,
      stored,
      // A report is not the person's own words either (FR-11) — the reporting session is tagged as its
      // source
      { sessionId, name },
      true,
      forModel,
      told,
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
      (others ? `\n${others} other session${others === 1 ? '' : 's'} you started ${others === 1 ? 'has' : 'have'} ended ${others === 1 ? 'its turn' : 'their turns'} and remain${others === 1 ? 's' : ''}: ${this.agentCall(parentId, { action: 'list' })} shows them.` : '')
    )
  }

  /**
   * An agent_session call a report names, in the form its receiver calls it (#850): the Assistant reaches agent_session
   * only through centralu_run in the `commands` tier, where the bare call it would copy from the report is refused. A
   * seat without the tool keeps the bare form the reports always named.
   */
  private agentCall(receiverId: string, args: Record<string, string>): string {
    return namedCall(this.host.toolProfileOf(receiverId), 'agent_session', args)
  }

  /**
   * Tells a session something in its conversation (#428): a report, or Centralu's word on a request that did not go. Never while this host is leaving. Handing over, a report whose mark the store keeps is the
   * next host's to give (#646); one held only in memory (a linked machine's, #723) and a notice like these are dropped
   * in that window, as anything said then would be. Quitting, the next start tells what the quit cut (#698), where a
   * word now would read "failed" and could wake a sleeping session on the way out. Never to a session that is gone, and it never throws: the session may be asleep
   * or deleted, and a notice must not destabilize the host. The ways of telling each kept their own guard, and
   * the report had none.
   *
   * `relayed`: the text is about another session (`from`), stored and shown as from it. What the model reads is
   * `forModel`, the words Centralu wrote, with the source's id (#1186): every such text is Centralu's but a report's
   * last response, which the report leaves out of `forModel` (#120). The model used to read only "intersession message
   * available" for all of them, so a note that was not delivered, a card waiting on it or a link that dropped never
   * reached it.
   *
   * A notice that could not be delivered (a session that cannot be woken: its tool fails to start) is kept, said in the
   * log, and delivered once the session takes a message again (`deliverHeld`, #1186); it used to be dropped without a
   * word. Kept in memory only: a host swap in between loses it, as before. `onDelivered`: told when it went in, now or from the held notices
   */
  async tellSession(
    sessionId: string,
    text: string,
    from: { sessionId: string; name: string },
    relayed: boolean,
    forModel: string = text,
    onDelivered?: () => void,
  ): Promise<boolean> {
    if (this.host.disposing || !this.host.meta.has(sessionId)) return false
    const modelText = `${forModel}\nsourceSessionId: ${from.sessionId}`
    try {
      await this.host.deliver(sessionId, text, undefined, from, relayed, undefined, 'inline', undefined, undefined, relayed ? modelText : undefined)
      onDelivered?.()
      return true
    } catch (e) {
      // The session may be asleep or deleted — a notice must not destabilize the host
      if (this.host.disposing || !this.host.meta.has(sessionId)) return false
      const list = this.held.get(sessionId) ?? []
      if (list.length >= HELD_NOTICES_MAX) list.shift()
      list.push({ text, from, relayed, forModel, ...(onDelivered ? { onDelivered } : {}) })
      this.held.set(sessionId, list)
      console.error(`[sessions] ${sessionId.slice(0, 8)}: a notice about ${from.sessionId.slice(0, 8)} could not be delivered (${(e as Error).message}); kept for its next message`)
      return false
    }
  }

  /** Notices that could not be delivered, by the session they are for (`tellSession`) */
  private readonly held = new Map<string, { text: string; from: { sessionId: string; name: string }; relayed: boolean; forModel: string; onDelivered?: () => void }[]>()

  /** The session was deleted: the notices kept for it go with it (#1186 review), and a cut its answer was to tell */
  forgetHeld(sessionId: string): void {
    this.held.delete(sessionId)
    this.cutsUntold.delete(sessionId)
  }

  /** The session took a message: the notices kept for it go in now, oldest first, each told as it was (#1186) */
  deliverHeld(sessionId: string): void {
    const list = this.held.get(sessionId)
    if (!list) return
    this.held.delete(sessionId)
    void (async () => {
      for (const n of list) await this.tellSession(sessionId, n.text, n.from, n.relayed, n.forModel, n.onDelivered)
    })()
  }
}

/** The most notices kept for one session that could not be woken: the oldest goes first past it */
const HELD_NOTICES_MAX = 20
