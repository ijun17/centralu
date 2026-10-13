# Security boundaries and residual limits

These controls reduce risks from untrusted repository and agent content. They do not
sandbox an already-executing process with the user's OS privileges. An app's server is such a
process ("App servers"); an app's screen is sandboxed ("App views"). The app model itself is in
[apps.md](apps.md).

## Inter-agent content

Worker reports retain their provenance in stored history and the UI. Reports from
workers to directing sessions become host-authored notifications; ordinary
orchestrator/manager/coordinator instructions retain their content and attachments. A worker
holding the read-only `reader` set (#320) is still a worker here: the gate asks whether the
source directs sessions, not whether it has tools. Worker-originated records are excluded from
privileged conversation memory. Read-session, preview and recall text is framed as structured
untrusted data, not human authorization — that now includes what one ordinary session reads of
another in the same project; the reader set reads no other project and cannot send.

### Starting other agents in the same project (#561)

`start_agent` and `agent_session` let an ordinary session start a Claude or Codex session in its own project and
work with it ([agent-host.md](agent-host.md) §1.2.1). They add no reach the caller lacked (the child works on the
same files under the same or a lower preset), but they multiply what runs. The rules below
apply to `safe` and `normal`; `auto` opens the consent, depth, ownership and trust
boundaries (#603), with a log line instead of a card or refusal:

- **The person's consent**, a card in the caller's session the first time it starts one: once, always for this
  session (kept while the host serves it), always for this project (stored as the project's `agents` consent,
  revoked in Settings → Permissions). Injected text can at most raise a card.
- **Never above the caller**: the child gets the caller's preset; a child the person raised above it takes no
  more work from the caller.
- **Depth one**: a session marked `askedBy` (started by `start_agent`), or handling an active `ask_project` task, can neither
  start agents nor ask a project.
- **Ownership**: `agent_session` acts only on a session whose `askedBy` is the caller, in its project. Under
  `auto`, another caller's delegation can be observed without consuming its report or result;
  observer waits never grant files or stop work on cancellation. A person's turn or app request
  with no delegation stays unowned by its observer, does not pin that caller awake, and
  continues if the caller is stopped. An explicit stop preserves
  the owner's error report/result. Self wait, stop, delete and send are refused in every preset.
- **A ceiling**: Settings → Orchestrator → Running agents per project (`prefs.agentCeiling`).
  Empty uses the preset default: no ceiling under `auto`, 4 otherwise (`AGENT_CEILING`); zero
  explicitly removes the ceiling, and a positive integer limits all running children in each project.
- **Visible**: each child is an ordinary session in the sidebar with its own approval cards and Stop, and outlives
  the caller's deletion. Its task is recorded as sent by the caller (`from`), not by the person.
  Mid-turn follow-ups keep that provenance and are framed as the parent's words, through the same message path
  the person uses. They do not interrupt the child or replace the turn an existing wait follows; only a turn
  delegated by this parent accepts them, and the preset check still applies on every send (#592). If a note runs
  as a new turn after the earlier result, its completion receipt keeps that turn in the parent's delegation:
  send, stop and wait still apply. Intermediate results cannot consume the report marker; the last note's
  answer is delivered once through a wait or a report. Follow-ups use a note frame, not the initial task frame.
- **Not from an untrusted project** (#382's rule).

**Worktree deletion** (#608, owner 2026-10-13) no longer requires a clean worktree or merge proof in any preset.
Same-project scope, the preset's ownership rules and the refusal for working children remain. Sends and resumes
are blocked during cleanup; disposal
must complete before snapshotting or removing the worktree. Patches preserve tracked and non-ignored untracked
files (binary bytes and staged changes included); full git bundles keep the union of HEAD and the stored branch not reachable from the local trunk.
A switched or detached HEAD does not drop the stored branch. Submodule HEAD/local branches and gitlink
targets from the index, HEAD tree, and every unmerged superproject commit are bundled when locally
available and absent from remote refs, even after submodule HEAD moves away. Batch object checks
skip unfetched targets, and historical `.gitmodules` names preserve targets across path renames.
History and tree listings stream to temporary files instead of filling a stdout buffer. Temporary named refs make gitlink-only targets
fetchable from the bundle and are removed from the live repository after capture. If the trunk cannot be
read, all reachable commits are kept conservatively. Initialized submodules are captured separately. Snapshotting uses a private index with repository hooks and filters disabled. It does not
change the child's index or execute repository programs. Patch bytes go directly to files, without UTF-8 stdout
decoding. Input above 256 MiB (all working files considered by git add plus changed staged blobs, including
initialized submodules) is refused before any git add; files and the real index stay untouched. Once trashed,
a removal failure returns `deleted` with a warning naming what was left. Ignored untracked files are not kept.

The recovery directory is `<data>/worktree-recovery/<session id>/<snapshot id>/`, tied to the trash record.
Restore recreates the root worktree/branch and attempts to apply its patches, with a conversation notice offering
the files and manual bundle/patch recovery (submodules are manual). A bundled stored branch that differs
from HEAD also gets a `recovered/<session id>-stored-branch` branch, with a numeric suffix if occupied.
Existing branches are not overwritten. If a retry finds the worktree already present, it leaves the files
and index alone. A marker written after successful patch application lets the notice report prior success;
without one, it warns that manual recovery may still be needed. Recreating the worktree clears the marker.
Gitlinks found only in older merged history remain tracked by [#623](https://github.com/ijun17/centralu/issues/623).
Recovery files remain after restore and through later deletions, until the session is purged through Settings;
purge/empty trash removes the entire session recovery directory before its row is deleted. The trash has no
automatic expiry today; any future expiry must use the same purge path. Other programs with the person's
permissions can still write the repository while it is captured: stopping the session is not filesystem isolation.

Worktree children (#582) keep the same preset as their parent. **Every Codex session under `auto` runs
with `danger-full-access` (no sandbox) and `never` approval**, including a child of an `auto` parent. This
matches Claude's `auto` bypass permissions. Commands have the person's OS access, including network and
files outside the project. `safe` uses workspace-write with `untrusted` approval. `normal` follows the
person's configured approval policy and sandbox mode, including a personal full-access mode.

In the Codex adapter, every linked-worktree session still adds its repository's canonical git common
directory to workspace-write's writable roots on start and resume (#585), retaining existing extra roots.
**Codex keeps `.git` read-only even inside writable roots**, so this does not permit commits or index locks.
Committing in that repository needs `auto`, or the person's own full-access sandbox under `normal`.
Git metadata is shared between branches, so a worktree is not isolation from changes to refs or repository
configuration. No guessed git path is granted when discovery fails.

Codex workspace-write network access is explicitly off under `safe` and `normal` (#585); `auto` has
unrestricted network access through its full-access sandbox. The effective
thread sandbox, rather than the CLI name in the manager, determines the notice in `start_agent`'s answer:
"this child cannot reach the network under <preset>" when blocked, with no such notice under `auto`.
The mapping applies on thread start and resume; a changed preset takes effect on the session's next thread.
This controls commands in Codex's sandbox, not host-run MCP app servers. Claude children receive no
Centralu SDK sandbox override, just like
ordinary Claude sessions; the person's own loaded sandbox settings may still restrict them. This comparison
was checked against adapter/SDK configuration, not a live Claude model turn.

JS dependencies are copied into new worktrees before the agent starts when the root lockfiles and package
manifests match the project checkout. APFS clones fall back to ordinary copies, never a shared top-level
`node_modules` symlink. Workspace package folders are included, existing targets are not overwritten, source
and destination paths use the project path guards, and dependency links outside the worktree are removed.
This avoids automatic registry access and install scripts in the host. It does not validate dependency code:
running tests still executes the project's installed dependencies. Missing or incompatible source dependencies
need the project's explicit setup command or an install by the child under its preset.

### Asking another project (#371 part B)

`ask_project` is the one way an ordinary session acts outside its own project. Under `auto`,
consent and depth/trust refusals are open and logged. The existing target session keeps its own
preset; session creation in another project is forbidden under every preset (#614). Under `safe`
and `normal` it has these controls ([agent-host.md](agent-host.md) §1.2):

- **The person's consent per pair of projects**, asked as a card in the caller's session the first
  time X asks Y; only "always" is remembered (store `project_consents`), and Settings revokes it.
  The card names the selected session as well as its project. Without consent no task is delivered.
  The card is the boundary, not the tool's description: a caller steered by injected text can at most raise a card.
- **What the delegated session runs is gated by its own project's permissions.** The existing session keeps its own
  preset and project trust; its approvals stand as cards in that session. Under a person's global bypass it runs as freely as that person's
  own sessions there — the owner's decision is that the delegated session may change code in its own
  project. The task arrives framed as sent by another session, never as the person.
- **Depth one.** A session handling an active cross-project task cannot ask a third project, so two projects that
  consented to each other cannot pass a task back and forth without a person.
- **Trust** (owner decision 2026-10-11, #382). A session in a project the person has not trusted cannot
  ask at all, the rule `attach_app` follows: text in that repository could be the one asking, and the
  card would then be the only thing between a planted instruction and another project. An untrusted
  project *can* be asked, and the card says so ("Let X ask Y (not trusted) to …", and a line on what
  that means): the selected session there reads none of its settings or instruction files and runs none
  of its apps, but works on its files under the person's own permission settings. A remembered
  "always" for the pair still skips the card, also after the target loses trust.
- **Existing sessions only** (#614). Selection by name or id is confined to ordinary sessions in the
  named target project. Without a selector, exactly one is required; ambiguity lists names, states
  and last activity, and no session refuses until the person opens one. Builders, app agents and
  orchestrators cannot be targets. No preset permits cross-project child creation. Old ask-created
  sessions remain ordinary sessions without cross-project ownership. A busy session accepts tracked
  mid-turn input only if its adapter supports it; otherwise it returns busy and its state. Another
  delegation's watcher cannot be overwritten. Delivered input is visible in conversation with the
  asking session's `from`; waits follow its completion receipt, including queued turns. Caller Stop
  reaches a target only during an active wait. If the task joined the person's running turn, caller
  Stop/cancellation ends only that caller's wait, leaving the turn, receipts and other observers
  running. A bounded call that already returned does not confer a right to stop the target.
- **The answer is someone else's words**, JSON-quoted for the caller like a worker's preview.
- **Files come back by name, and only from inside the target project.** A named path is granted
  to the caller only if it exists inside the target project's folder after resolving symlinks, and
  never the project root itself; a file opens that file, a folder what is under it. A path outside
  is listed and not opened (Claude then asks the person before reading it; Codex does not restrict
  reads at all, so for a Codex caller the grant changes nothing and the residual is the same as any
  Codex read).
- **Residual:** within an allowed pair, the task text comes from the calling model, so injected text
  in the caller's context can reach the target project as a task. The target's approvals, the
  visible session and Stop are the controls left; revoking the pair ends it.

JSON framing prevents ambiguous transcript-line assembly; it does **not** make text safe
for an LLM to obey or eliminate prompt injection. Tool scopes and typed approval checks
remain the deterministic authorization boundaries.

### Claude's independent-session messaging (#569)

Claude Code can discover other Claude processes on the same machine through
`~/.claude/sessions/<pid>.json` and send messages over per-process Unix sockets
(named pipes on Windows). Its default inbound policy delivers messages between sessions in
the same permission-mode class, including two `safe` sessions. That path does not pass through
Centralu's `ask_project` consent card.

Every `safe` or `normal` Claude query Centralu builds applies inline SDK `settings.crossSessionInbound: 'refuse'`
to drop inbound peer messages and adds `ListAgents` and its alias `ListPeers` to
`disallowedTools`. It also forces `CLAUDE_CODE_HARBOR_KITE=0` in the child environment: in the
inspected CLI versions 2.1.263–2.1.289 this undocumented gate disables peer listing,
cross-session sends and inbox binding. `SendMessage` remains available because it also
continues the session's own background subagents. Existing settings, denies and environment
are merged, and settings-file selection remains governed by project trust and session kind.

Under `auto`, the adapter applies none of these cross-session controls (#603); the session's
own CLI settings and environment still apply. For other presets these controls cover workers, orchestrators, coordinators, worktree managers, builders, app
agents, `start_agent` children and resumed sessions, including fresh keeper processes. A host
handover that adopts an existing CLI cannot retroactively change its startup flags or
environment; processes started before this fix must be restarted.

Limits: the environment gate is version-sensitive. The documented inbound refusal and
discovery denies remain even if that gate stops working, but they alone do not prove outbound
isolation when a peer address is already known and `SendMessage` stays enabled. Re-run
`packages/agent-host/scripts/probe-cross-session.mts` before SDK/CLI upgrades to check discovery,
delivery to a second session and own-subagent messaging. Unit tests check constructed options;
the live probe supplies bounded runtime evidence. This is a provider-messaging boundary,
not OS isolation: commands with the user's permissions can still access same-user files and
sockets, and processes started outside Centralu are not configured by this adapter.

## What each session's tools can do (#382)

One place for what each kind of session can call and when the person is asked. Each piece was
decided in its own issue; this is the whole matrix, audited against the code before 1.0.

### Which tools a session has

The host gives a session one profile (`toolProfileOf` in `sessions/manager.ts`), and the profile
decides both which tools the session sees and which calls run (`profileAllows` in
`sessions/orchestrator-tools.ts`). Claude's in-process server is built from the profile
(`adapters/claude/orchestrator-mcp.ts`, `toolDefsFor`); Codex calls through the bridge, and the host
checks the profile again on every call (`SessionManager.runOrchestratorTool`), so a name the
session was not given is refused even when the bridge asks for it. The bridge connects with a
credential for its own session's bridge calls, not with the host's token (owner question 4; "The
front door" below).

| Profile | Which sessions | What its tools see |
|---|---|---|
| `orchestrator` | The central orchestrator | Every session |
| `scoped` | A coordinating session | Its member sessions |
| `builder` | An app's builder session | Its own app (`check`) |
| `reader` | Every other session in a project, while Settings → Orchestrator → "Let sessions look at their own project" is on | Its own project; acts only on the agents it started (`start_agent`, behind a consent card) and another project only through a consent card |
| none | A session with the switch off, a session with no project, and an agent an app started (`run_agent`) | No Centralu server at all |

The worktree manager's profile (`manager`: list, read and send to its worktree sessions, propose one, delete a merged
one) was folded into ordinary sessions (#561 part 3): a session starts worktree agents itself with `start_agent`, works
with them through `agent_session`, and removes an idle child with `agent_session` `delete`. The parent decides in every preset; local work is
set aside with the trashed session before removal (#608). A former manager is an ordinary `reader` that owns the worktree sessions it held (store v48).

The matrix below is checked against `profileAllows` and `toolDefsFor` by a test
(`sessions/tool-matrix.test.ts`), so adding a tool or moving one between profiles fails until this
table says the same. "yes" means the session sees the tool and its calls run; "—" means the tool
is not listed for it and a call by name is refused (`Not a tool of this session`).

<!-- tool-matrix:start -->
| Tool | orchestrator | scoped | builder | reader | none |
|---|---|---|---|---|---|
| `update_centralu` | yes | — | — | yes | — |
| `list_sessions` | yes | yes | — | — | — |
| `read_session` | yes | yes | — | yes | — |
| `send_to_session` | yes | yes | — | — | — |
| `recall` | yes | — | — | yes | — |
| `app_guide` | yes | — | — | yes | — |
| `update_session_settings` | yes | — | — | — | — |
| `create_project` | yes | — | — | — | — |
| `create_session` | yes | — | — | — | — |
| `propose_skill` | yes | — | — | — | — |
| `propose_mcp_server` | yes | — | — | — | — |
| `check` | — | — | yes | — | — |
| `create_app` | yes | — | — | — | — |
| `ask_project` | — | — | — | yes | — |
| `start_agent` | — | — | — | yes | — |
| `agent_session` | — | — | — | yes | — |
| `find_apps` | — | — | — | yes | — |
| `attach_app` | — | — | — | yes | — |
| `detach_app` | — | — | — | yes | — |
<!-- tool-matrix:end -->

A reader's `read_session` without an id lists its project's sessions; that is why it has no
`list_sessions`. Its read tools see only its own project (`orchestratorToolsFor(…, ownProject)`), and
the object behind them refuses directing calls (`readerToolsFor`).

An ordinary reader's `update_centralu` reaches the host's existing update service only after a host-owned consent card. “Always”
lasts for that session while this host runs; it is not a project grant and it never changes the person's
automatic-update preference. In the commands tier the orchestrator reaches it through `centralu_run`, while the
reader is offered its compact definition, deferred behind tool search on Claude because updates are rare.

**The rare-commands tier** (#512, the default since 2026-10-12). The matrix is drawn for
`CC_RARE_COMMANDS=resident`, where every command is a tool. By default (`CC_RARE_COMMANDS` unset, or
`commands`) the host takes the orchestrator's
`create_app`, `propose_skill` and `propose_mcp_server` out of its tool list
and gives it `centralu_commands`, `centralu_help` and `centralu_run` instead; no other seat changes. Who
may run what does not change: `centralu_run` lists and runs only the commands `profileAllows` gives the
seat (`commandsFor`), a command's own name is refused like any tool the seat was not shown, and a run is
checked against the command's own schema before it goes through the same runner, so each command keeps
its gates and its card (the screen re-reads both proposal lists on a `centralu_run` it cannot name). The
three are Centralu tools (`mcp__centralu__*`), allowed under every preset like the rest.
`sessions/command-tier.test.ts` checks, profile by profile, that the tier changes how a seat reaches a
command and never which commands it reaches. `CC_RARE_COMMANDS=deferred` keeps the three as tools and
defers them behind Claude's tool search, which changes nothing here. The measurement is in
[tool-cost.md](tool-cost.md) §9.

Apps are separate from this profile. Decision 4 ([apps.md](apps.md) §9.1) gives the orchestrator the
user-folder apps, a project's sessions that project's apps, and a builder its own app
(`givesApp` in `sessions/session-apps.ts`); a reader adds others with `attach_app` (§9.4). An agent an
app started gets none (`appsFor`).

### When the person is asked

"Open" means the calling session's own `auto` preset opens that permission boundary (#603),
read at call time by `SessionManager.autoBoundaryOpen`; auto allowances are logged, without
writing remembered consents. Tool profiles, same-project scope, valid inputs, app sharing,
and the target's own preset still apply. Global bypass under `normal` does not open host boundaries.
"Allowed" runs without a card, "asks" raises a card in the calling session, "refused" fails the call
without asking. "Bypass" is the person's own global setting (`defaultMode: "bypassPermissions"` in
`~/.claude/settings.json`; `approval_policy = "never"` in `~/.codex/config.toml`), which only the
`normal` preset reads.

| Call | Claude `safe` | Claude `normal` | Claude `normal` + bypass | Claude `auto` | Codex `safe` | Codex `normal` | Codex `normal` + bypass | Codex `auto` | Enforced in |
|---|---|---|---|---|---|---|---|---|---|
| A Centralu tool the profile has | allowed | allowed | allowed | open | allowed | allowed | allowed | open | Claude: `canUseTool`, `isOrchestratorTool` and only when the session was given the server, checked before auto's refusal (`adapters/claude/index.ts`). Codex: `default_tools_approval_mode: 'approve'` on the bridge, and an elicitation for it accepted only on a thread that has it (`adapters/codex/index.ts`, `mcpConfig`, `onServerRequest`) |
| A Centralu tool the profile does not have | refused | refused | refused | refused | refused | refused | refused | refused | `profileAllows` (exposure and execution) |
| `ask_project`, first time for a pair of projects | asks (consent card) | asks | asks | open | asks | asks | asks | open | `ensureProjectAccess` in `SessionManager.askProject`; "always" is kept in `project_consents` |
| `ask_project` from a session that was itself asked | refused | refused | refused | open | refused | refused | refused | open | `askProject` (depth one) |
| `ask_project` from an untrusted project | refused | refused | refused | open | refused | refused | refused | open | `askProject` (the caller's project trust, #382) |
| `ask_project` into an untrusted project, first time for the pair | asks (the card says it is not trusted) | asks | asks | open | asks | asks | asks | open | `ensureProjectAccess` (`to.trusted`), `projectAccessQuestion` |
| `start_agent`, first time for a session | asks (consent card: once, always for this session, always for this project) | asks | asks | open | asks | asks | asks | open | `ensureAgentConsent` in `SessionManager.startAgent`; "always for this session" lives while the host serves it, "always for this project" is kept in `project_consents` (kind `agents`) |
| `start_agent` from a session that was itself started or asked (`askedBy`) | refused | refused | refused | open | refused | refused | refused | open | `startAgent` (depth one; `askProject` refuses the same sessions) |
| `start_agent` from an untrusted project | refused | refused | refused | open | refused | refused | refused | open | `startAgent` (the project's trust, #382) |
| `start_agent` past 4 running children in the project, default setting | refused | refused | refused | open | refused | refused | refused | open | `agentCeilingError` (`prefs.agentCeiling`; empty: auto unlimited, otherwise `AGENT_CEILING`; 0: unlimited) |
| `agent_session` on a session the caller did not start | refused | refused | refused | open | refused | refused | refused | open | `agentSession` (same project in every preset; ownership opens under auto) |
| `agent_session` delete, an idle worktree child with uncommitted changes or commits absent from the trunk | allowed | allowed | allowed | allowed | allowed | allowed | allowed | allowed | `cleanUpWorktreeChild` (#608): the parent decides; patches and bundles follow the session into the trash before the worktree and branch are removed. Working children are refused; an idle process must be disposed successfully first. |
| `agent_session` send, to a child the person raised above the caller's preset | refused | refused | refused | refused | refused | refused | refused | refused | `agentSession` (`presetWithin`) |
| `create_project` (the orchestrator makes a new project, empty or a clone) | asks (a card with the full path and, for a clone, the repository, every time) | asks | asks | open | asks | asks | asks | open | `SessionManager.createProjectAsked` → `askHost`; the folder is made only after "Create", and never over anything already there (`projectFolderTarget`, `makeProjectFolder`); by default in `~/Centralu`, a folder of the home that macOS does not protect, so making one raises no OS permission prompt (the Desktop did); a clone takes https, ssh and scp-like addresses only, never `ext::`, `file://` or a local path (`gitSourceError`), clones no submodules and never asks for a sign-in (`project-clone.ts`) |
| `attach_app`, another project's shared app, first time for the pair | asks (consent card) | asks | asks | open | asks | asks | asks | open | `AppAccess.attach` → `ensureProjectAccess(…, 'apps', …)` |
| `attach_app`, an untrusted target project's shared app | refused | refused | refused | open | refused | refused | refused | open | `AppAccess`, `SessionAppsHub` and runtime startup/call gates use the caller's preset; auto does not mark the project trusted |
| `update_centralu`, first time in an ordinary session | asks | asks | asks | open | asks | asks | asks | open | `updateCentraluAsked` → `askHost`; other presets keep session-only remembered consent |
| Claude's independent-session discovery and messaging | refused | refused | refused | open | — | — | — | — | Claude adapter `withoutCrossSessionMessaging`, applied only outside auto |
| `attach_app`, a user-folder app | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `AppAccess.attach` (no card: the person's own folder) |
| `find_apps` / `attach_app` from an untrusted project | refused | refused | refused | open | refused | refused | refused | open | `AppAccess.gate` |
| An app tool the app marks `readOnlyHint` | allowed | allowed | allowed | open | allowed | allowed | allowed | open | Claude: `canUseTool`, `appToolOf` + `SessionApps.readOnly`. Codex: per-tool `approval_mode: 'approve'` (`mcpConfig`) |
| Any other app tool | asks | asks | allowed | open | asks | asks | allowed | open | Claude: the card in `canUseTool`; bypass and auto never reach it. Codex: `appApprovalModeFor` (`prompt`, `writes`, or `approve` when the person's policy resolves to `never`) |
| The agent's own tools (commands, edits) | asks, reads run | the person's settings | allowed | open | asks, reads run | the person's settings | allowed | open | `permissionOptionsFor` in each adapter |

Rows that differ by session:

- **The orchestrator and coordinators** read no settings files, but under `normal` they follow the
  person's bypass on both CLIs (owner decision 2026-10-11, #382). On Codex `~/.codex` loads, so the
  person's `approval_policy` applies. On Claude (`settingSources: []`) only the person's own
  `defaultMode` is carried, read from the user tier with the SDK's merge engine
  (`personsDefaultMode` in `adapters/claude/index.ts`); their `CLAUDE.md`, hooks and rules stay out,
  and a mode written in the orchestrator's own folder does not count. The direction is decision 1's:
  the person's global choice applies to every session that runs under `normal`, and someone who wants
  a card from the orchestrator has `safe`.
- **An agent an app started** (`run_agent`, `SessionManager.runAppAgent`) is `safe` whatever the
  calling session uses, has no Centralu server and no apps. Reads run; everything else asks.
- **A session `ask_project` addresses** already exists and keeps its own preset, tool and project
  trust. The caller's `auto` skips host consent; it does not raise the target's permissions. Depth
  one applies during a delegated task under `safe`/`normal`; the target's own `auto` opens that gate.
- **A session `start_agent` started** (#561) runs in the caller's own folder under **the caller's
  preset**, so it never has more than the session that asked for it: `safe` stays `safe`, `normal` reads
  the person's own settings as the caller does, `auto` stays `auto`. No argument sets it and no tool of
  the caller changes it afterwards; the person may, and a child raised above the caller no longer takes
  work from it. Its approvals stand as cards in its own session. It holds the reader set but cannot start
  agents or ask a project under `safe`/`normal` (depth one); `auto` opens both.
- **A builder's `check`** starts its app and runs the app's code without a card, under every preset,
  like any Centralu tool. This is intended (owner decision 2026-10-11, #382): the builder is the
  session writing that code, so a card for running it would ask the person about the builder's own
  last edit, and every edit already went through the builder's own approvals. Builders exist only in
  trusted projects and the user folder, whose apps run anyway once trusted, and `check` reaches its
  own app only (`builder` profile), never another.

The **Codex `normal` + bypass** cell follows the person's policy, as Claude's does (owner decision
2026-10-11, #382). With `writes`, the person's `approval_policy = "never"` turned "needs approval"
into a refusal ("requires approval, but approval policy is never", codex source `mcp_tool_call.rs`).
So under `normal` the adapter asks Codex for the policy before it loads the app bridges
(`config/read`, `personsApprovalPolicy`) and gives them `approve` when it resolves to `never`, `writes`
otherwise. Which layers count follows what the thread loads, measured with codex-cli 0.160.0 in a
scratch `CODEX_HOME` (the person's policy and a repository's `.codex/config.toml` set to opposite
values): `config/read` without a folder returns the person's layers only, and with the folder adds the
repository's only when Codex trusts that folder, as `thread/start` does. A session whose repository
files are kept out (an untrusted project, the orchestrator, coordinators) reads without the folder, so
a planted `.codex/config.toml` cannot turn its app tools into `approve`. The thread's own
`approvalPolicy` is compared afterwards and a difference logged. The refusal itself is still from
Codex source, and no logged-in app call was run.

### Turning things off

The table describes `safe`/`normal`. Under `auto`, project trust and revoked remembered
consents do not close delegation or attachment; the session's preset is checked on each call.
Auto attachments are recorded separately from consent grants and stop counting after a preset
downgrade. The session-tools switch and app-sharing switch still apply to every preset.

| Change | orchestrator | scoped | builder | reader |
|---|---|---|---|---|
| "Let sessions look at their own project" off | — | — | — | Becomes none. Calls refused at once (`readerToolsFor`; the bridge through `toolProfileOf`); apps it attached leave at once (`onDemand.allowed` in `useExternalApps`, recounted by `setUiPreferences`). Ones allowed "once" are forgotten (`AppAccess.dropOnce`); the rest come back if it is turned on again (#382); the schemas leave Claude at the next start |
| Its project loses trust | No change (reads no project files) | No change (reads no project files) | Its app stops, so `check` cannot start it | Settings files at the next start; its project's apps stop and leave at once; `find_apps` and `attach_app` refused; apps it attached leave at once. `ask_project` and `start_agent` refused (#382, #561) |
| The other project loses trust | — | — | — | Apps attached from it leave at once; `ask_project` to it still runs, its card says it is not trusted, and the existing target session follows its trust |
| The person revokes a pair in Settings | — | — | — | Apps attached under "always" leave at once; the next `ask_project` or `attach_app` asks again; for a project's `agents` row, the next `start_agent` asks again (a child already running is left to finish) |
| Sharing of an app turned off | — | — | — | Leaves every session that attached it |

## Tool output in the store

The store keeps every tool call whole ([#221](https://github.com/ijun17/centralu/issues/221)): the call's raw
`input` (a Write's content, an Edit's both sides, a command with its options) and the result's whole `output`. It used to
keep only the card — the first 300 characters of a Claude result, 2,000 of a Codex one, a file edit's path — and the
full text lived only in the tools' own files, which Claude Code deletes after 30 days without activity. That record now
outlives the tool's cleanup. It also means **secrets a tool printed stay in the store for as long as the session does**,
instead of for as long as the tool keeps its file; deleting the session for good (FR-22) is what removes them.

That record does not move the boundary of [#73](https://github.com/ijun17/centralu/issues/73): full tool output from
one session reaching another session's prompt is the privilege path it closed. So the record stays in the store:

- **Readers get the card unless they ask for the record by name.** `Store.loadMessages` and `loadMessagesFrom` drop
  `input` and `output` in SQLite (`json_remove`) unless called with `{ full: true }`, and nothing calls them that way
  yet. Every reader that hands stored messages to someone else goes through them: `read_session`, `recall`'s context,
  `list_sessions`' preview and the report-back, the handoff record and handoff note, the orchestrator's memory, an app
  agent's final answer, the UI's history pages (`messages.load`, `trash.read`). Each of these also names the fields it
  copies (`summary.title`, the string `summary`, `text`), so a leak would take both layers failing.
- **Events leave the host as their card.** `withoutToolRecord` is applied where every event leaves `SessionManager`,
  before the WebSocket broadcast, its reconnect buffer and the in-process app observers.
- **The search index holds none of it.** Only what the person and the agents said, and the agents' reasoning, are
  indexed (`INDEXED_KINDS` in `store.ts`) — not tool calls, and not their output — so neither `recall` nor the palette
  can find a session by what a command printed, or by the command.

Tests: `manager.test.ts` ("a tool call is kept whole in the store and leaves it only as its card") puts secrets where
the card does not reach and looks for them in the broadcast, the history and trash pages, `read_session`, `recall`,
search, `list_sessions`, the handoff record and file, and the orchestrator's memory; `store-tool-record.test.ts` holds
the store's default read and the index.

### A subagent's steps

What a native subagent did — Claude Code's `Agent` tool, Codex's `spawn_agent` — is kept too
([#222](https://github.com/ijun17/centralu/issues/222)): its text, its readable reasoning, and its tool calls and
results whole, the way #221 keeps the parent's. About a third of all Claude tool calls happen inside subagents
(measured for #222: 20,107 of 59,734), so this is where most of a tool's printed output lands. The same rule applies,
with one more layer:

- **They are not the conversation.** The steps live in a table of their own (`subagent_messages`, store v41), keyed by
  the session and the launching call, and the only reader is `Store.loadSubagentMessages`, which names one launch card.
  Every reader listed above reads `messages`, so none of them can hand a subagent's tool output — or its words — to
  another session's prompt, count it as unread, or take it for the parent's last answer (the handoff note).
- **The screen gets cards.** `loadSubagentMessages` drops `input` and `output` like `loadMessages` does, and the live
  `subagent_event` is stripped by the same `withoutToolRecord`. The subagent's text and reasoning do go to the screen
  that opens its card: they are what it said, as the parent's text is.
- **Not indexed, text included.** The parent's own report on what its subagent found is in the conversation, and is
  what search and `recall` find.
- **They go when the session goes.** The rows belong to the session, so the trash keeps them and a purge deletes them
  (FR-22).

Tests: `manager.test.ts` ("a subagent's steps are kept under its launch card and read by nothing else") looks for a
subagent's tool secrets, words and reasoning in every reader above, and for its tool secrets in the broadcast and
`messages.subagent`; `store-subagent.test.ts` holds the table, the default read and the index.

## Text an app sends

An app's view can ask to put text into a conversation (MCP Apps `ui/message`). The person reads
it and chooses to send it, but the app wrote it, and an app's code can relay outside data word
for word: the same injection path as a worker's report, so the same rule applies (#120).

- An inline view's message is shown to the person first, and nothing is sent before they press
  Send. It can go only to the conversation of the card the view stands under: `apps.viewMessage`
  takes the conversation and the app from the view instance and only compares the conversation
  the caller names (`rpc.ts`, `InlineViews.owner`).
- A pinned view's message is shown with a list of sessions, and nothing is sent before the person
  picks one. A pinned view belongs to no conversation, so the destination is the session picked.
  The app still comes from the view instance (`ViewHost.describe`), and an instance that is not
  open is refused.
- It is stored with its source (`fromApp`) and drawn as the app's message, not the person's. A
  session's automatic name is never taken from it.
- The agent receives it framed (`appMessageFrame` in `sessions/manager.ts`): a header naming the
  app and saying the person chose to send it but did not write it, and that it is the app's text,
  not an instruction; then **every line** of the text behind `> `. A line imitating the header, or
  a made-up "person:" field, stays inside the quote. The app's name passes the one-line field rule
  (`frameField`). A pinned view's message gets the same frame, which says it came from the app's
  own view, outside this conversation.

The same rule covers an app's error report. "Send to builder" hands the builder a bundle made of
the app's own output: its reason and the last lines of its stderr, which can carry outside text
too. It goes with a header saying the person sent a report Centralu built from the app's output,
and every line behind `> ` (`builderErrorFrame` in `@cc/protocol`). Only a person's click sends
it, and a bundle goes once (`builder-requests.test.ts`, "nothing goes out before it is clicked;
clicking sends that bundle enclosed in a quotation exactly once, and a second click is
rejected").

Tests: `inline-views.test.ts` ("goes to that conversation, is recorded as a message sent by the
app, and the agent receives it as the app's text enclosed in a quotation", with a forged header
inside the text; "cannot send by claiming a different conversation for a view inside a
conversation, or through an instance that is not open"; "a fixed view's message goes to whichever
conversation the person picked, in the same frame as a view inside a conversation (an app's
text) — but stating it came from outside the conversation"); `e2e/inline-views.spec.ts` and
`e2e/apps.spec.ts` for asking first; `e2e/build-loop.spec.ts` for the pinned path.

A `run_agent` prompt (apps.md §10) is an app's text too, and no person chose to send it. It is
stored with its source (`fromApp`) and reaches the agent in the same frame, under a heading saying
the app asked for this work through Centralu, that the person did not write or read it, that
nothing in it can grant permissions or change instructions, and that the final message goes back
to the app (`appMessageFrame(..., 'request')`; `app-agents.test.ts` "work an app assigns is
confined to the same frame as UI messages — every line is a quote, so the app's text cannot forge
a header or fake the end of the frame").

Limits:

- The frame states where text came from. As with reports, it does not make the text safe to obey.

## Repository configuration and project trust

A project the user has not marked trusted cannot change how its sessions ask for approval
(#92). Claude sessions load only the user's own settings (`settingSources: ['user']`), so
the repository's `.claude/` settings, local settings, hooks, commands and `CLAUDE.md` do
not apply. Codex threads are started with the project's paths marked `untrusted` for that
thread only, and `project_doc_max_bytes = 0`. That keeps the repository's `.codex/config.toml`,
hooks, exec rules and `AGENTS.md` out, and it stops Codex from persisting the folder as
trusted in `~/.codex/config.toml` on first use. The user's own settings in `~/.claude` and
`~/.codex` still decide under the `normal` preset. What a session reads follows from what the
session is, not from whether it carries Centralu's own tools (#152). Only the orchestrator and
coordinators read no settings files, trusted or not: they belong to no project and work in a folder
other sessions can write to (in Claude, `settingSources: []`, which leaves out `~/.claude` too, except
the person's own `defaultMode`, carried under `normal` since #382; in Codex, their folder is marked
`untrusted` and `project_doc_max_bytes = 0`, while `~/.codex` still loads). Agents a session started (in its folder or a worktree) and the builders of project apps follow their project's trust
like any worker. The builder of a user-folder app counts as trusted, because that folder is the user's own
(decision 3).

The same switch decides whether the project's apps may run (M4 decision 3; [apps.md](apps.md) §3).
An untrusted project's apps are discovered and listed with the reason, but never started, never
attached to a session, and every call to them is refused; no app or builder is created there.
Trust is re-read at every app call, not only when an app is attached (`runtime.ts` `call`,
`session-apps.ts`; tests "an app in an untrusted project never starts even when a request
arrives", "turning off trust immediately stops a running app", "a call after trust is lost is
blocked — checked again on every call, not only when it attached").
What this closed was measured with the real CLI (#152, `scripts/probe-project-trust.mts`, CLI
2.1.282): a committed `settings.json` allow rule was already ignored by the CLI; the holes were
`settings.local.json` allow rules and a project hook answering "allow", which turned the approval
card off even under `safe`.

How projects get trust: a project registered now starts untrusted, and the sidebar asks once when
it is added. The `trusted` column arrived untrusted by default (store v33); v35 then marked every
project that existed at that moment as trusted, once, so an update did not silently start ignoring
the `.claude/` settings of folders the user had chosen and worked in. v35 does not run again, so
trust turned off later stays off.

Limits:

- Trust is read when a session's tool process starts. Changing it affects running sessions'
  repository settings at their next restart or resume. Apps follow at once: a project that loses
  trust has its running apps stopped and detached immediately.
- Projects that existed before v35 were trusted without being asked.
- Codex still loads repository skills (`.codex/skills`, `.agents/skills`) in untrusted
  folders. They are instructions only; whatever they lead the model to do still passes approval.
- The Codex behaviour is verified from Codex source and the installed binary's strings, not
  by a logged-in run.

### Git before trust (#407)

A folder copied from somewhere (a zip, a shared drive) carries its own `.git/config` and
`.git/hooks`, and plain git reads run several of the programs named there. Measured against a
planted copy with git 2.54: `status` runs `core.fsmonitor`, the clean filter of each file whose stat
data no longer matches the index, and the `post-index-change` hook when it rewrites the index;
`check-ignore` and `ls-files` run `core.fsmonitor`; `diff` and `show` run textconv drivers and smudge
and clean filters; `log` and `show` run `gpg.program` on a signed commit when `log.showSignature`
is set; `worktree add` runs `post-checkout`, `reference-transaction` and smudge filters. The host
reads a project as soon as it is added (`projects.list` asks for its branch and change count), so
every one of these was reachable before the person answered the trust question.

**Before a project is trusted, no git read the host makes runs a program the repository chose.**
Every git the host starts goes through `runGit` (`dev-services/git-exec.ts`); `git-exec.test.ts`
fails if any other source starts git. A read for an untrusted project gets:

- `--no-optional-locks`, so the index is not rewritten and the folder is left as it was found;
- `-c core.hooksPath=<null device>` (`/dev/null`, or `\\.\nul` on Windows), under which no hook
  can exist;
- `-c core.fsmonitor=` (empty reads as off in every git; `false` is a boolean only from 2.36);
- `-c log.showSignature=false`, so no signature is verified and `gpg.program` never starts;
- for every filter driver git would see in that folder (listed first with
  `git config --get-regexp '^filter\.'` under the same flags, so `include.path` and `includeIf`
  resolve exactly as for the read), `clean`, `smudge` and `process` set to no command and
  `required` to false. The user's own drivers (Git LFS) are turned off too;
- `--no-textconv --no-ext-diff` on `diff`, `show` and `log`, and `--ignore-submodules=all` on
  `status` and `diff`: a submodule has its own config, whose drivers were not listed.

Command-line configuration outranks every configuration file and is handed to the git processes
git starts itself, so an included file or a nested call cannot undo it. The reads this covers are
the change count and branch (`projects.list`, `projects.gitStatus`, the app broker's status),
`git.status`, `git.diff` (tracked and untracked), `git.log`, `git.commitDetail`, `git.branches`,
`git.ignoredEntries`, the `git.checkout` dry run, the file tree's `check-ignore`, file search's
`ls-files`, a project app's version history, and the worktree dirty check. A worktree session
cannot be started in an untrusted project at all: checking out runs the repository's filters and
hooks by design, turning them off would leave files they never converted (an LFS pointer, a
git-crypt blob) for the session to edit and commit back, and `--no-checkout` would leave an empty
folder. The manager refuses with the reason, and `gitWorktreeAdd` refuses too unless told the
project is trusted.

What a read still does before trust: it reads the repository's files, its configuration and any
file that configuration includes, and `core.excludesFile`. It does not start a pager (stdout is a
pipe) or an editor, and it does not touch the network, so `core.sshCommand` and
`credential.helper` are never read. `safe.directory` is left to git: git honours it only from the
user's own and the system configuration, and the host never sets it, so a folder owned by another
user is refused as it would be in a terminal.

A trusted project's reads run as plain git does (fsmonitor stays on for the checkout dry run and
the worktree dirty check, which can otherwise approach the 10-second limit on a large repository).
`git.log` runs locked for every project; the signature check it skips only printed into output
the parser never read. Tests: `git-untrusted.test.ts` runs each read against the planted copy and
requires no marker, with the same read for a trusted project as the control; `manager.test.ts`
"runs none of the repository's programs before project trust, through every door that reads it".

Limits:

- **Writes the person asks for run as plain git does, trusted or not.** Stage runs clean filters;
  commit runs `pre-commit`, `commit-msg` and `post-commit` and may sign with `gpg.program`;
  switching branches runs `post-checkout` and smudge filters; push runs `pre-push`, credential
  helpers and `core.sshCommand`. Turning filters off would change what gets committed, so these
  are not locked; they happen only on the person's click.
- Before trust, status does not look inside submodules. The untrusted worktree dirty check counts
  each submodule as a change, so a removal asks first.
- Before trust, a file under a clean filter (Git LFS) whose stat data changed shows as modified,
  and diffs show raw content without textconv.
- A filter driver whose name contains `=` cannot be named in `-c`; the read is refused instead.
- The driver list is read just before the read. Something that changes `.git/config` in between
  is already running on the machine.
- The Windows null-device hooks path is covered by the Windows CI job running these tests; no
  person has run it on a Windows machine.

## Local transport

The host listens on loopback and requires a token that is not blank — whitespace-only is
refused at construction, matching the trim the browser entry point already applies.
Browser/WebView connections must additionally match the explicit origin allowlist, which
`CC_HOST_ALLOWED_ORIGINS` (comma-separated) replaces when set. A client without an Origin
header still needs the token; Origin is a browser defense, not native-client identity.
Literal `Origin: null` is rejected. A rejected upgrade is logged by the host, because the
browser does not hand the 403 to the page. Development tokens should be generated per launch and shared
only with the intended local client. Mock/demo modes do not connect to the host.
A socket that has not sent a valid hello within 10 seconds is closed, and a socket whose undrained
outbound backlog passes 64 MiB is cut, so a connection cannot make the host hold unbounded memory or
an endless slot (#82; `transport/server.ts`, `TRANSPORT_LIMITS`). An authenticated socket's hello is
answered once; a repeat is ignored. A hello may carry a Codex bridge's credential instead of the token
(#382, "The front door" below); that socket receives no events and may call only its own session's
bridge RPCs.

## The remote host (`centralu serve`, #82)

A host started with `centralu serve` on another machine is reached by the app through an SSH local forward
([agent-host.md](agent-host.md) §4.7). The boundary is the one above, unchanged: loopback binding and the token.

- **Nothing listens on a public interface.** The host binds 127.0.0.1 on the remote; the forward binds 127.0.0.1 on
  the person's computer. Reaching the host takes an SSH login to that machine as that user, so SSH is what
  authenticates the person and encrypts the link. Centralu adds no listener, no TLS and no login of its own.
- **The token** is 32 random bytes in `<data folder>/serve.json`, created with mode 0600 (never written wider and
  narrowed later) and set back to 0600 whenever `serve` finds it wider. It is printed only by
  `centralu serve --connection`, which the client runs over SSH; the host's ready line, which also carries it, is read
  by the launcher and passed on to nothing. It reaches the host in the environment (`CC_HOST_TOKEN`, readable only by
  the owner), not on the command line, which every user on the machine can read with `ps`. It does not change across
  restarts until `--rotate-token`.
- **Other users on the remote machine** can connect to 127.0.0.1 like anyone local, and are stopped by the token, as on
  a desktop. A machine where another user can read your files (root, or a wrong home-folder mode) can read the token;
  the remote mode is for a machine the person trusts, and the spec says so (product-spec.md §1.5).
- **Single trusted user.** One host per data folder (the ownership lock), one person's sign-ins. There is no
  account model and no sharing between people.
- **Headless.** The host starts without `DISPLAY` / `WAYLAND_DISPLAY`, so nothing it starts can raise a window or a
  keyring prompt on that machine.
- **What the client must not do:** forward with a wildcard bind address (`-L 0.0.0.0:…`) or `GatewayPorts`, which
  would expose the host's port on the client's network with only the token in front of it.

## The keeper's control socket

The keeper (`centralu-keeper`, #280, #440) is a new trust boundary: through its socket a process can read the front
door's port and token, stop the host, and make the keeper run a host from another folder (`switch`). The rule is the same
as for the token itself, which only this user can read: **only this user's processes get in.**

- The socket is `<data>/keeper.sock`, created under `umask 077` so it is born `0600`, with no window before a chmod.
- Every connection's peer uid is read from the kernel (`getpeereid` on macOS, `SO_PEERCRED` on Linux) and the
  connection is dropped unless it is the keeper's own uid.
- A request line is capped at 256 KiB, and a connection that sends nothing in 5 seconds is closed (except an
  attach, which is held open on purpose).
- `keeper.json`, `keeper-settings.json` and `keeper.log` are written `0600` and hold no token. The host's stderr goes
  to `keeper.log` as well as `host.log`; the host never writes its token to stderr.
- Per-build copies live in `<data>/hosts/` (folders created `0700`). A build key is limited to
  `[A-Za-z0-9_-]`, so a commit string cannot name a path outside that folder.

Limits:

- `switch` runs `main.mjs` from whatever host folder the request names. Any process of this user can therefore make
  the keeper run code of its choosing — which that process could do by itself anyway. It is not a privilege
  boundary between processes of the same user, and is not meant to be one.
- `relaunching` (#352) keeps a keeper with no window running for at most 300 s, whatever background mode says. It
  grants nothing `set_background` does not already, and only for a bounded time.
- The socket is local only. Windows has no keeper yet (named pipes and their ACLs are not written).

### The front door

Under the keeper, clients connect to the keeper's **front door** (#280 step 3), which relays bytes to the current
host. It changes where a client connects, not what it must prove:

- It listens on **loopback only** (`127.0.0.1`), on a port chosen when the keeper starts. Any process on this
  machine can open a TCP connection to it, exactly as it could to a host before. The door adds no authentication of
  its own and checks nothing: every byte goes to the host, which still requires the token in `hello` and still
  applies the `Origin` rule to the browser's own header (the relay passes the upgrade request through unchanged).
- **The token is the keeper's**, 16 random bytes from `/dev/urandom`, one per keeper lifetime. It reaches clients
  only through the user-only control socket, and hosts only through their environment (`CC_HOST_TOKEN`). The host
  deletes it from its environment once read, so terminals, agents, commands and app processes do not inherit it;
  app processes never received `CC_*` variables anyway. It is never written to `keeper.json`, `keeper.log` or
  `host.log`.
- **Deleting it hides it from children only, not from other processes of the same user.** Measured on macOS 27.0.1
  (build 26A434, 2026-10-11): a node process started with `CC_PROBE_SECRET=<marker>` deleted it from `process.env`
  at once and set another variable afterwards. From a separate process of the same user, started with an empty
  environment (`env -i`), `ps eww -p <pid>`, `ps -E -ww -p <pid>` and a `sysctl` read of `KERN_PROCARGS2` (2,164
  bytes back) all printed `CC_PROBE_SECRET=<marker>`; the variable set after start appeared in none of them. The
  same `sysctl` for pid 1, a root process, failed with `EINVAL`. So what a process is started with stays readable
  to every process of its user for as long as it runs; on Linux `/proc/<pid>/environ` is the same initial block
  (not measured here). The host's own initial environment holds the token, and the control socket's `status` hands
  it out, both to this user only: the token is not a boundary between processes of the same user, and does not try
  to be one.
- **The Codex bridge gets a credential of its own, not the token** (#382, owner question 4, decided 2026-10-11).
  Codex starts the bridge with the front door's address and `CC_BRIDGE_TOKEN`, an HMAC of the bridge's session id
  keyed by the token (`transport/bridge-token.ts`, `bridgeAddress`). Before this the bridge held the token itself,
  so a command a session ran could take it from the bridge's environment as measured above and call every RPC:
  set its own preset to auto (`agents.updateSettings`), trust a project (`projects.setTrusted`). A socket that says
  hello with a bridge credential is not a client: it gets `hello_ok` and nothing else (no replay, no broadcast, no
  terminal output), and may call only `orchestrator.tools`, `orchestrator.tool`, `apps.sessionTools` and
  `apps.sessionCall`, each naming the credential's own session (`bridgeRefusal`); everything else is refused before
  it reaches the handler (`server.test.ts`, `app-bridge.test.ts`). Because it is derived from the front door's token,
  the next host after a swap accepts it with nothing handed over or stored, and a running bridge keeps working
  (`scripts/keeper-integration.mjs`, the swap scenario). What it still opens is that session's own Centralu tools and
  attached apps as that session, gated by the session's profile like the session's own calls; a process that reads
  an orchestrator's bridge gets the orchestrator's set. It is valid for the keeper's lifetime. This takes the token
  out of the one process that held it for a session; per the bullet above, the token itself stays within reach of
  the same user.
- A stable token is a longer-lived secret than a token per host. It lives as long as the keeper, which is as long as
  the agents it serves; a keeper restart makes a new one, and a keeper update (step 4) passes the
  same one on to the new keeper over the handoff channel below.
- While no host is ready, the door holds a connection up to 45 s before closing it, so an unauthenticated
  connection costs at most a socket and a thread for that long; after a host is up, the host's own handshake
  timeout (10 s) applies.

### The keeper's child socket

The keeper also holds the host's agents, terminals and commands (#280 step 2) and serves them on a second socket,
`<data>/children.sock`. Through it a process can start a program with the arguments, folder and environment of its
choosing, read and write an agent's stdin and stdout (its whole conversation, approvals included) or a terminal, and
signal any child the keeper holds. The rule is the keeper socket's: **only this user's processes get in.**

- Created under `umask 077`, so it is born `0600`; every connection's peer uid is read from the kernel and the
  connection is dropped unless it is the keeper's own uid.
- A control line is capped at 16 MiB (a spawn carries a whole environment); a host's input to a child is queued up
  to 8 MiB before the keeper stops reading it; a control connection that stops reading its events is dropped past
  8 MiB.
- `signal` takes only TERM, KILL, INT, HUP, QUIT, USR1, USR2 and WINCH, never pid 1 or below, and is a no-op for a
  child that has exited, whose pid may already belong to someone else.
- Children start in their own session, with the environment the host passed. The host takes `CC_KEEPER`,
  `CC_HOST_SOURCE`, `CC_HOST_TOKEN` and `CC_FRONT_DOOR` out of its own environment before it spawns anything, so no
  child inherits the front door's token.
- The keeper stores each child's tag and parses nothing in it, and parses nothing a child says.

Limits: as with `switch`, spawning lets any process of this user run a program — which it could do by itself — and
reading a held agent's stream lets it read what that agent says, which the same user could also read from the
agent's own transcript. It is not a boundary between processes of the same user. It is local only; Windows has no
keeper.

### The keeper handoff channel

A keeper update hands everything the keeper holds to the new build's keeper (#280 step 4,
[architecture.md](architecture.md) §4.4): through that channel go the front door's token, every
agent's and terminal's descriptors with their unsent output, and the listening sockets. So who can
be on the other end matters as much as on `keeper.sock`.

- The channel is one end of a `socketpair` that the outgoing keeper places at descriptor 3 of the
  process it starts itself. It has no path in the filesystem, so no other process can connect to it
  at all; there is no socket file to protect with `0600` and none to remove. The incoming keeper
  still reads its peer's uid from the kernel and refuses another user's.
- The process started is the executable named by `switch` (`keeper.exe`) or `upgrade` (`exe`):
  the app's own executable inside its bundle. Like `switch`'s host folder, any process of this user
  can name another one through `keeper.sock`, and the keeper will start it and hand it the token and
  every handle. That is no new power: the same user can already read the token from the socket and
  the agents' streams from the child socket. It is not a boundary between processes of the same
  user.
- Nothing from the channel is logged: the snapshot carries the token, and the log lines name only
  pids, counts and reasons.
- The incoming keeper proves it holds `keeper.lock` by taking the `flock` on the passed description
  before it says ready; a third keeper is refused throughout, as before.
- `CC_KEEPER_HANDOFF_HOLD_MS` makes an incoming keeper wait before it says ready. It exists for the
  integration test and changes nothing but timing.

## Signed content (#440)

With the thin shell ([plans/thin-shell.md](plans/thin-shell.md)), the keeper and the host run from a
folder outside any signed app bundle, with the permissions the person granted to the shell. The boundary
is **what may be started from that folder**: only files a release signed. The verifier is
`apps/desktop/content-verify` (shared by the shell and, on a handoff, the keeper); the writer is
`scripts/content-manifest.mts`. Its first user is the shell (`apps/desktop/src-tauri/shell`, step 3 of
the plan), which a macOS release window opens since step 4 (§10.2) when the shell it carries is the one
`shell.lock` pins; until shell v1 is pinned, no release opens it. Its second is a keeper the shell started,
which verifies the next build's content itself before handing over to it (step 5, §10.3).

- **Signature first.** `content-manifest.json` lists every file (path, size, sha256, executable bit) with
  the app version, platform and minimum shell version. `content-manifest.json.sig` is an ed25519 signature
  over the manifest's exact bytes, checked with `verify_strict` before anything in the manifest is parsed.
  The key is chosen by id (the first 8 bytes of SHA-256 over the public key) among the keys compiled in
  from `packaging/shell/keys.json` (`current` and `next`); an id that is not among them is refused.
- **The private keys** exist only as the `npm-publish` environment secrets, behind the same approval as
  the npm token. The release workflow passes `CONTENT_SIGNING_KEY` to the darwin platform job only, and
  `release-npm.mts` takes it out of its environment before starting anything. A rehearsal has no
  environment and signs with a key generated in memory, which no keys.json holds; a publish refuses to
  sign with one (`--require-content-key`) and checks its signature against keys.json before publishing.
- **Only listed files are copied, and what is hashed is what is copied.** Each path is walked one
  component at a time with `openat` and `O_NOFOLLOW` from the content folder, and must end at a regular
  file (`fstat`); a FIFO is opened non-blocking so it cannot stall the start. The file is read once:
  every chunk is hashed and written to the copy in the same step, reading stops one chunk past the listed
  size, and the size and hash must match. Unlisted files in the source are not copied.
- **Paths** are relative and `/`-separated, with no empty, `.` or `..` component, no `\` and no control
  character, and not the manifest's own names. Paths that differ only in ASCII case, and a path that is
  also the folder of another, are refused. The writer refuses the same names (one table,
  `tests/fixtures/paths.json`, tests both).
- **Into place atomically.** The copy goes into a new `0700` folder beside the destination, is read back
  and hashed again, and everything below its top is made read-only (`0444`, `0555` for executables and
  folders). The top folder is renamed onto the destination with a rename that refuses an existing one
  (`renamex_np(RENAME_EXCL)` on macOS, `renameat2(RENAME_NOREPLACE)` on Linux) and only then made `0555`,
  through a descriptor opened before the rename: macOS refuses to rename a folder its owner cannot write
  (always on macOS 14, across parents on macOS 27). In that moment only the owner can write to it, and
  only at the top; a listing after the `fchmod` refuses any name the manifest does not account for. Any
  refusal removes the copy.
- **Other refusals:** a manifest for another platform, one that needs a newer shell, an unknown `format`,
  a manifest over 16 MiB or a signature file over 64 KiB, and a version lower than the highest this data
  folder has started unless the window asks for a rollback (`version::check_not_downgrade`).

The shell adds:

- **The keys it trusts are keys.json, compiled in.** A test build can trust one more key (the integration
  test's throwaway key, given at compile time) only behind the `test-key` feature, and a build without
  `debug_assertions` refuses to compile with it (`compile_error!` in `shell/src/keys.rs`). Nothing on the
  way to a release turns the feature on: `tooling/shell-bundle.test.ts` and
  `tooling/shell-release-workflow.test.ts` check the source, the shell's manifest and the shell release
  workflow, and `scripts/shell-integration.mts` checks that a build without the feature refuses content
  the throwaway key signed. The status file says `testBuild`, so a test build
  cannot pass for a real one.
- **It starts only from the copy.** The keeper is `<data>/content/<version>/centralu-keeper` and its host
  folder `<data>/content/<version>/host`; nothing is started from the folder the window passed. A copy
  already there for that version is used only if it verifies again where it is (`verify_in_place`: the
  signature, the same manifest bytes as the source, every listed file's size, hash, read-only mode and
  executable bit, no symlink and nothing unlisted at any depth); otherwise it is removed and copied again.
  A `--content` inside `<data>/content/` is refused (as given and resolved, and arguments may not contain
  `..`), so that removal can never reach the source.
- **The data folder is the window's.** The shell does not create or migrate it; a missing one is refused.
  `shell-status.json` is written `0600` with `O_NOFOLLOW` to a temporary name and renamed.
- **Its own bytes are pinned.** The shell is built once per shell version by
  `.github/workflows/shell-release.yml` (no cache, no feature, no secret) and recorded in
  `packaging/shell/shell.lock` (zip sha256 and cdhash); `fetchPinned` (`scripts/shell-bundle.mts`)
  refuses a download whose sha256 differs, and the release refuses a downloaded bundle whose cdhash
  differs, before it puts the shell into the window (`scripts/bundle-stage.mts`). The window installs a copy
  only if its files hash to what the release recorded beside it (`shell.json`), never replaces a higher
  installed version with a lower one, never installs or opens an unpinned shell (a local build's), and opens
  the shell through LaunchServices with absolute paths only; an old `shell-status.json` cannot answer for a
  start, because the window matches it by a fresh nonce.

The keeper adds, on a handoff (step 5, [plans/thin-shell.md](plans/thin-shell.md) §10.3):

- **A keeper from verified content never starts a bundle.** A keeper whose own executable is
  `<data>/content/<version>/centralu-keeper` (resolved, so a symlinked data folder still counts) treats the
  keeper executable a window names only as a pointer to that bundle's `Contents/Resources/content`. It
  verifies that content with the same verifier and the same rules as the shell (signature against
  keys.json, platform, a listed keeper and host, the downgrade floor; not the minimum shell version, which
  the window decides), copies it into `<data>/content/<new version>/` (or reuses a copy that verifies in
  place with the same manifest bytes), and hands over to the keeper inside that copy, its host named in
  that copy too. The window's `hostDir` is never read. Its hosts run from the copy's `host/`, never from a
  copy of a bundle in `<data>/hosts/`. A content inside `<data>/content/` is refused as the source.
- **A refusal moves nothing.** The keeper and its host stay; no partial copy is left; the window is told
  the reason (`refused` in the swap view). A refused build only ever runs through the window's fallback,
  the direct start under the window's own identity (§10.2), which a person reaches with Restart completely.
- **A rollback never goes through a handoff.** A version below `<data>/content/highest-started` is refused
  on a handoff whatever the window asks; only the shell's `--rollback` lowers the floor. The incoming keeper
  raises the floor once it serves.
- **What runs is never removed under it.** A version folder the keeper runs from, a host runs from or will
  run from next, or a switch holds is never removed by the cleanup, and one that no longer verifies while
  something runs from it is refused (`in-use`) rather than replaced.
- **The keys are keys.json.** The keeper crate's `test-key` feature (`keeper/src/keeper/keys.rs`) is guarded
  as the shell's is: refused without `debug_assertions`, turned on by nothing on the way to a release
  (`tooling/keeper-executable.test.ts`). `scripts/keeper-content-integration.mts` builds the test keeper
  and puts the plain one back in the target folder before anything else runs from it.

Limits:

- Another process of the same user can change the copy after it is verified, or start whatever it likes
  with the same `node` and agent CLIs the keeper uses; the plan says so (§4). This protects against
  running content the project did not sign, a partial or corrupted update, and a file dropped into
  Centralu's folders inheriting the grants, not against the user's own processes.
- Whoever holds a signing key can sign anything; rotating means moving `next` to `current` in a new shell
  version, which is why the shell carries both.
- Windows has no verifier copy yet (`verify_and_copy` is Unix only); it has no shell either (§8).

## App servers

An app's server is code running as the user, with the user's files, network and processes. The
sandbox described under "App views" covers only its screens, and there is no process sandbox for
the server (out of scope for M4). So for a server the boundary is **whether it runs at all**, and
then who may call it:

- A project's apps start only in a trusted project (previous section). A cloned repository's
  `.centralu/apps/` does nothing until the user trusts the project, and an app that arrives later
  with `git pull` is governed by that same trust: there is no second gate for it. User-folder apps,
  approved MCP servers included, are trusted because the user put them there. An app **imported**
  into the user folder from elsewhere is not: see "Imported apps and app links" below.
- The host withholds its own environment: every `CC_*` and `CENTRALU_*` variable is removed (the
  WebSocket token is one; with it an app could call every RPC). The app receives its declared
  secrets, `CENTRALU_APP_ID` and `CENTRALU_APP_DATA` (`runtime.ts` `spawnSpec`; test "receives its
  data folder (created for it) and only its declared secrets, never the host's own variables").
- Secret values live in `app-secrets.json` (0600) and are replaced by their names in the app's log,
  run records (arguments, errors, kept failures) and error bundles (`secrets.ts` `redactor`,
  `app-process.ts` `AppLog`; test "stderr goes to the app's own log, with secret values masked by
  name"). Arguments are hashed only after redaction. The person enters values through
  `apps.setSecret`, which accepts only names the manifest declares and never returns a value: the
  app list carries only whether each declared name is set, and refusals never quote the value. A
  test looks for the value, as a string, in the app log, run records, kept failures, error bundles,
  the list, broadcasts, the host console and the RPC replies, with an app that leaks it on purpose
  (`app-secrets.test.ts` "even when the app leaks the value into stderr, a failure message, or an
  argument, only the name remains in the log, run record, error bundles, list, broadcasts,
  console, and RPC answer"). In the UI the field is a
  password field that is emptied once sent (`e2e/app-share.spec.ts`).
- Every call goes through the host, which enforces tool visibility in both directions: views reach
  only `app` tools, agents only `model` tools, and a refused call never reaches the app
  (`runtime.ts` `call`; `mediation.test.ts` "a screen cannot call a model-only tool, and a session
  cannot call an app-only tool — the call never even reaches the app"; with third-party apps,
  `e2e/public-apps.spec.ts`). The
  session side re-checks decision 4 at every call, so a detached app cannot be reached by a stale
  tool name.
- A project's session reaches another project's app only by attaching it (#371 part A, apps.md
  §9.4), and only when three things hold, each read again at every count of the session's apps and
  so at every call: the person shares that app (off by default, per app), the person allowed this
  pair of projects (a consent card in the calling session; "always" kept per pair and revocable in
  Settings, "once" for that attachment, a denial not kept), and both projects are trusted. A session
  in an untrusted project attaches nothing, so a planted AGENTS.md cannot pull another project's
  tools into it. User-folder apps attach without a card, as they are the person's own; that does not
  widen what the session could already run, since the calls follow the session's preset. The app
  still runs in its own folder with its own data, and its calls are recorded with the calling
  session (`app-access.test.ts`, `app-access-manager.test.ts`).
- The broker pipe (fd 3) is handed only to that process, so there is no token to steal. A broker
  call must carry the run id of a call the same app is handling on the same pipe; no id, an
  invented id, a finished run's id and another app's live id are all refused, logged and recorded
  without a parent, so an app cannot put rows into another app's chain (`broker.ts`;
  `mediation.test.ts` "a broker call with no run id is refused (an app waking itself up on its
  own)", "a made-up id, a finished run's id, and another app's live id are all refused";
  `broker-records.test.ts`). Broker work is
  cancelled with the call it serves, down to an agent session it started.
- What an app may ask the broker for is declared in its manifest's `uses`, and the person allows
  each capability once (an agent tool, another app, a host data name), asked where the chain
  started; the answer is kept until `uses` changes and can be forgotten. Undeclared or unanswered
  requests never run (`desk.ts`; `capabilities.test.ts`, `app-capabilities.test.ts`,
  `host-data.test.ts`, `call-app.test.ts`).
- An agent an app asks for runs in a new session the person can see, with the `safe` preset
  whatever the calling session uses and whatever the person's own settings say, with no apps
  attached, and receives the prompt framed as the app's text ("Text an app sends";
  `app-agents.test.ts` "the agent stands up as safe even when called from an auto-running session
  (the person's global bypass does not carry over to an app's instruction), the app's text is
  framed as the app's text, and the session that hands back an answer goes idle").
  A person's global bypass is trust in their own instructions, not in instructions an app wrote,
  which may carry text the app fetched from elsewhere. Reads still run without asking; writes and
  commands stop at an approval card in that session. Its settings files
  follow the project's trust like a worker's; a user-folder app's agent, which runs in the
  orchestrator's folder, reads only the person's own settings, never that folder's files
  (`settingFilesFor`; `setting-files.test.ts`).
- Runaway limits: a chain holds at most 3 app calls and never calls the same app tool again on its
  own path, and an app runs one agent at a time and at most 5 a minute. Every request, refusals
  included, is a run record under the call that caused it (`limits.test.ts`,
  `broker-records.test.ts`, `app-chain.test.ts`).
- Stopping an app closes stdin and fd 3 together. An app still running after the grace has its
  whole process tree ended, SIGTERM then SIGKILL, descendants that outlive their parent included
  (`app-process.ts` `stop`, `kill-tree.ts`, #149). An app that exits by itself has its own process
  group ended the same way, SIGTERM then SIGKILL after the grace (`stopGroup`), and disposing the
  runtime stops every process it started, including ones a restart replaced
  (`lifecycle.test.ts`).

Limits:

- Nothing confines what a running app server does with the user's privileges. Trust is a decision
  about code, not a sandbox.
- The data folder is outside the repository so that runtime files are never committed. It is not
  an isolation boundary between apps: they all run as the same user.
- Redaction is literal string replacement. Values shorter than 4 characters, and values the app
  transforms (encodes, splits), are not caught.
- Visibility decides who may call a tool, not what the tool does.
- Sharing an app and allowing a pair of projects are about which sessions may call it, not what it
  does with what they send: an attached app receives whatever the calling session's agent passes it,
  which can include that project's files or conversation. "Always for this pair" covers every app
  the other project shares, including ones shared later.
- A permission is per capability, not per request: once an app may run an agent, the app decides
  what to ask it. The agent's writes and commands still stop at an approval card (`safe`), but
  what it may read is whatever its session can read.
- `sessions.list` gives session names, and an automatically named session is named after the first
  words of its first message. It never lists a session in the trash (FR-22), and no app capability or
  agent tool restores or deletes one for good — only the person, in Settings.
- fd 3 on Windows is an overlapped pipe (apps.md §10). The broker suites pass in the Windows CI
  job with Node apps; nobody has run a Python app or the packaged app on Windows.

## Imported apps and app links

An app imported from a folder, a zip or an https link (plan E-3, [apps.md](apps.md) §12) is someone
else's code that will run as the user. It gets its own confirmation, separate from project trust.

- **Nothing runs before the person has seen what runs.** The source is copied into a staging folder
  the discovery never scans, and the review (the command and its arguments, what `uses` declares,
  the secrets it wants, every file) is shown before anything is in. An imported app arrives turned
  off (`unconfirmed`): it never starts, is never attached to a session, every call is refused, and
  no builder session is made for it. The runtime checks this at every call, start, `check` and
  status, not only when it is listed (`runtime.ts` `held`; `imports.test.ts` "an app brought in
  shows unconfirmed with a reason, calling it is refused and no process starts — enabling it
  starts it"; `session-apps.test.ts` "an imported app does not attach to the orchestrator before
  the person turns it on, calling it by name is refused, and turning it on attaches it (M4
  E-3)").
- **The confirmation is held by the host and bound to what was seen.** It lives in
  `app-imports.json` (0600) in the data folder, not in the app folder, so neither the app's code nor
  an archive can supply it. It is bound to the folder's exact file id (bigint stat, persisted as
  the decimal string `inoExact`). Numeric `ino` is kept for older hosts during swaps and rollbacks
  until a later release can remove it ("add first, remove later"). The new host compares `inoExact`
  when present. Legacy numeric ids below 2^53 still match exactly; unsafe numeric ids keep their
  import mark but require fresh review. Lookups are read-only; importing or confirming explicitly
  writes both fields. The mark records a hash of the manifest's `server` and `uses`. Enabling sends
  back the key of the review the person saw, and the host
  compares it with the manifest at that moment, so what was reviewed is what is enabled. A later
  change to `server` or `uses` (an editor, the builder, a restored version) asks again
  (`import-book.ts`, `handover.ts`; "a changed command blocks calls, and the confirmation dialog
  states what changed alongside the command it was enabled with — enabling with the new key runs
  it again", "if it changed after the confirmation dialog was seen, that dialog's key no longer
  enables it").
- **Reading the source.** Links inside a folder are not followed: one pointing outside refuses the
  import, one pointing inside is not copied. Files are opened without following a final link, after
  the path guard has checked the parents. Zip entries are judged before anything is written: no
  `..`, absolute paths, drive letters, backslashes, empty segments or control characters (zip
  slip), no link entry leaving the archive, no entry inflating past its declared size (inflation
  stops there), matching checksums, no names that collide on a case-insensitive disk, no
  encrypted, split or ZIP64 archives. There are caps on files (2,000), bytes (64 MiB, 16 MiB per
  file), depth (16) and the archive (32 MiB). Every file is written under a path built from checked
  segments and checked again to be inside the staging folder (`imports.ts`, `zip.ts`;
  `imports.test.ts` "a zip cannot write outside (zip slip)", "a link inside the folder that points
  outside is refused (stating what it points at), and a link pointing inside is never moved",
  "caps: file count, one file, the total, depth, archive size").
- **Dot-names are not copied.** A user-folder app's builder works in the app folder and reads the
  settings there (decision 3 trusts that folder), so `.claude/` or `.codex/` inside an archive
  would be hooks and settings nobody confirmed. `.git`, `.env` and the rest are left out too.
- **Downloads.** Only `https:`; no user or password in the URL; loopback, link-local (cloud
  metadata lives there) and unspecified hosts are refused. Redirects are followed by hand, at most
  five, and every target is checked again, so an https link cannot bounce to http or to this
  machine. The body is capped by its declared length and again while it streams; it goes to a
  temporary folder that is removed afterwards, and the result is judged like a local zip.
- **App links** (`centralu://app?url=…`, E-4) are text someone else wrote. The macOS shell accepts
  only the `centralu` scheme under a length cap, a few at a time, and passes them to the page,
  which accepts only `centralu://app` with one `url` that is https or a file of this machine
  (`parseAppLink`). A link only fills in the import dialog: nothing is read or downloaded until the
  person presses Review, and then the host judges the source again with its own rules. The shell
  receives links through the platform's open event rather than the deep-link plugin, which would
  open more commands to the page; the one command added, `take_app_links`, is granted like the
  others (next sections).

Limits:

- The confirmation covers what an app runs and what it may ask Centralu for, not its code. Once
  enabled, an app's code can change without asking again, as a user-folder app's can; that is what
  enabling means.
- An https host given by name is not resolved and checked: a name that resolves to a private
  address is fetched. The request happens only after the person presses Review on that address.
- Hardlinks in a source folder are copied as the files they are; pathname checks cannot tell where
  an inode came from (the same limit as "Project files and native handoff"). Same-user races
  between checking a file and opening it remain.
- If `app-imports.json` cannot be read, it is moved aside and the marks are lost: imported apps
  are then treated as the user's own until they are imported again. The host logs this.
- App links have been exercised by hand on a built app, not in CI, and are received on macOS only.

## App views

A view is an app's HTML running inside the desktop window, isolated in layers. Browser e2e
(Chromium) covers the frame rules; the Tauri window was measured by hand (spikes S-1 and S-2,
#186).

**The proxy sits behind a per-launch secret.** Every HTTP route on the host's loopback port is
behind a 32-byte random path segment made at each launch, a different value from the WebSocket
token (`transport/http.ts`). Under the keeper the segment is instead derived from the keeper's token
(HMAC-SHA256 under a fixed label, base64url, 43 characters; `deriveHttpSecret`), so that every host
the keeper starts has the same one and a view's address survives a build switch (#280 step 4). It
is still a different value from the token, and one-way from it: a leaked view address gives nothing
toward the RPC door. The other direction was never a boundary, since whoever holds the token can
already ask `apps.viewFrame` for an address carrying the secret. It lives as long as the keeper's
token, and a keeper restart changes both. Without it, or with a wrong one, a request gets the same 404 as a path
that does not exist, in status, body and headers (77 method and path combinations in #150;
`server.test.ts` "reaching it without the secret is nothing but 404, indistinguishable between a
wrong secret and a nonexistent route"). The comparison is constant-time over hashes. Every
response sends `Referrer-Policy: no-referrer`, so a view cannot read the secret from its referrer.
A frame address is given only to a parent on the WebSocket origin allowlist (`view-host.ts`
`frame`; "gives no address to a parent origin outside the allow list, and 404s even when the
address is tampered with"). Under the keeper the address names the front door's port rather than
the host's (`swap-control.ts` `viewPort`); the door relays the request unread, so the host applies
exactly the same secret and allowlist checks. The desktop CSP opens frames to `http://127.0.0.1:*`
and nothing wider (`tooling/desktop-csp.test.ts`): the port changes every launch, and the secret
locks the path.

**Opaque origin by default.** The proxy page, on the host port's origin rather than our UI's,
creates the inner frame with `sandbox="allow-scripts allow-forms"` set **before** it gives the
frame the HTML through `srcdoc` (`views/proxy-page.ts`). It never uses `document.write`: in the
reference host that let the view inherit the proxy's origin and reach other proxies' addresses,
secret paths included, and their storage (measured, S-1). The inner document's origin is `"null"`:
no parent or top window, no storage or cookies, no popups, no top navigation, no fetch, WebSocket
or image from the host port, and navigating itself elsewhere is blocked by the proxy's
`frame-src` (`e2e/app-frame.spec.ts` "S-2 (browser part): an app frame cannot reach the parent,
the top window, storage, popups, or the host network", and "opaque mode: the inner frame's origin
is "null", and it cannot read the proxy's secret address"). The outer frame has
`allow-scripts allow-same-origin allow-forms` so that the per-app mode can work; its origin is
the host port's, not our UI's, so it cannot touch our window.

**Per-app origin, when an app asks.** `view.origin: "app"` in the manifest gives the inner frame
`allow-same-origin` on `http://127.0.0.1:<port>`: a real origin, so browser storage works. The
port is fixed per (project, app) and never given to another app, because WebKit keeps storage per
origin and a reused port would hand one app another's storage. The port book (`views/origin-ports.ts`,
kept in app settings under `apps.viewPorts`) only grows; a port another program holds is retired
for good and the app moves, losing what it stored there. Ports come from 20000–32767, clear of the
macOS and Linux ephemeral ranges, and listen on 127.0.0.1 only. The port serves only that app's
instances, behind a secret derived per app from the host secret (HMAC), so a view reading its own
`location.href` learns nothing that opens another app's route; the proxy page there allows only
its own script hash and that one frame origin (`origin-ports.test.ts`; `view-host.test.ts`
"per-app origin"; `e2e/app-frame.spec.ts` "per-app origin mode: gets a real origin on its own
port, storage is separated per app, and reopening gets the same origin").

**A linked machine's views are served by the hub** (#82, [plans/remote-hub.md](plans/remote-hub.md) §11). Storage
lives in the window that renders a view, so the port has to come from the book of the host whose window shows it: a
machine's own ports would collide with the hub's in the one WebKit that holds both. The hub keys a machine's app as
`<machine>.<that machine's key>` in its own book, asks the machine only for the app's raw resource
(`apps.viewDocument`), and builds the CSP, sandbox and proxy page itself, so a loopback entry is dropped by the hub's
rule whatever the machine's build does. The machine's answer must name a project of its own machine or none; one
naming another machine's project is "not open" (`links/linked-views.test.ts`). No address of the machine reaches the
window, and the machine's HTTP secret never leaves it. A machine removed and another linked under the same name gets
the same machine id, and so the old origins and their storage: accepted (owner, 2026-10-11), as for a local app made
again under the same id.

**CSP.** A view's policy is assembled from its resource's `_meta.ui.csp` (`views/csp.ts`) and sent
as a header on the proxy page, which the `srcdoc` document inherits: the view can tighten it with
its own `<meta>`, never widen it. By default: `default-src 'none'`; inline script and style;
`data:` and `blob:` for images, media, fonts and workers; `connect-src` and `frame-src` `'none'`
unless declared; `form-action 'none'`; `object-src 'none'`. `'self'` is not a source: under the
opaque origin it would mean the host port. A declared entry must be `scheme://host[:port][/path]`
with http(s) or ws(s) (a `*.` subdomain or a `:*` port is allowed). A bare `*`, bare schemes,
keywords, anything containing a space, `;` or `,`, and loopback hosts (where the host's routes and
other apps' ports live) are dropped, and the drop is logged. A declared host is parsed the way a
browser parses a URL (WHATWG) before it is checked, and the policy carries that canonical form, so
`127.1`, `2130706433` and `0x7f000001` are read as `127.0.0.1` and dropped (#407). This is
hardening, not a closed hole: CSP host matching is literal, and Chromium and WebKit (Playwright)
blocked every fetch to `127.0.0.1` under a policy that listed only those other spellings, while a
policy listing `127.0.0.1` let each spelling through. The frame's `allow` attribute passes
only a declared camera, microphone, geolocation or clipboard-write (`csp.test.ts`). The manifest's
own `csp` field is not used.

**The frame decides, not the message.** The proxy relays only messages whose `event.source` is its
parent, with the host origin it was given explicitly (never `document.referrer`, which is empty
under `tauri://`), or its own inner frame, with origin `"null"` or the app's origin; a replaced
inner document is dropped. In the UI, the bridge listens only to its own iframe (`AppFrame.tsx`)
and sends every tool call and resource read under the component's own app, project and instance
(`e2e/app-frame.spec.ts` "a message that claims a different app cannot change which app the call
is attributed to": another app named in the SDK's `_meta`, raw JSON-RPC with extra fields, and a
message posted straight to the top window all fail). On the host, a view instance fixes its app:
asking for a frame or a resource under another app's name is "not open" (`view-host.test.ts` "the
instance decides which app the view belongs to — presenting a different app name or project does
not open it").

**A view shows only its own app's screen.** An inline view opens only if the `ui://` its tool
declares is in that app's `resources/list`, and closes if the call's result points elsewhere
(`inline-views.ts`; "a tool that declares someone else's view opens nothing and leaves a
rejection — the call still completes", "closes and rejects the opened view when the result points
to someone else's view"). Documents are read only from the
instance's own app process, so a pinned view's `home` result cannot name another app's screen
either (`app-home-view.ts`).

**Links** open only for `http(s):` and `mailto:`, only after the person confirms, and outside
Centralu with `noopener,noreferrer` (`AppFrame.tsx`; "a link opens through the platform's
external-open port after the person confirms it, and anything that is not http(s) or mailto is
refused without even asking"). A view's tool calls are not approved one by one:
the view is the control surface the app offers the person. They are recorded as `view`.

Limits:

- The e2e runs in Chromium. WKWebView and the Tauri window were measured by hand in the spikes and
  in #186, not in CI.
- `apps.invoke` does not check on its own that a view of that app is open; it trusts its caller,
  the UI, the only holder of the WebSocket token. The app is fixed in the UI (`AppFrame`), not
  derived again by the host.
- In dev and web mode, where the top page is `http://127.0.0.1`, cookies are shared across all
  ports (measured in Chromium, WebKit and WKWebView, S-1); localStorage and IndexedDB are not. The
  per-app origin separates storage by origin only.
- A view might rewrite its own `referrer` meta and send the proxy's address to a domain it
  declared in `connectDomains`. Not measured yet (#150).
- A declared `connectDomains` entry is a real way out for anything the view holds. The CSP limits
  where data can go, not what.
- The host adds a drag relay to every view's document (#308, apps.md §6.7): a few lines that post a
  dragged item's `text/uri-list` and `text/plain`, and where the drag ended, to the view's parent.
  It runs with the view's own privileges and posts nothing the view could not post itself. The UI
  reads both messages as the app's words: it checks their shape, counts an end only after a start
  from the same frame and while that frame holds the page's focus (a press in it), and only ever
  puts a link or text into a composer's draft, never sends it. An app the person is pressing in at
  that moment could still post an end pointing at a session of its choosing; what it gets is text
  in a draft the person sees before sending.
- Open view instances survive a planned hand-over under the keeper (`view-handover.ts`): the
  leaving host writes each instance's id, app and `ui://` address (nothing the app returned) to the
  store under `views.handover`, and the next host reopens them under the same ids if the record is
  at most ten minutes old, then deletes it. Each reopened instance holds its app as a fresh one
  does and must still match its app on every request; a view in a conversation is re-bound to its
  card so its messages still go only there. An instance id is a bearer handle to that one view for
  whoever holds the WebSocket token, as it was before; it now lives across the swap too.

## Desktop command permissions

Tauri lets a page call our Rust commands over IPC. Until #186, with no app manifest, Tauri let app
commands from **local** origins (the dev server, `tauri://localhost`, registered custom schemes)
through without a permission check (tauri 2.11.5 `webview/mod.rs` `on_message`); only a per-launch
invoke key stood in the way. Remote origins, a loopback app frame among them, were already refused
(tauri ≥ 2.11.1).

Now `apps/desktop/src-tauri/build.rs` declares an app manifest, which creates a permission per
command (`allow-<command>`), and `capabilities/default.json` grants the 19 commands **only to the
window `main` on local origins**: no `remote`, no wildcard window. The granted set is exactly what
the frontend calls. `tooling/desktop-permissions.test.ts` holds the manifest, the `invoke_handler`,
the grants and the call sites to each other, and fails on `remote` or a wildcard. Plugin
permissions have no call site to hold them to, so the test names every one that is granted: adding
a plugin, or widening one, is a change to that list. The one widening so far is a scoped `opener:allow-open-url` for
`vscode://vscode-remote/ssh-remote+*` (VS Code's Remote-SSH links for a linked machine's project, #82); the test holds
it to that one pattern. It also holds the app-link setup (M4 E-4) to
one URL scheme, `centralu`, and no deep-link plugin.

Measured on a real Tauri instance (#186, when there were 12; `take_app_links` came with app links,
M4 E-4, and the five keeper commands came with #280 — `host_build`, `switch_host_build`, `background_mode`,
`set_background_mode`, `quit_and_stop_agents` — and none of those has been measured this way): all 12 answer from the main page, in dev and in a
`tauri://localhost` debug build. From an app frame holding a leaked invoke key, 60 of 60 calls were
refused by the permission check and none reached a handler.

Limits:

- Tauri writes the real invoke key to stderr every time a wrong key arrives. Nothing in our
  pipeline collects Tauri's own stderr (`host.log` holds the host's stderr; the release app's
  stderr goes to `/dev/null`). Whatever starts collecting it must keep it on the machine.
- A frame on a **local** origin inside the main window has our UI's origin, so permissions cannot
  tell it apart. The rule that covers it: never serve app content from a local origin (the dev
  server's port, `tauri://`, custom schemes). Only review keeps a future change from breaking it.
- A `remote` capability covering 127.0.0.1 would open our commands to app views. Do not add one.

## Project files and native handoff

Existing filesystem targets are checked against the canonical project root. Symlinks
resolving inside that root are supported; outside targets and dangling links are rejected.
Text/image reads require a regular-file descriptor, bound allocation/read size, and compare
opened-file identity. Native reveal/trash checks are additional absolute/no-symlink checks;
they are **not** independent proof of project containment. Opening in an IDE does not fall
back to a generic OS opener that could execute repository-authored content. A linked machine's project is opened
with a VS Code Remote-SSH link instead (#82): VS Code connects over the person's ssh and, by default, asks before opening a remote file
or folder from a link (`security.promptForRemoteFileProtocolHandling`); the hub hands it a path and never reads or runs the file itself.

Limits:

- An in-root hardlink shares an inode with its other names. Canonical pathname checks do
  not establish where that inode originated, so they do not close hardlink-based access.
- Validation and OS pathname use are separate operations. Same-user replacement races
  remain, especially for move/import/list/watch and native handoff. Descriptor identity
  checks narrow the read window but are not an atomic descriptor-relative filesystem sandbox.
- Project containment does not confine provider tools or terminal commands intentionally
  executed with the user's permissions. Approval policy and OS isolation are separate layers.

Do not expand the scope of these claims without stronger implementation and platform-level
validation. In particular, do not describe these checks as complete filesystem isolation.

## Images a reply names

An agent often answers with a screenshot it saved: `![grid](/Users/me/Desktop/run/.test/r1/grid.png)`. The window
cannot load that path itself (its origin is the app, and the desktop CSP's `img-src` is `'self' data: blob:`), so
WKWebView drew a broken-image mark. The owner chose (2026-10-07) to show such an image **wherever it is on disk**, so
the window asks the session's host for it (`messages.image`, [protocol.md](protocol.md) §3) and draws the bytes as a
`data:` URL. The CSP is unchanged: a web image in a reply stays an ordinary `<img>`, and whether it loads is the CSP's
answer, as before.

Since the file can be anywhere, the project root is not the boundary here. Three checks are, each on its own
(`dev-services/message-image.ts`, `SessionManager.messageImage`):

- **Only a path this session's replies wrote.** The host looks for the path in the session's own stored replies
  (`assistant` `text` rows, its subagents' included) and in the reply still streaming. The person's messages, reasoning
  and tool output do not count, and neither does another session's reply. The match must stand alone, bounded by
  space, a bracket or a quote, so a reply that wrote `/x/a.png` does not admit `a.png` (which resolves against the
  session's folder to a different file). This is asked before the path is resolved or anything on disk is touched: a
  refused path learns nothing about whether it exists. Without it, whoever holds the WebSocket token could read any
  image on the machine through this call.
- **Only a real image, by its bytes.** PNG, JPEG, GIF or WebP by their signatures, whatever the name says. A text file
  named `.png`, or a link named `.png` that points at one, is refused, and its contents are not sent. SVG is refused:
  it has no signature, so accepting it would mean accepting any text file that contains `<svg`, and it is a document
  that can carry script and external references, which the window would be taking on the strength of an agent's
  sentence (`<img>` does not run them, but nothing here needs it to). The project file viewer still shows a project's
  SVGs.
- **At most 10 MB** (`IMAGE_PREVIEW_MAX_BYTES`, shared with the file viewer's preview), checked on the opened file
  and again on what was read, so a file that grows between the two is still refused.
- **Only this machine.** A `file://` URL that names another host is refused, and on Windows so is any path that
  resolves to `\\…`: a UNC share (`\\server\share`, `//server/share`, and `file://server/share`, which Node turns into
  that UNC path on Windows rather than refusing it) or a `\\?\` / `\\.\` device path. Reading one would have the host
  reach out to whichever machine a reply named, and Windows offers that machine the person's sign-in. This is decided
  on the resolved path, so a relative path in a session whose folder is a share is refused too. A drive letter mapped to
  a share is read like any other drive: the person mapped it.

The path is resolved once (`~`, a path relative to the session's folder, a `file://` URL, then `realpath`), and that
resolved string is the one opened, with `O_NOFOLLOW`, once; the type, the size and the signature are all read through
that one descriptor. A refusal comes back as an answer with its reason (not mentioned, not found, not an image, too
large, unreadable), shown in the picture's place with the path the reply wrote. When there is a file there, the answer
carries its resolved path, and the window offers to reveal it in the file manager through the shell's `reveal_path`,
which still refuses a relative path or one with a link in it. For a session on a linked machine the hub drops that path
from the answer (`links/routes.ts`) and the window offers no reveal: the file is on the other machine.

Limits:

- **What the agent writes decides what is shown.** Text an agent read (a web page, a repository file) can steer it into
  naming any image on the machine. The image is then shown to the person in the window and sent nowhere else; the
  agent's own tools could already read the same file with the person's permissions. The checks keep the call from being
  a general file reader, not an agent from pointing at a picture.
- **macOS asks per protected folder.** Reading a file under Desktop, Documents or Downloads is the host reading it, and
  macOS may ask once for that folder in Centralu's name, as it does when a project is there.
- **Same-user races** remain as in "Project files and native handoff": a directory along the path can be swapped
  between `realpath` and `open`. What is read is still checked as an image under the cap, through one descriptor.

## Windows (#14)

Nothing here has been run on a Windows machine by a person yet; the Windows CI job runs the unit
tests. What differs from macOS and Linux, and what holds it:

- **Programs run by name in a project.** Given a bare name, Windows process creation looks in the
  child's working directory before PATH. Every git call runs in the project, so a `git.exe`
  committed at a repository's root would run on the first status read. `git`, `gh` and an app's
  manifest command are spawned by the absolute path found on PATH (`tool-launch.ts` `programPath`,
  `resolveCommand`; tests in `tool-launch.test.ts`), and PATH lookups skip relative entries
  (`env-path.ts`, and `node`/`code` in the Rust shell).
- **Tool shims are read, not shelled.** npm and pnpm install a tool as a `.cmd` file, which Node
  starts only through `cmd.exe`, and cmd.exe would read `%`, `^`, `&` and quotes in our arguments
  (JSON, prompts) as its own syntax. The shim is read for the `.js` or `.exe` it starts, and that
  is spawned without a shell. Project commands (the Run button) do run under `cmd.exe /d /s /c`,
  because the command is the person's own text.
- **Paths.** `path-guard.ts` refuses a path whose `relative()` from the root is absolute (another
  drive, a UNC share), instead of walking its segments inside the root (`path-guard.test.ts`, with
  `path.win32`). Windows paths ignore case; containment uses `relative()`, which does too.
- **File identity.** A read's opened-file check is the only guard against a swap there, since
  Windows has no `O_NOFOLLOW`. An NTFS file id is 64 bits with the record's reuse count on top, so
  it is above 2^53, and as a Number two files can compare equal: on windows-2022, 1754 of 2000
  pairs of files made one after the other did. `dev` and `ino` are compared as bigints
  (`path-guard.ts` `assertExistingPath`, `fs.ts`; `fs-read-identity.test.ts`, #368).

Limits:

- If git is not installed at all, the bare name is used, and a planted `git.exe` in the project
  folder would run. The same holds for `codex` when it is not installed.
- The files written `0600` here (`app-secrets.json`, `app-imports.json`) get no mode on Windows,
  which has no mode bits; they are as private as the folder they are in. The default data folder
  is in the user's profile, which only that user (and administrators) can read. A `CC_DATA_DIR`
  elsewhere gets that folder's ACL.
- Junctions are reported as links by `lstat` and so are treated like symlinks, but no containment
  test creates one yet (creating a symlink on Windows needs Developer Mode or administrator
  rights; a junction does not).
- The keeper does not run on Windows (no named-pipe control socket), so the direct path is used.
