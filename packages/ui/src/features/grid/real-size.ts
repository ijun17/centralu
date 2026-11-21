import { useEffect, useState, type RefObject } from 'react'

/**
 * The room panels are laid out in, in real pixels (core's `columnsFor`, grid and project screen #203): the text zoom
 * enlarges letters, not narrows panels, so the observer's zoomed box is multiplied by the zoom it was laid out under.
 * That zoom is read beside the box, not taken from the store: the store's zoom changes before App applies it and the
 * observer reports, and the mix is a width no zoom laid out (measured at 1280×720, zoom 1 to 1.25: the grid briefly
 * stood three panels in a row, an app view over its panel moved there and back, and the project screen's e2e failed 3
 * of 30 runs in WebKit). The box always changes with the zoom (the window's CSS height is divided by it), so the old
 * size holds until the observer reports. Two numbers, not one object: an unchanged side re-renders nothing.
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
