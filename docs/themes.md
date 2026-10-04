# Themes — how the look is chosen, and how to write a theme

The screen's colours, shadows and scrollbar come from tokens (`packages/ui/src/styles/index.css`).
A **theme** is a set of values for those tokens. Settings → Appearance chooses which theme shows;
a **custom theme** is a JSON file anyone — a person, an editor, an agent — can write (#312).

## Choosing

Four preferences, stored with the other screen preferences (`UiPreferences`):

| Preference | Values | What it does |
|---|---|---|
| `themeMode` | `dark` · `light` · `system` | Which side shows. `system` follows the OS (`prefers-color-scheme`). |
| `themeDark` | a preset id or a theme file's id | The theme for the dark side |
| `themeLight` | a preset id or a theme file's id | The theme for the light side |
| `accent` | a CSS colour, or `null` (default) | Colours focus, selection, the working orbit and checked boxes |

The two sides are chosen separately so that following the OS switches between two themes the
person picked. An id that names nothing (a deleted file) falls back to that side's preset.

**Presets** live in the stylesheet: the `@theme` values are the Dark preset, and any other preset
is a `[data-theme='…']` block. A side with no preset of its own yet (light, until the light
presets land) borrows Dark.

**The accent never colours the signal.** `ink-signal` is reserved for "waiting for you"
(product-spec FR-12); an accent on it would make an ordinary control compete with the one thing
that must stand out.

## Theme files

Each custom theme is one file: `<data>/themes/<id>.json`, where `<data>` is `~/.centralu`
(`~/.centralu-dev` for a development build, `CC_DATA_DIR` in tests). The id is the file name:
lowercase letters, digits and hyphens.

```json
{
  "$schema": "./theme.schema.json",
  "name": "Paper",
  "base": "light",
  "tokens": {
    "surface-floor": "#fafafa",
    "ink": "#1a1a1a",
    "ink-faint": "oklch(0.6 0 0)",
    "shadow-modal": "0 24px 60px -12px rgb(0 0 0 / 0.25)"
  }
}
```

- `name` — shown in Settings. `base` — `dark` or `light`: which side the theme is for, and whose
  values fill in every token the file leaves out. **A partial file is normal**: write only what
  you want to change.
- `tokens` — keys are token names without the `--color-` prefix (`surface-floor`, `ink-muted`,
  `term-red`); shadows and scrollbar sizes keep their own prefix (`shadow-modal`,
  `scrollbar-size`). Values are any CSS the browser accepts for that kind of token — a colour
  (`#rrggbb`, `rgb()`, `oklch()`, `color-mix()`, with alpha), a box-shadow, a length.
- **The schema.** The host writes `theme.schema.json` next to the themes, and every file the app
  creates points at it with `$schema`, so an editor completes token names and flags a typo. The
  same schema is in the repository at [`theme.schema.json`](theme.schema.json); the full token
  list with descriptions is there.
- **Mistakes never stop the app.** An unknown key or token, or a value the browser rejects, is
  listed next to the theme in Settings and skipped. A file that does not parse (halfway through an
  edit) is listed as broken, and the screen keeps showing the last version of it that did.

**Live.** The host watches the folder (`packages/agent-host/src/themes.ts`) and announces every
change (`themes_changed`); the screen re-reads the list and re-applies. Saving the file in an
editor changes the open window.

**From Settings.** *Customise…* copies the theme showing now into a new file (every token written
out) and selects it; *Edit* changes tokens with a colour picker and a text field (for values a
picker cannot hold, such as alpha or `color-mix()`); *Open file* opens it in your editor;
*Show in Finder* reveals it (that is the export: the theme already is a file); *Import…* copies a
file in; *Delete* moves it to the trash. Every write is atomic (temp file, then rename), so a
watcher or an agent reading the folder never sees half a file.

## The urgency order

In dark, brightness is urgency; stated so that it also holds in light, **contrast is urgency**. On
every surface text is read on (the floor, the sidebar, raised surfaces, the conversation and its
cards), the inks must stand out in this order:

`ink-signal` > `ink` > `ink-muted` > `ink-faint`

Settings checks each custom theme (WCAG contrast, with translucent inks measured where they land)
and warns next to it when the order breaks. It is a warning, not a refusal: a theme is the
person's, but a theme that breaks the order quietly hides what is waiting for them.

## How it is applied

`packages/ui/src/app/theme.ts`. On `<html>`: `data-theme` (the preset), `data-theme-base`
(`color-scheme` follows it), the custom tokens as inline custom properties, and the accent's
tokens on top. Everything that reads a token follows — utilities (plain `@theme`, so they read
`var()`), CSS, and xterm, which re-reads its theme on every switch (`components/terminalTheme.ts`).

The resolved choice is cached in `localStorage` and applied in `main.tsx` before the first frame,
since the preferences arrive a round trip later; without it a light theme would open with a dark
flash. The desktop window is told the side too (`SystemPort.setWindowAppearance`): a window held
to one appearance reports that appearance to the page, so System mode hands it back to the OS.
`tauri.conf.json` no longer forces the window to Dark.
