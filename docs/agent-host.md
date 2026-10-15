# Agent Host — the Node sidecar design

A standalone Node process. In dev the developer starts it directly (`pnpm host`); in the packaged app the keeper (`centralu-keeper`, §4.1) spawns and watches it, and in `pnpm app:dev` the Tauri app does. **It has to behave the same whether or not a UI is there** — the UI can be closed and reopened many times (reconnecting) and the host keeps its sessions.

## 1. Internal structure

```
agent-host/src/
├─ main.ts              # CLI (--port --token --db --watch-parent), the wiring of the services,
│                       #   each start step marked against lifecycle/start.ts's START_ORDER
├─ lifecycle/           # the process's start and ending (runtime-unification.md step 3):
│                       #   launch-env (variables read once, deleted), start (the order as data,
│                       #   the final refusal), gate (nothing to a screen before the server),
│                       #   steps + shutdown (the ordered, run-once, bounded stop plan),
│                       #   endings (signals, the parent's pipe, crashes, host-errors.log)
├─ rpc.ts               # RPC method dispatch
├─ transport/
│  ├─ server.ts         # ws server, handshake, RPC routing
│  └─ event-log.ts      # assigns seq, ring buffer, afterSeq replay (protocol §1)
├─ adapters/
│  ├─ contract.ts       # AgentAdapter interface + capability types
│  ├─ claude/           # based on the Claude Agent SDK (incl. orchestrator-mcp.ts)
│  └─ codex/            # app-server JSON-RPC client (written here, incl. the stdio bridge)
├─ sessions/            # session lifecycle, orchestrator tools, app guide
├─ dev-services/        # git/fs/store (the store is not dev-only — it is where messages live)
├─ log-file.ts          # tees stderr to ~/.centralu/host.log (stdout is reserved, see below)
├─ env-path.ts          # PATH augmentation — a GUI app inherits no login-shell PATH
├─ tool-launch.ts       # how a found tool is started (Windows .cmd shims, absolute paths)
├─ os.ts               # what differs between OSes, asked by name (architecture.md §2)
├─ data-dir.ts          # locating and migrating the data directory
├─ idle.ts              # the one rule for "is anything running a person would lose" (#352)
└─ updates.ts           # update checks, installing, "apply automatically when idle"
```

Usage parsing and the orchestrator's MCP surface do **not** have their own directories:
per-account usage lives in `adapters/<tool>/usage.ts` (it is a per-tool question), and the
orchestrator's tools are defined once in `sessions/orchestrator-tools.ts` and exposed per
adapter — in-process for claude, over a stdio bridge for codex.

### 1.1 Who gets Centralu's own tools (tool profiles)

Every session gets one bundle of the `centralu` server's tools, or none. One pure rule decides which
(`toolProfileFor` in `sessions/tool-profiles.ts`, from the row's kind, its app and builder slot and
the Settings switch; `toolBundleFor` names the object behind each profile). The manager asks it at
create, at every wake and on every bridge call (`toolProfileOf`), so the three cannot drift apart;
`profileAllows` decides both what the bundle exposes and what its calls may run, so a name the
bundle leaves out is refused even through the Codex bridge.

| Profile | Who | View | Tools | Instructions |
|---|---|---|---|---|
| `orchestrator` | the one orchestrator | every session | all but the builder's | role and usage |
| `scoped` | a coordinator (#80): made only by the control app's tasks, which were removed in #372 with the RPC that created one; the ones in a store still wake with this profile | its members | list, read, send | its boundary |
| `builder` | an app's building session (M4 C-3) | its own app | `check` | build-and-check |
| `reader` | every other session in a project (#320), a former worktree manager included | its own project, read at call time; acts on the agents it started (auto: any session in that project) | `read_session` (no id: lists), `recall`, `app_guide`; `ask_project` (#371, §1.2); `start_agent`, `agent_session` (#561, §1.2.1); and `find_apps`, `attach_app`, `detach_app` (#371 part A, apps.md §9.4) | Centralu's tools first unless the person says otherwise (#564) |

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
with `agent_session` `delete`, keeping local work with the session in the trash (#608, `cleanUpWorktreeChild`). What stayed: the person's own worktree
sessions (the new-session window's option; they now stand alone instead of under a manager made for them), merge and
pull-request detection on every worktree session, and the project's trunk (`worktrees.setTrunk`, the project menu's
"Worktree trunk", kept in the former slot's row). The orchestrator gets no replacement for `propose_worktree_session`:
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

The app-access tools (#371 part A: `find_apps`, `attach_app`, `detach_app`, apps.md §9.4) ride on
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
conversations, `read_session` for this project's other sessions, `ask_project` for another project's work,
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
`scripts/smoke-reader.mts` runs the set end to end with a real model (`TOOL=codex` for Codex).

### 1.2 Asking another project (`ask_project`, #371 part B)

The one reach an ordinary session has outside its project. `ask_project({ project, session?, task? })`
gives a task to an **existing ordinary session** in another registered project and returns its answer.
It never creates a session in another project (#614, owner decision 2026-10-13). Creation remains the
person's action in that project; `start_agent` creates only within its caller's own project. The global
orchestrator, which belongs to no project, retains its own create-session tool.

What one call does (`SessionManager.askProject`):

1. **The project.** Name or id of another registered project, on this computer or on a linked machine
   (§1.2.4). Its own project is refused; an unknown name lists the other projects, each with the machine
   it is on once a machine is linked. Under `safe`/`normal`, an untrusted caller cannot ask, and a child
   started by another session or a session currently handling a cross-project task cannot delegate
   again (depth one). Under `auto` (#603), the caller's own preset opens and logs those boundaries.
2. **The session.** `session` names an ordinary session by name or id. Orchestrators, builders and
   app agents are excluded. Without it, exactly one ordinary session is selected; otherwise the call
   lists the candidates with id, name, state and last activity and asks the caller to name one.
   Duplicate names require an id. No ordinary session means a refusal telling the person to open
   one there. Selection never creates, renames or takes ownership of a session, and the task's
   text never auto-names a "New session" (#646): only the person's own words do, as with an app's
   message. Old `Asked by <project> · HH:MM` sessions remain ordinary sessions; startup removes
   their former cross-project `askedBy` mark, retaining their name and history.
3. **Consent.** `ensureProjectAccess` (`delegate`) raises a card in the caller's session naming
   `<caller project> asks <project> / <session>` and the task. Allow once, always for this project
   pair, or deny; only always is stored in `project_consents` and revoked in Settings → Permissions.
   The card states the target's trust, including in conversation and notification text. Under `auto`
   the card is skipped and logged without saving consent. The selected session keeps its own tool,
   model, effort, preset, project trust and approvals. Availability, the caller's trust and depth, and the target
   project are checked again after consent (`askGateError`). The caller's project losing trust or being removed, or
   the target project being removed, withdraws a card still standing (`withdrawReaches`).
4. **Delivery.** The task travels in `askFrame`, explaining the caller and how the answer comes
   back, and appears in the target conversation with `from` identifying the asking session. An idle
   session resumes as needed. A session busy with a turn that is not the caller's (the person's,
   another delegation, or requests queued ahead) returns the choices instead (§1.2.3, #677): the
   caller passes `ifBusy` `note` (an `auto` caller only, through the adapter's tracked mid-turn input
   path, #594, on a CLI that takes it, and never into another caller's delegation) or `queue`; no
   fork across projects. No interrupt or CLI-specific logic is added to the manager, and another
   delegation's watcher is never replaced. `AgentRunWait` holds until the delivered input's receipt completes,
   even if the CLI queues it into a later turn; an earlier turn's answer cannot finish this call.
5. **The answer.** Final text is JSON-quoted as another session's words and clipped after 6,000
   characters. Named files and folders inside the target project, resolved through symlinks, become
   readable to the caller for this host's lifetime (`readGrants`); the project root is never granted.
   Outside paths are listed without grants. Claude checks grants on each read through `mayRead`;
   Codex's reads are already unrestricted.

**Long work.** A call waits up to `ASK_WAIT_MS` (240 s), below the Codex MCP ceiling of 300 s and
bridge wait of 280 s. It then answers still working, naming the session and how to call again with
`project`, `session` and no task. Without `session`, one outstanding call in that project is enough
to continue waiting, even if another session was opened meanwhile. Multiple outstanding tasks need
an explicit session. A new task cannot replace unfinished work in the same session.

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
| A session busy with a turn, or `ifBusy`, is refused with a reason; the machine's sessions are read again after the card is answered, and nothing is sent if the session left or started a turn meanwhile | A note or a queue into a session on another machine needs the machine to take them; not built. The card can stand for minutes, and a task sent into a turn the person started there would join it and end the call with their turn |
| A machine's project list is waited for 4 s (`LOOKUP_MS`); one that does not answer is counted as away | The name is looked up on every call, so one half-open link must not hold up the asks that name something else. The name that is on this computer and on a machine is still refused as ambiguous when the machine answers; when it does not, the call goes on with what was heard |
| A link that is no longer connected ends the tasks asked of its sessions (`observeLinkLoss`, on `machine_status`) | Their events stop reaching the hub, so the end of the turn would never be seen. The sentence says the task was delivered and may still be running there |
| `trusted` is carried only when the machine says it | An older machine's absence is "not saying" (`ProjectAccess.to.trusted`), not "not trusted" |
| Cancelling the call stops the wait, not the machine's turn | This host asks the machine to run a task but has no interrupt of its own turn there |
| The machine's own cards are answered by the person in the hub's window | `asking` (the caller answering them) is not built across machines; the call says it waits on the person |

### 1.2.1 Starting other agents in the same project (`start_agent`, `agent_session`, #561)

An ordinary session can start another agent, Claude or Codex, in its own project and work with it: a Claude session
hands implementation to Codex and reviews the result, without a shell `codex exec` the app does not show. Built on
ask_project's machinery (`Delegation`, `AgentRunWait`, `ASK_WAIT_MS`, `finalAnswer`), in the reader set with its
own budget (`AGENT_TOOLS`, `AGENT_BUDGET_CHARS`).

| Tool | Arguments → what comes back |
|---|---|
| `start_agent` | `{ task, tool?: string, model?, effort?, wait?, worktree?, branch?, lsp? }` → the child's id and name, and its answer (`done`) or `working`; or `pending` with a request handle while the person's card stands (#673), or, with `lowMemory`, while an allowed start waits for memory (§1.2.4, #686). `lsp: true` keeps the child's code intelligence (§1.2.4) |
| `agent_session` | `{ sessionId, action: status\|send\|wait\|stop\|delete\|answer, text?, card?, ifBusy? }` → the same states, plus `at_rest` (nothing the caller gave it runs; its last answer), `asking` and `answered` (a card in the turn the caller gave it, §1.2.2, #676), `busy` and `queued` (a send to a session busy with a turn that is not the caller's, §1.2.3, #677), `stopped` and `deleted` (a child moved to the trash; worktree cleanup also preserves local work, #608/#637) |

The optional `tool` is a registry name, accepted as a string by the schema and checked against the
current registry at call time. An unknown name returns an error listing the installed tools; adding
an adapter does not require changing this schema.

Under `auto` (#603), the host's shared `autoBoundaryOpen` decision opens consent, depth,
project trust and same-project ownership gates, with allowances logged. Worktree cleanup keeps local work
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

What one `start_agent` call does (`SessionManager.startAgent`), with the refusal/card rules
below retained for `safe` and `normal`:

1. **Who may.** An ordinary session (`reader` profile) of a trusted project (#382's rule), not one marked `askedBy`:
   depth one, so a child cannot start agents, and neither can a session handling an active ask_project task.
2. **How many.** Settings → Orchestrator → Running agents per project persists `prefs.agentCeiling`,
   read at call time. Empty/null means no ceiling under `auto`, `AGENT_CEILING` (4) otherwise;
   zero is unlimited, and a positive integer sets a ceiling per project over all its sessions.
   A child counts while a delegated turn runs. Checked before the card and again after it,
   and for a new `agent_session send` turn. The check after the card also takes the place (#673 review,
   `agentStartReserved`): one synchronous step, held through `createSession` until the child's delegation counts it,
   given back if the start fails, so calls at once cannot pass the ceiling together. A fork takes its place the same way
   (`reservePlace`). A request still waiting on the
   person's card holds no place: it may stand for hours, and is counted when it is approved.
3. **Choice.** `tool` defaults to the project's tool; `model` and `effort` to that tool's remembered choice for the
   project (#107). A model or effort the tool's list does not have is refused with the list (`agentChoiceError`;
   an alias the ids or labels contain passes, and a tool that cannot list passes all). The check never holds the call
   (#660): it uses the cached list (one read at a time, kept whenever it arrives, a failed read not retried for a
   minute) and waits at most `START_AGENT_MODEL_CHECK_MS` (3 s) for a missing one; without a list in time the child
   starts on the name as given and the answer says it was not checked (an empty list is said to be empty). A name the
   cached list lacks is refused only after a fresh read (the CLI may have been updated).
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
   raised again (`raiseHostAsks`, not recorded twice) when that turn ends, unless it ended in an error. While it stands
   the request is in the store's `agent_start_requests` (v50): a host swap or restart leaves the row (the leaving
   host's call answers `pending`), and the next host raises the card again (`resumeAgentStart`) and starts the child
   when it is approved. An approval (here or there) first reads again what the start rests on (#673 review): the
   caller is still here, its project still trusted, it is still allowed by depth one (it may have begun handling an
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
   and that the final message is the answer) recorded as sent by the caller (`from`).
6. **The answer.** Waited for like ask_project's, up to 240 s; past it, or with `wait: false` at once, the answer is
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

**In a new worktree** (part 2). `worktree: true`, or a `branch`, opens the child in a new git worktree of the
project's repository instead of the caller's folder, through the same path as the new-session window's worktree
option (`createSession`'s `worktree`, `worktreeBranch`, `worktreeBase`: the copy-and-setup step;
`auto` delegation may also create a worktree in an untrusted project). The branch is the one asked for (git's own rule checks it) or one named from the job (`agentBranch`:
`centralu/write-the-parser-1a2b`), settled before the card, which names it. It forks from the caller's own branch
when the caller is itself a worktree session, so the child starts from the caller's work; otherwise from the
project's trunk. A project that is no git repository is refused before the card. The child shows as every worktree
session does (its branch is its name; merged and pull-request state, #69/#76), and paths its answer names in the
worktree become readable to the caller. A boolean and a name rather than a `workspace` enum: each is cheaper, and
either alone says what is meant. A worktree child hangs under the session that started it in the sidebar,
as a same-folder child does: the sidebar groups by who started a session (`askedBy`, `orderAsTree` in
`ui/features/sidebar/tree.ts`), and `parentSessionId` still places a former worktree manager's sessions.

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
requires the verified CLI protocol (2.1.289 or newer) and its `interrupt_receipt_v1` and
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
finish or be stopped first. A missing worktree folder is refused with its path and a request to restore it;
the live/stored session retains worktree metadata (only the trash list hides missing folders), so it never
becomes a same-folder deletion. Cleanup refuses a child still waking/restarting, blocks sends/resumes, and requires
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
index, HEAD tree, and every unmerged superproject commit against their remote refs. Candidate gitlinks
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
must use `purgeSession` if added. Gitlinks found only in older merged superproject history remain a
follow-up ([#623](https://github.com/ijun17/centralu/issues/623)); a superproject merge does not prove
that module commits were pushed. Writes by other programs during capture are outside this session's lock.

**Size.** The two definitions are 1,085 characters (`AGENT_BUDGET_CHARS` 1,100; 1,060 before #686's `lsp`, which carries no description; 990 before #677's `ifBusy`, 956 before #676's `answer` action and `card`, 992 before the registry-name schema, 918 before the worktree arguments, 974 before `delete`). Claude loads `start_agent` (a request
made in words, like ask_project's, which deferred was not found) and defers `agent_session`, which every
`start_agent` answer names; Codex reaches both through its `exec` tool. Measured in tool-cost.md §10: +170 tokens per ordinary Claude request (412 → 582); "Have Codex …" reached `start_agent` 3 of 3 on Claude, "another agent" went to each CLI's own sub-agents. No `name` argument: the child
is named from its task and the person renames it.

**stdout is reserved.** `main.ts` prints exactly one line to it: the handshake the Tauri
supervisor parses for the port and auth token. Everything else goes to stderr, because that
is what `log-file.ts` tees to `~/.centralu/host.log` — and a `.app` launched from Finder has
no stdout destination at all, so a `console.log` here reaches nobody in production while
looking fine in a terminal. `no-console` in `eslint.config.js` enforces this everywhere in
the package except that one line.

**On Windows (#14)** the host runs on the direct path (there is no keeper), started by the app
with no console window; its children share that windowless console. Processes differ in four
ways, each in one place:

| What | macOS and Linux | Windows | Where |
|---|---|---|---|
| Finding a tool | PATH, augmented from the login shell | PATH with PATHEXT, absolute entries only; npm/pnpm `.cmd` shims read for the `.js` or `.exe` they start, and Node's own `npm.cmd`/`npx.cmd` (a different shape: variables, and a newer npm in the global prefix preferred) for their `npm-cli.js`/`npx-cli.js` | `env-path.ts`, `tool-launch.ts` |
| `git`, `gh`, an app's command | by name | by absolute path: given a bare name, Windows looks in the working directory (the project) first | `tool-launch.ts` `programPath`, `resolveCommand` |
| Ending a tree | process groups, TERM then KILL | `taskkill /T /F`, one shot; a pty's `kill()` gets no signal. What an app left running after it ended is found by parent links and creation times (one PowerShell CIM listing, ~0.5 s) and ended the same way | `dev-services/kill-tree.ts` |
| Terminal / Run button | login shell `-l` / `-lc` | `pwsh` or Windows PowerShell, `-NoLogo` / `cmd.exe /d /s /c` | `dev-services/terminal.ts` |

Quitting closes the host's stdin (it runs with `--watch-parent`, so EOF runs the same shutdown as
TERM) and ends its tree with `taskkill` only if it is still running after the grace period. A
worktree setup command runs under `cmd.exe`, so it reads `%CENTRALU_WORKTREE%`, not
`$CENTRALU_WORKTREE`.

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
`agent_session` send that starts a turn, and `send_to_session` to a session at rest. A task or note that joins a turn
already running (the person's, or someone else's) gives no one that turn.

- **The link** (`turnOwners`, `ownTurn` / `releaseTurn`): session → the session that gave it the turn. It ends with
  the delegation's outcome (`startDelegation`), or with the turn for `send_to_session`. A card from a later turn the
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
| `queue` | Held (`queued`, `enqueue`) and delivered as a new turn B owns when A's running turn ends (`drainQueue`, from the turn's end and the boundaries that free a session): B's delegation for `agent_session` and `ask_project`, its turn for `send_to_session`, each framed as that tool frames its work, with the report when it ends and its cards (§1.2.2). One at a time, oldest first. The answer is a handle (`qr-…`) and the place in the queue; `agent_session` status (or `ask_project` with no task) says where it stands, `stop` withdraws it. Written to `queued_requests` (store v52): `detachAll` delivers nothing (`handingOver`), and the next host delivers a request when the kept session's turn ends there, or soon after start for a session at rest (a kept one after its adoption, so its input never starts a second process). A request whose session or requester is gone is dropped, as are those of a trashed session. Before it goes in, the request tool's gates are read again (`queuedGateError`: ask_project's trust and depth and the target project; agent_session's preset rule), and a request that fails them is dropped with its requester told. Its caller's project losing trust or being removed, and the person revoking the pair, withdraw queued `ask_project` requests the same way (`withdrawReaches`). **Delivery** (#684 review): one drain per session at a time (`delivering`), which reserves the session before its first await, so waking a sleeping session counts as busy and lets no second request in; the request stays first in the queue and its row stays, marked `delivering_at`, until the session's turn actually starts, and only then is it taken off. A swap or crash in between leaves the row, and the next host delivers it again: at least once, with one duplicate possible when the old process took the input without a word before the swap. A deferred restart is not waited out by the drain (`deliver` waits for it), and its end schedules the drain again. A retry of the same request (requester, tool and words) returns the handle already held instead of a second entry. |
| `fork`, `fork_read` | A sub-session from a copy of A's conversation now (`forkFor`): the adapter's `forkConversation` (Claude: the SDK's `forkSession`, which writes the copy beside the original's transcript; Codex: `thread/fork`), resumed with its history on screen (`importHistory`). An adapter without it, a session with no conversation yet, and `ask_project` (which never creates a session in another project) are not offered a fork. start_agent's gates apply: depth one, the project's trust (#382; #673's consent rule as `ensureAgentConsent` has it) and the per-project ceiling; once the card is answered the gates are read again and a place is taken before the copy is made (`reservePlace`), and the project losing trust withdraws a card still standing. The preset is the lowest of B's and A's. `fork` gets a worktree of its own (`agentWorktreeBranch`, branched from A's branch when A is a worktree session; a project with no git repository is refused and pointed at `fork_read`); `fork_read` is read-only work in A's folder under at most `safe`, so two agents never write one folder. Linked to B: `askedBy` B for a same-project ordinary session (the orchestrator through the delegation alone), its turn B's delegation (the report, its cards), and `forkedFrom` A (`sessions.forked_from_session_id`, store v52), which the sidebar uses to hang it under A, ahead of `parentSessionId` and `askedBy` (`orderAsTree`, `foldGroupsHiding`). |

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

### 1.2.5 A handoff takes the live children along (#693)

A handoff (`createSession` with `handoff.fromSessionId`, the session handoff of domain-model §1.1) used to leave the
original's children where they were: their reports woke the original, which the person had stopped working in (and
usually deleted next), and the new session could not reach them, since `agent_session` works only for the starter. The
new session now takes over the original's **live** work as it is created, before its first turn reads the note
(`moveLiveChildren`, owner decision on #693):

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
- **What stays**: a settled child (finished and reported or read, nothing pending) stays with the original, so its
  history stays where it happened, and is deleted with it or left on its own as before.
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
- **Who may hand over** is not checked here: `moveLiveChildren` trusts its caller. Today only the person's handoff
  calls it; an agent-facing handoff (#694's orchestrator tools) must check its authority over the original first.
- **Atomic**: everything stored moves in one transaction (`Store.moveChildren`); the host's memory follows after the
  commit, with no await in between. A crash before the commit leaves every link on the original, after it every
  link on the new session, so a host taking over after a swap or a restart reads one owner (`report_marks`,
  `delegated_turns`, `queued_requests` and `agent_start_requests` are read at startup as before). If the store refuses,
  nothing moves and the note lists nothing. A delegation's end releases its turn by the delegation's owner at that
  time, not the one that started it.
- **The windows** hear `session_owner` (the session's `askedBy` and `parentSessionId` now) and hang the child under
  its new owner; a linked machine's event is qualified (`Qualifier.event`) and patched into the hub's mirror.

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
hub's orchestrator does not see the linked machines; their projects are made from that machine's +. A
clone also says "Cloning … into …" in the orchestrator's conversation once Create is chosen, while the call runs. The
swap left the orchestrator's resident set smaller than before (`residentCost`, Claude: 11,798 → 11,620 characters, and
11,770 with the clone's arguments; docs/tool-cost.md).

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
  parentCallId?, ambient?, stopsWithTurn?, stoppable? }`. `stopsWithTurn` is what interrupting the turn does to it,
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
    (`applyDeferredRestart`). A restart that ends background work, or work that is unknown, says so in the
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
- Process management (spawning the CLI, crash detection) is the adapter's own responsibility. A crash is emitted as an `error` event and the host does not die.
- A capability is not necessarily a static declaration; it can be **decided at detect() time** (e.g. if whether approvals work depends on the Codex version, decide after detecting the version — the C4 response).

### 2.1 Claude query options and independent-session messaging (#569)

`ClaudeSession.start` is the single SDK `query({ options })` construction site. Both
`SessionManager.createSession` and the resume/wake path use it, for ordinary sessions,
orchestrators, coordinators, worktree managers, builders, app agents and `start_agent` children.
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
   hand-won protocol knowledge rots silently otherwise.
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
logs every request it answers with `{}`.

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

**One host per data folder** (`dev-services/instance-lock.ts`). Two hosts on one folder would each hold their own session list and write to the same `store.db`. Ownership is an exclusive SQLite transaction (`BEGIN EXCLUSIVE` on `host-ownership.sqlite`, DELETE journal mode) that the host holds for its whole lifetime (#82): taking it is atomic, a second host is refused at once, and the operating system releases it when the host dies, however it dies, so a crash leaves nothing stale. `host.lock` (pid and start time) remains as the description of the owner in the conflict message, and nothing more: until #461 a live, matching `host.lock` also refused the start, for hosts from before #82 that knew only that file. Before #82 ownership was the file alone, checked and then written: 8 hosts started at once produced 2 owners. This is single-machine ownership — not a distributed lease, and not for a data folder on a network filesystem.

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

Not decided by the window, each in its own place:

| What | Where it is decided |
|---|---|
| What the shell does once opened: install or keep, pinned or not, verify, copy, and the reasons it refuses | `shell::prepare`, `shell::install::plan`, `shell::start::start` in the window; the shell crate ([plans/thin-shell.md](plans/thin-shell.md) §10.1, §10.2) |
| A keeper started directly handing itself over (§4.4): to the `centralu-keeper` the window names (since #444). An executable of any other name (a window from before #440 names its own) is refused and the keeper stays on its build (#461) | `server::switch`, `server::upgrade`, `handoff::give` |
| A keeper from verified content handing itself over: verifies and copies the new content, then hands over to `<data>/content/<new>/centralu-keeper` | `server::content_route` (§4.4) |
| `centralu serve` on a remote: the npm launcher runs the bundled host on the system Node; no window, no keeper | `packaging/npm/centralu/bin/serve.mjs` (§4.7) |
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

**The legacy folder.** Before anything creates the default data folder, the app and the keeper move the
pre-rename folder to the new name by the same rule as `data-dir.ts`: the host leaves a legacy folder alone once
the new one exists, so creating `~/.centralu` first (for `keeper.log` or the socket) would strand the data.

**One keeper per data folder.** `flock` on `<data>/keeper.lock`, released by the OS however the keeper ends.
A second keeper whose predecessor answers on the socket exits with code 3 and starts no host; one whose
predecessor holds the lock but does not answer (on its way out) waits up to 15 s for it.

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

**Token and address from the keeper.** Under the keeper the host gets `CC_HOST_TOKEN` (the front door's token,
the same for every host the keeper runs) and `CC_FRONT_DOOR` (`ws://127.0.0.1:<door>`), and deletes both from its
environment once read, so terminals, agents and commands do not inherit them. The Codex bridge is started with the
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

- **Agents.** The manager passes the adapter a `ProcessSource` (`adapters/contract.ts`): `spawn` in the keeper,
  or `adopt` a kept process. Claude gets it as `spawnClaudeCodeProcess`; `CodexClient` takes the process instead
  of spawning. `KeeperAgentProcess` has the `ChildProcess` surface both use, but `kill()` is a keeper request for
  the CLI's whole process group (below) that is never sent once the process is detached or the host is exiting
  (the SDK kills its processes on owner exit), and `stdin.end()` is `close_stdin`. Codex request ids carry a per-client prefix, so an answer to the previous
  host's request cannot resolve one of ours.
- **Terminals and commands.** `TerminalService` and `CommandRunner` take the keeper's pty module (`KeeperPty`,
  node-pty's surface) instead of node-pty; stopping or closing them walks the process tree (`kill-tree.ts`), which
  works from anywhere. Closing a terminal takes the tree before the shell gets its hang-up: a dev server started
  from it is in a group of its own (job control), and one that ignored the hang-up used to be left running.

**What stopping an agent ends.** An agent CLI starts helpers of its own: Claude Code's LSP tool runs
`typescript-language-server`, which runs `tsserver` (one reached 3.4 GB); MCP servers from the user's config; shells.
They share the CLI's process group, which `setsid` made the CLI's own, so the group is the CLI, what it started, and
nothing else. A stop signals that group: the host's TERM, and the KILL that follows when the CLI is still there after
its grace (the SDK's 5 s; codex's 2 s after EOF), reach the helpers too. And whenever an agent exits, however it ended
(a stop, a crash, a CLI that does not clean up), the keeper sweeps its group: TERM at once, KILL 2 s later to whatever
is still in it (`Sweep`, `keeper/children/mod.rs`). Before, only the CLI's pid was signalled, and what it left was
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
times and ended (`collectOrphansWindows`). Being in a group of its own, the CLI is no longer in the host's: a host
that is SIGKILLed takes it along only through stdin EOF, on which codex exits at once and claude after the turn it
is in. The SDK adds the end of the CLI's stderr to a failure only for a process it spawned itself, so the adapter
adds it the same way.

**Leaving** (`lifecycle/shutdown.ts`, `stopPlan(mode)`). *Detach* — SIGTERM, SIGINT, SIGHUP, the keeper's pipe closing, an
uncaught exception, a swap's drain — calls `detach()` on every session handle, terminal and command run: nothing
is sent to the tool, a waiting approval stays waiting, and output still in flight is recorded before the store
closes. App processes and the in-process tool servers stop, as they live in the host. *Stop* — the keeper's `stop`
event, or any ending without the child service — is the old path: sessions disposed, terminals and runs killed.
After a stop the keeper ends whatever is left (stdin EOF and SIGHUP, 2 s, TERM to each group, 1 s, KILL), and
what exited agents left in their groups.

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
handover (§4.4) their parent is init, and the parent chain alone would offer them as leftovers.

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
| Never while it waits on others (`waitsOn`): a child it started with `start_agent` (or a session handling its ask_project task) still in the turn it gave it, a session it owns (`askedBy`; a former worktree manager's worktree sessions, #561) while that one works, or a session that owes it a report (`reportBack`) | Their answer comes back to it in moments, and waking it for that costs the resume it saved. A child waiting on its parent sleeps by the ordinary rule: it is idle |
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
`adapters/claude/normalize.ts`) and lists each pending one with the session's background tasks (kind `other`, not
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
| An app request cancelled mid-turn fails its wait before it interrupts the session | Claude's adapter ends the turn the moment it is interrupted, so the wait read the cancel as "stopped before it finished" |
| Classify and surface; never resend by itself | A resent turn can repeat side effects (a push, a comment, a release). Continuing is one message from the person or the asker, the same sentence both ways: "Continue where you stopped. Check what already happened before repeating a step." Auto-resend on reconnect could come later as an opt-in |
| A Codex `interrupted` turn ends as a Stop does (`state_change waiting_input`), not as `turn_complete` | `turn_complete` is "finished": the orchestrator was told the work was done. A wait on the turn (`AgentRunWait`) ends on the interrupt, since no `turn_complete` follows it now |
| The Codex adapter tells its own interrupts from Codex's and logs which (`interruptsSent`, "interrupted by a stop from Centralu" / "by Codex"). A Stop that lands while a note's `turn/start` is in flight interrupts the turn the answer names, and counts as ours too (`takeInputTurn`) | The real case could not tell whether the person's Stop, the host or the CLI sent it |
| The person's Stop, and an orchestrator's `agent_session stop`, set nothing | They know; flagging their own act would be noise |
| Only `retrying` starts the `reconnecting` clock, never silence | A session polling CI with 15–40 s sleeps looked frozen and was not; long builds look the same |
| A report owed for the turn names the reason first ("stopped before finishing: a network error ended its turn", "its tool interrupted the turn") and how to go on | "The assigned work failed" made the asker redo or abandon work that only needed a "continue" |
| When no report is owed (no report mark, no call waiting on the turn now), the session that gave the turn hears once of a `network`, `interrupted` or `quit` stop (`tellAskerOfInterruption`): a delegation's caller nobody waits for now (`ask_project` or `start_agent` past its bound), else the session that started it (`askedBy`). A call still waiting reads the stop from its own answer | The 2026-10-15 case, and an `ask_project` turn whose session has no `askedBy`. One report per stopped turn; another needs another turn, so two sessions cannot wake each other in a loop |
| A `quit` is told at the next start, once per child, to the first that still exists of: the session owed its report, the one that gave the turn (`delegated_turns`), its `askedBy` (`quitNotices`, after the keeper's adoption for a kept one). A kept process that cannot be re-attached settles its report the same way. **No requester that is itself stopped by a quit** is told, at the start or later: it waits for the person's Continue | An asker that delegated without waiting was at rest, not cut, and its report mark used to be dropped: it never heard. Waking it once costs a turn; never hearing costs the work. An orchestrator the same quit cut would be resumed at launch with nobody there, and that turn would clear its own "stopped" mark before the person saw it; its children's rows say they stopped once it is continued |
| The orchestrator's list (`list_sessions`, and `read_session` with no id for a reader) and `agent_session status` add "stopped: network error", "stopped: Centralu quit during its turn", "stopped: its tool interrupted the turn" or "reconnecting to its API for N min" to the row. No filter argument | The row already says it, and an argument rides in every request's tool definitions (docs/tool-cost.md). `agent_session`'s list (#690) does not exist yet |
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
| `autostart` | Additive: `{ on, how, linger }`. `how` is what this machine starts its host at boot with (`systemd`, a scheduled `task`), null where it offers nothing; `on` whether `--autostart on` wrote that entry; `linger` (systemd) whether the user's manager starts at boot or only at login. Read from `<data>/autostart.json`, the mark `--autostart` keeps, so no link start asks systemd or Task Scheduler |
| `install` | Additive (the line stays `v: 1`): `{ managed, current, previous, node }`. `managed` is whether the managed launcher of an install the app made over ssh ran this command ([plans/remote-hub.md](plans/remote-hub.md) §10.1); `current` and `previous` are that install's pointer files as `{ version, node }` (null when absent or not two plain words); `node` is the Node that answered |

stdout carries that line and nothing else; anything to explain goes to stderr. If the command is not found (exit 127),
the SSH shell's PATH lacks npm's global folder (nvm, fnm, volta and `~/.npm-global` set it only in interactive
shells): use `~/.centralu/bin/centralu`, which `serve` and `--connection` keep pointing at this install and this Node
by absolute path. Those paths are versioned under nvm and Homebrew, so after a Node upgrade the launcher fails until
`centralu serve` (or `--connection`) runs once from an interactive shell and rewrites it.

| Decision | Why |
|---|---|
| A launcher starts the bundled host on the system Node; no keeper | The same `resources/host` the app runs, so a remote host is not a second build to keep working. The keeper exists to swap builds under a window and to hold agents across restarts; a headless host needs neither yet |
| Bound to 127.0.0.1 only, reached through an SSH local forward | SSH already authenticates the person and encrypts the link. A public port would need TLS and a login of our own, and every scanner on the internet would find it |
| The token lives in `<data folder>/serve.json`, mode 0600 from the first byte, narrowed back if it drifts | It is the key to every RPC on that machine. `--connection` prints it and nothing else does: the host's ready line, which carries it, is read by the launcher and never passed on |
| The token reaches the host in `CC_HOST_TOKEN`, not `--token` | Any user on the machine can read another's command line (`ps`); only the owner can read a process's environment. The host deletes the variable after reading it |
| Token and port are generated once and kept | The client stores them and reconnects without an SSH round trip; it runs `--connection` again only when a hello is refused |
| Default port 17175 | Below every OS's ephemeral range and below the host's per-app view origins (20000–32767, `views/origin-ports.ts`) |
| A recorded or default port another program holds moves to the next free one above it (up to 19 more, below 20000) and is recorded; `--port` is used as given | One Windows laptop linked twice, its Windows side and a WSL distro, had both hosts on 17175: WSL2 relays the distro's loopback ports to Windows (`wslrelay.exe`), so the second could not start (#482). Inside WSL, the ports Windows listens on count as taken too (`netstat.exe` through interop): a host there on such a port would be unreachable, because the hub's forward ends on Windows' loopback. `--connection` reports the port the host got |
| The host gets its own process group and `--watch-parent` | Ctrl+C reaches the launcher, which passes one SIGINT to the host alone, and the host stops its agents in order. Killing the launcher, even with SIGKILL, closes the host's stdin and takes it down: it is never left running unsupervised (`tooling/launcher-serve.test.ts`) |
| A signal during startup is held until the host can shut down | Before the host attaches its handlers the kernel's default applies and ends it on the spot. Measured: a SIGINT passed on as soon as the ready line was read killed the host every time. Now it shuts down cleanly once started; a second signal while starting exits at once (`lifecycle/endings.ts`, `holdSignals`) |
| A second signal forces the exit only when it comes 1 s or more after the first; SIGHUP shuts down like SIGINT and SIGTERM | A person pressing Ctrl+C again, while starting or while shutting down, gets the host gone at once (exit 1); a shutdown is also bounded at 10 s (`lifecycle/shutdown.ts`). One request often arrives as two: Ctrl+C reaches the launcher, which forwards a SIGINT, and the terminal may deliver its own; a closing terminal sends SIGHUP right after SIGINT. Within `REPEAT_AFTER_MS` (1 s, `lifecycle/endings.ts`) the second is the same request and changes nothing, so it cannot cut the shutdown it asked for short (owner, 2026-10-12, #504). Without a listener SIGHUP's default ended the host with no shutdown at all |
| A second `serve`, or any other host on the same data folder, is refused | The ownership lock (`instance-lock.ts`) is the authority. `serve` first asks the port it recorded, so a serve already up is named with its port; for any other owner the host's lock message is followed by a line naming the pid |
| No `DISPLAY` / `WAYLAND_DISPLAY` in the host's environment | Nothing it starts can open a window or a keyring dialog nobody would see; a tool that would ask falls back to its file store or fails with a message in the log |
| Windows: no own group, no forwarding | `detached` means a new console there; the host shares the launcher's console and gets Ctrl+C itself. Not exercised yet |

**Keeping it running without a session: `--detach` and `--stop`** ([plans/remote-hub.md](plans/remote-hub.md) §10.4).
The hub runs `centralu serve --detach` over ssh when it finds no host running (§4.8), and a person can run it too.
It starts the same `serve` as a launcher outside the session that asked, then returns once that launcher's host
answers a hello, so the caller can connect at once:

| Where | How it is started | Why (measured, plan §10.4) |
|---|---|---|
| Linux, macOS | A new session (`setsid`) with no terminal and no stdio; reparented to init once `--detach` exits | Nothing of the ssh session's process group or terminal reaches it (`tooling/launcher-serve.test.ts` kills the whole group and the host still answers) |
| Windows | `Win32_Process.Create` through WMI (`Invoke-CimMethod`), from Windows PowerShell 5.1 by full path | Windows' OpenSSH ends every process of a session with it, `Start-Process` included; a process WMI creates is not in the session |
| WSL (`WSL_DISTRO_NAME` set and interop on) | The same WMI call, from `powershell.exe` reached through the drive WSL mounts, creating `wsl.exe -d <distro> -u <user> --cd <folder> --exec <node> <centralu.mjs> serve …` | WSL stops a distro about 15 s after its last `wsl.exe` client exits; this `wsl.exe` is one for as long as the host runs. On the test laptop a WMI-created `wsl.exe` later hung without running anything (plan §10.4); that is reported as `wmi_blocked`, and the hub runs the host link-bound |

A process WMI creates gets the account's default environment, not the session's, so what the launcher needs from the
`--detach` that started it travels in one internal argument (`--detached-child=<base64 JSON>`): the log file, and
`CC_DATA_DIR`, `CENTRALU_HOST_ENTRY` and `CENTRALU_MANAGED` when set. Never the token, which stays in `serve.json`.
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
| Windows | A scheduled task "Centralu host" for this user at their sign-in (`Interactive`, no administrator, no stored password), running `serve` in a hidden Windows PowerShell window, on battery too, with no time limit (Task Scheduler's default ends a task after 72 hours) | Starts at sign-in, not before it (with automatic sign-in, that is boot) |
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
| Link | `links.ts` (`LinkedMachine`) | One per machine: transport, version check, client, backoff, status, the hidden-session set, the mirror's updates |
| Client | `remote-client.ts` | The hub's WebSocket to the remote host: hello, cursor and epoch, calls, events, terminal frames |
| Router | `router.ts`, `routes.ts` | In front of `HostServer.onRpc`: sends a call to the machine its ids name, merges lists, answers the rest locally |
| Qualifier | `qualifier.ts`, `machine-ids.ts` | `<machine>.<id>` on the way in, stripped on the way out; numbers folded per slot |
| Mirror | `stored.ts`, store v46 `machine_headers` | Each machine's sessions and projects as last listed, for when it cannot be reached |
| Installer | `install.ts`, `registry.ts`, `remote-install.mjs` | `machines.install`: preflight, the pinned Node and the npm packages on the remote, checked against the release's pin and the registry's signed metadata (below) |
| Update | `update.ts` | `machines.update`, `machines.rollback`, `machines.uninstall`: stop the remote's host, switch its pointers, start and check, or put back (below) |
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
a link-bound host's log. Output is decoded as a stream, so a character split between two chunks stays whole.

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
| 1. Node | Downloads the pinned archive from nodejs.org, compares its SHA-256 with the one the hub sends from `remote-runtime.json`, unpacks it with the system's tar (`System32\tar.exe` on Windows) into a `.partial-node-*` folder, keeps only `bin/node` (`node.exe`) and `LICENSE`, and renames it to `<data>/remote/node/v<N>/` | Sends the archive's name and hash; reads `CENTRALU-INSTALL node ok` or a failure code |
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
| Boot entry | — | — | `serve --autostart off` through the lookup (§4.7), after the stop. Not removed: nothing is removed. A version older than `--autostart` is passed by (it cannot have written one from here) |
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
(ssh failed, the forward or the socket dropped; retried with backoff from 2 s to a minute); `starting` (no host ran
there; the link is starting one, above); `updating` (the hub is stopping, switching or removing the Centralu it installed there; the link waits, above); `not_running` (Centralu answers there but no `centralu serve` runs, and
starting one failed, `error` says why; retried); `versions_differ`; `refused` (a token refused twice in a row:
the connection line is read again once at once, since `--rotate-token` changes the token a running serve keeps until
it restarts).

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
the machine's relayed events for the end of that turn and reports it as for a session here.
`update_session_settings` and `create_session` go through the router (`agents.updateSettings`,
`agents.createSession`), a project found by name or qualified id on any reachable machine, a name two machines share
refused with the ids. `create_project { machine }` raises the same card, naming the machine (`project_create`'s
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
| Sidebar | Once there is a linked machine, groups by `machine`: this computer first (with "Your apps"), then each machine with its name and link state (`connected`, `connecting`, `away`, `version mismatch`, …), its projects and its user-folder apps. A project or session of a machine that is not connected stays listed, dimmed (`data-away`), and is never woken. A machine's + adds a folder there by its path (`projects.add {path, machine}`) or makes a new, empty one, in that machine's `~/Centralu` by default (`projects.create {name, parent?, machine}`, §1.3); its name opens Settings → Machines |
| Settings → Machines | `machines.list/add/remove/reconnect`. Add a machine lists the hosts of this computer's ssh config (`machines.sshHosts`, read again each time it opens), each with what `ssh -G` resolves and "linked as …"; picking one probes it (`machines.probe`) and offers ready rows, "Windows" (with the shell that answers ssh), "WSL (<distro>)" (the default marked) or "Linux or macOS", with a name, the first row not linked yet chosen (`probeChoices` in `@cc/core`). A row already linked through that alias is shown but not offered. A probe that cannot tell says why in one sentence (`probeProblem`), and "Enter a target by hand" keeps the typed fields, prefilled from the host picked; with no hosts in the config, the dialog opens on them. A probe answering after another host was picked is dropped. Each row says the last error as what to do (`machineProblem` in `@cc/core`: a key not loaded, a host key never accepted, Centralu not installed or not serving there), and holds the version prompt. Where the machine offers it, a "Start Centralu when <machine> starts" switch (`machines.autostart`, `autostartRow` in `@cc/core`), with a line where it falls short of boot: a systemd manager that starts only at login, a Windows sign-in |
| Version prompt | From `MachineInfo.versions`: an older hub gets the existing update path; an older remote gets the exact `npm i -g centralu@<hub version>` to run there (phase 1 cannot update it); one protocol connects and the update is offered on the connected row (#689); "Connect anyway" (`machines.acceptVersions`) remains for a link held at `versions_differ`. A hub running a local build installs and updates a remote at `<base>` when `<base>` speaks its `protocolVersion`, else at the newest earlier release that does (a registry that cannot be reached, or no such release, is a plain refusal); `machines.update` never goes down, and refuses when the remote runs a newer version than it would install (`installVersion` in `links/registry.ts`; a release declares it in its `package.json`), and the result's `note` says so |
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
- **store**: better-sqlite3 + a `user_version` migration runner. The schema DDL lives in exactly one place,
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

The rule, written above the step list in `dev-services/store.ts` (`migrationSteps`), which a reviewer checks every new
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
   record opens it and runs no step it does not know.
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
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43, 53 | add a column (53: `sessions.interruption`, why the last turn did not finish, #698) | reads it (39: shows sessions in the trash as live ones; 43: an older host's `grid.set` writes no span, so app panels fall back to their defaults, #306; 53: an older host neither reads nor writes `sessions.interruption`, so a row it serves keeps the last value, #698) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42, 49, 50, 51, 52 | add a table (3 also backfills the index: heavy; 42 copies the grid's session rows into `grid_layout` once and leaves `grid_panels` as it was, #288; 49 adds `report_marks`, the report a session owes the session that gave it work, #646; 50 adds `agent_start_requests`, a start_agent card still waiting for the person, #673; 51 adds `delegated_turns`, the session that gave a running turn, #676; 52 adds `queued_requests`, a request held for a busy session, and the nullable `sessions.forked_from_session_id`, #677) | reads it (42: an older host keeps its grid in `grid_panels`, so the two builds' grids can differ) |
| 10, 11, 40 | rebuild with the same shape (10: `sessions` with `project_id` nullable; 11 and 40: the index, then `VACUUM`: heavy) | reads it |
| 21, 26, 29, 35, 48 | rewrite data one way (21 rewrites every message: heavy; 48 gives a former worktree manager's worktree sessions `askedBy`, #561) | reads it, cannot be undone |
| **13, 28, 32** | **drop a table or a column** | **breaks: raises `min_reader_version`** |

A step that changes the schema regenerates [generated/schema.md](generated/schema.md) (`pnpm docs:schema`) in the
same PR, and a new table gets a line in a "Where it is stored" list of [domain-model.md](domain-model.md) and its
mirror. `schema-doc.test.ts` fails until both are done.

### 5.2 Stored shapes another build reads (#384)

The store's tables are one shape that two builds share; §5.1 covers them. Many other shapes are stored or exchanged
the same way: JSON rows in `app_settings`, files in the data folder, files a person or another build writes, and
the lines and frames between processes. An older and a newer build read each of them during a host swap, after a
person goes back a release, and between two machines on different releases.

The rules for every shape:

- **A field added:** an older reader ignores it, and, where it writes the record back, keeps it.
- **A field removed or not yet written:** a newer reader uses the default.
- **A value this build cannot read** (a word from a newer enum): that value takes its default, alone; the rest of
  the record still reads. A permission that cannot be read is a refusal, never a grant.
- **A broken file:** a clear message that names the file or row, never a crash, and never a setting reset without
  a word.

| Shape | Where | Reader / writer | Older shape | Newer shape | Broken | Tests |
|---|---|---|---|---|---|---|
| Screen preferences (`UiPreferences`) | `app_settings.ui_preferences` | `parseUiPreferences` (protocol), `SessionManager.uiPreferences` / `setUiPreferences` | each missing field is its default | an unreadable value shows its default; unknown fields and unreadable values are kept when this build writes a change | defaults, one stderr line naming the row; the next change replaces it | `theme.test.ts`, `ui-preferences.test.ts` |
| Workspace snapshot | `workspace` row | the UI store's restore (`attach`), `readNotifyPolicy` (core), `sanitizeLayout` | every field is checked on its own; a notification switch the snapshot lacks is on by default, not off | ignored. The window rewrites the snapshot whole, so an older window drops a newer one's layout fields: deliberate, the snapshot is layout, not settings | the host answers `null`, the screen starts from its defaults | `store.test.ts` (ui), `notify.test.ts` |
| Theme and typography cache | the page's `localStorage` | `applyCachedTheme`, `applyCachedTypography` | each value checked | ignored | same as no cache: only the first frame, the host's answer follows | (cache only) |
| Keeper settings | `keeper-settings.json` | `source::load_settings` (keeper, serde with defaults) | `background` defaults to off | ignored on read, **dropped on the next save** | reads as off, **with no message** | `background_mode_is_off_unless_saved_on` (no newer-shape test yet) |
| Grid placements | `grid_layout` | `Store.listGridView` / `setGridView` | a row without a span reads as none chosen (v43) | `kind` has a CHECK, so a new panel kind is a table rebuild: a breaking step under §5.1. A span out of bounds reads as none | (rows) | `store.test.ts` (v42, v43) |
| Consents between projects (#371) | `project_consents` | `Store.listProjectConsents` / `getProjectConsent` | (rows) | a kind this build does not know stays in the store and is not listed (#384) | (rows) | `store.test.ts` |
| A session's app consents | `app_settings.session_apps:<id>` | `parse` in `sessions/app-access.ts` | (list) | an element with an unknown consent is dropped | empty list | |
| App permissions | `app_permissions` | `desk.ts` | a decision recorded for an older `uses` asks again | any decision but `allow` refuses | (rows) | `app-capabilities.test.ts` |
| App manifest | `centralu.app.json` | `parseManifest` | optional fields default (`view.origin` opaque, `uses` empty) | an unknown field is a warning; an unknown `uses.host` capability is a warning and refused; another `manifestVersion` is an error naming both versions | an error naming the file, shown in the app list | `manifest.test.ts` |
| App secrets | `app-secrets.json` | `AppSecrets` | (map) | extra keys ignored | apps start without secrets, said on stderr | `app-secrets.test.ts` (not the broken file) |
| Imported-app marks | `app-imports.json` | `ImportBook` | (map) | extra keys kept | moved aside as `.unreadable-<time>` and reported, so an imported app asks again | |
| App versions | `app-versions/<app>/<id>/meta.json` | `AppVersions.list` | | extra fields kept | a record without `id` and `at` is skipped, like a half-deleted one (#384) | `versions.test.ts` |
| Theme files | `<data>/themes/*.json` | `parseThemeFile` (protocol) | missing tokens fall back to the base theme | an unknown key or token is listed as a problem and ignored | listed as broken, with the reason | `theme.test.ts`, `themes.test.ts` |
| Orchestrator proposals and skills | `app_settings.orchestrator_*` | `OrchestratorProposals` | | an element keeps its extra fields | not a list reads as empty; an element without a name or content is skipped (#384) | `orchestrator-proposals.test.ts` |
| View hand-over | `app_settings.views.handover` | `restoreViewHandover` | | an element that is not a view is skipped (#384) | nothing reopens; the row is deleted all the same | `view-handover.test.ts` |
| View origin ports, agent versions seen, project JSON columns | `app_settings.apps.viewPorts`, `agents.versionsSeen`, `projects.*` | `readBook`, `readSeen`, `Store` | each value checked | ignored | read as none | |
| Host build record | `CC_HOST_SOURCE` (keeper to host) | `hostBuild` (`keeper-link.ts`) | missing keys are left out | ignored | the host's own commit only | `keeper-link.test.ts` |
| Start status | `shell-status.json` | the window's `start.rs`, field by field, matched by nonce | | ignored | treated as no status yet | `start.rs` tests |
| Keeper record | `keeper.json` | written for a person; no build reads it | | | | |
| Remote connection line | `centralu serve --connection` stdout | `parseConnectionLine` (`links/tunnel.ts`) | `version` and `dataDir` default | another `v` is an error that says which side to update; a missing port or token is an error | lines that are not JSON are skipped | `tunnel.test.ts` |
| Host ↔ UI payloads | RPC results, events, `hello_ok` | `parseRpcResult`, `parseServerFrame`, `parseTolerant` (protocol, #339) | defaults applied | undeclared fields dropped; an unreadable value is kept as sent, alone | | `tolerant.test.ts`, `rpc-client.test.ts`, `e2e/older-host.spec.ts` |

Not covered yet: `keeper-settings.json` drops fields it does not know when it saves, and an unreadable file reads as
off without a message (the keeper's Rust, left for its own change). An e2e that opens a newer store with the
previous release's host is still to come; `older-host.spec.ts` covers the payload half.

## 6. Usage and limits (FR-9)

**We ask the tool, we do not read its files.** `agents.usage` → `SessionManager.usageFor(tool)`
→ the adapter's optional `listUsage()`, which calls the tool's own API (the Claude SDK for one,
`app-server` for the other). An adapter that cannot answer throws, and the manager degrades
with the reason attached rather than showing a confident wrong number.

Usage is an **account** property, not a session or directory one, which is why `listUsage()`
takes no arguments — the answer is the same whichever folder you ask from. Only subscription
limits are in scope; metered credits are not.

This section used to describe something else entirely: a chokidar watcher parsing
`~/.claude/projects/**` and `~/.codex/sessions/**` incrementally, writing `usage_facts` rows
that a `usage.weekly` RPC would read, with aggregation in `core/usage`. **None of it exists** —
chokidar is not a dependency, `core/usage` holds only the cache arithmetic of §6.1, there is no `usage.weekly`
method, and no build ever wrote a row to `usage_facts`. It stays in `schema.sql` for now: released builds up to
v0.1.0-beta.10 still delete a project's rows from it, and this build is the first that leaves it alone, so dropping it
is a contract step for a later release (§5.1 rule 2). It was
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
Tool calls and results are dropped, keeping only the name: the point of importing is to get the conversation back,
not to resurrect the execution log.

**Where the tool compacted is kept** ([#303](https://github.com/ijun17/centralu/issues/303)). Codex's history (now
`thread/turns/list` with full items, before #342 `thread/read`) returns each compaction as a `{ type: 'contextCompaction', id }` item in the turn where it ran — a turn of its own for
`/compact`, ahead of the user's message for an automatic one (measured on codex-cli 0.147.0, 0.153.4 and 0.160.0,
`scripts/probe-codex-compaction.mts`). The reader turns it into a compaction line (`HistoryMessage` with
`role: 'system', marker: 'compaction'`), and the host stores that as exactly the row a live `compaction` event leaves
(kind `marker`, the event as its payload), so the screen and the handoff pivot cannot tell a read-back compaction from
one watched live. Stored once: catching up skips as many compaction lines right after our last message as our record
already holds there (a compaction this host saw live is in both), and attaches the rest. The Claude reader
keeps only user and assistant messages from `getSessionMessages`, so an imported Claude conversation still shows none.

### 8.4 The identity of an imported session

- The tool is sent a `resume` → the model's actual context continues.
- The screen restores the last `HISTORY_LIMIT` (200) lines → this is a **snapshot for display**.
- The restored conversation is marked `lastReadSeq = lastSeq`. Do not summon a human for a conversation they have already read.
- Which conversation was taken over is recorded in `sessions.imported_from` (schema v5).
  `external_id` cannot tell you — the tool may **issue a new identifier** when resuming,
  making it differ from the original, at which point the 'already imported' mark in the list is wrong every time.
- If the record cannot be read, the session still lives. Failing to read a record is no reason to block the conversation too.
