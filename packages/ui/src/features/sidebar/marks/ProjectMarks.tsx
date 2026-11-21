import type { ProjectInfo } from '@cc/protocol/client'
import { Tooltip } from '../../../components/primitives.jsx'

/**
 * Marks on the name line, next to the name so they read as one unit. No "N running in the same folder" warning:
 * sharing a folder is intended (a worktree keeps sessions apart), and an always-on warning is noise.
 */
export function ProjectMarks({ project }: { project: ProjectInfo }) {
  const denied = project.git?.denied === true

  return (
    // The app's own tooltip: the browser's title takes a second or two to appear
    <span className="readout flex shrink-0 items-center gap-1.5 text-2xs text-ink-faint">
      {/*
        No changes count: the project's tooltip (ProjectDetail) says it
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
