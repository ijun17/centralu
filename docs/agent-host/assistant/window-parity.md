# What the window does, the Assistant can do: preferences, archive, trust

**Preferences** (#1219, with the session archive). `get_preferences` and `set_preferences` are rare commands of the Assistant
(`PreferencesFlow`, `sessions/preferences-flow.ts`). They make the window's own calls through the router
(`SessionManager.useWindowRpc`, wired in main.ts to `router.handle`; `callWindow` in `sessions/window-rpc.ts` checks
the params with the method's schema and reads the answer with its result schema, and only the methods named in
`WINDOW_METHODS` are callable), so the host checks them as it checks the window.

- `get_preferences` reads `prefs.get`, `themes.list`, `agents.sleepPolicy`, `updates.status` (not forced: the read the window makes at start, which asks the registry only when checking is on and one is due)
  and `agents.versions`, one line each, with the choices; a part the host cannot read says so and the rest still answers.
  It also lists the theme files (`get_preferences { themeFile: id }` shows one in full), the models for started agents, and the limits on agents, which `set_agent_limits` changes behind a card.
- #1978, the Assistant sets what the person sets: `preferences-coverage.ts` names every field of `UiPreferences` as a field of `set_preferences` / `set_agent_limits` or as excluded with a reason, and `preferences-coverage.test.ts` fails when a new preference is in neither. Excluded: `accent` and `sessionTools` (gone from the product), `hubAuto` (no `set_preferences` field yet; the Assistant turns it on or off through the call the window makes, `prefs.set` or `machines.hubAuto`, which asks nothing with the limited credential either, owner decision 2026-11-05). Never reached by any command, by design: sign-ins and credentials, OS permission prompts, pairing a machine by hand, the privacy choices only the person grants. `set_preferences` also takes `agentModels` (merged into the saved map; null clears one), `themeFile` (writes a theme file through `themes.save`, the same schema and host code as Settings; the unknown tokens the reader skips are reported) and `deleteThemeFile` (`themes.remove`: the host has no OS trash, which Settings reaches through the shell, so the file moves to the themes folder's `.removed/` under a name of its own, the answer says where, and a side that showed it goes back to its preset, as Settings does). `themes.save` refuses a theme above the reader's size limit and one whose id differs from a hand-written file in the folder only by case.
- `set_preferences` takes only what changes: `theme` (an id or a name), `textSize`, `bodyFont`, `codeFont`,
  `lineHeight`, `idleSleepMinutes` (a whole number, or "never"), `autoUpdate` ("Automatic updates", below), and
  `moveIdleSessionsToNewAgentCli` and `notifications` (the switches to change: `approval`, `done`, `whenFocused`, `sound`;
  merged one by one into the host's record, [The inventory behind #1219](#the-inventory-behind-1219-what-the-window-calls-and-what-the-assistant-reaches); no card, except to turn `approval` off, or `sound` while it would still
  notify, the ones that tell the person a card waits, which ask in every preset and keep them on when denied). The
  "error" and "every session finished" notifications are gone from the product (owner decision 2026-10-20): the window
  no longer raises them, `set_preferences` refuses `error` and `allDone` by name, and the stored switches stay readable
  for older builds. The arguments are strict: a field it does not have (`sessionTools`, always on and named by neither command, `agentCeiling`,
  `themeMode`) is refused by name. A theme names one preset (`THEME_PRESETS`, now in the protocol) or a theme file that
  reads cleanly; it sets the side of the theme's base and the stored mode to that same base, so the mode stays `dark` or
  `light`, never `system`. The text size lands on the nearest step, as `prefs.set` does. A theme, font or
  schema refusal comes before any write; a service the host lacks (no update service in a test) is reported next to the
  changes that did happen.
- **The notification switches** (#1306) are in the preferences record (`UiPreferences.notifyPolicy`, optional), no longer only in the
  window's workspace snapshot, so the window and the Assistant share one source. `UiPreferenceStore.uiPreferences` carries
  them once: the first read that finds none takes the snapshot's `notifyPolicy` (the defaults when the window never saved
  one) and writes it, so a snapshot an older window still writes never overrides a switch chosen since (the text size moved
  the same way, #312). A patch carries only the switches that change and the host merges them one by one
  (`setUiPreferences`), so the window and the Assistant changing different switches do not undo each other. Every change
  is announced with `prefs_changed` (carries nothing; a window reads `prefs.get` again), which also brings the
  Assistant's other preferences (theme, text size) to an open window. The window keeps writing its snapshot's copy, for a
  build that reads it there; against a host that answers without the field it keeps using the snapshot's.

- **Automatic updates** (owner decision 2026-10-20) is one setting over the two stored switches: checking (`updates.auto`,
  `updates.setAuto`) and installing and applying when idle (`updates.autoApply`, `updates.setAutoApply`). Both are **on**
  for a person who never chose (`update-switches.ts`); a person who turned either off has it stored off and keeps it off,
  and one who turned checking off before keeps installing off too (their Check now only informed, and still does).
  Installing is on by default only in the person's desktop app (`installsByDefault`): a bundled build the window started
  itself (`CC_STARTED_BY=app`, Windows and Linux), or one the keeper runs from the installed app (`CC_HOST_SOURCE`'s
  `bundlePath` is `installedCopyPath()`, macOS). Every other host keeps installing off unless turned on: a `centralu
  serve` host, since on a linked machine the hub keeps its version (`machines.update`, the managed install under
  `<data>/remote`) and one installing by itself would race it; with the hub's own installing on, it brings each linked
  machine to its version by itself (#1508, [../remote/install-and-update.md](../remote/install-and-update.md) "Following the hub"); a host from source; and one a script or test harness
  started (no `CC_STARTED_BY`, a keeper running a build output or debug bundle, `CI` set), which must not install the
  published package globally on the machine running it. The wire default of `UpdateStatus.autoApply`
  stays false, for older hosts. `set_preferences autoUpdate: true` asks first, in every preset, whenever either half is
  off: with both on, a newer Centralu installs by itself and the desktop window relaunches into it when nothing is busy, so
  code arrives with no later question. It is an `other` card with `about: "orchestrator_change"` (`ASSISTANT_CHANGE`),
  allow or deny only; on Allow it turns on the half or halves that are off. A denial leaves both as they were and the
  call's other changes still happen. `autoUpdate: false` asks nothing and turns installing off before checking. The
  separate `checkForUpdates` and `applyUpdatesWhenIdle` fields are gone and refused by name; `get_preferences` shows one
  line, and says which half is on when they differ.

**The session archive** (#1219; its commands were `list_trash`, `restore_trashed`, `trash_subagent_steps`, `delete_trashed` and `empty_trash` until #1404, when an Assistant read "empty the trash" as the operating system's bin). The rare commands `list_archive`, `restore_archived { sessionId, what? }`, `archive_subagent_steps { sessionId }`,
`delete_archived { sessionId, what? }` and `delete_all_archived` (`TrashFlow`, `sessions/trash-flow.ts`, through the same window RPC as the
preferences) are the Settings → Archive screen's calls. `what` is `session` (the default) or `steps`.

- `list_archive` reads `trash.list` (linked machines merged; a machine not reached is named) and `subagents.usage`: the
  sessions with their project, size and what deleting for good takes along, the kept app runs (#378), the archived subagent
  steps, and the sessions whose steps could be moved there. Rows beyond 25 are counted.
- `restore_archived`, `archive_subagent_steps`: `trash.restore`, `trash.restoreSubagentSteps`, `subagents.trash`. They lose nothing and
  ask nothing, with one exception: restoring a session whose project was deleted registers the project's folder again (as
  the window's Restore does), which is what `add_project` asks about, so that restore raises a card naming the folder. A
  session not in the archive is refused before any call.
- `delete_archived` and `delete_all_archived` delete for good, behind a card in every preset (`ASSISTANT_CHANGE`, allow or deny only).
  A session or steps that are not in the archive are refused before the card, so a live session cannot be deleted this way.
  The card names the session (or the counts, the size and up to ten names), what goes with it (the tool's conversation
  file, a worktree marked for removal) and that it cannot be undone. After Allow the archive is read again and the host
  deletes exactly what the card named and is still there, one `trash.purge` / `trash.purgeSubagentSteps` (with the `upTo`
  the card listed) / `trash.purgeRuns` (one call per machine) at a time, as the window's Delete all archived sessions does; `trash.empty` is
  not used, because it takes everything in the archive, also what arrived after the card. A session restored or deleted while the card
  stood is left alone and said so, and so is one restored and archived again (its `deletedAt`, message count or what goes
  with it differ from the row the card named); one that failed to delete stays and is reported, and the rest go on.

**Trust** (#1219, third slice). The rare commands `list_projects` and `set_project_trust { project, trusted }`
(`TrustFlow`, `sessions/trust-flow.ts`, through the same window RPC as the preferences) are the project list's and the
trust switch's calls (`projects.list`, `projects.setTrusted`, with `apps.list` and `machines.list` to name what the
trust covers and where). `project` is an id, or a name exactly one project has (two that share it are named with their
ids). The Assistant's instructions point to these and the machine commands in one line: `centralu_commands "machine trust rule grant limits"` finds them all (2 characters more than the line it replaced).

- `list_projects`: each project with its id, folder, machine and whether it is trusted.
- `set_project_trust` with `trusted: false` asks too, in every preset (the reviewer's decision on #1325): it is not only
  narrowing. An untrusted project's sessions read the person's own settings only (`settingSourcesFor`), so the project's
  own deny rules and the hooks that block tools stop applying to its agents, `auto` sessions included; its apps stop and
  its idle sessions restart (a busy one when its turn ends, #663). The card says so; after Allow the project is read again
  (removed, moved, unreachable, or untrusted meanwhile: nothing more changes).
- With `trusted: true` it asks first, in every preset (`ASSISTANT_CHANGE`, allow or deny only): the card names the
  project, its folder and machine, and each of its apps (root and inner) with its description and what it may ask for,
  in the window's trust card's words (`usesLines`, now in the protocol so both say it the same way). After Allow the
  project and its apps are read again: one removed meanwhile, or whose apps changed (an app added by a pull, or what one
  may ask for), is not trusted, and the answer says why; one the person trusted meanwhile is left as it is. What a
  manifest supplies (name, description, the declared background work) is quoted with control and format characters
  escaped, the folder is named whole, and an app whose manifest could not be read, or that a linked machine listed without
  `uses` (an older build), is said to ask for what is not known rather than for nothing. A project whose machine is not
  reachable (its row is the hub's last copy) is refused before the card. A linked machine's project's apps are asked of
  that machine alone (`apps.list` with `machine`, which the router sends to that machine only, so a machine that does not
  answer is an error, not a list without its apps); when they cannot be listed, trust is refused before the card. Every
  app is named with its id quoted (an id is a folder's name). After Allow its folder and machine are checked too.
- The lists (`list_projects`, `list_approval_rules`, `list_app_grants`) say which linked machines are not connected, or
  that the machines could not be read at all, so a list without them does not read as complete.
- `list_approval_rules { project? }` reads Settings' list (`approvals.rules`, a linked machine's merged with its ids
  folded): each rule's id, what it allows, the project or session it belongs to, and since when.
  `remove_approval_rule { id }` removes one at once (`approvals.deleteRule`), as Settings' delete does: it only
  narrows, and that action asks again. An id no rule has is refused. **No command adds or widens a rule**: the window has
  no such call either, and a rule comes only from the person answering a card "always" (`ApprovalRules.rememberAlways`).
- App trust follows the project's since #1141 (a root app and its inner apps run when the project is trusted, and an
  imported app is enabled by trusting its project), so trusting an app is `set_project_trust`. `list_app_grants { app?,
  project? }` lists the apps (`apps.list`) with their trust and sharing and the person's remembered answers to what each
  asked for (`apps.permissions`, routed to a linked machine as the window routes it), and the remembered consents of one
  project reaching another (`projectConsents.list`). `forget_app_answer { app, project?, capability }` and
  `revoke_project_consent { from, to, kind }` act at once (`apps.forgetPermission`, `projectConsents.revoke`): each only
  makes the next attempt ask the person again. `share_app { app, project?, shared }` is the inner app's share switch
  (`apps.setShared`): off acts at once; on asks first, every preset, with a card naming the app, its project and what it
  may ask for. After Allow the app is read again: one removed, already shared, or whose `uses` changed while the card
  stood is not shared. A root app and a user-folder app have no share switch, and are refused before any card. The
  person's answer to an app's own capability question is not given from here: the app asks the person.
- `set_agent_limits { agentCeiling?, agentDepth? }` changes the person's limits on agents: the running agents per project
  (a number, 0 unlimited, or `"preset"` for the preset's own) and the levels of sessions that may start agents (1 to 3).
  "Let sessions look at other sessions" (`sessionTools`) is not one of them: it is not a setting any more (owner decision
  2026-10-20, #1321), so the command has no field for it and refuses one by name. They bound what agents do and cost, the
  Assistant's own children included, so **every change asks**, narrowing too, in every preset: the card names each
  limit as it is and as it becomes (`→`). Values are checked with `prefs.set`'s own schema before the card; nothing to
  change asks nothing. After Allow the limits are read again, and when the person changed one in Settings while the card
  stood nothing is changed (the card's "from" is not what is set); otherwise one `prefs.set` with exactly the named fields.
  `set_preferences` still has no field for them. The agent models (`agentModels`) have one there since #1978: they act at once with no card, on the owner rule that the Assistant sets what the person sets (2026-11-05): the tool must be an agent CLI on this computer, and a model and effort are free text, as Settings' picker takes with "Other…"; one that is not in the tool's current list (`agent_models`) is saved as typed and the answer says so; clearing a difficulty never set leaves no entry. Everything is checked before anything is written; the theme file is written last, and a `theme` named in the same call that is not found after the write is a partial success, said so.

## The inventory behind #1219: what the window calls, and what the Assistant reaches

The owner's direction (#1219): what the person can do in the window, the Assistant can ask to do, through the same
host checks; consequential or trust-changing actions raise a card the person answers, reading and reversible ones do not.
This is the list that principle is applied to: every RPC method of `packages/protocol/src/commands/methods/` (the
window's channel), grouped, and for each group one of three states.

- **Has it**: reachable by the Assistant today, as a tool or a rare command behind `centralu_run`.
- **Should**: the Assistant should reach it, in a slice not made yet, with the card it needs. None is left since the
  fourth slice (below): a method is now *has it*, *person*, or *not an errand* (a drawing aid, or a call that only means
  something to the window), each with its reason.
- **Person**: stays with the person, with the reason. A method here may still be *read* by the Assistant when the
  group says so.

| Group (methods) | State | Notes |
|---|---|---|
| Sessions: start, message, stop. `agents.createSession`, `agents.send`, `agents.interrupt`, `agents.forkConversation`, `agents.switchTool`, `agents.exportHandoff*`, `agents.updateSettings` | Has it | `create_session`, `send_to_session`, `agent_session` (`stop`, `send`), `start_agent` (a fork), `handoff_session`, `update_session_settings`, each behind the target's preset |
| Reading sessions. `sessions.list`, `messages.load`, `messages.subagent`, `messages.search`, `agents.worktreeStatus`, `agents.autoCompact` | Has it | `list_sessions`, `read_session`, `recall`, `agent_session` (`status`, `list`) |
| Answering a waiting session. `agents.respondApproval`, `agents.answerQuestion` | Has it | `answer_question`, the target's preset and the delegation rules decide (security-boundaries/approvals.md) |
| Deleting a session. `agents.deleteSession` | Has it: its own children (`agent_session delete`), and any other worker session behind a card (`delete_session`, #1219 fourth slice) | A move to the session archive keeps the conversation, the worktree and the tool's file but not what the host holds for the session (a caller's wait for its report, delegations, grants, standing start_agent cards), so `delete_session` **asks**, naming that (the messages waiting for its answer and the tasks it owes a report of too, since restoring brings none back), when moving the session drops any of it (#1512: `agents.archiveIfAtRest` moves a session only when the list is empty and it is still at rest; the window's dialog reads the losses when it opens (`agents.archiveLosses`, read only, #1595) and calls it on an Archive that has not shown them, and when it lists losses the person confirms again (#1589); an idle local session nobody waits on is moved with no card unless the caller runs under `safe`, since the move is undone with `restore_archived` or Settings → Archive), and the host decides in the step that moves it (a message the person sent meanwhile keeps the session). It refuses the caller itself, an Assistant or coordinator, a child of the caller (that is `agent_session delete`, #637), a session that is working, waiting on the person or running a background job (archiving ends its process), and one on a machine that cannot be reached |
| Restart or resume. `agents.restartSession`, `agents.resumeSession` | Has it | A send to an asleep or stopped session wakes it |
| Housekeeping of a session. `sessions.rename`, `agents.clearBackgroundTasks` | Has it (#1219, fourth slice) | `rename_session` (a worker session; the answer quotes the old name, so it can be set back) and `clear_background_tasks` (ended tasks only; running ones stay): no card |
| Reading how the agent CLIs stand. `agents.detect`, `agents.usage`, `agents.models` | Has it (#1219, fourth slice) | `agent_status` (installed, logged in, plan and limits) and `agent_models`: read only |
| `agents.stopBackgroundTask` | **Person** | It ends a process the session started, which cannot be undone. A child the Assistant started is stopped with `agent_session` (`stop`) |
| `sessions.clearError` | **Person**, window only (`window` in `method-rights.ts`) | Done on an error moves the session to idle (#1549): an agent's script must not hide a failure of its own. It carries the newest row the window saw (`seq`) and clears only an error no newer row follows |
| `sessions.markRead`, `sessions.reorder`, `projects.reorder` | **Person** | Marking a session read hides a notice the person has not seen; the order is the person's arrangement of their own sidebar |
| `agents.account`, `agents.capabilities`, `agents.commands`, `agents.listExternalSessions`, `messages.image` | Not an errand | An opaque account fingerprint that only means something compared between two machines (#726), what the composer's menus draw, the "Past conversations" import dialog, and a picture for the screen. No command imports a past conversation |
| MCP and skill proposals. `agents.mcpProposals`, `agents.skillProposals` (the lists) and the `resolve*` calls | Proposing has it (`propose_mcp_server`, `propose_skill`); resolving is **Person** | Approving installs code or changes every Assistant turn from then on. `agents.orchestratorSkills` and `agents.deleteOrchestratorSkill` (and their twins `agents.assistantSkills` and `agents.deleteAssistantSkill`, #2133): **Person**, they edit the Assistant's own instructions |
| Preferences. `prefs.get`, `prefs.set` | Has it for theme, text size, fonts, line height, idle sleep, sending with Ctrl+Enter, folded groups and (#1978) the models for started agents; the rest **Person** | `sessionTools` is not a setting (always on, 2026-10-20). `agentCeiling`, `agentDepth`: has it (#1219, third slice), `set_agent_limits`, every change behind a card. `agentModels`: has it (#1978), `set_preferences agentModels`, no card. `hubAuto`: no field of the Assistant's; `prefs.set` and `machines.hubAuto` turn it on or off with no card, with the limited credential too (owner decision 2026-11-05). `sendWithModifierEnter` and `foldedGroups` (#1219, fourth slice): `set_preferences` sets them with no card (a way of typing and a way of looking; folding names the sessions whose children fold, by id). `accent` is gone from the product (2026-10-20): not offered, and refused by name |
| Themes. `themes.list`, `themes.save`, `themes.remove` | Has it (#1978) | `get_preferences` lists the files, `set_preferences themeFile` writes one, `deleteThemeFile` removes one (kept in `.removed/`). `themes.import` (a file from elsewhere on disk) and `themes.resolve` (a path for the shell) are not an errand: `themeFile` takes the content itself |
| Update switches. `updates.status`, `updates.setAuto`, `updates.setAutoApply`, `agents.versions`, `agents.setAutoApplyVersions` | **This change** | Turning "Automatic updates" **on** (`autoUpdate`, both halves) asks (it installs and relaunches without a later question); the rest act at once. `updates.apply` has `update_centralu install`; `updates.answerApply` and `updates.reportApply` are the window's side of an apply |
| Idle sleep. `agents.sleepPolicy`, `agents.setSleepPolicy` | **This change** | |
| Agent CLIs. `agents.applyVersions` | Has it (#1219, fourth slice) | `apply_agent_versions`: the header's "restart idle sessions on the new CLI", at once and with no card; each restart ends a turn only when idle, and a busy session, or one that spoke within the last minute (`keepQuiet`: the Assistant is not the person's own button), is named and left |
| Notifications. The switches `approval`, `done`, `whenFocused`, `sound` (`notifyPolicy` in `prefs.get` / `prefs.set`, which still carries `error` and `allDone` for older builds; the window no longer raises those two, 2026-10-20) | **Has it** (#1306) | `set_preferences notifications`, no card, except to turn `approval` off, or `sound` while it would still notify. They moved from the window's workspace snapshot into the host's preferences record (as the text size did, #312), carried from the snapshot once; the window reads and writes them through the host and hears every change (`prefs_changed`) |
| When agents compact (#1376). `autoCompact` in `prefs.get` / `prefs.set` | **This change** | `set_preferences { autoCompact: { controlled?, share?, idleShare?, nudge?, nudgeFirst?, nudgeSecond? } }`; no card (reversible, and only about when an agent compacts). Reaches a session when its process next starts |
| The session archive. `trash.list`, `trash.read`, `trash.restore`, `trash.restoreSubagentSteps`, `subagents.usage`, `subagents.trash` | **This change** | List, restore a session or its subagent steps, move subagent steps to the archive: no card. `trash.read` (an archived conversation) and `trash.readRun`: not an errand: `restore_archived` then `read_session` reads a conversation, with the fencing `read_session` has; a second reader of conversation text would need its own |
| Deleting for good. `trash.purge`, `trash.purgeSubagentSteps`, `trash.purgeRuns`, `trash.empty` | **This change**, behind a card naming what goes | One session, or one session's archived steps (`delete_archived`), or all of it (`delete_all_archived`). `trash.empty` itself is not called: it takes everything there is, and `delete_all_archived` deletes what its card named, one call each |
| Workspace layout. `workspace.save`, `workspace.load`, `grid.get`, `grid.set` | **Person** | The window's own state, written whole by one writer (`saveWorkspace`); a second writer erases the other's fields |
| Projects. `projects.add`, `projects.inspect`, `projects.create`, `projects.createPreview` | Has it | `add_project`, `create_project`, each behind a card |
| `projects.list` | Has it (#1219, third slice) | `list_projects`: names, ids, folders, machine and trust |
| `projects.gitStatus`, `projects.origin`, `files.search` | Has it (#1219, fourth slice) | `project_git_status` (branch, changed files, origin) and `search_project_files` (by part of a name, as the composer's @ does): read only |
| Project trust. `projects.setTrusted` | Has it (#1219, third slice) | `set_project_trust`: both ways ask (taking trust away drops the project's own deny rules and hooks); trusting's card names the folder and each app with what it may ask for; both checked again after Allow |
| Project commands. `projects.setCommands`, `projects.setWorktreeSetup`, `worktrees.setTrunk`, `projects.delete`, `projects.reorder` | **Person** | Commands and worktree setup run shell commands; `projects.delete` can trash a folder |
| Git and files in a project. `git.*`, `fs.*`, `attachments.save` | **Person** | The window acting on the person's own repository and files. The Assistant hands this to a session in the project, which has the tools and the preset that decide it |
| Approval rules. `approvals.rules` (read), `approvals.deleteRule` | Has it (#1219, third slice) | `list_approval_rules`, `remove_approval_rule` (it only narrows: no card). No command adds or widens a rule; the window has no such call, and a rule comes only from the person's "always" on a card |
| Apps. `apps.list`, `apps.create` | Has it | `find_apps`, `attach_app`, `detach_app`, `create_app`; an app's own tools reach a session through the `app` tool (#2231) |
| App grants. `apps.permissions`, `apps.forgetPermission`, `apps.setShared`, `projectConsents.list`, `projectConsents.revoke` | Has it (#1219, third slice) | `list_app_grants`, `forget_app_answer`, `revoke_project_consent` (they only make the next attempt ask: no card), `share_app` (on asks, with a card naming the app and what it may ask for, checked again after Allow; off acts at once) |
| App trust and imports. `apps.reach`, `apps.enable`, `apps.review`, `apps.setSecret`, `apps.importPrepare`, `apps.importCommit`, `apps.importCancel` | **Person** | Enabling an app is trusting its project since #1141 (`set_project_trust`); importing one brings code in; a secret's value is never handed to an agent |
| App upkeep. `apps.remove`, `apps.restart`, `apps.versions`, `apps.restoreVersion`, `apps.check`, `apps.runs`, `apps.errors`, `apps.usage` | Has it (#1219, fourth slice) | `remove_app` behind a card (the user-folder app's folder moves to `app-trash/`, and it is detached from every session). `list_app_versions`, `list_app_runs`, `list_app_errors`, `app_usage` read; `restore_app_version` (the code it replaces is kept first), `restart_app` and `check_app` act at once but are refused while another session, screen or app has a call in progress in the app (a restart ends it, as the window's Restart does). What an app wrote is quoted as data |
| `apps.questions`, `apps.answerQuestion` | **Person** | A capability question a chain from a screen the person is looking at is waiting on: the answer is a trust decision (it is remembered for the app), and the Assistant can already narrow one afterwards (`forget_app_answer`) |
| The app builder's channel. `apps.builder`, `apps.createBuilder`, `apps.askBuilder`, `apps.sendError` | Not an errand | How an app's screen talks to its building session. The Assistant reaches that session as any other: `list_sessions`, `read_session`, `send_to_session` |
| App screens. `apps.viewFrame`, `apps.viewDocument`, `apps.openView`, `apps.closeView`, `apps.recoverView`, `apps.holdViews`, `apps.inlineReopen`, `apps.inlineViews`, `apps.viewMessage`, `apps.readResource`, `apps.invoke` | **Person** | Drawing and clicking an app's screen: they have no meaning without a window |
| Linked machines. `machines.list`, `machines.add`, `machines.remove`, `machines.reconnect`, `machines.setAutoReconnect`, `machines.install`, `machines.update`, `machines.autostart`, `machines.probe` | Has it (slice 1, #1238) | Six commands and `list_machines`; add, install, update, remove and start at boot behind a card |
| `machines.disconnect`, `machines.rollback`, `machines.uninstall`, `machines.sshHosts`, `machines.activity` | Has it (#1219, fourth slice) | `disconnect_machine` acts at once (the row's button; connecting it again asks, #1341). `rollback_machine` and `uninstall_machine` each ask, in every preset, with a card naming the machine and what happens there (the versions, that the Centralu there stops, what is removed and what stays, and that a disconnected machine is connected for it). `machine_activity` and `list_ssh_hosts` read |
| `machines.acceptVersions` | Not an errand | Since #689 two versions of one protocol connect by themselves (`mayConnect`), and for different protocols the call refuses, so there is nothing to accept; it is the window's answer to a prompt that no longer comes |
| What a machine's sessions may ask of this computer. `machines.setAsks`, `machines.askConsents`, `machines.withdrawAsk` | **Person** | It widens what code on another computer may do here (#550) |
| Host to host. `host.activity`, `host.sessions`, `host.readSession`, `host.recall`, `host.lastAnswer`, `host.send`, `host.stop`, `host.handover`, `host.hubOffer` | Not the window's | Answered for a linked hub or a switch; no window calls them |
| Terminals, commands and processes. `terminal.*`, `commands.*`, `processes.strays`, `processes.stop` | **Person** | A shell and run commands on the person's behalf, and stopping a process; the Assistant has no shell of its own, its sessions do |
| The Assistant's own channel. `assistant.get`, `assistant.peek`, `assistant.configure`, `assistant.tools`, `assistant.tool`, and the same under `orchestrator.*` (#2133) | Not an errand | How the window and the bridge reach the Assistant itself |

The same methods are classified once more for a caller that is neither the window nor the Assistant (#1405): a
script or tool holding the limited credential runs the everyday ones and is refused the rest
(`transport/method-rights.ts`; the classes and the rule in [security-boundaries/credentials.md](../../security-boundaries/credentials.md), "Who holds full power"). Everything this table cards in every preset is `asks` there.

The linked machines came first (#1238), then the preferences and the session archive (#1309) and the notification switches (#1313).
The third slice is trust, as the owner asked (2026-10-20): project trust first (`list_projects`, `set_project_trust`),
then approval rules, app trust and grants, and the Assistant's own limits. In each, what narrows trust acts at once
and what widens it waits for the person's card, which names exactly what changes and is checked again after Allow.
The fourth slice finished the inventory: the machine calls left (`disconnect_machine`, `rollback_machine`, `uninstall_machine`, `accept_machine_versions`, `machine_activity`, `list_ssh_hosts`), deleting a session that is not the caller's child (`delete_session`), app upkeep (`remove_app` behind a card, and `list_app_versions`, `restore_app_version`, `restart_app`, `check_app`, `list_app_runs`, `list_app_errors`, `app_usage`), the harmless preferences and `apply_agent_versions`, and the housekeeping and reads (`rename_session`, `clear_background_tasks`, `agent_status`, `agent_models`, `project_git_status`, `search_project_files`). Where the slice did not give a method a command, the row says why: the person's (it cannot be undone, or it hides something from them), or not an errand.
