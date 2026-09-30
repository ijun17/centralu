/*
 * The track sizes the grid and the project screen (#203) share. Both lay panels out the same
 * way, and a working panel's ring is drawn by the same layer in both, so the fix that keeps the
 * ring whole (#208) has to hold in both — one copy is what makes that true.
 */

/** The gap between panels (px). Kept in one place since wholePixelTracks below subtracts and divides by this value */
export const GRID_GAP = 8

/**
 * Stands panels on **whole pixels** (#208).
 *
 * Dividing with 1fr leaves a panel's width and position as fractions that follow the window
 * width. WebKit (in practice, WKWebView) aligns a spinning border's mask to a different pixel
 * than the panel on a fractional layout, and loses one whole side of the ring (measured: at 1x
 * scale, three columns, a window width where the middle panel starts at x.328 — one window width
 * out of three — the right side disappeared). Switching the mask to four strips or a clip-path
 * broke at the same spot; it only stayed whole when the panel's position was an integer. So the
 * fix targets the position, not the mask.
 *
 * Every panel except the last has its size rounded down to the pixel, and the last panel takes
 * the leftover few pixels as 1fr. That makes every panel's starting point an integer while the
 * grid still fits the screen exactly. Why the window width is not measured and hardcoded as px
 * in JS: ResizeObserver reports **after** layout, so during a window resize, one frame at a time
 * gets drawn at the old width, leaving the grid either overflowing or with a gap. 100% is always
 * that frame's actual width.
 */
export function wholePixelTracks(n: number): string {
  if (n <= 1) return 'minmax(0, 1fr)'
  const share = `round(down, calc((100% - ${(n - 1) * GRID_GAP}px) / ${n}), 1px)`
  return `repeat(${n - 1}, ${share}) minmax(0, 1fr)`
}
