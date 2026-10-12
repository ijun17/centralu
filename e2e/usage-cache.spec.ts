import { expect, test, type Page } from '@playwright/test'

/**
 * The prompt cache in the usage gauge (docs/agent-host.md §6.1): one line in the donut's tooltip, and the breakdown in
 * the dropdown its click opens. The figures are the mock's, as a host would answer them; how a host counts them is
 * unit-tested where it is done (`cache-ledger.test.ts`, the adapters' normalize tests).
 */

type MockWindow = { __mock: any; __store: any }

const HOUR = 3600_000

async function setup(page: Page): Promise<void> {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as MockWindow).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-alpha')).toBeVisible()
}

async function newSession(page: Page, prompt: string): Promise<string> {
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as unknown as MockWindow).__store.getState().focusedSessionId)
}

/** The answer a host gives: Claude mostly hits (94%) with six rebuilds, Codex reports reads only (90%) */
function figures(here: string) {
  const now = Date.now()
  const since = new Date(now - 5 * HOUR).toISOString()
  const today = new Date(now - 12 * HOUR).toISOString()
  const countingSince = new Date(now - 30 * HOUR).toISOString()
  const claude = (read: number, rebuilds: number) => ({
    requests: 412,
    inputTokens: 18_400,
    cacheReadTokens: read,
    cacheCreationTokens: 1_940_000,
    rebuilds,
    rebuildCauses: rebuilds === 6 ? { expired: 3, model_change: 1, compaction: 1, launch_settings: 1 } : { expired: 6, model_change: 3 },
    expiredIdleMs: { min: 64 * 60_000, max: 64 * 60_000 },
    sessions: [
      { sessionId: here, name: 'Cached work', requests: 9, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1_120_000, rebuilds: 3, rebuildCauses: { expired: 2, model_change: 1 } },
      { sessionId: 'gone', name: '', requests: 2, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 540_000, rebuilds: 1 },
    ],
  })
  return {
    claude: {
      writes: true,
      countingSince,
      windows: [
        { id: '5h', label: 'last 5 h', since, ...claude(31_200_000, 6) },
        { id: 'today', label: 'today', since: today, ...claude(5_000_000, 9) },
      ],
    },
    codex: {
      writes: false,
      countingSince,
      windows: [
        {
          id: '5h',
          label: 'last 5 h',
          since,
          requests: 96,
          inputTokens: 410_000,
          cacheReadTokens: 3_900_000,
          cacheCreationTokens: 0,
          rebuilds: 0,
          sessions: [],
        },
      ],
    },
    // A linked machine counts its own: 71%, a session of its own (the hub qualifies the id)
    'box.claude': {
      writes: true,
      countingSince,
      windows: [
        {
          id: '5h',
          label: 'last 5 h',
          since,
          requests: 30,
          inputTokens: 0,
          cacheReadTokens: 710_000,
          cacheCreationTokens: 290_000,
          rebuilds: 2,
          sessions: [{ sessionId: 'box.s9', name: 'Remote work', requests: 30, inputTokens: 0, cacheReadTokens: 710_000, cacheCreationTokens: 290_000, rebuilds: 2 }],
        },
      ],
    },
  }
}

async function answer(page: Page, cacheStats: unknown): Promise<void> {
  await page.evaluate((c) => {
    const m = (window as unknown as MockWindow).__mock
    m.usageState = {
      supported: true,
      usage: { plan: 'max', windows: [{ id: 'weekly_all', label: 'Weekly', percent: 40, resetsAt: null, scope: null }], daily: [] },
    }
    m.cacheStats = c
  }, cacheStats)
  // The donuts ask on mount and when the host connection comes back: this is the second
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
  await expect(page.getByTestId('connection')).toBeVisible()
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
  await expect(page.getByTestId('connection')).toHaveCount(0)
}

test('the gauge says the cache hit rate on hover, and its dropdown breaks it down and opens the session that wrote most', async ({ page }) => {
  await setup(page)
  const cached = await newSession(page, 'the cached one')
  const other = await newSession(page, 'another one')
  expect(other).not.toBe(cached)
  await answer(page, figures(cached))

  await test.step('hover: one short line', async () => {
    await page.getByTestId('usage-donut-claude').hover()
    await expect(page.getByTestId('usage-donut-cache-claude')).toHaveText('Cache hit 94% · last 5 h')
  })

  await test.step('click: the breakdown for the last 5 hours', async () => {
    await page.getByTestId('usage-donut-claude').click()
    const cache = page.getByTestId('usage-cache')
    await expect(cache).toHaveAttribute('data-window', '5h')
    await expect(page.getByTestId('usage-cache-rate')).toHaveText('94%')
    await expect(page.getByTestId('usage-cache-read')).toContainText('31.2M')
    await expect(page.getByTestId('usage-cache-written')).toContainText('1.9M')
    await expect(page.getByTestId('usage-cache-uncached')).toContainText('18k')
    await expect(page.getByTestId('usage-cache-rebuilds')).toContainText('6 of 412 requests')
    await expect(page.getByTestId('usage-cache-causes')).toHaveText(
      '6 rebuilds: 3 cache expired (idle 64 min) · 1 model change · 1 compaction · 1 launch settings changed',
    )
    await expect(page.getByTestId(`usage-cache-session-causes-${cached}`)).toHaveText('2 cache expired · 1 model change')
    await expect(page.getByTestId('usage-cache-sessions')).toContainText('Most cache writes')
    await expect(page.getByTestId('usage-cache-reads-only')).toHaveCount(0)
  })

  await test.step('the switch shows today', async () => {
    await page.getByTestId('usage-cache-window-today').click()
    await expect(page.getByTestId('usage-cache')).toHaveAttribute('data-window', 'today')
    await expect(page.getByTestId('usage-cache-rate')).toHaveText('72%')
    await expect(page.getByTestId('usage-cache-rebuilds')).toContainText('9 of 412 requests')
    await expect(page.getByTestId('usage-cache-causes')).toHaveText('9 rebuilds: 6 cache expired (idle 64 min) · 3 model change')
  })

  await test.step('a session that is gone is named, not a button', async () => {
    await expect(page.getByTestId('usage-cache-session-gone')).toContainText('Deleted session')
    await expect(page.locator('button[data-testid="usage-cache-session-gone"]')).toHaveCount(0)
  })

  await test.step('a session row opens that session and closes the dropdown', async () => {
    await page.getByTestId(`usage-cache-session-${cached}`).click()
    await expect(page.getByTestId('usage-drop')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as MockWindow).__store.getState().focusedSessionId)).toBe(cached)
  })
})

test('Codex is said to report cache reads only', async ({ page }) => {
  await setup(page)
  await answer(page, figures('none'))
  await page.getByTestId('usage-donut-codex').hover()
  await expect(page.getByTestId('usage-donut-cache-codex')).toHaveText('Cache hit 90% · last 5 h')
  await page.getByTestId('usage-donut-codex').click()
  await expect(page.getByTestId('usage-cache-rate')).toHaveText('90%')
  await expect(page.getByTestId('usage-cache-written')).toContainText('not reported')
  await expect(page.getByTestId('usage-cache-reads-only')).toHaveText(
    'Codex reports cache reads only, not writes: the hit rate is cached input over all input.',
  )
  // For a reads-only tool, a rebuild is a request that read less than half its input from cache
  await expect(page.getByTestId('usage-cache-rebuilds')).toContainText('0 of 96 requests')
  await expect(page.getByTestId('usage-cache-causes')).toHaveCount(0)
})

test("a linked machine's donut shows that machine's own cache figures", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', name: 'Box', sshTarget: 'me@box' }))
  await answer(page, figures('none'))
  await expect(page.getByTestId('usage-donut-box.claude')).toBeVisible()
  await page.getByTestId('usage-donut-box.claude').hover()
  await expect(page.getByTestId('usage-donut-cache-box.claude')).toHaveText('Cache hit 71% · last 5 h')
  await page.getByTestId('usage-donut-box.claude').click()
  await expect(page.getByTestId('usage-drop')).toHaveAttribute('data-machine', 'box')
  await expect(page.getByTestId('usage-cache-rate')).toHaveText('71%')
  await expect(page.getByTestId('usage-cache-session-box.s9')).toContainText('Remote work')
})

test('a host that predates the figures leaves the tooltip and the dropdown as they were', async ({ page }) => {
  await setup(page)
  await answer(page, {})
  await page.getByTestId('usage-donut-claude').hover()
  await expect(page.getByTestId('usage-donut-tip-claude')).toContainText('Weekly')
  await expect(page.getByTestId('usage-donut-cache-claude')).toHaveCount(0)
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-panel')).toBeVisible()
  await expect(page.getByTestId('usage-cache')).toHaveCount(0)
})
