import { useCallback, useEffect, useState } from 'react'
import type { AppReview } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppReviewDetails } from './AppReviewDetails.jsx'

/**
 * 사람의 확인을 기다리는 가져온 앱 (M4 E-3) — 고정 화면 자리에 확인 창이 선다. 처음 들어와 아직 켜지 않았거나, 켠 뒤 무엇을 돌리는지
 * (server)나 무엇을 쓰겠다는지(uses)가 바뀌었다. 켜면 host가 이 창의 열쇠를 지금의 매니페스트와 대 보고 적는다 — 그 사이 바뀌었으면
 * 거절하고, 이 창은 새로 읽어 바뀐 것을 보인다.
 *
 * 켜면 목록이 방송을 따라 바뀌고, 고정 화면은 열 수 있는 앱이 된 그 자리에서 앱을 연다(화면이 home을 부른다).
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
  // 목록이 말하는 이유가 바뀌면(다시 바뀐 매니페스트) 다시 읽는다
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
      // 그 사이 바뀌었다 — 이유를 보이고 새 창을 읽는다(사람은 바뀐 것을 보고 다시 켠다)
      setError((e as Error).message)
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl overflow-y-auto px-6 py-6" data-testid="pinned-review">
      <p className="text-[13px] text-chalk" data-testid="pinned-review-title">
        {app.info.imported?.confirmedAt ? 'This app changed. Review it before it runs again.' : 'This app was imported. Review it before it runs.'}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate">
        Nothing from it runs until you enable it: no process, no tools for agents, no screen.
      </p>
      <div className="mt-4">{review ? <AppReviewDetails review={review} /> : !error && <p className="text-[12px] text-slate">Reading…</p>}</div>
      {error && (
        <p className="mt-3 whitespace-pre-wrap break-words rounded border border-edge bg-panel px-2.5 py-2 text-[11px] text-chalk" role="alert" data-testid="pinned-review-error">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
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
