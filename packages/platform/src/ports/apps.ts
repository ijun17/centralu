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

/**
 * Where to mount one app screen (M4 B-3). Created by the host. `url` contains a secret slot
 * that changes on every run. Never written to a log or the screen.
 */
export type AppViewFrame = {
  url: string
  /** The outer iframe's `allow` — only the capabilities the app declared and the host accepted */
  allow: string
  /** The CSP domains and permissions the host accepted. Reported to the screen as `hostCapabilities.sandbox` */
  sandbox: {
    csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] }
    permissions: Record<string, object>
  }
}

/**
 * **Which screen** a call from a screen came from. An app is identified by (project, id), so
 * projectId travels with it (`null` is a user-folder app). If instanceId is present, the host
 * checks it against that screen's app.
 */
export type AppCallOrigin = { projectId?: string | null; instanceId?: string }

/** The shape of an MCP `tools/call` response (exactly per spec — this layer only carries it) */
export type AppToolResult = {
  content: Record<string, unknown>[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/**
 * One pinned screen (M4 B-2) — the screen instance the host opened by calling the `home`
 * tool, plus that call's input (tool-input) and result (tool-result), which AppFrame sends
 * per spec.
 */
export type AppHomeView = {
  instanceId: string
  tool: string
  resourceUri: string
  toolInput: Record<string, unknown>
  toolResult: AppToolResult
  runId: string
}

/**
 * A reopened in-conversation screen (M4 B-1) — the new instance, plus that call's input and
 * outcome, which AppFrame resends per spec.
 * The result (`toolResult`) and cancellation (`cancelled`) are either one or the other (it
 * finished), or neither (it is still running).
 */
export type InlineViewReopened = {
  instanceId: string
  appId: AppId
  projectId: string | null
  tool: string
  toolInput: Record<string, unknown>
  toolResult?: AppToolResult
  cancelled?: string
}

/** One in-conversation screen the host is holding (M4 B-1) — without its body */
export type InlineViewKept = {
  callId: string
  appId: AppId
  projectId: string | null
  tool: string
  kept: boolean
  instanceId: string | null
}

/** The shape of an MCP `resources/read` response */
export type AppResourceResult = { contents: ({ uri: string } & Record<string, unknown>)[] } & Record<string, unknown>

/**
 * One new app (M4 C-1) — `projectId` null means a new project of its own (#1141): a folder `<parent>/<id>`, in
 * `~/Centralu` without `parent`, whose root is the app. `tool` is the builder session's tool; if absent the host picks
 * one (the project's default tool, or the orchestrator's tool for a new app project).
 */
export type NewAppSpec = { projectId: string | null; id: string; name: string; description?: string; tool?: ToolName; parent?: string }

/**
 * The created app and its builder session. If the session failed to start (no tool, or not
 * logged in yet), `builder` is null and `builderError` is the reason — the app has already
 * been created either way.
 */
export type AppCreated = { app: ExternalAppInfo; builder: SessionInfo | null; builderError?: string }

/**
 * A message to the builder session, sent from an app (M4 C-5). `instanceId` is the pinned
 * screen the person was viewing — the host writes which screen it came from into the header,
 * using that instance. Attachments are already saved under the builder session's id (the
 * same path the composer uses).
 */
export type BuilderAsk = {
  appId: AppId
  projectId: string | null
  text: string
  attachments?: Attachment[]
  instanceId?: string
  /** A linked machine's user-folder app (#82): which machine. A project app's id already names its machine */
  machine?: string
}

/**
 * The external apps (M4) — discovery, their screens, and the calls those screens make.
 */
export interface AppsPort {
  /**
   * The address at which to mount an app screen (M4 B-3). `hostOrigin` is the origin
   * (`location.origin`) of the calling screen. The sandbox proxy exchanges messages only with
   * that origin.
   */
  viewFrame(appId: AppId, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }): Promise<AppViewFrame>
  /**
   * An app tool the screen calls (the bridge's `oncalltool`). The response is exactly the MCP
   * result the app gave (including `structuredContent`, `isError`, `_meta`). If the app could
   * not be reached, this is an `isError` result carrying a reason written by the host. Scope
   * (`app` only) and logging are handled by the host's mediation.
   */
  callTool(appId: AppId, tool: string, args: Record<string, unknown>, from?: AppCallOrigin): Promise<AppToolResult>
  /** The screen reads its own app's resource (the bridge's `onreadresource`) */
  readResource(appId: AppId, uri: string, from?: AppCallOrigin): Promise<AppResourceResult>
  /**
   * Every external app discovered, and its state (M4 A-8). Apps from an untrusted project and
   * broken apps come too, with a reason. When the list changes, the host broadcasts
   * `external_apps_changed`, and the receiver calls this again.
   */
  list(): Promise<ExternalAppInfo[]>
  /**
   * Opens a pinned screen (M4 B-2) — the host calls the manifest's `home` as the screen caller
   * and opens an instance. Fails with a reason if there is no home, the app did not declare a
   * screen, or the app could not be reached. `machine` names a linked machine for its user-folder
   * app (#82); a project app's id already names its machine.
   */
  /** Keep openKey unchanged; recover queries the original outcome without running home again. */
  openView(appId: AppId, projectId: string | null, machine?: string, openKey?: string, recover?: boolean): Promise<AppHomeView>
  /** Closes a pinned screen — releases the app it was holding. Passes quietly if it is already closed */
  closeView(instanceId: string): Promise<void>
  /**
   * Claims the pinned screens this window shows, after a reconnect (#392). A screen opened here is
   * leased to this window's connection, and the host closes it a few minutes after the connection
   * ends unless a window claims it. Resolves to the ids that are no longer open, to open again.
   */
  holdViews(instanceIds: string[]): Promise<string[]>
  /**
   * Sends an app screen's `ui/message` into the conversation (M4 B-1·B-4) — called **only
   * after the person confirms**. The host masks the app behind the instance. For an
   * in-conversation screen it can only go to the conversation that screen stands in (the host
   * rejects it otherwise); for a pinned screen it goes to whichever conversation the person
   * chose. It is recorded in the conversation as a message the app sent
   * (`user_message.fromApp`), and the agent receives it wrapped in the app's own text.
   */
  sendViewMessage(sessionId: string, instanceId: string, text: string): Promise<void>
  /**
   * Reopens an in-conversation screen that had been collapsed (M4 B-1's "Reopen") — does not
   * call the tool again. The host returns a new instance plus the input and outcome it had
   * been holding. Fails with a reason if it is not holding one (in that case, opening the app
   * is the only path left).
   */
  reopenInlineView(sessionId: string, callId: string): Promise<InlineViewReopened>
  /**
   * The in-conversation screens the host is holding for one conversation (M4 B-1) — queried
   * when the reopen UI is setting up the placeholder for a past card. `kept` means it can be
   * reopened; if `instanceId` is present, it is an instance left open (the reopen UI closes it
   * to release the app).
   */
  inlineViews(sessionId: string): Promise<InlineViewKept[]>
  /**
   * Makes the app startable again (M4 B-6's "Restart") — clears consecutive failures and the
   * reason, and brings it down if it is up.
   * **Does not start it up**: whoever calls next (the screen that reopens it) starts it.
   */
  restart(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<void>
  /**
   * One app's run history, most recent first (M4 B-7) — who (screen, session, app) called
   * which tool and how it ended. Arguments arrive only as a summary. The history is readable
   * even for an app whose folder is gone.
   */
  runs(appId: AppId, projectId: string | null, limit?: number, machine?: MachineRef): Promise<AppRun[]>
  /**
   * Deletes a user-folder app (M4 A-7) — its folder is moved to `app-trash/` in the data
   * folder, and the run history stays. The host rejects this for a project app (it is a file
   * in the repository, so git is where it gets collected).
   */
  remove(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<void>
  /**
   * Creates a new app from a template (M4 C-1) — called by the "New app" window. The same
   * door as the orchestrator's `create_app`. The host validates the name, trust and any
   * existing id; a rejection carries the reason as the error message (the window stays open
   * as it was). Does not start the app.
   */
  create(spec: NewAppSpec): Promise<AppCreated>
  /** That app's builder session (M4 C-2) — null if there is none (never created, or deleted) */
  builder(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<SessionInfo | null>
  /** Creates that app's builder session (M4 C-2) — returns the existing one if there already is one */
  createBuilder(appId: AppId, projectId: string | null, tool?: ToolName, machine?: MachineRef): Promise<SessionInfo>
  /**
   * "Fix this" (M4 C-5) — sends the message from the input line below an app screen to that
   * app's builder session. The host attaches a header noting which app and screen it came
   * from, and, if the app is stalled or the last run failed, that fact too. Rejects if there
   * is no builder session.
   * @returns the builder session the message went to
   */
  askBuilder(req: BuilderAsk): Promise<{ sessionId: string }>
  /**
   * One app's recent error bundles (M4 C-6) — moments the app failed to start, died, or a
   * tool failed. `latest` is what the screen displays. A bundle that has been sent to the
   * builder session carries `sentAt`.
   */
  errors(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<{ latest: AppErrorBundle | null; recent: AppErrorBundle[] }>
  /**
   * Whether a session can use one app's tools right now, and if not, why (#308). Asked when an item
   * dragged out of that app's view lands in the session's composer: the link goes in either way, and
   * the composer says what would fix a session that cannot reach the app.
   */
  reach(sessionId: string, appId: AppId, projectId: string | null): Promise<AppReach>
  /**
   * Sends one error bundle (`at`) to that app's builder session (M4 C-6) — **only when the
   * person clicks it.** Each bundle goes only once (the host rejects a second attempt).
   */
  sendError(appId: AppId, projectId: string | null, at: number, machine?: MachineRef): Promise<{ sessionId: string }>
  /**
   * The capability questions still waiting for an answer, among the chains that started from
   * a screen (M4 D-4). The pinned screen draws that app's questions, and the app row in the
   * sidebar shows "waiting for an answer". Re-read when the host broadcasts
   * `external_app_questions_changed`. Questions from a chain that started in a session are
   * not here — they are that session's approval card (`capability`).
   */
  questions(): Promise<AppQuestion[]>
  /** Answers a capability question (M4 D-4) — the answer is remembered for that app and that capability. The host rejects it if the question is already closed */
  answerQuestion(questionId: string, decision: 'allow' | 'deny'): Promise<void>
  /** The remembered capability answers for one app (M4 D-4) */
  permissions(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<AppPermission[]>
  /** Forgets one remembered answer (M4 D-4) — asks again the next time that capability is needed */
  forgetPermission(appId: AppId, projectId: string | null, capability: string, machine?: MachineRef): Promise<void>
  /** The agent usage one app has requested (M4 D-5) — the last day and the last 30 days */
  usage(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<AppUsage>
  /**
   * Sets or changes (`value`) or deletes (`null`) one of the app's secrets (M4 E). The value
   * lives only in a 0600 file on the host — it never comes back in this response or in any
   * listing. The list (`list`) only says whether each declared name is present or absent.
   * Only names the manifest declares can be set, and a running app picks up the new value the
   * next time it needs it.
   */
  setSecret(appId: AppId, projectId: string | null, name: string, value: string | null, machine?: MachineRef): Promise<void>
  /**
   * Shares a project app with the person's other projects, or stops (#371 part A). Off by default;
   * a session in another project can then find and attach it, once the person allows that pair of
   * projects. Turning it off detaches it from every session that attached it.
   */
  setShared(appId: AppId, projectId: string, shared: boolean): Promise<void>
  /**
   * Prepares to import an app (M4 E-3) — the host copies the source (a folder on this
   * machine, a local .zip, or a .zip over https) into a staging area and returns what the
   * person should review. **It has not been admitted yet.** Rejections (a link pointing
   * outside, zip slip, exceeding the size limit, a colliding id) are thrown exactly as the
   * host states them.
   */
  importPrepare(source: string): Promise<{ token: string; review: AppReview }>
  /**
   * Admits the app from staging as a project of its own (#1141): a folder `<parent>/<id>` (`~/Centralu` without
   * `parent`), registered untrusted, or trusted with `enable`, which also needs the key (`reviewKey`) from the window
   * the person reviewed. Does not start it
   */
  importCommit(token: string, opts: { enable: boolean; reviewKey?: string; parent?: string }): Promise<ExternalAppInfo>
  /** Cancels the import — clears the staging area */
  importCancel(token: string): Promise<void>
  /** The review window for an admitted app (M4 E-3) — an imported app not yet enabled, or one whose `server`/`uses` changed after being enabled. If it changed, `changed` is the declaration from when it was enabled */
  review(appId: AppId, projectId: string | null): Promise<AppReview>
  /** Enables an imported app — `reviewKey` is the key from the window the person reviewed. The host rejects it if the manifest changed in the meantime */
  enable(appId: AppId, projectId: string | null, reviewKey: string): Promise<ExternalAppInfo>
  /**
   * An app's versions (M4 E-1) — for a user-folder app, snapshots the host has kept (most
   * recent first, with `current` on the one matching the running code); for a project app,
   * the recent commits that touched that app's folder (git is the version history here,
   * read-only).
   */
  versions(appId: AppId, projectId: string | null, machine?: MachineRef): Promise<AppVersions>
  /**
   * Restores a user-folder app to a kept version (M4 E-1) — the host keeps a snapshot of the
   * current code as a version, then overwrites it and restarts with that code. The host
   * rejects this for a project app (git is where restoring happens there).
   */
  restoreVersion(appId: AppId, projectId: string | null, id: string, machine?: MachineRef): Promise<ExternalAppInfo>
}
