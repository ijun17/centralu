import { z } from 'zod'
import { GitCommit } from './git.js'
import { GridSpan } from './grid.js'
import { AppId } from './ids.js'

/**
 * An external app's status (docs/apps/trust-lifecycle-calls.md; `error` says why). `untrusted` and `unconfirmed` (an
 * import not turned on yet, or whose `server`/`uses` changed since) never start, attach to no session and refuse every
 * call. `stopped` starts on first need; `crashed` starts again after a backoff; `failed` waits for `apps.restart`.
 */
export const ExternalAppStatus = z.enum([
  'invalid',
  'untrusted',
  'unconfirmed',
  'stopped',
  'starting',
  'running',
  'crashed',
  'failed',
])
export type ExternalAppStatus = z.infer<typeof ExternalAppStatus>

/** The manifest's `uses`: what the app declares it will use. `agent`: `true` (the person's default agent) or tool names */
export const AppUses = z.object({
  agent: z.union([z.boolean(), z.array(z.string())]).optional(),
  apps: z.array(z.string()).optional(),
  host: z.array(z.string()).optional(),
  /** Background work it may keep its process running for with no view open and no call, in the manifest's words */
  background: z.string().optional(),
  /** It may post notices into a session that called it */
  notices: z.boolean().optional(),
})
export type AppUses = z.infer<typeof AppUses>

/** One per (project, id): the same id in two projects is two apps. `projectId: null` is a user-folder app */
export const ExternalAppInfo = z.object({
  appId: AppId,
  projectId: z.string().nullable(),
  /** A native path: the screen only ever displays it */
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
   * Changes only when the app runs on new code, so an open view knows its HTML is stale (docs/apps/views.md); only
   * compared. Absent: never started on this host
   */
  codeStamp: z.string().optional(),
  /**
   * The latest error bundle's time; absent: none since the host started. The screen refetches the bundle when it
   * changes, since a read-only tool's failure sends no "changed" (that would loop) (docs/apps/build-loop.md)
   */
  lastErrorAt: z.number().optional(),
  /** Declared secrets and whether each is set here. Never the value: this list goes out on every broadcast */
  secrets: z.array(z.object({ name: z.string(), set: z.boolean() })).optional(),
  /**
   * The saved secrets file did not read (docs/apps/what-an-app-is.md): `movedTo` the copy it was moved aside to, null
   * while stuck in place; `reason` in a few words, never what the file holds. Absent from older hosts
   */
  secretsUnreadable: z
    .object({ movedTo: z.string().nullable(), at: z.number(), reason: z.string().optional() })
    .optional(),
  /** Which linked machine the app lives on; absent or null for the hub's own (a user-folder app is otherwise ambiguous) */
  machine: z.string().nullable().optional(),
  /**
   * A user-folder app imported from outside: where from, when, and when the person turned it on (null: not yet). Kept
   * by the host outside the app's folder
   */
  imported: z.object({ source: z.string(), at: z.number(), confirmedAt: z.number().nullable() }).optional(),
  /**
   * The panel span the manifest recommends (`view.span`), checked and clamped by the host. A default only: the person's
   * choices come first; absent: 1 × 1
   */
  span: GridSpan.optional(),
  /**
   * A project app shared with the person's other projects (`apps.setShared`). Absent: not shared, also from an older
   * host (the safe default). A user-folder app never carries it: every project has it already
   */
  shared: z.boolean().optional(),
  /**
   * Turned off on this computer (`apps.setOff`, docs/plans/remote-hub.md §13.7): a copy of an app another computer runs,
   * never started, called or given to a session here; `status` reads `stopped`. Absent: on
   */
  off: z.boolean().optional(),
  /** The manifest stands at its project's root, so the project is the app: `dir` is the project's folder */
  root: z.boolean().optional(),
  /**
   * What the manifest declares, empty when nothing; absent when it is invalid, or from an older host, which a trust card
   * reads as not known, never as asking for nothing. A declaration, not a permission
   */
  uses: AppUses.optional(),
  /**
   * The app holds its process for background work now, in its own words. Only with `uses.background`, while its process
   * runs: the idle rule leaves it running, and `apps.restart` ends the hold
   */
  busy: z.string().optional(),
})
export type ExternalAppInfo = z.infer<typeof ExternalAppInfo>

/**
 * What a person sees before turning an imported app on: what it runs, what it will use, its secrets and files, and
 * what is not carried over (a dot name, a symlink) with why. `reviewKey` binds `server` and `uses`: sent back to turn it
 * on and checked against that same manifest, so what was reviewed is what runs. `changed`: null for a first import.
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
 * One run of an external app. Arguments only as a summary and a hash; the raw ones are kept in `failure` for the last
 * few failed calls, for the agent fixing the app. A secret value reads `[redacted:name]` everywhere.
 */
export const AppRun = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  appId: AppId,
  /**
   * `broker`: this app asking Centralu for something (`tool` is then run_agent, call_app or host_data). The rows of a
   * chain (another app it called, an agent it requested) link by `parentRunId`.
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
  /** The session run_agent stood up; null before it stands up, and on any other row */
  sessionId: z.string().nullable(),
  /** A run_agent row's tokens as the tool reported them; null on other rows and when it reported none */
  tokens: z.object({ input: z.number(), output: z.number() }).nullable(),
  failure: z.object({ args: z.string(), result: z.string().nullable() }).nullable(),
  /** A run_agent row whose session was deleted after a clean end: kept in Settings → Archive. Absent from older hosts */
  kept: z.boolean().optional(),
})
export type AppRun = z.infer<typeof AppRun>

/**
 * A capability question from a chain that started from a screen (one from a session is its approval card). It shows on
 * `origin`'s pinned screen and sidebar row; `app` may be another app the first one called. Past `expiresAt` the host
 * closes it as a denial.
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
 * A remembered answer for one app. `current` false: an allow whose manifest `uses` changed since, so a `safe` caller is
 * asked again. A deny is current from #2237's build on; an older host reports one given against older `uses` as not current.
 */
export const AppPermission = z.object({
  capability: z.string(),
  text: z.string(),
  decision: z.enum(['allow', 'deny']),
  decidedAt: z.number(),
  current: z.boolean(),
})
export type AppPermission = z.infer<typeof AppPermission>

/** Agent use one app requested over a period, counting only runs that stood up */
export const AgentUse = z.object({
  runs: z.number(),
  /** Finished runs only; a running one counts toward `runs` alone */
  durationMs: z.number(),
  /** Null if no run reported any */
  tokens: z.object({ input: z.number(), output: z.number() }).nullable(),
})
export type AgentUse = z.infer<typeof AgentUse>

/** The last day, and the 30 days the record keeps */
export const AppUsage = z.object({ day: AgentUse, month: AgentUse })
export type AppUsage = z.infer<typeof AppUsage>

/**
 * An app's failure to start, crash or failed tool call, for the screen's "send to builder" (docs/apps/build-loop.md):
 * the host never sends it on its own. A secret value reads `[redacted:name]`, as in the run history.
 */
export const AppErrorBundle = z.object({
  kind: z.enum(['start', 'crash', 'tool']),
  at: z.number(),
  message: z.string(),
  stderr: z.array(z.string()),
  tool: z.string().nullable(),
  args: z.string().nullable(),
  runId: z.string().nullable(),
  /**
   * The person denied a request somewhere in this call's chain: the screen says so instead of an app error, offers no
   * "send to builder", and points to that `app`'s Permissions. Absent from an older host: null
   */
  denied: z
    .object({
      appId: AppId,
      projectId: z.string().nullable(),
      name: z.string(),
      capability: z.string(),
      text: z.string(),
    })
    .nullable()
    .default(null),
  text: z.string(),
  /**
   * When the person sent it; null if never, and from an older host. A bundle goes once: the host refuses a second send,
   * and every screen draws "sent" from this
   */
  sentAt: z.number().nullable().default(null),
})
export type AppErrorBundle = z.infer<typeof AppErrorBundle>

/**
 * An app outside git has host-kept snapshots, taken whenever it starts on changed code (the last 5); a project app has
 * the recent commits touching its folder instead (read-only: restore through git). `current`: the folder's code matches.
 * `reason`: `started`, `imported` or `before restore`.
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

/** `uses` in plain words, one line per capability: the one wording on every card that asks (review, trust, notice) */
export function usesLines(uses: AppUses): string[] {
  const out: string[] = []
  if (uses.agent === true) out.push('Run your default agent in a new session')
  else if (Array.isArray(uses.agent) && uses.agent.length)
    out.push(`Run your agent in a new session: ${uses.agent.join(', ')}`)
  if (uses.apps?.length) out.push(`Call other apps: ${uses.apps.join(', ')}`)
  if (uses.host?.length)
    out.push(`Read Centralu data: ${uses.host.map((name) => HOST_DATA_WORDS[name] ?? name).join('; ')}`)
  if (uses.background) out.push(`Keep running in the background while busy: ${uses.background}`)
  if (uses.notices) out.push('Post notices into the sessions that called it')
  return out
}

/**
 * One "Can …" line per `usesLines` line, on every card that shows a trusted app: in a trusted project what it declares
 * runs without asking (#2237), so it is said as what the app can do
 */
export function appCanLines(lines: readonly string[]): string[] {
  if (!lines.length) return ['Uses nothing beyond its own tools']
  return lines.map((l) => `Can ${l.charAt(0).toLowerCase()}${l.slice(1)}`)
}

/** The host data names an app may declare (`HOST_CAPABILITIES`), in plain words */
const HOST_DATA_WORDS: Record<string, string> = {
  'sessions.list': "the names and states of its project's sessions (sessions.list)",
  'git.status': "its project's branch and changed files (git.status)",
}
