import type { AppErrorBundle, AppReach, Attachment, ExternalAppInfo, ProjectInfo, SessionInfo, ToolName } from '@cc/protocol/client'
import { appKeyOf, errorMessage, noSuchAppText, builderErrorFrame, builderRequestOf, newAppIdProblem, sessionLiveDefaults } from '@cc/protocol/client'
import type { AppCreated, BuilderAsk, NewAppSpec } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'
import type { AppRegistry } from './app-registry.js'
import type { ToolsMock } from './tools.js'
import type { OrchestratorMock } from './orchestrator.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** Making an app and its builder session (M4 C), error bundles, and whether a session can reach an app (#308) */
export class AppBuilderMock {
  /** What a live agent says about an attached app (#308, `apps.reach`), keyed `<sessionId> <projectId|_user>/<appId>` */
  readonly appAttachments = new Map<string, 'restart' | 'failed'>()
  /** Every `apps.reach` asked, in order */
  readonly reachAsks: { sessionId: string; appId: string; projectId: string | null }[] = []
  /** Sent bundle → time sent — only once, like the host */
  private readonly errorsSent = new Map<string, number>()
  /** "Send to builder" calls that reached the host — empty before a click, one after */
  readonly errorSends: { appId: string; projectId: string | null; at: number; machine?: string }[] = []
  /** How many times a bundle has been read — tests check it is re-read when "changed" arrives */
  errorReads = 0
  /** If set, sendError waits on this — lets a test check the screen while a send is in progress */
  sendErrorGate: Promise<void> | null = null
  /** What the "New app" window sent to the host — tests check what the window chose (id, name, tool) */
  readonly createdApps: NewAppSpec[] = []
  /**
   * Makes and registers a new project folder (`projects.create`, wired by the mock platform): where an app made without
   * a project lands, as the host's does (#1141)
   */
  makeProject: ((name: string, parent?: string) => Promise<ProjectInfo>) | null = null
  /** What the input line below an app screen sent to the host (M4 C-5) — tests check what was sent, from which screen, with what attached */
  readonly builderAsks: BuilderAsk[] = []
  /**
   * Puts a message into the builder session — like the host's `deliver`: records it, carries
   * attachments by path, and notifies the screen with `user_message` (a message the host
   * injected was not already drawn by the UI). The receiving session starts working.
   */
  private deliverToBuilder(sessionId: string, text: string, attachments?: Attachment[]): void {
    const s = this.store.sessions.get(sessionId)
    if (!s) throw mockError(`Session not found: ${sessionId}`, 'session_not_found')
    s.live = true
    // emit records it and assigns a seq, like the host (the same path as sendViewMessage)
    this.emit({ type: 'user_message', sessionId, seq: (this.store.messages.get(sessionId)?.length ?? 0) + 1, text, ...(attachments?.length ? { attachments } : {}) })
    this.emit({ type: 'state_change', sessionId, state: 'working' })
  }
  readonly apps = {
    /**
     * A new app (M4 C-1). Like the real thing (`ExternalApps.createApp` →
     * `AppSessions.createAppBuilder`): rejects using the same checks (protocol's
     * `newAppIdProblem`, reserved ids, trust, an existing id) — the rejection wording is
     * exactly the host's, and a test checks that the window shows it as-is — then adds it to
     * the list, broadcasts, and creates the builder session. The app stays even if the session
     * fails to start.
     */
    create: async (spec: NewAppSpec): Promise<AppCreated> => {
      this.createdApps.push(structuredClone(spec))
      const idProblem = newAppIdProblem(spec.id)
      if (idProblem === 'builtin') throw new Error(`"${spec.id}" cannot be an app id — that id is reserved — pick another`)
      if (idProblem) throw new Error(`"${spec.id}" cannot be an app id — ${idProblem}`)
      const name = spec.name.replace(/\s+/g, ' ').trim()
      if (!name) throw new Error('The app needs a name')
      let dir = `/mock/data/apps/${spec.id}`
      let projectId = spec.projectId
      if (projectId === null) {
        /*
         * Like the host (#1141): a new folder `<parent>/<id>` (~/Centralu), registered as a trusted project whose root is
         * the app. The folder rules and their refusals are the new project's (`projects.create`)
         */
        if (!this.makeProject) throw new Error('This mock cannot make a project')
        const made = await this.makeProject(spec.id, spec.parent)
        projectId = made.id
        dir = made.path
      } else {
        const project = this.projectStore.list.find((p) => p.id === spec.projectId)
        if (!project) throw new Error(`There is no such project: ${spec.projectId}`)
        if (!project.trusted) {
          throw new Error('Centralu does not make apps in a project it does not trust — an app is code that runs on this machine, so trust the project first')
        }
        dir = `${project.path}/.centralu/apps/${spec.id}`
      }
      if (spec.projectId !== null && this.registry.externalAppList.some((a) => a.appId === spec.id && a.projectId === spec.projectId)) {
        throw new Error(`An app "${spec.id}" already exists (${dir}) — use another id`)
      }
      const app: ExternalAppInfo = {
        appId: spec.id,
        projectId,
        dir,
        name,
        version: '0.1.0',
        description: spec.description?.replace(/\s+/g, ' ').trim() || `${name} (a Centralu app)`,
        // The template's home tool — the same name as the real template (app-template/centralu.app.json)
        home: 'show',
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
        ...(spec.projectId === null ? { root: true } : {}),
      }
      this.registry.externalAppList.push(app)
      this.emit({ type: 'external_apps_changed' })
      try {
        return { app: structuredClone(app), builder: await this.apps.createBuilder(spec.id, projectId, spec.tool) }
      } catch (e) {
        return { app: structuredClone(app), builder: null, builderError: errorMessage(e) }
      }
    },
    builder: async (appId: string, projectId: string | null): Promise<SessionInfo | null> => {
      const id = this.registry.appBuilders.get(appKeyOf(projectId, appId))
      const s = id ? this.store.sessions.get(id) : undefined
      return s ? structuredClone(s) : null
    },
    /**
     * The builder session (M4 C-2). Like the real thing: one per app (returns the existing one
     * if there is one), never created for an untrusted app, and if no tool is chosen, uses the
     * project's default tool (the orchestrator's tool for a user-folder app). The session fails
     * to start if that tool is absent or not logged in. The name is a human-chosen "<app> ·
     * builder", and the session's app slot is that app. Broadcasts `session_created` on
     * creation.
     */
    createBuilder: async (appId: string, projectId: string | null, tool?: ToolName): Promise<SessionInfo> => {
      const key = appKeyOf(projectId, appId)
      const have = this.registry.appBuilders.get(key)
      const held = have ? this.store.sessions.get(have) : undefined
      if (held) return structuredClone(held)
      const app = this.registry.externalAppList.find((a) => a.appId === appId && a.projectId === projectId)
      if (!app) throw new Error(noSuchAppText({ projectId, appId }))
      if (!app.trusted) {
        throw new Error('Centralu does not give a builder to an app in a project it does not trust — trust the project, and the app can start and be tested')
      }
      const project = projectId ? this.projectStore.list.find((p) => p.id === projectId) : undefined
      const chosen = tool ?? (project ? project.defaultTool : this.orchestratorMock.orchestratorTool) ?? this.toolsMock.firstRegisteredTool()
      const detected = this.toolsMock.detected.find((t) => t.name === chosen)
      if (!detected?.installed || !detected.loggedIn) {
        throw new Error(`Could not start ${chosen} session: ${detected?.detail ?? `${chosen} is not installed`}`)
      }
      const id = `mock-session-${this.clock.next()}`
      const info: SessionInfo = {
        id,
        projectId,
        kind: 'worker',
        tool: chosen,
        externalId: `ext-${id}`,
        name: `${app.name ?? appId} · builder`,
        autoNamed: false,
        state: 'idle',
        lastReadSeq: 0,
        lastSeq: 0,
        createdAt: this.clock.now(),
        waitingSince: null,
        live: true,
        model: null,
        effort: null,
        verbosity: null,
        serviceTier: null,
        permissionPreset: 'normal',
        importedFrom: null,
        worktree: null,
        parentSessionId: null,
        scopeSessionIds: null,
        roleAppend: `(mock builder role for ${appId})`,
        appId,
        ...sessionLiveDefaults(),
      }
      this.store.sessions.set(id, info)
      this.registry.appBuilders.set(key, id)
      // The same rule as the real thing: creating a session sets that project's default tool (manager.createSession)
      if (project && project.defaultTool !== chosen) {
        project.defaultTool = chosen
        this.emit({ type: 'projects_changed' })
      }
      this.emit({ type: 'session_created', sessionId: id, session: structuredClone(info) })
      return structuredClone(info)
    },
    /**
     * "Fix this" (M4 C-5). Like the real thing (builder-requests.ts): rejects with the same
     * wording, and builds the header with **the same function** (protocol's
     * `builderRequestOf`), from facts the mock knows — the app listing (name, stopped
     * state), the instance (screen), the run history (the front of `appRuns`, as filled in by
     * a test). The message built that way stands as a human message in the builder session's
     * conversation.
     */
    askBuilder: async (req: BuilderAsk): Promise<{ sessionId: string }> => {
      this.builderAsks.push(structuredClone(req))
      const key = appKeyOf(req.projectId, req.appId)
      const builderId = this.registry.appBuilders.get(key)
      let view: { uri: string } | null | undefined
      if (req.instanceId) {
        const inst = this.registry.pinnedInstances.get(req.instanceId)
        view = inst && inst.appId === req.appId && inst.projectId === req.projectId ? { uri: inst.uri } : null
      }
      const built = builderRequestOf({
        text: req.text,
        hasAttachments: !!req.attachments?.length,
        app: this.registry.externalAppList.find((a) => a.appId === req.appId && a.projectId === req.projectId),
        builder: builderId && this.store.sessions.has(builderId) ? builderId : null,
        view,
        latestRun: this.registry.appRuns.get(key)?.[0],
      })
      if ('refusal' in built) throw new Error(built.refusal)
      this.deliverToBuilder(built.builder, built.frame, req.attachments)
      return { sessionId: built.builder }
    },
    /** Error bundles (M4 C-6) — a test fills `appErrors` (most recent first). A sent bundle carries `sentAt`, like the host */
    errors: async (appId: string, projectId: string | null, machine?: string): Promise<{ latest: AppErrorBundle | null; recent: AppErrorBundle[] }> => {
      this.errorReads++
      const key = appKeyOf(projectId, appId, machine)
      const recent = (this.registry.appErrors.get(key) ?? []).map((b) => ({ ...structuredClone(b), sentAt: this.errorsSent.get(`${key}\n${b.kind}\n${b.at}`) ?? null }))
      return { latest: recent[0] ?? null, recent }
    },
    /**
     * Whether a session can use an app's tools (#308) — decision 4 as the host decides it (session-apps.ts
     * `reach`): the app's scope first, then trust and the app's state. What a live Codex thread has is the
     * host's to know; a test stands for it with `appAttachments` (`<sessionId> <projectId|_user>/<appId>`).
     */
    reach: async (sessionId: string, appId: string, projectId: string | null): Promise<AppReach> => {
      this.reachAsks.push({ sessionId, appId, projectId })
      const s = this.store.sessions.get(sessionId)
      if (!s) throw new Error(`Session not found: ${sessionId}`)
      const app = this.registry.externalAppList.find((a) => a.appId === appId && a.projectId === projectId)
      if (!app) return { reachable: false, reason: 'unavailable' }
      const key = appKeyOf(projectId, appId)
      const given =
        (s.kind === 'orchestrator' ? projectId === null : s.projectId !== null && s.projectId === projectId) ||
        this.registry.appBuilders.get(key) === sessionId
      if (!given) return { reachable: false, reason: 'other-project' }
      if (app.status === 'untrusted') return { reachable: false, reason: 'untrusted' }
      if (app.status === 'invalid' || app.status === 'unconfirmed' || app.status === 'failed') {
        return { reachable: false, reason: 'app-unusable', status: app.status }
      }
      const live = this.appAttachments.get(`${sessionId} ${key}`)
      if (live === 'restart') return { reachable: false, reason: 'restart' }
      if (live === 'failed') return { reachable: false, reason: 'bridge-failed' }
      return { reachable: true }
    },
    /**
     * Sends an error bundle to the builder session (M4 C-6). Like the real thing
     * (builder-requests.ts): rejects with the same wording, sends each bundle only once
     * (recording comes first), and builds the shape sent to the agent with **the same
     * function** (`builderErrorFrame`).
     */
    sendError: async (appId: string, projectId: string | null, at: number, machine?: string): Promise<{ sessionId: string }> => {
      this.errorSends.push(machine ? { appId, projectId, at, machine } : { appId, projectId, at })
      // So a test can hold "sending" open — checking meanwhile whether the screen accepts a second click
      if (this.sendErrorGate) await this.sendErrorGate
      const key = appKeyOf(projectId, appId)
      const info = this.registry.externalAppList.find((a) => a.appId === appId && a.projectId === projectId)
      if (!info) throw new Error('This app no longer exists')
      const builderId = this.registry.appBuilders.get(key)
      if (!builderId || !this.store.sessions.has(builderId)) throw new Error('This app has no builder session yet. Start one, then send the error')
      const errorKey = appKeyOf(projectId, appId, machine)
      const bundle = (this.registry.appErrors.get(errorKey) ?? []).find((b) => b.at === at)
      if (!bundle) throw new Error('This error is no longer kept. If it happens again, send the new one')
      const sentKey = `${errorKey}\n${bundle.kind}\n${bundle.at}`
      if (this.errorsSent.has(sentKey)) throw new Error('This error was already sent to the builder')
      this.errorsSent.set(sentKey, this.clock.now())
      this.deliverToBuilder(builderId, builderErrorFrame({ appId, name: info.name ?? appId }, bundle.text))
      return { sessionId: builderId }
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly store: SessionStore,
    private readonly projectStore: ProjectStore,
    private readonly registry: AppRegistry,
    private readonly toolsMock: ToolsMock,
    private readonly orchestratorMock: OrchestratorMock,
  ) {}
}
