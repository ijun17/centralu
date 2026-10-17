import { blockedOnQuestion, type Attachment, type ExternalAppInfo, type GitSource, type NormalizedEvent, type PermissionPreset, type SessionInfo, type SettingsApplied, type ToolName, type UpdateStatus } from '@cc/protocol'
import type { BusyAnswer, BusyChoice, ChildRunResult, HandoffResult, LinkedSessions, OrchestratedSession, OrchestratorTools, RecallHit, RoutedCard } from '../adapters/contract.js'
import type { AppCheckReport, AppRef } from '../apps/external/runtime.js'
import type { QueuedRequest, Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { presetWithin } from './start-agent.js'
import type { ChildOwnership, LinkedReport } from './child-ownership.js'
import type { OrchestratorProposals } from './orchestrator-proposals.js'
import { dedupeNearbyHits, takeInTurns, windowAround } from './snippet.js'
import { authorOf, contextAt, labelOf, lastActiveOf, previewOf, timeOf } from './transcript-view.js'

/**
 * What the orchestrator tools reach of the session manager (#428): its sessions and store, who owns whose work, and
 * the manager's own operations they call. The manager hands itself over through this (`SessionManager.seat`), so the
 * tools stay one function over a narrow surface rather than a method that sees the whole class.
 */
export type OrchestratorSeatHost = {
  /** Read when a tool runs, as every field here: the manager may replace what it holds (`reorderSessions` and `meta`) */
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
  createProjectOnMachine(
    sessionId: string,
    reader: LinkedSessions,
    machine: { id: string; name: string },
    spec: { name: string; parent?: string; source?: GitSource },
    signal?: AbortSignal,
  ): Promise<{ ok: true; projectId: string; name: string; path: string; machine: string } | { ok: false; error: string }>
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
  const projects = () => new Map(host.store.listProjects().map((p) => [p.id, p.name]))
  /*
   * The central orchestrator alone reads the linked machines too (#82 phase 4): a lead and an ordinary
   * session each have a view inside one machine. Asked when the call runs, as the links are wired after a session
   * may already have started.
   */
  const central = scopeIds === undefined && !ownProject && !hubView
  const linked = () => (central ? host.linkedReader() : null)
  /** The links, when this id names a linked machine's session and this seat reaches the machines */
  const remoteOf = (id: string) => {
    const reader = linked()
    return reader?.machineOf(id) ? reader : null
  }
  /*
   * The reader's view (#320) is its own project, read when the call runs. A session with no project
   * sees nothing: `null === null` must not become "every session without a project".
   */
  const ownProjectId = () => host.meta.get(orchestratorId)?.projectId ?? null
  const inScope = (s: SessionInfo) =>
    // Coordinator session (#80, #81): the allow list is its entire view
    scopeIds !== undefined ? scopeIds.includes(s.id)
    : ownProject ? (ownProjectId() !== null && s.projectId === ownProjectId())
    // What a hub's window shows of this host: never its orchestrator or coordinators (remote-hub.md §3.4)
    : hubView ? s.kind !== 'orchestrator' && s.kind !== 'coordinator'
    : true
  const scopeError = (id: string) =>
    scopeIds !== undefined ? `Not a member of this coordinating session: ${id}`
    : ownProject ? `Not a session in this project: ${id}`
    : hubView ? `Not a session this machine shares: ${id}`
    : `Not a session this app manages: ${id}`

  return {
    updateCentralu: async (action, signal) => host.updateCentraluAsked(orchestratorId, action, signal),
    listSessions: async () => {
      const byId = projects()
      const mine: OrchestratedSession[] = [...host.meta.values()]
        // Excludes itself — instructing itself would create a loop
        .filter((s) => s.id !== orchestratorId && inScope(s))
        .map((s) => ({
          sessionId: s.id,
          name: labelOf(host.store, s),
          project: s.projectId ? (byId.get(s.projectId) ?? '(project no longer exists)') : '(none)',
          state: s.state,
          ...(blockedOnQuestion(s) ? { waitingOn: 'question' as const } : {}),
          ...(s.worktreeMerged ? { merged: true } : {}),
          // PR status (#76, stage 3) — what lets a manager tell "waiting on review" apart from "just still
          // in progress"
          ...(s.worktreePr ? { pr: { number: s.worktreePr.number, state: s.worktreePr.state } } : {}),
          tool: s.tool,
          preview: previewOf(host.store, s.id),
          lastActive: lastActiveOf(host.store, s.id),
          ...(s.interruption ? { interruption: s.interruption } : {}),
        }))
      const reader = linked()
      return reader ? [...mine, ...(await reader.list())] : mine
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
      const all = host.store.listProjects()
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
      if (reader && remote[0]) {
        const r = await reader.createSession(remote[0], { tool: opts.tool, name: opts.name, preset })
        if (!r.ok) return r
        if (opts.firstMessage) {
          const sent = await reader.send(r.sessionId, opts.firstMessage, sender.name)
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
        if (opts.firstMessage) await host.send(info.id, opts.firstMessage, undefined, sender)
        return { ok: true, sessionId: info.id, name: host.meta.get(info.id)?.name ?? info.name }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },

    recall: async (query, limit = 12) => {
      const byId = projects()
      // Fetches generously, dedupes overlapping hits, then trims — trimming before dedupe would let `limit`
      // get eaten by duplicates
      const raw = host.store.searchMessages(query, limit * 12)
      const mine = raw.filter((h) => {
        const s = host.meta.get(h.sessionId)
        // Excludes the orchestrator's own words — tracing back from something it said itself would just be
        // an echo
        return s && s.id !== orchestratorId && inScope(s)
      })
      const out: RecallHit[] = []
      // Asked at once, while this host's own search runs: each machine is a round trip
      const remote = linked()?.recall(query, limit)
      for (const h of dedupeNearbyHits(mine)) {
        const s = host.meta.get(h.sessionId)!
        out.push({
          sessionId: s.id,
          session: labelOf(host.store, s),
          project: s.projectId ? (byId.get(s.projectId) ?? '(project no longer exists)') : '(none)',
          // Cut from **the surrounding conversation**, not a single delta chunk (a chunk alone says
          // nothing)
          snippet: windowAround(contextAt(host.store, s.id, h.seq) || h.body, query, 160),
          seq: h.seq, // Passed as `around` to read_session, it jumps straight to that spot
          at: timeOf(host.store, h.sessionId, h.seq),
        })
        if (out.length >= limit) break
      }
      if (!remote) return { hits: out }
      /*
       * Each machine's hits in its own rank, taken in turns with this host's (#82 phase 4): ranks from two stores
       * do not compare, and appending would let the first source fill the limit before another is heard
       */
      const { hits, notSearched } = await remote
      return { hits: takeInTurns([out, ...hits], limit), ...(notSearched.length ? { notSearched } : {}) }
    },

    readSession: async (sessionId, limit = 40, opts) => {
      // The scope check follows the same rule as sendToSession — only a session within its own scope
      if (sessionId === orchestratorId) return { ok: false, error: 'Does not read itself' }
      // A linked machine's session is read there, by the machine that holds it (#82 phase 4)
      const reader = linked()
      if (reader?.machineOf(sessionId)) return reader.read(sessionId, limit, opts)
      const target = host.meta.get(sessionId)
      if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }

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
      const rows = around
        ? [
            ...host.store.loadMessages(sessionId, limit, around + 1),
            ...host.store.loadMessagesFrom(sessionId, around, limit),
          ]
        : host.store.loadMessages(sessionId, limit * 2)

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
    // The same for starting agents (#561): these seats create and direct sessions with their own tools
    startAgent: async () => ({ ok: false, error: 'Only an ordinary project session can start agents this way' }),
    agentSession: async () => ({ ok: false, error: 'Only an ordinary project session can start agents this way' }),
    listAgents: async () => ({ ok: false, error: 'Only an ordinary project session can start agents this way' }),

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
      if (remote) {
        /*
         * A linked machine's session (#82 phase 4): delivered there as an instruction from this orchestrator, under
         * that session's own approval settings. The report is watched for before the send, since the machine's first
         * events can reach this hub before its answer does. While the send is out, the session's events go to the new
         * wait, a turn end included: the new instruction's turn is what the orchestrator asked about. An earlier report
         * paused over its own work (#723) is replaced by it, as a new task ends a pause here; if the send fails it is
         * put back, and its settle wait starts again from the work as the hub knows it now. A turn end of the old work
         * that came in that moment went to the new wait and is not told again.
         */
        const earlier = host.children.linkedReports.get(sessionId)
        const mine = reportBack ? { orchestratorId, busy: false } : undefined
        if (mine) host.children.setLinkedReport(sessionId, mine)
        const r = await remote.send(sessionId, text, host.meta.get(orchestratorId)?.name ?? 'Orchestrator')
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
        // As here (#166): a new instruction without a report replaces this orchestrator's earlier request
        if (!reportBack && earlier?.orchestratorId === orchestratorId && current === earlier) host.children.dropLinkedReport(sessionId)
        return { ok: true }
      }
      const target = host.meta.get(sessionId)
      if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }
      /*
       * Busy with a turn that is not this seat's (#677): this seat chooses. A note goes in as before (auto only,
       * #606); a queue holds it for a new turn when the running one ends; a fork copies the session's conversation
       * into a sub-session. Each tells this seat when its turn ends. Without `ifBusy`, nothing is sent.
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
        // Only comes back when asked for — silent by default
        if (reportBack) host.children.markReport(sessionId, orchestratorId)
        // Instructing again without asking for a report clears this orchestrator's earlier request — the
        // new instruction replaces it (#166)
        else if (host.children.awaitingReport.get(sessionId) === orchestratorId) host.children.clearReport(sessionId)
        return { ok: true, ...(atRest ? {} : { busy: { state: 'noted' as const, sessionId, sessionName: target.name } }) }
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
    createApp: async (spec) => {
      let projectId: string | null = null
      if (spec.project) {
        const project = host.store.listProjects().find((p) => p.id === spec.project || p.name === spec.project)
        if (!project) return { ok: false, error: `No such project: ${spec.project}` }
        projectId = project.id
      }
      try {
        const { app, builder, builderError } = await host.createApp({ projectId, id: spec.id, name: spec.name, description: spec.description, tool: spec.tool })
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

    // On-demand app attachment is a project session's (#371 part A, readerToolsFor) — no profile here exposes it
    findApps: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
    attachApp: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
    detachApp: async () => ({ ok: false, error: 'Only a session in a project attaches apps this way' }),
  }
}
