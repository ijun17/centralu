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
import { dropsLeft } from '../sidebar/reorder.js'

/** For fitTabs: the gap between tabs (gap-0.5) and the `…` button's width (14px icon, p-1) */
const TAB_GAP = 2
const MORE_W = 22

const TAB_LABELS: Record<PanelTab, string> = {
  // Named for what it shows, the working tree's changes; its id stays `git`
  git: 'Changes',
  history: 'History',
  files: 'Files',
  terminal: 'Terminal',
}

/**
 * The tab groups, stacked (#20): a tab dragged onto the body's lower half splits off a second group, and the bottom group's
 * last tab dragged back dissolves it. One arrangement for the whole app, kept across relaunches (store/panelLayout.ts).
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
  /** The bottom group's strip: its top edge is the boundary, so the resize handle lives here */
  const stripRef = useRef<HTMLElement>(null)
  /** This group's control buttons (tabActions.tsx), portalled from the body */
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null)

  // Measures the space the tabs may use (fitRef), not the strip: the buttons never collapse, and its width does not move
  // with `…`, so the count is not shaken by its own result. Layout pixels only: `rect` is already multiplied by --text-zoom.
  const fitRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  const [widths, setWidths] = useState<Partial<Record<PanelTab, number>>>({})
  const measure = useCallback((id: PanelTab, w: number) => {
    if (w <= 0) return
    // The same object for the same value, or measure and render loop
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
          // Off any tab: the tab joins this group's end. The bottom group's last tab dragged here unsplits.
          const dragged = e.dataTransfer.getData(PANEL_TAB_MIME) as PanelTab
          if (!dragged) return
          e.preventDefault()
          onLayout(moveTabToGroupEnd(groups, dragged, gi))
        }}
      >
        {/*
          On this strip's top edge, the boundary a person grabs. Ratios of `rect` only: `rect` is zoomed, offsetHeight is not.
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
          Tabs on the left give way to the buttons on the right (fitTabs).
        */}
        <div ref={fitRef} className="flex min-w-0 flex-1 items-center gap-0.5">
          <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            {shown.map((id) => (
              <TabButton
                key={id}
                id={id}
                active={group.active === id}
                // No repo, no answer (#21); a disabled button fires no drag events, so these are arranged from repo projects
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
          /* Not 'evidence-tab-…': something scans the tab list by that prefix */
          data-testid={gi === 0 ? 'evidence-actions' : `evidence-actions-${gi}`}
        />
      </nav>
      <div
        /* overflow-hidden: the container, not each tab, keeps overflow off the next group's strip */
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        /* Each body's share: strips are fixed height and basis is 0, so the grow ratio is the height ratio */
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
            /* The focus-coloured landing line of every drop indicator: border-line was too faint on the tinted half */
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

/** The collapsed tabs, picked by name from a list below the strip, which has no width to spare */
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
  onMeasure?: (id: PanelTab, width: number) => void
}) {
  // Each button keeps its own drop edge, so the line draws on that button only (as the sidebar rows)
  const [edge, setEdge] = useState<'left' | 'right' | null>(null)
  // The running badge (#60) stays on the tab while another tab shows or the terminal is closed
  const running = useStore((s) =>
    id === 'terminal' ? Object.values(s.commandRuns[projectId] ?? {}).some((r) => r.running) : false,
  )

  return (
    <button
      ref={(el) => {
        // Watched, not measured once: --text-zoom changes it
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

/** An inset shadow, not a border: a border grows the button 2px and nudges the strip mid-drag (as the sidebar's dropLine) */
function dropLine(edge: 'left' | 'right' | null): string {
  if (!edge) return ''
  return edge === 'left'
    ? 'shadow-[inset_2px_0_0_0_var(--color-focus)]'
    : 'shadow-[inset_-2px_0_0_0_var(--color-focus)]'
}
