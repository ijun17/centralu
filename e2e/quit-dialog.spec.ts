import { expect, test, type Page } from '@playwright/test'

/**
 * The quit question's buttons follow background mode (#280, #387).
 *
 * Off, quitting already stops the keeper, the host and everything they hold, so the only way out
 * is **Quit completely** and it says what that stops. On, **Quit** closes the window and leaves
 * everything running, and **Quit completely** stops it all anyway. "Quit and stop agents" is gone:
 * it undersold what stops.
 *
 * Drawn through apps/web/shell-banner.html, which mounts the desktop's own QuitDialog on the mock;
 * what a button would run in the app is recorded in `window.__shellCalls`.
 */

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls)

async function open(page: Page, background: 'on' | 'off') {
  await page.goto(`/shell-banner.html?dialog=quit&background=${background}`)
  await expect(page.getByTestId('confirm-quit')).toBeVisible()
}

test('background mode off: one way out, "Quit completely", and it says what stops', async ({ page }) => {
  await open(page, 'off')
  const dialog = page.getByTestId('confirm-quit')
  const primary = page.getByTestId('confirm-quit-yes')
  await expect(primary).toHaveText(/^Quit completely/)
  await expect(page.getByTestId('confirm-quit-stop')).toHaveCount(0)
  // No plain "Quit": off, there is nothing it could leave running
  await expect(dialog.getByRole('button', { name: /^Quit(\s*⏎)?$/ })).toHaveCount(0)
  await expect(page.getByTestId('confirm-quit-stops')).toContainText('Also stops agents, terminals and running commands.')
  await expect(dialog).not.toContainText('Quit and stop agents')

  // The plain quit, as before: with background mode off the keeper stops everything when the window goes
  await primary.click()
  expect(await calls(page)).toEqual(['quit_app'])
})

test('background mode on: "Quit" keeps everything running, "Quit completely" stops it all', async ({ page }) => {
  await open(page, 'on')
  const dialog = page.getByTestId('confirm-quit')
  await expect(page.getByTestId('confirm-quit-yes')).toHaveText(/^Quit\s*⏎$/)
  await expect(page.getByTestId('confirm-quit-background')).toContainText('agents keep running in the background')
  const completely = page.getByTestId('confirm-quit-stop')
  await expect(completely).toHaveText('Quit completely')
  await expect(completely).toHaveAttribute('title', 'Also stops agents, terminals and running commands.')
  await expect(dialog).not.toContainText('Quit and stop agents')

  await completely.click()
  expect(await calls(page)).toEqual(['quit_and_stop_agents'])
})

test('background mode on: the primary "Quit" is the plain quit', async ({ page }) => {
  await open(page, 'on')
  await page.getByTestId('confirm-quit-yes').click()
  expect(await calls(page)).toEqual(['quit_app'])
})

// #841 item 7, #990 review: an empty list because the host could not tell must not read as nothing left running
test('says why it could not check for leftover processes', async ({ page }) => {
  await page.goto('/shell-banner.html?dialog=quit&background=off&strays=unknown')
  await expect(page.getByTestId('quit-strays-unknown')).toContainText('Could not check for processes left running in your project folders: The keeper could not say')
  await expect(page.getByTestId('quit-strays')).toHaveCount(0)
})

test('says nothing of it when the list was read', async ({ page }) => {
  await open(page, 'off')
  await expect(page.getByTestId('quit-strays-unknown')).toHaveCount(0)
})

// #1512: with background mode off and a turn running, the person can keep the turns going instead of ending them
test('background mode off and a turn running: "Quit and keep running" turns the mode on, then quits', async ({ page }) => {
  await page.goto('/shell-banner.html?dialog=quit&background=off&running=2')
  await expect(page.getByTestId('confirm-quit-running')).toContainText('2 sessions are busy now')
  await expect(page.getByTestId('confirm-quit-running')).toContainText('Keep agents running after Centralu quits')
  // The plain choice is unchanged beside it
  await expect(page.getByTestId('confirm-quit-yes')).toHaveText(/^Quit completely/)
  await page.getByTestId('confirm-quit-keep').click()
  expect(await calls(page)).toEqual(['set_background_mode', 'quit_app'])
})

test('nothing running, or background mode on: no "Quit and keep running"', async ({ page }) => {
  await page.goto('/shell-banner.html?dialog=quit&background=off&running=0')
  await expect(page.getByTestId('confirm-quit')).toBeVisible()
  await expect(page.getByTestId('confirm-quit-keep')).toHaveCount(0)
  await page.goto('/shell-banner.html?dialog=quit&background=on&running=2')
  await expect(page.getByTestId('confirm-quit')).toBeVisible()
  await expect(page.getByTestId('confirm-quit-keep')).toHaveCount(0)
})
