import { appKeyOf, noSuchAppText, sameApp } from '@cc/protocol/client'
import type { AppRun, ExternalAppInfo } from '@cc/protocol/client'
import type { AppCallOrigin, AppHomeView, AppResourceResult, AppToolResult, AppViewFrame, InlineViewKept, InlineViewReopened } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { AppRegistry } from './app-registry.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** App screens (M4 B): pinned and in-conversation views, tool calls from a screen, runs, restart and removal */
export class AppsMock {
  private readonly homeOpens = new Map<string, AppHomeView>()
  readonly heldViews: string[][] = []
  readonly restarts: { appId: string; projectId: string | null }[] = []
  appRunReads = 0
  /** A test plugs in the real runtime's `ExternalApps.runs` */
  appRunsProvider: ((appId: string, projectId: string | null, limit: number) => AppRun[] | Promise<AppRun[]>) | null = null
  readonly removedApps: string[] = []
  readonly openedViews: { appId: string; projectId: string | null; machine?: string }[] = []
  readonly closedViews: string[] = []
  readonly viewMessages: { sessionId: string; instanceId: string; text: string }[] = []
  readonly reopenedViews: { sessionId: string; callId: string }[] = []
  /** A test plugs in the real ViewHost */
  inlineInstanceProvider: ((appId: string, projectId: string | null) => string | Promise<string>) | null = null
  openViewProvider: ((appId: string, projectId: string | null, openKey?: string, recover?: boolean) => Promise<AppHomeView>) | null = null
  viewFrameProvider:
    | ((appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => Promise<AppViewFrame>)
    | null = null
  readonly appToolCalls: { appId: string; tool: string; args: Record<string, unknown>; from: AppCallOrigin }[] = []
  appToolHandler: ((appId: string, tool: string, args: Record<string, unknown>, from: AppCallOrigin) => AppToolResult | Promise<AppToolResult>) | null =
    null
  readonly appResources = new Map<string, AppResourceResult>()
  readonly appResourceReads: { appId: string; uri: string; from: AppCallOrigin }[] = []
  readonly apps = {
    /** No host, so no address: e2e/app-frame.spec.ts plugs in the real host's proxy */
    viewFrame: async (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => {
      if (!this.viewFrameProvider) throw new Error('This app view is not open')
      return this.viewFrameProvider(appId, instanceId, opts)
    },
    /** The default answer echoes the call; the answer is the app's MCP result as `apps.invoke` gives it */
    callTool: async (appId: string, tool: string, args: Record<string, unknown>, from?: AppCallOrigin) => {
      const origin: AppCallOrigin = { ...from, projectId: from?.projectId ?? null }
      this.appToolCalls.push({ appId, tool, args, from: origin })
      if (this.appToolHandler) return this.appToolHandler(appId, tool, args, origin)
      return { content: [{ type: 'text', text: `mock: ${tool}` }], structuredContent: { appId, tool, args } }
    },
    readResource: async (appId: string, uri: string, from?: AppCallOrigin) => {
      this.appResourceReads.push({ appId, uri, from: from ?? {} })
      const found = this.appResources.get(`${appId} ${uri}`)
      if (!found) throw new Error(`No resource ${uri} in app ${appId}`)
      return found
    },
    list: async (): Promise<ExternalAppInfo[]> =>
      structuredClone(this.registry.externalAppList).map((a) => {
        const at = this.registry.appErrors.get(appKeyOf(a.projectId, a.appId, a.machine))?.[0]?.at
        return at === undefined ? a : { ...a, lastErrorAt: at }
      }),
    /** e2e/apps.spec.ts plugs in the real ViewHost; without it, an instance with an empty result */
    openView: async (appId: string, projectId: string | null, machine?: string, openKey?: string, recover = false): Promise<AppHomeView> => {
      this.openedViews.push(machine ? { appId, projectId, machine } : { appId, projectId })
      const previous = openKey ? this.homeOpens.get(openKey) : undefined
      if (recover && !this.openViewProvider && !previous) throw new Error('The original app open could not be recovered')
      const v: AppHomeView = this.openViewProvider
        ? await this.openViewProvider(appId, projectId, openKey, recover)
        : previous ?? {
            instanceId: `mock-view-${this.clock.next()}`,
            tool: 'home',
            resourceUri: `ui://${appId}/home`,
            toolInput: {},
            toolResult: { content: [{ type: 'text', text: 'mock home' }] },
            runId: `mock-run-${this.clock.id}`,
          }
      if (openKey) this.homeOpens.set(openKey, v)
      this.registry.pinnedInstances.set(v.instanceId, { appId, projectId, uri: v.resourceUri })
      return v
    },
    /** As the host: an id no longer held (closed, or its lease ran out) is missing */
    holdViews: async (instanceIds: string[]) => {
      this.heldViews.push([...instanceIds])
      return instanceIds.filter((id) => !this.registry.pinnedInstances.has(id) || this.closedViews.includes(id))
    },
    closeView: async (instanceId: string) => {
      this.closedViews.push(instanceId)
      for (const [key, home] of this.homeOpens) if (home.instanceId === instanceId) this.homeOpens.delete(key)
      // An in-conversation screen's record (input, outcome) stays, as on the host
      for (const rec of this.registry.inlineRecords.values()) if (rec.instanceId === instanceId) rec.instanceId = null
    },
    /** Recorded as `fromApp`; wrapping it for the agent is the host's appMessageFrame */
    sendViewMessage: async (sessionId: string, instanceId: string, text: string) => {
      // As the host: an in-conversation screen only to its conversation, a pinned one to the person's choice
      const inline = this.registry.inlineInstances.get(instanceId)
      if (inline && inline.sessionId !== sessionId) throw new Error('This app view is not open in that conversation')
      const owner = inline ?? this.registry.pinnedInstances.get(instanceId)
      if (!owner) throw new Error('This app view is not open')
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
      const name = this.registry.externalAppList.find((a) => sameApp(a, { appId: owner.appId, projectId: owner.projectId }))?.name ?? owner.appId
      const fromApp = { appId: owner.appId, projectId: owner.projectId, name }
      this.viewMessages.push({ sessionId, instanceId, text })
      this.emit({ type: 'user_message', sessionId, seq: (this.store.messages.get(sessionId)?.length ?? 0) + 1, text, fromApp })
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    /** As the host, without calling the tool again; the size cap is the host's, tested in agent-host */
    /** Without bodies; an outcome that arrived as `kept: false` is already gone */
    inlineViews: async (sessionId: string): Promise<InlineViewKept[]> =>
      [...this.registry.inlineRecords.entries()]
        .filter(([key]) => key.startsWith(`${sessionId} `))
        .map(([key, rec]) => ({
          callId: key.slice(sessionId.length + 1),
          appId: rec.appId,
          projectId: rec.projectId,
          tool: rec.tool,
          kept: true,
          instanceId: rec.instanceId,
        })),
    reopenInlineView: async (sessionId: string, callId: string): Promise<InlineViewReopened> => {
      this.reopenedViews.push({ sessionId, callId })
      const rec = this.registry.inlineRecords.get(`${sessionId} ${callId}`)
      if (!rec) throw new Error("This view's result is no longer kept. Open the app instead")
      const instanceId = rec.instanceId ?? (this.inlineInstanceProvider
        ? await this.inlineInstanceProvider(rec.appId, rec.projectId)
        : `mock-inline-${this.clock.next()}`)
      this.registry.inlineInstances.set(instanceId, { sessionId, appId: rec.appId, projectId: rec.projectId })
      rec.instanceId = instanceId
      return {
        instanceId,
        appId: rec.appId,
        projectId: rec.projectId,
        tool: rec.tool,
        toolInput: rec.toolInput,
        ...(rec.toolResult ? { toolResult: rec.toolResult } : {}),
        ...(rec.cancelled !== undefined ? { cancelled: rec.cancelled } : {}),
      }
    },
    /** As the host: `stopped`, not started; the next screen opened starts it */
    /** As the host: a user-folder app only */
    remove: async (appId: string, projectId: string | null, machine?: string) => {
      if (projectId !== null) throw new Error("A project app is part of the project's repository — remove it there")
      const at = this.registry.externalAppList.findIndex((a) => sameApp(a, { appId, projectId: null, machine }))
      if (at === -1) throw new Error(noSuchAppText({ projectId: null, appId }))
      this.registry.externalAppList.splice(at, 1)
      this.removedApps.push(appId)
      this.emit({ type: 'external_apps_changed' })
    },
    runs: async (appId: string, projectId: string | null, limit = 100): Promise<AppRun[]> => {
      this.appRunReads++
      if (this.appRunsProvider) return structuredClone(await this.appRunsProvider(appId, projectId, limit))
      return structuredClone((this.registry.appRuns.get(appKeyOf(projectId, appId)) ?? []).slice(0, limit))
    },
    restart: async (appId: string, projectId: string | null, machine?: string) => {
      this.restarts.push({ appId, projectId })
      const a = this.registry.externalAppList.find((x) => sameApp(x, { appId, projectId, machine }))
      if (!a) throw new Error(noSuchAppText({ projectId, appId }))
      if (a.status === 'failed' || a.status === 'crashed' || a.status === 'running') Object.assign(a, { status: 'stopped', error: null })
      // Its process went, and a busy hold with it (#1236)
      delete a.busy
      this.emit({ type: 'external_apps_changed' })
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly store: SessionStore,
    private readonly registry: AppRegistry,
  ) {}
}
