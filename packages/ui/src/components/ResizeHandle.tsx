import { useEffect, useRef, useState } from 'react'

/**
 * 레인 폭 조절 손잡이.
 *
 * 폭은 **손잡이가 붙은 요소의 실제 모서리**를 기준으로 계산한다.
 * 창 가장자리(window.innerWidth)를 기준으로 삼으면, 레이아웃이 한 번 창 밖으로
 * 밀려난 순간부터 기준점이 어긋나 끌수록 더 커지는 되먹임이 생긴다
 * (도그푸딩: "키운 크기보다 더 커져서 화면이 옆으로 스크롤된다").
 * 요소 자신의 rect를 쓰면 밀려난 상태에서도 계산이 스스로 맞춰진다.
 *
 * 더블클릭하면 기본값으로 돌아온다 — 잘못 끌어놓고 되돌릴 방법이 없으면 안 된다.
 */
export function ResizeHandle({
  side,
  onResize,
  onReset,
  testId,
  min,
  max,
  onDraggingChange,
}: {
  /**
   * 손잡이가 붙는 모서리.
   * 'left'/'right'는 폭을, 'top'은 높이를 조절한다 — 위아래로 나뉜 두 칸의 경계다.
   */
  side: 'left' | 'right' | 'top'
  onResize: (width: number) => void
  onReset: () => void
  testId: string
  min: number
  max: number
  /** 끄는 중에는 애니메이션을 꺼야 한다 — 매 프레임 보간하면 손을 따라오지 못한다 */
  onDraggingChange?: (dragging: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const pane = ref.current?.parentElement
    if (!pane) return

    const onMove = (e: MouseEvent) => {
      const rect = pane.getBoundingClientRect()
      onResize(
        side === 'left' ? rect.right - e.clientX
        : side === 'right' ? e.clientX - rect.left
        : rect.bottom - e.clientY,
      )
    }
    const onUp = () => {
      setDragging(false)
      onDraggingChange?.(false)
    }

    // 끄는 동안 글자가 잡히면 커서가 튄다
    document.body.style.cursor = side === 'top' ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, onResize, side, onDraggingChange])

  return (
    <div
      ref={ref}
      className={`absolute z-10 transition-colors ${
        side === 'top'
          ? 'left-0 top-0 h-1 w-full cursor-row-resize'
          : `top-0 h-full w-1 cursor-col-resize ${side === 'left' ? 'left-0' : 'right-0'}`
      } ${dragging ? 'bg-graphite' : 'hover:bg-graphite/60'}`}
      onMouseDown={(e) => {
        e.preventDefault()
        setDragging(true)
        onDraggingChange?.(true)
      }}
      onDoubleClick={onReset}
      data-testid={testId}
      role="separator"
      aria-orientation={side === 'top' ? 'horizontal' : 'vertical'}
      aria-valuemin={min}
      aria-valuemax={max}
      title={side === 'top' ? 'Drag to resize height · double-click to reset' : 'Drag to resize width · double-click to reset'}
    />
  )
}
