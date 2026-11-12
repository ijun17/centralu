import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeFileEntry } from '@cc/protocol'
import { usableThemeFiles } from '../store/store.js'
import { activeSide, cachedThemeFiles, contrast, pickableThemes, resolveSide, unusableValues, urgencyBreaks, type Rgba } from './theme.js'

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
    const t = resolveSide('light', 'mine', [file({ tokens: { 'surface-floor': '#fafafa', 'shadow-modal': 'none' } })])
    expect(t).toMatchObject({ id: 'mine', base: 'light', tokens: { '--color-surface-floor': '#fafafa', '--shadow-modal': 'none' } })
  })

  it('gives a theme file its own line as the window line unless the file sets one, and a preset keeps its own', () => {
    // No colour from the preset or another token is mixed in: the window borders are the file's line, as it names it or inherits it
    expect(resolveSide('dark', 'mine', [file({ base: 'dark', tokens: { line: '#aa0000' } })]).tokens).toMatchObject({ '--color-line': '#aa0000', '--color-line-chrome': 'var(--color-line)' })
    expect(resolveSide('dark', 'mine', [file({ base: 'dark', tokens: {} })]).tokens).toMatchObject({ '--color-line-chrome': 'var(--color-line)' })
    expect(resolveSide('dark', 'mine', [file({ base: 'dark', tokens: { line: '#aa0000', 'line-chrome': '#00aa00' } })]).tokens['--color-line-chrome']).toBe('#00aa00')
    expect(resolveSide('dark', 'graphite', []).tokens).toEqual({})
  })

  it('has every border a file leaves out follow the token THEME_TOKENS names, and a file that sets one keeps it', () => {
    const tokens = resolveSide('light', 'mine', [file({ tokens: { line: '#f1cddb', 'line-strong': '#dfb0c4', 'line-answering': '#eeeeee' } })]).tokens
    expect(tokens).toMatchObject({
      '--color-line-panel': 'var(--color-line-strong)',
      '--color-line-answering': '#eeeeee',
      '--color-line-bubble-mine': 'var(--color-line-strong)',
    })
  })

  it('falls back to the side’s preset when the id names nothing', () => {
    expect(resolveSide('dark', 'gone', [])).toMatchObject({ id: 'dark', preset: 'dark', tokens: {} })
    expect(resolveSide('light', 'gone', [])).toMatchObject({ id: 'light', preset: 'light', base: 'light' })
    expect(resolveSide('dark', 'hc-dark', [])).toMatchObject({ preset: 'hc-dark', base: 'dark' })
    // Graphite is a dark preset of its own, and Dark stays what the dark side falls back to (#2208)
    expect(resolveSide('dark', 'graphite', [])).toMatchObject({ id: 'graphite', preset: 'graphite', base: 'dark', tokens: {} })
  })

  it('does not apply a broken file (the store hands over its last clean version instead)', () => {
    expect(resolveSide('light', 'mine', [file({ broken: true, tokens: { ink: '#000' } })]).tokens).toEqual({})
  })
})

/*
 * A theme file a person or another build wrote (#384): the host lists unknown keys as problems and passes every value
 * on as text, so a colour this window cannot use is caught here, alone. It is never applied, and Settings says which.
 */
describe('a custom theme named like a preset (#2214)', () => {
  const custom = file({ id: 'graphite-2', name: 'Graphite', base: 'dark', tokens: { 'surface-floor': '#223344' } })

  it('is listed beside the preset, and each applies its own tokens', () => {
    expect(pickableThemes([custom]).filter((c) => c.name === 'Graphite').map((c) => c.id)).toEqual(['graphite', 'graphite-2'])
    expect(resolveSide('dark', 'graphite', [custom])).toMatchObject({ id: 'graphite', preset: 'graphite', tokens: {} })
    expect(resolveSide('dark', 'graphite-2', [custom])).toMatchObject({ id: 'graphite-2', name: 'Graphite', tokens: { '--color-surface-floor': '#223344' } })
  })

  it('a file stored under the preset id before keeps shadowing it, and is listed once, where the preset was', () => {
    const old = file({ id: 'graphite', name: 'My graphite', base: 'dark', tokens: { 'surface-floor': '#101820' } })
    expect(pickableThemes([old]).filter((c) => c.id === 'graphite')).toEqual([{ id: 'graphite', name: 'My graphite', base: 'dark', file: true }])
    expect(resolveSide('dark', 'graphite', [old])).toMatchObject({ name: 'My graphite', tokens: { '--color-surface-floor': '#101820' } })
  })

  it('a file that does not read is not offered and hides no preset, as the window does not apply it', () => {
    const broken = file({ id: 'graphite', name: 'graphite', base: 'dark', broken: true })
    expect(pickableThemes([broken]).filter((c) => c.id === 'graphite')).toEqual([{ id: 'graphite', name: 'Graphite', base: 'dark', file: false }])
  })
})

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
    const r = resolveSide('light', 'mine', [file({ tokens: { 'surface-floor': '#101010', 'surface-side': 'not-a-colour' } })])
    expect(r.tokens['--color-surface-floor']).toBe('#101010')
    expect(r.tokens).not.toHaveProperty('--color-surface-side')
  })
})

describe('the urgency order (contrast is urgency)', () => {
  const dark: Record<string, Rgba> = {
    '--color-surface-floor': [18, 14, 10, 1],
    '--color-ink-signal': [255, 255, 255, 1],
    '--color-ink': [240, 236, 234, 1],
    '--color-ink-muted': [172, 167, 163, 1],
    '--color-ink-faint': [117, 111, 107, 1],
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

/*
 * A custom theme whose file is broken when the window starts has no clean version in memory. The last run's cache stands in
 * for it, so the window keeps the theme's floor instead of falling to Dark and writing Dark over the cache.
 */
describe('a custom theme whose file is broken at start', () => {
  const cache = {
    mode: 'dark',
    dark: { id: 'mine', name: 'Mine', base: 'dark', preset: 'dark', tokens: { '--color-surface-floor': '#101820', sparkle: '#fff' } },
    light: { id: 'light', name: 'Light', base: 'light', preset: 'light', tokens: {} },
  }

  afterEach(() => vi.unstubAllGlobals())

  it('is read back from the cache, its known tokens only, and no preset', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(cache) })
    expect(cachedThemeFiles()).toEqual({ mine: expect.objectContaining({ id: 'mine', base: 'dark', broken: false, tokens: { 'surface-floor': '#101820' } }) })
  })

  it('keeps the cached tokens in place of the broken file, and reads nothing when nothing is cached', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(cache) })
    const broken = file({ id: 'mine', base: 'dark', broken: true })
    const lastGoodThemes = cachedThemeFiles()
    expect(resolveSide('dark', 'mine', usableThemeFiles({ themeFiles: [broken], lastGoodThemes }))).toMatchObject({ id: 'mine', tokens: { '--color-surface-floor': '#101820' } })
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(cachedThemeFiles()).toEqual({})
  })
})
