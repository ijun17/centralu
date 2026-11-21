/** Facts about the web engine, answered here so ui never asks (tooling/styles.test.ts forbids such checks there) */

/**
 * Measured 2026-10-05 (Playwright 1.62.1), a frame at (50, 30) whose card was dropped at page (80, 440): WebKit's
 * `dragend` said (30, 410), the frame's own, as the spec has it; Chromium's said (80, 440) in every frame, same-origin
 * included, though its `mousedown` and `dragstart` there were the frame's. The desktop is WebKit on macOS and Linux,
 * WebView2 (Chromium) on Windows. Told by `navigator.userAgentData`, which only Chromium has: each engine's user agent
 * string names the other.
 */
export function frameDragEndInPage(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return typeof nav === 'object' && nav !== null && 'userAgentData' in nav
}
