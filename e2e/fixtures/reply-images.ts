import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * A local image an agent writes into its reply (`![shot](/Users/me/…/shot.png)`) is drawn from the bytes the session's
 * host reads (`messages.image`), never from the file path: the desktop window cannot load one, and WKWebView drew its
 * broken-image mark for it. When the host refuses, the reason stands in the picture's place.
 *
 * The mock answers `messages.image` from `__mock.messageImages`; which paths a host reads is the host's own tests'
 * business (agent-host message-image tests). Here the subject is what the window draws for each answer.
 */

const SHOT = '/Users/me/Desktop/game/.test/run-7/origin-character-quality-grid.png'

/** A real PNG of the given size, drawn in the page, as base64 */
const pngOf = (page: Page, w: number, h: number) =>
  page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#777'
      ctx.fillRect(0, 0, w, h)
      const url = canvas.toDataURL('image/png')
      return url.slice(url.indexOf(',') + 1)
    },
    [w, h] as const,
  )

const answer = (page: Page, path: string, value: unknown) =>
  page.evaluate(([p, v]) => (window as any).__mock.messageImages.set(p, v), [path, value] as const)

const agentSays = (page: Page, sessionId: string, text: string) =>
  page.evaluate(
    ([sid, t]) => (window as any).__mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: t }),
    [sessionId, text] as const,
  )

/** The scenarios, as a function so they run in Chromium and in WebKit (the desktop app is WKWebView) */
export function replyImageTests(): void {
  test.describe('a local image in an agent reply', () => {
    test('is drawn from the bytes the host sends, never from the path, and zooms on click', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const sid = await newSession(page, 'alpha')
      const b64 = await pngOf(page, 24, 12)
      await answer(page, SHOT, { ok: true, mime: 'image/png', data: b64, file: SHOT })

      await agentSays(page, sid, `The comparison:\n\n![Origin comparison](${SHOT})\n\nLeft is the old origin.`)

      const shown = page.getByTestId('reply-image')
      const img = shown.locator('img')
      await expect(img).toBeVisible()
      await expect(img).toHaveAttribute('src', `data:image/png;base64,${b64}`)
      await expect(img).toHaveAttribute('alt', 'Origin comparison')
      // It decoded: the engine drew it at its own size, which a broken image does not have
      expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(24)
      // No element anywhere in the reply points the engine at the file
      await expect(page.getByTestId('msg-assistant').locator(`img[src="${SHOT}"]`)).toHaveCount(0)
      expect(await page.evaluate(() => (window as any).__mock.messageImageCalls)).toEqual([{ sessionId: sid, path: SHOT }])

      await img.click()
      await expect(page.getByTestId('image-lightbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('image-lightbox')).toHaveCount(0)
    })

    test('a path written with spaces or non-Latin letters is asked for as the reply wrote it', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const sid = await newSession(page, 'alpha')
      const path = '/Users/me/스크린샷 모음/첫 화면.png'
      await answer(page, path, { ok: true, mime: 'image/png', data: await pngOf(page, 8, 8) })
      await agentSays(page, sid, `![first](<${path}>)`)
      await expect(page.getByTestId('reply-image').locator('img')).toBeVisible()
      expect(await page.evaluate(() => (window as any).__mock.messageImageCalls)).toEqual([{ sessionId: sid, path }])
    })

    test('a refused one shows its alt text, its path and the reason in a box, and reveals the file', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const sid = await newSession(page, 'alpha')
      await answer(page, SHOT, {
        ok: false,
        reason: 'too_large',
        message: 'The image is 14.2 MB; a reply shows images up to 10.0 MB',
        file: SHOT,
      })
      await agentSays(page, sid, `![Origin comparison](${SHOT})`)

      const box = page.getByTestId('reply-image-refused')
      await expect(box).toBeVisible()
      await expect(box).toHaveAttribute('data-reason', 'too_large')
      await expect(box).toContainText('Origin comparison')
      await expect(box.getByTestId('reply-image-path')).toHaveText(SHOT)
      await expect(box.getByTestId('reply-image-reason')).toHaveText('The image is 14.2 MB; a reply shows images up to 10.0 MB')
      await expect(page.getByTestId('msg-assistant').locator('img')).toHaveCount(0)

      await box.getByTestId('reply-image-reveal').click()
      expect(await page.evaluate(() => (window as any).__mock.revealedImages)).toEqual([SHOT])
    })

    test('a path no reply named, or one that is not there, has no reveal: there is no file to show', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const sid = await newSession(page, 'alpha')
      await answer(page, '/etc/a.png', { ok: false, reason: 'not_mentioned', message: 'No reply in this session names this path, so it is not read' })
      await agentSays(page, sid, '![a](/etc/a.png) and ![b](/tmp/gone.png)')

      const boxes = page.getByTestId('reply-image-refused')
      await expect(boxes).toHaveCount(2)
      await expect(boxes.nth(0)).toHaveAttribute('data-reason', 'not_mentioned')
      // The mock's default, as for a file the host's disk does not have
      await expect(boxes.nth(1)).toHaveAttribute('data-reason', 'not_found')
      await expect(boxes.nth(1).getByTestId('reply-image-reason')).toHaveText('There is no file at /tmp/gone.png')
      await expect(page.getByTestId('reply-image-reveal')).toHaveCount(0)
    })

    test('a refused image of a session on another machine offers no reveal on this computer', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const sid = await newSession(page, 'alpha')
      await page.evaluate((id) => {
        const store = (window as any).__store
        store.setState((s: any) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], machine: 'studio' } } }))
      }, sid)
      await answer(page, SHOT, { ok: false, reason: 'not_an_image', message: 'Not a PNG, JPEG, GIF or WebP image', file: SHOT })
      await agentSays(page, sid, `![x](${SHOT})`)
      await expect(page.getByTestId('reply-image-refused')).toHaveAttribute('data-reason', 'not_an_image')
      await expect(page.getByTestId('reply-image-reveal')).toHaveCount(0)
    })

    test('a web image stays an ordinary img, as before', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const sid = await newSession(page, 'alpha')
      await agentSays(page, sid, '![logo](https://example.invalid/logo.png)')
      await expect(page.getByTestId('msg-assistant').locator('img[src="https://example.invalid/logo.png"]')).toHaveCount(1)
      expect(await page.evaluate(() => (window as any).__mock.messageImageCalls)).toEqual([])
    })
  })
}
