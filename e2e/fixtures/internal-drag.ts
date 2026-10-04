import { expect, test, type Page } from '@playwright/test'
import { newSession, panels, setup } from './project-screen.js'

/**
 * A drag that started inside the app is never a file from the OS (#286).
 *
 * In the packaged app (WKWebView), dragging a grid panel whose conversation showed a screenshot onto another session
 * panel attached the screenshot instead of placing the session: WebKit put the dragged element's images on the drag as
 * files, so the drag carried `Files` next to the session type, and the session panel took it for a file dropped in
 * from Finder.
 *
 * Playwright's engines do not do that. A real mouse drag of a header whose panel holds an `<img>`, measured on
 * 2026-10-04 with Playwright 1.62.1, carried only the types the page set (`application/x-cc-session` and the mark) in
 * both WebKit and Chromium, also with the panel as the drag image; a dragged `<img>` carried `text/html` and
 * `text/uri-list`, no `Files`, and `files.length` was 0 every time. So the engine's part is played here by hand: each
 * drag is dispatched with a `DataTransfer` built in the page that already holds an image `File`, and its own handlers
 * add the rest at `dragstart`, as they would in the app. Steps go one `evaluate` each, because React commits the
 * `dragstart` state in a microtask (see project-screen.ts).
 *
 * Nothing attaching cannot be waited for, so each scenario ends by dropping a real file from the OS on the same spot
 * and waiting for that: attaching is asynchronous, and the screenshot, dropped first, would have landed first.
 */

const SHOT = 'screenshot-in-the-conversation.png'
const OS_FILE = 'from-finder.pdf'

/** Picks up `selector` with a drag that already carries an image file, the way WebKit hands one over */
async function pickUp(page: Page, selector: string, closest?: string) {
  await page.evaluate(
    ({ selector, closest, shot }) => {
      const w = window as any
      w.__dt = new DataTransfer()
      w.__dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], shot, { type: 'image/png' }))
      w.__src = closest
        ? document.querySelector(selector)!.closest(closest)!
        : document.querySelector(selector)!
      w.__src.dispatchEvent(
        new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true, cancelable: true }),
      )
    },
    { selector, closest, shot: SHOT },
  )
}

/**
 * Carries the picked-up drag over `selector` and lets go there, at `x` across `card` (the panel whose half decides
 * before or after), then ends the drag on its source, in the order the browser fires them. Returns the types the drop
 * carried, so a test can say it really had `Files` on it.
 */
async function letGo(page: Page, selector: string, card: string, x = 0.8): Promise<string[]> {
  await page.evaluate(
    ({ selector, card, x }) => {
      const w = window as any
      const r = document.querySelector(card)!.getBoundingClientRect()
      const at = { clientX: r.left + r.width * x, clientY: r.top + r.height / 2 }
      const el = document.querySelector(selector)!
      for (const type of ['dragenter', 'dragover'])
        el.dispatchEvent(
          new DragEvent(type, { dataTransfer: w.__dt, bubbles: true, cancelable: true, ...at }),
        )
    },
    { selector, card, x },
  )
  return page.evaluate(
    ({ selector, card, x }) => {
      const w = window as any
      const r = document.querySelector(card)!.getBoundingClientRect()
      const at = { clientX: r.left + r.width * x, clientY: r.top + r.height / 2 }
      document
        .querySelector(selector)!
        .dispatchEvent(
          new DragEvent('drop', { dataTransfer: w.__dt, bubbles: true, cancelable: true, ...at }),
        )
      w.__src.dispatchEvent(new DragEvent('dragend', { dataTransfer: w.__dt, bubbles: true }))
      return [...w.__dt.types] as string[]
    },
    { selector, card, x },
  )
}

/** A file from Finder dropped on `selector`: the one drop that must still attach */
async function dropOsFile(page: Page, selector: string) {
  await page.evaluate(
    ({ selector, name }) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['content'], name, { type: 'application/pdf' }))
      document
        .querySelector(selector)!
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    { selector, name: OS_FILE },
  )
}

const saved = (page: Page) =>
  page.evaluate(() => ((window as any).__mock.savedAttachments as { name: string }[]).map((a) => a.name))

const gridPanels = (page: Page) =>
  page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId) as string[])

async function openGrid(page: Page, ids: string[]) {
  await page.evaluate(
    (l) =>
      (window as any).__store
        .getState()
        .setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))),
    ids,
  )
  await page.getByTestId('grid-button').click()
  for (const id of ids) await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()
}

/**
 * The screenshot was not attached anywhere: only the file from Finder, dropped after it on the same spot (`at`), was,
 * to the session of the panel it was dropped in (`panel`)
 */
async function onlyTheOsFileAttached(page: Page, at: string, panel: string) {
  await dropOsFile(page, at)
  await expect(page.locator(panel).getByTestId('attachment-list')).toContainText(OS_FILE)
  await expect(page.getByTestId('attachment-list')).toHaveCount(1)
  await expect(page.getByTestId('attachment-list')).not.toContainText(SHOT)
  expect(await saved(page)).toEqual([OS_FILE])
}

const header = (id: string) => `[data-testid="grid-panel-${id}"] [data-testid="pane-header"]`
const chat = (id: string) => `[data-testid="grid-panel-${id}"] [data-testid="chat-stream"]`
const cell = (id: string) => `[data-testid="grid-panel-${id}"]`

/** The scenarios, as a function so they run in Chromium and in WebKit (the desktop app is WKWebView) */
export function internalDragTests(): void {
  test.describe('a drag that started inside the app is never a file from the OS (#286)', () => {
    test('a grid panel carrying a screenshot as a file, dropped on another panel’s conversation, is placed and attaches nothing', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      await openGrid(page, [a, b])

      await pickUp(page, header(a))
      await expect(page.getByTestId(`grid-panel-${a}`)).toHaveClass(/opacity-40/)
      const types = await letGo(page, chat(b), cell(b))
      // The drop really did carry the file, next to the session
      expect(types).toEqual(expect.arrayContaining(['Files', 'application/x-cc-session']))

      await expect.poll(() => gridPanels(page)).toEqual([b, a])
      await expect(page.getByTestId('pane-drop-target')).toHaveCount(0)
      await onlyTheOsFileAttached(page, chat(b), cell(b))
    })

    test('the same drag dropped on the other panel’s composer is placed and attaches nothing', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      await openGrid(page, [a, b])

      await pickUp(page, header(a))
      await letGo(page, `${cell(b)} [data-testid="input-dropzone"]`, cell(b))

      await expect.poll(() => gridPanels(page)).toEqual([b, a])
      await onlyTheOsFileAttached(page, `${cell(b)} [data-testid="input-dropzone"]`, cell(b))
    })

    test('a sidebar session carrying a file, dropped on a grid panel, joins the grid and attaches nothing', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      const c = await newSession(page, 'alpha')
      await openGrid(page, [a, b])

      await pickUp(page, `[data-testid="session-row-${c}"]`, 'li')
      await letGo(page, chat(b), cell(b))

      await expect.poll(() => gridPanels(page)).toEqual([a, b, c])
      await onlyTheOsFileAttached(page, chat(b), cell(b))
    })

    test('something picked up out of a conversation, which no handler of ours types, is not attached where it is dropped', async ({
      page,
    }) => {
      // Selected text with a screenshot in it, or the screenshot itself: the engine starts that drag, not our code,
      // so only the mark every drag gets at dragstart says it is ours
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      await openGrid(page, [a, b])

      await pickUp(page, chat(a))
      const types = await letGo(page, chat(b), cell(b))
      expect(types).toContain('Files')
      expect(types).not.toContain('application/x-cc-session')

      expect(await gridPanels(page)).toEqual([a, b])
      await onlyTheOsFileAttached(page, chat(b), cell(b))
    })

    test('an evidence tab carrying a file, dropped on the session, attaches nothing', async ({ page }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')
      const tab = page.locator('[data-testid^="evidence-tab-"]').first()
      await expect(tab).toBeVisible()
      const id = await tab.getAttribute('data-testid')

      await pickUp(page, `[data-testid="${id}"]`)
      const types = await letGo(page, '[data-testid="chat-stream"]', '[data-testid="session-view"]')
      expect(types).toEqual(expect.arrayContaining(['Files', 'application/x-cc-panel-tab']))

      await onlyTheOsFileAttached(page, '[data-testid="chat-stream"]', '[data-testid="session-view"]')
    })

    test('a project-screen panel carrying a file, dropped on another session panel, is reordered and attaches nothing', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      const b = await newSession(page, 'alpha')
      await page.getByTestId('project-header-alpha').click()
      expect(await panels(page)).toEqual([`session:${a}`, `session:${b}`])

      const panel = (id: string) => `[data-testid="project-panel-session:${id}"]`
      await pickUp(page, `${panel(a)} [data-testid="pane-header"]`)
      await expect(page.locator(panel(a))).toHaveClass(/opacity-40/)
      await letGo(page, `${panel(b)} [data-testid="chat-stream"]`, panel(b))

      await expect.poll(() => panels(page)).toEqual([`session:${b}`, `session:${a}`])
      await onlyTheOsFileAttached(page, `${panel(b)} [data-testid="chat-stream"]`, panel(b))
    })

    test('a sidebar session carrying a file, dropped on the file tree, imports nothing into the project', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      const a = await newSession(page, 'alpha')
      await page.getByTestId('evidence-tab-files').click()
      await expect(page.getByTestId('file-tree')).toBeVisible()

      await pickUp(page, `[data-testid="session-row-${a}"]`, 'li')
      await letGo(page, '[data-testid="file-drop-root"]', '[data-testid="file-drop-root"]')

      // A file from Finder dropped after it still comes in, and is all that does
      await dropOsFile(page, '[data-testid="file-drop-root"]')
      await expect(page.getByTestId(`file-${OS_FILE}`)).toBeVisible()
      await expect(page.getByTestId(`file-${SHOT}`)).toHaveCount(0)
      const files = await page.evaluate(() =>
        (((window as any).__mock.fsState.entries[''] ?? []) as { name: string }[]).map((e) => e.name),
      )
      expect(files).toEqual([OS_FILE])
    })

    test('over a text field the window’s floor lets a drag from inside the app through as text, and still blocks a file from Finder', async ({
      page,
    }) => {
      await setup(page, ['/tmp/alpha'])
      await newSession(page, 'alpha')
      await page.keyboard.press('Meta+k')
      await expect(page.getByTestId('palette-input')).toBeVisible()

      // The palette's field does not preventDefault on its own, so this measures the floor (App.tsx)
      const blocked = await page.evaluate(() => {
        const field = document.querySelector('[data-testid="palette-input"]')!
        const over = (fromInside: boolean) => {
          const dt = new DataTransfer()
          dt.items.add(new File(['x'], 'shot.png', { type: 'image/png' }))
          dt.setData('text/plain', 'selected conversation text')
          if (fromInside) {
            document
              .querySelector('[data-testid="chat-stream"]')!
              .dispatchEvent(
                new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }),
              )
          }
          const e = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
          field.dispatchEvent(e)
          return e.defaultPrevented
        }
        return { fromInside: over(true), fromFinder: over(false) }
      })
      expect(blocked).toEqual({ fromInside: false, fromFinder: true })
    })
  })
}
