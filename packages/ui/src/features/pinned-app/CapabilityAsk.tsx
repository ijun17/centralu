import { useEffect } from 'react'
import type { AppQuestion } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { PermissionCard, approvalKeyAction } from '../approval/ApprovalCard.jsx'

/**
 * 고정 화면 위의 능력 물음 (M4 D-4) — 이 앱의 화면에서 시작된 사슬이 능력(에이전트, 다른 앱, host 데이터)을 처음 쓰려 한다.
 *
 * 화면에서 시작된 호출에는 세션이 없다. 사람이 누른 것은 이 화면이고, 부탁은 그 누름에서 나왔다 — 그래서 물음이 이 화면
 * 위에 선다(세션에서 시작된 사슬의 물음은 그 세션의 승인 카드다). 모양은 세션의 카드와 같다(`PermissionCard`): 같은 물음은
 * 어디에 서든 같은 얼굴이어야 한다. 능력을 쓰려는 앱이 이 앱이 부른 다른 앱이면 그 앱의 이름이 카드에 선다.
 *
 * 답할 때까지 화면의 호출은 기다린다(host가 진행 알림으로 살려 둔다). 답하지 않고 5분이 지나면 host가 거절로 닫고, 이 카드는
 * 목록에서 사라진다. 키는 세션의 카드와 같은 y/n — 이 화면을 보고 있을 때만 받는다.
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
      // "항상 허용"은 없다 — 답은 어차피 기억된다
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
