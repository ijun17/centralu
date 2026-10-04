import type { ITheme } from '@xterm/xterm'

/**
 * The terminal's colours, font and text size, read from the theme's CSS variables when an xterm is created
 * (#312). xterm paints with its own theme object rather than CSS, so this is the one place the
 * three xterms (the shell, a command's log in the terminal panel, the run dialog's log) learn the
 * theme. Each variable is spelled out in full: Tailwind only emits a theme variable it can find
 * written somewhere, and a name built from parts would not be found.
 *
 * A variable that is missing (a test page without the stylesheet) is left out, so xterm falls
 * back to its own default for that colour instead of painting an empty string.
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

/**
 * `shell` is a live terminal on the side surface with a visible cursor. `log` is a read-only
 * command log on a raised surface; it takes no input, so its cursor is painted the background
 * colour and disappears.
 */
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
  const fontFamily = read('--font-term')
  // xterm takes a number of pixels; the token is written in px (`11px`). What a machine wrote
  // is the xs step everywhere else too (paths, the code viewer).
  const fontSize = Number.parseFloat(read('--text-xs') ?? '')
  return {
    theme,
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize > 0 ? { fontSize } : {}),
  }
}
