import { LEAVE_MS, usePresence } from '../../components/presence.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDismiss } from '../../components/useDismiss.js'
import type { CacheStats, MachineInfo, ToolName, ToolStatus, UsageSnapshot } from '@cc/protocol/client'
import { cacheTooltipLine } from '@cc/core'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, usageTools } from '../../store/store.js'
import { useMachineName, useToolMeta } from '../../store/selectors.js'
import { Tooltip } from '../../components/primitives.jsx'
import { UsagePanel } from './UsagePanel.jsx'
import { SAME_ACCOUNT_LABEL } from './sameAccount.js'
import { usageTone, weeklyWindow } from './weekly.js'
import { setupStates, signedOutTools, withLiveSetups } from '../tools/setupLine.js'
import { ToolSetupLine } from '../tools/ToolSetupLine.jsx'

/**
 * What `agents.usage` answered for one tool. `unsupported` is the host's own `supported: false` (the tool cannot report
 * limits at all, #1616: `supported: false` with the host's `notReported` mark), never inferred from the tool's name. It
 * is unset for a failed read and for an older host that sends no mark: those are *unknown for now*, not *never*.
 */
type Snap = {
  usage: UsageSnapshot | null
  reason?: string
  cache?: CacheStats
  sameAccount?: boolean
  unsupported?: boolean
}

/**
 * One `agents.usage` answer as a snap: the same reading wherever it comes from (first ask, retry). The host also answers
 * `supported: false` for a read that failed, and a host that predates the mark answers both alike: only `notReported`
 * (the tool has no way to report limits) is the dimmed ring, so everything else stays unknown for now.
 */
function toSnap(r: {
  supported?: boolean
  reason?: string
  notReported?: boolean
  usage: UsageSnapshot | null
  cache?: CacheStats
  sameAccountAsHub?: boolean
}): Snap {
  const unsupported = r.supported === false && r.notReported === true
  return {
    usage: r.usage,
    reason: r.supported ? undefined : r.reason,
    cache: r.cache,
    sameAccount: r.sameAccountAsHub,
    unsupported: unsupported || undefined,
  }
}

/**
 * What one machine said about its limits. `live` is null until it has answered which tools are usable there; `snap`
 * holds each tool's last answer.
 */
type Group = {
  live: ToolName[] | null
  /**
   * The tools that are installed but signed out (owner, 2026-10-27): each gets a donut with a solid ring in the signal ink, so the same state
   * looks the same for every tool. `tools` is what detect said of them, for the panel's sign-in line
   */
  signedOut: ToolName[]
  tools: ToolStatus[]
  /** Every tool with a donut, live or signed out, in the order detect lists them */
  order: ToolName[]
  snap: Partial<Record<ToolName, Snap>>
}

/** The key of this computer's group. Machine ids start with a letter, so it never collides with one */
const HERE = ''

/** Which donut's detail is open: a tool, on this computer (`machine` null) or on a linked machine */
type Open = { machine: string | null; tool: ToolName }

/** How often the limits are asked again while the window is in view */
const POLL_MS = 5 * 60_000
/** How soon a machine whose detect failed (its host restarting, the link catching up) is asked again */
const RETRY_MS = 15_000

const EMPTY: Group = { live: null, signedOut: [], tools: [], order: [], snap: {} }

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
  const here = groups[HERE] ?? EMPTY
  const hereDonuts = useDonutPresence(here.live === null ? null : here.order)

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
        .then((read) => {
          // This computer's live setups over the reading: an install or sign-in that finished since is counted at once
          const found = machine ? read : withLiveSetups(read, useStore.getState().toolSetups)
          const usable = found.filter((t) => t.installed && t.loggedIn).map((t) => t.name)
          const signedOut = signedOutTools(found).map((t) => t.name)
          patch({ live: usable, signedOut, tools: found, order: found.filter((t) => usable.includes(t.name) || signedOut.includes(t.name)).map((t) => t.name) })
          for (const tool of usable) {
            const put = (snap: Snap) => patch((g) => ({ snap: { ...g.snap, [tool]: snap } }))
            /*
             * A call that failed is not an answer (#850; RV1624): the donut keeps what it last knew (known, or the tool
             * has no limits) and only learns why the last ask failed. Over a host swap it would otherwise flash to
             * dashed and back; over a link that stays up, stay dashed until the retry.
             */
            const failed = (reason: string) =>
              patch((g) => ({ snap: { ...g.snap, [tool]: { ...(g.snap[tool] ?? { usage: null }), reason } } }))
            void platform.agents
              .usage(tool, on)
              .then((r) => put(toSnap(r)))
              .catch((e: Error) => {
                failed(e.message)
                // A reading that failed (the tool's process busy or restarting) is tried again soon, not in five minutes
                retries.current.push(
                  setTimeout(() => {
                    void platform.agents
                      .usage(tool, on)
                      .then((r) => put(toSnap(r)))
                      .catch(() => {})
                  }, RETRY_MS),
                )
              })
          }
        })
        /*
         * A question that failed is not an answer (#850 item 8; owner, 2026-10-18: a linked machine read "No agent" for minutes
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

  /*
   * A tool's own install or sign-in moved on this computer (`tool_setup`): asked again at once, so a donut turns from
   * error to a reading, or appears, without waiting for the next tick. Only a change after the first reading counts.
   */
  // The states, not the setups: an install's progress readings do not ask detect and usage again
  const setupState = useStore((s) => setupStates(s.toolSetups))
  const setupStateSeen = useRef(setupState)
  useEffect(() => {
    if (setupStateSeen.current === setupState) return
    setupStateSeen.current = setupState
    loadOneRef.current?.(null)
  }, [setupState])

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

  // With no linked machine, a computer with no usable tool says only that, as it always did
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
            Pressing outside closes it — covers the screen without dimming it (same rule as the inbox).
            On the press, not the click, and marked data-no-drag: this sits inside the top bar's
            window drag region, and on Windows a window drag swallows the mouseup, so a click never
            came and the dropdown stayed open (#365, DragRegion.tsx).
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
              {/* The agent's name is the heading (owner, 2026-10-28): the panel is about that tool, signed in or not */}
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
                <UsagePanel tool={drop.tool} machine={drop.machine} />
              )}
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
  const donuts = useDonutPresence(group.order)
  /*
   * Only a machine with a tool that can run there shows (owner, 2026-10-18): one that is not connected, or has no
   * tool installed and logged in, is left out rather than drawn as "Offline" or "No agent". Tools will grow (OpenCode
   * and others) and so will machines; the bar keeps only what the person can use. Settings → Machines still lists
   * every machine with its state.
   */
  if (!info || info.status !== 'connected' || (!group.order.length && !donuts.length)) return null
  return (
    <span
      className="cc-donut-in ml-1.5 flex items-center gap-0.5 rounded-full border border-line py-0.5 pl-2 pr-0.5"
      data-testid={`usage-machine-${machineId}`}
      data-status={info.status}
    >
      <Tooltip
        testId={`usage-machine-tip-${machineId}`}
        align="right"
        content={
          <span className="block">
            <span className="block text-ink">{info.name}</span>
            <span className="mt-1 block text-ink-faint">Usage on this machine</span>
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

/** The short change between a ring's states: its opacity, its fill and its colour, in the time of the bar's other small moves */
const RING_FADE =
  'transition-[opacity,color,stroke-dasharray] duration-150 ease-out motion-reduce:transition-opacity'

/**
 * A single donut — the ring is weekly usage, the center is the tool's single letter.
 *
 * When the number is unknown, **it does not draw a full gray ring**: that reads as "0% used."
 * A dashed ring means unknown, and the expandable detail answers why it is unknown (claude needs
 * a live session to be asked about a limit at all — the usual reason for "unknown").
 *
 * A tool that does not report limits at all (the host's `supported: false`, #1616) is not "unknown for now": nothing
 * the person does would change it, so its ring is solid and dimmed with no fill, and its letter keeps the full ink.
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
  /** Installed but signed out (owner, 2026-10-27): a solid ring in the signal ink, no reading */
  signedOut?: boolean
  /** Came after the bar was first drawn: fades in. `leaving`: on its way out, still drawn for its exit */
  entering?: boolean
  leaving?: boolean
  active: boolean
  onClick: () => void
}) {
  const meta = useToolMeta(tool)
  const machineName = useMachineName(machine)
  // A machine's donut is named `<machine>.<tool>`, the way the hub names a machine's ids (#82); this computer's keep their names
  const id = machine ? `${machine}.${tool}` : tool
  const label = machineName ? `${meta.label} on ${machineName}` : meta.label
  const w = !signedOut && snap?.usage ? weeklyWindow(snap.usage.windows) : null
  const known = w !== null
  /*
   * Three looks for what the ring can say (#1616). Known: the fill on its track. Unknown for now: a dashed ring and a
   * faint letter, a state the person may change (a session to run, a machine to connect). Unsupported: the tool never
   * reports limits, so there is nothing to act on: a plain, solid, dimmed ring with no fill, the letter at full ink.
   */
  const unsupported = !known && !signedOut && snap?.unsupported === true
  const state = known ? 'known' : unsupported ? 'unsupported' : 'unknown'
  // What is drawn: signed out is its own solid look (below), so it is neither the dashed unknown nor the dimmed unsupported
  const look = signedOut ? 'signedOut' : state
  const percent = w?.percent ?? 0
  const R = 9
  const C = 2 * Math.PI * R
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * C
  const tone = known ? usageTone(percent) : 'text-ink-faint'
  // Signed out waits on the person, which is the signal's white (design-system §1), not an error: a solid ring and its letter in `ink-signal` (a dashed ring means "unknown")
  const ring = signedOut ? 'text-ink-signal' : 'text-line'
  const cacheLine = cacheTooltipLine(snap?.cache)

  return (
    <Tooltip
      testId={`usage-donut-tip-${id}`}
      content={
        <span className="block">
          <span className="block text-ink">{label}</span>
          <span className="readout mt-1 block">
            {signedOut
              ? 'Not signed in'
              : known
                ? `${w.label}${w.scope ? ` · ${w.scope}` : ''} — ${percent}% used`
                : 'Weekly usage unknown'}
          </span>
          {/* Why the numbers equal this computer's, or why there are none: said in the donut's words, never a blank (#726) */}
          {!signedOut && known && snap?.sameAccount && (
            <span className="readout block text-ink-faint" data-testid={`usage-donut-same-${id}`}>
              {SAME_ACCOUNT_LABEL}
            </span>
          )}
          {!signedOut && !known && snap?.reason && (
            <span className="readout block text-ink-faint" data-testid={`usage-donut-reason-${id}`}>
              {snap.reason}
            </span>
          )}
          {/*
            The prompt cache in one line (docs/agent-host.md §6.1), from the answer the donut already asked for: the
            detail below the donut breaks it down. Absent when the host did not count it (one that predates it).
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
        aria-label={signedOut ? `${label} not signed in` : `${label} weekly usage${known ? ` ${percent}%` : ' unknown'}`}
        data-testid={`usage-donut-${id}`}
        data-signed-out={signedOut || undefined}
        data-leaving={leaving || undefined}
        tabIndex={leaving ? -1 : undefined}
        data-percent={known ? percent : ''}
        data-state={state}
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
        /*
         * A linked machine's donuts sit in a capsule drawn by its outline only (owner, 2026-10-18): a filled capsule
         * left the hover's fill nothing to stand out from. The hover is a full step, so it shows on either ground.
         * Inside that capsule the donut has no padding of its own and the capsule keeps 2px on every side, so its
         * hover circle stands the same distance from the outline above, below and beside it (owner).
         */
        className={`relative z-40 flex items-center rounded-full ${machine ? '' : 'cc-donut-in p-0.5'} transition-colors hover:bg-surface-hover ${
          active ? 'bg-surface-hover' : ''
        } ${leaving ? 'cc-donut-out pointer-events-none' : entering ? 'cc-donut-in' : ''}`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
          {/*
            The rings stand on top of each other and change by opacity (#1616, the owner's motion rule): a state change is
            a short fade, never a jump, and with reduced motion it is the fade alone. The dashed one is the unknown; the
            solid one is the track of a read ring; the thin dim one is the unsupported ring (a read ring's track alone is nearly
            invisible in the light theme, and an empty track would also read as 0% used).
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
            className={`text-line ${RING_FADE} ${look === 'unknown' ? 'opacity-100' : 'opacity-0'}`}
          />
          <circle
            data-ring="solid"
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className={`${ring} ${RING_FADE} ${look === 'known' || look === 'signedOut' ? 'opacity-100' : 'opacity-0'}`}
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
            // Has to start at 12 o'clock to match the direction people read in (same rule as the larger donut in the detail view)
            transform="rotate(-90 12 12)"
            style={{ strokeDasharray: `${filled} ${C - filled}` }}
            className={`${tone} ${RING_FADE} ${known ? 'opacity-100' : 'opacity-0'}`}
          />
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

/**
 * Where a donut would stand when a machine has no usable agent (owner, 2026-10-18): an empty dashed ring of the donut's
 * size, not the words "No agent", which took the capsule's width and were cut at its edge. The tooltip around it says
 * what it means.
 */
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
 * The tools with a donut, kept through their exit (owner, 2026-10-27: every change is animated): one that goes (a tool
 * uninstalled, a machine's list changing) stays drawn for `LEAVE_MS` with `leaving`, and one that comes after the bar was
 * first drawn is `entering`. The first reading is not an entrance: the bar does not open with every donut fading in.
 */
function useDonutPresence(order: ToolName[] | null): { tool: ToolName; entering: boolean; leaving: boolean }[] {
  const key = order === null ? null : order.join(',')
  const [state, setState] = useState<{ key: string | null; shown: ToolName[]; leaving: ToolName[] }>({ key, shown: order ?? [], leaving: [] })
  const first = useRef<Set<ToolName> | null>(null)
  if (first.current === null && order !== null && order.length > 0) first.current = new Set(order)
  if (state.key !== key) {
    const next = order ?? []
    // Everything drawn that is not in the list now is leaving, one already on its way out included: it keeps its place until its exit ends
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

/**
 * What the dropdown of a signed-out tool's donut holds (owner, 2026-10-27): the setup line, the same piece as in the
 * pickers, with its sign-in for Antigravity and the terminal command for the others.
 */
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
