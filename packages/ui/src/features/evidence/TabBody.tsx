import type { PanelTab } from '../../store/store.js'
import { FileTree } from '../files/FileTree.jsx'
import { lazyComponent } from '../../components/lazy.jsx'
import { GitChanges } from './GitChanges.jsx'
import { CommitHistory } from './CommitHistory.jsx'

/** xterm is ~300 KB, so it loads with the tab's first showing */
const TerminalPane = lazyComponent(() => import('./Terminal.jsx').then((m) => m.TerminalPane))


/** The active tab of every group renders through here */
export function TabBody({
  tab,
  projectId,
  project,
}: {
  tab: PanelTab
  projectId: string
  project: { git?: { denied?: boolean } | null }
}) {
  const isRepo = !!project.git

  if (tab === 'terminal') return <TerminalPane projectId={projectId} />

  // Git and history need a repository. Their tabs are disabled without one, but a saved snapshot or a non-repo project
  // moving in under an open tab still leads here.
  if (tab === 'files' || !isRepo) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tab !== 'files' && !isRepo && (
          <p className="px-3 py-2 text-xs text-ink-faint" data-testid="evidence-not-repo">
            Not a git repository
          </p>
        )}
        <FileTree projectId={projectId} />
      </div>
    )
  }

  if (tab === 'history') return <CommitHistory projectId={projectId} />

  // No history strip under the changes (#20): a fixed-height block overflows a short split half onto the next group's
  // strip, and the History tab (#21) has a full column.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitChanges projectId={projectId} denied={project.git?.denied} />
    </div>
  )
}
