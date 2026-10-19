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
`session/InlineView.tsx`. These are the only apps: the compiled built-in app framework and its one app,
the control rail (#81), were removed in #372 (decided in #97). Security reasoning: [security-boundaries.md](security-boundaries.md).

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

A **root app** (#1141) is a registered project whose own root holds the manifest: the project is the
app. Its folder is the project's, named as the person likes, so its id is the manifest's `id`, not the
folder name; it is still identified by (project, id), and its data, secrets, grants and runs are kept
under that key. The design and the reasons: [plans/root-apps.md](plans/root-apps.md).

### 1.1 The manifest, `centralu.app.json`

One zod schema (`manifest.ts`) judges it, for discovery, `create_app` and `check` alike.

| Field | Meaning | Rule |
|---|---|---|
| `manifestVersion` | Manifest format | Must be `1`. Anything else is refused with "update Centralu": guessing at a format we do not know would run a changed field with its old meaning |
| `id` | App id | Equal to the folder name (a root app's is the manifest's own, §1). `^[a-z0-9][a-z0-9-]{0,31}$`, not starting with `centralu`, not a reserved id (`RESERVED_APP_IDS`: `control`, the removed control app's, #372) (#93: with no underscore, an app cannot forge the `__` separator of `mcp__app-<id>__<tool>`) |
| `name`, `version`, `description` | What people and agents read | Not empty; at most 80, 64 and 2000 characters |
| `server.command`, `server.args` | How to start the server | Run with the app folder as the working directory |
| `home` | The tool that opens the pinned view (§6.2) | Optional. Must be a tool with a `ui://` view that the view may call; `check` reports it otherwise |
| `uses.agent`, `uses.apps`, `uses.host` | What the app **declares** it will ask Centralu for (§10) | Optional. A declaration, not a permission. Absent means nothing |
| `uses.notices` | `true`: the app may post notices into a session that called it (§10, `notify`) | Optional. In `uses`, as above |
| `uses.background` | What the app does in the background, in words the person reads (§4, "Busy") | Optional, 1 to 200 characters. Without it the app cannot keep itself running. In `uses`, so an imported app adding it is reviewed again (§12) and the trust card lists it |
| `secrets` | Names of the secrets the app needs | Optional. Environment-variable names; `CENTRALU_*` and `CC_*` are reserved |
| `view.origin` | `opaque` (default) or `app` (§6.4) | An unknown value is refused, not read as the default |
| `view.span` | The span, in grid cells, the app **recommends** for its panel on the grid (§6.2): `{ "cols": 2, "rows": 1 }` | Optional, and only a default: the person's choice for the placement and their setting for the app come first. Each side 1 to 4; a whole number outside is clamped, anything else ignored — both with a warning, never an error, since an app without one simply stands at 1 × 1 |
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
| Project app | `<project>/.centralu/apps/<id>/`: committed with the repository, so it is shared with the team once pushed | The project's sessions, if the project is trusted (§3, §9); another project's session that attaches it, if the person shares it (§9.4) | Through git. Centralu has no button for it |
| Root app | `<project>/centralu.app.json`: the project is the app (#1141) | Its project's sessions, if the project is trusted (§3, §9); the orchestrator and another project's session that attach it (§9.4) | Remove the manifest: the app goes, and what is kept under its key (data, secrets, grants, runs, builder) stays for when the manifest comes back. Deleting the project takes its runs, grants and secrets with it |
| User-folder app | `<data folder>/apps/<id>/` (`~/.centralu/`, or `~/.centralu-dev/` in development): for apps used across projects, and apps imported from elsewhere (§12) | The orchestrator; a project's session that attaches it (§9.4) | Settings > Apps, after one confirmation. A running app is stopped, and waited for, before its folder moves to `<data folder>/app-trash/` (Windows will not move a folder a process is working in, #14); runs, data, secrets and kept versions stay, an imported app's mark goes |

- Only the **registered project root** is scanned, never a worktree. A worktree carries its own copy
  of the folder, but the app runs once per project and worktree sessions use the root's app.
- The root's own `centralu.app.json` is read with it, and the root is always watched, so a manifest
  added or removed there is seen without a restart. An app in `.centralu/apps/` with the same id keeps
  it; the root app is then listed `invalid` with the reason. A root manifest that does not pass is listed
  under its `id` when that much reads, else under `centralu-root`, an id no app can take.
- A folder watcher follows apps appearing, disappearing and changing (the manifest, and one level of
  subfolders such as `ui/`). Discovery only reads; it starts nothing.
- Broken or untrusted apps are not hidden. They stand in the list with their reason (`invalid`,
  `untrusted`), so a person can see why an app does not run.
- **User-folder apps become projects** (#1141): once the host is ready (where the steps a swap left
  for later run, so a host failing before then has moved nothing), each `<data folder>/apps/<id>/`
  whose manifest is valid and names its folder's id is registered as a project **in place**, in the
  same store transaction as the move below, and is that project's root app from then on, once (`apps.adoptedUserApps`, bound to a random mark written in the folder, `.centralu/adopted`, so a
  project the person deletes is not registered again, and a folder made later under the same name is:
  not the folder's file id, which ext4 gives again to a folder made where one was just removed, birth
  time and all). What was kept under `_user/<id>` is carried to `<project id>/<id>`: data,
  logs, kept versions and secrets are copied; grants are copied, and so are other apps' grants to
  call it; runs and the app's sessions move to the project; the builder map, attachments, grid panel,
  view origin port and the window's span and open app follow the new key. The project is trusted,
  except an imported app the person never enabled. Sessions the manager already loaded follow, and
  windows hear them again (`session_created`), so the builder is found under the new key in the same
  run. A folder whose manifest is invalid or names another id (a backup copy) is not moved: it stays
  listed with its reason, as today. Copies leave the old key's state for a previous
  build during a swap (`user-app-adoption.ts`, [plans/root-apps.md](plans/root-apps.md) §4). One that
  appears later, such as an approved MCP server, is registered the same way while the host runs.
  **The old key still reaches it:** a call or any other request by `user/<id>` (an older window during
  a swap, a stored name, a script) resolves to the project's root app (`ExternalApps.resolve`, which
  every runtime method taking a key reads first), with that app's trust and rules, while the user
  folder has no app of that id and the project still exists.
  **A deleted project gives the folder back** (#1204): while a session of the project is in the trash
  the folder stays where it is, adopted, since restoring one registers the project again at that path.
  Once none is (the project had none, or the trash lost them for good), its folder goes to
  `<data folder>/app-trash/` as a removed user-folder app's does, the data, logs and kept versions it
  kept under `<project id>/<id>` go back to `_user/<id>`, and the record goes. **Nothing `_user/<id>`
  already held is deleted**: it can be the only copy of something (a previous build serving after a
  rollback writes there only), so it goes beside the folder, to `<data folder>/app-trash/<id>-<ms>-user-data/`,
  where no sweep looks, before the project's copy takes its place. Its secrets and grants are not
  returned: they went with the project, and the folder put back gets what `_user/<id>` still holds.
  Moving the folder back into the user folder makes it a new project, with its data. Nothing moves
  while a project is registered at that folder (the person added it again, in any spelling, or through
  a link, a junction or a `subst` drive: real paths are compared; or inside the folder) or a session in
  the trash names it, nor while a project's path cannot be resolved (a drive that is not there now, a
  link loop, no access, or a UNC path, which is never resolved). Such a project holds every give-back
  until it resolves or goes; a mapped drive letter is resolved, and a dead server can make that slow. Only
  the folder that carries the adoption's mark moves: another folder of that name, and what is kept for
  it, is never touched.
  Checked at each start once the host is ready, after a project is deleted, and after the trash is
  emptied or loses a session; a move that fails (a folder in use on Windows) is tried again a few
  times, then at the next start.
- An MCP server approved through `propose_mcp_server` becomes a **user-folder app with no screen**
  (a manifest only). Its calls go through the same path as every app's, are recorded, and can be
  removed. Servers approved earlier are moved over when the host starts; moving them again changes
  nothing (#152).
- The proposal itself waits in `orchestrator_mcp_proposals` until the person answers. Every change to
  that list (and to the skill proposal list) is announced by the host with
  `orchestrator_proposals_changed`, sent after the write, and the screen re-reads on it: not on the
  orchestrator's `tool_call`, which arrives before anything is saved (#703). A pending proposal
  counts as waiting on the person: the orchestrator's sidebar row, the top-bar count, the waiting
  list and the next-waiting jump carry it like an approval. Two re-reads cover a missed broadcast:
  the reconnect recovery reads both lists (a gap such as sleep or a host swap), and the `tool_result`
  of a proposal call (`propose_mcp_server`, `propose_skill`, `centralu_run`; matched by session and
  call id) reads them after the save, for a host that predates the event.

**Data and secrets stay out of the repository.** A project app's folder is committed, so a file the
app wrote there while running would reach the whole team.

- **Data**: the app receives `CENTRALU_APP_DATA`, a folder under `<data folder>/app-data/` created
  before it starts, and `CENTRALU_APP_ID`.
- **Secrets**: the manifest holds names only. Values live on this machine, in
  `<data folder>/app-secrets.json` (mode 0600, written through a temporary file of its own created
  0600). A file that does not parse is moved aside as `app-secrets.json.unreadable-<ms>`, never
  written over, and apps start without secrets until they are entered again; one that cannot be read
  at all is left in place and not written until it can be (`private-json-file.ts`). Either is said on
  screen (#944): the app list carries `secretsUnreadable` (the copy's file name, or null while the file
  is stuck in place, and `reason`: why, in a few words such as "it is not valid JSON" or "Centralu may
  not read it (EACCES)", never anything the file holds) on every app that declares secrets, and the
  Secrets section shows one line above the fields; while the file is stuck, Save is disabled and says
  why. The reason is known to the host that met the file: a copy found after a restart is named
  without one. The line goes for an app once that app has a value again (one file holds every app's
  values), or once a stuck file reads again; a moved-aside copy is found in the data folder, so a
  restart says it again until the copy is removed or each app's values are back. An app receives only the names it declares, as environment variables. Values of 4 characters or more
  are replaced by `[redacted:NAME]` in the app's log, run records and error bundles, and in the text of a failed start
  (the list, a check, a caller's refusal), and in what a check report and a screen read quote of the app's own errors
  (a failed `resources/read`, a failed second tool list; also the tool and screen names the report prints), also where JSON
  escapes them (a multi-line key in an argument, #838). The app's log is masked a line at a time, so each line of a
  multi-line value (a PEM) of 16 characters or more is masked on its own; shorter lines of it (`}`, an empty line)
  are not. A line past 8192 characters is written in pieces; the cut is made on the masked text and keeps back as many
  characters as the longest value, so a value split across two reads is masked whole.
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

- **Asking**: a newly registered project starts untrusted, except one Centralu made itself as a new empty
  folder (below, #655), and the sidebar asks once with a card
  (*Trust this project? Trusting lets this project's apps run and its settings apply.*), not a modal
  dialog. It can be changed later from the project menu, or with "Trust this project" on an
  untrusted app. Trust follows the project, with no switch per app (owner, #1141), so the card lists
  what trusting covers: each of the project's apps (its root app and those in `.centralu/apps`) with
  its name, the first line of its description and what its manifest's `uses` declares, in plain words
  (`uses` is on the app list for this, a protocol addition), and says that the project's own root
  app then reaches the orchestrator and other projects. A long list scrolls inside the card, and each
  description is shown whole. When the project has apps, the menu's "Trust this project…" opens that
  card instead of trusting at once, and so does every other "Trust this project…" (an untrusted app's
  screen, its row in Settings, the New app dialog), in place (`TrustCard`).
- **An app a trusted project gains later** (a manifest a `git pull` brought, root or inside) is
  trusted with the project (owner). The inbox says so once ("New app: <name>", with what it may ask
  for); opening it opens the app, Done takes it off. The window keeps what it has seen per trusted
  project in its workspace snapshot (`noteAppArrivals` in @cc/core); a project seen for the first
  time, or whose trust just changed, gives no notice, since its card listed its apps.
- **Migration**: the `trusted` column arrived untrusted by default (store v33); then v35 marked
  **every project that existed at that moment** as trusted, once. Those were folders the person had
  chosen and worked in for weeks, and an update must not silently start ignoring their `.claude/`
  settings. Projects registered afterwards start untrusted, except a new empty folder Centralu made (#655:
  `projects.create` / `create_project` without a Git source, on this machine or a linked one), which starts
  trusted: only the person and Centralu wrote there. A clone starts untrusted, since an agent can ask for any
  URL; registering an existing folder is unchanged, and registering a path that is already a project never
  changes its trust. v35 never runs again, so trust turned off later stays off.
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
| Start | Lazily, the first time something needs the app: a tool list, a call, a screen. Discovery and the app list start nothing, except that a host starting resumes the apps that were busy (Busy, below) | Performance budget: five installed apps and nothing happening means zero app processes |
| One at a time | Concurrent needs share one start (five concurrent calls, one process) | Two processes would hold one data folder |
| Started means answering | Connected **and** `tools/list` answered. A server that stays up but fails every request is a failed start | Spike S-6: a broken server stayed alive, answered `-32603` to everything, and said nothing on stderr |
| Protocol era | Probed once per app (`server/discover`, falling back to the 2025-11-25 `initialize`), then remembered | The SDK's own probe starts the process twice |
| One instance | Per (project, app) | Worktrees share the root's app |
| Idle | No open view, no call in progress and no busy hold for 5 minutes: stopped | A process nobody calls has no reason to run. An open view holds its app |
| Busy | An app whose manifest declares `uses.background` may say it is busy with background work (`centralu.busy(reason)`, anywhere in the app, a timer included) and release it (`centralu.busy(false)`). While it holds, the idle rule leaves it running, as an open view does; on release the idle time starts. The hold belongs to the process that made it: a stop, a crash or a restart ends it, and a report from a process already replaced holds nothing. The app's sidebar row says "Running: <reason>" and has Stop, as do its row in Settings and its view; Stop closes the view if one is open and stops the process (`apps.restart`), and the next need starts it again, and it may hold again. A hold also outlives the host: the apps holding busy are kept in `app-busy.json` in the data folder, and a host that starts (a restart, or the new one in a swap) starts them again 3 s after its first scan, with no call; each record is spent then, so an app with no work left goes on the idle rule. Releasing the hold, the person's Stop and a crash remove the record; an app that is gone, may not run, or no longer declares `uses.background` is not started (#1236) | Work that runs on its own clock (a merge queue landing pull requests overnight) stopped with the process when nobody looked at the app. The person sees what keeps it running and can stop it, and an app holds only what its manifest declares |
| Crash | Nothing restarts it by itself; the next need does, not earlier than 1 s, then 2 s after. The third consecutive failure stops the app (`failed`) with its reason, until Restart, `check`, a changed manifest, or its builder's turn ending with the folder changed (§8). An app that ran 60 s before dying starts the count again | Retrying forever hides a broken app |
| Stop | stdin and fd 3 closed together; after 2 s the whole process tree is terminated (SIGTERM, then SIGKILL). The app's process group is signalled even after a clean exit. Windows has neither groups nor signals: the app is not started detached (that would give it no console, and every console program it starts a window of its own), and its tree is ended with `taskkill /T /F` (#14). Once the app has ended there, by itself or stopped, what it left running is found by parent links (Windows keeps an orphan's parent id; creation times rule out a reused number) and ended the same way: a Node app's plain children already die with it in libuv's job, but a Python app's children and `detached` ones do not | Spike S-5: closing stdin alone left Node and Python apps running. On Windows the first test run showed a `detached` helper outliving its app |
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
- **A `run_agent` row keeps its request and answer (#378, store v57)**: the app's prompt once a
  session stood up for it, the agent's answer and its structured output, redacted like the rest of
  the row. Deleting a session for good no longer deletes the runs it started or ran in: the link
  (`session_id`, `caller_session_id`) is cleared and the row stays in the app's log. Until then
  purging an app-agent session erased its run, and purging a session that called an app erased
  those calls.
- **The record of a deleted app-agent session (#378)** is kept in `app_run_records` (what the trash
  lists: app, session name, tool, status, duration, tokens, request, answer, output, times),
  `app_run_messages` (the whole conversation, tool calls and their results included, copied from
  `messages`; owner decision 2026-10-06) and `app_run_subagent_messages` (its subagents' steps, from
  `subagent_messages`), in one transaction before the session goes, checked by its row counts
  against the session's: a copy that is not whole keeps nothing, and the session stays. None points
  at `sessions`, and the project name is copied in, so a record outlives the session, its log line
  and the project. The person reads it in Settings → Trash, grouped by app, and deletes it there, one,
  an app's all, or with the trash emptied; deleting it also clears the request, answer and output on
  its log line, which keeps status, time and tokens. Otherwise it goes with the log's 30 days. A
  record is the machine's its app ran on, as the run and the delete were: `trash.list` merges a
  linked machine's under its name, and `trash.readRun` and `trash.purgeRuns` go there by `machine`.
  `trash.empty` leaves the records alone (the window deletes the ones it listed with
  `trash.purgeRuns`, one call per machine), so emptying across machines never takes records nobody
  was shown. An agent use count reads a row whose session is gone by its
  kept request, so a deleted session still counts as an agent started.
- Shown beside a pinned view (the Runs panel): time, tool, caller (with the session's name), status,
  duration, and the reason of a failure. Reading one app's runs returns its rows **and the chain
  under them** (the other apps it called, the requests it and they made), and the panel indents each
  row under the one that caused it, jumps to an agent's session ("Open session"), or says a deleted
  one's record is in Settings → Trash (#378), and re-reads
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

Apps stand in the sidebar under their project. A **root app** is its project (#1141): it has no row of
its own; the project's line carries an app mark (dimmed, with the reason in its label, when the app
cannot run; lit while its screen shows or its view asks something), and the mark and "Open as app" in
the project's menu open it. The project's line is dragged onto the grid or its project screen as an
app row is. Its sessions (its builder, its agents) are the project's sessions. The
"Your apps" section is gone, which also settles #732's crowded bottom; a user-folder app still listed
(a linked machine on a build from before #1141, or one this host could not move into a project)
stands in "Other apps" above the bottom row, which is drawn only while there is one. Opening one
makes the host call the manifest's `home` tool, as a `view` caller, and show the result's view in
the main area. A host calling a tool is within the standard, and the view is still born from a tool
call.

A project app's sessions (its builder, the agents its `run_agent` started) belong to the
project and stand indented under the app's row, with their session menus and badges (#591).
Sessions of a removed project app return to the project's ordinary session list. A user-folder
app's sessions have no project and stand indented under its row in "Other apps". An app row says
"asks you" for an approval or a pending question, including a question from its view; a completed
turn awaiting another message does not set that mark. A session with no project that no listed
app claims (a coordinator the control app left behind, #372; a session of a user-folder app since
removed) has no sidebar row. Search, the command palette and the inbox still reach it. The
"No app" list that used to hang under the orchestrator
row and catch all of these is gone (#372 follow-up): nothing stands under the orchestrator.

- `home` must declare a `ui://` view and be visible to `app`. Otherwise opening is refused **before
  anything is called**, so nobody sees the app's state change behind a screen that never appeared.
- Going to a session and back keeps the same document (hidden, not unloaded). Every way a view goes
  away sends teardown first. A hidden view is moved out of the window and made `inert`, never put
  in `display: none` or `visibility: hidden`: in WKWebView a frame hidden either way and shown again
  stops drawing the native scrollbars inside the app's document, leaving an empty gutter (#309). A view that holds focus when it is hidden lets go of it:
  WebKit keeps focus inside a frame that turns inert, and the keys went on into a view nobody could
  see (#115). When Centralu starts again, the app that was on screen reopens (the
  host calls `home` again).
- While the app starts, a skeleton; if it fails, the reason and Restart. Restart waits until the
  host has stopped the app before opening again.
- The Runs panel (§5.2) opens beside the view.
- **On its project's screen** (product-spec §5.5) the pinned view stands in the app's panel. It is
  the same entry, instance and frame as the app view's: the frame never moves in the document (a
  moved iframe loses its document), the view is laid over the panel's slot and only its style
  changes (`pinned-app/slots.ts`). In a panel the view has no header; the panel's Open goes to the
  app view, and removing the panel closes the view, teardown first. The app's sidebar row dropped on
  the screen adds its panel where it lands. Project screens start empty; apps never appear automatically. While anything is dragged, the panel lays a
  transparent cover over the view (`pinned-app/dragShield.tsx`, #296), and the view stays in sight:
  in WebKit a drag goes into a frame whatever its pointer-events say, and the row or panel would
  land in the app instead of beside it. The cover is the panel's child in React's tree, portalled
  into the view, so the panel's own drag handlers hear the drag; it goes on the drag's drop or
  end, or when the drag leaves the window. The panel's slot takes the view's place in the keyboard order: Tab
  from the panel's header goes into the view, and back out to the header.
- **On the grid** (product-spec §5.4, #288) an app placed there by hand gets **a view of its own**:
  the same hosting (opened by `home`, laid over the panel's slot, hidden rather than unloaded on
  another screen, teardown first when the panel is removed), but a separate entry and instance
  from the pinned view above, so the same app can stand on the grid and on its project screen at
  once, each keeping its document, with one app process behind both. Each grid view costs one
  instance and one frame; nothing caps their number.
- **An app panel's span on the grid** (#306): columns × rows of grid cells (a session panel is
  1 × 1). The person sets it — for one placement from the panel's top bar ("2×1", a cell picker;
  kept on the placement, `GridPanel.span`), for the app in Settings → Apps — and the app may
  recommend one in its manifest (`view.span`, the app list's `span`). The first that is set wins:
  placement, Settings, the app, 1 × 1. The grid clamps a span the window cannot hold and says so on
  the button; the view is laid over the larger slot like any other (product-spec §5.4). So a view
  must work at whatever size it gets: the recommendation is a hint, not a promise.
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
  with its `sandbox` set first, then gives it the app's HTML through `srcdoc`. Under the keeper the
  address names the front door's port and a secret derived from the keeper's token, and open
  instances are handed to the next host, so a view stays as it was across a build switch
  ([agent-host.md](agent-host.md) §4.2). A linked machine's view is served the same way by the hub,
  from the machine's raw document and with the hub's own per-app origin ports, so storage stays
  apart per app and per machine in the one window that renders them all
  ([plans/remote-hub.md](plans/remote-hub.md) §11).
- **Opaque origin** (default): the inner frame gets `allow-scripts allow-forms` only. No browser
  storage, so no two views share any. **Per-app origin** (`view.origin: "app"`): the inner frame is
  `allow-same-origin` on `http://127.0.0.1:<port>`, a port fixed for that (project, app) and never
  given to another app, because WebKit keeps storage per origin. It exists for apps that break
  without storage: 5 of 86 public apps in the spike's sample (S-8), including the ext-apps map
  example. The host listens on that port from the app's first view until the app is removed (its
  folder or its project) and its last view is closed; the port stays the app's, so an app put back
  gets the same origin (#392). A linked machine's app keeps its port open for the hub's life: the
  hub is not told when it is removed there.
- **CSP** comes from the resource's `_meta.ui.csp` (the standard's place) and is stricter than the
  standard's default: no network, no nested frames, no form submission, no `'self'` source, and
  this machine's addresses (loopback, unspecified and link-local, `isThisMachineHost`) dropped even when declared. `_meta.ui.permissions` passes only what is declared
  (camera, microphone, geolocation, clipboard-write). Both are read from the resource's **contents**
  entry, which the template runtime's `uiResource` leaves without `_meta`; the project-board app adds
  it there (`viewResource` in its server.mjs) to declare GitHub's image hosts as `resourceDomains`,
  so images in an issue it shows load and nothing else does.
- **Bridge**: the official ext-apps 2.x `AppBridge`, loaded the first time a view opens. The frame
  is recognised by `event.source`, and the app by the component that opened it. Tool calls go to
  `apps.invoke`; resource reads go to `apps.readResource`, for the frame's own app only; a link opens
  outside Centralu after the person confirms (http(s) and mailto only); log messages are accepted
  and dropped; size changes resize an inline view (24 to 2000 px), while a pinned view fills its
  area.
- **Host context**: the theme (§6.5), `displayMode: "inline"`, locale, time zone, and
  `centralu.fontScale` (reported only: the UI's own zoom already scales the frame).

### 6.5 The theme in a view (#312)

A view gets the theme the person chose in Settings (light or dark, a preset, a custom theme, the
accent; [themes.md](themes.md)), so an app can look like Centralu without knowing which theme is on.

- **`theme`** is `light` or `dark`: the side of the theme that shows.
- **`styles.variables`** carries all 76 MCP Apps style variables, mapped from Centralu's tokens
  (`packages/ui/src/features/app-frame/hostStyles.ts` is the table): the colour roles (background,
  text and border for primary, secondary, tertiary, inverse, ghost, info, danger, success, warning
  and disabled, and the focus rings), the two fonts, weights, text and heading sizes with their line
  heights, radii, the border width and shadows. Centralu is achromatic, so the roles the standard
  gives a hue land on the inks: info is plain text, and **warning is the signal colour**, what is
  waiting for the person (pure white in dark, pure black in light). Danger is Centralu's danger red,
  success the diff's green. The two fonts and the text line heights follow the body font, code font
  and line height in Settings → Appearance ([themes.md](themes.md)), and a change is sent like a theme
  switch. Sizes are not multiplied by the text size setting, since the root zoom
  already scales the frame; where Centralu has no step of its own (a large heading, bold), the value
  is written out.
- **`centralu.variables`** carries Centralu's own, which the standard has no name for:
  `--centralu-signal` (the signal colour again, under its own name) and the scrollbar,
  `--centralu-scrollbar-thumb`, `-thumb-hover`, `-track`, `-size`, `-inset` and `-radius`.
- **Read where the view sits.** The values come from the tokens as they compute on the view's slot,
  so a view in the conversation gets the conversation's surfaces and a pinned view the floor's.
  Every preset puts the conversation on the floor's own steps ([themes.md](themes.md)), so an app
  panel on the grid gets the same background roles as the session panels beside it (primary =
  the floor, secondary = raised, tertiary = the hover step); a custom theme that sets
  `surface-reading` apart is the one case where the two differ.
- **Switches reach open views.** A theme switch, an edit to a custom theme and the accent send
  `host-context-changed` to every open view, without reloading it. Like every change notification
  it carries only the fields that changed, so an app reads the whole context the bridge keeps
  (`app.getHostContext()`), not the notification's.
- **The color scheme.** The view's frame, the proxy page and the app's page must declare the same
  scheme: Chromium and WebKit paint an opaque backdrop behind a frame whose document declares a
  different one (white for a document that declares none, which is right for an app with dark
  default text). AppFrame sets the frame's scheme to the theme's side and puts it in the proxy
  address's fragment (`#color-scheme=light`), the proxy page takes it from there before the first
  paint and from every host context it passes on afterwards, and the template's page sets its own
  from `theme`, as ext-apps' `applyDocumentTheme` does. With matching schemes a view is
  transparent on Centralu's background, light or dark. WKWebView keeps subframes transparent
  either way; there the scheme still decides how form controls draw.

**What the template does, and what an app should do** (recommended, never checked; owner
decision 7): the template's page applies everything it receives on `<html>` (the colour scheme, the
standard variables and Centralu's own), on connect and on every change. Its styles read only the
variables, type and shape as well as colour (sizes, line heights, fonts, weights, radii, the border
width), through one `:root` block at the top that names each with Centralu's dark value as its
fallback, for the moment before the host context arrives; nothing below that block has a colour or
size of its own. Spacing has no variable in the standard and stays literal. It also ships **Centralu's scrollbar**: a small
stylesheet that draws `::-webkit-scrollbar` from the `--centralu-scrollbar-*` variables the way
Centralu draws its own, with `scrollbar-color` and `scrollbar-width` only where `::-webkit-scrollbar`
does not exist (where it does, Chromium lets `scrollbar-color` switch it off). The project-board app
uses the same pieces, and reads its type and shape from the theme the same way, so the font, line
height and text size in Settings → Appearance reshape it as they reshape Centralu. An app built for
another host that applies the standard variables gets Centralu's colours too, and draws its own
scrollbars.

### 6.6 Narrow first (#306)

A view is often narrow: a grid or project-screen panel is one cell, about 360–480px wide on a laptop
screen, and the inline view under a tool card is the conversation's width. Centralu does not enlarge
a panel on focus (#306 left that for later). A grid panel can span more cells, but the person decides
that; an app can only recommend a size (`view.span`, §6.2), and the window may still give it one cell.
So **an app is built to work at a panel's width first and to spread out when there is room.**
Recommended, never checked:

- Nothing has a fixed width wider than about 320px; rows of controls wrap (`flex-wrap`) instead of
  overflowing, and long text wraps (`overflow-wrap: anywhere`).
- Below about 520px, a layout of side-by-side parts becomes one column that scrolls as a page
  (a media query in the view's own document measures the frame, so it is the panel's width).
- What waits on the person stays first in the narrow order.
- Check it at 360px as well as full width.

The template's page follows this (its buttons wrap, its margin shrinks on a narrow frame), and the
project-board app is the worked example: its status columns sit side by side when there is room and
stack under 520px, with the decision column first, so every card reads in full in a grid panel.
Stacked, the board is one long page, so a row of tabs above it, one per status with its count,
jumps to that section, and the tab of the section in view is marked as the board scrolls (a tab
just clicked keeps the mark until the person scrolls, so a short last section still reads as the one
chosen). The tabs are buttons with an explicit `tabindex`, since WebKit's Tab skips buttons unless
the system's keyboard navigation is on (`e2e/fixtures/app-theme.ts` checks all of it at about 380px).

### 6.7 Dragging an item out of a view (#308)

An item in a view (a board card, a row) can be dragged onto a session, and goes into its message as
a link the agent reads and can open.

**The contract for an app** is two standard drag types, set in the item's `dragstart`:
`text/uri-list` (the item's address) and `text/plain` (one line naming it, such as
`#306 App panels too narrow`). Nothing Centralu-specific; the template's `AGENTS.md` says so, and
the project-board app's cards carry both (with its own `text/x-item` for moves between columns).

**What lands.** Dropped anywhere on a session's pane, the link goes into its composer **at the
caret**, in place of a selection, as a Markdown link: `[#306 App panels too narrow](https://…/306)`.
The title is `text/plain` when it is one line and differs from the address, otherwise the address.
Only `http(s)` and `mailto` addresses become links; text with no address goes in as it is. A space
keeps it off neighbouring words, and the caret ends after it. The same rule takes a link or text
dropped on the composer itself (a link dragged from a browser, a selection from the conversation),
and a link from outside the window anywhere on the pane. A drag carrying a session, panel, project
or path type is still the grid's or the tree's (#286), and an OS file is still an attachment even
when it carries its `file:` address as a uri-list.

**Why the drag's own data is not enough.** A drag that starts in a document of one origin is not
delivered to a document of another origin in the same page. Measured on 2026-10-05 in Playwright
1.62.1's Chromium and WebKit: a card setting both types in a frame, dragged onto a textarea in the
page, reached it from a same-origin `srcdoc` frame; from a frame on another host, on the same host
and another port, and from a sandboxed (opaque) `srcdoc` frame, the page heard **nothing**, not
even `dragenter`. Only the frame's `dragend` fired. Both engines carry the same rule (WebKit's
`SecurityOrigin::canReceiveDragData`, kept by Blink), and a view is always another origin (§6.4).
So the page never sees the drag, and the DragShield (§6.2) never goes up for it.

**The route instead.** The host adds a small relay to every view's document, before its last
`</body>` (`views/drag-relay.ts`; the view's CSP already allows inline script). In the view's own
window it reads the two types at `dragstart`, after the item's handler, and posts them through the
view's bridge as `centralu/notifications/drag` (`{ phase: "start", uri, text }`); at that drag's
`dragend` it posts where the drag ended in the view's coordinates, with the view's size (`{ phase:
"end", x, y, width, height }`). The proxy passes both on unchanged. The UI (`app-frame/dragRelay.ts`)
turns the end into a point in the page and dispatches `cc-app-link-drop` on the element there; a
session pane takes it. Added by the host rather than the app runtime, it reaches every app, older
runtimes and apps built for other hosts included, and the contract stays the standard one.

| Decision | Why |
|---|---|
| The end point, not a drop event | The page gets no drop. The `dragend` in the view is the only place that knows where the hand let go |
| The point's coordinates depend on the engine | Measured with a frame 50 px right and 30 px down, a drop at (80, 440): WebKit's `dragend` said (30, 410), the frame's own coordinates as the spec has it; Chromium's said (80, 440), the page's, in every frame tried, while its `mousedown` and `dragstart` were in the frame's. The UI tells Chromium (WebView2 on Windows) by `navigator.userAgentData`, an API only Chromium has; the user agent string names both engines in each |
| Scaled by the frame's box over the view's size | The text size setting zooms the root; the frame's content box against the view's reported `innerWidth`/`innerHeight` maps the point whatever the zoom |
| An end inside the source frame, or over another frame, is ignored | Inside, it is the app's own drop (a card moved between columns); over a frame, it landed on a view, not on the page |
| The messages are the app's words | Shape-checked; an end counts only after a start from the same view and within 2 minutes, and only while that frame holds the page's focus (pressing on an item gives its frame focus: in both engines `document.activeElement` was the frame after the drag). A view that just posts the two messages puts nothing in (e2e). The link only goes into a draft the person sees and sends themselves |

**When the session cannot reach the app.** The link goes in either way, and the composer asks the
host whether this session can use the app's tools (`apps.reach`). If not, a quiet line under the
composer names the app, why, and what fixes it; it goes on send, on dismiss, on the next drop, or
when the composer shows another session. The host answers from decision 4 (§9.1) and then from the
live agent:

| `reason` | When | The line says |
|---|---|---|
| `other-project` | Another project's app, a user-folder app outside the orchestrator, or a session an app stood up | Ask in a session of that project (or: only the orchestrator can use your apps) |
| `untrusted` | The app's project, which is this session's or that of an app it attached, is not trusted | Trust the project |
| `app-unusable` | The app is `invalid`, `unconfirmed` or `failed` (`status`) | Fix the manifest, turn it on, or restart it |
| `restart` | A Codex thread started before the app was attached: Codex keeps the servers a thread started with (§9.2). The adapter answers from the servers it configured (`appAttachment`) | Restart the session |
| `bridge-failed` | Codex reported the app's bridge failed to start (`mcpServer/startupStatus/updated`), until it reports it ready | Restart the session |
| `unavailable` | No app runtime, or the app is gone | That the app is not available |

A session that is not running answers from decision 4 alone: it attaches what the rule gives it when
it wakes, and a Codex resume carries the current servers. Claude follows the attached set live
through in-process proxies, so its sessions never answer `restart`. A host from before this answers
nothing, and the line stays off.

## 7. What is standard and what is Centralu's

| Layer | What | With an app built for another host |
|---|---|---|
| Standard | MCP server; `ui://` resources (`text/html;profile=mcp-app`) and `_meta.ui.resourceUri`; `_meta.ui.visibility`; `_meta.ui.csp` and `permissions`; the view lifecycle (tool-input, tool-result, tool-cancelled, resource-teardown, size, host context); the sandbox proxy | Works |
| Standard, inline | A view under the tool card that called it | **Works: `e2e/public-apps.spec.ts`**, two official examples, unmodified |
| Centralu's way, within the standard | The manifest; the pinned view (the host calls `home`); attaching apps to sessions as `app-<id>`; trust; run records; `check`; the builder | The pinned view needs only a `home` tool with a view in the manifest (not covered by the compatibility test). The rest is invisible to the app |
| Centralu extension | `centralu/notifications/changed`; the fd 3 broker and `_meta["centralu/runId"]`; `run_status`; `centralu.fontScale`; `centralu.variables` (signal, scrollbar) | Does not apply: such an app ignores the notification, so an open view shows what it last read, and it has no broker |

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
  proposed-server rule (#93 plus no `app-` prefix), a reserved id, an untrusted project, a folder
  that already exists. Parent folders are made one level at a time through the path guard (a
  `.centralu` link pointing outside the project stops it). The template is expanded into a hidden
  folder, which discovery skips, then renamed into place. The data folder is created. Nothing is
  started.
- **Without a project** (#1141) the app becomes a project of its own: a new folder `<parent>/<id>`
  (`~/Centralu` unless a parent is given, with a new project's rules: the default is made when
  missing, a chosen parent must exist, nothing of that name may be there), the template written
  there through a dot-named sibling, then registered as a **trusted** project (Centralu made it, as
  an empty project folder, #655) whose root is the app. A folder that fails to register is removed.
  The builder works in that project, at its root. The orchestrator's `create_app` without `project`
  raises create_project's card for the folder first, since it is the one thing it makes outside a
  project.
- **New app** (the UI's door to the same function): "New app…" in each project's menu, and the app
  button beside Add project and New folder at the bottom of the sidebar, for an app that is a project
  of its own (#1141). The dialog asks for a name and the agent that builds it; without a project it
  also shows the folder it will make, in `~/Centralu` unless the person changes it (Choose… is the
  folder picker), judged as the new project dialog judges it (`projects.createPreview`), and offers
  "Import one…". It derives the id from the name
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
  A view on the grid or the project screen has the same bar, but its panel is too narrow for the
  conversation beside it, so its "Show the conversation" (and the error tail's "Show") goes to the
  app view with "Builder" open, through the same `openApp` the panel's Open uses. On the project
  screen that is the same view and × goes back to the panel; the grid's view stays on the grid.
  With no builder left, the error tail shows no "Show".
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
  because file links and history catch-up assume it; a user-folder app's builder
  works in the app folder. The app's rules come as the session's role text, fixed when it is made.
  Preset `normal`. Tool: the project's default, or the orchestrator's for a user-folder app. It is
  attached to its own app's tools, and gets one more tool, `check`. Carrying Centralu's own tools
  does not change which files it reads (#152): like any other session of its project, a Claude
  builder in a trusted project loads the project's `.claude/` and `CLAUDE.md` and the person's
  `~/.claude`, a global bypass included, and a Codex builder reads `AGENTS.md`. Once the project's
  trust is withdrawn, it reads only the person's own settings from its next start. A user-folder
  app's builder counts as trusted, since that folder is the person's own (decision 3). Only the
  orchestrator and coordinators read no settings files; under `normal` they still follow the person's
  own default mode, a global bypass included (#382).
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
  that, dot-files, `__MACOSX` and `node_modules` skipped, at most 2000 files and 16 levels (the
  depth an import allows, `APP_FOLDER_DEPTH`; one walk for every reader, `walkAppFolder`). If it differs from
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
| Orchestrator | User-folder apps. The root apps of trusted projects it attaches when it needs one (§9.4, #1205); an untrusted project's root app reaches it under no preset. Two of one id are named apart, and a name once seen stays with its app (below) |
| A project's sessions, worktree sessions included | That project's apps, if the project is trusted |
| A builder | The above, and its own app (a user-folder app's builder has no project) |
| Any other | None |

Beyond this table, a project's session can attach an app **itself** for as long as it needs it: an
app another project shares, a user-folder app, or another project's root app; and so can the
orchestrator, a trusted project's root app (§9.4). Apps that are `invalid`, `untrusted` or
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
still cost; Codex loads them. Until #1205 the orchestrator was given every trusted project's root app
(#1141), so with ten projects that are apps it carried ten servers it mostly never called. A rule that
gives a session apps by a count that grows on its own (projects, shares) is not added to decision 4;
such apps are reached on demand (§9.4), and the session pays for the ones it attached. What it is given
is bounded by things the person set up for that session: its own project's apps, its own app as a
builder, and for the orchestrator the user folder, where an MCP server the person approved for it lands
(A-7). Measured with the app `create_app` makes (two agent tools and the host's `run_status`), with 0, 3
and 10 trusted root apps: before, Codex 6,800 / 9,179 / 14,733 characters and 11 / 20 / 41 tools, Claude
6,800 / 7,004 / 7,483 (the names alone); after, 6,800 and 11 tools in every case, plus 75 characters of
instructions once (`sessions/orchestrator-app-cost.test.ts`, [tool-cost.md](tool-cost.md) §12).
The tool list is the last one read, so starting a session does not start every app. If none has
been read yet, the host starts the app and waits up to 15 s, then attaches it with an empty list
and updates the list when the app answers. A session's apps and `attach_app` wait the same bound
(`TOOL_LIST_WAIT_MS` in `sessions/session-apps.ts`, through `withTimeout`, #428).

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
loaded with `approve` instead (#382, [security-boundaries.md](security-boundaries.md)).

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

### 9.4 Another project's apps, on demand (#371 part A)

Decision 4 keeps a session to its own project's apps. The owner's decision for #371 (2026-10-05)
lets a session reach further only while it needs to: it **finds** an app it could attach,
**attaches** it (the app's tools join this session) and **detaches** it (they leave), so another
project's tools cost no context when they are not in use. Code: `sessions/app-access.ts`, the hub's
`OnDemandApps` port in `session-apps.ts`, the tools in `orchestrator-tools.ts`.

**What can be attached**, decided when the session asks and again every time the hub counts the
session's apps (and so at every call):

| App | When | Asks the person |
|---|---|---|
| Another project's app | The person shares it (off by default), its project is trusted, and it is not `invalid`, `untrusted` or `failed` | Once per pair of projects, in the calling session: the consent card (Allow once, Always for this pair, Deny). "Always" is kept per (from project, to project, `apps`) in `project_consents` (store v44, shared with part B's `ask_project`) and listed in Settings, where revoking it detaches what it allowed. "Once" lasts for that attachment; a denial is not remembered |
| User-folder app | Not `invalid`, `unconfirmed` or `failed` | Never: the person put it in their own folder to use across projects |
| Another project's root app (#1141) | Its project is trusted (an untrusted project's apps are never attached, under any preset, `auto` included), and it is not `invalid` or `failed`. Found as `<project>/<id>`, and attached by its bare id too when one project's root app has it | Never, as a user-folder app: it took that app's place. It has no share switch: its project's trust decides (owner), and the trust card lists the project's apps (§3) |
| This project's own app | Already attached by decision 4 | — |

A session in an **untrusted** project attaches nothing: its repository's text could be the one
asking, and an untrusted project runs none of its own apps either. A project's ordinary session has
the tools (they ride with the reader set, below), and so does the orchestrator (#1205, below); a
coordinator, a builder and an agent an app stood up do not.

**The orchestrator** (#1205) is given the user-folder apps and attaches the root apps of trusted
projects here, the one it needs when it needs it, under the same name book (`app-<id>`, a name once
seen stays with its app). Nothing else: a project's inner app, shared or not, is that project's
(`find_apps` does not list it and `attach_app` refuses it, naming `send_to_session`), and no card is
asked, as for any root app. The three are among its rare commands, behind `centralu_run`
(`RARE_COMMANDS` in `tool-seats.ts`): as tools they would not fit its ceiling, and its instructions
name `find_apps` in one line. Each answer names the next call in the form the seat makes it
(`centralu_run(command="attach_app", …)`). The attachment is kept per session like any other, so it
lasts across restarts until `detach_app`; a Codex orchestrator's thread restarts when the turn ends,
as a project session's does. `apps.reach` answers `reachable` for a root app it could attach and has
not: its agent attaches it with nothing for the person to do; and `untrusted` for one it attached whose
project has since lost trust (so for a project session's too), since trusting the project again is the fix.
An orchestrator that had root apps attached before #1205 reads, once, before its first turn since, that
they are no longer attached by default and how to find them (`rootAppsNotice`, [tool-cost.md](tool-cost.md) §12). A user-folder app the orchestrator had
seen, when its folder becomes a project in place (#1141), stays attached to it as an attachment of its
own, under the name it called it by (`UserAppAdoptionRecords.carry`).

**Sharing** is the person's choice, per project app: "Share with other projects" in Settings → Apps,
or the Share button in the app's header (`apps.setShared`). It is kept in the store's settings table
(`app_shared:<project>/<app>`, absent means off) and reported in the app list (`shared: true`).
Turning it off detaches the app from every session that attached it.
Attachments count only while the session holds the reader set: turning "Let sessions look at their own
project" off in Settings takes them away at once (detach_app goes with the set). Turning it off also
forgets the ones allowed with "Allow once", and turning it on again brings back the rest: those under
an "always" the person still keeps, and user-folder apps (owner decision, #382).

**The tools** (a project's ordinary session, beside the reader set; agent-host.md §1.1; the orchestrator's as commands):

| Tool | Does | Result names |
|---|---|---|
| `find_apps({ query? })` | Lists what this session could attach: `<project>/<app>` for another project's app, `<app>` for a user-folder app, with the project, the manifest's name and first description line (JSON-quoted: the author's words), and the tool names if the app has listed them since the host started (finding starts no app) | `attach_app` |
| `attach_app({ app })` | Asks for consent if needed, attaches, starts the app to list its tools (within the 15 s cap) | the tools as `mcp__<server>__<tool>`, when they are there, and `detach_app` |
| `detach_app({ app })` | Detaches an app this tool attached (a name from `find_apps`, or the server name). An app decision 4 gives stays | — |

They are counted against their own ceiling (`APP_ACCESS_BUDGET_CHARS`, 900; the set is 874, of
which about 210 per tool is the name and schema envelope), not the reader set's. Claude defers all
three behind tool search, which costs +31 input tokens per request against +263 loaded
(`scripts/probe-reader-tools.mts`; Codex has no deferral and loads them). Measured with haiku (Claude Code
2.1.289, `scripts/smoke-app-access.mts`: a fresh pair of scratch projects per trial with a shared app,
the consent card answered "always", and a prompt naming neither the tools nor the project): in 5 of
5 sessions the model found `find_apps` through tool search, attached the app, called its tool in the
same turn and detached it, and on the next turn no call reached the app (one model tried the old name
anyway; the CLI answered "No such tool available").

That smoke test ran before `ask_project` (#371 part B) was loaded on the same server. With it loaded, a question about another project's app went to `ask_project` and never to tool search
(#522: 0 of 10 runs called `attach_app`). Since then Claude loads `find_apps` (+75 tokens per request) and
`ask_project`'s description ends "For another project's apps, use find_apps." (+11); `attach_app` and
`detach_app` stay deferred. 9 of 10 runs, and 8 of 10 in a second, then called `attach_app`
([tool-cost.md](tool-cost.md) §8).

**Attaching and detaching, per agent:**

| | Claude | Codex |
|---|---|---|
| Attach | The hub recounts the live handle; the adapter's `setMcpServers` adds the app's proxy server. The tools are there **in the same turn** (measured above: the model loaded `mcp__app-counter__poke` through tool search right after `attach_app` and called it). They always wait behind tool search: the proxy drops `anthropic/alwaysLoad` from what an app declares (#513), so attaching or detaching changes the deferred names and never the request's tool list, and costs no cache rebuild (measured, [tool-cost.md](tool-cost.md)) | A thread keeps the servers it started with (§9.2), so the manager restarts the session through resume **when the turn ends** (`appsRestartAfterTurn`, beside #164's settings restart), and `mcpConfig` then includes the app. The result says the tools arrive next turn and tells the model to finish the turn. Run for real (codex-cli 0.160.0, `TOOL=codex` in the same script): the model attached the app and said it would finish next turn; after "Go on." it called `poke`, detached the app, and on the following turn no longer had the tool. That is also the first logged-in run showing the MCP configuration sent with `thread/resume` takes effect (§9.2, S-7) |
| Detach | The proxy server is removed at once | Every call is checked against the current set, so a call by the old name is refused at once; the name leaves the thread with the same end-of-turn restart |

**Names.** The app attaches as `app-<id>`, or `app-<id>-2` (and so on) when that name is taken in
the session, for instance by its own project's app of the same id, or was ever given to another app
of the session, one gone for the moment included (#1141, the session's book `session_app_names`,
`SessionAppsHub.claimAttachName`). The name is written in that book, so it stays with the app for the
session's life, and attaching it again after a detach gives it the same name; an app that later
appears in the session's own project with the same id gets a name of its own (`app-<id>-<project>`).

**Where it runs and what is recorded.** Nothing about the app changes: it runs where it lives, with
its own folder as working directory and its own data folder, one instance per (project, app) shared
with its own project's sessions (§4). Calls go through `ExternalApps.call` with caller `session`
and the calling session's id (§5), so the owner's Runs panel lists them under the calling session's
name, and approval follows the calling session's preset (decision 5).

**How long.** Until `detach_app`, or until the session is deleted. The list is kept per session in
the store's settings table (`session_apps:<session>`), so it survives the host restarting and the
session resuming. It is checked again on every count: sharing turned off, the "always" revoked,
either project untrusted, or the app becoming unusable takes it away (Claude at once; a Codex thread
refuses the call, and the name leaves at its next thread).

## 10. The broker: agents, other apps, host data

An app asks for things outside itself (run the person's agent, call another app, read host data)
through a **broker**. The host starts every app with a fourth pipe, fd 3. On it the host is an MCP
server and the app its client. Only the process holding the pipe can call, so there is no token,
and the pipe says which app is calling (spike S-5).

On Windows fd 3 is created `overlapped` (#14). A plain pipe reaches the child as a synchronous
handle, and Windows serialises I/O on one: the app's read waiting on fd 3 held back its own write
of the request, so every broker call timed out on the first Windows test run. stdin and stdout go
one way each and are unaffected.

A request passes, in order: the gate (run id), the manifest's declaration, the person's permission,
the runaway limits, then the work, and it leaves a run record however it ends. All of it after the
gate happens in one place, the broker desk (`desk.ts`).

- **Admission by run id.** Every call the host sends an app carries `_meta["centralu/runId"]`. A
  broker call must carry the run id of a call **that app is handling now, on that same pipe**. A call
  without a run id (an app waking up by itself, out of scope), with an invented id, with a finished
  run's id or another app's id is refused, and the refusal goes to the app's log and its runs.
- **`busy { busy, reason? }`, the one request without a run id (#1236).** The app tells the host
  about itself (busy with background work, or no longer), so it asks for nothing outside the app and
  reaches only its own lifecycle (§4, "Busy"). Refused unless the manifest declares
  `uses.background`; a refusal goes to the app's log. Not a run: it leaves no run record. The
  template's `centralu.busy(reason)` sends only changes, in order, and resolves false (said once on
  stderr) when Centralu did not take it.
- **`notify { to, text }`, the other request without a run id (#1161 item 1).** A notice into a
  session that called the app, posted later from a timer or a queue: "merged #77", "#78 needs
  attention". With `uses.notices: true`, every call a session's chain started carries that session's
  address in `_meta["centralu/notice"]` (`centralu.noticeAddress()` in a tool handler). The address is
  the session id with a MAC over (app, session) under a key in the data folder (`app-notice.key`,
  0600; `notices.ts`): the app can name only sessions that called it, never one it read from a list,
  another app's address does not open for it, and it still opens after the host restarts. The session
  receives it as a report arrives: recorded as the app's message, handed to the agent in the app-text
  frame (`appMessageFrame` `notice`: every line quoted, "the person did not write or read it"), and
  an idle or asleep session wakes. Refused, with a reason the app reads, when undeclared, for an
  address it was not given, when empty or over 4000 characters, past 10 a minute, while the host
  hands over or quits (the app tries again), and once the session is gone. Every notice is a run
  record with no parent, its session and text in the arguments, delivered or refused, so the Runs
  panel shows what the app told which session. `centralu.notify(address, text)` resolves true once
  delivered.
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
  the same schema and returns it as `structuredContent`. A finished session is left `idle`, so it
  does not wait in the inbox; an agent session gets no apps. **Once the run ends cleanly it is
  deleted (#378)** and its record kept in the trash (§5.2): an app that calls `run_agent` a few dozen
  times a day filled the sidebar with sessions nobody would talk to. It stays in the list, as before,
  when the run failed, was stopped or cancelled (the person needs to see what went wrong, a schema
  mismatch included), when a card was shown during it (the person took part), when the person
  opened it (its pane shown, with nothing unread too) or wrote to it from the run until the delete is
  final, its process's close included (it has become theirs), when it woke again, is waking or
  restarting, or holds something sent to it, or when it has attachments (the record copies no
  files). The delete is decided at the moment the session leaves the lists, with nothing awaited
  after, so a message sent meanwhile either keeps the session or is told the session is gone; a
  waking session is never deleted by withdrawing its wake. A delete the person asks for while the
  host's is under way is theirs: the session stays in the trash, its conversation file too unless
  they chose otherwise. A draft the person had written in a session that goes is kept on screen, to
  be copied. While it runs it is visible as any
  session: its approval cards appear there. The app has its answer once the session is gone, so a
  screen that reads `sessions.list` after its call sees it as it stays.
- **`call_app { app, tool, args }`.** Only apps listed in `uses.apps` and only their `model` tools,
  through `ExternalApps.call` with caller `app` and the parent run id (§5): visibility, trust, the
  record, the change notification (the cause is the asking run) and cancellation are the same as
  for any other caller. A project app reaches its own project's app of that id first, then the user
  folder's, then the root app of that id (#1141) when exactly one trusted project is an app of that id; a
  user-folder app or a root app reaches the user folder's, then that root app. Another project's inner
  app is never reached.
- **`host_data { name }`.** A closed list, read-only, deny by default: `sessions.list` (the names
  shown in the sidebar and each session's kind, tool, state and times, never the conversations; the
  project's sessions for a project app, a root app included as its permission card says (#1141), every session for a user-folder app; never those in the trash, FR-22) and `git.status` (the
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

The schemas are in `packages/protocol/src/commands/methods/apps.ts` (the `apps.*` methods), `entities/apps.ts` and `events.ts`.

| RPC | What |
|---|---|
| `apps.list` | Every discovered app, with status and reason |
| `apps.invoke` | A view's tool call (`projectId` absent or null means a user-folder app) |
| `apps.viewFrame`, `apps.readResource` | The frame address of a view instance; a resource of the frame's own app |
| `apps.viewDocument` | An open instance's app, origin method and raw document, for a hub that serves this host's view in its own window (#82, [plans/remote-hub.md](plans/remote-hub.md) §11) |
| `apps.openView`, `apps.recoverView`, `apps.closeView`, `apps.holdViews` | Open a pinned view (calls `home`; a client `openKey` shares/reclaims one instance and its original outcome across a planned host swap; recovery queries that key and never calls home again, even when a crash lost the reservation; `machine` names a linked machine's user-folder app); close any view instance; claim a window's pinned views after a reconnect. A view of this host opened with `lease` belongs to the window's connection: once that ends, the host waits five minutes for a claim and then closes it, so a reloaded or closed window does not hold its apps open for good (#392). A linked machine's view is opened without one |
| `apps.inlineViews`, `apps.inlineReopen`, `apps.viewMessage` | The inline views a conversation still holds; reopen one without calling again; deliver a view's message once the person agreed (an inline view's to its conversation, a pinned view's to the session picked) |
| `apps.runs`, `apps.errors` | Run records with their chains; the latest error bundles |
| `apps.reach` | Whether a session can use one app's tools now, and if not why (§6.7) |
| `apps.questions`, `apps.answerQuestion` | Capability questions waiting on a pinned view (chains a view started); answer one |
| `apps.permissions`, `apps.forgetPermission` | The answers kept for one app; forget one |
| `apps.usage` | One app's agent use over the last day and 30 days |
| `apps.restart`, `apps.remove` | Clear a stopped app's failures and stop it (the next need starts it; a view's Stop for a busy app, §4); remove a user-folder app |
| `apps.create`, `apps.builder`, `apps.createBuilder`, `apps.check`, `apps.askBuilder`, `apps.sendError` | The build loop (§8) |
| `apps.setSecret` | Set, replace or clear one declared secret (§2); the value is never returned |
| `apps.setShared` | Share a project app with the person's other projects, or stop (§9.4) |
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

"Import one…" in the New app dialog, or "Import an app" in the command palette, opens one dialog for
a folder, a `.zip` file, or an https link to a `.zip` (the "Your apps" group that had the button is
gone, #1141). It takes two steps.

1. **Review.** `apps.importPrepare` copies the source into a staging folder in the data folder
   (`app-staging/`, which discovery never scans, so nothing there can start or attach), judges it,
   and returns what the person sees before anything is in: the command and its arguments (what it
   runs, as the person), what it declares in `uses` (run your agent, call other apps, read Centralu
   data), the secrets it wants, whether it has a screen, and every file with its size, plus what
   was not copied and why. A download goes to a temporary folder first and is removed afterwards.
2. **Bring it in.** The app lands as a **project of its own** (#1141): its folder moves to
   `<parent>/<id>` (`~/Centralu` unless the person picks another parent, with a new project's folder
   rules), which is registered as a project whose root is the app. "Import" registers it
   **untrusted**, so it never runs until the person trusts the project (trusting it is enabling it);
   "Import and enable" registers it trusted, sending back the key of the review the person just saw;
   the host re-reads the staged manifest and refuses a key that does not match it. A host before
   #1141 moved it to `<data folder>/apps/<id>/` turned off (`unconfirmed`) instead, and that path
   (`commitImport`) is still what the import mark below governs. Closing the dialog drops the staging; staging also expires after 30 minutes and is cleared
   when the host starts. The app lands in the list and its pinned view opens.

An imported app that is not enabled is treated like an untrusted project's app: it never starts,
it is not attached to any session, every call to it is refused, `check` reports it, and no builder
session is made for it. Its pinned view shows the same review with **Enable**; Settings > Apps
says where it came from and offers "Review and enable…".

**The confirmation is the host's.** It is kept in `<data folder>/app-imports.json` (0600), outside
the app folder, so the app's own code cannot write "confirmed" and an archive cannot arrive with
it. It is bound to the folder's inode, so a different folder later created with the same id is not
covered: it is still an import, unconfirmed until reviewed (#838), and removing the app forgets it. Bigint stat supplies the exact file id, persisted as the
decimal string `inoExact`. The numeric `ino` remains `Number(fileId)` so older hosts retain their
existing comparison during swaps and rollbacks; it can be removed only in a later release under
the "add first, remove later" rule. The new host compares `inoExact` when present. Without it,
legacy numeric ids below 2^53 still match exactly; unsafe numeric ids retain the import mark but
are treated as unconfirmed. Lookups do not change stored records. Importing or confirming writes
both fields, upgrading a legacy record to the current exact id when the person reviews it again.
The mark records a hash of the manifest's `server` (command and arguments) and `uses`; the runtime
compares it at every call, start and status. If either changes later (an editor, the builder, a
restored version), the app is `unconfirmed` again ("Needs
review"), and the review shows what it ran and asked for when it was enabled. Other fields, and the
code itself, do not ask again: the confirmation is about what runs and what it may ask for, not a
review of every edit.

The file is also the only record of which apps were imported, so a broken one must not make an
import read as the person's own (#1172). When the file is gone and a copy moved aside from it
(`app-imports.json.unreadable-<ms>`) is in the data folder, the host writes a new file at once in
which every app then in the user folder has a mark of its own (`lost`, naming the copy). Each of
them, the person's own apps too, is `unconfirmed` until it is reviewed and enabled, and its reason
names both files by full path, and why the file could not be read while the host that moved it runs
(#944). The review does not say the app was imported, and neither does
Settings once it is enabled; like an import, it asks again if its `server` or `uses` changes. An
app made after that is not held, and removing the copy changes nothing. Putting a mended copy back
as `app-imports.json` makes it the record again, even while the host runs: the host reads the file
again whenever it changes, so its next write keeps those marks. While no such file can be written
(the file cannot be read at all, or the data folder cannot be listed), every app without a mark is
held instead. A file that cannot be read at all stays in place and refuses writes, so nothing can
be enabled until it reads again, and then its marks count as before.

What is refused before anything lands (`imports.test.ts`):

| Refused | Why |
|---|---|
| An id already in the user folder (even an invalid folder), a reserved id, an id failing the #93 rule or starting with `app-` | Same rule as a new app. Nothing is overwritten |
| A link inside a folder that points outside it | Links are not followed; the refusal names the link and its target. Links pointing inside are not copied and are listed |
| A zip entry with `..`, an absolute path, a drive letter, a backslash, an empty segment or a control character | Zip slip. Files are written only under paths built from checked segments, and each is checked again to be inside the staging folder |
| A zip link entry pointing outside the archive; an entry that inflates past its declared size (inflation stops there) or fails its checksum; two entries that differ only in case or Unicode form; a file and a folder with the same name; encrypted, split or ZIP64 archives | The list the person saw must be the files that are written |
| More than 2,000 files, 64 MiB in all, 16 MiB in one file, 16 levels, or a `.zip` over 32 MiB | An app is small; the caps keep a mistake or a bomb from filling the disk |
| A source that is not an absolute path, a `file:` URL of this machine, or an `https:` URL; https with a user or password in it; a loopback, link-local or unspecified host | Only local files and https. Redirects are followed by hand, at most five, and each target is checked again |

**A zip made on Windows has no executable bit.** Explorer's "Send to > Compressed folder" and `Compress-Archive` write
no Unix mode, so after import `start.sh` is not executable on macOS or Linux and the app fails to start with EACCES. Start
it through its interpreter (`sh start.sh`, `node server.mjs`) in `centralu.app.json`, or zip it on macOS or Linux (`zip`
keeps the mode).

**Names starting with a dot are not copied** (`.git`, `.env`, and `.claude/` and `.codex/` among
them): a user-folder app's builder works in the app folder and reads settings there, so an
archive could otherwise bring hooks that run before anyone confirmed anything. The folder
fingerprint does not count dot-names as code either.

### 12.2 Versions (E-1)

A **project app** is versioned by git: the Versions panel beside its pinned view lists the recent
commits that touched `.centralu/apps/<id>` (read by the host core with `git log -- <folder>`;
`repo: false` outside a repository). It is read-only; going back is done with git.

A **root app** in a repository is versioned by git the same way, over the whole repository (its folder
is the project). Outside a repository it keeps copies like a user-folder app, under
`<data folder>/app-versions/<project id>/<id>/` (#1141). Its folder is the person's whole project,
so a restore writes the version's files back and **deletes nothing** the version lacks, and it is
refused when the copy of the current files it takes first cannot be made (over 64 MiB, a disk error).

A **user-folder app** (imported ones included) has no git, so the host keeps copies. Each time the
app starts on code it has not kept yet, and when an app is imported, its folder is copied to
`<data folder>/app-versions/_user/<id>/`; the five newest stay. The copy covers exactly what the
folder fingerprint covers (one walk, `walkCode`: no dot-names, no `__MACOSX`, no `node_modules`,
16 levels), so a version's
fingerprint is the code stamp the list already carries, and the panel marks the version equal to
the code on disk as **current**. The same code starting again (after idling or a crash) adds
nothing.

"Restore previous version" (the version just before the current one), or Restore on any row,
asks once, then `apps.restoreVersion`: the current files are kept as a version first, so a restore
can be undone; the chosen version is written back (code files it does not hold are removed;
dot-names and `node_modules` are left alone, and so is anything deeper than the version looked: a
version an older build kept walked 8 levels, `Snapshot.depth`; large files get their times back so the
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
  is checked against the app-server protocol and a fake adapter only). fd 3 on Windows (spike
  S-5, §10) passes the broker test suites in the Windows CI job with Node apps; a Python app, and
  any app in the packaged Windows app, have not been tried.
- The broker answers only while the app handles a call, except `busy` and `notify`: an app cannot
  run an agent, call an app or read host data by itself (a timer, a watcher). The host data list has
  two names.
- Attaching another project's app (§9.4) is a project session's: the orchestrator, a worktree
  manager and a coordinator cannot. Codex gets an attached app only from its next turn, so the
  person has to send another message for the model to use it.
- Export (plan E-2) and sharing through a team server are not built: an app is shared by sending
  its folder or a zip of it, or by committing a project app.
- App links arrive on macOS only, and have been exercised by hand, not in CI (§12.3). An https
  host given by name is not checked for resolving to a private address.
- Dragging an item out of a view (§6.7) has run only in Playwright's Chromium and WebKit, not in the
  packaged app's WKWebView or in WebView2; the end point's coordinates there are taken from those
  engines' measurements. During such a drag the page hears nothing, so no drop target lights up.
