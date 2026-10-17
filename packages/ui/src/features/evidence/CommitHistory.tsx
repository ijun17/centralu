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
 * The History tab — the place a person comes to **read** the log (#21).
 *
 * It is also the successor to the History strip that used to live below the git tab. That strip had
 * a fixed height, so with splitting (#20) it covered the neighboring group's tab strip, and since
 * this tab already answers the same question ("how did we get here") with a full vertical column,
 * the strip was removed.
 *
 * **The lines (the lane graph) are now drawn here.** Back at #21, the reason this tab chose dates
 * and dropped the lines was "the graph lives over there (the strip)" — now that "over there" is
 * gone, that premise is gone too. A full-width tab has room for both: the lines state branching and
 * merging, the date states "how long ago." Row height is therefore fixed — the lines only look
 * continuous when they line up exactly at each row's boundary.
 *
 * What opens on click is not reinvented either: `openCommit` already expands the History tab of the
 * wide overlay to that commit (`DiffView` draws the single diff that `git show` returns).
 */
export function CommitHistory({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const openCommit = useStore((s) => s.openCommit)
  const touched = useGitRefreshKey(projectId)
  // A response arriving late while switching projects must not draw another project's history (`useLoad`)
  const log = useLoad(() => platform.git.log(projectId, COMMIT_LIMIT), [platform, projectId], [touched])
  const commits = log.data

  const withAuthor = commits ? hasMultipleAuthors(commits) : false
  const graph = useMemo(() => {
    const rows = layoutCommits(commits ?? [])
    return { rows, lanes: laneCount(rows) }
  }, [commits])

  /*
   * A failed read used to be drawn as "No commits yet" (#850 item 8). It stands in place of the history when there is
   * none, and above the last one when a refresh failed
   */
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
              /* Fixed height — if rows had different heights, the lines would misalign at row boundaries and look broken */
              className="flex w-full items-center gap-1.5 pr-3 text-left transition-colors hover:bg-surface-hover/25"
              style={{ height: ROW_H }}
              onClick={() => openCommit(c.sha)}
              data-testid={`history-commit-${c.shortSha}`}
              title={`${c.subject} — ${c.author}`}
            >
              {/* The left padding is the graph's own job (PAD_L) — stacking px-3 on top would push the dot twice as far from the wall */}
              <CommitGraph row={graph.rows[i]!} commit={c} lanes={graph.lanes} head={i === 0} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink-muted">{c.subject}</span>
                <span className="readout block truncate text-2xs text-ink-faint">
                  {c.shortSha} · <RelativeAge when={c.when} />
                  {[
                    ...(withAuthor ? [c.author] : []),
                    ...(c.parents.length > 1 ? ['merge'] : []),
                    // Which session made it (#50) — known through observation, without a hook. Absent for a human commit
                    ...(c.sessionName ? [c.sessionName] : []),
                  ].map((text) => ` · ${text}`).join('')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* A list that cuts off silently is a list lying that there are no older commits */}
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
