/**
 * The engine `pnpm ux` runs in: the one the desktop app runs on, WebKit on macOS and Linux and
 * Chromium on Windows (WebView2). `E2E_BROWSER` names one explicitly.
 *
 * Playwright's WebKit on Windows is its own port, not an engine the app ships on, and it keeps only
 * the text types of a drag (`text/plain`, `text/uri-list`, `text/html`). The app's drags carry
 * `application/x-cc-*` types (sidebar/reorder.ts), so the grid and the sidebar never see what was
 * dragged and refuse the drop: the four tasks that drag failed there while 45 others passed (#2022).
 */
export function uxEngine(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): 'chromium' | 'webkit' {
  if (env.E2E_BROWSER === 'chromium' || env.E2E_BROWSER === 'webkit') return env.E2E_BROWSER
  return platform === 'win32' ? 'chromium' : 'webkit'
}
