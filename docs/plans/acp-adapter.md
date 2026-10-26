# The ACP adapter, and Cursor as its first tool (#59, #1476, #1498)

Proposed and approved 2026-10-26; §0 is what PR 1 settled. A design to agree on before code: what was measured, the shape of a generic Agent Client
Protocol (ACP) client adapter in `packages/agent-host`, how Cursor CLI (`agent acp`) runs through it, how it is
tested from recorded frames (#1498), and how the work is split. OpenCode (`opencode acp`) is the second tool on the
same core; Antigravity (`agy`, stream-json, no ACP) gets its own adapter later and is out of scope here. A record like
the rest of `plans/`, so not mirrored in Korean; [agent-host.md](../agent-host.md) §2–3 gains the lasting parts in
the same pull request as the code.

## 0. What PR 1 settled

Added 2026-10-26, after the design below was approved and PR 1 built. Where this section and a later one disagree,
this one is the newer: the later sections are the design as proposed, kept for its reasoning.

### 0.1 The owner's answers

| Question (§14) | Answer | What PR 1 does |
|---|---|---|
| Role text | Left out | An ACP tool declares `roleText: false`: it cannot be the orchestrator, a coordinator or an app's agent yet. Later: measure whether a leading prompt block marked as Centralu's carries it |
| Untrusted projects | Not offered (fail safe) | `keepsRepoFilesOut: false`: refused in an untrusted project; revisited when what each tool reads is known |
| OpenCode's `/compact` | Accepted for PR 3 only | Not in PR 1: only inside the compact turn Centralu started, ended `end_turn`, next reading smaller; `trigger: manual`, no summary |
| `safe` on Cursor | Not offered | Not mapped to Cursor's `ask` mode, which is a different promise. Since the review of #1562, Normal and Edits are not offered either (§0.6): `presets: ['auto']`, and whether Cursor stays offered under Auto only is the owner's to decide |
| Idle sleep | Measure first | `sleep: false`; memory measured below, decided with the numbers |
| Subscription tools | Like Claude and Codex | The official CLI runs; Centralu never reads or reuses its login (`agent status` is asked, as a terminal would) |

The three limits are new optional capabilities (`AdapterCapabilities.presets`, `keepsRepoFilesOut`, `roleText`;
absent means what Claude and Codex always did) with one rule over them, `launchRefusal` in `@cc/protocol`. **The
host is the gate**: every start and wake passes `startFit` (`sessions/session-start.ts`) and is refused before any
process starts, whatever path asked (a picker, `start_agent`, an app's agent, a fork, a handoff). Every other path that puts a tool
or a preset on a session is held to the same rule, read the one way (`sessionDemands` in `sessions/tool-fit.ts`, through
`ToolRegistry.refusal`) and refused before anything changes: a tool switch (`agents.switchTool`), a preset changed on
a running session (`updateSettings`), and the orchestrator's tool (`orchestrator.configure`, `ORCHESTRATOR_DEMANDS`).
Unchecked, each saved a session its tool cannot run, which refused every send after (review of #1562). The pickers ask the
same rule and grey the tool with the same words: the new-session and new-app dialogs, the orchestrator's cards in the
intro and its picker in Settings, and the preset menu (a preset the tool cannot keep is greyed). The empty session's
tool switch (`SessionStart`) leaves a refused tool out instead, as it leaves out one not installed (owner,
2026-10-18: not shown greyed there), asked with the session's own preset and role.

### 0.2 Cursor, measured logged in (agent 2026.10.22-27dcf5f, Windows 11, model Auto)

Recorded through the adapter itself (`scripts/acp-record.mts`, §10.5) in eight scenarios; they replay in
`adapters/acp/replay.test.ts`. What the bundle reading of §1.1 said, and what the runs showed:

- **No `usage_update`, no compaction updates** in any run. `/compact` is answered with ordinary text and `end_turn`.
  So `contextUsage: 'none'` and no `compactCommand` (§5.5 and §5.6 hold).
- **`session/load` replays** the conversation (user, thought and message chunks) before its answer, as OpenCode's
  does; the replay is dropped from the live stream (§4.3 holds). No `session/resume`.
- **A permission request carries less than the call.** Its `toolCall` has no `rawInput` and a title in backticks, with
  a content line `Not in allowlist: echo`; the command itself came on the `tool_call` frame before it. The card is
  drawn from both (`AcpNormalizer.call`), so it and the "always" rule read `echo probe-1`. Found by the first Cursor
  recording; the replay test that failed on it is "approval: asks with a card the command reads on". Option ids are
  `allow-once`, `allow-always` and `reject-once`, with ACP's kinds.
- **Setting a model persists.** `session/set_config_option {configId: model}` writes the choice to
  `~/.cursor/acp-config.json` (`selectedModelVariantId`), the default of every Cursor session the person runs. A probe
  did it once (and it was put back to `default[]`); PR 1 never sets a model, and the model menu (PR 2) has to choose a
  model without changing the person's default.
- **It does not end on stdin EOF while a session is open** (still running 60 s after EOF; 1.7 s with no session). The
  adapter's `dispose` kills the tree after its 2 s grace. The MCP servers it started from the person's own
  `~/.cursor/mcp.json` ended by themselves once it was killed. On macOS, with Centralu's bridge attached, it and the
  bridge outlived a SIGKILLed host by 60 s and more (alone it exits 2.5 s after EOF), and a shell it started outlived
  it when it was killed: hence the host watch and the tree notes of §0.6.
- **Shell commands run on Windows** (`echo`), on a machine whose PATH has Git's `cmd` but not its `bin`, and where
  `bash` on PATH is WSL's. Which shell Cursor used is not reported. Git Bash is needed by `agent worker start`, not by
  `agent acp`.
- **Sessions are named by the tool** (`session_info_update`), and it answered in the person's language from their own
  rules.
- **Memory.** Windows (working set of the agent's own Node): 153 MB after `initialize`, 145 MB idle with a session,
  149 MB after a turn. macOS (RSS, no MCP servers of the person's; the review of #1562): 232 MB after `initialize`,
  262 MB idle with a session, 264 MB after a turn, 202 MB 30 s later; Centralu's bridge adds about 49 MB. A session
  also starts the person's own MCP servers (here one `npx` server, +~170 MB, which a terminal session of Cursor starts
  too).
- **It writes without asking** (Windows; macOS in the review of #1562). Asked to create a file in the folder, write one
  outside it, change one and delete one, it sent no `session/request_permission` for any write, inside or outside the
  folder, also with the client advertising `fs.readTextFile` and `fs.writeTextFile` (it then called no `fs/*` method
  either). It asked only for the delete, as `kind: edit` while its `tool_call` said `delete`. So a preset that asks
  before a change cannot be kept: Cursor runs under Auto only (§0.6).
- **Results.** A command's output comes in `rawOutput {exitCode, stdout, stderr}` with no `content`; a refused call
  ends `completed` with nothing else; an MCP call's ends `rawOutput {success}`. A call to Centralu's bridge is asked
  about as `<server>-<tool>: <tool>` (`centralu-recall: recall`, kind `other`); its `tool_call` says `MCP: tool`.
- **macOS layout** (the review of #1562): `~/.local/bin/{agent,cursor-agent}` link to
  `versions/<version>/cursor-agent`, a script that runs the bundled Node; `findCursor` resolves it, also from a bare
  PATH once the host's PATH is filled in.
- An account without access to a model answers a prompt with the text "Upgrade your plan to continue" and `end_turn`,
  no error. It reads as an ordinary reply, and is shown as one.

### 0.3 What changed against the design

- **Layout.** Cursor's profile and adapter are `adapters/cursor-agent/` (as `claude/` and `codex/`), and the registry's
  tool name is `cursor-agent`, Cursor's own binary name: the adapter-identity lint bans a registered tool's name as any
  literal or object key outside the adapters, and `cursor` is a CSS property and an MCP pagination key.
- **No take-over after a swap yet** (§4.4 is PR 2). A process the previous host left is closed with its tree (and waited
  for), the tool calls it left open are closed as failed, and the conversation is opened again with `session/load`
  (`closeAdopted`). The turn it was running is over, and is said so: the handle reports `takesOverTurn: false`, and the
  manager ends that turn as one a quit cut (`turnLostInSwap`: idle, the quit mark and its line, the owed report to the
  caller or the person), not `working` with nothing behind it. Under the keeper the process is the keeper's child, which it sweeps if the host dies; without the
  keeper, Windows ends the host's children with it, and on macOS and Linux a Cursor with a session open would outlive
  a crashed host (the EOF finding above), which is why the keeper's spawn is used whenever the host has one.
- **No apps** are attached to an ACP agent in PR 1 (`appAttachment` answers `failed`): an app's tool calls would reach
  the agent's own approval, which is not Centralu's per-app policy (#382). Centralu's own tools are attached (§6).
- **No model list, modes or effort** (PR 2): Cursor runs its default model.
- **Mid-turn cancel.** A cancel that reaches the agent before its turn has begun is lost (ACP's cancel is a
  notification, answered only by the turn's end); the turn going on after it gets the cancel once more. Measured on
  OpenCode: the updates after a cancel are the call it aborted, flushed, so the second cancel is harmless there.

### 0.4 The lessons PR 1 is held to

1. **A turn's end says whether the session is still usable.** A clean end is `turn_complete`, or `state_change
   waiting_input` with `interrupted` (our Stop) or `interrupted_by_tool` (the agent's own `cancelled`). A failed prompt
   (a JSON-RPC error) is an `error` that leaves the session usable. A process that ended in a turn is `error
   adapter_crashed`, on which the manager drops the handle and the next message opens the conversation again; one that
   ended while idle is `session_live` with `asleep`. A refusal is a non-retryable `error`.
2. **The answer to a cancel is not the end of the turn.** Only the prompt's own answer ends it, and a Stop belongs to
   the turn it was pressed in (`Turn.stopAsked`), so a late `cancelled` or a late `end_turn` can never end the next one.
   A Stop the agent does not confirm within 10 s is said as a notice (`stopNotConfirmed`), not an error.
3. **Orphans after a restart are closed,** not left spinning: the adopted process with its tree, and its open calls as
   failed results (the cards stop). Sub-agents are not reported in PR 1 (`builtInSubagents: false`), so none can be
   left behind.
4. **Tests wait for events, never for time.** The replayer writes a frame when the adapter has sent what precedes it;
   the scenario driver resolves on the event; `adapters/frames/no-sleeps.test.ts` fails a test in `acp/`, `frames/` or
   `cursor-agent/` that calls `setTimeout`, `sleep` or a fake clock.
5. **Windows.** Nothing starts through a shell: Cursor's newest version folder is found as its own launcher finds it
   and its `node.exe index.js acp` started directly; OpenCode's npm shim is read by `launchFor`. Tools are found with
   `whichTool`, which reads the login shell's PATH in the packaged app, and Cursor's default install folder
   (`%LOCALAPPDATA%\cursor-agent`) is looked in too.

### 0.5 What other adapters take from this

The parts that know no protocol live outside `adapters/acp/`, for OpenCode (PR 3, on the ACP core) and for the
Antigravity adapter (`agy`, stream-json, not ACP), which is designed in parallel:

| Part | Where | Antigravity can take it |
|---|---|---|
| Process start and tree teardown | `adapters/local-process.ts`, the keeper's `ProcessSource` (shared already) | as is |
| The frame recorder | `adapters/frames/recorder.ts` (`CC_RECORD_FRAMES=<folder>`, one file per process, lines both ways and the exit) | as is: it records lines of any protocol |
| The scrubber | `scripts/frames-scrub.mts` | as is; its id keys (`sessionId`, `toolCallId`, `messageId`) may need the tool's own |
| The replayer | `adapters/frames/replay.test-helpers.ts`, with a `FrameCodec` | with `jsonLinesCodec` (lines matched by `type`) instead of `jsonRpcCodec` |
| The scenarios and their driver | `adapters/frames/scenarios.test-helpers.ts`, at `SessionHandle` level | as is, with a record script of its own |
| The no-sleeps guard | `adapters/frames/no-sleeps.test.ts` | add its folder to the list |
| The capability limits and `launchRefusal` | `@cc/protocol` | declare what it cannot keep; the host and the pickers follow |
| The fake peer | `adapters/acp/fake-peer.test-helpers.ts` | no: it speaks JSON-RPC |
| Ending with the host, and what it started | `adapters/local-process.ts` (`endsWithHost`, `noteTree`) | yes: start with `endsWithHost`, note the tree while a command runs |
| The recordings scan | `adapters/frames/recordings-private.test.ts` | add its recordings folder to `ROOTS` |

### 0.6 The deep review of #1562 (macOS, real Cursor) and what it changed

| Found | Now |
|---|---|
| Edits and Normal held no folder boundary: Cursor writes without asking, and a delete it asks about as `kind: edit` was granted under Edits | Cursor runs under Auto only (`presets: ['auto']`; the refusal says which presets remain). A request's kind never overrides the call's own (`AcpNormalizer.call(…, asked)`); tested on a real recording (`files`) |
| A tool switch and `orchestrator.configure` skipped the gate; the empty session's switch asked with Normal | One reading and one rule on every path (§0.1) |
| `ToolStatus` in `acp/wire.ts` shadowed a protocol name; the bundle was over its ceiling | `CallStatus`; the growth measured (+2,299 B) and declared (`tooling/bundle-growth/feat-acp-cursor.json`) |
| Every result read "(no output)"; a refused command read ok | `rawOutput`'s `stdout` and `stderr` are read; a refused call, a non-zero exit and `success: false` end not ok |
| Cursor and the bridge outlived a SIGKILLed host on macOS | A process the adapter starts runs behind a host watch (`HOST_WATCH` in `local-process.ts`): a pipe only the host holds the other end of, whose close kills the group, whatever happens to stdin |
| A restart mid-call left its card spinning; a swap left the session `working` with no turn | `dispose` closes the open calls; a swap ends the turn as a quit does (§0.3) |
| The scrubber missed a path split across chunks, macOS temp folders, the person's skill names and the bridge token | Chunks are scrubbed joined; every system's home and temp folders, the user name, secret-named environment values and the command list are scrubbed; every recording was scrubbed again, and `frames/recordings-private.test.ts` reads them all |
| Each call to Centralu's own tools was a raw-JSON card | `AcpProfile.centraluToolOf`: answered without a card, as Claude and Codex take the bridge |
| A shell outlived a killed Cursor; the recorder appended a second host to the first one's file; a reordered recording still replayed | The tree is noted while a command runs and its groups swept after; the next free file number; every call must end once, after it |

A second-model review of these fixes found more, also fixed: a noted helper group was kept until the CLI exited and
could by then be someone else's number (it is now dropped once empty, `notedGroups` in `kill-tree.ts`); `ps` ran
synchronously every 2 s while a command ran (now asynchronous); a result's ok read only the last update; a call of
another kind titled as the bridge's would pass as Centralu's own (only kind `other` does now).

A re-check on macOS with real Cursor, at those fixes, found four more, also fixed: a command Cursor ran (`zsh -c`, a
`sleep 300`) sat in a group of its own and outlived a SIGKILLed host, since only the host knew its group (the host now
tells the host watch each helper group as it notes and drops it, and the watch ends them first; a second re-check found a host killed within 2 s of a command's start, before the
host's note, still left it, so the watch also reads the CLI's descendants by parent links when its pipe closes); 60 KB of a command's
output arrived as `stdout: ""` and read "(no output)" (an empty result now says the tool did not return the output, as it
cannot be told from a command that printed none; recording `big-output`); `smoke:cursor` counted the watch's subshell as
a second agent (counted by parent now); and removing `endsWithHost` or Cursor's `presets` failed no unit test (now each
does, `acp/adapter.test.ts`).

A live Normal to Auto change restarted the process (about 10 s): with Cursor under Auto only, it has no other preset to
change to.

### 0.7 OpenCode (PR 3), on the core as reviewed

`adapters/opencode/` is a profile and nothing else; the core is PR 1's as fixed after its review.

| Part | OpenCode 1.19.4, measured |
|---|---|
| Presets | All four, the same promise as for Claude and Codex, through an inline `OPENCODE_CONFIG_CONTENT` that OpenCode merges after the person's global and project files (`config.ts`). It is built from what the person's OpenCode would read (`config-files.ts`: the global files, `OPENCODE_CONFIG`, the project's `opencode.json(c)` up to its repository's root, the `.opencode` folders, `OPENCODE_CONFIG_DIR`, the managed folder, and the agents their markdown files define), with the person's own inline value kept under it. The asks below are made under the agent Centralu runs (`build` under Safe, the person's `default_agent` or `build` otherwise); under every other agent, which only runs as a subagent, each of them is a deny (Subagents, below). **Safe** asks before every edit (`edit` covers `write` and `patch`), command (`bash`), and web fetch or search (`webfetch`, `websearch`, as Claude's default asks), whatever the rules of any agent say: OpenCode's own, each the person names in a config file or `mode`, and each their markdown files define; handing work (`task`) to an agent it cannot see (one a plugin adds) asks too. A deny of the person's stays a deny (in `permission` or legacy `tools`), a deny of every `task` included. **Normal** asks before edits and commands where the person's rules say nothing about them; each rule of theirs wins over that base for the calls it names: one for every call of the tool (`bash: allow`, `*`, a one-word `permission`, legacy `tools`) leaves no base, one for some (`bash: {"git *": "allow"}`) decides those and the rest ask; the rules of an agent defined in a markdown file come after the base anyway, unless it is the person's `default_agent`, whose asks Centralu sets under its own name and so after its markdown rules. **Edits** starts as Normal and the adapter allows the edits inside the folder itself, so commands ask. **Auto** adds nothing; the adapter answers whatever is asked. Not held under any preset: MCP tools (the person's servers' and Centralu's own), `todowrite`, `skill`, reads. What can still loosen Safe: a managed config (`%ProgramData%\opencode`, `/Library/Application Support/opencode`, `/etc/opencode`) or an OpenCode account organisation's config, both merged after Centralu's; an agent a plugin adds runs its own rules once its `task` card is allowed. OpenCode's `plan` and `explore` agents, which deny edits by themselves, ask instead under Normal when Centralu runs them (Centralu's rule comes after theirs) |
| Subagents | OpenCode drops an ask made in a subagent's session (one `task` started): its ACP side answers only for the session it opened (`session.tryGet` finds no other), so no `session/request_permission` is sent, nothing answers, and the turn waits until it is stopped (#1565 Mac re-check, case E). So under Safe and Normal (and Edits), under every agent but the one Centralu runs, whatever would ask is denied: the preset's tools, OpenCode's own asks (a `.env` read, a loop) and each tool the person's rules for that agent ask before (`task` and `OPENCODE_PERMISSION` included); their allows and denies stay. The subagent is told and its run ends; `task` hands its last text back to the agent Centralu runs, which can ask, and work is never handed to that agent as a subagent. Still waiting under every preset: an ask for a folder outside the project from inside a subagent (OpenCode's own `external_directory` rule, whose allowed folders are its own), an ask written for every tool at once (`"*": "ask"`) or in a markdown agent's frontmatter, and, under Auto, any subagent's ask |
| A deny | A call denied by a rule ends the turn (OpenCode stops its loop on a deny unless `experimental.continue_loop_on_deny`), so a call later in the same turn, a write after a denied command, is never tried |
| Trust and role | Trusted projects only (it reads `AGENTS.md` and the project's `opencode.json`, which can add plugins and servers); a project's plugin (`.opencode/plugin/*.js`) runs its code when the session starts, under every preset, Safe included. No role text, so not the orchestrator, a coordinator or an app's agent |
| Centralu's own tools | Not asked about under any preset (only `edit` and `bash` ask, measured in the `basic` and `approval` recordings), so no `centraluToolOf` is needed |
| Compaction | Its `/compact` sends no protocol frame. Marked only at the end of the compact turn Centralu itself started (`SessionEvents.sendCompact`, `compact: true`), ended `end_turn` with a context reading smaller than the one before it: `trigger: manual`, no summary. A `/compact` the person types is never taken for one (`AcpSessionDeps.infersCompaction`) |
| Input during a turn | Folded into the running turn by OpenCode; Centralu queues it for the turn's end instead (`midTurnInput: false`), the fold off |
| Cost | `usage_update.cost` is the conversation's running total (read in its binary); a turn's cost is what it added. A new conversation starts from 0; the last total is kept beside the session (`app_settings` `running_cost:<id>`, `CreateSessionOpts.runningCost`), so the first turn after a restart, a wake or a host swap has its cost too |
| Reply text | Its free model sometimes puts its reasoning in the reply and closes it with `</think>`, with no `<think>` (seen in most runs on 2026-10-25, in OpenCode's own store; its provider passes the text through). The core drops the first such tag of a message (`AcpNormalizer`); the reasoning before it stays reply text |
| A refused model | When its model's provider refuses a turn (the free models' usage limit), OpenCode retries inside and sends no ACP frame: the turn shows nothing until it ends. `smoke:opencode` reports OpenCode's logged error when no event comes; Centralu itself shows the person nothing yet (#1569) |
| Writes | After an asked edit it calls `fs/write_text_file` even with `fs` not advertised; the method-not-found answer is harmless (it writes itself) |
| Ending | Started behind the host watch like every ACP CLI (§0.6) |

`smoke:opencode` (`packages/agent-host/scripts/smoke-opencode.mjs`) runs it on a temporary host, with OpenCode in
temporary XDG folders; it counts and stops only the `opencode acp` processes its own hosts started. The reason it
gives for a silent turn (`openCodeError()`, OpenCode's last logged error) is the smoke's only, not the adapter's.

`smoke:opencode:scripted` (`packages/agent-host/scripts/smoke-opencode-scripted.mjs`) checks the presets with no
account and no quota: each case runs a temporary host and OpenCode (temporary data folder, XDG folders and HOME) whose
model is a local OpenAI-compatible stand-in answering with scripted tool calls, so what is asked, denied or allowed is
OpenCode's own evaluation on the platform it runs on. It denies every card and checks the cards, the turn's end and the
files written for Safe, Normal and Edits, cases C, D, G and J, the person's `bash: deny` and `bash: allow`, and the
three subagent cases (§0.8). It stops only the hosts it started and their `opencode acp`.

### 0.8 The review of PR 3 (Windows, real OpenCode 1.19.4) and what it changed

| Found | Now |
|---|---|
| A `mode.<name>` entry in the project's or the global `opencode.json` beat Safe: OpenCode copies `mode` over `agent` after the inline config; a command ran and a file was written with no card | Safe is put under `mode` for each name the person lists there (no other name, since one listed there becomes primary). The test's model of OpenCode's precedence now has `mode`, the merge's key order and the file layers |
| A project subagent (`.opencode/agent/helper.md`, `bash`/`edit` allowed) reached through `task` ran unasked | Every agent the markdown files define is held; `task` to an agent it cannot see asks |
| Within one object a key keeps its first place, and the last matching rule decides, so `{bash: allow, "*": allow}` under an agent beat Safe's `bash` (found while fixing the above) | Safe's rules sit under keys of their own (`bash*`), read after the person's, then the person's denies. Such a key also matches a tool whose name starts the same (an MCP tool `read_notes`), so it starts at its tool's first ask and holds that tool at most more strictly |
| `webfetch` ran unasked under Safe | Safe asks before `webfetch` and `websearch` |
| Normal and Edits asked nothing (OpenCode's default allows everything) | Normal asks before edits and commands under the person's own rules; Edits as Normal with the folder's edits allowed |
| A project plugin runs code at the session's start | Inherent to trusted projects only; said above |
| The first turn after a restart reported no cost | The last total is kept beside the session |
| `smoke:opencode` stopped every new `opencode acp`, and failed once with no card in 240 s | It stops only its hosts' descendants; the miss was the free models' usage limit (OpenCode logged `Free usage limit reached` and retried silently), so the smoke now names OpenCode's logged error |
| A stray `</think>` on a new session's first turn | Dropped by the core, as above (open question 3) |

A second-model review of these fixes found more, also fixed and measured the same way: Safe read a legacy `tools: {bash: false}` as ask, and let the held agents run where the person denied every `task`; Normal's base was dropped for a tool the person had only partial rules for (`git *`), so every other command ran unasked; a held tag split over two messages lost its text.

The owner's re-check on macOS (OpenCode 1.19.4, its free model) held every case but one: under Safe, case E's subagent
asked, OpenCode logged the ask, and no card came, so the turn waited until its bound (three runs of three). The ask is
dropped by OpenCode itself (Subagents, above), so a subagent's asks are now denies; checked by runs (below), and against the log's own
calls in `config.test.ts`. The same re-check found `smoke:opencode`
counting the host watch's subshell as a second agent process on macOS, as `smoke:cursor` once did; both smokes now
count through one helper (`scripts/smoke-processes.mjs`). A second-model review of that fix found three more ways a
subagent could still ask (`task` to an agent Centralu cannot see, the person's own `task` asks, and Normal's
`OPENCODE_PERMISSION` asks under OpenCode's own subagents) and a key that also matched other tools (`read*` for an MCP
tool `read_…`); each fixed with a test that fails without it.

That key fix broke Safe on macOS (the owner's next re-check: no card in any case, the files written): it named each
tool in capitals (`BASH`), taking OpenCode's match to ignore case. It does on Windows only: its `Wildcard.match` has
the flags `si` in the Windows build and `s` in the macOS and Linux builds of 1.19.4 (read in all three). The keys are
`bash*` again, each starting at its tool's first ask (so `read*` never carries an allow to `read_notes`), and the test's
model of OpenCode decides every case on each platform's match and fails where they differ.

How a claim here is checked: `opencode debug agent <name>` only lists an agent's rules; the order it prints says
nothing about how they match on the platform at hand, and an evaluation by hand on that listing used Windows' match.
A claim about what OpenCode allows or asks is checked by a run: `opencode acp` itself, with a local stand-in model (an
OpenAI-compatible server that answers with scripted tool calls, so no quota), counting the cards and the files written,
on the Windows build and the Linux build (under WSL, whose match is macOS's). Measured so for 9c37862df, 4ca7a9fda and
the fix, cases baseline Safe, C, D, G, J, a deny, E (a markdown subagent), E through OpenCode's `general`, Normal, and
Normal with the person's `bash: allow`: 4ca7a9fda asked nothing on Linux and wrote both files; 9c37862df held all but
E, which waited with OpenCode's log saying `bash*` asked in the subagent; the fix holds every case on both builds and
E ends with nothing written. The runs are kept as `smoke:opencode:scripted` (§0.7), through a real host, which also
covers Edits; on 9c37862df its subagent cases fail as the turn never ends.

## 1. What was measured

Everything below rests on frames captured from the real tools on Windows 11 (2026-10-26), with a scratch
recorder that spawns the agent, drives a scripted sequence and writes every line both ways with its time. Where a
fact comes from reading the installed bundle instead of a run, it says so.

| Tool | Version | What ran |
|---|---|---|
| Cursor CLI | `agent` 2026.10.22-27dcf5f, `agentInfo` not sent | `initialize`, `session/new`, `authenticate`, **not logged in** (`agent status`: "Not logged in"). No turn yet; the rest read from the bundle (`versions/<v>/3635.index.js`, the CLI's own ACP server) |
| OpenCode | 1.19.4 (`agentInfo.version`) | Real turns on the free `opencode/big-pickle` model, no credentials: text, a file write, a shell command with allow once / reject / always, cancel mid-turn, cancel with a permission pending, a second prompt during a turn, `/compact`, SIGKILL mid-turn then `session/load` in a new process, `session/resume` in another. Probe sessions deleted afterwards (`opencode session delete`) |

### 1.1 What the frames say

**Handshake.**

```
→ initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false},
              terminal: false, session: {compaction: {}}}, clientInfo}
← Cursor:   {protocolVersion: 1, agentCapabilities: {loadSession: true, mcpCapabilities: {http, sse},
             promptCapabilities: {image: true, audio: false, embeddedContext: false}, sessionCapabilities: {list: {}}},
             authMethods: [{id: "cursor_login", name: "Cursor Login", description: "…Run 'agent login' first…"}]}
← OpenCode: {protocolVersion: 1, agentCapabilities: {loadSession: true, mcpCapabilities: {http, sse},
             promptCapabilities: {embeddedContext, image}, sessionCapabilities: {close, fork, list, resume}},
             authMethods: [{id: "opencode-login", …}], agentInfo: {name: "OpenCode", version: "1.19.4"}}
```

Cursor answered in 2.2 s, OpenCode in 2.1 s (cold start, both). Neither advertises compaction of its own; the client
capability is what ACP asks for ([§5.6](#56-compaction)).

**Authentication.** Cursor not logged in answers `session/new` with
`{code: -32000, message: "Authentication required", data: {message: "…run 'agent login' first, then call authenticate() with methodId 'cursor_login'."}}`.
Calling `authenticate {methodId: "cursor_login"}` then **does not fail: it starts the browser login flow and waits**
(no answer in 8 s; the bundle: "Starting browser login flow", `open(loginUrl)`, `waitForResult`). With stored
credentials the server starts authenticated (`isAuthenticated` is read from the credential store at start) and
`session/new` works without `authenticate`. OpenCode advertises a method but `session/new` worked with zero
credentials (its free models). So: **the adapter never calls `authenticate`** ([§4.2](#42-authentication)).

**A turn (OpenCode).** `session/prompt` → `available_commands_update` (first prompt of a process) → chunks →
`usage_update {used, size, cost: {amount, currency}}` → the prompt's answer
`{stopReason: "end_turn", usage: {inputTokens, outputTokens, totalTokens, thoughtTokens?, cachedReadTokens}}`.
`usage_update` came once per turn, just before the answer, not per model request.

**Tool calls (OpenCode).** `tool_call {status: pending, title: "bash", kind: "execute", rawInput: {cwd}}` arrives
with the input still empty; the next `tool_call_update {status: in_progress, title: <the command>, rawInput: {command, cwd}}`
carries it, then `in_progress` updates whose `content` holds the **whole output so far** (not a delta), then
`completed` with `content` and `rawOutput {output, metadata: {exit, truncated}}`. A file write: `kind: "edit"`,
`locations: [{path}]` and `rawInput {filePath, content}` on the `in_progress` update.

**Permissions (OpenCode, with `edit` and `bash` set to `ask` through `OPENCODE_CONFIG_CONTENT`).**

```
← {id: 0, method: "session/request_permission", params: {sessionId, toolCall: {toolCallId, title, kind, status: "pending",
     rawInput: {command}}, options: [{optionId: "once", kind: "allow_once", name: "Allow once"},
     {optionId: "always", kind: "allow_always", …}, {optionId: "reject", kind: "reject_once", …}]}}
→ {id: 0, result: {outcome: {outcome: "selected", optionId: "once"}}}
```

The request comes after the `tool_call_update` that names the command, with the same `toolCallId`. A reject ends the
call as `failed`, content "The user rejected permission to use this specific tool call.", and the turn goes on.
Cursor's options (bundle) are `allow-once` / `allow-always` / `reject-once` with the same kinds: **option ids differ
per tool, kinds do not**. Cursor writes an `allow-always` answer into its own persistent allowlist
(`persistAllowlistEntry`, the person's Cursor settings).

**Cancel.** `session/cancel` (a notification) mid-turn: the prompt answered `stopReason: "cancelled"` 190 ms later,
preceded by `usage_update {used: 0, size: 200000}` (**a false zero**: the next turn read 11,176). With a permission
pending, the agent sent no withdrawal: the tool call went `failed` ("Tool execution aborted", `metadata.interrupted`)
and the prompt answered `cancelled`, while the request stayed open on our side. ACP says the client must then answer
it `cancelled`.

**Input during a turn (OpenCode).** A second `session/prompt` sent 4 s into a running one was folded into the same run:
the answer to it came after the story, and **both prompt requests were answered at the same millisecond with the same
result**. The first prompt's answer therefore does not mark the end of the first input's turn. ACP does not define this.

**Compaction (OpenCode).** `/compact` as a prompt (not in `available_commands_update`, but it runs): the summary
streamed as ordinary `agent_message_chunk`s ("## Objective …"), `usage_update.used` went 9,889 → 429, the answer
`end_turn` with no `usage`. **No `compaction_update`, although the client advertised `session.compaction`.** The
context survived (the next turn recalled the first prompt's word). Cursor's bundle has no compaction updates and no
`/compact` handling found.

**Resume.** SIGKILL during a turn, then a new process: `session/list {cwd}` listed the session with a generated title
and `updatedAt`; `session/load` **replayed the conversation as `user_message_chunk` / `agent_message_chunk`
notifications before its answer** (~1 s), then a prompt recalled the code word. No lock, no error. `session/resume`
(no replay) on the same session took **45 s** to answer. Both answers carry `configOptions` (the model select, its
current value and the provider's whole list). The turn killed mid-way left nothing in the replay.

**What Cursor sends (bundle, not run).** Standard updates: message, thought and user chunks, `tool_call(_update)`,
`plan`, `available_commands_update`, `current_mode_update`, `session_info_update` (it names sessions itself). Its own
updates: `subagent_spawned {subagentSessionId, name, task, _meta.cursor.toolCallId}` and `subagent_state_update`,
sent only when the client advertises sub-agent support. Its own requests to the client: `cursor/ask_question`,
`cursor/create_plan`, `cursor/update_todos`, `cursor/task`, `cursor/generate_image`; a client that answers
`cursor/ask_question` with method-not-found gets each question as a `session/request_permission` whose options are
the answers plus a "Skip" (`reject_once`). Its own method from the client: `cursor/list_available_models`. Modes
(`agent`, `plan`, `ask`) through `session/set_mode` and a `mode` config option; the model through the `model` config
option (or the unstable `session/set_model`). **No `usage_update`, no compaction updates, no `session/resume`.**
`session/cancel` cancels the running prompt.

**Windows launch.** `%LOCALAPPDATA%\cursor-agent\agent.cmd` runs `versions\promote-staged.cmd` (moves a staged update
into place), then PowerShell (`cursor-agent.ps1`), which picks the newest `versions\<YYYY.MM.DD-…-hash>\` and runs its
own `node.exe index.js`. The install is 256 MB per version, with its own Node. `tool-launch.ts`'s shim reader would
take the first quoted `%~dp0…` path as the target, which here is `promote-staged.cmd`: the generic resolution does
not fit this launcher ([§3.2](#32-finding-and-starting-the-agent)). OpenCode's npm shim is an ordinary cmd-shim around
`opencode.exe`, which `launchFor` already resolves.

**Git Bash.** The installer's "Git for Windows (with Git Bash) is required to run a private worker" is about
`agent worker start` (the bundle: "worker start exits with that requirement when Git Bash is not installed"), not
about `agent acp`. On this machine `bash` on PATH is `C:\WINDOWS\system32\bash.exe` (WSL), and Git's `bin` is not on
PATH, which is likely why it warned. Whether Cursor's own shell tool needs Git Bash under ACP is measured with the
first logged-in turn.

### 1.2 Model artefacts seen

The free model leaked `</think>` and `<|func_arg_name|>` tokens into `agent_message_chunk` text. That is the model,
not the protocol; the adapter passes text through as it comes.

## 2. Shape

```
adapters/acp/                    the generic core: no tool name appears here
  connection.ts                  JSON-RPC 2.0 over newline-delimited stdio; ids; requests both ways; the recorder tap
  wire.ts                        our own narrow types for the ACP frames we read (anti-corruption, §2 of agent-host.md)
  adapter.ts                     AcpAdapter implements AgentAdapter, given a profile
  session.ts                     AcpSession implements SessionHandle: open policy, turns, input queue, cancel, teardown
  normalize.ts                   session/update → NormalizedEvent (stateless per frame, a small per-turn context)
  approvals.ts                   session/request_permission ↔ approval cards
  profile.ts                     the AcpProfile type: everything a tool may add or override
  known-updates.ts               the update kinds mapped or left out on purpose (unmapped.ts reads it)
  recordings/<tool>-<version>/   scrubbed recordings (fixture data)
  tools/cursor.ts                Cursor's profile: launch, detect, its extensions
  tools/opencode.ts              (PR 3)
```

`registry.ts` adds `new AcpAdapter(cursorProfile)`: the adapter's `tool` is the profile's name (`cursor`), so a third
and fourth tool are one line each. `ToolName` is already an open string (#74), and the descriptor rides with
`agents.detect`, so protocol, core and UI do not change ([§12](#12-what-the-ui-needs)).

**The profile is the only place a tool is named.** It holds data and small hooks, never a fork of the turn logic:

| Profile part | Cursor | OpenCode (PR 3) |
|---|---|---|
| `descriptor` | `Cursor`, mark, install, `agent login` | `OpenCode`, …, `opencode auth login` |
| `locate()`, `launch()` | §3.2 | `whichTool('opencode')` + `launchFor` |
| `detect()` | `agent status` | `opencode auth list` / the free tier needs none |
| `env(opts)` | none yet | `OPENCODE_CONFIG_CONTENT` for the permission preset (measured: makes `edit`/`bash` ask) |
| `clientMeta` | sub-agent support, when PR 2 maps it | none |
| `extensions` | `cursor/ask_question` → question cards, `subagent_*` updates, `cursor/update_todos` → plan | none |
| `models()` | `cursor/list_available_models` | `opencode models` |
| `compactCommand` | absent until measured | `/compact` (measured) |
| `quirks` | — | folds mid-turn prompts; zero `usage_update` on cancel |

Orchestration code asks the adapter what it supports, never which tool it is ([§7](#7-capabilities)). A test
fails on a tool name inside `adapters/acp/` outside `tools/`.

## 3. Process model

### 3.1 One process per session

One `agent acp` per Centralu session, as Codex runs one app-server per session.

| | One per session (chosen) | One shared per tool |
|---|---|---|
| A crash | ends one session | ends every session of that tool |
| The keeper | holds one process per session already (`ProcessSource`), so a swap adopts each one as today | a new shape: one shared child several sessions name |
| Per-session settings | environment per process: OpenCode's permission preset is process config; Cursor pins team and auth per process | every session the same, or per-session switches ACP does not have |
| Memory | one Node per session (Cursor ships its own `node.exe`); to measure, ~150–250 MB expected | one |
| Sleep (#568) | ending a process puts one session to sleep | needs session/close per session; Cursor does not offer it |

Memory is the cost, and putting idle sessions to sleep is the answer to it, as for Claude. `capabilities.processModel`
is `per-session`. A profile can move to a shared process later without the core changing shape, since ACP sessions
are already addressed by id inside one connection.

### 3.2 Finding and starting the agent

Through the existing path: `whichTool` (the login shell's PATH, which the packaged app does not inherit from a
terminal) and `launchFor`, spawned by `LocalAgentProcess` / the keeper's `ProcessSource.spawn` with `spawnGrouped`.
Never `shell: true`: prompts and JSON go over stdin, but arguments and paths still must not meet cmd.exe.

Cursor's launcher does not fit `launchFor`, so its profile resolves it itself, as its own `agent.ps1` does:

1. Find the install: `agent` / `cursor-agent` on PATH, else `%LOCALAPPDATA%\cursor-agent` (Windows),
   `~/.local/bin/agent` → its target (macOS, Linux; to measure there).
2. Take the newest `versions\<name>` whose name matches the launcher's own pattern, ordered as it orders them.
3. Spawn that folder's `node.exe index.js acp` (Windows) with `CURSOR_INVOKED_AS=agent.cmd`, as the launcher sets it.

It does not run `promote-staged.cmd`. That script renames version folders, and with a session holding one it waits
for it to be free; the person's next `agent` in a terminal promotes as before. `installedVersion()` reports the newest
folder, so a promoted update moves idle sessions to it the usual way (§4.6 of agent-host.md). **Not** `agent` on PATH
by name alone: `agent` is a generic word, and another program of that name on PATH must not be started as Cursor; the
found path must sit in a Cursor install (a `versions` folder with `index.js` beside it).

### 3.3 Teardown

`dispose()`:

1. If a turn runs: `session/cancel`, answer every open permission `cancelled`, wait for the prompt's answer up to
   the existing stop bound (`stopConfirmMs`, 10 s).
2. `session/close` if the agent advertised `sessionCapabilities.close` (OpenCode does; Cursor does not).
3. End stdin, wait a short grace, then stop the **whole process tree** with the existing grouped-child code
   (`killHandle`, the Windows sweep by creation time). MCP servers the agent started (ours and the person's) are in
   that tree.

`detach()` (a host swap) sends nothing at all, as for Codex.

## 4. Starting a session

### 4.1 initialize

```
{protocolVersion: 1,
 clientInfo: {name: "centralu", version},
 clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false,
                      session: {compaction: {}}, _meta: profile.clientMeta}}
```

No `fs` and no `terminal`: the agent then uses its own file and shell tools, and their approvals come through
`session/request_permission`. Offering them would mean reimplementing file IO and terminals in the host, with a second
place where approval is decided. `session.compaction` is advertised as ACP requires for its compaction updates (#59).
`protocolVersion` 1, since both tools answer 1; a v2 draft exists (a different turn end, a different resume) and is a
profile-level switch when a tool needs it.

The answer is kept per process: `loadSession`, `sessionCapabilities.{resume, list, close, fork}`,
`promptCapabilities.image`, `mcpCapabilities`, `agentInfo.version` (the `agent_version` event, else the profile's
`installedVersion`).

### 4.2 Authentication

The adapter never calls `authenticate`. Measured, Cursor's starts a browser login and waits, which would open a
browser on the person's machine from a background session; a session already logged in does not need it.
`detect()` asks the tool (`agent status`), and an `-32000 Authentication required` from `session/new` or
`session/load` becomes an `error` naming the login command from the descriptor ("Cursor is not logged in. Run
`agent login` in a terminal."). Logging in stays the person's, in a terminal, like `codex login`.

### 4.3 session/new, session/load, resume

- **New:** `session/new {cwd, mcpServers}` ([§6](#6-centralus-tools-through-mcpservers)). `externalId` is the
  returned `sessionId`.
- **Reopening a conversation** (`resumeExternalId`: a woken session, a host restart without the keeper, a moved CLI
  version): `session/load {sessionId, cwd, mcpServers}` when `loadSession` is advertised, else `session/resume` when
  that is, else the session cannot be reopened (`capabilities.resume` false for that tool). Load is preferred over
  resume although it replays: measured on OpenCode, load answered in ~1 s and resume in 45 s.
- **The replay is not live.** Every `session/update` for the session between the load request and its answer is the
  replay (measured: all of it came before the answer). It is dropped from the live stream; reading history uses the
  same mechanism ([§8](#8-later-import-and-history)). Updates flagged `_meta.isReplay`, should a tool send them, are
  dropped too.
- **A load that fails** with "not found" is the existing "no record of this conversation" error, not a silent
  `session/new`: the person would lose the conversation without being told. Any other failure is an error with the
  agent's text.
- **Settings on open:** the answer's `configOptions` give the model the conversation runs with; one that differs from
  the session's is taken as `takeOpenedSettings` (#1369), and the session's model is set with
  `session/set_config_option` when the tool offers a `model` option.

### 4.4 A host swap under the keeper

The keeper keeps the process; the ACP connection's state (initialized, session loaded) lives in it. The adopting host
sends neither `initialize` nor `session/load` again. Two things need care:

- **Ids.** The new host's request ids are strings with a per-host prefix, so an answer meant for the previous host's
  request is never taken for one of ours. An answer to a `session/prompt` the previous host sent (unknown id, a
  `stopReason`) ends the adopted turn.
- **A permission the previous host was asking.** The agent does not send it again. The card's `requestId` is the
  JSON-RPC id of the agent's request, and the card stores the offered options (id and kind), so the adopting host can
  answer the card it restores. A request it cannot answer (no stored card) is answered `cancelled`, and the turn goes
  on without it.

## 5. From ACP to our events

### 5.1 The table

| ACP | NormalizedEvent | Notes |
|---|---|---|
| `agent_message_chunk` (text) | `message_delta` | `messageId` from ACP's when sent (OpenCode does), else one per turn segment |
| `agent_message_chunk` (image) | `message_image` | |
| `agent_thought_chunk` | `reasoning_delta` | plain text on both tools |
| `user_message_chunk` | dropped live | an echo of our prompt; only the load replay uses it |
| `tool_call`, `tool_call_update` | `tool_call` once, `tool_output_delta`, `tool_result` | below |
| `session/request_permission` | `approval_request` / `approval_resolved` | §5.3 |
| `plan` | `plan_update` | entries `{content, priority, status}`, replacing the last; `adapters/plan.ts` |
| `available_commands_update` | kept for `listCommands` | OpenCode listed the person's Claude Code skills (it reads `~/.claude/skills`) |
| `current_mode_update`, `config_option_update` | `settings_changed {by: 'tool'}` | only a real difference |
| `session_info_update {title}` | `session_title {auto: true}` | Cursor names its sessions |
| `usage_update {used, size}` | `context_update {used, window: size, exactness: 'exact'}` | §5.5 |
| the prompt answer's `usage` | `usage_update {tokens}` | `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens` into `TokenUsage` |
| `compaction_update`, `compaction_summary_chunk` | `compaction` | §5.6 |
| `notice` | `notice` | `from` the descriptor's label |
| prompt answer `end_turn` | `turn_complete` | |
| `cancelled` | the turn ends stopped (`interrupted`) | only after our cancel; otherwise `INTERRUPTED_BY_TOOL` |
| `max_tokens`, `max_turn_requests` | `turn_complete` and a `notice` saying why it stopped | |
| `refusal` | `error` (not retryable), the turn's text kept | |
| a JSON-RPC error on the prompt | `error` | auth (§4.2) and "model not available" get their own wording |
| process exit | `error` + `session_live {live: false, reason: 'crashed'}` | cards released (`PendingCards`), queued inputs said undelivered |
| an unknown update kind | nothing; one host.log line | `unmapped.ts`, like the other two |

### 5.2 Tool calls

ACP sends a call as an upsert by `toolCallId`; ours is one `tool_call`, deltas, one `tool_result`. Measured, the first
frame (`pending`) has no input yet. So:

- `tool_call` goes out on the first frame that carries a non-empty `rawInput`, or on the first `in_progress`,
  `completed` or `failed`, whichever comes first, with `title`, `kind` and the input as received (`tool_call.input`
  is the record, the card's summary comes from `title` and `kind` through `tool-titles.ts`).
- An `in_progress` update's `content` is the whole output so far (measured); the delta is what it adds to the last
  one, as `tool_output_delta`.
- `completed` or `failed` → `tool_result` with the content's text and, when present, `rawOutput`'s text.
- `kind: edit` with `locations` or a `diff` content (`{path, oldText, newText}`) → `files_touched`, and the edit card
  gets the diff.
- A call never finished when the turn ends is closed as failed, so no card spins forever.

### 5.3 Approvals

`session/request_permission {toolCall, options}` → `approval_request` (the `ApprovalDetail` from the call's kind,
title and input, through the same builder the other adapters use). The answer is chosen **by kind, never by option id
or name**, since the ids differ per tool:

| Our decision | Answered with |
|---|---|
| allow | the `allow_once` option |
| always | the `allow_once` option, and the rule is ours (`always-allow.ts`): later calls that match it are answered `allow_once` by the adapter without a card |
| deny | the `reject_once` option |
| stop, close, a cancelled turn | `{outcome: "cancelled"}` |

"Always" is not passed on as `allow_always`. Cursor writes that into the person's own allowlist, which outlives
Centralu and which the person cannot see or undo from here; the rule Centralu shows, saves and removes has to be the
one that decides (#838). A request with no option of the needed kind is answered `cancelled` and logged, never guessed.

The permission presets:

| Preset | What the adapter does |
|---|---|
| `normal` | the tool's own configuration decides what it asks; every question becomes a card. OpenCode, whose default asks nothing: Centralu's base asks before edits and commands, under the person's own rules (§0.7) |
| `auto` | the adapter answers every question `allow_once` itself |
| `edits` (#1525) | `auto` for `kind: edit` calls inside the session's folder, a card for the rest (a `delete` or a `move` is not an edit, as for Codex) |
| `safe` | needs the tool to ask before every write and command. OpenCode: through `OPENCODE_CONFIG_CONTENT` (measured; §0.7). Cursor: no per-process switch found yet; until one is, Cursor does not offer `safe` (open question 3) |

`capabilities.gatesSteps` is false: ACP has no hook before every tool call, so an ACP session cannot be the
orchestrator answering a session's request (#1447). That is the existing rule for a tool that cannot gate steps.

### 5.4 Input during a turn

ACP defines one prompt at a time per session. Measured, OpenCode folds a second one into the running turn and answers
both together, so the end of the first input's turn cannot be told; other agents may refuse it. The core therefore
**queues input itself**: a message sent while a prompt runs waits, and goes as the next `session/prompt` when the
running one answers. `capabilities.midTurnInput` is false, and `turnInputs()` says what each turn took, as for Claude,
so the mailbox and `sendTracked` know a queued message ran as its own turn. The queue lives in the handle (the
manager already persists what was sent); messages still queued when the process ends are said undelivered
(`undeliveredError`). A profile that wants the fold (OpenCode's, later) can turn it on once its turn ends can be
told apart.

`nudge` and `quiet` input are left unimplemented: ACP has no way to add to a conversation without a turn.

### 5.5 Context share

One definition, the existing one: `context_update` feeds `SessionInfo.context`, `ContextMeter` and the nudges (#1492)
exactly as Codex's readings do. ACP's `usage_update.used` is the context in tokens, `size` the window.

- `contextAtRequest` is false: measured, the reading comes once per turn, at its end.
- A reading of `used: 0` in a turn that ended `cancelled` is dropped (measured: a false zero).
- The window goes to `ModelWindows.note` like any exact reading.
- A tool that sends no `usage_update` (Cursor, from its bundle) has `contextUsage: 'none'`, and the window shows no
  share for it, rather than an estimate built from a size we would have to guess. If Cursor's prompt answer carries
  `usage`, that is token use, not context, and is kept as `usage_update` only.

`autoCompactTokens` has no ACP field; the adapter ignores it unless a profile maps it (OpenCode's config may).

### 5.6 Compaction

- `compaction_update {compactionId, status}` and `compaction_summary_chunk {compactionId, content}` are collected per
  id. `completed` → one `compaction` marker; `failed` → a marker with `failed: true` and the error; `cancelled` →
  nothing. The summary is kept for the handoff record (`lastCompactSummary` needs no process: the host stores it as it
  arrives). `trigger` is `manual` for a compaction inside the compact turn Centralu started (#1451, #1500), `auto`
  otherwise, as for Codex.
- **An ordinary message is never taken for a compaction** (#59's note). OpenCode's measured `/compact` sends none of
  the above, only text and a drop in `usage_update.used`.
- Asking for one: `compactCommand` exists on the adapter only when the profile has one, so `compact_self` and the
  break-time compaction are offered only for those tools. For a tool whose `/compact` leaves no protocol marker
  (OpenCode 1.19.4), the compact turn Centralu itself started is the one known boundary: the adapter marks it when that
  turn ends `end_turn` and the next reading is smaller than the one before. That reads our own request's outcome, not a
  message, and it is what open question 4 asks the owner to accept or refuse.

### 5.7 Sub-agents and background work

ACP has no standard sub-agent update. Cursor's `subagent_spawned` / `subagent_state_update` (with
`_meta.cursor.toolCallId`, the launching call) map onto `subagent_event` with `parentCallId` and onto
`background_tasks`, in the Cursor profile, in PR 2 after a recording. Until then `builtInSubagents` and
`backgroundTasks` are false, and the client does not advertise sub-agent support, so Cursor runs them inline as tool
calls. A tool that cannot report background work is never idle while it holds a process (`sessionIdle`), which keeps
sleep and swaps safe meanwhile.

## 6. Centralu's tools through mcpServers

`session/new` and `session/load` take the session's MCP servers, so Centralu's tools reach an ACP agent the way they
reach Codex: the same stdio bridge (`orchestrator-bridge.mjs`, which calls back to the host's front door with the
session's bridge credential, #382), one entry for Centralu's own tools and one per attached app (`CC_APP_SERVER`):

```
{name: ORCHESTRATOR_MCP_NAME, command: <the host's node>, args: [bridgePath()],
 env: [{name: "CC_HOST_URL", value}, {name: "CC_BRIDGE_TOKEN", value}, {name: "CC_SESSION_ID", value}]}
```

stdio although both tools advertise `mcpCapabilities.http`: the bridge already survives host swaps and is scoped to one
session; an HTTP endpoint would be a second way in to secure. `bridge-path.ts` moves from `adapters/codex/` to
`adapters/` (the bundled file name stays). The servers are fixed when the session opens, so an app attached later is
`appAttachment: 'restart'`, as for Codex.

Tool approvals inside our own bridge are the host's, as now. `instructionChannel` is `server` (the bridge's MCP
instructions); ACP has no system-prompt field, so `systemPromptAppend` has no standard path (open question 2).

## 7. Capabilities

The capability list is what orchestration code reads; nothing outside `adapters/acp/tools/` asks which tool it is.
Values for the ACP adapter, decided per profile and, where marked, from the `initialize` answer at `detect()`
(agent-host.md §2: a capability may be decided at detect time):

| Capability | Cursor (PR 1) | From |
|---|---|---|
| `approvals` | true | the protocol |
| `contextUsage` | `none` | no `usage_update` (bundle); `exact` for a tool that sends it |
| `resume` | true | `loadSession` or `sessionCapabilities.resume` |
| `autoTitle` | true | `session_info_update` |
| `attachments` | `['image']` | `promptCapabilities.image` |
| `verbosities` | `[]` | |
| `exclusiveWriter` | false | ACP promises no lock |
| `backgroundTasks`, `builtInSubagents` | false | until PR 2 |
| `midTurnInput` | false | §5.4 |
| `gatesSteps` | false | §5.3 |
| `processModel` | `per-session` | §3.1 |
| `instructionChannel` | `server` | §6 |
| `sleep` | false | until resume is measured to lose nothing on Cursor |
| `compactCommand` (method) | absent | §5.6 |
| `listExternalSessions`, `readExternalHistory` (methods) | PR 2 | `sessionCapabilities.list` |

No new capability field is needed for PR 1. Whether a tool offers compaction is the presence of `compactCommand`,
which is how the contract already expresses capability (contract.ts: optional methods, not flags).

## 8. Later: import and history

`session/list {cwd}` (both tools) → `listExternalSessions`. `readExternalHistory` opens a short-lived process,
`session/load`s, keeps the replay (user and agent chunks, tool calls), and closes it: the same replay the live path
drops. `deleteExternalConversation`: OpenCode's `session/delete` / CLI; Cursor has none.

## 9. What ACP does not carry

| | Cursor | OpenCode |
|---|---|---|
| Account usage and limits (`listUsage`) | nothing in ACP or found in the bundle; left out | per-message `cost` in `usage_update` (free tier 0); no limits |
| The model list (`listModels`) | `cursor/list_available_models` (its own method) on a short-lived process; model ids carry parameters such as `[fast=true]`; the `model` config option on a session | `opencode models` (CLI); the `model` config option lists all providers' models |
| Effort | Cursor's model parameters (config options of category `model_config`), to measure logged in | the model's `variant`, later |
| Model window | `size` of `usage_update` if it ever comes; none now | `usage_update.size` (200,000 for big-pickle) |
| Cost per turn | — | `usage_update.cost`; not shown in PR 1 (no field for it) |

## 10. Tests (#1498 from day one)

### 10.1 The recorder

A dev-only switch on the host, `CC_ACP_RECORD=<folder>`, makes `connection.ts` write every line both ways, in order,
with its time, to one file per session. Recordings become fixtures only through a scrubber:

- paths under the session folder → `<cwd>`, the home folder → `<home>`; session ids, tool call ids, message ids and
  permission ids → stable placeholders (`ses-1`, `call-1`), consistent within a file;
- secrets (tokens, emails, the bridge credential, anything matching the host's secret patterns) removed;
- the command and skill list in `available_commands_update` cut to names only;
- the model's free text kept only for the scripted prompts (they are ours), long outputs cut with a marker.

Each file starts with a header line: tool, CLI version, `protocolVersion`, `agentInfo`, the scenario's name and
prompts, OS, and the date.

### 10.2 The replayer

A test helper gives the adapter a fake `AgentProcess` driven by a recording. It reads the adapter's outgoing frames,
matches each against the next recorded one by method and the parameters that matter (ids remapped, `<cwd>` and
placeholders matched, the rest a wildcard), then emits the recorded incoming frames up to the next outgoing one, with
their ids rewritten to the adapter's, and answers the adapter's requests from the recording. A test asserts the
`NormalizedEvent`s the adapter emitted (a snapshot where the list is long) and that every frame was consumed. Times
are kept for order, not slept: tests do not wait on wall-clock time.

### 10.3 The fake peer

A small scriptable ACP agent in the test helpers, for what a real tool cannot be made to send: a process that dies
mid-turn, a malformed line, `Authentication required`, a load that is not found, `compaction_update` and
`compaction_summary_chunk` (no tool we run sends them yet), a cancel with a permission open, a slow cancel past the
stop bound, an unknown update kind, and an adoption with the previous host's request ids in flight. Hand-written
frames stay here and say so, as #1498 asks.

### 10.4 Scenarios

| Scenario | OpenCode 1.19.4 | Cursor |
|---|---|---|
| a plain turn, a tool call, a file edit | recorded | after login |
| approval: allow, deny, "always" answered once | recorded | after login |
| input during a turn | recorded (folds) | after login |
| interrupt; interrupt with a permission open | recorded | after login |
| compaction (`/compact`) | recorded (text only) | after login, if it has one |
| process dies mid-turn, then load in a new process | recorded | after login |
| resume after a host restart (no keeper) | recorded (load, resume) | after login |
| adoption after a host swap | fake peer | fake peer |
| not logged in | — | recorded |
| sub-agents | — | PR 2 |

### 10.5 Refreshing

`pnpm acp:record <tool>` reruns the scenarios against the installed CLI in a temporary folder with a temporary
`CC_DATA_DIR`, scrubs, and rewrites `recordings/<tool>-<version>/`, so a tool update shows as a fixture diff
reviewed like code. OpenCode's run is free (its free models); Cursor's spends the person's plan, so it is run by hand
before a Cursor bump, not on a schedule. The weekly surface drift run (#270) reads each ACP tool's `initialize` answer
(no turn, no login needed) and its offered update kinds against the profile's baseline.

## 11. The SDK

The official TypeScript SDK (`@agentclientprotocol/sdk` 2.0.2) is Apache-2.0, 7.9 MB unpacked (generated zod schemas
for v1 and the v2 draft), with zod as a peer (we have zod 4). **Not a runtime dependency.** We speak JSON-RPC
ourselves:

- the connection is ~200 lines, the same shape as `CodexClient`, and the recorder, the per-host id prefix after a swap
  (§4.4) and the replay filter all need the raw line, which an SDK connection class keeps to itself;
- the SDK's own types must not leave `adapters/acp/` anyway (anti-corruption), so we would write the narrow types
  regardless;
- its entry points split stable and unstable features and moved between releases (its 2.0 migration guide); our
  surface is a dozen methods and update kinds.

It stays useful for the drift check: a dev-only step that reads the SDK's published `schema.json` and fails when a
method or update kind in our contract (`known-updates.ts`, `wire.ts`) leaves it, as `codex:bindings --check` does.

## 12. What the UI needs

Ideally nothing beyond the tool picker gaining an entry, and that already comes from the registry: the picker lists
`agents.detect`'s descriptors, and no `'codex'` literal is left in `packages/ui` (checked). The settings menu follows
capabilities and the model list. Checked in PR 1 with the mock platform: the descriptor's mark is distinct
(`descriptors.test.ts`), and a tool with `contextUsage: 'none'` draws no share.

## 13. The pull requests

1. **PR 1, `feat/acp-cursor`**: this document, the capability limits and `launchRefusal` with the host's gate and the
   pickers, `adapters/acp/` (connection, wire types, normalizer, session, adapter, fake peer), `adapters/frames/`
   (recorder, replayer, scenarios), `adapters/cursor-agent/` (launch, detect, surface, default model), the recordings
   of both tools, and agent-host.md §2–3.
2. **Cursor, the rest:** the model list and effort without changing the person's default (§0.2), modes, question cards
   (`cursor/ask_question`), sub-agents, import, apps, taking over a process after a swap.
3. **OpenCode on the same core:** its profile, its permission preset through config, cost, its `/compact` boundary
   (§0.1).
4. **The ACP drift check** beyond the surface reading PR 1 already gives Cursor (the weekly job installs Cursor's CLI).

## 14. Open questions

Questions 1 to 6 of the design were answered (§0.1). Left open:

1. **Cursor under Auto only.** It writes without asking (§0.2), so it cannot run under Safe, Normal or Edits. Whether it
   stays offered so, and how a session gets Auto (the new-session dialog has no preset choice and starts under Normal),
   is the owner's to decide.
2. **Cursor on Linux.** The layout `findCursor` reads there is measured on macOS only; the weekly drift job will say.
3. **Reasoning in OpenCode's reply text.** The `</think>` is dropped (§0.7), but the reasoning before it stays reply
   text, since it was shown as it came. Holding a message's text until it is known to be no reasoning would delay every
   reply; turning shown text into reasoning would need a protocol event. Left until the model or OpenCode stops sending it.
