import type { Page } from '@playwright/test'

/**
 * The computed colour of a theme token, as `getComputedStyle` reports a colour (`rgb(…)`), to compare an element's
 * colour with in whichever theme is on (#845). A test that writes the colour out breaks on every palette change and
 * says nothing about which token the element should be using.
 */
export async function tokenColor(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${n})`
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  }, name)
}

/** The red, green and blue channels of a colour `getComputedStyle` reported */
export function channels(rgb: string): [number, number, number] {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb)
  if (!m) throw new Error(`not an rgb() colour: ${rgb}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
