import type { Page } from '@playwright/test'

/**
 * Lets a test read the real clipboard after a copy (#424). Chromium needs `clipboard-read` and
 * `clipboard-write`; Playwright's WebKit knows only `clipboard-read` (a copy from a key press
 * needs no permission there) and refuses the whole call when `clipboard-write` is in it.
 */
export async function grantClipboard(page: Page): Promise<void> {
  const engine = page.context().browser()?.browserType().name()
  await page.context().grantPermissions(engine === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'])
}
