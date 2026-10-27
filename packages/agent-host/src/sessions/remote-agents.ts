import { randomUUID } from 'node:crypto'
import { gitRemoteKey, type ApprovalDetail, type BackgroundTask, type PermissionPreset, type SessionInfo, type SessionState } from '@cc/protocol'
import type { AgentListRow, AgentSessionOpts, ChildRunResult, LinkedProject, LinkedSessions, OrchestratedSession, RoutedCard, StartAgentOpts } from '../adapters/contract.js'
import { awayPhrase, NOT_CONNECTED, NOT_CONNECTED_PHRASE, NOT_REACHABLE } from '../adapters/contract.js'
import { gitValidBranchName } from '../dev-services/git-worktree.js'
import { readJsonObjects } from '../dev-services/store/json.js'
import { asObj } from '../json-value.js'
import { inTurn } from '../idle.js'
import { agentDepthRefusal, depthOf } from './agent-depth.js'
import { ANSWER_READ_MAX_CHARS, ASK_WAIT_MS, clipAnswer, NO_WORDS, taskLine } from './ask-project.js'
import { answersFrom, cardCall, cardHandle, cardNotice } from './delegated-cards.js'
import type { DelegationHost } from './delegation-host.js'
import type { LinkedEvent } from './linked-reports.js'
import { HUB_SENDER } from './hub-sender.js'
import { linkedTurnEnd } from './linked-turn-end.js'
import { agentBranch, agentChoice, agentName, agentNoteFrame, distinguishingText, givenAgentName, presetWithin, remoteAgentFrame } from './start-agent.js'
import { ASK_THE_PERSON, START_AGENT_CALL_MS, START_AGENT_SETUP_MS } from './start-agent-terms.js'
import { labelOf } from './transcript-view.js'
import { raceBound } from './with-timeout.js'
import { raceTimeout } from '../timing.js'

/**
 * A child start_agent started on a linked machine (#1038), as the hub keeps it: the machine's session (its qualified
 * id), the session that started it, and what the hub says of it when the machine cannot be asked. Kept in the store, so
 * agent_session still finds it after the hub restarts.
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
   * The preset the machine started it under (#1273 review): a send is refused once the caller has less, as a local
   * child's is (`agent-session-actions.ts`). Absent from a record made before #1273, when it was `normal` at most
   */
  preset?: PermissionPreset
  startedAt: number
  /** The turn its caller last gave it (a start, a send at rest): its cards' handles name it, as a delegated turn's do (#676) */
  turn?: string
  /**
   * The end of the turn its caller gave it is owed to the caller (a call waits on it, or its report is armed), kept so a
   * restarted hub still reports it (`restore`); `paused`, the background work its report is held over there (#723)
   */
  owed?: { paused?: BackgroundTask[] }
  /** The last instruction the hub sent it, as the machine records it: a turn that took it is the caller's (#1038 review) */
  sent?: string
  /**
   * Whose the child's current or last turn is, as last settled (`Whose`): kept so a turn the person took stays theirs
   * across a restart. `caller` is read again after a restart, as anything may have happened there meanwhile
   */
  whose?: 'caller' | 'other'
  /**
   * The rows of the messages its caller gave the child that the tool may run as a turn of its own (#1604): its notes into a
   * running turn, which a tool that does not read one there runs once that turn ends, and its instruction sent at rest, which
   * can run after another message given before it. The machine says which message a turn began for on the event that opens it
   * (`origin.seq` names the row); only a turn whose origin is a row held here, sent by this hub, is taken for the caller's.
   * Kept in the record, so a restart or a link's loss between a note and its turn does not lose it. A row goes when a turn is
   * run for it or for a later one, and all go once the turn is another's (`setWhose`). Not with a send at rest: that one is the
   * caller's too, and the turns of the notes before it are still to come (the gap between a turn's end and the next)
   */
  given?: number[]
}

/**
 * Whose the child's current or last turn is, from this hub's own evidence only (#1038 review, RV13): `caller` once the
 * machine recorded the instruction this hub last sent (from this link's `HUB_SENDER`, with the kept text) while no other
 * turn ran there, and nothing else since; `other` once anything else came (the person's message, the instruction taken
 * into a turn already running); `unknown` while an instruction is on its way, and from a link's loss or a restart until
 * the machine's last message is read again (`verify`)
 */
type Whose = 'caller' | 'other' | 'unknown'

/**
 * What the gate lets through (`RemoteAgents.gate`): `owned`, the current or last turn is the caller's, so its words and
 * state are; `live`, that turn is running now (not ended, nor held over its background work), so its cards, an answer to
 * them and a note into it are the caller's too. Not owned: the caller gets the fact and the state word, nothing more
 */
type Gate = { owned: boolean; live: boolean; whose: Whose }

/** The most rows of the caller's messages a child's record holds for turns to come (`RemoteAgent.given`) */
const MAX_GIVEN_ROWS = 64

/** The record with nothing owed */
const withoutOwed = (r: RemoteAgent): RemoteAgent => {
  const { owed: _owed, ...rest } = r
  return rest
}

/** A machine's sentence to go inside another, without its own full stop */
const bare = (error: string): string => error.trim().replace(/\.+$/, '')

/**
 * How long a start waits for the machine to say its instructions for agents now (#1161 review), once the child is made
 * there: the machine just answered, so this is short. Past it, what it listed before the card goes with the task
 */
export const INSTRUCTIONS_WAIT_MS = 5_000


/**
 * What became of a deleted child's worktree on its machine (#1161 item 3), as the rest of "It went to <machine>'s
 * trash": removed, left and why, or left because the machine's build predates the cleanup. Nothing for a child started
 * without a worktree.
 */
function remoteWorktreeLine(
  rec: RemoteAgent,
  done: { worktree: 'removed' | 'kept' | 'none'; path?: string; branch?: string; why?: string; note?: string } | 'older' | undefined,
): string {
  if (!rec.worktree) return ''
  if (done === 'older' || !done) {
    return `; its worktree there, on ${rec.worktree}, stays${done === 'older' ? `: ${rec.machine} runs a Centralu from before #1161, which does not remove it` : ''}. The person deletes it on that machine`
  }
  const where = `its worktree there${done.path ? ` (${done.path})` : ''}, on ${done.branch ?? rec.worktree}`
  // The machine's cleanup said what it did itself (the folder already gone, a branch kept by what it holds): said as it is
  if (done.note) return done.worktree === 'none' ? `; ${bare(done.note)}` : `; as for ${where}: ${bare(done.note)}`
  if (done.worktree === 'removed') return `, and ${where}, was removed with its branch: nothing in it was uncommitted or unpushed`
  if (done.worktree === 'none') return `; it had no worktree of its own there any more`
  return `; ${where}, was left: ${bare(done.why ?? 'the machine did not say why')}`
}

/**
 * A remote address as an answer may show it (#1038 review): the repository it names, never the address as written, which
 * can carry a user and a token (`https://user:ghp_…@github.com/…`). A local path is said to be one.
 */
const shownRemote = (url: string | null): string => (url === null ? 'no origin' : (gitRemoteKey(url) ?? 'a local path'))

/**
 * The most a child on another machine runs under when its caller's `auto` is not carried (#1038 review, as
 * create_session over a link, #838): `normal`. An `auto` caller's is carried only to a machine that takes it (#1273,
 * `AutoThere`), as that machine's own switch says.
 */
const remotePreset = (caller: PermissionPreset): PermissionPreset => (presetWithin(caller, 'normal') ? caller : 'normal')

/**
 * The caller's preset as `fromHub` carries it (#1273). The machine reads only `auto` from it; `edits` (#1525) is never put
 * on the link, because a machine from before it refuses a whole start for a value it does not know: it goes as `normal`,
 * the preset the child there runs under.
 */
const carriedPreset = (caller: PermissionPreset): PermissionPreset => (caller === 'auto' ? 'auto' : remotePreset(caller))

/**
 * What a machine says of an `auto` caller's child (#1273, `LinkedSessions.hubAuto`): `auto`, it runs under `auto` there
 * too and no card is raised; otherwise why it runs under `normal` (its switch is off, or its Centralu predates it)
 */
type AutoThere = { auto: true } | { auto: false; withheld: 'machine_off' | 'older' }

/** What the start tells an `auto` caller of its child's preset (#1273), for its notice */
const autoNotice = (machine: string, there: AutoThere): string =>
  there.auto
    ? `it runs under auto on ${machine}, as this session does`
    : there.withheld === 'machine_off'
      ? `it runs under normal on ${machine}: that computer does not take auto from another computer (its "Allow auto from a linked computer" setting is off)`
      : `it runs under normal on ${machine}: that computer runs a Centralu from before #1273, which does not take auto from another computer`

/** Where the hub keeps its children on linked machines: one app setting, so an older build leaves it alone */
export const REMOTE_AGENTS_KEY = 'remote_agents'

/**
 * What a child on a linked machine reaches of the session manager (#1038), typed as the manager declares each member.
 * The manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type RemoteAgentsHost = Pick<
  DelegationHost,
  'askHost' | 'autoBoundaryOpen' | 'children' | 'emit' | 'linkedReader' | 'meta' | 'store' | 'tellSession' | 'uiPreferences' | 'projectOrigin' | 'linkedTasksRunning' | 'settleLinkedTurn'
>

/**
 * The project's ceiling on agents working at once (`AgentStartGates`, reached through the start flow): a child on a
 * linked machine counts under its parent's project (#1038), and its start holds a place from its check, as a local one
 */
export type AgentPlaces = {
  agentCeilingError(callerId: string, projectId: string): string | null
  reservePlace(callerId: string, projectId: string): { release: () => void } | { error: string }
}

/** How a wait on a remote child's turn ended; `taken`: the turn turned out not to be the caller's (`whose` became `other`) */
type Step = { step: 'completed' } | { step: 'failed'; error: string } | { step: 'deleted' } | { step: 'unreachable'; machine: string } | { step: 'asking' } | { step: 'taken' }

/** A call waiting on a remote child's turn: the turn's end as the machine's events tell it */
type TurnWait = { busy: boolean; done: Promise<Step>; end(step: Step): void }

/**
 * start_agent on a linked machine (#1038) and agent_session on what it starts there. The child is a session of the
 * machine's checkout of the caller's repository (the same `origin`, `gitRemoteKey`), made over the link under the
 * caller's preset and one level below it in the agent depth (`CreateSessionParams.agentDepth`), after a card that
 * names the machine. Its turn's end comes back as a linked machine's session's does for the orchestrator (`LinkedReports`,
 * #723), to the session that started it; a call waiting on it reads the answer instead, as a local child's wait does.
 * A link that drops is said to the parent, and a turn that ended while it was down is reported once it is back.
 *
 * The person may use the same session on that machine. Nothing of a turn that is not the caller's reaches the caller
 * (#1038 review, RV13): every path that hands the caller anything of the child (status, wait, answer, send, a card's
 * notice, the linked report's text) passes one gate (`gate`), which reads whose the turn is (`Whose`) from this hub's
 * own evidence. What does not pass gets the fact and the state word.
 */
export class RemoteAgents {
  private loaded: RemoteAgent[] | null = null
  private readonly waits = new Map<string, TurnWait>()
  /** Children whose parent was told their link dropped, until it is back */
  /**
   * The children whose caller was told the link dropped, with whether the notice said that nothing here reconnects the machine
   * (#1341). One told only that the link dropped is told again when the machine turns out to wait for the person: the person
   * turned Auto reconnect off, or disconnected it, while it was down
   */
  private readonly toldDown = new Map<string, boolean>()
  /** The turns an update of their machine cut whose callers were told it goes on (#1618), by session and when it was continued: once each */
  private readonly toldCut = new Set<string>()
  /** The cards of a caller's turn its caller was told of, once each (`<session>\0<turn>\0<request>`, #676) */
  private readonly toldCards = new Set<string>()
  /** Whose each child's turn is, as settled in this host (`Whose`); one not here is read from its record (`whoseOf`) */
  private readonly whose = new Map<string, Whose>()
  /** What made a turn another's, when it is told (#1576): a message from another session of this hub, else it is read as the person's */
  private readonly otherBy = new Map<string, 'session' | 'person'>()
  /** Notes sent into a running turn whose record has not come back yet (memory only): two quick notes both are the caller's own */
  private readonly notesSent = new Map<string, string[]>()
  /** Children an instruction is on its way to: its own send's answer says what came of it, and the machine is not read meanwhile */
  private readonly pending = new Set<string>()
  /** Children whose turn's end the linked reports held back while whose the turn was could not be told (`reportGate`) */
  private readonly deferred = new Set<string>()
  /** Children in a turn there, as their machine's events last said (`trackBusy`); unknown, and so cleared, when the link drops */
  private readonly busy = new Set<string>()
  /** The last message number seen of each child there, so a link's replay of a message is not taken twice */
  private readonly lastSeq = new Map<string, number>()

  constructor(
    private readonly host: RemoteAgentsHost,
    private readonly places: AgentPlaces,
  ) {}

  /**
   * At startup (#1038): what was owed of each child when the last host stopped is owed again, to a caller still here. A
   * call that waited on it is gone with that host, so its end is the caller's report now. Whose the child's turn is was
   * not watched meanwhile (`whoseOf` reads it `unknown`): once the machine's link is up the child is read (`caughtUp`),
   * and only a turn that is still the caller's is reported. A report held over the child's background work waits for
   * that work as before: the link's resync reads it whole and starts the settle wait (`LinkedReports.resync`), not
   * before (#1038 review): a link still connecting past the settle wait would have settled every task as ended.
   */
  restore(): void {
    for (const r of this.records()) {
      if (!r.owed) continue
      if (!this.host.meta.has(r.callerId)) {
        this.save(this.records().map((x) => (x.sessionId === r.sessionId ? withoutOwed(x) : x)))
        continue
      }
      this.host.children.setLinkedReport(r.sessionId, { orchestratorId: r.callerId, busy: false, ...(r.owed.paused ? { paused: r.owed.paused } : {}) })
      if (!r.owed.paused) this.toldDown.set(r.sessionId, false)
    }
  }

  /** The hub's record of a child on a linked machine, by its qualified id */
  of(sessionId: string): RemoteAgent | undefined {
    return this.records().find((r) => r.sessionId === sessionId)
  }

  /**
   * The caller's children on linked machines, as agent_session list shows them (#690), each with its machine and the
   * state that machine reports (as last known when it cannot be asked): a state word, nothing of any turn. One gone from
   * its machine, or whose machine was removed, is dropped from the record here (#1038 review).
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
      const state: AgentListRow['state'] =
        there?.state === 'waiting_approval' || there?.state === 'waiting_question' ? 'waiting'
        : there ? (inTurn(there.state as SessionState) ? 'working' : 'finished')
        : this.waits.has(r.sessionId) || this.reportArmed(r) ? 'working' : 'finished'
      out.push({ sessionId: r.sessionId, name: r.name, tool: r.tool, state, asleep: false, machine: r.machine })
    }
    return out
  }

  /**
   * How many children the project's sessions started on linked machines are working now (#1038): the turn the caller
   * gave is running as far as the hub knows, a call waits on it or its report is owed. One whose turn ended with its
   * own background work still running there is not, as a local child whose turn ended is not (#721)
   */
  workingIn(projectId: string): number {
    const mine = this.records().filter((r) => this.host.meta.get(r.callerId)?.projectId === projectId)
    if (!mine.length) return 0
    const reader = this.host.linkedReader
    return mine.filter((r) => {
      // A removed machine's child is out of reach for good: no end of it will come to free the place (#1038 review)
      if (!reader?.machineLinked(r.machineId)) return false
      const report = this.host.children.linkedReports.get(r.sessionId)
      return this.waits.has(r.sessionId) || (report?.orchestratorId === r.callerId && !report.paused)
    }).length
  }

  /**
   * The caller is gone (trashed): its children's records go, and nothing is owed to it (#1038 review). Each stays on
   * its machine, and goes back to that machine's project in the sidebar
   */
  forgetCaller(callerId: string): void {
    for (const r of this.records().filter((x) => x.callerId === callerId)) {
      this.forget(r.sessionId)
      this.owned(r.sessionId, null)
    }
  }

  /** A handoff gave the original's work to `to` (#693): its children on linked machines are the heir's, report included */
  moveCaller(from: string, to: string): void {
    const moving = this.records().filter((r) => r.callerId === from)
    if (!moving.length) return
    this.save(this.records().map((r) => (r.callerId === from ? { ...r, callerId: to } : r)))
    for (const r of moving) this.owned(r.sessionId, to)
    for (const [id, report] of [...this.host.children.linkedReports]) {
      if (report.orchestratorId === from && this.of(id)) this.host.children.setLinkedReport(id, { ...report, orchestratorId: to })
    }
  }

  /**
   * Whether a report about this session may go now (`LinkedReportsHost.reportGate`, #1038 review): the linked reports
   * send a child's words only through the gate. A turn that is the caller's is reported; another's to nobody; one whose
   * owner the hub cannot tell yet (a link's return not read yet) stays owed, and is settled once it can (`caughtUp`)
   */
  reportGate(sessionId: string): 'deliver' | 'withhold' | 'defer' {
    const rec = this.of(sessionId)
    if (!rec) return 'deliver'
    const g = this.gateNow(rec)
    if (g.owned) return 'deliver'
    if (g.whose === 'other') return 'withhold'
    this.deferred.add(sessionId)
    void this.settleDeferred(rec)
    return 'defer'
  }

  /**
   * A turn's end the linked reports held back while whose the turn was could not be told (#1038 review): read whose it
   * is now, and if the caller's, report it as its end would have been (or, if the child is in a turn again, when that
   * ends). Another's ends what was owed (`setWhose`). Not now (an instruction on its way, the machine not answering), the
   * send's answer or the link's next resync settles it
   */
  private async settleDeferred(rec: RemoteAgent): Promise<void> {
    const reader = this.host.linkedReader
    if (!reader || this.pending.has(rec.sessionId)) return
    await this.verify(rec, reader)
    const report = this.host.children.linkedReports.get(rec.sessionId)
    if (!report || report.orchestratorId !== rec.callerId || report.paused || !this.gateNow(rec).owned) return
    const now = await reader.read(rec.sessionId, 1)
    if (!now.ok || this.host.children.linkedReports.get(rec.sessionId) !== report || !this.gateNow(rec).owned) return
    this.deferred.delete(rec.sessionId)
    if (inTurn((now.state ?? 'idle') as SessionState)) report.busy = true
    else this.host.settleLinkedTurn(rec.sessionId)
  }

  async startAgent(callerId: string, opts: StartAgentOpts & { machine: string }, signal?: AbortSignal): Promise<ChildRunResult> {
    const startedAt = Date.now()
    const caller = this.host.meta.get(callerId)
    if (!caller?.projectId) {
      return { ok: false, error: caller?.kind === 'orchestrator'
        ? 'The orchestrator starts a session on a linked machine with create_session; start_agent with a machine is for a project\'s session.'
        : 'This session belongs to no project, so it cannot start agents.' }
    }
    const refused = this.gateError(callerId)
    if (refused) return { ok: false, error: refused }
    const project = this.host.store.projects.listProjects().find((p) => p.id === caller.projectId)!
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
    // An auto caller's child runs auto there too where that machine takes it (#1273), and then no card is raised
    const asked = this.callerPreset(callerId) === 'auto' ? await this.autoThere(machine, reader) : null
    if (asked && 'error' in asked) return { ok: false, error: asked.error }
    const tool = opts.tool ?? target.defaultTool ?? caller.tool
    // The person's model for a difficulty is read here, as for a local child; the machine is not asked for its list
    const { model, effort, difficulty } = agentChoice(opts, undefined, this.host.uiPreferences().agentModels?.[tool])
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
     * Decided from the caller as it is now, after every wait above (#1273 review): a caller that left `auto` while the
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
     * Asked each time (#1038 review), with no "always": nothing is remembered for another machine. Except for an `auto`
     * caller whose child runs `auto` there too (owner decision 2026-10-19, #1273): the person let this session act
     * without asking, and that machine's own switch lets a linked computer's `auto` reach it. A `normal` or `safe`
     * caller, or a machine whose switch is off or that cannot take `auto`, is asked
     */
    const unasked = there?.auto === true && this.host.autoBoundaryOpen(callerId, `start an agent on ${machine.name} under auto`)
    // The card is bounded as a local start's setup is (#660): past it the card goes and nothing is made
    const ctl = new AbortController()
    let decision: Awaited<ReturnType<RemoteAgentsHost['askHost']>> = 'allow'
    if (!unasked) {
      const onAbort = () => ctl.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) ctl.abort()
      const timer = setTimeout(() => ctl.abort(), START_AGENT_SETUP_MS)
      try {
        decision = await this.host.askHost(callerId, detail, ctl.signal, { alwaysAsk: true })
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
    // The caller's preset may have changed while the card stood: never a child above it (#1273 review)
    const lowered = this.loweredError(callerId, preset, `so nothing was started on ${machine.name}`)
    if (lowered) return { ok: false, error: lowered }
    // A place is held from here until the child counts (its wait or report armed), so starts at once cannot pass the ceiling together
    const place = this.places.reservePlace(callerId, project.id)
    if ('error' in place) return { ok: false, error: place.error }
    try {
      return await this.makeChild(callerId, caller, opts, { machine, target, tool, name, model, effort, branch, startedAt, preset, there, unasked }, reader, place.release, signal)
    } finally {
      place.release()
    }
  }

  /** The child made on the machine once allowed, its task sent, and its answer waited for (`startAgent`) */
  private async makeChild(
    callerId: string,
    caller: SessionInfo,
    opts: StartAgentOpts & { machine: string },
    c: {
      machine: { id: string; name: string }; target: LinkedProject; tool: string; name?: string; model?: string; effort?: string; branch?: string; startedAt: number
      /** The preset it is to run under there, what the machine said of an `auto` caller's, and whether no card was asked (#1273) */
      preset: PermissionPreset; there: AutoThere | null; unasked: boolean
    },
    reader: LinkedSessions,
    counted: () => void,
    signal?: AbortSignal,
  ): Promise<ChildRunResult> {
    const { machine, target, tool, name, model, effort, branch, startedAt, there, unasked } = c
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
    // Read again now: the caller's preset may have dropped while the machine made it (#1273 review)
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
     * (#1161 review): the card may have stood a while, and a machine connected on demand was listed from its mirror
     */
    const task = remoteAgentFrame(label, opts.task, await this.instructionsOn(reader, target))
    const rec: RemoteAgent = {
      sessionId: made.sessionId, callerId, machineId: machine.id, machine: machine.name, name: made.name, tool,
      project: target.name, ...(branch ? { worktree: branch } : {}), startedAt: Date.now(), sent: task, turn: randomUUID(),
      preset: childPreset,
    }
    this.save([...this.records(), rec])
    // Its row came to the windows before the hub knew whose it is: now it names the caller as its `askedBy`, and the caller points to it (#1038, #1416)
    this.owned(rec.sessionId, callerId)
    // Its task is on its way: whose its turn is, its record there says (`messageTaken`)
    this.whose.set(rec.sessionId, 'unknown')
    this.pending.add(rec.sessionId)
    /*
     * Set before the send, as the machine's first events can reach the hub before its answer does (#1038 review: a turn
     * that failed at once was reported, and the wait that came after it waited out its bound): the call's wait when it
     * waits, otherwise the report
     */
    const waiting = opts.wait === false ? undefined : this.openWait(rec.sessionId)
    if (!waiting) this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: callerId, busy: false })
    // It counts by itself now (`workingIn`)
    counted()
    // The machine counts the task's turn one level below the caller too, whatever it keeps of the session (#838)
    const sent = await reader.send(rec.sessionId, task, label, { depth: depthOf(this.host, callerId) + 1 })
    this.pending.delete(rec.sessionId)
    if (!sent.ok) {
      if (waiting && this.waits.get(rec.sessionId) === waiting) this.dropWait(rec.sessionId)
      if (this.host.children.linkedReports.get(rec.sessionId)?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
      return { ok: false, error: `The session "${rec.name}" [${rec.sessionId}] was made on ${machine.name} but did not take the task: ${bare(sent.error)}. Send it again with agent_session, or delete it.` }
    }
    // The machine recorded the task before it answered: a task not taken as a turn of its own (the person's first message came first) is not followed
    const notTaken = this.unclaimed(rec, waiting)
    if (notTaken) return notTaken
    const unchecked = [
      model || effort ? `${[model && `model "${model}"`, effort && `effort "${effort}"`].filter(Boolean).join(' and ')} not checked against ${machine.name}'s list` : '',
      // Not passed across (#1038 review): said, rather than dropped without a word
      opts.lsp ? `lsp is not passed to another machine: it starts as ${machine.name} starts a session` : '',
      // As the machine started it: a switch turned off after its answer leaves a carded start under normal (#1273 review)
      there ? autoNotice(machine.name, there.auto && childPreset !== 'auto' ? { auto: false, withheld: 'machine_off' } : there) : '',
    ].filter(Boolean).join('; ') || undefined
    const left = Math.max(1_000, START_AGENT_CALL_MS - (Date.now() - startedAt))
    // The wait opened before the send: a turn that ended inside the send has settled it already
    const result = waiting ? await this.awaitTurn(rec, signal, Math.min(ASK_WAIT_MS, left), waiting) : this.working(rec, true)
    return result.ok && unchecked ? { ...result, notice: [result.notice, unchecked].filter(Boolean).join('; ') } : result
  }

  /**
   * The instructions of the machine's copy of the project as it has them now (#1161 item 2), or as it listed them
   * before the card when it cannot say (#1161 review): a reader without the read, one that fails or throws, one that
   * does not answer within `INSTRUCTIONS_WAIT_MS`. Never a reason the start stops; a machine that predates them listed
   * none, so its child starts without them, as it did before.
   */
  private async instructionsOn(reader: LinkedSessions, target: LinkedProject): Promise<string> {
    const listed = target.agentInstructions ?? ''
    if (typeof reader.agentInstructions !== 'function') return listed
    const now = await raceTimeout(reader.agentInstructions(target).catch(() => null), INSTRUCTIONS_WAIT_MS, null)
    return now?.ok ? now.text : listed
  }

  /** agent_session on a child of a linked machine (#1038): status, wait, send, stop, delete, through the link */
  async agentSession(callerId: string, rec: RemoteAgent, opts: AgentSessionOpts, signal?: AbortSignal): Promise<ChildRunResult> {
    if (rec.callerId !== callerId) return { ok: false, error: `${rec.sessionId} is not a session this session started. agent_session works only on sessions start_agent started from here.` }
    const reader = this.host.linkedReader
    if (!reader) return { ok: false, error: `${rec.sessionId} is on ${rec.machine}, and no machine is linked to this computer now.` }
    const label = labelOf(this.host.store.messages, this.host.meta.get(callerId)!)
    const stateOf = async (): Promise<{ ok: true; state: SessionState; running: boolean } | { ok: false; error: string }> => {
      const r = await reader.read(rec.sessionId, 1)
      if (!r.ok) return { ok: false, error: `${rec.machine} cannot be asked about "${rec.name}" now: ${r.error ?? 'no answer'}` }
      const state = (r.state ?? 'idle') as SessionState
      // A turn its events said began since counts too: the state read may predate it (#1038 review)
      return { ok: true, state, running: inTurn(state) || this.busy.has(rec.sessionId) }
    }
    switch (opts.action) {
      case 'answer':
        return this.answer(rec, opts.card, opts.text ?? '', reader)
      case 'status': {
        const now = await stateOf()
        if (!now.ok) return now
        const g = await this.gate(rec, reader)
        const running = now.running || this.waits.has(rec.sessionId)
        if (!g.owned) return this.notYours(rec, g, running, now.state)
        if (!running) return this.atRest(rec, now.state, reader)
        // The cards of the turn it gave are what the caller reads first, as for a local child (#676)
        const cards = g.live ? await this.cardsOf(rec, reader) : []
        return cards.length ? this.asking(rec, cards) : this.working(rec, this.reportArmed(rec))
      }
      case 'wait': {
        const g = await this.gate(rec, reader)
        if (!g.owned) {
          const now = await stateOf()
          if (!now.ok) return now
          return this.notYours(rec, g, now.running, now.state)
        }
        if (this.waits.has(rec.sessionId) || this.reportArmed(rec)) return this.awaitTurn(rec, signal, ASK_WAIT_MS)
        const now = await stateOf()
        if (!now.ok) return now
        return now.running ? this.awaitTurn(rec, signal, ASK_WAIT_MS) : this.atRest(rec, now.state, reader)
      }
      case 'send': {
        const text = opts.text?.trim()
        if (!text) return { ok: false, error: 'Give the text to send.' }
        // Never work for a child above its caller (#1273 review), as a local child's send (agent-session-actions.ts)
        const childPreset = rec.preset ?? 'normal'
        const own = this.callerPreset(callerId)
        if (!presetWithin(childPreset, own)) {
          return { ok: false, error: `"${rec.name}" now has more permissions (${childPreset}) than this session (${own}), so this session cannot give it work. Tell the person.` }
        }
        const now = await stateOf()
        if (!now.ok) return now
        if (now.running) {
          /*
           * A note into the turn the caller gave it, as into a local child's (#646): the machine takes it into the
           * running turn as it takes the person's message there. Nothing is armed again: the turn's end is still the one
           * owed. Another's turn there (the person's on that machine) is not the caller's to add to, and neither a queue
           * nor a fork reaches another machine
           */
          const g = await this.gate(rec, reader)
          if (!g.live) {
            return { ok: false, error: `"${rec.name}" is busy on ${rec.machine} with ${this.otherTurn(rec, g)}. A queue or a fork does not reach another machine: try again once it is at rest.` }
          }
          const refused = this.gateError(callerId)
          if (refused) return { ok: false, error: refused }
          // Kept before it goes, as the machine records it before it answers: its record tells the turn that took it
          const framed = agentNoteFrame(label, text)
          this.sentNow(rec.sessionId, framed)
          this.notesSent.set(rec.sessionId, [...(this.notesSent.get(rec.sessionId) ?? []), framed])
          const sent = await reader.send(rec.sessionId, framed, label, { depth: depthOf(this.host, callerId) + 1 })
          if (!sent.ok) {
            const at = (this.notesSent.get(rec.sessionId) ?? []).lastIndexOf(framed)
            if (at >= 0) this.notesSent.set(rec.sessionId, (this.notesSent.get(rec.sessionId) ?? []).filter((_, i) => i !== at))
            return { ok: false, error: `Could not send to "${rec.name}" on ${rec.machine}: ${bare(sent.error)}.` }
          }
          // Taken while the turn was still the caller's, it is part of that turn; otherwise the gate has closed on it
          return this.gateNow(rec).live ? this.working(rec, this.reportArmed(rec) || this.waits.has(rec.sessionId)) : this.wentElsewhere(rec)
        }
        const refused = this.gateError(callerId)
        if (refused) return { ok: false, error: refused }
        // New work counts under the caller's project as a local child's does (#1038); nothing is awaited up to the arming
        const full = this.places.agentCeilingError(callerId, this.host.meta.get(callerId)?.projectId ?? '')
        if (full) return { ok: false, error: full }
        // A new turn: its cards are new cards (#676), and whose it is, the machine's record of this instruction says
        const framed = agentNoteFrame(label, text)
        this.save(this.records().map((r) => (r.sessionId === rec.sessionId ? { ...r, turn: randomUUID(), sent: framed } : r)))
        this.notesSent.delete(rec.sessionId)
        this.whose.set(rec.sessionId, 'unknown')
        this.pending.add(rec.sessionId)
        this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: callerId, busy: false })
        const sent = await reader.send(rec.sessionId, framed, label, { depth: depthOf(this.host, callerId) + 1 })
        this.pending.delete(rec.sessionId)
        if (!sent.ok) {
          if (this.host.children.linkedReports.get(rec.sessionId)?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
          return { ok: false, error: `Could not send to "${rec.name}" on ${rec.machine}: ${bare(sent.error)}.` }
        }
        return this.unclaimed(rec, undefined) ?? this.working(rec, true)
      }
      case 'stop': {
        // Stopped by the one it would report to: nothing more is owed. Taken down first, as the stopped turn's end can
        // reach the hub before the machine's answer does; put back if the stop does not go
        const owed = this.host.children.linkedReports.get(rec.sessionId)
        if (owed?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
        const r = await reader.interrupt(rec.sessionId)
        if (!r.ok) {
          if (owed?.orchestratorId === callerId && !this.host.children.linkedReports.has(rec.sessionId)) this.host.children.setLinkedReport(rec.sessionId, owed)
          return { ok: false, error: `Could not stop "${rec.name}" on ${rec.machine}: ${bare(r.error)}.` }
        }
        return { ok: true, state: 'stopped', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool }
      }
      case 'delete': {
        // Gone already (#1038 review): deleted there, or its machine removed, while the hub could not see it
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
        if (now.running) {
          // Nothing is owed of a child being deleted, and its stopped turn's end may come in first; put back if the stop fails
          const owed = this.host.children.linkedReports.get(rec.sessionId)
          if (owed?.orchestratorId === callerId) this.host.children.dropLinkedReport(rec.sessionId)
          const stopped = await reader.interrupt(rec.sessionId)
          if (!stopped.ok) {
            if (owed?.orchestratorId === callerId && !this.host.children.linkedReports.has(rec.sessionId)) this.host.children.setLinkedReport(rec.sessionId, owed)
            return { ok: false, error: `Could not stop "${rec.name}" on ${rec.machine} before deleting it: ${bare(stopped.error)}.` }
          }
        }
        /*
         * The worktree made for it there goes with it when nothing would be lost (#1161 item 3): the machine decides, as
         * only it can read that worktree, and says what it left and why. Only one made for it: the record names the
         * branch this hub asked for, and a child started without a worktree is deleted as before
         */
        // A reader without the call (one from before #1161) deletes as before, as a machine that predates it does
        const canClean = typeof reader.deleteAgentChild === 'function'
        const withWorktree = rec.worktree && canClean
          ? await reader.deleteAgentChild!(rec.sessionId, rec.worktree).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
          : undefined
        const older = !!rec.worktree && (!canClean || (!!withWorktree && !withWorktree.ok && 'olderBuild' in withWorktree))
        if (withWorktree && !withWorktree.ok && !older) return { ok: false, error: `Could not delete "${rec.name}" on ${rec.machine}: ${bare(withWorktree.error)}.` }
        if (!withWorktree?.ok) {
          const r = await reader.deleteSession(rec.sessionId)
          if (!r.ok) return { ok: false, error: `Could not delete "${rec.name}" on ${rec.machine}: ${bare(r.error)}.` }
        }
        this.forget(rec.sessionId)
        return {
          ok: true, state: 'deleted', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool,
          notice: `It went to ${rec.machine}'s session archive${remoteWorktreeLine(rec, withWorktree?.ok ? withWorktree : older ? 'older' : undefined)}.`,
        }
      }
    }
  }

  /**
   * A linked machine's event (`SessionManager.observeLinked`), read before the linked reports are: a call waiting on a
   * child's turn takes its end, so the report a waiting caller already read is not sent too.
   */
  observe(e: LinkedEvent): void {
    if (e.type === 'machine_status') return this.linkChanged(e.machine)
    if (e.type === 'machine_resync') return void this.caughtUp(e.machineId)
    if (typeof e.sessionId !== 'string') return
    const sessionId = e.sessionId
    const rec = this.of(sessionId)
    if (!rec) return
    if (e.type === 'user_message') this.messageTaken(rec, e)
    else this.trackBusy(rec, e)
    const wait = this.waits.get(sessionId)
    if ((e.type === 'approval_request' || e.type === 'question_request') && typeof e.requestId === 'string') {
      this.cardRaised(rec, e.type === 'approval_request' ? 'approval' : 'question', e.requestId, !!wait)
    }
    if (e.type === 'session_deleted') {
      this.forget(sessionId)
      wait?.end({ step: 'deleted' })
      return
    }
    if (!wait) return
    const step = linkedTurnEnd(wait.busy, e)
    if (step?.step === 'busy') {
      wait.busy = true
      // A card in the turn: the call waiting on it reads the card, as a local child's wait does (#676)
      // Left in place for the call, which arms the report before it takes the wait down (`rearm`): the turn is never
      // owed to nobody in between, so what tells it the caller's stays
      if (step.waits) wait.end({ step: 'asking' })
    } else if (step && step.step !== 'card_closed') {
      this.dropWait(sessionId)
      wait.end(step)
    }
  }

  // ── The gate ────────────────────────────────────────────────────────────────────────────

  /**
   * The gate (#1038 review, RV13): what of the child's current or last turn its caller may have. Every path that hands
   * the caller anything of the child asks it: status, wait (on opening, on a card, at the turn's end, before owing it
   * again), answer, send, a card's notice, and the linked report's text and preview (`reportGate`). Owned: the turn's
   * words and state are the caller's; live: its cards, an answer to them and a note into it are too. Read from this hub's
   * own evidence (`Whose`); a turn not yet told apart since a link's loss or a restart is read from the machine first
   * (`verify`), unless an instruction is on its way, whose own record decides.
   */
  private async gate(rec: RemoteAgent, reader: LinkedSessions): Promise<Gate> {
    if (this.whoseOf(rec) === 'unknown' && !this.pending.has(rec.sessionId)) await this.verify(rec, reader)
    return this.gateNow(rec)
  }

  /** The gate as this hub's evidence stands now, for the paths that cannot wait on the machine (events, the linked reports) */
  private gateNow(rec: RemoteAgent): Gate {
    const whose = this.whoseOf(rec)
    const owned = whose === 'caller'
    // A report held over the background work of a turn that ended is no turn running (#1038 review)
    const report = this.host.children.linkedReports.get(rec.sessionId)
    const mine = report?.orchestratorId === rec.callerId
    /*
     * Except a turn the child's own tool started when that work ended (a task notification, no message of anyone's): the
     * linked report reads it as the work's (`LinkedReport.turn`, the report is owed its end), so it is the caller's too
     * (#1576). Only on the hub's own sight of its start: after a swap, or from a machine that does not list background
     * work, nothing says so and the turn is not taken for the caller's
     */
    const continuesPause = mine && !!report.paused && report.busy && report.turn?.by === 'work'
    const running = this.waits.has(rec.sessionId) || (mine && (!report.paused || continuesPause))
    return { owned, live: owned && running, whose }
  }

  /** Whose the child's turn is (`Whose`): as settled here, else as its record kept it; `caller` is re-read after a restart */
  private whoseOf(rec: RemoteAgent): Whose {
    return this.whose.get(rec.sessionId) ?? (this.of(rec.sessionId)?.whose === 'other' ? 'other' : 'unknown')
  }

  /**
   * Settles whose the child's turn is (#1038 review), kept in its record. Becoming another's while the caller was owed
   * something of it ends that: a call waiting on it returns the fact (`taken`), and a report owed is dropped and the
   * caller told, unless its own send's answer says it (`pending`)
   */
  private setWhose(rec: RemoteAgent, whose: Whose, why?: string): void {
    const was = this.whoseOf(rec)
    // What made a turn another's is told with it (`messageTaken` sets it after), never kept past it
    if (was !== 'other' || whose !== 'other') this.otherBy.delete(rec.sessionId)
    this.whose.set(rec.sessionId, whose)
    if (whose !== 'caller') this.setGiven(rec.sessionId, [])
    const kept = whose === 'unknown' ? undefined : whose
    const stored = this.of(rec.sessionId)
    if (stored && kept && stored.whose !== kept) this.save(this.records().map((r) => (r.sessionId === rec.sessionId ? { ...r, whose: kept } : r)))
    if (whose !== 'other' || was === 'other') return
    const wait = this.waits.get(rec.sessionId)
    if (wait) {
      this.dropWait(rec.sessionId)
      wait.end({ step: 'taken' })
    }
    if (!this.reportArmed(rec)) return
    this.host.children.dropLinkedReport(rec.sessionId)
    if (wait || this.pending.has(rec.sessionId)) return
    const what = `${why ?? 'took a turn there that you did not give it (the person on that machine, most likely)'}. ` +
      'What you gave it is not followed from here, and nothing of that turn is yours to read: agent_session status gives only its state.'
    void this.host.tellSession(
      rec.callerId,
      `[Centralu] "${rec.name}" [${rec.sessionId}] on ${rec.machine} ${what}`,
      { sessionId: rec.sessionId, name: rec.name },
      true,
      // What the model reads (#1186): all of it but the names, which are not Centralu's words (#120)
      `[Centralu] The session [${rec.sessionId}] on its machine ${what}`,
    )
  }

  /**
   * Reads whose the child's turn is from the machine, when this hub could not watch it (a link's loss, a restart, #1038
   * review): the caller's only if the last message the child took is the instruction this hub sent it (`sent`, from this
   * link's `HUB_SENDER`). Not read (the machine did not answer), it stays unknown
   */
  private async verify(rec: RemoteAgent, reader: LinkedSessions): Promise<void> {
    const last = await reader.lastUserMessage(rec.sessionId)
    // Settled meanwhile, by an event or a send: that is newer than this read
    if (!last.ok || this.whoseOf(rec) !== 'unknown' || this.pending.has(rec.sessionId)) return
    const sent = this.of(rec.sessionId)?.sent
    if (last.message && sent !== undefined && last.message.text === sent && this.fromHubHere(rec, last.message.from)) this.setWhose(rec, 'caller')
    else this.setWhose(rec, 'other', 'ran a turn there that you did not give it while the hub could not see it (the person on that machine, most likely), or what you sent never went in')
    /*
     * The turns that opened while the hub could not see them (#1604): the child is in none now, so no turn will open for a
     * message before the last it took in, and the rows left for those (`turnOpens`) are done with. The last one's own row
     * stays: the tool opens the turn run for a queued note a moment after the one before it ended, with the child at rest
     * in between, and a stale row is harmless where a missing one refuses the caller
     */
    const upTo = last.message?.seq
    if (last.atRest && upTo !== undefined) this.setGiven(rec.sessionId, this.givenRows(rec.sessionId).filter((row) => row >= upTo))
  }

  /**
   * After a send or a start's task (#1038 review): taken as a turn of its own, the turn is the caller's and the call goes
   * on. Otherwise it is not followed: taken into a turn already running there (the gate is closed, `messageTaken`), or no
   * record of it came back with the machine's answer. What was owed for it is taken down and the caller gets the fact
   */
  private unclaimed(rec: RemoteAgent, waiting: TurnWait | undefined): ChildRunResult | null {
    const whose = this.whoseOf(rec)
    if (whose === 'caller') {
      // An end held back while the instruction was on its way is settled now that the turn is told apart
      if (this.deferred.has(rec.sessionId)) void this.settleDeferred(rec)
      return null
    }
    if (waiting && this.waits.get(rec.sessionId) === waiting) this.dropWait(rec.sessionId)
    if (this.reportArmed(rec)) this.host.children.dropLinkedReport(rec.sessionId)
    if (whose === 'unknown') this.setWhose(rec, 'other')
    return this.wentElsewhere(rec)
  }

  /**
   * What the running turn is, said for a caller it is not live for (#1576): named by what started it, so only a message
   * of a person's on that machine is "the person may be using it". A turn the hub has no sight of the start of (a swap,
   * a machine that lists no background work) is said to be the child's own, not a person's
   */
  private otherTurn(rec: RemoteAgent, g: Gate): string {
    if (g.whose === 'unknown') return 'a turn the hub cannot tell the owner of (the link dropped, or Centralu restarted, and the machine cannot be read now)'
    if (g.whose === 'other') {
      const by = this.otherBy.get(rec.sessionId)
      if (by === 'session') return "a turn another session asked of it (it is not the one you gave it)"
      if (by === 'person') return 'a turn you did not give it (the person may be using it there)'
      // No message of anyone's was seen to start it: the hub cannot say it is a person's (#1604)
      return 'a turn already running there when your message reached it, which this hub did not see begin (the person, or the child’s own tool)'
    }
    const report = this.host.children.linkedReports.get(rec.sessionId)
    if (report && report.orchestratorId !== rec.callerId) return 'a turn another session is owed the end of (it is not the one you gave it)'
    return 'a turn it started by itself that this hub cannot tie to the work you gave it'
  }

  /**
   * What the caller gets of a child whose turn the gate does not let through: the fact and the state word. Nothing of
   * the turn: no card, no words, and nothing owed or armed for it
   */
  private notYours(rec: RemoteAgent, g: Gate, running: boolean, state: SessionState): ChildRunResult {
    const why = g.whose === 'unknown'
      ? `The hub could not tell whose its last turn on ${rec.machine} was (the link dropped, or Centralu restarted, and the machine cannot be read now)`
      : running
        ? `It is in ${this.otherTurn(rec, g)} on ${rec.machine}`
        : `Its last turn on ${rec.machine} was not one you gave it (the person's)`
    const notice = `${why}: nothing of that turn is yours to read, and none of it is reported to you.${running ? ' Send to it once it is at rest.' : ''}`
    if (running) return { ...this.working(rec, false), notice }
    return { ok: true, state: 'at_rest', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, answer: '(not yours to read: a turn you did not give it)', sessionState: state, notice }
  }

  // ── Evidence ────────────────────────────────────────────────────────────────────────────

  /**
   * A message the child took there (#1038 review). The instruction this hub last sent it, from this link, makes the turn
   * that takes it the caller's (`tookInstruction`), unless another turn was already running there when it went in: then
   * it is only a message in that turn (a send that raced the person's own message, a note that arrived after the
   * caller's turn had ended and the person's had begun), and the turn is another's. Any other message (the person's,
   * the same words typed there included) makes it another's: once the person speaks into a turn, nothing more of it is
   * the caller's, and the caller is told (`setWhose`). A message seen already (a link's replay) is skipped
   */
  private messageTaken(rec: RemoteAgent, e: LinkedEvent): void {
    const sessionId = rec.sessionId
    if (typeof e.seq === 'number') {
      if (e.seq <= (this.lastSeq.get(sessionId) ?? -1)) return
      this.lastSeq.set(sessionId, e.seq)
    }
    const own = this.notesSent.get(sessionId) ?? []
    const earlier = typeof e.text === 'string' && e.text !== rec.sent ? own.indexOf(e.text) : -1
    if (earlier >= 0 && this.fromHubHere(rec, e.from)) {
      // An earlier note of the caller's own, its record arriving after a later note was kept as the last sent
      this.notesSent.set(sessionId, own.filter((_, i) => i !== earlier))
      if (this.whoseOf(rec) === 'caller' && this.gateNow(rec).live) return this.noteRow(sessionId, e.seq)
    }
    if (this.fromHubHere(rec, e.from) && e.text === rec.sent) {
      const at = own.indexOf(rec.sent ?? '')
      if (at >= 0) this.notesSent.set(sessionId, own.filter((_, i) => i !== at))
      // A note into the caller's own running turn stays in it, unless the tool runs it after that turn (`carried`)
      if (this.whoseOf(rec) === 'caller' && this.gateNow(rec).live) return this.noteRow(sessionId, e.seq)
      if (this.busy.has(sessionId)) return this.setWhose(rec, 'other', 'took what you sent as a message into a turn already running there that you did not give it (the person\'s, most likely)')
      this.tookInstruction(rec)
      // The tool can run it after a note sent before it: the turn it opens names this row (#1604)
      this.noteRow(sessionId, e.seq)
      return
    }
    this.setWhose(rec, 'other', 'took a message there that you did not send (the person on that machine, most likely)')
    this.otherBy.set(sessionId, this.fromHubHere(rec, e.from) ? 'session' : 'person')
  }

  /**
   * The machine recorded the instruction this hub last sent the child, with no other turn running there: the turn that
   * takes it is the caller's. If nothing was owed of it any more (a note sent as the caller's turn ended, which went in
   * after), the instruction starts a turn of its own, and its end is owed as a start's or a send's is
   */
  private tookInstruction(rec: RemoteAgent): void {
    this.setWhose(rec, 'caller')
    if (this.waits.has(rec.sessionId) || this.reportArmed(rec) || !this.host.meta.has(rec.callerId)) return
    this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: false })
  }

  /** Whether the child is in a turn there, as the machine's events last said (#1038 review): an instruction taken in one is a message in it */
  private trackBusy(rec: RemoteAgent, e: LinkedEvent): void {
    const sessionId = rec.sessionId
    const step = linkedTurnEnd(true, e)
    if (step?.step === 'busy') {
      this.busy.add(sessionId)
      this.turnOpens(rec, e)
    } else if (step?.step === 'completed' || step?.step === 'failed' || step?.step === 'deleted') this.busy.delete(sessionId)
  }

  /** A message of the caller's was stored on the machine as row `seq`: if the tool runs a turn for it after another's, that turn names it (`given`) */
  private noteRow(sessionId: string, seq: unknown): void {
    if (typeof seq === 'number' && !this.givenRows(sessionId).includes(seq)) this.setGiven(sessionId, [...this.givenRows(sessionId), seq].slice(-MAX_GIVEN_ROWS))
  }
  private givenRows(sessionId: string): readonly number[] {
    return this.of(sessionId)?.given ?? []
  }
  private setGiven(sessionId: string, rows: readonly number[]): void {
    const rec = this.of(sessionId)
    if (!rec || (rec.given ?? []).join() === rows.join()) return
    const { given: _given, ...rest } = rec
    this.save(this.records().map((r) => (r.sessionId === sessionId ? { ...rest, ...(rows.length ? { given: [...rows] } : {}) } : r)))
  }

  /**
   * A turn opens on the machine (#1604), and says which message it was run for when one was given a sender (`origin`, on
   * the event that opens it: not only the one that takes the session from rest, as the tool can open the turn of an earlier
   * message after a later one has set it working). When that is a row of the caller's (`given`, from this hub), the turn is
   * the caller's: its end is owed as the first turn's was, and a note goes into it. A turn with no origin, or one for a row
   * not held here (the person's, another session's, a machine that does not say), is not taken for the caller's. The rows up
   * to the one named are done with either way: the tool runs messages in the order they were given. While whose the child's turn
   * is cannot be told (a link's loss, a restart), the rows are kept, and no turn is taken for the caller's
   */
  private turnOpens(rec: RemoteAgent, e: LinkedEvent): void {
    const origin = e.type === 'state_change' ? asObj(e.origin) : {}
    const named = origin.seq
    const held = this.givenRows(rec.sessionId)
    if (typeof named !== 'number' || !held.includes(named) || !this.fromHubHere(rec, origin.from)) return
    // Not told apart yet (the link dropped, or Centralu restarted): the rows stay for the re-read that tells (`verify`)
    if (this.whoseOf(rec) === 'unknown') return
    this.setGiven(rec.sessionId, held.filter((row) => row > named))
    if (this.whoseOf(rec) !== 'caller' || this.gateNow(rec).live || !this.host.meta.has(rec.callerId)) return
    this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: true })
  }

  // ── Waits ───────────────────────────────────────────────────────────────────────────────

  /** Waits on the child's turn up to the bound; while it waits, the answer is the call's and no report is sent */
  private async awaitTurn(rec: RemoteAgent, signal: AbortSignal | undefined, boundMs: number, opened?: TurnWait): Promise<ChildRunResult> {
    const reader = this.host.linkedReader
    const wait = opened ?? this.waits.get(rec.sessionId) ?? this.openWait(rec.sessionId)
    // As a local child's wait takes its report down (#561): the call reads the answer, and it is put back if the call does not
    if (this.reportArmed(rec)) this.host.children.dropLinkedReport(rec.sessionId)
    const r = await raceBound(wait.done, boundMs, signal)
    /*
     * Owed again only while the turn may still be the caller's (the gate open, or not told apart since the link went):
     * the report first, then the wait down, so the turn is never owed to nobody in between
     */
    const rearm = (): boolean => {
      const again = this.whoseOf(rec) !== 'other'
      if (again) this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: wait.busy })
      if (this.waits.get(rec.sessionId) === wait) this.dropWait(rec.sessionId)
      return again
    }
    const settledNot = (): ChildRunResult => this.notYours(rec, this.gateNow(rec), true, 'working' as SessionState)
    if (r === 'bound') return rearm() ? this.working(rec, true) : settledNot()
    if (r === 'aborted') {
      rearm()
      return { ok: false, error: `The call was cancelled; "${rec.name}" was left running on ${rec.machine}.` }
    }
    if (r.step === 'taken') return settledNot()
    if (r.step === 'unreachable') {
      if (!rearm()) return settledNot()
      return { ...this.working(rec, true), notice: `The link to ${r.machine} dropped while it worked, so it cannot be followed now. Its report comes once the link is back and its turn has ended, if that turn is still yours.` }
    }
    if (r.step === 'asking') {
      // Its turn goes on: its end is owed again, and the cards are the answer now, if the turn is still the caller's
      if (!rearm()) return settledNot()
      const cards = reader && this.gateNow(rec).live ? await this.cardsOf(rec, reader) : []
      return cards.length ? this.asking(rec, cards) : this.working(rec, true)
    }
    if (r.step === 'deleted') return { ok: false, error: `"${rec.name}" [${rec.sessionId}] was deleted on ${rec.machine} before it finished.` }
    // The turn ended: what it said is the caller's only through the gate
    if (!this.gateNow(rec).owned) return this.notYours(rec, this.gateNow(rec), false, 'idle' as SessionState)
    if (r.step === 'failed') return { ok: false, error: `"${rec.name}" [${rec.sessionId}] on ${rec.machine} did not finish: ${r.error}. Tell the person, or give it a clearer task.` }
    const words = await this.lastWords(rec, reader)
    // The turn left the child's own background work running there (#721): the report waits for that work's end
    const running: BackgroundTask[] = this.host.linkedTasksRunning(rec.sessionId)
    if (running.length) this.host.children.setLinkedReport(rec.sessionId, { orchestratorId: rec.callerId, busy: false, paused: running })
    return {
      ok: true, state: 'done', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, answer: words.answer, readable: [], outside: [],
      notice: `It works on ${rec.machine}: the paths it names are that machine's, not readable from here.${running.length ? ' Its own background work still runs there; a final report follows when that work ends.' : ''}${words.notice}`,
    }
  }

  /** A wait on the child's turn, which the machine's events end (`observe`); `busy` as far as the hub has seen */
  private openWait(sessionId: string): TurnWait {
    let end!: (step: Step) => void
    const done = new Promise<Step>((resolve) => (end = resolve))
    const wait = { busy: this.host.children.linkedReports.get(sessionId)?.busy ?? false, done, end }
    this.waits.set(sessionId, wait)
    this.keepOwed(sessionId)
    return wait
  }

  private dropWait(sessionId: string): void {
    this.waits.delete(sessionId)
    this.keepOwed(sessionId)
  }

  /** What is owed of the child now, kept in its record when it changed (#1038): a wait open, or its report armed */
  private keepOwed(sessionId: string): void {
    const rec = this.of(sessionId)
    if (!rec) return
    const report = this.host.children.linkedReports.get(sessionId)
    const armed = report?.orchestratorId === rec.callerId ? report : undefined
    const owed = this.waits.has(sessionId) || armed ? { ...(armed?.paused ? { paused: armed.paused } : {}) } : undefined
    if (JSON.stringify(owed) === JSON.stringify(rec.owed)) return
    this.save(this.records().map((r) => (r.sessionId !== sessionId ? r : owed ? { ...r, owed } : withoutOwed(r))))
  }

  // ── What the caller gets ────────────────────────────────────────────────────────────────

  /** A send the machine took into a turn that is not the caller's, or no record of it came back: delivered, and followed no further */
  private wentElsewhere(rec: RemoteAgent): ChildRunResult {
    return {
      ...this.working(rec, false),
      notice: `It did not go in as a turn of its own on ${rec.machine}: a turn you did not give it was running there (the person's, most likely), and it went into that turn as a message, or no record of it came back. Nothing of that turn is reported to you; send again once it is at rest.`,
    }
  }

  /**
   * Whether the child is no longer anywhere (#1038 review): its machine removed from Centralu, or the machine's sessions
   * (read now, or as last known when it cannot be asked) do not have it
   */
  private gone(rec: RemoteAgent, reader: LinkedSessions, listed: readonly OrchestratedSession[]): boolean {
    if (!reader.machineLinked(rec.machineId)) return true
    return !listed.some((s) => s.sessionId === rec.sessionId)
  }

  private working(rec: RemoteAgent, reported: boolean): Extract<ChildRunResult, { state: 'working' }> {
    return { ok: true, state: 'working', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, reported }
  }

  /** The child at rest, its last words: only ever called past the gate */
  private async atRest(rec: RemoteAgent, state: SessionState, reader: LinkedSessions): Promise<ChildRunResult> {
    const words = await this.lastWords(rec, reader)
    return { ok: true, state: 'at_rest', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, answer: words.answer, sessionState: state, ...(words.notice ? { notice: words.notice.trim() } : {}) }
  }

  /**
   * The child's last words, read there and cut as an answer is cut here, the cut naming the read that shows the rest
   * (#1186). A read that failed is said in the notice, where it used to come back as an empty answer
   */
  private async lastWords(rec: RemoteAgent, reader: LinkedSessions | null): Promise<{ answer: string; notice: string }> {
    const words = reader ? await reader.lastWords(rec.sessionId, ANSWER_READ_MAX_CHARS, { turn: true }).catch((e: Error) => ({ ok: false as const, error: e.message })) : { ok: false as const, error: 'no machine is linked here' }
    if (!words.ok) return { answer: '', notice: ` Its answer could not be read there (${words.error}): read_session(sessionId="${rec.sessionId}") reads it once the machine answers.` }
    if (words.text === '') return { answer: NO_WORDS, notice: '' }
    return { answer: clipAnswer(words.text, rec.name, words.seq !== null ? { sessionId: rec.sessionId, seq: words.seq } : undefined), notice: '' }
  }

  /**
   * The cards standing in the child's turn, as its caller reads them (#676): its questions, and its approval, which is
   * never the caller's to answer here (`answer`). Each named by a handle of the turn the caller gave it, the request and
   * what the card asks, so an answer meant for an earlier card finds nothing on a new one. Only ever read past the gate
   */
  private async cardsOf(rec: RemoteAgent, reader: LinkedSessions): Promise<RoutedCard[]> {
    const r = await reader.cards(rec.sessionId)
    if (!r.ok) return []
    const turn = this.of(rec.sessionId)?.turn ?? rec.sessionId
    const cards: RoutedCard[] = r.questions.map((q) => ({ card: cardHandle(turn, q.requestId, q.questions), requestId: q.requestId, kind: 'question' as const, questions: q.questions }))
    if (r.approval) cards.push({ card: cardHandle(turn, r.approval.requestId, r.approval.detail), requestId: r.approval.requestId, kind: 'approval', detail: r.approval.detail, answerable: false })
    return cards
  }

  private asking(rec: RemoteAgent, cards: RoutedCard[]): ChildRunResult {
    return { ok: true, state: 'asking', sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool, cards }
  }

  /**
   * agent_session answer on a child of a linked machine (#1038), as on a local child's delegated turn (#676): the gate
   * must find the caller's turn running there, and the card must still stand as it read it. A question takes its answer,
   * through the machine as its window would answer it. An approval stays the person's on that computer, whatever the
   * child runs under there: a caller's `auto` (which alone lets a caller answer a local child's approval) may give the
   * child `auto` there (#1273), but never answers that computer's cards, so what runs there is allowed there, by the person
   */
  private async answer(rec: RemoteAgent, card: string | undefined, text: string, reader: LinkedSessions): Promise<ChildRunResult> {
    if (!(await this.gate(rec, reader)).live) return { ok: false, error: `"${rec.name}" on ${rec.machine} is not running a turn you gave it, so none of its cards are yours to answer.` }
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
    const answers = answersFrom(chosen.questions, text)
    if ('error' in answers) return { ok: false, error: answers.error }
    // Read again: the turn may have become another's while the cards were read
    if (!this.gateNow(rec).live) return { ok: false, error: `"${rec.name}" on ${rec.machine} is not running a turn you gave it, so none of its cards are yours to answer.` }
    const r = await reader.answerQuestion(rec.sessionId, chosen.requestId, answers)
    if (!r.ok) return { ok: false, error: `The question was not answered: ${bare(r.error)}.` }
    return { ok: true, state: 'answered', card: chosen.card, sessionId: rec.sessionId, sessionName: rec.name, tool: rec.tool }
  }

  /**
   * A card came up in the child (#676): in the turn its caller gave it, the caller hears of it once, by the wait on that
   * turn when one stands (it returns the card), otherwise by a notice into its conversation, as a report is delivered.
   * Past the gate only
   */
  private cardRaised(rec: RemoteAgent, kind: 'question' | 'approval', requestId: string, waited: boolean): void {
    if (!this.gateNow(rec).live || !this.host.meta.has(rec.callerId)) return
    const key = `${rec.sessionId}\0${rec.turn ?? ''}\0${requestId}`
    if (this.toldCards.has(key)) return
    this.toldCards.add(key)
    if (waited) return
    void this.host.tellSession(rec.callerId, cardNotice(kind, rec.sessionId, cardCall('reader', rec.sessionId), false), { sessionId: rec.sessionId, name: rec.name }, true)
  }

  /** Whether the child's turn end is owed to the session that started it */
  private reportArmed(rec: RemoteAgent): boolean {
    return this.host.children.linkedReports.get(rec.sessionId)?.orchestratorId === rec.callerId
  }

  // ── The link ────────────────────────────────────────────────────────────────────────────

  /**
   * A machine's link that is no longer connected: what happens there now is unseen, so whose each child's turn is is not
   * known until the machine is read again (`verify`), and whether it is in a turn neither. A call waiting on a child
   * there returns now, and the session that started a child still owed a report is told once that it cannot be followed
   * until the link is back. A report paused over the child's background work is the linked reports' to send
   * (`LinkedReports.linkChanged`).
   */
  private linkChanged(machine: unknown): void {
    const m = machine as { id?: unknown; name?: unknown; status?: unknown; autoReconnect?: unknown; operation?: { kind?: unknown } | null } | null
    if (!m || typeof m.id !== 'string' || m.status === 'connected') return
    /*
     * Nothing here reconnects it (#1341): the person disconnected it, or its Auto reconnect is off and the attempt that
     * failed or the redials that gave up were the last. Judged by the link and not by the row, which says `unreachable` the
     * moment a drop starts. With the switch off the caller is told once, when this is so, and not at the first sign of
     * a drop that the quick redial, an attempt or an install or update may undo
     */
    const alone = this.host.linkedReader?.machineWaitsForPerson(m.id) === true
    const mayRecover = m.autoReconnect === false && !alone && m.status !== 'versions_differ' && m.status !== 'updating'
    const name = typeof m.name === 'string' && m.name ? m.name : m.id
    for (const rec of this.records()) {
      if (rec.machineId !== m.id) continue
      if (this.whoseOf(rec) === 'caller') this.whose.set(rec.sessionId, 'unknown')
      this.busy.delete(rec.sessionId)
      const wait = this.waits.get(rec.sessionId)
      if (wait) {
        this.dropWait(rec.sessionId)
        wait.end({ step: 'unreachable', machine: name })
        // The call said it; what ended while the link was down is reported once it is back, seen working or not (#1038 review)
        this.toldDown.set(rec.sessionId, false)
        continue
      }
      const report = this.host.children.linkedReports.get(rec.sessionId)
      const told = this.toldDown.get(rec.sessionId)
      if (!report || report.orchestratorId !== rec.callerId || report.paused || (told !== undefined && (told || !alone))) continue
      if (mayRecover) continue
      /*
       * This hub's own update or rollback of the machine holds the link (#1618): its stop ends this turn, and the host it starts
       * continues it, when the machine's host is one that does (its hello's `updateContinued`). The caller hears that once the
       * link is back (`caughtUp`), not that the link dropped. An update that ends with the machine not back clears the row's
       * operation, and the drop is told then as any is. A host from before that is told as before
       */
      if (updating(m.operation) && this.host.linkedReader?.continuesCutTurns?.(m.id) === true) continue
      this.toldDown.set(rec.sessionId, alone)
      const why = !alone
        ? 'It cannot be followed until the link is back: '
        : m.status === 'disconnected'
          ? 'The person disconnected the machine, so nothing here reconnects it: ask the person to connect it. It cannot be followed until then: '
          : "The machine's Auto reconnect is off, so nothing here reconnects it: ask the person to connect it. It cannot be followed until then: "
      const rest = why +
        'its report comes then, once its turn has ended, if that turn is still yours. agent_session status reads its state once the machine can be reached.'
      void this.host.tellSession(
        rec.callerId,
        `[Centralu] The link to ${name} dropped while "${rec.name}" [${rec.sessionId}] was working there. ${rest}`,
        { sessionId: rec.sessionId, name: rec.name },
        true,
        // What the model reads (#1186): all of it but the names, which are not Centralu's words (#120)
        `[Centralu] The link to its machine dropped while the session [${rec.sessionId}] was working there. ${rest}`,
      )
    }
  }

  /**
   * A machine's link is up again (or the hub started): a child gone from it is forgotten (#1038 review); whose each
   * child's turn is is read again where it was not watched (`verify`), which ends what was owed of a turn that is not
   * the caller's any more (`setWhose`). A child still the caller's whose turn's end the hub may have missed, or held
   * back while it could not tell, is reported now if it is at rest; one still running reports when it ends.
   */
  private async caughtUp(machineId: unknown): Promise<void> {
    const reader = this.host.linkedReader
    if (!reader || typeof machineId !== 'string') return
    // Deleted there while the link was down, or the machine removed: nothing of it will come, so nothing is owed of it
    // and it holds no place under the ceiling (#1038 review). Read as `list` reads it; not at all if it cannot be read
    const mine = this.records().filter((r) => r.machineId === machineId)
    if (!mine.length) return
    const listed = await reader.list().catch(() => null)
    for (const rec of mine) {
      if (listed && this.gone(rec, reader, listed)) {
        this.forget(rec.sessionId)
        continue
      }
      const missed = this.toldDown.delete(rec.sessionId)
      const held = this.deferred.delete(rec.sessionId)
      if (this.whoseOf(rec) === 'unknown' && !this.pending.has(rec.sessionId)) await this.verify(rec, reader)
      const report = this.host.children.linkedReports.get(rec.sessionId)
      if (!report || report.orchestratorId !== rec.callerId || report.paused || !this.gateNow(rec).owned) continue
      if (!report.busy && !missed && !held) continue
      const now = await reader.read(rec.sessionId, 1)
      // Read again: the turn's own end, or another's message, may have come in while the machine was asked
      if (!now.ok || this.host.children.linkedReports.get(rec.sessionId) !== report || !this.gateNow(rec).owned) continue
      if (inTurn((now.state ?? 'idle') as SessionState)) {
        report.busy = true
        this.tellContinued(rec)
      } else this.host.settleLinkedTurn(rec.sessionId)
    }
  }

  /**
   * A child whose turn an update of its machine cut, found in a turn again once the link is back: the host that update
   * started continued it (#1618). Its caller is told so once, and that the report it is owed is that turn's end, so it
   * neither waits on a link that came back nor continues the child by hand a second time
   */
  private tellContinued(rec: RemoteAgent): void {
    const at = this.host.linkedReader?.continuedAfterUpdate?.(rec.sessionId)
    if (at == null || this.toldCut.has(`${rec.sessionId}@${at}`)) return
    this.toldCut.add(`${rec.sessionId}@${at}`)
    const rest = 'and Centralu continued it there on the new version. Its report comes when that turn ends; nothing is needed from you now.'
    void this.host.tellSession(
      rec.callerId,
      `[Centralu] An update of Centralu on its machine cut the turn "${rec.name}" [${rec.sessionId}] was running there, ${rest}`,
      { sessionId: rec.sessionId, name: rec.name },
      true,
      // What the model reads (#1186): all of it but the name, which is not Centralu's words (#120)
      `[Centralu] An update of Centralu on its machine cut the turn the session [${rec.sessionId}] was running there, ${rest}`,
    )
  }

  /**
   * Whether a message the child took was sent by this hub over this link (#1038 review): the machine records a hub's
   * instruction from `HUB_SENDER`, which reaches the hub qualified with that machine's id. Another machine's prefix is no
   * instruction of this link's. Two hubs linked to one machine record the same sender; the text (`sent`) tells them apart
   */
  private fromHubHere(rec: RemoteAgent, from: unknown): boolean {
    return (from as { sessionId?: unknown } | null)?.sessionId === `${rec.machineId}.${HUB_SENDER}`
  }

  /** The instruction the hub is about to send the child, kept so its turn can be told from another's (`messageTaken`, `verify`) */
  private sentNow(sessionId: string, text: string): void {
    this.save(this.records().map((r) => (r.sessionId === sessionId ? { ...r, sent: text } : r)))
  }

  /**
   * Tells the windows whose child a machine's session is now (#1038): the links name the parent in its rows from here
   * on (`LinkDeps.ownerOf`), and this moves a row the windows hold already. The machine knows no parent for it, and
   * none for its folder: a session start_agent made there is never a worktree manager's
   */
  private owned(sessionId: string, askedBy: string | null): void {
    this.host.emit({ type: 'session_owner', sessionId, askedBy, parentSessionId: null })
  }

  private records(): RemoteAgent[] {
    if (!this.loaded) {
      // Whatever arms, moves or drops a child's report, here or in the linked reports, is kept in its record. Hooked on
      // the first read (`restore` at startup does one), as nothing is armed for a child before its record is read
      this.host.children.onLinkedReportChange((sessionId) => this.keepOwed(sessionId))
    }
    this.loaded ??= readJsonObjects<RemoteAgent>(
      this.host.store.settings.appSetting(REMOTE_AGENTS_KEY),
      (x) => typeof x.sessionId === 'string' && typeof x.callerId === 'string' && typeof x.machineId === 'string',
    )
    return this.loaded
  }

  private save(list: RemoteAgent[]): void {
    this.loaded = list
    this.host.store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify(list))
  }

  /** The child is gone from the machine: its record and anything owed of it go */
  private forget(sessionId: string): void {
    if (this.records().some((r) => r.sessionId === sessionId)) this.save(this.records().filter((r) => r.sessionId !== sessionId))
    this.toldDown.delete(sessionId)
    this.whose.delete(sessionId)
    this.otherBy.delete(sessionId)
    this.notesSent.delete(sessionId)
    this.pending.delete(sessionId)
    this.deferred.delete(sessionId)
    this.busy.delete(sessionId)
    this.lastSeq.delete(sessionId)
    for (const key of [...this.toldCards]) if (key.startsWith(`${sessionId}\0`)) this.toldCards.delete(key)
    if (this.host.children.linkedReports.has(sessionId)) this.host.children.dropLinkedReport(sessionId)
  }

  /** What start_agent and a send rest on in the caller, read again after a card: here, in a trusted project, above the depth */
  private gateError(callerId: string): string | null {
    const caller = this.host.meta.get(callerId)
    if (!caller) return 'The session that asked is no longer here.'
    const project = this.host.store.projects.listProjects().find((p) => p.id === caller.projectId)
    if (!project) return 'This session\'s project is no longer registered.'
    if (project.trusted !== true && !this.host.autoBoundaryOpen(callerId, 'start in an untrusted project')) {
      return `This session's project is not trusted, so it cannot start agents — the person can trust it from the project menu. ${ASK_THE_PERSON}`
    }
    return agentDepthRefusal(this.host, callerId, 'start agents')
  }

  /** The caller's preset as it is now; `safe` for one gone, so nothing is decided on a preset no one has */
  private callerPreset(callerId: string): PermissionPreset {
    return this.host.meta.get(callerId)?.permissionPreset ?? 'safe'
  }

  /** Why a start stops when the caller's preset fell below the child's while it went on (#1273 review), or null */
  private loweredError(callerId: string, preset: PermissionPreset, what: string): string | null {
    const now = this.callerPreset(callerId)
    return presetWithin(preset, now) ? null : `This session now runs under ${now}, below the ${preset} the child would have run under, ${what}. Start it again if it is still wanted. ${ASK_THE_PERSON}`
  }

  /** What the machine says of an `auto` caller's child (#1273): whether it takes `auto` from this computer, or why not */
  private async autoThere(machine: { id: string; name: string }, reader: LinkedSessions): Promise<AutoThere | { error: string }> {
    const r = await reader.hubAuto(machine.id)
    if (r.ok) return r.allowed ? { auto: true } : { auto: false, withheld: 'machine_off' }
    if ('olderBuild' in r) return { auto: false, withheld: 'older' }
    return { error: `Could not ask ${machine.name} whether it takes auto from this computer: ${bare(r.error)}. Nothing was started there.` }
  }

  /** The machine's project that is a checkout of this project's repository: the same `origin`, read on both sides */
  private async checkoutOn(
    machine: { id: string; name: string },
    project: { id: string; name: string },
    reader: LinkedSessions,
  ): Promise<{ project: LinkedProject } | { error: string }> {
    const origin = await this.host.projectOrigin(project.id)
    const key = origin ? gitRemoteKey(origin) : null
    if (!origin || !key) {
      return { error: `This project has ${origin ? 'a local folder as its origin remote' : 'no origin remote'}, so no checkout of it on ${machine.name} can be told apart. Start the agent here, without machine.` }
    }
    // Only this machine is waited for if it is down (#1532): a lookup does not wait on the others
    const all = await reader.projects({ machineId: machine.id })
    const away = all.away.find((a) => a.machineId === machine.id)
    if (away) {
      // Nothing here connects it (#1341): the sentence names the person, who can; no retry on its own is promised
      if (away.why === NOT_CONNECTED) return { error: `${machine.name} ${awayPhrase(NOT_CONNECTED)}, so nothing was started there. Try again once it is connected.` }
      // Said once: `why` already starts with "not reachable right now" when a call tried to connect it (#1532)
      const cannot = away.why.startsWith(`${NOT_REACHABLE};`) ? `is ${away.why}` : `cannot be reached (${away.why})`
      return { error: `${machine.name} ${cannot}, so nothing was started there. Try again once its link is back.` }
    }
    const theirs = all.projects.filter((p) => p.machineId === machine.id)
    const read = await Promise.all(theirs.map(async (p) => ({ p, r: await reader.origin(p) })))
    // A build from before #1038 would not keep the child within the agent depth: a loop of starts between machines
    if (read.some(({ r }) => !r.ok && 'olderBuild' in r)) {
      return { error: `${machine.name} runs an older Centralu, which would not keep a session started from here within the agent depth, so nothing was started there. Update Centralu on ${machine.name}, then try again.` }
    }
    // Asked and not reached: the link went away after the list was read. That is the machine away, not a machine without the checkout
    const unreached = read.map(({ r }) => (!r.ok && (r.error.includes(NOT_REACHABLE) || r.error.includes(NOT_CONNECTED_PHRASE)) ? r.error : null))
    if (read.length > 0 && unreached.every((e) => e !== null)) {
      return { error: `${machine.name} cannot be reached (${NOT_REACHABLE}), so nothing was started there. Try again once its link is back.` }
    }
    const same = read.filter(({ r }) => r.ok && r.origin && gitRemoteKey(r.origin) === key).map(({ p }) => p)
    const chosen = same.length === 1 ? same[0] : same.filter((p) => p.name === project.name).length === 1 ? same.find((p) => p.name === project.name) : undefined
    if (chosen) return { project: chosen }
    if (same.length) return { error: `${machine.name} has more than one checkout of ${key}: ${same.map((p) => `"${p.name}"`).join(', ')}, none named as this project is. Choosing among them is not available yet: the person can remove the extra one there.` }
    const listed = read.map(({ p, r }) => `"${p.name}" (${r.ok ? shownRemote(r.origin) : 'not read'})`).join(', ')
    return { error: `${machine.name} has no checkout of ${key}, so nothing was started there.${listed ? ` Its projects: ${listed}.` : ' It has no projects.'} The person can clone it there first.` }
  }
}

/** The row's operation is this hub's update or rollback of the machine, whose stop and start hold the link (#1618) */
function updating(op: { kind?: unknown } | null | undefined): boolean {
  return op?.kind === 'update' || op?.kind === 'rollback'
}
