# M4 apps plan: the place it is built is the place it is used (v2, decisions finalized)

> Standard: **does the person click and use, in the very place it was built, a tool the agent
> made — and does the agent call it as a function?**
>
> Prior investigation: a survey of the current app layer (2026-09-25), the deprecation of MCP
> sampling (SEP-2577) and a survey of Goose's MCP Apps implementation (2026-09-14),
> re-checking the spec, SDK and Tauri against primary sources and the installed code
> (2026-09-25).
>
> **v2 (reflecting the re-review, 2026-09-25)**: re-checking v1 against primary sources found
> three false premises: the path for an app to ask an agent something (MRTR cannot be used for
> that), a screen that stays open indefinitely (not in the spec), and updates to an open screen
> (the spec has no subscription). Several things were also missing: screens that open inside a
> conversation, tool visibility scope, long-running calls, Codex's approval and resume paths, an
> app's data and secrets, and overlap with the existing approved-MCP-server feature. These are
> laid out below under "What changed from v1".
>
> **Status: decisions finalized (2026-09-25).** All 12 open questions were settled on the
> recommended answer (see "Decisions" at the very end). Progress is tracked in the "Progress
> checklist".

## What changed from v1

| v1's assumption | What was confirmed | v2's design |
|---|---|---|
| When an app asks the agent for something, it carries a custom kind like `centralu/agent` on MRTR | MRTR's request-for-input allows only three kinds (ask the user, call the model, list roots). As of the 2026-07-28 spec, a server cannot send a request first | The host opens a **broker MCP server**, and the app process becomes that server's standard client. MRTR is used only for its original purpose (asking the person something mid-task) |
| An app's screen stays open outside the conversation | Every screen in the spec is an instance created by a single tool call. A pinned, always-on screen is only at the proposal stage (ext-apps #684, #754) | Split where a screen can open into two places. **Inside a conversation** (spec as written) and a **pinned screen** (opening an app has the host call a "home tool" — the host doing the calling is also within spec) |
| When the agent changes a value, an open screen sees the same value | A screen can only read a resource, not subscribe to it (ext-apps #659) | Every time an app's tool call ends, the host notifies its open screens that something "changed" (our extension). Our template receives it and reads again |
| The bridge uses `@mcp-ui/client` | `@mcp-ui/client` 7.1.1 is still stuck on SDK v1 and ext-apps 1.x. The official `@modelcontextprotocol/ext-apps` is at 2.0.0 | Use the official `ext-apps` 2.x `AppBridge` directly |
| An app's tools are open to every caller as the same list | The spec has a tool visibility scope (`_meta.ui.visibility`: `model`, `app`), and enforcing it is the host's job | Open only `model` tools to the agent, and only that same app's `app` tools to the screen |
| Turning off an app makes it disappear starting the next turn | Claude can swap a running session's servers (`Query.setMcpServers`). Codex only takes them when a thread starts, and ignores tool-list-changed notifications | Handle it differently per tool (see "Attaching to a session" below) |
| Approval for app tools just follows the session preset | Our Codex adapter auto-refuses every confirmation request from a server other than `centralu` (`codex/index.ts:309-314`). Codex asks for MCP tool approval through exactly that confirmation request. Under our `auto` preset (`approvalPolicy: never` + sandbox), Codex refuses an unannotated MCP tool call on its own | Fix the Codex approval path, and line up the approval criterion with MCP tool annotations (`readOnlyHint`, etc.) |
| An app's state lives in the existing key-value store | That store can only be used by compiled-in built-in apps. An external app process cannot reach it | Put a per-app data folder **outside the repository** |
| `allow-same-origin` on the loopback iframe, and a custom scheme per app if needed | Tauri treats a registered custom-scheme page as **local**, giving it the same IPC credentials as our own screens. `*.localhost` does not resolve by name on macOS 15 and below | Do not use a custom scheme. Isolate an app's screen with an opaque origin |
| An app's version is tracked separately by a folder hash | An app inside a project already has git managing its version | Keep snapshots only for apps outside git |

## What changed during implementation (2026-09-25)

Settled by comparing merged code against the document (found while working on F-1). Most of these are not reversed decisions — places where the implementation found a better answer, or where the plan's own sentences disagreed with each other. The one exception is decision 6, changed after implementation surfaced a hole in it (the `safe` row in the table).

| Plan | Implementation | Reason |
|---|---|---|
| Assemble screen CSP from the manifest's `csp` | Assembled from each `ui://` resource's `_meta.ui.csp` instead. The manifest's `csp` is unused | The spec puts CSP on the resource. An app built for another host runs unmodified |
| Revive a crash with exponential backoff | Revive with no timer, the next time it is needed | There is no reason to revive, in the background, an app nobody is calling |
| An in-conversation screen that scrolls out becomes a frozen image | A "reopen" placeholder | An opaque-origin frame cannot be captured as an image |
| The pin button moves the in-conversation screen | Opens the pinned screen fresh with a `home` call | Every screen is born from a tool call (spec) |
| Attach an approved MCP server outside the orchestrator too | Only to the orchestrator (and its builder session) | Decision 4 and the A-7 wording disagreed. Follow decision 4 |
| On Windows, loopback HTTP instead of fd 3 | fd 3 on every platform | Windows is not supported yet (#14). Build the alternative when it is |
| A "changed" notification on every call, no matter who called it | A read-only tool call does not notify, a screen does not receive the change it caused itself, and notifications are coalesced per app | **A design flaw in the plan.** The template screen called `show` on every notification and looped roughly 700 times a second (measured: 2,035 times in 3 seconds). Fixed in #190 |
| A builder session reads settings by trust, like a worker | Read no settings at all, because it held orchestrator tools (including the user's own global settings) | **An implementation defect.** Fixed in #193 to decide it by the session's kind. The worktree manager had the same defect |
| Send progress notifications for a screen's long call | Did not send them, so the screen side gave up at 60 seconds | **An implementation gap.** Fixed in #192 so that `AppFrame` sends a progress notification every 20 seconds while it waits |
| An agent session an app called is archived when it ends (decision 6, D-1) | Closes the process when it ends and leaves it `idle` in the list. It does not wait in the inbox | Archiving was retired (FR-20: keep no hidden sessions). Leaving it `waiting_input` would call the person to answer a turn the app has already taken |
| The preset for an agent an app called is `normal` (decision 6) | `safe` | **A hole in the decision.** `normal` takes its approval behavior from the person's own settings. So for a person using global bypass, an instruction an app wrote writes files and runs commands with no card at all. The path decision 6 meant to close reopens through the person's own settings. Global bypass is a choice to trust one's own instructions, not a choice to trust instructions an app wrote (unlike #92, where the one giving the instruction was still the person). Reads still go unasked even under `safe`, so lookups and summaries still work. #194 |
| E-3 import shows `uses` and a file list, then turns on | Shows the command and its arguments (`server`) at the top, plus secrets, screens, and what was not moved. The enabled record is kept host-side (`app-imports.json`, bound to the folder's inode) as a hash of `server` and `uses`; a change to either asks again. Names starting with a dot are not moved | An app server is code that runs with the person's own permissions, so turning it on means allowing that command to run. Because a user-folder app's builder session reads the settings in the app folder, a hook in a bundle's `.claude/` could have run unconfirmed |

**Still missing**: when the host restarts, only the one app whose screen was open reopens. Saving in an editor alone does not revive an app stuck in `failed` state.

## What is blocking this right now

The skeleton of an app layer already exists (#81). But that skeleton can only hold **apps we wrote into the code and built**.

| What blocks it | What happens now | Evidence |
|---|---|---|
| A new app cannot be created | Apps are baked into two compile-time arrays. Neither the user nor an agent can add an app without rebuilding Centralu | `agent-host/src/apps/registry.ts:11`, `ui/src/apps/registry.ts:8`, `AppId = 'control'` (`ui/src/apps/contract.ts:11`) |
| An app's screen cannot be shown isolated | A screen is nothing but a React component compiled into `packages/ui`. The Tauri CSP has no `frame-src`, so an iframe is blocked by `default-src 'self'` | `tauri.conf.json` `security.csp` |
| A working session cannot call an app | App tools are visible only to the orchestrator, manager and coordinating sessions. An ordinary worker has no such tool at all (a deliberate decision in #81) | `manager.ts:1106-1110`, `3553-3559` |
| An app cannot call an agent | The only thing a host-side app can do is create a coordinating session. There is no path to send a prompt and wait for the result | `apps/contract.ts:31-56`, `manager.ts:2740-2772` |
| Apps cannot call each other | `HostAppContext` has no means to call | #97 |
| There is no record of what the person called | What an agent calls stays in that session's conversation, but what is called through `apps.invoke` is left nowhere | `manager.ts:414-430` |
| The existing approved-MCP-server feature stands apart | A server approved through `propose_mcp_server` attaches only to the orchestrator (stdio only), has no way to list or remove it, and a call does not pass through the host so it is never recorded | `manager.ts:1119`, `1576`, `3403-3417` |
| A Codex session cannot use another party's MCP server | Confirmation requests are auto-refused; under the `auto` preset Codex refuses on its own | `codex/index.ts:49-50`, `309-314` |
| It cannot be handed off | There is no concept of bundling, exporting, importing or versioning | Only exists in the comments of #71 and #72 |

Already there, so **not rebuilt**: the tool registry and profile check (`orchestrator-tools.ts:546-595`), Claude's in-process MCP and the Codex stdio bridge (`orchestrator-mcp.ts`, `orchestrator-bridge.mjs`), a session an app owns (`app_id`, v31), turning it on and off, folder watching (`DirWatchers`), the reserved-name check (#93's `mcpServerNameError`), the question card (takes MRTR's "ask the person" as is), and termination down to descendants (`kill-tree`).

## Promise cross-check (what the product promises ↔ this plan)

| What the product promises | In this plan |
|---|---|
| The agent builds a tool for the work **together with its screen** | C (the build loop) |
| When it falls short while in use, fix it **right there** by saying "put a button here" | C-4, C-5 |
| The person clicks to use it, and the agent calls **that same screen like a function**. Not two builds | A-4 (a single call path), B-5 (updating an open screen) |
| A tool calls **the very agent already in use**. No separate API key or token to buy | D-1 |
| A tool sits in each scattered place, and **tools call one another** | D-2, D-3 |
| Hand it to the team with one button, and the receiving side opens it with no install | E (the local half). The team-server half is outside this plan |
| It keeps a record of who ran what | A-6 (a local run record). Central collection is outside this plan |

---

## The skeleton of the design

### How far this follows the spec

| Layer | What |
|---|---|
| **Exactly as the spec** | An MCP server, `ui://` resources and `_meta.ui.resourceUri`, tool visibility scope, screen lifecycle messages (tool-input, tool-result, tool-cancelled, resource-teardown), the sandbox proxy, MRTR's "ask the person" |
| **Our own way, within the spec** | A pinned screen (the host calls the home tool), brokering (an app becomes the client calling the host's MCP server) |
| **Extensions outside the spec** | Update notifications for an open screen, the broker server's tools (running an agent, calling between apps, host data), run records, trust and capability approval |

So "an app built for Goose runs unmodified" is true **only up through an in-conversation screen**. Live updates on a pinned screen, and brokering, work only for an app built with our template. The document says so as well (F-1).

The principle held to is the one set on 2026-09-14. It does not embrace Goose (Goose is itself an agent, so it buys tokens with a provider API key, while we drive the CLI the user has already paid for). Sampling (`sampling/createMessage`) is not used (deprecated 2026-07-28, removed as soon as 2027-07-28).

### Where an app's state lives

In MCP Apps, **the screen holds no state.** Every tool call creates a new instance, and state restoration is written into the spec only as "a future extension." So this design does not put state in the screen.

| What | Where | Lifetime |
|---|---|---|
| An app's state and data | The app server process, a data folder outside the repository | As long as the app exists |
| The screen | A sandboxed iframe. Just a window reflecting the state | One tool call. Reads fresh again when closed or reopened |
| An always-open screen, change notifications | The host (us) | Until the user closes it |

MCP Apps is used only as **the protocol between a screen and a tool.** Everything else a "real app" needs (state, an always-on screen, updates, brokering) is filled in by the host. Dropping the protocol for our own format would mean an app built for another host could not open here, and our own apps could not run elsewhere.

### The shape of one app

```
<app folder>/                               Code. Committed to the repository if it is a project app
  centralu.app.json                         Manifest
  server.mjs                                MCP server (stdio)
  ui/index.html                             Screen
  AGENTS.md, CLAUDE.md                      Guidance for an agent editing this app

~/.centralu/app-data/<project id>/<app id>/  Data. Outside the repository, only on the user's machine
```

- Manifest fields: `manifestVersion`, `id`, `name`, `version`, `description`, `server { command, args }`, `home` (the tool name that opens the pinned screen), `uses { agent?, apps?, host? }`, `secrets?` (names only), `view { origin: 'opaque' | 'app' }?`. A screen's CSP is not in the manifest but, per the spec, in each `ui://` resource's `_meta.ui.csp` (settled during implementation, see "What changed during implementation" above). `manifestVersion` is for when teammates are on different Centralu versions.
- **The id rule is the same as #93**: `^[a-z0-9][a-z0-9-]{0,31}$`, forbidden to start with `centralu`. With no underscore, it cannot form the tool-name divider `__`. The server name attached to a session is `app-<id>`, and `__` is also forbidden in a tool name inside an app.
- **Data and secrets are outside the repository.** Because app code is committed and shared with the team, writing a file created at runtime into the app folder would leak it to the team. The data folder is passed through an environment variable (`CENTRALU_APP_DATA`). A secret has only its name in the manifest; the value is stored only on the user's machine (keychain, or a 0600-permission file) and passed in as an environment variable. A secret value is never carried in a run record, an argument summary, or an agent prompt.

### The two places a screen can open

1. **Inside a conversation (spec)**: when a session's agent calls a tool that has a screen, the screen opens under that tool call's card in the conversation. This is the spec's original use, and the place compatible with an app built for another host.
2. **A pinned screen (our own way, within spec)**: opening the app from the sidebar has the host call the manifest's `home` tool, and shows the resulting screen in the main area. It can also be moved there from an in-conversation screen with a "pin" button.

In both places the screen is born from a tool call, so neither leaves the spec. One constraint of our own attaches to an in-conversation screen: the conversation list is virtually scrolled, so an item that scrolls out of view disappears from the DOM. Its iframe disappears with it, so before it goes the spec's teardown request is sent and a "reopen" placeholder is left in its place (instead of a frozen image, since an opaque-origin frame cannot be captured). Live in-conversation screens are capped at the most recent 3.

### There is one call path ("the same screen, like a function")

```
The person clicks ─▶ screen (iframe) ─ tools/call ─▶ host ─┐
                                                            ├─▶ visibility check ─▶ approval ─▶ app process
The agent ─▶ session's app-<id> proxy server ──────────────┘                            │
                                                                                          ▼
                                              run record (app_runs) + "changed" notice to open screens
```

- **The host stands in the middle of every call.** Even the agent does not attach directly to the app process. So what a screen calls and what an agent calls pass through the same code and the same record.
- **The caller is recorded as one of three**: a screen, a session (session id), or an app (a request chain). v1 recorded a screen's call as "the person," which was wrong. A screen is the app's own code, so it can call a tool even when nobody clicked anything.
- **Visibility scope**: only a tool whose `visibility` includes `model` is listed for the agent. A screen may call only that **same app's** `app` tools. Because the server itself cannot tell who called it (ext-apps #746), the host enforces this.
- **A screen's app id is decided by the iframe that sent the message,** not trusted from the id written inside the message content (the same principle as #93 and #94: what is verified is exactly what is used).
- A tool response's `_meta.ui.resourceUri` is checked against the app that responded, to stop one app impersonating another's screen.

### The path for an app to ask outward: the broker server

- When the host starts an app process, it gives it **one extra pipe** besides standard input/output. On that pipe, the host is the MCP server and the app is the client. Only the process holding the pipe can call it, so there is no token, and the pipe itself says who called.
- The broker server's tools: `run_agent { prompt, tool?, schema? }`, `call_app { app, tool, args }`, and host data tools (session list, git status, and so on — only what is declared in `uses.host`).
- When the host sends a tool call to an app, it carries a run id in `_meta`, and the template's helper attaches that id back onto the broker call. That is how the chain is recorded, and how the depth limit and cancellation follow the chain. **A broker call that arrives with no run id** (an app waking itself up on its own) is refused in v1.
- MRTR is used only for its original purpose: when an app asks the person something mid-task (`ElicitRequest`), it shows as the question card we already have. A model call (`CreateMessageRequest`) is not accepted.
- What an app author writes is one line: `await centralu.agent('…', { schema })`. The pipe connection and carrying the run id are hidden by the template's helper.

### How an open screen sees the same value

Every time an app's tool call ends (no matter who called it), the host sends `centralu/notifications/changed` to every open screen of that app. Our template receives it and calls the state tool again. This is the same approach #81 chose for built-in apps (one notification and reread). Since this is outside the spec, an app not built with our template ignores the notification and does not update.

This is the heart of "the same screen, like a function." If the person leaves a pinned screen open and the agent calls `set_interval`, the slider in front of the person's eyes has to move.

### A long-running call

| Caller | Limit on one call | Basis |
|---|---|---|
| Claude session (in-process proxy server) | Effectively none (`MCP_TOOL_TIMEOUT` default is about 28 hours) | Claude Code environment variable docs |
| Codex session | 300 seconds (the code default since 0.145; the 60 seconds in the docs is stale) | codex `rmcp_client.rs` |
| Screen | 60 seconds, though a progress notification resets the count (ext-apps turns this on) | MCP TS SDK, ext-apps `callServerTool` |
| Host → app | We decide | |

- While waiting (including while waiting on approval), the host sends the screen progress notifications to keep the call alive.
- If a call from Codex passes 240 seconds, "in progress" and the run id are returned first. The result lands in the app's screen and record, and the agent checks in afterward through the `run_status` tool attached to each app's proxy server.
- If something upstream in the chain is cancelled (the person stops the session), the cancellation propagates down through the app call and the agent run.
- MCP Tasks was dropped from the core spec on 2026-07-28 and became an extension (`io.modelcontextprotocol/tasks`). Whether the agent-side clients (Claude, Codex) support it is unconfirmed. Whether to use it only between the host and an app is decided in the spike.

### Attaching to a session

| | Claude | Codex |
|---|---|---|
| How it attaches | An in-process proxy server per app (`createSdkMcpServer({ name: 'app-<id>' })`) | Chosen among three in the spike (S-3): an HTTP address (`url` + `bearer_token_env_var`, no extra process), `dynamicTools` (an experimental feature, calls come straight to the host), a stdio bridge (a process per session count × app count) |
| Changing it mid-run | With no restart, from the next turn, through `Query.setMcpServers()` (present in the installed SDK 0.3.263) | Not possible. Tool-list-changed notifications are ignored, and reloading the config applies to every thread at once. It takes effect from the next thread's start |
| Approval | Our approval card in `canUseTool` | A confirmation request (`mcpServer/elicitation/request`, `_meta.codex_approval_kind: "mcp_tool_call"`) is sent as our approval card. It is auto-refused right now |

- In the code right now, resuming Codex (`thread/resume`) does not resend the MCP configuration (`codex/index.ts:143-159`). Whether the initial configuration stays with the thread has to be confirmed by running it (S-7).
- There is a record that Codex's HTTP approach received not a single request on codex-cli 0.147.0 (`orchestrator-bridge.mjs:5-6`). It is now documented as supported with no experimental flag needed. Measure it again on the installed 0.153.4.

### Approval has three layers

1. **Tool call**: follows the MCP tool annotation. A tool with `readOnlyHint: true` is not asked about; the rest follow the session preset (`safe` always asks, `normal` asks, `auto` does not ask). This is the same criterion as Codex's `writes` approach (ask only about a non-read-only tool), so both tools behave the same way. Codex's `auto` preset is `approvalPolicy: never`, so unless the app server configuration states `default_tools_approval_mode`, Codex refuses an unannotated tool on its own.
2. **Capability**: asked once, the first time an app uses running an agent, another app, or host data. Asked again if the manifest's `uses` changes.
3. **Trust**: whether this app's code may run at all on this machine (question 3).

A call made from a screen is not asked about per call, because the screen is itself the control surface the app offers the person. It is instead recorded as "screen."

### Security boundaries

- **The sandbox proxy is loopback HTTP.** Because a Tauri screen is a web page, a different-origin proxy is required by the spec. A custom scheme is not used. Tauri treats a registered scheme as local and gives it the same IPC credentials as our own screens, and the only thing standing in the way then is the one invoke key that changes per launch. On top of that, our build has no app command permission list, so from a local origin all 12 registered commands are open.
- **An app's screen is isolated with an opaque origin.** The inner iframe is not given `allow-same-origin`. That keeps browser storage from mixing between apps (the reference implementation uses one origin for every server). Separating origins per app through `*.localhost` cannot be used because the name does not resolve on macOS 15 and below. The cost is that a screen cannot use browser storage. This is accepted because keeping state on the server is this design's own principle. Since 5 of 86 public apps break under this approach (S-8), a separate per-app-origin mode is opened for imported apps and apps that request it (the S-1 result).
- `frame-src http://127.0.0.1:*` is added to the Tauri CSP. The host port changes every launch, so it cannot be pinned. Instead the proxy path is locked with a secret value made fresh at each launch.
- It is tested directly that a command cannot be called from the app iframe through `__TAURI_INTERNALS__` or `window.webkit.messageHandlers` (S-2). WKWebView exposes message handlers to every frame.
- **An app's server is code that runs with the user's own permissions.** The sandbox applies only to the screen. So trust (question 3) is the largest boundary.
- **An agent an app calls inherits neither the calling session's `auto` nor the person's global bypass.** The preset is always `safe` (decision 6). Text an app hands over is wrapped as someone else's text (the same rule as #120), because the path an app uses to hand external data to an agent is exactly the path of prompt injection.
- **Cost**: once allowed, an app can repeat running an agent from its screen, and the user's subscription limit is shared with the app. Each app is capped at 1 concurrent run and a per-minute count, and per-app usage is shown on the record screen. The depth limit blocks only the chain, not repetition.

---

## Order and reasoning

Start with the biggest risks. There are five places where zero has been verified: an opaque-origin iframe and the bridge in WKWebView, the path for attaching to Codex, two SDK generations (v1, v2) in one process, brokering over an extra pipe, and an install-free template.

```
S spikes ─▶ P groundwork ─▶ A runtime ─▶ B screens ─▶ C build loop ─▶ D brokering ─▶ E handoff ─▶ F docs & compatibility
```

B does the in-conversation screen first. Since it is exactly as the spec, the risk is small, and the pinned screen and update notifications are layered on top of it. Once A and B are done, "a hand-built app is used by both the person and the agent" becomes true. Only once C is done does this feature's first promise (use it and fix it right where it was built) become true. **The dogfooding acceptance criterion is the end of C.**

Rough size: S 3 days, P 1 day, A 4 days, B 5 days, C 4 days, D 5 days, E 2 days, F 1 day. About 5 weeks all together. Reschedule after the spikes.

---

## S. Spikes (a 3-day box; if it fails, the design changes)

| # | What to check | Pass criterion | If it fails |
|---|---|---|---|
| S-1 | Loopback proxy → opaque-origin iframe → ext-apps 2.x `AppBridge` in WKWebView | An official example app opens **with no modification** and a button calls a tool | If the origin is the problem, give the inner iframe a different origin per app via port. If the bridge is the problem, fall back to `@mcp-ui/client` 7 (the wire protocol is the same, so the app side is unaffected) |
| S-2 | Attempt a Tauri command call from the same iframe | Fails through both `__TAURI_INTERNALS__` and `window.webkit.messageHandlers` | Move the app screen to a separate window and grant it no IPC permission |
| S-3 | Three paths to attach to Codex (HTTP, `dynamicTools`, stdio bridge) | On 0.153.4, a tool call reaches the host, and an approval confirmation request comes to our card | Go with the stdio bridge, and find a way for one bridge per session to carry several apps |
| S-4 | SDK coexistence in one process: the app-side client is v2 (`@modelcontextprotocol/client`), the Claude proxy server is v1 (through the Claude SDK) | Runs with no conflict, and talks to app servers of both the 2025-11-25 and 2026-07-28 generations | Line up the app side on v1 too, and switch asking the person (MRTR) to a way that works under v1 |
| S-5 | Brokering over the extra pipe (fd 3) | Both a Node app and a Python app call a host tool over the pipe | Loopback HTTP with a per-app secret value |
| S-6 | An install-free template | Starts with `node server.mjs`, no `npm install` (a small runtime file is copied in) | The scaffold runs the install and shows a skeleton screen meanwhile |
| S-7 | The MCP configuration survives a Codex resume | A tool of the server attached at start can still be called after `thread/resume` | Carry `mcp_servers` again in the resume request's `config`. Fix the existing orchestrator bridge the same way |
| S-8 | Browser storage use across a sample of public MCP apps | Count how many apps break under an opaque origin | If it is many, promote S-1's alternative (per-app port) to the default |

## P. Groundwork (1 day)

- **P-1** Open the UI's `AppId` from a closed union into a string (the same thing #74 did for `ToolName`). Built-in and external apps stand in one registry.
- **P-2** Rebuild the host's HTTP hook. Right now it is unused, takes only a path, and sits open on the same port as the WebSocket **with no authentication** (`server.ts:55`, `91-98`). Have it take a method, query and headers, answer asynchronously, and lock it with a secret value.
- **P-3** Bring in `@modelcontextprotocol/client` (v2) and `@modelcontextprotocol/ext-apps` 2.x as direct dependencies. The only SDK present now is v1 1.30.0 bundled with the Claude SDK, and our own code cannot import it.
- **P-4** Fix `app_guide`. It documents an `archive_session` that does not exist and knows none of the control tools (`app-guide.ts:47`). It is the first thing an agent about to build an app reads.
- **P-5** `ControlDoc` is defined twice, in different shapes, in the host and in the UI (`control.ts:47-53`, `ControlRail.tsx:31-48`). Merge them, and write down the principle that a state shape is defined in one place.
- **P-6** Fix where things break for a session whose cwd differs from the project path. Record catch-up looks up Claude's history by `project.path` (`manager.ts:1626`), and a user-folder app's builder session is exactly such a session.

## A. Runtime (host)

- **A-1 Manifest** Validate `centralu.app.json` with zod. An unknown field only warns.
- **A-2 Discovery** Scan where apps live (question 1), and follow additions, deletions and changes with folder watching. A project app is read only from **the registered project root**. Even if every worktree has its own copy of the same app, there is one instance per project, and a worktree session also uses the root's app.
- **A-3 Process lifetime** Starts the first time it is needed. A crashed app is not revived on a timer; it starts again the next time it is needed (with 1-second, 2-second spacing). Three failures in a row and it stops and records why. Stderr goes into a per-app log file. **An idle app is brought down**: with no open screen and no call in progress, it ends after 5 minutes.
- **A-4 Brokering** A screen's call (`apps.call` RPC) and a session proxy server's call come into the same function. The visibility check, approval, issuing a run id and recording all happen here, once each.
- **A-5 Attaching to a session** As in the "Attaching to a session" table above. Which sessions it attaches to is question 4.
- **A-6 Run record** `app_runs(id, app_id, tool, caller_kind, caller_session_id, parent_run_id, status, duration_ms, args_digest, created_at)`. `caller_kind` is screen, session or app; `status` is in-progress, success, failure or cancelled. Only a summary and hash of the arguments are kept, but **the raw text of a few recent failures is kept locally** (with secrets redacted), because the builder agent needs to see the failed input to fix it. A retention period applies.
- **A-7 Absorbing the existing approved-MCP-server feature** Move an approved MCP server to become a "screenless app" (question 8). Its calls now pass through the host, so they are recorded, and it can be removed from the list. Where it attaches follows decision 4: as a user-folder app, it attaches only to the orchestrator (and the session building that app). Two registries would mean two approval flows and two attach paths.
- **A-8 One list with the built-in app** `control` remains a compiled-in built-in app. The registry shows the built-in and external ones as one list.

## B. Screens (UI)

- **B-1 In-conversation screen** Shown under the tool call card. Screen lifecycle messages are sent per spec. When it scrolls out under virtual scrolling, teardown is sent first and a placeholder is left.
- **B-2 Pinned screen** The app stands alongside sessions under the project in the sidebar. Clicking it has the host call the `home` tool and show it in the main area. It uses focus, shortcuts and saved order the same way a session does.
- **B-3 Sandbox hosting** Loopback proxy (secret value) → opaque-origin iframe → `AppBridge`. The per-app CSP is assembled by the host from the manifest's `csp`. Theme and font size are passed through `host-context-changed`.
- **B-4 Bridge wiring** `oncalltool` → brokering. `onreadresource` → the host reads from the app and passes it along. `onopenlink` → the external browser after the person confirms. `size-changed` → layout. `ui/message` → to that session if it is an in-conversation screen; if it is a pinned screen, the person is asked which session to send it to.
- **B-5 Update notification** As in "How an open screen sees the same value" above.
- **B-6 A waiting screen** Shows a skeleton while the process starts (decided 2026-09-14: for anything asynchronous, a good skeleton is enough). A crash is shown inside the screen with the reason and a "restart" button.
- **B-7 Viewing the record** Opens this app's run record and agent usage next to the app screen.

## C. The build loop (this feature's first promise)

- **C-1 Scaffold** The "New app" button and the orchestrator tool `create_app` do the same thing. The template follows the rules from the start: tool annotations, visibility scope, state on the server, the data folder, receiving update notifications, how to use `centralu.agent`, and what is forbidden.
- **C-2 Builder session** One per app. For a project app, **cwd is the project root**, and app guidance is given through `roleAppend` (the same way as a coordinating session). Making the app folder the cwd breaks the handoff note, file links and record catch-up, which all assume the project root. For a user-folder app, cwd is the app folder (which is why P-6 comes first).
- **C-3 The builder session tests its own app** That app's tools attach to the builder session, which can call `check` (manifest validation, starting the server, the tool list, reading `ui://`, checking visibility and annotations). The person must not become the tester. The person's place is to judge.
- **C-4 When it takes effect** It does not restart on every file change. It restarts once **when the builder session's turn ends** (something only we can do, since we know the session's state). A call in progress is not cut off. A "restart" button is also provided. A Claude session gets the changed tool list from the next turn; a Codex session gets it from the next thread.
- **C-5 The "fix this here" line** A thin composer sits under the app screen. What is typed here goes to the builder session, with which app and which screen it came from attached. The user never leaves the app. In v1, the user pastes in a screenshot. Capturing the app screen directly (WKWebView's `takeSnapshot`) is a later step: Tauri does not expose it, so it needs an objc2 call, and GPU-drawn content is not captured.
- **C-6 An error reaches the builder** If the app process dies or a tool throws, the tail of stderr is shown in the screen, and one "send to builder session" click passes it along. It is never sent automatically, to stop the agent from repeating fix-and-break cycles without the person knowing.

## D. Brokering (an agent, between apps, host data)

- **D-1 Running an agent** On receiving `run_agent`, a new session is made under that app for each request, and archived automatically when it ends. It is made fresh per request because Claude's structured output (`outputFormat`) is fixed only when the session starts (Codex takes `outputSchema` per turn). Given a `schema`, it returns validated JSON. The preset is `safe` (decision 6), and its tools follow `uses.agent` and the project default.
- **D-2 Between apps** `call_app`. Only the `model` tools of an app listed in `uses.apps` may be called.
- **D-3 Host data** Opens only what is written in `uses.host`. Resolves the item left in #97 (a capability model for an app to declare the host feature it needs) the same way.
- **D-4 Capability approval** Asks the person the first time an app uses a capability ("The resource-search app wants to use Claude"). Remembered per app and per capability, and asked again if `uses` changes.
- **D-5 Stopping runaway calls** A chain depth limit (default 3), repetition detection within the same chain, and per-app concurrency and frequency caps. This is where "preventing an A→B→A loop," deferred in #80, is resolved.
- **D-6 Cancellation and the record** A cancellation propagates down the chain. Each request creates a child row in `app_runs`, and the whole chain is viewed on one screen.

## E. Handoff (the local half)

A team server (permissions, distribution, central records) sits behind the paid boundary, so it is outside this plan. What is done here is only what works with no server.

- **E-1 Versions** For a project app, git is the version. The record screen shows that folder's commits, and reverting is done through git. Only a user-folder app or an imported app, which sit outside git, keep a snapshot.
- **E-2 Export** Bundles the app into one folder (or a zip). A project app is already shared with the team the moment it is committed to the repository.
- **E-3 Import** Follows the trust model (question 3). It arrives off by default, and the person turns it on after seeing `uses` and the file list.
- **E-4 Deep link** Opening `centralu://app?url=…` brings up E-3's confirmation screen.

## F. Documents and compatibility

- **F-1** `docs/apps.md`: the app's shape, the call path, brokering, security boundaries. States the scope of compatibility honestly (an in-conversation screen is spec, updates on a pinned screen and brokering are our own extension). Two copies, English and Korean.
- **F-2** Write an app server's permissions, screen isolation, and trust model into `docs/security-boundaries.md`.
- **F-3** Add an e2e test that opens two apps published for another host, unmodified, as in-conversation screens. If it breaks, compatibility is broken.

---

## Verification matrix

Every new test is confirmed by **inverting** it: it has to fail when the fixed code is disabled (a discipline set on 2026-09-24).

**Automated (e2e, mock agent)**

| Promise | Scenario | What to look at |
|---|---|---|
| Opens inside a conversation | A mock session calls a tool with a screen | The screen under the card, tool-input and tool-result received |
| The same screen as a function | Set the slider to 0.1 seconds on the pinned screen → a mock session calls `get_interval` | The same value. One row for the screen, one row for the session in the record |
| Updating an open screen | A mock session calls `set_interval` | The slider on the already-open pinned screen moves |
| Visibility scope | The mock session's tool list; the screen calls a `model`-only tool | The `app`-only tool is absent from the list, and the screen's call is refused |
| Blocking impersonation | App A's response points to B's `ui://` | No screen opens, and the refusal is recorded |
| Isolation between apps | App A's screen accesses B's storage and window | Fails |
| Blocking IPC | Calling a Tauri command from an app screen | Fails |
| Stopping a runaway | A calls B, B calls A again | Stops at the second A, and the reason is recorded |
| Cancellation propagation | Stop the calling session | The agent run downstream is cancelled too |
| Codex approval | A mock Codex sends an app tool confirmation request | An approval card appears instead of an auto-refusal |

**Manual (dogfooding, a real agent)**

| Promise | Scenario | What to look at |
|---|---|---|
| Built together with a screen | "Make me a capture-interval slider" | The app appears in the sidebar, and the screen has a slider |
| Fixed right there | "Add a reset button" in the composer | Never leaving the app, the button appears once the turn ends, and the value is kept |
| Calls the agent in use | An app tool asks for a summary | Capability approval on first use, a session under the app, JSON matching the schema |
| Acceptance criterion (end of C) | Rebuild, in this format, a tool that was made before but never used because of install and setup barriers | A non-developer opens it with no explanation |

**Performance budget**

| Situation | Standard |
|---|---|
| 5 apps installed, doing nothing | Under 0.2% CPU (this app's own current standard), 0 app processes |
| Opening the pinned screen of an app that was down | The skeleton is immediate, the first screen within 2 seconds |

## Outside this plan

- Team server: permissions, distribution, central run records, relay (the paid boundary)
- An app waking itself up (a timer, watching). The broker server refuses a call with no run id
- A sandbox for the app server itself (process isolation). v1 relies on trust alone
- Capturing the app screen directly and handing it to the builder session
- Moving the control app to the new format
- An app marketplace

## To confirm separately from this plan (found during the re-review)

1. **Codex resume does not resend the MCP configuration** (`codex/index.ts:143-159`). If the initial configuration does not stay with the thread, a Codex orchestrator that slept and woke up loses its `centralu` tools. This has to be confirmed by running it (the same measurement as S-7).
2. **An MCP server approved in the Codex orchestrator is likely not to work.** because confirmation requests are auto-refused (`codex/index.ts:309-314`). This also has to be confirmed by running it.
3. ~~The user project's `.centralu/handoff/` is not ignored by git.~~ **Resolved (#142)**: the handoff note was moved out of the user's repository, into the data folder as `handoff/<project id>/<session id>.md`. The app no longer reads, writes, or cleans up `.centralu/handoff/` in the repository (an old note already placed there is left as is). In a live handoff, the agent writes the note as its answer and the host is the one that places the file — no agent writes outside the repository.
4. **There is no Tauri app command permission list.** From a local-origin frame, all 12 registered commands are open. It is not a problem right now since there is no iframe, but it has to be closed before the app screen exists.

---

## Spike results

The code is in `spike/apps-host/` (branch `spike/host`). Every number was measured on Node 26.9.0, macOS arm64.

### S-4 Two SDK generations coexisting: pass
- The Claude SDK (0.3.263) bundles MCP SDK v1 on its own, so it does not collide with the v2 (`@modelcontextprotocol/client`/`server` 2.1.0) we are bringing in. 3 new packages enter the repository, and zod stays at one version, 4.4.3.
- The v2 client lists tools and calls them with both a 2026-07-28 server and a 2025-11-25 server. MRTR's "ask the person" is received by **a single handler** across both generations (from the 2025 generation it instead arrives as a server-initiated `elicitation/create`).
- **What changes in the plan**: the v2 client's default is the 2025 spec generation. The host has to state the spec generation explicitly. The SDK's stdio transport **starts the app process twice** to detect the generation (a probe, then the real one). We keep our own transport layer (about 45 lines) instead, remember the generation found for each app, and reconnect with `connect({ prior })`. This transport has to expose `pid` and `stderr` (otherwise it is mistaken for HTTP and detection stalls). v2's `LATEST_PROTOCOL_VERSION` constant is still 2025-11-25, so it is not used to tell the generation.

### S-5 Brokering over the extra pipe (fd 3): pass
- A Node app, a Python 3.9 app (standard library only), and an official-Python-SDK app all succeeded at the "host → app tool → broker call over the pipe → app → host" round trip. Steady-state round trip median 0.2–1.2ms.
- A broker call with no run id, and a forged id, are refused, and when the host cancels, the broker-side record ends as "cancelled."
- The host-side broker server uses the SDK's own transport unmodified (0 lines of extra code). On macOS the pipe is a pair of Unix sockets.
- **What changes in the plan**: an app did not end when the host closed only standard input (in Node, the pipe socket holds it open; in the official Python SDK, a reader thread does). **The shutdown rule**: the host closes standard input and the pipe together, and after the grace period ends descendants too. The template `unref`s the pipe. The Node template carries the run id in `AsyncLocalStorage`, so `await centralu.agent('…')` becomes one line with no argument for it.
- **Remaining risk**: on Windows, fd 3 is only passed through when the child uses the MSVCRT runtime (libuv docs). This has not been tested. On Windows, the loopback HTTP alternative is used.

### S-6 An install-free template: pass
- Placing one runtime file (902KiB minified, 220KiB gzipped, entirely MIT) in the app folder is enough to start with no `npm install`. Median time to the first tool list is 180–215ms (bare `node` is 123–133ms).
- Asked to add a button, Claude (Sonnet) touched only `server.mjs` and the screen, leaving the runtime alone (26 turns, 114 seconds). But the first attempt's server-start error **left not a single line in stderr**, and it wandered for 15 turns. The SDK returned nothing but `-32603` for every request.
- **What changes in the plan**:
  - C-1 The template runtime must always write a start error to stderr, and also accepts a tool with no screen (fixed and confirmed in the spike).
  - C-3 `check` actually fetches the tool list. Even a broken server had a live process.
  - C-6 A stack trace inside the minified runtime cannot be read. An error in app code keeps its file:line. The runtime ships with a source map.
  - Drop the HTTP/OAuth code the runtime does not use (about 280KiB) (a pipe-only client is about 40 lines, bringing it to 621KiB).
  - The `runtime/` committed per app (about 1.4MB) is marked as generated with `.gitattributes`.
  - The screen bridge (462KiB) goes into the HTML every time a screen opens. Whether to export it separately as a script cached at the proxy origin is decided in B-3.

### S-1 The official bridge and an opaque origin in WKWebView: pass (one caveat)

The code is in `spike/apps-ui/` (branch `spike/ui`). macOS 27.0, WebKit 22625, Tauri 2.11.5, ext-apps 2.0.0.

- Inside the loopback proxy (its own origin), an opaque-origin iframe given only `allow-scripts allow-forms` was set up, and the official `AppBridge` attached. Init, tool-input and tool-result, button → server tool → screen update (71–92ms), and `size-changed` all worked in the Tauri dev window, a `tauri://localhost` build matching production, bare WKWebView, and both Chromium and WebKit. Browser storage access is blocked with `SecurityError` (the intended isolation).
- **The current CSP blocks the proxy frame.** Adding `frame-src http://127.0.0.1:*` fixes it.
- **The caveat**: the official example map-server (CesiumJS) cannot receive a single map tile under an opaque origin (in Chromium, a blob module worker is blocked too). Switching to a per-app-port origin (`allow-same-origin`) fixes it.
- `@mcp-ui/client` was not needed.
- **What changes in the plan (proxy rules)**:
  - Set `sandbox` first, then put in the screen with `srcdoc`. **`document.write` is not used.** In the reference implementation, that approach let the screen inherit the proxy's origin and reach other proxies' addresses (secret paths included) and their storage (measured).
  - A frame is filtered by `event.source`, not by origin. Every opaque origin is `"null"`.
  - The host origin is not read from `document.referrer` but passed explicitly. Under `tauri://`, the referrer is empty.
- **What changes in the plan (origin mode)**: an app built with our template defaults to an opaque origin. A per-app-origin mode is opened separately for an imported app or one that requests it in the manifest. This mode needs **a fixed, never-reused port** per app id (because WebKit storage persists per port origin, reusing a port could hand one app's storage to another). As in dev and web mode, where the top page is `http://127.0.0.1`, **cookies are shared across every port** (measured in Chromium, WebKit and WKWebView). localStorage is separated.

### S-2 Blocking IPC from the app frame: pass (security)

- Neither the app frame nor the proxy frame has any Tauri global such as `__TAURI_INTERNALS__`, and accessing the parent or top window is a `SecurityError`.
- `window.webkit.messageHandlers.ipc` **is present in both frames, and the message does reach Tauri.** What stops it is two layers: a wrong invoke key is dropped with no response, and even a deliberately leaked key is refused entirely by Tauri's per-origin permission check. Fetching `ipc://` is blocked by the same two layers.
- A temporary wrapper recording whether a call reaches the app command handler was measured across 10 Tauri runs. Zero commands arrived from the frame, while a normal call from the main frame was recorded (the control).
- **What changes in the plan**: S-2's fallback (moving the app screen to a separate window) is not needed. Instead, three rules are kept: never serve the proxy or app content from a local origin (the dev server port, `tauri://`, a custom scheme); never add a `remote` permission covering `127.0.0.1`; and since Tauri **writes the real invoke key to stderr** every time a wrong key arrives, whatever log collects stderr must never leave the machine.

### S-8 Browser storage use by public apps: measured

- A sample of 86 (25 official examples, 61 external). 15 apps use storage. Under an opaque origin, **4 apps break**, 10 degrade gracefully, and 1 could not be checked. Adding map-server, which breaks for reasons unrelated to storage, makes it **5 of 86**.
- Since the official docs recommend keeping screen state in localStorage under a `viewUUID` key, this ratio could grow. Searching for storage use alone underestimates breakage (as map-server shows).

## Decisions (finalized 2026-09-25)

1. **Where an app lives**: inside the project (`<project>/.centralu/apps/<id>/`) by default; the user folder (`~/.centralu/apps/<id>/`) for something used across several projects. Moving the handoff note out of the repository is reviewed as a separate issue (since ignoring the whole `.centralu/` would also hide apps). Moved to the data folder in #142.
2. **App server language**: the template and guidance are Node only. The run command accepts any command at all.
3. **Trust**: one project-level trust setting decides both apps and #92 together. In a trusted project, apps run and the project's settings are respected. In an untrusted project, apps stay off and the project's settings cannot turn off the approval card. A user-folder app is trusted; only an app brought in from outside is checked separately.
4. **Which sessions call an app**: a trusted project's app attaches to every session of that project; a user-folder app attaches only to the orchestrator. The control app's tools stay invisible to a worker, as now (#81's decision is changed only for external apps).
5. **Tool call approval**: a tool with a read-only annotation is not asked about; the rest follow the session preset. A call made from a screen is never asked about. A capability (running an agent, another app, host data) is asked about once, the first time.
6. **An agent an app calls**: a new session is made under that app for each request and archived when it ends. The preset is `safe`, regardless of the calling session or the person's global settings. The original decision was `normal`; the reason for changing it is written in the last row of "What changed during implementation."
7. **The two places a screen opens**: both are done this time. The in-conversation screen comes first.
8. **The existing approved-MCP-server feature**: absorbed into apps (A-7).
9. **Scope**: all of S through D; for E, only the light pieces (a snapshot for an app outside git, import confirmation, a deep link). Team handoff is the next plan.
10. **The dogfooding target**: a resource-search tool.
11. **Naming**: the milestone is **M4** (M3, "cost dashboard," is left as is). The name used inside the product is **"app,"** the same as in the code. Reflecting this in the product spec is done in F.
12. **The four found separately**: 3 and 4 are filed as issues right away; 1 and 2 are filed after being confirmed by running S-7.

## Progress checklist

- [x] Decisions finalized and the plan committed (`2f08fc7`)
- [x] Filed issues for "To confirm separately" 3 and 4 (#142, #143)
- [ ] **S** Spikes — S-1, S-2, S-4, S-5, S-6 pass, S-8 measured. **S-3 and S-7 are waiting on a Codex login** (the Codex-side behavior is confirmed only from source and types right now)
- [x] **P** Groundwork — P-1, P-4, P-5, P-6 (#144), P-2 (#150), P-3 (#148)
- [x] **A** Runtime — A-1 through A-4 and A-6 (#148), A-5 (#151), A-7 (#152), A-8 (#154). Applying decision 3's #92 is also #152
- [x] **B** Screens — B-2, B-3, B-6, B-7, and the pinned-screen part of B-4 (#150, #154); B-1 and the in-conversation part of B-4 (#187); B-5 (#154, the loop fixed in #190); wrapping the pinned-screen message (#192)
- [ ] **C** Build loop — the code is done: host-side C-1 through C-4 and C-6 (#155); UI-side new-app button, C-5's composer, C-6's send button, reopening the screen with the new code (#192). **What is left: the dogfooding acceptance criterion (needs a person)**
- [x] **D** Brokering — D-1 through D-6 (#194). Changed decision 6 to `safe`. Codex's `run_agent` is confirmed only with a fake client, since login has not happened yet. #97 stays open: D-3 built the declaration vocabulary for external apps, but the built-in control app still reads the inbox through `AppHostApi`'s `useInbox` and `useCounts`
- [x] **E** Handoff (the light pieces) — the secrets screen and RPC; E-3 import and the person's confirmation (arrives off, asks again if `server` or `uses` changes); E-1 a snapshot (the last 5) and revert for a user-folder app, read-only git commits of that folder for a project app; E-4 app links (macOS, through the OS's open event, no deep-link plugin) — #196. E-2 export is outside the scope of decision 9. The end-to-end app link path has to be confirmed by hand in a built app (`tauri dev` does not receive the scheme)
- [x] **Real-agent pre-check** (2026-09-25, host started from source + web screen + real Claude, a temporary data folder) — the three rows of the manual matrix (built together with a screen, fixed right there, calls the agent in use), the in-conversation screen, and decision 6's `safe` (an app agent's write stops at the approval card even under the person's global bypass) all passed. Of 10 findings, an app agent session's conversation showing twice was fixed in #197 (the record cursor, #79); the run panel, tokens, restarting mid-builder-turn, the rejection indicator, English wording, the progress notification, a blank screen, and the card next to the builder session were fixed in #198. What is left: a call a screen made directly still gets no progress notification, the global placement of the completion card (design backlog), and an app agent session also showing a completion card
- [x] **F** Documents and compatibility — F-1, F-2, F-3, and the product spec's M4 (#191). The brokering part is #194
