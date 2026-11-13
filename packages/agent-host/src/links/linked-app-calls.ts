import { appKeyOf, sameApp, type ExternalAppInfo, type LinkedApp, type LinkedAppCallParams, type LinkedAppCallResult } from '@cc/protocol'
import type { AppCallOutcome, AppRef, ExternalApps } from '../apps/external/runtime.js'
import { DETACHED_KEEP_MS, RUN_STATUS_TOOL, TOOL_LIST_WAIT_MS } from '../sessions/app-call-bounds.js'
import { isObj } from '../json-value.js'
import { raceTimeout } from '../timing.js'
import { qualify } from './machine-ids.js'

/**
 * The app's host answering a session of a linked host (#1938, docs/plans/remote-hub.md §13.3, §13.4): `host.apps` /
 * `host.appCall` / `host.appCancel` on a machine, from its hub, and `hub.apps` / `hub.appCall` / `hub.appCancel` on a hub,
 * from a machine. One answerer for both directions; what differs is who may reach what (`reach`), which each side decides.
 *
 *   - **The other side is the link's.** `from` is the host at the other end of the connection the call came on, never
 *     a field of the call, and the session is qualified by it (`<from>.<session>`), so a host names only its own sessions.
 *   - **Every call goes through `ExternalApps.call`**, as a call of a session here does: visibility, the run id, the run row
 *     (`callerKind: 'session'` with the qualified id), cancellation and the app's own gates happen once, there. The
 *     calling session's approval was its own host's (§13.4): this side decides only whether that session may reach this
 *     app, read again at every list and every call.
 *   - **A call outlives its wait.** The caller says how long it waits (`waitMs`); past it the answer is `running` with the
 *     run id, and the run carries on. The same call id asked again waits on the same run, so a resend after a dropped link
 *     never runs it twice. `run_status` is answered from the outcomes kept here, then from the app's run rows.
 *   - A call from elsewhere has no preset here, so the app's own agent and capability questions treat it as `safe` (the
 *     default of `appAgentPreset`), and a question the app raises stands on the app's row (`askCapability`).
 */

/** The host at the other end of the link a call came on */
export type LinkedCaller = { id: string; name: string }

export type LinkedAppCallsDeps = {
  rt: Pick<ExternalApps, 'list' | 'knownTools' | 'tools' | 'call' | 'runs'>
  /** Whether this session of the other side may reach this app now; the app is usable and in a trusted project already */
  reach(from: LinkedCaller, session: string, app: ExternalAppInfo): boolean
  /** Why nothing here is offered to this session, said to its agent; null when it may reach some apps */
  refusal(from: LinkedCaller, session: string): string | null
  projectName(projectId: string): string
}

/** An app that cannot run now is not offered, as for a session here (session-apps.ts `UNUSABLE`) */
const UNUSABLE = new Set(['invalid', 'untrusted', 'unconfirmed', 'failed'])
const RUN_STATUSES = ['ok', 'error', 'cancelled', 'rejected', 'running'] as const
/** The calls kept after they ended, per link, for `run_status` and a resend */
const KEPT_PER_LINK = 200

type Open = { from: string; session: string; runId: string; started: number; outcome: Promise<AppCallOutcome>; done: AppCallOutcome | null; abort: AbortController }

export class LinkedAppCalls {
  /** `<from>\0<call id>` → the call */
  private calls = new Map<string, Open>()
  /** `<from>\0<call id>` → when a cancel came for a call not here (yet) */
  private withdrawn = new Map<string, number>()

  constructor(private readonly deps: LinkedAppCallsDeps) {}

  /**
   * The apps this session of the other side may reach here, each with the tools its agent would get. `start`: that one is
   * started first, within the bound a session here waits for a list, if it has not listed its tools since this host started
   */
  async list(from: LinkedCaller, session: string, start?: AppRef): Promise<LinkedApp[]> {
    if (this.deps.refusal(from, session)) return []
    const first = start ? this.reachable(from, session).find((a) => sameApp(a, start)) : undefined
    if (first && start && !this.deps.rt.knownTools(start, 'model')) await raceTimeout(this.deps.rt.tools(start, 'model').catch(() => []), TOOL_LIST_WAIT_MS, null)
    return this.reachable(from, session).flatMap((a) => {
      if (a.projectId === null) return []
      const ref = { projectId: a.projectId, appId: a.appId }
      const known = this.deps.rt.knownTools(ref, 'model')
      // Cut to what the caller's schema takes (protocol/src/linked-apps.ts), so one long word never makes the whole list unreadable
      return {
        projectId: ref.projectId,
        project: this.deps.projectName(ref.projectId).slice(0, 500),
        appId: a.appId,
        name: (a.name ?? a.appId).slice(0, 500),
        description: (a.description ?? '').slice(0, 4000),
        ...(a.root === true ? { root: true } : {}),
        tools: known
          ? known
              .filter((t) => t.name.length <= 200)
              .slice(0, 500)
              .map(({ name, title, description, inputSchema, annotations }) => ({
                name,
                ...(title !== undefined ? { title: title.slice(0, 500) } : {}),
                ...(description !== undefined ? { description: description.slice(0, 20_000) } : {}),
                inputSchema,
                ...(annotations ? { annotations } : {}),
              }))
          : null,
      }
    })
  }

  /** One call: started, or the one under this id joined, and answered by the caller's wait */
  async call(from: LinkedCaller, p: LinkedAppCallParams): Promise<LinkedAppCallResult> {
    const key = `${from.id}\0${p.call}`
    // Withdrawn before it arrived (the cancel overtook the call): it never starts
    if (this.withdrawn.has(key)) return { status: 'cancelled', runId: '', result: null, error: 'The call was cancelled', durationMs: 0 }
    let open = this.calls.get(key)
    if (open && open.session !== p.session) return rejected('That call id is another session\'s. Nothing ran.')
    if (!open) {
      const ref: AppRef = { projectId: p.projectId, appId: p.appId }
      const refused = this.deps.refusal(from, p.session)
      const app = refused ? undefined : this.reachable(from, p.session).find((a) => sameApp(a, ref))
      if (!app) return rejected(refused ?? `${from.name} cannot use that app of this computer now: it is not shared, its project is not trusted, or it is gone. Nothing ran.`)
      if (p.tool === RUN_STATUS_TOOL) return this.runStatus(from, p.session, ref, p.args)
      open = this.start(key, from, p, ref)
    }
    const first = await raceTimeout(open.outcome.then((o) => ({ o })), p.waitMs, null)
    if (first) return wire(first.o)
    return { status: 'running', runId: open.runId, result: null, error: null, durationMs: Date.now() - open.started }
  }

  /** The caller withdrew the call: its run here is cancelled. One that ended stays recorded */
  cancel(from: LinkedCaller, call: string): void {
    const key = `${from.id}\0${call}`
    const open = this.calls.get(key)
    if (open) return open.abort.abort()
    // Not here yet: kept, so the call that is still on its way never starts
    this.withdrawn.set(key, Date.now())
    for (const [k, at] of this.withdrawn) if (Date.now() - at > DETACHED_KEEP_MS || this.withdrawn.size > KEPT_PER_LINK) this.withdrawn.delete(k)
  }

  private reachable(from: LinkedCaller, session: string): ExternalAppInfo[] {
    return this.deps.rt
      .list()
      .filter((a) => a.projectId !== null && !UNUSABLE.has(a.status) && this.deps.reach(from, session, a))
      .sort((x, y) => appKeyOf(x).localeCompare(appKeyOf(y)))
  }

  private start(key: string, from: LinkedCaller, p: LinkedAppCallParams, ref: AppRef): Open {
    this.prune(from.id)
    const abort = new AbortController()
    let runId = ''
    const outcome = this.deps.rt
      .call(ref, p.tool, p.args, { kind: 'session', sessionId: qualify(from.id, p.session) }, { signal: abort.signal, onRun: (id) => (runId = id), ...(p.notListed ? { notListed: true as const } : {}) })
      .catch((err: Error): AppCallOutcome => ({ runId, status: 'error', result: null, error: err.message, durationMs: 0 }))
    const open: Open = { from: from.id, session: p.session, runId, started: Date.now(), outcome, done: null, abort }
    // The run id is decided synchronously as the call starts (`AppCalls.call`)
    open.runId = runId
    void outcome.then((o) => (open.done = o))
    this.calls.set(key, open)
    return open
  }

  /** A run of this session on this app: its outcome while it is kept here, else what its row says */
  private runStatus(from: LinkedCaller, session: string, ref: AppRef, args: Record<string, unknown>): LinkedAppCallResult {
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
    if (!runId) return rejected(`${RUN_STATUS_TOOL} needs a run_id`)
    const kept = [...this.calls.values()].find((c) => c.from === from.id && c.session === session && c.runId === runId)
    if (kept?.done) return wire(kept.done)
    if (kept) return { status: 'running', runId, result: null, error: null, durationMs: Date.now() - kept.started }
    const caller = qualify(from.id, session)
    const row = this.deps.rt.runs(ref, 500).find((r) => r.id === runId && r.callerKind === 'session' && r.callerSessionId === caller)
    if (!row) return rejected(`Unknown run id: ${runId} — a session can see only the runs it started on this app`)
    const status = RUN_STATUSES.find((s) => s === row.status) ?? 'error'
    return { status, runId, result: null, error: row.error ?? (status === 'running' ? null : 'its result is no longer kept'), durationMs: 0 }
  }

  /** Ended calls past their keeping, and the oldest past the cap, go; a call still running stays */
  private prune(from: string): void {
    const now = Date.now()
    const ended = [...this.calls].filter(([, c]) => c.from === from && c.done)
    for (const [key, c] of ended) if (now - c.started > DETACHED_KEEP_MS) this.calls.delete(key)
    const left = ended.filter(([key]) => this.calls.has(key))
    for (const [key] of left.slice(0, Math.max(0, left.length - KEPT_PER_LINK + 1))) this.calls.delete(key)
  }
}

/** An outcome as it crosses the link */
function wire(o: AppCallOutcome): LinkedAppCallResult {
  const r = o.result
  return {
    status: o.status,
    runId: o.runId,
    result: r ? { content: r.content, ...(isObj(r.structuredContent) ? { structuredContent: r.structuredContent } : {}), ...(r.isError !== undefined ? { isError: r.isError } : {}) } : null,
    error: o.error === null ? null : o.error.slice(0, 20_000),
    durationMs: o.durationMs,
  }
}

function rejected(error: string): LinkedAppCallResult {
  return { status: 'rejected', runId: '', result: null, error, durationMs: 0 }
}
