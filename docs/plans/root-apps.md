# Root apps: a project whose folder has `centralu.app.json` (#1141)

Owner's decision (2026-10-18, #1141): apps are added and listed like projects. A project is an app
when its folder has a Centralu app manifest at its root. This note fixes what the code does; the
step-by-step plan is the issue's. Apps inside a project (`<project>/.centralu/apps/<id>/`) do not
change.

## 1. Identity and keys

| | Rule |
|---|---|
| What makes it an app | `<project root>/centralu.app.json`, read by the project's own scan beside `.centralu/apps/*` |
| Ref | `{ projectId: <the project's id>, appId: <the manifest's id> }`, so the key is `<project id>/<manifest id>` (`appKeyOf`) |
| Folder-name rule | Not applied: the project's folder name is the person's, the manifest's `id` names the app |
| Marked as | `root: true` on `ExternalAppInfo` (protocol addition) |
| Invalid manifest | Listed `invalid` with its reason, under the manifest's `id` when that much reads, else `centralu-root` (an id no app can take, so it never meets a real app's state) |
| Same id as an app in `.centralu/apps/` | The inner app keeps it (it is unchanged by this issue); the root app is listed `invalid` and says why |
| Trust | The project's. Untrusted project: listed `untrusted`, never started |
| Process | Working directory, `dir` and the builder's cwd are the project root |
| Versions | A project in git: its git history (`git log` of the root). Otherwise kept copies, like a user-folder app's, under `<data>/app-versions/<project id>/<id>/` |

Everything kept per app follows that key, as for any project app: data
(`<data>/app-data/<project id>/<id>/`), logs, secrets, grants (`app_permissions`), runs, the builder
map, view origin port, grid panels, attachments. So the app's state belongs to the project: renaming
or moving the folder keeps it (the project keeps its id), and a new folder is a new project with
nothing inherited.

## 2. Adding and removing the manifest

- **Added** (by hand, by an agent, by `git pull`): the folder watcher that already watches the
  project root sees it, and the app appears without a restart. Nothing else about the project changes.
- **Removed**: the app leaves the list and its process stops, as when an inner app's folder goes.
  Its state is **kept** under the same key, so adding the manifest back (same id) brings back its data,
  secrets, grants, runs and builder.
- **Project deleted** (through the trash, as today): its apps' runs and grants go with the project
  (`deleteProject` already does this for every app of the project), and now its apps' **secrets** go
  too (§5). Data, logs and kept versions stay on disk, as they do for an inner app today.

## 3. Creating and importing

`apps.create` / `create_app` / New app with no project make a **new folder** `<parent>/<id>` (parent:
`~/Centralu` unless the person picks another, the same default and picker as a new project), write the
template there, register it as a project (trusted: Centralu made the folder, #655) and start its
builder in the project root. A project's "New app…" still makes an inner app. An import lands the
same way, in a new project folder under the parent; "Import and enable" registers it trusted,
"Import" untrusted (trusting the project is enabling it).

## 4. Existing user-folder apps

Each `<data>/apps/<id>/` with a manifest is **registered as a project in place** when the host starts
(and when a new one appears there, such as an approved MCP server), once. Its state is carried from
`_user/<id>` to `<new project id>/<id>`:

| Item | How |
|---|---|
| Data, logs, kept versions | Copied to the new key's folders; the `_user` copy stays |
| Secrets | Copied to the new key in `app-secrets.json`; the old entry stays |
| Grants | Rows copied to the new key, and `app:_user/<id>` grants other apps hold copied to `app:<project>/<id>` |
| Runs and kept failures | Moved to the project (`project_id` set) |
| Builder map, sessions | Map entry added; the app's sessions (builder, its agents) move into the project |
| Attachments (`session_apps:*`), grid panels, view origin port, the window's spans and open app | Rewritten or copied to the new key |
| Trust | Trusted, except an imported app the person never enabled (untrusted: trusting it is enabling it) |

The adopted folders are recorded (`apps.adoptedUserApps`, bound to the folder's inode), so a project
the person later deletes is not brought back at the next start.

**A previous build during a swap** (agent-host.md §5.1) still finds the folder in `<data>/apps/` and
keeps working on the `_user` copies, which this build leaves in place; it shows the app's sessions under
the new project and misses the runs moved to it. No table or column changes. Removing the `_user`
copies is a later release's step.

## 5. Which sessions get its tools

| Session | Root app |
|---|---|
| The orchestrator | Gets it, as it gets user-folder apps |
| Its own project's sessions | Get it (it is that project's app) |
| Another project's session | Attaches it through `find_apps` / `attach_app` without a share switch or consent card, as a user-folder app; named `<project>/<id>` |
| App-agent sessions | None, as before |

Its broker reach is a user-folder app's: `host_data sessions.list` sees every session, and other root
apps answer `call_app` by id after the caller's own project. `git.status` reads its project.

## Decisions

| Decision | Chosen | Alternatives, and why not |
|---|---|---|
| Key of a root app | `<project id>/<manifest id>` (the issue's proposal) | The folder path: lost on a move or rename. The manifest id alone: two projects' `notes` would share secrets |
| Root id taken by an inner app | Inner app wins, root listed `invalid` | Root wins: changes an existing app (#1141 says inner apps stay as they are) |
| State when the manifest goes | Kept | Deleted: an accidental `git checkout` would lose secrets and data |
| Secrets and grants when an app's project is deleted (the open point from #1140) | **Forgotten** with the project: grants already were, secrets now too. A project id is never reused, so nothing could read them again | Kept: they would sit in `app-secrets.json` forever, readable by nobody but a person opening the file |
| Migration: move or copy | Copy files and secrets, copy grants, move runs and sessions | Move everything: a previous build serving after a failed swap would lose the app's data. Copy runs: run ids are keys, chains would need renumbering |
| Approved MCP servers | Become root apps too, in place | Stay hidden user-folder apps: two kinds of app again, and Settings would be the only place to find them |
| Imported apps | Project trust replaces the import mark (enabled = trusted) | Keep the per-app review on `server`/`uses` changes: a second gate a project app does not have; capability questions still ask before any broker use |
| Versions of a root app | git when the project is a repository, kept copies otherwise | Always copies: a large repository would be copied on every start |
| A root app's reach | A user-folder app's (orchestrator, attach without consent, every session in `host_data`) | A project app's: migrated apps would lose what they did yesterday |
| Where the note lives | `docs/plans/` (a record, English only) and the parts that last in `apps.md` / `domain-model.md` | A new design document: most of it is a one-time migration |

## Not handled yet

- **Linked machines.** A linked machine running this build adopts its own user-folder apps and lists
  them as its projects' root apps, which the hub shows like its own. A machine on an older build still
  sends user-folder apps: the hub lists them in the sidebar's leftover "Other apps" list (only shown
  when there is one), with no New app or Import there. New app and Import make the folder on this
  computer only.
- The `_user` copies the migration leaves are not removed yet.
