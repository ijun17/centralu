import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArchiveUnreached } from './ArchiveSection.jsx'

// #841 item 4: a machine whose trash could not be read was left out of the list without a word
describe('the session archive of a machine that was not reached', () => {
  it('is named under the list', () => {
    const html = renderToStaticMarkup(<ArchiveUnreached unreached={[{ name: 'Box' }, { name: 'Laptop' }]} />)
    expect(html).toContain('data-testid="trash-unreached"')
    expect(html).toContain('Not listed: the session archive on Box, Laptop, which could not be reached just now.')
  })

  it('says nothing when every machine answered', () => {
    expect(renderToStaticMarkup(<ArchiveUnreached unreached={[]} />)).toBe('')
    expect(renderToStaticMarkup(<ArchiveUnreached />)).toBe('')
  })
})
