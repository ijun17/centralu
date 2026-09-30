import { useEffect } from 'react'
import type { AppQuestion } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { PermissionCard, approvalKeyAction } from '../approval/ApprovalCard.jsx'

/**
 * A capability question over a pinned view (M4 D-4) — a chain started by this app's view is trying to
 * use a capability (an agent, another app, host data) for the first time.
 *
 * A call started from a view has no session. What the person pressed was this view, and the request
 * came out of that press — so the question stands over this view (a question from a chain started by
 * a session is that session's approval card instead). Its shape matches the session card
 * (`PermissionCard`): the same question must wear the same face no matter where it stands. If the app
 * trying to use the capability is another app this app called, that app's name appears on the card.
 *
 * The view's call waits until it is answered (the host keeps it alive with progress notifications).
 * If 5 minutes pass unanswered, the host closes it as declined, and this card disappears from the
 * list. The keys are the same y/n as a session card — received only while this view is being looked
 * at.
 */
export function CapabilityAsk({ question, visible }: { question: AppQuestion; visible: boolean }) {
  const answer = useStore((s) => s.answerAppQuestion)

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const st = useStore.getState()
      const action = approvalKeyAction(e, {
        typing: t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable,
        covered: st.inboxOpen || st.usageOpen || st.settingsOpen || st.paletteOpen || st.overlay !== null || st.view !== 'app',
      })
      // There is no "always allow" — the answer is remembered either way
      if (!action || action.decision === 'always') return
      void answer(question.id, action.decision)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, question.id, answer])

  return (
    <div
      className="absolute inset-x-3 bottom-3 z-20 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
      role="dialog"
      aria-label={`${question.app.name} asks for a permission`}
      data-testid="pinned-capability-ask"
    >
      <PermissionCard appName={question.app.name} text={question.text} onAnswer={(d) => void answer(question.id, d)} />
    </div>
  )
}
