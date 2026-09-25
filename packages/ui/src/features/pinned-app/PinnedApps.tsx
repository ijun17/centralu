import { useEffect, useRef, type ReactNode } from 'react'
import { externalAppKey, useStore, type PinnedView } from '../../store/store.js'
import { useExternalApp, type ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppFrame, type AppFrameHandle } from '../app-frame/AppFrame.jsx'
import { AppIcon, CloseIcon } from '../../components/icons.jsx'

/**
 * 고정 화면 (M4 B-2) — 사이드바에서 연 앱이 메인 영역을 차지한다.
 *
 * **연 화면은 모두 붙어 있다.** 보이는 것은 하나뿐이고 나머지는 `display: none`으로 숨는다. 세션을
 * 보러 갔다 돌아와도 같은 iframe, 같은 문서, 같은 인스턴스다. 화면에는 상태가 없다는 규격의 말은
 * "다시 뜨면 새로 읽는다"는 뜻이지, 다시 띄워도 된다는 뜻이 아니다. 다시 띄우면 입력하던 칸, 펼쳐
 * 둔 목록, 스크롤이 날아가고, 앱은 home을 또 한 번 받는다. iframe은 DOM에서 떼는 순간 문서를 버리고
 * (옮기기만 해도 다시 읽는다), 숨기기만 하면 문서가 산다. 그래서 이 층은 App의 가운데 레인에서 **자리를
 * 바꾸지 않는 한 자식**으로 늘 그려진다.
 *
 * 내려가는 길은 셋뿐이고, 셋 다 규격의 teardown을 먼저 보낸다(AppFrame의 약속: 떼기 전에 부른다).
 *   닫기               사람이 ×를 눌렀다
 *   앱이 사라졌다       폴더를 지웠다, 프로젝트를 지웠다
 *   앱이 더 돌 수 없다  신뢰를 잃었다, 매니페스트가 깨졌다 — 화면의 HTML도 그 프로젝트의 코드다
 */
export function PinnedApps() {
  const pinned = useStore((s) => s.pinnedViews)
  const showing = useStore((s) => s.view === 'app')
  const focusedKey = useStore((s) => (s.focusedApp ? externalAppKey(s.focusedApp.projectId, s.focusedApp.appId) : null))
  return (
    <div className={showing ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'} data-testid="pinned-apps">
      {pinned.map((pv) => (
        <PinnedAppView key={pv.key} pv={pv} visible={showing && pv.key === focusedKey} />
      ))}
    </div>
  )
}

function PinnedAppView({ pv, visible }: { pv: PinnedView; visible: boolean }) {
  const app = useExternalApp(pv.projectId, pv.appId)
  const frame = useRef<AppFrameHandle>(null)
  const start = useStore((s) => s.startPinnedView)
  const release = useStore((s) => s.releasePinnedView)
  const close = useStore((s) => s.closeApp)
  const setToast = useStore((s) => s.setToast)
  const scope = useStore((s) => (pv.projectId ? (s.projects[pv.projectId]?.name ?? 'Project') : 'Your apps'))

  const canOpen = !!app && !!app.info.home && app.status.runnable
  useEffect(() => {
    if (canOpen && pv.phase === 'idle') void start(pv.key)
  }, [canOpen, pv.phase, pv.key, start])

  /*
   * 신뢰를 잃었거나 매니페스트가 깨졌다 — 앱이 더 돌 수 없다. 화면(앱의 HTML)도 그 프로젝트의 코드라서
   * 함께 내린다. 자리는 남기고 idle로 돌린다: 다시 신뢰하면 이 자리에서 다시 연다.
   */
  const blocked = app?.info.status === 'untrusted' || app?.info.status === 'invalid'
  useEffect(() => {
    if (!blocked || pv.phase !== 'open') return
    let alive = true
    void (async () => {
      await frame.current?.teardown()
      if (alive) release(pv.key)
    })()
    return () => {
      alive = false
    }
  }, [blocked, pv.phase, pv.key, release])

  /*
   * 앱이 사라졌다. **한 번이라도 본 앱만** 사라진 것으로 친다 — 목록을 다시 읽는 사이의 빈 순간을
   * 사라짐으로 읽으면, 멀쩡한 화면이 닫힌다.
   */
  const seen = useRef(false)
  if (app) seen.current = true
  const gone = seen.current && !app
  useEffect(() => {
    if (!gone) return
    void (async () => {
      await frame.current?.teardown()
      close(pv.key)
      setToast(`${pv.appId} is no longer available — its folder or project was removed`)
    })()
  }, [gone, pv.key, pv.appId, close, setToast])

  const onClose = async () => {
    await frame.current?.teardown()
    close(pv.key)
  }

  return (
    <section
      className={visible ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
      data-testid={`pinned-app-${pv.key}`}
      data-phase={pv.phase}
      aria-label={app?.title ?? pv.appId}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-ash">
          <AppIcon />
        </span>
        <span className="truncate text-[13px] font-medium tracking-tight text-chalk" data-testid="pinned-title">
          {app?.title ?? pv.appId}
        </span>
        <span className="truncate text-[11px] text-slate">{scope}</span>
        {app && (
          <span className="readout shrink-0 text-[10px] text-slate" data-testid="pinned-status">
            {app.status.label}
          </span>
        )}
        <button
          type="button"
          className="ml-auto flex items-center justify-center rounded p-1 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
          aria-label={`Close ${app?.title ?? pv.appId}`}
          onClick={() => void onClose()}
          data-testid="pinned-close"
        >
          <CloseIcon />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col p-2">
        <Body app={app} pv={pv} frame={frame} />
      </div>
    </section>
  )
}

function Body({ app, pv, frame }: { app: ExternalCatalogApp | undefined; pv: PinnedView; frame: React.RefObject<AppFrameHandle | null> }) {
  const trust = useStore((s) => s.setProjectTrusted)
  /*
   * 인스턴스가 열려 있는 동안은 **무슨 일이 있어도 프레임을 그린다.** 앱이 막히거나 사라지면 위의 효과가
   * teardown을 보내고 자리를 되돌린다. 그 전에 여기서 안내문으로 갈아 끼우면 React가 iframe을 먼저 떼어,
   * teardown이 닿을 창이 없어진다(AppFrame의 약속: 떼기 전에 부른다).
   */
  if (pv.phase === 'open' && pv.instanceId) {
    return (
      <AppFrame
        ref={frame}
        fill
        appId={pv.appId}
        projectId={pv.projectId}
        instanceId={pv.instanceId}
        toolInput={pv.toolInput}
        toolResult={pv.toolResult}
        className="flex min-h-0 flex-1 flex-col"
      />
    )
  }
  if (!app) return null
  if (!app.info.home) {
    return (
      <Notice testId="pinned-no-screen" title="This app has no screen.">
        {app.info.description ?? 'Its manifest names no home tool, so there is nothing to show here.'}
      </Notice>
    )
  }
  if (app.info.status === 'untrusted') {
    return (
      <Notice testId="pinned-untrusted" title={app.status.reason ?? ''}>
        Trusting lets this project&apos;s apps run and its settings apply.
        {app.projectId && (
          <button
            type="button"
            className="mt-3 block rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite"
            onClick={() => void trust(app.projectId!, true)}
            data-testid="pinned-trust"
          >
            Trust this project
          </button>
        )}
      </Notice>
    )
  }
  if (!app.status.runnable) {
    return (
      <Notice testId="pinned-blocked" title={app.status.label}>
        <span className="whitespace-pre-wrap break-words" data-testid="pinned-reason">
          {app.status.reason}
        </span>
      </Notice>
    )
  }
  if (pv.phase === 'failed') {
    return (
      <Notice testId="pinned-open-failed" title="This app's screen could not be opened.">
        <span className="whitespace-pre-wrap break-words" data-testid="pinned-reason">
          {pv.error}
        </span>
      </Notice>
    )
  }
  return <div className="px-3 py-2 text-[12px] text-ash" data-testid="pinned-opening">Opening {app.title}…</div>
}

function Notice({ testId, title, children }: { testId: string; title: string; children?: ReactNode }) {
  return (
    <div className="m-auto max-w-md px-6 py-10 text-center" data-testid={testId}>
      <p className="text-[13px] text-chalk">{title}</p>
      {children && <div className="mt-2 flex flex-col items-center text-[12px] leading-relaxed text-ash">{children}</div>}
    </div>
  )
}
