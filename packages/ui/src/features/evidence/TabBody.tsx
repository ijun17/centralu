import type { PanelTab } from '../../store/store.js'
import { FileTree } from '../files/FileTree.jsx'
import { lazyComponent } from '../../components/lazy.jsx'
import { GitChanges } from './GitChanges.jsx'
import { CommitHistory } from './CommitHistory.jsx'

/** The terminal brings xterm (~300 KB), so it loads when its tab is first shown (components/lazy.tsx) */
const TerminalPane = lazyComponent(() => import('./Terminal.jsx').then((m) => m.TerminalPane))


/** What one tab shows. The active tab of every group renders through here. */
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

  // The terminal belongs to the project (a directory), so being a git repo is irrelevant
  if (tab === 'terminal') return <TerminalPane projectId={projectId} />

  /*
    Git and history both ask questions of the repository, so neither has an answer
    without one. The tabs are disabled then, but paths still lead here — a saved
    snapshot can restore them, or a non-repo project can move in under a watching tab.
  */
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

  /*
    Git tab: what changed right now, alone. The history strip that used to sit below it
    left with the split feature (#20): it was a fixed-height block, so in a short split
    half it overflowed the group body straight over the next group's tab strip — and the
    History tab (#21) already answers "how did we get here" with a full column to do it in.
  */
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitChanges projectId={projectId} denied={project.git?.denied} />
    </div>
  )
}
