import { useCallback, useEffect, useRef, useState } from 'react'
import { registerInlineFrame, useStore, type InlineView as InlineViewState } from '../../store/store.js'
import { useExternalApp } from '../../store/app-catalog.js'
import { AppFrame, type AppFrameHandle, type AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { messageText } from '../pinned-app/MessageAsk.jsx'
import { UpdatedCue } from '../pinned-app/UpdatedCue.jsx'
import { AppIcon } from '../../components/icons.jsx'

/**
 * An in-conversation app view (M4 B-1) — when the agent calls an app tool that has a view, this
 * stands below that call's card.
 *
 * The view's lifetime is decided by the host (`app_view`: open → result/cancel → closed). This
 * component only renders it: while open, it mounts AppFrame and, per the spec, sends tool-input
 * once and then tool-result (or tool-cancelled) once (AppFrame enforces the order). When the
 * host closes it, **teardown is sent first**, then it collapses into the placeholder.
 *
 * The view's `ui/message` always goes **to this conversation** (B-4: an in-conversation view has
 * a fixed destination for messages). It still asks first, though — the view is the app's own
 * code, so it can send a message without anyone clicking anything. Nothing goes out until the
 * person reads the text to be sent and presses "Send". A sent message is recorded in the
 * conversation as something the app said, and the agent receives it wrapped by the host as the
 * app's text (the same rule as #120).
 *
 * "Pin" opens that app's pinned view (B-2) — the way to keep using the same app outside the
 * conversation.
 *
 * **Virtual scrolling** (the plan: send teardown and leave a still image before a row leaves the
 * viewport). The conversation list detaches rows from the DOM once they scroll far enough out of
 * view — the moment a row is detached, its iframe's window disappears too, so any teardown sent
 * after that never arrives. So a row with a mounted frame is held onto by the list instead of
 * being detached (`registerInlineFrame`), and a row about to be detached is given `leaving`. At
 * that point the view sends teardown and collapses into the placeholder — only then does the row
 * actually get detached. The placeholder's "Reopen" opens a new view with the input and result
 * the host still holds, without calling the tool again.
 *
 * When the conversation itself changes or is hidden (switching sessions, moving to a pinned
 * view), the whole list unmounts and there is nothing to hold onto — in that case AppFrame's last
 * attempt (firing off teardown on unmount) is all there is, and the view stays alive and
 * re-renders when it comes back (the same instance, receiving the input and result again).
 */
export function InlineViewSlot({ sessionId, callId, leaving = false }: { sessionId: string; callId: string; leaving?: boolean }) {
  const view = useStore((s) => s.inlineViews[sessionId]?.[callId])
  if (!view) return null
  // If the session changes, the same row can end up rendering a different conversation's card —
  // a key keeps view states from bleeding into each other
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
   * A handle is registered in the store while the frame is mounted — no matter what collapses
   * it (scrolling, a limit, the host closing it), teardown goes through this handle first. The
   * list does not detach a row that has a handle.
   */
  useEffect(() => {
    if (!showFrame) return
    return registerInlineFrame(sessionId, callId, {
      teardown: () => frame.current?.teardown() ?? Promise.resolve('not-connected'),
    })
  }, [showFrame, sessionId, callId])

  // The list is about to detach this row — send teardown and collapse. Once collapsed the
  // handle is unregistered, and only then does the row actually get detached
  useEffect(() => {
    if (leaving && view.state === 'live' && showFrame) void close(sessionId, callId, 'Closed when it scrolled out of view')
  }, [leaving, view.state, showFrame, close, sessionId, callId])

  /*
   * The frame failed to mount — either the instance was already closed (the host restarted it)
   * or the document could not be read. Rather than leaving a broken frame, this collapses into
   * the placeholder. If the host still holds it, "Reopen" opens it again as a new instance.
   */
  const onFailed = useCallback(
    (message: string) => void close(sessionId, callId, `This view could not be shown: ${message}`),
    [close, sessionId, callId],
  )

  /*
   * The view's `ui/message`. If an earlier question is still pending, that one is closed as
   * declined (the same rule as pinned views and link confirmation). If there is no text at all,
   * this declines without asking — there is nothing to send.
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
  // Once the view goes away, any pending question is closed as declined — there is no view
  // left to answer
  useEffect(() => {
    if (view.state !== 'live') settleAsk(false)
  }, [view.state, settleAsk])
  useEffect(() => () => settleAsk(false), [settleAsk])

  return (
    <div
      className="mt-1.5 rounded-md border border-line bg-surface-raised/60"
      data-testid="inline-view"
      data-call={view.callId}
      data-state={view.state}
    >
      <div className="flex items-center gap-2 px-2.5 py-1 text-xs">
        <span className="shrink-0 text-ink-faint">
          <AppIcon size={12} />
        </span>
        <span className="truncate text-ink-muted" data-testid="inline-view-title">
          {title}
        </span>
        {/* Reopened with new code (M4 C-4) — the same one-line cue as a pinned view. If it
        changed too often, the person clicks through */}
        {view.state === 'live' && view.updatedAt && <UpdatedCue key={view.updatedAt} at={view.updatedAt} testId="inline-view-updated" />}
        {view.state === 'live' && view.stale && (
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-surface-hover/60 hover:text-ink"
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
            className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
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
          <div className="mt-1.5 rounded-md border border-line bg-surface-side px-3 py-2 text-sm" role="dialog" data-testid="inline-view-ask">
            <p className="text-ink">{title} wants to send this to this conversation:</p>
            <pre
              className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-floor px-2.5 py-2 font-sans text-sm text-ink-muted"
              data-testid="inline-view-ask-text"
            >
              {ask.text}
            </pre>
            {ask.dropped > 0 && (
              <p className="mt-1 text-xs text-ink-faint">
                {ask.dropped} non-text part{ask.dropped > 1 ? 's' : ''} will not be sent.
              </p>
            )}
            <p className="mt-1.5 text-xs text-ink-faint">The agent will see it as the app&apos;s message, not as yours.</p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-ink-faint transition-colors hover:text-ink"
                onClick={() => void answer(false)}
                data-testid="inline-view-ask-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-line bg-surface-floor px-3 py-1 text-ink transition-colors hover:border-line-strong"
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
 * A slot with no view (the plan: a view that leaves the viewport should leave a still image).
 * A view whose contents are opaque cannot be captured as an image, so this is a line of text
 * instead — which app's view it was and why it collapsed, plus what can be done: "Reopen" if the
 * host still holds this call (does not call the tool again), "Open app" if the app has a home
 * view (pinned view).
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
      <p className="px-1 py-1 text-sm text-ink-muted" role="note" data-testid="inline-view-rejected">
        This view was not shown: <span className="text-ink-faint">{view.rejected}</span>
      </p>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-line px-3 py-2 text-sm" data-testid="inline-view-placeholder">
      <p className="min-w-0 flex-1 text-ink-muted">
        {title}&apos;s view is closed
        {view.reason && <span className="text-ink-faint" data-testid="inline-view-reason"> · {view.reason}</span>}
      </p>
      {view.kept && (
        <button
          type="button"
          className="shrink-0 rounded-md border border-line bg-surface-floor px-2.5 py-0.5 text-ink transition-colors hover:border-line-strong"
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
          className="shrink-0 rounded-md px-2 py-0.5 text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
          onClick={onOpen}
          data-testid="inline-view-open-app"
        >
          Open app
        </button>
      )}
    </div>
  )
}
