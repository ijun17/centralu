import { DEFAULT_UI_PREFERENCES, LineHeight, nearestTextSize, type UiPreferences } from '@cc/protocol/client'
import { readStored, writeStored } from './stored.js'

/** Fonts, line height and text size on `<html>`: docs/themes.md "Text: size, fonts and line height" */

/**
 * Appended after the person's pick, for the Korean fallback. Copies of `@theme`'s (a unit test keeps them equal): the
 * fallback has to be known before the inline value replaces the stylesheet's.
 */
export const DEFAULT_SANS = "Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', system-ui, sans-serif"
export const DEFAULT_MONO = "D2Coding, ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"

/** Copies of `@theme`'s, kept equal by the same test */
export const LEADING_BODY = 1.65
export const LEADING_CODE = 1.5

/**
 * One factor for both, so prose and code keep their proportion. 12%: at 13px about 2.5px a line, the smallest step
 * that reads as a different density without Compact's descenders overlapping.
 */
const LINE_HEIGHT_FACTORS: Record<LineHeight, number> = { compact: 0.88, normal: 1, relaxed: 1.12 }

/** Empty is the app's own stack */
export const BODY_FONTS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Pretendard (default)' },
  { value: 'system-ui', label: 'System' },
  { value: 'Inter', label: 'Inter' },
  { value: 'Helvetica Neue', label: 'Helvetica Neue' },
  { value: 'Avenir Next', label: 'Avenir Next' },
  { value: 'IBM Plex Sans', label: 'IBM Plex Sans' },
]

export const CODE_FONTS: readonly { value: string; label: string }[] = [
  { value: '', label: 'D2Coding (default)' },
  { value: 'ui-monospace', label: 'System monospace' },
  { value: 'SF Mono', label: 'SF Mono' },
  { value: 'Menlo', label: 'Menlo' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Cascadia Code', label: 'Cascadia Code' },
  { value: 'IBM Plex Mono', label: 'IBM Plex Mono' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
]

/** Family names CSS reads as keywords; quoting one would turn it into a font literally named "monospace" */
const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
])

/** Quotes each name unless quoted or generic, so `JetBrains Mono` and `"JetBrains Mono", Menlo` both work */
export function familyList(written: string): string {
  const parts: string[] = []
  for (const raw of written.split(',')) {
    const name = raw.trim()
    if (!name) continue
    if (/^(['"]).*\1$/.test(name) || GENERIC.has(name.toLowerCase())) parts.push(name)
    else parts.push(`"${name.replace(/["\\]/g, '')}"`)
  }
  return parts.join(', ')
}

/** null for the default: write nothing */
export function fontStack(written: string, fallback: string): string | null {
  const list = familyList(written)
  return list ? `${list}, ${fallback}` : null
}

/** Without CSS (a test in Node) everything passes */
export function isUsableFont(written: string): boolean {
  const stack = fontStack(written, 'monospace')
  if (stack === null) return true
  return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('font-family', stack)
}

export type Typography = Pick<UiPreferences, 'bodyFont' | 'codeFont' | 'lineHeight' | 'textSize'>

/** Each read on its own, so a missing or odd field (an older host) is its default */
export function typographyOf(prefs: Partial<UiPreferences>): Typography {
  const d = DEFAULT_UI_PREFERENCES
  return {
    bodyFont: typeof prefs.bodyFont === 'string' ? prefs.bodyFont : d.bodyFont,
    codeFont: typeof prefs.codeFont === 'string' ? prefs.codeFont : d.codeFont,
    lineHeight: LineHeight.safeParse(prefs.lineHeight).success ? (prefs.lineHeight as LineHeight) : d.lineHeight,
    textSize: typeof prefs.textSize === 'number' && Number.isFinite(prefs.textSize) ? nearestTextSize(prefs.textSize) : d.textSize,
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** Only what differs from the stylesheet */
export function typographyProperties(t: Typography): Record<string, string> {
  const out: Record<string, string> = {}
  const sans = isUsableFont(t.bodyFont) ? fontStack(t.bodyFont, DEFAULT_SANS) : null
  const mono = isUsableFont(t.codeFont) ? fontStack(t.codeFont, DEFAULT_MONO) : null
  if (sans) out['--font-sans'] = sans
  if (mono) out['--font-mono'] = mono
  const factor = LINE_HEIGHT_FACTORS[t.lineHeight]
  if (factor !== 1) {
    out['--leading-body'] = String(round(LEADING_BODY * factor))
    out['--leading-code'] = String(round(LEADING_CODE * factor))
  }
  return out
}

const PROPERTIES = ['--font-sans', '--font-mono', '--leading-body', '--leading-code'] as const

/** The properties last applied (none: the stylesheet's own), so a write that changes nothing announces nothing */
let applied = '{}'

/** A font or line-height change is announced with the theme's `cc-themechange`, which xterm and app views follow */
export function applyTypography(t: Typography, root: HTMLElement = document.documentElement): void {
  const props = typographyProperties(t)
  for (const name of PROPERTIES) {
    if (props[name]) root.style.setProperty(name, props[name])
    else root.style.removeProperty(name)
  }
  // The zoom and `--text-zoom` change together: vh/vw ignore zoom, so index.css divides any vh/vw left by it
  const style = root.style as CSSStyleDeclaration & { zoom: string }
  style.zoom = String(t.textSize)
  style.setProperty('--text-zoom', String(t.textSize))
  const key = JSON.stringify(props)
  if (key !== applied) {
    applied = key
    window.dispatchEvent(new CustomEvent('cc-themechange'))
  }
}

const CACHE_KEY = 'cc-typography'

/** Storage denied: the next start shows the default fonts until the preferences arrive */
export function cacheTypography(t: Typography): void {
  writeStored(CACHE_KEY, t)
}

/** Before anything is drawn: a font or zoom arriving with the preferences, a round trip later, reflows the screen */
export function applyCachedTypography(): void {
  try {
    const cached = readStored(CACHE_KEY) as Partial<UiPreferences> | undefined
    if (cached === undefined) return
    applyTypography(typographyOf(cached))
  } catch {
    /* a broken cache is the same as none */
  }
}
