import { describe, expect, it } from 'vitest'
import { frameDragEndInPage } from './engine.js'

describe('frameDragEndInPage (#308)', () => {
  it('is Chromium, told by the client hints only it has, not by the user agent string', () => {
    expect(frameDragEndInPage({ userAgentData: {}, userAgent: 'AppleWebKit Safari' })).toBe(true)
    expect(frameDragEndInPage({ userAgent: 'Mozilla/5.0 AppleWebKit (KHTML, like Gecko) Chrome/140 Safari/537.36' })).toBe(false)
  })

  it('is false where there is no navigator at all', () => {
    expect(frameDragEndInPage(undefined)).toBe(false)
    expect(frameDragEndInPage(null)).toBe(false)
  })
})
