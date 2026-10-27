import { expect, test, type Page } from '@playwright/test'
import { setup as firstRun } from './fixtures/control.js'
import { setup, newSession } from './fixtures/panel.js'

/**
 * The right-hand panel and the grid around it: the usage donuts, one per tool. Moved out of
 * panel.spec.ts by subject; the shared helpers (setup, newSession, openGrid) are in
 * fixtures/panel.ts.
 */

/** The default mock has empty windows and only renders 'usage-unavailable' — this sets up the state where the donut shows */
async function stubUsage(page: Page, windows?: unknown[]) {
  await page.evaluate((ws: unknown[] | undefined) => {
    ;(window as never as { __mock: any }).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: ws ?? [{ id: 'session', label: '5 hours', percent: 41, resetsAt: null, scope: null }],
        daily: [],
      },
    }
  }, windows)
}

/*
 * ── Usage (#26 → 2026-09-09) ────────────────────────────────────────
 *
 * Usage is per **account**, but differs by tool. For a long time, that answer was inferred from
 * whatever was on screen (the tools showing in the grid). It is no longer inferred: **one donut
 * per tool** lives permanently on the dashboard, and the person chooses which limit to look at.
 * So what is checked here is not "is the guess correct" but "does each donut speak for its own
 * tool."
 */

test('usage gets one donut per tool — the screen never guesses which tool is meant', async ({ page }) => {
  await setup(page)
  await stubUsage(page)
  await newSession(page, 'alpha', 'claude', "Claude's task")

  // Even while looking only at a Claude session, the Codex donut stays in its own spot
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  await expect(page.getByTestId('usage-donut-codex')).toBeVisible()

  await page.getByTestId('usage-donut-codex').click()
  // The agent's name is the panel's heading; the word "Usage" is not (owner, 2026-10-28)
  await expect(page.getByTestId('usage-drop-title')).toHaveText('Codex')
  await expect(page.getByTestId('usage-drop')).toContainText('Codex')
  await expect(page.getByTestId('usage-drop')).not.toContainText('Claude Code')
  await expect(page.getByTestId('usage-panel')).toHaveCount(1)

  // Clicking a different donut switches to that tool's limit (same spot, different answer)
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-drop-title')).toHaveText('Claude Code')
})

/**
 * Only a connected agent gets a donut (user request, 2026-09-09).
 *
 * An empty ring for an unused tool would say nothing while still taking up space on the
 * dashboard. The test is installed-plus-logged-in — the **same test** the new-session dialog
 * uses, so the two places on screen never give different answers to "can this tool be used."
 */
test('a tool that is not logged in gets an signed-out donut, not a usage one (#59)', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    const as = (name: string, s: object) => ({ ...m.detected.find((t: any) => t.name === name), ...s })
    m.detected = [
      as('claude', { installed: true, loggedIn: true, detail: 'mock 2.1.0' }),
      as('codex', { installed: true, loggedIn: false, detail: 'not logged in' }),
    ]
  })
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()

  // Opening the details is itself asking again (the person may have just logged out — the same rule as the session dialog)
  await page.getByTestId('usage-donut-claude').click()

  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  // A tool installed but signed out is not drawn with a reading (owner, 2026-10-27): its donut is the error one, with no usage
  await expect(page.getByTestId('usage-donut-claude')).not.toHaveAttribute('data-signed-out', 'true')
  await expect(page.getByTestId('usage-donut-codex')).toHaveAttribute('data-signed-out', 'true')

  /*
   * If nothing at all can be used, the space is not left empty — the message is not "nothing to
   * see" but **"there is something to do"** (install, log in). The same rule that logs a
   * disconnection.
   */
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    const claude = m.detected.find((t: any) => t.name === 'claude')
    // Not installed: an installed tool that is signed out has a donut of its own now (tool-setup.ts)
    m.detected = [{ ...claude, installed: false, loggedIn: false, detail: 'not installed' }]
  })
  // Closing (first click) then reopening (second) asks again at that point — closing asks nothing
  await page.getByTestId('usage-donut-claude').click()
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-no-agent')).toBeVisible()
})

test('a tool check that fails is not "no agent": the strip keeps what it said last (#850)', async ({ page }) => {
  await firstRun(page)
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()

  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.agents.detect = () => Promise.reject(new Error('detect did not answer'))
  })
  // Opening the details asks again, and that ask fails
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-no-agent')).toHaveCount(0)
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
})

/**
 * The unknown is not drawn as 0%.
 *
 * A ring drawn fully gray reads as "nothing used at all" — a failure where the fact that it could
 * not be read disappears from the screen (the same kind of failure as #26 "silently falling back
 * to claude"). When unknown, it is dotted, and the details opened by clicking it state the reason.
 */
test('if the weekly limit is unknown, the donut says so', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  // The default mock has no windows — weekly cannot be selected
  const donut = page.getByTestId('usage-donut-claude')
  await expect(donut).toHaveAttribute('data-percent', '')

  await stubUsage(page, [{ id: 'weekly_all', label: 'Weekly', percent: 93, resetsAt: null, scope: null }])
  await donut.click()
  await expect(page.getByTestId('usage-drop')).toBeVisible()
  // Once a value arrives, the donut carries that number
  await expect.poll(async () => donut.getAttribute('data-percent')).toBe('93')
})
