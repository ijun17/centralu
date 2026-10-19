import { blockedOnQuestion, RESERVED_APP_IDS, type Attachment, type ExternalAppInfo, type GitSource, type MachineInfo, type NormalizedEvent, type PermissionPreset, type SessionInfo, type SettingsApplied, type ToolName, type UpdateStatus } from '@cc/protocol'
import type { AgentListRow, AgentSessionOpts, BusyAnswer, BusyChoice, ChildRunResult, HandoffResult, LinkedSessions, OrchestratedSession, OrchestratorTools, RecallHit, RoutedCard, StartAgentOpts } from '../adapters/contract.js'
import type { AppCheckReport, AppRef } from '../apps/external/runtime.js'
import type { QueuedRequest, Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { presetWithin } from './start-agent.js'
import type { ChildOwnership, LinkedReport } from './child-ownership.js'
import type { OrchestratorProposals } from './orchestrator-proposals.js'
import type { FolderAdded } from './project-creation.js'
import type { MachineAnswer, MachineRequest } from './machine-flow.js'
import { dedupeNearbyHits, takeInTurns, windowAround, windowAroundLines } from './snippet.js'
import { authorOf, contextAt, labelOf, lastActiveOf, previewOf, timeOf } from './transcript-view.js'

/**
 * What the orchestrator tools reach of the session manager (#428): its sessions and store, who owns whose work, and
 * the manager's own operations they call. The manager hands itself over through this (`SessionManager.seat`), so the
 * tools stay one function over a narrow surface rather than a method that sees the whole class.
 */
export type OrchestratorSeatHost = {
  /** Read when a tool runs, as every field here: what the manager holds is read now, never a copy kept from before */
  readonly store: Store
  readonly meta: ReadonlyMap<string, SessionInfo>
  readonly children: ChildOwnership
  readonly proposals: Pick<OrchestratorProposals, 'proposeMcpServer' | 'proposeSkill'>
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
  rename(sessionId: string, name: string): void
  send(sessionId: string, text: string, attachments?: Attachment[], from?: { sessionId: string; name: string }): Promise<void>
  routedCards(sessionId: string, callerId: string): RoutedCard[]
  answerRoutedCard(callerId: string, sessionId: string, card: string | undefined, text: string): Promise<ChildRunResult>
  busyForCaller(callerId: string, sessionId: string): boolean
  busyAnswer(callerId: string, target: SessionInfo, from: QueuedRequest['via']): Extract<BusyAnswer, { state: 'busy' }>
  busyChoices(callerId: string, target: SessionInfo, from: QueuedRequest['via']): BusyChoice[]
  enqueue(callerId: string, target: SessionInfo, via: QueuedRequest['via'], text: string): Extract<BusyAnswer, { state: 'queued' }>
  forkFor(
    callerId: string,
    target: SessionInfo,
    text: string,
    readOnly: boolean,
    via: QueuedRequest['via'],
    signal?: AbortSignal,
  ): Promise<{ ok: false; error: string } | { ok: true; fork: SessionInfo } | { ok: true; queued: Extract<BusyAnswer, { state: 'queued' }> }>
  autoBoundaryOpen(sessionId: string, boundary?: string): boolean
  createProjectAsked(
    sessionId: string,
    spec: { name: string; parent?: string; source?: GitSource },
    signal?: AbortSignal,
  ): Promise<{ ok: true; projectId: string; name: string; path: string } | { ok: false; error: string }>
  /** create_app without a project (#1141): create_project's card for the folder it makes (`ProjectCreation.askAppProject`) */
  askAppProject(sessionId: string, spec: { id: string; parent?: string }, signal?: AbortSignal): Promise<string | null>
  createProjectOnMachine(
    sessionId: string,
    reader: LinkedSessions,
    machine: { id: string; name: string },
    spec: { name: string; parent?: string; source?: GitSource },
    signal?: AbortSignal,
  ): Promise<{ ok: true; projectId: string; name: string; path: string; machine: string } | { ok: false; error: string }>
  /** add_project (#1220): `ProjectCreation.addFolderAsked`, a folder on this computer */
  addFolderAsked(sessionId: string, path: string, signal?: AbortSignal): Promise<FolderAdded>
  /** add_project on a linked machine (#1220): `ProjectCreation.addFolderOnMachine` */
  addFolderOnMachine(sessionId: string, reader: LinkedSessions, machine: { id: string; name: string }, path: string, signal?: AbortSignal): Promise<FolderAdded>
  /** The linked machines as `machines.list` answers them (#1220), once wired (`useMachineList`); empty without links */
  machineList(): MachineInfo[]
  /** The machine commands (#1219): `MachineFlow.run`, with the orchestrator as the session its cards stand in */
  machineRequest(sessionId: string, req: MachineRequest, signal?: AbortSignal): Promise<MachineAnswer>
  /** start_agent and agent_session for the central orchestrator (#853): the start flow, with the orchestrator as the caller */
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
  /** handoff_session's waitFor (#694): `HandoffFlow.wait` */
  handoffWait(callerId: string, handle: string, signal?: AbortSignal): Promise<HandoffResult>
  builderRefOf(m: Pick<SessionInfo, 'id' | 'appId' | 'projectId'>): AppRef | null
  checkApp(ref: AppRef): Promise<AppCheckReport>
  createApp(params: {
    projectId: string | null
    id: string
    name: string
    description?: string
    tool?: ToolName
    parent?: string
  }): Promise<{ app: ExternalAppInfo; builder: SessionInfo | null; builderError?: string }>
}

/**
 * Report requests of overlapping linked sends (#839): what each one replaced, and those whose send failed while another
 * send's request stood over them. A failed send puts back what was there before it, past any such failed request.
 */
const replacedBy = new WeakMap<LinkedReport, LinkedReport | undefined>()
const failedSends = new WeakSet<LinkedReport>()

/**
 * The tools given to an orchestrator (FR-11).
 *
 * **There is no way to reach outside the sessions this app manages.** Since it only ever looks at
 * the manager's own metadata, it never touches someone else's session made from a terminal, or
 * files, or a project directory — not because a blocking rule was written for it, but because that
 * is the entire extent of what it can see.
 */
export function orchestratorToolsFor(
  host: OrchestratorSeatHost,
  orchestratorId: string,
  scopeIds?: string[],
  ownProject?: boolean,
  /** A hub's view of this host (`hostReader`, #82 phase 4): what its window shows, with no calling session */
  hubView?: boolean,
): OrchestratorTools {
  const projects = () => new Map(host.store.projects.listProjects().map((p) => [p.id, p.name]))
  /*
   * The central orchestrator alone acts on the linked machines (#82 phase 4); an ordinary session of a trusted project
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
  const ownProjectId = () => host.meta.get(orchestratorId)?.projectId ?? null
  /** Where the calling session's context last lost what came before (#974), or null; a hub's view has no caller */
  const ownCut = () => (orchestratorId && host.meta.has(orchestratorId) ? host.store.messages.lastContextCut(orchestratorId) : null)
  const inScope = (s: SessionInfo) =>
    // Coordinator session (#80, #81): the allow list is its entire view
    scopeIds !== undefined ? scopeIds.includes(s.id)
    : ownProject ? (ownProjectId() !== null && s.projectId === ownProjectId())
    // What a hub's window shows of this host: never its orchestrator or coordinators (remote-hub.md §3.4)
    : hubView ? s.kind !== 'orchestrator' && s.kind !== 'coordinator'
    : true
  /*
   * What a seat may read (#984, owner decision 2026-10-17). An ordinary session of a **trusted** project reads every
   * project's sessions, on this computer and on the linked machines, so it can find the session to talk to later. From
   * an untrusted project it reads its own project only, as before: text planted in a clone nobody trusted could
   * otherwise search every conversation (the reason #382 keeps ask_project and attach_app from there).
   *
   * Outside its own project it reads ordinary sessions only: never an orchestrator or a coordinator, whose
   * conversations direct others, and never an app's (its builder, or an agent an app asked for), whose conversations
   * carry what an app was given and nobody else was (`readsOwnProject`, `projectSessions` on a machine). Acting stays
   * inside `inScope` and behind ask_project's consent; the reader object refuses it anyway.
   */
  const trustedIds = () => new Set(host.store.projects.listProjects().filter((p) => p.trusted === true).map((p) => p.id))
  /** This reader's view reaches past its own project: only from a trusted one */
  const wide = () => {
    const own = ownProjectId()
    return !!ownProject && own !== null && trustedIds().has(own)
  }
  const ordinary = (s: SessionInfo) => s.kind === 'worker' && s.projectId !== null && !(s.appId && !RESERVED_APP_IDS.includes(s.appId))
  const readable = (s: SessionInfo) => inScope(s) || (wide() && ordinary(s))
  /** The links a read reaches: the central orchestrator's, and a trusted reader's (#984); acting reaches them from the centre only */
  const readLinks = () => (central || wide() ? host.linkedReader() : null)
  /** A machine's session as a reader may see it: null when it may not, else whether to mark it untrusted */
  const remoteReadable = (reader: LinkedSessions, id: string): { untrusted: boolean } | null => {
    if (central) return { untrusted: false }
    const facts = reader.readerFacts(id)
    return facts && !facts.app ? { untrusted: !facts.trusted } : null
  }
  /** Said on every row a trusted reader sees of a project nobody trusted (#984): its text may be planted */
  const NOT_TRUSTED = ' (not trusted)'
  const projectLabel = (projectId: string | null, names: Map<string, string>, untrusted: (id: string) => boolean) =>
    !projectId ? '(none)' : (names.get(projectId) ?? '(project no longer exists)') + (names.has(projectId) && untrusted(projectId) ? NOT_TRUSTED : '')
  /** Which projects a row is marked untrusted for: only in a trusted reader's wide view, where its own is trusted */
  const untrustedMark = () => {
    if (!wide()) return () => false
    const trusted = trustedIds()
    return (id: string) => !trusted.has(id)
  }
  const readError = (id: string) => (ownProject && wide() ? `Not a session you can read: ${id}` : scopeError(id))
  const scopeError = (id: string) =>
    scopeIds !== undefined ? `Not a member of this coordinating session: ${id}`
    : ownProject ? `Not a session in this project: ${id}`
    : hubView ? `Not a session this machine shares: ${id}`
    : `Not a session this app manages: ${id}`

  /**
   * An instruction to a linked machine's session (#82 phase 4), send_to_session's and create_session's first message
   * (#1233): delivered there as an instruction from this orchestrator, under that session's own approval settings. The report is watched for before the send, since the machine's first
   * events can reach this hub before its answer does. The new wait reads nothing until the machine's record of this
   * instruction is relayed (`instruction`, #1082): a turn end before it is an earlier turn's. An earlier report
   * paused over its own work (#723) is replaced by it, as a new task ends a pause here; if the send fails it is
   * put back, and its settle wait starts again from the work as the hub knows it now. A turn end of the old work
   * that came in that moment is not the new wait's, and is not told again.
   */
  const sendLinked = async (reader: LinkedSessions, sessionId: string, text: string, reportBack: boolean | undefined): Promise<{ ok: boolean; error?: string }> => {
    const earlier = host.children.linkedReports.get(sessionId)
    const mine: LinkedReport | undefined = reportBack ? { orchestratorId, busy: false, instruction: text } : undefined
    if (mine) host.children.setLinkedReport(sessionId, mine)
    const r = await reader.send(sessionId, text, host.meta.get(orchestratorId)?.name ?? 'Orchestrator')
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
      console.error(`[links] ${sessionId}: the machine's record of the instruction was not heard; the next turn end reports`)
      delete mine.instruction
    }
    // As here (#166): a new instruction without a report replaces this orchestrator's earlier request
    if (!reportBack && earlier?.orchestratorId === orchestratorId && current === earlier) host.children.dropLinkedReport(sessionId)
    return { ok: true }
  }

  return {
    updateCentralu: async (action, signal) => host.updateCentraluAsked(orchestratorId, action, signal),
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
        .filter((s) => s.id !== orchestratorId && readable(s) && inProject(s.projectId, s.projectId ? (byId.get(s.projectId) ?? '') : ''))
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
      if (sessionId === orchestratorId) {
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
      const local = all.filter((p) => p.id === opts.project || p.name === opts.project)
      // A linked machine's project, by its name or qualified id (#82 phase 4). Asked only when links exist
      const reader = linked()
      const remote = reader && opts.project ? await reader.findProjects(opts.project) : []
      if (local.length + remote.length > 1) {
        // One name on two machines: guessing would start the work on the wrong disk
        const named = [
          ...local.map((p) => `${p.name} [${p.id}] on this computer`),
          ...remote.map((p) => `${p.name} [${p.id}] on ${p.machine}`),
        ]
        return { ok: false, error: `More than one project is called that; give its id: ${named.join('; ')}` }
      }
      /*
       * The new session never runs with more than this seat's own permissions, and its first message is this seat's,
       * not the person's (#838). It used to be `normal` whatever the seat ran under and stored as if the person had
       * typed it, so a `safe` orchestrator that read a planted instruction could start a `normal` session carrying
       * it, with no card. `normal` stays the most it gets, as before: `auto` is the person's to give.
       */
      const seat = host.meta.get(orchestratorId)
      const seatPreset = seat?.permissionPreset ?? 'safe'
      const preset: PermissionPreset = presetWithin('normal', seatPreset) ? 'normal' : seatPreset
      const sender = { sessionId: orchestratorId, name: seat?.name ?? 'Orchestrator' }
      /*
       * The first message is work this seat hands out (#1233): it is told when that turn ends unless it said not to, as
       * start_agent's caller is. It used to be a plain send, owed to nobody, and the orchestrator heard nothing.
       */
      const reportBack = opts.reportBack !== false
      if (reader && remote[0]) {
        const r = await reader.createSession(remote[0], { tool: opts.tool, name: opts.name, preset })
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
          host.children.ownTurn(info.id, orchestratorId, true)
          try {
            await host.send(info.id, opts.firstMessage, undefined, sender)
          } catch (e) {
            host.children.releaseTurn(info.id, orchestratorId)
            throw e
          }
          if (reportBack) host.children.markReport(info.id, orchestratorId)
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
        if (h.sessionId === orchestratorId) return cut !== null && h.seq < cut
        const s = host.meta.get(h.sessionId)
        return s && readable(s)
      })
      // Its own project's hits first, each in its rank (#984): the ones it most likely means
      const own = ownProject ? ownProjectId() : null
      if (own) mine.sort((x, y) => Number(host.meta.get(y.sessionId)?.projectId === own) - Number(host.meta.get(x.sessionId)?.projectId === own))
      const out: RecallHit[] = []
      // Asked at once, while this host's own search runs: each machine is a round trip
      const remote = readLinks()?.recall(query, limit)
      for (const h of dedupeNearbyHits(mine)) {
        const s = host.meta.get(h.sessionId)!
        const context = contextAt(host.store.messages, s.id, h.seq, s.id === orchestratorId && cut !== null ? cut : undefined)
        out.push({
          sessionId: s.id,
          session: s.id === orchestratorId ? `${labelOf(host.store.messages, s)} (this session, before compaction)` : labelOf(host.store.messages, s),
          project: projectLabel(s.projectId, byId, untrusted),
          // Cut from **the surrounding conversation**, not a single delta chunk (a chunk alone says
          // nothing); its own hit stops at its compaction (#974). Its lines are kept, so the mark of who wrote a message is
          // never one that a message's text wrote (#838)
          snippet: context ? windowAroundLines(context, query, 160) : windowAround(h.body, query, 160),
          seq: h.seq, // Passed as `around` to read_session, it jumps straight to that spot
          at: timeOf(host.store.messages, h.sessionId, h.seq),
        })
        if (out.length >= limit) break
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
      const self = sessionId === orchestratorId
      const cut = self ? ownCut() : null
      if (self && (cut === null || opts?.around == null || opts.around >= cut)) {
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
      const target = host.meta.get(sessionId)
      if (!target || (!self && !readable(target))) return { ok: false, error: readError(sessionId) }

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
      const read = around
        ? [
            ...host.store.messages.loadMessages(sessionId, limit, around + 1),
            ...host.store.messages.loadMessagesFrom(sessionId, around, limit),
          ]
        : host.store.messages.loadMessages(sessionId, limit * 2)
      const rows = cut === null ? read : read.filter((r) => r.seq < cut)

      const lines: string[] = []
      /** The line that contains the seq `around` points at — the window is cut to align with this */
      let anchor = -1
      const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
      for (const r of rows) {
        const p = r.payload as { text?: string; summary?: { title?: string; tool?: string } }
        if (r.kind === 'text' && r.role === 'assistant') {
          const text = p.text ?? ''
          const last = lines[lines.length - 1]
          if (last) {
            try {
              const parsed = JSON.parse(last) as { role?: string; text?: string }
              // Two messages of one response are two paragraphs, as `turnAnswer` joins them (#428)
              if (parsed.role === 'assistant') {
                lines[lines.length - 1] = JSON.stringify({ ...parsed, text: parsed.text ? `${parsed.text}\n\n${text}` : text })
              } else {
                lines.push(JSON.stringify({ ts: stamp(r.ts), role: 'assistant', text }))
              }
            } catch {
              lines.push(JSON.stringify({ ts: stamp(r.ts), role: 'assistant', text }))
            }
          } else {
            lines.push(JSON.stringify({ ts: stamp(r.ts), role: 'assistant', text }))
          }
        } else if (r.kind === 'text') {
          // Who wrote it (#838): a child's report or an app's text is not the person's, and says so on its line
          const author = authorOf(r.payload)
          const by = author.kind === 'session' ? { from: author.name } : author.kind === 'app' ? { fromApp: author.name } : {}
          lines.push(JSON.stringify({ ts: stamp(r.ts), role: 'user', ...by, text: p.text ?? '' }))
        } else if (r.kind === 'tool_call' && p.summary?.title) {
          /*
           * **A tool call is folded up.** Expanded, a full python script or a full commit message
           * takes up all the space, burying the actual person-agent conversation underneath it (a
           * dogfooding finding). One line is enough to say what happened; the full body can be
           * expanded with tools:true if it is actually needed.
           */
          const title = opts?.tools ? p.summary.title : p.summary.title.split('\n')[0]!.slice(0, 100)
          lines.push(JSON.stringify({ ts: stamp(r.ts), role: 'tool', tool: p.summary.tool ?? '?', title }))
        }
        if (around != null && anchor < 0 && r.seq >= around && lines.length > 0) anchor = lines.length - 1
      }
      /*
       * When `around` is given, the window is cut **centered on that spot.**
       * Both branches used to cut off the tail the same way, so even arriving with the seq recall
       * pointed at, only the trailing end of the window was ever visible — leaving the same "found
       * it but cannot get there" state intact.
       */
      const from = around != null && anchor >= 0 ? Math.max(0, anchor - Math.floor(limit / 2)) : -1
      const picked = from >= 0 ? lines.slice(from, from + limit) : lines.slice(-limit)
      // The cards of a turn this seat gave it (#676): this read is where a directing seat finds them
      const cards = host.routedCards(sessionId, orchestratorId)
      return {
        ok: true,
        state: target.state,
        ...(target.projectId && untrustedMark()(target.projectId) ? { untrusted: true } : {}),
        lines: picked.map((l) => (l.length > 2000 ? l.slice(0, 2000) + '…' : l)),
        ...(cards.length ? { cards } : {}),
      }
    },

    // A card of a turn this seat gave a session in its view (#676) — the directing seats' agent_session answer
    answerQuestion: async (opts) => {
      const target = host.meta.get(opts.sessionId)
      if (!target || !inScope(target)) return { ok: false, error: scopeError(opts.sessionId) }
      return host.answerRoutedCard(orchestratorId, opts.sessionId, opts.card, opts.text)
    },

    // Only an ordinary session asks another project (#371): the orchestrator, managers and coordinators already
    // direct sessions with send_to_session, inside their own view
    askProject: async () => ({ ok: false, error: 'Only an ordinary project session can ask another project' }),
    /*
     * Starting agents (#561): an ordinary session's, and the central orchestrator's (#853), which hands light work
     * outside any project (a web search, a lookup) to a child the person can watch, where it used to reach for its
     * CLI's own subagent, which Centralu never shows. A coordinator and a hub's view direct sessions with their own tools
     */
    startAgent: async (opts, signal) =>
      central && host.meta.get(orchestratorId)?.kind === 'orchestrator'
        ? host.startAgent(orchestratorId, opts, signal)
        : { ok: false, error: 'Only an ordinary project session or the orchestrator can start agents this way' },
    agentSession: async (opts, signal) =>
      central && host.meta.get(orchestratorId)?.kind === 'orchestrator'
        ? host.agentSession(orchestratorId, opts, signal)
        : { ok: false, error: 'Only an ordinary project session or the orchestrator can start agents this way' },
    listAgents: async () =>
      central && host.meta.get(orchestratorId)?.kind === 'orchestrator'
        ? { ok: true, agents: await host.listAgents(orchestratorId) }
        : { ok: false, error: 'Only an ordinary project session or the orchestrator can start agents this way' },

    sendToSession: async (sessionId, text, reportBack, ifBusy) => {
      /*
       * Never fails silently. If the orchestrator names the wrong session and nothing happens, the
       * person only sees "I told it to and it did not" — returning the reason lets the orchestrator
       * ask again or fix it itself.
       */
      if (sessionId === orchestratorId) {
        return { ok: false, error: 'Cannot send to itself' }
      }
      const remote = remoteOf(sessionId)
      if (remote) return sendLinked(remote, sessionId, text, reportBack)
      const target = host.meta.get(sessionId)
      if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }
      /*
       * Busy with a turn that is not this seat's (#677): this seat chooses. A note goes in as before (auto only,
       * #606); a queue holds it for a new turn when the running one ends; a fork copies the session's conversation
       * into a sub-session. A queued or forked turn is this seat's and tells it when it ends; a note joins a turn that
       * stays its owner's, and tells this seat only as the note rule below says (#1233). Without `ifBusy`, nothing is sent.
       */
      if (host.busyForCaller(orchestratorId, sessionId)) {
        if (!ifBusy) return { ok: true, busy: host.busyAnswer(orchestratorId, target, 'send_to_session') }
        if (ifBusy === 'queue') return { ok: true, busy: host.enqueue(orchestratorId, target, 'send_to_session', text) }
        if (ifBusy === 'fork' || ifBusy === 'fork_read') {
          const f = await host.forkFor(orchestratorId, target, text, ifBusy === 'fork_read', 'send_to_session')
          if (!f.ok) return f
          if ('queued' in f) return { ok: true, busy: f.queued }
          host.children.markReport(f.fork.id, orchestratorId)
          return { ok: true, busy: { state: 'forked', sessionId: f.fork.id, sessionName: host.meta.get(f.fork.id)?.name ?? f.fork.name, forkedFrom: target.id } }
        }
        const note = host.busyChoices(orchestratorId, target, 'send_to_session').find((c) => c.choice === 'note')!
        if (!note.available) return { ok: false, error: `No note to "${target.name}": ${note.why}. Queue it or fork it instead.` }
        host.autoBoundaryOpen(orchestratorId, 'a note into a turn that is not its own')
      }

      try {
        // Tagged with its source and kept in the store/UI. The adapter's reporting gate only ever fires for
        // a lower-privilege reportBack.
        const orch = host.meta.get(orchestratorId)
        // A session at rest starts a turn that is this seat's (#676): its cards come here too, until it ends
        const atRest = !inTurn(target.state)
        if (atRest) host.children.ownTurn(sessionId, orchestratorId, true)
        try {
          await host.send(sessionId, text, undefined, {
            sessionId: orchestratorId,
            name: orch?.name ?? 'Orchestrator',
          })
        } catch (e) {
          if (atRest) host.children.releaseTurn(sessionId, orchestratorId)
          throw e
        }
        const held = host.children.awaitingReport.get(sessionId)
        if (atRest) {
          // Only comes back when asked for — silent by default
          if (reportBack) host.children.markReport(sessionId, orchestratorId)
          // Instructing again without asking for a report clears this orchestrator's earlier request — the
          // new instruction replaces it (#166)
          else if (held === orchestratorId) host.children.clearReport(sessionId)
          return { ok: true }
        }
        /*
         * A note (#1233): words into a turn already running, which is still the same work. It never drops a report
         * someone is owed of that turn, this seat's own included: a bare note after a reportBack (or after
         * create_session's first message) used to clear it, and the end went unheard. With `reportBack` it adds this
         * seat's mark only where nobody's stands: one mark per session, and taking another's would leave them untold.
         */
        if (reportBack && held === undefined) host.children.markReport(sessionId, orchestratorId)
        const reportTaken = !!reportBack && held !== undefined && held !== orchestratorId
        return { ok: true, busy: { state: 'noted' as const, sessionId, sessionName: target.name, ...(reportTaken ? { reportTaken: true as const } : {}) } }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
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

    // A new project (#515) — made only once the person approves the card this raises in the orchestrator's own slot
    createProject: async (spec, signal) => {
      const reader = linked()
      if (spec.machine && reader) {
        const machine = reader.machineNamed(spec.machine)
        if (machine) return host.createProjectOnMachine(orchestratorId, reader, machine, { name: spec.name, parent: spec.parent, source: spec.source }, signal)
        if (!/^this computer$/i.test(spec.machine.trim())) return { ok: false, error: `No linked machine is called ${spec.machine}; leave machine out for this computer` }
      } else if (spec.machine && !/^this computer$/i.test(spec.machine.trim())) {
        return { ok: false, error: 'No machine is linked to this computer; leave machine out' }
      }
      return host.createProjectAsked(orchestratorId, { name: spec.name, parent: spec.parent, source: spec.source }, signal)
    },

    /*
     * An existing folder as a project (#1220), made only once the person allows the card this raises in the
     * orchestrator's own slot. The central orchestrator's alone, as the linked machines are; `machine` is resolved as
     * create_project resolves it.
     */
    addProject: async (spec, signal) => {
      if (!central) return { ok: false, error: 'Only the orchestrator adds projects' }
      const reader = linked()
      if (spec.machine && reader) {
        const machine = reader.machineNamed(spec.machine)
        if (machine) return host.addFolderOnMachine(orchestratorId, reader, machine, spec.path, signal)
        if (!/^this computer$/i.test(spec.machine.trim())) return { ok: false, error: `No linked machine is called ${spec.machine}; list_machines names them, and leaving machine out means this computer` }
      } else if (spec.machine && !/^this computer$/i.test(spec.machine.trim())) {
        return { ok: false, error: 'No machine is linked to this computer; leave machine out' }
      }
      return host.addFolderAsked(orchestratorId, spec.path, signal)
    },

    // The linked machines (#1220): the list Settings shows, read only; the central orchestrator's alone
    listMachines: () => (central ? host.machineList() : []),

    // Changes to the linked machines (#1219), behind the person's card where they change a machine or this computer's reach
    machine: async (req, signal) => (central ? host.machineRequest(orchestratorId, req, signal) : { ok: false, error: 'Only the orchestrator changes linked machines' }),

    /*
     * A handoff (#694): the central orchestrator's alone (the profile gives it no other seat; checked here too, as this
     * object also serves a lead's and a reader's view), a session of this computer in its view. The rest of the rule
     * (which sessions, mid-turn, the person's card) is HandoffFlow's.
     */
    handoffSession: async (spec, signal) => {
      if (!central) {
        console.error(`[agent-host] handoff_session by ${orchestratorId.slice(0, 8)} refused: not the central orchestrator`)
        return { ok: false, error: 'Only the orchestrator hands sessions off' }
      }
      // Waiting on a run a "still running" answer named: its own runs only (`HandoffFlow.wait`)
      if (spec.waitFor) return host.handoffWait(orchestratorId, spec.waitFor, signal)
      if (!spec.sessionId) return { ok: false, error: 'Give sessionId: the session to hand off, from list_sessions.' }
      const id = spec.sessionId
      // Every refusal is logged with who asked and for which session, as the flow's are (#694 review)
      const refuse = (error: string) => {
        console.error(`[agent-host] handoff_session by ${orchestratorId.slice(0, 8)} of ${id.slice(0, 8)} refused: ${error}`)
        return { ok: false as const, error }
      }
      if (id === orchestratorId) return refuse('An orchestrator does not hand itself off; the person does that.')
      if (remoteOf(id)) return refuse('That session runs on a linked machine; hand it off there.')
      const target = host.meta.get(id)
      if (!target || !inScope(target)) return refuse(scopeError(id))
      return host.handoff(orchestratorId, target, { ...(spec.tool ? { tool: spec.tool } : {}), ...(spec.mode ? { mode: spec.mode } : {}), ...(spec.instructions ? { instructions: spec.instructions } : {}) }, signal)
    },

    // Checks its own app (C-3) — which app it is is decided by the calling session. Refused if it is not a
    // builder session (the directory has changed)
    checkApp: async () => {
      const self = host.meta.get(orchestratorId)
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
        const refused = await host.askAppProject(orchestratorId, { id: spec.id, ...(spec.parent ? { parent: spec.parent } : {}) }, signal)
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

    // On-demand app attachment: a project session's (#371 part A, readerToolsFor) and the central orchestrator's (#1205,
    // SessionTools.orchestratorToolsFor); a coordinator's scope has none
    findApps: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
    attachApp: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
    detachApp: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
  }
}
