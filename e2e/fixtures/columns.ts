import type { Page } from '@playwright/test'

/**
 * Every column count a grid of panels stands in while `change` runs and the screen settles, in order, without
 * repeats — `[1]` is a grid that never moved, `[1, 2, 1]` one that went through two columns on the way.
 *
 * Read from the grid's own style as each commit lands (a mutation observer), not by looking now and then: a layout
 * that lasts one frame is still a frame the person saw, and an app's view laid over a panel follows it there
 * (pinned-app/slots.ts). "Settles" is two frames: the resize observer that reports the new size runs in the first,
 * and the render it asks for normally lands before the second. A count neither size has comes from the render
 * `change` itself causes, before any frame, so it is recorded however late the observer is.
 */
export async function columnsThrough(page: Page, grid: string, change: () => Promise<unknown>): Promise<number[]> {
  await page.evaluate((sel) => {
    const w = window as any
    const el = document.querySelector(sel)!
    const count = () => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
    w.__columns = [count()]
    w.__columnsWatch = new MutationObserver(() => {
      const n = count()
      if (n !== w.__columns.at(-1)) w.__columns.push(n)
    })
    w.__columnsWatch.observe(el, { attributes: true, attributeFilter: ['style'] })
  }, grid)
  await change()
  return page.evaluate(
    () =>
      new Promise<number[]>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const w = window as any
            w.__columnsWatch.disconnect()
            done(w.__columns)
          }),
        ),
      ),
  )
}
