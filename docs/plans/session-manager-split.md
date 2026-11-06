# Splitting `SessionManager` by role (#1143 part 1)

Proposed 2026-10-31. The owner's rule for this round: the same behaviour with less code, not only moved code. This
document measures `packages/agent-host/src/sessions/manager.ts` (§1), says what each kind of code in it becomes (§2–§4),
the shape it ends in (§5) and the pull requests that get there (§6). Changes of behaviour that would shrink it further
are listed for the owner to decide (§7) and are not in any pull request here. A record like the rest of `plans/`, so not
mirrored in Korean. Nothing on screen changes.

Measured on main at `9f1d57cba` (2026-10-31). Line numbers are main's. Paths are under `packages/agent-host/src/`
unless they say otherwise.

## 1. What is in the file

### 1.1 How it was measured

A script over the TypeScript language service, run against the root `tsconfig.json`, lists every member of the class
(83 fields, 216 methods, the constructor). For each member it records the line span with its doc comment, the `this.`
fields it reads and writes, the manager methods it calls, and `findReferences` grouped by file (the manager itself,
other source, tests). A member whose body is one call is a pass-through. One whose doc says "kept on the manager for its
callers" is a forwarding stub left by the first round. The language service misses structural use: `agent-versions.ts`
calls `deps.sessions.noteAgentMoved?.()` on a manager passed in as `sessions`, and `inline-views.ts` takes
`mgr: { sessionAppsHub(); recordAppView() }`. So every member with no reference was also checked by reading its call
sites, and each deletion below is proven in its pull request by `tsc`. A removed name that still has a caller does not
compile.

### 1.2 The numbers

3,204 lines:

| What | Members | Lines |
|---|---|---|
| Imports, exported types (`MailHooks`, `KeptAgent`, `ManagerParts`, …), re-exports | | 186 |
| Fields | 83 | 218 |
| Constructor (wiring the modules, the restore at start) | 1 | 271 |
| `parts()`: what the moved-out modules reach of the manager | 1 | 376 |
| `seat()`: what the orchestrator tools reach of it | 1 | 61 |
| Forwarding stubs (`x(...a) { return this.<module>.x(...a) }`) | 116 | 467 |
| Other one-call methods (`listSessions`, `sessionInfo`, the `use*` setters, …) | 23 | 122 |
| Methods with logic | 75 | 1,274 |
| Blank lines between members | | 229 |

### 1.3 Why it is big again

The first round (#1277–#1281, #1294–#1298, 2026-10-19 and 20) took it from 3,167 to 2,473 lines. Each method it moved
left a stub behind, and every module's host was added to `parts()`. By 2026-10-31 it was back at 3,204: 32 commits added
816 lines and removed 85. The largest were mail (#1413, #1446, #1473, #1511, #1516: 274 lines), the turns an update cuts
(#1626: 147), usage history and compaction (#1483, #1478, #1504: 111). New logic landed in the manager because the state
it needed lives there. The stubs and `parts()` grow with every module, so moving code out without deleting the stubs
leaves the file about as long.

## 2. The forwarding stubs (467 lines)

A stub exists only so a caller can write `mgr.x()` instead of `mgr.<module>.x()`. The caller then has two places to
read, and every new method of a module adds five lines here. The rule from here on: **a caller calls the module that
does the work.** The manager makes such a module a public `readonly` field, and the stub goes.

Who calls the 116 stubs (lines here and in §6 count the blank line after each stub, so the 467 of §1.2 are 583):

| Callers | Stubs | Lines | What deleting it touches |
|---|---|---|---|
| `rpc.ts` only, or the manager itself; no test | 50 | ~250 | `manager.ts`, `rpc.ts` |
| `main.ts`, a script or a structural type, no test | 5 | ~25 | also `main.ts` (`noteAgentMoved`, `noteAgentMoveFailed` through `AgentVersionService`; `sessionAppsHub`, `recordAppView` through `attachInlineViews`; `loadSubagentMessages` from `packages/agent-host/scripts/probe-subagent-record.mts`) |
| A test calls it, or reaches it by cast | 61 | ~308 | the tests (decision D1) |

The 50 by module: `ProjectFiles` 17 (git panel B-1, file tree and viewer C-1, file operations #19), `SessionTrash` 7,
`ProjectRegistry` 6, `SessionAppWiring` 4, `SessionSettings` 1 (`markRead`), `SessionLayout` 2, `UiPreferenceStore` 2,
`SessionRecord` 2, `ToolQueries` 2, `AppSessions` 2, and one each of `ApprovalRules`, `HostCards`, `ProjectCreation`,
`ToolRegistry`, and the private `SessionEvents.onEvent`, which only the manager calls. The private `deliver` is like it,
but `start-agent.test.ts:711` reaches it by cast, so it is counted with the tests.

The 61 a test reaches are mostly the session's own verbs: `orchestrator` (299 test references), `agentSession` (282),
`runOrchestratorTool` (184), `createSession` (179), `startAgent` (174), `askProject` (105), `observeLinked` (110),
`updateSettings` (78), `setUiPreferences` (74), `trashSession` (70). Under "tests unchanged" they stay until the owner
decides D1.

The same pattern is in two modules of the first round: `sessions/delegation-flow.ts` keeps 19 stubs ("kept on the flow for
its callers") and `sessions/start-agent-flow.ts` 16. The rule applies to them too; they are not in this plan's pull requests.

## 3. `parts()` and `seat()` (437 lines)

`parts()` is one object of getters and forwards that every moved-out module gets as its host. Of its about 110
`(...a) => self.<x>(...a)` entries, 42 forward to a module `parts()` already exposes by a getter (`queue` 8, `reports` 7,
`delegationFlow` 6, `cards` 3, `hostCards` 3, `appSessions` 3, and 12 more), and 40 forward to a manager method, many of
them stubs. `seat()` repeats 21 entries of `parts()`.

- A forward to a stub is pointed at the module when the stub goes (§2).
- `seat()` can be `parts()` plus its own entries (`Object.create(this.parts())`, so the getters still run when read):
  about 29 lines. `orchestrator-seat.ts` keeps `OrchestratorSeatHost` as it is.
- The 42 forwards to an exposed module could go if each module read `host.queue.busyAnswer()` instead of
  `host.busyAnswer()`: about 56 lines, but each module's host type and any test that builds a fake host change. That is
  done module by module, and only where no test builds the host by hand.

## 4. The logic, grouped by the state it shares

A group counts its members with logic (1,274 lines in §1.2), its one-call methods (122) and the fields it owns, so the
groups add up to more than either row of §1.2.

| Group | Members | Lines | Owns | Reads of the shared state |
|---|---|---|---|---|
| Processes: resume, sleep, restart, switch tool, fork, idle | 16 | 388 | `sleeping`, `resuming`, `leaving`, `running` | `handles`, `meta`, `restartPolicy`, `externals`, `record` |
| Host tenure: adopt kept processes, the turns an update cuts, quit notices, dispose, detach | 28 | 315 | `updateCuts`, `continuedAfterUpdate`, `updateLists`, `stoppingForUpdate`, `disposing`, `handingOver`, `quitNotices`, `quitPersonWork`, `sweepingHandles`, `keptAtStart`, `adoptedProcesses` | every module (`leaveHost`) |
| Turn inputs: send, approvals, answers, interrupt | 13 | 210 | `agentRuns`, `turnObservers` | `meta`, `hostCards`, `approvalRules`, `children`, `reports` |
| The mailbox's view of sessions (`mailSessions`, `workClosed`, `mailReceiver`, `readsMail`, `mailSeats`, …) | 12 | 170 | `mailHooks` | `meta`, `children`, `handles`, `events`, `disposing`, `handingOver` |
| Project coordinators (`deleteProject`, `setProjectTrusted`, `sessionsMovedToProject`, `cwdFor`, `worktreeStatus`) | 5 | 144 | | five modules each |
| Late setters from `main.ts` (`useMachineList`, `useMemoryGate`, `useLinkedReader`, `useUpdates`, …) | 16 | 71 | the injected services | |
| Session lookup (`listSessions`, `sessionOf`, `requireHandle`, `openSession`, …) | 10 | 58 | | `meta`, `handles` |
| Usage (`startUsageHistory`, `usageHistory`, `autoCompactFor`) | 3 | 31 | | `usageRecorder`, `cacheLedger` |
| Machine asks | 5 | 28 | | `machineAsks` |

Shared by every group, so it stays on the manager and is read through getters, never copied: `meta`, `handles`, `emit`
(re-wrapped in the constructor), `store`, `adapters` and the module objects.

Duplication and dead code found by reading this logic (a second model's audit, each item then checked against main):

- **Dead, about 20 lines:** `parts()`'s `get appAccess` and `UiPreferenceStoreHost.appAccess` (nothing reads them);
  `parts()`'s `untilHandedOver` (`AskProjectHost` picks it, `ask-project-flow.ts` never calls it); the re-export of
  `AppMessageSource`, `AppMessageVia`, `AppViewPlace` (imported from `app-messages.js` everywhere); three stale comments
  (lines 175–180, a fragment of a doc whose full text is `stampExternalSynced`'s in `external-conversations.ts`;
  2909–2916, a doc of a method that is gone; 554, about a cleanup store step v55 now does).
- **The same code twice, about 15 lines:** `hasCompactTool` in the constructor and `canReadMail`; the
  `selfCompaction`/`contextNudges` lambdas in the constructor; the two `stop()` calls in `disposeAll` and `detachAll`,
  which become a call to `stopSelfCompaction()` (the same two calls); `tellPersonOfInterruption` and `updateResumeDone`, one-line helpers inlined
  at their callers.
- **Checked and not duplicates:** `worktreeStatus` and `worktree-sessions.ts` (different fallback); `searchMessages`
  and `orchestrator-seat.ts` (a window of 60 against 160); the withdraw tests in `deleteProject` and
  `setProjectTrusted`; the process teardown in `switchTool`, `restartSession` and `sleepSession` (each differs in what
  it stamps and in what order).

Moving a group out does not make the code smaller: a new module adds its host type and imports (about 20–40 lines).
It is worth it where the group changes for its own reason and conflicts with other stacks. The mail group and the turn
inputs are; processes and host tenure are too, but they are race-sensitive (#839, #568, #163) and touch what the
session core changes (§6.2).

## 5. The shape it ends in

`SessionManager` stays the one object the RPC router, `main.ts` and the tests hold. It keeps:

- the wiring: the constructor, `parts()` (smaller), the `use*` setters, the module objects as fields;
- the session lookup and the state every group shares (`meta`, `handles`, `emit`);
- the coordinators that cross groups (`deleteProject`, `setProjectTrusted`) and the session's own verbs that tests use
  (`createSession`, `send`, `startAgent`, …, decision D1).

It loses the stubs, the dead code and the copies above. A module the router reaches is a public `readonly` field
(`mgr.files`, `mgr.trash`, …), so the reader goes from the RPC method to the code in one step. No new layer is added:
the modules exist already.

Expected size: the deletions of §2 (without the test-held stubs), §3 and §4 take about 400 lines out of the file and
out of the code base. The moves of §4 then take about 1,080 more out of the file, into modules of their own, leaving it
near 1,700 lines. Deleting the test-held stubs that are not the session verbs of D1 would take about 270 more.

## 6. The pull requests

Each is a pure deletion or a pure move. Existing tests stay as they are. `tsc` proves a deletion has no caller left.

### 6.1 Order

| # | Pull request | Files | Lines out of `manager.ts` | Collides with |
|---|---|---|---|---|
| 1 | **This document; the 17 `ProjectFiles` stubs**: the router calls `mgr.files.*` | `manager.ts`, `rpc.ts` | 85 | nothing |
| 2 | **Dead code and copies** of §4 | `manager.ts`, `ui-preferences.ts`, `ask-project-flow.ts` | ~35 | nothing |
| 3 | **The other rpc-only stubs** (33: trash, project registry, layout, preferences, record, tool queries, app sessions, approval rules, host cards, project creation, tool registry, `markRead`, `onEvent`), with the `parts()`/`seat()` entries that called them | `manager.ts`, `rpc.ts` | ~165 | nothing |
| 4 | **`seat()` on `parts()`** | `manager.ts` | ~29 | nothing |
| 5 | **The stubs `main.ts` reaches** (5, §2): `main.ts` passes the module instead of the manager to `AgentVersionService` (`sessions: mgr`) and `attachInlineViews` | `manager.ts`, `main.ts`, `agent-versions.ts`, `inline-views.ts`, the probe script | ~25 | key pairing (#1711) edits `main.ts`: after its slices land |
| 6 | **The mailbox's view of sessions** moved to `sessions/mail-sessions.ts` | `manager.ts`, new file | ~170 (moved) | nothing in flight |
| 7 | **Turn inputs** moved to `sessions/turn-inputs.ts` | `manager.ts`, new file | ~210 (moved) | nothing in flight |
| 8 | **`parts()` forwards to exposed modules**, module by module where no test builds the host | `manager.ts`, the modules | ~56 | depends on the module |
| 9 | **Processes** moved to `sessions/session-processes.ts` | `manager.ts`, new file | ~390 (moved) | the session core (#1654) PRs 6–9 |
| 10 | **Host tenure** moved to `sessions/host-tenure.ts` | `manager.ts`, new file | ~315 (moved) | the session core (#1654) PRs 6–9; touches every module, so last |

### 6.1a What landed

Manager line counts are after each pull request.

- **2, dead code and copies** (`manager.ts` 3,119 to 3,063): the re-export of the app-message types, `parts()`'s
  `appAccess` and `untilHandedOver` (and their host types' members), three stale comments, `hasCompactTool` through
  `canReadMail`, the two `stop()` pairs through `stopSelfCompaction()`, one `setting` and `notice` for both compaction
  modules, `updateResumeDone` and `tellPersonOfInterruption` inlined, and `nameUnnamedWorktrees` (§7: old rows still
  named "New session" stay so, by the owner's removal of old-version compatibility, #1143).
- **3, the forwarding stubs** (`manager.ts` 3,063 to 2,713): 70 stubs, the rpc-only ones and, by decision D1, the ones
  tests call, except the session's own verbs (`createSession`, `startAgent`, `agentSession`, `askProject`,
  `orchestrator`, `runOrchestratorTool`, `updateSettings`, `rename`). The router, the other modules and the tests call the
  module (`mgr.trash.restoreSession`); the module fields they need are public `readonly`. Still on the manager because
  `main.ts`, `links/` or `adapters/` call them (those files are out of this round): `addProject`, `askFromMachine`,
  `builderBusy`, `forgetWatchHolder`, `forwarding`, `hostReader`, `listProjects`, `loadMessages`, `mcpProposals`,
  `observeLinked`, `remoteAgentParent`, `sendFromHub`, `setAgentInstructions`, `setUiPreferences`, `toolProfileOf`,
  `trashSession`, `uiPreferences`, `useExternalApps`, `useLinkedApps`, `useLinkedSessions`, `useProjectsHome`, and the five
  of PR 5 (`noteAgentMoved`, `noteAgentMoveFailed`, `sessionAppsHub`, `recordAppView`, `loadSubagentMessages`). So
  "five stubs reach `main.ts`" in §2 was low: 21 more do.
- **4, `seat()` on `parts()`** (`manager.ts` 2,713 to 2,698): the 20 entries `seat()` repeated are gone; it is its own entries
  standing on the `parts()` object as prototype, typed so a missing one does not compile. `proposals` and `linkedReader`
  stay its own (the seat reads them with a wider type than `parts()` gives). A prototype, not `Object.assign`, which would
  read the `proposals` getter once and keep the value; the small `stands` guard says the type without an assertion
  (the assertion ceiling only goes down).
- **8, `parts()` forwards to exposed modules** (`manager.ts` 2,698 to 2,690): only 8 of the 42, far fewer than the ~56 lines
  the plan counted, because a hand-built host stops the rest: a test builds the host of `AskProjectFlow`, `DelegationFlow`,
  `RestartPolicy`, `SessionTrash`, `HandoffFlow`, `ChildReports`, `LinkedReports`, `RemoteAgents`, `HostCards`,
  `AppSessions`, `SessionEvents`, `WorktreeSessions`, `ChildOwnership` and the orchestrator seat, and the shared
  `DelegationHost` is in most of them. Done where no test builds the consumer: `dropOpenedByAuto`, `withdrawReaches`
  (`queue`), `isAppAgentSession`, `requireAppAccess` (`apps`), `appHostData`, `runAppAgent`, `agentRunEnded`
  (`appSessions`) and `askCapability` (`hostCards`); `HandoffChildren`, `ProjectConsents`, `RoutedCards`, `LaunchInputs`,
  `UpdatesAsked`, `SessionTools` and `SessionAppWiring` read the module off the host. The other 34 wait for a pull request
  that also rewrites those tests' hosts.

### 6.2 Work in flight

- **The shared session core (#1654).** Its PRs 6–9 (PR 5 is in flight on its own branch) change `adapters/` and `adapters/core/` (the ledger, the decision
  order, events). The manager's process code (`switchTool`, `restartSession`, `sleepSession`, `handleSink`) and host
  tenure (`adoptKept`, the swap and dispose paths) read what those PRs reshape: `SessionHandle`, the sink, adopting a
  kept process. PRs 9 and 10 here wait for them. PRs 1–8 do not touch `adapters/`.
- **Key pairing (#1711).** Its branches edit `links/` and `main.ts`. Only PR 5 here touches `main.ts`, so it waits.
- **#1334** (an app hears of its project's sessions, open since 2026-10-20) adds 15 lines to `manager.ts` and edits
  `session-app-wiring.ts`. PR 3 removes `SessionAppWiring` stubs near its hunk. A rebase there is a few lines.

### 6.3 Keeping it from growing back

New logic goes into the module whose state it uses, or a new one, and the manager gets one field and its wiring. A
method the router needs is called on the module, never through a new stub. A size budget for `manager.ts` in a guard
test would hold this by structure; it is not proposed here because a guard is deep-tier tooling and the rule may be
enough once the stubs are gone.

## 7. Proposals that change behaviour (the owner decides; in no pull request here)

| Proposal | What changes for the person | Lines saved | Risk |
|---|---|---|---|
| Drop `createWorktreeManager` and the `worktrees.createManager` RPC (`rpc.ts`, `links/routes.ts`, `method-rights.ts`, protocol) | A window from before #561 gets "unknown method" instead of an explanation; no window of today calls it | ~18 | Low |
| Drop `nameUnnamedWorktrees` (run at every start) | New worktree sessions are already named after their branch at start (`session-start.ts:256`); old rows still named "New session" stay so | ~21 | Low |
| `dropWildcardApprovalRules` as a one-time store step instead of at every start | None, once the step has run | ~3 | Low (store migrations: add first, remove later) |
| `cwdFor`'s fallback for rows from before store v14 as a store step filling the folder once | None, if every old row gets a folder | ~3 | Medium: a row the step misses would break |
| Treat a process adopted after a swap like any other for mail (`readsMail`, `adoptedProcesses`) | A kept process would get reports by mail instead of as a relayed message | ~10 | Medium: changes every adopted process, `report-mail.test.ts` pins today's |

## 8. Decisions for the owner

| # | Question | Default taken until decided | Why |
|---|---|---|---|
| D1 | The 61 stubs a test reaches: keep them, or one pull request that rewrites the tests' calls (`mgr.restoreSession(` to `mgr.trash.restoreSession(`) with no assertion changed? | Keep the 8 that are the session's own verbs (`createSession`, `startAgent`, `agentSession`, `askProject`, `orchestrator`, `runOrchestratorTool`, `updateSettings`, `rename`); the rest stay until decided | The verbs are the session API the tests read as a contract. The other 53 (trash, preferences, consents, linked host, orchestrator slot, handoff notes, …; about 270 lines) are not, but rewriting them changes test files, which this round's rule keeps unchanged |
| D2 | The moves of §4 (PRs 6, 7, 9, 10) add about 20–40 lines each. Do them, or stop after the deletions? | Do the deletions first; decide on the moves when PR 5 has landed | The moves serve merge conflicts and reader load, not size. Whether they are still needed can be read from how often stacks conflict on `manager.ts` once it is about 400 lines shorter |
