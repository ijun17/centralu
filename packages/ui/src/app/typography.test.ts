import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SANS, applyCachedTypography, familyList, fontStack, typographyOf, typographyProperties } from './typography.js'

const DEFAULTS = typographyOf({})

describe('the font a person writes', () => {
  it('is quoted name by name, leaving quoted names and generic keywords alone', () => {
    expect(familyList('JetBrains Mono')).toBe('"JetBrains Mono"')
    expect(familyList(' "Fira Code" , Menlo, monospace ')).toBe('"Fira Code", "Menlo", monospace')
    expect(familyList("'IBM Plex Sans'")).toBe("'IBM Plex Sans'")
    expect(familyList(' , ')).toBe('')
  })

  it('goes in front of the app’s own stack, never in place of it (the Korean fallback stays)', () => {
    expect(fontStack('Inter', DEFAULT_SANS)).toBe(`"Inter", ${DEFAULT_SANS}`)
    expect(fontStack('', DEFAULT_SANS)).toBe(null)
  })
})

describe('what a choice writes on the root', () => {
  it('writes nothing at the defaults, so the stylesheet shows exactly as before', () => {
    expect(typographyProperties(DEFAULTS)).toEqual({})
  })

  it('moves body and code line heights by one factor', () => {
    expect(typographyProperties({ ...DEFAULTS, lineHeight: 'relaxed' })).toEqual({ '--leading-body': '1.848', '--leading-code': '1.68' })
    expect(typographyProperties({ ...DEFAULTS, lineHeight: 'compact' })).toEqual({ '--leading-body': '1.452', '--leading-code': '1.32' })
  })

  it('reads an older host’s record, missing the text fields, as the defaults', () => {
    expect(typographyOf({ sendWithModifierEnter: true })).toEqual(DEFAULTS)
    expect(typographyOf({ textSize: 1.2, lineHeight: 'airy' })).toMatchObject({ textSize: 1.25, lineHeight: 'normal' })
  })
})

describe('the cached typography before first paint', () => {
  afterEach(() => vi.unstubAllGlobals())

  const page = (stored: unknown) => {
    const style = { setProperty: vi.fn(), removeProperty: vi.fn(), zoom: '' }
    vi.stubGlobal('document', { documentElement: { style } })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal('CustomEvent', class {})
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(stored) })
    return style
  }

  it('applies what it holds, each field on its own', () => {
    const style = page({ textSize: 1.25, lineHeight: 'airy', bodyFont: 7 })
    applyCachedTypography()
    expect(style.zoom).toBe('1.25')
  })

  it('applies nothing from a cache that is not an object', () => {
    for (const stored of [3, 'x', [1.25], null]) {
      const style = page(stored)
      applyCachedTypography()
      expect(style.zoom).toBe('')
    }
  })
})
