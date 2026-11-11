# What an app is

```
<app folder>/                       code; a project app is committed with the repository
  centralu.app.json                 manifest: the file that makes the folder an app
  server.mjs                        MCP server over stdio (any command is accepted)
  ui/index.html                     screens, served by the server as ui:// resources
  AGENTS.md, CLAUDE.md, runtime/    from the template (build-loop.md), not required

<data folder>/app-data/<project id | _user>/<app id>/    the app's data, outside the repository
```

The folder name is the app's id. An app is identified by (project, id): two projects may each have
a `notes` app, and they are two apps.

A **root app** (#1141) is a registered project whose own root holds the manifest: the project is the
app. Its folder is the project's, named as the person likes, so its id is the manifest's `id`, not the
folder name; it is still identified by (project, id), and its data, secrets, grants and runs are kept
under that key. The design and the reasons: [plans/root-apps.md](../plans/root-apps.md).

## The manifest, `centralu.app.json`

One zod schema (`manifest.ts`) judges it, for discovery, `create_app` and `check` alike.

| Field | Meaning | Rule |
|---|---|---|
| `manifestVersion` | Manifest format | Must be `1`. Anything else is refused with "update Centralu": guessing at a format we do not know would run a changed field with its old meaning |
| `id` | App id | Equal to the folder name (a root app's is the manifest's own, [What an app is](#what-an-app-is)). `^[a-z0-9][a-z0-9-]{0,31}$`, not starting with `centralu`, not a reserved id (`RESERVED_APP_IDS`: `control`, the removed control app's, #372) (#93: with no underscore, an app cannot forge the `__` separator of `mcp__app-<id>__<tool>`) |
| `name`, `version`, `description` | What people and agents read | Not empty; at most 80, 64 and 2000 characters |
| `server.command`, `server.args` | How to start the server | Run with the app folder as the working directory |
| `home` | The tool that opens the pinned view ([views.md](views.md#pinned-in-the-main-area-centralus-way-within-the-standard)) | Optional. Must be a tool with a `ui://` view that the view may call; `check` reports it otherwise |
| `uses.agent`, `uses.apps`, `uses.host` | What the app **declares** it will ask Centralu for ([broker-and-rpcs.md](broker-and-rpcs.md#the-broker-agents-other-apps-host-data)) | Optional. A declaration, not a permission. Absent means nothing |
| `uses.notices` | `true`: the app may post notices into a session that called it ([broker-and-rpcs.md](broker-and-rpcs.md#the-broker-agents-other-apps-host-data), `notify`) | Optional. In `uses`, as above |
| `uses.background` | What the app does in the background, in words the person reads ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#lifecycle), "Busy") | Optional, 1 to 200 characters. Without it the app cannot keep itself running. In `uses`, so an imported app adding it is reviewed again ([handing-over.md](handing-over.md)) and the trust card lists it |
| `secrets` | Names of the secrets the app needs | Optional. Environment-variable names; `CENTRALU_*` and `CC_*` are reserved |
| `view.origin` | `opaque` (default) or `app` ([views.md](views.md#how-a-view-is-hosted)) | An unknown value is refused, not read as the default |
| `view.span` | The span, in grid cells, the app **recommends** for its panel on the grid ([views.md](views.md#pinned-in-the-main-area-centralus-way-within-the-standard)): `{ "cols": 2, "rows": 1 }` | Optional, and only a default: the person's choice for the placement and their setting for the app come first. Each side 1 to 4; a whole number outside is clamped, anything else ignored — both with a warning, never an error, since an app without one simply stands at 1 × 1 |
| `csp` | Four lists of domains | Validated, but **not read**: a view's CSP comes from its resource's `_meta.ui.csp` ([views.md](views.md#how-a-view-is-hosted)) |

Unknown fields are warnings, not errors, so an older Centralu reads what it knows from a newer
manifest. A change of meaning goes through `manifestVersion`, never through a new field. A manifest
over 64 KiB is not read.

Tool names come from the running server, not from the manifest. A tool whose name contains `__`, or
whose `_meta.ui.visibility` is malformed, is dropped from the app's list with a warning. A malformed
visibility is not read as the default: the side that is wrong stays closed.

## Where apps live

| | Folder | Whose tools | Removing it |
|---|---|---|---|
| Project app | `<project>/.centralu/apps/<id>/`: committed with the repository, so it is shared with the team once pushed | The project's sessions, if the project is trusted ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#trust) and [attaching.md](attaching.md)); another project's session that attaches it, if the person shares it ([other-projects-apps.md](other-projects-apps.md)) | Through git. Centralu has no button for it |
| Root app | `<project>/centralu.app.json`: the project is the app (#1141) | Its project's sessions, if the project is trusted ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#trust) and [attaching.md](attaching.md)); the Assistant and another project's session that attach it ([other-projects-apps.md](other-projects-apps.md)) | Remove the manifest: the app goes, and what is kept under its key (data, secrets, grants, runs, builder) stays for when the manifest comes back. Deleting the project takes its runs, grants and secrets with it |
| User-folder app | `<data folder>/apps/<id>/` (`~/.centralu/`, or `~/.centralu-dev/` in development): for apps used across projects, and apps imported from elsewhere ([handing-over.md](handing-over.md)) | The Assistant; a project's session that attaches it ([other-projects-apps.md](other-projects-apps.md)) | Settings > Apps, after one confirmation. A running app is stopped, and waited for, before its folder moves to `<data folder>/app-trash/` (Windows will not move a folder a process is working in, #14); runs, data, secrets and kept versions stay, an imported app's mark goes |

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
  build during a swap (`user-app-adoption.ts`, [plans/root-apps.md](../plans/root-apps.md) §4). One that
  appears later, such as an approved MCP server, is registered the same way while the host runs.
  **The old key still reaches it:** a call or any other request by `user/<id>` (an older window during
  a swap, a stored name, a script) resolves to the project's root app (`ExternalApps.resolve`, which
  every runtime method taking a key reads first), with that app's trust and rules, while the user
  folder has no app of that id and the project still exists.
  **A deleted project gives the folder back** (#1204): while a session of the project is in the session archive
  the folder stays where it is, adopted, since restoring one registers the project again at that path.
  Once none is (the project had none, or the archive lost them for good), its folder goes to
  `<data folder>/app-trash/` as a removed user-folder app's does, the data, logs and kept versions it
  kept under `<project id>/<id>` go back to `_user/<id>`, and the record goes. **Nothing `_user/<id>`
  already held is deleted**: it can be the only copy of something (a previous build serving after a
  rollback writes there only), so it goes beside the folder, to `<data folder>/app-trash/<id>-<ms>-user-data/`,
  where no sweep looks, before the project's copy takes its place. Its secrets and grants are not
  returned: they went with the project, and the folder put back gets what `_user/<id>` still holds.
  Moving the folder back into the user folder makes it a new project, with its data. Nothing moves
  while a project is registered at that folder (the person added it again, in any spelling, or through
  a link, a junction or a `subst` drive: real paths are compared; or inside the folder) or a session in
  the session archive names it, nor while a project's path cannot be resolved (a drive that is not there now, a
  link loop, no access, or a UNC path, which is never resolved). Such a project holds every give-back
  until it resolves or goes; a mapped drive letter is resolved, and a dead server can make that slow. Only
  the folder that carries the adoption's mark moves: another folder of that name, and what is kept for
  it, is never touched.
  Checked at each start once the host is ready, after a project is deleted, and after the session archive is
  emptied or loses a session; a move that fails (a folder in use on Windows) is tried again a few
  times, then at the next start.
  The host marks such a project, and one added again at its folder by its spelling alone (`ProjectInfo.fromUserFolder`, only
  ever `true`, absent from a host before #1301), and the Delete project dialog asks the host once when it opens
  (`projects.deleteOutlook`, `UserAppAdoption.outlook`): by real paths, as the give-back compares them, so a re-add through a
  junction, a link or a `subst` drive counts; a UNC or unresolvable path is `unsure` (the give-back counts it as at the folder;
  the dialog says it could not check where the folder is); a project inside an app folder whose own project is gone is told that
  the folder around it may move. Resolved off the event loop and within 2 s per path. The dialog shows "Checking what happens to
  the folder…" and offers no Delete until the answer comes (3 s at most, then the mark decides). The dialog says the host **may** move the
  folder, when (no session that could bring the project back left in the archive, no other project at the folder), where to, that nothing is deleted and
  what putting it back is; a host without the call leaves the mark deciding, and a project that stays keeps "The folder on disk
  is left alone." (`features/project/deleteNote.ts`).
- An MCP server approved through `propose_mcp_server` becomes a **user-folder app with no screen**
  (a manifest only). Its calls go through the same path as every app's, are recorded, and can be
  removed. Servers approved earlier are moved over when the host starts; moving them again changes
  nothing (#152).
- The proposal itself waits in `orchestrator_mcp_proposals` until the person answers. Every change to
  that list (and to the skill proposal list) is announced by the host with
  `orchestrator_proposals_changed`, sent after the write, and the screen re-reads on it: not on the
  Assistant's `tool_call`, which arrives before anything is saved (#703). A pending proposal
  counts as waiting on the person: the Assistant's sidebar row, the top-bar count, the waiting
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
