import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * Where a popover hung off a button goes, all of it inside the window. It is rendered into body and `fixed`, as the
 * tooltip and the sidebar's row menu are: as an `absolute` child it is clipped by the first ancestor with an overflow,
 * and a grid panel is `overflow-hidden` (its rounded corners), so the header's list lost its right side, Stop included.
 *
 * All numbers are layout pixels: a rect is in screen pixels (zoom already applied), while a fixed `top`/`left` gets the
 * zoom (`--text-zoom`) applied again, so the caller divides the rect and the window by it (`offsetHeight` is already
 * layout pixels). Mixed, the sidebar's menu sat 24px below and 103px left of its button at zoom 1.1 (54px/249px at
 * 1.25, measured), which a test at zoom 1.0 cannot see.
 */

/** Between the button and the popover: flush, it is unclear where the button ends */
const GAP = 4
/** Off the window's edge: flush against it reads as cut off */
const EDGE = 8

export type Placement = { top: number; left: number; maxHeight: number }

type Box = { top: number; bottom: number; left: number; right?: number }
type Options = {
  /** The anchor edge the popover lines up with; `right` for a menu off a button at the window's right */
  align?: 'left' | 'right'
  /** The side tried first; the other is used when this one does not fit and has less room */
  side?: 'below' | 'above'
  gap?: number
}

/**
 * Next to the anchor on `side` unless that runs off the window: shifted sideways to EDGE inside (never past the left
 * edge), flipped when the other side has more room, height capped by the room on its side (it scrolls inside).
 * `height` is the natural height, not the capped one, so a list that grew is placed for what it now holds.
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

/** A menu opened at a point (a right-click): its corner at the point, no gap, otherwise `placeUnder`'s rules */
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
 * `placeUnder` (`placeAt` for a point) for a mounted popover, measured before paint; null until then: hide the popover
 * while it is null, so it is never drawn at 0,0. Placed again on any scroll (capture: scroll does not bubble), on
 * resize, and when its content changes size.
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
    // The children too: at its cap the popover's box stops changing while its content grows, which may move it upward
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
