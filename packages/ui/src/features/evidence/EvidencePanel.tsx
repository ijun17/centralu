import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GitCommit, GitFileStatus } from '@cc/protocol'
import { laneCount, layoutCommits } from '@cc/core'
import { CommitGraph, ROW_H } from '../../components/CommitGraph.jsx'
import { ChevronIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useShortcut } from '../../app/shortcut.js'
import { useStore, type PanelTab } from '../../store/store.js'
import {
  PANEL_TABS,
  PANEL_TAB_MIME,
  moveTab,
  moveTabToGroupEnd,
  splitTab,
  type PanelGroup,
} from '../../store/panelLayout.js'
import { FileTree } from '../files/FileTree.jsx'
import { TerminalPane } from './Terminal.jsx'
import { COMMIT_LIMIT, commitAgo, hasMultipleAuthors } from './commits.js'
import { fitTabs } from './fitTabs.js'
import { TabActionSlot, TabActions } from './tabActions.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, useTextZoom } from '../../store/store.js'

/**
 * The evidence lane (right side).
 *
 * The three lanes each play a different role:
 *   left = observation (what is waiting for me) · center = action (talking to it) ·
 *   right = evidence (did it actually do that)
 *
 * What lives here is not a screen that **replaces** the conversation. It is the place to check the
 * claim when an agent says "I fixed three files." That is why it sits alongside the center tab
 * rather than being one of its tabs.
 *
 * Looking at something closely (code, a diff, a commit) does not happen here — a diff cannot be
 * read at 340px. Clicking it expands into a wide overlay over the conversation.
 *
 * **This lane stays visible while that overlay is open** (issue #15). It used to be covered
 * by it, on the reasoning above — but "a diff needs more than 340px" is a reason not to draw
 * the diff *in here*, not a reason to hide the list that sent you to it. This is where the
 * next file comes from, so covering it turned reading three changed files into three rounds
 * of escape-and-find-it-again.
 */
export function EvidencePanel() {
  const open = useStore((s) => s.panelOpen)
  const projectId = useStore((s) => {
    /*
     * A session with no project (the foreman) **does not fall back to the last project** (a
     * dogfooding finding, 2026-09-06): if the files and git history of the last-viewed project
     * showed up next to the foreman, it would read as if the foreman started in that folder — when
     * it actually runs from the orchestrator's home. The fallback exists for "not viewing any
     * session at all."
     */
    const sess = s.focusedSessionId ? s.sessions[s.focusedSessionId] : null
    return sess ? sess.projectId : s.focusedProjectId
  })
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const width = useStore((s) => s.panelWidth)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  // The minimum width is fixed in real pixels (the same rule as the sidebar) — text zoom does not eat into how narrow it can get
  const zoom = useTextZoom()
  const [resizing, setResizing] = useState(false)
  const isRepo = !!project?.git

  /*
   * ⌘⇧1–4 — switch tab. Settings advertises this under Shortcuts, so it has to keep
   * working when the tabs are rearranged (#20). **The digit follows the tab's identity**
   * (1 git · 2 history · 3 files · 4 terminal — PANEL_TABS order), not its seat in the
   * strip: the shortcut list is static text, and static text can only tell the truth
   * about a mapping that a reorder does not move. Position digits would also silently
   * retarget muscle memory every time a tab is dragged.
   */
  /*
   * The command-run ledger is loaded for this project up front (a carryover from #60). Loading it
   * only once the terminal tab is opened would leave the badge dark right after a UI reload — a dev
   * server that is already running is a fact even before the tab is opened.
   */
  useEffect(() => {
    if (projectId) void useStore.getState().loadCommandRuns(projectId)
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return
      // e.code, not e.key — Shift turns the key value into '!' '@' … (same as App.tsx)
      const digit = /^Digit([1-4])$/.exec(e.code)?.[1]
      if (!digit) return
      const tab = PANEL_TABS[Number(digit) - 1]!
      // Without a repo, git/history stay unreachable by key just as their buttons are disabled
      if ((tab === 'git' || tab === 'history') && !isRepo) return
      e.preventDefault()
      useStore.getState().setPanelTab(tab)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectId, isRepo])

  if (!projectId || !project) return null

  /*
   * **The width slides** on open and close.
   *
   * The collapsed strip and the panel used to be swapped wholesale, and the screen changed abruptly.
   * The eye then could not follow "what went where," and it was momentarily unclear whether
   * something had collapsed or vanished. With the width flowing continuously, it reads on its own
   * as the same thing having collapsed.
   *
   * The transition is turned off while dragging the resize handle — interpolating every frame
   * cannot keep up with the hand and feels sticky.
   */
  return (
    <aside
      className={`relative flex h-full shrink-0 flex-col overflow-hidden border-l border-edge bg-pit ${
        resizing ? '' : 'transition-[width] duration-200 ease-out motion-reduce:transition-none'
      }`}
      style={{ width: open ? width : RAIL_W }}
      data-testid={open ? 'evidence-panel' : 'evidence-rail-shell'}
    >
      {open ? (
        <>
          <ResizeHandle
            side="left"
            min={PANEL_MIN / zoom}
            max={PANEL_MAX}
            onResize={setPanelWidth}
            onReset={() => setPanelWidth(PANEL_DEFAULT)}
            onDraggingChange={setResizing}
            testId="evidence-resize"
          />
          <PanelHeader projectName={project.name} branch={project.git?.branch ?? null} />
          <PanelGroups projectId={projectId} project={project} isRepo={isRepo} />
        </>
      ) : (
        // Leaves a trace even while closed — vanished and collapsed are not the same thing
        <CollapsedRail projectId={projectId} isRepo={!!project.git} />
      )}
    </aside>
  )
}

/** The collapsed strip's width. Has to match what CollapsedRail draws, or the transition breaks continuity */
const RAIL_W = 32

function PanelHeader({ projectName, branch }: { projectName: string; branch: string | null }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const sc = useShortcut()
  const openBranches = useStore((s) => s.openBranches)

  /*
   * The header's height **has to match the conversation side's header** (SessionView's HEADER) —
   * the two stand side by side, and even a 1px mismatch reads as a doubled boundary. Back when this
   * was written as padding, this one came out to 41px and the other to 40px (their contents were
   * 24px and 23px respectively). So it is written as `h-10`, not padding: the two rows stay one row
   * even when their contents change.
   */
  return (
    <DragRegion className="flex h-10 items-center gap-2 border-b border-edge px-3">
      <span className="readout truncate text-[11px] text-ash" data-testid="evidence-project">
        {projectName}
      </span>
      {branch && (
        <button
          className="readout truncate text-[10px] text-slate transition-colors hover:text-chalk"
          onClick={openBranches}
          data-testid="evidence-branch"
          title="Switch branch"
        >
          {branch}
        </button>
      )}
      <span className="ml-auto shrink-0">
      <IconButton
        label={`Collapse panel (${sc('mod', 'B')})`}
        onClick={() => togglePanel(false)}
        testId="evidence-close"
        align="right"
      >
        {/* Collapsing is 'the opposite of expanding', so it wears the same mark — same meaning, same shape */}
        <ChevronIcon open={false} />
      </IconButton>
      </span>
    </DragRegion>
  )
}

/** The gap between tabs (gap-0.5) and the `…` button's width — the two numbers the collapse calculation uses */
const TAB_GAP = 2
const MORE_W = 26

const TAB_LABELS: Record<PanelTab, string> = {
  git: 'Git',
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
function PanelGroups({
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
        className={`relative flex items-center gap-0.5 border-b border-edge px-2 py-1 ${gi > 0 ? 'border-t' : ''}`}
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
          The left side is where to go (tabs), the right side is what to do from where you already
          are (control buttons). When space runs short, the tabs are always what gives way — the
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
              the same ash landing line as every other drop indicator — border-edge was
              measured too faint against the tinted half to read as a boundary at all.
            */
            className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-graphite/30 ${
              groups.length === 1 ? 'top-1/2 shadow-[inset_0_2px_0_0_var(--color-ash)]' : 'top-0'
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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid={gi === 0 ? 'evidence-tabs-more' : `evidence-tabs-more-${gi}`}
        aria-label={`${hidden.length} more tabs`}
        title={hidden.map((t) => TAB_LABELS[t]).join(' · ')}
        className={`rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-graphite/50 hover:text-chalk ${
          open ? 'bg-graphite/50 text-chalk' : 'text-ash'
        }`}
      >
        …
      </button>
      {open && (
        <>
          {/* Closes when clicked outside — the menu itself sits at a higher z below */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            className="cc-drop absolute left-0 top-full z-50 mt-1 min-w-28 overflow-hidden rounded border border-edge bg-panel py-0.5 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
            data-testid={gi === 0 ? 'evidence-tabs-overflow' : `evidence-tabs-overflow-${gi}`}
          >
            {hidden.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`evidence-overflow-tab-${id}`}
                onClick={() => {
                  onPick(id)
                  setOpen(false)
                }}
                className="block w-full px-3 py-1 text-left text-[11px] text-ash transition-colors hover:bg-graphite/50 hover:text-chalk"
              >
                {TAB_LABELS[id]}
              </button>
            ))}
          </div>
        </>
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
      className={`rounded px-2 py-0.5 text-[12px] transition-colors disabled:opacity-40 ${
        active ? 'bg-graphite/50 text-chalk' : 'text-ash hover:text-chalk'
      } ${dropLine(edge)}`}
    >
      {TAB_LABELS[id]}
      {running && (
        <span
          className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-chalk align-middle"
          data-testid="terminal-tab-running"
          aria-label="a command is running"
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
    ? 'shadow-[inset_2px_0_0_0_var(--color-ash)]'
    : 'shadow-[inset_-2px_0_0_0_var(--color-ash)]'
}

/** What one tab shows. The active tab of every group renders through here. */
function TabBody({
  tab,
  projectId,
  project,
}: {
  tab: PanelTab
  projectId: string
  project: { git?: { denied?: boolean } | null }
}) {
  const isRepo = !!project.git

  // The terminal belongs to the project (a directory), so being a git repo is irrelevant
  if (tab === 'terminal') return <TerminalPane projectId={projectId} />

  /*
    Git and history both ask questions of the repository, so neither has an answer
    without one. The tabs are disabled then, but paths still lead here — a saved
    snapshot can restore them, or a non-repo project can move in under a watching tab.
  */
  if (tab === 'files' || !isRepo) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tab !== 'files' && !isRepo && (
          <p className="px-3 py-2 text-[11px] text-slate" data-testid="evidence-not-repo">
            Not a git repository
          </p>
        )}
        <FileTree projectId={projectId} />
      </div>
    )
  }

  if (tab === 'history') return <CommitHistory projectId={projectId} />

  /*
    Git tab: what changed right now, alone. The history strip that used to sit below it
    left with the split feature (#20): it was a fixed-height block, so in a short split
    half it overflowed the group body straight over the next group's tab strip — and the
    History tab (#21) already answers "how did we get here" with a full column to do it in.
  */
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitChanges projectId={projectId} denied={project.git?.denied} />
    </div>
  )
}

/** The vertical strip left behind when the panel is collapsed. Where it went stays visible, and the change count is still readable while collapsed */
function CollapsedRail({ projectId, isRepo }: { projectId: string; isRepo: boolean }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const platform = usePlatform()
  const sc = useShortcut()
  const touched = useGitRefreshKey(projectId)
  const [count, setCount] = useState<number | null>(null)
  // Collapsing the panel must not collapse the fact that "a command is running" (the reason for the #60 carryover)
  const running = useStore((s) => Object.values(s.commandRuns[projectId] ?? {}).some((r) => r.running))

  useEffect(() => {
    if (!isRepo) {
      setCount(null)
      return
    }
    // A response arriving late while switching projects must not draw another project's number
    let alive = true
    platform.git
      .status(projectId)
      .then((f) => alive && setCount(f.length))
      .catch(() => alive && setCount(null))
    return () => {
      alive = false
    }
  }, [platform, projectId, isRepo, touched])

  return (
    /* The shell (width, border, background) belongs to the outer aside — drawing it here too would double the line during the transition */
    <div
      className="flex h-full w-8 shrink-0 flex-col items-center gap-2 py-2"
      data-testid="evidence-rail"
    >
      <button
        className="rounded px-1 py-0.5 text-[12px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
        onClick={() => togglePanel(true)}
        data-testid="evidence-open"
        title={`Expand evidence panel (${sc('mod', 'B')})`}
      >
        ‹
      </button>
      {count !== null && count > 0 && (
        <button
          className="readout rounded px-1 text-[10px] text-ash transition-colors hover:text-chalk"
          onClick={() => togglePanel(true)}
          data-testid="evidence-rail-count"
          title={`${count} changed files`}
        >
          {count}
        </button>
      )}
      {running && (
        <button
          className="flex items-center justify-center rounded px-1 py-1"
          onClick={() => togglePanel(true)}
          data-testid="evidence-rail-running"
          title="A command is running — open the terminal tab"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-chalk" />
        </button>
      )}
      {/* Vertical text — states what the collapsed strip is a strip of */}
      <span
        className="mt-1 text-[10px] text-slate"
        style={{ writingMode: 'vertical-rl' }}
        aria-hidden
      >
        Evidence
      </span>
    </div>
  )
}

/**
 * Changed files — the most frequently viewed list in this app.
 * Only the list and committing happen here; a diff opens up somewhere wide.
 */
function GitChanges({ projectId, denied }: { projectId: string; denied?: boolean }) {
  const platform = usePlatform()
  const openGit = useStore((s) => s.openGit)
  const setToast = useStore((s) => s.setToast)
  /*
   * Writes through the store, reads straight from the platform (issue #49).
   *
   * This panel sits **beside** the sidebar count it was leaving stale — commit here and the
   * number a few pixels to the left kept the old value. `refresh` below stays local because
   * it fetches the file list, which the store does not hold; the store owns the summary.
   */
  const gitStage = useStore((s) => s.gitStage)
  const gitCommit = useStore((s) => s.gitCommit)
  const touched = useGitRefreshKey(projectId)
  const [files, setFiles] = useState<GitFileStatus[] | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  // A request generation number — a response arriving late while switching projects must not draw another project's list
  const statusGen = useRef(0)
  const refresh = useCallback(async () => {
    const gen = ++statusGen.current
    try {
      const next = await platform.git.status(projectId)
      if (gen === statusGen.current) setFiles(next)
    } catch {
      if (gen === statusGen.current) setFiles([])
    }
  }, [platform, projectId])

  // Re-reads whenever an agent touches a file (evidence only means something if it is current)
  useEffect(() => {
    void refresh()
  }, [refresh, touched])

  const unstaged = files?.filter((f) => !f.staged) ?? []
  const staged = files?.filter((f) => f.staged) ?? []

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      // When the RPC throws (disconnect, timeout), nothing caught it and it looked like a success — no silent failures
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col border-b border-edge" data-testid="evidence-git">
      {/* The label 'Changes' was dropped since the tab already says it — only the count and buttons go to the right of the strip */}
      {files && files.length > 0 && (
        <TabActions>
          <span className="readout text-[10px] text-ash" data-testid="evidence-change-count">
            {files.length}
          </span>
          <button
            className="rounded px-1.5 py-0.5 text-[10px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
            onClick={() => openGit()}
            data-testid="evidence-git-full"
            title="Open in wide view"
          >
            Expand
          </button>
        </TabActions>
      )}

      {denied ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-ash" data-testid="evidence-git-denied">
          Folder access permission required — System Settings → Privacy & Security → Files and Folders
        </p>
      ) : files === null ? (
        <p className="px-3 pb-2 text-[11px] text-slate">Loading…</p>
      ) : files.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-slate" data-testid="evidence-clean">
          No changes
        </p>
      ) : (
        <>
          {/*
            Staged and unstaged files are shown **split apart.**
            What will actually go into the commit is the one fact that matters right before
            committing, and mixing them into one list meant reading that off a small tag at the end
            of each row instead. Above the boundary is what goes in, below it is what does not — the
            boundary itself is the answer.
          */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChangeGroup
              title="Staged"
              files={staged}
              onOpen={openGit}
              busy={busy}
              action={{
                id: 'unstage',
                one: 'Unstage',
                all: 'Unstage all',
                run: (paths) => run(() => gitStage(projectId, paths, true)),
              }}
            />
            <ChangeGroup
              title="Changed"
              files={unstaged}
              onOpen={openGit}
              busy={busy}
              action={{
                id: 'stage',
                one: 'Stage',
                all: 'Stage all',
                run: (paths) => run(() => gitStage(projectId, paths)),
              }}
            />
          </div>
        </>
      )}
      {!denied && files !== null && (
        /*
         * Committing has to work in a narrow space too — the flow of checking a change and then
         * wrapping it up right there must not be broken. This block stays even when the list is
         * empty (#160). In the most common sequence of committing and pushing as separate steps,
         * the moment everything got committed and the state became "No changes," Push disappeared
         * along with it — there was no way left in the app to push the commit just made.
         */
        <div className="mt-auto border-t border-edge px-3 py-2">
          <input
            className="w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="evidence-commit-message"
          />
          <div className="mt-1.5 flex gap-1.5">
            <button
              className="flex-1 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
              disabled={busy || !message.trim() || staged.length === 0}
              data-testid="evidence-commit"
              onClick={() =>
                void run(async () => {
                  const r = await gitCommit(projectId, message.trim())
                  setToast(r.ok ? 'Committed' : (r.message ?? 'Commit failed'))
                  if (r.ok) setMessage('')
                })
              }
            >
              Commit
            </button>
            <button
              className="rounded border border-edge px-2 py-1 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk disabled:opacity-40"
              disabled={busy}
              data-testid="evidence-push"
              onClick={() =>
                void run(async () => {
                  const r = await platform.git.push(projectId)
                  setToast(r.ok ? 'Pushed' : (r.message ?? 'Push failed'))
                })
              }
            >
              Push
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/** One group (staged / changed). Renders no header at all when empty */
function ChangeGroup({
  title,
  files,
  onOpen,
  busy,
  action,
}: {
  title: string
  files: GitFileStatus[]
  onOpen: (path: string, staged: boolean) => void
  busy: boolean
  action: { id: 'stage' | 'unstage'; one: string; all: string; run: (paths: string[]) => Promise<void> }
}) {
  if (files.length === 0) return null
  return (
    <section data-testid={`evidence-group-${title.toLowerCase()}`}>
      <header className="sticky top-0 flex items-center gap-1.5 bg-pit px-3 py-1">
        <h4 className="text-[10px] uppercase text-slate">{title}</h4>
        <span className="readout text-[10px] text-slate">{files.length}</span>
        <button
          className="ml-auto text-[10px] text-slate transition-colors hover:text-chalk disabled:opacity-40"
          disabled={busy}
          onClick={() => void action.run(files.map((f) => f.path))}
          data-testid={`evidence-${action.id}-all`}
        >
          {action.all}
        </button>
      </header>
      <ul>
        {files.map((f) => (
          <ChangeRow
            key={f.path}
            file={f}
            onOpen={() => onOpen(f.path, f.staged)}
            busy={busy}
            actionId={action.id}
            actionLabel={action.one}
            onAction={() => void action.run([f.path])}
          />
        ))}
      </ul>
    </section>
  )
}

function ChangeRow({
  file,
  onOpen,
  busy,
  actionId,
  actionLabel,
  onAction,
}: {
  file: GitFileStatus
  onOpen: () => void
  busy: boolean
  actionId: 'stage' | 'unstage'
  actionLabel: string
  onAction: () => void
}) {
  return (
    <li className="group/file relative">
      <button
        className="flex w-full items-center gap-2 px-3 py-1 pr-12 text-left transition-colors hover:bg-graphite/25"
        onClick={onOpen}
        data-testid={`evidence-file-${file.path}`}
        title={`${file.path} — view diff`}
      >
        {/* The kind is told apart by a letter, not a color (strict grayscale) */}
        <span className="readout w-3 shrink-0 text-[10px] text-ash">{statusMark(file.status)}</span>
        <span className="truncate text-[12px] text-ash" dir="rtl">
          {file.path}
        </span>
      </button>
      {/*
        A way to stage or unstage just this one file. Without it, doing "commit everything except
        this one" meant dropping out to the terminal — it must be possible to finish it right where
        it was being reviewed.
      */}
      <button
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] text-slate opacity-0 transition-opacity hover:text-chalk focus:opacity-100 group-hover/file:opacity-100 disabled:opacity-40"
        disabled={busy}
        onClick={onAction}
        data-testid={`evidence-${actionId}-${file.path}`}
        title={`${file.path} ${actionLabel}`}
      >
        {actionLabel}
      </button>
    </li>
  )
}

/**
 * The History tab — the place a person comes to **read** the log (#21).
 *
 * It is also the successor to the History strip that used to live below the git tab. That strip had
 * a fixed height, so with splitting (#20) it covered the neighboring group's tab strip, and since
 * this tab already answers the same question ("how did we get here") with a full vertical column,
 * the strip was removed.
 *
 * **The lines (the lane graph) are now drawn here.** Back at #21, the reason this tab chose dates
 * and dropped the lines was "the graph lives over there (the strip)" — now that "over there" is
 * gone, that premise is gone too. A full-width tab has room for both: the lines state branching and
 * merging, the date states "how long ago." Row height is therefore fixed — the lines only look
 * continuous when they line up exactly at each row's boundary.
 *
 * What opens on click is not reinvented either: `openCommit` already expands the History tab of the
 * wide overlay to that commit (`DiffView` draws the single diff that `git show` returns).
 */
function CommitHistory({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const openCommit = useStore((s) => s.openCommit)
  const touched = useGitRefreshKey(projectId)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)

  useEffect(() => {
    // A response arriving late while switching projects must not draw another project's history
    let alive = true
    platform.git
      .log(projectId, COMMIT_LIMIT)
      .then((c) => alive && setCommits(c))
      .catch(() => alive && setCommits([]))
    return () => {
      alive = false
    }
  }, [platform, projectId, touched])

  // Read once — checking the clock per row would give rows in the same list different reference times
  const now = Date.now()
  const withAuthor = commits ? hasMultipleAuthors(commits) : false
  const graph = useMemo(() => {
    const rows = layoutCommits(commits ?? [])
    return { rows, lanes: laneCount(rows) }
  }, [commits])

  if (commits === null) {
    return (
      <p className="px-3 py-2 text-[11px] text-slate" data-testid="evidence-history">
        Loading…
      </p>
    )
  }
  if (commits.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-slate" data-testid="evidence-history-empty">
        No commits yet
      </p>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="evidence-history">
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {commits.map((c, i) => (
          <li key={c.sha}>
            <button
              /* Fixed height — if rows had different heights, the lines would misalign at row boundaries and look broken */
              className="flex w-full items-center gap-1.5 pr-3 text-left transition-colors hover:bg-graphite/25"
              style={{ height: ROW_H }}
              onClick={() => openCommit(c.sha)}
              data-testid={`history-commit-${c.shortSha}`}
              title={`${c.subject} — ${c.author}`}
            >
              {/* The left padding is the graph's own job (PAD_L) — stacking px-3 on top would push the dot twice as far from the wall */}
              <CommitGraph row={graph.rows[i]!} commit={c} lanes={graph.lanes} head={i === 0} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-ash">{c.subject}</span>
                <span className="readout block truncate text-[10px] text-slate">
                  {[
                    c.shortSha,
                    commitAgo(c.when, now),
                    ...(withAuthor ? [c.author] : []),
                    ...(c.parents.length > 1 ? ['merge'] : []),
                    // Which session made it (#50) — known through observation, without a hook. Absent for a human commit
                    ...(c.sessionName ? [c.sessionName] : []),
                  ].join(' · ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* A list that cuts off silently is a list lying that there are no older commits */}
      {commits.length >= COMMIT_LIMIT && (
        <p
          className="shrink-0 border-t border-edge px-3 py-1.5 text-[10px] text-slate"
          data-testid="evidence-history-cap"
        >
          Newest {COMMIT_LIMIT} commits — older ones are not listed
        </p>
      )}
    </section>
  )
}

/**
 * The single letter in front of a row (user request, 2026-09-10: "a new file shows up as a
 * question mark, but it should show A").
 *
 * git writes a file it does not yet track as `?`, but on screen that reads as **unknown** — when
 * it is actually a known fact (a new file). The letter a person reads should state what happened,
 * the way M, A, D and R do, so it is written as A (added) instead. Whether it is staged is already
 * stated by the group it is in (Staged/Changed), so this letter does not need to say it again.
 *
 * **The data itself is not changed.** The host's `'?'` stays exactly as the fact "not tracked" — only
 * the display is changed here (the same rule the diff's file band follows, keeping the original
 * wording for a copy).
 */
function statusMark(status: GitFileStatus['status']): string {
  return status === '?' ? 'A' : status.toUpperCase()
}

/**
 * The signal that knows when to re-read the list — two signals combined.
 *
 * The count of files an agent touched reports the first edit **during** a turn. That alone was not
 * enough (#160): a `git commit` run through Bash, a command typed into the terminal, or re-editing a
 * file already touched does not change this count. So this also watches `gitEpoch`, which is bumped
 * by the same signals that make the sidebar's summary re-read (turn end, window regaining focus, an
 * approval, switching branches).
 */
function useGitRefreshKey(projectId: string): string {
  const touched = useStore((s) => {
    let n = 0
    for (const sess of Object.values(s.sessions)) {
      if (sess.projectId === projectId) n += sess.touchedPaths.length
    }
    return n
  })
  const epoch = useStore((s) => s.gitEpoch[projectId] ?? 0)
  return `${touched}:${epoch}`
}
