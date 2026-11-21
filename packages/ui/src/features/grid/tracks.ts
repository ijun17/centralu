// Track sizes shared by the grid and the project screen (#203), so the whole-ring rule (#208) holds in both.

/** The gap between panels (px); wholePixelTracks subtracts and divides by it */
export const GRID_GAP = 8

/**
 * Panels on whole pixels (#208): on a fractional layout WebKit (WKWebView) aligns a spinning border's mask to another
 * pixel than the panel and loses one side of the ring (measured at 1x, three columns, middle panel at x.328). A mask
 * of four strips or a clip-path broke at the same spot, so this fixes the position: every panel but the last is
 * rounded down to the pixel, the last takes the rest as 1fr. Not measured in JS: ResizeObserver reports after layout,
 * so a resize would draw a frame at the old width.
 */
export function wholePixelTracks(n: number): string {
  if (n <= 1) return 'minmax(0, 1fr)'
  const share = `round(down, calc((100% - ${(n - 1) * GRID_GAP}px) / ${n}), 1px)`
  return `repeat(${n - 1}, ${share}) minmax(0, 1fr)`
}
