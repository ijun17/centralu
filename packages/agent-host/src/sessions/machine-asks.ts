import type { HubAskParams, HubAskResult, HubProject, SessionState } from '@cc/protocol'
import { oneLineText } from '@cc/protocol'
import { inTurn } from '../idle.js'
import { AgentRunWait } from './app-agents.js'
import { ASK_WAIT_MS, askFrame, clipAnswer, taskLine } from './ask-project.js'
import { hubAskDepthKey } from './agent-depth.js'
import type { DelegationHost } from './delegation-host.js'
import { MACHINE_ASKER } from './hub-sender.js'
import { raceBound } from './with-timeout.js'
import { turnAnswer } from './turn-answer.js'

/**
 * What a linked machine's ask reaches of the session manager (#550), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type MachineAsksHost = Pick<DelegationHost, 'agentRuns' | 'askHost' | 'builderRefOf' | 'deliver' | 'emit' | 'meta' | 'store'>

/** The machine a call came from, as the link it came in on names it: never what the call says */
export type AskingMachine = { id: string; name: string }

/** A task a machine's session gave a session here, while its turn runs and until its answer is read */
type Given = {
  machineId: string
  callerId: string
  sessionId: string
  sessionName: string
  project: string
  wait: AgentRunWait
  notice?: string
  settledAt?: number
}

/** How long an answer nobody came back for is kept (#550): the machine's session may ask again after a link drop */
const UNREAD_KEPT_MS = 60 * 60_000

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
 *     builder's. A session busy with a turn gets nothing: a note or a queue from another machine is not offered, as for
 *     step 3's asks the other way (§12.6).
 *   - The task arrives framed as from that session on that machine (`MACHINE_ASKER`, never the person and never an
 *     orchestrator), and the session works on it one level deeper than the asker (#867), so it cannot ask on.
 *   - The answer goes back cut to size. Paths in it are this computer's: the machine lists them and opens none.
 */
export class MachineAsks {
  private readonly given = new Map<string, Given>()

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
  private ordinary(projectId: string): { id: string; name: string; state: SessionState }[] {
    return [...this.host.meta.values()]
      .filter((s) => s.projectId === projectId && s.kind === 'worker' && !s.appId && !this.host.builderRefOf(s))
      .map((s) => ({ id: s.id, name: s.name, state: s.state }))
  }

  private busy(sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    const run = this.host.agentRuns.get(sessionId)
    return !m || inTurn(m.state) || (!!run && !run.finished)
  }

  /** `hub.askProject`: one ask of a machine's session, as `ask_project` is here */
  async ask(machine: AskingMachine, p: HubAskParams, signal?: AbortSignal): Promise<HubAskResult> {
    this.prune()
    const shut = this.gate(machine)
    if (shut) return { ok: false, error: shut }
    const here = this.selfName()
    const projects = this.host.store.projects.listProjects()
    const wanted = p.project.trim()
    const target =
      projects.find((x) => x.id === wanted) ?? projects.find((x) => x.name === wanted) ?? projects.find((x) => x.name.toLowerCase() === wanted.toLowerCase())
    if (!target) {
      return { ok: false, error: `No project named "${oneLineText(wanted, 120)}" on ${here}. Its projects are: ${projects.map((x) => x.name).join(', ') || 'none'}.` }
    }
    const label = `${target.name} on ${here}`
    const mine = [...this.given.values()].filter((g) => g.machineId === machine.id && g.callerId === p.caller.sessionId && g.project === target.id)
    const wantedSession = p.session?.trim()
    if (!p.task && !wantedSession && mine.length === 1) return this.awaitGiven(mine[0]!, signal)
    const sessions = this.ordinary(target.id)
    const named = wantedSession ? sessions.filter((s) => s.name.toLowerCase() === wantedSession.toLowerCase()) : sessions
    const chosen = sessions.find((s) => s.id === wantedSession) ?? (named.length === 1 ? named[0] : undefined)
    if (!chosen) {
      const list = sessions.map((s) => JSON.stringify({ id: s.id, name: s.name, state: s.state })).join('\n')
      return {
        ok: false,
        error: sessions.length
          ? `${wantedSession ? `No unique ordinary session named "${oneLineText(wantedSession, 120)}" in ${label}. ` : ''}Name a session with the session argument. Sessions (name, state):\n${list}`
          : `${label} has no ordinary session. The person has to open one there; this call cannot create one.`,
      }
    }
    const key = this.keyOf(machine.id, p.caller.sessionId, chosen.id)
    const pending = this.given.get(key)
    if (pending && !p.task) return this.awaitGiven(pending, signal)
    const other = [...this.given.values()].find((g) => g.sessionId === chosen.id && !g.wait.finished)
    if (other) {
      return {
        ok: false,
        error:
          other === pending
            ? `${label} is still working on your last task in the session "${chosen.name}". Call ask_project again with that session and no task to wait for it.`
            : `The session "${chosen.name}" in ${label} is busy with another session's task. Name another session, or ask again later.`,
      }
    }
    if (!p.task) return { ok: false, error: `Give a task: what ${label} / ${chosen.name} should do.` }
    if (this.busy(chosen.id)) {
      return { ok: false, error: `The session "${chosen.name}" in ${label} is busy with a turn that is not yours (${chosen.state}). A note or a queue from another machine is not available: name another session, or ask again once it is idle.` }
    }

    // The pair's card (owner decision 2026-10-18): asked once, then remembered until withdrawn
    if (!this.host.store.machines.machineAskConsent(machine.id, p.caller.sessionId, target.id)) {
      const decision = await this.host.askHost(
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
        signal,
      )
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
    // The card stood while the person could use the session: nothing goes into a turn that is not the caller's
    const now = this.ordinary(target.id).find((s) => s.id === chosen.id)
    if (!now) return { ok: false, error: `The session "${chosen.name}" in ${label} is no longer available; nothing was sent.` }
    if (this.busy(chosen.id) || [...this.given.values()].some((g) => g.sessionId === chosen.id && !g.wait.finished)) {
      return { ok: false, error: `The session "${chosen.name}" in ${label} started a turn while the question to the person stood; nothing was sent. Ask again once it is idle, or name another session.` }
    }
    return this.give(machine, p, p.task, target, chosen, key, signal)
  }

  /** Hands the task over and waits for its turn: registered before the send, as the turn can end before it returns */
  private async give(
    machine: AskingMachine,
    p: HubAskParams,
    task: string,
    target: { id: string; name: string },
    chosen: { id: string; name: string },
    key: string,
    signal?: AbortSignal,
  ): Promise<HubAskResult> {
    let after = this.host.meta.get(chosen.id)?.lastSeq ?? 0
    const given: Given = {
      machineId: machine.id,
      callerId: p.caller.sessionId,
      sessionId: chosen.id,
      sessionName: chosen.name,
      project: target.id,
      wait: new AgentRunWait(
        (message) => (given.notice = message),
        () => this.host.meta.get(chosen.id)?.name ?? chosen.name,
        undefined,
        () => {
          const answer = turnAnswer(this.host.store.messages.loadMessages(chosen.id, 50), { afterSeq: after })
          after = this.host.meta.get(chosen.id)?.lastSeq ?? after
          return answer
        },
      ),
    }
    const depthKey = hubAskDepthKey(chosen.id)
    const done = () => {
      given.settledAt = Date.now()
      if (this.host.agentRuns.get(chosen.id) === given.wait) this.host.agentRuns.delete(chosen.id)
      this.host.store.settings.deleteAppSetting(depthKey)
    }
    void given.wait.done.then(done, done)
    this.given.set(key, given)
    this.host.agentRuns.set(chosen.id, given.wait)
    // One level below the asker on its machine (#867): the session cannot start agents or ask on past the depth
    this.host.store.settings.setAppSetting(depthKey, String(p.depth))
    const from = { sessionId: MACHINE_ASKER, name: `${oneLineText(p.caller.name, 120) || 'A session'} on ${machine.name}` }
    try {
      await this.host.deliver(chosen.id, askFrame(`${oneLineText(p.caller.project, 120) || 'a project'} on ${machine.name}`, task), undefined, from, false)
    } catch (e) {
      given.wait.fail(e as Error)
      this.given.delete(key)
      return { ok: false, error: `Could not hand the task to ${target.name} on ${this.selfName()}: ${(e as Error).message}` }
    }
    return this.awaitGiven(given, signal)
  }

  /** Waits for a given task up to the bound, as `awaitDelegation` does; its answer is read once */
  private async awaitGiven(g: Given, signal?: AbortSignal): Promise<HubAskResult> {
    const base = { project: this.host.store.projects.listProjects().find((x) => x.id === g.project)?.name ?? g.project, sessionId: g.sessionId, sessionName: g.sessionName }
    const outcome = g.wait.done.then(
      (r) => ({ ok: true as const, answer: r.answer ?? '' }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    )
    const r = await raceBound(outcome, ASK_WAIT_MS, signal)
    if (r === 'bound' || r === 'aborted') return { ok: true, state: 'working', ...base, ...(g.notice ? { notice: g.notice } : {}) }
    this.forget(g)
    if (!r.ok) return { ok: false, error: `${base.project}'s session "${g.sessionName}" on ${this.selfName()} did not finish: ${r.error}. Tell the person, or ask again with a clearer task.` }
    return { ok: true, state: 'done', ...base, answer: clipAnswer(r.answer, g.sessionName) }
  }

  private keyOf(machineId: string, callerId: string, sessionId: string): string {
    return `${machineId}/${callerId}>${sessionId}`
  }

  private forget(g: Given): void {
    for (const [k, v] of this.given) if (v === g) this.given.delete(k)
  }

  /** Answers nobody came back for are not kept for good */
  private prune(): void {
    const now = Date.now()
    for (const [k, g] of this.given) if (g.settledAt !== undefined && now - g.settledAt > UNREAD_KEPT_MS) this.given.delete(k)
  }
}
