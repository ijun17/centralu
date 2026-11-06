import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StickyUser, type StickyUserState } from './StickyUser.jsx'

function pinned(over: Partial<StickyUserState>): string {
  const sticky = {
    stickyText: 'Manager ⤷ Run the tests',
    stickyRelayed: false,
    stickyRef: createRef<HTMLDivElement>(),
    stickyOpen: true,
    setStickyOpen: () => {},
    stickyObscured: false,
    stickyReturning: false,
    ...over,
  } as unknown as StickyUserState
  return renderToStaticMarkup(<StickyUser sticky={sticky} />)
}

describe('the pinned copy of a message', () => {
  it('draws a relayed message in the relayed look, collapsed and expanded, as its row does (#1629)', () => {
    const html = pinned({ stickyRelayed: true })
    expect(html.match(/bg-surface-raised text-ink/g)).toHaveLength(2)
    expect(html.match(/data-relayed/g)).toHaveLength(2)
    expect(html).not.toContain('bg-surface-hover')
    expect(pinned({ stickyText: 'Hello' })).toContain('bg-surface-hover')
    expect(html).not.toContain('border-dashed')
  })
})

describe('the pinned copy while its pane is folded', () => {
  it('is out of view and takes no press, and is drawn in place otherwise', () => {
    const folded = pinned({ stickyFolded: true })
    expect(folded).toContain('data-folded="true"')
    expect(folded).toContain('opacity-0')
    expect(folded).toContain('inert')
    const open = pinned({ stickyFolded: false })
    expect(open).not.toContain('data-folded')
    expect(open).toContain('opacity-100')
    expect(open).not.toContain('inert')
  })
})
