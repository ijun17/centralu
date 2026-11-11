# The host process contract

**HO1. stdout carries the handshake and nothing else.**
Happened: the ready line carries the token, so stdout must never reach a file; the opposite failure also happened: a
migration announced itself on stdout and left no trace in a Finder-launched app.
Rule: stdout carries only protocol lines (`ready`; under a keeper `swap`, `activity`) and final
refusals; diagnostics go to stderr; the stderr copy to `host.log` never includes stdout; lint allows only
`console.error`/`warn` outside `main.ts`.
Guard: `host/log-file.test.ts` "teeStderrToFile does not touch stdout — the token goes out that way".
Platforms: all.

**HO2. A final refusal is written synchronously to stdout and stops the retries.**
Happened: a lock conflict went to stderr only; the supervisor reads stdout, so it retried six times and showed
"exited (code 1)" (#184, 71ffb7f9). A store too new to read (#292) is the same kind.
Rule: write the refusal with `writeSync` to fd 1 (stdout to a pipe is asynchronous on macOS and `process.exit`
follows) and to stderr, exit 1 with no ready line. The supervisor stops at "already using this data" and "written by a
newer Centralu"; those phrases are a contract.
Guard: `host/dev-services/instance-lock.test.ts` "a blocked host also writes the reason to stdout, and exits with 1";
`host/dev-services/store-min-reader.test.ts` "a host given a store it cannot read says so on stdout and exits with 1";
`keeper/host_proc.rs` `another_owner_of_the_data_is_reported_at_once`; `keeper/host_proc.rs`
`a_store_too_new_is_final_like_a_lock_conflict`.
Platforms: all.

**HO3. Logging starts before anything else.**
Happened: a Finder-launched app has stderr on `/dev/null`; a day was lost to codex's real error line landing nowhere
(15bff4fe), and the first data move's explanation was lost (6e0af69d).
Rule: the stderr copy to `<data>/host.log` starts as soon as the data folder is known, before PATH, the lock and the
store; the banner (build, Node, pid, db) is the first line.
Guard: `host/log-file.test.ts` "text written to stderr also remains in the file"; `host/log-file.test.ts` "the startup
banner states the build, DB, and pid on its own"; `host/lifecycle/host-process.test.ts` "the log is on before PATH and
the lock: a refused start says why in host.log, after the banner (HO3)"; `host/lifecycle/start.test.ts` "the log is on
before the PATH probe, the lock and the store (HO3)", with `StartSequence` throwing at a step `main.ts` takes out of
`START_ORDER`. *Changed by step 3.*
Platforms: all.

**HO4. Log rotation never keeps a closed descriptor number.**
Happened: after a failed rename the closed fd number stayed in use; the OS reissued it to the SQLite WAL, a pty or a
socket, and later log lines corrupted those (3492dd38). `host-errors.log` grew hundreds of MB a day.
Rule: the fd is cleared on close even when the rename fails; every log keeps one previous generation past 8 MiB; a
logging failure never throws.
Guard: `host/log-file.test.ts` "does not hold onto a dead fd when the rollover fails, and keeps writing to the same
file"; `host/log-file.test.ts` "rolls over and keeps only one prior generation once it overflows (does not silently eat
up the folder)"; `host/lifecycle/endings.test.ts` "keeps one previous generation once it passes its size, and the new
entry starts the file" (`host-errors.log`, `crashRecorder`). *Changed by step 3.*
Platforms: all.

**HO5. One path to exit, and it is the full shutdown.**
Happened: an early SIGINT/SIGTERM handler released the lock and called `process.exit(0)`; handlers run in order, so
the real shutdown never ran: every quit orphaned claude and codex and skipped the WAL checkpoint (3492dd38).
Rule: the only signal handler that leads to exit is the shutdown; the lock is released in `process.on('exit')`.
Guard: `tooling/launcher-serve.test.ts` "serves on 127.0.0.1 with its token, reports itself in --connection, refuses a
second serve, and stops on SIGTERM" (POSIX).
Platforms: macOS, Linux.

**HO6. A signal during startup is held, not obeyed.**
Happened: until a listener exists the kernel default kills the process; Ctrl+C right after the ready line killed
`centralu serve`'s host every time, and 3 s later shut it down cleanly (#390, 8cf2dd28).
Rule: holding handlers are installed right after the lock is taken; the first signal runs the shutdown as soon as it
exists; a second one during startup exits at once with 1, unless it comes within 1 s of the first (the same request
delivered twice, see HO8).
Guard: `tooling/launcher-serve.test.ts` "passes Ctrl+C (SIGINT) to the host, which shuts down cleanly";
`host/lifecycle/endings.test.ts` "a second one while still starting, a second or more later, exits at once with 1", "the
same request delivered twice while starting (within a second) does not exit" and "is held, not obeyed, and acted on once
the shutdown exists"; `host/lifecycle/start.test.ts` "signals are held right after the lock, before
anything that takes time (HO6)". *Changed by step 3.*
Platforms: macOS, Linux.

**HO7. The host ends when its parent's pipe closes, and only when asked to watch it.**
Happened: an exit hook alone left an orphaned host holding its port when the parent was SIGKILLed (8cc60ff0); deciding
by "is stdin a TTY" made a host with stdin on `/dev/null` kill itself (M1.5 defect 4).
Rule: only a supervisor passes `--watch-parent`; then stdin `end`/`close`/`error` is "parent gone" and the host shuts
down (a stop). Without the flag stdin EOF means nothing. This is the
only parent-death signal on Windows.
Guard: `tooling/launcher-serve.test.ts` "takes the host down when the launcher itself is killed, instead of leaving
it unsupervised"; `scripts/keeper-integration.mjs` check "a SIGKILLed keeper takes its host with it";
`host/lifecycle/host-process.test.ts` "without --watch-parent the end of stdin means nothing, and a signal still shuts it
down (HO7)" and "with --watch-parent the end of stdin is the parent gone, and the host shuts down (HO7)".
*Changed by step 3.*
Platforms: all.

**HO8. Shutdown order: ptys first, the store last, every close runs once.**
Happened: the supervisor allows 3 s before SIGKILL; pty children run in their own session, so a group kill cannot
reach them, and ptys disposed after `await mgr.disposeAll()` were never reached (3492dd38). When one step threw, the
store stayed open with its WAL unfolded, and on the signal path the host never exited (#396, bda7de5c).
Rule: in stop mode terminals and commands are disposed synchronously before any await; app processes stop in parallel
with sessions; the server closes last among services, then the store and the keeper connection; every close runs even
after a failure, the first error wins; a leave runs at most once and ends with its log line and exit 0. It is bounded
(10 s, past the supervisor's budget, for a host nothing supervises): past it, or at a second signal while leaving, the
host says so and exits 1 at once, never a second, different ending. A second signal within 1 s of the first is the same
request delivered twice (the launcher's forward and the terminal's own, SIGHUP right after SIGINT) and changes nothing
(`REPEAT_AFTER_MS`, `lifecycle/endings.ts`; owner, 2026-10-12). SIGHUP runs the shutdown like SIGINT and SIGTERM.
Guard: `host/lifecycle/shutdown.test.ts` "a close that throws does not skip the next one", "run when a step threw, and
the step's error is the one that comes out", "in stop mode terminals and commands end before anything is awaited, even
when the links never stop", "the server closes after every service, then the store, then the keeper connection", "a
service that fails to stop does not keep the server, the store or the keeper connection open", "a second ending changes
nothing: the services stop once and the process exits once" and "ends with its log line and exit 0 even when a step
failed", "a step that never settles does not hold the process: past the bound it says so and exits 1";
`host/lifecycle/endings.test.ts` "a second signal while shutting down, a second or more later, exits at once instead of
waiting it out", "the same request delivered twice (the launcher forward and the terminal, or SIGHUP right after SIGINT)
does not force the exit" and "a terminal closing (SIGHUP) runs the shutdown, not the kernel default".
*Changed by step 3*: the ptys used to be ended only after the ssh links were awaited, and a service that threw
skipped every service after it; `stopPlan` puts them first and `runSteps` runs every step.
Platforms: all (the setsid point is POSIX).

**HO9. Shutdown finishes within the supervisor's budget.**
Happened: a socket that connected but never said hello held `http.close()` open (5 s and counting, against 2 ms after
the fix); a peer that never answers a close frame makes `ws` wait 30 s (#82, 18541dcf).
Rule: close every socket, 250 ms grace, then terminate; `closeAllConnections()`; a second close is the same promise.
Guard: `host/transport/server.test.ts` "cuts a peer that never answers the close frame after the grace period";
`host/transport/server.test.ts` "does not wait for a half-sent HTTP request"; `host/transport/server.test.ts` "a second
close() is the same shutdown, not a new one"; `host/transport/server.test.ts` "a socket that connected but never said
hello does not hold close() open (HO9)". *Changed by step 3.*
Platforms: all.

**HO10. Rejections are survived; uncaught exceptions shut down in order.**
Happened: one rejection that leaked while adding a project killed the host and every unrelated session, and the
packaged app had no stderr to say why (df8ad446).
Rule: `unhandledRejection` is logged to stderr and `host-errors.log` and survived; `uncaughtException` is logged and
runs the normal shutdown.
Guard: `host/lifecycle/endings.test.ts` "a rejection is recorded and survived; an uncaught exception is recorded and
shuts down"; "a log that cannot be written is not thrown again". *Changed by step 3.*
Platforms: all.

**HO11. Nothing is pushed to clients before the server exists.**
Happened: an adopted pty replays its output as soon as it is attached; an await added before the server was declared
(#329) made every host restart that held a terminal crash, five times, until the keeper gave up (#348, ea5a9611).
Only a hand run noticed.
Rule: early frames are dropped (services keep their own scrollback); broadcasts before listen are swallowed.
Guard: `scripts/keeper-integration.mjs` scenario `update` (`keeper-integration-relaunch.mjs`) check "the keeper
restarts the crashed host";
`host/lifecycle/start.test.ts` "are dropped, not thrown, and the ones after it opens are sent" (`lifecycle/gate.ts`:
every service is handed a gate's `push`, never the server). *Changed by step 3.*
Platforms: macOS, Linux.

**HO12. The keeper's control lines reach only a host the keeper started.**
Happened: under the keeper, the host's stdin carries JSON control lines (#280 step 3); anyone else's stdin is not the
host's to read.
Rule: the control channel is attached only with `CC_KEEPER=1` or `CC_STARTED_BY=app` (the window, #1895); one object
per line, anything else ignored, a buffer past 64 KiB without a newline dropped; a line that comes before its handler
is kept for it.
Guard: `host/keeper-control.test.ts` "reads one JSON object per line, across chunk boundaries, and ignores anything
else"; `host/keeper-control.test.ts` "a line that grows past 64 KiB without a newline is dropped, even one that would
parse, and the next line is read (HO12)"; `host/keeper-control.test.ts` "keeps the last line of an op that came before
its handler, and gives it when the handler is set (#1895)". *Changed by step 3 and by #1895 step 4 PR 5, which removed
the waiters with the standby.*
Platforms: macOS, Linux.

**HO13. The host listens on loopback only, and a busy port is a sentence.**
Happened: a port conflict crashed the host because `ws` re-emits the HTTP server's error (m1-result.md).
Rule: listen on `127.0.0.1`; EADDRINUSE becomes a readable message and exit 1 with no ready line; `wss.on('error')`
is always attached.
Guard: `host/transport/server.test.ts` "binds the loopback address only"; `host/transport/server.test.ts` "a port
another program holds is a sentence to read, and the error never escapes as an uncaught one" (fails without the `wss`
error listener, and with a bind to every address). *Changed by step 3.*
Platforms: all.

**HO14. A failed spawn fails one session, never the host.**
Happened: ENOENT (after an nvm switch, or codex removed) arrives as `error`; without a listener it is an uncaught
exception that kills the host and every live session.
Rule: every child has an `error` listener; the failure ends only its session and `onExit` fires once; EPIPE on a
child's stdin (git, an app's fd 3) is swallowed.
Guard: `host/adapters/codex/client.test.ts` "a nonexistent command fails only this session, without killing the
process"; `host/dev-services/git-exec.test.ts` "fails only the call: EPIPE on its stdin never escapes";
`host/apps/external/app-process.test.ts` "fails the start, and EPIPE never escapes as an uncaught exception". The app's
stdin has two listeners (`app-process.ts` and `stream-transport.ts`, which every write goes through): the test fails
only with both removed. *Changed by step 3.*
Platforms: all.

**HO15. Detach or stop is decided by whether the keeper holds the children.**
Happened: under the keeper's child service a signal means a restart and the agents stay; without it, it is a stop
(#280 step 2).
Removed: detach mode went with #1895 step 4 PR 1 and the keeper's children service with PR 2: every ending is a
stop or a stop for an update, and its guards went with them. *Changed by step 3.*
Platforms: all.
