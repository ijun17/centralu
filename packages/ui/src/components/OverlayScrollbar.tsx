import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** The thinnest a thumb gets, so a very long conversation still leaves something to grab */
const MIN_THUMB = 24

/**
 * A scrollbar drawn over the content instead of beside it (owner, 2026-10-18): the scroller hides its own bar
 * (`.cc-scroll-overlay`, zero width) and this thumb floats over its right edge. The native bar took a column of
 * its own, which, with the answer bubble's padding inside the page's, left one layer of padding too many on the
 * right.
 *
 * Put it in a `relative` box that holds the scroller and has the same size: it reads the scroller's position on
 * every scroll and its size whenever the scroller or anything in it resizes. Drag the thumb to scroll. `onGrab`
 * runs when the thumb is pressed, for a scroller that has to know a person took over (the conversation's
 * following, which a press on the native bar used to tell it).
 */
export function OverlayScrollbar({
  scrollRef,
  onGrab,
  testId,
}: {
  scrollRef: RefObject<HTMLElement | null>
  onGrab?: () => void
  testId?: string
}) {
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const frame = useRef(0)

  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      const { scrollTop, scrollHeight, clientHeight } = el
      if (scrollHeight <= clientHeight + 1) return setThumb(null)
      const height = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * clientHeight)
      const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height)
      setThumb((t) =>
        t && Math.abs(t.top - top) < 0.5 && Math.abs(t.height - height) < 0.5 ? t : { top, height },
      )
    })
  }, [scrollRef])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', measure, { passive: true })
    // The content's height changes without a scroll (a row measured, a card folded open): watch every child
    const sizes = new ResizeObserver(measure)
    const watchChildren = () => {
      sizes.disconnect()
      sizes.observe(el)
      for (const child of Array.from(el.children)) sizes.observe(child)
      measure()
    }
    watchChildren()
    const children = new MutationObserver(watchChildren)
    children.observe(el, { childList: true })
    return () => {
      el.removeEventListener('scroll', measure)
      sizes.disconnect()
      children.disconnect()
      cancelAnimationFrame(frame.current)
    }
  }, [scrollRef, measure])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el || !thumb || e.button !== 0) return
    e.preventDefault()
    onGrab?.()
    const startY = e.clientY
    const startTop = el.scrollTop
    const ratio = (el.scrollHeight - el.clientHeight) / Math.max(1, el.clientHeight - thumb.height)
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => {
      el.scrollTop = startTop + (ev.clientY - startY) * ratio
    }
    const up = () => {
      setDragging(false)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  if (!thumb) return null
  return (
    <div
      aria-hidden
      className="group absolute right-0 z-10 flex w-2.5 justify-center"
      style={{ top: thumb.top, height: thumb.height }}
      onPointerDown={onPointerDown}
      data-testid={testId}
    >
      <div
        className={`h-full rounded-full transition-[width,background-color] duration-150 ${
          dragging
            ? 'w-1.5 bg-scrollbar-thumb-hover'
            : 'w-1 bg-scrollbar-thumb group-hover:w-1.5 group-hover:bg-scrollbar-thumb-hover'
        }`}
      />
    </div>
  )
}
