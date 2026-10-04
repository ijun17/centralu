import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * Where a popover that hangs under a button goes, so that all of it is inside the window.
 *
 * Why this exists: a popover drawn as an `absolute` child of its button is clipped by the first ancestor with an
 * overflow, and a grid panel is `overflow-hidden` (it has to be — its rounded corners and the orbit ring). The
 * background-task list hung off the session header that way and lost its right side, Stop included, in any panel
 * narrower than the list (0.1.0-beta.9, the owner's screenshot). The popover is therefore rendered into
 * `document.body` and placed `fixed`, which leaves no box to clip it — the same reason the tooltip and the sidebar's
 * row menu are fixed.
 *
 * All numbers are layout pixels: the caller divides the anchor's screen rect and the window by the zoom
 * (`--text-zoom`) first, for the reason RowMenu in Sidebar.tsx measured (a fixed length gets the zoom multiplied in a
 * second time).
 */

/** Between the button and the popover — flush, it is unclear where the button ends */
const GAP = 4
/** Off the window's edge — flush against it reads as cut off even when it is not */
const EDGE = 8

export type Placement = { top: number; left: number; maxHeight: number }

/**
 * Below the anchor, left edges lined up, unless that runs off the window:
 * - sideways it shifts left until its right edge is EDGE inside the window, but never past the window's left edge;
 * - if it does not fit below and there is more room above, it opens upward;
 * - either way its height is capped by the room on its side, and it scrolls inside.
 *
 * `height` is the popover's natural height (its content's), not the capped one, so a list that grew is placed for
 * what it now holds.
 */
export function placeUnder(
  anchor: { top: number; bottom: number; left: number },
  size: { width: number; height: number },
  win: { width: number; height: number },
): Placement {
  const below = anchor.bottom + GAP
  const roomBelow = Math.max(0, win.height - EDGE - below)
  const roomAbove = Math.max(0, anchor.top - GAP - EDGE)
  const up = size.height > roomBelow && roomAbove > roomBelow
  const maxHeight = up ? roomAbove : roomBelow
  const top = up ? anchor.top - GAP - Math.min(size.height, roomAbove) : below
  const left = Math.max(EDGE, Math.min(anchor.left, win.width - EDGE - size.width))
  return { top, left, maxHeight }
}

/**
 * `placeUnder` for a mounted popover, measured before paint (null until then: hide the popover while it is null, so
 * the frame where it sits at 0,0 never reaches the screen).
 *
 * It is placed again when anything scrolls (the anchor moved, the popover did not — capture, because scroll does not
 * bubble), when the window resizes, and when the popover's own content changes size (a row added, steps expanded).
 */
export function useAnchoredPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  open: boolean,
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const place = () => {
      const a = anchorRef.current
      const el = popoverRef.current
      if (!a || !el) return
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
      const r = a.getBoundingClientRect()
      const borders = el.offsetHeight - el.clientHeight
      const next = placeUnder(
        { top: r.top / zoom, bottom: r.bottom / zoom, left: r.left / zoom },
        { width: el.offsetWidth, height: el.scrollHeight + borders },
        { width: window.innerWidth / zoom, height: window.innerHeight / zoom },
      )
      // Same numbers, same object: a ResizeObserver callback that set a new one each time would re-render for nothing
      setPlacement((p) => (p && p.top === next.top && p.left === next.left && p.maxHeight === next.maxHeight ? p : next))
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    /*
     * The children, not just the popover: once the popover is at its cap its own box stops changing, while the content
     * inside it keeps growing — and that growth is what may have to move it upward.
     */
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    const el = popoverRef.current
    if (el && observer) for (const node of [el, ...Array.from(el.children)]) observer.observe(node)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [open, anchorRef, popoverRef])
  return placement
}
