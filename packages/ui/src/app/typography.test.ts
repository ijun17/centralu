import { describe, expect, it } from 'vitest'
import { DEFAULT_SANS, familyList, fontStack, typographyOf, typographyProperties } from './typography.js'

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
    expect(typographyOf({ textSize: 1.2, lineHeight: 'airy' as never })).toMatchObject({ textSize: 1.25, lineHeight: 'normal' })
  })
})
