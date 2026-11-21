import { useState } from 'react'
import { appKeyOf } from '@cc/core'
import { errorMessage, sameApp, type AgentUse, type AppPermission, type AppRun, type AppUsage } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { formatClock, formatCount, formatDuration } from '../../app/format.js'
import { appTitleOf } from '../../store/names.js'
import { isApp, useStore } from '../../store/store.js'
import { Badge } from '../../components/Badge.jsx'

/**
 * One app's run history (M4 B-7) beside the pinned view: the local half of "record who ran what" (A-6). View, agent
 * and brokered calls take one path and leave a row each. Re-read on open, on Refresh, and on each
 * `external_app_runs_changed` for a row here, which covers rejections, read-only calls and their chains;
 * `external_app_state_changed` skips read-only calls (#190). A failure gets a bright left line and its reason (the
 * palette rule). Chained rows (M4 D-6) indent under their cause; an agent's row offers Open session.
 */
/** `machine`: a linked machine's user-folder app (#82), whose runs, answers and agent use are that machine's */
export function RunsPanel({ appId, projectId, machine }: { appId: string; projectId: string | null; machine?: string | null }) {
  const platform = usePlatform()
  const changed = useStore((s) => s.externalAppRunChanges[appKeyOf(projectId, appId)] ?? 0)
  const sessions = useStore((s) => s.sessions)
  const apps = useStore((s) => s.externalApps)
  const focusSession = useStore((s) => s.focusSession)
  // Every time `changed` changes — a row visible in this panel was created or ended
  const read = useLoad(() => platform.apps.runs(appId, projectId, 100, machine), [platform, appId, projectId, machine], [changed])
  const runs = read.data ?? null
  const error = read.error
  const load = read.reload
  const nameOf = (r: AppRun) => appTitleOf(apps.find((a) => isApp(a, r.projectId, r.appId, machine)) ?? r)

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface-side" data-testid="runs-panel" aria-label="Runs">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <Badge readout>Runs</Badge>
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
        <Permissions appId={appId} projectId={projectId} machine={machine} changed={changed} />
        <AgentUseSection appId={appId} projectId={projectId} machine={machine} runs={runs} />
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
                own={sameApp(r, { appId, projectId })}
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
 * Remembered capability answers for this app (M4 D-4). Asked only when a `safe` session calls in (#2237); otherwise
 * the declared uses run unasked. A decline holds for every caller until Forget; forgetting an allow matters only to a
 * `safe` caller, asked again. An allow given against older `uses` shows "outdated"; a decline never does (this build's
 * host). Re-read on open, on history changes, on the view's question changing, and after Forget.
 */
function Permissions({ appId, projectId, machine, changed }: { appId: string; projectId: string | null; machine?: string | null; changed: number }) {
  const platform = usePlatform()
  const asked = useStore((s) => s.appQuestionsVersion)
  const setToast = useStore((s) => s.setToast)
  const [again, setAgain] = useState(0)
  // A failed read shows no section, as an empty one does: the runs below say when the host does not answer
  const list: AppPermission[] | undefined = useLoad(
    () => platform.apps.permissions(appId, projectId, machine),
    [platform, appId, projectId, machine],
    [changed, asked, again],
  ).data
  const forget = async (p: AppPermission) => {
    try {
      await platform.apps.forgetPermission(appId, projectId, p.capability, machine)
    } catch (e) {
      setToast(`Could not forget: ${errorMessage(e)}`)
    }
    setAgain((n) => n + 1)
  }
  if (!list || list.length === 0) return null
  return (
    <section className="border-b border-line px-3 py-2" data-testid="runs-permissions">
      <Badge as="p" readout>
        Permissions
      </Badge>
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
 * The agent usage this app asked for (M4 D-5): count, time and tokens over a day and 30 days, as it borrows the
 * person's agent; a looping app shows here first. Absent for an app that never asked. Re-read with `runs`.
 */
function AgentUseSection({ appId, projectId, machine, runs }: { appId: string; projectId: string | null; machine?: string | null; runs: AppRun[] | null }) {
  const platform = usePlatform()
  const use: AppUsage | undefined = useLoad(() => platform.apps.usage(appId, projectId, machine), [platform, appId, projectId, machine], [runs]).data
  if (!use || use.month.runs === 0) return null
  return (
    <section className="border-b border-line px-3 py-2" data-testid="runs-agent-use">
      <Badge as="p" readout>
        Agent use
      </Badge>
      <dl className="mt-1 space-y-0.5 text-xs">
        <UseLine label="24 h" use={use.day} testId="agent-use-day" />
        <UseLine label="30 days" use={use.month} testId="agent-use-month" />
      </dl>
    </section>
  )
}

function UseLine({ label, use, testId }: { label: string; use: AgentUse; testId: string }) {
  const parts = [`${use.runs} ${use.runs === 1 ? 'run' : 'runs'}`, formatDuration(use.durationMs)]
  if (use.tokens) parts.push(`${formatCount(use.tokens.input + use.tokens.output)} tokens`)
  return (
    <div className="flex items-baseline gap-2">
      <dt className="readout w-12 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 truncate text-ink-muted" data-testid={testId} title={use.tokens ? `in ${use.tokens.input} · out ${use.tokens.output}` : undefined}>
        {parts.join(' · ')}
      </dd>
    </div>
  )
}

/**
 * The history as a chain (M4 D-6), from the host's one newest-first list: a row goes under its listed parent, else at
 * the top. The top level is newest first; under a parent, in the order things happened, to read top to bottom.
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
    // Reversing the newest-first list puts rows sharing a timestamp back in order (the sort is stable)
    for (const c of [...(kids.get(r.id) ?? [])].reverse().sort((a, b) => a.createdAt - b.createdAt)) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  // A row whose parent is itself (never expected) is still kept
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
      className={`border-b border-l-2 border-line py-1.5 pr-3 text-xs ${failed ? 'border-l-ink' : 'border-l-transparent'}`}
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
          {formatClock(when, { seconds: true })}
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
            {formatCount(run.tokens.input + run.tokens.output)} tokens
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
        {/* Its session was deleted once the run ended cleanly (#378); what it did waits in the session archive */}
        {!onOpenSession && run.kept && (
          <span className="shrink-0 text-2xs text-ink-faint" data-testid="run-kept">
            in Settings → Archive
          </span>
        )}
        <span className="readout ml-auto shrink-0" data-testid="run-duration">
          {run.durationMs === null ? '…' : formatDuration(run.durationMs)}
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
