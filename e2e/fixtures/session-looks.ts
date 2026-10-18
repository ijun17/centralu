import { expect, test, type Page } from '@playwright/test'
import { addSessionPanels, newSession, setup } from './project-screen.js'

/**
 * The four looks of a session (#736): the sidebar's mark and the grid's panel say what a session is doing by line and
 * fill alone, with nothing moving. Each look is read from the rendered style, in the dark and the light preset, so a
 * token changed to the wrong one, a border that lost its dashes or a fill that went missing fails here.
 *
 *   idle       a thin grey line
 *   answering  a light grey (ink-muted) solid line
 *   stopped    a thick white dashed line on grey (error, limited, an interruption)
 *   waiting    a thick white solid line on grey (an approval, an open question)
 */

type Look = 'idle' | 'answering' | 'stopped' | 'waiting'

/** Each state that has to show one of the four looks, as the patch the store holds for it */
const CASES: { name: string; look: Look; patch: Record<string, unknown> }[] = [
  { name: 'idle', look: 'idle', patch: { state: 'idle' } },
  { name: 'a finished turn (waiting_input)', look: 'idle', patch: { state: 'waiting_input' } },
  { name: 'working', look: 'answering', patch: { state: 'working' } },
  { name: 'error', look: 'stopped', patch: { state: 'error' } },
  { name: 'limited', look: 'stopped', patch: { state: 'limited' } },
  { name: 'an interruption', look: 'stopped', patch: { state: 'waiting_input', interruption: { reason: 'quit', at: 1 } } },
  { name: 'waiting_approval', look: 'waiting', patch: { state: 'waiting_approval' } },
  { name: 'an open question', look: 'waiting', patch: { state: 'idle', pendingQuestions: [{ requestId: 'q-look', questions: [] }] } },
]

/**
 * What a look draws, as tokens. The mark is one chip whose own border is the look (owner, 2026-10-18: one edge, not a
 * ring behind a chip): thin grey when idle, 2px when it says something, dashed when stopped. A panel only colours and
 * dashes its own 1px border.
 */
const LOOKS: Record<
  Look,
  { width: string; style: string; panelStyle: string; line: 'signal' | 'muted' | 'faint-line'; chip: 'floor' | 'selected' }
> = {
  idle: { width: '1px', style: 'solid', panelStyle: 'solid', line: 'faint-line', chip: 'floor' },
  answering: { width: '2px', style: 'solid', panelStyle: 'solid', line: 'muted', chip: 'floor' },
  stopped: { width: '2px', style: 'dashed', panelStyle: 'dashed', line: 'signal', chip: 'selected' },
  waiting: { width: '2px', style: 'solid', panelStyle: 'solid', line: 'signal', chip: 'selected' },
}

/** A token's colour as the browser computes it (`rgb(…)`), so the expectation follows the preset */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('i')
    probe.style.color = `var(${n})`
    document.body.append(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  }, name)
}

async function colours(page: Page) {
  return {
    signal: await token(page, '--color-ink-signal'),
    muted: await token(page, '--color-ink-muted'),
    'faint-line': await token(page, '--color-line-strong'),
    clear: 'rgba(0, 0, 0, 0)',
    floor: await token(page, '--color-surface-floor'),
    selected: await token(page, '--color-surface-selected'),
    lineStrong: await token(page, '--color-line-strong'),
  }
}

/** The preset the test runs in. The app starts dark whatever the OS says, so the mode is set, not emulated */
async function useScheme(page: Page, scheme: 'dark' | 'light') {
  await page.evaluate((mode) => (window as any).__store.getState().setPrefs({ themeMode: mode }), scheme)
  await expect(page.locator('html')).toHaveAttribute('data-theme-base', scheme)
}

async function patchSession(page: Page, id: string, patch: Record<string, unknown>) {
  await page.evaluate(
    ([sid, p]) => {
      const store = (window as any).__store
      store.setState((s: any) => {
        // Start from a session at rest, so the cases do not leak into each other
        const { interruption: _i, ...rest } = s.sessions[sid]
        return { sessions: { ...s.sessions, [sid]: { ...rest, state: 'idle', pendingQuestions: [], ...(p as object) } } }
      })
    },
    [id, patch] as const,
  )
}

/**
 * Nothing animates on `el` itself or on its pseudo-elements: the old orbit rotated a layer of the border for as long
 * as a session worked. (What lies inside a panel, such as the pulsing dot, is not the look.)
 */
async function expectStill(el: ReturnType<Page['locator']>) {
  const running = await el.evaluate(
    (node) => node.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect).target === node).length,
  )
  expect(running).toBe(0)
}

export function sessionLookTests() {
  for (const scheme of ['dark', 'light'] as const) {
    test.describe(`${scheme} preset`, () => {
      test('the sidebar mark wears one of the four looks for every state', async ({ page }) => {
        await setup(page, ['/tmp/alpha'])
        await useScheme(page, scheme)
        const id = await newSession(page, 'alpha')
        const c = await colours(page)
        const mark = page.getByTestId(`session-row-${id}`).locator('[data-testid^="tool-mark-"][data-state]')
        const chip = mark.locator('> span')

        for (const { name, look, patch } of CASES) {
          await patchSession(page, id, patch)
          const want = LOOKS[look]
          await expect(mark, name).toHaveAttribute('data-look', look)
          // No ring around the chip: the mark itself draws nothing
          await expect(mark, name).toHaveCSS('background-color', c.clear)
          await expect(mark, name).toHaveCSS('border-top-width', '0px')
          // The chip's own border is the look, and its fill carries it inside
          await expect(chip, name).toHaveCSS('border-top-width', want.width)
          await expect(chip, name).toHaveCSS('border-top-style', want.style)
          await expect(chip, name).toHaveCSS('border-top-color', c[want.line])
          await expect(chip, name).toHaveCSS('background-color', c[want.chip])
          await expectStill(mark)
        }
      })

      test('the mark keeps its size in every look, and the tooltip still names the exact state', async ({ page }) => {
        await setup(page, ['/tmp/alpha'])
        await useScheme(page, scheme)
        const id = await newSession(page, 'alpha')
        const mark = page.getByTestId(`session-row-${id}`).locator('[data-testid^="tool-mark-"][data-state]')
        const sizes = new Set<string>()
        for (const { patch } of CASES) {
          await patchSession(page, id, patch)
          const box = await mark.boundingBox()
          sizes.add(`${box!.width}x${box!.height}`)
        }
        expect([...sizes]).toHaveLength(1)

        await patchSession(page, id, { state: 'error' })
        await expect(mark).toHaveAttribute('aria-label', /Error/)
        await patchSession(page, id, { state: 'waiting_approval' })
        await expect(mark).toHaveAttribute('aria-label', /approval/i)
      })

      test('a grid panel wears the same four looks as its mark', async ({ page }) => {
        await setup(page, ['/tmp/alpha'])
        await useScheme(page, scheme)
        const id = await newSession(page, 'alpha')
        await page.evaluate((sid) => (window as any).__store.getState().setGridPanels([{ kind: 'session', sessionId: sid }]), id)
        await page.getByTestId('grid-button').click()
        const panel = page.getByTestId(`grid-panel-${id}`)
        await expect(panel).toBeVisible()
        const c = await colours(page)

        for (const { name, look, patch } of CASES) {
          await patchSession(page, id, patch)
          const want = LOOKS[look]
          await expect(panel, name).toHaveAttribute('data-look', look)
          for (const side of ['top', 'right', 'bottom', 'left']) {
            await expect(panel, `${name}: ${side}`).toHaveCSS(`border-${side}-width`, '1px')
            await expect(panel, `${name}: ${side}`).toHaveCSS(`border-${side}-style`, want.panelStyle)
            await expect(panel, `${name}: ${side}`).toHaveCSS(`border-${side}-color`, c[want.line === 'faint-line' ? 'lineStrong' : want.line])
          }
          // No fill: the panel is a screen to read, only its border carries the look
          await expect(panel.getByTestId('pane-header'), name).toHaveCSS('background-color', c.clear)
          await expectStill(panel)
        }
      })

      test('the panel of a project screen wears the look too', async ({ page }) => {
        await setup(page, ['/tmp/alpha'])
        await useScheme(page, scheme)
        const id = await newSession(page, 'alpha')
        await page.getByTestId('project-header-alpha').click()
        await addSessionPanels(page, [id])
        const panel = page.getByTestId(`project-panel-session:${id}`)
        const c = await colours(page)
        await patchSession(page, id, { state: 'waiting_approval' })
        await expect(panel).toHaveAttribute('data-look', 'waiting')
        await expect(panel).toHaveCSS('border-top-width', '1px')
        await expect(panel).toHaveCSS('border-top-style', 'solid')
        await expect(panel).toHaveCSS('border-top-color', c.signal)
        await patchSession(page, id, { state: 'error' })
        await expect(panel).toHaveAttribute('data-look', 'stopped')
        await expect(panel).toHaveCSS('border-top-style', 'dashed')
      })
    })
  }

  test('the spin settings and the orbit are gone', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    const id = await newSession(page, 'alpha')
    await patchSession(page, id, { state: 'working' })
    await page.keyboard.press('Meta+k')
    await page.getByTestId('palette-input').fill('settings')
    await page.getByTestId('palette-item-action').click()
    await page.getByTestId('settings-tab-appearance').click()
    await expect(page.getByTestId('settings-fold-composer')).toBeVisible()
    await expect(page.getByTestId('settings-spin-grid')).toHaveCount(0)
    await expect(page.getByTestId('settings-spin-icon')).toHaveCount(0)
    await page.keyboard.press('Escape')
    const root = await page.evaluate(() => ({ spinGrid: document.documentElement.dataset.spinGrid, spinIcon: document.documentElement.dataset.spinIcon }))
    expect(root).toEqual({ spinGrid: undefined, spinIcon: undefined })
    // No element carries an orbit, and no animation runs anywhere while a session works
    await expect(page.locator('.cc-orbit, .cc-orbit-ring, .cc-orbit-ring-layer')).toHaveCount(0)
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && /orbit/.test((a as CSSAnimation).animationName ?? '')).length)
    expect(running).toBe(0)
  })
}
