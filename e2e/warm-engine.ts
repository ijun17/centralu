import { chromium, webkit, type BrowserType, type FullConfig } from '@playwright/test'

/**
 * Opens one page in the engine the run uses, before any test starts (playwright.config.ts `globalSetup`).
 *
 * The first WebKit page a machine ever opens builds the GStreamer registry (~/.cache/gstreamer-1.0) and the Mesa
 * shader cache. On a fresh ubuntu-24.04 runner that took 3.5–4.7 s alone and about 150 ms after it, even in a new
 * browser process (measured 2026-10-12). In the e2e job it fell on the first test of each worker, inside that test's
 * 20 s: two workers built the caches at once while vite compiled the app, the page took 7–17 s to open, and on a
 * slow runner 14.8 s and over 20 s. Both workers' first tests then timed out together, whichever spec the shard
 * started with (composer-thumbnails.ts on #555, twice). Opened here, before the workers, no test pays for it.
 */
export default async function warmEngine(
  config: FullConfig,
  engines: Record<'chromium' | 'webkit', Pick<BrowserType, 'launch'>> = { chromium, webkit },
): Promise<void> {
  const name = config.projects[0]?.use.browserName === 'webkit' ? 'webkit' : 'chromium'
  const browser = await engines[name].launch()
  try {
    const context = await browser.newContext()
    await context.newPage()
    await context.close()
  } finally {
    await browser.close()
  }
}
