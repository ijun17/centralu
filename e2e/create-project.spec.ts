import { test, expect, type Page } from '@playwright/test'

/**
 * Making a new project (#515): "New folder" beside Add project on this computer, "Create a new folder" in a linked
 * machine's dialog, and the orchestrator's create_project card. The mock answers as the host does: the ~/Centralu of the
 * machine it is for, the name rule (shared through protocol), and a refusal for a name already taken.
 */

async function start(page: Page) {
  await page.goto('/?mock=1')
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
}


test('New folder: the dialog says where the folder goes as the name is typed, refuses a taken or bad name, and makes it', async ({ page }) => {
  await start(page)
  await page.evaluate(() => (window as any).__mock.takenPaths.add('/Users/you/Centralu/taken'))
  await page.getByTestId('create-project').click()
  const dialog = page.getByTestId('create-project-dialog')
  await expect(dialog).toBeVisible()
  // Before a name, the location: this computer's ~/Centralu
  await expect(dialog.getByTestId('create-project-parent-shown')).toHaveText('/Users/you/Centralu')
  await expect(dialog.getByTestId('create-project-confirm')).toBeDisabled()

  await dialog.getByTestId('create-project-name').fill('taken')
  await expect(dialog.getByTestId('create-project-error')).toContainText('already in /Users/you/Centralu')
  await expect(dialog.getByTestId('create-project-confirm')).toBeDisabled()

  await dialog.getByTestId('create-project-name').fill('a/b')
  await expect(dialog.getByTestId('create-project-error')).toContainText('one folder')

  await dialog.getByTestId('create-project-name').fill('game')
  await expect(dialog.getByTestId('create-project-path')).toHaveText('/Users/you/Centralu/game')
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

test('New folder: a picker the shell refuses says why in the form (#972)', async ({ page }) => {
  await start(page)
  await page.getByTestId('create-project').click()
  const dialog = page.getByTestId('create-project-dialog')
  await dialog.getByTestId('create-project-change-parent').click()
  await page.evaluate(() => ((window as any).__mock.pickFails = 'dialog.open not allowed'))
  await dialog.getByTestId('create-project-pick-parent').click()
  await expect(dialog.getByTestId('create-project-error')).toHaveText('dialog.open not allowed')
})

/**
 * The location comes from the host a moment after the dialog opens (the preview waits 150 ms for typing to pause).
 * Change used to follow that text, so it jumped when the text arrived: a click on it as the dialog opened went down
 * on the button and came up beside it, and the location stayed as it was (a WebKit CI run of the test above). The
 * page's clock is held here, so the press starts before the text arrives and ends after it.
 */
test('New folder: a click on Change as the dialog opens still opens the location, though the location arrives mid-click', async ({ page }) => {
  await page.clock.install()
  await start(page)
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000)
  await page.getByTestId('create-project').click()
  const dialog = page.getByTestId('create-project-dialog')
  await expect(dialog.getByTestId('create-project-parent-shown')).toHaveText('…')
  const box = (await dialog.getByTestId('create-project-change-parent').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.clock.runFor(200)
  await expect(dialog.getByTestId('create-project-parent-shown')).toHaveText('/Users/you/Centralu')
  await page.mouse.up()
  await expect(dialog.getByTestId('create-project-parent')).toHaveValue('/Users/you/Centralu')
  await expect(dialog.getByTestId('create-project-pick-parent')).toBeVisible()
})

test("a linked Windows machine: Create a new folder is made by that machine's host, in its own ~/Centralu, in its own path terms", async ({ page }) => {
  await start(page)
  await page.evaluate(() => (window as any).__mock.machines.add({ name: 'Win', sshTarget: 'me@win', shell: 'powershell' }))
  await page.getByTestId('add-project').click()
  await page.getByTestId('add-project-on-win').click()
  const dialog = page.getByTestId('add-remote-project-dialog')
  // Adding an existing folder is still the first choice
  await expect(dialog.getByTestId('add-remote-project-path')).toBeVisible()
  await dialog.getByTestId('add-remote-project-mode-new').click()
  await expect(dialog.getByTestId('create-project-parent-shown')).toHaveText('C:\\Users\\you\\Centralu')
  // What only Windows refuses is refused for a Windows machine
  await dialog.getByTestId('create-project-name').fill('notes.')
  await expect(dialog.getByTestId('create-project-error')).toContainText('dot or a space')
  await dialog.getByTestId('create-project-name').fill('game')
  await expect(dialog.getByTestId('create-project-path')).toHaveText('C:\\Users\\you\\Centralu\\game')
  await dialog.getByTestId('create-project-confirm').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('project-machine-game')).toHaveText('Win')
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

/**
 * A clone instead of an empty folder (#515): the folder is named after the repository unless a name is given, an
 * address the host would refuse is refused as it is typed, and a clone that fails leaves the form with its sentence.
 */
test('New folder: clone a repository — named after it, refused addresses said at once, a failed clone keeps its reason', async ({ page }) => {
  await start(page)
  await page.getByTestId('create-project').click()
  const dialog = page.getByTestId('create-project-dialog')
  await dialog.getByTestId('create-project-clone').check()

  await dialog.getByTestId('create-project-git').fill('ext::sh -c x')
  await expect(dialog.getByTestId('create-project-error')).toContainText('ext::')
  await dialog.getByTestId('create-project-git').fill('/Users/you/code/app')
  await expect(dialog.getByTestId('create-project-error')).toContainText('local folder')

  await dialog.getByTestId('create-project-git').fill('https://github.com/me/game.git')
  await expect(dialog.getByTestId('create-project-name')).toHaveAttribute('placeholder', 'game')
  await expect(dialog.getByTestId('create-project-path')).toHaveText('/Users/you/Centralu/game')
  await expect(dialog.getByTestId('create-project-confirm')).toHaveText('Clone project')

  await page.evaluate(() => {
    ;(window as any).__mock.nextCloneError = 'https://github.com/me/game.git needs a sign-in this machine does not have saved.'
  })
  await dialog.getByTestId('create-project-confirm').click()
  await expect(dialog.getByTestId('create-project-error')).toContainText('needs a sign-in')
  await expect(page.getByTestId('project-game')).toHaveCount(0)

  await dialog.getByTestId('create-project-branch').fill('dev')
  await dialog.getByTestId('create-project-confirm').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('project-game')).toBeVisible()
  expect((await page.evaluate(() => (window as any).__mock.createProjectCalls)).at(-1)).toEqual({
    name: '',
    source: { git: 'https://github.com/me/game.git', branch: 'dev' },
  })
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
