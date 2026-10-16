import { useEffect, useState } from 'react'
import { changedFileCount } from '@cc/protocol'
import { ChevronIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useShortcut } from '../../app/shortcut.js'
import { useStore, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, useTextZoom } from '../../store/store.js'
import { PANEL_TABS } from '../../store/panelLayout.js'
import { DragRegion } from '../../components/DragRegion.jsx'
import { useLoad } from '../../app/useLoad.js'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { PanelGroups } from './PanelTabs.jsx'
import { useGitRefreshKey } from './GitChanges.jsx'

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
   * The header's height **has to match the conversation side's header** (SessionHeader's HEADER) —
   * the two stand side by side, and even a 1px mismatch reads as a doubled boundary. Back when this
   * was written as padding, this one came out to 41px and the other to 40px (their contents were
   * 24px and 23px respectively). So it is written as `h-10`, not padding: the two rows stay one row
   * even when their contents change.
   */
  return (
    <DragRegion className="flex h-10 items-center gap-2 border-b border-line px-3">
      <span className="readout truncate text-xs text-ink-muted" data-testid="evidence-project">
        {projectName}
      </span>
      {branch && (
        <button
          className="readout truncate text-2xs text-ink-faint transition-colors hover:text-ink"
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

/** The vertical strip left behind when the panel is collapsed. Where it went stays visible, and the change count is still readable while collapsed */
function CollapsedRail({ projectId, isRepo }: { projectId: string; isRepo: boolean }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const platform = usePlatform()
  const sc = useShortcut()
  const touched = useGitRefreshKey(projectId)
  // Collapsing the panel must not collapse the fact that "a command is running" (the reason for the #60 carryover)
  const running = useStore((s) => Object.values(s.commandRuns[projectId] ?? {}).some((r) => r.running))

  // A response arriving late while switching projects must not draw another project's number (`useLoad`). A failed
  // read shows no number: the rail has no room to say why, and the panel says it once opened
  const files = useLoad(() => (isRepo ? platform.git.status(projectId) : null), [platform, projectId, isRepo], [touched])
  const count = files.data ? changedFileCount(files.data) : null

  return (
    /* The shell (width, border, background) belongs to the outer aside — drawing it here too would double the line during the transition */
    <div
      className="flex h-full w-8 shrink-0 flex-col items-center gap-2 py-2"
      data-testid="evidence-rail"
    >
      <button
        className="rounded-md px-1 py-0.5 text-sm text-ink-faint transition-colors hover:bg-surface-hover/50 hover:text-ink"
        onClick={() => togglePanel(true)}
        data-testid="evidence-open"
        title={`Expand evidence panel (${sc('mod', 'B')})`}
      >
        ‹
      </button>
      {count !== null && count > 0 && (
        <button
          className="readout rounded-md px-1 text-2xs text-ink-muted transition-colors hover:text-ink"
          onClick={() => togglePanel(true)}
          data-testid="evidence-rail-count"
          title={`${count} changed files`}
        >
          {count}
        </button>
      )}
      {running && (
        <button
          className="flex items-center justify-center rounded-md px-1 py-1"
          onClick={() => togglePanel(true)}
          data-testid="evidence-rail-running"
          title="A command is running — open the terminal tab"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-ink" />
        </button>
      )}
      {/* Vertical text — states what the collapsed strip is a strip of */}
      <span
        className="mt-1 text-2xs text-ink-faint"
        style={{ writingMode: 'vertical-rl' }}
        aria-hidden
      >
        Evidence
      </span>
    </div>
  )
}
