import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Unreached } from './Unreached.jsx'

// #841 item 4, #2268: a machine whose trash (or Tasks) could not be read is not left out without a word
describe('the part of a merged list on a machine that was not reached', () => {
  it('is named under the list, in one look wherever it stands', () => {
    const html = renderToStaticMarkup(<Unreached what="the session archive" unreached={[{ name: 'Box' }, { name: 'Laptop' }]} testId="trash-unreached" />)
    expect(html).toContain('data-testid="trash-unreached"')
    expect(html).toContain('class="text-sm text-ink"')
    expect(html).toContain('Not listed: the session archive on Box, Laptop, which could not be reached just now.')
  })

  it('says nothing when every machine answered', () => {
    expect(renderToStaticMarkup(<Unreached what="the session archive" unreached={[]} testId="trash-unreached" />)).toBe('')
    expect(renderToStaticMarkup(<Unreached what="the session archive" testId="trash-unreached" />)).toBe('')
  })
})
