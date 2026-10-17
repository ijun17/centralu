import { expect, test, type Page } from '@playwright/test'
import { setup as setupProjects } from './control.js'

/**
 * The sidebar's one list across machines (#734): a linked machine's projects stand among this computer's, in one order
 * the person sets by dragging, each with its machine's badge; there are no machine headers. On the mock platform, which
 * is told about machines; the order kept on the hub across a reload is asked of two real hosts in
 * `linked-hosts-ui-scenarios.ts`. A function, because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 */

type MockWindow = { __mock: any; __store: any }

/** This computer with two projects, alpha and beta, added through Add project before any machine is linked */
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
      await expect(page.getByTestId('project-api')).not.toHaveAttribute('data-away', 'true')

      await setMachine(page, 'box', { status: 'unreachable', error: 'ssh: connect to host box port 22: Operation timed out' })
      await expect(badge).toHaveAttribute('data-status', 'unreachable')
      expect(await border(page, 'project-machine-api')).toBe('dashed')
      await expect(badge).toHaveAttribute('title', 'ssh: connect to host box port 22: Operation timed out')
      // The row keeps its dimming for a machine that is away
      await expect(page.getByTestId('project-api')).toHaveAttribute('data-away', 'true')

      await setMachine(page, 'box', { status: 'connecting', error: null })
      expect(await border(page, 'project-machine-api')).toBe('dashed')
      await setMachine(page, 'box', { status: 'connected', error: null })
      await expect(badge).toHaveAttribute('data-status', 'connected')
      expect(await border(page, 'project-machine-api')).toBe('solid')
    })

    test('pressing the badge opens Settings → Machines, and does not open the project', async ({ page }) => {
      await setup(page)
      await link(page, 'Box')
      await addOn(page, 'box', '/home/me/api')
      await page.getByTestId('project-machine-api').click()
      await expect(page.getByTestId('settings-machines')).toBeVisible()
      await expect(page.getByTestId('machine-row-box')).toBeVisible()
      await expect(page.getByTestId('project-header-api')).not.toHaveAttribute('aria-current', 'page')
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
      await expect(page.getByTestId('add-project')).toHaveText('Add project')

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
        await expect(page.getByTestId('add-remote-project-dialog')).toContainText('Add a project on Box')
        await page.getByTestId('add-remote-project-path').fill('/home/me/api')
        await page.getByTestId('add-remote-project-confirm').click()
        await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
        await expect(page.getByTestId('project-machine-api')).toHaveText('Box')
        expect(await listed(page)).toEqual(['alpha', 'beta', 'gamma', 'api'])
      })

      await test.step('or a new folder made there', async () => {
        await page.getByTestId('add-project').click()
        await page.getByTestId('add-project-on-box').click()
        const dialog = page.getByTestId('add-remote-project-dialog')
        await dialog.getByTestId('add-remote-project-mode-new').click()
        await dialog.getByTestId('create-project-name').fill('fresh')
        await dialog.getByTestId('create-project-confirm').click()
        await expect(dialog).toHaveCount(0)
        await expect(page.getByTestId('project-machine-fresh')).toHaveText('Box')
        expect(await page.evaluate(() => (window as unknown as MockWindow).__mock.createProjectCalls)).toEqual([{ name: 'fresh', machine: 'box' }])
      })
    })

    test("a linked machine's user-folder apps stand in Your apps with its badge, dimmed while it is away", async ({ page }) => {
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

      // Its badge, pressed, opens Settings → Machines rather than the app
      await page.getByTestId('app-machine-box:_user/notes').click()
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
      // From the row, the next Tab stop is the badge (WebKit on macOS reaches buttons with Option-Tab), and Enter opens Settings → Machines
      await row.focus()
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
      await expect(badge).toBeFocused()
      await page.keyboard.press('Enter')
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
}
