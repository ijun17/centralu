import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from '@modelcontextprotocol/ext-apps/schema.json'
import { activeTheme, readHostStyles } from './hostStyles.js'

/**
 * What an app view is told about Centralu's theme (#312 step 6): every MCP Apps style variable,
 * read from our tokens where the view sits. The node test run has no CSS, so the computed style is
 * stood in for by a table per element, and `<html>` by an object carrying the theme's side.
 */

/** Every token styles/index.css defines that the mapping reads, with a value of its own */
const TOKENS: Record<string, string> = {
  '--color-surface-floor': '#101010',
  '--color-surface-raised': '#181818',
  '--color-surface-hover': '#202020',
  '--color-surface-selected': '#282828',
  '--color-ink': '#eeeeee',
  '--color-ink-muted': '#aaaaaa',
  '--color-ink-faint': '#777777',
  '--color-ink-signal': '#ffcc00',
  '--color-danger': '#ff4444',
  '--color-danger-bg': '#331111',
  '--color-diff-add': '#44ff44',
  '--color-diff-add-bg': '#113311',
  '--color-line': '#333333',
  '--color-line-strong': '#555555',
  '--color-focus': '#8888ff',
  '--font-sans': 'Inter, sans-serif',
  '--font-mono': 'Menlo, monospace',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--text-xs': '11px',
  '--text-sm': '12px',
  '--text-md': '13px',
  '--text-display': '19px',
  '--leading-body': '1.5',
  '--leading-tight': '1.25',
  '--radius-sm': '3px',
  '--radius-md': '6px',
  '--radius-lg': '10px',
  '--radius-full': '9999px',
  '--shadow-sticky': '0 1px 0 #000',
  '--shadow-popover': '0 4px 12px #000',
  '--shadow-modal': '0 12px 32px #000',
  '--color-scrollbar-thumb': '#444444',
  '--color-scrollbar-thumb-hover': '#666666',
  '--color-scrollbar-track': 'transparent',
  '--scrollbar-size': '10px',
  '--scrollbar-thumb-inset': '2px',
  '--scrollbar-radius': '5px',
}

/** The standard's own list of style variables (ext-apps' schema), not the copy hostStyles.ts was written from */
const STANDARD_KEYS = (schema as unknown as { $defs: { McpUiStyleVariableKey: { anyOf: { const: string }[] } } })
  .$defs.McpUiStyleVariableKey.anyOf.map((k) => k.const)

/** Stands in for `getComputedStyle`: what each element computes, as the browser returns it (untrimmed) */
function computes(byElement: Map<Element, Record<string, string>>, base?: 'light' | 'dark') {
  vi.stubGlobal('document', { documentElement: { dataset: base ? { themeBase: base } : {} } })
  vi.stubGlobal('getComputedStyle', (el: Element) => ({
    getPropertyValue: (name: string) => {
      const v = byElement.get(el)?.[name]
      return v === undefined ? '' : ` ${v}`
    },
  }))
}
const element = () => ({}) as Element

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readHostStyles', () => {
  it('tells the view every variable the standard names when the theme defines every token', () => {
    const el = element()
    computes(new Map([[el, TOKENS]]))
    expect(Object.keys(readHostStyles(el).variables).sort()).toEqual([...STANDARD_KEYS].sort())
  })

  it('maps the standard\'s roles onto Centralu\'s tokens, without the space the browser computes in front', () => {
    const el = element()
    computes(new Map([[el, TOKENS]]))
    const { variables } = readHostStyles(el)
    expect(variables['--color-background-primary']).toBe('#101010')
    expect(variables['--color-text-primary']).toBe('#eeeeee')
    expect(variables['--color-text-warning']).toBe('#ffcc00')
    expect(variables['--font-sans']).toBe('Inter, sans-serif')
    expect(variables['--font-text-md-size']).toBe('13px')
    expect(variables['--border-radius-md']).toBe('6px')
    expect(variables['--shadow-hairline']).toBe('0 0 0 1px #333333')
    expect(variables['--color-background-warning']).toBe('color-mix(in srgb, #ffcc00 12%, transparent)')
  })

  it('reads the tokens where the view sits, so a view in the conversation lane gets the lane\'s colours', () => {
    const floor = element()
    const lane = element()
    computes(new Map([[floor, TOKENS], [lane, { ...TOKENS, '--color-surface-floor': '#0a0a0a' }]]))
    expect(readHostStyles(floor).variables['--color-background-primary']).toBe('#101010')
    expect(readHostStyles(lane).variables['--color-background-primary']).toBe('#0a0a0a')
  })

  it('never sends an empty value: a token that reads empty leaves its variables out, the derived ones too', () => {
    const el = element()
    const { ['--color-ink-signal']: _signal, ['--color-line']: _line, ...rest } = TOKENS
    computes(new Map([[el, rest]]))
    const { variables, centralu } = readHostStyles(el)
    for (const key of ['--color-text-warning', '--color-background-warning', '--shadow-hairline', '--color-border-primary'] as const) {
      expect(variables, key).not.toHaveProperty(key)
    }
    expect(centralu).not.toHaveProperty('--centralu-signal')
    expect(Object.values(variables).every((v) => v !== '')).toBe(true)
    // Values Centralu writes out itself do not depend on any token
    expect(variables['--color-background-ghost']).toBe('transparent')
    expect(variables['--font-weight-bold']).toBe('700')
  })

  it('keeps Centralu\'s own variables apart from the standard\'s', () => {
    const el = element()
    computes(new Map([[el, TOKENS]]))
    const { variables, centralu } = readHostStyles(el)
    expect(centralu).toEqual({
      '--centralu-signal': '#ffcc00',
      '--centralu-scrollbar-thumb': '#444444',
      '--centralu-scrollbar-thumb-hover': '#666666',
      '--centralu-scrollbar-track': 'transparent',
      '--centralu-scrollbar-size': '10px',
      '--centralu-scrollbar-inset': '2px',
      '--centralu-scrollbar-radius': '5px',
    })
    expect(Object.keys(variables).filter((k) => !STANDARD_KEYS.includes(k))).toEqual([])
  })

  it('a view with no element yet is told only the side of the theme', () => {
    computes(new Map(), 'light')
    expect(readHostStyles(null)).toEqual({ theme: 'light', variables: {}, centralu: {} })
  })
})

describe('activeTheme', () => {
  it('is light only when the theme says light, and dark otherwise', () => {
    computes(new Map(), 'light')
    expect(activeTheme()).toBe('light')
    computes(new Map(), 'dark')
    expect(activeTheme()).toBe('dark')
    computes(new Map())
    expect(activeTheme()).toBe('dark')
  })
})
