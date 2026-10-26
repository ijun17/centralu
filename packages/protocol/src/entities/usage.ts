import { z } from 'zod'
import { ToolName } from './ids.js'

/**
 * The tokens reported by a tool (`usage_update`). The three input fields **do not overlap** —
 * the same accounting as the Anthropic API:
 *
 *   inputTokens          input that did not come from cache
 *   cacheReadTokens      input read from cache
 *   cacheCreationTokens  input written to cache
 *
 * So all the input the model actually read is the sum of the three. Codex reports input that
 * came from cache **inside** its input count, so the adapter subtracts it to fit this shape
 * (`codex/token-readings.ts`). If the two tools did not carry the same meaning here, whatever sums
 * them up (an app's requested-agent history, M4 D-5) would record a different number depending
 * on the tool.
 *
 * `cacheCreationTokens` is 0 when the tool does not report cache writes (Codex), not absent (#843): every reader sums
 * it as a number (an app's requested-agent usage, `app-agents.ts`), so making it optional would change its meaning
 * for each of them, a change rather than an addition (protocol.md §4). Where "wrote nothing" and "not reported" must
 * differ, the prompt cache accounting, the reading is `RequestInput`, which leaves it absent.
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
 * The input of **one model request**, split as `TokenUsage` splits it — what the prompt cache is judged by.
 *
 * `TokenUsage` is a running reading (Claude's result is cumulative over the process, Codex's `total` over the
 * thread), so it cannot be put into a window of time. This is sent once per request, alongside it, by the adapter
 * that can tell requests apart: Claude per assistant message (deduplicated by its message id), Codex per change of
 * its thread's total (`last`).
 *
 * `cacheCreationTokens` is **absent when the tool does not report cache writes**: Codex reports the input it read
 * from cache and nothing about writing it, and an absent figure must not read as "wrote nothing".
 */
export const RequestInput = z.object({
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number().optional(),
  /** The tokens the model wrote back, as the tool reported them for this request; absent when it did not say (usage history, §6.2) */
  outputTokens: z.number().optional(),
  /**
   * The subagent that made the request (Claude: the id of the tool call that launched it); absent for the session's
   * own conversation. A subagent has a prompt and a cache of its own, so its requests are judged apart.
   */
  agent: z.string().optional(),
  /**
   * How long what this request wrote stays cached, as the API reported it (Claude's `cache_creation` split). Absent
   * when the tool does not say, or the request wrote nothing.
   */
  cacheTtl: z.enum(['5m', '1h']).optional(),
  /**
   * Of `cacheCreationTokens`, what the API said stays cached an hour and five minutes (Claude's `cache_creation` split, #1492):
   * the two are priced apart (docs/agent-host.md §6.1), so the weighting of writes needs them, not only which one the request had
   * most of. Absent when the tool did not split its writes; the part that is in neither is priced as a five-minute write.
   */
  cacheWrite1hTokens: z.number().optional(),
  cacheWrite5mTokens: z.number().optional(),
  /** The model that served this request, as the tool reported it (Claude's `message.model`); absent when it does not say (usage history, §6.2) */
  model: z.string().optional(),
})
export type RequestInput = z.infer<typeof RequestInput>

/**
 * Why a rebuild most likely happened, from what the host saw in that session between the request before it and this
 * one (docs/agent-host.md §6.1). A string on the wire, so a newer host's cause reaches an older screen as its name.
 *
 *   cold_start         the session's first request
 *   subagent           a subagent's first request (its own prompt)
 *   new_process        the session's process was started again: resumed, restarted, revived, a new host
 *   model_change       the model changed
 *   compaction         the conversation was compacted or cleared
 *   thread_restart     Codex's thread was restarted for its apps or settings
 *   instructions       the session's tools or instructions changed (apps attached, the orchestrator's skills)
 *   launch_settings    retained launch settings changed or were not recorded by the previous build
 *   expired            idle longer than the cache lifetime the API reported
 *   probably_expired   idle more than 5 minutes, the lifetime unknown
 *   unknown            none of these
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

/** One session's share of a cache window (`CacheWindowStats.sessions`) */
export const CacheSessionStats = z.object({
  sessionId: z.string(),
  /** The session's name when the host was asked; empty for a session that no longer exists */
  name: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  rebuilds: z.number(),
  /** The rebuilds by their likely cause (`RebuildCause`); absent from a host that predates it */
  rebuildCauses: z.record(z.string(), z.number()).optional(),
  /**
   * What the rebuilds wrote to the cache, in tokens (#1492): the sum of the cache writes of the requests counted as rebuilds, so the
   * steady writes every new message needs are not in it. For a tool that does not report writes (Codex) the input it did not read
   * from the cache stands in. Absent from a host that predates it, and from hours an earlier build stored.
   */
  rebuildTokens: z.number().optional(),
})
export type CacheSessionStats = z.infer<typeof CacheSessionStats>

/**
 * The prompt cache over one window of time, summed from the requests in it (docs/agent-host.md §6.1).
 *
 * The sums, not the rate: the hit rate is `cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreationTokens)`
 * and is computed where it is shown (`@cc/core` `cacheHitRate`), so a host and a UI of different builds cannot
 * disagree on what it means.
 */
export const CacheWindowStats = z.object({
  /** `5h`, `today` */
  id: z.string(),
  /** How the window is named on screen ("last 5 h", "today") */
  label: z.string(),
  /** ISO8601, where the window begins */
  since: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  /** Requests that wrote most of their prompt to the cache again (the threshold: docs/agent-host.md §6.1) */
  rebuilds: z.number(),
  /** The rebuilds by their likely cause (`RebuildCause`); absent from a host that predates it */
  rebuildCauses: z.record(z.string(), z.number()).optional(),
  /** What the rebuilds wrote to the cache, in tokens (`CacheSessionStats.rebuildTokens`) */
  rebuildTokens: z.number().optional(),
  /**
   * What the cache cost in units of an uncached input token (#1492), for the share the writes were of it: the tokens read from the cache
   * times the price of a read, and the tokens written times the price of a write, each as a ratio to uncached input (Anthropic: read 0.1,
   * five-minute write 1.25, one-hour write 2; Codex by model, docs/agent-host.md §6.1). No money: the ratios, not the prices. For a tool
   * that does not report writes (Codex) the write units are those of the input it did not read from the cache. Absent from a host that
   * predates them.
   */
  cacheReadCost: z.number().optional(),
  cacheWriteCost: z.number().optional(),
  /**
   * The shortest and longest idle time before a rebuild put down to the cache expiring (`expired`, `probably_expired`),
   * in milliseconds; absent when there was none
   */
  expiredIdleMs: z.object({ min: z.number(), max: z.number() }).optional(),
  /** The sessions that cost the cache most in this window, most first, a few at most */
  sessions: z.array(CacheSessionStats),
})
export type CacheWindowStats = z.infer<typeof CacheWindowStats>

/** What one tool's prompt cache did lately, on the machine that answers (`agents.usage`) */
export const CacheStats = z.object({
  /** The tool reports cache writes (Claude). False: reads only (Codex), and every write figure here is 0 */
  writes: z.boolean(),
  /**
   * ISO8601, when this host began counting. The figures live in the host's memory, so a window that began before
   * this is only partly known, and the screen says "since" this time instead of the window's name.
   */
  countingSince: z.string(),
  windows: z.array(CacheWindowStats),
})
export type CacheStats = z.infer<typeof CacheStats>

/**
 * What `usage.history` groups the token rows by (docs/agent-host.md §6.2); `day` and `hour` are the time axis
 * (`groupBy`).
 */
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
  /** What to call the key; a project that no longer exists is named by its id */
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
  /** What the rows' keys are, as asked: a hub qualifies the ids of a linked machine's sessions and projects by it */
  by: UsageHistoryBy,
  readings: z.array(UsageHistoryReadings),
  rows: z.array(UsageHistoryRow),
  /** The oldest token record this host keeps (ISO8601); absent when it keeps none. A range before it is not known */
  recordedSince: z.string().optional(),
})
export type UsageHistory = z.infer<typeof UsageHistory>

/**
 * A usage snapshot — **per account** (unrelated to any particular session or directory).
 *
 * Received as an array since the number and names of windows differ by tool:
 *   Claude — session (5 hours), weekly_all, weekly_scoped
 *   Codex  — primary (10080 minutes = weekly), secondary
 * The UI draws this without knowing how many windows there are. Adding a new window never
 * requires a screen change.
 */
export const UsageWindow = z.object({
  id: z.string(),
  label: z.string(),
  /** 0 to 100. How much of the limit has been used */
  percent: z.number(),
  /** When the window resets (ISO). Null if unknown */
  resetsAt: z.string().nullable().default(null),
  /** If this window applies to one specific model only, that model's name */
  scope: z.string().nullable().default(null),
})
export type UsageWindow = z.infer<typeof UsageWindow>

export const UsageSnapshot = z.object({
  plan: z.string().nullable().default(null),
  windows: z.array(UsageWindow).default([]),
  /** Daily tokens. A tool that cannot report this leaves it empty — the UI collapses that row on its own */
  daily: z.array(z.object({ date: z.string(), tokens: z.number() })).default([]),
  /**
   * The tool has no limits to report at all (#1623): `plan` and `totals` are everything it says. The screen then says so
   * plainly rather than "unavailable", and draws no limit bar. Absent for a tool that reports limits, and from a host that
   * predates it.
   */
  noLimits: z.boolean().optional(),
  /**
   * What the tool counted locally, as a total and not a limit (#1623): a tool with no limits to read may still say how much
   * was used on this computer. Absent when it says nothing, and from a host that predates it.
   */
  totals: z
    .object({
      /** What the totals cover, in the words the person reads under their title ("all time") */
      scope: z.string(),
      rows: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          value: z.number(),
          /** How the screen writes the value: a count, a number of tokens, or dollars */
          unit: z.enum(['count', 'tokens', 'usd']),
        }),
      ),
    })
    .optional(),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshot>
