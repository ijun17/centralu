import { test, expect } from '@playwright/test'
import { APP_VERSION } from '@cc/protocol'
import { setup } from './fixtures/control.js'

/**
 * The control loop's scenarios on updates: checking, installing, applying now or when idle, and relaunch refusals. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * Updates: only notify, and install only when the person clicks (issue #43).
 *
 * The whole shape of this feature is in one run: a quiet line appears when the registry
 * has something newer, clicking it is the consent, and the app stops at "restart" rather
 * than replacing itself out from under the person. Driven entirely through the mock —
 * `npm i -g` is never run by a test.
 */
test('A pending npm release is shown as a wait and disables duplicate update actions (#581)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.offerUpdate('9.9.9')
    const store = (window as any).__store
    store.setState({ update: { ...store.getState().update, phase: 'waiting_for_npm', error: 'Waiting for npm to serve 9.9.9' } })
  })
  await expect(page.getByTestId('update-line')).toHaveText('Waiting for npm to serve 9.9.9')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-state')).toHaveText('Waiting for npm to serve 9.9.9')
  await expect(page.getByTestId('update-check-now')).toBeDisabled()
  await expect(page.getByTestId('update-apply')).toBeDisabled()
})

test('A quiet line appears when a new version exists, and installing requires a click (#43)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })

  // With no news yet, there is no line in the dashboard — it appears only when there is something
  // to say
  await expect(page.getByTestId('update-line')).toBeHidden()

  // A new version has been published to the registry
  await page.evaluate(() => (window as any).__mock.offerUpdate('9.9.9'))
  const line = page.getByTestId('update-line')
  await expect(line).toContainText('9.9.9')

  // Clicking it is the consent — nothing happens before that
  await line.click()
  /*
   * Even once it finishes, it **does not restart on its own.** Swapping out the running app is
   * the person's call to make, and this line is where it says so.
   */
  await expect(line).toContainText('Restart')
})

/**
 * "Apply now" (#352): where the window can relaunch into the installed build without cutting
 * anything (the desktop app with the keeper — the mock stands in for it), the line stops at
 * "Apply now" instead of "Restart", and clicking it is what relaunches. Where it cannot, the line
 * says to restart, as before.
 */
test('Once installed, the update line offers "Apply now" where the window can relaunch into it (#352)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.relaunchCheck = { ready: true }
    ;(window as any).__mock.offerUpdate('9.9.9')
  })
  const line = page.getByTestId('update-line')
  await line.click()
  await expect(page.getByTestId('update-apply-now')).toBeVisible()
  await expect(line).toContainText('9.9.9 installed')
  // Installing alone relaunched nothing; the click does
  expect(await page.evaluate(() => (window as any).__mock.relaunches)).toBe(0)
  await page.getByTestId('update-apply-now').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.relaunches)).toBe(1)
})

test('A relaunch the keeper cannot hold is refused out loud (#352)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.relaunchCheck = { ready: true }
    m.relaunchFails = 'the background keeper is from an older build'
    m.offerUpdate('9.9.9')
  })
  await page.getByTestId('update-line').click()
  await page.getByTestId('update-apply-now').click()
  await expect(page.getByTestId('toast')).toContainText('Could not apply the update: the background keeper is from an older build')
})

/**
 * "Apply updates automatically when idle" (#352): off by default; on, a newer version is
 * installed without a click and applied only once the keeper reports nothing running.
 */
test('Applying automatically waits until nothing is running (#352)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.relaunchCheck = { ready: true }
    m.setHostBusy(true)
    m.registryVersion = '9.9.9'
  })
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-updates').click()
  const box = page.getByTestId('update-auto-apply')
  await expect(box).not.toBeChecked()
  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-state')).toContainText('9.9.9 is available')

  // Turning it on installs what is already known, without a click on "Update to"
  await box.check()
  await expect(page.getByTestId('update-state')).toContainText('Installed 9.9.9')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(false))
  await expect(page.getByTestId('update-waiting')).toBeVisible()
  // Something is running: it waits
  await page.waitForTimeout(1500)
  expect(await page.evaluate(() => (window as any).__mock.relaunches)).toBe(0)

  // The keeper reports idle: it applies, once
  await page.evaluate(() => (window as any).__mock.setHostBusy(false))
  await expect.poll(() => page.evaluate(() => (window as any).__mock.relaunches)).toBe(1)
  await page.evaluate(() => (window as any).__mock.setHostBusy(true))
  await page.evaluate(() => (window as any).__mock.setHostBusy(false))
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as any).__mock.relaunches)).toBe(1)
})

/**
 * Settings gained an 'Updates' tab (issue #43 / the fourth tab #7 opened up).
 *
 * Automatic checking is **on by default** — it is read-only and swallows failures, so leaving it
 * on costs nothing, while leaving it off would strand someone who never opens settings on an old
 * version forever. This also confirms that turning it off genuinely stops asking: otherwise this
 * checkbox is decoration.
 */
test('Settings > Updates: check now and automatic checking (#43)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-updates').click()

  /*
   * States what is currently running first — without one side of the comparison visible, the
   * rest cannot be read either.
   *
   * Writing a literal version string here would turn this line red **on every release.** It
   * actually happened: the commit that bumped to 0.1.0-beta.3 broke this line, and nobody saw it
   * because what CI runs before a release is `pnpm verify` (up through unit tests only). What is
   * being confirmed is not the version number but **that a number is carried onto the screen at
   * all**, so this checks only the shape.
   */
  await expect(page.getByTestId('update-current')).toContainText(/Running \d+\.\d+\.\d+/)
  await expect(page.getByTestId('update-auto')).toBeChecked()

  await page.evaluate(() => {
    ;(window as any).__mock.registryVersion = '9.9.9'
  })
  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-state')).toContainText('9.9.9')

  // With it off, it never asks the registry
  await page.getByTestId('update-auto').uncheck()
  const asked = await page.evaluate(async () => {
    const m = (window as any).__mock
    m.registryVersion = null // Asking now would come back as "unreachable"
    await (window as any).__store.getState().checkUpdate(false)
    return (window as any).__store.getState().update.latest
  })
  // An automatic call arriving with auto-check turned off went nowhere — the previously known
  // answer just stays
  expect(asked).toBe('9.9.9')
})

test('A locally replaced bundle offers Apply now without an npm install event (#610)', async ({ page }) => {
  // Derived from the build's version: a release bump must not turn this local build into a downgrade.
  const local = `${APP_VERSION}.local.1`
  await setup(page, { projects: ['/tmp/alpha'] })
  await expect(page.getByTestId('update-line')).toBeHidden()
  await page.evaluate((version) => {
    const w = window as any
    w.__mock.relaunchCheck = { ready: true, version }
    // Returning from the local-build terminal discovers the external install.
    window.dispatchEvent(new Event('focus'))
  }, local)
  await expect(page.getByTestId('update-apply-now')).toBeVisible()
  await expect(page.getByTestId('update-line')).toContainText(`${local} installed`)
  expect(await page.evaluate(() => (window as any).__mock.relaunches)).toBe(0)
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-state')).toContainText(`Installed ${local}`)
  await expect(page.getByTestId('update-apply')).toBeHidden()
  await page.getByTestId('update-apply-now-settings').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.relaunches)).toBe(1)
})
