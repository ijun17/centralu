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

export const PARENT = 'g-parent'
export const KIDS = ['g-kid-1', 'g-kid-2']
const APP_SESSION = 'g-app-session'
const APP_KID = 'g-app-kid'

/** One session of the project, a parent with two children, and an app with a session and a child of it */
export async function seed(page: Page): Promise<{ plain: string; projectId: string; appKey: string }> {
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

      // Every level's band starts 16px after its parent's (the column grid itself is measured in the next test)
      const sectionX = (await page.getByTestId('project-alpha').boundingBox())!.x
      const level1 = (await page.getByTestId(`session-row-${plain}`).locator('xpath=ancestor::li[1]').boundingBox())!.x - sectionX
      const level2 = (await page.getByTestId(`session-row-${KIDS[0]}`).locator('xpath=ancestor::li[1]').boundingBox())!.x - sectionX
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

    /*
     * #685: after #667 a session's chip stood left of its project's name, and the app level did not line up with the
     * session level. Each level's content (tool mark or app icon, then the name) starts one 16px step right of its
     * parent's content, and a fold chevron stands in the gutter just left of the content it belongs to.
     */
    for (const [label, width] of [['narrow', 0], ['wide', 420]] as const) {
      test(`each level's content starts one step right of its parent's content, ${label} sidebar`, async ({ page }) => {
        const { plain, appKey } = await seed(page)
        // 0 asks for the narrowest the sidebar goes (it clamps), and the names get long enough to truncate there
        await page.evaluate((w) => (window as any).__store.getState().setSidebarWidth(w), width)
        await page.evaluate(
          ([ids]) => {
            const store = (window as any).__store
            const long = 'a session name far too long to fit in a narrow sidebar on one line'
            store.setState((s: any) => ({
              sessions: Object.fromEntries(
                Object.entries(s.sessions).map(([id, v]: [string, any]) => [id, ids.includes(id) ? { ...v, name: long } : v]),
              ),
            }))
          },
          [[PARENT, KIDS[0], APP_SESSION, APP_KID]] as const,
        )
        await expect(page.getByTestId(`session-row-${PARENT}`)).toContainText('a session name far too long')

        const left = async (locator: ReturnType<Page['locator']>) => (await locator.first().boundingBox())!.x
        const name = await left(page.getByTestId('project-header-alpha'))
        const plainMark = await markX(page, `session-row-${plain}`)
        const parentMark = await markX(page, `session-row-${PARENT}`)
        const kidMark = await markX(page, `session-row-${KIDS[0]}`)
        const appIcon = await left(page.getByTestId(`app-row-${appKey}`).locator('> span').first())
        const appSessionMark = await markX(page, `app-session-row-${APP_SESSION}`)
        const appKidMark = await markX(page, `app-session-row-${APP_KID}`)
        const userAppIcon = await left(page.getByTestId('app-row-_user/tool').locator('> span').first())
        const userAppTitle = await left(page.getByText('Your apps', { exact: true }))

        // project name < session chip < child chip, one 16px step each
        expect(plainMark - name).toBeCloseTo(16, 0)
        expect(kidMark - parentMark).toBeCloseTo(16, 0)
        // a sibling with a chevron and one without start at the same column
        expect(parentMark).toBeCloseTo(plainMark, 0)
        // the app level lines up with the session level: icon = a session's chip, its session = a child's chip
        expect(appIcon).toBeCloseTo(plainMark, 0)
        expect(appSessionMark).toBeCloseTo(kidMark, 0)
        expect(appKidMark - appSessionMark).toBeCloseTo(16, 0)
        // a user-folder app stands one step in from its group's title the way a session does from its project's name
        expect(userAppIcon - userAppTitle).toBeCloseTo(16, 0)

        // Chevrons hang in the gutter: the project's ends where its name starts, a row's where its own content starts
        const gutter = async (testId: string, contentX: number) => {
          const box = (await page.getByTestId(testId).boundingBox())!
          return { right: box.x + box.width, contentX }
        }
        const project = (await page.getByTestId('project-fold-alpha').boundingBox())!
        expect(project.x + project.width / 2).toBeLessThan(name)
        expect(project.x + project.width / 2).toBeGreaterThan(name - 16)
        for (const [id, mark] of [[`children-fold-${PARENT}`, parentMark], [`app-fold-${appKey}`, appIcon], [`children-fold-${APP_SESSION}`, appSessionMark]] as const) {
          const { right, contentX } = await gutter(id, mark)
          expect(right).toBeLessThanOrEqual(contentX)
          expect(contentX - right).toBeLessThan(16)
        }

        // Long names truncate instead of widening the sidebar or wrapping onto a second line
        const fit = await page.evaluate((id) => {
          const bar = document.querySelector('[data-testid="sidebar"]')!
          const row = document.querySelector(`[data-testid="app-session-row-${id}"]`)!
          return { spill: bar.scrollWidth - bar.clientWidth, height: row.getBoundingClientRect().height }
        }, APP_KID)
        expect(fit.spill).toBeLessThanOrEqual(0)
        const plainHeight = (await page.getByTestId(`session-row-${plain}`).boundingBox())!.height
        expect(fit.height).toBeCloseTo(plainHeight, 0)

        // A drop line sits on its own row's band, not out in the gutter or across the level above
        for (const id of [plain, KIDS[0]]) {
          const li = page.getByTestId(`session-row-${id}`).locator('xpath=ancestor::li[1]')
          await li.evaluate((el) => {
            const dt = new DataTransfer()
            dt.setData('application/x-cc-session', 'someone-else')
            const r = el.getBoundingClientRect()
            el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 2 }))
          })
          // The line is the row's ::after, drawn once React has the edge; its width is "auto" (not a number) until then
          await expect
            .poll(() => li.evaluate((el) => parseFloat(getComputedStyle(el, '::after').width) - el.getBoundingClientRect().width))
            .toBeCloseTo(0, 0)
          await li.evaluate((el) => el.dispatchEvent(new DragEvent('dragleave', { bubbles: true })))
        }
      })
    }

    /*
     * The fold chevron was a 16px button (10px glyph) in a row, a 20px one in the project row, whose glyph ended on the
     * name's first letter; and the project row aligned its items on the text baseline, which an icon button does not
     * have, so its `+` and `⋯` stood 2-3px off the name's centre. Every part of a row is centred on the row's line now.
     */
    for (const [label, width] of [['narrow', 0], ['wide', 420]] as const) {
      test(`a row's chevron is a large target clear of its title, and every part of a row is centred on its line, ${label} sidebar`, async ({ page }) => {
        const { plain, appKey } = await seed(page)
        // A second project, folded: its row shows the summary of what it hides
        await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/beta'))
        await page.getByTestId('add-project').click()
        await expect(page.getByTestId('project-beta')).toBeVisible()
        const betaSession = await newSession(page, 'beta')
        // A working session is one the folded row counts (an idle one is not worth a sign)
        await page.evaluate((id) => (window as any).__store.setState((s: any) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], state: 'working' } } })), betaSession)
        await page.getByTestId('project-fold-beta').click()
        await expect(page.getByTestId('fold-summary-beta')).toBeVisible()

        await page.evaluate((w) => (window as any).__store.getState().setSidebarWidth(w), width)
        // Every kind of mark a session row carries, and a long name that has to truncate
        await page.evaluate(
          ([plainId, parentId, kidId]) => {
            const long = 'a session name far too long to fit in a narrow sidebar on one line'
            ;(window as any).__store.setState((s: any) => ({
              sessions: Object.fromEntries(
                Object.entries(s.sessions).map(([id, v]: [string, any]) => [
                  id,
                  id === plainId
                    ? { ...v, backgroundTasks: [{ id: 't', status: 'running', description: 'build', ambient: false }] }
                    : id === kidId
                      ? { ...v, merged: true }
                      : id === parentId
                        ? { ...v, name: long, pr: { number: 12, state: 'open', url: 'https://example.test/pull/12' } }
                        : v,
                ]),
              ),
            }))
          },
          [plain, PARENT, KIDS[0]] as const,
        )
        await page.getByTestId(`children-fold-${PARENT}`).click()
        await expect(page.getByTestId(`children-folded-${PARENT}`)).toBeVisible()
        await page.getByTestId(`children-fold-${PARENT}`).click()
        await expect(page.getByTestId(`session-row-${KIDS[0]}`)).toBeVisible()
        await expect(page.getByTestId(`background-mark-${plain}`)).toBeVisible()

        // The line of a row and the centres of what stands on it, all measured on screen
        const centres = (rowId: string, partIds: string[]) =>
          page.evaluate(
            ([row, parts]) => {
              const mid = (el: Element) => {
                const r = el.getBoundingClientRect()
                return r.top + r.height / 2
              }
              const find = (id: string) => {
                const el = document.querySelector(`[data-testid="${id}"]`)
                if (!el) throw new Error(`no ${id}`)
                return el
              }
              const rowEl = find(row)
              const line = rowEl.closest('header') ?? rowEl
              const out: Record<string, number> = { '(row)': mid(line) }
              for (const part of parts) {
                // `title` is the name's text inside the row's button, `mark` the tool chip or the app icon
                const el = part === 'title' ? rowEl.querySelector('.truncate')! : part === 'mark' ? rowEl.firstElementChild! : find(part)
                out[part] = mid(el)
              }
              return out
            },
            [rowId, partIds] as const,
          )
        const expectCentred = async (rowId: string, partIds: string[]) => {
          const c = await centres(rowId, partIds)
          for (const [part, y] of Object.entries(c)) {
            if (part !== '(row)') expect(Math.abs(y - c['(row)']!), `${part} on ${rowId}: ${JSON.stringify(c)}`).toBeLessThanOrEqual(1)
          }
        }

        // Project rows: the arrow, the name, `+`, its options and `⋯` (and, folded, the summary of what is hidden)
        await expectCentred('project-header-alpha', [
          'project-fold-alpha',
          'project-new-session-alpha',
          'project-new-session-options-alpha',
          'project-menu-alpha',
        ])
        await expectCentred('project-header-beta', ['project-fold-beta', 'fold-summary-beta', 'project-new-session-beta', 'project-menu-beta'])
        // Session rows at the three depths, the badges they carry, and the menu at their end
        await expectCentred(`session-row-${plain}`, ['mark', 'title', `background-mark-${plain}`, `session-menu-${plain}`])
        await expectCentred(`session-row-${PARENT}`, ['mark', 'title', `pr-badge-${PARENT}`, `children-fold-${PARENT}`, `session-menu-${PARENT}`])
        await expectCentred(`session-row-${KIDS[0]}`, ['mark', 'title', `merged-badge-${KIDS[0]}`, `session-menu-${KIDS[0]}`])
        await expectCentred(`app-row-${appKey}`, ['mark', 'title', `app-fold-${appKey}`])
        await expectCentred(`app-session-row-${APP_SESSION}`, ['mark', 'title', `children-fold-${APP_SESSION}`, `session-menu-${APP_SESSION}`])
        await expectCentred(`app-session-row-${APP_KID}`, ['mark', 'title', `session-menu-${APP_KID}`])
        await expectCentred('app-row-_user/tool', ['mark', 'title', 'app-fold-_user/tool'])
        await expectCentred('app-session-row-g-user-app-session', ['mark', 'title'])
        // A folded group's count stands on its row's line too
        await page.getByTestId(`children-fold-${PARENT}`).click()
        await expectCentred(`session-row-${PARENT}`, ['mark', 'title', `children-folded-${PARENT}`])
        await page.getByTestId(`app-fold-${appKey}`).click()
        await expectCentred(`app-row-${appKey}`, ['mark', 'title', `app-folded-${appKey}`])
        // "Your apps": its title and the two buttons
        const header = await page.evaluate(() => {
          const mid = (el: Element) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2
          const section = document.querySelector('[data-testid="user-apps"] > header')!
          return [...section.children].map((el) => mid(el.querySelector('button') ?? el) - mid(section))
        })
        for (const d of header) expect(Math.abs(d)).toBeLessThanOrEqual(1)

        // The chevrons: at least 24px square with a 14px glyph, a hit area that is the button itself, and air before the title
        await page.getByTestId(`app-fold-${appKey}`).click()
        await page.getByTestId(`children-fold-${PARENT}`).click()
        // A chevron turns when its group opens; its box is only the glyph's once the turn is over
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
        for (const id of ['project-fold-alpha', `children-fold-${PARENT}`, `app-fold-${appKey}`, `children-fold-${APP_SESSION}`]) {
          const button = page.getByTestId(id)
          const box = (await button.boundingBox())!
          expect(box.width, id).toBeGreaterThanOrEqual(24)
          expect(box.height, id).toBeGreaterThanOrEqual(24)
          const glyph = (await button.locator('svg').boundingBox())!
          expect(glyph.width, `${id} glyph`).toBeGreaterThanOrEqual(14)
          // The whole button answers a press, down to its corners, not only the glyph
          const corners: [number, number][] = [[2, 2], [box.width - 2, 2], [2, box.height - 2], [box.width - 2, box.height - 2]]
          for (const [dx, dy] of corners) {
            const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('button')?.getAttribute('data-testid'), [box.x + dx, box.y + dy])
            expect(hit, `${id} corner ${dx},${dy}`).toBe(id)
          }
          // The title it belongs to starts 6px or more after the glyph
          const titleX = id === 'project-fold-alpha'
            ? (await page.getByTestId('project-header-alpha').boundingBox())!.x
            : await page.evaluate((fold) => {
                const li = document.querySelector(`[data-testid="${fold}"]`)!.closest('li')!
                return li.querySelector('[data-testid^="tool-mark"], [data-testid^="app-row-"] > span')!.getBoundingClientRect().left
              }, id)
          expect(titleX - (glyph.x + glyph.width), `${id} gap to its title`).toBeGreaterThanOrEqual(6)
        }

        // The deeper rows keep their steps with the bigger gutter, and nothing overflows or wraps
        const plainMark = await markX(page, `session-row-${plain}`)
        expect(await markX(page, `session-row-${KIDS[0]}`)).toBeCloseTo(plainMark + 16, 0)
        // (a tooltip the pointer left open is a popup outside the bar, not a row that overflows)
        await page.mouse.move(700, 600)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await expect(page.getByTestId(`children-fold-${PARENT}-tip`)).toHaveCount(0)
        const fit = await page.evaluate(() => {
          const bar = document.querySelector('[data-testid="sidebar"]')!
          return bar.scrollWidth - bar.clientWidth
        })
        expect(fit).toBeLessThanOrEqual(0)
      })
    }

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
