import { z } from 'zod'
import { AppId, Attachment, ProjectConsentKind, ProjectId, SessionId, ToolName } from '../../entities.js'
import { machineParam } from '../machine-fields.js'

/** Params of the `apps` methods, parsed by the host (docs/apps/broker-and-rpcs.md "RPCs and events"). Results: ./apps.results.ts */
export const appsParams = {
  /**
   * The address carries the per-launch secret and goes only to an allowlisted origin (docs/security-boundaries/app-views.md).
   * The instance decides the app; `appId` and `projectId` are only checked against it. `hostOrigin` is the caller's
   * `location.origin`, the one origin the proxy talks to.
   */
  'apps.viewFrame': z.object({
    appId: AppId,
    projectId: ProjectId.nullable().default(null),
    instanceId: z.string(),
    hostOrigin: z.string(),
  }),
  /**
   * For a hub serving a linked machine's open view in its own window (docs/plans/remote-hub.md §11); the UI never asks.
   * `resource` is the app's raw `resources/read` answer: the hub applies its own CSP, sandbox and origin rules, so nothing
   * that decides a view's reach comes finished from the other machine. An older host answers "Unknown method".
   */
  'apps.viewDocument': z.object({ instanceId: z.string() }),
  /**
   * Calls the manifest's `home` as the view caller and opens an instance at its `_meta.ui.resourceUri`. Fails with a
   * reason, leaving no live view, when there is no home or view or the app cannot be reached; an app's own failure answer
   * still opens (drawing it is the view's job). A keyed open keeps only a failure reservation in the lease grace period.
   */
  'apps.openView': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    /** A linked machine's user-folder app, which has no project id to name it; ignored with a project */
    ...machineParam,
    /** docs/apps/broker-and-rpcs.md "RPCs and events". Without it (an older window, a linked machine's view) the view lives until `apps.closeView` */
    lease: z.boolean().optional(),
    /** One UUID per logical open: a repeat, also across a planned host handover, reuses the instance and never runs home twice */
    openKey: z.string().uuid().optional(),
  }),
  /** Releases the app the instance held (with no open view it counts down to idle). Closing twice is a no-op */
  'apps.closeView': z.object({ instanceId: z.string() }),
  /** Reclaims a keyed home open after losing its answer; never calls the home tool. */
  'apps.recoverView': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    lease: z.boolean().optional(),
    openKey: z.string().uuid(),
  }),
  /**
   * After every reconnect. `missing`: ids no longer open (the window was away longer than the host waited), which the
   * window opens again. An instance opened without a lease is left as it is.
   */
  'apps.holdViews': z.object({ instanceIds: z.array(z.string()).max(1000) }),
  /**
   * Never calls the tool again (docs/apps/views.md "Inline, under the tool card"): a new instance gets the held input and
   * outcome; a call still running gets its outcome through `app_view`. Re-applies the live view cap, which may close the
   * one open longest (`closed`).
   */
  'apps.inlineReopen': z.object({ sessionId: SessionId, callId: z.string() }),
  /**
   * For a reopened UI planting placeholders: `kept` means Reopen needs no new call; an `instanceId` still open is one the
   * UI does not know, and closes to release the app. Empty after a host restart (held in memory only).
   */
  'apps.inlineViews': z.object({ sessionId: SessionId }),
  /**
   * Sent only after the person reads it and agrees. The instance decides the app (#93, #94: the string validated is the
   * one used): an inline view's text goes to its own conversation (`sessionId` only checked), a pinned view's to the one
   * the person chose (docs/security-boundaries/untrusted-text.md "Text an app sends").
   */
  'apps.viewMessage': z.object({
    sessionId: SessionId,
    instanceId: z.string(),
    text: z.string().min(1).max(64_000),
  }),
  /** Answers MCP `resources/read`'s result as is. With `instanceId`, it must match that view's app */
  'apps.readResource': z.object({
    appId: AppId,
    projectId: ProjectId.nullable().default(null),
    uri: z.string(),
    instanceId: z.string().optional(),
  }),
  /**
   * Called as a view: only tools with `app` in `visibility`. `result` is the app's own answer; `status: 'rejected'` never
   * reached the app (`text` says why).
   */
  'apps.invoke': z.object({
    appId: AppId,
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    projectId: ProjectId.nullable().optional(),
    /** The calling view, which skips the `external_app_state_changed` this call causes */
    instanceId: z.string().optional(),
  }),
  /**
   * Untrusted and broken apps are listed with a reason: hiding them leaves nowhere to ask why. With `machine`: only that
   * machine's, asked of it alone, so silence is an error rather than a list without its apps (a trust card names what it
   * covers). An older hub ignores `machine` and answers the merged list.
   */
  'apps.list': z.object({ ...machineParam }),
  'apps.runs': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    limit: z.number().int().min(1).max(500).default(100),
  }),
  /** Clears a failed app's run of failures and stops it if up; does not start it (the next need does) */
  'apps.restart': z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
  /**
   * A user-folder app only (git withdraws a project app): its folder goes to `app-trash/` and it is detached from every
   * session. With `machine`, removed there; this host's app of the same id is untouched.
   */
  'apps.remove': z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
  /**
   * docs/apps/build-loop.md. With `projectId`: `.centralu/apps/<id>/` in that trusted project; null: a new trusted project
   * `<parent>/<id>` whose root is the app (an older host uses its user folder). `id`: lowercase, digits and hyphens, at
   * most 32, not starting with `centralu` or `app-` (it becomes `app-<id>`). Not started.
   */
  'apps.create': z.object({
    projectId: ProjectId.nullable(),
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    /** Absent: the project's default tool (the Assistant's, for a user-folder app) */
    tool: ToolName.optional(),
    /** Absent: `~/Centralu` */
    parent: z.string().max(4096).optional(),
  }),
  /** Null when none. Its cwd is the project root for a project app, the app's own folder for a user-folder app */
  'apps.builder': z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
  /** In memory since the host started; `latest` is what "Send to builder" sends. What lasts is `apps.runs` */
  'apps.errors': z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
  /**
   * docs/apps/view-theme-layout-drag.md "Dragging an item out of a view". Decided by the apps/attaching.md rule and what
   * the live agent has (a Codex thread keeps the servers it started with); a session not running counts as reachable
   * when the rule gives it the app.
   */
  'apps.reach': z.object({ sessionId: SessionId, appId: AppId, projectId: ProjectId.nullable() }),
  /** Only chains a view started; a session's chain asks on its own approval card */
  'apps.questions': z.object({}),
  /** Remembered per app and capability, allow or deny (`apps.forgetPermission` forgets it). A closed question is refused */
  'apps.answerQuestion': z.object({ questionId: z.string(), decision: z.enum(['allow', 'deny']) }),
  /** 'delegate': ask_project starts a session there; 'apps': its apps attach to the caller. Newest first */
  'projectConsents.list': z.object({}),
  /** The next reach from that project to that one asks again */
  'projectConsents.revoke': z.object({
    fromProjectId: ProjectId,
    toProjectId: ProjectId,
    kind: ProjectConsentKind,
  }),
  'apps.permissions': z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
  /** A forgotten allow makes a caller under `safe` ask again; a forgotten deny lets the app use it again */
  'apps.forgetPermission': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    capability: z.string(),
  }),
  /** Readable while the record stays, also for an app whose folder is gone */
  'apps.usage': z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
  /** One per app: an existing one is returned. Refused in an untrusted project, where the app never starts to be tested */
  'apps.createBuilder': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    tool: ToolName.optional(),
  }),
  /**
   * Only on the person's "Send to builder"; the host never sends one itself. Each bundle (`at`, from `apps.errors`) goes
   * once. The agent gets the app's output quoted (`builderErrorFrame`).
   */
  'apps.sendError': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    at: z.number(),
  }),
  /**
   * "Fix this": the person's words go to the building session as an instruction, under a header the host adds (the app,
   * the open `instanceId`, a stopped or failed state: `builderRequestFrame`). Attachments are saved first with
   * `attachments.save` and the builder's id. Refused without a building session.
   */
  'apps.askBuilder': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    text: z.string().max(64_000),
    attachments: z.array(Attachment).optional(),
    instanceId: z.string().optional(),
  }),
  /**
   * As the building session's `check`: restarts the app on its current files (after in-flight calls) and reads its tools
   * and their views. `text` is safe to send to an agent.
   */
  'apps.check': z.object({ appId: AppId, projectId: ProjectId.nullable() }),
  /**
   * docs/apps/other-projects-apps.md. Off by default; turning it off detaches it from every session. A user-folder app is
   * everywhere already: refused.
   */
  'apps.setShared': z.object({ appId: AppId, projectId: ProjectId, shared: z.boolean() }),
  /**
   * For a copy another computer runs for the same repository (docs/plans/remote-hub.md §13.7): off, it never starts, is
   * never called or given to a session here, and a running copy stops. A user-folder app: refused.
   */
  'apps.setOff': z.object({ appId: AppId, projectId: ProjectId, off: z.boolean() }),
  /**
   * The value lives only in a 0600 file on this machine: never in an answer, the list, a log or a run record. Only names
   * the manifest declares. A running app stops after in-flight calls and gets the value at its next start.
   */
  'apps.setSecret': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    name: z.string(),
    value: z
      .string()
      .max(16 * 1024)
      .nullable(),
  }),
  /**
   * docs/apps/handing-over.md "Import (E-3)": stages a folder or .zip (a path, a `file:` address, an https .zip) and
   * answers the `review`. Discovery never scans the staging, so nothing appears yet. A failed check clears it.
   */
  'apps.importPrepare': z.object({ source: z.string().max(4096) }),
  /**
   * Arrives turned off (`unconfirmed`); with `enable`, `reviewKey` must be the preparation's, so what turns on is what the
   * person reviewed. Refused if the id was created meanwhile. Lands as a project `<parent>/<id>` (`~/Centralu` when
   * absent), trusted only with `enable`; an older host ignores `parent` and uses its user folder.
   */
  'apps.importCommit': z.object({
    token: z.string(),
    enable: z.boolean().default(false),
    reviewKey: z.string().optional(),
    parent: z.string().max(4096).optional(),
  }),
  'apps.importCancel': z.object({ token: z.string() }),
  /**
   * An import not enabled yet, or one whose `server`/`uses` changed since (`changed`: the declaration it was enabled
   * with). User-folder apps only; a project app follows the project's trust.
   */
  'apps.review': z.object({ appId: AppId, projectId: ProjectId.nullable() }),
  /** `reviewKey` is checked against the current manifest: refused if it changed since, or if the app was not imported */
  'apps.enable': z.object({ appId: AppId, projectId: ProjectId.nullable(), reviewKey: z.string() }),
  /**
   * A user-folder app: host-kept snapshots, `current` the one matching the code. A project app: the git commits that
   * touched its folder (`repo: false` and an empty list outside a repository).
   */
  'apps.versions': z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
  /**
   * Snapshots the current code first (so a restore can be undone), then restarts the app on the version after in-flight
   * calls; open views reopen (`codeStamp`). A changed `server`/`uses` is asked again. A project app: refused (git).
   */
  'apps.restoreVersion': z.object({
    appId: AppId,
    projectId: ProjectId.nullable(),
    ...machineParam,
    id: z.string(),
  }),
} as const
