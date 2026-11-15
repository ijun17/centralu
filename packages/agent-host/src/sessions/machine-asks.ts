import type { HubAskParams, HubAskResult, HubProject, SessionState } from '@cc/protocol'
import { oneLineText } from '@cc/protocol'
import { ASK_WAIT_MS, askFrame, clipAnswer, pickAskedSession, taskLine } from './ask-project.js'
import type { DelegationHost } from './delegation-host.js'
import { lastResponse } from './turn-answer.js'
import { unfinished } from '../mail/delegation.js'
import { lastActiveOf } from './transcript-view.js'
import { isOrdinary } from './tool-profiles.js'

/**
 * What a linked machine's ask reaches of the session manager (#550), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type MachineAsksHost = Pick<DelegationHost, 'children' | 'hostCards' | 'emit' | 'linkedTasks' | 'mailTask' | 'meta' | 'store'>

/** The machine a call came from, as the link it came in on names it: never what the call says */
export type AskingMachine = { id: string; name: string }

/**
 * The reverse direction, on the hub (#550, docs/plans/remote-hub.md §12.7, owner decision 2026-10-18): a linked machine's
 * session asks a project of this computer, as `ask_project` does here, behind this computer's card for the pair.
 *
 *   - Only while that machine's switch is on (Settings → Machines), read at every step that waits: before the card,
 *     after it, and when a pair is remembered.
 *   - The card is this computer's, in the session here that would get the task, so only this computer's windows can
 *     answer it; it names the machine and the asking session there. Approving it is remembered for the pair (that
 *     session, this project) until withdrawn in Settings → Machines, or until the switch goes off; a remembered pair
 *     passes with no card. Deny is not remembered.
 *   - The target is an existing ordinary session, as for an ask here (#614): never created, never an app's or a
 *     builder's.
 *   - The task is mail (#1948 step 6): a task from that session on that machine (its address here, `<machine>.<id>`),
 *     framed as from it (never the person and never an assistant), which this host's delivery gives the session, held
 *     while it is busy as any task is, and whose turn its engine reports. The session works on it one level deeper than
 *     the asker (#867, the task's `depth`), so it cannot ask on.
 *   - The call waits for that report up to the bound and answers with the session's words, cut to size; past the bound
 *     it answers `working` with the task's id, and the report goes to the machine when it comes (`MailAcross.passReport`).
 *     Paths in it are this computer's: the machine lists them and opens none.
 */
export class MachineAsks {
  /** What closes the cards standing for each machine (#550 review): turning its switch off, or removing it */
  private readonly standing = new Map<string, Set<AbortController>>()

  constructor(
    private readonly host: MachineAsksHost,
    /** This computer's name, as the machine's session reads it in an answer */
    private readonly selfName: () => string,
  ) {}

  /** The projects a machine's session may name (`hub.projects`) */
  projects(): HubProject[] {
    return this.host.store.projects.listProjects().map((p) => ({ id: p.id, name: p.name }))
  }

  /** Why the machine may not ask now, or null */
  private gate(machine: AskingMachine): string | null {
    return this.host.store.machines.linkedMachineAsks(machine.id)
      ? null
      : `${this.selfName()} does not let sessions on ${machine.name} ask its projects. The person can turn that on in Settings → Machines on ${this.selfName()}.`
  }

  /** An ordinary session of the project here, which an ask may reach (#614) */
  private ordinary(projectId: string): { id: string; name: string; state: SessionState; lastActive?: string }[] {
    return [...this.host.meta.values()]
      .filter((s) => s.projectId === projectId && isOrdinary(s))
      .map((s) => ({ id: s.id, name: s.name, state: s.state }))
  }

  /**
   * `hub.askProject`: one ask of a machine's session, as `ask_project` is here. `hold` holds the call's limit on the machine
   * while the pair's card is out of the person's sight (#2271)
   */
  async ask(machine: AskingMachine, p: HubAskParams, signal?: AbortSignal, hold?: (held: boolean) => void): Promise<HubAskResult> {
    const shut = this.gate(machine)
    if (shut) return { ok: false, error: shut }
    const here = this.selfName()
    const tasks = this.host.linkedTasks
    if (!tasks) return { ok: false, error: `${here} takes work from another computer only by mail, and its mail is not running.` }
    const projects = this.host.store.projects.listProjects()
    const wanted = p.project.trim()
    const target =
      projects.find((x) => x.id === wanted) ?? projects.find((x) => x.name === wanted) ?? projects.find((x) => x.name.toLowerCase() === wanted.toLowerCase())
    if (!target) {
      return { ok: false, error: `No project named "${oneLineText(wanted, 120)}" on ${here}. Its projects are: ${projects.map((x) => x.name).join(', ') || 'none'}.` }
    }
    const label = `${target.name} on ${here}`
    // The asking session as this host names it, and its asks of the project's sessions not answered yet
    const caller = `${machine.id}.${p.caller.sessionId}`
    const sessions = this.ordinary(target.id)
    const mine = tasks.asks(caller).flatMap((a) => {
      const s = sessions.find((x) => x.id === a.sessionId)
      return s ? [{ taskId: a.taskId, session: s }] : []
    })
    const wantedSession = p.session?.trim()
    const [only] = mine
    if (!p.task && !wantedSession && only && mine.length === 1) return this.answer(only.taskId, only.session, target.name, signal)
    const picked = pickAskedSession(sessions, wantedSession, label, (s) => lastActiveOf(this.host.store.messages, s.id))
    if ('error' in picked) return { ok: false, error: picked.error }
    const chosen = picked.chosen
    const pending = mine.find((g) => g.session.id === chosen.id)
    if (pending && !p.task) return this.answer(pending.taskId, chosen, target.name, signal)
    if (pending && tasks.open(caller, chosen.id) === pending.taskId) {
      return { ok: false, error: `${label} is still working on your last task in the session "${chosen.name}". Call ask_project again with that session and no task to wait for it.` }
    }
    if (!p.task) return { ok: false, error: `Give a task: what ${label} / ${chosen.name} should do.` }

    // The pair's card (owner decision 2026-10-18): asked once, then remembered until withdrawn
    if (!this.host.store.machines.machineAskConsent(machine.id, p.caller.sessionId, target.id)) {
      const closing = new AbortController()
      const onAbort = () => closing.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) closing.abort()
      let mine = this.standing.get(machine.id)
      if (!mine) this.standing.set(machine.id, (mine = new Set()))
      mine.add(closing)
      const decision = await this.host.hostCards.askHost(
        chosen.id,
        {
          kind: 'project_access',
          access: 'delegate',
          from: {
            id: machine.id,
            name: oneLineText(p.caller.project, 120) || 'a project',
            machine: machine.name,
            session: { id: p.caller.sessionId, name: oneLineText(p.caller.name, 120) || p.caller.sessionId },
          },
          to: { id: target.id, name: target.name, trusted: target.trusted },
          text: taskLine(p.task),
          session: { id: chosen.id, name: chosen.name },
        },
        closing.signal,
        /*
         * Raised whatever the target session's preset (#550 review): its `auto` is its own, and answers no card of another
         * machine, as start_agent's on another computer is asked every time (#1038). The machine's call waits on the person,
         * so its limit stops while the person cannot see the card (#2271): their own turn in that session hides it until the
         * turn ends (#673), or another card stands in its place
         */
        { alwaysAsk: true, ...(hold ? { onHeld: hold } : {}) },
      ).finally(() => {
        signal?.removeEventListener('abort', onAbort)
        mine.delete(closing)
        if (!mine.size && this.standing.get(machine.id) === mine) this.standing.delete(machine.id)
      })
      // The card may have stood a while: the switch and the project are read again, and their reason comes first
      const after = this.gate(machine) ?? (this.host.store.projects.listProjects().some((x) => x.id === target.id) ? null : `${target.name} was removed from ${here}, so it was not reached.`)
      if (after) return { ok: false, error: after }
      if (decision === 'deny') return { ok: false, error: `The person did not allow this session to ask ${label}. Do not ask again unless they tell you to.` }
      if (decision === null) return { ok: false, error: `The question to the person was withdrawn before they answered, so ${label} was not reached.` }
      if (!this.host.store.machines.setMachineAskConsent({ machineId: machine.id, sessionId: p.caller.sessionId, sessionName: oneLineText(p.caller.name, 120) || p.caller.sessionId, projectId: target.id })) {
        return { ok: false, error: `${here} no longer lets sessions on ${machine.name} ask its projects, so ${label} was not reached.` }
      }
      this.host.emit({ type: 'project_consents_changed' })
    }
    if (signal?.aborted) return { ok: false, error: 'The call was cancelled before delivery' }
    const now = this.ordinary(target.id).some((s) => s.id === chosen.id) ? this.host.meta.get(chosen.id) : undefined
    if (!now) return { ok: false, error: `The session "${chosen.name}" in ${label} is no longer available; nothing was sent.` }
    const from = `${oneLineText(p.caller.name, 120) || 'A session'} on ${machine.name}`
    const mailed = this.host.mailTask(caller, now, 'ask_project', askFrame(`${oneLineText(p.caller.project, 120) || 'a project'} on ${machine.name}`, p.task, { name: from }), false, p.depth)
    if ('error' in mailed) return { ok: false, error: `Could not hand the task to ${label}: ${mailed.error}` }
    return this.answer(mailed.messageId, chosen, target.name, signal)
  }

  /**
   * Closes every card still standing for a machine (#550 review): its switch went off, or it was removed. The asks
   * answer with the switch's refusal; nothing is delivered and nothing is remembered. Its tasks not given yet are
   * withdrawn, so none reaches a session after the switch went off; one given already runs on, as it did
   */
  closeCards(machineId: string): void {
    for (const c of [...(this.standing.get(machineId) ?? [])]) c.abort()
    this.host.linkedTasks?.withdrawAsks(`${machineId}.`)
  }

  /**
   * Waits for the task's report up to the bound, as an ask here waits for its turn. The answer carries a report it read, which is then not passed to the
   * machine; a report that comes after the answer is (`holdReports`)
   */
  private async answer(taskId: string, session: { id: string; name: string }, project: string, signal?: AbortSignal): Promise<HubAskResult> {
    const tasks = this.host.linkedTasks!
    const base = { project, sessionId: session.id, sessionName: session.name, taskId }
    const release = tasks.holdReports(taskId)
    let told = false
    try {
      const r = await tasks.settled(taskId, ASK_WAIT_MS, { signal })
      const s = tasks.standing(taskId)
      // A report in at the bound is answered with, not passed after the answer: it would reach the machine before its copy of the task
      if (r === 'aborted' || s.state === 'open') return { ok: true, state: 'working', ...base }
      told = true
      const failed = unfinished(s)
      if (failed !== null) return { ok: false, error: `${project}'s session "${session.name}" on ${this.selfName()} did not finish: ${failed}. Tell the person, or ask again with a clearer task.` }
      // The session's own words, whole, while they are still the task's: once it has said more since the report, they are other work's, and the report's are read
      const rows = this.host.store.messages.loadMessages(session.id, 200)
      const reportAt = this.host.store.mailbox.reportsOn(taskId).at(-1)?.createdAt ?? Infinity
      const words = rows.some((row) => row.ts > reportAt) ? '' : lastResponse(rows, this.host.children.turnRows(session.id))
      const answer = words || (s.state === 'reported' ? (s.answer ?? '') : '')
      return { ok: true, state: 'done', ...base, answer: clipAnswer(answer, session.name) }
    } finally {
      release(told)
    }
  }
}

