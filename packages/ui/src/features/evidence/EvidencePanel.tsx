import { useEffect, useState } from 'react'
import { BranchIcon, ChevronIcon } from '../../components/icons.jsx'
import { Tooltip } from '../../components/primitives.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useShortcut } from '../../app/shortcut.js'
import { useStore, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, useTextZoom } from '../../store/store.js'
import { PANEL_TABS } from '../../store/panelLayout.js'
import { DragRegion } from '../../components/DragRegion.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { PanelGroups } from './PanelTabs.jsx'

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
     * A session with no project (the orchestrator, a coordinator) **does not fall back to the last
     * project** (a dogfooding finding, 2026-09-06): if the files and git history of the last-viewed
     * project showed up next to it, it would read as if that session started in that folder — when
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
      className={`relative flex h-full shrink-0 flex-col overflow-hidden border-l border-line bg-surface-side ${
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

/** The collapsed strip's width. Has to match what CollapsedRail draws, or the transition breaks continuity */
const RAIL_W = 32

function PanelHeader({ projectName, branch }: { projectName: string; branch: string | null }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const sc = useShortcut()
  const openBranches = useStore((s) => s.openBranches)

  /*
   * The header's height **has to match the conversation side's header** (SessionHeader's HEADER) —
   * the two stand side by side, and even a 1px mismatch reads as a doubled boundary. Back when this
   * was written as padding, this one came out to 41px and the other to 40px (their contents were
   * 24px and 23px respectively). So it is written as `h-10`, not padding: the two rows stay one row
   * even when their contents change.
   */
  return (
    <DragRegion className="flex h-10 items-center gap-2 border-b border-line px-3">
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
          {/* Collapsing is 'the opposite of expanding', so it wears the same mark — same meaning, same shape */}
          <ChevronIcon open={false} size={PANEL_FOLD_ICON} />
        </IconButton>
      </span>
    </DragRegion>
  )
}

/**
 * The strip left behind when the panel is collapsed: the expand button where the collapse button was, the same
 * component and the same mark turned the other way. No count, no label and no running dot (owner, 2026-10-19): the
 * sidebar's changes capsule already says what changed, and a label named the panel by its internal name
 */
function CollapsedRail() {
  const togglePanel = useStore((s) => s.togglePanel)
  const sc = useShortcut()

  return (
    /* The shell (width, border, background) belongs to the outer aside — drawing it here too would double the line during the transition */
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
