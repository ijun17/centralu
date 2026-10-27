import { useCallback } from 'react'
import { useLabelNow } from '../../app/useLabelNow.js'
import { nextResetTick } from '../../app/labelClock.js'
import type { CacheStats, ToolName, UsageSnapshot, UsageWindow } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Tooltip } from '../../components/primitives.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { useStore } from '../../store/store.js'
import { useMachineName, useToolMeta } from '../../store/selectors.js'
import { CacheSection } from './CacheSection.jsx'
import { formatCount, formatDuration, formatReadAt } from '../../app/format.js'
import { HistorySection } from './HistorySection.jsx'
import { SAME_ACCOUNT_LABEL } from './sameAccount.js'
import { useLoad } from '../../app/useLoad.js'

/**
 * Usage (FR-9).
 *
 * **Only covers subscription limits** — additional paid credits are out of scope.
 *
 * The number and names of windows differ by tool (Claude has 5-hour plus weekly, Codex has one
 * weekly window). So the UI draws the array without knowing how many windows there are — a new
 * window appearing does not require a change here.
 */
export function UsagePanel({ tool, machine = null }: { tool: ToolName; /** A linked machine's limits (#82); null for this computer */ machine?: string | null }) {
  const platform = usePlatform()
  const meta = useToolMeta(tool)
  /*
   * A session the cache section names opens like a sidebar row, and the dropdown closes: the person asked "which
   * session", and the answer is that session on screen.
   */
  const focusSession = useStore((s) => s.focusSession)
  const toggleUsage = useStore((s) => s.toggleUsage)
  const openSession = (id: string) => {
    toggleUsage(false)
    focusSession(id)
  }

  const read = useLoad(() => platform.agents.usage(tool, machine ?? undefined), [platform, tool, machine])
  /*
   * A tool whose own command is slower than the host waits answers `provisional` (#1623). The panel asks once more, to
   * settle: that one call returns when the command ends, so the plan or the totals arrive on the open panel, and nothing
   * polls. It is asked once and never again (an answer that is still provisional stands), so a host that ignores it cannot
   * make a loop.
   */
  const provisional = read.data?.provisional === true
  const settled = useLoad(() => (provisional ? platform.agents.usage(tool, machine ?? undefined, { settle: true }) : null), [platform, tool, machine, provisional])
  const r = settled.data ?? read.data
  const state: { usage: UsageSnapshot | null; reason?: string; cache?: CacheStats; sameAccount?: boolean; notReported?: boolean } = r
    ? {
        usage: r.usage,
        reason: r.supported ? undefined : r.reason,
        cache: r.cache,
        sameAccount: r.sameAccountAsHub,
        notReported: !r.supported && r.notReported === true,
      }
    : { usage: null, reason: read.error ?? undefined }

  if (r === undefined && read.error === null) {
    return (
      <SkeletonLines lines={4} className="px-4 py-6" label="Loading usage" testId="usage-loading" />
    )
  }

  // What the host counted stands apart from the limits: a limit the tool would not tell does not hide it
  const cache = state.cache && (
    <CacheSection cache={state.cache} toolLabel={meta.label} canOpen={(id) => id in useStore.getState().sessions} onOpen={openSession} />
  )

  // What the host stored over the last days (§6.2): independent of the limits too, and absent from a host that predates it
  const history = <HistorySection tool={tool} machine={machine} canOpen={(id) => id in useStore.getState().sessions} onOpen={openSession} />

  /*
   * A tool with no limits to report (#1623, owner 2026-10-26) is not "unavailable": nothing is wrong and nothing is to be
   * done, and the panel says so in plain words. What the tool does say stands under it: its plan, and what it counted on this
   * computer, labelled as totals and not a limit. A failed read (no `notReported`) is still the reason as it is.
   */
  if (state.notReported) {
    return (
      <>
        <NotReported label={meta.label} usage={state.usage} machine={machine} />
        {cache && <div className="px-4 pb-4 [&>section]:mt-0">{cache}</div>}
        <div className="px-4 pb-4 [&>section:first-child]:mt-0">{history}</div>
      </>
    )
  }

  // Failing to read it and there being none are different — the reason is shown as is
  if (!state.usage || state.usage.windows.length === 0) {
    return (
      <>
        <p className="px-4 py-6 text-center text-sm leading-body text-ink-muted" data-testid="usage-unavailable">
          Usage unavailable
          {state.reason && <span className="mt-1 block text-xs text-ink-faint">{state.reason}</span>}
        </p>
        {cache && <div className="px-4 pb-4 [&>section]:mt-0">{cache}</div>}
        <div className="px-4 pb-4 [&>section:first-child]:mt-0">{history}</div>
      </>
    )
  }

  const { plan, windows, daily } = state.usage

  return (
    <div className="px-4 py-4" data-testid="usage-panel">
      {plan && (
        <p className="readout mb-3 text-xs text-ink-faint" data-testid="usage-plan">
          {plan} plan
        </p>
      )}
      {/* A linked machine's limits that are this computer's, because one account is signed in to both (#726) */}
      {state.sameAccount && (
        <p className="mb-3 text-xs text-ink-faint" data-testid="usage-same-account">
          {SAME_ACCOUNT_LABEL}
        </p>
      )}

      <div className="flex flex-wrap justify-center gap-6">
        {windows.map((w) => (
          <Donut key={`${w.id}-${w.scope ?? ''}`} window={w} />
        ))}
      </div>

      {/* Only some tools provide daily tokens (Codex does; Claude has no such window at all) */}
      {daily.length > 0 && <DailyTokens daily={daily} />}
      {cache}
      {history}
    </div>
  )
}

/** The words of the panel for a tool that reports no limits (#1623): the exact copy the owner confirms */
export const NOT_REPORTED_COPY = {
  title: (tool: string) => `${tool} does not report usage limits.`,
  plan: (plan: string) => `${plan} plan`,
  totalsTitle: (scope: string) => `Local totals · ${scope}`,
  totalsNote: (tool: string, where: string) => `Counted by ${tool} on ${where}. These are totals, not a limit.`,
  totalsAsOf: (at: number, now: number) => `As of ${formatReadAt(at, now)}`,
}

/**
 * How a total is written: tokens as the daily tokens are (abbreviated), dollars with their cents, and the whole-number counts
 * (sessions, messages) exactly, with the thousands separators of the person's language
 */
function totalText(value: number | null, unit: 'count' | 'tokens' | 'usd'): string {
  // The tool printed it in a form that could not be read: a dash, never a number that may be wrong
  if (value === null) return '—'
  return unit === 'usd' ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : unit === 'count' ? value.toLocaleString() : formatCount(value)
}

function NotReported({ label, usage, machine }: { label: string; usage: UsageSnapshot | null; machine: string | null }) {
  const totals = usage?.totals
  // The totals are what that machine counted: the words say where, as the dropdown's header does
  const machineName = useMachineName(machine)
  return (
    <div className="px-4 py-6" data-testid="usage-not-reported">
      {/* Each part fades in as it arrives: the plan or the totals may come after the words, when the command was slow. The totals are keyed by the read, so new ones landing on the open panel (a settle) fade in as a whole, rows and time together, and do not jump */}
      <p className="cc-row-in text-center text-sm leading-body text-ink-muted" data-testid="usage-not-reported-text">
        {NOT_REPORTED_COPY.title(label)}
      </p>
      {usage?.plan && (
        <p className="cc-row-in mt-4 text-center text-xs text-ink" data-testid="usage-plan">
          {NOT_REPORTED_COPY.plan(usage.plan)}
        </p>
      )}
      {totals && totals.rows.length > 0 && (
        <section key={totals.asOf ?? 'unread'} className="cc-row-in mt-5 border-t border-line pt-3" data-testid="usage-totals">
          <span className="text-xs uppercase text-ink-faint">{NOT_REPORTED_COPY.totalsTitle(totals.scope)}</span>
          <ul className="mt-2 space-y-1">
            {totals.rows.map((row) => (
              <li key={row.id} className="flex items-baseline gap-2" data-testid={`usage-total-${row.id}`}>
                <span className="text-xs text-ink-muted">{row.label}</span>
                <span className="readout ml-auto text-xs text-ink" data-unread={row.value === null ? '' : undefined}>
                  {totalText(row.value, row.unit)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-ink-faint">{NOT_REPORTED_COPY.totalsNote(label, machineName ?? 'this computer')}</p>
          {totals.asOf !== undefined && (
            <p className="mt-1 text-2xs text-ink-faint" data-testid="usage-totals-as-of">
              {NOT_REPORTED_COPY.totalsAsOf(totals.asOf, Date.now())}
            </p>
          )}
        </section>
      )}
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
  const tone = w.percent >= 90 ? 'text-ink-signal' : w.percent >= 70 ? 'text-ink' : 'text-ink-muted'

  return (
    <Tooltip
      testId={`usage-tip-${w.id}`}
      content={
        <span className="block">
          <span className="block text-ink">
            {w.label}
            {w.scope && ` · ${w.scope}`}
          </span>
          <span className="readout mt-1 block">{w.percent}% used</span>
          <span className="readout block text-ink-faint">
            <ResetTime resetsAt={w.resetsAt} />
          </span>
        </span>
      }
    >
      <span className="flex flex-col items-center gap-1" data-testid={`usage-window-${w.id}`}>
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" strokeWidth="6" className="text-line" />
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
        <span className={`readout text-md leading-none ${tone}`}>{w.percent}%</span>
        {/*
          The model name **is written out** (user's observation, 2026-09-09). Before, when a
          scope existed, only a dangling "·" was shown and the name was left to the tooltip, so
          two 74% weekly donuts standing side by side gave no way to read on screen which was
          whose limit — that is what "per model seems to be missing" meant.
        */}
        <span className="max-w-[92px] truncate text-2xs text-ink-faint" title={w.scope ?? undefined}>
          {w.label}
          {w.scope ? ` · ${w.scope}` : ''}
        </span>
      </span>
    </Tooltip>
  )
}

function ResetTime({ resetsAt }: { resetsAt: string | null }) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  const next = useCallback((now: number) => nextResetTick(at, now), [at])
  const now = useLabelNow(Number.isFinite(at) ? next : null)
  return <>{resetText(resetsAt, now)}</>
}

/** Time remaining in human units — "how much is left" matters more than the exact moment */
function resetText(resetsAt: string | null, now: number): string {
  if (!resetsAt) return 'reset time unknown'
  const ms = new Date(resetsAt).getTime() - now
  if (!Number.isFinite(ms)) return 'reset time unknown'
  if (ms <= 0) return 'resets soon'
  return `resets in ${formatDuration(ms, { coarse: true })}`
}

/** Daily tokens — only the most recent 7 days. Bar length is relative to that day's peak */
function DailyTokens({ daily }: { daily: { date: string; tokens: number }[] }) {
  const recent = daily.slice(-7)
  const peak = Math.max(...recent.map((d) => d.tokens), 1)
  const today = recent.at(-1)

  return (
    <section className="mt-5 border-t border-line pt-3" data-testid="usage-daily">
      <div className="flex items-baseline gap-2">
        <span className="text-xs uppercase text-ink-faint">Daily tokens</span>
        {today && (
          <span className="readout ml-auto text-xs text-ink">Today {formatCount(today.tokens)}</span>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {recent.map((d) => (
          <li key={d.date} className="flex items-center gap-2">
            <span className="readout w-12 shrink-0 text-2xs text-ink-faint">{d.date.slice(5)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <span
                className="block h-full rounded-full bg-ink-muted"
                style={{ width: `${Math.round((d.tokens / peak) * 100)}%` }}
              />
            </span>
            <span className="readout w-14 shrink-0 text-right text-2xs text-ink-faint">
              {formatCount(d.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

