import { useEffect } from 'react'
import { PlayIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useStore } from '../../store/store.js'

/**
 * The button that opens frequently used commands (issue #44, expanded into a window in #60).
 *
 * The reason the open state is held by the pane is unchanged: in the grid, this header is the
 * handle (`draggable`) used to move the pane, so dragging must be disabled while the window is
 * open.
 *
 * Listing, registering, running and logs have all moved to CommandRunnerOverlay — the small
 * popover in the header had no room to show logs (#60). All that is left here is the button
 * that opens it.
 *
 * However, **the icon lights up white while something is running** (requested by a user on
 * 2026-09-07). Closing the window used to make the fact that something was running disappear
 * from this header — this reads the same record the terminal tab and the collapsed strip's
 * dot read, so the door doubles as an indicator light.
 */
export function RunMenu({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const running = useStore((s) => Object.values(s.commandRuns[projectId] ?? {}).some((r) => r.running))

  /*
   * Reads the record here too. The evidence panel reads it when the project changes, but the
   * grid has no evidence panel, and right after the UI is freshly launched the record stays
   * empty until the window is opened once — otherwise the icon stays gray even while a dev
   * server is running, making it **an indicator light that lies**.
   */
  useEffect(() => {
    void useStore.getState().loadCommandRuns(projectId)
  }, [projectId])

  return (
    <IconButton
      label={running ? 'Saved commands — one is running' : 'Saved commands — run with live logs'}
      onClick={() => onOpenChange(!open)}
      testId="run-open"
      align="right"
      lit={running}
    >
      <PlayIcon />
    </IconButton>
  )
}
