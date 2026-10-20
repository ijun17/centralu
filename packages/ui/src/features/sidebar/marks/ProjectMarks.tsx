import type { ProjectInfo } from '@cc/protocol'
import { Tooltip } from '../../../components/primitives.jsx'
import { formatChangedCount } from '../../../app/format.js'
import { ChangesIcon } from '../../../components/icons.jsx'

/**
 * Marks placed on the name line — they claim no new vertical space.
 *
 * A warning used to live here, "N running in the same folder" (⧉N). It was removed (user request,
 * 2026-09-07): running several sessions in the same folder is **an intentional choice** in this
 * app, and a worktree is the answer if the person actually wants them kept apart. A warning that
 * is always on becomes background noise, not advice.
 */
export function ProjectMarks({ project }: { project: ProjectInfo }) {
  const changed = project.git?.changedFiles ?? 0
  const count = formatChangedCount(changed, project.git?.more)
  const denied = project.git?.denied === true

  return (
    /*
      **Placed right next to the name.** Pushed to the far end with ml-auto, these numbers used to
      read as disconnected from what they were about, sitting far from the name (dogfooding: "what
      is this number?"). Right next to it, it reads as one unit: "22 changes in this project."

      The explanation is given through the **app's own tooltip.** The browser's default title takes
      one or two seconds to appear, and if a person wondering "what is this" has to wait that long,
      they simply stop asking. The fewer units a bare-number mark has, the faster the answer needs
      to come.
    */
    <span className="readout flex shrink-0 items-center gap-1.5 text-2xs text-ink-faint">
      {changed > 0 && (
        <Tooltip
          content={`${count} uncommitted file${changed > 1 ? 's' : ''}`}
          testId={`mark-changed-tip-${project.name}`}
        >
          {/* A capsule with the changes icon and the count (owner, 2026-10-18), the top bar's grammar */}
          <span
            className="flex h-[18px] items-center gap-1 rounded-full border border-line px-1.5 text-ink-faint"
            data-testid={`mark-changed-${project.name}`}
          >
            <ChangesIcon size={11} />
            <span className="translate-y-px leading-none">{count}</span>
          </span>
        </Tooltip>
      )}
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
