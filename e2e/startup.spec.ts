import { expect, test } from '@playwright/test'

test('real host mode without token renders a startup error instead of a module throw', async ({ page }) => {
  const pageErrors: string[] = []
  const hostSockets: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('websocket', (ws) => {
    if (ws.url().includes('127.0.0.1:5175')) hostSockets.push(ws.url())
  })

  await page.goto('/')

  await expect(page.getByTestId('startup-error')).toBeVisible()
  await expect(page.getByTestId('startup-error')).toContainText('Host token is required')
  expect(pageErrors).toEqual([])
  expect(hostSockets).toEqual([])
})

test('?demo remains browser-only mock mode without a host token', async ({ page }) => {
  await page.goto('/?demo')

  await expect(page.getByTestId('startup-error')).toHaveCount(0)
  await expect(page.getByTestId('app-title')).toBeVisible()
})
