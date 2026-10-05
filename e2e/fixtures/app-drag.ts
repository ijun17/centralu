import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { appScreenHtml, startFixtureHost, type FixtureHost } from './app-views.js'
import { newSession } from './project-screen.js'

/**
 * An item dragged out of an app view into a session's composer (#308), run in Chromium (app-drag.spec.ts) and in
 * WebKit (app-drag-webkit.spec.ts).
 *
 * The project-board app's real screen stands on the grid beside a session, in a real frame from the fixture host
 * (the sandbox proxy, an opaque inner frame, and the host's drag relay added to the document by the real ViewHost).
 * A card is dragged with the mouse, so the browser runs the drag itself: only then does the page not hear it (a drag
 * from another origin is not delivered here, agent-host views/drag-relay.ts), and only then does it end with a real
 * `dragend` in the view, the one thing the relay reports.
 */

const BOARD = new URL('../../.centralu/apps/project-board/', import.meta.url)
const BOARD_URI = 'ui://project-board/index.html'
const ISSUE = 'https://example.test/issues/306'
const LINK = `[#306 App panels too narrow](${ISSUE})`

const BOARD_STATE = {
  ok: true,
  project: { title: 'Centralu', url: 'https://example.test/project', number: 1, owner: 'someone' },
  fetchedAt: '2026-10-05T09:00:00Z',
  options: { area: ['ui'], priority: ['High'] },
  columns: ['Needs decision', 'In progress', 'Done'],
  decisionStatus: 'Needs decision',
  items: [
    { itemId: 'item-306', status: 'Needs decision', priority: 'High', area: 'ui', number: 306, title: 'App panels too narrow', url: ISSUE, type: 'issue', draft: false, repository: 'someone/centralu' },
    { itemId: 'item-307', status: 'In progress', priority: 'High', area: 'ui', number: 307, title: 'Another', url: 'https://example.test/issues/307', type: 'issue', draft: false, repository: 'someone/centralu' },
  ],
}

const board = (projectId: string) => ({
  appId: 'project-board',
  projectId,
  dir: '/tmp/alpha/.centralu/apps/project-board',
  name: 'Project board',
  version: '0.1.0',
  description: null,
  home: 'show',
  trusted: true,
  status: 'running',
  error: null,
  warnings: [],
})

const viewKey = (pid: string) => `grid:${pid}/project-board`
const boardView = (page: Page, pid: string): FrameLocator =>
  page.getByTestId(`pinned-app-${viewKey(pid)}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
const composer = (page: Page, sessionId: string): Locator => page.getByTestId(`grid-panel-${sessionId}`).locator('[data-testid="input-dropzone"] textarea')
const notice = (page: Page, sessionId: string): Locator => page.getByTestId(`grid-panel-${sessionId}`).getByTestId('composer-app-notice')
const reachAsks = (page: Page) => page.evaluate(() => ((window as any).__mock.reachAsks as unknown[]).length)

/** Drags from one point to another with the mouse, in steps, the way a hand does */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 8, { steps: 4 })
  await page.mouse.move(to.x + 10, to.y, { steps: 12 })
  await page.mouse.move(to.x, to.y, { steps: 3 })
  await page.mouse.up()
}

const middle = async (l: Locator) => {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Drags board card #306 onto the middle of a session's panel (its conversation: the composer is folded on the grid) */
async function dragCardTo(page: Page, pid: string, sessionId: string) {
  const card = boardView(page, pid).locator('.card[data-number="306"]')
  await expect(card).toBeVisible()
  await drag(page, await middle(card), await middle(page.getByTestId(`grid-panel-${sessionId}`).getByTestId('session-view')))
}

/** Sets a session's draft and puts the caret at `caret`, as if the person had typed it and clicked there */
async function draftWithCaret(page: Page, sessionId: string, text: string, caret: number) {
  await page.evaluate(({ s, t }) => (window as any).__store.getState().setDraft(s, { text: t, attachments: [] }), { s: sessionId, t: text })
  const field = composer(page, sessionId)
  await expect(field).toHaveValue(text)
  await field.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), caret)
}

export function appDragTests(): void {
  test.describe('an item dragged out of an app view into a composer (#308)', () => {
    let fx: FixtureHost
    test.beforeAll(async () => {
      fx = await startFixtureHost({ [`project-board ${BOARD_URI}`]: { html: appScreenHtml(BOARD) } })
    })
    test.afterAll(async () => {
      await fx?.close()
    })

    test.beforeEach(async ({ page }) => {
      await page.exposeFunction('__viewFrame', (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
        fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
      )
      await page.exposeFunction('__openView', (appId: string, projectId: string | null) => {
        const instanceId = fx.open({ projectId, appId }, BOARD_URI)
        return { instanceId, tool: 'show', resourceUri: BOARD_URI, toolInput: {}, toolResult: { content: [{ type: 'text', text: 'board' }], structuredContent: BOARD_STATE }, runId: `run-${instanceId}` }
      })
    })

    /** Projects alpha (with the board) and beta, a session in each, and the grid: alpha's session, beta's, the board */
    async function boardBesideSessions(page: Page): Promise<{ pid: string; alpha: string; beta: string }> {
      await page.goto('/?mock=1')
      await page.evaluate((state) => {
        const w = window as any
        w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
        w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
        w.__mock.appToolHandler = async (_app: string, tool: string) =>
          tool === 'show' ? { content: [{ type: 'text', text: 'board' }], structuredContent: state } : { content: [{ type: 'text', text: 'ok' }] }
      }, BOARD_STATE)
      for (const dir of ['/tmp/alpha', '/tmp/beta']) {
        await page.evaluate((d) => ((window as any).__mock.nextPickedDirectory = d), dir)
        await page.getByTestId('add-project').click()
        await page.getByTestId(`trust-ask-yes-${dir.slice(5)}`).click()
      }
      const pid = await page.evaluate(() => {
        const projects = Object.values((window as any).__store.getState().projects) as { id: string; name: string }[]
        return projects.find((p) => p.name === 'alpha')!.id
      })
      await page.evaluate((list) => (window as any).__mock.setExternalApps(list), [board(pid)])
      const alpha = await newSession(page, 'alpha')
      const beta = await newSession(page, 'beta')
      await page.evaluate(
        ({ a, b, p }) =>
          (window as any).__store.getState().setGridPanels([
            { kind: 'session', sessionId: a },
            { kind: 'session', sessionId: b },
            { kind: 'app', projectId: p, appId: 'project-board' },
          ]),
        { a: alpha, b: beta, p: pid },
      )
      await page.getByTestId('grid-button').click()
      await expect(page.getByTestId(`pinned-app-${viewKey(pid)}`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
      await expect(boardView(page, pid).locator('.card')).toHaveCount(2)
      return { pid, alpha, beta }
    }

    test('a board card dropped on a session goes into its composer as a Markdown link at the caret', async ({ page }) => {
      const { pid, alpha } = await boardBesideSessions(page)
      await draftWithCaret(page, alpha, 'Look at please', 'Look at '.length)
      await dragCardTo(page, pid, alpha)
      await expect(composer(page, alpha)).toHaveValue(`Look at ${LINK} please`)
      // The caret stands right after the link and the space it brought, so typing goes on from there
      await expect.poll(() => composer(page, alpha).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(`Look at ${LINK} `.length)
      // A session of the board's own project can use its tools: no line under the link
      await expect.poll(() => reachAsks(page)).toBe(1)
      await expect(notice(page, alpha)).toHaveCount(0)
    })

    test('a session that cannot use the board\'s tools still gets the link, with a line saying why and what fixes it', async ({ page }) => {
      const { pid, alpha, beta } = await boardBesideSessions(page)
      await dragCardTo(page, pid, beta)
      await expect(composer(page, beta)).toHaveValue(`${LINK} `)
      await expect(notice(page, beta)).toHaveAttribute('data-reason', 'other-project')
      await expect(notice(page, beta)).toHaveText("This session can't use Project board's tools: the app belongs to alpha. Ask in a session of alpha to use them.")
      // Dismissed, it goes
      await notice(page, beta).getByTestId('composer-app-notice-dismiss').click()
      await expect(notice(page, beta)).toHaveCount(0)

      // A Codex thread that started before the board was attached (the host's answer, stood for by the mock)
      await page.evaluate((key) => (window as any).__mock.appAttachments.set(key, 'restart'), `${alpha} ${pid}/project-board`)
      await dragCardTo(page, pid, alpha)
      await expect(composer(page, alpha)).toHaveValue(`${LINK} `)
      await expect(notice(page, alpha)).toHaveAttribute('data-reason', 'restart')
      await expect(notice(page, alpha)).toContainText('Restart the session to attach it.')
    })

    test('a view that only says a drag happened, with no press in it, puts nothing into a composer', async ({ page, browserName }) => {
      const { pid, alpha } = await boardBesideSessions(page)
      const target = await middle(page.getByTestId(`grid-panel-${alpha}`).getByTestId('session-view'))
      const frame = (await page.getByTestId(`pinned-app-${viewKey(pid)}`).getByTestId('app-frame-iframe').boundingBox())!
      // In the frame's own coordinates for WebKit (inside its 1 px border), the page's for Chromium: either way, over the session
      const at = browserName === 'webkit' ? { x: target.x - frame.x - 1, y: target.y - frame.y - 1 } : target
      // Counted on the page's window, after the bridge's own listener: once both have arrived, both have been handled
      await page.evaluate(() => {
        const w = window as any
        w.__relayed = 0
        window.addEventListener('message', (e) => {
          if (e.data?.method === 'centralu/notifications/drag') w.__relayed++
        })
      })
      // The app's own script posts the relay's two messages, pointing at the session, while the person is elsewhere
      await boardView(page, pid)
        .locator('body')
        .evaluate((_, { x, y }) => {
          const method = 'centralu/notifications/drag'
          window.parent.postMessage({ jsonrpc: '2.0', method, params: { phase: 'start', uri: 'https://evil.test/', text: 'click me' } }, '*')
          window.parent.postMessage({ jsonrpc: '2.0', method, params: { phase: 'end', x, y, width: innerWidth, height: innerHeight } }, '*')
        }, at)
      await expect.poll(() => page.evaluate(() => (window as any).__relayed)).toBe(2)
      await expect(composer(page, alpha)).toHaveValue('')
      expect(await reachAsks(page)).toBe(0)
    })

    test('a card moved between the board\'s own columns stays the board\'s: no composer takes it', async ({ page }) => {
      // Tall enough that the grid's board panel shows the card and the next column under its header
      await page.setViewportSize({ width: 1280, height: 1200 })
      const { pid, alpha } = await boardBesideSessions(page)
      const v = boardView(page, pid)
      // A grid panel is narrow, so the board stacks its columns (#306): the next column's head is just below the card
      const head = v.locator('.column[data-status="In progress"] .col-head')
      await expect(head).toBeInViewport()
      await drag(page, await middle(v.locator('.card[data-number="306"]')), await middle(head))
      await expect
        .poll(() => page.evaluate(() => ((window as any).__mock.appToolCalls as { tool: string }[]).filter((c) => c.tool === 'set_item_fields').length))
        .toBe(1)
      await expect(composer(page, alpha)).toHaveValue('')
      expect(await reachAsks(page)).toBe(0)
    })

    test('a link dropped on the composer itself goes in at the caret; a file still attaches, and a session drag still adds nothing', async ({ page }) => {
      const { alpha } = await boardBesideSessions(page)
      await draftWithCaret(page, alpha, 'see', 3)
      const zone = page.getByTestId(`grid-panel-${alpha}`).getByTestId('input-dropzone')
      const link = await page.evaluateHandle((url) => {
        const dt = new DataTransfer()
        dt.setData('text/uri-list', url)
        dt.setData('text/plain', '#306 App panels too narrow')
        return dt
      }, ISSUE)
      await zone.dispatchEvent('drop', { dataTransfer: link })
      await expect(composer(page, alpha)).toHaveValue(`see ${LINK} `)

      // A session dragged onto it (#286) carries its own type: the composer leaves it to the grid
      const session = await page.evaluateHandle(() => {
        const dt = new DataTransfer()
        dt.setData('application/x-cc-session', 'x')
        dt.setData('text/plain', 'a session')
        return dt
      })
      await zone.dispatchEvent('drop', { dataTransfer: session })
      await expect(composer(page, alpha)).toHaveValue(`see ${LINK} `)

      // An OS file is still an attachment, not text — even carrying its address as a uri-list
      const file = await page.evaluateHandle(() => {
        const dt = new DataTransfer()
        dt.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' }))
        dt.setData('text/uri-list', 'file:///tmp/note.txt')
        return dt
      })
      await zone.dispatchEvent('drop', { dataTransfer: file })
      await expect(page.getByTestId(`grid-panel-${alpha}`).getByTestId('attachment-list')).toContainText('note.txt')
      await expect(composer(page, alpha)).toHaveValue(`see ${LINK} `)
      // A drop on the composer is no app's: nobody is asked whether the session reaches one
      expect(await reachAsks(page)).toBe(0)
    })
  })
}
