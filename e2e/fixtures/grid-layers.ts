import { expect, test } from '@playwright/test'

/**
 * What a grid panel asks the compositor for (#364, docs/spikes/2026-10-memory-heavy-store.md §10).
 *
 * Six idle panels held ~145 MB more in WebKit's GPU process than the focus view. Listing the layers
 * showed most of the extra layers were conversation rows composited "for overlap": each row was
 * placed with a transform, which made it a stacking context, and once a code block in an earlier row
 * scrolled sideways (a composited scroller of its own), WebKit gave nearly every later row a layer
 * too (119 layers in six panels; 50 without). The rows are placed with `top` now. These check the
 * styles that decide it, since a test cannot read WebKit's layer tree: no row and no panel is a
 * stacking context by transform or will-change.
 */
export function gridLayerTests() {
  test('no conversation row or grid panel is lifted onto a layer of its own', async ({ page }) => {
    await page.goto('/?demo=grid')
    await expect(page.locator('[data-testid^="grid-panel-"]')).toHaveCount(4)
    const rows = page.locator('[data-testid^="grid-panel-"] [data-testid="chat-stream"] [data-index]')
    await expect(rows.first()).toBeVisible()
    const styles = await page.evaluate(() => {
      const of = (el: Element) => {
        const cs = getComputedStyle(el)
        return {
          what: el.getAttribute('data-testid') ?? `row ${el.getAttribute('data-index')}`,
          transform: cs.transform,
          translate: cs.translate,
          willChange: cs.willChange,
        }
      }
      return [
        ...document.querySelectorAll('[data-testid^="grid-panel-"]'),
        ...document.querySelectorAll('[data-testid^="grid-panel-"] [data-testid="chat-stream"] [data-index]'),
      ].map(of)
    })
    expect(styles.length).toBeGreaterThan(4)
    expect(
      styles.filter((s) => s.transform !== 'none' || (s.translate && s.translate !== 'none') || s.willChange !== 'auto'),
    ).toEqual([])
  })
}
