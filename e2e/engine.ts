/**
 * The engine `pnpm e2e` runs in, or undefined for the mixed run: Chromium, plus the `-webkit.spec.ts`
 * twins in WebKit. `E2E_BROWSER` names one engine and wins. On Windows the app runs in WebView2
 * (Chromium) and Playwright's WebKit there is its own port, not an engine the app ships on: it keeps
 * only the text types of a drag, so the app's `application/x-cc-*` types never reach a drop and
 * every scenario that drags fails in it (#2022), so an unset run is Chromium alone there.
 */
export function e2eEngine(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): 'chromium' | 'webkit' | undefined {
  if (env.E2E_BROWSER === 'chromium' || env.E2E_BROWSER === 'webkit') return env.E2E_BROWSER
  return platform === 'win32' ? 'chromium' : undefined
}
