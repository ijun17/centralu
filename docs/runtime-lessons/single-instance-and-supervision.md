# One instance per data folder, and supervising the host

## One instance per data folder

**LK1. One keeper per data folder, by `flock`, not a pid file.**
Happened: the kernel releases the lock on SIGKILL or a crash, so no stale lock is ever judged (#278).
Rule: a held lock with a socket that answers exits 3; a held lock with a silent socket retries up to 15 s, then exits 4.
Guard: `keeper/os/unix.rs` `a_second_lock_on_the_same_file_is_refused_until_the_first_is_dropped`;
`scripts/keeper-integration.mjs` check "a second keeper on the same folder defers to the first (exit 3)".
Platforms: macOS, Linux.

**LK2. One host per data folder, by a lock the OS releases.**
Happened: the check-then-write `host.lock` gave two owners when eight hosts started at once, and a second acquire in
the same process succeeded (#82, c1693343).
Rule: the host holds `BEGIN EXCLUSIVE` on `host-ownership.sqlite` (DELETE journal, `timeout: 0`) for its whole life;
busy or locked means held, any other error refuses the start; the handle stays reachable so garbage collection cannot
close it. Not valid on network file systems.
Guard: `host/dev-services/instance-lock.test.ts` "of hosts started at the same moment, exactly one owns the folder";
`host/dev-services/instance-lock.test.ts` "the operating system releases ownership when the owner is SIGKILLed — the
next host starts"; `host/dev-services/instance-lock.test.ts` "an ownership file that cannot be read refuses the start
instead of guessing"; `host/dev-services/instance-lock.test.ts` "a lock whose result nobody kept is still held after a
collection" (`--expose-gc`; measured: a collected handle releases the lock). *Changed by step 3.*
Platforms: all.

**LK3. A pid is not an identity.**
Happened: after a SIGKILL or a power loss, a pid in `host.lock` reused by an unrelated process blocked every start
with no window to close (#184). A Korean-locale writer and a C-locale reader read the same start time differently.
Rule: record pid and start time in `host.lock`, with `ps` run with `LC_ALL=C`. Since #461 the file is only read for the
conflict message, so neither a reused pid nor an unreadable start time can refuse a start any more (LK4).
Guard: `host/dev-services/instance-lock.test.ts` "ps runs in the C locale whatever the host was started with".
*Changed by step 3, and by #461.*
Platforms: macOS, Linux.

**LK4. A pid in `host.lock` refuses nothing.**
Happened: Windows has no start time and reuses pids quickly, so a stale file named a live, unrelated process and
refused every start while the real lock was free (979edf00, #14). Elsewhere the check stayed only for hosts from
before #82, which knew nothing else.
Rule: ownership is the SQLite lock alone, on every OS; the check of the file went with #461.
Guard: `host/dev-services/instance-lock.test.ts` "a live, matching owner left in host.lock does not refuse a host that
holds ownership".
Platforms: all. *Changed by #461.*

**LK5. Release only your own lock.**
Rule: on release, unlink `host.lock` only if its pid is ours; the conflict message names the lock path.
Guard: `host/dev-services/instance-lock.test.ts` "never releases someone else's lock (that would defeat the point of
the block)".
Platforms: all.

**LK6. A stale socket belongs to whoever holds the lock.**
Rule: the lock holder removes and rebinds `keeper.sock`; a stopping keeper removes its socket before it stops
anything, so the next keeper waits on the lock, not on a dead socket.
Guard: `scripts/keeper-integration.mjs` check "a new keeper takes over the folder (stale socket and all)";
`scripts/keeper-integration.mjs` check "the socket is removed on the way out".
Platforms: macOS, Linux.

**LK7. A unix socket path is at most 104 bytes on macOS.**
Happened: tests use short `/tmp` paths on purpose; a long `CC_DATA_DIR` fails at bind with only a log line and exit 5.
Rule: check the socket path length before binding and say which folder is too deep.
Guard: **UNGUARDED** (no preflight exists).
Platforms: macOS (108 on Linux).

**LK8. The keeper's sockets are private from birth.**
Rule: sockets are created under umask 077 (no window before a chmod); every connection's peer uid must match.
Guard: `keeper/os/unix.rs`
`the_peer_of_our_own_socket_is_us`; `scripts/keeper-integration.mjs` check "the control socket is user-only (0600)".
`keeper/os/unix.rs` `another_user_or_an_unknown_one_is_refused` (`os::peer_is_this_user`, which both sockets
call).
Platforms: macOS, Linux.

## Supervising the host

**SU1. A crash loop gives up, and some refusals are final.**
Rule: five consecutive failures give up; backoff 400 ms doubling to 5 s; 30 s of uptime resets the count; a lock conflict
and a too-new store are not retried. (A deliberate bounce, which a swap's failure used, was not counted; it went with
#1895 step 4 PR 4.)
Guard: `keeper/host_proc.rs` `counts_consecutive_failures_and_gives_up_after_five`; `keeper/host_proc.rs`
`a_death_after_a_stable_run_starts_the_count_over`; `keeper/host_proc.rs` `backoff_doubles_and_stops_at_five_seconds`.
Platforms: all.

**SU2. Retry after giving up starts one watcher, never two.**
Happened: Retry did not restart the host, then could start a second watcher (#184).
Rule: a supervisor that gave up can be claimed again, forgetting the old error and any failed Node lookup; nothing
restarts while the app is quitting.
Guard: `keeper/host_proc.rs` `a_supervisor_that_gave_up_can_be_claimed_again`; `keeper/host_proc.rs`
`no_restart_while_the_app_is_quitting`.
Platforms: all.

**SU3. Stopping the host: its pid first, a real grace, then the group.**
Happened: a 300 ms grace cut the WAL checkpoint short (1ecb7393); a group TERM first would hit codex directly, which
leaves its thread lock behind on SIGTERM (#57).
Rule: TERM the host's pid alone, wait 3 s, then TERM its group; on unix stdin stays open until the end so EOF does not
race TERM into a second shutdown.
Guard: `keeper/host_proc/tests.rs` `a_host_is_stopped_pid_first_then_its_group_with_stdin_held`.
Platforms: macOS, Linux.

**SU4. Signals go through `kill(2)`, to a real pid or group only.**
Happened: `kill_group` ran `/bin/kill -TERM -<pid>`; procps-ng 4.0.3/4.0.4 (Ubuntu 24.04) read `-<pid>` as an option
and signalled the group named by the pid's first digit: `-130` became `kill(-1, SIGTERM)`, every process of the user,
on every quit of the direct path Linux runs (#350, fixed by #458).
Rule: call `kill(2)` directly; refuse 0, 1 and numbers past `i32::MAX`; never signal the caller's own group; never
shell out to `kill`.
Guard: `keeper/host_proc.rs` `kill_group_signals_the_group_the_pid_leads_and_nothing_else`; `keeper/host_proc.rs`
`signals_go_only_to_a_real_pid_or_group`.
Platforms: macOS, Linux. *Changed by #458.*

**SU5. On Windows the polite stop is closing stdin, and the kill is checked.**
Happened: Windows has no TERM; quitting stalled for the full grace, then hard-killed a host that never released its
lock (#307).
Rule: close the host's stdin, wait the grace, then `taskkill /T /F` only if the host is still running (an ended pid
may already be someone else's).
Guard: `keeper/host_proc/tests.rs` `a_windows_host_is_asked_to_stop_by_closing_its_stdin` (Windows CI's Rust unit tests).
Platforms: Windows.

**SU6. A host's group stop does not escalate.**
Happened: found while collecting this list: the group gets TERM only, then the leader alone gets KILL, so a stuck
grandchild in the group survives.
Rule: a group stop ends with KILL to the group.
Guard: **UNGUARDED**.
Platforms: macOS, Linux.

**SU7. A host the keeper did not start is supervised by its identity, not its number.**
Happened: #840 item 8: a handed-over host was watched by its bare pid, so once it ended and its parent reaped it, a
new process given that pid read as the host still running, and a stop would have sent it SIGKILL.
Rule: a handed-over host is not the keeper's child: it is watched by a kqueue registration (macOS) or a pidfd
(Linux) made in the handoff's `prepare`, before `ready` (`os::process::ProcessWatch`), and an end once seen stays
seen. Only "no such process" (`ESRCH`) at registration means it has gone; any other failure, and a system with
neither, falls back to the pid, where EPERM from `kill(pid, 0)` means alive.
Removed: went with #1895 step 4 PR 4, which removed the keeper handoff (`keeper/handoff/`, `os/unix/handles.rs`, `host_proc/handover.rs`, `keeper-handoff-integration.mjs`) and its guards: a keeper runs one build, and one started with `--take-over-fd` exits with code 7, which a sending keeper reads as an aborted handoff (`keeper/keeper/server/tests.rs` `a_keeper_started_to_take_another_over_exits_at_once`). `keeper/os/unix.rs` `a_process_we_may_not_signal_is_alive` stays.
Platforms: macOS, Linux.

**SU8. The window reaps every child it starts.**
Happened: fire-and-forget children (alerts, `open`) left a zombie each (40d3565e).
Rule: every child the window spawns is waited on.
Guard: **UNGUARDED**.
Platforms: all.
