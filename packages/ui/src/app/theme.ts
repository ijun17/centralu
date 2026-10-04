import { THEME_TOKENS, THEME_TOKEN_BY_KEY, type ThemeFileEntry, type UiPreferences } from '@cc/protocol'

/**
 * The theme engine (#312 step 3).
 *
 * A theme is a set of values for the tokens in `styles/index.css`. Presets live in the stylesheet:
 * the `@theme` values are the Dark preset, and any other preset is a `[data-theme='…']` block
 * there. A custom theme is a file in the data folder's `themes/` (protocol theme.ts, read and
 * watched by the host); its tokens are applied as inline custom properties on `<html>`, so they
 * override the preset for the same side, and any token it leaves out keeps that preset's value. Everything that
 * reads a token (utilities, `var()` in CSS, xterm via terminalTheme.ts) follows without knowing
 * which theme is on.
 */

export type ThemeBase = 'dark' | 'light'
export type ThemePreset = { id: string; name: string; base: ThemeBase }

/** The presets the stylesheet defines. Dark is the `@theme` values themselves. */
export const THEME_PRESETS: readonly ThemePreset[] = [{ id: 'dark', name: 'Dark', base: 'dark' }]

export { THEME_TOKENS }

/** The tokens the accent replaces when it is on. The signal colour is never among them. */
export const ACCENT_TOKENS = [
  '--color-focus',
  '--color-selection',
  '--color-activity-1',
  '--color-activity-2',
  '--color-activity-3',
  '--color-activity-4',
  '--color-activity-5',
] as const

/**
 * What the accent writes over those tokens. The selection stays translucent (it brightens
 * whatever is under it, see ::selection in index.css), and the orbit keeps a sweep of shades
 * of one hue rather than five hues, held below white as the galaxy palette is.
 */
export function accentTokens(accent: string): Record<string, string> {
  const mix = (pct: number, other: string) => `color-mix(in oklab, ${accent} ${pct}%, ${other})`
  return {
    '--color-focus': accent,
    '--color-selection': mix(35, 'transparent'),
    '--color-activity-1': mix(60, 'black'),
    '--color-activity-2': accent,
    '--color-activity-3': mix(70, 'white'),
    '--color-activity-4': accent,
    '--color-activity-5': mix(60, 'black'),
  }
}

/** Whether the browser accepts this value for this token (by its theme-file key). Anything else is never applied. */
export function isValidTokenValue(key: string, value: string): boolean {
  const token = THEME_TOKEN_BY_KEY.get(key)
  if (!token || !value.trim() || value.length > 400) return false
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true
  const property = token.kind === 'color' ? 'color' : token.kind === 'shadow' ? 'box-shadow' : 'width'
  return CSS.supports(property, value)
}

/** The tokens of a theme file the browser would not take, one sentence each, for Settings to show next to it */
export function unusableValues(entry: ThemeFileEntry): string[] {
  return Object.entries(entry.tokens)
    .filter(([key, value]) => !isValidTokenValue(key, value))
    .map(([key, value]) => `"${value}" is not a usable value for ${key}; it is ignored.`)
}

/** What a resolved theme is: the preset under it and the inline tokens on top. */
export type ResolvedTheme = {
  /** The id the person chose (a preset id or a custom theme's id) */
  id: string
  name: string
  base: ThemeBase
  /** The `[data-theme]` preset block under it */
  preset: string
  /** Inline overrides: a custom theme's tokens (none for a preset) */
  tokens: Record<string, string>
  /** The accent colour laid over them, or null */
  accent: string | null
}

/** The preset a side falls back to. A side with no preset of its own (light, until it has one) borrows Dark. */
function presetFor(base: ThemeBase): ThemePreset {
  return THEME_PRESETS.find((p) => p.base === base) ?? THEME_PRESETS[0]!
}

/** Which side shows: the mode, or the OS when the mode is System. */
export function activeSide(mode: UiPreferences['themeMode'], systemDark: boolean): ThemeBase {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
}

/**
 * The theme for one side. An id that names nothing (a deleted custom theme, a preset from a newer
 * build) falls back to that side's preset rather than to nothing.
 */
export function resolveSide(
  side: ThemeBase,
  id: string,
  themeFiles: readonly ThemeFileEntry[],
  accent: string | null,
): ResolvedTheme {
  const accentOn = accent && isAccentValid(accent) ? accent : null
  const file = themeFiles.find((f) => f.id === id && !f.broken)
  if (file) {
    const tokens: Record<string, string> = {}
    for (const [key, value] of Object.entries(file.tokens)) {
      if (isValidTokenValue(key, value)) tokens[THEME_TOKEN_BY_KEY.get(key)!.cssVar] = value
    }
    return { id, name: file.name, base: file.base, preset: presetFor(file.base).id, tokens, accent: accentOn }
  }
  const preset = THEME_PRESETS.find((p) => p.id === id) ?? presetFor(side)
  return { id: preset.id, name: preset.name, base: preset.base, preset: preset.id, tokens: {}, accent: accentOn }
}

function isAccentValid(accent: string): boolean {
  return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', accent)
}

/** Both sides resolved, plus the mode — what the cache keeps, so first paint can pick a side before the prefs arrive. */
export type ThemeChoice = { mode: UiPreferences['themeMode']; dark: ResolvedTheme; light: ResolvedTheme }

export function resolveChoice(prefs: UiPreferences, themeFiles: readonly ThemeFileEntry[]): ThemeChoice {
  return {
    mode: prefs.themeMode,
    dark: resolveSide('dark', prefs.themeDark, themeFiles, prefs.accent),
    light: resolveSide('light', prefs.themeLight, themeFiles, prefs.accent),
  }
}

export function pickTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  return activeSide(choice.mode, systemDark) === 'dark' ? choice.dark : choice.light
}

/** The names this module last wrote inline, so a switch removes exactly those and nothing else on `<html>`. */
let written: string[] = []

/** Puts a theme on the page. Cheap enough to run on every change: a few attribute and property writes. */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  for (const name of written) root.style.removeProperty(name)
  root.dataset.theme = theme.preset
  root.dataset.themeBase = theme.base
  // The accent goes on top of the theme's own tokens: when it is on, it is what focus, selection
  // and the orbit are, whichever theme is under it
  const layers = { ...theme.tokens, ...(theme.accent ? { '--color-accent': theme.accent, ...accentTokens(theme.accent) } : {}) }
  if (theme.accent) root.dataset.accent = ''
  else delete root.dataset.accent
  for (const [name, value] of Object.entries(layers)) root.style.setProperty(name, value)
  written = Object.keys(layers)
  window.dispatchEvent(new CustomEvent('cc-themechange'))
}

/** `matchMedia` for the OS's dark preference, or dark when there is none (a test page in node). */
export function systemPrefersDark(): boolean {
  return typeof matchMedia !== 'function' || matchMedia('(prefers-color-scheme: dark)').matches
}

const CACHE_KEY = 'cc-theme'

export function cacheChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(choice))
  } catch {
    /* storage denied — the next start paints Dark for a moment, then the prefs arrive */
  }
}

/**
 * Applies the theme the last run chose, before React draws anything (main.tsx). The real
 * preferences arrive with the host's first answer, which is too late for the first frame: a light
 * theme would open as a dark flash. Anything unreadable leaves the stylesheet's Dark in place.
 */
export function applyCachedTheme(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return
    const choice = JSON.parse(raw) as ThemeChoice
    if (!choice?.dark || !choice?.light) return
    const theme = pickTheme(choice, systemPrefersDark())
    // The cache is the page's own writing, but it is re-checked like anything stored
    const tokens: Record<string, string> = {}
    const keyOf = new Map(THEME_TOKENS.map((token) => [token.cssVar, token.key]))
    for (const [name, value] of Object.entries(theme.tokens ?? {})) {
      const key = keyOf.get(name)
      if (key && typeof value === 'string' && isValidTokenValue(key, value)) tokens[name] = value
    }
    const accent = typeof theme.accent === 'string' && isAccentValid(theme.accent) ? theme.accent : null
    applyTheme({ ...theme, tokens, accent })
  } catch {
    /* a broken cache is the same as none */
  }
}

/**
 * Reads what a preset sets every token to (by theme-file key), with the custom and accent layers
 * lifted for the moment it takes to read. Used to duplicate a preset into a theme file: the copy
 * starts from exactly what that preset puts on screen.
 */
export function readPresetTokens(preset: string, root: HTMLElement = document.documentElement): Record<string, string> {
  const saved = written.map((name) => [name, root.style.getPropertyValue(name)] as const)
  const savedTheme = root.dataset.theme
  const hadAccent = 'accent' in root.dataset
  for (const name of written) root.style.removeProperty(name)
  delete root.dataset.accent
  root.dataset.theme = preset
  try {
    const style = getComputedStyle(root)
    const out: Record<string, string> = {}
    for (const token of THEME_TOKENS) out[token.key] = style.getPropertyValue(token.cssVar).trim()
    return out
  } finally {
    if (savedTheme === undefined) delete root.dataset.theme
    else root.dataset.theme = savedTheme
    if (hadAccent) root.dataset.accent = ''
    for (const [name, value] of saved) root.style.setProperty(name, value)
  }
}

// ── The urgency order ───────────────────────────────────────────────────────────

/** The surfaces text is read on. The order has to hold on every one of them. */
export const READING_SURFACES = [
  ['--color-surface-floor', 'the floor'],
  ['--color-surface-side', 'the sidebar'],
  ['--color-surface-raised', 'raised surfaces'],
  ['--color-surface-reading', 'the conversation'],
  ['--color-surface-reading-raised', 'cards in the conversation'],
] as const

/** Strongest first: what "waiting for you" relies on (product-spec FR-12) */
export const INK_ORDER = [
  ['--color-ink-signal', 'signal'],
  ['--color-ink', 'text'],
  ['--color-ink-muted', 'secondary'],
  ['--color-ink-faint', 'background information'],
] as const

export type Rgba = [number, number, number, number]

/** WCAG relative luminance of an opaque sRGB colour (channels 0–255) */
export function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** A translucent colour as it lands on an opaque one */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3]
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]
}

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Where the urgency order breaks: on each surface, each ink must stand out more than the one
 * after it. "Contrast is urgency" (#312 decision 2) — the same rule as "brightness is urgency" in
 * dark, stated so it also holds in light. Returns one sentence per break, empty when it holds.
 */
export function urgencyBreaks(colors: Record<string, Rgba>): string[] {
  const breaks: string[] = []
  for (const [surfaceName, surfaceLabel] of READING_SURFACES) {
    const surface = colors[surfaceName]
    if (!surface) continue
    const ground = surface[3] < 1 ? over(surface, [0, 0, 0, 1]) : surface
    const ratios = INK_ORDER.map(([name]) => {
      const ink = colors[name]
      return ink ? contrast(over(ink, ground), ground) : null
    })
    for (let i = 0; i + 1 < INK_ORDER.length; i++) {
      const [a, b] = [ratios[i], ratios[i + 1]]
      if (a == null || b == null) continue
      if (!(a > b)) {
        breaks.push(`On ${surfaceLabel}, ${INK_ORDER[i + 1]![1]} stands out as much as ${INK_ORDER[i]![1]} or more.`)
      }
    }
  }
  return breaks
}

/**
 * Resolves token values to colours the way the page would, by letting the browser compute them
 * on a hidden probe and reading the pixels back from a 1×1 canvas (so any syntax the browser
 * accepts — hex, rgb, oklch, color-mix — ends up as plain sRGB).
 */
export function resolveColors(tokens: Record<string, string>, preset: string, names: readonly string[]): Record<string, Rgba> {
  const root = document.documentElement
  const probe = document.createElement('div')
  probe.dataset.theme = preset
  probe.style.display = 'none'
  for (const [name, value] of Object.entries(tokens)) probe.style.setProperty(name, value)
  root.appendChild(probe)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out: Record<string, Rgba> = {}
  try {
    for (const name of names) {
      probe.style.color = `var(${name})`
      const computed = getComputedStyle(probe).color
      if (!ctx) continue
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = computed
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      out[name] = [r!, g!, b!, a! / 255]
    }
  } finally {
    probe.remove()
  }
  return out
}
