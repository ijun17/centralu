import { appKeyOf, noSuchAppText } from '@cc/protocol'
import type { AppRun, ExternalAppInfo } from '@cc/protocol'
import type { AppCallOrigin, AppHomeView, AppResourceResult, AppToolResult, AppViewFrame, InlineViewKept, InlineViewReopened } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { AppRegistry } from './app-registry.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** App screens (M4 B): pinned and in-conversation views, tool calls from a screen, runs, restart and removal */
export class AppsMock {
  private readonly homeOpens = new Map<string, AppHomeView>()
  /** Every `holdViews` call, in order (#392) */
  readonly heldViews: string[][] = []
  /** Apps asked to restart — tests check whether the Restart button reached the host */
  readonly restarts: { appId: string; projectId: string | null }[] = []
  /** How many times the history has been read — tests check it is re-read when "changed" arrives */
  appRunReads = 0
  /** If set, history is read from here instead — a test plugs in the real runtime's history (`ExternalApps.runs`) */
  appRunsProvider: ((appId: string, projectId: string | null, limit: number) => AppRun[] | Promise<AppRun[]>) | null = null
  /** A deleted user-folder app — tests check it only reaches the host after confirmation */
  readonly removedApps: string[] = []
  /** Pinned screens opened and instances closed — tests check "how many times opened," "released on close" */
  readonly openedViews: { appId: string; projectId: string | null; machine?: string }[] = []
  readonly closedViews: string[] = []
  /** Messages an in-conversation screen sent into the conversation — tests check these only reach here after the person confirms */
  readonly viewMessages: { sessionId: string; instanceId: string; text: string }[] = []
  /** Reopened screens — tests check whether "Reopen" reached the host */
  readonly reopenedViews: { sessionId: string; callId: string }[] = []
  /** The side that builds a new instance when reopening (a test plugs in the real ViewHost) */
  inlineInstanceProvider: ((appId: string, projectId: string | null) => string | Promise<string>) | null = null
  openViewProvider: ((appId: string, projectId: string | null, openKey?: string, recover?: boolean) => Promise<AppHomeView>) | null = null
  /** The side that builds a screen's address (a test plugs this in) */
  viewFrameProvider:
    | ((appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => Promise<AppViewFrame>)
    | null = null
  /** Tools called from a screen — tests check what went out under which app's name */
  readonly appToolCalls: { appId: string; tool: string; args: Record<string, unknown>; from: AppCallOrigin }[] = []
  appToolHandler: ((appId: string, tool: string, args: Record<string, unknown>, from: AppCallOrigin) => AppToolResult | Promise<AppToolResult>) | null =
    null
  /** `${appId} ${uri}` → the read result */
  readonly appResources = new Map<string, AppResourceResult>()
  readonly appResourceReads: { appId: string; uri: string; from: AppCallOrigin }[] = []
  readonly apps = {
    /**
     * The app screen (M4 B-3). There is no host in the mock, so no address can be constructed.
     * A test plugs in a function that starts the real host's proxy and supplies an address here
     * (e2e/app-frame.spec.ts). If nothing is plugged in, there is no screen.
     */
    viewFrame: async (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) => {
      if (!this.viewFrameProvider) throw new Error('This app view is not open')
      return this.viewFrameProvider(appId, instanceId, opts)
    },
    /**
     * A tool call from a screen — recorded, and answered with whatever a test plugged in. The
     * default answer echoes back what was called. Keeps the same contract as web. projectId
     * always travels along (null if absent), and the answer is exactly the shape of MCP result the
     * app gave (`apps.invoke`'s `result`).
     */
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
    // Like the host, carries the time of the most recent error bundle (M4 C-6) — a test supplies the mock's bundles (appErrors)
    list: async (): Promise<ExternalAppInfo[]> =>
      structuredClone(this.registry.externalAppList).map((a) => {
        const at = this.registry.appErrors.get(appKeyOf(a.projectId, a.appId, a.machine))?.[0]?.at
        return at === undefined ? a : { ...a, lastErrorAt: at }
      }),
    /**
     * A pinned screen (M4 B-2). The mock has neither an app process nor a ViewHost. A test
     * plugs in a function that opens an instance from the real ViewHost (e2e/apps.spec.ts). If
     * nothing is plugged in, this just records the call and fabricates an instance with an
     * empty result.
     */
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
      // Like the host's ViewHost, holds which app and screen the instance belongs to — "this came from that screen" is checked against this
      if (openKey) this.homeOpens.set(openKey, v)
      this.registry.pinnedInstances.set(v.instanceId, { appId, projectId, uri: v.resourceUri })
      return v
    },
    /** Like the host: an id it no longer holds (closed, or dropped by a test as if its lease ran out) is missing */
    holdViews: async (instanceIds: string[]) => {
      this.heldViews.push([...instanceIds])
      return instanceIds.filter((id) => !this.registry.pinnedInstances.has(id) || this.closedViews.includes(id))
    },
    closeView: async (instanceId: string) => {
      this.closedViews.push(instanceId)
      for (const [key, home] of this.homeOpens) if (home.instanceId === instanceId) this.homeOpens.delete(key)
      // If it was an in-conversation screen, that record's instance also closes — like the host, the record (input, outcome) stays
      for (const rec of this.registry.inlineRecords.values()) if (rec.instanceId === instanceId) rec.instanceId = null
    },
    /**
     * A message from an app screen (M4 B-1·B-4). Like the real thing: an in-conversation
     * screen only accepts one for the conversation it belongs to, a pinned screen accepts
     * whichever conversation the person chose, and it is recorded in the conversation as a
     * message the app sent (`fromApp`). Wrapping it in the shape the agent receives is the
     * host's job (manager's appMessageFrame), so here it just records what came in.
     */
    sendViewMessage: async (sessionId: string, instanceId: string, text: string) => {
      // Like the real thing: an in-conversation screen only to that conversation, a pinned screen to whichever the person chose (the app is decided by the instance)
      const inline = this.registry.inlineInstances.get(instanceId)
      if (inline && inline.sessionId !== sessionId) throw new Error('This app view is not open in that conversation')
      const owner = inline ?? this.registry.pinnedInstances.get(instanceId)
      if (!owner) throw new Error('This app view is not open')
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError('Session not found', 'session_not_found')
      const name = this.registry.externalAppList.find((a) => a.appId === owner.appId && a.projectId === owner.projectId)?.name ?? owner.appId
      const fromApp = { appId: owner.appId, projectId: owner.projectId, name }
      this.viewMessages.push({ sessionId, instanceId, text })
      this.emit({ type: 'user_message', sessionId, seq: (this.store.messages.get(sessionId)?.length ?? 0) + 1, text, fromApp })
      this.emit({ type: 'state_change', sessionId, state: 'working' })
    },
    /**
     * Reopens a collapsed in-conversation screen (M4 B-1). Like the real thing: does not call
     * the tool again, and returns the held input and outcome with a new instance. The instance
     * is built by whatever a test plugged in (the real ViewHost). Rejects with the same wording
     * as the host if nothing is being held. The mock does not enforce the size cap — that is
     * the host's job, and its test lives in agent-host.
     */
    /** Like the real thing: the screens held for this conversation, without their bodies. The mock has already discarded an outcome that was too large (an outcome that arrived as `kept: false`) */
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
    /**
     * Like the real thing: clears the reason of an app that was stalled or dead, sets it up as
     * a resting app (`stopped`), then broadcasts the list. Does not start it — whichever screen
     * opens next does that.
     */
    /** Like the real thing: only deletes a user-folder app (rejects a project app), then broadcasts the list */
    remove: async (appId: string, projectId: string | null) => {
      if (projectId !== null) throw new Error("A project app is part of the project's repository — remove it there")
      const at = this.registry.externalAppList.findIndex((a) => a.appId === appId && a.projectId === null)
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
    restart: async (appId: string, projectId: string | null) => {
      this.restarts.push({ appId, projectId })
      const a = this.registry.externalAppList.find((x) => x.appId === appId && x.projectId === projectId)
      if (!a) throw new Error(noSuchAppText({ projectId, appId }))
      if (a.status === 'failed' || a.status === 'crashed' || a.status === 'running') Object.assign(a, { status: 'stopped', error: null })
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
