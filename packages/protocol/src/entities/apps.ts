import { z } from 'zod'
import { GitCommit } from './git.js'
import { GridSpan } from './grid.js'
import { AppId } from './ids.js'

/**
 * An external app's status (M4 A).
 *
 *   invalid     the manifest is missing or invalid — `error` states why
 *   untrusted   an app in an untrusted project. Discovered and shown in the list, but **never starts**
 *   stopped     startable, but currently down (starts only the first time it is actually needed)
 *   starting    starting up — from when the process comes up until it reports its tool list
 *   running     up and running
 *   crashed     the last startup or run failed (`error` states why). The next time it is needed, it starts again after a backoff
 *   failed      stopped after repeated failures — does not start again before `apps.restart`
 *   unconfirmed an app imported from outside that the person has not turned on yet, or whose `server`/`uses` changed after being turned on (M4 E-3). Like `untrusted`,
 *               it **never starts**, is not attached to any session, and every call to it is rejected — until the person reviews it via `apps.review` and turns it on via `apps.enable`
 */
export const ExternalAppStatus = z.enum(['invalid', 'untrusted', 'unconfirmed', 'stopped', 'starting', 'running', 'crashed', 'failed'])
export type ExternalAppStatus = z.infer<typeof ExternalAppStatus>

/** The manifest's `uses` — the capabilities the app declares it will use (M4 D). `agent` is either `true` (the person's default agent) or a list of tool names */
export const AppUses = z.object({
  agent: z.union([z.boolean(), z.array(z.string())]).optional(),
  apps: z.array(z.string()).optional(),
  host: z.array(z.string()).optional(),
  /**
   * The background work the app may keep its process running for with no view open and no call (#1236), in the
   * manifest's words. Absent from an older host, and from an app that declares none.
   */
  background: z.string().optional(),
})
export type AppUses = z.infer<typeof AppUses>

/**
 * One discovered external app (M4 A-2). There is one instance per (project, id) — the same id
 * in two different projects means two different apps. `projectId: null` means a user-folder app.
 */
export const ExternalAppInfo = z.object({
  appId: AppId,
  projectId: z.string().nullable(),
  /** The absolute path to the app's folder (a native path — the screen only ever displays it) */
  dir: z.string(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  home: z.string().nullable(),
  trusted: z.boolean(),
  status: ExternalAppStatus,
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  /**
   * A fingerprint of the app folder read by the running (or most recently running) process —
   * absent if it has never started on this host (M4 C-4).
   *
   * An open screen's HTML belongs to whatever code was running when that screen was opened. When
   * the building session's turn ends and the app restarts on new code (or `check`/Restart starts
   * it with the current files), this value changes, and the screen uses that to know "my HTML is
   * stale." Restarting on the same code (dying and coming back, or waking from idle) does not
   * change it — reopening would show nothing different. Since it carries no meaning of its own,
   * it is only ever compared.
   */
  codeStamp: z.string().optional(),
  /**
   * The time of this app's most recent error bundle (`apps.errors`'s `latest.at`, M4 C-6) —
   * absent if there has been no error since the host started. The screen's error line refetches
   * the bundle when this changes. This cannot be known from the "changed" notification alone: a
   * read-only tool's failure never emits that notification (emitting it would create a loop of
   * the screen refetching and failing again).
   */
  lastErrorAt: z.number().optional(),
  /**
   * The secrets the manifest declares, and whether a value is set on this machine (M4 E, the
   * secrets field) — absent if there is no declaration. **The value never appears here**: since
   * this list is refetched on every broadcast, it only carries what the screen needs to show
   * (whether a field is empty). Setting and clearing a value goes through `apps.setSecret`.
   */
  secrets: z.array(z.object({ name: z.string(), set: z.boolean() })).optional(),
  /**
   * The saved secrets could not be read (#944, #841 item 2), on an app that declares secrets: `movedTo` names the copy
   * the unreadable file was moved aside to (the values were not lost, but the app no longer gets them), or is null
   * when it could not be moved, and saving is refused until the file is fixed or removed. `at` is when the host met
   * it. Gone once this app has a value again (the file holds every app's, #993 review), or once a stuck file reads
   * again; a copy moved aside is found in the data folder, so a restart says it again. Absent from older hosts.
   */
  secretsUnreadable: z.object({ movedTo: z.string().nullable(), at: z.number() }).optional(),
  /** Which linked machine the app lives on (#82); absent or null for the hub's own (a user-folder app is otherwise ambiguous) */
  machine: z.string().nullable().optional(),
  /**
   * For a user-folder app imported from outside, its provenance (M4 E-3) — where it came from,
   * when, and when the person turned it on (null if not turned on). The host keeps this marker
   * outside the app's own folder. If it has not been turned on, or `server`/`uses` changed after
   * it was, its status is `unconfirmed`.
   */
  imported: z.object({ source: z.string(), at: z.number(), confirmedAt: z.number().nullable() }).optional(),
  /**
   * The span the app recommends for its panel on the grid (#306), from the manifest's `view.span`, already checked and
   * clamped by the host — absent when the manifest has none. Only a default: the person's choice for the placement and
   * their setting for the app both come first, and an app without one stands at 1 × 1 as before.
   */
  span: GridSpan.optional(),
  /**
   * A project app the person shares with their other projects (#371 part A, `apps.setShared`) — true
   * only when on. Absent means not shared, and a user-folder app never carries it (it is available to
   * every project already). An older host never sends it, which reads as off: the safe default.
   */
  shared: z.boolean().optional(),
  /**
   * A root app (#1141): the manifest stands at its project's own root, so the project is the app — `dir` is the
   * project's folder, and the app is listed with its project rather than under it. True only when so; absent from an
   * older host, which has none.
   */
  root: z.boolean().optional(),
  /**
   * What the manifest declares it will ask Centralu for (`uses`: agents it may run, apps it may call, host data it may
   * read), absent when it declares nothing or the manifest is invalid (#1141). A declaration, not a permission: the
   * project's trust card lists it per app, so the person sees what trusting lets its apps ask for. Absent from an older
   * host.
   */
  uses: AppUses.optional(),
  /**
   * The app holds its process for background work now (#1236): what it said it is doing, in its own words. Only an app
   * whose manifest declares `uses.background` can hold, and only while its process runs; the idle rule leaves it
   * running meanwhile, and stopping it (`apps.restart`) ends the hold with the process. Absent when it holds nothing,
   * and from an older host.
   */
  busy: z.string().optional(),
})
export type ExternalAppInfo = z.infer<typeof ExternalAppInfo>

/**
 * What a person sees before turning an app on (M4 E-3) — for an app to import (or an imported
 * app that needs to be asked about again), **what it runs** (`server`), **what it intends to
 * use** (`uses`), which secrets it wants, and which files will be brought in. Anything not
 * carried over (a name starting with a dot, a symlink) is also listed with a reason.
 *
 * `reviewKey` is the key for whatever turning it on binds together (server and uses). It is sent
 * back unchanged when turning the app on, and the host checks it against **that same** manifest
 * — what the person reviewed and what gets turned on have to be the same thing. `changed` states
 * what changed since it was turned on, when this is a re-review (null for a first-time import).
 */

export const AppReview = z.object({
  appId: AppId,
  name: z.string(),
  version: z.string(),
  description: z.string(),
  server: z.object({ command: z.string(), args: z.array(z.string()) }),
  uses: AppUses,
  secrets: z.array(z.string()),
  home: z.string().nullable(),
  viewOrigin: z.enum(['opaque', 'app']),
  files: z.array(z.object({ path: z.string(), bytes: z.number() })),
  totalBytes: z.number(),
  skipped: z.array(z.object({ path: z.string(), why: z.string() })),
  warnings: z.array(z.string()),
  reviewKey: z.string(),
  source: z.string(),
  changed: z
    .object({
      server: z.boolean(),
      uses: z.boolean(),
      was: z.object({
        server: z.object({ command: z.string(), args: z.array(z.string()) }),
        uses: AppUses,
      }),
    })
    .nullable(),
})
export type AppReview = z.infer<typeof AppReview>

/**
 * One run of an external app (M4 A-6) — who called it (a screen, session or app), which tool,
 * and how it ended.
 *
 * The arguments carry **only a summary and a hash**. The raw arguments are kept in `failure`,
 * and only for the most recent handful of failed calls (since the agent fixing the app needs to
 * see the input that failed). A secret value is replaced with `[redacted:name]` everywhere it
 * would otherwise appear.
 */
export const AppRun = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  appId: AppId,
  /**
   * A record of what (M4 D-6) — `tool` is this app's own tool being called, `broker` is this app
   * asking Centralu for something (`tool` is the name of the broker tool: run_agent, call_app,
   * host_data). One app's history also carries the chain below it (the row for another app it
   * called, the row for the agent it requested) — linked by `parentRunId`.
   */
  kind: z.enum(['tool', 'broker']),
  tool: z.string(),
  callerKind: z.enum(['view', 'session', 'app']),
  callerSessionId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  status: z.enum(['running', 'ok', 'error', 'cancelled', 'rejected']),
  durationMs: z.number().nullable(),
  argsDigest: z.string(),
  argsSummary: z.string(),
  error: z.string().nullable(),
  createdAt: z.number(),
  /** The agent session run_agent stood up (M4 D-6) — the run history panel's link to jump to that session. Null before the session stands up, and for any other row */
  sessionId: z.string().nullable(),
  /** The tokens for a run_agent row (M4 D-5) — the input/output the tool reported. Null for other rows, and for a run the tool never reported */
  tokens: z.object({ input: z.number(), output: z.number() }).nullable(),
  failure: z.object({ args: z.string(), result: z.string().nullable() }).nullable(),
  /**
   * A run_agent row whose session was deleted once the run ended cleanly (#378): its request, answer and conversation
   * are kept in Settings → Trash. Absent from a host older than #378.
   */
  kept: z.boolean().optional(),
})
export type AppRun = z.infer<typeof AppRun>

/**
 * An external app's error bundle (M4 C-6) — holds that moment as one unit, whether the app
 * failed to start (start), ended without warning (crash), or a tool call failed (tool). Used by
 * the app screen when it offers "send to builder." The host **never sends it on its own** — only
 * when the person clicks does the UI send `text` to the building session.
 *
 * The arguments are summary-only, and a secret value is replaced with `[redacted:name]` wherever
 * it would appear in standard error, the reason, or the arguments (the same rule as the run history).
 */
/**
 * A question raised the first time an app tries to use a capability (M4 D-4) — belongs to a
 * chain that **started from a screen**. A question from a chain that started from a session is
 * not here; it stands as that session's own approval card (`ApprovalDetail`'s `capability`).
 *
 * `origin` is the app of the screen that started the chain — the question appears on that app's
 * pinned screen, and the sidebar shows that app's row as "waiting for an answer." The app trying
 * to use the capability (`app`) can be another app that the first one called. Once `expiresAt`
 * passes, the host closes it as a denial.
 */
export const AppQuestion = z.object({
  id: z.string(),
  app: z.object({ appId: AppId, projectId: z.string().nullable(), name: z.string() }),
  capability: z.string(),
  text: z.string(),
  origin: z.object({ appId: AppId, projectId: z.string().nullable() }),
  askedAt: z.number(),
  expiresAt: z.number(),
})
export type AppQuestion = z.infer<typeof AppQuestion>

/**
 * A remembered answer for one app (M4 D-4). If `current` is false, the manifest's `uses`
 * changed afterward — that answer no longer applies, and the next attempt to use that
 * capability asks again.
 */
export const AppPermission = z.object({
  capability: z.string(),
  text: z.string(),
  decision: z.enum(['allow', 'deny']),
  decidedAt: z.number(),
  current: z.boolean(),
})
export type AppPermission = z.infer<typeof AppPermission>

/** Agent use one app requested over a period (M4 D-5) — only counts runs that actually stood up (a rejected request never stood one up) */
export const AgentUse = z.object({
  runs: z.number(),
  /** The sum of time taken by finished runs — a still-running run only counts toward the count */
  durationMs: z.number(),
  /** The sum of tokens across runs the tool reported. Null if none reported any */
  tokens: z.object({ input: z.number(), output: z.number() }).nullable(),
})
export type AgentUse = z.infer<typeof AgentUse>

/** One app's agent use (M4 D-5) — the last day, and the 30 days the record retains */
export const AppUsage = z.object({ day: AgentUse, month: AgentUse })
export type AppUsage = z.infer<typeof AppUsage>

export const AppErrorBundle = z.object({
  kind: z.enum(['start', 'crash', 'tool']),
  at: z.number(),
  message: z.string(),
  /** The last lines of the app's standard error */
  stderr: z.array(z.string()),
  tool: z.string().nullable(),
  args: z.string().nullable(),
  runId: z.string().nullable(),
  /**
   * This failure came from a person's decision (M4 D-4) — the person denied a request (agent,
   * another app, host data) made by this call or a chain below it. The screen reports the
   * decision rather than an app error, and does not offer "send to builder." The place to reverse
   * it is that `app`'s run history panel (Permissions, Forget). Absent from an older host's
   * response — null if not present.
   */
  denied: z
    .object({ appId: AppId, projectId: z.string().nullable(), name: z.string(), capability: z.string(), text: z.string() })
    .nullable()
    .default(null),
  /** Text that can be sent to the building session as-is */
  text: z.string(),
  /**
   * When the person sent this bundle to the building session — null if it was never sent (C-6).
   * Each bundle goes **only once**: the host records it and rejects a second attempt. The screen
   * draws "sent" from this (the same on a reopened screen, and in a different window). Absent
   * from an older host's response — null if not present.
   */
  sentAt: z.number().nullable().default(null),
})
export type AppErrorBundle = z.infer<typeof AppErrorBundle>

/**
 * An app's versions (M4 E-1). For an app outside git (a user-folder app, including an imported
 * one), these are host-kept snapshots taken every time it starts on changed code (the most
 * recent 5); for a project app, git is the version history, so these are the recent commits that
 * touched that app's folder (read-only — restoring happens through git instead).
 *
 * A snapshot's `current` means the app folder's current code matches that version (the folder
 * fingerprints match). `reason` states why it was taken: `started` (it started on that code),
 * `imported` (as brought in), `before restore` (the code right before a restore).
 */
export const AppSnapshot = z.object({
  id: z.string(),
  at: z.number(),
  files: z.number(),
  bytes: z.number(),
  reason: z.string(),
  current: z.boolean(),
})
export type AppSnapshot = z.infer<typeof AppSnapshot>

export const AppVersions = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshots'), snapshots: z.array(AppSnapshot) }),
  z.object({ kind: z.literal('git'), repo: z.boolean(), commits: z.array(GitCommit) }),
])
export type AppVersions = z.infer<typeof AppVersions>
