# A child's workspace: worktrees, sandboxes and the machine's room

**In a new worktree** (part 2). `worktree: true`, or a `branch`, opens the child in a new git worktree of the
project's repository instead of the caller's folder, through the same path as the new-session window's worktree
option (`createSession`'s `worktree`, `worktreeBranch`, `worktreeBase`: the copy-and-setup step;
`auto` delegation may also create a worktree in an untrusted project). The branch is the one asked for (git's own rule checks it) or one named from the job or from the caller's `name` (`agentBranch`:
`centralu/write-the-parser-1a2b`, at most 40 characters after the prefix, cut at a word, #861), settled before the card, which names it. It forks from the caller's own branch
when the caller is itself a worktree session, so the child starts from the caller's work; otherwise from the
project's trunk as the remote has it (#1484, `resolveForkBase`): the trunk is fetched (bounded, trusted projects only) and the
child forks from `origin/<trunk>`, never from the checkout's HEAD, which may be any branch; with no remote, a failed or timed-out fetch, or an
untrusted project it forks from the newer of the local trunk and the remote-tracking ref last fetched, and with no trunk found at all from HEAD.
A fetch that failed is remembered per repository and remote for 5 minutes (#1488, `gitFetchBranch`): no start asks again meanwhile, so an
unreachable remote costs one wait, not one per start. Where the worktree forked from is the start answer's note for a local start, the
`worktreeBase` of `agents.createSession`'s answer for a linked machine's (an older machine leaves it out), and a session notice for the person when a remote was not fetched.
A branch asked for that is already there (#1662, a pull request's handed to a new session; `WorktreeSessions.takeBranch`)
is not forked: the worktree starts on it as the remote has it, fetched (trusted projects only), tracking it when only the remote
has it. A local branch behind the remote is moved to its head when every commit of its own was on the remote at some point
(the remote-tracking ref's reflog, so a rebased pull request counts) or is on the trunk; otherwise the start is refused with
the count. An archived session's worktree that has the branch checked out is removed when it has no uncommitted change and
every commit of its own is on a remote or the trunk; any other worktree that has it (a session not archived, the project's
folder, one of the person's) is never touched, and the refusal names it. A start that fails keeps such a branch, and so does the session's cleanup later: `worktree_branch_was_there:<session>`, an
app setting (no store step; a build before it reads nothing new), marks it, and goes when the session is deleted for good.
The start answer's `notice` names the base commit and what could not be done (a start on a linked machine does not carry it back yet). The recorded base (`baseSha`) is that commit. A project that is no git repository is refused before the card. The child shows as every worktree
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
either existing creator/parent link, including records reloaded after a host swap. Stored session and archive
shapes stay unchanged, so the previous host can continue reading them during a swap.

**A usable worktree** (#582). Provisioning reuses installed JS dependencies automatically, even without a
configured setup command. With an unchanged root lockfile (`pnpm-lock.yaml`, `package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `bun.lock` or `bun.lockb`), missing `node_modules` folders are cloned from the
project checkout, including workspace packages whose `package.json` is unchanged. Existing folders and links
are left alone. The existing APFS clone / ordinary-copy fallback gives the child independent files: a symlink
to the project's dependencies would let it change the original checkout. Internal dependency links stay;
links escaping the new worktree are removed after all package copies finish, except a link into the project, which is made
again leading to the same place in the worktree (on Linux and Windows by the copy, after macOS's APFS clone by `dropEscapingLinks`, #1708). No install or lifecycle script
runs automatically. If dependencies are absent in the project, differ from the child's lockfile/manifests,
or cannot be copied, the configured setup command or the child must install them; creation still continues.
What provisioning could not do (a copy skipped or refused, a link dropped, dependencies or the setup command
failing) is a warning notice at the top of the new session, and a `start_agent` child also gets it in its task,
since an agent does not read notices (#841). A step after `git worktree add` that throws before a session owns
the worktree removes the folder and its branch again (#774); what could not be removed is named in the error.

**Removing a worktree** (#1655, #1560, `gitWorktreeRemove`, the one path for every removal: a start that failed, an
agent's cleanup, a purge, a branch taken over). The host removes the folder (`removeData`: never through a link, long
paths taken), then git drops its entry. git did the delete before, and on Windows it deleted through a junction what
the junction led to (a pnpm-style link out of the worktree), and stopped at a path past 260 characters after it had
already dropped its entry and the `.git` file, so the folder stayed with nothing to clean it (a junction to the project
took the project with its `.git`). A link (a symlink, a junction) is never removed: git would take the worktree it
leads to. A folder that holds a checkout git lists is never removed. A folder git no longer lists is removed the same
way only as a session's folder in the worktree root (`<root>/<project>/<session>`) with no `.git` of its own (what such a stop left);
anything else unlisted is refused. git is given the path as it lists it (a Windows short name it does not match).
A removal that cannot finish (a file held open) throws with the path and what was left, and git's entry stays for a
retry; the archive's answer and the purge say so.

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

## What a child costs the machine: code intelligence and the memory gate (#686)

Parallel children are bounded by memory before usage. Measured on the owner's 24 GB Mac (2026-10-14): a Claude child
that used code navigation ran its own `tsserver` at 0.5–1.1 GB in this monorepo, beside 0.3–0.5 GB for the CLI;
Codex starts no language server. The owner decided (2026-10-15) two things.

**Code intelligence is off for a child unless its caller asks.** `codeIntelligenceOff` (tool-profiles.ts) is the rule:
a child (`isChildSession`: a `start_agent` child, a fork, an app's agent) starts without it unless `start_agent` passed
`lsp: true`; sessions the person starts, the Assistant and builder sessions keep the person's own setting. The
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
| A fork ([delegated-turns.md](delegated-turns.md#requests-to-a-busy-session-677)) | Becomes a place in the busy session's queue instead (`enqueue`), which starts no process; the answer says `queued` with `lowMemory`, read as "Not forked: memory is low … queued instead". |
| An app's agent | Waits inside the app's call: the run's progress says "waiting for memory", and the agent starts when memory recovers; a cancelled call ends it without a session. |

The wait re-reads memory every 15 s (`MEMORY_RECHECK_MS`) and lets **one** queued start go per check, oldest first:
a child takes its memory over the first seconds of its turn, so starts released together would all read the same free
memory. It gives up after 30 minutes (`MEMORY_WAIT_MAX_MS`): the caller is told as a message and the person in a
notice. A withdrawn request, a deleted caller, or a host leaving (`disposeAll` closes the gate; the stored
request goes to the next host) ends the wait without a start. Sessions the person starts are never gated.
