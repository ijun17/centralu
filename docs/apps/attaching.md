# Attaching apps to sessions

## Which session gets which apps (decision 4)

| Session | Apps |
|---|---|
| Assistant | User-folder apps. The root apps of trusted projects it attaches when it needs one ([other-projects-apps.md](other-projects-apps.md), #1205); an untrusted project's root app reaches it under no preset. Two of one id are named apart, and a name once seen stays with its app (below) |
| A project's sessions, worktree sessions included | That project's apps, if the project is trusted |
| A builder | The above, and its own app (a user-folder app's builder has no project) |
| Any other | None |

Beyond this table, a project's session can attach an app **itself** for as long as it needs it: an
app another project shares, a user-folder app, or another project's root app; and so can the
assistant, a trusted project's root app ([other-projects-apps.md](other-projects-apps.md)). Apps that are `invalid`, `untrusted` or
`failed` are not attached. The rule is checked again **at every call**, not only when attaching:
Codex cannot change a running thread's servers, so the per-call check is what actually stops an app
that was detached.

Each app appears as an MCP server named `app-<id>`; in Claude its tools read `mcp__app-<id>__<tool>`. A name a session has seen stays bound to its app for the session's life (#1141,
`session_app_names:<session>`, purged with the session): a later app with the same id (the root app of
another project, say) gets a name qualified by its project, `app-<id>-<project>`, never a name another
app held, one gone for the moment (its manifest broken mid-edit) included; `attach_app` keeps to the
same book. No name is longer than `app-<id>` of the longest id (36 characters, `SERVER_NAME_MAX`), so
`mcp__<server>__` leaves a tool 21 of the 64 characters a tool name may have: a long project name is
cut, and a name cut short stays unique by a number. **An untrusted project's apps attach nowhere**, its own project's sessions included and
under `auto` too (owner, #1141): #603's opening of an untrusted project's apps to an `auto` session no
longer applies, and the runtime refuses them for every caller.

**A session's tool list does not grow with the projects the person trusts** (#1205). Every attached
app is a server whose tools ride in each request: Claude defers them behind tool search, so their names
still cost; Codex loads them. Until #1205 the Assistant was given every trusted project's root app
(#1141), so with ten projects that are apps it carried ten servers it mostly never called. A rule that
gives a session apps by a count that grows on its own (projects, shares) is not added to decision 4;
such apps are reached on demand ([other-projects-apps.md](other-projects-apps.md)), and the session pays for the ones it attached. What it is given
is bounded by things the person set up for that session: its own project's apps, its own app as a
builder, and for the Assistant the user folder, where an MCP server the person approved for it lands
(A-7). Measured with the app `create_app` makes (two agent tools and the host's `run_status`), with 0, 3
and 10 trusted root apps: before, Codex 6,800 / 9,179 / 14,733 characters and 11 / 20 / 41 tools, Claude
6,800 / 7,004 / 7,483 (the names alone); after, 6,800 and 11 tools in every case, plus 75 characters of
instructions once (`sessions/assistant-app-cost.test.ts`, [tool-cost.md](../tool-cost.md) §12).
The tool list is the last one read, so starting a session does not start every app. If none has
been read yet, the host starts the app and waits up to 15 s, then attaches it with an empty list
and updates the list when the app answers. A session's apps and `attach_app` wait the same bound
(`TOOL_LIST_WAIT_MS` in `sessions/session-apps.ts`, through `withTimeout`, #428).

## Apps through two fixed Centralu tools (#2231)

Owner decision (2026-11-12, option B; #512's apps row): a session reaches its apps through Centralu's own
server, never through one MCP server per app. Before, every attached app was a server in the session (Claude: an
in-process proxy per app, swapped in with `setMcpServers`; Codex: a stdio bridge per app, fixed at `thread/start`,
`tools/list_changed` ignored), so a Codex thread never saw an app that arrived mid-thread, and a Codex request grew
with every attached app. Now the session's tool list is the same whatever apps come and go, on every CLI that has
Centralu's tools.

**The tools** (every profile: the Assistant, a coordinator, a builder and an ordinary session; each has apps under
decision 4):

| Tool | Does | Answer |
|---|---|---|
| `app_tools({ app? })` | No `app`: this session's apps, decision 4's and what it attached, one per line with the first line of its description and its tool names (`(reads)` after a read-only one). With `app`: that app's tools, one line each with the read-only mark and the input schema | Names `app_call`; with no app, `find_apps` where the seat has it |
| `app_call({ app, tool, args? })` | Calls one tool of one of this session's apps. `args` is an object (JSON text of one is read too) | The app's own result (`content` and `structuredContent` as the app gave them); a mismatch answers with the tool's schema and runs nothing |

`find_apps`, `attach_app` and `detach_app` keep their roles (another project's or the user folder's apps, #371 part A);
`find_apps` is the one listing of what a session *could* attach, `app_tools` of what it *has*: no app is in both. An
app made or attached mid-session is callable on the next `app_call`, the same turn included, on both CLIs: the
call checks the session's apps at call time, and nothing is restarted.

**Names.** `app` is the app's name in this session: its server name of before without `app-` (`board`,
`board-centralu`, `board-2`), from the same book (`session_app_names:<session>`, #1141), so a name a session has
seen still never comes to mean another app. `app-board` is read as `board` (a session's earlier turns used the server
names). The cut that kept `mcp__<server>__<tool>` within 64 characters (`SERVER_NAME_MAX`) goes: no app name is part
of a tool name any more.

**The one call path.** `app_call` reaches the hub's `SessionApps.call`, which re-checks decision 4 and the
attachment at the call and goes through `ExternalApps.call` (caller `session`), as before. The host checks `args`
against the tool's `inputSchema` first (zod's JSON Schema reader; a schema it cannot read is not checked, as the CLIs
did not), so a wrong call costs no run and no card.

**Approval moves to the host, at the call, with the real arguments**, the same on every CLI. In order:

1. The Assistant in a turn a session's request started (#1447): the request gate (`whenAsked`), as before.
2. A tool that runs unasked (`readOnlyHint`, or `centralu/risk` `local`, or `routine` in the session's own
   project's app under `normal`, now with the real arguments on Codex too): no card.
3. Otherwise the session's preset, read at the call:

| Preset | Claude | Codex | Before (Claude / Codex) |
|---|---|---|---|
| `safe` | Card | Card | Card / card (`prompt`) |
| `normal`, `edits` | Card, unless the person's own Claude mode is `bypassPermissions` | Card, unless the person's own `approval_policy` is `never` | The CLI's flow (a card, the person's rules, their mode) / card (`writes`), `approve` under `never` |
| `auto` | No card | No card | No card / no card (`approve`) |

The card is the host's (`HostCards.askHost`) in the session's approval slot, the same `other` card a Claude app
tool raised (`mcp__app-<name>__<tool> {arguments}`); Allow runs the call, Deny answers "denied by the person",
and Always allows this call only (an app tool's card has no rule key, as before). Codex never asks about Centralu's
tools itself (`default_tools_approval_mode: approve`), so nothing of Codex's sits in front of the card. What changes:
a Claude `normal` session's own permission rules that named `mcp__app-…` tools no longer apply (the CLI never sees an
app tool), and a Claude mode other than `bypassPermissions` (`dontAsk`, `plan`, `auto`) gets the card;
`askWhen`/`askUnless` are honoured on Codex as on Claude, since the host has the arguments.

**Waiting.** A card stands until the person answers; on Codex the Centralu server's call ceiling
(`tool_timeout_sec`) is raised from 300 s to 3,600 s so that a card is not cut by Codex (before, Codex asked
before the call and its 300 s ran only once allowed). An app's run still answers "still running" with its run id
after 240 s on Codex and is followed with `app_call(app, tool="run_status", args={run_id})`; Claude waits, as before.

**Cards and history.** A call's card shows the app and its tool as an app tool's did: the adapters mark an
`app_call` with `centralu: { app, tool }` (`centraluMark`) and title it with the arguments, so the screen draws it
as it drew `mcp__app-<id>__<tool>`. An old record keeps its `mcp__app-<id>__<tool>` name and mark and renders as
before. The inline view (B-1) joins the call to its card as before: Claude passes the card id
(`claudecode/toolUseId`) on the Centralu call; Codex's `item/started` for `app_call` is noted with the app, tool
and arguments inside it.

**Instructions.** One line, where a session learns how to reach apps: the reader's first-tools line says
`app_tools and app_call for this session's apps`, and #957's line on repository work names an app's help tool
through `app_call`. The Assistant's, a builder's and a coordinator's instructions get one short sentence each.

**Older window and host** (protocol.md §4, additions only). No shape changes. A record of an `app_call` carries
the same `centralu` mark an app call had, so an older window draws it as before (`centraluCallOf` reads the mark
first). An older window's `apps.reach` stops seeing `restart` and `bridge-failed`, which nothing produces now. The
bridge methods `apps.sessionTools` and `apps.sessionCall` are removed (§3.2): only an app bridge of an older host's
Codex thread called them, and such a thread is restarted with the host.

**Recordings and replay.** The Claude recordings `mcp-app.jsonl` (2.1.296, 2.1.316) keep `mcp__app-…` calls: they
are history, and their replay stays as it is (an old record renders). A recording of an `app_call` needs a live
re-record on each CLI. Fixtures that carry a session's tool list (`surface-baseline`, the tool-prefix test) gain the
two tools and lose the app servers.

**What is deleted.** The Claude app proxy (`app-proxy.ts`) and the server sync for apps (`setMcpServers` on every
attach, detach and app change); the Codex app bridge (`CC_APP_SERVER` in `centralu-bridge.mjs`), the app part of
`thread-servers.ts` (per-tool `approval_mode`, `appApprovalModeFor`, `checkAppMode`, `appAttachment`), the elicitation
path for app servers in `server-requests.ts`, the thread restart after an attach (`appsRestartAfterTurn`), the
adapters' approval branches for app tools (`appToolUnasked`, the request hook's app branch), `SERVER_NAME_MAX`, and
the bridge RPCs `apps.sessionTools`/`apps.sessionCall`. Apps' own MCP servers stay: they are the host's backend.

## Claude and Codex

| | Claude | Codex |
|---|---|---|
| Attachment | An in-process proxy server per app | A stdio bridge process per app (`centralu-bridge.mjs` with `CC_APP_SERVER`); none for a session with no apps |
| Apps come or go | `setMcpServers`, without a restart; visible from the next turn. The whole set goes every time, because the SDK drops a server left out, `centralu` included | Not within a thread: Codex ignores `tools/list_changed`. Applied from the next thread. `thread/resume` carries the same MCP configuration as `thread/start` |
| An app's tools change | The proxy sends `tools/list_changed` | From the next thread |
| Approval | `canUseTool`, then our approval card | Codex asks through an elicitation marked `codex_approval_kind: "mcp_tool_call"` (`codex/approval_kind` in newer source; both are read). For our app servers it becomes our approval card, where it used to be declined automatically |

**Approval (decision 5)**: a tool the app annotates `readOnlyHint: true` is never asked about. Other
app tools follow the session's preset. The decision is made from the attached app's tool list, not
from a server name that starts with `app-`.

| Preset | Read-only tool | Other app tool |
|---|---|---|
| `safe` | No card | Card. Codex: `prompt`, with each read-only tool set to `approve` |
| `normal` | No card | As the person's own settings decide, like any other tool. Claude: the CLI decides whether to ask. Codex: `writes`, which asks about tools that are not read-only |
| `auto` | No card | No card. Claude: no callback. Codex: `approve`; without it Codex, under `approvalPolicy: never`, refuses an unannotated tool itself |

**A write can declare how risky it is** (`apps/external/tool-risk.ts`). Everything that is not read-only used to
ask, from a note in the app's own data folder to a merge, and "always" does not help on Claude: an app tool's card
has no rule key, so nothing it remembers reaches the next call. A tool may say, in its `_meta`:

| `_meta["centralu/risk"]` | Means | No card when |
|---|---|---|
| `"local"` | Writes only this app's own data on this computer, and can be undone | Always, under every preset and in any attached app. Only next to `annotations.destructiveHint: false` (the MCP default is `true`), so a tool that is silent about it still asks |
| `"routine"` | An ordinary write its own project would do anyway (a comment, a pull request). Not one that merges or releases: leave those undeclared, so a card stays the check on them | The app belongs to the session's own project (a trusted project: an untrusted project's apps do not attach), under `normal`. Not for a user-folder app, an app attached from another project, the Assistant, or `safe` |
| absent | Anything else | Never: it asks as before |

`_meta["centralu/askWhen"]`, an object such as `{ "push": true, "path": "*" }`, makes a `routine` tool ask when any
named argument holds the value named (`"*"`: is set at all). `_meta["centralu/askUnless"]`, such as
`{ "skipPrePr": "*", "dryRun": true }`, is the other way round: the call asks unless some named argument holds that
value, for a tool that is routine in one form only. The values are `true`, `false`, a string, a number or `"*"`; a
declaration the host cannot read (not an object, empty, a value that is a list or an object, which no argument could
equal) asks always. Codex fixes a tool's approval when the thread starts, before any arguments exist, so there a tool
with `askWhen` or `askUnless` always asks. A declaration
is a claim in the same way `readOnlyHint` is: it is read from the tool list of an attached app, never from a name; the
project's trust decides only `routine`, which is honoured for no app but the session's own project's. `check` warns
about a declaration the host ignores or cannot read, and about an `askWhen` or `askUnless` on a tool that is not `routine`.

A call from a view is never asked about: the view is the control surface the app offers the
person. It is recorded as `view`.

**What the model reads from a result.** A tool result can carry both `content` (text) and
`structuredContent` (JSON). The MCP specification treats the two as the same data: "For backwards
compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a
TextContent block" (2025-06-18, Tools, Structured Content). The two agents differ in which one the
model reads. Measured on 2026-10-04 with a probe tool whose text said `TEXT-7381` and whose
structured part said `STRUCT-4402`:

- **Claude Code** (2.1.282, and 2.1.287 from the VS Code extension) replaces the text with the
  JSON of `structuredContent` before the model sees it, with or without an `outputSchema`. The
  model answered only `STRUCT-4402`.
- **Codex** (0.160.0, `gpt-5.6-luna`) calls MCP tools from a script the model writes, and the
  script receives the whole result. Without an `outputSchema`, the model's script printed the
  text (`TEXT-7381`); with one, it read `structuredContent` (`STRUCT-4402`).

So keep the text and the structured part saying the same thing, and put any sentence the model must
read, such as "Status: On hold → Ready", inside `structuredContent` too (the project board app
leads with a `summary` field).

**Codex is verified from its source only.** Codex was logged out during M4, so the Codex path was
checked against the installed 0.153.4's generated types, its binary's strings and Codex's source,
not by a logged-in run: the approval-mode values, the configuration field names, the elicitation's
`_meta` key, and whether the MCP configuration sent with `thread/resume` takes effect (spikes S-3
and S-7 wait for a login). `normal` follows the person's own policy for an app's write tools, as
Claude does: with `approval_policy = "never"`, which would refuse a tool that asks, the bridges are
loaded with `approve` instead (#382, [security-boundaries/approvals.md](../security-boundaries/approvals.md)).

## Long calls and cancellation

- Codex ends an MCP call at 300 s (set explicitly, `tool_timeout_sec`). A call from a Codex session
  still running at 240 s returns early with "still running" and its run id. The call carries on, its
  result reaches the view and the run record, and the agent follows it with `run_status`: read-only,
  limited to this session's runs of this app, results kept for 1 hour and 50 per session. Claude
  sessions simply wait.
- A view's own call is held by the view's SDK for 60 s (the MCP TS SDK's request timeout), unless
  progress arrives: ext-apps' `callServerTool` resets that clock on each progress notification.
  While a view's call is pending, the UI sends `notifications/progress` for the request's progress
  token every 20 s, and stops when the call settles or the view goes away. So a slow tool, or a
  wait for approval, does not make the view give up on a call the app is still running. A request
  sent without a progress token gets none (its SDK would not listen).
- Stopping or closing a session cancels every app call it started, including those that returned
  early. The app receives `notifications/cancelled`, and, through the run id, whatever the app had
  asked the broker for is cancelled too, down the chain: another app's call it made, and an agent
  session it started, which is interrupted.
