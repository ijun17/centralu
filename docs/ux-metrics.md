# What a task costs: keyboard and mouse operations

New features and usability changes are judged by numbers ([#518](https://github.com/ijun17/centralu/issues/518)):
for a task a person does, how many keyboard and mouse operations it takes and how long an
experienced person would need. The aim is to keep both as low as possible, and to notice when a
change makes a task cost more.

The numbers come from Playwright scenarios against the mock (`e2e/ux/*.task.ts`), priced by the
**Keystroke-Level Model** (KLM; Card, Moran & Newell) with **Fitts's law** for every pointing.
They predict an expert's error-free execution time. They do not measure how easy a task is to
learn, how long a person spends reading, or how often they get it wrong.

The principles these numbers serve, and what a pull request shows with them: [usability.md](usability.md).

## Discoverable paths first

A task is judged by the path a person can find on screen, not by its shortcut (owner,
2026-10-12). A shortcut is known only to people who already know it: a task that is cheap by ⌘K
and three clicks deep by sight is a three-click task for everyone who was never told. So every
path is tagged with its **access**:

| Access | Means | Counts toward |
|---|---|---|
| `discoverable` | Everything the path needs is visible: buttons, menus, rows, a hint printed on screen (the palette's "↵ Open"). The mouse, or the keyboard only on what the screen shows: Tab, Enter on a focused control, typing into a field that has the caret | The headline numbers, the budgets, the baseline |
| `shortcut` | Needs knowing something the screen does not show: ⌘K, ⌘[, y/n/a, any chord | The **expert** section only, reported apart and never used to argue that a task is cheap |

Every task has a discoverable path, or a pending entry saying that it has none; that gap is the
finding. A shortcut path is written beside it when one exists, so the report also shows what the
keys save someone who knows them.

| Need | Run |
|---|---|
| The suite, with the table and `test-results/ux-report.json` | `pnpm ux` |
| One task | `pnpm ux -g approve.keyboard` |
| Compare with the baseline as it runs | `UX_BASELINE=e2e/ux/baseline.json pnpm ux` |
| A report as a table | `pnpm ux:report <report.json>` |
| Two reports side by side | `pnpm ux:report --compare <before.json> <after.json>` |

`pnpm ux` starts its own dev server (port 5196, `UX_PORT`) and runs in WebKit, the desktop app on
macOS and Linux (`E2E_BROWSER=chromium` for the Windows engine). Locally, take the e2e lock like
any Playwright run (AGENTS.md). CI runs it on every pull request in the `ux tasks` job
(`.github/workflows/build.yml`): a task over its budget fails the job, the table and the comparison
with `e2e/ux/baseline.json` go to the job's summary, and the JSON is kept as the `ux-report`
artifact.

## The model

A task is a string of operators. Its time is the sum of their times.

| Operator | Meaning | Time | Source |
|---|---|---|---|
| K | A key press. A chord counts every key in it (`⌘K` is K K); a capital or a shifted symbol is Shift and the key | 0.28 s | Card, Moran & Newell 1980, Fig. 1: the average non-secretary typist, 40 wpm. Their table runs from 0.08 s (135 wpm) through 0.2 s (55 wpm, an average skilled typist) to 1.2 s (someone who does not know the keyboard). The slower value because the people this is for are not all developers |
| P | Pointing with the mouse at a target | Fitts's law, per target (below) | KLM gives 1.1 s as the average; Fitts's law prices each pointing from what is on screen |
| B | A mouse button press *or* release; a click is B B | 0.1 s | Card, Moran & Newell 1980 |
| H | The hand moving between keyboard and mouse | 0.4 s | Card, Moran & Newell 1980 |
| M | Mental preparation | 1.35 s | Card, Moran & Newell 1980; placed by their rules (below) |
| R | Waiting for the app | measured, **not added** | See "Waits" below |

### Fitts's law

`P = a + b · log2(D/W + 1)`, the Shannon form (MacKenzie 1992), with

- **D**, the distance from where the pointer is to the target's centre, read from the boxes on
  screen at the moment of the click;
- **W**, the target's width *along the line of approach* (MacKenzie & Buxton 1992): coming in
  level, a wide button is wide; coming in from above, it is only as wide as it is tall;
- **b = 0.1 s/bit**, the Model Human Processor's Fitts slope I_M (Card, Moran & Newell 1983,
  100 ms/bit, range 70–120);
- **a = 0.8 s**, a project choice, not a fitted constant: it makes a 3-bit target (D/W = 7, a
  typical button across a window) cost the KLM's average P of 1.1 s, so a Fitts-priced P and the
  textbook P agree where they should.

What the numbers are for is comparing two versions of a task, and for that a and b only have to
stay fixed. Pointing at a target the pointer is already on costs no P, only the click.

### Hick–Hyman law

A choice among n items (the waiting list, palette results) is priced as `0.15 s · log2(n + 1)`
(Card, Moran & Newell 1983, the Model Human Processor's I_C; Hick 1952, Hyman 1953) and reported as
a **note on the task, not added to its time**: the M before the choice already stands for the
decision, and adding both would count it twice. A step reports one when the task passes `among`.

### Where the M's go

Card, Moran & Newell's heuristic rules (1980, Fig. 2), as `e2e/ux/klm.ts` applies them:

| Rule | As written | Here |
|---|---|---|
| 0 | An M before every K that is not part of a text or number string proper, and before every P that selects a command (not an argument) | An M before every `press` (one per key or chord) and before every click with `role: 'command'` (the default). None inside a typed string, none before a click with `role: 'argument'` (placing the caret in a field) |
| 1 | If the operator after an M is fully anticipated by the one before it, delete the M (P M K → P K) | Deleted between a pointing and the K or B it leads to. A click never gets an M between its P and its B in the first place |
| 2 | If a string of M K's belongs to one cognitive unit, delete all M's but the first | A chord is one press, so one M. A step marked `continues` belongs to the unit before it (`ArrowDown ArrowDown Enter` to the second item) |
| 3 | If a K is a redundant terminator, delete the M before it | A press marked `redundant` |
| 4 | If a K terminates a constant string, delete the M before it; if it terminates a variable string, keep it | The first key after a typed string is read as its terminator; strings are `variable` unless the task says `constant` |

What the rules leave to judgement, the task says (`role`, `string`, `continues`); the recorder
cannot tell a command from an argument by looking.

### Where this is an approximation

- **The hand starts on the keyboard** and **the pointer in the middle of the window**, unless a
  task says otherwise. A mouse path pays one H to begin with; a keyboard path pays none.
- **Every key while the hand is on the mouse costs an H**, as in the classic model, even a
  modifier chord a person might press with the other hand.
- **Typing is the same for every string**: no M within it, 0.28 s a key. Composing the message
  itself is not the interface's cost, and both paths of a task type the same text.
- **Reading is not counted.** Neither is finding a target by eye beyond the M before it.
- **Scrolling is not counted.** A target outside the window is scrolled to and the report says
  so in the task's notes.
- **The system's own dialogs** (the folder picker) are outside the page; what a person does in
  them is not counted, and the task says so.
- **A drag is priced like two pointings.** Dragging follows Fitts's law with a steeper slope than
  pointing (MacKenzie, Sellen & Buxton 1991); the model keeps b = 0.1 s/bit for both, so a drag is a
  little cheaper here than in life, and the hold is not counted.
- **Errors and recovery are not modelled.** The goal check makes sure the path works; it does
  not price the wrong turns.

### Waits

Every place a person would wait for the app before going on is an R (`u.until(...)`), and the
goal check is the last. R is reported as a count and the measured milliseconds, **not added to the
KLM time**: against the mock, the app answers at once, and under test load the measured time is
the test machine's, not the app's. A deterministic time is what lets a budget fail a run without
failing it at random. An R that matters to a person (a slow host, a remote machine) is measured
with the host, not here.

## Writing a task

A task is a named Playwright scenario with a start state and a checked goal, in
`e2e/ux/*.task.ts`:

```ts
uxTask({
  id: 'approve.mouse', // <task>.<path>
  task: 'Answer an approval waiting in another session',
  path: 'mouse', // or 'keyboard' or 'mixed': how the person moves through the app
  access: 'discoverable', // or 'shortcut' (see "Discoverable paths first")
  start: demo, // the start state, not measured: the mock's handles and the store are fine here
  run: async (u, page) => {
    await u.click(page.getByTestId('session-row-…'))
    await u.until('the approval card', () => expect(page.getByTestId('approval-card')).toBeVisible())
    await u.click(page.getByTestId('approve-allow'))
  },
  goal: async (page) => expect(page.getByTestId('approval-card')).toBeHidden(),
  budget: { operators: 9, M: 2, H: 1, seconds: 5.8 }, // a discoverable path only
})
```

Everything in `run` goes through the recorder `u` (`e2e/ux/recorder.ts`), never `page` or a
locator directly, or it goes uncounted:

| Call | Operators | Notes |
|---|---|---|
| `u.press(chord, { continues?, redundant?, among? })` | M + one K per key | A real key event (`page.keyboard.press`) |
| `u.type(text, { string? })` | one K per key | `string: 'constant'` for a string known by heart (a command's name); `variable` otherwise |
| `u.fill(field, text)` | a click on the field if it does not have the keyboard, then `type` | Focus is asked of the page, so a field that should have taken focus and did not shows up as an extra P B B |
| `u.click(target, { role?, continues?, among? })` | M (command) + P + B B | A real click at the target's centre; D and W from its box |
| `u.point(target)` | P | A hover without a click |
| `u.drag(source, target, { at? })` | M + P B P B | Real pointer moves, press and release; `at` is the drop point inside the target (the top of a row, to drop before it) |
| `u.until(label, check)` | R | Waits for the app and measures how long |

A task the suite cannot run yet goes in as `uxPending({ id, task, path, access, waitingOn, reason })`:
it is listed in the report as pending, so a baseline says what it does not cover. When the feature
lands, the same pull request replaces it with a `uxTask`. "No discoverable path exists" is listed
the same way.

Write the discoverable path of every task, the shortest one the screen shows, and the shortcut path
beside it when one exists. Only a discoverable path takes a `budget`; the types refuse one on a
shortcut path (`e2e/ux/task.ts`).

## Reading the numbers

A report has two tables: **discoverable paths** first, the headline, then **expert paths**, the
shortcuts. `--compare` groups the same way; a report from before the tags (version 1) takes each
task's group from the other report.

- **The operator string** (`H M P B B M P B B`) is the task's shape. Runs of three or more are
  written with their count (`25K`). Reading it tells what a change did: a new `H P B B` before a
  typed string is a field that stopped taking focus; a new `M K` is one more decision.
- **Operator counts** (K P B H M) and **Ops**, their sum, are what the budgets hold exactly.
- **KLM s** is the predicted time of an expert doing the task without errors. Differences matter
  more than the absolute value: one M is 1.35 s, one H 0.4 s, one key 0.28 s.
- **Travel px** is the total pointer distance. It explains a P that got slower.
- **R** is how many times the person waits and the measured milliseconds.
- **Notes** carry Hick–Hyman choices and anything the path assumes or leaves out.

The JSON report (`test-results/ux-report.json`, or `UX_REPORT`) has every step with its operators,
time, pointing (D, W, index of difficulty) and wait.

## Budgets

A discoverable path declares upper bounds: `operators`, any of `K P B H M`, `seconds`, `travelPx`.
A run over any of them fails. A shortcut path has none: it is measured and reported, but how cheap
it is never stands for the task. The first budgets are the baseline's numbers: the counts exactly, the KLM
time with 2% and 0.05 s of headroom rounded up to a tenth, because pointing times follow the
boxes on screen and fonts differ a little between machines.

A change that makes a task cost more fails the `ux tasks` check. If the cost is deliberate, raise
the budget in the same pull request and say why in its description; if a change makes a task
cheaper, lower the budget so the gain is kept. Update `e2e/ux/baseline.json` with the CI run's
`ux-report` artifact when the numbers move.

## Baseline (2026-10-12)

WebKit on Linux (the CI run), 1280 × 840 (the desktop app's default window), the `?demo` scene.
On macOS the numbers agree to within 0.01 s and a few pixels of travel. Since #528 the composer of
a session just created or picked in the palette, and the typed Add machine form's first field, take
the keyboard. Since #529 every core task has a discoverable path, and the paths are split by access
(see "Discoverable paths first").

**Discoverable paths** (the headline; the budgets are these):

| Task | Path | Operators | K | P | B | H | M | Ops | KLM s | Travel px |
|---|---|---|---|---|---|---|---|---|---|---|
| Start a new session and give it its first instruction | mouse (the open project's +, #529; since #543 it starts the session at once) | `H M P B B H 18K M K` | 19 | 1 | 2 | 2 | 2 | 26 | 10.27 | 534 |
| Answer an approval waiting in another session | mouse (Allow on its sidebar row, #543) | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.14 | 586 |
|  | mouse (Allow on its waiting-list row, #543) | `H M P B B M P B B` | 0 | 2 | 4 | 1 | 2 | 9 | 5.83 | 982 |
| Answer an approval while typing a message in its session | mouse (the card's Allow, keyboard still in the composer) | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.01 | 357 |
| Switch to another session by name | mouse | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 2.92 | 525 |
| Switch back to the session you were just in | mouse (the top bar's back arrow) | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.21 | 663 |
| Send a message to another session | mouse | `H M P B B P B B H 25K M K` | 26 | 2 | 4 | 2 | 2 | 36 | 13.39 | 1141 |
| Find a past conversation | mixed (the search field in the top bar, #529, #727) | `H M P B B H 4K M K` | 5 | 1 | 2 | 2 | 2 | 12 | 6.26 | 633 |
| Open an app on another machine | mouse (its sidebar row) | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.01 | 544 |
| Link another machine | mouse (picked from the ssh config, #514) | `H M P B B M P B B M P B B M P B B` | 0 | 4 | 8 | 1 | 4 | 17 | 11.05 | 2240 |
|  | mouse (typed by hand) | `H M P B B M P B B H 10K H P B B H 13K H M P B B` | 23 | 4 | 8 | 5 | 3 | 43 | 17.71 | 2161 |
| Add an existing folder as a project | mouse | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 2.99 | 567 |
| Create a new project (an empty folder in ~/Centralu, #515) | mouse | `H M P B B H 4K H M P B B` | 4 | 2 | 4 | 3 | 2 | 15 | 7.55 | 1048 |

**Expert paths** (shortcuts; never the headline):

| Task | Path | Operators | K | P | B | H | M | Ops | KLM s | Travel px |
|---|---|---|---|---|---|---|---|---|---|---|
| Start a new session and give it its first instruction | keyboard (palette, New session) | `M 8K M 19K M K` | 28 | 0 | 0 | 0 | 3 | 31 | 11.89 | 0 |
| Answer an approval waiting in another session | keyboard (⌘⇧A, y) | `M 3K M K` | 4 | 0 | 0 | 0 | 2 | 6 | 3.82 | 0 |
|  | keyboard (⌘I, y on the waiting list's row, #543) | `M K K M K` | 3 | 0 | 0 | 0 | 2 | 5 | 3.54 | 0 |
| Answer an approval while typing a message in its session | keyboard (⌘⇧Y from the composer) | `M 3K` | 3 | 0 | 0 | 0 | 1 | 4 | 2.19 | 0 |
| Switch to another session by name | keyboard (palette) | `M 7K M K` | 8 | 0 | 0 | 0 | 2 | 10 | 4.94 | 0 |
| Switch back to the session you were just in | keyboard (back) | `M K K` | 2 | 0 | 0 | 0 | 1 | 3 | 1.91 | 0 |
| Send a message to another session | keyboard (palette) | `M 7K M 26K M K` | 34 | 0 | 0 | 0 | 3 | 37 | 13.57 | 0 |
| Find a past conversation | keyboard (⌘K) | `M 6K M K` | 7 | 0 | 0 | 0 | 2 | 9 | 4.66 | 0 |
| Open an app on another machine | keyboard (palette, #529) | `M 7K M K` | 8 | 0 | 0 | 0 | 2 | 10 | 4.94 | 0 |

Pending:

| Task | Access | Path | Waiting on |
|---|---|---|---|
| Create a new project by asking the orchestrator | discoverable | mouse | The demo's orchestrator does not call `create_project`, so only a test handle raises its card |

What the baseline shows:

- **Starting a session took three clicks behind a button that appears only on hover** (the
  project's menu, then New session, then Start: 34 operators, 15.4 s). The project the person is in
  now shows its `+` (#529): two clicks, 30 operators, about 13 s. For someone who knows ⌘K, the
  palette's New session saves about a second more, an expert's number that does not stand for the
  task.
- **Finding a past conversation had no path anyone could see**: the palette, the only search,
  opened only by ⌘K / Ctrl+K. The search field in the middle of the top bar (#529, #727) opens it and prints
  the key, so the button also teaches the shortcut.
- **Opening an app was already one click** on its sidebar row; the palette now lists apps too, for
  an app scrolled out of sight or on a folded project.
- **Switching sessions from the palette used to leave the keyboard on the page** (#528, fixed): the
  keyboard path of "send a message" took the mouse for one click into the composer.
- **Picking a machine from the ssh config (#514) is 6.7 s cheaper than typing it**: 17 operators
  against 43. The typed form moves the hand between the keyboard and the mouse five times (2 s of H
  alone).
- **The waiting list, the way the app points to an approval out of sight, cost 8.4 s by mouse**,
  against 5.6 s for the sidebar row when it is in sight: both opened the session to reach the card's
  Allow. Since #543 the rows show the command and answer it in place: 5.8 s and 3.1 s. The keys
  (`⌘⇧A`, `y`: 3.8 s; `⌘I`, `y`: 3.5 s) are the expert's answer, not the task's.

## Audit 2026-10

The core tasks cover what a person does most; this audit measures the next twenty or so frequent
flows (`e2e/ux/flows.task.ts`, #518) on their discoverable paths, then ranks what could be cheaper
across every task, old and new. Nothing here is changed yet: the candidates are for the owner to
pick. WebKit on Linux (the CI run, now in `e2e/ux/baseline.json`), 1280 × 840, the `?demo` scene;
on macOS the operators are the same and the times agree to within a few hundredths of a second.

The new tasks carry looser budgets than the core ones (two operators to spare, the M's exactly,
the time plus 10%), enough to fail a change that adds a decision or a step and not one that moves a
pixel. A pull request that makes one cheaper tightens it.

| Task | Id | Operators | K | P | B | H | M | Ops | KLM s | Travel px |
|---|---|---|---|---|---|---|---|---|---|---|
| See what the agent changed in a file | `open-diff.mouse` | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.10 | 546 |
| Open a file the agent named: its link in the reply | `open-file.mouse-link` | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.08 | 211 |
| Open a file the agent named: the Files tab, folder by folder | `open-file.mouse-tree` | `H M P B B M P B B M P B B M P B B M P B B M P B B` | 0 | 6 | 12 | 1 | 6 | 25 | 15.83 | 890 |
| Open a file the agent named: the path in a tool card (since #543 item 6) | `open-file.mouse-tool-card` | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.07 | 167 |
| Attach a file to a message | `attach-file.mouse` | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.16 | 426 |
| Commit the session's changes with a message | `commit.mouse` | `H M P B B P B B H 30K H M P B B` | 30 | 3 | 6 | 3 | 2 | 44 | 16.33 | 1398 |
| Stop a session that is working | `stop-session.mouse` | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.12 | 384 |
| Rename a session | `rename-session.mouse` | `H P M P B B M P B B H 20K M K` | 21 | 3 | 4 | 2 | 3 | 33 | 14.06 | 714 |
| Delete a session (to the trash) | `delete-session.mouse` | `H P M P B B M P B B M P B B` | 0 | 4 | 6 | 1 | 3 | 14 | 9.17 | 1401 |
| Bring back a session deleted by mistake | `restore-session.mouse` | `H M P B B M P B B M P B B` | 0 | 3 | 6 | 1 | 3 | 13 | 8.47 | 1789 |
| Start a session in its own git worktree | `worktree-session.mouse` | `H M P B B M P B B M P B B` | 0 | 3 | 6 | 1 | 3 | 13 | 8.50 | 1364 |
| Answer a question an agent asked in another session | `answer-question.mouse` | `H M P B B M P B B` | 0 | 2 | 4 | 1 | 2 | 9 | 5.42 | 1005 |
| Continue a session in the other tool (hand off) | `handoff.mouse` | `H P M P B B M P B B M P B B M P B B` | 0 | 5 | 8 | 1 | 4 | 18 | 11.66 | 1436 |
| Change a session's model | `change-model.mouse` | `H M P B B M P B B` | 0 | 2 | 4 | 1 | 2 | 9 | 5.83 | 707 |
| Run one of the project's saved commands | `run-command.mouse` | `H M P B B M P B B M P B B` | 0 | 3 | 6 | 1 | 3 | 13 | 8.25 | 964 |
| Open a terminal in the session's project | `open-terminal.mouse` | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.15 | 584 |
| Put an app on the grid | `grid-app.mouse` | `H M P B B M P B P B` | 0 | 3 | 4 | 1 | 2 | 10 | 6.63 | 1524 |
| Put a session on the grid | `grid-session.mouse` | `H M P B B M P B P B` | 0 | 3 | 4 | 1 | 2 | 10 | 6.59 | 1452 |
| Move a project to the top of the sidebar | `reorder-projects.mouse` | `H M P B P B` | 0 | 2 | 2 | 1 | 1 | 6 | 3.98 | 724 |
| Add a folder on a linked machine as a project (since #734: Add project, then the machine, `H M P B B M P B B H 12K H M P B B`, 27 · 12.33 s · 1325 px) | `add-remote-project.mouse` | `H M P B B H 12K H M P B B` | 12 | 2 | 4 | 3 | 2 | 23 | 9.98 | 996 |
| Update the app when a new version is out | `update-app.mouse` | `H M P B B M B B` | 0 | 1 | 4 | 1 | 2 | 8 | 4.75 | 589 |
| See how much of the weekly limit is used | `view-usage.mouse` | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.18 | 647 |
| Switch to the light theme | `change-theme.mouse` | `H M P B B M P B B M P B B` | 0 | 3 | 6 | 1 | 3 | 13 | 8.44 | 1791 |

What they show:

- **Six of the twenty-two paths are one click** (the diff, a file's link, attach, stop, the
  terminal, usage): the entry is on screen where the person already looks.
- **The cost is in repeated `M P B B`**, one decision and one click per step: a dialog that asks
  for defaults (new session, worktree, delete, hand off), a menu behind a menu (Settings, then a
  tab), a pick followed by a confirm (a question's option then Answer, a saved command then Run).
- **Hidden entry points.** A session's ⋯ appears only under the pointer (rename, delete and hand off
  begin with a `P` to reveal it). A path in a tool card ("Read packages/…") was not a link, so the
  same file cost 15.8 s through the tree instead of 3.1 s (a link since #543 item 6: 3.07 s). A project can be reordered only by a drag
  nothing on screen mentions. Adding a machine lives in Settings, not in the sidebar's machine group
  where the machines are (the groups went in #734: one list, each linked machine's project with its badge).
- **Fields that do not take the keyboard**: the composer after clicking a session's row (the core
  task "send a message", `P B B`), and the commit message after Stage all.

### Candidates, ranked

Ranked by the time saved on the task's discoverable path, weighted by how often a person does the
task (a judgement, marked H, M or L; nobody has counted yet). "After" is computed with the same
values as the suite: a step a change removes is taken out with its measured operators, and a target
that changes is re-priced by Fitts's law. Each is a proposal, not a decision.

| Rank | Task (path) | Now: ops · KLM s · M · travel px | What costs | Proposed change | After: ops · KLM s (Δ) | Often | Work |
|---|---|---|---|---|---|---|---|
| 1 (built, #543: 5.83 s) | Answer an approval (`approve.mouse-inbox`) | 13 · 8.35 · 3 · 1050 | The waiting list only navigates: open the list, pick the row, then find Allow in the card (`M P B B` three times) | Allow and Deny on each waiting-list row, with the command it asks about shown in the row | 9 · 5.85 (−2.50) | H | UI only (the waiting session already carries its approval) |
| 2 (built, #543: 3.14 s; the command on a line under the row, not only in a tooltip) | Answer an approval (`approve.mouse`) | 9 · 5.56 · 2 · 741 | The sidebar row only opens the session; Allow is a second pointing across the window | An Allow / Deny pair on a waiting row in the sidebar (only while it waits), the command in its tooltip | 5 · ~3.1 (−2.4) | H | UI only |
| 3 | Start a new session (`new-session.mouse`) | 30 · 12.98 · 3 · 1198 | The `+` opens a dialog whose only step in the common case is Start (`M P B B`, 2.72 s) | One click on `+` starts a session with the last-used tool and no worktree; the dialog moves behind a "…" beside it (partly done: #529 made the `+` visible; **done in #543**, where the "…" is a chevron beside the `+` and the budget is 26 operators, M 2, 10.6 s; since 2026-10-17 the chevron is gone: the dialog is the project menu's New session, and the new session's empty screen offers the other tool and the past conversations) | 26 · 10.26 (−2.72) | H | UI only (the tool from the project's last session) |
| 4 | Send a message to another session (`send-to-session.mouse`) | 36 · 13.39 · 2 · 1141 | Clicking a session's row leaves the keyboard on the row: a `P B B` into the composer before typing | A click on a row (not arrowing through rows) gives the composer the keyboard, as the palette does since #528 | 33 · 11.95 (−1.44) | H | UI only |
| 5 | Answer a question (`answer-question.mouse`) | 13 · 8.04 · 3 · 1332 (**done, #543**: now 9 · 5.42 · 2 · 1005) | Picking the option is the decision; Answer is a second one (`M P B B`, 2.62 s) | For a single question with one choice, clicking an option answers; Answer stays for several questions, multiple choice and "Other" | 9 · 5.42 (−2.62) | H | UI only |
| 6 | Open a file the agent named (`open-file.mouse-tree`) | 25 · 15.83 · 6 · 889 | A path in a tool card is not a link; the tree costs one `M P B B` per folder | Paths in tool cards (Read, Edit, Write) open the file like a reply's link; an Edit opens its diff | 5 · 3.08 (−12.75) | M | UI only (`openFile` exists). **Done** (#543): the link opens the file (`open-file.mouse-tool-card`, 5 · 3.07); the Edit's diff is not part of it |
| 7 | Commit the changes (`commit.mouse`) | 44 · 16.33 · 2 · 1398 | Commit is disabled until something is staged, a git idea people who are not developers do not have | With nothing staged, the button reads "Commit all" and stages everything; Stage all stays for those who stage | 40 · 13.54 (−2.79) | M | UI only (stage all, then commit: both exist) |
| 8 | Link another machine (`add-machine.ssh-config`, `.mouse-manual`) | 17 · 11.05 · 4 · 2240 | Two levels into Settings (Settings, then Machines) while the machines are listed in the sidebar | An "Add machine" entry in the sidebar's machine group (and beside "Add project" before there is a group) opens the same form | 13 · 8.37 (−2.68); typed: 39 · 15.03 | L (first run) | UI only |
| 9 | Link another machine (`add-machine.ssh-config`) | 17 · 11.05 · 4 · 2240 | When the probe finds one shell there is nothing to choose, yet Link still waits for a click | Link at once when the probe finds exactly one shell; the choice appears only when there are several | 13 · 8.34 (−2.71); with 8: 9 · 5.66 | L (first run) | UI only (the probe already returns the shells) |
| 10 | Rename a session (`rename-session.mouse`) | 33 · 14.06 · 3 · 714 | Hover to reveal ⋯, ⋯, Rename: 6.4 s before the first key; the double-click is invisible | Click the open session's name in its header to rename it (an edit cursor on hover) | 28 · ~10.6 (−3.5) | M | UI only |
| 11 | Delete, and bring back (`delete-session.mouse`, `restore-session.mouse`) | 14 · 9.17 · 3 · 1401; 13 · 8.47 · 3 · 1789 | A confirmation for something the trash makes reversible; bringing it back is two levels into Settings | Delete moves to the trash at once; the toast says "Moved to the trash · Undo" | 10 · 6.54 (−2.63); restore from the toast: 5 · ~3.2 (−5.3) | M | UI only (restore exists) |
| 12 | Hand off to the other tool (`handoff.mouse`) | 18 · 11.66 · 4 · 1436 | The dialog defaults to the same tool, so continuing in the other one is one more pick | Two menu items, "Hand off to Claude Code…" and "Hand off to Codex…", each opening the dialog with its tool chosen | 14 · 9.08 (−2.58) | L | UI only |
| 13 | Run a saved command (`run-command.mouse`) | 13 · 8.25 · 3 · 964 | Picking a command selects it; Run is a second decision (#60 chose this so a click can read a log) | A ▶ on each command's row runs it; clicking the row still selects | 9 · ~5.8 (−2.5) | M | UI only |
| 14 | Start a worktree session (`worktree-session.mouse`) | 13 · 8.50 · 3 · 1364 | Dialog, box, Start | With 3: the "…" beside `+` offers "New session in a worktree", which starts at once on the default branch name | 9 · ~5.8 (−2.7) | M | UI only |
| 15 | Any session menu (rename, delete, hand off) | e.g. 14 · 9.17 · 3 for delete | The ⋯ shows only under the pointer: a `P` to the row before the `P` to the ⋯, and nothing tells a newcomer a menu exists | Keep the open session's ⋯ visible, and open the same menu on a right-click of any row | −1 P each, about −0.75 s | M | UI only |
| 16 | Add a folder on a linked machine (`add-remote-project.mouse`) | 23 · 9.98 · 2 · 996 (#734: 27 · 12.33 · 3 · 1325, the machine is now picked in Add project's menu since the machine header and its + are gone) | The whole path is typed; there is no picker on the other machine | Prefill the machine's home folder, and list its recent or likely folders under the field | 14 · ~7.5 (−2.5) | L | Prefill: UI only (the host's New-folder preview already names a folder there). Listing folders: host (a directory listing on the linked machine) |
| 17 | Update the app (`update-app.mouse`) | 8 · 4.75 · 2 · 589 | Install, then Apply now | When nothing is running, one click installs and applies | 5 · 3.20 (−1.55) | L | UI only (the keeper's busy report exists) |

"Work" says whether a candidate is a change to the screen alone (`packages/ui`, through ports that
exist) or needs the host or the protocol too. All but the folder list in 16 are the screen alone.

Not candidates: the one-click tasks, the grid (6.6 s, and the empty grid says how), and the theme
(8.4 s, but done once).

## References

- Card, S. K., Moran, T. P., & Newell, A. (1980). The keystroke-level model for user performance
  time with interactive systems. *Communications of the ACM*, 23(7), 396–410.
- Card, S. K., Moran, T. P., & Newell, A. (1983). *The Psychology of Human-Computer Interaction*.
  Lawrence Erlbaum. Ch. 2 (the Model Human Processor), ch. 8 (the Keystroke-Level Model).
- Fitts, P. M. (1954). The information capacity of the human motor system in controlling the
  amplitude of movement. *Journal of Experimental Psychology*, 47(6), 381–391.
- MacKenzie, I. S. (1992). Fitts' law as a research and design tool in human-computer
  interaction. *Human-Computer Interaction*, 7(1), 91–139.
- MacKenzie, I. S., & Buxton, W. (1992). Extending Fitts' law to two-dimensional tasks. *CHI '92*.
- MacKenzie, I. S., Sellen, A., & Buxton, W. (1991). A comparison of input devices in elemental
  pointing and dragging tasks. *CHI '91*.
- Hick, W. E. (1952). On the rate of gain of information. *Quarterly Journal of Experimental
  Psychology*, 4(1), 11–26. Hyman, R. (1953). Stimulus information as a determinant of reaction
  time. *Journal of Experimental Psychology*, 45(3), 188–196.
- Kieras, D. (2001). Using the Keystroke-Level Model to estimate execution times. University of
  Michigan. (A practical guide to placing M's.)
- John, B. E., et al. (2004). Predictive human performance modeling made easy (CogTool). *CHI '04*.
- ISO 9241-11:2018, Usability: definitions and concepts (effectiveness, efficiency, satisfaction).
- Sauro, J., & Lewis, J. R. (2016). *Quantifying the User Experience* (2nd ed.). Morgan Kaufmann.
- Nielsen Norman Group, "Interaction Cost".
