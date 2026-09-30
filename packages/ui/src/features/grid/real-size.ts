import { useEffect, useState, type RefObject } from 'react'

/**
 * The room panels are laid out in, in **real pixels** — what the grid and the project screen (#203)
 * count their columns in (core's `columnsFor`). A panel's minimum width is fixed in real pixels, like
 * the sidebar's and the evidence panel's: the text zoom (App.tsx, on the root) is there to enlarge the
 * letters, not to narrow the panel. A resize observer's box is in zoomed CSS pixels, so it is multiplied
 * by the zoom it was laid out under (dogfooding: a grid that was one row at zoom level 3 became two rows
 * at level 4 while it was not).
 *
 * The zoom is the one the measured layout had, read beside the box, and the product is kept — not the
 * box kept and multiplied by the store's zoom at render. The store's zoom changes the moment the scale is
 * set, and the view renders with it before App applies it and the observer reports the new box. The two
 * together are a width no zoom ever laid out. Measured at 1280×720, going from 1 to 1.25: the project
 * screen's room is 684 real pixels, then 535, one column for two panels either way, and 684 × 1.25 = 855
 * stood them side by side in between; the grid's is 1024, then 960, two columns for three panels, and
 * 1024 × 1.25 = 1280 stood them in three. An app's view laid over its panel (pinned-app/slots.ts) went
 * there and back, and the project screen's e2e test, measuring the panel in that frame, failed 3 of 30
 * runs in WebKit on a loaded machine. Kept as a product, the old real size holds until the observer
 * reports the new one. It always does: the window's CSS height is divided by the zoom, so the box always
 * changes with it.
 *
 * Kept as two numbers rather than one object, so an observer firing with an unchanged dimension does not
 * re-render every panel.
 */
export function useRealSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [width, setWidth] = useState(1200)
  const [height, setHeight] = useState(800)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (w: number, h: number) => {
      // Set together with the root's zoom in one place (App.tsx), so the two always agree
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
      setWidth(w * zoom)
      setHeight(h * zoom)
    }
    const ro = new ResizeObserver(([e]) => {
      if (e) measure(e.contentRect.width, e.contentRect.height)
    })
    ro.observe(el)
    // The first render should not wait a frame for the observer; the content box, as the observer measures it
    const s = getComputedStyle(el)
    measure(
      el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
      el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom),
    )
    return () => ro.disconnect()
  }, [ref])
  return { width, height }
}
