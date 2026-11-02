import { useCallback, useEffect, useRef, type DependencyList, type RefObject } from 'react'

/** How tall the fade at a cut edge is, in px (owner, 2026-11-03) */
export const EDGE_FADE_PX = 28

/**
 * How strong the fade is at each edge of a scroller, 0 to 1: none at the very top and at the very end (nothing is cut
 * there, and the newest line must stay plain), full strength once a fade's height of content lies beyond the edge.
 * Between, it ramps with the distance, so scrolling away from an end fades it in instead of switching it on. The first
 * pixel does not count: a position that rounds to the end is the end.
 */
export function edgeFadeLevels(pos: { scrollTop: number; scrollHeight: number; clientHeight: number }): { top: number; bottom: number } {
  const above = pos.scrollTop
  const below = pos.scrollHeight - pos.clientHeight - pos.scrollTop
  const level = (distance: number) => Math.round(Math.min(1, Math.max(0, distance - 1) / EDGE_FADE_PX) * 50) / 50
  return { top: level(above), bottom: level(below) }
}

/**
 * Fades a scroller's top and bottom edges where more content lies beyond them (#1706): a line cut by the edge then
 * reads as scrolling. The two fades are overlays in the colour of the floor, written straight into the DOM from the
 * scroll event: nothing renders per frame, and the scroller's own content (the pinned question above all, which sits
 * inside it, and any inline app frame) is left alone, as a mask on the scroller would not.
 *
 * While the view is following the newest line (`sticking`) the bottom is the end by definition: a chunk that has just
 * grown the list is not yet followed, and the line it brought must not flash faded in between. `resync` lists what
 * changes the content's height without a scroll; it is read after the commit's follow-to-bottom has moved the view.
 */
export function useEdgeFade(scrollRef: RefObject<HTMLElement | null>, sticking: RefObject<boolean>, resync: DependencyList) {
  const top = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const shown = useRef({ top: -1, bottom: -1 })
  const apply = useCallback(() => {
    const el = scrollRef.current
    if (!el || !top.current || !bottom.current) return
    const next = edgeFadeLevels(el)
    if (sticking.current) next.bottom = 0
    if (next.top !== shown.current.top) top.current.style.opacity = String(next.top)
    if (next.bottom !== shown.current.bottom) bottom.current.style.opacity = String(next.bottom)
    shown.current = next
  }, [scrollRef, sticking])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', apply, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    resize?.observe(el)
    apply()
    return () => {
      el.removeEventListener('scroll', apply)
      resize?.disconnect()
    }
  }, [scrollRef, apply])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what moves the end
  useEffect(apply, resync)
  return { top, bottom }
}
