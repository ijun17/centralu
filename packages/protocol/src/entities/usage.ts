import { z } from 'zod'
import { ToolName } from './ids.js'

/**
 * A tool's running token reading (`usage_update`). The three input fields do not overlap, as in the Anthropic API, so
 * their sum is all the input the model read; Codex counts cached input inside its input, and its adapter subtracts it
 * (`codex/token-readings.ts`). `cacheCreationTokens` is 0, not absent, when the tool reports no writes (Codex): every
 * reader sums it, so making it optional would be a change, not an addition (docs/protocol.md §4). See `RequestInput`.
 */
export const TokenUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  costUsd: z.number().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsage>

/**
 * One model request's input, split as `TokenUsage` splits it: what the prompt cache is judged by, since a running
 * reading cannot be put into a window of time (docs/agent-host/prompt-cache.md). `cacheCreationTokens` is absent when
 * the tool reports no writes (Codex), which must not read as "wrote nothing".
 */
export const RequestInput = z.object({
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number().optional(),
  /** As the tool reported them for this request; absent when it did not say */
  outputTokens: z.number().optional(),
  /** The subagent that made it (Claude: the launching call's id); absent for the session's own. It has its own cache */
  agent: z.string().optional(),
  /** How long what it wrote stays cached (Claude's `cache_creation` split); absent when not said or nothing written */
  cacheTtl: z.enum(['5m', '1h']).optional(),
  /**
   * The one-hour and five-minute parts of `cacheCreationTokens`, as the API split them: priced apart
   * (docs/agent-host/prompt-cache.md). Absent when not split; a part in neither is priced as a five-minute write.
   */
  cacheWrite1hTokens: z.number().optional(),
  cacheWrite5mTokens: z.number().optional(),
  /** The model that served it (Claude's `message.model`); absent when the tool does not say */
  model: z.string().optional(),
})
export type RequestInput = z.infer<typeof RequestInput>

/**
 * Why a rebuild most likely happened, from what the host saw since the request before; each cause in
 * docs/agent-host/prompt-cache.md. A string on the wire, so a newer host's cause reaches an older screen as its name.
 */
export const RebuildCause = z.enum([
  'cold_start',
  'subagent',
  'new_process',
  'model_change',
  'compaction',
  'thread_restart',
  'instructions',
  'launch_settings',
  'expired',
  'probably_expired',
  'unknown',
])
export type RebuildCause = z.infer<typeof RebuildCause>

/** What a prompt cache did over some requests: the sums every per-session and per-window figure here shares */
const CacheCounts = z.object({
  requests: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  /** Requests that wrote most of their prompt to the cache again (the threshold: docs/agent-host/prompt-cache.md) */
  rebuilds: z.number(),
  /** The rebuilds by their likely cause (`RebuildCause`); absent from a host that predates it */
  rebuildCauses: z.record(z.string(), z.number()).optional(),
  /**
   * The cache writes of the rebuilds only, so not the steady writes of each new message; for Codex, the input it did
   * not read from the cache. Absent from an older host, and from hours an earlier build stored.
   */
  rebuildTokens: z.number().optional(),
})

/** One session's share of a cache window (`CacheWindowStats.sessions`) */
export const CacheSessionStats = z.object({
  sessionId: z.string(),
  /** Empty for a session that no longer exists */
  name: z.string(),
  ...CacheCounts.shape,
})
export type CacheSessionStats = z.infer<typeof CacheSessionStats>

/**
 * The prompt cache over one window of time. Sums, not the rate: the hit rate is computed where it is shown (`@cc/core`
 * `cacheHitRate`), so a host and a UI of different builds cannot disagree on it (docs/agent-host/prompt-cache.md).
 */
export const CacheWindowStats = CacheCounts.extend({
  /** `5h`, `today` */
  id: z.string(),
  /** How the window is named on screen ("last 5 h", "today") */
  label: z.string(),
  /** ISO8601, where the window begins */
  since: z.string(),
  /**
   * In units of an uncached input token, by price ratios, no money (docs/agent-host/prompt-cache.md). For a tool that
   * reports no writes (Codex) the write units are those of the input it did not read from the cache. Absent: older host.
   */
  cacheReadCost: z.number().optional(),
  cacheWriteCost: z.number().optional(),
  /** The shortest and longest idle (ms) before a rebuild put down to `expired` or `probably_expired`; absent when none */
  expiredIdleMs: z.object({ min: z.number(), max: z.number() }).optional(),
  /** The sessions that cost the cache most in this window, most first, a few at most */
  sessions: z.array(CacheSessionStats),
})
export type CacheWindowStats = z.infer<typeof CacheWindowStats>

/** What one tool's prompt cache did lately, on the machine that answers (`agents.usage`) */
export const CacheStats = z.object({
  /** The tool reports cache writes (Claude). False: reads only (Codex), and every write figure here is 0 */
  writes: z.boolean(),
  /** ISO8601. The figures live in host memory, so the screen says "since" this for a window that began earlier */
  countingSince: z.string(),
  windows: z.array(CacheWindowStats),
})
export type CacheStats = z.infer<typeof CacheStats>

/** The token rows' key (docs/agent-host/usage.md "Usage over time"); `day` and `hour` are the time axis (`groupBy`) */
export const UsageHistoryBy = z.enum(['session', 'project', 'model', 'tool'])
export type UsageHistoryBy = z.infer<typeof UsageHistoryBy>

/** One tool's limit window over time on one account: the readings the host stored, oldest first */
export const UsageHistoryReadings = z.object({
  tool: ToolName,
  /** An opaque fingerprint of the login (`agents.account`), empty when the tool did not say which */
  account: z.string(),
  /** The window as `agents.usage` names it: its id, label and, for a per-model window, the model */
  window: z.string(),
  label: z.string(),
  scope: z.string().nullable(),
  points: z.array(z.object({ at: z.string(), percent: z.number(), resetsAt: z.string().nullable() })),
})
export type UsageHistoryReadings = z.infer<typeof UsageHistoryReadings>

/** The tokens of one hour or day for one key (`by`), summed from the hourly buckets */
export const UsageHistoryRow = z.object({
  /** ISO8601, the start of the day (the host's local midnight) or of the hour */
  period: z.string(),
  /** The session id, project id, model or tool; `*` for the rows folded into "others", `none` for the sessions of no project */
  key: z.string(),
  /** A project that no longer exists is named by its id */
  name: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  /** Of `cacheCreationTokens`, what the API said stays cached five minutes or an hour (the rest was not said) */
  cacheCreation5mTokens: z.number(),
  cacheCreation1hTokens: z.number(),
  outputTokens: z.number(),
  rebuilds: z.number(),
  /** The rebuilds by their likely cause (`RebuildCause`) */
  rebuildCauses: z.record(z.string(), z.number()),
})
export type UsageHistoryRow = z.infer<typeof UsageHistoryRow>

/** The answer of `usage.history`: the limit readings and the token rows of a time range */
export const UsageHistory = z.object({
  /** As asked: a hub qualifies the ids of a linked machine's sessions and projects by it */
  by: UsageHistoryBy,
  readings: z.array(UsageHistoryReadings),
  rows: z.array(UsageHistoryRow),
  /** The oldest token record this host keeps (ISO8601); absent when it keeps none. A range before it is not known */
  recordedSince: z.string().optional(),
})
export type UsageHistory = z.infer<typeof UsageHistory>

/**
 * One limit window of an account, not of a session. Tools differ in their windows (Claude: session (5 hours),
 * weekly_all, weekly_scoped; Codex: primary (weekly), secondary), so the UI draws any number of them.
 */
export const UsageWindow = z.object({
  id: z.string(),
  label: z.string(),
  /** 0 to 100, of the limit used */
  percent: z.number(),
  /** ISO; null if unknown */
  resetsAt: z.string().nullable().default(null),
  /** If this window applies to one specific model only, that model's name */
  scope: z.string().nullable().default(null),
  /** When a tool reports multiple scoped windows of the same cadence, the adapter marks its representative window here */
  primary: z.boolean().optional(),
})
export type UsageWindow = z.infer<typeof UsageWindow>

export const UsageSnapshot = z.object({
  plan: z.string().nullable().default(null),
  windows: z.array(UsageWindow).default([]),
  /** Empty from a tool that cannot report it: the UI collapses that row */
  daily: z.array(z.object({ date: z.string(), tokens: z.number() })).default([]),
  /**
   * What the tool counted on this computer, a total and not a limit: a tool with no limits to read (`notReported`) may
   * still say this. Absent when it says nothing, and from an older host.
   */
  totals: z
    .object({
      /** What the totals cover, in the words the person reads under their title ("all time") */
      scope: z.string(),
      /** When the host read them (ms): a large database reads slowly, so the host keeps the last ones and the screen says their age */
      asOf: z.number().optional(),
      rows: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          /** Null: the tool printed it in a form the host could not read. The screen shows it as unread, never as a number */
          value: z.number().nullable(),
          unit: z.enum(['count', 'tokens', 'usd']),
        }),
      ),
    })
    .optional(),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshot>
