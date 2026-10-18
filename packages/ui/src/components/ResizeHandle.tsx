import { useCallback, useEffect, useRef, useState } from 'react'

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
 *
 * #842 item 11:
 *  - **Only the primary button drags.** A right-click, or a Ctrl+click (the context menu on macOS), started a drag whose
 *    mouseup the context menu swallowed, so the edge followed the pointer until the next click.
 *  - **A drag ends if the handle goes away mid-drag** (the panel closed under it by ⌘B): the owner is told, or the
 *    panel's width animation stayed off for good. It also ends when the window loses focus, where no mouseup comes.
 *  - **The keyboard resizes it**: it is a focusable separator, and the arrows move the edge (Shift for a bigger step),
 *    Home and End go to the limits.
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
  // The size the separator reports to a screen reader, measured when it changes by keyboard or a drag ends
  const [now, setNow] = useState<number | null>(null)
  const sizeOf = useCallback(() => {
    const rect = ref.current?.parentElement?.getBoundingClientRect()
    return rect ? Math.round(side === 'top' ? rect.height : rect.width) : null
  }, [side])

  // A drag in progress when the handle unmounts still has to be ended for the owner
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

    // If text gets selected while dragging, the cursor jumps
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

/**
 * The size a key moves a handle to, or null when the key is not a resize (a pure function: tests attach here). The
 * arrow that points the way the edge moves grows the pane: → for a handle on a pane's right edge, ← for one on its left
 * edge, ↑ for one on its top edge.
 */
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
