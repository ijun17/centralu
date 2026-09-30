import { createHash } from 'node:crypto'

/**
 * The shape and rules of the run ledger (M4 A-6).
 *
 * The runtime does not know **where** the ledger is stored — it only declares the shape
 * (`RunLedger`), and the host fills it in with the store (main.ts). **What** gets kept is decided
 * here: arguments are kept only as a summary and a hash, secret values are never written anywhere,
 * and only the most recent failed calls keep their original text.
 */

/** The retention period — on every startup, anything older than this is pruned */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** How many failures per app keep their original text */
export const FAILURES_KEPT = 20
/** The length of the argument summary — one line in the runs screen */
export const SUMMARY_CHARS = 200

export type AppRunRow = {
  id: string
  projectId: string | null
  appId: string
  /**
   * What this row is a record of (M4 D-6) — `tool` is a call to this app's own tool, `broker` is
   * something this app **requested** over fd 3 (`tool` is the broker tool's name: run_agent,
   * call_app, host_data). An app's own tool name can collide with a broker tool's name, so the name
   * alone cannot distinguish them.
   */
  kind: 'tool' | 'broker'
  tool: string
  callerKind: 'view' | 'session' | 'app'
  callerSessionId: string | null
  parentRunId: string | null
  status: 'running' | 'ok' | 'error' | 'cancelled' | 'rejected'
  durationMs: number | null
  argsDigest: string
  argsSummary: string
  error: string | null
  createdAt: number
  /** The agent session this request started (a run_agent row) — this is where a chain crosses over into that session */
  sessionId: string | null
}

/** Tokens an agent spent (M4 D-5) — as much as the tool reported. If the tool did not report it, the row has none (null) */
export type AgentTokens = { input: number; output: number }

/** A row as read back — the store returns text (an open-ended string), and the protocol narrows its shape */
export type AppRunListed = Omit<AppRunRow, 'callerKind' | 'status' | 'kind'> & {
  callerKind: string
  status: string
  kind: string
  /** Tokens on a run_agent row (D-5) */
  tokens: AgentTokens | null
  failure: { args: string; result: string | null } | null
}

/**
 * The agent usage one app has requested (M4 D-5) — over a period, the count of agent runs that
 * **actually started** (a run_agent row with a session), the sum of time spent, and the sum of
 * tokens. A refused request never started an agent, so it is not counted. Tokens are added up only
 * from runs that reported them — null if there were none at all.
 */
export type AgentUse = { runs: number; durationMs: number; tokens: AgentTokens | null }

export type RunLedger = {
  begin(row: AppRunRow): void
  end(id: string, end: { status: AppRunRow['status']; durationMs: number; error: string | null; tokens?: AgentTokens | null }): void
  /** Links an agent session to a still-running row (D-6) — the moment the session exists, before it ends */
  link(id: string, sessionId: string): void
  keepFailure(f: { runId: string; projectId: string | null; appId: string; args: string; result: string | null; createdAt: number }, keep: number): void
  list(projectId: string | null, appId: string, limit: number): AppRunListed[]
  /** The agent usage this app requested since `since` (D-5) */
  agentUse(projectId: string | null, appId: string, since: number): AgentUse
  prune(before: number): number
  settleUnfinished(error: string): number
}

/**
 * A ledger that announces when the record changes (M4 D-6) — when a row starts (`begin`), gets
 * linked to a session (`link`), and ends (`end`), it calls `announce` for **every app whose runs
 * panel can see that row.** One app's runs panel shows that app's own rows and the chain beneath
 * them (`listAppRuns`) — so a single row is visible on the panel of its own app, and on the panels
 * of every app further up the chain it descended from.
 *
 * Each row decides those apps and holds onto them **at the moment the row starts.** Its parent is
 * open at that point (a row only ever starts under an open run — a denied row with no parent belongs
 * only to its own app). It is not recomputed by walking up again when the row ends: if the parent
 * ended first, the chain is already broken, and a panel further up would never hear about this row
 * ending.
 *
 * Why this is a different signal from "changed" (`emitChanged`): that one means a value inside the
 * app changed, and its open screen re-reads. A read-only tool's call never emits that (doing so
 * would turn the screen's re-read into a loop, #190). But a read-only tool can still request an
 * agent and start a chain that runs for minutes — the runs panel has to hear about that, and the
 * screen must not.
 */
export function announcingLedger(inner: RunLedger, announce: (app: { projectId: string | null; appId: string }) => void): RunLedger {
  type App = { projectId: string | null; appId: string }
  const open = new Map<string, App[]>()
  const tell = (apps: readonly App[] | undefined) => {
    for (const a of apps ?? []) announce(a)
  }
  return {
    ...inner,
    begin(row) {
      inner.begin(row)
      const apps: App[] = [{ projectId: row.projectId, appId: row.appId }]
      for (const up of row.parentRunId ? (open.get(row.parentRunId) ?? []) : []) {
        if (!apps.some((a) => a.projectId === up.projectId && a.appId === up.appId)) apps.push(up)
      }
      open.set(row.id, apps)
      tell(apps)
    },
    link(id, sessionId) {
      inner.link(id, sessionId)
      tell(open.get(id))
    },
    end(id, e) {
      inner.end(id, e)
      tell(open.get(id))
      open.delete(id)
    },
  }
}

/**
 * JSON with key order fixed. If the same arguments produced a different hash just because their key
 * order differed, there would be no way to count "failed again with the same input".
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/**
 * Arguments → what gets kept in the ledger. Summarized and hashed **after masking**: a hash is still
 * a trace of the input — the hash of an argument containing a short secret can be recovered by
 * brute-force lookup.
 */
export function describeArgs(args: unknown, redact: (t: string) => string): { json: string; digest: string; summary: string } {
  const json = redact(canonicalJson(args))
  const digest = createHash('sha256').update(json).digest('hex')
  const summary = json.length > SUMMARY_CHARS ? `${json.slice(0, SUMMARY_CHARS)}…` : json
  return { json, digest, summary }
}
