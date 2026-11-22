import { randomUUID } from 'node:crypto'
import { gitRemoteKey, type ApprovalDetail, type PermissionPreset, type SessionInfo, type SessionState, isAssistantKind, agentLook, oneLineText } from '@cc/protocol'
import type { AgentListRow, AgentSessionOpts, ChildRunResult, LinkedProject, LinkedSessions, OrchestratedSession, RoutedCard, StartAgentOpts } from '../adapters/contract.js'
import { NOT_CONNECTED, NOT_CONNECTED_PHRASE, NOT_REACHABLE } from '../adapters/contract.js'
import { awayRefusal } from '../links/machine-reach.js'
import { gitValidBranchName } from '../dev-services/git-worktree.js'
import { readJsonObjects } from '../dev-services/store/json.js'
import type { DelegationOrigin } from '../mail/messages.js'
import { heldLine } from '../mail/across-core.js'
import type { TaskStanding } from '../mail/delegation.js'
import { inTurn } from '../idle.js'
import { depthOf } from './agent-depth.js'
import { agentStartGateError } from './agent-start-gates.js'
import { ANSWER_READ_MAX_CHARS, ASK_WAIT_MS, clipAnswer, NO_WORDS, taskLine } from './ask-project.js'
import type { DelegationHost } from './delegation-host.js'
import type { LinkedEvent } from './linked-reports.js'
import { aboveCallerError, agentBranch, agentChoice, agentName, distinguishingText, givenAgentName, presetWithin, remoteAgentFrame } from './start-agent.js'
import { autoNotice, bare, carriedPreset, remotePreset, remoteWorktreeLine, shownRemote, type AutoThere } from './remote-agent-words.js'
import { ASK_THE_PERSON, START_AGENT_CALL_MS, START_AGENT_SETUP_MS } from './start-agent-terms.js'
import { labelOf } from './transcript-view.js'
import { raceTimeout } from '../timing.js'
import type { NoteSent } from '../mail/tool.js'

/**
 * A child start_agent started on a linked machine (#1038), as the hub keeps it: the machine's session (its qualified
 * id), the session that started it, and what the hub says of it when the machine cannot be asked. Kept in the store, so
 * agent_session still finds it after the hub restarts. The work given it is the mailbox's, tasks across the link (#1948 step 6)
 */
export type RemoteAgent = {
  sessionId: string
  callerId: string
  machineId: string
  machine: string
  name: string
  tool: string
  /** The machine's project it works in, by its name there */
  project: string
  /** The branch of the worktree it was started in there, if one */
  worktree?: string
  /**
   * The preset the machine started it under (#1273): a send is refused once the caller has less, as a local
   * child's is (`agent-session-actions.ts`). Absent from a record made before #1273, when it was `normal` at most
   */
  preset?: PermissionPreset
  startedAt: number
}

/**
 * A record as a build before #1948 step 6 kept it: what the hub owed the caller of the child's turn (`owed`), and its own reading of whose each
 * turn there was. Read once at startup (`restore`), and dropped
 */
type StoredRemoteAgent = RemoteAgent & { owed?: unknown; whose?: unknown; given?: unknown; queued?: unknown; sent?: unknown; turn?: unknown }
const LEGACY = ['owed', 'whose', 'given', 'queued', 'sent', 'turn'] as const

/**
 * How long a start waits for the machine to say its instructions for agents now (#1161), once the child is made
 * there: the machine just answered, so this is short. Past it, what it listed before the card goes with the task
 */
const INSTRUCTIONS_WAIT_MS = 5_000

/** Where the hub keeps its children on linked machines: one app setting, so an older build leaves it alone */
export const REMOTE_AGENTS_KEY = 'remote_agents'

/** An at-rest child's answer when no report on a task of the caller's came back: nothing of a turn that was not the caller's is read (#1038) */
const NOTHING_REPORTED = '(no report on a task you gave it has come back)'

/** What a start on a machine that takes no work from this hub says to do (#1948 step 6) */
const stillConnecting = (machine: string) => `${machine} is still connecting to this computer, so nothing was made there. Try again in a moment.`
const olderThere = (machine: string) => `${machine} runs an older Centralu, which takes no work from this computer. Update Centralu on ${machine}, or start the session here.`
/** What a child on a machine says when this computer's own mail, which carries its work, is not running */
const NO_MAIL = 'this computer gives work to another machine only by mail, and its mail is not running'

/**
 * What a child on a linked machine reaches of the session manager (#1038), typed as the manager declares each member.
 * The manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type RemoteAgentsHost = Pick<
  DelegationHost,
  'hostCards' | 'autoBoundaryOpen' | 'trustGate' | 'children' | 'closing' | 'emit' | 'linkedReader' | 'linkedTasks' | 'meta' | 'store' | 'tellSession' | 'uiPreferences' | 'files' | 'linkedReports' | 'adapters'
>

/**
 * The project's ceiling on agents working at once (`AgentStartGates`, reached through the start flow): a child on a
 * linked machine counts under its parent's project (#1038), and its start holds a place from its check, as a local one
 */
export type AgentPlaces = {
  agentCeilingError(callerId: string, projectId: string): string | null
  reservePlace(callerId: string, projectId: string): { release: () => void } | { error: string }
}

/**
 * start_agent on a linked machine (#1038) and agent_session on what it starts there. The child is a session of the
 * machine's checkout of the caller's repository (the same `origin`, `gitRemoteKey`), made over the link under the
 * caller's preset and one level below it in the agent depth (`CreateSessionParams.agentDepth`), after a card that
 * names the machine. Its work goes as mail (#1948 step 6, docs/plans/mailbox.md §10.6): a start and each send are a task
 * across the link, which that machine's delivery gives the child (held while it is busy) and its engine reports; the
 * report comes back answering the task here, as a local child's does, and a call that waits reads it. Whose a turn there
 * is, is that machine's to say: nothing here reads the person's own turns on it (#1038, RV13).
 */
export class RemoteAgents {
  /** Whether a machine takes this hub's tasks (`LinkedMachineConnection.takesTasks`, #1948 step 6). Set by main.ts */
  machineTasks: ((machineId: string) => boolean | undefined) | null = null

  private loaded: StoredRemoteAgent[] | null = null
  /** The calls waiting on a child's report, each ended at once when the child is deleted there (`observe`) */
  private readonly waits = new Map<string, Set<() => void>>()

  constructor(
    private readonly host: RemoteAgentsHost,
    private readonly places: AgentPlaces,
  ) {}

  /**
   * At startup: a record a build before #1948 step 6 kept owed its caller the end of the child's turn by the relayed report, which is gone. Its
   * caller is told once, in one notice for all its children, where to read it, and the old fields are dropped, so no later start tells it again
   */
  restore(): void {
    const stored = this.records()
    if (!stored.some((r) => LEGACY.some((k) => k in r))) return
    const notices = new Map<string, { lines: string[]; about: { sessionId: string; name: string } }>()
    for (const r of stored) {
      // What the old build held for the child while it was busy is not sent by this one: said, never dropped without a word
      const held = Array.isArray(r.queued) ? r.queued.length : 0
      if ((r.owed === undefined && !held) || !this.host.meta.has(r.callerId)) continue
      const text = [
        r.owed === undefined ? '' : `[Centralu] Centralu was updated while "${r.name}" on ${r.machine} was working on a task from this session, so its report will not arrive. read_session(sessionId="${r.sessionId}") shows where it stands.`,
        held ? `[Centralu] Centralu was updated while ${held === 1 ? 'a message' : `${held} messages`} from this session waited for "${r.name}" on ${r.machine} to be free. ${held === 1 ? 'It was' : 'They were'} not sent; send again what still matters.` : '',
      ].filter(Boolean)
      const notice = notices.get(r.callerId)
      if (notice) notice.lines.push(...text)
      else notices.set(r.callerId, { lines: text, about: { sessionId: r.sessionId, name: r.name } })
    }
    for (const [callerId, n] of notices) void this.host.tellSession(callerId, n.lines.join('\n'), n.about, true)
    this.save(stored.map(({ owed: _o, whose: _w, given: _g, queued: _q, sent: _s, turn: _t, ...r }) => r))
  }

  /** The hub's record of a child on a linked machine, by its qualified id */
  of(sessionId: string): RemoteAgent | undefined {
    return this.records().find((r) => r.sessionId === sessionId)
  }

  /** A child started here on a linked machine, by its name and machine as one name (`MailSessionsHost.linkedChild`) */
  named(sessionId: string): { name: string } | undefined {
    const r = this.of(sessionId)
    return r && { name: oneLineText(`${r.name} on ${r.machine}`, 120) }
  }

  /**
   * The caller's children on linked machines, as agent_session list shows them (#690), each with its machine and the
   * state that machine reports (as last known when it cannot be asked): a state word, nothing of any turn. One gone from
   * its machine, or whose machine was removed, is dropped from the record here (#1038).
   */
  async rows(callerId: string): Promise<AgentListRow[]> {
    const mine = this.records().filter((r) => r.callerId === callerId)
    const reader = this.host.linkedReader
    if (!mine.length || !reader) return []
    const listed = await reader.list().catch(() => null)
    const out: AgentListRow[] = []
    for (const r of mine) {
      if (listed && this.gone(r, reader, listed)) {
        this.forget(r.sessionId)
        continue
      }
      const there = listed?.find((s) => s.sessionId === r.sessionId)
      // Its machine's row as a child here reads (`agentLook`), with the tasks its machine relays (#2146)
      const state: AgentListRow['state'] = there
        ? agentLook({ state: there.state, backgroundTasks: this.host.linkedReports.tasksOf(r.sessionId), interruption: there.interruption })
        : this.openTask(r) ? 'working' : 'finished'
      out.push({ sessionId: r.sessionId, name: r.name, tool: r.tool, state, asleep: false, machine: r.machine })
    }
    return out
  }

  /**
   * How many children the project's sessions started on linked machines are working now (#1038): a task their caller gave is open (not reported,
   * withdrawn or released). A removed machine's child is out of reach for good, and holds no place (#1038)
   */
  workingIn(projectId: string): number {
    const mine = this.records().filter((r) => this.host.meta.get(r.callerId)?.projectId === projectId)
    if (!mine.length) return 0
    const reader = this.host.linkedReader
    return mine.filter((r) => reader?.machineLinked(r.machineId) === true && this.openTask(r) !== undefined).length
  }

  /**
   * The caller is gone (trashed): its children's records go (#1038). Each stays on its machine, and goes back to that machine's project in
   * the sidebar
   */
  forgetCaller(callerId: string): void {
    for (const r of this.records().filter((x) => x.callerId === callerId)) {
      this.forget(r.sessionId, false)
      this.owned(r.sessionId, null)
    }
  }

  /**
   * A handoff gave the original's work to `to` (#693): its children on linked machines are the heir's. Returns them, whose tasks the handoff moves
   * with the original's mail (`MessageService.handOver`, #1948 step 6)
   */
  moveCaller(from: string, to: string): string[] {
    const moving = this.records().filter((r) => r.callerId === from)
    if (!moving.length) return []
    this.save(this.records().map((r) => (r.callerId === from ? { ...r, callerId: to } : r)))
    for (const r of moving) this.owned(r.sessionId, to)
    return moving.map((r) => r.sessionId)
  }

  async startAgent(callerId: string, opts: StartAgentOpts & { machine: string }, signal?: AbortSignal): Promise<ChildRunResult> {
    const startedAt = Date.now()
    const caller = this.host.meta.get(callerId)
    if (!caller?.projectId) {
      return { ok: false, error: isAssistantKind(caller?.kind)
        ? 'The Assistant starts a session on a linked machine with create_session; start_agent with a machine is for a project\'s session.'
        : 'This session belongs to no project, so it cannot start agents.' }
    }
    // Said, and an `auto` caller's crossing logged, before anything is asked, as by a local start's first gate
    const project = this.host.store.projects.listProjects().find((p) => p.id === caller.projectId)
    if (!project) return { ok: false, error: 'This session\'s project is no longer registered.' }
    const untrusted = this.host.trustGate(callerId, project.id, 'starting agents')
    if (untrusted) return { ok: false, error: untrusted }
    const refused = this.gateError(callerId)
    if (refused) return { ok: false, error: refused }
    // Counted under the caller's project, as a local child is (#1038); checked before anything is asked
    const full = this.places.agentCeilingError(callerId, project.id)
    if (full) return { ok: false, error: full }
    const reader = this.host.linkedReader
    if (!reader) return { ok: false, error: 'No machine is linked to this computer, so no session can be started on one. Start it here, without machine.' }
    const machine = reader.machineNamed(opts.machine)
    if (!machine) return { ok: false, error: `No linked machine is called "${opts.machine}". read_session lists the linked machines' sessions, each with its machine.` }
    const found = await this.checkoutOn(machine, project, reader)
    if ('error' in found) return { ok: false, error: found.error }
    const target = found.project
    /*
     * An auto caller's child runs auto there too where that machine takes it (#1273), and then no card is raised. Only in
     * a project that machine trusts (owner decision 2026-11-05, `presetFromHub` there): in an untrusted one it is a
     * `normal` child behind the card, as a `normal` caller's
     */
    const asked = this.callerPreset(callerId) === 'auto' && target.trusted === true ? await this.autoThere(machine, reader) : null
    if (asked && 'error' in asked) return { ok: false, error: asked.error }
    // Its work goes as mail (#1948 step 6): a machine whose Centralu takes no tasks from this hub is told to update before anything is asked or made
    const takes = this.machineTasks?.(machine.id)
    if (!this.host.linkedTasks) return { ok: false, error: `Nothing was made on ${machine.name}: ${NO_MAIL}.` }
    if (takes === undefined) return { ok: false, error: stillConnecting(machine.name) }
    if (takes !== true) return { ok: false, error: olderThere(machine.name) }
    const tool = opts.tool ?? target.defaultTool ?? caller.tool
    // The person's model for a difficulty is read here, as for a local child; the machine is not asked for its list
    const label = this.host.adapters.get(tool)?.descriptor.label ?? tool
    // The machine may apply its own remembered model for the project: this computer cannot name it
    const { model, effort, difficulty, fellBack } = agentChoice(opts, undefined, this.host.uiPreferences().agentModels?.[tool], label, `the model ${machine.name} picks for it`)
    const given = givenAgentName(opts.name)
    const siblings = [...this.records().filter((r) => r.callerId === callerId).map((r) => r.name), ...[...this.host.meta.values()].filter((s) => s.askedBy === callerId).map((s) => s.name)]
    const basis = given ?? distinguishingText(opts.task, siblings)
    let branch: string | undefined
    if (opts.worktree || opts.branch) {
      const asked = opts.branch?.trim()
      if (asked && !(await gitValidBranchName(asked))) return { ok: false, error: `Not a valid branch name: ${asked}` }
      branch = asked || agentBranch(basis, randomUUID())
    }
    const name = given ?? (branch ? undefined : agentName(basis))
    /*
     * Decided from the caller as it is now, after every wait above (#1273): a caller that left `auto` while the
     * machine was asked gets its own preset's card and child, never the `auto` it no longer has
     */
    const callerNow = this.callerPreset(callerId)
    const there = callerNow === 'auto' ? asked : null
    const preset: PermissionPreset = there?.auto ? 'auto' : remotePreset(callerNow)
    const detail: Extract<ApprovalDetail, { kind: 'agent_start' }> = {
      kind: 'agent_start',
      project: { id: target.id, name: target.name },
      tool,
      ...(model ? { model } : {}),
      ...(difficulty ? { difficulty } : {}),
      preset,
      ...(branch ? { worktree: { branch } } : {}),
      text: taskLine(opts.task),
      ...(given ? { name: given } : {}),
      machine: machine.name,
      ...(there && !there.auto ? { autoWithheld: there.withheld } : {}),
    }
    /*
     * Asked each time (#1038), with no "always": nothing is remembered for another machine. Except for an `auto`
     * caller whose child runs `auto` there too (owner decision 2026-10-19, #1273): the person let this session act
     * without asking, and that machine's own switch lets a linked computer's `auto` reach it. A `normal` or `safe`
     * caller, or a machine whose switch is off or that cannot take `auto`, is asked
     */
    const unasked = there?.auto === true && this.host.autoBoundaryOpen(callerId, `start an agent on ${machine.name} under auto`)
    // The card is bounded as a local start's setup is (#660): past it the card goes and nothing is made
    const ctl = new AbortController()
    let decision: Awaited<ReturnType<RemoteAgentsHost['hostCards']['askHost']>> = 'allow'
    if (!unasked) {
      const onAbort = () => ctl.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) ctl.abort()
      const timer = setTimeout(() => ctl.abort(), START_AGENT_SETUP_MS)
      try {
        decision = await this.host.hostCards.askHost(callerId, detail, ctl.signal, { alwaysAsk: true })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    // The card may have stood a while: what the start rests on in the caller is read again, and its reason comes first
    const after = this.gateError(callerId)
    if (after) return { ok: false, error: after }
    if (decision === 'deny') return { ok: false, error: `The person did not allow this session to start an agent on ${machine.name}. Do not start one again unless they tell you to. ${ASK_THE_PERSON}` }
    if (decision === null || ctl.signal.aborted || signal?.aborted) {
      return { ok: false, error: signal?.aborted ? 'The call was withdrawn before the session was created, so none was.' : `No session was created: the question to the person was withdrawn or not answered in time. ${ASK_THE_PERSON}` }
    }
    // The caller's preset may have changed while the card stood: never a child above it (#1273)
    const lowered = this.loweredError(callerId, preset, `so nothing was started on ${machine.name}`)
    if (lowered) return { ok: false, error: lowered }
    // A place is held from here until the child counts (its task open), so starts at once cannot pass the ceiling together
    const place = this.places.reservePlace(callerId, project.id)
    if ('error' in place) return { ok: false, error: place.error }
    try {
      return await this.makeChild(callerId, caller, opts, { machine, target, tool, name, model, effort, fellBack, branch, startedAt, preset, there, unasked }, reader, place.release, signal)
    } finally {
      place.release()
    }
  }

  /** The child made on the machine once allowed, its task sent as mail, and its report waited for (`startAgent`) */
  private async makeChild(
    callerId: string,
    caller: SessionInfo,
    opts: StartAgentOpts & { machine: string },
    c: {
      machine: { id: string; name: string }; target: LinkedProject; tool: string; name?: string; model?: string; effort?: string; branch?: string; startedAt: number
      /** A difficulty named with no model set for it on this tool (`agentChoice`, #2350) */
      fellBack?: string
      /** The preset it is to run under there, what the machine said of an `auto` caller's, and whether no card was asked (#1273) */
      preset: PermissionPreset; there: AutoThere | null; unasked: boolean
    },
    reader: LinkedSessions,
    counted: () => void,
    signal?: AbortSignal,
  ): Promise<ChildRunResult> {
    const { machine, target, tool, name, model, effort, fellBack, branch, startedAt, there, unasked } = c
    const made = await reader.createSession(target, {
      tool: tool as never,
      ...(name ? { name } : {}),
      // `normal` at most, which a machine from before #1273 keeps; the preset carried says `auto` only where it is taken
      preset: remotePreset(c.preset),
      callerPreset: carriedPreset(c.preset),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(branch ? { worktreeBranch: branch } : {}),
      agentDepth: depthOf(this.host, callerId) + 1,
    })
    if (!made.ok) return { ok: false, error: `Could not start ${tool} on ${machine.name}: ${bare(made.error)}. ${ASK_THE_PERSON}` }
    /*
     * Started without a card on the machine's word that it takes `auto` (#1273), and it did not: its switch went off
     * since. A `normal` child there is what the card is for, so the one made is deleted unstarted (no task was sent)
     */
    const childPreset: PermissionPreset = made.preset ?? remotePreset(c.preset)
    // Read again now: the caller's preset may have dropped while the machine made it (#1273)
    const above = !presetWithin(childPreset, this.callerPreset(callerId))
    if (above || (unasked && childPreset !== 'auto')) {
      const why = above
        ? `this session now runs under ${this.callerPreset(callerId)}, below the ${childPreset} the session made there runs under`
        : `${machine.name} no longer takes auto from this computer (its "Allow auto from a linked computer" setting was turned off)`
      const gone = await reader.deleteSession(made.sessionId)
      return {
        ok: false,
        error: `${why}, so the session made there was given no task and went to ${machine.name}'s session archive${gone.ok ? '' : `, or would have: it could not be deleted (${bare(gone.error)}), so "${made.name}" stays there with no task`}. Start it again to ask the person. ${ASK_THE_PERSON}`,
      }
    }
    const label = labelOf(this.host.store.messages, caller)
    /*
     * The instructions of the machine's own copy of the project (#1161 item 2): its paths and its shell. Read again now
     * (#1161): the card may have stood a while, and a machine connected on demand was listed from its mirror
     */
    const task = remoteAgentFrame(label, opts.task, await this.instructionsOn(reader, target))
    const rec: RemoteAgent = {
      sessionId: made.sessionId, callerId, machineId: machine.id, machine: machine.name, name: made.name, tool,
      project: target.name, ...(branch ? { worktree: branch } : {}), startedAt: Date.now(), preset: childPreset,
    }
    this.save([...this.records(), rec])
    // Its row came to the windows before the hub knew whose it is: now it names the caller as its `askedBy`, and the caller points to it (#1038, #1416)
    this.owned(rec.sessionId, callerId)
    const sent = await this.giveTask(rec, callerId, task, 'start_agent')
    if (!sent.ok) return { ok: false, error: `The session "${rec.name}" [${rec.sessionId}] was made on ${machine.name} but did not take the task: ${bare(sent.text)}. Send it again by mail, or delete it with agent_session.` }
    // It counts by itself now: its task is open (`workingIn`)
    counted()
    const unchecked = [
      // The link dropped since the session was made: the task waits here for it
      sent.held ? heldLine(machine.name) : '',
      fellBack ?? '',
      // Where its worktree forked from, as the machine said (#1488); a machine from before it says nothing
      made.worktreeBase ?? '',
      model || effort ? `${[model && `model "${model}"`, effort && `effort "${effort}"`].filter(Boolean).join(' and ')} not checked against ${machine.name}'s list` : '',
      // Not passed across (#1038): said, rather than dropped without a word
      opts.lsp ? `lsp is not passed to another machine: it starts as ${machine.name} starts a session` : '',
      // As the machine started it: a switch turned off after its answer leaves a carded start under normal (#1273)
      there ? autoNotice(machine.name, there.auto && childPreset !== 'auto' ? { auto: false, withheld: 'machine_off' } : there) : '',
    ].filter(Boolean).join('; ') || undefined
    const left = Math.max(1_000, START_AGENT_CALL_MS - (Date.now() - startedAt))
    const result = opts.wait === false || sent.held ? this.working(rec, true) : await this.awaitReport(rec, callerId, sent.messageId, signal, Math.min(ASK_WAIT_MS, left))
    return result.ok && unchecked ? { ...result, notice: [result.notice, unchecked].filter(Boolean).join('; ') } : result
  }

  /** Work for the child, as a task from the caller across the link (#1948 step 6): the machine holds it while the child is busy, and reports it */
  private giveTask(rec: RemoteAgent, callerId: string, text: string, origin: DelegationOrigin): Promise<{ ok: true; messageId: string; held?: true } | { ok: false; text: string }> {
    const tasks = this.host.linkedTasks
    return tasks ? tasks.send(callerId, rec.sessionId, text, { origin }) : Promise.resolve({ ok: false, text: NO_MAIL })
  }

  /**
   * The instructions of the machine's copy of the project as it has them now (#1161 item 2), or as it listed them
   * before the card when it cannot say (#1161): a reader without the read, one that fails or throws, one that
   * does not answer within `INSTRUCTIONS_WAIT_MS`. Never a reason the start stops; a machine that predates them listed
   * none, so its child starts without them, as it did before.
   */
  private async instructionsOn(reader: LinkedSessions, target: LinkedProject): Promise<string> {
    const listed = target.agentInstructions ?? ''
    if (typeof reader.agentInstructions !== 'function') return listed
    const now = await raceTimeout(reader.agentInstructions(target).catch(() => null), INSTRUCTIONS_WAIT_MS, null)
    return now?.ok ? now.text : listed
  }

  /** agent_session on a child of a linked machine (#1038): status, wait, send, answer, stop, delete, through the link and the mailbox */
  agentSession(callerId: string, rec: RemoteAgent, opts: AgentSessionOpts, signal?: AbortSignal): Promise<ChildRunResult> {
    return this.act(callerId, rec, opts, signal)
  }

  /** New work for a child of a linked machine (`AgentSessionActions.sendWork`, the caller's `mail` to it), through the link */
  send(callerId: string, rec: RemoteAgent, text: string): Promise<ChildRunResult> {
    return this.act(callerId, rec, { sessionId: rec.sessionId, action: 'send', text })
  }

  /**
   * A note for the child across the link (the caller's `mail` with `kind: "note"`, #2493): a message that needs no reply, written quiet there, with
   * no task and no report. Refused as new work is: a child above its caller, or a caller the gate refuses
   */
  async note(callerId: string, rec: RemoteAgent, text: string): Promise<NoteSent> {
    const refused = aboveCallerError(rec.name, rec.preset ?? 'normal', this.callerPreset(callerId)) ?? this.gateError(callerId)
    if (refused) return { ok: false, error: refused }
    const tasks = this.host.linkedTasks
    const sent = tasks ? await tasks.send(callerId, rec.sessionId, text, { origin: 'agent_session', note: true }) : { ok: false as const, text: NO_MAIL }
    return sent.ok ? { ok: true, messageId: sent.messageId, name: `${rec.name} on ${rec.machine}` } : { ok: false, error: `Could not send to "${rec.name}" on ${rec.machine}: ${bare(sent.text)}.` }
  }

  private async act(callerId: string, rec: RemoteAgent, opts: AgentSessionOpts | { sessionId: string; action: 'send'; text: string }, signal?: AbortSignal): Promise<ChildRunResult> {
    if (rec.callerId !== callerId) return { ok: false, error: `${rec.sessionId} is not a session this session started. agent_session works only on sessions start_agent started from here.` }
    const reader = this.host.linkedReader
    if (!reader) return { ok: false, error: `${rec.sessionId} is on ${rec.machine}, and no machine is linked to this computer now.` }
    const stateOf = async (): Promise<{ ok: true; state: SessionState } | { ok: false; error: string }> => {
      const r = await reader.read(rec.sessionId, 1)
      if (!r.ok) return { ok: false, error: `${rec.machine} cannot be asked about "${rec.name}" now: ${r.error ?? 'no answer'}` }
      return { ok: true, state: (r.state ?? 'idle') as SessionState }
    }
    switch (opts.action) {
      case 'answer':
        return this.answer(rec, opts.card, opts.text ?? '', reader)
      case 'status':
      case 'wait': {
        // The task it is on for the caller: a wait reads its report, status says it runs (`openTask`)
        const open = this.openTask(rec)
        if (open && opts.action === 'wait') return this.awaitReport(rec, callerId, open, signal, ASK_WAIT_MS)
        const now = await stateOf()
        if (!now.ok) return now
        if (open) return this.working(rec, true)
        // In a turn none of the caller's tasks started: its state word, nothing of the turn
        if (inTurn(now.state)) return this.working(rec, false)
        // Reading where it stands reads the reports the caller holds of it, as a local child's status does
        this.host.children.answered(callerId, rec.sessionId)
        return { ok: true, state: 'at_rest', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, answer: this.host.linkedTasks?.lastAnswer(callerId, rec.sessionId) ?? NOTHING_REPORTED, sessionState: now.state }
      }
      case 'send': {
        // Never work for a child above its caller (#1273), as a local child's send (agent-session-actions.ts)
        const above = aboveCallerError(rec.name, rec.preset ?? 'normal', this.callerPreset(callerId))
        if (above) return { ok: false, error: above }
        const refused = this.gateError(callerId)
        if (refused) return { ok: false, error: refused }
        // New work counts under the caller's project as a local child's does (#1038); more for a child already working holds no new place
        const full = this.openTask(rec) ? null : this.places.agentCeilingError(callerId, this.host.meta.get(callerId)?.projectId ?? '')
        if (full) return { ok: false, error: full }
        const sent = await this.giveTask(rec, callerId, opts.text, 'agent_session')
        if (!sent.ok) return { ok: false, error: `Could not send to "${rec.name}" on ${rec.machine}: ${bare(sent.text)}.` }
        // Its machine gives it the task once it is free (or once the link is back), and its report comes back as mail
        return sent.held ? { ...this.working(rec, true), notice: heldLine(rec.machine) } : this.working(rec, true)
      }
      case 'stop': {
        const r = await this.stopThere(rec, callerId, reader)
        if (!r.ok) return { ok: false, error: `Could not stop "${rec.name}" on ${rec.machine}: ${bare(r.error)}.` }
        return { ok: true, state: 'stopped', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool }
      }
      case 'delete': {
        // Gone already (#1038): deleted there, or its machine removed, while the hub could not see it
        const listed = await reader.list().catch(() => null)
        if (listed && this.gone(rec, reader, listed)) {
          this.forget(rec.sessionId)
          return {
            ok: true, state: 'deleted', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool,
            notice: reader.machineLinked(rec.machineId) ? `It was no longer on ${rec.machine}; nothing was left to delete.` : `${rec.machine} was removed from Centralu; the session is forgotten here.`,
          }
        }
        const now = await stateOf()
        if (!now.ok) return now
        if (inTurn(now.state)) {
          const stopped = await this.stopThere(rec, callerId, reader)
          if (!stopped.ok) return { ok: false, error: `Could not stop "${rec.name}" on ${rec.machine} before deleting it: ${bare(stopped.error)}.` }
        } else this.host.linkedTasks?.withdraw(callerId, rec.sessionId)
        /*
         * The worktree made for it there goes with it when nothing would be lost (#1161 item 3): the machine decides, as
         * only it can read that worktree, and says what it left and why. Only one made for it: the record names the
         * branch this hub asked for, and a child started without a worktree is deleted as before
         */
        // A reader without the call (a stand-in) deletes as before
        const canClean = typeof reader.deleteAgentChild === 'function'
        const withWorktree = rec.worktree && canClean
          ? await reader.deleteAgentChild!(rec.sessionId, rec.worktree).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
          : undefined
        if (withWorktree && !withWorktree.ok) return { ok: false, error: `Could not delete "${rec.name}" on ${rec.machine}: ${bare(withWorktree.error)}.` }
        if (!withWorktree) {
          const r = await reader.deleteSession(rec.sessionId)
          if (!r.ok) return { ok: false, error: `Could not delete "${rec.name}" on ${rec.machine}: ${bare(r.error)}.` }
        }
        this.forget(rec.sessionId)
        return {
          ok: true, state: 'deleted', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool,
          notice: `It went to ${rec.machine}'s session archive${remoteWorktreeLine(rec, withWorktree)}.`,
        }
      }
    }
  }

  /**
   * Stops the child's turn there, for a stop or a deletion by its caller (#1038): the caller's open tasks to it are withdrawn first (the withdrawal
   * crosses by the receipts), so the stopped turn reports nothing to it
   */
  private stopThere(rec: RemoteAgent, callerId: string, reader: LinkedSessions): ReturnType<LinkedSessions['interrupt']> {
    this.host.linkedTasks?.withdraw(callerId, rec.sessionId)
    return reader.interrupt(rec.sessionId)
  }

  /**
   * A linked machine's event (`LinkedHost.observeLinked`): its link up again (or the machine removed), when a child gone from it is forgotten; a
   * child deleted there, which ends the calls waiting on it
   */
  observe(e: LinkedEvent): void {
    if (e.type === 'machine_resync') return void this.caughtUp(e.machineId)
    if (e.type !== 'session_deleted' || typeof e.sessionId !== 'string' || !this.of(e.sessionId)) return
    this.forget(e.sessionId)
    for (const end of [...(this.waits.get(e.sessionId) ?? [])]) end()
  }

  // ── Waits ───────────────────────────────────────────────────────────────────────────────

  /**
   * Waits up to the bound for Centralu's report on the caller's task `taskId` (#1948 step 6), which comes back from the machine as mail; or for the
   * task to end with none (withdrawn, released there). Past the bound the child is working, and the report reaches the caller as mail
   */
  private async awaitReport(rec: RemoteAgent, callerId: string, taskId: string, signal: AbortSignal | undefined, boundMs: number): Promise<ChildRunResult> {
    const tasks = this.host.linkedTasks
    if (!tasks) return this.working(rec, true)
    let deleted = false
    let end!: () => void
    const gone = new Promise<void>((resolve) => (end = resolve))
    const onDeleted = () => {
      deleted = true
      end()
    }
    const ends = this.waits.get(rec.sessionId) ?? new Set<() => void>()
    ends.add(onDeleted)
    this.waits.set(rec.sessionId, ends)
    let r: 'settled' | 'bound' | 'aborted'
    try {
      r = await tasks.settled(taskId, boundMs, { signal, until: gone })
    } finally {
      ends.delete(onDeleted)
      if (!ends.size) this.waits.delete(rec.sessionId)
    }
    if (deleted) return { ok: false, error: `"${rec.name}" [${rec.sessionId}] was deleted on ${rec.machine} before it finished.` }
    if (r === 'aborted') return { ok: false, error: `The call was cancelled; "${rec.name}" was left running on ${rec.machine}.` }
    if (r === 'bound') return this.working(rec, true)
    return this.reported(rec, callerId, taskId, tasks.standing(taskId))
  }

  /**
   * What a call that waited gives back of the task's end: the report's, which the call has given the caller, so the report is marked read and does
   * not wake it again (`ChildOwnership.answered`). A handoff that moved the child to another session meanwhile leaves the report to it
   */
  private async reported(rec: RemoteAgent, callerId: string, taskId: string, s: TaskStanding): Promise<ChildRunResult> {
    if (this.of(rec.sessionId)?.callerId !== callerId) return this.working(rec, false)
    this.host.children.answered(callerId, rec.sessionId)
    if (s.state === 'open') return this.working(rec, true)
    if (s.state === 'ended') return { ok: false, error: `"${rec.name}" [${rec.sessionId}] on ${rec.machine} did not finish: its task there ended with no report (${s.why}).` }
    if (s.outcome === 'waiting') {
      const reader = this.host.linkedReader
      const cards = reader ? await this.cardsOf(rec, reader) : []
      return cards.length ? this.asking(rec, cards) : this.working(rec, true)
    }
    if (s.outcome === 'failed' || s.outcome === 'stopped') {
      return { ok: false, error: `"${rec.name}" [${rec.sessionId}] on ${rec.machine} did not finish: ${s.error ?? s.reason ?? s.outcome}. Tell the person, or give it a clearer task.` }
    }
    const answer = await linkedWords(this.host.linkedReader, rec.sessionId, rec.name, s.answer)
    // The turn left the child's own background work running there (#721): the final report comes as mail when that work ends
    const paused = s.outcome === 'paused'
    return {
      ok: true, state: 'done', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, answer, readable: [], outside: [],
      notice: `It works on ${rec.machine}: the paths it names are that machine's, not readable from here.${paused ? ' Its own background work still runs there; a final report follows when that work ends.' : ''}`,
    }
  }

  // ── What the caller gets ────────────────────────────────────────────────────────────────

  /** The caller's newest task to the child that is not settled: the work it is on for the caller (`LinkedTasks.open`) */
  private openTask(rec: RemoteAgent): string | undefined {
    return this.host.linkedTasks?.open(rec.callerId, rec.sessionId)
  }

  /**
   * Whether the child is no longer anywhere (#1038): its machine removed from Centralu, or the machine's sessions
   * (read now, or as last known when it cannot be asked) do not have it
   */
  private gone(rec: RemoteAgent, reader: LinkedSessions, listed: readonly OrchestratedSession[]): boolean {
    if (!reader.machineLinked(rec.machineId)) return true
    return !listed.some((s) => s.sessionId === rec.sessionId)
  }

  private working(rec: RemoteAgent, reported: boolean): Extract<ChildRunResult, { state: 'working' }> {
    return { ok: true, state: 'working', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, reported }
  }

  /**
   * The cards standing in the child that its machine shows the caller as a giver of work there, each with whether it may answer (#676, #1948 step 6):
   * that machine alone judges, by its own rule, so none is the caller's from what it gave and none of a turn the person had a part in
   */
  private async cardsOf(rec: RemoteAgent, reader: LinkedSessions): Promise<RoutedCard[]> {
    const r = await reader.cards(rec.sessionId, rec.callerId)
    return r.ok ? r.cards : []
  }

  private asking(rec: RemoteAgent, cards: RoutedCard[]): ChildRunResult {
    return { ok: true, state: 'asking', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, cards }
  }

  /**
   * agent_session answer on a child of a linked machine (#1038), as on a local child's delegated turn (#676): its machine decides whether the caller may,
   * by its own rule for a giver of work there (`host.answerCard`), and the card must still stand as it read it. An approval stays the person's on that
   * computer, whatever the child runs under there: a caller's `auto` (which alone lets a caller answer a local child's approval) may give the child
   * `auto` there (#1273), but never answers that computer's cards, so what runs there is allowed there, by the person
   */
  private async answer(rec: RemoteAgent, card: string | undefined, text: string, reader: LinkedSessions): Promise<ChildRunResult> {
    const cards = await this.cardsOf(rec, reader)
    const chosen = card ? cards.find((c) => c.card === card) : undefined
    if (!chosen) {
      return {
        ok: false,
        error: !card
          ? cards.length ? `Name the card you read: ${cards.map((c) => c.card).join(', ')}.` : `"${rec.name}" has no card waiting.`
          : `Card ${card} no longer stands in "${rec.name}" as you read it: it was answered (the person may have answered first), withdrawn, or replaced by another card. ` +
            (cards.length ? `Read it again: ${cards.map((c) => c.card).join(', ')} stands now.` : 'Nothing is waiting now.'),
      }
    }
    if (chosen.kind === 'approval') {
      return { ok: false, error: `Only the person can answer this approval in "${rec.name}": it runs on ${rec.machine}, and only that computer decides what runs there, whatever preset the session runs under. Tell them if it matters.` }
    }
    const r = await reader.answerCard(rec.sessionId, rec.callerId, chosen.card, text)
    if (!r.ok) return { ok: false, error: `The question was not answered: ${bare(r.error)}.` }
    return { ok: true, state: 'answered', card: chosen.card, sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool }
  }

  // ── The link ────────────────────────────────────────────────────────────────────────────

  /**
   * A machine's link is up again, or the machine was removed (the hub's resync of it): a child gone from it is forgotten (#1038), and holds
   * no place under the ceiling. Read as `list` reads it; not at all if it cannot be read
   */
  private async caughtUp(machineId: unknown): Promise<void> {
    const reader = this.host.linkedReader
    if (!reader || typeof machineId !== 'string') return
    const mine = this.records().filter((r) => r.machineId === machineId)
    if (!mine.length) return
    const listed = await reader.list().catch(() => null)
    for (const rec of mine) if (listed && this.gone(rec, reader, listed)) this.forget(rec.sessionId)
  }

  /**
   * Tells the windows whose child a machine's session is now (#1038): the links name the parent in its rows from here
   * on (`LinkDeps.ownerOf`), and this moves a row the windows hold already. The machine knows no parent for it, and
   * none for its folder: a session start_agent made there is never a worktree manager's
   */
  private owned(sessionId: string, askedBy: string | null): void {
    this.host.emit({ type: 'session_owner', sessionId, askedBy, parentSessionId: null })
  }

  private records(): StoredRemoteAgent[] {
    this.loaded ??= readJsonObjects<StoredRemoteAgent>(
      this.host.store.settings.appSetting(REMOTE_AGENTS_KEY),
      (x) => typeof x.sessionId === 'string' && typeof x.callerId === 'string' && typeof x.machineId === 'string',
    )
    return this.loaded
  }

  private save(list: StoredRemoteAgent[]): void {
    this.loaded = list
    this.host.store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify(list))
  }

  /**
   * The child is gone from the machine: its record goes. A machine removed from Centralu sends nothing back any more, so the tasks still open to the
   * child are released `gone` here, and the stop notice tells their senders (mailbox.md §10.6.1); one deleted there is released there, and that
   * crosses back by the receipts. Not for a caller that is gone (`releases` false): its own going releases what it gave
   */
  private forget(sessionId: string, releases = true): void {
    const rec = this.of(sessionId)
    if (!rec) return
    this.save(this.records().filter((r) => r.sessionId !== sessionId))
    const reader = this.host.linkedReader
    if (releases && reader && !reader.machineLinked(rec.machineId)) this.host.linkedTasks?.gone(sessionId)
  }

  /** What start_agent and a send rest on in the caller, read again after a card and before each send: a local start's (`agentStartGateError`) */
  private gateError(callerId: string): string | null {
    // Never the Assistant's place (`''`): a caller here is a project's session, and one with none has none registered
    return agentStartGateError(this.host, callerId, this.host.meta.get(callerId)?.projectId || null)
  }

  /** The caller's preset as it is now; `safe` for one gone, so nothing is decided on a preset no one has */
  private callerPreset(callerId: string): PermissionPreset {
    return this.host.meta.get(callerId)?.permissionPreset ?? 'safe'
  }

  /** Why a start stops when the caller's preset fell below the child's while it went on (#1273), or null */
  private loweredError(callerId: string, preset: PermissionPreset, what: string): string | null {
    const now = this.callerPreset(callerId)
    return presetWithin(preset, now) ? null : `This session now runs under ${now}, below the ${preset} the child would have run under, ${what}. Start it again if it is still wanted. ${ASK_THE_PERSON}`
  }

  /** What the machine says of an `auto` caller's child (#1273): whether it takes `auto` from this computer, or why not */
  private async autoThere(machine: { id: string; name: string }, reader: LinkedSessions): Promise<AutoThere | { error: string }> {
    const r = await reader.hubAuto(machine.id)
    if (r.ok) return r.allowed ? { auto: true } : { auto: false, withheld: 'machine_off' }
    return { error: `Could not tell whether ${machine.name} takes auto from this computer: ${bare(r.error)}. Nothing was started there.` }
  }

  /** The machine's project that is a checkout of this project's repository: the same `origin`, read on both sides */
  private async checkoutOn(
    machine: { id: string; name: string },
    project: { id: string; name: string },
    reader: LinkedSessions,
  ): Promise<{ project: LinkedProject } | { error: string }> {
    const origin = await this.host.files.projectOrigin(project.id)
    const key = origin ? gitRemoteKey(origin) : null
    if (!origin || !key) {
      return { error: `This project has ${origin ? 'a local folder as its origin remote' : 'no origin remote'}, so no checkout of it on ${machine.name} can be told apart. Start the agent here, without machine.` }
    }
    // Only this machine is waited for if it is down (#1532): a lookup does not wait on the others
    const all = await reader.projects({ machineId: machine.id })
    const away = all.away.find((a) => a.machineId === machine.id)
    // One the person disconnected names the person, who can connect it (#1341); `why` says what a call's attempt to connect it met (#1532)
    if (away) return { error: awayRefusal(machine.name, away.why, 'nothing was started there') }
    const theirs = all.projects.filter((p) => p.machineId === machine.id)
    const read = await Promise.all(theirs.map(async (p) => ({ p, r: await reader.origin(p) })))
    // Asked and not reached: the link went away after the list was read. That is the machine away, not a machine without the checkout
    const unreached = read.map(({ r }) => (!r.ok && (r.error.includes(NOT_REACHABLE) || r.error.includes(NOT_CONNECTED_PHRASE)) ? r.error : null))
    if (read.length > 0 && unreached.every((e) => e !== null)) {
      // One the person disconnected meanwhile says so, as above
      return { error: awayRefusal(machine.name, unreached.every((e) => e?.includes(NOT_CONNECTED_PHRASE)) ? NOT_CONNECTED : NOT_REACHABLE, 'nothing was started there') }
    }
    const same = read.filter(({ r }) => r.ok && r.origin && gitRemoteKey(r.origin) === key).map(({ p }) => p)
    const chosen = same.length === 1 ? same[0] : same.filter((p) => p.name === project.name).length === 1 ? same.find((p) => p.name === project.name) : undefined
    if (chosen) return { project: chosen }
    if (same.length) return { error: `${machine.name} has more than one checkout of ${key}: ${same.map((p) => `"${p.name}"`).join(', ')}, none named as this project is. Choosing among them is not available yet: the person can remove the extra one there.` }
    const listed = read.map(({ p, r }) => `"${p.name}" (${r.ok ? shownRemote(r.origin) : 'not read'})`).join(', ')
    return { error: `${machine.name} has no checkout of ${key}, so nothing was started there.${listed ? ` Its projects: ${listed}.` : ' It has no projects.'} The person can clone it there first.` }
  }
}

/**
 * A linked machine's session's answer to the task a call gave it, for start_agent's child and an ask_project task there alike: the words its report on
 * that task kept (`kept`), its turn's own (#1812). A session's latest turn there may be a later one (the person's, after the task's ended), so its last
 * words are read there only to give the whole answer, cut as an answer is cut here with the read that shows the rest (#1186), and only when they are the
 * report's: they begin with the words it kept. Otherwise, or when they cannot be read, the kept words are the answer. A report that kept none is a turn
 * that said nothing
 */
export async function linkedWords(reader: LinkedSessions | null, sessionId: string, name: string, kept: string | undefined): Promise<string> {
  if (!kept) return NO_WORDS
  const words = reader ? await reader.lastWords(sessionId, ANSWER_READ_MAX_CHARS, { turn: true }).catch(() => null) : null
  // The report keeps the head of the answer, cut with an ellipsis (`clipPreview`)
  const head = kept.endsWith('…') ? kept.slice(0, -1) : kept
  if (words?.ok && words.text.startsWith(head)) return clipAnswer(words.text, name, words.seq !== null ? { sessionId, seq: words.seq } : undefined)
  return kept === head ? clipAnswer(kept, name) : `${kept}[the rest is cut here; read_session(sessionId="${sessionId}") reads it whole]`
}
