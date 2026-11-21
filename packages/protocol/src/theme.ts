import { z } from 'zod'
import { errorMessage } from './error-message.js'
import { isRecord } from './tolerant.js'

// Theme files (docs/themes.md "Theme files"), read the same way by the host that reads, watches and writes them and
// the screen that applies them.

export type ThemeTokenKind = 'color' | 'shadow' | 'length'
export type ThemeTokenDef = {
  /** The key in a theme file: `surface-floor` */
  key: string
  /** The CSS variable it sets: `--color-surface-floor` */
  cssVar: string
  label: string
  group: string
  kind: ThemeTokenKind
  /** Left out of a file, the token takes this one's value, not the preset's: a custom theme's borders are its own lines */
  follows?: string
}

const defs = (group: string, kind: ThemeTokenKind, list: [string, string, string?][]): ThemeTokenDef[] =>
  list.map(([key, label, follows]) => ({
    key,
    cssVar: kind === 'color' ? `--color-${key}` : `--${key}`,
    label,
    group,
    kind,
    ...(follows ? { follows } : {}),
  }))

/** In Settings' order. A unit test keeps it equal to the tokens of `packages/ui/src/styles/index.css` */
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
    ['line-chrome', 'Window line: sidebar, top bar, panel headers', 'line'],
    ['line-strong', 'Strong line'],
    ['line-panel', 'Resting panel edge', 'line-strong'],
    ['line-answering', 'Answering panel edge', 'ink-muted'],
    ['line-bubble-mine', 'Your message bubble edge', 'line-strong'],
  ]),
  ...defs('Ink', 'color', [
    ['ink-signal', 'Signal: waiting for you'],
    ['ink', 'Text'],
    ['ink-muted', 'Secondary'],
    ['ink-faint', 'Background information'],
    ['mark-waiting', 'Session mark waiting on an approval: fill'],
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

export const THEME_TOKEN_BY_KEY: ReadonlyMap<string, ThemeTokenDef> = new Map(
  THEME_TOKENS.map((t) => [t.key, t]),
)

/**
 * Skipped without a problem line and still accepted by the schema, so an editor does not mark a valid file red. A token
 * is added here in the change that removes it (#844)
 */
export const RETIRED_THEME_TOKENS: readonly string[] = [
  'activity-1',
  'activity-2',
  'activity-3',
  'activity-4',
  'activity-5',
]
const RETIRED_THEME_TOKEN_SET: ReadonlySet<string> = new Set(RETIRED_THEME_TOKENS)

/** The file name without `.json` */
export const ThemeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/)

/** Its stylesheet block is `[data-theme='<id>']` (Dark is the `@theme` values themselves) */
export type ThemePreset = { id: string; name: string; base: 'dark' | 'light' }

/**
 * The stylesheet's presets, here so the host can name them too (`set_preferences`, #1219). The first of each base is
 * that side's default, which a saved id that names nothing (`graphite`, #2335) resolves to.
 */
export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'dark', name: 'Dark', base: 'dark' },
  { id: 'light', name: 'Light', base: 'light' },
  { id: 'hc-dark', name: 'High contrast dark', base: 'dark' },
  { id: 'hc-light', name: 'High contrast light', base: 'light' },
]

/** `My theme` -> `my-theme`, before `freeThemeId` adds a number */
export function themeSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'theme'
  )
}

export function isPresetThemeId(id: string): boolean {
  return THEME_PRESETS.some((p) => p.id === id)
}

/** For a new file only (#2214); one already stored under a preset's id is saved in place */
export function presetIdRefusal(id: string): string {
  return `${id} is a preset's id, and a theme file under it would hide the preset. Leave the id out and the file is filed under another one.`
}

/**
 * The one rule for host, Assistant and mock. Never a preset's id (#2214): the window looks for a file first, so a theme
 * named "Dark" would hide the preset; it gets `dark-2` and keeps its name.
 */
export function freeThemeId(name: string, isTaken: (id: string) => boolean): string {
  const base = themeSlug(name)
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (!isTaken(id) && !isPresetThemeId(id)) return id
  }
}

/** The host adds `$schema` */
export const ThemeFileContent = z.object({
  name: z.string().min(1).max(80),
  base: z.enum(['dark', 'light']),
  tokens: z.record(z.string().max(60), z.string().max(400)),
})
export type ThemeFileContent = z.infer<typeof ThemeFileContent>

export const ThemeFileEntry = z.object({
  id: ThemeId,
  path: z.string(),
  name: z.string(),
  base: z.enum(['dark', 'light']),
  /** Only the usable ones */
  tokens: z.record(z.string(), z.string()),
  /** One sentence each */
  problems: z.array(z.string()),
  /** Not JSON, or not an object */
  broken: z.boolean(),
})
export type ThemeFileEntry = z.infer<typeof ThemeFileEntry>

/**
 * For the picker and `set_preferences` alike. A broken file is never applied, so it is not offered and hides nothing; a
 * file stored under a preset's id shadows that preset, so the id is offered once, as the file.
 */
export function pickableThemes(files: readonly Pick<ThemeFileEntry, 'id' | 'name' | 'base' | 'broken'>[]): { id: string; name: string; base: 'dark' | 'light'; file: boolean }[] {
  const usable = files.filter((f) => !f.broken)
  return [
    ...THEME_PRESETS.filter((p) => !usable.some((f) => f.id === p.id)).map((p) => ({ id: p.id, name: p.name, base: p.base, file: false })),
    ...usable.map((f) => ({ id: f.id, name: f.name, base: f.base, file: true })),
  ]
}

export const THEME_SCHEMA_FILE = 'theme.schema.json'
export const THEME_SCHEMA_REF = `./${THEME_SCHEMA_FILE}`

/** Never throws: a file halfway through an edit is normal, and comes back `broken` with the reason */
export function parseThemeFile(id: string, path: string, text: string): ThemeFileEntry {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      id,
      path,
      name: id,
      base: 'dark',
      tokens: {},
      problems: [`Not valid JSON: ${errorMessage(e)}`],
      broken: true,
    }
  }
  if (!isRecord(raw)) {
    return {
      id,
      path,
      name: id,
      base: 'dark',
      tokens: {},
      problems: ['The file is not a JSON object.'],
      broken: true,
    }
  }
  const file = raw
  for (const key of Object.keys(file)) {
    if (!['$schema', 'name', 'base', 'tokens'].includes(key))
      problems.push(`Unknown key "${key}" is ignored.`)
  }
  let name = id
  if (typeof file.name === 'string' && file.name.trim()) name = file.name.trim().slice(0, 80)
  else problems.push('"name" is missing; the file name is used instead.')
  let base: 'dark' | 'light' = 'dark'
  if (file.base === 'dark' || file.base === 'light') base = file.base
  else problems.push('"base" must be "dark" or "light"; "dark" is used.')
  const tokens: Record<string, string> = {}
  const rawTokens = file.tokens
  if (rawTokens !== undefined && !isRecord(rawTokens)) {
    problems.push('"tokens" must be an object of token names to values.')
  } else {
    for (const [key, value] of Object.entries(rawTokens ?? {})) {
      if (RETIRED_THEME_TOKEN_SET.has(key)) continue
      if (!THEME_TOKEN_BY_KEY.has(key)) problems.push(`Unknown token "${key}" is ignored.`)
      else if (typeof value !== 'string' || !value.trim() || value.length > 400)
        problems.push(`Token "${key}" needs a CSS value as a string.`)
      else tokens[key] = value.trim()
    }
  }
  return { id, path, name, base, tokens, problems, broken: false }
}

/** The text of a theme file the app writes: `$schema` first, so an editor offers completion */
export function formatThemeFile(content: ThemeFileContent): string {
  return `${JSON.stringify({ $schema: THEME_SCHEMA_REF, name: content.name, base: content.base, tokens: content.tokens }, null, 2)}\n`
}

/** A test keeps `docs/theme.schema.json` equal to it */
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
      base: {
        enum: ['dark', 'light'],
        description: 'Which side this theme is for, and whose values fill the tokens left out',
      },
      tokens: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries([
          ...THEME_TOKENS.map((t): [string, object] => [
            t.key,
            { type: 'string', maxLength: 400, description: `${t.group}: ${t.label}. ${kindText[t.kind]}${t.follows ? ` Left out, it follows "${t.follows}".` : ''}` },
          ]),
          ...RETIRED_THEME_TOKENS.map((key): [string, object] => [
            key,
            { type: 'string', description: 'Retired: Centralu no longer uses this token and ignores it.' },
          ]),
        ]),
      },
    },
  }
}
