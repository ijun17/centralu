import { useEffect, useState } from 'react'
import { errorMessage, type AppSnapshot, type AppVersions } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { formatBytes, formatClock, formatDay } from '../../app/format.js'
import { useStore } from '../../store/store.js'
import { userAppMachine, type ExternalCatalogApp } from '../../store/app-catalog.js'
import { Badge } from '../../components/Badge.jsx'
import { Button } from '../../components/Button.jsx'

/**
 * Beside the pinned view, as the evidence panel. A user-folder app's versions are the host's snapshots per start on new
 * code (the last 5), with "Restore previous version" on top for an app a building session broke. A project app's history
 * is git: only the commits touching its folder are read.
 */
export function VersionsPanel({ app }: { app: ExternalCatalogApp }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const refresh = useStore((s) => s.refreshExternalApps)
  // A restore that failed; reading the list fails on its own (`read.error`)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A linked machine's user-folder app (#82): its versions are that machine's
  const machine = userAppMachine(app.info)

  // A restart on new code makes a version, so a new codeStamp re-reads
  const read = useLoad(() => platform.apps.versions(app.appId, app.projectId, machine), [platform, app.appId, app.projectId, machine], [app.info.codeStamp])
  const versions: AppVersions | null = read.data ?? null
  const error = restoreError ?? read.error
  // A list read again after a failed restore clears that failure
  useEffect(() => setRestoreError(null), [read.data])

  // One press restores (#1512). The host first keeps the current files as a version, so the toast's Undo can go back: to
  // the version current before, or to the `before restore` copy for unstarted edits. An `undo` restore offers no Undo.
  const restore = async (snap: AppSnapshot, undo = false) => {
    setBusy(true)
    setRestoreError(null)
    try {
      // Read just before, not from the panel's last reading: the way back is whatever is current now
      const before = await platform.apps.versions(app.appId, app.projectId, machine)
      const kept = before.kind === 'snapshots' ? before.snapshots : []
      const wasCurrent = kept.find((s) => s.current)
      await platform.apps.restoreVersion(app.appId, app.projectId, snap.id, userAppMachine(app.info))
      const now = await platform.apps.versions(app.appId, app.projectId, machine).catch(() => null)
      // This restore's copy is the new one; an older 'before restore' is another restore's
      const copy = now?.kind === 'snapshots' ? now.snapshots.find((s) => s.reason === 'before restore' && !kept.some((k) => k.id === s.id)) : undefined
      const back = wasCurrent && wasCurrent.id !== snap.id ? wasCurrent : copy && copy.id !== snap.id ? copy : null
      const text = `Restored ${app.title} to the version from ${when(snap.at)}`
      setToast(text, !undo && back ? { label: 'Undo', run: () => void restore(back, true) } : undefined)
      void refresh()
      void read.reload()
    } catch (e) {
      setRestoreError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const snaps = versions?.kind === 'snapshots' ? versions.snapshots : []
  const at = snaps.findIndex((s) => s.current)
  // The version before the current code; with unstarted edits (no version matches), the newest
  const previous = at >= 0 ? snaps[at + 1] : snaps[0]

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface-side" data-testid="versions-panel" aria-label="Versions">
      <header className="flex h-8 shrink-0 items-center border-b border-line px-3">
        <Badge readout>Versions</Badge>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-3 py-2 text-xs text-ink-muted" role="alert" data-testid="versions-error">
            {error}
          </p>
        )}
        {versions?.kind === 'git' && <GitHistory versions={versions} />}
        {versions?.kind === 'snapshots' && (
          <>
            <p className="px-3 pt-2 text-xs leading-body text-ink-faint">
              Kept on this machine each time the app starts on new code. The last five stay.
            </p>
            {previous && (
              <Button
                variant="primary"
                size="sm"
                className="mx-3 mt-2"
                onClick={() => void restore(previous)}
                busy={busy}
                busyText="Restoring…"
                title="The current files are kept as a version first, and the app restarts on the restored code"
                data-testid="versions-restore-previous"
              >
                Restore previous version
              </Button>
            )}
            {snaps.length === 0 && <p className="px-3 py-3 text-xs text-ink-faint">No versions yet. One is kept the first time the app starts.</p>}
            <ol className="mt-2">
              {snaps.map((s) => (
                <li key={s.id} className="border-b border-line px-3 py-1.5 text-xs" data-testid="version-row" data-current={s.current || undefined}>
                  <div className="flex items-baseline gap-2">
                    <time className="readout shrink-0 text-ink-faint" dateTime={new Date(s.at).toISOString()}>
                      {when(s.at)}
                    </time>
                    <span className="truncate text-ink-muted">{REASON[s.reason] ?? s.reason}</span>
                    {s.current ? (
                      <span className="readout ml-auto shrink-0 text-ink" data-testid="version-current">
                        current
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-ink-faint transition-colors hover:text-ink"
                        onClick={() => void restore(s)}
                        disabled={busy}
                        data-testid="version-restore"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-ink-faint">
                    {s.files} files · {formatBytes(s.bytes)}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  )
}

/** Read-only: git is a project app's history */
function GitHistory({ versions }: { versions: Extract<AppVersions, { kind: 'git' }> }) {
  return (
    <div data-testid="versions-git">
      <p className="px-3 pt-2 text-xs leading-body text-ink-faint">
        {versions.repo
          ? 'This app lives in the project, so git keeps its versions. Commits that touched it, newest first; restore with git.'
          : 'This project is not a git repository, so there is no history for this app.'}
      </p>
      {versions.repo && versions.commits.length === 0 && <p className="px-3 py-3 text-xs text-ink-faint">No commits touch this app yet.</p>}
      <ol className="mt-2">
        {versions.commits.map((c) => (
          <li key={c.sha} className="border-b border-line px-3 py-1.5 text-xs" data-testid="version-commit">
            <div className="flex items-baseline gap-2">
              <span className="readout shrink-0 text-ink-faint">{c.shortSha}</span>
              <span className="min-w-0 truncate text-ink-muted" title={c.subject}>
                {c.subject}
              </span>
            </div>
            <p className="mt-0.5 text-ink-faint">
              {c.author} · {when(c.when)}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}

const REASON: Record<string, string> = {
  started: 'Started on new code',
  imported: 'As imported',
  'before restore': 'Before a restore',
}

const when = (at: number): string => `${formatDay(at)}, ${formatClock(at)}`

