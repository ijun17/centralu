# Starting other agents in the same project (#561)

`start_agent` and `agent_session` let an ordinary session start a Claude or Codex session in its own project and
work with it ([agent-host/delegation/start-agent.md](../agent-host/delegation/start-agent.md)). They add no reach the caller lacked (the child works on the
same files under the same or a lower preset), but they multiply what runs. The rules below
apply to `safe` and `normal`; `auto` opens the consent, ownership and trust
boundaries (#603), with a log line instead of a card or refusal (Claude's own cross-session messaging is closed under `auto` too, [inter-agent-content.md](inter-agent-content.md#claudes-independent-session-messaging-569)). The agent depth binds every preset, `auto` included (#867):

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
  Assistant, `prefs.agentDepth`). A session the person started is depth 0; one started by another (`askedBy`), or
  working on a task another session gave it (an unsettled delegation: `ask_project`, a fork, `agent_session`), is one
  deeper than that session, the deepest link counting; a fork whose requester is gone is at least 1, so a fork the
  assistant made (no `askedBy`) counts 1 for good, and a session an `auto` caller reached through `agent_session`
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
- **The Assistant's children** (#853): the Assistant reaches `start_agent` and `agent_session` too (as commands
  in the `commands` tier), for light work outside any project. Its child has no project and works in a folder of its
  own under `<data>/orchestrator-agents`, never the Assistant's, so nothing it writes lands where the Assistant
  reads (Codex loads `.agents/skills` from a session's folder whatever the trust) and no two children share one; the
  folder goes when the child is deleted for good. It runs under the Assistant's preset with no Centralu tools and
  only the person's own settings (no project to trust). The consent is a card under `safe` and `normal` (no
  project's trust stands in for it), with "always for this project" kept as always for the Assistant while the host
  serves it, since there is no project to remember it for; `auto` opens it. `agent_session` acts only on a child whose
  `askedBy` is the Assistant, in every preset. The depth binds as for any caller: the Assistant is at 0.
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
[#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6461617566); [plans/antigravity-acp.md](../plans/antigravity-acp.md) §4.2).

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
