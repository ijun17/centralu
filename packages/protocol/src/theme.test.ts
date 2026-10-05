import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_PREFERENCES, parseUiPreferences, textSizeFromLegacyStep } from './entities.js'
import { THEME_TOKENS, formatThemeFile, parseThemeFile, themeFileJsonSchema } from './theme.js'

describe('the theme file format (#312)', () => {
  it('docs/theme.schema.json is the schema the host writes (run scripts/theme-schema.mts when this fails)', () => {
    const committed = JSON.parse(readFileSync(new URL('../../../docs/theme.schema.json', import.meta.url), 'utf8'))
    expect(committed).toEqual(themeFileJsonSchema())
  })

  it('the schema lists exactly the tokens the reader accepts, and nothing else', () => {
    const schema = themeFileJsonSchema() as { properties: { tokens: { properties: object; additionalProperties: boolean } } }
    expect(Object.keys(schema.properties.tokens.properties)).toEqual(THEME_TOKENS.map((t) => t.key))
    expect(schema.properties.tokens.additionalProperties).toBe(false)
  })

  it('a file the app writes reads back the same, with $schema first', () => {
    const text = formatThemeFile({ name: 'Paper', base: 'light', tokens: { 'surface-floor': '#fafafa' } })
    expect(Object.keys(JSON.parse(text))).toEqual(['$schema', 'name', 'base', 'tokens'])
    expect(parseThemeFile('paper', '/p', text)).toEqual({
      id: 'paper',
      path: '/p',
      name: 'Paper',
      base: 'light',
      tokens: { 'surface-floor': '#fafafa' },
      problems: [],
      broken: false,
    })
  })

  it('a partial file is fine: only the tokens it sets come back', () => {
    expect(parseThemeFile('a', '/a', '{"name":"A","base":"dark","tokens":{"ink":"#fff"}}').tokens).toEqual({ ink: '#fff' })
    expect(parseThemeFile('b', '/b', '{"name":"B","base":"dark"}')).toMatchObject({ tokens: {}, problems: [], broken: false })
  })

  it('never throws on what a person halfway through an edit might save', () => {
    for (const text of ['', '{', '[]', 'null', '"x"', '{"tokens":[]}', '{"base":"blue","tokens":{"ink":42}}']) {
      expect(() => parseThemeFile('x', '/x', text)).not.toThrow()
    }
    expect(parseThemeFile('x', '/x', '[]')).toMatchObject({ broken: true })
    expect(parseThemeFile('x', '/x', '{"base":"blue"}')).toMatchObject({ base: 'dark', name: 'x', broken: false })
  })
})

describe('screen preferences, field by field', () => {
  it('one bad field falls back alone and keeps the others', () => {
    expect(parseUiPreferences({ sendWithModifierEnter: true, themeMode: 'sepia', accent: '#123456' })).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      sendWithModifierEnter: true,
      accent: '#123456',
    })
  })

  it('a blob from before themes reads with the theme defaults', () => {
    expect(parseUiPreferences({ sendWithModifierEnter: true })).toEqual({ ...DEFAULT_UI_PREFERENCES, sendWithModifierEnter: true })
  })

  it('the text fields read tolerantly: a size lands on the nearest step, anything unusable is its default', () => {
    expect(parseUiPreferences({ textSize: 1.3, lineHeight: 'relaxed', bodyFont: 'Inter', codeFont: 'Menlo' })).toMatchObject({
      textSize: 1.25,
      lineHeight: 'relaxed',
      bodyFont: 'Inter',
      codeFont: 'Menlo',
    })
    expect(parseUiPreferences({ textSize: '1.1', lineHeight: 'airy', bodyFont: 3 })).toMatchObject({ textSize: 1, lineHeight: 'normal', bodyFont: '' })
    expect(parseUiPreferences({ textSize: 0.9 }).textSize).toBe(0.925)
  })

  it('the old snapshot step maps onto the five sizes, clamped, and anything else is no size', () => {
    expect(textSizeFromLegacyStep(0)).toBe(0.85)
    expect(textSizeFromLegacyStep(2)).toBe(1)
    expect(textSizeFromLegacyStep(4)).toBe(1.25)
    expect(textSizeFromLegacyStep(99)).toBe(1.25)
    expect(textSizeFromLegacyStep(-3)).toBe(0.85)
    expect(textSizeFromLegacyStep('4')).toBe(null)
    expect(textSizeFromLegacyStep(undefined)).toBe(null)
  })
})
