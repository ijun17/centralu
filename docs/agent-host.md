# Agent Host — the Node sidecar design

A standalone Node process. In dev the developer starts it directly (`pnpm host`); in the packaged app the keeper (`centralu-keeper`, §4.1) spawns and watches it, and in `pnpm app:dev` the Tauri app does. **It has to behave the same whether or not a UI is there** — the UI can be closed and reopened many times (reconnecting) and the host keeps its sessions.

## 1. Internal structure

```
agent-host/src/
├─ main.ts              # CLI (--port --token --db --watch-parent --memory --standby), the wiring of the
│                       #   services, each start step marked against lifecycle/start.ts's START_ORDER
├─ lifecycle/           # the process's start and ending (runtime-unification.md step 3):
│                       #   launch-env (variables read once, deleted), start (the order as data,
│                       #   the final refusal), gate (nothing to a screen before the server),
│                       #   steps + shutdown (the ordered, run-once, bounded stop plan),
│                       #   endings (signals, the parent's pipe, crashes, host-errors.log)
├─ rpc.ts               # RPC method dispatch
├─ transport/
│  ├─ server.ts         # ws server, handshake, RPC routing
│  ├─ event-log.ts      # assigns seq, ring buffer, afterSeq replay (protocol §1)
│  └─ json-lines.ts     # newline-delimited JSON: split at \n only (never readline, which also splits at U+2028), pending requests (#428)
├─ adapters/
│  ├─ contract.ts       # AgentAdapter interface + capability types
│  ├─ contract/         # the contract's larger parts: orchestrator tools, session apps, the tool's process,
│  │                    #   the tool's surface (what it offers, what the adapter limits, #270)
│  ├─ registry.ts       # the tool → adapter map
│  ├─ claude/           # based on the Claude Agent SDK (incl. orchestrator-mcp.ts)
│  └─ codex/            # app-server JSON-RPC client (written here, incl. the stdio bridge)
├─ sessions/            # SessionManager and the parts moved out of it: delegation, handoff, the session archive (`session-trash.ts`),
│                       #   orchestrator tools, session apps (folder-structure.md §1)
├─ apps/external/       # external apps: manifest, discovery, runs, broker, capabilities (apps.md)
├─ views/               # app views: the view host, its CSP, the proxy page, drag relay
├─ links/               # linked machines (#82): links, the remote client, install and update over ssh
├─ keeper/              # the keeper's child service: agents and ptys spawned there, re-attach (#280)
├─ dev-services/        # git/fs/store, terminals, commands (not dev-only — it is where messages live, §5)
├─ swap-control.ts      # the host's half of a swap (#280 step 3); drain.ts waits out the calls it serves
├─ keeper-link.ts       # what the host tells the keeper, and its own build
├─ view-handover.ts     # open app views across a swap (#280 step 4)
├─ log-file.ts          # tees stderr to ~/.centralu/host.log (stdout is reserved, see below)
├─ env-path.ts          # PATH augmentation — a GUI app inherits no login-shell PATH
├─ stream-text.ts       # text read off a child's stream: a kept tail, lines, decoded as one stream (#428)
├─ timing.ts            # bounded waits (withTimeout, raceTimeout, raceBound, waitForEvent, waitForExit): each clears and unrefs its timer
├─ tool-launch.ts       # how a found tool is started (Windows .cmd shims, absolute paths)
├─ os.ts                # what differs between OSes, asked by name (architecture.md §2)
├─ data-dir.ts          # locating and migrating the data directory
├─ idle.ts              # the one rule for "is anything running a person would lose" (#352)
├─ updates.ts           # update checks, installing, "apply automatically when idle"; update-apply.ts: an agent's apply (#665)
├─ agent-versions.ts    # moving sessions to a newly installed agent CLI (#297); cli-version.ts finds the version
└─ themes.ts            # the themes folder (#312)
```

Usage parsing and the orchestrator's MCP surface do **not** have their own directories:
per-account usage lives in `adapters/<tool>/usage.ts` (it is a per-tool question), and the
orchestrator's tools are defined once in `sessions/tool-definitions.ts`, run by
`sessions/orchestrator-tools.ts` (which re-exports every name, so most modules import from it) and exposed per
adapter — in-process for claude, over a stdio bridge for codex. Which seat is shown and may run
which tool is `sessions/tool-seats.ts`; the texts the answers are built from, `sessions/tool-answers.ts`.

### 1.1 Who gets Centralu's own tools (tool profiles)

Every session gets one bundle of the `centralu` server's tools, or none. One pure rule decides which
(`toolProfileFor` in `sessions/tool-profiles.ts`, from the row's kind, its app and builder slot and
the Settings switch; `toolBundleFor` names the object behind each profile). The manager asks it in one
place (`toolChoice`: the profile, and the bundle built when the adapter's options are), used at create, at
every wake, on every bridge call and by `toolProfileOf`, so they cannot drift apart. The orchestrator's,
a coordinator's and the reader's objects are one function, `orchestratorToolsFor` (`sessions/orchestrator-seat.ts`),
over the narrow view of the manager it is handed (`OrchestratorSeatHost`);
`profileAllows` decides both what the bundle exposes and what its calls may run, so a name the
bundle leaves out is refused even through the Codex bridge.

| Profile | Who | View | Tools | Instructions |
|---|---|---|---|---|
| `orchestrator` | the one orchestrator | every session | all but the builder's | role and usage |
| `scoped` | a coordinator (#80): made only by the control app's tasks, which were removed in #372 with the RPC that created one; the ones in a store still wake with this profile | its members | list, read, send | its boundary |
| `builder` | an app's building session (M4 C-3) | its own app | `check` | build-and-check |
| `reader` | every other session in a project (#320), a former worktree manager included | from a trusted project, reads every project's ordinary sessions here and on linked machines (not an orchestrator's, a coordinator's or an app's); from an untrusted one, its own project only (#984); acts on the agents it started (auto: any session in its own project) | `read_session` (no id: lists), `recall`, `app_guide`; `ask_project` (#371, §1.2); `start_agent`, `agent_session` (#561, §1.2.1); and `find_apps`, `attach_app`, `detach_app` (#371 part A, apps.md §9.4) | Centralu's tools first unless the person says otherwise (#564) |

The instructions reach the model on both CLIs, by different doors. Claude gets them as the in-process
server's `instructions`. codex-cli 0.160.0 shows a server's instructions to no model (#525, measured with
`scripts/probe-codex-mcp-instructions.mts`), so the Codex bridge sends none and the same text rides in the
thread's developer instructions, after the seat's role, under a one-line header. Codex reads those at
`thread/start` only and ignores them on `thread/resume`, so a Codex thread keeps the instructions it was started
with: one that changes profile while its thread lives on has its new tools without their instructions until it starts a
new thread.

**The worktree manager** (`manager`, #69/#76) was folded into ordinary sessions (#561 part 3, owner 2026-10-12). It was
a project's seat that watched its worktree sessions, proposed new ones (`propose_worktree_session`, which the person
then created) and deleted a merged one behind a hard gate (`delete_worktree_session`). Now a session starts worktree
agents itself (`start_agent` with `worktree`, §1.2.1), works with them (`agent_session`) and removes an idle child
with `agent_session` `delete`, keeping local work with the session in the session archive (#608, `cleanUpWorktreeChild` in `sessions/worktree-sessions.ts`). What stayed: the person's own worktree
sessions (the new-session window's option; they now stand alone instead of under a manager made for them), merge and
pull-request detection on every worktree session, and the project's trunk (`worktrees.setTrunk`, kept in the former slot's row;
the project menu's "Worktree trunk" entry was removed in #733, so the trunk is detected and used but no screen sets it) The orchestrator gets no replacement for `propose_worktree_session`:
making a branch and a folder in the person's repository now goes through a project session's consent card, and the
orchestrator reaches that session with `send_to_session`. Existing data: store v48 gives a former manager's worktree
sessions `askedBy` = their parent, so it owns them as the agents it started; `worktrees.createManager` is refused with
the reason (the protocol keeps it for an older window), and the slot's column stays until a later contract step.

The reader's read tools stay inside its project, and its tools object refuses changing
settings outright, not only by name. Its agent tools follow §1.2.1, including auto's ownership opening. Its update tool requires consent outside auto (§4.5). It is never given to an agent
session an app stood up (M4 D-1), whose answer goes
back to the app. It cannot be turned off (owner decision 2026-10-20): `sessionTools` stays in the preferences record
for older builds, but the host reads it as on whatever is stored and does not store an "off" an older window sends.
For provenance (#90) a reader is
still an ordinary worker — `directs()` counts every profile but `reader`.

**Its size is the design constraint**, because it rides in every session on every turn. Measured
against the real CLI (haiku, CLI 2.1.289, `scripts/probe-reader-tools.mts`; first request's input
tokens over a run with no `centralu` server, claude.ai connectors off):

| Shape | Characters | Tokens |
|---|---|---|
| `list_sessions`, `read_session`, `recall`, `app_guide` in the orchestrator's words | 2,493 | +672 |
| the same four, re-worded | 1,138 | +338 |
| listing merged into `read_session` (three tools, all loaded) | 897 | +267 |
| **as shipped**: `app_guide` deferred behind tool search | 897 | **+192** |
| all three deferred | 897 | +28 |

Per tool, loaded: `read_session` 239 → 98, `recall` 182 → 84, `app_guide` 148 → 85,
`list_sessions` 103 → 75 before it was merged away. A tool costs about 55 tokens before its first
word (name and schema envelope), which is why merging beat trimming. Deferring the whole set was
refused: asked about an earlier conversation, the model never called `recall` (the orchestrator
had measured the same for `send_to_session`, which is why its tools are `alwaysLoad`). Deferred,
`app_guide` was found through tool search 4 times in 5, against 5 in 5 loaded; the miss is an answer
from a guess about the app, and the orchestrator has the guide loaded. Codex has no deferral and
gets all three. `orchestrator-tools.test.ts` fails if the serialized set and its instructions pass
`READER_BUDGET_CHARS` (1,000 until #564 gave the set its 392 characters of instructions; 1,400 since,
the set at 1,375). #581 adds the consented update tool, deferred on Claude like the guide, and its
instructions pointer: 1,709 characters against a 1,750 ceiling. #1480 gave `read_session` `tools` (three words or a boolean),
`maxChars` and the `before`, `from` and `offset` a budget's notes name, all without a description: +204 characters, 1,913 against a
ceiling raised to 1,950 (the reader's resident sum rises by the same 200: Claude 2,396 definitions + 413 instructions, 2,562 more
deferred; Codex, loading all, 4,958 + 465 = 5,423 against 5,500). They are all in the definitions because Claude's in-process server
strips an argument its schema does not list before the tool runs (measured on the SDK's `tool()`), so a read a note names would
lose its argument. The same arguments cost the orchestrator and the scoped seat 178 characters (a short description for `tools` and
`maxChars`), whose ceilings rise 9,500 → 9,700 (Codex 9,663) and 2,400 → 2,600 (Codex 2,560). The full reader profile's resident
and deferred figures for both CLIs are in [tool-cost.md](tool-cost.md) §11 and §14. #1487 restored `.int().min(0)` on `offset` (the schema had lost it): +12
characters in the reader set and in the orchestrator's, whose ceilings rise by 10 (1,960 and 9,710), the reader's resident sum by 25 (2,850).

The app-access tools (#371 part A: `find_apps`, `attach_app`, `detach_app`, apps.md §9.4) are the
orchestrator's too since #1205, as rare commands behind `centralu_run`, for the root apps it attaches
when it needs one ([tool-cost.md](tool-cost.md) §12). In an ordinary session they ride on
the same server with their own ceiling, `APP_ACCESS_BUDGET_CHARS` (900; the set is 874), so neither
set grows into the other's headroom. Claude defers all three, which adds +31 tokens per request (the
same probe, 2026-10-05, measured on the #320 set before `ask_project` joined it: +192 to +223), and
loaded they would add +263, which is what a
Codex session pays. The model found them: 5 of 5 fresh haiku sessions found `find_apps` through
tool search from a plain request (apps.md §9.4), with no other way open to it.

Since #522 Claude loads `find_apps` and defers the other two. With `ask_project` loaded beside it, a
question about another project's app went to `ask_project` (or to reading sessions) and never to tool
search: 0 of 10 runs went on to `attach_app`. Loaded, with `ask_project`'s description ending "For
another project's apps, use find_apps.", 9 of 10 did (8 of 10 in a second run), for +86 tokens per ordinary Claude request (+75 the
definition, +11 the pointer: 326 → 412). The variants and their numbers are in
[tool-cost.md](tool-cost.md) §8. #523 made `app_guide`'s `topic` an enum of its seven topics (the
reader set is 983 characters with it).

**Measuring it again** (#513). `pnpm measure:tools` measures every profile on both CLIs the same way,
repeatably: resident tokens (the API's usage, and `count_tokens` with and without Centralu's tools), cache
reads and writes per request and which event caused a rebuild, tool selection and first-try argument
validity on a fixed prompt set, and what tool results add over a longer session. `orchestrator-tools.test.ts`
pins each profile's resident characters (`RESIDENT_BUDGET_CHARS`), and `adapters/claude/tool-prefix.test.ts`
that attaching or detaching an app never changes a Claude session's tool list. How to run it and read it,
and the baseline: [tool-cost.md](tool-cost.md). That baseline (2026-10-12) found that Codex no longer puts
MCP tools in the request up front: codex-cli 0.160.0 reaches them from its own `exec` tool, so "Codex has no
deferral" above describes the CLI the numbers above were taken with.

**The orchestrator's rare commands** (#512; `CC_RARE_COMMANDS`, the commands tier by default since 2026-10-12).
`create_app`, `propose_skill` and `propose_mcp_server` are a third of what the orchestrator carries and the
least of what it calls. By default (`CC_RARE_COMMANDS` unset, or `commands`) the host takes
them out of the tool list and serves three fixed tools in their place, `centralu_commands` (one line each),
`centralu_help` (one command's schema) and `centralu_run` (checked on the host against that schema, strictly;
a wrong call answers with it), plus one line in the instructions saying they exist. The profile rule is the
same (`commandsFor` lists and runs only what `profileAllows` gives the seat), and a run goes through the same
runner, so each command keeps its result and its card. `propose_worktree_session` was in the tier at first and
came out: nothing in the instructions names it, and hidden it was never reached. `app_guide` stays a tool: the person's questions about
the app come unannounced, and deferred it was found less often (tool-cost.md §8). The setting is read once at
start, since a session's tool list is its prompt prefix. The other two stay selectable for measurement:
`CC_RARE_COMMANDS=resident` serves every command as a tool, as before, and `CC_RARE_COMMANDS=deferred` defers
the three behind Claude's tool search (the server is then loaded tool by tool, as the reader's is). The three
arms are compared in [tool-cost.md](tool-cost.md) §9. On Sonnet the tier lost nothing (every rare command
reached, first-try arguments valid, English and Korean) and saved 835 tokens a request; on haiku it saved 709
and reached a rare command less often (15 of 24 against 23 of 24). The owner made it the default on the Sonnet
numbers and because it keeps the orchestrator's resident prefix from growing as commands are added
(decision of 2026-10-12, #512): the orchestrator carries 9,317 characters instead of 11,862, and its ceiling
(`RESIDENT_BUDGET_CHARS`) went from 12,000 to 9,500.
**Centralu's features first** (#564, owner decision 2026-10-12, product-spec.md §1.2): unless the person says
otherwise, agents running in Centralu use Centralu's own features first. Two seats carry it. The orchestrator's role
starts with a preamble saying so (`orchestratorRole`; it names `centralu_commands` where the seat has the tier), first
measured in round 2 of tool-cost.md §9 at 33 to 55 tokens a request with no regression and no gain that held, and on
by default since #564. An ordinary session, which has no role, gets the same rule as its tools' instructions
(`READER_INSTRUCTIONS`): one sentence naming which tool answers which need (`READER_FIRST`: `recall` for earlier
conversations, `read_session` for other sessions, `ask_project` for another project's work,
`find_apps` for another project's apps, and `start_agent`, not the CLI's own Agent tool, for long work, another CLI
or a worktree, or work the person will follow; the CLI's own subagents stay the way to hand off short helper work
inside the turn, owner decision of 2026-10-12). A tool that joins the reader seat and answers a need the person states
in words adds its line there. Before #564 the reader set had no instructions, on the principle that Centralu offered
tools to the person's sessions and did not direct them; the owner withdrew that principle. `CC_ORCHESTRATOR_PREAMBLE=0`
and `CC_READER_INSTRUCTIONS=0` (read once at start) turn either off, for measuring them against their absence. What
they cost and change: [tool-cost.md](tool-cost.md) §11.

A Codex session with a bundle starts the stdio bridge, so since #320 every Codex session starts
one more node process (about 40 MB resident, idle). The bridge sets
`default_tools_approval_mode: 'approve'`: our tools are never asked about, as on the Claude side,
and without it Codex in auto (`approvalPolicy: never`) refused every call on its own.
The bridge decodes its stdin as one UTF-8 stream: a pipe can split a multibyte character between
two chunks, and decoding each chunk on its own put U+FFFD into the tool's arguments.
`scripts/smoke-reader.mts` runs the set end to end with a real model (`TOOL=codex` for Codex).

### 1.2 Asking another project (`ask_project`, #371 part B)

The one reach an ordinary session has outside its project. `ask_project({ project, session?, task? })`
gives a task to an **existing ordinary session** in another registered project and returns its answer.
It never creates a session in another project (#614, owner decision 2026-10-13). Creation remains the
person's action in that project; `start_agent` creates only within its caller's own project. The global
orchestrator, which belongs to no project, retains its own create-session tool.

What one call does (`SessionManager.askProject`, which runs `AskProjectFlow` in `sessions/ask-project-flow.ts`, #428):

1. **The project.** Name or id of another registered project, on this computer or on a linked machine
   (§1.2.4). Its own project is refused; an unknown name lists the other projects, each with the machine
   it is on once a machine is linked. Under `safe`/`normal`, an untrusted caller cannot ask; under `auto`
   (#603), the caller's own preset opens and logs that boundary. Under every preset, a session at the agent depth
   cannot delegate (#867, `agentDepthRefusal`): at the default of 1, a child started by another session or a
   session currently handling a cross-project task.
2. **The session.** `session` names an ordinary session by name or id. Orchestrators, builders and
   app agents are excluded. Without it, exactly one ordinary session is selected; otherwise the call
   lists the candidates with id, name, state and last activity and asks the caller to name one.
   Duplicate names require an id. No ordinary session means a refusal telling the person to open
   one there. Selection never creates, renames or takes ownership of a session, and the task's
   text never auto-names a "New session" (#646): only the person's own words do, as with an app's
   message. Old `Asked by <project> · HH:MM` sessions remain ordinary sessions; their former cross-project `askedBy` mark is removed (#614), and
   their name and history are kept.
3. **Consent.** `ensureProjectAccess` (`delegate`) raises a card in the caller's session naming
   `<caller project> asks <project> / <session>` and the task. Allow once, always for this project
   pair, or deny; only always is stored in `project_consents` and revoked in Settings → Permissions.
   The card states the target's trust, including in conversation and notification text. Under `auto`
   the card is skipped and logged without saving consent. The selected session keeps its own tool,
   model, effort, preset, project trust and approvals. Availability, the caller's trust and depth, and the target
   project are checked again after consent (`askGateError`). The caller's project losing trust or being removed, or
   the target project being removed, withdraws a card still standing (`withdrawReaches`).
4. **Delivery.** The task travels in `askFrame`, explaining the caller and how the answer comes
   back (the caller's project name a one-line field, `frameField`, as the parent's name in `agentFrame` and
   `agentNoteFrame` is, #428), and names the asking session by its name (one line, written as a JSON string so a quote in it cannot close it) and id (#1186: the model
   read the project only; `from`, which identifies the session, is in the store and on screen, not in the input). It
   appears in the target conversation with `from` identifying the asking session. An idle
   session resumes as needed, and once it is awake (a wake or a deferred restart takes seconds) the caller's trust and
   depth and the target project are read once more before the task is written (`deliver`'s `stillAllowed`): an `auto`
   caller's untrusted project still lets it through (#606); its depth and a removed project still refuse. A session busy with a turn that is not the caller's (the person's,
   another delegation, or requests queued ahead) returns the choices instead (§1.2.3, #677): the
   caller passes `ifBusy` `note` (an `auto` caller only, through the adapter's tracked mid-turn input
   path, #594, on a CLI that takes it, and never into another caller's delegation) or `queue`; no
   fork across projects. No interrupt or CLI-specific logic is added to the manager, and another
   delegation's watcher is never replaced. `AgentRunWait` holds until the delivered input's receipt completes,
   even if the CLI queues it into a later turn; an earlier turn's answer cannot finish this call.
5. **The answer.** Final text is JSON-quoted as another session's words and clipped after 6,000
   characters: the first 4,500 and the last 1,200 are kept, and the cut names the read that shows the rest,
   `read_session(sessionId, around=<the answer's first seq>, offset=4500)` (#1186; `clipAnswer`, `answerAt`). Where
   that session cannot be read from the caller (a hub's), the cut names the session as before. `read_session` shows
   at most 2,000 characters of a line's text; a longer line says which characters it shows (`shown`) and the read that
   goes on (`readOn`: the same call with `around` at the line's first seq and `offset`), and a read with `offset`
   shows up to 8,000 characters of that one line (`sessions/session-lines.ts`). `offset` is in no tool definition:
   the cut and the line spell out the call, as recall's hit does `around`. It also goes to a linked machine
   (`host.readSession`'s `offset`, additive: an older machine answers its plain read, and the hub says that machine cannot read from an offset rather than showing the same cut lines again; a read from an offset always says what it shows, which is how the hub tells them apart). The cut used to send the caller
   to the session by name, and read_session cut every line at 2,000 characters of its JSON with no word of it, so
   the middle of a long answer could not be read back at all. **A read has a total, too (#1480)**: 40 lines of 2,000 characters
   were about 80,000 characters in one call, all read again on every later request of the reader. The lines of one call, notes
   included, come to at most `maxChars` (12,000 by default, brought to 2,000-40,000), and the first line always comes. A plain read
   fills from the newest line back; one around a spot, outward from it a side at a time; one `from` a line, forward. One line shows
   2,000 characters at the default and a sixth of `maxChars` above it, up to 8,000 (`lineCutOf`). When a side is left out a note
   line says how many lines and the call that reads on from where the read stopped: `before=<seq of the oldest line shown>` back, or
   `from=<seq of the first line not shown>` forward, so following it shows nothing twice (`around` centres, and showed half of it
   again). `tools` is `none` (tool calls left out, and the texts a call separated stay separate lines, so the end of a turn is a line of
   its own), `titles` (one line each, the default, `false`) or `full` (`true`). For a linked machine, `host.readSession` takes
   `maxChars`, `toolLines`, `before` and `from` (additive; `tools` stays the boolean an older machine's schema accepts) and answers the
   `maxChars` it held. The hub bounds every answer itself (`fitMachineLines`): tool lines out for `none`, then the budget, keeping the
   lines nearest the spot of an `around` read (the machine centres its window on it) and the newest otherwise, a machine's own notes
   counted. A machine from before it answers every line it has and no `maxChars`: its note cannot name the read that goes on, since
   those lines carry no seq, and says to find the passage with `recall` and read around its seq; `before` and `from` to such a machine
   are refused, since it would answer the plain read again. A note's call repeats the `tools` (when not `titles`) and `maxChars` the reader gave, so
   following it reads the same way, and a read answered to a hub (`hubView`) adds that a hub from before `before` and `from` strips them from the call
   (its schema lacks them, so the newest lines would come back again): "the hub needs an update to read on", and `around=<seq>` reads near the same spot (`ReadOn`
   in `sessions/session-lines.ts`, #1487). **A session reads and recalls its handoff lineage (#1487)**: its predecessor by its newest handoff marker, that one's
   predecessor, and so on (`HandoffMarkers.lineage`, up to 12 generations), in the session archive too. A handoff stays inside a project: `createSession`
   takes `handoff.fromSessionId` only for a live session of the same project, and `lineage` ends at a marker naming a session of another project (the archived
   row's project is in its trash record, `projectOf`), so a marker written another way reads nothing of the archive. `recall` keeps a quarter of its limit
   for these hits, nearest predecessor first. `read_session` reads these and `recall` searches
   them (by their messages: the archive's search index is dropped, `searchSessions`), and nothing else of the archive; a session deleted for good takes its
   own marker with it and ends the chain. The lines are the predecessor's: `role: predecessor` for the assistant's words, `predecessor: <id>` on every
   line, an opening sentence in the answer, and in `recall` the label "(your predecessor, archived)" with `[predecessor]` in the snippet. The note's
   header lists the lineage ids (`lineageLine`; the record's header, and the first line of an agent's note) and stays the only thing handed over. Named files and folders inside the target project, resolved through symlinks, become
   readable to the caller for this host's lifetime (`readGrants`); the project root is never granted.
   A grant and each read are compared in one spelling (`canonicalPath`, `isInside` in `dev-services/path-guard.ts`,
   #428), so a short name, another case or a link to the root reads as the place it names.
   Outside paths are listed without grants. Claude checks grants on each read through `mayRead`;
   Codex's reads are already unrestricted.
   A turn that **completes** while the asked session's own background work (timers left out) still runs is a pause, as a
   `start_agent` child's is (§1.2.1 step 7, #1460; it used to come back as the final answer, with no report owed, so the
   result of the turn the work's ending started reached no one): the call answers `done` with the words so far and
   `paused` ("its turn ended while its own background work is still running (…); a final report follows when that work
   ends and a turn ends it; if it is a server or watcher it leaves running this answer may be the final one;
   `read_session`"), with no `agent_session stop`, which an asked session does not have. It is decided where the delegation's
   turn ends (`DelegationFlow.startDelegation`), whether or not a call is still waiting, so a turn that ends after the
   call's bound is paused too and the next call reads the pause. The report is marked owed and paused (`markReport` +
   `pauseReport`: the store's `report_marks` and `report_paused:<session>`, so a host swap keeps both and the next host
   delivers the final report once), and the rest is §1.2.1 step 7's: the report comes when a turn ends with that work gone,
   or `PAUSED_REPORT_SETTLE_MS` after the work ended with no turn, a turn the person starts there is theirs and not
   reported (#1377), and a new task from the same caller ends the pause. A note that joined the person's turn is not
   paused: that turn's work is theirs. Like a child's, work the person left running there (a dev server) holds the
   report until it ends.

**Long work.** A call waits up to `ASK_WAIT_MS` (240 s), below the Codex MCP ceiling of 300 s and
bridge wait of 280 s. It then answers still working, naming the session and how to call again with
`project`, `session` and no task, and where the turn is (`progress`, #1186): how long the session has recorded
nothing and its last step (a tool call's title on one line, quoted as JSON), as start_agent's and agent_session's
`working` do; a session at work and one stuck read the same before. Without `session`, one outstanding call in that project is enough
to continue waiting, even if another session was opened meanwhile. Multiple outstanding tasks need
an explicit session. A new task cannot replace unfinished work in the same session.

Every bounded wait (ask_project's, start_agent's and agent_session's, a start request's, a handoff's) is one race,
`raceBound` in `timing.ts` (#428): the outcome, the bound, the call's cancellation (also one that came
before the wait) and the wait's own wakes. Unlike `withTimeout` it never rejects: the bound is an answer.

**Stop.** Stop on the caller reaches delegated work only while that caller is actually waiting
(`waiters > 0`), as for `start_agent`; after a bounded call returns still working, the target keeps
running. If the task joined an already-running turn, Stop or call cancellation ends only the caller's
wait and never interrupts the person's turn. Its receipt watcher, other observers and report-back
continue until the input finishes. A task assigned to an idle target can still be interrupted while
the caller waits. An explicit Stop on the target remains available. A failed turn or deleting the
target returns an error naming the session. Deleting the caller drops the wait and grants while the
target keeps its turn. Tracked notes cannot report an intermediate turn's completion.

**Size.** Historical baseline before the optional session selector (#614). Measured like the reader set (haiku, `scripts/probe-reader-tools.mts`): `ask_project`
is 350 characters (`DELEGATE_BUDGET_CHARS` 400) and costs **+103 tokens** loaded (the set: +192 →
+295), +10 deferred. It is loaded: asked "Have the toolkit project export the sprites again, then
tell me where the files are", the model called it for that project 7 times in 10 loaded and 0 in 5
deferred — deferred, it searched past conversations and its own folder instead, the failure #320
measured for `recall`. A miss is an answer saying it has no such project, and the person can name
the tool. One of five unrelated how-to questions drew a call naming a project that does not exist
(refused, no card). The description says "a job", not "a task": the two read the same to the model
(7 in 10 each), and the guide, which lists every seat's tools, keeps no word of the removed
control rail's tasks (#372). Two other wordings did no better (0 and 3 in 5).

`packages/agent-host/scripts/smoke-ask-project.mts` runs it end to end on a temp store and data folder: a haiku session
in one scratch project has the other write a file with a number only it knows and reads it back
(`CALLER`/`CALLEE` = `claude` or `codex`).

### 1.2.4 A project on a linked machine (#700)

`ask_project` reaches the projects of linked machines the way the orchestrator's `create_session` does
(docs/plans/remote-hub.md §12.6). `SessionManager.askProject` resolves `project` over this computer's
projects and `LinkedSessions.projects()` (each reachable machine's `projects.list`) with `matchProjects`
(`sessions/ask-project.ts`). In order, the first step that finds anything wins:

| Written as | Finds |
|---|---|
| a project id, or a machine-qualified id (`m1.p-12`) | that project, always |
| the name | the project of that name, on this computer or on a machine |
| `<machine>/<name>` (the machine by its id or the name the person gave it) | that machine's project |
| the name, case aside | as above |

The same name on two machines is refused with every choice listed as `name [id] on <machine>`, since
guessing would send the work to the wrong disk. A machine that is not connected is named instead of
leaving its projects out: its projects come from the headers mirror and are refused as "not reachable
right now", a name found nowhere says which machines were not asked, and `<machine>/<name>` for a machine
that is down says so.

For a machine's project the call runs through the links, not the manager's own sessions
(`askLinkedProject`): the machine's ordinary sessions are listed with `sessions.list` there (same
exclusions as here), the person's consent is asked for this call, the task goes as `host.send` (recorded
there as sent by the asking session, named with this computer), and the turn is waited on through the
machine's own events, which the hub relays qualified (`observeLinked`). The answer is the session's last
words, read there whole (`host.lastAnswer`, #1186: its text up to 100,000 characters, its length and its first
message's seq there), cut as an answer is cut here, the cut naming `read_session` on that session with that seq and
an offset. The hub used to read it from `host.readSession`'s lines, which the machine cut at 2,000 characters of JSON,
so a long answer came back as an older line or empty; an older machine is still read that way, its cut line read back
as far as it goes. A read that failed is said (the turn ended, the answer could not be read, read it with
`read_session` once the machine answers), here, in start_agent's answers for a child there and in a report's preview,
where it used to come back as an empty answer. It runs on that machine with its own logins, folder and preset.

| Choice | Reason |
|---|---|
| The card names the machine, and "always" is not offered (`ProjectAccess.to.machine`) | A remembered consent is a row tied to two projects of this computer (foreign keys on `projects`); a machine's project has no row. The plan (§12.5, question 4) recommended the pair's card with the machine named; it asks each time until the owner wants a remembered form |
| Paths in the answer are listed under "outside", none opened | They name the machine's files, not this computer's |
| A session busy with a turn, or `ifBusy`, is refused with a reason; the machine's sessions are read again after the card is answered, and nothing is sent if the session left or started a turn meanwhile. The caller's trust and depth are read again after the card and right before the send (`askGateError`), and the caller's project losing trust withdraws a card still standing | A note or a queue into a session on another machine needs the machine to take them; not built. The card can stand for minutes, and a task sent into a turn the person started there would join it and end the call with their turn |
| A machine's project list is waited for 4 s (`LOOKUP_MS`); one that does not answer is counted as away | The name is looked up on every call, so one half-open link must not hold up the asks that name something else. The name that is on this computer and on a machine is still refused as ambiguous when the machine answers; when it does not, the call goes on with what was heard. `create_session` finds a machine's project through the same list (`projects({ ref })`, #1143; it was `findProjects` until #1547): it was unbounded, and dropped a machine that did not answer, so a stalled link held up a create in a project on this computer and a name also on that machine started the work here. A name it finds only in a mirror is refused as away, and one also here is refused as ambiguous |
| The turn's end is read by `linkedTurnEnd` (`sessions/linked-turn-end.ts`), the same reading the orchestrator's report from that machine uses (`LinkedReports`): an approval or a question there is a running turn (as is a working state, `isInTurn`), an error or a usage limit ends the call as not finished, an interruption does once the turn was seen running (before then it ended the turn the task joined, not the task's), and so does the session being deleted there (#428) | A local agent's run reads an interrupted turn as not finished (`AgentRunWait`, #698); the two copies had drifted, so an interrupted turn there answered as done and a deleted session left the call waiting |
| A link that is no longer connected ends the tasks asked of its sessions (`observeLinkLoss`, on `machine_status`) | Their events stop reaching the hub, so the end of the turn would never be seen. The sentence says the task was delivered and may still be running there |
| A turn that **completes** while the session's own background work (timers left out) still runs there is paused, as a local child's is (§1.2.1 step 7, #1457): the call answers `done` with the words so far and `paused` naming the work, "its report follows when that work ends and a turn there ends it", the warning that a server left running may make this the final answer, and `read_session` on that session. The asker is then owed the work's last turn end: `LinkedReports.oweAsker` keeps a paused linked report for it on the turn end, before the call is told (`LinkedReports.observe` reads the same event after and finds it paused, so nothing is sent for it), and the later turn there with none of that work left wakes the asker once through the same `reportGate`, person's-turn and loop rules as the orchestrator's linked reports (§1.2.1 step 7). A failed, stopped or person's turn is not paused; an older machine that does not list background tasks never pauses (today's answer); a report another session is owed there is not replaced. The turn the child's own tool starts when that work ends (a task notification, no message of anyone's) is the asker's work continuing: a note goes into it as into the turn the asker gave (`gateNow`: the report is paused, the hub saw the turn begin and the linked report reads it as the work's), and `status`, `wait` and `answer` read it as that turn; a turn a person's message started, or one another session is owed, is refused with the cause named ("the person may be using it there" only for a person's), and a turn the hub did not see begin (a hub swap in it) or a machine that lists no background work (never paused) keeps today's refusal, said as "a turn it started by itself that this hub cannot tie to the work you gave it" (#1576). The asker's new task to the session ends the pause (`releaseAsker`, put back if the send fails), since that ask's own end is what it hears next. A link lost while paused reports as `LinkedReports` does for any paused report ("the link to … dropped before that work ended"). A call that went away first (cancelled, or past its bound) still gets the pause when it collects with no task, while the report is owed; collected after the report went out, the words are plain. Two limits, as for every linked report: it lives in the hub's memory, so a hub swap drops it, and a turn another session or the orchestrator gives the session ends the report owed to the asker, since a turn belongs to whoever sent its message (#1377) | The call used to answer at the first turn end, so work started in the background ("I will summarize when it ends", #1457) lost its result: nothing reached the asker, who went on as if the answer were final |
| `trusted` is carried only when the machine says it | An older machine's absence is "not saying" (`ProjectAccess.to.trusted`), not "not trusted" |
| Cancelling the call stops the wait, not the machine's turn | This host asks the machine to run a task but has no interrupt of its own turn there |
| The machine's own cards are answered by the person in the hub's window | `asking` (the caller answering them) is not built across machines; the call says it waits on the person |

**The other way round** (#550, [plans/remote-hub.md](plans/remote-hub.md) §12.7). A session on a linked machine asks a
project of a hub that turned the machine's switch on (Settings → Machines there, off by default): the machine's
`ask_project` lists each such hub's projects under the hub's name (`LinkedHubs`, links/linked-hubs.ts; asked with
`hub.projects` on the connection the hub offered on, 4 s each), and hands the whole ask to the hub (`askHubProject` →
`hub.askProject`), which runs it as an ask here would (`MachineAsks`, sessions/machine-asks.ts): this computer's card for
the pair in the session that would get the task, remembered once approved (`machine_ask_consents`), the existing
ordinary session, the task as from `<session> on <machine>` (`MACHINE_ASKER`), one level deeper than the asker, and the
answer cut to size. A cancelled call there withdraws a card still standing here. The hub answers nothing else of the
machine (`reverseCalls`).

### 1.2.1 Starting other agents in the same project (`start_agent`, `agent_session`, #561)

An ordinary session can start another agent, Claude or Codex, in its own project and work with it: a Claude session
hands implementation to Codex and reviews the result, without a shell `codex exec` the app does not show. Built on
ask_project's machinery (`Delegation`, `AgentRunWait`, `ASK_WAIT_MS`, `turnAnswer`), in the reader set with its
own budget (`AGENT_TOOLS`, `AGENT_BUDGET_CHARS`).

"The turn's answer" has one rule, `turnAnswer` in `sessions/turn-answer.ts` (#428): the text after the turn's last tool
call, reasoning skipped, messages joined as paragraphs, and with `afterSeq` only the rows after the previous answer (a
queued turn has no user row of its own). A delegation's, a child's and an app's agent's answer read it; a preview
(`previewOf`, the report's "Last response") reads `lastResponse`, the same rule at the last text the agent wrote, and
is cut by `clipPreview` (its head and an ellipsis), on this host and for a linked machine's session (`lastWords`) alike.

| Tool | Arguments → what comes back |
|---|---|
| `start_agent` | `{ task, tool?: string, model?, effort?, difficulty?: light\|standard\|heavy, wait?, worktree?, branch?, lsp? }` → the child's id and name, and its answer (`done`) or `working`; or `pending` with a request handle while the person's card stands (#673), or, with `lowMemory`, while an allowed start waits for memory (§1.2.4, #686). `lsp: true` keeps the child's code intelligence (§1.2.4) |
| `agent_session` | `{ sessionId?, action: status\|send\|wait\|stop\|delete\|answer\|list, text?, card?, ifBusy? }` → the same states, plus `at_rest` (nothing the caller gave it runs; its last answer), `asking` and `answered` (a card in the turn the caller gave it, §1.2.2, #676), `busy` and `queued` (a send to a session busy with a turn that is not the caller's, §1.2.3, #677), `stopped` and `deleted` (a child moved to the session archive; worktree cleanup also preserves local work, #608/#637). `list` needs no `sessionId`: the caller's own children (`askedBy`) still here, each as working, waiting, finished or stopped, asleep or not, its last activity, and a worktree branch not merged yet (#690) |

**Cleaning up after a child (#690).** On 2026-10-14 a parent integrated fourteen children's answers and deleted none of
them until the person said it could; asked why, it said it had forgotten the last step, and nothing it read named it.
Every answer that hands a child's result to the session that started it now ends with one line naming the delete:
`done` and `at_rest` (`cleanUpLine`, `sessions/tool-answers.ts`), and the report of a finished turn
(`ChildReports.cleanUpWords`), which also says how many of its other children are finished and that `list` shows them.
The line says to archive the child once its answer is used and to keep it only if more work on the same thing is coming soon (#1482).
The line is said only of the caller's own child (`askedBy`; under `auto` agent_session also reads the person's sessions
and siblings) whose work is over: not a turn cut short (`interruption`), failed or limited, nor one owing a report over
its own background work (`cleanUpDue`, `sessions/own-agents.ts`). The report counts with the same rule `list` uses
(`ownAgents`, `agentState`: a delegation still running is working, a cut-short turn is stopped, one being archived is
gone). `list` takes `askedBy` only, as status, send, wait and stop do: a `parentSessionId`-only link is the former
worktree manager's, which store step v48 copied into `askedBy`.
The line rides in the answer, not in `start_agent`'s description: it costs nothing until the result is read, which
is the moment it applies. Nothing deletes a child on its own: a delete can drop a branch, and even with the session archive it
stays the parent's or the person's call. Sleep (#568) already frees a finished child's memory.

The optional `tool` is a registry name, accepted as a string by the schema and checked against the
current registry at call time. An unknown name returns an error listing the installed tools; adding
an adapter does not require changing this schema.

Under `auto` (#603), the host's shared `autoBoundaryOpen` decision opens consent,
project trust and same-project ownership gates, with allowances logged. It does not open the agent depth (#867):
`auto` children each starting their own once ran twelve sessions at once (#862). Worktree cleanup keeps local work
in the session archive under every preset (#608).
`agent_session` can status, wait, send or stop any session in the same project, and delete
any worktree session there,
including another parent's child or the person's turn; adapter mid-turn support and the
child's own preset still apply. Deleting a session without a worktree still requires the caller to have started it
(`askedBy` or `parentSessionId` equals the caller), even under `auto` (#637). Observing an app agent reuses its completion watcher, so
`run_agent` still receives its answer and the agent keeps its `safe` preset. Cleanup removes an idle worktree and branch even with dirty files or an unproven tip, after setting aside
local work with the conversation in the session archive (#608). `run_agent`
app agents stay `safe`, and no session gets a preset above its caller. When auto observes another
caller's unfinished delegation, its wait has its own bound and cancellation and returns
`reported: false` while working. It does not consume the owner's report, key, waiter count
or read grants. A stop leaves the owner's failure report and result available, including
cross-project `ask_project` delegations. An observer's mid-turn note rides on a reader of its
own (#646): its receipt is held, and its failure recorded, there and never on the owner's wait,
so the owner still reads its own answer, not the reply to the note, and a refused note does
not fail the owner's delegation. The observer's later `status` and `wait` read that reader (the
reply to its note, or the refusal), never the owner's delegation; a refusal no wait is reading is
said once in the observer's session, as a report is. Self wait, stop, delete and send are refused in
all presets; self status does not create a delegation. A person's own turn or an app request
without a delegation is also observed without registering ownership: the app's existing
completion watcher is reused, or a temporary event reader watches the person's turn and
is removed when the observation ends. These observations do not add a `waitsOn` dependency,
prevent an idle caller from sleeping, or stop the target when the caller is interrupted.

What one `start_agent` call does (`SessionManager.startAgent`, also `AgentStartFlow` in start-agent-flow.ts), with the refusal/card rules
below retained for `safe` and `normal`:

1. **Who may.** An ordinary session (`reader` profile) of a trusted project (#382's rule), above the agent depth
   (#867, `sessions/agent-depth.ts`). Settings → Agents → How deep agents may start agents, a slider from 1 to 3,
   persists `prefs.agentDepth`; a record without it reads as 1 (`agentDepthOf`), so it needs no store migration. A
   session the person started is depth 0; one marked `askedBy`, or working on a task another session gave it (an
   unsettled delegation: ask_project, a fork, agent_session), is one deeper than that session, the deepest link
   counting, and a fork whose requester is gone is at least 1. Two consequences beyond `auto`: a fork the orchestrator
   made has `forkedFrom` but no `askedBy`, so it counts 1 for good and cannot start agents at the default (it could
   before); a session an `auto` caller reaches through agent_session counts one deeper while that delegation is
   unsettled. A child or fork records the depth it was started at (`agent_depth:<id>` in `app_settings`, an app
   setting rather than a column, so an older build leaves it alone; `purgeSession` deletes it), and its depth is never
   less than that: deleting the middle of a chain does not make the rest of it shallower. Sessions made before this
   build have no record and count by their links alone. A caller at the setting's depth or deeper is refused
   under every preset, `auto` included, with an error that names the setting and where it is; at 1, a child cannot
   start agents, and neither can a session handling an active ask_project task. The setting is read at each call
   (and again after the card, below), so lowering it applies to the next start. Forks and ask_project read the same.
2. **How many.** Settings → Agents → Running agents per project persists `prefs.agentCeiling`,
   read at call time. Empty/null means no ceiling under `auto`, `AGENT_CEILING` (4) otherwise;
   zero is unlimited, and a positive integer sets a ceiling per project over all its sessions.
   A child counts while a delegated turn runs; a child on a linked machine (#1038) counts under its parent's project
   while a call waits on its turn or its report is owed (`RemoteAgents.workingIn`); a removed machine's child holds no place,
   and one deleted there while the link was down is forgotten when the link is back (`caughtUp`). Checked before the card and again after it,
   and for a new `agent_session send` turn. The check after the card also takes the place (#673 review,
   `agentStartReserved`): one synchronous step, held through `createSession` until the child's delegation counts it,
   given back if the start fails, so calls at once cannot pass the ceiling together. A fork takes its place the same way
   (`reservePlace`). Once the child's session exists, the caller's gates (`agentStartGateError`) and the preset rule
   are read again with no wait before its delegation; a session that fails them gets no task and goes to the session archive. A request still waiting on the
   person's card holds no place: it may stand for hours, and is counted when it is approved.
3. **Choice.** `tool` defaults to the project's tool; `model` and `effort` to that tool's remembered choice for the
   project (#107). A model or effort the tool's list does not have is refused with the list (`agentChoiceError`;
   an alias the ids or labels contain passes, and a tool that cannot list passes all). The check never holds the call
   (#660): it uses the cached list (one read at a time, kept whenever it arrives, a failed read not retried for a
   minute) and waits at most `START_AGENT_MODEL_CHECK_MS` (3 s) for a missing one; without a list in time the child
   starts on the name as given and the answer says it was not checked (an empty list is said to be empty). A name the
   cached list lacks is refused only after a fresh read (the CLI may have been updated).

   **By difficulty** (#729). A `difficulty` with no `model` takes the person's model and effort for that tool and
   difficulty instead, from Settings → Agents → Models for the agents a session starts (`prefs.agentModels`, the
   whole map in one patch; nothing chosen for it falls back to the remembered choice). A model named still wins
   (`agentChoice` in `sessions/start-agent.ts`). The card names a model the setting chose, "(gpt-6, your choice for
   heavy work)". The setting's model and effort are checked as named ones are: a retired one is refused with the list,
   and the refusal adds "That is the person's choice for heavy work …: tell them, or name a model" only when the
   setting's own model or effort is at fault, not an effort the caller named; one that could not be checked says to
   name a model if the first turn fails, not to start again without it, since the caller never named it.

   The words on `difficulty` and `worktree` are the loose guidance #729 asked for (an agent may ignore them, and a
   project's AGENTS.md wins): light for lookups, small fixes and reviews, heavy for design, security and data loss; a
   worktree for edits that end in a pull request, none for research or edits the person watches live. They are in the
   schema, not in an answer, because a caller needs them before its first call. The child's frame (`agentFrame`) asks
   it to wait for its own background work that ends (a test run, a build) inside its turn before it answers (§7 below).
4. **Consent** (`ensureAgentConsent`). **The project's trust is the consent for a `normal` caller** (#673, owner
   decision 2026-10-14): trusting the project (#655) was already the person's decision about it, and a card in a
   session they were not looking at only made the session work alone. Read at each call, nothing remembered; no
   setting. A `safe` caller gets a card in its
   approval slot, detail `agent_start` (the tool, model, preset and task): allow once, always for this session
   (`always`, kept in memory while this host serves the session), always for this project (`always` with scope
   `project`, the card's ⌥; stored as the project's `project_consents` row of kind `agents`, from and to the same
   project, listed and revoked in Settings → Permissions), deny. `auto` opens it, as before.
   Everything before the child exists (check, card, start) has one bound, `START_AGENT_SETUP_MS` (200 s, under the Codex
   bridge's 280 s): past it the answer says whether a session was created. Refusals and this answer tell the calling
   model to ask the person rather than do the work with its own CLI's subagents (#660).
   **A card is not withdrawn at the bound** (#673). The call answers `pending` with the request id (`ag-…`) as a
   handle, and the setup goes on in the background: the card stays until the person answers. An approval then starts
   the child with its report armed (the caller is told when its turn ends, as with `wait: false`); a refusal, or a
   start that fails after the approval, is told to the caller as a message from Centralu (`HOST_SENDER`). The card
   lives in the caller's single approval slot, which the caller's own next events clear while its turn goes on; it is
   raised again (`raiseHostAsks` in `sessions/host-cards.ts`, not recorded twice) when that turn ends, unless it ended in an error.
   Every way such a card closes (the person's answer, a withdrawal, an aborted call, a handoff moving it) goes through
   `HostCards.closeAsk`, which returns a session to the rest the card was raised from (#428). While it stands
   the request is in the store's `agent_start_requests` (v50): a host swap or restart leaves the row (the leaving
   host's call answers `pending`), and the next host raises the card again (`resumeAgentStart`) and starts the child
   when it is approved. An approval (here or there) first reads again what the start rests on (#673 review): the
   caller is still here, its project still trusted, it is still above the agent depth (it may have begun handling an
   ask_project task meanwhile), and its preset is no higher than the one on the card; otherwise no child starts and the
   caller is told why. Turning trust off withdraws the project's standing cards at once and tells their callers. The
   same caller asking the same task (and tool, when named) while its card stands gets the existing handle back, not a
   second card: a host swap's drain tells a cut call to call again, and that call never read its `pending`. A
   request ends when it is answered,
   when the caller withdraws it (`agent_session stop`), when its call is cancelled while the card stands, or when the
   caller is deleted; each end without a child leaves a notice in the caller's session for the person
   (`Centralu · agent request`), apart from a denial on a card the call was still waiting on, which the card shows.
   In the window, a card raised in a session off screen leaves a card in the top right (`Notices`, kind
   `agent_start`) even while the app is in front, and clicking it opens that session.
   The wait of `wait: true` is cut to what is left of `START_AGENT_CALL_MS` (270 s), so setup and wait together stay
   inside the bridge's bound; past it the answer is `working`, with the report armed.
5. **The child.** A visible session in the caller's own folder (a worktree session's worktree), named from the task,
   marked `askedBy` the caller (drawn indented under it in the sidebar, owner decision 2026-10-12; its header links
   back: "Started by …"), under **the caller's permission preset**:
   never more, and no argument or tool of the caller changes it. The task goes in a frame (`agentFrame`: who asks,
   and that the final message is the answer) recorded as sent by the caller (`from`). After the task come the
   project's **instructions for agents started here** (#1161 item 2, `ProjectInfo.agentInstructions`), when the
   person set any: the rules a parent otherwise repeats in every brief (its own worktree, stacked pull requests, never
   `git stash`), written once in the dialog of the project's menu, "Instructions for agents…", and said in the frame
   to be the person's, from the project's settings on that computer. They are read when the task is delivered, so a
   card that stood a while or a start queued for memory carries what is set then; the orchestrator's children (no
   project) get none, and nothing else (`agent_session send`, ask_project, a fork, which carries the conversation)
   carries them. They are kept as an app
   setting of the project (`agent_instructions:<projectId>`, at most 8,000 characters, gone with the project), not a
   column, so no store step: an older build serving the same store during a swap ignores the key, and its children
   start without them.
6. **The answer.** Waited for by the same wait as ask_project's (`DelegationWaits.awaitTurn`, #428, each wording its own result; paths an answer names are granted by `grantReads`), up to 240 s; past it, or with `wait: false` at once, the answer is
   `working` and the caller is told when the turn ends through the report the orchestrator's `reportBack` uses
   (`awaitingReport` → `deliverReport`). What reaches the model is the part Centralu wrote (#1186): how the work
   ended (finished, failed, paused on its own background work, a usage limit, cut short), the session's id, the
   kind of its tool's error (`errorKind`: overloaded, usage limit, network, refused, other), how to go on, and
   `read_session(sessionId, around=<its last response's seq>)`, which shows the last response and the error, an error
   row being one `role: "error"` line; the last response itself, the error's words, the session's and project's names
   and its tasks' descriptions stay in the stored report and the screen (#120: nothing the reported session, its tool,
   its machine or a name could write goes into the receiver's input; a CLI's error can carry a hook's output, and a
   linked machine's is whatever it sends). A `Reason:` built from an error's text (a note or a queued request that was
   not delivered) reaches the model by its kind too; one Centralu wrote is quoted as JSON. The model used
   to read "intersession message available" and an id alone, for every such notice. A report or notice that cannot
   be delivered (the receiver cannot be woken: its tool fails to start) is logged and kept in memory, and goes in
   once that session takes a message again (`deliverHeld`); it used to be dropped without a word. A call waiting at that moment takes the answer instead, so it does not arrive twice. The marker
   is written to `report_marks` (store v49, #646) as well as kept in memory, so a host swap (#280) does not lose
   it: the leaving host's `detachAll` fails its waits without reporting (`handingOver`), the next host restores
   the marks of the sessions the keeper kept that are still in their turn, which ends under it. It drops a
   mark whose session has no process any more (that turn died with the old host) and one whose kept session
   already finished its turn during the swap, so a later turn the person starts there is never reported as the
   assigned work (#166); that answer stays readable through `agent_session`, and the caller is told once that a turn
   ended during the swap, with the read that shows it, not that the work finished (`tellTurnEndedInSwap`, #1186: it
   used to hear nothing). Paths the
   answer names inside the child's folder become readable to the caller, as ask_project's do.
   Each answer that promises the notice (`working` with the report armed, `pending`) says not to check with `status`
   meanwhile, and that `wait` is the one call that blocks until the end; `pending` no longer names `status`. Each that
   names `send` (`done`, `at_rest`) says to start a new agent for another kind of work, with the task written in full,
   since it starts without the old one's context and the old one's name and role came from its first task (#747: a parent
   called `status` more than ten times in a row, and sent read-only research children the editing). In the answers,
   not the descriptions: an answer costs nothing until it is shown.
7. **Work that waits on its own background tasks** (#721). The caller hears of the work's last turn end, not its
   first. On 2026-10-15 six children backgrounded `pnpm verify` and ended a turn "waiting for verify to finish"; that
   turn used up the report, the turn the verify's completion started finished the work and told no one, and the
   caller, asleep, heard nothing for an hour. Now:

   | Rule | Why |
   |---|---|
   | A turn that **completes** while background work the session's tool lists as running (`liveBackgroundTasks`, timers left out) is still going is a pause: the caller is told once, "The assigned work paused: its turn ended while its own background work is still running (…). If that work is a server or watcher it leaves running, the answer below may be its final one. A final report follows only if that work ends; agent_session(action="stop") on it stops that work and ends the wait", with the last response. The report stays owed (`pausedReports`, with the tasks it paused on; the app setting `report_paused:<session>`). Task descriptions are framed fields (`frameField`) | The caller reads why the child stopped talking, and is not promised an end that a dev server left running never brings |
   | A timer the tool holds (`BackgroundTask.timer`: Claude's `/loop` wake-ups and scheduled prompts) does not hold a report | A loop or a seven-day cron job would hold it for good; the timer keeps the process awake all the same |
   | `agent_session stop` on a paused child stops the tasks it paused on that still run, where the tool can stop one on its own (`stopBackgroundTask`), takes the report down, and names what it could not stop | The caller of a child that left a server running had no way out: it was not kept awake, and `stop` said nothing was running |
   | A turn belongs to whoever started it (#1377). `ChildOwnership` records whose a turn is when it starts (`noteMessage` at each message, `turnStarted` when the session goes busy; the app setting `report_turn:<session>` while a report is owed) and `ChildReports.reportBackIfAwaited` decides at its end: the person's message at rest (no source: what the composer sends, `/compact` and other slash commands included; a caller's, another session's, an app's or Centralu's message always has one) makes the next turn theirs, and it is reported to nobody; the caller's message, an app's or Centralu's, and the CLI starting a turn when the work's background tasks end, make it the work's, and it is reported. A person's message into a running turn is named (`SessionHandle.send` `opts.id`) and kept as pending; whether the turn took it in is decided at its end by the inputs the tool says it took (`SessionHandle.turnInputs`; Claude's result names them, `user_message_uuids`, because it folds a queued input in only at a tool round): taken, it joined the work's turn and the report says so ("The person wrote in this session during this turn."); not taken, it starts the next turn, which is the person's. A tool that takes every message into the turn (Codex steers an active turn) has no `turnInputs`; a CLI that cannot name them (before 2.1.289) takes none in. The pending messages are kept in `report_turn:` too. The host says whose each turn was on the event that ends it (`turn` on `turn_complete`, `error`, `limit_reached`, `state_change`) | A person's message never closes a report (it did, #1340/#1344): asking something mid-way no longer costs the caller the work's result; their own failed turn is still never reported as the work's. The report closes only as before (a work turn ends with no paused work, the caller stops or reads it) or when the person chooses |
   | The person's choice (`agents.send` `intent`; the composer shows "Working for <caller>", `agents.reportOwed`): **Just asking** (default) as above; **Add to the task** (`task`): the message makes the turn the work's, reported as "The person added an instruction to this task during this turn."; **Take it over** (`takeover`): the report closes, the running turn becomes theirs, and the caller is told once ("The person took this session over; its later turns are theirs, and none of them will be reported to you") | The person decides what their message means to the work; the host only keeps the rule |
   | Two limits of that rule, left as they are. **A CLI before 2.1.289** cannot name the inputs a turn took in (`turnInputs` is `null`), so a person's message sent into the work's turn is always taken as held for the next turn, also when the CLI did fold it in at a tool round. If the work's own next turn then starts within `NEXT_STARTER_MS` (15 s), for instance because its background task ended just then, that turn reads as the person's and is not reported. The report stays owed, not lost: the next work turn reports it, or the settle wait does (`PAUSED_REPORT_SETTLE_MS`) when the work had ended. **A host swap** loses what is kept in memory only: the message waiting to start a turn (`nextStarter`) and whose the last turn was (`lastBy`; `report_turn:` keeps the running turn and its pending messages). A swap in the second between the person's message and their turn starting makes that turn the work's under the next host, so it is reported as the work's; and a report the settle wait sends right after a swap can carry the person's last answer as the work's last response | Both are rare and bounded; persisting them would write the person's every message to the store for a window of about a second, so they are said here instead |
   | With no report paused and no turn of the caller's running, `stop` on a child whose own background work still runs (timers left out) stops that work the same way (#718), only when the caller started it (`askedBy`), it is at rest with no card standing, no delegation or wait of anyone is on it, and no report paused over that work is owed to another session (`restingWork`). Work an earlier, finished turn of the person's left running there cannot be told apart from the caller's: `stop` and then `delete` end it too. When nothing could be stopped (only work its tool cannot stop on its own), `stop` fails, naming that work. It waits up to `STOP_REPORTED_MS` (3 s) for the tool to report the end of what it stopped (Claude reports it after `stopTask` returns), so a `delete` right after it is not refused, and says so when the end was not reported yet. Worktree cleanup (`delete`) refused by that work names it, and points to `stop` only for the tasks the tool can stop. A timer does not hold the cleanup, and the delete's `note` names the timers that ended with the process | `delete` refused "still working" while `stop` said nothing was running, so a child at rest with a polling loop left could not be deleted. A turn the person or another session runs there is theirs, and so is the work it starts. A timer is out of `stop`'s reach (`stoppable: false`) and goes with the process |
   | Later turn ends while work still runs say nothing; the first turn end with none left delivers the owed report ("finished", the answer of that turn) and wakes the caller through `deliver`'s resume | One pause notice per task: a Monitor that fires every few minutes would otherwise wake the caller each time. The turns that keep the report are the child's own work, never a loop: a report does not start the reporting session's turn |
   | The work ends with no turn running and none starts within `PAUSED_REPORT_SETTLE_MS` (60 s): the report goes out with the last answer and how each task ended ("background work ended (pnpm verify: stopped) and no turn followed, so the work may not have finished"; "…: completed …" when all completed) | Claude starts the turn within a second (its task-notification); a task the person stopped by hand starts none. Each change of the work starts the wait again, and a turn running when it is up reports at its own end |
   | A failed or stopped turn (error, usage limit, the person's Stop, the #698 reasons) is reported as it ended, work running or not | Those need the caller now; the next turn is not the work's own |
   | A call waiting on the turn (`wait: true`, `agent_session wait`) takes the paused answer, with a notice that the work is not over, and the report is held for the end without a separate pause notice. `status` and `wait` on a paused child read the answer and the same notice and leave the report owed | A read of the paused answer used to take the report down, and with it the end |
   | The turn the child's own tool starts when the paused work ends (no message began it, no person wrote into it) is the caller's work (`ChildOwnership.continuesPause`, the same reading `reportBackIfAwaited` reports it by): `agent_session send` puts a note into it on a wait of its own, as an observer's note, with no `auto` needed and the report still owed; a person's turn or a person's message in it is refused as before, and the refusal says "the person may be using it" only for a turn a person started (#1576) | The note was refused "busy with something else (the person may be using it)" during the turn whose end the caller was owed |
| A paused child at rest does not keep its caller awake (`waitsOn`); in a turn it does | The work may run for minutes or for good (a dev server); the report wakes the caller when it comes |
   | The person talking to a paused child: their turn ends by the same rules, so the caller hears the end once the work is over | The work the caller gave is still the child's; the person's turn does not end it |
   | New work from the same caller (`agent_session send`, a note) ends the pause: that run's own wait or report tells its end. Archiving either session takes the report down | A pause belongs to the work it was told for; held on, it would report the new work a second time |
   | Across a host swap the pause stays with the mark when the keeper kept the child's process (the work runs on there); a host that finds no process drops both, and a kept process that cannot be re-attached reports the work as stopped | The work went with a process that is gone |
   | A handoff moves a paused child with its report; the note says "paused on its own background work; its report comes when that work ends" | Not "finished; its report has not been delivered yet": the new session would wait for a report that is not late |
   | Only a turn the delegation's own wait saw end is judged: the delegation's outcome path reports only a wait that failed with no ending event, or one notes held (`tracksInputs`) | Judged again a microtask later, the pause could read as the end once the work had ended |

   A linked machine's session the hub's orchestrator asked to hear about (`reportBack`) pauses the same way (#723,
   `sessions/linked-reports.ts`). The hub keeps each linked session's task list for every session a machine relays,
   so work started before the orchestrator asked is known: read whole from the machine's `sessions.list`
   (`LinkedSessions.backgroundTasks`) each time its link comes up (`machine_resync`: the first link, after a drop, after
   the hub's start), since a machine resends its work only when it changes, and then changed by the relayed
   `background_tasks` (the same `applyBackgroundTasks`). A change relayed while that read is out is newer and kept. A
   completed turn there with its own work running (timers left out) sends the paused notice once and keeps the linked
   report (`LinkedReport.paused`); a later turn end with none of that work left sends the final report; the work ending
   with no turn after it settles the report after `PAUSED_REPORT_SETTLE_MS`, saying how each task ended; a failed turn
   is reported as it ended. The orchestrator has no `agent_session`, so the notice offers no stop, as for its own
   sessions here; a new `send_to_session` to that session replaces the report, as before. While that send is out, the
   session's events go to the new wait; a send that fails puts the paused report back and starts its settle wait again.
   The machine's link dropping while the report is paused sends it at once, saying the link dropped before the work
   ended and to read the session once it is back (the hub would not see the end), or as settled when the work had
   already ended and only the settle wait was running. A dropped link forgets that machine's task lists until it is
   back. A turn in progress keeps its wait across a drop, as before. The same report is kept for an `ask_project` task there
   whose turn ended on its own background work (`oweAsker`, §1.2.4, #1457): the asking session is its owner, and the call
   was told of the pause when it returned. A turn there belongs to whoever started it, as here (#1377): the hub reads the machine's relayed `user_message`
   (no source: the person's; the hub's instruction, another session's and an app's are the work's) and the turn's events
   (`LinkedReport.next` / `turn`), and the person's own turn is reported to nobody and changes nothing of the wait. A
   person's message into a running turn of the work is noted in its report. The relayed message carries the person's choice
   (`intent`: `task`, `takeover`); `takeover` closes the wait and tells the orchestrator once, with the same line, without
   the machine's words. The machine's host says whose each turn was on the event that ends it (`turn`), and the hub reads that; a host that does
   not say (an older one) is read from the messages the hub saw, taking a message seen while a turn runs as joining it. The
   hub also applies the choice itself as it routes the call (`Router` `forwarding`, `LinkedReports.choosing`): an older
   machine strips the `intent` it does not know, so "Take it over" closes the wait once the machine took the message, and
   "Add to the task" marks the next relayed message. A child `start_agent` started keeps the rule of #1038
   (`RemoteAgents`, which reads the event first): the person's turn there is not the caller's to read, and the caller is
   told. A machine removed from Centralu reports every wait
   on it, paused or mid-turn ("…was removed from Centralu before …, so its end will not be reported"), named as the hub
   last knew the session. A session deleted there drops its report. Linked reports live in the hub's memory: a hub swap
   drops them, as before.

   Codex lists child threads as background work, so a Codex parent thread that ends with a child thread running is
   paused the same way; a tool that cannot report its background work (`capabilities.backgroundTasks` off) never
   pauses a report.

**In a new worktree** (part 2). `worktree: true`, or a `branch`, opens the child in a new git worktree of the
project's repository instead of the caller's folder, through the same path as the new-session window's worktree
option (`createSession`'s `worktree`, `worktreeBranch`, `worktreeBase`: the copy-and-setup step;
`auto` delegation may also create a worktree in an untrusted project). The branch is the one asked for (git's own rule checks it) or one named from the job or from the caller's `name` (`agentBranch`:
`centralu/write-the-parser-1a2b`, at most 40 characters after the prefix, cut at a word, #861), settled before the card, which names it. It forks from the caller's own branch
when the caller is itself a worktree session, so the child starts from the caller's work; otherwise from the
project's trunk as the remote has it (#1484, `resolveForkBase`): the trunk is fetched (bounded, trusted projects only) and the
child forks from `origin/<trunk>`, never from the checkout's HEAD, which may be any branch; with no remote, a failed or timed-out fetch, or an
untrusted project it forks from the newer of the local trunk and the remote-tracking ref last fetched, and with no trunk found at all from HEAD.
The start answer's `notice` names the base commit and what could not be done (a start on a linked machine does not carry it back yet). The recorded base (`baseSha`) is that commit. A project that is no git repository is refused before the card. The child shows as every worktree
session does (its branch is its name; merged and pull-request state, #69/#76), and paths its answer names in the
worktree become readable to the caller. A boolean and a name rather than a `workspace` enum: each is cheaper, and
either alone says what is meant. A worktree child hangs under the session that started it in the sidebar,
as a same-folder child does: the sidebar groups by who started a session (`askedBy`, `orderAsTree` in
`ui/features/sidebar/tree.ts`), and `parentSessionId` still places a former worktree manager's sessions.

**On a linked machine** (#1038, `sessions/remote-agents.ts`). `machine` (a linked machine's id or name) starts the
child on that machine, in its project that is a checkout of the caller's repository: the same `origin` remote on both
sides (`projects.origin`, compared by `gitRemoteKey`, so `git@github.com:me/app.git` and `https://github.com/me/app` are
one repository). No such checkout is refused with that machine's projects and their origins; two checkouts are
refused unless one has the caller's project's name; a machine that cannot be reached is refused as unreachable. The
caller's gates are the same (an ordinary session of a trusted project, above the agent depth) and are read again after
the card. The card is `agent_start` with `machine`: it names the computer, is raised every time, and offers no
"always", as ask_project's card for another machine's project (#700); it is bounded like a local start's setup
(`START_AGENT_SETUP_MS`). An `auto` caller's start raises no card where the machine takes `auto` from this computer
(#1273): the hub asks it first (`host.hubAuto`, its "Allow auto from a linked computer" switch); a machine whose switch is
off, or one from before #1273, gets the card, which says why the child runs under `normal` (`autoWithheld`). The child
is made over the link (`agents.createSession` there) under the caller's preset capped at `normal` (as create_session
over a link, #838) with the caller's preset carried beside it (`fromHub`), which the machine turns into `auto` only for
an `auto` caller while its switch is on, read again at that start (`presetFromHub`); a child made without a card that
did not get `auto` (the switch went off meanwhile) is deleted before it is given its task. The machine marks it
`startedFromHub`, and its row and header show its preset there and on the hub. It is made with the model, effort and worktree
branch asked for (the machine's own rules apply: a worktree needs a project trusted there; `lsp` is not passed, and
the answer says so), and kept one level below the caller in the agent depth on that machine (`agentDepth`, and the
task's turn is sent with that depth too); a machine whose build would drop it is refused, with a line to update it.
Only network remotes match (`gitRemoteKey`), and a refusal names repositories, never the addresses as written. Its
task goes in `remoteAgentFrame`, sent as from the caller ("… on <hub>"), with **the machine's** instructions for agents
started in its copy of the project after it (#1161 item 2), not the hub's: each machine keeps its own, so a Windows
machine's say its paths and its shell. The hub reads them from the machine once the child is made there, after the
card (a machine whose build predates them lists none, and its child starts without them; one that cannot be asked then
gives what it listed before the card); the person edits them in that project's menu on
the hub, which routes the save to the machine (`projects.setAgentInstructions`, by project). A call that waits opens its wait before the
send, so a turn that ends at once is its answer, not a report. The hub records it (`remote_agents`, an app setting) and arms a linked report for the
caller before the send (`LinkedReport`, as the orchestrator's `reportBack`), so the end of its turn comes back as a
local child's does, with the same pause over its own background work (#723); a call waiting on it (`wait`,
`agent_session wait`) reads the answer instead (`RemoteAgents.observe`, read before the reports). `agent_session`
works on it through the link: `status` and `wait` (the machine's state and last words), `send`, `stop`
(`agents.interrupt` there; nothing more is owed), `delete` (to that machine's session archive), `answer`,
and `list` names its machine. **`delete` takes the worktree made for it there too** (#1161 item 3,
`agents.deleteAgentChild` on that machine, `WorktreeSessions.deleteHubChild`), when nothing would be lost by it. Only
that one: a worktree Centralu made (`worktree.base`) on the branch the hub's record names, for a session another
session started (its recorded agent depth), so never the project's own folder, a worktree session of the person's, or
one a child started without a worktree.
Only when nothing is lost: nothing uncommitted in it, and every commit of its own (its checkout's `HEAD` and the branch
made for it, which the agent may have left) on a remote-tracking ref or the trunk (`gitUnpublishedCommits`); a branch
pushed from there passes, a commit only there does not. Then it goes as a local child's does (`cleanUpWorktreeChild`:
its recovery snapshot in the session archive, the worktree and the branch removed). Otherwise the session still goes to the session archive,
the worktree stays, and the answer says what was left and why ("it holds 2 uncommitted files", "it has 1 commit that no
remote and not the trunk has: push …", work still running there, another session in its folder). A folder already gone
is said in the cleanup's own words (#715: its branch kept when it holds commits the trunk lacks), never as "nothing was
unpushed"; a delete asked again finds the session gone and says so. A turn the hub just
stopped is waited out for up to 10 s first (`STOPPING_WAIT_MS`), as the cleanup refuses a session still in its turn. A
machine whose build predates it answers "Unknown method": the hub deletes the session there as before and says the
worktree stays because of that build. A local child's worktree was already removed by `delete` (#608); that is
unchanged. The cards of the turn its caller gave it come to the caller as a local child's (#676): a
wait returns them (`asking`), `status` reads them from the machine (`LinkedSessions.cards`), and a card raised while
no call waits is told once (`cardNotice`); each card's handle names that turn (`RemoteAgent.turn`, new with each start
or send at rest). `answer` takes a question card's answer to the machine (`agents.answerQuestion` there). An approval
card stays the person's on that machine, whatever the caller's preset: a caller's `auto`, which alone lets it answer a
local child's approval, never answers one on another computer, even when its child runs under `auto` there. `send`
into the turn the caller gave it goes in as a note (the machine's `host.send` takes it into the running turn, as the
person's message there; nothing is armed again); into a turn the caller did not give it (the person's there) it is
refused, as neither a queue nor a fork reaches another machine. A note the tool did not read in the turn it went into
runs as a turn of its own once that turn ends, with no message to start it (#1604). The machine's host says which: the tool
names the input a turn began from, the host keeps who sent each message of a hub's it gave the tool under an id
(`ChildOwnership` `noteInputOrigin`: into a running turn or at rest, in the order given, at most 64 a session, in the app
setting `input_origins:<session>`, read and written there each time so a host that takes the session over after a swap still
has them and the one that leaves cannot overwrite what the other wrote). They go as the tool's inputs do: when a turn runs
one, when a turn's end says it took it in, or, for a tool that does not say (Codex), when that turn began after it was given;
a stop, a process that is gone (a crash or a lost conversation, a host that starts with no process for a session its last left mid-turn, a new process) and the session's deletion take off all, and the `state_change` that opens the turn carries
`origin: { seq, from }`, the row of that message and its sender (additive, `TurnOrigin`). Any other error or a usage limit ends the turn and leaves the process, which can still run a message it holds queued as the next turn, so those stay: a stale one is harmless (ids are unique, and the next turn that names a later input takes it off) and a missing one refuses the caller. The tool names the input only
on the event that opens the turn, and the host reads it there whether or not it already had the session working: an
instruction sent at rest in the gap between a turn and the one run for a note before it has the session working before
that turn opens. The tool runs inputs in the order they were given, so a turn that names an input has taken every one given
before it, and all of them leave the host's store (a CLI that runs several notes as one turn names only the last); so do
those a turn's end says it took in. Claude Code names it as `user_message_uuid` on the turn's first message (the adapter's
`turnStartInputs`); Codex, which merges a message sent while a turn runs into it but starts a turn of its own for one sent
just after a turn ended or queued behind a compact or review (`flushPending`), gives its `turn/start` the input's id as the
client id and reads it back from the turn's first item (`item/started`, `userMessage`, `clientId`) with a second
`working` for that turn that names it; a message that joined a turn already running shows after the turn's first item and
names nothing. The hub holds the rows of the messages its caller gave the child that the tool may run as a turn of its own
(`RemoteAgent.given`, in the child's record, so a restart of the hub keeps them): its notes into a running turn, and its
instruction sent at rest. A send at rest does not drop the
rows of the notes before it, as the turns run for those can still be to come. The hub takes a turn for the caller's when its
origin names one of those rows from this hub's sender; its end is then owed as the first turn's was, and a note goes into it.
A row goes when a turn is run for it or for a later one, and every row goes with a message of someone else's.
Nothing is guessed from the time between turns. A turn with no origin is refused, and so is everything after the person's
message. A link's loss or a restart of the hub keeps the rows but not whose the turn is (`unknown`): a turn that opens
meanwhile is not taken for the caller's, and the rows stay for the re-read when the link is back (`verify`): if the machine's
last message is the caller's note, the turn that is run for it afterwards is the caller's. The same read says whether the machine lists the child in a turn (`lastUserMessage`'s `atRest`) and the row of that message: at rest, no turn will open for a message before that one, so the rows before that row are dropped, which settles the turns that opened while the hub could not see them. That message's own row stays: the tool opens the turn run for a queued note a moment after the turn before it ended, with the child at rest in between. An older machine sends no origin
and behaves as before this: a note it runs as a turn of its own stays refused. A refusal names the turn by what the hub saw start it: a person's message, another session's, or no message
at all ("which this hub did not see begin"), never the person without a message of theirs.

What the caller reads of such a turn is that turn's words (#1604). `host.lastAnswer` takes `turn: true`: the answer is
that of the last turn that ended, read from the row the machine saw it begin after (`ChildOwnership.noteTurnStart`, in the
app setting `turn_span:<session>` for a session a hub gives messages, so a host that takes the session over after a swap
reads it), not the last response of the record. A note's row is stored while the turn before it runs, so the last response
joined the two turns' words and clipped them at the report's 600 characters; and a note stored in the middle of a turn's
text ended that text, so a wait read only what followed the note. A caller's notes in a turn (a row that names its sender)
are rows among its text (`turnAnswer`'s `acrossNotes`); the person's message ends it, as it always did. The next turn may
have begun as the hub reads the end of this one: then it is the turn before it that ended, up to where the next began. A turn
that ended with nothing to say has no answer, and the report says so; it is never the turn before's. A turn that never sent its end because its process went (a host that starts with the session left mid-turn, a crash) is closed when that is known (`processGone`): its words are those it said, or none, never the turn before's. A turn the host did not
see begin (before this build) reads as the last response, and so does an older machine.

The person may use the same session on that machine, and nothing of a turn that is not the caller's reaches the
caller (#1038 review, RV13). One gate decides it (`RemoteAgents.gate`), and every path that hands the caller anything
of the child passes it: `status` (in a turn and at rest), `wait` (as it opens, on a card, at the turn's end, and before
owing the turn again when the call is cut short), `answer`, `send` (a start's task, a send at rest, a note into a
turn), a card's notice, and the linked report's text and preview (`LinkedReports` asks `reportGate`: deliver, withhold,
or defer while it cannot tell). The gate reads whose the child's current or last turn is (`Whose`) from this hub's own
evidence: `caller` once the machine recorded the instruction this hub last sent (its `user_message` from this
machine's `HUB_SENDER`, with the text kept as `sent`, not a replay of one seen before) while no other turn ran there
(`busy`, from its events) and nothing else since; `other` once anything else came: the person's message (their words
the same as the caller's included), or the instruction taken into a turn already running (a send that read the child
at rest just before the person's message, a start's task behind the person's first message, a note that arrived after
the caller's turn ended); `unknown` while an instruction is on its way, and from a link's loss or a restart until the
machine's last message is read again (`verify`). Owned, the turn's words are the caller's; live (owned and running,
not held over its background work), its cards, an answer to them and a note into it are too. Not owned, the caller gets
the fact ("a turn you did not give it", "the person is using it there") and the state word: no card, no words, no wait
or report owed for it. Becoming another's ends what the caller was owed: a waiting call returns that fact, and a report
owed is dropped and the caller told, so once the person speaks into the caller's own running turn, nothing more of it
is reported. A turn's end the reports held back while whose it was could not be told is settled once it can
(`settleDeferred`, `caughtUp`). A note that goes in after the caller's turn ended with nothing else running starts a
turn of its own, whose end is owed as a send's is (`tookInstruction`). The table in `remote-agents-boundary.test.ts`
runs every such path against each way the person's turn can come about. When the link drops, a waiting call returns with that
said, and a caller still owed a report is told once that the child cannot be followed until the link is back; when it
is back, the child is read (`caughtUp`, `verify`): what ran there meanwhile is the caller's only if the last message the child
took is the instruction this hub sent it (its text kept as `sent`, from this machine's `HUB_SENDER` as the link
qualifies it; `LinkedSessions.lastUserMessage`). Then a turn that ended meanwhile is reported, and one still running
reports when it ends. Otherwise another's message came after (the person's on that machine), or the instruction never
went in: the caller is told that what it gave the child ended or was set aside unseen, with nothing the child said
since, rather than handed another's turn as its report. The paths its answer names are that machine's, and none
is made readable here. It counts under the caller's project's ceiling (below, "How many"), wherever it runs: the
ceiling bounds how much one project's sessions set going at once, and the machine counts nothing for a session the
hub started there; its start holds a place from the card's answer until its wait or report counts it, and a new
`send` turn is checked as a local one. What is owed of it survives a hub restart: its record keeps `owed` (a call
waits on its turn or its report is armed, with the background work a held report waits on), written whenever its
report changes (`ChildOwnership.onLinkedReportChange`). The next host arms the report again for a caller still there
(`RemoteAgents.restore`; a call that waited is gone, so the end is its report now), and once the machine's link is up
reads the child: a turn that ended meanwhile is reported then, one still running when it ends if it is the caller's
(below), and a held report waits for its work once the link's resync has read it (`LinkedReports.resync`), not
before: a link slow to come up would otherwise settle that work as ended. The orchestrator's own linked reports still live in memory. A child deleted there, or whose
machine was removed, while the hub could not see it is cleared by `list` and `delete`; the caller's session archive clears its
children's records, and a handoff gives them to the heir. In the sidebar it stands in that machine's project, among
the sessions there and with its "Asked by <caller>" mark, since a project on another machine is a project of its own
(#1416; #1038 first drew it under its caller, in the caller's project). The caller's row carries no pointer to it
(owner, 2026-10-26: the "2 on win-pc" pointer of #1416 was removed); the child keeps its row, its mark and its inbox entry. The hub names the
caller as its `askedBy` in that machine's rows and owner events (`LinkDeps.ownerOf`, `SessionManager.remoteAgentParent`)
and sends `session_owner` when it records the child, hands it to an heir, or forgets it with its caller; the mark
follows `askedBy`, so it moves with the heir and goes when the caller does.

**Creator and worktree ancestry** (#637). `askedBy` records who started an agent, regardless of its folder.
`parentSessionId` records worktree ancestry (including former manager children); `start_agent` sets it only
when creating a worktree. Same-folder children keep `parentSessionId: null`. The sidebar uses a present
`parentSessionId` first, then `askedBy`. Keep these fields distinct: changing ancestry for same-folder sessions
would also change worktree consumers. No migration or backfill is needed; deletion without a worktree accepts
either existing creator/parent link, including records reloaded after a host swap. Stored session and archive
shapes stay unchanged, so the previous host can continue reading them during a swap.

**A usable worktree** (#582). Provisioning reuses installed JS dependencies automatically, even without a
configured setup command. With an unchanged root lockfile (`pnpm-lock.yaml`, `package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `bun.lock` or `bun.lockb`), missing `node_modules` folders are cloned from the
project checkout, including workspace packages whose `package.json` is unchanged. Existing folders and links
are left alone. The existing APFS clone / ordinary-copy fallback gives the child independent files: a symlink
to the project's dependencies would let it change the original checkout. Internal dependency links stay;
links escaping the new worktree are removed after all package copies finish. No install or lifecycle script
runs automatically. If dependencies are absent in the project, differ from the child's lockfile/manifests,
or cannot be copied, the configured setup command or the child must install them; creation still continues.
What provisioning could not do (a copy skipped or refused, a link dropped, dependencies or the setup command
failing) is a warning notice at the top of the new session, and a `start_agent` child also gets it in its task,
since an agent does not read notices (#841). A step after `git worktree add` that throws before a session owns
the worktree removes the folder and its branch again (#774); what could not be removed is named in the error.

**Codex sandbox** (#582). Every Codex session whose cwd is a linked git worktree (including a cwd below its
root) adds the canonical `git rev-parse --git-common-dir` to the workspace-write roots, retaining configured
extra roots (#585). Codex keeps `.git` read-only even inside writable roots, so this does not permit commits
or index locks: committing in that repository needs `auto`, or a personal full-access mode under `normal`.
On codex-cli 0.160.0, `thread/start` and `thread/resume` accept `sandbox` as a mode; the details
ride in `config` as `sandbox_workspace_write.writable_roots` and `sandbox_workspace_write.network_access`.
`safe` maps to `untrusted` approval and `workspace-write`, `auto` to `never` approval and `danger-full-access`
(no sandbox, matching Claude's bypass); `normal` keeps the person's approval and sandbox mode.
Workspace-write network access is explicitly disabled for `safe` and `normal`; `auto` has unrestricted
network and OS file access. A person's `normal` full-access sandbox remains full-access. The mapping lives
inside the Codex adapter and applies on both start and resume, so a changed preset takes effect on the
session's next thread. `start_agent` children inherit the parent's preset, including full access under `auto`;
they never receive a higher preset. The adapter reads the effective sandbox from the thread response:
when it blocks network,
`start_agent`'s answer (both `working` and `done`) says "this child cannot reach the network under <preset>".
An `auto` child has no network restriction notice. The manager carries an optional adapter notice;
no CLI-name test decides this outside adapters.

**Claude comparison** (#582). Centralu supplies no Claude SDK `sandbox` override, for children or ordinary
sessions. Both use the same permission mapping (`safe`: `default`, `auto`: `bypassPermissions`, `normal`:
the person's settings, falling back to explicit `default`) and project-trust settings sources. There is no Centralu-imposed child-only git-root
or network gap. A sandbox in the person's own Claude settings can still restrict commands; Centralu does
not widen it here. Dependency preparation above applies to both adapters.

**The person's input is stamped as theirs.** The Claude Agent SDK's user message has an `origin`; an absent one is
"unattributed" and fails closed at the CLI's strict `isHuman()` trust gates. `SessionManager.send` takes `fromPerson`,
which only `agents.send` (the composer, slash commands, the person's Continue) sets.
`SessionEvents.deliver` hands it to the handle as `send(text, { origin: { kind: 'human' } })`, and the Claude adapter
writes `origin: { kind: 'human' }` on that stdin message. A message with a source (a caller's delivery, a report), an app's
notice or view message, a builder request, a new session's first message (only the UI's handoff opening, which quotes an
agent's note), a message with a Centralu line in front of it (`rootAppsNotice`) and every note through `sendTracked` carry
none, as before. One known gap: the handoff request the UI writes for the predecessor goes through `agents.send` and is
stamped, since the host cannot tell Centralu's text from the person's there. Measured on CLI
2.1.296: the CLI accepts it, echoes it on the replayed user message, and answers the same with or without it, mid-turn
wording and `/compact` included (`docs/plans/mailbox.md` §7.1).

`agent_session` normally acts on a session whose `askedBy` is the caller, in its project (the `auto` exception is above).
Deleting a child without a worktree also accepts `parentSessionId` as its ownership link. `send` during the caller's turn
uses the adapter's ordinary message path when it declares `capabilities.midTurnInput` and provides `sendTracked`:
Codex 0.160 `turn/start`
steers an already-active regular turn (confirmed by `TurnStartParams.turnTrigger`; compact/review messages keep
their existing queue), and Claude queues a user message for the query's streaming prompt iterator. It returns
`working` immediately and holds the original delegation until every note's completion receipt finishes. Codex
binds a receipt through the input's `clientUserMessageId` / `userMessage.clientId` and the `turn/start` response's
turn id, even if that response follows its completion notification;
notes during compact/review can share a later turn. Claude stamps input UUIDs and uses the result's
`user_message_uuids` to identify consumed notes, including folded batches. Receipts complete only by matching
UUIDs: a sign-in-race retry can reorder delivery, and a capped list never proves an omitted input was consumed. At initialization, the adapter
requires the verified CLI protocol (2.1.289 or newer, compared as semver, so a suffixed version such as
`2.1.290-beta.1` counts) and its `interrupt_receipt_v1` and
`interrupt_cancel_queued_v1` capabilities before exposing `sendTracked`. Older or unknown producers keep the
mid-turn refusal: the single `user_message_uuid` names the turn's first input and cannot confirm a folded note.
Results without input IDs belong to synthetic turns (including background-task notifications) and neither
complete nor cancel a pending note. Stop cancels pending notes too
(Claude's SDK `cancelQueued` / control-request `cancel_queued`; Codex removes queued notes and interrupts a turn
named by an in-flight response after Stop). Claude reports person messages dropped from its local queue or
listed as cancelled in the SDK interrupt receipt as **not delivered**, asking the person to resend them. A turn error instead cancels only parent notes, via the SDK's optional
`cancelAsyncMessage` / `cancel_async_message`, and preserves the person's local/SDK queue. Without that SDK
method the CLI queue is left intact; the failed delegation still receives the turn's error. SDK cancellation
is also skipped while person input is pending: cancelling an already-dequeued representative UUID can drop its
whole coalesced batch. Only batches without person input are eligible for per-UUID cancellation.

The existing `wait` and report marker follow the whole delegation, so an intermediate turn cannot deliver an
answer or detach the queued note from its parent. Each completed turn's answer is captured separately: queued
input was already stored before the earlier answer, so those turns need not have a user row between them.
The adapters notify the host synchronously **after recording the matched completion**, so later frames in the
same event batch cannot overwrite that answer. Pending notes also make the child non-idle between turns, so the
sleeper, CLI replacement and deferred settings/instructions restart cannot discard queued work. Deferred
restart markers remain set while input is held. Since adapters complete receipts after emitting `turn_complete`,
the last receipt re-checks the restart when the session is not mid-turn. New input waits for disposal and resume,
so the next task uses the updated settings, app set and launch policy. The person's
Stop is marked before calling the adapter, including adapters that reject receipts synchronously. A follow-up is framed as a **note about ongoing work**
(`agentNoteFrame`), without the initial task/answer frame, and stored and shown with `from`.
A `send` after the child finishes starts a new delegation and uses the task/return-answer frame (`agentFrame`).
It is refused on an adapter without this capability, while the child works on something else
(the person may be using it), or when the person has since raised its preset above the caller's (`presetWithin`).
`stop` ends the turn the caller gave it; a turn the person started there is theirs.

**Stop and delete.** The caller's call cancelled (Claude's MCP signal), or Stop on the caller while a call waits on
a child, stops that child's turn. A child left running (`wait: false`, or past the bound) is its own session: the
caller's Stop does not reach it, it has its own Stop. Deleting the caller drops its waits and its session consent;
the children keep their turns and their link.

**Deleting a child without a worktree** (#637). In every preset, the caller may delete only a session it started
in the same project (`askedBy` or `parentSessionId` equals the caller). The host uses the sidebar's
`trashSession` path (the session archive's entry point; the archive was called the trash until #1404, and the code names keep that word): withdraw a pending wake, settle waits, dispose the child process if present, flush streamed
messages, then move the session to the archive and emit `session_deleted`. Mid-turn deletion requires the caller's
own unsettled delegation, including while the parent is working; it does not stop the parent's turn. If the
person has started another turn, or an approval/question remains without that delegation, deletion is refused
until that work finishes, even under `auto`. History and the tool's conversation remain restorable.
Concurrent sidebar and agent archive requests share one operation per session: the first request's options and
result apply to both, with one process disposal, store write and deletion event.
The result is `deleted` without worktree/branch recovery fields. A session belonging to another caller, an
unowned session, a session in another project, and self-deletion are refused.

**Deleting a worktree child** (#608, decision owner 2026-10-13). In every preset the parent decides whether
to remove its child: neither uncommitted files nor an unproven merge refuses deletion. A working child must
finish or be stopped first. A worktree folder that is already gone (#715) holds no work to lose, so deletion
goes ahead without a snapshot: the session goes to the archive, `git worktree prune` drops git's stale entry, and
the branch is kept when it has commits the trunk lacks (or when that cannot be told) or when another
worktree has it checked out, and removed when it has none. "Gone" means `lstat` failed with ENOENT and the folder
above it is there; any other error, or a missing parent (a volume not mounted), is refused with "Cannot reach the
worktree folder" and nothing is removed. The note says git's entry was pruned only when `git worktree list` no
longer shows it. The answer carries a `note` saying so in one line. A merge run as `gh pr merge --delete-branch` beside a
worktree removes that folder this way (gh deletes the local branch, so it removes the worktree that holds it),
which is why the project board's `merge_when_green` deletes the branch on GitHub only. The session never
becomes a same-folder deletion: it keeps its worktree metadata. Cleanup refuses a child still waking/restarting, blocks sends/resumes, and requires
successful disposal of the idle CLI before snapshotting. It is also refused while any other session has its
folder inside the worktree (#647), asleep or not: a helper the child started without a worktree of its own
works there, and after a host swap no session has a process, so a message would wake it right in the folder.
The answer names those sessions so the parent deletes them first. While a cleanup runs, every session whose
folder is inside that worktree is held like the child itself (no send, wake, resume or fork), and the
occupants are checked again after the snapshot and again after archiving: one that came in meanwhile (restored
from the archive, opened there) keeps the worktree in place, with the snapshot kept. A sidebar delete already
under way refuses it too, and a cleanup cannot join a delete that started first: that delete's archive record
carries no recovery snapshot, so the worktree stays in place for that path. Failed capture leaves the worktree and branch in place. Once captured,
the session goes to the archive, then git removes the worktree (including initialized submodules) and branch.
After archiving, removal errors return `deleted` with a warning naming the leftover worktree/branch and
recovery location. The parent cannot retry an archived session through `agent_session`. Capture errors still
return a refusal before archiving. The
tool's conversation remains. The answer reports the uncommitted file and commit counts, or that nothing
needed setting aside. A saved notice also offers the recovery directory in the archived conversation. Counts
count the union of HEAD and the stored branch against the configured local trunk (project HEAD if unset),
not a GitHub merge badge; squash/rebase commits may therefore be kept conservatively. An unreadable trunk
keeps all reachable commits. Submodules count local HEAD/branch commits and gitlink targets from the
index, HEAD tree, and every unmerged superproject commit against their remote refs. The configured trunk's
history is scanned too (#623), when the project has modules: a gitlink merged there still names a module
commit that may exist only in this checkout's private repository, so a commit that no remote has is kept even
though the superproject history that records it landed. Candidate gitlinks
are batch-checked in each module repository; unfetched objects are skipped because removing this
checkout cannot lose them. Existence checks set `GIT_NO_LAZY_FETCH=1` and disable transports with
`GIT_ALLOW_PROTOCOL=`; the latter also prevents network access on Git versions that predate the lazy-fetch
switch. A single raw log scan and one HEAD tree listing stream to temporary files,
so history length does not require one process per commit or fit in the stdout buffer. Historical
`.gitmodules` names associate renamed paths with their initialized module; each distinct manifest is read
once. Capture includes intermediate commits and the stored branch even after the submodule HEAD moves away. Gitlink-only targets get
temporary named refs in the bundle so they remain fetchable after the private module repository is removed;
the temporary refs are removed from the live repository after bundling. Revision lists, bundle refs, and
temporary ref updates use stdin, keeping large module histories below Windows command-line limits.
The raw log explicitly uses `--diff-merges=separate`, independent of the person's `log.diffMerges` setting.

**Git compatibility.** This repository does not otherwise pin a minimum Git version. Recovery capture
requires Git 2.31 or newer: that release introduced both `--diff-merges` and `bundle --stdin`
([upstream release notes](https://raw.githubusercontent.com/git/git/v2.31.0/Documentation/RelNotes/2.31.0.txt)).
Older Git fails capture before deletion; upgrade Git to use recovery. The lazy-fetch switch arrived in
[Git 2.45](https://raw.githubusercontent.com/git/git/v2.45.0/Documentation/RelNotes/2.45.0.txt);
on 2.31–2.44 the empty protocol allowlist still prevents existence checks from reaching a remote.

The archive record's optional `recovery` JSON field remembers the snapshot id, tip and counts; this is additive and
needs no schema migration. Files live at `<data>/worktree-recovery/<session id>/<snapshot id>/`:
`0.patch` holds the root's working changes from HEAD, `0.staged.patch` its staged changes, `0.bundle` a
self-contained bundle of both HEAD and the stored branch when commits are absent from the trunk, and
`snapshot.json` the tip, repository map and exported refs. Initialized submodules use subsequent numbers, recursively. Binary files and symlink
targets are preserved; ignored untracked files are excluded. A private temporary index captures the
working tree without changing its real index; hooks and filters are disabled to keep the bytes on disk.
Git writes patches directly with `diff --output`, preserving CP949/Latin-1 text bytes without a stdout buffer
limit. Before any `git add`, a preflight refuses input above 256 MiB across all initialized repositories
(tracked and non-ignored untracked working files plus changed staged blobs). It leaves the files and index
untouched. Add/diff allow 120 seconds. The index is removed after capture. Clean, merged work creates only the small restore metadata, no patch
or bundle. Archive byte totals include recovery files.

Restore recreates the root branch/worktree at its saved tip and attempts both patches before making the
session live (its CLI remains stopped). If the original branch name is occupied, it uses `recovered/<session id>`.
An occupied original name is left alone, whoever made it. A recovery name is taken over when it is free, or
when restore made it (#647): `git worktree add -b` creates the branch before the folder, so a failed attempt
leaves the branch behind, and a retry reuses that leftover instead of failing on it. The mark is a ref under
`refs/centralu/recovered/<branch>` at the saved tip; restore creates the mark and the branch together, both
with the same one-time reflog message, and adopts a branch only when its creation entry matches the mark's.
A branch the person deletes and makes again at the same commit has a new reflog, so it is never adopted and
a numeric suffix is used instead: a later cleanup never deletes a branch the person made. A cleanup that
deletes a recovery branch deletes its mark too, so saved commits do not stay reachable for good.
If HEAD and the bundled stored branch differ, restore also creates `recovered/<session id>-stored-branch`
at the stored tip and names it in the notice. An occupied recovery name gets a numeric suffix; a retry
reuses a branch already at that tip. Existing branches are never overwritten.
A notice offers the recovery paths and `git apply` / `git fetch <bundle> <ref>:<branch>` (`git bundle list-heads` lists saved refs) instructions; patches
that cannot be applied and all submodule recovery remain available for manual recovery. A restore interrupted
after creating the worktree does not reapply patches on retry, to preserve possible edits since the interruption.
A `patches-applied` marker records the worktree path after both patches succeed. On retry the notice
reports that prior success, preserving any subsequent edits. Without that marker it explicitly says
patches were not applied on this retry and may need manual recovery. Recreating a missing worktree
clears the old marker before applying patches again. Each later deletion uses a new snapshot so earlier
files are retained. Deleting for good, including delete all archived sessions, removes the entire session recovery directory
only after the rows are gone (#647): the directory is first moved aside, which fails where removal would and
leaves the archive entry retryable, then deleted once the database step succeeds, or moved back when that step
fails, so the entry stays restorable. A folder that cannot be moved back is logged and left aside under
`<session id>.purging-<random>`; at startup such folders go back under their session's
name while the entry is still in the archive (joining any snapshot made since), and are deleted once it is gone,
so a crash at any point of a purge is repaired. Purge and restore wait for that repair; a folder that cannot
be repaired (held open on Windows) is logged and retried at the next start, and the others go on. No automatic archive expiry is implemented; expiry
must use `purgeSession` if added. A superproject merge does not prove that module commits were pushed, so
gitlinks in merged trunk history are scanned like unmerged ones (#623). Writes by other programs during capture are outside this session's lock.

**Size.** The two definitions are 1,357 characters (`AGENT_BUDGET_CHARS` 1,375; 1,332 before #861's `name`, a bare string; 1,085 before #729's `difficulty` and the words on it and on `worktree`, +247 characters and +68 tokens, measured, in every ordinary Claude request, whose resident Centralu part goes from 2,313 to 2,560 characters; 1,060 before #686's `lsp`, which carries no description; 990 before #677's `ifBusy`, 956 before #676's `answer` action and `card`, 992 before the registry-name schema, 918 before the worktree arguments, 974 before `delete`). Claude loads `start_agent` (a request
made in words, like ask_project's, which deferred was not found) and defers `agent_session`, which every
`start_agent` answer names; Codex reaches both through its `exec` tool. Measured in tool-cost.md §10: +170 tokens per ordinary Claude request (412 → 582); "Have Codex …" reached `start_agent` 3 of 3 on Claude, "another agent" went to each CLI's own sub-agents. `name` (#861) is a short name
the caller gives: the child's name in the sidebar, and what its new worktree's branch is made from. Without one, the
child is named from its task (a worktree child by its branch), skipping the leading words the task shares with a
sibling's name (`distinguishingText`, at least two of them), and the person renames it.

**stdout is reserved.** `main.ts` prints exactly one line to it: the handshake the Tauri
supervisor parses for the port and auth token. Everything else goes to stderr, because that
is what `log-file.ts` tees to `~/.centralu/host.log` — and a `.app` launched from Finder has
no stdout destination at all, so a `console.log` here reaches nobody in production while
looking fine in a terminal. `no-console` in `eslint.config.js` enforces this everywhere in
the package except that one line.

**On Windows (#14)** the host runs on the direct path (there is no keeper), started by the app
with no console window; its children share that windowless console. Processes and folders differ
in five ways, each in one place:

| What | macOS and Linux | Windows | Where |
|---|---|---|---|
| Finding a tool | PATH, augmented from the login shell | PATH with PATHEXT, absolute entries only; npm/pnpm `.cmd` shims read for the `.js` or `.exe` they start, a shim that starts another (Yarn v1's global bin) followed up to three deep, and Node's own `npm.cmd`/`npx.cmd` (a different shape: variables, and a newer npm in the global prefix preferred) for their `npm-cli.js`/`npx-cli.js` | `env-path.ts`, `tool-launch.ts` |
| `git`, `gh`, an app's command | by name | by absolute path: given a bare name, Windows looks in the working directory (the project) first. Never a `.cmd` (Node refuses to spawn one): the `.exe` its shim starts, or the first `.exe` on PATH. An app's command given as a path is taken from the app's folder, with PATHEXT tried when it has no extension (#849) | `tool-launch.ts` `programPath`, `resolveCommand` |
| Ending a tree | process groups, TERM then KILL | `taskkill /T /F`, one shot; a pty's `kill()` gets no signal, and only when taskkill could not end the tree: node-pty's own kill after it listed a console that was gone and killed the shell's pid 5 s later (#857). What an app left running after it ended is found by parent links and creation times (one PowerShell CIM listing, ~0.5 s) and ended the same way | `dev-services/kill-tree.ts` |
| Terminal / Run button | login shell `-l` / `-lc` | `pwsh` or Windows PowerShell, `-NoLogo` / `cmd.exe /d /s /c`, on the ConPTY node-pty ships (`useConptyDll`, `conpty/` in the bundle): Windows' own left a `conhost.exe` per tab and command until the host exited (#849) | `dev-services/terminal.ts`, `dev-services/pty-slot.ts` `spawnPty`, `os.ts` `usesShippedConpty` |
| Watching the file tree | one watcher per expanded folder | one recursive watcher on the project's root: a watched folder, and every folder above it, cannot be renamed or moved (#849) | `dev-services/watch.ts`, `os.ts` `locksWatchedFolders` |

Quitting closes the host's stdin (it runs with `--watch-parent`, so EOF runs the same shutdown as
TERM) and ends its tree with `taskkill` only if it is still running after the grace period. A
worktree setup command runs under `cmd.exe`, so it reads `%CENTRALU_WORKTREE%`, not
`$CENTRALU_WORKTREE`.

**Its work ends with it; a terminal's does not (#1067).** Windows does not end a process's children when it ends. A
host that crashed or was ended left behind whatever its work had started through a program that is not Node: codex's
MCP servers, a dev server a Run command's PowerShell started, what a git hook started. libuv's own job lets a child's
children leave it silently, and what a ConPTY starts leaves it too. At start the host joins a job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway, and holds its only handle (`lifecycle/work-job.ts`, the `work
job` start step; one PowerShell, run while the store opens). From then on nothing it starts can leave: libuv's job ends
what can no longer leave it when the host ends, and the job's own flag ends the rest (the test reads the flag back).
Breakaway stays off because Git for Windows' sh asks for it, and a hook's children then outlived the host.

Terminals are the person's, not the host's work: what is started in one (`code .`, the browser `claude auth login`
opens) must outlive a host that crashes. They are started by a broker the host starts **before** it joins
(`dev-services/broker-pty.ts`, `pty-broker.mjs` beside the host): a Node process that owns node-pty and speaks one
JSON line per message over its stdin and stdout, behind the same node-pty-shaped surface as the keeper's ptys. It ends
with the host and its pseudoconsoles with it, so the shell ends as before, but what the shell started outside its
console stays. A quit still ends each terminal's tree as before. Run commands, agents, git and app servers stay in the
job. A broker that cannot start, or ends, leaves new terminals to start in the host. Under a keeper the host joins no
job, since the keeper holds what must outlive a host swap. The host opens nothing for the person: "Open in IDE" and
`system.openUrl` are the window's. A host that cannot join (PowerShell refused, an outer job that forbids it) says so
in its log and runs as before.

**How a Claude process is started on Windows (#353).** Claude Code installed with npm is one
program, `node_modules\@anthropic-ai\claude-code\bin\claude.exe`, which npm's `claude.cmd` starts
and which the host starts directly since #307. That file is a second name (a hard link) of the
platform package's `claude.exe`. Windows lets a running program's names be renamed, and deleted
while another name remains, but never deletes the last name or writes over it. An npm update
deletes both names and creates new files; with a Centralu session running from `bin\claude.exe`
the second deletion is the last name and fails, and Claude Code's setup step (`install.cjs`) then
leaves npm's 500-byte placeholder behind: a text file named `.exe` that Windows calls a 16-bit
program. So, on Windows only (`adapters/claude/exe-link.ts`, `start-gate.ts`):

| Step | What happens | Why |
|---|---|---|
| Placeholder check | an `.exe` under 1 MB that does not start with `MZ` fails the session start, and `detect`, with the file, the cause and the fix (`node "<pkg>\install.cjs"`, or reinstall with no Claude Code running) | a spawn error would only say "16-bit program" |
| Hard link | the program is hard-linked into `<data>\tools\claude\<version>-<size>\claude.exe` (data = `CC_DATA_DIR`) and started from there; a copy when linking fails (`EXDEV`, `EPERM`); npm's path itself if both fail, with a log line | an npm update deletes both of npm's names for the program and creates new files there; Windows refuses to delete the last name of a running program, so with a session running from npm's name the update fails, and with one running from the link it succeeds (measured on NTFS); a link costs no disk |
| Link key | the version from npm's `package.json` next to the program plus its size; outside npm, size and modification time | free to read; `--version` would run npm's file, a content hash reads 250 MB per start; npm stamps every file with one time |
| Cleanup | a link folder goes when no session of this host runs from it and it is not the one new sessions use: at host start, when the installed version changes, when a session's process ends | removing a link never disturbs a process running from it; Windows refuses only the last name of a running program, and that folder goes on a later sweep |
| Spaced starts | Claude processes start one at a time, 1.5 s apart | the sign-in is a file with one refresher at a time; processes started together all refresh an expired token at once |
| Refresh race | a turn that ends with "another Claude Code process is refreshing it" is sent again once after 3 to 6 s, with a notice in the conversation; a second loss is reported | the CLI calls it transient; the other process has written the new token by then |
| Leaving | on quit the host waits up to 1.5 s for the Claude processes it closed to exit on their stdin EOF | a Node process takes its children with it when it exits, which could cut a refresh mid-write |

The retry runs on every platform (it costs nothing where the race never happens); the rest is
Windows only, because macOS and Linux replace a running program without complaint and macOS keeps
the sign-in in the keychain. Ending one session needs nothing extra: on Windows the SDK closes the
CLI's stdin and kills it only after 7 seconds. A process that is mid-turn when the host quits is
still ended with the host, as before. A Claude Code update installed while sessions run is picked
up by each session's next start; the old version's link goes once its last session ends.

**How a Codex process is started (#568).** `npm i -g @openai/codex` installs `bin/codex.js`, a Node wrapper that
finds the platform binary (`@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex`), starts it and stays alive only
to forward signals. Measured on codex-cli 0.160 (macOS arm64): an idle `codex app-server` started through the
wrapper is 44 MB of `node` plus 115 MB of binary; started directly, the 115 MB alone. So every Codex client the host
starts (a session's app-server, in the keeper or not, and the short-lived ones for usage, models, history, fork and
delete) starts the binary where the wrapper would find it (`adapters/codex/native.ts`): nested in the package
(npm), beside it (pnpm, hoisting installs), or the package's own `vendor/`. It sets what the wrapper sets,
`CODEX_MANAGED_BY_<NPM|PNPM|BUN>` and `CODEX_MANAGED_PACKAGE_ROOT`, which the binary reads for its update hint and
its install check; it finds `codex-path/rg` and `codex-resources` beside itself. Anything else (a Homebrew cask, a
binary on PATH, a wrapper whose platform package is missing, a platform the wrapper does not know) starts as found.
`CC_CODEX_NATIVE=0` starts the wrapper as before.

The one addition (#280): under the keeper (`CC_KEEPER=1`), the host also writes
`{"activity":{"busy":true|false}}` to stdout, once at start and whenever it changes
(`keeper-link.ts`). That is what the keeper's idle rule reads. Started any other way, the host
writes nothing but the ready line.

### 1.2.2 Cards in a delegated turn (#676)

When a session works on a turn another session gave it, the cards it raises in that turn go to that session as
well as to the person (owner decision 2026-10-14, the child-question rule of #561 option B, scoped tightly). The turn
is **delegated** when another session's work starts it: `ask_project` into a session at rest, `start_agent`, an
`agent_session` send that starts a turn, `send_to_session` to a session at rest, and `create_session`'s first
message (#1233). A task or note that joins a turn already running (the person's, or someone else's) gives no one that
turn, and never clears a report mark someone is owed of it (#1233, `domain-model.md` Report mark).

- **The link** (`turnOwners`, `ownTurn` / `releaseTurn`): session → the session that gave it the turn. It ends with
  the delegation's outcome (`startDelegation`), or with the turn for `send_to_session` and `create_session`. A card from a later turn the
  person starts there never goes to the caller. Written to `delegated_turns` (store v51) as well as kept in memory:
  the leaving host's `detachAll` keeps the rows (`handingOver`), and the next host restores the links of sessions the
  keeper kept that are still in their turn, ending each with that turn; any other row is dropped. The kept CLI sends
  its standing card again to the new host (§4.3); `told_cards` stops a second notice.
- **Delivery** (`routeCard`). A wait of the caller on that turn (`agent_session` wait, `start_agent` waiting,
  `ask_project` waiting) returns `asking` with the cards. With no wait, one notice goes into the caller's
  conversation, marked as from the session, as a report is (`tellCardRaised`): host-written words naming the
  session's id and the call that reads the card. Never the card's text: the question, its options and an approval's
  detail are the target's words, so the caller reads them as a **tool result** (`agent_session` status, or
  `read_session` for a directing seat), fenced as JSON (`cardsText`), not in the person's seat.
- **Answering** (`answerRoutedCard`). A question: `agent_session` `answer` (an ordinary session, also across
  projects for an `ask_project` target: only status and answer there) or `answer_question` (the orchestrator; a rare
  command, so through `centralu_run` in the default tier; a coordinator only reads). `text` is the answer, one line
  per question, `;` between a multi-select's choices, or a JSON array; a choice naming an option is that option's
  label (`answersFrom`). The card stays in the session for the person; the first answer lands, a later one finds the
  card gone. An approval: the caller is told, and may allow or deny only when **both** hold at the answer
  (`answersApproval`, the rule of #603/#606): the caller's own preset is `auto` and it is not an app's agent, and the
  session running the turn is `normal` or `auto` and not an app's agent (owner decision: an `auto` orchestrator may
  approve for a `normal` session). A `safe` session's approvals stay the person's whoever gave it the work: the
  caller's `auto` never raises the target's permissions. Never a card the host raised in that session; "always" stays
  the person's.
- **Which card** (#679 review). The caller reads each card by a handle, `<request id>.<digest>`, the digest over the
  delegated turn (`turnId`, stored with the link) and what the card asks (`cardHandle`), and its answer must name
  that handle. An adapter numbers its requests again in a new process (`req-1`, …), so a request id alone could carry
  an answer meant for an earlier card onto a new one in the same session, or into a later turn; a handle that matches
  no standing card is refused, and the caller reads the card again. `told_cards` keeps handles too, so a new card
  under a reused id is told.

### 1.2.3 Requests to a busy session (#677)

When session B asks session A for work (`agent_session` send, `ask_project` to an existing session, `send_to_session`)
while A runs a turn that is not B's (the person's, another session's delegation, an app's), or while requests are
queued ahead, Centralu does not decide for B (owner decision 2026-10-14). The request tool returns `busy` with the
choices, each marked available or not and why (`busyChoices`), and sends nothing; B calls again with `ifBusy`, or
passes it up front. The answer also says where A's turn is and how many requests are queued there already (`progress`,
`ahead`, #1186), so B can choose knowing what it waits behind. Queueing by default, as #1186 proposed, is not done:
the owner's decision above leaves the choice to B. B's own running turn there is not busy for B: a note into its own work goes on as before. Messages
the person sends are unchanged. The answer says which choice ran and its handle.

| `ifBusy` | What happens |
|---|---|
| `note` | Today's mid-turn note (#594/#606/#653): only when B's own preset is `auto`, and only on a CLI that takes input mid-turn (`send_to_session` sends as before). The turn's answer stays its owner's; B reads the reply to its note on its own reader. Not into another caller's `ask_project` task. |
| `queue` | Held (`queued`, `enqueue`) and delivered as a new turn B owns when A's running turn ends (`drainQueue`, from the turn's end and the boundaries that free a session): B's delegation for `agent_session` and `ask_project`, its turn for `send_to_session`, each framed as that tool frames its work, with the report when it ends and its cards (§1.2.2). One at a time, oldest first. The answer is a handle (`qr-…`) and the place in the queue; `agent_session` status (or `ask_project` with no task) says where it stands, `stop` withdraws it. Written to `queued_requests` (store v52): `detachAll` delivers nothing (`handingOver`), and the next host delivers a request when the kept session's turn ends there, or soon after start for a session at rest (a kept one after its adoption, so its input never starts a second process). A request whose session or requester is gone is dropped, as are those of an archived session. Before it goes in, the request tool's gates are read again with the requester's preset as it is then (`queuedGateError`): for ask_project its trust and depth, the target project, and the pair's remembered consent when only `auto` let the request pass without one (`openedByAuto`, stored as `queued_requests.opened_by_auto`, store v54, so a swap keeps it; a row an older build wrote is read as marked when the pair has no remembered consent); for agent_session the ownership a requester that is not `auto` needs and the preset rule. A request that fails them is dropped with its requester told. A requester moved off `auto`, or handing off to a successor that is not `auto` (`moveChildren`, the original is told), drops at once what only `auto` let through (`dropOpenedByAuto`: a marked ask whose pair still has no remembered consent, a send to a session it did not start); one being delivered at that moment is left to the delivery gate, which reads the stored mark if a swap delivers it again. Its caller's project losing trust or being removed, and the person revoking the pair, withdraw queued `ask_project` requests the same way (`withdrawReaches`); trust and a revoked pair leave an `auto` requester's requests, which the delivery gate reads again. **Delivery** (#684 review): one drain per session at a time (`delivering`), which reserves the session before its first await, so waking a sleeping session counts as busy and lets no second request in; the request stays first in the queue and its row stays, marked `delivering_at`, until the session's turn actually starts, and only then is it taken off. A swap or crash in between leaves the row, and the next host delivers it again: at least once, with one duplicate possible when the old process took the input without a word before the swap. A deferred restart is not waited out by the drain (`deliver` waits for it), and its end schedules the drain again. A row being delivered is left out of `withdrawReaches` and `dropOpenedByAuto`, so its gate (`queuedGateError`, for every tool) is read once more after that wait and any wake, before the task is written (`stillAllowed`). A remembered pair consent revoked in that window does not stop it: being delivered counts as running, as a delegation already running is left to finish (`revokeProjectConsent`). A retry of the same request (requester, tool and words) returns the handle already held instead of a second entry. |
| `fork`, `fork_read` | A sub-session from a copy of A's conversation now (`forkFor`): the adapter's `forkConversation` (Claude: the SDK's `forkSession`, which writes the copy beside the original's transcript; Codex: `thread/fork`), resumed with its history on screen (`importHistory`). An adapter without it, a session with no conversation yet, and `ask_project` (which never creates a session in another project) are not offered a fork. start_agent's gates apply: the agent depth (#867), the project's trust (#382; #673's consent rule as `ensureAgentConsent` has it) and the per-project ceiling; once the card is answered the gates are read again and a place is taken before the copy is made (`reservePlace`), and the project losing trust withdraws a card still standing. Once the fork's session exists the gates and the lower of the two presets as they are now are read again with no wait before its delegation; a fork that fails them gets no task and goes to the session archive. The preset is the lowest of B's and A's. `fork` gets a worktree of its own (`agentWorktreeBranch`, branched from A's branch when A is a worktree session; a project with no git repository is refused and pointed at `fork_read`); `fork_read` is read-only work in A's folder under at most `safe`, so two agents never write one folder. Linked to B: `askedBy` B for a same-project ordinary session (the orchestrator through the delegation alone), its turn B's delegation (the report, its cards), and `forkedFrom` A (`sessions.forked_from_session_id`, store v52), which the sidebar uses to hang it under A, ahead of `parentSessionId` and `askedBy` (`orderAsTree`, `foldGroupsHiding`). |

**Sizes.** `ifBusy` carries no words in any schema: the `busy` answer names it and its values. `ask_project`'s is a
bare string (the enum would put the reader's Claude request over its 2,300), and the runner refuses other values;
`DELEGATE_BUDGET_CHARS` rises from 400 to 450, `AGENT_BUDGET_CHARS` from 1,000 to 1,100 (the agent set is 1,060 with
#676's `answer` and `card`), and the scoped seat's from 2,350 to 2,400 for `send_to_session`'s.

### 1.2.4 What a child costs the machine: code intelligence and the memory gate (#686)

Parallel children are bounded by memory before usage. Measured on the owner's 24 GB Mac (2026-10-14): a Claude child
that used code navigation ran its own `tsserver` at 0.5–1.1 GB in this monorepo, beside 0.3–0.5 GB for the CLI;
Codex starts no language server. The owner decided (2026-10-15) two things.

**Code intelligence is off for a child unless its caller asks.** `codeIntelligenceOff` (tool-profiles.ts) is the rule:
a child (`isChildSession`: a `start_agent` child, a fork, an app's agent) starts without it unless `start_agent` passed
`lsp: true`; sessions the person starts, the orchestrator and builder sessions keep the person's own setting. The
caller chooses per task (on for refactors and wide cross-file changes; research, docs, small fixes and tests do well
with search and a final typecheck); Centralu does not guess the task's kind from its words. The decision is made once,
in `createSession`, and recorded as the app setting `code_intelligence:<id>` = `off` (no column, so no migration), so
every wake, restart and host resume launches the child as it was created, and a session made before this build keeps
the person's setting. The adapter receives `noCodeIntelligence` and decides what it means: Claude disables, in the
SDK's `settings` option (the CLI's `--settings` flag layer, highest of the layers the person controls), every enabled
plugin that declares `lspServers` (adapters/claude/lsp-plugins.ts). The person's settings files are never written.
Which plugins: the enabled ids come from the SDK's own merge (`resolveSettings`, over the layers that session reads),
and a plugin counts when its installed copy's `.claude-plugin/plugin.json` declares `lspServers`, its root has a
`.lsp.json`, or its marketplace entry (`.claude-plugin/marketplace.json`, as Anthropic's official LSP plugins do with
`strict: false`) declares them, found through `plugins/installed_plugins.json` and `plugins/known_marketplaces.json`
under `CLAUDE_CONFIG_DIR` (or `~/.claude`). Those files are the CLI's, not a published interface, so the measured
plugin, `typescript-lsp@claude-plugins-official`, is always disabled as well (`KNOWN_LSP_PLUGINS`): a layout change
can miss another language's server, never that one. The keeper fingerprint adds `noLsp` only when it is on, so every
fingerprint stored before reads the same. Codex ignores the option.

**A new child starts only while the machine has room** (`MemoryGate`, sessions/memory-gate.ts, wired in main.ts with
`useMemoryGate`; tests wire one only where it is the subject). The reading is free plus reclaimable memory
(`availableMemorySource`, os.ts): macOS `vm_stat`'s free, inactive and speculative pages (`os.freemem()` there read
0.2 GB with 9 GB inactive); Linux `MemAvailable`; Windows `os.freemem()`. A read that fails lets the start go. Below
the floor (2 GB, `MEMORY_FLOOR_BYTES`) the start is **queued, not refused**:

| Start | Below the floor |
|---|---|
| `start_agent` | After consent (the card or the project's trust), the request (`agent_start_requests`, #673) is marked `allowed` and the call answers `pending` with `lowMemory` and its `ag-…` handle (the model reads "queued: low memory"). A notice in the caller's session says why. agent_session `status`/`wait`/`stop` work on the handle as on a card's; a start that had no card gets a request of its own. Once memory recovers the child starts with its report armed, and the handle leads to it. A host that takes over an `allowed` request waits for memory without raising the card again (an older build raises it again, which only asks twice). |
| A fork (§1.2.3) | Becomes a place in the busy session's queue instead (`enqueue`), which starts no process; the answer says `queued` with `lowMemory`, read as "Not forked: memory is low … queued instead". |
| An app's agent | Waits inside the app's call: the run's progress says "waiting for memory", and the agent starts when memory recovers; a cancelled call ends it without a session. |

The wait re-reads memory every 15 s (`MEMORY_RECHECK_MS`) and lets **one** queued start go per check, oldest first:
a child takes its memory over the first seconds of its turn, so starts released together would all read the same free
memory. It gives up after 30 minutes (`MEMORY_WAIT_MAX_MS`): the caller is told as a message and the person in a
notice. A withdrawn request, a deleted caller, or a host leaving (`disposeAll`, `detachAll` close the gate; the stored
request goes to the next host) ends the wait without a start. Sessions the person starts are never gated.

### 1.2.5 A handoff takes the children along (#693, #738)

A handoff (`createSession` with `handoff.fromSessionId`, the session handoff of domain-model §1.1) used to leave the
original's children where they were: their reports woke the original, which the person had stopped working in (and
usually deleted next), and the new session could not reach them, since `agent_session` works only for the starter. The
new session now takes over the original's **live** work as it is created, before its first turn reads the note
(`moveChildren`, owner decision on #693), and **every** child when the original goes (#738):

- **What is live**: a session working or waiting on the person (approval or question), one holding a request the
  original queued (§1.2.3), one whose report to the original is not delivered yet, an `ask_project` answer the
  original never came back for (that tool tells nobody when it ends), and a start_agent request still open: its card
  still standing (#673), or already allowed and queued until memory frees up (§1.2.4, #686). Same-project children (`askedBy` or `parentSessionId` naming the original) and the original's
  delegations in another project both count.
- **What moves**: `askedBy` and `parentSessionId` where they name the original (another project's session keeps its
  own row), the report mark (`report_marks`), the delegated turn's link (`delegated_turns`) and the delegation the
  host holds for it (its key names the caller), the requests the original queued (`queued_requests`), and its standing
  start requests (`agent_start_requests`, whose stored request names its caller too). A standing card closes in the
  original and stands in the new session as a card raised between turns, so the new session's first turn hides it and
  its end raises it again; an approval starts the child for the new session (the waiting setup reads the request's
  caller after the card). A start that already made a moved child hands its handle over too.
- **What stays, and only while the original stays**: a settled child (finished and reported or read, nothing
  pending) stays with an original the handoff keeps, so its history stays where it happened. A settled child is often
  still in use, though (finished, reported, waiting for its orchestrator's next instruction), and left with an original
  that goes it belonged to nobody: `askedBy` named a removed session, the sidebar showed it at the top level, its next
  report was owed to the removed session, and a successor that is not `auto` could not `agent_session` it (#738). So:
  - **A handoff that removes the original** (chosen in the window; its default since #1477, and before #694) says so (`handoff.removesOriginal`, an addition to
    `createSession`), and every child moves as the session is created, settled ones too, listed in the note as
    "finished; waiting for more work". It is the same move in the same transaction; only `stateOf` gives a settled
    child a state instead of passing it over. The window removes the original as a separate, last step (`store.handoff`,
    "destruction comes last"), so the host is told beforehand rather than finding out: told at creation, the move still
    happens before the first turn reads the note. If that deletion then fails, both sessions stand and the children
    are with the session the person works in.
  - **An original removed later** (a handoff that kept it, then a delete; or a window that did not say it would
    remove it) gives its children to the session that inherited its handoff, in `trashSessionOnce` (`sessions/session-trash.ts`) before the
    teardown lets go of them (scope `removed`): settled ones, and working ones it started after the handoff, with the
    reports, turns and delegations that are theirs, since an orphan is worse. What it asked for and the person never
    answered stays behind and goes as before: its standing start_agent cards are withdrawn and the requests it queued
    are dropped, so no card appears in another session because this one was deleted. A call of its own still waiting
    on a moved child ends with a fixed answer (`handedOverReply`), since archiving drops the `handedOver` entries
    before the woken call reads them. The heir is the newest live session whose handoff marker names it
    (`Store.handoffHeirs`, filtered in SQL); successors that were removed, or are being removed at the same time
    (`trashing`), pass on to their own successors, the nearest generation first. Its note was read long ago, so it is
    told in its conversation (a `notice`); the original, about to go, is told nothing. The move is its own transaction ahead of the archive's: a crash between them leaves the children
    on the heir and the original standing. A removed session that never handed over leaves its children on their own,
    as before.
- **The note**: the note file the opening message points at, and the marker that keeps its original, open with a
  section listing what moved: name, state, handle, and what the new session can actually do with it, which depends on
  what moved (#693 review). A child it now started: `agent_session` works on it, and its report comes when one is owed.
  Another project's session: `ask_project` with no task waits for the answer, and the cards of the turn it now owns
  are told to it. A same-project session it did not start (a turn it now owns): the report and the cards, while
  `agent_session` works on it only under `auto`. A standing card: the handle for `agent_session` until the person
  answers. A start queued for memory (`allowed`): no card; it starts on its own as the new session's child when memory
  allows, with the report armed for it, and the handle works meanwhile. Nothing moved, nothing added. The opening message itself is the window's and is not changed (the window
  confirms it by its text).
- **An original that stays** (a handoff that keeps it, #694) is told in its conversation what went to whom (a
  `notice`). A call of its own still waiting on one of them (`agent_session` wait or send, `ask_project` with no task,
  a wait on a start request's handle, a `start_agent` call whose card is approved later) ends with where it went, so
  the answer is read once, by the new session; a wait had taken the child's report mark down, so that report is owed to
  the new session, set in the same transaction (`armReports`). Its later `agent_session` or `ask_project` about one of
  them says where it went (`handedOver`, live only) rather than "not a session this session started".
- **Who may hand over** is not checked here: `moveChildren` trusts its caller. Two callers reach it through
  `createSession`: the person's handoff (the window's RPC) and the orchestrator's `handoff_session`, after
  `HandoffFlow` has checked its authority over the original (§1.2.6). Any other agent-facing path must check its
  authority the same way first.
- **Atomic**: everything stored moves in one transaction (`Store.moveChildren`); the host's memory follows after the
  commit, with no await in between. A crash before the commit leaves every link on the original, after it every
  link on the new session, so a host taking over after a swap or a restart reads one owner (`report_marks`,
  `delegated_turns`, `queued_requests` and `agent_start_requests` are read at startup as before). If the store refuses,
  nothing moves and the note lists nothing. A delegation's end releases its turn by the delegation's owner at that
  time, not the one that started it.
- **Where the state lives**: `ChildOwnership` (`sessions/child-ownership.ts`, #428) holds who owns a child's work:
  report marks and paused reports, delegated turns, queued requests and the one being delivered, delegations and
  observer notes, start_agent requests, linked machines' reports, and what a handoff gave away. Each change with a
  store mirror writes it there; the manager reads through read-only maps. The memory side of the move is one call,
  `moveOwner`, which runs the manager's card move for the moving start requests in the middle, in the order above.
  What moves, the store's transaction, and `askedBy` / `parentSessionId` stay with the manager. At startup it reads
  its own rows back (`restoreReports`, `restoreTurns`, `restoreQueued`), as the manager's constructor did; the
  standing start_agent requests are `AgentStartFlow.restoreAgentStarts`, called between the reports and the turns.
- **The windows** hear `session_owner` (the session's `askedBy` and `parentSessionId` now) and hang the child under
  its new owner; a linked machine's event is qualified (`Qualifier.event`) and patched into the hub's mirror.
- **The mail moves too** (#1574, docs/plans/mailbox.md §4.1): `MailService.handOver`, run last inside the same
  transaction (`moveChildren`'s `then`), so a refusal there leaves the children and the mail on the original. With the
  original kept (scope `live`), the threads it owns with a moved child as assignee; with it removed (`all`, or `removed`
  in `trashSessionOnce`), every thread not done it is in. The successor takes the original's role, and the unread
  receipts become its own, so a moved child's report is posted in the successor's thread and moves it to review, and
  mail the original never got wakes the successor. The note (and the heir's notice for `removed`) lists each thread as
  `mail thread "<subject>"` with its id as the handle; the archive preview of an original with an heir says its
  threads go to that heir. `session_owner` is unchanged: a thread is not a sidebar link, and the Inbox hears the mail
  change itself. A child on a linked machine has no mail thread yet (mail across machines is slice 4), so only its
  report link moves (`moveCaller`), as before.

### 1.2.6 The orchestrator hands a session off (`handoff_session`, #694)

Handoff was the session menu's alone (⋯ → Hand off to a fresh session…). The central orchestrator now has it as a tool,
so it can replace a session that has drifted, or move its work to the other CLI, the way the person does. The note is
**from the record by default**, in the tool and in the window alike (owner decision on #694; the window archives
the original by default since #1477, having kept it from #694 to then): the session being
replaced is the one least likely to summarize correctly (repeated compaction, stale state, a summary carrying injected
text), and the record mode asks it nothing (`exportHandoffRecord`, `sessions/handoff-record.ts`; since #1481 the note opens with a contents section built without a model: the
the reply that ended each of its last turns in full, the sessions the predecessor started by state with ids, its running background work and a table of the note's
parts with line numbers; the name of the note the predecessor itself took over from is in the header; and a tool result is cut to
its first 500 characters with a marker, every call keeping its input). Asking
the session to write it (`mode: "agent"`) stays an option in both.

- **Arguments**: the target session, the receiving tool (the same by default), the note mode (`record` by default),
  and extra words for the new session, which its opening message gives after the note's opening as the
  orchestrator's (`handoffOpening` in `packages/protocol/src/handoff.ts`, the window's own opening, now shared).
- **Who may hand off what** (`HandoffFlow` in `sessions/handoff-flow.ts`, the seat's checks in
  `sessions/orchestrator-seat.ts`):
  - Only the central orchestrator has the tool (`profileAllows`): a lead (`scoped`), an ordinary session (`reader`),
    a builder and an app's agent do not, and the seat refuses it for any view but the central one.
  - The target is a session of this computer the orchestrator sees, and of those only a project's ordinary session:
    never the orchestrator itself, an orchestrator or coordinator, an app's session (its builder or an agent an app
    started: the successor would not carry the tie to the app), a linked machine's session (handed off there), or a
    worktree session (refused with the window's reason).
  - A target mid-turn (working, waiting on an approval or a question) is refused, without a card: a handoff never cuts
    a running turn. A target in an error state cannot write a note, so `agent` is refused there with a pointer to the
    record.
  - The receiving tool is checked first (`toolProblem`: an adapter, installed and signed in): a tool that cannot start
    a session is refused before any card, so a name the model made up never reaches the person's eyes.
  - A handoff that guards nothing asks no one (#1509, owner 2026-10-24): the target is at rest (the check above) and the
    preset the successor takes, which is the original's, is within the orchestrator's own (`HandoffFlow.covered`). The original
    stays and the orchestrator hands over no power it lacks. It is read again where the successor starts, after an agent's note too. A target above the
    orchestrator's preset takes the card below.
  - Otherwise the person's consent is a card in the orchestrator's own session for each handoff (`askHost`, an `other` card with
    `about: "session_handoff"`), naming the target, the receiving tool, where the note comes from, the preset the new
    session runs under and the extra words. Every name on it is someone else's text and is JSON-quoted; the extra words
    are cut at 400 characters and the card says so and gives the full length. Under the orchestrator's own `auto` the
    boundary is open (#603) and logged as `session_handoff of <target>`. "Always" lasts for that orchestrator while this
    host serves it, never for a project (`sessionOnlyAlways`), as an update's does, and is recorded only for a call that
    passed every check after the card. Every check runs again after the card: a turn started while the card stood is
    not cut short. Every refusal is logged with the caller and the target.
- **What it does** is the window's handoff without the deletion: the note is written to the same file
  (`<data>/handoff/<project>/<session>.md`), the successor is created with the original's settings (none of the
  tool-specific ones when the tool changes), the original's preset and name, and the note as its marker. Its opening
  message is stored and shown as the orchestrator's (`from`, the internal `initialFrom` of `createSession`), not the
  person's. The record labels every row another session or an app sent with its source and carries its text as one JSON
  string, as read_session does; only the person's rows are `[user]`, so a child's report cannot read as the person's
  instruction in the successor's note. A row starts only at the start of a line and its later lines are indented,
  tool titles and paths stay on one line, and the predecessor's name is JSON-quoted (#797), so no line of the
  session's own text can start a row either. Creating it
  moves the original's live children (§1.2.5, scope `live`): **the original always stays**, and is told in its
  conversation who took over. The person removes it.
- **Agent mode** sends the window's prompt (`handoffPrompt`, now in the protocol) as the orchestrator's message, waits
  for the turn to end and reads the note from the store (`exportHandoffNote`). The turn's end is read as start_agent
  reads a child's (`AgentRunWait` among `turnObservers`, #428): a turn that fails, hits a limit or is stopped, or ends
  with no note, answers at once and says which, instead of the bound's "wrote no note". The call waits up to 240 seconds, under
  the Codex bridge's 280; past that it answers "still running" with a handle, the handoff goes on, and calling again
  with `waitFor` set to that handle waits on that run. The handle's result is read once and kept at most ten minutes;
  a run nobody waits on frees its session when it ends, so a later call on that session is a new handoff. One handoff
  per session at a time: the session is claimed before anything is awaited and freed when the whole run ends, and a
  call that finds it claimed is refused. The note may take ten minutes, as in the window.
- **Not done**: the grid slot is not swapped (the window does that for its own handoff), and a host swap while an agent
  is writing its note drops the handoff (the request and the note stay in that session's conversation; call again).
  The card waits like `create_project`'s, so on Codex a card left standing past the bridge's bound ends the call there
  while the card stays.

### 1.2.7 The orchestrator starts sessions outside any project (#853)

Handing off light work unrelated to any project (a web search, a lookup), the orchestrator reached for its CLI's own
subagent, which never appears in Centralu: the person could neither watch it nor step in. It now has `start_agent` and
`agent_session` too, as commands of the `commands` tier (`RARE_COMMANDS`, reached through `centralu_run`; a direct
tool in the other tiers), and one line of its instructions says to use them rather than its Agent tool. The flow is
§1.2.1's (`AgentStartFlow`) with the orchestrator as the caller and no project as the place
(`ORCHESTRATOR_PLACE`, an empty id):

- **The child** has no project (`projectId: null`), is marked `askedBy` the orchestrator, and works in a folder of its
  own, `<data>/orchestrator-agents/<uuid>` (`newOrchestratorAgentFolder`), never the orchestrator's: a file a child
  left in the orchestrator's folder (Codex loads `.agents/skills` from it whatever the trust) would reach the session
  that directs every other one, and children sharing one folder wrote over each other (#994 review). The folder goes
  when the child is deleted for good (`purgeSession`), and with a start that fails. It runs under the orchestrator's
  preset and gets no Centralu tools and only the person's own settings (no project to trust). There is no worktree,
  and a busy child is not forked: there is no repository to fork from. In the sidebar it hangs under the
  orchestrator's row (`orchestratorChildren`), folded until the mouse rests on its button (#1591), with a ⋯ menu to stop or delete it; a child whose orchestrator was
  replaced stays there under "Started by an earlier orchestrator".
- **The consent**: a card under `safe` and `normal` (no project's trust stands in for it), naming no project
  ("Start Codex in a folder of its own, outside any project, …") and offering no "Always for this project"; ⌥a, or that
  answer from an older window, is kept as always for the orchestrator while this host serves it, which the card says
  ("lasts until Centralu restarts"). `auto` opens it. The depth binds as for any caller; the orchestrator is at 0, so
  its child starts none.
- **The rest is the same**: the per-place ceiling (`agentCeilingError`, counted over the orchestrator's children that
  are still here, and worded as "agents you started"), the
  finish notice through the report path, a request kept across a swap (its `projectId` is the empty place id), and
  `agent_session` status, send, wait, stop and delete, on a child whose `askedBy` is the orchestrator and no other
  session in any preset. Its answers name `centralu_run(command="agent_session", …)` for the orchestrator.

Characters: the orchestrator's instructions grow by the one line (Claude 8,744 → 8,893 resident, Codex 8,796 →
8,945, under its 9,500); the two tools' definitions ride in no request in the default tier. Not measured live:
whether the orchestrator then reaches for `start_agent` rather than its Agent tool. Not done: a read-only research
preset for such a child (the issue's suggestion); it runs under the orchestrator's preset as any child does.

### 1.3 Making a new project (`projects.create`, `create_project`, #515)

A project used to need a folder that already existed (`projects.add` refuses one that does not). Now
the host can make one: `projects.create { name, parent?, machine? }` makes an **empty** folder (no
`git init`, no template) and registers it as `projects.add` does, but trusted (#655): nothing in it came from outside. A clone (`source`) is
registered untrusted, and registering a path that is already a project never changes its trust. `projects.createPreview` answers
where it would go and why it would be refused, without making anything; the dialog asks it as the
person types. Both route by `machine` like `projects.add` (remote-hub.md §5), so the folder is made
by the host of the machine the project lives on, with that machine's own path rules.

| Rule | Where |
|---|---|
| The name is one folder: no `/` or `\`, not `.` or `..`, no control characters, at most 255 bytes, no Windows device name (`CON`, `nul.txt`, `COM1`) on any machine; on Windows also none of `< > : " \| ? *` and no trailing dot or space | `folderNameError` (protocol, shared with the dialog and the mock) |
| Nothing there is reused: a folder, a file or a broken link of that name refuses the call, and `mkdir` is never recursive for the folder itself, so a name taken after the check is refused too | `projectFolderTarget`, `makeProjectFolder` (`dev-services/project-folder.ts`) |
| A given `parent` is a full path to a folder that exists; it is never made | same |
| No `parent`: the machine's `~/Centralu`, made if missing | `projectsHome` |

**The default location is `~/Centralu`** on every machine: `~/Centralu` on macOS and Linux (WSL included),
`%USERPROFILE%\Centralu` on Windows (`projectsHome`, a platform module; the name is `PROJECTS_DIR` in protocol, which
the mock shows too). It is made on first use.

| Decision | Why |
|---|---|
| `~/Centralu`, not the Desktop (owner, 2026-10-12; the first build of #515 used the Desktop) | No permission prompt: on macOS the Desktop is a protected folder, and the first look into it (typing a name in the dialog) asked for access in Centralu's name; a folder of the home is not protected. Visible: it is found in Finder or Explorer, where a person looks for their work. One rule everywhere: no Desktop known-folder lookup (PowerShell on Windows, XDG on Linux), and a WSL distro or a server, which have no Desktop, get the same folder as a laptop |
| Apart from the data folder (`~/.centralu`) | The data folder is the app's and an uninstall may remove it; projects are the person's work and must not go with it |

The host only has a default location when `main.ts` wires one in (`SessionManager.useProjectsHome`); without it a
call with no `parent` is refused. That is what keeps tests and the linked-hosts e2e (which give a temporary `HOME`'s
`Centralu`) out of the home of whoever runs them.

**A clone instead of an empty folder** (`source: { git, branch? }`; the owner's addition on #515). The folder is made
empty first, by the same rules, and then `git clone -- <url> <folder>` runs into it (`dev-services/project-clone.ts`):

| Rule | How |
|---|---|
| The machine's own git and sign-ins | the clone runs on the host of the machine the project lives on, through `runGit`, with the person's git configuration (a fresh clone has no configuration or hooks of its own, so nothing the repository chose can run) |
| Never asks for a sign-in | `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=` and `SSH_ASKPASS=` (empty, which git skips), `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never` (Git Credential Manager uses what it has saved, no window), and `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` unless the person set their own ssh command. A repository that needs a sign-in the machine has not saved fails at once with one sentence |
| Addresses | `https://`, `ssh://` and scp-like `user@host:path` only (`gitSourceError`, protocol). Refused: `ext::` and every `<transport>::`, `file://` and local paths (an agent could otherwise have a folder of the person's copied into a project it reads), `git://` and `http://` (unauthenticated, unencrypted), an address or host starting with `-`, and a password written into the address (it would be kept in `.git/config` and shown on the card). `protocol.ext.allow=never` and `protocol.file.allow=never` are also passed, for a redirect |
| No submodules | no `--recurse-submodules`: their addresses are the repository's to choose, past the one the person approved |
| Name | an empty `name` is the repository's own (`repoNameOf`: the last path segment without `.git`) |
| Failure leaves nothing | the folder made for it is removed and no project is registered; each failure is one sentence (`cloneFailure`: a missing sign-in, branch, host or repository, no git, or over the 10-minute limit) |
| Time | the host stops a clone after 10 minutes. The window's call waits 180 s (`LONG_CALLS`) and a linked machine's hop 200 s; past that the dialog says it is still cloning, and the project joins the list when it lands (`projects_changed`) |

Tested end to end against a local bare repository served over https (git's dumb protocol from a static server, a
self-signed certificate trusted through `GIT_SSL_CAINFO`, the person's git configuration left out), including a
path that answers 401 for a repository that needs a sign-in (`sessions/clone-project.test.ts`).

**The orchestrator's `create_project { name?, parent?, git?, branch? }`** replaced `propose_project`, which only lit
up the sidebar's Add project button. It raises a card in the orchestrator's own approval slot
(`project_create`: the name, the full path and, for a clone, the repository and branch), and the call waits for the answer, as `ask_project`'s
consent card does (`askHost`). Nothing is made until the person chooses Create; "always" is read as
allow and nothing is remembered; deny, or the call stopping, makes nothing. The target is checked
before the card (a refusal costs the person nothing) and again after it. A project made this way is
announced with `projects_changed`, which every window answers by re-reading the project list. It is
the orchestrator's alone (security-boundaries.md), and it makes projects on this computer only: the
hub's orchestrator does not see the linked machines; their projects are made from Add project, by picking the machine. A
clone also says "Cloning … into …" in the orchestrator's conversation once Create is chosen, while the call runs. The
swap left the orchestrator's resident set smaller than before (`residentCost`, Claude: 11,798 → 11,620 characters, and
11,770 with the clone's arguments; docs/tool-cost.md).

**Adding a folder that already exists** (`add_project { path, machine? }` and `list_machines`, #1220, the first slice of
#1219). The person linked a laptop and asked for two folders on its desktop as projects; `create_project` never reuses
a folder, and nothing named the machines. Both are rare commands of the orchestrator (`RARE_COMMANDS`, reached through
`centralu_run`, #1205), the central orchestrator's alone:

1. The folder's machine reads it, changing nothing: `projects.inspect { path, machine? }` (additive, routed by `machine`)
   answers the absolute path in that machine's terms (a leading `~` is its home; any other relative path is refused),
   whether something is there and is a folder, whether it is in a git repository and that repository's `origin` (git's
   config only, with the untrusted-project settings), and the project already kept for it (`ProjectCreation.inspectFolder`).
2. A missing path, a file or a folder already a project is refused with that reason, before any card.
3. The card (`project_add`, raised by `askHost` with `alwaysAsk`, so `auto` asks too) shows the machine, the path, that it
   exists and is a folder, and the git facts; `text` carries the whole question for a window that does not know the kind
   (#844). Allow or deny; "always" is read as allow and nothing is remembered.
4. On Allow the folder is registered as the sidebar's Add project registers it: on this computer the facts are read again
   (a folder gone or added meanwhile is refused) and `addProject` registers it, then the apps list is read again
   (`ProjectCreation.registerFolder`, the steps of `projects.add`); on a linked machine, that machine's `projects.add`
   through the router, which checks again there. New, it is untrusted. The host then sends `projects_changed` with
   `added` (additive), and a window asks about the project's trust as it does for a folder the person added.

A machine on a Centralu from before `projects.inspect` is named as too old, before any card. `list_machines` answers one
line per machine from what `machines.list` answers (`SessionManager.useMachineList`, wired to `links.list()` in
`main.ts`): its name, status, OS and shell (from the shell the hub reaches it with), and whether it reconnects by itself
(Auto reconnect, `MachineInfo.autoReconnect`, #1341).

**Managing the linked machines** (#1219, second slice). The orchestrator's rare commands `add_machine { sshTarget, name?,
wslDistro? }`, `install_machine { machine, action: install | update }`, `remove_machine`, `reconnect_machine`,
`set_machine_auto_reconnect { on }` and `set_machine_autostart { on }` make the calls the Machines screen makes on the
hub's links (`MachineFlow`, `sessions/machine-flow.ts`, wired by `SessionManager.useMachineOps(links)` in main.ts).
`add_machine` connects nowhere before the person's card (security review of #1238): the target is resolved with `ssh -G`
(`Links.resolve`; no connection, no key loaded) and the card shows the host, user and port ssh would use, and its
ProxyCommand or ProxyJump when one is set. After Allow one BatchMode ssh probes what runs there (`machines.probe`); a
target that does not answer or runs nothing it can link is linked nowhere, and the answer says why, with no second card.
The shell follows the probe as the Add machine dialog's rows do: a Unix shell, Windows through PowerShell, or a WSL
distro of it when one is named. A target, name or distro with a control or format character (Unicode Cc, Cf, bidi
overrides among them) is refused before anything runs. Linking, installing,
updating, removing and start at boot wait for a card in the orchestrator's slot under every preset (an `other` card,
`about: "machine_change"`, the question whole in `raw`, so any window reads it; allow or deny, nothing remembered).
Reconnecting and Auto reconnect act at once, as the row's buttons do, except that undoing what the person chose asks (#1341):
`reconnect_machine` on a machine they disconnected or whose Auto reconnect is off, and `set_machine_auto_reconnect` turning the
switch back on, wait for a card (`about: "machine_change"`); a machine away on its own with the switch on is reconnected with no card, and one already connected is answered as connected (nothing is done). Refused before any card: a machine not linked,
a target that is no ssh target or that `ssh -G` cannot read, a name already linked, and an install or update
this computer cannot make (`LinkedMachine.operationRefusal`, the same sentences `operate` refuses with). Every answer
ends with the machine as it is after the change (`machineLine`). An install or update runs while the tool call waits.

**Preferences** (#1219, with the session archive). `get_preferences` and `set_preferences` are rare commands of the central orchestrator
(`PreferencesFlow`, `sessions/preferences-flow.ts`). They make the window's own calls through the router
(`SessionManager.useWindowRpc`, wired in main.ts to `router.handle`; `callWindow` in `sessions/window-rpc.ts` checks
the params with the method's schema and reads the answer with its result schema, and only the methods named in
`WINDOW_METHODS` are callable), so the host checks them as it checks the window.

- `get_preferences` reads `prefs.get`, `themes.list`, `agents.sleepPolicy`, `updates.status` (not forced: the read the window makes at start, which asks the registry only when checking is on and one is due)
  and `agents.versions`, one line each, with the choices; a part the host cannot read says so and the rest still answers.
  It also lists the send key, which no command changes, and the limits on agents, which `set_agent_limits` changes behind a card.
- `set_preferences` takes only what changes: `theme` (an id or a name), `textSize`, `bodyFont`, `codeFont`,
  `lineHeight`, `idleSleepMinutes` (a whole number, or "never"), `autoUpdate` ("Automatic updates", below), and
  `moveIdleSessionsToNewAgentCli` and `notifications` (the switches to change: `approval`, `done`, `whenFocused`, `sound`;
  merged one by one into the host's record, §1.4; no card, except to turn `approval` off, or `sound` while it would still
  notify, the ones that tell the person a card waits, which ask in every preset and keep them on when denied). The
  "error" and "every session finished" notifications are gone from the product (owner decision 2026-10-20): the window
  no longer raises them, `set_preferences` refuses `error` and `allDone` by name, and the stored switches stay readable
  for older builds. The arguments are strict: a field it does not have (`sessionTools`, always on and named by neither command, `agentCeiling`,
  `themeMode`) is refused by name. A theme names one preset (`THEME_PRESETS`, now in the protocol) or a theme file that
  reads cleanly; it sets the side of the theme's base and the stored mode to that same base, so the mode stays `dark` or
  `light`, never `system`. The text size lands on the nearest step, as `prefs.set` does. A theme, font or
  schema refusal comes before any write; a service the host lacks (no update service in a test) is reported next to the
  changes that did happen.
- **The notification switches** (#1306) are in the preferences record (`UiPreferences.notifyPolicy`, optional), no longer only in the
  window's workspace snapshot, so the window and the orchestrator share one source. `UiPreferenceStore.uiPreferences` carries
  them once: the first read that finds none takes the snapshot's `notifyPolicy` (the defaults when the window never saved
  one) and writes it, so a snapshot an older window still writes never overrides a switch chosen since (the text size moved
  the same way, #312). A patch carries only the switches that change and the host merges them one by one
  (`setUiPreferences`), so the window and the orchestrator changing different switches do not undo each other. Every change
  is announced with `prefs_changed` (carries nothing; a window reads `prefs.get` again), which also brings the
  orchestrator's other preferences (theme, text size) to an open window. The window keeps writing its snapshot's copy, for a
  build that reads it there; against a host that answers without the field it keeps using the snapshot's.
- **When agents compact** (#1376) is Centralu's setting, `UiPreferences.autoCompact` `{ controlled, share }` (optional: a record from
  before it reads as on at 60%, `autoCompactOf`; an older host ignores the field). The point is a share of the model's context
  window, for both tools. `launchOptions` (every launch and wake) turns the share and the model's window into tokens
  (`sessions/auto-compact.ts`), `CreateSessionOpts.autoCompactTokens`. **Claude** gets `autoCompactWindow` and `autoCompactEnabled: true` in
  the flag-layer `settings` of the query, next to the code-intelligence plugins (`flagSettings`, no file is touched). The CLI compacts
  at that window minus **33,000 tokens** (measured on CLI 2.1.296 with `getContextUsage()`: `autoCompactThreshold` was `maxTokens - 33,000`
  with the setting and without it, at 200k and at 1M), so the adapter passes the point plus 33,000, kept to the 100k to 1M it accepts: the
  earliest it can compact is 67,000 tokens, and a share under that on a small model lands there. The adapter compares the threshold the CLI
  reports with the one asked for and logs a difference once. The CLI's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` variable still takes precedence,
  and with the setting on Centralu turns auto compact on (`autoCompactEnabled`) even when the person's own Claude settings turned it off
  (Settings says so). **Codex** gets `model_auto_compact_token_limit` in the per-thread `config` of `thread/start` and `thread/resume`,
  which overrides the person's `config.toml` for that thread. Off (`controlled: false`), nothing is passed and each agent's own settings
  decide, untouched.
  The window is the model's own, which a tool reports with its token readings. `ModelWindows` keeps it, with the model the
  tool resolved the name to (`context_update.model`), per tool and model name (a default model per project) in the app settings. Claude's CLI
  reports the smaller of the model's window and the `autoCompactWindow` it was started with (a 1M model started at 153,000 reports 153,000; a
  200k one started at 633,000 reports 200,000), so `AgentAdapter.windowCeilingFor` gives the largest window a process started with the
  setting can report, and a reading is read against it: **below it** is the model's real window and is recorded, whatever was known (a
  record that was too large corrects itself); **at it** is only "at least this": the record stands when the CLI names the same model, and is
  dropped when it names another (the alias, the project default or the person's own setting moved), so the next start passes nothing and
  learns the real window (a record that was too small can rise). The ceiling a process was started with is kept with the session
  (`auto_compact_ceiling:<id>`) and read back when a host swap adopts the process, since the process keeps its original flags whatever the
  setting says by then; one adopted without a kept ceiling (a host from before) can only say "at least". The row is dropped when the session has no process to adopt: when it sleeps, is deleted, or its start fails (a purge of the trash takes any left, by its `<name>:<id>` shape). The adopted process is handed the ceiling (`CreateSessionOpts.autoCompactCeiling`), and the adapter's once-only log of a compaction point that differs from the one asked for compares against it, not against what the setting gives now. Codex reports the model's own window, so its readings always replace the
  known one. A model nobody has read a window from passes nothing at its first start and the value from the next (Settings, and the
  session's own settings menu, say so).
  **One context share (#1553).** The share shown anywhere is used / the model's full window, for Claude and Codex alike: 100% is the whole window
  (a 1M model: 1,000k), and the compaction point is not its end (the tooltip names it; the bar does not draw it, #1572). The reading a tool gives is for learning from (`ModelWindows.note` reads it
  against the ceiling, as above); what leaves the host is made from it once, in `SessionEvents.shareOf`, before the event is applied, stored or sent: the
  `context_update` (and so `SessionInfo.context`) carries `window` = the model's full window (`ModelWindows.shareWindow`: the reading when it is under the
  ceiling or the process has none, else the window kept for the model), `compactAt` = where the process compacts by itself, and `capped: true` when the full
  window is not known (a reading at the ceiling with no record for that model: an adopted process without a kept ceiling, or a model name that moved to another
  model); then `window` is only the tool's reading, a floor under the model's. **`compactAt` is said by the adapter, per reading, for a process Centralu's control
  started** (`claudeCompactAt`: the CLI's own `getContextUsage().autoCompactThreshold`, which is not the tokens asked for when the CLI clamps them to its
  range and the model's window: asked 40k on a 200k model it compacts at 67k; an adopted process counts as controlled only with the ceiling its host kept.
  `codexCompactAt`: the limit the thread was started with, Codex not reporting one; none for an adopted thread). Nothing is stored for it, so a rollback to a build that
  writes no such row cannot leave a stale one, and the point belongs to the process: a new process clears the host's copy at its start (`autoCompactFor`),
  and its first reading says the new one. The host drops a `compactAt` that is not under `window`. A screen or a text for an agent turns the reading into a
  share with `contextShare` (protocol) and divides by nothing else. The nudges and the rest rule take the model's window from `ModelWindows.of`: the record kept for this tool and model, which a floor is never written to (a capped reading drops it). **A stored reading is never one**, because `capped`
  is not stored: after a restart of the host, or a switch to a model nobody has read, they say and do nothing until a reading gives that model's window. The nudges also state the process's point
  (`context.compactAt`), not the setting as it is now (the setting reaches a process at its next start); without one known (just after a start, or a process
  Centralu did not start to compact) only the first share is told, and only when it is under the share of the setting (the old rule), and no compaction point is named.
  What is shown for an unknown full window: the gauge reads "≤N%" (an upper bound) with a tooltip that says the model's full window is not known yet and the real
  share is at most this, until the tool's next reading under a process with no ceiling teaches it (usually the next start). The stored `context_window` is the
  share window; `capped` and `compactAt` are not stored and come back with the next reading (a record from before may still hold the tool's smaller window until then).
  The gauge's bar warns (darker fill) within 10 points of the mark, and at 80% when no mark is known; the mark stands out of the track above and below, so it still shows once the fill has passed it.
  **Compacting at a break (#1451).** The share above stays the in-turn backstop (60%); two things compact a session at a break instead
  (`sessions/self-compaction.ts`, `SelfCompaction`), because a long-lived session's whole context is rewritten into the cache after every
  long wait and a compaction in the middle of work breaks the flow. Both send the tool's own command as a turn of its own (`SessionEvents.sendCompact`:
  Claude `/compact [focus]`, Codex's `thread/compact/start` through its slash handling, which takes the bare command, so a focus line
  reaches Claude only), with no user row, and the conversation gets a line from Centralu when the tool reports it done:
  "Compacted by Centralu (reason)".
  - **`compact_self`**, a tool of an ordinary session and the orchestrator (loaded, 453 characters; docs/tool-cost.md §15): asks for a compaction
    **after the current turn ends**, never in the middle of one, with an optional `focus` line (one line, 300 characters). Its description says when:
    work is finished and reported; before waiting more than a few minutes on a child, CI or the person; switching to an unrelated task.
    The request is always accepted: the size of the context known during a turn is the one read at the previous turn's end, so a turn that grew past the floor would have been refused. The **floor** of 100,000 tokens is checked at the turn's end on the size of the turn's last model request of its own conversation (`usage_update.request`, which both tools send), else on the size the tool reads then (Claude reads it just after the turn ends, so the request waits for that `context_update`, at most 5 seconds (its own timer) before it goes by the reading it has, and a reading owed for the turn before that lands in the next turn is not taken for the next turn's; Codex reads it during the turn); under the floor the request is dropped. One request is pending per
    session; asking again replaces the focus. **The person's turn first:** a request is spent at the first turn end after it, so a message the
    person sent into that turn is part of it, and one queued behind it runs before the compact in the tool's own queue, which compacts after
    it; a turn the person interrupts (or that ends in an error or a usage limit) **drops** the request, and a card the host raised at the turn's end holds it: it goes when the card closes with the session still at rest, and is dropped if a turn starts first (the person's answer is theirs; the request is never carried into it). The tool's answer is its confirmation: it does not
    wait for the compaction. The request does not ask whether background work runs: waiting on CI in the background is what it is for.
  - **A session at rest** for 10 minutes whose context is over `autoCompact.idleShare` of the model's window (default 30%, 10% to 95%; Settings
    and `set_preferences` offer it) **and** over the floor is compacted by a sweep (every minute; the 10 minutes count from the moment the session is idle by every rule of `sessionIdle`: no turn, card, question or background work. A turn's end starts them only if it leaves the session idle; otherwise the sweep that sees it become idle does, so a card answered or background work stopped late does not bring an immediate compact; the share is read against the model's own window, not the smaller one a Claude process started under the CLI's compaction setting reports) before its next turn. Off with the existing
    `autoCompact.controlled` switch. Never a session in a turn, with an approval or question card open, running background work, or without a
    process (`sessionIdle`, the rule of the sleep sweep; a session that sleeps after 15 minutes is compacted at 10 if it was over the share).
    **The compact turn is marked.** The ending event of a turn Centralu started to compact says `turn.compaction: true` once the tool has reported the compaction in it (`TurnWho`, an addition; a turn of the person's that the tool ran first from its queue is not marked, and a compaction Claude says is its own, `compaction.trigger: 'auto'`, is not taken for Centralu's; a compact turn that is interrupted or fails before the compaction is reported is forgotten, so a `/compact` the person types later is not Centralu's), and the window raises no "done" notice, card or sound for it; a build that does not know the field shows one, as before. The turn is not a turn of the session's own for the rest rule.
    The share is read as `autoCompact.idleShare` but **stored beside the record** (`autoCompactIdleShare` in the screen preferences row), because an older build rewrites `autoCompact` as the two fields it knows and would erase a third inside it; a top-level field of the row survives every build's save (measured on the previous build in the deep review of #1478).
    A session is compacted once per rest: what a compaction leaves is not always read back (Codex reports no size), so it needs a turn of its own
    before the next. A host that starts counts the rest of a session it never saw end a turn from when it first saw it at rest, and a wake from sleep starts the rest again.
    A turn's end is the compact's only after a turn began following the send (Codex's request starts its turn later); a tool that refuses it before that clears the mark. The sweep stops in the shutdown plan with the sleep sweep. Known gap: on Codex a message or mail delivered in the moment between the send and the compact's turn start can take that turn's bookkeeping.
  - **Telling a growing session (#1492).** An agent cannot see how full its context is (Claude Code does not tell the model), so `compact_self`
    alone depends on it thinking of the tool. When a session's context passes a first share (`autoCompact.nudgeFirst`, default 30% of the model's
    window) Centralu tells it **once**, quietly, its size and share and "when this step of the work is done, call `compact_self`", and tells it
    **once more** at a second share (`nudgeSecond`: default 10 points below the share the tool compacts at, so 50% when that is 60%; **never at or
    above it**, held at least 5 points below, `nudgeShares` in `@cc/protocol`), where the tool's own compaction would otherwise come in the middle
    of work (`sessions/context-nudges.ts`, `ContextNudges`). **Quiet:** the note goes in as `SessionHandle.nudge`, which never starts a turn and never
    interrupts one: Claude takes it as quiet input (`shouldQuery: false`, stamped as Centralu's channel), read with the session's next input or at the
    running turn's next tool round; Codex steers it into the regular turn that is running with `turn/steer`, which names the turn (`expectedTurnId`) and is refused by Codex
    for one that has ended, so a note for the last request of a turn (Codex sends its token count just before `turn/completed`) starts no turn of its own,
    where a `turn/start` did (#1504 review, measured on a real Codex). A Codex session between turns, or in a compact or review turn it cannot steer, takes
    none, and a refused steer is not counted as told (`nudge` answers with a promise): the note waits for a later request of a running turn, the next
    turn's first. A session at rest is the rest rule's job, not this.
    **Once per share per compaction cycle:** a share is told the first time a request is over it (a request over both says it once); a compaction of
    any kind that succeeded (the agent's, Centralu's, the tool's own, the person's `/compact`) or a fresh conversation (`/clear`) starts the cycle again, so
    the shares are told again when the context grows back; a compaction that failed does not. The counters are in memory: a host that starts tells a session
    already over a share again, once. **Only where it can be acted on:** a session that has `compact_self` (an ordinary session and the orchestrator,
    `toolProfileOf`), with Centralu's control on (`autoCompact.controlled`) and the notices on (`autoCompact.nudge`), over the 100,000-token floor (a smaller
    context would be refused), and a share under the tool's own (a first share at or above it is never told). The window's conversation says each one as a
    line from Centralu ("Centralu told it its context is 33% full: call compact_self when this step is done"). Settings (Compaction) and `set_preferences`
    take `nudge`, `nudgeFirst` and `nudgeSecond` (`null` is back to following the tool's share); a second share at or above the tool's own, or less than
    5 points below it, is refused by the host with the reason, a first share not below a chosen second one is refused too (`refused`, `data.reason` `bad_value`, not `internal`), a patch that moves
    several is judged as the whole setting that results, and a tool's share lowered under a second share chosen before **takes it down** (to 5 points below the
    share; back to the default, null, when it could not then stay above the first), in what is stored and in what `prefs.get` reads (`settledSecond`), so the setting
    as read can always be sent back whole: it is what a hub pushes to every linked machine, and a refusal there would have kept the machine from taking the
    share too. All three are **stored beside the record** like `idleShare`
    (`autoCompactNudge`, `autoCompactNudgeFirst`, `autoCompactNudgeSecond`), so an older build's save of `autoCompact` cannot erase them; a linked machine
    takes the hub's values with the rest of the setting (`offerAutoCompact`).
    **The size during a turn** comes from each model request's input as the stream says it (`usage_update.request`: Claude per assistant message, Codex per
    token count; a subagent's request is not the conversation's), because the tool's own reading comes at a turn's end (Claude reads it just after the turn
    ends). The same figure moves the window's meter (`sessions/context-meter.ts`, `ContextMeter`): each request becomes a `context_update` marked
    `exactness: 'estimate'` (the window draws it like a reading, with no "≈", #1572; a hub and an older window read it as a reading), **at most one per 3 seconds per session**, in the
    window of the session's last reading (`SessionInfo.context.window`, the model's full window when known, #1553, so the meter never changes its denominator in a turn; none until a reading gave one), carrying its `capped` and `compactAt`. **The
    tool's reading stays the authority** at the turn's end whatever the estimates said, and estimates stop for the rest of a turn in which the tool read the
    size. Codex reads it with every request, right after the request's token count (`AgentAdapter.contextAtRequest`), so it gets no estimate at all: the exact
    figure is there at once, and an estimate could only flicker in front of it. **A reading owed for the turn before cannot overwrite this turn's:** a turn that ended with no reading in it owes
    one (Claude's), and when that lands after the next turn's own estimate it is not applied and not sent to the window (the compaction rule still hears it);
    it is applied when the session is at rest or the turn has no estimate yet. The compaction rules ignore estimates (`SelfCompaction`), and an estimate is
    no reading of the model's window (`ModelWindows`).
    **Follow-ups of #1478 (#1500).** A request held for a card the host raised is judged when any event, or the sweep, finds the card gone and the session
    at rest, not only on the card's own `approval_resolved` / `question_resolved` (a card also closes with the session's stop, a withdrawn card, a host swap, and says
    nothing then); a held request of a session with no process is dropped. The held path goes on `!busy && !cardOpen` even while background work runs, as the rule
    for every request made in a turn does (waiting for CI in the background is what the request is for); `sessionIdle`'s stricter rule is the rest compaction's. Codex
    does not say why it compacted: its adapter says `manual` for a compaction inside the compact turn the session started (`/compact`) and `auto` for any other,
    so the tool's own compaction in the middle of a person's turn that ran first is not taken for Centralu's. A stopped tracker ignores events (`stop()`).
  **Linked machines.** A machine starts and wakes its sessions from its own preferences, and the setting lives on the hub, so the hub tells
  each machine its setting as a change of that machine's preferences (`prefs.set`, at every connect and when the hub changes it,
  `LinkedMachine.offerAutoCompact`): the hub's switch and percentage govern the machines it links, and a value set on the machine itself is
  replaced at the next connect (a machine linked to two hubs takes the last one's). A machine from before it drops the field and applies nothing. The model windows are kept per host, so a
  machine learns its own. `agents.autoCompact { sessionId }` answers `{ controlled, share, tokens }` for the next start from the host
  that runs the session (routed like the session), from the same function the launch uses (`autoCompactPlan`), and the session's settings
  menu shows it; a machine from before it answers "Unknown method", which the menu reads as "this computer's Centralu predates the
  setting".
  A change reaches a session when its process next starts; running sessions are not restarted and are not marked as drifted. The
  patch merges field by field like the notification switches; `set_preferences { autoCompact: { controlled?, share? } }` (no card:
  reversible, and only about when an agent compacts) and `get_preferences` carry it; Settings, agents section, offers the switch
  and the share (20% to 95%).
- **Automatic updates** (owner decision 2026-10-20) is one setting over the two stored switches: checking (`updates.auto`,
  `updates.setAuto`) and installing and applying when idle (`updates.autoApply`, `updates.setAutoApply`). Both are **on**
  for a person who never chose (`update-switches.ts`); a person who turned either off has it stored off and keeps it off,
  and one who turned checking off before keeps installing off too (their Check now only informed, and still does).
  Installing is on by default only in the person's desktop app (`installsByDefault`): a bundled build the window started
  itself (`CC_STARTED_BY=app`, Windows and Linux), or one the keeper runs from the installed app (`CC_HOST_SOURCE`'s
  `bundlePath` is `installedCopyPath()`, macOS). Every other host keeps installing off unless turned on: a `centralu
  serve` host, since on a linked machine the hub keeps its version (`machines.update`, the managed install under
  `<data>/remote`) and one installing by itself would race it; with the hub's own installing on, it brings each linked
  machine to its version by itself (#1508, §4.8 "Following the hub"); a host from source; and one a script or test harness
  started (no `CC_STARTED_BY`, a keeper running a build output or debug bundle, `CI` set), which must not install the
  published package globally on the machine running it. The wire default of `UpdateStatus.autoApply`
  stays false, for older hosts. `set_preferences autoUpdate: true` asks first, in every preset, whenever either half is
  off: with both on, a newer Centralu installs by itself and the desktop window relaunches into it when nothing is busy, so
  code arrives with no later question. It is an `other` card with `about: "orchestrator_change"` (`ORCHESTRATOR_CHANGE`),
  allow or deny only; on Allow it turns on the half or halves that are off. A denial leaves both as they were and the
  call's other changes still happen. `autoUpdate: false` asks nothing and turns installing off before checking. The
  separate `checkForUpdates` and `applyUpdatesWhenIdle` fields are gone and refused by name; `get_preferences` shows one
  line, and says which half is on when they differ.

**The session archive** (#1219; its commands were `list_trash`, `restore_trashed`, `trash_subagent_steps`, `delete_trashed` and `empty_trash` until #1404, when an orchestrator read "empty the trash" as the operating system's bin). The rare commands `list_archive`, `restore_archived { sessionId, what? }`, `archive_subagent_steps { sessionId }`,
`delete_archived { sessionId, what? }` and `delete_all_archived` (`TrashFlow`, `sessions/trash-flow.ts`, through the same window RPC as the
preferences) are the Settings → Archive screen's calls. `what` is `session` (the default) or `steps`.

- `list_archive` reads `trash.list` (linked machines merged; a machine not reached is named) and `subagents.usage`: the
  sessions with their project, size and what deleting for good takes along, the kept app runs (#378), the archived subagent
  steps, and the sessions whose steps could be moved there. Rows beyond 25 are counted.
- `restore_archived`, `archive_subagent_steps`: `trash.restore`, `trash.restoreSubagentSteps`, `subagents.trash`. They lose nothing and
  ask nothing, with one exception: restoring a session whose project was deleted registers the project's folder again (as
  the window's Restore does), which is what `add_project` asks about, so that restore raises a card naming the folder. A
  session not in the archive is refused before any call.
- `delete_archived` and `delete_all_archived` delete for good, behind a card in every preset (`ORCHESTRATOR_CHANGE`, allow or deny only).
  A session or steps that are not in the archive are refused before the card, so a live session cannot be deleted this way.
  The card names the session (or the counts, the size and up to ten names), what goes with it (the tool's conversation
  file, a worktree marked for removal) and that it cannot be undone. After Allow the archive is read again and the host
  deletes exactly what the card named and is still there, one `trash.purge` / `trash.purgeSubagentSteps` (with the `upTo`
  the card listed) / `trash.purgeRuns` (one call per machine) at a time, as the window's Delete all archived sessions does; `trash.empty` is
  not used, because it takes everything in the archive, also what arrived after the card. A session restored or deleted while the card
  stood is left alone and said so, and so is one restored and archived again (its `deletedAt`, message count or what goes
  with it differ from the row the card named); one that failed to delete stays and is reported, and the rest go on.

**Trust** (#1219, third slice). The rare commands `list_projects` and `set_project_trust { project, trusted }`
(`TrustFlow`, `sessions/trust-flow.ts`, through the same window RPC as the preferences) are the project list's and the
trust switch's calls (`projects.list`, `projects.setTrusted`, with `apps.list` and `machines.list` to name what the
trust covers and where). `project` is an id, or a name exactly one project has (two that share it are named with their
ids). The orchestrator's instructions point to these and the machine commands in one line: `centralu_commands "machine trust rule grant limits"` finds them all (2 characters more than the line it replaced).

- `list_projects`: each project with its id, folder, machine and whether it is trusted.
- `set_project_trust` with `trusted: false` asks too, in every preset (the reviewer's decision on #1325): it is not only
  narrowing. An untrusted project's sessions read the person's own settings only (`settingSourcesFor`), so the project's
  own deny rules and the hooks that block tools stop applying to its agents, `auto` sessions included; its apps stop and
  its idle sessions restart (a busy one when its turn ends, #663). The card says so; after Allow the project is read again
  (removed, moved, unreachable, or untrusted meanwhile: nothing more changes).
- With `trusted: true` it asks first, in every preset (`ORCHESTRATOR_CHANGE`, allow or deny only): the card names the
  project, its folder and machine, and each of its apps (root and inner) with its description and what it may ask for,
  in the window's trust card's words (`usesLines`, now in the protocol so both say it the same way). After Allow the
  project and its apps are read again: one removed meanwhile, or whose apps changed (an app added by a pull, or what one
  may ask for), is not trusted, and the answer says why; one the person trusted meanwhile is left as it is. What a
  manifest supplies (name, description, the declared background work) is quoted with control and format characters
  escaped, the folder is named whole, and an app whose manifest could not be read, or that a linked machine listed without
  `uses` (an older build), is said to ask for what is not known rather than for nothing. A project whose machine is not
  reachable (its row is the hub's last copy) is refused before the card. A linked machine's project's apps are asked of
  that machine alone (`apps.list` with `machine`, which the router sends to that machine only, so a machine that does not
  answer is an error, not a list without its apps); when they cannot be listed, trust is refused before the card. Every
  app is named with its id quoted (an id is a folder's name). After Allow its folder and machine are checked too.
- The lists (`list_projects`, `list_approval_rules`, `list_app_grants`) say which linked machines are not connected, or
  that the machines could not be read at all, so a list without them does not read as complete.
- `list_approval_rules { project? }` reads Settings' list (`approvals.rules`, a linked machine's merged with its ids
  folded): each rule's id, what it allows, the project or session it belongs to, and since when.
  `remove_approval_rule { id }` removes one at once (`approvals.deleteRule`), as Settings' delete does: it only
  narrows, and that action asks again. An id no rule has is refused. **No command adds or widens a rule**: the window has
  no such call either, and a rule comes only from the person answering a card "always" (`ApprovalRules.rememberAlways`).
- App trust follows the project's since #1141 (a root app and its inner apps run when the project is trusted, and an
  imported app is enabled by trusting its project), so trusting an app is `set_project_trust`. `list_app_grants { app?,
  project? }` lists the apps (`apps.list`) with their trust and sharing and the person's remembered answers to what each
  asked for (`apps.permissions`, routed to a linked machine as the window routes it), and the remembered consents of one
  project reaching another (`projectConsents.list`). `forget_app_answer { app, project?, capability }` and
  `revoke_project_consent { from, to, kind }` act at once (`apps.forgetPermission`, `projectConsents.revoke`): each only
  makes the next attempt ask the person again. `share_app { app, project?, shared }` is the inner app's share switch
  (`apps.setShared`): off acts at once; on asks first, every preset, with a card naming the app, its project and what it
  may ask for. After Allow the app is read again: one removed, already shared, or whose `uses` changed while the card
  stood is not shared. A root app and a user-folder app have no share switch, and are refused before any card. The
  person's answer to an app's own capability question is not given from here: the app asks the person.
- `set_agent_limits { agentCeiling?, agentDepth? }` changes the person's limits on agents: the running agents per project
  (a number, 0 unlimited, or `"preset"` for the preset's own) and the levels of sessions that may start agents (1 to 3).
  "Let sessions look at other sessions" (`sessionTools`) is not one of them: it is not a setting any more (owner decision
  2026-10-20, #1321), so the command has no field for it and refuses one by name. They bound what agents do and cost, the
  orchestrator's own children included, so **every change asks**, narrowing too, in every preset: the card names each
  limit as it is and as it becomes (`→`). Values are checked with `prefs.set`'s own schema before the card; nothing to
  change asks nothing. After Allow the limits are read again, and when the person changed one in Settings while the card
  stood nothing is changed (the card's "from" is not what is set); otherwise one `prefs.set` with exactly the named fields.
  `set_preferences` still has no field for them. The agent models (`agentModels`) stay the person's.

### 1.4 The inventory behind #1219: what the window calls, and what the orchestrator reaches

The owner's direction (#1219): what the person can do in the window, the orchestrator can ask to do, through the same
host checks; consequential or trust-changing actions raise a card the person answers, reading and reversible ones do not.
This is the list that principle is applied to: every RPC method of `packages/protocol/src/commands/methods/` (the
window's channel), grouped, and for each group one of three states.

- **Has it**: reachable by the orchestrator today, as a tool or a rare command behind `centralu_run`.
- **Should**: the orchestrator should reach it, in a slice not made yet, with the card it needs. None is left since the
  fourth slice (below): a method is now *has it*, *person*, or *not an errand* (a drawing aid, or a call that only means
  something to the window), each with its reason.
- **Person**: stays with the person, with the reason. A method here may still be *read* by the orchestrator when the
  group says so.

| Group (methods) | State | Notes |
|---|---|---|
| Sessions: start, message, stop. `agents.createSession`, `agents.send`, `agents.interrupt`, `agents.forkConversation`, `agents.switchTool`, `agents.exportHandoff*`, `agents.updateSettings` | Has it | `create_session`, `send_to_session`, `agent_session` (`stop`, `send`), `start_agent` (a fork), `handoff_session`, `update_session_settings`, each behind the target's preset |
| Reading sessions. `sessions.list`, `messages.load`, `messages.subagent`, `messages.search`, `agents.worktreeStatus`, `agents.autoCompact` | Has it | `list_sessions`, `read_session`, `recall`, `agent_session` (`status`, `list`) |
| Answering a waiting session. `agents.respondApproval`, `agents.answerQuestion` | Has it | `answer_question`, the target's preset and the delegation rules decide (security-boundaries.md) |
| Deleting a session. `agents.deleteSession` | Has it: its own children (`agent_session delete`), and any other worker session behind a card (`delete_session`, #1219 fourth slice) | A move to the session archive keeps the conversation, the worktree and the tool's file but not what the host holds for the session (a caller's wait for its report, delegations, grants, standing start_agent cards), so `delete_session` **asks**, naming that (the unfinished mail threads it is assigned or owns too, since restoring hands none back), when moving the session drops any of it (#1512: `agents.archiveIfAtRest` moves a session only when the list is empty and it is still at rest; the window's dialog reads the losses when it opens (`agents.archiveLosses`, read only, #1595) and calls it on an Archive that has not shown them, and when it lists losses the person confirms again (#1589); an idle local session nobody waits on is moved with no card unless the caller runs under `safe`, since the move is undone with `restore_archived` or Settings → Archive), and the host decides in the step that moves it (a message the person sent meanwhile keeps the session). It refuses the caller itself, an orchestrator or coordinator, a child of the caller (that is `agent_session delete`, #637), a session that is working, waiting on the person or running a background job (archiving ends its process), and one on a machine that cannot be reached |
| Restart or resume. `agents.restartSession`, `agents.resumeSession` | Has it | A send to an asleep or stopped session wakes it |
| Housekeeping of a session. `sessions.rename`, `agents.clearBackgroundTasks` | Has it (#1219, fourth slice) | `rename_session` (a worker session; the answer quotes the old name, so it can be set back) and `clear_background_tasks` (ended tasks only; running ones stay): no card |
| Reading how the agent CLIs stand. `agents.detect`, `agents.usage`, `agents.models` | Has it (#1219, fourth slice) | `agent_status` (installed, logged in, plan and limits) and `agent_models`: read only |
| `agents.stopBackgroundTask` | **Person** | It ends a process the session started, which cannot be undone. A child the orchestrator started is stopped with `agent_session` (`stop`) |
| `sessions.clearError` | **Person**, window only (`window` in `method-rights.ts`) | Done on an error moves the session to idle (#1549): an agent's script must not hide a failure of its own. It carries the newest row the window saw (`seq`) and clears only an error no newer row follows |
| `sessions.markRead`, `sessions.reorder`, `projects.reorder` | **Person** | Marking a session read hides a notice the person has not seen; the order is the person's arrangement of their own sidebar |
| `agents.account`, `agents.capabilities`, `agents.commands`, `agents.listExternalSessions`, `messages.image` | Not an errand | An opaque account fingerprint that only means something compared between two machines (#726), what the composer's menus draw, the "Past conversations" import dialog, and a picture for the screen. No command imports a past conversation |
| MCP and skill proposals. `agents.mcpProposals`, `agents.skillProposals` (the lists) and the `resolve*` calls | Proposing has it (`propose_mcp_server`, `propose_skill`); resolving is **Person** | Approving installs code or changes every orchestrator turn from then on. `agents.orchestratorSkills` and `agents.deleteOrchestratorSkill`: **Person**, they edit the orchestrator's own instructions |
| Preferences. `prefs.get`, `prefs.set` | Has it for theme, text size, fonts, line height, idle sleep, sending with Ctrl+Enter and folded groups; the rest **Person** | `sessionTools` is not a setting (always on, 2026-10-20). `agentCeiling`, `agentDepth`: has it (#1219, third slice), `set_agent_limits`, every change behind a card. `agentModels`: **Person**. `sendWithModifierEnter` and `foldedGroups` (#1219, fourth slice): `set_preferences` sets them with no card (a way of typing and a way of looking; folding names the sessions whose children fold, by id). `accent` is gone from the product (2026-10-20): not offered, and refused by name |
| Themes. `themes.list` | **This change** (read) | `themes.save`, `themes.import`, `themes.resolve`: a theme file is a file in the data folder (docs/themes.md), which an agent can already write; no command |
| Update switches. `updates.status`, `updates.setAuto`, `updates.setAutoApply`, `agents.versions`, `agents.setAutoApplyVersions` | **This change** | Turning "Automatic updates" **on** (`autoUpdate`, both halves) asks (it installs and relaunches without a later question); the rest act at once. `updates.apply` has `update_centralu install`; `updates.answerApply` and `updates.reportApply` are the window's side of an apply |
| Idle sleep. `agents.sleepPolicy`, `agents.setSleepPolicy` | **This change** | |
| Agent CLIs. `agents.applyVersions` | Has it (#1219, fourth slice) | `apply_agent_versions`: the header's "restart idle sessions on the new CLI", at once and with no card; each restart ends a turn only when idle, and a busy session, or one that spoke within the last minute (`keepQuiet`: the orchestrator is not the person's own button), is named and left |
| Notifications. The switches `approval`, `done`, `whenFocused`, `sound` (`notifyPolicy` in `prefs.get` / `prefs.set`, which still carries `error` and `allDone` for older builds; the window no longer raises those two, 2026-10-20) | **Has it** (#1306) | `set_preferences notifications`, no card, except to turn `approval` off, or `sound` while it would still notify. They moved from the window's workspace snapshot into the host's preferences record (as the text size did, #312), carried from the snapshot once; the window reads and writes them through the host and hears every change (`prefs_changed`) |
| When agents compact (#1376). `autoCompact` in `prefs.get` / `prefs.set` | **This change** | `set_preferences { autoCompact: { controlled?, share?, idleShare?, nudge?, nudgeFirst?, nudgeSecond? } }`; no card (reversible, and only about when an agent compacts). Reaches a session when its process next starts |
| The session archive. `trash.list`, `trash.read`, `trash.restore`, `trash.restoreSubagentSteps`, `subagents.usage`, `subagents.trash` | **This change** | List, restore a session or its subagent steps, move subagent steps to the archive: no card. `trash.read` (an archived conversation) and `trash.readRun`: not an errand: `restore_archived` then `read_session` reads a conversation, with the fencing `read_session` has; a second reader of conversation text would need its own |
| Deleting for good. `trash.purge`, `trash.purgeSubagentSteps`, `trash.purgeRuns`, `trash.empty` | **This change**, behind a card naming what goes | One session, or one session's archived steps (`delete_archived`), or all of it (`delete_all_archived`). `trash.empty` itself is not called: it takes everything there is, and `delete_all_archived` deletes what its card named, one call each |
| Workspace layout. `workspace.save`, `workspace.load`, `grid.get`, `grid.set` | **Person** | The window's own state, written whole by one writer (`saveWorkspace`); a second writer erases the other's fields |
| Projects. `projects.add`, `projects.inspect`, `projects.create`, `projects.createPreview` | Has it | `add_project`, `create_project`, each behind a card |
| `projects.list` | Has it (#1219, third slice) | `list_projects`: names, ids, folders, machine and trust |
| `projects.gitStatus`, `projects.origin`, `files.search` | Has it (#1219, fourth slice) | `project_git_status` (branch, changed files, origin) and `search_project_files` (by part of a name, as the composer's @ does): read only |
| Project trust. `projects.setTrusted` | Has it (#1219, third slice) | `set_project_trust`: both ways ask (taking trust away drops the project's own deny rules and hooks); trusting's card names the folder and each app with what it may ask for; both checked again after Allow |
| Project commands. `projects.setCommands`, `projects.setWorktreeSetup`, `worktrees.setTrunk`, `worktrees.createManager`, `projects.delete`, `projects.reorder` | **Person** | Commands and worktree setup run shell commands; `projects.delete` can trash a folder |
| Git and files in a project. `git.*`, `fs.*`, `attachments.save` | **Person** | The window acting on the person's own repository and files. The orchestrator hands this to a session in the project, which has the tools and the preset that decide it |
| Approval rules. `approvals.rules` (read), `approvals.deleteRule` | Has it (#1219, third slice) | `list_approval_rules`, `remove_approval_rule` (it only narrows: no card). No command adds or widens a rule; the window has no such call, and a rule comes only from the person's "always" on a card |
| Apps. `apps.list`, `apps.create`, `apps.sessionTools`, `apps.sessionCall` | Has it | `find_apps`, `attach_app`, `detach_app`, `create_app`; an app's own tools reach a session through its attach |
| App grants. `apps.permissions`, `apps.forgetPermission`, `apps.setShared`, `projectConsents.list`, `projectConsents.revoke` | Has it (#1219, third slice) | `list_app_grants`, `forget_app_answer`, `revoke_project_consent` (they only make the next attempt ask: no card), `share_app` (on asks, with a card naming the app and what it may ask for, checked again after Allow; off acts at once) |
| App trust and imports. `apps.reach`, `apps.enable`, `apps.review`, `apps.setSecret`, `apps.importPrepare`, `apps.importCommit`, `apps.importCancel` | **Person** | Enabling an app is trusting its project since #1141 (`set_project_trust`); importing one brings code in; a secret's value is never handed to an agent |
| App upkeep. `apps.remove`, `apps.restart`, `apps.versions`, `apps.restoreVersion`, `apps.check`, `apps.runs`, `apps.errors`, `apps.usage` | Has it (#1219, fourth slice) | `remove_app` behind a card (the user-folder app's folder moves to `app-trash/`, and it is detached from every session). `list_app_versions`, `list_app_runs`, `list_app_errors`, `app_usage` read; `restore_app_version` (the code it replaces is kept first), `restart_app` and `check_app` act at once but are refused while another session, screen or app has a call in progress in the app (a restart ends it, as the window's Restart does). What an app wrote is quoted as data |
| `apps.questions`, `apps.answerQuestion` | **Person** | A capability question a chain from a screen the person is looking at is waiting on: the answer is a trust decision (it is remembered for the app), and the orchestrator can already narrow one afterwards (`forget_app_answer`) |
| The app builder's channel. `apps.builder`, `apps.createBuilder`, `apps.askBuilder`, `apps.sendError` | Not an errand | How an app's screen talks to its building session. The orchestrator reaches that session as any other: `list_sessions`, `read_session`, `send_to_session` |
| App screens. `apps.viewFrame`, `apps.viewDocument`, `apps.openView`, `apps.closeView`, `apps.recoverView`, `apps.holdViews`, `apps.inlineReopen`, `apps.inlineViews`, `apps.viewMessage`, `apps.readResource`, `apps.invoke` | **Person** | Drawing and clicking an app's screen: they have no meaning without a window |
| Linked machines. `machines.list`, `machines.add`, `machines.remove`, `machines.reconnect`, `machines.setAutoReconnect`, `machines.setConnect`, `machines.install`, `machines.update`, `machines.autostart`, `machines.probe` | Has it (slice 1, #1238) | Six commands and `list_machines`; add, install, update, remove and start at boot behind a card |
| `machines.disconnect`, `machines.rollback`, `machines.uninstall`, `machines.sshHosts`, `machines.activity` | Has it (#1219, fourth slice) | `disconnect_machine` acts at once (the row's button; connecting it again asks, #1341). `rollback_machine` and `uninstall_machine` each ask, in every preset, with a card naming the machine and what happens there (the versions, that the Centralu there stops, what is removed and what stays, and that a disconnected machine is connected for it). `machine_activity` and `list_ssh_hosts` read |
| `machines.acceptVersions` | Not an errand | Since #689 two versions of one protocol connect by themselves (`mayConnect`), and for different protocols the call refuses, so there is nothing to accept; it is the window's answer to a prompt that no longer comes |
| What a machine's sessions may ask of this computer. `machines.setAsks`, `machines.askConsents`, `machines.withdrawAsk`, `machines.need` | **Person** | It widens what code on another computer may do here (#550) |
| Host to host. `host.activity`, `host.sessions`, `host.readSession`, `host.recall`, `host.lastAnswer`, `host.send`, `host.stop`, `host.handover`, `host.hubOffer` | Not the window's | Answered for a linked hub or a switch; no window calls them |
| Terminals, commands and processes. `terminal.*`, `commands.*`, `processes.strays`, `processes.stop` | **Person** | A shell and run commands on the person's behalf, and stopping a process; the orchestrator has no shell of its own, its sessions do |
| The orchestrator's own channel. `orchestrator.get`, `orchestrator.peek`, `orchestrator.configure`, `orchestrator.tools`, `orchestrator.tool` | Not an errand | How the window and the bridge reach the orchestrator itself |

The same methods are classified once more for a caller that is neither the window nor the orchestrator (#1405): a
script or tool holding the limited credential runs the everyday ones and is refused the rest
(`transport/method-rights.ts`; the classes and the rule in [security-boundaries.md](security-boundaries.md), "Who holds
full power"). Everything this table cards in every preset is `asks` there.

The linked machines came first (#1238), then the preferences and the session archive (#1309) and the notification switches (#1313).
The third slice is trust, as the owner asked (2026-10-20): project trust first (`list_projects`, `set_project_trust`),
then approval rules, app trust and grants, and the orchestrator's own limits. In each, what narrows trust acts at once
and what widens it waits for the person's card, which names exactly what changes and is checked again after Allow.
The fourth slice finished the inventory: the machine calls left (`disconnect_machine`, `rollback_machine`, `uninstall_machine`, `accept_machine_versions`, `machine_activity`, `list_ssh_hosts`), deleting a session that is not the caller's child (`delete_session`), app upkeep (`remove_app` behind a card, and `list_app_versions`, `restore_app_version`, `restart_app`, `check_app`, `list_app_runs`, `list_app_errors`, `app_usage`), the harmless preferences and `apply_agent_versions`, and the housekeeping and reads (`rename_session`, `clear_background_tasks`, `agent_status`, `agent_models`, `project_git_status`, `search_project_files`). Where the slice did not give a method a command, the row says why: the person's (it cannot be undone, or it hides something from them), or not an errand.

## 2. The AgentAdapter contract (the implementation spec for product spec §6.2)

```ts
interface AgentAdapter {
  readonly tool: ToolName                  // a closed enum in @cc/protocol — see #74
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>          // installed / logged in (FR-19)
  installedVersion?(): Promise<string | null>  // #297: the CLI installed now, read without a session (§4.6)
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>
  resume(externalId: string, opts): Promise<SessionHandle | null>  // null = resume not possible
}

interface SessionHandle {
  readonly externalId: string
  send(input: UserInput, opts?: { origin?: InputOrigin }): void  // origin: only { kind: 'human' }, for the person's own typing
  sendTracked?(text: string, observer?: InputObserver): Promise<void> // host-only completion receipt (#592)
  respondApproval(requestId: string, decision: Decision, scope?: Scope): void
  interrupt(): void
  stopBackgroundTask?(taskId: string): Promise<void>  // #290: stop one background task alone
  dispose(): Promise<void>
  events: Emitter<NormalizedEvent>         // emits protocol types only
}

interface AdapterCapabilities {
  approvals: boolean            // can permissions be overridden per session (reflects the M0 result)
  contextUsage: 'exact' | 'estimate' | 'none'
  resume: boolean
  autoTitle: boolean
  attachments: ('image' | 'file')[]
  verbosities: string[]         // response-length steps; empty = the tool has no such knob (#54)
  exclusiveWriter: boolean      // nobody else can write the conversation while we hold it
  backgroundTasks: boolean      // reports its background work as `background_tasks` (#290)
  toolDeferral: boolean         // can individual Centralu definitions wait behind tool search
  instructionChannel: 'server' | 'developer' // where Centralu's tool instructions reach the model (#525)
  processModel: 'per-session' | 'shared-server' // whether one CLI process owns one or several conversations
  builtInSubagents: boolean     // child-agent events are normalized by this adapter
  peerMessaging: boolean        // the CLI has a direct session-to-session path (#575)
  midTurnInput?: boolean         // send accepts a message during a running turn without interrupting it (#592)
  sleep?: boolean               // #568: an idle session may be put to sleep (resume measured to keep the cache); §4.6.1
  presets?: PermissionPreset[]  // the presets it can keep; absent: all (Cursor keeps `auto` only, plans/acp-adapter.md §0.1)
  keepsRepoFilesOut?: boolean   // can be kept from a project's own files when untrusted (#92); absent: true
  roleText?: boolean            // takes Centralu's role text (`systemPromptAppend`); absent: true
}
```

Implementation rules:

- **External SDK types may not leave adapters/<tool>/** (anti-corruption). The adapter's only output is `NormalizedEvent`.
- **A tool call carries its card and its record** (#221). `summary` is what the card shows and may be cut short;
  `tool_call.input` is the input the tool received, as it received it, and `tool_result.output` is the whole text it
  answered, uncut, with images left out (they go out as `message_image`, #40). The host keeps the record in the store
  and strips it from everything it sends ([protocol.md](protocol.md) §2), so an adapter never has to choose between a
  small card and a complete record.
- **A native subagent's steps go out wrapped, tagged with the launching call** (#222). Never as the parent's own events
  (#98): a `subagent_event` whose `step` is a text, reasoning, tool call or tool result, and whose `parentCallId` is the
  call that started the subagent. Claude: the subagent's messages carry `parent_tool_use_id`, and `forwardSubagentText`
  makes its text and thinking arrive, not only its tool blocks; the normalizer reads them as the parent's and wraps them.
  Codex: a child thread's `item/*` notifications arrive on the parent's connection with the child's `threadId`; the
  parent's `spawnAgent` item names the child in `receiverThreadIds` on `item/completed`, and a child's items that arrive
  before that (measured: the child's first notification came in the same millisecond, before the link) are held and
  replayed. Only official routes are used — the SDK's stream and the app-server's notifications, never the tools'
  transcript files. The manager stores the steps in `subagent_messages`, apart from the conversation, and sends them on
  as cards. A file a subagent changed is still reported as the session's (`files_touched`), and a commit it made is
  attributed to the session (#50).
- **Background work is reported as one level, `background_tasks`** (#290): every live task after a change (REPLACE
  semantics, so a missed message cannot leave a task "running"), and the tasks that just ended with their status
  (`completed`, `failed`, `stopped`). Each task carries `{ id, kind: agent | shell | mcp | other, description,
  parentCallId?, ambient?, stopsWithTurn?, stoppable?, timer? }` (`timer`: a timer the tool holds, not work, #721). `stopsWithTurn` is what interrupting the turn does to it,
  **as measured for that tool**, and absent where it was not measured; it is what the session's Stop control says
  before it is pressed. An adapter that cannot see its background work declares `capabilities.backgroundTasks: false`
  and sends nothing rather than guessing. An adapter that reports it also releases it: when its process goes away it
  sends the live set empty, with what it held ended as `stopped`.
  - **Claude** reads `system/background_tasks_changed` (the level; no tool_use_id), `task_started` (the launching
    call, `owned_by_subagent`), `task_updated` and `task_notification` (the ending). Measured
    (`scripts/probe-background-tasks.mts`, CLI 2.1.282, SDK 0.3.263): `interrupt()` mid-turn stops a background
    subagent (`task_notification` stopped, in the same millisecond) and **leaves a backgrounded shell running**;
    `stopTask(id)` stops one task with the same three messages; `close()` kills what is left and emits nothing.
  - **Codex** lists each child thread a `spawnAgent` item named while the thread is active, and ends it with the
    child's `turn/completed` status. Measured (`scripts/probe-codex-background.mts`, codex-cli 0.160.0):
    `turn/interrupt` on the parent's turn **leaves the child running**; `turn/interrupt` on the child's own turn stops
    it, which is the per-task stop. Codex's interrupt does not kill a command the child was running.
  - The manager keeps the list per session (`SessionInfo.backgroundTasks`, live-only like `goal`), applying each
    event with `applyBackgroundTasks` — the same function the UI's reducer and the mock run. `sessionIdle()` says
    whether a session's process can be swapped without losing work (#297): no turn, no pending approval or question,
    no running task that is not ambient, and never idle while a tool that cannot report background work holds a
    process. The rule itself is `sessionIdle` in `idle.ts`, next to `hostBusy` (§4.5).
  - **The running tasks survive a host swap** (#648). The tool lists its level only when it changes and says nothing
    at startup, so a host that adopted a kept process read every session as idle, and the sleeper or a definitions
    refresh closed the process over a running dev server. The manager writes the running set to the store on every
    change and when a process starts (`background_tasks:<id>`, empty for a new process); the host that adopts the
    process lists the session from that record and hands it to the adapter (`ProcessSource.adopt.backgroundTasks`),
    whose tracker is seeded with it so the tasks' endings are reported (timers excepted: they are read back from the
    transcript). A session whose record is missing (the previous host predates it) is `background_unknown`, so it is
    not put to sleep, until the tool's own full list arrives (`background_tasks` with `snapshot`, Claude's
    `background_tasks_changed`), or until it has been quiet for two hours, which is logged and recorded as none. A level
    built from an ending or a timer neither settles it nor is recorded. The record goes when the session is deleted.
  - **Restarts and background work** (#648). A restart that changes safety (the permission preset, the launch
    settings, the tool definitions a profile serves) waits only for the turn: an idle session restarts at once, and a
    mid-turn change applies when the turn ends, whatever runs in the background or is unknown. Any other deferred
    restart (a model, an app set) also waits while listed background work runs, at most one hour
    (`applyDeferredRestart`, in `RestartPolicy`, `sessions/restart-policy.ts`). A restart that ends background work, or work that is unknown, says so in the
    conversation first (a `restart` notice naming the tasks).
- **The CLI version a process runs is reported once per process, as `agent_version`** (#297). Claude: the init
  message's `claude_code_version` (init comes again with every query; only a change is sent). Codex: the `initialize`
  answer's `userAgent`, `<client name>/<server version> (<os>) …` (measured, codex-cli 0.160.0:
  `centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)`); `protocol-contract.json` lists the
  field so a rename fails the drift check. An adopted process says nothing again, so its version comes from the
  keeper tag (§4.6).
- **What the tool tells its own user goes out, in its own words** (#304): a fresh conversation as
  `conversation_reset`, text meant to be read as `notice`, a setting the tool switched by itself as `settings_changed`
  with `by: 'tool'` (its snapshot is what the process was launched with plus the switched field; the host applies only
  what differs), a retry as the `retrying` activity until output flows again. Measured payloads (CLI 2.1.289 through SDK
  0.3.263, codex-cli 0.160.0, 2026-10-04) unless marked otherwise:

  | Tool | Message | Becomes |
  |---|---|---|
  | Claude | `conversation_reset {new_conversation_id, trigger: 'clear'}` on `/clear`; then an `init` with a new `session_id` | `conversation_reset` |
  | Claude | `system/informational {content, level}` — a `UserPromptSubmit` hook's block reason arrived as level `warning`, `prevent_continuation: true` | `notice`; level `info` is left out (the CLI shows it only in transcript mode) |
  | Claude | `system/notification {key, text, priority, color}` (not exercised) | `notice` at a level folded from colour and priority; "Error compacting conversation" is left to the failed-compaction marker |
  | Claude | `system/api_retry {attempt, max_retries, retry_delay_ms, error_status, error}` — a 529 answered twice, then a synthetic "API Error" message and an error result | `retrying` once per episode plus a host.log line per attempt; the previous activity comes back on the next stream event or assistant message |
  | Claude | `system/model_refusal_fallback` (not exercised; sdk.d.ts) | scope `session` or absent: a notice and a `settings_changed` with the fallback model. Scope `local` (a subagent): host.log only. `retracted_message_uuids` is not acted on |
  | Claude | `system/model_refusal_no_fallback` (not exercised; the CLI sends `content: ""` on its main-thread paths) | held until the result: the failed turn's error message, or a notice if the turn did not fail. Text: `content`, else the refusal's explanation, else its category |
  | Codex | `configWarning {summary, details}` while `thread/start` is answered, then `warning {threadId, message}` with the same text, on every start and resume | `notice` with `oncePerSession`; the unknown-key text becomes "Codex ignored N settings in `~/.codex/config.toml`", the keys one per line, `for you` |
  | Codex | `deprecationNotice {summary, details}`: the owner saw "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`…" (#342). `guardianWarning {threadId, message}` (not exercised) | `notice` (the first once per session). The full-history one becomes "Codex says Centralu loads thread history in an outdated way", `for Centralu` |
  | Codex | `mcpServer/startupStatus/updated` — a failing server goes `starting` → `failed {error}` twice on one thread start | one `notice` per server in Codex's words (`MCP client for \`x\` failed to start: …`), again only after it started in between |
  | Codex | `model/rerouted {turnId, fromModel, toModel, reason}` (not exercised) | `notice` only: it names a turn, and the thread's settings do not change with it |
  | Codex | `thread/settings/updated {threadSettings}` (not exercised) | measured against what `thread/start`/`thread/resume` answered (Codex answers a default with a concrete model), and only a real difference becomes a notice and a `settings_changed` |
  | Codex | `thread/resume` answers `model` and `reasoningEffort` of the thread; a failed turn's `error.message` is the provider's body, e.g. `{"status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."}}` (#1369) | The session's model is sent with every `thread/resume` and `turn/start` (`TurnStartParams.model`: "this turn and subsequent turns"). What the resume answers is compared with what the session shows: no model recorded, or another one answered, and the thread's model (and effort) become the session's, taken by the host as it registers the handle (`SessionHandle.takeOpenedSettings`, `sessions/opened-settings.ts`; a resume that answers later sends a `settings_changed` the tool made), with a warning notice for the second. A recorded model that the thread answers alike changes nothing, and a session started here on the default stays on it (Codex answers a default with a concrete value, which nobody chose); only a conversation taken over from elsewhere adopts the thread's values when its record is on the default. Turns ask for the thread's model only after a mismatch with a recorded one, and again after a switch made outside Centralu (`thread/settings/updated`), so no turn undoes what the screen shows. So the screen never names a model other than the one running. A refused model is an `error` with `retryable: false` and `data: {reason: 'model_rejected', model}` (`code` stays `internal`, so an older window shows it as any failed turn); the window adds "Pick another model", which opens the session's model menu. Not exercised against a live account: the PC it was written on had no Codex login |

  A child thread's notifications stay out of the parent's conversation, as before.

  Every notice also carries who is speaking and what kind it is (`from`, `label`), and where the adapter can tell, who
  has to act (`audience`, #342). Codex's are worded in `adapters/codex/notices.ts`:

  | Codex notice | Line | Whose |
  |---|---|---|
  | unknown `config.toml` keys (`configWarning`, its `warning` twin) | "Codex ignored 2 settings in `~/.codex/config.toml`", keys one per line, "Codex already runs without them; removing them from the file only silences this notice." | `you` |
  | other `configWarning` | Codex's text | `you` |
  | full-history hydration (`deprecationNotice`, both wordings in the 0.160.0 binary) | "Codex says Centralu loads thread history in an outdated way", "Nothing to do on your side; Centralu will switch to the paginated API (#342)." | `centralu` |
  | other `deprecationNotice` | Codex's text | `centralu` if it names an app-server method (`thread/…`, `turn/…`, `review/…`), `you` if it names `config.toml` or `[features…]`, else unsaid |
  | MCP start failure | Codex's text | `centralu` for Centralu's orchestrator bridge, unsaid for an app's bridge (`app-<id>`, it may fail for the app's reasons), `you` for any other server |
  | `warning`, `guardianWarning`, `model/rerouted`, thread settings changed | Codex's text (or ours, for the last two) | unsaid |

  Claude Code's notices carry `from: 'Claude Code'` and a label (`hook` — `for you`, `notice`, `model switch`,
  `refusal`). The explanation is the host's because recognizing a notice means knowing the tool's wording; the screen
  only draws what it is given, and Codex's own words stay one click away.
- Adapters hold no state — tracking session state is done by `sessions/` watching events. The adapter is a converter.
- **What both adapters do the same way is written once, in `adapters/session-kit.ts`** (#428), since copies of it
  drifted into bugs. A line Centralu itself says in a chat (a `/goal` confirmation or refusal) is `adapterNotice`: an
  assistant message with its own `messageId` (`centralu-notice-<n>`, counted across the host), so the record never
  joins it onto the model's open reply. Codex's `/goal` replies named no message and were glued onto it mid-turn.
  A message the person sent that the CLI will never read is said with `undeliveredError` / `undeliveredText` ("N
  message(s) were still queued when the session closed and were not delivered — please resend"), never dropped: the
  screen already shows it as sent. Codex closed while a lazy resume was still waking used to drop the messages sent
  meanwhile without a word (both places that spoke for them stood aside for each other); `dispose` and `detach` (a host
  swap: the next host resumes the thread, not those messages) now say them, and a
  resume that fails or outlives its cap names them inside the one error that retires the handle.
  Open cards are a `PendingCards`: every way a card goes (answered, withdrawn by the CLI, the turn stopped, the handle
  closed) goes through `take` or `release`, which removes it before it is closed, and the adapter says
  `approval_resolved` / `question_resolved` there. A turn is said stopped only once the tool confirms the
  stop: Codex's `turn/completed`, Claude's answer to the SDK's `interrupt()` or the stopped turn's result, whichever
  comes first. Claude used to say it at once, so a rejected interrupt showed the turn stopped while the CLI kept
  working. A Stop that has not taken effect (either tool refuses the interrupt, or nothing confirms Claude's within
  `stopConfirmMs`, 10 s) leaves the turn running, and is said as a notice (`stopNotConfirmed`, label
  `STOP_NOT_CONFIRMED_LABEL`), not an error: an error moves the session to `error`, which the manager takes as the
  turn's end (delegation waits settle, queued requests go in), and the turn's own ending (`waiting_input`) is not a
  move `error` allows. The notice also clears the wait's `stoppedByPerson` (`AgentRunWait`), so a child that then
  finishes hands its answer to the one waiting. A second Stop joins the first one's wait and bound; one pressed after
  the bound was said starts the bound again on the same wait. A confirmation after the bound still ends the turn as
  stopped. A turn that fails or hits a limit while a Stop waits ends as it did: nothing says it stopped after that.
  Only an idle Claude session's refused interrupt is still `couldNotStop`, after it was said stopped. The window's
  Stop button says "Stopping…" from the click until the turn ends, through an approval in it, and shows the notice's
  text when there is one (`stopping`, ActivityRow). Cards are still answered with a refusal before the stop is known
  to work, so a tool whose card was denied stays denied when the stop is refused.
- **"Always allow" adds the matcher the answer carried, and nothing without one** (`always-allow.ts`, both adapters).
  The UI computes and shows the matcher and the manager saves exactly it, so the live rule, the saved rule and the
  screen agree. Claude used to fall back to the command text: a rule nobody saved or named, gone at the next restart.
  The key and the match are written once, in protocol (`alwaysAllowKey`, `matchesAllowRule`), and core's suggestion
  and preview, the UI's matcher and both adapters read them: a command trimmed, a file edit's path, nothing for an
  edit with no path (the card offers no "always" for it and the manager saves no "(no path)" rule), none for a command
  flagged outside the sandbox, for the network or as terminal input or ending in `*`, and an exact match with `*` a
  literal character (#838; it was a wildcard at the end, which made "always" on `cat logs/*` a prefix rule). The copies had drifted: a command with surrounding whitespace never matched its own rule,
  and core's preview read a `*` in the middle as a wildcard the host did not honour.
- Process management (spawning the CLI, crash detection) is the adapter's own responsibility. A crash is emitted as an `error` event and the host does not die.
- **A launch a tool declared it cannot keep is refused before any process starts** (`presets`, `keepsRepoFilesOut`,
  `roleText`; `launchRefusal` in protocol, applied by `startFit` in `sessions/session-start.ts` at every start and wake, and through `ToolRegistry.refusal` with
  the session read by `sessionDemands` (`sessions/tool-fit.ts`) to a tool switch, a preset changed on a running session
  and the orchestrator's tool).
  The host is the gate whatever path asked; the pickers ask the same rule and grey the tool with the same words.
  Claude and Codex declare none of the three, so nothing changes for them ([plans/acp-adapter.md](plans/acp-adapter.md) §0.1).
- A capability is not necessarily a static declaration; it can be **decided at detect() time** (e.g. if whether approvals work depends on the Codex version, decide after detecting the version — the C4 response).

### 2.1 Claude query options and independent-session messaging (#569)

`ClaudeSession.start` is the single SDK `query({ options })` construction site. Both
`SessionManager.createSession` and the resume/wake path use it, for ordinary sessions,
orchestrators, coordinators, worktree managers, builders, app agents and `start_agent` children.
The two build the adapter's options in one place (`SessionStarts.launchOptions` in `sessions/session-start.ts`, #428), so an option
added there reaches a new session and a wake alike (`sessions/launch-options.test.ts`).
Its `spawnClaudeCodeProcess` callback sends the SDK's flags and environment to either the local
spawn or the keeper; a fresh keeper replacement therefore receives the same options.

`withoutCrossSessionMessaging` wraps the existing options in the Claude adapter, under every preset: `auto` too
(the mailbox plan's slice 0, §9.6; this narrows #603 for this one control). It merges inline SDK flag settings
with `crossSessionInbound: 'refuse'`, appends discovery denies `ListAgents` and `ListPeers`,
and merges `process.env` and any explicit environment with `CLAUDE_CODE_HARBOR_KITE: '0'` last, without `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`.
The Claude launch fingerprint (`launchSettingsFingerprint`) is version 3 for `auto`, so a kept `auto` process started before the controls is restarted once by the #589 path.
The adapter previously selected settings files only through `settingSources`; inline `settings`
are a separate layer and do not replace that selection, permission options, MCP servers or
resume IDs. `SendMessage` is deliberately left available for this query's own subagents.

The environment gate disables peer discovery, cross-session sends and inbox binding in the
inspected CLI versions 2.1.263–2.1.299. It is undocumented, version-sensitive and undoable by the `env` of the person's user settings, so the
documented refusal and discovery denies stay as additional controls. They do not alone block
every outbound send to a known peer if the gate changes. A keeper adoption attaches to an
already-running process and cannot apply new startup controls. The `auto` launch fingerprint is version 3, so the host
that adopts a retained `auto` process started before the controls restarts it once through the normal launch-settings
handover path (#589): at once when it is idle, after its current turn otherwise. Nothing needs to be restarted by hand.
See [security-boundaries.md](security-boundaries.md).

The regression matrix in `sessions/setting-files.test.ts` checks the options for each kind on
start and resume across trust and permission presets; adapter tests check merging and the keeper
spawn path. For runtime validation before SDK/CLI upgrades, run
`pnpm exec tsx packages/agent-host/scripts/probe-cross-session.mts`: two Haiku sessions in
temporary folders, with Centralu's shared controls, test discovery, delivery and `SendMessage`
to its own background subagent. This is a manual billable probe; it requires sockets and Claude sign-in,
sets a temporary `CC_DATA_DIR`, and never starts a host or uses `~/.centralu`.

## 3. Procedure for adding a new tool (C3 — the reason this document exists)

1. Create `adapters/<tool>/` and implement `AgentAdapter` (event conversion + detect + capability).
2. Add the tool to `ToolName` and give it a `TOOL_META` entry in `@cc/protocol` — display
   name, one-glyph mark, install command, login command. Then register the adapter in the
   `adapters` Map in `main.ts`.
3. Add contract tests: recorded raw response fixtures → NormalizedEvent snapshot verification. For a new tool, record
   with the tool-neutral frame tooling in `adapters/frames/` (#1498): the recorder (`CC_RECORD_FRAMES`), the scrubber
   (`scripts/frames-scrub.mts`), the replayer with the protocol's `FrameCodec`, and the scenarios driven at the
   `SessionHandle` level, so the fixtures are what the adapter itself sent and received (the ACP adapter's are made by
   `scripts/acp-record.mts`, [plans/acp-adapter.md](plans/acp-adapter.md) §0.5 and §10).
4. Write down the vendor surface you depend on, and give it a drift check (see §3.1) —
   hand-won protocol knowledge rots silently otherwise. Fill in the contract's `surface`
   (`adapters/contract/surface.ts`, #270) too: how to read what the tool offers without a turn,
   what the adapter blocks, drops or works around (each with its measurement), and a recorded
   baseline. The weekly drift run then watches the new tool in the other direction as well.
5. Done. **ui, core and platform are unchanged**, and protocol changes only by the two
   entries in step 2. (If more was needed, that is not the adapter's fault but the protocol
   lacking a concept — consider extending the protocol first)

This claim used to be stronger and untrue: it said protocol was unchanged too, while in
practice a third tool meant editing roughly twenty hard-coded sites across eleven files —
three separate `TOOL_LABEL` maps, inline `tool === 'codex' ? … : …` ternaries in the sidebar
and the host, the badge letter, the install and login commands, and four literal
`['claude', 'codex']` arrays. The behavioural half of the boundary was always clean; the
presentational half leaked, which is the wrong way round, because it meant the cost of a new
tool was paid in small edits that this directory gave no hint about. `TOOL_META` exists so
that the sentence above can be true (#74).

**Capability never goes in `TOOL_META`.** What a tool *can do* is declared by its adapter
(`AdapterCapabilities`, `ModelOption`) and discovered at runtime; `TOOL_META` holds only how
to present it. Mixing the two is how a knob ends up having to be taught to the UI twice.

### 3.1 Vendor-surface drift checks (run these before any SDK/CLI upgrade)

Everything we know about a vendor's protocol was learned by measuring, and a vendor
upgrade can un-learn it without an error anywhere. Each adapter therefore keeps an
explicit list of every vendor name it touches, and a script that re-verifies the list:

| Tool | Contract | Check | What it catches |
|---|---|---|---|
| Codex | `adapters/codex/protocol-contract.json` — every RPC method and notification we send or read, plus approval enum values; and `adapters/codex/generated/`, the params types of those notifications and requests and what they import, which the adapter is compiled against (#1339) | `pnpm codex:bindings --check` (regenerates bindings from the installed CLI, greps for our names, and compares generated/ with what it makes) | a method/notification leaving the protocol (change axis C4), and a type the adapter reads changing |
| Claude | name lists inside `scripts/claude-sdk-drift.mjs` — SDK exports, option keys, response fields — plus a runtime argument probe: every explicit `permissionMode` must reach the CLI unchanged, accepting both `--permission-mode value` and `--permission-mode=value`; spawn is intercepted so no CLI runs (#578) | `pnpm drift:claude [version]` (installs `@latest`, or the given version, into a temp dir, never the workspace) | a name leaving the `.d.ts`, or the SDK dropping, rewriting or bypassing an explicit mode, **before** an upgrade lands it on us |
| Claude (resume) | that a resumed process reads the prompt cache as a live one (#568, §4.6.1): what makes putting idle sessions to sleep free | `pnpm exec tsx packages/agent-host/scripts/probe-resume-cache.mts` (live, haiku, a temporary data folder; exits 1 when the woken turn reads under 90% from cache) | a CLI whose resume rebuilds the request differently: sessions would still wake, only slower and dearer, and nothing else would say so |
| Every adapter (the other direction, #270) | the contract's `surface` (`adapters/contract/surface.ts`): a reader of what the installed tool offers (Claude: the SDK's stdout message union, its `Options` keys and `Query` methods, and the CLI's `--help`; Codex: the generated client request, notification and server request methods, and its `--help`), the adapter's `limitations` (what it blocks, drops or works around, each with its measurement), and `adapters/<tool>/surface-baseline.ts` (what was last reviewed) | `pnpm drift:surface` (reads the latest published tools without a session or a turn; `--record` rewrites the baselines, `--file-issue` is the weekly job) | a command, message type or capability the tool now offers that nobody reviewed, a limitation whose reason may be gone (`/goal` stayed refused for weeks after the CLI ran it headless), or one on a name the tool dropped. Filed as one issue per tool; the job stays green |

The surface check is news, not a break, so it files an issue instead of going red. What was reviewed is
accounted for by test: every message type in an adapter's baseline is mapped, ignored on purpose, or a
limitation (`claude/surface.test.ts`, `codex/surface.test.ts`), and a `dropped` one stays out of the known
set so `UnmappedTypes` still logs its first instance. Claude's slash commands are listed only by a running
CLI, so they are compared at run time instead: the init message's `slash_commands` against the command
limitations, one host.log line each (`initSurfaceLines`); a limitation the adapter already follows by
itself (`followsOffer`, `/goal`) says nothing.

Claude's `normal` preset resolves `permissions.defaultMode` with the SDK's `resolveSettings` and
`filterEscalatingDefaultMode`, using the same settings sources as the session, then sends it explicitly.
With no valid mode, or a failed read, it sends `default` so tool calls needing permission still reach
`canUseTool`. A session reading no settings files carries only the person's user-tier mode (#382).
A configured bypass still bypasses the callback; neither an absent mode nor an escalating mode in a
committed project file selects bypass. Normal's launch fingerprint is now v2: after a keeper handoff,
the host refresh restarts retained v1 processes, immediately when idle or after the current turn finishes
(#589). The resumed process receives the explicit mode. Safe's derived flags did not change, so its
fingerprint stays at v1. Auto's is v3 since the cross-session controls reached it (the mailbox plan's slice 0): a kept `auto`
process from before them is restarted the same way, once.

Released betas since beta.1 sent no `--permission-mode` under `normal`. With the person's Claude Code
CLI >= 2.1.285 and a third-party provider or telemetry off, headless sessions start in auto mode when
no configured settings mode overrides that default: a classifier, rather than Centralu's approval,
decided tool use. The exposure depends on the person's installed CLI, not just the pinned SDK.

The [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
records two separate changes: 0.3.286 leaves an omitted mode to the CLI, which can choose its automatic
classifier without a configured mode; 0.3.295 encodes named options as `--flag=value`. The latter broke
our old minified-source regex in 0.3.296. Both 0.3.263 (the lockfile pin) and 0.3.296 preserve explicit
modes in the spawn probe. This verifies argument building, not live CLI approval decisions.

Both are name checks (Claude's argument probe aside), run in both directions: the vendor must still carry every name
we use, and our source must still use every name listed (so the contract cannot
outlive the code). They cannot catch a field that still exists but changed meaning —
that class is guarded by runtime plausibility checks in the adapters (the
`149,084%` context-gauge lesson). Nor can they catch a notification that keeps its name but
stops arriving: the Codex compaction marker came only from `thread/compacted`, which stays in
the bindings (marked deprecated in favour of the `contextCompaction` item) while no measured
CLI sends it, so no Codex compaction left a marker ([#303](https://github.com/ijun17/centralu/issues/303)).
A probe against the real binary (`scripts/probe-codex-*.mts`) is the check for that class.

**The rule that keeps them honest:** when adapter code starts depending on a new
vendor name — a new notification, a config key, a field — add it to the contract
**in the same PR**. A new tool (step 4 above) starts by creating its own equivalent
of one of these.

**The other direction, at runtime: unmapped types** ([#58](https://github.com/ijun17/centralu/issues/58),
[#270](https://github.com/ijun17/centralu/issues/270)). The checks above notice a name we use leaving the vendor's
surface. They cannot notice a type we do not use *arriving*, and protocol.md §4 makes an adapter drop what it does not
know. So each adapter keeps a second list, of every type it maps or leaves out on purpose
(`CLAUDE_KNOWN_TYPES` and `CODEX_KNOWN_NOTIFICATIONS`, grouped as in the #58 survey). The first time a session
receives a type outside that list, `adapters/unmapped.ts` writes one host.log line:
`[claude] 1a2b3c4d unmapped message type: system/permission_denied`. Nothing on screen changes. Types the survey wants shown
but nobody has wired yet stay off the list on purpose, so their first real instance is a grep away. When you wire one,
or decide it is noise, move it onto the list in the same PR. Server *requests* need no list: the Codex adapter already
logs every request it answers with `{}`. The weekly counterpart, which hears of a type before any session receives
it, is the surface check in the table above: a `dropped` limitation there is exactly a type kept off this list.

## 4. Session lifecycle and UI reconnection

```
UI disconnects  → the host does nothing (sessions carry on, events accumulate in event-log)
UI reconnects   → hello { afterSeq, streamEpoch } → replay the missed events (same lifetime, within budget)
                  or resync (another lifetime, out of the buffer, over budget) → restore the screen
host restarts   → under the keeper: agents, terminals and commands keep running there; the new
                  host re-attaches to them mid-turn (§4.3) → a new streamEpoch → UIs resync
                → without a keeper: session processes die → a new streamEpoch → UIs resync
                  → attempt resume with the externalId from the store (the same path as FR-10)
                  → a session that was mid-turn is reset to idle with a `quit` marker (§4.6.2)
host swapped    → the old host drains, the new one takes over behind the same front door (§4.2)
                → clients reconnect to the same address and resync on the new streamEpoch
keeper updated  → the old keeper hands every handle to the new build's keeper (§4.4): the host,
                  agents, terminals and every connection carry on; nothing reconnects
app quits       → background mode off (default): the keeper stops the host, as above
                → background mode on: nothing happens to the host; a relaunched app re-attaches
app relaunches  → "Apply now" (#352): the app announces it first, so with either mode nothing
  to update       happens to the host; the relaunched window re-attaches and switches (§4.5)
```

Thanks to this design, half of FR-10 (restore on restart) is the same code path as an ordinary reconnect — it is the default behaviour, not a special case. The rules for the cursor, the replay budget and the transport bounds are in [protocol.md](protocol.md) §1.

**One host per data folder** (`dev-services/instance-lock.ts`). Two hosts on one folder would each hold their own session list and write to the same `store.db`. Ownership is an exclusive SQLite transaction (`BEGIN EXCLUSIVE` on `host-ownership.sqlite`, DELETE journal mode) that the host holds for its whole lifetime (#82): taking it is atomic, a second host is refused at once, and the operating system releases it when the host dies, however it dies, so a crash leaves nothing stale. `host.lock` (pid and start time; since #1223 also `at`, when it took the folder, `by`, who started it — `app`, `keeper` or `serve` — and for serve `from`, the hub whose link asked and the ssh client's address) remains as the description of the owner in the conflict message, and nothing more: until #461 a live, matching `host.lock` also refused the start, for hosts from before #82 that knew only that file. Before #82 ownership was the file alone, checked and then written: 8 hosts started at once produced 2 owners. This is single-machine ownership — not a distributed lease, and not for a data folder on a network filesystem.

### 4.0 How the host starts, on each platform

This is the one list. The window decides in one pure function, `start_plan::plan` in the keeper crate
(`apps/desktop/src-tauri/keeper/src/start_plan.rs`), from what it knows: the OS, debug or release, the variables
below, whether a bundled host is in its resources, whether a keeper answers on `<data>/keeper.sock`, whether the shell
already fell back once in this window's life. Every start site asks it: the window's first start and its retries, and
each keeper start. Each row below is a row of its table test (`every_row_of_the_start_table`), and a second test checks
every combination of those facts against the code the plan replaced.

`centralu --keeper` is not a start site any more (#461). The window's executable runs the keeper only when a debug window
started it with `CC_KEEPER_IN_PROCESS` (the `KeeperInProcess` row); started that way by anything else, it exits at once
with 64 and opens no window (`keeper::exe::run_from_window`). Until 0.1.0-beta.16 it `exec`ed the `centralu-keeper`
beside it, for keepers of 0.1.0-beta.11 and earlier, which hand over by starting the new build's window executable as
`centralu --keeper --take-over-fd 3 ...`, and for windows from before #440; such a keeper now never hears `ready` and
rolls back, and the window offers "Restart completely". A bundle with no `centralu-keeper` beside the window (assembled
by hand) used to run the keeper in the window's executable; it now fails to start its keeper and says so.

| Where | Variables | Mode | What runs | Why |
|---|---|---|---|---|
| macOS release | none | `ThroughShell` | the window opens `<data>/shell/Centralu.app` through LaunchServices, which starts `centralu-keeper` from `<data>/content/<version>/` and the host from that verified copy (§4.1) | the shell holds macOS permissions across updates ([plans/thin-shell.md](plans/thin-shell.md)) |
| macOS release | `CC_SHELL_UNPINNED=1` | `ThroughShell` | the same, and a shell the window carries unpinned is opened too | checking the path by hand with a temporary `CC_DATA_DIR` |
| macOS release, the shell fell back (refused, not carried, unpinned, not installable, not opened, no report) | none | `KeeperBeside` | the window starts the `centralu-keeper` next to its own executable; the host runs from `<data>/hosts/<key>/` | agents must keep working; the window does so for the rest of its life |
| macOS release | `CC_KEEPER_HOST_SOURCE` (any value) | `KeeperBeside` | the keeper beside the window, running the named folder (a blank value: the bundled host) | the keeper scripts' way of naming a host, which the shell would not run |
| macOS release with no bundled host (`cargo run --release`) | none | `KeeperBeside` | the keeper beside the window, the source host, the dev data folder | there is nothing for the shell to verify |
| a keeper already answers | | `Attach` | nothing is started; the window attaches | one keeper per data folder |
| macOS debug (`pnpm app:dev`) | none | `Direct` | the window runs the source host through tsx, `CC_DEV=1` | the app is the host's parent, as before the keeper; a bundled host left in `target/debug` is ignored |
| macOS or Linux debug | `CC_USE_KEEPER=1` | `KeeperInProcess` | the window starts itself as `centralu --keeper` with `CC_KEEPER_IN_PROCESS=1`; the keeper runs the source host | `tauri dev` builds only the window, so a `centralu-keeper` beside it may be older code ([architecture.md](architecture.md) §4.1) |
| any | `CC_HOST_CMD` (any value) | `Direct` | that command line (a blank value: the bundled or source host) | the escape hatch for running some other host |
| Linux release (AppImage, deb, rpm) | none | `Direct` | the window runs the bundled host through the system Node | the real window has not yet run the keeper on a Linux desktop ([spikes/2026-10-linux-keeper.md](spikes/2026-10-linux-keeper.md) §7, runtime-unification step 4b) |
| Linux debug | none | `Direct` | the source host through tsx | as above |
| Linux release | `CC_USE_KEEPER=1` | `Keeper` | the window copies the keeper beside it (`usr/bin/` in the AppImage) and its bundled host into `<data>/content/<version>/` (`keeper/carried.rs`: hashed, renamed into place, read-only; not signed) and starts the keeper from the copy, which runs the host from it; a copy that fails falls back to the keeper beside the window | nothing long-lived may run from the AppImage's mount, which goes when its window quits (runtime-lessons FI4); no shell off macOS |
| Windows, release or debug | `CC_USE_KEEPER` is ignored | `Direct` | the bundled host (release) or the source host (debug), no console window (§1) | the keeper is built on unix sockets, descriptor passing and `flock` |
| Windows release, `centralu serve` installed in the data folder (`<data>/remote/bin/centralu.cmd` or `<data>/bin/centralu.cmd`), and its `serve --connection` lists `window` in `takes` and names this window's protocol (`serve_window::choose`; otherwise the row above) | none | `Direct` (`Host::Serve`) | that launcher as `centralu serve --window`: it starts the folder's serve host in this sign-in when none runs (the sign-in task, as `--detach` does), prints that host's port and token as the ready line, and ends when the window closes its stdin, leaving the host running. A host in a network logon is used as it is, and the sign-in task moves it into this sign-in once idle. A `serve --window` that ends before its ready line hands every later attempt in the window's life to the bundled host (`ServeFallback`); if a host holds the folder all the same, the folder's lock refuses that start with the message naming who holds it | one host per data folder: a linked hub's serve holds this folder, or will, and the window's own host was refused by the lock ("Could not start the agent host", #1223). The window and the hub's link are two clients of one host |

Not decided by the window, each in its own place:

| What | Where it is decided |
|---|---|
| What the shell does once opened: install or keep, pinned or not, verify, copy, and the reasons it refuses | `shell::prepare`, `shell::install::plan`, `shell::start::start` in the window; the shell crate ([plans/thin-shell.md](plans/thin-shell.md) §10.1, §10.2) |
| A keeper started directly handing itself over (§4.4): to the `centralu-keeper` the window names (since #444). An executable of any other name (a window from before #440 names its own) is refused and the keeper stays on its build (#461) | `server::switch`, `server::upgrade`, `handoff::give` |
| A keeper from verified content handing itself over: verifies and copies the new content, then hands over to `<data>/content/<new>/centralu-keeper` | `server::content_route` (§4.4) |
| `centralu serve` on a remote: the npm launcher runs the bundled host on the system Node; no window, no keeper. On Windows a window in the same data folder attaches to it (`serve --window`, §4.0) | `packaging/npm/centralu/bin/serve.mjs` and the `serve-*.mjs` modules beside it, one concern each (§4.7) |
| `pnpm dev` and e2e: `pnpm host` runs the source host; no window, no keeper | `CONTRIBUTING.md` |

### 4.1 Who holds the host: the keeper (#280, option C step 1)

In the packaged app the host's parent is the keeper (`centralu-keeper`, an executable of its own next to the
window's, #440; [architecture.md](architecture.md) §4.1), not the app. The keeper launches the host with
`--port 0 --watch-parent --db <data>/store.db` and `CC_DATA_DIR=<data>`, keeps its stdin pipe, and restarts
it by the rules the app used before: five consecutive failures, a 30 s stable-uptime reset, and an
immediate stop on a lock conflict or a store only a newer build can read (`host_proc/` in the
`apps/desktop/src-tauri/keeper` crate, shared by the keeper and the app's direct path: the logic every OS shares in
`mod.rs`, the process mechanism that differs by OS in the keeper crate's OS layer `src/os/`, the keeper's handover of a host in `handover.rs`, finding Node in `node.rs`). If the keeper dies, the host sees EOF on that pipe and shuts down.

**Who starts the keeper.** The window, when no keeper answers on `<data>/keeper.sock`. A macOS release first
asks the shell ([plans/thin-shell.md](plans/thin-shell.md) §6, §10.2; `src/shell/` in the window): it installs or
upgrades `<data>/shell/Centralu.app` from the shell it carries, opens it through LaunchServices
(`/usr/bin/open -n -g -a <shell> --args --content <bundle>/Contents/Resources/content --data-dir <data>
--bundle-path <bundle> --nonce <n>`), and waits up to 45 s for `<data>/shell-status.json` with that nonce. The
shell verifies the signed content, copies it to `<data>/content/<version>/` and starts `centralu-keeper` from
there with the same command line the window would use (`keeper::exe::Start`), so the keeper and everything under
it are judged by macOS as the shell. If the shell refuses or does not report, the window starts the keeper itself
from its own bundle, as every other build does, for the rest of its life, and keeps the reason for `host_build`
(`shell`): a release shows it in the build bar, a build whose shell is unpinned (a local `pnpm app`, a
rehearsal) only writes it to `keeper.log` as a `[window]` line, and never installs or opens that shell.
Debug builds, `CC_KEEPER_HOST_SOURCE`, Linux and Windows start the keeper (or the host) directly, as before (§4.0).

**Per-build copies.** Before each launch the keeper copies the bundle's `resources/host` folder to
`<data>/hosts/<key>/` (temporary folder, then rename) and runs `main.mjs` from there. The key is the commit
stamped into `bundle-info.json`; a `-dirty` or `unknown` build gets its build time appended, so two different
dirty builds never share a copy. Once a host is ready, the copies it does not run from are removed, except those a
launch or a swap holds (`source::Copies`): a launch holds its copy until the keeper records it as the running host's,
a swap until its new host is adopted or it gives up. Copying and cleaning take one lock, the cleanup reads which copy
the host runs from when it runs, and a keeper handing itself over stops both at the freeze. Without the hold, the
cleanup a keeper's newly adopted host set off deleted the copy a swap had just made ("Cannot find module
.../hosts/<key>/main.mjs", #368). A complete copy is used even when the folder it came from is gone: on Linux that
folder is inside an AppImage, mounted only while something holds it open, and a keeper that took over from a newer
AppImage's window outlives that window's mount ([spikes/2026-10-linux-keeper.md](spikes/2026-10-linux-keeper.md) §6).

A keeper the shell started (its own executable in `<data>/content/<version>/`) makes no copies: its hosts run from
the verified copy's `host/` folder, which is read-only and was checked against the signed manifest
([plans/thin-shell.md](plans/thin-shell.md) §5, §10.3). The same lock holds those `content/<version>` folders, and
the cleanup removes every version no claim holds, that is not the keeper's own and that no host runs from or will run
from next, plus `.partial-*` folders a copy that died left behind.

**Where it came from.** The keeper keeps, for the running host, `{ commit, builtAt, version,
protocolVersion, bundlePath, hostDir, copyDir }`, returns it on the control socket, writes it to
`<data>/keeper.json` (no token), and passes it to the host as `CC_HOST_SOURCE`. The host adds it to every
`hello_ok` as `build` ([protocol.md](protocol.md) §1), with the commit always its own compiled-in one.

**Control socket.** `<data>/keeper.sock`, created `0600` under `umask 077`; every connection's peer uid must
be the keeper's own. Newline-delimited JSON, one request per connection except `attach`:

| request | answer |
|---|---|
| `{"op":"status"}` | `{"ok":true,"view":…}` — host state, the front door's port and a credential (§4.2: the token for a Centralu window, the limited credential for any other process, and `view.rights` says which, #1405), build source, background mode, attached windows, activity, the current or last swap (`swap`), whether the host keeps agents across one (`keepsAgents`), and the keeper's own build (`keeper.build`, since step 4; a window counts a keeper without one as another build, which only "Restart completely" moves, #461) |
| `{"op":"attach","protocol":1,"build":…}` | `{"ok":true,"view":…,"sameBuild":bool,"keeperSameBuild":bool,"relaunched":bool}`, then `{"event":"status","view":…}` on every change for as long as the connection is open. An open attach connection is what "a window is attached" means; its closing is the detach. `relaunched`: this window is the one an announced relaunch started (§4.5) |
| `{"op":"relaunching","graceSecs":n?}` | `{"ok":true,"graceSecs":n}` — the app is about to relaunch itself to apply an update (#352): for `n` s (60 by default, at most 300) no window attached does not stop the keeper, whatever background mode says. The next attach spends it |
| `{"op":"stop"}` | stops the host and the keeper ("Quit completely", and "Restart completely", after which the window starts a keeper of its own build) |
| `{"op":"switch","source":…,"keeper":{"exe":…}?}` | a window's only (#1405; anything else gets `window_only`): a blue-green swap to that build (§4.2; the build stamp is re-read from its folder). With no host up, the next start simply runs that build. With `keeper` (the app sends its build's `centralu-keeper`; an app from before #440 sent its own executable, which is refused since #461, the keeper staying on its build) and a keeper of another build, the keeper first hands itself over to that build's keeper ([architecture.md](architecture.md) §4.4), which then runs the swap. A keeper from verified content starts nothing from the bundle: it verifies and copies the bundle's signed content and hands over to the keeper in that copy (§4.4); a refusal ends the swap as `failed` with `refused` set. A second `switch` during a swap is refused |
| `{"op":"upgrade","exe":…,"source":…}` | a window's only (#1405): hands the keeper over to the keeper at `exe`, of build `source`, leaving the host alone (§4.4); from verified content, to the keeper in the verified copy of `exe`'s bundle content |
| `{"op":"restart"}` | Retry after the host gave up (refused during a swap) |
| `{"op":"settings"}` / `{"op":"set_background","on":bool}` | background mode, kept in `<data>/keeper-settings.json` |

A window that does not take a status push within 5 s (it stopped reading) is closed by the keeper, which is its
detach; the window then attaches again. Before #840 item 5 it was only taken off the push list, kept counting as
attached, and got no status again. A window the keeper closed itself may only be stalled (suspended, in a debugger,
its reader blocked), so its detach does not stop the keeper even when it was the last one and background mode is
off: for 5 minutes (`REATTACH_GRACE`) the keeper waits for a window as it does for an announced relaunch, the next
attach spends that, and if none comes the idle rule applies as usual. Each window has a writer thread of its own
(`server/push.rs`): a change only queues the new view, a view still waiting is replaced by a newer one of the same
swap phase, and the attach answer is queued first and never replaced. A view of another swap phase is kept: a
swap's phases follow each other at once (standby, then draining), and a window that had only read the later one
was never told of the earlier (#368). Before, pushes were blocking writes under the keeper's state lock,
so a window that stopped reading held every push, request and host status for up to 5 s at each change. A keeper
handoff lets every writer send what it queued, then stops them before the windows' sockets change hands.

**The legacy folder.** Before anything creates the default data folder, the app and the keeper move the
pre-rename folder to the new name by the same rule as `data-dir.ts`: the host leaves a legacy folder alone once
the new one exists, so creating `~/.centralu` first (for `keeper.log` or the socket) would strand the data.

**One keeper per data folder.** `flock` on `<data>/keeper.lock`, released by the OS however the keeper ends.
A second keeper whose predecessor answers on the socket exits with code 3 and starts no host; one whose
predecessor holds the lock but does not answer (on its way out) waits up to 15 s for it.

**Descriptors.** A keeper started from Finder or launchd gets a soft descriptor limit of 256, which a few dozen
relays and attached streams used up. It raises its soft limit to 10,240 (or the hard limit) as it starts; what it
starts (hosts, agents, terminals, commands) gets the limit from before back, so a `select`-based program is never
handed a descriptor past 1,024. When an `accept` still fails for want of one, each of its three listeners (`keeper.sock`,
`children.sock`, the front door) is left alone for 100 ms and the failure is logged once every 10 s with a count,
instead of the loop coming straight back to the waiting connection (one core and thousands of log lines a second on
Linux; macOS drops the connection instead), and a thread the OS refuses for a connection closes that connection
rather than aborting the keeper (`keeper/accept.rs`, #840 item 3). A front-door relay holds one descriptor per
socket (its table shares the relay's sockets instead of duplicating them, which made four per relay), and the door
relays at most 1,024 connections at once: one past that is closed as it is accepted, logged once per run, so a
client connecting in a loop cannot run the keeper out of descriptors (`front_door.rs`, `MAX_RELAYS`).

**When it ends.** `idle_decision` in `keeper/mod.rs`: with a window attached, never. During an announced
relaunch's grace (§4.5), not yet, in either mode. With background mode off, when the last window detaches. With it on, after 30 minutes with no window and no activity reported by the
host (a working or waiting session, a terminal, a command run). A keeper no window attached to within 60 s of
starting ends too: the app that launched it died first.

`scripts/keeper-integration.mjs` drives all of this, the announced relaunch included, with the real binary (`cargo build` into `/tmp`) and the
real bundled host against a temporary `CC_DATA_DIR`.

**In CI.** The `keeper e2e` job in `.github/workflows/build.yml` (macOS) builds the binary and the host once and runs
the parts of the three keeper scripts that need no model and no network: all of `keeper-integration.mjs`, and
`keeper-children-integration.mjs` and `keeper-handoff-integration.mjs` with `--no-claude --no-codex`, then the
shell's (`shell-integration.mts`) and the handoff from verified content (`keeper-content-integration.mts`, §4.4). It exists
because none of this shows in unit tests or e2e: #329's `await` before the server existed crashed every host
restart that held a terminal (#348), and only a hand run of the children script noticed. The claude and codex
turns stay manual. Each script ends every process it started and everything those started, pass or fail, found
from one process table rather than by name (`scripts/keeper-test-processes.mjs`), and prints the end of
`keeper.log` and `host.log` when a check fails. The `keeper e2e (linux)` job runs the same scripts and the keeper
crate's unit tests on ubuntu-24.04. A first trial there (2026-10-05) ended when SIGTERM reached the script itself: the
stop path ran `/bin/kill -TERM -<pid>`, which procps-ng 4.0.4 sends to the group named by the pid's first digit, so a
host pid starting with 1 signalled every process of the user (#350). Both stop functions call `kill(2)` now
([spikes/2026-10-linux-keeper.md](spikes/2026-10-linux-keeper.md)).

### 4.2 The front door and the swap, seen from the host (#280, option C step 3)

The design is in [architecture.md](architecture.md) §4.2. What the host does:

**Token and address from the keeper.** Under the keeper the host gets the front door's token (the same for every
host the keeper runs) as the first line on its stdin, `{"token":…}`, told by `CC_HOST_TOKEN_ON_STDIN=1` (#538,
`lifecycle/handed-token.ts`), and `CC_FRONT_DOOR` (`ws://127.0.0.1:<door>`) in its environment, which it deletes
once read, so terminals, agents and commands do not inherit it. The token is read before the control channel takes
stdin; a host told to expect it that gets no such line within 10 s ends its start with a line saying why.

**Mixed versions during an update** (#538). Which side reads what:

| Keeper | Host | The token |
|---|---|---|
| this build or later | this build or later (its `bundle-info.json` says `tokenOnStdin`, or it runs from source) | on stdin only |
| this build or later | older (a rollback, a switch to an older window's build) | in `CC_HOST_TOKEN`, as before; `keeper.log` says so |
| older (one that could not hand itself over) | this build or later | in `CC_HOST_TOKEN`, as before; the host still reads it |
| older | older | as before |

The child socket checks its peer by pid whatever the host's build, so an older host under this keeper is let in
as any host is, and this host under an older keeper meets the old same-user rule. A keeper handoff passes the token
on its own channel and the host's stdin unchanged, so nothing is read again. The Codex bridge is started with the
front door's address (`swap-control.ts`, `bridgeAddress`): a running codex keeps its bridge, and only an address
that outlives this host survives a swap. Without a keeper the bridge gets the host's own port, as before.

**The bridge's credential** (#382). The bridge is not given the token. It gets `CC_BRIDGE_TOKEN`, an HMAC of its
session id keyed by the host's token (`transport/bridge-token.ts`), because any process of the same user can read
the environment the bridge started with ([security-boundaries.md](security-boundaries.md), "The front door"). A
connection that says hello with one is not a client: it gets `hello_ok` and nothing else (no replay, no broadcast,
no terminal output), and it may call only `orchestrator.tools`, `orchestrator.tool`, `apps.sessionTools` and
`apps.sessionCall`, each naming the session the credential was made for. Under a keeper the key is the front door's
token, so the next host accepts a running bridge's credential without anything being handed over. A host from before
this change refuses it: after switching back to such a build, a Codex session started by a newer one loses its
Centralu tools until it is restarted, and the bridge says so.

**Control lines on stdin** (`swap-control.ts`). The keeper's pipe also carries one JSON object per line; the host
answers on stdout next to its ready line. Neither side parses anything else the other says.

| keeper → host | host → keeper |
|---|---|
| (started with `--standby`) | `{"standby":{pid,schema}}` once its own checks pass |
| `{"op":"activate"}` | the ordinary ready line once it serves |
| `{"op":"drain","timeoutMs":N}` | `{"drained":{waitedFor,cut,ms,keptAgents}}`, then it exits |
| — | `{"swap":{"keepsAgents":bool}}` once per start |

**Standby.** Before the ownership lock: the host has loaded its bundle and found its tools; it reads the store
read-only (`Store.inspect`) and, if `min_reader_version` is past it, says the "written by a newer Centralu" sentence
and exits 1, so the swap fails while the running host is untouched. Otherwise it reports and waits for `activate`;
the pipe closing (the keeper gave up) ends it without having touched anything. It does not listen in standby: the
front door hides the port, and the server needs the session manager, which needs the store open for writing.

**Drain** (`drain.ts`). Every WebSocket RPC and every in-process MCP tool call (the orchestrator tools, the
app-tool proxy) runs through one tracker. On `drain`, new calls are refused and running ones get the bound; past
it each is answered with an error saying the host switched builds and stopped waiting, that the call may or may
not have finished, and to check and call again. RPC errors from a refusal or a cut carry `retryable: true`. Then,
in order: a moment for a cut call's error to reach its agent, the **detach hook** `stopServices('detach')`, the
lock released, `drained` written, exit. The detach hook releases the keeper-held agents, terminals and commands
(§4.3) and stops only what lives in the host (app processes, in-process servers); `drained.keptAgents` and the
start-up `keepsAgents` report are true only when the host has the keeper's child service. A host without one
stops its children here, as a stop does.

**Taking over.** After `activate` the host takes the lock and opens the store with `swap: true`: expand steps run
now, heavy and breaking steps run after its ready line (§5.1).

**Open app views** (#280 step 4). A view's frame address names the front door's port (`swap-control.ts`, `viewPort`)
and a secret derived from the keeper's token (`transport/http.ts`, `deriveHttpSecret`), so every host the keeper
runs gives out the same address for the same instance; without a keeper both stay as before (the host's port, a
random secret). The instances themselves live in memory, so a planned ending — the drain above, or a signal while
the host has the keeper's child service — writes each open one's id, app and `ui://` address to `app_settings`
(`views.handover`, `view-handover.ts`), first thing in `stopServices`. The next host started under the keeper reads
the record before it listens, deletes it, and if it is at most ten minutes old reopens them under the same ids:
each holds its app again as `open()` does, an app that no longer exists is skipped, and a view in a conversation
is re-bound to its card (`InlineViews.adopt`) so its messages still go only there. What a conversation's view does
not keep is its call's input and result (never written down), so once closed it offers "open app", as after any
restart. A crash writes nothing and its views are lost, as before. Per-app origin ports are bound lazily by the new
host the first time `apps.viewFrame` or the proxy page needs them. On the UI side, every open `AppFrame` asks for
its address again after a resync (`hostResyncs` in the store): the same address leaves the view and its state
alone, another one is loaded, a failure takes the first load's failure path.

### 4.3 The children the keeper holds, seen from the host (#280, option C step 2)

The design is in [architecture.md](architecture.md) §4.3. Under the keeper (`CC_KEEPER=1`) the host connects to
`<data>/children.sock` at startup (`keeper/held-children.ts`). If nothing answers there (an older keeper, a socket
that would not bind), the host spawns its own children and every ending stops them, exactly as without a keeper.
`pnpm dev`, e2e, a debug app and Windows never take this path.

**The child socket** (`keeper/children/` in the desktop keeper crate, `keeper/children-client.ts` here). The first line
of a connection says what it is. A *control* connection (`{"op":"hello","protocol":1}`), one per host, carries
requests `{"rid":n,"op":…}` answered `{"rid":n,"ok":…}` and two pushed events: `{"event":"exit","id","code","signal"}`
and `{"event":"stop"}` (the keeper is stopping for good; stop your children). An *attach* connection
(`{"op":"attach","protocol":1,"id","stream":"out"|"err"}`) answers one line and then carries raw bytes: the
child's output to the host, the host's bytes to the child's stdin or pty.

| request | does |
|---|---|
| `spawn` `{kind:"pipes"\|"pty", cmd, args, cwd, env, cols?, rows?, tag}` | starts the child in its own session; `cmd` is looked up on the `PATH` in `env` |
| `list` | every child: id, kind, pid, cmd, cwd, start, alive, exit status, tag, size, bytes not yet sent |
| `signal` `{id, signal, group?}` | a signal to the child, or its whole group; refused for a name outside TERM/KILL/INT/HUP/QUIT/USR1/USR2/WINCH, and a no-op once it has exited (its pid may belong to someone else) |
| `close_stdin` `{id}` | EOF after what was written (codex removes its thread lock on EOF, #57) |
| `resize` `{id, cols, rows}` | `TIOCSWINSZ` on a pty |
| `set_tag` `{id, tag}` / `release` `{id}` | replace the tag; forget an exited child (a running one is refused) |

A new attach replaces the previous reader of that stream. A host that half-closes its attach connection is
detaching: it is sent the rest of the line it is in, then the stream ends and the keeper buffers for the next one.

**Buffers** (`keeper/children/buffer.rs`). An agent's stdout: lossless up to 64 MiB, then the keeper stops reading
and the child blocks on its pipe; only whole lines go to a reader, and a line a lost reader got part of is sent
whole to the next. A pty: drained always, the last 256 KiB kept and replayed to each new reader. An agent's stderr:
a 256 KiB tail, never blocking. Bytes from a host go to an agent's stdin in whole lines only, so a host that dies
mid-write never leaves a torn request; up to 8 MiB are queued before the keeper stops reading the host. A control
connection whose host stops reading is dropped once 8 MiB of replies and exit events wait for it, with a line in the
keeper's log: that host then sees every child it holds exit with SIGHUP and cannot spawn until it restarts. Once a
burst has been sent, each of these buffers hands back the capacity it left behind, keeping 1 MiB.

**What the host spawns there.** Every child carries a tag only hosts read (`keeper/tags.ts`): `{kind:"agent",
tool, sessionId, version?}` (the CLI version it was started from, #297, §4.6), `{kind:"terminal", id, cwd}`, `{kind:"command", cwd, command, runId, startedAt}`. A newer host
must keep reading an older host's tags: the children outlive the build that spawned them.

- **Agents.** The manager passes the adapter a `ProcessSource` (`adapters/contract/process.ts`): `spawn` in the keeper,
  or `adopt` a kept process. Claude gets it as `spawnClaudeCodeProcess`; `CodexClient` takes the process instead
  of spawning. `KeeperAgentProcess` has the `ChildProcess` surface both use, but `kill()` is a keeper request for
  the CLI's whole process group (below) that is never sent once the process is detached or the host is exiting
  (the SDK kills its processes on owner exit), and `stdin.end()` is `close_stdin`. Codex request ids carry a per-client prefix, so an answer to the previous
  host's request cannot resolve one of ours.
- **Terminals and commands.** `TerminalService` and `CommandRunner` take the keeper's pty module (`KeeperPty`,
  node-pty's surface) instead of node-pty; stopping or closing them walks the process tree (`kill-tree.ts`), which
  works from anywhere. Closing a terminal takes the tree before the shell gets its hang-up: a dev server started
  from it is in a group of its own (job control), and one that ignored the hang-up used to be left running.
  Both hold each pty in a `PtySlot` (`dev-services/pty-slot.ts`, #428): its output (256 KiB), its exit, its tree
  stopped, and a failed start, node-pty not loading included, said on screen and followed by an exit.
- **Both** stand on `keeper/held-child.ts` (#428): the spawn's answer, the attach of their streams, the exit reported
  once the output has ended (at most 1 s after it, `exit-after-drain.ts`), the release of the keeper's record, and a
  detach that waits at most 2 s each for the attach and for the keeper to end the stream. A child whose streams cannot
  be attached is ended (KILL to its group) and released once it has exited: the keeper refuses to release a running
  child, so releasing it at once left it running with nobody to read or stop it. A child adopted from a previous host
  gets one more attach first, with a 15 s bound (a loaded machine or a keeper handoff can hold the first one past its
  5 s). If that fails too, an agent is ended, since its session starts a new CLI on the same conversation and two
  CLIs on one thread conflict; a terminal or a command run is left running in the keeper for the next host.

**What stopping an agent ends.** An agent CLI starts helpers of its own: Claude Code's LSP tool runs
`typescript-language-server`, which runs `tsserver` (one reached 3.4 GB); MCP servers from the user's config; shells.
They share the CLI's process group, which `setsid` made the CLI's own, so the group is the CLI, what it started, and
nothing else. A stop signals that group: the host's TERM, and the KILL that follows when the CLI is still there after
its grace (the SDK's 5 s; codex's 2 s after EOF), reach the helpers too. And whenever an agent exits, however it ended
(a stop, a crash, a CLI that does not clean up), the keeper sweeps its group: TERM at once, KILL 2 s later to whatever
is still in it (`Sweep`, `keeper/children/stop.rs`). Before, only the CLI's pid was signalled, and what it left was
reparented to launchd/init and kept running with its memory. A group number is not reused while anyone is in it, and
no sweep is sent while any process holds the CLI's pid (its zombie not yet reaped, or the number given to someone
else), so a sweep never reaches another group; the keeper's own group is never a target (#350). A sweep still
waiting is handed to the next keeper with the table (§4.4), and a keeper stopping for good waits for its sweeps and
KILLs what is left at the end. Ptys are not swept: the kernel hangs up a terminal's foreground group as its shell
exits, and the host ends a terminal's or a command's tree when it stops one. A detach (a restart, a swap) sends
nothing, so agents and their helpers survive it.

Without a keeper (Windows, `pnpm dev`, e2e, a debug app, a keeper whose child service did not answer) the host
spawns the CLI itself, Claude's through `spawnClaudeCodeProcess` too (`adapters/local-process.ts`). On macOS and
Linux it gets a process group of its own; a stop is `kill-tree.ts`'s TERM to every group in its tree and KILL to
the survivors after 3 s, and once it has exited its group is swept the same way (`stopGroup`). On Windows a stop is
`taskkill /T /F` on its tree, and once it has exited what it left running is found by parent links and creation
times and ended (`collectOrphansWindows`), against a start time taken before the spawn. The start and the sweep are
the ones app processes use (`dev-services/grouped-child.ts`: `spawnGrouped`, `sweepExited`). Being in a group of its own, the CLI is no longer in the host's: a host
that is SIGKILLed takes it along only through stdin EOF, on which codex exits at once and claude after the turn it
is in. The SDK adds the end of the CLI's stderr to a failure only for a process it spawned itself, so both
adapters add it the same way (`withStderrTail`, `stream-text.ts`): the host's own child and the keeper's each keep the
last 8 KiB of stderr (`AgentProcess.stderrTail`), decoded as one stream so a character split between two chunks stays
whole, and Claude's `adapter_crashed` and Codex's "codex app-server exited" carry it, under the keeper too.
A Codex app-server that exits **while its session has no turn in flight** (nothing running, no message whose `turn/start` is still unanswered, none queued, no input waiting for its turn, no blocking command, and the process had finished starting: a message sent just before the exit is lost with the process, so it is a crash with the stderr tail, not sleep) is not a crash (#1397): a Codex session keeps its app-server while idle (#568), so a system shutdown, a logout or a kill lands on such sessions. The adapter says `session_live` (`live: false`, `reason: 'asleep'`) instead of an `adapter_crashed` error, whatever the exit code; the manager retires the handle (as for a crash, only from the handle registered now) and the next message resumes the thread. No error, no mark. An exit during a turn is still `adapter_crashed`. Not done: telling a shutdown from a crash during a turn (a `shutdown` interruption with Continue) needs the keeper or host to record the system's shutdown signal first.

**Leaving** (`lifecycle/shutdown.ts`, `stopPlan(mode)`). *Detach* — SIGTERM, SIGINT, SIGHUP, the keeper's pipe closing, an
uncaught exception, a swap's drain — calls `detach()` on every session handle, terminal and command run: nothing
is sent to the tool, a waiting approval stays waiting, and output still in flight is recorded before the store
closes. App processes and the in-process tool servers stop, as they live in the host. *Stop* — the keeper's `stop`
event, or any ending without the child service — is the old path: sessions disposed, terminals and runs killed.
After a stop the keeper ends whatever is left (stdin EOF and SIGHUP, 2 s, TERM to each group, 1 s, KILL), and
what exited agents left in their groups. For a terminal each step reaches every process group in its session, so a
job its shell put in a group of its own (a dev server sent to the background, one that ignores the hang-up) ends
too (#840 item 2); before, only the shell's own group was signalled and such a job kept its port.

**Re-attach.** At startup the host lists the keeper's children. Live agents re-attach after `listen`, through
`resumeSession`, so a screen waking the same session joins the re-attach instead of starting a second process.
Their sessions keep `working` / `waiting_approval` through the startup reset (`keptSessions`); the state is then
corrected by what the tool says. The transcript catch-up is skipped (the keeper's buffer delivers what was said
meanwhile). A kept agent whose session is gone is stopped. Terminals and command runs come back under their ids
with the replayed output as scrollback; a run that ended while no host was attached keeps its exit code. An exited
agent or terminal is released. Measured before relying on it (2026-10-04, CLI 2.1.282 + SDK 0.3.263 with haiku;
codex-cli 0.160.0 with `gpt-5.6-luna`, low effort):

| tool | measured |
|---|---|
| claude | A new `query()` over the kept process: its `initialize` re-delivered the pending approval to the new `canUseTool` at once; answering it ran the command and finished the turn. Mid-turn, the remaining three Bash calls and the result arrived through the new host. |
| codex | `initialize` again: `-32600 "Already initialized"`, nothing else changes. `thread/resume`: `thread.status` `active`/`waitingOnApproval`, the running turn in `thread.turns` (the id Stop needs), and the approval re-sent with the same request id (`0`); accepting it finished the turn. Since #342 the resume asks for no turns (`excludeTurns: true`), and the running turn comes from `thread/turns/list` (`limit: 1`, newest first, `itemsView: 'notLoaded'`), asked only when the thread is `active`; measured again on 0.160.0 (2026-10-05): the turn came back `inProgress`, and a pending approval was still re-sent under its id. A Codex that predates the flag answers with the turns, and those are read as before. It does not restart the thread's MCP servers (a probe server configured on resume never started), which is why the bridge has the front door's address and a credential every host the keeper runs accepts (§4.2). |

**A lost in-process call.** A call to the host's own in-process tools (orchestrator `mcp__centralu__*`, app
proxies `mcp__app-*`) in flight when the host died is never answered: measured, the adopted claude waited silently
until the new owner called `interrupt()`, which ended the turn (`error_during_execution`); the next turn, including
a call to the same tool now served by the new host, ran normally. So the manager hands the adapter the tool calls
the store holds without a result, and Claude, finding one of its in-process tools among them, reports an error
naming it and interrupts the turn. A planned swap drains such calls first (§4.2); this is for a crash. Codex needs
nothing: its bridge fails a call whose socket closed.

**Strays.** `strays.ts` rule 3 counts the keeper's live children and their descendants as ours. After a keeper
handover (§4.4) their parent is init, and the parent chain alone would offer them as leftovers. Stopping the ones a
person chose (`stopStrays`) is the two shots every stop uses: SIGTERM to those still leftovers, then, after 3 s,
SIGKILL to those that still are and still run the same command, measured again each time (#428). When the keeper
cannot answer which children it holds, nothing is stopped: after a keeper handoff its agents are init's children, and
without its list they would read as leftovers. Both walk the table with `dev-services/proc-table.ts`,
as `kill-tree.ts` does.

**Activity.** Kept terminals, runs and live sessions are the host's own entries again once taken over, so the
activity report counts them as before. While no host is up the keeper counts nothing; its idle limit is 30
minutes and a crashed host is back in seconds.

`scripts/keeper-children-integration.mjs` drives this with the real binary, host, claude (haiku) and codex
(`gpt-5.6-luna`): a claude turn across a SIGKILLed host, a terminal and a dev server across the same crash (resized
afterwards), a codex turn across a swap, and stop ending every child. CI runs it with `--no-claude --no-codex` (§4.1).

### 4.4 The keeper's handoff, seen from the host (#280, option C step 4)

The design is in [architecture.md](architecture.md) §4.4. The host does nothing for it and notices nothing: its
stdin and stdout are the same pipes, its control and attach connections on `children.sock` are the same sockets, its
token and the front door's address do not change, and its parent becomes init when the old keeper exits. What it
writes on stdout during the freeze (an activity report, say) waits in the pipe and is read by the new keeper; what the
old keeper had already read from it but not acted on is handed over with the rest. Its own control lines on stdin,
used by a swap, keep working from the new keeper, which can drain it as the start of a switch. Its children are as
they were: the outgoing keeper parks the child table between two passes and the new one carries on from the same
buffers, so a turn in progress loses and repeats nothing.

`scripts/keeper-handoff-integration.mjs` drives this with real binaries of three builds, the real host, claude (haiku)
and codex (`gpt-5.6-luna`): a handoff with a turn of each in a tool call, a terminal and a dev server counting; a
handoff killed before its commit; a switch that moves the keeper and then swaps the host; and an app view and the
window's connection across all of it. CI runs it with `--no-claude --no-codex` (§4.1).

**From verified content** ([plans/thin-shell.md](plans/thin-shell.md) §10.3). A keeper the shell started runs from
`<data>/content/<version>/` and must only ever start signed code, so its handoff takes the window's keeper
executable only as a pointer to that bundle's `Contents/Resources/content`. It verifies that content with the shell's
rules and keys (signature, platform, a keeper and a host listed, not below `<data>/content/highest-started`), copies
it into `<data>/content/<new version>/` (or reuses a copy that verifies in place), and hands over to the keeper in
that copy with `--host-source` naming the copy's `host/`; the host it then swaps to, on a `switch`, is that same
folder. The incoming keeper raises the floor once it serves. A refusal (`content`, `downgrade`, `copy`, `in-use`,
`no-content`) moves nothing: the keeper and the host serve on, and the window sees a failed swap with the reason in
`refused` and the words in `message`. Rollbacks go through the shell only. The host notices none of this: what it
runs from is a folder like any other copy. A keeper started directly (debug builds, the window's fallback) hands over
to the executable it is given, as above, and so does a keeper from the unsigned copy a Linux window makes (no `.sig`
in its folder, and an OS whose release signs no content, `start_plan::Os::signs_content`): the next Linux window
copies its own build into `content/<new>/` first and names the keeper there. A keeper from any content folder, signed
or not, closes the descriptors it inherited (all but a handoff's channel) and drops the AppImage's variables before
anything else (`keeper/appimage.rs`), so no AppImage stays mounted for its life (runtime-lessons FI4, FI5). `scripts/keeper-content-integration.mts` drives it with a test
shell and a test keeper that trust a throwaway key, the real host and a counting terminal: a tampered and an older
content refused with everything serving, a handoff into `content/0.2.1/` with the same host, terminal and front
door, the host's switch to the new copy, and the old version's folder removed once nothing runs from it.

### 4.5 Applying an update, seen from the host (#352)

The design is in [architecture.md](architecture.md) §4.5. The host's part is the install and one rule.

**Checking (#635).** Startup and the six-hour background interval remain unchanged. Opening Settings → Updates
forces a check only with automatic checking on; with it off, use Check now. Focus/visibility restoration also
checks only with automatic checking on, when the last successful check is more than an hour old; attempts are
throttled for an hour, including failures and paired focus/visibility events. Checks leave an active install or pending apply alone. A failed install
keeps its phase and error throughout later checks, until the next install attempt. Successful ordinary checks
follow npm exactly, including a lower `latest` after a dist-tag rollback, and recompute whether it is newer.

**The install** (`updates.ts`). Before installing, `updates.apply` refreshes the registry with the forced eight-second
deadline unless a successful check is less than one minute old, avoiding a second request when a check starts
auto-apply. With nothing newer known (automatic checks off, or a stored "up to date" hours old) it refreshes first
rather than refusing, reporting `checking` while it looks; nothing newer is then a result (`idle`, no error), never
`failed` (#645). The call answers once the target is settled — after the lookup, as `npm i -g` is about to start, or
with that result — not when the install is done. Only during installation, a stored version seen less than one hour ago may win over a lower fresh
answer to tolerate a stale npm edge. Retaining it preserves its original check time; an older stored version yields
to the fresh tag so a release rollback takes effect. A target at or below the running version installs nothing.
If the refresh fails, it installs the stored version and keeps a fallback notice during and after installation.
Lookup, npm retries and bundle replacement are one busy operation; concurrent checks/clicks cannot replace its target or start a second install. It runs `npm i -g --prefer-online centralu@<v>` and, when the installed app exists,
`centralu install`, then reports `restart_required`; it never restarts anything. npm is the source of truth for
releases, so the copy is replaced whatever released version it holds, a higher one too: a release pulled from
`latest` must not survive in /Applications to be offered by "Apply now". The one copy left alone is a maintainer's
local build (`<base>.local.N`, `pnpm local-update`, #610/#613) newer than the target, waiting for "Apply now";
putting the release it was cut from over it would undo it (`keepsInstalledCopy`, mirrored in the launcher's
`semver.mjs`). A version that cannot be read or is not well-formed SemVer in that shape is replaced, so a corrupt
plist or version file cannot block updates. The version is read the same way as the launcher reads it
(`readInstalledCopyVersion`: `plutil -extract CFBundleShortVersionString raw` on the bundle's `Info.plist`, XML or
binary, on macOS; the launcher's `centralu-version.txt` on Windows; nothing on Linux). When a local build is kept,
the package is still updated, `restart_required` carries a notice naming it, and the window's own bundle check offers
to apply it. `centralu install` applies the same rule by itself and takes `--force` to replace such a copy on
purpose (#645). With `autoApply` on ("Apply updates
automatically when idle", `updates.setAutoApply`, saved as `updates.autoApply` in the store's app settings, off by
default) a check that finds a newer version starts the same install by itself, and turning the setting on with a newer
version already known starts it at once. Not over an install under way or one already finished: a check after it leaves
`restart_required` alone, so it installs once. A failed install stays visible until another install attempt;
a background or requested check does not erase its error. With `autoApply` on, the host tries again by itself on a
backoff — 10 minutes, then 1 hour, then every 6 hours — from a timer kept in memory (#645): a check that lands
before the delay starts nothing, one after it retries too, and a release other than the one that failed is tried at
once. The error stays on the line until the next attempt starts; success, turning the setting off and shutdown end
the retries. Without the setting a failure is left for the person, as before.

On host shutdown, pending lookups and npm waits cannot start another command or publish stale completion. A command
already launched is not undone. After reconnect or a host swap, the window re-reads status without replaying the
install, and ignores replies from the previous host lifetime.

Both commands run without a shell, through `tool-launch.ts` (`commandFor` in `updates.ts`): on Windows `npm` and
`centralu` are batch files, which `execFile` cannot start by name (ENOENT) or by path (EINVAL), so each is read for the
`.js` it starts and that runs under the host's Node. The installed app it refreshes is `installedCopyPath()`, the
launcher's `installedPaths()[0]` per platform (a test holds the two together). A failure says which half failed: npm's
own last line (not its pointer to the log), or, when npm worked and only the copy did not, the launcher's first line,
the copy's path and `centralu install` to finish by hand.

**A release arriving at npm.** The `latest` tag can reach this host before the package version has reached the npm
edge it installs from. On npm's narrow `ETARGET`/`notarget` response only, the host retries the exact install with
`--prefer-online` for up to ten minutes, reporting `waiting_for_npm` and “Waiting for npm to serve <version>” between
attempts. Other failures still fail at once; a bounded propagation wait must not hide a credential, disk or package
error.

**Agent updates (#581).** `update_centralu(action: "check" | "install")` reaches the same `UpdateService`
methods as the window. In the commands tier it is discovered and run through `centralu_commands`, `centralu_help`
and `centralu_run`; an ordinary session gets a minimal definition, deferred behind Claude's tool search
like `app_guide` because updates are rare (Codex is offered it without a deferral flag). Its first call raises a consent card:
allow once, or always for that session until the host restarts. It never calls `updates.setAutoApply`, so an agent
cannot change the person's automatic-apply preference with it. (The orchestrator's `set_preferences` can turn it on, behind a
card in every preset, §1.4.) An install starts the normal host install; the window still
performs its own safe relaunch/switch step.

**Applying for an agent (#665).** `update_centralu(action: "apply")` is the window's "Apply now" asked for by an agent.
Only a window can relaunch, so the host asks over the event stream (`update-apply.ts`, `UpdateApplyBroker`): an
`update_apply_request` that every window answers with the checks its button makes (`agentApplyVerdict`: a relaunch
port, an installed build newer than the window, and a bundle on disk whose own version, read by the shell from its
`Info.plist`, is newer than the window and the same as the installed one), through `updates.answerApply`. The
shell's `ready` alone says only "another build": an older app restored over the installed one is one too.
The first window that is ready gets a ticket. With none ready, the call ends with the windows' reasons ("nothing is
installed", "already runs it", a browser window that cannot relaunch) or, with no window open or none answering
within 5 s, says so. Then the caller's own preset decides, as for every Centralu boundary (#606): `auto` goes on and
is logged, `normal` raises a card (its "always" covers applying for that session only, apart from check and
install), `safe` and an agent an app started are refused before any window is
asked. `normal` raises no card while the person's Automatic updates are on and the host is idle apart from the caller's own
turn (#1509, owner 2026-10-24: the window's own auto-apply would relaunch at that moment; `updateAtRest` in main.ts,
`hostBusyBesides` in `idle.ts`). That is judged in the consent step, after a window said it is ready, and again after the second ask of the
windows, right before `update_apply_go`, which then carries `unasked` (additive): the window waits out someone typing
(`TYPING_QUIET_MS`) as its own automatic apply does, and reports that instead of relaunching. Nothing is remembered, except that a card-free relaunch that failed brings the card back for that installed version, for every session, so an agent cannot retry it in a loop with no one asked. The limited credential's `updates.apply` reads the same state (`RightsHost.updateAtRest`). After consent the windows are asked again, since a card can stand for minutes, and `update_apply_go` names the
first ready window's ticket. That window alone checks again, reports `started` through `updates.reportApply`, runs
`applyUpdateNow` (the keeper is told, then the shell relaunches) and reports the outcome. Only after `started` does its
connection ending count as the relaunch, since a relaunching window can close before its last report; ending before
it is given 5 s to come back and report, then answered as "whether it relaunched is not known". Reports are matched
by ticket, not by connection: only that window was given it, and a window that reconnected has a new connection.

The card rides on the `other` detail, `{ kind: 'other', raw: <question>, about: 'centralu_apply' }`, rather than a
new kind or a new `centralu_update` action: a released window parses events strictly and drops one whose detail it
cannot parse, while `other` with its text has been read by every build. The question says what the relaunch costs: the
agents keep running, and the new window switches the host at once, which stops a Centralu tool call still running
after 10 s in any session (an agent waiting on its children included). One window relaunches: one ticket goes per request, and the
keeper's relaunch is the single owner of the switch the new window makes. A replayed request or go starts nothing (the
host is no longer asking, or the window no longer holds the ticket), a linked machine's apply events never reach a
hub's windows (`links/qualifier.ts`), and a host swap in the middle ends that host's requests: the next host knows
none of them, and the agent's call is cut at the drain like any in-process tool call.

The automatic mode ("Automatic updates", on unless the person turned it off) still waits for the keeper to report nothing busy. The
relaunch itself loses nothing a keeper holds, but the relaunched window then switches the host by itself, and that
switch is what a busy host can lose: a Centralu tool call still running after the 10 s drain (a `start_agent` or
`agent_session` wait, an `ask_project`, an app tool) is cut and has to be tried again, and a host that cannot hand
agents over stops running turns. An orchestrator with working children is almost always inside such a wait, so
dropping the busy rule would cut those waits on every automatic apply. An agent's explicit apply makes that choice for
itself, as a person pressing the button does, and its own call is answered before the switch begins.

**On Windows**, measured on Windows 11 on 2026-10-08 with a temporary npm prefix and a stand-in holding the same
handles as the running app (an exe started from the folder, the host's `better-sqlite3` and `node-pty` modules mapped):

| Step | What happens |
|---|---|
| `npm i -g centralu@<v>` | Succeeds while the app runs, from the installed copy or from inside the npm package |
| `centralu install` | Renames `%LOCALAPPDATA%\Programs\Centralu` aside to `Centralu.old-<time>` and the assembled `Centralu.new` into its place. NTFS allows the rename with the exe and the native modules in use; it refuses only while some process's working directory is inside. The app moves its working directory out of its own folder at start (`leave_app_folder` in `src-tauri/src/lib.rs`), since File Explorer starts an exe in its folder and the host inherits it. The aside copy cannot be deleted while the old app runs; the next install sweeps every `Centralu.old-*` it can |
| The running app | Keeps the files it has open. Windows still reports the exe at its original path, so anything opened by path afterwards is the new copy's, a host restarted by the old window included (inferred from that path, not run) |
| "Apply now" | Not offered: there is no keeper, so a relaunch would stop every agent (`relaunch_info`). The line says "Restart Centralu to finish updating to <v>"; quitting and opening it again from the Start menu or `centralu` starts the new copy |

Builds up to 0.1.0-beta.12 cannot update themselves on Windows (their host ran `npm` by name: "Update failed", `spawn
npm ENOENT`), and the fix only runs once it is the installed build. Updating to it takes `centralu update` in a
terminal once; that goes through a shell and works while the app is open.

**The rule** (`idle.ts`). `hostBusy(snapshot)` is the one answer to "would someone lose something if this stopped
now": a live session working, waiting for an approval or on a question, or running background work that counts as
activity (#290); an open terminal; a running project command. A session whose turn has finished (`waiting_input`, what
`turn_complete` leaves until the next message) is idle: its answer is stored. Until 2026-10-05 that state counted as
busy, so every session that had ever answered held off the keeper's idle exit and the automatic apply; a waiting
question is now counted by `pendingQuestions`, not by the state. The snapshot is `activity()` in `main.ts`, with the
manager's session list, which carries pending approvals and questions and background tasks. The keeper reads it through the activity report (§4.1) for its idle exit;
the window gets it from the keeper's view for the switch's question and for applying an update when idle. An open
terminal counts even at a prompt: the host cannot tell an idle shell from one running a command, so the automatic mode
waits for terminals to close. Moving one session to a newly installed agent CLI (#297) uses the same file's narrower
rule, `sessionIdle` (§4.6).

**What the host sees.** Nothing new: the relaunched window reconnects through the same front door, then the switch
drains this host and starts the new build's (§4.2), after the keeper has handed itself over (§4.4). The new host's
update status starts fresh at its own version.

The desktop waits for its automatic relaunch swap before mounting the app (#580). If that attempt
fails or times out, it opens on the attached host and remembers the attempt so `DesktopRoot` does
not repeat it automatically. The platform records the attached swap's `startedAt` before requesting
another switch: the keeper retains its last swap across handoffs. The startup wait ignores failed
swap broadcasts with that same timestamp, including activity changes before a new swap starts;
the current request's rejection, a new failure, a matching host build or the timeout settles it.
Only a matching host build or a final swap with a different `startedAt` supersedes the startup
error. A failed new swap shows its reason once, and a late success clears the timeout; an old final
swap cannot hide a new refusal.
Later switch requests record the same boundary, so a new final swap clears their request timeout
even if it arrives before the timeout. Repeated old reports and full restart errors stay independent.
The browser regression in `e2e/relaunch.spec.ts` boots the real desktop entry with a mocked shell
boundary.

### 4.6 Moving sessions to a newly installed agent CLI (#297)

Every session runs its own agent process, started from the CLI installed at the time, and an update to `claude` or
`codex` reaches a session only when its process starts again. Under the keeper (§4.3) a process outlives every app
restart, so a person who uses Centralu daily could run an old CLI indefinitely. `agent-versions.ts` knows both sides and
restarts a session on the installed CLI when nothing in it would be lost.

**The installed version** (`AgentAdapter.installedVersion`, `cli-version.ts`), read at host start, every ten minutes,
and when a window gains focus (`agents.versions { force: false }`, answered from a reading under 30 s old):

1. npm's `package.json` beside the file the command runs (`whichTool`, then `launchFor` for a Windows shim, then the
   symlink's target), with the package name checked: `@anthropic-ai/claude-code`, `@openai/codex`. No process runs.
   On Windows this is the only way it is read: Claude starts from the host's own link under
   `<data>\tools\claude\…` (§1, "How a Claude process is started on Windows"), and running npm's `claude.exe` to
   ask would hold the file an npm update has to replace.
2. The file's own name when it is a version: Claude Code's native installer links `claude` to
   `~/.local/share/claude/versions/<version>`.
3. `<cli> --version`, off Windows only (a Homebrew cask, a manual install).

**The running version** is `SessionInfo.agentVersion`: what the process reported (`agent_version`, §2), and until it
does, the installed version when it was started. Each keeper spawn writes that version on the child's tag
(`{ kind: 'agent', tool, sessionId, version }`), and `adoptKept` gives it back to the session, because an adopted
process does not report again. A tag from a host before #297 has no version: that session's version stays unknown and
it is never moved by itself (unknown is never "older", `runsOlderCli`), until its next restart. If an update lands
between the last reading and a spawn, the tag names the older version; the next host then moves that session once
more, which costs a resume and nothing else.

**When a session is moved** (`restartDecision`): it is live, it runs an older version than the installed one, it is
idle by `sessionIdle` (no turn, no approval or question, no live background task, and a tool that cannot report
background work is never idle), and, when it moves by itself, nothing has come from it for 60 s (counted from host start
for a session the host has not heard from). The quiet period is for the person: a turn that just ended is when they read
the answer and type the next message. `sessionIdle` reads the same facts about a session as `hostBusy`, but leaves
out terminals and commands, which a session restart does not touch, and never calls a tool idle that cannot report
its background work.

| Decision | Why |
|---|---|
| Moving by itself is on by default ("Move idle sessions to a newly installed agent CLI", `agents.setAutoApplyVersions`, saved as `agents.autoApplyVersions`) | The owner's decision (2026-10-05). The restart waits until nothing would be lost, and the conversation continues through resume |
| The header's action (`agents.applyVersions`) restarts every idle outdated session at once, without the quiet period | The update is app-wide; a person who just updated wants every session on it. A busy one is listed and keeps the line |
| The restart is the manager's `restartSession` | The same path as "Restart agent": the handle is disposed (under the keeper: stdin closed, then a signal, through the keeper), and the session resumes in a newly spawned process. Nothing is re-attached, so the new process is the new CLI (`sessions/agent-versions-restart.test.ts`) |
| The conversation gets one line from Centralu, "Claude Code restarted on 2.1.290 (was 2.1.282). The conversation continues." | A process restarted by itself is never silent |
| The installed versions last seen are kept (`agents.versionsSeen`) | An update made while the app was closed still counts as a change |

**Default tool resolution (#573).**

The registry resolves a saved tool only when its adapter is registered, otherwise the first registered adapter.
An empty registry returns no tool (`null`): project listing and serving apps still work on a host with no agents.
Creating a session without a tool fails with `tool_not_installed` and asks the person to install and configure an
agent CLI. Linked projects keep a missing default too; creating a session there requires an available tool.

**Tool definitions after a host switch (#581).**

The keeper can preserve an agent process across a Centralu update, but that process also preserves the Centralu MCP
definitions it was started with. `SessionManager.refreshToolDefinitions()` compares the profile's served definitions
and instructions using `residentCost(...).prefixHash`; the adapter declares the serving form in
the adapter capabilities (`toolDeferral` and `instructionChannel`), rather than the manager naming a CLI.
The hash is kept in an app setting per session.
On a changed hash, a live idle session restarts through the same resume path as #297; a working or approval-waiting
session restarts after its turn; a sleeping session has no process and records the new hash for its next wake. Thus the
conversation continues while the next process sees the new tools.

**Launch settings after a host switch (#589).**

The same keeper handoff can retain a process that was started with an older adapter policy: Codex sandbox roots and
network settings, or Claude launch options and environment controls. Each adapter may report a versioned
`launchSettingsFingerprint(settings)` for the stable, session-specific launch inputs. The manager keeps that value in
an app setting per session and compares it after adopting keeper children. A mismatch restarts an idle process through
the ordinary resume path, waits for a working or approval-waiting process to finish its turn, and is simply recorded
for an asleep session with no process. The host never names a CLI or interprets the fingerprint; changing an adapter's
derived launch policy means changing its own fingerprint.

Codex's fingerprint is version 2 since #597 changes `auto` from workspace-write to full access. It includes
the adapter's sandbox override (`normal` leaves that mode to the person's settings). Kept sessions restart
through `launch_settings` so they pick up the changed sandbox.

A missing stored fingerprint is also a mismatch: builds before this check kept processes with unknown
launch settings. The update that introduces it therefore restarts each retained process once, at the
same safe boundary, and records the new fingerprint. Later handoffs keep an unchanged process.
Both changed and previously unrecorded launch settings use the `launch_settings` cache rebuild cause
("launch settings changed"); the restart log says "launch settings changed or previously unrecorded".
This is separate from `instructions` ("tools changed").

**The capability check seam** (#270). On every change of an installed CLI's version the service calls
`capabilityCheck({ tool, from, to })`. #270 proposes re-running the probes for what a tool could not do when its version
moves; nothing implements that yet, so the default writes one line to host.log saying so. The probes plug in there.

### 4.6.1 Putting idle sessions to sleep (#568)

Every session runs its own agent process, and an idle one keeps its memory: one Claude process was 240-300 MB after a
few turns and grew while idle (a three-day Opus session was 814 MB, #561). Ending it frees all of it, and resuming the
conversation later reads the prompt cache as the live process would have. Measured in #561 (CLI 2.1.29x, haiku): the
next turn read ~100% from cache resumed as live, at 2, 6 and 10 minutes on the 1 h lifetime and at 2 and 4 minutes on a
forced 5 min one; both expired alike at 6 minutes on 5 min. A wake adds +0.7 s (p50) and +1.8 s (p95) before the first
token. So the host puts idle sessions to sleep (`sessions/sleep.ts`, `SessionSleeper`), a policy of the host's and not
of a tool's:

| Rule | Why |
|---|---|
| A live session sleeps once it has said nothing (no event of any kind) for the set time: **15 minutes** by default, "Put idle sessions to sleep after" in Settings → Background (`agents.setSleepPolicy`, saved as `agents.sleepAfterMinutes`, `off` for never) | The owner's decision (2026-10-12). Inside the 1 h cache lifetime Claude Code asks for, so the wake still reads the cache |
| Only a tool whose adapter says so (`capabilities.sleep`): Claude yes, Codex no | Claude's resume was measured to keep the cache. A large Codex thread took 7-13 s to resume and its cache on resume is unmeasured; Codex's memory is better won by one shared app-server per account (#561 E3), decided separately |
| Never while `sessionIdle` says no: a turn, an approval or a question waiting, background work (the CLI's own timers included, below), or a tool that cannot report its background work | The same rule as moving a session to a new CLI (§4.6): ending the process would end what it holds |
| Never while it waits on others (`waitsOn`): a child it started with `start_agent` (or a session handling its ask_project task) still in the turn it gave it, a session it owns (`askedBy`; a former worktree manager's worktree sessions, #561) while that one works, or a session that owes it a report (`reportBack`), except one whose report is paused over its own background work while it rests (#721, §1.2.1 step 7) | Their answer comes back to it in moments, and waking it for that costs the resume it saved. A child waiting on its parent sleeps by the ordinary rule: it is idle |
| The quiet period counts from host start for a session this host has not heard from | A host that just replaced another (a restart, a swap) does not know what the person was doing a second ago |
| Sleeping is `SessionManager.sleepSession`: refused unless still idle, the handle leaves the map, `session_live {live: false, reason: 'asleep'}` goes out, the process is disposed. A message arriving meanwhile starts a resume that waits for the dispose (`sleeping`) | Never two processes on one conversation; a send is never lost to a closing handle |
| Waking is the ordinary `resumeSession`, the path a session takes after a host restart; every resume sends `session_live {live: true}` | One path to keep right. The event tells every window, not only the one that asked |
| `session_live {live: false}` also goes out when a process is dropped and no new one takes its place (#648): `reason: 'restart_failed'` when a restart the host started (a refresh, a CLI move, "Restart agent") did not bring a process up, `'crashed'` when the process died | Before this the windows kept showing the session live, the screen's wake stepped back, and the person learnt only when a send failed. Now it shows asleep, and the next message wakes it |
| Under the keeper the dispose stops the kept child (stdin closed, signalled). A host that takes over finds nothing to adopt for it, lists it asleep, and wakes it in a new child (`sleep-keeper.test.ts`). The sweep stops before a detach (`stopPlan`) | A sleep in the middle of a swap would end a process the next host is meant to adopt |
| The screen wakes a session when its composer takes the keyboard or gets its first key, and on send; never on selecting or viewing it, and the grid's panels are not woken at startup | A session looked at is not a session typed to. The resume runs while the person types, so its 0.7 s is mostly hidden. Before #568 selecting woke a session and the grid woke every panel at startup, to hide a slow Codex resume |
| Asleep shows quietly: the sidebar's tool mark is drawn exactly as the same session awake in the same state (a fade would read as a stalled session, #670) and only its tooltip says "asleep"; the conversation's line says "Asleep — it wakes when you type to it", then "Waking session…" while it starts | Not a state to act on, so no colour and no badge; but a person who wonders why the first answer is slower can find out |

`CC_SLEEP_AFTER_MS` sets a shorter quiet period over the setting, for probes and tests. `probe-resume-cache.mts`
re-measures the cache on a woken turn through a real host (§3.1); run it on a Claude Code update. Its first run
(2026-10-12, haiku, `CC_SLEEP_AFTER_MS=20000`, 120 s more of quiet): asleep after 23 s, the woken turn read 99.7% of
26,198 input tokens from cache (the warm turn before it 99.2%), and took 4.6 s from send to end against 2.3 s warm, the
resume and the transcript catch-up included.

**The CLI's own timers count as background work.** `/loop` and scheduled prompts are timers inside the Claude process
(`ScheduleWakeup`, `CronCreate`), which the CLI does not report as tasks; a process put to sleep or restarted loses
them silently. The Claude adapter reads them off the calls and their structured results (`ClaudeSchedules` in
`adapters/claude/schedules.ts`) and lists each pending one with the session's background tasks (kind `other`, not
stoppable on its own), so `sessionIdle` says `background`. A wake-up is pending until its `scheduledFor` (else the
asked delay, else the runtime's one-hour maximum), or until `ScheduleWakeup {stop: true}`; a cron job until
`CronDelete` names it, a `CronList` answer omits it, or it auto-expires after seven days (a one-shot job is kept as
long, conservatively). The adapter looks again a second after the next one is due. A process adopted from a previous
host reads them back from its conversation's last 400 messages (the transcript has no structured results, so a
wake-up counts its asked delay from the adoption). The background mark's tooltip lists them and says the session stays
awake until they end. A Codex session is never put to sleep, so its own scheduling needs nothing here.

Not covered: the reconnect recovery still wakes the sessions that were live before a host restart without a keeper.

### 4.6.2 Turns that stopped without anyone asking (#698)

A turn can end before its work does, and nothing about the session says so: it rests in `error`, `idle` or
`waiting_input` like any other. On 2026-10-15 the internet dropped twice while several child sessions worked. The
Claude children ended in `error` (the CLI retried `api_retry` ten times, about three minutes, then failed with
`ECONNREFUSED` and `ENOTFOUND`) and sat there until the person sent "continue" by hand; the turns had been opened by
the CLI itself (a Monitor firing), so no report was owed and the orchestrator that started them heard nothing. A Codex
child's interrupted turn was reported to its orchestrator as "The assigned work finished", and "Quit completely" reset
sessions mid-turn to `idle` with no line in their conversation.

The host now keeps **why the last turn did not finish** on the session (`SessionInfo.interruption`, stored as
`sessions.interruption`, store v53) and sends each change as an `interruption` event. Reading it from the events is
tool-neutral (`sessions/interruptions.ts`):

| Reason | Set when | Cleared when |
|---|---|---|
| `network` | a running turn ends in an error the network caused (`interruptionAfter` with `endedTurn`; a crash, `adapter_crashed`, and an error at rest are not): the error codes (`ECONNREFUSED`, `ENOTFOUND`, ...), Claude's "API Error: No response from API / Can't reach the API server / Connection refused, lost, reset, error, dropped / Request timed out / No internet route / Unable to connect to API / fetch failed" (the wordings read in the CLI's own connection-failure function; "Unable to connect to API: SSL …" is a setting, not the network), the computer sleeping, Codex's "stream disconnected before completion", "failed to lookup address information", "Connection failed: error sending request", "waiting for network" (`isNetworkFailure`; the sentences measured in the real store and host.log). Only the tool's sentence counts, not the stderr tail a crash carries (`failureSentence`); generic words ("connection closed", "network error") count only inside those sentences, since an MCP server or a dev server can say them | the session works again (`working`, output), or a turn ends otherwise |
| `quit` | a start finds the session `working` or `waiting_approval` with no process (a full quit, a reboot, a crash the keeper did not survive), or a kept process cannot be re-attached, or a turn a linked hub's update cut could not be continued (§4.8, #1618; one that is continued is not marked). A warning line from Centralu is written into the conversation ("Centralu quit or restarted while this turn was running …") | the same |
| `interrupted` | a turn ends `waiting_input` with the reason `interrupted_by_tool` (`INTERRUPTED_BY_TOOL`): Codex's `turn/completed {status: "interrupted"}` for a turn no `turn/interrupt` of ours preceded | the same |
| `reconnecting` | the tool has stayed `retrying` for `RECONNECTING_FLAG_MS` (5 minutes): Codex waits for the network without end. Live only, never stored | the activity moves off `retrying` or the turn ends |

| Decision | Why |
|---|---|
| An app request cancelled mid-turn fails its wait before it interrupts the session | Claude's adapter ends the turn as soon as the CLI confirms the interrupt, before the turn's result, so the wait read the cancel as "stopped before it finished" |
| Classify and surface; never resend by itself, except the turns a linked hub's update cut (owner, 2026-10-26, #1618: §4.8, "Continuing the turns an update cut"), which the next host continues once with the same sentence | A resent turn can repeat side effects (a push, a comment, a release). Continuing is one message from the person or the asker, the same sentence both ways: "Continue where you stopped. Check what already happened before repeating a step." Auto-resend on reconnect could come later as an opt-in |
| A Codex `interrupted` turn ends as a Stop does (`state_change waiting_input`), not as `turn_complete` | `turn_complete` is "finished": the orchestrator was told the work was done. A wait on the turn (`AgentRunWait`) ends on the interrupt, since no `turn_complete` follows it now |
| The Codex adapter tells its own interrupts from Codex's and logs which (`interruptsSent`, "interrupted by a stop from Centralu" / "by Codex"). A Stop that lands while a note's `turn/start` is in flight interrupts the turn the answer names, and counts as ours too (`takeInputTurn`) | The real case could not tell whether the person's Stop, the host or the CLI sent it |
| The person's Stop, and an orchestrator's `agent_session stop`, set nothing | They know; flagging their own act would be noise |
| Only `retrying` starts the `reconnecting` clock, never silence | A session polling CI with 15–40 s sleeps looked frozen and was not; long builds look the same |
| A report owed for the turn names the reason first ("stopped before finishing: a network error ended its turn", "its tool interrupted the turn") and how to go on | "The assigned work failed" made the asker redo or abandon work that only needed a "continue" |
| When no report is owed (no report mark, no call waiting on the turn now), the session that gave the turn hears once of a `network`, `interrupted` or `quit` stop (`tellAskerOfInterruption`): a delegation's caller nobody waits for now (`ask_project` or `start_agent` past its bound), else the session that started it (`askedBy`). A call still waiting reads the stop from its own answer | The 2026-10-15 case, and an `ask_project` turn whose session has no `askedBy`. One report per stopped turn; another needs another turn, so two sessions cannot wake each other in a loop |
| Every report and every word Centralu gives a session about its request (a start that did not start, a note or a queued request that did not go) goes through `tellSession` (#428): never while the host hands over or quits, never to a session that is gone | A quit used to report each running child as "failed: Centralu is shutting down" in its caller, which the next start then told again as a `quit` stop, and a report could wake a sleeping caller on the way out |
| A `quit` is told at the next start, once per child, to the first that still exists of: the session owed its report, the one that gave the turn (`delegated_turns`), its `askedBy` (`quitNotices`, after the keeper's adoption for a kept one). A kept process that cannot be re-attached settles its report the same way. **No requester that is itself stopped by a quit** is told, at the start or later: it waits for the person's Continue | An asker that delegated without waiting was at rest, not cut, and its report mark used to be dropped: it never heard. Waking it once costs a turn; never hearing costs the work. An orchestrator the same quit cut would be resumed at launch with nobody there, and that turn would clear its own "stopped" mark before the person saw it; its children's rows say they stopped once it is continued |
| The orchestrator's list (`list_sessions`, and `read_session` with no id for a reader) and `agent_session status` add "stopped: network error", "stopped: Centralu quit during its turn", "stopped: its tool interrupted the turn" or "reconnecting to its API for N min" to the row. No filter argument | The row already says it, and an argument rides in every request's tool definitions (docs/tool-cost.md). `agent_session list` (#690) names such a child `stopped` and leaves the reason to `status`: it is a list for cleaning up, where what matters is that the child's work is not over |
| The screen shows it beside the state: the inbox row's word and **Continue**, the sidebar mark's ring (only while the stopped turn's answer is unread, #1549) and tooltip, a line above the composer (product-spec FR-15) | The state alone looks the same for a stopped turn and a finished one; Continue is the one message that goes on |
| `CLAUDE_CODE_MAX_RETRIES` is left as the CLI sets it | Its three minutes outlast most drops; a longer budget would hold a turn hostage through a long outage |

### 4.6.3 The mailbox's delivery in the host (#1347)

`MailDelivery` (`mail/delivery.ts`) starts once the host is ready and **stops first** when it leaves, before the sessions are let go of
(`lifecycle/shutdown.ts`), so a host handing over wakes no session the next one takes. A delivery already waiting for a session to
wake checks again before it sends (`deliverMail`'s `leaving`). It writes a heartbeat (`mail.heartbeat`) with each 60 s sweep, except
while the person has not answered for a crowd of sleeping sessions, so that a restart asks again. A host that was off, or away without
stopping, more than 30 minutes wakes a sleeping session only for mail that needs it (§7.9). The sweep also runs the mailbox's retention
and moves on the work of a session that left without telling the mailbox. Sleeping sessions are resumed two at a time.

A wake is delivered when the tool says it took the input (`takeInput`, `sessions/session-events.ts`); a tool silent for 90 s counts as
having taken it, because sending it again could run the work twice. If that tool then **fails** the input (a session closed with it
queued, a rejected `turn/start`), the delivery makes the mail unread and undelivered again and holds it `failed` for the person (Inbox:
Retry): a failure told that late does not prove the tool never ran it, so nothing sends it again by itself. A failure after the tool
took it is not acted on. The tool keeps the wake in its own record as a user turn; the host writes no user row for it, so the catch-up and the import
that read the record back leave the wake out (`mail/wake-text.ts`, used by `stripInjectedBlocks`): the `✉` line the delivery
wrote is its only trace in the conversation, and `read_session` and `recall` never show it as the person's message.

**Delegations are written down beside the old path** (slice 3 of #1347, docs/plans/mailbox.md §8.1). Each place a session gives another work
(`start_agent`, `agent_session send`, `ask_project`, the orchestrator's `send_to_session` and `create_session` with `reportBack`, a request
queued behind a busy session, a fork) calls `ChildOwnership.delegated` once the task has been delivered by the old path, and the mailbox
(`MailService.recordDelegation`) writes it as a thread the caller owns and the child is assigned, `running`, whose first message is the
caller's own words and is recorded delivered and read, so nothing wakes the child. A later instruction to the same child is a `note` in
that thread; into a `done` one it opens a thread that follows it. It makes no relation or rate check (the delegation's own checks came
first), never throws into a delegation, and skips an auto observer's note and a child on a linked machine. Reports do not use these
threads yet. A delegation thread is moved when a party is archived as any thread is (§3.3, `MailService.partyGone`), never closed by it: the person becomes the owner of a gone caller's, and a gone child's is `open` with nobody on it. Only a delegation tool's thread is reused for the next instruction to the same child.

**Every turn is recorded** (slice 3). `ChildOwnership.turnStarted`, which already says whose a turn is (#1377), tells the mailbox (`turnRecorder`,
`mail/delegation.ts`), which writes a `mail_turns` row for a turn it did not start: `person` (no thread, unless they chose to add their message to
the task), `caller` (a message of the session that gave the work: the thread that session owns with this one), or `cli` (the CLI ran on
after the work's background tasks, again the thread its owner has). A turn a caller's message started begins before the delegation is written
down, so `attach` gives it the thread then, only if it is the work of that caller. A report or notice about another session starts a
turn of its own kind (`report`; an app's message is `app`), which is nobody's send. When a turn mail started is going, the other starter
adds nothing. The guards of §7.9 count only `mail` turns. A turn of no thread is deleted by retention once the session has a later ended
one. A host that takes over from another keeps the open rows of the sessions the keeper handed over that are still in their turn, reads
them back and records their end; every other open row is closed `lost` at start.

**A call that returns the answer is the report** (slice 3). When `start_agent`, `agent_session` (`wait`, `status`) or `ask_project` returns what a
child answered (or that its turn failed), `ChildOwnership.answered` tells the mailbox (`answerRecorder`): the reports it holds for the caller
are read and handled, and a thread still `running` gets a `report` recorded as told (delivered, read, handled: nothing wakes the owner for
news a call gave) and goes to `review`. A turn that left the child's own background work running reports nothing yet; the thread stays
`running` until that report comes. The child's last response is its own words, so it is put in the thread as a message of the child's
(`relayed`, clipped, read and handled for the caller) in front of the report; Centralu's report holds only what Centralu knows: how the
turn ended, the id, the kind of an error and `read_session` for more, never the child's text or an error's text (#1186).

**A turn's end is a report in the thread** (slice 3). `ChildReports.deliverReport` builds the old stored report (Centralu's lines, then the
session's last response) for the old way and hands the mailbox (`reportRecorder`) the words the model may read (#1186): how the turn ended, the id, the kind of an
error, how to go on, `read_session`. The session's last response is its own words, so the thread keeps it as a message of the session's (`relayed`, read and handled for the
owner) in front of the report, and the session's name, project, task text and error text are in no message under Centralu's name. It goes into the thread the owner has with the
session as a `report` from Centralu, with the facts a wake carries (`outcome`, the kind of `error`, how many tasks are left `paused`,
`personNote`), and the thread moves (`review` when the work was reported, `running` when the turn left the session's own background work
running, `done`/`dropped` when the person took the session over). An owner that reads mail (an ordinary session or the orchestrator) is told
by the mailbox and not by the old relayed message, in a turn too (3.9): at rest it is woken, in a turn the mail waits for the turn's end and wakes it then (until in-turn delivery by hooks, slice 6, brings it into the turn). The words (the last response) are read with `mail read`. Centralu's own
messages are never held by the loop guard: a turn that ends sends a report however many a thread has had. An owner that cannot
(a coordinator, a builder, an app's agent; also, only for how a report is told, a session whose process was kept from an earlier host and keeps the tools it started with: `SessionManager.readsMail`, whose doubt falls back to the relayed message, which any process takes. The mailbox's receive rule stays on the seat, `canReadMail`: such a session is still written to and woken by mail, so its relayed notice is delivered like a busy owner's: settled when it is delivered, and not kept when it fails, because the mailbox wakes it and a notice kept as well would be a second report) is told the old way as before, including keeping a notice it cannot deliver (`ChildReports.held`) until the
session takes a message; the report is in the thread, and its receipt is marked delivered when `tellSession` delivers it, now or from the kept ones, and nothing
tries to wake it. The old relayed path (`held`, the relayed notice) goes at the contract (slice 9), or earlier if every seat gets `mail`; the linked path keeps it until slice 4. No thread for the work, or a thread the
owner closed: the old way tells alone. A thread the session closed itself by mail, saying how it ended, takes no second report.

When the owner deletes the child (`agent_session delete`) after the work was reported, the thread is closed `done`/`finished` before the child goes. When the
session that had the work is archived or deleted on its own, `partyGone` leaves the thread `open` with nobody on it, and if the work was
still going (`running` or `open`) its owner gets one `report` (`stopped`, `reason: assignee_archived`) so it does not wait for work that
stopped; it reassigns or closes the thread. Archiving a child that is at work stops its turn, and that end is not reported as the work's (the report is `closed`
for a session being archived, `ChildReports` asks `trashing`): the one `assignee_archived` report is all the owner hears. A gone caller's threads are the person's, as ever.

**Work handed on keeps the thread running** (slice 3, §6). A delegation made in the middle of a turn that belongs to a thread (`start_agent`,
`agent_session send`, `ask_project`, … from a session doing work for someone) opens a thread whose `parentId` is that turn's thread and whose `depth` is one
below it, or the depth the host knows the child to be at if that is deeper (`recordDelegation`). A helper that is sent more (its thread is continued) takes the work
it is sent more from as its parent, or none when that turn belongs to no thread. Only the assignee's own work counts as a parent, and a session opening a thread by
`mail` may name no other (a thread kept open under another's work would hold that work running).

A turn of the parent that ends while such threads are going is a pause, not the work's end. A thread is going while it has an assignee and is `open`, `running`
or `blocked`: one in `review` has been reported to its owner, which has it, and one with nobody on it (its helper was archived or deleted; `partyGone` told the
owner) is not work anyone is doing. A blocked parent is not held by it. `ChildReports` passes `waitingOn` work, the report is `paused` with `facts.waitingOn`
(the thread ids) and the frame's `waitingOn="N"`, in Centralu's words and a count, nothing of the threads; the thread stays `running`, and the report mark stays owed for
the turn that ends it. Its own background work ending (the 60 s settle) while threads are still going ends only that pause. The same threads are not reported again by
the turns that follow (the last report of the thread is compared, not its events), and a call that returns an answer meanwhile does not move the thread to `review`
either (the mailbox holds it, `reportTurn`). A turn that failed or was cut short is reported as it ended.

A pause wakes its owner once (MB): the first pause of a thread, background work or child threads alike, wakes it; the later ones are recorded with `wake: false`
(read at its next turn, shown on the thread, no turn started) until the owner or the person posts work or a note in the thread. The end of the work, a failure, a
stop, a card and a blocker always wake. A pause that does not wake starts no turn for an owner told the old way either: `reportRecorder` leaves it recorded
(`closed`) unless the owner is in a turn, where the relayed notice joins the turn.

The turn a child's report starts, where the report is the only mail for its receiver and the receiver is running the work the child's thread was opened under,
belongs to that work (`drain`'s `workThread`), so its end is reported to whoever gave it. Mail for other work of the receiver's keeps its own turn.

**Across a host swap** (slice 3, §4.2). A session at rest that waits for threads it handed on keeps the report mark it owes: `restoreReports` runs in
the manager's constructor, before the mailbox hook is wired, so it asks the store for the threads going (`waitingOnSessions`, the latest thread of the pair), and the turn
their end starts ends under the new host and is reported once, as the work's end. Waiting needs no process of its own (the work is the helpers', and their report wakes
the session), so a session that was asleep, or whose host was quit, keeps it too; what its process held (a pause on background work) went with it. A mark of a session with
nothing going, or whose caller is gone, is dropped as before.

When this host becomes the active one (before delivery starts, `takeOverFromEarlierBuild`) it takes over from an earlier build that served the same store, both ways.
It **adopts** the report marks that build wrote (`adoptOldMarks`): each is a `running` thread owned by the marking caller (origin `start_agent` when the caller started the
session, else `send_to_session`) with a stand-in `assign` (the owner's words were not kept; the session's conversation has them) and an `adopted` event that carries the count
of the tasks a paused report waits on; keyed by the two sessions and idempotent. And it **closes the work that build finished** (`reconcileFinished`): an earlier build reports
the old way and never moves the threads this build wrote, so after a rollback and a roll forward a finished helper's thread still reads `running`, and its parent would count it
as going for ever. A `start_agent`, `send_to_session` or `ask_project` thread that is `open` or `running` with someone on it, whose session owes its owner no report mark (the mark
names the owner), is at rest, holds nothing paused or queued and has no mail it has not taken (the owner or the person sent more into it), goes to `review` with an event (`reason: no_report_owed`) and no report: that build told the owner. Blocked threads and
threads made with `mail` or `agent_session` are left. The old rows stay, kept in step as before. Queued requests are not adopted yet (#1456).

**Reports are mail only for an owner that reads mail** (slice 3.9, §8.1). A report to an owner whose seat has the mail tool (`canReadMail`) and whose process is known to have it (`readsMail`) is the thread's report and nothing else: at rest the mailbox wakes the owner; in a turn the mail waits for the turn's end (delivery's `busy`, then a poke when it comes to rest) and wakes it then. No relayed message goes into the turn, and nothing is kept in memory for the owner (`ChildReports.held`). The old way of telling stays for the two who are not that: an owner whose seat cannot read mail (a coordinator, a builder, an app's agent) is told the relayed way and the notice is kept if it cannot be delivered (nothing else will tell it), and a process kept from an earlier host, whose tools may not include mail, is told by the relayed message (not kept) and woken by the mailbox if that fails. In-turn delivery by hooks (slice 6) will bring the mail into the turn; until then an owner in a turn hears the report when the turn ends. An owner that reads the answer in that turn through `agent_session wait` or `status` marks the report read, so it is not woken again; one that read it with `read_session`, or called `status` before the helper had finished, has not, and is woken once at the turn's end.

**The thread moves when the turn begins; the person closing it tells the owner** (slice 3.10, §3.3). More work for a session (the owner's or the person's `note`, `question`, `answer` or `assign` into a thread in `review`, or an `assign` into an `open` one) leaves the thread as it is when it is posted; it is `running` from the moment the turn that mail starts begins (`MailService.turnStarted`, called by delivery once the tool took the input): only the assignee's, only the turn's work thread, only when the mail in the delivery gives it work, with an event (`reason: turn_started`). An assignee that is not a session (an app has no turns of its own yet) is moved when the mail is posted, as before. A delegation tool's continued thread (`recordDelegation`) is still moved by the call: it is the host's act, the move the old path made when the turn started. When the person closes a thread a session owns (Drop, Mark done in the Inbox, `update` to `done`) its owner is told once: a `report` from Centralu to the owner (`facts.closedBy: person`, `outcome` `dropped`, `marked_done`, `failed` or `stopped`), in Centralu's words and with the session's id. The owner closing its own thread, and the person closing work they own, tell nobody; taking the session over has its own report (`personTookOver`). The turn that was still going when the person dropped it is not a second word (`reportRecorder` answers `closed`). A review thread the owner sent more into counts as work going for its parent until the turn begins (`openChildren`), so the parent is not reported finished meanwhile. Not done (#1472): an owner that cannot read mail, or whose process was kept from an earlier host, is not told of the close.

**Closing work that is going stops it** (3.10, MB). When the person (Drop, Mark done) or the owner (`mail close`) closes a thread whose work was going (`open`, `running` or `blocked`) with a session on it, `MailService.update` asks the host (`ClosingHooks`, `closingRecorder`): a turn of the thread is going when the assignee is in a turn and `mail_turns` says that turn belongs to this thread. That turn is stopped as `agent_session stop` stops it: interrupted (`SessionManager.workClosed`), with the background work that turn's own tool calls started (calls since the turn began, matched by the task's `parentCallId`; a paused report for the owner adds what it waited for; a dev server the person started, an earlier turn's work and work the tool cannot place are left running, #1474), and the report mark is dropped so the stopped turn is not reported again; the owner's one report is the person's close notice, with `facts.stopped: true`. The helper is told once, in Centralu's words ("The person dropped thread t_…; its work was stopped. Do not continue it.", naming the owner when the owner closed it), as quiet input into a live process of a tool that takes quiet input (`quietInput`, Claude; no wake) and as a `helper_told` event of the thread. A sleeping helper, and one in a tool with no quiet input (Codex starts a turn for any input), get the event only (#1474). A helper paused over its own background work for the owner counts as going: its work is stopped and the Inbox asks. A helper in a turn that is not the thread's (the person's own, another thread's) is not interrupted and gets the note without `was stopped`. The helper closing its own thread, and a thread whose work was reported already, stop and tell nothing. The Inbox row says `working` when a turn of the thread is going, and Drop and Mark done then ask once ("<helper> is working on this. Stop its work and close the thread?"); closing without stopping is not offered.

**A turn the mailbox starts is reported** (3.10, MR2 live). A delivery that carries mail of a thread the session is the assignee of, owned by a session, starts a turn that is that thread's work: its end is reported to the owner as any turn of work is (`reportBackIfAwaited`, so the same pause and dedupe rules), and the thread leaves `running`. Delivery tells the host in `MailInput.reportTo`; the host owes the report from the moment the input goes in (`SessionManager.mailSessions`'s `deliver` sets the report mark) and forgets it if the input is not taken. Only mail that gives the thread work counts (`MailService.givesWork`: a running thread, or the owner's or the person's `note`, `question`, `answer`, `assign` into a reported or open one); a member's note starts no work of the thread. Before this the owner's new work into a thread in `review` ended with the thread `running` for good, and a parent above it paused for good. A helper that already owes another owner a report keeps that mark and its pause: the host remembers the turn's owner apart (`ChildOwnership.markMailTurn`, in memory) and reports the turn's end to that owner alone (`ChildReports.reportMailTurn`, no pause), not to the first owner; the first owner's paused work that ended during the turn is settled at its end; a close of the thread while the turn runs reports it to nobody. A host swap in that turn forgets the owner, and the turn is then read as the first owner's (#1474).

**Work the person owns** (slice 3, §8.1). A session a script or the RPC starts with a first message has nobody waiting for it: `agents.createSession` called over a
connection with the limited credential (#1405: every process of the user other than the window) and an `initialPrompt` passes `byScript`, and `createSession` writes the
work down before the message goes in (`startedForPerson`): a `running` thread owned by the person (origin `create_session`) with the message as its `assign`, already
read by the session, which wakes for nothing. A call the person had to allow on a card (a preset above `normal`) runs as the limited call it was (`HostRequests`), so it is
a script's too. A window's own `createSession` is the person typing, and starts no thread. The person owes the work while that thread is `running` (`personOwes`), so it
survives a host swap in the store and needs no mark of its own. The turns of the session that no one else started (not the person's, not a report's, not another
session's) belong to the thread while it runs (`turnRecorder`), so work handed on in them is a child thread of it and the turn's end is a pause, as for a session's work (§6).

**A session asking the orchestrator** (3.11, #1447, §9.7). `mailRelations` lets any session write to the orchestrator (unless its tool cannot put each step of a request to the host:
`orchestratorAsks`, from the adapter's `gatesSteps`; checked before a reply in an existing thread, so a request opened earlier does not wake it either), and `MailService.open` holds the limits of asking (`checkAsk`): the request is an `assign` (a thread with the session as owner
and the orchestrator as assignee, `MailService.isAsk`), one is open at a time (`open`, `running` or `blocked`; one the orchestrator has answered, `review`, is not open), at most
`ASKS_PER_HOUR` (5) words an hour go to the orchestrator, a request's first word and each word written into it after (`checkAskRate`, also in `post`), both limits counted over the asker's project and its root session (`MailPolicy.askGroup`), and the refusal names the open thread when it is the
session's own (`refused` with `data.thread`). `MailService.requestedBy` is the session whose request a thread is, from the thread's first word and not its owner now, which
`partyGone` changes. The request's words are never inline (`drain`): the orchestrator's wake lists host fields (`relationWord`: "a session asking you for something") and
`mail read` adds the header over the quoted words (`MailTool`'s `asker`, from `AskedByHost`), in the request's own turn only (`MailTurns.current(...).threadId`), where another turn is
shown only who it is from. A session reaches the orchestrator as `to: "orchestrator"`, because an ordinary session cannot list it. A request from a project that is not trusted is
held `policy` by the delivery (`untrustedAsker`) until the person releases it. `MailTurns` records the asker when the turn begins (`askerOf`; read back in `closeStale`), so the gate does not
follow the thread's owner. The end of the orchestrator's turn is reported to the asking session as any turn of work is, in the thread of the turn that ended (`MailTurns.threadOf`, else `askedOf`),
and for a request in Centralu's words alone (`askedReportBody`): no last response, no `read_session` pointer. The privileged steps are gated by `AskedGate` (`sessions/asked-gate.ts`):
`runParsed` calls it around every tool and command, `SessionApps.call` around every app tool, and the Claude adapter around every step of the CLI's own (`CreateSessionOpts.requestTurn`:
`requestTurnHooks` puts a `PreToolUse` hook in front of every tool call, in any permission mode, with a `timeout` long enough for a person, and it asks `AskedGate.askCli`: a read is left to the CLI's
own flow, an Allow is returned as the hook's `allow` so the CLI does not ask again, a Deny as `deny` with the words the model reads, and a question that cannot be asked as `deny`; a tool of Centralu's own
server and an attached app's are left to their own gates, so the person is asked once. A permission mode narrowed per turn (`setPermissionMode`) was built first and dropped: tools that need no permission never reach
the permission callback in it. `scripts/probe-pretooluse-hook.mts` measures the hook with the real CLI). `askCli` refuses without a question what would go on after the turn (`OUTLIVES_THE_TURN`: a subagent, a scheduled prompt,
a watched command). `AskedGate` also remembers the scope of every read of the orchestrator's conversation (`asked-reach.ts`: `readScope` names what a read looks at as an allowlist: a path, a named session, project or thread, and nothing for a call that gives back nothing; any other tool or a name not known is a read of everything (`agent_session` `list`, a `mail` `update` of another thread, and `AskUserQuestion` in a request's turn included), and `pinned` fixes a path's real place at read time; `SessionApps.call` tells the gate of a read-only app tool with `readOnly: true`, which it runs without a question; the CLI tells it the reads of the person's own turns through `RequestTurn.seen`),
from `beginConversation` (a launch with nothing to resume and no past conversation handed over in the prompt: `session-start.ts` asks `orchestratorMemory` first) until the next one; a conversation it did not see begin, or one that starts from such a summary, counts as having read everything. `outOfReach` judges the scopes against the asking session's folders and project from
`AskedGateHost.reach`/`projectOf` when words are written; after a read out of reach, `askedAct` makes every `mail` `reply`/`update`/`close`/`send` to a session in a request's turn raise the card with the whole text. `askCliRead` is the CLI's own card for a read in a preset that asks (`canUseTool` in
`session-cards.ts` hands it to `RequestTurn.askRead`), so it names the session and offers no "always". When the orchestrator's open turn is a request (`askedBy`), a step that `askedAct` does not list as
a read raises an `other` card (`ORCHESTRATOR_CHANGE`, `alwaysAsk`, not covered) with "Session "…" in project "…" asked the orchestrator to run …", and Allow runs it with the
orchestrator's own cards covered for the call (`HostCards.cover`: answered `allow` once, never persisted, only for work the call itself started and only until it returns or its signal fires; an Allow that arrives after the request's turn ended runs nothing). A request held for an untrusted project is shown to the orchestrator as waiting, with none of its words, so reading it cannot take it off the person's Release list. A turn kept under the keeper across a host swap is read back from `mail_turns` (`MailTurns.closeStale`) and is still the request; a lost one is closed,
and its steps are not asked about, since its tool calls are gone with it. Not done: a linked machine's session asking the hub's orchestrator (slice 4, the machine's asks
switch and a card that names the machine too), and Codex as the orchestrator of a request (its per-turn approval policy: `TurnStartParams.approvalPolicy` is not in the generated types here and no `codex` binary was available to measure it).

**The first message is the script's, not the person's** (3.8b). Only words the person typed may pass as theirs, and a script's first message can carry outside words (a CI log, an issue title). So `createSession` over the limited credential stores it, and announces it as `user_message`, with `fromScript: { credential }`, where `credential` is what the connection called itself in its hello (`RpcContext.label`, cut by the transport, never checked), made plain by `scriptLabel` (no quote, bracket, angle bracket or line break; `unnamed` when it said nothing). It is written by the host from the connection, never from a field of the call: a window's call has none, and a field in the params is ignored. The session reads it under a header of Centralu's (`scriptMessageFrame`: "sent by the script <label> the person set up; the person did not type it"), every line behind `> `, not stamped `origin: human`. The screen draws it as the script's (its label, dashed, like an app's message), not as the person's bubble; `read_session` gives the line `fromScript`, `recall` marks it `[script "<label>"]`, a handoff record and an orchestrator's memory do not take it for the person's; the session is not named from it. The thread's `assign` carries the label as a fact and `mail read` says it is a script's, not typed by the person; the owner stays the person, so reports still land in the Inbox. A call the person allowed on a card keeps the label (`HostRequests` passes it on). The label is the script's own claim: every process of the user holds the one limited credential, so any script may call itself anything, another script's name or `Centralu` included. It stands in quotes in every sentence of Centralu's (`the script "<label>"`), says who the script says it is and nothing more, and grants nothing. A later `agents.send` by a script is marked the same way, from the calling connection (`SessionManager.send`'s `fromScript`): stored and announced as the script's, under the same header, not stamped `origin: human`, not naming the session, and with no `intent` (a script cannot take over a report another session is owed); it is the work's turn, not the person's own, so a thread the person owes is reported when it ends. Not done (#1468): `apps.askBuilder` from a script still stores its text as the person's, a session created on a linked machine has no mark, and the Inbox thread's subject is still taken from the script's text.

The end of the first turn that is the work's (`reportToPersonIfOwed`, for a turn no one else is owed and the person did not start) is a report in the person's thread: Centralu's
words (`personReportLine`: how the turn ended, a count of tasks, nothing of the session's words), the session's last response as its own relayed message beside them, the
`failed` kind as a fact; the thread goes to `review`, so the turns after it are the person's own and are not reported. A turn that left the session's own background work
running is a pause: the thread stays `running`, the same count of tasks is said once, and the turn that work's end starts is the report. A turn a quit cut (the next start found the session mid-turn with no process, or a kept process could not be re-attached) is reported as the `quit` it was, and the thread goes to `review`. Not done (#1463): a pause whose background work ends with no turn leaves the thread `running` (report marks have a 60 s settle for this; the person's thread has none), and a first send that throws after the session started leaves its thread `running`. Also not done: a session started on a linked machine has no thread.

### 4.7 Remote mode, phase 1: `centralu serve` (#82)

The app can work with a project on another machine (an SSH server, later a laptop). That machine runs its own,
independent host: its own store, its own agent CLI sign-ins, its own files and terminals (#82, decision 1). In phase 1
the person installs and starts that host by hand; the app reaches it through an SSH local forward. Nothing listens on
a public interface on either end: the remote host binds 127.0.0.1, and so does the forward on the person's computer.
The app installing the host over SSH is phase 3, after its lifecycle contract is written (#82, decision 4).

**On the remote machine:**

1. Install Node 22.14 or later, then `npm i -g centralu`. On Linux the platform package carries the bundled host
   unpacked beside the AppImage (`host/`, [releasing.md](releasing.md)), so running it needs no display, no FUSE and
   no desktop libraries.
2. Install Claude Code and/or Codex there and sign in (`claude`, then `/login`; `codex login`). The host uses that
   machine's sign-ins, never the client's.
3. Run `centralu serve`. It stays in the foreground and logs to stderr (and to `~/.centralu/host.log`, as always).
   The line to look for is `[centralu serve] listening on 127.0.0.1:17175 …`.
4. Keep it running: `centralu serve --detach` (below), which the app also runs over ssh when it finds no host
   there, or whatever you already use: tmux, `nohup`, a `systemd --user` unit (below), which also starts it at boot.
   An update path and uninstall come with the installer in phase 3.

```ini
# ~/.config/systemd/user/centralu.service
[Unit]
Description=Centralu host (centralu serve)

[Service]
# The launcher serve keeps up to date, so the unit does not depend on npm's PATH
ExecStart=%h/.centralu/bin/centralu serve
# SIGTERM to the launcher only; it passes one to the host, which stops its own agents first
KillMode=mixed
TimeoutStopSec=30
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now centralu`, and once,
`loginctl enable-linger $USER`, so the host keeps running after you log out. Run the first `centralu serve` by hand:
that is what writes `~/.centralu/bin/centralu`. `centralu serve --autostart on` (below) writes and enables a unit like
this one for you.

**The commands:**

| Command | What it does |
|---|---|
| `centralu serve` | Starts the host in the foreground on `127.0.0.1:<port>`. Exit code: the host's own (0 after a clean stop) |
| `centralu serve --port <n>` | The same, on that port. The port is recorded, and the next `serve` without a flag uses it |
| `centralu serve --detach [--port <n>]` | Starts `serve` outside this session and returns once its host answers a hello (below). Prints one JSON line. A host already running is reported, not started twice |
| `centralu serve --detach --from <hub>` | The same; `<hub>` is the name of the computer whose link asks (letters, digits, `.`, `_`, `-`), written with the ssh client's address to the host's `host.lock`, so a second Centralu refused on this folder names that link (#1223). A hub sends it only when the connection line's `takes` lists `from` |
| `centralu serve --stop` | Asks the running host to stop (`host.stop`), waits until it has, and prints one JSON line |
| `centralu serve --connection` | Prints one JSON line and exits (below). Creates the token if there is none yet |
| `centralu serve --rotate-token` | Replaces the token, keeping the port. A running serve keeps the old one until it restarts |
| `centralu serve --autostart on\|off\|status` | Starts this machine's host at boot, stops doing that, or says whether it does (below). Never starts or stops a host now. Prints one JSON line |
| `centralu serve --help` | The above |

`--connection` answers the one question the client asks over `ssh -T -o BatchMode=yes <target> …`:

```json
{"v":1,"port":17175,"token":"…","version":"0.1.0-beta.11","protocolVersion":1,"dataDir":"/home/me/.centralu","hostRunning":true}
```

| Field | Meaning |
|---|---|
| `v` | The shape of this line. A client that does not know the number says which side to update |
| `port` | Where the host listens on the remote's loopback: the port the last `serve` listened on, else 17175 |
| `token` | The token for the hello. The same across restarts until `--rotate-token` |
| `version`, `protocolVersion` | The running host's when `hostRunning`, read from its `hello_ok`; otherwise the installed package's (`host/bundle-info.json`). They differ after an `npm i -g` the host was not restarted for |
| `dataDir` | The data folder the host owns |
| `hostRunning` | A host holding this token answered a hello on `port` just now. A TCP connect alone does not count |
| `proof` | Present (`true`) when the installed host answers a `prove` (#838; `hostProof` in its `bundle-info.json`): the hub then asks it to prove it holds the token before sending the hello, so a program another account put on the forward's local port never sees the token. Taken from the installed build, not from what answers on the port. A host still running from before the update refuses the proof: the link says the machine runs an older host than the one installed and asks for a restart there. Absent from an older remote, which gets the hello as before |
| `takes` | Additive (#1223): the options this `serve` takes that an older one refuses, today `["from"]`. A hub adds `--from <its name>` to `--detach` only when it is listed: an older serve answers an option it does not know with an error and starts nothing |
| `autostart` | Additive: `{ on, how, linger }`. `how` is what this machine starts its host at boot with (`systemd`, a scheduled `task`), null where it offers nothing; `on` whether `--autostart on` wrote that entry; `linger` (systemd) whether the user's manager starts at boot or only at login. Read from `<data>/autostart.json`, the mark `--autostart` keeps, so no link start asks systemd or Task Scheduler |
| `install` | Additive (the line stays `v: 1`): `{ managed, current, previous, node }`. `managed` is whether the managed launcher of an install the app made over ssh ran this command ([plans/remote-hub.md](plans/remote-hub.md) §10.1); `current` and `previous` are that install's pointer files as `{ version, node }` (null when absent or not two plain words); `node` is the Node that answered |

stdout carries that line and nothing else; anything to explain goes to stderr. If the command is not found (exit 127),
the SSH shell's PATH lacks npm's global folder (nvm, fnm, volta and `~/.npm-global` set it only in interactive
shells): use `~/.centralu/bin/centralu`, which `serve` and `--connection` keep pointing at this install and this Node
by absolute path. Those paths are versioned under nvm and Homebrew, so after a Node upgrade the launcher fails until
`centralu serve` (or `--connection`) runs once from an interactive shell and rewrites it.
On Windows it is `centralu.cmd`, written in UTF-8; cmd.exe reads a batch file in the console's code page, so the file
switches the console to UTF-8 (`chcp 65001`) before the line with the paths, or a profile folder named in Korean
(code page 949) sent node to a path that was not there (#849, `launcher-cmd.test.ts`). The code page it had is put back
on that same line, ahead of node: cmd.exe has read the whole line by then, and a Ctrl+C that ends the batch job cannot
skip the restore.

| Decision | Why |
|---|---|
| A launcher starts the bundled host on the system Node; no keeper | The same `resources/host` the app runs, so a remote host is not a second build to keep working. The keeper exists to swap builds under a window and to hold agents across restarts; a headless host needs neither yet |
| Bound to 127.0.0.1 only, reached through an SSH local forward | SSH already authenticates the person and encrypts the link. A public port would need TLS and a login of our own, and every scanner on the internet would find it |
| The token lives in `<data folder>/serve.json`, mode 0600 from the first byte, narrowed back if it drifts | It is the key to every RPC on that machine. `--connection` prints it and nothing else does: the host's ready line, which carries it, is read by the launcher and never passed on |
| The token reaches the host as the first line on its stdin (#538), not `--token` and not `CC_HOST_TOKEN` | Any user on the machine can read another's command line (`ps`), and every process of the same user can read a process's start environment for as long as it runs, deleted or not (#502). The host's stdin is a pipe to the launcher anyway (`--watch-parent`) |
| Token and port are generated once and kept | The client stores them and reconnects without an SSH round trip; it runs `--connection` again when a hello is refused, or when five redials of the same forward (about 6 s) reach no host: a detached host that died leaves `ssh -N` up, and only the connection line says to start one again (`LINK_REDIALS`, #1143) |
| Default port 17175 | Below every OS's ephemeral range and below the host's per-app view origins (20000–32767, `views/origin-ports.ts`) |
| A recorded or default port another program holds moves to the next free one above it (up to 19 more, below 20000) and is recorded; `--port` is used as given | One Windows laptop linked twice, its Windows side and a WSL distro, had both hosts on 17175: WSL2 relays the distro's loopback ports to Windows (`wslrelay.exe`), so the second could not start (#482). Inside WSL, the ports Windows listens on count as taken too (`netstat.exe` through interop): a host there on such a port would be unreachable, because the hub's forward ends on Windows' loopback. `--connection` reports the port the host got |
| The host gets its own process group and `--watch-parent` | Ctrl+C reaches the launcher, which passes one SIGINT to the host alone, and the host stops its agents in order. Killing the launcher, even with SIGKILL, closes the host's stdin and takes it down: it is never left running unsupervised (`tooling/launcher-serve.test.ts`) |
| A signal during startup is held until the host can shut down | Before the host attaches its handlers the kernel's default applies and ends it on the spot. Measured: a SIGINT passed on as soon as the ready line was read killed the host every time. Now it shuts down cleanly once started; a second signal while starting exits at once (`lifecycle/endings.ts`, `holdSignals`) |
| A second signal forces the exit only when it comes 1 s or more after the first; SIGHUP shuts down like SIGINT and SIGTERM | A person pressing Ctrl+C again, while starting or while shutting down, gets the host gone at once (exit 1); a shutdown is also bounded at 10 s (`lifecycle/shutdown.ts`). One request often arrives as two: Ctrl+C reaches the launcher, which forwards a SIGINT, and the terminal may deliver its own; a closing terminal sends SIGHUP right after SIGINT. Within `REPEAT_AFTER_MS` (1 s, `lifecycle/endings.ts`) the second is the same request and changes nothing, so it cannot cut the shutdown it asked for short (owner, 2026-10-12, #504). Without a listener SIGHUP's default ended the host with no shutdown at all |
| A second `serve`, or any other host on the same data folder, is refused | The ownership lock (`instance-lock.ts`) is the authority. `serve` first asks the port it recorded, so a serve already up is named with its port; for any other owner the host's lock message is followed by a line naming the pid and, when `host.lock` says, who started it. The host's own message names a serve host's link and what stopping it costs (#1223): on a linked Windows machine the desktop window used to be told to close a window that did not exist |
| Except on Windows, where a `serve` in the person's sign-in takes the folder over from a host in a network logon, once that host has nothing running (#1224) | The host the hub's ssh started before anyone signed in cannot open the user's Credential Manager vault. The sign-in task's `serve` (at sign-in, or from `--detach`) asks it `host.stop { ifIdle: true }` every 30 s: the host checks its own idle rule (no turn, approval, question, background work, terminal or command) and the calls in flight, and stops in the same step, taking no new call from its yes on, so a turn cannot slip in between. Then this serve starts its own host on the same port and token; the hub's link drops and reconnects by its backoff; past its redials (about 6 s) it reads the connection line, and a `serve --detach` it runs then is kept by the folder's lock from making a second host on it (`serve-detach.mjs`). It waits 30 minutes at most, and says `waiting`, then `gave_up`, to the host (`host.handover`), which the hub's row shows. A host that does not say its logon (older) is never moved |
| No `DISPLAY` / `WAYLAND_DISPLAY` in the host's environment | Nothing it starts can open a window or a keyring dialog nobody would see; a tool that would ask falls back to its file store or fails with a message in the log |
| Windows: no own group, no forwarding | `detached` means a new console there; the host shares the launcher's console and gets Ctrl+C itself. Not exercised yet |

**Keeping it running without a session: `--detach` and `--stop`** ([plans/remote-hub.md](plans/remote-hub.md) §10.4).
The hub runs `centralu serve --detach` over ssh when it finds no host running (§4.8), and a person can run it too.
It starts the same `serve` as a launcher outside the session that asked, then returns once that launcher's host
answers a hello, so the caller can connect at once:

| Where | How it is started | Why (measured, plan §10.4) |
|---|---|---|
| Linux, macOS | A new session (`setsid`) with no terminal and no stdio; reparented to init once `--detach` exits | Nothing of the ssh session's process group or terminal reaches it (`tooling/launcher-serve.test.ts` kills the whole group and the host still answers) |
| Windows, someone signed in | The data folder's scheduled task (`Centralu host (<user>)`, the one `--autostart` writes), registered without its trigger when it is not there, and registered again when its action or its principal is not what this serve would write (a launcher that moved, a task another account wrote under the name), keeping a trigger only when the task was this user's; then started with `Start-ScheduledTask` (#1224). `detach.how` is `task` | Its principal is `Interactive`, so it runs in the person's own session with their sign-in's token, also when asked from an ssh session. Measured on a linked Windows 11 PC (2026-10-19): started from the hub's ssh logon it ran in session 1, interactive logon, medium integrity, and saw the user's Credential Manager entries; the ssh logon's own processes ran in session 0, network logon, and saw none (`cmdkey /list`: `* NONE *`) |
| Windows, nobody signed in (no Explorer outside session 0 whose owner has this account's SID; matched by SID, since an ssh logon on a PC in a workgroup says `USERDOMAIN=WORKGROUP` where WMI names the PC, #1223), the task's host not answering in 20 s, or `CENTRALU_SIGNIN_TASK=off` | `Win32_Process.Create` through WMI (`Invoke-CimMethod`), from Windows PowerShell 5.1 by full path | Windows' OpenSSH ends every process of a session with it, `Start-Process` included; a process WMI creates is not in the session. It keeps the caller's network logon: Git there cannot use the credentials saved in Windows, and the host says so (`hello_ok.logon`) |
| WSL (`WSL_DISTRO_NAME` set and interop on) | The same WMI call, from `powershell.exe` reached through the drive WSL mounts, creating `wsl.exe -d <distro> -u <user> --cd <folder> --exec <node> <centralu.mjs> serve …` | WSL stops a distro about 15 s after its last `wsl.exe` client exits; this `wsl.exe` is one for as long as the host runs. On the test laptop a WMI-created `wsl.exe` later hung without running anything (plan §10.4); that is reported as `wmi_blocked`, and the hub runs the host link-bound |

A process WMI creates gets the account's default environment, not the session's, so what the launcher needs from the
`--detach` that started it travels in one internal argument (`--detached-child=<base64 JSON>`): the log file, and
`CC_DATA_DIR`, `CENTRALU_HOST_ENTRY` and `CENTRALU_MANAGED` when set, and `CENTRALU_STARTED_FROM` (the `--from` hub and the
ssh client's address the `--detach` saw, for `host.lock`, #1223). Never the token, which stays in `serve.json`.
The launcher writes `<data>/serve.log` (its own lines and the host's stderr until the host is ready; `host.log` has
the rest, so it stops growing; the three earlier starts' are kept as `serve.log.1` to `serve.log.3`, so the log of
the first of the at most three starts a hub makes by itself is still there, #1143) and `<data>/serve.pid`
(`{ pid, hostPid, port }`, removed when it exits). Its first line says how it was started and, on Windows, why not in
the sign-in (`started in the background through WMI: no Windows sign-in of this user was found (none of the 2 Explorers
in desktop sessions is this account's)`, or `the sign-in task failed: <reason>`, or that the task's host did not answer);
the reason travels in the same internal argument. A start through the task leaves one line of its own, written by
`--detach`, since the task's `serve` writes no `serve.log` (#1223); when that host does not answer, the line is removed
before the WMI start, so `serve.log.1` keeps the start before and a WMI start that never ran still shows as no
`serve.log`. A `serve.log` that cannot be moved aside is removed for the same reason.

`--detach` prints the connection line with `hostRunning: true` and `detach: { ok: true, how, already }`, or
`{ "v": 1, "detach": { "ok": false, "how", "reason", "message" } }`. `reason` is `wmi_blocked` when WMI refused, or
created a process that never ran (no `serve.log` within 10 s, or the process gone first); `exited` and `timeout`
(30 s) quote the end of `serve.log`. **A blocked start is said in one sentence naming the likely cause**: Microsoft
Defender's attack surface reduction rule "Block process creations originating from PSExec and WMI commands", off by
default and turned on by some managed machines. The hub then runs the host bound to its link (§4.8).

**A Node below the floor is refused before any host starts** (#699). The floor is `engines.node` of the npm package
(22.14.0), read by `bin/node-floor.mjs` and nowhere restated. The bundled better-sqlite3 declares Node-API 10, which
Node has from 22.14.0; under 22.12.0 (measured on Windows and on macOS) the module loads and then crashes on its first
`new Database`, with an access violation (exit 3221225477) or SIGSEGV, before the host writes a line. `centralu serve`
(foreground) and `--detach` therefore print one sentence on stderr that names the Node found, the floor and the two ways
out (update Node, or link the machine from a Centralu window, which installs a Node of its own there), and exit 1; they
download nothing. `--detach` also answers in its JSON line with `reason: "node_too_old"` and the `node` and `floor`
it found, which the hub reads (§4.8). `--connection`, `--stop`, `--rotate-token` and `--autostart` start no host and keep
working, so the hub can still read `install.node` from a machine whose Node is too old.

`--stop` asks the running host to stop over its own socket with the token (`host.stop`, [protocol.md](protocol.md)
§3), then waits up to 30 s for the port to close and the host's pid (from `host.lock`) to end. Only the host does its
shutdown that way on Windows: killing the WMI-started launcher ended the host 143 ms later with no "shutting down"
line (plan §10.4), because the host sits in libuv's kill-on-close job object. Only for a host that does not go (one
from before `host.stop`, a shutdown that hangs): SIGTERM to the launcher on posix, which passes it on, and on Windows
ending the host, said in the answer (`how: "ended"`). It signals only the pids `serve.pid` and `host.lock` name, and
only while the two agree and the host answered with this folder's token. It prints
`{ "v": 1, "stop": { "ok", "wasRunning", "how"?, "message"? } }`. A host refuses `host.stop` unless `serve` started
it (`CC_SERVE=1`): the app's host is stopped by the app.

**The managed launcher** (plan §10.1, S8). An install the hub makes over ssh (phase 3's next step) has its own
launcher at `<data>/remote/bin/centralu` (`centralu.cmd`), whose text never changes (`managedLauncherScript` in
`serve.mjs`): it reads `<data>/remote/current` ("<centralu version> <node version>", two plain words or it refuses)
at every start and runs that version's `centralu.mjs` on that version's pinned Node with `CENTRALU_MANAGED=1`. A
`serve` that sees `CENTRALU_MANAGED=1` leaves `<data>/bin/centralu` to an npm install on the same machine, and drops
the variable from the host's environment.

**Starting at boot: `--autostart`** ([plans/remote-hub.md](plans/remote-hub.md) §10.4, owner decision 4: offered per
machine, off by default; the hub's switch is §4.8). `centralu serve --autostart on` writes an entry that starts `serve`
when the machine starts, `off` removes it, `status` asks systemd or Task Scheduler and corrects the mark. Neither starts
nor stops a host now. The entry runs the launcher the hub's lookup would find (the managed launcher, else
`<data>/bin/centralu`) and carries `CC_DATA_DIR` when it is set; one entry per data folder (any but `~/.centralu` gets a
suffix from its path).

| Where | The entry | What it does not do |
|---|---|---|
| Linux with systemd | `~/.config/systemd/user/centralu-serve.service`, as above but `Restart=on-failure` bounded to five starts in five minutes; `daemon-reload`, `enable` (never `--now`: a second serve beside the running one would fail and be restarted), then `loginctl --no-ask-password enable-linger` | Where lingering needs an administrator, it starts at login, not boot; the answer says to run `sudo loginctl enable-linger $USER`. `off` leaves lingering as it is |
| Windows | A scheduled task "Centralu host (<user>)" for this user at their sign-in (`Interactive`, no administrator, no stored password), running `serve` in a hidden Windows PowerShell window, on battery too, with no time limit (Task Scheduler's default ends a task after 72 hours). `off` keeps the task and takes only its trigger: `--detach` starts the host in the person's sign-in through it (#1224). `remove` (uninstall) removes it. The user is in the name because Task Scheduler's root folder is one list for every account, and an administrator's ssh logon sees the others' tasks; an earlier version's "Centralu host" of this user is removed | Starts at sign-in, not before it (with automatic sign-in, that is boot) |
| WSL (interop on) | The same task, "Centralu host (WSL <distro>)", registered through `powershell.exe` on the Windows side; it runs `wsl.exe -d <distro> -u <user> --cd ~ --exec <launcher> serve`, which holds the distro for as long as the host runs | A unit inside the distro would never run: WSL stops a distro with no Windows client |
| macOS, Linux without systemd, WSL without interop | None: one sentence says so | — |

It prints `{ "v": 1, "autostart": { "ok", "on", "how", "linger", "message"? } }`. The task's PowerShell travels to
`powershell.exe` as `-EncodedCommand` on a command line of its own (CreateProcess, 32,767 characters), never through
ssh. None of the entries has been created on a real machine yet (plan §10.10, step 6).

**App views of this host, shown on a hub.** The hub's window never loads an address of this host: the hub asks
`apps.viewDocument` for an open instance (its app, its origin method and the app's raw `resources/read` answer) and
serves the view from its own door and its own per-app origin ports ([plans/remote-hub.md](plans/remote-hub.md) §11). This host
binds nothing for it, and its HTTP secret stays here. The other end, the host that links to this one, is §4.8.

A host refuses a client of another protocol with `version_mismatch` and close code 4002. The message names both numbers
and which side is older, so the person knows whether to update the app or the remote ([protocol.md](protocol.md) §1).

### 4.8 Remote mode, phase 1: the hub's links (#82)

The other half of §4.7: the host a window is attached to (the **hub**) links to the `centralu serve` hosts of other
machines and shows their sessions and projects as its own ([plans/remote-hub.md](plans/remote-hub.md); the protocol
side is [protocol.md](protocol.md) §6). Hosts talk only to hosts: the window still talks to one host, and each machine
stays the one writer of its own store. The code is `packages/agent-host/src/links/`.

**The pieces, as `main.ts` wires them.**

| Piece | File | What it does |
|---|---|---|
| Registry | `stored.ts`, store v46 `linked_machines` | The machines the person linked: id, name, ssh target, remote shell, the `slot` for folding numbers, the version pair accepted |
| Transport | `tunnel.ts` (`SshTunnel`) | Asks the remote for its connection line over ssh, then holds an ssh local forward |
| Link | `linked-machine-connection.ts`, `linked-machine-ops.ts` (`LinkedMachine`) | One per machine: transport, version check, client, backoff, status, the hidden-session set, the mirror's updates; and what the person asks of it (install, update, rollback, uninstall, autostart, activity) |
| Links | `links-registry.ts` (`Links`), `link-deps.ts`; `links.ts` re-exports them | Every link of this hub, added and removed with the registry, and the ssh hosts and probe |
| Client | `remote-client.ts` | The hub's WebSocket to the remote host: hello, cursor and epoch, calls, events, terminal frames |
| Router | `router.ts`, `routes.ts` | In front of `HostServer.onRpc`: sends a call to the machine its ids name, merges lists, answers the rest locally |
| Qualifier | `qualifier.ts`, `machine-ids.ts` | `<machine>.<id>` on the way in, stripped on the way out; numbers folded per slot |
| Mirror | `stored.ts`, store v46 `machine_headers` | Each machine's sessions and projects as last listed, for when it cannot be reached |
| Installer | `install.ts`, `registry.ts`, `remote-install.mjs` | `machines.install`: preflight, the pinned Node and the npm packages on the remote, checked against the release's pin and the registry's signed metadata (below) |
| Update | `update.ts` | `machines.update`, `machines.rollback`, `machines.uninstall`: stop the remote's host, switch its pointers, start and check, or put back (below) |
| Dev build | `dev-build.ts`, `remote-dev.ts` | `pnpm remote-dev <machine> --ref <commit> --repo <path>` (#1036): a dev build of the host made there from a commit, marked `source: { kind: 'dev' }`, swapped in by the update's steps ([plans/remote-hub.md](plans/remote-hub.md) §10.11). A command on the hub, no RPC |
| Autostart | `autostart.ts` | `machines.autostart`: `centralu serve --autostart` there, through the lookup (below) |
| Ssh config, probe | `ssh-config.ts`, `probe.ts` | `machines.sshHosts`: the hosts of this computer's `~/.ssh/config`; `machines.probe`: what runs at one of them, before it is linked (below) |

The three choke points of §5 of the plan are where it sits: the router is the `onRpc` the server calls, a link puts
the remote's events into `server.broadcast` (so they get the hub's own `seq` and replay) and its terminal frames into
the same lane as local ones. A host with no linked machine routes every call to its own handler, as before.

**The transport.** Two ssh commands, the person's own `ssh`, keys and `~/.ssh/config`:

```
ssh -T -o BatchMode=yes -o ConnectTimeout=15 -- <target> <connection command>
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o GatewayPorts=no -L 127.0.0.1:<port>:127.0.0.1:<port> -- <target>
```

`ConnectTimeout` only bounds the connection, so each asking ssh also has a deadline and a bound on its output
(`SshTunnel.run`): 60 s for the connection line, 120 s for starting the host (`serve --detach` waits up to 30 s for the host itself, and its own message is the better reason), 30 minutes for one installer, updater or
autostart step (the managed Windows install downloads about 30 MB of Node inside one step, which a slow link needs
minutes for). Past its deadline, or once stdout is longer than 1 MiB, the ssh is stopped and the call rejects. Of stderr
only the end is kept: 64 KiB for an asking ssh, 16 KiB for the forward, whose ssh lives as long as the link and carries
a link-bound host's log. Output is decoded as a stream, so a character split between two chunks stays whole. The
machine probe and `ssh -G` run through the same runner with their own deadlines (`runSsh`, `links/ssh-run.ts`). Every
ssh this host stops, at a deadline, at a forward that did not come up or at `close()`, gets SIGTERM and, 2 s later,
SIGKILL if it is still there (`endChild`).

**A machine with no host running is started** (plan §10.9, decision 7). When the connection line says
`hostRunning: false`, the link goes to `starting`, runs `centralu serve --detach` through the same lookup as the
connection command (§4.7), writes `[links] <machine>: no Centralu host is running there; starting one` and how it
went to `host.log`, and opens again. Nobody is asked: adding the machine was the consent (§3.2 of the plan). The row
keeps `hostStarted: { how, at, note }`. Where the remote answers `wmi_blocked`, the link falls back to a
**link-bound** host: from then on the forward's ssh runs `centralu serve` (found the same way) as its remote command
instead of `-N`, and the link reads the connection line until that host answers. It lives as long as the link
(Windows' OpenSSH ends the session's processes, and on posix the launcher takes the hangup as a stop), and the row
says so. A start that fails (Centralu too old for `--detach`, the host exiting while it starts) is `not_running`
with the reason, retried with the backoff.

**What the link does not start by itself** (#1143, owner decision 2026-10-19). Adding the machine is consent to start a
host that crashed or is missing, not one the person stopped:

- **The person's stop is remembered there.** `centralu serve --stop` writes `<data>/stopped.json` (`by: stop`), and
  so does a host that the desktop app's keeper stops for good when the person quits Centralu on that machine (Quit
  completely, or the last window closing with background mode off: `by: quit`, `lifecycle/stopped-mark.ts`). The
  desktop app shares the data folder with `serve` (`dataRoot()`); on Windows its window uses the folder's serve host
  (`--window`), which closing the window leaves running, so there is no quit to mark there. Every host that starts in
  the folder removes the mark: a start, by whoever, is the person's again. `--connection` reports it as
  `stopped: { by, at }` while no host runs. The hub's own stop (an update, a rollback, an uninstall) runs `serve --stop`
  with `CENTRALU_STOP_BY=hub` and leaves no mark.
- **The link starts at most three hosts there within 10 minutes** (`RESTARTS`), and then none until the person's Start,
  however long it waits: the limit is kept, not read off the starts again as they age out. A start at the person's
  Start counts too, so a Start whose hosts stop before they answer is not repeated for good, and so does a host that
  was started and never answered (`serve --detach` says `exited` or `timeout`: one that crashes at boot). A start
  where nothing could be started (ssh, no Centralu there, WMI refusing) is not counted: it is `not_running` with its
  reason, on the backoff, as before. A host that answered its hello and
  then stopped again at once used to reset the backoff at every hello and was started again about every 10 s for
  good. Now the backoff, and the limit, start over only once a host has stayed up 60 s (`STABLE_MS`).
- **Either way the row is `stopped`**, with `error` saying which, and the link starts nothing until the person's Start
  (the row's button, `machines.reconnect`) or the orchestrator's `reconnect_machine` with the person's card. It still
  reads the line on its backoff, so a host the person starts there is connected to; the row stays `stopped` while it
  does, and the reason is kept while the machine cannot be reached (`startHeldBack`, until a host runs there or a
  start goes through). The card is asked on that reason, not on the row's status of the moment, and without it the
  orchestrator's reconnect only opens the link (`reconnect { start: false }`). A Start pressed while the machine cannot
  be reached is spent, not kept for whenever it comes back. The `stopped` sentence after the limit ends with what the
  last start said when its host never answered. A machine whose Centralu predates the
  mark says no `stopped`, and is started as before, within the same limit.

**A machine whose Node is below the floor is switched to the hub's own** (#699). Before it starts a host, the link
reads `install.node` from the connection line; a machine that is not on a managed install and runs a Node below the
floor (§4.7) is installed on first, with the same `machines.install` path as a person's click: the pinned Node of
`remote-runtime.json`, checked against its SHA-256, and the hub's version from the registry. The same happens when
`--detach` answers `node_too_old`, or when it quotes a host that exited with 3221225477, `-1073741819` or SIGSEGV (a
launcher from before the floor existed). The link then opens again and finds the managed launcher first. The row says
so once, in `hostStarted.note`: "Centralu installed its own Node 24.21.0 on Box, because the Node on Box (22.12.0) is
older than 22.14.0, the oldest Centralu runs on." It is tried **once** until the link next connects: a host that still
fails on the Node the hub installed is reported as it is. Where the hub may not install (a development build, which is
not published; a machine that runs a command of the person's own; no installer), the row is `not_running` with the
floor named and a request to update Node there.

The connection command depends on the remote's shell (`MachineInfo.shell`), because `ssh <target> <command>` hands the
command to whatever login shell the remote account has:

| Shell | The connection command | Measured on |
|---|---|---|
| `posix` | `sh -c 'd="${CC_DATA_DIR:-$HOME/.centralu}"; m="$d/remote/bin/centralu"; if [ -x "$m" ]; then exec "$m" serve --connection; elif command -v centralu …; then exec centralu …; elif [ -x "$d/bin/centralu" ]; then exec …; else echo CENTRALU-NOT-FOUND; exit 127; fi'` | the fake ssh of `tunnel.test.ts`; the order by a real `sh` there |
| `powershell` | `powershell -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>` of the same lookup (`<data>\remote\bin\centralu.cmd`, then `Get-Command centralu.cmd` (the `.cmd` shim, never the bare name: PowerShell would pick the `.ps1`, which the default `Restricted` execution policy blocks, #688), then `<data>\bin\centralu.cmd`, the launcher `serve` keeps; `<data>` is `CC_DATA_DIR` there, else `%USERPROFILE%\.centralu`) | Windows 11, OpenSSH, PowerShell 5.1 (before the managed launcher was added) |
| `wsl` | The same PowerShell wrapper around `wsl.exe -d '<distro>' -- bash -lc 'echo <base64> \| base64 -d \| bash -l'`, the script being the POSIX lookup with `/mnt/*` taken off PATH | Ubuntu 24.04 in WSL2 on that laptop |

The managed launcher the installer writes (below) comes first, so a machine with both an npm install and one the hub
made runs the version the hub installed; a phase 1 machine finds `centralu` as before.

A machine can name its own command in place of `centralu` (`MachineInfo.command`): a source checkout, a data folder
other than `~/.centralu`. It runs as given, with no fallback.

**Picking a machine from the ssh config** (#514; `ssh-config.ts`, `probe.ts`). The Add machine dialog lists the
hosts of the ssh config of the computer the hub runs on, as VS Code's Remote-SSH does, so linking needs no typing.
Two calls, both additive and the hub's own:

- `machines.sshHosts` reads `~/.ssh/config` the way OpenSSH reads it: `Include` where it stands (globs sorted as
  glob(3) sorts them, a relative path under `~/.ssh`, `~/` expanded, nested at most 16 deep, a file that includes
  itself read once), `Host` lines with several patterns and quoted values, `#` comments, `Keyword=value`. Pattern-only
  and negated entries (`Host *`, `Host *.example`, `!bad`) are left out, and so are `Match` blocks, whose conditions
  only ssh can evaluate (one note says where they are). Each alias, at most 100, is resolved by `ssh -G -- <alias>`
  (8 at a time, 5 s each) for its `hostname`, `user` and `port`; `ssh -G` prints the configuration and exits before
  it loads a key. Only the config's text is read, by the host and never by the window; no `IdentityFile` is opened.
  Each host carries the machines already linked through that alias (`linked`), and the window reads it again each
  time the dialog opens: no watcher.
- `machines.probe { sshTarget }` runs one BatchMode ssh (`ConnectTimeout=10`, 30 s in all) with one command:
  `powershell -NoProfile -NonInteractive -EncodedCommand <base64>`, about 1,640 characters. That line means the same
  to the three shells an ssh command can land in: cmd.exe (Windows OpenSSH with no `DefaultShell`) and PowerShell
  both start PowerShell, and a POSIX shell has no `powershell` and answers exit 127. The script only reads the
  registry: `HKLM\SOFTWARE\OpenSSH\DefaultShell` (where OpenSSH itself reads the shell it runs a command under; empty
  is cmd.exe) and the WSL distros under `HKCU\...\Lxss` with `DefaultDistribution` (where `wsl.exe -l` reads them).
  The answer (`MachineProbe`) is `posix`, or `windows` with `windowsShell` (`cmd`, `powershell`, `pwsh`, `other`)
  and the distros (docker-desktop's own left out), or `reachable: false` with ssh's last line (a key refused, a host
  key not known, a name that does not resolve, a timeout), or reached but not recognised.

Measured on a Windows 11 PC over Tailscale (2026-10-12, cmd.exe default shell): the probe answered in 1.15 s with
`platform=Win32NT`, an empty `DefaultShell`, `Ubuntu` as the default distro and `docker-desktop`; PowerShell 5.1 wrote
its "preparing modules for first use" progress to stderr as CLIXML, which is not read.

| Decision | Why |
|---|---|
| The probe is the PowerShell line for every shell, and POSIX is told by exit 127 | No one line runs a program in cmd.exe, PowerShell 5.1 and sh alike: `&`, `&&` and `\|\|` are parse errors in PowerShell 5.1, and `;` is not a separator in cmd.exe. The `-EncodedCommand` line is the one every Windows command already crosses on (above), and 127 is POSIX's "command not found" (csh's own words are read too) |
| The distros come from the registry, not `wsl.exe -l` | `wsl.exe -l` writes UTF-16, and it starts the WSL service; the registry is where it reads them, and reading it starts nothing |
| The host reads the config, `ssh -G` resolves it | The window has no file access; `ssh -G` applies everything a hand-written reader would get wrong (`Match`, `CanonicalizeHostname`, defaults), and connects to nothing |
| The probe runs when a host is picked, not for every listed host | One ssh per host the person chose, never a sweep of every machine in the config |

**Installing on a machine** (phase 3, plan §10.2; `install.ts`, `registry.ts`, `remote-install.mjs`).
`machines.install` installs the hub's own version there over the same ssh, in three remote commands, each a script for
that machine's shell sent the way the lookup is (base64 to `sh`, to `bash -l` inside WSL, `-EncodedCommand` to
PowerShell):

| Step | What runs there | What the hub does |
|---|---|---|
| 0. Preflight | Prints one `CENTRALU-PREFLIGHT` line: `uname`, `getconf GNU_LIBC_VERSION`, musl, free space where the data folder is, `tar`, `gzip`, `curl`/`wget`, a SHA-256 tool (Windows: architecture, `tar.exe`, `curl.exe`) | Decides (`preflight`): glibc 2.34 or later, no musl, a published platform, the tools, 600 MB free (300 on Windows); otherwise one sentence and nothing is downloaded |
| — | — | Reads `centralu@<v>` and the host's package from the npm registry and checks each `dist.signatures` against the registry's keys (`/-/npm/v1/keys`, unexpired), as `npm audit signatures` does. The host's package is `@centralu/host-<platform>@<v>`, the host alone ([releasing.md](releasing.md) "Host-only packages"); only when the registry answers 404 for it (a version published before those packages) is it `@centralu/<platform>@<v>`, the platform package with the window in it. Any other failure on the host-only package refuses |
| 1. Node | Downloads the pinned archive from nodejs.org, compares its SHA-256 with the one the hub sends from `remote-runtime.json`, unpacks it with the system's tar (`System32\tar.exe` on Windows) into a `.partial-node-*` folder, keeps only `bin/node` (`node.exe`) and `LICENSE`, and renames it to `<data>/remote/node/v<N>/` (on Windows, a rename refused while an on-access scanner holds the `node.exe` just run is tried again for up to 15 s, #368) | Sends the archive's name and hash; reads `CENTRALU-INSTALL node ok` or a failure code |
| 2. Centralu | `remote-install.mjs`, written there gzipped in base64 and run on that Node: takes `install.lock`, fetches both tarballs, refuses any whose sha512 is not the integrity the hub sent, unpacks them in npm's layout into `.partial-<v>-<pid>/`, drops the AppImage or `centralu.exe` when the host came in the platform package, writes `install.json`, renames the folder to `versions/<v>/` (a folder already there, the same version with other bytes, is moved aside first and removed only after the new one is in place), writes the managed launcher if there is none (`managedLauncherScript` from that version's `serve.mjs`; never rewritten), moves `current` to `previous` and writes `current`, each by a rename over the file, and removes versions and Nodes neither names | Reads `CENTRALU-INSTALL done <json>`: `current`, `previous`, what was removed and what could not be (a Windows program running from it) |

A script too long for a Windows command line (step 2's, about 17,000 characters of stdin) goes on the command's stdin as base64 and
then a line holding one dot (#1360). The PowerShell reads the bytes from `[Console]::OpenStandardInput()` up to that line,
says `CENTRALU-STDIN-READY` when it starts and `CENTRALU-STDIN-OK` when it has the script, then runs it; it does not wait for the
end of input, and it does not use `[Console]::In`, whose `ReadToEnd()` never returned in a share of the runs on Windows OpenSSH
(docs/runtime-lessons.md RE18). `exec` waits for the first line for 2 minutes (`stdinReadyMs`: ssh's own connecting has its allowance of six attempts,
`SSH_CONNECT_ALLOWANCE_MS`, on top of 30 s for PowerShell starting; a failure there is not retried) and for the second for 30 s
after it (`stdinAckMs`). The reader gives itself 20 s from the first line (`STDIN_READER_MS`): past it, or when the input is cut,
it exits with 4 and prints nothing more, also when the whole input comes late, so it is gone, or never ran the script, before the
hub's 30 s are over, and a failed step leaves no PowerShell behind. A reader whose process is already older than 30 s when it says
it runs (`SSH_POWERSHELL_START_MS`; a PowerShell that came up after the hub's wait, the input waiting in its pipe) reads nothing and
exits with 4 too. When PowerShell was up and the input was not read, the step
has not started, so it is sent once more (only when the reader itself ended, with 3 or 4, or no confirmation came in 30 s; a dropped link
after READY is "ssh could not reach" and is not sent again), and a second failure says so with "PowerShell on <machine> did not confirm within 30 seconds that it had read this step's input, so the step did not
start, twice". The step's own limit (30 minutes) is then only for a step that runs.

The remote prints codes, the hub turns them into sentences (`node_hash`, `integrity`, `download`, `busy`, …); exit
codes are not read, as for the lookup. `install.lock` is a folder made with `mkdir`, then its `pid` and a `token` of
the run: a lock found without a pid is held while it is under a minute old (its installer is between the two), a lock
whose process is gone is moved aside before it is removed (so two installers that both found it stale do not both
take it), and an installer removes the lock only while its `token` is still the one inside. A host running there is not touched: the old version becomes `previous` and
keeps its folder, and the next start runs the new one. When the link is not connected the hub opens it again at once,
and the lookup finds the managed launcher. A development hub refuses (its version is not on npm), and so does a
machine with a command of its own.

**Updating, rolling back and uninstalling** (phase 3 step 4, plan §10.5; `update.ts`). Each is one call
(`machines.update`, `machines.rollback`, `machines.uninstall`, additive) that answers when it is done or failed; its
steps arrive meanwhile as the machine's `operation` (`{ kind, step, target, at }`, additive) in `machine_status`, and
the row's status is `updating` (additive; an older window reads it as unreachable) while the host there is down. One
at a time per machine, and the remote's `install.lock` guards the files.

| Step | Update | Rollback | Uninstall |
|---|---|---|---|
| Install beside | `machines.install`'s steps with `activate: false`: the new version lands in `versions/<v>/`, nothing points at it, nothing is removed, and no launcher is written yet, so the lookup still finds what runs | — | — |
| Wait | **Until no session there is in a turn** (#1399): `HostControl.beforeStop`, after the install beside and before anything is held or stopped, reads `host.activity` every 15 s and goes on once working, approvals, questions and background work are all 0 (terminals and project commands stay open for hours and are not waited for). The row's operation says `wait_idle` meanwhile, and `machines.cancelUpdate` (or an orchestrator's cancelled call) ends the wait: the update fails saying it was cancelled and nothing was switched. `when: 'now'` (the person's choice) skips the wait, the answer's `note` says how many sessions' turns it ended (and how many terminals and project commands closed), and the next host continues those turns (below, #1618). Once a reading says none, it is read again about 3 s later, right before the host is held and stopped (the stop takes seconds, and `host.stop { ifIdle }`, which would be atomic, counts terminals and commands too). A machine that cannot be asked at all (a host from before `host.activity`, a link held on another protocol) is not waited for, and a machine none of whose readings has succeeded is read again twice, then not waited for either (waiting on what was never seen would never end). Once one reading has succeeded, a failed one proves nothing (a busy or dropped remote fails them too), so the wait goes on through failed readings, the row saying `wait_unread` ("it cannot read what runs there now"), and the host is stopped only on a successful reading of no session in a turn, the second one too; Cancel and `when: 'now'` are the ways out. `MachineInfo.updateWaits` (set by every hub that waits) lets a window promise the wait: an older hub sends nothing and stops at once, so the window words the plain Update there. When `install_machine` has answered "still under way", how the update ends is told to the orchestrator as a message in its conversation, a failure too. Removing the machine or stopping the hub ends the wait ("nothing was switched"). The wait is not kept across a restart of the hub (the version stays installed beside, harmless). `pnpm remote-dev` (`dev-build.ts`), rollback and uninstall do not wait. An older hub ignores `when` and stops at once; an older window shows the step as `wait_idle` and has no Cancel. `install_machine` (update) answers after about 200 s that the update is still under way, since a tool call that long is cut by its caller while the update goes on; the window's `machines.update` has the long call budget, and a wait that outlasts it is the row's to show | — | — |
| Hold | The link stops reconnecting and starting a host of its own (Reconnect included) until the check; it would otherwise start the old version between the stop and the switch | the same | the same |
| Stop | `centralu serve --stop` through the lookup: the running version stops itself in order (§4.7). Not stopped: the call fails and nothing is switched | the same | the same; not stopped, nothing is removed |
| Boot entry | — | — | `serve --autostart remove` through the lookup (§4.7), after the stop; `off` of a serve from before `remove`, where `off` removed the entry. Not removed: nothing is removed. A version older than `--autostart` is passed by (it cannot have written one from here) |
| Switch | `remote-install.mjs` with `action: 'pointers'`: `previous` = the old `current`, `current` = the new one, each by rename; the launcher is written now if there is none. The stop before it was `serve --stop` with `CENTRALU_STOP_FOR=update`, so the host it stopped wrote the turns it ended to `<data>/update-resume.json` (#1618, below) | `current` = `previous`, `previous` removed: one step back only | `<data>/remote/` removed, by a script per shell (a running `node.exe` could not remove itself) |
| Start | `serve --detach` (`Tunnel.startHost`) | the same | — |
| Check | The link opens again; only a hello whose `build.version` is the target ends it, within 30 s | the same | — |
| After | Success: `action: 'prune'` removes what neither pointer names. Failure: the end of `host.log`, `serve --stop` again, the old pointers back (none, after a first update over an npm install: then the launcher goes too), the old version started if one was running, and the call fails with that sentence. That stop is for an update too: the turns the new host had not continued, and those it was running, stay listed for the version put back (one from before #1618 ignores the list) | Failure: the same, towards the version it left | The link opens again and finds what is left (an npm install, or nothing) |

**Following the hub** (#1508, owner 2026-10-24). While the hub's "Automatic updates" are on (`updates.autoApply`;
`LinkDeps.autoUpdate`, which main.ts reads as off while the hub drains for a swap), a linked machine on an older release
of the hub's channel follows the hub's version with no one's click: one switch covers both. The condition is
`LinkedMachine.followsHub` and lives there only: automatic updates on, the hub can update the machine (`operationRefusal`),
the person did not remove what the hub installed there, neither side runs a local build (`<base>.local.N`), and
`versions.older` is `remote`. Versions of two channels are never ranked, so a stable machine does not follow a beta hub.

- **When.** At every connect (`connectedNow`, after the hello and the lists): that is also how the hub's own update
  reaches its machines, since the next host links again and finds them older. And when the person turns automatic
  updates on (`updates.setAutoApply`, `Links.followHub`), for the machines already connected.
- **What.** The same update as `machines.update { when: 'now' }`, marked `unasked` (`LinkedMachine.stopAtOnce`): it does not
  wait (owner, 2026-10-26, #1618). It used to wait for the turns there (#1399) and for terminals and project commands
  (`OPEN_WORK_WAIT_MS`, #1579), and a machine always busy never updated: two machines were held for hours (#1614). It
  reads what runs there once, right before the hold, for the answer's sentence, and stops the host: the turns running end
  and are continued by the next host (below), and terminals and project commands close. It stops no host it cannot ask what runs (a Centralu from
  before `host.activity`, or one whose reading fails, tried again twice): that is read before anything is installed and
  again before the hold, and the update fails, nothing switched, the row saying to update from Settings. A swap that comes
  after the hold finds it as it finds the person's update (§4.7). The `wait_open` step is no longer shown by this hub;
  a window keeps its words for an older one.
- **How often.** Once per version of the hub's, and once more 10 minutes after a failure (`FOLLOW_RETRY_MS`); an update
  of this hub's from before #1618 could also be cancelled while it waited, which spent the version. Every update nobody approved counts as a try for
  the hub's version, the hub's own and an agent's card-less one alike (`unaskedRun`). A spent version (both tries failed)
  makes `followsHub` false, so an agent cannot start it again without a card. A retry whose time comes while the
  machine is busy or away runs when that ends or at the next connect. A failure shows on the row as `MachineInfo.followHub`
  (`{ version, failed, retryAt }`, additive and optional) while the machine is still behind, and its steps show as any
  update's do.
- **Not covered.** A machine on another protocol is held at `versions_differ`, where neither its hello nor what runs there
  can be read, so it stays the person's to update (no protocol bump has happened yet: `PROTOCOL_VERSION` is 1).
- **An agent's call.** A limited caller's `machines.update` with `when` `idle` or absent runs without a card when
  `followsHub` holds (transport/method-rights.ts `RightsHost`, security-boundaries.md "Who holds full power"); the
  transport judges it once and tells the handler (`RpcContext.covered`), and the orchestrator's `install_machine` (update) goes without its card on the same check; both run `unasked`.

**Starting a machine's host at boot** (plan §10.4, owner decision 4; `autostart.ts`). `machines.autostart { machineId,
on? }` (additive) runs `centralu serve --autostart on|off|status` there through the lookup, and the Centralu found
writes, removes or reads its own entry (§4.7); without `on` it only reads. The row's `autostart` (`MachineInfo`,
additive) comes from the connection line at every link start and from the call's answer; a remote that predates it
says nothing, and the window shows no switch. Nothing starts or stops, so nothing is asked first and the link is not
held. Refused while an install, update, rollback or uninstall runs there, and where the hub has no shell on the
machine. Only the lookup crosses ssh, as short as `--connection`'s, so it fits cmd.exe's line.

What would stop is asked of the remote first: `machines.activity` calls the remote's `host.activity` (additive), which
counts what `hostBusy` counts (`activityCounts`, idle.ts): working sessions, approvals and questions waiting,
background work, terminals and running commands. While the link is held at `versions_differ` on one protocol (before #689) it asked
over a short connection of its own. A remote that predates the call answers nothing, and the prompt says "anything
running". No remote runs a keeper today (plan §10.4), so on Linux and Windows an update ends the agents there; their
sessions resume on the new host through their stored ids, as after any restart, and the turns it ended are continued.

**Continuing the turns an update cut** (#1618, owner 2026-10-26). An update that does not wait (the person's `now`, and
every update nobody approved) ends the turns running there; the host it starts takes each of them up again, once, the way
the person's Continue would.

- **Which.** One definition, recorded by the host that stops, at the moment it stops: the sessions in a turn as it lets
  its sessions go (`cutTurns` in idle.ts: working, or waiting on an approval or a question, `turnCut`), read in the same
  step as their processes end and after it took its last call (`SessionManager.disposeAll`). So a turn that began after
  the hub read what runs is listed too, and a person's Stop the host took before it stopped leaves its session out.
  Background work alone is not a turn and is not continued.
- **Told it is an update.** Every stop of the hub's after which a host starts again in that folder (the update's, the
  put-back's after a failed check, a rollback's; not an uninstall's) runs `serve --stop` with `CENTRALU_STOP_FOR=update`
  (`stopCommand`, `stopRemoteHost`), which the launcher passes on as `host.stop { forUpdate: true }` (additive). The host
  then writes the ids to `<data>/update-resume.json` (`{ v: 1, ids }`, lifecycle/update-resume.ts), added to what is
  already listed there. A host the launcher could not ask (it is ended instead), a stop of the person's, or a host from
  before #1618 writes nothing, and its turns end as a stop's always did.
- **Taken once each.** The next host to start in that folder reads the list before it builds its sessions, without
  taking it. Each id leaves it only once dealt with (`dropFromUpdateResume`): its Continue went in, its loss was reported,
  or the start did not find it cut. A host that stops before then (its check failed and the update puts the old one
  back, a second update, a rollback) leaves the rest listed and adds the turns it cuts itself, the continued ones
  included, so the host after it continues them. Nothing expires: the list is the next start's, whenever it comes, on
  that machine's own clock. A file of another format continues nothing.
- **Continued.** A listed session the start finds mid-turn with no process stays `working` (no "stopped" mark, no quit
  notice), its owed report and its delegated turn kept as a kept process's are, and once the start is done it is woken
  and given Centralu's note through Centralu's channel (`deliverMail`, no message of the person's): "Centralu on this
  machine was updated while your turn was running, which stopped the turn before it finished. Continue where you stopped.
  Check what already happened before repeating a step." Until the note is in, a wake from elsewhere (a window that sees
  the machine back) keeps the turn's state (`RestartPolicy.continuingTurns`), so a hub reading the machine meanwhile does
  not read the turn as ended, and the note goes in once. A window does not wake a session that is in a turn with no
  process at all: the machine continues it, and "<machine> is back, resuming N sessions" counts only what the window
  wakes. The conversation shows "Centralu was updated during this turn, which stopped it; Centralu continued it on the
  new version."
- **The stop keeps what is owed.** A quitting host's failed delegation waits no longer settle the child's report or
  turn (`DelegationFlow`, `closing`): the next start decides, from the marks the store kept, whether the turn is told as
  stopped (a quit) or continued (an update). Work the person owns gets no "stopped" report in their Inbox; its one report
  is the continued turn's end.
- **Not continued.** A session that is not mid-turn when the host stops: the person stopped it and the host took the
  Stop, it was archived or deleted. A Stop still on its way when the host stops is not taken: that session is listed and
  continued. A session whose turn had ended but whose background work (a dev server, a watcher) still ran loses that
  work with its process and is not continued: nothing was in a turn to continue. One whose tool cannot take it up again
  ends as a kept process that could not be re-attached does (`turnLostInSwap`): `quit`, and its report or its requester
  told it stopped.
- **Its caller.** A requester on the same machine hears once "The assigned work's turn was cut short by an update of
  Centralu on its machine, and Centralu continued it there on the new version", with whether its report still follows
  (`ChildReports.tellCutByUpdate`, outcome `resumed`, the thread kept running); a requester continued itself is not
  told, its own note covers its children. A caller on the hub (a child start_agent made there) is not told that the link
  dropped while the hub's own update or rollback holds the link, from its first step until the link is back
  (`RemoteAgents.updateHolds`), when the machine's host is one that continues cut turns. The new host's `hello_ok`
  names the turns it continued (`updateContinued`, with when, on its clock); once the link is back and the child is in
  its turn again and named there, the caller hears once that the update cut the turn and Centralu continued it. An
  update that ends with the machine not back lets the link go, and the drop is told then. Either way the report it is
  owed is the continued turn's end: one report, never "finished" for the cut.
- **What it does not cover.** A child on the machine found at rest when the link is back after it could not be
  continued is reported as at rest, as before: neither `host.sessions` nor the hello carries the loss (one whose
  continued turn ended meanwhile is reported finished, which it is). A machine whose host predates #1618 lists nothing as
  it stops; the hub's sentence then says the turns were lost, and a caller on the hub hears the drop as before.
  `pnpm remote-dev` (`dev-build.ts`) stops at once and continues nothing.

| Decision | Why |
|---|---|
| The fallback to the launcher is decided on the remote, in one command, and "not found" is a word on stdout | Exit codes do not survive Windows: OpenSSH runs the command under PowerShell, which turns any failure into 1. Measured: a 127 from WSL or from PowerShell itself arrived as 1, and a missing command inside WSL arrived as 0 |
| Everything but plain words crosses PowerShell as base64 | PowerShell 5.1 re-parses quotes, and mangles a double quote passed to a native program; base64 is letters, digits, `+`, `/` and `=`, which no layer touches |
| A WSL lookup takes `/mnt/*` off PATH | WSL appends Windows' PATH, and Windows' npm folder has a `centralu` shim: measured, `command -v centralu` in the distro named `/mnt/c/Users/<me>/AppData/Roaming/npm/centralu`, the Windows install |
| The WSL forward runs `wsl.exe -d <distro> --exec sleep infinity` instead of `-N` | WSL stops a distro about 15 s after its last `wsl.exe` client exits, and its services with it. Measured: `centralu serve` under a systemd unit was stopped 19 s after it started, with no client attached; a forward to Windows' sshd alone never holds the distro |
| Both ends of the forward bind 127.0.0.1, `GatewayPorts=no` | Nothing on either machine's network can use the link |
| The same port number on both ends when it is free here, another one otherwise | The number reads the same in both machines' logs. Nothing depends on it since phase 2: the hub serves a linked machine's app views on its own port (plan §11). Two machines on the default 17175 cannot both have it |
| `BatchMode=yes` everywhere | A password or host-key prompt nobody can answer would hang the link. The person sets the keys up once, as for any ssh use |
| The token is not stored; it is asked over ssh at every link start | It is the key to every RPC on that machine. One ssh round trip per start (measured 2.1 to 4.3 s to connected on a LAN) is cheap |
| The ssh processes are children of the hub host, behind the `Tunnel` interface | Probe 4 of the plan (§10.6, 2026-10-08) measured the alternatives across real hub swaps: the link is away about 1.1 s per swap as it is, 0.8 s with OpenSSH `ControlPersist` (which leaves a forward behind per swap and outlives "Quit completely"), and would be about 0.14 s as a keeper child. The remote's agents never notice a hub swap, so it stays here |

**The link's states** (`MachineInfo.status`, sent as `machine_status`): `connecting`; `connected`; `away` (#1398: the
machine does not answer at all: ssh's connect timed out, there is no route, or the name does not resolve (`links/away.ts`, ssh's own
words, on the whole last line of an exit-255 failure, so a program on the remote that prints "timed out" does not make a machine away, and a
banner exchange that timed out, which something answered, stays an error); asleep, off or off the network, not an error. `error` keeps ssh's
line for the details; `lastConnectedAt` says when the link was last up, the moment it dropped and not its hello, kept in the store
(`app_settings`, `links.lastConnected.<id>`, no migration step) so it survives a restart of this host; and `nextAttemptAt` when the hub
tries again, told to the windows at each attempt although the status does not change. The status stays `away` between the backoff's attempts
instead of flipping to `connecting` and back; the person's Connect shows `connecting`, also when it joins an attempt under way, and so
does the first attempt ssh gets an answer to. The row (Settings → Machines) says "<name> is not reachable: asleep, off or off the network",
then when it was last connected and when it tries again, then ssh's line; the sidebar's status word stays "away" for it and for `unreachable`. Retried on the backoff below while Auto reconnect is on; with it off, `nextAttemptAt`
is null); `unreachable` (the machine answered or was linked and then failed: an ssh it refused (a key, a host key, a refused connection), a
link that dropped, the forward or the socket; `error` says why; retried with backoff from 2 s to 5 minutes while Auto reconnect is on, #1134, #1341; with it off, not until the person's Connect); `starting` (no host ran
there; the link is starting one, above); `updating` (the hub is stopping, switching or removing the Centralu it installed there; the link waits, above); `not_running` (Centralu answers there but no `centralu serve` runs, and
starting one failed, `error` says why; retried); `versions_differ`; `refused` (a token refused twice in a row:
the connection line is read again once at once, since `--rotate-token` changes the token a running serve keeps until
it restarts); `disconnected` (#1134: closed on purpose and not tried, below); `stopped` (#1143: the person stopped
Centralu there, or the hosts the link started kept stopping; the link starts none until the person's Start, above).

**Auto reconnect** (#1341, owner decision 2026-10-20; `MachineInfo.autoReconnect`, kept in the `linked_machines.connect`
column of v59 with no new step: null is on, `when_needed` is off, which is where the older connect mode kept its choice, so
a machine set to "when needed" reads back with the switch off and a build still serving during a host swap reads the same
value as it always did; a later release may add a column named for the switch and drop this one, add first and remove
later). One switch per linked machine, on by default; it replaces the connect mode (`at_start` / `when_needed`, #1134).

*On* is what every machine did before: connected when the hub starts and tried again after every drop, on the backoff (2 s,
doubling to 5 minutes), so an orchestrator working through it hears reports and cards as they happen.

*Off* is for a laptop that is often closed or a server used once a week: the hub tries **once** when it starts. After a
failed attempt, or a drop that the quick redials do not undo, it tries nothing more until the person presses Connect
(`machines.reconnect`: Settings → Machines, or the machine's badge menu in the sidebar). The quick redials stay (owner
decision): after a drop the client dials the same forward again a few times (`LINK_REDIALS`, about 6 s, no new ssh), so a blip
or a host swapped in place is back with no Connect; only when they fail does the link give up, close the forward and wait.
`LinkedMachineConnection.retryLater` does nothing for it, and the row says `press Connect to try again` where it says
`reconnecting` for a machine with the switch on. The one thing it still does by itself is look again at the versions of a
link held at `versions_differ` (every 60 s): it only reads the connection line, refreshes the row, and connects nothing
(`readsOnly`). Turning the switch off while connected leaves the link up; turning it on while the link is away tries again
at once. An attempt under way at the person's Connect, or the one immediate re-ask after a refusal, is part of that attempt
and goes ahead either way.

Nothing connects a machine on a need any more (`machines.need`, `NEED_HOLD_MS`, the idle disconnect and the 60 s wait of
`linked-sessions.ts` are gone). An agent's call that needs a machine nothing here will connect (the person disconnected
it, or its switch is off and the attempt at the hub's start is over: `LinkedMachineConnection.waitsForPerson`) is answered
at once: `start_agent` with the machine, `ask_project` on one of its projects, `agent_session`, a send to or a read of
one of its sessions say "is not connected, and nothing here connects it by itself; ask the person to connect it (Settings,
Machines, Connect)" (`NOT_CONNECTED` / `awayPhrase`, `adapters/contract/orchestrator.ts`), and its projects are listed as
away with that reason. A machine with the switch on that is away between attempts is not waited out either (#1532): a call that
needs it starts one attempt at once, `LinkedMachineConnection.reachForCall` through the same `connect` that the row's Connect,
the badge's menu, the project menu's Reconnect and the orchestrator's `reconnect_machine` use (`keepBackoff`: the backoff goes on
from the step it was at instead of starting over, and a call starts no host the link would not start by itself), and waits for it
(or for the attempt it found under way) at most `CALL_WAIT_MS` (10 s) from the moment it asks. Connected in time, the call goes through; not, it is answered "not reachable right now; the attempt to
connect it just now failed: <ssh's words>" (or "an attempt to connect it is still under way"), and the backoff stands. One attempt at a time per machine:
a call that finds one under way (the backoff's, the person's press, another call's) waits on it and starts none, so a press and a
call at the same moment make one attempt. Calls cannot defeat the backoff: a machine takes at most one attempt started by a call
per `CALL_WINDOW_MS` (15 s); a call inside the window is answered at once with the last attempt's reason. The calls are those that
reach the machine through `linkedSessions` (`start_agent`, `ask_project` and `create_session` through their project lookup, but
only for the machine the act needs: `start_agent`'s `machine`, or the one a project name, qualified id or `machine/name` points to
(`projects(need)`); a lookup never waits on another machine, nor on an attempt to one, with one exception (#1547): a bare name that matches no project at all (not on this computer, not on a machine that is up, not in any machine's mirror, which is empty after a restart and cannot know a project made since) tries every machine that is down, within the same bound (`ProjectNeed.anyDown`, asked by `ask_project` and `create_session` after their first lookup found nothing; the machines that are up are not asked again, their rows are the first answer, `prior`), and only then answers "No project named" (`create_session`: "No such project"), naming the machines it could not ask. A machine is waited for once per its call window (`callWindowMs`, 15 s) that way, counted from the guess whether it started an attempt or only joined one under way: a call inside the window joins the wait if it is still going, or is answered at once, without joining an attempt under way as `reachForCall` would. A name qualified with a machine or hub is answered by the first lookup alone, and the machines that did not answer stand as it held them. `create_session` names a project by the same match as `ask_project` (`matchProjects`: id, exact name, `machine/name`, the name in any case), over this computer and the machines, and says which machines it could not ask; a qualified name speaks only of its own machine (`awayFor`, which tells a machine's id from a bare name by the machines the lookup saw, `ProjectLookup.machines`, not by their projects), and the name is trimmed as `ask_project` trims it. The answer waits for the slowest of the down machines, since a same name on another one would make the choice ambiguous. A name qualified with a machine or hub never widens to the others; `agent_session`, a send to or a read of one
of its sessions) and the router's calls that have no window behind them (no `ctx`: an agent's, an app view's);
a window's own calls start nothing, they poll. Not for a machine that waits for the person, one whose host the person stopped
there, one at `versions_differ` or `updating`, or one held by an operation. What a child there reported meanwhile is read once the
link is up again. A parent waiting on a child whose turn is running is
told when the machine starts waiting for the person (`LinkedReports.linkChanged`: a link-lost report saying Auto reconnect is off and to ask
the person to connect it), judged by the link itself (`waitsForPerson`, sent with the `machine_status` of the moment it gives up) and not by
the row, which says `unreachable` while the client still redials, an attempt is under way or an install or update holds the machine: the
wait stands through those.

Its sessions keep running there meanwhile; on the next connect the window re-reads that machine (`machine_resync`) and
with it what they said. The row's Disconnect closes any link without unlinking the machine and tries none until Connect or
the hub's next start, with the switch on or off. An install, update or autostart change on a disconnected machine connects
it first, since it runs over the link's ssh, and leaves it up. `machines.need` is still accepted for one release and
answers the row, so an older window does not fail, and `machines.setConnect` still sets the switch (`at_start` is on). A
build from before it reads the column as the connect mode, so it connects a machine with the switch off only when something there
needs it; an older window reads `disconnected` as `unreachable` and shows no setting.

**Versions are checked before connecting** (plan §4). The connection line carries the running remote host's `version`
and `protocolVersion`, and the hub compares them with its own before it opens the socket, and again with
`hello_ok.build` once it does. Another protocol never connects and holds the link at `versions_differ`. One protocol
connects whatever the app versions (#689): a different version of the same channel only names the older side, and the
row *offers* the update (the hub's through its own update, the remote's over ssh by `machines.update`) without
holding anything. A dev build has no older side. A local build (`<base>.local.N`) is compared as `<base>`. The update itself is the next step: the hub's through its own update, the remote's by hand in phase 1
(`npm i -g centralu` there) and over ssh in phase 3.

**After connecting**, the link reads the remote's `sessions.list` and `projects.list` into the mirror, notes which
sessions it hides (the remote's orchestrator and coordinators, §3.4 of the plan), and broadcasts `machine_resync`; the
window re-reads that machine and wakes what died. The link keeps one cursor and epoch per remote, so a dropped socket
gets the gap replayed, and a remote that restarted is a new lifetime and a resync. Events of sessions the hub does not
show are dropped, and session events keep the mirror's names and states current between reads.

**The reverse direction is off** (plan §3.2). The link is a client connection the hub opened. The protocol has no
frame for a host to call its client, and `RemoteClient` drops anything shaped like a request without dispatching it
(`remote-client.test.ts`), so a compromised remote cannot reach the hub through the link.

**The orchestrator reads every machine** (phase 4 step 1, [plans/remote-hub.md](plans/remote-hub.md) §12.3;
`linked-sessions.ts`). The hub's central orchestrator's `list_sessions`, `read_session` and `recall` include each linked
machine's sessions, asked of that machine with `host.sessions`, `host.readSession` and `host.recall` (additive), which
it answers with the orchestrator's own code over the view the hub's window has (`SessionManager.hostReader`: no
orchestrator or coordinator; at most 200 lines and 50 hits per call). The hub qualifies the ids, names the machine on
each row and hit (`project api on Ubuntu box`), lists a machine it cannot ask from the headers mirror with why, and says
which machines it could not search. What a machine answers is fenced as a worker's text is (#121): names on one line,
ids that are not ids dropped, a conversation line that is not one line quoted. A manager, a lead and an ordinary
session keep their own machine's view.

**And directs them** (phase 4 step 2, plan §12.4). `send_to_session` goes to the machine as `host.send` (additive),
delivered there as an instruction from `<orchestrator> on <this computer>`; with `reportBack`, `observeLinked` watches
the machine's relayed events for the end of that turn and reports it as for a session here, a turn that ends with the
session's own background work running included (§1.2.1 step 7, #723). The watch starts at the instruction's own
`user_message` there (#1082): a turn end relayed before it happened on the machine before the instruction was in, and
is an earlier turn's. A record lost before it was relayed is not waited for past the send's answer: the machine's events and answers come in order on one link, so from that answer on the next turn end reports, as before.
`update_session_settings` and `create_session` go through the router (`agents.updateSettings`,
`agents.createSession`), a project found by name or qualified id on any reachable machine, a name two machines share
refused with the ids. `create_session`'s first message goes as `send_to_session`'s instruction, its turn's end
reported the same way unless `reportBack` is false (#1233). `create_project { machine }` raises the same card, naming the machine (`project_create`'s
`machine`, additive), with the path that machine's `projects.createPreview` gives, and has that machine make it.

**Measured through the hub** (probe 3, 2026-10-05; a MacBook on Wi-Fi, the remote a Windows 11 laptop on the same
LAN; `centralu serve` of main in WSL2 and of beta.10 on Windows):

| | WSL2 Ubuntu | Windows (PowerShell) |
|---|---|---|
| Link to connected | 2.1 to 4.3 s | 2.3 to 3.7 s |
| RPC round trip through the hub, median / p95 | 5.4–12.8 / 7.7–36 ms | 5.5–22 / 8–68 ms |
| Keystroke to echo (one RPC per key), median / p95 | 8–16 / 12–35 ms | 16–31 / 17–46 ms |
| Terminal output, through the hub / straight to the remote | 6.3 MB at 7.5–15 / 5.5–8.7 MB/s | 0.34 MB in 10.0 / 9.5 s |
| `git.diff` of a 400k-line change (the host's 0.5 MB cap) | 240–290 ms | 310–365 ms |

The relay adds nothing measurable against the remote's own pace: Windows' slow output is ConPTY's, the same straight
to the remote host. The 64 MiB slow-reader cut was not reached.

**The window's side** (`packages/ui`; the recovery is in [state-management.md](state-management.md) §7):

| Where | What it does with the links |
|---|---|
| Sidebar | One project list whatever the machine (#734), in the order the hub keeps across machines: `projects.reorder` takes the whole list with machine-qualified ids, each machine saves the order of its own, and the hub saves the whole list in its store (`hub.projectOrder` in `app_settings`), so `projects.list` answers in it once a machine is linked; a project that order does not name yet (added since, or a newly linked machine's) goes at the end, with machines linked as with none. The order is checked before it is kept; an id the kept order has and a stale window's order lacks keeps its place after the id it followed, and an id the hub no longer lists is forgotten unless it is a linked machine's (which may only be out of reach). The answer holds every machine's projects, also a machine the order named none of. A linked machine's project, and its user-folder apps (a machine on a build from before #1141), which stand in "Other apps", carry the machine's name as a badge right of their name (cut with an ellipsis past 96px): a solid border while the link is `connected`, dashed otherwise (`connecting`, `away`, …); pressing it opens Settings → Machines, and its tooltip carries the link's last error. A project or session of a machine that is not connected stays listed, dimmed (`data-away`), and is never woken. Add project asks where once a machine is linked: this computer (the folder picker) or a connected machine, where a folder is added by its path (`projects.add {path, machine}`) or a new, empty one is made, in that machine's `~/Centralu` by default (`projects.create {name, parent?, machine}`, §1.3) |
| Settings → Machines | `machines.list/add/remove/reconnect`. Add a machine lists the hosts of this computer's ssh config (`machines.sshHosts`, read again each time it opens), each with what `ssh -G` resolves and "linked as …"; picking one probes it (`machines.probe`) and offers ready rows, "Windows" (with the shell that answers ssh), "WSL (<distro>)" (the default marked) or "Linux or macOS", with a name, the first row not linked yet chosen (`probeChoices` in `@cc/core`). A row already linked through that alias is shown but not offered. A probe that cannot tell says why in one sentence (`probeProblem`), and "Enter a target by hand" keeps the typed fields, prefilled from the host picked; with no hosts in the config, the dialog opens on them. A probe answering after another host was picked is dropped. Each row says the last error as what to do (`machineProblem` in `@cc/core`: a key not loaded, a host key never accepted, Centralu not installed or not serving there), and holds the version prompt. Where the machine offers it, a "Start Centralu when <machine> starts" switch (`machines.autostart`, `autostartRow` in `@cc/core`), with a line where it falls short of boot: a systemd manager that starts only at login, a Windows sign-in. A machine whose host said in its hello that it runs with administrator rights (`MachineInfo.elevated`, #702) says so in one sentence with the way out (`elevatedNote` in `@cc/core`) |
| Version prompt | From `MachineInfo.versions`: an older hub gets the existing update path; an older remote gets the exact `npm i -g centralu@<hub version>` to run there (phase 1 cannot update it); one protocol connects and the update is offered on the connected row (#689); "Connect anyway" (`machines.acceptVersions`) remains for a link held at `versions_differ`. A hub running a local build installs and updates a remote at `<base>` when `<base>` speaks its `protocolVersion`, else at the newest earlier release that does (a registry that cannot be reached, or no such release, is a plain refusal); `machines.update` never goes down, and refuses when the remote runs a newer version than it would install (`installVersion` in `links/registry.ts`; a release declares it in its `package.json`), and the result's `note` says so. A remote on a dev build (`<base>.local.N`, `pnpm remote-dev`, #1036, [plans/remote-hub.md](plans/remote-hub.md) §10.11) is compared as `<base>`: going back to `<base>` is no downgrade |
| New-session dialog, session menu | `agents.detect`, `agents.models`, `agents.capabilities` with the project's `machine` |
| Session header | Names the machine (also every grid panel's header, and where approvals and questions are answered); "older CLI" compares with `agents.versions {machine}` |
| Inbox, notice cards, OS notifications | Name the machine of a remote session |
| Usage gauges (phase 2) | This computer's donuts first, then each linked machine's behind its name: `agents.detect` and `agents.usage` with its `machine`. Only connected machines are asked (on the 5-minute refresh, on the host connection coming back, and when that machine's link comes back); one that is not connected shows its state |
| Open in VS Code (phase 2) | For another machine's project, the project's sidebar menu, the diff, the viewer and the file tree's row menu offer "Open in VS Code": a `vscode://vscode-remote/ssh-remote+<sshTarget><path>` link through `system.openUrl` (`remoteIdeUrl` in `@cc/core`). Not offered for a WSL machine, nor for an ssh target a link cannot carry |
| App views (phase 2) | Another machine's apps open like this computer's: a pinned view, a view in its conversations, Pin. The hub serves each from its own door with the machine's document (`apps.viewDocument`), and per-app origins from its own port book, keyed by machine ([plans/remote-hub.md](plans/remote-hub.md) §11). A user-folder app is opened with its `machine` (`apps.openView`), and its panels, Restart and Remove pass the same `machine` (plan §11.9, §11.10); Settings → Apps lists such apps per machine. They stand on the grid too: the hub keeps such a panel while it knows the machine and the project (store v47, plan §11.8) |
| Off for another machine's project | Reveal in the file manager and the file tree's other verbs, this computer's Open in IDE (`fs.resolve` is refused), moving its folder to this computer's trash on delete, New app |

**What phase 1 does not cover yet.** Installing and updating the remote over ssh is phase 3 ([plans/remote-hub.md](plans/remote-hub.md) §10), of which the
link starting a host it finds not running is in. `processes.strays/stop` and the quit dialog still ask this computer
only.

## 5. dev-services (despite the name, this is the prod path — corrected 2026-08-15)

When the Node sidecar became the deployment path in M1.5, the plan to "move it to Rust at Tauri step 4 and delete it"
was **put on hold**. This directory is used as is in prod today. The name is a historical remnant.

- **git**: spawn the `git` CLI + parse `--porcelain=v2/-z`. status·diff·log·branches·checkout·stage·commit·push.
  Moving to git2 (Rust) **is not done until measurement confirms a bottleneck** (m2-plan decision 3).
  The port interface is the same, so moving it later leaves the UI unchanged.
- **store**: better-sqlite3 + a `user_version` migration runner. `Store` (`store.ts`) opens the file and runs the
  migrations through the two classes it extends: the runner (`store/migrate-runner.ts`, which also answers
  `Store.inspect`) and, below it, the min-reader version gate (`store/reader-gate.ts`); an owed `VACUUM` is
  `store/vacuum.ts`. The records are one module per concept in `dev-services/store/` (projects, sessions, messages,
  the session archive, app runs, …), held as fields that callers name (`store.projects.listProjects()`), and the step list is in
  `store/migrations/`. The schema DDL lives in exactly one place,
  `protocol/src/schema/schema.sql`. In the bundle it is copied next to the build output and ships with it (F-0).
  The rule for migration steps is below (§5.1).
- **fs**: lazy readdir listing + `git check-ignore` (once per directory) + path escape blocking.
- **attachments**: saves pasted images to `~/.centralu/attachments/<sessionId>/`.
- The `--dev-services` flag **does not exist** (the document got ahead of itself). Everything is always loaded.

### 5.1 Migration steps: expand, then contract (#292)

Two builds meet one `store.db` more often than it looks: a person goes back to an older release, and a host swap
(#280) keeps the previous host serving while the next one starts, and hands back to it if the next one fails. Until
#292 nothing stopped an older host from opening a newer store. It skipped every step it did not know and failed only
when it touched something a later step had dropped. Measured on 2026-10-04: of the first 40 steps (v2–v41, seven
weeks), v28 (`sessions.archived` dropped) and v32 (`projects.default_model` / `default_effort` dropped) broke the
build before them outright, and v13 (the grid's old-named table dropped) made it silently lose every grid placement, because the
older `schema.sql` recreated the table empty.

The rule, written above the step list in `dev-services/store/migrations/index.ts` (`migrationSteps`), which a reviewer checks every new
step against:

1. **Expand.** A step may add tables, nullable or defaulted columns and indexes, or rewrite data into a form the
   previous build still reads. It declares `breaksOlderReaders: false`.
2. **Contract, one release later.** A step that drops or renames a table, column or index, or leaves data an older
   build cannot read or would silently lose, lands one release after the code stopped reading and writing what it
   removes, and declares `breaksOlderReaders: true`. Dropping something an older `schema.sql` creates counts (v13).
3. **The store records the lowest schema version that can still read it:** the `min_reader_version` row in
   `app_settings`. A breaking step raises it to its own version before it runs. A store from before #292 gets it
   computed once from the steps it has already run (32 for every store migrated to date). On open, before `schema.sql`
   or any step touches the file, a host whose newest step is below the record refuses to start: "This data was
   written by a newer Centralu", naming both versions, on stderr and stdout, exit 1, the same path as a lock conflict.
   The desktop supervisor shows it at once instead of retrying. A host older than the store but at or above the
   record opens it and runs no step it does not know. A record that is not a version (a hand edit, a write cut short)
   is worked out again, and said, by a host that knows every step the store has run; a host older than the store
   refuses the same way, naming the row, since a floor worked out from fewer steps could open what it cannot read
   (#384).
4. **Heavy steps are marked `heavy: true`:** a step that rewrites or re-indexes every message, or `VACUUM`s (v3, v11,
   v21, v40 so far; v40 held the start for 1.9s on 137,722 messages). A swap runs them after the switch rather
   than during it.
5. **During a swap (#280 step 3)** the host taking over runs the expand steps and leaves every heavy or breaking
   step for `runDeferred`, which it calls just after its ready line, once the front door points at it and the host
   it replaced is gone for good. The previous build still reads an expanded store, so a new host that fails before
   it is ready can be replaced by the previous build again; a breaking step is exactly what would stop that.
   `user_version` moves past a deferred step, and `app_settings.deferred_migrations` lists what is still owed: a
   host that dies first leaves it to the next open, which runs it in its place. So a heavy or breaking step must
   be correct when it runs after later steps, and the build that ships it must work before it has run (a contract
   step keeps this by rule 2; a heavy step by only reshaping data the code reads either way).
6. **A step commits as one unit with the record that it ran (#396):** its statements, the `min_reader_version` raise
   and the `user_version` bump (with the `deferred_migrations` list when it changes: shortened when a step a swap left
   for later runs, lengthened when a swap leaves one) go in one transaction.
   Each statement used to commit on its own, so a start killed between two `ALTER`s of v12 or v17 left the first
   column, and the next start, finding it, skipped the rest of the step for good. `VACUUM` cannot run in a
   transaction, so a step queues it for after its commit and records in that commit that it is owed (a `vacuum_owed`
   row in `app_settings`, deleted once the vacuum has run or failed; `vacuumAfterStep`). A host stopped during the
   vacuum leaves the row, and the next open vacuums, or, in a swap, `runDeferred` does. v10 switches `foreign_keys`,
   which SQLite ignores inside a transaction, and commits on its own (`ownTransaction`), as one unit by itself.

| Steps | What they do | Older build |
|---|---|---|
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43, 45, 47, 53, 54 | add a column (45: `sessions.asked_by_session_id`, the session that asked for this one, #371, whose meaning moved with #561 and #614, see 48 and 55; 47: `grid_layout.remote_app_id` and `app_machine`, a panel of a linked machine's app, #82; 53: `sessions.interruption`, why the last turn did not finish, #698; 54: `queued_requests.opened_by_auto`, a queued ask only `auto` let through) | reads it (39: shows sessions in the session archive as live ones; 43: an older host's `grid.set` writes no span, so app panels fall back to their defaults, #306; 47: an older host reads app rows only where `app_id` is set, and its `setGridView` drops a linked machine's app panel when it rewrites the layout; 53: an older host neither reads nor writes `sessions.interruption`, so a row it serves keeps the last value, #698; 54: an older host neither reads nor writes `opened_by_auto`; a row it queues is null, read as marked when the pair has no remembered consent) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42, 44, 46, 49, 50, 51, 52, 57 | add a table (3 also backfills the index: heavy; 44 adds `project_consents`, the "always" one project was given to reach another, #371; 46 adds `linked_machines` and `machine_headers`, the hub's links and what it last heard from each, and the nullable `grid_layout.remote_session_id`, #82; 42 copies the grid's session rows into `grid_layout` once and leaves `grid_panels` as it was, #288; 49 adds `report_marks`, the report a session owes the session that gave it work, #646; 50 adds `agent_start_requests`, a start_agent card still waiting for the person, #673; 51 adds `delegated_turns`, the session that gave a running turn, #676; 52 adds `queued_requests`, a request held for a busy session, and the nullable `sessions.forked_from_session_id`, #677; 57 adds `app_run_records`, `app_run_messages` and `app_run_subagent_messages`, the record of a deleted app-agent session, and the nullable `app_runs.request`, `answer` and `output`, #378) | reads it (42: an older host keeps its grid in `grid_panels`, so the two builds' grids can differ; 46: an older host's `setGridView` drops a linked machine's session panel when it rewrites the layout) |
| 60 | add a column and a table (#550): `linked_machines.asks`, the per-machine switch for a linked machine's sessions to ask this computer's projects, off by default, and `machine_ask_consents`, the pairs (a session of that machine, a project here) the person approved, each end a foreign key with CASCADE | reads it (an older host's insert leaves the switch off, it never reads the table, and its removal of a machine takes the machine's pairs with it) |
| 62 | add two tables (#1452): `usage_readings` (the limit windows' readings) and `usage_buckets` (the requests of each hour per session, project, tool and model), §6.2 | reads it (an older host neither reads nor writes the two tables, so it records nothing while it serves a swap, and its purge leaves a purged session's `usage_buckets` rows, which hold counts only) |
| 10, 11, 40 | rebuild with the same shape (10: `sessions` with `project_id` nullable; 11 and 40: the index, then `VACUUM`: heavy) | reads it |
| 21, 26, 29, 35, 48, 55 | rewrite data one way (21 rewrites every message: heavy; 48 gives a former worktree manager's worktree sessions `askedBy`, #561; 55 clears an `askedBy` that names a session of another project, the ask_project meaning from before #614, which the host start did until #844) | reads it, cannot be undone (55: a build of beta.20 or before still writes the old meaning, and a row it writes after the step keeps it, as that build showed it) |
| **13, 28, 32, 56** | **drop a table or a column** (56: `usage_facts`, which nothing ever wrote, #423) | **breaks: raises `min_reader_version`** (56: an older host recreates the table empty, which harms nothing) |

A step that changes the schema regenerates [generated/schema.md](generated/schema.md) (`pnpm docs:schema`) in the
same PR, and a new table gets a line in a "Where it is stored" list of [domain-model.md](domain-model.md) and its
mirror. `schema-doc.test.ts` fails until both are done.

### 5.2 Stored shapes another build reads (#384)

The store's tables are one shape that two builds share; §5.1 covers them. Many other shapes are stored or exchanged
the same way: JSON rows in `app_settings`, JSON columns, files in the data folder, files a person or another build
writes, and the lines and frames between processes. An older and a newer build read each of them during a host swap,
after a person goes back a release, and between two machines on different releases.

The rules for every shape: a field added is ignored by an older reader, and kept where it writes the record back; a
field removed gets its default in a newer reader; a value this build cannot read takes its default alone, and a
permission that cannot be read is a refusal; a broken file or row gives a clear message that names it, never a crash
and never a setting reset without a word.

Every such shape, its owner, its parser and what it does today with each of those, with the tests that feed it the
other build's shapes: [stored-shapes.md](stored-shapes.md). A new stored shape, or a new field in one, gets its row
there in the same pull request.

## 6. Usage and limits (FR-9)

**We ask the tool, we do not read its files.** `agents.usage` → `SessionManager.usageFor(tool)`
→ the adapter's optional `listUsage()`, which calls the tool's own API (the Claude SDK for one,
`app-server` for the other). An adapter that cannot answer throws, and the manager degrades
with the reason attached rather than showing a confident wrong number.

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
chokidar is not a dependency, `core/usage` holds only the cache arithmetic of §6.1, there is no `usage.weekly`
method, and no build ever wrote a row to `usage_facts`. The table is gone from `schema.sql`, and store step 56
drops it from an existing store (#423; a contract step, §5.1 rule 2, one release after the last that deleted a
project's rows from it). It was
also the *opposite* of the rule §8.1 states, and the two sections sat in this file
contradicting each other. Reading a tool's private JSONL is exactly what §8.1 forbids, for
the reason given there: an undocumented format breaks silently on upgrade, and a silent break
in a number is worse than a missing number.

### 6.1 The prompt cache

The usage gauge also says how much of the agents' input came from the prompt cache, because a
cache rebuild is what costs: a rebuilt prompt is paid at the write price and counts toward the
limit the gauge shows. The donut's tooltip carries one line ("Cache hit 94% · last 5 h"), and the
dropdown its click opens breaks it down per tool, for the last five hours and today (the host's
local midnight): the hit rate, tokens read from cache, written to it and uncached, the rebuilds,
and the few sessions that wrote most, each opening that session.

**Counted from the sessions' own events, not from the tool's files** (the rule above). The
adapters send one `request` per model request on `usage_update` (`RequestInput`): Claude per
assistant message, deduplicated by its message id because the CLI can send one response as several
messages that repeat its usage; Codex from `last` in `thread/tokenUsage/updated`, skipping a
notification whose `total` has not moved (a repeat). `tokens` stays the running reading it always
was. A Claude subagent's request counts too, carried on a `usage_update` that repeats the parent's
last reading, so the subagent's tokens never stand in for the parent's figures (#98).
`SessionManager` hands each request to `CacheLedger` (`sessions/cache-ledger.ts`), and
`agents.usage` answers with `cache: CacheStats` summed at the moment it is asked. A linked
machine's host counts its own, and the hub qualifies the session ids in its answer.

| Decision | Reasoning |
|---|---|
| Hit rate = `cacheRead / (input + cacheRead + cacheCreation)` over the window | The three input fields do not overlap (`TokenUsage`), so their sum is all the input the model read. A write counts as a miss: a window that only rebuilt reads 0%. Computed where it is shown (`@cc/core` `cacheHitRate`), from sums, so a host and a UI of different builds cannot disagree on the meaning |
| A **rebuild** is a request whose cache write is at least 50% of its whole input and at least 4,096 tokens | Normal work writes only what is new since the last request and reads the rest, a few percent; a request whose cached prefix expired or changed (another model, other tools) writes almost all of it. Claude Code's fixed prefix alone is well over 10,000 tokens, so the floor only drops small helper calls. Judged per request, not per turn: a turn of N tool calls is N+1 requests, and summing them would dilute the one rebuild under the later requests' reads. It needs no state, so interleaved subagent requests do not confuse it. `pnpm measure:tools` uses a finer rule (the input the previous request sent that this one did not read, [tool-cost.md](tool-cost.md) §2), which needs each conversation's previous request; this rule can miss a partial rebuild that still reads half its prompt, and can count a very large tool result or a long new message early in a conversation: it is written once either way, over half of a small prompt, and its cause says "unknown", not "expired" (a 69k message in a short Codex conversation counted, #1504 review) |
| `rebuildTokens`, **what the rebuilds wrote** (#1492), per window and per session, shown next to the count ("7 rebuilds · 1M written", and "(600k)" on a session's row) | "Most cache writes" mixed the rebuilds with the steady writes every new message needs. It is the sum of the cache writes of the requests counted as rebuilds (for a tool that reports no writes, the input it did not read, which is what its rebuild paid at the write price). Kept per hour bucket in `usage_buckets.rebuild_tokens` (v63, expand only), so a restart keeps it. Hours stored before v63, and an hour a v63 host wrote and an older one then added rebuilds to (fewer tokens than 4,096 per counted rebuild), have rebuilds and no tokens: the sum is then **not known** (the field is absent from that window and session, the screen shows the count alone), never shown as smaller |
| **Writes: N% of cache cost** (#1492), beside the hit rate | The hit rate is by tokens, which hides that a write costs far more than a read: 96% by tokens was about 43% of the cost (measured on the Mac, 2026-10-23). The host weights the tokens by price **ratios** to uncached input, no money (`sessions/cache-cost.ts`): Anthropic read 0.1, five-minute write 1.25, one-hour write 2, from the API's own split (`RequestInput.cacheWrite5mTokens` / `cacheWrite1hTokens`, `cache_creation.ephemeral_5m/1h_input_tokens`; a write it did not split is priced as five minutes); Codex by model (`AgentAdapter.cacheBilling`): GPT-5.6 and later read 0.1 (0.05 on Sol) and a 30-minute write 1.25, a model named as an older one has no write price (1); a name that says no generation is priced as the current one. The share is `cacheWriteCost / (cacheReadCost + cacheWriteCost)` (`@cc/core` `cacheWriteShare`, over `CacheWindowStats`' two sums, absent from a host that predates them). Codex reports no writes, so the input it did not read stands in and the line says "uncached input"; the Codex model is the one the turns ask for, else the one the thread opened with (the adapter stamps it on each token count, `RequestInput.model`, because a session on the tool's default has none recorded and Codex's count does not say), and the ratios are as stated in the issue, not measured against a bill here |
| Codex: reads only | Codex reports the input it read from cache inside its input count and nothing about writing to it. So its hit rate is cached input over all input, its sessions are ranked by uncached input, and the screen says so in words. A Codex rebuild is a request that read less than half its input from cache (4,096 tokens or more not read): what it did not read was paid in full and is what the provider caches for the next request, the cost a Claude write stands for. codex-cli 0.160's breakdown has a `cacheWriteInputTokens` field; whether it is ever non-zero for OpenAI models, and whether `inputTokens` includes it, is not measured, so it is not read |
| Kept in the host's memory, a day at most and 50,000 requests per tool, and restored at start from the hourly buckets (§6.2) | The windows are hours, and the figure is read only when someone looks at the gauge. Never a write per request: entries are appended in memory as requests close, old ones dropped on the next append, and the sums are taken on `agents.usage`. What an earlier run counted comes back from `usage_buckets` at start (`CacheLedger.restore`), so a restart or a swap no longer empties the figures: each bucket counts as one entry in the middle of its hour, so a window that begins inside that hour takes it or leaves it whole (an error of up to half an hour at the 5-hour edge), and `countingSince` moves back to the oldest hour restored. Rebuilds come back by cause but not with their idle times, so `expiredIdleMs` covers this run only. The gauge already asks every 5 minutes, so the tooltip costs no new question |
| The donut's own window, not the gauge's weekly one | A week does not fit in memory across restarts, and what someone acts on (an idle session whose cache expired, a model switch) shows within hours |

**Why a rebuild happened.** Each rebuild is given a likely cause, from what the host saw in that
session between the conversation's previous request and this one. The manager tells the ledger as
things happen (`CacheLedger.note`); the next request of the session's own conversation takes the
notes, rebuild or not, so a note never outlives the request it was about. The dropdown says the
causes in one line under Rebuilds ("6 rebuilds · 1M written: 3 cache expired (idle 64 min) · 1 model change ·
1 compaction · 1 unknown"; without the "written" part from a host that does not say it) and under each session it names. It is a guess from evidence, not a
report from the API, and the screen's Rebuilds tooltip says so.

| Cause, strongest evidence first | Taken from |
|---|---|
| `cold_start` first request | The session was just created (`createSession`) |
| `subagent` subagent start | A Claude subagent's first request. A subagent has its own prompt and cache, so its requests are a lane of their own (`RequestInput.agent`, the call that launched it) and never take the session's notes |
| `new_process` new process | The session's process came up again without a stated reason: woken, revived after a crash, restarted from the menu, a conversation taken over from outside. Also a conversation whose request this host has never seen with nothing noted: its process started after this host did (a restart, a host swap) |
| `model_change` model change | The model changed: the person's setting (`updateSettings`), or the tool's own switch (a refusal's fallback, `recordToolSettings`). A settings restart whose drift is the model says so too. Measured in #513's baseline: the only in-session event that rebuilt Claude's cache |
| `compaction` compaction | A `compaction` event, or `conversation_reset` (Claude Code's /clear): the next request begins with a summary or nothing the cache has seen |
| `thread_restart` thread restart | Codex's thread restarted so it takes an attached or detached app (`sessionAppsChanged`, at once or when the turn ends) |
| `instructions` tools changed | Claude took an attached or detached app at once (its tool list is part of the prompt), or the orchestrator restarted for a skill or MCP change |
| `launch_settings` launch settings changed | A keeper-retained process restarted because its adapter launch fingerprint changed or the previous build had not recorded one (#589); an idle process restarts now, a working process after its turn; a change of the project's trust does the same for the project's live sessions (#663) and says so in the conversation |
| `expired` cache expired | Idle longer than the lifetime the API reported for this lane's last write (Claude's `cache_creation` split: `ephemeral_1h_input_tokens` or `ephemeral_5m_input_tokens`) |
| `probably_expired` probably expired | Idle more than 5 minutes when no lifetime was reported (Codex never reports one; a Claude lane that has not written yet) |
| `unknown` | None of these, including idle shorter than the reported lifetime |

How long Claude Code asks the cache to keep a write is decided per request inside the CLI (read in
CLI 2.1.289): `FORCE_PROMPT_CACHING_5M`, then `CLAUDE_CODE_PROMPT_CACHE_TTL` (or its subagent twin),
then the `promptCacheTtl` setting, an agent's frontmatter and `ENABLE_PROMPT_CACHING_1H`; otherwise
one hour for a claude.ai subscriber who is not on overage when the request's source is on a
remotely configured allowlist (`repl_main_thread*`, `sdk`, `auto_mode`, `memdir_relevance` by
default), and five minutes for everything else: API keys, overage, subagents. None of that is
visible from outside, and the allowlist can change without a release, so the host does not guess
it: it reads what the API reports each request wrote, and falls back to five minutes only when
nothing was reported. The idle time behind the rebuilds put down to expiry is shown with them
(`expiredIdleMs`, the shortest and longest in the window).

Measured with `scripts/probe-cache-causes.mts` (live, haiku, CLI 2.1.289 through SDK 0.3.263, a
subscriber's login, 2026-10-12): the API reported `1h` for the SDK session's writes, and `5m` under
`FORCE_PROMPT_CACHING_5M`. A switch to sonnet read 0 and wrote 23,266 of 23,268 tokens, named
`model_change`. A new session under the forced five minutes wrote all 16,794, named `cold_start`;
without it, the first request read 12,973 tokens another session had cached, so no rebuild. After
6 minutes idle on the five-minute lifetime the next request read 0 and wrote 16,959, named
`expired` (idle 362 s). Two events did not rebuild at all, so they had nothing to name: after
`/compact` the next request read the 13,074-token fixed prefix and wrote only the 2,308-token
summary, and after a restart it read 15,382 and wrote 2,124. Compaction replaces the conversation,
not the system prompt and tools in front of it, so it is named only when its summary outweighs
that prefix.

Not covered: a Codex child agent's requests (its notifications go to the parent's step list,
not through this count), the Codex request that a resumed thread may report once on resume, and
causes the host is not told about: a change the CLI makes to its own system prompt between
requests. The cache is the account's, shared across sessions, so one session can also read a
prefix another wrote and show no rebuild where one of these events would lead you to expect one.

### 6.2 Usage over time (#1452)

Two records, both from what the host is told or asks the tool itself (the rule at the top of §6, never the tools'
files), kept in `store.db` (v62) and **local to this computer: never synced, and a linked machine keeps its own**.
Counts, percentages and names only: no content.

- **Limit readings** (`usage_readings`: `at`, tool, account, window, percent, `resets_at`). A reading is every fresh
  answer `agents.usage` gets from a tool (`ToolQueries.usageFor`), whoever asked: the gauge, a turn end or the timer. Besides the
  gauge's own polls, a turn end asks (at most every 2 minutes per tool) and a timer asks every 10 minutes for each tool that has a
  live session here; a tool with no session is not started up just to be looked at. A window that reads as it did last time writes no row: the same percent and a reset time within a minute (Claude derives the reset
  time from a relative one, so it moves by a few hundred ms on every read of an unchanged window). `account` is the `agents.account` fingerprint (looked up at most every 10 minutes), empty
  when the tool does not say; a model-scoped window keeps its `scope`. Claude's `rate_limit_event` carries no percentage (only a
  rejection), which is why a turn end asks instead of reading it.
- **Tokens per hour** (`usage_buckets`): the requests `CacheLedger` already counts (§6.1), added up by `UsageRecorder`
  (`sessions/usage-recorder.ts`) into one bucket per hour, session, project, tool, model and machine (`''` for this host's own
  requests): requests, uncached input, cache read, cache write (and the part of it the API said stays cached 5 minutes or an hour,
  `cacheTtl`, and since #1492 the API's own split of the writes into one hour and five minutes), output, the rebuilds by cause and what the rebuilds wrote (`rebuild_tokens`, v63). Buckets are written once a minute and at drain (`disposeAll`, `detachAll`), one
  upsert each that **adds** to the row, so a restart or a swap midway through an hour only adds. A write that fails keeps the buckets
  for the next minute. The model comes from the request when the tool says which served it (Claude's `message.model`, so a subagent or a fallback on
  another model is counted under its own), else from the session's setting (Codex: `by: model` is then the session's configured model, a known limit).
  Output comes from the request's own usage where the tool reports it per request (`RequestInput.outputTokens`: Codex's `last.outputTokens`).
  **Claude's is left at 0**: an assistant message carries only the count the stream started with (a few tokens), and the final count arrives in the stream's
  `message_delta`, which the normalizer does not follow. Recording the placeholder would understate it by orders of magnitude, so no figure is better than that one; counting it from `message_delta` is a named follow-up. Meanwhile `usage_history` prints `out n/a` for a row with no output rather than `out 0`, which an agent would take as fact (it is about 1.6% of the tokens but about 9.5% of the cost at Haiku prices).

| Decision | Reasoning |
|---|---|
| Keep 90 days, pruned when the host starts and once a day | An hourly row is small (a few hundred bytes; a busy day is a few hundred rows), and weeks are what "did a change save tokens" needs. Prune deletes buckets whose hour began, and readings taken, more than 90 days ago |
| A purged session's buckets go with it (in the purge's last transaction, `TrashRecords.purgeSession`); a trashed or archived session's stay | Purging is the only deletion that is for good: a session in the trash can come back, and an archived one is still the person's. What is not yet written for it is dropped too (`UsageRecorder.forget`), so a later flush cannot bring the rows back. A deleted *project* leaves its rows, named by id |
| Local only, never synced; a linked machine records its own | Per-session counts say what the person worked on and when. Nothing here goes anywhere but to the person's own window; the hub asks a machine through the existing routing (`usage.history { machine }`, route `machine`, the session and project ids in the answer qualified like any other) |
| Hourly buckets, summed to days in the host's local time at the question | One shape serves the day and the hour axis. A range that begins inside an hour takes that hour whole. In a time zone that is not a whole number of hours from UTC (India, +5:30) a bucket straddles local midnight and goes to the day it began in |
| At most 50 keys per answer, the rest folded into `*` ("Others") | A range of many sessions stays one small answer, and the biggest are never folded. The sessions of no project are `none` ("Orchestrator") |
| No alert line yet ("the weekly window will run out before its reset at this pace") | The issue asked it as a question. The readings are what such a line needs; the rule for the pace is a decision of its own, a named follow-up |
| A purged session leaves nothing | At start the host also deletes buckets whose session no longer exists (`UsageRecords.sweepOrphans`): a build older than this one that purged a session during a swap leaves them. A trashed session still has its row, so its buckets stay. A purge also takes the session out of the in-memory cache figures (`CacheLedger.forget`), so no window names it with an empty name |
| A linked machine on the hub's account (`sameAccountAsHub`) | The hub's limits stand for it, so the hub's readings are its readings; the machine still has its own token buckets, which the hub reads with `machine`. One list merging several machines' rows is a named follow-up: the dropdown asks one machine at a time, as the gauge does |

**Asking.** `usage.history { from, to, groupBy: 'day' | 'hour', by: 'session' | 'project' | 'model' | 'tool', tool?, machine? }`
is read-only (routed as `machine`, like `agents.usage`) and answers `{ by, readings, rows, recordedSince? }`: the readings in the
range (and for each series the last one before it, since a reading is stored only when it changes) as one series per tool, account and window, and rows of tokens per period and key (`UsageHistoryRow`: the sums above and
`rebuildCauses`). `recordedSince` is the oldest hour kept, so a screen can say that earlier days are not known. The same answer
reaches the orchestrator as the rare command `usage_history { days?, by? }` (behind `centralu_run`, so it costs nothing in every
request; the orchestrator's alone; it answers the top 15 keys and each window's movement in a few lines), which is how an agent
checks what its work cost. An ordinary session does not get it: its resident tools are budgeted per request (§1.1).

**The screen.** The usage dropdown ends with "Last 7 days" (`features/usage/HistorySection.tsx`): the weekly window's percent as a
step line (drawn from a day of readings on; less is a dot at the edge, so only the figure shows) from the readings (the window `weeklyWindow` would draw, of the account read last) and the five sessions or projects (a
switch) that used the most tokens, each with its cache hit rate (`topUsage` in `@cc/core`). A host that predates the question
leaves the section out.

## 8. Importing previous sessions (external sessions)

The path for taking over a conversation started outside Centralu — in a terminal.
`+ → pick a tool → previous conversation list` in the session creation modal is this feature's entrance.

### 8.1 Principle: use only official APIs

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

### 8.2 Compatibility with older tool versions

Not being able to fetch a list and not being able to create a session are different problems.
**Using an old tool version does not also block creating new sessions.**

- Claude: dynamic import + check the function exists. If it does not, 'not supported' instead of the module load blowing up.
- Codex: a server that does not know `thread/list` returns JSON-RPC `-32601`.
  This is treated not as an exception but as a normal negotiation outcome, and the reason is passed upward.
  But a genuine fault (`EACCES` etc.) is not hidden behind 'not supported' — the cause has to be visible.

That is why `agents.listExternalSessions` does not throw but returns `{ supported, reason?, sessions }`.
The UI draws `supported: false` as guidance, not as an error.

### 8.3 Cleaning up the conversation

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
compaction or tool call from one watched live. Stored once: catching up skips the event lines right after our last
message that our record already holds there (a compaction by count, a tool call or result by its id; one this host saw
live is in both), and attaches the rest. A Claude record keeps no compaction row (`getSessionMessages` drops system
rows), so the reader marks one where the CLI's summary stands as a user turn.

### 8.4 The identity of an imported session

- The tool is sent a `resume` → the model's actual context continues.
- The screen restores the last `HISTORY_LIMIT` (200) lines → this is a **snapshot for display**.
- The restored conversation is marked `lastReadSeq = lastSeq`. Do not summon a human for a conversation they have already read.
- Which conversation was taken over is recorded in `sessions.imported_from` (schema v5).
  `external_id` cannot tell you — the tool may **issue a new identifier** when resuming,
  making it differ from the original, at which point the 'already imported' mark in the list is wrong every time.
- If the record cannot be read, the session still lives. Failing to read a record is no reason to block the conversation too.
