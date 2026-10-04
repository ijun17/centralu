import { z } from 'zod'

/**
 * Theme files (#312).
 *
 * A custom theme is a JSON file in the data folder's `themes/` directory, one file per theme,
 * named `<id>.json`. People and agents can write one by hand, so the format is small and
 * forgiving: a name, which side it belongs to, and the tokens it changes. Any token left out
 * keeps the value of the preset for that side. Unknown keys and values that cannot be used are
 * reported next to the theme in Settings and skipped; a file never stops the app.
 *
 * This module is shared by the host (which reads, watches and writes the folder) and the screen
 * (which applies the tokens), so both read a file the same way.
 */

export type ThemeTokenKind = 'color' | 'shadow' | 'length'
export type ThemeTokenDef = {
  /** The key in a theme file: `surface-floor` */
  key: string
  /** The CSS variable it sets: `--color-surface-floor` */
  cssVar: string
  label: string
  group: string
  kind: ThemeTokenKind
}

const defs = (group: string, kind: ThemeTokenKind, list: [string, string][]): ThemeTokenDef[] =>
  list.map(([key, label]) => ({
    key,
    cssVar: kind === 'color' ? `--color-${key}` : `--${key}`,
    label,
    group,
    kind,
  }))

/**
 * Every token a theme can set, in the order Settings shows them. `packages/ui/src/styles/index.css`
 * holds the Dark values; a unit test checks the two lists agree, so a token added to the
 * stylesheet cannot be left out of themes by accident.
 */
export const THEME_TOKENS: readonly ThemeTokenDef[] = [
  ...defs('Surfaces', 'color', [
    ['surface-floor', 'Floor'],
    ['surface-side', 'Sidebar'],
    ['surface-raised', 'Raised: cards, menus, dialogs, inputs'],
    ['surface-selected', 'Selected'],
    ['surface-hover', 'Hover'],
    ['surface-deck', 'Grid floor'],
    ['surface-reading', 'Conversation'],
    ['surface-reading-raised', 'Conversation, raised'],
  ]),
  ...defs('Lines', 'color', [
    ['line', 'Line'],
    ['line-strong', 'Strong line'],
  ]),
  ...defs('Ink', 'color', [
    ['ink-signal', 'Signal: waiting for you'],
    ['ink', 'Text'],
    ['ink-muted', 'Secondary'],
    ['ink-faint', 'Background information'],
  ]),
  ...defs('Diff and danger', 'color', [
    ['diff-add', 'Added'],
    ['diff-add-bg', 'Added, background'],
    ['diff-del', 'Deleted'],
    ['diff-del-bg', 'Deleted, background'],
    ['danger', 'Danger'],
    ['danger-bg', 'Danger, background'],
  ]),
  ...defs('Interaction', 'color', [
    ['focus', 'Focus'],
    ['selection', 'Selection'],
    ['scrim', 'Scrim'],
    ['scrim-thin', 'Thin scrim'],
    ['signal-glow', 'Signal glow'],
  ]),
  ...defs('Scrollbar', 'color', [
    ['scrollbar-track', 'Track'],
    ['scrollbar-thumb', 'Thumb'],
    ['scrollbar-thumb-hover', 'Thumb, hover'],
  ]),
  ...defs('Scrollbar', 'length', [
    ['scrollbar-size', 'Size'],
    ['scrollbar-thumb-inset', 'Thumb inset'],
    ['scrollbar-radius', 'Radius'],
  ]),
  ...defs('Keycap', 'color', [
    ['keycap-top', 'Top'],
    ['keycap-bottom', 'Bottom'],
    ['keycap-border', 'Border'],
  ]),
  ...defs('Activity', 'color', [
    ['activity-1', 'Activity 1'],
    ['activity-2', 'Activity 2'],
    ['activity-3', 'Activity 3'],
    ['activity-4', 'Activity 4'],
    ['activity-5', 'Activity 5'],
  ]),
  ...defs('Terminal', 'color', [
    ['term-bg', 'Background'],
    ['term-log-bg', 'Log background'],
    ['term-fg', 'Text'],
    ['term-cursor', 'Cursor'],
    ['term-selection', 'Selection'],
    ['term-black', 'Black'],
    ['term-red', 'Red'],
    ['term-green', 'Green'],
    ['term-yellow', 'Yellow'],
    ['term-blue', 'Blue'],
    ['term-magenta', 'Magenta'],
    ['term-cyan', 'Cyan'],
    ['term-white', 'White'],
    ['term-bright-black', 'Bright black'],
    ['term-bright-red', 'Bright red'],
    ['term-bright-green', 'Bright green'],
    ['term-bright-yellow', 'Bright yellow'],
    ['term-bright-blue', 'Bright blue'],
    ['term-bright-magenta', 'Bright magenta'],
    ['term-bright-cyan', 'Bright cyan'],
    ['term-bright-white', 'Bright white'],
  ]),
  ...defs('Shadows', 'shadow', [
    ['shadow-popover', 'Popover'],
    ['shadow-popover-up', 'Popover, upward'],
    ['shadow-dropdown', 'Dropdown'],
    ['shadow-notice', 'Notice'],
    ['shadow-modal', 'Dialog'],
    ['shadow-sticky', 'Pinned question'],
    ['shadow-dock', 'Folded composer'],
    ['shadow-dock-raised', 'Folded composer, raised'],
    ['shadow-key', 'Keycap'],
    ['shadow-chip', 'Session chip'],
  ]),
]

export const THEME_TOKEN_BY_KEY: ReadonlyMap<string, ThemeTokenDef> = new Map(THEME_TOKENS.map((t) => [t.key, t]))

/** A theme file's id is its file name without `.json`: lowercase words and hyphens */
export const ThemeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/)

/** What the screen writes into a theme file (the host adds `$schema`) */
export const ThemeFileContent = z.object({
  name: z.string().min(1).max(80),
  base: z.enum(['dark', 'light']),
  tokens: z.record(z.string().max(60), z.string().max(400)),
})
export type ThemeFileContent = z.infer<typeof ThemeFileContent>

/** One theme file as the host read it */
export const ThemeFileEntry = z.object({
  id: ThemeId,
  /** Where it is on disk, for "Open file" and "Show in Finder" */
  path: z.string(),
  name: z.string(),
  base: z.enum(['dark', 'light']),
  /** The tokens that can be used, by key. Unknown keys and unusable values are not here. */
  tokens: z.record(z.string(), z.string()),
  /** What was wrong with the file, one sentence each. Empty when it read cleanly. */
  problems: z.array(z.string()),
  /** True when the file could not be read as a theme at all (not JSON, not an object) */
  broken: z.boolean(),
})
export type ThemeFileEntry = z.infer<typeof ThemeFileEntry>

/** The schema file written next to the themes, which `$schema` in each file points at */
export const THEME_SCHEMA_FILE = 'theme.schema.json'
export const THEME_SCHEMA_REF = `./${THEME_SCHEMA_FILE}`

/**
 * Reads a theme file's text. **Never throws** — a file someone is halfway through editing is
 * the normal case, not an error; it comes back `broken` with the reason, and the screen keeps
 * showing the last version that read cleanly.
 */
export function parseThemeFile(id: string, path: string, text: string): ThemeFileEntry {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { id, path, name: id, base: 'dark', tokens: {}, problems: [`Not valid JSON: ${(e as Error).message}`], broken: true }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { id, path, name: id, base: 'dark', tokens: {}, problems: ['The file is not a JSON object.'], broken: true }
  }
  const file = raw as Record<string, unknown>
  for (const key of Object.keys(file)) {
    if (!['$schema', 'name', 'base', 'tokens'].includes(key)) problems.push(`Unknown key "${key}" is ignored.`)
  }
  let name = id
  if (typeof file.name === 'string' && file.name.trim()) name = file.name.trim().slice(0, 80)
  else problems.push('"name" is missing; the file name is used instead.')
  let base: 'dark' | 'light' = 'dark'
  if (file.base === 'dark' || file.base === 'light') base = file.base
  else problems.push('"base" must be "dark" or "light"; "dark" is used.')
  const tokens: Record<string, string> = {}
  if (file.tokens !== undefined && (typeof file.tokens !== 'object' || file.tokens === null || Array.isArray(file.tokens))) {
    problems.push('"tokens" must be an object of token names to values.')
  } else {
    for (const [key, value] of Object.entries((file.tokens as Record<string, unknown> | undefined) ?? {})) {
      if (!THEME_TOKEN_BY_KEY.has(key)) problems.push(`Unknown token "${key}" is ignored.`)
      else if (typeof value !== 'string' || !value.trim() || value.length > 400) problems.push(`Token "${key}" needs a CSS value as a string.`)
      else tokens[key] = value.trim()
    }
  }
  return { id, path, name, base, tokens, problems, broken: false }
}

/** The text of a theme file the app writes: `$schema` first, so an editor offers completion */
export function formatThemeFile(content: ThemeFileContent): string {
  return `${JSON.stringify({ $schema: THEME_SCHEMA_REF, name: content.name, base: content.base, tokens: content.tokens }, null, 2)}\n`
}

/**
 * JSON Schema (draft-07) for a theme file. The host writes it next to the themes; the same text
 * is kept in `docs/theme.schema.json` for anyone writing a theme outside the app (a test keeps
 * the two equal).
 */
export function themeFileJsonSchema(): Record<string, unknown> {
  const kindText: Record<ThemeTokenKind, string> = {
    color: 'A CSS colour: #rrggbb, rgb(), oklch(), color-mix() …',
    shadow: 'A CSS box-shadow',
    length: 'A CSS length, such as 10px',
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Centralu theme',
    description:
      'A custom theme for Centralu. Tokens left out keep the value of the preset for the same side (base). See docs/themes.md.',
    type: 'object',
    required: ['name', 'base'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      name: { type: 'string', minLength: 1, maxLength: 80, description: 'Shown in Settings → Appearance' },
      base: { enum: ['dark', 'light'], description: 'Which side this theme is for, and whose values fill the tokens left out' },
      tokens: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          THEME_TOKENS.map((t) => [t.key, { type: 'string', maxLength: 400, description: `${t.group}: ${t.label}. ${kindText[t.kind]}` }]),
        ),
      },
    },
  }
}
