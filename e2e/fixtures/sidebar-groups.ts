import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * The sidebar's indentation and folding (#666): a project's sessions stand one level under its row, the children a
 * session started and the sessions an app owns one level further, and each of those groups folds behind a chevron.
 *
 * A function, like `sidebarSelectionTests`, because it runs in Chromium and in WebKit (sidebar-groups-webkit.spec.ts):
 * the desktop app is WKWebView, and the chevron sits in a gutter outside its row's box, which the engines lay out and
 * hit-test separately.
 *
 * The mock keeps sessions in memory and the screen preferences in localStorage, so a reload loses the sessions and
 * keeps the folds. Sessions are therefore emitted with fixed ids, and a reload test emits them again.
 */

const PARENT = 'g-parent'
const KIDS = ['g-kid-1', 'g-kid-2']
const APP_SESSION = 'g-app-session'
const APP_KID = 'g-app-kid'

/** One session of the project, a parent with two children, and an app with a session and a child of it */
async function seed(page: Page): Promise<{ plain: string; projectId: string; appKey: string }> {
  const plain = await newSession(page, 'alpha')
  const projectId = await page.evaluate(
    () => (Object.values((window as any).__store.getState().projects) as { id: string; name: string }[]).find((p) => p.name === 'alpha')!.id,
  )
  await page.evaluate(
    ([pid, ids]) => {
      const m = (window as any).__mock
      const base = [...m.sessions.values()][0]
      const emit = (id: string, name: string, extra: Record<string, unknown>) =>
        m.emit({
          type: 'session_created',
          sessionId: id,
          session: { ...base, id, name, worktree: null, parentSessionId: null, askedBy: null, appId: null, ...extra },
        })
      emit(ids.parent, 'parent', {})
      ids.kids.forEach((id: string, i: number) => emit(id, `kid ${i + 1}`, { parentSessionId: ids.parent, askedBy: ids.parent }))
      const manifest = (appId: string, projectId: string | null) => ({
        appId,
        projectId,
        dir: `/tmp/${appId}`,
        name: appId,
        version: '0.1.0',
        description: null,
        home: 'home',
        trusted: true,
        status: 'stopped',
        error: null,
        warnings: [],
      })
      m.setExternalApps([
        manifest('tool', null),
        {
          appId: 'slider',
          projectId: pid,
          dir: '/tmp/alpha/.centralu/apps/slider',
          name: 'Slider',
          version: '0.1.0',
          description: null,
          home: 'home',
          trusted: true,
          status: 'stopped',
          error: null,
          warnings: [],
        },
      ])
      emit(ids.appSession, 'app builder', { appId: 'slider' })
      // A user-folder app's key (`_user/tool`) does not change when the project is added again, so it can be found after a reload
      emit('g-user-app-session', 'user app builder', { projectId: null, appId: 'tool' })
      emit(ids.appKid, 'app helper', { appId: 'slider', parentSessionId: ids.appSession, askedBy: ids.appSession })
    },
    [projectId, { parent: PARENT, kids: KIDS, appSession: APP_SESSION, appKid: APP_KID }] as const,
  )
  await expect(page.getByTestId(`session-row-${PARENT}`)).toBeVisible()
  await expect(page.getByTestId(`app-session-row-${APP_SESSION}`)).toBeVisible()
  return { plain, projectId, appKey: `${projectId}/slider` }
}

const foldedGroups = (page: Page) => page.evaluate(() => (window as any).__store.getState().prefs.foldedGroups as string[])
const x = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!.x
const markX = async (page: Page, rowId: string) =>
  (await page.getByTestId(rowId).getByTestId('tool-mark-claude').boundingBox())!.x

export function sidebarGroupTests(): void {
  test.describe('the sidebar indents sessions and folds their groups (#666)', () => {
    test.beforeEach(async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
    })

    test('sessions stand one level under the project, children and app sessions one level further', async ({ page }) => {
      const { plain, appKey } = await seed(page)

      // Level 1 is 16px in from the project row's section; every further level is 16px more (plus the guide line's 1px)
      const sectionX = (await page.getByTestId('project-alpha').boundingBox())!.x
      const level1 = (await page.getByTestId(`session-row-${plain}`).locator('xpath=ancestor::li[1]').boundingBox())!.x - sectionX
      const level2 = (await page.getByTestId(`session-row-${KIDS[0]}`).locator('xpath=ancestor::li[1]').boundingBox())!.x - sectionX
      expect(level1).toBeCloseTo(16, 0)
      expect(level2 - level1).toBeCloseTo(16, 0)
      await expect(page.locator(`li[data-level="1"]`).filter({ has: page.getByTestId(`session-row-${plain}`) })).toHaveCount(1)
      await expect(page.locator(`li[data-level="2"]`).filter({ has: page.getByTestId(`session-row-${KIDS[0]}`) })).toHaveCount(1)

      // The app row is a level-1 item, its sessions level 2, a child of one of them level 3
      await expect(page.locator('li[data-level="1"]').filter({ has: page.getByTestId(`app-row-${appKey}`) })).toHaveCount(1)
      await expect(page.locator('li[data-level="2"]').filter({ has: page.getByTestId(`app-session-row-${APP_SESSION}`) })).toHaveCount(1)
      await expect(page.locator('li[data-level="3"]').filter({ has: page.getByTestId(`app-session-row-${APP_KID}`) })).toHaveCount(1)

      // A row with a chevron and one without start their tool mark at the same column: the chevron lives in the gutter
      expect(await markX(page, `session-row-${plain}`)).toBeCloseTo(await markX(page, `session-row-${PARENT}`), 0)
      // The chevron stands left of its row's content, inside the gutter
      expect(await x(page, `children-fold-${PARENT}`)).toBeLessThan(await markX(page, `session-row-${PARENT}`))

      // Nothing spills sideways and the long names still truncate rather than wrap
      const spill = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="sidebar"]')!
        return bar.scrollWidth - bar.clientWidth
      })
      expect(spill).toBeLessThanOrEqual(0)
    })

    test('folding a session’s children hides them behind a count; unfolding drops it', async ({ page }) => {
      await seed(page)
      await expect(page.getByTestId(`children-folded-${PARENT}`)).toHaveCount(0)

      await page.getByTestId(`children-fold-${PARENT}`).click()
      for (const id of KIDS) await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
      await expect(page.getByTestId(`children-folded-${PARENT}-count`)).toHaveText('2')
      await expect(page.getByTestId(`children-fold-${PARENT}`)).toHaveAttribute('aria-expanded', 'false')
      // Nothing else folded with it
      await expect(page.getByTestId(`app-session-row-${APP_KID}`)).toBeVisible()
      await expect.poll(() => foldedGroups(page)).toEqual([`session:${PARENT}`])

      await page.getByTestId(`children-fold-${PARENT}`).click()
      for (const id of KIDS) await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
      await expect(page.getByTestId(`children-folded-${PARENT}`)).toHaveCount(0)
      expect(await foldedGroups(page)).toEqual([])
    })

    /*
     * The mock loses its sessions on a reload and keeps its preferences, and a fold whose session is gone is dropped
     * at attach, so a session's fold cannot be followed across one here (the store tests do that with sessions that
     * stay). A user-folder app's key does not depend on any session or project id, so it can.
     */
    test('a fold survives a reload', async ({ page }) => {
      await seed(page)
      const key = '_user/tool'
      await page.getByTestId(`app-fold-${key}`).click()
      await expect(page.getByTestId('app-session-row-g-user-app-session')).toHaveCount(0)
      await expect(page.getByTestId(`app-folded-${key}-count`)).toHaveText('1')
      await expect.poll(() => foldedGroups(page)).toEqual([`app:${key}`])

      await page.reload()
      await expect(page.getByTestId('add-project')).toBeVisible()
      await page.evaluate((p: string) => ((window as any).__mock.nextPickedDirectory = p), '/tmp/alpha')
      await page.getByTestId('add-project').click()
      await seed(page)
      await expect(page.getByTestId(`app-folded-${key}-count`)).toHaveText('1')
      await expect(page.getByTestId('app-session-row-g-user-app-session')).toHaveCount(0)
      expect(await foldedGroups(page)).toEqual([`app:${key}`])

      await page.getByTestId(`app-fold-${key}`).click()
      await expect(page.getByTestId('app-session-row-g-user-app-session')).toBeVisible()
      expect(await foldedGroups(page)).toEqual([])
    })

    test('a deleted session’s fold is dropped, not kept toward the cap', async ({ page }) => {
      await seed(page)
      await page.getByTestId(`children-fold-${PARENT}`).click()
      await expect.poll(() => foldedGroups(page)).toEqual([`session:${PARENT}`])
      await page.evaluate((id) => (window as any).__mock.emit({ type: 'session_deleted', sessionId: id }), PARENT)
      await expect(page.getByTestId(`session-row-${PARENT}`)).toHaveCount(0)
      await expect.poll(() => foldedGroups(page)).toEqual([])
    })

    test('Left and Right type into the rename field and an input method, they do not fold', async ({ page }) => {
      await seed(page)

      // While the name is being edited the arrows move the caret
      await page.getByTestId(`session-row-${PARENT}`).dblclick()
      const input = page.getByTestId(`session-name-input-${PARENT}`)
      await expect(input).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowRight')
      await expect(input).toBeVisible()
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(input).toHaveCount(0)

      // An arrow that belongs to an input method composing on the focused row (isComposing, or WebKit's keyCode 229)
      const row = page.getByTestId(`session-row-${PARENT}`)
      await row.focus()
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
        await row.evaluate((el, i) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true, ...i })), init)
      }
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toBeVisible()
      expect(await foldedGroups(page)).toEqual([])
      // And the same row still folds on a plain Left
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toHaveCount(0)
    })

    test('an app’s sessions fold behind a count on the app row', async ({ page }) => {
      const { appKey } = await seed(page)
      await page.getByTestId(`app-fold-${appKey}`).click()
      await expect(page.getByTestId(`app-session-row-${APP_SESSION}`)).toHaveCount(0)
      await expect(page.getByTestId(`app-session-row-${APP_KID}`)).toHaveCount(0)
      await expect(page.getByTestId(`app-folded-${appKey}-count`)).toHaveText('2')
      // The app row itself stays, and still opens the app
      await expect(page.getByTestId(`app-row-${appKey}`)).toBeVisible()
      await expect.poll(() => foldedGroups(page)).toEqual([`app:${appKey}`])

      await page.getByTestId(`app-fold-${appKey}`).click()
      await expect(page.getByTestId(`app-session-row-${APP_SESSION}`)).toBeVisible()
      await expect(page.getByTestId(`app-folded-${appKey}`)).toHaveCount(0)
    })

    test('a folded group still signals a hidden child that waits for approval, errored, or is unread', async ({ page }) => {
      const { appKey } = await seed(page)
      await page.getByTestId(`children-fold-${PARENT}`).click()
      await page.getByTestId(`app-fold-${appKey}`).click()
      await expect(page.getByTestId(`children-folded-${PARENT}-attention`)).toHaveCount(0)
      await expect(page.getByTestId(`app-folded-${appKey}-attention`)).toHaveCount(0)

      // A child asks for approval: the parent's count grows a sign, in the signal strength
      await page.evaluate(
        (id) => (window as any).__mock.requestApproval(id, { kind: 'command', command: 'rm -rf build', cwd: '/tmp/alpha' }, 'r-hidden'),
        KIDS[1],
      )
      await expect(page.getByTestId(`children-folded-${PARENT}-attention`)).toHaveAttribute('data-attention', 'alert')
      await expect(page.getByTestId(`children-folded-${PARENT}`)).toHaveAttribute('aria-label', /one needs you/)
      // Opening the group shows the row that asks, and the sign leaves with the fold
      await page.getByTestId(`children-fold-${PARENT}`).click()
      await expect(page.getByTestId(`session-row-${KIDS[1]}`).getByTestId('tool-mark-claude')).toHaveAttribute('data-state', 'waiting_approval')
      await expect(page.getByTestId(`children-folded-${PARENT}`)).toHaveCount(0)

      // An app's hidden session that errored
      await page.evaluate(
        (id) => (window as any).__mock.emit({ type: 'state_change', sessionId: id, state: 'error' }),
        APP_SESSION,
      )
      await expect(page.getByTestId(`app-folded-${appKey}-attention`)).toHaveAttribute('data-attention', 'alert')

      // Only unread: the quieter strength
      await page.evaluate(
        (id) =>
          (window as any).__store.setState((s: any) => ({
            sessions: {
              ...s.sessions,
              [id]: { ...s.sessions[id], state: 'idle', lastSeq: s.sessions[id].lastReadSeq + 1 },
            },
          })),
        APP_SESSION,
      )
      await expect(page.getByTestId(`app-folded-${appKey}-attention`)).toHaveAttribute('data-attention', 'unread')
    })

    test('Left folds and Right unfolds the focused row’s group', async ({ page }) => {
      const { plain, appKey } = await seed(page)

      await page.getByTestId(`session-row-${PARENT}`).focus()
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toHaveCount(0)
      // The key stays with the row, so the same row answers the next one
      await page.keyboard.press('ArrowRight')
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toBeVisible()

      // A row with nothing under it ignores both, and so does a key with a modifier
      await page.getByTestId(`session-row-${plain}`).focus()
      await page.keyboard.press('ArrowLeft')
      expect(await foldedGroups(page)).toEqual([])
      await page.getByTestId(`session-row-${PARENT}`).focus()
      await page.keyboard.press('Shift+ArrowLeft')
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toBeVisible()

      // The app row answers too
      await page.getByTestId(`app-row-${appKey}`).focus()
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByTestId(`app-session-row-${APP_SESSION}`)).toHaveCount(0)
      await page.keyboard.press('ArrowRight')
      await expect(page.getByTestId(`app-session-row-${APP_SESSION}`)).toBeVisible()
    })

    test('selecting a hidden session unfolds the groups that hide it', async ({ page }) => {
      const { appKey } = await seed(page)
      await page.getByTestId(`children-fold-${PARENT}`).click()
      await page.getByTestId(`app-fold-${appKey}`).click()
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toHaveCount(0)
      await expect(page.getByTestId(`app-session-row-${APP_KID}`)).toHaveCount(0)

      // The path search, a notification and the inbox take: the store's focusSession
      await page.evaluate((id) => (window as any).__store.getState().focusSession(id), KIDS[0])
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toBeVisible()
      await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toHaveAttribute('aria-current', 'page')
      // Only the group that hid it opened
      await expect(page.getByTestId(`app-session-row-${APP_KID}`)).toHaveCount(0)
      await expect.poll(() => foldedGroups(page)).toEqual([`app:${appKey}`])

      // A child inside a folded app opens both its app and its parent
      await page.evaluate((id) => (window as any).__store.getState().focusSession(id), APP_KID)
      await expect(page.getByTestId(`app-session-row-${APP_KID}`)).toBeVisible()
      await expect(page.getByTestId(`app-session-row-${APP_KID}`)).toHaveAttribute('aria-current', 'page')
      expect(await foldedGroups(page)).toEqual([])
    })

    test('selecting a hidden session from the search opens its group', async ({ page }) => {
      await seed(page)
      await page.getByTestId(`children-fold-${PARENT}`).click()
      await expect(page.getByTestId(`session-row-${KIDS[1]}`)).toHaveCount(0)

      await page.getByTestId('search-button').click()
      await page.keyboard.type('kid 2')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId(`session-row-${KIDS[1]}`)).toHaveAttribute('aria-current', 'page')
    })

    test('dragging a session or a project still reorders with the indentation and a fold in place', async ({ page }) => {
      const { plain } = await seed(page)
      await page.getByTestId(`children-fold-${PARENT}`).click()
      // The plain session, dropped on the top half of the parent row, goes ahead of it
      await page.dragAndDrop(`[data-testid="session-row-${PARENT}"]`, `[data-testid="session-row-${plain}"]`, {
        targetPosition: { x: 10, y: 2 },
      })
      await expect
        .poll(async () => (await page.getByTestId('project-alpha').locator('li[data-level="1"] [data-testid^="session-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))))
        .toEqual([`session-row-${PARENT}`, `session-row-${plain}`])

      // A child cannot be dragged to reorder (position is membership), so a fold never changes who is whose
      await page.getByTestId(`children-fold-${PARENT}`).click()
      await expect(page.getByTestId(`session-row-${KIDS[0]}`).locator('xpath=ancestor::li[1]')).toHaveAttribute('draggable', 'false')

      // A project is still grabbed by its name row and dropped on another project
      await page.evaluate((p: string) => ((window as any).__mock.nextPickedDirectory = p), '/tmp/beta')
      await page.getByTestId('add-project').click()
      await expect(page.getByTestId('project-beta')).toBeVisible()
      const projects = () => page.evaluate(() => Object.values((window as any).__store.getState().projects).map((p: any) => p.name as string))
      expect(await projects()).toEqual(['alpha', 'beta'])
      await page.dragAndDrop('[data-testid="project-header-beta"]', '[data-testid="project-alpha"]', { targetPosition: { x: 10, y: 2 } })
      await expect.poll(projects).toEqual(['beta', 'alpha'])
    })
  })
}
