import type {
  AppErrorBundle,
  AppReach,
  AppId,
  AppPermission,
  AppUsage,
  AppQuestion,
  AppReview,
  AppRun,
  AppVersions,
  Attachment,
  ExternalAppInfo,
  SessionInfo,
  ToolName,
} from '@cc/protocol/client'
import type { MachineRef } from './common.js'

/** Where to mount one app screen (M4 B-3). `url` holds a secret that changes every run: never logged or shown */
export type AppViewFrame = {
  url: string
  /** Only the capabilities the app declared and the host accepted */
  allow: string
  /** Reported to the screen as `hostCapabilities.sandbox` */
  sandbox: {
    csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] }
    permissions: Record<string, object>
  }
}

/** The calling screen: an app is (project, id), `null` a user-folder app; the host checks `instanceId` against it */
export type AppCallOrigin = { projectId?: string | null; instanceId?: string }

/** An MCP `tools/call` response, exactly per spec */
export type AppToolResult = {
  content: Record<string, unknown>[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/** A pinned screen (M4 B-2): the instance opened by calling `home`, with that call's input and result */
export type AppHomeView = {
  instanceId: string
  tool: string
  resourceUri: string
  toolInput: Record<string, unknown>
  toolResult: AppToolResult
  runId: string
}

/** A reopened in-conversation screen (M4 B-1): `toolResult` or `cancelled` once it finished, neither while it runs */
export type InlineViewReopened = {
  instanceId: string
  appId: AppId
  projectId: string | null
  tool: string
  toolInput: Record<string, unknown>
  toolResult?: AppToolResult
  cancelled?: string
}

export type InlineViewKept = {
  callId: string
  appId: AppId
  projectId: string | null
  tool: string
  kept: boolean
  instanceId: string | null
}

/** An MCP `resources/read` response */
export type AppResourceResult = { contents: ({ uri: string } & Record<string, unknown>)[] } & Record<string, unknown>

/**
 * `projectId` null: a new project of its own (#1141), folder `<parent>/<id>` (`~/Centralu` without `parent`). Without
 * `tool` the host picks the project's default, or the Assistant's for a new app project.
 */
export type NewAppSpec = { projectId: string | null; id: string; name: string; description?: string; tool?: ToolName; parent?: string }

/** `builder` null with `builderError` when the session failed to start; the app exists either way */
export type AppCreated = { app: ExternalAppInfo; builder: SessionInfo | null; builderError?: string }

/**
 * M4 C-5. `instanceId`: the pinned screen the person was viewing, named in the message's header. Attachments are
 * already saved under the builder session's id.
 */
export type BuilderAsk = {
  appId: AppId
  projectId: string | null
  text: string
  attachments?: Attachment[]
  instanceId?: string
  /** A linked machine's user-folder app (#82); a project app's id already names its machine */
  machine?: string
}

/** docs/apps/broker-and-rpcs.md "RPCs and events", and the documents it links, hold the contracts not noted here */
export interface AppsPort {
  /** The sandbox proxy talks only with `hostOrigin`, the calling screen's `location.origin` (M4 B-3) */
  viewFrame(appId: AppId, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }): Promise<AppViewFrame>
  /**
   * The bridge's `oncalltool`: the app's MCP result as is; an unreachable app is an `isError` result with the host's
   * reason. Scope (`app` only) and logging are the host's.
   */
  callTool(appId: AppId, tool: string, args: Record<string, unknown>, from?: AppCallOrigin): Promise<AppToolResult>
  readResource(appId: AppId, uri: string, from?: AppCallOrigin): Promise<AppResourceResult>
  list(): Promise<ExternalAppInfo[]>
  /** Rejects with a reason without a home or a declared screen, or when the app is unreachable (M4 B-2) */
  openView(appId: AppId, projectId: string | null, machine?: string, openKey?: string, recover?: boolean): Promise<AppHomeView>
  /** Releases the app it held; quiet when already closed */
  closeView(instanceId: string): Promise<void>
  holdViews(instanceIds: string[]): Promise<string[]>
  /** Recorded as `user_message.fromApp`; the agent gets it wrapped in the app's own text */
  sendViewMessage(sessionId: string, instanceId: string, text: string): Promise<void>
  /**
   * Does not call the tool again (M4 B-1): a new instance with the input and outcome the host held. Rejects when it
   * holds none; opening the app is then the only way.
   */
  reopenInlineView(sessionId: string, callId: string): Promise<InlineViewReopened>
  /**
   * For a past card's placeholder (M4 B-1). `kept`: it can be reopened; `instanceId`: an instance left open, which the
   * reopen UI closes to release the app.
   */
  inlineViews(sessionId: string): Promise<InlineViewKept[]>
  restart(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<void>
  /** Newest first (M4 B-7); arguments only as a summary; readable after the app's folder is gone */
  runs(appId: AppId, projectId: string | null, limit?: number, machine?: MachineRef): Promise<AppRun[]>
  /**
   * A user-folder app's folder moves to the data folder's `app-trash/`; run history stays (M4 A-7). Rejected for a
   * project app: git collects that.
   */
  remove(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<void>
  /**
   * The "New app" window's door, the same as the Assistant's `create_app` (M4 C-1). The host checks name, trust and
   * id; a rejection's message is the reason. Does not start the app.
   */
  create(spec: NewAppSpec): Promise<AppCreated>
  /** null: never created, or deleted (M4 C-2) */
  builder(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<SessionInfo | null>
  /** Returns the existing one if there is one */
  createBuilder(appId: AppId, projectId: string | null, tool?: ToolName, machine?: MachineRef): Promise<SessionInfo>
  /**
   * "Fix this" (M4 C-5): the host adds a header naming the app and screen, and a stall or a failed last run. Rejects
   * without a builder session.
   */
  askBuilder(req: BuilderAsk): Promise<{ sessionId: string }>
  errors(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<{ latest: AppErrorBundle | null; recent: AppErrorBundle[] }>
  reach(sessionId: string, appId: AppId, projectId: string | null): Promise<AppReach>
  sendError(appId: AppId, projectId: string | null, at: number, machine?: MachineRef): Promise<{ sessionId: string }>
  /** A chain started in a session asks on its approval card (`capability`) instead (M4 D-4) */
  questions(): Promise<AppQuestion[]>
  /** Remembered for that app and capability; rejected when the question is closed */
  answerQuestion(questionId: string, decision: 'allow' | 'deny'): Promise<void>
  permissions(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<AppPermission[]>
  forgetPermission(appId: AppId, projectId: string | null, capability: string, machine?: MachineRef): Promise<void>
  usage(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<AppUsage>
  /**
   * `null` deletes (M4 E). The value lives only in a 0600 file on the host and never comes back; `list` says only
   * whether each declared name is set. Only declared names; a running app reads it when it next needs it.
   */
  setSecret(appId: AppId, projectId: string | null, name: string, value: string | null, machine?: MachineRef): Promise<void>
  /**
   * Off by default (#371): a session in another project can attach it once the person allows that pair of projects.
   * Off detaches it from every session.
   */
  setShared(appId: AppId, projectId: string, shared: boolean): Promise<void>
  /**
   * For the copy of an app another computer runs for the same repository (#1938): off, it never starts here, no session
   * here gets it, and a running copy stops.
   */
  setOff(appId: AppId, projectId: string, off: boolean): Promise<void>
  importPrepare(source: string): Promise<{ token: string; review: AppReview }>
  importCommit(token: string, opts: { enable: boolean; reviewKey?: string; parent?: string }): Promise<ExternalAppInfo>
  importCancel(token: string): Promise<void>
  /** Not yet enabled, or `server`/`uses` changed since; `changed` is then the enabled declaration (M4 E-3) */
  review(appId: AppId, projectId: string | null): Promise<AppReview>
  enable(appId: AppId, projectId: string | null, reviewKey: string): Promise<ExternalAppInfo>
  versions(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<AppVersions>
  restoreVersion(appId: AppId, projectId: string | null, id: string, machine?: MachineRef): Promise<ExternalAppInfo>
}
