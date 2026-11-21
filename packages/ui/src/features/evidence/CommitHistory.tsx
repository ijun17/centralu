import { useMemo } from 'react'
import { RelativeAge } from '../../components/RelativeAge.jsx'
import { laneCount, layoutCommits } from '@cc/core'
import { CommitGraph, ROW_H } from '../../components/CommitGraph.jsx'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { COMMIT_LIMIT, hasMultipleAuthors } from './commits.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { useLoad } from '../../app/useLoad.js'
import { useGitRefreshKey } from './GitChanges.jsx'

/**
 * The History tab, where the log is read (#21). A full-width tab has room for the lane graph beside the date; a click
 * opens the commit in the wide overlay (`openCommit`).
 */
export function CommitHistory({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const openCommit = useStore((s) => s.openCommit)
  // The commit the wide view shows is the selected row, as with a changed file or a tree row
  const openSha = useStore((s) => (s.overlay?.kind === 'git' && s.overlay.sub === 'history' ? (s.overlay.sha ?? null) : null))
  const touched = useGitRefreshKey(projectId)
  const log = useLoad(() => platform.git.log(projectId, COMMIT_LIMIT), [platform, projectId], [touched])
  const commits = log.data

  const withAuthor = commits ? hasMultipleAuthors(commits) : false
  const graph = useMemo(() => {
    const rows = layoutCommits(commits ?? [])
    return { rows, lanes: laneCount(rows) }
  }, [commits])

  // A failed read is never "No commits yet" (#850 item 8): it stands in place of no history, or above a stale one
  const failed = log.error !== null && (
    <LoadFailed
      what="the history"
      error={log.error}
      onRetry={() => void log.reload()}
      className="px-3 py-2"
      testId="evidence-history-failed"
    />
  )
  if (commits === undefined) {
    return (
      failed || (
        <SkeletonLines lines={5} className="px-3 py-2" label="Loading the history" testId="evidence-history" />
      )
    )
  }
  if (commits.length === 0) {
    return (
      <>
        {failed}
        <p className="px-3 py-2 text-xs text-ink-faint" data-testid="evidence-history-empty">
          No commits yet
        </p>
      </>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="evidence-history">
      {failed}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {commits.map((c, i) => (
          <li key={c.sha}>
            <button
              /* A fixed height, so the graph's lines meet at row boundaries */
              className={`flex w-full items-center gap-1.5 pr-3 text-left transition-colors ${
                openSha === c.sha ? 'bg-surface-selected' : 'hover:bg-surface-hover/20'
              }`}
              style={{ height: ROW_H }}
              onClick={() => openCommit(c.sha)}
              data-testid={`history-commit-${c.shortSha}`}
              title={`${c.subject} — ${c.author}`}
            >
              {/* The graph pads its own left (PAD_L); px-3 here would double it */}
              <CommitGraph row={graph.rows[i]!} commit={c} lanes={graph.lanes} head={i === 0} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm ${openSha === c.sha ? 'text-ink' : 'text-ink-muted'}`}>
                  {c.subject}
                </span>
                <span className="readout block truncate text-2xs text-ink-faint">
                  {c.shortSha} · <RelativeAge when={c.when} />
                  {[
                    ...(withAuthor ? [c.author] : []),
                    ...(c.parents.length > 1 ? ['merge'] : []),
                    // The session that made it (#50), observed without a hook; absent for a person's commit
                    ...(c.sessionName ? [c.sessionName] : []),
                  ].map((text) => ` · ${text}`).join('')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* A silent cut would claim there are no older commits */}
      {commits.length >= COMMIT_LIMIT && (
        <p
          className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-ink-faint"
          data-testid="evidence-history-cap"
        >
          Newest {COMMIT_LIMIT} commits — older ones are not listed
        </p>
      )}
    </section>
  )
}
