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
├─ sessions/            # SessionManager and the parts moved out of it: delegation, handoff, the trash,
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
with `agent_session` `delete`, keeping local work with the session in the trash (#608, `cleanUpWorktreeChild` in `sessions/worktree-sessions.ts`). What stayed: the person's own worktree
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
back to the app. Settings → Orchestrator turns it off (`sessionTools`, on by default): a new session
then gets no bundle, and a live one's calls are refused at once. For provenance (#90) a reader is
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
instructions pointer: 1,709 characters against a 1,750 ceiling. The full reader profile's resident
and deferred figures for both CLIs are in [tool-cost.md](tool-cost.md) §11.

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
   `agentNoteFrame` is, #428), and appears in the target conversation with `from` identifying the asking session. An idle
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
   characters. Named files and folders inside the target project, resolved through symlinks, become
   readable to the caller for this host's lifetime (`readGrants`); the project root is never granted.
   A grant and each read are compared in one spelling (`canonicalPath`, `isInside` in `dev-services/path-guard.ts`,
   #428), so a short name, another case or a link to the root reads as the place it names.
   Outside paths are listed without grants. Claude checks grants on each read through `mayRead`;
   Codex's reads are already unrestricted.

**Long work.** A call waits up to `ASK_WAIT_MS` (240 s), below the Codex MCP ceiling of 300 s and
bridge wait of 280 s. It then answers still working, naming the session and how to call again with
`project`, `session` and no task. Without `session`, one outstanding call in that project is enough
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
words, read there. It runs on that machine with its own logins, folder and preset.

| Choice | Reason |
|---|---|
| The card names the machine, and "always" is not offered (`ProjectAccess.to.machine`) | A remembered consent is a row tied to two projects of this computer (foreign keys on `projects`); a machine's project has no row. The plan (§12.5, question 4) recommended the pair's card with the machine named; it asks each time until the owner wants a remembered form |
| Paths in the answer are listed under "outside", none opened | They name the machine's files, not this computer's |
| A session busy with a turn, or `ifBusy`, is refused with a reason; the machine's sessions are read again after the card is answered, and nothing is sent if the session left or started a turn meanwhile. The caller's trust and depth are read again after the card and right before the send (`askGateError`), and the caller's project losing trust withdraws a card still standing | A note or a queue into a session on another machine needs the machine to take them; not built. The card can stand for minutes, and a task sent into a turn the person started there would join it and end the call with their turn |
| A machine's project list is waited for 4 s (`LOOKUP_MS`); one that does not answer is counted as away | The name is looked up on every call, so one half-open link must not hold up the asks that name something else. The name that is on this computer and on a machine is still refused as ambiguous when the machine answers; when it does not, the call goes on with what was heard |
| The turn's end is read by `linkedTurnEnd` (`sessions/linked-turn-end.ts`), the same reading the orchestrator's report from that machine uses (`LinkedReports`): an approval or a question there is a running turn (as is a working state, `isInTurn`), an error or a usage limit ends the call as not finished, an interruption does once the turn was seen running (before then it ended the turn the task joined, not the task's), and so does the session being deleted there (#428) | A local agent's run reads an interrupted turn as not finished (`AgentRunWait`, #698); the two copies had drifted, so an interrupted turn there answered as done and a deleted session left the call waiting |
| A link that is no longer connected ends the tasks asked of its sessions (`observeLinkLoss`, on `machine_status`) | Their events stop reaching the hub, so the end of the turn would never be seen. The sentence says the task was delivered and may still be running there |
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
| `agent_session` | `{ sessionId?, action: status\|send\|wait\|stop\|delete\|answer\|list, text?, card?, ifBusy? }` → the same states, plus `at_rest` (nothing the caller gave it runs; its last answer), `asking` and `answered` (a card in the turn the caller gave it, §1.2.2, #676), `busy` and `queued` (a send to a session busy with a turn that is not the caller's, §1.2.3, #677), `stopped` and `deleted` (a child moved to the trash; worktree cleanup also preserves local work, #608/#637). `list` needs no `sessionId`: the caller's own children (`askedBy`) still here, each as working, waiting, finished or stopped, asleep or not, its last activity, and a worktree branch not merged yet (#690) |

**Cleaning up after a child (#690).** On 2026-10-14 a parent integrated fourteen children's answers and deleted none of
them until the person said it could; asked why, it said it had forgotten the last step, and nothing it read named it.
Every answer that hands a child's result to the session that started it now ends with one line naming the delete:
`done` and `at_rest` (`cleanUpLine`, `sessions/tool-answers.ts`), and the report of a finished turn
(`ChildReports.cleanUpWords`), which also says how many of its other children are finished and that `list` shows them.
The line is said only of the caller's own child (`askedBy`; under `auto` agent_session also reads the person's sessions
and siblings) whose work is over: not a turn cut short (`interruption`), failed or limited, nor one owing a report over
its own background work (`cleanUpDue`, `sessions/own-agents.ts`). The report counts with the same rule `list` uses
(`ownAgents`, `agentState`: a delegation still running is working, a cut-short turn is stopped, one being trashed is
gone). `list` takes `askedBy` only, as status, send, wait and stop do: a `parentSessionId`-only link is the former
worktree manager's, which store step v48 copied into `askedBy`. With the session tools turned off it says so.
The line rides in the answer, not in `start_agent`'s description: it costs nothing until the result is read, which
is the moment it applies. Nothing deletes a child on its own: a delete can drop a branch, and even with the trash it
stays the parent's or the person's call. Sleep (#568) already frees a finished child's memory.

The optional `tool` is a registry name, accepted as a string by the schema and checked against the
current registry at call time. An unknown name returns an error listing the installed tools; adding
an adapter does not require changing this schema.

Under `auto` (#603), the host's shared `autoBoundaryOpen` decision opens consent,
project trust and same-project ownership gates, with allowances logged. It does not open the agent depth (#867):
`auto` children each starting their own once ran twelve sessions at once (#862). Worktree cleanup keeps local work
in the trash under every preset (#608).
`agent_session` can status, wait, send or stop any session in the same project, and delete
any worktree session there,
including another parent's child or the person's turn; adapter mid-turn support and the
child's own preset still apply. Deleting a session without a worktree still requires the caller to have started it
(`askedBy` or `parentSessionId` equals the caller), even under `auto` (#637). Observing an app agent reuses its completion watcher, so
`run_agent` still receives its answer and the agent keeps its `safe` preset. Cleanup removes an idle worktree and branch even with dirty files or an unproven tip, after setting aside
local work with the conversation in the trash (#608). `run_agent`
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
   (#867, `sessions/agent-depth.ts`). Settings → Orchestrator → How deep agents may start agents, a slider from 1 to 3,
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
2. **How many.** Settings → Orchestrator → Running agents per project persists `prefs.agentCeiling`,
   read at call time. Empty/null means no ceiling under `auto`, `AGENT_CEILING` (4) otherwise;
   zero is unlimited, and a positive integer sets a ceiling per project over all its sessions.
   A child counts while a delegated turn runs; a child on a linked machine (#1038) counts under its parent's project
   while a call waits on its turn or its report is owed (`RemoteAgents.workingIn`); a removed machine's child holds no place,
   and one deleted there while the link was down is forgotten when the link is back (`caughtUp`). Checked before the card and again after it,
   and for a new `agent_session send` turn. The check after the card also takes the place (#673 review,
   `agentStartReserved`): one synchronous step, held through `createSession` until the child's delegation counts it,
   given back if the start fails, so calls at once cannot pass the ceiling together. A fork takes its place the same way
   (`reservePlace`). Once the child's session exists, the caller's gates (`agentStartGateError`) and the preset rule
   are read again with no wait before its delegation; a session that fails them gets no task and goes to the trash. A request still waiting on the
   person's card holds no place: it may stand for hours, and is counted when it is approved.
3. **Choice.** `tool` defaults to the project's tool; `model` and `effort` to that tool's remembered choice for the
   project (#107). A model or effort the tool's list does not have is refused with the list (`agentChoiceError`;
   an alias the ids or labels contain passes, and a tool that cannot list passes all). The check never holds the call
   (#660): it uses the cached list (one read at a time, kept whenever it arrives, a failed read not retried for a
   minute) and waits at most `START_AGENT_MODEL_CHECK_MS` (3 s) for a missing one; without a list in time the child
   starts on the name as given and the answer says it was not checked (an empty list is said to be empty). A name the
   cached list lacks is refused only after a fresh read (the CLI may have been updated).

   **By difficulty** (#729). A `difficulty` with no `model` takes the person's model and effort for that tool and
   difficulty instead, from Settings → Orchestrator → Models for the agents a session starts (`prefs.agentModels`, the
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
   (`awaitingReport` → `deliverReport`, which reaches the model as an untrusted-source notice it reads with
   `read_session`). A call waiting at that moment takes the answer instead, so it does not arrive twice. The marker
   is written to `report_marks` (store v49, #646) as well as kept in memory, so a host swap (#280) does not lose
   it: the leaving host's `detachAll` fails its waits without reporting (`handingOver`), the next host restores
   the marks of the sessions the keeper kept that are still in their turn, which ends under it. It drops a
   mark whose session has no process any more (that turn died with the old host) and one whose kept session
   already finished its turn during the swap, so a later turn the person starts there is never reported as the
   assigned work (#166); that answer stays readable through `agent_session`. Paths the
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
   | With no report paused and no turn of the caller's running, `stop` on a child whose own background work still runs (timers left out) stops that work the same way (#718), only when the caller started it (`askedBy`), it is at rest with no card standing, no delegation or wait of anyone is on it, and no report paused over that work is owed to another session (`restingWork`). Work an earlier, finished turn of the person's left running there cannot be told apart from the caller's: `stop` and then `delete` end it too. When nothing could be stopped (only work its tool cannot stop on its own), `stop` fails, naming that work. It waits up to `STOP_REPORTED_MS` (3 s) for the tool to report the end of what it stopped (Claude reports it after `stopTask` returns), so a `delete` right after it is not refused, and says so when the end was not reported yet. Worktree cleanup (`delete`) refused by that work names it, and points to `stop` only for the tasks the tool can stop. A timer does not hold the cleanup, and the delete's `note` names the timers that ended with the process | `delete` refused "still working" while `stop` said nothing was running, so a child at rest with a polling loop left could not be deleted. A turn the person or another session runs there is theirs, and so is the work it starts. A timer is out of `stop`'s reach (`stoppable: false`) and goes with the process |
   | Later turn ends while work still runs say nothing; the first turn end with none left delivers the owed report ("finished", the answer of that turn) and wakes the caller through `deliver`'s resume | One pause notice per task: a Monitor that fires every few minutes would otherwise wake the caller each time. The turns that keep the report are the child's own work, never a loop: a report does not start the reporting session's turn |
   | The work ends with no turn running and none starts within `PAUSED_REPORT_SETTLE_MS` (60 s): the report goes out with the last answer and how each task ended ("background work ended (pnpm verify: stopped) and no turn followed, so the work may not have finished"; "…: completed …" when all completed) | Claude starts the turn within a second (its task-notification); a task the person stopped by hand starts none. Each change of the work starts the wait again, and a turn running when it is up reports at its own end |
   | A failed or stopped turn (error, usage limit, the person's Stop, the #698 reasons) is reported as it ended, work running or not | Those need the caller now; the next turn is not the work's own |
   | A call waiting on the turn (`wait: true`, `agent_session wait`) takes the paused answer, with a notice that the work is not over, and the report is held for the end without a separate pause notice. `status` and `wait` on a paused child read the answer and the same notice and leave the report owed | A read of the paused answer used to take the report down, and with it the end |
   | A paused child at rest does not keep its caller awake (`waitsOn`); in a turn it does | The work may run for minutes or for good (a dev server); the report wakes the caller when it comes |
   | The person talking to a paused child: their turn ends by the same rules, so the caller hears the end once the work is over | The work the caller gave is still the child's; the person's turn does not end it |
   | New work from the same caller (`agent_session send`, a note) ends the pause: that run's own wait or report tells its end. Trashing either session takes the report down | A pause belongs to the work it was told for; held on, it would report the new work a second time |
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
   back. A turn in progress keeps its wait across a drop, as before. A machine removed from Centralu reports every wait
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
project's trunk. A project that is no git repository is refused before the card. The child shows as every worktree
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
the card. The card is `agent_start` with `machine`: it names the computer, is raised every time (an `auto` caller
included), and offers no "always", as ask_project's card for another machine's project (#700); it is bounded like a
local start's setup (`START_AGENT_SETUP_MS`). The child is made over the link (`agents.createSession` there) under
the caller's preset capped at `normal` (as create_session over a link, #838), with the model, effort and worktree
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
(`agents.interrupt` there; nothing more is owed), `delete` (to that machine's trash), `answer`,
and `list` names its machine. **`delete` takes the worktree made for it there too** (#1161 item 3,
`agents.deleteAgentChild` on that machine, `WorktreeSessions.deleteHubChild`), when nothing would be lost by it. Only
that one: a worktree Centralu made for the session (`worktree.base`) on the branch the hub's record names, so never the
project's own folder, a worktree the person opened a session in, or one a child started without a worktree.
Only when nothing is lost: nothing uncommitted in it, and every commit of its own (its checkout's `HEAD` and the branch
made for it, which the agent may have left) on a remote-tracking ref or the trunk (`gitUnpublishedCommits`); a branch
pushed from there passes, a commit only there does not. Then it goes as a local child's does (`cleanUpWorktreeChild`:
its recovery snapshot in the trash, the worktree and the branch removed). Otherwise the session still goes to the trash,
the worktree stays, and the answer says what was left and why ("it holds 2 uncommitted files", "it has 1 commit that no
remote and not the trunk has: push …", work still running there, another session in its folder). A turn the hub just
stopped is waited out for up to 10 s first (`STOPPING_WAIT_MS`), as the cleanup refuses a session still in its turn. A
machine whose build predates it answers "Unknown method": the hub deletes the session there as before and says the
worktree stays because of that build. A local child's worktree was already removed by `delete` (#608); that is
unchanged. The cards of the turn its caller gave it come to the caller as a local child's (#676): a
wait returns them (`asking`), `status` reads them from the machine (`LinkedSessions.cards`), and a card raised while
no call waits is told once (`cardNotice`); each card's handle names that turn (`RemoteAgent.turn`, new with each start
or send at rest). `answer` takes a question card's answer to the machine (`agents.answerQuestion` there). An approval
card stays the person's on that machine, whatever the caller's preset: the child runs under `normal` at most there, and
a caller's `auto`, which alone lets it answer a local child's approval, is never carried to another computer. `send`
into the turn the caller gave it goes in as a note (the machine's `host.send` takes it into the running turn, as the
person's message there; nothing is armed again); into a turn the caller did not give it (the person's there) it is
refused, as neither a queue nor a fork reaches another machine.

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
machine was removed, while the hub could not see it is cleared by `list` and `delete`; the caller's trash clears its
children's records, and a handoff gives them to the heir. In the sidebar it hangs under its caller, in the caller's
project, with its machine's tag: the hub names the caller as its `askedBy` in that machine's rows and owner events
(`LinkDeps.ownerOf`, `SessionManager.remoteAgentParent`) and sends `session_owner` when it records the child, hands it
to an heir, or forgets it with its caller; the window places a session whose parent runs on another machine under
that parent's project (`sidebarProjectOf`).

**Creator and worktree ancestry** (#637). `askedBy` records who started an agent, regardless of its folder.
`parentSessionId` records worktree ancestry (including former manager children); `start_agent` sets it only
when creating a worktree. Same-folder children keep `parentSessionId: null`. The sidebar uses a present
`parentSessionId` first, then `askedBy`. Keep these fields distinct: changing ancestry for same-folder sessions
would also change worktree consumers. No migration or backfill is needed; deletion without a worktree accepts
either existing creator/parent link, including records reloaded after a host swap. Stored session and trash
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
`trashSession` path: withdraw a pending wake, settle waits, dispose the child process if present, flush streamed
messages, then move the session to the trash and emit `session_deleted`. Mid-turn deletion requires the caller's
own unsettled delegation, including while the parent is working; it does not stop the parent's turn. If the
person has started another turn, or an approval/question remains without that delegation, deletion is refused
until that work finishes, even under `auto`. History and the tool's conversation remain restorable.
Concurrent sidebar and agent trash requests share one operation per session: the first request's options and
result apply to both, with one process disposal, store write and deletion event.
The result is `deleted` without worktree/branch recovery fields. A session belonging to another caller, an
unowned session, a session in another project, and self-deletion are refused.

**Deleting a worktree child** (#608, decision owner 2026-10-13). In every preset the parent decides whether
to remove its child: neither uncommitted files nor an unproven merge refuses deletion. A working child must
finish or be stopped first. A worktree folder that is already gone (#715) holds no work to lose, so deletion
goes ahead without a snapshot: the session goes to the trash, `git worktree prune` drops git's stale entry, and
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
occupants are checked again after the snapshot and again after trashing: one that came in meanwhile (restored
from the trash, opened there) keeps the worktree in place, with the snapshot kept. A sidebar delete already
under way refuses it too, and a cleanup cannot join a delete that started first: that delete's trash record
carries no recovery snapshot, so the worktree stays in place for that path. Failed capture leaves the worktree and branch in place. Once captured,
the session goes to the trash, then git removes the worktree (including initialized submodules) and branch.
After trashing, removal errors return `deleted` with a warning naming the leftover worktree/branch and
recovery location. The parent cannot retry a trashed session through `agent_session`. Capture errors still
return a refusal before trashing. The
tool's conversation remains. The answer reports the uncommitted file and commit counts, or that nothing
needed setting aside. A saved notice also offers the recovery directory in the trashed conversation. Counts
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

The trash's optional `recovery` JSON field remembers the snapshot id, tip and counts; this is additive and
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
or bundle. Trash byte totals include recovery files.

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
files are retained. Deleting for good, including empty trash, removes the entire session recovery directory
only after the rows are gone (#647): the directory is first moved aside, which fails where removal would and
leaves the trash entry retryable, then deleted once the database step succeeds, or moved back when that step
fails, so the entry stays restorable. A folder that cannot be moved back is logged and left aside under
`<session id>.purging-<random>`; at startup such folders go back under their session's
name while the entry is still in the trash (joining any snapshot made since), and are deleted once it is gone,
so a crash at any point of a purge is repaired. Purge and restore wait for that repair; a folder that cannot
be repaired (held open on Windows) is logged and retried at the next start, and the others go on. No automatic trash expiry is implemented; expiry
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
passes it up front. B's own running turn there is not busy for B: a note into its own work goes on as before. Messages
the person sends are unchanged. The answer says which choice ran and its handle.

| `ifBusy` | What happens |
|---|---|
| `note` | Today's mid-turn note (#594/#606/#653): only when B's own preset is `auto`, and only on a CLI that takes input mid-turn (`send_to_session` sends as before). The turn's answer stays its owner's; B reads the reply to its note on its own reader. Not into another caller's `ask_project` task. |
| `queue` | Held (`queued`, `enqueue`) and delivered as a new turn B owns when A's running turn ends (`drainQueue`, from the turn's end and the boundaries that free a session): B's delegation for `agent_session` and `ask_project`, its turn for `send_to_session`, each framed as that tool frames its work, with the report when it ends and its cards (§1.2.2). One at a time, oldest first. The answer is a handle (`qr-…`) and the place in the queue; `agent_session` status (or `ask_project` with no task) says where it stands, `stop` withdraws it. Written to `queued_requests` (store v52): `detachAll` delivers nothing (`handingOver`), and the next host delivers a request when the kept session's turn ends there, or soon after start for a session at rest (a kept one after its adoption, so its input never starts a second process). A request whose session or requester is gone is dropped, as are those of a trashed session. Before it goes in, the request tool's gates are read again with the requester's preset as it is then (`queuedGateError`): for ask_project its trust and depth, the target project, and the pair's remembered consent when only `auto` let the request pass without one (`openedByAuto`, stored as `queued_requests.opened_by_auto`, store v54, so a swap keeps it; a row an older build wrote is read as marked when the pair has no remembered consent); for agent_session the ownership a requester that is not `auto` needs and the preset rule. A request that fails them is dropped with its requester told. A requester moved off `auto`, or handing off to a successor that is not `auto` (`moveChildren`, the original is told), drops at once what only `auto` let through (`dropOpenedByAuto`: a marked ask whose pair still has no remembered consent, a send to a session it did not start); one being delivered at that moment is left to the delivery gate, which reads the stored mark if a swap delivers it again. Its caller's project losing trust or being removed, and the person revoking the pair, withdraw queued `ask_project` requests the same way (`withdrawReaches`); trust and a revoked pair leave an `auto` requester's requests, which the delivery gate reads again. **Delivery** (#684 review): one drain per session at a time (`delivering`), which reserves the session before its first await, so waking a sleeping session counts as busy and lets no second request in; the request stays first in the queue and its row stays, marked `delivering_at`, until the session's turn actually starts, and only then is it taken off. A swap or crash in between leaves the row, and the next host delivers it again: at least once, with one duplicate possible when the old process took the input without a word before the swap. A deferred restart is not waited out by the drain (`deliver` waits for it), and its end schedules the drain again. A row being delivered is left out of `withdrawReaches` and `dropOpenedByAuto`, so its gate (`queuedGateError`, for every tool) is read once more after that wait and any wake, before the task is written (`stillAllowed`). A remembered pair consent revoked in that window does not stop it: being delivered counts as running, as a delegation already running is left to finish (`revokeProjectConsent`). A retry of the same request (requester, tool and words) returns the handle already held instead of a second entry. |
| `fork`, `fork_read` | A sub-session from a copy of A's conversation now (`forkFor`): the adapter's `forkConversation` (Claude: the SDK's `forkSession`, which writes the copy beside the original's transcript; Codex: `thread/fork`), resumed with its history on screen (`importHistory`). An adapter without it, a session with no conversation yet, and `ask_project` (which never creates a session in another project) are not offered a fork. start_agent's gates apply: the agent depth (#867), the project's trust (#382; #673's consent rule as `ensureAgentConsent` has it) and the per-project ceiling; once the card is answered the gates are read again and a place is taken before the copy is made (`reservePlace`), and the project losing trust withdraws a card still standing. Once the fork's session exists the gates and the lower of the two presets as they are now are read again with no wait before its delegation; a fork that fails them gets no task and goes to the trash. The preset is the lowest of B's and A's. `fork` gets a worktree of its own (`agentWorktreeBranch`, branched from A's branch when A is a worktree session; a project with no git repository is refused and pointed at `fork_read`); `fork_read` is read-only work in A's folder under at most `safe`, so two agents never write one folder. Linked to B: `askedBy` B for a same-project ordinary session (the orchestrator through the delegation alone), its turn B's delegation (the report, its cards), and `forkedFrom` A (`sessions.forked_from_session_id`, store v52), which the sidebar uses to hang it under A, ahead of `parentSessionId` and `askedBy` (`orderAsTree`, `foldGroupsHiding`). |

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
  - **A handoff that removes the original** (chosen in the window; its default until #694) says so (`handoff.removesOriginal`, an addition to
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
    on a moved child ends with a fixed answer (`handedOverReply`), since the trash drops the `handedOver` entries
    before the woken call reads them. The heir is the newest live session whose handoff marker names it
    (`Store.handoffHeirs`, filtered in SQL); successors that were removed, or are being removed at the same time
    (`trashing`), pass on to their own successors, the nearest generation first. Its note was read long ago, so it is
    told in its conversation (a `notice`); the original, about to go, is told nothing. The move is its own transaction ahead of the trash's: a crash between them leaves the children
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

### 1.2.6 The orchestrator hands a session off (`handoff_session`, #694)

Handoff was the session menu's alone (⋯ → Hand off to a fresh session…). The central orchestrator now has it as a tool,
so it can replace a session that has drifted, or move its work to the other CLI, the way the person does. The note is
**from the record by default**, in the tool and in the window alike (owner decision on #694; the window still keeps
the original by default, the pairing the record mode always had): the session being
replaced is the one least likely to summarize correctly (repeated compaction, stale state, a summary carrying injected
text), and the record mode asks it nothing (`exportHandoffRecord`, `sessions/handoff-record.ts`, unchanged). Asking
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
  - The person's consent is a card in the orchestrator's own session for each handoff (`askHost`, an `other` card with
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
  orchestrator's row (`orchestratorChildren`), with a ⋯ menu to stop or delete it; a child whose orchestrator was
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
`main.ts`): its name, status, OS and shell (from the shell the hub reaches it with), and whether it connects at start or
when needed (`MachineInfo.connect`, #1134).

**Managing the linked machines** (#1219, second slice). The orchestrator's rare commands `add_machine { sshTarget, name?,
wslDistro? }`, `install_machine { machine, action: install | update }`, `remove_machine`, `reconnect_machine`,
`set_machine_connect { connect }` and `set_machine_autostart { on }` make the calls the Machines screen makes on the
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
Reconnecting and the connect mode act at once, as the row's buttons do. Refused before any card: a machine not linked,
a target that is no ssh target or that `ssh -G` cannot read, a name already linked, and an install or update
this computer cannot make (`LinkedMachine.operationRefusal`, the same sentences `operate` refuses with). Every answer
ends with the machine as it is after the change (`machineLine`). An install or update runs while the tool call waits.

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
  send(input: UserInput): void
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
- A capability is not necessarily a static declaration; it can be **decided at detect() time** (e.g. if whether approvals work depends on the Codex version, decide after detecting the version — the C4 response).

### 2.1 Claude query options and independent-session messaging (#569)

`ClaudeSession.start` is the single SDK `query({ options })` construction site. Both
`SessionManager.createSession` and the resume/wake path use it, for ordinary sessions,
orchestrators, coordinators, worktree managers, builders, app agents and `start_agent` children.
The two build the adapter's options in one place (`SessionStarts.launchOptions` in `sessions/session-start.ts`, #428), so an option
added there reaches a new session and a wake alike (`sessions/launch-options.test.ts`).
Its `spawnClaudeCodeProcess` callback sends the SDK's flags and environment to either the local
spawn or the keeper; a fresh keeper replacement therefore receives the same options.

`withoutCrossSessionMessaging` wraps the existing options and takes the session's preset
in the Claude adapter. Under `auto` (#603) it leaves peer messaging, discovery and the
environment gate alone; the CLI's own configuration still applies. Under `safe`/`normal`, it merges inline SDK flag settings
with `crossSessionInbound: 'refuse'`, appends discovery denies `ListAgents` and `ListPeers`,
and merges `process.env` and any explicit environment with `CLAUDE_CODE_HARBOR_KITE: '0'` last.
The adapter previously selected settings files only through `settingSources`; inline `settings`
are a separate layer and do not replace that selection, permission options, MCP servers or
resume IDs. `SendMessage` is deliberately left available for this query's own subagents.

The environment gate disables peer discovery, cross-session sends and inbox binding in the
inspected CLI versions 2.1.263–2.1.289. It is undocumented and version-sensitive, so the
documented refusal and discovery denies stay as additional controls. They do not alone block
every outbound send to a known peer if the gate changes. A keeper adoption attaches to an
already-running process and cannot apply new startup controls; restart processes created by
an older host to pick up this fix. The auto launch fingerprint is versioned so a retained
auto process with the old controls restarts through the normal launch-settings handover path. See [security-boundaries.md](security-boundaries.md).

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
3. Add contract tests: recorded raw response fixtures → NormalizedEvent snapshot verification.
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
| Codex | `adapters/codex/protocol-contract.json` — every RPC method and notification we send or read, plus approval enum values | `pnpm codex:bindings --check` (regenerates bindings from the installed CLI, greps for our names) | a method/notification leaving the protocol (change axis C4) |
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
fingerprint stays at v1; auto's existing v2 is unchanged.

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
| `{"op":"status"}` | `{"ok":true,"view":…}` — host state, the front door's port and token (§4.2), build source, background mode, attached windows, activity, the current or last swap (`swap`), whether the host keeps agents across one (`keepsAgents`), and the keeper's own build (`keeper.build`, since step 4; a window counts a keeper without one as another build, which only "Restart completely" moves, #461) |
| `{"op":"attach","protocol":1,"build":…}` | `{"ok":true,"view":…,"sameBuild":bool,"keeperSameBuild":bool,"relaunched":bool}`, then `{"event":"status","view":…}` on every change for as long as the connection is open. An open attach connection is what "a window is attached" means; its closing is the detach. `relaunched`: this window is the one an announced relaunch started (§4.5) |
| `{"op":"relaunching","graceSecs":n?}` | `{"ok":true,"graceSecs":n}` — the app is about to relaunch itself to apply an update (#352): for `n` s (60 by default, at most 300) no window attached does not stop the keeper, whatever background mode says. The next attach spends it |
| `{"op":"stop"}` | stops the host and the keeper ("Quit completely", and "Restart completely", after which the window starts a keeper of its own build) |
| `{"op":"switch","source":…,"keeper":{"exe":…}?}` | a blue-green swap to that build (§4.2; the build stamp is re-read from its folder). With no host up, the next start simply runs that build. With `keeper` (the app sends its build's `centralu-keeper`; an app from before #440 sent its own executable, which is refused since #461, the keeper staying on its build) and a keeper of another build, the keeper first hands itself over to that build's keeper ([architecture.md](architecture.md) §4.4), which then runs the swap. A keeper from verified content starts nothing from the bundle: it verifies and copies the bundle's signed content and hands over to the keeper in that copy (§4.4); a refusal ends the swap as `failed` with `refused` set. A second `switch` during a swap is refused |
| `{"op":"upgrade","exe":…,"source":…}` | hands the keeper over to the keeper at `exe`, of build `source`, leaving the host alone (§4.4); from verified content, to the keeper in the verified copy of `exe`'s bundle content |
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
cannot change the person's automatic-apply preference. An install starts the normal host install; the window still
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
asked. After consent the windows are asked again, since a card can stand for minutes, and `update_apply_go` names the
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

The automatic mode ("Apply updates automatically when idle") still waits for the keeper to report nothing busy. The
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
| `quit` | a start finds the session `working` or `waiting_approval` with no process (a full quit, a reboot, a crash the keeper did not survive), or a kept process cannot be re-attached. A warning line from Centralu is written into the conversation ("Centralu quit or restarted while this turn was running …") | the same |
| `interrupted` | a turn ends `waiting_input` with the reason `interrupted_by_tool` (`INTERRUPTED_BY_TOOL`): Codex's `turn/completed {status: "interrupted"}` for a turn no `turn/interrupt` of ours preceded | the same |
| `reconnecting` | the tool has stayed `retrying` for `RECONNECTING_FLAG_MS` (5 minutes): Codex waits for the network without end. Live only, never stored | the activity moves off `retrying` or the turn ends |

| Decision | Why |
|---|---|
| An app request cancelled mid-turn fails its wait before it interrupts the session | Claude's adapter ends the turn as soon as the CLI confirms the interrupt, before the turn's result, so the wait read the cancel as "stopped before it finished" |
| Classify and surface; never resend by itself | A resent turn can repeat side effects (a push, a comment, a release). Continuing is one message from the person or the asker, the same sentence both ways: "Continue where you stopped. Check what already happened before repeating a step." Auto-resend on reconnect could come later as an opt-in |
| A Codex `interrupted` turn ends as a Stop does (`state_change waiting_input`), not as `turn_complete` | `turn_complete` is "finished": the orchestrator was told the work was done. A wait on the turn (`AgentRunWait`) ends on the interrupt, since no `turn_complete` follows it now |
| The Codex adapter tells its own interrupts from Codex's and logs which (`interruptsSent`, "interrupted by a stop from Centralu" / "by Codex"). A Stop that lands while a note's `turn/start` is in flight interrupts the turn the answer names, and counts as ours too (`takeInputTurn`) | The real case could not tell whether the person's Stop, the host or the CLI sent it |
| The person's Stop, and an orchestrator's `agent_session stop`, set nothing | They know; flagging their own act would be noise |
| Only `retrying` starts the `reconnecting` clock, never silence | A session polling CI with 15–40 s sleeps looked frozen and was not; long builds look the same |
| A report owed for the turn names the reason first ("stopped before finishing: a network error ended its turn", "its tool interrupted the turn") and how to go on | "The assigned work failed" made the asker redo or abandon work that only needed a "continue" |
| When no report is owed (no report mark, no call waiting on the turn now), the session that gave the turn hears once of a `network`, `interrupted` or `quit` stop (`tellAskerOfInterruption`): a delegation's caller nobody waits for now (`ask_project` or `start_agent` past its bound), else the session that started it (`askedBy`). A call still waiting reads the stop from its own answer | The 2026-10-15 case, and an `ask_project` turn whose session has no `askedBy`. One report per stopped turn; another needs another turn, so two sessions cannot wake each other in a loop |
| Every report and every word Centralu gives a session about its request (a start that did not start, a note or a queued request that did not go) goes through `tellSession` (#428): never while the host hands over or quits, never to a session that is gone | A quit used to report each running child as "failed: Centralu is shutting down" in its caller, which the next start then told again as a `quit` stop, and a report could wake a sleeping caller on the way out |
| A `quit` is told at the next start, once per child, to the first that still exists of: the session owed its report, the one that gave the turn (`delegated_turns`), its `askedBy` (`quitNotices`, after the keeper's adoption for a kept one). A kept process that cannot be re-attached settles its report the same way. **No requester that is itself stopped by a quit** is told, at the start or later: it waits for the person's Continue | An asker that delegated without waiting was at rest, not cut, and its report mark used to be dropped: it never heard. Waking it once costs a turn; never hearing costs the work. An orchestrator the same quit cut would be resumed at launch with nobody there, and that turn would clear its own "stopped" mark before the person saw it; its children's rows say they stopped once it is continued |
| The orchestrator's list (`list_sessions`, and `read_session` with no id for a reader) and `agent_session status` add "stopped: network error", "stopped: Centralu quit during its turn", "stopped: its tool interrupted the turn" or "reconnecting to its API for N min" to the row. No filter argument | The row already says it, and an argument rides in every request's tool definitions (docs/tool-cost.md). `agent_session list` (#690) names such a child `stopped` and leaves the reason to `status`: it is a list for cleaning up, where what matters is that the child's work is not over |
| The screen shows it beside the state: the inbox row's word and **Continue**, the sidebar mark's ring and tooltip, a line above the composer (product-spec FR-15) | The state alone looks the same for a stopped turn and a finished one; Continue is the one message that goes on |
| `CLAUDE_CODE_MAX_RETRIES` is left as the CLI sets it | Its three minutes outlast most drops; a longer budget would hold a turn hostage through a long outage |

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
| Token and port are generated once and kept | The client stores them and reconnects without an SSH round trip; it runs `--connection` again only when a hello is refused |
| Default port 17175 | Below every OS's ephemeral range and below the host's per-app view origins (20000–32767, `views/origin-ports.ts`) |
| A recorded or default port another program holds moves to the next free one above it (up to 19 more, below 20000) and is recorded; `--port` is used as given | One Windows laptop linked twice, its Windows side and a WSL distro, had both hosts on 17175: WSL2 relays the distro's loopback ports to Windows (`wslrelay.exe`), so the second could not start (#482). Inside WSL, the ports Windows listens on count as taken too (`netstat.exe` through interop): a host there on such a port would be unreachable, because the hub's forward ends on Windows' loopback. `--connection` reports the port the host got |
| The host gets its own process group and `--watch-parent` | Ctrl+C reaches the launcher, which passes one SIGINT to the host alone, and the host stops its agents in order. Killing the launcher, even with SIGKILL, closes the host's stdin and takes it down: it is never left running unsupervised (`tooling/launcher-serve.test.ts`) |
| A signal during startup is held until the host can shut down | Before the host attaches its handlers the kernel's default applies and ends it on the spot. Measured: a SIGINT passed on as soon as the ready line was read killed the host every time. Now it shuts down cleanly once started; a second signal while starting exits at once (`lifecycle/endings.ts`, `holdSignals`) |
| A second signal forces the exit only when it comes 1 s or more after the first; SIGHUP shuts down like SIGINT and SIGTERM | A person pressing Ctrl+C again, while starting or while shutting down, gets the host gone at once (exit 1); a shutdown is also bounded at 10 s (`lifecycle/shutdown.ts`). One request often arrives as two: Ctrl+C reaches the launcher, which forwards a SIGINT, and the terminal may deliver its own; a closing terminal sends SIGHUP right after SIGINT. Within `REPEAT_AFTER_MS` (1 s, `lifecycle/endings.ts`) the second is the same request and changes nothing, so it cannot cut the shutdown it asked for short (owner, 2026-10-12, #504). Without a listener SIGHUP's default ended the host with no shutdown at all |
| A second `serve`, or any other host on the same data folder, is refused | The ownership lock (`instance-lock.ts`) is the authority. `serve` first asks the port it recorded, so a serve already up is named with its port; for any other owner the host's lock message is followed by a line naming the pid and, when `host.lock` says, who started it. The host's own message names a serve host's link and what stopping it costs (#1223): on a linked Windows machine the desktop window used to be told to close a window that did not exist |
| Except on Windows, where a `serve` in the person's sign-in takes the folder over from a host in a network logon, once that host has nothing running (#1224) | The host the hub's ssh started before anyone signed in cannot open the user's Credential Manager vault. The sign-in task's `serve` (at sign-in, or from `--detach`) asks it `host.stop { ifIdle: true }` every 30 s: the host checks its own idle rule (no turn, approval, question, background work, terminal or command) and the calls in flight, and stops in the same step, taking no new call from its yes on, so a turn cannot slip in between. Then this serve starts its own host on the same port and token; the hub's link drops and reconnects by its backoff. It waits 30 minutes at most, and says `waiting`, then `gave_up`, to the host (`host.handover`), which the hub's row shows. A host that does not say its logon (older) is never moved |
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
| Windows, nobody signed in (no Explorer of this user outside session 0), the task's host not answering in 20 s, or `CENTRALU_SIGNIN_TASK=off` | `Win32_Process.Create` through WMI (`Invoke-CimMethod`), from Windows PowerShell 5.1 by full path | Windows' OpenSSH ends every process of a session with it, `Start-Process` included; a process WMI creates is not in the session. It keeps the caller's network logon: Git there cannot use the credentials saved in Windows, and the host says so (`hello_ok.logon`) |
| WSL (`WSL_DISTRO_NAME` set and interop on) | The same WMI call, from `powershell.exe` reached through the drive WSL mounts, creating `wsl.exe -d <distro> -u <user> --cd <folder> --exec <node> <centralu.mjs> serve …` | WSL stops a distro about 15 s after its last `wsl.exe` client exits; this `wsl.exe` is one for as long as the host runs. On the test laptop a WMI-created `wsl.exe` later hung without running anything (plan §10.4); that is reported as `wmi_blocked`, and the hub runs the host link-bound |

A process WMI creates gets the account's default environment, not the session's, so what the launcher needs from the
`--detach` that started it travels in one internal argument (`--detached-child=<base64 JSON>`): the log file, and
`CC_DATA_DIR`, `CENTRALU_HOST_ENTRY` and `CENTRALU_MANAGED` when set, and `CENTRALU_STARTED_FROM` (the `--from` hub and the
ssh client's address the `--detach` saw, for `host.lock`, #1223). Never the token, which stays in `serve.json`.
The launcher writes `<data>/serve.log` (its own lines and the host's stderr until the host is ready; `host.log` has
the rest, so it stops growing; the previous start's is kept as `serve.log.1`) and `<data>/serve.pid`
(`{ pid, hostPid, port }`, removed when it exits).

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
| `posix` | `sh -c 'm="${CC_DATA_DIR:-$HOME/.centralu}/remote/bin/centralu"; if [ -x "$m" ]; then exec "$m" serve --connection; elif command -v centralu …; then exec centralu …; elif [ -x "$HOME/.centralu/bin/centralu" ]; then exec …; else echo CENTRALU-NOT-FOUND; exit 127; fi'` | the fake ssh of `tunnel.test.ts`; the order by a real `sh` there |
| `powershell` | `powershell -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>` of the same lookup (`<data>\remote\bin\centralu.cmd`, then `Get-Command centralu.cmd` (the `.cmd` shim, never the bare name: PowerShell would pick the `.ps1`, which the default `Restricted` execution policy blocks, #688), then `%USERPROFILE%\.centralu\bin\centralu.cmd`) | Windows 11, OpenSSH, PowerShell 5.1 (before the managed launcher was added) |
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
| Hold | The link stops reconnecting and starting a host of its own (Reconnect included) until the check; it would otherwise start the old version between the stop and the switch | the same | the same |
| Stop | `centralu serve --stop` through the lookup: the running version stops itself in order (§4.7). Not stopped: the call fails and nothing is switched | the same | the same; not stopped, nothing is removed |
| Boot entry | — | — | `serve --autostart remove` through the lookup (§4.7), after the stop; `off` of a serve from before `remove`, where `off` removed the entry. Not removed: nothing is removed. A version older than `--autostart` is passed by (it cannot have written one from here) |
| Switch | `remote-install.mjs` with `action: 'pointers'`: `previous` = the old `current`, `current` = the new one, each by rename; the launcher is written now if there is none | `current` = `previous`, `previous` removed: one step back only | `<data>/remote/` removed, by a script per shell (a running `node.exe` could not remove itself) |
| Start | `serve --detach` (`Tunnel.startHost`) | the same | — |
| Check | The link opens again; only a hello whose `build.version` is the target ends it, within 30 s | the same | — |
| After | Success: `action: 'prune'` removes what neither pointer names. Failure: the end of `host.log`, `serve --stop` again, the old pointers back (none, after a first update over an npm install: then the launcher goes too), the old version started if one was running, and the call fails with that sentence | Failure: the same, towards the version it left | The link opens again and finds what is left (an npm install, or nothing) |

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
sessions resume on the new host through their stored ids, as after any restart.

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

**The link's states** (`MachineInfo.status`, sent as `machine_status`): `connecting`; `connected`; `unreachable`
(ssh failed, the forward or the socket dropped; retried with backoff from 2 s to 5 minutes, #1134); `starting` (no host ran
there; the link is starting one, above); `updating` (the hub is stopping, switching or removing the Centralu it installed there; the link waits, above); `not_running` (Centralu answers there but no `centralu serve` runs, and
starting one failed, `error` says why; retried); `versions_differ`; `refused` (a token refused twice in a row:
the connection line is read again once at once, since `--rotate-token` changes the token a running serve keeps until
it restarts); `disconnected` (#1134: closed on purpose and not tried, below).

**When a link is opened** (#1134, owner decision 2026-10-18; `MachineInfo.connect`, the `linked_machines.connect`
column, v59). `at_start`, the default, is what every machine did before: connected when the hub starts and tried again
after every drop, so an orchestrator working through it hears reports and cards as they happen. `when_needed` is for a
laptop that is often closed or a server used once a week: the machine is not connected at start, and no attempt is
made until something needs it. A need is the window opening one of its projects or sessions (`machines.need`, said
again every 2 minutes while it stays open), or the orchestrator acting there: `start_agent` with the machine,
`agent_session`, `ask_project` on one of its projects, `read_session` of one of its sessions (`linked-sessions.ts`
waits up to 60 s for the link). Looking a name up is not a need: such a machine's projects stand as last listed, not as
away, also while it is connecting or between attempts, so the act that follows waits for the link instead of being
refused. Each act there starts the hold again. The link stays up for 10 minutes after the last need, for as long as a
session there is in a turn as the hub last heard it (followed event by event, so a turn open when the link dropped
keeps it tried), and for as long as a session here waits on a child there (its report owed, over its turn or over its
background work; `SessionManager.linkedWorkOwed`); then it closes (`disconnected`), also while it was away. A
restarted hub connects such a machine at start while a report of a child there is owed. Its sessions keep running there meanwhile; on the next connect the window
re-reads that machine (`machine_resync`) and with it what they said. The row's Disconnect closes any link without
unlinking the machine; Connect (`machines.reconnect`) opens it and keeps it until Disconnect. After the person's
Disconnect, the window saying again that it still has something of the machine open (`machines.need` with `repeat`)
does not bring it back; Connect, the window opening something of it again, or an agent's work does. A machine connected
at start that the person disconnected stays so until Connect or the hub's next start: an agent's work does not bring it
back. An install, update or autostart change on a disconnected machine connects it first, since it runs over the link's
ssh, without pinning it: its hold runs from the end of the job. An older host ignores the column and connects every machine at start; an older window reads `disconnected` as
`unreachable` and shows no setting.

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
  the trash, app runs, …), held as fields that callers name (`store.projects.listProjects()`), and the step list is in
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
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43, 45, 47, 53, 54 | add a column (45: `sessions.asked_by_session_id`, the session that asked for this one, #371, whose meaning moved with #561 and #614, see 48 and 55; 47: `grid_layout.remote_app_id` and `app_machine`, a panel of a linked machine's app, #82; 53: `sessions.interruption`, why the last turn did not finish, #698; 54: `queued_requests.opened_by_auto`, a queued ask only `auto` let through) | reads it (39: shows sessions in the trash as live ones; 43: an older host's `grid.set` writes no span, so app panels fall back to their defaults, #306; 47: an older host reads app rows only where `app_id` is set, and its `setGridView` drops a linked machine's app panel when it rewrites the layout; 53: an older host neither reads nor writes `sessions.interruption`, so a row it serves keeps the last value, #698; 54: an older host neither reads nor writes `opened_by_auto`; a row it queues is null, read as marked when the pair has no remembered consent) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42, 44, 46, 49, 50, 51, 52, 57 | add a table (3 also backfills the index: heavy; 44 adds `project_consents`, the "always" one project was given to reach another, #371; 46 adds `linked_machines` and `machine_headers`, the hub's links and what it last heard from each, and the nullable `grid_layout.remote_session_id`, #82; 42 copies the grid's session rows into `grid_layout` once and leaves `grid_panels` as it was, #288; 49 adds `report_marks`, the report a session owes the session that gave it work, #646; 50 adds `agent_start_requests`, a start_agent card still waiting for the person, #673; 51 adds `delegated_turns`, the session that gave a running turn, #676; 52 adds `queued_requests`, a request held for a busy session, and the nullable `sessions.forked_from_session_id`, #677; 57 adds `app_run_records`, `app_run_messages` and `app_run_subagent_messages`, the record of a deleted app-agent session, and the nullable `app_runs.request`, `answer` and `output`, #378) | reads it (42: an older host keeps its grid in `grid_panels`, so the two builds' grids can differ; 46: an older host's `setGridView` drops a linked machine's session panel when it rewrites the layout) |
| 60 | add a column and a table (#550): `linked_machines.asks`, the per-machine switch for a linked machine's sessions to ask this computer's projects, off by default, and `machine_ask_consents`, the pairs (a session of that machine, a project here) the person approved, each end a foreign key with CASCADE | reads it (an older host's insert leaves the switch off, it never reads the table, and its removal of a machine takes the machine's pairs with it) |
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
| A **rebuild** is a request whose cache write is at least 50% of its whole input and at least 4,096 tokens | Normal work writes only what is new since the last request and reads the rest, a few percent; a request whose cached prefix expired or changed (another model, other tools) writes almost all of it. Claude Code's fixed prefix alone is well over 10,000 tokens, so the floor only drops small helper calls. Judged per request, not per turn: a turn of N tool calls is N+1 requests, and summing them would dilute the one rebuild under the later requests' reads. It needs no state, so interleaved subagent requests do not confuse it. `pnpm measure:tools` uses a finer rule (the input the previous request sent that this one did not read, [tool-cost.md](tool-cost.md) §2), which needs each conversation's previous request; this rule can miss a partial rebuild that still reads half its prompt, and can count a very large tool result early in a conversation |
| Codex: reads only | Codex reports the input it read from cache inside its input count and nothing about writing to it. So its hit rate is cached input over all input, its sessions are ranked by uncached input, and the screen says so in words. A Codex rebuild is a request that read less than half its input from cache (4,096 tokens or more not read): what it did not read was paid in full and is what the provider caches for the next request, the cost a Claude write stands for. codex-cli 0.160's breakdown has a `cacheWriteInputTokens` field; whether it is ever non-zero for OpenAI models, and whether `inputTokens` includes it, is not measured, so it is not read |
| Kept in the host's memory, a day at most and 50,000 requests per tool | The windows are hours, and the figure is read only when someone looks at the gauge. A table would be a migration and a write per request for that; a restart loses only what the screen then admits (`countingSince`: the window is named "since 14:02" and the dropdown says earlier requests are not known). Nothing runs on a timer: entries are appended as requests close, old ones dropped on the next append, and the sums are taken on `agents.usage`. The gauge already asks that every 5 minutes, so the tooltip costs no new question |
| The donut's own window, not the gauge's weekly one | A week does not fit in memory across restarts, and what someone acts on (an idle session whose cache expired, a model switch) shows within hours |

**Why a rebuild happened.** Each rebuild is given a likely cause, from what the host saw in that
session between the conversation's previous request and this one. The manager tells the ledger as
things happen (`CacheLedger.note`); the next request of the session's own conversation takes the
notes, rebuild or not, so a note never outlives the request it was about. The dropdown says the
causes in one line under Rebuilds ("6 rebuilds: 3 cache expired (idle 64 min) · 1 model change ·
1 compaction · 1 unknown") and under each session it names. It is a guess from evidence, not a
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
a record but the words is read by the adapter's live normalizer (`normalizeMessage` for a Claude message,
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
