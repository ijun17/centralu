import { expect, test, type Locator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './app-views.js'
import { slider, setApps } from './grid-apps.js'
import { newSession, setup } from './project-screen.js'

/**
 * The keyboard stays with the composer (#115: "the composer sometimes stops accepting keystrokes").
 *
 * The composer was never disabled; what went was focus. A layer that took focus (the inbox, the
 * palette, the settings screen) closed and took the focused element with it, so the browser left
 * focus on `<body>`; a press on the window's drag region moved focus to nothing; a hidden app view
 * kept it inside its frame. In every case the box looked exactly as before and the keys landed
 * nowhere. Each test types, passes through one of those paths, types again, and reads the box: the
 * one thing the person sees.
 *
 * A function, like `sidebarSelectionTests`, because it runs in Chromium (composer-focus.spec.ts)
 * and in WebKit (composer-focus-webkit.spec.ts): the desktop app is WKWebView, and the hidden frame
 * keeping the keyboard is WebKit's behaviour.
 */

const box = (page: Page) => page.getByTestId('prompt-input')

/** A session open in the focus view, its composer holding focus with `a` typed into it */
async function typing(page: Page): Promise<Locator> {
  await setup(page, ['/tmp/alpha'])
  await newSession(page, 'alpha')
  await box(page).click()
  await page.keyboard.type('a')
  await expect(box(page)).toHaveValue('a')
  return box(page)
}

export function composerFocusTests(): void {
  test.describe('the composer keeps the keyboard (#115)', () => {
    test('after the inbox is opened and closed from the keyboard', async ({ page }) => {
      const input = await typing(page)
      await page.keyboard.press('ControlOrMeta+i')
      await expect(page.getByTestId('inbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('inbox')).toBeHidden()
      await page.keyboard.type('b')
      await expect(input).toHaveValue('ab')
    })

    test('after the command palette is opened and dismissed', async ({ page }) => {
      const input = await typing(page)
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByTestId('palette-input')).toBeFocused()
      await page.keyboard.type('zzz')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('command-palette')).toBeHidden()
      await page.keyboard.type('b')
      await expect(input).toHaveValue('ab')
    })

    test('after the settings screen is opened from the composer, clicked in, and closed', async ({ page }) => {
      const input = await typing(page)
      await page.keyboard.press('Backspace')
      await page.keyboard.type('/settings')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Enter')
      const settings = page.getByTestId('settings')
      await expect(settings).toBeVisible()
      // A click inside moves focus into the screen, which leaves with it
      await settings.locator('button').first().click()
      await page.keyboard.press('Escape')
      await expect(settings).toBeHidden()
      await page.keyboard.type('b')
      await expect(input).toHaveValue('b')
    })

    test('after the window is moved by its top bar', async ({ page }) => {
      const input = await typing(page)
      const bar = (await page.getByTestId('app-header').boundingBox())!
      // An empty spot of the bar: between the title and the counter
      await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
      await page.mouse.down()
      await page.mouse.up()
      // The press did start a window drag, so this is the path the bar takes, not a missed click
      expect(await page.evaluate(() => (window as any).__mock.windowDrags)).toBe(1)
      await page.keyboard.type('b')
      await expect(input).toHaveValue('ab')
    })

    test.describe('an app view', () => {
      let fx: FixtureHost
      test.beforeAll(async () => {
        fx = await startFixtureHost({ 'slider ui://slider/main': { html: fixtureViewHtml() } })
      })
      test.afterAll(async () => {
        await fx?.close()
      })

      test('put out of sight without a click lets go of the keyboard', async ({ page }) => {
        await page.exposeFunction('__viewFrame', (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
          fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
        )
        await page.exposeFunction('__openView', (appId: string, projectId: string | null) => {
          const instanceId = fx.open({ projectId, appId }, `ui://${appId}/main`)
          return {
            instanceId,
            tool: 'home',
            resourceUri: `ui://${appId}/main`,
            toolInput: {},
            toolResult: { content: [{ type: 'text', text: 'home' }], structuredContent: { home: appId } },
            runId: `run-${instanceId}`,
          }
        })
        await page.goto('/?mock=1')
        await page.evaluate(() => {
          const w = window as any
          w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
          w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
          w.__mock.nextPickedDirectory = '/tmp/alpha'
        })
        await page.getByTestId('add-project').click()
        await page.getByTestId('trust-ask-yes-alpha').click()
        const pid = await page.evaluate(() => Object.keys((window as any).__store.getState().projects)[0] as string)
        await setApps(page, [slider(pid)])
        const s = await newSession(page, 'alpha')

        // Typing into a field of the app's own page
        await page.getByTestId(`app-row-${pid}/slider`).click()
        const section = page.getByTestId(`pinned-app-${pid}/slider`)
        await expect(section.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
        const view = section.getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
        await view.locator('body').evaluate((b) => {
          const field = document.createElement('input')
          field.id = 'field'
          b.append(field)
        })
        await view.locator('#field').click()
        await page.keyboard.type('x')
        await expect(view.locator('#field')).toHaveValue('x')

        // The screen moves to the session the way a notification click does: no click in the page
        await page.evaluate((id) => (window as any).__store.getState().focusSession(id), s)
        await expect(section).toHaveAttribute('data-mode', 'hidden')
        await page.keyboard.type('y')
        await expect(view.locator('#field')).toHaveValue('x')
        // The keys reach the page again: its own shortcut opens the palette
        await page.keyboard.press('ControlOrMeta+k')
        await expect(page.getByTestId('command-palette')).toBeVisible()
      })
    })
  })
}
