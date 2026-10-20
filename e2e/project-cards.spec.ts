import { test, expect, type Page } from '@playwright/test'

/**
 * The orchestrator's project cards (#515, #82): create_project and add_project raise a card in the approval slot, and
 * the folder is made or added only on the answer. Neither has an "always": it is one folder. The dialogs that used to
 * be tested beside these (New folder on this computer, Create a new folder on a linked machine) are gone with the
 * sidebar's New folder button; the host still makes the folder, and a project it makes on its own joins the sidebar.
 */

async function start(page: Page) {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
}


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
    (sid) => (window as any).__mock.requestApproval(sid, { kind: 'project_create', name: 'shop', path: '/Users/you/Centralu/shop' }, 'mk-1'),
    orc,
  )
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'project_create')
  await expect(card.getByTestId('approval-detail')).toHaveText('Make a new project shop?')
  await expect(card.getByTestId('approval-path')).toHaveText('/Users/you/Centralu/shop')
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
  await page.evaluate((s) => (window as any).__mock.requestApproval(s, { kind: 'project_create', name: 'shop', path: '/Users/you/Centralu/shop' }, 'mk-2'), sid)
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'project_create')
  await card.getByTestId('approval-detail').click()
  // Keys are handled in the order they are pressed, so the y after it is the proof: had the a
  // answered, its answer would come first in the list (or the card would be gone for the y)
  await page.keyboard.press('a')
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

test('create_project on a linked machine: the card names the machine whose disk the path is on (#82 phase 4)', async ({ page }) => {
  await start(page)
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()
  const orc = await page.evaluate(() => (window as any).__store.getState().orchestratorId as string)
  await page.evaluate(
    (sid) =>
      (window as any).__mock.requestApproval(sid, { kind: 'project_create', name: 'api', path: '/home/me/Centralu/api', machine: 'Ubuntu box' }, 'mk-4'),
    orc,
  )
  const card = page.getByTestId('approval-card')
  await expect(card.getByTestId('approval-detail')).toHaveText('Make a new project api on Ubuntu box?')
  await expect(card.getByTestId('approval-machine')).toHaveText('Ubuntu box')
  await expect(card.getByTestId('approval-path')).toHaveText('/home/me/Centralu/api')
  // The conversation keeps the question with the machine in it, after the card is answered
  await card.getByTestId('approve-deny').click()
  await expect(page.getByText('Make the empty folder /home/me/Centralu/api on Ubuntu box and add it as the project api?')).toBeVisible()
})

test('create_project with git: the card names the repository, its branch and where it goes', async ({ page }) => {
  await start(page)
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()
  const orc = await page.evaluate(() => (window as any).__store.getState().orchestratorId as string)
  await page.evaluate(
    (sid) =>
      (window as any).__mock.requestApproval(
        sid,
        { kind: 'project_create', name: 'game', path: '/Users/you/Centralu/game', source: { git: 'git@github.com:me/game.git', branch: 'dev' } },
        'mk-3',
      ),
    orc,
  )
  const card = page.getByTestId('approval-card')
  await expect(card.getByTestId('approval-detail')).toHaveText('Clone a repository as the new project game?')
  await expect(card.getByTestId('approval-source')).toHaveText('git@github.com:me/game.git (branch dev)')
  await expect(card.getByTestId('approval-path')).toHaveText('into /Users/you/Centralu/game')
  await card.getByTestId('approve-deny').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([{ sessionId: orc, requestId: 'mk-3', decision: 'deny' }])
})

/**
 * The orchestrator's add_project (#1220): the card shows what the folder's machine found there (the machine, the full
 * path, that it is a folder, the git repository and its origin), has no "always", and a folder added this way is asked
 * about for trust in the sidebar as one the person added.
 */
test('add_project: the card shows the folder, its machine and its git facts, has no always, and answers allow or deny', async ({ page }) => {
  await start(page)
  await page.getByTestId('suggest-create-project').click()
  await expect(page.getByTestId('msg-user').first()).toBeVisible()
  const orc = await page.evaluate(() => (window as any).__store.getState().orchestratorId as string)
  const here = {
    kind: 'project_add',
    name: 'site',
    path: '/Users/you/code/site',
    exists: true,
    folder: true,
    git: true,
    origin: 'git@github.com:me/site.git',
    text: 'Add the existing folder /Users/you/code/site as the project site? It is a git repository (origin git@github.com:me/site.git).',
  }
  await page.evaluate(([sid, d]) => (window as any).__mock.requestApproval(sid, d, 'mk-a1'), [orc, here] as const)
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'project_add')
  await expect(card.getByTestId('approval-detail')).toHaveText('Add the folder site as a project?')
  await expect(card.getByTestId('approval-machine')).toHaveCount(0)
  await expect(card.getByTestId('approval-path')).toHaveText('/Users/you/code/site')
  await expect(card.getByTestId('approval-found')).toHaveText('A folder that exists')
  await expect(card.getByTestId('approval-git')).toHaveText('A git repository, origin git@github.com:me/site.git')
  await expect(card.getByTestId('approve-always')).toHaveCount(0)
  await card.getByTestId('approve-deny').click()
  await expect.poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([{ sessionId: orc, requestId: 'mk-a1', decision: 'deny' }])
  // The conversation keeps the whole question after the card is answered
  await expect(page.getByText(here.text)).toBeVisible()

  const linked = {
    kind: 'project_add',
    name: 'notes',
    path: '/home/me/Desktop/notes',
    machine: 'Laptop',
    exists: true,
    folder: true,
    git: false,
    origin: null,
    text: 'Add the existing folder /home/me/Desktop/notes on Laptop as the project notes? It is not a git repository.',
  }
  await page.evaluate(([sid, d]) => (window as any).__mock.requestApproval(sid, d, 'mk-a2'), [orc, linked] as const)
  await expect(card.getByTestId('approval-detail')).toHaveText('Add the folder notes on Laptop as a project?')
  await expect(card.getByTestId('approval-machine')).toHaveText('Laptop')
  await expect(card.getByTestId('approval-path')).toHaveText('/home/me/Desktop/notes')
  await expect(card.getByTestId('approval-git')).toHaveText('Not a git repository')
  await card.getByTestId('approve-allow').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers))
    .toEqual([
      { sessionId: orc, requestId: 'mk-a1', decision: 'deny' },
      { sessionId: orc, requestId: 'mk-a2', decision: 'allow' },
    ])
})

test('an add-folder card takes y and n from the keyboard, and a does nothing — there is nothing to always allow', async ({ page }) => {
  await start(page)
  await page.evaluate(() => {
    ;(window as any).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
  const detail = { kind: 'project_add', name: 'site', path: '/Users/you/code/site', exists: true, folder: true, git: false, origin: null, text: 'Add the existing folder /Users/you/code/site as the project site? It is not a git repository.' }
  await page.evaluate(([s, d]) => (window as any).__mock.requestApproval(s, d, 'mk-a3'), [sid, detail] as const)
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'project_add')
  await card.getByTestId('approval-detail').click()
  // Keys are handled in the order they are pressed: had the a answered, its answer would come first
  await page.keyboard.press('a')
  await page.keyboard.press('n')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([{ sessionId: sid, requestId: 'mk-a3', decision: 'deny' }])
})

test('add_project: a folder the host added after Allow is asked about for trust in the sidebar, as Add project asks', async ({ page }) => {
  await start(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    const p = await m.projects.add('/Users/you/code/alpha')
    m.emit({ type: 'projects_changed', added: p.id })
  })
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  await expect(page.getByTestId('trust-ask-alpha')).toBeVisible()
})
