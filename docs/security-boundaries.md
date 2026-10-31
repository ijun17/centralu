# Security boundaries and residual limits

These controls reduce risks from untrusted repository and agent content. They do not
sandbox an already-executing process with the user's OS privileges. An app's server is such a
process ("App servers"); an app's screen is sandboxed ("App views"). The app model itself is in
[apps.md](apps.md).

## Inter-agent content

A script an agent runs calls the host with its session's credential (#1405, "Who holds full power"): attribution, not
proof, and never more than the limited credential's rights.

Worker reports retain their provenance in stored history and the UI. Reports from
workers to directing sessions become host-authored notifications: the receiver's model reads only what Centralu wrote
(how the work ended, the session's id, the kind of its tool's error, how to go on, and the `read_session` call that
shows the last response and the error as data), never the last response, an error's words (a CLI's error can carry a
hook's output, a linked machine's is whatever it sends), a session's or project's name or a task's description (#1186;
`ChildReports.tellSession`'s `forModel`, `errorKind`). A notice that could not be delivered is kept in memory, dropped
with its session, and delivered when the session next takes a message; ordinary
orchestrator/manager/coordinator instructions retain their content and attachments. A worker
holding the read-only `reader` set (#320) is still a worker here: the gate asks whether the
source directs sessions, not whether it has tools. Worker-originated records are excluded from
privileged conversation memory. Read-session, preview and recall text is framed as structured
untrusted data, not human authorization — that now includes what one ordinary session reads of
another. The reader set cannot send. From a trusted project it reads other projects' and linked machines' ordinary
sessions (#984), each row of a project nobody trusted marked "(not trusted)"; from an untrusted project it reads its
own project only, so text planted there cannot search every conversation (the #382 rule).

Who wrote each line travels with it (#838). `read_session` gives a line another session sent `from` and one an app
sent `fromApp`, and the first message a script started a session with `fromScript` (`authorOf` in `sessions/transcript-view.ts`); `recall`'s context marks every message
(`[person]`, `[agent]`, `[session "<name>"]`, `[app "<name>"]`, `[script "<label>"]`) and indents a message's own later lines, so neither a
child's report nor an app's text reads as the person's, and no text can start a line with a mark of its own. The
hit's snippet keeps those lines (`windowAroundLines` in `sessions/snippet.ts`): it used to fold every line break into a
space, which put a mark an app's text wrote on the same footing as a real one, and a snippet cut inside a message starts
with that message's mark (`orchestrator-seat.test.ts`). The
orchestrator's memory of its past conversation (appended to its prompt when it restarts) leaves out app messages as it
already left out other sessions', and indents a message's later lines, so text cannot start a `Person:` line.

### Starting other agents in the same project (#561)

`start_agent` and `agent_session` let an ordinary session start a Claude or Codex session in its own project and
work with it ([agent-host.md](agent-host.md) §1.2.1). They add no reach the caller lacked (the child works on the
same files under the same or a lower preset), but they multiply what runs. The rules below
apply to `safe` and `normal`; `auto` opens the consent, ownership and trust
boundaries (#603), with a log line instead of a card or refusal (Claude's own cross-session messaging is closed under `auto` too, below). The agent depth binds every preset, `auto` included (#867):

- **The person's consent.** For a `normal` caller it is the project's trust (#673): only a trusted project's
  sessions can start agents at all, and trusting it was the person's decision about that project, so no card is
  raised; trust is read at each call and when a standing card is approved. A `safe` caller gets a card in its session
  the first time it starts one: once, always for this session (kept while the host serves it), always for this
  project (stored as the project's `agents` consent, revoked in Settings → Permissions). Injected text can at most
  raise a card, and a card is never withdrawn by a timer: it stands until the person answers, the caller withdraws
  it, the caller is deleted or the project loses trust, and survives a host swap (`agent_start_requests`). An
  approval reads trust, depth and the caller's preset again: a preset raised above the one on the card starts
  nothing, so the person never approves one set of permissions and gets another. Trust and depth are read once
  more when the child's session exists, before it is given the task; a child that fails them gets none.
- **Never above the caller**: the child gets the caller's preset; a child the person raised above it takes no
  more work from the caller.
- **The agent depth** (#867): a setting, 1 to 3 and 1 by default ("How deep agents may start agents" in Settings →
  Orchestrator, `prefs.agentDepth`). A session the person started is depth 0; one started by another (`askedBy`), or
  working on a task another session gave it (an unsettled delegation: `ask_project`, a fork, `agent_session`), is one
  deeper than that session, the deepest link counting; a fork whose requester is gone is at least 1, so a fork the
  orchestrator made (no `askedBy`) counts 1 for good, and a session an `auto` caller reached through `agent_session`
  counts one deeper than that caller while the delegation is unsettled. A session another session started also
  records the depth it was started at (`agent_depth:<id>` in `app_settings`, purged with the session), and never
  counts less: deleting the middle of a chain does not let what hung below it start agents. A session at the
  setting's depth or deeper can neither start agents, nor fork, nor ask a project, under every preset: `auto` opened
  this until #867, and children under it each starting their own ran twelve sessions at once (#862). Read at each
  call (`agentDepthRefusal`), so lowering it applies to the next start; the refusal names the setting and where it is.
- **Ownership**: `agent_session` normally acts only on a session whose `askedBy` is the caller, in its project.
  Deletion without a worktree accepts either `askedBy` or `parentSessionId` equal to the caller, and requires
  that link in every preset (#637); it uses the same archive path as the sidebar. Stopping a busy child also
  requires the caller's own unsettled delegation; a person's turn or pending approval/question is protected. Under
  `auto`, another caller's delegation can be observed without consuming its report or result;
  observer waits never grant files or stop work on cancellation. A person's turn or app request
  with no delegation stays unowned by its observer, does not pin that caller awake, and
  continues if the caller is stopped. An explicit stop preserves
  the owner's error report/result. Self wait, stop, delete and send are refused in every preset.
- **Cards of a delegated turn** (#676): a question raised in a turn the caller gave (also `ask_project`'s and
  `send_to_session`'s) reaches the caller as a tool result it asks for, never as a user message carrying the
  target's text; the caller may answer it, as the person may, and the first answer counts. An approval reaches it as
  a notice only: it may allow or deny only while its own preset is `auto` and the target is `normal` or `auto`; never
  for a `safe` target, never as or for an app's agent, never a card the host raised, never "always". An answer names
  the handle of the card the caller read (request id, turn, content), so an id an adapter reuses after a restart
  cannot carry it onto another card. The link ends with the turn, so the person's later turns stay theirs.
- **Requests to a busy session** (#677): a turn that is not the requester's is never joined without the requester
  choosing it. A note into it needs the requester's own `auto` (#606); a queue waits for the turn to end and is
  then the requester's turn, whose tool's gates are read again when it goes in; a fork starts an agent, so it takes
  start_agent's gates (depth, trust, ceiling, the consent card, with the gates read again once the card is answered
  and a place under the ceiling taken before the fork is made), runs at the lower of the two presets, and gets a worktree of its own unless it is read-only work,
  which shares the folder under at most `safe`, so two agents never write one folder.
- **The orchestrator's children** (#853): the orchestrator reaches `start_agent` and `agent_session` too (as commands
  in the `commands` tier), for light work outside any project. Its child has no project and works in a folder of its
  own under `<data>/orchestrator-agents`, never the orchestrator's, so nothing it writes lands where the orchestrator
  reads (Codex loads `.agents/skills` from a session's folder whatever the trust) and no two children share one; the
  folder goes when the child is deleted for good. It runs under the orchestrator's preset with no Centralu tools and
  only the person's own settings (no project to trust). The consent is a card under `safe` and `normal` (no
  project's trust stands in for it), with "always for this project" kept as always for the orchestrator while the host
  serves it, since there is no project to remember it for; `auto` opens it. `agent_session` acts only on a child whose
  `askedBy` is the orchestrator, in every preset. The depth binds as for any caller: the orchestrator is at 0.
- **A ceiling**: Settings → Agents → Running agents per project (`prefs.agentCeiling`).
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
skip unfetched targets without lazy-fetching (`GIT_NO_LAZY_FETCH=1`); an empty `GIT_ALLOW_PROTOCOL`
also blocks transport access on older Git. Historical `.gitmodules` names preserve targets across path renames.
History and tree listings stream to temporary files instead of filling a stdout buffer. Separate merge
diffs are explicit, so `log.diffMerges` cannot hide merge-only gitlinks. Revision/ref lists travel on stdin
instead of exceeding Windows command-line limits. Recovery requires Git 2.31+ (see the host document). Temporary named refs make gitlink-only targets
fetchable from the bundle and are removed from the live repository after capture. If the trunk cannot be
read, all reachable commits are kept conservatively. Initialized submodules are captured separately. Snapshotting uses a private index with repository hooks and filters disabled. It does not
change the child's index or execute repository programs. Patch bytes go directly to files, without UTF-8 stdout
decoding. Input above 256 MiB (all working files considered by git add plus changed staged blobs, including
initialized submodules) is refused before any git add; files and the real index stay untouched. Once archived,
a removal failure returns `deleted` with a warning naming what was left. Ignored untracked files are not kept.

The recovery directory is `<data>/worktree-recovery/<session id>/<snapshot id>/`, tied to the archive record (`trash` column).
Restore recreates the root worktree/branch and attempts to apply its patches, with a conversation notice offering
the files and manual bundle/patch recovery (submodules are manual). A bundled stored branch that differs
from HEAD also gets a `recovered/<session id>-stored-branch` branch, with a numeric suffix if occupied.
Existing branches are not overwritten. If a retry finds the worktree already present, it leaves the files
and index alone. A marker written after successful patch application lets the notice report prior success;
without one, it warns that manual recovery may still be needed. Recreating the worktree clears the marker.
Gitlinks found only in merged trunk history are scanned too (#623): merging a gitlink does not publish the module commit it names.
Recovery files remain after restore and through later deletions, until the session is purged through Settings;
delete for good and delete all archived sessions (`trash.purge`, `trash.empty`) remove the entire session recovery directory before its row is deleted. The session archive has no
automatic expiry today; any future expiry must use the same purge path. Other programs with the person's
permissions can still write the repository while it is captured: stopping the session is not filesystem isolation.

Worktree children (#582) keep the same preset as their parent. **Every Codex session under `auto` runs
with `danger-full-access` (no sandbox) and `never` approval**, including a child of an `auto` parent. This
matches Claude's `auto` bypass permissions. Commands have the person's OS access, including network and
files outside the project. `safe` uses workspace-write with `untrusted` approval. `normal` follows the
person's configured approval policy and sandbox mode, including a personal full-access mode.
**Antigravity can read its account token on Windows and Linux** (the Google sign-in it keeps in
`<data>/tools/antigravity/gemini-home/antigravity-acp/acp_token.json` there, and on a Mac without a usable Keychain):
its own viewer and search read files without asking under every preset, as Codex can read its `auth.json` and Claude
Code its credentials file on Linux, and under `auto` its commands, edits and subagents run unasked too. On a Mac with
a usable Keychain the agent keeps the token there instead. Accepted by the owner (2026-10-28,
[#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6461617566); [plans/antigravity-acp.md](plans/antigravity-acp.md) §4.2).

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
On Windows the copy is a walk that never follows a link (#849): a junction (pnpm without Developer Mode, npm and
yarn workspaces) is made again as a junction to the same place in the worktree, and a link whose target is outside
the project is not made at all. `cpSync` had copied every junction as a real folder, an outside one included, and two
junctions pointing at each other ended the host. What is a link is taken from the folder's listing, not from `lstat`:
a junction to a volume path (`\??\Volume{…}\…`), which needs no privilege to make, is one `lstat` follows and calls a
folder, because libuv cannot read its target. Such a link is left out, and a folder walked twice, a tree deeper than
256 folders or one of more than 2,000,000 entries stops the copy.
This avoids automatic registry access and install scripts in the host. It does not validate dependency code:
running tests still executes the project's installed dependencies. Missing or incompatible source dependencies
need the project's explicit setup command or an install by the child under its preset.

### Asking another project (#371 part B)

`ask_project` is the one way an ordinary session acts outside its own project. Under `auto`,
consent and trust refusals are open and logged; the agent depth is not (#867), it refuses under every preset. The existing target session keeps its own
preset; session creation in another project is forbidden under every preset (#614). Under `safe`
and `normal` it has these controls ([agent-host.md](agent-host.md) §1.2):

- **The person's consent per pair of projects**, asked as a card in the caller's session the first
  time X asks Y; only "always" is remembered (store `project_consents`), and Settings revokes it.
  The card names the selected session as well as its project. Without consent no task is delivered.
  The card is the boundary, not the tool's description: a caller steered by injected text can at most raise a card.
  The card's names (projects, the session, the machine, an app) are JSON-quoted on one line, as the handoff card's
  are, and the task is one line that says how many characters it has in all when it is cut at 160 (#838): a name
  could otherwise read as the card's own words, and a cut task looked like the whole of it. start_agent's card quotes
  its project and branch the same way.
- **What the delegated session runs is gated by its own project's permissions.** The existing session keeps its own
  preset and project trust; its approvals stand as cards in that session. Under a person's global bypass it runs as freely as that person's
  own sessions there — the owner's decision is that the delegated session may change code in its own
  project. The task arrives framed as sent by another session, never as the person.
- **The agent depth** (#867). A session handling an active cross-project task is one level deeper than its asker, so
  at the default depth of 1 it cannot ask a third project, and two projects that consented to each other cannot pass a
  task back and forth without a person. No preset opens it. The same holds across machines (#838 item 12): a hub asking
  a linked machine's session sends the depth that session works at (`host.send`'s `ask`, the caller's depth plus one),
  and the machine counts it until that turn ends (`hubAskDepthKey`), so the session refuses start_agent and ask_project
  as one asked on its own machine would. A machine or hub from before this change neither sends nor reads it: there,
  a linked ask still counts the asked session as one the person started.
- **Trust** (owner decision 2026-10-11, #382). A session in a project the person has not trusted cannot
  ask at all, the rule `attach_app` follows: text in that repository could be the one asking, and the
  card would then be the only thing between a planted instruction and another project. An untrusted
  project *can* be asked, and the card says so ("Let X ask Y (not trusted) to …", and a line on what
  that means): the selected session there reads none of its settings or instruction files and runs none
  of its apps, but works on its files under the person's own permission settings. A remembered
  "always" for the pair still skips the card, also after the target loses trust. Trust and depth are read
  again once the card is answered, and again before a queued ask goes in.
- **Existing sessions only** (#614). Selection by name or id is confined to ordinary sessions in the
  named target project. Without a selector, exactly one is required; ambiguity lists names, states
  and last activity, and no session refuses until the person opens one. Builders, app agents and
  orchestrators cannot be targets. No preset permits cross-project child creation. Old ask-created
  sessions remain ordinary sessions without cross-project ownership. A session busy with a turn that
  is not the caller's returns the choices and receives nothing (#677): a note into that turn only
  from an `auto` caller whose target takes tracked mid-turn input, or a queue for a new turn; never a
  fork, which would create a session in another project. Another delegation's watcher cannot be
  overwritten. Delivered input is visible in conversation with the
  asking session's `from`; waits follow its completion receipt, including queued turns. Caller Stop
  reaches a target only during an active wait. If the task joined the person's running turn, caller
  Stop/cancellation ends only that caller's wait, leaving the turn, receipts and other observers
  running. A bounded call that already returned does not confer a right to stop the target.
- **The answer is someone else's words**, JSON-quoted for the caller like a worker's preview.
- **Files come back by name, and only from inside the target project.** A named path is granted
  to the caller only if it exists inside the target project's folder after resolving symlinks
  (`canonicalPath`, so the grant and a later read compare in one spelling; the grant is kept as it
  was made and never resolved again, so a link swapped in for a granted folder opens nothing new), and
  never the project root itself; a file opens that file, a folder what is under it. A path outside
  is listed and not opened (Claude then asks the person before reading it; Codex does not restrict
  reads at all, so for a Codex caller the grant changes nothing and the residual is the same as any
  Codex read).
- **Residual:** within an allowed pair, the task text comes from the calling model, so injected text
  in the caller's context can reach the target project as a task. The target's approvals, the
  visible session and Stop are the controls left; revoking the pair ends it.

### A linked machine's session asking this computer (#550)

The reverse direction of linked machines ([plans/remote-hub.md](plans/remote-hub.md) §12.7). The plan treats a linked
machine as the less trusted side: a compromised server must not reach the person's computer by default (§3.2). So:

- **Off by default, per machine, on this computer.** Only the hub's Settings → Machines turns it on, and the switch is
  read at every call; off refuses at once and forgets the pairs. It is stored on the machine's row and goes with it.
- **An allowlist of two calls**, `hub.projects` and `hub.askProject`, answered only through the handler the hub's link
  to that machine was given. A machine cannot reach any RPC method, the router, a session's conversation, a file, an
  app or the orchestrator through it; anything else is "Unknown method". The machine is the link's own, never what a
  call says, and at most 16 of its calls run at once. A build without the handler drops such a call.
- **The hub's card for each pair**, raised in the hub's session that would get the task, so only the hub's windows can
  answer it, and raised whatever that session's preset: `auto` there answers no card of another machine (#550 review).
  It names the machine and the asking session there, quoted on one line;
  turning the switch off closes it. Approving it is remembered for the
  pair until withdrawn (owner decision 2026-10-18): the person approves each session of the machine once per project.
- **The same rules as an ask here** for what runs: an existing ordinary session only, never created; a busy one gets
  nothing; the task framed as from that session on that machine, never as the person or an orchestrator (so a seat that
  directs would get it as someone else's words); the agent depth counted across the link; once the pair is approved, the
  target session works under its own preset, trust and approvals (its `auto`, if it has it, then applies to its tool
  calls, never to the pair's card); the answer cut to size; paths in it listed on the machine and none opened.
- **Residual:** the machine names the asking session itself. A compromised machine can use any pair approved for any of
  its sessions, and so reach every project of this computer that a session of that machine was approved for; that is
  what the switch and each approval consent to, and withdrawing a pair or turning the switch off ends it. While the
  switch is on, it can also raise this computer's card as often as its calls allow (16 at once), under names it chose;
  the card says which machine asks, and turning the switch off refuses every call from then on. The task text
  is the machine's agent's words, as for any ask (the residual above). The machine reads its own trust and depth gates
  before it asks; a caller there losing trust while this computer's card stands does not withdraw the card.

JSON framing prevents ambiguous transcript-line assembly; it does **not** make text safe
for an LLM to obey or eliminate prompt injection. Tool scopes and typed approval checks
remain the deterministic authorization boundaries.

### Claude's independent-session messaging (#569)

Claude Code can discover other Claude processes on the same machine through
`~/.claude/sessions/<pid>.json` and send messages over per-process Unix sockets
(named pipes on Windows). Its default inbound policy delivers messages between sessions in
the same permission-mode class, including two `safe` sessions. That path does not pass through
Centralu's `ask_project` consent card.

Every Claude query Centralu builds, under every preset, `auto` included, applies inline SDK flag settings
`crossSessionInbound: 'refuse'` to drop inbound peer messages, adds `ListAgents` and its alias `ListPeers` to
`disallowedTools`, and sets `CLAUDE_CODE_HARBOR_KITE=0` in the child environment. `SendMessage` remains available
because it also continues the session's own background subagents. Existing settings, denies and environment are merged,
and settings-file selection remains governed by project trust and session kind. The host's own
`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are dropped from the environment it passes on: a host
started inside a Claude session would otherwise hand its children that session's inbox address and secret.

This is not opened by `auto` (it narrows #603 for this one control, as the mailbox plan's slice 0 decided,
`docs/plans/mailbox.md` §9.6): two `auto` sessions are the same permission class, the CLI's default delivers between
them at once, and that would reach another Centralu session past the relations, the record and the guards its own
messaging keeps. The controls cover workers, orchestrators, coordinators, worktree managers, builders, app agents,
`start_agent` children and resumed sessions, including fresh keeper processes.

What holds, and what does not, said plainly (CLI 2.1.263 to 2.1.299 read and measured):

- **`CLAUDE_CODE_HARBOR_KITE=0` can be undone.** The CLI applies the `env` of the person's **user** settings
  (`~/.claude/settings.json`), of flag settings and of managed settings onto its environment after it starts, so a user
  `env` that sets the key to `1` binds the session's inbox again. Project and local settings cannot set it (the key is
  on their deny list). The environment gate is therefore not the control to rely on. What holds when it is undone is
  the inline `crossSessionInbound: 'refuse'` (the message is accepted into the inbox and never read: probe case
  `kite-on-b`) and the `ListAgents` / `ListPeers` denies.
- **Managed (organisation policy) settings outrank Centralu's inline layer.** The CLI resolves the inbound value as
  managed, then flag, then user settings; repo files can only tighten it. A managed `crossSessionInbound: accept`
  reopens the channel, and a managed `env` can turn the gate back on. That is the organisation's decision and Centralu
  does not override it. A managed file was not tried (it would affect every Claude on the machine).
- **Below that, the person's own settings do not reopen it.** A project settings file that asks for `accept` loses to
  the inline layer (probe case `auto-accept-file`). By the CLI's resolution order (read in its binaries, not measured)
  so do the person's user setting `crossSessionInbound: accept` and the CLI's `/config` switch: flag settings beat user
  settings. The person's own interactive Claude cannot reach a
  Centralu session either (probe case `in-from-raw`: the receiver has no inbox to reach).
- **A process an older host started keeps the flags it was started with**, so a kept `auto` session from before this
  change has its inbox open. Its launch fingerprint is version 3 now (`launchSettingsFingerprint`), so the host that
  adopts it restarts it once, at the next safe boundary (the #589 path: at idle, or after its turn), and the restart
  carries the controls.

Limits: the environment gate is version-sensitive, undocumented, and undoable by user settings as said. The documented
inbound refusal and the discovery denies do not alone prove outbound isolation when a peer address is already known and
`SendMessage` stays enabled; the probe measures the outbound side too (`out-to-raw`: a controlled sender is told
"Cross-session messaging is not available in this session"). Re-run
`packages/agent-host/scripts/probe-cross-session.mts` before SDK/CLI upgrades: it addresses the receiver by the name it
registered (the CLI never routes a session UUID), runs the controlled cases, the mixed ones, and two uncontrolled
controls that show it can see a leak. Unit tests check constructed options; the live probe supplies bounded runtime
evidence. This is a provider-messaging boundary, not OS isolation: commands with the user's permissions can still access
same-user files and sockets, and processes started outside Centralu are not configured by this adapter.

## What each session's tools can do (#382)

One place for what each kind of session can call and when the person is asked. Each piece was
decided in its own issue; this is the whole matrix, audited against the code before 1.0.

### Which tools a session has

The host gives a session one profile (`toolProfileFor` in `sessions/tool-profiles.ts`, asked through
`SessionManager.toolProfileOf`), and the profile
decides both which tools the session sees and which calls run (`profileAllows` in
`sessions/orchestrator-tools.ts`). Claude's in-process server is built from the profile
(`adapters/claude/orchestrator-mcp.ts`, `toolDefsFor`); Codex calls through the bridge, and the host
checks the profile again on every call (`SessionManager.runOrchestratorTool`), so a name the
session was not given is refused even when the bridge asks for it. The arguments are checked once
for both paths, against the tool's one schema (`TOOL_ARGS`, #850): Claude's server checks them against
the definition it shows, and the bridge hands them over unchecked. The bridge connects with a
credential for its own session's bridge calls, not with the host's token (owner question 4; "The
front door" below).

| Profile | Which sessions | What its tools see |
|---|---|---|
| `orchestrator` | The central orchestrator | Every session |
| `scoped` | A coordinating session | Its member sessions |
| `builder` | An app's builder session | Its own app (`check`) |
| `reader` | Every other session in a project (always: "Let sessions look at other sessions" is no longer a setting, owner decision 2026-10-20, and a stored "off" is not read) | From a trusted project, reads every project's ordinary sessions on this computer and the linked machines (not an orchestrator's, a coordinator's or an app's); from an untrusted one, its own project only (#984); acts only on the agents it started (`start_agent`: the project's trust under `normal`, a consent card under `safe`, #673) and another project only through a consent card |
| none | A session with no project, and an agent an app started (`run_agent`) | No Centralu server at all |

The worktree manager's profile (`manager`: list, read and send to its worktree sessions, propose one, delete a merged
one) was folded into ordinary sessions (#561 part 3): a session starts worktree agents itself with `start_agent`, works
with them through `agent_session`, and removes an idle child with `agent_session` `delete`. The parent decides in every preset; local work is
set aside with the archived session before removal (#608). A former manager is an ordinary `reader` that owns the worktree sessions it held (store v48).

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
| `answer_question` | yes | — | — | — | — |
| `recall` | yes | — | — | yes | — |
| `app_guide` | yes | — | — | yes | — |
| `update_session_settings` | yes | — | — | — | — |
| `create_project` | yes | — | — | — | — |
| `add_project` | yes | — | — | — | — |
| `list_machines` | yes | — | — | — | — |
| `add_machine` | yes | — | — | — | — |
| `install_machine` | yes | — | — | — | — |
| `remove_machine` | yes | — | — | — | — |
| `reconnect_machine` | yes | — | — | — | — |
| `set_machine_auto_reconnect` | yes | — | — | — | — |
| `set_machine_autostart` | yes | — | — | — | — |
| `disconnect_machine` | yes | — | — | — | — |
| `rollback_machine` | yes | — | — | — | — |
| `uninstall_machine` | yes | — | — | — | — |
| `machine_activity` | yes | — | — | — | — |
| `list_ssh_hosts` | yes | — | — | — | — |
| `get_preferences` | yes | — | — | — | — |
| `set_preferences` | yes | — | — | — | — |
| `apply_agent_versions` | yes | — | — | — | — |
| `list_archive` | yes | — | — | — | — |
| `restore_archived` | yes | — | — | — | — |
| `archive_subagent_steps` | yes | — | — | — | — |
| `delete_session` | yes | — | — | — | — |
| `rename_session` | yes | — | — | — | — |
| `clear_background_tasks` | yes | — | — | — | — |
| `agent_status` | yes | — | — | — | — |
| `agent_models` | yes | — | — | — | — |
| `project_git_status` | yes | — | — | — | — |
| `search_project_files` | yes | — | — | — | — |
| `delete_archived` | yes | — | — | — | — |
| `delete_all_archived` | yes | — | — | — | — |
| `list_projects` | yes | — | — | — | — |
| `set_project_trust` | yes | — | — | — | — |
| `list_approval_rules` | yes | — | — | — | — |
| `remove_approval_rule` | yes | — | — | — | — |
| `list_app_grants` | yes | — | — | — | — |
| `forget_app_answer` | yes | — | — | — | — |
| `revoke_project_consent` | yes | — | — | — | — |
| `share_app` | yes | — | — | — | — |
| `list_app_versions` | yes | — | — | — | — |
| `restore_app_version` | yes | — | — | — | — |
| `restart_app` | yes | — | — | — | — |
| `check_app` | yes | — | — | — | — |
| `list_app_runs` | yes | — | — | — | — |
| `list_app_errors` | yes | — | — | — | — |
| `app_usage` | yes | — | — | — | — |
| `remove_app` | yes | — | — | — | — |
| `set_agent_limits` | yes | — | — | — | — |
| `create_session` | yes | — | — | — | — |
| `handoff_session` | yes | — | — | — | — |
| `usage_history` | yes | — | — | — | — |
| `propose_skill` | yes | — | — | — | — |
| `propose_mcp_server` | yes | — | — | — | — |
| `check` | — | — | yes | — | — |
| `create_app` | yes | — | — | — | — |
| `ask_project` | — | — | — | yes | — |
| `start_agent` | yes | — | — | yes | — |
| `agent_session` | yes | — | — | yes | — |
| `find_apps` | yes | — | — | yes | — |
| `attach_app` | yes | — | — | yes | — |
| `detach_app` | yes | — | — | yes | — |
| `mail` | yes | — | — | yes | — |
| `compact_self` | yes | — | — | yes | — |
<!-- tool-matrix:end -->

`usage_history` ([agent-host.md](agent-host.md) §6.2) is the orchestrator's alone, a rare command, and read-only: it returns token counts, cache hit
rates and the limit windows' percentages kept on this computer, with the names of sessions and projects and no conversation content.

**The mailbox (#1347, [plans/mailbox.md](plans/mailbox.md) §9).** The sender of a post is always what the host knows: the session
whose tool called, the person for the window's `mail.*` calls, Centralu for its own; no argument of a call names one. Who may write to
whom is `mail/relations.ts` (§9.1): a session to the sessions it started, the one that started it and the person; the orchestrator
to any session; any session to the orchestrator, a new thread too (3.11, below); the person and Centralu to any session here; nobody to an app before slice 7; an app to a session that called it; and nobody, the person and Centralu included, to a session whose seat has no `mail` tool (a coordinator, a builder, an app's agent, a session outside a project), refused as `no_mailbox` because the wake names a call it cannot make. A
session that runs `auto` holds, without waking, what another session or an app that is only in a thread sends it (§7.7), and the person
releases it. What another party wrote reaches a model only inside the wake frame (`mail/frame.ts`) or the `mail` tool's `read`, both
quoting every line (U+2028, U+2029 and U+0085 included) behind `> `, escaping the frame's tags, and naming the sender by Centralu's
word for how it stands to the reader. The `mail.*` methods are the window's: they are not in the orchestrator's window-call list, and
the `mail` tool is the ordinary session's and the orchestrator's alone (matrix above), which runs it as a command behind `centralu_run` and is told of mail in that form, because it owns the threads `send_to_session` opens (slice 3); a coordinator, a builder and an app's agent are not parties of the mailbox. The delivery stamps its input as Centralu's channel, and sends it
as the CLI's own input, never as a message of the person's.

**A session asking the orchestrator (#1447, [plans/mailbox.md](plans/mailbox.md) §9.7).** Any session of this host may open a thread to the orchestrator
(`mail send` with `to: "orchestrator"`, an `assign`): the session owns it and the orchestrator is its assignee. The request is a session's text, so it
is not the person's word, and these follow. (1) Its words never go inline: the wake lists host fields and calls the sender "a session asking you
for something", and `mail read` quotes the words under a header Centralu writes from its own record (the session's name, its project, whether the
project is trusted). The words are read in the turn mail starts for the request and in no other: read in the person's turn, or in another request's, they would be a session's
words in a turn that has no card for them, so `mail read` gives only who the request is from there, and `mail inbox` lists a request by that header and not by the
subject the session wrote. (2) In a turn whose thread is such a request, every step of the orchestrator that is not on a short list of reading acts
(`sessions/asked-acts.ts`: reads, and answering in the request's own thread) raises the person's card first, naming the session and its project, under
every preset (`alwaysAsk`, so `auto` does not answer it), Allow or Deny only (`ORCHESTRATOR_CHANGE`); the list fails closed, so a command added later
asks until it is listed as a read. That is three doors, each closed where every call passes through it: Centralu's own tools and commands (`runParsed`, on both CLIs);
an attached app's tools (`SessionApps`' `call`, on both CLIs: a request could otherwise have the orchestrator call a project app's `merge_when_green`); and the CLI's own
tools, its shell, file edits, fetches and the rest (Claude: a `PreToolUse` hook, `adapters/claude/request-hook.ts`, which the CLI runs before every tool call in every permission mode and whose
decision stands in for its own question, so the person is asked about each step whatever the preset, and an "always" the person once saved for such a step is not consulted. A narrower
permission mode alone was tried and is not enough: a tool that needs no permission never reaches the CLI's permission callback in it, and the review of #1516 ran a subagent and a cron prompt
through it unasked). A request's turn is refused, without a question, the tools that go on after the turn: a subagent, a prompt scheduled for later, a watched command
(`OUTLIVES_THE_TURN`) and a command started in the background, since the person's card belongs to the turn and what they start would run later with no asker. The card shows a step of the CLI's own whole (a
file's content, an edit's text, a message), refusing one over 6,000 characters; only Centralu's own tools have their long free text cut. The Allow is for that one step: the
cards the step would raise itself meanwhile are covered by it (`HostCards.cover`, kept by the call's own async work and ended with the call or its signal), so there is one
card, and no "always" is offered or kept; an Allow that arrives after the turn it was asked in ended (also when the thread's next turn has begun) runs nothing. The card shows every argument whole except long free text of
Centralu's own tools, which is cut and says how long it was; a step too long to show whole is refused, not asked about in part. **What the orchestrator has read, and who reads it after.** Reading needs
no card, but the orchestrator writes to sessions and the session reads what it wrote, and its conversation keeps what it read, so a read could hand a session what it cannot read itself. Reads stay free. The host
remembers the scope of every read of the orchestrator's whole conversation (`sessions/asked-reach.ts`, `AskedGate`), in the person's own turns, in other sessions' requests and across compaction (a summary can carry the data), and only a new
conversation clears it; a conversation the host did not see begin (the host restarted, a kept process was adopted), or one that starts from a summary of an earlier conversation handed over in the prompt (the tool was switched, and the summary carries the orchestrator's own answers), is not known to have read nothing, and counts as having read everything. The scopes are judged
against the reach of whoever asks at the moment words are written. What counts is an allowlist, fail closed: only a call that gives back nothing anybody read (the CLI's `Write`, `Edit`, `TodoWrite`, a `mail` that sends, replies, closes or marks handled, `compact_self`) or whose scope is exact
(`Read`, `Grep` and `Glob` by path, `agent_session` `status` or `wait` of a named session, a named project, a mail thread, read or updated) is classified; every other tool, a name the host has not heard of included, counts as reading everything: a Bash or PowerShell command, a fetch, a search, a tool of an attached app (also one
the app marks read-only, which is never asked about) or of another MCP server, `ask_project` naming no project, a worker's reply (`agent_session` send or answer, `start_agent`), the mail inbox, `agent_session` `list` (it ignores the session named and lists every worker of every project), a list or a check of anything else. A `mail` `update` gives back the thread's state, and its next step only when the call set it, so it is judged by its thread as a read is. The person's answer to `AskUserQuestion` counts in a request's turn (the asker could have got the person to type something and receive it with no card); in the person's own turn it is the person's word to the orchestrator and does not. A path is pinned to where it was when it was read, so a link swapped afterwards does not change what was read. A step is noted after it is judged, so what it gives back is not in its own card. Out of reach for a session: a file outside its folders (its working folder, its project's folder, its worktree, what another
project handed it back; a path is judged as the file system has it, links followed; a relative path, a pattern aimed elsewhere or a path that climbs out counts as outside), a conversation of another project (`read_session`, `agent_session`
status), anything across projects (`recall`, `list_sessions`, `list_archive`, `machine_activity`), another project's state or none named (`project_git_status`, `list_app_runs`, `list_app_errors`, `app_usage`), and a mail thread other than its own request (`mail read`).
**In a request's turn** (and only there: in the person's own turns the orchestrator writes to its workers as before, with no card, since the asker cannot start those turns), once the conversation has read something out of the asker's reach, every word to a
session raises the person's card with the whole text, naming the asker and the read: `mail` `reply`, `update` and `close`, in the request's thread or any other, and `mail send` (a new thread to the asker included); a thread id is taken trimmed, as the
mail tool takes it. Other steps that pass words on show them whole as well. Deny sends nothing, and a text too long for the card is refused. Marking the thread handled, and mail to the person, stay free. Expect most replies to carry a card in practice; the
limit of 5 words an hour bounds that. This replaces "read grants never move across" (§9.7, "What it does not grant") with a gate on the way back.
Under a preset that asks about a read, a read the CLI itself asks about in a request's turn is the host's card (Allow or Deny, naming the session), not the CLI's own with its "always". Whose request the turn is is fixed when the turn begins
(`MailTurns`), so the session going to the trash, or the thread passing to the person, does not lift the gate or unhide a held request. A turn that is not a request (the person's,
or a thread the person gave) is as it was. **Where the orchestrator's tool cannot put each step of its own to the host** (`gatesSteps`; Codex, whose per-turn approval policy
is not yet measured here), a session cannot ask the orchestrator at all, in a thread it opened before as well: the write is refused with a reason, because its shell and edits could not be put to the person.
**Not covered, and named:** a turn that a relayed report starts (the old path of a kept process) belongs to no thread, so a request's words do not reach it; an app tool its app marks read-only
(`readOnlyHint`) is not asked about, on the app's word, as for every session; `read_session` and `recall` of the asking session show what it wrote, so the words are reachable by them in any turn
(reading needs no card, §9.7); a step whose card would pass 6,000 characters (a `Write` of more than about 6 KB) is refused, with no way through but smaller parts; what the conversation has read is kept in memory, so after a host swap or restart it is treated as having read everything (every word to a session in a request asks) until a new conversation begins; a turn that an old build's kept process was already in when this build took it over has no hook until it restarts; the output of a command the person allowed can start a turn of the CLI's own
later, as the output of any command can (a command started in the background is refused in a request's turn, since it would start that turn on purpose). (3) Limits:
a request from a project nobody trusted is held (`policy`) until the person releases it in the Inbox, and `mail inbox` and `mail read` show the orchestrator none of
its words meanwhile, whether or not the hold is written yet, while marking it handled, answering and closing it are refused; one request is open at a time and at most 5 words an hour (a request's first word and every word written into it after, so a follow-up in an answered request is no way round the
limit), both counted over the sessions of the asker's project and the sessions under its root session, so starting sessions does not multiply them (a refusal names the open
request only when it is the session's own). The sessions the orchestrator itself started are not one group: the walk up to the root stops before the orchestrator, so its sessions in
other projects each have their own request and their own five an hour. Nothing moves across with the answer: the asking session gets back only what the orchestrator posts in the thread, and the end of the
orchestrator's turn is reported in Centralu's words alone, never with the orchestrator's last response (which may be addressed to the person) or a pointer to its conversation. A linked machine's sessions asking the hub's orchestrator are slice 4's (§9.7, "Linked machines").

`handoff_session` (#694) is the orchestrator's alone, and among its commands the one that acts on another session's
place in the person's work: it starts a successor from a note and moves the original's live children to it. Its
authority is checked before anything moves (`HandoffFlow`; `moveChildren` checks none itself): the central
orchestrator, a project's ordinary session of this computer in its view, not mid-turn, and the person's card unless the
orchestrator is `auto` or the handoff guards nothing (#1509, owner 2026-10-24): the session is at rest (the same check) and the
preset the successor takes, the original's, is within the orchestrator's own (`HandoffFlow.covered`, read again before anything
starts and where the successor starts, so a preset raised meanwhile, while an agent wrote its note too, is not handed off unasked). The original stays, so nothing is lost, and the
orchestrator hands over no power it lacks. A session above the orchestrator's preset (a `safe` orchestrator and a `normal`
session, or a `normal` orchestrator and an `auto` one) still asks. A covered handoff can create a fresh session in an untrusted
project without a card, as `send_to_session` already reaches that project's sessions without one; the successor runs under the
original's preset, and the project's trust gates what it may do as it does for the original. What injected text in the orchestrator's context can reach depends on that consent: under
`normal` or `safe`, a card for each handoff, and after the person answered "always" on one, handoffs of any eligible
session without a card for as long as the host serves that orchestrator; under `auto`, handoffs of any eligible session
with only a log line (`[permissions] … session_handoff of <id> … allowed`). In every case it cannot reach an ineligible
session, a session mid-turn, a deletion, or a preset above the original's. The receiving tool is checked before the card
(an unknown, uninstalled or signed-out tool is refused without one), every name on the card is JSON-quoted, the
orchestrator's extra words are cut at 400 characters with the cut said, and "always" is recorded only once the call has
passed every check after the card. Refusals are logged with the caller and the target, and under `auto` the allowance
is logged once, by the call that holds the session (#797), so a burst of calls logs one "allowed" and the refusals.

The note defaults to the stored record, so a session's own drift does not write it. The record labels every row
another session, an app or a script sent (`from`, `fromApp`, `fromScript`: a child's report, a parent's or orchestrator's instruction, an app's
message, a script's first message) with its source and carries its text as one JSON string, as read_session does (#120, #121); only the person's
rows are `[user]`. That holds per line, as the successor reads the file, not only per row (#797): a row starts only at
the start of a line, and every later line of any row's text is indented, so the session's own multi-line reply or
compaction summary cannot make a line that starts with `[user]`. A tool's name and title (a multi-line command, a
heredoc) and paths are kept to one line with control characters escaped, and the predecessor's name is JSON-quoted in
the record's header and instructions and in the successor's opening, since a name can hold a newline. The successor's opening is stored and shown as the orchestrator's message (`from`), not the
person's. In agent mode the request goes in as the orchestrator's message and the reply is read from the store after
the turn ends. The original is never deleted, and the successor runs under the original's preset, never the
orchestrator's.

**`create_session`** (#838) starts the session under the orchestrator's own preset, `normal` at most (`safe` stays
`safe`, `auto` gets `normal`, as before), on this computer and on a linked machine alike, and its first message is
stored and shown as the orchestrator's (`from`), not the person's. It was `normal` whatever the orchestrator ran
under, with the instruction recorded as the person's, so a `safe` orchestrator that read a planted instruction could
start a `normal` session carrying it without a card.

**`start_agent` on a linked machine** (#1038) runs the child there under the caller's preset. A `normal` or `safe`
caller's is carried as it is, behind the card naming the machine, raised every time (`askHost`'s `alwaysAsk`) with no
"always": nothing is remembered for another machine's project.

An `auto` caller's child runs under `auto` there too (#1273, owner decision 2026-10-19), and then no card is raised: the
person let that session act without asking, and the orchestrator's own remote work otherwise went back to a
hand-written script that made `auto` sessions there directly. What is carried is the caller's preset only, as
`agents.createSession`'s `fromHub: { callerPreset }`; the machine decides. It takes `auto` that way only while its own
Settings → "Allow auto from a linked computer" switch is on (`UiPreferences.hubAuto`, on by default, so a person can
refuse it on a machine they share; a record that cannot be read, or a value that is not true or false, reads as off,
#1273 review); it reads the switch at each start (`presetFromHub`), and anything else sent with
`fromHub` runs `normal` at most there. The machine does not tell the hub's call from any other holder of its token:
whoever holds the token could already ask for `auto` outright (`permissionPreset`), so `fromHub` gives no one more. The hub asks the
machine first (`host.hubAuto`): a machine whose switch is off keeps the card, which says the child runs under `normal`
and why (`autoWithheld: "machine_off"`), and so does a machine from before #1273 (`"older"`), which drops `fromHub`
and keeps `normal`; the start's answer to the caller says the same, never silently. A switch turned off between the
hub's question and the start starts nothing there: the child made without a card is given no task and goes to that
machine's session archive. The child is never above its caller (#1273 review): the preset is decided from the caller as it is once
the machine has answered, so the card states the preset the child will get; the caller is read again after the card
(a caller lowered while it stood starts nothing) and once the machine has made the child (one made above the caller as
it is then is given no task and goes to that machine's session archive); and `agent_session send` refuses work to a child whose
preset (kept in the hub's record, `RemoteAgent.preset`) is above the caller's, as a local child's send does. The child's row and header show its preset on both machines (`SessionInfo.startedFromHub`).
**Residual:** the hub holds the machine's token, so the switch is the person's say over what Centralu's own
start_agent carries, not a wall against a hub that is not Centralu. An `auto` child there runs as `auto` runs on that
computer (Codex's `auto` is `danger-full-access` there), with that computer's logins, and an `auto` caller's starts
there are bounded only as its local ones are (the project's ceiling, unlimited under `auto` unless the person set one,
and the agent depth), no longer by a card each. A missing switch reads as on (the default); a damaged one as off. The hub's Settings → Machines sets the switch of
each linked machine over the link (`host.setHubAuto`), so a machine with no window of its own (`centralu serve`) can be
set too, and so the hub can also turn back on a switch a person turned off at that machine; the machine still reads it at each start, and setting it from the hub is no boundary against the hub (any
holder of the token could ask for `auto` outright). A start interrupted between the machine making the child and its
task (a hub restart, a link drop) leaves an idle session there under the child's preset, with no task, which nothing
on the hub follows; nothing runs in it until a person types into it.

The machine keeps the child one level below the caller in the agent
depth (`agentDepth`); a machine whose build would drop it (it has no `projects.origin`) is refused, so two machines
linked both ways cannot start each other's sessions past the setting. The checkout is matched by its origin's
repository (`gitRemoteKey`): a local-path remote never matches across machines, and answers show the repository,
never the address as written, which can carry a token. Its caller may answer a question card of the turn it gave it
(`agent_session answer`), never an approval card there, `auto` or not: what that computer runs is allowed there. A
turn is the one it gave only on evidence: the machine's record of this hub's own instruction, taken while no other
turn ran there, with no other message since and not since the hub last lost sight of the child (a link drop, a
restart). One gate (`RemoteAgents.gate`) stands between the child and every path to its caller (status, wait, answer,
send, a card's notice, the linked report's text and preview), so the person's own turn there is never read, answered
or reported as the caller's: the caller gets only the fact and the state word.

**Proposals** (`propose_mcp_server`, `propose_skill`, #838) are approved by name, and approval installs or saves what
is stored when the person presses it. A proposal under the name of one still waiting is refused, never replaced: a
second one used to swap the command or text the person was reading for one they never saw. The person dismisses the
first to free the name.

Names reach the model's text on one line (#838): `list_sessions` keeps a session's, project's and machine's name to
one line, a session's new name is made one line when it is set, and a builder's role prompt quotes its app's manifest
name, so a name with a line break cannot add a row or a rule of its own.

A reader's `read_session` without an id lists its project's sessions; that is why it has no
`list_sessions`. Its read tools see only its own project (`orchestratorToolsFor(…, ownProject)` in `sessions/orchestrator-seat.ts`), and
the object behind them refuses directing calls (`readerToolsFor`).

An ordinary reader's `update_centralu` reaches the host's existing update service only after a host-owned consent card. “Always”
lasts for that session while this host runs; it is not a project grant and it never changes the person's
automatic-update preference. In the commands tier the orchestrator reaches it through `centralu_run`, while the
reader is offered its compact definition, deferred behind tool search on Claude because updates are rare.
Its `apply` action (#665) relaunches the person's window into the installed build, and is decided by the caller's own
preset in every profile, orchestrator included: `auto` applies, `normal` asks on every call until "always" (kept
apart from check and install), `safe` and app agents are refused. The window still makes every check its "Apply now"
makes, so an agent can only ask for what the person could click. `normal` asks no card while the person's Automatic updates are
on and nothing but the caller's own turn is running (#1509, `UpdatesAsked.updateAtRest`, main.ts `updateAtRest`): the window's own
auto-apply would relaunch at that moment. It is judged after a window said it is ready and again right before the relaunch (`update_apply_go.unasked`, on which the window also waits
out someone typing, as its own auto-apply does), and remembers nothing, except that a card-free relaunch that failed brings the card back for that installed version, for every session, so an agent cannot retry it in a loop with no one asked.

**The rare-commands tier** (#512, the default since 2026-10-12). The matrix is drawn as if every command were a tool.
The host takes the orchestrator's
`create_app`, `propose_skill` and `propose_mcp_server` out of its tool list
and gives it `centralu_commands`, `centralu_help` and `centralu_run` instead; no other seat changes. Who
may run what does not change: `centralu_run` lists and runs only the commands `profileAllows` gives the
seat (`commandsFor`), a command's own name is refused like any tool the seat was not shown, and a run is
checked against the command's own schema before it goes through the same runner, so each command keeps
its gates and its card (the screen re-reads both proposal lists on a `centralu_run` it cannot name). The
three are Centralu tools (`mcp__centralu__*`), allowed under every preset like the rest.
`sessions/command-tier.test.ts` checks, profile by profile, that the tier changes how a seat reaches a
command and never which commands it reaches. The measurement is in
[tool-cost.md](tool-cost.md) §9.

Apps are separate from this profile. Decision 4 ([apps.md](apps.md) §9.1) gives the orchestrator the
user-folder apps, a project's sessions that project's apps, and a builder its own app (`givesApp` in
`sessions/session-apps.ts`); a reader adds others with `attach_app` (§9.4), and the orchestrator adds the
root apps of trusted projects the same way (#1141: a project whose folder holds the manifest is an app, and
its trust is the project's; #1205: as commands behind `centralu_run`, and never a project's inner app). An
agent an app started gets none (`appsFor`). **An untrusted project's apps attach nowhere** (owner,
#1141): its root app and the apps inside it, to no session, its own project's included, under every
preset, `auto` too; #603's opening no longer applies to apps, and the runtime refuses them for every
caller (`blocker` in `apps/external/runtime.ts`). The project's sessions still run and read its code.
A name a session has seen an app under (`app-<id>`) stays bound to that app for the session's life
(`session_app_names:<session>`), so a later app of the same id, a repository's included, cannot take
calls meant for another (`SessionAppsHub.named`).

### The `edits` preset (#1525, owner 2026-10-24)

A fourth preset, between `normal` and `auto` (`safe` < `normal` < `edits` < `auto`). **`edits` is `normal` plus one
grant**: a file edit inside the session's project folder (or its worktree) raises no card. Everything else is
`normal`'s, in every row of the table below: commands, deletes, paths outside the folder, network access and runs
outside the sandbox ask; the person's own bypass applies as under `normal`, and `edits` never asks more than `normal`
would. `normal` keeps its meaning (the person approves each step).

- **Preset, not a hidden default.** A default that made `normal` accept edits in a trusted project would put a word
  on the picker that is not true of the session, and an explicit `normal` could not be told from the default. So the
  picker lists `edits` ("No card in project"), and the **default** is what changed: the window names the preset when the
  person starts a session without choosing one, `edits` in a **trusted** project and `normal` in an untrusted one
  (`defaultPresetFor`, `@cc/core`, read in `createSession` of the store). A preset named in the start, the settings menu,
  a handoff or a fork always wins and is never raised. The host's own default stays `normal`, so a client that names none
  (a script, the limited credential, an older window) never gets `edits` unasked, and naming it as the limited credential
  does asks first (`presetAbove`, `transport/method-rights.ts`). A project on a linked machine keeps `normal` as the
  default: that machine may run a build from before `edits`, which refuses a value it does not know. The stored and shown
  preset is the one the session runs under. There is no per-project default preset to override (the "per project" choice
  of #1525 is the project's trust).
- **Mapping to Claude.** Not `acceptEdits`. The SDK's mode also approves `rm`, `rmdir`, `mv`, `cp`, `sed`, `mkdir` and
  `touch` inside the working directory (Claude Code's documentation, "acceptEdits"), which would let deletes and
  commands through. `edits` launches exactly as `normal` does (the trusted settings mode, else `default`) and `canUseTool`
  allows `Edit`, `MultiEdit`, `Write` and `NotebookEdit` whose target is inside the session's folder
  (`adapters/edit-grant.ts`, the shape of the read grant, #371). A person's `acceptEdits` or bypass setting stays as it is
  (it decides before `canUseTool`). **The person's own `ask` rules win**: when their settings (the sources the session
  reads, the policy tier included) have an `ask` rule for `Edit`, `Write`, `MultiEdit` or `NotebookEdit`, or the settings
  cannot be read, the session has no grant at all (`editAskRuleExists`; the rule's path pattern is the CLI's syntax and is
  not matched, so `ask: ["Write(secret/**)"]` leaves every edit of that session asking). An ask the CLI says a rule forced
  (`matchedAskRule`) is a card too, and so is an ask whose `decisionReason` is anything but empty or the permission mode asking: the SDK documents it as free text, so only a short allowlist of known benign reasons
  grants (`benignAskReason`) and an unknown or reworded reason fails closed. These two options are a second line: measured on Claude Code 2.1.296, an `ask` rule reached `canUseTool` with
  both undefined, so the card for a plain ask rule comes only from `editAskRuleExists`.
- **Mapping to Codex.** Codex has no mode that accepts patches and asks for commands: its approval policies gate the
  sandbox boundary, not the kind of action (`on-request` runs sandboxed commands without a card). So `edits` is
  `normal`'s launch (the person's own policy and sandbox, network off) and the adapter answers an
  `item/fileChange/requestApproval` (or the older `applyPatchApproval`) with accept when every change of the patch is an add or an update inside the folder
  (`adapters/codex/server-requests.ts`, `adapters/edit-grant.ts`). A delete, a move, a request that names extra access
  (`grantRoot`, a `reason`), or a path outside asks. Under Codex's default
  config (workspace-write, on-request) in-folder patches already ran without a card, so there `edits` and `normal`
  differ only where the person's config asks.
- **What is never granted.** The folder is the session's `cwd` after symlinks are resolved (a link out of it is
  outside, and so is a link whose target does not exist yet), compared by path segment (`/proj-other` is not inside
  `/proj`). A folder that is the person's home folder, holds it, or is the root of any disk gets no grant. Inside the folder, the names that
  decide what runs or what is allowed still ask, at any depth and in any case: `.git`, `.gitconfig`, `.gitmodules`,
  `.githooks`, `.husky`, `.pre-commit-config.yaml`, `.github/workflows`, `.claude`, `.claude.json`, `.codex`, `.agents`,
  `.mcp.json`, `.vscode`, `.idea`, `.devcontainer`, `.centralu`, the shell startup files (`.bashrc`, `.zshrc`, `.profile`,
  ...), `.envrc`, `.ripgreprc`, the package managers' config (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`,
  `.cargo/config`, `.cargo/config.toml`) and `node_modules` (a hard link there reaches other projects). `CLAUDE.md` and `AGENTS.md` stay
  editable. A segment with a `:` asks (a Windows stream such as
  `.mcp.json::$DATA` writes the file it names). A path that cannot be resolved asks. The check reads the disk once,
  before the write: another process that swaps a link in between is not stopped by it. A person who picks `edits` in an
  untrusted project gets the grant too (their choice wins); only the default is tied to trust. The preset is read at each call: changing between `normal` and `edits` replaces no
  process (`launchPreset`, `SessionHandle.setPermissionPreset`) and takes effect in the next call, while a change that alters
  the launch (to or from `safe` or `auto`) still restarts at the end of the turn.
  **What the grant is not:** edits to project files are code the person later runs. Under `edits`, an `allow` rule (or the
  person's bypass) for a command that runs project code (`npm test`, `make`, a script) amounts to running anything the agent
  wrote into the project, with no card for it. The protected names narrow where that starts; they do not close it.
- **Agent-started sessions.** The default applies only to a session the person's window starts. `start_agent`'s child
  gets the caller's preset, never above it (`presetWithin`, rank updated), so a `normal` caller's child is `normal`
  in a trusted project and an `edits` caller's is `edits`. `edits` is treated as `normal` by the consent (the project's
  trust is a `normal` or `edits` caller's consent, #673), the ceiling (4, `auto` has none), `ask_project`, the answer
  rules and `update_centralu`. A linked machine's child (`start_agent` with `machine`, `create_session`, the hub's
  `normal` at most) is `normal` for an `edits` caller, and the caller's preset that `fromHub` carries goes as `normal` too
  (`carriedPreset`, `makeChild`): `edits` is never put on the link, so an older machine never sees a value it does not know. A build since #1171 reads a stored `edits` as `safe` (its store parses unknown presets
  to `safe`), and an earlier one passes it through as an unknown preset that asks like `normal`: neither asks less.

### When the person is asked

"Open" means the calling session's own `auto` preset opens that permission boundary (#603),
read at call time by `SessionManager.autoBoundaryOpen`; auto allowances are logged, without
writing remembered consents. Tool profiles, same-project scope, valid inputs, app sharing,
and the target's own preset still apply. Global bypass under `normal` does not open host boundaries.
"Allowed" runs without a card, "asks" raises a card in the calling session, "refused" fails the call
without asking. "Bypass" is the person's own global setting (`defaultMode: "bypassPermissions"` in
`~/.claude/settings.json`; `approval_policy = "never"` in `~/.codex/config.toml`), which only the
`normal` and `edits` presets read. The table has no `edits` column: `edits` is the `normal` column in every row, except
the row for a file edit inside the session's folder, where it is allowed.

For Claude, `normal` passes the trusted settings mode explicitly, falling back to `default` when no
valid mode is configured or settings cannot be read (#578). Omitting the SDK mode can now select
Claude's automatic classifier, so omission is not a manual-approval guarantee. The SDK's trust filter
rejects escalating modes from committed project settings before the adapter uses them. An explicit
personal bypass remains intentional: it auto-approves before `canUseTool`, as the table below records.

Released betas since beta.1 omitted `--permission-mode` under `normal`. With the person's Claude Code
CLI >= 2.1.285 and a third-party provider or telemetry off, a headless session without a configured
mode overriding the default starts in auto mode: a classifier, rather than Centralu's approval,
decided tool use. Normal's v2 launch fingerprint makes the host refresh restart retained older
processes after adoption, at idle or when their current turn finishes (#589).

| Call | Claude `safe` | Claude `normal` | Claude `normal` + bypass | Claude `auto` | Codex `safe` | Codex `normal` | Codex `normal` + bypass | Codex `auto` | Enforced in |
|---|---|---|---|---|---|---|---|---|---|
| A Centralu tool the profile has | allowed | allowed | allowed | open | allowed | allowed | allowed | open | Claude: `canUseTool`, `isOrchestratorTool` and only when the session was given the server, checked before auto's refusal (`adapters/claude/session-cards.ts`). Codex: `default_tools_approval_mode: 'approve'` on the bridge, and an elicitation for it accepted only on a thread that has it (`adapters/codex/thread-servers.ts` `mcpConfig`, `adapters/codex/server-requests.ts` `onServerRequest`) |
| A Centralu tool the profile does not have | refused | refused | refused | refused | refused | refused | refused | refused | `profileAllows` (exposure and execution) |
| `read_session` and `recall` of the caller's own handoff lineage, archived ones included (#1487) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `ownLineage` in `orchestratorToolsFor` (`sessions/orchestrator-seat.ts`): the session's predecessor by its newest handoff marker, that one's, and so on (`HandoffMarkers.lineage`), whatever the project or whether live or in the session archive, and **nothing else of the archive**: any other archived session is refused as a missing one, and `recall` searches only these sessions' own messages in the archive (`searchSessions`, since the archive's search index is dropped). The chain also ends at a marker naming a session of another project, and `createSession` accepts `handoff.fromSessionId` only for a live session of the same project, so a forged marker cannot point a session at text it was never given. A session deleted for good ends the chain there, and a hub's view has no caller, so no lineage. Every line is the predecessor's, never the reader's own or the person's: `role: predecessor` for what it said, `predecessor: <id>` on each line, `[predecessor]` and `[person, to the predecessor]` in a hit's snippet, and a hit says "(your predecessor, archived)"; the answer opens by saying so. The note names the ids (`lineageLine`) and stays the only thing handed over |
| A file edit inside the session's folder (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`; a Codex patch that adds or updates files) (#1525) | asks | asks | allowed | open | asks | asks (or allowed, where the person's own policy and sandbox let a patch through) | allowed | open | **`edits` allows it**, with no card, for a path inside the folder (links resolved) that is under none of the protected names; a delete, a move, a command and every other path ask as under `normal`. `adapters/edit-grant.ts` (`insideFolder`), Claude `canUseTool` (`session-cards.ts`), Codex `item/fileChange/requestApproval` (`server-requests.ts`) |
| `ask_project`, first time for a pair of projects | asks (consent card) | asks | asks | open | asks | asks | asks | open | `ensureProjectAccess` in `SessionManager.askProject`; "always" is kept in `project_consents` |
| `ask_project` from a session at the agent depth (default 1: one that was itself started or asked) | refused | refused | refused | refused | refused | refused | refused | refused | `askGateError`, `agentDepthRefusal` (`prefs.agentDepth`, #867) |
| `ask_project` from an untrusted project | refused | refused | refused | open | refused | refused | refused | open | `askProject` (the caller's project trust, #382) |
| `ask_project` into an untrusted project, first time for the pair | asks (the card says it is not trusted) | asks | asks | open | asks | asks | asks | open | `ensureProjectAccess` (`to.trusted`), `projectAccessQuestion` |
| `start_agent`, first time for a session, trusted project | asks (consent card: once, always for this session, always for this project) | allowed (the project's trust is the consent, #673) | allowed | open | asks | allowed | allowed | open | `ensureAgentConsent` (`trustIsAgentConsent`) in `SessionManager.startAgent`; "always for this session" lives while the host serves it, "always for this project" is kept in `project_consents` (kind `agents`); a card past the setup bound stays, and the call answers `pending` (#673) |
| `start_agent` (or a fork) from a session at the agent depth (default 1: one that was itself started or asked) | refused | refused | refused | refused | refused | refused | refused | refused | `setUpAgent`, `agentStartGateError`, `forkTrustError` through `agentDepthRefusal` (`prefs.agentDepth`, 1–3, #867; `askProject` refuses the same sessions) |
| `start_agent` from an untrusted project | refused | refused | refused | open | refused | refused | refused | open | `startAgent` (the project's trust, #382) |
| `start_agent` with `machine` (a child on a linked machine, #1038, #1273) | asks every time, no "always"; the child runs under `safe` | asks every time; the child runs under `normal` | asks every time; `normal` | open: no card, the child runs under `auto` there while that machine's "Allow auto from a linked computer" is on; otherwise asks, the child under `normal`, the card saying why | asks; `safe` | asks; `normal` | asks; `normal` | open, as Claude `auto` (Codex's `auto` there is `danger-full-access`) | `RemoteAgents.startAgent` (`askHost` with `alwaysAsk`, the caller read again after the machine answered, after the card and after the child is made) and, on the machine, `presetFromHub` at each start; `agent_session send` refuses a child above its caller |
| `start_agent` past 4 running children in the project, default setting | refused | refused | refused | open | refused | refused | refused | open | `agentCeilingError` (`prefs.agentCeiling`; empty: auto unlimited, otherwise `AGENT_CEILING`; 0: unlimited) |
| `agent_session` on a session the caller did not start (except delete without a worktree) | refused | refused | refused | open | refused | refused | refused | open | `agentSession` (same project in every preset; ownership opens under auto) |
| `agent_session` delete without a worktree, a session the caller did not start | refused | refused | refused | refused | refused | refused | refused | refused | `agentSession` (#637): requires `askedBy` or `parentSessionId` equal to the caller in the same project. An owned child is moved to the session archive; mid-turn deletion requires the caller's own unsettled delegation and otherwise protects the person's turn/cards. |
| `agent_session` delete, an idle worktree child with uncommitted changes or commits absent from the trunk | allowed | allowed | allowed | allowed | allowed | allowed | allowed | allowed | `cleanUpWorktreeChild` (#608): the parent decides; patches and bundles follow the session into the archive before the worktree and branch are removed. Working children are refused; an idle process must be disposed successfully first. |
| A request (`agent_session` send, `ask_project`, `send_to_session`) to a session busy with a turn that is not the caller's, `ifBusy` `note` (#677) | refused | refused | refused | open | refused | refused | refused | open | `busyChoices`: the caller's own preset; a target CLI that takes mid-turn input; never into another caller's `ask_project` task. Without `ifBusy` the choices come back and nothing is sent |
| The same, `ifBusy` `queue` | allowed | allowed | allowed | allowed | allowed | allowed | allowed | allowed | `enqueue` / `drainQueue`: behind the request tool's own gates (ownership, the project-pair consent). At delivery they are read again with the caller's preset as it is then (`queuedGateError`): `ask_project`'s trust and depth, the target project still registered, and the pair's remembered consent when only `auto` let the request pass without one (marked on the stored row, `queued_requests.opened_by_auto`, so a host swap keeps the mark; a row an older build wrote is read as marked when the pair has no remembered consent); `agent_session`'s ownership and preset rule. A request kept for an `auto` caller when the person revokes the pair's consent or its project loses trust rests on `auto` alone from then on, and is marked so then (#838; `withdrawReaches`). Moving the caller off `auto`, or a handoff to a successor that is not `auto`, drops what only `auto` let through (`dropOpenedByAuto`). Delivered as the caller's new turn when the running one ends |
| The same, `ifBusy` `fork` / `fork_read` (not `ask_project`) | asks (start_agent's consent card) | allowed (the project's trust is the consent, #673) | allowed | open | asks | allowed | allowed | open | `forkFor`, `forkGateError`, `ensureAgentConsent`: start_agent's trust and ceiling (`auto` opens them), and its agent depth, which refuses under every preset including `auto` (#867); the lower of the two presets, `fork_read` at most `safe`; `fork` in a worktree of its own |
| `agent_session` answer / `answer_question`, a question in a turn the caller gave (#676) | allowed | allowed | allowed | allowed | allowed | allowed | allowed | allowed | `answerRoutedCard`: only while the caller owns the session's running turn (`turnOwners`) and the card stands; the person may answer first |
| `agent_session` answer / `answer_question`, an approval in a turn the caller gave (#676), target `normal` or `auto` | refused | refused | refused | open | refused | refused | refused | open | `answersApproval`: the caller's own preset at the answer; never an app agent or a host-raised card; allow or deny, never always |
| The same, target `safe` or an app's agent | refused | refused | refused | refused | refused | refused | refused | refused | `answersApproval` (#679 review): the caller's `auto` never raises the target's permissions; the caller is told only |
| `agent_session` send, to a child the person raised above the caller's preset | refused | refused | refused | refused | refused | refused | refused | refused | `agentSession` (`presetWithin`) |
| `handoff_session` (the orchestrator hands a session off, #694) | asks (a card naming the target, the receiving tool, the note's source, the new session's preset and the extra words, each quoted; "always" for this orchestrator while the host serves it, recorded only for a call that passed every check; an unknown or unusable tool is refused before the card), but none when the session is at rest and its preset, which the successor takes, is within the orchestrator's own (#1509, `HandoffFlow.covered`) | same | same | open | same | same | same | open | `HandoffFlow.handoff` (`sessions/handoff-flow.ts`) → `askHost`, an `other` card with `about: "session_handoff"`; the central orchestrator only (`profileAllows`, and the seat refuses any other view); the target must be a project's ordinary session of this computer in its view, not itself, an orchestrator or coordinator, an app's session or a worktree session, and not mid-turn (refused without a card, checked again after it); the original is never deleted, its live children move to the successor (`moveChildren`, scope `live`), and the successor keeps the original's preset |
| `create_project` (the orchestrator makes a new project, empty or a clone) | asks (a card with the full path and, for a clone, the repository, every time) | asks | asks | open | asks | asks | asks | open | `ProjectCreation.createProjectAsked` (`sessions/project-creation.ts`) → `askHost`; the folder is made only after "Create", and never over anything already there (`projectFolderTarget`, `makeProjectFolder`); by default in `~/Centralu`, a folder of the home that macOS does not protect, so making one raises no OS permission prompt (the Desktop did); a clone takes https, ssh and scp-like addresses only, never `ext::`, `file://` or a local path (`gitSourceError`), clones no submodules and never asks for a sign-in (`project-clone.ts`) |
| `add_project` (the orchestrator adds a folder that already exists, here or on a linked machine, #1220) | asks (a card with the machine, the full path, that it exists and is a folder, and whether it is a git repository with its `origin`, every time) | asks | asks | asks | asks | asks | asks | asks | `ProjectCreation.addFolderAsked` / `addFolderOnMachine` (`sessions/project-creation.ts`) → `askHost` with `alwaysAsk`: `auto` does not answer it, since the folder can be anything on that disk and, once a project, the orchestrator can start sessions in it. The facts are read on the folder's machine (`projects.inspect`, git config only, none of the repository's programs); a missing path, a file or a folder already a project is refused before the card, and on Allow the folder is registered as the sidebar's Add project registers it (`addProject`; on a linked machine that machine's `projects.add`), untrusted when new. The central orchestrator only, as a rare command behind `centralu_run` |
| `list_machines` (the orchestrator lists the linked machines, #1220) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | Reading only: the list `machines.list` answers (`links.list()`), named, with status, OS and shell, and whether it reconnects by itself; the central orchestrator only |
| `add_machine`, `install_machine` (install or update; an update never stops a turn it can see: with sessions in a turn the card says so, and one that cannot be read says that and Allow means "update when idle", #1399), `remove_machine`, `set_machine_autostart` (the orchestrator changes a linked machine, #1219) | asks (a card naming the machine or ssh target, what runs there and what the change does there and here, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `MachineFlow.run` (`sessions/machine-flow.ts`) → `askHost` with `alwaysAsk`, an `other` card with `about: "machine_change"` whose question is whole in `raw`; then the window's own call on the hub's links (`Links.add`, `install`, `update`, `remove`, `autostart`). `add_machine` opens no connection before the card: it shows what `ssh -G` resolves the target to (host, user, port, ProxyCommand or ProxyJump), and only after Allow does one BatchMode ssh probe it (`machines.probe`); a target that does not answer or runs nothing it can link is linked nowhere, with no second card. Refused before the card: a machine not linked, a target that is no ssh target or that `ssh -G` cannot read, a target, name or distro with a control or format character (Unicode Cc, Cf), a name already linked, and an install or update this computer cannot make (no installer, a development build, a command of the machine's own: `LinkedMachine.operationRefusal`). The central orchestrator only, as rare commands behind `centralu_run` |
| `reconnect_machine` on a machine away on its own with Auto reconnect on, `set_machine_auto_reconnect` turning Auto reconnect off, or on where it already is (#1219, #1341) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `MachineFlow.run` → `Links.reconnect`, `Links.setAutoReconnect`: what the Machines row's Reconnect and Auto reconnect switch do, which the window does not ask about either; nothing changes on the machine. The central orchestrator only |
| `reconnect_machine` on a machine the person disconnected or whose Auto reconnect is off and that is not connected, `set_machine_auto_reconnect` turning Auto reconnect back on (#1341) | asks (a card naming the machine and what connecting does: it connects over ssh with the person's keys; every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `MachineFlow.run` → `askHost` with `alwaysAsk`, an `other` card with `about: "machine_change"`, then the same `Links` call. An agent does not undo what the person chose by itself: only `machines.disconnect` leaves a machine `disconnected`, and a switch that is off is the person's choice that nothing reconnects the machine by itself, so an agent reconnecting it is that. A machine away on its own with the switch on is reconnected with no card, and one that is already connected is only answered as connected: no card, nothing done. A denied card changes nothing. The central orchestrator only |
| `delete_session` (the orchestrator moves a session that is not its own child to the session archive, #1219; the person's own "Archive session…" in the window is a different call, behind its dialog (`agents.archiveIfAtRest`, then `agents.deleteSession`), described after the table) | asks every time, whether or not anything is dropped (#1512: a caller under `safe` is the one an injected text is likeliest to steer) | asks when moving it drops something the archive does not bring back; no card for an idle session on this host that nobody waits on and that owes no report (#1512), and the answer says restore_archived brings it back | asks when moving it drops something the archive does not bring back; no card for an idle session on this host that nobody waits on and that owes no report (#1512), and the answer says restore_archived brings it back | asks when moving it drops something the archive does not bring back; no card for an idle session on this host that nobody waits on and that owes no report (#1512), and the answer says restore_archived brings it back | asks every time, whether or not anything is dropped (#1512: a caller under `safe` is the one an injected text is likeliest to steer) | asks when moving it drops something the archive does not bring back; no card for an idle session on this host that nobody waits on and that owes no report (#1512), and the answer says restore_archived brings it back | asks when moving it drops something the archive does not bring back; no card for an idle session on this host that nobody waits on and that owes no report (#1512), and the answer says restore_archived brings it back | asks when moving it drops something the archive does not bring back; no card for an idle session on this host that nobody waits on and that owes no report (#1512), and the answer says restore_archived brings it back | The card names the session, that the person started it when that is so, what restoring brings back, and what the host lets go of when it leaves that restoring does not: a caller waiting for its report, reports its children owe it, work it waits on, the start_agent cards it raised, what the person allowed it, the unfinished mail threads it is assigned or owns (restoring hands none back); no "always". `TrashFlow.deleteSession` (`sessions/trash-flow.ts`) → `askHost` with `alwaysAsk`, an `other` card with `about: "orchestrator_change"`. A move to the session archive is not fully undoable (`trashSessionOnce` drops the owed reports, delegations, read grants, agent consents and standing start_agent cards, and ends the process), so the card says what is lost for this session (`SessionTrash.lossesOf`). With or without a card the host decides at the last moment, in the step that moves the session and with nothing awaited between (`SessionTrash.trashIfQuiet`, the `onlyIf` of `trashShared`): it moves only if the session is still at rest (no turn, wake, restart or note held for it, no card, no background job running, no app waiting) and what it drops is what the card listed, so a message the person sent while the card stood keeps the session and its new turn is not cut. The window's own `agents.deleteSession` makes the move for a linked machine's session, which cannot be decided in the step: there the list is read again after Allow and the card is the safeguard. The two boxes of the window's delete are left unchecked (`deleteWorktree` and `deleteExternal` false): the session, its worktree and the tool's conversation file all stay; deleting for good is `delete_archived`'s card. Refused before the card: the caller itself, a session that is not a worker (an orchestrator or a coordinator is the person's), a child the caller started (`askedBy`: that is `agent_session` delete, which also settles its report and cleans up its worktree), a session working or waiting on an approval or a question (the person may be using it), a session with a background job still running (archiving it ends its process and the job with it, which restoring does not bring back; the person stops it first), a session on a machine that cannot be reached, and an id no session has. The central orchestrator only |
| `list_app_versions`, `list_app_runs`, `list_app_errors`, `app_usage` (the orchestrator reads how an app is doing, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `AppUpkeepFlow.run` (`sessions/app-upkeep-flow.ts`) → the window's own `apps.versions`, `apps.runs`, `apps.errors`, `apps.usage` through the router, so a linked machine's app is reached the way the window reaches it. Read only. What an app wrote (an error message, the last lines of its standard error, what it was called with, a commit subject or hash, a kept version's id and reason, and each line of a check's report; a linked machine's host writes the version fields) is the app's own text: each is one quoted line with control and format characters escaped, data to read and never an instruction. The central orchestrator only |
| `restore_app_version`, `restart_app`, `check_app` (the orchestrator looks after an app the way its screens do, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `AppUpkeepFlow.run` → `apps.restoreVersion`, `apps.restart`, `apps.check`. Each acts on an app whose code already runs here: a restore keeps the code it replaces as a version first, so it can be restored back (a project app is git's, and refused), a restart stops the app and starts nothing (a call in progress ends with it, as the window's Restart does; so both are refused while the run history shows a call in progress in the app from another session, screen or app), a check restarts it on its files as the building session's `check` does (a linked machine's app is refused: it runs on this computer's apps only). An imported app whose restored version asks for more than the person allowed asks them again (`apps.restoreVersion`). The central orchestrator only |
| `remove_app` (the orchestrator removes a user-folder app, #1219) | asks (a card naming the app and where it is, that its folder moves to `app-trash/` and is kept, that it is detached from every session, that anything calling it stops working, and that an import still waiting for review is forgotten; every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `AppUpkeepFlow.remove` → `askHost` with `alwaysAsk`, an `other` card with `about: "orchestrator_change"`; then the window's own `apps.remove`. Refused before the card: an app that does not exist or is named by two apps, and a project app (a file in the repository, withdrawn through git; `apps.remove` refuses it too). The app is read again after Allow: one removed meanwhile is answered as gone and nothing more is done. A denied card changes nothing. The central orchestrator only |
| `rename_session`, `clear_background_tasks` (the orchestrator does a session's housekeeping, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `HousekeepingFlow.run` (`sessions/housekeeping-flow.ts`) → the window's own `sessions.rename` and `agents.clearBackgroundTasks` through the router. Neither destroys anything: the answer quotes the old name so it can be set back, and only ended background tasks leave the list (a running one is the tool's to end; `agents.stopBackgroundTask` has no command). Refused before the call: itself, an orchestrator or a coordinator, an id no session has, a session on a machine that cannot be reached, and for a name an empty or over-long one, one with a control or format character, or one that begins with `[Centralu]` (how the host marks its own notices). The central orchestrator only |
| `agent_status`, `agent_models`, `project_git_status`, `search_project_files` (the orchestrator reads how the agent CLIs stand, a project's git state and its files, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `HousekeepingFlow.run` → `agents.detect`, `agents.usage`, `agents.models`, `projects.gitStatus`, `projects.origin`, `files.search`: read only, what the window shows. The account's fingerprint (`agents.account`) is not read. Names and paths come from the person's folder and are quoted as one line each; a query with a control or format character is refused. The central orchestrator only |
| `disconnect_machine` (the orchestrator closes a linked machine's link, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `MachineFlow.run` → `Links.disconnect`: what the Machines row's Disconnect does, which the window does not ask about either. It only narrows: the link closes and none is tried, the machine and its lists stay, and nothing on the machine changes. A machine busy with an install, update, rollback or uninstall is refused by `Links.disconnect`. Connecting it again is the card above (#1341). The central orchestrator only |
| `rollback_machine`, `uninstall_machine` (the orchestrator changes what runs on a linked machine, #1219) | asks (a card naming the machine, its ssh target and what the change does there, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `MachineFlow.run` → `askHost` with `alwaysAsk`, an `other` card with `about: "machine_change"`. Rollback names both versions and says it stops the Centralu there (a turn in progress is lost) and puts the newer one back if the older does not answer in 30 s; uninstall says it stops the Centralu there and removes what this computer installed, that sessions, projects and other data stay, an npm install of its own is not touched, and the machine stays linked. A version the machine reported is its own text and is shown as one quoted line. Both open the link of a machine the person disconnected, or one that is down with its Auto reconnect off (#1341), and leave it connected (the window's rollback and uninstall do too), so the card says so for such a machine. After Allow the machine is read again (`stillAsCardSaid`): one removed, whose installed versions moved (a rollback would go from a version the card did not name), busy with another change, or that was disconnected or lost its link with Auto reconnect off while the card stood (this would connect it without the card saying so) is not touched. Then the window's own call on the hub's links (`Links.rollback`, `uninstall`). Refused before the card: a machine not linked, no earlier version there (rollback), nothing this computer installed there (uninstall), a rollback or uninstall this computer cannot make (`LinkedMachine.operationRefusal`), and a machine busy with another install, update, rollback or uninstall. A denied card changes nothing. `machines.acceptVersions` has no command: since #689 two versions of one protocol connect by themselves, and for different protocols the call refuses. The central orchestrator only |
| `machine_activity`, `list_ssh_hosts` (the orchestrator reads what an update would stop on a machine, and the hosts of this computer's ssh config, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `MachineFlow.run` → `Links.activity`, `Links.sshHosts`: the `machines.activity` and `machines.sshHosts` answers, read only. Aliases and names are fenced as the model's reading of a person's words (`trustedJsonText`), and the config file's path and ssh's own notes (which can echo a line of the file) are each one quoted line; the file's other lines are not shown. The central orchestrator only |
| `get_preferences`, and `set_preferences` for the theme, text size, fonts, line height, the notification switches, idle sleep, update checking, moving idle sessions to a new agent CLI, sending with Ctrl+Enter, folding the sidebar's groups and when agents compact by themselves (the orchestrator changes a setting the window offers, #1219, #1376: the last only moves the point at which an agent summarises its own conversation, within 20% to 95% of the model's window, and reaches a session at its next start) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `PreferencesFlow.run` (`sessions/preferences-flow.ts`) → the window's own calls through the router (`prefs.set`, `agents.setSleepPolicy`, `updates.setAuto`, `agents.setAutoApplyVersions`), so the method's schema and the host's handler decide, as for the window. Only these reversible settings have a field (sending with Ctrl+Enter is a way of typing, and folding names the sessions whose children fold: neither widens anything); `sessionTools` (always on, not a setting), the agent ceiling, depth and models, trust, approval rules and app grants have none, and an unknown field is refused by name. The stored theme mode is only ever `dark` or `light` (the theme's base). The central orchestrator only, as rare commands behind `centralu_run` |
| `apply_agent_versions` (the orchestrator restarts idle sessions on the installed agent CLI, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `PreferencesFlow.applyVersions` → the window's own `agents.applyVersions` through the router: the session header's one app-wide action, which does not ask either. It restarts only a session that is fully idle on an older CLI than the one installed and has said nothing for a minute (`keepQuiet`, the quiet period the automatic move keeps so a restart does not land the moment someone starts typing; the window's own button passes none, and so waits for none); a session working, waiting on the person, running background tasks or recently active is left as it is and named. The central orchestrator only |
| `set_preferences` `autoUpdate: true` while checking or installing is off ("Automatic updates", #1219; one setting since 2026-10-20) | asks (a card saying that a newer Centralu then installs by itself and the desktop window relaunches into it when nothing is busy, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `PreferencesFlow.run` → `askHost` with `alwaysAsk`, an `other` card with `about: "orchestrator_change"` whose question is whole in `raw`; then `updates.setAuto` and `updates.setAutoApply` for the half or halves that are off. Turning it off asks nothing. A denial leaves both halves as they were and the other changes of the same call still happen. `update_centralu` never changes this switch (docs/agent-host.md §4.5); this is the one way an agent can, and it is the person's card that does it |
| `set_preferences` `notifications.approval: false`, when the switch is on, or `notifications.sound: false` while it would still notify (#1306) | asks (a card naming the notification that stops, or the sound, and what the person then does not hear of, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `PreferencesFlow.run` → `askHost` with `alwaysAsk`, an `other` card with `about: "orchestrator_change"` whose question is whole in `raw`; then `prefs.set`. The approval notification is the one that tells the person a card waits, so turning it off is the orchestrator choosing what the person stops hearing about; the sound is the same stop: it is how an approval reaches someone away (`notices.ts` alerts through it; the OS banner path does not reach them), so turning it off while an approval would still notify asks too, and once it no longer notifies it asks nothing. Turning them on, one already off, and the other switches (`done`, `whenFocused`) ask nothing. One card for both in a call. A denial keeps the approval notification on, and the sound on with it (off, it would silence it); the other switches of the call still change. The "error" and "every session finished" notifications are gone from the product (2026-10-20): `error` and `allDone` are refused by name |
| `list_archive`, `restore_archived`, `archive_subagent_steps` (the orchestrator reads the session archive, brings a session or its subagent steps back, or moves a session's subagent steps there, #1219; they were `list_trash`, `restore_trashed` and `trash_subagent_steps` until #1404) | allowed (a restore that brings back a deleted project's folder asks, below) | allowed | allowed | open | allowed | allowed | allowed | open | `TrashFlow.run` (`sessions/trash-flow.ts`) → the window's own calls through the router (`trash.list`, `subagents.usage`, `trash.restore`, `trash.restoreSubagentSteps`, `subagents.trash`), so a linked machine's archive is reached as the window reaches it and the host's checks decide (a session not in the archive is refused, a restore whose project folder is gone is refused by the host). Nothing is lost: all three are reversible. The central orchestrator only, as rare commands behind `centralu_run` |
| `restore_archived` of a session whose project was deleted (#1219) | asks (a card naming the session, the project and the folder that will be registered again, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `TrashFlow.run` → `askHost` with `alwaysAsk` (`about: "orchestrator_change"`), then `trash.restore`, which registers the folder as a project again (untrusted), what `add_project` asks about. A session not in the archive is refused before any call |
| `delete_archived` (one archived session, or its archived subagent steps, for good) and `delete_all_archived` (everything listed: sessions, kept app runs, archived steps) (#1219; `delete_trashed` and `empty_trash` until #1404, renamed after an orchestrator read "empty the trash" as the operating system's bin) | asks (a card naming the session or the counts, the size, up to ten names, the tool conversation files and worktrees that go with them, and that it cannot be undone, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `TrashFlow.run` → `askHost` with `alwaysAsk`, an `other` card with `about: "orchestrator_change"` whose question is whole in `raw`; then the window's `trash.purge`, `trash.purgeSubagentSteps` and `trash.purgeRuns`, one per item the card named (`trash.empty` is not called: it takes everything there is). Refused before the card: a session that is not in the archive (a live session is never deleted from here), steps not in the archive. After Allow the archive is read again: a session restored (or deleted) while the card stood is left alone, one that reached the archive meanwhile is not deleted, and steps moved there after the card are kept (`upTo`). The archive on a linked machine that could not be reached is left alone and named. The central orchestrator only |
| `list_projects` (the orchestrator reads the projects, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `TrustFlow.run` (`sessions/trust-flow.ts`) → the window's own call through the router (`projects.list`). The central orchestrator only, as a rare command behind `centralu_run` |
| `set_project_trust` with `trusted: false` (the orchestrator takes a project's trust away, #1219) | asks (a card saying the project's own deny rules and hooks stop applying, auto sessions included, and its sessions restart, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `TrustFlow.run` → `askHost` with `alwaysAsk` (`about: "orchestrator_change"`), then `projects.setTrusted`. Not only narrowing: an untrusted project's sessions read the person's own settings only (`settingSourcesFor`), so the project's deny rules and blocking hooks no longer bind its agents. After Allow the project is read again: removed, moved, unreachable or already untrusted, nothing more changes. The central orchestrator only |
| `list_approval_rules`, `remove_approval_rule` (the orchestrator reads the approval rules, or removes one, #1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `TrustFlow.run` → the window's own calls through the router (`approvals.rules`, `approvals.deleteRule`; a linked machine's rule by its folded id). Removing only narrows: that action asks again. No command adds or widens a rule; a rule comes only from the person answering a card "always". The central orchestrator only, as rare commands behind `centralu_run` |
| `list_app_grants`, `forget_app_answer`, `revoke_project_consent`, and `share_app` with `shared: false` (#1219) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `TrustFlow.run` → the window's own calls through the router (`apps.list`, `apps.permissions`, `apps.forgetPermission`, `projectConsents.list`, `projectConsents.revoke`, `apps.setShared`). Each only narrows: a forgotten answer or a revoked consent asks the person again next time, and an app no longer shared is detached from other projects' sessions. The central orchestrator only |
| `share_app` with `shared: true` (#1219) | asks (a card naming the app, its project and what it may ask for, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `TrustFlow.run` → `askHost` with `alwaysAsk` (`about: "orchestrator_change"`), then `apps.setShared`. A root app or a user-folder app has no share switch and is refused before the card. After Allow the app is read again: one removed, already shared, or whose `uses` changed meanwhile is not shared. Sharing still needs the person's consent for each pair of projects before another project's session attaches it. The central orchestrator only |
| `set_agent_limits` (the orchestrator changes the limits on agents: running agents per project, levels that may start agents, #1219) | asks (a card naming each limit as it is and as it becomes, every change, narrowing too, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `TrustFlow.run` → `askHost` with `alwaysAsk` (`about: "orchestrator_change"`), then `prefs.set` with exactly the named fields. Values are checked with the window's own patch schema before the card; nothing to change asks nothing. After Allow the limits are read again: one the person changed in Settings while the card stood leaves everything as it is. `set_preferences` has no field for them, the agent models stay the person's, and `sessionTools` (always on since 2026-10-20) is refused by name. The central orchestrator only |
| `set_project_trust` with `trusted: true` (#1219) | asks (a card naming the project, its folder and machine, and each of its apps with what it may ask for, in the window's trust card's words, every time; no "always") | asks | asks | asks | asks | asks | asks | asks | `TrustFlow.run` → `askHost` with `alwaysAsk`, an `other` card with `about: "orchestrator_change"` whose question is whole in `raw`; then `projects.setTrusted`. After Allow the project and its apps are read again: a project removed meanwhile, or whose apps changed (one added by a pull, or what one may ask for), is not what the card named and is not trusted; one the person trusted meanwhile is left as it is. Refused before the card: a name no project has, or one two projects share (their ids are named). The central orchestrator only |
| `attach_app`, another project's shared app, first time for the pair | asks (consent card) | asks | asks | open | asks | asks | asks | open | `AppAccess.attach` → `ensureProjectAccess(…, 'apps', …)` |
| `attach_app`, an untrusted target project's app (shared inside, or its root app) | refused | refused | refused | refused | refused | refused | refused | refused | An untrusted project's apps attach nowhere (owner, #1141); `AppAccess`, `SessionAppsHub` and the runtime's start and call gate refuse them under every preset (#603's opening no longer applies to apps) |
| `update_centralu`, first time in an ordinary session | asks | asks | asks | open | asks | asks | asks | open | `updateCentraluAsked` → `askHost`; other presets keep session-only remembered consent |
| `update_centralu` action `apply` (any profile that has the tool) | refused | asks, but no card while Automatic updates are on and nothing but the caller runs (#1509) | same | open | refused | same as Claude `normal` | same | open | `applyUpdateAsked` → `askHost` (an `other` card, `about: 'centralu_apply'`) after a window answered ready (`UpdateApplyBroker`), skipped when `UpdatesAsked.updateAtRest` says Automatic updates are on and the host is idle apart from the caller's own turn; app agents refused; the window re-checks with its button's rules (`agentApplyVerdict`: the bundle's own version must be the installed one and newer than the window) |
| Claude's independent-session discovery and messaging | refused | refused | refused | refused | — | — | — | — | Claude adapter `withoutCrossSessionMessaging`, under every preset (`auto` too since the mailbox plan's slice 0; #603's opening no longer applies to it) |
| `attach_app`, a user-folder app | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `AppAccess.attach` (no card: the person's own folder) |
| `attach_app`, another trusted project's root app (#1141) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `AppAccess.attach` (no card: its project's trust covers it, and the trust card listed it, with what it may ask for) |
| `attach_app` by the orchestrator (#1205), a trusted project's root app | allowed | allowed | allowed | allowed | allowed | allowed | allowed | allowed | `AppAccess.attach` (no card, as above; the orchestrator has no project whose trust would gate it). A project's inner app, shared or not, is refused: it is that project's (`AppAccess.candidates`) |
| `find_apps` / `attach_app` from an untrusted project | refused | refused | refused | open | refused | refused | refused | open | `AppAccess.gate` |
| An app tool the app marks `readOnlyHint` | allowed | allowed | allowed | open | allowed | allowed | allowed | open | Claude: `canUseTool`, `appToolOf` + `SessionApps.readOnly`. Codex: per-tool `approval_mode: 'approve'` (`mcpConfig`) |
| An app tool the app declares `local` (its own data, undoable, next to `destructiveHint: false`) | allowed | allowed | allowed | open | allowed | allowed | allowed | open | `SessionApps.unasked` → `runsUnasked` (`apps/external/tool-risk.ts`), the same call sites as `readOnly` (Claude `canUseTool`; Codex per-tool `approval_mode`) |
| An app tool the app declares `routine`, in the session's own project's app | asks | allowed | allowed | open | asks | allowed | allowed | open | `runsUnasked`: `own` is the session's project (never the orchestrator, a user-folder app or an app attached from elsewhere), and the project is trusted or the app would not attach. `centralu/askWhen` makes the call ask when any argument it names matches (or is set, for `"*"`), `centralu/askUnless` unless one does; a declaration it cannot read (including a value that is a list or an object) always asks; Codex, which fixes approval before arguments exist, then always asks |
| Any other app tool | asks | asks | allowed | open | asks | asks | allowed | open | Claude: the card in `canUseTool`; bypass and auto never reach it. Codex: `appApprovalModeFor` (`prompt`, `writes`, or `approve` when the person's policy resolves to `never`) |
| The agent's own tools (commands, edits) | asks, reads run | the person's settings | allowed | open | asks, reads run | the person's settings | allowed | open | `permissionOptionsFor` in each adapter |

**The person's own "Archive session…" in the window** is not `delete_session`, and takes no card of the call table: it is the
person's. The window asks first, every time and also for an idle session (owner, 2026-10-26, #1589; #1512 had moved an idle one
at once): its dialog shows the worktree choice and the conversation-file box, ticked by default. When it opens it reads what the
archive would lose (`agents.archiveLosses`, read only, rights `window` (it names mail thread subjects, which only the window reads), `SessionTrash.archiveLosses` = `lossesOf`: the same list as
the orchestrator's card, with the unfinished mail threads the session is assigned or owns) and lists it, whichever way the worktree box
is ticked (#1595); Archive then moves the session in one step, as the person saw it. If the read has not come, or came empty (or the
host is from before the method, "Unknown method"), Archive asks the host as it moves it: with the worktree kept
`agents.archiveIfAtRest` (`SessionTrash.archiveIfAtRest`, rights `asks` for any other caller), which reads then moves, only when
`lossesOf` is empty and, in the step that moves it, the session is still at rest (`trashIfQuiet`); otherwise nothing moves, the
dialog lists the host's lines, and its next Archive is `agents.deleteSession`. With the worktree deleted too (`archiveIfAtRest` never
removes one) it reads `agents.archiveLosses` again, and the dialog (if still open) moves it with `agents.deleteSession` when there are none. A session that was merely
not at rest, and a host without the methods, go to `agents.deleteSession` on the dialog's answer. Undo on the toast after the archive is
`trash.restore` and puts back the unsent draft and the session's place in each project's grid; it does not bring back the scroll
position or the focus, and it does not hand back what `lossesOf` names (which is why the dialog lists those).

Rows that differ by session:

- **The orchestrator and coordinators** read no settings files, but under `normal` they follow the
  person's bypass on both CLIs (owner decision 2026-10-11, #382). On Codex `~/.codex` loads, so the
  person's `approval_policy` applies. On Claude (`settingSources: []`) only the person's own
  `defaultMode` is carried, read from the user tier with the SDK's merge engine
  (`personsDefaultMode` in `adapters/claude/permissions.ts`); their `CLAUDE.md`, hooks and rules stay out,
  and a mode written in the orchestrator's own folder does not count. The direction is decision 1's:
  the person's global choice applies to every session that runs under `normal`, and someone who wants
  a card from the orchestrator has `safe`.
- **An agent an app started** (`run_agent`, `SessionManager.runAppAgent`) is `safe` whatever the
  calling session uses, has no Centralu server and no apps. Reads run; everything else asks.
- **A session `ask_project` addresses** already exists and keeps its own preset, tool and project
  trust. The caller's `auto` skips host consent; it does not raise the target's permissions, which
  includes answering its approval cards: an `auto` caller may answer them only for a `normal` or `auto`
  target, never a `safe` one or an app's agent (#676, `answersApproval`). The agent
  depth applies during a delegated task under every preset (#867).
- **A session `start_agent` started** (#561) runs in the caller's own folder under **the caller's
  preset**, so it never has more than the session that asked for it: `safe` stays `safe`, `normal` reads
  the person's own settings as the caller does, `auto` stays `auto`. No argument sets it and no tool of
  the caller changes it afterwards; the person may, and a child raised above the caller no longer takes
  work from it. Its approvals stand as cards in its own session. It holds the reader set but cannot start
  agents or ask a project at the default agent depth of 1, under every preset (#867); a depth of 2 or 3 in
  Settings lets it.
- **A builder's `check`** starts its app and runs the app's code without a card, under every preset,
  like any Centralu tool. This is intended (owner decision 2026-10-11, #382): the builder is the
  session writing that code, so a card for running it would ask the person about the builder's own
  last edit, and every edit already went through the builder's own approvals. Builders exist only in
  trusted projects and the user folder, whose apps run anyway once trusted, and `check` reaches its
  own app only (`builder` profile), never another.
- **"Always allow" on an agent's own card** (#838) is remembered as the host's own key for the card standing
  (`alwaysAllowKey` of `pendingApproval.detail`), never as the matcher the window sent: a window from an older build,
  during a swap, could send a wider one. A matcher that is not that key remembers nothing, and the call is allowed
  once. At startup the host deletes saved rules ending in `*`, which an older build read as prefixes; that only
  narrows what is allowed.

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

**"Always allow" on a command** (#838) remembers the command's text, trimmed, and lets through that text only
(`alwaysAllowKey`, `matchesAllowRule` in `protocol/src/always-allow.ts`; both adapters check it before asking). A `*`
is a literal character: a trailing one used to be a wildcard, so "always" on `cat logs/*` allowed every command that
starts `cat logs/`, chained ones included, saved for the project. A command that ends in `*` has no key at all: no "always"
on its card, and a rule an older build saved for one allows nothing now, so it asks again rather than allowing more.
A host from an earlier build, serving the same store during a swap or after a downgrade, would read such a rule as a
prefix, so this build never writes one. A command the card flags (outside the sandbox, network access, input to a running terminal) has no key
either: the card offers no "always", and a rule for the same text does not let it through, since the rule cannot tell
it from the plain command. What the host remembers is its own key for the card, whatever the window sends (see "Always
allow" on an agent's own card, above).

**An existing folder becoming a project** (#1220). Before `add_project`, no agent could make Centralu reach a folder
the person had not picked: `create_project` only makes a new one. The orchestrator's `add_project` is a new way for an
agent to bring a folder in, on this computer or a linked machine, and the person's card gates it under every preset,
`auto` included (`alwaysAsk`): a project is somewhere the orchestrator can start sessions, so this is the person's
choice of reach, not a tool call. The card shows what the folder's own machine found (`projects.inspect`): the machine,
the absolute path, that something is there and is a folder, and whether it is in a git repository with its `origin`
(read from the repository's config with git's untrusted settings, so a planted hook or filter does not run). A path
that is missing, a file, or a folder already a project is refused before the card, with the reason. On Allow the facts
are read again and the folder is registered by the sidebar's own steps (`addProject`, on a linked machine its
`projects.add`): untrusted when new, and the window asks about trust as when the person adds a folder. Deny or a
withdrawn card registers nothing. Only the central orchestrator has it, as a rare command behind `centralu_run`
(`RARE_COMMANDS`); `list_machines`, beside it, only reads the hub's `machines.list`.

**Linked machines from the orchestrator** (#1219). Linking a machine lets this computer, and the agents on it, reach
that machine over the person's own ssh; installing or updating runs Centralu's installer there and, for an update, stops
the Centralu running there; removing one drops its sessions and projects from this computer's lists; start at boot
writes an entry in that machine's own startup. Each of these is the person's choice, so the orchestrator's commands for
them wait for a card under every preset, `auto` included, and the card says what will run where. The card offers allow
and deny only and nothing is remembered: a window that knows `machine_change` shows no "always", and an older window's
"always" is read as allow, once. Reconnecting and when a machine connects change no machine and no reach, as the row's
buttons do not ask. Linking connects nowhere before the card (security review of #1238): a probe logs in with the
person's keys, so before the card the host only runs `ssh -G`, which opens no connection and loads no key, and the card
shows where ssh would go (host, user, port, and a ProxyCommand or ProxyJump, which run a command or reach another host
first). The probe comes after Allow, and a target that does not answer is linked nowhere. Before any card the host refuses
what it can tell without connecting: a machine not linked, a target that is no ssh target or that `ssh -G` cannot read,
a target, name or distro with a control or format character (a bidi override would make the card read otherwise than
what runs), a name already linked, and an install this computer cannot make.

**Settings and the session archive from the orchestrator** (#1219). `get_preferences` and `set_preferences` change what the
window's Settings changes, through the window's own calls, so the same schemas and handlers decide. The reversible
settings (theme, text size, fonts, line height, idle sleep, update checking, moving idle sessions to a new agent CLI) act
at once. What widens what agents may do or cost (the agent ceiling, depth and models), trust, approval rules and app
grants have no field: an unknown field is refused by name, and so is `sessionTools`, which is not a setting any more (the
reader set is always on, owner decision 2026-10-20); the trust commands below handle trust, rules, grants and the limits,
each behind its own card where it widens. "Automatic updates" turned on (`autoUpdate`) is a
setting that asks (as is turning off the approval notification, below): with both on, code arrives and the window relaunches without a later question, which is what
`update_centralu` is kept from doing. The card offers allow and deny only (`orchestrator_change`; an older window's "always"
is read as allow, once). Turning off the notification for an approval asks too, and so does turning off the sound while it still
notifies: they are what tells the person a card waits, and the orchestrator should not decide that they stop hearing of one.

The session archive is the person's safety net, so deleting from it for good is the one thing there that asks (`delete_archived`, `delete_all_archived`):
the card names what goes (the sessions by name, how many, how large, the tool's conversation files and worktrees that
go with them), and the host deletes exactly what the card named and is still in the archive as the card named it (a session restored and archived again is not), never more. Listing, restoring
and moving a session's subagent steps to the archive lose nothing and ask nothing. A live session cannot be deleted
through these commands: it has to be in the archive first, which `agents.deleteSession` and the sidebar do.

**Trust from the orchestrator** (#1219, third slice). Trust is what lets a project's apps run and its setting files
apply, so the orchestrator only asks for it, and asks to take it away as well: an untrusted project's sessions read
the person's own settings only, so its own deny rules and the hooks that block tools stop binding its agents (`auto`
sessions included). `set_project_trust` with `trusted: true` raises a card that names the project, its folder and machine, and each app the trust covers with what it may ask for
(the same wording as the window's trust card, `usesLines`). What the card named is checked again after Allow, so a
project whose apps changed while the card stood is not trusted on an answer about other apps. Approval rules only
narrow from the orchestrator: it may list and remove them, and no command adds one, so a standing "allow" still comes
only from the person's own "always" on a card. An app's remembered answers and the consents between projects can only
be forgotten or revoked from the orchestrator, which makes the next attempt ask the person (a forgotten "deny" too: the
app asks the person again, never the orchestrator, so no card guards it); sharing an app with other projects asks, and an
app's own capability question is still answered by the person alone. Every card quotes what a manifest supplies (an app's
name, description, the background work it declares) with control and format characters escaped, so a line break or a
bidi override in someone's repository cannot make the card say something it does not; a project's folder is named whole.
An app's id, which is its folder's name, is quoted too. A project whose machine cannot be reached is refused before any
card, and so is one whose machine could not list its apps (they are asked of that machine alone, `apps.list` with
`machine`, so a failure is not read as "no app"). The limits on agents
(running agents per project, levels that may start agents) bound the
orchestrator's own children too, so every change to them asks, narrowing as well as widening.

A program that is not a window and holds the limited credential (#1405) is asked through none of the cards above: its
irreversible calls raise a **host request**, the host's own card with Allow and Deny only, which only a window holding
the token answers, refused at once with no such window, withdrawn when the program leaves and after 15 minutes ("The card
for a limited call", under "Who holds full power").

### Turning things off

The table describes `safe`/`normal`. Under `auto`, project trust and revoked remembered
consents do not close delegation or attachment; the session's preset is checked on each call.
Auto attachments are recorded separately from consent grants and stop counting after a preset
downgrade. The app-sharing switch still applies to every preset. The session-tools switch is gone (always on,
2026-10-20).

| Change | orchestrator | scoped | builder | reader |
|---|---|---|---|---|
| "Let sessions look at other sessions" off (an older window sending it, or a record an earlier build stored) | — | — | — | No change: the reader set is always on (owner decision 2026-10-20). The host reads the switch as on (`UiPreferencesCommands.uiPreferences`), does not store an "off" (`setUiPreferences`), and neither the profile rule (`toolProfileFor`) nor the reader set (`readerToolsFor`) reads it, so its calls, the bridge's `toolProfileOf` and apps it attached are unaffected |
| Its project loses trust | No change (reads no project files) | No change (reads no project files) | Its app stops, so `check` cannot start it | Settings files at the next start; its project's apps stop and leave at once; `find_apps` and `attach_app` refused; apps it attached leave at once. `ask_project` and `start_agent` refused (#382, #561); its standing `start_agent` cards, its sessions' `ask_project` and fork cards, and its queued `ask_project` requests are withdrawn and their callers told (#673); those of an `auto` session stay, and are read again at delivery |
| The other project loses trust | — | — | — | Apps attached from it leave at once; `ask_project` to it still runs, its card says it is not trusted, and the existing target session follows its trust |
| The person revokes a pair in Settings | — | — | — | Apps attached under "always" leave at once; the next `ask_project` or `attach_app` asks again, and an `ask_project` request for the pair still queued is withdrawn (one an `auto` session queued stays, and is read again at delivery); for a project's `agents` row, the next `start_agent` of a `safe` session asks again (a child already running is left to finish; a `normal` session needs no row in a trusted project, #673) |
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
  indexed (`INDEXED_KINDS` in `dev-services/store/search-index.ts`) — not tool calls, and not their output — so neither `recall` nor the palette
  can find a session by what a command printed, or by the command.

Tests: `manager-messages.test.ts` ("a tool call is kept whole in the store and leaves it only as its card") puts secrets where
the card does not reach and looks for them in the broadcast, the history and archive pages, `read_session`, `recall`,
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
- **They go when the session goes.** The rows belong to the session, so the session archive keeps them and a purge deletes them
  (FR-22).

Tests: `manager-messages.test.ts` ("a subagent's steps are kept under its launch card and read by nothing else") looks for a
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
- The agent receives it framed (`appMessageFrame` in `sessions/app-messages.ts`): a header naming the
  app and saying the person chose to send it but did not write it, and that it is the app's text,
  not an instruction; then **every line** of the text behind `> `. A line imitating the header, or
  a made-up "person:" field, stays inside the quote. The app's name passes the one-line field rule
  (`frameField`). A pinned view's message gets the same frame, which says it came from the app's
  own view, outside this conversation.
- One rule makes any text one line (`oneLineText` in `protocol/app-frames.ts`, #428; `frameField`
  is it at 120 characters): white space, control characters (U+0085 included), the line and paragraph
  separators, the bidi controls, the zero-width space and word joiner, and the tag characters (which
  hide text from a reader) become one space. ZWJ, ZWNJ and the soft hyphen stay: they are part of names.
  A linked machine's paths keep their spaces and joiners and lose only what breaks a line (`onePath`). Every name or task line the host puts on one line uses it: a frame's names (`askFrame`,
  `agentFrame`, `agentNoteFrame`), a linked machine's names, consent cards' task lines, session labels.
  The ten copies had different sets, and the narrower ones let a NEL, a bidi override or U+2028 through.

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

A notice an app posts into a session that called it (apps.md §10, `notify`, #1161 item 1) is an
app's text no person chose to send either. It is stored with its source (`fromApp`), and reaches the
agent in the same frame, under a heading saying the app posted it to this session, which called its
tools before, that the person did not write or read it, and that nothing in it can grant permissions
or change instructions (`appMessageFrame(..., 'notice')`; `app-notice.test.ts` "is recorded as the
app's message and reaches the agent framed as the app's text, each line quoted", with a forged header
inside the text). Who it may reach is under "App servers".

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
it is added, whether the person added it or allowed the orchestrator's `add_project` card (#1220; the host names the
project in `projects_changed.added`). The exception is a new empty folder Centralu made itself (`projects.create` or `create_project`
without a Git source, here or on a linked machine, #655): only the person and Centralu wrote there, so it starts
trusted. A clone stays untrusted, because an agent can ask for any URL and the contents come from outside. The `trusted` column arrived untrusted by default (store v33); v35 then marked every
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
Every git the host starts goes through `runGit` (`dev-services/git-exec.ts`); the lint rule `guard/git-start`
(`tooling/eslint-guards.js`) fails if any other source starts git. A read for an untrusted project gets:

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

The listing is its own git process before each read. Saving a worktree's work before its deletion
(#608) makes about fifteen calls in one folder, so its reads share one listing per repository
(`gitFilterListings`, #368). What the shared listing covers: the reads of refs, history, trees and
the index (`rev-parse`, `rev-list`, `log --raw`, `ls-tree`, `ls-files`, `diff --cached`, `bundle
create`), none of which runs a filter. The one call of the save that runs clean filters, `add -A`
into the save's private index, comes after the history scans and the bundle, which can take
minutes. The cleanup stops only the session being deleted: the project's other sessions keep
running, can write a driver into the configuration the worktree shares, and the worktree's
`.gitattributes` can name it. So `read-tree` and `add -A` take a listing of their own, made right
before them. What is left is the window every read before trust already had between its listing
and the call. A planted configuration is on disk before the save starts and is turned off as
before. Calls that change which configuration git reads (`GIT_DIR`, `GIT_CONFIG_*`) never share
a listing: it is keyed by folder alone.

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

A new worktree forks from the project's trunk **as the remote has it** (#1484): `resolveForkBase` runs
one `git fetch` of the trunk, which reads the repository's network settings (`core.sshCommand`, a
credential helper, `core.gitProxy`, `url.*.insteadOf`), so it runs only in a trusted project, as
the checkout does, with a prompt-free environment (`cloneEnv`) and a 20-second bound. An untrusted
project forks from the local trunk ref and the start answer says it was not fetched. Test:
`git-worktree.test.ts` "an untrusted project is not fetched".

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
requires no marker, with the same read for a trusted project as the control; `manager-projects.test.ts`
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

## The data folder (#838)

The data folder (`~/.centralu`, or `CC_DATA_DIR`) holds every conversation (`store.db`), the remembered consents and
the host's log. It was `0755` with `store.db` and `host.log` `0644`, readable by every account on the machine. At each
start the host makes it its owner's only (`keepDataFolderPrivate` in `data-dir.ts`, before the store or the log opens):
the folder `0700`, and `store.db`, its WAL and SHM files and the host's logs `0600` when they are wider; a new
`host.log` is created `0600`. Only what the owner owns and what is not a link is changed, only for the data folder
itself (a `--db` elsewhere is left alone), and not on Windows, whose profile folder's ACL is already per user.

The folder's own mode is what protects the rest: a file written later with the default mode (an older build serving
during a swap, an app's data, SQLite) is still behind a folder only its owner can enter, and an older build never
widens the folder again. The host's `umask` is not changed: it is every agent's and every terminal's, and the files
they write in the person's projects keep the person's own modes.

### Antigravity's agent and its token (#59)

Centralu installs Google's Antigravity agent itself and keeps all of its state under the data folder
(`tools/antigravity/`, [plans/antigravity-acp.md](plans/antigravity-acp.md) §3, §4), so it sits behind the folder's
`0700`. The rules that hold it:

- **Only the pinned build runs.** `agents.installTool` downloads the one archive this Centralu pins and refuses it unless
  its sha256 is the pinned one, before anything is unpacked; only the files the release names, as plain files, are
  written, and the folder is put in place by one rename. The method `asks` for the limited credential: it brings in a
  program that later runs.
- **The agent's home is Centralu's.** Every process starts with `GEMINI_HOME` there, never the person's `~/.gemini`, so
  none of their global MCP servers, hooks or skills load into a Centralu session, and Centralu never reads the CLI's
  sign-in. The agent keeps the person's `HOME`, so its commands see their git, ssh and npm settings; one thing escapes
  `GEMINI_HOME` because of it: Google's harness extracts its screencast encoder (`webm_encoder`) into
  `$HOME/.gemini/antigravity/bin/` at the first prompt. Nothing else under `~/.gemini` was read or written in the
  measured runs, and development and review runs use a temporary `HOME`. The owner accepted this
  ([#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6446873429);
  [plans/antigravity-acp.md](plans/antigravity-acp.md) §4.1).
- **The token is in the agent's own store, as Google ships it.** Centralu sets no store (owner 2026-10-28,
  [#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6461617566)). Agent 1.4.3 uses the macOS Keychain when
  a probe of it works (service `gemini`, account `antigravity-acp`; the program is signed with Google's Developer ID, so
  a Keychain prompt, if any, names Google's `agy_acp_server`, not Centralu), and otherwise the file
  `gemini-home/antigravity-acp/acp_token.json` (mode 0600): always on Windows and Linux. Centralu never reads the
  Keychain and never opens or looks for the file; signed in is read from `auth.type` in the agent's `settings.json`
  alone, and a sign-in that no longer works is told when a session's process asks for the agent's own login (below).
  **What Auto still reaches**, and more: nothing in Centralu keeps the agent from its own folder. Its viewer and search
  read the token file without asking under every preset where the file is the store (Windows, Linux), as Codex reads
  its `auth.json`; no built-in tool is switched off (no `_meta.antigravity.disabledTools`), no client read is offered
  (`fs.readTextFile` false), and a permission request naming that folder is answered as any other of its kind (a card
  under Safe, Normal and Edits, unasked under Auto or a saved rule). A subagent's request (`Run invoke_subagent?`, kind
  `other`) runs unasked under Auto and asks with a card every time under the other presets: a call of kind `other` has
  no rule key, so no saved "always" rule allows it. The guard of the first
  build, which refused such requests under every preset, is gone, so a request is never refused for the path it names
  ([plans/antigravity-acp.md](plans/antigravity-acp.md) §4.2 says why).
- **The sign-in address stays out of logs and events.** It reaches the host through a private folder (`0700`) and the
  agent's stderr, is opened once and only when it is the agent's own login request (its OAuth client on Google's
  authorize page, a loopback redirect), and no `tool_setup` event carries it.
- **The agent never starts a browser, and the person's `BROWSER` never reaches it.** Every Antigravity process gets
  `BROWSER` set to Centralu's helper in that private folder (on Windows a `node` command line run with no shell, since
  `cmd` would split the address at `&`). The host opens the address, on Windows through the terminal broker, outside
  the host's job object, so a Stop, a finished sign-in or the host's exit cannot end the person's browser and its tabs
  ([plans/antigravity-acp.md](plans/antigravity-acp.md) §4.3). In a session, the helper handed the agent's own login
  request means the stored sign-in stopped working: the session fails as `not_logged_in` and its process ends. Commands
  the agent runs inherit `BROWSER`, so any other address they hand it is dropped and logged without the address, never
  opened and never taken for a sign-in: nothing is opened that the person did not ask for (§4.4). Where no helper can be
  written, the agent is not started. Lines of
  the agent's stderr that hold an address, an email or a token's name never reach `host.log` or a crash message.
- **The agent never decides alone.** It stays in its `default` mode, where it asks; `allow_always` is never sent, so no
  rule of its own outlives Centralu's preset; a question it asks is the person's to answer under every preset.

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
an endless slot (#82; `transport/server.ts`, `TRANSPORT_LIMITS`). Before its hello a socket may send
one frame of at most 64 KiB and it must be a hello: anything else closes it (4001), and bytes are
counted as they are read, so a socket that sends more than that before hello is cut without the frame
having to arrive. At most 16 sockets may wait for their hello at once; a further upgrade is refused
with a 503. A slot is given back only when its socket is gone: a socket that times out or is refused
gets its close frame, and is cut if the peer does not answer within a quarter of a second. After hello
a frame may be up to 100 MiB (the library's default, set explicitly); a bigger one closes the socket
(1009). The token is compared in constant time. An authenticated socket's hello is
answered once; a repeat is ignored. A hello may carry a Codex bridge's credential instead of the token
(#382, "The front door" below); that socket receives no events and may call only its own session's
bridge RPCs. It may also carry the limited credential, which calls only the everyday methods ("Who holds full power",
below).

`pnpm dev:live` (#739) is the one script that puts a host credential into a browser page. It reads the running
app's front door port and credential from the keeper's `status` and gives them to the Vite it starts, as
`VITE_HOST_URL` and `VITE_HOST_TOKEN` in that child's environment only (not printed, not written anywhere). Since
#1405 the script is not a window to the keeper, so the credential is the limited one (owner, 2026-10-21): the page
reads every conversation and does the everyday things, and what cannot be undone raises a card in the app's own
window (or, for the person's own answers, is refused). Vite bundles `VITE_*` values into the page, so the page it
serves, on `http://127.0.0.1:5173` or `:5174`, holds that credential. That page does **not** have the protection of the keeper
socket ("The keeper's control socket" below: `0600`, peer uid checked). A loopback TCP port is not per user:
on a machine with other users, any of them can fetch `http://127.0.0.1:5173/` and read the token from the
served bundle, and then connect to the front door and read every conversation. So `dev:live` is for single-user
machines, and it prints a warning saying so. The dev server listens on `127.0.0.1` only (never `0.0.0.0`): do not expose it (no
`--host` other than `127.0.0.1`, no tunnel). The credential is derived from the front door's token, which the keeper makes once per
keeper lifetime and keeps across host swaps and keeper handoffs (`front_door.rs`); it changes only when the
keeper restarts, that is, when the app is fully quit and opened again, and the script is run again then.

## Who holds full power (#1405)

On 2026-10-21 the orchestrator misread "empty the trash" (the person meant the Windows Recycle Bin), read the front
door's token from the keeper's `status`, and called `trash.purge` through a script it wrote: the hub relayed it to a
linked machine, and 108 trashed sessions were deleted with no question. The window asks first; the orchestrator's own
`delete_trashed` / `empty_trash` raise a card; the raw path asked nothing.

**What this defends against:** a process of the person's own user that is not the person's click in a window (an
agent, a script it wrote, a tool or MCP server, an app server, a `pnpm dev:live` page) getting full host power from a
documented interface and using it without the confirmation the window shows. **The honest limit:** such a process runs
as the same user. It can delete `store.db`, edit it with `sqlite3`, remove the data folder, attach a debugger where the
OS allows it, start the app's own executable, or ssh to a linked machine with the person's key. None of that is closed.
What is removed is the path where full, unconfirmed power is one request away; it is not a wall between processes of one
user, and where it cannot prevent it prefers to be loud.

**Two rights at hello**, besides the Codex bridge's credential above (`transport/server.ts`): the token, which a window and a hub linked to this host hold, calls
everything; the **limited credential** (`ccl1:<mac>`, an HMAC of a label of its own keyed by the token,
`transport/limited-token.ts`) calls the everyday methods only. It is derived, not stored, as the bridge's is: the next
host after a swap accepts it with nothing handed over, and holding it gives nothing toward the token. A socket holding it
is a client like a window (it gets the event stream: owner, 2026-10-21, to revisit once the orchestrator's tooling no
longer needs it), but none of its `res` frames answers the host's own calls, which are a hub's.

**A session's credential** (`ccs1:<sessionId>:<mac>`, `transport/session-token.ts`, slice 6) has the limited
credential's rights and names a session. Every agent the host starts finds it in its environment, with the host's
address (`CC_HOST_URL`, `CC_HOST_CREDENTIAL`; `hostAccessEnv`, in the Claude CLI's and the Codex app-server's
environment, and so in what they run), so a script an agent writes calls the host the sanctioned way instead of reading
a token from somewhere. One naming a session this host does not have is refused at hello. It is **attribution, not
proof**: an agent's environment is readable by every process of the same user for as long as it runs ("The front door"
below), so a process can present another session's credential. Its rights are the same either way; all it can fake is
the session a card names, which says "which says it runs under the session". The name is weak in two more ways: a
session's name can be changed by any limited caller (`sessions.rename` is everyday), and on a serve host whoever reads
`serve.json`'s key can derive a session credential for any session ("The remote host" below). Beside it, a Codex
session's bridge process holds `CC_BRIDGE_TOKEN` (`ccb1`) in its environment, readable the same way, and that one gives
more than the session credential: the session's own tool channel as that session, under its preset ("The Codex bridge
gets a credential of its own" below; the rare commands still raise a card in every preset). Derived like the bridge's, so the next
host after a swap, and a keeper's adopted agent, keep it working. An agent started by a build from before slice 6 and
adopted after an update has none (a process's environment is fixed when it starts) until its next start. A host started
inside an agent takes both variables out of its own environment at start (`LAUNCH_VARIABLES`), so its agents get only
its own. The orchestrator's instructions do not mention it:
their resident budget had no room, and `keeper.sock` hands out only the limited credential anyway.

**Where it is judged:** in the transport, before the router, on the host where the call starts. A limited call naming a
linked machine's session is refused on the hub and never relayed; the machine does not judge again, since it cannot tell
a relayed call's origin.

**What it may call** (`transport/method-rights.ts`, keyed by every RPC method with no default, so a method added to the
protocol does not compile until someone classifies it, and a test compares its keys with the protocol's):

| Class | With the limited credential | Which methods |
|---|---|---|
| everyday | runs | reading, creating and messaging sessions (a preset of `normal` or below), renaming, sleep policy, the trash's list, read and restore, git, files, terminals, commands, stopping a process, app upkeep that keeps what it replaces. What the user could do by hand anyway is not held back |
| asks | waits for the person's card in the window and runs once allowed ("The card for a limited call" below); refused at once when no window that shows the card holds the token | deleting for good (`trash.purge`, `trash.purgeRuns`, `trash.purgeSubagentSteps`, `trash.empty`); deleting a session (#1371: not fully undoable); deleting or adding a project, its trust either way, its commands, worktree setup and agent instructions; removing, enabling, importing apps, sharing one; adding, removing, installing, updating (save the catch-up below), rolling back, uninstalling a machine, its autostart, its versions, letting it ask or start `auto` here; installing an update (save the idle one below) or turning automatic updates on; a session created above `normal` or carrying a hub's preset (`fromHub`: an `auto` one starts it under `auto` while the hub-auto switch is on, and only a hub, which holds the token, sends it), or set to any preset but `safe` (the parameters do not say what it was); a preference that sets the agent ceiling or depth, turns hub auto on, or turns approval notifications or their sound off |
| window | refused, never a card | the person's own answers (approval cards, questions, an update's apply and its report, whose ticket every client hears, MCP and skill proposals), the window's layout written whole, an app's secret, an import's preparing and cancelling, an app view's own calls |
| link | refused | a hub's `host.*` calls (`host.stop` and `host.activity` are everyday: stopping is what `kill` does) |
| bridge | refused | `orchestrator.tool(s)`, `apps.sessionTools`, `apps.sessionCall`: through them a caller would act as an `auto` session, whose own cards are skipped |

The full list, method by method, is [generated/method-rights.md](generated/method-rights.md), written from the table by
`pnpm docs:rights` and checked by a test. A method whose answer depends on its parameters reads them as sent, before they
are parsed, and asks when it cannot read them. One reads the host's state too, through `RightsHost`, which main.ts
gives the server (a server given none asks): `machines.update` runs without a card when the hub's automatic updates are
on, `when` is `idle` or absent, and the machine runs an older release of the hub's channel that the update brings to the
hub's own version (#1508, owner 2026-10-24; `LinkedMachine.followsHub`, the one place the condition lives, which the
orchestrator's `install_machine` reads too). The person already chose that with "Automatic updates", which brings the
hub itself to that version unasked, and the hub runs the same update by itself (agent-host.md §4.8). Such an update
waits for the turns there and for its terminals and project commands (it closes none of them; after 30 minutes it gives
up), stops no host it cannot ask what runs (found out before anything is installed), and gives up once automatic updates
go off. Once spent for a version (the person cancelled it, or its two tries failed) `followsHub` is false, so an agent's
update of that machine asks again. `machines.cancelUpdate` stays everyday: a limited caller can end the hub's own
catch-up of a machine while it waits, and that stops it until the hub's next version (the person's Update still works).
Stopping an update is what the person's Cancel does and changes nothing there, so it is not held back. `now`,
`machines.rollback`, `machines.uninstall`, `machines.install` and `machines.acceptVersions` still ask. `updates.apply` reads the
host's state in the same way (`RightsHost.updateAtRest`, #1509, owner 2026-10-24): it runs without a card while the person's
Automatic updates are on and nothing is running (`hostBusy`: no turn, no card waiting, no background work, no terminal or command, and
no swap draining), since the host installs the known update by itself then (`UpdateService.setAutoApply`). Anything else, and a
server given no state, asks. Turning the setting on stays an ask. The rule for `asks`: it deletes beyond what the trash brings back, moves out of reach what the trash does not fully
restore, widens what agents, apps or machines may do without the person, or brings in code that later runs unasked;
and everything the orchestrator's tools card in every preset is `asks` too. A test reads the orchestrator's flows
(`sessions/*-flow.ts`) and fails when a window method they call after their card (in the same block) is everyday here,
unless it is a read made again after Allow; a card raised only in some branches (restoring a session whose project was
deleted) is not seen by it. A refusal is `ok: false` with
`data: { refused: 'rights', rights }` and a line in the host's log naming the method; the socket stays open.

**The card for a limited call** (`host-requests.ts`, slice 3). An `asks` call is held, and the host raises a
**host request**: not a session's card (the program holds no session's rights, and a card in the orchestrator's slot
would read as the orchestrator's doing) but the host's own, shown over the lanes of every window that said in its hello
that it shows them (`hello.shows`), one at a time, oldest first.

- **What it names.** The trash's deletes ask through the orchestrator's own trash flow with this card in place of
  the orchestrator's: the same question, naming each session (quoted on one line), its machine, its size and what goes
  with it, and the same reading of the trash again after Allow: a session restored meanwhile is not deleted, and
  `trash.empty` deletes only the rows its card listed, never what arrived while it stood. Any other method's call is
  parsed by the method's own schema first (`host-request-targets.ts`): a field the method does not take is dropped, so
  a caller cannot put text on the card that would not run, and a call the method would refuse is refused before it
  asks. The card names the method, what it acts on by name as the window's lists name it (the session, project, app or
  linked machine, with the machine it lives on), what a delete loses, and the parsed parameters, quoted on one line with
  format characters escaped; the call runs with those parameters. An id that names nothing is refused, and after Allow
  the names are read again: a call whose target was renamed, deleted or unlinked while the card stood does not run.
  Parameters too long to show whole (over 2,000 characters) are refused rather than cut, since what runs is what the
  card shows. The card wraps a line anywhere, so a long one is not clipped.
  The program's own name (`hello.client`) is shown quoted, cut to 60 characters, and said to be what it calls itself:
  nothing checks it.
- **Who answers.** Only a window holding the token (`requests.answer` is `window`): never the program, another
  limited socket, a bridge or an agent. Allow and Deny only, no "always" (owner, 2026-10-21), and no key: a y meant for
  the composer must not delete something for good. A card's buttons take a click only once it has stood half a second,
  and one click: the next card appears where the last one was, and the program hears each answer and can ask again.
- **When it is refused at once.** No window that shows host requests holds the token (owner, 2026-10-21: refused,
  not left standing): an older window, a hub's link and the limited credential count for nothing. Or 8 already wait,
  counted again when the card is raised (a trash delete reads the trash first, so many at once cannot pass the bound).
- **When it ends unanswered.** The program's socket closes, 15 minutes pass (owner, 2026-10-21: the one card with a
  timer, since a raw call has no turn to end it), no window shows requests for 30 seconds (a window that reloads comes
  back within it and keeps its cards), or the host stops (its sockets close with it). Nothing is kept across a swap: the caller asks the
  next host again. An allowed call runs as a call the host serves, so a swap's drain refuses or cuts it like any other.
- **Linked machines.** The card is raised on the host where the call started, before the router, so a call naming a
  linked machine's session asks on the hub and is relayed only once allowed (with the hub's link, which holds that
  machine's token). A linked machine's own limited callers are refused there: no window there shows host requests, and
  the hub does not show a machine's (`requests.*` are never forwarded).
- **Residual.** A window built with `dev:live` holds the limited credential and is a window all the same: it shows
  the card, and its Allow is refused (`window`), so the person answers in the app's own window.

**Who holds what, today.** Built so far: the credential, the classification (slices 1 and 2), the card (slice 3), and
the keeper handing the token to windows only (slice 4, "The keeper's control socket" below): a script that asks
`keeper.sock` gets the limited credential, and a serve host's `serve.json` (slice 5, "The remote host" below) holds no
full credential: a script that reads it, or runs `--connection`, gets the limited one. Every agent's process has its
session's credential (slice 6). The direct host on Windows gives its token only to the window that started it.

## The remote host (`centralu serve`, #82)

A host started with `centralu serve` on another machine is reached by the app through an SSH local forward
([agent-host.md](agent-host.md) §4.7). The boundary is the one above, unchanged: loopback binding and the token.

- **Nothing listens on a public interface.** The host binds 127.0.0.1 on the remote; the forward binds 127.0.0.1 on
  the person's computer. Reaching the host takes an SSH login to that machine as that user, so SSH is what
  authenticates the person and encrypts the link. Centralu adds no listener, no TLS and no login of its own.
- **No full credential is written down** (#1405, `serve-files.mjs`, `lifecycle/serve-credentials.ts`).
  `<data folder>/serve.json` (version 2, mode 0600 from the first byte and narrowed back if it drifts) holds the host's
  `key` and one entry per full credential, `{ id, label, verifier, created }`, the verifier being the SHA-256 of the
  credential. The host gets the key as the first line on its stdin (`{"key"}`, a pipe to the launcher: not on the command
  line, which `ps` shows every user, and not in the environment, which every process of the user can read for as long
  as the host runs, measured below in "The front door"), and the file's path in `CC_SERVE_STATE`. It derives what it
  hands out from the key (the limited credential, a bridge's, the proof of a probe) and takes as full only a hello whose
  credential's verifier is in the file, read again at each hello, so a pairing or a revocation applies at once. A hello
  with the key itself is refused. The host takes exactly the entries the launcher lists and `--revoke` takes (an 8-hex
  id and a label `--pair` takes, `isListedEntry` on both sides, one test holding the two rules equal): an entry written
  into the file by hand with no label or another id opens nothing, since one that nobody could see or withdraw would
  undo the listing below, and the launcher's next write leaves it out.
  - **Who gets a full credential.** Whoever runs `serve --connection --pair <label>`: one is made, printed once and
    kept as its verifier, replacing that label's earlier one. A hub pairs as `hub:<its name>-<key>` at each link, the
    key being the 8 hex characters of the hub's own random id (`hubSelfId`, kept in its store), so two hubs of one
    computer name do not replace each other's credential; its own
    credential lives in its memory only, as the token did, and it needs no store change. `serve --window` gets one
    per start (label `window`): the desktop app runs it on Windows, and it runs the same on Linux and macOS, so any
    program of this user there can run it too. The launcher's own hand-over call (`host.handover`, a
    hub's) uses one made for that call and withdrawn after it.
  - **What anyone else gets.** `--connection` without `--pair` prints the limited credential (`limited`) and the
    other full credentials by id, label and date (`others`), never their values; `--stop` and the launcher's probes
    use the limited credential. `--revoke <id>` withdraws one full credential; `--rotate-token` draws a new key and
    withdraws them all. Both act at once on the next hello, and on the sockets already open (#1405 review): the host
    reads `serve.json` at each hello and, while any socket holds a full credential, every second, and closes each
    socket whose credential the file no longer names (4001 "credential withdrawn"; a hub's link then pairs again).
    Before, a socket opened and then revoked within 135 ms kept full rights for as long as it stayed open, while no
    listing named it. A file that is not there (moved aside, as the launcher advises for a bad one) names no full
    credential at all, at once. One that is there but cannot be read (permission denied, as after `chmod 000`, or a
    scanner holding it on Windows) names none for a new hello, at once (#1405 review: a credential paired just before
    kept full rights for 30 s while nothing listed it); a socket already in keeps what the file said at its last read
    for at most 5 s, so one busy moment does not close every link, and is then closed as "credential file unreadable",
    not "credential withdrawn". `host.credentials` then answers the error's code (`unreadable`), and the hub's row
    says the machine's credential file cannot be read; a hub whose link was closed that way says the same, and does not
    take its own credential for withdrawn. The launcher says a file it may not read is a permission problem and how to
    give access back, never to move it aside, which would end every credential it names. Changes to the file take
    `serve.json.lock`: one whose time is more than 10 s from now, ahead or behind (a crashed writer, a clock set back),
    is taken over. A writer reads its lock back before each try of its rename, and tries only within 8 s of taking the
    lock by its own process clock, so neither a stall nor Windows' 5 s of rename retries lets a writer whose lock was
    taken over write. Taking a stale lock over, and removing one's own, move the lock aside first and put back one that
    turns out to be another writer's. Left open: a writer suspended over 2 s between its last read-back and the rename,
    and a system clock set forward by over 10 s while a lock is held.
  - **Moving on.** A version 1 file's token becomes a full credential labelled `legacy` (a hub or window still holding
    it keeps working) and a new key is drawn; the next pairing of a hub or of the window removes `legacy` (a pairing
    under any other label leaves it, so a program's own `--pair` does not cut off a hub that has not paired yet). This
    stays as the update path for a machine below the oldest release still served (#1143): version 2 first shipped in
    0.1.0-beta.45, so updating an older machine runs this launcher on its version 1 file. Every host the launcher starts takes verifiers and its key on
    stdin, so it keeps no single token for an older one; a `legacyHostToken` that release kept goes at the next write.
  - **The honest limit.** A process of this user on that machine can run `--pair` itself, as an agent that ssh-es there
    can. It gets a full credential of its own, which the file names by its label. That is made loud rather than
    prevented (owner, 2026-10-21): the hub's machine row in Settings → Machines lists every full credential the machine
    holds besides the hub's own, by the label its asker gave (shown quoted, never checked) and its date, with Revoke,
    which runs `serve --revoke` there over the machine's ssh without opening its link (`machines.revokeCredential`; the
    hub's own is refused, since its next link would only make it again). The list is the one the machine named when the
    link opened, then what the machine's host says through the link (`host.credentials`, read from `serve.json`) at each
    connect and every 30 seconds: a pairing there while the link is up shows within that. It is shown while connected,
    its labels cleaned to one line. A pairing under a label already there replaces that credential, as the hub's own
    re-pairing at each link does. Each entry keeps how it was asked for (`via`: `pair` for `--connection --pair`,
    `window` for `--window`, `handover` for the launcher's own one-call credential, which a launcher from before #1711 made and a host since takes as limited only), and a pairing is marked `replaced`
    in the file and on the row ("which replaced an earlier one of that name") only when the entry it took the place of
    was asked for another way, or does not say (#1405 review): the window pairing at each start and a hub at each link
    are their own pairer again, and marking them made the flag mean nothing. So `--pair window` in the window's place,
    and the window's next start after it, are a change the person sees. The window's credential, from `serve --window`
    on any OS, is listed on a hub's row as "window" with its date, and its re-pairing at each start is not marked. Two askers of the same way under one label (a
    program's `--pair hub:<name>-<key>` against that hub's own link) cannot be told apart by the launcher: the hub tells
    it itself. One under this hub's own label that this hub did not make says so ("under this computer's own name but
    not made by it"), and the row says when this hub's own was gone from the list or withdrawn while its link held it
    (the host there closes the link then, 4001 "credential withdrawn"); that mark stays for as long as the hub runs,
    since the link pairs again at once. A credential used and then withdrawn before the next 30 s read is listed too
    (#1405 review): the host keeps, while it runs, every full credential a socket said hello with, and `host.credentials`
    adds those no longer in `serve.json` as `gone` (", used, then withdrawn" after its entry, no Revoke; "Full access was used here, then withdrawn" when none other is left, the owner's wording), unless the next
    credential of the same label, the next used there or the one the file names now, was paired the same way (its
    pairer again, as at each window start or hub link; the file's own counts since a review found a hub that had paired
    again but not yet said hello listed as gone on another hub's row for one read). Under any label but a hub's this
    also leaves out one used and then withdrawn when the label was paired the same way again; that new pairing is
    listed itself, with Revoke. Before, `--pair x`, a hello and
    `--revoke` within 135 ms left no trace on any row. The machine's user can get around this at will in two ways:
    - **Kill the host.** Closed while the hub's link is up (#1712). The first time a full credential says hello on a
      host, the host appends its record (id, label, date, verifier, never the credential) to `serve-used.jsonl` beside
      `serve.json`, BEFORE the socket gets its rights, and tells the hubs linked to it at once with a
      `host_credential_used` event over their open links (the sockets in with a `hub:`-labelled credential; the event
      carries a `check` of a nonce of its own, so a hub knows its own credential from one that only reuses its id, and
      never the verifier; a hub's key entry, #1711, has no secret to check and carries its public key instead, which a hub compares with its own, and a hub from before key pairing drops such an event and lists the use at its next read). A hub puts the credential on its row and starts a `host.credentials` read at once (a burst
      of events costs one read in flight and one waiting), whose answer then replaces it, provided that host's record
      holds the credential (`usedIds`; one that started again without it, because the file was removed or could not be
      written, leaves what the hub was told on the row). Until a read has answered, the hub cannot know whether the
      credential is still held, so the row shows it as a held credential is shown, not as "used, then withdrawn" (and
      not at all while the first read the event started is in flight); once a read has answered and does not list it,
      it reads "used, then withdrawn". If the host is stopped first, or the read cannot answer (the file unreadable),
      the use stays on the row as held, also while the link is down, until a read says otherwise. A restarted host
      reads the file back (at most 256 records, the newest; a credential named by more than one line is one record), and
      every report takes in only the lines added since the last read (a byte offset, reset when the file is replaced or
      shorter; one read takes at most 1 MiB of new lines, the newest, and says on stderr when it skips older ones), so a
      program that appends to the file cannot make a report slow, and the file is rewritten (past four times the
      records kept) only from a state that holds all of it, so a fresh use is never rewritten away. A record whose
      line was cut short (a full disk, a power loss) is skipped, and the next record is written on a line of its own. A
      hello reads nothing back: it appends and, when the file was exactly as long as what was read, counts its line
      where it stands; otherwise the next report reads it with whatever else was added (#1715).
      Agents' per-session credentials are not full credentials and are not reported. The owner's constraint
      (2026-10-29) is that this never slows or blocks ordinary work: the hello is not held for the hub (the event is
      queued on the hub's socket, a hub that stopped reading is cut as for any event), with the hub's link down the
      record stays in the file, and a record that cannot be written (a full disk) is said on stderr while the hello
      goes on.
      **Records do not stay for good** (owner decision, 2026-10-30): the first report that finds a recorded
      credential no longer named by `serve.json` writes down when (`goneAt`, a line added to the file) and the host
      drops the record, from memory and at the file's next rewrite, 7 days after (a restart does not renew the clock,
      since it is in the file; a credential still named is never dropped, and one named again loses its note, so a later
      withdrawal starts a new week; while `serve.json` cannot be read nothing is noted or dropped). The date is when the host found it withdrawn, which is the first report after the withdrawal,
      or after a host that was stopped starts and reports again. The hub keeps what the person withdrew from a
      machine's row, by id and time, in its store (`app_settings` `links.revoked.<machine>`, the newest 256, written
      with no migration step; forgotten with the machine, once a read of the machine answers that its host keeps no
      record of the credential (`usedIds`, which is a week after the host's first report after the withdrawal, however
      long no hub read it), and at the latest after 60 days), so a record the machine's host still keeps does not bring
      a withdrawn credential back on the row after the hub restarts. What is left is the same
      user's: drop the hub's link first (the event has nowhere to go; the file is read at the next link), or delete the
      file or make it unwritable, which that user can do as easily as `serve.json` (the hub's event still arrives while
      its link is up, and it keeps it across the restart; with the link down too, nothing is left to show). A swap's
      overlap, two hosts of one folder, may lose a line to the rewrite that shortens a file past four times its bound.
    - **Take the hub's label while its link is down** (end the user's own ssh session, pair under
      `hub:<name>-<key>`, use, withdraw, and let the hub pair again). The host takes the hub's next credential for
      the same pairer again, so its `gone` leaves the taken one out. Closed (#1405 review): `host.credentials` also
      gives every id used under a hub's label, listed or gone, in order of first use (`usedUnderHubLabels`), and the
      hub compares those under its own label with the ids it paired itself while it runs, by id and by secret: the host
      keeps one record per id and verifier, and answers each entry with a `check`, an HMAC under its verifier of a nonce the
      hub chose for that read (never the verifier), which the hub compares with the same HMAC of the secret it holds. An
      entry written into `serve.json` by hand under a reused hub id, with another secret, is not the hub's own then: it
      is listed as used and gone, or, while still listed, as held, and the hub's own is then taken for gone if it is the
      one missing. Any other is listed as used
      and gone ("under this computer's own name but not made by it"); its own are never listed. Left: one used under
      the hub's label before this hub's first link in its present run is not judged, since the hub does not remember
      the ids of its earlier runs. An entry that reuses the hub's own id has no working Revoke: the hub refuses to withdraw its own id, and `serve --revoke <id>` there would take both. The record keeps at most 256 (id, secret) pairs, so whoever can write `serve.json` can still push older ones out, as it could with 256 ids before.

    The row lists 32 and counts the rest ("And N more"), so a flood of entries cannot hide the one after them. A
    process of this user there can also read the key. That gives it the limited credential, a session's credential
    (`ccs1`) for any session it can name, which fakes only the name on a card, and also a bridge credential (`ccb1`)
    for any session it can name, which reaches
    that session's own tool channel (`orchestrator.tool`, under that session's preset; "The Codex bridge gets a credential of its own" below), as it
    did before #1405 when the file held the token. Any process of this user, on any OS, can run `--window` and get the window's credential, until
    the launcher checks its parent (#1417).
- **Other users on the remote machine** can connect to 127.0.0.1 like anyone local, and are stopped by the token, as on
  a desktop. A machine where another user can read your files (root, or a wrong home-folder mode) can read the token;
  the remote mode is for a machine the person trusts, and the spec says so (product-spec.md §1.5).
- **Single trusted user.** One host per data folder (the ownership lock), one person's sign-ins. There is no
  account model and no sharing between people.
- **The reverse direction** (#550). A host calls a hub linked to it only on the connection that hub opened and offered
  on (`host.hubOffer`), with `rpc` frames the hub answers only through its link's allowlist ("A linked machine's session
  asking this computer", above). A window, or anything else holding the token, that offers itself as a hub only makes
  the machine's sessions send it their asks: the token already gives it more than that.
- **An administrator's ssh on Windows runs everything elevated** (#702). Windows OpenSSH gives an account in the
  Administrators group a full token for a network logon, with no UAC split, so a host the hub starts over ssh, every
  agent it starts and every tool call they make run with administrator rights, where the same person at the desktop
  would run them unelevated. Centralu does not refuse it (the person may want it); the host says so in its hello
  (`hello_ok.elevated`, from the token's integrity level) and the machine's row in Settings → Machines says it in one
  sentence with the way out: link the machine through a standard account with its own ssh key. A host running as root
  on Linux or macOS is reported the same way.
- **A host started over ssh on Windows has no access to the person's saved sign-ins** (#1224). A key login is a network
  logon without the password, so DPAPI cannot unlock the user's master key and Credential Manager reads as empty
  (measured: `cmdkey /list` printed `* NONE *` there while the profile held 46 saved credentials). Git Credential
  Manager can neither use nor save a sign-in. Centralu does not work around it (no plaintext store, no token carried
  through Centralu): the host says which logon it runs in (`hello_ok.logon`) and the machine's row says what that means.
- **A dev build on a linked machine** (`pnpm remote-dev`, #1036; [plans/remote-hub.md](plans/remote-hub.md) §10.11)
  sends nothing new across the link (no file travels but the installer every update sends), but it does run what is
  on that machine: the working copy there, by its own bundler on the pinned Node, at a commit the hub named in full and
  checked there first (HEAD must equal it, no uncommitted changes unless the maintainer allows them, the hub's
  protocol), and the git on that machine's PATH to check it (the installer runs on its own Node and cannot use the
  host's `runGit`, so a repository's own git configuration applies there as when the maintainer runs git in it). It
  is a command on the hub over the link's own ssh, never an RPC, so an agent or a linked machine cannot start one; the
  hold it writes (`<data>/remote/hold.json`) only makes links wait, and lapses. The build is marked (`install.json`
  `source: { kind: 'dev' }`, shown on the machine's row), so it is never taken for a release. Going back is not free:
  the dev build runs on the machine's real store and may migrate it past what the release reads; the store is copied
  before the dev build first opens it and put back when the dev build does not answer, or when the release will not
  start on it, which drops what was done on the dev build since. Only the store is copied.
- **Headless.** The host starts without `DISPLAY` / `WAYLAND_DISPLAY`, so nothing it starts can raise a window or a
  keyring prompt on that machine.
- **What the client must not do:** forward with a wildcard bind address (`-L 0.0.0.0:…`) or `GatewayPorts`, which
  would expose the host's port on the client's network with only the token in front of it.
- **Other users on the person's computer** (#838). The forward's local end is a loopback port, and any account there
  can listen on it first: the forward counts as up when something accepts on the port, and the hub's hello carries
  the remote's token. So before the hello the hub asks the host to prove it holds the token (`prove`: an HMAC of a
  fresh nonce under the token, with a label no other derived secret uses, `transport/host-proof.ts`), and sends the
  hello only to a host that does. Something else on the port gets a nonce, never the token, and the link reports
  itself down. The hub asks only when the connection line says the host can (`proof`, written by
  `serve --connection` over SSH from the installed build, `hostProof` in `bundle-info.json`, never from what answers
  on the port, which could otherwise make the line say no); a remote from before #838 has no `proof` and gets the
  hello as before, so on such a remote this hole stays open until it is updated. A host that refuses the `prove`
  (a machine rolled back to such a build) is a refusal: the hub reads the line again rather than retrying.
- **Residual: the proof under a stored verifier** (#1405 review, held for the owner). A hub that paired proves the
  host with `credentialProof`, keyed by its credential's verifier, which `serve.json` holds. A process of the same user
  on the linked machine that reads the file can therefore stop the host (`host.stop` is everyday, or `kill`), listen on
  its port, answer the hub's `prove { credential }` from the file, and receive the hub's full credential in the hello
  that follows. That credential is never listed as an "other" one. This is no worse than before #1405, when the file
  held the token itself, but a reader of `serve.json` gets more than the limited credential through it. Closing it needs
  an asymmetric pairing (the verifier a public key, the hub signing the host's nonce instead of sending a bearer
  credential); until the owner decides, it stays a stated residual. Another account cannot take this path: it cannot
  read the 0600 file. The design that closes it (#1711, proposed): [plans/key-pairing.md](plans/key-pairing.md).
- **The same on the linked machine.** `serve --connection`, `serve` and `serve --stop` ask the host on the recorded
  port with the token, and another account there can hold that port while the host is down. When the installed
  build proves, they send `prove` first and the hello only to a host that proved it (`helloSocket` in `serve-host.mjs`, beside `serve.mjs`).
  Something on the port that does not prove is not this folder's host unless the folder's `host.lock` names a live
  process that started when the lock says (`ps -o lstart`, `lockHolderIsAlive`): a host from before #838 still running
  after an update, which then counts as running and is stopped by its pid. A lock a dead host left, whose pid another
  process now has, or one without a start time (an older host, or Windows, which has no `ps`), does not count, so
  `--stop` never signals a stranger.
- **A linked machine updated without a restart** runs an older host than the one installed: its line says `proof`
  (from the installed build), the host refuses the `prove`, and the link says so ("runs an older Centralu host than
  the one installed there") and asks for a restart (`centralu serve --stop`, then start it), rather than reporting a
  token problem. The hub sends it no token meanwhile. A Unix-socket forward
  in a 0700 folder was the other choice; it was not taken because a Windows hub's Node cannot connect to the
  AF_UNIX socket OpenSSH would create there, while the proof works with every hub and every remote.

## The keeper's control socket

The keeper (`centralu-keeper`, #280, #440) is a new trust boundary: through its socket a process can read the front
door's port and a credential, stop the host, and make the keeper run a host from another folder (`switch`). The rule:
**only this user's processes get in, and only a Centralu window gets the token** (#1405).

- **Who is a window** (`keeper/window_peer.rs`). The peer pid the kernel recorded at `connect` (`LOCAL_PEERPID`,
  `SO_PEERCRED`, as the child socket reads it) names an executable (`proc_pidpath`, `/proc/<pid>/exe`) that is, by
  exact resolved path, one of the window executables the keeper accepts (`accepted_windows`): the `centralu` beside
  the keeper's own executable (the macOS bundle's `Contents/MacOS/`, a debug build), unless the keeper runs from
  `<data>/content/`, where a file dropped beside it proves nothing; and the window of each build the keeper names: its
  own `--bundle-path` and the bundle of the current host's and the next launch's build, which only a window's `switch`
  sets (`<bundle>/Contents/MacOS/centralu` for a macOS bundle, the executable itself elsewhere). What a client says
  about its own build in `attach` counts for nothing. A file named `centralu` anywhere else, a renamed `node` among
  them, is not a window. Linux's ` (deleted)` mark is taken only after an accepted path (an update replaced the
  file). On a keeper signed with a team identifier the executable must also be signed by that team (`codesign
  --display`), and one whose signature cannot be read is not a window; no release is signed with a team today
  (macOS releases are signed ad hoc), so in every build that ships the path decides. A peer whose pid or executable
  the kernel does not name is not a window. The keeper judges before it takes its state lock, logs every refusal with
  the executable, the accepted paths and why, and a window given the limited credential says so in its own log. A
  window adopted in a keeper handoff is judged again from its socket, whose peer record travels with it. A test runs
  two copies of the test binary against the socket, one at the accepted path and one named `centralu` elsewhere: only
  the first gets the token (`only_the_accepted_window_executable_gets_the_token`).
- **What a window gets.** `status` and `attach` carry the front door's token (`view.rights: "full"`), and so does
  every status pushed to it. It alone may `switch` and `upgrade`, which start a build of the request's naming and hand
  it the token.
- **What anything else gets.** The limited credential in the token's place (`view.rights: "limited"`, `limited.rs`,
  derived as the host derives it, so it works behind the door across swaps), on `status`, `attach` and every push to
  it; `switch` and `upgrade` are refused (`window_only`). `stop`, `restart`, `relaunching`, `settings`,
  `set_background` and `children` hand out no token and stay open to this user. A test sends every op from a process
  that is not a window and fails if any line it gets back holds the token
  (`no_reply_carries_the_token_to_a_process_that_is_not_a_window`); the ops are listed once (`OPS`) and a second test
  checks the list against the dispatcher.
- **Residuals.** A process of this user can start the app's own executable, which opens a window the person sees, or
  replace the file at an accepted path (an app bundle is the user's to change). A peer can connect and then `exec` the
  window's executable, keeping its pid: the window it starts flashes on screen. `codesign --display` reads the file
  now at the path, not the code running in the peer; a team-signed keeper should judge the peer's audit token
  (`LOCAL_PEERTOKEN`, `SecCodeCopyGuestWithAttributes`) before releases are signed with a team (#1439). On
  Linux, where the keeper runs only with `CC_USE_KEEPER=1`, a window runs from its AppImage's mount, whose path
  changes at every launch: only the window that started or switched the keeper is accepted, and a later launch gets
  the limited credential until a window of its own starts a keeper; to settle before the Linux keeper runs by
  default.
  A debug keeper started with `CC_KEEPER_TEST_WINDOW_EXE=<path>` also accepts that executable, for the integration
  scripts, which pass the `node` that runs them; a release keeper compiles that out. An older keeper (before #1405) still hands the
  token to every process until the app is fully quit or the keeper is updated (its update hands over to a keeper that
  judges windows).

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

- `switch` runs `main.mjs` from whatever host folder the request names, and only a window may ask (#1405): it would
  otherwise hand the token to code of the caller's choosing. A process of this user can still replace the files of a
  host folder before a window switches to it; that is the same-user residual, not a boundary. The same holds with no
  window at all: a host the keeper restarts after it exits runs from its copy as the copy is (`<data>/hosts/<key>/`,
  or `<data>/content/<version>/host/`, not verified again before each launch), so a process that edits the copy and
  then ends the host (its pid is in `status`) has its own code started with the token.
- `relaunching` (#352) keeps a keeper with no window running for at most 300 s, whatever background mode says. It
  grants nothing `set_background` does not already, and only for a bounded time.
- `children` (#538) lists what the keeper holds (each child's id, pid, kind, tag and state), read-only: the child
  socket that used to answer it now answers only the keeper's hosts.
- The socket is local only. Windows has no keeper yet (named pipes and their ACLs are not written). On Windows the
  host is the window's or `centralu serve`'s child, and gets its token on stdin from `centralu serve` as above; the
  window's host makes its own and says it on its ready line.

### The front door

Under the keeper, clients connect to the keeper's **front door** (#280 step 3), which relays bytes to the current
host. It changes where a client connects, not what it must prove:

- It listens on **loopback only** (`127.0.0.1`), on a port chosen when the keeper starts. Any process on this
  machine can open a TCP connection to it, exactly as it could to a host before. The door adds no authentication of
  its own and checks nothing: every byte goes to the host, which still requires the token in `hello` and still
  applies the `Origin` rule to the browser's own header (the relay passes the upgrade request through unchanged).
- **The token is the keeper's**, 16 random bytes from `/dev/urandom`, one per keeper lifetime. It reaches clients
  only through the user-only control socket, and hosts as the first line on their stdin (#538, owner decision
  2026-10-18): `{"token":…}`, with `CC_HOST_TOKEN_ON_STDIN=1` telling the host to read it there
  (`lifecycle/handed-token.ts`) before the control lines that follow. Not in their environment (below). The one
  exception is a host from before #538, whose `bundle-info.json` does not say `tokenOnStdin`: it reads only
  `CC_HOST_TOKEN`, so the keeper still hands it the token there and says so in `keeper.log`
  (`server/host.rs`, `prepare_host`); that happens only when the keeper starts an older build than its own (a
  rollback, or a switch to an older window's build). It is never written to `keeper.json`, `keeper.log` or
  `host.log`.
- **Deleting it hides it from children only, not from other processes of the same user.** Measured on macOS 27.0.1
  (build 26A434, 2026-10-11): a node process started with `CC_PROBE_SECRET=<marker>` deleted it from `process.env`
  at once and set another variable afterwards. From a separate process of the same user, started with an empty
  environment (`env -i`), `ps eww -p <pid>`, `ps -E -ww -p <pid>` and a `sysctl` read of `KERN_PROCARGS2` (2,164
  bytes back) all printed `CC_PROBE_SECRET=<marker>`; the variable set after start appeared in none of them. The
  same `sysctl` for pid 1, a root process, failed with `EINVAL`. So what a process is started with stays readable
  to every process of its user for as long as it runs; on Linux `/proc/<pid>/environ` is the same initial block
  (not measured here). That is why the keeper and `centralu serve` stopped putting the token there (#538): a pipe's
  bytes are read once, by the one process holding its end. What was left: the control socket's `status` and `attach`
  handed the token to any process of this user, since every window needs it and no window is the keeper's child
  (the owner kept that path when deciding #538). Since #1405 they hand it only to a Centralu window, judged by the
  exact path of the executable the kernel names for the peer ("The keeper's control socket" above); any other process gets the limited
  credential. So the token is not one request away any more, though it is still not a wall between processes of the
  same user (the residuals above); it is no longer in any process's start environment for one to read.
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
signal any child the keeper holds. The rule (#538, owner decision 2026-10-18): **only the hosts this keeper holds
get in**, not every process of this user.

- Created under `umask 077`, so it is born `0600`; every connection's peer uid is read from the kernel and the
  connection is dropped unless it is the keeper's own uid.
- Then its peer pid, also from the kernel (`SO_PEERCRED` on Linux, `LOCAL_PEERPID` on macOS), recorded when the
  peer connected: the connection is dropped, with a line in `keeper.log`, unless that pid is the current host's
  (the supervisor's, its own or one handed over by the previous keeper) or a swap's standby while it is one: that
  exact pid, not its process group. `spawn_host` makes the host lead a group, and what the host runs without a
  session of its own (a worktree's setup command, `npm install -g`, a version probe) is in that group, so a setup
  script an agent changed would otherwise get in. A host run from source is one process for this (Node with tsx's
  loader, `source_launch`). Nothing is answered before the keeper names its host (`Children::answer_hosts`); after a
  keeper handoff, the host handed over is answered from the first accept until the new keeper has adopted it.
- What the keeper holds can still be listed, read-only, through `keeper.sock` (`{"op":"children"}`), for this user's
  tools and the integration scripts.
- A control line is capped at 16 MiB (a spawn carries a whole environment); a host's input to a child is queued up
  to 8 MiB before the keeper stops reading it; a control connection that stops reading its events is dropped past
  8 MiB.
- `signal` takes only TERM, KILL, INT, HUP, QUIT, USR1, USR2 and WINCH, never pid 1 or below, and is a no-op for a
  child that has exited, whose pid may already belong to someone else.
- Children start in their own session, with the environment the host passed. The host takes `CC_KEEPER`,
  `CC_HOST_SOURCE`, `CC_HOST_TOKEN`, `CC_HOST_TOKEN_ON_STDIN` and `CC_FRONT_DOOR` out of its own environment before
  it spawns anything; the token is not there to begin with unless an older keeper started it.
- The keeper stores each child's tag and parses nothing in it, and parses nothing a child says.

Limits: the check names processes, not code. A process that can act as the host (attach a debugger to it, or
replace its files before it starts) gets in, and this user can do both. It closes the path where any process of this
user, a command an agent ran included, simply connects. A pid is the kernel's record of who connected; it is not
reused while the keeper holds that host. It is local only. Windows has no keeper; when it gets one, its child channel would
be a named pipe whose DACL names this user, with `GetNamedPipeClientProcessId` for the same check by pid.

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
  the app's own executable inside its bundle. Only a Centralu window may send either (#1405), since
  the keeper starts what it names and hands it the token and every handle. A process of this user
  that replaces a bundle's files before a window switches to it is the same-user residual, not a
  boundary.
- Nothing from the channel is logged: the snapshot carries the token, and the log lines name only
  pids, counts and reasons.
- The incoming keeper proves it holds `keeper.lock` by taking the `flock` on the passed description
  before it says ready; a third keeper is refused throughout, as before.
- `CC_KEEPER_HANDOFF_HOLD_MS` makes an incoming keeper wait before it says ready. It exists for the
  integration test and changes nothing but timing.

## Signed content (#440)

With the thin shell ([plans/thin-shell.md](plans/thin-shell.md)), the keeper and the host run from a
folder outside any signed app bundle, with the permissions the person granted to the shell. The boundary
is **what may be started from that folder**: only files signed by a key compiled into the verifier,
including release content and owner-approved local content (#610). The verifier is
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
  the npm token. Within `release.yml`, `CONTENT_SIGNING_KEY` goes only to the darwin platform job;
  `local-content-sign.yml` also receives it in its approved signing job (#610).
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

A refusal is **shown by the window itself, in a native dialog** (#634, `apps/desktop/src-tauri/src/refusal.rs`):

- **Why it is drawn there.** The build bar is drawn by the web UI, which the host feeds, and the host is the thing whose
  content failed to verify: it could hide the line or write another. The dialog is drawn by the window process, the signed
  app bundle, from what the window reads itself: the shell's `shell-status.json` and the keeper's swap view over the
  keeper's socket. Neither passes through the host, and nothing of this is sent to or from it. Both
  can be written by another process of the user (the keeper's socket takes a `switch` naming any folder, and
  `shell-status.json` is the user's file), so **the dialog repeats no free text from either**: it is built from the kind
  of check (a fixed list of ids, each with fixed words; an id it does not know is not repeated), the file's name (it comes from
  the signed manifest; cut to plain text of at most 200 characters), the two hashes (only if each is 64 hex characters) and the
  window's own version (the running one only if it is a plain version). The sentence the keeper or the shell gave goes to
  `keeper.log` on one line, which "Show log" reveals.
- **Only for a switch this window sent.** The window notes the moment before it sends its switch (`Announcer::we_asked`); the
  first ended swap that began after it, whose target is this window's build, is that request's end, and is shown if it is a
  refusal; the ask is spent either way. A refusal of a switch another process asked for gets no dialog, however often it asks
  (the keeper keeps the last swap's view for a window that attaches later, and another window's refused update is not
  announced either). **One dialog at a time**: none is handed out while one is open (the dialog's own callback clears the
  flag), and two are at least 5 seconds apart; one that had to wait is shown by a later view.
- **What it says.** Which version could not be verified and which one keeps running (an update), or that Centralu started
  without the permission shell (a start), and under Details the check that failed (an unknown signing key, a signature that
  does not match, a file whose hash differs, another platform, a version below the floor, a newer shell needed), the file
  and both hashes. The keeper names the check and the file in its refusal (`check_id`, `file_of` in `keeper/content.rs`;
  `refusedCheck` and `refusedFile` in the swap view, additions only: a keeper or window of another build ignores them). For
  the shell's refusal of the window's own content, the window reads that content again (`keeper::content::diagnose`: the
  shell's checks, then every listed file's size and hash; it reads and hashes and starts, copies and changes nothing),
  because the shell's status carries one sentence and no hashes and its crate cannot change without a new shell version.
- **Show, do not run.** The dialog only tells. It starts, trusts and unlocks nothing; what keeps running is what already ran
  (an update swap) or what the window starts itself when the shell refused (§6 of the plan, unchanged), and the dialog says
  which: after a refusal by the shell it says that Centralu was started directly from the app and that this start was not
  verified, not that nothing ran. Its two buttons are "Show log" (reveals `keeper.log`) and "Close"; it names the commands that
  fetch the build again (`npm i -g centralu@<version>`, then `centralu install --force`: `centralu update` does nothing when
  the registry's latest is the version already installed). A "run anyway" (the owner's decision of 2026-10-14 on #634) is not
  built: the shell and keeper still verify by default and there is no override.
- **Only verification failures** (`content`, `downgrade`, `shell-too-old`) are shown this way. A copy that failed, a folder in
  use, a shell that would not open and the like stay in the build bar, which is the host's to draw and can be hidden by it.
- **Once per refusal** in a window's life (the keeper pushes the same failed view on every status change); a second attempt
  that is refused again is shown again.

Limits:

- Another process of the same user can change the copy after it is verified, or start whatever it likes
  with the same `node` and agent CLIs the keeper uses; the plan says so (§4). This protects against
  running content the project did not sign, a partial or corrupted update, and a file dropped into
  Centralu's folders inheriting the grants, not against the user's own processes.
- Whoever holds a signing key can sign anything; rotating means moving `next` to `current` in a new shell
  version, which is why the shell carries both.
- Windows has no verifier copy yet (`verify_and_copy` is Unix only); it has no shell either (§8), so no refusal arises there
  and the dialog is never shown.
- The dialog is drawn by the window process, which runs as the same user as everything else here: another process of the
  user could draw over it or close it, and one that reaches the keeper's socket (the host is a child of the keeper and does)
  can ask for a switch to content it names, which the keeper refuses: the window shows no dialog for that (only for a switch it
  sent itself), and a refusal it does show repeats none of the requester's words (its folder name is in the log only). It can,
  in a race, make the keeper refuse the window's own switch (one swap runs at a time) and so use up the window's one dialog for
  that request; it cannot make the dialog say more than the check, the file, the hashes and the versions, and it cannot suppress
  a refusal the keeper or the shell made. What it protects against is the host hiding or rewriting a refusal, not the user's
  own processes.
- The text of the shell's refusal is the shell's (pinned) and the window's diagnosis reads the content again: a content changed
  between the shell's refusal and the diagnosis is described as it is then, or, when it verifies then, by the shell's sentence.

### Local content signing (#610)

Whoever can dispatch `local-content-sign.yml` on `main` and approve `npm-publish` can have
**arbitrary unreviewed dirty-tree code signed with the release key**. The manifest supplies file
hashes, not source code for CI to rebuild or review. Its `commit`, `dirty` and installed version
are self-reported; signing does not attest that the code came from that commit or was reviewed.
CI treats the manifest as data and never executes the uploaded code, but the resulting signature
grants that code the same content trust as a release.

Both validation passes read the base version as data from the checked-out workflow commit (the
dispatched `main` commit for this workflow): the newest release tag reachable from it
(`readReleaseBase`; since #1501 no file holds the version, and both jobs check out the whole history
for its tags). Tags are pushed only by maintainers, as main is. The uploaded `local.baseVersion`
must equal it, and the next release and upper bound are derived from it.
A manifest claiming `beta.999` cannot advance the shell's highest-seen floor when main is on
`beta.20`. The reported installed version is not an attestation of any machine's state.

Approval uses the owner's `gh`-authenticated token. At the #610 security review, `npm-publish`
has one required reviewer, self-review is allowed, and administrators can bypass protection;
the same owner token can dispatch and approve. This is not an independent two-person review.
The workflow's `GITHUB_REF == main` check is advisory. The enforcement is the environment's
deployment policy: since 2026-10-13 `npm-publish` admits only the `main` branch and `v*` tags, so
a branch with an edited workflow cannot receive the key even after approval. This is a GitHub
setting, not a file in the repository; anyone who can push to `main` or create a `v*` tag (today
only the owner, the sole collaborator) can still run an edited workflow with the key after
approval. The check in workflow code is not a substitute for that policy.

**The signature is not machine-bound.** A signed local manifest and its matching files verify
on any `darwin-arm64` machine trusting the same key whose highest-seen version is lower. No
machine identity, target path or owner account is part of the signature's authorization. The
local command's selected install target is a convenience, not a restriction on redistribution.

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
  secrets, `CENTRALU_APP_ID` and `CENTRALU_APP_DATA` (`app-start-env.ts` `spawnSpec`; test "receives its
  data folder (created for it) and only its declared secrets, never the host's own variables").
- Secret values live in `app-secrets.json` (0600) and are replaced by their names in the app's log,
  run records (arguments, errors, kept failures), error bundles and the text of a failed start, which the list, a check
  and a caller's refusal carry, and the app's own error text a check report or a failed resource read quotes (`#1142`:
  `app-check.ts`, `app-resources.ts` `maskedError`; tests "a check report quotes …", "a resource read that fails …") (`secrets.ts` `redactor`, `app-process.ts` `AppLog` and `AppProcess.start`; tests "stderr
  goes to the app's own log, with secret values masked by name", "an app that fails to start with the value in its
  error leaves only the name in the list, the bundles, the check and the refusal"). Each value is also replaced in its JSON-escaped form (#838), since run records keep
  arguments as JSON, where a multi-line key or one with quotes is spelled differently, and each line of a
  multi-line value of 16 characters or more on its own, since the app's log is masked a line at a time. A run record's
  arguments and kept result are masked string by string before they become JSON, then as JSON (`runs.ts`
  `maskedJson`): a value holding the secret already JSON-escaped (JSON passed as text) was escaped a second time,
  a spelling neither form matched (`redactor.test.ts`). Arguments are hashed only after redaction. The person enters values through
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
  tools into it. User-folder apps attach without a card, as they are the person's own, and so does
  another trusted project's root app (#1141), which its project's trust covers (the trust card lists
  each app with what it declares it may ask for, and the inbox says once when a trusted project gains
  one); that does not widen what the session could already run, since the calls follow the session's
  preset. An untrusted project's apps attach to no session, under any preset. The app
  still runs in its own folder with its own data, and its calls are recorded with the calling
  session (`app-access.test.ts`, `app-access-manager.test.ts`).
- The broker pipe (fd 3) is handed only to that process, so there is no token to steal. A broker
  call must carry the run id of a call the same app is handling on the same pipe; no id, an
  invented id, a finished run's id and another app's live id are all refused, logged and recorded
  without a parent, so an app cannot put rows into another app's chain (`broker.ts`;
  `mediation.test.ts` "a broker call with no run id is refused (an app waking itself up on its
  own)", "a made-up id, a finished run's id, and another app's live id are all refused";
  `broker-records.test.ts`). Broker work is
  cancelled with the call it serves, down to an agent session it started. The one exception is
  `busy` (#1236): an app says it is busy with background work, or no longer, without a run id. It
  asks for nothing outside the app: it only keeps the app's own process from the idle rule, and only
  when the manifest declares `uses.background` (in `uses`, so an imported app adding it is reviewed
  again and the trust card lists it). The hold is the app's row ("Running: <reason>"), it ends with
  the process, and the person stops it from its sidebar row, its row in Settings or its view
  (`app-lifecycle.ts` `setBusy`; `busy.test.ts`, `e2e/apps.spec.ts`). A host that starts again
  starts the apps that held busy when the last one stopped (`app-busy.json`), but only one still
  allowed to run (trusted, enabled, not failed) and still declaring `uses.background`; the person's
  Stop and a crash remove its record (`busy-book.ts`, `ExternalApps.resumeBusy`).
  The other is `notify` (#1161 item 1): an app that declares `uses.notices` posts a
  notice into a session that called it, from a timer, without a run id. It can reach only those
  sessions: a call a session's chain started carries an address for that session, the session id
  with a MAC over (app, session) under a key kept in the data folder (0600), so a session id read
  from `sessions.list`, another app's address or a made-up one opens nothing. The text reaches the
  agent in the app-text frame, every line quoted ("Text an app sends"); at most 10 a minute and 4000
  characters each; every notice, delivered or refused, is a run record naming the session
  (`notices.ts`, `desk.ts` `notice`; `notices.test.ts`, `app-notice.test.ts`).
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
- A session that called an app with `uses.notices` once can be told by it for as long as the session
  exists: an address does not expire, and nothing but the rate limit bounds how often the app speaks.
  The text is the app's, framed as such, and grants nothing; the person reads it in the conversation.
- An app that declares `uses.background` decides when it is busy: one that never releases keeps
  running until the person stops it or Centralu quits. The row shows the hold the whole time; nothing
  limits how long it lasts.
- The data folder is outside the repository so that runtime files are never committed. It is not
  an isolation boundary between apps: they all run as the same user.
- Redaction is literal string replacement. Values shorter than 4 characters, and values the app
  transforms (encodes, splits), are not caught. Neither are JSON spellings other than the raw value, its
  `JSON.stringify` form and one more level of escaping: a value escaped with `\uXXXX` where JSON.stringify writes
  the character itself (.NET writes `+` as `+`), or JSON nested two levels deep in text, keeps the secret in a
  run record.
- Visibility decides who may call a tool, not what the tool does.
- Sharing an app and allowing a pair of projects are about which sessions may call it, not what it
  does with what they send: an attached app receives whatever the calling session's agent passes it,
  which can include that project's files or conversation. "Always for this pair" covers every app
  the other project shares, including ones shared later.
- A permission is per capability, not per request: once an app may run an agent, the app decides
  what to ask it. The agent's writes and commands still stop at an approval card (`safe`), but
  what it may read is whatever its session can read.
- `sessions.list` gives session names, and an automatically named session is named after the first
  words of its first message. It never lists a session in the session archive (FR-22), and no app capability or
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
  import mark but require fresh review. A folder that is not the one marked (recreated under the id
  outside Centralu, or unreadable) also keeps the import mark and is unconfirmed until reviewed (#838):
  it used to read as no mark, which the gate takes for the person's own app, so replacing an enabled
  import's folder ran whatever the new one held. Removing the app through Centralu still forgets the
  mark. The mark is written before the folder is moved in, so a failed write brings nothing in.
  Lookups are read-only; importing or confirming explicitly
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
  segments and checked again to be inside the staging folder. A file is written 0644, or 0755 when its source (a
  folder's file, or a zip entry made on Unix) has any executable bit; no other mode bit (setuid) is carried over
  (`execBits`) (`imports.ts`, `zip.ts`;
  `imports.test.ts` "a zip cannot write outside (zip slip)", "a link inside the folder that points
  outside is refused (stating what it points at), and a link pointing inside is never moved",
  "caps: file count, one file, the total, depth, archive size", "a file stays executable whether the app came as a
  folder or as a zip").
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
- If `app-imports.json` cannot be read, the marks cannot be used, and the file is also the only
  record of which apps were imported (#1172). When it is gone and a moved-aside copy
  (`app-imports.json.unreadable-<ms>`) is in the data folder, every app then in the user folder, the
  person's own apps too, gets a mark (`lost`) in a new file written at once, and asks once before it
  runs again, with a reason naming both files: an app asks once more rather than running unasked. The
  new file is the record from then on, so an app made later is not held and removing the copy is
  safe; a mended copy put back is read as soon as the file changes. The new file goes in place by a
  hard link, which never replaces a file: one put back, or written by the other host of a swap, in
  the moment before wins. While the file cannot be read at all, the data folder cannot be listed, or
  the new file cannot be written (a data folder on a disk without hard links), every app without a
  mark is held instead (`ImportBook.doubt`), tried again once a second. The host logs it
  (`imports.test.ts` "a marks file that cannot be read holds the apps instead of running them").
- **Only the apps in the user folder at that moment are held.** An import whose folder is not there
  when the loss is found (moved out of the user folder for a while, or the whole `apps` folder
  missing) gets no `lost` mark, and runs as the person's own when it comes back.
- **An older build ignores the copy.** A build before #1172 (a rollback, or the older host still
  serving during a swap) reads a missing `app-imports.json` as no imports and runs every imported app
  unasked, as it always did. Once this build has written the file of `lost` marks, an older build
  reads them as imports not yet enabled and holds those apps too. A file an older build writes in
  the meantime, from its empty view of the marks, is taken as the record.
- An unreadable `app-secrets.json` is moved aside the same way, and its values stay in the
  moved-aside copy. For both files, only a file that
  does not parse, or parses to the wrong shape, is moved aside; one that cannot be read at all (no
  permission, too many open files, held by a scan on Windows) is left in place, reads as empty, and
  writes to it are refused until a read succeeds, as they are while a damaged file cannot be moved.
  Temp files a crashed write left (they can hold values) are removed at start when their writer's pid
  is gone or they are over a minute old (`private-json-file.ts`; `private-json-file.test.ts`).
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
or image from the host port, and navigating itself elsewhere is blocked by the `frame-src` of the
proxy page's header, which in this mode is the view's own policy (`buildViewCsp`: `'none'` unless
declared). A frame's navigation is checked against the document that embeds it, so the view's
`frame-src` stops it only because that document is the proxy page here
(`e2e/app-frame.spec.ts` "S-2 (browser part): an app frame cannot reach the parent, the top window,
storage, popups, or the host network", "which CSP stops a frame navigating itself outward", and
"opaque mode: the inner frame's origin is "null", and it cannot read the proxy's secret address").
The outer frame has
`allow-scripts allow-same-origin allow-forms` so that the per-app mode can work; its origin is
the host port's, not our UI's, so it cannot touch our window.

**Per-app origin, when an app asks.** `view.origin: "app"` in the manifest gives the inner frame
`allow-same-origin` on `http://127.0.0.1:<port>`: a real origin, so browser storage works. The
port is fixed per (project, app) and never given to another app, because WebKit keeps storage per
origin and a reused port would hand one app another's storage. The port book (`views/origin-ports.ts`,
kept in app settings under `apps.viewPorts`) only grows; a port another program holds is retired
for good and the app moves, losing what it stored there. Every change re-reads the book and
writes it in one transaction, so apps starting at once, or the old and new host of a swap, each keep
their own entry; a port another entry claimed while it was being bound is given up. Ports come from 20000–32767, clear of the
macOS and Linux ephemeral ranges, and listen on 127.0.0.1 only. The port serves only that app's
instances, behind a secret derived per app from the host secret (HMAC), so a view reading its own
`location.href` learns nothing that opens another app's route; the proxy page there allows only
its own script hash and that one frame origin (`origin-ports.test.ts`; `view-host.test.ts`
"per-app origin"; `e2e/app-frame.spec.ts` "per-app origin mode: gets a real origin on its own
port, storage is separated per app, and reopening gets the same origin"). That one frame origin
is also what stops the view navigating its own frame outward in this mode: the view's own policy
cannot, since a frame's navigation is checked against the proxy page that embeds it
(`buildProxyCsp`; `e2e/app-frame.spec.ts` "which CSP stops a frame navigating itself outward").

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
keywords, anything containing a space, `;` or `,`, and hosts of this machine (loopback, unspecified and
link-local, also with a trailing dot or inside a `::`-compatible or NAT64 IPv6 address: where the host's routes and other apps' ports live, and cloud metadata; the same check an
import's download address goes through) are dropped, and the drop is logged. A declared host is parsed the way a
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
they are **not** independent proof of project containment. What the host hands them depends on what it is for
(`fs.resolve`'s `purpose`, #838). For the **trash** it is the entry itself (`resolveEntry`): the folder it sits in is
resolved, the last segment is taken as it is, a link included, and the project folder is refused; the shell's trash
check (`assert_safe_native_entry`) allows a link only as that last segment, and the `trash` crate canonicalizes only the
parent, so a link is trashed as the link. For **reveal** and **open in an IDE** it is what the entry is
(`resolveTarget`): a link is followed, its target checked inside the project, and the project folder refused. Before,
both followed the last link, so an untrusted repository's `old-build -> .` sent the project folder to the trash. The
project folder itself goes to the trash through one door only, "Delete project and trash folder"
(`trashProjectFolder`, `purpose: 'project'`, which takes no path). A window from before this change sends no purpose
and gets `resolveTarget`: the project folder is refused, except as the literal root (`.`) its delete dialog sends, and
a link to something else inside the project is still trashed as its target until the window is updated. The shell
also refuses a path that ends in a separator or `.`, which its component check would otherwise drop (`link/`). Opening in an IDE does not fall
back to a generic OS opener that could execute repository-authored content. A linked machine's project is opened
with a VS Code Remote-SSH link instead (#82): VS Code connects over the person's ssh and, by default, asks before opening a remote file
or folder from a link (`security.promptForRemoteFileProtocolHandling`); the hub hands it a path and never reads or runs the file itself.

A worktree session's file links (#1209) name the session: `fs.readFile` and `fs.resolve` with a `sessionId` take that
session's folder as the root instead of the project's (its worktree, or the project when it has none), and every check
above runs against that root. The host builds the root from its own record of the session, never from a path the window
sends, and hands the same string to the containment check and to the read (`ProjectFiles.folderOf`, `dev-services/project-files.ts`). A session of
another project is refused, so a project id cannot carry a stranger's folder, and a path outside the worktree is refused
like one outside the project, the main checkout included. A session's folder is only read, revealed and opened: `trash`
and `project` with a `sessionId` are refused.

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
  on the resolved path, so a relative path in a session whose folder is a share is refused too. A local link that leads
  there (`shot.png -> \\host\share\x.png`, or a folder link earlier in the path) is refused as well, before `realpath`
  follows it, since following it is already the connection. On Windows the path is walked from its drive (`link-walk.ts` `walkLinks`,
  #849): what each name is comes from its folder's listing (`lstat` follows a link whose target libuv cannot read),
  and a link is followed by hand only when its target is a drive path or relative to the link's folder
  (`localLinkTarget`). Any other target is refused, the NT spellings of a share (`\Device\Mup\…`, `\GLOBAL??\UNC\…`)
  included, and so is a link whose target cannot be read (a junction to a volume with no drive letter), a name its
  folder does not list and that names none of its entries (a trailing dot or space, a stream), and more than 64 links.
  A short name (`RUNNER~1`, how a temp folder or a link's target may be spelled) is matched to the entry it names by
  file identity from `lstat`, which does not follow a link, and that entry is judged as itself: a short name of a link
  to a share is that link, refused. What `realpath` answers must be a drive path too. A
  drive letter mapped to a share is read like any other drive: the person mapped it.

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
  `resolveCommand`; tests in `tool-launch.test.ts`). A program not on PATH at all is never spawned by its bare
  name either: `git`, `gh`, `codex` and `claude` are then a path under `%SystemRoot%\System32` that only an
  administrator can make (`notOnPath`, `toolCommand`), so the spawn reports the tool missing. The bare name had been
  the answer there, and on a machine without git, gh or codex a `git.exe`, `gh.exe` or `codex.exe` committed to a
  project ran on its first status read, pull request look or listing of past Codex conversations, before any trust
  (#838; `git-exec.test.ts`, `git-pr.test.ts`, `codex/not-installed.test.ts` plant one). PATH lookups skip relative entries
  (`env-path.ts`, and `node`/`code` in the Rust shell), and are otherwise no narrower than Windows' own search, so a
  tool it would start is found: a quoted entry is read without its quotes, and an App Execution Alias counts as there
  (`env-path.test.ts`). `du`, which sized the copy candidates by
  bare name with the project as its folder, is not run on Windows at all: the sizes are read from
  the file system there (`measuresWithDu`, #849; `git.test.ts` plants a `du.exe`).
- **System programs by their whole path.** taskkill, Windows PowerShell and cmd.exe are named under
  `%SystemRoot%\System32` (`os.ts` `systemTool`, `commandInterpreter`; `%ComSpec%` for cmd). A `SystemRoot` or
  `ComSpec` that is not a whole path from a drive's root (empty, relative, drive-relative like `C:x`, rooted without
  a drive) is not used and `C:\Windows` is (#428): an empty `SystemRoot` made taskkill's path
  `System32\taskkill.exe`, which Windows looks up in the working directory, the project's folder (`os.test.ts`).
  The remote installer, which runs on its own on a linked Windows machine, names its `tar.exe` by the same rule
  (`links/remote-install.mjs` `tarProgram`, `install.test.ts`).
- **Tool shims are read, not shelled.** npm and pnpm install a tool as a `.cmd` file, which Node
  starts only through `cmd.exe`, and cmd.exe would read `%`, `^`, `&` and quotes in our arguments
  (JSON, prompts) as its own syntax. The shim is read for the `.js` or `.exe` it starts, and that
  is spawned without a shell. Project commands (the Run button) do run under `cmd.exe /d /s /c`,
  because the command is the person's own text.
- **Paths.** `path-guard.ts` refuses a path whose `relative()` from the root is absolute (another
  drive, a UNC share), instead of walking its segments inside the root (`path-guard.test.ts`, with
  `path.win32`). A link along the path is not followed to see whether it stays inside before the walk of
  `link-walk.ts` (the one a reply's image takes) has read where it leads: a symlink to a share (`docs -> \\host\share`),
  or a chain of local links ending in one, is refused unread, since `realpath` following it is already the SMB
  connection with the person's sign-in offered; the guard used to refuse it only afterwards, as outside the project
  (`path-guard-share.test.ts`). A project that is itself on a share (opened from one, a mapped drive, `\\wsl.localhost`)
  keeps its links on that one share: they are followed, and a link to another host or share is refused. Windows paths ignore case; containment folds case as NTFS does (`foldCase`). Every
  "inside" test in the host is `isInside` in `os/rules.ts` (`path-guard.ts` `isInside` is that rule for a given path style: NTFS's case folding, which keeps the Kelvin sign apart from `k`), and every comparison that must see one
  place in two spellings canonicalizes with `canonicalPath` there (`realpathSync.native`: the long name
  for a short one, the case on disk, a link resolved, through the nearest folder that exists; #428). The
  copies had drifted: ask_project's read grants compared with case and the JS `realpath`, so a short
  name or another case was refused, and a touched file under a project kept through a link was dropped.
- **Names that are not file names.** A file dragged into the tree (`importFile`) is refused on
  Windows when Windows would not make a file of that name, by the rules a new project folder's
  name follows (`folderNameError`). Node writes through `\\?\` paths, so a device name (`nul`,
  `aux.c`, `nul .txt`) or a name with a trailing dot or space lands as a file of that very name, which
  Explorer, cmd and git read as the device or as another name and cannot open or remove; and
  `notes.txt:payload` writes a hidden stream on `notes.txt` past the no-overwrite flag (#849).
- **File identity.** A read's opened-file check is the only guard against a swap there, since
  Windows has no `O_NOFOLLOW`. An NTFS file id is 64 bits with the record's reuse count on top, so
  it is above 2^53, and as a Number two files can compare equal: on windows-2022, 1754 of 2000
  pairs of files made one after the other did. `dev` and `ino` are compared as bigints
  (`path-guard.ts` `assertExistingPath`, `fs.ts`; `fs-read-identity.test.ts`, #368).

Limits:

- The files written `0600` here (`app-secrets.json`, `app-imports.json`) get no mode on Windows,
  which has no mode bits; they are as private as the folder they are in. The default data folder
  is in the user's profile, which only that user (and administrators) can read. A `CC_DATA_DIR`
  elsewhere gets that folder's ACL.
- Junctions are reported as links by `lstat` and so are treated like symlinks, except one whose target
  libuv cannot read (a volume path, `\\?\Volume{…}\…`, which anyone can make): `lstat` follows that one and calls it a
  folder, so the worktree copy and the reply-image walk ask the folder's listing instead, and the path guard checks
  where every entry `lstat` does not call a link really is (`realpath`), which has to be inside the project too. It
  had walked on inside such a junction as if it were the project: the file tree listed the folder it led to and a
  dropped file was written there (`path-guard.test.ts`, also by a short name and another case). Creating a symlink on
  Windows needs Developer Mode or administrator rights; a junction does not.
- The keeper does not run on Windows (no named-pipe control socket), so the direct path is used.
