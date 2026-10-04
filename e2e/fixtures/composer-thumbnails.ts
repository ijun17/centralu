import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * The composer shows an image it is about to send as the image itself (#284).
 *
 * Files are pasted the way a screenshot arrives: a `paste` event on the composer whose clipboard carries the file. The
 * images are drawn on a canvas in the page, so each is a real PNG of a chosen size — fake bytes would not decode, and
 * would take the broken-image path the third scenario tests on purpose.
 */

/** Pastes a file into the composer. `png` draws a real PNG of that size; `bytes` sends the given text as the file */
async function paste(
  page: Page,
  name: string,
  file: { png: [number, number] } | { bytes: string; type: string },
): Promise<string | null> {
  return page.getByTestId('prompt-input').evaluate(async (el, { name, file }) => {
    let blob: Blob
    let b64: string | null = null
    if ('png' in file) {
      const canvas = document.createElement('canvas')
      ;[canvas.width, canvas.height] = file.png
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#888'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const url = canvas.toDataURL('image/png')
      b64 = url.slice(url.indexOf(',') + 1)
      blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' })
    } else {
      blob = new Blob([file.bytes], { type: file.type })
    }
    const data = new DataTransfer()
    data.items.add(new File([blob], name, { type: blob.type }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return b64
  }, { name, file })
}

const composerHeight = (page: Page) =>
  page.getByTestId('prompt-input').evaluate((el) => el.closest('form')!.getBoundingClientRect().height)

/** The scenarios, as a function so they run in Chromium and in WebKit (the desktop app is WKWebView) */
export function composerThumbnailTests(): void {
  test.describe('the composer shows a pasted image as a thumbnail before sending (#284)', () => {
    test('a pasted image shows as an <img> of its own bytes, named, zooms on click, and its remove button removes it', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')

      const b64 = await paste(page, 'Screenshot 2026-10-04 at 10.12.03.png', { png: [16, 9] })
      const list = page.getByTestId('attachment-list')
      const img = list.getByTestId('attachment-thumb').locator('img')
      await expect(img).toBeVisible()
      await expect(img).toHaveAttribute('src', `data:image/png;base64,${b64}`)
      await expect(img).toHaveAttribute('alt', 'Screenshot 2026-10-04 at 10.12.03.png')
      // It decoded: a broken image would have fallen back to the chip
      expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(16)
      await expect(list.getByTestId('attachment-chip')).toHaveCount(0)

      await img.click()
      await expect(page.getByTestId('image-lightbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('image-lightbox')).toHaveCount(0)

      await list.getByRole('button', { name: 'Remove attachment Screenshot 2026-10-04 at 10.12.03.png' }).click()
      await expect(page.getByTestId('attachment-list')).toHaveCount(0)
      await expect(page.getByTestId('send')).toBeDisabled()
    })

    test('a file that is not an image keeps the IMG/DOC chip, with its name and remove button', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')

      await paste(page, 'notes.txt', { bytes: 'hello', type: 'text/plain' })
      const chip = page.getByTestId('attachment-list').getByTestId('attachment-chip')
      await expect(chip).toContainText('DOC')
      await expect(chip).toContainText('notes.txt')
      await expect(page.getByTestId('attachment-list').locator('img')).toHaveCount(0)

      await chip.getByRole('button', { name: 'Remove attachment notes.txt' }).click()
      await expect(page.getByTestId('attachment-list')).toHaveCount(0)
    })

    test('an image the browser cannot decode falls back to the chip', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')

      await paste(page, 'broken.png', { bytes: 'not a png', type: 'image/png' })
      const chip = page.getByTestId('attachment-list').getByTestId('attachment-chip')
      await expect(chip).toContainText('IMG')
      await expect(chip).toContainText('broken.png')
      await expect(page.getByTestId('attachment-list').locator('img')).toHaveCount(0)
      await expect(chip.getByRole('button', { name: 'Remove attachment broken.png' })).toBeVisible()
    })

    test('the composer is as tall with two thumbnails, of different shapes, as with one — and with a chip beside them', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')
      const before = await composerHeight(page)

      await paste(page, 'wide.png', { png: [40, 10] })
      const thumbs = page.getByTestId('attachment-thumb').locator('img')
      await expect(thumbs).toHaveCount(1)
      await expect.poll(() => thumbs.first().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(40)
      const one = await composerHeight(page)
      // The strip did add a row
      expect(one).toBeGreaterThan(before)

      // A tall image, whose natural height would make its row taller than a wide one's
      await paste(page, 'tall.png', { png: [10, 80] })
      await expect(thumbs).toHaveCount(2)
      await expect.poll(() => thumbs.nth(1).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(10)
      expect(await composerHeight(page)).toBe(one)

      // Both on one row, the same height
      const boxes = await thumbs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))
      expect(boxes[0]!.height).toBe(boxes[1]!.height)
      expect(boxes[0]!.top).toBe(boxes[1]!.top)

      await paste(page, 'notes.txt', { bytes: 'hello', type: 'text/plain' })
      await expect(page.getByTestId('attachment-chip')).toBeVisible()
      expect(await composerHeight(page)).toBe(one)
    })
  })
}
