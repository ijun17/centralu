import { test, expect } from '@playwright/test'
import { setup, newSession, emitEvent } from './fixtures/control.js'

/**
 * The control loop's scenarios on terminals, the context gauge and the usage screen. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('Context gauge and limit display (FR-14, FR-9)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')

  /*
   * A session where no turn has finished yet has **no value** — the tool reports once per
   * finished turn. "Unknown" and "0%" are different statements and must look different: drawing
   * 0% when there is no value would falsely claim "nothing has been used yet".
   */
  await expect(page.getByTestId('context-gauge')).toContainText('—')
  await emitEvent(page, 0, { type: 'context_update', used: 0, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('0%')

  await emitEvent(page, 0, { type: 'context_update', used: 168000, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('84%')

  await emitEvent(page, 0, { type: 'limit_reached', usedPercent: 21, windowMins: 10080 })
  await expect(page.getByTestId('limit-badge')).toContainText('21%')
})

/**
 * The context gauge was empty after a restart (issue #48).
 *
 * The read value was correct from the start — it simply was not persisted anywhere, so on
 * restart the gauge stayed empty until that session **ran another turn**. On screen it looked
 * like a broken gauge.
 *
 * Persisting it is the host's job, and the store/manager tests guard that side. What is guarded
 * here is the next step: does the value carried in the list **actually reach the screen**? #37
 * broke at exactly this step — attach picked only the effort level off the list and filled
 * everything else with defaults, so a value that was perfectly fine in the DB disappeared only
 * on screen. Persisting it and having nobody read it back is the same bug.
 */
test('The context gauge stays filled in after restarting the app (#48)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await emitEvent(page, 0, { type: 'context_update', used: 168000, window: 200000, exactness: 'exact' })
  await expect(page.getByTestId('context-gauge')).toContainText('84%')

  // Equivalent to restarting the app: the store receives the list and rebuilds the session
  // summary from scratch
  await page.evaluate(async () => {
    const w = window as any
    await w.__store.getState().attach(w.__mock)
  })

  await expect(page.getByTestId('context-gauge')).toContainText('84%')
  // No "this might be stale" marker is attached — the gauge never promised to reflect "right
  // now". The value is always from the last finished turn, and a restart only widens that gap.
  await expect(page.getByTestId('context-gauge')).toHaveText('Context 84%')
})

test('A terminal belongs to the project, so it persists across switching sessions', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first session')
  await newSession(page, 'alpha', 'second session')

  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  // Get the terminal into a state where it has output something
  const termId = await page.evaluate(() => {
    const m = (window as any).__mock
    const t = [...m.terminalState.byCwd.values()][0][0]
    m.emitTerminal(t.id, 'hello from alpha\r\n')
    return t.id
  })

  // Switching sessions still attaches to the same terminal (a running dev server must not die)
  const first = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])
  await page.getByTestId(`session-row-${first}`).click()
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  const sameTerminal = await page.evaluate(() => {
    const lists = [...(window as any).__mock.terminalState.byCwd.values()]
    return lists.length === 1 && lists[0].length === 1 && lists[0][0].id
  })
  expect(sameTerminal).toBe(termId)

  // Reattaching restores the output so far (an empty screen would not be a real terminal)
  await expect(page.getByTestId(`terminal-surface-${termId}`)).toContainText('hello from alpha')
})

test('Keyboard input goes to the shell', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  const id = await page.evaluate(() => [...(window as any).__mock.terminalState.byCwd.values()][0][0].id)
  await page.getByTestId(`terminal-surface-${id}`).click()
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')

  const sent = await page.evaluate(() =>
    (window as any).__mock.terminalState.input.map((i: { data: string }) => i.data).join(''),
  )
  expect(sent).toContain('ls')
  expect(sent).toContain('\r')
})

test('Opening and closing multiple terminals (stacked vertically)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-terminal').click()

  // One already exists when first opened — an empty screen with just a button would add an extra step
  await expect(page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')).toHaveCount(
    1,
  )

  await page.getByTestId('terminal-add').click()
  await page.getByTestId('terminal-add').click()
  const surfaces = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-surface-"]')
  await expect(surfaces).toHaveCount(3)

  // Stacked vertically (not horizontally)
  const first = (await surfaces.nth(0).boundingBox())!
  const second = (await surfaces.nth(1).boundingBox())!
  expect(second.y).toBeGreaterThan(first.y)
  expect(Math.abs(second.x - first.x)).toBeLessThan(2)

  // Closing the middle one renumbers the rest
  const ids = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { id: string }) => t.id),
  )
  await page.getByTestId(`terminal-close-${ids[1]}`).click()
  await expect(surfaces).toHaveCount(2)
  const titles = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { title: string }) => t.title),
  )
  expect(titles).toEqual(['Terminal 1', 'Terminal 2'])
})

/**
 * Closing a terminal makes the remaining ones grow taller. When that happens, they must **not be
 * recreated** — a freshly created xterm starts at a default size before immediately being
 * resized to fit, and that resize redraws the shell's prompt, which can look like extra lines
 * appeared.
 */
test('Closing one terminal does not recreate the remaining ones', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-terminal').click()
  await page.getByTestId('terminal-add').click()

  const ids = await page.evaluate(() =>
    [...(window as any).__mock.terminalState.byCwd.values()][0].map((t: { id: string }) => t.id),
  )
  await expect(page.getByTestId(`terminal-surface-${ids[0]}`)).toBeVisible()

  // Give the surviving terminal some output — re-reading the list after closing one changes this
  // terminal's history snapshot, and that was the condition that triggered recreation
  await page.evaluate((id) => (window as any).__mock.emitTerminal(id, 'dev server running\r\n'), ids[0])

  // Leave a marker on the actual DOM of the surviving terminal
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="terminal-surface-${id}"] .xterm`) as HTMLElement & {
      __kept?: boolean
    }
    el.__kept = true
  }, ids[0])

  await page.getByTestId(`terminal-close-${ids[1]}`).click()
  await expect(page.getByTestId(`terminal-surface-${ids[1]}`)).toHaveCount(0)

  // If the same DOM node is still there, it was never recreated
  const kept = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="terminal-surface-${id}"] .xterm`) as
      (HTMLElement & { __kept?: boolean }) | null
    return el?.__kept === true
  }, ids[0])
  expect(kept).toBe(true)
})

/** Usage (FR-9) — covers subscription limits only */
test('Usage modal: a donut per window, and hovering shows the reset time', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: [
          {
            id: 'session',
            label: '5 hours',
            percent: 8,
            resetsAt: new Date(Date.now() + 7_800_000).toISOString(),
            scope: null,
          },
          {
            id: 'weekly_all',
            label: 'Weekly',
            percent: 93,
            resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
            scope: null,
          },
        ],
        daily: [],
      },
    }
  })

  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-plan')).toContainText('max')
  await expect(page.getByTestId('usage-window-session')).toContainText('8%')
  await expect(page.getByTestId('usage-window-weekly_all')).toContainText('93%')

  // Details are answered only when asked
  await page.getByTestId('usage-window-weekly_all').hover()
  await expect(page.getByTestId('usage-tip-weekly_all')).toContainText('reset')
  /*
   * And it is **not clipped** (dogfooding finding: because the donut sits near the bottom of the
   * modal's scroll box, an absolutely positioned tooltip looked cut off at the bottom). This
   * checks both whether the cause of the clipping — absolute positioning inside a scroll box —
   * has been removed (same idiom as the checkbox test: Chromium's rect stays the same even when
   * clipped, so this measures the cause rather than the symptom), and whether it fits entirely
   * within the window.
   */
  const tip = page.getByTestId('usage-tip-weekly_all')
  expect(await tip.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
  const tb = (await tip.boundingBox())!
  expect(tb.y + tb.height).toBeLessThanOrEqual(page.viewportSize()!.height)

  // A tool that cannot provide daily data collapses that row (Claude has no daily window)
  await expect(page.getByTestId('usage-daily')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('usage-drop')).toBeHidden()
})

test('A tool that provides daily tokens shows them alongside', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'pro',
        windows: [{ id: 'primary', label: '1 week', percent: 22, resetsAt: null, scope: null }],
        daily: [
          { date: '2026-08-15', tokens: 115640 },
          { date: '2026-08-16', tokens: 9005155 },
        ],
      },
    }
  })
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-daily')).toContainText('Today 9M')
})

test('When usage cannot be read, the reason is stated (never left as a blank screen)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Focus the project so Usage resolves its tool honestly (project defaultTool),
  // instead of leaning on the hardcoded 'claude' fallback #26 removes. These three
  // passed on that fallback alone — adding a project never set focusedProjectId.
  await page.getByTestId('project-header-alpha').click()
  await page.evaluate(() => {
    ;(window as any).__mock.usageState = {
      supported: false,
      reason: 'The installed Claude Code SDK does not support usage queries',
      usage: null,
    }
  })
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-unavailable')).toContainText('does not support usage queries')
})

/*
 * GUI slash commands (2026-09-07): `/usage` is a client-side command with no reply in the SDK
 * protocol — pressing Enter opens an app screen instead of sending a message. Recognizing it is
 * our own registry's job (the SDK has no concept of a "client command"), and the interception
 * happens before it ever reaches the adapter, so it is tool-agnostic.
 */
test('Pressing Enter on /usage opens the usage screen instead of sending it — with an argument it becomes a message', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // It appears in autocomplete alongside session commands — the hint states its origin
  await page.getByTestId('prompt-input').fill('/usa')
  await expect(page.getByTestId('autocomplete')).toContainText('/usage')
  await expect(page.getByTestId('autocomplete')).toContainText('opens in app')

  const userCount = (sid: string) =>
    ((window as any).__store.getState().chat[sid] ?? []).filter((i: any) => i.kind === 'user').length
  const before = await page.evaluate(userCount, id)

  await page.getByTestId('prompt-input').fill('/usage')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('usage-drop')).toBeVisible()
  // No message was sent, and the composer is empty
  expect(await page.evaluate(userCount, id)).toBe(before)
  await expect(page.getByTestId('prompt-input')).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('usage-drop')).toBeHidden()

  // Anything following the name means it is talking to the session — it goes out as an ordinary message
  await page.getByTestId('prompt-input').fill('/usage summarize last week')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('usage-drop')).toBeHidden()
  await expect.poll(() => page.evaluate(userCount, id)).toBe(before + 1)

  // /model's CLI screen already exists here — it opens this session's settings menu
  await page.getByTestId('prompt-input').fill('/model')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  expect(await page.evaluate(userCount, id)).toBe(before + 1)
})
