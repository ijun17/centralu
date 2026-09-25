import { useEffect, useRef, useState } from 'react'
import type { AppErrorBundle } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import type { AppBuilder } from './useAppBuilder.js'

/** 보이는 표준에러의 줄 수 — 끝부분이다. 묶음 전체는 만드는 세션에 간다 */
const TAIL_LINES = 8

/** 묶음의 종류 → 사람이 읽을 한 줄 */
function titleOf(b: AppErrorBundle): string {
  if (b.kind === 'start') return 'The app could not start'
  if (b.kind === 'crash') return 'The app stopped'
  return `${b.tool ?? 'A tool'} failed`
}

/**
 * 오류가 만드는 쪽에 닿는다 (M4 C-6) — 앱이 뜨지 못했거나, 죽었거나, 도구가 던졌을 때 고정 화면 아래에 그 묶음의 끝을
 * 보이고, "Send to builder" 한 번으로 만드는 세션에 넘긴다.
 *
 * **자동으로 보내지 않는다.** 에이전트가 사람 모르게 고치고 깨뜨리기를 되풀이하는 것을 막는다(플랜 C-6). 보내는 것은
 * 사람이 누른 그 한 번이고, 한 묶음은 한 번만 간다 — host가 보냈다고 적고(`sentAt`) 두 번째를 거절한다. 그래서 다시
 * 연 화면도, 다른 창도 "보냈다"를 안다.
 *
 * 무엇을 보이나: 가장 최근 묶음. 앱이 멈춰 있으면(crashed·failed) 언제 난 것이든, 아니면 **이 화면을 연 뒤에** 난 도구
 * 실패만 — 앱이 멀쩡히 도는데 지난주의 실패를 내밀면 그것은 경고가 아니라 소음이다. 사람이 걷으면(×) 그 묶음은 다시
 * 서지 않는다. 다시 읽는 때: host가 묶음을 새로 들 때(목록의 `lastErrorAt`), 앱의 상태가 바뀔 때. "바뀌었다" 알림은
 * 쓰지 않는다 — 읽기 전용 도구의 실패는 그 알림을 내지 않는다.
 */
export function ErrorTail({
  app,
  builder,
  onShowBuilder,
}: {
  app: ExternalCatalogApp | undefined
  builder: AppBuilder
  onShowBuilder: () => void
}) {
  const platform = usePlatform()
  const appId = app?.appId
  const projectId = app?.projectId ?? null
  const status = app?.info.status
  // host가 묶음을 새로 들면 목록의 이 값이 바뀐다 — 읽기 전용 도구의 실패도(그것은 "바뀌었다"를 내지 않는다)
  const lastErrorAt = app?.info.lastErrorAt
  const [bundle, setBundle] = useState<AppErrorBundle | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 이 화면이 선 때 — 앱이 도는 동안에는 이 뒤의 실패만 보인다 */
  const since = useRef(Date.now())

  useEffect(() => {
    if (!appId) return
    let alive = true
    platform.apps
      .errors(appId, projectId)
      .then((r) => alive && setBundle(r.latest))
      // 못 읽으면 옛 것을 둔다 — 다음 신호가 다시 읽는다
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, lastErrorAt, status])

  if (!app || !bundle || dismissed === bundle.at) return null
  const stopped = status === 'crashed' || status === 'failed'
  if (!stopped && bundle.at < since.current) return null

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await platform.apps.sendError(app.appId, app.projectId, bundle.at)
      // 보냈다는 사실은 host가 든다 — 다시 읽어 그 답(sentAt)으로 그린다
      const r = await platform.apps.errors(app.appId, app.projectId)
      setBundle(r.latest)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const tail = bundle.stderr.slice(-TAIL_LINES)

  return (
    <section className="mt-2 shrink-0 rounded border border-edge bg-panel px-3 py-2 text-[12px]" role="alert" data-testid="error-tail" data-kind={bundle.kind}>
      <header className="flex items-center gap-2">
        <span className="min-w-0 truncate text-chalk" data-testid="error-tail-title">
          {titleOf(bundle)}
        </span>
        <time className="readout shrink-0 text-[10px] text-slate" dateTime={new Date(bundle.at).toISOString()}>
          {new Date(bundle.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </time>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {bundle.sentAt !== null ? (
            <span className="flex items-center gap-2 text-[11px] text-slate" data-testid="error-tail-sent">
              Sent to the builder.
              <button type="button" className="text-ash underline-offset-2 hover:text-chalk hover:underline" onClick={onShowBuilder}>
                Show
              </button>
            </span>
          ) : builder.id ? (
            <button
              type="button"
              className="rounded border border-edge bg-void px-2.5 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
              onClick={() => void send()}
              disabled={busy}
              title="Hand this error to the app's builder session, once"
              data-testid="error-tail-send"
            >
              {busy ? 'Sending…' : 'Send to builder'}
            </button>
          ) : (
            <span className="text-[11px] text-slate">Start a builder to send it.</span>
          )}
          <IconButton label="Hide this error" onClick={() => setDismissed(bundle.at)} testId="error-tail-dismiss" align="right">
            <CloseIcon size={12} />
          </IconButton>
        </span>
      </header>
      <p className="mt-1 whitespace-pre-wrap break-words text-ash" data-testid="error-tail-message">
        {bundle.message}
      </p>
      {tail.length > 0 && (
        <pre
          className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-edge bg-void px-2 py-1 font-mono text-[11px] leading-relaxed text-ash"
          data-testid="error-tail-stderr"
        >
          {tail.join('\n')}
        </pre>
      )}
      {error && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-ash" data-testid="error-tail-error">
          {error}
        </p>
      )}
    </section>
  )
}
