import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, type InlineView as InlineViewState } from '../../store/store.js'
import { useExternalApp } from '../../store/app-catalog.js'
import { AppFrame, type AppFrameHandle, type AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { messageText } from '../pinned-app/MessageAsk.jsx'
import { AppIcon } from '../../components/icons.jsx'

/**
 * 대화 안 앱 화면 (M4 B-1) — 에이전트가 화면이 달린 앱 도구를 부르면, 그 호출 카드 아래에 선다.
 *
 * 화면의 수명은 host가 정한다(`app_view`: 열림 → 결과·취소 → 닫힘). 이 부품은 그것을 그리기만 한다:
 * 열려 있으면 AppFrame을 띄우고 규격대로 tool-input을 한 번, 그다음 tool-result(또는 tool-cancelled)를
 * 한 번 보낸다(AppFrame이 순서를 지킨다). host가 닫으면 **teardown을 먼저 보내고** 자리표시로 접는다.
 *
 * 화면의 `ui/message`는 **이 대화로** 간다(B-4: 대화 안 화면은 보낼 곳이 정해져 있다). 그래도 묻는다 —
 * 화면은 앱의 코드라서 아무도 누르지 않아도 말을 보낼 수 있다. 사람이 보낼 글을 읽고 "Send"를 누르기
 * 전에는 아무것도 가지 않는다. 보낸 말은 대화에 앱이 보낸 말로 남고, 에이전트는 host가 앱의 글로 감싼
 * 모양을 받는다(#120과 같은 규칙).
 *
 * "Pin"은 그 앱의 고정 화면(B-2)을 연다 — 같은 앱을 대화 밖에서 계속 쓰는 길이다.
 */
export function InlineViewSlot({ sessionId, callId }: { sessionId: string; callId: string }) {
  const view = useStore((s) => s.inlineViews[sessionId]?.[callId])
  if (!view) return null
  // 세션이 바뀌면 같은 줄이 다른 대화의 카드를 그릴 수 있다 — 화면의 상태를 섞지 않게 열쇠로 가른다
  return <InlineViewBody key={`${sessionId}:${callId}`} sessionId={sessionId} view={view} />
}

type Ask = { text: string; dropped: number; resolve: (sent: boolean) => void }

function InlineViewBody({ sessionId, view }: { sessionId: string; view: InlineViewState }) {
  const app = useExternalApp(view.projectId, view.appId)
  const title = app?.title ?? view.appId
  const frame = useRef<AppFrameHandle>(null)
  const park = useStore((s) => s.parkInlineView)
  const openApp = useStore((s) => s.openApp)
  const sendViewMessage = useStore((s) => s.sendViewMessage)

  /*
   * host가 인스턴스를 닫았다(앱이 사라짐, 신뢰를 잃음, 사칭) — 프레임에 teardown을 보낸 뒤 접는다.
   * 프레임이 그려진 적이 없으면(카드가 화면 밖이었다) teardown은 곧바로 'not-connected'로 돌아온다.
   */
  useEffect(() => {
    if (view.state !== 'closing') return
    let alive = true
    void (async () => {
      await frame.current?.teardown()
      if (alive) park(sessionId, view.callId)
    })()
    return () => {
      alive = false
    }
  }, [view.state, sessionId, view.callId, park])

  /*
   * 화면의 `ui/message`. 먼저 온 물음이 남아 있으면 그것은 거절로 닫는다(고정 화면·링크 확인과 같은 규칙).
   * 글이 한 조각도 없으면 묻지 않고 거절한다 — 보낼 것이 없다.
   */
  const [ask, setAsk] = useState<Ask | null>(null)
  const askRef = useRef<Ask | null>(null)
  const settleAsk = useCallback((sent: boolean) => {
    const a = askRef.current
    askRef.current = null
    setAsk(null)
    a?.resolve(sent)
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
  const answer = async (send: boolean) => {
    const a = askRef.current
    if (!a) return
    askRef.current = null
    setAsk(null)
    if (!send || !view.instanceId) return a.resolve(false)
    a.resolve(await sendViewMessage(sessionId, view.instanceId, a.text))
  }
  // 화면이 내려가면 묻던 것도 거절로 닫는다 — 답할 화면이 없다
  useEffect(() => {
    if (view.state !== 'live') settleAsk(false)
  }, [view.state, settleAsk])
  useEffect(() => () => settleAsk(false), [settleAsk])

  const showFrame = (view.state === 'live' || view.state === 'closing') && view.instanceId !== null
  return (
    <div
      className="mt-1.5 rounded border border-edge bg-panel/60"
      data-testid="inline-view"
      data-call={view.callId}
      data-state={view.state}
    >
      <div className="flex items-center gap-2 px-2.5 py-1 text-[11px]">
        <span className="shrink-0 text-slate">
          <AppIcon size={12} />
        </span>
        <span className="truncate text-ash" data-testid="inline-view-title">
          {title}
        </span>
        {app?.info.home && !view.rejected && (
          <button
            type="button"
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
            onClick={() => openApp(view.projectId, view.appId)}
            title={`Open ${title} in its own view, beside your sessions`}
            data-testid="inline-view-pin"
          >
            Pin
          </button>
        )}
      </div>
      <div className="px-2 pb-2">
        {showFrame ? (
          <AppFrame
            ref={frame}
            key={view.instanceId}
            appId={view.appId}
            projectId={view.projectId}
            instanceId={view.instanceId!}
            toolInput={view.toolInput}
            toolResult={view.toolResult}
            toolCancelled={view.toolResult === undefined ? view.cancelled : undefined}
            onMessage={onMessage}
          />
        ) : (
          <Placeholder view={view} title={title} canOpen={!!app?.info.home} onOpen={() => openApp(view.projectId, view.appId)} />
        )}
        {ask && (
          <div className="mt-1.5 rounded-md border border-edge bg-pit px-3 py-2 text-[12px]" role="dialog" data-testid="inline-view-ask">
            <p className="text-chalk">{title} wants to send this to this conversation:</p>
            <pre
              className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-edge bg-void px-2.5 py-2 font-sans text-[12px] text-ash"
              data-testid="inline-view-ask-text"
            >
              {ask.text}
            </pre>
            {ask.dropped > 0 && (
              <p className="mt-1 text-[11px] text-slate">
                {ask.dropped} non-text part{ask.dropped > 1 ? 's' : ''} will not be sent.
              </p>
            )}
            <p className="mt-1.5 text-[11px] text-slate">The agent will see it as the app&apos;s message, not as yours.</p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-2 py-1 text-slate transition-colors hover:text-chalk"
                onClick={() => void answer(false)}
                data-testid="inline-view-ask-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-edge bg-void px-3 py-1 text-chalk transition-colors hover:border-graphite"
                onClick={() => void answer(true)}
                data-testid="inline-view-ask-send"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 화면이 없는 자리 (플랜: 벗어난 화면은 정지 이미지를 남긴다). 불투명 출처의 화면은 찍을 수 없어서
 * 그림 대신 한 줄이다 — 어느 앱의 화면이었고 왜 접혔는지, 그리고 할 수 있는 일.
 */
function Placeholder({
  view,
  title,
  canOpen,
  onOpen,
}: {
  view: InlineViewState
  title: string
  canOpen: boolean
  onOpen: () => void
}) {
  if (view.rejected) {
    return (
      <p className="px-1 py-1 text-[12px] text-ash" role="note" data-testid="inline-view-rejected">
        This view was not shown: <span className="text-slate">{view.rejected}</span>
      </p>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-edge px-3 py-2 text-[12px]" data-testid="inline-view-placeholder">
      <p className="min-w-0 flex-1 text-ash">
        {title}&apos;s view is closed
        {view.reason && <span className="text-slate" data-testid="inline-view-reason"> · {view.reason}</span>}
      </p>
      {canOpen && (
        <button
          type="button"
          className="shrink-0 rounded border border-edge bg-void px-2.5 py-0.5 text-chalk transition-colors hover:border-graphite"
          onClick={onOpen}
          data-testid="inline-view-open-app"
        >
          Open app
        </button>
      )}
    </div>
  )
}
