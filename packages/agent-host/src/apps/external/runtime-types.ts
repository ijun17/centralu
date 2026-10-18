import type { CallToolResult } from '@modelcontextprotocol/client'
import { BROKER_KEEPALIVE_MS } from './broker.js'
import type { CapabilityBook } from './capabilities.js'
import type { HandoverOptions } from './handover.js'
import type { AppRef } from './ref.js'
import type { RunLedger } from './runs.js'

/**
 * What the external app runtime (`runtime.ts`) is given, and the shape of one call's outcome — the
 * runtime's own vocabulary, apart from its body. `runtime.ts` re-exports all of it: the host knows
 * the runtime through that one door.
 */

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
   * After a start fails, how long to wait for news of the process exiting before writing the
   * reason (`AppProcess.start`). An app that exits at once is then reported as "exited before it
   * was ready (code 3)", not as the SDK's "connection closed" that arrives first. A broken server
   * that stays alive (S-6) waits all of it, once per failed start.
   */
  startExitWaitMs: number
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
  startExitWaitMs: 250,
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
  /** Ids an external app can never take (`RESERVED_APP_IDS`) — the retired control app's rows and sessions still carry `control` (#97) */
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
  /**
   * Whether the person shares this project app with their other projects (#371 part A) — read from
   * the store on every `list()`, like trust. Absent means nothing is shared. The runtime only reports
   * it (`ExternalAppInfo.shared`); who may attach a shared app is decided by the session side
   * (sessions/app-access.ts), and every call is checked there again.
   */
  shared?: (ref: AppRef) => boolean
  /**
   * Whether a folder in the user folder was registered as a project in place (#1141, `user-app-adoption.ts`): it is
   * that project's root app now, so the user folder no longer lists it. Asked on every scan of the user folder, with
   * the folder's path, which the record is bound to. Absent: nothing was.
   */
  adoptedUserApp?: (appId: string, dir: string) => boolean
}
