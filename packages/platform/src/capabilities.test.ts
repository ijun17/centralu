import { describe, expect, it } from 'vitest'
import { badgeCount, defaultCapabilities } from './capabilities.js'
import { MockPlatform } from './mock/index.js'

describe('platform defaults (#972 item 7)', () => {
  it('a dock badge is a whole number, never below zero, on the mock as on the desktop', async () => {
    expect([badgeCount(-3), badgeCount(2.9), badgeCount(Number.NaN), badgeCount(4)]).toEqual([0, 2, 0, 4])
    const m = new MockPlatform()
    await m.system.setBadge(-2)
    expect(m.badge).toBe(0)
    await m.system.setBadge(3.6)
    expect(m.badge).toBe(3)
  })

  it('the defaults are written once and a platform overrides only what it learned', () => {
    expect(defaultCapabilities({ fileManagerName: 'Finder' })).toMatchObject({
      windowControlsInset: 0,
      shortcutKeys: { mod: '⌘', alt: '⌥', join: '' },
      fileManagerName: 'Finder',
    })
    expect(new MockPlatform().capabilities.fileManagerName).toBe('Finder')
  })
})
