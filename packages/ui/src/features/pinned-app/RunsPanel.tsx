import { useCallback, useEffect, useState } from 'react'
import type { AgentUse, AppPermission, AppRun, AppUsage } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { externalAppKey, useStore } from '../../store/store.js'

/**
 * One app's run history (M4 B-7) — a panel that opens and closes beside the pinned view.
 *
 * This is where the local half of "record who ran what" (A-6) reaches the person's eyes. A call
 * from the view, a call from a session's agent, and a call brokered through another app all pass
 * through the same single path and each leave one row. Someone using the app can see "did what I
 * just pressed actually reach the app" and "what did the agent do with this app" without leaving
 * the app.
 *
 * When it re-reads: when the panel opens, every time a row visible in this panel is created, its
 * session continues, or it ends (the counter on `external_app_runs_changed`), and when the person
 * presses the button. The host emits that signal for every row in the record — a rejected call, a
 * read-only tool call, and the chain it starts too (an agent an app asked for can run for several
 * minutes). While this relied on the "changed" signal the view listens for (`external_app_state_changed`),
 * a chain started by a read-only tool call stayed invisible until Refresh was pressed: that signal
 * does not fire for a read-only tool call (#190), and re-reading every few seconds only ran while a
 * row the panel already held was still running.
 * A failure (the app answered with a failure, the host rejected it) is shown by a bright line on the
 * left of the row and one line stating the reason. Brightness belongs to whatever is blocked, exactly
 * the palette rule.
 *
 * The history is laid out as a chain (M4 D-6): a row for another app this app called, and a row for
 * something this app (or that app) asked Centralu for (an agent, another app, host data) is indented
 * under the row that caused it. A row where an agent was asked for lets a person jump to that session
 * (Open session).
 */
export function RunsPanel({ appId, projectId }: { appId: string; projectId: string | null }) {
  const platform = usePlatform()
  const changed = useStore((s) => s.externalAppRunChanges[externalAppKey(projectId, appId)] ?? 0)
  const sessions = useStore((s) => s.sessions)
  const apps = useStore((s) => s.externalApps)
  const focusSession = useStore((s) => s.focusSession)
  const [runs, setRuns] = useState<AppRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    let alive = true
    platform.apps
      .runs(appId, projectId, 100)
      .then((r) => {
        if (!alive) return
        setRuns(r)
        setError(null)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId])
  // Every time `changed` changes — a row visible in this panel was created or ended
  useEffect(() => load(), [load, changed])
  const nameOf = (r: AppRun) => apps.find((a) => a.appId === r.appId && a.projectId === r.projectId)?.name ?? r.appId

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface-side" data-testid="runs-panel" aria-label="Runs">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="readout text-2xs uppercase text-ink-faint">Runs</span>
        <button
          type="button"
          className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink"
          onClick={() => void load()}
          data-testid="runs-refresh"
        >
          Refresh
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Permissions appId={appId} projectId={projectId} changed={changed} />
        <AgentUseSection appId={appId} projectId={projectId} runs={runs} />
        {error && (
          <p className="px-3 py-2 text-xs text-ink-muted" role="alert">
            Could not read runs: {error}
          </p>
        )}
        {runs && runs.length === 0 && <p className="px-3 py-3 text-xs text-ink-faint">No runs yet.</p>}
        <ol>
          {runs &&
            chainRuns(runs).map(({ run: r, depth }) => (
              <RunRow
                key={r.id}
                run={r}
                depth={depth}
                own={r.appId === appId && r.projectId === projectId}
                appName={nameOf(r)}
                sessionName={r.callerSessionId ? sessions[r.callerSessionId]?.name : undefined}
                onOpenSession={r.sessionId && sessions[r.sessionId] ? () => focusSession(r.sessionId) : undefined}
              />
            ))}
        </ol>
      </div>
    </aside>
  )
}

/**
 * The remembered answers to capability questions for this app (M4 D-4) — an answer the person gave
 * once stays here. A decline pressed by mistake, or a grant now worth taking back, is forgotten from
 * here (Forget). Forgetting it means it is asked again the next time that capability is needed. An
 * old answer no longer applies once the manifest's `uses` has changed — it shows as "outdated."
 *
 * When it re-reads: when the panel opens, when this panel's history changes (an answered request's
 * row soon either continues into a session or ends as a decline), when the view's question changes,
 * and after forgetting one.
 */
function Permissions({ appId, projectId, changed }: { appId: string; projectId: string | null; changed: number }) {
  const platform = usePlatform()
  const asked = useStore((s) => s.appQuestionsVersion)
  const setToast = useStore((s) => s.setToast)
  const [list, setList] = useState<AppPermission[] | null>(null)
  const [again, setAgain] = useState(0)
  useEffect(() => {
    let alive = true
    platform.apps
      .permissions(appId, projectId)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, changed, asked, again])
  const forget = async (p: AppPermission) => {
    try {
      await platform.apps.forgetPermission(appId, projectId, p.capability)
    } catch (e) {
      setToast(`Could not forget: ${(e as Error).message}`)
    }
    setAgain((n) => n + 1)
  }
  if (!list || list.length === 0) return null
  return (
    <section className="border-b border-line px-3 py-2" data-testid="runs-permissions">
      <p className="readout text-2xs uppercase text-ink-faint">Permissions</p>
      <ul className="mt-1 space-y-1">
        {list.map((p) => (
          <li key={p.capability} className="flex items-baseline gap-2 text-xs" data-testid="permission-row" data-capability={p.capability} data-decision={p.decision}>
            <span className={`min-w-0 flex-1 break-words ${p.current ? 'text-ink-muted' : 'text-ink-faint line-through'}`} title={p.capability}>
              {p.text}
            </span>
            <span className={`readout shrink-0 ${p.decision === 'deny' ? 'text-ink' : 'text-ink-faint'}`} data-testid="permission-decision">
              {p.current ? (p.decision === 'allow' ? 'allowed' : 'denied') : 'outdated'}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md px-1 text-2xs text-ink-faint transition-colors hover:text-ink"
              onClick={() => void forget(p)}
              data-testid="permission-forget"
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The agent usage this app has asked for (M4 D-5) — how many times, how long, and how many tokens,
 * over the last day and the last 30 days. An app borrows the person's own agent to use — its share
 * is shown here per app. An app stuck in a loop is what this number states first. It does not appear
 * at all for an app that has never asked for an agent.
 *
 * When it re-reads: every time the history is re-read (`runs` changes) — usage changes as soon as an
 * agent's row ends.
 */
function AgentUseSection({ appId, projectId, runs }: { appId: string; projectId: string | null; runs: AppRun[] | null }) {
  const platform = usePlatform()
  const [use, setUse] = useState<AppUsage | null>(null)
  useEffect(() => {
    let alive = true
    platform.apps
      .usage(appId, projectId)
      .then((u) => alive && setUse(u))
      .catch(() => alive && setUse(null))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, runs])
  if (!use || use.month.runs === 0) return null
  return (
    <section className="border-b border-line px-3 py-2" data-testid="runs-agent-use">
      <p className="readout text-2xs uppercase text-ink-faint">Agent use</p>
      <dl className="mt-1 space-y-0.5 text-xs">
        <UseLine label="24 h" use={use.day} testId="agent-use-day" />
        <UseLine label="30 days" use={use.month} testId="agent-use-month" />
      </dl>
    </section>
  )
}

function UseLine({ label, use, testId }: { label: string; use: AgentUse; testId: string }) {
  const parts = [`${use.runs} ${use.runs === 1 ? 'run' : 'runs'}`, longDuration(use.durationMs)]
  if (use.tokens) parts.push(`${tokenCount(use.tokens.input + use.tokens.output)} tokens`)
  return (
    <div className="flex items-baseline gap-2">
      <dt className="readout w-12 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 truncate text-ink-muted" data-testid={testId} title={use.tokens ? `in ${use.tokens.input} · out ${use.tokens.output}` : undefined}>
        {parts.join(' · ')}
      </dd>
    </div>
  )
}

/** A summed duration — "42 s", "3m 20s", "2h 5m" */
function longDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** A token count — "850", "12.4k", "3.1M" */
function tokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * Lays the history out as a chain (M4 D-6) — the host provides this app's rows and the chain below
 * them as one list (newest first). A row whose parent is in the list is placed right under that
 * parent; the rest go at the top level. The top level is newest first, but under one parent it is
 * **in the order things happened** — what happens inside one call has to read top to bottom.
 * Indentation depth is provided along with each row.
 */
export function chainRuns(runs: AppRun[]): { run: AppRun; depth: number }[] {
  const ids = new Set(runs.map((r) => r.id))
  const kids = new Map<string, AppRun[]>()
  const roots: AppRun[] = []
  for (const r of runs) {
    if (r.parentRunId && r.parentRunId !== r.id && ids.has(r.parentRunId)) kids.set(r.parentRunId, [...(kids.get(r.parentRunId) ?? []), r])
    else roots.push(r)
  }
  const out: { run: AppRun; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (r: AppRun, depth: number) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({ run: r, depth })
    // The received list is newest first — reversing it puts even rows sharing a timestamp back in the order they happened (the sort is stable)
    for (const c of [...(kids.get(r.id) ?? [])].reverse().sort((a, b) => a.createdAt - b.createdAt)) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  // Even a row whose parent points at itself (should never happen, but) is not dropped
  for (const r of runs) walk(r, 0)
  return out
}

/** The outcome as a person reads it — the record's word (`rejected`) and the view's word (refused) are the same thing */
const STATUS: Record<AppRun['status'], string> = {
  running: 'running',
  ok: 'ok',
  error: 'failed',
  rejected: 'refused',
  cancelled: 'cancelled',
}

const CALLER: Record<AppRun['callerKind'], string> = { view: 'View', session: 'Session', app: 'App' }

function duration(ms: number | null): string {
  if (ms === null) return '…'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function RunRow({
  run,
  depth,
  own,
  appName,
  sessionName,
  onOpenSession,
}: {
  run: AppRun
  /** Depth within the chain — 0 is the top level */
  depth: number
  /** Is this a row of this panel's own app — otherwise it is another app's row further down the chain */
  own: boolean
  appName: string
  sessionName: string | undefined
  /** Jumps to the agent session this row created — only when the session still exists */
  onOpenSession: (() => void) | undefined
}) {
  const failed = run.status === 'error' || run.status === 'rejected'
  const when = new Date(run.createdAt)
  // A broker row is something an app asked Centralu for — it states the app that asked, not the caller
  const broker = run.kind === 'broker'
  const caller = broker
    ? `Asked by ${appName}`
    : run.callerKind === 'session' && sessionName
      ? `${CALLER.session} · ${sessionName}`
      : CALLER[run.callerKind]
  const tool = !broker && !own ? `${appName} · ${run.tool}` : run.tool
  return (
    <li
      className={`border-b border-l-2 border-line/60 py-1.5 pr-3 text-xs ${failed ? 'border-l-ink' : 'border-l-transparent'}`}
      style={{ paddingLeft: 12 + depth * 14 }}
      data-testid="run-row"
      data-status={run.status}
      data-failed={failed || undefined}
      data-kind={run.kind ?? 'tool'}
      data-depth={depth}
    >
      <div className="flex items-baseline gap-2">
        {depth > 0 && (
          <span className="-ml-3 w-2 shrink-0 text-ink-faint" aria-hidden="true">
            ↳
          </span>
        )}
        <time className="readout shrink-0 text-ink-faint" dateTime={when.toISOString()} data-testid="run-time">
          {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </time>
        <span className="min-w-0 truncate font-mono text-ink" data-testid="run-tool">
          {tool}
        </span>
        <span className={`readout ml-auto shrink-0 ${failed ? 'text-ink' : 'text-ink-faint'}`} data-testid="run-status">
          {STATUS[run.status]}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 text-ink-faint">
        <span className="truncate" data-testid="run-caller">
          {caller}
        </span>
        {run.tokens && (
          <span className="readout shrink-0" data-testid="run-tokens" title={`in ${run.tokens.input} · out ${run.tokens.output}`}>
            {tokenCount(run.tokens.input + run.tokens.output)} tokens
          </span>
        )}
        {onOpenSession && (
          <button
            type="button"
            className="shrink-0 rounded-md px-1 text-2xs text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
            onClick={onOpenSession}
            data-testid="run-open-session"
          >
            Open session
          </button>
        )}
        <span className="readout ml-auto shrink-0" data-testid="run-duration">
          {duration(run.durationMs)}
        </span>
      </div>
      {failed && run.error && (
        <p className="mt-0.5 line-clamp-2 break-words text-ink-muted" title={run.error} data-testid="run-error">
          {run.error}
        </p>
      )}
    </li>
  )
}
