# What Centralu's MCP tools cost a session

Decisions about how Centralu exposes its tools (#419, #512) are made on numbers. This is the one
repeatable measurement of those numbers (#513): how to run it, how to read it, and the first baseline.
It is a record of measurement, like [runtime-lessons.md](runtime-lessons.md), so it is not mirrored in
Korean. The design it measures is in [agent-host.md §1.1](agent-host.md) (who gets which tools) and
[apps.md §9.4](apps.md) (attaching apps to a session).

## 1. Running it

```bash
pnpm measure:tools                         # dry: no model calls
pnpm measure:tools --live                  # live: real models (Claude: haiku; Codex: the account's default)
pnpm measure:tools --compare before.json after.json
```

| Option | Default | Does |
|---|---|---|
| `--cli` | `claude,codex` | Which CLIs to drive |
| `--reps` | `2` | Repetitions of every session and prompt |
| `--model` | `haiku` | Claude's model |
| `--codex-model` | the account's default | Codex's model (Codex's names do not say which is small) |
| `--change-model` | `sonnet` / Codex's next model | The model the cache script switches to at its last step; `none` skips the step |
| `--phases` | dry: `resident,cache,results`; live: all four and `selection` | Which parts to run |
| `--prompts` | `scripts/measure-tools/prompts.json` | The fixed prompt set |
| `--out` | a file in the system temp folder | Where the JSON goes (meta, summary, and the raw records) |
| `--keep` | off | Keep the scratch folder (projects, data folder, `host.log`) |
| `--kinds` | all five | The session kinds the resident phase starts |
| `--only` | every prompt | Run only these prompt ids of the set |

A prompt file may set `preset` (the permission preset of every selection session) and, per orchestrator
prompt, `fresh` (a new orchestrator every repetition, and what the run made is removed before the next:
sessions, apps, proposals). `prompts-512.json` and its Korean twin `prompts-512-ko.json` do both (§9).

What a run starts: per CLI, one host on a fresh temporary data folder (`CC_DATA_DIR` and `--db` both
inside it, never `~/.centralu`), two trusted scratch git projects, `website` and `ops`, and in `ops` a
counter app (the runtime's test fixture) shared with other projects. Live runs use the person's own CLI
logins, as every earlier probe did. A live run asks for nothing to be carried out beyond a tool call:
selection turns decline consent cards and approvals, so `ask_project` starts no session.

What a live run costs: the baseline below spent about $0.74 of Claude usage at list prices (187 haiku
requests and 3 sonnet ones, mostly cache reads) and a few minutes of Codex usage on the account's plan.

The baselines are kept next to the script, meta and summary only, so a later run compares against them:
`packages/agent-host/scripts/measure-tools/baselines/2026-10-12-{dry,live}.json`.

## 2. How it measures

**Definitions** (both modes, no CLI). `sessions/tool-cost.ts` serializes each profile's tools as the
model is handed them (`{ name, description, input_schema }`, the name as `mcp__centralu__<tool>`), splits
what is resident from what waits behind tool search, adds the server instructions the model is sent, and
hashes the resident part. The budget test reads the same function (§5).

**The recorder** (Claude). The host's Claude sessions are started with `ANTHROPIC_BASE_URL` pointing at a
local server (`scripts/measure-tools/recorder.mts`), so every request the CLI makes passes through it.
Live, it forwards each request to the API unchanged and reads the usage the API reports. Dry, it answers
itself: a scripted reply, a text or a tool call the driver queued, so the real CLI builds its real
requests and no model is called. Either way each request's tool list, system prompt and history are
compared with the session's previous request. Credentials pass through (live) or are replaced by a dummy
key (dry); nothing about them is written down. Three things the recorder changes, measured with CLI 2.1.289:

- Claude Code turns tool search off when the API is not first-party, which a local base URL is: every
  MCP tool was loaded and there was no ToolSearch. The recorder's sessions run with
  `ENABLE_TOOL_SEARCH=true`, which is the default against the real API.
- A request through the recorder is about 220 tokens smaller than the same request sent directly
  (21,363 against 21,584, the same prompt run both ways twice). Compare runs with each other, not with
  numbers taken without it.
- The account's claude.ai connectors are off (`ENABLE_CLAUDEAI_MCP_SERVERS=false`): when they come up
  varies run to run, and they moved #320's baseline by a hundred tokens.

**Centralu's own tokens** (Claude, live). A directing seat runs on another system prompt than an
ordinary session (the orchestrator on Claude Code's preset with its role, the builder with its role), so
the difference from a session with no tools mixes the two. The recorder therefore counts each session's
first request twice with `count_tokens`, which costs nothing: as sent, and with every trace of Centralu
taken out (its definitions, its names in the deferred list, its server instructions). The difference is
Centralu's alone. `count_tokens` comes out 146 tokens under the usage of the same request (it is sent
without the thinking and context parameters), the same for every kind, so the difference holds.

**Codex.** There is no fake API for Codex to talk to, so dry mode measures only its definitions. Live,
the per-request numbers are the host's `usage_update` (Codex reports the thread's running totals; one
request is the difference from the previous report, and a report that repeats the totals is not a request).

**A rebuild.** Everything the previous request sent should be readable from cache by the next one, so
`lost` is the previous request's whole input minus this request's cache read. More than 1,024 tokens
(one cache block) is marked REBUILD. A rebuild can still be partly served from another session's cache
when their prefixes match: the account's cache is shared, which is why the baseline's model change read
17,322 tokens of a sonnet prefix written by an earlier run within Claude Code's one-hour cache.

**Tool selection.** Each prompt runs in a fresh ordinary session (the orchestrator's in the one
orchestrator, which keeps its conversation across repetitions). The verdict is from the first Centralu or
app tool the model calls: one of the expected tools is *right*, another is *wrong*, none is *none*; for
the prompt that expects no tool, any call is *wrong*. *Steps* is the position of the first expected call
among all the turn's tool calls, tool search and Codex's `exec` included. *Args ok* is that call's
arguments against the tool's schema (Claude only: Codex calls MCP tools from inside `exec`, as code, and
the host's event carries no arguments). *1st ok* is whether that call's result was not an error; a
declined consent card makes `ask_project`'s an error by design.

**Result growth.** A scripted session lists sessions, reads one, recalls twice and reads the guide.
`added` is what a request's input grew by beyond the previous request's input and output, which is what
the previous tool result (and the next user message) added to every later request.

**What it cannot script.** A CLI update (compare two runs across the update instead); a coordinator
(the RPC that made one was removed in #372; its definitions are measured); an app's agent session, which
gets no Centralu tools, the same as the `none` row.

## 3. Reading the output

| Table | Read it for |
|---|---|
| Resident definitions per profile | Characters each profile carries: resident tools, deferred tools, instructions, and a hash of the resident part. A hash that changes between two runs is a prefix that changed with the release |
| Claude request prefix (dry) | Per request of a scripted session: whether the tool list (`tools`), the entries tool search added (`deferred entries`), the system prompt and the history were reused. `rewritten@n` is the first message that differs. `results` is the characters of Centralu's tool results in that request's history |
| Resident context per session kind (live) | The first request's input tokens; `Δ none` against a session with no Centralu tools; `Centralu` from `count_tokens` (Claude) |
| Cache per request (live) | Uncached input, cache read, cache write and output per request, the event before it, and `lost` |
| Tool results over a longer session (live) | What each tool result added |
| Tool selection (live) | right / none / wrong of the runs, median steps, args ok, 1st ok, and the calls made |

`--compare` prints every number of two runs as `before → after (Δ)`, with the rebuilds per step summed
over repetitions. Two runs compare only when they used the same prompt file and the same CLI versions
(both are in the JSON's `meta`).

## 4. Baseline (2026-10-12)

Base commit 31e42c56 with this change; Claude Code 2.1.289 on haiku 4.5 (3 repetitions), codex-cli 0.160.0
on gpt-6.1-sol (2 repetitions); macOS. The person's own Claude Code settings were read, as Centralu's
sessions read them, so the absolute sizes are this machine's; the differences are what carries over.

### Definitions (characters)

| Profile | Tools | Claude resident | Claude deferred | Instructions (Claude) | Codex, all loaded |
|---|---|---|---|---|---|
| orchestrator | 12 | 9,954 | 0 | 1,844 | 9,954 |
| manager | 5 | 3,479 | 0 | 2,785 | 3,479 |
| scoped | 3 | 1,888 | 0 | 379 | 1,888 |
| builder | 1 | 610 | 0 | 822 | 610 |
| reader | 7 | 968 | 1,153 | 0 | 2,121 |

At this baseline Codex was sent no server instructions: the bridge answers `initialize` without them. Since #525
the same text rides in a Codex thread's developer instructions, 52 characters longer for its header (§7).

### Resident tokens per session kind (first request, live)

| Kind | Claude total | Claude Δ none | **Claude: Centralu's own** | Codex total | Codex Δ none (its role, no tools) |
|---|---|---|---|---|---|
| none (tools off; an app's agent) | 16,143 | — | 0 | 17,872 | — |
| ordinary (reader) | 16,469 | +326 | **326** | 17,872 | **+0** |
| orchestrator | 25,661 | +9,518 | **3,223** | 18,146 | +274 |
| worktree manager | 17,617 | +1,474 | **1,476** | 18,652 | +780 |
| builder | 23,623 | +7,480 | **462** | 18,486 | +614 |

Repetitions agreed to within 150 tokens (the orchestrator's one run of 25,513 against 25,661).

### Cache per event (live)

| Event | Claude | Codex |
|---|---|---|
| next turn | no rebuild (lost 8–10 tokens: the previous request's uncached input) | no rebuild |
| a deferred tool loaded (ToolSearch) | **no rebuild.** The tool list's loaded part is unchanged; the loaded tool joins it as a `defer_loading` entry, and that did not cost the cache | no rebuild |
| an app attached | **no rebuild**: its tools are announced as deferred names in the conversation | no rebuild at the thread restart that brings the tools |
| an app detached | **no rebuild**: the `defer_loading` entry of its loaded tool leaves the list, and the cache holds | no rebuild at the restart |
| permission preset changed | no rebuild | no rebuild |
| session restarted | no rebuild | no rebuild |
| woken (host restarted, session resumed) | no rebuild | no rebuild |
| model changed | **rebuild**: a cache is per model; the history is rewritten from message 0 (the model line of the first message) | none seen (21,248 read after the switch): unexplained, see §6 |

Codex rebuilt about 8,400 tokens once in the baseline's second repetition (in the detaching turn) and
once in a trial run before it (in the turn after attaching), each in the middle of a turn whose `exec`
had just reached an app tool; the baseline's first repetition had none. Codex's caching is its own; the
table says when, not why.

### Tool selection (live; right of runs, steps, 1st ok)

| Prompt | Expects | Claude (3) | Codex (2) |
|---|---|---|---|
| other sessions | `read_session` | 3/3, 1 step | 2/2, 2 steps |
| an earlier decision | `recall` / `read_session` | 3/3, 1 step | 2/2, 2 steps |
| how Centralu works | `app_guide` (deferred on Claude) | 2/3 (1 none), 2 steps; **1st ok 0/2** | 2/2, 3 steps; 1st ok 0/2 |
| have another project do it | `ask_project` | 3/3, 1 step | 2/2, 2 steps |
| another project's app | `find_apps` / `attach_app` (deferred on Claude) | **0/3**: it read sessions and recalled, then (2 of 3) called `ask_project` | 2/2, 2 steps |
| no tool needed | none | 3/3 | 2/2 |
| orchestrator: overview | `list_sessions` / `read_session` | 2/3 (1 none: it remembered the previous repetition) | 2/2 |
| orchestrator: delegate | `send_to_session` | 3/3 | 1/2 (read first) |

Claude's first-try arguments validated against the schema every time (16 of 16). Validating is not
working: `app_guide`'s first call failed in every run on both CLIs. On Claude the model asked for a topic
in its own words ("sharing apps between projects"): the schema's `topic` is a free string, and the tool
knows seven topics.

### Result growth (live, the scripted session)

| Result | Claude: characters → tokens added | Codex: tokens added |
|---|---|---|
| `read_session` listing | 174 → 80 | 7,411 in the turn's first `exec` step, where Codex finds its tools; then 100 |
| `read_session` of one session | 287 → 97 | 117 |
| `recall` | 318 → 121 | 94–138 |
| `app_guide` (no topic) | 1,458 → 394 (plus 218 for the tool search that loaded it) | 395 |

Over the scripted session Claude's request grew from 16,467 to 19,094 tokens, Codex's from 17,872 to 28,260.

## 5. What guards the numbers without a model

- `sessions/orchestrator-tools.test.ts`, *the resident cost of each profile*: each profile's resident
  definitions plus instructions stay within `RESIDENT_BUDGET_CHARS` on both CLIs (the reader's is the sum
  of its four sets' ceilings). It reuses the reader set's own budget tests rather than repeating them.
- `adapters/claude/tool-prefix.test.ts`: the resident tool prefix of a Claude session, read the way the
  CLI reads it (`tools/list` on every server, the tools marked `anthropic/alwaysLoad`), is byte-identical
  before and after an app is attached and detached, even an app that declares `anthropic/alwaysLoad`
  itself; the app proxy drops that flag (apps.md §9.4). Loading a deferred tool is the CLI's own doing;
  dry mode runs it against the real CLI.

## 6. What the baseline found

1. **Claude's prefix holds** through every event Centralu causes: a deferred tool loading, an app
   attaching and detaching, a preset change, a restart and a wake. Only a model change rebuilds, as it
   must. The cache risk #419 was written about is not there today on Claude.
2. **Codex no longer loads MCP tools up front.** codex-cli 0.160.0 gives the model an `exec` tool in which
   MCP tools are JavaScript functions (`tools.mcp__centralu__recall({…})`) and `ALL_TOOLS` lists them; an
   ordinary session's first request is the same size with Centralu's tools as without (in a trial, asked
   to list the tools it could call, it named none of Centralu's, and still called `read_session` when
   asked to). The cost moved into the conversation: the first `exec` step of the scripted session added
   7,411 tokens. "Codex has no
   deferral" in agent-host.md §1.1 and apps.md §9.4 describes an earlier Codex.
3. **The orchestrator is the expensive seat**: 3,223 tokens of its own in every request on Claude, ten
   times an ordinary session's 326.
4. **A deferred tool can lose to a loaded one.** Asked about another project's app, haiku never searched
   for `find_apps` and reached for the loaded `ask_project` instead (0 of 3); #371's own measurement, with a
   prompt that said "use it", found it 5 of 5. Deferral is not free for selection. Fixed in #522 (§8).
5. **A free-string argument fails first try.** `app_guide`'s topic: 0 of 4 first calls worked. Fixed in #523
   (§8).
6. **Codex: a model set before a session's first turn broke it.** The change restarts the thread
   through resume, Codex has no rollout to resume before a first turn, and the next send failed with
   "Could not resume the conversation". The baseline measured such seats on their default model. Fixed in
   #524 (§7).
7. **Codex: a model change showed no rebuild** (gpt-6.1-sol → gpt-6-astra read 21,248 tokens from cache).
   Either the change did not reach the thread or Codex's cache crosses those models; not settled here.

## 7. Codex: role instructions and a model set before the first turn (2026-10-12)

Two of the baseline's findings, fixed and measured again: Codex seats got none of their tools' instructions
(#525), and a model set before a Codex session's first turn broke the session (#524, §6.6). codex-cli 0.160.0,
gpt-6.1-sol, macOS.

**Where Codex shows instructions.** `scripts/probe-codex-mcp-instructions.mts` starts a thread with a stdio MCP
server whose `initialize` answers with marked `instructions`, and marked `developerInstructions` next to them, and
asks the model for a phrase from each. In four runs (in two of them the model first found the server's tool in its
`exec` listing and called it) the model named the developer phrase and never the server's, and the thread's
rollout held the developer text as a developer message and the server's nowhere. So the bridge still sends none,
and the adapter appends `instructionsFor(profile)`, the text Claude's in-process server sends, to the thread's
developer instructions, after the seat's role, under the header `# How to use the centralu tools
(mcp__centralu__*)` (`codexToolInstructionsFor`).

The same probe resumed the thread with other developer instructions, then the same again, then none, a turn after
each: the model kept naming the first phrase and the rollout gained no developer message. Codex reads developer
instructions at `thread/start` only, so a thread keeps the instructions it started with (agent-host.md §1.1), and
the adapter sends them on a start alone. (Cache read of the four turns: 12,288 of 18,712, 12,288 of 19,419,
19,200 of 19,485, 19,328 of 19,551; one run, so the first resume's shortfall is not attributed here.)

**Dry** (`pnpm measure:tools`, compared with the dry baseline): every Claude number and prefix is unchanged. Codex's
resident characters (definitions plus instructions) grow by the instructions and their header: orchestrator
9,954 → 11,850, manager 3,479 → 6,316, scoped 1,888 → 2,319, builder 610 → 1,484; the reader, which has no
instructions, stays at 2,121.

**What they cost** (`pnpm measure:tools --live --cli codex --phases resident --codex-model gpt-6.1-sol --reps 1`,
the first request's input tokens; the baseline's Codex repetitions agreed to the token; kept as
`baselines/2026-10-12-codex-instructions-live.json`, base commit b66c9777 with this change):

| Kind | Instruction characters added | Before (§4) | After | Added |
|---|---|---|---|---|
| none | 0 | 17,872 | 17,868 | (−4) |
| ordinary (reader) | 0 | 17,872 | 17,868 | (−4) |
| orchestrator | 1,898 | 18,146 | 18,551 | **+405** |
| worktree manager | 2,837 | 18,652 | 18,485 | **+617** against `none` of the same run |
| builder | 876 | 18,486 | 18,678 | **+192** |

About 4.6 characters a token, as for the definitions. The manager's "before" is not comparable: Codex puts the
person's skill list in the same developer message, and its remote plugins' entries arrive in some threads and not
others (3,279 characters more in the baseline's manager thread, which is all of that row's +780 in §4; every
thread of this run had the shorter list). Against `none` of the same run its instructions cost 617 tokens.

**A model set before the first turn.** The measurement now sets the model on every seat before its first turn, as
it does on Claude; the orchestrator and the builder, which are running when the change arrives, restart, and every
seat's first turn ran. A started Codex thread names itself to the host only at its first turn, so a restart before
then starts a thread again rather than resuming one Codex has nothing written for (`CodexSession.externalId`;
`sessions/codex-seats.test.ts`). Sessions an older build started and never messaged keep the id they were given
then, and still fail to wake with "has no record of this conversation"; a new session is the way out for them.


## 8. Finding another project's app, and the guide's topic (#522, #523)

Two findings from the baseline (§6.4, §6.5), fixed and measured again: asked about another project's app, Claude
never searched for the deferred `find_apps` and reached for the loaded `ask_project` (#522); `app_guide`'s first
call failed because `topic` was free text and only seven topics exist (#523). Claude Code 2.1.289 on haiku 4.5,
codex-cli 0.160.0 on gpt-6.1-sol, macOS, base commit 27027fb1. Each variant is a `--phases selection` run on the
same prompts (Claude 5 repetitions, Codex 3); the prompt set gained three prompts for this (`centralu-howto-2`,
`open-app-named`, `open-app-list`). Every run's summary is kept in
`baselines/2026-10-12-selection-522-523-live.json`. The runs cost about $4 of Claude usage at list prices.

**The guide's topic** is now an enum of the seven topics in both schemas that offer it (the reader's, and the
orchestrator's, where the topic list moves from the description into the enum: +3 characters). A topic sent in
other words that names one of them ("session settings", "approval") is answered with that topic and the list,
for a caller that does not check the schema; one that names none is still refused with the list.

| `app_guide` first call worked | Before (string) | After (enum) |
|---|---|---|
| Claude | **1 of 4** (three asked for "sharing apps between projects") | **15 of 15** (every one a listed topic) |
| Codex | 1 of 3 | 5 of 6 |

Codex calls MCP tools as code inside its `exec` tool and the host's event carries no arguments, so its one miss
after the change is not attributed; the close-match answer above came after that run. The reader set grows from
897 to 983 characters (`READER_BUDGET_CHARS` then stayed 1,000); on Claude `app_guide` is deferred, so no request
carries it until it is loaded.

**Another project's app.** The variants, all with the enum, on the two prompts that ask about another project's
app without naming a tool (`open-app`, `open-app-named`: 10 runs each), the one that asks which apps there are
(`open-app-list`), and `ask-project`, which must stay with `ask_project`. *First right*: the first Centralu call is
`find_apps` or `attach_app`. *Attach called*: `attach_app` was called in the turn. The measurement declines every
consent card (§1), so no attach went through and no run reached the app's own tools; after the refusal some runs
tried `ask_project`, whose card was declined too. *Resident*: Centralu's own tokens in an ordinary Claude session's
every request (`count_tokens`, §2), against 326 before.

| Variant | Resident | First right | Attach called | `open-app-list` | `ask-project` |
|---|---|---|---|---|---|
| before: `find_apps` deferred, no pointer | 326 | 0/10 | 0/10 | 4/5 | 5/5 |
| a1: `ask_project` ends "For another project's apps, use find_apps." | 337 (+11) | 3/10 | 5/10 | 5/5 | 5/5 |
| a2: "… To use another project's app yourself, call find_apps, then attach_app." | not measured | 2/10 | 3/10 | 5/5 | 5/5 |
| a3: "… Not for its apps: find_apps and attach_app give you their tools." | not measured | 0/10 | 0/10 | 5/5 | 5/5 |
| a1 + `find_apps`'s result telling it to attach rather than ask | 337 (+11) | 1/10 | 3/10 | 5/5 | 5/5 |
| b: `find_apps` loaded | 401 (+75) | 5/10 | 1/10 | 5/5 | 5/5 |
| b + that result hint | 401 (+75) | 6/10 | 6/10 | 5/5 | 5/5 |
| b2: `find_apps` and `attach_app` loaded | 481 (+155) | 7/10 | 7/10 | 5/5 | 5/5 |
| **a1 + b (shipped)** | **412 (+86)** | **6/10**, again 7/10 | **9/10**, again 8/10 | 5/5, 5/5 | 5/5, 5/5 |

What the runs show:

- **A pointer alone helps a little.** With `find_apps` deferred, the model reaches it only by searching, and the
  pointer made it search in some runs (a1); how the pointer is worded mattered more than its length (a3 did
  nothing).
- **Loading `find_apps` alone gets it called but not finished.** After `find_apps` answered, the model called the
  loaded `ask_project` instead of searching for `attach_app` (b: 5 found, 1 called `attach_app`). The result naming
  `attach_app` was not enough; a hint telling it to attach (b + hint) or loading `attach_app` as well (b2) closed
  some of that gap.
- **The pointer and the loaded tool together** did best at less than b2's cost: 9 of 10 called `attach_app`, and on
  the second run 8 of 10 (open-app 5/5, open-app-named 3/5). Every run that went to `ask_project` first was on the
  prompt that names the other project ("Use the counter app from the {other} project"); after its declined consent
  card, 3 of those 6 runs went on to `find_apps` and `attach_app`.
- **Codex was already right**: `find_apps` first in 6 of 6 before and 6 of 6 after, `attach_app` called in 6 of 6
  after.
  Asked which apps there are, it read the guide first (0 of 3 both times), which the verdict counts as wrong.
- The cost is 86 tokens in every ordinary Claude session's every request, about 0.5% of a 16,500-token first
  request; Codex's first request does not carry MCP tools (§6.2). Claude's prefix still holds through every event
  in a dry run (the tool list grows by `find_apps`; nothing else changes).

**Left open.** `centralu-howto-2` ("What does the Speed option under the input box in Centralu do?") never reached
`app_guide` on Claude in 20 runs across the variants (it called `recall`, or a subagent, or nothing); Codex read the
guide 6 of 6. The guide is deferred on Claude (#320); the question it answers here is selection, not the topic.

**A prompt to keep out of the set.** A first version of `centralu-howto-2` asked "How do I make Centralu stop
asking me to approve every command in a session?". Haiku took it as a request: it invoked the person's own
settings skill and wrote permission rules into the scratch project's `.claude/settings.json` (a selection
session runs on the `normal` preset, which follows the person's own Claude Code settings). Those runs were
stopped and discarded; nothing outside the scratch folder changed. Selection prompts ask questions, not for
changes.

## 9. The orchestrator's rare commands: resident, deferred, or discovered (#512, 2026-10-12)

The orchestrator carries about 3,200 tokens of its own in every request, and three tools it rarely calls
(`create_app`, `propose_skill`, `propose_mcp_server`) are a third of the characters. #512 asked whether a seat
should discover such commands like a CLI rather than carry them. A prototype behind a switch (since removed)
(agent-host.md §1.1, security-boundaries.md; C became the default, see the decision at the end of this section)
gives three arms on the same prompts:

- **A** `resident`: today.
- **B** `deferred`: the rare tools behind Claude's tool search (Claude only: Codex reaches every MCP tool through
  its `exec` already, §6.2, so on Codex B is A).
- **C** `commands`: the rare tools leave the tool list; `centralu_commands` (one line each), `centralu_help` (one
  command's schema) and `centralu_run` (checked on the host against that schema, strictly; a wrong call answers
  with it) stand in, and one line in the instructions says so. The instructions still name each command and when
  to use it, in every arm.

Claude Code 2.1.289 on haiku 4.5 (3 repetitions), codex-cli 0.160.0 on gpt-6.1-sol (2 repetitions), macOS, base
commit 81d17084 with this change. `pnpm measure:tools --live --rare <arm> (a flag since removed) --phases resident,selection --kinds
none,orchestrator --prompts packages/agent-host/scripts/measure-tools/prompts-512.json`. The nine prompts name no
tool: four need a rare command (an app for a project, an app of the person's own, a weekly procedure to keep, a
browser), one needs `propose_worktree_session`, four need a core one (`list_sessions`/`read_session`,
`send_to_session`, `recall`, `create_session`). Every repetition runs in a new orchestrator and what the run made
(sessions, apps, proposals) is removed before the next. The prompts ask for things to be done, so the sessions run
under `safe`: the agent's own tools and the person's skills raise a card the measurement declines, Centralu's run as
under every preset. Claude Code's auto memory is off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`): in a trial the
orchestrator kept the weekly procedure in its memory folder, where every later orchestrator of the run would read it.
Claude was run twice: a first run with `propose_worktree_session` in the tier too, and, after the findings below,
the run the tables report. Every run's summary is kept in `baselines/2026-10-12-rare-commands-512-live.json`. The
runs cost about $3.90 of Claude usage at haiku's list prices (883 requests, the builder sessions `create_app` started
included, which run on the CLI's default model; see round 2's spend) and about 45 Codex turns.

### Resident cost (the orchestrator's first request)

| | A resident | B deferred | C commands |
|---|---|---|---|
| Characters: definitions + instructions (Claude) | 9,927 + 1,833 = 11,760 | 6,223 + 1,833 = 8,056 (3,704 deferred) | 7,221 + 1,994 = 9,215 |
| Claude, first request | 22,693 | 21,677 | 21,983 |
| **Claude, Centralu's own** (`count_tokens`) | **3,240** | **2,225 (−1,015)** | **2,531 (−709)** |
| Codex, first request (Δ none) | 18,553 (+681) | = A | 18,590 (+716) |

The three fixed tools cost about 1,000 characters (~280 tokens), which is why C saves less than B. Codex's first
request carries no MCP definitions (§6.2), so C only adds its instruction line there (+37 tokens). Since these runs, #556 gave
`create_project` a `machine` argument: +102 characters of resident definitions in every arm (11,862 / 8,158 / 9,317),
the differences between the arms unchanged. With
`propose_worktree_session` in the tier too (the first run), B was 2,034 and C 2,326.

### Selection (Claude; both runs, 6 per prompt)

*Reached*: the expected command was called (or run through `centralu_run`) anywhere in the turn. The orchestrator
often lists sessions first, which §4's first-call verdict counts as wrong; that happened equally in every arm.

| Prompt needs | A resident | B deferred | C commands |
|---|---|---|---|
| `create_app`, a project's app | 5/6 | 6/6 | 4/6 |
| `create_app`, the person's own | 6/6 | 6/6 | 5/6 |
| `propose_skill` | 6/6 | **3/6** | **1/6** |
| `propose_mcp_server` | 6/6 | 6/6 | 5/6 |
| **rare, all** | **23/24** | **21/24** | **15/24** |
| `propose_worktree_session` (first run, in the tier) | 3/3 | **0/3** | **0/3** |
| core: list, send, recall, create a session | 24/24 | 24/24 | 24/24 |

The core prompts did not regress in any arm: the same calls, the same first call (the delegate prompt lists
sessions first in every arm), 1 step, 2 requests.

### First-try arguments and what a discovery costs (Claude, the second run)

| On the rare prompts (12 runs) | A | B | C |
|---|---|---|---|
| First call of the command valid (strict schema), both runs | 23/23 | **12/21** | 15/15 |
| That call worked | 11/11 | 7/9 | 8/8 |
| Discovery calls (tool search, `centralu_commands`, `centralu_help`) | 0 | 9 | 17 |
| Steps to the command (median) | 1 | 2 | 3 |
| Requests per turn (median) | 2 | 4 | 5 |
| Input tokens per turn, cache included (median) | 46,018 | 90,053 | 102,459 |
| Output tokens per turn (median) | 611 | 939 | 1,183 |
| Requests within a turn that rebuilt the cache | 0 | 0 | 0 |

- **B's first-try failures** are all haiku calling a deferred tool by name, with arguments guessed from the
  instructions (`serverName` for `name`, no `id`, a `description` for `content`), before loading it: the call fails,
  it searches, then calls it again (9 of 21 first calls).
- **C's arguments were right every time**, because the model read `centralu_help` before every run that reached
  the command; in a trial that skipped it, `create_app` went without `id`, the schema came back, and the second
  run was right.
- **A discovery costs whole requests**, each one the full context again, mostly read from cache: B about one more
  (+44k tokens per turn, median), C two to three more (+56k). Against C's 709 tokens saved on every request, one use
  of a rare command costs what about 80 orchestrator requests save.
- **The cache held** in every arm: no request in a turn rebuilt, a tool-search load included (as in §4), and C's
  tool list never changes.

### Codex (2 repetitions; C with `propose_worktree_session` in the tier)

| | A resident | C commands |
|---|---|---|
| Rare commands reached | 8/8 | 8/8 |
| ... first try passed the host's check | — (no arguments on Codex's events, §2) | 8/8 |
| ... first call worked | 7/8 | 7/8 |
| Steps to the command (median) | 2 | 3 |
| Requests / input tokens per rare turn (median) | 5 / 92,314 | 6 / 112,533 |
| `propose_worktree_session` reached | 0/2 (it delegated with `send_to_session`) | **2/2**, found through `centralu_commands` |
| Core prompts reached | 8/8 | 8/8 |

Codex calls `centralu_help` before running a command and does it as one more `exec` step: one more request, about
20k tokens. Its one failed first call in each arm was `create_app` for the project's app in the second repetition,
while the first repetition's app was still in the scratch project (a project app is part of the repository, so the
host does not remove it; the measurement now deletes the scratch project's folder instead). The error text is not
in the record, so a taken id is the likely cause, not a confirmed one.

### What else the runs showed

- **A hidden `propose_skill` loses to the person's own skills.** Asked to keep a weekly procedure, the orchestrator
  in B and C invoked Claude Code's `Skill` with the person's `schedule` skill (recurring remote agents) instead,
  in 3 of 6 runs each; most other misses answered in text. Under `safe` nothing was created: no tool past the
  skill's text was called.
- **Claude Code's own tool search competes with `centralu_commands`.** In C the model once searched tool search
  for `propose_mcp_server`, found nothing and stopped; once it made a project with `create_project` for an app.
- **A command the instructions do not name is not found.** `propose_worktree_session` was reached 3 of 3 as a tool
  and 0 of 3 deferred or behind `centralu_run` on Claude; the orchestrator's instructions never mention it. It is
  out of the tier (`RARE_COMMANDS`). On Codex the listing found it where the tool did not.
- **The measurement had to change** to be fair: a turn's requests are now only the measured session's (the
  builder `create_app` stands up made requests in the orchestrator's window, which the first run counted), each
  prompt starts a new orchestrator and removes what the last one made, and the sessions run under `safe` with auto
  memory off.

### Round 2: Sonnet, Korean, and a preamble (2026-10-12)

The owner asked for the same comparison on a stronger model, in Korean, and with a preamble at the head of the
orchestrator's role, along the owner's words: "You are an agent running inside Centralu. Before doing something
yourself or using another tool, look for what Centralu's MCP tools and commands can do (centralu_commands)."
(where the seat has no commands the last words are "MCP tools can do."
without the name). It goes in the orchestrator's role only: Centralu offers its tools to the person's own sessions
and does not direct them (product-spec.md §1.2, a principle withdrawn later the same day, §11), so no ordinary session
gets it (`orchestratorRole`, tested in `manager.test.ts`). Arms: **A** resident, **A'** resident + preamble, **C** commands, **D** commands + preamble.

Claude Code 2.1.289 on `claude-sonnet-5-5` (the CLI's `sonnet`), 3 repetitions, the Korean set
(`prompts-512-ko.json`: the same nine asks as a Korean speaker would type them, no tool named) and the English set;
haiku 4.5 for A' and D on the English set, against round 1's A and C. Both sets gained a tenth prompt that needs no
tool ("What is 17 times 23?"), to catch a preamble that sends the model looking before a simple answer; the runs
that predate it ran it alone (`--only core-no-tool`). Same harness and rules as above. Summaries:
`baselines/2026-10-12-rare-commands-512-round2-live.json`.

**What the preamble costs**, every orchestrator request: 143 characters in A', 176 in D (it names
`centralu_commands`). First request, same model and language: Sonnet A → A' +47 tokens (English) / +44 (Korean),
C → D +55 / +54; haiku A → A' +33, C → D +40.

**Sonnet** (each cell: English / Korean; rare = the four rare prompts, 12 runs per language):

| | A resident | A' + preamble | C commands | D commands + preamble |
|---|---|---|---|---|
| First request (tokens) | 21,438 / 21,439 | 21,485 / 21,483 | 20,603 / 20,603 (−835) | 20,658 / 20,657 |
| Rare command reached | 12/12 / 12/12 | 12/12 / 12/12 | 12/12 / 12/12 | 12/12 / 12/12 |
| `propose_worktree_session` (a tool in every arm) | 3/3 / 3/3 | 3/3 / 3/3 | 3/3 / 3/3 | 3/3 / 3/3 |
| Core commands reached | 12/12 / 12/12 | 12/12 / 12/12 | 12/12 / 12/12 | 12/12 / 12/12 |
| No tool needed: no Centralu call | 3/3 / 3/3 | 3/3 / 3/3 | 3/3 / 3/3 | 3/3 / 3/3 |
| Discovery calls on core or no-tool prompts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| First-try arguments valid (rare) | 12/12 / 12/12 | 12/12 / 12/12 | 12/12 / 12/12 | 12/12 / 12/12 |
| Steps to the command (median) | 1 / 1 | 1 / 1 | 4 / 3 | 3 / 3 |
| Discovery calls on the rare prompts | 0 / 0 | 0 / 0 | 24 / 21 | 22 / 23 |
| Requests per rare turn (median) | 3 / 3 | 3 / 3 | 5 / 5 | 5 / 5 |
| Input tokens per rare turn (median) | 54,673 / 54,774 | 54,626 / 54,889 | 96,394 / 96,879 | 96,130 / 96,881 |
| Output tokens per rare turn (median) | 482 / 627 | 458 / 708 | 656 / 893 | 620 / 797 |
| Rebuilds within a turn | 0 | 0 | 0 | 0 |

**Haiku** (English, 12 rare runs; A and C are round 1's second run above):

| | A | A' | C | D |
|---|---|---|---|---|
| First request (tokens) | 22,693 | 22,726 | 21,983 | 22,023 |
| Rare command reached | 11/12 | **12/12** | 8/12 | 8/12 |
| ... project app / own app / skill / browser | 2 / 3 / 3 / 3 | 3 / 3 / 3 / 3 | 2 / 3 / 0 / 3 | 1 / 3 / 1 / 3 |
| `propose_worktree_session` | 3/3 | 3/3 | 3/3 | 3/3 |
| Core commands reached | 12/12 | 12/12 | 12/12 | 12/12 |
| No tool needed: no Centralu call | 3/3 | 3/3 | 3/3 | 3/3 |
| First-try arguments valid (rare) | 11/11 | 12/12 | 8/8 | 7/8 |
| Requests / input tokens per rare turn (median) | 2 / 46,018 | 3 / 58,075 | 5 / 102,459 | 4 / 90,911 |

What round 2 shows:

- **Sonnet finds a rare command in every arm and both languages**, 96 of 96, with valid arguments first time. C and D
  reach it by listing and reading help first: two more requests and about 42k more input tokens per rare turn
  (+77%), and the saving is 835 tokens a request (Sonnet counts the same characters as more tokens than haiku).
- **Korean and English behave the same** on every row, within a few tokens.
- **The preamble did not regress anything**: no `centralu_commands` call on a core or no-tool prompt in any run, the
  same core calls as without it, a simple answer stayed one request. It also changed little that the tier needed:
  Sonnet was at 12/12 without it, and on haiku D reached as often as C (8/12) and lost `propose_skill` the same way.
  On haiku A' it took the one rare miss of A (12/12 against 11/12, one run's difference).
- **Haiku is where the tier costs**, and the preamble does not buy it back.

**Spend.** Round 2 cost $14.52 at list prices (1,609 requests): $7.27 on Sonnet, $1.12 on haiku, and $6.13 on
`claude-opus-5-5`, the CLI's default model, which the builder sessions `create_app` stands up run on (the
measurement stops and deletes them after each turn; a builder handed work by the orchestrator spends while the turn
lasts). Round 1's $3.90 above priced every request at haiku's rates, its builders included, so it was likely higher by
about the same share (roughly $0.5 a run that made an app); pinning the builder's model is a harness change for a
next round.

### Recommendation

**Keep the default (`resident`), without the preamble.** On haiku, C saves 709 tokens a request (22% of Centralu's
own, 3% of the request) and reaches a rare command in 15 of 24 runs against 23 of 24; B saves more (1,015) and
loses less (21 of 24), but its losses fall on `propose_skill` and its first calls often fail before the tool is
loaded. On Sonnet the tier loses nothing (24 of 24 in each arm, both languages) and saves 835 tokens a request, but
every use of a rare command costs two more requests, about 42k more input tokens, so it pays only when the
orchestrator makes some fifty requests per rare command it runs; on haiku it also loses selection. The preamble
costs 33 to 55 tokens a request, regressed nothing, and moved nothing that was measured beyond one run, so it has
not earned its place either. On Codex C saves nothing resident, since Codex's first request carries no MCP
definitions, and costs a step each time. The case #512 still makes for C, a tool list that stays fixed while apps
and commands come and go, was not measured here, and §4 found Claude's cache holding through attach and detach
already. If a cut is wanted, the arm to measure next is B for `create_app` and `propose_mcp_server` only (each
reached 6 of 6 deferred on haiku), with `propose_skill` loaded; the switches stay off until then.

### Decision (owner, 2026-10-12)

**The commands tier (C) is the orchestrator's default**, without the preamble (#564 later turned it on as a product
rule, §11). Round 2 on Sonnet found no loss in selection or arguments (12 of 12 in every row, English and Korean)
and 835 fewer tokens a request, and the tier keeps the resident prefix from growing as commands are added: the
orchestrator was at 11,862 of its 12,000 characters resident, and is at 9,317 in the tier (Codex 9,369 with the
header over its instructions).
`RESIDENT_BUDGET_CHARS.orchestrator` follows it down to 9,500, so a command that wants to be resident again is a
decision rather than headroom. The haiku numbers above stand: a seat on haiku reaches a rare command less often
through the tier. The `resident` and `deferred` arms and the `--rare`, `--preamble` and `--reader-instructions` flags were removed
under #1143; a run made before this date with no `--rare` measured `resident`.

**`handoff_session` (#694)** joined the rare commands: its definition rides in no request, only its line in
`centralu_commands`. What it adds to every orchestrator request is one instruction line naming it (107 characters and
its newline), since the instructions are what a model that cannot see a rare command goes looking with. Measured
2026-10-16 with `residentCost`: 6,642 resident definition characters and 2,102 of instructions on Claude (8,744), 2,154
on Codex (8,796), under the 9,500 ceiling. Its selection through the tier was not measured live.

**Not measured.** Opus as the orchestrator's model; B (deferral) on Sonnet; the Korean set on haiku and on Codex;
Codex in round 2; a command used late in a long orchestrator conversation; app tools behind `app_tools`/`app_call`
(#512's app tier); B with `propose_skill` loaded; the proposal cards on screen in the real app (the unit tests cover
the events the screen reacts to); Windows and the packaged app.

## 10. Starting other agents in the same project (#561, 2026-10-12)

`start_agent` and `agent_session` joined the reader set ([agent-host.md](agent-host.md) §1.2.1). Measured with
`pnpm measure:tools --live --kinds none,reader --phases resident,selection --prompts
packages/agent-host/scripts/measure-tools/prompts-561.json --reps 3` (Claude Code on haiku, codex-cli 0.160.0 on the
account's default model, gpt-6.1-sol). Selection turns decline the consent card, so no child was started; the
start itself is covered by `scripts/smoke-delegation.mjs start-agent`.

**Size.** The two definitions are 918 characters (`AGENT_BUDGET_CHARS` 950): `start_agent` 506, `agent_session` 412. The
reader seat is 3,167 characters on Codex (all loaded; `RESIDENT_BUDGET_CHARS.reader` 3,250) and 1,810 resident on
Claude, where `start_agent` is loaded and `agent_session` deferred.

| | Claude: Centralu's own tokens, first request | Codex: Δ against no tools |
|---|---|---|
| before (#522, §8) | 412 | +0 |
| with the agent set | **582 (+170)** | +0 (Codex reaches MCP tools through its `exec` tool, §6) |
| with `worktree` and `branch` (part 2; 974 characters, budget 1,000; 3,224 on Codex, budget 3,300) | **604 (+22)**, 2 runs | not measured (as above) |

**Selection** (3 runs each):

| Prompt | Claude | Codex |
|---|---|---|
| "Have Codex write a one-line shell command …" | `start_agent` 3/3, one step | 0/3: did it itself (`Bash`, or answered) |
| "Hand this to another agent and tell me what it says: …" | 0/3: no Centralu call (its own sub-agent) | 0/3: its own sub-agents (`subAgentActivity`) |
| `ask-project` (regression) | 3/3 | 3/3 |
| `other-sessions` (regression) | 3/3 | 3/3 |

Naming the tool ("Have Codex …") reaches `start_agent` on Claude every time; "another agent" in general goes to each
CLI's own sub-agents, which the app does not show as sessions, and Codex never chose `start_agent` without being told.
The descriptions do not say "use this instead of your own sub-agents": Centralu offers the tool and does not direct the
person's sessions (product-spec.md §1.2). The reader-set instructions #564 adds (Centralu's features first) are where
that line belongs; this section is the before, and §11 the after.

**Not measured.** Opus and Sonnet as the parent; Korean prompts; a Codex parent starting a child live (the bridge
serves it like every reader tool); the cost of a running child's reports to its parent over a long session.

**Part 3: the worktree manager folded into ordinary sessions.** The `manager` seat is gone, so its row in the tables
above is history (3,479 characters of tools and 2,785 of instructions in every manager request). `agent_session` gained
`delete` (the manager's hard-gated clean-up): the agent set is 992 characters (budget 1,000), the reader seat 3,242 on
Codex. The orchestrator lost `propose_worktree_session`: 10,029 → 9,278 resident characters on both CLIs (counted with
`residentCost`, not measured live).

**#729: `difficulty`, and when to use a worktree (2026-10-16).** `start_agent` gained `difficulty` (light, standard,
heavy: the person's model per tool and difficulty applies) with a description saying when to use which and to use it
instead of `model`, and `worktree` gained one saying when to use it. Characters (`residentCost`): `start_agent` 551 →
798, the agent set 1,085 → 1,332 (`AGENT_BUDGET_CHARS` 1,100 → 1,350), the reader seat 2,313 → 2,560 resident on
Claude, where `start_agent` is loaded (the test's ceiling 2,350 → 2,600), and 4,150 → 4,397 on Codex
(`RESIDENT_BUDGET_CHARS.reader` 4,200 → 4,450). Measured with `pnpm measure:tools --live --cli claude --kinds
none,reader --phases resident --reps 2` on #747's head (a9b981e2) and on this change, Claude Code 2.1.289 on haiku,
then `--compare`:

| | Claude: Centralu's own tokens, first request (both runs equal) |
|---|---|
| before | 764 |
| with `difficulty` and the two descriptions | **832 (+68)** |

The guidance is in the schema because a caller needs it before its first call; #747's guidance, needed after one, went
into the answers at no resident cost. Not measured: whether models then pass `difficulty` rather than `model`, and
pick a worktree as described; Codex (it reaches MCP tools through `exec`, §6).

**#690: `agent_session` `list`, and the clean-up line (2026-10-17).** `list` lists the caller's own children, so
`sessionId` became optional; the description names it. `agent_session` 534 → 535 characters (`residentCost`: the
`required` entry that went away nearly pays for the enum value and the words), the agent set 1,332 → 1,333. Claude
defers `agent_session`, so its resident cost does not move there. The line naming the delete once a child's answer is
used rides in the answers (`done`, `at_rest`, a finished turn's report), at no resident cost. Not measured live.

**#861: `name` (2026-10-17).** `start_agent` gained `name`, a bare optional string with no description: a short name
for the child, shown in the sidebar, that its new worktree's branch is made from. Characters (`residentCost`): the
agent set 1,333 → 1,358 (`AGENT_BUDGET_CHARS` 1,350 → 1,375); every ordinary Claude request carries the 25, as
`start_agent` is loaded there. Not measured live: about 7 tokens at the ratio §10 measured. Without a name, the child's
name and branch skip the leading words its task shares with a sibling's name (`distinguishingText`), which costs no
schema.

**#1038: `machine` (2026-10-18).** `start_agent` gained `machine`, a bare optional string with no description: a linked
machine to start the child on, in its checkout of the caller's repository. The answer that refuses one names what is
missing (no such machine, no checkout there, unreachable), so no words ride in the schema. Characters: the agent set
grows by the argument's name and type, as `name`'s did (`AGENT_BUDGET_CHARS` 1,375 → 1,400; the reader resident
ceiling 2,600 → 2,625). Not measured live.

## 11. Centralu's features first: instructions for ordinary sessions, and the orchestrator's preamble (#564, 2026-10-12)

The owner replaced the principle that Centralu does not shape the person's workflow with a rule: unless the person
directly says otherwise, agents running in Centralu use Centralu's own features first (product-spec.md §1.2). Ordinary
sessions, which had Centralu's tools and no instructions (#320), now get one sentence, and the orchestrator's preamble
(§9, round 2) is on by default, worded as the rule:

- Ordinary sessions (`READER_INSTRUCTIONS`, 392 characters; Codex: 444 with the header over it): "You are running inside
  Centralu. Unless the person says otherwise, use its tools before other ways of doing the same: recall for earlier
  conversations; read_session for this project's other sessions; find_apps to use another project's app; ask_project to
  have another project do work; start_agent, not your Agent tool, for long work, another CLI or a worktree, or work the
  person will follow." The last entry came
  after #561's tools (§10) joined the seat; it was measured on its own (below), the rest of this section without it.
- The orchestrator (188 characters, at the head of its role): "You are an agent running inside Centralu. Unless the
  person says otherwise, use Centralu's MCP tools and commands (centralu_commands) before doing something yourself or
  using another tool."

Claude Code 2.1.289 on haiku 4.5 and `claude-sonnet-5-5` (3 repetitions), codex-cli 0.160.0 on its default
gpt-6.1-sol (2 repetitions), macOS, base commit 96267a44 (the commands tier default, #512) with this change.
`pnpm measure:tools --live --phases resident,selection --kinds none,reader,orchestrator --prompts
packages/agent-host/scripts/measure-tools/prompts-564.json` (with flags since removed), and the
Korean twin `prompts-564-ko.json`. Every selection session is an ordinary one under `safe` (the agent's own tools and
skills raise a card the measurement declines; Centralu's run, and `ask_project`'s and `attach_app`'s consent cards are
declined too), auto memory off. The prompts name no tool and not Centralu: four where a Centralu tool plainly answers
(`first-`), four that leave another way open, a shell, the file system or a guess (`tempt-`), and three where no
Centralu tool fits (`none-`: a product, a file listing of this project, a commit message), to catch over-use. Summaries:
`baselines/2026-10-12-centralu-first-564-live.json`.

### What it costs, every request

The first request of a session, Centralu's own tokens (`count_tokens`, §2) on Claude, and the difference from a
session with no Centralu tools in the same run on Codex (whose first request carries no MCP definitions, §6.2):

| | Without | With | Added |
|---|---|---|---|
| Ordinary session, Claude haiku | 412 | 511 | **+99** |
| Ordinary session, Claude Sonnet | 527 | 648 | **+121** |
| Ordinary session, Codex | +0 | +70 | **+70** (+62 to +78 on the no-tool prompts' requests) |
| Orchestrator preamble, haiku / Sonnet / Codex (first request against `none`) | | | +42 / +60 / +37 |

Under 0.7% of an ordinary session's first request on every model. These runs predate #561's agent set (§10), so the
"without" is the seat of §8. `READER_BUDGET_CHARS` goes from 1,000 to 1,400 (the set is 1,375: 983 of tools, 392 of
instructions with the `start_agent` line), which also raises the reader seat's resident ceiling, the sum of its four
sets' (`RESIDENT_BUDGET_CHARS.reader`, 3,300 → 3,700; Codex carries 3,686 with the header and #574's `delete`). A line added to
`READER_FIRST` counts against it, so a tool that joins the seat is a decision about this number too.

**The rare update tool (#581).** `update_centralu` joins the ordinary session with a minimal
`check | install` schema and a pointer in `READER_FIRST`. Updating Centralu is rare, so Claude defers
its definition behind tool search, like `app_guide`. Codex is offered the full set without a deferral
flag; its CLI decides what to load (§6.2). Measured with `definitionChars` and `residentCost` after
#576's instructions: the update definition is 298 characters, its pointer adds 36, and the reader
set is 1,709 (983 existing definitions + 298 update + 428 instructions). `READER_BUDGET_CHARS`
rises from 1,400 to 1,750, and the reader resident ceiling from 3,700 to 4,050.

| Reader profile, characters | Resident definitions | Deferred definitions | Instructions | Resident total |
|---|---|---|---|---|
| Claude | 1,867 | 1,673 | 428 | 2,295 |
| Codex, all offered tools loaded | 3,540 | 0 | 480 | 4,020 |

Claude's resident definitions stay unchanged; only the 36-character pointer joins every request.
The resident test also caps Claude at 2,300 characters to guard that deferral (2,350 since #686: start_agent's `lsp`
argument, name and type only, took the reader's Claude request from 2,288 to 2,313 characters). These are serialized
character counts, not a new live token or tool-selection measurement.

**The count had to be fixed first.** Claude Code put the servers' instructions on Sonnet in the same block as the
agent list, the skill list and the date, and the recorder took Centralu's section out up to the block's end: the
ordinary session read 7,349 tokens of its own on Sonnet with instructions, and the orchestrator 6,582. The recorder now
takes our section out by its exact text (`setOurInstructions`) and the frame only when no other server's section is
left; the figures above are from runs after the fix, and agree with the difference from `none` in the same run. Earlier
counted Sonnet figures in this document (§9 reports first-request totals there) are not affected; a counted figure of a
seat that had instructions on Sonnet before this fix would be.

### What it changes (right: the first Centralu call is an expected one; English / Korean)

Without: the first-, none- prompts from round 1's runs without the instructions, the tempt- prompts from a run without
them beside the shipped wording's. With: the shipped wording, all eleven prompts in one run.

| Prompts | haiku without | haiku with | Sonnet without | Sonnet with | Codex without | Codex with |
|---|---|---|---|---|---|---|
| `first-app` (another project's app) | 0/3 / 0/3 | 1/3 / 1/3 | 3/3 / 3/3 | 3/3 / 3/3 | 2/2 / 2/2 | 2/2 / 2/2 |
| `first-recall`, `-sessions`, `-ask` | 9/9 / 9/9 | 9/9 / 9/9 | 9/9 / 9/9 | 9/9 / 9/9 | 6/6 / 5/6 | 6/6 / 6/6 |
| `tempt-ask` ("list the files in {other}'s top folder") | 2/3 / 1/3 | 3/3 / 2/3 | 3/3 / 3/3 | 3/3 / 3/3 | 2/2 / 2/2 | 2/2 / 2/2 |
| `tempt-recall` ("have we already settled ... ? Check first.") | 3/3 / 0/3 | 3/3 / 0/3 | 3/3 / 3/3 | 3/3 / 3/3 | 2/2 / 2/2 | 2/2 / 2/2 |
| `tempt-sessions` ("is something else running in this project?") | 0/3 / 0/3 | 1/3 / 1/3 | 3/3 / 0/3 | 3/3 / 0/3 | 2/2 / 2/2 | 2/2 / 2/2 |
| `tempt-app` ("read the counter {other} shares") | 0/3 / 0/3 | 0/3 / 0/3 | **0/3** / 3/3 | **3/3** / 3/3 | 2/2 / 2/2 | 2/2 / 2/2 |
| **The eight** | **14/24 / 10/24** | **17/24 / 13/24** | **21/24 / 21/24** | **24/24 / 21/24** | **16/16 / 15/16** | **16/16 / 16/16** |
| `none-` (no Centralu tool fits): no Centralu call | 9/9 / 9/9 | 9/9 / 9/9 | 9/9 / 9/9 | 9/9 / 9/9 | 6/6 / 6/6 | 6/6 / 6/6 |

- **No over-use.** Not one Centralu call on a no-tool prompt in any run, with or without, and those turns took the same
  number of requests but one: haiku's Korean commit message, 3 → 4 (median), with no Centralu call either way.
- **Where a model already reached for Centralu, nothing changed**: Sonnet and Codex were at or near every prompt
  without the instructions. The gains are where a loaded Centralu tool competed with another: Sonnet asked about a
  counter another project shares went to `ask_project` first (0 of 3) and to `find_apps` first with them (3 of 3); haiku
  reached `attach_app` on `first-app` in 4 of 6 runs with them against 0 of 6 without, though its first call stayed
  `ask_project` in most (a Centralu feature too: with the consent card declined, the measurement cannot say whether it
  would have answered).
- **Codex spends less per turn with them.** Its turns on the positive prompts read 26% to 44% fewer input tokens
  (median per turn: `first-app` 96,611 → 70,933, `first-recall` 127,900 → 89,047, `tempt-recall` 117,741 → 71,134),
  in the same number of requests or fewer; `first-ask`, which names the project to ask, did not change. Named tools spare
  Codex looking its tools up from `exec` first (§6.2's 7,411-token step); the records do not carry the `exec` code, so
  that is the likely reason, not a confirmed one. On Claude, haiku called `recall` fewer times per turn (4 → 3
  requests in English, 4 → 2 in Korean); nothing else moved.
- **What the instructions did not fix.** Asked whether "something else is running in this project", haiku searched
  its tools for a process tool and Sonnet in Korean answered without looking; asked in Korean whether a backup was
  "already settled", haiku looked through the files instead of the conversations, with or without. These read as
  questions about processes and files, which the sentence does not claim.

**The wording.** The first wording put `ask_project for work in another project` before `find_apps for another
project's apps` (round 1: 0 of 3 / 2 of 3 first right on haiku's `first-app`, `attach_app` reached 0 / 1 of 3).
Two others on haiku's `first-app` and `first-ask` (3 repetitions, both languages): `find_apps` first, worded as using
an app (shipped; `attach_app` reached in 8 of 12 runs over two runs, `first-ask` 12 of 12), and "find_apps then
attach_app to use another project's app yourself" (4 of 6, and longer). On Sonnet and Codex the first wording already
did as well as the shipped one. Three repetitions separate none of these firmly.

### The `start_agent` line (after #561)

§10 found that "Hand this to another agent …" never reached `start_agent`: Claude Code used its own `Agent` tool, whose
subagents Centralu does not show as sessions. `prompts-561.json`'s two start prompts on haiku, 3 repetitions each,
`safe` not set (as in §10), the consent card declined; base 578db451 (#561's tools and the commands tier on main):

| Arm | Centralu's own tokens, first request | "Have Codex write …" | "Hand this to another agent …" |
|---|---|---|---|
| no instructions | 604 | 3/3 | 0/3 (`Agent`) |
| instructions without a `start_agent` line | 703 (+99) | 3/3 | 0/3 |
| + "start_agent to hand work to another agent (Claude or Codex)" | 719 (+16) | 3/3 | 0/3 |
| + "start_agent, not a subagent of your own, to hand work to another agent" | 723 (+20) | 3/3 | 1/3 |
| + "start_agent, not your Agent tool, to hand work to another agent" | 719 (+16) | 6/6 | 4/6 (two runs) |

Only a line that names the competing tool moved the choice; a line that merely lists `start_agent` did nothing. With
the last one, on haiku, the no-tool prompts still made no Centralu call (9 of 9) and `first-ask` and `first-sessions`
stayed 3 of 3 each.

**Option B (owner decision, 2026-10-12).** The CLI's own subagents stay the way to hand off short helper work inside the
turn; `start_agent` is for work that runs in another CLI or a worktree, runs long, or that the person will watch or
continue. The line now says so and still names the Agent tool (106 characters, 108 with its separator): "start_agent,
not your Agent tool, for long work, another CLI or a worktree, or work the person will follow". Measured on
`prompts-564-agent.json` (`safe`, consent cards declined, 3 repetitions), base 578db451:

| Prompt | Expect | haiku | Sonnet |
|---|---|---|---|
| "Have Codex write a one-line shell command …" | `start_agent` | 3/3 | 3/3 |
| "Hand this to another agent and tell me what it says: summarize …" (short; ambiguous under B) | either | `start_agent` 1/3, `Agent` 2/3 | `start_agent` 3/3 |
| "Hand off building a CSV-to-JSON converter …, with tests. It is a long job and I want to check on its progress myself later." | `start_agent` | 3/3 (two then tried `Agent` after the declined card) | 3/3 |
| "Use a helper to search the code here for TODO comments …" | the built-in `Agent`, no Centralu call | `Agent` first 3/3, no Centralu call | `Agent` first 3/3, no Centralu call |
| The three no-tool prompts | no Centralu call | 9/9 | 9/9 |
| Centralu's own tokens, first request | | 731 (+28 against no line, +12 against the line before) | 931 |

The short ambiguous hand-off splits on haiku and goes to `start_agent` on Sonnet; the long one and the named CLI reach it
on both, and the helper search stays with the built-in subagent on both. `Agent` is Claude Code's name; on Codex, whose
own sub-agents §10 also saw, the line was not measured.

**The orchestrator's preamble** was measured in §9 round 2 (no regression, no gain that held); its new wording was not
measured on the orchestrator's prompts here, only its cost above.

**Spend.** $10.40 at list prices for 1,901 Claude requests ($6.24 on Sonnet, $4.16 on haiku; the `start_agent` line
$2.20 of it, option B $1.17; cache writes priced at the one-hour rate, so an upper bound), no builder session (no prompt made an app),
and about 140 Codex turns on the account's plan.

**Not measured.** Opus as an ordinary session's model; a session that was already running when the change ships
(a Claude session picks the instructions up when its process next starts, at a one-time cost to its cache; a Codex
thread keeps what it was started with, agent-host.md §1.1); prompts deep in a long conversation, where the instructions
are far from the question; the consent cards allowed, so what `ask_project` or `attach_app` would then have answered;
the orchestrator's new preamble on its own prompts; the `start_agent` line on Codex and in Korean, and with the consent
card allowed (whether the child then does the long job); Windows and the packaged app.

**#957: repository work through an app's guide (2026-10-17).** Owner decision: no task-to-tool table in these
instructions, which sit in the prompt's cached prefix and would change whenever an app does; an app such as the
project board serves its own table on demand from its `help` tool. One line, the same whichever apps they are, sends
an agent there first (`REPO_WORK_FIRST`): "an attached app's help tool before repository work by hand (PRs, CI,
merges, releases)". Only in an ordinary session that has an app attached when it starts
(`READER_INSTRUCTIONS_WITH_APPS`): without one there is no help to read. Decided at the start, so a session's prefix
never changes under it. Not in the orchestrator's instructions: it does no repository work itself. Characters: +88 in
such a session's instructions (`residentCost` counts a session with no app, so the reader stays 2,585 on Claude and
4,422 on Codex, and `READER_BUDGET_CHARS` stays 1,750). Not measured live: whether agents then call an app's `help`
before `gh`.

**#853: the orchestrator's children (2026-10-17).** `start_agent` and `agent_session` joined the orchestrator's rare
commands (`RARE_COMMANDS`), so their 1,357 characters ride in none of its requests in the default tier; one line of
its instructions names `start_agent` for light work outside any project. Orchestrator (`residentCost`): 8,744 →
8,893 on Claude, 8,796 → 8,945 on Codex. Not measured live.

## 12. The orchestrator's tool list and the projects that are apps (#1205, 2026-10-19)

Since #1141 the orchestrator was given the root app of every trusted project as its own MCP server, so its tool list
grew with each project the person trusted, whether it called the app or not. Measured without a model
(`sessions/orchestrator-app-cost.test.ts`): the orchestrator's served list, Centralu's definitions plus every attached
app's tools as `mcp__<server>__<tool>` with description and schema (`definitionChars`), in the default `commands` tier.
Each root app is the one `create_app` makes: `show` and `increment` for the agent (`reset` is the screen's alone), and
the host's `run_status`, about 793 characters per app. On Claude app tools wait behind tool search, so only their names
ride in a request; Codex loads them.

| Trusted root apps | 0 | 3 | 10 |
|---|---|---|---|
| Before: tools (servers) | 11 (1) | 20 (4) | 41 (11) |
| Before: characters, Codex | 6,800 | 9,179 | 14,733 |
| Before: characters, Claude (names of deferred app tools) | 6,800 | 7,004 | 7,483 |
| After: tools (servers) | 11 (1) | 11 (1) | 11 (1) |
| After: characters, Codex and Claude | 6,800 | 6,800 | 6,800 |

Characters are of the definitions alone; about four make a token (§8: `find_apps`, 294 characters, measured 75
tokens), so ten such apps cost a Codex orchestrator about 2,000 tokens in every request before, and none after. The
orchestrator now attaches a root app when it needs one: `find_apps`, `attach_app` and `detach_app` joined its rare
commands, so their 874 characters ride in none of its requests; one line of its instructions (+75 characters) names
"the find_apps command", as the others name theirs, so the first call is not a refused bare name. Its resident cost
(`residentCost`), after #1219's machine commands: 9,368 → 9,443 on Claude, 9,420 → 9,495 on Codex, against a ceiling of
9,500; the line was cut to fit. An app it attached costs what it did before, until `detach_app`. The user-folder apps stay given (apps.md §9.1).

The preferences and archive commands (#1219: `get_preferences`, `set_preferences` and five commands for the session archive, all rare; the archive was called the trash until #1404, and `list_trash` became `list_archive`) came with
almost no more resident cost. The machine line, which named six commands, now names one and says to look for the rest with
`centralu_commands` and the query "machine"; the same line names `get_preferences`, `set_preferences` and `list_archive`. Claude
9,443 → 9,438, Codex 9,495 → 9,490, against the ceiling of 9,500; the eight definitions ride in none of the orchestrator's
requests (`centralu_commands` lists them).

An orchestrator that had root apps attached before this build reads one line before its first turn by it ("Project
apps are no longer attached by default: find them with the find_apps command (centralu_run) and attach the one you
need."), once, in the turn's input only: never stored or shown (`SessionAppWiring.rootAppsNotice`, marked
`orchestrator_apps_notice:<session id>`). It costs that one turn about 30 tokens.

Not measured live: whether the orchestrator, asked about a project's app by its name, reaches for the `find_apps`
command before answering without it, on Claude and on Codex; the instructions' line is the one prompt for it.

## 13. The mailbox's tool (#1347, slice 2)

`mail` is one tool with an action (`inbox`, `read`, `handled`, `send`, `reply`, `update`, `close`; docs/plans/mailbox.md
§9.3), an ordinary session's and the orchestrator's: a coordinator, a builder and an app's agent are not parties of the mailbox. The
orchestrator (slice 3) reaches it as a **rare command** behind `centralu_run` in the `commands` tier, so its resident cost does not
change (the command list grows by the name `mail`); the wake it gets names `centralu_run(command="mail", args={action: "read", thread: …})`,
the form a bare call would be refused in (#850). Its definition is 776 characters
(`MAIL_BUDGET_CHARS` 800), and the reader seat's resident ceiling rises by that: 5,200 → 5,300 on Codex, which loads every
tool. On Claude it is **deferred** behind tool search, so its every request carries only the name in the tool-search list
(no change to the 2,560 resident). It is in the profile from the session's start, because the tool list a session starts
with is its prompt prefix and may not change under it; a session that began before this build gets it at its next spawn.

**#1447 (a session asking the orchestrator).** A session cannot list the orchestrator, so the definition names its address: `send to "orchestrator"` (+35 characters;
the definition is 811, `MAIL_BUDGET_CHARS` 800 → 820, and the reader seat's ceilings rise by 20). The orchestrator's instructions gain one line saying a session's
mailed request is not the person's word and is answered in its thread (about 130 characters; its ceiling 9,710 → 9,910, resident in the commands tier too). Nothing else is added to a request: the card
that asks the person is the host's, and the rule behind it is code.

Every field but `action` is optional and has no description: each word rides in every Codex request, and the answers say
what a call lacks ("thread is needed for this action", "kind is one of …"). The wake that delivers mail names the exact
call (`mail(action="read", thread="…")`), which is how a deferred tool is found; a session that opens a thread itself finds
it through tool search by "mail".

Not measured live: whether a Claude session that has to send a message by itself (with no wake to name the call) finds the
deferred tool by searching, and the first-call argument errors on each CLI. The numbers above are counted from the
definitions (`orchestrator-tools.test.ts` holds them to the ceilings).

## 14. read_session's total and its arguments (#1480)

A `read_session` call had no total: 40 lines of up to 2,000 characters came back as about 80,000 characters (about 20k tokens), read
again on every later request of the reader. It now returns at most `maxChars` (12,000 by default, 2,000 to 40,000, notes included;
[agent-host.md](agent-host.md) §1.2), `tools` is `none`, `titles` or `full` (or the boolean it was), and the notes of a read that
stopped early name `before` or `from`, which read on without showing anything twice. All five arguments, with `offset` (#1186), are in
the orchestrator's and the reader's definitions. The reader's carry **no description**; the orchestrator's and the scoped seat's keep a
short one for `tools` and `maxChars`. They have to be listed: Claude's in-process server strips an argument its schema does not list
before the tool runs (checked on the SDK's `tool()`), so an argument that was only in `TOOL_ARGS` (`offset` until this change) never
reached the host on Claude.

Measured in characters (`residentCost`, the budget tests), not live in tokens:

| Seat | Before | After | Ceiling |
|---|---|---|---|
| reader set (`READER_BUDGET_CHARS`) | 1,709 | 1,913 (+204) | 1,750 → 1,950 |
| reader, Claude resident (definitions + instructions) | 2,605 | 2,809 | sum of the sets' ceilings |
| reader, Codex (all loaded) | 5,219 | 5,423 | 5,300 → 5,500 |
| orchestrator, Codex (developer instructions) | 9,485 | 9,663 (+178) | 9,500 → 9,700 |
| scoped, Codex | 2,382 | 2,560 (+178) | 2,400 → 2,600 |

#1487 restored `.int().min(0)` on `offset`, which #1489 had lost: +12 characters in the reader set and the orchestrator's definition. The
reader set with its instructions is 1,953 against a ceiling now 1,960, the reader on Claude 2,849 against a sum now 2,850, and the
orchestrator 9,703 against a ceiling now 9,710 (Codex's figures move with them by the same 12).

A live run of the first version of this change (`tools` and `maxChars` only) measured +44 tokens per request for an ordinary session and
+34 for the orchestrator, against about 3,900 tokens saved by one default read of a long session; the arguments added since (`before`,
`from`, `offset`, the boolean) cost about 110 characters more and were not measured live.

Not measured live: tokens through `pnpm measure:tools --live` for the final definitions, and whether a reader with these arguments and
no description picks `maxChars` by itself when a note says a read stopped early.

## 15. compact_self (#1451)

`compact_self({ focus? })` asks Centralu to compact the calling session when its turn ends (docs/agent-host.md "Compacting at a break"). An
ordinary session's and the orchestrator's; a coordinator and a builder do not have it. It is **loaded** on Claude, not deferred: its description is the
instruction on when to use it (work finished and reported; before waiting over a few minutes on a child, CI or the person; switching to an
unrelated task), and a deferred tool is not read until something searches for it. Counted from the definition: 453 characters
(`COMPACT_BUDGET_CHARS` 460), which raises the reader seat's Claude resident ceiling 2,850 → 3,310, its Codex ceiling by the same, and the
orchestrator's 9,710 → 10,170 (its tool list is resident in the commands tier too). The saving it is for is measured in #1451 (cache reads of
contexts over 300k tokens were 64% of the cost); the tool's own cost is a few dozen tokens per request.

**Whether an agent calls it on its own (#1492, one run, 2026-10-24).** An agent cannot see its context size, so Centralu tells it quietly when it
passes shares (docs/agent-host.md "Telling a growing session"). Claude on its cheapest model (`haiku`, window 1,000,000 as the CLI reported it), an
in-process host on a temporary store, the shares set to 10% and 25% (the defaults are 30% and 10 points under the tool's 60%, which a 1M window only
reaches at 300k and 500k), one turn of three steps that read thirty 30 KB files (about 8,800 tokens each), write a summary and report. The meter moved
with every request (18 estimates, one per 3 s, from 35k to 301k; the tool's reading at the turn's end replaced the last, 301,480). The notices arrived
at 11% (106k) and 26% (256k), once each, in the middle of the Read calls, with no turn started. The agent **kept reading** to the end of the step it was
on, wrote the summary, and **called `compact_self` once right after it** (its answer: "Asked to compact"), not at either notice: the behaviour the
notice asks for ("when this step of the work is done"). One run on one model: not a rate. Codex was not run (no Codex CLI on the machine that did it).
