/**
 * Facts about the web engine the UI runs in, answered here so ui never asks (tooling/styles.test.ts
 * fails the build on an engine or OS check under packages/ui).
 */

/**
 * Whether the engine reports a frame's `dragend` in the top page's coordinates instead of the
 * frame's own (#308, `PlatformCapabilities.frameDragEndInPage`). Measured on 2026-10-05
 * (Playwright 1.62.1), a frame 50 px right and 30 px down whose card was dropped at (80, 440) in the
 * page: WebKit's `dragend` said (30, 410), the frame's own coordinates as the spec has it, and
 * Chromium's said (80, 440), the page's, in every frame tried, same-origin included, while its
 * `mousedown` and `dragstart` in the same frame were in the frame's. The desktop app is WebKit on
 * macOS and Linux, and WebView2, which is Chromium, on Windows.
 *
 * Told by the one API only Chromium has (`navigator.userAgentData`, its client hints), not by the
 * user agent string, which WebKit and Chromium both fill with each other's names.
 */
export function frameDragEndInPage(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return typeof nav === 'object' && nav !== null && 'userAgentData' in nav
}
