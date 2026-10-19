# Stored shapes another build reads (#384)

The store's tables are one shape that two builds share. [agent-host.md](agent-host.md) §5.1 covers them: steps that
add first and remove later, and `min_reader_version`. Many other shapes are stored or exchanged the same way: JSON
rows in `app_settings`, JSON columns, files in the data folder, files a person or another build writes, and the lines
and frames between processes. An older and a newer build read each of them during a host swap (the previous host
serves while the next one starts, and takes over again if it fails), after a person goes back a release, and between
two machines on different releases.

This document is the inventory: every such shape, who owns it, where it is parsed, and what an added field, a
removed field and a broken value do **today**. It is a record of the code, kept with `file:line` so a reader can check
it. When a line moves, the symbol named next to it still finds it. Like [runtime-lessons.md](runtime-lessons.md), it is
English only.

## The rules

For every shape:

1. **A field added:** an older reader ignores it, and, where it writes the record back, keeps it.
2. **A field removed or not yet written:** a newer reader uses the default.
3. **A value this build cannot read** (a word from a newer enum, the wrong type): that value takes its default, alone;
   the rest of the record still reads. **A permission that cannot be read is a refusal, never a grant.**
4. **A broken file or row** (not JSON, the wrong top-level type): a clear message that names the file or row, never a
   crash, and never a setting reset without a word.

A row of `app_settings` kept for one session is keyed `<name>:<sessionId>` (`agent_depth:`, `report_paused:`,
`tool_prefix:`, …). Deleting the session for good deletes every key of that shape (`SESSION_SETTING_OF`,
`purgeSession`), so a new per-session key needs no line in the purge.

The helpers for JSON the store holds are in `packages/agent-host/src/dev-services/store/json.ts`: `parseJson`
(undefined for text that is not JSON), `readJson` (a schema with a fallback), `readJsonList` (an element that does not
read is skipped) and `readJsonObjects` (a list of objects, every field kept). None of them throws. None of them says
anything either, so a reader whose fallback would be written back has to say it itself (rule 4). A list of objects
that is written back after a change uses `listSetting` (`store/settings.ts`), which does both: it keeps the elements
this build cannot read, and sets a row that is not a list aside, naming it, before replacing it.

## How to read the tables

- Paths are relative to `packages/` unless they start with `apps/`.
- **Added** is what this build does with a field or value a newer build wrote; **Removed** is what it does with a
  record an older build wrote, which lacks a field; **Broken** is a value that is not JSON or not the shape at all.
- ✗ marks a cell where today's code breaks a rule, with the rule's number. Each one is either fixed by a pull request
  that changes the cell, or listed under [Left](#left) with the reason.
- **Tests** names the test files, and which of the three cases have none.

## Settings

| Shape | Where | Owner | Parser | Added | Removed | Broken | Tests |
|---|---|---|---|---|---|---|---|
| Screen preferences (`UiPreferences`) | `app_settings.ui_preferences` | agent-host sessions | `parseUiPreferences` `protocol/src/entities/preferences.ts:259`; host `UiPreferenceStore.uiPreferences` / `setUiPreferences` / `storedUiPreferences` `agent-host/src/sessions/ui-preferences.ts:52`, `:91`, `:111`; the UI reads the result again (`ui/src/store/connection.ts:511`) | read field by field: an unknown word (a newer `themeMode`) is its default, alone; unknown fields and unreadable values are kept when this build writes a change (the patch is written over the stored record, not over this build's reading of it) | each missing field is its default, except `notifyPolicy` (#1306): a record without it takes the workspace snapshot's switches, or the defaults, on the first read, and keeps them; a rollback to a build that writes them only to the snapshot is not followed by the record, as with the text size (#312) | defaults, one stderr line naming the row (once per host); reading it never writes it (the one-time moves of an old text size and of the notification switches out of the snapshot skip a broken row); the next change replaces the row with the patch alone | `ui-preferences.test.ts`, `protocol/src/theme.test.ts` (all three) |
| Workspace snapshot | `workspace` row (id 1) | ui store | host `SettingsRecords.saveWorkspace` / `loadWorkspace` `agent-host/src/dev-services/store/settings.ts:55`, `:69`; the UI's restore in `attach` (`ui/src/store/connection.ts:587`) with `sanitizeLayout` `ui/src/store/panelLayout.ts:138`, `sanitizeArrangements` `core/src/grid/project.ts:85` | ignored. The window rewrites the snapshot whole, so an older window drops a newer one's fields: deliberate for layout, but the snapshot also holds settings (`appSpans`, `showIgnored`, `introSeen`, and a copy of `notifyPolicy` for a build that reads it there; the host's record is the source since #1306, carried from the snapshot once by `UiPreferenceStore.uiPreferences`) | each field checked on its own; a notification switch the snapshot lacks is on, not off (`readNotifyPolicy`, `protocol/src/entities/preferences.ts`, which reads the preferences record the same way) | not a JSON object: the host answers `null` and names the row on stderr with what it held; the window opens as its defaults, and its next change replaces the row. A `workspace.load` that fails, or a restore that throws partway, is said in a toast, and the window saves nothing over the stored snapshot while it reads it again (every reconnect, then 1, 5 and 30 s); read, its settings and layout come back and saving resumes; past the last try the window's own snapshot is saved in its place, said once | `store-layout.test.ts`, `panelLayout.test.ts`, `notify.test.ts`, `store-unreadable-rows.test.ts` (all three) |
| Theme and typography cache | the page's `localStorage` (`cc-theme`, `cc-typography`) | ui app | `applyCachedTheme` `ui/src/app/theme.ts:176`, `applyCachedTypography` `ui/src/app/typography.ts:180` | ignored | each value checked, except the cached `mode`, `preset` and `base` | same as no cache. Only the first frame; the host's answer follows | `typography.test.ts` (`typographyOf` only) |
| Keeper settings | `keeper-settings.json` | keeper (Rust) | `Settings::from_json` / `load_settings` / `save_background` `apps/desktop/src-tauri/keeper/src/keeper/source.rs:479`, `:508`, `:538` | unknown fields kept and written back; a `background` that is not true or false reads as off, alone, with a stderr line | `background` is off | not JSON or not an object: off, one line naming the file in `keeper.log`; the next save replaces it. A read error other than a missing file (permissions, I/O) also reads as off, and the next save then replaces the file and a newer build's fields with it ✗1 ([Left](#left)) | `background_mode_is_off_unless_saved_on`, `a_newer_settings_file_keeps_what_this_build_does_not_know` (all three; none for a read error) |
| On/off settings (`updates.auto`, `updates.autoApply`, `agents.autoApplyVersions`) | `app_settings` | agent-host | `flagSetting` `agent-host/src/dev-services/store/settings.ts:20` | — | never written is the default | anything but `true`/`false` is the default | `json.test.ts` |
| Sleep after | `app_settings.agents.sleepAfterMinutes` | agent-host sessions | `sessions/sleep.ts:77` | — | default | default | `sleep.test.ts` |
| Agent versions seen | `app_settings.agents.versionsSeen` | agent-host | `readSeen` `agent-host/src/main.ts:430` | kept | — | `{}` with no word; the values are not checked | none |
| Project JSON columns (`commands`, `worktree_setup`, `worktree_manager`, `default_models`) | `projects` | agent-host store | `ProjectRecords` `agent-host/src/dev-services/store/projects.ts:54`, `:76`, `:102`, `:154`; `setProjectToolDefaults` `:175` | `default_models`: a pick is written over the stored value, so a newer build's fields for a tool and a tool this build does not know are kept. `commands`, `worktree_setup`, `worktree_manager`: cut down to the fields this build knows, and written back that way ✗1 ([Left](#left)) | default | empty; `default_models` that is not a JSON object is named on stderr when the next pick replaces it; the other three with no word ✗4 ([Left](#left)) | `store.test.ts` "the project list survives a corrupted value" (`commands`), `store-unreadable-rows.test.ts` (`default_models`, all three) |
| Orchestrator proposals and skills | `app_settings.orchestrator_mcp_proposals`, `orchestrator_mcp_servers`, `orchestrator_skill_proposals`, `orchestrator_skills` | agent-host sessions | `OrchestratorProposals.list` `agent-host/src/sessions/orchestrator-proposals.ts:78` on `listSetting` `dev-services/store/settings.ts:51` | an element keeps its extra fields; one this build cannot read (no name or content) is not used, and is kept when the list is written back | — | not a list reads as empty and is named on stderr; the next write sets it aside as `<key>.unreadable` before replacing it | `orchestrator-proposals.test.ts` (all three) |
| Orchestrator tool | `app_settings.orchestrator_tool` | agent-host sessions | `sessions/tool-registry.ts` (`registeredTool`), asked by `sessions/manager.ts` | an unknown tool is the first registered one | — | same | none |
| Project order across machines | `app_settings.hub.projectOrder` | agent-host links | `storeProjectOrder` `agent-host/src/links/stored.ts:52` | — | — | no order, with no word; the next drag writes a new one | `links/stored.test.ts` |
| Card rests | `app_settings.card_rests` | agent-host sessions | `sessions/card-rest.ts:37` | an unknown state is dropped (the data is temporary) | — | `{}` | none for broken |
| View hand-over | `app_settings.views.handover` | agent-host | `restoreViewHandover` `agent-host/src/view-handover.ts:68` | an element that is not a view is skipped | — | nothing reopens; the row is deleted all the same | `view-handover.test.ts` |
| Per-session settings | `app_settings.<name>:<sessionId>` | agent-host sessions | `report_paused:` `sessions/child-ownership.ts:89`; `background_tasks:` (`keptBackgroundTasks`), `tool_prefix:`, `launch_settings:` `sessions/launch-records.ts:49`; `agent_depth:`, `hub_ask_depth:` `sessions/agent-depth.ts:59`; `fresh_start:` `sessions/session-start.ts:638`; `external_synced:` `sessions/external-conversations.ts:237`; `code_intelligence:` `sessions/tool-profiles.ts:108` | — | default | `background_tasks:` that does not read whole (not JSON, not a list, a task in another shape) reads as "not known", which keeps an adopted process from sleeping, and is named on stderr; an unreadable `agent_depth:` is depth 0; a `fresh_start:` that is not a number reads as nothing to lose. The others read as their safe side (a changed launch hash restarts, an unreadable sync mark reads again) | `store-purge-settings.test.ts` (the purge), `background-tasks-swap.test.ts` (`background_tasks:`, all three); none for the other broken values |

## Apps

| Shape | Where | Owner | Parser | Added | Removed | Broken | Tests |
|---|---|---|---|---|---|---|---|
| App manifest | `centralu.app.json` in an app folder | agent-host apps | `parseManifest` `agent-host/src/apps/external/manifest.ts:234` | an unknown field is a warning ("unknown field, ignored: …"); an unknown `uses.host` capability is a warning and refused when asked; a `view.span` out of bounds is clamped or ignored with a warning; another `manifestVersion` is an error naming both versions; an unknown `view.origin` or a malformed `uses` stops the app with an error (deliberate: `docs/apps.md`) | optional fields default (`view.origin` opaque, `uses` empty, `server.args` empty) | "centralu.app.json is not JSON: …" / "… must be a JSON object", shown in the app list with the app | `manifest.test.ts`, `discovery.test.ts` (all three) |
| An app's consents in a session | `app_settings.session_apps:<sessionId>` | agent-host sessions | `AppAccess.stored` / `isRecord` `agent-host/src/sessions/app-access.ts:357`, `:368` on `listSetting` | an element with a consent this build does not know grants nothing, and is kept when the list is written back | — | empty list, named on stderr; the next write sets it aside as `session_apps.unreadable:<sessionId>`, which goes with the session | `app-access.test.ts`, `store-purge-settings.test.ts` |
| An app shared with other projects | `app_settings.app_shared:<appKey>` | agent-host sessions | `sessions/app-access.ts:107` | anything but `1` is not shared: a refusal | not shared | not shared | `app-access.test.ts` (all three) |
| App permissions | `app_permissions` | agent-host apps | `PermissionRecords` `agent-host/src/dev-services/store/permissions.ts:71`; `desk.ts:587` | any decision but `allow` refuses, without asking, and the record stays | a decision recorded for an older `uses` asks again | (rows) | `app-capabilities.test.ts` (all three) |
| App secrets | `app-secrets.json` | agent-host apps | `SecretStore` `agent-host/src/apps/external/secrets.ts:25` on `PrivateJsonFile` `private-json-file.ts:68` | extra apps and keys kept on write | (map) | moved aside as `.unreadable-<time>`, one stderr line naming the file, and the app's screen says its secrets could not be read and why (never the contents); a file that cannot be read at all stays and refuses writes | `private-json-file.test.ts`, `app-secrets.test.ts` |
| Imported-app marks | `app-imports.json` | agent-host apps | `ImportBook` `agent-host/src/apps/external/import-book.ts:61`; the gate `AppHandover.gate` `handover.ts:103` | extra fields on an entry kept by `confirm` (an older build keeps `lost`, #1172) | (map); an entry without `lost` is an import | moved aside and said on stderr, as for secrets, and since the file is the only record of which apps were imported, a new file is written at once with a `lost` mark for every app then in the user folder, each `unconfirmed` until reviewed; a file that cannot be read at all stays and refuses writes, and every app without a mark is held meanwhile (`ImportBook.doubt`) | `private-json-file.test.ts`, `imports.test.ts` "a marks file that cannot be read holds the apps instead of running them" |
| App versions | `app-versions/<app>/<id>/meta.json` | agent-host apps | `AppVersions.list` `agent-host/src/apps/external/versions.ts:79` | extra fields kept | a missing `depth` is the legacy depth | a record without `id` and `at` is skipped, like a half-deleted one, with no word | `versions.test.ts` |
| View origin ports | `app_settings.apps.viewPorts` | agent-host views | `parsePortBook` / `readBook` `agent-host/src/views/origin-ports.ts:108`, `:81`, through `parseStoredPortBook` `main.ts:464` | top-level fields a newer build added are kept when the book is written back; an assignment in a shape this build cannot read is not used, and the port in it is retired, so it never goes to another app | — | not a JSON object: every number in the text that could be a port is retired, its apps get new ports (losing what they kept under the old origin, never reaching another app's), and the row is named on stderr once | `origin-ports.test.ts` (all three) |
| Builder links | `app_settings.apps.builders` | agent-host sessions | `sessions/app-sessions.ts:433` | — | — | `{}` with no word, and the next link written over every other app's ✗4 ([Left](#left)) | `app-sessions.test.ts` |
| Theme files | `<data>/themes/*.json` | agent-host | `parseThemeFile` `protocol/src/theme.ts:177`; `ThemeFiles.list` / `save` `agent-host/src/themes.ts:86`, `:113` | an unknown key or token is listed as a problem and ignored; a colour the window cannot use is dropped alone when the theme is applied and listed in Settings. Saving the theme from Settings writes only the tokens this build knows ✗1 ([Left](#left)) | missing tokens fall back to the base theme | listed as broken with the reason, next to the file in Settings; the person's choice of theme is not changed | `theme.test.ts`, `themes.test.ts`, `ui/src/app/theme.test.ts` (all three, and a colour the window cannot use) |

## Grid, consents and links

| Shape | Where | Owner | Parser | Added | Removed | Broken | Tests |
|---|---|---|---|---|---|---|---|
| Grid placements | `grid_layout` | agent-host store | `GridRecords.listGridView` / `setGridView` `agent-host/src/dev-services/store/grid.ts:18`, `:70` | `kind` has a CHECK, so a new panel kind is a table rebuild: a breaking step under §5.1. `setGridView` rewrites the table, so a newer build's columns are lost (v46, v47, said in §5.1) | a row without a span reads as none chosen (v43) | a span out of bounds or half set reads as none | `store.test.ts` (v42, v43, spans) |
| Consents between projects (#371) | `project_consents` | agent-host store | `getProjectConsent` / `listProjectConsents` `agent-host/src/dev-services/store/permissions.ts:102`, `:134` | a kind this build does not know stays in the store, grants nothing, and is not listed | (rows) | (rows) | `store.test.ts` |
| Approval rules ("always allow") | `approval_rules` | agent-host sessions | `PermissionRecords.listApprovalRules` `agent-host/src/dev-services/store/permissions.ts:34`; `ApprovalRules.rulesFor` `sessions/approval-rules.ts:53` | only an `allow` of a scope this build knows (`session`, `project`) applies: a rule a newer build wrote with another decision or scope allows nothing, and stays in the store | — | (rows) | `rules.test.ts` |
| Why a turn stopped (#698) | `sessions.interruption` | agent-host store | `SessionRecords.readSessions` `agent-host/src/dev-services/store/sessions.ts:111` (`readJson` with `Interruption`) | a reason this build does not know reads as `interrupted`, alone; extra fields dropped | none written: no interruption | not JSON: no interruption, and the session row still reads | `store-unreadable-rows.test.ts` (all three) |
| A session's permission preset | `sessions.permission_preset` | agent-host store | `SessionRecords.readSessions` `agent-host/src/dev-services/store/sessions.ts:111` | a word this build does not know reads as `safe`, which asks about everything; the next write of the session from this build stores `safe` in its place ([Left](#left)) | none chosen is `normal` | (column) | `store-unreadable-rows.test.ts` |
| Requests queued for a busy session | `queued_requests.via` | agent-host sessions | `ChildOwnershipRecords` `agent-host/src/dev-services/store/child-ownership.ts:100`; `ChildOwnership.restoreQueued` `sessions/child-ownership.ts:282`; `QueuedRequests.queuedGateError` `sessions/queued-requests.ts:197` | a `via` this build does not know is not delivered and not dropped: `restoreQueued` leaves the row in the store for a build that knows the tool, names it on stderr, and the requests behind it are delivered | — | (column) | `busy-requests.test.ts` |
| Linked machines (#82) | `linked_machines` | agent-host store | `LinkedMachineRecords.listLinkedMachines` `agent-host/src/dev-services/store/linked-machines.ts:29` | an unknown `shell` reads as `posix` | — | (rows) | `links/*.test.ts` |
| The highest slot handed out | `app_settings.links.slotHighWater` | agent-host store | `addLinkedMachine` / `slotHighWater` `agent-host/src/dev-services/store/linked-machines.ts:62`, `:82` | — | none written: the highest slot in use | a value that is not a whole number reads as none, so the next machine takes the slot after the highest in use, and the row is named on stderr | `store-unreadable-rows.test.ts` |
| Mirrored headers | `machine_headers.info` | agent-host store | `machineHeaders` `agent-host/src/dev-services/store/linked-machines.ts:96` | kept (the remote's `SessionInfo` / project, read by the protocol's tolerant parse) | — | a header that is not JSON is skipped; the next mirror writes it again | `store-unreadable-rows.test.ts` |
| Kept runs | `app_runs`, `app_run_failures` | agent-host store | `AppRunRecords` `agent-host/src/dev-services/store/app-runs.ts:27` | `status`, `kind`, `caller_kind` are text, passed as they are to the protocol | — | no JSON column | `external-app-runs.test.ts` |

## Store bookkeeping

| Shape | Where | Owner | Parser | Added | Removed | Broken | Tests |
|---|---|---|---|---|---|---|---|
| Lowest reader version | `app_settings.min_reader_version` | agent-host store | `ReaderGate.tooNew` / `storedMinReader` `agent-host/src/dev-services/store/reader-gate.ts:95`, `:106`; `MigrationRunner.migrate` `migrate-runner.ts:82` | — | none recorded: computed from the steps already run | a value that is not a version, on a store this host knows every step of, is worked out again from the steps the store has run and named on stderr. On a store newer than this host it refuses to start with "This data was written by a newer Centralu, and which versions can read it cannot be told", naming the row and the file, and changes nothing | `store-min-reader.test.ts` (all three) |
| Steps a swap left for later | `app_settings.deferred_migrations` | agent-host store | `storedDeferred` / `sayUnreadableDeferred` `agent-host/src/dev-services/store/migrate-runner.ts:308`, `:317` | — | none owed | a list that does not read whole is named on stderr with what it held; the steps it named do not run ([Left](#left)) | `store-swap.test.ts` (all three) |
| An owed `VACUUM` | `app_settings.vacuum_owed` | agent-host store | `store/vacuum.ts:29` (presence) | — | — | — | `store-swap.test.ts` |

## Files and lines between processes

| Shape | Where | Owner | Parser | Added | Removed | Broken | Tests |
|---|---|---|---|---|---|---|---|
| Host build record | `CC_HOST_SOURCE` (keeper to host) | agent-host | `hostBuild` `agent-host/src/keeper-link.ts:21` | ignored | missing keys are left out | the host's own commit only, with no word | `keeper-link.test.ts` |
| Start status | `shell-status.json` | the window (Rust) | `read_status` `apps/desktop/src-tauri/src/shell/mod.rs:240`, matched by nonce in `start.rs` | ignored | — | treated as no status yet; the start ends with "the shell did not report", which does not name the file | `shell/start/tests.rs` (none for a file that is not JSON) |
| Keeper record | `keeper.json` | keeper | written for a person and the integration scripts; no build reads it | | | | |
| Bundle info | `bundle-info.json` next to a host | keeper | `source.rs:69`, `server/host.rs:192` | ignored | — | commit `unknown`, the build time from the file's time, with no word | |
| Remote connection line | `centralu serve --connection` stdout | agent-host links | `parseConnectionLine` `agent-host/src/links/tunnel.ts:108` | ignored; `hostRunning` defaults to false | `version` and `dataDir` default | another `v` is an error that says which side to update; a missing port, token or protocol version is an error; lines that are not JSON are skipped | `tunnel.test.ts` (all three), `dev-build.test.ts`, `autostart.test.ts` |
| Worktree recovery snapshot | `snapshot.json` in a trashed worktree's folder | agent-host | `readSnapshot` `agent-host/src/dev-services/worktree-recovery.ts:324` | — | — | not JSON, or naming no repository: the restore fails with an error that names the file, and its patches and bundles stay for a restore by hand | `worktree-recovery.test.ts` (broken) |

## Host ↔ UI payloads

| Shape | Where | Owner | Parser | Added | Removed | Broken | Tests |
|---|---|---|---|---|---|---|---|
| RPC results | every `res` frame | protocol | `parseRpcResult` `protocol/src/commands.ts:52` → `parseTolerant` `protocol/src/tolerant.ts:24`; called in `platform/src/web/rpc-client.ts:401` | undeclared fields dropped; an unreadable value is kept as sent, alone | defaults applied (a field the protocol adds has a default, protocol.md §4) | a frame that is not JSON is dropped; an answer that does not read rejects the call, naming the method | `tolerant.test.ts`, `rpc-client.test.ts`, `e2e/older-host.spec.ts` |
| Events | every `event` frame | protocol | `parseServerFrame` `protocol/src/envelope.ts:130`, a strict parse | an unknown event type is dropped (protocol.md); an unknown word in a field without a `.catch` (`state_change.state`, `session_live.reason`, …) drops the whole event, with no word ✗3 ([Left](#left)) | defaults applied | dropped | `protocol.test.ts` "forward compatibility" |
| A new session's record | `session_created.session` | ui store | `parseTolerant(SessionInfo, …)` `ui/src/store/events/sessions.ts:89` | read as `sessions.list` reads it: undeclared fields dropped, an unreadable value kept as sent, alone; the session is added | defaults applied | a payload that is not a session record is not added | `store-sessions.test.ts` |
| A linked machine's app view | `apps.viewDocument` answered by a remote | agent-host links | `linkedViews` `agent-host/src/links/linked-views.ts:32`, `parseTolerant` | read tolerantly; an origin mode the hub does not know is `opaque`, the one that shares nothing | defaults applied | an answer without the app, address or document is an error that says to update both computers | `linked-views.test.ts` |
| The handshake | `hello_ok` | protocol | `parseServerFrame` | strict: an unreadable `hello_ok` is dropped and the handshake times out | defaults applied | dropped | `e2e/older-host.spec.ts` (older only) |

## Left

What this inventory found and the pull requests of #384 do not change, with the reason.

- **Builder links (`apps.builders`)** are read and written in `sessions/app-sessions.ts`, which #1141 is reworking;
  a row that is not JSON is replaced by the next link with no word. `listSetting`'s rule fits it once that lands.
- **Saving a theme from Settings drops the tokens this build does not know.** The window sends the theme it read
  (`ui/src/features/settings/ThemeSection.tsx`), which holds known tokens only; the host writes what it is sent. The
  fix is in the window, on the owner's UI branch.
- **`keeper-settings.json` that cannot be read for a reason other than its absence** (permissions, I/O) reads as off,
  and the next save replaces the file, a newer build's fields with it; a `shell-status.json` that is not JSON ends
  the start with "the shell did not report", which does not name the file. Both are Rust (the keeper and the window);
  this pull request stack was made on a machine without a Rust toolchain, so neither change could be tested here.
- **The workspace snapshot is written whole by the window**, so an older window drops a newer one's fields: the
  snapshot is the window's own record of its screen, and merging it on the host would keep fields a window cleared on
  purpose. Settings that must survive another build live in `ui_preferences`, which merges.
- **`grid_layout` is rewritten whole by `setGridView`**: §5.1 records what an older host does to the newer columns
  (v46, v47).
- **Values with no word on stderr but no harm**: the theme cache's `mode`, `preset` and `base` (the first frame only),
  `hub.projectOrder` (the order of projects), `card_rests` (temporary), `CC_HOST_SOURCE` and `bundle-info.json` (a
  build's own record, for its banner), an app version record without `id` and `at` (skipped like a half-deleted one),
  and a linked machine's `shell` this build does not know (read as `posix`).
- **A permission preset this build cannot read is written back as `safe`.** `upsertSession` writes the whole row, so
  keeping the newer word would mean every writer knowing which value it read rather than chose. `safe` only asks more;
  the person sets the preset again in the newer build.
- **A project's `commands`, `worktree_setup` and `worktree_manager` are written back in this build's shape.** Each
  is rewritten whole from what this build read (`commands` from the list the window sends back), so keeping a newer
  build's fields means carrying them through each writer and, for `commands`, through the protocol and the window;
  and a value that is not JSON is replaced without a word. The cost is a setting the person enters again, not a
  permission.
- **`agents.versionsSeen` that does not read** is read as nothing seen, with no word: one upgrade's capability check
  (`AgentVersionService`) is skipped, and the next read writes the versions again. Nothing else depends on it.
- **An event with a word this build does not know is dropped whole.** Events are parsed strictly
  (`parseServerFrame`); a field that may grow a word carries a `.catch` (the notice level, the interruption reason,
  a background task's status), and the rest do not. Read piecewise, the event would hand the screen's reducers a
  state or a reason they have no branch for, which is a worse failure than a missed update: the next read of the
  session list (tolerant) carries the value. A field that a newer build may widen gets its `.catch` when it is
  added, under protocol.md §4.
- **Steps an unreadable `deferred_migrations` named do not run.** `user_version` is past them, and a step a swap left
  for later owes an index, a vacuum or a contraction, never data, so the open says what the row held instead of
  guessing which steps to run again.

## An older host on a newer store, end to end

`e2e/older-host.spec.ts` covers the payload half: the real UI on a real host whose every frame is rewritten as a host
from before every defaulted field would send it. No e2e opens a store a newer build wrote with the previous release's
host. What it would take:

1. **The previous release's host.** It is published on npm as `@centralu/host-<platform>@<version>` (releasing.md,
   "Host-only packages"; `scripts/host-package.mts`), with the pinned Node beside it. The test would fetch the
   version before the one under test (`npm view centralu dist-tags`, then `npm pack`) into a temporary folder once
   per run, outside the repository, and cache it by version. A pull request run has network; a run with none skips.
2. **A newer store.** The host under test opens a store in a temporary data folder (`CC_DATA_DIR`), runs every
   step, and writes the shapes this inventory lists in a form only it knows: a field the previous release lacks in
   `ui_preferences`, the workspace snapshot, `apps.viewPorts`, a project's `default_models`; a newer word where a
   column takes one (an approval rule's decision, a permission preset, a queued request's `via`).
3. **The previous host on it.** Started on the same data folder, it must start (or refuse with the "written by a
   newer Centralu" sentence when `min_reader_version` is past it), list its sessions, refuse what it cannot read as
   a permission, and keep the newer fields when it writes: change a preference, open a view, then reopen the store
   with the host under test and compare.
4. **The UI.** The previous release's window ships inside its platform package as an app bundle, which Playwright
   does not drive, so the screen half stays with `older-host.spec.ts`; this test drives the older host through its
   RPCs (`hostCall`), as that spec does for its event.
5. **Where it runs.** The full tier, once per platform: the host package is per platform, and a release bump is
   the moment a new previous release exists. It cannot run before the first release that has the shapes it checks,
   so each shape's assertion lands one release after the shape.

Until then the unit tests in the tables above stand in for it: each feeds the parser the shapes the other build
writes.
