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

/**
 * Keeps what the page puts on the clipboard at each copy, read off the copy event (#36).
 *
 * Not the system clipboard: Playwright's WebKit on Linux, which CI runs, refuses
 * `navigator.clipboard.readText()` even with `clipboard-read` granted. The page's copy handlers
 * (CodeViewer, GitPanel) write their payload into the event and cancel it, and a cancelled copy
 * puts exactly that payload on the clipboard. A copy the page leaves to the browser is recorded
 * as not handled, and `copied` fails on it rather than mistaking the browser's copy for the
 * page's. Call before the page loads.
 */
export async function watchCopies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener('copy', (e) => {
      ;(window as any).__copied = { text: e.clipboardData?.getData('text/plain') ?? '', handled: e.defaultPrevented }
    })
  })
}

/**
 * Copies the selection with the copy shortcut, ⌘C on macOS and Ctrl+C elsewhere.
 *
 * Playwright's WebKit on Linux, which CI runs, turns neither into a copy: no copy event fires at
 * all (every #36 copy scenario waited out its timeout there, while Ctrl+A reached the page). So
 * there the event the shortcut would have caused is dispatched instead, on the focused element,
 * with a DataTransfer of its own as the browser's carries. What the page does with it is the same
 * code either way: its handlers listen on the document and read the selection, not the key.
 */
export async function pressCopy(page: Page): Promise<void> {
  const engine = page.context().browser()?.browserType().name()
  if (engine !== 'webkit' || process.platform !== 'linux') {
    await page.keyboard.press('ControlOrMeta+c')
    return
  }
  await page.evaluate(() => {
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, composed: true, clipboardData: new DataTransfer() }))
  })
}

/** What the page put on the clipboard at the last copy not read yet (see `watchCopies`) */
export async function copied(page: Page): Promise<string> {
  const handle = await page.waitForFunction(() => {
    const c = (window as any).__copied
    ;(window as any).__copied = undefined
    return c
  })
  const c = (await handle.jsonValue()) as { text: string; handled: boolean }
  if (!c.handled) throw new Error('the page left this copy to the browser: nothing of its own went on the clipboard')
  return c.text
}
