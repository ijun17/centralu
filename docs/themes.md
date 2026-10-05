# Themes — how the look is chosen, and how to write a theme

The screen's colours, shadows and scrollbar come from tokens (`packages/ui/src/styles/index.css`).
A **theme** is a set of values for those tokens. Settings → Appearance chooses which theme shows;
a **custom theme** is a JSON file anyone — a person, an editor, an agent — can write (#312).
The same section sets the text: its size, the body and code fonts, and the line height ([below](#text-size-fonts-and-line-height)).

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

**Presets** live in the stylesheet: the `@theme` values are the Dark preset, and the others are
`[data-theme='…']` blocks that set every colour token:

| Preset | Id | Side |
|---|---|---|
| Dark | `dark` | dark (the default) |
| Light | `light` | light (the default) |
| High contrast dark | `hc-dark` | dark |
| High contrast light | `hc-light` | light |

Every preset puts the conversation on the floor, with what rests on it (the composer, tool cards,
approval and question cards) on the raised step and drawn with a hairline border, the way the
project-board app draws its columns and cards ([#362](https://github.com/ijun17/centralu/issues/362)).
So a session panel and an app panel beside it on the grid stand on the same ground, and an app's
view is told the steps the conversation uses ([apps.md §6.5](apps.md#65-the-theme-in-a-view-312)).
`surface-reading` and `surface-reading-raised` still exist, so a custom theme can give the
conversation surfaces of its own; the presets set them to the floor and raised values.

Dark is a dark floor (`#141414`) with raised boxes (`#1d1d1d`). The sidebar (`#1a1a1a`) stays
apart from the conversation by lightness, not only by its edge line: a reader once saw the two as
"the same colour" at three steps apart with the line between them, so the gap is kept at ΔL* 2.9.
Light keeps the dark rule in the form that survives the inversion: pure black is reserved for what
is waiting for you, and raised surfaces move toward white. It sits a step down from white: the floor
is `#e8e8e8`, raised `#f4f4f4`, the sidebar a recess at `#e0e0e0` (ΔL* 2.8 below the conversation),
and no surface is pure white. The comments in `styles/index.css` record the measurements. The high-contrast presets put every ink at 4.5:1 or more and the hairline at 3:1 or
more against every reading surface. A test checks the urgency order (below) for every preset, and
those two thresholds for the high-contrast ones.

A few things change with the side rather than the tokens: `color-scheme` follows it, the gust that
marks a finished response multiplies instead of screening on a light side (screen cannot lighten
white), and file-kind icons get a hairline outline there, since several vscode-icons are drawn pale
for a dark editor.

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

**The first paint comes before all of that** ([#340](https://github.com/ijun17/centralu/issues/340)). With the window no
longer forced to Dark, WKWebView painted its own default until the bundle loaded, and under a light OS appearance that
default is white. `main.tsx` runs only after the bundle, so a small inline script in `index.html` (desktop and web, the
same text) runs before any stylesheet or module: it reads the same `cc-theme` cache, picks the side the same way, and
sets `background-color` and `color-scheme` on `<html>` to that theme's floor (a custom theme's own floor token, else its
preset's). Nothing cached paints the stylesheet's Dark, `#141414`. `applyTheme` removes the two inline values, because
from then on the stylesheet owns them, and a leftover inline `color-scheme` would outrank `html[data-theme-base]`
after a switch.

| Decision | Why |
|---|---|
| A script, not an inline `<style>` | The floor depends on the cache, which only a script can read. The values go in through the CSSOM, which no CSP governs, so `style-src` is untouched |
| The desktop CSP allows it by hash (`script-src 'self' 'sha256-…'`) | `script-src 'self'` refuses inline scripts. A hash allows exactly this text and nothing else. `tooling/first-paint.test.ts` fails with the new hash when the script changes |
| The preset floors are written into the script | The stylesheet has not loaded yet, so there is nothing to read them from. The same test compares them with `index.css` |
| The native window does not read the cache at launch | Rust would need a cached value of its own, written by the page. The document loads from the bundle's embedded assets, and the script paints with its first frame. Only the gap before that frame is left, and it is not worth a second cache |

## Text: size, fonts and line height

Settings → Appearance also sets the text (#312 step 5). Four more preferences in `UiPreferences`,
applied the way a theme is — as values for tokens, written on `<html>` (`packages/ui/src/app/typography.ts`):

| Preference | Values | What it does |
|---|---|---|
| `textSize` | `0.85` · `0.925` · `1` (default) · `1.1` · `1.25` | The root's CSS zoom: the whole screen scales, like the OS's display scaling. Any other number lands on the nearest step |
| `bodyFont` | a family or a list, `''` (default) | Goes in front of `--font-sans`: replies, titles, controls |
| `codeFont` | a family or a list, `''` (default) | Goes in front of `--font-mono`: code blocks and spans, paths, readouts, and every terminal |
| `lineHeight` | `compact` · `normal` (default) · `relaxed` | Multiplies `--leading-body` (1.65) and `--leading-code` (1.5) by 0.88 · 1 · 1.12 |

Settings offers a short list of common fonts and *Other…* for any installed font by name. What is
typed is quoted name by name (`JetBrains Mono` becomes `"JetBrains Mono"`; a generic keyword such as
`monospace` stays bare) and checked by the browser before it is kept.

| Decision | Why |
|---|---|
| The app's stack is always appended after the picked font | A font that is not installed, or a Latin font with no Hangul, falls back glyph by glyph to what shows today. Replacing the stack would turn Korean into whatever the OS picks last |
| A default writes nothing on the root | The stylesheet's own values show, so a person who never opens these settings sees exactly the screen from before they existed (checked with the style snapshot) |
| The terminal follows the code font | The terminal is text a machine wrote, like a path or a log. Step 1 kept xterm on its own stack only so that the token rename moved nothing. On a font change xterm re-reads it and refits, so the shell gets its new columns |
| Line height leaves `--leading-tight` and the fixed-row views alone | A heading or a two-line label is set to fit its box. The code viewer (18px rows), the diff (~17px) and the commit graph (38px) are virtual lists or drawn lanes that know their row height in pixels (see the comments there) |
| The text size moved out of the workspace snapshot | It is a way of looking, like the theme, not a place things are. The host moves the snapshot's old step (`textScale`, 0..4) into the record once, on the first read that finds no `textSize` there; after that the record has its own value and the old field is ignored |
| Markdown keeps its em sizes | A heading (1.25em) or a code span (0.92em) is sized against the reply's own text, so it keeps its proportion whichever font is picked; the text size is a zoom over everything, so there is nothing else for them to follow |

Like the theme, the last choice is cached (`cc-typography` in `localStorage`) and applied in `main.tsx`
before the first frame, so a different font or zoom does not reflow the screen once the preferences
arrive. A font or line-height change is announced with the theme's `cc-themechange`, which is what
xterm and app views listen to. The composer's caret maths (`features/session/caret.ts`) reads the
textarea's computed line height in pixels and copies it to its mirror, so it needs nothing from here.

## Apps

App views get the theme too ([apps.md](apps.md) §6.5): the side as the MCP Apps `theme`, all 76
standard style variables mapped from these tokens, and in the `centralu` extension the signal colour
and the scrollbar tokens. Every switch, custom-theme edit and accent change reaches open views
without reloading them, and so does a change of font or line height: `--font-sans`, `--font-mono` and
the line-height variables are read from the same tokens. The text size is not sent as sizes (the root
zoom already scales the frame); `centralu.fontScale` reports it. The signal colour is the standard's warning colour there, so an app that
marks "waiting for you" with it keeps the urgency order. The app template applies all of it and
ships Centralu's scrollbar as a stylesheet; apps are encouraged to use both, never checked.
