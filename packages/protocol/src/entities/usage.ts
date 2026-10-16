import { z } from 'zod'

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
 * (`codex/normalize.ts`). If the two tools did not carry the same meaning here, whatever sums
 * them up (an app's requested-agent history, M4 D-5) would record a different number depending
 * on the tool.
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
})
export type UsageSnapshot = z.infer<typeof UsageSnapshot>
