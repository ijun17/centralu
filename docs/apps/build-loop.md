# The build loop

The first promise of apps is that the place a tool is built is the place it is used and changed.
The host side exists (#155), and so does the UI side: New app, the "fix it here" bar under a view,
and "Send to builder".

- **Making an app**: the Assistant's `create_app` and the RPC `apps.create` (the New app button's
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
  The builder works in that project, at its root. The Assistant's `create_app` without `project`
  raises create_project's card for the folder first, since it is the one thing it makes outside a
  project.
- **New app** (the UI's door to the same function): "New app…" in each project's menu, and the app
  button beside Add project over the sidebar's project list, for an app that is a project
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
  Preset `auto`, the default every new session gets (owner decision 2026-11-05; `normal` before). Tool: the project's default, or the Assistant's for a user-folder app. It is
  attached to its own app's tools, and gets one more tool, `check`. Carrying Centralu's own tools
  does not change which files it reads (#152): like any other session of its project, a Claude
  builder in a trusted project loads the project's `.claude/` and `CLAUDE.md` and the person's
  `~/.claude`, a global bypass included, and a Codex builder reads `AGENTS.md`. Once the project's
  trust is withdrawn, it reads only the person's own settings from its next start. A user-folder
  app's builder counts as trusted, since that folder is the person's own (decision 3). Only the
  assistant and coordinators read no settings files; under `normal` they still follow the person's
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
  the new code ([views.md](views.md#keeping-open-views-current-centralu-extension)).
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
  how the screen hears of a read-only tool's failure: reads send no "changed" ([views.md](views.md#keeping-open-views-current-centralu-extension)). A tool call
  that failed because the person denied a capability somewhere in its chain (a Deny, or a denial
  kept from before, [broker-and-rpcs.md](broker-and-rpcs.md#the-broker-agents-other-apps-host-data)) is not an app bug: its bundle carries that decision (`denied`: which app,
  what it asked for), the view says the person did not allow it and points to Runs, Permissions,
  Forget, with no stack and no "Send to builder", and `apps.sendError` refuses it. A call from
  another app that failed for that reason carries the same decision.
