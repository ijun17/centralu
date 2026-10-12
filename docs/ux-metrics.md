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
| Start a new session and give it its first instruction | mouse (the open project's +, #529) | `H M P B B M P B B H 18K M K` | 19 | 2 | 4 | 2 | 3 | 30 | 12.98 | 1198 |
| Answer an approval waiting in another session | mouse (sidebar) | `H M P B B M P B B` | 0 | 2 | 4 | 1 | 2 | 9 | 5.56 | 741 |
|  | mouse (waiting list) | `H M P B B M P B B M P B B` | 0 | 3 | 6 | 1 | 3 | 13 | 8.35 | 1050 |
| Switch to another session by name | mouse | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 2.92 | 525 |
| Switch back to the session you were just in | mouse (the top bar's back arrow) | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.21 | 663 |
| Send a message to another session | mouse | `H M P B B P B B H 25K M K` | 26 | 2 | 4 | 2 | 2 | 36 | 13.39 | 1141 |
| Find a past conversation | mixed (the Search button, #529) | `H M P B B H 4K M K` | 5 | 1 | 2 | 2 | 2 | 12 | 6.26 | 633 |
| Open an app on another machine | mouse (its sidebar row) | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 3.01 | 544 |
| Link another machine | mouse (picked from the ssh config, #514) | `H M P B B M P B B M P B B M P B B` | 0 | 4 | 8 | 1 | 4 | 17 | 11.05 | 2240 |
|  | mouse (typed by hand) | `H M P B B M P B B H 10K H P B B H 13K H M P B B` | 23 | 4 | 8 | 5 | 3 | 43 | 17.71 | 2161 |
| Add an existing folder as a project | mouse | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 2.99 | 567 |

**Expert paths** (shortcuts; never the headline):

| Task | Path | Operators | K | P | B | H | M | Ops | KLM s | Travel px |
|---|---|---|---|---|---|---|---|---|---|---|
| Start a new session and give it its first instruction | keyboard (palette, New session) | `M 8K M 19K M K` | 28 | 0 | 0 | 0 | 3 | 31 | 11.89 | 0 |
| Answer an approval waiting in another session | keyboard (⌘⇧A, y) | `M 3K M K` | 4 | 0 | 0 | 0 | 2 | 6 | 3.82 | 0 |
| Switch to another session by name | keyboard (palette) | `M 7K M K` | 8 | 0 | 0 | 0 | 2 | 10 | 4.94 | 0 |
| Switch back to the session you were just in | keyboard (back) | `M K K` | 2 | 0 | 0 | 0 | 1 | 3 | 1.91 | 0 |
| Send a message to another session | keyboard (palette) | `M 7K M 26K M K` | 34 | 0 | 0 | 0 | 3 | 37 | 13.57 | 0 |
| Find a past conversation | keyboard (⌘K) | `M 6K M K` | 7 | 0 | 0 | 0 | 2 | 9 | 4.66 | 0 |
| Open an app on another machine | keyboard (palette, #529) | `M 7K M K` | 8 | 0 | 0 | 0 | 2 | 10 | 4.94 | 0 |

Pending:

| Task | Access | Path | Waiting on |
|---|---|---|---|
| Create a new project (an empty folder) | discoverable | mouse | #515 |

What the baseline shows:

- **Starting a session took three clicks behind a button that appears only on hover** (the
  project's menu, then New session, then Start: 34 operators, 15.4 s). The project the person is in
  now shows its `+` (#529): two clicks, 30 operators, about 13 s. For someone who knows ⌘K, the
  palette's New session saves about a second more, an expert's number that does not stand for the
  task.
- **Finding a past conversation had no path anyone could see**: the palette, the only search,
  opened only by ⌘K / Ctrl+K. The Search button at the top of the sidebar (#529) opens it and prints
  the key, so the button also teaches the shortcut.
- **Opening an app was already one click** on its sidebar row; the palette now lists apps too, for
  an app scrolled out of sight or on a folded project.
- **Switching sessions from the palette used to leave the keyboard on the page** (#528, fixed): the
  keyboard path of "send a message" took the mouse for one click into the composer.
- **Picking a machine from the ssh config (#514) is 6.7 s cheaper than typing it**: 17 operators
  against 43. The typed form moves the hand between the keyboard and the mouse five times (2 s of H
  alone).
- **The waiting list, the way the app points to an approval out of sight, costs 8.4 s by mouse**,
  against 5.6 s for the sidebar row when it is in sight. The keys (`⌘⇧A`, `y`: 3.8 s) are the
  expert's answer, not the task's.

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
- Hick, W. E. (1952). On the rate of gain of information. *Quarterly Journal of Experimental
  Psychology*, 4(1), 11–26. Hyman, R. (1953). Stimulus information as a determinant of reaction
  time. *Journal of Experimental Psychology*, 45(3), 188–196.
- Kieras, D. (2001). Using the Keystroke-Level Model to estimate execution times. University of
  Michigan. (A practical guide to placing M's.)
- John, B. E., et al. (2004). Predictive human performance modeling made easy (CogTool). *CHI '04*.
- ISO 9241-11:2018, Usability: definitions and concepts (effectiveness, efficiency, satisfaction).
- Sauro, J., & Lewis, J. R. (2016). *Quantifying the User Experience* (2nd ed.). Morgan Kaufmann.
- Nielsen Norman Group, "Interaction Cost".
