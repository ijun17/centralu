# Trust, lifecycle and the one call path

## Trust

One switch per project decides both whether its apps may run and whether its repository settings
apply (decision 3, #92). The reason is the same for both: an app is code the repository brings, and
`.claude/` settings are files the repository brings. Opening a folder should not be enough for
either to act.

| | Trusted project | Untrusted project |
|---|---|---|
| Apps | Start when needed; attached to the project's sessions | Listed as `untrusted`; never started, never attached, every call refused. No app is created there (`create_app`, `apps.create`) and no builder session is made |
| Repository settings | Apply as before | Do not apply: see security-boundaries/project-trust.md |

- **Asking**: a newly registered project starts untrusted, except one Centralu made itself as a new empty
  folder (below, #655), and the sidebar asks once with a card
  (*Trust this project? Trusting lets this project's apps run and its settings apply.*), not a modal
  dialog. It can be changed later from the project menu, or with "Trust this project" on an
  untrusted app. Trust follows the project, with no switch per app (owner, #1141), so the card lists
  what trusting covers: each of the project's apps (its root app and those in `.centralu/apps`) with
  its name, the first line of its description and what its manifest's `uses` declares, in plain words
  (`uses` is on the app list for this, a protocol addition), and says that the project's own root
  app then reaches the Assistant and other projects. A long list scrolls inside the card, and each
  description is shown whole. When the project has apps, the menu's "Trust this project…" opens that
  card instead of trusting at once, and so does every other "Trust this project…" (an untrusted app's
  screen, its row in Settings, the New app dialog), in place (`TrustCard`).
  The card, the project's row and a one-line notice above a session's composer also say what stays off until
  then: the project's `CLAUDE.md` and `AGENTS.md`, hooks and commands are ignored, its apps do not run, and its
  sessions cannot start agents or use worktrees unless they run under `auto` (#1512). The notice and the New session dialog's worktree option
  carry the same card, so the person can trust where they met the limit. A first worktree (nothing saved yet)
  offers the install command its lockfile names and the ignored `.env` files as chips that fill the setup fields.
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
  after the person has seen what it runs ([handing-over.md](handing-over.md)). A project app that arrives with `git pull` is
  governed by the project's trust above; it gets no second gate.

## Lifecycle

| | Rule | Why |
|---|---|---|
| Start | Lazily, the first time something needs the app: a tool list, a call, a screen. Discovery and the app list start nothing, except that a host starting resumes the apps that were busy (Busy, below) | Performance budget: five installed apps and nothing happening means zero app processes |
| One at a time | Concurrent needs share one start (five concurrent calls, one process) | Two processes would hold one data folder |
| Started means answering | Connected **and** `tools/list` answered. A server that stays up but fails every request is a failed start | Spike S-6: a broken server stayed alive, answered `-32603` to everything, and said nothing on stderr |
| Protocol era | Probed once per app (`server/discover`, falling back to the 2025-11-25 `initialize`), then remembered | The SDK's own probe starts the process twice |
| One instance | Per (project, app) | Worktrees share the root's app |
| Idle | No open view, no call in progress and no busy hold for 5 minutes: stopped | A process nobody calls has no reason to run. An open view holds its app |
| Busy | An app whose manifest declares `uses.background` may say it is busy with background work (`centralu.busy(reason)`, anywhere in the app, a timer included) and release it (`centralu.busy(false)`). While it holds, the idle rule leaves it running, as an open view does; on release the idle time starts. The hold belongs to the process that made it: a stop, a crash or a restart ends it, and a report from a process already replaced holds nothing. The app's sidebar row has a square Stop icon whose tooltip says "Running: <reason>" (the row writes no text for it, so the title keeps the row's width, #1928), and its row in Settings and its view have Stop too; Stop closes the view if one is open and stops the process (`apps.restart`), and the next need starts it again, and it may hold again. A hold also outlives the host: the apps holding busy are kept in `app-busy.json` in the data folder, and a host that starts (a restart, or the new one in a swap) starts them again 3 s after its first scan, with no call; each record is spent then, so an app with no work left goes on the idle rule. Releasing the hold, the person's Stop and a crash remove the record; an app that is gone, may not run, or no longer declares `uses.background` is not started (#1236) | Work that runs on its own clock (a merge queue landing pull requests overnight) stopped with the process when nobody looked at the app. The person sees what keeps it running and can stop it, and an app holds only what its manifest declares |
| Crash | Nothing restarts it by itself; the next need does, not earlier than 1 s, then 2 s after. The third consecutive failure stops the app (`failed`) with its reason, until Restart, `check`, a changed manifest, or its builder's turn ending with the folder changed ([build-loop.md](build-loop.md)). An app that ran 60 s before dying starts the count again | Retrying forever hides a broken app |
| Stop | stdin and fd 3 closed together; after 2 s the whole process tree is terminated (SIGTERM, then SIGKILL). The app's process group is signalled even after a clean exit. Windows has neither groups nor signals: the app is not started detached (that would give it no console, and every console program it starts a window of its own), and its tree is ended in one order: the process table is read, the app alone is ended, then what was under it, parents before children (`taskkill /T` only for a table that cannot be read, #14, #2141). Once the app has ended there, by itself or stopped, what it left running is found by parent links (Windows keeps an orphan's parent id; creation times rule out a reused number) and ended the same way: a Node app's plain children already die with it in libuv's job, but a Python app's children and `detached` ones do not | Spike S-5: closing stdin alone left Node and Python apps running. On Windows the first test run showed a `detached` helper outliving its app |
| Host shutdown | Every app stopped with a 1 s grace, without waiting for SIGKILL | Tauri gives the host 3 s |
| Manifest changed | A new entry replaces the old one; the old process stops **after its calls in progress finish**. While the app's builder is in a turn, the change waits for the turn's end ([build-loop.md](build-loop.md)); `check` reads it at once | Editing a file must not cut someone's call, and a half-edited manifest must not restart the app under the person |

The app's environment is the host's **minus** every `CC_*` and `CENTRALU_*` variable (the host's
WebSocket token is among them, and with it an app could call every RPC), plus the declared secrets,
`CENTRALU_APP_ID` and `CENTRALU_APP_DATA`. Its working directory is its folder.

Status in the list: `invalid`, `untrusted`, `unconfirmed` (an imported app the person has not
enabled, or whose `server` or `uses` changed since, [handing-over.md](handing-over.md)), `stopped`, `starting`, `running`,
`crashed` (the last start or run failed; the next need retries), `failed` (stopped after three).

## One call path

```
view (iframe) ─ apps.invoke ──────────────────────────────────┐
session agent ─ app-<id> proxy (Claude: in-process;           │
                Codex: stdio bridge) ─────────────────────────┼─▶ ExternalApps.call ─▶ app process
another app ─── broker on fd 3 (call_app, broker-and-rpcs.md) ─┘          │
                                                                          ├─ run record (app_runs)
                                                                          └─ "changed" to open views (views.md)
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
does not exist; the tool is not visible to that caller ([Tool visibility](#tool-visibility)). Otherwise the host starts the app if
needed and sends `tools/call` with the run id in `_meta["centralu/runId"]`. Outcomes: `ok`; `error`
(the app answered `isError`, could not start, or died during the call); `cancelled` (the caller
cancelled, and the app received `notifications/cancelled`); `rejected`. A call waits at most 10
minutes, counted again from each progress notification.

### Tool visibility

MCP Apps' `_meta.ui.visibility` says whom a tool is for: `model` (agents), `app` (the app's own
screen), or both, the default.

- A session's tool list shows only `model` tools. A view may call only `app` tools, and only **its
  own app's**: the app is fixed by the frame ([views.md](views.md#how-a-view-is-hosted)), never by the message.
- Hiding a tool from a list is not the same as refusing it when called by name. The call path checks
  both directions. A server cannot tell who called it (ext-apps #746), so the host enforces this.
- The host adds one read-only tool to every app attached to a session, `run_status` ([attaching.md](attaching.md#long-calls-and-cancellation)). An
  app's own tool of the same name is hidden behind it.

### Run records

Table `app_runs` (store v34): id, project, app, tool, caller kind, caller session, parent run,
status (`running`, then `ok`, `error`, `cancelled` or `rejected`), duration, time, error. Since v37
a row also has a kind, `tool` (a call to this app's tool) or `broker` (a request this app made
through the broker, [broker-and-rpcs.md](broker-and-rpcs.md#the-broker-agents-other-apps-host-data)), and the agent session a `run_agent` request started; since v38 the tokens
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
- **The record of a deleted app-agent session (#378)** is kept in `app_run_records` (what the session archive
  lists: app, session name, tool, status, duration, tokens, request, answer, output, times),
  `app_run_messages` (the whole conversation, tool calls and their results included, copied from
  `messages`; owner decision 2026-10-06) and `app_run_subagent_messages` (its subagents' steps, from
  `subagent_messages`), in one transaction before the session goes, checked by its row counts
  against the session's: a copy that is not whole keeps nothing, and the session stays. None points
  at `sessions`, and the project name is copied in, so a record outlives the session, its log line
  and the project. The person reads it in Settings → Archive, grouped by app, and deletes it there, one,
  an app's all, or with all archived sessions deleted; deleting it also clears the request, answer and output on
  its log line, which keeps status, time and tokens. Otherwise it goes with the log's 30 days. A
  record is the machine's its app ran on, as the run and the delete were: `trash.list` merges a
  linked machine's under its name, and `trash.readRun` and `trash.purgeRuns` go there by `machine`.
  `trash.empty` ("Delete all archived sessions…") leaves the records alone (the window deletes the ones it listed with
  `trash.purgeRuns`, one call per machine), so deleting them all across machines never takes records nobody
  was shown. An agent use count reads a row whose session is gone by its
  kept request, so a deleted session still counts as an agent started.
- Shown beside a pinned view (the Runs panel): time, tool, caller (with the session's name), status,
  duration, and the reason of a failure. Reading one app's runs returns its rows **and the chain
  under them** (the other apps it called, the requests it and they made), and the panel indents each
  row under the one that caused it, jumps to an agent's session ("Open session"), or says a deleted
  one's record is in Settings → Archive (#378), and re-reads
  whenever a row it shows begins, gets its agent session, or ends: the host announces that per app
  (`external_app_runs_changed`, coalesced like [views.md](views.md#keeping-open-views-current-centralu-extension)'s notification) for every row of the app and of
  the chain under it, a read-only tool's call and the agent run it asked for included. Open views do
  not hear it; they still get no "changed" for a read-only call ([views.md](views.md#keeping-open-views-current-centralu-extension)). Above the list: the answers the person gave to this app's
  capability questions (forgettable), and its agent use over the last day and 30 days (runs,
  duration, tokens).
