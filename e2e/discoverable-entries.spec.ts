import { expect, test, type Page } from '@playwright/test'

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

/*
 * Sessions start from the project's menu only (owner, 2026-10-18): the + on the project row, shown on hover, moved the
 * row's other marks as the pointer passed. The menu's one New session starts a session at once; the window that
 * chooses a tool, a past conversation or a worktree opens from the palette (below) or a worktree proposal.
 */
test("a project row carries no +, and its menu holds the one New session", async ({ page }) => {
  await demo(page)
  // Nothing on the row moves when the pointer arrives: the menu's button stands where it stood
  const actions = page.getByTestId('project-actions-centralu')
  await page.mouse.move(900, 500)
  const away = await actions.boundingBox()
  await page.getByTestId('project-header-centralu').hover()
  expect(await actions.boundingBox()).toEqual(away)
  await expect(page.getByTestId('project-new-session-centralu')).toHaveCount(0)
  await expect(page.getByTestId('project-new-session-landing-site')).toHaveCount(0)
  await expect(page.getByTestId('project-new-session-options-centralu')).toHaveCount(0)

  await page.getByTestId('project-menu-centralu').click()
  const menu = page.getByTestId('project-menu-open-centralu')
  await expect(menu.getByText('New session', { exact: true })).toHaveCount(1)
  await expect(page.getByTestId('new-session-with-centralu')).toHaveCount(0)
})

test("the menu's New session starts a session at once with the project's tool, model and effort, and the caret is in its message box (#543)", async ({ page }) => {
  await demo(page)
  // What the project remembers: Codex, its model and effort (the demo's default is Claude Code)
  await page.evaluate(() => {
    const s = (window as any).__store
    const p = s.getState().projects
    const id = Object.keys(p).find((k) => p[k].name === 'centralu')!
    s.setState({ projects: { ...p, [id]: { ...p[id], defaultTool: 'codex', defaultModels: { codex: { model: 'gpt-5.6-terra', effort: 'high' } } } } })
  })
  const before = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions).length)

  await newSessionFromMenu(page)

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
  await expect(page.getByTestId('msg-user').last()).toContainText('Fix the login bug')
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

/** The project menu's New session, as a person reaches it */
async function newSessionFromMenu(page: Page): Promise<void> {
  await page.getByTestId('project-menu-centralu').click()
  await page.getByTestId('new-session-centralu').click()
}

const sessionCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__store.getState().sessions).length)

test("New session falls back to the other tool when the project's is logged out, as the dialog does (#543)", async ({ page }) => {
  await demo(page)
  await logOut(page, ['claude'], 'claude')
  const before = await sessionCount(page)

  await newSessionFromMenu(page)

  await expect.poll(() => sessionCount(page)).toBe(before + 1)
  await expect(page.getByTestId('new-session-dialog')).toHaveCount(0)
  const made = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    return st.sessions[st.focusedSessionId]
  })
  expect(made.tool).toBe('codex')
  await expect(page.getByTestId('prompt-input')).toBeFocused()
})

test("New session opens the dialog instead when no tool can run, and the dialog says why (#543)", async ({ page }) => {
  await demo(page)
  await logOut(page, ['claude', 'codex'], 'claude')
  const before = await sessionCount(page)

  await newSessionFromMenu(page)

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
  await expect(page.getByTestId('palette-item-app')).toHaveText(/Ledger.*Other apps/)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pinned-app-_user/ledger')).toBeVisible()
})
