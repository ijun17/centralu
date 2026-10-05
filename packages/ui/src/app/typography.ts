import { DEFAULT_UI_PREFERENCES, LineHeight, nearestTextSize, type UiPreferences } from '@cc/protocol'

/**
 * Fonts, line height and text size (#312 step 5), written on `<html>` next to the theme.
 *
 * Like a theme, these are values for tokens in `styles/index.css` — `--font-sans`, `--font-mono`,
 * `--leading-body`, `--leading-code` — set as inline properties on the root, so every utility,
 * every `var()` in CSS, xterm (components/terminalTheme.ts) and app views (hostStyles.ts) follow.
 * A preference left at its default writes nothing: the stylesheet's own value shows, so the
 * default screen is exactly what it was before these settings existed.
 *
 * The text size is the root's CSS zoom, as it was before it moved into the preferences.
 */

/**
 * The stylesheet's stacks, appended after whatever the person picks. They are copies of the
 * `@theme` values (a unit test keeps them equal) because the fallback has to be known before the
 * inline value replaces the stylesheet's. Appending them is what keeps the Korean fallback: a Latin
 * font has no Hangul, and the browser takes each missing glyph from the next family in the list.
 */
export const DEFAULT_SANS = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard Variable', Pretendard, system-ui, sans-serif"
export const DEFAULT_MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"

/** The body line height and the code one at Normal — copies of `@theme`'s, kept equal by the same test */
export const LEADING_BODY = 1.65
export const LEADING_CODE = 1.5

/**
 * Compact and Relaxed move both by the same factor, so prose and code keep their proportion.
 * 12% either way: at 13px that is about 2.5px a line, the smallest step that reads as a different
 * density in a long reply without turning Compact into overlapping descenders.
 */
export const LINE_HEIGHT_FACTORS: Record<LineHeight, number> = { compact: 0.88, normal: 1, relaxed: 1.12 }

/** A short list to pick from. Empty is the app's own stack; anything else can be typed */
export const BODY_FONTS: readonly { value: string; label: string }[] = [
  { value: '', label: 'System (default)' },
  { value: 'Inter', label: 'Inter' },
  { value: 'Helvetica Neue', label: 'Helvetica Neue' },
  { value: 'Avenir Next', label: 'Avenir Next' },
  { value: 'IBM Plex Sans', label: 'IBM Plex Sans' },
  { value: 'Pretendard', label: 'Pretendard' },
]

export const CODE_FONTS: readonly { value: string; label: string }[] = [
  { value: '', label: 'System monospace (default)' },
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

/**
 * What the person wrote, as a CSS family list: each comma-separated name is quoted unless it
 * already is or it is a generic keyword, so `JetBrains Mono` and `"JetBrains Mono", Menlo` both
 * work. Returns '' for nothing usable.
 */
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

/** The full stack for a written choice, the app's stack after it; null for the default (write nothing) */
export function fontStack(written: string, fallback: string): string | null {
  const list = familyList(written)
  return list ? `${list}, ${fallback}` : null
}

/** Whether the browser accepts a written choice as a font-family. Without CSS (a test in node) everything passes */
export function isUsableFont(written: string): boolean {
  const stack = fontStack(written, 'monospace')
  if (stack === null) return true
  return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('font-family', stack)
}

export type Typography = Pick<UiPreferences, 'bodyFont' | 'codeFont' | 'lineHeight' | 'textSize'>

/** The four preferences, each read on its own so a missing or odd field (an older host) is its default */
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

/** The custom properties a choice sets on the root. Only what differs from the stylesheet is in it */
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

/**
 * Puts a choice on the page. A font or line-height change is announced with `cc-themechange`,
 * the event a theme switch uses: xterm re-reads its font then and app views re-send their
 * variables, the same way they follow a theme.
 */
export function applyTypography(t: Typography, root: HTMLElement = document.documentElement): void {
  const props = typographyProperties(t)
  for (const name of PROPERTIES) {
    if (props[name]) root.style.setProperty(name, props[name])
    else root.style.removeProperty(name)
  }
  /*
   * The zoom and `--text-zoom` always change together: vh/vw ignore zoom, so the shell is held by
   * a chain of % and any remaining vh/vw is divided by this variable (index.css, --text-zoom).
   */
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

export function cacheTypography(t: Typography): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(t))
  } catch {
    /* storage denied — the next start shows the default fonts until the preferences arrive */
  }
}

/**
 * The last run's fonts, line height and text size, before anything is drawn (main.tsx), for the
 * same reason as the cached theme: the preferences arrive a round trip later, and a different font
 * or zoom arriving then reflows the whole screen once.
 */
export function applyCachedTypography(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return
    applyTypography(typographyOf(JSON.parse(raw) as Partial<UiPreferences>))
  } catch {
    /* a broken cache is the same as none */
  }
}
