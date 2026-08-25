import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 모달 껍데기.
 *
 * **반드시 포털로 띄운다.** `absolute inset-0`은 가장 가까운 positioned 조상을 기준으로
 * 자리를 잡는데, 모달을 쓰는 컴포넌트가 어디에 놓이는지는 모달이 알 바가 아니다.
 * 실제로 사이드바에 폭 조절 손잡이를 넣느라 `relative`를 붙였더니, 그 안에서 열리던
 * 세션 생성 모달이 **사이드바 폭 안에 갇혔다** (도그푸딩에서 지적됨).
 * 조상의 사정과 무관하게 창 전체를 덮으려면 body에 붙이는 수밖에 없다.
 *
 * esc와 바깥 클릭으로 닫는 것도 여기서 한 번만 처리한다 — 쓰는 쪽마다 다시 쓰면
 * 어떤 모달은 esc가 되고 어떤 건 안 되는 상태가 된다.
 */
export function Modal({
  onClose,
  children,
  testId,
  align = 'center',
}: {
  onClose: () => void
  children: ReactNode
  testId?: string
  /** 위쪽에 붙일지 가운데 둘지. 목록형은 위가 편하다 */
  align?: 'center' | 'top'
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-void/80 backdrop-blur-[2px] ${
        align === 'top' ? 'items-start pt-[calc(12vh/var(--text-zoom))]' : 'items-center'
      }`}
      onClick={onClose}
      data-testid={testId}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    document.body,
  )
}
