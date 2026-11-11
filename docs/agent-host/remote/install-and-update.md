# Installing, updating and starting a linked machine

**Picking a machine from the ssh config** (#514; `ssh-config.ts`, `probe.ts`). The Add machine dialog lists the
hosts of the ssh config of the computer the hub runs on, as VS Code's Remote-SSH does, so linking needs no typing.
Two calls, both additive and the hub's own:

- `machines.sshHosts` reads `~/.ssh/config` the way OpenSSH reads it: `Include` where it stands (globs sorted as
  glob(3) sorts them, a relative path under `~/.ssh`, `~/` expanded, nested at most 16 deep, a file that includes
  itself read once), `Host` lines with several patterns and quoted values, `#` comments, `Keyword=value`. Pattern-only
  and negated entries (`Host *`, `Host *.example`, `!bad`) are left out, and so are `Match` blocks, whose conditions
  only ssh can evaluate (one note says where they are). Each alias, at most 100, is resolved by `ssh -G -- <alias>`
  (8 at a time, 5 s each) for its `hostname`, `user` and `port`; `ssh -G` prints the configuration and exits before
  it loads a key. Only the config's text is read, by the host and never by the window; no `IdentityFile` is opened.
  Each host carries the machines already linked through that alias (`linked`), and the window reads it again each
  time the dialog opens: no watcher.
- `machines.probe { sshTarget }` runs one BatchMode ssh (`ConnectTimeout=10`, 30 s in all) with one command:
  `powershell -NoProfile -NonInteractive -EncodedCommand <base64>`, about 1,640 characters. That line means the same
  to the three shells an ssh command can land in: cmd.exe (Windows OpenSSH with no `DefaultShell`) and PowerShell
  both start PowerShell, and a POSIX shell has no `powershell` and answers exit 127. The script only reads the
  registry: `HKLM\SOFTWARE\OpenSSH\DefaultShell` (where OpenSSH itself reads the shell it runs a command under; empty
  is cmd.exe) and the WSL distros under `HKCU\...\Lxss` with `DefaultDistribution` (where `wsl.exe -l` reads them).
  The answer (`MachineProbe`) is `posix`, or `windows` with `windowsShell` (`cmd`, `powershell`, `pwsh`, `other`)
  and the distros (docker-desktop's own left out), or `reachable: false` with ssh's last line (a key refused, a host
  key not known, a name that does not resolve, a timeout), or reached but not recognised.

Measured on a Windows 11 PC over Tailscale (2026-10-12, cmd.exe default shell): the probe answered in 1.15 s with
`platform=Win32NT`, an empty `DefaultShell`, `Ubuntu` as the default distro and `docker-desktop`; PowerShell 5.1 wrote
its "preparing modules for first use" progress to stderr as CLIXML, which is not read.

| Decision | Why |
|---|---|
| The probe is the PowerShell line for every shell, and POSIX is told by exit 127 | No one line runs a program in cmd.exe, PowerShell 5.1 and sh alike: `&`, `&&` and `\|\|` are parse errors in PowerShell 5.1, and `;` is not a separator in cmd.exe. The `-EncodedCommand` line is the one every Windows command already crosses on (above), and 127 is POSIX's "command not found" (csh's own words are read too) |
| The distros come from the registry, not `wsl.exe -l` | `wsl.exe -l` writes UTF-16, and it starts the WSL service; the registry is where it reads them, and reading it starts nothing |
| The host reads the config, `ssh -G` resolves it | The window has no file access; `ssh -G` applies everything a hand-written reader would get wrong (`Match`, `CanonicalizeHostname`, defaults), and connects to nothing |
| The probe runs when a host is picked, not for every listed host | One ssh per host the person chose, never a sweep of every machine in the config |

**Installing on a machine** (phase 3, plan §10.2; `install.ts`, `registry.ts`, `remote-install.mjs`).
`machines.install` installs the hub's own version there over the same ssh, in three remote commands, each a script for
that machine's shell sent the way the lookup is (base64 to `sh`, to `bash -l` inside WSL, `-EncodedCommand` to
PowerShell):

| Step | What runs there | What the hub does |
|---|---|---|
| 0. Preflight | Prints one `CENTRALU-PREFLIGHT` line: `uname`, `getconf GNU_LIBC_VERSION`, musl, free space where the data folder is, `tar`, `gzip`, `curl`/`wget`, a SHA-256 tool (Windows: architecture, `tar.exe`, `curl.exe`) | Decides (`preflight`): glibc 2.34 or later, no musl, a published platform, the tools, 600 MB free (300 on Windows); otherwise one sentence and nothing is downloaded |
| — | — | Reads `centralu@<v>` and the host's package from the npm registry and checks each `dist.signatures` against the registry's keys (`/-/npm/v1/keys`, unexpired), as `npm audit signatures` does. The host's package is `@centralu/host-<platform>@<v>`, the host alone ([releasing.md](../../releasing.md) "Host-only packages"); only when the registry answers 404 for it (a version published before those packages) is it `@centralu/<platform>@<v>`, the platform package with the window in it. Any other failure on the host-only package refuses |
| 1. Node | Downloads the pinned archive from nodejs.org, compares its SHA-256 with the one the hub sends from `remote-runtime.json`, unpacks it with the system's tar (`System32\tar.exe` on Windows) into a `.partial-node-*` folder, keeps only `bin/node` (`node.exe`) and `LICENSE`, and renames it to `<data>/remote/node/v<N>/` (on Windows, a rename refused while an on-access scanner holds the `node.exe` just run is tried again for up to 15 s, #368) | Sends the archive's name and hash; reads `CENTRALU-INSTALL node ok` or a failure code |
| 2. Centralu | `remote-install.mjs`, written there gzipped in base64 and run on that Node: takes `install.lock`, fetches both tarballs, refuses any whose sha512 is not the integrity the hub sent, unpacks them in npm's layout into `.partial-<v>-<pid>/`, drops the AppImage or `centralu.exe` when the host came in the platform package, writes `install.json`, renames the folder to `versions/<v>/` (a folder already there, the same version with other bytes, is moved aside first and removed only after the new one is in place), writes the managed launcher if there is none (`managedLauncherScript` from that version's `serve.mjs`; never rewritten), moves `current` to `previous` and writes `current`, each by a rename over the file, and removes versions and Nodes neither names | Reads `CENTRALU-INSTALL done <json>`: `current`, `previous`, what was removed and what could not be (a Windows program running from it) |

A script too long for a Windows command line (step 2's, about 17,000 characters of stdin) goes on the command's stdin as base64 and
then a line holding one dot (#1360). The PowerShell reads the bytes from `[Console]::OpenStandardInput()` up to that line,
says `CENTRALU-STDIN-READY` when it starts and `CENTRALU-STDIN-OK` when it has the script, then runs it; it does not wait for the
end of input, and it does not use `[Console]::In`, whose `ReadToEnd()` never returned in a share of the runs on Windows OpenSSH
(docs/runtime-lessons.md RE18). `exec` waits for the first line for 2 minutes (`stdinReadyMs`: ssh's own connecting has its allowance of six attempts,
`SSH_CONNECT_ALLOWANCE_MS`, on top of 30 s for PowerShell starting; a failure there is not retried) and for the second for 30 s
after it (`stdinAckMs`). The reader gives itself 20 s from the first line (`STDIN_READER_MS`): past it, or when the input is cut,
it exits with 4 and prints nothing more, also when the whole input comes late, so it is gone, or never ran the script, before the
hub's 30 s are over, and a failed step leaves no PowerShell behind. A reader whose process is already older than 30 s when it says
it runs (`SSH_POWERSHELL_START_MS`; a PowerShell that came up after the hub's wait, the input waiting in its pipe) reads nothing and
exits with 4 too. When PowerShell was up and the input was not read, the step
has not started, so it is sent once more (only when the reader itself ended, with 3 or 4, or no confirmation came in 30 s; a dropped link
after READY is "ssh could not reach" and is not sent again), and a second failure says so with "PowerShell on <machine> did not confirm within 30 seconds that it had read this step's input, so the step did not
start, twice". The step's own limit (30 minutes) is then only for a step that runs.

The remote prints codes, the hub turns them into sentences (`node_hash`, `integrity`, `download`, `busy`, …); exit
codes are not read, as for the lookup. `install.lock` is a folder made with `mkdir`, then its `pid` and a `token` of
the run: a lock found without a pid is held while it is under a minute old (its installer is between the two), a lock
whose process is gone is moved aside before it is removed (so two installers that both found it stale do not both
take it), and an installer removes the lock only while its `token` is still the one inside. A host running there is not touched: the old version becomes `previous` and
keeps its folder, and the next start runs the new one. When the link is not connected the hub opens it again at once,
and the lookup finds the managed launcher. A development hub refuses (its version is not on npm), and so does a
machine with a command of its own.

**Updating, rolling back and uninstalling** (phase 3 step 4, plan §10.5; `update.ts`). Each is one call
(`machines.update`, `machines.rollback`, `machines.uninstall`, additive) that answers when it is done or failed; its
steps arrive meanwhile as the machine's `operation` (`{ kind, step, target, at }`, additive) in `machine_status`, and
the row's status is `updating` (additive; an older window reads it as unreachable) while the host there is down. One
at a time per machine, and the remote's `install.lock` guards the files.

| Step | Update | Rollback | Uninstall |
|---|---|---|---|
| Install beside | `machines.install`'s steps with `activate: false`: the new version lands in `versions/<v>/`, nothing points at it, nothing is removed, and no launcher is written yet, so the lookup still finds what runs | — | — |
| Wait | **Until no session there is in a turn** (#1399): `HostControl.beforeStop`, after the install beside and before anything is held or stopped, reads `host.activity` every 15 s and goes on once working, approvals, questions and background work are all 0 (terminals and project commands stay open for hours and are not waited for). The row's operation says `wait_idle` meanwhile, and `machines.cancelUpdate` (or an Assistant's cancelled call) ends the wait: the update fails saying it was cancelled and nothing was switched. `when: 'now'` (the person's choice) skips the wait, the answer's `note` says how many sessions' turns it ended (and how many terminals and project commands closed), and the next host continues those turns (below, #1618). Once a reading says none, it is read again about 3 s later, right before the host is held and stopped (the stop takes seconds, and `host.stop { ifIdle }`, which would be atomic, counts terminals and commands too). A machine that cannot be asked at all (a host from before `host.activity`, a link held on another protocol) is not waited for, and a machine none of whose readings has succeeded is read again twice, then not waited for either (waiting on what was never seen would never end). Once one reading has succeeded, a failed one proves nothing (a busy or dropped remote fails them too), so the wait goes on through failed readings, the row saying `wait_unread` ("it cannot read what runs there now"), and the host is stopped only on a successful reading of no session in a turn, the second one too; Cancel and `when: 'now'` are the ways out. `MachineInfo.updateWaits` (set by every hub that waits) lets a window promise the wait: an older hub sends nothing and stops at once, so the window words the plain Update there. When `install_machine` has answered "still under way", how the update ends is told to the Assistant as a message in its conversation, a failure too. Removing the machine or stopping the hub ends the wait ("nothing was switched"). The wait is not kept across a restart of the hub (the version stays installed beside, harmless). `pnpm remote-dev` (`dev-build.ts`), rollback and uninstall do not wait. An older hub ignores `when` and stops at once; an older window shows the step as `wait_idle` and has no Cancel. `install_machine` (update) answers after about 200 s that the update is still under way, since a tool call that long is cut by its caller while the update goes on; the window's `machines.update` has the long call budget, and a wait that outlasts it is the row's to show | — | — |
| Hold | The link stops reconnecting and starting a host of its own (Reconnect included) until the switch's outcome; it would otherwise start the old version between the stop and the switch | the same | the same |
| Hand over | First the switch there is read: one under way refuses the update before the wait, the hold or any step (#1907). Then one command runs the new version's `centralu serve --switch` there (docs/plans/remote-hub.md §10.5a), which detaches a switcher and returns; the steps below are the machine's, written to `<data>/remote/switch.json`, and the hub reads them with `serve --switch-status` until the outcome. A link drop or a hub that dies leaves the machine to finish | The same, run by the version that runs now | — |
| Stop | `centralu serve --stop` of the running version, by the switcher: it stops itself in order ([serve.md](serve.md)). Not stopped: the outcome is a failure and nothing is switched | the same | The hub's own `serve --stop` through the lookup; not stopped, nothing is removed |
| Boot entry | — | — | `serve --autostart remove` through the lookup ([serve.md](serve.md)), after the stop. Not removed: nothing is removed. A version older than `--autostart` is passed by (it cannot have written one from here) |
| Switch | The switcher writes `previous` = the old `current`, `current` = the new one, each by rename; the launcher is written now if there is none. The stop before it was `serve --stop` with `CENTRALU_STOP_FOR=update`, so the host it stopped wrote the turns it ended to a list of its own, `<data>/update-resume.<uuid>.json` (#1618, below) | `current` = `previous`, `previous` removed: one step back only | `<data>/remote/` removed, by a script per shell (a running `node.exe` could not remove itself) |
| Start | `serve --detach` of the new version, by the switcher | the same | — |
| Check | The new version's `serve --connection` says a host answers as the target, within 30 s. A host answering as another version was started meanwhile by one that asks no switch (a release from before it): it is stopped and the new version started again, twice at most (#1907) | the same | — |
| After | Success: the switcher prunes what neither pointer nor the switch's runner names. Failure: the end of `host.log`, `serve --stop` again, the old pointers back (none, after a first update over an npm install: then the launcher goes too), the old version started if one was running, and the call fails with that sentence. That stop is for an update too: the turns the new host had not continued, and those it was running, stay listed for the version put back (one from before #1618 ignores the list) | Failure: the same, towards the version it left | The link opens again and finds what is left (an npm install, or nothing) |

**Following the hub** (#1508, owner 2026-10-24). While the hub's "Automatic updates" are on (`updates.autoApply`;
`LinkDeps.autoUpdate`, which main.ts reads as off while the hub drains to stop), a linked machine on an older release
of the hub's channel follows the hub's version with no one's click: one switch covers both. The condition is
`LinkedMachine.followsHub` and lives there only: automatic updates on, the hub can update the machine (`operationRefusal`),
the person did not remove what the hub installed there, neither side runs a local build (`<base>.local.N`), and
`versions.older` is `remote`. Versions of two channels are never ranked, so a stable machine does not follow a beta hub.

- **When.** At every connect (`connectedNow`, after the hello and the lists): that is also how the hub's own update
  reaches its machines, since the next host links again and finds them older. And when the person turns automatic
  updates on (`updates.setAutoApply`, `Links.followHub`), for the machines already connected.
- **What.** The same update as `machines.update { when: 'now' }`, marked `unasked` (`LinkedMachine.stopAtOnce`): it does not
  wait (owner, 2026-10-26, #1618). It used to wait for the turns there (#1399) and for terminals and project commands
  (`OPEN_WORK_WAIT_MS`, #1579), and a machine always busy never updated: two machines were held for hours (#1614). It
  reads what runs there once, right before the hold, for the answer's sentence, and stops the host: the turns running end
  and are continued by the next host (below), and terminals and project commands close. It stops no host it cannot ask what runs (a Centralu from
  before `host.activity`, or one whose reading fails, tried again twice): that is read before anything is installed and
  again before the hold, and the update fails, nothing switched, the row saying to update from Settings. A swap that comes
  after the hold finds it as it finds the person's update ([serve.md](serve.md)). The `wait_open` step is no longer shown by this hub;
  a window keeps its words for an older one.
- **How often.** Once per version of the hub's, and once more 10 minutes after a failure (`FOLLOW_RETRY_MS`); an update
  of this hub's from before #1618 could also be cancelled while it waited, which spent the version. Every update nobody approved counts as a try for
  the hub's version, the hub's own and an agent's card-less one alike (`unaskedRun`). A spent version (both tries failed)
  makes `followsHub` false, so an agent cannot start it again without a card. A retry whose time comes while the
  machine is busy or away runs when that ends or at the next connect. A failure shows on the row as `MachineInfo.followHub`
  (`{ version, failed, retryAt }`, additive and optional) while the machine is still behind, and its steps show as any
  update's do.
- **Not covered.** A machine on another protocol is held at `versions_differ`, where neither its hello nor what runs there
  can be read, so it stays the person's to update (no protocol bump has happened yet: `PROTOCOL_VERSION` is 1).
- **An agent's call.** A limited caller's `machines.update` with `when` `idle` or absent runs without a card when
  `followsHub` holds (transport/method-rights.ts `RightsHost`, security-boundaries/credentials.md); the
  transport judges it once and tells the handler (`RpcContext.covered`), and the Assistant's `install_machine` (update) goes without its card on the same check; both run `unasked`.

**The desktop copy follows the host** (#1736). The hub's update brings the host-only package, which has no desktop
executable, so a Windows window that runs on the machine's `centralu serve` host (`start_plan.rs`, `Host::Serve`) kept the
executable it was installed with: its icon, shell and keeper never moved. So a `centralu serve` host the hub installed
(its entry under `<data>/remote`; a release, not under CI; not on macOS, where swapping /Applications from the background
may raise the App Management prompt: `copyFollowsHost` in `update-switches.ts`) brings the installed copy
(`installedCopyPath`) up to its own version once per start (`UpdateService.followHost`): when the copy is older than the
host or its version cannot be read or is malformed, it runs `npm i -g --prefer-online centralu@<host version>`, unless
the global package is already at or above it (it is never taken down), and then the npm package's own launcher's
`install`, by its path (`npm root -g`), not `centralu` from PATH, which there may be the hub's shim with no app to copy.
The install from the app runs the launcher the same way. On Linux a menu entry whose AppImage is gone counts as no copy. On Windows that renames the running copy aside (the table under "On Windows" above), so
the window's next start runs the new executable; on Linux the menu entry already points into the package. A copy newer
than the host (a rollback by the hub, or a newer local build) stays. It follows the rule of the hub's update of the host
itself: the machine's own "Automatic updates" switch is not read, since the hub reads only its own. Nobody sees it: no
status changes. A failure is one line in the host log (the exit code and npm's first error line) and is tried again at the next host start; it never runs beside
an install from the app (one running leaves it for the next start, one asked for meanwhile waits for it). The release
check (`scripts/release-npm.mts`, `scripts/icon-check.mts`) fails a Windows package whose `centralu.exe` lacks an image of
`icons/icon.ico`.

**Starting a machine's host at boot** (plan §10.4, owner decision 4; `autostart.ts`). `machines.autostart { machineId,
on? }` (additive) runs `centralu serve --autostart on|off|status` there through the lookup, and the Centralu found
writes, removes or reads its own entry ([serve.md](serve.md)); without `on` it only reads. The row's `autostart` (`MachineInfo`,
additive) comes from the connection line at every link start and from the call's answer; a remote that predates it
says nothing, and the window shows no switch. Nothing starts or stops, so nothing is asked first and the link is not
held. Refused while an install, update, rollback or uninstall runs there, and where the hub has no shell on the
machine. Only the lookup crosses ssh, as short as `--connection`'s, so it fits cmd.exe's line.

What would stop is asked of the remote first: `machines.activity` calls the remote's `host.activity` (additive), which
counts what `hostBusy` counts (`activityCounts`, idle.ts): working sessions, approvals and questions waiting,
background work, terminals and running commands. While the link is held at `versions_differ` on one protocol (before #689) it asked
over a short connection of its own. A remote that predates the call answers nothing, and the prompt says "anything
running". No remote runs a keeper today (plan §10.4), so on Linux and Windows an update ends the agents there; their
sessions resume on the new host through their stored ids, as after any restart, and the turns it ended are continued.
