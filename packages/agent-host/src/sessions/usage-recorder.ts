import { errorMessage, type RequestInput, type ToolName, type UsageSnapshot } from '@cc/protocol'
import { HOUR_MS, type StoredWindow, type UsageBucket, type UsageRecords } from '../dev-services/store/usage-history.js'
import { paidTokens, type Counted } from './cache-ledger.js'

/**
 * Keeps usage over time (docs/agent-host.md §6.2): the requests `CacheLedger` counts, summed into hourly buckets and
 * written once a minute, and the limit windows' readings. Both come from what the host is told or asks the tool
 * itself, never from the tool's files (§8.1).
 */

/** How long counted requests wait in memory before they are written, and so the most a crash loses */
export const FLUSH_MS = 60_000
/** How often the limit windows are read while a session of the tool is live */
export const SAMPLE_MS = 10 * 60_000
/** A turn end reads the limits at most this often per tool */
export const TURN_END_GAP_MS = 2 * 60_000
/** How long records are kept */
export const KEEP_DAYS = 90
/** The login's fingerprint is looked up again after this long */
const ACCOUNT_MS = 10 * 60_000

export type RequestSource = {
  sessionId: string
  /** null for the orchestrator */
  projectId: string | null
  tool: ToolName
  model: string | undefined
}

export class UsageRecorder {
  private readonly buckets = new Map<string, UsageBucket>()
  private readonly accounts = new Map<ToolName, { fingerprint: string; at: number }>()
  private readonly lastRead = new Map<ToolName, number>()
  private timers: NodeJS.Timeout[] = []
  private lastPrune = 0

  constructor(
    private readonly usage: UsageRecords,
    private readonly opts: {
      /** The fingerprint of the login a tool uses here (`agents.account`); '' when it does not say */
      accountOf: (tool: ToolName) => Promise<string>
      now?: () => number
    },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** Counts one request in its hour's bucket, in memory until the next flush */
  request(src: RequestSource, r: RequestInput, counted: Counted, at: number = this.now()): void {
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS
    const projectId = src.projectId ?? ''
    // The model that served the request when the tool says (Claude), else the session's setting
    const model = r.model || src.model || ''
    const id = [hour, src.sessionId, projectId, src.tool, model].join('\n')
    let b = this.buckets.get(id)
    if (!b) {
      this.buckets.set(
        id,
        (b = { hour, sessionId: src.sessionId, projectId, tool: src.tool, model, machine: '', requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, rebuilds: 0, rebuildTokens: 0, causes: {} }),
      )
    }
    const write = r.cacheCreationTokens ?? 0
    b.requests++
    b.input += r.inputTokens
    b.cacheRead += r.cacheReadTokens
    b.cacheWrite += write
    // The API's own split of what the request wrote (#1492), else the whole write under the one lifetime it reported
    b.cacheWrite1h += r.cacheWrite1hTokens ?? (r.cacheTtl === '1h' ? write : 0)
    b.cacheWrite5m += r.cacheWrite5mTokens ?? (r.cacheTtl === '5m' ? write : 0)
    b.output += r.outputTokens ?? 0
    if (counted.rebuild) {
      b.rebuilds++
      b.rebuildTokens += paidTokens(r)
      const cause = counted.cause ?? 'unknown'
      b.causes[cause] = (b.causes[cause] ?? 0) + 1
    }
  }

  /** Writes the buckets held in memory, one upsert each. Returns how many. A failed write keeps them for the next try */
  flush(): number {
    if (this.buckets.size === 0) return 0
    const list = [...this.buckets.values()]
    try {
      this.usage.addBuckets(list)
    } catch (err) {
      console.error(`[usage] could not write ${list.length} bucket(s): ${errorMessage(err)}`)
      return 0
    }
    this.buckets.clear()
    return list.length
  }

  /** A session is gone for good: what it counted and has not been written yet goes too (its stored rows go with it) */
  forget(sessionId: string): void {
    for (const [id, b] of this.buckets) if (b.sessionId === sessionId) this.buckets.delete(id)
  }

  /** Stores a reading `agents.usage` took of a tool's limit windows (unchanged windows are left out) */
  async snapshot(tool: ToolName, snapshot: UsageSnapshot, at: number = this.now()): Promise<void> {
    const windows: StoredWindow[] = snapshot.windows.map((w) => ({
      id: w.id,
      scope: w.scope,
      label: w.label,
      percent: w.percent,
      resetsAt: w.resetsAt ? Date.parse(w.resetsAt) || null : null,
    }))
    if (windows.length === 0) return
    try {
      this.usage.addReadings(at, tool, await this.account(tool), windows)
    } catch (err) {
      console.error(`[usage] could not store the ${tool} limit reading: ${errorMessage(err)}`)
    }
  }

  private async account(tool: ToolName): Promise<string> {
    const hit = this.accounts.get(tool)
    const now = this.now()
    if (hit && now - hit.at < ACCOUNT_MS) return hit.fingerprint
    const fingerprint = await this.opts.accountOf(tool).catch(() => '')
    this.accounts.set(tool, { fingerprint, at: now })
    return fingerprint
  }

  /** Drops what is older than the keeping time. Once a day at most unless `force` */
  prune(force = false): void {
    const now = this.now()
    if (!force && now - this.lastPrune < 24 * HOUR_MS) return
    this.lastPrune = now
    try {
      this.usage.prune(now - KEEP_DAYS * 24 * HOUR_MS)
    } catch (err) {
      console.error(`[usage] could not prune: ${errorMessage(err)}`)
    }
  }

  /**
   * A turn ended: reads the tool's limits through `read`, unless that was done lately. A turn end is when a tool's
   * window has just moved, and the only moment a quiet account would otherwise not be looked at.
   */
  turnEnded(tool: ToolName, read: (tool: ToolName) => Promise<unknown>): void {
    const now = this.now()
    if (now - (this.lastRead.get(tool) ?? 0) < TURN_END_GAP_MS) return
    this.lastRead.set(tool, now)
    void read(tool).catch(() => undefined)
  }

  /**
   * Starts the timers: a flush each minute, and each ten minutes a limit reading of every tool in `liveTools` (a tool
   * with no live session is not started up just to be looked at; the gauge's own polls cover a person who is looking).
   */
  start(liveTools: () => ToolName[], read: (tool: ToolName) => Promise<unknown>): void {
    this.prune()
    const tick = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref()
      this.timers.push(t)
    }
    tick(FLUSH_MS, () => {
      this.flush()
      this.prune()
    })
    tick(SAMPLE_MS, () => {
      for (const tool of liveTools()) {
        this.lastRead.set(tool, this.now())
        void read(tool).catch(() => undefined)
      }
    })
  }

  /** Stops the timers and writes what is left (the host is draining) */
  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.flush()
  }
}
