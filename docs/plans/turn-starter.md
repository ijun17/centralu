# Whose a turn is, from the tool's naming of its inputs

Issue #1639, proposed 2026-11-03. Status: **design only**. It is built once the owner has answered the
decisions in §5. Everything here is read from main at `d648f42e1`, the mailbox switch.

## 1. Today

A session's turn is the person's or the work's (`TurnStarter.by`, #1377). Two records answer "who sent the message
this turn runs for", and only one of them asks the tool:

| Record | Kept | Whose messages | Decided |
|---|---|---|---|
| `nextStarter` / `nextSource` / `pending` in `ChildOwnership` (#1377) | memory, plus `report_turn:<session>` while a report is owed | every message | when the session goes from rest to `working` (`turnStarted`): the message noted in the last `NEXT_STARTER_MS` (15 s), or else the CLI's own turn |
| `input_origins:<session>` (#1604) | the store | a hub's messages only | on the event that opens the turn, by the input the tool names (`turnStartInputs`) |

The 15 s window is a guess based on time. Under load, or when the tool holds a message longer than the window, the
turn goes to the wrong side: it reads as the CLI's own turn, so a person's turn is reported as the work's. A command
the tool answers without a turn has the same effect when a work turn follows within the window: that turn reads as
the person's, and its report is not sent. `docs/agent-host.md` lists two limits of this rule (a CLI before 2.1.289,
and a host swap losing the memory-only record).

What reads `by` when a turn starts:

- the mailbox (`ChildOwnership.onTurnStarted` → `turnRecorder` → `MailTurns.beginOther`) writes the turn's row
  (`mail_turns.started_by`: `person`, `caller`, `cli`, `report`, `app`). The pair loop guard and
  `lastPersonTurn` count these rows, and what the turn sends gets its cause from them;
- `continuesPause` (the CLI's own turn after paused work is the caller's, #1576) and `personInTurn` (a refusal
  says "the person may be using it"), each time a call arrives during the turn;
- at the turn's end, `turnEnded` (the report goes out or not, and `turn` on the ending event).

## 2. What each tool names

| Tool | At a turn's start | At its end |
|---|---|---|
| Claude Code | `user_message_uuid` on the turn's first stream message (`turnStartInputs`). A turn the CLI starts itself (a task notification) names none (#1830). **A message sent at rest** makes the adapter say `working` at once (`deliver`), before the CLI says anything. The naming message comes later and no event carries it, so today neither record learns the input of a turn started at rest | `user_message_uuids` on the result (2.1.289 and newer; older: none) |
| Codex | a second `working` on the turn's first item, naming the `clientId` (`announceStart`) | none: an input sent while a turn runs joins that turn |
| ACP (core ledger) | nothing today, though the ledger starts every turn with one known input (`Queued.named`) | `turnInputs`: that input |

## 3. Proposal

1. **One record, in the store.** Every message given to the tool goes in under an id, whoever sends it: the person,
   an app, a session, the mailbox's wake, or a hub. `SessionHandle.send` already takes `opts.id` in every adapter.
   One list per session, `turn_inputs:<session>`, in the order the messages were given, at most 64: each entry is
   `[id, { by, added?, source?, origin? }]`. It replaces `nextStarter`, `nextSource` and `pending`, and it carries
   what `input_origins` carries (`origin`).
2. **Decided when the tool names the inputs.** A turn begins (rest to `working`) with its starter not yet known.
   The first `working` of that turn whose `turnStartInputs` names an id held in the list decides it: the turn
   belongs to the sender of the last named id, and every entry given up to that one leaves the list. This is the
   same rule `takeInputOrigin` follows today. A turn that names nothing on the event that opens it (Claude's first
   stream message with no uuid, Codex's first item with no client id) is the CLI's own turn (`cli`), with no doubt.
   For that:
   - the Claude adapter says `working` again on the first stream message of a turn it already said working, when that
     message names an input (as Codex does), so a turn started at rest is named too;
   - the ACP ledger answers `turnStartInputs` with the input it starts the turn with.
3. **Until it is decided, nothing acts on `by`.** The mailbox's turn row is written when the starter is decided (the hook
   moves from `turnStarted` to that point). `continuesPause` is false and `personInTurn` reads "not known" as not
   the caller's turn. A turn that ends before it is decided is decided at its end by rule 4.
4. **A tool that names nothing (one definite rule, no clock).** The turn belongs to the oldest entry given before the
   turn began. For a tool that runs one prompt at a time this is exact. A message that went into a running turn
   stays in the list until a turn names it or a later one, or until the end of a turn that names what it took in (as
   `turnEnded` does today).
5. **Remove** `NEXT_STARTER_MS`, `nextStarter`, `nextSource`, `pending` and `addNext`. Also remove the limit row in
   `docs/agent-host.md` (the first limit goes; the swap limit goes with rule 1).

#1640 (the person's Stop drops what is queued and says it was not delivered) is a prerequisite: after a Stop no
entry can start a turn, and the Stop already clears the list (`dropInputOrigins`).

## 4. Tests

- A message held queued longer than 15 s (fake timers) still has its turn attributed to its sender.
- A Claude send at rest: the `working` said at once names nothing, and the later one names the caller's id. The turn
  is the caller's, and the test fails when the decision moves back to the rest-to-`working` edge.
- A command the tool answers without a turn, then a CLI turn of its own: that turn is `cli`, not the person's.
- A real Claude child: the person types while a caller's note is queued, and each turn is attributed to its own sender.

## 5. Decisions for the owner

| # | Question | Proposed | Other choice |
|---|---|---|---|
| D1 | Keep every message's entry in the store (one small settings write per message sent) | Yes: one record, it survives a swap, and it removes both limits in `agent-host.md` | Keep the person's entries in memory (no write per message), and keep the swap limit |
| D2 | The key | A new `turn_inputs:<session>`, with `input_origins:` still written beside it for a hub's messages until the next release (a build before this one reads it during a swap), then removed (add first, remove later) | Extend `input_origins` entries in place: the older build skips any entry without `from`, so it would lose the person's entries, which it never kept anyway |
| D3 | A call that arrives while the starter is not known yet (between the turn's start and the tool's first message, usually under 3 s) | Refused as for a turn this host cannot tie to the work, with the existing words ("a turn it started by itself that this hub cannot tie to the work you gave it") | Hold the call until the starter is decided, with a bound |
| D4 | How Claude names a turn started at rest | A second `state_change: working`, as Codex does (no protocol change; the host already reads `turnStartInputs` on every `working`) | A new event that names the inputs (a protocol addition) |
| D5 | The hub's own 15 s window for "Add to the task" on a linked machine (`ADD_NEXT_MS`, `sessions/linked-reports.ts`) | Not in this change: the machine's host already sends `origin`. A follow-up issue | Same change |

Size, estimated: `child-ownership.ts` about −60/+45, `session-events.ts` about ±10, the Claude adapter +8, the
ACP ledger +3, tests about +120, `agent-host.md` −1 limit row and the record's paragraph rewritten.
