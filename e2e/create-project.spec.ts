import { test, expect, type Page } from '@playwright/test'

/**
 * Making a new project (#515): "New folder" beside Add project on this computer, "Create a new folder" in a linked
 * machine's dialog, and the orchestrator's create_project card. The mock answers as the host does: the Desktop of the
 * machine it is for, the name rule (shared through protocol), and a refusal for a name already taken.
 */

async function start(page: Page) {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
}


test('New folder: the dialog says where the folder goes as the name is typed, refuses a taken or bad name, and makes it', async ({ page }) => {
  await start(page)
  await page.evaluate(() => (window as any).__mock.takenPaths.add('/Users/you/Desktop/taken'))
  await page.getByTestId('create-project').click()
  const dialog = page.getByTestId('create-project-dialog')
  await expect(dialog).toBeVisible()
  // Before a name, the location: this computer's Desktop
  await expect(dialog.getByTestId('create-project-parent-shown')).toHaveText('/Users/you/Desktop')
  await expect(dialog.getByTestId('create-project-confirm')).toBeDisabled()

  await dialog.getByTestId('create-project-name').fill('taken')
  await expect(dialog.getByTestId('create-project-error')).toContainText('already in /Users/you/Desktop')
  await expect(dialog.getByTestId('create-project-confirm')).toBeDisabled()

  await dialog.getByTestId('create-project-name').fill('a/b')
  await expect(dialog.getByTestId('create-project-error')).toContainText('one folder')

  await dialog.getByTestId('create-project-name').fill('game')
  await expect(dialog.getByTestId('create-project-path')).toHaveText('/Users/you/Desktop/game')
  await expect(dialog.getByTestId('create-project-error')).toHaveCount(0)
  await dialog.getByTestId('create-project-confirm').click()

  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('project-game')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.createProjectCalls)).toEqual([{ name: 'game' }])
})

test('New folder: another location is a full path, typed or chosen with the picker', async ({ page }) => {
  await start(page)
  await page.getByTestId('create-project').click()
  const dialog = page.getByTestId('create-project-dialog')
  await dialog.getByTestId('create-project-change-parent').click()
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/Users/you/code'
  })
  await dialog.getByTestId('create-project-pick-parent').click()
  await expect(dialog.getByTestId('create-project-parent')).toHaveValue('/Users/you/code')
  await dialog.getByTestId('create-project-name').fill('site')
  await expect(dialog.getByTestId('create-project-path')).toHaveText('/Users/you/code/site')
  await dialog.getByTestId('create-project-confirm').click()
  await expect(page.getByTestId('project-site')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.createProjectCalls)).toEqual([{ name: 'site', parent: '/Users/you/code' }])
})

test("a linked Windows machine: Create a new folder is made by that machine's host, on its own Desktop, in its own path terms", async ({ page }) => {
  await start(page)
  await page.evaluate(() => (window as any).__mock.machines.add({ name: 'Win', sshTarget: 'me@win', shell: 'powershell' }))
  await page.getByTestId('add-remote-project-win').click()
  const dialog = page.getByTestId('add-remote-project-dialog')
  // Adding an existing folder is still the first choice
  await expect(dialog.getByTestId('add-remote-project-path')).toBeVisible()
  await dialog.getByTestId('add-remote-project-mode-new').click()
  await expect(dialog.getByTestId('create-project-parent-shown')).toHaveText('C:\\Users\\you\\Desktop')
  // What only Windows refuses is refused for a Windows machine
  await dialog.getByTestId('create-project-name').fill('notes.')
  await expect(dialog.getByTestId('create-project-error')).toContainText('dot or a space')
  await dialog.getByTestId('create-project-name').fill('game')
  await expect(dialog.getByTestId('create-project-path')).toHaveText('C:\\Users\\you\\Desktop\\game')
  await dialog.getByTestId('create-project-confirm').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('machine-group-win').getByTestId('project-game')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__mock.createProjectCalls)).toEqual([{ name: 'game', machine: 'win' }])
})

/**
 * The orchestrator's create_project: the host raises a card in the orchestrator's own approval slot with the full path,
 * and makes the folder only on Create. The card has no "always" — it is one folder — so `a` does nothing.
 */
test('create_project: the card in the orchestrator names the folder and its full path, has no always, and Create answers allow', async ({ page }) => {
  await start(page)
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()
  const orc = await page.evaluate(() => (window as any).__store.getState().orchestratorId as string)
  await page.evaluate(
    (sid) => (window as any).__mock.requestApproval(sid, { kind: 'project_create', name: 'shop', path: '/Users/you/Desktop/shop' }, 'mk-1'),
    orc,
  )
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'project_create')
  await expect(card.getByTestId('approval-detail')).toHaveText('Make a new project shop?')
  await expect(card.getByTestId('approval-path')).toHaveText('/Users/you/Desktop/shop')
  await expect(card.getByTestId('approve-always')).toHaveCount(0)
  await card.getByTestId('approve-allow').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers))
    .toEqual([{ sessionId: orc, requestId: 'mk-1', decision: 'allow' }])
})

test('a new-project card takes y and n from the keyboard, and a does nothing — there is nothing to always allow', async ({ page }) => {
  await start(page)
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  await page.evaluate((s) => (window as any).__mock.requestApproval(s, { kind: 'project_create', name: 'shop', path: '/Users/you/Desktop/shop' }, 'mk-2'), sid)
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'project_create')
  await card.getByTestId('approval-detail').click()
  await page.keyboard.press('a')
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([])
  await page.keyboard.press('y')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([{ sessionId: sid, requestId: 'mk-2', decision: 'allow' }])
})

test('a project the host made on its own joins the sidebar when the host says so', async ({ page }) => {
  await start(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    await m.projects.create('shop')
    m.emit({ type: 'projects_changed' })
  })
  await expect(page.getByTestId('project-shop')).toBeVisible()
})
