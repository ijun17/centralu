# Who gets Centralu's own tools (tool profiles)

Every session gets one bundle of the `centralu` server's tools, or none. One pure rule decides which
(`toolProfileFor` in `sessions/tool-profiles.ts`, from the row's kind, its app and builder slot and
the Settings switch; `toolBundleFor` names the object behind each profile). The manager asks it in one
place (`toolChoice`: the profile, and the bundle built when the adapter's options are), used at create, at
every wake, on every bridge call and by `toolProfileOf`, so they cannot drift apart. The Assistant's,
a coordinator's and the reader's objects are one function, `centraluToolsFor` (`sessions/assistant-seat.ts`),
over the narrow view of the manager it is handed (`AssistantSeatHost`);
`profileAllows` decides both what the bundle exposes and what its calls may run, so a name the
bundle leaves out is refused even through the Codex bridge.

| Profile | Who | View | Tools | Instructions |
|---|---|---|---|---|
| `assistant` | the one Assistant | every session | all but the builder's | role and usage |
| `scoped` | a coordinator (#80): made only by the control app's tasks, which were removed in #372 with the RPC that created one; the ones in a store still wake with this profile | its members | list, read, send | its boundary |
| `builder` | an app's building session (M4 C-3) | its own app | `check` | build-and-check |
| `reader` | every other session in a project (#320), a former worktree manager included | from a trusted project, reads every session here and on linked machines but an Assistant's (#984, #1941); from an untrusted one, its own project only; acts on the agents it started (auto: any session in its own project) | `read_session` (no id: lists), `recall`, `app_guide`; `ask_project` (#371, [delegation/ask-project.md](delegation/ask-project.md)); `start_agent`, `agent_session` (#561, [delegation/start-agent.md](delegation/start-agent.md)); and `find_apps`, `attach_app`, `detach_app` (#371 part A, apps.md §9.4) | Centralu's tools first unless the person says otherwise (#564) |

The instructions reach the model on both CLIs, by different doors. Claude gets them as the in-process
server's `instructions`. codex-cli 0.160.0 shows a server's instructions to no model (#525, measured with
`scripts/probe-codex-mcp-instructions.mts`), so the Codex bridge sends none and the same text rides in the
thread's developer instructions, after the seat's role, under a one-line header. Codex reads those at
`thread/start` only and ignores them on `thread/resume`, so a Codex thread keeps the instructions it was started
with: one that changes profile while its thread lives on has its new tools without their instructions until it starts a
new thread.

**There is no worktree manager** (#561 part 3, owner 2026-10-12). A session starts worktree
agents itself (`start_agent` with `worktree`, [delegation/child-workspace.md](delegation/child-workspace.md)), works with them (`agent_session`) and removes an idle child
with `agent_session` `delete`, keeping local work with the session in the session archive (#608, `cleanUpWorktreeChild` in `sessions/worktree-sessions.ts`). What stayed: the person's own worktree
sessions (the new-session window's option; they now stand alone instead of under a manager made for them), merge and
pull-request detection on every worktree session, and the project's trunk (`worktrees.setTrunk`, kept in the former slot's row;
the project menu's "Worktree trunk" entry was removed in #733, so the trunk is detected and used but no screen sets it) The Assistant gets no replacement for `propose_worktree_session`:
making a branch and a folder in the person's repository now goes through a project session's consent card, and the
assistant reaches that session with `send_to_session`. Existing data: store v48 gives a former manager's worktree
sessions `askedBy` = their parent, so it owns them as the agents it started; the slot's column stays until a later contract step.

The reader's read tools stay inside its project, and its tools object refuses changing
settings outright, not only by name. Its agent tools follow [delegation/start-agent.md](delegation/start-agent.md), including auto's ownership opening. Its update tool requires consent outside auto ([lifecycle/updates.md](lifecycle/updates.md)). It is never given to an agent
session an app stood up (M4 D-1), whose answer goes
back to the app. It cannot be turned off (owner decision 2026-10-20): `sessionTools` stays in the preferences record
for older builds, but the host reads it as on whatever is stored and does not store an "off" an older window sends.
For provenance (#90) a reader is
still an ordinary worker — `directs()` counts every profile but `reader`.

**Its size is the design constraint**, because it rides in every session on every turn. Measured
against the real CLI (haiku, CLI 2.1.289, `scripts/probe-reader-tools.mts`; first request's input
tokens over a run with no `centralu` server, claude.ai connectors off):

| Shape | Characters | Tokens |
|---|---|---|
| `list_sessions`, `read_session`, `recall`, `app_guide` in the Assistant's words | 2,493 | +672 |
| the same four, re-worded | 1,138 | +338 |
| listing merged into `read_session` (three tools, all loaded) | 897 | +267 |
| **as shipped**: `app_guide` deferred behind tool search | 897 | **+192** |
| all three deferred | 897 | +28 |

Per tool, loaded: `read_session` 239 → 98, `recall` 182 → 84, `app_guide` 148 → 85,
`list_sessions` 103 → 75 before it was merged away. A tool costs about 55 tokens before its first
word (name and schema envelope), which is why merging beat trimming. Deferring the whole set was
refused: asked about an earlier conversation, the model never called `recall` (the Assistant
had measured the same for `send_to_session`, which is why its tools are `alwaysLoad`). Deferred,
`app_guide` was found through tool search 4 times in 5, against 5 in 5 loaded; the miss is an answer
from a guess about the app, and the Assistant has the guide loaded. Codex has no deferral and
gets all three. `centralu-tools.test.ts` fails if the serialized set and its instructions pass
`READER_BUDGET_CHARS` (1,000 until #564 gave the set its 392 characters of instructions; 1,400 since,
the set at 1,375). #581 adds the consented update tool, deferred on Claude like the guide, and its
instructions pointer: 1,709 characters against a 1,750 ceiling. #1480 gave `read_session` `tools` (three words or a boolean),
`maxChars` and the `before`, `from` and `offset` a budget's notes name, all without a description: +204 characters, 1,913 against a
ceiling raised to 1,950 (the reader's resident sum rises by the same 200: Claude 2,396 definitions + 413 instructions, 2,562 more
deferred; Codex, loading all, 4,958 + 465 = 5,423 against 5,500). They are all in the definitions because Claude's in-process server
strips an argument its schema does not list before the tool runs (measured on the SDK's `tool()`), so a read a note names would
lose its argument. The same arguments cost the Assistant and the scoped seat 178 characters (a short description for `tools` and
`maxChars`), whose ceilings rise 9,500 → 9,700 (Codex 9,663) and 2,400 → 2,600 (Codex 2,560). The full reader profile's resident
and deferred figures for both CLIs are in [tool-cost.md](../tool-cost.md) §11 and §14. #1487 restored `.int().min(0)` on `offset` (the schema had lost it): +12
characters in the reader set and in the Assistant's, whose ceilings rise by 10 (1,960 and 9,710), the reader's resident sum by 25 (2,850).

The app-access tools (#371 part A: `find_apps`, `attach_app`, `detach_app`, apps.md §9.4) are the
Assistant's too since #1205, as rare commands behind `centralu_run`, for the root apps it attaches
when it needs one ([tool-cost.md](../tool-cost.md) §12). In an ordinary session they ride on
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
[tool-cost.md](../tool-cost.md) §8. #523 made `app_guide`'s `topic` an enum of its seven topics (the
reader set is 983 characters with it).

**Measuring it again** (#513). `pnpm measure:tools` measures every profile on both CLIs the same way,
repeatably: resident tokens (the API's usage, and `count_tokens` with and without Centralu's tools), cache
reads and writes per request and which event caused a rebuild, tool selection and first-try argument
validity on a fixed prompt set, and what tool results add over a longer session. `centralu-tools.test.ts`
pins each profile's resident characters (`RESIDENT_BUDGET_CHARS`), and `adapters/claude/tool-prefix.test.ts`
that attaching or detaching an app never changes a Claude session's tool list. How to run it and read it,
and the baseline: [tool-cost.md](../tool-cost.md). That baseline (2026-10-12) found that Codex no longer puts
MCP tools in the request up front: codex-cli 0.160.0 reaches them from its own `exec` tool, so "Codex has no
deferral" above describes the CLI the numbers above were taken with.

**The Assistant's rare commands** (#512, the commands tier since 2026-10-12).
`create_app`, `propose_skill` and `propose_mcp_server` are a third of what the Assistant carries and the
least of what it calls. The host takes
them out of the tool list and serves three fixed tools in their place, `centralu_commands` (one line each),
`centralu_help` (one command's schema) and `centralu_run` (checked on the host against that schema, strictly;
a wrong call answers with it), plus one line in the instructions saying they exist. The profile rule is the
same (`commandsFor` lists and runs only what `profileAllows` gives the seat), and a run goes through the same
runner, so each command keeps its result and its card. `propose_worktree_session` was in the tier at first and
came out: nothing in the instructions names it, and hidden it was never reached. `app_guide` stays a tool: the person's questions about
the app come unannounced, and deferred it was found less often (tool-cost.md §8). The tier never changes while the host runs, since a session's tool list is its prompt prefix; there is no setting
for it (the `resident` and `deferred` arms were measurement switches, removed under #1143). The three
arms were compared in [tool-cost.md](../tool-cost.md) §9. On Sonnet the tier lost nothing (every rare command
reached, first-try arguments valid, English and Korean) and saved 835 tokens a request; on haiku it saved 709
and reached a rare command less often (15 of 24 against 23 of 24). The owner made it the default on the Sonnet
numbers and because it keeps the Assistant's resident prefix from growing as commands are added
(decision of 2026-10-12, #512): the Assistant carries 9,317 characters instead of 11,862, and its ceiling
(`RESIDENT_BUDGET_CHARS`) went from 12,000 to 9,500.
**Centralu's features first** (#564, owner decision 2026-10-12, product-spec.md §1.2): unless the person says
otherwise, agents running in Centralu use Centralu's own features first. Two seats carry it. The Assistant's role
starts with a preamble saying so (`assistantRole`; it names `centralu_commands` where the seat has the tier), first
measured in round 2 of tool-cost.md §9 at 33 to 55 tokens a request with no regression and no gain that held, and on
since #564. An ordinary session, which has no role, gets the same rule as its tools' instructions
(`readerInstructions`): one sentence naming which tool answers which need (`readerFirst`: `recall` for earlier
conversations, `read_session` for other sessions, `ask_project` for another project's work,
`find_apps` for another project's apps, and `start_agent`, not the CLI's own subagent tool (Claude's `Agent`, Codex's
`spawn_agent`: each adapter declares its own as `subagentTool`, #1587), for long work, another CLI
or a worktree, or work the person will follow; the CLI's own subagents stay the way to hand off short helper work
inside the turn, owner decision of 2026-10-12). A tool that joins the reader seat and answers a need the person states
in words adds its line there. Before #564 the reader set had no instructions, on the principle that Centralu offered
tools to the person's sessions and did not direct them; the owner withdrew that principle. The switches that turned either off
(`CC_ORCHESTRATOR_PREAMBLE`, `CC_READER_INSTRUCTIONS`) were measurement tools and are removed. What
they cost and change: [tool-cost.md](../tool-cost.md) §11.

A Codex session with a bundle starts the stdio bridge, so since #320 every Codex session starts
one more node process (about 40 MB resident, idle). The bridge sets
`default_tools_approval_mode: 'approve'`: our tools are never asked about, as on the Claude side,
and without it Codex in auto (`approvalPolicy: never`) refused every call on its own.
The bridge decodes its stdin as one UTF-8 stream: a pipe can split a multibyte character between
two chunks, and decoding each chunk on its own put U+FFFD into the tool's arguments.
`scripts/smoke-delegation.mjs reader` runs the set end to end with a real model (`TOOL=codex` for Codex).
