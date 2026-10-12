import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Entry points a person can see (#529). The task-cost baseline (docs/ux-metrics.md) found three
 * core tasks with no short path anyone could find without being told a key: starting a session took
 * three clicks behind a menu that only shows on hover, searching past conversations opened only by
 * ⌘K, and the palette did not list apps. These are the doors that answer them, and what each opens.
 */

async function demo(page: Page): Promise<void> {
  await page.goto('/?demo')
  await expect(page.getByTestId('session-name')).toHaveText('Finish the collapsed composer')
}

/** How visible an element is: its own opacity times every ancestor's */
const seen = (el: Locator) =>
  el.evaluate((node) => {
    let o = 1
    for (let at: Element | null = node; at; at = at.parentElement) o *= Number(getComputedStyle(at).opacity)
    return o
  })

test('the Search button opens the palette and says its key', async ({ page }) => {
  await demo(page)
  const search = page.getByTestId('search-button')
  await expect(search).toBeVisible()
  // The key is printed on the door itself, by this keyboard's name for it (the mock's is ⌘)
  await expect(search).toContainText('⌘K')
  await search.click()
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await expect(page.getByTestId('palette-input')).toHaveAttribute('placeholder', /apps/)
})

test("the project the person is in shows its +, others only on hover, and it opens that project's dialog", async ({ page }) => {
  await demo(page)
  const here = page.getByTestId('project-new-session-centralu')
  const there = page.getByTestId('project-new-session-landing-site')
  // Opacity, not presence: the other project's + is still reachable by hover and Tab
  await page.mouse.move(900, 500)
  await expect.poll(() => seen(here)).toBe(1)
  await expect.poll(() => seen(there)).toBe(0)

  await here.click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await expect(page.getByTestId('new-session-dialog')).toContainText('centralu')
})

test("the palette's New session names the project it starts in and opens its dialog", async ({ page }) => {
  await demo(page)
  await page.getByTestId('search-button').click()
  await page.getByTestId('palette-input').fill('new session')
  const item = page.getByTestId('palette-item-action').filter({ hasText: 'New session' })
  await expect(item).toContainText('in centralu')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('new-session-dialog')).toContainText('centralu')
  // The dialog keeps the keyboard: Enter starts the session (its Start button holds the focus)
  await expect(page.getByTestId('create-session-confirm')).toBeFocused()
})

test('the palette lists apps by name, only once something is typed, and opens one', async ({ page }) => {
  await demo(page)
  await page.evaluate(() => {
    const mock = (window as any).__mock
    mock.setExternalApps([
      ...mock.externalAppList,
      {
        appId: 'ledger',
        projectId: null,
        dir: '/Users/you/.centralu/apps/ledger',
        name: 'Ledger',
        version: '0.1.0',
        description: null,
        home: 'home',
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
      },
    ])
  })
  await expect(page.getByTestId('app-row-_user/ledger')).toBeVisible()

  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('palette-item-session').first()).toBeVisible()
  await expect(page.getByTestId('palette-item-app')).toHaveCount(0)
  await page.getByTestId('palette-input').fill('ledg')
  await expect(page.getByTestId('palette-item-app')).toHaveText(/Ledger.*Your apps/)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pinned-app-_user/ledger')).toBeVisible()
})
