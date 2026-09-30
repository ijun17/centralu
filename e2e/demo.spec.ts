import { expect, test } from '@playwright/test'

/**
 * The screen for looking at by hand (`?demo`) — user request, 2026-09-10.
 *
 * This scene exists so that a person fixing the UI **has something to see the moment they open
 * it**. Being dev-only, it is an easy spot to rot quietly while nobody is watching (one changed
 * port on the mock and the seed breaks right there). So at minimum this much is guaranteed:
 * opening it shows content, and sending a message gets a reply.
 */
test('?demo has something to see the moment it opens', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto('/?demo')

  // A project and a session already exist — this is a screen mid-work, not an intro screen
  await expect(page.getByTestId('project-centralu')).toBeVisible()
  await expect(page.getByTestId('project-landing-site')).toBeVisible()
  await expect(page.getByTestId('session-name')).toBeVisible()
  // A past conversation exists too (including a tool card)
  await expect(page.getByTestId('chat-stream')).toContainText('무지개 링')
  await expect(page.getByTestId('tool-card').first()).toBeVisible()
  // The dashboard's donut and the evidence panel's git changes are also filled in
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  await expect(
    page.getByTestId('evidence-file-packages/ui/src/features/session/SessionView.tsx'),
  ).toBeVisible()

  expect(errors).toEqual([])
})

test('?demo replies when sent a message', async ({ page }) => {
  await page.goto('/?demo')
  await page.getByTestId('prompt-input').fill('답 오나 보자')
  await page.getByTestId('prompt-input').press('Enter')

  // Script: one tool call, a few reply chunks, then done. Once done, it settles into 'awaiting input'.
  await expect(page.getByTestId('chat-stream')).toContainText('답 오나 보자', { timeout: 10_000 })
  await expect(page.getByTestId('chat-stream')).toContainText('데모 목이라', { timeout: 10_000 })
})

test('?demo=grid comes up as a grid with four panels', async ({ page }) => {
  await page.goto('/?demo=grid')
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.locator('[data-testid^="grid-panel-"]')).toHaveCount(4)
  // One panel is mid-response — where the rainbow ring spins
  await expect(page.locator('.cc-orbit-ring-layer')).toHaveCount(1)
})

/** `?mock=1` stays as it was — it is the door e2e uses, and the demo scene must not leak into it */
test('?mock=1 is empty — the scene lives only under demo', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
})
