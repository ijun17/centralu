# Task ledger (#1173): the app and the three core pieces it needs

A plan, kept as it was decided (2026-10-20; the owner's trust decisions of 2026-10-18 apply). Built in two stacked pull requests: piece 1 (`watch_sessions`), then the app. Pieces 2 and 3 are design only until reviewed. `docs/apps.md` §10 describes what is built.

Written 2026-10-20 against main at `2c6a8d12`. I read this issue and its two decisions (trust follows the project), #314, #315, #1161, `docs/apps.md` (§3, §4, §10, §13), the broker (`broker.ts`, `desk.ts`, `notices.ts`, `app-start-env.ts`), the session state rules (`protocol/session-state.ts`, `session-events.ts`) and the project board app. The build follows in two stacked pull requests (§10); everything marked *design only* waits for review.

### 0. What the code already gives, which changes the shape

Two of the three core pieces are partly there:

| Piece in the issue | What main has | What is really missing |
|---|---|---|
| 1. Apps observe session state | `host_data("sessions.list")`: a snapshot, only inside a tool call (needs a run id), asks the person once | Any way to *hear* a change, outside a call. This is the one real gap |
| 2. Apps wake on a timer | `uses.background` + `centralu.busy()` (#1236): the app runs its own `setInterval`, the host keeps the process alive and starts it again after a host restart | A wake for an app that is **not** holding busy, and a restart after a crash (a crash drops the hold, `docs/apps.md` §4 "Crash") |
| 3. Apps send a message to a session | `notify` (#1258): `uses.notices`, no run id, a signed address that survives a swap, shown as the app's message, wakes an idle session, 10 a minute, every one a run row | Naming a session that **never called** the app: one the person picked, the orchestrator, an assignee |

So the ledger can be built and used on **piece 1 plus what exists**; pieces 2 and 3 are narrower than the issue says, and I design them as small extensions, not as new subsystems. That is why (a) below is the only core change I build now.

### 1. The task model and where it is kept

One ledger per project: an app of that project (`.centralu/apps/task-ledger/`), one file in the app's data folder (`ledger.json`, outside the repository, atomic write, one writer: the app process).

```
Task      id "T12" (per-project counter, never reused)
          title ≤200, state, blockedBy[] ≤5, next ≤300, notes ≤4000
          issue: number|null            the linked GitHub issue
          assignee: { sessionId, name }|null   name kept so a gone session still reads
          stateSince, createdAt, updatedAt, seenSeq (see §5), doneAt
state     ready | running | review | queued | blocked | done      (done is not in the issue's list; a task has to end somewhere and be undoable for 14 days)
blockedBy { kind: issue|pr|decision|text, ref: number|null, text }
          issue    resolved when the issue is closed
          pr       resolved when merged (closed unmerged: stays blocked, shown "closed without merging")
          decision resolved by a comment starting "Decision (owner" written by the repository's owner or a login in `github.deciders` (corrected after review: the first version took anyone's comment, or the issue closing)
          text     "Mac only": resolved only by a person
Settings  responsible: { sessionId, address, label }|null   one per project
          quietMinutes (30), sweepMinutes (10), github: { on, repo }
```

- A task **needs attention** when any of the four triggers of §5 holds; the panel lists those first and the app notifies once per change.
- State changes are the responsible session's or the person's, never guessed by the app, with one exception: when the last blocker resolves, `blocked → ready` (that *is* trigger 3).
- Why a file in the data folder, not the host store: rule 7 of the app template (state lives in the app's data folder), no store migration (the deep tier, and a step an older build serving the same store must survive), and the ledger can be removed with its app. Unknown fields are kept on read and written back, and the file has a `version`, so a later build and an earlier one can share a data folder across a rollback.
- Why not committed to the repository: a task's assignee is a session on this person's machine, and the file changes every few minutes.

### 2. Sync with GitHub issues (optional, one way in, no way out)

Off by default (`github.on`); a project without GitHub never sees it. On, it uses the person's own `gh` like the board app does (no token stored, asks Centralu for nothing); `gh` missing or logged out is a line in the panel, never an error.

- **In:** a linked task takes its title and its closed state from the issue. Everything else (state, next, notes, assignee) is the ledger's and is never overwritten. Open issues that are not linked are **offered** in the panel ("14 open issues not in the ledger", Add / Add all), never imported by themselves: a repository has hundreds, and a ledger that fills itself is not a plan. A closed linked issue moves its task to `done`; a reopened one moves it back to `ready`.
- **Blockers:** `issue`, `pr` and `decision` refs are re-read each sweep with at most three `gh` calls (one `issue list`, one `pr list`, one `issue view` per decision), so ten minutes of lag at worst for news that comes from GitHub. News from sessions is immediate (§4).
- **Out:** nothing. The ledger does not write labels, close issues or set the board's Status. "Create an issue from a task" goes through the board app's `file_issue`, because that tool carries the rules (English only, the private word list); a second path to GitHub would skip them. Two-way state sync would need a conflict rule for every field and buys little: the board already shows Status.

### 3. The panel on the project screen

No new host spot. An app with a `home` view already stands as a panel on its project screen (`docs/apps.md` §6.2: drop the app's sidebar row on the screen; the pinned view fills the panel). The ledger recommends `view.span` 2×2 and works at 360 px (narrow first, §6.6). I do not touch the sidebar or Settings.

```
Responsible: [ orchestrator ▾ ]    ● watching     ⚙ GitHub
 NEEDS YOU                                                  (the four triggers, oldest first)
  T12  Fix login            ready · nobody is assigned                       [Assign ▾]
  T9   Landing queue        ◐ idle, new answer 4 min ago                     [Review]
 RUNNING   T7 Mac checks    ◉ working · next: run the e2e specs        ← assignee's live state, from the observation
 REVIEW / QUEUED / BLOCKED (chips: #1290 open, "Mac only")      READY       DONE (collapsed, 14 days)
 [ + add a task ]      [ 14 open issues not in the ledger ▸ ]
```

Everything is inline-editable (title, state, next, notes, assignee from the project's observed sessions, blockers). The panel says plainly when the ledger is not watching (no Centralu support, process stopped) and when nobody is responsible ("nobody will be told"). It calls only the app's own tools; an agent calls the same ones (`ledger_list`, `ledger_add`, `ledger_update`, `ledger_assign`, `ledger_take_charge`), one code path as for every app.

### 4. Events and the safety sweep

Events first; the sweep only makes sure a missed event is found.

| Event | Source | Reaction |
|---|---|---|
| A session of the project changed (state, a question waiting, a turn ended, name, gone) | core piece 1, a long-poll | re-evaluate that session's tasks: triggers 2 and 4 |
| A tool call (agent or panel) | the ledger's tools | re-evaluate that task: triggers 1 and 3 |
| An issue or PR was filed, opened, queued | the board app, `call_app` from its tool (§7) | re-read just those numbers now |
| Every `sweepMinutes` (10) | the app's own interval, held by `busy` | full snapshot of the sessions (no cursor), `gh` refresh, all four triggers over all tasks, prune |
| The app starts (host restart, swap, crash recovery) | start | the same as a sweep |

The sweep is idempotent: it computes the same *keys* (§5) the live events compute, so it sends nothing an event already sent, and finds what an event missed (a cursor lost in a swap, a stopped app, a closed issue). `busy` is held while any task is not `done` ("watching 6 tasks"), so the person sees on the app's row why it runs, and can stop it.

### 5. Notification rules: once per change, four triggers

A notification is **keyed by the change that caused it**, written to the ledger file *before* it is sent. The same key is never sent twice, across sweeps, restarts and a swap.

| Trigger | When | Key |
|---|---|---|
| 1 `unassigned` | state `ready`, no assignee | `unassigned:<task>:<stateSince>` |
| 2 `answer` | the assignee is at rest (`idle`/`waiting_input`/`error`/`limited`) and its `lastSeq` is above the task's `seenSeq`; or it stopped on a card (`waiting_approval`, a question) | `answer:<task>:<session>:<lastSeq>` / `asking:<task>:<session>:<waitingSince>` |
| 3 `unblocked` | every blocker resolved (the task goes `blocked → ready`) | `unblocked:<task>:<stateSince of the blocked state>` |
| 4 `quiet` | the assignee is `working` with no event for `quietMinutes`, or its session is gone | `quiet:<task>:<session>:<lastSeq>` / `…:gone` |

- **Why `lastSeq`:** it is persisted by the host, so "a new answer since I last looked" is true after a host restart too, with no event. A session that finished while the ledger was not running is found by the snapshot, not lost.
- **Batching:** due notifications within 15 s become **one** message, at most 8 items then "and 3 more: call ledger_list", at most one message a minute to the responsible session (the host also caps an app at 10 a minute). Each wakes the responsible session and costs a turn; this is the reason for batching and for the keys.
- **Delivery:** through `notify` to the responsible session (the one that called `ledger_take_charge`, whose address the ledger keeps). A refusal (session gone, host restarting) is retried at the next sweep, three times, then shown in the panel as "not delivered". A message the host took is never repeated.
- **Text:** the host frames it as the app's text ("the person did not write or read it"). The ledger also cuts titles to 80 characters and strips line breaks, because a title can come from a GitHub issue somebody else wrote.
- **No responsible session:** nothing is sent; the panel says so; due notifications wait and are dropped if the condition no longer holds when one is chosen.

### 6. The three core pieces

**Trust, for all three.** An untrusted project's apps never run, and turning trust off stops them, so every pipe below closes. For the rest: the owner's decision is that trust follows the project, with no card per use and a new card only when an update declares a new capability. That is **not built for any capability yet** (today each capability is asked once, on first use, and again when `uses` changes: `desk.permit`, `usesStamp`), and for a project app nothing holds an update that adds a capability. So `observe` follows the mechanism that exists: the question is asked once, on the app's pinned view because no run started the poll, and again when `uses` changes (corrected after review: the first version said it asked no card, and that an update would ask again, which nothing did). When the owner's model is built it replaces this for all capabilities together.

**Manifest.** One new key, `uses.sessions`, a list of names: `"observe"` now, `"message"` later. A name this build does not know is a warning and refused, like `uses.host` (an older build reading a newer manifest still runs the app). It goes in the trust card and the inbox's "New app" notice in plain words (`uses-lines.ts`).

#### Piece 1: apps observe their project's session state (**built in PR 1**)

```
manifest   "uses": { "sessions": ["observe"] }
helper     const w = await centralu.watchSessions({ after?, waitMs? })        one poll
           const stop = centralu.observeSessions(({ full, sessions, gone }) => …)   a loop with backoff
broker     watch_sessions { after?: string, waitMs?: number }      no run id (like busy and notify)
answer     { cursor: "<hostEpoch>.<rev>", full: boolean,
             sessions: [ { id, name, kind, tool, state, live, waitingSince, lastSeq, activeAt,
                           parentId, askedBy, pending: { approvals, questions }, createdAt, machine } ],
             gone: [ids] }
```

- **Long-poll with a cursor, not a push.** No server-to-app channel exists on fd 3 and none is needed. An app that was stopped, a host that swapped (a new epoch), a ring that overflowed (1000 changes) all answer the same way: `full: true`, every session of the project, and the app compares with what it remembers. Nothing is lost by a missed event; there is no "replay".
- **Scope:** the app's own project's sessions, not in the trash, ≤500 rows. Not the orchestrator, other projects, or other machines' sessions. A user-folder app (no project) is refused.
- **Content:** state and counters only, never a conversation or a preview. `name` is what the sidebar shows (as `sessions.list` already gives; a session the person never named is named by the first 40 characters of its first message, so that fragment leaves, as it does today).
- **What counts as a change:** the name, state, kind, liveness, the number of open cards, the parent, and `lastSeq` **only while the session is at rest** (during a turn it changes on every message; a poll would never rest). `activeAt` (the time of the last event the host saw) is in every answer but never wakes a poll.
- **Limits:** one open request per app (a second is refused with the reason); `waitMs` ≤25 s (default 20, under the MCP client's 60 s); an answer waits 250 ms after the first change so a burst is one answer; at most 120 answers a minute. No run row (a poll every 20 s would bury the Runs panel): a refusal is a line in the app's log.
- **What the person sees:** the trust card line "See the state of this project's sessions (not their conversations)"; nothing per poll.
- **Linked machines:** not in v1. The linked machine's sessions reach windows through the hub's own broadcast (`linked-machine-connection.ts`), not the manager's event stream; the same API can read that later.

#### Piece 2: apps wake on a timer (**design only**)

The ledger does not need it (it uses `busy`), so I do not build it. What it would be, for review:

```
manifest   "uses": { "wake": { "tool": "sweep", "everyMinutes": 10 } }
```

- The host **calls a tool** of the app on schedule, caller kind `timer`. A wake with no call has no run id, so it could not be admitted, recorded or cancelled; a tick that *is* a run makes everything it asks for (an agent, another app, host data) go through the existing gate, and answers #314's "its own run record".
- Starts the app when stopped; counts toward the crash limit like any call. Minimum 5 minutes. One tick in flight: a tick still running skips the next. After sleep, one tick, not a burst. Not while the project is untrusted, the app is `failed` or `unconfirmed`, or the person pressed Stop (until the next time they open it). Fires whenever the host runs, with no window (keeper background mode, #280).
- The person sees "Wakes every 10 min" on the app's row, each tick in the Runs panel as caller "timer", and a line in the trust card.
- **Why it is held back:** a new caller kind is stored in `app_runs`, and a build before it reads that value. That is a store question and belongs to a deep review. It is also the fix for "a crashed ledger stays down until something calls it", so I expect to ask for it after the ledger has run for a while.

#### Piece 3: apps send a message to a session (**design only**)

`notify` is the narrow case: it can name only a session that called the app. The wider capability is `uses.sessions: ["observe", "message"]` and a broker request `send_to_session { to, text }` (no run id):

- `to` is a session of the app's own project (taken from the observation, so it cannot be invented), or the orchestrator. The orchestrator row appears in the observation **only** for an app that declares `message`; this is the "reach" the trust decision names.
- Not an app's agent session, not a builder of another app. A linked machine's session is not reachable in v1.
- Delivery is `notify`'s own path (`appNotice`): the app's message in the conversation (the dashed "from app" bubble), handed to the agent in the app-text frame naming the app, an idle or asleep session wakes. Same 4000 characters, the same 10 a minute per app, every send a run row naming the target and the text; a refusal is a row with its reason.
- Withdrawing: turn trust off for the project (the one switch of the decision). There is no per-capability grant to withdraw.
- What it unlocks for the ledger: the person picks the responsible session in the panel (today it must be a session that called `ledger_take_charge`), the orchestrator without it having called, and telling an assignee.

### 7. The project board app becomes one user

The board's merge queue runs in the background with no run id, so it cannot `call_app` the ledger from there; it does not need to, because the ledger reads GitHub itself. The board touches the ledger where a session is calling it (it has a run id there): `file_issue`, `open_pr` and `queue_merge` call `task-ledger.ledger_poke({ issue, pr })` (best effort: absent ledger, no error) so the ledger re-reads those numbers at once and offers or moves the task. Its `uses.apps` lists `task-ledger`. The queue's own owner-session notices (#1258) stay: they are the queue's contract and fire on the queue's own clock; the ledger adds the *task-level* news (a blocker resolved) once, not a second copy of the same landing. This is a follow-up PR, after the ledger has run.

### 8. Left out on purpose

- **#1161 item 2, standing instructions for started agents:** not in the ledger. The host appends them at `start_agent`; that must work with no app running, so it is a project setting in the host (and per machine), shown in the project's settings. It stays #1161 item 2. The ledger can show it later.
- Writing state to GitHub (labels, Status), creating issues (the board's `file_issue` does, with its rules), importing issues by itself.
- Piece 2 and piece 3 (design only above); observing a linked machine's sessions; starting sessions from the ledger (it tells the responsible session; deciding and starting stay with it).
- Dependencies between tasks, due dates, priorities, subtasks, an audit log, learning what "usual" quiet means (a fixed `quietMinutes` instead), notifying the person (the panel is where they see it).
- Sharing a ledger between machines or people.

### 9. Decisions (mine, with the alternative I did not take)

1. **A separate app, `task-ledger`, from the start; not inside the board app** (the issue's order says inside, then extract). The board's server is 95 KB; the ledger needs its own state, tools and screen, and extracting later is cutting a monolith apart. As its own app in this repository it is the shared app the shape section describes, and the board uses it through `call_app`.
2. **Observation is a long-poll with a cursor** over fd 3. Alternative: server-to-app MCP notifications. Rejected: it needs a new direction on the pipe, an app handler, and a replay story for a missed one; the cursor gives the same latency with a snapshot as the only recovery.
3. **`uses.sessions`, not a new name in `uses.host`.** `host_data` is a call inside a run and asks the person once; observation has no run to ask on, and `message` joins it later. Alternative: `sessions.watch` in the closed host list.
4. **Observation is asked about once**, like the other capabilities, on the app's screen (first version: no card, following the trust decision; but nothing in the code made an update that adds a capability ask again, so the docs promised what was not there).
5. **The ledger ships on `busy` + `notify` + observation.** Alternative: wait for pieces 2 and 3. Rejected: the first useful version needs neither.
6. **Storage in the app's data folder**, not the host store.
7. **Tests of the app live with the other app tests** (`packages/agent-host/src/apps/external/`), not in `tooling/` (a guard tier for a non-guard).

### 10. Build

- **PR 1 (host, deep review):** piece 1 end to end: `uses.sessions` in the manifest and the protocol's `AppUses`, the `watch_sessions` request in the broker and desk, `SessionWatch` in the session manager, `centralu.watchSessions` / `observeSessions` in the app runtime (template rebuilt), the trust-card line, `docs/apps.md` (+ `.ko.md`) and this design as `docs/plans/task-ledger.md`. It touches the broker, capabilities and the protocol, so it goes to the deep review.
- **PR 2 (the app, light):** `.centralu/apps/task-ledger/` with the model, storage, the four triggers, the sweep, GitHub sync, the panel; on PR 1.
- Not built: pieces 2 and 3, the board's calls.

### 11. Shared with #1324 (host-kept watches)

#1324 asks for watches the host keeps for a session (registered through `centralu_run`, event-first, stored across
restarts, delivered as a Centralu notice, listed and cancellable) and says it shares pieces 1 and 2. What is shared:

| Source | Here | For a watch |
|---|---|---|
| Session state (piece 1) | `SessionWatch` keeps one feed of changes to what may be seen of a session: a fingerprint per session, a revision per change, a ring of 1000. The app's long-poll reads it | A watch on "session X finished / asked / went quiet" is a second reader of the same feed. The feed is public inside the host (`SessionWatch.onChange`), and the long-poll is itself a reader of it, so the two cannot disagree about what a change is |
| Timers (piece 2) | designed only: a host schedule that calls an app's tool (`uses.wake`) | A watch with a time source is a schedule entry whose target is a session notice instead of an app tool: one scheduler (persisted, expiry, one tick after sleep, listed, cancellable) with two kinds of target |
| Rows and conditions | the row is the vocabulary: `state`, `pending`, `lastSeq`, `waitingSince`, `activeAt` | conditions are predicates over the same row: *finished* = at rest and `lastSeq` above the mark; *asked* = `pending` above zero; *quiet* = `working` and `activeAt` older than N. The host knows when the turn ended, so no phrase matching |

- **Delivery.** `notify` already is a notice into a session, recorded and framed as not the person's, waking an idle
  session (`appNotice`). A watch's notice is the same path with a different source label ("watch" instead of the app's
  name): add the source to the notice path once, not a second delivery. Piece 3 (`message`) stays out of #1324.
- **Once per change.** The keys of §5 (`kind:subject:change-token`, written before the send) are the rule #1324 states in
  prose; a host-kept watch needs the same store of delivered keys, which is host state (the deep tier).
- **Visible.** "Listed where the person looks, cancellable" and piece 2's "the row says *Wakes every 10 min*" are one list:
  what is armed for this session or app.
- **Not shared.** The ledger does not register watches: its triggers combine host facts with its own task data and GitHub
  and batch several into one message, so it reads the sources raw and keeps its own conditions. A session registers its own
  watches with its own authority; an app's access stays `uses` plus project trust. A session may watch only sessions it can
  already read.

### 12. As built (the app, `.centralu/apps/task-ledger/`)

Where the app differs from §1 to §5, and what it does not yet do:

- **Tools.** Four for agents and the panel: `ledger_list`, `ledger_add`, `ledger_update`, `ledger_take_charge`. Assigning
  is `ledger_update` with `assignee` (a session id or `"me"`), removing is `remove: true`, "seen" is `seen: true`; there is
  no separate `ledger_assign` (fewer tools resident in every session). The panel alone has `show`, `ledger_settings`,
  `ledger_adopt` and `ledger_sweep` ("Check now").
- **What the app moves by itself:** a blocked task whose blockers all resolved becomes ready (trigger 3), and a ready task
  given a session starts running. A linked task takes its title from its issue; a linked issue closing closes the task, and
  the issue reopening reopens only a task the issue closed.
- **Triggers 2 and 4 look only at a `running` task's assignee.** A task in review, queued or blocked has a session that may
  answer follow-ups; telling about each would be noise.
- **A task stays on the panel's "Needs you" list until somebody looks** (any change to it, or "Seen"), also after the
  responsible session was told once.
- **The responsible session is one that called the ledger** (`ledger_take_charge`, or any tool: its address is kept, and
  the person picks among those in the panel). Naming any other session is piece 3.
- **The panel asks again every 30 seconds while it is seen.** A session's state changes with no tool being called, and an
  app cannot tell its open views to read again (only a call that changed something does, `docs/apps.md` §6.3). That is
  a run record of the panel's `show` every 30 seconds while the panel is on screen; a way for an app to say "my view
  changed" would remove it. Not built.
- **Not built:** the board app's `ledger_poke` calls (§7), pieces 2 and 3, observing a linked machine's sessions. After
  the app crashes nothing restarts it until something calls it or the panel is opened (piece 2 is the fix).
- **A session is not watched for its own task when it is the responsible one.** Each message makes it answer, and that
  answer would be a new reason to tell it. (A review of the app found this loop.)
- **GitHub off reads nothing.** The sweep asks `gh` for no issue, pull request or decision while `github.on` is false, and
  the panel says that blockers on GitHub wait for it to be turned on. On, at most ten decisions are read in a sweep.
  `gh` is read outside the chain of changes, so a slow `gh` never holds up a tool call.
- **An old key is kept until the sessions are known.** What a session's state caused is forgotten only after the whole
  project has been heard, otherwise a restart a day after a message would tell it again.
- **A ledger file from a newer version is read and never written** (a rollback cannot damage it); the panel says so.
- **Known gap:** when the manifest changes, Centralu stops the old process only after its calls finish, so for a moment two
  processes may hold the same `ledger.json`; the last write wins. Not guarded.
### 13. Corrections after review

A review of the three pull requests found two constraints the issue itself names that the first design did not meet, and a trust
claim that was not true. What changed, and what is planned.

**Trust (corrected in §6, decision 4).** The first version said an update that adds a capability "asks again" and that
observation needs no card. For a project app nothing holds such an update (only an imported app is held when `uses` changes),
and `usesStamp` re-asks only capabilities that raise a card when used. `observe` now raises one like the others: once, on the
app's pinned view (no run started the poll), kept until `uses` changes. The owner's model (trust follows the project, a card
only for what an update adds) is for all capabilities together and is not built.

**The central orchestrator cannot be the responsible session in v1.** The issue says the responsible session is "usually the
orchestrator". The orchestrator's apps are the user-folder apps and the root apps it attaches (#1205); it never attaches a
project's inner app (`app-access.ts`), and the ledger is one. So it cannot call `ledger_take_charge`, and `notify` only
reaches a session that called the app. In v1 the responsible session is a **project session**, in practice the one working as
lead in that project (as here, where the orchestrating session is a worker session of the repository). The panel's "Responsible:
orchestrator" sketch in §3 means that. How the central orchestrator becomes reachable, in order of preference:

1. **Piece 3 with orchestrator reach** (below): the person picks the orchestrator in the panel, the app messages it with
   `send_to_session`. Needs the trust discussion that follows.
2. A ledger that is a *root* app of its own project, which the orchestrator can attach (#1205, `attach_app`): then it is the
   project, not an app inside it. Rejected for this repository (its project is the product).
3. A user-folder ledger shared by every project: it has no project, so it cannot observe one (piece 1 is for project apps).
   It would need a project argument and its own scope rule.

**Piece 3 needs its own trust decision before it is built.** Letting an app message the orchestrator turns repository code
into a direct prompt channel into the most privileged session (it sees every project, starts agents, changes settings).
Framing the text as the app's (a quoted block that says the person did not write it) does not make that safe: it is a
convention a model may follow, not a boundary. So, proposed and left to the owner (tier `person`):

- not folded into "trust the project": a **separate card per app, once**, naming the app and its project, saying it may write
  into the orchestrator's conversation, showing what it was sent last; a deliberate exception to "no further cards";
- only apps of trusted projects that declare `message`; a revoke in the orchestrator's own settings list;
- the existing limits (4000 characters, 10 a minute, every send a run record naming the text) and a **lower ceiling to the
  orchestrator** (for example 3 a minute, one open per app), and the orchestrator reads app text as it already does: it can
  grant nothing and change no instruction;
- the orchestrator never acts on app text without the person's own word for anything that spends or deletes.

**Linked machines are not observed, and assignees there are invisible to triggers 2 and 4.** The ledger's children mostly run
on a linked machine, and #1324's first case is exactly that remote poll, so "shares the source with #1324" is only half true until
this is done. Where a linked machine's session state enters the feed, as the next step (a separate pull request on #1334):

- The hub already holds it: `LinkedMachineConnection.onEvent` keeps a mirror of each machine's sessions
  (`mirror.upsertSession`, `patchSession`, `removeSession`, and `machine_resync` after a reconnect) with ids qualified by the
  machine (`qualify`). `SessionWatch` gets a second input from that mirror, not from the manager's emit path, so each
  mirror change is a change in the same feed, fingerprint and cursor.
- Which of the hub's projects a linked session belongs to: the pairing `start_agent machine` already uses, a machine's
  project that is a checkout of this project's repository (`checkoutOn`: the same `origin`, `gitRemoteKey`). A linked project
  with no such local project is invisible to every app; one with several checkouts is refused, as there.
- The row gets `machine` (already in it) and `unreachable`, and **a session on an unreachable machine is not "gone" and not
  "quiet"**: the mirror keeps the last state, and trigger 4 and "gone" must not fire from silence the link caused. `lastSeq`
  and `activeAt` for a linked session are what the mirror last heard, so trigger 2 reads the machine's `lastSeq` after a
  `machine_resync`. This is the part that needs real linked machines to test.
- Limits, scope and the card are unchanged (the app's own project; it already says "state and counters").
- #1324's session-state watches read the same feed, so a watch on a child that runs on a linked machine works the same way.
- **A decision blocker is resolved only by who wrote it** (second review): a comment starting "Decision (owner" whose
  GitHub `authorAssociation` is `OWNER`, or whose author is a login in the setting `github.deciders` (for an organisation's
  maintainers, who are not `OWNER`). Anyone can write those words on a public repository, and what a decision unblocks may
  be acted on. A decision issue being closed decides nothing (its author can close it). Left: an `issue` blocker closes
  with the issue and a `pr` blocker with the merge (a merge needs a maintainer; an issue can be closed by its author), so a
  stranger's issue used as a blocker can be closed by its author.
- **What agents read is quoted.** `ledger_list` and the other tools quote each title, next step, blocker text and name on one
  line, as the message to the responsible session does, so none can pass for a line of the ledger.
