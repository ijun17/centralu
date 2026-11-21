import type { ProjectInfo } from '@cc/protocol/client'
import { Tooltip } from '../../../components/primitives.jsx'

/**
 * Marks placed on the name line — they claim no new vertical space.
 *
 * No "N running in the same folder" warning (owner, 2026-09-07): running several sessions in the
 * same folder is **an intentional choice** in this app, and a worktree is the answer if the person actually wants them kept apart. A warning that
 * is always on becomes background noise, not advice.
 */
export function ProjectMarks({ project }: { project: ProjectInfo }) {
  const denied = project.git?.denied === true

  return (
    /*
      **Placed right next to the name.** Pushed to the far end with ml-auto, a mark reads as
      disconnected from what it is about. Right next to the name, the two read as one unit.

      The explanation is given through the **app's own tooltip.** The browser's default title takes
      one or two seconds to appear, and if a person wondering "what is this" has to wait that long,
      they simply stop asking. The fewer units a bare-number mark has, the faster the answer needs
      to come.
    */
    <span className="readout flex shrink-0 items-center gap-1.5 text-2xs text-ink-faint">
      {/*
        No changes count on the name line (owner, 2026-10-20): it would take the line's room for little, and the
        project's tooltip (ProjectDetail) says it, more plainly
      */}
      {denied && (
        <Tooltip content="Folder access permission required" testId={`git-denied-tip-${project.name}`}>
          <span className="text-ink-muted" data-testid={`git-denied-${project.name}`}>
            !
          </span>
        </Tooltip>
      )}
    </span>
  )
}
