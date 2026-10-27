# Design system: the rules the screen is drawn by

What every screen of Centralu follows: colour, shape, lines, type, icons, the top bar's capsules, the
conversation, waiting cards, motion, states and the shared components. Each rule says why it holds and
where it lives in code. The values themselves are tokens in `packages/ui/src/styles/index.css`; how a
theme sets them is [themes.md](themes.md), how a screen is judged is [usability.md](usability.md), and
the words on screen are [ux-writing.md](ux-writing.md) (a draft). Decisions marked *owner, 2026-10-18*
were made on the screen and are recorded in the code comments at the place named.

## 1. Colour

| Rule | Why | In code |
|---|---|---|
| **Brightness says importance.** The inks rank `ink-signal` > `ink` > `ink-muted` > `ink-faint` on every surface; in light themes, contrast ranks them the same way | The chrome is achromatic, so brightness is the only scale left, and one scale read the same way everywhere is learned once. It also reads in grayscale and for colour-blind people | `@theme` in `index.css`; the order is checked for every preset and warned for custom themes (`app/theme.ts` `urgencyBreaks`, [themes.md](themes.md#the-urgency-order)) |
| **White is only for what waits on the person**: an approval, a question, an error to look at. `ink-signal` (pure white in dark, pure black in light) never marks a hover, a selection or decoration | The brightest thing on screen must be the thing that needs you (product-spec FR-12). Every other use of white competes with it | `--color-ink-signal`, `.signal`; no theme setting colours it ([themes.md](themes.md#choosing)) |
| **A white edge says what kind of wait.** Solid white edge = an approval or a question waits. Dashed white edge = an error (or a stop) to look at. An error outranks an approval, so with both the edge is dashed | Shape, not hue, tells the kind, so it survives grayscale. The same pair is used everywhere, so it is read once | Session mark and panel (`.cc-mark`, `.cc-panel` `data-look`), the inbox capsule (`InboxPill.tsx` `edge`), waiting cards (`ApprovalCard.tsx`, `QuestionCard.tsx`) |
| **Dashed without white = it failed, nothing waits.** A failed tool call or a failed background task is dashed in a grey line | A failure that is already over is history, not a call to act | `ChatRow.tsx` (tool card), `BackgroundTasks.tsx` |
| **No other hues.** The only colours are the diff's green and red (inside a diff only), `danger` (what destroys something, or failed to go through), the terminal's ANSI palette, file-kind icons, and Windows' own close-button red under the pointer | Green and red in a diff are near-reflex where an approval is judged; everything else would compete with brightness | `tooling/styles.test.ts` fails on any chromatic hex not listed there with its reason |

Surfaces climb from the floor up: `surface-floor` (the conversation), `surface-side` (sidebar, top
bar), `surface-raised` (what rests on the floor: composer, cards, menus, inputs), `surface-selected`
(a picked option), `surface-hover` (hover and pressed; the person's bubble). Values and the measured
distances between them are in [themes.md](themes.md#choosing).

## 2. Shape: the corner scale

Every corner is a step of this scale. Tailwind's own radii are cleared, so `rounded-<step>` names one of these.

| Token | Value | Takes it | Why |
|---|---|---|---|
| `--radius-sm` (`rounded-sm`) | 3px | checkboxes, inline code | A small mark inside a line of text |
| `--radius-md` (`rounded-md`) | 4px | buttons and controls, keycaps, the tool tile in a tool card, a session's mark | The default for something pressed |
| `--radius-lg` (`rounded-lg`) | 8px | panels, menus, dropdowns, dialogs, tool cards, sidebar tiles | A container, a step rounder than what is in it |
| `--radius-field` (`rounded-field`) | 10px | the top bar's search field, a question's options and its answer box | An input, so not a capsule's full round (*owner, 2026-10-18*, `SearchField.tsx`) |
| `--radius-field-key` (`rounded-field-key`) | 10 − 5 = 5px | the keycap inside a field (the search field's ⌘K) | The field's corner less the gap around the key, so the two curves run parallel |
| `--radius-bubble` (`rounded-bubble`) | 14px | both speakers' bubbles, the pinned message, approval and question cards, the conversation's own cards (a new session's past conversations) | What is said and what waits on the person read as speech, not as boxes (*owner, 2026-10-18*, `ChatStream.tsx`, `ApprovalCard.tsx`) |
| `--radius-full` (`rounded-full`) | full | the top bar's capsules, a card's kind label, dots, the scrollbar thumb | A status, not a container |

- **A shape inside a bordered shape takes the outer corner less the border**, written as a calc on the
  token at its call site (the folded composer: `rounded-b-[calc(var(--radius-lg)-1px)]`).
- **Guard.** Outside `packages/ui/src/components/` and `styles/`, a corner written as a number
  (`rounded-[14px]`, an inline `borderRadius`) fails the lint rule `guard/ui-radius-scale` (`tooling/eslint-guards.js`). Its list of sites that stay
  (`tooling/guard-exceptions.js`) can only shrink: a listed count above what the file holds fails too. A new step goes into `@theme` with what takes it, not at a call site.

## 3. Borders and lines

| Token | When | Why |
|---|---|---|
| `line` | the hairline: a card's or panel's border, dividers, a footer's top rule, meter tracks | Separates without drawing the eye |
| `line-strong` | a border that has to show: a focused or hovered field, checkboxes, graph lanes, an idle session mark, **every cell of a table in an answer (1px)** | The answer sits in a bubble on `surface-raised` with a `line` border, so hairline cells faded into the bubble (*owner, 2026-10-18*, `.cc-md th, td`; 2px was tried and reverted) |
| `line-side` | lines inside the sidebar (between projects, row borders) | Derived from `line` and `ink-faint`, so it stands apart on the sidebar's own ground in every theme (`:root` in `index.css`) |

Borders are 1px. A session mark that says something is 2px (`.cc-mark`), because at 17px a 1px change
of ink is too small to read. A table header takes half a hover step (`surface-hover` 50%), so it reads as
a header on the bubble and off it.

## 4. Type

| Rule | Why | In code |
|---|---|---|
| **Pretendard** for what a person or a model says, and for controls, titles and a session's mark letter (the usage donut's letter too) | A letter in the code face sat off centre in its chip; the mark is a name, not a readout (*owner, 2026-10-18*, `.cc-chip-letter`) | `--font-sans`, bundled (#731) |
| **D2Coding** for what a machine wrote: code, paths, commands, logs, terminals, and **numbers that must line up**: counts in capsules and folded projects, readouts, sizes, durations | Tabular digits keep a count from shifting as it changes; Hangul is twice the Latin width, so Korean in code stays on the grid | `--font-mono`, `.readout` (adds `tabular-nums`) |
| **Five sizes**: `text-2xs` 10px (labels, counts, times), `text-xs` 11px (what a machine wrote), `text-sm` 12px (controls), `text-md` 13px (what a person reads), `text-display` 19px (the first-run heading). Weights 400, 500, 600 | A dense band that reads at the default zoom; the whole screen scales by the root zoom, not by these | `@theme`; the lint rule `guard/ui-type-scale` fails on an arbitrary size ([themes.md](themes.md#text-size-fonts-and-line-height)) |

## 5. Icons

| Rule | Why | In code |
|---|---|---|
| **SVG drawn in `currentColor`, no emoji** | Emoji differ per OS and carry hue; an SVG follows the ink of its state (hover, disabled) | `components/icons.tsx` |
| **20px in the top bar**: the settings gear, the inbox envelope, and the usage donuts (a 20px ring in a 24px box, so its hover circle fits around it) | One size along the bar, so its controls read as a set (*owner, 2026-10-18*, `App.tsx`, `InboxPill.tsx`) | `GearIcon`, `MailIcon` with `size={20}`; `UsageDonuts.tsx` (`R = 9`, stroke 2.5) |
| **14px in rows**: a row's menu (`DotsIcon`), the sidebar's fold chevron, background work | The height of a row's text | `DISCLOSURE_ICON` (`sidebar/layout.ts`) |
| **One chevron for expand, everywhere**: `ChevronIcon`, pointing right when closed and turned 90° when open. Back and forward use the same chevron (`StepIcon`) | One shape means "there is more here"; the rotation also says "this just opened". A font triangle (▸▾) cannot be sized or aligned and outweighs the text | `ChevronIcon` in `icons.tsx` |
| **An icon with no words is an `IconButton`**: its name is its tooltip and its accessible name, one string | A tooltip that some icon buttons have and others do not is what happened before | `components/IconButton.tsx` |

## 6. Capsules in the top bar

A capsule is `rounded-full`, 1px border, on a translucent `surface-hover` fill; the shared look is `Pill`
(#1122).

| Rule | Why | In code |
|---|---|---|
| **An icon and a count; the words are in a tooltip** | The bar holds several states at once; a sentence for each would not fit and would be read every time | `InboxPill.tsx`, `BackgroundTasks.tsx`, `UpdateLine.tsx` (says only "Update"; version and effect in the tooltip) |
| **The inbox capsule** counts every session waiting on the person. Its edge is the white-edge rule: solid for an approval or question, dashed for an error, hairline otherwise; its ink is the signal only while an approval or error waits | It replaced the "Waiting for input" readout and the notice cards that covered the conversation (*owner, 2026-10-18*) | `InboxPill.tsx` |
| **The peek**: something new that happened off screen is written out inside the capsule for **4 s** (`PEEK_MS`), then folds back into the count. Only while the window is in front; what arrived while away is written out on return, newest first with "· N more" | News without covering the page. A finished turn on screen counts as seen when the line folds | `InboxPill.tsx` `useNoticePeek`, `Notices.tsx` |
| **The background work capsule**: hairline edge, a steady (not blinking) dot while work runs; quiet once it ended; dashed when a task failed | A brighter edge stood out too much (*owner, twice*); a lit dot says it runs without motion | `BackgroundTasks.tsx` |
| **Usage capsules**: one donut per tool. A linked machine's donuts sit in a capsule drawn by its **outline only**. The hover is a **full `surface-hover` step**, a circle **evenly inset** (2px on every side) | A filled capsule left the hover nothing to stand out from; the circle the hand lights must be the shape of the button (*owner, 2026-10-18*). A machine with no usable tool is left out, not drawn as "Offline" | `UsageDonuts.tsx` |

## 7. The conversation

| Rule | Why | In code |
|---|---|---|
| **The person's bubble on the right** (`surface-hover`, at most 75% wide); **the agent's text in a full-width bubble on the left** (`surface-raised`, `line` border). Both `rounded-bubble`, **no tail** | Side, width and shade already say who spoke; the tail corner was dropped (*owner, 2026-10-18*). A message from another session or an app is dashed | `ChatRow.tsx`, `ChatStream.tsx` `AnswerBubble` |
| **Only what the agent said goes in the bubble.** Tool calls, reasoning summaries, images, approvals and markers (compaction, handoff, an error line) stand **outside**, on the page, and split it | A card in the bubble read as a box in a box; reasoning in it read as a message | `ChatStream.tsx` `inBubble` |
| **Times** under the person's bubble and under the **last** bubble of an answer, as clock time in English: "3:42 PM", `text-2xs` `ink-faint` | Chat apps write it so; the day is said once by a divider | `format.ts` `formatSaidAt`, `ChatRow.tsx` `SaidAt` |
| **Day dividers** where a day begins: "Saturday, October 18, 2026" between two hairlines | So no time has to carry a date | `ChatStream.tsx` `DayDivider`, `formatDayLong` |
| **A tool card is one title row until opened**: the tool on a quiet tile, its input in the code face. The output, and the whole input when it says more than the title, show **only once the card is open** | The preview lines were rarely read and made every call a block (*owner, 2026-10-18*) | `ChatRow.tsx` `ToolCard` |
| **A Centralu call reads as what happened**: a sentence, a rounder tint, a stronger hairline, the session it reached as a chip; never the signal | It should stand out from other tool calls without competing with what waits | `ChatRow.tsx`, `CentraluCall.tsx`, `CentraluCallBody.tsx` |
| **The scrollbar is drawn over the content** (overlay), as a thin pill | The native bar took a column of its own, one padding too many beside the bubble | `components/OverlayScrollbar.tsx`, `.cc-scroll-overlay` |
| **The pinned message** (the person's question, held at the top while its answer scrolls) has the bubble's shape | It is the same message, so it keeps its shape | `StickyUser.tsx` |

## 8. Waiting cards: approval and question

Every card that waits on the person is drawn alike (*owner, 2026-10-18*, `ApprovalCard.tsx`, `QuestionCard.tsx`):

- `rounded-bubble`, on `surface-raised`, with a **white edge** all round (`ink-signal` at full strength: an
  edge that waits on the person is never a fraction of the signal, *owner, 2026-10-18*).
- **The kind as a capsule** at the top left (`Pill size="label" edge="solid"`), in the signal ink: "Awaiting approval", "Agent is asking";
  a quiet line beside it says what is blocked.
- The body: the command or question. A question's options are `rounded-field` and lit by a white edge
  when picked.
- **A plain footer** below a hairline: the answers as buttons with their keys (Allow, Deny, Always allow).

## 9. Motion

| Rule | Why | In code |
|---|---|---|
| **A layer comes from where it opens and leaves the same way**: `cc-drop` (160ms, from above: the top bar's dropdowns, the palette) and `cc-drop-out` (140ms); `cc-hang` / `cc-hang-out` from below (a menu that opens upward); `cc-fade` / `cc-fade-out` (160/150ms) for the scrim under it | Something that appears from nowhere reads as floating; leaving the way it came shows where it went | `index.css` keyframes |
| **Presence: an exit is decided during render**, not in an effect. `usePresence(open)` keeps the layer for `LEAVE_MS` (150ms) after it closes, with `leaving` for the exit class and to stop it taking presses | An effect runs after the frame that closed the layer, so the layer blinked off and back for its exit (*owner, 2026-10-18*, the palette) | `components/presence.ts` |
| **Every change on screen is animated** (the rule for new and changed UI; the sidebar's folds are the first to follow it, #1605): a fold or unfold, something appearing or leaving, a switch of view, rows added or removed. About 150–200ms, in line with the layers above (`cc-drop` 160ms, `LEAVE_MS` 150ms). It never delays or blocks input: a row under the pointer is pressable while the list moves, and nothing that reacts to the pointer waits for the motion. What leaves stays in the DOM until its exit ends, so nothing blinks. A list folds as a transition of its grid track, not a keyframe, so one reversed half way goes on from where it is | A change that lands in one frame has to be re-read to see what moved (*owner, 2026-10-26*, #1605). This is the rule for a change that happens once; "Only what is alive moves" below is about motion that keeps going as a signal, and the two do not conflict | `Fold` (`components/Fold.tsx`, `.cc-fold`: a project's rows, the orchestrator's children; 180ms open, 140ms close), `usePresence` |
| **Only what is alive moves**: `breathe` for work in progress, `cc-spin` (1.4s) for a button that is working, the gust once when a response finishes | Motion is a signal too, so it is spent only on "this is happening" | `.breathe`, `.cc-spin`, `.cc-gust` |
| **Reduced motion**: every animation is turned off or becomes a short change of brightness (spin becomes breathe; the gust becomes a still flash); a layer still appears and leaves, without travel, and a fold keeps its height and only fades (`.cc-fold`, 100ms) | The information stays, the movement goes | `@media (prefers-reduced-motion: reduce)` blocks in `index.css` |

## 10. States

| State | Look | Why |
|---|---|---|
| Hover | a translucent `surface-hover` (`/60` on capsules and icon buttons), the ink one step up (`ink-faint` to `ink`); a full step where the ground is already a fill (usage donuts) | Shows what the pointer will press without spending white |
| Pressed, open | `surface-hover`, held while the thing it opened is open (`aria-expanded`) | So the button and its dropdown read as one |
| Selected | `surface-selected` and the `ink`; a picked option in a waiting card adds the white edge, since there it is the answer being given | Selection is position, not urgency |
| Disabled | `opacity-50`, no hover | One fade everywhere (*owner, 2026-10-18*); the shared components hold it (`Button`, `Segmented`, `IconButton`, `InlineConfirm`) |
| Focus | `:focus-visible`: a 1px outline in `--color-focus`, 1px off; a theme file may set it | Keyboard focus must always show, and must never look like the signal |
| Asleep | **not shown at all**: no dimmed row, nothing in the mark or its tooltip, no line under the conversation. Only waking is said ("Waking session…"), and a wake that failed (its reason and Retry) | Sleep needs nothing from the person: typing to the session wakes it. A state that asks nothing is not announced (*owner, 2026-10-18*, `SessionNotes.tsx` `DormantNote`, `sidebar/marks/ToolMark.tsx`; [ux-writing.md](ux-writing.md) 1.1) |

## 11. Components

Screens are drawn with the shared components in `packages/ui/src/components/`, not with copied class
strings: a copy drifts (padding, hover, disabled fade) and the next screen copies the drift.

| Need | Use |
|---|---|
| An icon with no words | `IconButton` (its label is the tooltip and the accessible name) |
| A tooltip, a key hint | `Tooltip`, `Kbd` (`primitives.tsx`; key names come from the platform port, never ⌘ written out) |
| A session's state as a dot | `StateDot` (`primitives.tsx`) |
| A dialog | `Modal` (counts itself as an open layer, so global keys know), with `useDialogFocus` / `useFocusReturn` |
| A layer's enter and exit | `usePresence` (`presence.ts`) with the `cc-drop` / `cc-fade` classes |
| Something placed under its anchor | `useAnchoredPlacement` (`anchored.ts`), closed by `useDismiss` |
| "Are you sure?" in place | `InlineConfirm` (Cancel first, then the action, disabled while busy) |
| A list that failed to load | `LoadFailed` (what could not be read, why, Retry), never an empty list |
| Still loading | `SkeletonLines`, `ChatSkeleton` (invisible for 150ms, then fade in) |
| A scroller with its bar over the content | `OverlayScrollbar` |
| Time since | `RelativeAge` |
| A shell's banner line | `ShellBanner` |
| The window's drag handle | `DragRegion` |
| A resizable lane | `ResizeHandle` |
| A grid span picker | `SpanButton` (`SpanPicker.tsx`) |
| A command's log, a terminal | `CommandLogView`, `xterm.ts` with `terminalTheme.ts` |
| Icons | `icons.tsx` |
| A framed text button | `Button`: `primary` (the action a dialog is for), `secondary`, `quiet` (grey until hovered), `subtle` (faint, inside the conversation), `danger`, `ghost` (no frame); `xs` / `sm` / `md`; `busy` with `busyText` |
| One of several, shown at once | `Segmented` (a radio group: one Tab stop, the arrow keys pick) |
| A setting that is on or off | `Switch` (a checkbox underneath, drawn as a track and knob); in Settings through `SettingToggle`, laid out with `SettingsLayout.tsx` (page, group card, row) |
| A capsule | `Pill`: `size="bar"` (the top bar's 28px) or `"label"` (a waiting card's kind); edges `quiet`, `live`, `solid`, `dashed` |
| A small uppercase label | `Badge` (`readout` among figures) |
| A framed text field | `TextInput`, or `TextField` with its label, hint and problem |

**The guard.** The lint rule `guard/hand-made-looks` fails when a screen outside `components/` draws a
framed button, a framed text field, a small caps label or a capsule by hand, naming the component to use
(the patterns are in `tooling/eslint-guards-ts.js`). Its list of sites not moved yet
(`tooling/guard-exceptions.js`) **can only shrink**,
as the corner guard's does.

## Settled departures

Places where the screen did not follow a rule above, settled by the owner on 2026-10-18:

- The background work capsule's running dot was `bg-white`; it is `ink-signal` now, so a theme reaches it.
- The white edges used three inks; every edge that waits on the person is `ink-signal` at full strength now
  (inbox capsule, waiting cards, session marks).
- The disabled fade was 40%, 50% or 60%; it is 50% everywhere. #1122's `Button` follows it.

## Changing this

A new look starts as a token or a component, with its reason in the comment beside it, and this
document changes in the same pull request. A rule here that the screen no longer follows is a bug in
one of the two.
