import { test, expect } from '@playwright/test'
import { setup, newSession, pickSetting } from './fixtures/control.js'
import { columnsThrough } from './fixtures/columns.js'
import { openSessionDialog } from './fixtures/new-session.js'

/**
 * The control loop's scenarios on settings and the session settings menu: send key, models, effort, presets and their tabs. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * A switch to turn off the spinning indicator (requested by the person, 2026-09-13).
 *
 * This is about power, not taste — a single ceaseless animation pins the screen to its maximum
 * refresh rate (measured: app CPU went from 7.0% to 2.9% while one session was working). Turning
 * it off does not remove the indicator, it stops it: a plain bright-gray layer remains, still
 * saying "this is currently working".
 */
/*
 * The send key (setting: Send with ⌘/Ctrl+Enter).
 *
 * The pure decision logic lives in composerKeys.test.ts; what is checked here is whether that
 * decision **actually reaches the real composer**. There are two things a unit-level value
 * cannot tell: whether a plain Enter, once the setting is on, really inserts a newline (the
 * textarea only does that if nothing intercepts it), and whether the setting arrives before the
 * screen renders.
 */
test('Send key: with the default setting, Enter sends', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first instruction')

  // This is the composer for someone who has never opened settings — any change here is a regression
  const input = page.getByTestId('prompt-input')
  await input.fill('just enter')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('msg-user').last()).toContainText('just enter')
})

test('Send key: once enabled, Enter inserts a newline and the modifier+Enter sends', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first instruction')

  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-send-with-mod-enter').check()
  await page.keyboard.press('Escape')

  const input = page.getByTestId('prompt-input')
  await input.fill('line one')
  await input.press('Enter')
  // Only a line was added — nothing was sent
  await expect(input).toHaveValue('line one\n')
  await input.pressSequentially('line two')
  await expect(page.getByTestId('msg-user').filter({ hasText: 'line one' })).toHaveCount(0)

  // ⌘ (on Mac) and Ctrl (elsewhere) are treated as one decision, so both send — the UI does not
  // know which platform it is on
  await input.press('Meta+Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('msg-user').last()).toContainText('line two')

  await input.fill('with ctrl too')
  await input.press('Control+Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('msg-user').last()).toContainText('with ctrl too')

  // Reloading keeps the chosen value — if the setting were not remembered, this feature would
  // have to be re-enabled every time
  await page.reload()
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  await page.getByTestId('settings-tab-appearance').click()
  await expect(page.getByTestId('settings-send-with-mod-enter')).toBeChecked()
})

/*
 * The sessions' read-only tools (#320) are always on (owner, 2026-10-20): the switch is gone from Settings and the host
 * holds the preference true, so nothing a person does can turn them off.
 */
test("Settings: the sessions' read-only tools have no switch and read as on", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
  for (const tab of ['orchestrator', 'agents']) {
    await page.getByTestId(`settings-tab-${tab}`).click()
    await expect(page.getByTestId(`settings-tab-${tab}`)).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('settings-session-tools')).toHaveCount(0)
  }
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().prefs.sessionTools)).toBe(true)
})

// #1273: a linked computer's auto session starts agents here under auto unless the person turns it off
test('Settings: auto from a linked computer starts on, and turning it off is remembered', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const open = async () => {
    await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
    await page.getByTestId('settings-tab-agents').click()
  }
  await open()
  await expect(page.getByTestId('settings-hub-auto')).toBeChecked()
  await page.getByTestId('settings-hub-auto').uncheck()
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().prefs.hubAuto)).toBe(false)

  await page.reload()
  await open()
  await expect(page.getByTestId('settings-hub-auto')).not.toBeChecked()
})

// #1376: Centralu sets when agents compact, at 60% of the model's window, unless the person turns its control off
test("Settings: when agents compact starts on at 60%, moves in steps of 5, and turning Centralu's control off hides the share", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const open = async () => {
    await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
    await page.getByTestId('settings-tab-agents').click()
  }
  const saved = () => page.evaluate(() => (window as any).__store.getState().prefs.autoCompact ?? null)
  await open()
  await expect(page.getByTestId('settings-auto-compact')).toBeChecked()
  const share = page.getByTestId('settings-auto-compact-share')
  await expect(share).toHaveValue('60')
  await expect(page.getByTestId('settings-auto-compact-share-value')).toHaveText('60% of the window')
  await share.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(saved).toEqual({ controlled: true, share: 0.65 })

  await page.getByTestId('settings-auto-compact').uncheck()
  await expect.poll(saved).toEqual({ controlled: false, share: 0.65 })
  await expect(share).toHaveCount(0)

  await page.reload()
  await open()
  await expect(page.getByTestId('settings-auto-compact')).not.toBeChecked()
  await page.getByTestId('settings-auto-compact').check()
  await expect(share).toHaveValue('65')
})

test('Settings: running agents per project supports preset defaults and a remembered ceiling', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const open = async () => {
    await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
    await page.getByTestId('settings-tab-agents').click()
  }
  await open()
  const input = page.getByTestId('settings-agent-ceiling')
  await expect(input).toHaveValue('')
  await expect(page.getByText('Leave empty for the preset default:', { exact: false })).toBeVisible()
  await input.fill('8')
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().prefs.agentCeiling)).toBe(8)
  await page.reload()
  await open()
  await expect(input).toHaveValue('8')
  await input.fill('0')
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().prefs.agentCeiling)).toBe(0)
  await input.fill('')
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().prefs.agentCeiling)).toBe(null)
})

test('Settings: how deep agents may start agents is a slider from 1 to 3, starting at 1 and remembered (#867)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const open = async () => {
    await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
    await page.getByTestId('settings-tab-agents').click()
  }
  const saved = () => page.evaluate(() => (window as any).__store.getState().prefs.agentDepth ?? null)
  await open()
  const slider = page.getByRole('slider', { name: 'How deep agents may start agents' })
  const shown = page.getByTestId('settings-agent-depth-value')
  // Nothing saved reads as 1
  await expect(slider).toHaveValue('1')
  await expect(shown).toHaveText('1')
  await expect(page.getByText('At 1, only the sessions you start can start agents', { exact: false })).toBeVisible()
  // By the keyboard, as a person moves it: it stops at 3
  await slider.focus()
  for (const [key, value] of [['ArrowRight', 2], ['ArrowRight', 3], ['ArrowRight', 3]] as const) {
    await page.keyboard.press(key)
    await expect.poll(saved).toBe(value)
    await expect(shown).toHaveText(String(value))
  }
  await page.reload()
  await open()
  await expect(slider).toHaveValue('3')
  await expect(shown).toHaveText('3')
  await slider.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(saved).toBe(1)
  await expect(shown).toHaveText('1')
})

test('Settings: a model and effort per tool and difficulty for the agents a session starts (#729)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const open = async () => {
    await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
    await page.getByTestId('settings-tab-agents').click()
  }
  const chosen = () => page.evaluate(() => (window as any).__store.getState().prefs.agentModels ?? null)
  await open()
  const heavy = page.getByTestId('settings-agent-model-codex-heavy')
  await expect(heavy).toHaveValue('')
  // The effort belongs to a model: none until one is chosen
  await expect(page.getByTestId('settings-agent-model-codex-heavy-effort')).toHaveCount(0)
  await heavy.selectOption('gpt-5.6-terra')
  await expect.poll(chosen).toEqual({ codex: { heavy: { model: 'gpt-5.6-terra' } } })
  await page.getByTestId('settings-agent-model-codex-heavy-effort').selectOption('high')
  await expect.poll(chosen).toEqual({ codex: { heavy: { model: 'gpt-5.6-terra', effort: 'high' } } })

  // A model the list does not show (Claude lists its models only while a session runs): typed under Other…
  await page.getByTestId('settings-agent-model-claude-light').selectOption({ label: 'Other…' })
  await page.getByTestId('settings-agent-model-claude-light-other').fill('opus-next')
  await page.getByTestId('settings-agent-model-claude-light-other').press('Enter')
  await expect.poll(chosen).toEqual({ codex: { heavy: { model: 'gpt-5.6-terra', effort: 'high' } }, claude: { light: { model: 'opus-next' } } })
  // A typed model is offered every effort the tool's listed models have
  await page.getByTestId('settings-agent-model-claude-light-effort').selectOption('max')
  await expect.poll(chosen).toEqual({ codex: { heavy: { model: 'gpt-5.6-terra', effort: 'high' } }, claude: { light: { model: 'opus-next', effort: 'max' } } })
  // Other… left empty goes back to the select as it was
  const standard = page.getByTestId('settings-agent-model-claude-standard')
  await standard.selectOption({ label: 'Other…' })
  await page.getByTestId('settings-agent-model-claude-standard-other').blur()
  await expect(page.getByTestId('settings-agent-model-claude-standard-other')).toHaveCount(0)
  await expect(standard).toHaveValue('')
  // One width per column, whatever the model's name or whether a list arrived
  const widths = await page.locator('[data-testid^="settings-agent-model-"]:not([data-testid$="-effort"]):not([data-testid$="-other"])').evaluateAll((els) => [...new Set(els.filter((e) => e.tagName === 'SELECT').map((e) => e.getBoundingClientRect().width))])
  expect(widths).toHaveLength(1)

  await page.reload()
  await open()
  await expect(heavy).toHaveValue('gpt-5.6-terra')
  await expect(page.getByTestId('settings-agent-model-codex-heavy-effort')).toHaveValue('high')
  await expect(page.getByTestId('settings-agent-model-claude-light')).toHaveValue('opus-next')
  await expect(page.getByTestId('settings-agent-model-claude-light-effort')).toHaveValue('max')
  // A new model drops the old one's effort; Default removes the choice
  await heavy.selectOption('gpt-5.6-terra-mini')
  await expect.poll(chosen).toEqual({ codex: { heavy: { model: 'gpt-5.6-terra-mini' } }, claude: { light: { model: 'opus-next', effort: 'max' } } })
  await heavy.selectOption('')
  await expect.poll(chosen).toEqual({ codex: {}, claude: { light: { model: 'opus-next', effort: 'max' } } })
})

/*
 * The relationship between text size (zoom) and vh (dogfooding finding: "when I bump up the text
 * size, the session's composer disappears"). vh is not affected by zoom, so zooming in made the
 * 100vh shell taller than the window and pushed the bottom (the composer) outside it. After
 * switching the shell to a chain of percentages, the composer stays inside the window at every
 * zoom level.
 */
test('Settings: the composer stays inside the window even at the maximum text size', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-4').click()
  await page.keyboard.press('Escape')

  /*
   * Asserting from a single measurement races the layout settling right after the scale is
   * applied — under the full suite's parallel load it intermittently read a few pixels over
   * (passed when run alone). Poll until it settles: the contract is "the composer is inside the
   * window once the layout has settled", not "from the very first frame".
   */
  const viewport = page.viewportSize()!
  const bottomEdge = async () => {
    const box = await page.getByTestId('prompt-input').boundingBox()
    return box ? box.y + box.height : Number.POSITIVE_INFINITY
  }
  await expect.poll(bottomEdge).toBeLessThanOrEqual(viewport.height + 1)
  // Reverting stays inside the window too — growing and shrinking never loses its place
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-scale-0').click()
  await page.keyboard.press('Escape')
  await expect.poll(bottomEdge).toBeLessThanOrEqual(viewport.height + 1)
})

/*
 * The grid's column count is not affected by the text scale (dogfooding finding: "it is one row
 * at scale 3 but two rows at scale 4"). ResizeObserver measurements are in zoom coordinates, so
 * without converting to real pixels, the same window measures narrower as the scale goes up and
 * columns collapse. A window width of 1100 (860 for the grid after subtracting the 240 sidebar)
 * is exactly the width where the bug shows up: two panels (MIN_PANEL_W=380) fit at scale 1, but
 * using the raw zoom coordinate collapses them at 1.25 (860/1.25=688 < 760).
 */
test("Settings: changing the text size does not change the grid's column count", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'one')
  await newSession(page, 'alpha', 'two')
  await page.evaluate(() => {
    const store = (window as never as { __store: any }).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId })))
  })
  await page.getByTestId('grid-button').click()

  // The column count lives on the inner display:grid element — the outer element
  // (data-testid="grid") is a flex container
  const colsOf = () =>
    page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector<HTMLElement>('[data-testid="grid"] div.grid')!,
        ).gridTemplateColumns.split(' ').length,
    )
  const before = await colsOf()
  expect(before).toBe(2)

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()
  await page.getByTestId('settings-tab-appearance').click()
  /*
   * Every column count the grid stands in while the scale changes (columnsThrough), so a collapse
   * that a later measurement undoes still counts. The change is over once the root carries the new
   * zoom (scale 4 is 1.25); columnsThrough then waits the two frames the grid's resize observer and
   * the render it asks for take.
   */
  const counts = await columnsThrough(page, '[data-testid="grid"] div.grid', async () => {
    await page.getByTestId('settings-scale-4').click()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--text-zoom'))).toBe('1.25')
  })

  expect(counts).toEqual([2])
  expect(await colsOf()).toBe(2)
})

test('Settings: viewing and deleting approval rules (E-4)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.rulesList = [
      { id: 1, scope: 'session', matcher: 'npm test*', decision: 'allow', createdAt: Date.now() },
    ]
  })
  await newSession(page, 'alpha', 'task')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('settings')
  await page.getByTestId('palette-item-action').click()

  // Rules now live under the Permissions tab — settings are not all stacked into one long scroll (issue #7)
  await page.getByTestId('settings-tab-permissions').click()
  await expect(page.getByTestId('rules-list')).toContainText('npm test*')
  await page.getByTestId('delete-rule-1').click()
  await expect(page.getByTestId('rules-empty')).toBeVisible()
})

/** The same rule from two different projects does not look like an identical row — each row states its owner (#183) */
test('Settings: an approval rule row shows which project or session it belongs to (#183)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  await newSession(page, 'alpha', 'task')
  await page.evaluate(() => {
    const st = (window as any).__store.getState()
    const id = (name: string) =>
      Object.values(st.projects as Record<string, any>).find((p) => p.name === name)!.id
    ;(window as any).__mock.rulesList = [
      {
        id: 1,
        scope: 'project',
        matcher: 'pnpm test',
        decision: 'allow',
        createdAt: 1,
        projectId: id('alpha'),
        sessionId: null,
      },
      {
        id: 2,
        scope: 'project',
        matcher: 'pnpm test',
        decision: 'allow',
        createdAt: 2,
        projectId: id('beta'),
        sessionId: null,
      },
      {
        id: 3,
        scope: 'session',
        matcher: 'git push',
        decision: 'allow',
        createdAt: 3,
        projectId: null,
        sessionId: st.focusedSessionId,
      },
    ]
    st.toggleSettings(true)
  })
  await page.getByTestId('settings-tab-permissions').click()

  await expect(page.getByTestId('rule-owner-1')).toHaveText('alpha')
  await expect(page.getByTestId('rule-owner-2')).toHaveText('beta')
  await expect(page.getByTestId('rule-owner-3')).toHaveText('task')
})

test('Settings: turning off a notification policy is persisted (E-5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))

  await page.getByTestId('notify-done').uncheck()
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.notifyPolicy?.done).toBe(false)

  // "Error" and "Once when every session finishes" are gone (owner, 2026-10-20): the page has no switch for either
  await expect(page.getByTestId('notify-error')).toHaveCount(0)
  await expect(page.getByTestId('notify-allDone')).toHaveCount(0)

  // The shortcuts table is also checked here (FR-17) — it lives in the command palette since 2026-10-20
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('keyboard shortcuts')
  await page.getByTestId('palette-item-action').click()
  await expect(page.getByTestId('shortcut-list')).toContainText('⌘⇧1~4')
})

/**
 * The model list used to be hardcoded, so when Fable was released it could not be selected.
 * Now the list comes straight from the tool's official API, and effort levels arrive attached to
 * each model.
 */
// #1376: a session whose model's window Centralu has not read says that the agent's own setting decides for now
test("The session's settings say when Centralu has not read the model's window to set where the agent compacts, and say nothing when its control is off", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('settings-open').click()
  const note = page.getByTestId('settings-auto-compact-note')
  await expect(note).toContainText("has not read this model's window yet")

  // A machine from before the setting says "Unknown method"; any other failure is its own words, not that
  const fail = (message: string) =>
    page.evaluate((m) => {
      ;(window as any).__store.getState().platform.agents.autoCompact = async () => {
        throw new Error(m)
      }
    }, message)
  await page.keyboard.press('Escape')
  await fail('Unknown method: agents.autoCompact. This Centralu host does not have it.')
  await page.getByTestId('settings-open').click()
  await expect(note).toContainText('predates the Auto compact setting')
  await page.keyboard.press('Escape')
  await fail('connection lost')
  await page.getByTestId('settings-open').click()
  await expect(note).toContainText('Could not read where this session compacts (connection lost)')
  await expect(note).not.toContainText('predates')

  // Turned off in Settings: Centralu says nothing about it here
  await page.evaluate(() => (window as any).__store.getState().setPrefs({ autoCompact: { controlled: false } }))
  await expect(note).toHaveCount(0)
})

test('The model list comes from what the tool reports, and effort only appears for models that support it', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const menu = page.getByTestId('settings-menu')

  // Not a list we wrote — the list the host provides
  await page.getByTestId('settings-open').click()
  await expect(menu).toContainText('Fable')

  /*
    Picking a model leaves the menu open (a dogfooding request) — the effort/speed group changes
    to match the chosen model, so someone who just picked a model is usually not done yet. It
    used to take a re-opening click after every single row — that dance was itself the evidence
    of the friction.
  */
  // A model that does not support effort has no effort group — showing a control with no effect
  // would be a lie
  await menu.getByTestId('settings-model-haiku').click()
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('Effort')

  await menu.getByTestId('settings-model-fable').click()
  await expect(menu).toContainText('Effort')
  await menu.getByTestId('settings-effort-xhigh').click()
  // The menu never closes on selection (2026-09-06) — the only ways to close it are an outside
  // click, Esc, or the toggle
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  const settings = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId]
  })
  expect(settings.model).toBe('fable')
  expect(settings.effort).toBe('xhigh')
})

/**
 * Response speed (codex's service_tier — measured: gpt-5.4+ offers exactly one, "Fast, 1.5x
 * speed"). The group only appears for models that offer a tier, and switching to a model with no
 * tier resets the value along with it.
 */
test('Speed (Fast) only appears for models that offer a tier, and the chosen value stays on the session', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Tier belongs to codex — create a codex session (the session menu has no way to switch tools)
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  const menu = page.getByTestId('settings-menu')
  // Picking a model leaves the menu open, so the Speed group appears right there
  await pickSetting(page, 'settings-model-gpt-5.6-terra')
  await expect(menu).toContainText('Speed')
  await menu.getByTestId('settings-tier-priority').click()

  const tier = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].serviceTier
  })
  expect(tier).toBe('priority')

  // Switching to a model with no tier removes the group and resets the value — an unsupported
  // combination must not linger silently
  await pickSetting(page, 'settings-model-gpt-5.6-terra-mini')
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('Speed')
  const tier2 = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].serviceTier
  })
  expect(tier2).toBeNull()
})

/** Switching models resets effort — the steps differ per model, so the old value must not persist */
test('Switching models resets the reasoning effort', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await pickSetting(page, 'settings-model-fable')
  await pickSetting(page, 'settings-effort-max')
  await pickSetting(page, 'settings-model-sonnet')

  // sonnet has no max — leaving it would silently keep an unsupported combination
  const effort = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.sessions[s.focusedSessionId].effort
  })
  expect(effort).toBeNull()
})

/*
 * Restarting the app made the settings look like they had been reset (issue #37).
 *
 * Persistence was fine from the start — the chosen value was intact in both the DB and the
 * host's list. What got reset was the screen: the startup path picked only the effort level off
 * the list and filled model and permission with their defaults, so the button under the composer
 * read "Default · Normal". So this checks **the text the button actually reads**, not the store
 * value.
 */
test('The chosen model and permission stay visible even after restarting the app', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await pickSetting(page, 'settings-model-fable')
  await pickSetting(page, 'settings-effort-high')
  await pickSetting(page, 'settings-preset-auto')
  await expect(page.getByTestId('settings-open')).toHaveText(/Fable · high · Auto/)

  /*
   * Equivalent to restarting the app: the host (mock) stays alive, and only the store receives
   * the list and rebuilds the session summary from scratch — this attach is the actual path a
   * restart runs through.
   */
  await page.evaluate(async () => {
    const w = window as any
    await w.__store.getState().attach(w.__mock)
  })

  await expect(page.getByTestId('settings-open')).toHaveText(/Fable · high · Auto/)
})

/**
 * The session menu has **no way to switch agents** (a dogfooding decision).
 *
 * Since the conversation cannot carry over, "switching" there meant the same thing as "starting
 * a new conversation", and creating a session already does that more honestly. This removes the
 * second door that did the same thing.
 */
test('The session settings menu cannot switch agents — creating a new one covers that', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  // Model and permission remain — those two can change while the conversation continues
  await expect(page.getByTestId('settings-menu')).toContainText('Permissions')
  await expect(page.getByTestId('settings-tool-codex')).toHaveCount(0)
  await expect(page.getByTestId('settings-menu')).not.toContainText('starts a fresh conversation')
})

/*
 * Settings are split into tabs (issue #7).
 *
 * Three groups used to be stacked into one long scroll. That reads fine at three, but settings
 * only ever grow, and by eight, finding what the person wants gets buried somewhere in the scroll. The
 * tabs are split by **what the person came looking for** — make it stop pinging me
 * (Notifications), undo that auto-allow from earlier (Permissions), how does the message box send
 * (Appearance). Only one tab is rendered at a time, so a tab not selected must not be on screen.
 */
test('Settings are split into tabs, and only one tab shows at a time', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('open-settings').click()

  // Opening it starts on Notifications — the most frequent reason to come here
  await expect(page.getByTestId('notify-approval')).toBeVisible()
  await expect(page.getByTestId('settings-send-with-mod-enter')).toBeHidden()

  await page.getByTestId('settings-tab-appearance').click()
  await expect(page.getByTestId('settings-send-with-mod-enter')).toBeVisible()
  // Other tabs are not collapsed, they are absent — staying invisible in the DOM would make this
  // decoration, not a tab
  await expect(page.getByTestId('notify-approval')).toBeHidden()

  await page.getByTestId('settings-tab-permissions').click()
  await expect(page.getByTestId('rules-empty')).toBeVisible()
  await expect(page.getByTestId('settings-send-with-mod-enter')).toBeHidden()
})

test('Settings opens directly from the top bar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // The shortcuts table lives inside here — it must not require already knowing a shortcut to open
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
})

/*
 * In a settings menu row, **the name must never get squeezed out by the description**
 * (dogfooding finding: "Normal" was invisible in the permission group). Because the hint is
 * shrink-0, the label shrank all the way to 0 in the narrow menu (w-56) — a row with the
 * description intact and the very name to pick gone. This directly measures whether the label
 * is clipped in all three rows.
 */
test('Permission preset names are never squeezed out by their descriptions', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first instruction')
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  for (const v of ['safe', 'normal', 'auto']) {
    const label = page.getByTestId(`settings-preset-${v}`).locator('span').nth(1)
    await expect(label, v).not.toBeEmpty()
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), `${v} label clipped`).toBe(true)
  }
})

/*
 * Checkboxes are drawn by us (dogfooding finding: when the window loses key focus, the check's
 * background color turned gray under the OS's hand — accent-color cannot override that inactive
 * paint). Chromium cannot reproduce macOS's inactive paint, so this instead checks whether the
 * cause — leaving the drawing to the OS — has been removed.
 */
test('Checkboxes do not use native rendering — active and inactive windows produce the same pixels', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('open-settings').click()
  const box = page.getByTestId('notify-approval')
  await expect(box).toBeVisible()
  expect(await box.evaluate((el) => getComputedStyle(el).appearance)).toBe('none')
  // Having taken over the drawing, the checkmark must be ours too — without it, "checked" would
  // be invisible
  expect(await box.evaluate((el) => getComputedStyle(el, '::after').borderRightWidth)).not.toBe('0px')
})

/**
 * The model list is **a tool's own vocabulary** (dogfooding, 2026-09-09: "this is a claude
 * session, but codex models are showing").
 *
 * Even briefly leaving another tool's list in place offers something the screen cannot actually
 * pick — 'sonnet' and 'gpt-5.6-terra' are not two names for the same slot, they are words absent
 * from each other's dictionary. While the new list is loading, being **empty** is correct.
 */
test("Switching sessions does not leave the previous tool's model list behind", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'claude session')
  const claudeId = await page.evaluate(
    () => (window as never as { __store: any }).__store.getState().focusedSessionId,
  )

  // Create a codex session and open its menu to populate the list
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('tool-option-codex').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu').getByTestId('settings-model-gpt-5.6-terra')).toBeVisible()
  await page.keyboard.press('Escape')

  /*
   * Hold the list **until the test releases it.** Creating a window using a delay lets that
   * window get swallowed by some other wait (a name changing), turning this into a test that
   * passes whether or not the fix exists — that actually happened at first. Holding it and
   * releasing it lets the test decide exactly when that window is.
   */
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __releaseModels?: () => void }
    const real = w.__mock.agents.models.bind(w.__mock.agents)
    w.__mock.agents.models = async (tool: string) => {
      await new Promise<void>((r) => {
        w.__releaseModels = r
      })
      return real(tool)
    }
  })

  await page.evaluate(
    (id: string) => (window as never as { __store: any }).__store.getState().focusSession(id),
    claudeId,
  )
  // Open only after the screen has switched to that session — otherwise this would still be
  // opening the codex session's menu
  await expect(page.getByTestId('session-name')).toHaveText('claude session')
  await page.getByTestId('settings-open').click()
  const menu = page.getByTestId('settings-menu')
  await expect(menu.getByTestId('settings-model-gpt-5.6-terra')).toHaveCount(0)

  // Once released, this tool's own list appears
  await page.evaluate(() => (window as never as { __releaseModels?: () => void }).__releaseModels?.())
  await expect(menu.getByTestId('settings-model-haiku')).toBeVisible()
})

/*
 * A pick-one row is a radio group (components/Segmented.tsx): Tab enters on the picked option and leaves the group
 * in one press, the arrows pick the next or previous option. Typed with page.keyboard from a click on the picked
 * option, the way a person reaches it, and asserted on what was picked and where the next key goes.
 */
test('Settings: a pick-one row moves with the arrow keys, and Tab leaves it in one press', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-appearance').click()
  const group = page.getByRole('radiogroup', { name: 'Line height' })
  const radios = group.getByRole('radio')
  const count = await radios.count()
  expect(count).toBeGreaterThan(2)
  const picked = await radios.evaluateAll((els) => els.findIndex((e) => e.getAttribute('aria-checked') === 'true'))
  expect(picked).toBeGreaterThanOrEqual(0)
  // Only the picked option takes Tab
  await expect(group.locator('[tabindex="0"]')).toHaveCount(1)
  await radios.nth(picked).click()

  const next = (picked + 1) % count
  await page.keyboard.press('ArrowRight')
  await expect(radios.nth(next)).toHaveAttribute('aria-checked', 'true')
  await expect(radios.nth(next)).toBeFocused()
  await expect(radios.nth(picked)).toHaveAttribute('aria-checked', 'false')

  await page.keyboard.press('ArrowLeft')
  await expect(radios.nth(picked)).toHaveAttribute('aria-checked', 'true')
  await expect(radios.nth(picked)).toBeFocused()

  await page.keyboard.press('End')
  await expect(radios.nth(count - 1)).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Home')
  await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true')

  // One Tab and the focus is past the whole group, not on its next option
  await page.keyboard.press('Tab')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="radiogroup"][aria-label="Line height"]'))).toBe(false)
})
