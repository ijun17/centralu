import { useState } from 'react'
import { errorMessage, changedFileCount, type GitFileStatus } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { TabActions } from './tabActions.jsx'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { useLoad } from '../../app/useLoad.js'
import { Button } from '../../components/Button.jsx'
import { Badge } from '../../components/Badge.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { Pill } from '../../components/Pill.jsx'
import { Tooltip } from '../../components/primitives.jsx'

/** The list and committing; a diff opens in the wide overlay */
export function GitChanges({ projectId, denied }: { projectId: string; denied?: boolean }) {
  const platform = usePlatform()
  const openGit = useStore((s) => s.openGit)
  const setToast = useStore((s) => s.setToast)
  // Writes go through the store, so the sidebar's count beside it updates too (#49); the file list is read here, since
  // the store holds only the summary.
  const gitStage = useStore((s) => s.gitStage)
  const gitCommit = useStore((s) => s.gitCommit)
  const touched = useGitRefreshKey(projectId)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  /** Held until the cancelled write answers, so Cancel is pressed once (#1007) */
  const [cancelling, setCancelling] = useState(false)

  // Re-read whenever an agent touches a file, since evidence must be current. A failed read says so, not "No changes" (#850 item 8).
  const status = useLoad(() => platform.git.status(projectId), [platform, projectId], [touched])
  const files = status.data
  const refresh = status.reload

  const unstaged = files?.filter((f) => !f.staged) ?? []
  const staged = files?.filter((f) => f.staged) ?? []

  /** `verb` names the action in a failure's toast ("Could not commit: …", docs/ux-writing.md 1.5) */
  const run = async (fn: () => Promise<void>, verb: string) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      // A thrown RPC (disconnect, timeout) must not pass for a success
      setToast(`Could not ${verb}: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
      setCancelling(false)
    }
  }

  // A commit or push waits up to ten minutes on a hook or credential helper (#980); this ends it sooner (#1007), and the
  // write's own answer says it was cancelled.
  const cancel = async () => {
    setCancelling(true)
    try {
      await platform.git.cancel(projectId)
    } catch (e) {
      // The write goes on, and Cancel can be pressed again
      setCancelling(false)
      setToast(errorMessage(e))
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col border-b border-line" data-testid="evidence-git">
      {/* No 'Changes' label: the tab says it */}
      {files && files.length > 0 && (
        <TabActions>
          <ChangeCount count={changedFileCount(files)} />
          <Button variant="ghost" size="xs" onClick={() => openGit()} data-testid="evidence-git-full">
            Open wide
          </Button>
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
        <div className="px-3 pb-2 text-xs leading-body text-ink-muted" data-testid="evidence-git-denied">
          <p>Folder access is off for this project</p>
          <p className="text-ink-faint">
            Turn it on in System Settings, under Privacy & Security, Files and Folders
          </p>
        </div>
      ) : files === undefined ? (
        status.error === null && (
          <SkeletonLines lines={3} className="px-3 pb-2 pt-1" label="Loading the changes" />
        )
      ) : files.length === 0 ? (
        <p className="px-3 pb-2 text-xs text-ink-faint" data-testid="evidence-clean">
          No changes
        </p>
      ) : (
        <>
          {/*
            Split apart: what goes into the commit is the fact that matters before committing, not a tag per row.
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
                run: (paths) => run(() => gitStage(projectId, paths, true), 'unstage'),
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
                run: (paths) => run(() => gitStage(projectId, paths), 'stage'),
              }}
            />
          </div>
        </>
      )}
      {/* After a failed read too: git may still commit and push what it could not list */}
      {!denied && (files !== undefined || status.error !== null) && (
        /* Stays with an empty list (#160): right after a commit the list is "No changes", and Push must remain */
        <div className="mt-auto border-t border-line px-3 py-2">
          <TextInput
            size="sm"
            surface="raised"
            className="w-full"
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="evidence-commit-message"
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={busy || !message.trim() || staged.length === 0}
              data-testid="evidence-commit"
              onClick={() =>
                void run(async () => {
                  const r = await gitCommit(projectId, message.trim())
                  setToast(
                    r.ok ? 'Committed' : r.cancelled ? 'Commit cancelled' : failure('commit', r.message),
                  )
                  if (r.ok) setMessage('')
                }, 'commit')
              }
            >
              Commit
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              data-testid="evidence-push"
              onClick={() =>
                void run(async () => {
                  const r = await platform.git.push(projectId)
                  setToast(r.ok ? 'Pushed' : r.cancelled ? 'Push cancelled' : failure('push', r.message))
                }, 'push')
              }
            >
              Push
            </Button>
            {busy && (
              <Button
                variant="quiet"
                size="sm"
                disabled={cancelling}
                data-testid="evidence-git-cancel"
                onClick={() => void cancel()}
              >
                Cancel
              </Button>
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
        <Badge as="h4">{title}</Badge>
        <span className="readout text-2xs text-ink-faint">{files.length}</span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={busy}
          onClick={() => void action.run(files.map((f) => f.path))}
          data-testid={`evidence-${action.id}-all`}
        >
          {action.all}
        </Button>
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
  // The row whose diff the wide view shows is selected, as with a commit or tree row
  const selected = useStore(
    (s) =>
      s.overlay?.kind === 'git' &&
      s.overlay.sub === 'changes' &&
      s.overlay.path === file.path &&
      !!s.overlay.staged === file.staged,
  )
  return (
    <li className="group/file relative">
      <button
        className={`flex w-full items-center gap-2 px-3 py-1 pr-14 text-left transition-colors ${
          selected ? 'bg-surface-selected text-ink' : 'text-ink-muted hover:bg-surface-hover/20'
        }`}
        onClick={onOpen}
        data-testid={`evidence-file-${file.path}`}
        title={`${file.path} — view diff`}
      >
        {/* The kind is told apart by a letter, not a color (strict grayscale) */}
        <span className="readout w-3 shrink-0 text-2xs">{statusMark(file.status)}</span>
        <span className="readout truncate text-xs">{file.path}</span>
      </button>
      {/*
        Per file, so "everything but this one" is done here, not in a terminal.
      */}
      {/* Its own positioned box: the tooltip's anchor is `relative`, and two positions on one element race in the CSS order */}
      <span className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/file:opacity-100">
        <Tooltip content={`${actionLabel} ${file.path}`} align="right">
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={onAction}
            data-testid={`evidence-${actionId}-${file.path}`}
          >
            {actionLabel}
          </Button>
        </Tooltip>
      </span>
    </li>
  )
}

/** The words are in the tooltip, as on the top bar's capsules */
function ChangeCount({ count }: { count: number }) {
  return (
    <Tooltip content={`${count} changed ${count === 1 ? 'file' : 'files'}`} align="right">
      <Pill size="label" edge="quiet" data-testid="evidence-change-count">
        <span className="readout">{count}</span>
      </Pill>
    </Tooltip>
  )
}

/** What failed, with git's reason when it gave one */
function failure(verb: string, reason: string | undefined): string {
  return reason ? `Could not ${verb}: ${reason}` : `Could not ${verb}`
}

/**
 * git's untracked `?` reads as unknown, so a new file shows A, as M, A, D and R say what happened; the group says whether
 * it is staged. Display only: the host's `'?'` stays.
 */
function statusMark(status: GitFileStatus['status']): string {
  return status === '?' ? 'A' : status.toUpperCase()
}

/**
 * When to re-read: the touched-file count catches a turn's first edit, but not a Bash `git commit`, a terminal command or a
 * re-edit (#160), so `gitEpoch` (turn end, window focus, an approval, a branch switch) joins it.
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
