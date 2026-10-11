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

Codex is sent no server instructions: the bridge answers `initialize` without them.

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
  of its three sets' ceilings). It reuses the reader set's own budget tests rather than repeating them.
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
   prompt that said "use it", found it 5 of 5. Deferral is not free for selection.
5. **A free-string argument fails first try.** `app_guide`'s topic: 0 of 4 first calls worked.
6. **Codex: a model set before a session's first turn breaks it.** The change restarts the thread
   through resume, Codex has no rollout to resume before a first turn, and the next send fails with
   "Could not resume the conversation". The script measures such seats on their default model.
7. **Codex: a model change showed no rebuild** (gpt-6.1-sol → gpt-6-astra read 21,248 tokens from cache).
   Either the change did not reach the thread or Codex's cache crosses those models; not settled here.
