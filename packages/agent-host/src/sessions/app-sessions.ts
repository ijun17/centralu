import { orchestratorHome } from './orchestrator-home.js'
import type { SessionAppsHub } from './session-apps.js'
import type { AgentRunRequest, AgentRunResult, AppCheckReport, AppRef, HostCapability } from '../apps/external/runtime.js'
import { AgentRunWait } from './app-agents.js'
import { turnAnswer } from './turn-answer.js'
import { builderRole } from './app-builder.js'
import type {
  Attachment,
  CreateSessionParams,
  ExternalAppInfo,
  NormalizedEvent,
  PermissionPreset,
  SessionInfo,
  ToolName,
} from '@cc/protocol'
import { appKeyOf, noSuchAppText } from '@cc/protocol'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import type { MemoryGate } from './memory-gate.js'
import type { Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { attachmentBytes } from '../dev-services/attachments.js'
import {
  gitSummary,
  gitStatusFiles,
  type GitFileStatus,
  type GitSummary,
} from '../dev-services/git.js'
import type { DelegationFlow } from './delegation-flow.js'
import type { SessionRecord } from './session-record.js'
import type { AppMessageSource, AppMessageVia } from './app-messages.js'
import { parseJson } from '../dev-services/store/json.js'
import { asObj } from '../json-value.js'
import { rpcError } from '../rpc-error.js'

/** Key for the builder-session directory (APP_BUILDERS_KEY) — an app is identified by (project, id) */
const builderKey = (ref: AppRef): string => appKeyOf(ref.projectId, ref.appId)

/**
 * One builder session per app (M4 C-2) — `<projectId | _user>/<appId>` -> session id. A single JSON
 * field in app_settings.
 *
 * Why this does not get its own column on the session row: a session's `appId` stands for "the
 * session this app owns", which exists beyond builder sessions too (D-1's agent session called by
 * the app uses the same column). "That app's builder session" is a relation the app side points at,
 * and if the pointed-to session is deleted it is fine for it to quietly go stale (`builderOf`
 * checks the session). There is also no schema to migrate.
 */
const APP_BUILDERS_KEY = 'apps.builders'

/**
 * What the app sessions reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields, so each is read when used, never kept.
 */
export type AppSessionsHost = {
  readonly adapters: Map<string, AgentAdapter>
  readonly agentRuns: Map<string, AgentRunWait>
  readonly appsHub: SessionAppsHub | null
  createSession: (params: Omit<CreateSessionParams, "projectId" | "tool"> & { projectId: string | null; tool: ToolName | null; kind?: Exclude<SessionInfo["kind"], "coordinator">; roleAppend?: string; appId?: string | null; builderOf?: AppRef; appAgent?: { outputSchema?: Record<string, unknown>; }; askedBy?: string; forkedFrom?: string; lsp?: boolean; }) => Promise<SessionInfo>
  defaultToolFor: (projectId: string | null) => ToolName | null
  readonly delegationFlow: DelegationFlow
  deliver: (sessionId: string, text: string, attachments: Attachment[] | undefined, from: { sessionId: string; name: string; } | undefined, relayed: boolean, fromApp?: AppMessageSource, fromAppVia?: AppMessageVia, sendInput?: (handle: SessionHandle, text: string) => void) => Promise<void>
  readonly handles: Map<string, SessionHandle>
  listSessions: () => SessionInfo[]
  readonly memoryGate: MemoryGate | null
  readonly meta: Map<string, SessionInfo>
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  readonly record: SessionRecord
  rename: (sessionId: string, name: string) => void
  /** The way a finished app-agent session goes (#378): to the trash if still unused (`SessionTrash.trashIf`), then deleted for good */
  trashIf: (sessionId: string, removeExternal: boolean, onlyIf: () => boolean) => Promise<boolean>
  purgeSession: (sessionId: string) => Promise<void>
  emit: (e: NormalizedEvent) => void
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  readonly store: Store
  /** Sessions waking right now (#378 review: a finished app-agent session that is waking is in use) */
  readonly resuming: ReadonlyMap<string, unknown>
  /** A queued note not yet taken by the session (`SessionManager.inputsHeld`) */
  inputsHeld: (sessionId: string) => boolean
  /** Requests queued for a session until it is free (#677) */
  readonly children: { readonly queued: ReadonlyMap<string, readonly unknown[]> }
}

/**
 * The sessions an external app owns (#428): its builder session and the slot that names it (M4 C-1b, C-3), the check
 * it runs, the agents it asks for and the answer they give back (M4 D-1), and the host data it reads. Moved out of the
 * session manager as it was; what it reaches of the manager is `AppSessionsHost`.
 */
export class AppSessions {
  constructor(private readonly host: AppSessionsHost) {}

  /**
   * Creates a new app (M4 C-1b) — the single path both `apps.create` and the orchestrator's
   * `create_app` go through.
   *
   * Checking the name, trust and whether an id already exists is the runtime's own gate's job
   * (`ExternalApps.createApp`). Writing that check a second time here would produce two sets of
   * rules, and whichever one is looser becomes the hole (#93).
   */
  async createApp(params: {
    projectId: string | null
    id: string
    name: string
    description?: string
    tool?: ToolName
  }): Promise<{ app: ExternalAppInfo; builder: SessionInfo | null; builderError?: string }> {
    const rt = this.host.appsHub?.rt
    if (!rt) throw rpcError('External apps are unavailable — there is nowhere to make an app')
    const app = rt.createApp(params)
    /*
     * Creating an app also stands up its builder session (C-2). Even if that session fails to come up
     * (the tool is missing, or not logged in), **the app still exists** — its folder was already
     * created, and there is no reason to roll that back. The reason is returned alongside it, and
     * `apps.createBuilder` can stand one up later.
     */
    try {
      return { app, builder: await this.createAppBuilder({ projectId: app.projectId, appId: app.appId }, params.tool) }
    } catch (e) {
      return { app, builder: null, builderError: (e as Error).message }
    }
  }

  /**
   * That app's builder session (M4 C-2) — null if there is none. "open app X's builder session" asks this.
   *
   * The directory only ever points at a session. If the session it points to has been deleted, it
   * counts as none; and if the session's app slot or project no longer matches this app (a tampered
   * directory), that session is never handed over as this app's — the session row is always the
   * source of truth.
   */
  builderOf(ref: AppRef): SessionInfo | null {
    const id = this.builderMap()[builderKey(ref)]
    const m = id ? this.host.meta.get(id) : undefined
    if (!m || m.appId !== ref.appId || m.projectId !== ref.projectId) return null
    return m
  }

  /**
   * Stands up an app's builder session (M4 C-2) — returns the existing one if there already is one (one per
   * app).
   *
   *   Project app       cwd = **the project root**. Handoff notes, file links and history catch-up all
   *                     assume the project root — using the app's folder as cwd breaks all of them
   *                     (the plan's C-2). Where the app lives and what its rules are is told to it
   *                     through the role text.
   *   User-folder app   cwd = the app's own folder. There is no project to fall back to (P-6 already
   *                     made this kind of session possible).
   *
   * The caller picks the tool, and if it does not, the project's default tool is used (for a
   * user-folder app, the orchestrator's own tool). The session's app slot (`appId`) is set to that
   * app — it stands under the app in the sidebar. The preset is `normal`: a session that edits an
   * app's code never runs unattended without the person's knowledge. No builder is stood up for an
   * app in an untrusted project — that app cannot even launch, so there is nothing to test even if a builder
   * existed.
   */
  async createAppBuilder(ref: AppRef, tool?: ToolName): Promise<SessionInfo> {
    const existing = this.builderOf(ref)
    if (existing) return existing
    // One being stood up already (#839): a second ask waits on it, never makes another
    const key = builderKey(ref)
    const on = tool ?? this.host.defaultToolFor(ref.projectId)
    const standing = this.buildersStanding.get(key)
    if (standing) {
      // One app has one builder: a second ask on another tool is told which one it is getting, not given it silently
      if (standing.tool !== on) throw rpcError(`This app's builder is already being started on ${standing.tool ?? 'the default tool'}`)
      return standing.p
    }
    const p = this.standUpBuilder(ref, tool).finally(() => {
      if (this.buildersStanding.get(key)?.p === p) this.buildersStanding.delete(key)
    })
    this.buildersStanding.set(key, { p, tool: on })
    return p
  }

  /** Builders being stood up now, by app, with the tool each is on (#839) */
  private readonly buildersStanding = new Map<string, { p: Promise<SessionInfo>; tool: ToolName | null }>()

  private async standUpBuilder(ref: AppRef, tool?: ToolName): Promise<SessionInfo> {
    const rt = this.host.appsHub?.rt
    if (!rt) throw rpcError('External apps are unavailable')
    const app = rt.list().find((a) => a.appId === ref.appId && a.projectId === ref.projectId)
    if (!app) throw rpcError(noSuchAppText(ref))
    if (!app.trusted) {
      throw rpcError('Centralu does not give a builder to an app in a project it does not trust — trust the project, and the app can start and be tested')
    }
    /*
     * An imported app the person has not enabled yet (E-3) — its builder session works inside that
     * app's folder and receives that app's own tools. An agent is never let touch unverified code
     * first: enabling comes first.
     */
    if (app.status === 'unconfirmed') {
      throw rpcError(`${app.error ?? 'This imported app is not enabled'}. Enable it before starting its builder`)
    }
    let cwd = app.dir
    const fallback = this.host.defaultToolFor(ref.projectId)
    if (ref.projectId !== null) {
      const project = this.host.store.projects.listProjects().find((p) => p.id === ref.projectId)
      if (!project) throw rpcError(`Project not found: ${ref.projectId}`)
      cwd = project.path
    }
    const info = await this.host.createSession({
      projectId: ref.projectId,
      cwd,
      tool: tool ?? fallback,
      permissionPreset: 'normal',
      roleAppend: builderRole(app, cwd),
      appId: ref.appId,
      builderOf: ref,
    })
    // The name is the meaning a person reads for this session — treated as a name a person set, so an
    // auto-name never overwrites it (FR-18)
    this.host.rename(info.id, `${app.name ?? app.appId} · builder`)
    return this.host.meta.get(info.id)!
  }

  /**
   * Is this app's builder session inside a turn right now (M4 C-4) — asked by the runtime to decide
   * whether to reflect a change in the app's folder immediately or wait for the turn to end
   * (`ExternalAppsDeps.builderBusy`). Waiting for an approval also counts as being inside a turn.
   */
  builderBusy(ref: AppRef): boolean {
    const b = this.builderOf(ref)
    return !!b && inTurn(b.state)
  }

  /** The app this session builds — null if this is not a builder session. Takes the session's shape so it can
   * be asked even before it comes up (before it is placed in metadata) */
  builderRefOf(m: Pick<SessionInfo, 'id' | 'appId' | 'projectId'>): AppRef | null {
    if (!m.appId) return null
    const ref: AppRef = { projectId: m.projectId, appId: m.appId }
    return this.builderMap()[builderKey(ref)] === m.id ? ref : null
  }

  /**
   * Checks an app (M4 C-3) — called by `apps.check` and a builder session's own `check`. The actual verdict
   * is decided by the runtime's own gate.
   */
  async checkApp(ref: AppRef): Promise<AppCheckReport> {
    const rt = this.host.appsHub?.rt
    if (!rt) throw rpcError('External apps are unavailable')
    return rt.check(ref)
  }

  /**
   * A single piece of host data (M4 D-3) — called only after the gate has verified the name (from a
   * closed list) and the declaration. What is handed over, and how much of it, is decided here,
   * separately for each name (see the list comment in `capabilities.ts`). Conversation content never
   * goes out under any name: even the session list carries no preview — a conversation can hold
   * secrets the person pasted in and details of an unrelated project, and an app is code that can be shared
   * with a team.
   */
  async appHostData(name: HostCapability, app: AppRef): Promise<Record<string, unknown>> {
    switch (name) {
      case 'sessions.list': {
        const projects = new Map(this.host.store.projects.listProjects().map((p) => [p.id, p.name]))
        // A project app only sees that project's sessions; a user-folder app sees all of them (a user-folder
        // app is the orchestrator's own — decision 4)
        const sessions = this.host.listSessions()
          .filter((s) => app.projectId === null || s.projectId === app.projectId)
          .map((s) => ({
            id: s.id,
            name: s.name,
            project: s.projectId ? (projects.get(s.projectId) ?? null) : null,
            kind: s.kind,
            tool: s.tool,
            state: s.state,
            live: s.live,
            createdAt: s.createdAt,
            waitingSince: s.waitingSince,
            branch: s.worktree?.branch ?? null,
            appId: s.appId,
          }))
        return { sessions }
      }
      case 'git.status': {
        if (app.projectId === null) {
          throw new Error('git.status needs a project — this app lives in your user folder, so there is no project to read')
        }
        const project = this.host.store.projects.listProjects().find((p) => p.id === app.projectId)
        if (!project) throw new Error('the project of this app is gone')
        const trust = { trusted: project.trusted }
        return gitStatusForApp(await gitSummary(project.path, trust), () => gitStatusFiles(project.path, trust))
      }
    }
  }

  /**
   * Runs an agent an app asked for (M4 D-1, plan decision 6) — stands up **a new session per
   * request** under that app, and returns the answer once the turn ends.
   *
   * Why a new one is stood up per request: Claude's structured output (`outputFormat`) is only ever
   * fixed at the start of a query. Different requests can have different schemas, and if several
   * requests piled up in one session, an earlier request would bleed into a later answer.
   *
   *   Location  That project (cwd is the project root) for a project app; for a user-folder app, the
   *             orchestrator's own empty folder with no project, the same as a coordinator session.
   *             The session's app slot (`appId`) is set to that app.
   *   Preset    **Always `safe`** — never inherited from the calling session even if it is `auto`
   *             (the plan's "security boundary"). An app's text is someone else's words, and an agent
   *             running on that text must never act unattended without the person's knowledge.
   *   Text      Sent as the app's own text, not the person's — recorded in the conversation as a
   *             message the app sent (`fromApp`), and reaches the agent wrapped in the same frame as
   *             an inline view's message (`appMessageFrame`, every line contained in a quote) with the
   *             "work an app asked for" header (the rule from #120).
   *   Apps      None are attached (see the comment on `appsFor`).
   *
   * **When it finishes, its process is closed and it is left `idle`**, never `waiting_input`, so it never appears in
   * the inbox: a turn whose answer an app has already collected is not a turn waiting on a person's reply. Once the
   * desk has closed the run as `ok`, the session is deleted and its record kept in the trash (`agentRunEnded`, #378),
   * unless the person took part in it. (The plan's "archive it" went with the archive, FR-20: a hidden session was
   * indistinguishable from a deleted one. An app calling run_agent a few dozen times a day then filled the sidebar.)
   *
   * A cancellation (the requesting call was canceled, or something upstream in the chain stopped)
   * interrupts that session. If the person stops or deletes that session directly, the wait also ends,
   * carrying a reason.
   */
  async runAppAgent(
    req: AgentRunRequest,
    ctx: {
      signal: AbortSignal
      progress(message: string): void
      onSession?(sessionId: string): void
      onUsage?(tokens: { input: number; output: number }): void
    },
  ): Promise<AgentRunResult> {
    const adapter = this.host.adapters.get(req.tool)
    if (!adapter) throw new Error(`${req.tool} is not an agent this Centralu has, so ${req.appName}'s request cannot run`)
    // Standing up a session with a tool that is not logged in would only surface on the first turn — this is
    // checked first, and the tool's own words are returned as the reason
    const found = await adapter.detect()
    if (!found.installed || !found.loggedIn) {
      throw new Error(`${adapter.descriptor.label} cannot take ${req.appName}'s request: ${found.detail}`)
    }
    let cwd: string
    if (req.app.projectId !== null) {
      const p = this.host.store.projects.listProjects().find((x) => x.id === req.app.projectId)
      if (!p) throw new Error(`the project of ${req.appName} is gone`)
      cwd = p.path
    } else {
      cwd = orchestratorHome()
    }
    if (ctx.signal.aborted) throw new Error('the request was cancelled before the agent started')
    /*
     * Memory (#686): no room for another agent now. The app's call already waits for its answer, so the start is
     * queued inside it: the app's run reads "waiting for memory" as progress (the person sees it in the run log), and the
     * agent starts when memory recovers. Past the gate's bound, or when the call is cancelled, it ends without a session.
     */
    const short = await this.host.delegationFlow.starts.memoryShort()
    if (short && this.host.memoryGate) {
      const low = this.host.delegationFlow.starts.lowMemory(short)
      ctx.progress(`waiting for memory: ${low.available} free, ${low.floor} needed to start the agent`)
      const outcome = await this.host.memoryGate.wait(ctx.signal)
      if (outcome === 'aborted' || ctx.signal.aborted) throw new Error('the request was cancelled before the agent started (it was waiting for memory)')
      if (outcome === 'timeout') throw new Error(`memory stayed below ${low.floor} for ${low.maxWaitMinutes} minutes, so the agent was not started`)
    }

    /*
     * **The preset is `safe`** — regardless of the calling session and regardless of the person's own
     * global setting.
     *
     * This was `normal` at first (the plan's decision 6: never inherit the calling session's `auto`).
     * But `normal` still pulls its approval mode from the person's own `~/.claude`. For someone using
     * global bypass, that would let an agent an app called do anything at all with no approval card —
     * exactly the path decision 6 was meant to close off. This prompt was never written by the person.
     * It was sent by the app's code, and data the app pulled in from outside can be mixed into it (a
     * prompt injection channel). Global bypass is the person choosing to trust **their own
     * instructions** — not a choice to trust an instruction an app wrote too. (This differs from #92
     * respecting the user's own setting — there, the one giving the instruction was still the person.)
     *
     * Even under `safe`, a read is never asked about. A request like summarizing or looking something
     * up just runs, and only a write or a command execution surfaces as an approval card in this
     * session under this app — a slot the person can actually see.
     */
    const info = await this.host.createSession({
      projectId: req.app.projectId,
      cwd,
      tool: req.tool,
      permissionPreset: 'safe',
      appId: req.app.appId,
      appAgent: req.schema ? { outputSchema: req.schema } : {},
    })
    const id = info.id
    // A line in the run log (D-6) points at this session — so it can be jumped to from the log view even
    // while it is still running
    ctx.onSession?.(id)
    // Several requests from the same app would otherwise share the same name — a timestamp is appended to
    // tell them apart in the list. The name is never coined from the app's own text (it is someone else's
    // words)
    this.host.rename(id, `${req.appName} · agent ${new Date().toTimeString().slice(0, 5)}`)
    const wait = new AgentRunWait(
      (message) => ctx.progress(message),
      () => this.host.meta.get(id)?.name ?? 'the agent session',
      // Tokens spent are recorded on the request's own log line — the log view shows them added up per app
      // (D-5)
      (tokens) => ctx.onUsage?.(tokens),
    )
    this.host.agentRuns.set(id, wait)
    const onAbort = () => {
      if (this.host.agentRuns.get(id) !== wait) return
      // Failed first: Claude's interrupt ends the turn once the CLI confirms it, and the wait would read that as "stopped" (#698)
      wait.fail(new Error('the request was cancelled, so the agent was stopped'))
      try {
        this.host.handles.get(id)?.interrupt()
      } catch {
        // The session has already gone down — there is nothing left to stop
      }
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // It could have been canceled while the session was still being stood up — a listener attached to a
      // signal that already fired is never called (the same pitfall as runtime.call)
      if (ctx.signal.aborted) onAbort()
      else await this.host.deliver(id, req.prompt, undefined, undefined, false, { appId: req.app.appId, projectId: req.app.projectId, name: req.appName }, 'request')
      const { output } = await wait.done
      /*
       * Held from the answer until the desk says how the run ended (`agentRunEnded`) and the delete that may follow is
       * final: only an answer can end it cleanly, and the person opening or writing to the session at any moment in
       * between (its process's close included, which takes a real CLI up to seconds) makes it theirs (#378 review)
       */
      this.answeredRuns.set(id, { appName: req.appName, wait })
      // The answer is read from the store — what a person sees in that session and what the app receives are
      // the same text
      return { sessionId: id, text: turnAnswer(this.host.store.messages.loadMessages(id, 50)), ...(output !== undefined ? { output } : {}) }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
      await this.finishAppAgent(id, wait)
      if (wait.deleted) this.answeredRuns.delete(id)
    }
  }

  /**
   * App-agent sessions that answered (#378), from the answer until the desk has closed their run and what follows is
   * done, with the run's wait, which says how the person took part if they did. The desk's verdict comes in the same
   * call (the schema check).
   */
  private readonly answeredRuns = new Map<string, { appName: string; wait: AgentRunWait }>()

  /**
   * The person opened an app-agent session or wrote to it (#378) while its run was on, or before what follows its end
   * was done: it has become theirs, and it stays. A card shown to them counts too, which the run's wait sees itself
   * (`AgentRunWait`).
   */
  noteTookPart(sessionId: string, how: 'opened' | 'wrote'): void {
    const wait = this.host.agentRuns.get(sessionId) ?? this.answeredRuns.get(sessionId)?.wait
    if (wait) wait.personTookPart ??= how
  }

  /**
   * A run_agent run is over (#378): its session is deleted when the run ended cleanly and nobody took part in it, and
   * what it did is kept in the trash as the run's record (the app's request, the answer, the whole conversation). It
   * stays, as before, when the run failed, was stopped or cancelled (the person needs to see what went wrong), when a
   * card was shown during it, or when the person opened it or wrote to it.
   */
  async agentRunEnded(run: { runId: string; sessionId: string; status: string }): Promise<void> {
    const answered = this.answeredRuns.get(run.sessionId)
    try {
      if (!answered || run.status !== 'ok') return
      // A failure leaves the session where it is, as before #378: never the app's to hear about
      await this.deleteAnsweredAgent(run.runId, run.sessionId, answered).catch((e: Error) =>
        console.error(`[apps] the agent session ${run.sessionId.slice(0, 8)} of a finished run was not deleted: ${e.message}`),
      )
    } finally {
      // Only now: the person's part was heard until the delete was final
      if (answered && this.answeredRuns.get(run.sessionId) === answered) this.answeredRuns.delete(run.sessionId)
    }
  }

  private async deleteAnsweredAgent(runId: string, sessionId: string, answered: { appName: string; wait: AgentRunWait }): Promise<void> {
    const m = this.host.meta.get(sessionId)
    if (!m) return
    // An attachment is a file the record does not copy: a session holding one stays, so nothing of it is lost
    if ((await attachmentBytes(sessionId)) > 0) return
    /*
     * The tool's own conversation file goes with it when the tool can delete it: the record holds the whole conversation,
     * and a file left behind would be listed under + → Past conversations for every run an app ever made.
     */
    const removeExternal = !!(m.externalId ?? m.importedFrom) && !!this.host.adapters.get(m.tool)?.deleteExternalConversation
    /*
     * Decided at the moment the session leaves (`onlyIf`), not before: a message, a wake or a card that came in the
     * meantime keeps it. The record first: a session whose record could not be kept stays, so what it did is never lost
     */
    const trashed = await this.host.trashIf(sessionId, removeExternal, () => {
      const now = this.host.meta.get(sessionId)
      if (!now || answered.wait.personTookPart || this.inUse(now)) return false
      const projectName = now.projectId ? (this.host.store.projects.listProjects().find((p) => p.id === now.projectId)?.name ?? null) : null
      return this.host.store.keptRuns.keepRun({ runId, sessionId, sessionName: now.name, appName: answered.appName, projectName, tool: now.tool, keptAt: Date.now() })
    })
    if (!trashed) return
    await this.host.purgeSession(sessionId)
    // The app's runs panel reads the run as kept now
    if (m.appId) this.host.emit({ type: 'external_app_runs_changed', appId: m.appId, projectId: m.projectId })
  }

  /** Woken since its run (a message, a card), waking, or holding something sent to it: in use, so it stays (#378) */
  private inUse(m: SessionInfo): boolean {
    const id = m.id
    return (
      inTurn(m.state) ||
      this.host.handles.has(id) ||
      this.host.agentRuns.has(id) ||
      this.host.resuming.has(id) ||
      this.host.inputsHeld(id) ||
      (this.host.children.queued.get(id)?.length ?? 0) > 0 ||
      !!m.pendingApproval ||
      m.pendingQuestions.length > 0
    )
  }

  /** Lets an agent session that has handed over its answer (or otherwise ended) rest — closes the process and
   * leaves it `idle` (see the comment on `runAppAgent`) */
  private async finishAppAgent(sessionId: string, wait: AgentRunWait): Promise<void> {
    if (this.host.agentRuns.get(sessionId) === wait) this.host.agentRuns.delete(sessionId)
    // Being deleted right now — there is no session left to wrap up (trashSession itself closes the process)
    if (wait.deleted) return
    const h = this.host.handles.get(sessionId)
    if (h) {
      this.host.record.closeStream(sessionId)
      // Closed before it is removed — so a message issued during close arrives as a message from the
      // registered handle (the #157 guard in onEvent)
      const closing = h.dispose().catch(() => {})
      this.host.handles.delete(sessionId)
      this.host.running.delete(sessionId)
      await closing
    }
    if (!this.host.meta.has(sessionId)) return
    this.host.onEvent({ type: 'state_change', sessionId, state: 'idle', reason: 'app_agent_finished' })
  }

  private builderMap(): Record<string, string> {
    return asObj(parseJson(this.host.store.settings.appSetting(APP_BUILDERS_KEY))) as Record<string, string>
  }

  /** Records the builder session an app points at. If `sessionId` is null, this clears it — with `only`
   * given, only if it currently points at that session */
  setBuilder(ref: AppRef, sessionId: string | null, only?: string): void {
    const map = this.builderMap()
    const key = builderKey(ref)
    if (sessionId === null) {
      if (only !== undefined && map[key] !== only) return
      delete map[key]
    } else {
      map[key] = sessionId
    }
    this.host.store.settings.setAppSetting(APP_BUILDERS_KEY, JSON.stringify(map))
  }
}

/**
 * What an app's `git.status` answers for a project's git summary (`HOST_CAPABILITIES`).
 *
 * A summary git did not answer (`unknown`, #850 review) is an error with its reason, not "no branch, no changes": an
 * app would act on a clean tree that is not known to be clean. A count the host stopped at its cap says so (`more`).
 */
export async function gitStatusForApp(
  summary: GitSummary,
  files: () => Promise<GitFileStatus[]>,
): Promise<{ isRepo: boolean; branch: string | null; changedFiles: number; more?: true; files: GitFileStatus[] }> {
  if (summary.denied) throw new Error("Centralu cannot read this project's folder (the system denied access)")
  if (summary.unknown) throw new Error('git did not answer for this project in time — try again')
  if (!summary.isRepo) return { isRepo: false, branch: null, changedFiles: 0, files: [] }
  return {
    isRepo: true,
    branch: summary.branch,
    changedFiles: summary.changedFiles,
    ...(summary.more ? { more: true as const } : {}),
    files: await files(),
  }
}
