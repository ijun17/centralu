import { useLayoutEffect, useState, type RefObject } from 'react'

/** The room kept between the search field and whatever stands beside it */
const GAP = 16

/**
 * How much of the top bar's width each side of the search field must leave free (#727).
 *
 * The field is centred in the **window**, not in the room left between the controls, so it takes
 * the same amount from both sides: the larger of what the left controls (traffic lights, back and
 * forward, the count) and the right ones (update line, usage, Settings) occupy. A field wider than
 * the window minus twice that would reach under the busier side, so the field's width is capped
 * there and it shrinks, still centred, as the window narrows. A flex or grid track cannot say
 * "equal on both sides, as wide as the wider side needs", which is why this is measured.
 *
 * Read in a layout effect, so the first paint already has the right width, and again whenever the
 * bar or either side changes size (a window resize, the update line appearing, usage loading).
 * The field is absolutely positioned and sizes none of what is measured, so this cannot loop.
 */
export function useSearchReserve(
  leftEnd: RefObject<HTMLElement | null>,
  rightStart: RefObject<HTMLElement | null>,
): number {
  const [reserve, setReserve] = useState(0)
  useLayoutEffect(() => {
    const left = leftEnd.current
    const right = rightStart.current
    const bar = right?.offsetParent
    if (!left || !right || !(bar instanceof HTMLElement)) return
    const measure = () => {
      const fromLeft = left.offsetLeft + left.offsetWidth
      const fromRight = bar.clientWidth - right.offsetLeft
      const next = Math.ceil(Math.max(fromLeft, fromRight)) + GAP
      setReserve((prev) => (prev === next ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    for (const el of [bar, left, right]) watch.observe(el)
    return () => watch.disconnect()
  }, [leftEnd, rightStart])
  return reserve
}
