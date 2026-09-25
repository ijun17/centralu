import { useCallback, useEffect, useState } from 'react'
import type { AppSnapshot, AppVersions } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'

/**
 * 앱의 판 (M4 E-1) — 고정 화면 옆에 여닫는 판(기록 판과 같은 자리·모양).
 *
 * 사용자 폴더 앱은 host가 코드가 바뀌어 뜰 때마다 떠 둔 스냅샷이다(최근 5벌). 만드는 세션이 고치다 망가뜨린 앱을 사람이 되살리는 자리라
 * 맨 위에 "Restore previous version" 하나를 둔다 — 지금 코드의 바로 앞 판이다. 되돌리기는 파일을 되쓰는 일이라 한 번 묻는다. 그 물음이
 * 무엇이 남는지(지금 코드도 판으로 떠 둔다)를 함께 말한다.
 *
 * 프로젝트 앱은 git이 판이라 되돌리지 않는다. 그 앱 폴더를 건드린 최근 커밋을 읽기만 한다.
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
  // 앱이 새 코드로 다시 뜨면 새 판이 선다 — 목록의 codeStamp가 바뀔 때 다시 읽는다
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
  // 지금 코드의 바로 앞 판 — 지금 코드가 어느 판과도 같지 않으면(고쳤지만 아직 뜨지 않았다) 가장 최근 판이다
  const previous = at >= 0 ? snaps[at + 1] : snaps[0]

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-edge bg-pit" data-testid="versions-panel" aria-label="Versions">
      <header className="flex h-8 shrink-0 items-center border-b border-edge px-3">
        <span className="readout text-[10px] uppercase text-slate">Versions</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-3 py-2 text-[11px] text-ash" role="alert" data-testid="versions-error">
            {error}
          </p>
        )}
        {versions?.kind === 'git' && <GitHistory versions={versions} />}
        {versions?.kind === 'snapshots' && (
          <>
            <p className="px-3 pt-2 text-[11px] leading-relaxed text-slate">
              Kept on this machine each time the app starts on new code. The last five stay.
            </p>
            {previous && !asking && (
              <button
                type="button"
                className="mx-3 mt-2 rounded border border-edge bg-panel px-2.5 py-1 text-[11px] text-chalk transition-colors hover:border-graphite"
                onClick={() => setAsking(previous)}
                data-testid="versions-restore-previous"
              >
                Restore previous version
              </button>
            )}
            {asking && (
              <div className="mx-3 mt-2 rounded border border-edge bg-void px-2.5 py-2" data-testid="versions-confirm">
                <p className="text-[11px] leading-relaxed text-ash">
                  Replace {app.title}&apos;s files with the version from {when(asking.at)}? The current files are kept as a version first, and the app
                  restarts on the restored code.
                </p>
                <div className="mt-1.5 flex justify-end gap-2">
                  <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:text-chalk" onClick={() => setAsking(null)} data-testid="versions-confirm-cancel">
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded border border-edge bg-panel px-2 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
                    onClick={() => void restore(asking)}
                    disabled={busy}
                    data-testid="versions-confirm-yes"
                  >
                    {busy ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </div>
            )}
            {snaps.length === 0 && <p className="px-3 py-3 text-[11px] text-slate">No versions yet. One is kept the first time the app starts.</p>}
            <ol className="mt-2">
              {snaps.map((s) => (
                <li key={s.id} className="border-b border-edge/60 px-3 py-1.5 text-[11px]" data-testid="version-row" data-current={s.current || undefined}>
                  <div className="flex items-baseline gap-2">
                    <time className="readout shrink-0 text-slate" dateTime={new Date(s.at).toISOString()}>
                      {when(s.at)}
                    </time>
                    <span className="truncate text-ash">{REASON[s.reason] ?? s.reason}</span>
                    {s.current ? (
                      <span className="readout ml-auto shrink-0 text-chalk" data-testid="version-current">
                        current
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-slate transition-colors hover:text-chalk"
                        onClick={() => setAsking(s)}
                        data-testid="version-restore"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-slate">
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

/** 프로젝트 앱 — git이 판이다. 읽기만 한다 */
function GitHistory({ versions }: { versions: Extract<AppVersions, { kind: 'git' }> }) {
  return (
    <div data-testid="versions-git">
      <p className="px-3 pt-2 text-[11px] leading-relaxed text-slate">
        {versions.repo
          ? 'This app lives in the project, so git keeps its versions. Commits that touched it, newest first; restore with git.'
          : 'This project is not a git repository, so there is no history for this app.'}
      </p>
      {versions.repo && versions.commits.length === 0 && <p className="px-3 py-3 text-[11px] text-slate">No commits touch this app yet.</p>}
      <ol className="mt-2">
        {versions.commits.map((c) => (
          <li key={c.sha} className="border-b border-edge/60 px-3 py-1.5 text-[11px]" data-testid="version-commit">
            <div className="flex items-baseline gap-2">
              <span className="readout shrink-0 text-slate">{c.shortSha}</span>
              <span className="min-w-0 truncate text-ash" title={c.subject}>
                {c.subject}
              </span>
            </div>
            <p className="mt-0.5 text-slate">
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
