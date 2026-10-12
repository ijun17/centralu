import type { CacheSessionStats, CacheStats, CacheWindowStats, RequestInput, ToolName } from '@cc/protocol'

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
 */
export const REBUILD_SHARE = 0.5
/**
 * …and at least this many tokens. Claude Code's own fixed prefix (system prompt and tool definitions) is well over
 * 10,000 tokens, so every real rebuild is far above this; a small helper request that writes a little prompt is not
 * worth pointing at.
 */
export const REBUILD_MIN_TOKENS = 4_096

/** How long an entry is kept: the longest window is "today", which never reaches back more than a day */
const KEEP_MS = 24 * 60 * 60_000
/** At most this many entries per tool, oldest dropped first: a bound on memory however busy a day gets (~100 bytes each) */
const MAX_ENTRIES = 50_000
/** How many sessions a window names */
const TOP_SESSIONS = 3
const FIVE_HOURS_MS = 5 * 60 * 60_000

type Entry = {
  at: number
  sessionId: string
  input: number
  read: number
  write: number
  rebuild: boolean
}

/** Whether one request rewrote most of its prompt to the cache (the rule above) */
export function isRebuild(r: RequestInput): boolean {
  const write = r.cacheCreationTokens ?? 0
  const total = r.inputTokens + r.cacheReadTokens + write
  return write >= REBUILD_MIN_TOKENS && write >= total * REBUILD_SHARE
}

export class CacheLedger {
  private readonly entries = new Map<ToolName, Entry[]>()
  /** Tools that have reported a cache write figure at least once (Claude); the others report reads only */
  private readonly reportsWrites = new Set<ToolName>()
  private readonly startedAt: number

  constructor(now: number = Date.now()) {
    this.startedAt = now
  }

  record(tool: ToolName, sessionId: string, r: RequestInput, at: number = Date.now()): void {
    const write = r.cacheCreationTokens ?? 0
    // A synthesized answer (Claude's local /usage, "<synthetic>") carries zeros: there was no request
    if (r.inputTokens + r.cacheReadTokens + write <= 0) return
    if (r.cacheCreationTokens !== undefined) this.reportsWrites.add(tool)
    let list = this.entries.get(tool)
    if (!list) this.entries.set(tool, (list = []))
    list.push({ at, sessionId, input: r.inputTokens, read: r.cacheReadTokens, write, rebuild: isRebuild(r) })
    // Entries arrive in time order, so the old ones are at the front
    let drop = 0
    while (drop < list.length && list[drop]!.at < at - KEEP_MS) drop++
    drop = Math.max(drop, list.length - MAX_ENTRIES)
    if (drop > 0) list.splice(0, drop)
  }

  /**
   * The last five hours and today (the host's local midnight). `nameOf` names a session; undefined for one that is
   * gone.
   */
  stats(tool: ToolName, nameOf: (sessionId: string) => string | undefined, now: number = Date.now()): CacheStats {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const list = this.entries.get(tool) ?? []
    const writes = this.reportsWrites.has(tool)
    return {
      writes,
      countingSince: new Date(this.startedAt).toISOString(),
      windows: [
        windowOf(list, '5h', 'last 5 h', now - FIVE_HOURS_MS, writes, nameOf),
        windowOf(list, 'today', 'today', midnight.getTime(), writes, nameOf),
      ],
    }
  }
}

function windowOf(
  list: readonly Entry[],
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
    sessions: [],
  }
  const bySession = new Map<string, CacheSessionStats>()
  for (const e of list) {
    if (e.at < since) continue
    w.requests++
    w.inputTokens += e.input
    w.cacheReadTokens += e.read
    w.cacheCreationTokens += e.write
    if (e.rebuild) w.rebuilds++
    let s = bySession.get(e.sessionId)
    if (!s) {
      s = { sessionId: e.sessionId, name: '', requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rebuilds: 0 }
      bySession.set(e.sessionId, s)
    }
    s.requests++
    s.inputTokens += e.input
    s.cacheReadTokens += e.read
    s.cacheCreationTokens += e.write
    if (e.rebuild) s.rebuilds++
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
