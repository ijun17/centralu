import { expect, test, type Locator } from '@playwright/test'
import { setup } from './control.js'

/**
 * The space between top-bar usage donuts (owner, 2026-11-02): this computer's donuts stood further apart than a linked
 * machine's inside its capsule, because only this computer's buttons carried padding. One gap for both. A function,
 * because it runs in Chromium and in WebKit (the desktop app is WKWebView).
 */

type MockWindow = { __mock: any }

/** The horizontal gaps between neighbouring donuts' buttons (their round hover circles) and between their rings, in px */
async function gaps(donuts: Locator): Promise<{ circles: number[]; rings: number[] }> {
  const boxes = await donuts.evaluateAll((els) =>
    els.map((el) => {
      const b = el.getBoundingClientRect()
      const r = el.querySelector('svg')!.getBoundingClientRect()
      return { left: b.left, right: b.right, ringLeft: r.left, ringRight: r.right }
    }),
  )
  const between = (key: 'left' | 'ringLeft', prev: 'right' | 'ringRight') => boxes.slice(1).map((b, i) => b[key] - boxes[i]![prev])
  return { circles: between('left', 'right'), rings: between('ringLeft', 'ringRight') }
}

export function usageDonutGapTests(): void {
  test("this computer's donuts stand as far apart as a linked machine's, and their hover circles do not touch", async ({ page }) => {
    await setup(page, { projects: ['/tmp/alpha'] })
    await page.evaluate(() => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', name: 'Box', sshTarget: 'me@box' }))
    const here = page.locator('button[data-testid^="usage-donut-"]:not([data-testid*="."])')
    const there = page.getByTestId('usage-machine-box').locator('button[data-testid^="usage-donut-"]')
    await expect(there.nth(1)).toBeVisible()
    await expect(here.nth(1)).toBeVisible()

    const own = await gaps(here)
    const linked = await gaps(there)
    test.info().annotations.push({ type: 'gaps', description: `this computer ${JSON.stringify(own)}; linked machine ${JSON.stringify(linked)}` })
    expect(own.rings.length).toBeGreaterThan(0)
    expect(own.rings).toEqual(linked.rings.slice(0, own.rings.length))
    expect(Math.min(...own.circles, ...linked.circles)).toBeGreaterThan(0)
  })
}
