import type { Delegation } from './child-ownership.js'
import { errorKindWord } from './error-kind.js'
import { ASK_WAIT_MS, answerAt, askFrame, awayFor, clipAnswer, matchProjects, pathsIn, pickAskedSession, projectChoice, taskLine, type AskableProject } from './ask-project.js'
import { awayRefusal } from '../links/machine-reach.js'
import { labelOf, lastActiveOf, progressOf } from './transcript-view.js'
import type { HubAskParams, HubAskResult } from '@cc/protocol'
import type { AskProjectResult, LinkedProject, LinkedSessions } from '../adapters/contract.js'
import { frameField, liveBackgroundTasks } from '@cc/protocol'
import type { DelegationFlow, DelegationHost } from './delegation-flow.js'
import { agentDepthRefusal, depthOf } from './agent-depth.js'
import { isOrdinary } from './tool-profiles.js'
import { parseAddress, sessionAddress } from '../mail/address.js'
import { heldLine } from '../mail/across-core.js'
import { linkedWords } from './remote-agents.js'
import { unfinished } from '../mail/delegation.js'

/**
 * The hubs that let this host's sessions ask their projects (#550, the reverse direction; `LinkedHubs` in
 * links/linked-hubs.ts): each hub's projects, their ids under the hub's label, and one ask into one of them
 */
export type HubsReader = {
  projects(): Promise<{
    projects: { id: string; projectId: string; name: string; hub: string; hubId: string; label: string; away?: string }[]
    away: { hubId: string; hub: string; label: string; why: string }[]
  }>
  ask(hubId: string, params: HubAskParams, signal?: AbortSignal): Promise<HubAskResult>
}

/**
 * What the ask_project flow reaches (#428): the session manager's members it reads, as `DelegationHost` types them,
 * and the delegation flow's members both flows share. The manager builds it with getters for its fields, so each is
 * read when used, never kept.
 */
export type AskProjectHost = Pick<DelegationHost, 'agentRuns' | 'hostCards' | 'restartPolicy' | 'autoBoundaryOpen' | 'trustGate' | 'projectTrusted' | 'takesSendNow' | 'mailTask' | 'linkedTasks' | 'linkedReports' | 'ownTasksRunning' | 'children' | 'deliver' | 'ensureProjectAccess' | 'linkedReader' | 'meta' | 'readGrants' | 'refusesDelegation' | 'routedCards' | 'store' | 'uiPreferences' | 'untilCard'> &
  {
    readonly delegationFlow: Pick<DelegationFlow, 'awaitTurn' | 'grantReads' | 'handedOverReply' | 'delegate'>
  }

/**
 * An ask_project task on another computer, as its call names it: the session there (qualified, `<machine or hub id>.<id>`), as `ChildOwnership.answered`
 * takes it (`child`: a hub's, by its address), and the project
 */
type AskAcross = { taskId: string; sessionId: string; child: string; sessionName: string; project: string }

/**
 * ask_project (#371 part B): a session asks another project, here or on a linked machine (#700), and waits for the
 * answer. Split from the delegation flow (#428) as it was; the start_agent and agent_session side stays there.
 */
export class AskProjectFlow {
  constructor(private readonly host: AskProjectHost) {}

  /** The hubs linked to this host that let its sessions ask their projects (#550); none until main.ts gives them */
  hubs: HubsReader | null = null

  /**
   * What ask_project rests on in the caller, read before its card and again once the person answered it: a card can outlast
   * any of it. `quiet`: an earlier read of this ask
   * already logged the `auto` boundary it opens, so this one does not log it again. `trust`: false leaves the project's
   * trust out, for the one read that decides it once the target is known (§7.4).
   */
  askGateError(callerId: string, quiet = false, trust = true): string | null {
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
    return trust ? this.host.trustGate(callerId, caller.projectId, 'asking another project', quiet) : null
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
  async askProject(callerId: string, opts: { project: string; session?: string; task?: string }, signal?: AbortSignal): Promise<AskProjectResult> {
    const refused = this.askGateError(callerId, false, false)
    if (refused) return { ok: false, error: refused }
    /*
     * The project's trust is read now and answered once the target is known (docs/plans/mailbox.md §7.4): a task out of an
     * untrusted project is the mailbox's to refuse (S15), which records it for the person. Until then every refusal is
     * the trust sentence, as before, so an untrusted caller learns nothing of the other projects
     */
    const untrusted = this.askGateError(callerId)
    const fail = (error: string) => ({ ok: false as const, error: untrusted ?? error })
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
      ...fromHubs.projects.map((p) => ({ id: p.id, name: p.name, machine: p.hub, machineId: p.hubId, label: p.label })),
    ]
    // An older build printed a hub's projects under the hub's id (`<hub id>.<id>`, `<hub id>/<name>`): read under its label
    const older = [...fromHubs.projects, ...fromHubs.away].find((p) => wanted.startsWith(`${p.hubId}.`) || wanted.startsWith(`${p.hubId}/`))
    const sought = older ? `${older.label}${wanted.slice(older.hubId.length)}` : wanted
    let found = matchProjects(sought, askableOf())
    // Nowhere (#1547): the mirror of a machine that is down may lack a project made since, so those are tried now, once, bounded
    if (!found.length && reader && !exactHere) {
      there = await reader.projects({ ref: wanted, anyDown: true, prior: there })
      found = matchProjects(sought, askableOf())
    }
    const awayAll = [...there.away, ...fromHubs.away.map((a) => ({ machineId: a.label, machine: a.hub, why: a.why }))]
    const elsewhere = !!reader || fromHubs.projects.length > 0 || fromHubs.away.length > 0
    if (found.length > 1) {
      return fail(`More than one project is called "${wanted}": ${found.map(projectChoice).join('; ')}. Ask again with the id of the one you mean, or machine/name for a project on a linked machine.`)
    }
    if (!found[0]) {
      const slash = sought.indexOf('/')
      const prefix = slash > 0 ? sought.slice(0, slash).trim().toLowerCase() : null
      const down = awayAll.find((a) => a.machineId === prefix || a.machine.toLowerCase() === prefix || sought.startsWith(`${a.machineId}.`))
      if (down) return fail(awayRefusal(down.machine, down.why, `"${wanted}" cannot be asked there`))
      const others = [
        ...projects.filter((p) => p.id !== caller.projectId).map((p) => (elsewhere ? `${p.name} (this computer)` : p.name)),
        ...there.projects.map((p) => `${p.name} (on ${p.machine}${p.away ? `, ${p.away}` : ''})`),
        ...fromHubs.projects.map((p) => `${p.name} (on ${p.hub}${p.away ? `, ${p.away}` : ''})`),
      ]
      const missing = awayFor(sought, awayAll, [...there.machines.map((m) => m.machineId), ...fromHubs.projects.map((p) => p.label)])
      const unasked = missing.length ? ` Not asked, and its projects may be missing: ${missing.map((a) => `${a.machine} (${a.why})`).join(', ')}.` : ''
      return fail(others.length
        ? `No project named "${wanted}". The other projects are: ${others.join(', ')}.${unasked}`
        : `No project named "${wanted}" — this is the only project in Centralu.${unasked}`)
    }
    const asked = found[0]
    const hubTarget = fromHubs.projects.find((p) => p.id === asked.id)
    const remoteTarget = there.projects.find((p) => p.id === asked.id)
    const local = hubTarget || remoteTarget ? undefined : projects.find((p) => p.id === asked.id)
    // §7.4: a task is the mailbox's to refuse before anything is asked or delivered; a wait (no task) gives nothing
    if (opts.task) {
      const away = hubTarget ? { name: hubTarget.name, machine: hubTarget.hub } : remoteTarget ? { name: remoteTarget.name, machine: remoteTarget.machine } : null
      const s15 = this.host.refusesDelegation(callerId, away ? { projectId: asked.id, linked: true } : { projectId: asked.id }, { tool: 'ask_project', target: away ? `${away.name} on ${away.machine}` : (local?.name ?? asked.name), text: opts.task })
      if (s15) return { ok: false, error: s15 }
    }
    if (untrusted) return { ok: false, error: untrusted }
    if (hubs && hubTarget) {
      const callerProject = projects.find((p) => p.id === caller.projectId)?.name ?? 'another project'
      return this.askHubProject(callerId, callerProject, hubTarget, hubs, opts, signal)
    }
    if (reader && remoteTarget) {
      const callerProject = projects.find((p) => p.id === caller.projectId)?.name ?? 'another project'
      return this.askLinkedProject(callerId, callerProjectId, callerProject, remoteTarget, reader, opts, signal)
    }
    const target = projects.find((p) => p.id === found[0]!.id)!
    if (target.id === caller.projectId) return { ok: false, error: `${target.name} is this session's own project — do the work here.` }

    const candidates = [...this.host.meta.values()].filter((s) => s.projectId === target.id && isOrdinary(s))
    const wantedSession = opts.session?.trim()
    // A bounded call can keep waiting even when the person has since opened another session.
    const outstanding = [...this.host.children.delegations.entries()].filter(([, d]) =>
      d.callerId === callerId && d.target.id === target.id && !d.agent,
    )
    // A wait on a delegation a handoff gave away (#693): where it went, not another session's answer
    if (!opts.task && !outstanding.length) {
      const named = (id: string) => !wantedSession || id === wantedSession || this.host.meta.get(id)?.name.toLowerCase() === wantedSession.toLowerCase()
      const gone = [...this.host.children.handedOver].find(([id, h]) => h.from === callerId && this.host.meta.get(id)?.projectId === target.id && named(id))
      if (gone) return this.host.delegationFlow.handedOverReply(callerId, gone[0])
    }
    if (!opts.task && !wantedSession && outstanding.length === 1) {
      const [key, pending] = outstanding[0]!
      return this.awaitDelegation(key, pending, signal)
    }
    const picked = pickAskedSession(candidates, wantedSession, target.name, (s) => lastActiveOf(this.host.store.messages, s.id))
    if ('error' in picked) return { ok: false, error: picked.error }
    const chosen = picked.chosen
    const key = `${callerId}>${target.id}>${chosen.id}`
    const pending = this.host.children.delegations.get(key)
    if (pending && !opts.task) return this.awaitDelegation(key, pending, signal)
    const stillWorking = { ok: false as const, error: `${target.name} is still working on your last task in the session "${chosen.name}". Call ask_project with project "${target.name}", session "${chosen.id}" and no task to wait for it.` }
    if (pending && !pending.settled) return stillWorking
    if (!opts.task) return { ok: false, error: `Give a task: what ${target.name} / ${chosen.name} should do.` }

    const available = (): string | undefined => {
      const current = this.host.meta.get(chosen.id)
      if (!current || current.projectId !== target.id || !isOrdinary(current)) return 'The chosen session is no longer available'
    }
    const gone = available()
    if (gone) return { ok: false, error: gone }
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
     * replaced. Nothing is awaited from here to `delegate`.
     */
    const current = this.host.children.delegations.get(key)
    if (current && current !== pending && !current.settled) return stillWorking
    // A session that cannot take it now is sent it as mail, which starts a turn of its own once it is free (docs/plans/mailbox.md §10.6.2)
    if (!this.host.takesSendNow(chosen.id)) {
      const mailed = this.host.mailTask(callerId, this.host.meta.get(chosen.id)!, 'ask_project', opts.task)
      return 'error' in mailed ? { ok: false, error: mailed.error } : { ok: true, project: target.name, ...mailed }
    }
    if (pending) this.host.children.dropDelegation(key)
    const callerProject = projects.find((p) => p.id === caller.projectId)?.name ?? 'another project'
    /*
     * Read again once the session is awake: waking or restarting it takes seconds, and the gates can close meanwhile.
     * An untrusted project's `auto` boundary was logged by the read after the card, with no wait since; one that lost
     * its trust during the wake is logged then
     */
    const logged = !this.host.projectTrusted(callerProjectId)
    const stillAllowed = () => this.askGateError(callerId, logged) ?? this.projectGoneError(target)
    const frame = askFrame(callerProject, opts.task, { name: labelOf(this.host.store.messages, caller), sessionId: callerId })
    const { d, delivered } = this.host.delegationFlow.delegate({ key, callerId, sessionId: chosen.id, target, agent: false, via: 'ask_project', task: opts.task, frame, stillAllowed })
    const failed = await delivered
    return failed ? { ok: false, error: `Could not hand the task to ${target.name}: ${failed}` } : this.awaitDelegation(key, d, signal)
  }

  /**
   * ask_project to a project on a linked machine (#700, docs/plans/remote-hub.md §12.2 step 3). The same call as for a
   * project here, run through the links: the existing ordinary session is chosen by name or id, the person's consent
   * is asked for this call (a card that names the machine; "always" is read as allow once, as `create_project`'s is,
   * since a remembered consent is a row tied to two projects of this computer), and the task goes as a task across the
   * link (#1948 step 6): that machine's delivery gives it the session, held while it is busy as a busy session's task here
   * is, at the depth this caller's work makes it, and its engine reports it. The call waits for that report as start_agent
   * does for a child there; the answer is the session's words there, and the paths it names are that machine's files,
   * listed and none opened to the caller. A call with no task waits again on the caller's task still open there.
   *
   * Not here: cards of the machine's session answered by the caller (the person answers them in the hub's window), and
   * stopping the machine's turn when the call is cancelled.
   */
  private async askLinkedProject(
    callerId: string,
    callerProjectId: string,
    callerProject: string,
    target: LinkedProject,
    reader: LinkedSessions,
    opts: { session?: string; task?: string },
    signal?: AbortSignal,
  ): Promise<AskProjectResult> {
    const label = `${target.name} on ${target.machine}`
    const project = `${target.machineId}/${target.name}`
    const tasks = this.host.linkedTasks
    // The caller's asks there not answered yet, by the session's qualified id
    const given = (tasks?.asks(callerId) ?? []).filter((a) => a.sessionId.startsWith(`${target.machineId}.`))
    const wanted = opts.session?.trim()
    const of = (g: { taskId: string; sessionId: string }, sessionName: string): AskAcross => ({ taskId: g.taskId, sessionId: g.sessionId, child: g.sessionId, sessionName, project })
    if (target.away) {
      // A task already given there: the machine is down, and what became of it is the answer, not a refusal to ask
      const there = given.filter((g) => reader.describe(g.sessionId)?.project === target.name && (!wanted || g.sessionId === wanted))
      const [only] = there
      if (!opts.task && only && there.length === 1) return this.awaitAsk(callerId, of(only, reader.describe(only.sessionId)?.name ?? only.sessionId), reader, signal)
      return { ok: false, error: awayRefusal(target.machine, target.away, `${label} cannot be asked`) }
    }
    const listed = await reader.projectSessions(target)
    if (!listed.ok) return listed
    const sessions = listed.sessions
    const mine = sessions.flatMap((s) => given.filter((g) => g.sessionId === s.id).map((g) => of(g, s.name)))
    if (!opts.task && !wanted && mine.length === 1) return this.awaitAsk(callerId, mine[0]!, reader, signal)
    const picked = pickAskedSession(sessions, wanted, label)
    if ('error' in picked) {
      // The times are read only for the refusal that lists them: a successful ask never waits for them
      const moved = (await reader.sessionsMoved?.(target)) ?? {}
      const listed = pickAskedSession(sessions, wanted, label, (s) => moved[s.id])
      return { ok: false, error: 'error' in listed ? listed.error : picked.error }
    }
    const chosen = picked.chosen
    const pending = mine.find((g) => g.sessionId === chosen.id)
    if (pending && !opts.task) return this.awaitAsk(callerId, pending, reader, signal)
    if (pending && tasks?.open(callerId, chosen.id) === pending.taskId) {
      return { ok: false, error: `${label} is still working on your last task in the session "${chosen.name}". Call ask_project with project "${project}", session "${chosen.id}" and no task to wait for it.` }
    }
    if (!opts.task) return { ok: false, error: `Give a task: what ${label} / ${chosen.name} should do.` }
    if (!tasks) return { ok: false, error: 'Nothing was sent: this computer gives work to another machine only by mail, and its mail is not running.' }
    // A machine that takes no work from this computer, or not yet: said before the card, which would ask for nothing
    const cannot = tasks.refusal(chosen.id)
    if (cannot) return { ok: false, error: `Could not hand the task to ${label}: ${cannot}` }

    const decision = await this.host.hostCards.askHost(
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
    // The machine counts its session one level below the caller while it works on this (#838): the depth holds across machines
    const asker = labelOf(this.host.store.messages, this.host.meta.get(callerId)!)
    const frame = askFrame(callerProject, opts.task, { name: asker, sessionId: callerId, mailable: false })
    const sent = await tasks.send(callerId, chosen.id, frame, { origin: 'ask_project', depth: depthOf(this.host, callerId) + 1 })
    if (!sent.ok) return { ok: false, error: `Could not hand the task to ${label}: ${sent.text}` }
    const ask = of({ taskId: sent.messageId, sessionId: chosen.id }, chosen.name)
    // Held for its link: nothing went, so there is nothing to wait for yet
    if (sent.held) return { ok: true, state: 'working', project: ask.project, sessionId: ask.sessionId, sessionName: ask.sessionName, notice: heldLine(sent.computer) }
    return this.awaitAsk(callerId, ask, reader, signal)
  }

  /**
   * ask_project into a project of a hub linked to this host (#550, the reverse direction; docs/plans/remote-hub.md
   * §12.7). The hub does the rest, as an ask there would: its card for the pair (that hub's windows answer it; once
   * approved, the pair passes until the person withdraws it), the existing ordinary session, the task and the wait.
   * This side sends who asks and at which depth, and reads the answer: someone else's words, cut to size, and paths
   * that name the hub's files, listed and none opened. A call cancelled here is withdrawn there (`call.cancel`), which
   * withdraws a card still standing. The hub's task still working past the call (#1948 step 6) is kept here as a copy,
   * which its report answers when it comes; a call with no task waits on that report here
   */
  private async askHubProject(
    callerId: string,
    callerProject: string,
    target: { id: string; projectId: string; name: string; hub: string; hubId: string; label: string; away?: string },
    hubs: HubsReader,
    opts: { session?: string; task?: string },
    signal?: AbortSignal,
  ): Promise<AskProjectResult> {
    const label = `${target.name} on ${target.hub}`
    const project = `${target.label}/${target.name}`
    if (target.away) return { ok: false, error: awayRefusal(target.hub, target.away, `${label} cannot be asked`) }
    const prefix = `${target.label}.`
    // Its session by its id there, or as this host prints it (an older build printed the hub's id in front)
    const given = opts.session?.trim()
    const session = [prefix, `${target.hubId}.`].reduce((id, p) => (id?.startsWith(p) ? id.slice(p.length) : id), given)
    const onHub = (a: { to: string }) => { const p = parseAddress(a.to); return p?.kind === 'session' && p.host === target.hubId }
    const kept = opts.task ? [] : (this.host.linkedTasks?.asks(callerId) ?? []).filter((a) => onHub(a) && (!session || a.to === sessionAddress(target.hubId, session)))
    const [k] = kept
    if (k && kept.length === 1) {
      return this.awaitAsk(callerId, { taskId: k.taskId, sessionId: k.sessionId, child: k.to, sessionName: k.name, project }, null, signal)
    }
    const r = await hubs.ask(
      target.hubId,
      {
        caller: { sessionId: callerId, name: labelOf(this.host.store.messages, this.host.meta.get(callerId)!), project: callerProject },
        project: target.projectId,
        ...(session ? { session } : {}),
        ...(opts.task ? { task: opts.task } : {}),
        // The hub counts its session one level below this caller while it works on the task (#867, #838)
        depth: depthOf(this.host, callerId) + 1,
      },
      signal,
    )
    if (!r.ok) return { ok: false, error: r.error }
    const there = sessionAddress(target.hubId, r.sessionId)
    // A host with no mailbox has no printer: the form it prints is the one its ids read back as above
    const base = { project, sessionId: this.host.linkedTasks?.shown(there) ?? `${prefix}${r.sessionId}`, sessionName: r.sessionName }
    if (r.state === 'working') {
      if (r.taskId && opts.task) this.host.linkedTasks?.keep(callerId, there, r.taskId, opts.task)
      return { ok: true, state: 'working', ...base, ...(r.notice ? { notice: r.notice } : {}) }
    }
    const answer = r.answer ?? ''
    // The answer is the report on the task: a copy kept of it here is answered, so no report comes for it again
    if (r.taskId) this.host.children.answered(callerId, there, { ok: true, text: answer })
    // Paths in the answer are the hub's files: listed, not opened to the caller
    return { ok: true, state: 'done', ...base, answer: clipAnswer(answer, r.sessionName), readable: [], outside: pathsIn(answer) }
  }

  /**
   * Waits up to the bound for the report on an ask's task on another computer (`LinkedTasks.settled`), as `awaitDelegation` waits for a turn here, and
   * reads its answer: the session's words there when `reader` reads them (a linked machine's), else the report's
   */
  private async awaitAsk(callerId: string, ask: AskAcross, reader: LinkedSessions | null, signal?: AbortSignal): Promise<AskProjectResult> {
    const tasks = this.host.linkedTasks!
    const base = { project: ask.project, sessionId: ask.sessionId, sessionName: ask.sessionName }
    const r = await tasks.settled(ask.taskId, ASK_WAIT_MS, { signal })
    // The turn runs there and this host cannot stop it from here: the call stops waiting and says so
    if (r === 'aborted') return { ok: false, error: `The call was cancelled; ${ask.project}'s session "${ask.sessionName}" was left running.` }
    const s = tasks.standing(ask.taskId)
    if (r === 'bound' || s.state === 'open') return { ok: true, state: 'working', ...base }
    // The call gives the caller the report: it does not wake it again
    this.host.children.answered(callerId, ask.child)
    const failed = unfinished(s)
    if (failed !== null || s.state !== 'reported') return { ok: false, error: `${ask.project}'s session "${ask.sessionName}" [${ask.sessionId}] did not finish: ${failed}. Tell the person, or ask again with a clearer task.` }
    const answer = await linkedWords(reader, ask.sessionId, ask.sessionName, s.answer)
    // Its own background work still runs there (#721): its final report comes by mail when that work ends
    const paused = s.outcome === 'paused' ? liveBackgroundTasks([...this.host.linkedReports.tasksOf(ask.sessionId)]).filter((t) => !t.timer) : null
    return {
      ok: true, state: 'done', ...base, answer,
      // Paths in the answer are that computer's: listed, not opened to the caller
      readable: [], outside: pathsIn(answer),
      ...(paused ? { paused: pausedWords(paused, ask.sessionId, ' there') } : {}),
    }
  }

  /** Waits for a delegation up to the bound (`awaitTurn`), and turns its outcome into what the caller reads */
  private async awaitDelegation(key: string, d: Delegation, signal?: AbortSignal): Promise<AskProjectResult> {
    const sessionName = () => this.host.meta.get(d.sessionId)?.name ?? d.sessionId
    const base = { project: d.target.name, sessionId: d.sessionId }
    const r = await this.host.delegationFlow.awaitTurn(key, d, { signal, stopWhy: 'the call that asked was cancelled' })
    switch (r.kind) {
      case 'handedOver':
        return this.host.delegationFlow.handedOverReply(r.owner, d.sessionId)
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
        return { ok: false, error: `The call was cancelled, so ${d.target.name}'s session "${sessionName()}" was stopped.` }
      case 'failed':
        this.host.children.answered(d.callerId, d.sessionId, { ok: false, error: errorKindWord(r.error) }, d.taskId)
        return {
          ok: false,
          error: `${d.target.name}'s session "${sessionName()}" [${d.sessionId}] did not finish: ${r.error}. Tell the person, or ask again with a clearer task.`,
        }
    }
    const { granted, outside } = this.host.delegationFlow.grantReads(d.callerId, r.answer, d.target.path)
    /*
     * A turn that completed with the session's own background work still running (#721, #1460): the caller reads the answer now, and the session's
     * last response answers the task once that work ends (docs/plans/mailbox.md §10.6.3)
     */
    const running = this.host.ownTasksRunning(d.sessionId)
    const paused = running.length ? running : undefined
    this.host.children.answered(d.callerId, d.sessionId, paused ? undefined : { ok: true, text: r.answer }, d.taskId)
    return {
      ok: true, state: 'done', ...base, sessionName: sessionName(), answer: clipAnswer(r.answer, sessionName(), answerAt(this.host.store.messages, d.sessionId, r.answer)), readable: granted, outside,
      ...(paused ? { paused: pausedWords(paused, d.sessionId) } : {}),
    }
  }

}

/**
 * What the caller reads of a turn that ended with the session's own background work still running (#721, #1457): the
 * words of `DelegationWaits.pausedNotice` without the `agent_session stop`, which an ask_project target does not have.
 * The work may be a server that never ends, and the report comes only if it does. A hub's work is not listed on a machine (`tasks` empty)
 */
function pausedWords(tasks: readonly { description: string }[], sessionId: string, there = ''): string {
  return (
    `its turn ended while its own background work is still running${there}${tasks.length ? ` (${tasks.map((t) => frameField(t.description)).join(', ')})` : ''}, so the answer is what it said so far. ` +
    'A final report follows when that work ends and a turn ends it. If that work is a server or watcher it leaves running, ' +
    `this answer may be its final one. Read the session with read_session(sessionId="${sessionId}").`
  )
}
