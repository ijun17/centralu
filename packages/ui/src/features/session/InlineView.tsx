import { useCallback, useEffect, useRef, useState } from 'react'
import { registerInlineFrame, useStore, type InlineView as InlineViewState } from '../../store/store.js'
import { useExternalApp } from '../../store/app-catalog.js'
import { AppFrame, type AppFrameHandle, type AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { messageText } from '../pinned-app/MessageAsk.jsx'
import { UpdatedCue } from '../pinned-app/UpdatedCue.jsx'
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
 *
 * **가상 스크롤** (플랜: 벗어나기 전에 teardown을 보내고 정지 이미지를 남긴다). 대화 목록은 화면 밖으로 멀리
 * 나간 줄을 DOM에서 뗀다 — 떼는 순간 iframe의 창도 사라져, 그 뒤에 보낸 teardown은 닿지 않는다. 그래서
 * 프레임이 그려진 줄은 목록이 떼지 않고 붙들어 두고(`registerInlineFrame`), 뗄 때가 된 줄에는 `leaving`을
 * 준다. 화면은 그때 teardown을 보내고 자리표시로 접힌다 — 그다음에야 줄이 떨어진다. 자리표시의
 * "Reopen"은 도구를 다시 부르지 않고 host가 들고 있던 입력과 결과로 새 화면을 연다.
 *
 * 대화 자체가 바뀌거나 가려질 때(다른 세션, 고정 화면으로 이동)는 목록이 통째로 내려가 붙들 수 없다 —
 * 그때는 AppFrame의 마지막 시도(내려가며 teardown을 부친다)가 전부이고, 화면은 살아 있는 채로 남아 돌아오면
 * 다시 그려진다(같은 인스턴스, 입력과 결과를 다시 받는다).
 */
export function InlineViewSlot({ sessionId, callId, leaving = false }: { sessionId: string; callId: string; leaving?: boolean }) {
  const view = useStore((s) => s.inlineViews[sessionId]?.[callId])
  if (!view) return null
  // 세션이 바뀌면 같은 줄이 다른 대화의 카드를 그릴 수 있다 — 화면의 상태를 섞지 않게 열쇠로 가른다
  return <InlineViewBody key={`${sessionId}:${callId}`} sessionId={sessionId} view={view} leaving={leaving} />
}

type Ask = { text: string; dropped: number; resolve: (sent: boolean) => void }

function InlineViewBody({ sessionId, view, leaving }: { sessionId: string; view: InlineViewState; leaving: boolean }) {
  const app = useExternalApp(view.projectId, view.appId)
  const title = app?.title ?? view.appId
  const frame = useRef<AppFrameHandle>(null)
  const close = useStore((s) => s.closeInlineView)
  const reopen = useStore((s) => s.reopenInlineView)
  const openApp = useStore((s) => s.openApp)
  const sendViewMessage = useStore((s) => s.sendViewMessage)
  const reload = useStore((s) => s.reloadInlineView)
  const callId = view.callId

  const showFrame = (view.state === 'live' || view.state === 'closing') && view.instanceId !== null
  /*
   * 프레임이 그려진 동안 스토어에 손잡이를 올린다 — 누가 접든(스크롤, 상한, host의 닫힘) teardown이 이 손잡이로
   * 먼저 간다. 목록은 손잡이가 있는 줄을 떼지 않는다.
   */
  useEffect(() => {
    if (!showFrame) return
    return registerInlineFrame(sessionId, callId, {
      teardown: () => frame.current?.teardown() ?? Promise.resolve('not-connected'),
    })
  }, [showFrame, sessionId, callId])

  // 목록이 이 줄을 뗄 때가 됐다 — teardown을 보내고 접는다. 접히면 손잡이가 내려가고 그때 줄이 떨어진다
  useEffect(() => {
    if (leaving && view.state === 'live' && showFrame) void close(sessionId, callId, 'Closed when it scrolled out of view')
  }, [leaving, view.state, showFrame, close, sessionId, callId])

  /*
   * 프레임을 띄우지 못했다 — 인스턴스가 이미 닫혔거나(host가 다시 떴다) 문서를 못 읽었다. 깨진 프레임을 두지
   * 않고 자리표시로 접는다. host가 들고 있으면 "Reopen"이 새 인스턴스로 다시 연다.
   */
  const onFailed = useCallback(
    (message: string) => void close(sessionId, callId, `This view could not be shown: ${message}`),
    [close, sessionId, callId],
  )

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
        {/* 새 코드로 다시 열었다 (M4 C-4) — 고정 화면과 같은 한 마디. 너무 자주 바뀌었으면 사람이 누른다 */}
        {view.state === 'live' && view.updatedAt && <UpdatedCue key={view.updatedAt} at={view.updatedAt} testId="inline-view-updated" />}
        {view.state === 'live' && view.stale && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-ash transition-colors hover:bg-graphite/60 hover:text-chalk"
            onClick={() => void reload(sessionId, callId)}
            title="The app now runs new code. It changed several times in a row, so this view was not reopened on its own"
            data-testid="inline-view-stale"
          >
            Changed · Reload
          </button>
        )}
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
            onFailed={onFailed}
          />
        ) : (
          <Placeholder
            view={view}
            title={title}
            canOpen={!!app?.info.home}
            onOpen={() => openApp(view.projectId, view.appId)}
            onReopen={() => void reopen(sessionId, callId)}
          />
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
 * 그림 대신 한 줄이다 — 어느 앱의 화면이었고 왜 접혔는지, 그리고 할 수 있는 일: host가 이 호출을 들고
 * 있으면 "Reopen"(도구를 다시 부르지 않는다), 앱에 홈 화면이 있으면 "Open app"(고정 화면).
 */
function Placeholder({
  view,
  title,
  canOpen,
  onOpen,
  onReopen,
}: {
  view: InlineViewState
  title: string
  canOpen: boolean
  onOpen: () => void
  onReopen: () => void
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
      {view.kept && (
        <button
          type="button"
          className="shrink-0 rounded border border-edge bg-void px-2.5 py-0.5 text-chalk transition-colors hover:border-graphite"
          onClick={onReopen}
          title="Show this call's view again, with the same input and result. The tool is not called again."
          data-testid="inline-view-reopen"
        >
          Reopen
        </button>
      )}
      {canOpen && (
        <button
          type="button"
          className="shrink-0 rounded px-2 py-0.5 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
          onClick={onOpen}
          data-testid="inline-view-open-app"
        >
          Open app
        </button>
      )}
    </div>
  )
}
