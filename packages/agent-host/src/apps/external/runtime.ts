import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult, ListResourcesResult, PriorDiscovery, ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import { APP_ID_MAX_LENGTH, APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, newAppIdProblem, type AppReview, type ExternalAppInfo, type NewAppIdProblem } from '@cc/protocol'
import { DirWatchers } from '../../dev-services/watch.js'
import { AppProcess, AppStartError, type SpawnSpec } from './app-process.js'
import { BROKER_KEEPALIVE_MS, RUN_META, serveBroker } from './broker.js'
import { BrokerDesk, type BrokerHost, type CapabilityDecisionListed, type CapabilityDenial, type CapabilityOrigin } from './desk.js'
import { memoryCapabilityBook, type CapabilityBook } from './capabilities.js'
import { checkScreen, checkTools, formatReport, type AppCheckReport, type CheckFinding, type CheckedTool } from './check.js'
import { ERRORS_KEPT, errorBundle, type AppErrorBundle } from './errors.js'
import { folderFingerprint } from './fingerprint.js'
import { PROJECT_APPS_PARTS, PROJECT_APPS_REL, USER_APPS_PARTS, USER_APPS_REL, scanApps, type ScannedApp } from './discovery.js'
import { MANIFEST_FILE, MANIFEST_VERSION, parseManifest, toolNameError, type AppManifest } from './manifest.js'
import { FAILURES_KEPT, RUN_RETENTION_MS, announcingLedger, describeArgs, type AgentUse, type AppRunListed, type RunLedger } from './runs.js'
import { appTemplateDir, ensureDirInside, oneLine, scaffoldApp } from './scaffold.js'
import { SecretStore, redactor, secretValueProblem } from './secrets.js'
import type { AppRef } from './ref.js'
import { AppHandover, type HandoverOptions } from './handover.js'
import type { Snapshot } from './versions.js'
import { resourceUriOf, visibilityOf, type Audience } from './visibility.js'

/**
 * The external app runtime (M4 A) — **the one file that is the door the core knows external apps
 * through.**
 *
 * A built-in app (`HOST_APPS` in `registry.ts`) is a compiled module, while an external app is a
 * folder discovered at runtime and the process that folder starts. The two live differently, so
 * their registries differ too, but the same rule holds for both (#81): the core's path to knowing
 * about an app has to stay narrow — so this runtime never imports the core, and instead **receives**
 * what it needs (the project list and their trust, the data folder) through `ExternalAppsDeps`. This
 * is the same inversion #97 did for the UI runtime: the runtime declares what it needs, and the host
 * fills it in.
 *
 * It never imports the store either. Projects and trust are asked for through a function — asked
 * every time because the store is the single source of truth. Holding a copy here would mean the
 * copy still answers "yes" after trust has been turned off.
 */

/**
 * The scope name for a user-folder app — a key in memory, and also one segment of the data and log
 * folders.
 * A project id is a UUID, so it never collides with this name.
 */
const USER_SCOPE = '_user'

export type { AppRef } from './ref.js'

/** The shape of a check report also leaves through this door (C-3) */
export type { AppCheckReport, CheckFinding } from './check.js'
/** The shape of an error bundle (C-6) */
export type { AppErrorBundle } from './errors.js'
/** The part of the broker's body the host's core fills in (D) — the manager supplies it via `attachBrokerHost` */
export type { AgentRunRequest, AgentRunResult, BrokerHost, CapabilityOrigin, CapabilityQuestion, CapabilityDecisionListed } from './desk.js'
/** Where a capability approval's answer is stored (D-4) — the host fills it in with the store (`app-permission-book.ts`) */
export type { CapabilityBook, CapabilityDecision } from './capabilities.js'
/** The closed list of host data (D-3) — the manager fills in what each name gives */
export { HOST_CAPABILITIES, type HostCapability } from './capabilities.js'

/** The shape of the ledger also leaves through this door — a place for the core to fill in (main.ts, `app-run-ledger.ts`) */
export type { RunLedger, AppRunRow, AppRunListed, AgentTokens, AgentUse } from './runs.js'
/** The rule for reading a tool's declared screen also leaves through this door — an in-conversation screen (B-1) uses the same validation as a fixed screen */
export { resourceUriOf } from './visibility.js'

/**
 * Who called it (from the plan, "there is one call path") — three kinds.
 *
 *   view     the app's screen. The v1 plan called this "a person", which was wrong — a screen is the
 *            app's own code, so it can call a tool with no one pressing anything. Which screen
 *            (`instanceId`) is used only to attribute "changed" — that screen never hears the change
 *            it produced itself (B-5)
 *   session  a session's agent (attached by A-5)
 *   app      a broker call from another app (D-2) — the chain continues through the parent run id
 */
export type AppCaller =
  | { kind: 'view'; instanceId?: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'app'; parentRunId: string }

export type AppRunStatus = 'ok' | 'error' | 'cancelled' | 'rejected'

/**
 * The outcome of one call. **A policy denial is returned, never thrown** — a denial is also an
 * outcome that gets recorded (A-6), and the caller (RPC, or a session's proxy server) only has to
 * translate it into "a failed tool call".
 *
 *   ok         the app answered
 *   error      the app answered with a failure (isError), failed to start, or died mid-call
 *   cancelled  the caller cancelled it — the app received notifications/cancelled
 *   rejected   the host never sent it to the app (audience, trust, an unknown tool, a stopped app, a
 *              parent that is not open)
 */
export type AppCallOutcome = {
  runId: string
  status: AppRunStatus
  /** The app's answer verbatim (the shape the screen's AppBridge receives) — null if there was none */
  result: CallToolResult | null
  error: string | null
  durationMs: number
}

/**
 * The numbers that govern lifecycle. The defaults are the product's values, and tests use smaller
 * ones.
 */
export type RuntimeTiming = {
  /** Shuts down after this long with no open screen and no call in progress (from the plan, A-3: 5 minutes) */
  idleMs: number
  /** After the nth consecutive failure, waits base × 2^(n-1) before the next start */
  backoffBaseMs: number
  /** Stops and holds the reason once consecutive failures reach this many (from the plan, A-3: 3) */
  maxFailures: number
  /** If it stayed alive this long before dying, consecutive failures are counted from zero again */
  stableMs: number
  /** How long to wait for it to end on its own after stdin and fd 3 are closed */
  graceMs: number
  /** How long to wait for an answer to generation probing (`server/discover`) before falling back to the old generation */
  probeTimeoutMs: number
  /** The cap for the connection and for the first tool list, each */
  connectTimeoutMs: number
  /**
   * The cap for one host → app tool call. Reset every time the app sends a progress notification.
   * Each caller also has its own cap (Codex 300 seconds, a screen 60 seconds — from the plan,
   * "long-running calls"); this is the outer fence around all of them.
   */
  callTimeoutMs: number
  /** The size of one generation of an app's own log file */
  logMaxBytes: number
  /**
   * The cap on how long a check (C-3) waits for a call in progress to finish. Past this, it checks
   * the running process instead of restarting it — the promise to never cut a call off outranks the
   * check.
   */
  checkDrainMs: number
  /**
   * When there is no building session, or it is idle, restarts after this much silence since the last
   * change in the app folder (C-4). Several saves from an editor collapse into one restart.
   */
  reloadQuietMs: number
  /** How long to collect a building session's turn-end notifications (C-4) — a turn ending and a state change arriving back to back still produce one restart */
  turnEndDebounceMs: number
  /** The interval for the keepalive progress notification sent to a waiting broker call (D) — see the BROKER_KEEPALIVE_MS comment in `broker.ts` */
  brokerKeepaliveMs: number
  /**
   * The cap on waiting for the person's answer in capability approval (D-4). Closes as a denial past
   * this (remembering nothing). Why 5 minutes: the question shows up somewhere a person looks (a
   * session's card, an app's fixed screen), but the person is not always there. During that wait, the
   * requesting app's call and the entire chain above it are all held open — longer, and calls pile up
   * while the person is away; shorter, and it closes before someone moving between screens gets a
   * chance to answer.
   */
  capabilityQuestionMs: number
  /** The window for counting how many times one app has started an agent (D-5, `AGENT_RUNS_PER_WINDOW`) — one minute. Reduced by tests */
  agentRateWindowMs: number
}

export const DEFAULT_TIMING: RuntimeTiming = {
  idleMs: 5 * 60_000,
  backoffBaseMs: 1_000,
  maxFailures: 3,
  stableMs: 60_000,
  // Measured in S-5: a well-built app ended within 2-11ms of its input closing. 2 seconds leaves plenty of room even for slow cleanup
  graceMs: 2_000,
  /*
   * Only a 2025-generation server that **never answers** the probe pays this cost (a server that
   * answers with "unknown method" falls back immediately — the official v1 SDK server connected as
   * legacy in 218ms). The generation discovered is remembered per app, so this cost is paid at most
   * once per app after the host starts.
   */
  probeTimeoutMs: 10_000,
  connectTimeoutMs: 30_000,
  callTimeoutMs: 10 * 60_000,
  logMaxBytes: 1024 * 1024,
  checkDrainMs: 30_000,
  reloadQuietMs: 2_000,
  turnEndDebounceMs: 300,
  brokerKeepaliveMs: BROKER_KEEPALIVE_MS,
  capabilityQuestionMs: 5 * 60_000,
  agentRateWindowMs: 60_000,
}

export type ExternalAppsDeps = {
  /** The root and trust of registered projects — read from the store every time this is called */
  projects(): readonly { id: string; path: string; trusted: boolean }[]
  /** The host's data folder (`dataRoot()`) — user apps and app data live under it */
  dataRoot: string
  /** An id an external app can never take — a built-in app's id. `apps.invoke` disambiguates between them by the same name */
  reservedIds: readonly string[]
  /** The folder-watching flush interval (reduced by tests) */
  watchFlushMs?: number
  timing?: Partial<RuntimeTiming>
  /** The environment an app process inherits (defaults to process.env) — the host's own variables are filtered out */
  env?: NodeJS.ProcessEnv
  /**
   * An app's tool call ended (only a call that reached the app — a denial changes nothing. Neither
   * does a read-only tool). The signal that lets an open screen see the same value (from the plan,
   * "how an open screen sees the same value"). The host relays it as a broadcast.
   * `cause` is whoever made that call — absent unless it is a call (as opposed to, say, the app
   * restarting and changing on its own — every screen hears that one)
   */
  emitChanged?: (ref: AppRef, cause?: AppCaller | null) => void
  /** Where the run ledger is stored (A-6) — the host fills it in with the store. Nothing is recorded if absent */
  runs?: RunLedger
  /**
   * A row visible on this app's runs panel started, got linked to a session, or ended (D-6) — the
   * signal that tells the runs panel to re-read. The host collects these per app and broadcasts them.
   * This also fires for a read-only tool's call and the chain beneath it: kept separate from
   * `emitChanged`, which wakes a screen (see the comment on `announcingLedger`).
   */
  emitRunsChanged?: (ref: AppRef) => void
  /**
   * Where a capability approval's answer is stored (D-4) — the host fills it in with the store. Falls
   * back to memory if absent: this still keeps the promise of asking once per host lifetime, and asks
   * again once the host restarts.
   */
  permissions?: CapabilityBook
  /** The template folder a new app is expanded from (C-1). Defaults to the one the product ships (`appTemplateDir`) */
  templateDir?: string
  /**
   * Whether this app's building session is currently mid-turn (C-4) — the host fills it in from
   * session state. If so, a change to the app folder does not trigger an immediate restart; it waits
   * for the turn to end (`builderTurnEnded`) instead. If not (edited from an editor), it waits for
   * things to go quiet.
   */
  builderBusy?: (ref: AppRef) => boolean
  /** Handover's (E) limits and download — reduced and replaced with a fake by tests. Uses the product's values if absent */
  handover?: HandoverOptions
}

type Scope = { key: string; projectId: string | null; root: string; trusted: boolean }

/** One app's lifecycle — a process comes and goes, but this stays alive as long as the app is in the list */
type Life = {
  proc: AppProcess | null
  starting: Promise<AppProcess> | null
  /** Consecutive failure count — counts both a failed start and an unannounced exit */
  failures: number
  /** The next startup never happens before this time (exponential backoff) */
  retryAt: number
  /** The reason for the last failure (including the tail of stderr) */
  lastError: string | null
  /** Stopped — failed maxFailures times in a row. Does not start again until a person restarts it */
  gaveUp: boolean
  /** The spec generation discovered — the next startup connects without probing */
  verdict: PriorDiscovery | undefined
  /**
   * A generation number. Raised every time it stops or changes — if a startup in progress finishes
   * with a different number than when it began, that process is already stale and is discarded (so an
   * app that should start with a changed manifest never starts with the old command instead).
   */
  epoch: number
  inflight: number
  /** Waiters for inflight to reach 0 — a check (C-3) never cuts off a call in progress, it waits and then restarts */
  idleWaiters: (() => void)[]
  /**
   * The fingerprint of the app folder the last-started process saw (C-4) — null if it has never
   * started. Reflecting a change compares the current folder against this, and restarts if they
   * differ. Survives the process going down: an edit made while it was idle and stopped still counts
   * as "changed".
   */
  stamp: string | null
  /**
   * The fingerprint the last process that **actually started** read (C-4) — the list's `codeStamp`.
   * Unlike `stamp`, a failed startup never changes this: an open screen compares it against the code
   * currently running to tell whether it is showing stale HTML. Reopening a screen against new code
   * that failed to start would show nothing but the failure.
   */
  loaded: string | null
  idle: NodeJS.Timeout | null
  /** The current process's tool list (names and audience passed validation), and the reasons for anything filtered out */
  tools: AppTool[] | null
  toolWarnings: string[]
  /**
   * The last tool list read — unlike `tools`, **this survives the process going down** (A-5).
   *
   * Attaching an app to a session needs its tool list, but knowing the tool list requires starting
   * the app. Starting every attached app every time a session starts would break "zero app processes
   * while idle" (the performance budget) for a single session. The list read once is remembered, and
   * re-read and announced if changed the next time the app starts. If the manifest changes, entries
   * are rebuilt fresh, so the old list disappears along with it.
   */
  known: AppTool[] | null
  /**
   * The current process's pipe number. An open run carries the pipe number it was born under, and the
   * broker only accepts a run under that same number — so even if the app restarts, a dead process's
   * run id never works on the new pipe.
   */
  pipeId: number
}

type AppTool = { tool: Tool; visibility: Audience[] }

/** A currently open host → app call */
type OpenRun = {
  entry: AppEntry
  pipeId: number
  tool: string
  /** Whoever called it — the basis for finding who started it by walking up the chain (where D-4's question is attributed) */
  caller: AppCaller
  /** Set when the call ends or is cancelled — broker work beneath this run stops together with it */
  abort: AbortController
}

type AppEntry = {
  ref: AppRef
  scope: Scope
  /** Exactly what discovery saw — the baseline the next scan is compared against */
  found: ScannedApp
  dir: string
  /** The result of layering the runtime's own validation (a reserved id) on top of discovery's */
  manifest: AppManifest | null
  error: string | null
  warnings: string[]
  life: Life
}

/**
 * How long it waits to capture stderr once more after a tool failure (C-6). The stack a thrown app
 * error carries goes to stderr, while the failure answer goes to stdout, and the order they arrive in
 * is not guaranteed. Since it is a pipe on the same machine, both arrive within a few milliseconds.
 */
const STDERR_SETTLE_MS = 150

/** An error bundle returned on request — carries the time it was sent, if it was sent to the building session (C-6) */
export type SentErrorBundle = AppErrorBundle & { sentAt: number | null }

/** The key for a sent bundle — within one app, a bundle is uniquely (kind, time). Stays the same key even after stderr is re-captured and the bundle is replaced */
const sentKey = (holdKey: string, b: Pick<AppErrorBundle, 'kind' | 'at'>): string => `${holdKey}\n${b.kind}\n${b.at}`

/**
 * The reason a new app id is rejected, worded for an agent and a person to read (C-1b). Validation is
 * one single function (`newAppIdProblem`, @cc/protocol) — only the wording is attached here. The new
 * app dialog attaches its own wording to the same validation result (`appIdHint`), while the
 * orchestrator's `create_app` reads this wording as-is.
 */
const APP_ID_PROBLEM: Record<NewAppIdProblem, string> = {
  shape: `an app id is lowercase letters, digits and hyphens (up to ${APP_ID_MAX_LENGTH}), starting with a letter or digit — no underscores: "__" separates names in a session's tool names`,
  reserved: `ids starting with "${RESERVED_NAME_PREFIX}" belong to Centralu itself`,
  'server-prefix': `ids starting with "${APP_SERVER_PREFIX}" are how apps attach to sessions — pick another`,
  builtin: 'that is the id of a built-in app — pick another',
}

/** An app that cannot be called — the reason is exactly the message */
export class AppUnavailableError extends Error {
  readonly code = 'internal'
}

export class ExternalApps {
  /** Scope key → (app id → entry) */
  private scopes = new Map<string, { scope: Scope; apps: Map<string, AppEntry> }>()
  private watchers: DirWatchers
  private disposed = false
  private timing: RuntimeTiming
  private secrets: SecretStore
  /** Run id → open run. The broker's gatekeeper asks against this */
  private openRuns = new Map<string, OpenRun>()
  /**
   * (scope, app id) → open screen count. Tied to the name rather than the app entry (AppEntry): when
   * the manifest changes, a new entry is created, but the screen in front of the person stays open the
   * whole time. Tying this to the entry instead would leave the new entry thinking it has zero
   * screens, and demote an app with an open screen to idle.
   */
  private viewHolds = new Map<string, number>()
  private pipeSeq = 0
  /** `onAppsChanged` subscribers, and whether a notification is already scheduled for this tick */
  private appsListeners = new Set<() => void>()
  private appsNotePending = false
  /** Timers for reflecting changes (C-4) — per app name (holdKey). Carried over even when the manifest changes and a new entry is created */
  private turnEndTimers = new Map<string, NodeJS.Timeout>()
  private quietTimers = new Map<string, NodeJS.Timeout>()
  /** A reflect in progress — an overlapping call waits on the same one */
  private reloading = new Map<string, Promise<boolean>>()
  /** Recent error bundles per app name (holdKey), most recent first (C-6) — carried over even when the manifest changes and a new entry is created */
  private errorLog = new Map<string, AppErrorBundle[]>()
  /**
   * A bundle sent to the building session → the time it was sent (C-6). Kept separately instead of
   * marked on the bundle because a tool-failure bundle **gets replaced with a new object** shortly
   * after, when it re-captures stderr (recordError) — a mark written onto the bundle would disappear
   * at that point.
   */
  private errorsSent = new Map<string, number>()
  /**
   * Every process this runtime has ever started that has not yet ended. Not just the ones an entry
   * (`Life.proc`) is holding onto: an old process waiting for its call to finish after a new entry was
   * created because the manifest changed (`haltWhenDrained`), or a process being shut down by a check
   * or a reflect, belongs to no entry at all. `dispose` ends this list, not the entries — ending only
   * the entries would leave such a process orphaned under launchd after the host exits (this happened
   * with three fixture apps left behind after running the check and reflect tests with the fix
   * disabled).
   */
  private spawned = new Set<AppProcess>()
  /**
   * Open run → the person denied this run's request (or one further down its chain) (D-4) — recorded
   * by the desk. If that run ends in failure, this is attached to that failure's error bundle (it is
   * not a bug in the app, it is the person's decision), and if the run belongs to an app that called
   * another, it is passed up to the parent: if A called B, B's request was denied so B failed, and
   * that is why A failed, then the reason A's screen states is that same denial. Cleared once the run
   * ends.
   */
  private denials = new Map<string, CapabilityDenial>()
  /**
   * The broker desk (D) — the one place that resolves what an app requests over fd 3. A call between
   * apps (D-2) goes through this runtime's single path (`call`). Constructed in the constructor —
   * where the answer's storage (`deps.permissions`) and the wait cap (`timing`) are decided.
   */
  private desk: BrokerDesk
  /** Handover (E) — the staging area for an imported app and the person's confirmation (`handover.ts`) */
  private handover: AppHandover

  constructor(private deps: ExternalAppsDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    // Every ledger row passes through this one place — a tool-call row (`call`) and a broker-request row (the desk) alike. So the runs panel's own signal is also produced here, once
    const notify = deps.emitRunsChanged
    if (deps.runs && notify) this.deps = { ...deps, runs: announcingLedger(deps.runs, notify) }
    this.desk = new BrokerDesk(
      {
        has: (ref) => this.find(ref) !== undefined,
        name: (ref) => this.find(ref)?.manifest?.name ?? ref.appId,
        redactor: (ref) => redactor(this.secrets.all(this.appKey(ref))),
        origin: (runId) => this.chainOrigin(runId),
        chain: (runId) => this.chainOf(runId),
        denied: (runId, d) => {
          if (this.openRuns.has(runId) && !this.denials.has(runId)) this.denials.set(runId, d)
        },
        call: (ref, tool, args, caller, opts) => this.call(ref, tool, args, caller, opts),
      },
      deps.permissions ?? memoryCapabilityBook(),
      () => ({ questionMs: this.timing.capabilityQuestionMs, agentRateWindowMs: this.timing.agentRateWindowMs }),
      this.deps.runs ?? null,
    )
    this.secrets = new SecretStore(deps.dataRoot)
    this.watchers = new DirWatchers((key) => this.rescan(key), deps.watchFlushMs)
    /*
     * Once at startup: closes a run that never saw its own ending, and prunes anything past
     * retention. This is the safe moment for it — this host has not opened a single run yet.
     */
    const settled = deps.runs?.settleUnfinished('the host stopped before this call finished') ?? 0
    const pruned = deps.runs?.prune(Date.now() - RUN_RETENTION_MS) ?? 0
    if (settled || pruned) console.error(`[apps] run records: ${settled} unfinished closed, ${pruned} past retention removed`)
    // Handover (E) — an imported app's staging area and confirmation. The runtime never starts an app still waiting on confirmation (`held`)
    this.handover = new AppHandover(
      {
        dataRoot: deps.dataRoot,
        reservedIds: deps.reservedIds,
        rescanUser: () => this.rescanUser(),
        userApp: (appId) => {
          const e = this.find({ projectId: null, appId })
          return e ? { dir: e.dir, manifest: e.manifest } : null
        },
        changed: () => this.appsChanged(),
      },
      deps.handover,
    )
  }

  /**
   * An app's recent error bundles (M4 C-6) — failing to start, an unannounced exit, a tool failure.
   * `latest` is what "send to the building session" would send. **Never sent automatically** — the
   * UI reads and sends this when a person presses the button (see the comment in errors.ts).
   */
  errors(ref: AppRef): { latest: SentErrorBundle | null; recent: SentErrorBundle[] } {
    const key = this.holdKey(ref)
    const recent = (this.errorLog.get(key) ?? []).map((b) => ({ ...b, sentAt: this.errorsSent.get(sentKey(key, b)) ?? null }))
    return { latest: recent[0] ?? null, recent }
  }

  /**
   * Records that one bundle was sent to the building session (C-6) — **only once.** Returns the
   * bundle to send, `'sent'` if it was already sent, or null if it is no longer held (it aged out of
   * the list, or the host restarted). Recording happens before sending: even if the person clicks
   * twice, or from two windows, it goes out only once. If sending fails, the caller reverts this with
   * `unmarkErrorSent` — a bundle that never actually went out is never left marked "sent".
   *
   * The sending itself does not happen here. The runtime only collects bundles and answers when asked
   * (errors.ts); what actually sends it is the RPC a person triggers by clicking.
   */
  markErrorSent(ref: AppRef, at: number): AppErrorBundle | 'sent' | null {
    const key = this.holdKey(ref)
    const list = this.errorLog.get(key) ?? []
    const b = list.find((x) => x.at === at)
    if (!b) return null
    const k = sentKey(key, b)
    if (this.errorsSent.has(k)) return 'sent'
    // Clears the mark for a bundle that has aged out of the list — a mark has no reason to outlive the bundle it belongs to
    for (const old of [...this.errorsSent.keys()]) {
      if (old.startsWith(`${key}\n`) && !list.some((x) => sentKey(key, x) === old)) this.errorsSent.delete(old)
    }
    this.errorsSent.set(k, Date.now())
    return b
  }

  unmarkErrorSent(ref: AppRef, at: number): void {
    const key = this.holdKey(ref)
    const b = (this.errorLog.get(key) ?? []).find((x) => x.at === at)
    if (b) this.errorsSent.delete(sentKey(key, b))
  }

  /**
   * Records one error bundle. Since a tool failure's answer can arrive before stderr does (two
   * separate pipes — a thrown stack goes over stderr, the failure answer over stdout), that process's
   * stderr is captured once more a little afterward.
   */
  private recordError(e: AppEntry, b: Omit<AppErrorBundle, 'text' | 'denied'> & { denied?: AppErrorBundle['denied'] }, proc: AppProcess | null = null): void {
    const key = this.holdKey(e.ref)
    const app = `${e.manifest?.name ?? e.ref.appId} (${this.label(e.ref)})`
    const list = this.errorLog.get(key) ?? []
    let bundle = errorBundle(app, proc ? { ...b, stderr: proc.log.tailLines() } : b)
    list.unshift(bundle)
    if (list.length > ERRORS_KEPT) list.length = ERRORS_KEPT
    this.errorLog.set(key, list)
    /*
     * The "time of the last error" the list states has changed — the screen (the error row) sees this
     * and re-reads the bundle. Why this does not rely on "changed" (emitChanged): a read-only tool's
     * call never emits it (doing so would turn a screen re-reading on failure into a loop). Failing to
     * start or dying already announced through the status change, but for a tool failure, this is the
     * only signal.
     */
    this.appsChanged()
    if (!proc) return
    setTimeout(() => {
      const i = list.indexOf(bundle)
      if (i < 0) return
      bundle = errorBundle(app, { ...b, stderr: proc.log.tailLines() })
      list[i] = bundle
    }, STDERR_SETTLE_MS).unref()
  }

  /**
   * Receives the part of the broker's body only the host's core can do (an agent session) (D). Called
   * by the manager when it receives the runtime (`SessionManager.useExternalApps`) — the host's main
   * and the tests use the same seam. Empties it if null: a request afterward is refused with "no
   * agent to lend".
   */
  attachBrokerHost(host: BrokerHost | null): void {
    this.desk.attach(host)
  }

  /**
   * The remembered capability answers for one app (D-4), most recent first. `current` means it was
   * given against the manifest's current `uses`; otherwise it is no longer used. Everything is
   * non-current if the manifest is invalid or the app is gone.
   */
  permissions(ref: AppRef): CapabilityDecisionListed[] {
    const m = this.find(ref)?.manifest
    return this.desk.permissions(ref, m ? m.uses : null)
  }

  /** Forgets one remembered answer (D-4) — the next time that capability is needed, it is asked again */
  forgetPermission(ref: AppRef, capability: string): void {
    this.desk.forgetPermission(ref, capability)
  }

  /**
   * The chain leading up to this run (D-5) — the (app, tool) pairs from the call that started the
   * chain to this run. Only open runs are followed: a call beneath it lives only while its parent is
   * open (it is cancelled once the parent ends), so a running request's chain is never broken.
   */
  private chainOf(runId: string): { ref: AppRef; tool: string }[] {
    const path: { ref: AppRef; tool: string }[] = []
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && hops < 32; hops++) {
      path.unshift({ ref: run.entry.ref, tool: run.tool })
      run = run.caller.kind === 'app' ? this.openRuns.get(run.caller.parentRunId) : undefined
    }
    return path
  }

  /**
   * The agent usage one app has requested (D-5) — over the last day, and over the 30 days records are
   * kept. Read by the runs panel (`apps.usage`).
   */
  agentUse(ref: AppRef): { day: AgentUse; month: AgentUse } {
    const now = Date.now()
    const none = { runs: 0, durationMs: 0, tokens: null }
    const ledger = this.deps.runs
    return {
      day: ledger?.agentUse(ref.projectId, ref.appId, now - 24 * 60 * 60 * 1000) ?? none,
      month: ledger?.agentUse(ref.projectId, ref.appId, now - RUN_RETENTION_MS) ?? none,
    }
  }

  /**
   * Who started this run's chain (D-4) — walking up through parents to the first caller that is not
   * an app. For a screen, the answer is that screen's app (the question is attributed to its fixed
   * screen). If a parent along the way has already ended, this cannot be followed — returns null.
   */
  private chainOrigin(runId: string): CapabilityOrigin | null {
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && run.caller.kind === 'app' && hops < 32; hops++) run = this.openRuns.get(run.caller.parentRunId)
    if (!run) return null
    if (run.caller.kind === 'session') return { kind: 'session', sessionId: run.caller.sessionId }
    if (run.caller.kind === 'view') return { kind: 'view', app: run.entry.ref }
    return null
  }

  /** One app's run records, most recent first (B-7) — records are still readable even for an app whose folder is gone */
  runs(ref: AppRef, limit = 100): AppRunListed[] {
    return this.deps.runs?.list(ref.projectId, ref.appId, limit) ?? []
  }

  /**
   * Re-reads the project list and trust, and rescans everything.
   *
   * Called once at startup, and whenever a project is added or removed or trust changes (an RPC door
   * calls this). Changes inside a folder are tracked separately by watching — this function decides
   * "which folders to watch". **It never starts anything** — an app starts only the first time it is
   * needed.
   */
  refresh(): void {
    if (this.disposed) return
    const want = new Map<string, Scope>()
    want.set(USER_SCOPE, { key: USER_SCOPE, projectId: null, root: this.deps.dataRoot, trusted: true })
    for (const p of this.deps.projects()) {
      want.set(p.id, { key: p.id, projectId: p.id, root: p.path, trusted: p.trusted })
    }
    for (const key of [...this.scopes.keys()]) {
      if (!want.has(key)) this.dropScope(key)
    }
    for (const scope of want.values()) {
      const cur = this.scopes.get(scope.key)
      if (cur) cur.scope = scope
      else this.scopes.set(scope.key, { scope, apps: new Map() })
      this.rescan(scope.key)
    }
  }

  /** Every discovered external app — an untrusted project's app and one with a broken manifest appear too, with their reason */
  list(): ExternalAppInfo[] {
    const out: ExternalAppInfo[] = []
    for (const { apps } of this.scopes.values()) {
      for (const e of apps.values()) out.push(this.info(e))
    }
    return out
  }

  /**
   * An app's tool list — if the app is down, **this is where it starts** (the first time it is
   * needed).
   *
   * A tool with `__` in its name is dropped right here (A-1's `toolNameError`). The place a list is
   * read is the place it is enforced: this list becomes the source of truth both for what attaches to
   * a session (A-5) and for the tools a screen can call.
   */
  async tools(ref: AppRef, audience?: Audience): Promise<Tool[]> {
    const e = this.require(ref)
    const all = await this.use(e, async () => e.life.tools ?? [])
    return all.filter((t) => !audience || t.visibility.includes(audience)).map((t) => t.tool)
  }

  /**
   * The last tool list read — **never starts the app.** Null if it has never been read.
   *
   * The side that attaches an app to a session (A-5) checks this first, and starts the app with
   * `tools()` only if there is none. The list survives even while the app is down, so an app process
   * does not start every time a session starts.
   */
  knownTools(ref: AppRef, audience?: Audience): Tool[] | null {
    const known = this.require(ref).life.known
    if (!known) return null
    return known.filter((t) => !audience || t.visibility.includes(audience)).map((t) => t.tool)
  }

  /**
   * The app list, or an app's agent-facing tools, may have changed (A-5) — the moment to recount which
   * apps are attached to a session.
   *
   * When this fires: an app folder appears, disappears, or its manifest changes; a project is added
   * or removed; trust changes; an app stops (repeated failure) or restarts; a re-read tool list
   * differs from before. **What** changed is never carried — the receiving side re-reads `list()` and
   * `knownTools()` instead (the same approach as #81's "one notification, then re-read"). Changes
   * piling up within one tick are collapsed into one.
   *
   * This also fires for an app's lifecycle (starting, running, stopped from being idle, dead) (A-8).
   * Since the sidebar and the fixed screen show `list()`'s status, every place that status changes has
   * to pass through here. The session side compares what it currently sees (the attached apps and
   * tools) and does nothing if unchanged, so more notifications never mean more work. Why this is not
   * split into two separate notifications: the day something that changes the list calls only one of
   * the two, that change would reach only one of the two kinds of listener.
   */
  onAppsChanged(listener: () => void): () => void {
    this.appsListeners.add(listener)
    return () => void this.appsListeners.delete(listener)
  }

  private appsChanged(): void {
    if (this.appsNotePending || this.disposed) return
    this.appsNotePending = true
    queueMicrotask(() => {
      this.appsNotePending = false
      if (this.disposed) return
      for (const l of [...this.appsListeners]) {
        try {
          l()
        } catch (err) {
          // One listener's failure never blocks another session's update
          console.error('[apps] apps-changed listener failed:', err)
        }
      }
    })
  }

  /**
   * The **single path** through which an app's tool is called (M4 A-4).
   *
   * A call from a screen (`apps.invoke`), from a session's proxy server (A-5), and from another app
   * via the broker (D-2) all come through here. So audience checking, issuing a run id, cancellation,
   * the "changed" notification, and the ledger (A-6) all happen exactly once per call, through the
   * same code — with two paths, one of them eventually misses a check.
   */
  async call(
    ref: AppRef,
    name: string,
    args: Record<string, unknown>,
    caller: AppCaller,
    opts: {
      signal?: AbortSignal
      /**
       * Called once, the moment a run id is decided — used by a caller that needs the id before the
       * outcome is known (A-5's "long-running calls": returning "still running, run id is …" before
       * Codex's cap, rather than waiting for the outcome).
       */
      onRun?: (runId: string) => void
      /**
       * The text of a progress notification the app sent for this call (D) — a line the broker sent
       * the app, like "waiting on the person's approval in session X", is relayed up through this call
       * by the template's helper. Moved to somewhere the caller can display it (a session's tool card).
       * A wordless keepalive notification is never passed through.
       */
      onProgress?: (message: string) => void
    } = {},
  ): Promise<AppCallOutcome> {
    const e = this.require(ref)
    const runId = `run_${randomUUID()}`
    opts.onRun?.(runId)
    const t0 = Date.now()
    /*
     * A row is created as `running` the moment a call comes in, and corrected with its outcome when it
     * ends — a denial is also a row. What is masked is every secret stored for this app: whichever of
     * the arguments, the result, or the failure reason it ends up mixed into, only the name survives.
     */
    const redact = this.deps.runs ? redactor(this.secrets.all(this.appKey(e.ref))) : (t: string) => t
    const described = this.deps.runs ? describeArgs(args, redact) : null
    this.deps.runs?.begin({
      id: runId,
      projectId: e.ref.projectId,
      appId: e.ref.appId,
      kind: 'tool',
      sessionId: null,
      tool: name,
      callerKind: caller.kind,
      callerSessionId: caller.kind === 'session' ? caller.sessionId : null,
      parentRunId: caller.kind === 'app' ? caller.parentRunId : null,
      status: 'running',
      durationMs: null,
      argsDigest: described?.digest ?? '',
      argsSummary: described?.summary ?? '',
      error: null,
      createdAt: t0,
    })
    /** Whether it was actually sent to the app — "changed" only fires for a call that reached the app (a denial, cancellation while starting, or a failed startup changes nothing) */
    let sent = false
    /*
     * Is this a read-only tool (`readOnlyHint: true`)? Reading changes nothing, so "changed" is never
     * emitted for it either. Measured (65acb43): the template screen re-calls `show` on every
     * notification, and that `show` itself emits another notification, so a single screen called
     * `show` roughly 700 times per second (618 run-ledger rows in one second, 2035 in three seconds).
     * A tool with no annotation is treated as one that can change something, following MCP's own
     * default — if the wrong choice here is "does not notify", the screen shows a stale value.
     */
    let readOnly = false
    /** The process that received this call — its stderr is attached to the error bundle if the call fails (C-6) */
    let callee: AppProcess | null = null
    const done = (status: AppRunStatus, result: CallToolResult | null, error: string | null): AppCallOutcome => {
      const denial = this.denials.get(runId) ?? null
      this.denials.delete(runId)
      if (denial && status !== 'ok' && caller.kind === 'app' && this.openRuns.has(caller.parentRunId) && !this.denials.has(caller.parentRunId)) {
        this.denials.set(caller.parentRunId, denial)
      }
      /*
       * A call that reached the app failed (C-6) — this records only what could plausibly be the app's
       * own fault. A denial is policy, and a failure to start was already recorded separately by the
       * startup path. Arguments are masked under the same rule as the ledger — this bundle can become
       * the building session's prompt.
       */
      if (status === 'error' && sent) {
        const hide = this.deps.runs ? redact : redactor(this.secrets.all(this.appKey(e.ref)))
        this.recordError(
          e,
          {
            kind: 'tool',
            at: Date.now(),
            message: hide(error ?? '').split('\n')[0]!,
            stderr: [],
            tool: name,
            args: (described ?? describeArgs(args, hide)).summary,
            runId,
            denied: denial && { appId: denial.app.appId, projectId: denial.app.projectId, name: denial.name, capability: denial.capability, text: denial.text },
          },
          callee,
        )
      }
      const durationMs = Date.now() - t0
      const ledger = this.deps.runs
      if (ledger && described) {
        ledger.end(runId, { status, durationMs, error: error === null ? null : redact(error) })
        // A failed input is needed by the building agent to fix things — kept only for the most recent, and masked
        if (status === 'error') {
          ledger.keepFailure(
            { runId, projectId: e.ref.projectId, appId: e.ref.appId, args: described.json, result: result ? redact(JSON.stringify(result)) : null, createdAt: t0 },
            FAILURES_KEPT,
          )
        }
      }
      if (sent && !readOnly) this.deps.emitChanged?.(e.ref, caller)
      return { runId, status, result, error, durationMs }
    }

    // Checks that end before anything is sent to the app — do not even need to start a process
    if (!e.manifest) return done('rejected', null, `This app's manifest is invalid: ${e.error}`)
    if (!e.scope.trusted) return done('rejected', null, "This app's project is not trusted, so Centralu does not call its apps")
    const held = this.held(e)
    if (held) return done('rejected', null, held)
    if (e.life.gaveUp) return done('rejected', null, `This app stopped after failing ${this.timing.maxFailures} times in a row`)
    let parent: OpenRun | null = null
    if (caller.kind === 'app') {
      parent = this.openRuns.get(caller.parentRunId) ?? null
      if (!parent) return done('rejected', null, `The run that asked for this call is not open: ${caller.parentRunId}`)
    }
    if (opts.signal?.aborted) return done('cancelled', null, 'Cancelled before the call was sent')

    try {
      return await this.use(e, async (proc) => {
        const found = e.life.tools?.find((t) => t.tool.name === name)
        if (!found) return done('rejected', null, `This app has no tool named ${name}`)
        /*
         * A screen may call only `app` tools, and an agent or another app only `model` tools. A session
         * only ever receives `model` tools in its list to begin with (A-5), but a tool could still be
         * called if its name is known — hiding something from the list and blocking the call are
         * different things, and the blocking happens here.
         */
        const need: Audience = caller.kind === 'view' ? 'app' : 'model'
        if (!found.visibility.includes(need)) {
          return done('rejected', null, `${name} is not open to ${need === 'app' ? 'views' : 'agents'} (visibility: ${JSON.stringify(found.visibility)})`)
        }

        const upstream = [opts.signal, parent?.abort.signal].filter((x): x is AbortSignal => !!x)
        /*
         * If it was cancelled while the app was starting, this is never sent. Measured: a call
         * cancelled while starting ran a 5-second tool to completion anyway — a listener attached to a
         * signal that has already fired is never called.
         */
        if (upstream.some((sig) => sig.aborted)) return done('cancelled', null, 'Cancelled while the app was starting')
        const abort = new AbortController()
        const onUp = () => abort.abort(new Error('the caller cancelled this call'))
        for (const sig of upstream) sig.addEventListener('abort', onUp, { once: true })
        this.openRuns.set(runId, { entry: e, pipeId: e.life.pipeId, tool: name, caller, abort })
        sent = true
        readOnly = found.tool.annotations?.readOnlyHint === true
        callee = proc
        try {
          /*
           * Why `onprogress` is provided: the MCP SDK only attaches a progress token to a request when
           * this is present (in the client's request — without a token, the app has no way to send a
           * progress notification). So until now, `resetTimeoutOnProgress` did nothing at all. While an
           * app requests an agent and waits (D-1, which can take minutes), the template's helper has to
           * relay that wait up as this call's own progress, or the call gets cut off at
           * `callTimeoutMs`. If the notification carries a message, it is passed to the caller
           * (`onProgress`) — while the app waits on a person, the calling session's card can state what
           * it is waiting for. Before this, it was dropped here and never reached anywhere.
           */
          const result = await proc.client.callTool(
            { name, arguments: args, _meta: { [RUN_META]: runId } },
            {
              signal: abort.signal,
              timeout: this.timing.callTimeoutMs,
              resetTimeoutOnProgress: true,
              onprogress: (p) => {
                if (typeof p.message === 'string' && p.message.trim()) opts.onProgress?.(p.message)
              },
            },
          )
          return result.isError ? done('error', result, resultText(result) || 'The tool returned an error with no text') : done('ok', result, null)
        } catch (err) {
          if (abort.signal.aborted) return done('cancelled', null, 'The caller cancelled this call')
          return done('error', null, (err as Error).message)
        } finally {
          this.openRuns.delete(runId)
          // When a run ends, the broker work beneath it also ends — so nothing is left behind even if the app answered without waiting
          abort.abort()
          for (const sig of upstream) sig.removeEventListener('abort', onUp)
        }
      })
    } catch (err) {
      // Failed to start (a failed startup, or changed while backing off) — never reached the app, but this is not a policy denial
      return done('error', null, (err as Error).message)
    }
  }

  /**
   * Reads an app's resource — the path a screen uses to read its own `ui://` document and resources
   * (B-3, B-4's `onreadresource`). Not a tool call, so no run record is kept, but the rules for
   * starting the app (trust, only when first needed) are the same.
   */
  async readResource(ref: AppRef, uri: string): Promise<ReadResourceResult> {
    const e = this.require(ref)
    return this.use(e, (proc) => proc.client.readResource({ uri }, { timeout: this.timing.connectTimeoutMs }))
  }

  /**
   * The list of resources an app offers (MCP `resources/list`, following pagination) — the basis an
   * in-conversation screen (B-1) uses to check that a `ui://` a tool declared **actually belongs to
   * this app** (from the plan, "blocking impersonation"). Starts the app under the same rule as
   * reading. Follows only up to a page cap — so an app that keeps handing out the next page cannot
   * hold the host hostage.
   */
  async listResources(ref: AppRef, maxPages = 20): Promise<ListResourcesResult['resources']> {
    const e = this.require(ref)
    return this.use(e, async (proc) => {
      const out: ListResourcesResult['resources'] = []
      let cursor: string | undefined
      for (let page = 0; page < maxPages; page++) {
        const r = await proc.client.listResources(cursor ? { cursor } : {}, { timeout: this.timing.connectTimeoutMs })
        out.push(...r.resources)
        cursor = r.nextCursor
        if (!cursor) break
      }
      return out
    })
  }

  /**
   * One screen is holding this app open (called by ViewHost's open). While a screen is open, this is
   * never treated as an idle app — call the returned function to release the hold (close).
   */
  retainView(ref: AppRef): () => void {
    const e = this.require(ref)
    const key = this.holdKey(e.ref)
    this.viewHolds.set(key, (this.viewHolds.get(key) ?? 0) + 1)
    this.clearIdle(e)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.viewHolds.get(key) ?? 1) - 1
      if (left > 0) this.viewHolds.set(key, left)
      else this.viewHolds.delete(key)
      // Not the entry from when this was held, but the **current** entry — if the manifest changed in the meantime, the new entry starts going idle
      const now = this.find(ref)
      if (now) this.armIdle(now)
    }
  }

  /**
   * The tool that opens the fixed screen, and that screen itself (B-2) — the manifest's `home`, and
   * that tool's declared `_meta.ui.resourceUri`. Since this needs the tool list, if the app is down,
   * **this is where it starts**.
   *
   * A tool declaring no screen is never accepted. A fixed screen is one born from a tool call (from
   * the plan, "the two places a screen can appear"), and calling a tool with no screen would leave
   * only a result with nothing to open. Calling it anyway would leave the person watching the app's
   * state change with nothing appearing on screen. So this is refused **before** ever calling it. The
   * reason is worded for a person, since it shows up on screen verbatim.
   */
  async homeView(ref: AppRef): Promise<{ tool: string; resourceUri: string }> {
    const e = this.require(ref)
    if (!e.manifest) throw new AppUnavailableError(`This app's manifest is invalid: ${e.error ?? 'unknown error'}`)
    const home = e.manifest.home
    if (!home) throw new AppUnavailableError('This app has no screen: its manifest names no home tool')
    const all = await this.use(e, async () => e.life.tools ?? [])
    const found = all.find((t) => t.tool.name === home)
    if (!found) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" is not in its tool list`)
    const ui = resourceUriOf(found.tool)
    if (ui.error) throw new AppUnavailableError(`This app's screen is declared wrong: ${ui.error}`)
    if (!ui.uri) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" declares no _meta.ui.resourceUri`)
    return { tool: home, resourceUri: ui.uri }
  }

  /**
   * A screen's origin handling (B-3) — the manifest's `view.origin`. Opaque if the app does not exist
   * or its manifest is invalid: an unknown app is never handed a real origin (a port that leaves
   * storage behind).
   */
  viewOrigin(ref: AppRef): 'opaque' | 'app' {
    return this.find(ref)?.manifest?.view?.origin ?? 'opaque'
  }

  /**
   * Lets a stopped app start again (B-6's "Restart"). Clears consecutive failures and backoff, and
   * stops it if running — **never starts it**, the next time it is needed does.
   */
  async restart(ref: AppRef): Promise<void> {
    const e = this.require(ref)
    await this.halt(e, 'restart requested')
    Object.assign(e.life, { failures: 0, retryAt: 0, lastError: null, gaveUp: false, verdict: undefined })
    // A stopped app had been detached from sessions — announce so it can attach again. A crashed app's
    // reason is also cleared, changing its status in the list (A-8)
    this.appsChanged()
  }

  /**
   * Creates a screen-less app in the user folder (M4 A-7, decision 8) — where an MCP server a person
   * approved turns into an app.
   *
   * If an approved server lived in a separate registry (app_settings), the approval flow and the
   * attach path would both be duplicated. That server's calls never went through the broker, were
   * never recorded, and could not even be removed from a list. Becoming an app puts it on the same one
   * path every other app takes (audience, the run ledger, starting only when first needed, stopping
   * when idle). Since it is a user-folder app, it attaches to the orchestrator (decision 4 — the same
   * place a previously approved server used to attach).
   *
   * Validation is the same single set discovery uses: a manifest is built and passed through
   * `parseManifest` before it is written (the id rule from #93 lives there too). A built-in app's id
   * cannot be taken. **If an app with the same id already exists** — if it is the same server, that
   * app is returned as-is (calling this again produces the same result: when a move was interrupted
   * partway and runs again), and if different, this refuses (a person-made app is never overwritten).
   *
   * How it is written: to a temp folder starting with a dot (skipped by discovery), then renamed —
   * there is never a moment where discovery could read a half-written manifest as "a broken app".
   * Rescanned immediately after writing: on the user side, nothing is watched while `apps/` does not
   * exist yet (watching the data folder itself would wake up on every write to store.db), so watching
   * never catches the very first app. **This never starts it** — it starts the first time it is
   * needed.
   */
  installUserApp(spec: { id: string; name: string; description: string; server: { command: string; args: string[] } }): ExternalAppInfo {
    if (this.disposed) throw new AppUnavailableError('The app runtime has shut down')
    if (this.deps.reservedIds.includes(spec.id)) throw new AppUnavailableError(`"${spec.id}" is the name of a built-in app — use another name`)
    const text = JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        id: spec.id,
        name: spec.name,
        version: '1.0.0',
        description: spec.description,
        server: { command: spec.server.command, args: spec.server.args },
      },
      null,
      2,
    )
    const parsed = parseManifest(text)
    if (!parsed.ok) throw new AppUnavailableError(`This cannot become an app — ${parsed.error}`)

    this.rescanUser()
    const ref: AppRef = { projectId: null, appId: spec.id }
    const parent = join(this.deps.dataRoot, USER_APPS_REL)
    const dir = join(parent, spec.id)
    const held = this.find(ref)
    if (held || existsSync(dir)) {
      const same =
        held?.manifest?.server.command === spec.server.command &&
        JSON.stringify(held.manifest.server.args) === JSON.stringify(spec.server.args)
      if (held && same) return this.info(held)
      throw new AppUnavailableError(`Your user folder already has an app "${spec.id}" — use another name, or remove that app first`)
    }

    mkdirSync(parent, { recursive: true })
    const staging = join(parent, `.${spec.id}.${randomUUID()}`)
    mkdirSync(staging)
    try {
      writeFileSync(join(staging, MANIFEST_FILE), text + '\n')
      renameSync(staging, dir)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw new AppUnavailableError(`Could not write the app folder: ${(err as Error).message}`)
    }
    this.rescanUser()
    const made = this.find(ref)
    if (!made) throw new AppUnavailableError(`The app folder was written, but discovery did not find it: ${dir}`)
    return this.info(made)
  }

  /**
   * Checks an app (M4 C-3) — called by a building session's `check` and by `apps.check`. This is
   * where a building agent tests its own app in place of a person.
   *
   *   1. Rescans — reads the just-edited manifest under the same validation discovery uses
   *      (`parseManifest`)
   *   2. Restarts **with the current files** — a running process could still be old code. A call in
   *      progress is never cut off: this waits for it to finish (`checkDrainMs`), and past that, checks
   *      the running process instead and states so
   *   3. **Actually** calls for the tool list — in S-6, even a broken server's process stayed alive
   *   4. Reads each `ui://` screen the tools point at, one at a time
   *   5. Validates the naming, audience, annotation, and home problems (`check.ts`)
   *
   * **This never leaves the app in a strange state.** A check tries starting even a stopped (failed)
   * app — the same as a person pressing "Restart" (it clears consecutive failures). So repeating a
   * check never pushes an app further toward stopped: if it fails to start, that one failure
   * (crashed) and its reason are recorded, and if it starts, it becomes a normal running app (stopping
   * again if idle). A check never calls a tool, so it leaves no row in the run ledger.
   */
  async check(ref: AppRef): Promise<AppCheckReport> {
    const label = `${ref.projectId === null ? 'user' : ref.projectId.slice(0, 8)}/${ref.appId}`
    const findings: CheckFinding[] = []
    const notes: string[] = []
    let tools: CheckedTool[] = []
    const screens: { uri: string; chars: number }[] = []
    let procLine: string | null = null
    const report = (stderr: string | null) => formatReport(label, { findings, tools, screens }, { process: procLine, notes, stderr })

    const key = ref.projectId ?? USER_SCOPE
    // A check is a request to read the current files right now — even a manifest change deferred because it was mid-turn is read now (C-4, `rescan`'s `now`)
    if (this.scopes.has(key)) this.rescan(key, { now: ref.appId })
    else this.refresh()
    const e = this.find(ref)
    if (!e) {
      findings.push({ level: 'problem', where: 'app', message: 'there is no such app — its folder was removed or renamed' })
      return report(null)
    }
    for (const w of e.warnings) findings.push({ level: 'warning', where: 'centralu.app.json', message: w })
    if (!e.manifest) {
      findings.push({ level: 'problem', where: 'centralu.app.json', message: e.error ?? 'the manifest is invalid' })
      return report(null)
    }
    if (!e.scope.trusted) {
      findings.push({ level: 'problem', where: 'trust', message: "this app's project is not trusted, so the app does not start — trust the project to check it" })
      return report(null)
    }
    const held = this.held(e)
    if (held) {
      findings.push({ level: 'problem', where: 'review', message: held })
      return report(null)
    }

    // Restarts with the current files — stopped in **the very same tick** the call finishes (see the comment on drain)
    let restarted = false
    for (;;) {
      if (e.life.inflight === 0) {
        const wasStopped = e.life.gaveUp
        void this.halt(e, 'check: starting again from the files on disk')
        Object.assign(e.life, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
        if (wasStopped) this.appsChanged()
        restarted = true
        break
      }
      const busy = e.life.inflight
      if (!(await this.drain(e, this.timing.checkDrainMs))) {
        const limit = this.timing.checkDrainMs >= 1000 ? `${Math.round(this.timing.checkDrainMs / 1000)} s` : `${this.timing.checkDrainMs} ms`
        notes.push(
          `${busy} call${busy === 1 ? ' was' : 's were'} still running after ${limit}, so the app was not restarted — ` +
            'this report is about the process that was already running, which may not have your latest code',
        )
        break
      }
    }

    let stderr: string | null = null
    try {
      await this.use(e, async (proc) => {
        const listed = await proc.client.listTools(undefined, { timeout: this.timing.connectTimeoutMs })
        proc.tools = listed.tools
        this.readTools(e, proc)
        const t = checkTools(e.manifest!, listed.tools)
        findings.push(...t.findings)
        tools = t.tools
        for (const uri of t.screens) {
          let read: ReadResourceResult | Error
          try {
            read = await proc.client.readResource({ uri }, { timeout: this.timing.connectTimeoutMs })
          } catch (err) {
            read = err as Error
          }
          const s = checkScreen(uri, read)
          findings.push(...s.findings)
          screens.push({ uri, chars: s.chars })
        }
        procLine = `pid ${proc.child.pid}, ${proc.client.getProtocolEra()} (${proc.client.getNegotiatedProtocolVersion()}), ${restarted ? 'restarted from the files on disk' : 'the process that was already running'}`
        stderr = proc.log.tail() || null
      })
    } catch (err) {
      // Failed to start — the reason already includes the tail of stderr (AppProcess.start)
      findings.push({ level: 'problem', where: 'start', message: (err as Error).message })
    }
    return report(stderr)
  }

  /**
   * Creates a new app from the template (M4 C-1b) — "New app" (`apps.create`) and the orchestrator's
   * `create_app` use the same door.
   *
   *   project app     `<project>/.centralu/apps/<id>/` — committed to the repository and shared with
   *                   the team (decision 1's default)
   *   user-folder app `<data folder>/apps/<id>/` — for something used across several projects
   *                   (`projectId: null`)
   *
   * Three things refused, all before the folder is created:
   *   - **the name**: the same rule as a proposed MCP server (`newAppIdProblem` — #93's characters and
   *     the `centralu` reservation, plus a ban on the `app-` prefix). Discovery still reads an id with
   *     the `app-` prefix (a hand-made app), but there is no reason for a newly created app to have a
   *     server name like `app-app-notes`. A built-in app's id is also refused.
   *   - **an untrusted project**: a created app is code that runs on this machine, and an app in an
   *     untrusted project never starts (decision 3). An app that can be created but never runs would
   *     leave the building session spinning its wheels.
   *   - **an id that already exists**: even a folder standing there with an invalid manifest belongs
   *     to a person or an agent — never overwritten.
   *
   * Writing follows the same method as `installUserApp`: expanded into a temp folder starting with a
   * dot, then renamed (so discovery never sees a half-written app). The parent folder is created one
   * segment at a time through the path guard (`ensureDirInside` — stops if `.centralu` is a link
   * pointing outside). The data folder is also created right away. Rescanned immediately after
   * writing — watching might not be looking at that location yet. **This never starts it** — it
   * starts the first time it is needed.
   */
  createApp(spec: { projectId: string | null; id: string; name: string; description?: string }): ExternalAppInfo {
    if (this.disposed) throw new AppUnavailableError('The app runtime has shut down')
    const idProblem = newAppIdProblem(spec.id, this.deps.reservedIds)
    if (idProblem) throw new AppUnavailableError(`"${spec.id}" cannot be an app id — ${APP_ID_PROBLEM[idProblem]}`)
    const name = oneLine(spec.name)
    if (!name) throw new AppUnavailableError('The app needs a name')
    const description = oneLine(spec.description ?? '') || `${name} (a Centralu app)`

    // Trust is read from the single source of truth (the store) every time this is called — never from the runtime's own copy of scope
    let root = this.deps.dataRoot
    if (spec.projectId !== null) {
      const project = this.deps.projects().find((p) => p.id === spec.projectId)
      if (!project) throw new AppUnavailableError(`There is no such project: ${spec.projectId}`)
      if (!project.trusted) {
        throw new AppUnavailableError('Centralu does not make apps in a project it does not trust — an app is code that runs on this machine, so trust the project first')
      }
      root = project.path
    }
    const key = spec.projectId ?? USER_SCOPE
    if (this.scopes.has(key)) this.rescan(key)
    else this.refresh()

    const ref: AppRef = { projectId: spec.projectId, appId: spec.id }
    const parts = spec.projectId === null ? USER_APPS_PARTS : PROJECT_APPS_PARTS
    const dir = join(root, ...parts, spec.id)
    if (this.find(ref) || existsSync(dir)) {
      throw new AppUnavailableError(`An app "${spec.id}" already exists (${dir}) — use another id`)
    }

    let staging: string | null = null
    try {
      const parent = ensureDirInside(root, parts)
      staging = join(parent, `.${spec.id}.${randomUUID()}`)
      scaffoldApp(this.deps.templateDir ?? appTemplateDir(), staging, { id: spec.id, name, description })
      renameSync(staging, dir)
      staging = null
    } catch (err) {
      if (staging) rmSync(staging, { recursive: true, force: true })
      throw new AppUnavailableError(`Could not make the app folder: ${(err as Error).message}`)
    }
    mkdirSync(this.dataDirOf(ref), { recursive: true })
    this.rescan(key)
    const made = this.find(ref)
    if (!made) throw new AppUnavailableError(`The app folder was made, but discovery did not find it: ${dir}`)
    return this.info(made)
  }

  /**
   * Removes a user-folder app (M4 A-7) — the path for withdrawing an approved MCP server from the
   * list (a path that did not exist in the old registry).
   *
   * The folder is not deleted, only moved to `app-trash/` in the data folder: it could be a hand-made
   * app, and it is better to have a way to bring it back. The run ledger, data folder, and secrets
   * survive (a removed app's records are still readable — `runs`). **This never removes a project
   * app** — that is a file in a repository, and the place to withdraw it is git.
   *
   * Rescanned immediately after moving: a running process shuts down, and an attached session detaches
   * (appsChanged). A Claude session drops it from its server set without restarting, and a Codex
   * thread keeps the tool name until its next thread, but calling it is refused with "not an attached
   * app" (attaching to a session re-checks on every call).
   */
  removeUserApp(ref: AppRef): void {
    if (ref.projectId !== null) {
      throw new AppUnavailableError("A project app is part of the project's repository — remove it there")
    }
    this.rescanUser()
    const e = this.require(ref)
    const trash = join(this.deps.dataRoot, 'app-trash')
    mkdirSync(trash, { recursive: true })
    renameSync(e.dir, join(trash, `${ref.appId}-${Date.now()}`))
    // Also drops the imported-app mark (E-3) — a folder restored from the trash is one a person moved back by hand (decision 3: a user-folder app is trusted)
    this.handover.forget(ref.appId)
    this.rescanUser()
  }

  /** Rescans the user folder right now — scans everything if it has never scanned before (pre-startup) */
  private rescanUser(opts: { now?: string } = {}): void {
    if (this.scopes.has(USER_SCOPE)) this.rescan(USER_SCOPE, opts)
    else this.refresh()
  }

  /** Writes a secret value (clears it if `null`). A running app receives it starting from its next startup */
  setSecret(ref: AppRef, name: string, value: string | null): void {
    this.secrets.set(this.appKey(ref), name, value)
  }

  /**
   * A person sets, changes, or clears a secret value (M4 E, the secrets section) — the body of
   * `apps.setSecret`.
   *
   * Only **the names the manifest declares** can be set. Setting a name the manifest never declared
   * does nothing, since the app never receives it (`forApp`), and the person is left asking "I set it,
   * why doesn't it work". Clearing does not check the name — even a value for a name no longer in the
   * declaration has to be removable. **Never carries the value in any message**: a denial travels all
   * the way to the screen as an RPC error.
   *
   * A running app is stopped **only after finishing a call in progress** — the next time it is needed,
   * it starts with the new value (an app receives its environment once, at startup). This also clears
   * a stopped app's failure count: setting a value for an app that failed to start repeatedly for lack
   * of a key is the person fixing it (the same as Restart).
   */
  updateSecret(ref: AppRef, name: string, value: string | null): void {
    const e = this.require(ref)
    if (value !== null) {
      if (!e.manifest) throw new AppUnavailableError(`This app's manifest is invalid: ${e.error ?? 'unknown error'}`)
      if (!(e.manifest.secrets ?? []).includes(name)) throw new AppUnavailableError(`This app does not declare a secret named ${name}`)
      const problem = secretValueProblem(value)
      if (problem) throw new AppUnavailableError(problem)
    }
    this.secrets.set(this.appKey(ref), name, value)
    const L = e.life
    const fresh = () => {
      if (!L.proc && !L.starting) Object.assign(L, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
      this.appsChanged()
    }
    if (L.proc || L.starting) void this.haltWhenDrained(e, 'a secret changed; the next need starts it with the new value').then(fresh)
    else fresh()
    // The list's "set / unset" just changed — this announces it without waiting for the app to stop
    this.appsChanged()
  }

  // ── Handover: importing (E-3) ──────────────────────────────────────────────────────
  //
  // The body lives in `handover.ts`. Here, a denial worded for a person is translated into an RPC
  // error, and the list-shape of an app brought in is returned. The one place that blocks an imported
  // app from starting before confirmation is `held`, which a call, a startup, a check, and status all
  // check against.

  /** Prepares an import — stages it and returns what a person reviews. Nothing has been brought in yet */
  prepareImport(source: string): Promise<{ token: string; review: AppReview }> {
    if (this.disposed) throw new AppUnavailableError('The app runtime has shut down')
    return this.handover.prepare(source)
  }

  /** Brings a staged app into the user folder — disabled, or with `enable`, records the confirmation with the key the person reviewed. **This never starts it** */
  commitImport(token: string, opts: { enable: boolean; reviewKey?: string }): ExternalAppInfo {
    const id = this.handover.commit(token, opts)
    const made = this.find({ projectId: null, appId: id })
    if (!made) throw new AppUnavailableError(`The app was brought in, but discovery did not find it: ${id}`)
    return this.info(made)
  }

  cancelImport(token: string): void {
    this.handover.cancel(token)
  }

  /** The review dialog for an imported app — user-folder apps only (a project app follows the project's trust, decision 3) */
  reviewApp(ref: AppRef): AppReview {
    if (ref.projectId !== null) throw new AppUnavailableError("A project's apps follow the project's trust; there is nothing to review here")
    return this.handover.review(ref.appId)
  }

  /** Enables an imported app — only if the key from the confirmation dialog the person saw matches the current manifest */
  enableApp(ref: AppRef, key: string): ExternalAppInfo {
    if (ref.projectId !== null) throw new AppUnavailableError("A project's apps follow the project's trust; they are not enabled one by one")
    this.handover.enable(ref.appId, key)
    return this.info(this.require(ref))
  }

  // ── Handover: versions (E-1) ────────────────────────────────────────────────────────────

  /** Versions of an app outside git — user-folder apps only (a project app's versions are git, and the host's core reads those) */
  snapshots(ref: AppRef): (Snapshot & { current: boolean })[] {
    if (ref.projectId !== null) throw new AppUnavailableError('Project apps are versioned by git')
    this.rescanUser()
    return this.handover.versionsOf(ref.appId, this.require(ref).dir)
  }

  /**
   * Restores one version — captures the current code as a version before writing it back, clears the
   * consecutive-failure count since this is code the person chose, and **restarts with that code** (if
   * the app has ever started before. A call in progress is waited out — the same path as reflecting a
   * change). If the manifest also changed, a new entry is created and the old process stops after
   * finishing its call. If an imported app's version carries a different server or uses, that entry
   * waits on confirmation again.
   */
  restoreVersion(ref: AppRef, id: string): ExternalAppInfo {
    if (ref.projectId !== null) throw new AppUnavailableError("A project app's versions are its git history; restore it with git")
    this.rescanUser()
    const before = this.require(ref)
    this.handover.restore(ref.appId, id, before.dir)
    // A version the person chose — reads that version's manifest right now even if the building session is mid-turn
    this.rescanUser({ now: ref.appId })
    const e = this.require(ref)
    Object.assign(e.life, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
    void this.reloadIfChanged(ref, { startIfStopped: true, why: 'a previous version was restored' })
    this.appsChanged()
    return this.info(e)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.watchers.close()
    this.handover.dispose()
    for (const t of [...this.turnEndTimers.values(), ...this.quietTimers.values()]) clearTimeout(t)
    this.turnEndTimers.clear()
    this.quietTimers.clear()
    this.appsListeners.clear()
    const all = [...this.scopes.values()].flatMap((s) => [...s.apps.values()])
    this.scopes.clear()
    // Within the shutdown budget (Tauri's 3 seconds) — the grace period is shortened, and it does not wait all the way through SIGKILL
    await Promise.allSettled([
      ...all.map((e) => this.halt(e, 'host shutting down', { graceMs: 1_000, awaitKill: false })),
      // Also processes belonging to no entry at all (see the `spawned` comment) — if one is already stopping, this waits for that same stop (stop only ever runs once)
      ...[...this.spawned].map((p) => p.stop(1_000, { awaitKill: false })),
    ])
    this.spawned.clear()
  }

  // ── Reflecting changes (C-4) ─────────────────────────────────────────────────────────────────

  /**
   * This app's building session's turn ended (M4 C-4) — announced by the host from session state.
   *
   * This does not restart on every single change to the app folder: a building agent edits several
   * files, several times, within one turn, and the app in between is half-edited code. Only once the
   * turn ends is a whole batch of edits complete, and only the host watching session state knows that.
   * Notifications are briefly collected (a turn ending and a state change arrive back to back) — this
   * restarts once per turn.
   *
   * At turn end, the current folder is **measured directly** (its fingerprint). The answer is correct
   * no matter how many watch events were missed. This starts the app even if it is idle and stopped,
   * if it changed — the building session's tool list needs to move to the new code.
   */
  builderTurnEnded(ref: AppRef): void {
    if (this.disposed) return
    const key = this.holdKey(ref)
    clearTimeout(this.turnEndTimers.get(key))
    const t = setTimeout(() => {
      this.turnEndTimers.delete(key)
      /*
       * A manifest change deferred while mid-turn is read right now (`rescan`'s `now`). Even if
       * watching missed that change, it is read here. If a new entry was created, the old process
       * stops after finishing its call (`haltWhenDrained`), and the new entry is started **once** with
       * the new manifest — just like when only the folder changed, this starts an app even if it was
       * idle and stopped, as long as it has ever started before (this moves the building session's
       * tool list forward).
       */
      const before = this.find(ref)
      const scopeKey = ref.projectId ?? USER_SCOPE
      if (this.scopes.has(scopeKey) && !this.disposed) this.rescan(scopeKey, { now: ref.appId })
      const after = this.find(ref)
      if (before && after && after !== before) {
        if (before.life.stamp !== null) void this.startNewManifest(after, "the builder's turn ended and the manifest changed")
        return
      }
      void this.reloadIfChanged(ref, { startIfStopped: true, why: "the builder's turn ended and the app folder changed" })
    }, this.timing.turnEndDebounceMs)
    t.unref()
    this.turnEndTimers.set(key, t)
  }

  /**
   * A scan saw that the app folder changed (C-4). If a building session is mid-turn, this does
   * nothing — turn end reflects it instead. If there is none, or it is idle (edited from an editor),
   * this waits for things to go quiet after the last change, and reflects it if the building session
   * is still not mid-turn at that point. This path only ever restarts a running app — an app no one is
   * using is never woken up by an edit (the performance budget).
   */
  private folderChanged(e: AppEntry): void {
    if (this.deps.builderBusy?.(e.ref)) return
    const key = this.holdKey(e.ref)
    clearTimeout(this.quietTimers.get(key))
    const ref = e.ref
    const t = setTimeout(() => {
      this.quietTimers.delete(key)
      if (this.deps.builderBusy?.(ref)) return
      void this.reloadIfChanged(ref, { startIfStopped: false, why: 'the app folder changed and stayed quiet' })
    }, this.timing.reloadQuietMs)
    t.unref()
    this.quietTimers.set(key, t)
  }

  /**
   * If the folder differs from the last time it started, restarts with the current files — returns
   * true if it restarted.
   *
   * **A call in progress is never cut off.** This waits for it to finish (no cap — cutting it off is
   * worse). Stopped in the very same tick it finishes (see the comment on `drain`). Since a changed
   * folder means the author fixed something, an app stopped after failing repeatedly also gets another
   * chance (its count is cleared). Restarting re-reads the tool list, and a session is notified if the
   * agent-facing tools changed (immediately for Claude, from the next thread for Codex — same as A-5).
   * An open screen also receives "changed".
   */
  private reloadIfChanged(ref: AppRef, opts: { startIfStopped: boolean; why: string }): Promise<boolean> {
    const key = this.holdKey(ref)
    const running = this.reloading.get(key)
    if (running) return running
    const p = (async () => {
      const e = this.find(ref)
      if (!e || !e.manifest || !e.scope.trusted || this.disposed) return false
      const L = e.life
      if (L.stamp === null || folderFingerprint(e.dir) === L.stamp) return false
      if (!opts.startIfStopped && !L.proc?.alive) return false
      while (L.inflight > 0) await this.drain(e, 60_000)
      // The manifest changed and a new entry replaced this one, or it was removed, while waiting — a new entry starts through its own path
      if (this.find(ref) !== e || this.disposed) return false
      const pid = L.proc?.child.pid
      L.proc?.log.note(`reloading: ${opts.why}`)
      void this.halt(e, opts.why)
      Object.assign(L, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
      this.appsChanged()
      try {
        await this.use(e, async () => {})
        console.error(`[apps] ${this.label(ref)} reloaded (${opts.why})${pid ? `, was pid ${pid}` : ''}`)
        this.deps.emitChanged?.(ref)
      } catch (err) {
        // Failed to start — the reason is recorded both in the list (crashed) and in an error bundle. The building session's check reads that reason
        console.error(`[apps] ${this.label(ref)} reload failed: ${(err as Error).message.split('\n')[0]}`)
      }
      return true
    })().finally(() => this.reloading.delete(key))
    this.reloading.set(key, p)
    return p
  }

  /** Stops it only after finishing a call in progress — the way an old entry's process is collected when a manifest change replaces the entry */
  private async haltWhenDrained(e: AppEntry, why: string): Promise<void> {
    while (e.life.inflight > 0) await this.drain(e, 60_000)
    await this.halt(e, why)
  }

  /**
   * Starts a newly created entry with a new manifest (C-4) — for when reading a manifest deferred
   * until the building session's turn end replaces the entry. The old process is stopped by `rescan`
   * after finishing its call. If it starts, "changed" is sent to an open screen (the same as
   * `reloadIfChanged`).
   */
  private async startNewManifest(e: AppEntry, why: string): Promise<void> {
    if (!e.manifest || !e.scope.trusted || this.held(e) || this.disposed) return
    try {
      await this.use(e, async () => {})
      console.error(`[apps] ${this.label(e.ref)} started on its new manifest (${why})`)
      this.deps.emitChanged?.(e.ref)
    } catch (err) {
      // Failed to start — the reason is recorded both in the list (crashed) and in an error bundle. The building session's check reads that reason
      console.error(`[apps] ${this.label(e.ref)} did not start on its new manifest: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────

  /** An app is never idle while in use — the idle timer is set again once it is done */
  private async use<T>(e: AppEntry, fn: (proc: AppProcess) => Promise<T>): Promise<T> {
    e.life.inflight += 1
    this.clearIdle(e)
    try {
      return await fn(await this.ensureRunning(e))
    } finally {
      e.life.inflight -= 1
      if (e.life.inflight === 0) for (const w of e.life.idleWaiters.splice(0)) w()
      this.armIdle(e)
    }
  }

  /**
   * Waits for every call in progress to finish — resolves true if that happens within `ms`. The
   * caller has to stop it **in the same tick** it gets this back: yielding even once lets a call that
   * arrives in the meantime raise inflight again (the caller re-checks this with a while loop).
   */
  private drain(e: AppEntry, ms: number): Promise<boolean> {
    if (e.life.inflight === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(t)
        resolve(true)
      }
      const t = setTimeout(() => {
        e.life.idleWaiters = e.life.idleWaiters.filter((w) => w !== waiter)
        resolve(false)
      }, ms)
      t.unref()
      e.life.idleWaiters.push(waiter)
    })
  }

  /**
   * If it is running, returns it; if starting, returns that promise; otherwise starts a new one.
   *
   * **Only one starts at a time.** If five simultaneous needs each saw "none exists" and each started
   * one, five processes would grab hold of the same data folder — the same shape of problem
   * encountered restoring sessions (see the `resuming` comment in `manager.ts`). Everyone waits on the
   * same in-progress startup promise instead.
   */
  private ensureRunning(e: AppEntry): Promise<AppProcess> {
    const L = e.life
    if (!e.manifest) throw new AppUnavailableError(`The app cannot start — its manifest is invalid: ${e.error}`)
    if (!e.scope.trusted) {
      throw new AppUnavailableError("This app's project is not trusted, so the app does not start — trust the project and it will")
    }
    // An imported app never starts before a person reviews and enables it (E-3) — checked on every call: if server or uses changes after being enabled, it is blocked starting from the next startup
    const held = this.held(e)
    if (held) throw new AppUnavailableError(held)
    if (L.gaveUp) {
      throw new AppUnavailableError(
        `The app stopped after failing ${this.timing.maxFailures} times in a row — fix it, then restart it.\n${L.lastError ?? ''}`,
      )
    }
    if (L.proc?.alive) return Promise.resolve(L.proc)
    if (L.starting) return L.starting

    const epoch = L.epoch
    const p = (async () => {
      const wait = L.retryAt - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (L.epoch !== epoch || this.disposed) throw new AppUnavailableError('The app changed or was stopped, so this start was abandoned')
      const usedPrior = L.verdict !== undefined
      const pipeId = ++this.pipeSeq
      /*
       * The fingerprint is measured **before** starting (C-4) — even an app that fails to start has to
       * be left with "this code was tried once", or turn end would never restart it after a fix.
       * Measured once more if it starts: so an app that writes something into its own folder while
       * starting up is never read as "changed" and restarted without end.
       */
      L.stamp = folderFingerprint(e.dir)
      // An app outside git now has the code about to run captured as a version (E-1) — does nothing if it is the same code. The app still starts even if capturing the version fails
      if (e.ref.projectId === null) this.handover.snapshot(e.ref.appId, e.dir, 'started', L.stamp)
      let proc: AppProcess
      try {
        proc = await AppProcess.start(this.spawnSpec(e, pipeId))
      } catch (err) {
        if (L.epoch === epoch) {
          // If connecting failed with the remembered generation, that memory could be wrong — the next attempt probes again
          if (usedPrior) L.verdict = undefined
          this.fail(e, (err as Error).message)
          const started = err instanceof AppStartError ? err : null
          this.recordError(e, {
            kind: 'start',
            at: Date.now(),
            message: started?.head ?? (err as Error).message.split('\n')[0]!,
            stderr: started?.stderr ?? [],
            tool: null,
            args: null,
            runId: null,
          })
        }
        throw new AppUnavailableError((err as Error).message)
      }
      if (L.epoch !== epoch || this.disposed) {
        this.remember(proc)
        void proc.stop(this.timing.graceMs)
        throw new AppUnavailableError('The app changed or was stopped, so this start was abandoned')
      }
      this.remember(proc)
      L.verdict = proc.verdict() ?? L.verdict
      L.stamp = folderFingerprint(e.dir)
      L.loaded = L.stamp
      L.proc = proc
      L.pipeId = pipeId
      L.lastError = null
      this.readTools(e, proc)
      proc.onUnexpectedExit = (reason) => this.crashed(e, proc, reason)
      return proc
    })()
    L.starting = p
    // Starting, running, and crashed or failed (after failing to start) are all states the list states (A-8)
    this.appsChanged()
    const settled = () => {
      if (L.starting === p) L.starting = null
      this.appsChanged()
    }
    p.then(settled, settled)
    return p
  }

  private readTools(e: AppEntry, proc: AppProcess): void {
    const kept: AppTool[] = []
    const warnings: string[] = []
    const drop = (why: string) => {
      warnings.push(`a tool was dropped — ${why}`)
      proc.log.note(`tool dropped: ${why}`)
    }
    for (const t of proc.tools) {
      const err = toolNameError(t.name)
      if (err) {
        drop(err)
        continue
      }
      const vis = visibilityOf(t)
      if (!vis.ok) {
        drop(vis.error)
        continue
      }
      kept.push({ tool: t, visibility: vis.visibility })
    }
    if (e.manifest?.home && !kept.some((t) => t.tool.name === e.manifest?.home)) {
      warnings.push(`the home tool (${e.manifest.home}) is not in the tool list`)
    }
    // Only announces when what a session sees (agent-facing tools) has changed — a change to a screen-only tool has nothing to do with a session
    const forModel = (list: AppTool[] | null) =>
      list === null ? null : JSON.stringify(list.filter((t) => t.visibility.includes('model')).map((t) => t.tool))
    const before = forModel(e.life.known)
    e.life.tools = kept
    e.life.known = kept
    e.life.toolWarnings = warnings
    if (forModel(kept) !== before) this.appsChanged()
  }

  /**
   * Counts one failure. Stops it on the third, otherwise defers the next start.
   *
   * **Reviving it is the next need's job.** A dead app is never automatically restarted after the
   * backoff — the same principle as stopping an idle app (A-3): an app process with no one calling it
   * has no reason to stay running. Backoff is set as "the next startup happens no earlier than this".
   * A call that arrives in that window waits out the remaining time and then starts it.
   */
  private fail(e: AppEntry, reason: string): void {
    const L = e.life
    L.failures += 1
    L.lastError = reason
    const where = this.label(e.ref)
    if (L.failures >= this.timing.maxFailures) {
      L.gaveUp = true
      // A stopped app never attaches to a session (decision 4) — announce so an already-attached session detaches it
      this.appsChanged()
      console.error(`[apps] ${where} stopped after ${L.failures} consecutive failures: ${reason.split('\n')[0]}`)
    } else {
      L.retryAt = Date.now() + this.timing.backoffBaseMs * 2 ** (L.failures - 1)
      console.error(`[apps] ${where} failed (${L.failures}/${this.timing.maxFailures}): ${reason.split('\n')[0]}`)
    }
  }

  private crashed(e: AppEntry, proc: AppProcess, reason: string): void {
    const L = e.life
    if (L.proc !== proc) return
    L.proc = null
    L.tools = null
    this.clearIdle(e)
    // If it died after running well for a long time, this is not a consecutive failure — counted from zero
    if (Date.now() - proc.startedAt >= this.timing.stableMs) L.failures = 0
    this.fail(e, reason)
    this.recordError(e, { kind: 'crash', at: Date.now(), message: reason.split('\n')[0]!, stderr: proc.log.tailLines(), tool: null, args: null, runId: null })
    // Cleans up the pipe and the log, and collects any descendant left in its group
    void proc.stop(0)
    // A running app died without warning — the person in front of the screen has to see the reason (A-8, B-6)
    this.appsChanged()
  }

  /** Records a started process — every time one is recorded, anything already ended is cleared out (so the list never grows over the host's lifetime) */
  private remember(proc: AppProcess): void {
    for (const p of this.spawned) if (!p.alive) this.spawned.delete(p)
    this.spawned.add(proc)
  }

  /** Stops it — because it went idle, changed, lost trust, or the host is exiting */
  private async halt(e: AppEntry, why: string, opts: { graceMs?: number; awaitKill?: boolean } = {}): Promise<void> {
    const L = e.life
    L.epoch += 1
    this.clearIdle(e)
    const proc = L.proc
    L.proc = null
    L.tools = null
    if (!proc) return
    // A running app is stopping — it is not running in the list from this moment (A-8)
    this.appsChanged()
    proc.log.note(`stopping: ${why}`)
    await proc.stop(opts.graceMs ?? this.timing.graceMs, { awaitKill: opts.awaitKill })
  }

  private armIdle(e: AppEntry): void {
    this.clearIdle(e)
    const L = e.life
    if (L.inflight > 0 || this.viewsOf(e) > 0 || !L.proc) return
    L.idle = setTimeout(() => {
      L.idle = null
      if (L.inflight === 0 && this.viewsOf(e) === 0) void this.halt(e, `idle for ${this.timing.idleMs}ms`)
    }, this.timing.idleMs)
    L.idle.unref()
  }

  private viewsOf(e: AppEntry): number {
    return this.viewHolds.get(this.holdKey(e.ref)) ?? 0
  }

  /** The key for an open screen. Since this is never used in a path, it does not care about a project id's shape (unlike scopeDir) */
  private holdKey(ref: AppRef): string {
    return `${ref.projectId ?? USER_SCOPE}/${ref.appId}`
  }

  private clearIdle(e: AppEntry): void {
    if (e.life.idle) clearTimeout(e.life.idle)
    e.life.idle = null
  }

  /**
   * The shape to start with. What the app receives:
   *   - cwd = the app folder
   *   - `CENTRALU_APP_DATA` = a data folder outside the repository (created if it does not exist).
   *     Writing this inside the app folder would get it committed and leaked to the team (from the
   *     plan, "data and secrets")
   *   - only the secrets the manifest **declared**, as environment variables
   * What it never receives: the host's own variables (`CC_*`). Among them is the host's WebSocket
   * token (`CC_HOST_TOKEN`) — handing that to an app would let it call every one of the host's RPCs.
   */
  private spawnSpec(e: AppEntry, pipeId: number): SpawnSpec {
    const m = e.manifest!
    const scopeDir = this.scopeDir(e.ref)
    const dataDir = this.dataDirOf(e.ref)
    mkdirSync(dataDir, { recursive: true })
    const appKey = this.appKey(e.ref)
    const secrets = this.secrets.forApp(appKey, m.secrets ?? [])
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(this.deps.env ?? process.env)) {
      if (k.startsWith('CC_') || k.startsWith('CENTRALU_')) continue
      env[k] = v
    }
    Object.assign(env, secrets, { CENTRALU_APP_ID: e.ref.appId, CENTRALU_APP_DATA: dataDir })
    return {
      command: m.server.command,
      args: m.server.args,
      cwd: e.dir,
      env,
      logPath: join(this.deps.dataRoot, 'app-logs', scopeDir, `${e.ref.appId}.log`),
      logMaxBytes: this.timing.logMaxBytes,
      // Masks every stored value, even one absent from the declaration — masking it costs nothing
      redact: redactor(this.secrets.all(appKey)),
      prior: e.life.verdict,
      probeTimeoutMs: this.timing.probeTimeoutMs,
      connectTimeoutMs: this.timing.connectTimeoutMs,
      serveFd3: (fd3, note) =>
        serveBroker(
          fd3,
          {
            // Only this pipe's app, and a run open on this pipe — someone else's id and a dead process's id both fail
            openRun: (runId) => {
              const run = this.openRuns.get(runId)
              return run && run.entry === e && run.pipeId === pipeId ? run.abort.signal : null
            },
            note,
            refused: (tool, args, why) => this.desk.refused({ ref: e.ref, name: m.name, manifest: m }, tool, args, why),
          },
          /*
           * The requesting app is this pipe's app, and the manifest is **the one read when this process
           * started.** If the manifest changed in the meantime, a new entry was created and this process
           * stops after finishing its call — while it is still running, it requests things under the
           * declaration it started with (what was validated is what is used).
           */
          (tool, args, call) => this.desk.handle({ ref: e.ref, name: m.name, manifest: m }, tool, args, call),
          { keepaliveMs: this.timing.brokerKeepaliveMs },
        ),
    }
  }

  /** An app's data folder — outside the app folder (from the plan, "data and secrets"). The app receives it as `CENTRALU_APP_DATA` */
  private dataDirOf(ref: AppRef): string {
    return join(this.deps.dataRoot, 'app-data', this.scopeDir(ref), ref.appId)
  }

  /** The scope name used as one path segment. A project id is a UUID — refused rather than written into a path if it does not look like one */
  private scopeDir(ref: AppRef): string {
    if (ref.projectId === null) return USER_SCOPE
    if (!/^[A-Za-z0-9-]+$/.test(ref.projectId)) throw new AppUnavailableError(`This project id cannot be used in a path: ${ref.projectId}`)
    return ref.projectId
  }

  private appKey(ref: AppRef): string {
    return `${this.scopeDir(ref)}/${ref.appId}`
  }

  private label(ref: AppRef): string {
    return `${ref.projectId === null ? 'user' : ref.projectId.slice(0, 8)}/${ref.appId}`
  }

  // ── Discovery ──────────────────────────────────────────────────────────────────────

  private require(ref: AppRef): AppEntry {
    const e = this.find(ref)
    if (!e) throw new AppUnavailableError(`There is no such app: ${ref.projectId ?? 'user'}/${ref.appId}`)
    return e
  }

  private find(ref: AppRef): AppEntry | undefined {
    return this.scopes.get(ref.projectId ?? USER_SCOPE)?.apps.get(ref.appId)
  }

  private info(e: AppEntry): ExternalAppInfo {
    const m = e.manifest
    const lastErrorAt = this.errorLog.get(this.holdKey(e.ref))?.[0]?.at
    return {
      appId: e.ref.appId,
      projectId: e.ref.projectId,
      dir: e.dir,
      name: m?.name ?? null,
      version: m?.version ?? null,
      description: m?.description ?? null,
      home: m?.home ?? null,
      trusted: e.scope.trusted,
      status: this.status(e),
      error: e.error ?? this.held(e) ?? e.life.lastError,
      warnings: [...e.warnings, ...e.life.toolWarnings],
      // The full fingerprint is not needed — it is only ever a key for comparison, so the first 16 characters are enough
      ...(e.life.loaded ? { codeStamp: e.life.loaded.slice(0, 16) } : {}),
      ...(lastErrorAt !== undefined ? { lastErrorAt } : {}),
      ...this.secretSlots(e),
      ...this.importMark(e),
    }
  }

  /**
   * Whether an imported app is waiting on the person's confirmation (E-3) — the reason, or null. Only
   * a user-folder app can be an imported app (a project app is governed by project trust, decision 3).
   * On every call, the mark is checked against the current manifest (`AppHandover.gate`).
   */
  private held(e: AppEntry): string | null {
    return e.ref.projectId === null && e.manifest ? this.handover.gate(e.ref.appId, e.dir, e.manifest) : null
  }

  /** The mark of an imported app, for the list (E-3) — absent for an app that was not imported */
  private importMark(e: AppEntry): Pick<ExternalAppInfo, 'imported'> {
    const imported = e.ref.projectId === null ? this.handover.imported(e.ref.appId, e.dir) : undefined
    return imported ? { imported } : {}
  }

  /** Whether a value is set for each declared secret (E, the secrets section) — just the name and whether it is set. No field at all if there is no declaration */
  private secretSlots(e: AppEntry): Pick<ExternalAppInfo, 'secrets'> {
    const declared = e.manifest?.secrets ?? []
    if (declared.length === 0) return {}
    const stored = this.secrets.names(this.appKey(e.ref))
    return { secrets: declared.map((name) => ({ name, set: stored.has(name) })) }
  }

  private status(e: AppEntry): ExternalAppInfo['status'] {
    if (!e.manifest) return 'invalid'
    if (!e.scope.trusted) return 'untrusted'
    if (this.held(e)) return 'unconfirmed'
    const L = e.life
    if (L.gaveUp) return 'failed'
    if (L.proc?.alive) return 'running'
    if (L.starting) return 'starting'
    if (L.lastError) return 'crashed'
    return 'stopped'
  }

  /**
   * Rescans one scope. `now` is the id of an app whose manifest change should be read **right now** —
   * a building session's turn end, a check, or a version the person chose. Every other scan (watching,
   * `refresh`) defers a manifest change for an app whose building session is mid-turn until turn end
   * (see the comment below).
   */
  private rescan(key: string, opts: { now?: string } = {}): void {
    const held = this.scopes.get(key)
    if (!held || this.disposed) return
    const { scope } = held
    const result =
      scope.projectId === null
        ? scanApps(scope.root, USER_APPS_REL, [])
        : scanApps(scope.root, PROJECT_APPS_REL, ['', '.centralu'])
    const seen = new Set<string>()
    /** Whether there was a change that could change the set of apps attached to a session (A-5) */
    let changed = false
    for (const found of result.apps) {
      seen.add(found.folder)
      const prev = held.apps.get(found.folder)
      if (prev && prev.found.hash === found.hash && prev.found.error === found.error) {
        if (prev.scope.trusted !== scope.trusted) changed = true
        prev.scope = scope
        // An app in a project that lost trust is stopped immediately — it stays in the list
        if (!scope.trusted) void this.halt(prev, 'project is no longer trusted')
        // Did something outside the manifest change (server.mjs, a screen…) (C-4)? Measured only for an app that has started at least once
        else if (prev.life.stamp !== null && folderFingerprint(prev.dir) !== prev.life.stamp) this.folderChanged(prev)
        continue
      }
      /*
       * The manifest changed — a process started with the old command is stopped, and its counts and
       * remembered generation start fresh. A new call is received by the new entry. The old process is
       * stopped **only after a call in progress finishes** (C-4): editing files must never cut off
       * someone's call.
       */
      if (prev) {
        /*
         * **If the building session is mid-turn, this is deferred until turn end** (C-4). Replacing the
         * entry with a half-edited manifest would stop the old process, and an open screen would see the
         * changed code in the list, reopen, and load the half-edited code (measured: within a turn
         * spanning 10:09:55-10:11:09, "stopping: manifest changed" fired at 10:10:45, and the screen went
         * blank and reopened with the code still being edited). Until then, the old entry continues to
         * receive calls with its old manifest and old process. Turn end (`builderTurnEnded`) rescans with
         * `now` and moves everything over at once. Losing trust is never deferred this way.
         */
        if (opts.now !== found.folder && scope.trusted && prev.scope.trusted && this.deps.builderBusy?.(prev.ref)) {
          prev.scope = scope
          continue
        }
        void this.haltWhenDrained(prev, 'manifest changed')
      }
      held.apps.set(found.folder, this.entry(scope, found))
      changed = true
    }
    for (const [id, e] of [...held.apps]) {
      if (seen.has(id)) continue
      held.apps.delete(id)
      void this.halt(e, 'app folder removed')
      changed = true
    }
    this.watchers.setWatched(key, scope.root, result.watch)
    if (changed) this.appsChanged()
  }

  private entry(scope: Scope, found: ScannedApp): AppEntry {
    let { manifest, error } = found
    if (manifest && this.deps.reservedIds.includes(manifest.id)) {
      // The same id as a built-in app leaves `apps.invoke` to decide which one to call — whichever registered first wins
      error = `"${manifest.id}" is the name of a built-in app — use another id`
      manifest = null
    }
    return {
      ref: { projectId: scope.projectId, appId: found.folder },
      scope,
      found,
      dir: found.dir,
      manifest,
      error,
      warnings: found.warnings,
      life: {
        proc: null,
        starting: null,
        failures: 0,
        retryAt: 0,
        lastError: null,
        gaveUp: false,
        verdict: undefined,
        epoch: 0,
        inflight: 0,
        idleWaiters: [],
        stamp: null,
        loaded: null,
        idle: null,
        tools: null,
        toolWarnings: [],
        known: null,
        pipeId: 0,
      },
    }
  }

  private dropScope(key: string): void {
    const held = this.scopes.get(key)
    this.watchers.setWatched(key, held?.scope.root ?? join(this.deps.dataRoot, USER_APPS_REL), [])
    this.scopes.delete(key)
    for (const e of held?.apps.values() ?? []) void this.halt(e, 'project removed')
    if (held?.apps.size) this.appsChanged()
  }
}

/** Joins together the text parts of a result — becomes the one line a person reads (RPC's `text`) and a failure's reason */
export function resultText(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n')
}
