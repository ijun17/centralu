import { THEME_PRESETS, pickableThemes, THEME_TOKENS, THEME_TOKEN_BY_KEY, type ThemeFileEntry, type ThemePreset, type UiPreferences } from '@cc/protocol/client'
import { readStored, writeStored } from './stored.js'

/**
 * The theme engine: docs/themes.md "How it is applied". A custom theme's tokens go inline on `<html>` over its
 * preset, and a token it leaves out keeps the preset's value.
 */

export type ThemeBase = 'dark' | 'light'

/** The protocol's list, so the host names the same presets (#1219); the first of each base is that side's default */
export { THEME_PRESETS }
export type { ThemePreset }

export { THEME_TOKENS, pickableThemes }

/** By theme-file key; a value the browser rejects is never applied */
export function isValidTokenValue(key: string, value: string): boolean {
  const token = THEME_TOKEN_BY_KEY.get(key)
  if (!token || !value.trim() || value.length > 400) return false
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true
  const property = token.kind === 'color' ? 'color' : token.kind === 'shadow' ? 'box-shadow' : 'width'
  return CSS.supports(property, value)
}

export function unusableValues(entry: ThemeFileEntry): string[] {
  return Object.entries(entry.tokens)
    .filter(([key, value]) => !isValidTokenValue(key, value))
    .map(([key, value]) => `"${value}" is not a usable value for ${key}; it is ignored.`)
}

export type ResolvedTheme = {
  /** The id the person chose (a preset id or a custom theme's id) */
  id: string
  name: string
  base: ThemeBase
  /** The `[data-theme]` preset block under it */
  preset: string
  /** A custom theme's tokens, inline (none for a preset) */
  tokens: Record<string, string>
}

/** A side with no preset of its own borrows Dark */
function presetFor(base: ThemeBase): ThemePreset {
  return THEME_PRESETS.find((p) => p.base === base) ?? THEME_PRESETS[0]!
}

/** The picked theme's side, never the OS; a stored `system` reads as Dark: docs/themes.md "Choosing" */
export function activeSide(mode: UiPreferences['themeMode']): ThemeBase {
  return mode === 'light' ? 'light' : 'dark'
}

/** An id that names nothing (a deleted custom theme, a newer build's preset) falls back to the side's preset */
export function resolveSide(
  side: ThemeBase,
  id: string,
  themeFiles: readonly ThemeFileEntry[],
): ResolvedTheme {
  const file = themeFiles.find((f) => f.id === id && !f.broken)
  if (file) {
    const tokens: Record<string, string> = {}
    for (const [key, value] of Object.entries(file.tokens)) {
      if (isValidTokenValue(key, value)) tokens[THEME_TOKEN_BY_KEY.get(key)!.cssVar] = value
    }
    // A border the file leaves out follows the file's own token, never the preset's: docs/themes.md "The lines"
    for (const token of THEME_TOKENS) {
      const target = token.follows ? THEME_TOKEN_BY_KEY.get(token.follows) : undefined
      if (target && !(token.cssVar in tokens)) tokens[token.cssVar] = `var(${target.cssVar})`
    }
    return { id, name: file.name, base: file.base, preset: presetFor(file.base).id, tokens }
  }
  const preset = THEME_PRESETS.find((p) => p.id === id) ?? presetFor(side)
  return { id: preset.id, name: preset.name, base: preset.base, preset: preset.id, tokens: {} }
}

/** What the cache keeps, so first paint can pick a side before the preferences arrive */
export type ThemeChoice = { mode: UiPreferences['themeMode']; dark: ResolvedTheme; light: ResolvedTheme }

/** A stored `accent` is not applied: docs/themes.md "Choosing" */
export function resolveChoice(prefs: UiPreferences, themeFiles: readonly ThemeFileEntry[]): ThemeChoice {
  return {
    mode: prefs.themeMode,
    dark: resolveSide('dark', prefs.themeDark, themeFiles),
    light: resolveSide('light', prefs.themeLight, themeFiles),
  }
}

export function pickTheme(choice: ThemeChoice): ResolvedTheme {
  return activeSide(choice.mode) === 'dark' ? choice.dark : choice.light
}

/** What this module last wrote inline, so a switch removes exactly those and nothing else on `<html>` */
let written: string[] = []

export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  for (const name of written) root.style.removeProperty(name)
  // The first-paint script's inline values (#340) would outrank the stylesheet: docs/themes.md "How it is applied"
  root.style.removeProperty('background-color')
  root.style.removeProperty('color-scheme')
  root.dataset.theme = theme.preset
  root.dataset.themeBase = theme.base
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value)
  written = Object.keys(theme.tokens)
  window.dispatchEvent(new CustomEvent('cc-themechange'))
}

const CACHE_KEY = 'cc-theme'

/** Storage denied: the next start paints Dark for a moment, then the prefs arrive */
export function cacheChoice(choice: ThemeChoice): void {
  writeStored(CACHE_KEY, choice)
}

/** The last run's theme before React draws: docs/themes.md "How it is applied". Unreadable: the stylesheet's Dark */
export function applyCachedTheme(): void {
  try {
    const choice = readStored(CACHE_KEY) as ThemeChoice | undefined
    if (!choice?.dark || !choice?.light) return
    const theme = pickTheme(choice)
    // The cache is the page's own writing, but it is re-checked like anything stored
    const tokens: Record<string, string> = {}
    const keyOf = new Map(THEME_TOKENS.map((token) => [token.cssVar, token.key]))
    for (const [name, value] of Object.entries(theme.tokens ?? {})) {
      const key = keyOf.get(name)
      if (key && typeof value === 'string' && isValidTokenValue(key, value)) tokens[name] = value
    }
    applyTheme({ ...theme, tokens })
  } catch {
    /* a broken cache is the same as none */
  }
}

/**
 * The last run's custom themes, for `lastGoodThemes` before any file is read: a file broken at start has no clean
 * version yet, and Dark would be written over the cache (docs/themes.md "Theme files"). Re-checked like the cache above.
 */
export function cachedThemeFiles(): Record<string, ThemeFileEntry> {
  const out: Record<string, ThemeFileEntry> = {}
  const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined)
  const choice = readStored(CACHE_KEY)
  for (const theme of [field(choice, 'dark'), field(choice, 'light')]) {
    const id = field(theme, 'id')
    const base = field(theme, 'base')
    if (typeof id !== 'string' || THEME_PRESETS.some((p) => p.id === id) || (base !== 'dark' && base !== 'light')) continue
    const tokens: Record<string, string> = {}
    for (const token of THEME_TOKENS) {
      const value = field(field(theme, 'tokens'), token.cssVar)
      if (typeof value === 'string' && isValidTokenValue(token.key, value)) tokens[token.key] = value
    }
    const name = field(theme, 'name')
    out[id] = { id, path: '', name: typeof name === 'string' ? name : id, base, tokens, problems: [], broken: false }
  }
  return out
}

/** A preset's tokens (by theme-file key), read with the custom layer lifted: a copy starts from what the preset shows */
export function readPresetTokens(preset: string, root: HTMLElement = document.documentElement): Record<string, string> {
  const saved = written.map((name) => [name, root.style.getPropertyValue(name)] as const)
  const savedTheme = root.dataset.theme
  for (const name of written) root.style.removeProperty(name)
  root.dataset.theme = preset
  try {
    const style = getComputedStyle(root)
    const out: Record<string, string> = {}
    for (const token of THEME_TOKENS) out[token.key] = style.getPropertyValue(token.cssVar).trim()
    return out
  } finally {
    if (savedTheme === undefined) delete root.dataset.theme
    else root.dataset.theme = savedTheme
    for (const [name, value] of saved) root.style.setProperty(name, value)
  }
}

// ── The urgency order ───────────────────────────────────────────────────────────

/** The order has to hold on every one of these */
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
function luminance([r, g, b]: Rgba): number {
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

/** One sentence per break of the order on any surface; empty when it holds */
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

/** Computed on a hidden probe and read back from a 1×1 canvas, so any syntax (oklch, color-mix) ends as plain sRGB */
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
