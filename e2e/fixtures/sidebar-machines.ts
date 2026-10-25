import { expect, test, type Locator, type Page } from '@playwright/test'
import { newSession, setup as setupProjects } from './control.js'

/**
 * The sidebar's one list across machines (#734): a linked machine's projects stand among this computer's, in one order
 * the person sets by dragging, each with its machine's badge; there are no machine headers. On the mock platform, which
 * is told about machines; the order kept on the hub across a reload is asked of two real hosts in
 * `linked-hosts-ui-scenarios.ts`. A function, because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 */

type MockWindow = { __mock: any; __store: any }

/** This computer with two projects, alpha and beta, added through "Add a folder as a project" before any machine is linked */
async function setup(page: Page): Promise<void> {
  await setupProjects(page, { projects: ['/tmp/alpha', '/tmp/beta'] })
  // No machine linked: Add project is the folder picker at once, with nothing to choose
  await expect(page.getByTestId('add-project-machines')).toHaveCount(0)
}

/** Links a mock machine: it stands as connected at once and its `machine_status` reaches the store */
async function link(page: Page, name: string): Promise<string> {
  const id = await page.evaluate(
    async (n) => ((await (window as unknown as MockWindow).__mock.machines.add({ name: n, sshTarget: `me@${n.toLowerCase()}`, shell: 'posix' })) as { id: string }).id,
    name,
  )
  await expect.poll(() => page.evaluate((i) => (window as unknown as MockWindow).__store.getState().machines[i]?.status, id)).toBe('connected')
  return id
}

/** Moves a mock machine's link to another state, as the hub's `machine_status` does */
async function setMachine(page: Page, id: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(([i, p]) => (window as unknown as MockWindow).__mock.machineRow(i, p), [id, patch] as const)
}

/** A folder on a linked machine as a project, the way the person adds one: Add project, the machine, its path */
async function addOn(page: Page, machine: string, path: string): Promise<void> {
  await page.getByTestId('add-project').click()
  await page.getByTestId(`add-project-on-${machine}`).click()
  await expect(page.getByTestId('add-project-machines')).toHaveCount(0)
  await page.getByTestId('add-remote-project-path').fill(path)
  await page.getByTestId('add-remote-project-confirm').click()
  await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
}

/** The sidebar's projects, top to bottom, as on screen */
const listed = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sidebar"] section[data-testid^="project-"]')].map((el) => el.getAttribute('data-testid')!.slice('project-'.length)),
  )

const border = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).borderTopStyle)

/** A centre on screen, to hold a badge to its row's line (#705) */
const midY = (page: Page, testId: string, closest?: string) =>
  page.getByTestId(testId).evaluate((el, c) => {
    const line = c ? el.closest(c)! : el
    const r = line.getBoundingClientRect()
    return r.top + r.height / 2
  }, closest)

/** The computed opacity of an element, and of every ancestor of it up to the root: what an element is drawn at is their product */
const opacities = (loc: Locator) =>
  loc.evaluate((el) => {
    const out: number[] = []
    for (let n: Element | null = el; n; n = n.parentElement) out.push(Number(getComputedStyle(n).opacity))
    return out
  })
const opacity = async (loc: Locator) => (await opacities(loc))[0]!

const NOTES = {
  appId: 'notes',
  projectId: null,
  machine: 'box',
  dir: '/home/me/.centralu/apps/notes',
  name: 'Notes',
  version: '0.1.0',
  description: null,
  home: 'home',
  trusted: true,
  status: 'stopped',
  error: null,
  warnings: [],
}

export function sidebarMachinesTests(): void {
  test.describe('one project list across machines (#734)', () => {
    test("a linked machine's projects join the one list with its badge, and no machine header stands anywhere", async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/api')
      await expect(page.getByTestId('project-api')).toBeVisible()
      // One list: this computer's and the machine's, the new one at the end, under no heading
      expect(await listed(page)).toEqual(['alpha', 'beta', 'api'])
      await expect(page.locator('[data-testid^="machine-header-"]')).toHaveCount(0)
      await expect(page.locator('[data-testid^="machine-group-"]')).toHaveCount(0)
      await expect(page.getByTestId('sidebar')).not.toContainText(/this computer/i)
      // The badge names the machine, right of the project's name, on the name's line; this computer's carry none
      const badge = page.getByTestId('project-machine-api')
      await expect(badge).toHaveText('Box')
      expect((await badge.boundingBox())!.x).toBeGreaterThan((await page.getByTestId('project-header-api').boundingBox())!.x)
      expect(Math.abs((await midY(page, 'project-machine-api')) - (await midY(page, 'project-header-api', 'header')))).toBeLessThanOrEqual(1)
      await expect(page.getByTestId('project-machine-alpha')).toHaveCount(0)
      await expect(page.getByTestId('project-machine-beta')).toHaveCount(0)
    })

    test('a short remote name is shown whole beside its badge at the default width; only a name too long for the line is cut', async ({ page }) => {
      await setup(page)
      await link(page, 'Laptop')
      await setMachine(page, 'laptop', { status: 'unreachable' })
      await page.evaluate(async () => {
        const w = window as unknown as MockWindow
        await w.__mock.projects.add('/home/me/notes-site', 'laptop')
        await w.__mock.projects.add('/home/me/a-project-name-far-too-long-for-one-sidebar-line', 'laptop')
        await w.__store.getState().refreshProjects()
      })
      const cut = (name: string) => page.getByTestId(`project-header-${name}`).evaluate((el) => el.scrollWidth > el.clientWidth)
      await expect(page.getByTestId('project-machine-notes-site')).toBeVisible()
      // The sidebar at its default width, the pointer elsewhere: the hidden hover buttons take no room from the name
      await page.mouse.move(900, 450)
      expect(await cut('notes-site')).toBe(false)
      expect(await cut('a-project-name-far-too-long-for-one-sidebar-line')).toBe(true)
      // The badge still stands right after the name
      const name = (await page.getByTestId('project-header-notes-site').boundingBox())!
      const badge = (await page.getByTestId('project-machine-notes-site').boundingBox())!
      expect(badge.x).toBeGreaterThanOrEqual(name.x + name.width)
      expect(badge.x - (name.x + name.width)).toBeLessThanOrEqual(10)
    })

    test('the badge is solid while its machine is connected and dashed while it is not, with the link’s error as its tooltip', async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/api')
      const badge = page.getByTestId('project-machine-api')
      await expect(badge).toHaveAttribute('data-status', 'connected')
      expect(await border(page, 'project-machine-api')).toBe('solid')
      await expect(badge).toHaveAttribute('title', 'Box — me@box')
      await expect(page.getByTestId('project-api')).not.toHaveAttribute('data-away', 'true')

      await setMachine(page, 'box', { status: 'unreachable', error: 'ssh: connect to host box port 22: Operation timed out' })
      await expect(badge).toHaveAttribute('data-status', 'unreachable')
      expect(await border(page, 'project-machine-api')).toBe('dashed')
      // The state is said on the badge itself, not by its border alone: a dot before the name, and the tooltip
      await expect(badge).toHaveAttribute('title', 'Box is not connected — ssh: connect to host box port 22: Operation timed out')
      await expect(badge.locator('span[aria-hidden]')).toHaveCount(1)
      // The row keeps its dimming for a machine that is away
      await expect(page.getByTestId('project-api')).toHaveAttribute('data-away', 'true')

      await setMachine(page, 'box', { status: 'connecting', error: null })
      expect(await border(page, 'project-machine-api')).toBe('dashed')
      await setMachine(page, 'box', { status: 'connected', error: null })
      await expect(badge).toHaveAttribute('data-status', 'connected')
      expect(await border(page, 'project-machine-api')).toBe('solid')
      await expect(badge.locator('span[aria-hidden]')).toHaveCount(0)
    })

    test("pressing the badge opens the machine's menu, and does not open the project; Machine settings leads on to Settings → Machines", async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/api')
      await page.getByTestId('project-machine-api').click()
      const menu = page.getByTestId('machine-menu-box')
      await expect(menu).toBeVisible()
      await expect(page.getByTestId('settings-machines')).toHaveCount(0)
      await expect(page.getByTestId('project-header-api')).not.toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('project-machine-api')).toHaveAttribute('aria-expanded', 'true')
      // A connected machine: its name and state, Disconnect and Machine settings; no error, no last-connected line
      await expect(menu).toContainText('Box')
      await expect(page.getByTestId('machine-menu-status-box')).toHaveAttribute('data-status', 'connected')
      await expect(page.getByTestId('machine-menu-disconnect-box')).toBeVisible()
      await expect(page.getByTestId('machine-menu-connect-box')).toHaveCount(0)
      await expect(page.getByTestId('machine-menu-error-box')).toHaveCount(0)
      await expect(menu).not.toContainText('Last connected')

      await page.getByTestId('machine-menu-settings-box').click()
      await expect(menu).toHaveCount(0)
      await expect(page.getByTestId('settings-machines')).toBeVisible()
      await expect(page.getByTestId('machine-row-box')).toBeVisible()
      await expect(page.getByTestId('project-header-api')).not.toHaveAttribute('aria-current', 'page')
    })

    test("the badge's menu says why a machine is not connected and brings it back: Disconnect, then Connect", async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/api')
      const badge = page.getByTestId('project-machine-api')
      const menu = page.getByTestId('machine-menu-box')

      // Disconnect from the menu: the menu closes, the badge goes dashed, and the project stays listed (dimmed)
      await badge.click()
      await page.getByTestId('machine-menu-disconnect-box').click()
      await expect(menu).toHaveCount(0)
      await expect(badge).toHaveAttribute('data-status', 'disconnected')
      expect(await border(page, 'project-machine-api')).toBe('dashed')

      // Not connected: the state, the link's last error, and when it last connected, with Connect in place of Disconnect
      await setMachine(page, 'box', { error: 'ssh: connect to host box port 22: Operation timed out', lastConnectedAt: Date.now() - 5 * 60_000 })
      await badge.click()
      await expect(menu).toBeVisible()
      await expect(page.getByTestId('machine-menu-status-box')).toHaveAttribute('data-status', 'disconnected')
      await expect(page.getByTestId('machine-menu-error-box')).toHaveText('ssh: connect to host box port 22: Operation timed out')
      await expect(menu).toContainText('Last connected')
      await expect(page.getByTestId('machine-menu-disconnect-box')).toHaveCount(0)
      await expect(page.getByTestId('machine-menu-connect-box')).toHaveText('Connect')
      await page.getByTestId('machine-menu-connect-box').click()
      await expect(menu).toHaveCount(0)
      await expect(badge).toHaveAttribute('data-status', 'connected')
      expect(await border(page, 'project-machine-api')).toBe('solid')

      // A machine that never connected since Centralu started says so; Escape puts the menu away
      await setMachine(page, 'box', { status: 'unreachable', error: null, lastConnectedAt: null })
      await badge.click()
      await expect(menu).toContainText('Has not connected since Centralu started')
      await expect(page.getByTestId('machine-menu-connect-box')).toHaveText('Reconnect')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })

    test("the menu of a project on a machine that is away is whole, not see-through, and so is its tooltip (#1531)", async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/api')
      await setMachine(page, 'box', { status: 'unreachable', error: 'ssh: connect to host box port 22: Operation timed out' })
      // The block is dimmed, as before: this is the case that made the menu inherit the dimming
      await expect(page.getByTestId('project-api')).toHaveAttribute('data-away', 'true')
      expect(await opacity(page.getByTestId('project-api'))).toBeLessThan(1)

      await page.getByTestId('project-menu-api').click()
      const menu = page.getByTestId('project-menu-open-api')
      await expect(menu).toBeVisible()
      // The menu and every ancestor of it are fully opaque: an ancestor's opacity multiplies into everything inside it
      expect((await opacities(menu)).every((o) => o === 1)).toBe(true)
      // Drawn into the body it still wears the sidebar's line colour, as it did inside it
      const line = (id: string) => page.getByTestId(id).evaluate((el) => getComputedStyle(el).getPropertyValue('--color-line').trim())
      expect(await line('project-menu-open-api')).toBe(await line('sidebar'))
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      await page.getByTestId('project-header-api').hover()
      const tip = page.getByTestId('project-tip-api')
      await expect(tip).toBeVisible()
      expect((await opacities(tip)).every((o) => o === 1)).toBe(true)
    })

    test("a project is dragged between two of another machine's: the one order goes to the hub with the machines' ids", async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/api')
      expect(await listed(page)).toEqual(['alpha', 'beta', 'api'])
      await page.dragAndDrop('[data-testid="project-header-api"]', '[data-testid="project-beta"]', { targetPosition: { x: 10, y: 2 } })
      await expect.poll(() => listed(page)).toEqual(['alpha', 'api', 'beta'])
      // The hub was given the whole order, the machine's project by its qualified id, where the person put it
      await expect
        .poll(() => page.evaluate(() => ((window as unknown as MockWindow).__mock.projectsList as { id: string; name: string }[]).map((p) => p.name)))
        .toEqual(['alpha', 'api', 'beta'])
      const ids = await page.evaluate(() => ((window as unknown as MockWindow).__mock.projectsList as { id: string }[]).map((p) => p.id))
      expect(ids[1]).toMatch(/^box\./)
      // And back to the end, below this computer's
      await page.dragAndDrop('[data-testid="project-header-api"]', '[data-testid="project-beta"]', { targetPosition: { x: 10, y: 30 } })
      await expect.poll(() => listed(page)).toEqual(['alpha', 'beta', 'api'])
    })

    test('Add project asks where once a machine is linked: this computer by default, a machine only while connected', async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await link(page, 'Laptop')
      await setMachine(page, 'laptop', { status: 'unreachable' })
      await expect(page.getByTestId('add-project')).toHaveAccessibleName('Add a folder as a project')
      await expect(page.getByTestId('add-project')).toHaveAttribute('aria-haspopup', 'menu')

      await page.getByTestId('add-project').click()
      const menu = page.getByTestId('add-project-machines')
      await expect(menu).toBeVisible()
      // This computer first, then each machine with its link's state; one that is not connected cannot be picked
      await expect(menu.getByRole('menuitem')).toHaveText(['This computer', /^Box\s*connected$/, /^Laptop\s*away$/])
      await expect(page.getByTestId('add-project-on-local')).toBeEnabled()
      await expect(page.getByTestId('add-project-on-box')).toBeEnabled()
      await expect(page.getByTestId('add-project-on-laptop')).toBeDisabled()
      await expect(page.getByTestId('add-project-on-laptop')).toHaveAttribute('title', 'Laptop is not connected')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      await test.step('this computer: the folder picker, as before', async () => {
        await page.evaluate(() => ((window as unknown as MockWindow).__mock.nextPickedDirectory = '/tmp/gamma'))
        await page.getByTestId('add-project').click()
        await page.getByTestId('add-project-on-local').click()
        await expect(page.getByTestId('project-gamma')).toBeVisible()
        await expect(page.getByTestId('project-machine-gamma')).toHaveCount(0)
      })

      await test.step('a linked machine: its path typed, the project added there with its badge', async () => {
        await page.getByTestId('add-project').click()
        await page.getByTestId('add-project-on-box').click()
        await expect(page.getByTestId('add-remote-project-dialog')).toContainText('Add a project · Box')
        await page.getByTestId('add-remote-project-path').fill('/home/me/api')
        await page.getByTestId('add-remote-project-confirm').click()
        await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
        await expect(page.getByTestId('project-machine-api')).toHaveText('Box')
        expect(await listed(page)).toEqual(['alpha', 'beta', 'gamma', 'api'])
      })
    })

    test("a linked machine's user-folder apps (an older build there, #1141) stand in Other apps with its badge, dimmed while it is away", async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await page.evaluate((notes) => {
        const mock = (window as unknown as MockWindow).__mock
        mock.setExternalApps([...mock.externalAppList, notes])
      }, NOTES)
      const row = page.getByTestId('user-apps').getByTestId('app-row-box:_user/notes')
      await expect(row).toBeVisible()
      const badge = page.getByTestId('app-machine-box:_user/notes')
      await expect(badge).toHaveText('Box')
      expect(await border(page, 'app-machine-box:_user/notes')).toBe('solid')
      expect(Math.abs((await midY(page, 'app-machine-box:_user/notes')) - (await midY(page, 'app-row-box:_user/notes')))).toBeLessThanOrEqual(1)
      await expect(page.locator('[data-testid^="machine-apps-"]')).toHaveCount(0)
      const item = page.getByTestId('user-apps').locator('li', { has: page.getByTestId('app-row-box:_user/notes') })
      await expect(item).toHaveCSS('opacity', '1')

      await setMachine(page, 'box', { status: 'unreachable' })
      expect(await border(page, 'app-machine-box:_user/notes')).toBe('dashed')
      await expect(item).toHaveCSS('opacity', '0.6')

      // Its badge, pressed, opens the machine's menu rather than the app; Machine settings leads on to Settings → Machines
      await page.getByTestId('app-machine-box:_user/notes').click()
      await expect(page.getByTestId('machine-menu-box')).toBeVisible()
      await expect(page.getByTestId('pinned-app-box:_user/notes')).toHaveCount(0)
      await page.getByTestId('machine-menu-settings-box').click()
      await expect(page.getByTestId('settings-machines')).toBeVisible()
      await expect(page.getByTestId('pinned-app-box:_user/notes')).toHaveCount(0)
    })

    test("a linked machine's app is not dimmed before its machine's row has arrived (the same rule as a project's)", async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await page.evaluate((notes) => {
        const mock = (window as unknown as MockWindow).__mock
        mock.setExternalApps([...mock.externalAppList, notes])
      }, NOTES)
      const item = page.getByTestId('user-apps').locator('li', { has: page.getByTestId('app-row-box:_user/notes') })
      await expect(item).toHaveCSS('opacity', '1')
      // A machine the store has no row for yet is judged by the row's own mark (`isAway`), not as away
      await page.evaluate(() => (window as unknown as MockWindow).__store.setState({ machines: {} }))
      await expect(item).toHaveCSS('opacity', '1')
    })

    test("the app row's badge is a button of its own beside the row's, reached by keyboard, standing right after the title", async ({ page, browserName }) => {
      await setup(page)
      await link(page, 'Box')
      await page.evaluate((notes) => {
        const mock = (window as unknown as MockWindow).__mock
        mock.setExternalApps([...mock.externalAppList, notes])
      }, NOTES)
      const row = page.getByTestId('app-row-box:_user/notes')
      const badge = page.getByTestId('app-machine-box:_user/notes')
      await expect(badge).toBeVisible()
      // Not inside the row's button: a sibling button
      await expect(row.getByTestId('app-machine-box:_user/notes')).toHaveCount(0)
      expect(await badge.evaluate((el) => el.tagName)).toBe('BUTTON')
      expect(await badge.evaluate((el, r) => el.parentElement === document.querySelector(`[data-testid="${r}"]`)!.parentElement, 'app-row-box:_user/notes')).toBe(true)
      // Right after the title, on its line
      const title = (await row.locator('.truncate').first().boundingBox())!
      const box = (await badge.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(title.x + title.width)
      expect(box.x - (title.x + title.width)).toBeLessThanOrEqual(10)
      expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2))).toBeLessThanOrEqual(1)
      // From the row, the next Tab stop is the badge (WebKit on macOS reaches buttons with Option-Tab), and Enter opens the machine's menu (Machine settings in it leads to Settings → Machines)
      await row.focus()
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
      await expect(badge).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('machine-menu-box')).toBeVisible()
      await page.getByTestId('machine-menu-settings-box').click()
      await expect(page.getByTestId('settings-machines')).toBeVisible()
      await expect(page.getByTestId('pinned-app-box:_user/notes')).toHaveCount(0)
    })

    test('a long machine name is cut in its badge, so it cannot take the line from the project name', async ({ page }) => {
      await setup(page)
      const id = await link(page, 'Workstation in the back office')
      await addOn(page, id, '/home/me/api')
      const badge = page.getByTestId('project-machine-api')
      await expect(badge).toHaveText('Workstation in the back office')
      const size = await badge.evaluate((el) => ({ width: el.getBoundingClientRect().width, cut: el.scrollWidth > el.clientWidth }))
      expect(size.width).toBeLessThanOrEqual(96)
      expect(size.cut).toBe(true)
      await page.mouse.move(900, 450)
      expect(await page.getByTestId('project-header-api').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
    })
  })

  test.describe("a linked machine's child stands in that machine's project (#1416)", () => {
    /**
     * Alpha (this computer) with a session that started two agents on Box, as `start_agent(machine: 'box')` does: the
     * hub lists them as sessions of Box's project `cc`, with `askedBy` naming the session here. Beta is given enough
     * sessions that `cc`, below it, is off screen. Sessions are emitted with fixed ids: the mock keeps them in memory.
     */
    async function seed(page: Page): Promise<{ parent: string; ccId: string }> {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/cc')
      const parent = await newSession(page, 'alpha')
      const idOf = (name: string) =>
        page.evaluate(
          (n) => (Object.values<{ id: string; name: string }>((window as unknown as MockWindow).__store.getState().projects)).find((p) => p.name === n)?.id as string,
          name,
        )
      const ccId = await idOf('cc')
      const betaId = await idOf('beta')
      await page.evaluate(
        ([parentId, cc, beta]) => {
          const m = (window as unknown as MockWindow).__mock
          const base = [...m.sessions.values()][0]
          const emit = (id: string, name: string, extra: Record<string, unknown>) =>
            m.emit({ type: 'session_created', sessionId: id, session: { ...base, id, name, worktree: null, parentSessionId: null, askedBy: null, appId: null, ...extra } })
          for (let i = 0; i < 30; i++) emit(`filler-${i}`, `filler ${i}`, { projectId: beta })
          emit('box.child-1', 'build the parser', { projectId: cc, machine: 'box', askedBy: parentId })
          emit('box.child-2', 'write the tests', { projectId: cc, machine: 'box', askedBy: parentId })
        },
        [parent, ccId, betaId] as const,
      )
      await expect(page.getByTestId('session-row-box.child-1')).toBeAttached()
      return { parent, ccId }
    }

    test("the child is a top-level row of Box's project with its Asked by mark, not a row under its parent", async ({ page }) => {
      const { parent } = await seed(page)
      const cc = page.getByTestId('project-cc')
      await expect(cc.getByTestId('session-row-box.child-1')).toBeAttached()
      await expect(cc.getByTestId('session-row-box.child-2')).toBeAttached()
      // The project that holds the parent has neither, and the children stand at the project's own level
      await expect(page.getByTestId('project-alpha').getByTestId('session-row-box.child-1')).toHaveCount(0)
      await expect(page.getByTestId('project-alpha').getByTestId('session-row-box.child-2')).toHaveCount(0)
      await expect(page.getByTestId('project-alpha').getByTestId(`children-fold-${parent}`)).toHaveCount(0)
      const item = cc.locator('li', { has: page.getByTestId('session-row-box.child-1') })
      await expect(item).toHaveAttribute('data-level', '1')
      await expect(item).not.toHaveAttribute('data-nested')
      // No machine tag on the row: the project's badge says where it is
      await expect(page.getByTestId('session-machine-box.child-1')).toHaveCount(0)

      // Opening it says who asked, with the way back
      await page.getByTestId('session-row-box.child-1').click()
      await expect(page.getByTestId('asked-by-badge')).toContainText('Asked by alpha')
      await expect(page.getByTestId('project-cc')).toHaveAttribute('data-selected', 'true')
      await page.getByTestId('asked-by-badge').click()
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')
    })

    test('the parent points to them as "2 on Box"; pressing it opens their project and scrolls to them, picking none', async ({ page }) => {
      const { parent, ccId } = await seed(page)
      const pointer = page.getByTestId(`handed-off-${parent}-box`)
      await expect(pointer).toContainText('2 on Box')
      await expect(page.getByTestId('project-alpha').getByTestId(`handed-off-${parent}`)).toBeVisible()
      await expect(page.getByTestId(`handed-off-${parent}-box-attention`)).toHaveCount(0)

      await test.step('Box’s project is folded and off screen: the pointer opens it and brings the child into view', async () => {
        await page.evaluate((id) => (window as unknown as MockWindow).__store.getState().toggleProjectFold(id), ccId)
        await expect(page.getByTestId('project-cc')).toHaveAttribute('data-folded', 'true')
        await expect(page.getByTestId('session-row-box.child-1')).toHaveCount(0)
        const picked = await page.evaluate(() => (window as unknown as MockWindow).__store.getState().focusedSessionId as string)
        await pointer.click()
        await expect(page.getByTestId('project-cc')).not.toHaveAttribute('data-folded')
        await expect(page.getByTestId('session-row-box.child-1')).toBeInViewport()
        // It only showed them: nothing was picked
        expect(await page.evaluate(() => (window as unknown as MockWindow).__store.getState().focusedSessionId as string)).toBe(picked)
      })
    })

    test('the pointer lights when a child waits or has errored, and says so, so a stopped child is seen from its parent', async ({ page }) => {
      const { parent } = await seed(page)
      const pointer = page.getByTestId(`handed-off-${parent}-box`)
      for (const state of ['error', 'waiting_approval'] as const) {
        await page.evaluate((st) => (window as unknown as MockWindow).__mock.emit({ type: 'state_change', sessionId: 'box.child-2', state: st }), state)
        await expect(page.getByTestId(`handed-off-${parent}-box-attention`)).toHaveAttribute('data-attention', 'alert')
        await expect(pointer).toHaveAttribute('aria-label', '2 on Box, one needs you')
      }
      await page.evaluate(() => (window as unknown as MockWindow).__mock.emit({ type: 'state_change', sessionId: 'box.child-2', state: 'working' }))
      await expect(page.getByTestId(`handed-off-${parent}-box-attention`)).toHaveCount(0)
    })

    test('a child of the same project on the same machine still hangs under its parent, with no pointer of its own', async ({ page }) => {
      const { parent } = await seed(page)
      await page.evaluate((pid) => {
        const m = (window as unknown as MockWindow).__mock
        const base = [...m.sessions.values()][0]
        m.emit({ type: 'session_created', sessionId: 'local-kid', session: { ...base, id: 'local-kid', name: 'local kid', worktree: null, parentSessionId: null, askedBy: pid, appId: null } })
      }, parent)
      await expect(page.getByTestId('project-alpha').getByTestId('session-row-local-kid')).toBeVisible()
      await expect(page.getByTestId('project-alpha').locator('li', { has: page.getByTestId('session-row-local-kid') })).toHaveAttribute('data-level', '2')
      // Still the one pointer, for the two on Box, and none for the child here
      await expect(page.getByTestId(`handed-off-${parent}-box`)).toContainText('2 on Box')
      await expect(page.getByTestId(`handed-off-${parent}`).locator('button')).toHaveCount(1)
    })
  })
}
