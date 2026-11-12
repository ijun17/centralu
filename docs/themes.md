# Themes — how the look is chosen, and how to write a theme

The screen's colours, shadows and scrollbar come from tokens (`packages/ui/src/styles/index.css`).
A **theme** is a set of values for those tokens. Settings → Appearance chooses which theme shows;
a **custom theme** is a JSON file anyone — a person, an editor, an agent — can write (#312). The Assistant writes, lists and removes theme files through `set_preferences` / `get_preferences`
(`themeFile`, `deleteThemeFile`), by the same host code as Settings (`themes.save`, `themes.remove`); a removed file moves
to `themes/.removed/` under a name of its own rather than being destroyed (#1978).
The same section sets the text: its size, the body and code fonts, and the line height ([below](#text-size-fonts-and-line-height)).

## Choosing

Settings → Appearance → Theme is **one list of every theme** (the presets, then the person's own
files): picking one is the whole choice. It is stored with the other screen preferences
(`UiPreferences`) in three fields, so the stored shape stays what older builds read:

| Preference | Values | What it does |
|---|---|---|
| `themeMode` | `dark` · `light` | Which side shows: the side of the theme picked. A `system` that an older build stored reads as Dark. |
| `themeDark` | a preset id or a theme file's id | The theme for the dark side |
| `themeLight` | a preset id or a theme file's id | The theme for the light side |

Picking a theme sets `themeMode` to its side and that side's field to its id; the other side keeps its
last theme. **The app never follows the OS**: Dark is the default and nothing switches it behind the
person's back (`prefers-color-scheme` is not read, at first paint or after). There is no accent either:
Settings stopped offering it, and an `accent` an older build stored is not applied. A theme file can
still set `focus` and `selection` itself. An id that names nothing (a deleted file) falls back to that
side's preset.

**Presets** live in the stylesheet: the `@theme` values are the Dark preset, and the others are
`[data-theme='…']` blocks that set every colour token:

| Preset | Id | Side |
|---|---|---|
| Dark | `dark` | dark (the default) |
| Light | `light` | light (the default) |
| High contrast dark | `hc-dark` | dark |
| High contrast light | `hc-light` | light |
| Graphite | `graphite` | dark |

Every preset puts the conversation on the floor, with what rests on it (the composer, tool cards,
approval and question cards) on the raised step and drawn with a hairline border, the way the
project-board app draws its columns and cards ([#362](https://github.com/ijun17/centralu/issues/362)).
So a session panel and an app panel beside it on the grid stand on the same ground, and an app's
view is told the steps the conversation uses ([apps/view-theme-layout-drag.md](apps/view-theme-layout-drag.md#the-theme-in-a-view-312)).
`surface-reading` and `surface-reading-raised` still exist, so a custom theme can give the
conversation surfaces of its own; the presets set them to the floor and raised values.

Dark is a warm dark floor (`#120e0a`) with raised boxes (`#282320`, ΔL* 10.0 above the floor). Since 2026-11-05
(the owner's decision) its greys carry a faint warm tint, the colours of the "Dark Warm" custom theme, with the lightness steps
the neutral Dark had (floor `#0f0f0f`, raised `#242424`, ΔL* 9.9) within 0.1 and the same contrast. The
sidebar and the top bar are the floor's own `#120e0a` (the owner's ask, 2026-10-27), so only the edge line (`#45403c`, the sidebar's `line-chrome`, as the top bar's line is since #2207)
parts them from the conversation. They were `#181818` (ΔL* 3.9, at the owner's ask of 2026-10-20) and `#1d1d1d` (6.5) before: a reader once saw
the two as "the same colour" at three steps apart with the line between them, and the owner chose to let the line do it alone. Dark had narrower steps (floor `#141414`, sidebar `#1a1a1a`, raised
`#1d1d1d`, ΔL* 2.9 and 4.5) until the owner asked for wider ones ([#725](https://github.com/ijun17/centralu/issues/725)),
with the inks widened to match (16.4:1, 8.1:1 and 3.9:1 on the floor, as they still are). The inks are now body `#f0ecea`, secondary `#aca7a3`
and background `#756f6b`. A custom theme whose `base` is `dark` inherits these warm values for every token its file leaves out. Light and the high-contrast presets did not change.

**Graphite** (`graphite`, the owner's "Dark Graphite" custom theme made a preset, [#2208](https://github.com/ijun17/centralu/issues/2208)) is the dark theme without the warm tint: neutral greys in the style of macOS (floor `#1d1d1d`, sidebar `#28282a`, raised `#2c2c2e`; ink `#f5f5f7`, `#b0b0b5` and `#8e8e93`), with Apple's system colours for the focus ring, the selection and the terminal. Dark stays the dark side's default: Graphite is the second dark preset, chosen in the list like any other. Every value is the file's own but its `line`, one step lighter (`#3a3a3c`, from `#38383a`) to meet the hairline rule in [The lines](#the-lines); the comment above its block in `index.css` records the inks' measurements on every reading surface, and [The lines](#the-lines) the lines'. A person who already has the custom theme file keeps it as it is: the file is a theme of its own beside the preset, shows by its own name in the list, and nothing migrates or deletes it, so the two look the same until they edit one.

Light keeps the dark rule in the form that survives the inversion: pure black is reserved for what
is waiting for you, and raised surfaces step toward the floor's own white. Since 2026-11-12 (the owner's decision) it is the owner's "Light New" custom theme, the way Graphite is "Dark Graphite": macOS-style greys a step or two
bluer than neutral, a white floor (`#ffffff`), raised `#f7f7f8` and the sidebar a recess at `#efefef`. The signal is
`#000000` and the body ink `#1d1d1f`; the focus ring and the terminal's selection are the system blue (`#0066d6`,
`#cfe3ff`). It replaced the earlier Light (floor `#f0f0f0`, raised `#f9f9f9`, sidebar `#e0e0e0`, signal `#111111`, ink
`#2a2a2a`). Every token the file sets is the preset's value now; the ones it does not set kept the earlier Light's (the diff and danger colours, the keycap, the
terminal's ANSI colours, the scrim, the glow, and the notice, sticky, dock, key and chip shadows), and its window line
(`line-chrome`) is what its `line` and `ink-faint` mixed to, `#ceced1`. Three edges are written as colours of their own, softer than the
hairline there (owner, 2026-10-19), and did not move: a resting panel's border (`#d4d4d4`) and an answering one (`#9e9e9e`), a message
bubble's and a tool card's. The comments in `styles/index.css` record the measurements. The high-contrast presets put every ink at 4.5:1 or more and the hairline at 3:1 or
more against every reading surface. A test checks the urgency order (below) for every preset, and
those two thresholds for the high-contrast ones.

A few things change with the side rather than the tokens: `color-scheme` follows it, the gust that
marks a finished response multiplies instead of screening on a light side (screen cannot lighten
white), and file-kind icons get a hairline outline there, since several vscode-icons are drawn pale
for a dark editor.

**No theme colours the signal for decoration.** `ink-signal` is reserved for "waiting for you"
(product-spec FR-12); a hue on it would make an ordinary control compete with the one thing
that must stand out. (There is no accent setting any more; see [Choosing](#choosing).)

## Theme files

Each custom theme is one file: `<data>/themes/<id>.json`, where `<data>` is `~/.centralu`
(`~/.centralu-dev` for a development build, `CC_DATA_DIR` in tests). The id is the file name:
lowercase letters, digits and hyphens. A theme the app files by its name never takes a preset's id (a custom "Graphite" is `graphite-2`, keeping its name), so both can be picked; a file you name `graphite.json` yourself takes the preset's place in the picker.

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
  edit) is listed as broken, and the screen keeps showing the last version of it that did. A window that starts with the file broken has read no version yet, so the last run's cache (`cc-theme`) stands in for it, and the theme keeps its floor instead of falling to Dark (#1979).
- **A token Centralu stopped using is skipped without a word.** A theme made before it left still
  names it, and nothing is wrong with that file: `activity-1` to `activity-5` went with the working
  orbit (#742), and the schema still accepts them, marked retired (`RETIRED_THEME_TOKENS`).

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

A session's state is drawn with the same inks and no hue or motion (#736). The sidebar mark has four
looks: idle (the chip's own `line-strong` border), answering (a 1.5px `ink-muted` ring, light grey: working, nothing to do), stopped
(the same ring dashed, the chip on `surface-selected`: an error, an interruption or a limit) and
waiting (the solid ring, the chip on `surface-selected`: an approval or a question). A grid or project
panel follows with its own 1px border: `ink-muted` while answering (a lighter grey, `#9e9e9e`, in Light), `ink-signal` while waiting, dashed `ink-signal` when stopped.

## The lines

Three tokens draw every edge, and one rule orders them. `line` is the hairline (a card's or panel's border, a divider): visible but quiet. `line-chrome` is the window chrome's line, a step stronger. `line-strong` is for what has to read (a focused or hovered field, a checkbox, a table's cells in an answer, an idle session mark), clearly stronger again.

**The window chrome's line.** `line-chrome` is one colour a theme sets (it was mixed from `line` and `ink-faint` until the owner asked, 2026-11-12, for one border colour per theme). Three kinds of border are drawn in exactly it:

- **The sidebar's:** its lines and its edge. The sidebar swaps it in for `line` inside itself (`SIDEBAR_VARS`).
- **The top bar's:** its bottom line, and the shell banner's under it (`border-line-chrome`).
- **The session panel's:** its header's bottom line (`SessionHeader.tsx`), the untrusted-project notice's and the session notes' lines, the line above a framed composer, and the pinned app panel's header (`AppPanel.tsx`, which sits beside it in the grid). With them the evidence panel's edge, its header's line and the overlay header's line, which all sit on the sidebar's ground and meet the others in one line across the window. A panel's own frame stays `line-strong` (the panel's border is brighter than any line inside it, owner 2026-09-11), and cards and dialogs keep `line`.

A preset sets it to the value it drew before, so no preset changed. **A theme file that leaves it out gets its own `line`** (`resolveSide` writes `var(--color-line)`), not the preset's chrome colour and nothing mixed in: a file that sets `line` and not `line-chrome` has one colour for both. An older build reading a file with the key lists it as an unknown token and ignores it, and a newer build reads an older file as just said ([stored-shapes.md](stored-shapes.md)).

**The conversation's frames** are tokens of their own, each a colour the theme sets (the owner's goal, 2026-11-12: every border on screen is a theme colour, never a mix and never a hard-coded value that ignores the theme):

| Token | Draws | Left out, it follows |
|---|---|---|
| `line-panel` | a resting session or app panel's frame, in the grid and on a project screen | `line-strong` |
| `line-answering` | the same frame while its session answers, with its half-pixel ring and glow | `ink-muted` |
| `line-bubble` | the agent's answer bubble, and a relayed message's | `line` |
| `line-bubble-mine` | the person's own bubble | `line-strong` |
| `line-tool` | a tool call's card (a failed one keeps its dashed `line-strong`, a Centralu call its `line-strong`) | `line` |

Light used to draw these in colours of its own that every light theme inherited (a resting panel `#d4d4d4`, answering `#9e9e9e`, the bubbles `#e6e6e6` and `#cdcdcd`, the card `#e2e2e2`, owner 2026-10-19), so a custom light theme such as Pink had grey frames. Those values are the Light preset's tokens now; the dark and high-contrast presets set the colours these were drawn with (`line-strong`, `ink-muted`, `line`, and the person's bubble as `ink-faint` at 40% over `surface-hover`, written out as a solid colour). A theme file that leaves one out follows the token in the table (`follows` in `THEME_TOKENS`; `resolveSide` writes the `var()`), so Pink's frames are its own `line` and `line-strong`.

**No border is a part of a colour.** `border-line/60` and its kind (43 uses) drew `line` at 60 or 70% over the ground, so the line was a blend with whatever lay under it: 1.06 to 1.27:1 in Dark, Light and Graphite (under the rule below) and 2.1 to 2.6:1 in the high-contrast presets (under their 3:1). They are the solid `line` now (or `line-strong` for the selected chip's and the attachment's edge, which were `ink-faint` or `ink-muted` at 40 to 50%), and `tooling/styles.test.ts` fails on a border or divider class with an opacity on a line or ink token. Where one wanted to be lighter than `line`, it is not: `line` already is the quiet hairline, and the rule puts the floor at 1.2:1.

**The rule**, measured as WCAG contrast of the line against each of the three grounds a line is drawn on (the floor, the sidebar, a raised surface), the lowest of the three counting:

| Token | At least | Why this number |
|---|---|---|
| `line` | 1.2:1 | Below it a line is lost: the top bar's `line` was 1.10:1 on Light's sidebar and read as no line at all (a custom `line` `#232326` on a `#252528` sidebar, 1.03:1, was gone). Dark's lowest is 1.28:1 (on raised); Light's and Graphite's are 1.23:1 now, so 1.2 is a floor close to what the presets already draw, not a new look |
| `line-chrome` | 1.4:1 | A step over `line` on the grounds it sits on, so the sidebar's lines and its edge stand apart from the conversation beside them. Dark's lowest is 1.52:1, Light's 1.47:1 |
| `line-strong` | 1.7:1, and 0.25 over `line-chrome` | "Clearly stronger" in numbers: Dark's lowest is 1.83:1, 0.31 over its `line-chrome`. Light's was 1.42:1, and would have fallen under its own `line-chrome` once `line` rose |

The high-contrast presets keep the hairline at 3:1 or more on every reading surface, for `line` and `line-chrome` both; their `line-strong` is far above the rule. `e2e/fixtures/theme.ts` checks all of this for every preset, so a preset cannot drift back.

What changed, per preset (contrast on the floor / the sidebar / a raised surface; before, then after):

| Preset | `line` | `line-chrome` | `line-strong` |
|---|---|---|---|
| Dark (unchanged) | `#3a3531` 1.59 / 1.59 / 1.28 | `#45403c` 1.88 / 1.88 / 1.52 | `#514c48` 2.27 / 2.27 / 1.83 |
| Light, before (the earlier Light) | `#cbcbcb` 1.42 / 1.23 / 1.54 | `#bababa` 1.70 / 1.47 / 1.84 | `#aaaaaa` 2.04 / 1.76 / 2.21 |
| Light, now (Light New, the owner's values) | `#e3e3e6` 1.28 / 1.11 / 1.20 | `#ceced1` 1.57 / 1.37 / 1.47 | `#c6c6cb` 1.70 / 1.48 / 1.59 |
| High contrast dark (unchanged) | `#707070` 4.24 / 4.24 / 3.87 | `#797979` 4.82 / 4.82 / 4.40 | `#a8a8a8` 8.83 / 8.83 / 8.06 |
| High contrast light (unchanged) | `#767676` 4.54 on all | `#707070` 4.95 on all | `#4a4a4a` 8.86 on all |
| Graphite, before | `#38383a` 1.44 / 1.26 / 1.19 | `#48484b` 1.85 / 1.61 / 1.53 | `#545456` 2.23 / 1.95 / 1.84 |
| Graphite, after | `#3a3a3c` 1.49 / 1.30 / 1.23 | `#4a4a4c` 1.91 / 1.66 / 1.58 | `#545456` 2.23 / 1.95 / 1.84 (unchanged) |

- **Light** is the owner's "Light New" with its values kept as they are, and they miss the rule in the cells below (the same measure: the floor / the sidebar / a raised surface). The test fails for it on exactly these. The smallest value that passes is next to each; the owner decides between keeping his values and these.

  | Token | The owner's value | Fails on | Smallest passing | Its contrast |
  |---|---|---|---|---|
  | `line` (1.2:1) | `#e3e3e6` 1.28 / 1.11 / 1.20 | the sidebar (1.11), a raised surface by a hair (1.196) | `#dbdbde` | 1.38 / 1.20 / 1.29 |
  | `line-chrome` (1.4:1) | `#ceced1` 1.57 / 1.37 / 1.47 | the sidebar (1.37) | `#cbcbce` | 1.62 / 1.41 / 1.51 |
  | `line-strong` (1.7:1, and 0.25 over `line-chrome`) | `#c6c6cb` 1.70 / 1.48 / 1.59 | the sidebar (1.48) and a raised surface (1.59); the step over `line-chrome` is 0.13 / 0.11 / 0.12 | `#b8b8bd` (with `line-chrome` `#cbcbce`) | 1.98 / 1.72 / 1.85 |

  Every ink keeps the urgency order and clears 7 / 4.5 / 3:1 on every reading surface (body 14.6 on the sidebar, secondary 5.2, background 3.6). A person who already has the "Light New" file keeps it as it is, as with Graphite.
- **Graphite** is the owner's file and kept every value but one: `line` `#38383a` was 1.19:1 on raised, under the rule, and `#3a3a3c` (the step above, also its `surface-selected`) is 1.23:1. Nothing else in it broke the rule.
- **Dark and the high-contrast presets** already kept the rule, so none of their lines changed. The top bar's and the shell banner's line in Dark is now `line-chrome`, as the sidebar's always was.
- The evidence panel and the other panels drawn on the sidebar's ground keep the plain `line`: raising Light's `line` lifts them, and they sit at 1.23:1 on that ground now, not 1.10:1.

## How it is applied

`packages/ui/src/app/theme.ts`. On `<html>`: `data-theme` (the preset), `data-theme-base`
(`color-scheme` follows it) and the custom tokens as inline custom properties. Everything that reads a token follows — utilities (plain `@theme`, so they read
`var()`), CSS, and xterm, which re-reads its theme on every switch (`components/terminalTheme.ts`).

The resolved choice is cached in `localStorage` and applied in `main.tsx` before the first frame,
since the preferences arrive a round trip later; without it a light theme would open with a dark
flash. The desktop window is told the side too (`SystemPort.setWindowAppearance`): a window held
to the theme's appearance, whatever the OS is set to, and reports it to the page.
`tauri.conf.json` no longer forces the window to Dark.

**The first paint comes before all of that** ([#340](https://github.com/ijun17/centralu/issues/340)). With the window no
longer forced to Dark, WKWebView painted its own default until the bundle loaded, and under a light OS appearance that
default is white. `main.tsx` runs only after the bundle, so a small inline script in `index.html` (desktop and web, the
same text) runs before any stylesheet or module: it reads the same `cc-theme` cache, picks the side the same way, and
sets `background-color` and `color-scheme` on `<html>` to that theme's floor (a custom theme's own floor token, else its
preset's). Nothing cached paints the stylesheet's Dark, `#120e0a`. `applyTheme` removes the two inline values, because
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

The defaults are bundled with the UI (#731, `packages/ui/src/assets/fonts/`): **Pretendard** leads
`--font-sans` and **D2Coding** leads `--font-mono`, so the desktop app, the browser and Windows show
the same type; the system fonts stay behind them. Both are under the SIL Open Font License 1.1, with
the licence next to the files and inside them. Pretendard is a static file per weight the UI uses,
not the variable font, which WebKit on Linux lays out several times slower (#746). They load with `font-display: block` and start loading
before the first frame (`apps/web/src/main.tsx`); a terminal opened before D2Coding finished measures
its cell again when it does. App views receive the same stacks but not the font files, so a view
shows its system fallback until it bundles the fonts itself.

Settings offers a short list of common fonts, *System* / *System monospace* for the OS's own, and
*Other…* for any installed font by name. What is
typed is quoted name by name (`JetBrains Mono` becomes `"JetBrains Mono"`; a generic keyword such as
`monospace` stays bare) and checked by the browser before it is kept.

| Decision | Why |
|---|---|
| The app's stack is always appended after the picked font | A font that is not installed, or a Latin font with no Hangul, falls back glyph by glyph to what shows today. Replacing the stack would turn Korean into whatever the OS picks last |
| A default writes nothing on the root | The stylesheet's own values show, so a person who never opens these settings sees exactly the screen from before they existed (checked with the style snapshot) |
| The terminal follows the code font | The terminal is text a machine wrote, like a path or a log. Step 1 kept xterm on its own stack only so that the token rename moved nothing. On a font change xterm re-reads it and refits, so the shell gets its new columns |
| Line height leaves `--leading-tight` and the fixed-row views alone | A heading or a two-line label is set to fit its box. The code viewer (18px rows), the diff (~17px) and the commit graph (38px) are virtual lists or drawn lanes that know their row height in pixels (see the comments there) |
| The text size moved out of the workspace snapshot | It is a way of looking, like the theme, not a place things are |
| Markdown keeps its em sizes | A heading (1.25em) or a code span (0.92em) is sized against the reply's own text, so it keeps its proportion whichever font is picked; the text size is a zoom over everything, so there is nothing else for them to follow |

Like the theme, the last choice is cached (`cc-typography` in `localStorage`) and applied in `main.tsx`
before the first frame, so a different font or zoom does not reflow the screen once the preferences
arrive. A font or line-height change is announced with the theme's `cc-themechange`, which is what
xterm and app views listen to. The composer's caret maths (`features/session/caret.ts`) reads the
textarea's computed line height in pixels and copies it to its mirror, so it needs nothing from here.

## Apps

App views get the theme too ([apps/view-theme-layout-drag.md](apps/view-theme-layout-drag.md#the-theme-in-a-view-312)): the side as the MCP Apps `theme`, all 76
standard style variables mapped from these tokens, and in the `centralu` extension the signal colour
and the scrollbar tokens. Every switch and custom-theme edit reaches open views
without reloading them, and so does a change of font or line height: `--font-sans`, `--font-mono` and
the line-height variables are read from the same tokens. The text size is not sent as sizes (the root
zoom already scales the frame); `centralu.fontScale` reports it. The signal colour is the standard's warning colour there, so an app that
marks "waiting for you" with it keeps the urgency order. The app template applies all of it and
ships Centralu's scrollbar as a stylesheet; apps are encouraged to use both, never checked.
