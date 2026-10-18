import { test, expect, type Locator, type Page } from '@playwright/test'

/*
 * The update line is one small "Update" capsule (owner, 2026-10-18): the version and what a press does are in its
 * tooltip, and its words change only while it installs, when it waits for a restart and when it failed.
 */
const tipOf = async (page: Page, el: Locator) => {
  await el.hover()
  return page.getByRole('tooltip')
}

async function start(page: Page) {
  await page.goto('/?demo')
  await expect(page.getByTestId('open-settings')).toBeVisible()
  await page.evaluate(() => { (window as any).__mock.updateChecks = [] })
}

async function checks(page: Page) {
  return page.evaluate(() => (window as any).__mock.updateChecks)
}

async function focus(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

test('opening Updates refreshes the registry each time with automatic checks on (#635)', async ({ page }) => {
  await start(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    m.registryVersion = '9.9.1'
  })
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-state')).toHaveText('9.9.1 is available')
  expect(await checks(page)).toEqual([true])
  await page.getByTestId('settings-tab-appearance').click()
  await page.evaluate(() => { (window as any).__mock.registryVersion = '9.9.2' })
  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-state')).toHaveText('9.9.2 is available')
  expect(await checks(page)).toEqual([true, true])
})

test('opening Updates with automatic checks off only checks after Check now (#636 review)', async ({ page }) => {
  await start(page)
  await page.evaluate(async () => {
    await (window as any).__store.getState().setUpdateAuto(false)
    ;(window as any).__mock.registryVersion = '9.9.2'
  })
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-check-now')).toBeVisible()
  expect(await checks(page)).toEqual([])
  await focus(page)
  expect(await checks(page)).toEqual([])
  await page.getByTestId('update-check-now').click()
  await expect(page.getByTestId('update-state')).toHaveText('9.9.2 is available')
  expect(await checks(page)).toEqual([true])
})

test('opening Updates and returning to the window preserve a failed install (#636 review)', async ({ page }) => {
  await start(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    m.offerUpdate('9.9.1')
    m.updateFails = 'EACCES: install denied'
    await (window as any).__store.getState().applyUpdate()
  })
  await expect(page.getByTestId('update-line')).toHaveText('Update failed')
  await page.evaluate(() => { (window as any).__mock.registryVersion = '9.9.2' })
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-state')).toHaveText('Update failed: EACCES: install denied')
  await page.clock.setFixedTime(Date.now() + 3600_001)
  await focus(page)
  await expect(page.getByTestId('update-state')).toHaveText('Update failed: EACCES: install denied')
  await page.evaluate(() => { (window as any).__mock.updateFails = null })
  await page.getByTestId('update-apply').click()
  await expect(page.getByTestId('update-state')).toContainText('Installed 9.9.2')
})

test('focus checks sweep the one-hour boundary and throttle failures and paired visibility events (#635)', async ({ page }) => {
  await start(page)
  const base = Date.now()
  await page.clock.setFixedTime(base)
  await page.evaluate((at) => {
    const store = (window as any).__store
    store.setState({ update: { ...store.getState().update, auto: true, phase: 'idle', checkedAt: at } })
    ;(window as any).__mock.registryVersion = null
  }, base)
  for (const elapsed of [0, 1, 1800_000, 3599_999, 3600_000]) {
    await page.clock.setFixedTime(base + elapsed)
    await focus(page)
    expect(await checks(page)).toEqual([])
  }
  await page.clock.setFixedTime(base + 3600_001)
  await focus(page)
  await expect.poll(() => checks(page)).toEqual([true])
  for (const elapsed of [3600_002, 5400_000, 7200_001]) {
    await page.clock.setFixedTime(base + elapsed)
    await focus(page)
    expect(await checks(page)).toEqual([true])
  }
  await page.clock.setFixedTime(base + 7200_002)
  await page.evaluate(() => { (window as any).__mock.registryVersion = '9.9.2' })
  await focus(page)
  await expect(page.getByTestId('update-line')).toHaveText('Update')
  await expect(await tipOf(page, page.getByTestId('update-line'))).toContainText('9.9.2 is out')
  expect(await checks(page)).toEqual([true, true])
})

test('focus respects consent and leaves checks, installs, npm waits and pending applies alone (#635)', async ({ page }) => {
  await start(page)
  for (const phase of ['checking', 'updating', 'waiting_for_npm', 'restart_required']) {
    await page.evaluate((value) => {
      const store = (window as any).__store
      store.setState({ update: { ...store.getState().update, auto: true, phase: value, checkedAt: 1 } })
    }, phase)
    await focus(page)
    expect(await checks(page)).toEqual([])
  }
  await page.evaluate(() => {
    const store = (window as any).__store
    store.setState({ update: { ...store.getState().update, auto: false, phase: 'idle', checkedAt: 1 } })
  })
  await focus(page)
  expect(await checks(page)).toEqual([])
  await page.evaluate(() => {
    const store = (window as any).__store
    store.setState({ update: { ...store.getState().update, auto: true } })
  })
  await focus(page)
  await expect.poll(() => checks(page)).toEqual([true])
})

test('the dashboard and Settings show the fresh install target and fallback notice (#635)', async ({ page }) => {
  await start(page)
  const notice = 'Could not refresh latest; using previously checked 9.9.2.'
  await page.evaluate((error) => {
    const store = (window as any).__store
    store.setState({ update: { ...store.getState().update, latest: '9.9.2', newer: true, phase: 'updating', error } })
  }, notice)
  await expect(page.getByTestId('update-line')).toContainText('Updating…')
  await expect(page.getByTestId('update-line')).toContainText(notice)
  await expect(await tipOf(page, page.getByTestId('update-line'))).toContainText('Installing 9.9.2')
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-updates').click()
  await expect(page.getByTestId('update-state')).toContainText(notice)
  await expect(page.getByTestId('update-apply')).toBeDisabled()
  expect(await checks(page)).toEqual([])
})

test('one install and apply reaches the newest release after the banner became stale (#635)', async ({ page }) => {
  await start(page)
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.relaunchCheck = { ready: true }
    m.offerUpdate('9.9.1')
    m.registryVersion = '9.9.2'
  })
  await page.clock.setFixedTime(Date.now() + 60_001)
  await expect(page.getByTestId('update-line')).toHaveText('Update')
  await expect(await tipOf(page, page.getByTestId('update-line'))).toContainText('9.9.1 is out')
  await page.getByTestId('update-line').click()
  await expect(page.getByTestId('update-apply-now')).toBeVisible()
  await expect(await tipOf(page, page.getByTestId('update-line'))).toContainText('9.9.2 is installed')
  await page.getByTestId('update-apply-now').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.relaunches)).toBe(1)
})

/**
 * An agent's "Apply now" (#665): the host asks the window over the event stream, and the window runs its own button's
 * path. The mock plays the host's half (`agentApply`); everything after the event is the real window.
 */
test('an agent applies the installed update: the window relaunches once, through its Apply now (#665)', async ({ page }) => {
  await start(page)
  await page.evaluate(() => { (window as any).__mock.relaunchCheck = { ready: true, version: '9999.0.0' } })
  // The update line offers Apply now: what the agent may ask for is what the person could click
  await focus(page)
  await expect(page.getByTestId('update-apply-now')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.agentApply())).toEqual({ ok: true })
  expect(await page.evaluate(() => (window as any).__mock.relaunches)).toBe(1)
})

test('an agent asking with nothing installed is told so, and nothing relaunches (#665)', async ({ page }) => {
  await start(page)
  const out = await page.evaluate(() => (window as any).__mock.agentApply())
  expect(out.ok).toBe(false)
  expect(out.error).toContain('No update is installed')
  expect(await page.evaluate(() => (window as any).__mock.relaunches)).toBe(0)
})

// #665 review: the shell's "ready" only meant another build, and an older bundle on disk was offered as the update
test('an older build on disk is not offered as the installed update, to the person or an agent (#665)', async ({ page }) => {
  await start(page)
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.relaunchCheck = { ready: true, version: '0.0.5' }
    m.offerUpdate('9.9.1')
  })
  await page.getByTestId('update-line').click()
  await focus(page)
  // The line says to restart, as where the window cannot relaunch, and offers no Apply now
  await expect(page.getByTestId('update-line')).toHaveText('Restart to update')
  await expect(await tipOf(page, page.getByTestId('update-line'))).toContainText('Restart Centralu to finish updating to 9.9.1')
  await expect(page.getByTestId('update-apply-now')).toHaveCount(0)
  const out = await page.evaluate(() => (window as any).__mock.agentApply())
  expect(out.ok).toBe(false)
  expect(out.error).toContain('0.0.5')
  expect(await page.evaluate(() => (window as any).__mock.relaunches)).toBe(0)
})
