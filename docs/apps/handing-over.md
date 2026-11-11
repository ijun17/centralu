# Handing apps over: import, versions, links

Plan section E, the local half (decision 9): an app can be brought in from a folder, a zip or a
link, and an app outside git keeps versions to go back to. Sharing through a team server is the
next plan. Code: `apps/external/handover.ts` (staging, confirmation, versions), `imports.ts` and
`zip.ts` (reading a source), `import-book.ts` (the marks), `versions.ts`; UI
`features/app-share/`.

## Import (E-3)

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
decimal string `inoExact`; every host a store is still shared with compares it first. A record
from before it (#562) has only the numeric `ino`: legacy numeric ids below 2^53 still match exactly;
unsafe numeric ids retain the import mark but are treated as unconfirmed. Lookups do not change
stored records. Importing or confirming writes `inoExact` alone, upgrading a legacy record to the
exact id when the person reviews it again.
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

## Versions (E-1)

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
it ([views.md](views.md#keeping-open-views-current-centralu-extension)). An imported app restored to a version with a different `server` or `uses` is asked about
again ([Import](#import-e-3)). Project apps are refused.

## App links (E-4)

`centralu://app?url=<url>` opens the import dialog of [Import](#import-e-3) with the source filled in and a line
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
