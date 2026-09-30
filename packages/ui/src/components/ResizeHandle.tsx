import { useEffect, useRef, useState } from 'react'

/**
 * The lane-width resize handle.
 *
 * Width is calculated relative to the actual edge of the element the handle is attached to.
 * Using the window's own edge (window.innerWidth) as the reference means the reference point
 * drifts the instant the layout is pushed past the window, producing a feedback loop where
 * dragging makes it grow even larger (dogfooding: "it grew larger than what was dragged and the
 * screen started scrolling sideways"). Using the element's own rect lets the calculation
 * self-correct even once it has been pushed out of place.
 *
 * Double-clicking resets it to the default — there must be a way back after an accidental drag.
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
   * The edge the handle is attached to.
   * 'left'/'right' resizes width, 'top' resizes height — the boundary between two panels
   * stacked vertically.
   */
  side: 'left' | 'right' | 'top'
  onResize: (width: number) => void
  onReset: () => void
  testId: string
  min: number
  max: number
  /** Animation must be turned off while dragging — interpolating every frame cannot keep up with the hand */
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

    // If text gets selected while dragging, the cursor jumps
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
