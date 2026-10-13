import { expect, test, type Locator, type Page } from '@playwright/test'

type MockWindow = { __mock: any; __store: any }

async function setup(page: Page) {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?demo')
  await expect(page.getByTestId('chat-stream')).toBeVisible()
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  // Wait for the initial conversation landing before hovering; the subsequent scrolling must come from the stream.
  await expect
    .poll(() =>
      page.getByTestId('chat-stream').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(40)
}

async function staysOpen(page: Page, trigger: Locator, focus = false) {
  if (focus) {
    await page.mouse.move(0, 0)
    await trigger.focus()
  } else await trigger.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  const result = await trigger.evaluate(async (el) => {
    const { __mock: mock, __store: store } = window as unknown as MockWindow
    const sessionId = store.getState().focusedSessionId
    const anchor = el.parentElement!
    const tip = anchor.querySelector('[role="tooltip"]')!
    const stream = document.querySelector('[data-testid="chat-stream"]')!
    let scrolls = 0
    let interruptions = 0
    let anchorReplacements = 0
    const onScroll = () => scrolls++
    stream.addEventListener('scroll', onScroll)
    // A tooltip that closes and reopens between frames is still a regression.
    const observer = new MutationObserver(() => {
      if (!tip.isConnected || getComputedStyle(tip).visibility !== 'visible') interruptions++
    })
    observer.observe(anchor, { childList: true, subtree: true, attributes: true })
    try {
      for (let i = 1; i <= 50; i++) {
        mock.emit({
          type: 'message_delta',
          sessionId,
          role: 'assistant',
          text: `\n\nStreaming paragraph ${i}: the tooltip should stay open while this answer grows.\n`,
        })
        mock.emit({
          type: 'usage_update',
          sessionId,
          tokens: {
            inputTokens: i * 100,
            outputTokens: i * 30,
            cacheReadTokens: i * 90,
            cacheCreationTokens: i * 10,
          },
          request: { inputTokens: 100, cacheReadTokens: 90, cacheCreationTokens: 10 },
        })
        mock.emit({ type: 'context_update', sessionId, used: i * 220, window: 200_000, exactness: 'exact' })
        // Separate deliveries across paints so React and automatic follow scrolling actually run 50 times.
        for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame)
        if (!el.isConnected || el.parentElement !== anchor) anchorReplacements++
        if (!tip.isConnected) interruptions++
      }
      return { scrolls, interruptions, anchorReplacements, usage: store.getState().sessions[sessionId].usage }
    } finally {
      observer.disconnect()
      stream.removeEventListener('scroll', onScroll)
    }
  })
  expect(result.scrolls, 'streaming must exercise real conversation auto-scroll').toBeGreaterThan(0)
  expect(result.anchorReplacements, 'the trigger must remain mounted').toBe(0)
  expect(result.usage).toMatchObject({
    inputTokens: 5000,
    outputTokens: 1500,
    cacheReadTokens: 4500,
    cacheCreationTokens: 500,
  })
  expect(result.interruptions, 'the original tooltip and anchor must survive every streamed update').toBe(0)
  await expect(tip).toBeVisible()
  if (focus) await page.keyboard.press('Tab')
  else await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()
}

test('the focused header action tooltip survives streaming and dismisses on blur', async ({ page }) => {
  await setup(page)
  await staysOpen(page, page.getByTestId('restart-session'), true)
})

test('the gauge updates its usage and cache content in place while hovered and streaming', async ({
  page,
}) => {
  await page.clock.install()
  await setup(page)
  const gauge = page.getByTestId('usage-donut-claude')
  await gauge.hover()
  const tip = page.getByTestId('usage-donut-tip-claude')
  await expect(tip).toBeVisible()
  await page.evaluate(() => {
    const m = (window as unknown as MockWindow).__mock
    m.usageState.usage.windows = m.usageState.usage.windows.map((w: any) => ({ ...w, percent: 73 }))
    m.cacheStats.claude = {
      ...m.cacheStats.claude,
      windows: m.cacheStats.claude.windows.map((w: any) => ({
        ...w,
        inputTokens: 1000,
        cacheReadTokens: 9000,
        cacheCreationTokens: 0,
      })),
    }
  })
  // The production gauge polls every five minutes; advance that timer without reconnecting or replacing its tree.
  await page.clock.fastForward(5 * 60_000)
  await expect(gauge).toHaveAttribute('data-percent', '73')
  await expect(tip).toContainText('73% used')
  await expect(page.getByTestId('usage-donut-cache-claude')).toHaveText('Cache hit 90% · last 5 h')
  await staysOpen(page, gauge)
})

// All custom hover explanations use Tooltip, either directly at these call sites or through IconButton.
// ToolMark, goal/worktree/context/machine/background-task header badges use native title and are unaffected.
const surfaces = [
  'usage-donut-claude',
  'usage-donut-codex',
  'project-header-centralu',
  'mark-changed-centralu',
  'git-denied-centralu',
  'fold-summary-landing-site',
  'usage-machine-box',
  'usage-donut-box.claude',
  'usage-no-agent',
  'usage-window-weekly_all',
  'usage-cache-rebuilds',
  'update-line',
  'restart-session',
  'run-open',
  'project-fold-centralu',
] as const

for (const surface of surfaces) {
  test(`${surface} tooltip stays open during 50 streamed deltas and usage/cache updates`, async ({
    page,
  }) => {
    await setup(page)
    if (surface === 'git-denied-centralu') {
      await page.evaluate(() => {
        const store = (window as unknown as MockWindow).__store
        const projects = { ...store.getState().projects }
        const project = Object.values(projects).find((p: any) => p.name === 'centralu') as any
        projects[project.id] = { ...project, git: { ...project.git, denied: true } }
        store.setState({ projects })
      })
    }
    if (surface === 'fold-summary-landing-site') await page.getByTestId('project-fold-landing-site').click()
    if (surface.includes('box')) {
      await page.evaluate(() =>
        (window as unknown as MockWindow).__mock.machines.add({
          shell: 'posix',
          name: 'Box',
          sshTarget: 'me@box',
        }),
      )
      await expect(page.getByTestId('usage-donut-box.claude')).toBeVisible()
    }
    if (surface === 'usage-no-agent') {
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.detected = []
        m.setConnectionState('disconnected')
      })
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
    }
    if (surface.startsWith('usage-window') || surface === 'usage-cache-rebuilds') {
      await page.getByTestId('usage-donut-claude').click()
      await expect(page.getByTestId('usage-cache')).toBeVisible()
    }
    if (surface === 'update-line') {
      await page.evaluate(() =>
        (window as unknown as MockWindow).__mock.emit({
          type: 'update_status',
          status: {
            current: '0.1.0',
            latest: '0.2.0',
            newer: true,
            auto: false,
            phase: 'failed',
            error: 'Mock update failed',
          },
        }),
      )
    }
    const trigger =
      surface === 'usage-machine-box'
        ? page.getByTestId(surface).locator('span').first()
        : surface === 'usage-cache-rebuilds'
          ? page.getByTestId(surface).locator('span.underline')
          : page.getByTestId(surface)
    await staysOpen(page, trigger)
  })
}

test('scrolling the tooltip anchor ancestor still dismisses it', async ({ page }) => {
  await setup(page)
  await page.getByTestId('project-header-centralu').hover()
  await expect(page.getByTestId('project-tip-centralu')).toBeVisible()
  // Make the actual sidebar scrollable without moving the hovered row out from under the pointer.
  await page.getByTestId('project-header-centralu').evaluate((el) => {
    let scroller = el.parentElement!
    while (!['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement!
    const spacer = document.createElement('div')
    spacer.style.height = '2000px'
    spacer.style.flexShrink = '0'
    scroller.appendChild(spacer)
    scroller.scrollTop = 1
    if (scroller.scrollTop === 0) throw new Error('The tooltip ancestor must actually scroll')
  })
  await expect(page.getByTestId('project-tip-centralu')).toBeHidden()
})
