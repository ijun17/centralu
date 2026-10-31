import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeFileEntry } from '@cc/protocol'
import { accentTokens, activeSide, contrast, resolveSide, unusableValues, urgencyBreaks, type Rgba } from './theme.js'

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
  it('follows the picked mode, never the OS; a stored System mode reads as Dark', () => {
    expect(activeSide('dark')).toBe('dark')
    expect(activeSide('light')).toBe('light')
    expect(activeSide('system')).toBe('dark')
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

/*
 * A theme file a person or another build wrote (#384): the host lists unknown keys as problems and passes every value
 * on as text, so a colour this window cannot use is caught here, alone. It is never applied, and Settings says which.
 */
describe('a value a theme file holds that this window cannot use', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is listed alone, by key, and the usable ones are not', () => {
    vi.stubGlobal('CSS', { supports: (_property: string, value: string) => !value.startsWith('not-') })
    const entry = file({ tokens: { 'surface-floor': '#101010', 'surface-side': 'not-a-colour', 'surface-hover': '   ', 'surface-raised': `#${'0'.repeat(401)}` } })
    expect(unusableValues(entry)).toEqual([
      '"not-a-colour" is not a usable value for surface-side; it is ignored.',
      '"   " is not a usable value for surface-hover; it is ignored.',
      `"#${'0'.repeat(401)}" is not a usable value for surface-raised; it is ignored.`,
    ])
  })

  it('is applied for none of the tokens it names, and the rest still are', () => {
    vi.stubGlobal('CSS', { supports: (_property: string, value: string) => !value.startsWith('not-') })
    const r = resolveSide('light', 'mine', [file({ tokens: { 'surface-floor': '#101010', 'surface-side': 'not-a-colour' } })], null)
    expect(r.tokens['--color-surface-floor']).toBe('#101010')
    expect(r.tokens).not.toHaveProperty('--color-surface-side')
  })
})

describe('the accent', () => {
  it('colours focus and selection, and never the signal', () => {
    const tokens = accentTokens('#6ea8fe')
    expect(Object.keys(tokens).sort()).toEqual(['--color-focus', '--color-selection'])
    expect(tokens).not.toHaveProperty('--color-ink-signal')
    expect(tokens['--color-focus']).toBe('#6ea8fe')
  })
})

describe('the urgency order (contrast is urgency)', () => {
  const dark: Record<string, Rgba> = {
    '--color-surface-floor': [15, 15, 15, 1],
    '--color-ink-signal': [255, 255, 255, 1],
    '--color-ink': [237, 237, 237, 1],
    '--color-ink-muted': [168, 168, 168, 1],
    '--color-ink-faint': [112, 112, 112, 1],
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
