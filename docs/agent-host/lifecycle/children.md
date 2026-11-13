# The children the host starts, under a keeper too (#280, #1895)

The host spawns its agents, terminals and Run commands itself on every machine, under a keeper too, and every ending
stops them, or stops them for an update ([updates.md](updates.md)). It never connects to the keeper's
`<data>/children.sock`, lists no keeper children at start and takes none over ([plans/keeper-removal.md](../../plans/keeper-removal.md)
§4). The keeper has no children service: its `children` op answers an empty list, and a socket a dead holding keeper left is removed at start. The design is in [architecture.md](../../architecture.md) §4.3.

**Agents.** The host starts the CLI itself, Claude's through `spawnClaudeCodeProcess` too (`adapters/local-process.ts`).
On macOS and Linux it gets a process group of its own; a stop is `kill-tree.ts`'s TERM to every group in its tree and
KILL to the survivors after 3 s, and once it has exited its group is swept the same way (`stopGroup`). On Windows a
stop reads the process table, ends the CLI alone and then what the table showed under it, parents before children (`taskkill /T` only when the table cannot be read, #2141), and once it has exited what it left running is found by parent links and
creation times and ended (`collectOrphansWindows`), against a start time taken before the spawn. The start and the
sweep are the ones app processes use (`dev-services/grouped-child.ts`: `spawnGrouped`, `sweepExited`). An agent CLI
starts helpers of its own: Claude Code's LSP tool runs `typescript-language-server`, which runs `tsserver` (one
reached 3.4 GB); MCP servers from the user's config; shells. They share the CLI's group, so a stop and the sweep after
an exit reach them too. Being in a group of its own, the CLI is no longer in the host's, so
every CLI the host starts, Claude Code, Codex's app-server and the ACP tools alike, starts behind the host watch
(`endsWithHost`, `HOST_WATCH`): a pipe only the host holds, whose close ends the CLI's group however the host went,
SIGKILL included, and whatever the CLI does with stdin's end (#1654; one start for every tool,
`adapters/core/tool-process.ts`). The shell behind the watch also looks the CLI up itself before it starts it (on PATH as libuv does, relative and empty entries included, not with `command -v`, which differs by shell: Ubuntu 22.04's dash 0.5.11 names the first file of a name even when it cannot be run) and says on fd 4 when it is not there or cannot be run, so the host raises the same ENOENT or EACCES 'error' Node's spawn gives without the watch, not an "exited (code 127)". Windows has no such watch: there a host's children end with it through its kill-on-close job. The SDK adds the end of the CLI's stderr to a failure only for a process it spawned itself, so both
adapters add it the same way (`withStderrTail`, `stream-text.ts`): the host's own child keeps the
last 8 KiB of stderr (`AgentProcess.stderrTail`), decoded as one stream so a character split between two chunks stays
whole, and Claude's `adapter_crashed` and Codex's "codex app-server exited" carry it.
A Codex app-server that exits **while its session has no turn in flight** (nothing running, no message whose `turn/start` is still unanswered, none queued, no input waiting for its turn, no blocking command, and the process had finished starting: a message sent just before the exit is lost with the process, so it is a crash with the stderr tail, not sleep) is not a crash (#1397): an idle Codex session keeps its app-server until it is put to sleep (#568, #2027), so a system shutdown, a logout or a kill lands on such sessions. The adapter says `session_live` (`live: false`, `reason: 'asleep'`) instead of an `adapter_crashed` error, whatever the exit code; the manager retires the handle (as for a crash, only from the handle registered now) and the next message resumes the thread. No error, no mark. A session the host still reads as in a turn then (its end was lost, #1829) is set to `waiting_input`: no process is left to end it. A Stop with no turn running and none that can start says the session stopped at once, as Claude's does, since no `turn/completed` will come. An exit during a turn is still `adapter_crashed`; one the computer's shutdown caused is found by the next start and set to stopped with the `shutdown` interruption ([turn-endings-and-mail.md](turn-endings-and-mail.md), #1397). A Claude Code process that exits on its own follows the same rule (owner decision Q1 on #1654; the same `MidTurnLedger.exited`, with Claude's `inFlight`), whether the SDK's stream ends or throws: asleep with no turn open, no tracked input or card waiting, no message the CLI has not read or answered (a quiet input included, or one held behind `/goal` or the sign-in race), no background agent or shell still running (it goes with the process), and once the CLI has said anything on its stream; otherwise `adapter_crashed` with the stderr tail. The shutdown is told from a crash at the next start, not by a power-off signal per OS: a host the system kills may never see one, while its last heartbeat and the boot time are always there.

**Terminals and commands.** `TerminalService` and `CommandRunner` run node-pty; stopping or closing them walks the
process tree (`kill-tree.ts`). Closing a terminal takes the tree before the shell gets its hang-up: a dev server started
from it is in a group of its own (job control), and one that ignored the hang-up used to be left running. Both hold
each pty in a `PtySlot` (`dev-services/pty-slot.ts`, #428): its output (256 KiB), its exit, reported once the output
has ended (at most 1 s after it, `exit-after-drain.ts`), its tree stopped, and a failed start, node-pty not loading
included, said on screen and followed by an exit.

**Leaving** (`lifecycle/shutdown.ts`, `stopPlan(parts)`). Every ending is a stop: SIGTERM, SIGINT, SIGHUP,
the parent's pipe closing, an uncaught exception, `host.stop`, and the keeper's or the window's stop line. Terminals and
runs are ended first, synchronously, then sessions are disposed and app processes and the in-process servers stop.
A stop for an update (the keeper's or the window's stop line with `forUpdate`, a hub's `host.stop { forUpdate }`)
is the same stop, and first writes the open app views down ([front-door.md](front-door.md)) and lists the turns, terminals and runs it ends for
the next host, which reopens and continues them ([updates.md](updates.md)). The adapters have no detach any more, and there is no leave
mode that lets agents run on.

**A host that crashes.** The keeper restarts it by its usual rules ([keeper.md](keeper.md)). The agents end with the old host through
the host watch, its terminals and runs with it; a turn in flight shows stopped with Continue ([turn-endings-and-mail.md](turn-endings-and-mail.md)), as on Windows
and Linux. Only a stop for an update lists turns to continue.

**Strays.** `strays.ts` rule 3 counts only the host's own descendants as ours. Processes a holding keeper of an earlier
build left behind when it died hard (`kill -9`, a crash) are in sessions of their own under init. Ours is what the
nearest owner mark up its parent chain says is ours ([KL6](../../runtime-lessons/stopping-process-trees.md), #1898): what an earlier host on the same data
folder left (a crash, an update) is offered; what was started before the mark existed, those keepers' children included
([plans/keeper-removal.md](../../plans/keeper-removal.md) §5, risk 2), is not, nor anything whose environment cannot be read.
Stopping the ones a person chose (`stopStrays`) is the two shots every stop uses: SIGTERM to those still leftovers,
then, after 3 s, SIGKILL to those that still are and still run the same command, measured again each time (#428).
Both walk the table with `dev-services/proc-table.ts`, as `kill-tree.ts` does.

**Activity.** The activity report counts the host's own terminals, runs and live sessions. While no host is up the
keeper counts nothing; its idle limit is 30 minutes and a crashed host is back in seconds.

The `update` scenario of `scripts/keeper-integration.mjs` (in `keeper-integration-relaunch.mjs`) drives this with the
real binary and host: the keeper serves no child socket, the host runs a terminal and a dev server itself, a stop for
an update ends them and the next host opens them again, a SIGKILLed host's processes end with it and its terminals are
not reopened, and a stop ends the keeper, the host and its children. `--claude` adds a claude (haiku) turn that the
update cuts and the next host continues, and one the crash cuts. CI runs it without `--claude` ([keeper.md](keeper.md)).
