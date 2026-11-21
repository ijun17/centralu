import type { ProjectInfo } from '@cc/protocol/client'
import { isAway } from '@cc/core'
import { useMachineName } from '../../../store/selectors.js'
import { useStore } from '../../../store/store.js'
import { formatChangedCount } from '../../../app/format.js'
import { BranchIcon, ChangesIcon } from '../../../components/icons.jsx'

/** A project's tooltip, where its changes count lives (the name line has none): branch and changes, each with its icon */
export function ProjectDetail({ project }: { project: ProjectInfo }) {
  const changed = project.git?.changedFiles ?? 0
  // An away machine: what follows is what the hub last heard, so it is said first and the state lines are dimmed
  const away = useStore((s) => isAway(project, s.machines))
  const machineName = useMachineName(project.machine)
  return (
    <span className="flex min-w-48 flex-col gap-1.5" data-testid={`project-detail-${project.name}`}>
      {away && (
        <span className="text-ink" data-testid={`project-detail-away-${project.name}`}>
          Not connected to {machineName}, so this is what Centralu last heard and may be out of date.
        </span>
      )}
      <span className="readout block truncate text-ink-faint">{project.path}</span>
      {project.git?.denied ? (
        // Not "not a repo": what is needed is granting permission
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
        {project.trusted ? 'Trusted — its apps can run' : "Not trusted — its CLAUDE.md and AGENTS.md are ignored, its apps don't run"}
      </span>
    </span>
  )
}
