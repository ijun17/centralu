import { useState } from 'react'
import { changedFileCount, type GitFileStatus } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { TabActions } from './tabActions.jsx'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { useLoad } from '../../app/useLoad.js'

/**
 * Changed files — the most frequently viewed list in this app.
 * Only the list and committing happen here; a diff opens up somewhere wide.
 */
export function GitChanges({ projectId, denied }: { projectId: string; denied?: boolean }) {
  const platform = usePlatform()
  const openGit = useStore((s) => s.openGit)
  const setToast = useStore((s) => s.setToast)
  /*
   * Writes through the store, reads straight from the platform (issue #49).
   *
   * This panel sits **beside** the sidebar count it was leaving stale — commit here and the
   * number a few pixels to the left kept the old value. `refresh` below stays local because
   * it fetches the file list, which the store does not hold; the store owns the summary.
   */
  const gitStage = useStore((s) => s.gitStage)
  const gitCommit = useStore((s) => s.gitCommit)
  const touched = useGitRefreshKey(projectId)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  /** The person asked to end the running write (#1007); held until that write answers, so Cancel is pressed once */
  const [cancelling, setCancelling] = useState(false)

  /*
   * A response arriving late while switching projects must not draw another project's list (`useLoad`). Re-reads
   * whenever an agent touches a file (evidence only means something if it is current). A failed read says so: it
   * used to be drawn as "No changes" (#850 item 8).
   */
  const status = useLoad(() => platform.git.status(projectId), [platform, projectId], [touched])
  const files = status.data
  const refresh = status.reload

  const unstaged = files?.filter((f) => !f.staged) ?? []
  const staged = files?.filter((f) => f.staged) ?? []

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      // When the RPC throws (disconnect, timeout), nothing caught it and it looked like a success — no silent failures
      setToast((e as Error).message)
    } finally {
      setBusy(false)
      setCancelling(false)
    }
  }

  /*
   * A commit or push waits up to ten minutes on a hook or a credential helper (#980); this ends it sooner (#1007). The
   * write itself answers that it was cancelled, and its toast says so.
   */
  const cancel = async () => {
    setCancelling(true)
    try {
      await platform.git.cancel(projectId)
    } catch (e) {
      // A host from before #1007 has no such call: the write goes on, and Cancel can be pressed again
      setCancelling(false)
      setToast((e as Error).message)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col border-b border-line" data-testid="evidence-git">
      {/* The label 'Changes' was dropped since the tab already says it — only the count and buttons go to the right of the strip */}
      {files && files.length > 0 && (
        <TabActions>
          <span className="readout text-2xs text-ink-muted" data-testid="evidence-change-count">
            {changedFileCount(files)}
          </span>
          <button
            className="rounded-md px-1.5 py-0.5 text-2xs text-ink-faint transition-colors hover:bg-surface-hover/50 hover:text-ink"
            onClick={() => openGit()}
            data-testid="evidence-git-full"
            title="Open in wide view"
          >
            Expand
          </button>
        </TabActions>
      )}

      {/* Beside the last list when a refresh failed, in its place when there is none */}
      {!denied && status.error !== null && (
        <LoadFailed
          what="the changes"
          error={status.error}
          onRetry={() => void refresh()}
          className="px-3 pb-2"
          testId="evidence-git-failed"
        />
      )}
      {denied ? (
        <p className="px-3 pb-2 text-xs leading-body text-ink-muted" data-testid="evidence-git-denied">
          Folder access permission required — System Settings → Privacy & Security → Files and Folders
        </p>
      ) : files === undefined ? (
        status.error === null && <SkeletonLines lines={3} className="px-3 pb-2 pt-1" label="Loading the changes" />
      ) : files.length === 0 ? (
        <p className="px-3 pb-2 text-xs text-ink-faint" data-testid="evidence-clean">
          No changes
        </p>
      ) : (
        <>
          {/*
            Staged and unstaged files are shown **split apart.**
            What will actually go into the commit is the one fact that matters right before
            committing, and mixing them into one list meant reading that off a small tag at the end
            of each row instead. Above the boundary is what goes in, below it is what does not — the
            boundary itself is the answer.
          */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChangeGroup
              title="Staged"
              files={staged}
              onOpen={openGit}
              busy={busy}
              action={{
                id: 'unstage',
                one: 'Unstage',
                all: 'Unstage all',
                run: (paths) => run(() => gitStage(projectId, paths, true)),
              }}
            />
            <ChangeGroup
              title="Changed"
              files={unstaged}
              onOpen={openGit}
              busy={busy}
              action={{
                id: 'stage',
                one: 'Stage',
                all: 'Stage all',
                run: (paths) => run(() => gitStage(projectId, paths)),
              }}
            />
          </div>
        </>
      )}
      {/* After a failed read too: git may still commit and push what it could not list */}
      {!denied && (files !== undefined || status.error !== null) && (
        /*
         * Committing has to work in a narrow space too — the flow of checking a change and then
         * wrapping it up right there must not be broken. This block stays even when the list is
         * empty (#160). In the most common sequence of committing and pushing as separate steps,
         * the moment everything got committed and the state became "No changes," Push disappeared
         * along with it — there was no way left in the app to push the commit just made.
         */
        <div className="mt-auto border-t border-line px-3 py-2">
          <input
            className="w-full rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="evidence-commit-message"
          />
          <div className="mt-1.5 flex gap-1.5">
            <button
              className="flex-1 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-ink transition-colors hover:border-line-strong disabled:opacity-40"
              disabled={busy || !message.trim() || staged.length === 0}
              data-testid="evidence-commit"
              onClick={() =>
                void run(async () => {
                  const r = await gitCommit(projectId, message.trim())
                  setToast(r.ok ? 'Committed' : r.cancelled ? 'Commit cancelled' : (r.message ?? 'Commit failed'))
                  if (r.ok) setMessage('')
                })
              }
            >
              Commit
            </button>
            <button
              className="rounded-md border border-line px-2 py-1 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
              disabled={busy}
              data-testid="evidence-push"
              onClick={() =>
                void run(async () => {
                  const r = await platform.git.push(projectId)
                  setToast(r.ok ? 'Pushed' : r.cancelled ? 'Push cancelled' : (r.message ?? 'Push failed'))
                })
              }
            >
              Push
            </button>
            {busy && (
              <button
                className="rounded-md border border-line px-2 py-1 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
                disabled={cancelling}
                data-testid="evidence-git-cancel"
                onClick={() => void cancel()}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/** One group (staged / changed). Renders no header at all when empty */
function ChangeGroup({
  title,
  files,
  onOpen,
  busy,
  action,
}: {
  title: string
  files: GitFileStatus[]
  onOpen: (path: string, staged: boolean) => void
  busy: boolean
  action: { id: 'stage' | 'unstage'; one: string; all: string; run: (paths: string[]) => Promise<void> }
}) {
  if (files.length === 0) return null
  return (
    <section data-testid={`evidence-group-${title.toLowerCase()}`}>
      <header className="sticky top-0 flex items-center gap-1.5 bg-surface-side px-3 py-1">
        <h4 className="text-2xs uppercase text-ink-faint">{title}</h4>
        <span className="readout text-2xs text-ink-faint">{files.length}</span>
        <button
          className="ml-auto text-2xs text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
          disabled={busy}
          onClick={() => void action.run(files.map((f) => f.path))}
          data-testid={`evidence-${action.id}-all`}
        >
          {action.all}
        </button>
      </header>
      <ul>
        {files.map((f) => (
          <ChangeRow
            key={f.path}
            file={f}
            onOpen={() => onOpen(f.path, f.staged)}
            busy={busy}
            actionId={action.id}
            actionLabel={action.one}
            onAction={() => void action.run([f.path])}
          />
        ))}
      </ul>
    </section>
  )
}

function ChangeRow({
  file,
  onOpen,
  busy,
  actionId,
  actionLabel,
  onAction,
}: {
  file: GitFileStatus
  onOpen: () => void
  busy: boolean
  actionId: 'stage' | 'unstage'
  actionLabel: string
  onAction: () => void
}) {
  return (
    <li className="group/file relative">
      <button
        className="flex w-full items-center gap-2 px-3 py-1 pr-12 text-left transition-colors hover:bg-surface-hover/25"
        onClick={onOpen}
        data-testid={`evidence-file-${file.path}`}
        title={`${file.path} — view diff`}
      >
        {/* The kind is told apart by a letter, not a color (strict grayscale) */}
        <span className="readout w-3 shrink-0 text-2xs text-ink-muted">{statusMark(file.status)}</span>
        <span className="truncate text-sm text-ink-muted" dir="rtl">
          {file.path}
        </span>
      </button>
      {/*
        A way to stage or unstage just this one file. Without it, doing "commit everything except
        this one" meant dropping out to the terminal — it must be possible to finish it right where
        it was being reviewed.
      */}
      <button
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1 text-2xs text-ink-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover/file:opacity-100 disabled:opacity-40"
        disabled={busy}
        onClick={onAction}
        data-testid={`evidence-${actionId}-${file.path}`}
        title={`${file.path} ${actionLabel}`}
      >
        {actionLabel}
      </button>
    </li>
  )
}


/**
 * The single letter in front of a row (user request, 2026-09-10: "a new file shows up as a
 * question mark, but it should show A").
 *
 * git writes a file it does not yet track as `?`, but on screen that reads as **unknown** — when
 * it is actually a known fact (a new file). The letter a person reads should state what happened,
 * the way M, A, D and R do, so it is written as A (added) instead. Whether it is staged is already
 * stated by the group it is in (Staged/Changed), so this letter does not need to say it again.
 *
 * **The data itself is not changed.** The host's `'?'` stays exactly as the fact "not tracked" — only
 * the display is changed here (the same rule the diff's file band follows, keeping the original
 * wording for a copy).
 */
function statusMark(status: GitFileStatus['status']): string {
  return status === '?' ? 'A' : status.toUpperCase()
}

/**
 * The signal that knows when to re-read the list — two signals combined.
 *
 * The count of files an agent touched reports the first edit **during** a turn. That alone was not
 * enough (#160): a `git commit` run through Bash, a command typed into the terminal, or re-editing a
 * file already touched does not change this count. So this also watches `gitEpoch`, which is bumped
 * by the same signals that make the sidebar's summary re-read (turn end, window regaining focus, an
 * approval, switching branches).
 */
export function useGitRefreshKey(projectId: string): string {
  const touched = useStore((s) => {
    let n = 0
    for (const sess of Object.values(s.sessions)) {
      if (sess.projectId === projectId) n += sess.touchedPaths.length
    }
    return n
  })
  const epoch = useStore((s) => s.gitEpoch[projectId] ?? 0)
  return `${touched}:${epoch}`
}
