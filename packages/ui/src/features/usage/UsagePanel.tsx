import { useEffect, useState } from 'react'
import type { ToolName, UsageSnapshot, UsageWindow } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Tooltip } from '../../components/primitives.jsx'

/**
 * Usage (FR-9).
 *
 * **Only covers subscription limits** — additional paid credits are out of scope.
 *
 * The number and names of windows differ by tool (Claude has 5-hour plus weekly, Codex has one
 * weekly window). So the UI draws the array without knowing how many windows there are — a new
 * window appearing does not require a change here.
 */
export function UsagePanel({ tool }: { tool: ToolName }) {
  const platform = usePlatform()
  const [state, setState] = useState<{
    loading: boolean
    reason?: string
    usage: UsageSnapshot | null
  }>({ loading: true, usage: null })

  useEffect(() => {
    let alive = true
    setState({ loading: true, usage: null })
    void platform.agents
      .usage(tool)
      .then((r) => alive && setState({ loading: false, usage: r.usage, reason: r.supported ? undefined : r.reason }))
      .catch((e: Error) => alive && setState({ loading: false, usage: null, reason: e.message }))
    return () => {
      alive = false
    }
  }, [platform, tool])

  if (state.loading) {
    return (
      <p className="px-4 py-6 text-center text-[12px] text-slate" data-testid="usage-loading">
        Loading usage…
      </p>
    )
  }

  // Failing to read it and there being none are different — the reason is shown as is
  if (!state.usage || state.usage.windows.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-[12px] leading-relaxed text-ash" data-testid="usage-unavailable">
        Usage unavailable
        {state.reason && <span className="mt-1 block text-[11px] text-slate">{state.reason}</span>}
      </p>
    )
  }

  const { plan, windows, daily } = state.usage

  return (
    <div className="px-4 py-4" data-testid="usage-panel">
      {plan && (
        <p className="readout mb-3 text-[11px] text-slate" data-testid="usage-plan">
          {plan} plan
        </p>
      )}

      <div className="flex flex-wrap justify-center gap-6">
        {windows.map((w) => (
          <Donut key={`${w.id}-${w.scope ?? ''}`} window={w} />
        ))}
      </div>

      {/* Only some tools provide daily tokens (Codex does; Claude has no such window at all) */}
      {daily.length > 0 && <DailyTokens daily={daily} />}
    </div>
  )
}

/**
 * A donut.
 *
 * With no color to use, how full it is is expressed as brightness. The more dangerous, the
 * brighter it gets — the same grain as the rule that the brightest thing on screen is what is
 * waiting on me.
 */
function Donut({ window: w }: { window: UsageWindow }) {
  const R = 26
  const C = 2 * Math.PI * R
  const filled = (Math.max(0, Math.min(100, w.percent)) / 100) * C
  const tone = w.percent >= 90 ? 'text-beacon' : w.percent >= 70 ? 'text-chalk' : 'text-ash'

  return (
    <Tooltip
      testId={`usage-tip-${w.id}`}
      content={
        <span className="block">
          <span className="block text-chalk">
            {w.label}
            {w.scope && ` · ${w.scope}`}
          </span>
          <span className="readout mt-1 block">{w.percent}% used</span>
          <span className="readout block text-slate">{resetText(w.resetsAt)}</span>
        </span>
      }
    >
      <span className="flex flex-col items-center gap-1" data-testid={`usage-window-${w.id}`}>
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" strokeWidth="6" className="text-edge" />
          <circle
            cx="32"
            cy="32"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${C - filled}`}
            // Has to start at the 12 o'clock position to match the direction people read in
            transform="rotate(-90 32 32)"
            className={tone}
          />
        </svg>
        <span className={`readout text-[13px] leading-none ${tone}`}>{w.percent}%</span>
        {/*
          The model name **is written out** (user's observation, 2026-09-09). Before, when a
          scope existed, only a dangling "·" was shown and the name was left to the tooltip, so
          two 74% weekly donuts standing side by side gave no way to read on screen which was
          whose limit — that is what "per model seems to be missing" meant.
        */}
        <span className="max-w-[92px] truncate text-[10px] text-slate" title={w.scope ?? undefined}>
          {w.label}
          {w.scope ? ` · ${w.scope}` : ''}
        </span>
      </span>
    </Tooltip>
  )
}

/** Time remaining in human units — "how much is left" matters more than the exact moment */
function resetText(resetsAt: string | null): string {
  if (!resetsAt) return 'reset time unknown'
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (!Number.isFinite(ms)) return 'reset time unknown'
  if (ms <= 0) return 'resets soon'
  const min = Math.floor(ms / 60000)
  if (min < 60) return `resets in ${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `resets in ${hour}h ${min % 60}m`
  return `resets in ${Math.floor(hour / 24)}d ${hour % 24}h`
}

/** Daily tokens — only the most recent 7 days. Bar length is relative to that day's peak */
function DailyTokens({ daily }: { daily: { date: string; tokens: number }[] }) {
  const recent = daily.slice(-7)
  const peak = Math.max(...recent.map((d) => d.tokens), 1)
  const today = recent.at(-1)

  return (
    <section className="mt-5 border-t border-edge pt-3" data-testid="usage-daily">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase text-slate">Daily tokens</span>
        {today && (
          <span className="readout ml-auto text-[11px] text-chalk">Today {formatTokens(today.tokens)}</span>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {recent.map((d) => (
          <li key={d.date} className="flex items-center gap-2">
            <span className="readout w-12 shrink-0 text-[10px] text-slate">{d.date.slice(5)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-edge">
              <span
                className="block h-full rounded-full bg-ash"
                style={{ width: `${Math.round((d.tokens / peak) * 100)}%` }}
              />
            </span>
            <span className="readout w-14 shrink-0 text-right text-[10px] text-slate">
              {formatTokens(d.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}
