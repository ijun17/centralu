# Three big host files, same behaviour with less code (#1143 round 3)

Proposed 2026-11-07. The owner's rule for this round, as for `session-manager-split.md`: the same behaviour with less
code comes before anything new, and a change of behaviour is a proposal for the owner (§6), never part of a refactor.
This document audits `os/memory.ts`, `sessions/remote-agents.ts` and `mail/messages.ts` under
`packages/agent-host/src/` (§1–§3), says in what order they are done and why (§4), and lists the pull requests (§5).
A record like the rest of `plans/`, so not mirrored in Korean. Nothing on screen changes.

Measured on main at `15df9318b` (2026-11-07). Line numbers are those of that commit. `links/` is another session's
split in flight and is not touched here; §3.3 names the one place where a change there would help.

## 0. What the audit found, in one table

| File | Lines | Deletable with no change of behaviour | Same job done elsewhere | Drift (the two copies disagree) | Split by role |
|---|---|---|---|---|---|
| `os/memory.ts` | 1,729 | about 45–55 | about 40 more (`found()`, `statSync`/`lstatSync`, mode formula, detach), and about 15 against `os/real.ts` | 2 (dangling link on PATH, ctime on `fchmod`/`utimes`), both in a test fake | 7 modules, about 1,300 moved, about +150 added |
| `mail/messages.ts` | 1,392 | about 45 (three methods nothing in production calls, aliases, stale comments) | about 30 (`changedIds`, group-by, hidden check) | 1 (`turnsLost` against `sessionsStopped`), a question for the owner, not a refactor | 9 modules, about 1,250 moved, about +250–350 added |
| `sessions/remote-agents.ts` | 1,560 | about 25 | about 35 more with `start-agent-flow.ts`, `agent-start-gates.ts`, `queued-requests.ts` | 3 (start gate wording and log, `delete` against `stop`, "started here") | 3 modules, about 600 moved, about +90 added |

The split is a move, not a saving: each new module adds its host type and imports (about 20–40 lines), as D2 of
`session-manager-split.md` found. The three files do not repeat `manager.ts`'s forwarding-stub problem (no
`remote-agents.ts` public method is a stub; `MessageService` is a class its callers hold directly). So the reduction
here is smaller than there, about 5–7% of each file, and this plan puts the deletions first and the moves after.

### 0.1 How it was measured

Every file was read in full. A name is called dead only when `git grep` over `packages/`, `apps/`, `tooling/` and
`scripts/` finds no caller outside its own file and its tests, including structural use (a method reached through an
object type, a name in a string). `tsc` then proves each deletion in its own pull request: a removed name that still
has a caller does not compile. Where the only caller is a test, the test goes with it and the pull request says so.
A same-job-twice item is listed only when its two sides were compared line by line; a drift is listed only with the
exact difference.

## 1. `os/memory.ts` (1,729 lines)

The in-memory `Os` (os-layer.md): one closure, `memoryOs`, lines 279–1727. **No production file imports it.** Its
importers are `os/memory.test.ts`, `os/real.test.ts`, `os/contract.test-helpers.ts`, `os/write-file-whole.test.ts`
and two `lifecycle` tests, so a change to it cannot reach a running host. Its 40 contract cases run against the
real OS too (`real.test.ts`), which is the pin for any change that must read the same.

| Group | Lines | Shared state |
|---|---|---|
| Header, public types, node types, `fsError` | 275 | |
| Options and clock | 51 | `nowMs`, `timers` |
| Tree, holds, watch notify, `link`/`unlinkEntry` | 225 | `roots`, `inoSeq`, `openFiles`, `heldDirs`, `watches` |
| Stat, readdir, path operations | 324 | |
| Descriptors, sync/async facade, watch, `files` | 295 | `fds`, `fdSeq` |
| Environment | 51 | `vars` |
| Processes (`findProgram`, `MemoryChild`, `runSync`, `processes`) | 432 | `programs`, `procs`, `table`, `pidSeq` |
| Assembly (`launchDeps`, `memory`) | 61 | |

**Dead (proven by grep):** the double doc at 119–123; `export type { Timer }` and its import (the name is used nowhere
else); `Fd.closed` (set once, right before `fds.delete`); `Watch.errors` (nothing emits on it); `Proc.child` (never
read); the second `os: memory` at 1502; the `if (!entry)` at 1374 (`findProgram` returns only a registered program, and
`programs.delete` has no caller); the `n.kind !== 'file'` throw in `readFile` (with `follow` a `link` node is never
returned); the `windows ? 'EPERM'` arm of `fileForWrite` (`noFollow` is set only where `O_NOFOLLOW` is not 0, and it is
0 on Windows); `touch(a.parent)` in `rename` (`link()` already touches and notifies); `timers.includes(t) ? 1 : 0`.
Seven `export` keywords with no importer lose the keyword, which saves no line.

**The same job twice:** five `Found` literals in `lookupName` (a `found()` helper, about 15 lines); `statSync` and
`lstatSync`, which differ only in the follow flag; the overload pairs (`readdirSync`/`readdir`, `readFileSync`/
`readFileAsync`); the Windows mode formula in `chmod`, `fchmod` and `statOf`; the detach pair in `rename` and
`unlinkEntry`; `pidSeq` allocation and `programs.get(programKey(path))`, each written twice; `processes.run` and
`runShell`. Against `os/real.ts`: the signal gate (`signalRefusal`/`signalError`), `clock.sleep`, and the shell
choice are the same code in both, which moves to `rules.ts` / `clock` helpers and shrinks both files.

**Drift:** (1) `launchDeps().exists` counts a dangling link on PATH as present on both families, and real does only on
Windows (`presentOnWindows`), so a test on the fake finds a tool real does not. (2) `chmod` sets `ctime`, `fchmod` and
`utimes` do not. Both are a fake that disagrees with the real thing, so a fix is a contract case that fails on the
fake and passes on real, then the fix (its own pull request, §5, PR 5).

**Split (after the deletions):** `memory-types.ts` (types, constants, `fsError`), `memory-clock.ts`, `memory-tree.ts`,
`memory-ops.ts`, `memory-fds.ts`, `memory-env.ts`, `memory-processes.ts` (432 lines, ordering of `setImmediate`
ticks, `exit` before `close`, the TERM/KILL grace: moved last and byte-identical), and a `memory.ts` facade of about
120 lines that keeps `memoryOs` and re-exports the types. Not done in this round's first two pull requests.

## 2. `mail/messages.ts` (1,392 lines)

`MessageService`, the one writer of mail messages. It shares `records` (the store's `MailboxRecords`), `reach`,
`now` and the `run()` transaction with its `queued` change queue; only the stop notices have state of their own
(`oldPathsOpen`).

| Group | Lines |
|---|---|
| Header, imports, types | 158 |
| Core: constructor, `run`, `onChange`, `put`, `changed`, `row`, `checkText` | 120 |
| Send, task, `guards`, refusals | 165 |
| Reports, notices, `done` | 100 |
| Reading: `read`, `inbox`, `wakingFor`, `item`, `readable` | 120 |
| Drain and framing | 130 |
| Delivery-state writes, held, trust | 197 |
| Stops (`sessionStopped(s)`, `oldPathEnded`, the notices and their words) | 290 |
| Handoff | 70 |

**Dead (proven by grep from `src/`):**

- `turnStarted` (616–618): its only caller is `messages-drain.test.ts:208`; `records.markTurn` has no other caller and
  `markDelivered` already writes `turn_seq`.
- `feed` (516–519): only `messages.test.ts` calls it; `person.ts` calls `records.feedOf` itself; its doc cites a
  `mail.inbox` that does not exist.
- `heldByProject` (800–821): only `messages.test.ts:316,318` and `switch.test.ts:206`; `person.list()` lists held mail
  itself.
- `sweep` and `watchedTo`, each a one-line pass-through with one caller that already holds what it needs.
- `MailCalls` (a second name for `MessageCalls`), `export type { TurnNow }` (used by one test helper), and eight
  exported types that no file imports.
- Stale text: the "before slice M3a" doc at 49–51 (it is constructed in `host-mail.ts`), a second doc stacked on
  `citeKey` that belongs to `isHidden`, the "M6" and "under the name this file used before" comments, and two other
  files that cite names that do not exist (`MessageService.relationWord` in `frame.ts`, `requestsInTurn` in
  `asked-by.ts`).

A test that calls only a dead method goes with it, and the pull request lists those tests. The behaviour they pinned
is held by the callers they stood for (`person.list()` for the held list, `markDelivered` for the turn sequence).

**Kept on purpose:** `reminderSettled` and the legacy `WHY_WORDS` entries (`reminders`, `waited`, `working`,
`waiting`) read rows an older build may have written while this build was serving after a swap; the
`'budget'`/`'loop'` legacy paths are the same. Store migrations add first and remove later, and a row is read by the
build that did not write it.

**The same job twice:** the change-after-write loop (`for id: records.message(id); changed(m, …)`) five times; the
group-by `Map<string, string[]>` three times; the "hidden row means phantom" check twice; and the release-and-answer
sequence three times (`letGo`, then `settle`, then poke or announce) where `trustChanged` returns pokes and
`resumeHeld` calls `changed`. The first three are helpers that save about 16 lines. The fourth is two mechanisms for
one effect, and unifying them changes who announces: left for a later pull request that can read `person.ts`'s
compensating `announce()` at the same time.

**Drift (a question, §6):** `turnsLost` (after a crash) releases every unanswered row that is not a task as `lost`,
requests included. `sessionsStopped` (a quit or a stop) skips requests, "answered by its own turn's end". After a crash
nothing ends the request's turn, so this may be right, but nothing says so. The two loops should share one release
step either way; which result for a request is the owner's.

**Guards:** `guards()` (1105–1116) still *refuses* `repeat`, `rate_limited` and `ask_rate`; the loop, cascade, host-cap
and pair guards warn (mailbox.md D13, D32, #2014, #2035). The audit found no code that blocks agent mail beyond those
three. This round keeps them as they are and asks (§6) whether #2014 meant those three too.

**Split:** `mail-writer.ts` (core), `mail-views.ts`, `message-send.ts`, `message-read.ts`, `message-drain.ts`,
`held-mail.ts`, `stop-notices.ts`, `stop-words.ts` (pure text), `handoff.ts`; `MessageService` keeps a facade of about
130 lines. That facade is 38 delegating methods, the pattern `session-manager-split.md` §2 removes, so the callers
(`delivery.ts`, `person.ts`, `tool.ts`, `delegation.ts`, `adoption.ts`, `host-mail.ts`) would hold the modules.
#1948 (one channel) and the cross-host mail of #2067 change these same lines: the split waits until #2067 has landed,
and no module here is shaped for it.

## 3. `sessions/remote-agents.ts` (1,560 lines)

`RemoteAgents`, a parent's view of the agents it started on another machine. Twelve mutable collections (`whose`,
`pending`, `waits`, `toldDown`, `deferred`, `busy`, `endOwed`, `personHeld`, …) are shared by nearly every group, so
the gate, the waits, the held notes and the link-loss code cannot be pulled apart without passing most of them.

| Group | Lines |
|---|---|
| Types and pure helpers | 250 |
| Record store (`restore`, `records`, `save`, `forget`, `owned`, …) | 123 |
| `startAgent` and `makeChild` | 272 |
| `agentSession` (the verb) | 153 |
| Event intake (`observe`, …) | 141 |
| Gate and whose | 157 |
| Waits, held notes | 155 |
| Result builders | 88 |
| Link loss and return (`reportGate`, `settleDeferred`, `caughtUp`) | 148 |

**Dead:** `INSTRUCTIONS_WAIT_MS`, `AgentPlaces` and `RemoteAgent` are exported and imported by nobody (they lose the
keyword, no line); an orphan doc at 205 above the real doc of `toldDown`; `inTurn` from `idle.ts` is `isInTurn`
behind a cast, which this file already imports, so three casts and one import go; `'working' as SessionState` and
`'idle' as SessionState` are members of the enum already; `canClean` and `deleteAgentChild!` are one `?.` call;
`sendAtRest`'s `callerId` is always `rec.callerId`. About 25 lines and several lint-allowlist ceilings
(`no-non-null-assertion 3`, `no-unnecessary-type-assertion 3`, `no-unsafe-type-assertion 7`), which only go down.

**The same job twice:** the tail of `settleDeferred` and `caughtUp`; interrupt-then-restore in `stop` and `delete`;
`this.save(records().map(r => r.sessionId === id ? {…} : r))` seven times (a `patch(id, fn)`); the abort-plus-timer
around `askHost` (also in `start-agent-flow.ts` and `machine-asks.ts`, none `unref`'d); the machine-parse and
the `NOT_REACHABLE || NOT_CONNECTED_PHRASE` test.

**Drift, each its own pull request with a test that fails without the fix (§5):**

1. `gateError` after the card against `AgentStartGates.agentStartGateError`: the remote text says "project is not
   trusted", the local "is no longer trusted" (`start-agent.test.ts:502–530` pins the local one); and `gateError` goes
   through `autoBoundaryOpen`, which logs `[permissions] … allowed` on every send, the local check does not. Calling
   the shared check removes about 9 lines and both differences.
2. `delete` does not clear the held `queued` notes before it interrupts; `stop` does, and restores them on failure.
   The interrupted turn's end calls `scheduleDrain`, so a held note can go to a child being deleted. Narrow (`drain`
   re-checks the record), suspected, not yet shown by a test.
3. "started from here" against "started here" (`agent-session-actions.ts:123`, pinned by `delegation-flow.test.ts:436`).
   This one is wording the person reads, so it is a proposal (§6), not a fix.

**A change in `links/` that would help, not made:** `LinkedSessions.read` types `state` as `string`
(`contract/orchestrator.ts`); typing it as `SessionState` removes the last state cast at line 600.

**Not split now.** `docs/plans/turn-owned-by-no-one.md` deletes `reportGate`'s `withhold`, `tellDropped`, the paused
report and `ifBusy: 'queue'` (its P4, P6, P8), which are the gate, held-note and link-loss groups, 600 of the lines. A
move of code that is about to be deleted is wasted. The records (about 175 lines), the start path (about 310) and the
text helpers (about 120) are the three modules safe to cut, after that plan lands. The gate is security-sensitive
(RV13); `docs/agent-host.md:797,820` name `RemoteAgents.gate` and `tookInstruction`.

## 4. Where to start, and why

1. **`os/memory.ts`.** No production importer, so nothing a running host does can change, and the contract suite is
   a pin that runs against both the fake and the real OS. It has the most deletable lines of the three (about 45–55
   with no discussion, about 40 more by dedupe), none of them a decision about live behaviour.
2. **`mail/messages.ts`.** About 45 lines are proven dead and about 16 are helper-able; the live mail path is
   covered by 4,000-odd lines of tests that go through the service. Slightly riskier than the first because it is
   the live writer, and three tests that call only dead methods are deleted.
3. **`sessions/remote-agents.ts`.** The fewest lines (about 25 plus shared helpers), the thinnest tests on its start
   path, and a plan in flight (turn-owned-by-no-one) that deletes half of it. Its drifts are real bugs, so they get
   their own pull requests with tests, ahead of any move.

## 5. The pull requests

Each is a pure deletion, a dedupe or a move, with the existing tests unchanged except where §2 says a test goes with
the dead method it alone called. Line counts are measured and written in each pull request.

| # | Pull request | Files | Planned |
|---|---|---|---|
| 1 | **This document** | `docs/plans/host-big-files.md` | +about 250 |
| 2 | **`memory.ts` dead code and copies** (§1 dead, `at()`, `statAt`, `runIn`, `nextPid`, `findProgram` returning the entry) | `os/memory.ts` | −45 (landed, §5.1) |
| 3 | **`messages.ts` dead code and copies** (§2 dead, `changedIds`, group-by, hidden check) | `mail/messages.ts`, `frame.ts`, `asked-by.ts`, three tests | about −75 |
| 4 | `remote-agents.ts` dead code and `patch`/tail helpers (§3) | `sessions/remote-agents.ts`, lint allowlist | about −40 |
| 5 | `memory.ts` against `real.ts`: the signal gate, `clock.sleep`, the shell choice in shared helpers; the two drifts with contract cases first | `os/memory.ts`, `os/real.ts`, `os/rules.ts` | about −25 net |
| 6 | The start gate of a remote agent calls `agentStartGateError` (drift 1), a bug with a failing test | `remote-agents.ts`, test | about −9 |
| 7 | `delete` clears held notes before it interrupts (drift 2), once a test shows it | `remote-agents.ts`, test | about 0 |
| 8 | Moves: `memory.ts` into its seven modules; then the `messages.ts` modules after #2067; then the three `remote-agents.ts` modules after turn-owned-by-no-one | | moved, +20–40 per module |

This round stops after 1–3.

### 5.1 What landed

- **2, `memory.ts`** (1,729 to 1,684 lines; 54 added, 99 removed; the audit's "about −90" counted five items that did not
  survive a second look): the `Timer` re-export and import, the stale one-line doc above `SyncProgram`, `Fd.closed`
  (set once, right before `fds.delete`), `Watch.errors` (nothing emits on it; `on` returns the watcher), `Proc.child`,
  the second `os: memory` handed to a program, the `windows ? 'EPERM'` arm of `fileForWrite` (`noFollow` is set only
  where `O_NOFOLLOW` is not 0, and it is 0 on Windows), the `touch` after `link` in the same-entry rename (`link` touches
  the same folder), the `includes` in the timer cancel (`indexOf` of `-1` splices nothing at `>>> 0` either way), and
  `findProgram` returning the registered program so `startProcess` has no `EACCES` branch no one reaches. The copies:
  five `Found` literals through `at()`, `statSync`/`lstatSync` through `statAt`, `readdirSync` is `readdir` with its
  overloads, `run`/`runShell` through `runIn`, and `nextPid`. Left out after reading them again: `readFile`'s second check
  (it narrows the node's type, so removing it needs a cast), `rename`'s detach (`rename('.', x)` notifies today, `unlinkEntry`
  would not), the mode formula (one line saved) and the signal gate (moves to `rules.ts` with `real.ts` in PR 5).

## 6. Proposals that change behaviour (the owner decides; in no pull request here)

| Proposal | What changes | Lines | Risk |
|---|---|---|---|
| Drop the options of `memoryOs` no caller passes (`env`, `timePrecision`, `rmSync`, `now`, `cwd`, `sqlite`), fd 3 `overlapped` and `ctx.os/pid/cwd/env` | The fake's documented API (os-layer.md:519) shrinks; no production code and no test uses them | about 60 | Low |
| `turnsLost` releases requests as `lost`, `sessionsStopped` does not | Which text a request's sender reads after a crash against after a quit | about 10 once the release step is shared | Medium: a person-visible notice |
| Whether #2014 meant `repeat`, `rate_limited` and `ask_rate` to warn rather than refuse | An agent's mail that repeats or exceeds a rate would warn the person and still go | about 15 | Medium: a loop that today stops would run |
| "started from here" and "started here" in one wording | The text a model reads on a refusal | about 3 | Low |

## 7. Not in this round

Cross-host mail (#2067) comes after it. Approvals stay out of mail (they join the Inbox list); the guards warn the
person and do not block agent mail except the three above; nothing here extends keeper code (#1895 option C). Nothing
under `links/` is touched.
