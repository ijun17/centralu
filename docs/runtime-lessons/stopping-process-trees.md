# Stopping process trees

These are the host's own rules for what it starts without a keeper (terminals, commands, app processes, and agents on
Windows and in debug builds). The keeper's equivalents are [keeper-children-and-handoff.md](keeper-children-and-handoff.md#children-the-keeper-holds).

**KL1. Stop signals the tree, not the shell.**
Happened: node-pty's `kill()` signals one pid; commands run as `zsh -lc <cmd>`, so the shell died and the dev server
kept its port (63c27e84).
Rule: Stop signals the process group, TERM then KILL after 3 s.
Guard: `host/dev-services/commands.test.ts` "stop sends SIGTERM to the process group, and SIGKILL if it is still
alive after the grace period"; `host/dev-services/commands.test.ts` "no SIGKILL if it dies within the grace period —
a polite exit is honored".
Platforms: macOS, Linux.

**KL2. An interactive shell puts each job in its own group.**
Happened: a server started in a terminal tab had its own pgid; killing the shell's group missed it, and a server that
handles HUP survived quitting (d2993770).
Rule: walk `ps -A -o pid=,ppid=,pgid=` from the root and signal every group a descendant belongs to.
Guard: `host/os/kill-tree.test.ts` "an interactive shell: a job with its own group is a target too";
`host/os/kill-tree.test.ts` "follows all the way to a grandchild — a tree, not a list of children".
Platforms: macOS, Linux.

**KL3. Never our own group, init or group 0.**
Rule: our pgid and every pgid ≤ 1 are excluded from every shot.
Guard: `host/os/kill-tree.test.ts` "never fires at our own group — killing ourselves during cleanup would
leave the rest behind"; `host/os/kill-tree.test.ts` "init(1) and group 0 are never targets — this is where
the system itself could almost be fired at". The own-group return in `stopGroup` is **UNGUARDED**.
Platforms: macOS, Linux.

**KL4. A pid missing from `ps` is gone; fire nothing at it.**
Happened: the second shot assumed a pid missing from `ps` led its own group, which could SIGKILL whoever got the
recycled number (e7ea439a).
Rule: `ps` read and the root absent means no targets; fall back to `-root` only when `ps` itself failed; the same pid
in another group is someone else.
POSIX has the same window, much smaller, and no creation time is added (#2206): the second shot takes pid **and** group as the identity and reads `ps` again right before it fires, and a group is not reused while it has members. What is left is the milliseconds between a `ps` read and its signal, against a wrap of the number space: 32,768 by the kernel's default (about 22 s of forking at the 1,500 a second measured on Linux), 4,194,304 where systemd sets it (WSL, about 47 minutes), 99,999 on macOS (not measured, about 67 s at that rate). A creation time would be `ps lstart` (a locale-dependent text), `/proc/<pid>/stat` (Linux only) and nothing on macOS: three sources, not the one reader of Windows.
Guard: `host/os/kill-tree.test.ts` "fires at nothing when ps was read but root is missing — this is where a
recycled pid could be hit"; `host/os/kill-tree.test.ts` "the same pid in a different group is someone else
— a spot where the number was recycled in the meantime".
Platforms: macOS, Linux.

**KL5. The second shot aims at what the first shot saw.**
Happened: the root died on TERM, its children were reparented to init, a re-walk from the root found nothing and a
grandchild survived (#149, 65acb436).
Rule: the KILL targets the groups of whatever from the first list is still there with the same pid and pgid, plus
anything they started since.
Guard: `host/os/kill-tree.test.ts` "even when the grandchild is in root's group (zsh -lc, an app process)
and the caller saw root end, it is hit by SIGKILL after the grace period";
`host/os/kill-tree.test.ts` "even if root dies first, a surviving descendant in that group fires at the
whole group".
Platforms: macOS, Linux.

**KL6. What escaped the tree is shown, not killed.**
Happened: a dev server an agent started had ppid 1 and its own group; the VS Code Claude extension was SIGTERMed by
an early version (4a69b96f).
Rule: a stray is offered only when its cwd is inside a project, it has no tty, it is not under the host or a keeper
child, it is not what started the host, and its parent chain reaches init (or WSL's `/init` helper, found by probing where
a short-lived orphan lands and read only when its command is exactly `/init`) through other candidates; it is measured
again right before the kill. `systemd --user` is not taken for init: it also adopts an editor that detached itself
(`code .` from a terminal in the project), so a systemd desktop's own leftovers are missed, by choice (**UNGUARDED**
as a miss; a positive signal that a process came from our agents would fix it).
Guard: `host/dev-services/strays.test.ts` "picks only someone else's process running with no terminal in our
folder"; `host/dev-services/strays.test.ts` "a process a living app still holds is not on the list (VS Code
extensions)"; `host/dev-services/strays.test.ts` "never offers a child the keeper holds for this host, or what runs
under it"; `host/dev-services/strays.test.ts` "an orphan adopted by the machine's subreaper is on the list; what a living
parent holds is not, and nor is what started the host" (WSL's `/init`, #1882); `host/dev-services/strays.test.ts` "an editor
that detached itself under `systemd --user` is not offered, even though that process adopts orphans". Measuring again
before the kill is **UNGUARDED**.
Platforms: macOS, Linux.

**KL7. An agent's helpers end with it.**
Happened: only the CLI's pid was signalled; typescript-language-server and tsserver (one at 3.4 GB), MCP servers and
shells were reparented to launchd or init (#435, b1ffaca3).
Rule: the CLI leads a process group of its own; a stop signals that group only; after the CLI exits its group is swept
(TERM, KILL after the grace). On Windows: the table read, the CLI ended alone, then what was under it parents first
(`taskkill /T` only when the table cannot be read, #2141), and after exit the leftovers found by parent pid and
creation time.
Guard: `host/adapters/local-process.test.ts` "leads a process group of its own, not the host’s";
`host/adapters/local-process.test.ts` "a CLI that exits by itself does not leave its helper running";
`host/adapters/local-process.test.ts` "a stop ends the CLI first and then what was under it";
`host/adapters/claude/local-spawn.test.ts` "spawns the CLI itself, and stopping it ends the helper the CLI leaves
behind".
Platforms: all.

**KL8. Closing a terminal takes the tree, then hangs up.**
Happened: `close()` sent SIGHUP to the shell only, and a job-control server that ignored HUP kept its port (#435).
Rule: `stopTree` while the shell is alive (the tree is only visible under it), then HUP; no HUP on Windows.
Guard: `host/dev-services/terminal.test.ts` "closing one also ends a server started from its shell that ignores the
hang-up". The Windows branch is **UNGUARDED**.
Platforms: all.

**KL9. Quitting kills every pty tree at once.**
Happened: dispose sent one HUP, and a server that handles HUP outlived quitting (d2993770).
Rule: dispose sends KILL to every live pty's tree with no grace.
Guard: `host/dev-services/commands.test.ts` "an app shutdown (disposeAll) sends SIGKILL to the group immediately —
there is no process to wait a grace period for". The terminal's `disposeAll` is **UNGUARDED**.
Platforms: macOS, Linux.

**KL10. A group whose leader exited is still swept.**
Happened: an app that exited cleanly left a helper in its group, which ignored TERM and was orphaned (9a8a56f0).
Rule: `stopGroup(pgid)` in two shots; safe because a pgid is not reused while it has members.
Guard: `host/apps/external/lifecycle.test.ts` "even a descendant left by an app that ended cleanly on its own is
collected — its entire group is ended".
Platforms: macOS, Linux.

**KL11. On Windows node-pty takes no signal, and there is one shot.**
Happened: `kill("SIGTERM")` throws on Windows; Stop, restart, project removal and shutdown did nothing, and a throw from
a pty that was not ready crashed the host (#14, 46e78012).
Rule: `taskkill /PID n /T /F`, then `kill()` with no argument, both failures swallowed; no second shot by pid (it may
be someone else's by then).
Guard: `host/os/kill-tree.test.ts` "the tree goes with taskkill, and the pty is closed without a signal";
`host/os/kill-tree.test.ts` "Stop is one forceful shot: no second shot by pid after the grace period".
Platforms: Windows.

**KL12. On Windows leftovers are found by parent and creation time.**
Happened: Windows has no groups, so a helper outlived its app; libuv's job object hides this for plain Node children
but not for detached or Python ones (285be4e9, #360).
Rule: read the process table with its parent ids and creation times (the warm reader, `os/process-table.ts`, #2178); take the dead root's children created inside its lifetime (a clock tick of slack at the end: Node's clock runs
behind the creation times, #1773), and deeper children no older than their parent; `taskkill` each, never ourselves, never throw. One that is no longer
there (a console child's conhost.exe ends with its parent) has no taskkill started for it, and one that ended while taskkill was at it is not reported (#2200: the
answer is exit code 255 or 128 in the system's language, so the process being gone is what says it). **A number is reused**: before it ends a process of the sweep, the stop reads the table again (the same reader, in the time a taskkill is given) and ends it only if that pid still has the creation time the sweep saw it with (what remains is the milliseconds from that read to the taskkill); another creation time means the number is another process's, which `taskkill /T` would take with its tree, so it is skipped as gone (`ProcessGone`, #2206). A table that cannot be read leaves the process alone and says so.
Guard: `host/os/kill-tree.test.ts` "ends no process that has another creation time than the table showed it with, whose number it has now"; `host/os/kill-tree.test.ts` "a leftover that ended before taskkill reached it"; `host/os/kill-tree.test.ts` "a child created within a clock tick after the exit as the host read it is
the root's own, a later one a later holder's"; `host/apps/external/lifecycle.test.ts` "on Windows, a descendant started outside the app's job,
left by an app that ended on its own, is ended — no orphan is left behind".
Platforms: Windows.

**KL13. A replaced handle's late events are ignored.**
Happened: `restart()` killed the old pty; its exit arrived after the new pty took the slot and marked the terminal dead
(3492dd38); a replaced Claude handle's late crash killed the new one (#157).
Rule: events act only when they come from the current handle; dispose terminates the Claude process, and an error after
close is not a crash.
Guard: `host/dev-services/terminal.test.ts` "a late exit from the old shell does not overwrite the new shell";
`host/adapters/claude/index.test.ts` "does not raise a crash even when the stream ends with an exception after closing,
and terminates the process on close (#157)".
Platforms: all.

**KL14. Codex is closed with stdin EOF, not a signal.**
Happened: measured with codex-cli 0.147: EOF exits in 18 ms and removes `thread-writer-locks/<id>.lock`; SIGTERM
leaves it, and the thread stays locked (#57, df9651ee).
Rule: end stdin, wait up to 2 s, then KILL.
Guard: `host/adapters/codex/client.test.ts` "expected=true when we close it — does not report it as having died". That
EOF comes before any signal is **UNGUARDED**.
Platforms: all.

**KL15. On Windows closed Claude processes are given time to leave.**
Happened: libuv's job object kills children when the Node parent exits, possibly while Claude writes a refreshed token;
an idle claude left 0.6–0.9 s after its stdin closed (#353).
Rule: before the host exits, wait up to 1.5 s for the processes disposal closed.
Guard: `host/adapters/claude/windows-start.test.ts` "waits for the closed Claude processes to leave by themselves";
`host/adapters/claude/windows-start.test.ts` "never longer than its cap".
Platforms: Windows.

**KL16. App processes stop by closing their input, then their tree.**
Happened: closing only stdin did not end a Node app holding fd 3 or the Python SDK's read thread; three fixture apps
were found orphaned (9a8a56f0).
Rule: close stdin and fd 3 together, wait the grace, then stop the tree; `dispose` stops every process ever spawned,
including ones no entry holds.
Guard: `host/apps/external/lifecycle.test.ts` "closing stdin and fd 3 together lets even an app holding fd 3 open end
on its own within the grace period"; `host/apps/external/lifecycle.test.ts` "when the host exits (dispose), every
running app stops".
Platforms: all.

**KL17. Removing a project ends what runs in it.**
Happened: deleting a project left its terminals and Run-menu processes running until the app quit (#177, #201).
Guard: `host/project-delete-processes.test.ts` "a deleted project's terminals and executions end, and do not come back
when the same folder is re-added".
Platforms: all.

**KL18. On Windows a process holds its working directory.**
Happened: Windows refuses to move a folder that is some process's cwd (EBUSY); a process stops answering
`kill(pid, 0)` a few ms before it releases that handle (#360, #415).
Rule: stop the process and wait for its tree before moving or removing its folder.
Guard: `host/sessions/mcp-apps.test.ts` "removing a user-folder app drops it from the list and the Assistant, and its
folder goes to app-trash" (catches EBUSY only on the Windows CI job).
Platforms: Windows.

**KL19. stderr is always read, and exit comes after the last output.**
Happened: a CLI whose stderr nobody reads blocks once the pipe is full; a reader saw the exit before the last line
(b1ffaca3).
Rule: stderr is read and its last 8 KB kept for crash messages; exit is reported on stdout's end or after 1 s.
Guard: `host/adapters/claude/local-spawn.test.ts` "a failure still carries the end of what the CLI wrote to stderr".
Exit-after-output for the host's own processes is **UNGUARDED**.
Platforms: all.

**KL20. On Windows the app's fd 3 is overlapped.**
Happened: on a plain pipe, Windows serializes I/O on the synchronous handle; the app's read blocked its own write and
every broker call timed out on the first Windows run (eeed2312).
Rule: `stdio: ['pipe', 'pipe', 'pipe', 'overlapped']`.
Guard: `host/apps/external/mediation.test.ts` "accepts a broker call carrying its own run id — a request never declared
is refused by the desk with a reason" (catches it only on the Windows CI job).
Platforms: Windows.
