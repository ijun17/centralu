import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDismiss } from '../../components/useDismiss.js'
import { usePresence } from '../../components/presence.js'
import { IconButton } from '../../components/IconButton.jsx'
import { DotsIcon } from '../../components/icons.jsx'
import { useStore, type PanelTab } from '../../store/store.js'
import {
  PANEL_TAB_MIME,
  moveTab,
  moveTabToGroupEnd,
  splitTab,
  type PanelGroup,
} from '../../store/panelLayout.js'
import { fitTabs } from './fitTabs.js'
import { TabActionSlot } from './tabActions.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { TabBody } from './TabBody.jsx'

/** The gap between tabs (gap-0.5) and the `…` button's width (an IconButton: 14px icon, p-1) — the two numbers the collapse calculation uses */
const TAB_GAP = 2
const MORE_W = 22

const TAB_LABELS: Record<PanelTab, string> = {
  // The tab is named for what it shows, the working tree's changes (owner, 2026-10-19); its id stays `git`
  git: 'Changes',
  history: 'History',
  files: 'Files',
  terminal: 'Terminal',
}

/**
 * The tab groups, stacked vertically (#20). One group is the everyday panel. Dragging
 * a tab to the bottom half of the body splits a second group off; dragging the bottom
 * group's last tab back to a strip dissolves it. Every arrangement change goes through
 * the pure functions in store/panelLayout.ts and lands in the store, which persists it
 * globally — the panel is a way of looking, so there is one arrangement for the whole
 * app and it survives a relaunch (the #20 decision).
 */
export function PanelGroups({
  projectId,
  project,
  isRepo,
}: {
  projectId: string
  project: { git?: { denied?: boolean } | null }
  isRepo: boolean
}) {
  const groups = useStore((s) => s.panelLayout)
  const setPanelLayout = useStore((s) => s.setPanelLayout)

  return (
    <>
      {groups.map((g, gi) => (
        <TabGroup
          key={gi}
          gi={gi}
          group={g}
          groups={groups}
          isRepo={isRepo}
          onLayout={setPanelLayout}
          projectId={projectId}
          project={project}
        />
      ))}
    </>
  )
}

/** One group: its strip of tabs, then whichever tab is active in it */
function TabGroup({
  gi,
  group,
  groups,
  isRepo,
  onLayout,
  projectId,
  project,
}: {
  gi: number
  group: PanelGroup
  groups: PanelGroup[]
  isRepo: boolean
  onLayout: (groups: PanelGroup[]) => void
  projectId: string
  project: { git?: { denied?: boolean } | null }
}) {
  const setPanelTab = useStore((s) => s.setPanelTab)
  const panelSplit = useStore((s) => s.panelSplit)
  const setPanelSplit = useStore((s) => s.setPanelSplit)
  const [splitHint, setSplitHint] = useState(false)
  /** The bottom group's tab strip — the boundary between the two groups is this strip's top edge, so the resize handle lives here */
  const stripRef = useRef<HTMLElement>(null)
  /** Where this group's control buttons are drawn (tabActions.tsx) — the body renders here through a portal */
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null)

  /*
   * How many tabs fit. What is measured is **the space the tabs are allowed to use** (fitRef), not
   * the whole strip — the control buttons on the right never collapse, so that space was never the
   * tabs' to claim, and this space's own width does not change whether the `…` button appears or
   * disappears, so the calculation does not get shaken by its own result.
   *
   * Widths are measured entirely in layout pixels (offsetWidth, clientWidth). `rect` is a screen
   * pixel already multiplied by zoom (--text-zoom), and mixing the two would throw things off while
   * zoomed (the same rule as this file's boundary resize handle).
   */
  const fitRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  const [widths, setWidths] = useState<Partial<Record<PanelTab, number>>>({})
  const measure = useCallback((id: PanelTab, w: number) => {
    if (w <= 0) return
    // Returns the same object for the same value — otherwise it loops measure → render → measure
    setWidths((prev) => (Math.abs((prev[id] ?? -1) - w) < 0.5 ? prev : { ...prev, [id]: w }))
  }, [])

  useLayoutEffect(() => {
    const el = fitRef.current
    if (!el) return
    const read = () => setAvail(el.clientWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { shown, hidden } = useMemo(
    () =>
      fitTabs(group.tabs, (t) => widths[t] ?? 0, avail, group.active, {
        gap: TAB_GAP,
        more: MORE_W,
      }),
    [group.tabs, group.active, avail, widths],
  )

  return (
    <>
      <nav
        ref={stripRef}
        className={`relative flex items-center gap-0.5 border-b border-line px-2 py-1 ${gi > 0 ? 'border-t' : ''}`}
        data-testid={gi === 0 ? 'evidence-tabs' : `evidence-tabs-${gi}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANEL_TAB_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(e) => {
          // Dropped on the strip but not on a tab: the tab joins this group's end.
          // This is also the unsplit gesture — the bottom group's last tab dragged up
          // here empties that group, and an empty group stops existing.
          const dragged = e.dataTransfer.getData(PANEL_TAB_MIME) as PanelTab
          if (!dragged) return
          e.preventDefault()
          onLayout(moveTabToGroupEnd(groups, dragged, gi))
        }}
      >
        {/*
          The boundary resize handle (moved here after a second dogfooding finding). It originally
          sat on the top edge of the bottom body, but that was **below the tab strip**, not the "the
          boundary between the two panels" — the space between the top body and the bottom tab strip
          — that a person actually grabs for. The boundary is this strip's top edge.

          Why the calculation runs entirely on ratios: `rect` is a screen pixel multiplied by zoom
          (--text-zoom), while offsetHeight is a layout pixel, and mixing them throws things off
          while zoomed — measuring everything with `rect` and taking only the ratio cancels the unit
          out.
        */}
        {gi === 1 && (
          <ResizeHandle
            side="top"
            testId="panel-split-handle"
            min={15}
            max={85}
            onReset={() => setPanelSplit(0.5)}
            onResize={(v) => {
              // ResizeHandle's contract: v = the bottom of the element the handle is attached to (this strip) minus the pointer's y
              const strip = stripRef.current
              const col = strip?.parentElement
              const b0 = col?.querySelector<HTMLElement>('[data-testid="evidence-body-0"]')
              const b1 = col?.querySelector<HTMLElement>('[data-testid="evidence-body-1"]')
              if (!strip || !b0 || !b1) return
              const r0 = b0.getBoundingClientRect()
              const total = r0.height + b1.getBoundingClientRect().height
              const boundaryY = strip.getBoundingClientRect().bottom - v
              if (total > 0) setPanelSplit((boundaryY - r0.top) / total)
            }}
          />
        )}
        {/*
          The left side is where to go (tabs), the right side is what to do from where the person
          already is (control buttons). When space runs short, the tabs are always what gives way — the
          control buttons are actions on what is being looked at and must stay within reach, and a
          pushed-out tab can still be picked by name behind `…`.
        */}
        <div ref={fitRef} className="flex min-w-0 flex-1 items-center gap-0.5">
          <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            {shown.map((id) => (
              <TabButton
                key={id}
                id={id}
                active={group.active === id}
                // Repo questions have no answer without a repo (#21) — and a disabled button
                // also fires no drag events, so these tabs are arranged from repo projects
                disabled={(id === 'git' || id === 'history') && !isRepo}
                groups={groups}
                onLayout={onLayout}
                onPick={setPanelTab}
                projectId={projectId}
                onMeasure={measure}
              />
            ))}
          </div>
          {hidden.length > 0 && <MoreTabs gi={gi} hidden={hidden} onPick={setPanelTab} />}
        </div>
        <div
          ref={setActionSlot}
          className="flex shrink-0 items-center gap-1 pl-1"
          /* Does not use 'evidence-tab-' in its name — there is a place that scans the tab list by that prefix */
          data-testid={gi === 0 ? 'evidence-actions' : `evidence-actions-${gi}`}
        />
      </nav>
      <div
        /*
          overflow-hidden is the wall that protects the neighboring group. Without it, content from
          the group above overflowing its body **got drawn on top of the tab strip of the group
          below** (this actually happened with the git tab's fixed-height History strip — a
          dogfooding finding). The rule that a tab, whatever it draws, cannot escape its own body is
          enforced by the container, not by the content.
        */
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        /*
          Each split body's share (dogfooding: a fixed 50/50 split could not express "the terminal
          can stay narrow but a diff needs to be wide"). The tab strip has a fixed height, so flexGrow
          only divides space between the bodies — basis stays at flex-1's 0, so the grow ratio is
          exactly the height ratio.
        */
        style={groups.length === 2 ? { flexGrow: gi === 0 ? panelSplit : 1 - panelSplit } : undefined}
        data-testid={`evidence-body-${gi}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANEL_TAB_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const r = e.currentTarget.getBoundingClientRect()
          // One group: only the bottom half is a target (that is what "split" means here).
          // Two groups: this whole body adopts the dropped tab — the halves are taken.
          setSplitHint(groups.length > 1 || e.clientY > r.top + r.height / 2)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setSplitHint(false)
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData(PANEL_TAB_MIME) as PanelTab
          setSplitHint(false)
          if (!dragged) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          if (groups.length === 1) {
            if (e.clientY > r.top + r.height / 2) onLayout(splitTab(groups, dragged))
          } else {
            onLayout(moveTabToGroupEnd(groups, dragged, gi))
          }
        }}
      >
        <TabActionSlot value={actionSlot}>
          <TabBody tab={group.active} projectId={projectId} project={project} />
        </TabActionSlot>
        {splitHint && (
          <div
            /*
              The boundary is the meaning ("this half becomes the split"), so it wears
              the same focus-coloured landing line as every other drop indicator — border-line was
              measured too faint against the tinted half to read as a boundary at all.
            */
            className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-surface-hover/30 ${
              groups.length === 1 ? 'top-1/2 shadow-[inset_0_2px_0_0_var(--color-focus)]' : 'top-0'
            }`}
            data-testid="evidence-split-hint"
          />
        )}
      </div>
    </>
  )
}

/**
 * The pointer decides left/right the way the sidebar decides top/bottom (reorder.ts
 * `dropsBefore`): the boundary at the middle gives each outcome half the button, so
 * the hand can predict which side it gets.
 */
const dropsLeft = (rect: { left: number; width: number }, clientX: number): boolean =>
  clientX < rect.left + rect.width / 2

/**
 * The collapsed tabs (`…`).
 *
 * They only collapsed for lack of room; they have not disappeared — this is where they can be
 * picked by name. The list drops down below the strip, not inside it: the strip collapsed them
 * because it ran out of width, so expanding a list inside it would just recreate the same problem.
 */
function MoreTabs({ gi, hidden, onPick }: { gi: number; hidden: PanelTab[]; onPick: (t: PanelTab) => void }) {
  const [open, setOpen] = useState(false)
  // The wrapper holds the trigger and the list: a press inside either is not an outside press
  const wrapRef = useRef<HTMLDivElement>(null)
  const { shown, leaving } = usePresence(open)

  useDismiss({
    open,
    onClose: () => setOpen(false),
    refs: [wrapRef],
    returnFocusTo: wrapRef.current?.querySelector('button') ?? null,
  })

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <IconButton
        label={`${hidden.length} more tabs`}
        onClick={() => setOpen((o) => !o)}
        testId={gi === 0 ? 'evidence-tabs-more' : `evidence-tabs-more-${gi}`}
        lit={open}
      >
        <DotsIcon />
      </IconButton>
      {shown && (
        <div
          role="menu"
          className={`${leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'} absolute left-0 top-full z-50 mt-1 min-w-28 overflow-hidden rounded-lg border border-line bg-surface-raised p-1 shadow-(--shadow-popover)`}
          data-testid={gi === 0 ? 'evidence-tabs-overflow' : `evidence-tabs-overflow-${gi}`}
        >
          {hidden.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              data-testid={`evidence-overflow-tab-${id}`}
              onClick={() => {
                onPick(id)
                setOpen(false)
              }}
              className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/60 hover:text-ink"
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TabButton({
  id,
  active,
  disabled,
  groups,
  onLayout,
  onPick,
  projectId,
  onMeasure,
}: {
  id: PanelTab
  active: boolean
  disabled: boolean
  groups: PanelGroup[]
  onLayout: (groups: PanelGroup[]) => void
  onPick: (tab: PanelTab) => void
  projectId: string
  /** Reports its own width to the strip — the strip uses these numbers to count how many fit */
  onMeasure?: (id: PanelTab, width: number) => void
}) {
  // Each button keeps its own drop edge so the line is drawn on that button only —
  // the same call as the sidebar rows, for the same reason.
  const [edge, setEdge] = useState<'left' | 'right' | null>(null)
  /*
   * The terminal tab's running badge (a carryover from #60) — even with a dev server left running
   * while looking at another tab, the fact that "it is running" has to stay visible on the tab. This
   * gap (nothing shown once the terminal window was closed) was the reason for the carryover.
   */
  const running = useStore((s) =>
    id === 'terminal' ? Object.values(s.commandRuns[projectId] ?? {}).some((r) => r.running) : false,
  )

  return (
    <button
      ref={(el) => {
        // Width changes when the text size (--text-zoom) changes — it is watched continuously instead of measured just once
        if (!el || !onMeasure) return
        onMeasure(id, el.offsetWidth)
        const ro = new ResizeObserver(() => onMeasure(id, el.offsetWidth))
        ro.observe(el)
        return () => ro.disconnect()
      }}
      onClick={() => onPick(id)}
      data-testid={`evidence-tab-${id}`}
      disabled={disabled}
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.setData(PANEL_TAB_MIME, id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANEL_TAB_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setEdge(dropsLeft(e.currentTarget.getBoundingClientRect(), e.clientX) ? 'left' : 'right')
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        const dragged = e.dataTransfer.getData(PANEL_TAB_MIME) as PanelTab
        setEdge(null)
        if (!dragged) return
        e.preventDefault()
        e.stopPropagation()
        onLayout(moveTab(groups, dragged, id, dropsLeft(e.currentTarget.getBoundingClientRect(), e.clientX)))
      }}
      className={`rounded-md px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${
        active
          ? 'bg-surface-selected text-ink'
          : 'text-ink-muted enabled:hover:bg-surface-hover/60 enabled:hover:text-ink'
      } ${dropLine(edge)}`}
    >
      {TAB_LABELS[id]}
      {running && (
        <span
          className="breathe ml-1 inline-block size-1.5 rounded-full bg-ink align-middle"
          data-testid="terminal-tab-running"
          role="img"
          aria-label="A command is running"
        />
      )}
    </button>
  )
}

/**
 * The drop position, as an inset shadow on the target's edge — a border would grow the
 * button 2px and nudge the whole strip while dragging (the sidebar learned this the
 * hard way; see its dropLine).
 */
function dropLine(edge: 'left' | 'right' | null): string {
  if (!edge) return ''
  return edge === 'left'
    ? 'shadow-[inset_2px_0_0_0_var(--color-focus)]'
    : 'shadow-[inset_-2px_0_0_0_var(--color-focus)]'
}
