import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The lane resize handle. The size is measured from the pane's own rect, not window.innerWidth: once the layout is
 * pushed past the window that reference drifts, the drag grows more than the hand moved and the screen scrolls
 * sideways. Double-click resets to the default, the way back from an accidental drag.
 *
 * #842 item 11: only the primary button drags (a right-click or macOS Ctrl+click's menu swallows the mouseup, so the
 * edge would follow the pointer). A drag also ends for the owner when the handle unmounts (⌘B closed the panel), else
 * its width animation stays off, and on window blur, where no mouseup comes. It is a focusable separator: arrows move
 * the edge (Shift more), Home and End go to the limits.
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
  /** The edge the handle is on: `top` resizes the height of a pane stacked under another */
  side: 'left' | 'right' | 'top'
  onResize: (width: number) => void
  onReset: () => void
  testId: string
  min: number
  max: number
  /** The owner turns its animation off while dragging: interpolating every frame cannot keep up with the hand */
  onDraggingChange?: (dragging: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // The size the separator reports to a screen reader, measured when it changes by keyboard or a drag ends
  const [now, setNow] = useState<number | null>(null)
  const sizeOf = useCallback(() => {
    const rect = ref.current?.parentElement?.getBoundingClientRect()
    return rect ? Math.round(side === 'top' ? rect.height : rect.width) : null
  }, [side])

  const draggingRef = useRef(false)
  draggingRef.current = dragging
  const onDraggingChangeRef = useRef(onDraggingChange)
  onDraggingChangeRef.current = onDraggingChange
  useEffect(
    () => () => {
      if (draggingRef.current) onDraggingChangeRef.current?.(false)
    },
    [],
  )

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
      setNow(sizeOf())
    }

    // Text selected while dragging makes the cursor jump
    document.body.style.cursor = side === 'top' ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
    }
  }, [dragging, onResize, side, onDraggingChange, sizeOf])

  return (
    <div
      ref={ref}
      className={`absolute z-10 transition-colors ${
        side === 'top'
          ? 'left-0 top-0 h-1 w-full cursor-row-resize'
          : `top-0 h-full w-1 cursor-col-resize ${side === 'left' ? 'left-0' : 'right-0'}`
      } ${dragging ? 'bg-surface-hover' : 'hover:bg-surface-hover/60'}`}
      onMouseDown={(e) => {
        if (e.button !== 0 || e.ctrlKey) return
        e.preventDefault()
        setDragging(true)
        onDraggingChange?.(true)
      }}
      onDoubleClick={onReset}
      onFocus={() => setNow(sizeOf())}
      onKeyDown={(e) => {
        const current = sizeOf()
        if (current === null) return
        const next = keyResize(e, side, current, min, max)
        if (next === null) return
        e.preventDefault()
        onResize(next)
        // The owner may clamp it further: read back what it became
        requestAnimationFrame(() => setNow(sizeOf()))
      }}
      tabIndex={0}
      data-testid={testId}
      role="separator"
      aria-orientation={side === 'top' ? 'horizontal' : 'vertical'}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={now ?? undefined}
      aria-label={side === 'top' ? 'Resize height' : 'Resize width'}
      title={side === 'top' ? 'Drag to resize height · double-click to reset' : 'Drag to resize width · double-click to reset'}
    />
  )
}

/** The arrows move the edge by this much, Shift by four times as much */
export const KEY_STEP = 16

/** The size a key moves a handle to, or null; the arrow pointing the way the edge moves grows the pane */
export function keyResize(
  e: { key: string; shiftKey: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  side: 'left' | 'right' | 'top',
  current: number,
  min: number,
  max: number,
): number | null {
  if (e.altKey || e.metaKey || e.ctrlKey) return null
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  if (e.key === 'Home') return clamp(min)
  if (e.key === 'End') return clamp(max)
  const grow = side === 'right' ? 'ArrowRight' : side === 'left' ? 'ArrowLeft' : 'ArrowUp'
  const shrink = side === 'right' ? 'ArrowLeft' : side === 'left' ? 'ArrowRight' : 'ArrowDown'
  const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP
  if (e.key === grow) return clamp(current + step)
  if (e.key === shrink) return clamp(current - step)
  return null
}
