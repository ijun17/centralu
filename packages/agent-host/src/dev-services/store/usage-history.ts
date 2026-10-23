import type Database from 'better-sqlite3'
import type { ToolName } from '@cc/protocol'

/** One window of a limit reading, as `agents.usage` names it */
export type StoredWindow = { id: string; scope: string | null; label: string; percent: number; resetsAt: number | null }

/** A stored reading of one window */
export type StoredReading = StoredWindow & { tool: ToolName; account: string; at: number }

export const HOUR_MS = 60 * 60_000

/** The requests of one hour for one session, project, tool, model and machine (`usage_buckets`, v62) */
export type UsageBucket = {
  /** The start of the hour, in ms */
  hour: number
  sessionId: string
  /** '' for the orchestrator */
  projectId: string
  tool: ToolName
  /** '' when the session had no model set */
  model: string
  /** '' for this host's own requests */
  machine: string
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  /** Of `cacheWrite`, what the API said stays cached five minutes / an hour */
  cacheWrite5m: number
  cacheWrite1h: number
  output: number
  rebuilds: number
  /** The rebuilds by `RebuildCause` */
  causes: Record<string, number>
}

type BucketRow = {
  hour: number
  sessionId: string
  projectId: string
  tool: ToolName
  model: string
  machine: string
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  cacheWrite5m: number
  cacheWrite1h: number
  output: number
  rebuilds: number
  causes: string
}

const BUCKET_COLUMNS = `hour, session_id AS sessionId, project_id AS projectId, tool, model, machine, requests, input,
  cache_read AS cacheRead, cache_write AS cacheWrite, cache_write_5m AS cacheWrite5m, cache_write_1h AS cacheWrite1h,
  output, rebuilds, causes`

/**
 * What the host keeps of usage over time (docs/agent-host.md §6.2): the limit windows' readings and the tokens per
 * hour. Counts and percentages only, no content. Local to this computer: nothing here is synced.
 */
export class UsageRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * Stores the readings of one tool's account at `at`, leaving out a window that reads as it did last time (same
   * percent and reset time): a flat line is one row, not one per sample. Returns how many rows were written.
   */
  addReadings(at: number, tool: ToolName, account: string, windows: readonly StoredWindow[]): number {
    const last = this.db.prepare<unknown[], { percent: number; resetsAt: number | null }>(
      `SELECT percent, resets_at AS resetsAt FROM usage_readings
        WHERE tool = ? AND account = ? AND window_id = ? AND scope = ? ORDER BY at DESC LIMIT 1`,
    )
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO usage_readings (tool, account, window_id, scope, label, at, percent, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let written = 0
    this.db.transaction(() => {
      for (const w of windows) {
        const scope = w.scope ?? ''
        const prev = last.get(tool, account, w.id, scope)
        if (prev && prev.percent === w.percent && sameReset(prev.resetsAt, w.resetsAt)) continue
        insert.run(tool, account, w.id, scope, w.label, at, w.percent, w.resetsAt)
        written++
      }
    })()
    return written
  }

  /**
   * The readings with `from <= at < to`, oldest first, and for each series the last one before `from`: a reading is
   * stored only when it changes, so the value in force when the range began is that older row. One tool's when `tool` is given.
   */
  readings(from: number, to: number, tool?: ToolName): StoredReading[] {
    const rows = this.db
      .prepare<unknown[], Omit<StoredReading, 'scope'> & { scope: string }>(
        `SELECT tool, account, window_id AS id, scope, label, at, percent, resets_at AS resetsAt FROM usage_readings r
          WHERE (? IS NULL OR tool = ?)
            AND ((at >= ? AND at < ?)
              OR (at < ? AND at = (SELECT MAX(at) FROM usage_readings
                                    WHERE tool = r.tool AND account = r.account AND window_id = r.window_id AND scope = r.scope AND at < ?)))
          ORDER BY at`,
      )
      .all(tool ?? null, tool ?? null, from, to, from, from)
    return rows.map((r) => ({ ...r, scope: r.scope || null }))
  }

  /**
   * Adds each bucket to the row of its key: one upsert per bucket, so a restart or a swap midway through an hour only
   * adds to it.
   */
  addBuckets(buckets: readonly UsageBucket[]): void {
    if (buckets.length === 0) return
    const causesOf = this.db.prepare<unknown[], { causes: string }>(
      `SELECT causes FROM usage_buckets WHERE hour = ? AND session_id = ? AND project_id = ? AND tool = ? AND model = ? AND machine = ?`,
    )
    const upsert = this.db.prepare(
      `INSERT INTO usage_buckets (hour, session_id, project_id, tool, model, machine, requests, input, cache_read, cache_write,
                                  cache_write_5m, cache_write_1h, output, rebuilds, causes)
       VALUES (@hour, @sessionId, @projectId, @tool, @model, @machine, @requests, @input, @cacheRead, @cacheWrite,
               @cacheWrite5m, @cacheWrite1h, @output, @rebuilds, @causes)
       ON CONFLICT(hour, session_id, project_id, tool, model, machine) DO UPDATE SET
         requests = requests + excluded.requests, input = input + excluded.input, cache_read = cache_read + excluded.cache_read,
         cache_write = cache_write + excluded.cache_write, cache_write_5m = cache_write_5m + excluded.cache_write_5m,
         cache_write_1h = cache_write_1h + excluded.cache_write_1h, output = output + excluded.output,
         rebuilds = rebuilds + excluded.rebuilds, causes = excluded.causes`,
    )
    this.db.transaction(() => {
      for (const b of buckets) {
        const old = causesOf.get(b.hour, b.sessionId, b.projectId, b.tool, b.model, b.machine)
        const causes = mergeCauses(parseCauses(old?.causes), b.causes)
        upsert.run({ ...b, causes: JSON.stringify(causes) })
      }
    })()
  }

  /** The buckets whose hour is in `[from, to)`, oldest first; one tool's when `tool` is given */
  buckets(from: number, to: number, tool?: ToolName): UsageBucket[] {
    const rows = this.db
      .prepare<unknown[], BucketRow>(`SELECT ${BUCKET_COLUMNS} FROM usage_buckets WHERE hour >= ? AND hour < ? AND (? IS NULL OR tool = ?) ORDER BY hour`)
      .all(from, to, tool ?? null, tool ?? null)
    return rows.map((r) => ({ ...r, causes: parseCauses(r.causes) }))
  }

  /** The start of the oldest hour kept (of one tool when given), null when none is */
  firstHour(tool?: ToolName): number | null {
    const row = this.db.prepare<unknown[], { hour: number | null }>(`SELECT MIN(hour) AS hour FROM usage_buckets WHERE (? IS NULL OR tool = ?)`).get(tool ?? null, tool ?? null)
    return row?.hour ?? null
  }

  /**
   * Drops the buckets of sessions that no longer exist: a build older than this one purged them during a swap and left
   * the rows (they would show under the raw id). A trashed session still has its row, so its buckets stay.
   */
  sweepOrphans(): void {
    this.db.prepare(`/* includes the archive: a trashed session still has its row and keeps its buckets */
       DELETE FROM usage_buckets WHERE session_id NOT IN (SELECT id FROM sessions)`).run()
  }

  /** Drops what is older than `before` (ms): hours that began before it, readings taken before it */
  prune(before: number): void {
    this.db.prepare(`DELETE FROM usage_buckets WHERE hour < ?`).run(before)
    this.db.prepare(`DELETE FROM usage_readings WHERE at < ?`).run(before)
  }
}

/**
 * Claude derives a window's reset time from a relative one, so it moves by a few hundred ms on every read of an unchanged
 * window. A reset time that differs by less than this is the same one.
 */
export const RESET_TOLERANCE_MS = 60_000

function sameReset(a: number | null, b: number | null): boolean {
  return a === null || b === null ? a === b : Math.abs(a - b) < RESET_TOLERANCE_MS
}

function parseCauses(text: string | undefined): Record<string, number> {
  try {
    const v: unknown = JSON.parse(text ?? '{}')
    const out: Record<string, number> = {}
    if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) if (typeof n === 'number') out[k] = n
    return out
  } catch {
    return {}
  }
}

/** Sums two counts of rebuilds by cause */
export function mergeCauses(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n
  return out
}
