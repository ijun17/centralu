import type { ProjectInfo } from '@cc/protocol'
import { isAway } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { formatChangedCount } from '../../../app/format.js'
import { BranchIcon, ChangesIcon } from '../../../components/icons.jsx'

/**
 * Tooltip content: claims no space by default, but answers everything when asked.
 *
 * Since the name line lost its changes count (owner, 2026-10-20) this is where the count lives, so it is drawn to be
 * read at a glance: the branch and the uncommitted files each on a row with their icon, the count in the body ink.
 */
export function ProjectDetail({ project }: { project: ProjectInfo }) {
  const changed = project.git?.changedFiles ?? 0
  /*
   * A linked machine that is away: everything below is what the hub last heard (owner, 2026-10-20). Said first, and the
   * state lines dimmed, so a branch or a count from before the link dropped does not read as the folder's state now.
   */
  const away = useStore((s) => isAway(project, s.machines))
  const machineName = useStore((s) => (project.machine ? (s.machines[project.machine]?.name ?? project.machine) : null))
  return (
    <span className="flex min-w-48 flex-col gap-1.5" data-testid={`project-detail-${project.name}`}>
      {away && (
        <span className="text-ink" data-testid={`project-detail-away-${project.name}`}>
          Not connected to {machineName}, so this is what Centralu last heard and may be out of date.
        </span>
      )}
      <span className="readout block truncate text-ink-faint">{project.path}</span>
      {project.git?.denied ? (
        // Showing this as "not a repo" would lead the person to the wrong conclusion: what is needed is granting permission
        <span className="text-ink" data-testid="git-denied">
          Folder access permission required — System Settings → Privacy & Security → Files and Folders
        </span>
      ) : project.git ? (
        <span className={`flex flex-col gap-1 ${away ? 'opacity-60' : ''}`}>
          <span className="flex items-center gap-1.5 text-ink-muted">
            <BranchIcon />
            <span className="readout truncate text-ink">{project.git.branch}</span>
          </span>
          <span
            className={`flex items-center gap-1.5 ${changed > 0 ? 'text-ink' : 'text-ink-faint'}`}
            data-testid={`project-detail-changed-${project.name}`}
          >
            <ChangesIcon size={12} />
            {changed > 0 ? (
              <span>
                <span className="readout font-medium">{formatChangedCount(changed, project.git.more)}</span>{' '}
                uncommitted {changed === 1 && !project.git.more ? 'file' : 'files'}
                {away ? ' when last heard' : ''}
              </span>
            ) : (
              <span>No uncommitted changes{away ? ' when last heard' : ''}</span>
            )}
          </span>
        </span>
      ) : (
        <span className="text-ink-faint">Not a git repository</span>
      )}
      <span className="border-t border-line pt-1.5 text-ink-muted" data-testid={`project-trust-${project.name}`}>
        {project.trusted ? 'Trusted — its apps can run' : "Not trusted — its apps don't run"}
      </span>
    </span>
  )
}
