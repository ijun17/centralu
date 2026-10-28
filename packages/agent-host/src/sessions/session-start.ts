import { scriptMessageFrame } from './script-messages.js'
import { unfitError } from './tool-fit.js'
import { randomUUID } from 'node:crypto'
import type { BackgroundTask, CreateSessionParams, SessionInfo, ToolName } from '@cc/protocol'
import { autoCompactPlan } from './auto-compact.js'
import { autoCompactOf, launchRefusal, sessionLiveDefaults } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, CreateSessionOpts, EventSink, OrchestratorTools, ProcessSource, RequestTurn, SessionApps, SessionHandle } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import type { AppRef } from '../apps/external/runtime.js'
import type { Worktree } from '../dev-services/git-worktree.js'
import { writeHandoffNoteSync } from '../dev-services/handoff-notes.js'
import { rpcError } from '../rpc-error.js'
import { agentDepthKey } from './agent-depth.js'
import { presetFromHub, startedFromHubKey } from './hub-preset.js'
import { adoptOpenedSettings } from './opened-settings.js'
import type { AppSessions } from './app-sessions.js'
import type { CardRests } from './card-rest.js'
import type { DelegationHost } from './delegation-flow.js'
import { truncate, type ExternalConversations } from './external-conversations.js'
import { movedChildrenNote, type HandoffChildren } from './handoff-children.js'
import { shiftPartLines } from './handoff-record.js'
import { commandsSentence } from './tool-seats.js'
import type { HandoffNotes } from './handoff-notes.js'
import type { HostCardsHost } from './host-cards.js'
import type { LaunchRecords, LaunchRecordsHost } from './launch-records.js'
import { orchestratorRole } from './orchestrator-home.js'
import type { QueuedRequestsHost } from './queued-requests.js'
import type { RestartHost } from './restart-policy.js'
import type { SessionAppWiring } from './session-app-wiring.js'
import type { SessionRecordHost } from './session-record.js'
import type { SessionTools } from './session-tools.js'
import type { SessionTrashHost } from './session-trash.js'
import type { ToolQueries } from './tool-queries.js'
import { codeIntelligenceKey, codeIntelligenceOff } from './tool-profiles.js'
import { withTimeout } from './with-timeout.js'
import { worktreeSetupNotice, type WorktreeSessions } from './worktree-sessions.js'

/**
 * Where the marker "conversation up to here belongs to the old tool" is stored.
 *
 * Why this does not get its own column on the session row: it is not a property of the session
 * but **an event that happened on this install**, and it loses its meaning the moment the new
 * tool says its first word (from then on, externalId has the answer). app_settings is where a
 * value like that lives.
 */
export const freshStartKey = (sessionId: string) => `fresh_start:${sessionId}`

/**
 * What we may honestly say when the tool has no record of a conversation.
 *
 * This used to read "This conversation was deleted in Claude Code". Nobody ever observed a
 * deletion. The tool only answered "not in this directory" — and it keys its session store
 * **by working directory**, so it says that whenever the folder moves too. That is what
 * happened (issue #28): renaming the data directory moved the orchestrator's cwd, the tool
 * looked under a slug that had never existed, and the app told its owner that 924 messages
 * and an 821KB transcript — both still sitting on disk — had been deleted.
 *
 * So: report the observation, name the directory we looked in, and offer the two causes we
 * cannot tell apart from here. Claiming a deletion we did not witness reads as data loss,
 * and a person who believes their data is gone stops looking for it.
 */
function externalMissingReason(label: string, cwd: string): string {
  return (
    `${label} has no record of this conversation under ${cwd} — either it was removed there, ` +
    `or this folder has moved since the session started. The history kept here is still readable, ` +
    `and you can continue in a new session`
  )
}

/**
 * What starting a session's process reaches of the session manager (#428), typed as the manager declares each member.
 * The manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type SessionStartsHost = Pick<DelegationHost, 'adapters' | 'children' | 'cwdFor' | 'emit' | 'handles' | 'meta' | 'onEvent' | 'running' | 'store' | 'toolProfileOf' | 'uiPreferences'> &
  Pick<SessionRecordHost, 'cacheLedger' | 'modelWindows'> &
  Pick<SessionTrashHost, 'record' | 'restartPolicy'> &
  Pick<RestartHost, 'lettingGo'> &
  Pick<HostCardsHost, 'settleState'> &
  Pick<LaunchRecordsHost, 'settingFilesFor'> &
  Pick<QueuedRequestsHost, 'projectRow'> & {
    readonly appSessions: AppSessions
    readonly apps: SessionAppWiring
    readonly cardRests: CardRests
    /** The host's address and one session's bridge credential, once the host listens */
    readonly endpoint: ((sessionId: string) => { url: string; token: string } | null) | undefined
    readonly externals: ExternalConversations
    /** The event sink handed to an adapter, carrying which handle sent each event (#157) */
    handleSink: () => { sink: EventSink; own: (h: SessionHandle) => void }
    readonly handoffChildren: HandoffChildren
    readonly handoffNotes: HandoffNotes
    /** Where agent processes live when not with this host (the keeper, #280 step 2) */
    readonly keeperOpts: { processes?: { spawn(sessionId: string, tool: ToolName, spec: AgentSpawnSpec, version?: string): AgentProcess } }
    readonly launches: LaunchRecords
    /** Session waiting for a wake to finish so it can be deleted or switched -> the reason (#163) */
    readonly leaving: Map<string, string>
    listCommands: ToolQueries['listCommands']
    /** Whether another project handed this path back to the session (#371 part B) */
    mayRead: (sessionId: string, path: string, cwd: string) => boolean
    /** The orchestrator's turn being a session's request, and the person's card for the CLI's own steps in it (§9.7, #1447) */
    requestTurn: (sessionId: string) => RequestTurn
    /** A new conversation of the orchestrator begins: what an earlier one read is not in it (`AskedGate.beginConversation`) */
    newConversation: (sessionId: string, fresh: boolean) => void
    /** A session's row that is not being removed, or `session_not_found` */
    openSession: (sessionId: string) => SessionInfo
    /** The orchestrator's memory handoff for a new process */
    orchestratorMemory: (sessionId: string) => string
    /** The remembered approval rules for a session's process */
    rulesFor: (sessionId: string, projectId: string | null) => string[]
    /** The orchestrator's approved skills, as its role text names them (#71) */
    skillsPrompt: () => string
    toolLabel: (tool: ToolName) => string
    readonly tools: SessionTools
    /** The installed version of a tool as last read (#297), or null */
    readonly versionHint: ((tool: ToolName) => string | null) | null
    readonly worktrees: WorktreeSessions
  }

/**
 * A session's process brought up: a new session (`createSession`), or a wake of a stored one (`doResumeSession`), with
 * the options both launch with and the keeper as their process source. Moved out of the session manager as it was
 * (#428); what it reaches of the manager is `SessionStartsHost`.
 */
export class SessionStarts {
  constructor(private readonly host: SessionStartsHost) {}

  /**
   * Creates a session.
   *
   * Why projectId is `string | null`: the orchestrator does not belong to a project. The RPC
   * contract (CreateSessionParams) still requires a project, so outside callers can never send
   * null — the only place that can create a session with no project is `orchestrator()` below.
   */
  async createSession(
    params: Omit<CreateSessionParams, 'projectId' | 'tool'> & {
      projectId: string | null
      /** Internal default resolution can find no tool; reject that only when creating a session. */
      tool: ToolName | null
      /**
       * Role (#13). Not in the RPC contract — an outside caller can never "create" an orchestrator
       * (orchestrator() is the only path), and this field exists so orchestrator() has something to
       * fill when creating its own session.
       */
      kind?: Exclude<SessionInfo['kind'], 'coordinator'>
      /**
       * Who sent `initialPrompt`, when it is not the person (#694: the orchestrator's handoff_session). Not in the RPC
       * contract: a window's first message is the person's. Stored and broadcast as that sender's, as `send`'s `from`.
       */
      initialFrom?: { sessionId: string; name: string }
      /**
       * A script or the RPC started the session (the connection holds the limited credential, not the window's token): the work is the person's, written
       * down in the mailbox before the first message goes in, and the turn it starts is reported to their Inbox (§8.1). The message is the script's, not
       * the person's: stored and shown as such, and the session reads it under a header of Centralu's (`scriptMessageFrame`). `credential` is the
       * connection's label (`scriptLabel`). Not in the RPC contract: the host sets it from the connection
       */
      fromScript?: { credential: string }
      /**
       * Role text pinned on the row and reapplied on every wake — filled only by `createAppBuilder`. A coordinator's
       * role rode here too; nothing creates a coordinator since the control app went (#372), and one already in a
       * store wakes through `resumeSession` with its own row.
       */
      roleAppend?: string
      /** The app that created this session (#81). Filled by the host's own paths for an app (builder, `run_agent`),
       * never by the app itself */
      appId?: string | null
      /**
       * This session is that app's **builder session** (M4 C-2) — filled only by `createAppBuilder`.
       * Written **before** the adapter is launched: the app to attach and the tool bundle (C-3) see
       * this relationship the moment they launch it.
       */
      builderOf?: AppRef
      /**
       * This is an agent session an app asked for (M4 D-1) — filled only by `runAppAgent`. Loads the
       * answer schema into the adapter (`outputSchema`) and does not change the project's default
       * tool: the tool the app picked is not the person's choice.
       */
      appAgent?: { outputSchema?: Record<string, unknown> }
      /** The same-project session that started this agent (#561). */
      askedBy?: string
      /** The session whose conversation this one is a copy of (#677, a fork of a busy session) */
      forkedFrom?: string
      /** start_agent's choice of code intelligence for its child (#686); absent: a child starts without it */
      lsp?: boolean
      /** What the new worktree's setup could not do (#841 item 3), for a caller that tells the agent; the person gets a notice */
      onSetupProblems?: (problems: string[]) => void
      /** Where the new worktree forked from (#1484), as a sentence naming the commit and what could not be done to make it current */
      onWorktreeBase?: (note: string) => void
    },
  ): Promise<SessionInfo> {
    if (params.askedBy && this.host.meta.get(params.askedBy)?.projectId !== params.projectId) {
      throw new Error('A session cannot create a session in another project')
    }
    /*
     * A handoff comes from a live session of the same project (#1487): its marker is the evidence a lineage is read from, and
     * the children it moves and the note it names are that session's. The original is still live here, since the window and
     * handoff_session archive it after the successor exists; a linked machine's id is stripped before it gets here.
     */
    const original = params.handoff?.fromSessionId
    if (original && (!params.projectId || this.host.meta.get(original)?.projectId !== params.projectId)) {
      throw rpcError('A handoff comes from a live session of the same project')
    }
    if (!params.tool) {
      throw rpcError('No agent adapter is available. Install and configure an agent CLI before creating a session.', 'tool_not_installed')
    }
    const adapter = this.host.adapters.get(params.tool)
    if (!adapter) throw rpcError(`Unknown tool: ${params.tool}`, 'tool_not_installed')

    if (params.resumeExternalId) {
      const holder = this.host.externals.holderOf(params.resumeExternalId)
      if (holder) {
        throw rpcError(`This conversation is already open in the "${holder.name}" session — continue there`)
      }
    }

    const id = randomUUID()
    // Started from a linked computer (#1273): `auto` there only as this computer's switch allows, read at this start
    const permissionPreset = presetFromHub(params, this.host.uiPreferences())

    /*
     * Worktree session (FR-2 option). Created **before the adapter is launched** — it has to be
     * passed in as cwd.
     *
     * If it fails, session creation stops entirely. Quietly falling back to the original directory
     * would make the person think they are isolated while both sessions actually touch the same
     * files — the exact thing this feature exists to prevent.
     */
    let worktree: Worktree | null = null
    let setupProblems: string[] = []
    if (params.worktree && params.projectId) {
      let base: { note: string }
      ;({ worktree, setupProblems, base } = await this.host.worktrees.createWorktree({ ...params, projectId: params.projectId }, id))
      // Where it forked from (#1484): the start answer names the base commit
      params.onWorktreeBase?.(base.note)
    }

    /*
     * Session name = branch name (#69). Conductor assigns each workspace a "unique city name",
     * which says nothing at all about what the branch does — the branch name is the only
     * meaning-carrying identifier for the person to read.
     *
     * If the person set the branch, that name is **fixed permanently** (autoNamed=false — an
     * auto-name never overwrites it). If they did not, the name **starts out** as the auto-generated
     * branch (`centralu/…`) but keeps its auto-name eligibility: this slot used to just say 'New
     * session', and with several sessions in the worktree panel there was no way to tell from the
     * screen which was which branch (dogfooding, 2026-09-07). Once the first message arrives, a
     * meaningful name takes that slot's place.
     */
    const namedByBranch = worktree && params.worktreeBranch ? worktree.branch : null
    const info: SessionInfo = {
      id, projectId: params.projectId, kind: params.kind ?? 'worker', tool: params.tool, externalId: null,
      scopeSessionIds: null, roleAppend: params.roleAppend ?? null,
      appId: params.appId ?? null,
      ...(params.askedBy ? { askedBy: params.askedBy } : {}),
      name:
        namedByBranch ??
        // Not named from a script's message (§8.1): the person's own words name a session
        (params.initialPrompt && !params.fromScript ? truncate(params.initialPrompt) : (worktree?.branch ?? 'New session')),
      autoNamed: !namedByBranch, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true,
      model: params.model ?? null, effort: params.effort ?? null,
      verbosity: params.verbosity ?? null,
      serviceTier: params.serviceTier ?? null,
      permissionPreset,
      importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
      worktree,
      /*
       * A worktree session hangs in the sidebar under the session that started it with start_agent (#561); one the
       * person makes stands on its own. It used to hang under the project's worktree manager, made for it if there
       * was none (#69); that role was folded into ordinary sessions (#561 part 3).
       */
      parentSessionId: worktree && params.askedBy ? params.askedBy : null,
      ...(params.forkedFrom ? { forkedFrom: params.forkedFrom } : {}),
      ...(params.fromHub ? { startedFromHub: true } : {}),
      ...sessionLiveDefaults(),
      // Started from what is installed now, until the process says (#297)
      agentVersion: this.host.versionHint?.(params.tool) ?? null,
    }
    /*
     * The directory this session starts in. Remembered below, not derived again later —
     * the tool files the conversation under this exact path, so this is the only path that
     * can ever find it again (issue #28).
     */
    const cwd = worktree?.path ?? params.cwd

    // **Saved only after the adapter succeeds.** Saving first would leave a "ghost session" in the
    // DB when the adapter fails — visible in the list but impossible to address (confirmed with a
    // measurement).
    let handle: SessionHandle
    let apps: SessionApps | undefined
    let noCodeIntelligence = false
    this.host.record.unborn.set(id, [])
    // Everything from here until the session is saved is inside the cleanup below: a throw before the adapter starts
    // left the new worktree with no session pointing at it (#774)
    try {
      if (params.builderOf) this.host.appSessions.setBuilder(params.builderOf, id)
      // External apps (M4 A-5) — a worker gets these too. If the handle never comes up, the catch below closes
      // it
      apps = this.host.apps.appsFor(info)
      // The same rule runs again on every wake (toolProfileOf). The builder slot was just written (setBuilder), so the
      // flag says what the row's slot already says
      const { profile, tools } = this.host.tools.toolChoice(info, !!params.builderOf)
      // Code intelligence (#686): decided once, here, from what the session is, and recorded below for every wake
      noCodeIntelligence = codeIntelligenceOff({
        kind: info.kind,
        appId: info.appId ?? null,
        builder: !!params.builderOf,
        askedBy: info.askedBy ?? null,
        forkedFrom: info.forkedFrom ?? null,
        ...(params.lsp !== undefined ? { lsp: params.lsp } : {}),
      })
      const from = this.host.handleSink()
      handle = await startFit(
        adapter,
        this.launchOptions(info, {
          tool: params.tool, cwd, model: params.model, effort: params.effort,
          verbosity: params.verbosity,
          serviceTier: params.serviceTier,
          permissionPreset, resumeExternalId: params.resumeExternalId,
          noCodeIntelligence,
          inheritsHandoff: !!params.handoff?.fromSessionId,
          choice: { profile, tools },
          apps,
          memory: false,
          // The answer schema an app supplied when it asked for this (M4 D-1) — Claude gets it on this
          // session's query, Codex gets it on every turn of this session
          ...(params.appAgent?.outputSchema ? { outputSchema: params.appAgent.outputSchema } : {}),
        }),
        from.sink,
      )
      from.own(handle)
      // The host began leaving while it came up (#839): its handles are let go of, so this one is stopped here
      if (this.host.lettingGo) {
        await handle.dispose().catch(() => {})
        throw new Error('Centralu is restarting or quitting')
      }
    } catch (err) {
      this.host.record.unborn.delete(id)
      this.host.modelWindows.forget(id)
      apps?.close()
      // A session that never came up is not a builder session — clear the slot the app points at
      if (params.builderOf) this.host.appSessions.setBuilder(params.builderOf, null, id)
      // If the adapter fails, nobody will ever use the worktree just created — do not leave an
      // orphaned directory behind. (A session that fails here is never even saved, so there is no
      // way to recover it later if it is not cleaned up now.)
      /*
       * The branch is deleted along with it (#167). It was created together with the worktree via
       * `-b`, so deleting only the directory would block re-creating one under the same name with
       * "already exists", and if no name was ever set, a fresh `centralu/…` piled up on every
       * failure. Since `-b` fails if the name already exists, any branch that got this far was just
       * created by this call, and has not a single commit on it. What could not be removed is said
       * (#841): swallowed, the next start under the same name failed with "already exists" and no cause.
       */
      const left = worktree && params.projectId ? await this.host.worktrees.discardNewWorktree(params.cwd, worktree, params.projectId) : null
      const msg = (err as Error).message
      // What the person can act on keeps its code (a tool not signed in: its line offers Sign in, review of #1685)
      const code: unknown = Reflect.get(Object(err), 'code')
      const kept = code === 'not_logged_in' || code === 'tool_not_installed' ? code : 'internal'
      throw rpcError(`Could not start ${params.tool} session: ${msg}${left ? ` (${left})` : ''}`, kept)
    }

    // An imported conversation keeps the model it was started with: the record follows what runs (#1369), before it is saved
    adoptOpenedSettings(handle, info, { model: info.model, effort: info.effort }, !!params.resumeExternalId)
    this.host.meta.set(id, info)
    this.host.store.sessions.upsertSession(info)
    if (noCodeIntelligence) this.host.store.settings.setAppSetting(codeIntelligenceKey(id), 'off')
    // Started by another machine's session (#1038): that depth is this session's own, kept as one started here keeps its
    if (params.agentDepth) this.host.store.settings.setAppSetting(agentDepthKey(id), String(params.agentDepth))
    if (params.fromHub) this.host.store.settings.setAppSetting(startedFromHubKey(id), 'true')
    this.host.launches.rememberToolPrefix(id)
    this.host.launches.rememberLaunchSettings(info, cwd)
    this.host.store.sessions.setSessionCwd(id, cwd)
    /*
     * Lets the UI learn about this session **through an event too** (#69).
     *
     * Whichever side created it via RPC already knows from the response, but for a session the host
     * itself creates (the orchestrator's create_session, a manager created by worktree adoption),
     * this event is the only notification. Before this existed, that kind of session's event sat in
     * the pendingEvents holding area waiting for something to register it, and there was never
     * anything to register it — it only ever surfaced through listSessions after a reconnect. The
     * receiving side discards it (idempotently) if the session is already known.
     */
    this.host.emit({ type: 'session_created', sessionId: id, session: info })
    /*
     * **The tool picked most recently becomes this project's default.**
     *
     * default_tool was hardcoded to 'claude' at project creation and had no place that ever updated
     * it — someone using codex had to click the picker again for every single new session, forever.
     * Why this lives here instead of a settings screen: "what to use as the default" is **already
     * told to us by the act of creating a session.** So the UI and the orchestrator's create_session
     * both go through this same rule.
     */
    // The tool of an agent an app asked for (M4 D-1) is the app's choice — it never moves the person's
    // default
    if (params.projectId && !params.appAgent) {
      const owner = this.host.projectRow(params.projectId)
      if (owner && owner.defaultTool !== params.tool) {
        this.host.store.projects.setProjectDefaultTool(params.projectId, params.tool)
        this.host.emit({ type: 'projects_changed' })
      }
    }
    this.host.handles.set(id, handle)
    // A new process holds no background work yet (#648)
    this.host.launches.rememberBackgroundTasks(info)
    // The cache's first request (§6.1): a new conversation, or one taken over from outside in a new process
    this.host.cacheLedger.note(id, params.resumeExternalId ? 'new_process' : 'cold_start')
    this.host.running.set(id, {
      model: info.model,
      effort: info.effort,
      verbosity: info.verbosity,
      serviceTier: info.serviceTier,
      permissionPreset: info.permissionPreset,
    })
    handle.applyRules?.(this.host.rulesFor(id, params.projectId))
    // What the tool said while it was starting, now that the session exists to record it (see `unborn`)
    const early = this.host.record.unborn.get(id) ?? []
    this.host.record.unborn.delete(id)
    for (const e of early) this.host.onEvent(e)
    /*
     * What the worktree's setup could not do (#841 item 3), at the top of the new session: logged only, a `.env` that
     * never arrived was found by the agent's first failing command, and the person never learned why. A start_agent
     * caller also puts it in its child's task (`onSetupProblems`), as the agent does not read notices.
     */
    if (worktree && setupProblems.length) {
      this.host.onEvent({
        type: 'notice',
        sessionId: id,
        level: 'warning',
        from: 'Centralu',
        label: 'worktree setup',
        text: worktreeSetupNotice(setupProblems),
      })
      params.onSetupProblems?.(setupProblems)
    }

    // Restores past conversation. Done **after the adapter comes up** — a session with history but
    // no way to address it is just as bad as a ghost session.
    if (params.importHistory && params.resumeExternalId) {
      await this.host.externals.importHistory(info, adapter, params.resumeExternalId, params.cwd)
    }

    // The resume identifier is saved **immediately on creation.** Waiting for an event would mean
    // that if the host died before the first response, the session could never be resumed again (FR-10).
    if (handle.externalId) {
      info.externalId = handle.externalId
      this.host.store.sessions.upsertSession(info)
    }

    // Fetches skills ahead of time while the session is still alive.
    // Once it sleeps later there is no process to ask — this is prepared now for that moment.
    void this.host.listCommands(id).catch(() => {})

    /*
     * The first prompt is also **recorded under the same rule as send().**
     *
     * Just sending it to the adapter leaves the store without a first question — restarting would
     * produce a transcript that starts with an answer and nothing before it. The UI reconciles its
     * optimistic render against a user_message's seq, so this event is raised the same way send() does.
     */
    /*
     * A predecessor's note is **stamped as a marker** (#102).
     *
     * Back when the first message carried the note's full text, that text stayed in the conversation
     * on its own. Now that the first message only carries a path, leaving it at that would mean the
     * only original of what the agent wrote — unrecoverable once the predecessor is gone — exists in
     * a single file and nowhere else. It is stamped in the same slot, the same way, as a compaction
     * marker. The note itself does not ride along in the broadcast: what the screen draws is one
     * line, and the note is megabytes.
     */
    if (params.handoff) {
      const { from, fromSessionId } = params.handoff
      let { note } = params.handoff
      /*
       * The original's live children become this session's (#693), before its first turn reads the note: the note
       * opens with them, in the file the opening message points at and in the marker that keeps the note's original.
       * Nothing here awaits until the first message is sent, so a moved child's report cannot reach this session first.
       * When the window removes the original next (#738), every child moves, settled ones too, and the note lists them.
       */
      const moved = fromSessionId ? this.host.handoffChildren.moveChildren(fromSessionId, id, params.handoff.removesOriginal ? 'all' : 'live') : []
      if (moved.length) {
        const movedBlock = movedChildrenNote(moved, commandsSentence(this.host.toolProfileOf(id), ['agent_session']))
        // The record's table of parts names lines; they move down by the block put above them (#1481)
        note = movedBlock + shiftPartLines(note, movedBlock.split('\n').length - 1)
        try {
          if (fromSessionId && params.projectId) writeHandoffNoteSync(params.projectId, fromSessionId, note)
        } catch (e) {
          console.error(`[agent-host] handoff note not rewritten with the moved children: ${(e as Error).message}`)
        }
      }
      const seq = this.host.store.messages.nextSeq(id)
      this.host.store.messages.appendMessages([
        {
          sessionId: id,
          seq,
          role: 'system',
          kind: 'marker',
          // fromSessionId rides along too (#106) — it names the note file this session inherited,
          // and is the only way cleanup knows "this still has an owner"
          payload: { type: 'handoff', sessionId: id, seq, from, note, fromSessionId },
          ts: Date.now(),
        },
      ])
      info.lastSeq = seq
      this.host.emit({ type: 'handoff', sessionId: id, seq, from })
    }
    if (params.initialPrompt) {
      const seq = this.host.store.messages.nextSeq(id)
      const from = params.initialFrom
      this.host.store.messages.appendMessages([
        { sessionId: id, seq, role: 'user', kind: 'text', payload: { text: params.initialPrompt, ...(from ? { from } : {}), ...(params.fromScript ? { fromScript: params.fromScript } : {}) }, ts: Date.now() },
      ])
      info.lastSeq = seq
      info.lastReadSeq = seq // Something we sent counts as read
      this.host.store.sessions.upsertSession(info)
      this.host.emit({ type: 'user_message', sessionId: id, seq, text: params.initialPrompt, ...(from ? { from } : {}), ...(params.fromScript ? { fromScript: params.fromScript } : {}) })
      this.host.cardRests.turnAsked(id)
      // Never stamped: its only producer is a handoff, whose opening quotes a note written by an agent, not the person's typing
      if (params.fromScript) this.host.children.startedForPerson(id, params.initialPrompt, params.fromScript)
      // A script's message reaches the session framed as the script's, never stamped as the person's
      handle.send(params.fromScript ? scriptMessageFrame(params.fromScript.credential, params.initialPrompt) : params.initialPrompt)
    }
    return info
  }

  /**
   * `autoCompactTokens` for a session's launch (#1376): Centralu's setting at this moment over the model's window. For a tool
   * whose window reading follows the point it was started with, said to `ModelWindows`, so that reading is not taken for the
   * model's window; another tool's readings always count.
   */
  private autoCompactFor(m: SessionInfo, adopted: boolean): Pick<CreateSessionOpts, 'autoCompactTokens' | 'autoCompactCeiling'> {
    const { tokens } = autoCompactPlan(autoCompactOf(this.host.uiPreferences()), this.host.modelWindows, m)
    this.host.modelWindows.started(m.id, tokens === null ? null : (this.host.adapters.get(m.tool)?.windowCeilingFor?.(tokens) ?? null), adopted)
    // The point of the process before this one is not this one's: its first reading says the new (#1553)
    if (m.context?.compactAt !== undefined) {
      const { compactAt: _before, ...rest } = m.context
      m.context = rest
    }
    const kept = adopted ? this.host.modelWindows.ceilingOf(m.id) : null
    return { ...(tokens === null ? {} : { autoCompactTokens: tokens }), ...(kept === null ? {} : { autoCompactCeiling: kept }) }
  }

  /**
   * The options a session's process starts with (#428), the same for a new session (`createSession`) and a wake
   * (`doResumeSession`): what differs between the two is passed in, and the rest is read here, in the order both
   * used to read it. `memory`: the orchestrator's memory handoff rides along (a genuinely new process on a wake).
   */
  private launchOptions(
    m: SessionInfo,
    o: Pick<CreateSessionOpts, 'model' | 'effort' | 'verbosity' | 'serviceTier' | 'permissionPreset' | 'resumeExternalId' | 'knownGoal' | 'outputSchema'> & {
      tool: ToolName
      cwd: string
      adopt?: AgentProcess
      kept?: readonly BackgroundTask[] | null
      noCodeIntelligence: boolean
      inheritsHandoff: boolean
      choice: { profile: ToolProfile | null; tools: () => OrchestratorTools | undefined }
      apps: SessionApps | undefined
      memory: boolean
    },
  ): CreateSessionOpts {
    const { profile, tools } = o.choice
    // The past conversation handed over in the prompt when the tool changed (the person's words and the orchestrator's own answers)
    const past = m.kind === 'orchestrator' && o.memory ? this.host.orchestratorMemory(m.id) : ''
    // A conversation with nothing to resume is a new one, and one with nothing handed over is a clean one; a process taken over from an earlier host
    // or one resumed is the conversation it was; one that starts from a summary of an earlier conversation (whose answers may carry what it
    // read) is not known to have read nothing
    if (m.kind === 'orchestrator' && !o.resumeExternalId && !o.adopt) this.host.newConversation(m.id, past === '')
    return {
      sessionId: m.id,
      cwd: o.cwd,
      ...this.processSourceFor(m.id, o.tool, o.adopt, m.agentVersion, o.kept),
      model: o.model,
      effort: o.effort,
      verbosity: o.verbosity,
      serviceTier: o.serviceTier,
      // Where the agent compacts by itself (#1376), read at every start and wake: a change reaches a session when its process next starts
      ...this.autoCompactFor(m, !!o.adopt),
      permissionPreset: o.permissionPreset,
      resumeExternalId: o.resumeExternalId,
      runningCost: this.host.launches.runningCostFor(m.id, !!o.resumeExternalId),
      ...(o.knownGoal ? { knownGoal: o.knownGoal } : {}),
      // Which settings files reach this session (decision 3, #92, #152) — what the session is,
      // and the trust at this exact moment of launch. If this is a builder session, the
      // directory above already points at this session (setBuilder)
      /*
       * Trust is **re-read every time it wakes** (decision 3, #92). Even if trust is changed
       * while a session is running, the tool process already read its files and stays as it was
       * — it picks up the changed value the next time it comes up (restart, resume). What it
       * trusts is decided by the same check used at creation (settingFilesFor) — a session waking
       * as a manager and a builder session both get the same answer here.
       */
      ...this.host.settingFilesFor(m),
      ...(o.noCodeIntelligence ? { noCodeIntelligence: true } : {}),
      // Reads an inherited note without asking (#142). No marker exists yet — it is stamped once this
      // session comes up
      // An inherited note must still be readable after waking up (#142) — the first message still points
      // at that path
      ...this.host.handoffNotes.handoffReadDirs(m.projectId, o.inheritsHandoff),
      // Paths another project handed back to this session (#371), asked on every read
      mayRead: (path: string) => this.host.mayRead(m.id, path, o.cwd),
      ...(m.kind === 'orchestrator' ? { requestTurn: this.host.requestTurn(m.id) } : {}),
      // An orchestrator gets all of them, a builder session (M4 C-3) just its own app's check (the bundle blocks
      // the rest), an ordinary session its own project, read-only (#320, #561)
      /*
       * **Tool and role must carry over on resume too.**
       *
       * Attaching them only at creation would mean a freshly woken orchestrator becomes an
       * ordinary session with neither tools nor a role — sitting in an empty folder able to do
       * nothing, while looking perfectly fine on the outside, which is the worst possible state.
       *
       * And this is exactly **where a manager becomes real** (#69): a session whose first child
       * has just been attached passes this check the next time it wakes and receives the
       * child-only tools and role.
       */
      orchestratorTools: tools(),
      toolProfile: profile ?? undefined,
      /*
       * This is **where memory is handed over.** Switching tools breaks externalId, which routes
       * things down this path (a new process), and that is when the past conversation rides along
       * with it. A session that came in through resume already has the tool holding its context,
       * so the same text is never inserted twice.
       */
      systemPromptAppend:
        m.kind === 'orchestrator'
          ? // Skills (#71) always ride along; the memory handoff only for a genuinely new process
            // (unchanged rule)
            orchestratorRole() + this.host.skillsPrompt() + past
          : // A builder session's (M4 C-2) role is entirely the roleAppend fixed at creation
            // Reapplying the fixed role text — for a coordinator session an older build left (#372), and
            // for a builder session (C-2) even if the app is broken
            (m.roleAppend ?? undefined),
      // The path back to the host — used by the orchestrator tools' bridge and an external app's bridge
      // (M4 A-5)
      orchestratorBridge: profile || o.apps ? (this.host.endpoint?.(m.id) ?? undefined) : undefined,
      // An MCP server the person approved is loaded here as a user-folder app (M4 A-7, decision 4)
      // An approved MCP server is a user-folder app — an orchestrator receives those apps right here (M4
      // A-7)
      apps: o.apps,
      ...(o.outputSchema ? { outputSchema: o.outputSchema } : {}),
    }
  }

  /**
   * The keeper as a `ProcessSource` for one session, when this host runs under one (#280 step 2). `version` is the CLI
   * version a process spawned now is started from, written on its keeper tag (#297).
   */
  private processSourceFor(
    sessionId: string,
    tool: ToolName,
    adopt?: AgentProcess,
    version?: string | null,
    /** The background tasks the previous host last saw running in the adopted process (#648), if it kept a list */
    kept?: readonly BackgroundTask[] | null,
  ): { processSource?: ProcessSource } {
    const host = this.host.keeperOpts.processes
    if (!host) return {}
    return {
      processSource: {
        spawn: (spec) => host.spawn(sessionId, tool, spec, version ?? undefined),
        ...(adopt ? { adopt: { process: adopt, openCalls: this.openToolCalls(sessionId), backgroundTasks: kept ?? [] } } : {}),
      },
    }
  }

  /** Tool calls the store holds for this session with no result after them (the newest 200 rows) */
  private openToolCalls(sessionId: string): { callId: string; tool: string }[] {
    const open = new Map<string, string>()
    for (const r of this.host.store.messages.loadMessages(sessionId, 200)) {
      const p = r.payload as { callId?: unknown; summary?: { tool?: unknown } }
      if (typeof p?.callId !== 'string') continue
      if (r.kind === 'tool_call' && typeof p.summary?.tool === 'string') open.set(p.callId, p.summary.tool)
      else if (r.kind === 'tool_result') open.delete(p.callId)
    }
    return [...open].map(([callId, tool]) => ({ callId, tool }))
  }

  async doResumeSession(
    sessionId: string,
    adopt?: AgentProcess,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }> {
    const m = this.host.openSession(sessionId)

    // If it is already alive, use it as-is (never create a duplicate process); a kept process offered too is stopped (#839)
    if (this.host.handles.has(sessionId)) {
      adopt?.kill('SIGTERM')
      return { session: m, resumed: true }
    }

    const tool = m.tool
    const adapter = this.host.adapters.get(tool)
    if (!adapter) return { session: m, resumed: false, reason: `No adapter for ${m.tool}` }
    if (!adapter.capabilities.resume) return { session: m, resumed: false, reason: `${m.tool} does not support resume` }
    /*
     * Picks the identifier to resume from.
     *
     * **If there is no externalId, the resumed-from original (importedFrom) is used.**
     * Claude gives the external id asynchronously through system/init, so a session that only ever
     * loaded a conversation and was never actually addressed never gets that value filled in. But by
     * definition such a session **does have an original id** — and that is exactly what it should
     * resume from. (Measured: sessions existed with ext=null but from=c1a50932 and 95 messages.)
     */
    const resumeId = m.externalId ?? m.importedFrom

    // An adopted process is the conversation itself, whatever ids the store has for it
    if (!resumeId && !adopt) {
      /*
       * **Tells apart what was actually lost from what was deliberately left behind.**
       *
       * This guard treats "there is history but no resume id" as an accident and blocks it — and it
       * should. But switching tools produces exactly the same shape **on purpose** (a new tool
       * cannot resume an old conversation). So the boundary is recorded at that moment, and if
       * nothing has been exchanged since, launching a new one is judged to lose nothing.
       * (If messages were exchanged after the boundary, that is the new tool's conversation, and it
       * does have an externalId.)
       */
      const boundary = Number(this.host.store.settings.appSetting(freshStartKey(m.id)) ?? '-1')
      const newest = this.host.store.messages.loadMessages(m.id, 1)[0]
      if (newest && newest.seq > boundary) {
        return {
          session: m,
          resumed: false,
          reason: 'Lost this session\'s resume id — the history is still readable, and you can continue in a new session',
        }
      }
      // No messages were exchanged = launching a new one loses nothing
    }

    /*
     * **An orchestrator has no project.**
     *
     * Requiring a project here meant an orchestrator died forever every time the app was restarted
     * ("Could not resume the conversation: Project not found" — measured). It was, in effect, a
     * session that could only be created but never resumed.
     */
    const project = m.projectId === null ? null : this.host.projectRow(m.projectId)
    if (m.projectId !== null && !project) return { session: m, resumed: false, reason: 'Project not found' }
    const cwd = this.host.cwdFor(m)

    /*
     * Checks first whether this conversation was deleted on the tool's side.
     *
     * Just trying to resume it anyway brings the process up, but the first turn dies with
     * error_during_execution (measured). That message tells the person nothing about the cause.
     * Knowing in advance that it is gone lets us say what happened and what can be done about it.
     */
    // If two sessions try to hold the same conversation, the tool refuses — block it first and report who
    // holds it
    if (resumeId && !adopt) {
      const holder = this.host.externals.holderOf(resumeId, sessionId)
      if (holder) {
        return {
          session: m,
          resumed: false,
          reason: `The "${holder.name}" session already has this conversation open (two sessions cannot share one conversation)`,
          lockedElsewhere: true,
        }
      }
    }

    /*
     * Times each stage — **so a resume that succeeds but is slow still leaves a trace.**
     *
     * A timeout message only ever attaches to a failure. A resume that takes 9 seconds and succeeds
     * leaves nothing in the log at all, so when someone reported "waking up feels slow", the only
     * way to answer which stage ate the time was writing a fresh measurement script from scratch
     * (which is literally what happened during dogfooding). The single line below stays in host.log:
     * check (listing), start (process + resume), catch-up.
     */
    const t0 = Date.now()
    // A running process is proof enough that its conversation exists (and asking codex would start another app-server)
    const gone = adopt ? false : await this.host.externals.externalGone(m, cwd)
    const tCheck = Date.now() - t0
    if (gone) {
      return { session: m, resumed: false, reason: externalMissingReason(this.host.toolLabel(m.tool), cwd) }
    }

    // External apps (M4 A-5) — decision 4 is re-checked **right now** even on resume (an app could have come
    // or gone in between)
    const apps = this.host.apps.appsFor(m)
    // If this is a builder session, it gets its own app's check (C-3) — the directory is re-checked right now
    // (a different session could have taken over in between)
    const builds = this.host.appSessions.builderRefOf(m) !== null
    const { profile, tools } = this.host.tools.toolChoice(m, builds)
    const from = this.host.handleSink()
    /*
     * **The configuration the process will receive is read here, exactly once** (#162). If the
     * person changes settings while the process is being awaited below, `m` changes — if `running`
     * were filled by re-reading `m` after the wait, it would record the changed value instead of what
     * the process actually received, and updateSettings' comparison would never be able to detect the
     * mismatch (someone picks "safe" and it keeps running as "auto").
     */
    const launched = {
      model: m.model,
      effort: m.effort,
      verbosity: m.verbosity,
      serviceTier: m.serviceTier,
      permissionPreset: m.permissionPreset,
    }
    /*
     * The CLI version this process runs, until it says (#297): a new process starts from what is installed now. An
     * adopted one keeps the version its keeper tag gave (adoptKept) — it was started long before.
     */
    if (!adopt) m.agentVersion = this.host.versionHint?.(tool) ?? null
    // What the previous host saw running in the process this one adopts (#648); null when it kept no list
    const kept = adopt ? this.host.launches.keptBackgroundTasks(sessionId) : null
    try {
      const creating = startFit(
        adapter,
        this.launchOptions(m, {
          tool,
          cwd,
          adopt,
          kept,
          model: launched.model ?? undefined,
          effort: launched.effort ?? undefined,
          verbosity: launched.verbosity ?? undefined,
          serviceTier: launched.serviceTier ?? undefined,
          permissionPreset: launched.permissionPreset,
          resumeExternalId: resumeId ?? undefined,
          // The goal survives in the tool's conversation, not in a new one (see CreateSessionOpts.knownGoal)
          ...(resumeId && m.goal ? { knownGoal: m.goal } : {}),
          noCodeIntelligence: this.host.launches.codeIntelligenceOffFor(sessionId),
          inheritsHandoff: this.host.store.handoffs.inheritsHandoff(sessionId),
          choice: { profile, tools },
          apps,
          memory: !resumeId,
        }),
        from.sink,
      )
      /*
       * **This used to be an unbounded wait** — and that wait was holding this function's only
       * in-progress (resuming) promise. If the tool got stuck coming up, the outer RPC gave up at 30
       * seconds, but this promise never resolved, and because of dedup, Retry would **rejoin that
       * same stuck promise**. To the person it looked like "Retry does not work" (measured on a real
       * session).
       *
       * Why 150 seconds: it needs to stay inside resume-family RPCs' 180-second limit (LONG_CALLS in
       * rpc-client), so the screen gets a reason named for this stage instead of an unnamed RPC
       * timeout, and `resuming` also gets released at that point so Retry becomes a real retry. (It
       * used to be 25/30 seconds, and was raised after confirming that codex's thread/resume scales
       * with rollout size — measured at roughly 550MB in 13.5 seconds. A "resource upload" session was
       * hitting the 25-second wall and could never wake up.)
       *
       * Even if the timeout wins, the tool process can still be up somewhere — if it arrives later, it
       * is reclaimed. Failing to reclaim it would leave an app-server quietly holding a locked thread.
       */
      const tStartFrom = Date.now()
      const handle = await withTimeout(creating, 150_000, `Starting ${m.tool}`).catch((err) => {
        void creating.then((h) => (from.own(h), h.dispose())).catch(() => {})
        // This attaches a handle that never came up in time — a handle arriving late is disposed above and
        // closed here too
        apps?.close()
        throw err
      })
      const tStart = Date.now() - tStartFrom
      from.own(handle)
      /*
       * **If the session was deleted or its tool was switched while this wait was in flight, this
       * handle has nowhere to go** (#163). It used to be inserted without this check, and the row
       * rewritten — a deleted session would come back to life in the store and reappear in the list
       * on the next startup, with its process running until the host itself was shut off (holding the
       * thread's write lock the whole time, if it was Codex). For a session that switched tools, the
       * old tool's process survived and kept receiving messages, and the old tool's conversation id
       * got written into the new tool's slot.
       */
      const leaving =
        this.host.leaving.get(sessionId) ??
        (!this.host.meta.has(sessionId) ? 'The session was deleted while waking'
        : m.tool !== tool ? 'The session switched tools while waking'
        // The host is leaving (#839): its handles are let go of, so one registered now would be nobody's
        : this.host.lettingGo ? 'Centralu is restarting or quitting'
        : null)
      if (leaving) {
        // Waits for it to close — whichever side is deleting it goes on to delete the tool-side conversation
        // too (Codex holds its lock the whole time it runs)
        await handle.dispose().catch(() => {})
        return { session: m, resumed: false, reason: leaving }
      }
      /*
       * What the tool's conversation turned out to run with, taken into the record before anything reads it (#1369):
       * `launched` below becomes what this process runs, and the record follows it
       */
      if (adoptOpenedSettings(handle, m, launched, m.importedFrom != null)) {
        this.host.store.sessions.upsertSession(m)
        this.host.emit({ type: 'settings_changed', sessionId, model: m.model, effort: m.effort, verbosity: m.verbosity, serviceTier: m.serviceTier, by: 'tool' })
      }
      this.host.handles.set(sessionId, handle)
      if (!adopt) {
        // The process before it held the messages given it for turns to come, and a new one holds none (#1604)
        this.host.children.dropInputOrigins(sessionId)
        this.host.launches.rememberToolPrefix(sessionId)
        this.host.launches.rememberLaunchSettings(m, cwd)
        // A new process holds no background work yet (#648); whatever an earlier adopted one left unknown is over
        this.host.restartPolicy.backgroundUnknown.delete(sessionId)
        this.host.launches.rememberBackgroundTasks(m)
      }
      // Every window learns it is awake, not only the one that asked (#568)
      this.host.emit({ type: 'session_live', sessionId, live: true })
      // Why the process came up again, if a restart said so; a wake, a revive or a manual restart otherwise (§6.1)
      this.host.cacheLedger.note(sessionId, this.host.restartPolicy.restartReasons.get(sessionId) ?? 'new_process')
      this.host.restartPolicy.restartReasons.delete(sessionId)
      this.host.running.set(sessionId, launched)
      handle.applyRules?.(this.host.rulesFor(sessionId, m.projectId))
      // The identifier may only now be available — record it for the next resume
      if (handle.externalId && handle.externalId !== m.externalId) m.externalId = handle.externalId
      if (adopt) {
        /*
         * A re-attached process keeps the state it had (#280 step 2): a running turn is still
         * running, and a waiting approval has been, or is about to be, re-delivered by the tool —
         * which sets the state itself. Forcing `idle` here would tear down that fresh card.
         */
        this.host.store.sessions.upsertSession(m)
        this.host.emit({ type: 'state_change', sessionId, state: m.state, reason: 'reattached' })
        /*
         * And it keeps its background work (#648): the shells the previous host saw running still run in it, and the
         * tool will not list them again until something changes. They are listed from the kept record, as the tool's
         * own level would be; with no record (the previous host predates it), the session is held as unknown until
         * the tool first speaks, rather than read as idle and put to sleep over a running dev server.
         */
        if (kept === null) this.host.restartPolicy.backgroundUnknown.set(sessionId, Date.now())
        // Listed through onEvent, which also keeps the record for the host after this one
        else if (kept.length > 0) this.host.onEvent({ type: 'background_tasks', sessionId, live: kept })
      } else {
        this.host.settleState(m, { type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      }
      void this.host.listCommands(sessionId).catch(() => {})

      // Catches up on conversation continued outside (in a terminal's tool).
      // An orchestrator is a session the app manages, so there is nothing for it to catch up on
      // outside — since it has no project, this branch never fires for it in the first place
      // (an orchestrator with a project no longer exists).
      // Not for a re-attached process: what it said meanwhile arrives from the keeper's buffer, and
      // reading it from the transcript too would record it twice.
      let tCatchup = 0
      let added = 0
      if (project && !adopt) {
        // Even if catch-up stalls, the session is already alive — do not block on it, leave it for next time
        const tCatchupFrom = Date.now()
        const catchingUp = this.host.externals.syncImportedHistory(m, adapter)
        added = await withTimeout(catchingUp, 10_000, 'History catch-up').catch(() => {
          // Past the bound it goes on, and what it adds lands later: the windows are told then (#839)
          void catchingUp.then((late) => {
            if (late > 0 && this.host.meta.has(sessionId)) this.host.emit({ type: 'history_synced', sessionId, added: late })
          }, () => {})
          return 0
        })
        tCatchup = Date.now() - tCatchupFrom
        if (added > 0) this.host.emit({ type: 'history_synced', sessionId, added })
      }
      // If catchup is under a few hundred ms, it was skipped (nothing changed, so the full transcript was
      // never read)
      console.error(
        `[agent-host] ${adopt ? 're-attached' : 'resumed'} ${sessionId.slice(0, 8)} tool=${m.tool} ` +
          `check=${tCheck}ms start=${tStart}ms catchup=${tCatchup}ms added=${added} total=${Date.now() - t0}ms`,
      )
      return { session: m, resumed: true }
    } catch (err) {
      // No process came up for it: the ceiling written for the start is no use (#1376)
      this.host.modelWindows.forget(sessionId)
      /*
       * Only digs into why it failed **after** it has already failed.
       *
       * Used to query the tool's list before every resume, but codex spins up an app-server every
       * time that happens, so every session pick paid a few extra seconds (a dogfooding finding). An
       * expensive check only runs when something has actually gone wrong — the happy path has to stay fast.
       */
      // A cap applies to this after-the-fact check too — the worst outcome would be holding the real
      // failure reason (err) but losing it because the check itself hung. The same rule as elsewhere:
      // if it cannot be determined, it does not block (false).
      // A kept process that could not be re-attached has nobody left to address it
      if (adopt) {
        adopt.kill('SIGTERM')
        return { session: m, resumed: false, reason: (err as Error).message }
      }
      const gone = await withTimeout(this.host.externals.externalGone(m, cwd), 8_000, 'Checking the tool').catch(() => false)
      if (gone) {
        return { session: m, resumed: false, reason: externalMissingReason(this.host.toolLabel(m.tool), cwd) }
      }
      /*
       * The adapter tells us with a code that "another side is holding this conversation" (codex's
       * lock). Only that code is read, never a message re-parsed — this is the basis on which the
       * screen offers a fork.
       */
      const locked = (err as { code?: string }).code === 'conversation_locked'
      return { session: m, resumed: false, reason: (err as Error).message, lockedElsewhere: locked || undefined }
    }
  }
}

/**
 * The tool's session, unless the launch asks what the tool declared it cannot keep (`launchRefusal`): then it is refused
 * before any process starts. Every start and wake passes here, so the host is the gate whatever path asked (a picker,
 * start_agent, an app's agent, a fork, a handoff); a picker greys the tool with the same words.
 */
function startFit(adapter: AgentAdapter, opts: CreateSessionOpts, sink: EventSink): Promise<SessionHandle> {
  const reason = launchRefusal(adapter.capabilities, adapter.descriptor.label, {
    permissionPreset: opts.permissionPreset,
    projectTrusted: opts.projectTrusted,
    noSettingFiles: opts.noSettingFiles,
    roleText: !!opts.systemPromptAppend,
  })
  return reason ? Promise.reject(unfitError(reason)) : adapter.createSession(opts, sink)
}
