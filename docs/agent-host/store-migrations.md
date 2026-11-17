# dev-services (despite the name, this is the prod path — corrected 2026-08-15)

When the Node sidecar became the deployment path in M1.5, the plan to "move it to Rust at Tauri step 4 and delete it"
was **put on hold**. This directory is used as is in prod today. The name is a historical remnant.

- **git**: spawn the `git` CLI + parse `--porcelain=v2/-z`. status·diff·log·branches·checkout·stage·commit·push.
  Moving to git2 (Rust) **is not done until measurement confirms a bottleneck** (m2-plan decision 3).
  The port interface is the same, so moving it later leaves the UI unchanged.
- **store**: better-sqlite3 + a `user_version` migration runner. `Store` (`store.ts`) opens the file and runs the
  migrations through the two classes it extends: the runner (`store/migrate-runner.ts`) and, below it, the min-reader version gate (`store/reader-gate.ts`); an owed `VACUUM` is
  `store/vacuum.ts`. The records are one module per concept in `dev-services/store/` (projects, sessions, messages,
  the session archive, app runs, …), held as fields that callers name (`store.projects.listProjects()`), and the step list is in
  `store/migrations/`. The schema DDL lives in exactly one place,
  `protocol/src/schema/schema.sql`. In the bundle it is copied next to the build output and ships with it (F-0).
  The rule for migration steps is below ([Migration steps: expand, then contract](#migration-steps-expand-then-contract-292)).
- **fs**: lazy readdir listing + `git check-ignore` (once per directory) + path escape blocking.
- **attachments**: saves pasted images to `~/.centralu/attachments/<sessionId>/`.
- The `--dev-services` flag **does not exist** (the document got ahead of itself). Everything is always loaded.

## Migration steps: expand, then contract (#292)

Two builds meet one `store.db` more often than it looks: a person goes back to an older release, and a host swap
(#280) keeps the previous host serving while the next one starts, and hands back to it if the next one fails. Until
#292 nothing stopped an older host from opening a newer store. It skipped every step it did not know and failed only
when it touched something a later step had dropped. Measured on 2026-10-04: of the first 40 steps (v2–v41, seven
weeks), v28 (`sessions.archived` dropped) and v32 (`projects.default_model` / `default_effort` dropped) broke the
build before them outright, and v13 (the grid's old-named table dropped) made it silently lose every grid placement, because the
older `schema.sql` recreated the table empty.

The rule, written above the step list in `dev-services/store/migrations/index.ts` (`migrationSteps`), which a reviewer checks every new
step against:

1. **Expand.** A step may add tables, nullable or defaulted columns and indexes, or rewrite data into a form the
   previous build still reads. It declares `breaksOlderReaders: false`.
2. **Contract, one release later.** A step that drops or renames a table, column or index, or leaves data an older
   build cannot read or would silently lose, lands one release after the code stopped reading and writing what it
   removes, and declares `breaksOlderReaders: true`. Dropping something an older `schema.sql` creates counts (v13).
   A rename is both: an expand step adds the new form, and the build that adds it writes both forms and reads only the
   old one, since the previous build writes and deletes only that one (a person who goes back and forward leaves the
   new form stale). Only a build whose floor keeps out every build writing the old form alone may read the new form first
   ([plans/assistant-rename.md](../plans/assistant-rename.md) §3.1, §3.2, #2133).
3. **The store records the lowest schema version that can still read it:** the `min_reader_version` row in
   `app_settings`. A breaking step raises it to its own version before it runs, or to the lower version it names
   (`minReader`, v69: 68) when the builds from that version on already write everything it relies on. A store from before #292 gets it
   computed once from the steps it has already run (32 for every store migrated to date). On open, before `schema.sql`
   or any step touches the file, a host whose newest step is below the record refuses to start: "This data was
   written by a newer Centralu", naming both versions, on stderr and stdout, exit 1, the same path as a lock conflict.
   The desktop supervisor shows it at once instead of retrying. A host older than the store but at or above the
   record opens it and runs no step it does not know. A record that is not a version (a hand edit, a write cut short)
   is worked out again, and said, by a host that knows every step the store has run; a host older than the store
   refuses the same way, naming the row, since a floor worked out from fewer steps could open what it cannot read
   (#384).
4. **Heavy steps are marked `heavy: true`:** a step that rewrites or re-indexes every message, or `VACUUM`s (v3, v11,
   v21, v40 so far; v40 held the start for 1.9s on 137,722 messages). The start says in host.log that it migrated
   and how long it took.
5. **What a swap left (#280 step 3, gone since #1895 step 4 PR 5).** A host of an earlier build that took over in a
   swap ran the expand steps and left every heavy or breaking step for after it, with `user_version` already past
   them and `app_settings.deferred_migrations` listing what was owed; one that died first left the list behind. This
   build writes no such list, and an open that finds one runs those steps in their place in the order and crosses
   each off in its own commit (`store-migrations.test.ts`). So a step that was ever left that way must be correct
   when it runs after later steps.
6. **A step commits as one unit with the record that it ran (#396):** its statements, the `min_reader_version` raise
   and the `user_version` bump (with the `deferred_migrations` list shortened when a step a swap left for later runs)
   go in one transaction.
   Each statement used to commit on its own, so a start killed between two `ALTER`s of v12 or v17 left the first
   column, and the next start, finding it, skipped the rest of the step for good. `VACUUM` cannot run in a
   transaction, so a step queues it for after its commit and records in that commit that it is owed (a `vacuum_owed`
   row in `app_settings`, deleted once the vacuum has run or failed; `vacuumAfterStep`). A host stopped during the
   vacuum leaves the row, and the next open vacuums. v10 switches `foreign_keys`,
   which SQLite ignores inside a transaction, and commits on its own (`ownTransaction`), as one unit by itself.
7. **The store is copied before a breaking step runs (#2304).** A store step is the one change a person cannot undo
   by installing the previous build: the reader gate (rule 3) refuses it, and what the step removed is gone. So before
   the first step of an open that declares `breaksOlderReaders: true`, the runner writes one copy of the store beside
   it, `store.before-<step>.db` (`StoreCopies` in `dev-services/store/store-copy.ts`), and
   [Getting the copy back](#getting-the-copy-back) says how a person uses it. Nothing reads the copy by itself.
   - **What makes the copy is `breaksOlderReaders: true` and nothing else.** A step that deletes a person's data
     declares it, also when every older build would still read what is left. There is no separate "drops data" field:
     no step would set it today, and a field nothing sets is a branch nobody runs. A step that must delete without
     breaking adds its own trigger to `MigrationStep` in the pull request that adds the step.
   - **One copy an open, and a later copy keeps the earlier ones.** A store that crosses several breaking steps in
     one open keeps the copy from before the first: that is the store the build the person had could read. A new
     store (version 0) and a store in memory get none. An open that copies again deletes nothing: each copy is
     deleted for its age alone (below), so more than one can be beside the store, and
     [Getting the copy back](#getting-the-copy-back) says which to take. This differs from the decision recorded
     on #2304, which kept only the newest copy and deleted the earlier one when the next breaking step made a new
     one. The reason is the update that is stopped partway: a host stopped after the first breaking step committed
     and before a later one did starts again with a store past the first and copies it before the later step.
     That newer copy already lacks what the first step removed, so deleting the earlier one for it would delete
     the only copy of the store as it was before the update. Nothing in the store says which build the person
     would go back to, so no rule could pick the copy to delete; keeping each for its 14 days needs none, and
     costs disk space (below).
   - **A snapshot through the store's own connection.** `VACUUM INTO` writes the copy from one read transaction, with
     what is still in the WAL, while the host holds the data folder's lock, so no other host writes meanwhile. It
     runs before the step's transaction, since it cannot run inside one. A plain file copy would have to fold the WAL
     first and could not tell a half-written page from a whole one.
   - **A file under a copy's name is always whole.** The copy is written as `store.before-<step>.db.partial`, synced
     to disk (SQLite does not sync the target of `VACUUM INTO`) and then renamed. A host stopped during the copy
     leaves only the `.partial` file and the `.partial-journal` SQLite keeps beside the file it writes, which the
     next open deletes before it copies again: the step had not run. After the rename the store's folder is synced
     too (`OsFiles.fsyncDirSync`; nothing on Windows, where Node cannot open a folder to sync it): a rename is in
     the folder, so without it a power cut could undo the name while the step's commit stays. A folder that cannot
     be synced is said in host.log (`[store] the name of … could not be synced to the disk`) and is not a step
     without a copy: the copy is whole and under its name.
   - **A copy an earlier start left for the same step is kept.** A host whose step did not commit (stopped after
     the rename, stopped in the step, or the step failed) leaves `store.before-<step>.db` beside a store still below
     that step. The next open keeps that file as the copy, says so in host.log (`[store] … is kept as the copy
     before step …`) and writes none, when nothing was committed to the store since: the copy's time is not before
     `store.db`'s, nor before the WAL's when the WAL holds a commit. A commit reaches the WAL first, so its time
     counts; but an open makes an empty WAL new, and a step stopped before its commit leaves in it the part that
     outgrew the page cache (16 MB as better-sqlite3 is built), which SQLite drops, so a WAL newer than the copy is
     asked whether it holds a commit at all (`PRAGMA wal_checkpoint(PASSIVE)`, which says it without reading the
     WAL's frames here). Writing the copy again would add nothing but its time at every start of a host that stops
     in a long step, and a rename over the first copy, which Windows refuses while a backup or a scanner holds that
     file: the person would read "no copy" beside a whole one. A store written since is copied again: its step
     failed, the person went on with the build they had, and the first copy lacks that work. A time that wrongly
     reads as written since costs one more copy. One that wrongly reads as not written since keeps a copy without
     that work, and takes the clock set back, or a `store.db` put back from a backup with a time older than the
     copy. A folder under the name is not a copy.

     One case is copied again though nothing was lost: a start that committed something before it wrote the copy
     (an earlier step of the same open, the first `min_reader_version` record of a store from before #292, a
     deferred step crossed off) and then stopped in its step, or whose step failed. Those commits are in the copy,
     but they are still in the WAL, or reach `store.db` when the failed open closes, so the times read as written
     since. The next start writes the copy once more; the start after it keeps that one. A checkpoint before the
     copy would close this; it is not done, since the case costs one more copy and loses nothing.
   - **The copy takes the store's permissions**: it is created with the store's mode (`0600` in the data folder,
     [security-boundaries/local-data-and-transport.md](../security-boundaries/local-data-and-transport.md)), since
     it holds every conversation the store holds. On Windows the profile folder's ACL covers it, as it does the store.
   - **Kept 14 days.** A host start deletes a copy older than that, by the file's time; there is no timer, so a host
     that runs for weeks keeps the copy until its next start. Its age is the only thing a whole copy is deleted
     for. Only names of the form `store.before-<digits>.db`, with or without `.partial` or `.partial-journal`,
     are ever deleted: a file a person put beside the store under another name is left alone.
   - **Skipped when the disk is short or the copy fails.** With less free space than twice the store's size (the
     file and its WAL; read through `OsFiles.freeBytesSync`), no copy is made: the copy takes up to the store's size,
     and the step that follows needs room for its own writes. A disk that does not say how much is free is tried. A
     copy that fails midway is removed. Either way the step still runs, because a host that would not start for want
     of a copy leaves the person with nothing, and the person is told twice: a `[store] no copy before step …` line
     in host.log, and one notice from Centralu in the Inbox saying that this update ran without a copy and cannot be
     undone (`WARNING_TEXT.noStoreCopy`, `facts.storeCopySkipped`, once per step).
   - **What it costs.** A file the size of the store for each open that copies, for 14 days: one for an update,
     one more for each further update with a breaking step inside those 14 days, and one more for each later start
     that copied to finish an update stopped between two breaking steps. The copies add up, one store size each,
     until the disk has less than twice the store free: the free-space rule above then gives the next breaking
     step no copy and the person the notice, though part of what fills the disk is Centralu's own earlier copies.
     The rule itself counts as before: it is about the copy being written, and the space earlier copies take is
     already out of what the disk says is free. Measured on 2026-11-17 on a 972 MB store (Windows 11, NVMe, warm
     cache): `VACUUM INTO` 1.8 to 2.0 s, the sync 2 ms; in a host started on that store, 1.8 to 2.6 s for the
     copy. The window shows "Starting the agent host…" meanwhile, and host.log says that the copy started and how
     long it took. A copy and step that together take over 30 s show "Could not start the agent host" though the
     host is fine (#2334).

| Steps | What they do | Older build |
|---|---|---|
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43, 45, 47, 53, 54, 68, 70, 71 | add a column (71: `mail.subject`, the subject a session's send gave the chain it starts, #2229; 70: `mail.choices`, the answers a session's question to the person offers, #1630; 68: `sessions.is_assistant`, the Assistant's marker under the role's new name, copied from `is_orchestrator` and written beside it, read from v69 on, #2133; 45: `sessions.asked_by_session_id`, the session that asked for this one, #371, whose meaning moved with #561 and #614, see 48 and 55; 47: `grid_layout.remote_app_id` and `app_machine`, a panel of a linked machine's app, #82; 53: `sessions.interruption`, why the last turn did not finish, #698; 54: `queued_requests.opened_by_auto`, a queued ask only `auto` let through) | reads it (39: shows sessions in the session archive as live ones; 43: an older host's `grid.set` writes no span, so app panels fall back to their defaults, #306; 47: an older host reads app rows only where `app_id` is set, and its `setGridView` drops a linked machine's app panel when it rewrites the layout; 53: an older host neither reads nor writes `sessions.interruption`, so a row it serves keeps the last value, #698; 54: an older host neither reads nor writes `opened_by_auto`; a row it queues is null, read as marked when the pair has no remembered consent; 68: an older host writes only `is_orchestrator`, which is why the build of v68 reads that one, [plans/assistant-rename.md](../plans/assistant-rename.md)) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42, 44, 46, 49, 50, 51, 52, 57 | add a table (3 also backfills the index: heavy; 44 adds `project_consents`, the "always" one project was given to reach another, #371; 46 adds `linked_machines` and `machine_headers`, the hub's links and what it last heard from each, and the nullable `grid_layout.remote_session_id`, #82; 42 copies the grid's session rows into `grid_layout` once and leaves `grid_panels` as it was, #288; 49 adds `report_marks`, the report a session owes the session that gave it work, #646; 50 adds `agent_start_requests`, a start_agent card still waiting for the person, #673; 51 adds `delegated_turns`, the session that gave a running turn, #676; 52 adds `queued_requests`, a request held for a busy session, and the nullable `sessions.forked_from_session_id`, #677; 57 adds `app_run_records`, `app_run_messages` and `app_run_subagent_messages`, the record of a deleted app-agent session, and the nullable `app_runs.request`, `answer` and `output`, #378) | reads it (42: an older host keeps its grid in `grid_panels`, so the two builds' grids can differ; 46: an older host's `setGridView` drops a linked machine's session panel when it rewrites the layout) |
| 60 | add a column and a table (#550): `linked_machines.asks`, the per-machine switch for a linked machine's sessions to ask this computer's projects, off by default, and `machine_ask_consents`, the pairs (a session of that machine, a project here) the person approved, each end a foreign key with CASCADE | reads it (an older host's insert leaves the switch off, it never reads the table, and its removal of a machine takes the machine's pairs with it) |
| 62 | add two tables (#1452): `usage_readings` (the limit windows' readings) and `usage_buckets` (the requests of each hour per session, project, tool and model), [usage.md](usage.md#usage-over-time-1452) | reads it (an older host neither reads nor writes the two tables, so it records nothing while it serves a swap, and its purge leaves a purged session's `usage_buckets` rows, which hold counts only) |
| 64 | add `usage_local_totals` (#1623): the last good totals of a tool that reports no limits, with when they were read, so a restart shows them at once, [usage.md](usage.md) | reads it (an older host neither reads nor writes the table) |
| 65 | add two tables and four columns (#1684): `mail` and `mail_recipients`, mail without threads ([plans/mailbox.md](../plans/mailbox.md) §6.1), and `mail_turns.message_id`, `starter_id`, `ended_how` and `sessions.mail_args` (never read or written: the tool version it was for was not built, plans/mailbox.md §11.3); nothing read them yet | reads it (an older host never names the new tables, and names its columns in every read and insert of `mail_turns` and `sessions`) |
| 66 | add an index on `mail_recipients.held` (#1899), so the Inbox's held mail and the person's trust and Dismiss do not scan the table | reads it (an older host never names the index) |
| 73 | add a table (#1324): `mail_watches`, the watches sessions keep ([plans/mailbox.md](../plans/mailbox.md) §18.4). | never names it: after a rollback the watches sleep and fire nothing; an update back picks them up, and a time missed meanwhile fires once, late |
| 10, 11, 40 | rebuild with the same shape (10: `sessions` with `project_id` nullable; 11 and 40: the index, then `VACUUM`: heavy) | reads it |
| 21, 26, 29, 35, 48, 55, 72 | rewrite data one way (21 rewrites every message: heavy; 48 gives a former worktree manager's worktree sessions `askedBy`, #561; 55 clears an `askedBy` that names a session of another project, the ask_project meaning from before #614, which the host start did until #844; 72 ends the holds an earlier build left, #2243: a mail row held `budget`, or held `policy` and settled `legacy` by the v65 move when today's gate (`reach.holdFor`) would not hold that mail, becomes `dismissed`, the word the person's Dismiss sets (the step holds a frozen copy of the gate's conditions, `endOldHolds`, which step 75 applies to the rows it moves), because the guard and the `auto` receiver's first-contact hold no longer exist and the Inbox listed them weeks later) | reads it, cannot be undone (72: an older build reads `dismissed` as the person's own Dismiss and does not hold them again; 55: a build of beta.20 or before still writes the old meaning, and a row it writes after the step keeps it, as that build showed it) |
| **13, 28, 32, 56** | **drop a table or a column** (56: `usage_facts`, which nothing ever wrote, #423) | **breaks: raises `min_reader_version`** (56: an older host recreates the table empty, which harms nothing) |
| **69** | **copy the Assistant's old forms into the new ones once** (#2133 step 4): `is_assistant` from `is_orchestrator`, each renamed `app_settings` key from its old key, and a new key whose old key is absent deleted; from then on the new form is read first | **breaks the builds of v67 and before only: raises `min_reader_version` to 68**, not 69 (`minReader`). The build of v68 (beta.54 on) writes and deletes both forms and still opens the store; an older one would leave the new form stale ([plans/assistant-rename.md](../plans/assistant-rename.md) §3.2) |
| **74** | **turn what the builds before v70 kept beside the task rows into mail, once** (#2258): each `queued_requests` row becomes an undelivered task from its requester, each `report_marks` row whose caller has no open task to its session a delivered one, with frozen copies of the statements. A row whose requester or session is gone or in the trash, a held request with blank text or through a tool no build knows, and an id no mail address carries make none; then those rows, `delegated_turns` and the per-session keys `turn_inputs:`, `report_turn:`, `input_origins:`, `report_paused:` and `person_report_paused:` are deleted. The tables stay until step 76 (see 75) | **breaks the builds of v69 and before only: raises `min_reader_version` to 70**, not 74 (`minReader`). The build of v70 (beta.58 on) has #1948 steps 2 to 4, writes none of it but the marks it leaves as it goes, and still opens a store at v74 (step 75 keeps it out in turn); an older one would hold requests and settle tasks by marks this build no longer writes ([plans/turn-owned-by-no-one.md](../plans/turn-owned-by-no-one.md) §6) |
| **75** | **move the thread mail still pending in the old thread tables into `mail` and `mail_recipients`, once** (#2258, [plans/mailbox.md](../plans/mailbox.md) §6.3): each `mail_receipts` row not handled, not dismissed by the person, of a message of the last 180 days, that is not delivered, not read, or a question, is copied under its message's id with its row settled `legacy`, and the old receipt is marked handled, with a frozen copy of the move the host ran at every start until this build. From this build on only a migration step names `mail_threads`, `mail_participants`, `mail_blockers`, `mail_messages`, `mail_receipts`, `report_marks`, `delegated_turns`, `queued_requests` or `sessions.mail_args`. They stay, unread, for the build of v74, until step 76 | **breaks the builds of v70 to v73 (beta.58 to beta.69) only: raises `min_reader_version` to 74**, not 75 (`minReader`). Those builds leave a report mark for every session in a turn and make a task of each mark at their next start; the build of v74 deleted the marks at every start, so that one left during a rollback never became a task for work settled since, and this build no longer names `report_marks`, so the reader gate refuses those builds instead (rule 3: they stop at start, the store untouched). The build of v74 (beta.70 to beta.72) writes no mark, its own move at every start finds each receipt handled, and it still opens the store |
| **76** | **drop what only migration steps name** (#2258, [plans/mailbox.md](../plans/mailbox.md) M7): the tables `mail_threads`, `mail_participants`, `mail_blockers`, `mail_messages`, `mail_receipts`, `report_marks`, `delegated_turns` and `queued_requests`, the index `mail_turns_open` and the column `sessions.mail_args`, one release after step 75, whose build was the first to name none of them (rule 2). The thread messages step 75 did not move (handled, or older than its 180 days) are kept only in the copy the open that ran this step made, for its 14 days, and nowhere when that copy could not be made (rule 7): `store.before-76.db` for a store that was at version 75, and the copy named after the first breaking step of that open (`store.before-75.db` from version 74) for an older one. `schema.sql` creates none of these, so a new store and a migrated one end the same | **breaks the build of v74 (beta.70 to beta.72) only: raises `min_reader_version` to 75**, not 76 (`minReader`). That build reads the thread tables at every start, deletes from `report_marks` at every start and from two thread tables when a session is purged, so the reader gate refuses it (rule 3). The build of v75 names none of them and still opens the store. No release read or wrote `sessions.mail_args` |

A step that changes the schema regenerates [generated/schema.md](../generated/schema.md) (`pnpm docs:schema`) in the
same PR, and a new table gets a line in a "Where it is stored" list of [domain-model.md](../domain-model.md) and its
mirror. `schema-doc.test.ts` fails until both are done.

### Getting the copy back

For a person who updated, lost something to a breaking step (rule 7) and wants the store as it was before the update.
It is done by hand, on purpose: putting the copy back throws away everything done since the update, and only the
person can weigh that.

The copy is in the data folder, beside `store.db`: `~/.centralu` on macOS and Linux, `C:\Users\<name>\.centralu` on
Windows, or the folder `CC_DATA_DIR` names. Its name carries the step it was made before, for example
`store.before-76.db`. It is there for 14 days after the update, unless host.log and a notice in the Inbox said that
the update ran without one.

More than one copy can be there. Each update with a breaking step leaves its own for 14 days, and an update that
was stopped partway leaves one more for each later start that copied before a further breaking step. Take the
oldest copy among those written at or after the update you are undoing, by the files' dates; it is also the one
with the lowest number among them. In numbers, that is the copy with the lowest number above the store version of
the build you go back to, which that build says when it refuses a store ("this Centralu knows store versions up
to …").

A pick can be wrong in two ways. Neither loses anything, since the other copies stay where they are: quit again,
move that store aside and take the right copy.

- A copy with too high a number holds a store that an earlier breaking step had already changed. The older build
  refuses it at start ("This data was written by a newer Centralu") and changes nothing, or opens it without what
  that step removed.
- A copy from an earlier update (an older date, and a number at or below that build's store version) is opened
  like any older store: the build runs its steps on it and shows the data as it was before that earlier update.

The right copy can be missing: it was older than 14 days, or it was never written, which host.log says with the
step's number (`[store] no copy before step …`). The lowest copy there is then from after the update's first
breaking step, and the build from before the update refuses it or opens it without what that step removed. The
notice that an update ran without a copy is about the step that got none: a copy an earlier start of the same
update wrote is still there.

1. Quit Centralu with "Quit completely", and stop `centralu serve` (`centralu serve --stop`) if it runs on this
   computer. The store must have no host: with "Keep agents running after Centralu quits" on, a plain "Quit" leaves
   one running, which keeps writing to the files the next step moves (Windows refuses the move).
2. Install the Centralu you had before the update. The newer one would run the step again on the copy.
3. In the data folder, move `store.db`, `store.db-wal` and `store.db-shm` somewhere else (the last two may not be
   there). Keep them until the old build has started.
4. Rename the copy you chose, `store.before-<step>.db`, to `store.db`. Leave any other copy where it is.
5. Start Centralu.

What is not in the copy: conversations, sessions, mail and settings from after the update. Files outside the store
(attachments, apps' data, worktrees) are not copied and not put back; they stay as they are now.

A file named `store.before-<step>.db.partial` is a copy a host was stopped while writing. It is not whole: do not
use it. The next start deletes it, and the `.partial-journal` file beside it.

## Stored shapes another build reads (#384)

The store's tables are one shape that two builds share; [Migration steps: expand, then contract](#migration-steps-expand-then-contract-292) covers them. Many other shapes are stored or exchanged
the same way: JSON rows in `app_settings`, JSON columns, files in the data folder, files a person or another build
writes, and the lines and frames between processes. An older and a newer build read each of them during a host swap,
after a person goes back a release, and between two machines on different releases.

The rules for every shape: a field added is ignored by an older reader, and kept where it writes the record back; a
field removed gets its default in a newer reader; a value this build cannot read takes its default alone, and a
permission that cannot be read is a refusal; a broken file or row gives a clear message that names it, never a crash
and never a setting reset without a word.

Every such shape, its owner, its parser and what it does today with each of those, with the tests that feed it the
other build's shapes: [stored-shapes.md](../stored-shapes.md). A new stored shape, or a new field in one, gets its row
there in the same pull request.
