import { useEffect, useState } from 'react'
import { BranchIcon, ChevronIcon } from '../../components/icons.jsx'
import { Tooltip } from '../../components/primitives.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useShortcut } from '../../app/shortcut.js'
import { evidenceProjectOf, useStore, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, useTextZoom } from '../../store/store.js'
import { PANEL_TABS } from '../../store/panelLayout.js'
import { DragRegion } from '../../components/DragRegion.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { PanelGroups } from './PanelTabs.jsx'

/**
 * The evidence lane beside the conversation (docs/architecture.md "Why not tabs"). Close reading opens the wide overlay;
 * this lane stays visible under it, since the next file comes from here (#15).
 */
export function EvidencePanel() {
  const open = useStore((s) => s.panelOpen)
  const projectId = useStore(evidenceProjectOf)
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const width = useStore((s) => s.panelWidth)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  // The minimum width is in real pixels, as the sidebar's: text zoom does not narrow it
  const zoom = useTextZoom()
  const [resizing, setResizing] = useState(false)
  const isRepo = !!project?.git

  // Loaded up front (#60), so a dev server already running lights the badge after a UI reload, before the tab opens
  useEffect(() => {
    if (projectId) void useStore.getState().loadCommandRuns(projectId)
  }, [projectId])

  // ⌘⇧1–4 pick a tab by identity (PANEL_TABS order), not its seat (#20): the shortcut list is static text, and seat digits
  // would retarget muscle memory after every drag.
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

  // The width slides on open and close (docs/design-system.md §9), except while the handle drags: it would lag the hand.
  return (
    <aside
      className={`relative flex h-full min-w-0 shrink flex-col overflow-hidden border-l border-line-chrome bg-surface-side ${
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
        <CollapsedRail />
      )}
    </aside>
  )
}

/** The collapse and expand marks: one size, larger than a row's disclosure arrow, since they move a whole panel */
const PANEL_FOLD_ICON = 16

/** Matches CollapsedRail's `w-8`, or the transition jumps */
const RAIL_W = 32

function PanelHeader({ projectName, branch }: { projectName: string; branch: string | null }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const sc = useShortcut()
  const openBranches = useStore((s) => s.openBranches)

  // `h-10`, not padding, so it matches SessionHeader's HEADER beside it whatever their contents: padding gave 41px against
  // 40px, and a 1px step reads as a doubled boundary.
  return (
    <DragRegion className="flex h-10 items-center gap-2 border-b border-line-chrome px-3">
      {/* A name the person gave, so the UI face; the branch is git's own word, so the code face */}
      <span className="truncate text-sm text-ink" data-testid="evidence-project">
        {projectName}
      </span>
      {branch && (
        <Tooltip content="Switch branch">
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
            onClick={openBranches}
            data-testid="evidence-branch"
          >
            <BranchIcon size={12} />
            <span className="readout truncate">{branch}</span>
          </button>
        </Tooltip>
      )}
      {/* A flex box, not an inline span: a line box would sit the button 2px above the header's middle, where the rail's expand button is */}
      <span className="ml-auto flex shrink-0">
        <IconButton
          label={`Collapse panel (${sc('mod', 'B')})`}
          onClick={() => togglePanel(false)}
          testId="evidence-close"
          align="right"
        >
          {/* The expand mark turned round: the opposite act, the same shape */}
          <ChevronIcon open={false} size={PANEL_FOLD_ICON} />
        </IconButton>
      </span>
    </DragRegion>
  )
}

/**
 * The expand button where the collapse button was, the same mark turned round. No count, label or running dot: the
 * sidebar's changes capsule already says what changed, and a label would name the panel by its internal name.
 */
function CollapsedRail() {
  const togglePanel = useStore((s) => s.togglePanel)
  const sc = useShortcut()

  return (
    /* The outer aside draws the shell; drawing it here too would double the line during the transition */
    <div className="flex h-full w-8 shrink-0 flex-col items-center" data-testid="evidence-rail">
      {/* The header's height (h-10), so the button sits exactly where the collapse button was */}
      <DragRegion className="flex h-10 w-full shrink-0 items-center justify-center">
        <IconButton
          label={`Expand panel (${sc('mod', 'B')})`}
          onClick={() => togglePanel(true)}
          testId="evidence-open"
          align="right"
        >
          <span className="inline-flex rotate-180">
            <ChevronIcon open={false} size={PANEL_FOLD_ICON} />
          </span>
        </IconButton>
      </DragRegion>
    </div>
  )
}
