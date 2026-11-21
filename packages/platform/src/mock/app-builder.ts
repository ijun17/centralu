import type { AppErrorBundle, AppReach, Attachment, ExternalAppInfo, ProjectInfo, SessionInfo, ToolName } from '@cc/protocol/client'
import { appKeyOf, errorMessage, noSuchAppText, builderErrorFrame, builderRequestOf, newAppIdProblem, appIdProblemText, isAssistantKind, sameApp } from '@cc/protocol/client'
import type { AppCreated, BuilderAsk, NewAppSpec } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'
import type { AppRegistry } from './app-registry.js'
import type { ToolsMock } from './tools.js'
import type { AssistantMock } from './assistant.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'
import { mockSessionInfo } from './session-info.js'

/** Making an app and its builder session, error bundles, and whether a session can reach an app (#308) */
export class AppBuilderMock {
  /** What a live agent says about an attached app, keyed `<sessionId> <projectId|_user>/<appId>` */
  readonly appAttachments = new Map<string, 'restart' | 'failed'>()
  readonly reachAsks: { sessionId: string; appId: string; projectId: string | null }[] = []
  /** A bundle is sent only once, as on the host */
  private readonly errorsSent = new Map<string, number>()
  readonly errorSends: { appId: string; projectId: string | null; at: number; machine?: string }[] = []
  errorReads = 0
  sendErrorGate: Promise<void> | null = null
  readonly createdApps: NewAppSpec[] = []
  /** `projects.create`, wired by the mock platform: an app made without a project gets its own (#1141) */
  makeProject: ((name: string, parent?: string) => Promise<ProjectInfo>) | null = null
  readonly builderAsks: BuilderAsk[] = []
  /** As the host's `deliver`, with `user_message` too: the UI did not draw a message the host injected */
  private deliverToBuilder(sessionId: string, text: string, attachments?: Attachment[]): void {
    const s = this.store.sessions.get(sessionId)
    if (!s) throw mockError(`Session not found: ${sessionId}`, 'session_not_found')
    s.live = true
    this.emit({ type: 'user_message', sessionId, seq: (this.store.messages.get(sessionId)?.length ?? 0) + 1, text, ...(attachments?.length ? { attachments } : {}) })
    this.emit({ type: 'state_change', sessionId, state: 'working' })
  }
  readonly apps = {
    /**
     * As `ExternalApps.createApp`: the same checks in the host's exact wording (a test checks the window shows it
     * as-is). The app stays even if the builder session fails to start.
     */
    create: async (spec: NewAppSpec): Promise<AppCreated> => {
      this.createdApps.push(structuredClone(spec))
      const idProblem = newAppIdProblem(spec.id)
      if (idProblem) throw new Error(appIdProblemText(spec.id, idProblem))
      const name = spec.name.replace(/\s+/g, ' ').trim()
      if (!name) throw new Error('The app needs a name')
      let dir = `/mock/data/apps/${spec.id}`
      let projectId = spec.projectId
      if (projectId === null) {
        // As the host (#1141): a trusted project `<parent>/<id>` (~/Centralu) with the app at its root (`projects.create`)
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
      if (spec.projectId !== null && this.registry.externalAppList.some((a) => sameApp(a, { appId: spec.id, projectId: spec.projectId }))) {
        throw new Error(`An app "${spec.id}" already exists (${dir}) — use another id`)
      }
      const app: ExternalAppInfo = {
        appId: spec.id,
        projectId,
        dir,
        name,
        version: '0.1.0',
        description: spec.description?.replace(/\s+/g, ' ').trim() || `${name} (a Centralu app)`,
        // The real template's home tool (app-template/centralu.app.json)
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
    /** As the host's `AppSessions.createAppBuilder`: one per app, never for an untrusted one */
    createBuilder: async (appId: string, projectId: string | null, tool?: ToolName, machine?: string): Promise<SessionInfo> => {
      const key = appKeyOf(projectId, appId)
      const have = this.registry.appBuilders.get(key)
      const held = have ? this.store.sessions.get(have) : undefined
      if (held) return structuredClone(held)
      const app = this.registry.externalAppList.find((a) => sameApp(a, { appId, projectId, machine }))
      if (!app) throw new Error(noSuchAppText({ projectId, appId }))
      if (!app.trusted) {
        throw new Error('Centralu does not give a builder to an app in a project it does not trust — trust the project, and the app can start and be tested')
      }
      const project = projectId ? this.projectStore.list.find((p) => p.id === projectId) : undefined
      const chosen = tool ?? (project ? project.defaultTool : this.assistantMock.assistantTool) ?? this.toolsMock.firstRegisteredTool()
      const detected = this.toolsMock.detected.find((t) => t.name === chosen)
      if (!detected?.installed || !detected.loggedIn) {
        throw new Error(`Could not start ${chosen} session: ${detected?.detail ?? `${chosen} is not installed`}`)
      }
      const id = `mock-session-${this.clock.next()}`
      const info = mockSessionInfo({
        id,
        projectId,
        tool: chosen,
        externalId: `ext-${id}`,
        name: `${app.name ?? appId} · builder`,
        createdAt: this.clock.now(),
        roleAppend: `(mock builder role for ${appId})`,
        appId,
      })
      this.store.sessions.set(id, info)
      this.registry.appBuilders.set(key, id)
      this.emit({ type: 'session_created', sessionId: id, session: structuredClone(info) })
      return structuredClone(info)
    },
    /** "Fix this", as builder-requests.ts: the same wording and the same `builderRequestOf`, fed what the mock knows */
    askBuilder: async (req: BuilderAsk): Promise<{ sessionId: string }> => {
      this.builderAsks.push(structuredClone(req))
      const key = appKeyOf(req.projectId, req.appId)
      const builderId = this.registry.appBuilders.get(key)
      let view: { uri: string } | null | undefined
      if (req.instanceId) {
        const inst = this.registry.pinnedInstances.get(req.instanceId)
        view = inst && sameApp(inst, { appId: req.appId, projectId: req.projectId }) ? { uri: inst.uri } : null
      }
      const built = builderRequestOf({
        text: req.text,
        hasAttachments: !!req.attachments?.length,
        app: this.registry.externalAppList.find((a) => sameApp(a, { appId: req.appId, projectId: req.projectId })),
        builder: builderId && this.store.sessions.has(builderId) ? builderId : null,
        view,
        latestRun: this.registry.appRuns.get(key)?.[0],
      })
      if ('refusal' in built) throw new Error(built.refusal)
      this.deliverToBuilder(built.builder, built.frame, req.attachments)
      return { sessionId: built.builder }
    },
    /** A test fills `appErrors`, most recent first */
    errors: async (appId: string, projectId: string | null, machine?: string): Promise<{ latest: AppErrorBundle | null; recent: AppErrorBundle[] }> => {
      this.errorReads++
      const key = appKeyOf(projectId, appId, machine)
      const recent = (this.registry.appErrors.get(key) ?? []).map((b) => ({ ...structuredClone(b), sentAt: this.errorsSent.get(`${key}\n${b.kind}\n${b.at}`) ?? null }))
      return { latest: recent[0] ?? null, recent }
    },
    /**
     * Decision 4 of #308 as session-apps.ts `reach` takes it: scope, then trust, then the app's state.
     * `appAttachments` stands for what a live Codex thread has, which only the host knows.
     */
    reach: async (sessionId: string, appId: string, projectId: string | null): Promise<AppReach> => {
      this.reachAsks.push({ sessionId, appId, projectId })
      const s = this.store.sessions.get(sessionId)
      if (!s) throw new Error(`Session not found: ${sessionId}`)
      const app = this.registry.externalAppList.find((a) => sameApp(a, { projectId, appId }))
      if (!app) return { reachable: false, reason: 'unavailable' }
      const key = appKeyOf(projectId, appId)
      const given =
        (isAssistantKind(s.kind) ? projectId === null : s.projectId !== null && s.projectId === projectId) ||
        this.registry.appBuilders.get(key) === sessionId
      if (!given) return { reachable: false, reason: 'other-project' }
      if (app.status === 'untrusted') return { reachable: false, reason: 'untrusted' }
      if (app.status === 'invalid' || app.status === 'unconfirmed' || app.status === 'failed') {
        return { reachable: false, reason: 'app-unusable', status: app.status }
      }
      // Turned off on this computer (#1938), as the host's `unusableAs` reads it
      if (app.off === true) return { reachable: false, reason: 'app-unusable', status: 'off' }
      const live = this.appAttachments.get(`${sessionId} ${key}`)
      if (live === 'restart') return { reachable: false, reason: 'restart' }
      if (live === 'failed') return { reachable: false, reason: 'bridge-failed' }
      return { reachable: true }
    },
    /** As builder-requests.ts: the same wording, each bundle once (recorded first), framed by `builderErrorFrame` */
    sendError: async (appId: string, projectId: string | null, at: number, machine?: string): Promise<{ sessionId: string }> => {
      this.errorSends.push(machine ? { appId, projectId, at, machine } : { appId, projectId, at })
      // A test holds the send open to check whether the screen takes a second click
      if (this.sendErrorGate) await this.sendErrorGate
      const key = appKeyOf(projectId, appId)
      const info = this.registry.externalAppList.find((a) => sameApp(a, { appId, projectId, machine }))
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
    private readonly assistantMock: AssistantMock,
  ) {}
}
