import { useEffect } from 'react'
import { isTextEntry } from '../../app/keys.js'
import type { AppQuestion } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { isCovered, type CoveringLayers } from '../../store/layers.js'
import { PermissionCard, approvalKeyAction } from '../approval/ApprovalCard.jsx'

/**
 * A capability question over a pinned view (M4 D-4): a chain this view started uses a capability (an agent, another
 * app, host data) for the first time. A view's call has no session and came from a press here, so it stands here (a
 * session's chain gets its approval card). Shaped as `PermissionCard`, naming the called app when it asks. The call
 * waits, kept alive by progress; after 5 minutes unanswered the host declines it. y/n only while this view is seen.
 */
export function CapabilityAsk({ question, visible }: { question: AppQuestion; visible: boolean }) {
  const answer = useStore((s) => s.answerAppQuestion)

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const action = approvalKeyAction(e, {
        typing: isTextEntry(e.target),
        covered: capabilityAskCovered(st),
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
      className="absolute inset-x-3 bottom-3 z-20 shadow-(--shadow-popover)"
      role="dialog"
      aria-label={`${question.app.name} asks for a permission`}
      data-testid="pinned-capability-ask"
    >
      <PermissionCard appName={question.app.name} text={question.text} onAnswer={(d) => void answer(question.id, d)} />
    </div>
  )
}

/** Whether the y/n keys belong to something else: a layer over the view, or another screen (pure, for tests) */
export function capabilityAskCovered(st: CoveringLayers & { view: string }): boolean {
  return isCovered(st) || st.view !== 'app'
}
