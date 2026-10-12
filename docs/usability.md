# Usability: how the screen is judged

What makes a screen in Centralu good enough, the decisions already taken about it, and what a pull
request that changes the screen has to show. The measuring tool itself is
[ux-metrics.md](ux-metrics.md); this document is the judgement that uses it.

## Goal

**The fewest operations and decisions for a task, usable from the first day by people who are not
developers.** The people this is for run several agents at once and are not all programmers: a
task has to be findable by looking, and cheap once found. Speed for someone who already knows the
keys comes after that, never instead of it.

## Principles and decisions

| Principle | Decision and reasoning |
|---|---|
| **Judge the discoverable path** | A task is judged by the path whose every step is visible on screen: buttons, menus, rows, a hint printed next to them. Shortcuts (⌘K, chords, single-letter keys) are known only to people who were told, so they are expert extras, reported apart and never the evidence that a task is cheap. A task with no discoverable path is a finding, not a pass (owner, 2026-10-12, [#518](https://github.com/ijun17/centralu/issues/518); built in #529) |
| **The field that takes the next keystroke has the keyboard** | After creating a session, switching to one, or opening a form whose next step is typing, the caret is already in the field. A missing focus costs a hand move and a click (about 1.4 s) every time, and is invisible to tests that use `fill()` ([#528](https://github.com/ijun17/centralu/issues/528), CONTRIBUTING "Where the keyboard goes") |
| **Keys never misfire during IME composition** | Enter that finishes a Korean, Japanese or Chinese syllable, and Esc that cancels one, belong to the input method. Every handler acting on Enter, Esc, arrows or Tab where text can be typed goes through `composingKey` (`packages/ui/src/app/keys.ts`), which also catches WKWebView's `keyCode` 229 ([#496](https://github.com/ijun17/centralu/pull/496)) |
| **Entry points where the person already is** | A control near the pointer and the content it acts on is cheaper to reach (Fitts's law) and easier to find. Prefer an action on the row or panel it changes over one in a distant menu, and a visible control over one that appears only on hover (#529: the open project's `+`) |
| **Fewer choices per step** | Every choice costs a decision, and a longer list costs more (Hick–Hyman law). A sensible default that needs no dialog beats a dialog of defaults; a menu with fewer items beats one with more |

## Process

A pull request that adds or changes something on screen:

1. **Adds or updates its task scenarios** (`e2e/ux/*.task.ts`): the discoverable path, and the
   shortcut path beside it when one exists. A task a person does often gets one.
2. **Attaches discoverable before/after numbers** from `pnpm ux:report --compare <before> <after>`
   in the PR's **Usability** field, or says `n/a` when nothing on screen changed.
3. **Justifies every budget it raises**, in the PR description; lowers the budget when a task gets
   cheaper, so the gain is kept. CI's `ux tasks` job fails a task over its budget.

## Methods in brief

Details, values and sources: [ux-metrics.md](ux-metrics.md).

- **Keystroke-Level Model** (KLM): a task is a string of operators (K key, P point, B button,
  H hand move, M mental preparation), and its time is their sum. It predicts an expert's error-free
  time, which is what compares two versions of a task.
- **Fitts's law** prices each pointing from the target's distance and width on screen.
- **Hick–Hyman law** prices a choice among n items; reported as a note, since the M before it
  already stands for the decision.

## Not measured yet

What KLM does not see, and when to add it:

| Not measured | What it would catch | When |
|---|---|---|
| Learnability for first-time users | Whether someone who has never seen the app finds the path at all, and how long that takes | Before 1.0: a handful of first-run sessions with people who are not developers, timed and noted |
| A one-question SEQ (Single Ease Question) in real use | How hard a task felt, on a 7-point scale, right after doing it | When the app has users outside the team: asked once after a core task |
| Cognitive walkthroughs | Where a newcomer would not know what to do next, step by step, without running anything | For a new flow before it is built, and for a task whose discoverable path is long |
| Errors and recovery | Wrong turns and their cost | With the first-run sessions above |
| Reading and waiting | Time spent reading, and a slow host or remote machine | Waits are measured against the real host, not the mock ([ux-metrics.md](ux-metrics.md) "Waits") |

## References

- Card, S. K., Moran, T. P., & Newell, A. (1983). *The Psychology of Human-Computer Interaction*.
  Lawrence Erlbaum.
- Fitts, P. M. (1954). The information capacity of the human motor system in controlling the
  amplitude of movement. *Journal of Experimental Psychology*, 47(6), 381–391.
- Hick, W. E. (1952). On the rate of gain of information. *Quarterly Journal of Experimental
  Psychology*, 4(1), 11–26. Hyman, R. (1953). Stimulus information as a determinant of reaction
  time. *Journal of Experimental Psychology*, 45(3), 188–196.
- ISO 9241-11:2018, Usability: definitions and concepts.
- Nielsen, J. (1994). 10 Usability Heuristics for User Interface Design. Nielsen Norman Group.
- Sauro, J., & Lewis, J. R. (2016). *Quantifying the User Experience* (2nd ed.). Morgan Kaufmann.
  (The SEQ, and sample sizes for small studies.)
- Wharton, C., Rieman, J., Lewis, C., & Polson, P. (1994). The cognitive walkthrough method: a
  practitioner's guide. In *Usability Inspection Methods*. Wiley.
