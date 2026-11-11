# Imported apps and app links

An app imported from a folder, a zip or an https link (plan E-3, [apps/handing-over.md](../apps/handing-over.md)) is someone
else's code that will run as the user. It gets its own confirmation, separate from project trust.

- **Nothing runs before the person has seen what runs.** The source is copied into a staging folder
  the discovery never scans, and the review (the command and its arguments, what `uses` declares,
  the secrets it wants, every file) is shown before anything is in. An imported app arrives turned
  off (`unconfirmed`): it never starts, is never attached to a session, every call is refused, and
  no builder session is made for it. The runtime checks this at every call, start, `check` and
  status, not only when it is listed (`runtime.ts` `held`; `imports.test.ts` "an app brought in
  shows unconfirmed with a reason, calling it is refused and no process starts — enabling it
  starts it"; `session-apps.test.ts` "an imported app does not attach to the Assistant before
  the person turns it on, calling it by name is refused, and turning it on attaches it (M4
  E-3)").
- **The confirmation is held by the host and bound to what was seen.** It lives in
  `app-imports.json` (0600) in the data folder, not in the app folder, so neither the app's code nor
  an archive can supply it. It is bound to the folder's exact file id (bigint stat, persisted as
  the decimal string `inoExact`), which every host the store is still shared with compares first; a
  record from before it (#562) has only a numeric `ino`, no longer written. Legacy numeric ids below 2^53 still match exactly; unsafe numeric ids keep their
  import mark but require fresh review. A folder that is not the one marked (recreated under the id
  outside Centralu, or unreadable) also keeps the import mark and is unconfirmed until reviewed (#838):
  it used to read as no mark, which the gate takes for the person's own app, so replacing an enabled
  import's folder ran whatever the new one held. Removing the app through Centralu still forgets the
  mark. The mark is written before the folder is moved in, so a failed write brings nothing in.
  Lookups are read-only; importing or confirming explicitly
  writes both fields. The mark records a hash of the manifest's `server` and `uses`. Enabling sends
  back the key of the review the person saw, and the host
  compares it with the manifest at that moment, so what was reviewed is what is enabled. A later
  change to `server` or `uses` (an editor, the builder, a restored version) asks again
  (`import-book.ts`, `handover.ts`; "a changed command blocks calls, and the confirmation dialog
  states what changed alongside the command it was enabled with — enabling with the new key runs
  it again", "if it changed after the confirmation dialog was seen, that dialog's key no longer
  enables it").
- **Reading the source.** Links inside a folder are not followed: one pointing outside refuses the
  import, one pointing inside is not copied. Files are opened without following a final link, after
  the path guard has checked the parents. Zip entries are judged before anything is written: no
  `..`, absolute paths, drive letters, backslashes, empty segments or control characters (zip
  slip), no link entry leaving the archive, no entry inflating past its declared size (inflation
  stops there), matching checksums, no names that collide on a case-insensitive disk, no
  encrypted, split or ZIP64 archives. There are caps on files (2,000), bytes (64 MiB, 16 MiB per
  file), depth (16) and the archive (32 MiB). Every file is written under a path built from checked
  segments and checked again to be inside the staging folder. A file is written 0644, or 0755 when its source (a
  folder's file, or a zip entry made on Unix) has any executable bit; no other mode bit (setuid) is carried over
  (`execBits`) (`imports.ts`, `zip.ts`;
  `imports.test.ts` "a zip cannot write outside (zip slip)", "a link inside the folder that points
  outside is refused (stating what it points at), and a link pointing inside is never moved",
  "caps: file count, one file, the total, depth, archive size", "a file stays executable whether the app came as a
  folder or as a zip").
- **Dot-names are not copied.** A user-folder app's builder works in the app folder and reads the
  settings there (decision 3 trusts that folder), so `.claude/` or `.codex/` inside an archive
  would be hooks and settings nobody confirmed. `.git`, `.env` and the rest are left out too.
- **Downloads.** Only `https:`; no user or password in the URL; loopback, link-local (cloud
  metadata lives there) and unspecified hosts are refused. Redirects are followed by hand, at most
  five, and every target is checked again, so an https link cannot bounce to http or to this
  machine. The body is capped by its declared length and again while it streams; it goes to a
  temporary folder that is removed afterwards, and the result is judged like a local zip.
- **App links** (`centralu://app?url=…`, E-4) are text someone else wrote. The macOS shell accepts
  only the `centralu` scheme under a length cap, a few at a time, and passes them to the page,
  which accepts only `centralu://app` with one `url` that is https or a file of this machine
  (`parseAppLink`). A link only fills in the import dialog: nothing is read or downloaded until the
  person presses Review, and then the host judges the source again with its own rules. The shell
  receives links through the platform's open event rather than the deep-link plugin, which would
  open more commands to the page; the one command added, `take_app_links`, is granted like the
  others (next sections).

Limits:

- The confirmation covers what an app runs and what it may ask Centralu for, not its code. Once
  enabled, an app's code can change without asking again, as a user-folder app's can; that is what
  enabling means.
- An https host given by name is not resolved and checked: a name that resolves to a private
  address is fetched. The request happens only after the person presses Review on that address.
- Hardlinks in a source folder are copied as the files they are; pathname checks cannot tell where
  an inode came from (the same limit as "Project files and native handoff"). Same-user races
  between checking a file and opening it remain.
- If `app-imports.json` cannot be read, the marks cannot be used, and the file is also the only
  record of which apps were imported (#1172). When it is gone and a moved-aside copy
  (`app-imports.json.unreadable-<ms>`) is in the data folder, every app then in the user folder, the
  person's own apps too, gets a mark (`lost`) in a new file written at once, and asks once before it
  runs again, with a reason naming both files: an app asks once more rather than running unasked. The
  new file is the record from then on, so an app made later is not held and removing the copy is
  safe; a mended copy put back is read as soon as the file changes. The new file goes in place by a
  hard link, which never replaces a file: one put back, or written by the other host of a swap, in
  the moment before wins. While the file cannot be read at all, the data folder cannot be listed, or
  the new file cannot be written (a data folder on a disk without hard links), every app without a
  mark is held instead (`ImportBook.doubt`), tried again once a second. The host logs it
  (`imports.test.ts` "a marks file that cannot be read holds the apps instead of running them").
- **Only the apps in the user folder at that moment are held.** An import whose folder is not there
  when the loss is found (moved out of the user folder for a while, or the whole `apps` folder
  missing) gets no `lost` mark, and runs as the person's own when it comes back.
- **An older build ignores the copy.** A build before #1172 (a rollback, or the older host still
  serving during a swap) reads a missing `app-imports.json` as no imports and runs every imported app
  unasked, as it always did. Once this build has written the file of `lost` marks, an older build
  reads them as imports not yet enabled and holds those apps too. A file an older build writes in
  the meantime, from its empty view of the marks, is taken as the record.
- An unreadable `app-secrets.json` is moved aside the same way, and its values stay in the
  moved-aside copy. For both files, only a file that
  does not parse, or parses to the wrong shape, is moved aside; one that cannot be read at all (no
  permission, too many open files, held by a scan on Windows) is left in place, reads as empty, and
  writes to it are refused until a read succeeds, as they are while a damaged file cannot be moved.
  Temp files a crashed write left (they can hold values) are removed at start when their writer's pid
  is gone or they are over a minute old (`private-json-file.ts`; `private-json-file.test.ts`).
- App links have been exercised by hand on a built app, not in CI, and are received on macOS only.
