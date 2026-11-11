import { stamped } from '../log-file.js'
import { blockedOnQuestion, defaultPresetFor, type Attachment, type MachineInfo, type NormalizedEvent, type PermissionPreset, type SessionInfo, type SettingsApplied, type ToolName, type UpdateStatus, type UsageHistory, type UsageHistoryBy, isAssistantKind } from '@cc/protocol'
import { awayPhrase } from '../adapters/contract.js'
import { awayRefusal, tryAgainAfter } from '../links/machine-reach.js'
import { awayFor, matchProjects } from './ask-project.js'
import type { AgentListRow, AgentSessionOpts, ChildRunResult, HandoffResult, LinkedProject, LinkedSessions, OrchestratedSession, CentraluTools, RecallHit, RoutedCard, StartAgentOpts } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import type { Asker } from '../mail/asked-by.js'
import { lowestPreset, presetWithin } from './start-agent.js'
import type { ChildOwnership, LinkedReport } from './child-ownership.js'
import type { AssistantProposals } from './assistant-proposals.js'
import type { DelegationForks } from './delegation-forks.js'
import type { DelegationHost } from './delegation-host.js'
import type { AppSessions } from './app-sessions.js'
import type { ProjectCreation } from './project-creation.js'
import type { MachineAnswer, MachineRequest } from './machine-flow.js'
import type { PreferencesAnswer, PreferencesRequest } from './preferences-flow.js'
import type { TrashAnswer, TrashRequest } from './trash-flow.js'
import type { TrustAnswer, TrustRequest } from './trust-flow.js'
import type { AppUpkeepAnswer, AppUpkeepRequest } from './app-upkeep-flow.js'
import type { HousekeepingAnswer, HousekeepingRequest } from './housekeeping-flow.js'
import { staleSessionHint } from './stale-session-id.js'
import { dedupeNearbyHits, takeInTurns, windowAround, windowAroundLines } from './snippet.js'
import { LINE_WINDOW_CHARS, asPredecessor, budgetOf, fitLines, lineText, sessionLines, toolLinesOf, type SessionLine } from './session-lines.js'
import { contextAt, labelOf, lastActiveOf, previewOf, timeOf } from './transcript-view.js'

/**
 * The preset of a session create_session makes (owner decision 2026-11-05): the one named, or the default a new session
 * gets in that project (`defaultPresetFor`: `auto` in a trusted project, `normal` in an untrusted one). Never more than
 * the seat's own permissions (#838), and never above `normal` in an untrusted project, named or not. In a turn a
 * session's request started (`asker`), the default is also held to that session's preset, so the work handed on is no
 * looser than the asking session and takes no card (#1739). A default above a cap is held to it; a preset named above
 * one is refused (null). It used to be `normal` at most whatever was asked.
 */
export function createdPreset(seat: PermissionPreset, project: { trusted: boolean }, named?: PermissionPreset, asker?: PermissionPreset): PermissionPreset | null {
  const cap = project.trusted ? seat : lowestPreset('normal', seat)
  if (named !== undefined) return presetWithin(named, cap) ? named : null
  return lowestPreset(defaultPresetFor(project), cap, ...(asker ? [asker] : []))
}

/**
 * What the Centralu tools reach of the session manager (#428): its sessions and store, who owns whose work, and
 * the manager's own operations they call. The manager hands itself over through this (`SessionManager.seat`), so the
 * tools stay one function over a narrow surface rather than a method that sees the whole class.
 */
export type AssistantSeatHost = Pick<DelegationForks, 'forkFor'> &
  Pick<ProjectCreation, 'createProjectAsked' | 'askAppProject' | 'createProjectOnMachine' | 'addFolderAsked' | 'addFolderOnMachine'> &
  Pick<AppSessions, 'builderRefOf' | 'checkApp' | 'createApp'> & Pick<DelegationHost, 'refusesDelegation' | 'projectTrusted' | 'takesSendNow' | 'mailTask'> & {
  /** Read when a tool runs, as every field here: what the manager holds is read now, never a copy kept from before */
  readonly store: Store
  readonly meta: ReadonlyMap<string, SessionInfo>
  readonly children: ChildOwnership
  readonly proposals: Pick<AssistantProposals, 'proposeMcpServer' | 'proposeSkill'>
  /** The links to other machines, once wired (`useLinkedReader`), else null */
  linkedReader(): LinkedSessions | null
  /** A linked machine's report put back after a failed send: a paused one's settle wait starts again (#723) */
  linkedReportRestored(sessionId: string): void
  emit(e: NormalizedEvent): void
  updateCentraluAsked(
    sessionId: string,
    action: 'check' | 'install' | 'apply',
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string; status?: UpdateStatus; relaunched?: { version?: string } }>
  updateSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null; permissionPreset?: PermissionPreset },
    by: 'person' | 'orchestrator',
  ): Promise<SessionInfo & { applied: SettingsApplied }>
  createSession(params: { projectId: string; cwd: string; tool: ToolName | null; permissionPreset: PermissionPreset }): Promise<SessionInfo>
  firstTool(preferred?: ToolName | null): ToolName | null
  /** The session whose request the Assistant's turn is answering, if one (#1739, `AskedGateHost.askedBy`); absent where it is not wired */
  askedBy?(assistantId: string): Asker | null
  rename(sessionId: string, name: string): void
  send(sessionId: string, text: string, attachments?: Attachment[], from?: { sessionId: string; name: string }): Promise<void>
  routedCards(sessionId: string, callerId: string): RoutedCard[]
  answerRoutedCard(callerId: string, sessionId: string, card: string | undefined, text: string): Promise<ChildRunResult>
  autoBoundaryOpen(sessionId: string, boundary?: string): boolean
  /** The linked machines as `machines.list` answers them (#1220), once wired (`useMachineList`); empty without links */
  machineList(): MachineInfo[]
  /** The machine commands (#1219): `MachineFlow.run`, with the Assistant as the session its cards stand in */
  machineRequest(sessionId: string, req: MachineRequest, signal?: AbortSignal): Promise<MachineAnswer>
  /** The preference commands (#1219): `PreferencesFlow.run`, with the Assistant as the session its card stands in */
  preferencesRequest(sessionId: string, req: PreferencesRequest, signal?: AbortSignal): Promise<PreferencesAnswer>
  /** The session archive commands (#1219): `TrashFlow.run`, with the Assistant as the session its cards stand in */
  trashRequest(sessionId: string, req: TrashRequest, signal?: AbortSignal): Promise<TrashAnswer>
  /** The trust commands (#1219): `TrustFlow.run`, with the Assistant as the session its cards stand in */
  trustRequest(sessionId: string, req: TrustRequest, signal?: AbortSignal): Promise<TrustAnswer>
  /** The app upkeep commands (#1219): `AppUpkeepFlow.run`, with the Assistant as the session its card stands in */
  appUpkeepRequest(sessionId: string, req: AppUpkeepRequest, signal?: AbortSignal): Promise<AppUpkeepAnswer>
  /** The housekeeping and read commands (#1219): `HousekeepingFlow.run`, with the Assistant as the caller */
  housekeepingRequest(sessionId: string, req: HousekeepingRequest): Promise<HousekeepingAnswer>
  /** start_agent and agent_session for the Assistant (#853): the start flow, with the Assistant as the caller */
  startAgent(callerId: string, opts: StartAgentOpts, signal?: AbortSignal): Promise<ChildRunResult>
  agentSession(callerId: string, opts: AgentSessionOpts, signal?: AbortSignal): Promise<ChildRunResult>
  listAgents(callerId: string): Promise<AgentListRow[]>
  /** handoff_session (#694): `HandoffFlow.handoff`, after this seat's own scope checks */
  handoff(
    callerId: string,
    target: SessionInfo,
    opts: { tool?: ToolName; mode?: 'record' | 'agent'; instructions?: string },
    signal?: AbortSignal,
  ): Promise<HandoffResult>
  /** usage_history (§6.2): `SessionManager.usageHistory` */
  usageHistory(p: { from: string; to: string; groupBy: 'day' | 'hour'; by: UsageHistoryBy }): UsageHistory
  /** handoff_session's waitFor (#694): `HandoffFlow.wait` */
  handoffWait(callerId: string, handle: string, signal?: AbortSignal): Promise<HandoffResult>
}

/**
 * Report requests of overlapping linked sends (#839): what each one replaced, and those whose send failed while another
 * send's request stood over them. A failed send puts back what was there before it, past any such failed request.
 */
/** The rows one read from an offset loads (#1186): a response's messages, merged into the one line it reads */
const OFFSET_READ_ROWS = 200

const replacedBy = new WeakMap<LinkedReport, LinkedReport | undefined>()
const failedSends = new WeakSet<LinkedReport>()

/**
 * The tools given to an Assistant (FR-11).
 *
 * **There is no way to reach outside the sessions this app manages.** Since it only ever looks at
 * the manager's own metadata, it never touches someone else's session made from a terminal, or
 * files, or a project directory — not because a blocking rule was written for it, but because that
 * is the entire extent of what it can see.
 */
export function centraluToolsFor(
  host: AssistantSeatHost,
  assistantId: string,
  scopeIds?: string[],
  ownProject?: boolean,
  /** A hub's view of this host (`hostReader`, #82 phase 4): what its window shows, with no calling session */
  hubView?: boolean,
): CentraluTools {
  const projects = () => new Map(host.store.projects.listProjects().map((p) => [p.id, p.name]))
  /*
   * The Assistant alone acts on the linked machines (#82 phase 4); an ordinary session of a trusted project
   * reads them too (#984, `readLinks`), and a lead's view stays inside its members. Asked when the call runs, as the
   * links are wired after a session may already have started.
   */
  const central = scopeIds === undefined && !ownProject && !hubView
  const linked = () => (central ? host.linkedReader() : null)
  /** The links, when this id names a linked machine's session and this seat reaches the machines */
  const remoteOf = (id: string) => {
    const reader = linked()
    return reader?.machineOf(id) ? reader : null
  }
  /*
   * The reader's own project (#320), read when the call runs: what it acts in, and all it reads from an untrusted
   * project (#984). A session with no project has none: `null === null` must not become "every session without a project".
   */
  const ownProjectId = () => host.meta.get(assistantId)?.projectId ?? null
  /** Where the calling session's context last lost what came before (#974), or null; a hub's view has no caller */
  const ownCut = () => (assistantId && host.meta.has(assistantId) ? host.store.messages.lastContextCut(assistantId) : null)
  /**
   * The sessions this one took over from (#1487), nearest first, archived ones included: its handoff lineage, read when the
   * call runs. These, and nothing else of the archive, it reads and searches. A hub's view has no caller, so no lineage.
   */
  const ownLineage = (): string[] => (assistantId && host.meta.has(assistantId) ? host.store.handoffs.lineage(assistantId) : [])
  const inScope = (s: SessionInfo) =>
    // Coordinator session (#80, #81): the allow list is its entire view
    scopeIds !== undefined ? scopeIds.includes(s.id)
    : ownProject ? (ownProjectId() !== null && s.projectId === ownProjectId())
    // What a hub reads of this host: every session but its Assistant (remote-hub.md §3.4, #1941); it acts on none through this view
    : hubView ? !isAssistantKind(s.kind)
    : true
  /*
   * What a seat may read (#984, owner decision 2026-10-17; #1941, 2026-11-04). An ordinary session of a **trusted** project
   * reads every session but an Assistant's, on this computer and on the linked machines: a coordinator's, an app's (its
   * builder, an agent an app asked for) and one with no project included, so it can find the session to talk to later and
   * reads what the Assistant answering its request could pass back. No session reads an Assistant's conversation:
   * it is the person's own talk with it. From an untrusted project it reads its own project only, as before: text planted
   * in a clone nobody trusted could otherwise search every conversation (the reason #382 keeps ask_project and attach_app
   * from there). Acting stays inside `inScope` and behind ask_project's consent; the reader object refuses it anyway.
   */
  /** This reader's view reaches past its own project: only from a trusted one */
  const wide = () => !!ownProject && host.projectTrusted(ownProjectId())
  /** An Assistant's row is never read, even one with a project (a project assistant restored from before #1941) */
  const readable = (s: SessionInfo) => !isAssistantKind(s.kind) && (inScope(s) || wide())
  /** Another session of this host that `readSession` reads: one of its handoff lineage, or a readable one (`CentraluTools.mayRead`) */
  const mayRead = (sessionId: string): boolean => {
    if (sessionId === assistantId) return false
    const target = host.meta.get(sessionId)
    return ownLineage().includes(sessionId) || (!!target && readable(target))
  }
  /** The links a read reaches: the Assistant's, and a trusted reader's (#984); acting reaches them from the centre only */
  const readLinks = () => (central || wide() ? host.linkedReader() : null)
  /** A machine's session as a reader may see it: null when it may not, else whether to mark it untrusted */
  const remoteReadable = (reader: LinkedSessions, id: string): { untrusted: boolean } | null => {
    if (central) return { untrusted: false }
    const facts = reader.readerFacts(id)
    return facts && { untrusted: !facts.trusted }
  }
  /** Said on every row a trusted reader sees of a project nobody trusted (#984): its text may be planted */
  const NOT_TRUSTED = ' (not trusted)'
  const projectLabel = (projectId: string | null, names: Map<string, string>, untrusted: (id: string) => boolean) =>
    !projectId ? '(none)' : (names.get(projectId) ?? '(project no longer exists)') + (names.has(projectId) && untrusted(projectId) ? NOT_TRUSTED : '')
  /** Which projects a row is marked untrusted for: only in a trusted reader's wide view, where its own is trusted */
  const untrustedMark = () => (wide() ? (id: string) => !host.projectTrusted(id) : () => false)
  // A stale id (deleted, replaced) says what it was and which live session now carries its name (stale-session-id.ts)
  const readError = (id: string) =>
    (ownProject && wide() ? `Not a session you can read: ${id}` : scopeText(id)) + staleSessionHint(host, id, readable, central, 'read')
  const scopeError = (id: string, doing: 'send' | 'act' = 'act') => scopeText(id) + staleSessionHint(host, id, inScope, central, doing)
  const scopeText = (id: string) =>
    scopeIds !== undefined ? `Not a member of this coordinating session: ${id}`
    : ownProject ? `Not a session in this project: ${id}`
    : hubView ? `Not a session this machine shares: ${id}`
    : `Not a session this app manages: ${id}`

  /**
   * An instruction to a linked machine's session (#82 phase 4), send_to_session's and create_session's first message
   * (#1233): delivered there as an instruction from this Assistant, under that session's own approval settings. The report is watched for before the send, since the machine's first
   * events can reach this hub before its answer does. The new wait reads nothing until the machine's record of this
   * instruction is relayed (`instruction`, #1082): a turn end before it is an earlier turn's. An earlier report
   * paused over its own work (#723) is replaced by it, as a new task ends a pause here; if the send fails it is
   * put back, and its settle wait starts again from the work as the hub knows it now. A turn end of the old work
   * that came in that moment is not the new wait's, and is not told again.
   */
  const sendLinked = async (reader: LinkedSessions, sessionId: string, text: string, reportBack: boolean | undefined): Promise<{ ok: boolean; error?: string }> => {
    const earlier = host.children.linkedReports.get(sessionId)
    const mine: LinkedReport | undefined = reportBack ? { assistantId, busy: false, instruction: text } : undefined
    if (mine) host.children.setLinkedReport(sessionId, mine)
    const r = await reader.send(sessionId, text, host.meta.get(assistantId)?.name ?? 'Assistant')
    // Only what this call left is undone or dropped (#839): another send to the session set its own meanwhile
    const current = host.children.linkedReports.get(sessionId)
    if (mine) replacedBy.set(mine, earlier)
    if (!r.ok) {
      if (mine && current === mine) {
        // What was there before: past any request of an overlapping send that failed while this one was out (#839)
        let back = earlier
        while (back && failedSends.has(back)) back = replacedBy.get(back)
        if (back) {
          host.children.setLinkedReport(sessionId, back)
          host.linkedReportRestored(sessionId)
        } else host.children.dropLinkedReport(sessionId)
      } else if (mine) failedSends.add(mine)
      return r
    }
    /*
     * The machine records the instruction before it answers, and its events and answers come in order on one link,
     * read as they come: by now its record has been heard, unless it was lost (the machine's host swapped or restarted
     * before it went out, past what a reconnect replays). Then nothing would ever start the wait, so it reads turn
     * ends from here on, as before #1082: anything older came before this answer, and was not taken for its end
     */
    if (mine?.instruction !== undefined) {
      console.error(stamped(`[links] ${sessionId}: the machine's record of the instruction was not heard; the next turn end reports`))
      delete mine.instruction
    }
    // As here (#166): a new instruction without a report replaces this Assistant's earlier request
    if (!reportBack && earlier?.assistantId === assistantId && current === earlier) host.children.dropLinkedReport(sessionId)
    return { ok: true }
  }

  return {
    mayRead,
    updateCentralu: async (action, signal) => host.updateCentraluAsked(assistantId, action, signal),
    listSessions: async (opts) => {
      const byId = projects()
      const untrusted = untrustedMark()
      /** The project asked for (#984): by name or id, here or as a machine's row names it */
      const wanted = opts?.project?.trim().toLowerCase()
      const inProject = (id: string | null, name: string) => !wanted || id?.toLowerCase() === wanted || name.toLowerCase() === wanted
      // Its own project's sessions first: the ones it most likely means (#984)
      const own = ownProject ? ownProjectId() : undefined
      const all = [...host.meta.values()]
      const ordered = own ? [...all.filter((s) => s.projectId === own), ...all.filter((s) => s.projectId !== own)] : all
      const mine: OrchestratedSession[] = ordered
        // Excludes itself — instructing itself would create a loop
        .filter((s) => s.id !== assistantId && readable(s) && inProject(s.projectId, s.projectId ? (byId.get(s.projectId) ?? '') : ''))
        .map((s) => ({
          sessionId: s.id,
          name: labelOf(host.store.messages, s),
          project: projectLabel(s.projectId, byId, untrusted),
          state: s.state,
          ...(blockedOnQuestion(s) ? { waitingOn: 'question' as const } : {}),
          ...(s.worktreeMerged ? { merged: true } : {}),
          // PR status (#76, stage 3) — what lets a manager tell "waiting on review" apart from "just still
          // in progress"
          ...(s.worktreePr ? { pr: { number: s.worktreePr.number, state: s.worktreePr.state } } : {}),
          tool: s.tool,
          preview: previewOf(host.store.messages, s.id),
          lastActive: lastActiveOf(host.store.messages, s.id),
          ...(s.interruption ? { interruption: s.interruption } : {}),
        }))
      const reader = readLinks()
      if (!reader) return mine
      const theirs: OrchestratedSession[] = []
      for (const row of await reader.list()) {
        const seen = remoteReadable(reader, row.sessionId)
        if (seen && inProject(null, row.project)) theirs.push(seen.untrusted ? { ...row, project: row.project + NOT_TRUSTED } : row)
      }
      return [...mine, ...theirs]
    },

    updateSessionSettings: async (sessionId, s) => {
      if (sessionId === assistantId) {
        // Changing its own settings restarts its own process — that would be suicide in the middle of a
        // tool call
        return { ok: false, error: 'The person changes its own settings' }
      }
      const remote = remoteOf(sessionId)
      if (remote) {
        // Changed there, through the router, as the window's own call would (#82 phase 4); the trace is the same
        const r = await remote.updateSettings(sessionId, s)
        if (!r.ok) return r
        host.emit({ type: 'settings_changed', sessionId, model: r.info.model, effort: r.info.effort, verbosity: r.info.verbosity, serviceTier: r.info.serviceTier })
        return { ok: true, ...(r.info.applied === 'after_turn' ? { deferred: true } : {}) }
      }
      const target = host.meta.get(sessionId)
      if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }
      /*
       * A running turn is never blocked (#164) — applying a change used to mean an immediate
       * restart, which killed an in-progress turn, and that is why `working` was refused
       * (`waiting_approval` was missed). Now that updateSettings defers to the end of the turn, this
       * follows the same rule as the person's own path.
       */
      try {
        /*
         * **A settings change must never happen without a trace** (#30). `updateSettings` broadcasts it, marked as
         * this hand's: the screen toasts it, since to the person's eyes a value changed by a hand other than their
         * own is identical to a value quietly changing on its own.
         */
        const info = await host.updateSettings(sessionId, s, 'orchestrator')
        return { ok: true, ...(info.applied === 'after_turn' ? { deferred: true } : {}) }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    createSession: async (opts) => {
      const all = host.store.projects.listProjects()
      // A linked machine's project, by its name or qualified id (#82 phase 4). Asked only when links exist, and not for
      // this computer's own id, which is exact (as ask_project's rule is)
      const reader = linked()
      const wanted = (opts.project ?? '').trim()
      const exactHere = all.some((p) => p.id === wanted)
      // The same match as ask_project's: the id, the exact name, `<machine>/<name>`, then the name in any case; two of one name on this computer are still refused
      const found = (machineProjects: readonly LinkedProject[]) =>
        matchProjects(
          wanted,
          [
            ...all.map((p) => ({ id: p.id, name: p.name, machine: null, machineId: null })),
            ...machineProjects.map((p) => ({ id: p.id, name: p.name, machine: p.machine, machineId: p.machineId })),
          ],
          { everyOne: true },
        )
      let there = reader && wanted && !exactHere ? await reader.projects({ ref: wanted }) : null
      let matched = found(there?.projects ?? [])
      // Named nowhere (#1547): a machine that is down may hold a project its mirror lacks, so those are tried now (once per window)
      if (reader && there && !matched.length) {
        there = await reader.projects({ ref: wanted, anyDown: true, prior: there })
        matched = found(there.projects)
      }
      const local = matched.flatMap((m) => all.filter((p) => m.machineId === null && p.id === m.id))
      const remote = matched.flatMap((m) => (there?.projects ?? []).filter((p) => m.machineId !== null && p.id === m.id))
      const missing = there && !matched.length ? awayFor(wanted, there.away, there.machines.map((m) => m.machineId)) : []
      // Named with its machine, which is down: refused as ask_project refuses it
      const [down] = missing
      if (down && missing.length === 1 && (wanted.includes('/') || wanted.startsWith(`${down.machineId}.`))) return { ok: false, error: awayRefusal(down.machine, down.why, `"${wanted}" cannot be created there`) }
      if (missing.length) {
        return { ok: false, error: `No such project: ${wanted}. Not asked, and its projects may be missing: ${missing.map((a) => `${a.machine} (${a.why})`).join(', ')}.` }
      }
      if (local.length + remote.length > 1) {
        // One name on two machines: guessing would start the work on the wrong disk. A machine that cannot be asked just
        // now counts too (`away`): its project may be the one meant, and dropping it used to start the work here instead
        const named = [
          ...local.map((p) => `${p.name} [${p.id}] on this computer`),
          ...remote.map((p) => `${p.name} [${p.id}] on ${p.machine}${p.away ? ` (which ${awayPhrase(p.away)})` : ''}`),
        ]
        return { ok: false, error: `More than one project is called that; give its id: ${named.join('; ')}` }
      }
      // Found only from the mirror: refused now, rather than a create sent over a link that did not answer a list
      const away = remote[0]?.away
      if (away) return { ok: false, error: `${remote[0]!.name} [${remote[0]!.id}] is on ${remote[0]!.machine}, which ${awayPhrase(away)}. ${tryAgainAfter(away)}` }
      /*
       * The new session never runs with more than this seat's own permissions, and its first message is this seat's,
       * not the person's (#838). It used to be `normal` whatever the seat ran under and stored as if the person had
       * typed it, so a `safe` assistant that read a planted instruction could start a `normal` session carrying
       * it, with no card. Now it gets the default a new session gets, or the preset named, within the seat's own
       * (`createdPreset`, owner decision 2026-11-05). A project there whose trust the machine does not say is not trusted.
       */
      const seat = host.meta.get(assistantId)
      const own = seat?.permissionPreset ?? 'safe'
      const target = remote[0] ?? local[0]
      // A linked machine's project as that machine says; one here as this host reads it now
      const trusted = remote[0] ? remote[0].trusted === true : host.projectTrusted(target?.id ?? null)
      const asker = host.askedBy?.(assistantId)
      // Held to the lowest asking session's preset: a turn with two askers (which fails closed) holds to the lower of them
      const askerPreset = asker ? lowestPreset(...[asker, ...(asker.also ?? [])].map((a) => host.meta.get(a.sessionId)?.permissionPreset ?? 'safe')) : undefined
      const preset = createdPreset(own, { trusted }, opts.preset, askerPreset)
      if (preset === null) {
        return {
          ok: false,
          error: trusted
            ? `This session runs under ${own}, so it cannot create a session under ${opts.preset}. Name ${own} or lower, or ask the person to raise this session's preset.`
            : `${target?.name ?? 'That project'} is not trusted, so a session there runs under normal at most. Name normal or lower, or ask the person to trust the project.`,
        }
      }
      const sender = { sessionId: assistantId, name: seat?.name ?? 'Assistant' }
      /*
       * The first message is work this seat hands out (#1233): it is told when that turn ends unless it said not to, as
       * start_agent's caller is. It used to be a plain send, owed to nobody, and the Assistant heard nothing.
       */
      const reportBack = opts.reportBack !== false
      // §7.4: work given with the new session is the mailbox's to refuse before the session is made
      if (opts.firstMessage && target) {
        const refused = host.refusesDelegation(assistantId, remote[0] ? { linked: true } : { projectId: target.id }, {
          tool: 'create_session', target: remote[0] ? `a session on ${remote[0].machine}` : target.name, text: opts.firstMessage,
        })
        if (refused) return { ok: false, error: refused }
      }
      if (reader && remote[0]) {
        /*
         * `normal` at most on the link, as start_agent's child there (`remotePreset`): an `auto` one is carried as the
         * caller's (`fromHub`), so it runs `auto` there only while that machine's own "Allow auto from a linked computer"
         * switch is on (#1273), and `edits` never goes on the link (a build from before it refuses the start)
         */
        const r = await reader.createSession(remote[0], { tool: opts.tool, name: opts.name, preset: lowestPreset(preset, 'normal'), ...(preset === 'auto' ? { callerPreset: 'auto' as const } : {}) })
        if (!r.ok) return r
        if (opts.firstMessage) {
          // On a linked machine as send_to_session's instruction there: the report is watched for before it goes
          const sent = await sendLinked(reader, r.sessionId, opts.firstMessage, reportBack)
          if (!sent.ok) return { ok: false, error: `Created ${r.sessionId} on ${remote[0].machine}, but the first instruction did not go: ${sent.error}` }
        }
        return { ok: true, sessionId: r.sessionId, name: r.name }
      }
      const project = local[0]
      if (!project) {
        return {
          ok: false,
          error: opts.project ? `No such project: ${opts.project}` : 'Specify a project (name or id)',
        }
      }
      try {
        const info = await host.createSession({
          projectId: project.id,
          cwd: project.path,
          tool: opts.tool ?? host.firstTool(project.defaultTool),
          permissionPreset: preset,
        })
        if (opts.name) host.rename(info.id, opts.name)
        if (opts.firstMessage) {
          // This seat's turn, as a send to a session at rest is (#676): its cards come here, and more words are notes
          host.children.ownTurn(info.id, assistantId, true)
          try {
            await host.send(info.id, opts.firstMessage, undefined, sender)
          } catch (e) {
            host.children.releaseTurn(info.id, assistantId)
            throw e
          }
          if (reportBack) {
            host.children.markReport(info.id, assistantId)
            host.children.delegated(assistantId, info.id, 'create_session', opts.firstMessage)
          }
        }
        return { ok: true, sessionId: info.id, name: host.meta.get(info.id)?.name ?? info.name }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    recall: async (query, limit = 12) => {
      const byId = projects()
      const untrusted = untrustedMark()
      // Fetches generously, dedupes overlapping hits, then trims — trimming before dedupe would let `limit`
      // get eaten by duplicates
      const raw = host.store.messages.searchMessages(query, limit * 12)
      const cut = ownCut()
      const mine = raw.filter((h) => {
        // Its own words only earlier than its last compaction (#974): the model's context lost those and our record
        // did not. Later ones, or all of them with no compaction, are still in context and finding them is an echo
        if (h.sessionId === assistantId) return cut !== null && h.seq < cut
        const s = host.meta.get(h.sessionId)
        return s && readable(s)
      })
      // Its own project's hits first, each in its rank (#984): the ones it most likely means
      const own = ownProject ? ownProjectId() : null
      if (own) mine.sort((x, y) => Number(host.meta.get(y.sessionId)?.projectId === own) - Number(host.meta.get(x.sessionId)?.projectId === own))
      /*
       * Its handoff lineage, archived or not (#1487): the archive's index is dropped, so these are searched by their
       * messages, the nearest predecessor first. They are kept out of the other hits and come after them, each marked as
       * the predecessor's, but with a share of `limit` of their own: a common word fills the limit with live hits, and the
       * predecessor would never show.
       */
      const lineage = ownLineage()
      const earlier = dedupeNearbyHits(host.store.messages.searchSessions(lineage, query, limit * 4))
      const live = dedupeNearbyHits(mine.filter((h) => !lineage.includes(h.sessionId)))
      const chosen = live.slice(0, limit - Math.min(earlier.length, limit >= 2 ? Math.max(1, Math.floor(limit / 4)) : 0))
      chosen.push(...earlier.slice(0, limit - chosen.length))
      const out: RecallHit[] = []
      // Asked at once, while this host's own search runs: each machine is a round trip
      const remote = readLinks()?.recall(query, limit)
      for (const h of chosen) {
        const s = host.meta.get(h.sessionId)
        const predecessor = lineage.includes(h.sessionId)
        if (predecessor) {
          // Live or in the archive (where the session row keeps its name and the trash record its project)
          const stored = s ?? host.store.trash.trashedSession(h.sessionId)?.session
          if (!stored) continue
          const projectId = s ? s.projectId : host.store.handoffs.projectOf(stored.id)
          out.push({
            sessionId: stored.id,
            session: `${labelOf(host.store.messages, stored)} (your predecessor${s ? '' : ', archived'})`,
            project: projectLabel(projectId, byId, untrusted),
            snippet: windowAroundLines(contextAt(host.store.messages, stored.id, h.seq, undefined, true), query, 160),
            seq: h.seq,
            at: timeOf(host.store.messages, h.sessionId, h.seq),
            predecessor: true,
          })
          continue
        }
        if (!s) continue
        const context = contextAt(host.store.messages, s.id, h.seq, s.id === assistantId && cut !== null ? cut : undefined)
        out.push({
          sessionId: s.id,
          session: s.id === assistantId ? `${labelOf(host.store.messages, s)} (this session, before compaction)` : labelOf(host.store.messages, s),
          project: projectLabel(s.projectId, byId, untrusted),
          // Cut from **the surrounding conversation**, not a single delta chunk (a chunk alone says
          // nothing); its own hit stops at its compaction (#974). Its lines are kept, so the mark of who wrote a message is
          // never one that a message's text wrote (#838)
          snippet: context ? windowAroundLines(context, query, 160) : windowAround(h.body, query, 160),
          seq: h.seq, // Passed as `around` to read_session, it jumps straight to that spot
          at: timeOf(host.store.messages, h.sessionId, h.seq),
        })
      }
      if (!remote) return { hits: out }
      /*
       * Each machine's hits in its own rank, taken in turns with this host's (#82 phase 4): ranks from two stores
       * do not compare, and appending would let the first source fill the limit before another is heard
       */
      const { hits, notSearched } = await remote
      const links = readLinks()!
      const theirs = hits.map((list) =>
        list.flatMap((h) => {
          const seen = remoteReadable(links, h.sessionId)
          return !seen ? [] : seen.untrusted ? [{ ...h, project: h.project + NOT_TRUSTED }] : [h]
        }),
      )
      return { hits: takeInTurns([out, ...theirs], limit), ...(notSearched.length ? { notSearched } : {}) }
    },

    readSession: async (sessionId, limit = 40, opts) => {
      /*
       * Itself only at a recall hit from before its last compaction (#974), and only up to that point: the rest is
       * still in its context. A plain self-read would just echo it back.
       */
      const self = sessionId === assistantId
      const cut = self ? ownCut() : null
      const spot = opts?.around ?? opts?.from ?? opts?.before
      if (self && (cut === null || spot == null || spot >= cut)) {
        return {
          ok: false,
          error:
            cut === null ? 'Does not read itself: your conversation has not been compacted, so all of it is still in your context.'
            : 'Reads itself only before its last compaction, from a recall hit: search with recall, then pass that hit\'s seq as around.',
        }
      }
      // A linked machine's session is read there, by the machine that holds it (#82 phase 4)
      const reader = readLinks()
      if (!self && reader?.machineOf(sessionId)) {
        const seen = remoteReadable(reader, sessionId)
        if (!seen) return { ok: false, error: readError(sessionId) }
        const r = await reader.read(sessionId, limit, opts)
        return seen.untrusted && r.ok ? { ...r, untrusted: true } : r
      }
      /*
       * A session of its own handoff lineage (#1487), live or in the archive: readable whatever its project, and marked as
       * the predecessor's. The archive is read no further; any other session in it is refused here, as a missing one is
       */
      const inLineage = !self && ownLineage().includes(sessionId)
      const target = host.meta.get(sessionId)
      if (self ? !target : !mayRead(sessionId)) return { ok: false, error: readError(sessionId) }
      const state = target?.state ?? 'archived'
      // An archived session's project is in its trash record (the row's own is cleared)
      const targetProject = target ? target.projectId : host.store.handoffs.projectOf(sessionId)
      const mark = (ls: SessionLine[]): SessionLine[] => (inLineage ? asPredecessor(ls, sessionId) : ls)
      const readOn = { tools: toolLinesOf(opts?.tools), ...(opts?.maxChars !== undefined ? { maxChars: opts.maxChars } : {}), ...(hubView ? { viaHub: true } : {}) }

      /*
       * If `around` is given, reads near that point — the seq recall gave can just be passed
       * straight through. Without this, the state was "found it but cannot get there": recall only
       * gave a session id, read_session only read the very end, and in the end the whole session had
       * to be pulled up and searched by eye.
       */
      /*
       * The read count is measured in messages (#66) — applying the old x8 correction from when a
       * row was a delta, unchanged, to today's merged rows would mean pulling up hundreds of messages.
       */
      const around = opts?.around
      /*
       * A line read from an offset (#1186): the one line that starts at `around`, built from its rows on with the same
       * merging as the plain read, from character `offset` on. A long answer cut in a plain read (or by ask_project's
       * cut) is read to its end this way; before, the middle of it could not be read back at all.
       */
      if (around != null && opts?.offset != null) {
        const from = host.store.messages.loadMessagesFrom(sessionId, around - 1, OFFSET_READ_ROWS)
        const line = mark(sessionLines(cut === null ? from : from.filter((r) => r.seq < cut), opts))[0]
        return {
          ok: true,
          state,
          ...(inLineage ? { predecessor: sessionId } : {}),
          ...(targetProject && untrustedMark()(targetProject) ? { untrusted: true } : {}),
          lines: line ? [lineText(line, opts.offset, opts.maxChars === undefined ? LINE_WINDOW_CHARS : budgetOf(opts.maxChars), true)] : [],
        }
      }
      /*
       * A read on from where a budget stopped one (#1480): `before` the oldest line it showed, back; `from` the first it did
       * not, forward. The notes of a read name them, so following one shows nothing twice, as `around` (centred) did
       */
      const before = opts?.before
      const fromSeq = opts?.from
      const read = before != null
        ? host.store.messages.loadMessages(sessionId, limit * 2, before)
        : fromSeq != null
          ? host.store.messages.loadMessagesFrom(sessionId, fromSeq - 1, limit * 2)
          : around
        ? [
            ...host.store.messages.loadMessages(sessionId, limit, around + 1),
            ...host.store.messages.loadMessagesFrom(sessionId, around, limit),
          ]
        : host.store.messages.loadMessages(sessionId, limit * 2)
      const rows = cut === null ? read : read.filter((r) => r.seq < cut)
      const lines = mark(sessionLines(rows, opts))
      /** The line that contains the seq `around` points at — the window is cut to align with this */
      const at = around != null ? rows.find((r) => r.seq >= around)?.seq : undefined
      const anchor = at === undefined ? -1 : lines.findLastIndex((l) => l.seq <= at)
      /*
       * When `around` is given, the window is cut **centered on that spot.**
       * Both branches used to cut off the tail the same way, so even arriving with the seq recall
       * pointed at, only the trailing end of the window was ever visible — leaving the same "found
       * it but cannot get there" state intact.
       */
      const start = around != null && anchor >= 0 ? Math.max(0, anchor - Math.floor(limit / 2)) : -1
      const picked = before != null ? lines.slice(-limit) : fromSeq != null ? lines.slice(0, limit) : start >= 0 ? lines.slice(start, start + limit) : lines.slice(-limit)
      // The cards of a turn this seat gave it (#676): this read is where a directing seat finds them
      const cards = host.routedCards(sessionId, assistantId)
      return {
        ok: true,
        state,
        ...(inLineage ? { predecessor: sessionId } : {}),
        ...(targetProject && untrustedMark()(targetProject) ? { untrusted: true } : {}),
        // At most the call's budget in all (#1480), not 40 lines of 2,000 characters each
        lines: fitLines(picked, before != null ? 'back' : fromSeq != null ? 'forward' : start >= 0 && around != null ? { around: anchor - start } : 'back', budgetOf(opts?.maxChars), readOn),
        ...(cards.length ? { cards } : {}),
      }
    },

    // A card of a turn this seat gave a session in its view (#676) — the directing seats' agent_session answer
    answerQuestion: async (opts) => {
      const target = host.meta.get(opts.sessionId)
      if (!target || !inScope(target)) return { ok: false, error: scopeError(opts.sessionId) }
      return host.answerRoutedCard(assistantId, opts.sessionId, opts.card, opts.text)
    },

    // Only an ordinary session asks another project (#371): the Assistant, managers and coordinators already
    // direct sessions with send_to_session, inside their own view
    askProject: async () => ({ ok: false, error: 'Only an ordinary project session can ask another project' }),
    /*
     * Starting agents (#561): an ordinary session's, and the Assistant's (#853), which hands light work
     * outside any project (a web search, a lookup) to a child the person can watch, where it used to reach for its
     * CLI's own subagent, which Centralu never shows. A coordinator and a hub's view direct sessions with their own tools
     */
    startAgent: async (opts, signal) =>
      central && isAssistantKind(host.meta.get(assistantId)?.kind)
        ? host.startAgent(assistantId, opts, signal)
        : { ok: false, error: 'Only an ordinary project session or the Assistant can start agents this way' },
    agentSession: async (opts, signal) =>
      central && isAssistantKind(host.meta.get(assistantId)?.kind)
        ? host.agentSession(assistantId, opts, signal)
        : { ok: false, error: 'Only an ordinary project session or the Assistant can start agents this way' },
    listAgents: async () =>
      central && isAssistantKind(host.meta.get(assistantId)?.kind)
        ? { ok: true, agents: await host.listAgents(assistantId) }
        : { ok: false, error: 'Only an ordinary project session or the Assistant can start agents this way' },

    sendToSession: async (sessionId, text, reportBack, ifBusy) => {
      /*
       * Never fails silently. If the Assistant names the wrong session and nothing happens, the
       * person only sees "I told it to and it did not" — returning the reason lets the Assistant
       * ask again or fix it itself.
       */
      if (sessionId === assistantId) {
        return { ok: false, error: 'Cannot send to itself' }
      }
      const remote = remoteOf(sessionId)
      if (remote) {
        // §7.4: asked before anything goes over the link
        const refused = host.refusesDelegation(assistantId, { sessionId, linked: true }, { tool: 'send_to_session', target: `a session on ${remote.machineOf(sessionId) ?? 'a linked machine'}`, text })
        if (refused) return { ok: false, error: refused }
        return sendLinked(remote, sessionId, text, reportBack)
      }
      const target = host.meta.get(sessionId)
      if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId, 'send') }
      // §7.4: work given with a report asked is a delegation, the mailbox's to refuse before anything is sent, mailed or forked
      if (reportBack) {
        const refused = host.refusesDelegation(assistantId, { sessionId, projectId: target.projectId }, { tool: 'send_to_session', target: target.name || target.id, text })
        if (refused) return { ok: false, error: refused }
      }
      // A session that cannot take it now is sent it as mail, which starts a turn of its own once it is free (docs/plans/mailbox.md §10.6.2); a fork if asked
      if (!host.takesSendNow(sessionId)) {
        if (ifBusy) {
          const f = await host.forkFor(assistantId, target, text, ifBusy === 'fork_read', 'send_to_session')
          if (!f.ok) return f
          if ('mailed' in f) return { ok: true, busy: f.mailed }
          host.children.markReport(f.fork.id, assistantId)
          return { ok: true, busy: { state: 'forked', sessionId: f.fork.id, sessionName: host.meta.get(f.fork.id)?.name ?? f.fork.name, forkedFrom: target.id } }
        }
        const mailed = host.mailTask(assistantId, target, 'send_to_session', text)
        return 'error' in mailed ? { ok: false, error: mailed.error } : { ok: true, busy: mailed }
      }

      // At rest: the turn it starts is this seat's (#676), its cards come here too, until it ends
      host.children.ownTurn(sessionId, assistantId, true)
      try {
        // Tagged with its source and kept in the store/UI. The adapter's reporting gate only ever fires for
        // a lower-privilege reportBack.
        const orch = host.meta.get(assistantId)
        await host.send(sessionId, text, undefined, {
          sessionId: assistantId,
          name: orch?.name ?? 'Assistant',
        })
      } catch (e) {
        host.children.releaseTurn(sessionId, assistantId)
        return { ok: false, error: (e as Error).message }
      }
      // Only comes back when asked for — silent by default
      if (reportBack) {
        host.children.markReport(sessionId, assistantId)
        host.children.delegated(assistantId, sessionId, 'send_to_session', text)
      }
      // Instructing again without asking for a report clears this Assistant's earlier request — the
      // new instruction replaces it (#166)
      else if (host.children.awaitingReport.get(sessionId) === assistantId) host.children.clearReport(sessionId)
      return { ok: true }
    },


    /*
     * Only proposes (propose-not-power). Installing and restarting only happen when the person's
     * approval click drives them through resolveMcpProposal — registering an MCP server is
     * registering arbitrary command execution, so installing it right here would turn a single
     * injected line that came in through read_session into a running process.
     */
    proposeMcpServer: async (spec) => host.proposals.proposeMcpServer(spec),

    // Skill proposal (#71) — the same rule as an MCP proposal: proposing only saves it, and it has no
    // effect until approved
    proposeSkill: async (spec) => host.proposals.proposeSkill(spec),

    // A new project (#515) — made only once the person approves the card this raises in the Assistant's own slot
    createProject: async (spec, signal) => {
      const reader = linked()
      if (spec.machine && reader) {
        const machine = reader.machineNamed(spec.machine)
        if (machine) return host.createProjectOnMachine(assistantId, reader, machine, { name: spec.name, parent: spec.parent, source: spec.source }, signal)
        if (!/^this computer$/i.test(spec.machine.trim())) return { ok: false, error: `No linked machine is called ${spec.machine}; leave machine out for this computer` }
      } else if (spec.machine && !/^this computer$/i.test(spec.machine.trim())) {
        return { ok: false, error: 'No machine is linked to this computer; leave machine out' }
      }
      return host.createProjectAsked(assistantId, { name: spec.name, parent: spec.parent, source: spec.source }, signal)
    },

    /*
     * An existing folder as a project (#1220), made only once the person allows the card this raises in the
     * Assistant's own slot. The Assistant's alone, as the linked machines are; `machine` is resolved as
     * create_project resolves it.
     */
    addProject: async (spec, signal) => {
      if (!central) return { ok: false, error: 'Only the Assistant adds projects' }
      const reader = linked()
      if (spec.machine && reader) {
        const machine = reader.machineNamed(spec.machine)
        if (machine) return host.addFolderOnMachine(assistantId, reader, machine, spec.path, signal)
        if (!/^this computer$/i.test(spec.machine.trim())) return { ok: false, error: `No linked machine is called ${spec.machine}; list_machines names them, and leaving machine out means this computer` }
      } else if (spec.machine && !/^this computer$/i.test(spec.machine.trim())) {
        return { ok: false, error: 'No machine is linked to this computer; leave machine out' }
      }
      return host.addFolderAsked(assistantId, spec.path, signal)
    },

    // The linked machines (#1220): the list Settings shows, read only; the Assistant's alone
    listMachines: () => (central ? host.machineList() : []),

    // Changes to the linked machines (#1219), behind the person's card where they change a machine or this computer's reach
    machine: async (req, signal) => (central ? host.machineRequest(assistantId, req, signal) : { ok: false, error: 'Only the Assistant changes linked machines' }),

    // The preferences (#1219): the Assistant's alone, through the window's own calls
    preferences: async (req, signal) => (central ? host.preferencesRequest(assistantId, req, signal) : { ok: false, error: 'Only the Assistant changes preferences' }),

    // The session archive (#1219): the Assistant's alone; deleting for good waits for the person's card
    trash: async (req, signal) => (central ? host.trashRequest(assistantId, req, signal) : { ok: false, error: 'Only the Assistant manages the session archive' }),

    // Trust (#1219): the Assistant's alone; widening it waits for the person's card
    trust: async (req, signal) => (central ? host.trustRequest(assistantId, req, signal) : { ok: false, error: 'Only the Assistant changes trust' }),

    // Housekeeping and reads (#1219): the Assistant's alone; none asks
    housekeeping: async (req) => (central ? host.housekeepingRequest(assistantId, req) : { ok: false, error: 'Only the Assistant does this housekeeping' }),

    // App upkeep (#1219): the Assistant's alone; removing an app waits for the person's card
    appUpkeep: async (req, signal) => (central ? host.appUpkeepRequest(assistantId, req, signal) : { ok: false, error: 'Only the Assistant looks after apps' }),

    /*
     * A handoff (#694): the Assistant's alone (the profile gives it no other seat; checked here too, as this
     * object also serves a lead's and a reader's view), a session of this computer in its view. The rest of the rule
     * (which sessions, mid-turn, the person's card) is HandoffFlow's.
     */
    usageHistory: async ({ days, by }) => {
      const now = Date.now()
      return host.usageHistory({ from: new Date(now - days * 24 * 3_600_000).toISOString(), to: new Date(now + 3_600_000).toISOString(), groupBy: 'day', by })
    },
    handoffSession: async (spec, signal) => {
      if (!central) {
        console.error(`[agent-host] handoff_session by ${assistantId.slice(0, 8)} refused: not the Assistant`)
        return { ok: false, error: 'Only the Assistant hands sessions off' }
      }
      // Waiting on a run a "still running" answer named: its own runs only (`HandoffFlow.wait`)
      if (spec.waitFor) return host.handoffWait(assistantId, spec.waitFor, signal)
      if (!spec.sessionId) return { ok: false, error: 'Give sessionId: the session to hand off, from list_sessions.' }
      const id = spec.sessionId
      // Every refusal is logged with who asked and for which session, as the flow's are (#694 review)
      const refuse = (error: string) => {
        console.error(`[agent-host] handoff_session by ${assistantId.slice(0, 8)} of ${id.slice(0, 8)} refused: ${error}`)
        return { ok: false as const, error }
      }
      if (id === assistantId) return refuse('An Assistant does not hand itself off; the person does that.')
      if (remoteOf(id)) return refuse('That session runs on a linked machine; hand it off there.')
      const target = host.meta.get(id)
      if (!target || !inScope(target)) return refuse(scopeError(id))
      return host.handoff(assistantId, target, { ...(spec.tool ? { tool: spec.tool } : {}), ...(spec.mode ? { mode: spec.mode } : {}), ...(spec.instructions ? { instructions: spec.instructions } : {}) }, signal)
    },

    // Checks its own app (C-3) — which app it is is decided by the calling session. Refused if it is not a
    // builder session (the directory has changed)
    checkApp: async () => {
      const self = host.meta.get(assistantId)
      const ref = self ? host.builderRefOf(self) : null
      if (!ref) return { ok: false, text: 'This session is not the builder of any app, so there is no app to check' }
      const r = await host.checkApp(ref)
      return { ok: r.ok, text: r.text }
    },

    // Creates a new app (M4 C-1b) — a project is referenced by name or id (same as create_session). Rules
    // are enforced by the runtime's own gate
    createApp: async (spec, signal) => {
      let projectId: string | null = null
      if (spec.project) {
        const project = host.store.projects.listProjects().find((p) => p.id === spec.project || p.name === spec.project)
        if (!project) return { ok: false, error: `No such project: ${spec.project}` }
        projectId = project.id
      } else {
        // Without a project it makes a folder and a project (#1141): the person allows that on create_project's card
        const refused = await host.askAppProject(assistantId, { id: spec.id, ...(spec.parent ? { parent: spec.parent } : {}) }, signal)
        if (refused) return { ok: false, error: refused }
      }
      try {
        const { app, builder, builderError } = await host.createApp({
          projectId,
          id: spec.id,
          name: spec.name,
          description: spec.description,
          tool: spec.tool,
          ...(projectId === null && spec.parent ? { parent: spec.parent } : {}),
        })
        return {
          ok: true,
          appId: app.appId,
          projectId: app.projectId,
          dir: app.dir,
          ...(builder ? { builder: { sessionId: builder.id, name: builder.name } } : {}),
          ...(builderError ? { builderError } : {}),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    // On-demand app attachment: a project session's (#371 part A, readerToolsFor) and the Assistant's (#1205,
    // SessionTools.centraluToolsFor); a coordinator's scope has none
    findApps: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
    attachApp: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
    detachApp: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
  }
}
