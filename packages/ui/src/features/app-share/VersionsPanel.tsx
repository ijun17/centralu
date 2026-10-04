import { useCallback, useEffect, useState } from 'react'
import type { AppSnapshot, AppVersions } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'

/**
 * An app's versions (M4 E-1) — an expandable panel next to the pinned view (the same spot and
 * shape as the evidence panel).
 *
 * A user-folder app's versions are snapshots the host keeps every time it starts on new code
 * (the most recent 5). Since this is where a person recovers an app a building session broke
 * while fixing it, "Restore previous version" sits at the top — the version right before the
 * current code. Restoring rewrites files, so it asks once. That question also says what stays
 * (the current code is kept as a version too).
 *
 * A project app is not restored here, since git is its version history. Only the recent commits
 * that touched that app's folder are read.
 */
export function VersionsPanel({ app }: { app: ExternalCatalogApp }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const refresh = useStore((s) => s.refreshExternalApps)
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<AppSnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    let alive = true
    platform.apps
      .versions(app.appId, app.projectId)
      .then((v) => {
        if (!alive) return
        setVersions(v)
        setError(null)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [platform, app.appId, app.projectId])
  // A new version appears when the app restarts on new code — reads again whenever the list's codeStamp changes
  useEffect(() => load(), [load, app.info.codeStamp])

  const restore = async (snap: AppSnapshot) => {
    setBusy(true)
    setError(null)
    try {
      await platform.apps.restoreVersion(app.appId, app.projectId, snap.id)
      setAsking(null)
      setToast(`Restored ${app.title} to the version from ${when(snap.at)}`)
      void refresh()
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const snaps = versions?.kind === 'snapshots' ? versions.snapshots : []
  const at = snaps.findIndex((s) => s.current)
  // The version right before the current code — if the current code matches no version at all (edited but not yet started), it is the most recent version
  const previous = at >= 0 ? snaps[at + 1] : snaps[0]

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface-side" data-testid="versions-panel" aria-label="Versions">
      <header className="flex h-8 shrink-0 items-center border-b border-line px-3">
        <span className="readout text-2xs uppercase text-ink-faint">Versions</span>
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
            {previous && !asking && (
              <button
                type="button"
                className="mx-3 mt-2 rounded-md border border-line bg-surface-raised px-2.5 py-1 text-xs text-ink transition-colors hover:border-line-strong"
                onClick={() => setAsking(previous)}
                data-testid="versions-restore-previous"
              >
                Restore previous version
              </button>
            )}
            {asking && (
              <div className="mx-3 mt-2 rounded-md border border-line bg-surface-floor px-2.5 py-2" data-testid="versions-confirm">
                <p className="text-xs leading-body text-ink-muted">
                  Replace {app.title}&apos;s files with the version from {when(asking.at)}? The current files are kept as a version first, and the app
                  restarts on the restored code.
                </p>
                <div className="mt-1.5 flex justify-end gap-2">
                  <button type="button" className="rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink" onClick={() => setAsking(null)} data-testid="versions-confirm-cancel">
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-line bg-surface-raised px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong disabled:opacity-40"
                    onClick={() => void restore(asking)}
                    disabled={busy}
                    data-testid="versions-confirm-yes"
                  >
                    {busy ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </div>
            )}
            {snaps.length === 0 && <p className="px-3 py-3 text-xs text-ink-faint">No versions yet. One is kept the first time the app starts.</p>}
            <ol className="mt-2">
              {snaps.map((s) => (
                <li key={s.id} className="border-b border-line/60 px-3 py-1.5 text-xs" data-testid="version-row" data-current={s.current || undefined}>
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
                        onClick={() => setAsking(s)}
                        data-testid="version-restore"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-ink-faint">
                    {s.files} files · {size(s.bytes)}
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

/** A project app — git is its version history. Only reads it */
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
          <li key={c.sha} className="border-b border-line/60 px-3 py-1.5 text-xs" data-testid="version-commit">
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

function when(at: number): string {
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
