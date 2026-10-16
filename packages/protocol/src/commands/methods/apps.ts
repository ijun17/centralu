import { z } from 'zod'
import { AppReach } from '../../app-drag.js'
import {
  AppErrorBundle,
  AppId,
  AppPermission,
  AppQuestion,
  AppReview,
  AppRun,
  AppUsage,
  AppVersions,
  Attachment,
  ExternalAppInfo,
  ProjectConsent,
  ProjectConsentKind,
  ProjectId,
  SessionId,
  ToolName,
} from '../../entities.js'
import { machineParam } from '../machine-fields.js'
import { SessionInfo } from '../sessions.js'

const AppHomeViewResult = z.object({
  instanceId: z.string(),
  tool: z.string(),
  resourceUri: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  toolResult: z.looseObject({ content: z.array(z.record(z.string(), z.unknown())) }),
  runId: z.string(),
})

export const appMethods = {
  /**
   * The orchestrator tool — **the path a separate process (the bridge) uses to call back into
   * the host**.
   *
   * Claude attaches in-process, so it does not need this door. Codex can only attach a stdio
   * server through its per-thread config (HTTP did not work when measured), so it needs a
   * bridge, and the bridge makes no judgments itself — it only passes along a name and
   * arguments, and every rule stays in the host.
   */
  /**
   * The address at which an app's screen is served (M4 B-3). The host builds the sandbox proxy
   * address for it. That address's path sits behind a secret segment generated fresh on every
   * run, so only whoever knows the address can raise the screen. The secret only ever leaves
   * through this response (to a side already authenticated with the WebSocket token).
   *
   * A screen instance is created by a single tool call. The instance decides which app's screen
   * it is; `appId` and `projectId` are only checked against it. `hostOrigin` is the calling
   * screen's own origin (`location.origin`). It has to be on the same allowlist as the
   * WebSocket, and the proxy only exchanges messages with that origin.
   */
  'apps.viewFrame': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable().default(null),
      instanceId: z.string(),
      hostOrigin: z.string(),
    }),
    result: z.object({
      url: z.string(),
      allow: z.string(),
      sandbox: z.object({
        csp: z.object({
          connectDomains: z.array(z.string()),
          resourceDomains: z.array(z.string()),
          frameDomains: z.array(z.string()),
          baseUriDomains: z.array(z.string()),
        }),
        permissions: z.record(z.string(), z.object({})),
      }),
    }),
  },
  /**
   * What an open screen instance shows, for a hub that serves it in its own window (#82, remote hub phase 2,
   * docs/plans/remote-hub.md §11). A host asks this of a linked machine; the UI never needs it.
   *
   * The instance decides the app, as everywhere: the answer names it, the resource it reads, and the origin method
   * its manifest asks for. `resource` is the app's MCP `resources/read` answer as is: the hub reads the view out of it
   * and applies its own CSP, sandbox and origin rules, so nothing that decides a view's reach is taken from the other
   * machine as finished text. An instance that is not open there fails with a reason. Additive: an older host answers
   * "Unknown method", and the hub's window says that view cannot open until the versions are aligned.
   */
  'apps.viewDocument': {
    params: z.object({ instanceId: z.string() }),
    result: z.object({
      appId: AppId,
      projectId: z.string().nullable(),
      uri: z.string(),
      origin: z.enum(['opaque', 'app']),
      resource: z.looseObject({ contents: z.array(z.unknown()) }),
    }),
  },
  /**
   * Opens the pinned screen (M4 B-2). The host calls the manifest's `home` tool **as the screen
   * caller** (the one path used for this: visibility scope, run history), then opens a screen
   * instance at the `_meta.ui.resourceUri` that tool declared. The response has everything
   * AppFrame needs: the instance, and that call's input and result (the spec's tool-input,
   * tool-result).
   *
   * If there is no `home`, or that tool did not declare a screen, or the app cannot be reached
   * (not trusted, or failed to start), this fails with a reason and leaves no live screen behind. A
   * keyed open keeps only a failure reservation during the lease grace period, without holding the app. If
   * the app itself answered with a failure, this still opens — drawing a failure is also the
   * screen's job.
   *
   * `machine` (#82, additive) names a linked machine for its user-folder app, which has no project id to say so; the
   * hub opens it there and hands back the instance qualified. Ignored with a project, whose id already names its
   * machine. Absent: this host's own app, as before.
   */
  'apps.openView': {
    // openKey: one client-chosen UUID per logical open. Repeats reuse the instance and home outcome,
    // including after a planned host handover, so a lost answer never runs the home tool twice.
    /*
     * `lease` (#392, additive): the view belongs to this window's connection. Once the connection ends, the host waits
     * a few minutes for a window to claim it (`apps.holdViews`) and then closes it, so a reloaded or closed window does
     * not hold its apps open for good. Without it (an older window, or a linked machine's view) the view lives until
     * `apps.closeView`.
     */
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, lease: z.boolean().optional(), openKey: z.string().uuid().optional() }),
    result: AppHomeViewResult,
  },
  /**
   * Closes the pinned screen (M4 B-2). Releases the app the instance was holding on to — an app
   * with no open screen counts down toward idle (A-3). An instance that is already closed is
   * passed over silently (closing twice yields the same result).
   */
  'apps.closeView': {
    params: z.object({ instanceId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Reclaims a keyed home open after losing its answer; never calls the home tool. */
  'apps.recoverView': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, lease: z.boolean().optional(), openKey: z.string().uuid() }),
    result: AppHomeViewResult,
  },
  /**
   * A window claims the pinned screens it shows (#392), after every reconnect: each leased instance
   * named becomes this connection's again and stops waiting to be closed. `missing` lists the ids
   * that are not open any more (the window was away longer than the host waited); the window opens
   * those again. An instance opened without a lease is left as it is.
   */
  'apps.holdViews': {
    params: z.object({ instanceIds: z.array(z.string()).max(1000) }),
    result: z.object({ missing: z.array(z.string()) }),
  },
  /**
   * Reopens an inline conversation screen that had been collapsed (M4 B-1) — the "Reopen" for a
   * screen that fell out of virtual scroll or was pushed into a placeholder by the cap. **Does
   * not call the tool again**: the host opens a new instance and returns the input and outcome
   * (a result, or the cancellation reason) of that same call it was still holding — AppFrame
   * renders it again exactly to spec. If the call is still running, it arrives with no outcome
   * yet, and once it finishes, `app_view`'s result and cancelled fields arrive as usual.
   *
   * The host holds the input and result only in memory, size-capped (inline-views.ts). If it is
   * no longer holding them (too large, discarded for age, or the host restarted), this fails
   * with a reason, and the placeholder then only offers a way to open the app instead. Opening
   * this re-enforces the cap on live screens per conversation — the other, longest-open screen
   * may get closed with `closed`.
   */
  'apps.inlineReopen': {
    params: z.object({ sessionId: SessionId, callId: z.string() }),
    result: z.object({
      instanceId: z.string(),
      appId: AppId,
      projectId: z.string().nullable(),
      tool: z.string(),
      toolInput: z.record(z.string(), z.unknown()),
      toolResult: z.looseObject({ content: z.array(z.unknown()) }).optional(),
      cancelled: z.string().optional(),
    }),
  },
  /**
   * The inline conversation screens the host is holding for one conversation (M4 B-1) — asked by
   * a freshly reopened UI when it plants placeholders for past cards. If `kept` is true,
   * "Reopen" opens that screen without calling the tool again. If `instanceId` is present, that
   * instance is still open — since the freshly reopened UI does not know that frame, it closes
   * it to release the app. The body (input, result) is not carried here. If the host itself has
   * restarted, this comes back empty (what it was holding lived only in memory).
   */
  'apps.inlineViews': {
    params: z.object({ sessionId: SessionId }),
    result: z.array(
      z.object({
        callId: z.string(),
        appId: AppId,
        projectId: z.string().nullable(),
        tool: z.string(),
        kept: z.boolean(),
        instanceId: z.string().nullable(),
      }),
    ),
  },
  /**
   * An app screen's `ui/message` (M4 B-1, B-4) — called by the UI only after a person reads it
   * and chooses to send.
   *
   * The app is decided by **the instance** (#93, #94: the string that was validated is the one
   * that is used). Where it goes depends on where the screen lives:
   *   inline screen   the conversation that screen stands in. `sessionId` is only checked against
   *                   it and is rejected if it names a different conversation.
   *   pinned screen   since it does not belong to a conversation, the conversation is whatever
   *                   the person chose (the UI asks first). Rejected unless it is an open instance.
   * Either way it lands in the conversation as text the app sent (`user_message.fromApp`), and
   * what goes to the agent is the shape the host wraps as "app text" — for a pinned screen, it
   * also states that this came from outside the conversation.
   */
  'apps.viewMessage': {
    params: z.object({ sessionId: SessionId, instanceId: z.string(), text: z.string().min(1).max(64_000) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * A screen reads its own app's resource (M4 B-3, the bridge's `onreadresource`). The response
   * is exactly the result of MCP's `resources/read`. The spec's shape is known to the screen and
   * the app; this layer only carries it. If `instanceId` is given, it must match that screen's app.
   */
  'apps.readResource': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable().default(null),
      uri: z.string(),
      instanceId: z.string().optional(),
    }),
    result: z.looseObject({ contents: z.array(z.looseObject({ uri: z.string() })) }),
  },
  /**
   * A screen calls an app tool (M4 A-4).
   *
   * An app is unique per (project, id), so `projectId` distinguishes it (null or absent = a
   * user-folder app). The caller is recorded **as a screen**, and only tools open to a screen
   * (with `app` in `visibility`) can be called. `result` is exactly the app's own answer (the
   * shape the screen's AppBridge receives). If `status` is `rejected`, the host never sent it to
   * the app at all — the reason is in `text`.
   *
   * This door once also served the compiled-in apps (#81); they were removed in #372.
   */
  'apps.invoke': {
    params: z.object({
      appId: AppId,
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      projectId: ProjectId.nullable().optional(),
      /** The calling screen's instance — the caller's own screen is the one that skips the "changed" event (`external_app_state_changed.cause`) this call produces */
      instanceId: z.string().optional(),
    }),
    result: z.object({
      text: z.string(),
      isError: z.boolean().optional(),
      status: z.enum(['ok', 'error', 'cancelled', 'rejected']).optional(),
      runId: z.string().optional(),
      result: z.unknown().optional(),
    }),
  },
  /**
   * Discovered external apps (M4 A-2) — project apps and user-folder apps. Apps from an
   * untrusted project and apps with a broken manifest are listed too, with a reason (`status`,
   * `error`): hiding them would leave nowhere to ask why they do not show up.
   */
  'apps.list': { params: z.object({}), result: z.array(ExternalAppInfo) },
  /**
   * Lets a stopped (`failed`) external app be started again — clears the run of consecutive
   * failures, and takes it down if it happens to be up. **Does not start it**: whatever calls
   * next starts it (the same principle: it starts only the first time it is actually needed).
   */
  /** The run history of one external app, most recent first (M4 A-6 — read by the run history screen B-7) */
  'apps.runs': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, limit: z.number().int().min(1).max(500).default(100) }),
    result: z.array(AppRun),
  },
  'apps.restart': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Removes an external app in the user folder (M4 A-7) — the way to withdraw an approved MCP
   * server (an app with no screen). Its folder is moved to `app-trash/` in the data folder, and
   * it is detached from any session it was attached to. A project app (one with a `projectId`)
   * is rejected — since it is a file in the repository, git is where it gets withdrawn. The
   * relevant list is `apps.list`'s apps with `projectId: null`.
   */
  'apps.remove': {
    /** `machine` (#82, additive): a linked machine's user-folder app, removed on that machine; this host's app of the same id is untouched */
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Creates a new app from a template (M4 C-1b) — called by the "new app" button. The same door
   * as the orchestrator's `create_app`. If `projectId` is given, it is created at
   * `.centralu/apps/<id>/` in that project (only if trusted); if null, it goes in the user
   * folder. `id` is both the folder name and becomes `app-<id>` in a session: lowercase, digits
   * and hyphens, up to 32 characters, may not start with `centralu` or `app-`. An id that
   * already exists, an untrusted project, or an invalid name fails with a reason and creates
   * nothing. The app is not started — it starts only the first time it is actually needed.
   */
  'apps.create': {
    params: z.object({
      projectId: ProjectId.nullable(),
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      /** The tool for the building session (C-2). If omitted, the project's default tool (for a user-folder app, the orchestrator's tool) */
      tool: ToolName.optional(),
    }),
    /**
     * Creating an app also stands up its building session (C-2). If that session fails to stand
     * up, the app still remains — `builder` is null and `builderError` states why. In that case
     * it can be stood up again with `apps.createBuilder`.
     */
    result: z.object({ app: ExternalAppInfo, builder: SessionInfo.nullable(), builderError: z.string().optional() }),
  },
  /**
   * That app's building session (M4 C-2) — "open the building session for app X." Null if there
   * is none (never stood up, or deleted). A project app's building session has its cwd at the
   * project root; a user-folder app's has it at the app's own folder.
   */
  'apps.builder': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: SessionInfo.nullable(),
  },
  /**
   * Stands up that app's building session (M4 C-2) — returns the existing one if there already
   * is one (one per app). Used for a hand-made app, or an app whose building session was
   * deleted. An app in an untrusted project is rejected (that app never starts, so it cannot be
   * tested).
   */
  /**
   * The recent error bundles for one external app (M4 C-6) — `latest` is what "send to builder"
   * would send. Only carries bundles from after the host started (they live in memory). Anything
   * that needs to persist longer is the run history's job (`apps.runs`).
   */
  'apps.errors': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: z.object({ latest: AppErrorBundle.nullable(), recent: z.array(AppErrorBundle) }),
  },
  /**
   * Whether a session can use one app's tools right now, and if not, why (#308). Asked when an item
   * dragged out of that app's view is dropped on the session's composer: the link goes in either
   * way, and a session that cannot reach the app gets a notice saying what would fix it. Decided by
   * the host from the same rule that attaches apps (apps.md §9.1) and from what the session's live
   * agent actually has (a Codex thread keeps the servers it started with). A session that is not
   * running counts as reachable when the rule gives it the app: it attaches the app when it wakes.
   */
  'apps.reach': {
    params: z.object({ sessionId: SessionId, appId: AppId, projectId: ProjectId.nullable() }),
    result: AppReach,
  },
  /**
   * Capability questions raised by a chain that started from a screen (M4 D-4) — the ones still
   * waiting for an answer. Drawn by the pinned screen and the sidebar. A question from a chain
   * that started from a session is not here, since it is that session's own approval card.
   * Refetched whenever `external_app_questions_changed` arrives.
   */
  'apps.questions': { params: z.object({}), result: z.array(AppQuestion) },
  /**
   * Answers a capability question (M4 D-4). The answer is remembered for that app and that
   * capability — whether allowed or denied (it can be forgotten later via `apps.permissions`).
   * A question that is already closed (timed out, or the request was cancelled) is rejected.
   */
  'apps.answerQuestion': {
    params: z.object({ questionId: z.string(), decision: z.enum(['allow', 'deny']) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Every remembered cross-project consent (#371): which project may reach which, and how ('delegate' — ask_project
   * starts a session there; 'apps' — its apps attach to the caller). Listed in Settings, newest first, with the
   * project names as they are now. Refetched whenever `project_consents_changed` arrives.
   */
  'projectConsents.list': { params: z.object({}), result: z.array(ProjectConsent) },
  /** Revokes one remembered consent (#371) — the next reach from that project to that one asks again */
  'projectConsents.revoke': {
    params: z.object({ fromProjectId: ProjectId, toProjectId: ProjectId, kind: ProjectConsentKind }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** The remembered capability answers for one app (M4 D-4) — shown next to the run history panel (B-7) and can be forgotten there */
  'apps.permissions': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: z.array(AppPermission),
  },
  /** Forgets one remembered answer (M4 D-4) — the next attempt to use that capability asks again */
  'apps.forgetPermission': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, capability: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * How much agent use one app requested (M4 D-5) — how many times, for how long, how many
   * tokens. Read by the run history panel. Even for an app whose folder is gone, this is still
   * readable as long as the record remains.
   */
  'apps.usage': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: AppUsage,
  },
  'apps.createBuilder': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, tool: ToolName.optional() }),
    result: SessionInfo,
  },
  /**
   * "Fix this" (M4 C-5) — sends what a person wrote in the composer under an app's screen to
   * that app's building session. The person never leaves the app. The host attaches a header:
   * which app, which screen it came from (`instanceId` — the pinned screen the person was
   * looking at; it must be an open instance of that app), and, if the app is stopped or its
   * latest run failed, that fact (protocol's `builderRequestFrame`). Since a person wrote it, the
   * body goes through as an instruction. Attachments are saved beforehand through the same path
   * as the composer's (`attachments.save`, with the building session's id). Rejected if there is
   * no building session — stand one up first with `apps.createBuilder`.
   */
  /**
   * Sends one error bundle to that app's building session (M4 C-6) — called by the UI only when
   * the person clicks "Send to builder." The host never sends one on its own. The bundle is
   * identified by `at` (that bundle from `apps.errors`). Each bundle can only be sent once — it
   * is rejected if already sent. What reaches the agent is the app's output wrapped in quotes
   * (protocol's `builderErrorFrame`).
   */
  'apps.sendError': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, at: z.number() }),
    result: z.object({ sessionId: SessionId }),
  },
  'apps.askBuilder': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable(),
      ...machineParam,
      text: z.string().max(64_000),
      attachments: z.array(Attachment).optional(),
      instanceId: z.string().optional(),
    }),
    result: z.object({ sessionId: SessionId }),
  },
  /**
   * Checks an app (M4 C-3) — the same judgment as the building session's `check`. Restarts the
   * app with its current files (waiting for any in-flight call), and actually reads the tool
   * list and the screens the tools point to, returning problems with the manifest, tool names,
   * visibility scope, annotations and home. `text` is one block of text safe to send to an
   * agent. A stopped app is restarted for this too (the same as a normal restart).
   */
  'apps.check': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: z.object({
      ok: z.boolean(),
      text: z.string(),
      findings: z.array(z.object({ level: z.enum(['problem', 'warning']), where: z.string(), message: z.string() })),
    }),
  },
  /**
   * Shares a project app with the person's other projects, or stops sharing it (#371 part A). Off by
   * default: a project app is that project's own. A shared app can be found and attached by a session
   * in another project (`find_apps`, `attach_app`), after the person allows that pair of projects once.
   * Turning it off detaches it from every session that attached it. A user-folder app is the person's
   * own and available everywhere already, so it has no such switch (refused).
   */
  'apps.setShared': {
    params: z.object({ appId: AppId, projectId: ProjectId, shared: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Sets, changes (`value`) or removes (`null`) one of an app's secret values (M4 E, the secrets
   * field). The value lives only in a 0600 file on this machine — never in the response, the
   * list, logs or run history (the list only says whether each name is present or not,
   * `ExternalAppInfo.secrets`). Only names the manifest declares can be set. A running app is
   * brought down after finishing any in-flight call, and comes back up with the new value the
   * next time it is needed.
   */
  'apps.setSecret': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable(),
      ...machineParam,
      name: z.string(),
      value: z.string().max(16 * 1024).nullable(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Prepares to import an app (M4 E-3) — moves a folder or .zip on this machine (a path or a
   * `file:` address), or a .zip at an https address, into the host's waiting room, and returns
   * what the person should review (`review`). **This does not admit it yet**: discovery never
   * scans the waiting room, so nothing appears there. If the link points outside the folder, a
   * name escapes it (zip slip), the size cap is exceeded, the id breaks the rule, or the id
   * already exists, this fails with a reason and clears the waiting room. `apps.importCommit`
   * admits it; `apps.importCancel` calls it off (and the waiting room clears itself after 30
   * minutes regardless).
   */
  'apps.importPrepare': {
    params: z.object({ source: z.string().max(4096) }),
    result: z.object({ token: z.string(), review: AppReview }),
  },
  /**
   * Admits the app in the waiting room into the user folder (M4 E-3). An imported app arrives
   * **turned off** (`unconfirmed`). If `enable` is set, the person's confirmation is recorded
   * right after admission — `reviewKey` must then be the key received during preparation (what
   * turns on is exactly what the person reviewed). Rejected if the same id was created in the
   * meantime.
   */
  'apps.importCommit': {
    params: z.object({ token: z.string(), enable: z.boolean().default(false), reviewKey: z.string().optional() }),
    result: ExternalAppInfo,
  },
  'apps.importCancel': {
    params: z.object({ token: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Reviews an admitted app again (M4 E-3) — read by the confirmation window for an imported app
   * that has not been turned on, or one whose `server`/`uses` changed after being turned on and
   * needs to be asked about again. When re-asking, `changed` carries the declaration from when
   * it was turned on. Only accepts apps in the user folder (a project app follows the project's
   * trust setting instead).
   */
  'apps.review': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: AppReview,
  },
  /**
   * Turns on an imported app (M4 E-3) — the host records this app's confirmation. `reviewKey` is
   * the key from the confirmation window the person saw, and the host checks it against the
   * current manifest: rejected if it has changed in the meantime (review it again, then turn it
   * on). Rejected if this is not an imported app — there is nothing to turn on.
   */
  'apps.enable': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), reviewKey: z.string() }),
    result: ExternalAppInfo,
  },
  /**
   * An app's versions (M4 E-1) — for a user-folder app, host-kept snapshots (most recent first,
   * `current` marking whichever matches the code now); for a project app, the recent commits
   * that touched that app's folder (git is the version history, read-only). If it is not a
   * repository, this returns `repo: false` with an empty list.
   */
  'apps.versions': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: AppVersions,
  },
  /**
   * Restores a user-folder app to a kept version (M4 E-1). Before overwriting, it takes a
   * snapshot of the current code as a version too (so restoring can itself be undone), then
   * overwrites the files with the target version and restarts the app on that code — waiting for
   * any in-flight call to finish. An open screen reopens on the new code (`codeStamp`). If an
   * imported app's version has a different `server`/`uses`, it is asked about again. A project
   * app is rejected — git is where restoring happens for those.
   */
  'apps.restoreVersion': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, id: z.string() }),
    result: ExternalAppInfo,
  },
  /**
   * The agent tools of one external app attached to a session (M4 A-5) — called by the bridge
   * of an adapter that cannot attach in-process. The shape is exactly MCP's `Tool` (the bridge
   * hands back what it received, unchanged). Rejected if the app is not attached to that session.
   */
  'apps.sessionTools': {
    params: z.object({ sessionId: SessionId, server: z.string() }),
    result: z.object({ tools: z.array(z.record(z.string(), z.unknown())) }),
  },
  /**
   * A session's agent calls a tool of an attached app (M4 A-5) — called by the bridge. The
   * caller is that session, and it goes through the runtime's single path (visibility scope, run
   * id, history). The result has the shape of MCP's `CallToolResult`.
   *
   * `waitMs`: if a call takes longer than this, the run id and "still running" are returned
   * first (the call itself keeps going). The bridge of a tool with an outside time limit (Codex's
   * 300 seconds) sets this shorter than that limit.
   */
  'apps.sessionCall': {
    params: z.object({
      sessionId: SessionId,
      server: z.string(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      waitMs: z.number().int().min(1_000).max(3_600_000).optional(),
    }),
    result: z.object({
      content: z.array(z.unknown()),
      isError: z.boolean().optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
    }),
  },
} as const
