# Importing previous sessions (external sessions)

The path for taking over a conversation started outside Centralu — in a terminal.
`+ → pick a tool → previous conversation list` in the session creation modal is this feature's entrance.

## Principle: use only official APIs

Both tools leave transcripts on disk
(`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`).
**We do not parse those files directly.** That format is not a documented contract, so it
breaks silently when the tool is upgraded, and you end up showing the wrong conversation without knowing it broke.

| | List | Read the conversation |
|---|---|---|
| Claude Code | SDK `listSessions({ dir })` | SDK `getSessionMessages(id, { dir })` |
| Codex | app-server `thread/list { cwd }` | app-server `thread/turns/list { threadId, sortDirection: 'desc', itemsView: 'full' }`, page by page; `thread/read { threadId, includeTurns }` on a Codex without it |

Responsibility for version compatibility sits with the tool — each API reads the storage format its own version wrote.
What we have to maintain is only **the conversion from a response into a conversation**, and that conversion is separated out
as a pure function so it can be verified without starting the tool (`adapters/history.test.ts`).

**Codex history is read in pages, newest first** ([#342](https://github.com/ijun17/centralu/issues/342)). Codex 0.160.0
deprecates full-history hydration for paginated threads and says so in a `deprecationNotice` that reached the
conversation. Measured on a scratch thread (gpt-5.6-luna, 2026-10-05, 19 turns with long command output):

| Request | Answer | Notice |
|---|---|---|
| `thread/resume` (whole history) | 7,260 KB in one line | "Full-history hydration is deprecated…" |
| `thread/resume { excludeTurns: true }` | 1.9 KB | none |
| `thread/fork` (whole history) / `{ excludeTurns: true }` | 7,260 KB / 1.3 KB | the notice / none |
| `thread/read { includeTurns: true }` | 7,260 KB in one line | "Full-history hydration is deprecated…" |
| `thread/turns/list`, five turns a page, `full` | the newest page only, for the last 4 lines | none |

| Decision | Why |
|---|---|
| Resume with `excludeTurns: true` | Nothing reads the history a resume returned except the running turn's id, which has its own one-turn query. One thread's answer was 23 MB (`architecture.md` §4) |
| Page `thread/turns/list` newest first and stop once the lines are in hand | An import (200 lines) or a catch-up (600) of a long thread reads its tail, not all of it. The lines are the same `thread/read` gave, so catching up still finds our last message and attaches only what follows |
| `itemsView: 'full'`, not `summary` | Measured, `summary` gives a turn's user message and final answer in about 0.2% of the bytes, but leaves the `contextCompaction` item out (a manual compaction's turn came back empty), and the compaction line is #303's. A page is still as large as its turns' command output |
| A Codex without `thread/turns/list` reads the whole thread, as before | It answers `-32601`. Only paginated threads draw the deprecation, and older versions have none |
| The contract checks the fields read back and the enum words sent | A renamed `nextCursor` or `inProgress` fails no request; it reads as absent, and every page after the first, or the running turn after a resume, would be lost silently (`codex-bindings.mjs`) |

## Compatibility with older tool versions

Not being able to fetch a list and not being able to create a session are different problems.
**Using an old tool version does not also block creating new sessions.**

- Claude: dynamic import + check the function exists. If it does not, 'not supported' instead of the module load blowing up.
- Codex: a server that does not know `thread/list` returns JSON-RPC `-32601`.
  This is treated not as an exception but as a normal negotiation outcome, and the reason is passed upward.
  But a genuine fault (`EACCES` etc.) is not hidden behind 'not supported' — the cause has to be visible.

That is why `agents.listExternalSessions` does not throw but returns `{ supported, reason?, sessions }`.
The UI draws `supported: false` as guidance, not as an error.

## Cleaning up the conversation

Both tools inject their own system text into user turns
(`<system-reminder>`, `<ide_opened_file>`, `<system_instruction>`, traces of slash commands).
In practice, a list title came out as `<system_instruction>You are working inside…`
and the first conversation as `<ide_opened_file>…`.

`adapters/history-text.ts` strips only these blocks — it does not throw the whole thing away,
because real user speech often follows an injected block.
Only when nothing is left after stripping is the line dropped.
**Tool calls come back as they were shown live** ([#843](https://github.com/ijun17/centralu/issues/843)). Everything in
a record but the words is read by the adapter's live normalizer (a Claude message's body by `assistantEvents` and
`userEvents`, once `readableMessage` has checked it into the shape they read, #1339;
`normalizeNotification` for a Codex item as if it had started and completed), and the reader keeps its tool calls,
their results and its compactions (`adapters/history-events.ts`); its thinking, usage, plan, images and activity are
not part of a conversation read back. Before, only the words came back, with a Claude call kept as its name, so an
imported conversation showed `Bash` where a watched one showed the command and its output. The limit counts the words
and compactions of the newest end (`lastLines`): a turn's tool rows ride along, so a turn full of calls does not push
older turns out. The Claude reader reads the transcript whole and keeps that end too: the SDK's own `limit` slices
from the start, so it gave the oldest rows and counted tool rows (#1006). One import keeps the newest calls up to 400
tool rows and each result's record up to 20,000 characters, since it writes them in one go. Not the same as live: a
Claude agent's card says its report is not in the record, since `getSessionMessages` keeps no `tool_use_result` and its
result is text meant for the model, and an image in a result is not brought back.

**Where the tool compacted is kept** ([#303](https://github.com/ijun17/centralu/issues/303)). Codex's history (now
`thread/turns/list` with full items, before #342 `thread/read`) returns each compaction as a `{ type: 'contextCompaction', id }` item in the turn where it ran — a turn of its own for
`/compact`, ahead of the user's message for an automatic one (measured on codex-cli 0.147.0, 0.153.4 and 0.160.0,
`scripts/probe-codex-compaction.mts`). The reader turns it into an event line (`HistoryMessage` with
`role: 'system', event`), and the host stores that as exactly the row the live event leaves (its recorded kind,
`marker` for a compaction, the event as its payload), so the screen and the handoff pivot cannot tell a read-back
compaction or tool call from one watched live. Stored once: catching up starts after the later of our last message,
found by its words, and the last input Centralu wrote, known by the id it gave the line (`centraluInputId`, a fixed last
group that Claude Code keeps as the line's `uuid`; #1626 review: a note sent through Centralu's channel leaves no row of
its words, and anchoring on words alone attached it as the person's message). It skips each tool call or result our
record already holds, by its id, wherever it falls after that, and a compaction our record holds right after its last
message, by count (one this host saw live is in both), and attaches the rest. The CLI's own "[Request interrupted by
user]" line is not read back as a message of the person's. Where the tool keeps no id of Centralu's (Codex; a Claude Code version that does not keep it;
a transcript a crash left without it), Centralu's own Continue note is known by its exact text: the readers mark it as
Centralu's input, the catch-up anchors after it, and it is never stored as a message of the person's (a Claude read says in the
log that the CLI did not keep the id). What is left there is Codex after a crash before the agent's first words: the CLI's
lines before the note may be attached once. A Claude record keeps no compaction row (`getSessionMessages` drops system
rows), so the reader marks one where the CLI's summary stands as a user turn.

## The identity of an imported session

- The tool is sent a `resume` → the model's actual context continues.
- The screen restores the last `HISTORY_LIMIT` (200) lines → this is a **snapshot for display**.
- The restored conversation is marked `lastReadSeq = lastSeq`. Do not summon a human for a conversation they have already read.
- Which conversation was taken over is recorded in `sessions.imported_from` (schema v5).
  `external_id` cannot tell you — the tool may **issue a new identifier** when resuming,
  making it differ from the original, at which point the 'already imported' mark in the list is wrong every time.
- If the record cannot be read, the session still lives. Failing to read a record is no reason to block the conversation too.
