import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CENTRALU_SOURCES, STYLE_SOURCES, readHostStyles } from '../packages/ui/src/features/app-frame/hostStyles.js'

/*
 * The theme as an app view receives it (packages/ui features/app-frame/hostStyles.ts), checked
 * against the stylesheet it reads. Here rather than next to it because it reads index.css as a
 * file, and packages/ui does not use Node APIs.
 */
const css = readFileSync(new URL('../packages/ui/src/styles/index.css', import.meta.url), 'utf8')
/** Every custom property the stylesheet declares, with its first value: the `@theme` block, Dark */
const declared = new Map<string, string>()
for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) if (!declared.has(m[1]!)) declared.set(m[1]!, m[2]!.trim())

/** Every token a source names: the plain ones, and the ones a made-up value reads */
function tokensOf(sources: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const source of Object.values(sources)) {
    if (typeof source === 'string') out.push(source)
    else if (typeof source === 'function') (source as (read: (t: string) => string) => string)((t) => (out.push(t), '#000'))
  }
  return out
}

function stubPage(base: 'dark' | 'light') {
  vi.stubGlobal('document', { documentElement: { dataset: { themeBase: base } } })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => declared.get(name) ?? '' }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the theme as an app view receives it (#312 step 6)', () => {
  it('maps every MCP Apps style variable', () => {
    // The type makes the map complete; this keeps the count honest if the type ever widens
    expect(Object.keys(STYLE_SOURCES)).toHaveLength(76)
  })

  it('reads only tokens the stylesheet declares, so a renamed token cannot silently drop a variable', () => {
    const missing = [...tokensOf(STYLE_SOURCES), ...tokensOf(CENTRALU_SOURCES)].filter((t) => !declared.has(t))
    expect(missing).toEqual([])
  })

  it('sends all 76 with a value, the signal as warning and in the extension, and the scrollbar in the extension', () => {
    stubPage('dark')
    const { theme, variables, centralu } = readHostStyles({} as Element)
    expect(theme).toBe('dark')
    expect(Object.keys(variables)).toHaveLength(76)
    expect(variables['--color-text-warning']).toBe('#ffffff')
    expect(variables['--color-border-warning']).toBe('#ffffff')
    expect(variables['--color-background-warning']).toBe('color-mix(in srgb, #ffffff 12%, transparent)')
    expect(variables['--color-text-primary']).toBe('#e9e9e9')
    expect(variables['--font-text-md-size']).toBe('13px')
    expect(centralu).toEqual({
      '--centralu-signal': '#ffffff',
      '--centralu-scrollbar-thumb': '#292929',
      '--centralu-scrollbar-thumb-hover': '#353535',
      '--centralu-scrollbar-track': 'transparent',
      '--centralu-scrollbar-size': '10px',
      '--centralu-scrollbar-inset': '3px',
      '--centralu-scrollbar-radius': '999px',
    })
  })

  it('tells the side from the theme on the page', () => {
    stubPage('light')
    expect(readHostStyles(null).theme).toBe('light')
  })
})
