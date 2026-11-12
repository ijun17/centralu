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
`failed` are not attached. The rule is checked again **at every call**, not only when attaching: the `app` tool counts
the session's apps at each call, so an app detached, untrusted or broken is refused at once.

Each app has a name in the session, `<id>`, which the `app` tool takes (below; until #2231 it was an MCP server named
`app-<id>`, whose tools read `mcp__app-<id>__<tool>`). A name a session has seen stays bound to its app for the session's
life (#1141, `session_app_names:<session>`, purged with the session): a later app with the same id (the root app of
another project, say) gets a name qualified by its project, `<id>-<project>`, never a name another app held, one gone
for the moment (its manifest broken mid-edit) included; `attach_app` keeps to the same book, and a name taken twice gets
a number. **An untrusted project's apps attach nowhere**, its own project's sessions included and
under `auto` too (owner, #1141): #603's opening of an untrusted project's apps to an `auto` session no
longer applies, and the runtime refuses them for every caller.

**A session's tool list does not grow with the projects the person trusts** (#1205), nor, since #2231, with the apps
it has: until then every attached app was a server whose tools rode in each request (Claude deferred them behind tool
search, so their names still cost; Codex loaded them). Until #1205 the Assistant was given every trusted project's root app
(#1141), so with ten projects that are apps it carried ten servers it mostly never called. A rule that
gives a session apps by a count that grows on its own (projects, shares) is not added to decision 4;
such apps are reached on demand ([other-projects-apps.md](other-projects-apps.md)), and the session pays for the ones it attached. What it is given
is bounded by things the person set up for that session: its own project's apps, its own app as a
builder, and for the Assistant the user folder, where an MCP server the person approved for it lands
(A-7). Measured with the app `create_app` makes (two agent tools and the host's `run_status`), with 0, 3
and 10 trusted root apps: before, Codex 6,800 / 9,179 / 14,733 characters and 11 / 20 / 41 tools, Claude
6,800 / 7,004 / 7,483 (the names alone); after, 6,800 and 11 tools in every case, plus 75 characters of
instructions once (`sessions/assistant-app-cost.test.ts`, [tool-cost.md](../tool-cost.md) §12).
An app's tool list is the last one read, so starting a session does not start every app. If none has been read yet,
`app` `list` for that app starts it and waits up to 15 s, then answers with what it has. `attach_app` waits the same
bound (`TOOL_LIST_WAIT_MS` in `sessions/session-apps.ts`, through `withTimeout`, #428).

## Apps through one Centralu tool (#2231)

Owner decision (2026-11-12, option B; #512's apps row): a session reaches its apps through Centralu's own server, never
through one MCP server per app. Before, every attached app was a server in the session (Claude: an in-process proxy per
app, swapped in with `setMcpServers`; Codex: a stdio bridge per app, fixed at `thread/start`, `tools/list_changed`
ignored), so a Codex thread never saw an app that arrived mid-thread, and a Codex request grew with every attached app.
Now the session's tool list is the same whatever apps come, go or change their tools, on every CLI that has Centralu's
tools, ACP agents included ([security-boundaries/app-servers.md](../security-boundaries/app-servers.md)).

**The tool**, in every profile (the Assistant, a coordinator, a builder and an ordinary session; each has apps under
decision 4). One tool with an action, as `mail` is: a second tool would carry its own name and schema envelope (about 210
characters) in every request.

| Call | Does | Answer |
|---|---|---|
| `app({ action: "list" })` | This session's apps, decision 4's and what it attached, one per line with its manifest name, the first line of its description and its tool names (`(reads)` after a read-only one) | Names the next calls; `find_apps` too where the seat has it |
| `app({ action: "list", app })` | That app's tools, one line each with the read-only mark and the input schema; one app at a time. Starts the app if its list was never read (15 s bound, `TOOL_LIST_WAIT_MS`) | Names `call` |
| `app({ action: "call", app, tool, args? })` | Runs one tool of one of this session's apps. `args` is an object (JSON text of one is read too) | The app's own result (`content` and `structuredContent` as the app gave them); a mismatch answers with the tool's schema and runs nothing |

`find_apps`, `attach_app` and `detach_app` keep their roles (another project's or the user folder's apps, #371 part A):
`find_apps` lists what a session *could* attach, `app` what it *has*; no app is in both, and `find_apps` names `app`
where nothing it could attach matches. An app made or attached mid-session is callable on the next call, the same turn
included, on every CLI: the call counts the session's apps at the call, and nothing is restarted.

**Names.** `app` takes the app's name in this session: its server name of before without `app-` (`board`,
`board-centralu`, `board-2`), from the same book (`session_app_names:<session>`, #1141), so a name a session has
seen still never comes to mean another app. `app-board` is read as `board` (a session's earlier turns used the server
names). The cut that kept `mcp__<server>__<tool>` within 64 characters (`SERVER_NAME_MAX`) is gone: no app name is part
of a tool name any more.

**The one call path.** An `app` call reaches the hub's attachment of the session's live handle (`SessionAppsHub.liveFor`,
`Attachment.call`), which counts decision 4 and the attachment again and goes through `ExternalApps.call` (caller
`session`), as before ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#one-call-path)). The host checks `args` against
the tool's `inputSchema` first (zod's JSON Schema reader, as Centralu's own tools are checked; a schema it cannot read is
not checked, as neither CLI checked one), so a wrong call costs no card and no run.

**Approval is the host's, at the call, with the real arguments**, the same on every CLI (`Attachment.approve`). In order:

1. The Assistant in a turn a session's request started (#1447): the request gate (`whenAsked`), as before; it knows
   whether the tool only reads. `list` never asks: it only reads.
2. A tool that runs unasked (`readOnlyHint`, `centralu/risk` `local`, or `routine` in the session's own project's app
   under `normal`, `tool-risk.ts`): no card. `askWhen`/`askUnless` are read with the call's arguments on Codex too.
3. Otherwise the session's preset, read at the call (`presetAsks`):

| Preset | Claude | Codex, ACP | Before: Claude / Codex |
|---|---|---|---|
| `safe` | Card | Card | Card / card (`prompt`) |
| `normal`, `edits` | Card, unless the person's own Claude mode is `bypassPermissions` | Card, unless the thread runs the person's `approval_policy = "never"` (ACP: card) | The CLI's flow (a card; the person's rules or mode could skip it) / card (`writes`), `approve` under `never` |
| `auto` | No card | No card | No card / no card (`approve`) |

The card is the host's (`HostCards.askHost`) in the session's approval slot: an `other` card reading
`<app>: <tool> {arguments}`. Allow runs the call, Deny answers "The person denied this call. Nothing ran.", and Always
allows this call only (an app tool's card has no rule key, as before). Codex never asks about Centralu's tools itself
(`default_tools_approval_mode: approve`), so nothing of Codex's stands in front of the card. **A visible change on
Claude:** a `normal` session's own permission rules that named `mcp__app-…` tools no longer apply, since the CLI never
sees an app tool, so a person who had silenced a write's card with such a rule sees the card again; a Claude mode other
than `bypassPermissions` (`dontAsk`, `plan`, `auto`) gets the card as `default` does. Counted on one real setup
(2026-11-13): no rule named an `mcp__app-` tool, so no one-time notice was added.

**Waiting, and stopping.** On Claude the card stands until the person answers, as the CLI's own did. A call through the
stdio bridge (Codex, ACP) answers within `BRIDGE_ANSWER_MS` (240 s), before the bridge (280 s) and Codex (300 s,
`tool_timeout_sec`) cut it: a card still unanswered then is withdrawn and the agent told to ask the person and call
again, and an app's run still going answers "still running" with its run id, followed with
`app(action="call", app, tool="run_status", args={run_id})`. Stopping or closing the session withdraws a standing card
and cancels the call (`cancelAll`), as it cancels a run. Codex's own ceiling for Centralu's tools stays 300 s.

**Cards and history.** A call's card shows the app and its tool as an app tool's did: the adapters mark an `app` call
with `centralu: { app, tool }` and title it with its arguments (`centraluMark`, `appCallOf` in `adapters/tool-titles.ts`),
so the screen draws it as it drew `mcp__app-<id>__<tool>`; a listing is marked "Listed its apps" or "Read the tools of
<app>". An old record keeps its `mcp__app-<id>__<tool>` name and mark and renders as before. A live `mcp__app-…` call is
never marked now: such a server is the repository's or the person's own. The inline view (B-1) joins a call to its card
as before: Claude passes the card id (`claudecode/toolUseId`) on the Centralu call; the Codex adapter notes an `app`
item's app, tool and arguments (`SessionApps.noteCall`).

**Instructions.** One line, where a session learns how to reach apps: the reader's first-tools line says
`app for apps (find_apps: other projects')`, and #957's line on repository work names an app's help tool through the app
tool. The Assistant's apps line and a builder's first line name the app tool; a coordinator has the tool's description.

**Older window and host** (protocol.md §4, additions only). No shape a window reads changes. A record of an `app` call
carries the same `centralu` mark an app call had, so an older window draws it as before (`centraluCallOf` reads the mark
first). `apps.reach` no longer answers `restart` or `bridge-failed` (nothing produces them). The bridge's
`assistant.tool` result gains optional `content` and `structuredContent`. The bridge methods `apps.sessionTools` and
`apps.sessionCall` are removed (protocol.md §3.2): only an app bridge of an older host's Codex thread called them, and that
thread's process goes with the host that started it.

**Recordings and replay.** The Claude recordings `mcp-app.jsonl` (2.1.296, 2.1.316) keep their `mcp__app-…` calls: they
replay as history; the live mark they had is not set any more (see above). A recording of an `app` call needs a live
re-record on each CLI. The tool-list fixtures (`tool-prefix.test.ts`, the measured definitions) gain `app` and lose the
app servers.

**What is deleted.** The Claude app proxy (`app-proxy.ts`) and the server sync for apps (`setMcpServers` on every
attach, detach and app change); the Codex app bridge (`CC_APP_SERVER` in `centralu-bridge.mjs`), the app part of
`thread-servers.ts` (per-tool `approval_mode`, `appApprovalModeFor`, `checkAppMode`, `appAttachment`), the elicitation
path for app servers in `server-requests.ts`, the thread restart after an attach (`appsRestartAfterTurn`), the adapters'
approval branches for app tools (`appToolUnasked`, the request hook's app branch, `appToolOf`), `SERVER_NAME_MAX`, and the
bridge RPCs `apps.sessionTools`/`apps.sessionCall`. Apps' own MCP servers stay: they are the host's backend.

**Measured** ([tool-cost.md](../tool-cost.md) §16): every profile's list is the same size with 0, 3 or 10 apps on both
CLIs; with no app it carries the tool's 462 characters more on Codex (about 20 to 50 on Claude, where it waits behind tool
search), and with three apps already 1,900 fewer on Codex.

## Approval (decision 5) and what an app may declare

A tool the app annotates `readOnlyHint: true` is never asked about. Other app tools follow the session's preset, as the
table in [the section above](#apps-through-one-centralu-tool-2231) says, decided by the host at the call on every CLI.
The decision is made from the session's app's tool list, not from a name.

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
equal) asks always. The host decides with the call's arguments on every CLI (#2231; before, Codex fixed a tool's
approval when its thread started, so there a tool with either always asked). A declaration
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
  text (`TEXT-7381`); with one, it read `structuredContent` (`STRUCT-4402`). The `app` tool declares no
  `outputSchema` (one tool for every app's results), so Codex's script reads the whole result.

So keep the text and the structured part saying the same thing, and put any sentence the model must
read, such as "Status: On hold → Ready", inside `structuredContent` too (the project board app
leads with a `summary` field).

## Long calls and cancellation

- Codex ends an MCP call at 300 s (set explicitly, `tool_timeout_sec`), and the stdio bridge at 280 s. An `app` call
  through the bridge (Codex, ACP) answers within 240 s (`BRIDGE_ANSWER_MS`): a run still going then returns early with
  "still running" and its run id. The call carries on, its result reaches the view and the run record, and the agent
  follows it with the app's `run_status` (`app(action="call", app, tool="run_status", args={run_id})`): read-only,
  limited to this session's runs of this app, results kept for 1 hour and 50 per session. A card the person has not
  answered by then is withdrawn. Claude sessions simply wait.
- A view's own call is held by the view's SDK for 60 s (the MCP TS SDK's request timeout), unless
  progress arrives: ext-apps' `callServerTool` resets that clock on each progress notification.
  While a view's call is pending, the UI sends `notifications/progress` for the request's progress
  token every 20 s, and stops when the call settles or the view goes away. So a slow tool, or a
  wait for approval, does not make the view give up on a call the app is still running. A request
  sent without a progress token gets none (its SDK would not listen).
- Stopping or closing a session cancels every app call it started, including those that returned
  early, and withdraws a card that stands for one. The app receives `notifications/cancelled`, and, through the run id, whatever the app had
  asked the broker for is cancelled too, down the chain: another app's call it made, and an agent
  session it started, which is interrupted.
