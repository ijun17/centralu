import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { isPlainEscape } from '../../../app/keys.js'

/**
 * The shared shell for sidebar row menus — placement (zoom compensation, flipping, edge handling)
 * and the closing rules live here. Pulled out of the project menu: once session rows needed the
 * same menu, writing this calculation twice would foreseeably end up with only one copy fixed later
 * (the zoom compensation already went through that once).
 */
export function RowMenu({
  anchorEl,
  testId,
  onClose,
  children,
}: {
  anchorEl: HTMLElement | null
  testId: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  /*
   * **Appears right below the button that opened it.**
   *
   * It used to be `absolute right-2 top-6`. This row has no positioned ancestor of its own, so
   * that coordinate resolved against the sidebar as a whole, and no matter which project was
   * pressed, the menu always landed at one fixed spot near the top right of the sidebar — pressing
   * the tenth project produced its answer at the very top (a dogfooding finding). A menu has to sit
   * **next to whatever called it** for it to read as a menu about that thing.
   *
   * Why `fixed`: the sidebar has `overflow-y-auto`, so placing it in normal flow would clip the
   * menu for projects lower in the list. Positioning it relative to the viewport leaves no box to
   * clip against.
   *
   * If there is no room below, it flips upward. That means the height has to be **measured first**,
   * and the height is only known once it is rendered — so it is measured and placed with
   * useLayoutEffect (which runs before paint), and any frame where the position is not yet decided
   * never reaches the screen (hidden via visibility).
   */
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current
      if (!anchorEl || !el) return
      /*
       * **Everything is computed after converting to layout pixels** — because of zoom
       * (--text-zoom).
       *
       * getBoundingClientRect returns screen pixels already multiplied by the zoom, but the
       * top/right set here are lengths inside the zoomed root, so the zoom gets multiplied in
       * **a second time** when it is rendered. Mixing them as-is put the menu 24px below and 103px
       * to the left of the button at zoom 1.1 (54px/249px at 1.25 — measured; this is what the
       * dogfooding report "the menu position looks wrong" turned out to be). The e2e tests missed
       * it because they only measured at zoom 1.0.
       *
       * The window size (innerWidth/Height) has no notion of zoom, and offsetHeight is already in
       * raw layout pixels — only the screen pixels (rect) and the window pixels are divided by
       * zoom, so everything lands in one coordinate system.
       */
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
      const r = anchorEl.getBoundingClientRect()
      const h = el.offsetHeight
      const w = el.offsetWidth
      const winH = window.innerHeight / zoom
      const winW = window.innerWidth / zoom
      const GAP = 4 // Between the button and the menu — if flush, it is unclear where the button ends
      const EDGE = 8 // Keeps it from sitting flush against the window edge
      const below = r.bottom / zoom + GAP
      setPos({
        top: below + h <= winH - EDGE ? below : Math.max(EDGE, r.top / zoom - GAP - h),
        /*
         * The menu's right edge lines up with the button's — it reads as flowing out of the
         * button. But the left edge is also protected (dogfooding: with a narrow sidebar, the menu
         * ran off the left side of the window and became invisible). `right` means "how far from
         * the window's right edge," so a larger value pushes the menu further left, and if the
         * button sits close to the window's left edge, an entire menu-width can end up off screen —
         * this clamps it so the menu's left edge stays within EDGE.
         */
        right: Math.max(EDGE, Math.min(winW - r.right / zoom, winW - EDGE - w)),
      })
    }
    place()
    /*
     * When the sidebar scrolls, the button moves but the fixed menu does not — this re-attaches
     * it. Listened to in the capture phase because scroll does not bubble, so a plain listener on
     * window would not catch scrolling inside the sidebar.
     */
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorEl])
  /*
   * Closes when the person clicks outside it. If another project is pressed while a menu is open,
   * it can look as if two menus are open at once, but in fact each one holds its own state, so
   * neither closes the other.
   */
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => isPlainEscape(e) && onClose()
    // capture: the close still fires even when a row below calls stopPropagation
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      data-testid={testId}
      className="fixed z-30 w-48 rounded-md border border-line bg-surface-raised py-1 shadow-(--shadow-popover)"
      style={{ top: pos?.top ?? 0, right: pos?.right ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  )
}
