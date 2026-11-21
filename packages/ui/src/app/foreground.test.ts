import { describe, expect, it } from 'vitest'
import { isForeground } from './foreground.js'

describe('is the app in front of the person', () => {
  it('is in front when focused and visible', () => {
    expect(isForeground(true, 'visible')).toBe(true)
  })

  it('is not in front when minimized', () => {
    expect(isForeground(true, 'hidden')).toBe(false)
  })

  // After a switch to another app the window is still 'visible': visibility alone would block notifications
  it('is not in front when covered by another app even if the window is visible', () => {
    expect(isForeground(false, 'visible')).toBe(false)
  })

  it('is naturally not in front when neither is true', () => {
    expect(isForeground(false, 'hidden')).toBe(false)
  })
})
