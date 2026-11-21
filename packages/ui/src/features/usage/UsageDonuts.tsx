import { LEAVE_MS, usePresence } from '../../components/presence.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDismiss } from '../../components/useDismiss.js'
import { errorMessage, type CacheStats, type MachineInfo, type ToolName, type ToolStatus, type UsageSnapshot } from '@cc/protocol/client'
import { cacheTooltipLine } from '@cc/core'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useWhileVisible } from '../../app/useWhileVisible.js'
import { useStore, usageTools } from '../../store/store.js'
import { useMachineName, useToolMeta } from '../../store/selectors.js'
import { Tooltip } from '../../components/primitives.jsx'
import { NOT_REPORTED_COPY, UsagePanel } from './UsagePanel.jsx'
import { SAME_ACCOUNT_LABEL } from './sameAccount.js'
import { usageTone, weeklyWindow } from './weekly.js'
import { setupStates, signedOutTools, withLiveSetups } from '../tools/setupLine.js'
import { ToolSetupLine } from '../tools/ToolSetupLine.jsx'

/** What `agents.usage` answered for one tool */
type Snap = {
  usage: UsageSnapshot | null
  reason?: string
  cache?: CacheStats
  sameAccount?: boolean
  limits: 'read' | 'never' | 'unknown'
}

/**
 * One `agents.usage` answer as a snap. A failed read and an older host also answer `supported: false`: only
 * `notReported` is the dimmed ring; anything else stays unknown for now.
 */
export function toSnap(r: {
  supported?: boolean
  reason?: string
  notReported?: boolean
  usage: UsageSnapshot | null
  cache?: CacheStats
  sameAccountAsHub?: boolean
}): Snap {
  return {
    usage: r.usage,
    reason: r.supported ? undefined : r.reason,
    cache: r.cache,
    sameAccount: r.sameAccountAsHub,
    limits: r.supported === true ? 'read' : r.supported === false && r.notReported === true ? 'never' : 'unknown',
  }
}

/** What one machine said about its limits. `live` is null until it has answered which tools are usable there */
type Group = {
  live: ToolName[] | null
  /** Installed but signed out: a donut each (#1823). `tools` is detect's answer, for the panel's sign-in line */
  signedOut: ToolName[]
  tools: ToolStatus[]
  /** Every tool with a donut, live or signed out, in the order detect lists them */
  order: ToolName[]
  snap: Partial<Record<ToolName, Snap>>
}

/** This computer's group key; machine ids start with a letter, so it never collides */
const HERE = ''

/** Which donut's detail is open (`machine` null: this computer) */
type Open = { machine: string | null; tool: ToolName }

const POLL_MS = 5 * 60_000
/** How soon a machine whose detect failed (its host restarting, the link catching up) is asked again */
const RETRY_MS = 15_000

const EMPTY: Group = { live: null, signedOut: [], tools: [], order: [], snap: {} }

function connectedIds(machines: Record<string, MachineInfo>): string[] {
  return Object.values(machines)
    .filter((m) => m.status === 'connected')
    .map((m) => m.id)
}

/**
 * Usage in the top bar: one weekly donut per tool, per machine (#82, docs/plans/remote-hub.md §6; looks in
 * docs/design-system.md §6, §10). Always on screen, its detail drops below it; weekly only, as the 5-hour window
 * recovers fast. This computer's donuts come first, unnamed; a disconnected machine is not asked until its link is back.
 */
export function UsageDonuts() {
  const platform = usePlatform()
  const usageOpen = useStore((s) => s.usageOpen)
  const toggleUsage = useStore((s) => s.toggleUsage)
  // Disconnected, the spot says so: left empty it would read as "no tools", which is not known
  const connection = useStore((s) => s.connection)
  const offline = connection !== 'connected'
  // The linked machines in the host's order
  const machineOrder = useStore((s) => Object.keys(s.machines).join(','))
  const machineIds = machineOrder ? machineOrder.split(',') : []
  const connectedKey = useStore((s) => connectedIds(s.machines).join(','))
  const [groups, setGroups] = useState<Record<string, Group>>({})
  const [open, setOpen] = useState<Open | null>(null)
  // The last one opened, kept through the dropdown's exit (usePresence): `open` is already null then
  const lastOpen = useRef<Open | null>(open)
  if (open) lastOpen.current = open
  const { shown: dropShown, leaving } = usePresence(open !== null)
  const drop = dropShown ? (open ?? lastOpen.current) : null
  const openMeta = useToolMeta(drop?.tool ?? '')
  const openMachineName = useMachineName(drop?.machine)
  /*
   * The usable tools by detect, the new-session window's check, so the two never disagree. null: not asked yet, and
   * nothing is drawn, so the bar does not flicker.
   */
  const live = groups[HERE]?.live ?? null
  const here = groups[HERE] ?? EMPTY
  const hereDonuts = useDonutPresence(here.live === null ? null : here.order)

  /** Pending retries, cleared when the bar goes */
  const retries = useRef<ReturnType<typeof setTimeout>[]>([])
  /** Asks one machine (null: this computer) for its usable tools and their limits */
  const loadOne = useCallback(
    (machine: string | null) => {
      // Not while disconnected: it would queue and fail 30 seconds later (rpc-client's wait rule)
      if (useStore.getState().connection !== 'connected') return
      const key = machine ?? HERE
      const on = machine ?? undefined
      const patch = (p: Partial<Group> | ((g: Group) => Partial<Group>)) =>
        setGroups((all) => {
          const g = all[key] ?? EMPTY
          return { ...all, [key]: { ...g, ...(typeof p === 'function' ? p(g) : p) } }
        })
      // Limits only of usable tools (#726): reading another could start a process on that machine for nothing
      void platform.agents
        .detect(on)
        .then((read) => {
          // This computer's live setups over the reading (withLiveSetups)
          const found = machine ? read : withLiveSetups(read, useStore.getState().toolSetups)
          const usable = found.filter((t) => t.installed && t.loggedIn).map((t) => t.name)
          const signedOut = signedOutTools(found).map((t) => t.name)
          patch({ live: usable, signedOut, tools: found, order: found.filter((t) => usable.includes(t.name) || signedOut.includes(t.name)).map((t) => t.name) })
          for (const tool of usable) {
            const put = (snap: Snap) => patch((g) => ({ snap: { ...g.snap, [tool]: snap } }))
            // A failed call is not an answer (#850; RV1624): the donut keeps what it knew, so a host swap does not flash it dashed
            const failed = (reason: string) =>
              patch((g) => ({ snap: { ...g.snap, [tool]: { ...(g.snap[tool] ?? { usage: null, limits: 'unknown' }), reason } } }))
            // A provisional answer (#1623) is asked once more to settle, never in a loop: the settled answer is final
            const take = (r: Parameters<typeof toSnap>[0] & { provisional?: boolean }) => {
              put(toSnap(r))
              if (r.provisional) {
                void platform.agents
                  .usage(tool, on, { settle: true })
                  .then((s) => put(toSnap(s)))
                  .catch(() => {})
              }
            }
            void platform.agents
              .usage(tool, on)
              .then(take)
              .catch((e: unknown) => {
                failed(errorMessage(e))
                // Tried again soon, not at the next tick (the tool's process busy or restarting)
                retries.current.push(
                  setTimeout(() => {
                    void platform.agents
                      .usage(tool, on)
                      .then(take)
                      .catch(() => {})
                  }, RETRY_MS),
                )
              })
          }
        })
        /*
         * A failed detect is not an answer (#850 item 8): a host restarting for an update would read "No agent" for
         * minutes. The last answer stays and the machine is asked again soon.
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

  // A setup state that moved here (`tool_setup`) asks again at once; keyed by states, so progress readings ask nothing
  const setupState = useStore((s) => setupStates(s.toolSetups))
  const setupStateSeen = useRef(setupState)
  useEffect(() => {
    if (setupStateSeen.current === setupState) return
    setupStateSeen.current = setupState
    loadOneRef.current?.(null)
  }, [setupState])

  /** The connected machines last asked, so one whose link comes back is asked once */
  const asked = useRef<Set<string>>(new Set())
  const loadAll = useCallback(() => {
    loadOne(null)
    const ids = connectedIds(useStore.getState().machines)
    for (const id of ids) loadOne(id)
    asked.current = new Set(ids)
  }, [loadOne])

  /*
   * Every 5 minutes: limits move in minutes, and a reading costs the tool's process (claude asks a live session). Not
   * while hidden (it could start a process for nobody, #726); at once on return, and when the connection comes back.
   */
  useWhileVisible(() => loadAll(), POLL_MS, { immediate: true }, [loadAll, connection])

  // A machine whose link comes back (or was added) is asked then, alone, not at the next tick
  useEffect(() => {
    const now = new Set(connectedKey ? connectedKey.split(',') : [])
    for (const id of now) if (!asked.current.has(id)) loadOne(id)
    asked.current = now
  }, [connectedKey, loadOne])

  // The palette or /usage opens the tool being looked at (usageTools) on its session's machine if connected, else the first
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
      if (tool)
        return { machine: machine && s.machines[machine]?.status === 'connected' ? machine : null, tool }
      const first = here.order[0]
      return first ? { machine: null, tool: first } : null
    })
  }, [usageOpen, live, here.order])

  const show = (next: Open | null) => {
    setOpen(next)
    toggleUsage(next !== null)
    if (next) loadOne(next.machine)
  }
  const isOpen = (machine: string | null, tool: ToolName) => open?.machine === machine && open.tool === tool

  // The backdrop catches the outside press and covers an app's view, so only Escape is handled here
  useDismiss({ open: open !== null, onClose: () => show(null) })

  // Disconnected: one breathing dot and a word in the signal ink, as it blocks everything
  if (offline) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-ink-signal" data-testid="connection">
        <span className="size-1.5 rounded-full bg-ink-signal breathe" aria-hidden />
        {connection === 'connecting' ? 'Connecting' : 'Disconnected'}
      </span>
    )
  }

  // No usable tool needs action (install or sign in), so it is said; not before the first answer (null)
  const noAgent =
    live !== null && live.length === 0 && here.signedOut.length === 0 ? (
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

  // With no linked machine, a computer with no usable tool says only that
  if (noAgent && machineIds.length === 0) return noAgent

  return (
    <span className="relative flex items-center gap-0.5" data-testid="usage-donuts">
      {noAgent}
      {hereDonuts.map((d) => (
        <Donut
          key={d.tool}
          tool={d.tool}
          machine={null}
          snap={here.snap[d.tool]}
          signedOut={here.signedOut.includes(d.tool)}
          entering={d.entering}
          leaving={d.leaving}
          active={isOpen(null, d.tool)}
          onClick={() => show(isOpen(null, d.tool) ? null : { machine: null, tool: d.tool })}
        />
      ))}
      {machineIds.map((id) => (
        <MachineGroup key={id} machineId={id} group={groups[id] ?? EMPTY} isOpen={isOpen} show={show} />
      ))}

      {drop && (
        <>
          {/*
            A press outside closes it, on mousedown and data-no-drag: inside the top bar's drag region a Windows window
            drag swallows the mouseup, so a click never comes (#365, DragRegion.tsx).
          */}
          {!leaving && (
            <div
              className="fixed inset-0 z-30"
              onMouseDown={() => show(null)}
              data-no-drag
              data-testid="usage-backdrop"
            />
          )}
          <div
            data-no-drag
            className={`${leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'} absolute right-0 top-full z-40 mt-1 w-[420px] max-w-[calc(92vw/var(--text-zoom))] overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)`}
            data-testid="usage-drop"
            data-machine={drop.machine ?? undefined}
          >
            <header className="flex items-center gap-2 border-b border-line px-4 py-2">
              {/* The agent's name is the heading, signed in or not */}
              <h2 className="text-md font-medium text-ink" data-testid="usage-drop-title">{openMeta.label}</h2>
              {openMachineName && (
                <span className="truncate text-xs text-ink-faint" data-testid="usage-drop-machine">
                  on {openMachineName}
                </span>
              )}
            </header>
            <div className="max-h-[calc(60vh/var(--text-zoom))] overflow-y-auto">
              {(groups[drop.machine ?? HERE] ?? EMPTY).signedOut.includes(drop.tool) ? (
                <SignedOutPanel tool={drop.tool} machine={drop.machine} group={groups[drop.machine ?? HERE] ?? EMPTY} redetect={() => loadOne(drop.machine)} />
              ) : (
                <UsagePanel key={`${drop.machine ?? ''}:${drop.tool}`} tool={drop.tool} machine={drop.machine} />
              )}
            </div>
          </div>
        </>
      )}
    </span>
  )
}

/** One linked machine's donuts and name in an outlined capsule (#82; docs/design-system.md §6) */
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
  const donuts = useDonutPresence(group.order)
  // Connected and answered: shown, if only as its name (docs/design-system.md §6). Not asked yet: hidden, so it does not change
  if (!info || info.status !== 'connected' || (group.live === null && !donuts.length)) return null
  return (
    <span
      className={`cc-capsule-in ml-2 flex items-center gap-0.5 rounded-full border border-line py-0.5 pl-2 ${donuts.length ? 'pr-0.5' : 'pr-1.5'}`}
      data-testid={`usage-machine-${machineId}`}
      data-status={info.status}
    >
      <Tooltip
        testId={`usage-machine-tip-${machineId}`}
        align="right"
        content={
          <span className="block">
            <span className="block text-ink">{info.name}</span>
            {donuts.length > 0 && <span className="mt-1 block text-ink-faint">Usage on this machine</span>}
          </span>
        }
      >
        <span className="block max-w-[96px] truncate pr-0.5 text-2xs leading-body text-ink-faint">
          {info.name}
        </span>
      </Tooltip>
      {donuts.map((d) => (
        <Donut
          key={d.tool}
          tool={d.tool}
          machine={machineId}
          snap={group.snap[d.tool]}
          signedOut={group.signedOut.includes(d.tool)}
          entering={d.entering}
          leaving={d.leaving}
          active={isOpen(machineId, d.tool)}
          onClick={() => show(isOpen(machineId, d.tool) ? null : { machine: machineId, tool: d.tool })}
        />
      ))}
    </span>
  )
}

/** The ring's short state fade (docs/design-system.md §9) */
const RING_FADE =
  'transition-[opacity,color,stroke-dasharray] duration-150 ease-out motion-reduce:transition-opacity'

/**
 * A donut: the ring is weekly usage, the centre the tool's letter. Its looks: docs/design-system.md §10.
 * Unknown is usually claude with no live session to ask.
 */
function Donut({
  tool,
  machine,
  snap,
  signedOut = false,
  entering = false,
  leaving = false,
  active,
  onClick,
}: {
  tool: ToolName
  /** The linked machine it is for; null for this computer */
  machine: string | null
  snap?: Snap
  /** Installed but signed out (#1823) */
  signedOut?: boolean
  /** Came after the bar was first drawn: fades in. `leaving`: on its way out, still drawn for its exit */
  entering?: boolean
  leaving?: boolean
  active: boolean
  onClick: () => void
}) {
  const meta = useToolMeta(tool)
  const machineName = useMachineName(machine)
  // `<machine>.<tool>`, as the hub names a machine's ids (#82)
  const id = machine ? `${machine}.${tool}` : tool
  const label = machineName ? `${meta.label} on ${machineName}` : meta.label
  const w = !signedOut && snap?.usage ? weeklyWindow(snap.usage.windows) : null
  const known = w !== null
  const unsupported = !known && !signedOut && snap?.limits === 'never'
  const state = known ? 'known' : unsupported ? 'unsupported' : 'unknown'
  // Signed out: the unknown's dashed ring in the signal colour, never the dimmed unsupported
  const look = signedOut ? 'signedOut' : state
  const percent = w?.percent ?? 0
  const R = 9
  const C = 2 * Math.PI * R
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * C
  const tone = known ? usageTone(percent) : 'text-ink-faint'
  // Signed out waits on the person: `ink-signal`, not an error (#1823)
  const ring = signedOut ? 'text-ink-signal' : 'text-line'
  const cacheLine = cacheTooltipLine(snap?.cache)

  return (
    <Tooltip
      testId={`usage-donut-tip-${id}`}
      content={
        <span className="block">
          <span className="block text-ink">{label}</span>
          {/* A tool with no limits says so once, in the line below: a second "unknown" or "none" line would repeat it */}
          {(signedOut || !unsupported) && (
            <span className="readout mt-1 block">
              {signedOut
                ? 'Not signed in'
                : known
                  ? `${w.label}${w.scope ? ` · ${w.scope}` : ''} — ${percent}% used`
                  : 'Weekly usage unknown'}
            </span>
          )}
          {/* Why the numbers equal this computer's, or why there are none, never a blank (#726) */}
          {!signedOut && known && snap?.sameAccount && (
            <span className="readout block text-ink-faint" data-testid={`usage-donut-same-${id}`}>
              {SAME_ACCOUNT_LABEL}
            </span>
          )}
          {!signedOut && !known && (unsupported || snap?.reason) && (
            <span className={`readout ${unsupported ? 'mt-1' : ''} block text-ink-faint`} data-testid={`usage-donut-reason-${id}`}>
              {unsupported ? NOT_REPORTED_COPY.title(meta.label) : snap.reason}
            </span>
          )}
          {/*
            The prompt cache in one line (docs/agent-host/prompt-cache.md); absent from an older host
          */}
          {!signedOut && cacheLine && (
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
        aria-label={signedOut ? `${label} not signed in` : `${label} ${unsupported ? 'reports no usage limits' : `weekly usage${known ? ` ${percent}%` : ' unknown'}`}`}
        data-testid={`usage-donut-${id}`}
        data-signed-out={signedOut || undefined}
        data-leaving={leaving || undefined}
        tabIndex={leaving ? -1 : undefined}
        data-percent={known ? percent : ''}
        data-state={signedOut ? 'signed-out' : state}
        /*
         * z-40, above the outside-press shield, so switching donuts takes one click. The round hover and the spacing:
         * docs/design-system.md §6.
         */
        className={`relative z-40 flex items-center rounded-full transition-colors hover:bg-surface-hover ${
          active ? 'bg-surface-hover' : ''
        } ${leaving ? 'cc-donut-out pointer-events-none' : entering ? 'cc-donut-in' : ''}`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
          {/*
            Stacked rings that change by opacity (#1616): dashed unknown, solid track, dim unsupported (docs/design-system.md §9)
          */}
          <circle
            data-ring="dashed"
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeDasharray="2 3"
            className={`${ring} ${RING_FADE} ${look === 'unknown' || look === 'signedOut' ? 'opacity-100' : 'opacity-0'}`}
          />
          <circle
            data-ring="solid"
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className={`text-line ${RING_FADE} ${look === 'known' ? 'opacity-100' : 'opacity-0'}`}
          />
          <circle
            data-ring="dim"
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`text-ink-faint ${RING_FADE} ${look === 'unsupported' ? 'opacity-50' : 'opacity-0'}`}
          />
          <circle
            data-ring="fill"
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            // From 12 o'clock, as the detail's donut
            transform="rotate(-90 12 12)"
            style={{ strokeDasharray: `${filled} ${C - filled}` }}
            className={`${tone} ${RING_FADE} ${known ? 'opacity-100' : 'opacity-0'}`}
          />
          {/*
            The session chip's letter and face, so donuts side by side need no legend
          */}
          {/* y 11, not 12: Pretendard's capitals sit low around a central baseline (measured at 4x: 0.9px under the middle) */}
          <text
            x="12"
            y="11"
            textAnchor="middle"
            dominantBaseline="central"
            className={`fill-current font-sans font-semibold transition-colors duration-150 ease-out motion-reduce:transition-none ${signedOut ? 'text-ink-signal' : look === 'unknown' ? 'text-ink-faint' : 'text-ink'}`}
            style={{ fontSize: 'var(--text-2xs)' }}
          >
            {meta.mark}
          </text>
        </svg>
      </button>
    </Tooltip>
  )
}

/** No usable agent: an empty dashed ring, not the words "No agent", which would be cut at the capsule's edge */
function NoAgentMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className="shrink-0 text-ink-faint">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.2 2.6"
      />
    </svg>
  )
}

/**
 * The tools with a donut, kept `LEAVE_MS` through their exit (docs/design-system.md §9); one that comes after the first
 * reading is `entering`, so the bar does not open with every donut fading in.
 */
function useDonutPresence(order: ToolName[] | null): { tool: ToolName; entering: boolean; leaving: boolean }[] {
  const key = order === null ? null : order.join(',')
  const [state, setState] = useState<{ key: string | null; shown: ToolName[]; leaving: ToolName[] }>({ key, shown: order ?? [], leaving: [] })
  const first = useRef<Set<ToolName> | null>(null)
  if (first.current === null && order !== null && order.length > 0) first.current = new Set(order)
  if (state.key !== key) {
    const next = order ?? []
    // Whatever is drawn but no longer listed is leaving, and keeps its place until its exit ends
    const gone = state.shown.filter((t) => !next.includes(t))
    const merged = [...next]
    for (const t of gone) merged.splice(Math.min(state.shown.indexOf(t), merged.length), 0, t)
    setState({ key, shown: merged, leaving: gone })
  }
  const leavingKey = state.leaving.join(',')
  useEffect(() => {
    if (!leavingKey) return
    const t = setTimeout(() => setState((s) => ({ ...s, shown: s.shown.filter((x) => !s.leaving.includes(x)), leaving: [] })), LEAVE_MS)
    return () => clearTimeout(t)
  }, [leavingKey])
  return state.shown.map((tool) => ({ tool, entering: first.current !== null && !first.current.has(tool), leaving: state.leaving.includes(tool) }))
}

/** A signed-out tool's dropdown: the pickers' setup line (ToolSetupLine) */
function SignedOutPanel({ tool, machine, group, redetect }: { tool: ToolName; machine: string | null; group: Group; redetect: () => void }) {
  const meta = useToolMeta(tool)
  return (
    <div className="px-4 py-4" data-testid="usage-signed-out">
      <ToolSetupLine
        status={group.tools.find((t) => t.name === tool)}
        label={meta.label}
        login={meta.login}
        machine={machine}
        shown
        terminal={{ login: (label, command) => `${label} is not signed in. Run ${command} in a terminal.`, missing: (label) => `${label} is not installed` }}
        redetect={redetect}
        testId="usage-signed-out-line"
        className="text-sm leading-body text-ink-muted"
      />
    </div>
  )
}
