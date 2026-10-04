import { describe, expect, it } from 'vitest'
import type { ThemeFileEntry } from '@cc/protocol'
import { ACCENT_TOKENS, accentTokens, activeSide, contrast, resolveSide, urgencyBreaks, type Rgba } from './theme.js'

const file = (over: Partial<ThemeFileEntry>): ThemeFileEntry => ({
  id: 'mine',
  path: '/data/themes/mine.json',
  name: 'Mine',
  base: 'light',
  tokens: {},
  problems: [],
  broken: false,
  ...over,
})

describe('which side shows', () => {
  it('follows the OS only in System mode', () => {
    expect(activeSide('dark', false)).toBe('dark')
    expect(activeSide('light', true)).toBe('light')
    expect(activeSide('system', true)).toBe('dark')
    expect(activeSide('system', false)).toBe('light')
  })
})

describe('resolving a side', () => {
  it('applies a theme file’s tokens as CSS variables over the preset for its base', () => {
    const t = resolveSide('light', 'mine', [file({ tokens: { 'surface-floor': '#fafafa', 'shadow-modal': 'none' } })], null)
    expect(t).toMatchObject({ id: 'mine', base: 'light', tokens: { '--color-surface-floor': '#fafafa', '--shadow-modal': 'none' } })
  })

  it('falls back to the side’s preset when the id names nothing', () => {
    expect(resolveSide('dark', 'gone', [], null)).toMatchObject({ id: 'dark', preset: 'dark', tokens: {} })
    expect(resolveSide('light', 'gone', [], null)).toMatchObject({ id: 'light', preset: 'light', base: 'light' })
    expect(resolveSide('dark', 'hc-dark', [], null)).toMatchObject({ preset: 'hc-dark', base: 'dark' })
  })

  it('does not apply a broken file (the store hands over its last clean version instead)', () => {
    expect(resolveSide('light', 'mine', [file({ broken: true, tokens: { ink: '#000' } })], null).tokens).toEqual({})
  })
})

describe('the accent', () => {
  it('colours focus, selection and the orbit, and never the signal', () => {
    const tokens = accentTokens('#6ea8fe')
    expect(Object.keys(tokens).sort()).toEqual([...ACCENT_TOKENS].sort())
    expect(tokens).not.toHaveProperty('--color-ink-signal')
    expect(tokens['--color-focus']).toBe('#6ea8fe')
  })
})

describe('the urgency order (contrast is urgency)', () => {
  const dark: Record<string, Rgba> = {
    '--color-surface-floor': [20, 20, 20, 1],
    '--color-ink-signal': [255, 255, 255, 1],
    '--color-ink': [233, 233, 233, 1],
    '--color-ink-muted': [144, 144, 144, 1],
    '--color-ink-faint': [92, 92, 92, 1],
  }

  it('holds for the Dark values', () => {
    expect(urgencyBreaks(dark)).toEqual([])
  })

  it('names the surface and the inks when a lower ink stands out as much as a higher one', () => {
    expect(urgencyBreaks({ ...dark, '--color-ink-faint': [200, 200, 200, 1] })).toEqual([
      'On the floor, background information stands out as much as secondary or more.',
    ])
  })

  it('judges a translucent ink by where it lands', () => {
    // Half-transparent white over black is a mid grey: weaker than the opaque muted ink
    expect(urgencyBreaks({ ...dark, '--color-ink-muted': [255, 255, 255, 0.2] })).toEqual([
      'On the floor, background information stands out as much as secondary or more.',
    ])
  })

  it('measures contrast the WCAG way', () => {
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5)
  })
})
