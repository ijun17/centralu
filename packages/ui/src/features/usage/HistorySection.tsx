import { useEffect, useState } from 'react'
import type { ToolName, UsageHistory, UsageHistoryBy } from '@cc/protocol/client'
import { percentOf, topUsage } from '@cc/core'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { formatCount } from '../../app/format.js'
import { weeklySeries } from './weekly.js'

const DAY_MS = 24 * 3_600_000
const DAYS = 7
/** How many sessions or projects the list names */
const TOP = 5
/** What the list can be grouped by here: a model or a tool is one key per tool, not worth a list */
const GROUPS: { by: Extract<UsageHistoryBy, 'session' | 'project'>; label: string }[] = [
  { by: 'session', label: 'Sessions' },
  { by: 'project', label: 'Projects' },
]

/**
 * The last seven days, in the usage dropdown (docs/agent-host.md §6.2): the weekly window's percent over time, from the
 * readings the host stored, and the sessions or projects that used the most tokens with their cache hit rate.
 *
 * Asked once when the dropdown opens, and again when the list is regrouped. A host that predates the question (or a
 * failed one) leaves the section out: there is nothing to say, and the limits above it are not affected.
 */
export function HistorySection({
  tool,
  machine = null,
  canOpen,
  onOpen,
}: {
  tool: ToolName
  machine?: string | null
  /** Whether a session is on this screen to be opened */
  canOpen: (sessionId: string) => boolean
  onOpen: (sessionId: string) => void
}) {
  const platform = usePlatform()
  const [by, setBy] = useState<'session' | 'project'>('session')
  const [state, setState] = useState<{ from: number; to: number; history: UsageHistory } | null>(null)

  useEffect(() => {
    let alive = true
    const now = Date.now()
    const from = now - DAYS * DAY_MS
    const to = now + 3_600_000
    void platform.agents
      .usageHistory({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), groupBy: 'day', by, tool }, machine ?? undefined)
      .then((history) => alive && setState({ from, to, history }))
      .catch(() => alive && setState(null))
    return () => {
      alive = false
    }
  }, [platform, tool, machine, by])

  if (!state) return null
  return <HistoryView {...state} by={by} onBy={setBy} canOpen={canOpen} onOpen={onOpen} />
}

/** What the section shows for an answer; apart from the question so it can be drawn from an answer alone */
export function HistoryView({
  history,
  from,
  to,
  by,
  onBy,
  canOpen,
  onOpen,
}: {
  history: UsageHistory
  from: number
  to: number
  by: 'session' | 'project'
  onBy: (by: 'session' | 'project') => void
  canOpen: (sessionId: string) => boolean
  onOpen: (sessionId: string) => void
}) {
  const weekly = weeklySeries(history.readings)
  const top = topUsage(history.rows, TOP)
  const since = history.recordedSince ? Date.parse(history.recordedSince) : NaN

  return (
    <section className="mt-5 border-t border-line pt-3" data-testid="usage-history">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase text-ink-faint">Last {DAYS} days</span>
        <span className="ml-auto flex rounded-md border border-line p-px" role="group" aria-label="Group by">
          {GROUPS.map((g) => (
            <button
              key={g.by}
              type="button"
              aria-pressed={g.by === by}
              onClick={() => onBy(g.by)}
              data-testid={`usage-history-by-${g.by}`}
              className={`rounded px-1.5 text-2xs leading-body ${g.by === by ? 'bg-surface-hover text-ink' : 'text-ink-faint hover:text-ink-muted'}`}
            >
              {g.label}
            </button>
          ))}
        </span>
      </div>

      {weekly && <WeeklyLine series={weekly} from={from} to={to} />}

      {top.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted" data-testid="usage-history-empty">
          No model requests recorded in the last {DAYS} days
        </p>
      ) : (
        <ul className="mt-2 space-y-px" data-testid="usage-history-top">
          {top.map((t) => {
            const body = (
              <>
                <span className="truncate">{t.name}</span>
                <span className="readout ml-auto shrink-0 text-ink-faint">
                  {formatCount(t.tokens)}
                  {t.hitRate !== null && ` · ${percentOf(t.hitRate)}% hit`}
                </span>
              </>
            )
            const row = 'flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs'
            return (
              <li key={t.key}>
                {by === 'session' && canOpen(t.key) ? (
                  <button type="button" onClick={() => onOpen(t.key)} className={`${row} text-ink-muted hover:bg-surface-hover hover:text-ink`} data-testid={`usage-history-row-${t.key}`}>
                    {body}
                  </button>
                ) : (
                  <span className={`${row} text-ink-faint`} data-testid={`usage-history-row-${t.key}`}>
                    {body}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {Number.isFinite(since) && since > from && (
        <p className="mt-2 text-2xs text-ink-faint" data-testid="usage-history-since">
          Recorded on this computer since {new Date(since).toLocaleDateString()}; earlier days are not known.
        </p>
      )}
    </section>
  )
}

/**
 * The weekly window's percent against time, a step per reading: a reading holds until the next one, and the last one
 * to the right edge. Brightness, not hue (the screen's rule); the figure beside it is the latest reading, so the line
 * needs no axis to be read.
 */
function WeeklyLine({ series, from, to }: { series: NonNullable<ReturnType<typeof weeklySeries>>; from: number; to: number }) {
  const W = 200
  const H = 36
  const x = (t: number) => Math.max(0, Math.min(W, ((t - from) / (to - from)) * W)).toFixed(1)
  const y = (percent: number) => (H - (Math.max(0, Math.min(100, percent)) / 100) * H).toFixed(1)
  const points = series.points.map((p) => ({ t: Date.parse(p.at), percent: p.percent })).filter((p) => Number.isFinite(p.t))
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  const path = points.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p.percent)}` : `H${x(p.t)} V${y(p.percent)}`)).join(' ') + ` H${W}`
  const label = `${series.label}${series.scope ? ` · ${series.scope}` : ''}`
  // Less than a day of readings against a seven-day axis is a dot at the edge, not a line: the figure says it
  const drawn = to - first.t >= DAY_MS
  return (
    <div className="mt-2" data-testid="usage-history-weekly">
      <p className="flex items-baseline gap-2 text-xs">
        <span className="text-ink-muted">{label}</span>
        <span className="readout ml-auto text-ink">{last.percent}% now</span>
      </p>
      {drawn && (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 h-9 w-full text-ink-muted" role="img" aria-label={`${label} over the last ${DAYS} days`}>
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="currentColor" strokeWidth="1" className="text-line" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      )}
    </div>
  )
}
