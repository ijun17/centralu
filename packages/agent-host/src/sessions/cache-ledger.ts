import type { UsageBucket } from '../dev-services/store/usage-history.js'
import type { CacheSessionStats, CacheStats, CacheWindowStats, RebuildCause, RequestInput, ToolName } from '@cc/protocol'

/**
 * What the prompt cache did lately, per tool (docs/agent-host.md §6.1).
 *
 * One entry per model request, as the adapters report them (`usage_update.request`). Kept **in memory**: the window
 * is hours, a restart loses only what the screen then says it does not know ("since 14:02"), and a table would be a
 * migration and a write per request for a number that is only read when someone opens the gauge. Nothing here runs
 * on a timer: entries are added as requests close and summed when `agents.usage` asks.
 */

/**
 * A request is a **rebuild** when what it wrote to the cache is at least this share of its whole input…
 *
 * Normal work writes only what is new since the last request (a reply, a tool result) and reads the rest, so its
 * write is a small share. A request whose cached prefix had expired (more than five minutes idle) or changed (another
 * model, edited tools or system prompt) reads almost nothing and writes almost everything. Half is the line between
 * the two, wide on both sides: a long session's ordinary request writes a few percent, a rebuild well over 90%.
 *
 * A tool that reports reads only (Codex) has no write figure; for it, what was not read from cache stands in: a
 * request that read less than half its input from cache paid the rest in full, and that is what the provider caches
 * for the next one.
 */
export const REBUILD_SHARE = 0.5
/**
 * …and at least this many tokens. Claude Code's own fixed prefix (system prompt and tool definitions) is well over
 * 10,000 tokens, so every real rebuild is far above this; a small helper request that writes a little prompt is not
 * worth pointing at.
 */
export const REBUILD_MIN_TOKENS = 4_096
/**
 * Idle longer than this, with the cache lifetime unknown, is "probably expired": the API's default lifetime is five
 * minutes (Claude Code asks for an hour only in some cases, and says which in its usage; Codex does not say).
 */
export const DEFAULT_TTL_MS = 5 * 60_000
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const

/** How long an entry is kept: the longest window is "today", which never reaches back more than a day */
const KEEP_MS = 24 * 60 * 60_000
/** At most this many entries per tool, oldest dropped first: a bound on memory however busy a day gets (~120 bytes each) */
const MAX_ENTRIES = 50_000
/** At most this many lanes (a session's conversation, or one of its subagents) and sessions with notes held at once */
const MAX_LANES = 5_000
/** How many sessions a window names */
const TOP_SESSIONS = 3
const FIVE_HOURS_MS = 5 * 60 * 60_000
const HOUR_MS = 60 * 60_000

/**
 * The causes the host is told about between two requests (`note`), strongest evidence first. Which of them is named
 * for a rebuild is the first one present; the time gap and "unknown" are judged only when none is.
 */
const NOTED: readonly RebuildCause[] = ['cold_start', 'new_process', 'model_change', 'compaction', 'thread_restart', 'instructions', 'launch_settings']

type Entry = {
  at: number
  sessionId: string
  input: number
  read: number
  write: number
  rebuild: boolean
  /** The likely cause, for a rebuild */
  cause?: RebuildCause
  /** How long the lane had been idle, for a rebuild put down to expiry */
  idleMs?: number
}

/**
 * Requests an earlier run of this host counted, restored from the stored hourly buckets (`restore`): one entry per
 * bucket, placed in the middle of its hour, so a window that begins inside that hour takes it or leaves it whole.
 */
type Carried = {
  at: number
  sessionId: string
  requests: number
  input: number
  read: number
  write: number
  rebuilds: number
  causes: Record<string, number>
}

/** What `record` counted: whether the request was a rebuild, and why */
export type Counted = { rebuild: boolean; cause?: RebuildCause }

/** One prompt and its cache: a session's own conversation, or one subagent of it */
type Lane = { lastAt: number; ttlMs: number | null }

/** Whether one request rewrote most of its prompt to the cache (the rule above) */
export function isRebuild(r: RequestInput): boolean {
  const total = r.inputTokens + r.cacheReadTokens + (r.cacheCreationTokens ?? 0)
  const paid = r.cacheCreationTokens ?? r.inputTokens
  return paid >= REBUILD_MIN_TOKENS && paid >= total * REBUILD_SHARE
}

export class CacheLedger {
  private readonly entries = new Map<ToolName, Entry[]>()
  private readonly carried = new Map<ToolName, Carried[]>()
  /** Tools that have reported a cache write figure at least once (Claude); the others report reads only */
  private readonly reportsWrites = new Set<ToolName>()
  private readonly lanes = new Map<string, Lane>()
  /** What happened in a session since its conversation's last request (`note`), consumed by the next one */
  private readonly notes = new Map<string, Set<RebuildCause>>()
  private startedAt: number

  constructor(now: number = Date.now()) {
    this.startedAt = now
  }

  /**
   * Something happened in a session that would make its next request rebuild the cache: the session was created, its
   * process started again, its model changed. Kept until that session's own conversation makes a request.
   */
  note(sessionId: string, cause: RebuildCause): void {
    let set = this.notes.get(sessionId)
    if (!set) {
      if (this.notes.size >= MAX_LANES) this.notes.delete(this.notes.keys().next().value!)
      this.notes.set(sessionId, (set = new Set()))
    }
    set.add(cause)
  }

  /** A session is gone for good: its entries leave the figures, so no window names it with an empty name */
  forget(sessionId: string): void {
    for (const [tool, list] of this.entries) this.entries.set(tool, list.filter((e) => e.sessionId !== sessionId))
    for (const [tool, list] of this.carried) this.carried.set(tool, list.filter((c) => c.sessionId !== sessionId))
    this.notes.delete(sessionId)
  }

  /**
   * Takes the buckets an earlier run stored (`usage_buckets`) as requests this host had already counted, so the figures
   * outlive a restart or a swap. Called once, before this run's first request: a bucket this run adds to later is
   * not in the list, so nothing is counted twice. `countingSince` moves back to the oldest hour restored.
   */
  restore(buckets: readonly UsageBucket[]): void {
    for (const b of buckets) {
      let list = this.carried.get(b.tool)
      if (!list) this.carried.set(b.tool, (list = []))
      list.push({
        at: b.hour + HOUR_MS / 2,
        sessionId: b.sessionId,
        requests: b.requests,
        input: b.input,
        read: b.cacheRead,
        write: b.cacheWrite,
        rebuilds: b.rebuilds,
        causes: b.causes,
      })
      if (b.cacheWrite > 0) this.reportsWrites.add(b.tool)
      this.startedAt = Math.min(this.startedAt, b.hour)
    }
  }

  /** Counts one request. Returns what it counted as, or undefined for a reading that was no request */
  record(tool: ToolName, sessionId: string, r: RequestInput, at: number = Date.now()): Counted | undefined {
    const write = r.cacheCreationTokens ?? 0
    // A synthesized answer (Claude's local /usage, "<synthetic>") carries zeros: there was no request
    if (r.inputTokens + r.cacheReadTokens + write <= 0) return undefined
    if (r.cacheCreationTokens !== undefined) this.reportsWrites.add(tool)

    const key = `${sessionId}\n${r.agent ?? ''}`
    const lane = this.lanes.get(key)
    // A subagent's request does not take the notes: they are about the session's own conversation
    const notes = r.agent ? undefined : this.notes.get(sessionId)
    if (!r.agent) this.notes.delete(sessionId)
    const rebuild = isRebuild(r)
    const entry: Entry = { at, sessionId, input: r.inputTokens, read: r.cacheReadTokens, write, rebuild }
    if (rebuild) Object.assign(entry, causeOf(r, lane, notes, at))

    this.lanes.delete(key) // re-inserted last, so the lane idle longest is the one let go below
    const ttlMs = r.cacheTtl ? TTL_MS[r.cacheTtl] : (lane?.ttlMs ?? null)
    this.lanes.set(key, { lastAt: at, ttlMs })
    if (this.lanes.size > MAX_LANES) this.lanes.delete(this.lanes.keys().next().value!)

    let list = this.entries.get(tool)
    if (!list) this.entries.set(tool, (list = []))
    list.push(entry)
    // Entries arrive in time order, so the old ones are at the front
    let drop = 0
    while (drop < list.length && list[drop]!.at < at - KEEP_MS) drop++
    drop = Math.max(drop, list.length - MAX_ENTRIES)
    if (drop > 0) list.splice(0, drop)
    return { rebuild, ...(entry.cause ? { cause: entry.cause } : {}) }
  }

  /**
   * The last five hours and today (the host's local midnight). `nameOf` names a session; undefined for one that is
   * gone.
   */
  stats(tool: ToolName, nameOf: (sessionId: string) => string | undefined, now: number = Date.now()): CacheStats {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const list = this.entries.get(tool) ?? []
    const carried = this.carried.get(tool) ?? []
    const writes = this.reportsWrites.has(tool)
    return {
      writes,
      countingSince: new Date(this.startedAt).toISOString(),
      windows: [
        windowOf(list, carried, '5h', 'last 5 h', now - FIVE_HOURS_MS, writes, nameOf),
        windowOf(list, carried, 'today', 'today', midnight.getTime(), writes, nameOf),
      ],
    }
  }
}

/**
 * The likely cause of a rebuild, strongest evidence first (docs/agent-host.md §6.1):
 *
 * 1. what the host was told happened since the conversation's last request (`NOTED`, in that order), and a subagent's
 *    first request;
 * 2. a session's conversation the host has never seen a request of, with nothing noted: its process started after
 *    this host did (a restart or a host swap), so it is a new process;
 * 3. idle longer than the cache lifetime the API reported for this lane's writes, or more than five minutes when it
 *    never said;
 * 4. otherwise unknown.
 */
function causeOf(
  r: RequestInput,
  lane: Lane | undefined,
  notes: ReadonlySet<RebuildCause> | undefined,
  at: number,
): { cause: RebuildCause; idleMs?: number } {
  if (notes?.has('cold_start')) return { cause: 'cold_start' }
  if (!lane) return { cause: r.agent ? 'subagent' : 'new_process' }
  for (const c of NOTED) if (notes?.has(c)) return { cause: c }
  const idleMs = at - lane.lastAt
  if (lane.ttlMs !== null) return idleMs > lane.ttlMs ? { cause: 'expired', idleMs } : { cause: 'unknown' }
  return idleMs > DEFAULT_TTL_MS ? { cause: 'probably_expired', idleMs } : { cause: 'unknown' }
}

function windowOf(
  list: readonly Entry[],
  carried: readonly Carried[],
  id: string,
  label: string,
  since: number,
  writes: boolean,
  nameOf: (sessionId: string) => string | undefined,
): CacheWindowStats {
  const w: CacheWindowStats = {
    id,
    label,
    since: new Date(since).toISOString(),
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    rebuilds: 0,
    rebuildCauses: {},
    sessions: [],
  }
  const causes = w.rebuildCauses!
  const bySession = new Map<string, CacheSessionStats>()
  for (const e of list) {
    if (e.at < since) continue
    w.requests++
    w.inputTokens += e.input
    w.cacheReadTokens += e.read
    w.cacheCreationTokens += e.write
    let s = bySession.get(e.sessionId)
    if (!s) {
      s = { sessionId: e.sessionId, name: '', requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rebuilds: 0, rebuildCauses: {} }
      bySession.set(e.sessionId, s)
    }
    s.requests++
    s.inputTokens += e.input
    s.cacheReadTokens += e.read
    s.cacheCreationTokens += e.write
    if (!e.rebuild) continue
    w.rebuilds++
    s.rebuilds++
    const cause = e.cause ?? 'unknown'
    causes[cause] = (causes[cause] ?? 0) + 1
    s.rebuildCauses![cause] = (s.rebuildCauses![cause] ?? 0) + 1
    if (e.idleMs !== undefined) {
      const idle = w.expiredIdleMs
      w.expiredIdleMs = idle ? { min: Math.min(idle.min, e.idleMs), max: Math.max(idle.max, e.idleMs) } : { min: e.idleMs, max: e.idleMs }
    }
  }
  // What an earlier run counted (`restore`): the same sums, a bucket at a time
  for (const c of carried) {
    if (c.at < since) continue
    w.requests += c.requests
    w.inputTokens += c.input
    w.cacheReadTokens += c.read
    w.cacheCreationTokens += c.write
    w.rebuilds += c.rebuilds
    let s = bySession.get(c.sessionId)
    if (!s) {
      s = { sessionId: c.sessionId, name: '', requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rebuilds: 0, rebuildCauses: {} }
      bySession.set(c.sessionId, s)
    }
    s.requests += c.requests
    s.inputTokens += c.input
    s.cacheReadTokens += c.read
    s.cacheCreationTokens += c.write
    s.rebuilds += c.rebuilds
    const ofSession = (s.rebuildCauses ??= {})
    for (const [cause, n] of Object.entries(c.causes)) {
      causes[cause] = (causes[cause] ?? 0) + n
      ofSession[cause] = (ofSession[cause] ?? 0) + n
    }
  }
  /*
   * What a session cost the cache: what it wrote, for a tool that says so. A tool that reports reads only (Codex)
   * is ranked by the input it did not read from cache, which is what it paid in full.
   */
  const cost = (s: CacheSessionStats) => (writes ? s.cacheCreationTokens : s.inputTokens)
  w.sessions = [...bySession.values()]
    .filter((s) => cost(s) > 0)
    .sort((a, b) => cost(b) - cost(a))
    .slice(0, TOP_SESSIONS)
    .map((s) => ({ ...s, name: nameOf(s.sessionId) ?? '' }))
  return w
}
