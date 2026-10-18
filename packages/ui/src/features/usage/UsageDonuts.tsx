import { usePresence } from '../../components/presence.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDismiss } from '../../components/useDismiss.js'
import type { CacheStats, MachineInfo, ToolName, UsageSnapshot } from '@cc/protocol'
import { MACHINE_STATUS_LABEL, cacheTooltipLine } from '@cc/core'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, usageTools } from '../../store/store.js'
import { useMachineName, useToolMeta } from '../../store/selectors.js'
import { Tooltip } from '../../components/primitives.jsx'
import { UsagePanel } from './UsagePanel.jsx'
import { SAME_ACCOUNT_LABEL } from './sameAccount.js'
import { usageTone, weeklyWindow } from './weekly.js'

type Snap = { usage: UsageSnapshot | null; reason?: string; cache?: CacheStats; sameAccount?: boolean }

/**
 * What one machine said about its limits. `live` is null until it has answered which tools are usable there; `snap`
 * holds each tool's last answer.
 */
type Group = { live: ToolName[] | null; snap: Partial<Record<ToolName, Snap>> }

/** The key of this computer's group. Machine ids start with a letter, so it never collides with one */
const HERE = ''

/** Which donut's detail is open: a tool, on this computer (`machine` null) or on a linked machine */
type Open = { machine: string | null; tool: ToolName }

/** How often the limits are asked again while the window is in view */
const POLL_MS = 5 * 60_000
/** How soon a machine whose detect failed (its host restarting, the link catching up) is asked again */
const RETRY_MS = 15_000

const EMPTY: Group = { live: null, snap: {} }

/** The ids of the linked machines that are connected now, as one string so a selector can compare it */
function connectedIds(machines: Record<string, MachineInfo>): string[] {
  return Object.values(machines)
    .filter((m) => m.status === 'connected')
    .map((m) => m.id)
}

/**
 * Usage in the top bar — **one weekly donut per tool** (user request, 2026-09-09), **per machine** (#82, owner
 * decision on docs/plans/remote-hub.md §6).
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
 *
 * Linked machines: each machine signs its tools in on its own, possibly to another account, so each has limits of its
 * own. This computer's donuts come first and carry no name (the person reads the absence as "here", as `MachineTag`
 * does); each linked machine follows behind a hairline, named by the same chip the session header uses. A machine that
 * is not connected is named with its state and is **not asked**: the hub would only queue the call behind a link that
 * is down. It is asked again the moment its link comes back.
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
  /** The linked machines, in the order the host lists them (the sidebar's group order) */
  const machineOrder = useStore((s) => Object.keys(s.machines).join(','))
  const machineIds = machineOrder ? machineOrder.split(',') : []
  const connectedKey = useStore((s) => connectedIds(s.machines).join(','))
  const [groups, setGroups] = useState<Record<string, Group>>({})
  const [open, setOpen] = useState<Open | null>(null)
  /*
   * What the dropdown shows while it leaves: the last one opened, kept through its exit (usePresence), since `open`
   * is already null by then and the content would vanish before the panel does.
   */
  const lastOpen = useRef<Open | null>(open)
  if (open) lastOpen.current = open
  const { shown: dropShown, leaving } = usePresence(open !== null)
  const drop = dropShown ? (open ?? lastOpen.current) : null
  // A hook cannot be called conditionally — the value is unused anyway while closed
  const openMeta = useToolMeta(drop?.tool ?? '')
  const openMachineName = useMachineName(drop?.machine)
  /**
   * The tools a donut gets put up for (user request, 2026-09-09: "only connected agents should
   * get a donut").
   *
   * **A limit for a tool that is not there has no place on the dashboard** — an empty ring for
   * an unused tool says nothing while still taking up eye space. The check is
   * installed-and-logged-in (detect), the same check the new-session window uses: two screens
   * must never answer "can this tool be used" differently. On a linked machine it is that
   * machine's answer, as the new-session window asks it for a project there.
   *
   * null means "not asked yet" — nothing is drawn in the meantime. Putting up a donut and then
   * removing it before the first answer arrives would make the bar flicker.
   */
  const live = groups[HERE]?.live ?? null

  /** Retries of a detect that failed, cleared when the bar goes */
  const retries = useRef<ReturnType<typeof setTimeout>[]>([])
  /** Asks one machine (null: this computer) which tools are usable and what each one's limits are */
  const loadOne = useCallback(
    (machine: string | null) => {
      // Does not ask while disconnected — it would just queue up and fail 30 seconds later (rpc-client's wait rule)
      if (useStore.getState().connection !== 'connected') return
      const key = machine ?? HERE
      const on = machine ?? undefined
      const patch = (p: Partial<Group> | ((g: Group) => Partial<Group>)) =>
        setGroups((all) => {
          const g = all[key] ?? EMPTY
          return { ...all, [key]: { ...g, ...(typeof p === 'function' ? p(g) : p) } }
        })
      /*
       * Limits are asked only of the tools detect says are usable there (#726): one that is not installed or not logged
       * in has none to show, and reading it could start a process on that machine for nothing.
       */
      void platform.agents
        .detect(on)
        .then((found) => {
          const usable = found.filter((t) => t.installed && t.loggedIn).map((t) => t.name)
          patch({ live: usable })
          for (const tool of usable) {
            const put = (snap: Snap) => patch((g) => ({ snap: { ...g.snap, [tool]: snap } }))
            void platform.agents
              .usage(tool, on)
              .then((r) => put({ usage: r.usage, reason: r.supported ? undefined : r.reason, cache: r.cache, sameAccount: r.sameAccountAsHub }))
              .catch((e: Error) => {
                put({ usage: null, reason: e.message })
                // A reading that failed (the tool's process busy or restarting) is tried again soon, not in five minutes
                retries.current.push(
                  setTimeout(() => {
                    void platform.agents.usage(tool, on).then((r) => put({ usage: r.usage, reason: r.supported ? undefined : r.reason, cache: r.cache, sameAccount: r.sameAccountAsHub })).catch(() => {})
                  }, RETRY_MS),
                )
              })
          }
        })
        /*
         * A question that failed is not an answer (owner, 2026-10-18: a linked machine read "No agent" for minutes
         * after its host restarted for an update, though Claude Code was there). The last answer stays, or nothing is
         * drawn yet, and the machine is asked again soon rather than at the next 5-minute tick.
         */
        .catch(() => {
          const t = setTimeout(() => loadOneRef.current?.(machine), RETRY_MS)
          retries.current.push(t)
        })
    },
    [platform],
  )
  const loadOneRef = useRef(loadOne)
  loadOneRef.current = loadOne
  useEffect(() => () => retries.current.forEach(clearTimeout), [])

  /** The connected machines last asked, so a machine whose link comes back is asked once, and the others are not */
  const asked = useRef<Set<string>>(new Set())
  const loadAll = useCallback(() => {
    loadOne(null)
    const ids = connectedIds(useStore.getState().machines)
    for (const id of ids) loadOne(id)
    asked.current = new Set(ids)
  }, [loadOne])

  /*
   * Once on mount, then every 5 minutes after that. A limit is a value that moves on the order
   * of minutes, so polling every second would only hammer the tool's process without changing
   * the answer (claude asks a live session).
   */
  useEffect(() => {
    loadAll()
    let last = Date.now()
    const poll = () => {
      // A hidden window shows nothing: asking would start a reading (a process, on a machine with no session) for nobody (#726)
      if (document.hidden) return
      last = Date.now()
      loadAll()
    }
    const t = setInterval(poll, POLL_MS)
    // Back in view after a tick was skipped: asked at once rather than shown stale until the next tick
    const onVisible = () => {
      if (!document.hidden && Date.now() - last >= POLL_MS) poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // connection: the moment it comes back is when to ask again (a login could have happened meanwhile)
  }, [loadAll, connection])

  /*
   * A linked machine whose link comes back (or that was just added) is asked then, rather than at the next 5-minute
   * tick: its group would otherwise stand empty for up to five minutes after it says "connected". Only that machine is
   * asked; the rest keep their answers.
   */
  useEffect(() => {
    const now = new Set(connectedKey ? connectedKey.split(',') : [])
    for (const id of now) if (!asked.current.has(id)) loadOne(id)
    asked.current = now
  }, [connectedKey, loadOne])

  /*
   * Opening via the palette or /usage opens the detail for **whichever tool is currently being
   * looked at** (usageTools), on the machine that session runs on when that machine is connected —
   * or this computer's first donut if that tool is not on screen. Two doors, one destination.
   */
  useEffect(() => {
    if (!usageOpen) {
      setOpen(null)
      return
    }
    setOpen((cur) => {
      if (cur) return cur
      const s = useStore.getState()
      const tool = usageTools(s)[0]
      const machine = s.focusedSessionId ? (s.sessions[s.focusedSessionId]?.machine ?? null) : null
      if (tool) return { machine: machine && s.machines[machine]?.status === 'connected' ? machine : null, tool }
      const first = (live ?? [])[0]
      return first ? { machine: null, tool: first } : null
    })
  }, [usageOpen, live])

  const show = (next: Open | null) => {
    setOpen(next)
    toggleUsage(next !== null)
    if (next) loadOne(next.machine)
  }
  const isOpen = (machine: string | null, tool: ToolName) => open?.machine === machine && open.tool === tool

  // The backdrop catches the outside press and covers an app's view, so only Escape is handled here
  useDismiss({ open: open !== null, onClose: () => show(null) })

  /*
   * When disconnected, that fact stands in place of the donuts. One breathing dot and one word
   * — exactly the rule that the brightest thing in the top bar is what is blocking me.
   */
  if (offline) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-ink-signal" data-testid="connection">
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
  const noAgent =
    live !== null && live.length === 0 ? (
      <Tooltip
        testId="usage-no-agent-tip"
        content={
          <span className="block">
            <span className="block text-ink">No agent connected</span>
            <span className="mt-1 block text-ink-faint">Install or sign in to Claude Code or Codex</span>
          </span>
        }
      >
        <span className="flex" data-testid="usage-no-agent" aria-label="No agent connected">
          <NoAgentMark />
        </span>
      </Tooltip>
    ) : null

  // With no linked machine, a computer with no usable tool says only that, as it always did
  if (noAgent && machineIds.length === 0) return noAgent

  return (
    <span className="relative flex items-center gap-0.5" data-testid="usage-donuts">
      {noAgent}
      {(live ?? []).map((tool) => (
        <Donut
          key={tool}
          tool={tool}
          machine={null}
          snap={groups[HERE]?.snap[tool]}
          active={isOpen(null, tool)}
          onClick={() => show(isOpen(null, tool) ? null : { machine: null, tool })}
        />
      ))}
      {machineIds.map((id) => (
        <MachineGroup key={id} machineId={id} group={groups[id] ?? EMPTY} isOpen={isOpen} show={show} />
      ))}

      {drop && (
        <>
          {/*
            Pressing outside closes it — covers the screen without dimming it (same rule as the inbox).
            On the press, not the click, and marked data-no-drag: this sits inside the top bar's
            window drag region, and on Windows a window drag swallows the mouseup, so a click never
            came and the dropdown stayed open (#365, DragRegion.tsx).
          */}
          {!leaving && <div className="fixed inset-0 z-30" onMouseDown={() => show(null)} data-no-drag data-testid="usage-backdrop" />}
          <div
            data-no-drag
            className={`${leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'} absolute right-0 top-full z-40 mt-1 w-[420px] max-w-[calc(92vw/var(--text-zoom))] overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)`}
            data-testid="usage-drop"
            data-machine={drop.machine ?? undefined}
          >
            <header className="flex items-center gap-2 border-b border-line px-4 py-2">
              <h2 className="text-md font-medium text-ink">Usage</h2>
              <span className="readout text-xs text-ink-faint">{openMeta.label}</span>
              {openMachineName && (
                <span className="truncate text-xs text-ink-faint" data-testid="usage-drop-machine">
                  on {openMachineName}
                </span>
              )}
            </header>
            <div className="max-h-[calc(60vh/var(--text-zoom))] overflow-y-auto">
              <UsagePanel tool={drop.tool} machine={drop.machine} />
            </div>
          </div>
        </>
      )}
    </span>
  )
}

/**
 * One linked machine's donuts and its name on one soft tinted pill (#82): the pill says which donuts are that machine's,
 * so the name inside needs no chip of its own. A fill rather than a border, so it adds no height to the bar's lines.
 * A machine that is not connected shows its state in place of donuts (the sidebar's words for it), and is not asked.
 * One that is connected but has no usable tool says so in the same faint words as this computer would, so a missing
 * group never reads as "this machine has no limits".
 */
function MachineGroup({
  machineId,
  group,
  isOpen,
  show,
}: {
  machineId: string
  group: Group
  isOpen: (machine: string | null, tool: ToolName) => boolean
  show: (next: Open | null) => void
}) {
  const info = useStore((s) => s.machines[machineId])
  if (!info) return null
  const connected = info.status === 'connected'
  return (
    <span
      className="ml-1.5 flex items-center gap-0.5 rounded-full bg-surface-hover/30 pl-2 pr-0.5"
      data-testid={`usage-machine-${machineId}`}
      data-status={info.status}
    >
      <Tooltip
        testId={`usage-machine-tip-${machineId}`}
        align="right"
        content={
          <span className="block">
            <span className="block text-ink">{info.name}</span>
            <span className="mt-1 block text-ink-faint">
              {connected ? 'Usage on this machine' : `${MACHINE_STATUS_LABEL[info.status]}: not asked until it is back`}
            </span>
          </span>
        }
      >
        <span className="block max-w-[96px] truncate pr-0.5 text-2xs leading-body text-ink-faint">
          {info.name}
        </span>
      </Tooltip>
      {!connected ? (
        <span className="ml-0.5 text-2xs text-ink-faint" data-testid={`usage-machine-state-${machineId}`}>
          {MACHINE_STATUS_LABEL[info.status]}
        </span>
      ) : group.live !== null && group.live.length === 0 ? (
        <Tooltip
          align="right"
          content={
            <span className="block">
              <span className="block text-ink">No agent on {info.name}</span>
              <span className="mt-1 block text-ink-faint">Install or sign in to Claude Code or Codex there</span>
            </span>
          }
        >
          <span className="flex" data-testid={`usage-machine-no-agent-${machineId}`} aria-label={`No agent on ${info.name}`}>
            <NoAgentMark />
          </span>
        </Tooltip>
      ) : (
        (group.live ?? []).map((tool) => (
          <Donut
            key={tool}
            tool={tool}
            machine={machineId}
            snap={group.snap[tool]}
            active={isOpen(machineId, tool)}
            onClick={() => show(isOpen(machineId, tool) ? null : { machine: machineId, tool })}
          />
        ))
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
  machine,
  snap,
  active,
  onClick,
}: {
  tool: ToolName
  /** The linked machine it is for; null for this computer */
  machine: string | null
  snap?: Snap
  active: boolean
  onClick: () => void
}) {
  const meta = useToolMeta(tool)
  const machineName = useMachineName(machine)
  // A machine's donut is named `<machine>.<tool>`, the way the hub names a machine's ids (#82); this computer's keep their names
  const id = machine ? `${machine}.${tool}` : tool
  const label = machineName ? `${meta.label} on ${machineName}` : meta.label
  const w = snap?.usage ? weeklyWindow(snap.usage.windows) : null
  const known = w !== null
  const percent = w?.percent ?? 0
  const R = 9
  const C = 2 * Math.PI * R
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * C
  const tone = known ? usageTone(percent) : 'text-ink-faint'
  const cacheLine = cacheTooltipLine(snap?.cache)

  return (
    <Tooltip
      testId={`usage-donut-tip-${id}`}
      content={
        <span className="block">
          <span className="block text-ink">{label}</span>
          <span className="readout mt-1 block">
            {known ? `${w.label}${w.scope ? ` · ${w.scope}` : ''} — ${percent}% used` : 'Weekly usage unknown'}
          </span>
          {/* Why the numbers equal this computer's, or why there are none: said in the donut's words, never a blank (#726) */}
          {known && snap?.sameAccount && (
            <span className="readout block text-ink-faint" data-testid={`usage-donut-same-${id}`}>
              {SAME_ACCOUNT_LABEL}
            </span>
          )}
          {!known && snap?.reason && (
            <span className="readout block text-ink-faint" data-testid={`usage-donut-reason-${id}`}>
              {snap.reason}
            </span>
          )}
          {/*
            The prompt cache in one line (docs/agent-host.md §6.1), from the answer the donut already asked for: the
            detail below the donut breaks it down. Absent when the host did not count it (one that predates it).
          */}
          {cacheLine && (
            <span className="readout block text-ink-faint" data-testid={`usage-donut-cache-${id}`}>
              {cacheLine}
            </span>
          )}
        </span>
      }
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label} weekly usage${known ? ` ${percent}%` : ' unknown'}`}
        data-testid={`usage-donut-${id}`}
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
            a legend. Set in the same face as that chip (Pretendard, owner 2026-10-18).
          */}
          {/* y 11, not 12: Pretendard's capitals sit low around a central baseline (measured at 4x: 0.9px under the middle) */}
          <text
            x="12"
            y="11"
            textAnchor="middle"
            dominantBaseline="central"
            className={`fill-current font-sans font-semibold ${known ? 'text-ink' : 'text-ink-faint'}`}
            style={{ fontSize: 'var(--text-2xs)' }}
          >
            {meta.mark}
          </text>
        </svg>
      </button>
    </Tooltip>
  )
}

/**
 * Where a donut would stand when a machine has no usable agent (owner, 2026-10-18): an empty dashed ring of the donut's
 * size, not the words "No agent", which took the capsule's width and were cut at its edge. The tooltip around it says
 * what it means.
 */
function NoAgentMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className="shrink-0 text-ink-faint">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.6" />
    </svg>
  )
}
