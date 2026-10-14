import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Entry points a person can see (#529). The task-cost baseline (docs/ux-metrics.md) found three
 * core tasks with no short path anyone could find without being told a key: starting a session took
 * three clicks behind a menu that only shows on hover, searching past conversations opened only by
 * ⌘K, and the palette did not list apps. These are the doors that answer them, and what each opens.
 */

async function demo(page: Page): Promise<void> {
  await page.goto('/?demo')
  await expect(page.getByTestId('session-name')).toHaveText('Finish the collapsed composer')
}

/** How visible an element is: its own opacity times every ancestor's */
const seen = (el: Locator) =>
  el.evaluate((node) => {
    let o = 1
    for (let at: Element | null = node; at; at = at.parentElement) o *= Number(getComputedStyle(at).opacity)
    return o
  })

test('the Search button opens the palette and says its key', async ({ page }) => {
  await demo(page)
  const search = page.getByTestId('search-button')
  await expect(search).toBeVisible()
  // The key is printed on the door itself, by this keyboard's name for it (the mock's is ⌘)
  await expect(search).toContainText('⌘K')
  await search.click()
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await expect(page.getByTestId('palette-input')).toHaveAttribute('placeholder', /apps/)
})

test("the project the person is in shows its +, others only on hover, and the chevron beside it opens that project's dialog", async ({ page }) => {
  await demo(page)
  const here = page.getByTestId('project-new-session-centralu')
  const options = page.getByTestId('project-new-session-options-centralu')
  const there = page.getByTestId('project-new-session-landing-site')
  // Opacity, not presence: the other project's + is still reachable by hover and Tab
  await page.mouse.move(900, 500)
  await expect.poll(() => seen(here)).toBe(1)
  await expect.poll(() => seen(options)).toBe(1)
  await expect.poll(() => seen(there)).toBe(0)

  await options.click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await expect(page.getByTestId('new-session-dialog')).toContainText('centralu')
})

test("the + starts a session at once with the project's tool, model and effort, and the caret is in its message box (#543)", async ({ page }) => {
  await demo(page)
  // What the project remembers: Codex, its model and effort (the demo's default is Claude Code)
  await page.evaluate(() => {
    const s = (window as any).__store
    const p = s.getState().projects
    const id = Object.keys(p).find((k) => p[k].name === 'centralu')!
    s.setState({ projects: { ...p, [id]: { ...p[id], defaultTool: 'codex', defaultModels: { codex: { model: 'gpt-5.6-terra', effort: 'high' } } } } })
  })
  const before = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions).length)

  await page.getByTestId('project-new-session-centralu').click()

  // No dialog in between: the session exists, is the open one, and carries the remembered settings
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__store.getState().sessions).length)).toBe(before + 1)
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0)
  const made = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    return st.sessions[st.focusedSessionId]
  })
  expect(made).toMatchObject({ tool: 'codex', model: 'gpt-5.6-terra', effort: 'high' })
  await expect(page.getByTestId('prompt-input')).toBeFocused()
  await page.keyboard.type('Fix the login bug')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('msg-user').last()).toHaveText('Fix the login bug')
})

/** Makes the named tools unusable (logged out) on the mock, and the project's remembered tool the first of them */
async function logOut(page: Page, tools: string[], remembered: string): Promise<void> {
  await page.evaluate(
    ([out, tool]) => {
      const mock = (window as any).__mock
      for (const t of mock.detected) if (out!.includes(t.name)) t.loggedIn = false
      const s = (window as any).__store
      const p = s.getState().projects
      const id = Object.keys(p).find((k) => p[k].name === 'centralu')!
      s.setState({ projects: { ...p, [id]: { ...p[id], defaultTool: tool } } })
    },
    [tools, remembered] as [string[], string],
  )
}

const sessionCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__store.getState().sessions).length)

test("the + falls back to the other tool when the project's is logged out, as the dialog does (#543)", async ({ page }) => {
  await demo(page)
  await logOut(page, ['claude'], 'claude')
  const before = await sessionCount(page)

  await page.getByTestId('project-new-session-centralu').click()

  await expect.poll(() => sessionCount(page)).toBe(before + 1)
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0)
  const made = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    return st.sessions[st.focusedSessionId]
  })
  expect(made.tool).toBe('codex')
  await expect(page.getByTestId('prompt-input')).toBeFocused()
})

test("the + opens the dialog instead when no tool can run, and the dialog says why (#543)", async ({ page }) => {
  await demo(page)
  await logOut(page, ['claude', 'codex'], 'claude')
  const before = await sessionCount(page)

  await page.getByTestId('project-new-session-centralu').click()

  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await expect(page.getByTestId('tool-blocked')).toContainText('needs a login')
  expect(await sessionCount(page)).toBe(before)
})

test("the palette's New session names the project it starts in and opens its dialog", async ({ page }) => {
  await demo(page)
  await page.getByTestId('search-button').click()
  await page.getByTestId('palette-input').fill('new session')
  const item = page.getByTestId('palette-item-action').filter({ hasText: 'New session' })
  await expect(item).toContainText('in centralu')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('new-session-dialog')).toContainText('centralu')
  // The dialog keeps the keyboard: Enter starts the session (its Start button holds the focus)
  await expect(page.getByTestId('create-session-confirm')).toBeFocused()
})

test('the palette lists apps by name, only once something is typed, and opens one', async ({ page }) => {
  await demo(page)
  await page.evaluate(() => {
    const mock = (window as any).__mock
    mock.setExternalApps([
      ...mock.externalAppList,
      {
        appId: 'ledger',
        projectId: null,
        dir: '/Users/you/.centralu/apps/ledger',
        name: 'Ledger',
        version: '0.1.0',
        description: null,
        home: 'home',
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
      },
    ])
  })
  await expect(page.getByTestId('app-row-_user/ledger')).toBeVisible()

  await page.getByTestId('search-button').click()
  await expect(page.getByTestId('palette-item-session').first()).toBeVisible()
  await expect(page.getByTestId('palette-item-app')).toHaveCount(0)
  await page.getByTestId('palette-input').fill('ledg')
  await expect(page.getByTestId('palette-item-app')).toHaveText(/Ledger.*Your apps/)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pinned-app-_user/ledger')).toBeVisible()
})
