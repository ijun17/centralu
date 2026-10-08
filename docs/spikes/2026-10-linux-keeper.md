# The keeper on Linux, run for real (2026-10-08)

> Measured for #350 and #14 in WSL2 Ubuntu 24.04 on the owner's Windows laptop: a real Linux kernel, no display used.
> The keeper had compiled on Linux since #280 but had never been started there outside one cut-short CI trial.
>
> **Short version.**
> 1. **#350 is procps-ng's `kill`.** `kill_group` ran `/bin/kill -TERM -<pid>`. procps-ng 4.0.3 and 4.0.4 (Ubuntu
>    24.04 ships 4.0.4) read a negative pid after a signal option as another option and signal the group named by the
>    pid's **first digit**: `-130` became `kill(-1, SIGTERM)`, every process the user may signal. That is the SIGTERM
>    the CI trial's script received, reproduced here exactly. The same function stops the host on the direct path,
>    which is what Linux runs today, on every quit. Fixed: `kill(2)` directly (§2).
> 2. **The login-shell probe stalled under a terminal.** An interactive `$SHELL -ilc` in a process group of its own
>    is stopped by SIGTTOU when the app has a controlling terminal, which the npm launcher gives the AppImage. The
>    probe waited out its 5 s and fell back to fixed paths. Fixed: a session of its own (§3).
> 3. **The four keeper scripts pass on Linux**: 81, 14, 56 and 41 checks; the content script after a fix to the
>    script itself (§4). The descriptor handoff passes at every size of the #387 sweep, at a 16 KiB buffer and at
>    Linux's default 208 KiB, even with the wait-for-room retry disabled: Linux blocks (§5). A Linux CI job now runs
>    all of it.
> 4. **The AppImage.** A keeper the window starts keeps the window's AppImage mounted: it inherits the runtime's
>    keep-alive pipe and the mount's directory descriptor, and so does its host. The trouble is a **switch to a newer
>    AppImage's build**: the new keeper runs from the new AppImage's mount but holds nothing of it, so the mount goes
>    when that window quits. Measured: every later host restart failed and the keeper gave up (fixed here: the host
>    runs from its copy), and a debug keeper died of SIGBUS when asked to stop, most likely at a page-in of code not
>    yet in memory (not fixed: the keeper has to run from a copy, §6).
>
> What still stands between the keeper and the Linux default is §7.

## 1. Setup

| | |
|---|---|
| Machine | LG Gram, Windows 11, WSL2 Ubuntu 24.04.5, kernel `6.18.40.1-microsoft-standard-WSL2`, 18 CPUs, 7 GB |
| `kill` | procps-ng 4.0.4 (`2:4.0.4-4ubuntu3.3`); `pid_max` 4,194,304 |
| Toolchain | Node 22.23.3 (WSL's own); rustc 1.99.0 installed under the temporary folder only (`RUSTUP_HOME`, `CARGO_HOME`) |
| FUSE | `/dev/fuse` present, `fusermount3` setuid, no libfuse2 (the AppImage's static type-2 runtime does not need it) |

**Binaries.** The keeper is this branch's, built from a crate of one file: `src/bin/centralu-keeper.rs` unchanged,
linking the keeper crate. The window's crate needs webkit2gtk's headers, and no system packages were installed. The
window executable the handoff script needs is the published 0.1.0-beta.12 AppImage's `usr/bin/centralu`, unpacked with
`--appimage-extract`, its RUNPATH (`$ORIGIN/../lib`) pointed at the unpacked `usr/lib`. The host is beta.12's bundled
host from `@centralu/linux-x64@0.1.0-beta.12` (no host code changed since). The keeper crate's unit tests and the
shell's ran from this branch.

**Isolation.** The laptop is shared, and an unfixed keeper sends SIGTERM to every process of its user. So every
script and experiment ran in a user, pid and mount namespace of its own (`unshare -Urpf --mount-proc`) with:

- a small reaper as pid 1, which reaps orphans and exits when the script does, which ends everything in the
  namespace;
- a private `/tmp`, bind-mounted from the temporary folder, so the scripts' fixed `/tmp/ck-*` paths and the AppImage
  mounts stayed inside it.

`kill(-1)` from inside reaches only the namespace. What differs from a desktop: pids start at 1 (burned to three
digits where it mattered), uid 0 maps to the user, and the reaper stands in for init or `systemd --user` as the
reaper of orphans. The unit tests ran outside any namespace once the fix was in.

## 2. #350: a stop that signals outside its group

**What `/bin/kill` does.** Through an `LD_PRELOAD` shim around `kill(2)`, with the real call replaced by a log line:

| `/bin/kill -TERM <arg>` | calls |
|---|---|
| `-4`, `-9` | `kill(-4, 15)`, `kill(-9, 15)` |
| `-12`, `-1234`, `-12345`, `-123456` | `kill(-1, 15)` |
| `-99`, `-98765` | `kill(-9, 15)` |
| `-460`, `-40000`, `-4194303` | `kill(-4, 15)` |
| `-- -12345` | `kill(-12345, 15)` |
| `12345` | `kill(12345, 15)` |

`-s TERM -<pid>` and `-15 -<pid>` do the same. In procps-ng's `src/kill.c`, getopt sees `-12345` as an unknown option
`1`, and the "special case for signal digit negative PIDs" sends to `'0' - optopt`, minus that first digit, then
exits. 3.3.17 (Ubuntu 22.04) used the whole argument (`atoi(argv[optind-1])`); 4.0.5 and later parse the whole
argument again. 4.0.3 and 4.0.4 have the bug.

**Where it hit.** `host_proc.rs`: `stop_pid_gracefully` sends TERM to the host, waits up to 3 s, then always calls
`kill_group(pid)`, which ran `/bin/kill -TERM -<pid>`. `keeper-integration.mjs` with beta.12's keeper, pids burned to
the 100s first: the first scenario's stop (background off, the attached client killed) ran `kill(130, 15)` for the
host, then

```
kill[182] kill(-1, 15) = 0
SIGTERM: stopping everything this script started        (the script; exit 143)
```

which is the CI trial of 2026-10-05 ("right after the first scenario's keeper stopped"). With this branch's keeper the
same run calls `kill(-130, 15)`, `kill(-254, 15)`, ..., and all 81 checks pass.

**Not only the keeper.** `kill_group` is shared with the direct path, which Linux runs today (the keeper is opt-in
there, `Reason::KeeperOptIn` in `start_plan.rs`). So on a distribution with procps-ng 4.0.3 or 4.0.4, quitting Centralu sends SIGTERM to every process of the
user whenever the host's pid starts with 1, and to process group 2 to 9 otherwise (usually nobody's, or root's). The
host's own leftovers were never signalled. Not run through the window here (no display was used); it is the same
function with the same argument.

**Groups and sessions are as designed.** In every run the keeper led its own session (`setsid`), the host led its own
group (`process_group(0)`), held children led their own sessions, and the test script was in none of them.

**The fix.** `kill_pid` and `kill_group` call `kill(2)` directly. Both refuse 0 (the caller's group), 1 (`-1` is
everyone) and anything past `i32::MAX` (it would turn negative), and `kill_group` never signals the caller's own group.
The new test `kill_group_signals_the_group_the_pid_leads_and_nothing_else` starts a leader with a child in its group
and a bystander in another, then checks that the leader dies of SIGTERM, the child goes, and the bystander runs on.
With the old `kill_group` put back, in the namespace:

| Leader's pid | `/bin/kill` called | Result |
|---|---|---|
| 3x | `kill(-3, 15)`, ESRCH | `the group's leader got no SIGTERM` |
| 1xx | `kill(-1, 15)` | the test runner itself killed by SIGTERM (exit 143) |
| 4xx | `kill(-4, 15)`, ESRCH | `the group's leader got no SIGTERM` |

With the fix: `kill(-34, 15)`, `kill(-124, 15)`, `kill(-454, 15)`, all pass. On macOS the test passes either way
(macOS's `kill` reads the argument as a group), so only a Linux run guards it: the new CI job runs the keeper crate's
unit tests on ubuntu-24.04.

**Left as it is: a reused group number.** `stop_pid_gracefully` signals the group after the leader may have been
reaped (the group outlives its leader). The number can go to a new process only once the group is empty, and a new
process that leads a group of that number (anything started with `setsid`) would get the TERM. That needs the pid
counter to wrap within the 3 s grace: unlikely at `pid_max` 4,194,304, less so at 32,768 (some systems) or macOS's
99,999. A guard has to tell the host's own unreaped zombie from a reused pid (the watcher takes the child out before it
reaps it), which is more than a small fix. The children service already guards its leftovers sweep this way
(`signal_leftovers`).

## 3. The login-shell probe, stopped by its terminal

`finds_the_node_this_shell_knows` failed in WSL (`left: None, right: Some("/usr/bin/node")`, after 5 s). The probe runs
`$SHELL -ilc ...` with `process_group(0)`. Started from a process with a controlling terminal, that group is a
background group of the terminal's session, and an interactive bash setting up job control is stopped by SIGTTOU.
Measured with the same command line:

| Started in | Result |
|---|---|
| a process group of its own | stopped (`T`), killed at the timeout |
| a session of its own | the answer in 0.04 s |
| the parent's group | the answer in 0.03 s |

Who has a controlling terminal: the window when the npm launcher starts it, because Linux runs the AppImage attached to
the terminal (`packaging/npm/centralu/bin/platform.mjs`). The direct path then waited 5 s at every host start and
missed a node only the login shell knows (nvm, mise). A keeper is in its own session and was never affected. Fixed with
a session of its own (`keeper::sys::new_session`), which still makes the group number the shell's pid for the timeout's
`kill_group`. The existing test fails without the fix in WSL and passes with it.

## 4. The keeper scripts

All in the namespace above, with `--no-build` and, for the children and handoff scripts, `--no-claude --no-codex`
(what CI runs):

| | Checks | Result |
|---|---:|---|
| keeper crate unit tests | 158 | pass |
| shell unit tests (`-p centralu-shell`) | 21 | pass |
| `keeper-integration.mjs` | 81 | pass |
| `keeper-children-integration.mjs` | 14 | pass |
| `keeper-handoff-integration.mjs` (keeper A started as beta.12's window executable) | 56 | pass |
| `keeper-content-integration.mts` | 41 | pass after the script fix below; 39 before |

**The content script's two failures were the script's.** It compared `ps -o comm=` with the content folder's keeper
path. On Linux that column is the name alone (`centralu-keeper`), so "keeper A runs from `<data>/content/0.2.0/`" and
its keeper B twin failed although both keepers did run from there. It now reads `/proc/<pid>/exe` on Linux, as the
handoff script already did. For this run only, its test keeper was built from the one-file crate (§1); in CI it builds
as it does on macOS.

## 5. Handoff on Linux: descriptors and the #387 sweep

The handoff script passes everything it checks on macOS: the host, the terminal and the dev server keep their pids,
the counters stay continuous, the front door and the open WebSocket survive, a third keeper is turned away, and the
rollback when the incoming keeper is killed before the commit. Its descriptor batches go over `SCM_RIGHTS` as on
macOS.

`wire.rs`'s sweep (150 descriptors, three batches, after every prefix size from 0 to three buffers, plus the last
320 bytes below one buffer) at two buffer sizes, then again with the `EMSGSIZE | ENOBUFS | EAGAIN` arm of `send_fds`
made unreachable:

| `SO_SNDBUF` | Sizes | With the retry | Without it |
|---|---|---|---|
| 16,384 (the test asks for 8 KiB on Linux, which doubles it) | every 256 bytes to 49,152, and 41 near 16,384 | pass | pass |
| 212,992 (`net.core.wmem_default`) | every 2 KiB to 638,976, and 41 near 212,992 | pass | pass |

Linux blocks a `sendmsg` with descriptors until there is room; it never refused a batch. `optmem_max` is 131,072 bytes
and a batch carries 64 descriptors (256 bytes of control data). The retry stays for macOS.

The host swap (blue-green through the front door, the drain, a broken build refused, a failed new host rolled back)
passes in `keeper-integration.mjs`, and §6 swaps between two AppImages' builds.

## 6. The AppImage: what happens when the mount goes

**How the runtime keeps the mount** (type-2 runtime `8f39b89`, `src/runtime/runtime.c`). The runtime forks. The child
mounts the squashfs at `/tmp/.mount_<name>XXXXXX` and serves it, and a thread of it writes into a keep-alive pipe
until a write fails, then ends the server, which unmounts. The parent keeps the pipe's read end and a descriptor of
the mount's directory at 1023, then execs `AppRun`, which execs the window. Neither has close-on-exec, so the mount
lives for as long as any process holds the read end.

**Method.** FUSE works in this WSL; inside the user namespace libfuse mounts directly. Two AppImages, A and B, are
beta.12's runtime with its squashfs repacked: this branch's keeper in `usr/bin/`, and the host stamped `lk-A` and
`lk-B`. The window cannot run without a display, so a stand-in plays it: `<AppImage> --appimage-mount` makes the mount,
and a small process opens that process's descriptors at the same numbers (3, the keep-alive read end, and 1023), then
starts `<mount>/usr/bin/centralu-keeper` the way `sidecar.rs` does (its own session, the rest inherited, the same
arguments) and attaches. Ending both is "the window quits". Background mode on.

**1. One build: the window quits, the keeper stays.**

| | Holds the keep-alive pipe (fd 3) | Holds the mount (fd 1023) |
|---|---|---|
| keeper A | yes | yes |
| host A (node, started by the keeper) | yes | yes |

After the window quit, the mount and its FUSE server stayed, the keeper answered, and a host killed with SIGKILL was
restarted. So "the AppImage unmounts when the app exits" does not hit the keeper the window started: the keeper and
its host keep the mount alive, and so would anything they start that does not close those descriptors. The cost is
that the mount and its server live as long as that whole tree.

**2. A switch to a newer AppImage's build: the mount goes under the keeper.** B mounted, its window stand-in holding
B's descriptors, and `switch` sent with `keeper.exe` in B's mount and the host source in B's mount (what a window of B
sends). Keeper A handed over to keeper B and B swapped the host to `lk-B`:

| | |
|---|---|
| keeper B's executable | `/tmp/.mount_B.../usr/bin/centralu-keeper` |
| descriptors keeper B holds of mount B | none: keeper A started it, and its fd 3 is the handoff channel |
| mount A | gone once keeper A and host A had exited (nothing leaked) |
| B's window quits | mount B gone at once; keeper B runs on, its executable now shown as `/usr/bin/centralu-keeper` (detached) |

Then:

- **The host could not restart.** Host B killed: five attempts, each `no host in /tmp/.mount_B.../resources/host
  (main.mjs is missing)`, then "gave up", although `<data>/hosts/lk-B` was complete. `copy_into` checked the source
  before it looked for its own copy. **Fixed here:** a complete copy is used first. Measured after the fix: the host
  restarted from `hosts/lk-B`.
- **The keeper's own code.** The release keeper (2.4 MB) answered, restarted the host and stopped cleanly in this
  short run. The debug keeper (25 MB) died of **SIGBUS** (signal 7, seen by the reaper) when asked to stop, the
  likely reading being that the stop path's code was not yet in memory and a page-in from a FUSE file whose server
  is gone fails. A release keeper's code pages can be evicted like any file's, so over a long life under memory
  pressure it can meet the same end at a later page-in (not measured). **Not fixed here.**

This is the update path: `npm i -g centralu@next` installs a new AppImage, its window finds the old keeper and asks it
to switch.

**Proposed fix.** On Linux, never run the keeper from the mount. The window copies its keeper and host out before it
starts a keeper or asks for a switch, and passes the copy: `<data>/content/<version>/{centralu-keeper, host/}`, the
layout the thin shell gives macOS (`docs/plans/thin-shell.md` §8, decision 6: "share the keeper split, the manifest
and the content folder"). If the AppImage carries the signed content, the copy is verified like the shell's, and the
keeper's own `move_to_content` already verifies and copies for a handoff. Once nothing runs from the mount, the keeper
should also close the descriptors it inherited and does not own (all but the handoff channel), so the AppImage stops
being mounted for the life of the keeper, its host and every terminal. Today that pinning is what keeps case 1
working; after the copy it is only a leak: a FUSE server and a mount per launch, and an updated-away AppImage's file
kept on disk.

## 7. What still blocks the keeper as the Linux default

1. **The keeper runs from the AppImage** (§6, case 2): the copy has to come first. Until then a switch to a newer
   build leaves a keeper that can die of SIGBUS at any later page-in.
2. **The real window never ran here.** The window starting the keeper with `CC_USE_KEEPER=1`, attaching, quitting with
   background mode on and off, "Apply now" (#352) and an npm update, on a Linux desktop. No display was used on the
   owner's laptop.
3. **Desktop sessions.** Not covered by WSL: `systemd --user` as the reaper of orphans, and a logout with
   `KillUserProcesses=yes` (off by default on Ubuntu), which ends the keeper with the session even though it has a
   session of its own.
4. **The CI job** (`keeper e2e (linux)`, added here) has to stay green for a while: the exit watch there is pidfd, and
   timing under a loaded runner is untested.
5. The reused group number (§2), on any platform.

The direct path, which Linux keeps until then, gets both fixes of §2 and §3.
