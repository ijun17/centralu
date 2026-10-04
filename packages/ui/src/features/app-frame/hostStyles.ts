import type { McpUiStyleVariableKey, McpUiTheme } from '@modelcontextprotocol/ext-apps/app-bridge'

/**
 * Centralu's theme as an app view receives it (#312 step 6).
 *
 * MCP Apps names 76 style variables (ext-apps 2.0.0 `McpUiStyleVariableKey`). Each one here is
 * mapped from a semantic token in styles/index.css, so whatever theme is on (a preset, a custom
 * file, the accent) reaches the view the way it reaches our own screens. Where Centralu has no step
 * of its own (a larger heading, a bold weight), the value is written out and noted.
 *
 * The values are **read where the view sits** (`readHostStyles(el)`): the conversation lane
 * raises its surfaces one step (styles/index.css `[data-testid='session-view']`), so a view inside
 * it gets that lane's colours, a pinned view the floor's.
 *
 * Sizes are not scaled by the text size preference: the root zoom already scales the frame and
 * everything in it (see AppFrame's `hostContext`).
 */

/** A token to read, a value written out, or a value made from what was read */
type Source = `--${string}` | { value: string } | ((read: (token: string) => string) => string)

/** A translucent wash of a token's colour, for a background that has to read under any surface */
const tint = (token: string, pct: number) => (read: (t: string) => string) => {
  const c = read(token)
  return c ? `color-mix(in srgb, ${c} ${pct}%, transparent)` : ''
}

/*
 * Centralu is achromatic, so the roles the standard gives a hue map onto the four inks: info is
 * plain ink, and warning is the signal colour, "waiting for you" (#312 decision 5). Danger and
 * success keep the only hues the chrome has, the danger red and the diff's addition green.
 */

export const STYLE_SOURCES: Record<McpUiStyleVariableKey, Source> = {
  // Backgrounds
  '--color-background-primary': '--color-surface-floor',
  '--color-background-secondary': '--color-surface-raised',
  '--color-background-tertiary': '--color-surface-hover',
  '--color-background-inverse': '--color-ink',
  '--color-background-ghost': { value: 'transparent' },
  '--color-background-info': '--color-surface-selected',
  '--color-background-danger': '--color-danger-bg',
  '--color-background-success': '--color-diff-add-bg',
  '--color-background-warning': tint('--color-ink-signal', 12),
  '--color-background-disabled': '--color-surface-raised',
  // Text: the four inks keep their order (signal > ink > muted > faint)
  '--color-text-primary': '--color-ink',
  '--color-text-secondary': '--color-ink-muted',
  '--color-text-tertiary': '--color-ink-faint',
  '--color-text-inverse': '--color-surface-floor',
  '--color-text-ghost': '--color-ink-muted',
  '--color-text-info': '--color-ink',
  '--color-text-danger': '--color-danger',
  '--color-text-success': '--color-diff-add',
  '--color-text-warning': '--color-ink-signal',
  '--color-text-disabled': '--color-ink-faint',
  // Borders
  '--color-border-primary': '--color-line',
  '--color-border-secondary': '--color-line-strong',
  '--color-border-tertiary': '--color-surface-selected',
  '--color-border-inverse': '--color-ink',
  '--color-border-ghost': { value: 'transparent' },
  '--color-border-info': '--color-line-strong',
  '--color-border-danger': '--color-danger',
  '--color-border-success': '--color-diff-add',
  '--color-border-warning': '--color-ink-signal',
  '--color-border-disabled': '--color-line',
  // Focus rings
  '--color-ring-primary': '--color-focus',
  '--color-ring-secondary': '--color-line-strong',
  '--color-ring-inverse': '--color-surface-floor',
  '--color-ring-info': '--color-focus',
  '--color-ring-danger': '--color-danger',
  '--color-ring-success': '--color-diff-add',
  '--color-ring-warning': '--color-ink-signal',
  // Type
  '--font-sans': '--font-sans',
  '--font-mono': '--font-mono',
  '--font-weight-normal': { value: '400' },
  '--font-weight-medium': '--font-weight-medium',
  '--font-weight-semibold': '--font-weight-semibold',
  '--font-weight-bold': { value: '700' },
  // Text sizes: 13px is what a person reads in Centralu, 12px the controls around it, 11px what a
  // machine wrote. There is no larger body step, so lg is written out.
  '--font-text-xs-size': '--text-xs',
  '--font-text-sm-size': '--text-sm',
  '--font-text-md-size': '--text-md',
  '--font-text-lg-size': { value: '15px' },
  // Headings: Centralu titles are 13px, and its one display heading is 19px; the rest is written out
  '--font-heading-xs-size': '--text-md',
  '--font-heading-sm-size': { value: '15px' },
  '--font-heading-md-size': { value: '17px' },
  '--font-heading-lg-size': '--text-display',
  '--font-heading-xl-size': { value: '23px' },
  '--font-heading-2xl-size': { value: '28px' },
  '--font-heading-3xl-size': { value: '34px' },
  // Line heights: body text reads at Centralu's body leading, headings at its tight one
  '--font-text-xs-line-height': '--leading-body',
  '--font-text-sm-line-height': '--leading-body',
  '--font-text-md-line-height': '--leading-body',
  '--font-text-lg-line-height': '--leading-body',
  '--font-heading-xs-line-height': '--leading-tight',
  '--font-heading-sm-line-height': '--leading-tight',
  '--font-heading-md-line-height': '--leading-tight',
  '--font-heading-lg-line-height': '--leading-tight',
  '--font-heading-xl-line-height': '--leading-tight',
  '--font-heading-2xl-line-height': '--leading-tight',
  '--font-heading-3xl-line-height': '--leading-tight',
  // Radii: sm for small marks, md for controls and cards, lg for panels, full for pills
  '--border-radius-xs': '--radius-sm',
  '--border-radius-sm': '--radius-sm',
  '--border-radius-md': '--radius-md',
  '--border-radius-lg': '--radius-lg',
  '--border-radius-xl': '--radius-lg',
  '--border-radius-full': '--radius-full',
  '--border-width-regular': { value: '1px' },
  // Shadows
  '--shadow-hairline': (read) => (read('--color-line') ? `0 0 0 1px ${read('--color-line')}` : ''),
  '--shadow-sm': '--shadow-sticky',
  '--shadow-md': '--shadow-popover',
  '--shadow-lg': '--shadow-modal',
}

/**
 * Centralu's own variables, in the `centralu` extension of the host context. The standard has no
 * scrollbar, so the template's scrollbar stylesheet reads these; the signal colour is here as well
 * as in `--color-text-warning`, under its own name.
 */
export const CENTRALU_SOURCES: Record<string, `--${string}`> = {
  '--centralu-signal': '--color-ink-signal',
  '--centralu-scrollbar-thumb': '--color-scrollbar-thumb',
  '--centralu-scrollbar-thumb-hover': '--color-scrollbar-thumb-hover',
  '--centralu-scrollbar-track': '--color-scrollbar-track',
  '--centralu-scrollbar-size': '--scrollbar-size',
  '--centralu-scrollbar-inset': '--scrollbar-thumb-inset',
  '--centralu-scrollbar-radius': '--scrollbar-radius',
}

export type HostStyles = {
  theme: McpUiTheme
  /** The standard's variables (`styles.variables`) */
  variables: Partial<Record<McpUiStyleVariableKey, string>>
  /** Centralu's own (`centralu.variables`) */
  centralu: Record<string, string>
}

/** Which side of the theme shows (app/theme.ts writes it on `<html>`) */
export function activeTheme(root: HTMLElement = document.documentElement): McpUiTheme {
  return root.dataset.themeBase === 'light' ? 'light' : 'dark'
}

/** Reads every variable from the tokens as they compute on `el`. A token that reads empty is left out. */
export function readHostStyles(el: Element | null): HostStyles {
  const theme = activeTheme()
  if (!el) return { theme, variables: {}, centralu: {} }
  const cs = getComputedStyle(el)
  const read = (token: string) => cs.getPropertyValue(token).trim()
  const resolve = (source: Source): string => (typeof source === 'string' ? read(source) : typeof source === 'function' ? source(read) : source.value)
  const variables: HostStyles['variables'] = {}
  for (const [key, source] of Object.entries(STYLE_SOURCES) as [McpUiStyleVariableKey, Source][]) {
    const v = resolve(source)
    if (v) variables[key] = v
  }
  const centralu: Record<string, string> = {}
  for (const [key, token] of Object.entries(CENTRALU_SOURCES)) {
    const v = read(token)
    if (v) centralu[key] = v
  }
  return { theme, variables, centralu }
}
