import { createHash } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { AgentUse } from '@cc/protocol'

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
export type AgentTokens = NonNullable<AgentUse['tokens']>

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
 * from runs that reported them — null if there were none at all. The protocol's shape, as the screen reads it.
 */
export type { AgentUse }

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
 * One run's row, from the moment it starts to its outcome (A-6, D-6) — a tool call's row
 * (`ExternalApps.call`) and a broker request's row (the desk) alike, so both are kept under the same
 * rules: arguments as a masked summary and a hash, the error masked, and the original input kept
 * only for a failure (the most recent `FAILURES_KEPT`). A failed input is needed by the building
 * agent to fix things.
 *
 * A row is created the first time it is needed (`open`): a tool call opens it as the call comes in,
 * a broker request when its kind needs a running row (see `BrokerDesk.handle`). Closing opens it
 * first if it never was, and only the first close counts. Without a ledger, nothing is written.
 */
export class RunRow {
  readonly id: string
  private described: ReturnType<typeof describeArgs> | null = null
  private closed = false
  /** Tokens an agent spent — overwritten every time the tool reports it (it is a cumulative value). Written when this closes */
  used: AgentTokens | null = null

  constructor(
    private ledger: RunLedger | null,
    private head: Pick<AppRunRow, 'id' | 'projectId' | 'appId' | 'kind' | 'tool' | 'callerKind' | 'callerSessionId' | 'parentRunId' | 'createdAt'>,
    private args: unknown,
    private redact: (text: string) => string,
  ) {
    this.id = head.id
  }

  open(): void {
    if (this.described || !this.ledger) return
    this.described = describeArgs(this.args, this.redact)
    this.ledger.begin({
      ...this.head,
      status: 'running',
      durationMs: null,
      argsDigest: this.described.digest,
      argsSummary: this.described.summary,
      error: null,
      sessionId: null,
    })
  }

  /** Links the agent session this request started — the moment the session exists, before it ends */
  link(sessionId: string): void {
    this.open()
    this.ledger?.link(this.id, sessionId)
  }

  /** The masked one-line summary of the arguments — also what an error bundle quotes (C-6), with or without a ledger */
  summary(): string {
    return (this.described ?? describeArgs(this.args, this.redact)).summary
  }

  close(status: Exclude<AppRunRow['status'], 'running'>, error: string | null, result: CallToolResult | null = null): void {
    if (this.closed || !this.ledger) return
    this.closed = true
    this.open()
    const t0 = this.head.createdAt
    this.ledger.end(this.id, { status, durationMs: Date.now() - t0, error: error === null ? null : this.redact(error), tokens: this.used })
    if (status === 'error') {
      this.ledger.keepFailure(
        {
          runId: this.id,
          projectId: this.head.projectId,
          appId: this.head.appId,
          args: this.described!.json,
          result: result ? maskedJson(result, this.redact) : null,
          createdAt: t0,
        },
        FAILURES_KEPT,
      )
    }
  }
}

/**
 * JSON with key order fixed. If the same arguments produced a different hash just because their key
 * order differed, there would be no way to count "failed again with the same input".
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

/**
 * `value` as JSON with secrets masked: every string in it first (keys too), then the JSON text as a whole (#838).
 * Masking the text alone missed a secret the value already held JSON-escaped, an app answering with JSON as its text
 * (`{"token":"pa\"ss"}`) or an agent passing it as an argument: JSON.stringify escaped it a second time, and that
 * spelling matched neither the raw value nor the escaped form the redactor knows.
 */
export function maskedJson(value: unknown, redact: (t: string) => string): string {
  return redact(JSON.stringify(maskStrings(value, redact)) ?? 'null')
}

function maskStrings(v: unknown, redact: (t: string) => string): unknown {
  if (typeof v === 'string') return redact(v)
  if (Array.isArray(v)) return v.map((x) => maskStrings(x, redact))
  if (v && typeof v === 'object') {
    const out = keyed()
    for (const [k, x] of Object.entries(v)) out[redact(k)] = maskStrings(x, redact)
    return out
  }
  return v
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = keyed()
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/**
 * An object to copy keys into with no prototype, so every key is kept as its own property. On a plain `{}`, a key
 * `__proto__` (an own key of parsed JSON, which an app's result or an agent's arguments can hold) went to the
 * prototype setter: `{"__proto__":{…},"isError":true}` was kept as `{"isError":true}`, and two manifests that differed
 * only under that key hashed the same (review of #1075).
 */
function keyed(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

/**
 * Arguments → what gets kept in the ledger. Summarized and hashed **after masking**: a hash is still
 * a trace of the input — the hash of an argument containing a short secret can be recovered by
 * brute-force lookup.
 */
export function describeArgs(args: unknown, redact: (t: string) => string): { json: string; digest: string; summary: string } {
  const json = maskedJson(sortKeys(args), redact)
  const digest = createHash('sha256').update(json).digest('hex')
  const summary = json.length > SUMMARY_CHARS ? `${json.slice(0, SUMMARY_CHARS)}…` : json
  return { json, digest, summary }
}
