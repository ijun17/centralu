import { useCallback, useEffect, useState } from 'react'
import type { ToolName, UsageSnapshot } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, usageTools } from '../../store/store.js'
import { useToolMeta, useTools } from '../../store/selectors.js'
import { Tooltip } from '../../components/primitives.jsx'
import { UsagePanel } from './UsagePanel.jsx'
import { usageTone, weeklyWindow } from './weekly.js'

/**
 * Usage in the top bar — **one weekly donut per tool** (user request, 2026-09-09).
 *
 * It used to be a single text button labeled 'Usage', which opened a modal in the middle of the
 * screen on click. Two things about that fell short: (1) with no number on the dashboard, the
 * limit was something the person had to **ask** in order to know; (2) the place the answer
 * opened in was far from where they clicked.
 *
 * Now the donut lives on the dashboard permanently — how full it is shows as brightness, and the
 * center holds **that tool's single-letter mark** (the same letter as the sidebar session chip,
 * so which limit belongs to which tool reads without a legend). The detail drops down **directly
 * below** that donut.
 *
 * Why only the weekly window is put forward: the dashboard is a glance-read surface, and the
 * 5-hour window recovers quickly and does not say "is this urgent right now." Every other window
 * lives in the detail view.
 */
export function UsageDonuts() {
  const platform = usePlatform()
  const usageOpen = useStore((s) => s.usageOpen)
  const toggleUsage = useStore((s) => s.toggleUsage)
  /**
   * The host connection (user request, 2026-09-09: "if the host does not come up, put
   * Disconnected where the donut goes").
   *
   * Agents live inside the host — without a connection, there is no way at all to ask about a
   * tool. So this single spot says **one of two things**: a limit (a donut), or the fact that a
   * limit cannot be asked for. Leaving it empty would read as "there are no tools at all," which
   * is not true — it is **unknown**.
   */
  const connection = useStore((s) => s.connection)
  const offline = connection !== 'connected'
  const [snap, setSnap] = useState<Partial<Record<ToolName, { usage: UsageSnapshot | null; reason?: string }>>>({})
  const [open, setOpen] = useState<ToolName | null>(null)
  const tools = useTools()
  // A hook cannot be called conditionally — the value is unused anyway while closed
  const openMeta = useToolMeta(open ?? '')
  /**
   * The tools a donut gets put up for (user request, 2026-09-09: "only connected agents should
   * get a donut").
   *
   * **A limit for a tool that is not there has no place on the dashboard** — an empty ring for
   * an unused tool says nothing while still taking up eye space. The check is
   * installed-and-logged-in (detect), the same check the new-session window uses: two screens
   * must never answer "can this tool be used" differently.
   *
   * null means "not asked yet" — nothing is drawn in the meantime. Putting up a donut and then
   * removing it before the first answer arrives would make the bar flicker.
   */
  const [live, setLive] = useState<ToolName[] | null>(null)

  const load = useCallback(() => {
    // Does not ask while disconnected — it would just queue up and fail 30 seconds later (rpc-client's wait rule)
    if (useStore.getState().connection !== 'connected') return
    void platform.agents
      .detect()
      .then((found) => setLive(found.filter((t) => t.installed && t.loggedIn).map((t) => t.name)))
      .catch(() => setLive([]))
    for (const { name: tool } of tools) {
      void platform.agents
        .usage(tool)
        .then((r) => setSnap((s) => ({ ...s, [tool]: { usage: r.usage, reason: r.supported ? undefined : r.reason } })))
        .catch((e: Error) => setSnap((s) => ({ ...s, [tool]: { usage: null, reason: e.message } })))
    }
  }, [platform, tools])

  /*
   * Once on mount, then every 5 minutes after that. A limit is a value that moves on the order
   * of minutes, so polling every second would only hammer the tool's process without changing
   * the answer (claude asks a live session).
   */
  useEffect(() => {
    load()
    const t = setInterval(load, 5 * 60_000)
    return () => clearInterval(t)
    // connection: the moment it comes back is when to ask again (a login could have happened meanwhile)
  }, [load, connection])

  /*
   * Opening via the palette or /usage opens the detail for **whichever tool is currently being
   * looked at** (usageTools) — or the first donut if that tool is not on screen. Two doors, one
   * destination.
   */
  useEffect(() => {
    if (usageOpen) setOpen((cur) => cur ?? usageTools(useStore.getState())[0] ?? (live ?? [])[0] ?? null)
    else setOpen(null)
  }, [usageOpen, live])

  const show = (tool: ToolName | null) => {
    setOpen(tool)
    toggleUsage(tool !== null)
    if (tool) load()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      show(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /*
   * When disconnected, that fact stands in place of the donuts. One breathing dot and one word
   * — exactly the rule that the brightest thing in the top bar is what is blocking me.
   */
  if (offline) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-ink-signal" data-testid="connection">
        <span className="size-1.5 rounded-full bg-ink-signal breathe" aria-hidden />
        {connection === 'connecting' ? 'Connecting' : 'Disconnected'}
      </span>
    )
  }

  /*
   * The host is connected but there is not a single usable tool — leaving this empty would read
   * as "nothing to see," but it is actually **a state that needs action** (install or log in).
   * The fact is written using the same rule as disconnection. While it has not been asked yet
   * (null), nothing is said — silence before the first answer would not be true.
   */
  if (live !== null && live.length === 0) {
    return (
      <Tooltip
        testId="usage-no-agent-tip"
        content={
          <span className="block">
            <span className="block text-ink">No agent connected</span>
            <span className="mt-1 block text-ink-faint">Install or sign in to Claude Code or Codex</span>
          </span>
        }
      >
        <span className="text-[11px] text-ink-muted" data-testid="usage-no-agent">
          No agent
        </span>
      </Tooltip>
    )
  }

  return (
    <span className="relative flex items-center gap-0.5" data-testid="usage-donuts">
      {(live ?? []).map((tool) => (
        <Donut
          key={tool}
          tool={tool}
          snap={snap[tool]}
          active={open === tool}
          onClick={() => show(open === tool ? null : tool)}
        />
      ))}

      {open && (
        <>
          {/* Clicking outside closes it — covers the screen without dimming it (same rule as the inbox) */}
          <div className="fixed inset-0 z-30" onClick={() => show(null)} data-testid="usage-backdrop" />
          <div
            className="cc-drop absolute right-0 top-full z-40 mt-1 w-[420px] max-w-[calc(92vw/var(--text-zoom))] overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)"
            data-testid="usage-drop"
          >
            <header className="flex items-center gap-2 border-b border-line px-4 py-2">
              <h2 className="text-[13px] font-medium text-ink">Usage</h2>
              <span className="readout text-[11px] text-ink-faint">{openMeta.label}</span>
            </header>
            <div className="max-h-[calc(60vh/var(--text-zoom))] overflow-y-auto">
              <UsagePanel tool={open} />
            </div>
          </div>
        </>
      )}
    </span>
  )
}

/**
 * A single donut — the ring is weekly usage, the center is the tool's single letter.
 *
 * When the number is unknown, **it does not draw a full gray ring**: that reads as "0% used."
 * A dashed ring means unknown, and the expandable detail answers why it is unknown (claude needs
 * a live session to be asked about a limit at all — the usual reason for "unknown").
 */
function Donut({
  tool,
  snap,
  active,
  onClick,
}: {
  tool: ToolName
  snap?: { usage: UsageSnapshot | null; reason?: string }
  active: boolean
  onClick: () => void
}) {
  const meta = useToolMeta(tool)
  const w = snap?.usage ? weeklyWindow(snap.usage.windows) : null
  const known = w !== null
  const percent = w?.percent ?? 0
  const R = 9
  const C = 2 * Math.PI * R
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * C
  const tone = known ? usageTone(percent) : 'text-ink-faint'

  return (
    <Tooltip
      testId={`usage-donut-tip-${tool}`}
      content={
        <span className="block">
          <span className="block text-ink">{meta.label}</span>
          <span className="readout mt-1 block">
            {known ? `${w.label}${w.scope ? ` · ${w.scope}` : ''} — ${percent}% used` : 'Weekly usage unknown'}
          </span>
        </span>
      }
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`${meta.label} weekly usage${known ? ` ${percent}%` : ' unknown'}`}
        data-testid={`usage-donut-${tool}`}
        data-percent={known ? percent : ''}
        /*
         * Even while open, **another donut has to be clickable right away** — if the outside
         * click shield covered the donuts too, switching tools would take two clicks. So this
         * sits above the shield.
         */
        /*
         * The highlight is **round too** (user's observation, 2026-09-10). If a square lit up
         * where a ring is drawn, whether the hand touched the donut or the panel behind it would
         * look mismatched — the shape that lights up has to be the shape of the button.
         */
        className={`relative z-40 flex items-center rounded-full p-0.5 transition-colors hover:bg-surface-hover/50 ${
          active ? 'bg-surface-hover/50' : ''
        }`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
          <circle
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="text-line"
            {...(known ? {} : { strokeDasharray: '2 3' })}
          />
          {known && (
            <circle
              cx="12"
              cy="12"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${filled} ${C - filled}`}
              // Has to start at 12 o'clock to match the direction people read in (same rule as the larger donut in the detail view)
              transform="rotate(-90 12 12)"
              className={tone}
            />
          )}
          {/*
            The center letter is the **same mark** as the sidebar session chip. This single
            letter is why, with two donuts standing side by side, which is which reads without
            a legend.
          */}
          <text
            x="12"
            y="12"
            textAnchor="middle"
            dominantBaseline="central"
            className={`fill-current font-mono ${known ? 'text-ink' : 'text-ink-faint'}`}
            style={{ fontSize: '9px' }}
          >
            {meta.mark}
          </text>
        </svg>
      </button>
    </Tooltip>
  )
}
