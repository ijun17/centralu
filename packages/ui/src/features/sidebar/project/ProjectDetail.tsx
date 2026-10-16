import type { ProjectInfo } from '@cc/protocol'
import { formatChangedCount } from '../../../app/format.js'

/** Tooltip content — claims no space by default, but answers everything when asked */
export function ProjectDetail({ project }: { project: ProjectInfo }) {
  return (
    <span className="block" data-testid={`project-detail-${project.name}`}>
      <span className="readout block truncate text-ink-faint">{project.path}</span>
      <span className="mt-1 block" data-testid={`project-trust-${project.name}`}>
        {project.trusted ? 'Trusted — its apps can run' : "Not trusted — its apps don't run"}
      </span>
      <span className="mt-1 block">
        {project.git?.denied ? (
          // Showing this as "not a repo" would lead the person to the wrong conclusion — what is actually needed is granting permission
          <span className="text-ink" data-testid="git-denied">
            Folder access permission required — System Settings → Privacy & Security → Files and Folders
          </span>
        ) : project.git ? (
          <>
            <span className="text-ink">{project.git.branch}</span>
            {project.git.changedFiles > 0 && <span> · {formatChangedCount(project.git.changedFiles, project.git.more)} changed</span>}
          </>
        ) : (
          <span>not a git repo</span>
        )}
      </span>
    </span>
  )
}
