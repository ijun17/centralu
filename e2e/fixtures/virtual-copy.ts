import { expect, test, type Page } from '@playwright/test'
import { copied, pressCopy, watchCopies } from './clipboard.js'
import { newSession, setup } from './project-screen.js'

/**
 * Copy and ⌘A in the two panes whose rows are virtualized, the code viewer and the diff (#428): one rule, written once
 * (`useVirtualCopy`). Before, the diff let the browser copy a selection that ended outside it (chrome included), kept an
 * anchor from the previous file, and painted its sticky file band under ⌘A; the viewer did none of those.
 *
 * A selection is set by hand (`setBaseAndExtent`): what is under test is what the handlers make of a selection, and a
 * drag that ends in the app's chrome is engine-dependent (Chromium keeps a drag's focus inside the area it began in,
 * WebKit does not, #424).
 *
 * A function because it runs in Chromium and in WebKit (virtual-copy-webkit.spec.ts): the desktop app is WKWebView.
 */

const DIFF = Array.from({ length: 12 }, (_, i) => `${i % 2 ? '+' : '-'}row ${i}`).join('\n')
/** With a file header, so the sticky file band the diff draws over its rows is on screen */
const DIFF_TEXT = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,12 +1,12 @@\n${DIFF}`

async function openFile(page: Page, names: string[]) {
  await watchCopies(page)
  await setup(page, ['/tmp/alpha'])
  await page.evaluate((files) => {
    const m = (window as any).__mock
    m.fsState.entries[''] = files.map((name) => ({ name, path: name, isDir: false, ignored: false }))
    m.fs.readFile = async (_root: string, path: string) => {
      const text = Array.from({ length: 200 }, (_, i) => `${path} line ${i}`).join('\n')
      return { text, truncated: false, binary: false, bytes: text.length }
    }
  }, names)
  await newSession(page, 'alpha')
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId(`file-${names[0]}`).click()
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect(page.locator('[data-testid="code-viewer"] [data-line="5"]')).toBeVisible()
}

async function openDiff(page: Page) {
  await watchCopies(page)
  await setup(page, ['/tmp/alpha'])
  await page.evaluate((d) => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = d
  }, DIFF_TEXT)
  await newSession(page, 'alpha')
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  await expect(page.locator('[data-testid="diff-view"] [data-line="8"]')).toBeVisible()
  await expect(page.getByTestId('diff-current-file-band')).toBeVisible()
}

/** From the start of row `line` of the pane to the first text of `outside`, an element outside the pane */
const select = (page: Page, pane: string, line: number, outside: string) =>
  page.evaluate(
    ([paneId, row, out]) => {
      const code = document.querySelector(`[data-testid="${paneId}"] [data-line="${row}"] [data-code]`)!
      const there = document.querySelector(`[data-testid="${out}"]`)!
      const sel = document.getSelection()!
      sel.setBaseAndExtent(code.firstChild!, 0, there.firstChild ?? there, 0)
    },
    [pane, line, outside] as const,
  )

/** Some text of the app's chrome, in no pane: somebody else's copy */
const selectOutside = (page: Page) =>
  page.evaluate(() => document.getSelection()!.selectAllChildren(document.querySelector('[data-testid="evidence-project"]')!))

/** A caret in the middle of a row, and a moment for the engine to report it: the start of a selection the pane remembers */
async function caretIn(page: Page, pane: string, line: number) {
  await page.evaluate(
    ([paneId, row]) => {
      const code = document.querySelector(`[data-testid="${paneId}"] [data-line="${row}"] [data-code]`)!
      document.getSelection()!.collapse(code.firstChild!, 2)
    },
    [pane, line] as const,
  )
  await page.waitForTimeout(100)
}

const copyOf = async (page: Page) => {
  await pressCopy(page)
  return copied(page)
}

export function virtualCopyTests(): void {
  test.describe('copy in the virtualized panes (#428)', () => {
    test('viewer: a selection that ends outside the pane copies the pane part only', async ({ page }) => {
      await openFile(page, ['a.ts'])
      await select(page, 'code-viewer', 5, 'viewer-open-ide')
      const text = await copyOf(page)
      expect(text.startsWith('a.ts line 0\na.ts line 1\n')).toBe(true)
      expect(text.endsWith('a.ts line 4\n')).toBe(true)
      expect(text).not.toContain('Open in IDE')
    })

    test('diff: a selection that ends outside the pane copies the pane part only, as the viewer does', async ({ page }) => {
      await openDiff(page)
      await select(page, 'diff-view', 8, 'open-in-viewer')
      const text = await copyOf(page)
      expect(text.startsWith('diff --git a/src/a.ts b/src/a.ts\n')).toBe(true)
      expect(text).toContain('-row 0\n+row 1\n')
      expect(text).not.toContain('Show all')
    })

    test('viewer: a selection that begins outside the pane does not borrow the anchor of an earlier one', async ({ page }) => {
      await openFile(page, ['a.ts', 'b.ts'])
      // A click in line 3 of a.ts: the caret there is remembered as the anchor of a selection
      await page.locator('[data-testid="code-viewer"] [data-line="3"] [data-code]').click()
      await page.getByTestId('file-b.ts').click()
      await expect(page.locator('[data-testid="code-viewer"] [data-line="10"] [data-code]')).toHaveText('b.ts line 10')
      // A new selection begins in the header (the caret collapses there, the engine reports it) and is dragged into the
      // rows. Its start is the pane's top edge, not line 3 of the file left behind.
      await page.evaluate(() => {
        const out = document.querySelector('[data-testid="viewer-open-ide"]')!
        document.getSelection()!.collapse(out.firstChild ?? out, 0)
      })
      await page.waitForTimeout(100)
      await page.evaluate(() => {
        const row = document.querySelector('[data-testid="code-viewer"] [data-line="10"] [data-code]')!
        document.getSelection()!.extend(row.firstChild!, 4)
      })
      const text = await copyOf(page)
      expect(text.startsWith('b.ts line 0\n')).toBe(true)
      expect(text.endsWith('b.ts')).toBe(true)
    })

    test('viewer: a selection made outside the pane after one inside it is left to the browser', async ({ page }) => {
      await openFile(page, ['a.ts'])
      await caretIn(page, 'code-viewer', 3)
      await selectOutside(page)
      await pressCopy(page)
      await expect(copied(page)).rejects.toThrow('left this copy to the browser')
    })

    test('diff: a selection made outside the pane after one inside it is left to the browser', async ({ page }) => {
      await openDiff(page)
      await caretIn(page, 'diff-view', 6)
      await selectOutside(page)
      await pressCopy(page)
      await expect(copied(page)).rejects.toThrow('left this copy to the browser')
    })

    test('viewer: a page-wide select-all copies the rows, not the range an earlier caret in the pane left behind', async ({ page }) => {
      await openFile(page, ['a.ts'])
      // A caret in row 7 col 2 is remembered as an anchor; then everything on the page is selected, as ⌘A does outside the pane
      await caretIn(page, 'code-viewer', 7)
      await page.evaluate(() => document.getSelection()!.selectAllChildren(document.body))
      const text = await copyOf(page)
      const copied = text.split('\n')
      expect(copied[0]).toBe('a.ts line 0')
      expect(copied.at(-1)).toMatch(/^a\.ts line \d+$/)
      expect(copied.length).toBeGreaterThan(20)
    })

    /*
     * ⌘A's claim on the clipboard lasts only while its selection does (#842 item 9). It ended on a mouse press only, so a
     * selection made afterwards without the mouse, anywhere, copied as the whole file.
     */
    test('viewer: after ⌘A, a selection made elsewhere without the mouse is not copied as the whole file (#842 item 9)', async ({ page }) => {
      await openFile(page, ['a.ts'])
      await page.getByTestId('code-viewer').getByRole('region', { name: 'Code' }).focus()
      await page.keyboard.press('ControlOrMeta+a')
      expect(await copyOf(page)).toMatch(/^a\.ts line 0\n[\s\S]*a\.ts line 199$/)
      await selectOutside(page)
      await page.waitForTimeout(100)
      await pressCopy(page)
      await expect(copied(page)).rejects.toThrow('left this copy to the browser')
    })

    test('viewer: ⌘A is read by the key, so the A key on a Korean layout selects the whole file (#842 item 14)', async ({ page }) => {
      await openFile(page, ['a.ts'])
      await page.getByTestId('code-viewer').getByRole('region', { name: 'Code' }).focus()
      // The A key on a Korean (2-set) layout reports ㅁ as its key
      await page.evaluate(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㅁ', code: 'KeyA', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }))
      })
      expect(await copyOf(page)).toMatch(/^a\.ts line 0\n[\s\S]*a\.ts line 199$/)
    })

    test('diff: ⌘A highlights the rows only, and copies the whole diff', async ({ page }) => {
      await openDiff(page)
      await page.locator('[data-testid="diff-view"] [data-line="3"] [data-code]').click()
      await page.keyboard.press('ControlOrMeta+a')
      const painted = await page.evaluate(() => {
        const sel = document.getSelection()!
        const band = document.querySelector('[data-testid="diff-current-file-band"]')
        const rows = document.querySelector('[data-testid="diff-view"] [data-line="3"]')!
        return { band: band ? sel.containsNode(band, true) : null, rows: sel.containsNode(rows, true) }
      })
      expect(painted.rows).toBe(true)
      expect(painted.band).not.toBe(true)
      expect(await copyOf(page)).toBe(DIFF_TEXT)
    })
  })
}
