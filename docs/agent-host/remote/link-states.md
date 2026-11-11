# The link's states, versions, and the Assistant across machines

**The link's states** (`MachineInfo.status`, sent as `machine_status`): `connecting`; `connected`; `away` (#1398: the
machine does not answer at all: ssh's connect timed out, there is no route, or the name does not resolve (`links/away.ts`, ssh's own
words, on the whole last line of an exit-255 failure, so a program on the remote that prints "timed out" does not make a machine away, and a
banner exchange that timed out, which something answered, stays an error); asleep, off or off the network, not an error. `error` keeps ssh's
line for the details; `lastConnectedAt` says when the link was last up, the moment it dropped and not its hello, kept in the store
(`app_settings`, `links.lastConnected.<id>`, no migration step) so it survives a restart of this host; and `nextAttemptAt` when the hub
tries again, told to the windows at each attempt although the status does not change. The status stays `away` between the backoff's attempts
instead of flipping to `connecting` and back; the person's Connect shows `connecting`, also when it joins an attempt under way, and so
does the first attempt ssh gets an answer to. The row (Settings → Machines) says "<name> is not reachable: asleep, off or off the network",
then when it was last connected and when it tries again, then ssh's line; the sidebar's status word stays "away" for it and for `unreachable`. Retried on the backoff below while Auto reconnect is on; with it off, `nextAttemptAt`
is null); `unreachable` (the machine answered or was linked and then failed: an ssh it refused (a key, a host key, a refused connection), a
link that dropped, the forward or the socket; `error` says why; retried with backoff from 2 s to 5 minutes while Auto reconnect is on, #1134, #1341; with it off, not until the person's Connect); `starting` (no host ran
there; the link is starting one, above); `updating` (the hub is stopping, switching or removing the Centralu it installed there; the link waits, above); `not_running` (Centralu answers there but no `centralu serve` runs, and
starting one failed, `error` says why; retried); `versions_differ`; `refused` (a token refused twice in a row:
the connection line is read again once at once, since `--rotate-token` changes the token a running serve keeps until
it restarts); `disconnected` (#1134: closed on purpose and not tried, below); `stopped` (#1143: the person stopped
Centralu there, or the hosts the link started kept stopping; the link starts none until the person's Start, above).

**Auto reconnect** (#1341, owner decision 2026-10-20; `MachineInfo.autoReconnect`, kept in the `linked_machines.connect`
column of v59 with no new step: null is on, `when_needed` is off, which is where the older connect mode kept its choice, so
a machine set to "when needed" reads back with the switch off and a build still serving during a host swap reads the same
value as it always did; a later release may add a column named for the switch and drop this one, add first and remove
later). One switch per linked machine, on by default; it replaces the connect mode (`at_start` / `when_needed`, #1134).

*On* is what every machine did before: connected when the hub starts and tried again after every drop, on the backoff (2 s,
doubling to 5 minutes), so an Assistant working through it hears reports and cards as they happen.

*Off* is for a laptop that is often closed or a server used once a week: the hub tries **once** when it starts. After a
failed attempt, or a drop that the quick redials do not undo, it tries nothing more until the person presses Connect
(`machines.reconnect`: Settings → Machines, or the machine's badge menu in the sidebar). The quick redials stay (owner
decision): after a drop the client dials the same forward again a few times (`LINK_REDIALS`, about 6 s, no new ssh), so a blip
or a host swapped in place is back with no Connect; only when they fail does the link give up, close the forward and wait.
`LinkedMachineConnection.retryLater` does nothing for it, and the row says `press Connect to try again` where it says
`reconnecting` for a machine with the switch on. The one thing it still does by itself is look again at the versions of a
link held at `versions_differ` (every 60 s): it only reads the connection line, refreshes the row, and connects nothing
(`readsOnly`). Turning the switch off while connected leaves the link up; turning it on while the link is away tries again
at once. An attempt under way at the person's Connect, or the one immediate re-ask after a refusal, is part of that attempt
and goes ahead either way.

Nothing connects a machine on a need any more (`machines.need`, `NEED_HOLD_MS`, the idle disconnect and the 60 s wait of
`linked-sessions.ts` are gone). An agent's call that needs a machine nothing here will connect (the person disconnected
it, or its switch is off and the attempt at the hub's start is over: `LinkedMachineConnection.waitsForPerson`) is answered
at once: `start_agent` with the machine, `ask_project` on one of its projects, `agent_session`, a send to or a read of
one of its sessions say "is not connected, and nothing here connects it by itself; ask the person to connect it (Settings,
Machines, Connect)" (`NOT_CONNECTED` / `awayPhrase`, `adapters/contract/centralu-tools.ts`), and its projects are listed as
away with that reason. A machine with the switch on that is away between attempts is not waited out either (#1532): a call that
needs it starts one attempt at once, `LinkedMachineConnection.reachForCall` through the same `connect` that the row's Connect,
the badge's menu, the project menu's Reconnect and the Assistant's `reconnect_machine` use (`keepBackoff`: the backoff goes on
from the step it was at instead of starting over, and a call starts no host the link would not start by itself), and waits for it
(or for the attempt it found under way) at most `CALL_WAIT_MS` (10 s) from the moment it asks. Connected in time, the call goes through; not, it is answered "not reachable right now; the attempt to
connect it just now failed: <ssh's words>" (or "an attempt to connect it is still under way"), and the backoff stands. One attempt at a time per machine:
a call that finds one under way (the backoff's, the person's press, another call's) waits on it and starts none, so a press and a
call at the same moment make one attempt. Calls cannot defeat the backoff: a machine takes at most one attempt started by a call
per `CALL_WINDOW_MS` (15 s); a call inside the window is answered at once with the last attempt's reason. The calls are those that
reach the machine through `linkedSessions` (`start_agent`, `ask_project` and `create_session` through their project lookup, but
only for the machine the act needs: `start_agent`'s `machine`, or the one a project name, qualified id or `machine/name` points to
(`projects(need)`); a lookup never waits on another machine, nor on an attempt to one, with one exception (#1547): a bare name that matches no project at all (not on this computer, not on a machine that is up, not in any machine's mirror, which is empty after a restart and cannot know a project made since) tries every machine that is down, within the same bound (`ProjectNeed.anyDown`, asked by `ask_project` and `create_session` after their first lookup found nothing; the machines that are up are not asked again, their rows are the first answer, `prior`), and only then answers "No project named" (`create_session`: "No such project"), naming the machines it could not ask. A machine is waited for once per its call window (`callWindowMs`, 15 s) that way, counted from the guess whether it started an attempt or only joined one under way: a call inside the window joins the wait if it is still going, or is answered at once, without joining an attempt under way as `reachForCall` would. A name qualified with a machine or hub is answered by the first lookup alone, and the machines that did not answer stand as it held them. `create_session` names a project by the same match as `ask_project` (`matchProjects`: id, exact name, `machine/name`, the name in any case), over this computer and the machines, and says which machines it could not ask; a qualified name speaks only of its own machine (`awayFor`, which tells a machine's id from a bare name by the machines the lookup saw, `ProjectLookup.machines`, not by their projects), and the name is trimmed as `ask_project` trims it. The answer waits for the slowest of the down machines, since a same name on another one would make the choice ambiguous. A name qualified with a machine or hub never widens to the others; `agent_session`, a send to or a read of one
of its sessions) and the router's calls that come from no socket (no `ctx`: an agent's, an app view's);
a socket's calls (a window's, a hub's, a script's) start nothing, they poll. A refusal tells only the person where Connect is:
a call from their window (a full socket that shows their cards, `RpcContext.window`) or an app view (#1143); a hub, a script,
an app and an agent read the agent's sentence. Not for a machine that waits for the person, one whose host the person stopped
there, one at `versions_differ` or `updating`, or one held by an operation. What a child there reported meanwhile is read once the
link is up again. A parent waiting on a child whose turn is running is
told when the machine starts waiting for the person (`LinkedReports.linkChanged`: a link-lost report saying Auto reconnect is off and to ask
the person to connect it), judged by the link itself (`waitsForPerson`, sent with the `machine_status` of the moment it gives up) and not by
the row, which says `unreachable` while the client still redials, an attempt is under way or an install or update holds the machine: the
wait stands through those.

Its sessions keep running there meanwhile; on the next connect the window re-reads that machine (`machine_resync`) and
with it what they said. The row's Disconnect closes any link without unlinking the machine and tries none until Connect or
the hub's next start, with the switch on or off. An install, update or autostart change on a disconnected machine connects
it first, since it runs over the link's ssh, and leaves it up.

**Versions are checked before connecting** (remote-hub.md §4). The connection line carries the running remote host's `version`
and `protocolVersion`, and the hub compares them with its own before it opens the socket, and again with
`hello_ok.build` once it does. Another protocol never connects and holds the link at `versions_differ`. One protocol
connects whatever the app versions (#689): a different version of the same channel only names the older side, and the
row *offers* the update (the hub's through its own update, the remote's over ssh by `machines.update`) without
holding anything. A dev build has no older side. A local build (`<base>.local.N`) is compared as `<base>`. The update itself is the next step: the hub's through its own update, the remote's by hand in phase 1
(`npm i -g centralu` there) and over ssh in phase 3.

**After connecting**, the link reads the remote's `sessions.list` and `projects.list` into the mirror, notes which
sessions it hides (the remote's Assistant and coordinators, remote-hub.md §3.4), and broadcasts `machine_resync`; the
window re-reads that machine and wakes what died. The link keeps one cursor and epoch per remote, so a dropped socket
gets the gap replayed, and a remote that restarted is a new lifetime and a resync. Events of sessions the hub does not
show are dropped, and session events keep the mirror's names and states current between reads.

**The reverse direction is off** (remote-hub.md §3.2). The link is a client connection the hub opened. The protocol has no
frame for a host to call its client, and `RemoteClient` drops anything shaped like a request without dispatching it
(`remote-client.test.ts`), so a compromised remote cannot reach the hub through the link.

**The Assistant reads every machine** (phase 4 step 1, [plans/remote-hub.md](../../plans/remote-hub.md) §12.3;
`linked-sessions.ts`). The hub's Assistant's `list_sessions`, `read_session` and `recall` include each linked
machine's sessions, asked of that machine with `host.sessions`, `host.readSession` and `host.recall` (additive), which
it answers with the Assistant's own code over the view the hub's window has (`LinkedHost.hostReader`: no
assistant or coordinator; at most 200 lines and 50 hits per call). The hub qualifies the ids, names the machine on
each row and hit (`project api on Ubuntu box`), lists a machine it cannot ask from the headers mirror with why, and says
which machines it could not search. What a machine answers is fenced as a worker's text is (#121): names on one line,
ids that are not ids dropped, a conversation line that is not one line quoted. A manager, a lead and an ordinary
session keep their own machine's view.

**And directs them** (phase 4 step 2, remote-hub.md §12.4). `send_to_session` goes to the machine as `host.send` (additive),
delivered there as an instruction from `<assistant> on <this computer>`; with `reportBack`, `observeLinked` watches
the machine's relayed events for the end of that turn and reports it as for a session here, a turn that ends with the
session's own background work running included ([../delegation/start-agent-steps.md](../delegation/start-agent-steps.md) step 7, #723). The watch starts at the instruction's own
`user_message` there (#1082): a turn end relayed before it happened on the machine before the instruction was in, and
is an earlier turn's. A record lost before it was relayed is not waited for past the send's answer: the machine's events and answers come in order on one link, so from that answer on the next turn end reports, as before.
`update_session_settings` and `create_session` go through the router (`agents.updateSettings`,
`agents.createSession`), a project found by name or qualified id on any reachable machine, a name two machines share
refused with the ids. `create_session`'s first message goes as `send_to_session`'s instruction, its turn's end
reported the same way unless `reportBack` is false (#1233). `create_project { machine }` raises the same card, naming the machine (`project_create`'s
`machine`, additive), with the path that machine's `projects.createPreview` gives, and has that machine make it.

**Measured through the hub** (probe 3, 2026-10-05; a MacBook on Wi-Fi, the remote a Windows 11 laptop on the same
LAN; `centralu serve` of main in WSL2 and of beta.10 on Windows):

| | WSL2 Ubuntu | Windows (PowerShell) |
|---|---|---|
| Link to connected | 2.1 to 4.3 s | 2.3 to 3.7 s |
| RPC round trip through the hub, median / p95 | 5.4–12.8 / 7.7–36 ms | 5.5–22 / 8–68 ms |
| Keystroke to echo (one RPC per key), median / p95 | 8–16 / 12–35 ms | 16–31 / 17–46 ms |
| Terminal output, through the hub / straight to the remote | 6.3 MB at 7.5–15 / 5.5–8.7 MB/s | 0.34 MB in 10.0 / 9.5 s |
| `git.diff` of a 400k-line change (the host's 0.5 MB cap) | 240–290 ms | 310–365 ms |

The relay adds nothing measurable against the remote's own pace: Windows' slow output is ConPTY's, the same straight
to the remote host. The 64 MiB slow-reader cut was not reached.

**The window's side** (`packages/ui`; the recovery is in [state-management.md](../../state-management.md) §7):

| Where | What it does with the links |
|---|---|
| Sidebar | One project list whatever the machine (#734), in the order the hub keeps across machines: `projects.reorder` takes the whole list with machine-qualified ids, each machine saves the order of its own, and the hub saves the whole list in its store (`hub.projectOrder` in `app_settings`), so `projects.list` answers in it once a machine is linked; a project that order does not name yet (added since, or a newly linked machine's) goes at the end, with machines linked as with none. The order is checked before it is kept; an id the kept order has and a stale window's order lacks keeps its place after the id it followed, and an id the hub no longer lists is forgotten unless it is a linked machine's (which may only be out of reach). The answer holds every machine's projects, also a machine the order named none of. A linked machine's project, and its user-folder apps (a machine on a build from before #1141), which stand in "Other apps", carry the machine's name as a badge right of their name (cut with an ellipsis past 96px): a solid border while the link is `connected`, dashed otherwise (`connecting`, `away`, …); pressing it opens Settings → Machines, and its tooltip carries the link's last error. A project or session of a machine that is not connected stays listed, dimmed (`data-away`), and is never woken. Add project asks where once a machine is linked: this computer (the folder picker) or a connected machine, where a folder is added by its path (`projects.add {path, machine}`) or a new, empty one is made, in that machine's `~/Centralu` by default (`projects.create {name, parent?, machine}`, [../assistant/window-parity.md](../assistant/window-parity.md)) |
| Settings → Machines | `machines.list/add/remove/reconnect`. Add a machine lists the hosts of this computer's ssh config (`machines.sshHosts`, read again each time it opens), each with what `ssh -G` resolves and "linked as …"; picking one probes it (`machines.probe`) and offers ready rows, "Windows" (with the shell that answers ssh), "WSL (<distro>)" (the default marked) or "Linux or macOS", with a name, the first row not linked yet chosen (`probeChoices` in `@cc/core`). A row already linked through that alias is shown but not offered. A probe that cannot tell says why in one sentence (`probeProblem`), and "Enter a target by hand" keeps the typed fields, prefilled from the host picked; with no hosts in the config, the dialog opens on them. A probe answering after another host was picked is dropped. Each row says the last error as what to do (`machineProblem` in `@cc/core`: a key not loaded, a host key never accepted, Centralu not installed or not serving there), and holds the version prompt. Where the machine offers it, a "Start Centralu when <machine> starts" switch (`machines.autostart`, `autostartRow` in `@cc/core`), with a line where it falls short of boot: a systemd manager that starts only at login, a Windows sign-in. A machine whose host said in its hello that it runs with administrator rights (`MachineInfo.elevated`, #702) says so in one sentence with the way out (`elevatedNote` in `@cc/core`) |
| Version prompt | From `MachineInfo.versions`: an older hub gets the existing update path; an older remote gets the exact `npm i -g centralu@<hub version>` to run there (phase 1 cannot update it); one protocol connects and the update is offered on the connected row (#689); "Connect anyway" (`machines.acceptVersions`) remains for a link held at `versions_differ`. A hub running a local build installs and updates a remote at `<base>` when `<base>` speaks its `protocolVersion`, else at the newest earlier release that does (a registry that cannot be reached, or no such release, is a plain refusal); `machines.update` never goes down, and refuses when the remote runs a newer version than it would install (`installVersion` in `links/registry.ts`; a release declares it in its `package.json`), and the result's `note` says so. A remote on a dev build (`<base>.local.N`, `pnpm remote-dev`, #1036, [plans/remote-hub.md](../../plans/remote-hub.md) §10.11) is compared as `<base>`: going back to `<base>` is no downgrade |
| New-session dialog, session menu | `agents.detect`, `agents.models`, `agents.capabilities` with the project's `machine` |
| Session header | Names the machine (also every grid panel's header, and where approvals and questions are answered); "older CLI" compares with `agents.versions {machine}` |
| Inbox, notice cards, OS notifications | Name the machine of a remote session |
| Usage gauges (phase 2) | This computer's donuts first, then each linked machine's behind its name: `agents.detect` and `agents.usage` with its `machine`. Only connected machines are asked (on the 5-minute refresh, on the host connection coming back, and when that machine's link comes back); one that is not connected shows its state |
| Open in VS Code (phase 2) | For another machine's project, the project's sidebar menu, the diff, the viewer and the file tree's row menu offer "Open in VS Code": a `vscode://vscode-remote/ssh-remote+<sshTarget><path>` link through `system.openUrl` (`remoteIdeUrl` in `@cc/core`). Not offered for a WSL machine, nor for an ssh target a link cannot carry |
| App views (phase 2) | Another machine's apps open like this computer's: a pinned view, a view in its conversations, Pin. The hub serves each from its own door with the machine's document (`apps.viewDocument`), and per-app origins from its own port book, keyed by machine ([plans/remote-hub.md](../../plans/remote-hub.md) §11). A user-folder app is opened with its `machine` (`apps.openView`), and its panels, Restart and Remove pass the same `machine` (remote-hub.md §11.9, §11.10); Settings → Apps lists such apps per machine. They stand on the grid too: the hub keeps such a panel while it knows the machine and the project (store v47, remote-hub.md §11.8) |
| Off for another machine's project | Reveal in the file manager and the file tree's other verbs, this computer's Open in IDE (`fs.resolve` is refused), moving its folder to this computer's trash on delete, New app |
