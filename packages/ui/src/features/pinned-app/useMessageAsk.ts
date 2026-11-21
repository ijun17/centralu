import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppFrameMessage } from '../app-frame/AppFrame.jsx'
import { messageText, type MessageAskState } from './MessageAsk.jsx'

/**
 * The question a view's `ui/message` raises, for the pinned and in-conversation views (answered by a session pick, or
 * send / don't). `onMessage` holds the frame's request until answered; an earlier pending one is declined (as links
 * are, AppFrame), one without text is declined unasked. `take` hands the pending one to the caller to resolve; `settle`
 * closes it. Unmounting declines it.
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
