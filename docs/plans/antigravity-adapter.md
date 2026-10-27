# The Antigravity CLI adapter (#59, #1498)

Proposed 2026-10-26. A design to agree on before code: what was measured from Antigravity CLI (`agy`), how a
Centralu session runs it, how its stream maps onto our events, how approvals reach a card although print mode cannot
ask, and how it is tested from recorded frames (#1498). `agy` has no Agent Client Protocol (ACP) surface, so it gets
its own adapter; it takes the tool-neutral parts of the ACP work ([acp-adapter.md](acp-adapter.md), branch
`feat/acp-cursor`) instead of designing them again ([§11](#11-what-is-taken-from-the-acp-work)). A record like the rest
of `plans/`, so not mirrored in Korean; [agent-host.md](../agent-host.md) §2–3 gains the lasting parts in the same pull
request as the code.

Owner rule (2026-10-26, #59): Centralu runs only the official CLI and never reads, copies or reuses its login. The
person logs in with `agy` in a terminal.

## 1. What was measured

`agy` 1.4.7 (a single 192 MB Go binary at `~/.local/bin/agy`) on macOS, logged in with a free Google account,
2026-10-26. Twenty model turns on `gemini-3.8-flash-low`, driven by a scratch recorder that spawns `agy`, writes
scripted lines to its stdin and records every stdin, stdout and stderr line with its time. The Gemini weekly quota went
from 99.6% to 94% remaining; the limit was never reached. Where a fact comes from the documentation and changelog
embedded in the binary instead of a run, it says so.

A second round on 2026-10-27 used the committed recorder (`scripts/agy-record.mts`, §10.1) with the real gate hook:
the §10.4 scenarios and seven hook failure modes on 1.4.7, then five on 1.4.8 (a tool call, a deny, a Stop with a gate
request open, a hook that prints nothing, an unknown conversation id), which `agy` installed by itself between two runs
(its changelog lists no change to the stream, hooks or print mode, and the replayed scenario read the same; a hook that
prints nothing still lets the tool run). The quota went from 93% to about 84% remaining.

The raw recordings hold local paths and stay outside the repository; scrubbed ones are committed under
`packages/agent-host/src/adapters/agy/recordings/agy-<version>/` ([§10](#10-tests-1498-from-the-start)).

### 1.1 Print mode and its stream

`agy -p "<prompt>" --output-format stream-json` prints one JSON object per line. `--input-format stream-json` keeps
the process open and runs one turn per stdin line, in one conversation. **`-p` takes a value**: with stream-json input
the working form is `agy --input-format stream-json --output-format stream-json [flags] -p=` (an empty prompt
attached to the flag; a bare `-p` fails with "flag needs an argument", and `-p --input-format …` takes the next flag
as the prompt and says so).

Input lines (measured, and the CLI's own error texts):

```
{"event":"user","message":{"content":"<text>"}}
{"event":"user","message":{"content":[{"type":"text","text":"<text>"}]}}     only "text" blocks
```

| Input `event` | What `agy` does |
|---|---|
| `user` | runs a turn |
| `control_request`, `control_response` | **known but refused**: `error: stream input message event "control_request" is not supported yet`, a `result` with `status: ERROR`, exit 2 |
| anything else (`interrupt`, `cancel`, `keep_alive`, `permission_response`, …) | `warning: ignoring unsupported stream input message event "<name>"` on stderr, nothing else |

So there is no stdin control channel in 1.4.7: no interrupt, no approval answer, no settings change. The two reserved
names say one is planned; the drift check watches for them ([§10.5](#105-refreshing-and-drift)).

Output lines, in order, for one turn:

```
{"event":"init","conversation_id":"<uuid>","init":{"model","cwd","tools":[…],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{…,"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"pine"}}
{"event":"step_update","step_update":{…,"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n",
   "duration_seconds":2.18,"usage":{"input_tokens":6780,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":6781}}}
{"event":"result","result":{"conversation_id","status":"SUCCESS","response":"pineapple\n","duration_seconds",
   "num_turns":1,"usage":{…},"denied_actions"?:[{"action":"command","display_name":"RunCommand"}]}}
```

- `init` comes once per process, **after the first input line is read** (3.5–5.4 s after it on a cold start), not at
  launch. An idle process that has read nothing has printed nothing.
- `step_index` counts the conversation's steps across processes (a resumed conversation continues the numbering).
- Step types seen: `user_input`, `system_message`, `agent_response`, `tool`, `subagent`. The changelog calls the
  vocabulary "closed" with a "stable" discriminator; compaction and other steps were not seen ([§6](#6-context-and-compaction)).
- `agent_response`: `ACTIVE` frames carry `text_delta`; the `DONE` frame carries the last delta (often `"\n"`) and
  that model call's `usage`. A model call that only calls tools has an `agent_response` `DONE` with `usage` and no text
  (the transcript confirms it had no text, only `tool_calls`).
- `tool`: an `ACTIVE` frame with `tool_name` and `tool_info.parameters`, then `DONE` with `tool_info.output` or
  `ERROR` with `tool_info.error {type: "TOOL_ERROR", message}`. **There is no call id**; the `step_index` is the key.
- `system_message`: content is not in the stream (the transcript has it). Seen for a SessionStart hook's injected
  message and for the notice `agy` adds on every resume ([§1.4](#14-resume)).
- `thinking_tokens` is counted (59, 130, 262 in runs) but **no reasoning text is streamed**.
- `result.usage`, `num_turns` and `duration_seconds` are **cumulative for the conversation**, across processes (a
  resumed conversation's fourth turn reported `num_turns: 4` and the sum of all four); per-call figures are the
  `agent_response` `DONE` frames'.
- The `init.tools` list is not what runs: `read_file` ran although the list has `view_file` and no `read_file`.

### 1.2 Approvals: print mode cannot ask, a hook can

Without flags `permission_mode` is `request-review`. A tool that needs a confirmation is **soft-denied**: the tool step
ends `ERROR` ("permission check failed … user denied permission to run command"), stderr says
"a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an
allow-rule under permissions.allow in settings.json … or re-run with --dangerously-skip-permissions", the `result`
lists `denied_actions`, and **the turn ends there** (the model gets no further call). `--mode` and
`--dangerously-skip-permissions` are the only per-run presets; neither asks anyone.

`agy` runs **lifecycle hooks** (`hooks.json`, documented in the binary): `SessionStart`, `PreToolUse`,
`PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. A hook is a command (`sh -c` on Unix, `cmd /c` on Windows)
that gets JSON on stdin and answers JSON on stdout. Measured in print mode:

| What | Measured |
|---|---|
| `PreToolUse` input | `{conversationId, stepIdx, toolCall: {name, args}, workspacePaths, transcriptPath, artifactDirectoryPath, modelName, lastUserInput}`; `stepIdx` equals the stream's `step_index` of that tool step |
| It blocks | the tool waited for the hook: 4 s and **90 s** (with `"timeout": 600` in the hook entry); the tool step stayed `ACTIVE` meanwhile |
| `{"decision":"deny","reason":R}` | tool step `ERROR`, message `tool call denied by pre-tool hook: R`; **the model continues** and can tell the person |
| `{"decision":"allow"}` without the skip flag | **not enough**: the headless permission check still soft-denied; `permissionOverrides: ["command(<cmd>)"]` did not lift it either |
| `{"decision":"allow"}` with `--dangerously-skip-permissions` | the tool runs; `init.permission_mode` reads `always-proceed` |
| `{"decision":"ask"}` | soft-denied as above (print mode cannot ask) |
| The hook outlives its entry's `timeout` | killed; tool step `ERROR` (`JSON hook "…" failed: … signal: killed`); the tool does not run |
| The hook exits non-zero | the tool does not run, **even when it printed `allow` first** |
| It prints something that is not JSON, `{}`, or a decision `agy` does not know | the tool does not run (`{}`: `tool call denied by pre-tool hook:` with no reason) |
| **It prints nothing and exits 0** | **the tool runs**: the one failure that opens the gate, so the gate script prints a decision on every path (§5.4) |
| Tools outside `init.tools` | `write_file` (`Path`, `Content`) ran and passed the hook though the list does not name it; the stream's `tool_info.parameters` showed only `Path`, the hook got every argument |
| Coverage | with matcher `"*"`: `run_command`, `read_file`, `call_mcp_tool`, `invoke_subagent`, and the **sub-agent's own** tool calls (with the sub-agent's `conversationId`) |
| Environment | the hook inherits `agy`'s environment (a variable set on `agy` reached it) plus `ANTIGRAVITY_CONVERSATION_ID` |
| `PostToolUse` | fires after a tool that ran; not after a denied one |
| `SessionStart` | fires on a new conversation's first turn (not in a process that ran no turn); its `injectSteps: [{systemMessage: {systemMessage}}]` reached the model |
| `Stop` | fires when a turn ends normally (`terminationReason: "NO_TOOL_CALL"`); not seen for a soft-denied turn |

**That is the approval path**: the session runs with `--dangerously-skip-permissions`, and Centralu's own
`PreToolUse` hook, which blocks until the person answers the card, is the only gate ([§5](#5-approvals)).

### 1.3 Where hooks, MCP servers and rules come from, without writing anyone's config

Customization roots (embedded docs): the global `~/.gemini/config/` and every `.agents/` between the working folder and
the project root. Both belong to the person (their config, their repository). Measured: **a folder passed with
`--add-dir` is a customization root too.** `--add-dir <root>` where `<root>/.agents/plugins/centralu/` holds

```
plugin.json        {"name": "centralu"}
hooks.json         the gate (§5)
mcp_config.json    {"mcpServers": {"centralu": {"command", "args", "env"}}}
rules/AGENTS.md    text the model reads as a rule
```

loaded all four in a run whose working folder had no `.agents` at all: the hook gated tools, the MCP server's tool was
called, and the model quoted both the rule text and the SessionStart message. Nothing was written to
`~/.gemini/config` and nothing to the working folder. The plugin's enabled state lives in the person's `config.json`
only if they toggle it; with no entry it is enabled.

Side effects to know:

- The `--add-dir` folder becomes a workspace: it appears in `workspacePaths` and in a sub-agent's `workspace_uris`,
  so the agent may read it. It holds no secret ([§7](#7-centralus-tools)).
- An MCP server from a plugin is named `<plugin>_<server>` (`centralu_centralu`). Its tools are not native tools:
  `agy` writes one descriptor per tool under `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`, the model reads it
  with `read_file`, then calls `call_mcp_tool {ServerName, ToolName, Arguments}`. The `tools/call` request carries
  `_meta` with `antigravity.google/conversation_id`, `…/root_conversation_id` and `…/artifacts_dir`.
- The MCP server process inherits `agy`'s environment (measured: a variable of the parent process reached it).
- `agy` opens MCP with `server/discover` (protocol `2026-07-28`) and falls back to `initialize` (`2025-11-25`).

### 1.4 Resume

| Case | Measured |
|---|---|
| `--conversation <id>` after a clean end | context intact |
| after SIGINT | context intact; the interrupted answer is saved as far as it got |
| after SIGKILL mid-turn | **no lock, no error**; context intact; the killed answer is **not** saved (the transcript skips its step index); the presence file `presence/<id>.lock` stays behind and does not block |
| two processes on one conversation | process B ran a turn on the conversation while process A held it open and idle: no refusal |
| `--continue` | resumes the most recent conversation **of the working folder** (`cache/last_conversations.json` maps folder → id) |
| `--conversation <unknown id>` | stderr `warning: conversation "<id>" not found`, then **a new conversation is created and the turn runs in it** (a new id in `init`), exit 0. The warning comes 0.4–0.7 s after the start, `init` about 3.9 s; stopped with SIGINT at `init` (recording `unknown-id`, 1.4.8), `agy` answered `failed to send message: trajectory not found` (`result` `ERROR`, `num_turns` 0) and no model answer came |
| every resume | `agy` adds a `system_message` step: "[Notice] All your subagents and background tasks have been stopped due to server restart …" |

### 1.5 Interrupt

SIGINT to the `agy` process (alone or with its group): within 30 ms `error: interrupted` on stderr, a `result
{status: "ERROR", error: "interrupted", response: <the partial text>}`, and **the process exits** (code 1). The
interrupted answer is saved. There is no way to stop a turn and keep the process. Closing stdin while idle ends the
process normally (exit 0). No child process was left behind in any run (hooks, the MCP server).

**SIGINT does not end a turn while a `PreToolUse` hook runs.** With a gate request held open, `agy` printed nothing and
stayed until the hook process ended (97 s, when it was stopped by hand); then the tool step ended `ERROR`, stderr
`error: interrupted`, and the process exited 1. With the open request answered `deny` first and SIGINT right after, the
process exited within about a second, code 1 (0.66–0.97 s over the runs; recording `interrupt-gate`, 1.4.8). So a Stop answers every open gate request `deny`
before it sends SIGINT (§3.3).

### 1.6 Input during a turn

A second `user` line sent 2.6 s into a running turn was **queued**: it ran as its own turn after the first one's
`result`, with its own `result`. One `result` per input line, in order. The person's `settings.json` can change this
(`"queuedMessages": "send-immediately"` interrupts the running turn with the new message, per the changelog; not run).

### 1.7 Read-only commands, models, effort, quota, login

Print mode answers some slash commands without a turn, without quota and without creating a conversation
(`conversation_id: ""`), with a structured `command.data` under `--output-format json`:

| Command | `command.data` (measured) |
|---|---|
| `-p /usage` (also `/quota`) | `{description, groups: [{name: "Gemini Models", buckets: [{id: "gemini-weekly", window: "weekly", remaining_fraction, reset_time}]}, {name: "Claude and GPT models", …}]}` |
| `-p /model` | `{id: "gemini-3.8-flash-high", label, effort: "high", is_default}`: the persisted default |
| `-p /effort` | `{adjustable: true, current: "high", available: ["low", "medium", "high"]}` |
| `-p /help` | the commands print mode answers: `/agents /changelog /config /credits /effort /help /hooks /model /permissions /plugin /skills /usage` |
| `-p /context` | refused: "not available in print mode (it opens the interactive context breakdown)" |
| `-p /compact` | **not a command in print mode**: sent to the model as plain text (a turn spent; the model tried a shell command) |

`agy models` prints `id<TAB>label` lines: `gemini-3.8-flash-{high,medium,low}`, `claude-sonnet-4-6`,
`claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. The effort is part of the Gemini ids; `--effort` (low … max) also
exists. `agy models --output-format json`, which the changelog mentions, is refused by 1.4.7 ("flags provided but not
defined"). `agy agents` printed nothing (no custom agents).

Login: not logged in (a temporary `HOME`, below), `-p /usage` answers within 0.4 s, without a terminal and without
opening a browser: stderr `Error: authentication required. Run 'agy' to log in, then retry.`, `result {status:
"ERROR", error: "authentication failed or timed out"}`, exit 1. The changelog says print mode can otherwise take an
OAuth code from the controlling terminal; the adapter never gives it one ([§3.1](#31-one-process-per-live-session)).

### 1.8 State on disk, and a temporary home

Every run writes under `~/.gemini/antigravity-cli/`: `conversations/<id>.db`, `brain/<id>/` (artifacts and
`.system_generated/logs/transcript_full.jsonl`), `presence/<id>.lock`, `cache/last_conversations.json`,
`conversation_summaries.db`, `implicit/*.pb`, `log/cli-*.log`, and the MCP descriptors above. A stream-json process
that runs no turn still creates an empty conversation; the read-only commands do not.

**A temporary `HOME` logs `agy` out** (the login is found through the home folder). There is no other home or config
variable in 1.4.7: the binary's environment names are `AGY_ACCOUNT`, `AGY_ADC_AUTH`, `GEMINI_API_KEY`,
`ANTIGRAVITY_PROJECT_ID` and the like, none for a config or state folder. So tests can use a temporary home only for
the "not logged in" case; real turns run against the person's real `agy` state.

## 2. Shape

```
adapters/agy/
  index.ts          AgyAdapter implements AgentAdapter: detect, models, usage, capabilities
  session.ts        AgySession implements SessionHandle: the process, the input queue, interrupt, resume, teardown
  stream.ts         stream-json lines → our own narrow types (anti-corruption, agent-host.md §2)
  normalize.ts      step_update / result / stderr → NormalizedEvent (a small per-turn context)
  gate.ts           the host side of the PreToolUse gate: hook request → approval card → decision
  plugin-root.ts    writes the per-session --add-dir root (§3.2)
  tool-kinds.ts     agy tool names → read / edit / execute / mcp / subagent / other
  known-steps.ts    step types and stderr markers mapped or left out on purpose (unmapped.ts reads it)
  agy-gate.mjs      the hook command (always runs; bundled like orchestrator-bridge.mjs)
  gate-answer.mjs   what the hook does: post the call, print one answer (§5.1)
  recordings/agy-<version>/   scrubbed recordings (fixture data)
```

`registry.ts` adds `new AgyAdapter()`. `ToolName` is an open string (#74) and the descriptor (`Antigravity`, a mark,
the install line, `agy` to log in) rides with `agents.detect`, so protocol, core and UI do not change.

## 3. Process model

### 3.1 One process per live session

```
agy --input-format stream-json --output-format stream-json
    --model <id> [--effort <e>]
    --dangerously-skip-permissions
    --add-dir <plugin root>
    [--conversation <externalId>]
    -p=
```

spawned with the session folder as `cwd`, through `whichTool` and `launchFor` (`agy` is a plain binary on macOS
and Linux; Windows to measure), by `LocalAgentProcess` / the keeper's `ProcessSource.spawn` with `spawnGrouped`. Never
`shell: true`. stdin stays a pipe and there is no controlling terminal, so a login can never be prompted for;
`--print-timeout` is left at its default (no limit).

- One process per Centralu session, as for Codex: a crash ends one session, the keeper adopts each process across a
  host swap as today, and per-session settings are per-process flags. Measured: ~183 MB resident for an idle process.
- The process lives while the session does. It is **replaced** after every interrupt (the CLI exits, §1.5) and after a
  settings change that needs a flag (model, effort): the next input starts a new process with `--conversation`. A new
  process costs 3.5–5.4 s before `init` (measured, cold).
- **Never `--continue`**: it picks the folder's latest conversation, which may be another session's. Always
  `--conversation <externalId>`.
- `--mode` is not passed: the binary has a message for modes print mode does not support headless, and `auto` is a
  reviewer agent of its own; our gate decides instead.

### 3.2 The plugin root

Per session, under the host's data folder (`<CC_DATA_DIR>/agy/<sessionId>/`), never the session folder and never the
person's config:

```
.agents/plugins/centralu/plugin.json       {"name": "centralu"}
.agents/plugins/centralu/hooks.json        PreToolUse "*" → agy-gate.mjs (timeout: §5.4); SessionStart → role text (§7.2)
.agents/plugins/centralu/mcp_config.json   Centralu's bridge and one entry per attached app (§7.1)
.agents/plugins/centralu/rules/AGENTS.md   only if the role text needs a rule file (§7.2)
```

The files hold paths and names, **no secret**: the bridge credential and the gate's callback address reach the hook and
the MCP servers through `agy`'s environment, which both inherit (measured). The folder is made read-only, and the gate
refuses any write into it, since the agent sees it as a workspace. It is removed with the session.

### 3.3 Teardown

An interrupt answers every open gate request `deny` ("The turn was stopped.") and only then sends SIGINT: `agy` does not
act on SIGINT while a hook runs (§1.5), so the other order hangs until the hook's own timeout (97 s measured before the
hook was stopped by hand; with `deny` first, the process ended within about a second).

`dispose()`: answer every open gate request `deny` ("the session is closing"), close stdin if idle; if a turn runs,
SIGINT, wait for its `result` and exit up to the existing stop bound (`stopConfirmMs`), then stop the process tree with
`killHandle` (the Windows sweep by creation time). The hook commands and MCP servers are in that tree. `detach()` (a host
swap) sends nothing.

## 4. From the stream to our events

### 4.1 The table

| `agy` | NormalizedEvent | Notes |
|---|---|---|
| `init` | `agent_version` from `agy --version` at detect; `externalId := conversation_id` | **resume check**: an `init` whose id is not the `--conversation` asked for is the unknown-id case (§4.4) |
| `user_input` `DONE` | dropped | an echo of our input |
| `agent_response` `ACTIVE` `text_delta` | `message_delta` | `messageId` from `conversation_id:step_index` |
| `agent_response` `DONE` | last `message_delta`; `usage` → per-call tokens and the context reading (§6) | a `DONE` with no text is a model call that only called tools |
| `tool` `ACTIVE` | `tool_call` | call id `step:<step_index>`; title and kind from `tool-kinds.ts` and `tool-titles.ts`; the hook's `toolSummary` arg, when the gate saw it, is the card's summary |
| `tool` `DONE` | `tool_result` | `tool_info.output`; edits → `files_touched` from the edit tools' path args |
| `tool` `ERROR` | `tool_result` (error) | a gate deny and a soft-deny keep their own wording |
| `subagent` `DONE` | `subagent_event` (started) | `subagent_info.subagents[]: {type_name, role, initial_prompt, conversation_id, log_uri}`; §4.3 |
| `system_message` | dropped | content not streamed; the resume notice is agy's, not the person's |
| `result` `SUCCESS` | `turn_complete` | `denied_actions` → a `notice` naming them (should not happen under the gate) |
| `result` `ERROR` `"interrupted"` | the turn ends `interrupted` | only after our SIGINT; otherwise `INTERRUPTED_BY_TOOL` |
| `result` `ERROR` other | `error` with the text | auth and "model not found" get their own wording; stderr `AGY_ERROR: {…}` (changelog: canonical status, retryability, error id; exit 3) when present |
| stderr `warning:` / `error:` lines | host.log; `error:` also feeds the next `error` | never shown as conversation text |
| process exit | `error` + `session_live {live: false, reason: 'crashed'}` unless we stopped it | open gate cards released (`PendingCards`), queued inputs said undelivered |
| an unknown `step_type` or `event` | nothing; one host.log line | `unmapped.ts`, with `known-steps.ts` |

`result.usage` is cumulative for the conversation and is not used for a turn's tokens; the turn's tokens are the sum
of its `agent_response` `DONE` frames.

### 4.2 Turns and input

The adapter **queues input itself**, as the ACP core does: a message sent while a turn runs waits and is written to
stdin when that turn's `result` arrives. `agy` would queue it too (measured), but the person's own `queuedMessages`
setting can turn that into an interrupt, and a host-side queue keeps one meaning across tools. `midTurnInput` is false;
`turnInputs()` says what each turn took. `nudge` and `quiet` input are left unimplemented in P1; a `PreInvocation`
hook's `ephemeralMessage` is the candidate for a nudge (not measured).

### 4.3 Sub-agents

`invoke_subagent` is asynchronous: its step ends `subagent` `DONE` within ~2 s with the child's conversation id, and
the child reports back through its own `send_message` tool, which reaches the parent as a `system_message` step and
another `agent_response` in the same turn (measured). The child's steps are **not** in the parent's stream; its tool
calls do reach our gate (with the child's `conversationId`), so its approvals work. P1 maps the start (`subagent_event`
with `parentCallId`) and closes it when the turn ends; `builtInSubagents` stays false until the child's progress has a
source. The child's transcript (`log_uri`) is a file, and reading it is ruled out by §8.

### 4.4 Resume and the unknown id

`resumeExternalId` → `--conversation <id>`. Since an unknown id silently starts a new conversation and runs the turn
in it (§1.4), the adapter checks the first `init`: an id that differs, or the stderr `warning: conversation … not
found` before it, stops the process at once (SIGINT) and becomes the existing "no record of this conversation" error.
The prompt has then already reached the new conversation; that conversation is left as it is (there is no delete
command), and the session keeps its old `externalId`. Open question 5 asks whether a cheaper probe is worth looking for.

## 5. Approvals

### 5.1 The gate

`agy-gate.mjs` is the `PreToolUse` command. It reads the hook input, posts it to the session's gate address with the
session's gate credential (`CC_AGY_GATE_URL`, `CC_AGY_GATE_TOKEN` from the environment, which `agy` passes on to its
hooks), waits for a decision and prints `{"decision": "allow"}` or `{"decision": "deny", "reason": …}`. Which host end
serves that address is not settled: a loopback listener per session with its own credential, or a host route on the
bridge credential (#382). The session core's seam has no inbound path for it yet (#1654, gap 3), so the adapter keeps
it behind a small interface (`GateInbound`) either can fill, and the script does not change between them.

The hook is two files: `agy-gate.mjs`, the command, runs unconditionally under any name and only calls
`gate-answer.mjs`, which holds the logic the tests drive. It uses Node's global `fetch` and touches no file or process
(os-layer.md). It sends again only when the request never left (`ECONNREFUSED`, `ENOTFOUND`: a host swap), so a card is
never raised twice, and a `deny` reason names an error's code only, never its message (which can carry the address). The host side
(`gate.ts`) decides from the preset and the always-allow rules, or raises an `approval_request` card and waits:

| Our decision | Gate answer |
|---|---|
| allow | `allow` |
| always | `allow`, and the rule is ours (`always-allow.ts`); later matching calls are allowed without a card |
| deny | `deny`, reason "The person declined." (the model is told and continues, measured) |
| stop, close, an interrupt | `deny`, reason "The turn was stopped." |

Rules stay in Centralu (#838); nothing is written to the person's `agy` permissions. `ask` and `force_ask` are never
returned: print mode cannot ask (measured).

The card carries the hook's `stepIdx`, which is the stream's `step_index` (measured), so it attaches to the
`tool_call` already drawn; the hook's `toolCall.args` (with `toolSummary`) give the detail.

### 5.2 Presets

| Preset | The gate |
|---|---|
| `auto` | allows everything at once (the hook still runs, so `gatesSteps` holds) |
| `edits` (#1525) | allows reads, and edits inside the session's folder; a card for the rest |
| `normal` | allows reads inside the workspace (agy's own default does the same, per the changelog); a card for edits, commands, URL reads, browser actions and MCP calls to servers other than Centralu's |
| `safe` | a card for everything but reads inside the session's folder |

`tool-kinds.ts` classifies by tool name (`view_file`, `read_file`, `list_dir`, `grep_search`, `find_by_name` read;
`write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` edit; `run_command`,
`send_command_input`, `notebook_execution` execute; `call_mcp_tool` by `ServerName`; `invoke_subagent` and the
messaging tools subagent; `browser_*`, `read_url_content`, `search_web` outside). **An unknown name is a card**, never
an allow: the list in `init.tools` is not complete (measured), and a new tool must not slip through. Calls to
Centralu's own server (`centralu_*` server names) are allowed by the gate; the host's own approvals apply inside the
bridge, as now.

### 5.3 Who else answers

`gatesSteps` is true: every tool step, the sub-agents' included, passes the gate whatever the preset, so an `agy`
session can be the one whose requests go to the orchestrator (#1447).

### 5.4 Failure

The gate fails closed: the host unreachable past a short retry across a swap → `deny` with the reason. The hook entry's
`timeout` must outlast a person's answer (900 s proposed; 90 s measured to wait).

**The gate's end sends its headers at once and then a space every so often until it decides.** Node's `fetch` gives up
on an answer whose headers, or next piece of body, take over 300 s, and a person may take longer over a card; JSON reads
leading spaces as nothing, so the heartbeat does not change the answer. Until that end exists (`feat/agy-gate`), a card
left open past 300 s ends as `deny`.

How `agy` treats a hook that does not answer as asked was measured (§1.2): a timeout, a non-zero exit, output that is
not JSON, `{}` and an unknown decision all keep the tool from running. **Empty output with exit 0 lets it run.** So
`agy-gate.mjs` prints a decision on every path, `deny` unless Centralu clearly said `allow` (no address or credential,
unreachable, a status other than 200, an answer it cannot read, any other decision, an exception), and its test runs
each of those paths. No watchdog is needed.

## 6. Context and compaction

- **Context use:** each `agent_response` `DONE` carries that model call's `input_tokens` and `cache_read_tokens`;
  their sum is the prompt the model just read, which is the conversation's context at that call. That is a per-call
  exact reading (`contextAtRequest` true), like Codex's.
- **Window:** `agy` reports none (no field in the stream, `/context` refused in print mode, `/model` has no size).
  Without a window there is no share to draw, and the rule is not to guess one. Proposed: `contextUsage: 'none'` in P1,
  readings kept for `ModelWindows` should a window source appear (open question 3).
- **Compaction:** `agy` compacts automatically (changelog) and has `/compact` interactively, but print mode has no
  `/compact` (measured: it went to the model as text), no compaction event was seen, and no hook fires on it. So
  `compactCommand` is absent, `compact_self` and break-time compaction are not offered for `agy` sessions, and an
  automatic compaction is not marked. A large drop in the per-call input tokens is **not** taken for a compaction, and
  neither is any message text. If a compaction step type turns up in a recording (the vendor's step protos have one),
  it maps to `compaction` then.

## 7. Centralu's tools

### 7.1 MCP

`mcp_config.json` in the plugin root names the same stdio bridge Codex uses (`orchestrator-bridge.mjs`, run by the
host's node), one entry for Centralu's own tools and one per attached app (`CC_APP_SERVER`). The credential comes from
the environment (§3.2). `bridge-path.ts` moves from `adapters/codex/` to `adapters/` (shared with the ACP work, which
plans the same move). The servers are fixed when the process starts, so an app attached later is
`appAttachment: 'restart'`: the next process start (any input after an interrupt, or a forced restart) picks it up.

Tools are reached through `call_mcp_tool` after the model reads a descriptor file (§1.3), so their definitions are not
in the prompt prefix: `toolDeferral` is true in effect (to confirm against how the host counts the prefix).

### 7.2 Role text

Unlike ACP, `agy` has two measured paths into the model: the `SessionStart` hook's `systemMessage` (persists in the
conversation) and the plugin's `rules/AGENTS.md`. `systemPromptAppend` goes through `SessionStart`; `instructionChannel`
is `server` for the bridge's own MCP instructions. `SessionStart` fires only for a new conversation, so a resumed
session keeps the role text it started with (as stored in its history), and a changed role text needs a new
conversation, as for Claude.

### 7.3 Repository trust

`agy` reads the repository's `.agents/`, `AGENTS.md` and `GEMINI.md` and has no flag to stop it (`noSettingFiles`
cannot hold). Same answer as the ACP design's question 3: offered in an untrusted project only with that said, and never
for a session that must read no setting files. The orchestrator is therefore not an `agy` session even though the role
text has a path (open question 4).

## 8. What is left out

| | Why |
|---|---|
| Import and history (`listExternalSessions`, `readExternalHistory`) | the only sources are `agy`'s own files (`conversation_summaries.db`, `brain/<id>/…/transcript_full.jsonl`); agent-host.md §8.1 rules out parsing a tool's undocumented files. No CLI command lists or reads conversations |
| `deleteExternalConversation` | no CLI command |
| Reasoning text | not streamed; `thinking_tokens` only |
| Sleep (`sleep`) | resume works, but whether a resumed process reads the prompt cache was not measured (a resumed turn showed `cache_read_tokens: 0`); false until measured |
| Images | stream input accepts only `text` blocks |

## 9. Capabilities

| Capability | Value | From |
|---|---|---|
| `approvals` | true | the gate (§5) |
| `gatesSteps` | true | the hook sees every tool step, sub-agents' too |
| `contextUsage` | `none` | no window (§6) |
| `resume` | true | `--conversation`, survives SIGKILL |
| `exclusiveWriter` | false | two processes wrote one conversation |
| `autoTitle` | false | print mode skips titles (changelog) |
| `attachments` | `[]` | text blocks only |
| `verbosities` | `[]` | |
| `midTurnInput` | false | host-side queue (§4.2) |
| `backgroundTasks`, `builtInSubagents` | false | not visible in the stream |
| `processModel` | `per-session` | §3.1 |
| `instructionChannel` | `server` | §7.2 |
| `toolDeferral` | true | descriptor files (§7.1), to confirm |
| `sleep` | false | §8 |
| `compactCommand`, import methods | absent | §6, §8 |
| `listModels` | `agy models` | ids carry the effort for Gemini |
| `listUsage` | `-p /usage --output-format json` | weekly buckets per model group, no turn |

## 10. Tests (#1498 from the start)

### 10.1 The recorder

`scripts/agy-record.mts` runs each scenario against the installed `agy` in temporary folders, with the real gate hook
answered by a small listener standing in for the host, and writes a raw file outside the repository.
`scripts/agy-scrub.mts` turns it into a fixture: a header line (tool `agy`, CLI version, OS, date, scenario, what it
does, model), then every line with its time and direction in the repository's terms (`adapters/frames/recorder.ts`):
`out` (written to `agy`'s stdin), `in` (printed on its stdout), `err` (stderr), `gate` (each hook request and the
decision given), `spawn` (a process started, with its arguments), `exit` (code and signal) and `note` (what the recorder
checked itself, such as whether a command ran). `agy` has no JSON-RPC, so the tap sits on the process's three pipes and
on the gate's handler instead of on a connection.

The ACP scrubber's rules, plus: conversation ids and sub-agent ids → `conv-1`…; `~/.gemini/antigravity-cli/…` →
`<agy-home>/…`; the plugin root → `<plugin-root>`; the working folder → `<cwd>`; other ids → `id-1`…; the account's
quota in `/usage` → a fixed reading (half left, a fixed reset time); the tool list in `init` kept (it is the drift
baseline); stderr lines kept verbatim except paths. The streamed answer is scrubbed joined, as the ACP one is. The
shared privacy test (`adapters/frames/recordings-private.test.ts`) reads these recordings too.

### 10.2 The replayer

A fake `AgentProcess` driven by a recording: it matches each line the adapter writes to stdin against the next `in`,
then emits the `out` and `err` lines up to the next `in`, and plays each `gate` entry by calling the adapter's gate
handler with the recorded hook input and checking the decision the adapter returns against the recorded one (or against
the test's own answer to the card). Process exit is part of the recording (code and signal). Times keep the order and are
not slept.

### 10.3 The fake peer

A scriptable fake `agy` (stream-json in, stream-json out, a configurable exit), for what the real one cannot be made to
do on demand: dying mid-turn, a malformed line, an unknown step type, the unknown-id warning, `AGY_ERROR`, a hook that
times out, a quota-reached error, a slow SIGINT past the stop bound, and adoption after a host swap with a gate request
open. Hand-written frames stay here and say so.

### 10.4 Scenarios

| Scenario | How |
|---|---|
| a plain turn; a tool call; a file edit | recorded |
| gate: allow, deny, always (second call without a card), a sub-agent's tool call | recorded |
| input during a turn (queued by us) | recorded |
| interrupt (SIGINT) mid-text; with a gate request open, answered `deny` first (1.4.8) and left open (1.4.7) | recorded |
| SIGKILL mid-turn, then `--conversation` in a new process | recorded |
| unknown `--conversation` id | recorded |
| not logged in (temporary `HOME`) | recorded, no turn |
| `/usage`, `/model`, `/effort`, `agy models` | recorded, no turn |
| sub-agent start and report | recorded |
| hook timeout, non-zero exit (alone and after `allow`), not JSON, `{}`, an unknown decision, empty output | recorded, with a fake hook command and a marker file showing whether the command ran |
| adoption, quota reached, a malformed line | fake peer |

### 10.5 Refreshing and drift

`scripts/agy-record.mts` reruns the scenarios against the installed `agy` in temporary folders (no host runs),
on the cheapest model, and `scripts/agy-scrub.mts` writes `recordings/agy-<version>/`. It spends the person's weekly quota (~25 short turns),
so it is run by hand before an `agy` bump, not on a schedule. The weekly surface drift run (#270) reads, with no turn:
`agy --version`, `agy --help` (flags), `-p /help`, the `init` tool list (one stream-json process given a refused
`control_response`, which ends it before any turn but leaves an empty conversation behind), and whether
`control_request` is still refused; a change in any of them is a diff to review.

## 11. What is taken from the ACP work

| Taken as is | Changed for `agy` | Not used |
|---|---|---|
| process start and teardown (`LocalAgentProcess`, `ProcessSource`, `spawnGrouped`, `killHandle`, the stop bound) | the recorder's tap: three pipes and the gate instead of a JSON-RPC connection | the JSON-RPC connection and its id prefix after a swap |
| the recording file format, header and scrubber rules | the replayer's matching: lines, not requests | `session/load` replay filtering |
| the fake-peer approach and its "hand-written" marking | | `authenticate` handling (agy never prompts without a terminal) |
| the host-side input queue and `turnInputs()` | | per-session `mcpServers` (agy takes them from the plugin root) |
| approvals answered once with the rule kept in Centralu (`always-allow.ts`), the card builder, `PendingCards` | the answer goes to a hook, not a permission request | |
| the capability list and its presence-means-supported rule; `known-*.ts` + `unmapped.ts` | | |
| moving `bridge-path.ts` to `adapters/` | | |

## 12. Compared with Claude Code and Codex

| | Claude | Codex | `agy` |
|---|---|---|---|
| Approvals | in-process callback / hook | server request | a blocking hook, with the CLI's own checks off |
| Interrupt | keeps the process | keeps the process | ends the process; the next input resumes |
| Input during a turn | mid-turn | mid-turn | queued |
| Context share | exact | exact | used tokens only, no window |
| Compaction | marked, on request | marked, on request | neither |
| Reasoning | summaries | summaries | token count only |
| Import | SDK | app-server | none (no official API) |
| Usage and limits | yes | yes | `/usage` weekly buckets |
| Sub-agents | streamed | streamed | start and report only |
| Role text | system prompt | developer instructions | `SessionStart` system message |
| Not reading the repo's settings | yes | yes | no |

## 13. The pull requests

1. **The adapter, as a stack built beside the session core** (#1654), each with a test that fails without it:
   1. `feat/agy-adapter`: this document, the recorder and scrubber, the recordings, and the hook
      (`agy-gate.mjs`, `gate-answer.mjs`) with its test.
   2. `feat/agy-wire`: the stream codec and the table of §4.1, turns and input, sub-agents, resume with the unknown-id
      check, interrupt and capabilities, as a pure wire (lines in, events out) replayed from the recordings; it plugs
      into the session core's `ToolWire` once the core's PRs 1, 3, 5 and 9 land.
   3. `feat/agy-gate`: the gate's decisions and presets, the plugin root, and Stop denying every open request first,
      with each preset proved by a live run; its inbound path waits on the core's PR 3 (#1654, gap 3) and its card on
      PR 5 and 8.

   Then the session wiring, detect and usage, `agy-gate.mjs` in the bundle, and agent-host.md §2–3.
2. **Models and effort, sub-agent progress, nudges** through `PreInvocation`, if measured useful.
3. **Windows**: launch, `cmd /c` hooks, paths in the plugin root; measured on the Windows machine with its own login.
4. **The drift check** in the weekly surface run.

## 14. Open questions

1. **Running with `--dangerously-skip-permissions`.** The gate replaces `agy`'s own checks, so the person's own `agy`
   deny rules in `settings.json` no longer apply to Centralu's `agy` sessions (the flag skips every permission prompt).
   Acceptable with Centralu's presets as the only rules, or should the gate also read and honour the person's `agy`
   deny rules?
2. ~~**Hook failure modes**~~: measured (§1.2, §5.4). Only empty output with exit 0 lets the tool run; the gate script
   always prints a decision, so no watchdog.
3. **No context window.** Show used tokens without a share, or keep `contextUsage: 'none'` until `agy` reports a window?
4. **Repository trust and the orchestrator** (§7.3): same as the ACP design's question 3.
5. **The unknown-id trap** (§4.4): the turn reaches a new conversation before the mismatch is seen. The stderr warning
   comes some 3 s before `init` (measured), and stopping there kept the turn from reaching the model; an empty
   conversation is still left behind. Accept that, or look for a probe that does not run a turn?
6. **Quota**: the account is free with weekly limits. A quota-reached error was not reached, so its shape is unknown;
   should Centralu warn below some remaining fraction from `/usage`?
