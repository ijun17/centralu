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

| Steps | What they do | Older build |
|---|---|---|
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43, 45, 47, 53, 54, 68, 70 | add a column (70: `mail.choices`, the answers a session's question to the person offers, #1630; 68: `sessions.is_assistant`, the Assistant's marker under the role's new name, copied from `is_orchestrator` and written beside it, read from v69 on, #2133; 45: `sessions.asked_by_session_id`, the session that asked for this one, #371, whose meaning moved with #561 and #614, see 48 and 55; 47: `grid_layout.remote_app_id` and `app_machine`, a panel of a linked machine's app, #82; 53: `sessions.interruption`, why the last turn did not finish, #698; 54: `queued_requests.opened_by_auto`, a queued ask only `auto` let through) | reads it (39: shows sessions in the session archive as live ones; 43: an older host's `grid.set` writes no span, so app panels fall back to their defaults, #306; 47: an older host reads app rows only where `app_id` is set, and its `setGridView` drops a linked machine's app panel when it rewrites the layout; 53: an older host neither reads nor writes `sessions.interruption`, so a row it serves keeps the last value, #698; 54: an older host neither reads nor writes `opened_by_auto`; a row it queues is null, read as marked when the pair has no remembered consent; 68: an older host writes only `is_orchestrator`, which is why the build of v68 reads that one, [plans/assistant-rename.md](../plans/assistant-rename.md)) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42, 44, 46, 49, 50, 51, 52, 57 | add a table (3 also backfills the index: heavy; 44 adds `project_consents`, the "always" one project was given to reach another, #371; 46 adds `linked_machines` and `machine_headers`, the hub's links and what it last heard from each, and the nullable `grid_layout.remote_session_id`, #82; 42 copies the grid's session rows into `grid_layout` once and leaves `grid_panels` as it was, #288; 49 adds `report_marks`, the report a session owes the session that gave it work, #646; 50 adds `agent_start_requests`, a start_agent card still waiting for the person, #673; 51 adds `delegated_turns`, the session that gave a running turn, #676; 52 adds `queued_requests`, a request held for a busy session, and the nullable `sessions.forked_from_session_id`, #677; 57 adds `app_run_records`, `app_run_messages` and `app_run_subagent_messages`, the record of a deleted app-agent session, and the nullable `app_runs.request`, `answer` and `output`, #378) | reads it (42: an older host keeps its grid in `grid_panels`, so the two builds' grids can differ; 46: an older host's `setGridView` drops a linked machine's session panel when it rewrites the layout) |
| 60 | add a column and a table (#550): `linked_machines.asks`, the per-machine switch for a linked machine's sessions to ask this computer's projects, off by default, and `machine_ask_consents`, the pairs (a session of that machine, a project here) the person approved, each end a foreign key with CASCADE | reads it (an older host's insert leaves the switch off, it never reads the table, and its removal of a machine takes the machine's pairs with it) |
| 62 | add two tables (#1452): `usage_readings` (the limit windows' readings) and `usage_buckets` (the requests of each hour per session, project, tool and model), [usage.md](usage.md#usage-over-time-1452) | reads it (an older host neither reads nor writes the two tables, so it records nothing while it serves a swap, and its purge leaves a purged session's `usage_buckets` rows, which hold counts only) |
| 64 | add `usage_local_totals` (#1623): the last good totals of a tool that reports no limits, with when they were read, so a restart shows them at once, [usage.md](usage.md) | reads it (an older host neither reads nor writes the table) |
| 65 | add two tables and four columns (#1684): `mail` and `mail_recipients`, mail without threads ([plans/mailbox.md](../plans/mailbox.md) §6.1), and `mail_turns.message_id`, `starter_id`, `ended_how` and `sessions.mail_args`; nothing reads them yet | reads it (an older host never names the new tables, and names its columns in every read and insert of `mail_turns` and `sessions`) |
| 66 | add an index on `mail_recipients.held` (#1899), so the Inbox's held mail and the person's trust and Dismiss do not scan the table | reads it (an older host never names the index) |
| 10, 11, 40 | rebuild with the same shape (10: `sessions` with `project_id` nullable; 11 and 40: the index, then `VACUUM`: heavy) | reads it |
| 21, 26, 29, 35, 48, 55 | rewrite data one way (21 rewrites every message: heavy; 48 gives a former worktree manager's worktree sessions `askedBy`, #561; 55 clears an `askedBy` that names a session of another project, the ask_project meaning from before #614, which the host start did until #844) | reads it, cannot be undone (55: a build of beta.20 or before still writes the old meaning, and a row it writes after the step keeps it, as that build showed it) |
| **13, 28, 32, 56** | **drop a table or a column** (56: `usage_facts`, which nothing ever wrote, #423) | **breaks: raises `min_reader_version`** (56: an older host recreates the table empty, which harms nothing) |
| **69** | **copy the Assistant's old forms into the new ones once** (#2133 step 4): `is_assistant` from `is_orchestrator`, each renamed `app_settings` key from its old key, and a new key whose old key is absent deleted; from then on the new form is read first | **breaks the builds of v67 and before only: raises `min_reader_version` to 68**, not 69 (`minReader`). The build of v68 (beta.54 on) writes and deletes both forms and still opens the store; an older one would leave the new form stale ([plans/assistant-rename.md](../plans/assistant-rename.md) §3.2) |

A step that changes the schema regenerates [generated/schema.md](../generated/schema.md) (`pnpm docs:schema`) in the
same PR, and a new table gets a line in a "Where it is stored" list of [domain-model.md](../domain-model.md) and its
mirror. `schema-doc.test.ts` fails until both are done.

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
