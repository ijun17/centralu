import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * A record of every colour the main screens paint, for changes that must not move a pixel (#312).
 *
 * Renaming the colour tokens, collapsing arbitrary values onto tokens, or building a theme engine
 * on top of them is only safe if the screen comes out the same. This walks the demo scenes and
 * records, for every element and its pseudo-elements, the computed value of each colour-bearing
 * property (including the scrollbar thumb and the selection highlight where the engine reports
 * them), plus one screenshot per scene to look at. Run it before and after a change and compare
 * the two folders:
 *
 *   STYLE_SNAPSHOT_OUT=/tmp/before pnpm exec playwright test --config e2e/style-snapshot.config.ts
 *   (make the change)
 *   STYLE_SNAPSHOT_OUT=/tmp/after pnpm exec playwright test --config e2e/style-snapshot.config.ts
 *   node scripts/style-snapshot-diff.mjs /tmp/before /tmp/after
 *
 * `STYLE_SNAPSHOT_BROWSER=webkit` records the same scenes in WebKit, the engine the desktop app
 * runs in. Without `STYLE_SNAPSHOT_OUT` every test here is skipped, so it costs `pnpm e2e` nothing.
 */
const OUT = process.env.STYLE_SNAPSHOT_OUT
const BROWSER = process.env.STYLE_SNAPSHOT_BROWSER === 'webkit' ? 'webkit' : 'chromium'

test.skip(!OUT, 'records only when STYLE_SNAPSHOT_OUT names a folder')
test.use({ browserName: BROWSER, viewport: { width: 1440, height: 900 } })
// A scene opens several layers in a row; the default 20s is tight on a busy machine.
test.setTimeout(60_000)

/** Every scene runs on a page clock that starts here, see freeze() */
const CLOCK_START = Date.parse('2026-10-01T09:00:00Z')
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: CLOCK_START })
})

/** Everything that can carry a colour. Layout and opacity are left out: they are not what a colour change moves. */
const PROPS = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'box-shadow',
  'text-shadow',
  'outline-color',
  'outline-style',
  'text-decoration-color',
  'caret-color',
  'accent-color',
  'fill',
  'stroke',
  'stop-color',
  'column-rule-color',
] as const

/**
 * Collects the computed colours of every element in the page. Values that are the property's
 * "nothing here" are dropped to keep the file small; a value that appears or disappears still
 * shows up as a difference, because the key is then missing on one side.
 */
function collect(props: readonly string[]): Record<string, Record<string, string>> {
  const EMPTY = new Set(['none', 'rgba(0, 0, 0, 0)', 'transparent', 'auto', 'normal', ''])
  const out: Record<string, Record<string, string>> = {}
  const keyOf = (el: Element): string => {
    const parts: string[] = []
    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      const index = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0
      const id = e.getAttribute('data-testid')
      parts.unshift(`${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}:${index}`)
    }
    return parts.join('>') || 'html'
  }
  const record = (key: string, style: CSSStyleDeclaration, extra: readonly string[] = []) => {
    const entry: Record<string, string> = {}
    for (const p of [...props, ...extra]) {
      const v = style.getPropertyValue(p)
      // outline-color always resolves to a colour; it only paints when there is an outline.
      if (p === 'outline-color' && style.getPropertyValue('outline-style') === 'none') continue
      if (!EMPTY.has(v)) entry[p] = v
    }
    if (Object.keys(entry).length) out[key] = entry
  }
  for (const el of [document.documentElement, ...document.querySelectorAll('*')]) {
    const key = keyOf(el)
    record(key, getComputedStyle(el))
    for (const pseudo of ['::before', '::after']) {
      const s = getComputedStyle(el, pseudo)
      if (s.content !== 'none' && s.content !== 'normal') record(key + pseudo, s)
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      record(key + '::placeholder', getComputedStyle(el, '::placeholder'))
    }
    if (getComputedStyle(el).display === 'list-item') record(key + '::marker', getComputedStyle(el, '::marker'))
    // The scrollbar — its size and the thumb's inset and rounding are theme tokens too — and,
    // below, the selection highlight, where the engine reports them
    if (el.scrollHeight > el.clientHeight) {
      record(key + '::-webkit-scrollbar', getComputedStyle(el, '::-webkit-scrollbar'), ['width', 'height'])
      record(key + '::-webkit-scrollbar-track', getComputedStyle(el, '::-webkit-scrollbar-track'))
      record(key + '::-webkit-scrollbar-thumb', getComputedStyle(el, '::-webkit-scrollbar-thumb'), [
        'border-top-width',
        'border-top-style',
        'border-top-left-radius',
        'background-clip',
      ])
    }
  }
  record('html::selection', getComputedStyle(document.body, '::selection'))
  return out
}

/**
 * Freezes the page so two runs record the same instant: no transitions half-way through a
 * colour, no rotating plate, no breathing. Both the before and the after run do this, so it does
 * not hide a difference between them.
 */
async function freeze(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  })
  await page.mouse.move(720, 2)
  await page.evaluate(() => document.fonts.ready)
  // A working session's row counts the seconds of its turn and adds to what it says as they
  // pass, so a scene that took longer would record more of it. Every scene stops the clock at
  // the same instant after it started.
  await page.clock.pauseAt(CLOCK_START + 5 * 60_000)
  // The conversation follows its tail and the virtual lists measure rows after they mount, so
  // where a list ends up scrolled depends on timing, and two identical runs could screenshot
  // different scroll positions. Every vertical scroller is pinned to its end, again and again,
  // until nothing has moved for a few checks in a row. (The waits are on this side: the page's
  // own timers are stopped.)
  let last = ''
  let still = 0
  for (let i = 0; i < 60 && still < 4; i++) {
    const now = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight)
      for (const e of scrollers) {
        const overflow = getComputedStyle(e).overflowY
        if (overflow === 'auto' || overflow === 'scroll') e.scrollTop = e.scrollHeight
      }
      return scrollers.map((e) => `${e.scrollTop},${e.scrollHeight}`).join('|')
    })
    still = now === last ? still + 1 : 0
    last = now
    await page.waitForTimeout(100)
  }
}

async function snapshot(page: Page, scene: string): Promise<void> {
  await freeze(page)
  const dir = join(OUT!, BROWSER)
  mkdirSync(dir, { recursive: true })
  const styles = await page.evaluate(collect, PROPS)
  writeFileSync(join(dir, `${scene}.json`), JSON.stringify(styles, null, 1))
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  writeFileSync(join(dir, `${scene}.png`), png)
  writeFileSync(join(dir, `${scene}.png.sha256`), createHash('sha256').update(png).digest('hex'))
}

async function openDemo(page: Page, scene: '' | 'grid' = ''): Promise<void> {
  await page.goto(scene ? `/?demo=${scene}` : '/?demo')
  if (scene === 'grid') await expect(page.locator('[data-testid^="grid-panel-"]')).toHaveCount(4)
  else await expect(page.getByTestId('chat-stream')).toContainText('rainbow ring')
  // The demo's plan checklist lands 400ms after the screen attaches.
  await expect(page.getByText("Raise the ring's layer").first()).toBeVisible()
}

/** Sessions are picked by name: the mock's ids come from a counter that projects share. */
async function openSession(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid^="session-row-"]', { hasText: name }).click()
  await expect(page.getByTestId('session-view')).toBeVisible()
}

test('focus view', async ({ page }) => {
  await openDemo(page)
  await snapshot(page, 'focus')
})

test('grid', async ({ page }) => {
  await openDemo(page, 'grid')
  await snapshot(page, 'grid')
})

test('approval card', async ({ page }) => {
  await openDemo(page)
  await openSession(page, 'Clean up leftover processes')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await snapshot(page, 'approval')
})

test('question card', async ({ page }) => {
  await openDemo(page)
  await openSession(page, 'Pick the hero copy')
  await expect(page.getByTestId('question-card')).toBeVisible()
  await page.getByTestId('question-card').locator('button').first().click()
  await snapshot(page, 'question')
})

test('finished session', async ({ page }) => {
  await openDemo(page)
  await openSession(page, 'Optimize images')
  await snapshot(page, 'done')
})

test('diff', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('evidence-file-packages/ui/src/features/session/SessionView.tsx').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  await snapshot(page, 'diff')
})

test('git history', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.locator('[data-testid^="history-commit-"]').first()).toBeVisible()
  await page.locator('[data-testid^="history-commit-"]').first().click()
  await snapshot(page, 'history')
})

test('file tree', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('evidence-tab-files').click()
  await snapshot(page, 'files')
})

test('terminal with the 16 ANSI colours', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('evidence-tab-terminal').click()
  await page.getByTestId('terminal-add').click()
  const surface = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-mock-term-"]').first()
  await expect(surface).toBeVisible()
  const id = (await surface.getAttribute('data-testid'))!.replace(/^terminal-/, '')
  await page.evaluate((terminalId) => {
    const sgr = (n: number) => `\x1b[${n}m`
    let line = ''
    for (let i = 0; i < 8; i++) line += `${sgr(30 + i)}fg${i} ${sgr(90 + i)}br${i} ${sgr(40 + i)}bg${i}${sgr(0)} ${sgr(100 + i)}bb${i}${sgr(0)} `
    ;(window as never as { __mock: { emitTerminal(id: string, d: string): void } }).__mock.emitTerminal(
      terminalId,
      `${line}\r\n$ `,
    )
  }, id)
  await expect(surface).toContainText('fg7')
  await snapshot(page, 'terminal')
})

test('run dialog with a log', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.evaluate(() => {
    const mock = (window as never as { __mock: any }).__mock
    // Whatever the demo has registered first is what just started; write to every run it holds.
    for (const key of mock.commandRuns.keys()) {
      const [projectId, command] = String(key).split('\u0000')
      mock.emitCommandOutput(projectId, command, '\x1b[32m3 tests passed\x1b[0m \x1b[31m1 failed\x1b[0m\r\n')
    }
  })
  await expect(page.getByTestId('run-log')).toContainText('3 tests passed')
  await snapshot(page, 'run-log')
})

test('settings, every category', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
  const tabs = await page.locator('[data-testid^="settings-tab-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')!),
  )
  expect(tabs.length).toBeGreaterThan(5)
  for (const tab of tabs) {
    await page.getByTestId(tab).click()
    await snapshot(page, tab)
  }
})

test('command palette', async ({ page }) => {
  await openDemo(page)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await snapshot(page, 'palette')
})

test('inbox', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('counter').click()
  await expect(page.getByTestId('inbox')).toBeVisible()
  await snapshot(page, 'inbox')
})

test('usage popover', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('usage-donut-claude').click()
  await snapshot(page, 'usage')
})

test('new session dialog', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('project-menu-centralu').click()
  await page.getByTestId('new-session-centralu').click()
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
  await snapshot(page, 'new-session')
})

test('delete project dialog, armed', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('project-menu-centralu').click()
  await page.getByTestId('delete-project-centralu').click()
  await page.getByTestId('delete-project-name-input').fill('centralu')
  await page.getByTestId('delete-project-files-toggle').locator('input').check()
  await expect(page.getByTestId('delete-project-warning')).toBeVisible()
  await snapshot(page, 'delete-project')
})

test('project screen', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('project-header-centralu').click()
  await snapshot(page, 'project-screen')
})

test('session settings menu', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('settings-open').click()
  await expect(page.getByTestId('settings-menu')).toBeVisible()
  await snapshot(page, 'session-menu')
})

test('keyboard focus ring and text selection', async ({ page }) => {
  await openDemo(page)
  await page.getByTestId('chat-stream').click({ position: { x: 40, y: 40 } })
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await snapshot(page, 'focus-ring')
})
