# Usage and limits (FR-9)

**We ask the tool, we do not read its files.** `agents.usage` → `ToolQueries.usageFor(tool)`
→ the adapter's optional `listUsage()`, which calls the tool's own API (the Claude SDK for one,
`app-server` for the other). An adapter that cannot answer throws, and the manager degrades
with the reason attached rather than showing a confident wrong number.

**A tool that cannot report limits (#1616).** A tool whose adapter has no `listUsage()` at all is answered
`supported: false, notReported: true` with a plain reason ("<tool> does not report usage limits"). The mark is positive on
purpose: a read that failed (not logged in, a timeout) is also `supported: false`, and so is every answer of a host that
predates the mark, so only the mark tells "never" from "not now"; without it the window draws the dashed, unknown ring. The
window keeps the last answer through a call that fails (a host swap, a busy tool) and only learns why the ask failed.

**What a tool with no limits still says (#1623).** "Reports no limits" has one definition: the adapter has no `listUsage()`
(`usageFor` derives `notReported` from that and nowhere else). Cursor and OpenCode have no usage API, but their adapters have
an optional `localUsage()`, read from the tool's own command and never its credential or state files: Cursor's plan from
`agent about --format json` (`subscriptionTier`; the account's email in that output is never read out), OpenCode's local totals
from `opencode stats` (boxed tables read by their labels: sessions, messages, tokens, cost; no JSON form). `usageFor` answers
`supported: false, notReported: true` with a plain reason ("<tool> does not report usage limits") and a `usage` that carries
`plan` and `totals { scope, asOf, rows }` (additive); the donut is the dimmed one (design-system.md §10). A failed read also answers
`supported: false` but without `notReported`, which stays the unknown it is.
- *Logged out.* `agent about` prints `subscriptionTier: null` with exit 0 for an account that is not logged in; the answer is then
  the failed read every tool gives ("Cursor is not logged in on this computer", no `notReported`), and is kept ten seconds only,
  so a login a moment ago is seen.
- *Counts.* OpenCode writes the sessions and messages counts with `toLocaleString()` in the computer's language (Windows' regional
  setting; `LANG` is ignored): `1,204`, `1.204`, `1 204` (no-break or narrow no-break space), `1'204`, `12,04,567`. A count is a
  whole number, so only digit groups of exactly three behind one separator used throughout (or two and then three for the Indian
  grouping) are read; anything else is a row with a null value, shown as a dash and never as a number that may be wrong. Tokens and
  cost are `toFixed` with a suffix, not localized. The panel writes the two counts exactly, with the thousands separators of the
  person's language (`1,204`), and the token rows abbreviated (owner, 2026-10-27).
- *Cost of a read.* Each read is a process run, so the adapter's reader keeps it (`adapters/usage-read.ts`: Cursor's plan five
  minutes; OpenCode's totals a minute, or ten times as long as the last run took, so a run of twelve seconds is not started each
  minute), shares one run between askers, returns the last good answer at once while it reads again behind it (also for as long as
  a slow run takes), and does not run a failed command again for a minute. The totals carry `asOf`, the time the read ended, so a
  stale answer says how old it is (the panel writes "As of 3:42 PM", with the date for an earlier day). The readers keep the answer
  in memory; the host also keeps the last good totals in its store (`usage_local_totals`, v64: one row per tool, replaced by each
  newer read, counts only), writes them when a read ends, and hands them to the reader once after a restart (`localUsage({ seed })`).
  The reader stands on them as on a stale answer, so the panel shows them at once with their `asOf` while a fresh read goes on; a
  restart no longer needs a first slow run to show anything. Cursor's plan is not kept (a few seconds to read; it can change).
  An answer that is returned stale (after a restart, or past its freshness) is marked `provisional`: it stands in for the read going
  on behind it, so the open panel asks once more with `settle` and receives the new totals and their `asOf` when the read lands, in place
  and without polling (a `settle` waits twenty seconds at most; past that the stale answer stands and the next open finds the new one).
- *A slow command.* With no answer yet the asker waits three seconds, then gets an answer marked `provisional` (nothing known yet, or the last answer while it is read again)
  while the run goes on; a provisional answer is never kept. The open panel then asks once more with `settle: true`, which waits for
  the run in flight (twenty seconds at most) and answers what it read, so the plan or totals arrive on the
  panel without polling. `opencode stats` reads every session it has: measured on Windows with a temporary data
  folder filled with synthetic sessions (opencode 1.19.4, about 3 s for an empty database, 3.4 s for 200 sessions and 10,000
  messages, 4.4 s for 1,000 and 50,000 (190 MB), 11.3 s for 5,000 and 250,000 (1 GB)), roughly 1.7 s more per thousand sessions,
  so a database of some seven thousand sessions or more passes 15 s. The run is therefore not ended at 15 s: it has a ceiling of
  five minutes, the asker never waits for it (a `settle` waits twenty seconds at most and then answers provisionally again, the run
  going on), and a run that ends later is kept for the next ask. A run that reaches the ceiling is a failure, not started again for
  a minute.
- Measured on Windows (agent 2026.10.22, opencode 1.19.4): `agent about` 1.6 to 2.3 s, `opencode stats` 0.8 to 1.3 s; the recorded
  outputs (email replaced) are the parsers' test input.

Usage is an **account** property, not a session or directory one, which is why `listUsage()`
takes no arguments — the answer is the same whichever folder you ask from. Only subscription
limits are in scope; metered credits are not.

**With no session running (#726).** The Claude SDK puts the usage call only on a running session's query, so a host
nobody had a session on (typically a linked machine) used to answer "A running session is required to read usage" and
its meter stayed blank. `listUsage()` now starts a **probe session** for the read when none is live: a Claude process in
a temporary folder that is sent no message (nothing is billed), read until it answers (about 1.5 s measured; bounded at
20 s (a loaded machine took 3 to 8 s; the manager gives up at 15 s but the probe goes on and its answer is kept for the next ask); an SDK without the call is final at once) and stopped right after. It reads no settings files, starts no code
intelligence and, with `strictMcpConfig`, none of the person's MCP servers, and it is never lent to a model-list ask.
Its folder goes once the process has left (on Windows it holds the folder until then), and a leftover
(`centralu-usage-probe-*` in the temp folder, older than ten minutes) is swept at the first probe. An answer, and equally
a failure, stands for five minutes, so the meter's 5-minute polls start one process each at most and a broken CLI is not
retried on every poll. The meter does not poll while the window is hidden (it asks at once when it is shown again after
a skipped tick) and asks only the tools `agents.detect` reports usable on that machine. Not logged in: no probe, the
reason says so. Codex already reads usage with a short-lived client
and has no such gap.

**Same account on the hub and a linked machine (#726).** Each host answers `agents.account { tool }` with a fingerprint
of the login it sees (`claude auth status --json`: a hash of the organisation id and the lower-cased email; the
organisation alone would equate a team's members, who each have limits of their own). Only the hash leaves a host, never
the email. When the hub's and the machine's fingerprints are equal, the hub answers `agents.usage { machine }` with its
own limits and `sameAccountAsHub: true`, and asks the machine only for its prompt cache figures (`limits: false`), since
those count the machine's own requests. Otherwise, or when the machine's host predates `agents.account`, the machine is
asked as usual and probes if it has no session. The screen says "Same account as this computer", or the one-line reason
when no reading could be made, in place of a blank meter.

This section used to describe something else entirely: a chokidar watcher parsing
`~/.claude/projects/**` and `~/.codex/sessions/**` incrementally, writing `usage_facts` rows
that a `usage.weekly` RPC would read, with aggregation in `core/usage`. **None of it exists** —
chokidar is not a dependency, `core/usage` holds only the cache arithmetic of [prompt-cache.md](prompt-cache.md), there is no `usage.weekly`
method, and no build ever wrote a row to `usage_facts`. The table is gone from `schema.sql`, and store step 56
drops it from an existing store (#423; a contract step, [store-migrations.md](store-migrations.md#migration-steps-expand-then-contract-292) rule 2, one release after the last that deleted a
project's rows from it). It was
also the *opposite* of the rule [importing-sessions.md](importing-sessions.md#principle-use-only-official-apis) states, and the two sections sat in one document
contradicting each other. Reading a tool's private JSONL is exactly what [importing-sessions.md](importing-sessions.md#principle-use-only-official-apis) forbids, for
the reason given there: an undocumented format breaks silently on upgrade, and a silent break
in a number is worse than a missing number.

## Usage over time (#1452)

Two records, both from what the host is told or asks the tool itself (the rule at the top of [Usage and limits](#usage-and-limits-fr-9), never the tools'
files), kept in `store.db` (v62) and **local to this computer: never synced, and a linked machine keeps its own**.
Counts, percentages and names only: no content.

- **Limit readings** (`usage_readings`: `at`, tool, account, window, percent, `resets_at`). A reading is every fresh
  answer `agents.usage` gets from a tool (`ToolQueries.usageFor`), whoever asked: the gauge, a turn end or the timer. Besides the
  gauge's own polls, a turn end asks (at most every 2 minutes per tool) and a timer asks every 10 minutes for each tool that has a
  live session here; a tool with no session is not started up just to be looked at. A window that reads as it did last time writes no row: the same percent and a reset time within a minute (Claude derives the reset
  time from a relative one, so it moves by a few hundred ms on every read of an unchanged window). `account` is the `agents.account` fingerprint (looked up at most every 10 minutes), empty
  when the tool does not say; a model-scoped window keeps its `scope`. Claude's `rate_limit_event` carries no percentage (only a
  rejection), which is why a turn end asks instead of reading it.
- **Tokens per hour** (`usage_buckets`): the requests `CacheLedger` already counts ([prompt-cache.md](prompt-cache.md)), added up by `UsageRecorder`
  (`sessions/usage-recorder.ts`) into one bucket per hour, session, project, tool, model and machine (`''` for this host's own
  requests): requests, uncached input, cache read, cache write (and the part of it the API said stays cached 5 minutes or an hour,
  `cacheTtl`, and since #1492 the API's own split of the writes into one hour and five minutes), output, the rebuilds by cause and what the rebuilds wrote (`rebuild_tokens`, v63). Buckets are written once a minute and at drain (`disposeAll`), one
  upsert each that **adds** to the row, so a restart or a swap midway through an hour only adds. A write that fails keeps the buckets
  for the next minute. The model comes from the request when the tool says which served it (Claude's `message.model`, so a subagent or a fallback on
  another model is counted under its own), else from the session's setting (Codex: `by: model` is then the session's configured model, a known limit).
  Output comes from the request's own usage where the tool reports it per request (`RequestInput.outputTokens`: Codex's `last.outputTokens`).
  **Claude's comes from the stream's `message_delta`** (#2135): an assistant message carries only the count the stream started with (a few tokens), so the
  normalizer holds a streamed response's request until its `message_delta` brings the final count (`heldRequest`), and lets it go without output when the
  next response starts, the turn ends (a stopped stream) or the process ends first. The request's time is then the end of its stream, not its first
  message, so the idle gap the ledger measures ([prompt-cache.md](prompt-cache.md)) shifts by the difference of two responses' lengths, as it already did by their thinking. A subagent's responses are not streamed, so its requests still have no output, and a
  response that arrives whole (no `message_start`) is carried at once without one. Buckets before the fix have `output` 0 for Claude; `usage_history`
  prints `out n/a` for a row with no output rather than `out 0`, which an agent would take as fact.

| Decision | Reasoning |
|---|---|
| Keep 90 days, pruned when the host starts and once a day | An hourly row is small (a few hundred bytes; a busy day is a few hundred rows), and weeks are what "did a change save tokens" needs. Prune deletes buckets whose hour began, and readings taken, more than 90 days ago |
| A purged session's buckets go with it (in the purge's last transaction, `TrashRecords.purgeSession`); a trashed or archived session's stay | Purging is the only deletion that is for good: a session in the trash can come back, and an archived one is still the person's. What is not yet written for it is dropped too (`UsageRecorder.forget`), so a later flush cannot bring the rows back. A deleted *project* leaves its rows, named by id |
| Local only, never synced; a linked machine records its own | Per-session counts say what the person worked on and when. Nothing here goes anywhere but to the person's own window; the hub asks a machine through the existing routing (`usage.history { machine }`, route `machine`, the session and project ids in the answer qualified like any other) |
| Hourly buckets, summed to days in the host's local time at the question | One shape serves the day and the hour axis. A range that begins inside an hour takes that hour whole. In a time zone that is not a whole number of hours from UTC (India, +5:30) a bucket straddles local midnight and goes to the day it began in |
| At most 50 keys per answer, the rest folded into `*` ("Others") | A range of many sessions stays one small answer, and the biggest are never folded. The sessions of no project are `none` ("Assistant") |
| No alert line yet ("the weekly window will run out before its reset at this pace") | The issue asked it as a question. The readings are what such a line needs; the rule for the pace is a decision of its own, a named follow-up |
| A purged session leaves nothing | At start the host also deletes buckets whose session no longer exists (`UsageRecords.sweepOrphans`): a build older than this one that purged a session during a swap leaves them. A trashed session still has its row, so its buckets stay. A purge also takes the session out of the in-memory cache figures (`CacheLedger.forget`), so no window names it with an empty name |
| A linked machine on the hub's account (`sameAccountAsHub`) | The hub's limits stand for it, so the hub's readings are its readings; the machine still has its own token buckets, which the hub reads with `machine`. One list merging several machines' rows is a named follow-up: the dropdown asks one machine at a time, as the gauge does |

**Asking.** `usage.history { from, to, groupBy: 'day' | 'hour', by: 'session' | 'project' | 'model' | 'tool', tool?, machine? }`
is read-only (routed as `machine`, like `agents.usage`) and answers `{ by, readings, rows, recordedSince? }`: the readings in the
range (and for each series the last one before it, since a reading is stored only when it changes) as one series per tool, account and window, and rows of tokens per period and key (`UsageHistoryRow`: the sums above and
`rebuildCauses`). `recordedSince` is the oldest hour kept, so a screen can say that earlier days are not known. The same answer
reaches the Assistant as the rare command `usage_history { days?, by? }` (behind `centralu_run`, so it costs nothing in every
request; the Assistant's alone; it answers the top 15 keys and each window's movement in a few lines), which is how an agent
checks what its work cost. An ordinary session does not get it: its resident tools are budgeted per request ([tool-profiles.md](tool-profiles.md)).

**The screen.** The usage dropdown ends with "Last 7 days" (`features/usage/HistorySection.tsx`): the weekly window's percent as a
step line (drawn from a day of readings on; less is a dot at the edge, so only the figure shows) from the readings (the window `weeklyWindow` would draw, of the account read last) and the five sessions or projects (a
switch) that used the most tokens, each with its cache hit rate (`topUsage` in `@cc/core`). A host that predates the question
leaves the section out.
