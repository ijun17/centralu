import { expect, test, type Page } from '@playwright/test'
import { setup } from './control.js'

/**
 * The usage panel of a tool that reports no limits (#1623, owner 2026-10-26): plain words instead of "Usage unavailable"
 * and a technical reason, the plan the tool says, and what it counted locally, labelled as totals and not a limit. A
 * function, because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 *
 * Codex stands for the tool in the mock, on purpose: the screen reads the host's answer (`notReported`, the plan, the
 * totals) and the tool's label, never a tool's name.
 */

type MockWindow = { __mock: any }

const NONE = { plan: null, windows: [], daily: [] }
const PLAN = { ...NONE, plan: 'Free' }
const TOTALS = {
  ...NONE,
  totals: {
    scope: 'all time',
    rows: [
      { id: 'sessions', label: 'Sessions', value: 28, unit: 'count' },
      { id: 'input', label: 'Input', value: 257000, unit: 'tokens' },
      { id: 'cache-read', label: 'Cache read', value: 462700, unit: 'tokens' },
      { id: 'cost', label: 'Cost', value: 0, unit: 'usd' },
    ],
  },
}
/** A count the tool printed in a form the host could not read is null: shown as a dash, never as a number */
const UNREAD = { ...NONE, totals: { scope: 'all time', rows: [{ id: 'sessions', label: 'Sessions', value: null, unit: 'count' }, { id: 'messages', label: 'Messages', value: 126, unit: 'count' }] } }
const TOTALS_PLAN = { ...TOTALS, plan: 'Free' }
const answer = (usage: unknown) => ({ supported: false, reason: 'Codex does not report usage limits', notReported: true, usage })

async function open(page: Page, codex: unknown): Promise<void> {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate((c) => {
    ;(window as unknown as MockWindow).__mock.toolUsage = { codex: c }
  }, codex)
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
  await expect(page.getByTestId('connection')).toBeVisible()
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
  await expect(page.getByTestId('connection')).toHaveCount(0)
  await page.getByTestId('usage-donut-codex').click()
  await expect(page.getByTestId('usage-drop')).toBeVisible()
}

export function usageNotReportedTests(): void {
  test.describe('the usage panel of a tool that reports no limits (#1623)', () => {
    test('says so in plain words, with the plan, and without the technical reason or a limit bar', async ({ page }) => {
      await open(page, answer(PLAN))
      await expect(page.getByTestId('usage-not-reported-text')).toHaveText('Codex does not report usage limits.')
      await expect(page.getByTestId('usage-plan')).toHaveText('Free plan')
      await expect(page.getByTestId('usage-unavailable')).toHaveCount(0)
      await expect(page.getByTestId('usage-panel')).toHaveCount(0)
      await expect(page.locator('[data-testid^="usage-window-"]')).toHaveCount(0)
      await expect(page.getByTestId('usage-totals')).toHaveCount(0)
    })

    test('shows what the tool counted locally as totals, not a limit', async ({ page }) => {
      await open(page, answer(TOTALS))
      const totals = page.getByTestId('usage-totals')
      await expect(totals).toContainText('Local totals · all time')
      await expect(page.getByTestId('usage-total-sessions')).toHaveText('Sessions28')
      await expect(page.getByTestId('usage-total-input')).toHaveText('Input257k')
      await expect(page.getByTestId('usage-total-cache-read')).toHaveText('Cache read463k')
      await expect(page.getByTestId('usage-total-cost')).toHaveText('Cost$0.00')
      await expect(totals).toContainText('Counted by Codex on this computer. These are totals, not a limit.')
      // No plan line when the tool names none
      await expect(page.getByTestId('usage-plan')).toHaveCount(0)
    })

    test('a tool that says nothing at all still gets the plain words, and the donut is the dimmed one', async ({ page }) => {
      await open(page, answer(NONE))
      await expect(page.getByTestId('usage-not-reported-text')).toContainText('Codex does not report usage limits.')
      await expect(page.getByTestId('usage-totals')).toHaveCount(0)
      await expect(page.getByTestId('usage-donut-codex')).toHaveAttribute('data-state', 'unsupported')
      // The donut's own words (the accessible name and the tooltip) say the same, not "unknown" and not the technical reason
      await expect(page.getByTestId('usage-donut-codex')).toHaveAttribute('aria-label', 'Codex reports no usage limits')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('usage-drop')).toHaveCount(0)
      await page.mouse.move(0, 300)
      await page.getByTestId('usage-donut-codex').hover()
      await expect(page.getByTestId('usage-donut-reason-codex')).toHaveText('Codex does not report usage limits.')
      await expect(page.getByTestId('usage-donut-tip-codex')).not.toContainText('unknown')
    })

    test('a count the tool printed in a form the host could not read is a dash, not a number', async ({ page }) => {
      await open(page, answer(UNREAD))
      await expect(page.getByTestId('usage-total-sessions')).toHaveText('Sessions—')
      await expect(page.getByTestId('usage-total-messages')).toHaveText('Messages126')
    })

    test('a command that was slower than the host waits: the open panel receives the plan when it ends, without polling', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(
        ([first, settled]) => {
          const m = (window as unknown as MockWindow).__mock
          m.toolUsage = { codex: first }
          m.settledUsage = { codex: settled }
        },
        [{ ...answer(NONE), provisional: true }, answer(TOTALS_PLAN)] as const,
      )
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      await expect(page.getByTestId('connection')).toHaveCount(0)
      await page.getByTestId('usage-donut-codex').click()
      // The panel was never reopened: what it shows changed in place
      await expect(page.getByTestId('usage-plan')).toHaveText('Free plan')
      await expect(page.getByTestId('usage-totals')).toContainText('Local totals · all time')
      // Each ask that was provisional is settled once (the donut's two asks and the panel's), and nothing asks again however long it stays open
      const settles = () => page.evaluate(() => ((window as unknown as MockWindow).__mock.usageCalls as { settle: boolean }[]).filter((c) => c.settle).length)
      const asked = await settles()
      expect(asked).toBeGreaterThanOrEqual(1)
      expect(asked).toBeLessThanOrEqual(3)
      await page.waitForTimeout(700)
      expect(await settles()).toBe(asked)
    })

    test('the donut follows the settled answer as the panel does, not the provisional one for five minutes', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(
        ([first, settled]) => {
          const m = (window as unknown as MockWindow).__mock
          m.toolUsage = { codex: first }
          m.settledUsage = { codex: settled }
        },
        [{ ...answer(NONE), provisional: true }, { supported: false, reason: 'Codex is not logged in on this computer', usage: null }] as const,
      )
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      await expect(page.getByTestId('connection')).toHaveCount(0)
      // The command ended with "not logged in": the donut is the unknown one with that reason, not the dimmed "no limits" one
      await expect(page.getByTestId('usage-donut-codex')).toHaveAttribute('data-state', 'unknown')
      await page.mouse.move(0, 300)
      await page.getByTestId('usage-donut-codex').hover()
      await expect(page.getByTestId('usage-donut-reason-codex')).toHaveText('Codex is not logged in on this computer')
    })

    test('a read that failed is still its reason, not the plain words (nothing says the tool has no limits)', async ({ page }) => {
      await open(page, { supported: false, reason: 'Codex is not logged in on this computer', usage: null })
      await expect(page.getByTestId('usage-unavailable')).toContainText('Codex is not logged in on this computer')
      await expect(page.getByTestId('usage-not-reported')).toHaveCount(0)
    })

    test('a host that predates the answer (no plan, no totals, no mark) is the unavailable panel as it was', async ({ page }) => {
      await open(page, { supported: false, reason: 'codex does not support usage queries', usage: null })
      await expect(page.getByTestId('usage-unavailable')).toContainText('does not support usage queries')
      await expect(page.getByTestId('usage-not-reported')).toHaveCount(0)
    })

    test("a linked machine's totals say they were counted there, not on this computer", async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(() => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', name: 'Box', sshTarget: 'me@box' }))
      await page.evaluate((c) => {
        ;(window as unknown as MockWindow).__mock.toolUsage = { 'box.codex': c }
      }, answer(TOTALS))
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      await expect(page.getByTestId('connection')).toHaveCount(0)
      await page.getByTestId('usage-donut-box.codex').click()
      await expect(page.getByTestId('usage-totals')).toContainText('Counted by Codex on Box. These are totals, not a limit.')
    })

    for (const reduced of [false, true]) {
      test(`its rows come in by a short fade${reduced ? ', the only motion left with reduced motion' : ''}`, async ({ page }) => {
        if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
        await open(page, answer({ ...TOTALS, plan: 'Free' }))
        for (const id of ['usage-not-reported-text', 'usage-plan', 'usage-totals']) {
          const anim = await page.getByTestId(id).evaluate((el) => {
            const s = getComputedStyle(el)
            return { name: s.animationName, ms: parseFloat(s.animationDuration) * 1000 }
          })
          expect(anim.name).toBe('cc-donut-in')
          expect(anim.ms).toBeGreaterThanOrEqual(150)
          expect(anim.ms).toBeLessThanOrEqual(200)
        }
        // Opacity and nothing else moves: read from the keyframes themselves, since the 180ms may be over by now
        const props = await page.evaluate(() => {
          const found = new Set<string>()
          for (const sheet of document.styleSheets) {
            for (const rule of sheet.cssRules) {
              if (rule instanceof CSSKeyframesRule && rule.name === 'cc-donut-in') {
                for (const frame of rule.cssRules) for (const p of (frame as CSSKeyframeRule).style) found.add(p)
              }
            }
          }
          return [...found]
        })
        expect(props).toEqual(['opacity'])
        // The press is not held: the panel can be closed from the first frame
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('usage-drop')).toHaveCount(0)
      })
    }
  })
}
