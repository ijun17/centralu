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
  it('keeps the person’s own look for the person’s message', () => {
    const html = pinned({ stickyText: 'Hello' })
    expect(html).toContain('bg-surface-hover')
    expect(html).not.toContain('bg-surface-raised')
    expect(html).not.toContain('data-relayed')
  })

  it('draws a relayed message in the relayed look, collapsed and expanded, as its row does (#1629)', () => {
    const html = pinned({ stickyRelayed: true })
    expect(html.match(/bg-surface-raised text-ink/g)).toHaveLength(2)
    expect(html.match(/data-relayed/g)).toHaveLength(2)
    expect(html).not.toContain('bg-surface-hover')
    expect(html).not.toContain('border-dashed')
  })
})
