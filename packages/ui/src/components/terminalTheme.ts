import type { ITheme } from '@xterm/xterm'

/**
 * The terminal's colours, read from the theme's CSS variables when an xterm is created (#312): xterm paints with its own
 * theme object, not CSS. Each name is spelled out in full: Tailwind only emits a theme variable it finds written
 * somewhere. A missing variable (a test page without the stylesheet) is left out, so xterm uses its own default.
 */
const VARS = {
  foreground: '--color-term-fg',
  selectionBackground: '--color-term-selection',
  black: '--color-term-black',
  red: '--color-term-red',
  green: '--color-term-green',
  yellow: '--color-term-yellow',
  blue: '--color-term-blue',
  magenta: '--color-term-magenta',
  cyan: '--color-term-cyan',
  white: '--color-term-white',
  brightBlack: '--color-term-bright-black',
  brightRed: '--color-term-bright-red',
  brightGreen: '--color-term-bright-green',
  brightYellow: '--color-term-bright-yellow',
  brightBlue: '--color-term-bright-blue',
  brightMagenta: '--color-term-bright-magenta',
  brightCyan: '--color-term-bright-cyan',
  brightWhite: '--color-term-bright-white',
} as const satisfies Partial<Record<keyof ITheme, string>>

/** `log` is a read-only log on a raised surface; it takes no input, so its cursor is the background colour */
export function terminalStyle(el: Element, kind: 'shell' | 'log'): { theme: ITheme; fontFamily?: string; fontSize?: number } {
  const style = getComputedStyle(el)
  const read = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined
  const theme: ITheme = {}
  for (const [key, name] of Object.entries(VARS) as [keyof typeof VARS, string][]) {
    const value = read(name)
    if (value) theme[key] = value
  }
  const background = kind === 'log' ? read('--color-term-log-bg') : read('--color-term-bg')
  const cursor = kind === 'log' ? background : read('--color-term-cursor')
  if (background) theme.background = background
  if (cursor) theme.cursor = cursor
  // The code font (Settings → Appearance, #312 step 5): the terminal is text a machine wrote
  const fontFamily = read('--font-mono')
  // xterm takes pixels; the token is written in px (`11px`), the xs step of all machine text
  const fontSize = Number.parseFloat(read('--text-xs') ?? '')
  return {
    theme,
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize > 0 ? { fontSize } : {}),
  }
}

/**
 * Keeps an open terminal in step with the theme and the code font: xterm reads them only when told, so this re-reads
 * the variables on `cc-themechange` (applyTheme, applyTypography). A new font changes the cell size, so `refit` follows.
 * @returns stops following
 */
export function followTheme(
  term: { options: { theme?: ITheme; fontFamily?: string } },
  el: Element,
  kind: 'shell' | 'log',
  refit?: () => void,
): () => void {
  const update = () => {
    const next = terminalStyle(el, kind)
    term.options.theme = next.theme
    if (next.fontFamily && next.fontFamily !== term.options.fontFamily) {
      term.options.fontFamily = next.fontFamily
      refit?.()
    }
  }
  /*
   * A code font still loading when the terminal opened (picked later, or slower than the app's wait for bundled fonts,
   * #731): xterm measures its cell once, and again only when the family changes, so it is set away and back when a face
   * of its family loads. Once per face: in WebKit the measuring can fire another `loadingdone`.
   */
  const fonts = typeof document === 'undefined' ? undefined : document.fonts
  const measured = new Set<FontFace>()
  const remeasure = (e: Event) => {
    const family = term.options.fontFamily
    if (!family) return
    const names = family.split(',').map((n) => n.trim().replace(/^["']|["']$/g, '').toLowerCase())
    const faces = ((e as FontFaceSetLoadEvent).fontfaces ?? []).filter(
      (f) => !measured.has(f) && names.includes(f.family.replace(/^["']|["']$/g, '').toLowerCase()),
    )
    if (!faces.length) return
    for (const f of faces) measured.add(f)
    term.options.fontFamily = 'monospace'
    term.options.fontFamily = family
    refit?.()
  }
  window.addEventListener('cc-themechange', update)
  fonts?.addEventListener?.('loadingdone', remeasure)
  return () => {
    window.removeEventListener('cc-themechange', update)
    fonts?.removeEventListener?.('loadingdone', remeasure)
  }
}
