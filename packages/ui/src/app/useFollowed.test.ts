import { describe, expect, it } from 'vitest'
import { followOutside } from './useFollowed.js'

describe('followOutside', () => {
  it('keeps what is being typed while the outside value stays', () => {
    const state = { draft: 'Mine, edited', seen: 'Mine' }
    expect(followOutside(state, 'Mine')).toBe(state)
  })

  // The theme file was renamed by hand while its editor was open: the old name must not be written back on blur
  it('replaces the draft when the outside value changes', () => {
    expect(followOutside({ draft: 'Mine', seen: 'Mine' }, 'Renamed')).toEqual({ draft: 'Renamed', seen: 'Renamed' })
    expect(followOutside({ draft: 'half typed', seen: 'Mine' }, 'Renamed')).toEqual({ draft: 'Renamed', seen: 'Renamed' })
  })
})
