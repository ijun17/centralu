# Whose a turn is: decided at its start, corrected by the inputs the tool names

Issue #1639. Status: **built** in the same pull request as this document. The owner's decisions (2026-11-03) are in
§6. Read from main at `c9f3807a7`.

## 1. Before

A session's turn is the person's or the work's (`TurnStarter.by`, #1377). `ChildOwnership` decided it when the session
went from rest to `working`, from the message noted in the last 15 s (`NEXT_STARTER_MS`), else the CLI's own turn. That
is a guess by time: under load, or when the tool held a message longer than the window, the turn went to the wrong side.
A command the tool answered without a turn had the same effect when a work turn followed within the window. The record
(`nextStarter`, `nextSource`, `pending`) was memory only, so a host swap lost it.

What reads `by`:

- the mailbox's turn row (`onTurnStarted` → `turnRecorder` → `MailTurns.beginOther`, `mail_turns.started_by`), which
  the pair loop guard and `lastPersonTurn` count, and from which what the turn sends gets its cause;
- `continuesPause` and `personInTurn`, each time a call arrives during the turn;
- `turnEnded`, at the turn's end: the report goes out or not.

## 2. The rule

**Decide now, correct later.** There is no "not yet known" state: everything that reads `by` keeps working as it did.

1. **Entries.** Every message `sendMessage` gives the tool is one entry: the user row it already writes, which now
   also holds `inputId` (every message gets one, whoever sends it), `intent` (`task` or `takeover`, when not `ask`)
   and `relayed` (a report). The row's `from`, `fromApp` and `fromScript` say whose it is, as before: the person's when
   it has none of them. The first prompt `createSession` writes (a handoff, a script) is an entry the same way.
   The ids go to the tool with the message on every path: the queue drain (`QueuedRequests`), a routed card, and a
   Codex `send` (its `clientUserMessageId`, as `sendTracked` already did).
2. **Which entries are held.** `turn_inputs:<session>` holds `{ spent }`: the rows at or before `spent` are done with.
   The held entries are the rows after it that carry an `inputId`. They are kept in memory too and read back from the
   rows once per host, so a host that takes a kept session over after a swap knows them.
3. **At the turn's start** (rest to `working`): the turn is the oldest held entry's sender's, else the CLI's own
   (`cli`). Written to `report_turn` and the mailbox's row as before.
4. **When the tool names the turn's inputs** (`turnStartInputs` on a `working`, which now has three answers):
   - ids, of which some are held: the turn ran for every held entry up to the last one named (the tool runs inputs in
     order). It is the work's if any of them is, with `wrote` (or `added`) when one of them is the person's, else the
     person's. Those entries are spent.
   - ids, none held (a mail wake, a compact, a quiet note, the CLI's own): the turn is the CLI's own (`cli`).
   - `[]` (an opening that names nothing, from a tool that names inputs): the CLI's own.
   - `null` (not an opening, or a tool that never names): nothing changes.

   When the answer differs from the start's, the turn is decided again: `starters`, `report_turn` and the mailbox's
   row (`MailTurns.restate`: `started_by`, `message_id`, `starter_id` of the same turn). A turn the person took over
   (`takeTurn`) stays theirs.
5. **At the turn's end** (`turnInputs`):
   - ids: the held entries up to the last one named joined the turn (a person's into the work's is `wrote`, or
     `added`); they are spent. The rest stay for the next turn.
   - undefined (the tool takes every message into the running turn, Codex): every held entry joined, and is spent.
   - `null` (the tool cannot tell: a CLI before 2.1.289): every entry given before the end is spent, joined to no turn.
6. **Stop, cut, a process gone**: every held entry is spent (`spent` = the last row).
7. **Removed**: `NEXT_STARTER_MS`, `nextStarter`, `nextSource`, `pending`, `addNext`.

How each tool names a turn's inputs:

| Tool | At the start (`turnStartInputs`) | At the end (`turnInputs`) |
|---|---|---|
| Claude Code, 2.1.289 and newer (the CLI tracks inputs) | a second `working` on the turn's first stream message, also after a send at rest, also while a card is up: the message's `user_message_uuid`, or `[]` for a turn the CLI started itself | `user_message_uuids` |
| Claude Code, older | `null` | `null` |
| Codex | a second `working` on the turn's first item: its client id (`announceStart`) | undefined |
| ACP (core ledger) | on the ledger's own `working`: the input it started the turn with, or `[]` | that input |

`input_origins:<session>` (a hub's messages, #1604) is unchanged and still written beside the entries until the next
release: a build before this one reads it during a swap. It is removed then (add first, remove later).

## 3. Cases still attributed wrongly

From the review on #1639, and which way each errs:

| Case | Now |
|---|---|
| A compact, a mail wake, a queued request or a `start_agent` prompt is credited to a person's message still held | The queued request and the first prompt are entries now. A compact and a mail wake have none: until the tool names their id the turn is the held message's; Claude 2.1.289+, Codex and ACP correct it to `cli` at once. An older CLI keeps it: the turn reads as the person's, so its report is held back |
| A Codex turn from a person's `send` | Named (`clientUserMessageId`): right |
| An older CLI's own turn after a note was taken in mid-turn goes to that note's sender | Gone: an end that cannot name spends every entry. The cost: a note an older CLI really runs as a turn of its own after is read as the CLI's own turn, the work's, so a person's answer there is reported to the caller |
| The person then a caller at rest, folded into one turn | The work's with `wrote`, from every entry up to the one named |
| A takeover before the tool names the inputs is overwritten | Not overwritten: a taken-over turn stays the person's |
| Entries a build before this one leaves during a swap | It writes no `inputId`, so its rows are no entries. Its turns do not spend this build's entries: the next turn here decides by them until the tool names its input (Claude 2.1.289+, Codex, ACP), and an older CLI's end spends them |
| A message that started no turn (`/goal` refused, a limit at rest) | Stays held: the next turn is decided by it at its start, and corrected when the tool names that turn's input. An older CLI keeps it for one turn |

## 4. Tests

- A message held queued for 20 s before its turn opens is still its sender's turn (fails with the 15 s window).
- A Claude send at rest whose naming `working` names the caller's input after the person's started the turn: the
  turn is decided again as the caller's (fails when the decision stays at the rest-to-`working` edge).
- A compact or wake id named that no entry holds: the CLI's own turn.
- An end that cannot name spends every entry: the CLI's next turn is its own.
- The person takes over before the naming: the turn stays theirs.
- The mailbox's row is decided again in place (`MailTurns.restate`).

## 5. Not built here

- The hub's own 15 s window for "Add to the task" on a linked machine (`ADD_NEXT_MS`, `sessions/linked-reports.ts`)
  pairs the person's message with a machine's echo and does not decide who starts a turn. A follow-up issue.

## 6. Owner's decisions (2026-11-03)

| # | Decision |
|---|---|
| Design | The review's simpler design: decided at the turn's start, corrected when the tool names its inputs |
| D1 | No separate entry store: `inputId`, `intent` and `relayed` go on the user row `sendMessage` already writes |
| D2 | A new key (`turn_inputs:<session>`), never `input_origins` extended in place: an older build rewrites that list and drops what it cannot parse, and any key there marks the session as followed by a hub. `input_origins` is still written for a hub's messages until the next release |
| D3 | Goes away with this design (there is no "not yet known") |
| D4 | A second `working` event, no protocol event |
| D5 | A follow-up issue |
