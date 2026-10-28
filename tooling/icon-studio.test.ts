import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The icon studio opens with the shipped icon and saves panes.svg whole. Its defaults, the
// settings recorded in panes.svg's header and the drawing below them must stay one thing, or
// the next save from the studio quietly changes the icon.
const sources = new URL('../apps/desktop/src-tauri/icons/sources/', import.meta.url)

function studioIconFile(): string {
  const html = readFileSync(new URL('studio.html', sources), 'utf8')
  const script = /<script>([\s\S]*?)\/\/ ---------- UI ----------/.exec(html)?.[1]
  if (script === undefined) throw new Error('studio.html has no script before its UI part')
  return runInNewContext(`${script}\niconFile(Object.assign({}, DEFAULTS))`) as string
}

describe('icon studio', () => {
  it('draws the checked-in panes.svg, header and all, from its defaults', () => {
    const checkedIn = readFileSync(new URL('panes.svg', sources), 'utf8').replace(/\r\n/g, '\n')
    expect(studioIconFile()).toBe(checkedIn)
  })
})
