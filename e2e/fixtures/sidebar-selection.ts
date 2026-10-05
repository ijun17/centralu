import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * The sidebar says which project is on screen (user request, 2026-10-01). The open project's whole group is tinted —
 * `data-selected` on its section — and the open row inside it is marked with `aria-current="page"`: the project's
 * name row for its screen, the session's row for one of its sessions. The grid and the orchestrator tint nothing;
 * they light their own buttons.
 *
 * Asserted through those attributes, never through pixels: the colours are the palette's to adjust.
 *
 * A function, like `sidebarDropTests`, because it runs in Chromium and in WebKit (sidebar-selection-webkit.spec.ts).
 * The desktop app is WKWebView, and the band on the name row is held in place by a negative margin — layout the two
 * engines compute separately.
 */

const tinted = (page: Page) => page.getByTestId('sidebar').locator('section[data-selected]')
const marked = (page: Page) => page.getByTestId('sidebar').locator('[aria-current]')

/** Where every sidebar row and group stands, and whether anything spills sideways */
const layout = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-testid="sidebar"]')!
    const boxes = [
      ...bar.querySelectorAll(
        'section, section > header, [data-testid^="project-fold-"], [data-testid^="project-header-"], [data-testid^="session-row-"]',
      ),
    ].map((el) => {
      const r = el.getBoundingClientRect()
      return `${el.getAttribute('data-testid') ?? el.tagName} ${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)}`
    })
    return { boxes, overflow: bar.scrollWidth - bar.clientWidth }
  })

export function sidebarSelectionTests(): void {
  test.describe('the sidebar shows which project is open', () => {
    test('opening a project screen tints that project’s group and marks its name row', async ({ page }) => {
      await setup(page, ['/tmp/alpha', '/tmp/beta'])
      const a = await newSession(page, 'alpha')

      await page.getByTestId('project-header-alpha').click()
      await expect(page.getByTestId('project-view-name')).toHaveText('alpha')
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')
      await expect(tinted(page)).toHaveCount(1)
      await expect(page.getByTestId('project-header-alpha')).toHaveAttribute('aria-current', 'page')
      // Its session stands inside the tinted group, but it is not what is open
      await expect(page.getByTestId(`session-row-${a}`)).not.toHaveAttribute('aria-current', 'page')
      await expect(marked(page)).toHaveCount(1)

      // Another project's screen takes both layers with it
      await page.getByTestId('project-header-beta').click()
      await expect(page.getByTestId('project-view-name')).toHaveText('beta')
      await expect(page.getByTestId('project-beta')).toHaveAttribute('data-selected', 'true')
      await expect(page.getByTestId('project-header-beta')).toHaveAttribute('aria-current', 'page')
      await expect(tinted(page)).toHaveCount(1)
      await expect(marked(page)).toHaveCount(1)
    })

    test('opening an app of a project tints its group and marks the app’s row; an app in the user folder tints nothing', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha', '/tmp/beta'])
      const pid = await page.evaluate(
        () =>
          (Object.values((window as any).__store.getState().projects) as { id: string; name: string }[]).find(
            (p) => p.name === 'alpha',
          )!.id,
      )
      await page.evaluate(
        (projectId) =>
          (window as any).__mock.setExternalApps(
            [projectId, null].map((owner) => ({
              appId: 'slider',
              projectId: owner,
              dir: owner ? '/tmp/alpha/.centralu/apps/slider' : '/tmp/user-apps/slider',
              name: 'Slider',
              version: '0.1.0',
              description: null,
              home: 'home',
              trusted: true,
              status: 'stopped',
              error: null,
              warnings: [],
            })),
          ),
        pid,
      )

      await page.getByTestId(`app-row-${pid}/slider`).click()
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')
      await expect(tinted(page)).toHaveCount(1)
      await expect(page.getByTestId(`app-row-${pid}/slider`)).toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('project-header-alpha')).not.toHaveAttribute('aria-current', 'page')
      await expect(marked(page)).toHaveCount(1)

      await page.getByTestId('user-apps-list').getByRole('button', { name: /Slider/ }).click()
      await expect(tinted(page)).toHaveCount(0)
    })

    test('opening a session of a project tints its group and marks the session’s row, not the name row', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha', '/tmp/beta'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'beta')

      await page.getByTestId(`session-row-${a}`).click()
      await expect(page.getByTestId('session-view')).toBeVisible()
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')
      await expect(tinted(page)).toHaveCount(1)
      await expect(page.getByTestId(`session-row-${a}`)).toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('project-header-alpha')).not.toHaveAttribute('aria-current', 'page')
      await expect(marked(page)).toHaveCount(1)

      await page.getByTestId(`session-row-${b}`).click()
      await expect(page.getByTestId('project-beta')).toHaveAttribute('data-selected', 'true')
      await expect(page.getByTestId(`session-row-${b}`)).toHaveAttribute('aria-current', 'page')
      await expect(tinted(page)).toHaveCount(1)
      await expect(marked(page)).toHaveCount(1)
    })

    test('the grid and the orchestrator tint nothing, whichever project was open before them', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')
      // A session of alpha is open — alpha is tinted, so what follows is a tint going away, not one never drawn
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')

      await page.getByTestId('grid-button').click()
      await expect(page.getByTestId('grid-button')).toHaveAttribute('aria-pressed', 'true')
      await expect(tinted(page)).toHaveCount(0)
      await expect(marked(page)).toHaveCount(0)

      await page.getByTestId('project-header-alpha').click()
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')
      await page.getByTestId('orchestrator-button').click()
      await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('aria-pressed', 'true')
      await expect(tinted(page)).toHaveCount(0)
      await expect(marked(page)).toHaveCount(0)
    })

    /*
     * A coordinator is a session of no project, opened in the focus lane. Opening it leaves the store's
     * `focusedProjectId` on the project looked at last — a tint read from that would point at alpha while the
     * screen shows a session that is not alpha's.
     */
    test('a session with no project tints nothing, though a project was open just before it', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      const worker = await newSession(page, 'alpha')
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')

      // Nothing in the app creates a coordinator since the control app went (#97); one loaded from an
      // older store is planted the way the host would send it
      const coordinator = await page.evaluate((memberId) => {
        const m = (window as any).__mock
        const id = 'coord-plain-1'
        const session = {
          ...m.sessions.get(memberId),
          id,
          projectId: null,
          kind: 'coordinator',
          name: 'Coordinate the work',
          autoNamed: false,
          worktree: null,
          parentSessionId: null,
          scopeSessionIds: [memberId],
        }
        m.sessions.set(id, session)
        m.emit({ type: 'session_created', sessionId: id, session })
        return id
      }, worker)
      await page.getByTestId(`homeless-row-${coordinator}`).click()
      await expect(page.getByTestId('session-view')).toBeVisible()
      // The focus lane, showing a session with no project — the case under test
      expect(
        await page.evaluate(() => {
          const s = (window as any).__store.getState()
          return { view: s.view, project: s.sessions[s.focusedSessionId].projectId }
        }),
      ).toEqual({ view: 'focus', project: null })

      await expect(tinted(page)).toHaveCount(0)
      await expect(page.getByTestId(`session-row-${worker}`)).not.toHaveAttribute('aria-current', 'page')
    })

    test('a folded project that is open still shows its tint, on its name row', async ({ page }) => {
      await setup(page, ['/tmp/alpha', '/tmp/beta'])
      const a = await newSession(page, 'alpha')
      await page.getByTestId('project-fold-alpha').click()
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')

      // Its screen: the name row is marked, and folding is left alone (#205 — the name opens, the arrow folds)
      await page.getByTestId('project-header-alpha').click()
      await expect(page.getByTestId('project-view-name')).toHaveText('alpha')
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')
      await expect(page.getByTestId('project-header-alpha')).toHaveAttribute('aria-current', 'page')

      /*
       * One of its sessions, with the project still folded — the way a restored workspace comes back (`reveal:
       * false`; picking a session from the sidebar or the inbox unfolds it instead). There is no session row to
       * mark, so the group's tint is the only thing that says this project is on screen.
       */
      await page.evaluate((id) => (window as any).__store.getState().focusSession(id, { reveal: false }), a)
      await expect(page.getByTestId('session-view')).toBeVisible()
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-folded', 'true')
      await expect(page.getByTestId(`session-row-${a}`)).toHaveCount(0)
      await expect(page.getByTestId('project-alpha')).toHaveAttribute('data-selected', 'true')
      await expect(page.getByTestId('project-header-alpha')).not.toHaveAttribute('aria-current', 'page')
    })

    test('marking the open project moves no row and spills nothing sideways, at the narrowest sidebar', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha', '/tmp/beta'])
      const a = await newSession(page, 'alpha')
      await newSession(page, 'beta')
      await page.evaluate(() => (window as any).__store.getState().setSidebarWidth(0)) // Clamps to the minimum
      await expect.poll(async () => Math.round((await page.getByTestId('sidebar').boundingBox())!.width)).toBe(180)

      // Nothing open in the sidebar: the grid
      await page.getByTestId('grid-button').click()
      await expect(tinted(page)).toHaveCount(0)
      const plain = await layout(page)
      expect(plain.overflow).toBe(0)

      await page.getByTestId('project-header-alpha').click()
      await expect(page.getByTestId('project-header-alpha')).toHaveAttribute('aria-current', 'page')
      expect(await layout(page)).toEqual(plain)

      await page.getByTestId(`session-row-${a}`).click()
      await expect(page.getByTestId(`session-row-${a}`)).toHaveAttribute('aria-current', 'page')
      expect(await layout(page)).toEqual(plain)
    })
  })
}
