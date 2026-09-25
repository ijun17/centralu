import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { externalAppKey, registerPinnedFrame, useStore, type PinnedView } from '../../store/store.js'
import { useExternalApp, type ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppFrame, type AppFrameHandle, type AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { AppIcon, CloseIcon } from '../../components/icons.jsx'
import { RunsPanel } from './RunsPanel.jsx'
import { MessageAsk, messageText, type MessageAskState } from './MessageAsk.jsx'
import { BuilderPane } from './BuilderPane.jsx'
import { ErrorTail } from './ErrorTail.jsx'
import { FixBar } from './FixBar.jsx'
import { useAppBuilder } from './useAppBuilder.js'
import { UpdatedCue } from './UpdatedCue.jsx'

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
  // 기록 판(B-7)은 화면마다 따로 연다 — 한 앱의 기록을 보던 사람이 다른 앱으로 가면 그 앱의 화면이 먼저다
  const [runsOpen, setRunsOpen] = useState(false)
  // 만드는 세션 (C-5) — 아래 입력줄이 말을 보내는 곳이고, 그 대화를 화면 옆에 여닫는다(BuilderPane)
  const builder = useAppBuilder(pv.projectId, pv.appId)
  const [builderOpen, setBuilderOpen] = useState(false)

  /*
   * 화면의 `ui/message` (B-4) — 어느 세션으로 보낼지 묻는다(MessageAsk). 사람이 고르기 전에는 아무것도
   * 보내지 않고, 화면의 요청은 답을 기다린다. 먼저 온 물음이 남아 있으면 그것은 거절로 닫는다(링크
   * 확인과 같은 규칙, AppFrame). 글이 한 조각도 없는 말은 묻지 않고 거절한다 — 보낼 것이 없다.
   */
  const sendViewMessage = useStore((s) => s.sendViewMessage)
  const [ask, setAsk] = useState<MessageAskState | null>(null)
  const askRef = useRef<MessageAskState | null>(null)
  const settleAsk = useCallback((sent: boolean) => {
    const a = askRef.current
    askRef.current = null
    setAsk(null)
    a?.resolve(sent)
    return a
  }, [])
  const onMessage = useCallback(
    (m: AppFrameMessage) =>
      new Promise<boolean>((resolve) => {
        const { text, dropped } = messageText(m.content)
        if (!text) return resolve(false)
        askRef.current?.resolve(false)
        const next = { text, dropped, resolve }
        askRef.current = next
        setAsk(next)
      }),
    [],
  )
  const answer = async (sessionId: string | null) => {
    if (!sessionId) return void settleAsk(false)
    const a = askRef.current
    if (!a) return
    askRef.current = null
    setAsk(null)
    /*
     * 대화 안 화면과 **같은 길**로 보낸다 (`apps.viewMessage`) — 고른 대화에는 앱이 보낸 말로 남고, 에이전트는 host가
     * "앱의 글"로 감싼 모양을 받는다. 사람의 말(`send`)로 보내면 앱의 글이 사람의 지시로 둔갑한다. 틀은 host가 짓는다.
     */
    const sent = pv.instanceId ? await sendViewMessage(sessionId, pv.instanceId, a.text) : false
    if (sent) setToast(`Sent to ${useStore.getState().sessions[sessionId]?.name ?? 'the session'}`)
    a.resolve(sent)
  }
  // 화면이 내려가면(닫기·다시 시작·신뢰를 잃음) 묻던 것도 거절로 닫는다 — 답할 화면이 없다
  useEffect(() => {
    if (pv.phase !== 'open') settleAsk(false)
  }, [pv.phase, settleAsk])
  useEffect(() => () => void settleAsk(false), [settleAsk])

  /*
   * 그려진 프레임을 스토어에 올린다 (C-4) — 앱이 새 코드로 다시 뜨면 스토어가 이 화면을 다시 여는데(reloadPinnedView),
   * 그 전에 이 손잡이로 teardown을 보낸다.
   */
  useEffect(() => {
    if (pv.phase !== 'open' || !pv.instanceId) return
    return registerPinnedFrame(pv.key, { teardown: () => frame.current?.teardown() ?? Promise.resolve('not-connected') })
  }, [pv.phase, pv.instanceId, pv.key])
  const reload = useStore((s) => s.reloadPinnedView)

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
  // 다시 시작도 화면을 내리는 길이다 — teardown을 먼저 보낸다
  const restart = useStore((s) => s.restartApp)
  const onRestart = async () => {
    await frame.current?.teardown()
    await restart(pv.key)
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
        {/* 새 코드로 다시 열었다 (C-4) — 잠깐 서는 한 마디. 너무 자주 바뀌어 저절로 열지 않았으면 사람이 누른다 */}
        {pv.phase === 'open' && pv.updatedAt && <UpdatedCue key={pv.updatedAt} at={pv.updatedAt} testId="pinned-updated" />}
        {pv.phase === 'open' && pv.stale && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:bg-graphite/50 hover:text-chalk"
            onClick={() => void reload(pv.key)}
            title="The app now runs new code. It changed several times in a row, so this view was not reopened on its own"
            data-testid="pinned-stale"
          >
            Changed · Reload
          </button>
        )}
        {builder.id && (
          <button
            type="button"
            className={`ml-auto rounded px-2 py-0.5 text-[11px] transition-colors ${
              builderOpen ? 'bg-graphite text-chalk' : 'text-slate hover:bg-graphite/50 hover:text-chalk'
            }`}
            aria-pressed={builderOpen}
            onClick={() => setBuilderOpen((v) => !v)}
            data-testid="pinned-builder-toggle"
            title="The builder session's conversation, beside this app"
          >
            Builder
          </button>
        )}
        <button
          type="button"
          className={`${builder.id ? '' : 'ml-auto '}rounded px-2 py-0.5 text-[11px] transition-colors ${
            runsOpen ? 'bg-graphite text-chalk' : 'text-slate hover:bg-graphite/50 hover:text-chalk'
          }`}
          aria-pressed={runsOpen}
          onClick={() => setRunsOpen((v) => !v)}
          data-testid="pinned-runs-toggle"
          title="Recent runs of this app — who called which tool, and how it ended"
        >
          Runs
        </button>
        <button
          type="button"
          className="flex items-center justify-center rounded p-1 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
          aria-label={`Close ${app?.title ?? pv.appId}`}
          onClick={() => void onClose()}
          data-testid="pinned-close"
        >
          <CloseIcon />
        </button>
      </header>
      {/*
        화면 칸은 늘 이 줄의 첫 자식이다. 판을 여닫아도 React가 화면 칸을 새로 만들지 않는다 — 새로 만들면
        iframe이 떨어져 문서를 잃는다(이 파일 머리말).
      */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col p-2">
          <Body app={app} pv={pv} frame={frame} onRestart={() => void onRestart()} onMessage={onMessage} />
          <ErrorTail app={app} builder={builder} onShowBuilder={() => setBuilderOpen(true)} />
          <FixBar app={app} pv={pv} builder={builder} onShowBuilder={() => setBuilderOpen(true)} />
          {ask && <MessageAsk appTitle={app?.title ?? pv.appId} projectId={pv.projectId} ask={ask} onAnswer={(id) => void answer(id)} />}
        </div>
        {/* 보일 때만 그린다 — 숨은 동안 같은 세션을 포커스 뷰가 그리면 한 대화가 두 칸에 선다 */}
        {builderOpen && visible && builder.id && <BuilderPane sessionId={builder.id} onClose={() => setBuilderOpen(false)} />}
        {runsOpen && <RunsPanel appId={pv.appId} projectId={pv.projectId} />}
      </div>
    </section>
  )
}

function Body({
  app,
  pv,
  frame,
  onRestart,
  onMessage,
}: {
  app: ExternalCatalogApp | undefined
  pv: PinnedView
  frame: React.RefObject<AppFrameHandle | null>
  onRestart: () => void
  onMessage: (m: AppFrameMessage) => Promise<boolean>
}) {
  const trust = useStore((s) => s.setProjectTrusted)
  const title = app?.title ?? pv.appId
  /*
   * 인스턴스가 열려 있는 동안은 **무슨 일이 있어도 프레임을 그린다.** 앱이 막히거나 사라지면 위의 효과가
   * teardown을 보내고 자리를 되돌린다. 그 전에 여기서 안내문으로 갈아 끼우면 React가 iframe을 먼저 떼어,
   * teardown이 닿을 창이 없어진다(AppFrame의 약속: 떼기 전에 부른다).
   *
   * 떠 있던 앱이 죽었으면(B-6) 프레임 위에 이유와 "Restart"를 세운다. 프레임은 남긴다 — 앱은 다음 부름에
   * 스스로 다시 뜨고(crashed), 사람이 보던 화면의 내용도 아직 거기 있다. 멈춘 앱(failed)은 스스로 다시
   * 뜨지 않으므로 이 단추가 유일한 길이다.
   */
  if (pv.phase === 'open' && pv.instanceId) {
    const down = app?.info.status === 'crashed' || app?.info.status === 'failed'
    return (
      <>
        {down && (
          <div
            className="mb-2 flex items-start gap-3 rounded-md border border-edge bg-panel px-3 py-2 text-[12px]"
            role="alert"
            data-testid="pinned-crashed"
          >
            <div className="min-w-0 flex-1">
              <p className="text-chalk">{app?.info.status === 'failed' ? 'This app stopped after failing repeatedly.' : 'This app stopped.'}</p>
              {app?.status.reason && (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-ash" data-testid="pinned-reason">
                  {app.status.reason}
                </p>
              )}
            </div>
            <RestartButton onClick={onRestart} />
          </div>
        )}
        <AppFrame
          ref={frame}
          fill
          appId={pv.appId}
          projectId={pv.projectId}
          instanceId={pv.instanceId}
          toolInput={pv.toolInput}
          toolResult={pv.toolResult}
          onMessage={onMessage}
          loading={<Skeleton label={`Opening ${title}…`} />}
          className="flex min-h-0 flex-1 flex-col"
        />
      </>
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
  // 멈춘 앱(연달아 못 떴다) — 스스로 다시 뜨지 않는다. 이유와 다시 시작하는 길을 함께 준다
  if (app.info.status === 'failed') {
    return (
      <Notice testId="pinned-failed" title="This app stopped after failing repeatedly.">
        <span className="whitespace-pre-wrap break-words" data-testid="pinned-reason">
          {app.status.reason}
        </span>
        <RestartButton onClick={onRestart} className="mt-3" />
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
        <RestartButton onClick={onRestart} className="mt-3" />
      </Notice>
    )
  }
  const label =
    pv.phase === 'restarting' ? `Restarting ${title}…` : app.info.status === 'running' ? `Opening ${title}…` : `Starting ${title}…`
  return <Skeleton label={label} />
}

function RestartButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={`shrink-0 rounded border border-edge bg-void px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite ${className}`}
      onClick={onClick}
      data-testid="pinned-restart"
    >
      Restart
    </button>
  )
}

/**
 * 앱이 뜨는 동안의 자리 (B-6). 2026-09-14 결정: 비동기는 스켈레톤만 잘하면 된다.
 *
 * 앱은 처음 필요할 때 뜬다. 그래서 쉬던 앱을 여는 순간이 곧 프로세스가 뜨는 순간이다(성능 예산: 스켈레톤은
 * 즉시, 첫 화면은 2초 안). 빈 영역이나 한 줄짜리 "Loading"은 멈춘 것과 구별되지 않는다. 화면이 설 자리의
 * 모양을 먼저 보이고, 무엇을 기다리는지는 한 줄로 말한다(뜨는 중인지, 여는 중인지, 다시 시작하는 중인지).
 * 조용한 색만 쓴다 — 기다림은 사람을 부르는 신호가 아니다(팔레트 규칙).
 */
function Skeleton({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 rounded-md border border-edge bg-panel p-4"
      role="status"
      aria-live="polite"
      data-testid="pinned-skeleton"
    >
      <p className="text-[12px] text-ash" data-testid="pinned-skeleton-label">
        {label}
      </p>
      <div className="h-3 w-1/3 animate-pulse rounded bg-graphite/60" />
      <div className="h-24 animate-pulse rounded bg-graphite/40" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-graphite/40" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-graphite/40" />
    </div>
  )
}

function Notice({ testId, title, children }: { testId: string; title: string; children?: ReactNode }) {
  return (
    <div className="m-auto max-w-md px-6 py-10 text-center" data-testid={testId}>
      <p className="text-[13px] text-chalk">{title}</p>
      {children && <div className="mt-2 flex flex-col items-center text-[12px] leading-relaxed text-ash">{children}</div>}
    </div>
  )
}
