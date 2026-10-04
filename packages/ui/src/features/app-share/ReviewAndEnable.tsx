import { useCallback, useEffect, useState } from 'react'
import type { AppReview } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppReviewDetails } from './AppReviewDetails.jsx'

/**
 * An imported app waiting on the person's confirmation (M4 E-3) — a confirmation window stands
 * in the pinned-view slot. Either it just arrived and has not been enabled yet, or after being
 * enabled, what it runs (server) or what it uses (uses) changed. Enabling it makes the host
 * check this window's key against the current manifest and record it — if it changed in the
 * meantime, it is rejected, and this window reads again to show what changed.
 *
 * Once enabled, the list changes to follow the broadcast, and in that same spot, now that it has
 * become an openable app, the pinned view opens the app itself (the screen calls home).
 */
export function ReviewAndEnable({ app }: { app: ExternalCatalogApp }) {
  const platform = usePlatform()
  const refresh = useStore((s) => s.refreshExternalApps)
  const setToast = useStore((s) => s.setToast)
  const [review, setReview] = useState<AppReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    let alive = true
    platform.apps
      .review(app.appId, app.projectId)
      .then((r) => alive && setReview(r))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [platform, app.appId, app.projectId])
  // Reads again whenever the reason the list gives changes (the manifest changed again)
  useEffect(() => load(), [load, app.info.error, app.info.version])

  const enable = async () => {
    if (!review || busy) return
    setBusy(true)
    setError(null)
    try {
      await platform.apps.enable(app.appId, app.projectId, review.reviewKey)
      setToast(`Enabled ${app.title}`)
      void refresh()
    } catch (e) {
      // It changed in the meantime — show the reason and read the new window (the person sees what changed and enables it again)
      setError((e as Error).message)
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl overflow-y-auto px-6 py-6" data-testid="pinned-review">
      <p className="text-[13px] text-ink" data-testid="pinned-review-title">
        {app.info.imported?.confirmedAt ? 'This app changed. Review it before it runs again.' : 'This app was imported. Review it before it runs.'}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
        Nothing from it runs until you enable it: no process, no tools for agents, no screen.
      </p>
      <div className="mt-4">{review ? <AppReviewDetails review={review} /> : !error && <p className="text-[12px] text-ink-faint">Reading…</p>}</div>
      {error && (
        <p className="mt-3 whitespace-pre-wrap break-words rounded border border-line bg-surface-raised px-2.5 py-2 text-[11px] text-ink" role="alert" data-testid="pinned-review-error">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="rounded border border-line bg-surface-raised px-3 py-1 text-[12px] text-ink transition-colors hover:border-line-strong disabled:opacity-40"
          onClick={() => void enable()}
          disabled={!review || busy}
          data-testid="pinned-enable"
        >
          {busy ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  )
}
