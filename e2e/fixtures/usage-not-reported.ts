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

    test('writes the sessions and messages exactly, with thousands separators, and the tokens abbreviated (owner, 2026-10-27)', async ({ page }) => {
      const counts = {
        ...NONE,
        totals: {
          scope: 'all time',
          rows: [
            { id: 'sessions', label: 'Sessions', value: 1204, unit: 'count' },
            { id: 'messages', label: 'Messages', value: 120400, unit: 'count' },
            { id: 'input', label: 'Input', value: 1204000, unit: 'tokens' },
          ],
        },
      }
      await open(page, answer(counts))
      await expect(page.getByTestId('usage-total-sessions')).toHaveText('Sessions1,204')
      await expect(page.getByTestId('usage-total-messages')).toHaveText('Messages120,400')
      await expect(page.getByTestId('usage-total-input')).toHaveText('Input1.2M')
    })

    test('says when the totals were read: the clock time for today, the date as well for an earlier day, nothing from a host that predates it', async ({ page }) => {
      const read = (asOf: number | undefined) => ({ ...TOTALS, totals: { ...TOTALS.totals, ...(asOf === undefined ? {} : { asOf }) } })
      const line = page.getByTestId('usage-totals-as-of')
      await open(page, answer(read(Date.now() - 60_000)))
      await expect(line).toHaveText(/^As of \d{1,2}:\d{2}\s(AM|PM)$/)
      // It sits under the totals and their note, in the small muted text of the note
      const note = page.getByTestId('usage-totals').locator('p').first()
      const [noteBox, lineBox] = [await note.boundingBox(), await line.boundingBox()]
      expect(lineBox!.y).toBeGreaterThan(noteBox!.y)
      await expect(line).toHaveCSS('font-size', (await note.evaluate((e) => getComputedStyle(e).fontSize)))
      await expect(line).toHaveCSS('color', (await note.evaluate((e) => getComputedStyle(e).color)))

      await page.keyboard.press('Escape')
      await expect(page.getByTestId('usage-drop')).toHaveCount(0)
      await page.evaluate((c) => ((window as unknown as MockWindow).__mock.toolUsage = { codex: c }), answer(read(Date.now() - 3 * 86_400_000)))
      await page.getByTestId('usage-donut-codex').click()
      await expect(line).toHaveText(/^As of [A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{1,2}:\d{2}\s(AM|PM)$/)

      await page.keyboard.press('Escape')
      await expect(page.getByTestId('usage-drop')).toHaveCount(0)
      await page.evaluate((c) => ((window as unknown as MockWindow).__mock.toolUsage = { codex: c }), answer(read(undefined)))
      await page.getByTestId('usage-donut-codex').click()
      await expect(page.getByTestId('usage-total-sessions')).toBeVisible()
      await expect(line).toHaveCount(0)
    })

    test('the plan is in the body font, the figures in the figures font (owner, 2026-10-27)', async ({ page }) => {
      await open(page, answer({ ...TOTALS, plan: 'Free' }))
      const font = (id: string) => page.getByTestId(id).evaluate((e) => getComputedStyle(e).fontFamily)
      const body = await font('usage-not-reported-text')
      expect(await font('usage-plan')).toBe(body)
      expect(await page.getByTestId('usage-total-sessions').locator('span').last().evaluate((e) => getComputedStyle(e).fontFamily)).not.toBe(body)
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

    test('old totals shown while the host reads again: the open panel gets the new totals and their time when the read lands, without reopening', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      const read = (sessions: number, asOf: number) => ({ ...NONE, totals: { scope: 'all time', asOf, rows: [{ id: 'sessions', label: 'Sessions', value: sessions, unit: 'count' }] } })
      await page.evaluate(
        ([old, fresh]) => {
          const m = (window as unknown as MockWindow).__mock
          // The host's first answer is the old totals, marked as standing in for the read behind them; a settle returns the new ones
          m.toolUsage = { codex: old }
          m.settledUsage = { codex: fresh }
        },
        [{ ...answer(read(28, Date.now() - 3 * 86_400_000)), provisional: true }, answer(read(30, Date.now() - 1000))] as const,
      )
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      await expect(page.getByTestId('connection')).toHaveCount(0)
      await page.getByTestId('usage-donut-codex').click()
      // Never reopened: the totals and the time changed in place, from a dated read to today's
      await expect(page.getByTestId('usage-total-sessions')).toHaveText('Sessions30')
      await expect(page.getByTestId('usage-totals-as-of')).toHaveText(/^As of \d{1,2}:\d{2}\s(AM|PM)$/)
      // The panel's own first ask was answered with the old totals, and one more ask, to settle, brought the new ones
      const calls = await page.evaluate(() => (window as unknown as MockWindow).__mock.usageCalls as { tool: string; settle: boolean }[])
      expect(calls.some((c) => c.tool === 'codex' && !c.settle)).toBe(true)
      expect(calls.some((c) => c.tool === 'codex' && c.settle)).toBe(true)
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
