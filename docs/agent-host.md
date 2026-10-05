# Agent Host — the Node sidecar design

A standalone Node process. In dev the developer starts it directly (`pnpm host`); in the packaged app the keeper (`centralu --keeper`, §4.1) spawns and watches it, and in `pnpm app:dev` the Tauri app does. **It has to behave the same whether or not a UI is there** — the UI can be closed and reopened many times (reconnecting) and the host keeps its sessions.

## 1. Internal structure

```
agent-host/src/
├─ main.ts              # CLI (--port --token --dev-services), startup order, and the
│                       #   tool → adapter registry (a Map literal; there is no registry.ts)
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
├─ data-dir.ts          # locating and migrating the data directory
├─ idle.ts              # the one rule for "is anything running a person would lose" (#352)
└─ updates.ts           # update checks, installing, "apply automatically when idle"
```

Usage parsing and the orchestrator's MCP surface do **not** have their own directories:
per-account usage lives in `adapters/<tool>/usage.ts` (it is a per-tool question), and the
orchestrator's tools are defined once in `sessions/orchestrator-tools.ts` and exposed per
adapter — in-process for claude, over a stdio bridge for codex.

### 1.1 Who gets Centralu's own tools (tool profiles)

Every session gets one bundle of the `centralu` server's tools, or none. The manager decides which
(`toolProfileOf`, and the same rule at create and wake); `profileAllows` decides both what the
bundle exposes and what its calls may run, so a name the bundle leaves out is refused even through
the Codex bridge.

| Profile | Who | View | Tools | Instructions |
|---|---|---|---|---|
| `orchestrator` | the one orchestrator | every session | all but the manager's and builder's | role and usage |
| `manager` | a session with worktree children, or the project's manager slot (#69, #76) | its own worktree children | list, read, send, propose and delete a worktree session | worktree rules |
| `scoped` | a coordinator (#80; made through `agents.createCoordinator`, once by the control app's tasks, removed in #97) | its members | list, read, send | its boundary |
| `builder` | an app's building session (M4 C-3) | its own app | `check` | build-and-check |
| `reader` | every other session in a project (#320) | its own project, read at call time | `read_session` (no id: lists), `recall`, `app_guide`; `ask_project` (#371, §1.2); and `find_apps`, `attach_app`, `detach_app` (#371 part A, apps.md §9.4) | none |

The `reader` set is read-only: its tools object refuses sending, creating and settings outright,
not only by name. It is never given to an agent session an app stood up (M4 D-1), whose answer goes
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
`READER_BUDGET_CHARS` (1,000).

The app-access tools (#371 part A: `find_apps`, `attach_app`, `detach_app`, apps.md §9.4) ride on
the same server with their own ceiling, `APP_ACCESS_BUDGET_CHARS` (900; the set is 874), so neither
set grows into the other's headroom. Claude defers all three, which adds +31 tokens per request (the
same probe, 2026-10-05, measured on the #320 set before `ask_project` joined it: +192 to +223), and
loaded they would add +263, which is what a
Codex session pays. The model still finds them: 5 of 5 fresh haiku sessions found `find_apps` through
tool search from a plain request (apps.md §9.4).

A Codex session with a bundle starts the stdio bridge, so since #320 every Codex session starts
one more node process (about 40 MB resident, idle). The bridge sets
`default_tools_approval_mode: 'approve'`: our tools are never asked about, as on the Claude side,
and without it Codex in auto (`approvalPolicy: never`) refused every call on its own.
`scripts/smoke-reader.mts` runs the set end to end with a real model (`TOOL=codex` for Codex).

### 1.2 Asking another project (`ask_project`, #371 part B)

The one reach an ordinary session has outside its project. `ask_project({ project, task })` gives a
task to another registered project and returns the answer of the session that did it, the way a
subagent's result comes back. It rides with the reader set (same profile, same Settings switch) but
is its own set, `DELEGATE_TOOLS`, with its own budget, because it acts. The orchestrator, managers
and leads do not get it: they already direct sessions with `send_to_session`, inside their view.

What one call does (`SessionManager.askProject`):

1. **The target.** Another registered project, by name or id. Its own project is refused ("do the
   work here"); an unknown name is refused with the other projects' names. A session that was itself
   asked (`askedBy` set) cannot ask a third project: depth one, so two projects that consented to each
   other cannot bounce a task between them without a person.
2. **Consent** (`ensureProjectAccess`, kind `delegate`). The first time a session of project X asks
   project Y, a card stands in the caller's session, in the approval slot (detail `project_access`):
   allow once, always for this pair, deny. Only "always" is stored (store v44, `project_consents`,
   one row per from, to and kind; both ids cascade with their project). Settings → Permissions lists
   the pairs and revokes them. Deny and a withdrawn card return a refusal the model reads as "do not
   ask again unless told". The same gate serves part A's app tools (kind `apps`).
3. **The delegated session.** The idle (or finished) session this caller asked in that project
   before, so a second ask builds on the first; otherwise a new one with that project's folder, its
   instructions (its trust, as for any session), its default tool and that tool's remembered model and
   effort, under the `normal` preset — what a session the person opens there gets, so its approvals
   stand as cards in that session where the person sees them. It is an ordinary visible session,
   named `Asked by <project> · HH:MM` and marked `askedBy` (store v45) with the caller; its header
   links back, and the caller's conversation shows a compact card linking to it.
4. **The task** goes in a frame (`askFrame`): who asks, and that the final message is the answer and
   should name files by absolute path. It is recorded as sent by the caller (`from`), like
   `send_to_session`. The call waits on the turn with the same watcher an app's agent uses
   (`AgentRunWait`).
5. **The answer.** The turn's final text (`finalAnswer`), JSON-quoted for the model like a worker's
   preview (someone else's words), cut in the middle past 6,000 characters. The absolute paths it
   names that exist **inside the target project's folder** (resolved through symlinks; never the
   project root itself) become readable to the caller (`readGrants`): a file opens that file, a folder
   opens what is under it. Paths outside are listed but not opened. A grant lives while this host
   serves the caller. Claude reads through `CreateSessionOpts.mayRead`, asked in `canUseTool` (a read
   outside the working folder lands there; `additionalDirectories` is fixed at launch); Codex does not
   restrict reads, so it needs nothing.

**Long work.** A call waits up to `ASK_WAIT_MS` (240 s), under Codex's 300-s `tool_timeout_sec`
(now set on the `centralu` server too) with the same margin as an app's long call. Past it the
answer is "still working" with the session's name, and a call with the same project and no task
waits on the same turn; a new task while one runs is refused. The bridge waits 280 s for
`orchestrator.tool` (was 60 s), so "still working" reaches the model before any timeout does.

**Stop.** Stop on the caller (`interrupt`) stops the delegated turn and ends the call with that
reason; so does the call's own cancellation (the MCP request's signal, Claude). The person stopping
the delegated session, or a failed turn, returns an error naming the session and suggesting the
next step. Deleting the caller drops the wait and its grants; the delegated session keeps its turn,
since it is now that project's own session.

**Size.** Measured like the reader set (haiku, `scripts/probe-reader-tools.mts`): `ask_project`
is 350 characters (`DELEGATE_BUDGET_CHARS` 400) and costs **+103 tokens** loaded (the set: +192 →
+295), +10 deferred. It is loaded: asked "Have the toolkit project export the sprites again, then
tell me where the files are", the model called it for that project 7 times in 10 loaded and 0 in 5
deferred — deferred, it searched past conversations and its own folder instead, the failure #320
measured for `recall`. A miss is an answer saying it has no such project, and the person can name
the tool. One of five unrelated how-to questions drew a call naming a project that does not exist
(refused, no card). The description says "a job", not "a task": the two read the same to the model
(7 in 10 each), and the guide, which lists every seat's tools, keeps no word of the removed
control rail's tasks (#97). Two other wordings did no better (0 and 3 in 5).

`scripts/smoke-ask-project.mts` runs it end to end on a temp store and data folder: a haiku session
in one scratch project has the other write a file with a number only it knows and reads it back
(`CALLER`/`CALLEE` = `claude` or `codex`).

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
| Finding a tool | PATH, augmented from the login shell | PATH with PATHEXT, absolute entries only; npm/pnpm `.cmd` shims read for the `.js` or `.exe` they start | `env-path.ts`, `tool-launch.ts` |
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

The one addition (#280): under the keeper (`CC_KEEPER=1`), the host also writes
`{"activity":{"busy":true|false}}` to stdout, once at start and whenever it changes
(`keeper-link.ts`). That is what the keeper's idle rule reads. Started any other way, the host
writes nothing but the ready line.

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
| Claude | name lists inside `scripts/claude-sdk-drift.mjs` — SDK exports, option keys, response fields — plus one runtime shape check: an omitted `permissionMode` must reach the CLI as no `--permission-mode` flag (the `normal` preset rests on it, #275) | `pnpm drift:claude [version]` (installs `@latest`, or the given version, into a temp dir, never the workspace) | a name leaving the `.d.ts`, or the SDK pinning an omitted mode to `default` again, **before** an upgrade lands it on us |

Both are name checks (Claude's one shape check aside), run in both directions: the vendor must still carry every name
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

**One host per data folder** (`dev-services/instance-lock.ts`). Two hosts on one folder would each hold their own session list and write to the same `store.db`. Ownership is an exclusive SQLite transaction (`BEGIN EXCLUSIVE` on `host-ownership.sqlite`, DELETE journal mode) that the host holds for its whole lifetime (#82): taking it is atomic, a second host is refused at once, and the operating system releases it when the host dies, however it dies, so a crash leaves nothing stale. `host.lock` (pid and start time) remains as the description of the owner in the conflict message, and for older hosts that know only that file: a live, matching `host.lock` still refuses the start. Before #82 ownership was the file alone, checked and then written: 8 hosts started at once produced 2 owners. This is single-machine ownership — not a distributed lease, and not for a data folder on a network filesystem.

### 4.1 Who holds the host: the keeper (#280, option C step 1)

In the packaged app the host's parent is the keeper (`centralu --keeper`, the app's own executable in a
mode; [architecture.md](architecture.md) §4.1), not the app. The keeper launches the host with
`--port 0 --watch-parent --db <data>/store.db` and `CC_DATA_DIR=<data>`, keeps its stdin pipe, and restarts
it by the rules the app used before: five consecutive failures, a 30 s stable-uptime reset, and an
immediate stop on a lock conflict or a store only a newer build can read (`host_proc.rs`, shared by the
keeper and the app's direct path). If the keeper dies, the host sees EOF on that pipe and shuts down.

**Per-build copies.** Before each launch the keeper copies the bundle's `resources/host` folder to
`<data>/hosts/<key>/` (temporary folder, then rename) and runs `main.mjs` from there. The key is the commit
stamped into `bundle-info.json`; a `-dirty` or `unknown` build gets its build time appended, so two different
dirty builds never share a copy. Copies other than the running host's are removed once a host is ready.

**Where it came from.** The keeper keeps, for the running host, `{ commit, builtAt, version,
protocolVersion, bundlePath, hostDir, copyDir }`, returns it on the control socket, writes it to
`<data>/keeper.json` (no token), and passes it to the host as `CC_HOST_SOURCE`. The host adds it to every
`hello_ok` as `build` ([protocol.md](protocol.md) §1), with the commit always its own compiled-in one.

**Control socket.** `<data>/keeper.sock`, created `0600` under `umask 077`; every connection's peer uid must
be the keeper's own. Newline-delimited JSON, one request per connection except `attach`:

| request | answer |
|---|---|
| `{"op":"status"}` | `{"ok":true,"view":…}` — host state, the front door's port and token (§4.2), build source, background mode, attached windows, activity, the current or last swap (`swap`), whether the host keeps agents across one (`keepsAgents`), and the keeper's own build (`keeper.build`, since step 4) |
| `{"op":"attach","protocol":1,"build":…}` | `{"ok":true,"view":…,"sameBuild":bool,"keeperSameBuild":bool,"relaunched":bool}`, then `{"event":"status","view":…}` on every change for as long as the connection is open. An open attach connection is what "a window is attached" means; its closing is the detach. `relaunched`: this window is the one an announced relaunch started (§4.5) |
| `{"op":"relaunching","graceSecs":n?}` | `{"ok":true,"graceSecs":n}` — the app is about to relaunch itself to apply an update (#352): for `n` s (60 by default, at most 300) no window attached does not stop the keeper, whatever background mode says. The next attach spends it |
| `{"op":"stop"}` | stops the host and the keeper ("Quit and stop agents") |
| `{"op":"switch","source":…,"keeper":{"exe":…}?}` | a blue-green swap to that build (§4.2; the build stamp is re-read from its folder). With no host up, the next start simply runs that build. With `keeper` (the app sends its own executable) and a keeper of another build, the keeper first hands itself over to that build's keeper ([architecture.md](architecture.md) §4.4), which then runs the swap. A second `switch` during a swap is refused |
| `{"op":"upgrade","exe":…,"source":…}` | hands the keeper over to the keeper at `exe`, of build `source`, leaving the host alone (§4.4) |
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
`keeper-children-integration.mjs` and `keeper-handoff-integration.mjs` with `--no-claude --no-codex`. It exists
because none of this shows in unit tests or e2e: #329's `await` before the server existed crashed every host
restart that held a terminal (#348), and only a hand run of the children script noticed. The claude and codex
turns stay manual. Each script ends every process it started and everything those started, pass or fail, found
from one process table rather than by name (`scripts/keeper-test-processes.mjs`), and prints the end of
`keeper.log` and `host.log` when a check fails. Not on Linux yet: a trial on ubuntu-24.04 (2026-10-05) ended when,
right after the first scenario's keeper stopped, a SIGTERM reached the script itself, outside the keeper's process group.

### 4.2 The front door and the swap, seen from the host (#280, option C step 3)

The design is in [architecture.md](architecture.md) §4.2. What the host does:

**Token and address from the keeper.** Under the keeper the host gets `CC_HOST_TOKEN` (the front door's token,
the same for every host the keeper runs) and `CC_FRONT_DOOR` (`ws://127.0.0.1:<door>`), and deletes both from its
environment once read, so terminals, agents and commands do not inherit them. The Codex bridge is started with the
front door's address (`swap-control.ts`, `bridgeAddress`): a running codex keeps its bridge, and only an address
that outlives this host survives a swap. Without a keeper the bridge gets the host's own port, as before.

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

**The child socket** (`keeper/children/` in the desktop crate, `keeper/children-client.ts` here). The first line
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
mid-write never leaves a torn request; up to 8 MiB are queued before the keeper stops reading the host.

**What the host spawns there.** Every child carries a tag only hosts read (`keeper/tags.ts`): `{kind:"agent",
tool, sessionId, version?}` (the CLI version it was started from, #297, §4.6), `{kind:"terminal", id, cwd}`, `{kind:"command", cwd, command, runId, startedAt}`. A newer host
must keep reading an older host's tags: the children outlive the build that spawned them.

- **Agents.** The manager passes the adapter a `ProcessSource` (`adapters/contract.ts`): `spawn` in the keeper,
  or `adopt` a kept process. Claude gets it as `spawnClaudeCodeProcess`; `CodexClient` takes the process instead
  of spawning. `KeeperAgentProcess` has the `ChildProcess` surface both use, but `kill()` is a keeper request that
  is never sent once the process is detached or the host is exiting (the SDK kills its processes on owner exit),
  and `stdin.end()` is `close_stdin`. Codex request ids carry a per-client prefix, so an answer to the previous
  host's request cannot resolve one of ours.
- **Terminals and commands.** `TerminalService` and `CommandRunner` take the keeper's pty module (`KeeperPty`,
  node-pty's surface) instead of node-pty; stopping them still walks the process tree (`kill-tree.ts`), which
  works from anywhere.

**Leaving** (`main.ts`, `stopServices(mode)`). *Detach* — SIGTERM, SIGINT, the keeper's pipe closing, an
uncaught exception, a swap's drain — calls `detach()` on every session handle, terminal and command run: nothing
is sent to the tool, a waiting approval stays waiting, and output still in flight is recorded before the store
closes. App processes and the in-process tool servers stop, as they live in the host. *Stop* — the keeper's `stop`
event, or any ending without the child service — is the old path: sessions disposed, terminals and runs killed.
After a stop the keeper ends whatever is left (stdin EOF and SIGHUP, 2 s, TERM to each group, 1 s, KILL).

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
| codex | `initialize` again: `-32600 "Already initialized"`, nothing else changes. `thread/resume`: `thread.status` `active`/`waitingOnApproval`, the running turn in `thread.turns` (the id Stop needs), and the approval re-sent with the same request id (`0`); accepting it finished the turn. Since #342 the resume asks for no turns (`excludeTurns: true`), and the running turn comes from `thread/turns/list` (`limit: 1`, newest first, `itemsView: 'notLoaded'`), asked only when the thread is `active`; measured again on 0.160.0 (2026-10-05): the turn came back `inProgress`, and a pending approval was still re-sent under its id. A Codex that predates the flag answers with the turns, and those are read as before. It does not restart the thread's MCP servers (a probe server configured on resume never started), which is why the bridge has the front door's address and token. |

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

### 4.5 Applying an update, seen from the host (#352)

The design is in [architecture.md](architecture.md) §4.5. The host's part is the install and one rule.

**The install** (`updates.ts`). `updates.apply` runs `npm i -g centralu@<v>` and, when the installed app exists,
`centralu install`, then reports `restart_required`; it never restarts anything. With `autoApply` on ("Apply updates
automatically when idle", `updates.setAutoApply`, saved as `updates.autoApply` in the store's app settings, off by
default) a check that finds a newer version starts the same install by itself, and turning the setting on with a newer
version already known starts it at once. Not over an install under way or one already finished: a check after it leaves
`restart_required` alone, so it installs once. A failed install is retried by the next check that finds the version
again, six hours later.

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

**The capability check seam** (#270). On every change of an installed CLI's version the service calls
`capabilityCheck({ tool, from, to })`. #270 proposes re-running the probes for what a tool could not do when its version
moves; nothing implements that yet, so the default writes one line to host.log saying so. The probes plug in there.

### 4.7 Remote mode, phase 1: `centralu serve` (#82)

The app can work with a project on another machine (an SSH server, later a laptop). That machine runs its own,
independent host: its own store, its own agent CLI sign-ins, its own files and terminals (#82, decision 1). In phase 1
the person installs and starts that host by hand; the app reaches it through an SSH local forward. Nothing listens on
a public interface on either end: the remote host binds 127.0.0.1, and so does the forward on the person's computer.
The app installing the host over SSH is phase 3, after its lifecycle contract is written (#82, decision 4).

**On the remote machine:**

1. Install Node 22 or later, then `npm i -g centralu`. On Linux the platform package carries the bundled host
   unpacked beside the AppImage (`host/`, [releasing.md](releasing.md)), so running it needs no display, no FUSE and
   no desktop libraries.
2. Install Claude Code and/or Codex there and sign in (`claude`, then `/login`; `codex login`). The host uses that
   machine's sign-ins, never the client's.
3. Run `centralu serve`. It stays in the foreground and logs to stderr (and to `~/.centralu/host.log`, as always).
   The line to look for is `[centralu serve] listening on 127.0.0.1:17175 …`.
4. Keep it running with whatever you already use: tmux, `nohup`, or a `systemd --user` unit (below). Real
   supervision, an update path and uninstall come with the installer in phase 3.

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
that is what writes `~/.centralu/bin/centralu`.

**The commands:**

| Command | What it does |
|---|---|
| `centralu serve` | Starts the host in the foreground on `127.0.0.1:<port>`. Exit code: the host's own (0 after a clean stop) |
| `centralu serve --port <n>` | The same, on that port. The port is recorded, and the next `serve` without a flag uses it |
| `centralu serve --connection` | Prints one JSON line and exits (below). Creates the token if there is none yet |
| `centralu serve --rotate-token` | Replaces the token, keeping the port. A running serve keeps the old one until it restarts |
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
| The host gets its own process group and `--watch-parent` | Ctrl+C reaches the launcher, which passes one SIGINT to the host alone, and the host stops its agents in order. Killing the launcher, even with SIGKILL, closes the host's stdin and takes it down: it is never left running unsupervised (`tooling/launcher-serve.test.ts`) |
| A signal during startup is held until the host can shut down | Before the host attaches its handlers the kernel's default applies and ends it on the spot. Measured: a SIGINT passed on as soon as the ready line was read killed the host every time. Now it shuts down cleanly once started; a second signal while starting exits at once (`main.ts`, `pendingSignal`) |
| A second `serve`, or any other host on the same data folder, is refused | The ownership lock (`instance-lock.ts`) is the authority. `serve` first asks the port it recorded, so a serve already up is named with its port; for any other owner the host's lock message is followed by a line naming the pid |
| No `DISPLAY` / `WAYLAND_DISPLAY` in the host's environment | Nothing it starts can open a window or a keyring dialog nobody would see; a tool that would ask falls back to its file store or fails with a message in the log |
| Windows: no own group, no forwarding | `detached` means a new console there; the host shares the launcher's console and gets Ctrl+C itself. Not exercised yet |

**What phase 1 does not cover.** App views open from the host's HTTP door at `127.0.0.1:<port>`, so they work
through a forward whose local port equals the remote port. An app whose manifest asks for its own origin gets a port of
its own (`views/origin-ports.ts`), which one forward does not carry. The client's host list, search across machines and
the grid layout moving to the client are the client's part of #82.

A host refuses a client of another protocol with `version_mismatch` and close code 4002. The message names both numbers
and which side is older, so the person knows whether to update the app or the remote ([protocol.md](protocol.md) §1).

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

| Steps | What they do | Older build |
|---|---|---|
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43 | add a column | reads it (39: shows sessions in the trash as live ones; 43: an older host's `grid.set` writes no span, so app panels fall back to their defaults, #306) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42 | add a table (3 also backfills the index: heavy; 42 copies the grid's session rows into `grid_layout` once and leaves `grid_panels` as it was, #288) | reads it (42: an older host keeps its grid in `grid_panels`, so the two builds' grids can differ) |
| 10, 11, 40 | rebuild with the same shape (10: `sessions` with `project_id` nullable; 11 and 40: the index, then `VACUUM`: heavy) | reads it |
| 21, 26, 29, 35 | rewrite data one way (21 rewrites every message: heavy) | reads it, cannot be undone |
| **13, 28, 32** | **drop a table or a column** | **breaks: raises `min_reader_version`** |

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
chokidar is not a dependency, `core/usage` is not a directory, there is no `usage.weekly`
method, and while `usage_facts` is still in `schema.sql` no code reads or writes it. It was
also the *opposite* of the rule §8.1 states, and the two sections sat in this file
contradicting each other. Reading a tool's private JSONL is exactly what §8.1 forbids, for
the reason given there: an undocumented format breaks silently on upgrade, and a silent break
in a number is worse than a missing number.

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
