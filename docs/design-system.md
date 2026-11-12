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
| **Brightness says importance.** The inks rank `ink-signal` > `ink` > `ink-muted` > `ink-faint` on every surface; in light themes, contrast ranks them the same way | The chrome has no hue of its own (Dark's greys lean faintly warm, Light's are neutral), so brightness is the only scale left, and one scale read the same way everywhere is learned once. It also reads in grayscale and for colour-blind people | `@theme` in `index.css`; the order is checked for every preset and warned for custom themes (`app/theme.ts` `urgencyBreaks`, [themes.md](themes.md#the-urgency-order)) |
| **White is only for what waits on the person**: an approval, a question, an error to look at. `ink-signal` (pure white in dark, pure black in light) never marks a hover, a selection or decoration | The brightest thing on screen must be the thing that needs you (product-spec FR-12). Every other use of white competes with it | `--color-ink-signal`, `.signal`; no theme setting colours it ([themes.md](themes.md#choosing)) |
| **A white edge says what kind of wait.** Solid white edge = an approval or a question waits. Dashed white edge = an error (or a stop) to look at. An error outranks an approval, so with both the edge is dashed | Shape, not hue, tells the kind, so it survives grayscale. The same pair is used everywhere, so it is read once | Session mark and panel (`.cc-mark`, `.cc-panel` `data-look`), the inbox capsule (`InboxPill.tsx` `edge`), waiting cards (`ApprovalCard.tsx`, `QuestionCard.tsx`) |
| **An approval has its own fill on the session mark.** A mark waiting on an approval takes `mark-waiting` as its fill, one value per preset (Dark `#a8a39f`, Light its inverse `#5b5b5b`; the high-contrast presets take a fill the letter stays readable on), and its letter is `ink-signal`, the same ink as its edge. A mark that waits on a question while its session works keeps the grey fill. The row under it carries no line about the approval; the waiting list has it (*owner, 2026-11-02*, #1740; the owner chose the letter's contrast, 2.5:1 in Dark and 2.8:1 in Light, over a darker letter) | An approval is the wait that needs an answer, so it is the one mark that differs by fill as well as by edge, and the fill is a token so a theme can pick its own | Session mark (`.cc-mark[data-state='waiting_approval']`), `ToolMark.tsx` |
| **Background work is a faint dot on the session mark, not a chip.** A sidebar row whose session has a background task running puts a 5px dot in `ink-faint` on the mark's bottom-right corner, ringed 1.5px in the sidebar's own colour; no count and no motion beyond a short fade. The count and what runs are in the mark's tooltip and label | Brightness is the urgency signal and the mark's ring states the turn, so the dot is no brighter than `ink-faint`; a dot takes no width where a chip took a third of the row | `ToolMark.tsx` (`background`), `backgroundNote` in `BackgroundTasks.tsx` |
| **Dashed without white = it failed, nothing waits.** A failed tool call or a failed background task is dashed in a grey line | A failure that is already over is history, not a call to act | `ChatRow.tsx` (tool card), `BackgroundTasks.tsx` |
| **No other hues.** Dark's greys lean faintly warm, which adds no hue of its own. The only colours are the diff's green and red (inside a diff only), `danger` (what destroys something, or failed to go through), the terminal's ANSI palette, file-kind icons, and Windows' own close-button red under the pointer | Green and red in a diff are near-reflex where an approval is judged; everything else would compete with brightness | `tooling/styles.test.ts` fails on any chromatic hex not listed there with its reason |

Surfaces climb from the floor up: `surface-floor` (the conversation), `surface-side` (sidebar, top
bar; in Dark the same value as the floor, so the edge line alone parts them), `surface-raised` (what rests on the floor: composer, cards, menus, inputs), `surface-selected`
(a picked option), `surface-hover` (hover and pressed; the person's bubble). Values and the measured
distances between them are in [themes.md](themes.md#choosing).

## 2. Shape: the corner scale

Every corner is a step of this scale. Tailwind's own radii are cleared, so `rounded-<step>` names one of these.

| Token | Value | Takes it | Why |
|---|---|---|---|
| `--radius-sm` (`rounded-sm`) | 3px | checkboxes, inline code | A small mark inside a line of text |
| `--radius-md` (`rounded-md`) | 4px | buttons and controls, keycaps, the tool tile in a tool card, a session's mark | The default for something pressed |
| `--radius-lg` (`rounded-lg`) | 8px | panels, menus, dropdowns, dialogs, tool cards, sidebar tiles | A container, a step rounder than what is in it |
| `--radius-field` (`rounded-field`) | 10px | the sidebar's search field, a question's options and its answer box | An input, so not a capsule's full round (*owner, 2026-10-18*, `SearchField.tsx`) |
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
| `line-chrome` | the window chrome's border, one colour a theme sets: the sidebar's lines and edge, the top bar's and the shell banner's bottom line (`border-line-chrome`), the session panel's header and dividers, the evidence panel's edge and header, the overlay header | A step over `line` on the sidebar's ground. A panel's own frame is `line-panel` (the row below), and cards and dialogs keep `line` (*owner, 2026-11-12*, #2207; [themes.md](themes.md#the-lines)). A theme file without it gets its own `line` |
| `line-panel`, `line-answering`, `line-bubble-mine` | the conversation's frames that are not the hairline: a resting panel's edge, the answering panel's ring, the person's bubble (the agent's bubble and a tool call's card draw `line`) | Each a colour the theme sets, so a custom light theme's frames are not grey (*owner, 2026-11-12*; [themes.md](themes.md#the-lines)). A theme file without one follows `line-strong`, `ink-muted` and `line-strong`. A border, ring or divider is never a token at a part of its opacity (`styles.test.ts`): a danger notice's edge is `danger`, a danger button's `line-strong` and `danger` under the pointer |

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
| **The inbox capsule** counts every session waiting on the person. Its edge is the white-edge rule: solid for an approval card or a mail question waiting on the person's answer (`mailAsksYou`, a selector over the host's thread list, #2227), dashed for an error, hairline otherwise. The edge is `ink-signal`, the strongest ink of each theme (white in the dark presets, near black in the light ones, a custom theme's own), so its role is the same on every theme; the error wins when both apply, since the dash is the one shape that tells a failure from a wait; its ink is the signal only while an approval or error waits | It replaced the "Waiting for input" readout and the notice cards that covered the conversation (*owner, 2026-10-18*) | `InboxPill.tsx` |
| **The peek**: something new that happened off screen is written out inside the capsule for **4 s** (`PEEK_MS`), then folds back into the count. Only while the window is in front; what arrived while away is written out on return, newest first with "· N more" | News without covering the page. A finished turn on screen counts as seen when the line folds | `InboxPill.tsx` `useNoticePeek`, `Notices.tsx` |
| **The background work capsule** in a session's header: hairline edge, the count, drawn only while work runs; it fades out (`.cc-fade-out`) when the last task ends, and the ended ones it listed go with it (*owner, 2026-11-12*, #2213) | A brighter edge stood out too much (*owner, twice*); the badge answers "is something running back there", so it goes with the work | `BackgroundTasks.tsx` |
| **Usage capsules**: one donut per tool, **2px apart** whether they stand alone (this computer) or in a capsule (*owner, 2026-11-02*). A linked machine's donuts sit in a capsule drawn by its **outline only**. The hover is a **full `surface-hover` step**, a circle **evenly inset** (2px on every side) | A filled capsule left the hover nothing to stand out from; the circle the hand lights must be the shape of the button (*owner, 2026-10-18*). A machine that is not connected is left out, not drawn as "Offline"; a connected one stays, as its name alone when no tool is installed there (*owner, 2026-10-27*). A tool installed but signed out has a donut too: a dashed ring and letter in `ink-signal` (#1823), never `danger` (it waits on the person, it did not fail). Every tool's panel is headed by the agent's name, not "Usage" (*owner, 2026-10-28*) | `UsageDonuts.tsx` |

## 7. The conversation

| Rule | Why | In code |
|---|---|---|
| **The person's bubble on the right** (`surface-hover`, at most 75% wide); **the agent's text in a full-width bubble on the left** (`surface-raised`, `line` border). Both `rounded-bubble`, **no tail** | Side, width and shade already say who spoke; the tail corner was dropped (*owner, 2026-10-18*). A message from another session, an app or a script is drawn as the agent's bubble is (`surface-raised`, solid `line` edge) under a source line, not on the person's `surface-hover` (never dashed: dashes mean failed or unknown, #1629) | `ChatRow.tsx`, `bubbleLook.ts`, `ChatStream.tsx` `AnswerBubble` |
| **Only what the agent said goes in the bubble.** Tool calls (folded into a line, next row), reasoning summaries, images, approvals and markers (compaction, handoff, an error line) stand **outside**, on the page, and split it | A card in the bubble read as a box in a box; reasoning in it read as a message | `ChatStream.tsx` `inBubble` |
| **Times** under the person's bubble and under the **last** bubble of an answer, as clock time in English: "3:42 PM", `text-2xs` `ink-faint` | Chat apps write it so; the day is said once by a divider | `format.ts` `formatSaidAt`, `ChatRow.tsx` `SaidAt` |
| **Day dividers** where a day begins: "Saturday, October 18, 2026" between two hairlines | So no time has to carry a date | `ChatStream.tsx` `DayDivider`, `formatDayLong` |
| **A run of thinking and tool calls between two bubbles is one line** (*owner, 2026-11-06*, #2007): the reasoning rows and tool calls between two answer bubbles, or between the person's message and a bubble, fold into one `ink-faint` line, a chevron and what it holds ("1 thought · 12 tools · 4m 10s", the time from five seconds), pressed to open it in place and pressed again to fold it. While the turn is live the line also says the step it is on ("Bash: run2.sh before …"), and a call that failed leaves "N failed" on it. A run opens by the person's press **or** by a search hit inside it, and stays as left when the list detaches its rows and when the session is left. A run that a never-folded row cuts while the turn is live (an approval answered, a marker) leaves the rows after it in a new run, which starts folded and says its step on its line. **Never folded, and each splits a run**: a decided approval, a question or anything else waiting on the person (a worktree proposal), every marker (an error line, a usage limit, a stop or restart cut, compaction, handoff), an app's view shown inline (the call that opened it) and an image the agent shows. Opening fades the rows in (`cc-fade`) and closing fades them out (`cc-fade-out`); with reduced motion the rows appear and leave at once, with no fade; the press never waits for either. Between two answer bubbles the line stands **8px** from each (*owner, 2026-11-07*, half of the 16px it had): the row before it and its own row take 4px of bottom padding, not the 12px two bubbles stand apart by, and its press area keeps the words and 4px each side. After the person's message the 24px under it stays | Between two answers the agent's tool calls and thinking were most of the page, and the answers were the part the person came for; one line says what was done, how long it took and whether anything failed, and the card is one press away. What waits on the person or says something went wrong must never be a press away | `ChatStream.tsx`, `chat-stream/foldRuns.ts`, `chat-stream/FoldLine.tsx`, store `foldOpen` |
| **A tool card is one title row until opened**: the tool on a quiet tile, its input in the code face. The output, and the whole input when it says more than the title, show **only once the card is open** | The preview lines were rarely read and made every call a block (*owner, 2026-10-18*) | `ChatRow.tsx` `ToolCard` |
| **A Centralu call reads as what happened**: a sentence, a rounder tint, a stronger hairline, the session it reached as a chip; never the signal | It should stand out from other tool calls without competing with what waits | `ChatRow.tsx`, `CentraluCall.tsx`, `CentraluCallBody.tsx` |
| **The scrollbar is drawn over the content** (overlay), as a thin pill | The native bar took a column of its own, one padding too many beside the bubble | `components/OverlayScrollbar.tsx`, `.cc-scroll-overlay` |
| **The pinned message** (the person's question, held at the top while its answer scrolls) has the bubble's shape | It is the same message, so it keeps its shape | `StickyUser.tsx` |
| **In a short grid or project panel the composer folds and goes wholly below the panel's bottom edge**: nothing of the card shows at rest, shadow included. A panel folds it below about 570px and opens it again above about 620px (*owner, 2026-11-07*: twice the 285px/312px of 2026-10-20, and no resting sliver, which #2018 had made 32px by reading "the minimum height at which it folds" as the sliver). A hand in the bottom 54px raises it with a slide (300ms; none under reduced motion) and it slides back down when the hand leaves; **a pane that opens its composer (it grew, or a note holds it open, below) slides the card up from below the edge into its place** (300ms, `.cc-composer-rise`, the pane clips while it does; none under reduced motion); the space under the conversation is the card's full height always, so nothing moves when it rises | A short panel has little room to read in, and the composer's own 95px takes a third of a 285px one and a sixth of a 570px one. With nothing showing, the strip is the only way to the card, so it stays larger than anything the card ever showed | `SessionView.tsx` (`FOLD_SHARE`, `RISE_MS`), `foldedComposer.ts`, `.cc-composer-rise` |
| **A panel does not fold its composer while a note with a button shows above it**: Done after an error, Continue after an interruption, Retry (and Continue in a fork) on a session that could not wake (*owner, 2026-11-07*). The pane behaves as an open one for as long as the note shows, and folds again, by the same motion as any other fold, when the note goes. The away note has no button, so it does not count. The space reserved under a hidden card is kept as it is | The raised card covers the bottom of the pane, which is where those notes sit, so it would cover the very button a hand came to press | `SessionView.tsx`, `SessionNotes.tsx` (`useSessionNotes`) |
| **While the composer is folded the pinned message is out of view**: its copy slides up past the top edge and fades, and the original row is drawn in the stream instead; when the panel opens the copy slides back down (*owner, 2026-11-06*) | A short panel has little room to read in, and the copy at the top took part of it; the message is never gone from the stream nor drawn twice | `StickyUser.tsx`, `ChatStream.tsx` |

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
| **Every change on screen is animated** (the rule for new and changed UI; the sidebar's folds are the first to follow it, #1605): a fold or unfold, something appearing or leaving, a switch of view, rows added or removed. About 150–200ms, in line with the layers above (`cc-drop` 160ms, `LEAVE_MS` 150ms). It never delays or blocks input: a row under the pointer is pressable while the list moves, and nothing that reacts to the pointer waits for the motion. What leaves stays in the DOM until its exit ends, so nothing blinks. A list folds as a transition of its grid track, not a keyframe, so one reversed half way goes on from where it is | A change that lands in one frame has to be re-read to see what moved (*owner, 2026-10-26*, #1605). This is the rule for a change that happens once; "Only what is alive moves" below is about motion that keeps going as a signal, and the two do not conflict | `Fold` (`components/Fold.tsx`, `.cc-fold`: a project's rows, the Assistant's children, the inbox's "Earlier"; 180ms open, 140ms close), `usePresence` |
| **A line that changes its words** (a tool's setup line: Install, progress, Sign in, Waiting for the browser…) folds in and out as a `Fold`, changes in place with `.cc-setup-swap` (170ms; under reduced motion a 100ms fade, no travel), and a progress bar is a transition of its width (`.cc-progress`, 180ms). A top-bar donut that comes or goes after the bar was first drawn grows and fades (`.cc-donut-in` 170ms, `.cc-donut-out` 150ms, kept in the DOM through its exit) | The same rule, for what changes inside a line and for the bar | `features/tools/ToolSetupLine.tsx`, `UsageDonuts.tsx`, `ProgressBar` |
| **Only what is alive moves**: `breathe` for work in progress, `cc-spin` (1.4s) for a button that is working, the gust once when a response finishes | Motion is a signal too, so it is spent only on "this is happening" | `.breathe`, `.cc-spin`, `.cc-gust` |
| **The pinned message folds away with a short panel's composer** (*owner, 2026-11-06*): it slides up past the top edge and fades over 180ms (`STICKY_FOLD_MS`), and comes back down the same way. The original row is drawn when the copy has gone and hidden again as it returns. It is a transition on the wrapper, so it composes with the copy's own steps aside for the next message (`cc-hang-out-up`); the copy takes no press or focus for as long as it is out (`inert`), the list keeps its coordinates, and a panel that opens already folded starts with the copy out of view. With reduced motion it only fades | The change should be seen, not re-read; scrolling and clicks under it are never held | `StickyUser.tsx` |
| **A change of state is a short fade, never a jump** (*owner, 2026-10-26*): a usage donut going from unknown to read, to or from unsupported, or a machine's donuts coming back changes by opacity, colour and fill in **150ms** (`RING_FADE`), a returning machine's capsule fades in over 180ms (`.cc-capsule-in`); a donut that comes after the bar was drawn has the entrance of the row above (`.cc-donut-in`). With reduced motion only the opacity moves. It never holds a press: the control works from the first frame | A state that flips at once reads as a glitch, and one that waits on the animation reads as slow | `UsageDonuts.tsx` `RING_FADE`, `.cc-donut-in` |
| **A chip that leaves a row of chips gives back its width as it fades, and one that arrives takes it as it fades in** (#2202, #2209): the status summary on a project's name line keeps a chip for its exit (`usePresence`, 150ms) and, in the same 150ms, collapses its width and the gap beside it (`.cc-chip-out`), so the chips that stay slide over where they jumped by 21px when it was removed. A chip that arrives does the reverse (`.cc-chip-in`, 150ms, ease-in, the exit run backwards): its width and gap grow from nothing while it fades in, so the chips on its left slide over. Its wrapper has no box at rest (`display: contents`; the entrance class comes off when its animation ends), so the line's layout does not change. With reduced motion a 100ms fade only, and the chips are where they end from the first frame (arrival) or stay where they are until it is gone (exit) | A chip that goes in one frame moves the others in the same frame, which reads as a glitch, and it moved them from under a pointer that rested on the line, so its tooltip closed | `sidebar/marks/FoldSummary.tsx`, `.cc-chip-out` and `.cc-chip-in` in `index.css`, `e2e/control-sidebar.spec.ts` |
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
| Usage panel of a tool with no limits | Plain words ("<Tool> does not report usage limits."), then the plan the tool says, then what it counted on this computer under "Local totals · all time" with a line that these are totals, not a limit and, under it, when they were read ("As of 3:42 PM", with the date for an earlier day; the same small muted text; absent when the host sends no time). Sessions and messages are exact counts with the thousands separators of the person's language ("1,204"); the token rows stay abbreviated. The plan is in the body font, not the figures font. No limit bar, no "unavailable". Each part fades in as it arrives (150-200 ms, opacity only with reduced motion), so a plan that comes after a slow command appears in place. A count the tool printed in a form that could not be read is a dash, never a number. A logged-out account is the reason every tool gives, not this panel | The old "Usage unavailable" and a technical reason read as a fault the person could fix (*owner, 2026-10-26*, #1623) | `UsagePanel.tsx` `NotReported`, `.cc-row-in` |
| Usage donut | Three looks, by what the ring can say (*owner, 2026-10-26*, #1616). **Read**: the fill on its track, the letter at `ink`. **Unknown for now** (`supported: true` with no weekly window, a read that failed, a host that predates the `notReported` mark): a **dashed** ring, the letter `ink-faint`: something the person may change (a session to run). **Does not report usage** (the host answered `supported: false` with `notReported`, today Cursor and OpenCode; a failed read also answers `supported: false` but not that): a thin **solid** ring in `ink-faint` at 50%, **no fill, no dashes** (a read ring's track would be nearly invisible in the light theme, and an empty one reads as 0%), the letter at full `ink`. A machine that is not connected is left out (6) | Dashes mean "something to act on"; a tool that never reports limits has nothing to act on, and a faint letter read as "not connected". The ring is not empty-full, so it does not say 0% used. The flag is the host's answer, never inferred from the tool's name | `UsageDonuts.tsx` `Donut` (`data-state`) |

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
| A tool's setup (install, sign in, the terminal hint) | `ToolSetupLine` (`features/tools/`): one piece in the new-session dialog, the first-run card, the new-app dialog and under the empty session's tool capsule, where the tool being set up takes the capsule's fill until it is ready or the session's own tool is picked again (for Antigravity the first-run card and the new-app dialog show its refusal, with no action, until it takes role text); a button that halts work in progress (the install, the sign-in) reads **Stop**, never Cancel, which belongs to the dialog (*owner, 2026-10-28*) |
| A bar for work with a known end | `ProgressBar` (`value` 0 to 1; null breathes) |
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
| A framed text button | `Button`: `primary` (the action a dialog is for), `secondary`, `quiet` (grey until hovered), `subtle` (faint, inside the conversation), `danger`, `ghost` (no frame), `choice` (a row of a list a question offers: outlined, `surface-selected` under the pointer and for the one picked); `xs` / `sm` / `md` / `lg` (`lg` is a list's row); `busy` with `busyText` |
| One of several, shown at once | `Segmented` (a radio group: one Tab stop, the arrow keys pick) |
| A setting that is on or off | `Switch` (a checkbox underneath, drawn as a track and knob); in Settings through `SettingToggle`, laid out with `SettingsLayout.tsx` (page, group card, row) |
| A capsule | `Pill`: `size="bar"` (the top bar's 28px) or `"label"` (a waiting card's kind); edges `quiet`, `live`, `solid`, `dashed` |
| A small uppercase label | `Badge` (`readout` among figures) |
| A framed text field | `TextInput`, or `TextField` with its label, hint and problem |
| A mail thread that waits on the person's answer, in the Inbox | A card like the held-mail cards (*owner, 2026-11-12*, #2229): a `line` border, the subject in `ink`, "{sender} asks you", the question's first three lines, its choices as a `ChoiceList` (a pick answers without opening the thread) and Open for words of one's own. The cards come first in the list, newest first; ordinary threads stay rows. The state label says "Waiting on you" | `AskCard.tsx`, `inboxList.ts` |
| Which question the reply box answers | With more than one question open in a thread, "Answering {session} · “{question}”" with a list to switch and "N other open" (*owner, 2026-11-12*, #2191, mock-up A); the newest is the default. With one, nothing is drawn. The list drops from the row and goes back up (`usePresence`, `.cc-drop`) | `AnsweringPicker.tsx` |
| The answers a mailed question offers | `ChoiceList` (*owner, 2026-11-11*, #1630, mock-up A): a small muted label ("Choose one"), then a numbered vertical list of rows as wide as the message, outlined in `line-strong` with no fill, so they do not read as more of the message above. A row takes `surface-selected` under the pointer; once the question is answered no row takes a press, the picked one stays on `surface-selected` and the others fade as a disabled control does, and the label says what was done ("You chose", "Answered"). The rows are `Button variant="choice" size="lg"`; hover and the picked state change in 150ms (`Button`'s `transition`, colours and the disabled fade); the label changes in place with `.cc-setup-swap` (reduced motion: a 100ms fade) |

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
