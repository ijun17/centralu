# A view's theme, narrow layout and dragging out

## The theme in a view (#312)

A view gets the theme the person chose in Settings (light or dark, a preset or a custom theme;
[themes.md](../themes.md)), so an app can look like Centralu without knowing which theme is on.

- **`theme`** is `light` or `dark`: the side of the theme that shows.
- **`styles.variables`** carries all 76 MCP Apps style variables, mapped from Centralu's tokens
  (`packages/ui/src/features/app-frame/hostStyles.ts` is the table): the colour roles (background,
  text and border for primary, secondary, tertiary, inverse, ghost, info, danger, success, warning
  and disabled, and the focus rings), the two fonts, weights, text and heading sizes with their line
  heights, radii, the border width and shadows. Centralu has no hue in its chrome, so the roles the standard
  gives a hue land on the inks: info is plain text, and **warning is the signal colour**, what is
  waiting for the person (pure white in dark, pure black in light). Danger is Centralu's danger red,
  success the diff's green. The two fonts and the text line heights follow the body font, code font
  and line height in Settings → Appearance ([themes.md](../themes.md)), and a change is sent like a theme
  switch. Sizes are not multiplied by the text size setting, since the root zoom
  already scales the frame; where Centralu has no step of its own (a large heading, bold), the value
  is written out.
- **`centralu.variables`** carries Centralu's own, which the standard has no name for:
  `--centralu-signal` (the signal colour again, under its own name) and the scrollbar,
  `--centralu-scrollbar-thumb`, `-thumb-hover`, `-track`, `-size`, `-inset` and `-radius`.
- **Read where the view sits.** The values come from the tokens as they compute on the view's slot,
  so a view in the conversation gets the conversation's surfaces and a pinned view the floor's.
  Every preset puts the conversation on the floor's own steps ([themes.md](../themes.md)), so an app
  panel on the grid gets the same background roles as the session panels beside it (primary =
  the floor, secondary = raised, tertiary = the hover step); a custom theme that sets
  `surface-reading` apart is the one case where the two differ.
- **Switches reach open views.** A theme switch and an edit to a custom theme send
  `host-context-changed` to every open view, without reloading it. Like every change notification
  it carries only the fields that changed, so an app reads the whole context the bridge keeps
  (`app.getHostContext()`), not the notification's.
- **The color scheme.** The view's frame, the proxy page and the app's page must declare the same
  scheme: Chromium and WebKit paint an opaque backdrop behind a frame whose document declares a
  different one (white for a document that declares none, which is right for an app with dark
  default text). AppFrame sets the frame's scheme to the theme's side and puts it in the proxy
  address's fragment (`#color-scheme=light`), the proxy page takes it from there before the first
  paint and from every host context it passes on afterwards, and the template's page sets its own
  from `theme`, as ext-apps' `applyDocumentTheme` does. With matching schemes a view is
  transparent on Centralu's background, light or dark. WKWebView keeps subframes transparent
  either way; there the scheme still decides how form controls draw.

**What the template does, and what an app should do** (recommended, never checked; owner
decision 7): the template's page applies everything it receives on `<html>` (the colour scheme, the
standard variables and Centralu's own), on connect and on every change. Its styles read only the
variables, type and shape as well as colour (sizes, line heights, fonts, weights, radii, the border
width), through one `:root` block at the top that names each with Centralu's dark value as its
fallback, for the moment before the host context arrives; nothing below that block has a colour or
size of its own. Spacing has no variable in the standard and stays literal. It also ships **Centralu's scrollbar**: a small
stylesheet that draws `::-webkit-scrollbar` from the `--centralu-scrollbar-*` variables the way
Centralu draws its own, with `scrollbar-color` and `scrollbar-width` only where `::-webkit-scrollbar`
does not exist (where it does, Chromium lets `scrollbar-color` switch it off). The project-board app
uses the same pieces, and reads its type and shape from the theme the same way, so the font, line
height and text size in Settings → Appearance reshape it as they reshape Centralu. An app built for
another host that applies the standard variables gets Centralu's colours too, and draws its own
scrollbars.

## Narrow first (#306)

A view is often narrow: a grid or project-screen panel is one cell, about 360–480px wide on a laptop
screen, and the inline view under a tool card is the conversation's width. Centralu does not enlarge
a panel on focus (#306 left that for later). A grid panel can span more cells, but the person decides
that; an app can only recommend a size (`view.span`, [views.md](views.md#pinned-in-the-main-area-centralus-way-within-the-standard)), and the window may still give it one cell.
So **an app is built to work at a panel's width first and to spread out when there is room.**
Recommended, never checked:

- Nothing has a fixed width wider than about 320px; rows of controls wrap (`flex-wrap`) instead of
  overflowing, and long text wraps (`overflow-wrap: anywhere`).
- Below about 520px, a layout of side-by-side parts becomes one column that scrolls as a page
  (a media query in the view's own document measures the frame, so it is the panel's width).
- What waits on the person stays first in the narrow order.
- Check it at 360px as well as full width.

The template's page follows this (its buttons wrap, its margin shrinks on a narrow frame), and the
project-board app is the worked example: its status columns sit side by side when there is room and
stack under 520px, with the decision column first, so every card reads in full in a grid panel.
Stacked, the board is one long page, so a row of tabs above it, one per status with its count,
jumps to that section, and the tab of the section in view is marked as the board scrolls (a tab
just clicked keeps the mark until the person scrolls, so a short last section still reads as the one
chosen). The tabs are buttons with an explicit `tabindex`, since WebKit's Tab skips buttons unless
the system's keyboard navigation is on (`e2e/fixtures/app-theme.ts` checks all of it at about 380px).

## Dragging an item out of a view (#308)

An item in a view (a board card, a row) can be dragged onto a session, and goes into its message as
a link the agent reads and can open.

**The contract for an app** is two standard drag types, set in the item's `dragstart`:
`text/uri-list` (the item's address) and `text/plain` (one line naming it, such as
`#306 App panels too narrow`). Nothing Centralu-specific; the template's `AGENTS.md` says so, and
the project-board app's cards carry both (with its own `text/x-item` for moves between columns).

**What lands.** Dropped anywhere on a session's pane, the link goes into its composer **at the
caret**, in place of a selection, as a Markdown link: `[#306 App panels too narrow](https://…/306)`.
The title is `text/plain` when it is one line and differs from the address, otherwise the address.
Only `http(s)` and `mailto` addresses become links; text with no address goes in as it is. A space
keeps it off neighbouring words, and the caret ends after it. The same rule takes a link or text
dropped on the composer itself (a link dragged from a browser, a selection from the conversation),
and a link from outside the window anywhere on the pane. A drag carrying a session, panel, project
or path type is still the grid's or the tree's (#286), and an OS file is still an attachment even
when it carries its `file:` address as a uri-list.

**Why the drag's own data is not enough.** A drag that starts in a document of one origin is not
delivered to a document of another origin in the same page. Measured on 2026-10-05 in Playwright
1.62.1's Chromium and WebKit: a card setting both types in a frame, dragged onto a textarea in the
page, reached it from a same-origin `srcdoc` frame; from a frame on another host, on the same host
and another port, and from a sandboxed (opaque) `srcdoc` frame, the page heard **nothing**, not
even `dragenter`. Only the frame's `dragend` fired. Both engines carry the same rule (WebKit's
`SecurityOrigin::canReceiveDragData`, kept by Blink), and a view is always another origin ([views.md](views.md#how-a-view-is-hosted)).
So the page never sees the drag, and the DragShield ([views.md](views.md#pinned-in-the-main-area-centralus-way-within-the-standard)) never goes up for it.

**The route instead.** The host adds a small relay to every view's document, before its last
`</body>` (`views/drag-relay.ts`; the view's CSP already allows inline script). In the view's own
window it reads the two types at `dragstart`, after the item's handler, and posts them through the
view's bridge as `centralu/notifications/drag` (`{ phase: "start", uri, text }`); at that drag's
`dragend` it posts where the drag ended in the view's coordinates, with the view's size (`{ phase:
"end", x, y, width, height }`). The proxy passes both on unchanged. The UI (`app-frame/dragRelay.ts`)
turns the end into a point in the page and dispatches `cc-app-link-drop` on the element there; a
session pane takes it. Added by the host rather than the app runtime, it reaches every app, older
runtimes and apps built for other hosts included, and the contract stays the standard one.

| Decision | Why |
|---|---|
| The end point, not a drop event | The page gets no drop. The `dragend` in the view is the only place that knows where the hand let go |
| The point's coordinates depend on the engine | Measured with a frame 50 px right and 30 px down, a drop at (80, 440): WebKit's `dragend` said (30, 410), the frame's own coordinates as the spec has it; Chromium's said (80, 440), the page's, in every frame tried, while its `mousedown` and `dragstart` were in the frame's. The UI tells Chromium (WebView2 on Windows) by `navigator.userAgentData`, an API only Chromium has; the user agent string names both engines in each |
| Scaled by the frame's box over the view's size | The text size setting zooms the root; the frame's content box against the view's reported `innerWidth`/`innerHeight` maps the point whatever the zoom |
| An end inside the source frame, or over another frame, is ignored | Inside, it is the app's own drop (a card moved between columns); over a frame, it landed on a view, not on the page |
| The messages are the app's words | Shape-checked; an end counts only after a start from the same view and within 2 minutes, and only while that frame holds the page's focus (pressing on an item gives its frame focus: in both engines `document.activeElement` was the frame after the drag). A view that just posts the two messages puts nothing in (e2e). The link only goes into a draft the person sees and sends themselves |

**When the session cannot reach the app.** The link goes in either way, and the composer asks the
host whether this session can use the app's tools (`apps.reach`). If not, a quiet line under the
composer names the app, why, and what fixes it; it goes on send, on dismiss, on the next drop, or
when the composer shows another session. The host answers from decision 4 ([attaching.md](attaching.md#which-session-gets-which-apps-decision-4)) and then from the
live agent:

| `reason` | When | The line says |
|---|---|---|
| `other-project` | Another project's app, a user-folder app outside the Assistant, or a session an app stood up | Ask in a session of that project (or: only the Assistant can use your apps) |
| `untrusted` | The app's project, which is this session's or that of an app it attached, is not trusted | Trust the project |
| `app-unusable` | The app is `invalid`, `unconfirmed` or `failed` (`status`) | Fix the manifest, turn it on, or restart it |
| `restart` | A Codex thread started before the app was attached: Codex keeps the servers a thread started with ([attaching.md](attaching.md#claude-and-codex)). The adapter answers from the servers it configured (`appAttachment`) | Restart the session |
| `bridge-failed` | Codex reported the app's bridge failed to start (`mcpServer/startupStatus/updated`), until it reports it ready | Restart the session |
| `unavailable` | No app runtime, or the app is gone | That the app is not available |

A session that is not running answers from decision 4 alone: it attaches what the rule gives it when
it wakes, and a Codex resume carries the current servers. Claude follows the attached set live
through in-process proxies, so its sessions never answer `restart`. A host from before this answers
nothing, and the line stays off.
