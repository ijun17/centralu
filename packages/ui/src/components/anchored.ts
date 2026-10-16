import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * Where a popover that hangs under a button goes, so that all of it is inside the window.
 *
 * Why this exists: a popover drawn as an `absolute` child of its button is clipped by the first ancestor with an
 * overflow, and a grid panel is `overflow-hidden` (it has to be — its rounded corners and its border). The
 * background-task list hung off the session header that way and lost its right side, Stop included, in any panel
 * narrower than the list (0.1.0-beta.9, the owner's screenshot). The popover is therefore rendered into
 * `document.body` and placed `fixed`, which leaves no box to clip it — the same reason the tooltip and the sidebar's
 * row menu are fixed.
 *
 * All numbers are layout pixels: the caller divides the anchor's screen rect and the window by the zoom
 * (`--text-zoom`) first. A rect is in screen pixels, already multiplied by the zoom, while the `top`/`left` set on a
 * fixed popover are lengths inside the zoomed root, so the zoom is multiplied in a second time when it is drawn. Mixed as
 * they were, the sidebar's menu sat 24px below and 103px left of its button at zoom 1.1 (54px/249px at 1.25, measured:
 * the dogfooding report "the menu position looks wrong"), and the e2e tests missed it because they only measured at
 * zoom 1.0. The window size has no notion of zoom and `offsetHeight` is already raw layout pixels: only the rect and the
 * window are divided, so everything lands in one coordinate system.
 */

/** Between the button and the popover — flush, it is unclear where the button ends */
const GAP = 4
/** Off the window's edge — flush against it reads as cut off even when it is not */
const EDGE = 8

export type Placement = { top: number; left: number; maxHeight: number }

type Box = { top: number; bottom: number; left: number; right?: number }
type Options = {
  /** Which edge of the anchor the popover's own edge lines up with. Default `left`; `right` for a menu that flows out of a button at the window's right */
  align?: 'left' | 'right'
  /** The side tried first. Default `below`; the other side is used when this one does not fit and has less room */
  side?: 'below' | 'above'
  /** Between the anchor and the popover. Default 4 */
  gap?: number
}

/**
 * Next to the anchor, edges lined up (`align`), on the side asked for (`side`, below by default) unless that runs off
 * the window:
 * - sideways it shifts until the popover is EDGE inside the window, but never past the window's left edge;
 * - if it does not fit on its side and there is more room on the other, it opens there;
 * - either way its height is capped by the room on its side, and it scrolls inside.
 *
 * `height` is the popover's natural height (its content's), not the capped one, so a list that grew is placed for
 * what it now holds.
 */
export function placeUnder(
  anchor: Box,
  size: { width: number; height: number },
  win: { width: number; height: number },
  { align = 'left', side = 'below', gap = GAP }: Options = {},
): Placement {
  const roomBelow = Math.max(0, win.height - EDGE - (anchor.bottom + gap))
  const roomAbove = Math.max(0, anchor.top - gap - EDGE)
  const [roomHere, roomThere] = side === 'below' ? [roomBelow, roomAbove] : [roomAbove, roomBelow]
  const flip = size.height > roomHere && roomThere > roomHere
  const above = (side === 'above') !== flip
  const maxHeight = above ? roomAbove : roomBelow
  const top = above ? anchor.top - gap - Math.min(size.height, roomAbove) : anchor.bottom + gap
  const from = align === 'right' ? (anchor.right ?? anchor.left) - size.width : anchor.left
  const left = Math.max(EDGE, Math.min(from, win.width - EDGE - size.width))
  return { top, left, maxHeight }
}

/**
 * A menu opened at a point (a right-click): its corner at the point, no gap, otherwise `placeUnder`'s rules, so a menu
 * near the bottom or right edge comes up or to the left of the pointer instead of running off the window.
 */
export function placeAt(
  point: { x: number; y: number },
  size: { width: number; height: number },
  win: { width: number; height: number },
): Placement {
  return placeUnder({ top: point.y, bottom: point.y, left: point.x }, size, win, { gap: 0 })
}

/** What a popover hangs off: an element (or a ref to one), or a point in screen pixels, as a right-click gives */
export type Anchor = RefObject<Element | null> | Element | null | { x: number; y: number }

const isPoint = (a: Anchor): a is { x: number; y: number } => a !== null && 'x' in a && 'y' in a
const elementOf = (a: Anchor): Element | null => (a === null || isPoint(a) ? null : 'current' in a ? a.current : a)

/**
 * `placeUnder` (`placeAt` for a point) for a mounted popover, measured before paint (null until then: hide the popover
 * while it is null, so the frame where it sits at 0,0 never reaches the screen).
 *
 * It is placed again when anything scrolls (the anchor moved, the popover did not — capture, because scroll does not
 * bubble), when the window resizes, and when the popover's own content changes size (a row added, steps expanded).
 */
export function useAnchoredPlacement(
  anchor: Anchor,
  popoverRef: RefObject<HTMLElement | null>,
  open: boolean,
  { align = 'left', side = 'below' }: Pick<Options, 'align' | 'side'> = {},
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null)
  // The anchor is read at placing time; what restarts the effect is the ref or element, or the point's two numbers
  const pointX = isPoint(anchor) ? anchor.x : null
  const pointY = isPoint(anchor) ? anchor.y : null
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const anchorKey = isPoint(anchor) ? null : anchor
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const place = () => {
      const a = anchorRef.current
      const el = popoverRef.current
      if (!el || a === null) return
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
      const borders = el.offsetHeight - el.clientHeight
      const size = { width: el.offsetWidth, height: el.scrollHeight + borders }
      const win = { width: window.innerWidth / zoom, height: window.innerHeight / zoom }
      let next: Placement
      if (isPoint(a)) {
        next = placeAt({ x: a.x / zoom, y: a.y / zoom }, size, win)
      } else {
        const target = elementOf(a)
        if (!target) return
        const r = target.getBoundingClientRect()
        const box = { top: r.top / zoom, bottom: r.bottom / zoom, left: r.left / zoom, right: r.right / zoom }
        next = placeUnder(box, size, win, { align, side })
      }
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
  }, [open, anchorKey, pointX, pointY, popoverRef, align, side])
  return placement
}
