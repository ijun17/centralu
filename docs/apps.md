# Apps: tools built where they are used

An app is a small program that lives with a project: a person uses it through its screen, and
agents call the same tools as functions. There is one code path for both. This document describes
what the code does (M4, [plans/apps-plan.md](plans/apps-plan.md) has the reasoning and the history);
where a piece is still arriving, it says so.

An app is an **MCP server**, and its screens are **MCP Apps** views (`ui://` resources, ext-apps
2.x). Centralu has no format of its own for either: an app built for another host runs here, and an
app built here is a standard MCP server. What Centralu adds on top is listed in §7.

Code: runtime `packages/agent-host/src/apps/external/`, view hosting `packages/agent-host/src/views/`,
session attachment `sessions/session-apps.ts`, inline views `inline-views.ts`, template
`packages/agent-host/app-template/`, UI `packages/ui/src/features/{app-frame,pinned-app}/` and
`session/InlineView.tsx`. The built-in `control` app (#81) is a compiled app of a different kind
and is not covered here. Security reasoning: [security-boundaries.md](security-boundaries.md).

## 1. What an app is

```
<app folder>/                       code; a project app is committed with the repository
  centralu.app.json                 manifest: the file that makes the folder an app
  server.mjs                        MCP server over stdio (any command is accepted)
  ui/index.html                     screens, served by the server as ui:// resources
  AGENTS.md, CLAUDE.md, runtime/    from the template (§8), not required

<data folder>/app-data/<project id | _user>/<app id>/    the app's data, outside the repository
```

The folder name is the app's id. An app is identified by (project, id): two projects may each have
a `notes` app, and they are two apps.

### 1.1 The manifest, `centralu.app.json`

One zod schema (`manifest.ts`) judges it, for discovery, `create_app` and `check` alike.

| Field | Meaning | Rule |
|---|---|---|
| `manifestVersion` | Manifest format | Must be `1`. Anything else is refused with "update Centralu": guessing at a format we do not know would run a changed field with its old meaning |
| `id` | App id | Equal to the folder name. `^[a-z0-9][a-z0-9-]{0,31}$`, not starting with `centralu`, not a built-in app's id (#93: with no underscore, an app cannot forge the `__` separator of `mcp__app-<id>__<tool>`) |
| `name`, `version`, `description` | What people and agents read | Not empty; at most 80, 64 and 2000 characters |
| `server.command`, `server.args` | How to start the server | Run with the app folder as the working directory |
| `home` | The tool that opens the pinned view (§6.2) | Optional. Must be a tool with a `ui://` view that the view may call; `check` reports it otherwise |
| `uses.agent`, `uses.apps`, `uses.host` | What the app **declares** it will ask Centralu for (§10) | Optional. A declaration, not a permission. Absent means nothing |
| `secrets` | Names of the secrets the app needs | Optional. Environment-variable names; `CENTRALU_*` and `CC_*` are reserved |
| `view.origin` | `opaque` (default) or `app` (§6.4) | An unknown value is refused, not read as the default |
| `csp` | Four lists of domains | Validated, but **not read**: a view's CSP comes from its resource's `_meta.ui.csp` (§6.4) |

Unknown fields are warnings, not errors, so an older Centralu reads what it knows from a newer
manifest. A change of meaning goes through `manifestVersion`, never through a new field. A manifest
over 64 KiB is not read.

Tool names come from the running server, not from the manifest. A tool whose name contains `__`, or
whose `_meta.ui.visibility` is malformed, is dropped from the app's list with a warning. A malformed
visibility is not read as the default: the side that is wrong stays closed.

## 2. Where apps live

| | Folder | Whose tools | Removing it |
|---|---|---|---|
| Project app | `<project>/.centralu/apps/<id>/`: committed with the repository, so it is shared with the team once pushed | The project's sessions, if the project is trusted (§3, §9) | Through git. Centralu has no button for it |
| User-folder app | `<data folder>/apps/<id>/` (`~/.centralu/`, or `~/.centralu-dev/` in development): for apps used across projects, and apps imported from elsewhere (§12) | The orchestrator | Settings > Apps, after one confirmation. The folder moves to `<data folder>/app-trash/`; runs, data, secrets and kept versions stay, an imported app's mark goes |

- Only the **registered project root** is scanned, never a worktree. A worktree carries its own copy
  of the folder, but the app runs once per project and worktree sessions use the root's app.
- A folder watcher follows apps appearing, disappearing and changing (the manifest, and one level of
  subfolders such as `ui/`). Discovery only reads; it starts nothing.
- Broken or untrusted apps are not hidden. They stand in the list with their reason (`invalid`,
  `untrusted`), so a person can see why an app does not run.
- An MCP server approved through `propose_mcp_server` becomes a **user-folder app with no screen**
  (a manifest only). Its calls go through the same path as every app's, are recorded, and can be
  removed. Servers approved earlier are moved over when the host starts; moving them again changes
  nothing (#152).

**Data and secrets stay out of the repository.** A project app's folder is committed, so a file the
app wrote there while running would reach the whole team.

- **Data**: the app receives `CENTRALU_APP_DATA`, a folder under `<data folder>/app-data/` created
  before it starts, and `CENTRALU_APP_ID`.
- **Secrets**: the manifest holds names only. Values live on this machine, in
  `<data folder>/app-secrets.json` (mode 0600, written through a temporary file created 0600). An
  app receives only the names it declares, as environment variables. Values of 4 characters or more
  are replaced by `[redacted:NAME]` in the app's log, run records and error bundles.
  A person enters them in the **Secrets** panel beside the pinned view (its button says how many
  are missing) or in the app's row in Settings > Apps: Set, Replace, Clear. Both call
  `apps.setSecret`, which takes only a name the manifest declares, refuses an empty value, and
  never sends a value back: the app list carries, per declared name, only whether one is set
  (`secrets: [{ name, set }]`), because the list goes out on every broadcast. The field is a
  password field that forgets what it sent. An app receives its environment when it starts, so a
  running app is stopped once its calls in progress finish and the next need starts it with the
  new value; a stopped app's failure count is cleared, since a missing key is the usual reason it
  could not start (`app-secrets.test.ts`).
- **Logs**: the app's stderr goes to `<data folder>/app-logs/<project id | _user>/<id>.log`, redacted,
  1 MiB with one older generation (`.1`).

## 3. Trust

One switch per project decides both whether its apps may run and whether its repository settings
apply (decision 3, #92). The reason is the same for both: an app is code the repository brings, and
`.claude/` settings are files the repository brings. Opening a folder should not be enough for
either to act.

| | Trusted project | Untrusted project |
|---|---|---|
| Apps | Start when needed; attached to the project's sessions | Listed as `untrusted`; never started, never attached, every call refused. No app is created there (`create_app`, `apps.create`) and no builder session is made |
| Repository settings | Apply as before | Do not apply: see security-boundaries.md, "Repository configuration and project trust" |

- **Asking**: a newly registered project starts untrusted, and the sidebar asks once with a card
  (*Trust this project? Trusting lets this project's apps run and its settings apply.*), not a modal
  dialog. It can be changed later from the project menu, or with "Trust this project" on an
  untrusted app.
- **Migration**: the `trusted` column arrived untrusted by default (store v33); then v35 marked
  **every project that existed at that moment** as trusted, once. Those were folders the person had
  chosen and worked in for weeks, and an update must not silently start ignoring their `.claude/`
  settings. Projects registered afterwards start untrusted. v35 never runs again, so trust turned
  off later stays off.
- **When a change takes effect**: turning trust off stops the project's running apps at once and
  detaches them from sessions. Claude sessions lose the tools without a restart; Codex threads keep
  the names until their next thread, but every call is checked again and refused. Repository
  settings follow at a session's next restart or resume, and the UI says so when sessions are
  running.
- **User-folder apps** are trusted: the person put them there. An app **imported** from elsewhere
  is someone else's code, so it gets its own confirmation: it arrives turned off and runs only
  after the person has seen what it runs (§12). A project app that arrives with `git pull` is
  governed by the project's trust above; it gets no second gate.

## 4. Lifecycle

| | Rule | Why |
|---|---|---|
| Start | Lazily, the first time something needs the app: a tool list, a call, a screen. Discovery and the app list start nothing | Performance budget: five installed apps and nothing happening means zero app processes |
| One at a time | Concurrent needs share one start (five concurrent calls, one process) | Two processes would hold one data folder |
| Started means answering | Connected **and** `tools/list` answered. A server that stays up but fails every request is a failed start | Spike S-6: a broken server stayed alive, answered `-32603` to everything, and said nothing on stderr |
| Protocol era | Probed once per app (`server/discover`, falling back to the 2025-11-25 `initialize`), then remembered | The SDK's own probe starts the process twice |
| One instance | Per (project, app) | Worktrees share the root's app |
| Idle | No open view and no call in progress for 5 minutes: stopped | A process nobody calls has no reason to run. An open view holds its app |
| Crash | Nothing restarts it by itself; the next need does, not earlier than 1 s, then 2 s after. The third consecutive failure stops the app (`failed`) with its reason, until Restart, `check`, a changed manifest, or its builder's turn ending with the folder changed (§8). An app that ran 60 s before dying starts the count again | Retrying forever hides a broken app |
| Stop | stdin and fd 3 closed together; after 2 s the whole process tree is terminated (SIGTERM, then SIGKILL). The app's process group is signalled even after a clean exit | Spike S-5: closing stdin alone left Node and Python apps running |
| Host shutdown | Every app stopped with a 1 s grace, without waiting for SIGKILL | Tauri gives the host 3 s |
| Manifest changed | A new entry replaces the old one; the old process stops **after its calls in progress finish**. While the app's builder is in a turn, the change waits for the turn's end (§8); `check` reads it at once | Editing a file must not cut someone's call, and a half-edited manifest must not restart the app under the person |

The app's environment is the host's **minus** every `CC_*` and `CENTRALU_*` variable (the host's
WebSocket token is among them, and with it an app could call every RPC), plus the declared secrets,
`CENTRALU_APP_ID` and `CENTRALU_APP_DATA`. Its working directory is its folder.

Status in the list: `invalid`, `untrusted`, `unconfirmed` (an imported app the person has not
enabled, or whose `server` or `uses` changed since, §12), `stopped`, `starting`, `running`,
`crashed` (the last start or run failed; the next need retries), `failed` (stopped after three).

## 5. One call path

```
view (iframe) ─ apps.invoke ──────────────────────────┐
session agent ─ app-<id> proxy (Claude: in-process;   │
                Codex: stdio bridge) ─────────────────┼─▶ ExternalApps.call ─▶ app process
another app ─── broker on fd 3 (call_app, §10) ────────┘          │
                                                                  ├─ run record (app_runs)
                                                                  └─ "changed" to open views (§6.3)
```

Every call to an app tool, whoever makes it, goes through `ExternalApps.call` (`runtime.ts`).
Visibility, the run id, cancellation, the change notification and the run record happen there,
once, in one piece of code. A second path would sooner or later skip a check.

**Callers are recorded as three kinds**: `view` (the app's own screen), `session` (with the session
id) and `app` (another app, with the parent run id). A view is not "the person": it is the app's
code, and it can call tools with nobody pressing anything. That is also why opening a pinned view
records `home` as called by `view`.

A call is refused, never sent (`rejected`), when: the manifest is invalid; the project is not
trusted; the app stopped after three failures; (caller `app`) the parent run is not open; the tool
does not exist; the tool is not visible to that caller (§5.1). Otherwise the host starts the app if
needed and sends `tools/call` with the run id in `_meta["centralu/runId"]`. Outcomes: `ok`; `error`
(the app answered `isError`, could not start, or died during the call); `cancelled` (the caller
cancelled, and the app received `notifications/cancelled`); `rejected`. A call waits at most 10
minutes, counted again from each progress notification.

### 5.1 Tool visibility

MCP Apps' `_meta.ui.visibility` says whom a tool is for: `model` (agents), `app` (the app's own
screen), or both, the default.

- A session's tool list shows only `model` tools. A view may call only `app` tools, and only **its
  own app's**: the app is fixed by the frame (§6.4), never by the message.
- Hiding a tool from a list is not the same as refusing it when called by name. The call path checks
  both directions. A server cannot tell who called it (ext-apps #746), so the host enforces this.
- The host adds one read-only tool to every app attached to a session, `run_status` (§9.3). An
  app's own tool of the same name is hidden behind it.

### 5.2 Run records

Table `app_runs` (store v34): id, project, app, tool, caller kind, caller session, parent run,
status (`running`, then `ok`, `error`, `cancelled` or `rejected`), duration, time, error. Since v37
a row also has a kind, `tool` (a call to this app's tool) or `broker` (a request this app made
through the broker, §10), and the agent session a `run_agent` request started; since v38 the tokens
that agent reported. Those tokens are everything the run's models read and wrote, summed over every
model the run used: input counts cached input too (read from or written to the cache), because an
agent reads its whole context again on every call and that is the use the person shares with the app.

- Arguments are never stored whole. Secrets are redacted first; the canonical JSON (keys sorted)
  then becomes a 200-character summary and a SHA-256 digest. Hashing after redaction matters: the
  hash of an argument that holds a short secret can be reversed by guessing.
- **Failed calls keep their redacted arguments and result**, the latest 20 per app
  (`app_run_failures`). The builder needs the input that failed.
- Kept 30 days, pruned when the host starts. A row left `running` because the host died is closed
  at the next start.
- Shown beside a pinned view (the Runs panel): time, tool, caller (with the session's name), status,
  duration, and the reason of a failure. Reading one app's runs returns its rows **and the chain
  under them** (the other apps it called, the requests it and they made), and the panel indents each
  row under the one that caused it, jumps to an agent's session ("Open session"), and re-reads
  whenever a row it shows begins, gets its agent session, or ends: the host announces that per app
  (`external_app_runs_changed`, coalesced like §6.3's notification) for every row of the app and of
  the chain under it, a read-only tool's call and the agent run it asked for included. Open views do
  not hear it; they still get no "changed" for a read-only call (§6.3). Above the list: the answers the person gave to this app's
  capability questions (forgettable), and its agent use over the last day and 30 days (runs,
  duration, tokens).

## 6. Where a view appears

MCP Apps views have no state: every view is an instance made by one tool call, and the standard
leaves restoring state to a future extension. So an app's state lives in its server and its data
folder, and a view is a window onto it.

### 6.1 Inline, under the tool card (standard)

When a session's agent calls an app tool that declares `_meta.ui.resourceUri`, the view opens under
that call's card in the conversation. This is the standard's own use of a view, and the surface
where apps built for other hosts work unmodified. `e2e/public-apps.spec.ts` runs two official
ext-apps examples here, from their published npm packages, with a minimal manifest.

- **Which card**: Claude's CLI puts the card id in `_meta["claudecode/toolUseId"]` of every MCP call
  (read from the CLI binary in SDK 0.3.263). A Codex bridge call carries no id, so the host pairs
  Codex's `item/started` (`mcpToolCall`) with the bridged call by (server, tool, arguments with
  sorted keys), waiting up to 5 s for whichever arrives second. A call with no card gets no view (a
  Claude subagent's call, for one); the call itself runs unchanged.
- **Spoof check**: the view opens only if the URI the tool declares is in its app's
  `resources/list`. If the result then points at a different view, the view closes and the refusal
  is shown and logged. Resource templates are not accepted.
- **Order**: tool-input when the call starts, then tool-result or tool-cancelled when it ends.
- **Limits**: at most 3 live views per conversation (host and UI agree); a fourth closes the one
  opened earliest. A view scrolling far out of the virtualised conversation first gets
  `ui/resource-teardown`, then folds into a placeholder.
- **Reopen** does not call the tool again. The host keeps each call's input and result in memory
  (256K characters per call, 20 calls per conversation, 8M characters in all) and replays them to a
  new instance. After a host restart, or when a result was too large to keep, the placeholder offers
  only "Open app", the pinned view.
- **Pin** opens the app's pinned view.
- **`ui/message`** from an inline view asks first (*<app> wants to send this to this conversation*,
  Cancel or Send). Sent text goes only to that conversation, is shown as "<app> app ⤷", and reaches
  the agent framed as the app's text (security-boundaries.md, "Text an app sends").

### 6.2 Pinned, in the main area (Centralu's way, within the standard)

Apps stand in the sidebar under their project; user-folder apps under "Your apps". Opening one
makes the host call the manifest's `home` tool, as a `view` caller, and show the result's view in
the main area. A host calling a tool is within the standard, and the view is still born from a tool
call.

- `home` must declare a `ui://` view and be visible to `app`. Otherwise opening is refused **before
  anything is called**, so nobody sees the app's state change behind a screen that never appeared.
- Going to a session and back keeps the same document (hidden, not unloaded). Every way a view goes
  away sends teardown first. When Centralu starts again, the app that was on screen reopens (the
  host calls `home` again).
- While the app starts, a skeleton; if it fails, the reason and Restart. Restart waits until the
  host has stopped the app before opening again.
- The Runs panel (§5.2) opens beside the view.
- **`ui/message`** from a pinned view asks the person which session to send it to. Nothing is sent
  before a choice, and cancelling tells the view it was not sent. Once picked, it goes the inline
  view's way (`apps.viewMessage`): stored as the app's message, and framed as the app's text for the
  agent, saying it came from outside that conversation.

### 6.3 Keeping open views current (Centralu extension)

In the standard, a view cannot subscribe to resources (ext-apps #659). So when a call that may have
changed an app reaches it, whoever made the call, the host tells that app's open views: each
receives `centralu/notifications/changed`, which the host advertises under its `experimental`
capabilities.

- A call **may have changed** the app unless its tool is annotated `readOnlyHint: true`. A tool
  without annotations counts as possibly changing.
- A view is not told about a change its own instance caused (it already has that call's result);
  the app's other open views are. Notifications are coalesced per app.
- A view built from the template re-reads its state when told, by calling its read-only `show`. The
  template's rules require an annotation on every read tool for this reason.
- A view not built from the template ignores the notification and is not refreshed.

This is how a slider the person has open moves when an agent calls the tool behind it.

**When the app itself comes back on new code** (the builder's turn end, `check`, Restart after an
edit), a notification is not enough: the view's HTML is the old app's. The app list carries the
code the running process loaded (`codeStamp`, part of the folder fingerprint; unchanged by a
crash-and-restart of the same code, and by new code that failed to start). Each open view
remembers the stamp it opened on, and when the list says otherwise the UI reopens it: a pinned
view in place with a fresh `home` call, an inline view with its stored input and result (no tool
call again, even while its conversation is hidden). "Updated" stands in quiet text for a moment.
Only a new stamp reopens a view, never the notification above, which would let a reopened view's
first read cause the next reopen. A view reopens on its own at most 3 times a minute, because an
app that writes into its own folder would otherwise restart and reopen forever. After that it
shows "Changed · Reload" and waits for the person.

### 6.4 How a view is hosted

A summary; the reasoning is in security-boundaries.md, "App views".

- The UI asks the host for a frame address (`apps.viewFrame`). The host serves a **sandbox proxy**
  page on its loopback port, behind a secret made at every launch. The proxy creates the inner frame
  with its `sandbox` set first, then gives it the app's HTML through `srcdoc`.
- **Opaque origin** (default): the inner frame gets `allow-scripts allow-forms` only. No browser
  storage, so no two views share any. **Per-app origin** (`view.origin: "app"`): the inner frame is
  `allow-same-origin` on `http://127.0.0.1:<port>`, a port fixed for that (project, app) and never
  given to another app, because WebKit keeps storage per origin. It exists for apps that break
  without storage: 5 of 86 public apps in the spike's sample (S-8), including the ext-apps map
  example.
- **CSP** comes from the resource's `_meta.ui.csp` (the standard's place) and is stricter than the
  standard's default: no network, no nested frames, no form submission, no `'self'` source, and
  loopback addresses dropped even when declared. `_meta.ui.permissions` passes only what is declared
  (camera, microphone, geolocation, clipboard-write).
- **Bridge**: the official ext-apps 2.x `AppBridge`, loaded the first time a view opens. The frame
  is recognised by `event.source`, and the app by the component that opened it. Tool calls go to
  `apps.invoke`; resource reads go to `apps.readResource`, for the frame's own app only; a link opens
  outside Centralu after the person confirms (http(s) and mailto only); log messages are accepted
  and dropped; size changes resize an inline view (24 to 2000 px), while a pinned view fills its
  area.
- **Host context**: dark theme, `displayMode: "inline"`, our colours and fonts under the standard's
  CSS variable names, locale, time zone, and `centralu.fontScale` (reported only: the UI's own zoom
  already scales the frame). The proxy page declares the same color scheme as the host (`dark`),
  and the template's page sets its own from the theme it receives, as ext-apps'
  `applyDocumentTheme` does. With matching schemes a view is transparent on Centralu's background in
  Chromium too; Chromium paints an opaque backdrop behind a frame whose document declares a
  different scheme (white for one that declares none, which is right for an app with dark default
  text). WKWebView keeps subframes transparent either way.

## 7. What is standard and what is Centralu's

| Layer | What | With an app built for another host |
|---|---|---|
| Standard | MCP server; `ui://` resources (`text/html;profile=mcp-app`) and `_meta.ui.resourceUri`; `_meta.ui.visibility`; `_meta.ui.csp` and `permissions`; the view lifecycle (tool-input, tool-result, tool-cancelled, resource-teardown, size, host context); the sandbox proxy | Works |
| Standard, inline | A view under the tool card that called it | **Works: `e2e/public-apps.spec.ts`**, two official examples, unmodified |
| Centralu's way, within the standard | The manifest; the pinned view (the host calls `home`); attaching apps to sessions as `app-<id>`; trust; run records; `check`; the builder | The pinned view needs only a `home` tool with a view in the manifest (not covered by the compatibility test). The rest is invisible to the app |
| Centralu extension | `centralu/notifications/changed`; the fd 3 broker and `_meta["centralu/runId"]`; `run_status`; `centralu.fontScale` | Does not apply: such an app ignores the notification, so an open view shows what it last read, and it has no broker |

So "an app for another host runs as it is" holds **for the inline surface**. Keeping open views
current and the broker work only for apps built from our template. In the other direction, a
template app is a standard MCP server with a standard view: another host ignores the notification,
and `centralu.agent()` fails with "the broker pipe (fd 3) is not open". Running a template app in
another host has not been tested.

## 8. The build loop

The first promise of apps is that the place a tool is built is the place it is used and changed.
The host side exists (#155), and so does the UI side: New app, the "fix it here" bar under a view,
and "Send to builder".

- **Making an app**: the orchestrator's `create_app` and the RPC `apps.create` (the New app button's
  call) go through one function. Everything is refused **before a folder exists**: an id failing the
  proposed-server rule (#93 plus no `app-` prefix), a built-in id, an untrusted project, a folder
  that already exists. Parent folders are made one level at a time through the path guard (a
  `.centralu` link pointing outside the project stops it). The template is expanded into a hidden
  folder, which discovery skips, then renamed into place. The data folder is created. Nothing is
  started.
- **New app** (the UI's door to the same function): "New app…" in each project's menu, and a + on
  the "Your apps" group, which now always stands so the first user-folder app has somewhere to be
  made. The dialog asks for a name and the agent that builds it. It derives the id from the name
  (editable) and judges it by the host's own rule, which lives in `@cc/protocol` (`app-id.ts`) so
  both halves share one copy. What only the host can know (an existing id, trust, the template)
  comes back as the host's refusal, shown word for word. The picked agent is always sent. One that
  is missing or logged out is named with its fix, and Create waits. An untrusted project gets a
  "Trust this project" button in the dialog. On success the app is listed, its pinned view opens,
  and its builder session stands in the sidebar.
- **Fix it here**: a thin input under a pinned view. What the person types goes to the app's
  builder (`apps.askBuilder`), with a pasted screenshot attached the composer's way. The host puts a
  one-line `[Centralu]` header in front, built from what it knows rather than what the caller says:
  the app, the screen the person was looking at (from the view instance), a stopped app's reason,
  and the latest run if it did not end ok (`builderRequestFrame` in `@cc/protocol`, so the mock
  writes the same text). The person wrote the rest, so it goes through as an instruction, not
  quoted. The person stays on the app: the builder's conversation opens beside the view
  ("Builder"), not in place of it. An app without a builder offers "Start builder" instead.
- **Template** (`packages/agent-host/app-template/`): starts with `node server.mjs` alone, with no
  install and no `package.json`. One runtime file, `runtime/centralu-app-runtime.mjs` (626.5 KiB,
  built reproducibly from pinned MIT packages by `scripts/build-app-runtime.mjs` and marked generated
  in `.gitattributes`), brings the MCP SDK, zod, the view bridge and the `centralu` helpers: `tool`
  (registers a tool and carries the call's run id), `uiResource` (serves a screen and inlines the
  bridge), `readJson`, `writeJson` and `dataDir`, `agent`, `callApp`. The template follows the rules
  from its first line: an annotation on every tool, visibility, state in the server and the data
  folder, `console.log` sent to stderr (stdout is the MCP channel), start-up errors written to
  stderr, source maps.
- **Builder session**: every app gets one when it is made (`apps.builder`, `apps.createBuilder`;
  failing to make it does not undo the app). A project app's builder works in the **project root**,
  because hand-off notes, file links and history catch-up all assume it; a user-folder app's builder
  works in the app folder. The app's rules come as the session's role text, fixed when it is made.
  Preset `normal`. Tool: the project's default, or the orchestrator's for a user-folder app. It is
  attached to its own app's tools, and gets one more tool, `check`. Carrying Centralu's own tools
  does not change which files it reads (#152): like any other session of its project, a Claude
  builder in a trusted project loads the project's `.claude/` and `CLAUDE.md` and the person's
  `~/.claude`, a global bypass included, and a Codex builder reads `AGENTS.md`. Once the project's
  trust is withdrawn, it reads only the person's own settings from its next start. A user-folder
  app's builder counts as trusted, since that folder is the person's own (decision 3). Only the
  orchestrator and coordinators read no settings files.
- **`check`**: reads the manifest again; restarts the app **from the files on disk** (waiting up to
  30 s for calls in progress; past that it inspects the running process and says so); calls
  `tools/list` for real; reads every `ui://` screen the tools point at (MIME type, not empty, bridge
  tag replaced); then judges names, visibility, annotations and `home`. A missing `readOnlyHint` is
  a problem, not a warning: that tool would be asked about on every call, and Codex's `auto` preset
  would refuse it. `check` also clears a stopped app's failure count, so checking again and again
  never pushes an app into `failed`. It writes no run records.
- **Reload at the builder's turn end**: the app is not restarted on every file change, because in
  the middle of a turn the code is half edited. When the builder's turn ends (after 300 ms of
  quiet), the host fingerprints the app folder: contents for files up to 1 MiB, size and time above
  that, dot-files and `node_modules` skipped, at most 2000 files and 8 levels. If it differs from
  what the running process started from, the app restarts **after its calls in progress finish**,
  even if it was stopped, so the builder's tool list is fresh. The manifest follows the same
  rule: a change to it during the turn is read at the turn's end, when the app stops once and starts
  once on the new manifest; until then the old process keeps answering on the old one. Edits with
  no builder turn (an editor) reload a running app after 2 s of quiet. Claude sessions see changed tools from their next
  turn, Codex sessions from their next thread. Open views are told the app changed, and reopen on
  the new code (§6.3).
- **Error bundle**: the host keeps each app's last 10 errors (a failed start, an unexpected exit, a
  tool call that reached the app and failed) with the kind, time, message, tool, redacted argument
  summary, run id, and the app's last 20 stderr lines. `apps.errors` returns them. They live in
  memory; run records are the durable part. **Nothing sends them to the builder by itself**: an
  agent fixing and breaking an app in a loop behind the person's back is what this prevents. Sending
  is a person's click: under a pinned view, the latest bundle's title, message and last 8 stderr
  lines stand with "Send to builder" (`apps.sendError`) while the app is stopped, or for a tool
  failure since the view opened. A bundle goes once. The host marks it sent before sending
  (`sentAt`, removed again if the send fails) and refuses a second send. The builder gets it with
  every line quoted (`builderErrorFrame`), since stderr can carry outside text. The app list
  carries the latest bundle's time (`lastErrorAt`), and recording one announces the list. That is
  how the screen hears of a read-only tool's failure: reads send no "changed" (§6.3). A tool call
  that failed because the person denied a capability somewhere in its chain (a Deny, or a denial
  kept from before, §10) is not an app bug: its bundle carries that decision (`denied`: which app,
  what it asked for), the view says the person did not allow it and points to Runs, Permissions,
  Forget, with no stack and no "Send to builder", and `apps.sendError` refuses it. A call from
  another app that failed for that reason carries the same decision.

## 9. Attaching apps to sessions

### 9.1 Which session gets which apps (decision 4)

| Session | Apps |
|---|---|
| Orchestrator | User-folder apps |
| A project's sessions, worktree sessions included | That project's apps, if the project is trusted |
| A builder | The above, and its own app (a user-folder app's builder has no project) |
| Any other | None |

Apps that are `invalid`, `untrusted` or `failed` are not attached. The rule is checked again **at
every call**, not only when attaching: Codex cannot change a running thread's servers, so the
per-call check is what actually stops an app that was detached. The built-in `control` app's tools
are still not given to ordinary workers (#81).

Each app appears as an MCP server named `app-<id>`; in Claude its tools read `mcp__app-<id>__<tool>`.
The tool list is the last one read, so starting a session does not start every app. If none has
been read yet, the host starts the app and waits up to 15 s, then attaches it with an empty list
and updates the list when the app answers.

### 9.2 Claude and Codex

| | Claude | Codex |
|---|---|---|
| Attachment | An in-process proxy server per app | A stdio bridge process per app (`orchestrator-bridge.mjs` with `CC_APP_SERVER`); none for a session with no apps |
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

A call from a view is never asked about: the view is the control surface the app offers the
person. It is recorded as `view`.

**Codex is verified from its source only.** Codex was logged out during M4, so the Codex path was
checked against the installed 0.153.4's generated types, its binary's strings and Codex's source,
not by a logged-in run: the approval-mode values, the configuration field names, the elicitation's
`_meta` key, and whether the MCP configuration sent with `thread/resume` takes effect (spikes S-3
and S-7 wait for a login). One gap is known: `normal` follows the person's `~/.codex/config.toml`,
so with `approval_policy = "never"` there, Codex refuses an app's write tools.

### 9.3 Long calls and cancellation

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

## 10. The broker: agents, other apps, host data

An app asks for things outside itself (run the person's agent, call another app, read host data)
through a **broker**. The host starts every app with a fourth pipe, fd 3. On it the host is an MCP
server and the app its client. Only the process holding the pipe can call, so there is no token,
and the pipe says which app is calling (spike S-5).

A request passes, in order: the gate (run id), the manifest's declaration, the person's permission,
the runaway limits, then the work, and it leaves a run record however it ends. All of it after the
gate happens in one place, the broker desk (`desk.ts`).

- **Admission by run id.** Every call the host sends an app carries `_meta["centralu/runId"]`. A
  broker call must carry the run id of a call **that app is handling now, on that same pipe**. A call
  without a run id (an app waking up by itself, out of scope), with an invented id, with a finished
  run's id or another app's id is refused, and the refusal goes to the app's log and its runs.
- **Declared in `uses`.** The manifest says what the app may ask for: `"agent": true` (the person's
  default agent) or a list of tools (`["codex"]`), `"apps": [ids]`, `"host": [names]`. Anything
  undeclared is refused before anything runs. Declaring is not permission.
- **`run_agent { prompt, tool?, schema? }`.** Each request starts a new, visible session under the
  app: a project app's in its project (working folder: the project root), a user-folder app's like
  a coordinator (no project, the orchestrator's empty folder). The preset is always `safe`,
  whatever the calling session runs with and whatever the person's own settings say: a global
  bypass is trust in the person's own instructions, not in instructions an app wrote. Reads run
  without asking; writes and commands stop at an approval card in that session. Settings files: a project app's agent follows the
  project's trust like a worker; a user-folder app's agent reads only the person's own settings,
  never the orchestrator folder's files. The tool is `tool` if declared, else the default (the
  project's default tool; for a user-folder app, the orchestrator's). A tool that is not installed
  or not logged in is refused before a session is created, in the tool's words. The prompt reaches
  the agent framed as the app's text (security-boundaries.md, "Text an app sends"). The request
  waits for the turn and returns the final answer: the agent's text after its last tool call. With
  `schema` (a JSON Schema whose top level is an object), Claude receives it as `outputFormat` when
  the query starts and Codex as the turn's `outputSchema`; the host validates the answer against
  the same schema and returns it as `structuredContent`. A finished session is left `idle` in the
  list (archiving was retired, FR-20), so it does not wait in the inbox; an agent session gets no
  apps.
- **`call_app { app, tool, args }`.** Only apps listed in `uses.apps` and only their `model` tools,
  through `ExternalApps.call` with caller `app` and the parent run id (§5): visibility, trust, the
  record, the change notification (the cause is the asking run) and cancellation are the same as
  for any other caller. A project app reaches its own project's app of that id first, then the user
  folder's; a user-folder app reaches only user-folder apps.
- **`host_data { name }`.** A closed list, read-only, deny by default: `sessions.list` (the names
  shown in the sidebar and each session's kind, tool, state and times, never the conversations; the
  project's sessions for a project app, every session for a user-folder app) and `git.status` (the
  project's branch and changed files; project apps only). Only names declared in `uses.host`.
- **Asked once.** The first time an app uses a capability (an agent tool, another app, a host name),
  the person is asked where the chain started: on the approval card of the session whose agent
  started it, or on the app's pinned view (with a mark on its sidebar row) when a view started it.
  The answer, allow or deny, is kept per app and capability in the store, used until the manifest's
  `uses` changes, and listed in the Runs panel, where it can be forgotten. While the person decides
  (up to 5 minutes; no answer is a refusal that is not remembered), the request is kept alive with a
  progress notification every 10 s.
- **Runaway limits.** A chain holds at most 3 app calls (the view's or session's app is the first),
  and the same app tool cannot be called again inside its own chain; both are checked before the
  person is asked. An app runs one agent at a time (a second request is refused, not queued) and at
  most 5 a minute.
- **Records and cancellation.** Every request is a run record (kind `broker`) under the run that
  caused it, however it ends: done, failed (with its input kept like other failures), refused,
  cancelled. Requests the gate did not admit are recorded with no parent: the id they presented
  could belong to another app's chain. A `call_app` that reaches the other app is recorded by that
  app's own row. A request is cancelled when the app cancels it or when the call it serves ends or is
  cancelled, even if the app never passes the signal on; a cancelled `run_agent` interrupts its
  session.
- **Template helpers.** `centralu.agent(prompt, { schema, tool })`, `centralu.callApp(app, tool,
  args)` and `centralu.host(name)` carry the current run id for the author (AsyncLocalStorage), so a
  tool handler asks in one line. They pass the broker's progress up to the call they serve, so a long
  agent run does not time it out, and give up only when Centralu says nothing for 60 s or the request
  runs past 60 minutes. Outside a tool handler, or with no fd 3, they throw an error that says why.
  A progress message the broker sends ("waiting for the person to allow …", "waiting for the person
  to approve a step in …") travels up with it: when a session's agent made the call, the host shows
  the message as live output under that call's tool card (Claude and Codex alike). A view's own call
  does not get the message yet; its keep-alive (§9.3) is unchanged.

## 11. RPCs and events

The schemas are in `packages/protocol/src/commands.ts` and `events.ts`.

| RPC | What |
|---|---|
| `apps.list` | Every discovered app, with status and reason |
| `apps.invoke` | A view's tool call (a built-in app's call when `projectId` is absent) |
| `apps.viewFrame`, `apps.readResource` | The frame address of a view instance; a resource of the frame's own app |
| `apps.openView`, `apps.closeView` | Open a pinned view (calls `home`); close any view instance |
| `apps.inlineViews`, `apps.inlineReopen`, `apps.viewMessage` | The inline views a conversation still holds; reopen one without calling again; deliver a view's message once the person agreed (an inline view's to its conversation, a pinned view's to the session picked) |
| `apps.runs`, `apps.errors` | Run records with their chains; the latest error bundles |
| `apps.questions`, `apps.answerQuestion` | Capability questions waiting on a pinned view (chains a view started); answer one |
| `apps.permissions`, `apps.forgetPermission` | The answers kept for one app; forget one |
| `apps.usage` | One app's agent use over the last day and 30 days |
| `apps.restart`, `apps.remove` | Clear a stopped app's failures and stop it (the next need starts it); remove a user-folder app |
| `apps.create`, `apps.builder`, `apps.createBuilder`, `apps.check`, `apps.askBuilder`, `apps.sendError` | The build loop (§8) |
| `apps.setSecret` | Set, replace or clear one declared secret (§2); the value is never returned |
| `apps.importPrepare`, `apps.importCommit`, `apps.importCancel` | Stage an import and return the review; bring it in, turned off or enabled with the review's key; drop the staging (§12) |
| `apps.review`, `apps.enable` | The review of an imported app waiting for the person; enable it with that review's key (§12) |
| `apps.versions`, `apps.restoreVersion` | Kept versions of a user-folder app, or the git commits that touched a project app; restore a kept version (§12) |
| `apps.sessionTools`, `apps.sessionCall` | Used by the Codex bridge |
| `projects.setTrusted` | Trust (§3) |

Events: `external_apps_changed` (the list or an app's status changed: read `apps.list` again),
`external_app_state_changed` (§6.3), `external_app_runs_changed` (a row this app's Runs panel shows
began or ended: read `apps.runs` again, §5.2), `external_app_questions_changed` (a capability question
opened or closed: read `apps.questions` again), and `app_view` (an inline view opened, got its
result, was cancelled, closed or refused; stored without bodies, so a reopened UI can draw
placeholders). A capability question a session's chain raised is that session's
`approval_request` with `detail.kind: "capability"`.

## 12. Handing apps over: import, versions, links

Plan section E, the local half (decision 9): an app can be brought in from a folder, a zip or a
link, and an app outside git keeps versions to go back to. Sharing through a team server is the
next plan. Code: `apps/external/handover.ts` (staging, confirmation, versions), `imports.ts` and
`zip.ts` (reading a source), `import-book.ts` (the marks), `versions.ts`; UI
`features/app-share/`.

### 12.1 Import (E-3)

"Import" on the **Your apps** group opens one dialog for a folder, a `.zip` file, or an https
link to a `.zip`. It takes two steps.

1. **Review.** `apps.importPrepare` copies the source into a staging folder in the data folder
   (`app-staging/`, which discovery never scans, so nothing there can start or attach), judges it,
   and returns what the person sees before anything is in: the command and its arguments (what it
   runs, as the person), what it declares in `uses` (run your agent, call other apps, read Centralu
   data), the secrets it wants, whether it has a screen, and every file with its size, plus what
   was not copied and why. A download goes to a temporary folder first and is removed afterwards.
2. **Bring it in.** "Import" moves it to `<data folder>/apps/<id>/` **turned off** (`unconfirmed`).
   "Import and enable" does the same and confirms at once, sending back the key of the review the
   person just saw; the host re-reads the staged manifest and refuses a key that does not match
   it. Closing the dialog drops the staging; staging also expires after 30 minutes and is cleared
   when the host starts. The app lands in the list and its pinned view opens.

An imported app that is not enabled is treated like an untrusted project's app: it never starts,
it is not attached to any session, every call to it is refused, `check` reports it, and no builder
session is made for it. Its pinned view shows the same review with **Enable**; Settings > Apps
says where it came from and offers "Review and enable…".

**The confirmation is the host's.** It is kept in `<data folder>/app-imports.json` (0600), outside
the app folder, so the app's own code cannot write "confirmed" and an archive cannot arrive with
it. It is bound to the folder's inode, so a different folder later created with the same id is not
covered, and removing the app forgets it. It records a hash of the manifest's `server` (command and
arguments) and `uses`; the runtime compares it at every call, start and status. If either changes
later (an editor, the builder, a restored version), the app is `unconfirmed` again ("Needs
review"), and the review shows what it ran and asked for when it was enabled. Other fields, and the
code itself, do not ask again: the confirmation is about what runs and what it may ask for, not a
review of every edit.

What is refused before anything lands (`imports.test.ts`):

| Refused | Why |
|---|---|
| An id already in the user folder (even an invalid folder), a built-in id, an id failing the #93 rule or starting with `app-` | Same rule as a new app. Nothing is overwritten |
| A link inside a folder that points outside it | Links are not followed; the refusal names the link and its target. Links pointing inside are not copied and are listed |
| A zip entry with `..`, an absolute path, a drive letter, a backslash, an empty segment or a control character | Zip slip. Files are written only under paths built from checked segments, and each is checked again to be inside the staging folder |
| A zip link entry pointing outside the archive; an entry that inflates past its declared size (inflation stops there) or fails its checksum; two entries that differ only in case or Unicode form; a file and a folder with the same name; encrypted, split or ZIP64 archives | The list the person saw must be the files that are written |
| More than 2,000 files, 64 MiB in all, 16 MiB in one file, 16 levels, or a `.zip` over 32 MiB | An app is small; the caps keep a mistake or a bomb from filling the disk |
| A source that is not an absolute path, a `file:` URL of this machine, or an `https:` URL; https with a user or password in it; a loopback, link-local or unspecified host | Only local files and https. Redirects are followed by hand, at most five, and each target is checked again |

**Names starting with a dot are not copied** (`.git`, `.env`, and `.claude/` and `.codex/` among
them): a user-folder app's builder works in the app folder and reads settings there, so an
archive could otherwise bring hooks that run before anyone confirmed anything. The folder
fingerprint does not count dot-names as code either.

### 12.2 Versions (E-1)

A **project app** is versioned by git: the Versions panel beside its pinned view lists the recent
commits that touched `.centralu/apps/<id>` (read by the host core with `git log -- <folder>`;
`repo: false` outside a repository). It is read-only; going back is done with git.

A **user-folder app** (imported ones included) has no git, so the host keeps copies. Each time the
app starts on code it has not kept yet, and when an app is imported, its folder is copied to
`<data folder>/app-versions/_user/<id>/`; the five newest stay. The copy covers exactly what the
folder fingerprint covers (one walk, `walkCode`: no dot-names, no `node_modules`), so a version's
fingerprint is the code stamp the list already carries, and the panel marks the version equal to
the code on disk as **current**. The same code starting again (after idling or a crash) adds
nothing.

"Restore previous version" (the version just before the current one), or Restore on any row,
asks once, then `apps.restoreVersion`: the current files are kept as a version first, so a restore
can be undone; the chosen version is written back (code files it does not hold are removed;
dot-names and `node_modules` are left alone, and large files get their times back so the
fingerprint matches); the failure count is cleared; and the app restarts on the restored code
through the same path as a builder's turn end, after its calls in progress, so open views reopen on
it (§6.3). An imported app restored to a version with a different `server` or `uses` is asked about
again (§12.1). Project apps are refused.

### 12.3 App links (E-4)

`centralu://app?url=<url>` opens the import dialog of §12.1 with the source filled in and a line
saying a link asked for it. The dialog reads and downloads nothing until the person presses Review;
from there it is an ordinary import, turned off unless the person enables it.

- **macOS**: the bundle registers the `centralu` scheme in its Info.plist
  (`apps/desktop/src-tauri/Info.plist`, merged by Tauri's bundler), and the shell receives links
  through the platform's own open event (`RunEvent::Opened`), not the deep-link plugin, which would
  open more commands to the webview. The shell keeps links whose scheme is `centralu` and whose
  length is under 4,096 (at most eight at a time), brings the window forward and rings `app-link`;
  the webview takes them with `take_app_links`, so a link that starts the app is not lost and none
  arrives twice.
- **The link is someone else's text.** `parseAppLink` (`@cc/protocol`) accepts only
  `centralu://app` with exactly one `url`, and that url only https (without a user or password) or
  a `file:` URL of this machine. Anything else is a one-line notice and no dialog. The host judges
  the source again by its own rules when Review is pressed.
- **Manual check** (a scheme is routed only to a registered app bundle, so `tauri dev` cannot
  receive links): build the app, open it once so LaunchServices registers it, then run
  `open 'centralu://app?url=file:///path/to/app.zip'` and, for a download,
  `open 'centralu://app?url=https%3A%2F%2Fexample.com%2Fapp.zip'`. The import dialog should come to
  the front with the source filled in, and nothing should be read before Review.
- Linux and Windows receive no links yet.

## 13. Not there yet

- The manifest's `csp` field is not read; the per-app origin is chosen only in the manifest.
- Resource templates are not accepted by the spoof check; a Claude subagent's app calls get no
  inline view.
- The Codex path is unverified by a run (§9.2), and so is `run_agent` on Codex (its `outputSchema`
  is checked against the app-server protocol and a fake adapter only). fd 3 on Windows is untested
  (spike S-5).
- The broker answers only while the app handles a call: an app cannot ask by itself (a timer, a
  watcher). The host data list has two names.
- Export (plan E-2) and sharing through a team server are not built: an app is shared by sending
  its folder or a zip of it, or by committing a project app.
- App links arrive on macOS only, and have been exercised by hand, not in CI (§12.3). An https
  host given by name is not checked for resolving to a private address.
