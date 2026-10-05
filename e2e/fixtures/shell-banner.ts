import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * The shell's banner (the desktop keeper's "other build" bar) covers nothing (#326).
 *
 * It used to be laid over the window (`fixed inset-x-0 top-0 z-30`): its text started under the
 * macOS traffic lights and its "Switch to this build" button sat on the top bar's own controls.
 * Now App draws it in the flow, directly below the top bar, and the lanes give up its height.
 *
 * Driven through apps/web/shell-banner.html, which mounts the real App on the mock with the
 * desktop's own build bar in the slot (apps/desktop/src/build-bar.tsx, fed a made-up keeper report
 * and decided by the same `buildBar`) and reports the macOS 86px window-controls inset. The traffic lights
 * are not in a browser, so their box comes from tauri.conf.json — the same numbers the window is
 * built with.
 *
 * A function, like the other fixtures here, because it runs in Chromium and in WebKit
 * (shell-banner-webkit.spec.ts): the desktop app is WKWebView.
 */

type Box = { x: number; y: number; width: number; height: number }

const conf = JSON.parse(
  readFileSync(new URL('../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as {
  app: { windows: { trafficLightPosition: { x: number; y: number } }[] }
}
const light = conf.app.windows[0]!.trafficLightPosition
/** Three 12px buttons with macOS's 8px gaps between them */
const LIGHTS: Box = { x: light.x, y: light.y, width: 3 * 12 + 2 * 8, height: 12 }

/** ShellBanner's h-8, border included */
const BANNER_HEIGHT = 32

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

async function box(page: Page, testId: string): Promise<Box> {
  const b = await page.getByTestId(testId).first().boundingBox()
  expect(b, `${testId} is not on screen`).toBeTruthy()
  return b!
}

/** What the browser actually hits at the centre of an element — the element itself, or whatever covers it */
async function hitsItself(page: Page, testId: string): Promise<boolean> {
  return page
    .getByTestId(testId)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return !!hit && (hit === el || el.contains(hit))
    })
}

async function open(page: Page, query: string) {
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto(`/shell-banner.html?${query}`)
  await expect(page.getByTestId('host-other-build')).toBeVisible()
  await expect(page.getByTestId('app-header')).toBeVisible()
}

/** The banner sits right under the top bar, in the flow, clear of the traffic lights and the header */
async function expectBelowTopBar(page: Page) {
  const bar = page.getByTestId('host-other-build')
  // Not laid over anything: a static block, so it takes room instead of covering it
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('static')

  const header = await box(page, 'app-header')
  const banner = await box(page, 'host-other-build')
  expect(header.y, 'the top bar stays at the top of the window, where the traffic lights are centred').toBe(0)
  expect(
    Math.abs(banner.y - (header.y + header.height)),
    'the banner starts where the top bar ends',
  ).toBeLessThan(1)
  expect(overlaps(banner, header), 'the banner covers part of the top bar').toBe(false)
  expect(overlaps(banner, LIGHTS), 'the banner sits under the traffic lights').toBe(false)

  // Header controls are still the top of the stack where they are drawn
  expect(await hitsItself(page, 'counter'), 'the waiting counter in the top bar is covered').toBe(true)
  // One line of one height in every state (the lanes must not jump when a switch starts), long
  // text truncates instead of wrapping, and nothing spills past the window
  expect(banner.height).toBe(BANNER_HEIGHT)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)
  expect(banner.x + banner.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  return banner
}

/** Nothing in the lanes starts under the banner */
async function expectBelow(page: Page, banner: Box, testIds: string[]) {
  const floor = banner.y + banner.height
  for (const id of testIds) {
    const b = await box(page, id)
    expect(b.y, `${id} starts under the banner`).toBeGreaterThanOrEqual(floor - 0.5)
  }
}

export function shellBannerTests(): void {
  test.describe('the shell banner covers nothing (#326)', () => {
    test('the other-build bar sits below the top bar, its long text truncates and its button is clickable', async ({
      page,
    }) => {
      await open(page, 'demo=focus&state=other')
      const banner = await expectBelowTopBar(page)

      const text = page.getByTestId('host-other-build').locator('span').first()
      expect(
        await text.evaluate((el) => el.scrollWidth > el.clientWidth),
        'the build text should be cut, not wrapped',
      ).toBe(true)
      const button = await box(page, 'host-switch-build')
      expect(button.x + button.width).toBeLessThanOrEqual(page.viewportSize()!.width)
      expect(await hitsItself(page, 'host-switch-build'), 'something is drawn over the switch button').toBe(
        true,
      )

      await expectBelow(page, banner, ['sidebar', 'session-view', 'pane-header'])
      // The lanes gave up the banner's height rather than pushing the composer off the bottom
      const composer = await box(page, 'composer-shell')
      expect(composer.y + composer.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    })

    for (const state of ['progress', 'failed'] as const) {
      test(`the switch ${state} state sits in the same place`, async ({ page }) => {
        await open(page, `demo=focus&state=${state}`)
        const banner = await expectBelowTopBar(page)
        await expect(page.getByTestId('host-switch-progress')).toBeVisible()
        await expectBelow(page, banner, ['sidebar', 'session-view'])
      })
    }

    /*
     * #387: beta.10's keeper cannot hand itself over on macOS ("Message too long"), and the fix is
     * in the sending keeper, which an update does not replace. The host swap still goes ahead
     * under it, so the window runs its own build; the bar must say that calmly and offer the full
     * restart, instead of "Switch to this build" forever and "Could not switch builds" on the second try.
     */
    for (const state of ['keeper-later', 'keeper-later-first'] as const) {
      test(`a keeper that could not move while the host runs this build (${state}): a note and a full restart, no switch`, async ({
        page,
      }) => {
        await open(page, `demo=focus&state=${state}`)
        await expectBelowTopBar(page)
        const bar = page.getByTestId('host-other-build')
        await expect(bar).toHaveAttribute('role', 'status')
        await expect(page.getByTestId('host-switch-progress')).toHaveText(
          'Running this build. The background keeper moves to it the next time it restarts.',
        )
        await expect(bar).not.toContainText('Could not switch builds')
        await expect(page.getByTestId('host-switch-build')).toHaveCount(0)
        const restart = page.getByTestId('host-restart-keeper')
        await expect(restart).toHaveText('Restart completely')
        expect(await hitsItself(page, 'host-restart-keeper'), 'something is drawn over the restart button').toBe(true)

        // It says plainly what stops before anything does
        await restart.click()
        await expect(page.getByTestId('confirm-restart-keeper-loses')).toContainText(
          'Also stops agents, terminals and running commands.',
        )
        const calls = () => page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls)
        expect(await calls()).toEqual([])
        await page.getByTestId('confirm-restart-keeper-yes').click()
        expect(await calls()).toEqual(['restart_keeper'])
        await expect(page.getByTestId('host-switch-progress')).toHaveText('Restarting the background keeper on this build…')
        await expect(page.getByTestId('host-restart-keeper')).toHaveCount(0)
      })
    }

    test('a real failure still reads as one: the reason, "Try again", and no restart offered', async ({ page }) => {
      await open(page, 'demo=focus&state=failed')
      const bar = page.getByTestId('host-other-build')
      await expect(bar).toHaveAttribute('role', 'alert')
      await expect(page.getByTestId('host-switch-progress')).toHaveText(
        'Could not switch builds: the new build did not pass its start check: no answer within 60s. The running build was not touched and is still serving.',
      )
      await expect(page.getByTestId('host-switch-build')).toHaveText('Try again')
      await expect(page.getByTestId('host-restart-keeper')).toHaveCount(0)
    })

    test('in the grid, every panel starts below the banner', async ({ page }) => {
      await open(page, 'demo=grid&state=other')
      const banner = await expectBelowTopBar(page)
      await expect(page.getByTestId('grid')).toBeVisible()
      const panels = await page
        .locator('[data-testid^="grid-panel-"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!))
      expect(panels.length).toBeGreaterThan(0)
      await expectBelow(page, banner, ['sidebar', 'grid', ...panels])
      const grid = await box(page, 'grid')
      expect(grid.y + grid.height).toBeLessThanOrEqual(page.viewportSize()!.height + 0.5)
    })
  })
}
