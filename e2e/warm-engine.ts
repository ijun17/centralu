import { chromium, webkit, type BrowserType, type FullConfig } from '@playwright/test'
import { assertBrowserSandbox } from './browser-sandbox.js'

/**
 * Opens the app once in the engine the run uses, before any test starts (playwright.config.ts `globalSetup`, which
 * Playwright runs after the web servers are up).
 *
 * The first WebKit page a machine ever opens builds the GStreamer registry (~/.cache/gstreamer-1.0) and the Mesa
 * shader cache. On a fresh ubuntu-24.04 runner that took 3.5–5.4 s alone and about 150 ms after it, even in a new
 * browser process (measured 2026-10-12). In the e2e job it fell on the first test of each worker, inside that test's
 * 20 s: two workers built the caches at once while vite compiled the app for its first request, the page took 7–17 s
 * to open, and on a slow runner 14.8 s and over 20 s. Both workers' first tests then timed out together, whichever
 * spec the shard started with (composer-thumbnails.ts on #555, twice). Opened here, before the workers, no test pays
 * for the caches, and the app's modules are already compiled when the first test asks for them.
 */
export default async function warmEngine(
  config: FullConfig,
  engines: Record<'chromium' | 'webkit', Pick<BrowserType, 'launch'>> = { chromium, webkit },
  runtime: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv } = { platform: process.platform, env: process.env },
): Promise<void> {
  const use = config.projects[0]?.use ?? {}
  const name = use.browserName === 'webkit' ? 'webkit' : 'chromium'
  assertBrowserSandbox(config.metadata?.e2eBrowser ?? name, runtime.platform, runtime.env)
  // A project may select WebKit even when the suite's metadata says Chromium.
  assertBrowserSandbox(name, runtime.platform, runtime.env)
  const browser = await engines[name].launch()
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    if (use.baseURL) await page.goto(new URL('/?mock=1', use.baseURL).href)
    await context.close()
  } finally {
    await browser.close()
  }
}
