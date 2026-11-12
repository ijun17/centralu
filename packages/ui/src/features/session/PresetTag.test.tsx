import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PresetTag } from './PresetTag.jsx'

describe('PresetTag (#2213)', () => {
  const html = (preset: 'safe' | 'normal' | 'edits' | 'auto', startedFromHub: boolean | undefined) =>
    renderToStaticMarkup(<PresetTag preset={preset} startedFromHub={startedFromHub} testId="session-preset" />)

  it('says the preset of a session a linked computer started when it is not the default, and nothing otherwise', () => {
    expect(html('normal', true)).toMatch(/data-preset="normal"[^>]*>normal</)
    expect(html('edits', true)).toContain('data-preset="edits"')
    // The default says what was already assumed; a session no linked computer started carries none
    expect(html('auto', true)).toBe('')
    expect(html('normal', false)).toBe('')
    expect(html('normal', undefined)).toBe('')
  })
})
