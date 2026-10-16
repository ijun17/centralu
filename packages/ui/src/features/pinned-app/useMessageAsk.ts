import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { messageText, type MessageAskState } from './MessageAsk.jsx'

/**
 * The question a view's `ui/message` raises — shared by the pinned view and the in-conversation
 * view, which differ only in how the person answers (which session, or "send / don't").
 *
 * `onMessage` is the handler for the frame: it holds the view's request until the person answers.
 * If an earlier question is still pending, that one is closed as declined (the same rule as link
 * confirmation, AppFrame). A message with not a single piece of text is declined without asking —
 * there is nothing to send. `take` removes the pending question and hands it to the caller, which
 * must resolve it; `settle` closes it as sent or declined. A question still pending when the owner
 * goes away is closed as declined.
 */
export function useMessageAsk() {
  const [ask, setAsk] = useState<MessageAskState | null>(null)
  const askRef = useRef<MessageAskState | null>(null)
  const take = useCallback(() => {
    const a = askRef.current
    askRef.current = null
    setAsk(null)
    return a
  }, [])
  const settle = useCallback((sent: boolean) => take()?.resolve(sent), [take])
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
  useEffect(() => () => settle(false), [settle])
  return { ask, onMessage, take, settle }
}
