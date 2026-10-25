import type { Delegation } from './child-ownership.js'
import { errorKindWord } from './error-kind.js'
import { ANSWER_READ_MAX_CHARS, ASK_WAIT_MS, answerAt, askFrame, awayFor, clipAnswer, matchProjects, pathsIn, projectChoice, taskLine, type AskableProject } from './ask-project.js'
import { labelOf, lastActiveOf, progressOf } from './transcript-view.js'
import type { HubAskParams, HubAskResult, SessionState } from '@cc/protocol'
import { awayPhrase } from '../adapters/contract.js'
import type { AskProjectResult, LinkedProject, LinkedSessions } from '../adapters/contract.js'
import { inTurn } from '../idle.js'
import { linkedTurnEnd, type LinkedTurnEvent } from './linked-turn-end.js'
import type { LinkedReports } from './linked-reports.js'
import { raceBound } from './with-timeout.js'
import { frameField } from '@cc/protocol'
import type { BackgroundTask } from '@cc/protocol'
import type { DelegationFlow, DelegationHost } from './delegation-flow.js'
import { agentDepthRefusal, depthOf } from './agent-depth.js'


/**
 * An ask_project call's task in a session of a linked machine, while its turn runs there (#700). The hub cannot see
 * that turn but through the machine's events, so the end of the turn is what `observeLinked` settles.
 */
type LinkedAsk = {
  callerId: string
  /** The machine's session, qualified */
  sessionId: string
  sessionName: string
  /** `<machine id>/<project name>`: how the caller names the project again, and how the answer names it */
  project: string
  /** Whether the turn was seen working, so a state the machine reports before it starts is not taken for its end */
  busy: boolean
  settled: boolean
  /** What the session waits on, when it waits on the person there (an approval, a question) */
  notice?: string
  /**
   * The session's own background work the turn ended with (#1457): the asker is owed the work's last turn end
   * (`LinkedReports.oweAsker`), and the answer to this call says the work is paused
   */
  paused?: BackgroundTask[]
  outcome: Promise<{ ok: true } | { ok: false; error: string }>
  settle(r: { ok: true } | { ok: false; error: string }): void
  /** The calls waiting on it, woken when the session stops on a card */
  wake: Set<() => void>
}

/**
 * The hubs that let this host's sessions ask their projects (#550, the reverse direction; `LinkedHubs` in
 * links/linked-hubs.ts): each hub's projects, their ids qualified by the hub's, and one ask into one of them
 */
export type HubsReader = {
  projects(): Promise<{
    projects: { id: string; projectId: string; name: string; hub: string; hubId: string; away?: string }[]
    away: { hubId: string; hub: string; why: string }[]
  }>
  ask(hubId: string, params: HubAskParams, signal?: AbortSignal): Promise<HubAskResult>
}

/**
 * What the ask_project flow reaches (#428): the session manager's members it reads, as `DelegationHost` types them,
 * and the delegation flow's members both flows share. The manager builds it with getters for its fields, so each is
 * read when used, never kept.
 */
export type AskProjectHost = Pick<DelegationHost, 'agentRuns' | 'applyDeferredRestart' | 'askHost' | 'autoBoundaryOpen' | 'builderRefOf' | 'busyAnswer' | 'busyChoices' | 'busyForCaller' | 'children' | 'deliver' | 'enqueue' | 'ensureProjectAccess' | 'linkedReader' | 'meta' | 'queuedOf' | 'readGrants' | 'routedCards' | 'store' | 'uiPreferences' | 'untilCard'> &
  Pick<DelegationFlow, 'awaitTurn' | 'grantReads' | 'handedOverReply' | 'startDelegation' | 'untilHandedOver'> & {
    /** The orchestrator's and the askers' reports from linked machines' sessions (linked-reports.ts) */
    readonly linkedReports: Pick<LinkedReports, 'oweAsker' | 'releaseAsker'>
  }

/**
 * ask_project (#371 part B): a session asks another project, here or on a linked machine (#700), and waits for the
 * answer. Split from the delegation flow (#428) as it was; the start_agent and agent_session side stays there.
 */
export class AskProjectFlow {
  constructor(private readonly host: AskProjectHost) {}

  /** ask_project's tasks in a linked machine's sessions (#700), by the session's qualified id */
  readonly linkedAsks = new Map<string, LinkedAsk>()

  /** The hubs linked to this host that let its sessions ask their projects (#550); none until main.ts gives them */
  hubs: HubsReader | null = null

  /**
   * A machine's link that is no longer connected ends the tasks asked of its sessions: their events stop reaching the
   * hub, so the turn's end would never be seen and the call would answer "still working" for good. The turn may well
   * go on there; the sentence says so, and where to look.
   */
  observeLinkLoss(machine: unknown): void {
    const m = machine as { id?: unknown; name?: unknown; status?: unknown } | null
    if (!m || typeof m.id !== 'string' || m.status === 'connected') return
    const name = typeof m.name === 'string' && m.name ? m.name : m.id
    for (const [sessionId, ask] of this.linkedAsks) {
      if (ask.settled || !sessionId.startsWith(`${m.id}.`)) continue
      ask.settle({ ok: false, error: `the link to ${name} dropped before the turn ended. The task was delivered and may still be running there; read the session once the link is back` })
    }
  }

  /** A linked machine's event for a session an ask_project is waiting on: the turn ends as `linkedTurnEnd` reads it (#166, #428) */
  observeLinkedAsk(ask: LinkedAsk, e: LinkedTurnEvent): void {
    if (ask.settled) return
    const step = linkedTurnEnd(ask.busy, e)
    if (!step) return
    if (step.step === 'busy') {
      ask.busy = true
      if (!step.waits) return
      ask.notice = step.waits === 'approval' ? 'it waits on the person to answer an approval there' : 'it waits on the person to answer a question there'
      for (const wake of [...ask.wake]) wake()
      return
    }
    if (step.step === 'card_closed') ask.notice = undefined
    else if (step.step === 'completed') {
      /*
       * A turn that completed with the session's own background work still running there is a pause, as a local child's
       * is (#721): decided on this event, so the work's later turn is owed to the asker from now on, whether or not the
       * call is still waiting. The report is kept before the call is told, and `LinkedReports.observe` reads the same
       * event after this and finds it paused already
       */
      const paused = this.host.linkedReports.oweAsker(ask.sessionId, ask.callerId, e)
      if (paused.length) ask.paused = paused
      ask.settle({ ok: true })
    }
    else if (step.step === 'failed') ask.settle({ ok: false, error: step.error })
    else ask.settle({ ok: false, error: 'the session was deleted there before its turn ended' })
  }

  /**
   * What ask_project rests on in the caller, read before its card, again once the person answered it, and again before a
   * queued ask goes in (`drainQueue`): a card or a queue can outlast any of it. `quiet`: an earlier read of this ask
   * already logged the `auto` boundary it opens, so this one does not log it again.
   */
  askGateError(callerId: string, quiet = false): string | null {
    const caller = this.host.meta.get(callerId)
    if (!caller?.projectId) return 'This session belongs to no project, so it cannot ask another one'
    /*
     * The agent depth (#867): the task makes a session in the other project work one level below this one, so it is
     * start_agent's limit too, and no preset opens it
     */
    const deep = agentDepthRefusal(this.host, callerId, 'ask a project')
    if (deep) return deep
    /*
     * Not from an untrusted project (owner decision 2026-10-11, #382), the rule attach_app already follows
     * (`AppAccess.gate`): text in a repository the person has not trusted could be what is asking, and the consent card
     * alone would then be the only thing between a planted instruction and another project's session.
     */
    if (this.host.store.projects.listProjects().find((p) => p.id === caller.projectId)?.trusted !== true && !this.host.autoBoundaryOpen(callerId, quiet ? undefined : 'delegate from an untrusted project')) {
      return "This session's project is not trusted, so it cannot ask another project — the person can trust it from the project menu."
    }
    return null
  }

  /** The project asked is still registered: the person may remove it while its card stands */
  private projectGoneError(target: { id: string; name: string }): string | null {
    if (this.host.store.projects.listProjects().some((p) => p.id === target.id)) return null
    return `${target.name} was removed from Centralu, so it was not reached.`
  }

  /**
   * ask_project (#371 part B): a session in one project asks another project to do a task, and gets its answer back.
   *
   *   1. The target is another registered project, named by name or id. Its own project is refused (do it here),
   *      and a session at the agent depth cannot ask (#867): at the default of 1, one itself asked by another project
   *      cannot ask a third, so two projects that consented to each other cannot bounce a task between them without a
   *      person.
   *   2. The person's consent for the pair (`ensureProjectAccess`, kind 'delegate').
   *   3. An existing ordinary session in the target, named by name or id; no creation or ownership change.
   *      Without a name exactly one is selected, otherwise its sessions are listed for the caller to choose.
   *   4. The task goes in a frame (`askFrame`) marked as sent by the caller, and the call waits for the turn, up to
   *      `ASK_WAIT_MS`. Past it the answer is "still working" and a call with no task waits again.
   *   5. The final answer comes back cut to size, and the paths it names inside the target project become readable
   *      to the caller (`readableGrants`).
   *
   * Stop on the caller, the call's own signal, or the person deleting either session ends the wait; the first two
   * stop an assigned idle target only while waiting; a task that joined the person's turn only ends the wait.
   */
  async askProject(callerId: string, opts: { project: string; session?: string; task?: string; ifBusy?: 'note' | 'queue' }, signal?: AbortSignal): Promise<AskProjectResult> {
    const refused = this.askGateError(callerId)
    if (refused) return { ok: false, error: refused }
    // The gate read both; read here once more, with no wait in between, so the caller's project is known for what follows
    const caller = this.host.meta.get(callerId)
    const callerProjectId = caller?.projectId
    if (!caller || !callerProjectId) return { ok: false, error: 'This session belongs to no project, so it cannot ask another one' }
    const projects = this.host.store.projects.listProjects()
    const wanted = opts.project.trim()
    /*
     * The projects on linked machines count too (#700): a unique bare name works, `<machine>/<name>` or a qualified id
     * always does, and the same name on two machines is refused with both listed. A local id is exact, so it needs no
     * round trip to the machines.
     */
    const reader = this.host.linkedReader
    const exactHere = projects.some((p) => p.id === wanted)
    /*
     * And the projects of the hubs that let this host's sessions ask them (#550), each under the hub's own name, the same
     * rules as a linked machine's: `<hub>/<name>`, a qualified id, or a unique bare name
     */
    const hubs = this.hubs
    const none = { projects: [], away: [], machines: [] }
    // Nothing is awaited when neither is asked: a call naming a project of this computer by id goes on in the same tick
    const [first, fromHubs] =
      (reader || hubs) && !exactHere ? await Promise.all([reader ? reader.projects({ ref: wanted }) : none, hubs ? hubs.projects() : none]) : [none, none]
    let there = first
    const askableOf = (): AskableProject[] => [
      ...projects.map((p) => ({ id: p.id, name: p.name, machine: null, machineId: null })),
      ...there.projects.map((p) => ({ id: p.id, name: p.name, machine: p.machine, machineId: p.machineId })),
      ...fromHubs.projects.map((p) => ({ id: p.id, name: p.name, machine: p.hub, machineId: p.hubId })),
    ]
    let found = matchProjects(wanted, askableOf())
    // Nowhere (#1547): the mirror of a machine that is down may lack a project made since, so those are tried now, once, bounded
    if (!found.length && reader && !exactHere) {
      there = await reader.projects({ ref: wanted, anyDown: true, prior: there })
      found = matchProjects(wanted, askableOf())
    }
    const awayAll = [...there.away, ...fromHubs.away.map((a) => ({ machineId: a.hubId, machine: a.hub, why: a.why }))]
    const elsewhere = !!reader || fromHubs.projects.length > 0 || fromHubs.away.length > 0
    if (found.length > 1) {
      return {
        ok: false,
        error: `More than one project is called "${wanted}": ${found.map(projectChoice).join('; ')}. Ask again with the id of the one you mean, or machine/name for a project on a linked machine.`,
      }
    }
    if (!found[0]) {
      const slash = wanted.indexOf('/')
      const prefix = slash > 0 ? wanted.slice(0, slash).trim().toLowerCase() : null
      const down = awayAll.find((a) => a.machineId === prefix || a.machine.toLowerCase() === prefix || wanted.startsWith(`${a.machineId}.`))
      if (down) return { ok: false, error: `${down.machine} ${awayPhrase(down.why)}, so "${wanted}" cannot be asked there. Try again once its link is back.` }
      const others = [
        ...projects.filter((p) => p.id !== caller.projectId).map((p) => (elsewhere ? `${p.name} (this computer)` : p.name)),
        ...there.projects.map((p) => `${p.name} (on ${p.machine}${p.away ? `, ${p.away}` : ''})`),
        ...fromHubs.projects.map((p) => `${p.name} (on ${p.hub}${p.away ? `, ${p.away}` : ''})`),
      ]
      const missing = awayFor(wanted, awayAll, [...there.machines.map((m) => m.machineId), ...fromHubs.projects.map((p) => p.hubId)])
      const unasked = missing.length ? ` Not asked, and its projects may be missing: ${missing.map((a) => `${a.machine} (${a.why})`).join(', ')}.` : ''
      return {
        ok: false,
        error: others.length
          ? `No project named "${wanted}". The other projects are: ${others.join(', ')}.${unasked}`
          : `No project named "${wanted}" — this is the only project in Centralu.${unasked}`,
      }
    }
    const hubTarget = fromHubs.projects.find((p) => p.id === found[0]!.id)
    if (hubs && hubTarget) {
      const callerProject = projects.find((p) => p.id === caller.projectId)?.name ?? 'another project'
      return this.askHubProject(callerId, callerProject, hubTarget, hubs, opts, signal)
    }
    const remoteTarget = there.projects.find((p) => p.id === found[0]!.id)
    if (reader && remoteTarget) {
      const callerProject = projects.find((p) => p.id === caller.projectId)?.name ?? 'another project'
      return this.askLinkedProject(callerId, callerProjectId, callerProject, remoteTarget, reader, opts, signal)
    }
    const target = projects.find((p) => p.id === found[0]!.id)!
    if (target.id === caller.projectId) return { ok: false, error: `${target.name} is this session's own project — do the work here.` }

    const candidates = [...this.host.meta.values()].filter((s) =>
      s.projectId === target.id && s.kind === 'worker' && !s.appId && !this.host.builderRefOf(s),
    )
    const list = () => candidates.map((s) => JSON.stringify({
      id: s.id, name: s.name, state: s.state, lastActive: lastActiveOf(this.host.store.messages, s.id) ?? null,
    })).join('\n')
    const wantedSession = opts.session?.trim()
    // A bounded call can keep waiting even when the person has since opened another session.
    const outstanding = [...this.host.children.delegations.entries()].filter(([, d]) =>
      d.callerId === callerId && d.target.id === target.id && !d.agent,
    )
    // A wait on a delegation a handoff gave away (#693): where it went, not another session's answer
    if (!opts.task && !outstanding.length) {
      const named = (id: string) => !wantedSession || id === wantedSession || this.host.meta.get(id)?.name.toLowerCase() === wantedSession.toLowerCase()
      const gone = [...this.host.children.handedOver].find(([id, h]) => h.from === callerId && this.host.meta.get(id)?.projectId === target.id && named(id))
      if (gone) return this.host.handedOverReply(callerId, gone[0])
    }
    if (!opts.task && !wantedSession && outstanding.length === 1) {
      const [key, pending] = outstanding[0]!
      return this.awaitDelegation(key, pending, signal)
    }
    const named = wantedSession
      ? candidates.filter((s) => s.name.toLowerCase() === wantedSession.toLowerCase())
      : candidates
    const chosen = candidates.find((s) => s.id === wantedSession) ?? (named.length === 1 ? named[0] : undefined)
    if (!chosen) {
      return { ok: false, error: candidates.length
        ? `${wantedSession ? `No unique ordinary session named "${wantedSession}" in ${target.name}. ` : ''}Name a session with the session argument. Sessions (name, state, last active):\n${list()}`
        : `${target.name} has no ordinary session. The person has to open one there; this call cannot create one.` }
    }
    const key = `${callerId}>${target.id}>${chosen.id}`
    const pending = this.host.children.delegations.get(key)
    if (pending && !opts.task) return this.awaitDelegation(key, pending, signal)
    // A request of the caller's still queued there (#677): where it stands
    const held = !opts.task ? this.host.queuedOf(callerId, chosen.id) : undefined
    if (held?.ok && held.state === 'queued') return { ok: true, project: target.name, state: 'queued', sessionId: held.sessionId, sessionName: held.sessionName, queueId: held.queueId, position: held.position }
    const stillWorking = { ok: false as const, error: `${target.name} is still working on your last task in the session "${chosen.name}". Call ask_project with project "${target.name}", session "${chosen.id}" and no task to wait for it.` }
    if (pending && !pending.settled) return stillWorking
    if (!opts.task) return { ok: false, error: `Give a task: what ${target.name} / ${chosen.name} should do.` }

    const available = (): string | undefined => {
      const current = this.host.meta.get(chosen.id)
      if (!current || current.projectId !== target.id || current.kind !== 'worker' || current.appId || this.host.builderRefOf(current)) return 'The chosen session is no longer available'
    }
    const gone = available()
    if (gone) return { ok: false, error: gone }
    /*
     * Busy with a turn that is not the caller's (#677): the caller chooses. A note joins the running turn (auto only,
     * #606); a queue holds the task for a new turn when it ends. No fork across projects: ask_project never creates a
     * session in another project. Without `ifBusy` nothing is asked or sent, and the choices come back.
     */
    const busyNow = this.host.busyForCaller(callerId, chosen.id)
    if (busyNow && !opts.ifBusy) return { ok: true, project: target.name, ...this.host.busyAnswer(callerId, chosen, 'ask_project') }
    if (busyNow && opts.ifBusy === 'note') {
      const note = this.host.busyChoices(callerId, chosen, 'ask_project').find((c) => c.choice === 'note')!
      if (!note.available) return { ok: false, error: `No note to "${chosen.name}": ${note.why}. Queue it instead (ifBusy "queue").` }
    }
    const consent = await this.host.ensureProjectAccess(callerId, target.id, 'delegate', {
      text: taskLine(opts.task), session: { id: chosen.id, name: chosen.name },
    }, signal)
    // The card may have stood a while: what the ask rests on is read again, and its reason comes before the card's
    const after = this.askGateError(callerId) ?? this.projectGoneError(target)
    if (after) return { ok: false, error: after }
    if (!consent.ok) return consent
    // Consent can wait while the person deletes or starts work in the chosen session.
    const changed = available()
    if (changed) return { ok: false, error: changed }
    if (signal?.aborted) return { ok: false, error: 'The call was cancelled before delivery' }
    /*
     * Read again after the card (#839): another call of this caller's with a task for this session may have gone in
     * meanwhile. Its turn is the caller's own, so the busy check below lets this one through, and its delegation would be
     * replaced. Nothing is awaited from here to `startDelegation`.
     */
    const current = this.host.children.delegations.get(key)
    if (current && current !== pending && !current.settled) return stillWorking
    const busyAfter = this.host.busyForCaller(callerId, chosen.id)
    if (busyAfter && opts.ifBusy === 'queue') {
      const current = this.host.meta.get(chosen.id)!
      return { ok: true, project: target.name, ...this.host.enqueue(callerId, current, 'ask_project', opts.task) }
    }
    if (busyAfter) {
      // It became busy while the card stood, or the note it chose is no longer possible: the choices, again
      const note = this.host.busyChoices(callerId, this.host.meta.get(chosen.id)!, 'ask_project').find((c) => c.choice === 'note')!
      if (opts.ifBusy !== 'note' || !note.available) return { ok: true, project: target.name, ...this.host.busyAnswer(callerId, this.host.meta.get(chosen.id)!, 'ask_project') }
      this.host.autoBoundaryOpen(callerId, 'a note into a turn that is not its own')
    }
    if (pending) this.host.children.dropDelegation(key)
    const delegatedId = chosen.id
    const midTurn = inTurn(this.host.meta.get(delegatedId)!.state)
    let releaseInput: (() => void) | undefined
    const d = this.host.startDelegation(key, callerId, delegatedId, target, false, midTurn)
    const callerProject = projects.find((p) => p.id === caller.projectId)?.name ?? 'another project'
    try {
      const from = { sessionId: callerId, name: labelOf(this.host.store.messages, caller) }
      /*
       * Read again once the session is awake: waking or restarting it takes seconds, and the gates can close meanwhile.
       * An untrusted project's `auto` boundary was logged by the read after the card, with no wait since; one that lost
       * its trust during the wake is logged then
       */
      const logged = this.host.store.projects.listProjects().find((p) => p.id === callerProjectId)?.trusted !== true
      const stillAllowed = () => this.askGateError(callerId, logged) ?? this.projectGoneError(target)
      if (midTurn) {
        const releaseHold = d.wait.holdInput()
        const release = () => { releaseHold(); this.host.applyDeferredRestart(delegatedId) }
        releaseInput = release
        await this.host.deliver(delegatedId, askFrame(callerProject, opts.task, { name: from.name, sessionId: callerId }), undefined, from, false, undefined, 'inline', (h, input) => {
          const fail = (e: Error) => { d.wait.fail(e); release() }
          void h.sendTracked!(input, { complete: release, fail }).then(release, fail)
        }, stillAllowed)
      } else {
        await this.host.deliver(delegatedId, askFrame(callerProject, opts.task, { name: from.name, sessionId: callerId }), undefined, from, false, undefined, 'inline', undefined, stillAllowed)
      }
    } catch (e) {
      d.wait.fail(e as Error)
      releaseInput?.()
      this.host.children.dropDelegation(key, d)
      if (this.host.agentRuns.get(delegatedId) === d.wait) this.host.agentRuns.delete(delegatedId)
      return { ok: false, error: `Could not hand the task to ${target.name}: ${(e as Error).message}` }
    }
    this.host.children.delegated(callerId, delegatedId, 'ask_project', opts.task)
    return this.awaitDelegation(key, d, signal)
  }

  /**
   * ask_project to a project on a linked machine (#700, docs/plans/remote-hub.md §12.2 step 3). The same call as for a
   * project here, run through the links: the existing ordinary session is chosen by name or id, the person's consent
   * is asked for this call (a card that names the machine; "always" is read as allow once, as `create_project`'s is,
   * since a remembered consent is a row tied to two projects of this computer), the task is delivered as the hub's
   * instruction (`host.send`), and the turn is waited on through the machine's events. The session runs on that
   * machine, with its own logins and folder, under the preset it has. The answer comes back as everywhere else; the
   * paths it names are that machine's files and are listed, none opened to the caller.
   *
   * Not here yet: a note or a queue into a busy session (`ifBusy`), cards of the machine's session answered by the
   * caller (the person answers them in the hub's window), and stopping the machine's turn when the call is cancelled.
   */
  private async askLinkedProject(
    callerId: string,
    callerProjectId: string,
    callerProject: string,
    target: LinkedProject,
    reader: LinkedSessions,
    opts: { session?: string; task?: string; ifBusy?: 'note' | 'queue' },
    signal?: AbortSignal,
  ): Promise<AskProjectResult> {
    const label = `${target.name} on ${target.machine}`
    const project = `${target.machineId}/${target.name}`
    if (target.away) {
      // A task already given there: the machine is down, and what became of it is the answer, not a refusal to ask
      const given = [...this.linkedAsks.values()].filter((a) => a.callerId === callerId && a.project === project && (!opts.session || a.sessionId === opts.session.trim()))
      if (!opts.task && given.length === 1) return this.awaitLinkedAsk(given[0]!, reader, signal)
      return { ok: false, error: `${target.machine} ${awayPhrase(target.away)}, so ${label} cannot be asked. Try again once its link is back.` }
    }
    const listed = await reader.projectSessions(target)
    if (!listed.ok) return listed
    const sessions = listed.sessions
    const wantedSession = opts.session?.trim()
    // A turn that ended without its event reaching the hub (the link was down) is over once the machine says the session is out of its turn
    for (const s of sessions) {
      const stale = this.linkedAsks.get(s.id)
      if (stale && !stale.settled && stale.busy && !inTurn(s.state as SessionState)) stale.settle({ ok: true })
    }
    const mine = sessions.filter((s) => {
      const ask = this.linkedAsks.get(s.id)
      return ask && ask.callerId === callerId
    })
    if (!opts.task && !wantedSession && mine.length === 1) return this.awaitLinkedAsk(this.linkedAsks.get(mine[0]!.id)!, reader, signal)
    const named = wantedSession ? sessions.filter((s) => s.name.toLowerCase() === wantedSession.toLowerCase()) : sessions
    const chosen = sessions.find((s) => s.id === wantedSession) ?? (named.length === 1 ? named[0] : undefined)
    if (!chosen) {
      const list = sessions.map((s) => JSON.stringify({ id: s.id, name: s.name, state: s.state })).join('\n')
      return { ok: false, error: sessions.length
        ? `${wantedSession ? `No unique ordinary session named "${wantedSession}" in ${label}. ` : ''}Name a session with the session argument. Sessions (name, state):\n${list}`
        : `${label} has no ordinary session. The person has to open one there; this call cannot create one.` }
    }
    const pending = this.linkedAsks.get(chosen.id)
    if (pending && pending.callerId === callerId && !opts.task) return this.awaitLinkedAsk(pending, reader, signal)
    if (pending && !pending.settled) {
      return { ok: false, error: pending.callerId === callerId
        ? `${label} is still working on your last task in the session "${chosen.name}". Call ask_project with project "${project}", session "${chosen.id}" and no task to wait for it.`
        : `The session "${chosen.name}" in ${label} is busy with another session's task. Name another session, or ask again later.` }
    }
    if (!opts.task) return { ok: false, error: `Give a task: what ${label} / ${chosen.name} should do.` }
    if (inTurn(chosen.state as SessionState)) {
      return { ok: false, error: `The session "${chosen.name}" in ${label} is busy with a turn that is not yours (${chosen.state}). A note or a queue into a session on another machine is not available yet: name another session, or ask again once it is idle.` }
    }

    const decision = await this.host.askHost(
      callerId,
      {
        kind: 'project_access',
        access: 'delegate',
        from: { id: callerProjectId, name: callerProject },
        to: { id: target.id, name: target.name, machine: target.machine, ...(target.trusted !== undefined ? { trusted: target.trusted } : {}) },
        text: taskLine(opts.task),
        session: { id: chosen.id, name: chosen.name },
      },
      signal,
    )
    // The card may have stood a while: what the ask rests on in the caller is read again, and its reason comes first
    const after = this.askGateError(callerId)
    if (after) return { ok: false, error: after }
    if (decision === 'deny') return { ok: false, error: `The person did not allow ${callerProject} to reach ${label} this way. Do not ask again unless they tell you to.` }
    if (decision === null) return { ok: false, error: `The question to the person was withdrawn before they answered, so ${label} was not reached.` }
    if (signal?.aborted) return { ok: false, error: 'The call was cancelled before delivery' }
    /*
     * The card stood while the person could use the session there: ask the machine again before anything is sent. A
     * task sent into a turn that is not the caller's would join it (and its end would settle this call), the very
     * thing the busy refusal above keeps out. A note or a queue is not available across machines, so this refuses.
     */
    const again = await reader.projectSessions(target)
    if (!again.ok) return { ok: false, error: `Could not hand the task to ${label}: ${again.error}` }
    const now = again.sessions.find((s) => s.id === chosen.id)
    if (!now) return { ok: false, error: `The session "${chosen.name}" in ${label} is no longer available; nothing was sent.` }
    if (inTurn(now.state as SessionState)) {
      return { ok: false, error: `The session "${chosen.name}" in ${label} started a turn of its own while the question to the person stood (${now.state}); nothing was sent. Ask again once it is idle, or name another session.` }
    }
    const taken = this.linkedAsks.get(chosen.id)
    if (taken && !taken.settled) return { ok: false, error: `The session "${chosen.name}" in ${label} was given another task while the question stood; nothing was sent. Name another session, or ask again later.` }
    // Asking the machine again took a moment: the caller's gates once more, with no wait from here to the send
    const late = this.askGateError(callerId)
    if (late) return { ok: false, error: late }

    let settle!: LinkedAsk['settle']
    const outcome = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => (settle = resolve))
    const ask: LinkedAsk = {
      callerId, sessionId: chosen.id, sessionName: chosen.name, project, busy: false, settled: false, outcome, wake: new Set(),
      settle: (r) => {
        if (ask.settled) return
        ask.settled = true
        settle(r)
      },
    }
    /*
     * The earlier task's pause ends with this one (#721): this ask's own end is what the asker hears, so the report kept
     * for the earlier work is not delivered a second time. Put back if the send fails, since that work still runs
     */
    const putBack = this.host.linkedReports.releaseAsker(chosen.id, callerId)
    // Registered before the send: the machine's first events can reach the hub before its answer does
    this.linkedAsks.set(chosen.id, ask)
    // The machine counts its session one level below the caller while it works on this (#838): the depth holds across machines
    const asker = labelOf(this.host.store.messages, this.host.meta.get(callerId)!)
    const sent = await reader.send(chosen.id, askFrame(callerProject, opts.task, { name: asker, sessionId: callerId }), asker, { depth: depthOf(this.host, callerId) + 1 })
    if (!sent.ok) {
      if (this.linkedAsks.get(chosen.id) === ask) this.linkedAsks.delete(chosen.id)
      putBack?.()
      return { ok: false, error: `Could not hand the task to ${label}: ${sent.error}` }
    }
    return this.awaitLinkedAsk(ask, reader, signal)
  }

  /**
   * ask_project into a project of a hub linked to this host (#550, the reverse direction; docs/plans/remote-hub.md
   * §12.7). The hub does the rest, as an ask there would: its card for the pair (that hub's windows answer it; once
   * approved, the pair passes until the person withdraws it), the existing ordinary session, the delivery and the wait.
   * This side sends who asks and at which depth, and reads the answer: someone else's words, cut to size, and paths
   * that name the hub's files, listed and none opened. A call cancelled here is withdrawn there (`call.cancel`), which
   * withdraws a card still standing.
   */
  private async askHubProject(
    callerId: string,
    callerProject: string,
    target: { id: string; projectId: string; name: string; hub: string; hubId: string; away?: string },
    hubs: HubsReader,
    opts: { session?: string; task?: string },
    signal?: AbortSignal,
  ): Promise<AskProjectResult> {
    const label = `${target.name} on ${target.hub}`
    const project = `${target.hubId}/${target.name}`
    if (target.away) return { ok: false, error: `${target.hub} ${awayPhrase(target.away)}, so ${label} cannot be asked. Try again once its link is back.` }
    const prefix = `${target.hubId}.`
    const session = opts.session?.trim()
    const r = await hubs.ask(
      target.hubId,
      {
        caller: { sessionId: callerId, name: labelOf(this.host.store.messages, this.host.meta.get(callerId)!), project: callerProject },
        project: target.projectId,
        ...(session ? { session: session.startsWith(prefix) ? session.slice(prefix.length) : session } : {}),
        ...(opts.task ? { task: opts.task } : {}),
        // The hub counts its session one level below this caller while it works on the task (#867, #838)
        depth: depthOf(this.host, callerId) + 1,
      },
      signal,
    )
    if (!r.ok) return { ok: false, error: r.error }
    const base = { project, sessionId: `${prefix}${r.sessionId}`, sessionName: r.sessionName }
    if (r.state === 'working') return { ok: true, state: 'working', ...base, ...(r.notice ? { notice: r.notice } : {}) }
    const answer = r.answer ?? ''
    // Paths in the answer are the hub's files: listed, not opened to the caller
    return { ok: true, state: 'done', ...base, answer: clipAnswer(answer, r.sessionName), readable: [], outside: pathsIn(answer) }
  }

  /** Waits for a linked machine's turn up to the bound, as `awaitDelegation` does, and reads its answer there */
  private async awaitLinkedAsk(ask: LinkedAsk, reader: LinkedSessions, signal?: AbortSignal): Promise<AskProjectResult> {
    const working = (): AskProjectResult => ({
      ok: true, state: 'working', project: ask.project, sessionId: ask.sessionId, sessionName: ask.sessionName,
      ...(ask.notice ? { notice: ask.notice } : {}),
    })
    if (!ask.settled && ask.notice) return working()
    let wake: (() => void) | undefined
    const asked = new Promise<'asked'>((resolve) => ask.wake.add((wake = () => resolve('asked'))))
    try {
      const r = await raceBound(ask.outcome, ASK_WAIT_MS, signal, asked)
      if (r === 'asked' || r === 'bound') return working()
      if (r === 'aborted') {
        // The turn runs on the machine and this host cannot stop it from here: the call stops waiting and says so
        return { ok: false, error: `The call was cancelled; ${ask.project}'s session "${ask.sessionName}" was left running.` }
      }
      if (this.linkedAsks.get(ask.sessionId) === ask) this.linkedAsks.delete(ask.sessionId)
      if (!r.ok) return { ok: false, error: `${ask.project}'s session "${ask.sessionName}" [${ask.sessionId}] did not finish: ${r.error}. Tell the person, or ask again with a clearer task.` }
      // Its last words, read there: the whole text, cut here as an answer is cut everywhere
      const words = await reader.lastWords(ask.sessionId, ANSWER_READ_MAX_CHARS).catch((e: Error) => ({ ok: false as const, error: e.message }))
      // A read that failed is said, not handed back as an empty answer (#1186): the turn ended, and the task is done there
      if (!words.ok) {
        return { ok: false, error: `${ask.project}'s session "${ask.sessionName}" [${ask.sessionId}] ended its turn, but its answer could not be read there (${words.error}). Do not give the task again: read it with read_session(sessionId="${ask.sessionId}") once that machine answers.` }
      }
      const answer = words.text
      return {
        ok: true,
        state: 'done',
        project: ask.project,
        sessionId: ask.sessionId,
        sessionName: ask.sessionName,
        answer: clipAnswer(answer, ask.sessionName, words.seq !== null ? { sessionId: ask.sessionId, seq: words.seq } : undefined),
        // Paths in the answer are that machine's: listed, not opened to the caller
        readable: [],
        outside: pathsIn(answer),
        // Still paused only while that report is owed: collected after the work's report went out, these are its final words
        ...(ask.paused && this.host.children.linkedReports.get(ask.sessionId)?.orchestratorId === ask.callerId ? { paused: pausedWords(ask.paused ?? [], ask.sessionId, ' there') } : {}),
      }
    } finally {
      if (wake) ask.wake.delete(wake)
    }
  }

  /** Waits for a delegation up to the bound (`awaitTurn`), and turns its outcome into what the caller reads */
  private async awaitDelegation(key: string, d: Delegation, signal?: AbortSignal): Promise<AskProjectResult> {
    const sessionName = () => this.host.meta.get(d.sessionId)?.name ?? d.sessionId
    const base = { project: d.target.name, sessionId: d.sessionId }
    const r = await this.host.awaitTurn(key, d, { signal, stopWhy: 'the call that asked was cancelled' })
    switch (r.kind) {
      case 'handedOver':
        return this.host.handedOverReply(r.owner, d.sessionId)
      case 'asking':
        return { ok: true, state: 'asking', ...base, sessionName: sessionName(), cards: r.cards }
      case 'working':
      case 'bound': {
        const notice = r.kind === 'bound' ? d.notice() : undefined
        // Where its turn is (#1186): a session at work and one stuck read the same before
        const progress = progressOf(this.host.store.messages, d.sessionId)
        return { ok: true, state: 'working', ...base, sessionName: sessionName(), ...(notice ? { notice } : {}), ...(progress ? { progress } : {}) }
      }
      case 'cancelled':
        return { ok: false, error: d.joinedTurn
          ? `The call was cancelled; ${d.target.name}'s session "${sessionName()}" was left running.`
          : `The call was cancelled, so ${d.target.name}'s session "${sessionName()}" was stopped.` }
      case 'failed':
        this.host.children.answered(d.callerId, d.sessionId, { ok: false, error: errorKindWord(r.error) })
        return {
          ok: false,
          error: d.joinedTurn
            ? `The wait for ${d.target.name}'s session "${sessionName()}" [${d.sessionId}] ended: ${r.error}.`
            : `${d.target.name}'s session "${sessionName()}" [${d.sessionId}] did not finish: ${r.error}. Tell the person, or ask again with a clearer task.`,
        }
    }
    const { granted, outside } = this.host.grantReads(d.callerId, r.answer, d.target.path)
    /*
     * A turn that completed with the session's own background work still running was paused where the delegation ended
     * (`startDelegation`, #721, #1460), whether or not this call was waiting: the caller reads the answer now as a pause,
     * with no separate notice, and the report is owed for the work's last turn end
     */
    const paused = this.host.children.awaitingReport.get(d.sessionId) === d.callerId ? this.host.children.pausedReports.get(d.sessionId) : undefined
    this.host.children.answered(d.callerId, d.sessionId, paused ? undefined : { ok: true, text: r.answer })
    return {
      ok: true, state: 'done', ...base, sessionName: sessionName(), answer: clipAnswer(r.answer, sessionName(), answerAt(this.host.store.messages, d.sessionId, r.answer)), readable: granted, outside,
      ...(paused ? { paused: pausedWords(paused, d.sessionId) } : {}),
    }
  }

}

/**
 * What the caller reads of a turn that ended with the session's own background work still running (#721, #1457): the
 * words of `DelegationWaits.pausedNotice` without the `agent_session stop`, which an ask_project target does not have.
 * The work may be a server that never ends, and the report comes only if it does
 */
function pausedWords(tasks: readonly { description: string }[], sessionId: string, there = ''): string {
  return (
    `its turn ended while its own background work is still running${there} (${tasks.map((t) => frameField(t.description)).join(', ')}), so the answer is what it said so far. ` +
    'A final report follows when that work ends and a turn ends it. If that work is a server or watcher it leaves running, ' +
    `this answer may be its final one. Read the session with read_session(sessionId="${sessionId}").`
  )
}
