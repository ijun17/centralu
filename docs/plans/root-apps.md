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
| Versions | A project in git: its git history (`git log` of the root). Otherwise kept copies, like a user-folder app's, under `<data>/app-versions/<project id>/<id>/`. Restoring one copies its files back and **deletes nothing**: the app's folder is the person's whole project. A restore is refused when the copy of the current files it takes first could not be made |

Everything kept per app follows that key, as for any project app: data
(`<data>/app-data/<project id>/<id>/`), logs, secrets, grants (`app_permissions`), runs, the builder
map, view origin port, grid panels, attachments. So the app's state belongs to the project: renaming
or moving the folder keeps it (the project keeps its id), and a new folder is a new project with
nothing inherited.

## 2. Adding and removing the manifest

- **Added** (by hand, by an agent, by `git pull`): the folder watcher that already watches the
  project root sees it, and the app appears without a restart. Nothing else about the project changes.
  In a project already trusted, an app it did not have (a manifest a `git pull` brought, root or inside)
  is trusted with the project, as the owner decided; the inbox says so once, with its name and what it
  declares it may ask for, so the person sees what their trust now covers.
- **Removed**: the app leaves the list and its process stops, as when an inner app's folder goes.
  Its state is **kept** under the same key, so adding the manifest back (same id) brings back its data,
  secrets, grants, runs and builder.
- **Project deleted** (through the trash, as today): its apps' runs and grants go with the project
  (`deleteProject` already does this for every app of the project), and now its apps' **secrets** go
  too (§5). Data, logs and kept versions stay on disk, as they do for an inner app today.
  A project that was a user-folder app gives its folder back once nothing in the trash can restore the
  project (#1204): the folder to `<data>/app-trash/`, its data, logs and kept versions back to `_user/<id>`,
  where what the old key held goes beside the folder (`<data>/app-trash/<id>-<ms>-user-data/`), never deleted: a
  previous build serving after a rollback writes there only (§4).

## 3. Creating and importing

`apps.create` / `create_app` / New app with no project make a **new folder** `<parent>/<id>` (parent:
`~/Centralu` unless the person picks another, the same default and picker as a new project), write the
template there, register it as a project (trusted: Centralu made the folder, #655) and start its
builder in the project root. A project's "New app…" still makes an inner app. An import lands the
same way, in a new project folder under the parent; "Import and enable" registers it trusted,
"Import" untrusted (trusting the project is enabling it).


## 4. Existing user-folder apps

Each `<data>/apps/<id>/` with a valid manifest whose id is its folder's name (the rule a user-folder
app has today) is **registered as a project in place**, once. It runs once
the host is **ready**, where the steps a swap left for later run (`runDeferred`): a host that fails
before ready hands back to the previous build without having moved anything, so the copies below are
taken from what that build last wrote. Sessions the manager already holds are moved with it and
announced, so the builder is found under the new key in the same run. A folder whose manifest is
invalid, or names another id (a backup copy such as `notes-copy`), is not adopted: it stays in the user
folder, listed with its reason, as today, and the log says so. One that appears later (an approved
MCP server) follows while the host runs. Its state is carried from `_user/<id>` to
`<new project id>/<id>`:

| Item | How |
|---|---|
| Data, logs, kept versions | Copied to the new key's folders; the `_user` copy stays |
| Secrets | Copied to the new key in `app-secrets.json`; the old entry stays |
| Grants | Rows copied to the new key, and `app:_user/<id>` grants other apps hold copied to `app:<project>/<id>` |
| Runs and kept failures | Moved to the project (`project_id` set) |
| Builder map, sessions | Map entry added; the app's sessions (builder, its agents) move into the project |
| Attachments (`session_apps:*`), grid panels, view origin port, the window's spans and open app | Rewritten or copied to the new key |
| Trust | Trusted, except an imported app the person never enabled (untrusted: trusting it is enabling it) |

The adopted folders are recorded (`apps.adoptedUserApps`, bound to a random mark written in the folder,
`.centralu/adopted`), so a project the person later deletes is not brought back at the next start, and a
different folder made later under the same name is adopted. Not the folder's inode: ext4 gives a folder
made where one was just removed the same inode and the same birth time (a coarse clock), which #1152's
full tier on Linux showed.

**The old key is an alias.** A request by `user/<id>` (an older window, a stored name, a script, the keeper's
drain check) resolves to the project's root app (`ExternalApps.resolve`), with its trust and rules, while
the user folder has no app of that id and the project still exists; it answered "no such app" before.

**A previous build during a swap** (agent-host.md §5.1) still finds the folder in `<data>/apps/` and
keeps working on the `_user` copies, which this build leaves in place; it shows the app's sessions under
the new project and misses the runs moved to it. No table or column changes. Removing the `_user`
copies is a later release's step.

## 5. Which sessions get its tools

**Trust follows the project** (owner, 2026-10-18, on review): a root app has no switch of its own,
no share switch either. Its project's trust decides whether it runs and whether it reaches beyond its
project; the project's trust card and its menu row say how many apps the project has and that they
may reach other projects. Capability grants stay as they are (#1173 folds them in later).

| Session | Root app of a trusted project |
|---|---|
| The orchestrator | Gets it, as it gets user-folder apps |
| Its own project's sessions | Get it (it is that project's app) |
| Another project's session | Attaches it through `find_apps` / `attach_app` without a consent card, as a user-folder app; named `<project>/<id>`, or its bare id when one project has it |
| App-agent sessions | None, as before |

**An untrusted project's apps attach nowhere** (owner, on the second review): its root app and the
apps inside it alike, to no session, its own project's included, and under `auto` too; #603's opening
of an untrusted project's apps to an `auto` session no longer applies to apps. The project's sessions
still run and may still read its code. Apps inside a project (`.centralu/apps`) keep their share
switch and the pair consent for reaching other projects.

**Names are stable.** A session's agent calls an app by its server name (`app-<id>`), and a Codex
thread keeps the names it started with. Once a session has seen a name, it stays bound to the same app
for that session's life, kept with the session (`session_app_names:<session>`); a later app with the
same id gets a name qualified by its project (`app-<id>-<project>`), never the name another app held,
one gone for the moment included, and `attach_app` keeps to the same book. A name is never longer than
`app-<id>` of the longest id, so a tool keeps the room it has under a plain name (64 characters in all).

Its broker: `call_app` reaches another trusted project's root app by id after the caller's own project
and the user folder, when exactly one has it. `host_data sessions.list` answers its own project's
sessions, as for any project app and as the permission card says; `git.status` reads its project.

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
| A root app's reach | A user-folder app's (orchestrator, attach without a card) while its project is trusted; the trust card lists the project's apps (owner) | A per-app switch ("Share", then "Trust this app"): a second decision about the same code, which the owner ruled out. Never: migrated apps would lose what they did yesterday |
| An untrusted project's apps under `auto` | Attach nowhere, its own project's sessions included (owner) | #603's opening for `auto` sessions: an app is code that runs, which reading code is not |
| An app a trusted project gains later | Trusted with the project; the inbox says so once (owner) | A card per new app: a second decision about the same project |
| Two apps with one id in a session | The name a session has seen stays with its app; a later one is `app-<id>-<project>` | Naming by sort order: a new app could take a name the orchestrator already calls, and its calls would go to the other app |
| `host_data sessions.list` of a root app | Its project's sessions, as the permission card says | Every session: the card would have to say so, and a repository's app would read every project's session names |
| Restoring a root app's version outside git | Copies the version back, deletes nothing, refused if the copy taken first failed | As a user-folder app (deletes what the version lacks): the folder is the person's whole project |
| When user-folder apps move | After the host is ready, sessions moved live | At start: a host failing before ready leaves the previous build serving on old copies, marked done |
| A folder named apart from its manifest id | Not adopted, stays listed with its reason | Adopted: two folders with one id (a backup copy) would both become runnable |
| Where the note lives | `docs/plans/` (a record, English only) and the parts that last in `apps.md` / `domain-model.md` | A new design document: most of it is a one-time migration |

## Not handled yet

- **Linked machines.** A linked machine running this build adopts its own user-folder apps and lists
  them as its projects' root apps, which the hub shows like its own. A machine on an older build still
  sends user-folder apps: the hub lists them in the sidebar's leftover "Other apps" list (only shown
  when there is one), with no New app or Import there. New app and Import make the folder on this
  computer only.
- The `_user` copies the migration leaves are not removed yet.
