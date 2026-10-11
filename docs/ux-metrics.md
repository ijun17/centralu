# What a task costs: keyboard and mouse operations

New features and usability changes are judged by numbers ([#518](https://github.com/ijun17/centralu/issues/518)):
for a task a person does, how many keyboard and mouse operations it takes and how long an
experienced person would need. The aim is to keep both as low as possible, and to notice when a
change makes a task cost more.

The numbers come from Playwright scenarios against the mock (`e2e/ux/*.task.ts`), priced by the
**Keystroke-Level Model** (KLM; Card, Moran & Newell) with **Fitts's law** for every pointing.
They predict an expert's error-free execution time. They do not measure how easy a task is to
learn, how long a person spends reading, or how often they get it wrong.

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
  id: 'approve.keyboard', // <task>.<path>
  task: 'Answer an approval waiting in another session',
  path: 'keyboard', // or 'mouse' or 'mixed': how the person moves through the app
  start: demo, // the start state, not measured: the mock's handles and the store are fine here
  run: async (u, page) => {
    await u.press('ControlOrMeta+Shift+a')
    await u.until('the approval card', () => expect(page.getByTestId('approval-card')).toBeVisible())
    await u.press('y')
  },
  goal: async (page) => expect(page.getByTestId('approval-card')).toBeHidden(),
  budget: { operators: 6, M: 2, H: 0, seconds: 4.0 },
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

A task the suite cannot run yet goes in as `uxPending({ id, task, path, waitingOn, reason })`: it
is listed in the report as pending, so a baseline says what it does not cover. When the feature
lands, the same pull request replaces it with a `uxTask`. "No keyboard path exists" is listed the
same way.

Write both the keyboard path and the mouse path when both exist, and give each the shortest way a
person who knows the app would take.

## Reading the numbers

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

A task may declare upper bounds: `operators`, any of `K P B H M`, `seconds`, `travelPx`. A run
over any of them fails. The first budgets are the baseline's numbers: the counts exactly, the KLM
time with 2% and 0.05 s of headroom rounded up to a tenth, because pointing times follow the
boxes on screen and fonts differ a little between machines.

A change that makes a task cost more fails the `ux tasks` check. If the cost is deliberate, raise
the budget in the same pull request and say why in its description; if a change makes a task
cheaper, lower the budget so the gain is kept. Update `e2e/ux/baseline.json` with the CI run's
`ux-report` artifact when the numbers move.

## Baseline (2026-10-12)

WebKit, 1280 × 840 (the desktop app's default window), the `?demo` scene. Paths with no
counterpart are listed under "Pending".

| Task | Path | Operators | K | P | B | H | M | Ops | KLM s | Travel px |
|---|---|---|---|---|---|---|---|---|---|---|
| Start a new session and give it its first instruction | mouse | `H M P B B M P B B M P B B P B B H 18K M K` | 19 | 4 | 8 | 2 | 4 | 37 | 16.88 | 1833 |
| Answer an approval waiting in another session | keyboard | `M 3K M K` | 4 | 0 | 0 | 0 | 2 | 6 | 3.82 | 0 |
| | mouse (sidebar) | `H M P B B M P B B` | 0 | 2 | 4 | 1 | 2 | 9 | 5.60 | 766 |
| | mouse (waiting list) | `H M P B B M P B B M P B B` | 0 | 3 | 6 | 1 | 3 | 13 | 8.35 | 1052 |
| Switch back to the session you were just in | keyboard (back) | `M K K` | 2 | 0 | 0 | 0 | 1 | 3 | 1.91 | 0 |
| Switch to another session by name | keyboard (palette) | `M 7K M K` | 8 | 0 | 0 | 0 | 2 | 10 | 4.94 | 0 |
| | mouse | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 2.97 | 532 |
| Send a message to another session | keyboard | `M 7K M K M 26K M K` | 35 | 0 | 0 | 0 | 4 | 39 | 15.20 | 0 |
| | mouse | `H M P B B P B B H 25K M K` | 26 | 2 | 4 | 2 | 2 | 36 | 13.44 | 1175 |
| Find a past conversation | keyboard | `M 6K M K` | 7 | 0 | 0 | 0 | 2 | 9 | 4.66 | 0 |
| Open an app on another machine | mouse | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 2.98 | 534 |
| Link another machine (the form before #514) | mouse | `H M P B B M P B B P B B H 10K H P B B H 13K H M P B B` | 23 | 5 | 10 | 5 | 3 | 46 | 18.73 | 2204 |
| Add an existing folder as a project | mouse | `H M P B B` | 0 | 1 | 2 | 1 | 1 | 5 | 2.92 | 521 |

Pending:

| Task | Path | Waiting on |
|---|---|---|
| Start a new session | keyboard | No keyboard path: the palette has no "New session" action and no shortcut opens the dialog |
| Find a past conversation | mouse | No mouse path: the palette is the only search, opened only by ⌘K / Ctrl+K |
| Open an app on another machine | keyboard | No keyboard path: the palette does not list apps |
| Link a machine picked from the ssh config | mouse | #514 (pull request #517) |
| Create a new project (an empty folder) | mouse | #515 |

What the first baseline shows:

- **A new session does not give the composer the keyboard.** After the dialog closes, the first
  instruction needs a click into the composer (the `P B B` before `H 18K`): about 1.4 s of the
  task's 16.9.
- **Switching sessions from the palette leaves the keyboard on the page.** In WebKit one Tab
  reaches the composer (the `M K` before `26K` in the keyboard path of "send a message"); in
  Chromium (the Windows app) it does not, and the same path costs `H P B B H` more: 44 operators
  and 17.4 s instead of 39 and 15.2.
- **The add-machine form does not focus its first field**, and the mouse path moves between
  the hand and the mouse five times (2 s of H alone).
- **Answering an approval by keyboard is the cheapest core task after going back** (`⌘⇧A`, `y`:
  3.8 s); the waiting list, the way the app points to an approval out of sight, costs 8.4 s by
  mouse.

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
