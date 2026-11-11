# Applying an update, seen from the host (#352)

The design is in [architecture.md](../../architecture.md) §4.5. The host's part is the install and one rule.

**Checking (#635).** Startup and the six-hour background interval remain unchanged. Opening Settings → Updates
forces a check only with automatic checking on; with it off, use Check now. It asks each time Settings opens, also when
Settings is reopened during its closing fade with the view still mounted (#2155). The host runs one check at a time
(`inFlight`), but the window's own requests (its check on connect, the check as Updates opens, an install, the
switches) are answered independently: the window numbers them in the order it asked and drops an answer older than
the newest it has shown, and a failure of such an older request raises no toast (#2155, `packages/ui/src/store/updates.ts`).
The host's `update_status` events are always taken, as its newest state. Focus/visibility restoration also
checks only with automatic checking on, when the last successful check is more than an hour old; attempts are
throttled for an hour, including failures and paired focus/visibility events. Checks leave an active install or pending apply alone. A failed install
keeps its phase and error throughout later checks, until the next install attempt. Successful ordinary checks
follow npm exactly, including a lower `latest` after a dist-tag rollback, and recompute whether it is newer.

**The install** (`updates.ts`). Before installing, `updates.apply` refreshes the registry with the forced eight-second
deadline unless a successful check is less than one minute old, avoiding a second request when a check starts
auto-apply. With nothing newer known (automatic checks off, or a stored "up to date" hours old) it refreshes first
rather than refusing, reporting `checking` while it looks; nothing newer is then a result (`idle`, no error), never
`failed` (#645). The call answers once the target is settled — after the lookup, as `npm i -g` is about to start, or
with that result — not when the install is done. Only during installation, a stored version seen less than one hour ago may win over a lower fresh
answer to tolerate a stale npm edge. Retaining it preserves its original check time; an older stored version yields
to the fresh tag so a release rollback takes effect. A target at or below the running version installs nothing.
If the refresh fails, it installs the stored version and keeps a fallback notice during and after installation.
Lookup, npm retries and bundle replacement are one busy operation; concurrent checks/clicks cannot replace its target or start a second install, and answer with that target once it is settled (#2131 review), not with the release the status named while it looked. It runs `npm i -g --prefer-online centralu@<v>` and, when the installed app exists,
`centralu install`, then reports `restart_required`; it never restarts anything. npm is the source of truth for
releases, so the copy is replaced whatever released version it holds, a higher one too: a release pulled from
`latest` must not survive in /Applications to be offered by "Apply now". The one copy left alone is a maintainer's
local build (`<base>.local.N`, `pnpm local-update`, #610/#613) newer than the target, waiting for "Apply now";
putting the release it was cut from over it would undo it (`keepsInstalledCopy`, mirrored in the launcher's
`semver.mjs`). A version that cannot be read or is not well-formed SemVer in that shape is replaced, so a corrupt
plist or version file cannot block updates. The version is read the same way as the launcher reads it
(`readInstalledCopyVersion`: `plutil -extract CFBundleShortVersionString raw` on the bundle's `Info.plist`, XML or
binary, on macOS; the launcher's `centralu-version.txt` on Windows; on Linux the `package.json` beside the AppImage the
menu entry's `Exec=` starts, #1736). When a local build is kept,
the package is still updated, `restart_required` carries a notice naming it, and the window's own bundle check offers
to apply it. `centralu install` applies the same rule by itself and takes `--force` to replace such a copy on
purpose (#645). With `autoApply` on ("Apply updates
automatically when idle", `updates.setAutoApply`, saved as `updates.autoApply` in the store's app settings, off by
default) a check that finds a newer version starts the same install by itself, and turning the setting on with a newer
version already known starts it at once. Not over an install under way, nor again over one already finished: a check
after it still asks the registry (#2130), since a host may wait days to be restarted, but the release it installed, or
an older one, leaves `restart_required` as it was, so that release installs once. A release past it is reported as
newer (`idle`), and installing it, by a click or by itself, replaces the waiting build; the window then offers it
rather than the build on disk, which an agent can still apply. A failed install of it, also one npm took whose copy was
not replaced, stays `failed` and is retried as any failure is; the line shows its error beside the build on disk. A failed install stays visible until another install attempt;
a background or requested check does not erase its error. With `autoApply` on, the host tries again by itself on a
backoff — 10 minutes, then 1 hour, then every 6 hours — from a timer kept in memory (#645): a check that lands
before the delay starts nothing, one after it retries too, and a release other than the one that failed is tried at
once. The error stays on the line until the next attempt starts; success, turning the setting off and shutdown end
the retries. Without the setting a failure is left for the person, as before.

On host shutdown, pending lookups and npm waits cannot start another command or publish stale completion. A command
already launched is not undone. After reconnect or a host swap, the window re-reads status without replaying the
install, and ignores replies from the previous host lifetime.

Both commands run without a shell. `npm` goes through `tool-launch.ts` (`commandFor` in `updates.ts`): on Windows it is a
batch file, which `execFile` cannot start by name (ENOENT) or by path (EINVAL), so it is read for the `.js` it starts and
that runs under the host's Node. `install` is the launcher npm just installed, found by `npm root -g` and run by the host's
Node (`installCopy`), never `centralu` from PATH, which on a machine a hub manages may be the hub's shim (#1736). The installed app it refreshes is `installedCopyPath()`, the
launcher's `installedPaths()[0]` per platform (a test holds the two together). A failure says which half failed: npm's
own last line (not its pointer to the log), or, when npm worked and only the copy did not, the launcher's first line,
the copy's path and `centralu install` to finish by hand.

**A release arriving at npm.** The `latest` tag can reach this host before the package version has reached the npm
edge it installs from. On npm's narrow `ETARGET`/`notarget` response only, the host retries the exact install with
`--prefer-online` for up to ten minutes, reporting `waiting_for_npm` and “Waiting for npm to serve <version>” between
attempts. Other failures still fail at once; a bounded propagation wait must not hide a credential, disk or package
error.

**Agent updates (#581).** `update_centralu(action: "check" | "install")` reaches the same `UpdateService`
methods as the window. In the commands tier it is discovered and run through `centralu_commands`, `centralu_help`
and `centralu_run`; an ordinary session gets a minimal definition, deferred behind Claude's tool search
like `app_guide` because updates are rare (Codex is offered it without a deferral flag). Its first call raises a consent card:
allow once, or always for that session until the host restarts. It never calls `updates.setAutoApply`, so an agent
cannot change the person's automatic-apply preference with it. (The Assistant's `set_preferences` can turn it on, behind a
card in every preset, [../assistant/window-parity.md](../assistant/window-parity.md#the-inventory-behind-1219-what-the-window-calls-and-what-the-assistant-reaches).) An install starts the normal host install; the window still
performs its own safe relaunch step.

**Applying for an agent (#665).** `update_centralu(action: "apply")` is the window's "Apply now" asked for by an agent.
Only a window can relaunch, so the host asks over the event stream (`update-apply.ts`, `UpdateApplyBroker`): an
`update_apply_request` that every window answers with the checks its button makes (`agentApplyVerdict`: a relaunch
port, an installed build newer than the window, and a bundle on disk whose own version, read by the shell from its
`Info.plist`, is newer than the window and the same as the installed one), through `updates.answerApply`. The
shell's `ready` alone says only "another build": an older app restored over the installed one is one too.
The first window that is ready gets a ticket. With none ready, the call ends with the windows' reasons ("nothing is
installed", "already runs it", a browser window that cannot relaunch) or, with no window open or none answering
within 5 s, says so. Then the caller's own preset decides, as for every Centralu boundary (#606): `auto` goes on and
is logged, `normal` raises a card (its "always" covers applying for that session only, apart from check and
install), `safe` and an agent an app started are refused before any window is
asked. `normal` raises no card while the person's Automatic updates are on and the host is idle apart from the caller's own
turn (#1509, owner 2026-10-24: the window's own auto-apply would relaunch at that moment; `updateAtRest` in main.ts,
`hostBusyBesides` in `idle.ts`). That is judged in the consent step, after a window said it is ready, and again after the second ask of the
windows, right before `update_apply_go`, which then carries `unasked` (additive): the window waits out someone typing
(`TYPING_QUIET_MS`) as its own automatic apply does, and reports that instead of relaunching. Nothing is remembered, except that a card-free relaunch that failed brings the card back for that installed version, for every session, so an agent cannot retry it in a loop with no one asked. The limited credential's `updates.apply` reads the same state (`RightsHost.updateAtRest`). After consent the windows are asked again, since a card can stand for minutes, and `update_apply_go` names the
first ready window's ticket. That window alone checks again, reports `started` through `updates.reportApply`, runs
`applyUpdateNow` (the keeper is told, then the shell relaunches) and reports the outcome. Only after `started` does its
connection ending count as the relaunch, since a relaunching window can close before its last report; ending before
it is given 5 s to come back and report, then answered as "whether it relaunched is not known". Reports are matched
by ticket, not by connection: only that window was given it, and a window that reconnected has a new connection.

The card rides on the `other` detail, `{ kind: 'other', raw: <question>, about: 'centralu_apply' }`, rather than a
new kind or a new `centralu_update` action: a released window parses events strictly and drops one whose detail it
cannot parse, while `other` with its text has been read by every build. The question says what the relaunch costs: since
#1895 step 3 the host restarts, so running turns in every session, the asker's included, stop and go on once it is back,
and terminals and Run commands start again (`CENTRALU_APPLY_QUESTION`). One window relaunches: one ticket goes per request, and the
window relaunches only after its keeper has stopped for the update. A replayed request or go starts nothing (the
host is no longer asking, or the window no longer holds the ticket), a linked machine's apply events never reach a
hub's windows (`links/qualifier.ts`), and a host swap in the middle ends that host's requests: the next host knows
none of them, and the agent's call is cut at the drain like any in-process tool call.

**Without a keeper** (#1895, owner 2026-11-03: stop and continue on every machine). A window that starts its host itself (macOS `Direct`:
a debug build, or the release once the app starts it so) is the host's parent, and a relaunch would end the host as a quit does. So
`apply_update_relaunch` first stops the host for an update (`Supervisor::stop_host_for_update`), waits for it to end (up to
`STOP_FOR_UPDATE_WAIT`, 15 s: the host's own shutdown ends at 10 s), starts no other, and then relaunches. The stop is the one a linked
hub's `host.stop { forUpdate }` is ([../remote/install-and-update.md](../remote/install-and-update.md)), asked by a line on the host's stdin, `{"op":"stop","forUpdate":true}`, since the window
speaks no WebSocket and `host.stop` is refused to a host the app runs (a hub linked to it must not be able to stop it): the host
takes it only from the window that started it (`CC_STARTED_BY=app`), through `stopFromRequest`, the function `host.stop` calls. The
host the relaunched window starts continues the turns the stop ended, tells the agents of the background tasks and cards it ended,
and opens the terminals and Run commands again. A host that does not end in time is stopped the usual way, and its turns end as a
quit's. The update line says so (`RelaunchCheck.restartsHost`). Only where `relaunch_info` is ready, as with a keeper: from an app
bundle the update replaced (macOS). No Linux package or Windows install is a bundle, so those keep "Restart Centralu to finish
updating", and the busy report is the keeper's, so nothing applies by itself without one.

**The keeper holds no children** (#1895 step 3, owner decision 2026-11-03, option C; the removal that follows is
the removal design of #1895 step 4, [plans/keeper-removal.md](../../plans/keeper-removal.md), whose PR 1 to PR 3 are built). The macOS release keeps its shape, shell then keeper then host, because the
release is ad-hoc signed and only a tree the shell starts keeps its macOS permissions across updates ([plans/thin-shell.md](../../plans/thin-shell.md)
§1, §2): agents the host spawns itself are still in that tree. What changes is that a keeper started fresh serves no child socket,
so the host spawns its own children as on every other machine, and every ending stops them. The host does not look for the socket at all, and the keeper has no children service ([children.md](children.md)):

| | Now |
|---|---|
| "Apply now" | the window sends `{"op":"stop","forUpdate":true}` on `keeper.sock`; the keeper writes the host's stop line for an update (the one in [children.md](children.md)), waits up to 15 s, answers, and exits; the window relaunches and opens the shell, which starts the new build's keeper. The next host continues the listed turns with Centralu's note and opens the terminals and Run commands again. No keeper runs a host of another build. Only a window may ask (anyone else gets `window_only`: an agent's Bash could otherwise cut every turn and have it continued as an update's), the window whose executable the install has just replaced included: it is known by its pid and start as it attached (#2117, [security-boundaries/keeper.md](../../security-boundaries/keeper.md)), also when it attaches again after the install, since the keeper keeps every window it took while that process runs (#2119). A keeper started after the install knows no window from before it; its refusal says that only a window attached to it can stop it, and, to Centralu's own window, to quit Centralu and open it again, which runs the installed build. A refusal (the keeper stopping, a host not up) stops nothing and is shown with its own reason; a "Quit completely" during the stop is refused ("Centralu is stopping for an update; quit again once it has relaunched") and sends nothing, since that stop lists the turns it cut and leaves no quit mark for a linked hub (#1143); the relaunch goes on and the person quits there. The same refusal answers a quit while the build bar's restart has the keeper stopping for an update (its socket gone, its process still running) |
| The automatic mode | the same (`RelaunchCheck.idleReported`): with nothing busy the stop loses nothing |
| A host crash | the keeper restarts it by the same rules; the agents, terminals and commands end with it, and a turn in flight shows stopped with Continue, as on Windows and Linux. Only a stop for an update lists turns to continue |
| "Quit completely", background mode off, idle exit | a plain `{"op":"stop"}` on the host's stdin (`STOP_LINE`): the same stop and the same mark |
| Background mode, credential issuance (#1405), the front door, supervision, per-build copies | the keeper's |
| A window of another build opened by hand | "Restart into this build" ("Go back to this build" when the keeper is newer): a keeper whose view says `stopsForUpdate` gets `{"op":"stop","forUpdate":true}`, so the next host continues the turns; any other a plain `{"op":"stop"}`, which ends them as a quit does. The confirmation names that loss; it is asked when the keeper does not report itself idle, and always before a plain stop, since a keeper whose host is down reports idle whatever it still holds. The window keeps attaching, and its run loop starts a keeper of its own build. With automatic updates on, a window newer than an idle keeper that can stop for an update does this by itself, once per window and not after the bar was dismissed; it never moves a keeper back to an older build. Whether a host can stop for an update is what it said at its start (`{"swap":{...,"stopsForUpdate":true}}`); before #1895 step 4 PR 4 a handoff did not pass it on, so a keeper that took a host over read "cannot" until it started a new one. Between step 3 and step 4 PR 3 this was "Switch to this build", whose swap's drain stopped the host for an update |

The window knows the keeper does this from its view (`stopsForUpdate`), and sets `RelaunchCheck.restartsHost` then. A keeper whose
view lacks it (an earlier build, or one that took its host over from one) gets no "Apply now": the update line says it cannot stop the
agent host for an update and to restart it from the build bar first, or to quit Centralu completely (`KEEPER_TOO_OLD_TO_UPDATE`).
A window that cannot tell (Windows, Linux, a
browser, one not attached to a keeper yet) says only that restarting Centralu applies the update.

*A keeper of beta.48 or earlier still running.* A person on an earlier build presses "Apply now" there; the new window offers "Restart into
this build", a plain stop that ends what that keeper holds as a quit does. That keeper swaps its host to this build under itself anyway, no
host of this build stands by for it ([front-door.md](front-door.md)), so the swap fails before the running host is touched and quitting completely is the update. A
host of that keeper's that exits comes back as this build with no window involved, so the host keeps one small check until step 4 PR 6
(`lifecycle/keeper-held.ts`, through `keeper.sock`'s read-only `children` op and `children.sock`): a plain start under such a keeper ends what
it holds before the host restores its sessions, so their turns show stopped and Continue starts the only CLI (an `ok: false`, no answer or an
unreadable list ends nothing). It signals each child's process group through the service and, for a terminal, every group in the shell's session (found by its controlling terminal), so a job the shell put in a group of its own (`sleep &`) ends too. A keeper of this build serves no `children.sock` and answers `children` with an empty list, so nothing is asked.

The automatic mode ("Automatic updates", on unless the person turned it off) still waits for the keeper to report nothing busy. An
update stops the host (by the keeper), and that stop is what a busy host can
lose: a Centralu tool call still running (a `start_agent` or `agent_session` wait, an `ask_project`, an app tool) is cut and has to be
tried again, and running turns are cut and continued. An Assistant with working children is almost always inside such a wait, so
dropping the busy rule would cut those waits on every automatic apply. An agent's explicit apply makes that choice for
itself, as a person pressing the button does, and its own call is answered before the stop begins.

**On Windows**, measured on Windows 11 on 2026-10-08 with a temporary npm prefix and a stand-in holding the same
handles as the running app (an exe started from the folder, the host's `better-sqlite3` and `node-pty` modules mapped):

| Step | What happens |
|---|---|
| `npm i -g centralu@<v>` | Succeeds while the app runs, from the installed copy or from inside the npm package |
| `centralu install` | Renames `%LOCALAPPDATA%\Programs\Centralu` aside to `Centralu.old-<time>` and the assembled `Centralu.new` into its place. NTFS allows the rename with the exe and the native modules in use; it refuses only while some process's working directory is inside. The app moves its working directory out of its own folder at start (`leave_app_folder` in `src-tauri/src/lib.rs`), since File Explorer starts an exe in its folder and the host inherits it. The aside copy cannot be deleted while the old app runs; the next install sweeps every `Centralu.old-*` it can |
| The running app | Keeps the files it has open. Windows still reports the exe at its original path, so anything opened by path afterwards is the new copy's, a host restarted by the old window included (inferred from that path, not run) |
| "Apply now" | Not offered: there is no keeper, so a relaunch would stop every agent (`relaunch_info`). The line says "Restart Centralu to finish updating to <v>"; quitting and opening it again from the Start menu or `centralu` starts the new copy |

Builds up to 0.1.0-beta.12 cannot update themselves on Windows (their host ran `npm` by name: "Update failed", `spawn
npm ENOENT`), and the fix only runs once it is the installed build. Updating to it takes `centralu update` in a
terminal once; that goes through a shell and works while the app is open.

**The rule** (`idle.ts`). `hostBusy(snapshot)` is the one answer to "would someone lose something if this stopped
now": a live session working, waiting for an approval or on a question, or running background work that counts as
activity (#290); an open terminal; a running project command. A session whose turn has finished (`waiting_input`, what
`turn_complete` leaves until the next message) is idle: its answer is stored. A waiting
question is counted by `pendingQuestions`, not by the state. The snapshot is `activity()` in `main.ts`, with the
manager's session list, which carries pending approvals and questions and background tasks. The keeper reads it through the activity report ([keeper.md](keeper.md)) for its idle exit;
the window gets it from the keeper's view for the switch's question and for applying an update when idle. An open
terminal counts even at a prompt: the host cannot tell an idle shell from one running a command, so the automatic mode
waits for terminals to close. Moving one session to a newly installed agent CLI (#297) uses the same file's narrower
rule, `sessionIdle` ([agent-cli-updates.md](agent-cli-updates.md)).

**What the host sees.** A stop for an update, by the keeper's stop line. It stops this host's agents,
terminals and commands, and the next host continues the listed turns and opens the terminals and Run commands again.
The new host's update status starts fresh at its own version.

The desktop mounts the app once it has a host, with no swap to wait for: the relaunch swap and its start-up wait (#580)
went with #1895 step 4 PR 3, since the window no longer switches a keeper. `e2e/relaunch.spec.ts` boots the real desktop
entry with a mocked shell boundary and checks "Apply now" against a keeper that can stop for an update and one that
cannot, and the build bar's restart.
