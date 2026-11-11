# Moving sessions to a newly installed agent CLI (#297)

Every session runs its own agent process, started from the CLI installed at the time, and an update to `claude` or
`codex` reaches a session only when its process starts again. A process lives as long as its host, which in background
mode outlives every window ([keeper.md](keeper.md)), so a person who uses Centralu daily could run an old CLI for a long time. `agent-versions.ts` knows both sides and
restarts a session on the installed CLI when nothing in it would be lost.

**The installed version** (`AgentAdapter.installedVersion`, `cli-version.ts`), read at host start, every ten minutes,
and when a window gains focus (`agents.versions { force: false }`, answered from a reading under 30 s old):

1. npm's `package.json` beside the file the command runs (`whichTool`, then `launchFor` for a Windows shim, then the
   symlink's target), with the package name checked: `@anthropic-ai/claude-code`, `@openai/codex`. No process runs.
   On Windows this is the only way it is read: Claude starts from the host's own link under
   `<data>\tools\claude\…` ([../host-process.md](../host-process.md), "How a Claude process is started on Windows"), and running npm's `claude.exe` to
   ask would hold the file an npm update has to replace.
2. The file's own name when it is a version: Claude Code's native installer links `claude` to
   `~/.local/share/claude/versions/<version>`.
3. `<cli> --version`, off Windows only (a Homebrew cask, a manual install).

**The running version** is `SessionInfo.agentVersion`: what the process reported (`agent_version`, [../adapters/contract.md](../adapters/contract.md)), and until it
does, the installed version when it was started. No process outlives its host any more, so nothing hands a version
from one host to the next (before #1895 step 4 PR 1 the keeper's child tag did). A session whose version is unknown is
never moved by itself (unknown is never "older", `runsOlderCli`), until its next restart.

**When a session is moved** (`restartDecision`): it is live, it runs an older version than the installed one, it is
idle by `sessionIdle` (at rest by `busyWith`, whose part it names: no turn, no approval or question, no live background
task; and a tool that cannot report background work is never idle), and, when it moves by itself, nothing has come from it for 60 s (counted from host start
for a session the host has not heard from). The quiet period is for the person: a turn that just ended is when they read
the answer and type the next message. `sessionIdle` reads the same facts about a session as `hostBusy`, but leaves
out terminals and commands, which a session restart does not touch, and never calls a tool idle that cannot report
its background work.

| Decision | Why |
|---|---|
| Moving by itself is on by default ("Move idle sessions to a newly installed agent CLI", `agents.setAutoApplyVersions`, saved as `agents.autoApplyVersions`) | The owner's decision (2026-10-05). The restart waits until nothing would be lost, and the conversation continues through resume |
| The header's action (`agents.applyVersions`) restarts every idle outdated session at once, without the quiet period | The update is app-wide; a person who just updated wants every session on it. A busy one is listed and keeps the line |
| The restart is the manager's `restartSession` | The same path as "Restart agent": the handle is disposed (stdin closed, then a signal), and the session resumes in a newly spawned process. Nothing is re-attached, so the new process is the new CLI (`sessions/agent-versions-restart.test.ts`) |
| The conversation gets one line from Centralu, "Claude Code restarted on 2.1.290 (was 2.1.282). The conversation continues." | A process restarted by itself is never silent |
| The installed versions last seen are kept (`agents.versionsSeen`) | An update made while the app was closed still counts as a change |

**Default tool resolution (#573).**

The registry resolves a saved tool only when its adapter is registered, otherwise the first registered adapter.
An empty registry returns no tool (`null`): project listing and serving apps still work on a host with no agents.
Creating a session without a tool fails with `tool_not_installed` and asks the person to install and configure an
agent CLI. Linked projects keep a missing default too; creating a session there requires an available tool.

**Tool definitions after a host switch (#581).**

The keeper can preserve an agent process across a Centralu update, but that process also preserves the Centralu MCP
definitions it was started with. `LaunchRecords.refreshToolDefinitions()` compares the profile's served definitions
and instructions using `residentCost(...).prefixHash`; the adapter declares the serving form in
the adapter capabilities (`toolDeferral` and `instructionChannel`), rather than the manager naming a CLI.
The hash is kept in an app setting per session.
On a changed hash, a live idle session restarts through the same resume path as #297; a working or approval-waiting
session restarts after its turn; a sleeping session has no process and records the new hash for its next wake. Thus the
conversation continues while the next process sees the new tools.

**Launch settings after a host switch (#589).**

A live process keeps the adapter policy it was started with: Codex sandbox roots and network settings, or Claude
launch options and environment controls. Each adapter may report a versioned
`launchSettingsFingerprint(settings)` for the stable, session-specific launch inputs. The manager keeps that value in
an app setting per session and compares it when the tool definitions are refreshed and when a project's trust changes
(`refreshLaunchSettings`). Before #1895 step 4 PR 1 it also compared it after taking over a keeper's children. A mismatch restarts an idle process through
the ordinary resume path, waits for a working or approval-waiting process to finish its turn, and is simply recorded
for an asleep session with no process. The host never names a CLI or interprets the fingerprint; changing an adapter's
derived launch policy means changing its own fingerprint.

Codex's fingerprint is version 2 since #597 changes `auto` from workspace-write to full access. It includes
the adapter's sandbox override (`normal` leaves that mode to the person's settings). Kept sessions restart
through `launch_settings` so they pick up the changed sandbox.

A missing stored fingerprint is also a mismatch: builds before this check kept processes with unknown
launch settings. The update that introduces it therefore restarts each retained process once, at the
same safe boundary, and records the new fingerprint.
Both changed and previously unrecorded launch settings use the `launch_settings` cache rebuild cause
("launch settings changed"); the restart log says "launch settings changed or previously unrecorded".
This is separate from `instructions` ("tools changed").

**The capability check seam** (#270). On every change of an installed CLI's version the service calls
`capabilityCheck({ tool, from, to })`. #270 proposes re-running the probes for what a tool could not do when its version
moves; nothing implements that yet, so the default writes one line to host.log saying so. The probes plug in there.

## Putting idle sessions to sleep (#568)

Every session runs its own agent process, and an idle one keeps its memory: one Claude process was 240-300 MB after a
few turns and grew while idle (a three-day Opus session was 814 MB, #561). Ending it frees all of it, and resuming the
conversation later reads the prompt cache as the live process would have. Measured in #561 (CLI 2.1.29x, haiku): the
next turn read ~100% from cache resumed as live, at 2, 6 and 10 minutes on the 1 h lifetime and at 2 and 4 minutes on a
forced 5 min one; both expired alike at 6 minutes on 5 min. A wake adds +0.7 s (p50) and +1.8 s (p95) before the first
token. So the host puts idle sessions to sleep (`sessions/sleep.ts`, `SessionSleeper`), a policy of the host's and not
of a tool's:

| Rule | Why |
|---|---|
| A live session sleeps once it has said nothing (no event of any kind) for the set time: **15 minutes** by default, "Put idle sessions to sleep after" in Settings → Background (`agents.setSleepPolicy`, saved as `agents.sleepAfterMinutes`, `off` for never) | The owner's decision (2026-10-12). Inside the 1 h cache lifetime Claude Code asks for, so the wake still reads the cache |
| Only a tool whose adapter says so (`capabilities.sleep`): Claude yes, Codex no | Claude's resume was measured to keep the cache. A large Codex thread took 7-13 s to resume and its cache on resume is unmeasured; Codex's memory is better won by one shared app-server per account (#561 E3), decided separately |
| Never while `sessionIdle` says no: a turn, an approval or a question waiting, background work (the CLI's own timers included, below), or a tool that cannot report its background work | The same rule as moving a session to a new CLI ([Moving sessions to a newly installed agent CLI](#moving-sessions-to-a-newly-installed-agent-cli-297)): ending the process would end what it holds |
| Never while it waits on others (`waitsOn`): a child it started with `start_agent` (or a session handling its ask_project task) still in the turn it gave it, a session it owns (`askedBy`; a former worktree manager's worktree sessions, #561) while that one works, or a session that owes it a report (`reportBack`), except one whose report is paused over its own background work while it rests (#721, [../delegation/start-agent-steps.md](../delegation/start-agent-steps.md) step 7) | Their answer comes back to it in moments, and waking it for that costs the resume it saved. A child waiting on its parent sleeps by the ordinary rule: it is idle |
| The quiet period counts from host start for a session this host has not heard from | A host that just replaced another (a restart, a swap) does not know what the person was doing a second ago |
| Sleeping is `SessionProcesses.sleepSession`: refused unless still idle, the handle leaves the map, `session_live {live: false, reason: 'asleep'}` goes out, the process is disposed. A message arriving meanwhile starts a resume that waits for the dispose (`sleeping`) | Never two processes on one conversation; a send is never lost to a closing handle |
| Waking is the ordinary `resumeSession`, the path a session takes after a host restart; every resume sends `session_live {live: true}` | One path to keep right. The event tells every window, not only the one that asked |
| `session_live {live: false}` also goes out when a process is dropped and no new one takes its place (#648): `reason: 'restart_failed'` when a restart the host started (a refresh, a CLI move, "Restart agent") did not bring a process up, `'crashed'` when the process died | Before this the windows kept showing the session live, the screen's wake stepped back, and the person learnt only when a send failed. Now it shows asleep, and the next message wakes it |
| The dispose stops the process the host started (stdin closed, signalled). The sweep stops before the sessions are let go of in the shutdown (`stopPlan`) | A sleep then would race the sessions' own stop |
| The screen wakes a session when its composer takes the keyboard or gets its first key, and on send; never on selecting or viewing it, and the grid's panels are not woken at startup | A session looked at is not a session typed to. The resume runs while the person types, so its 0.7 s is mostly hidden. Before #568 selecting woke a session and the grid woke every panel at startup, to hide a slow Codex resume |
| Asleep shows quietly: the sidebar's tool mark is drawn exactly as the same session awake in the same state (a fade would read as a stalled session, #670) and only its tooltip says "asleep"; the conversation's line says "Asleep — it wakes when you type to it", then "Waking session…" while it starts | Not a state to act on, so no colour and no badge; but a person who wonders why the first answer is slower can find out |

`CC_SLEEP_AFTER_MS` sets a shorter quiet period over the setting, for probes and tests. `probe-resume-cache.mts`
re-measures the cache on a woken turn through a real host ([../adapters/vendor-drift-checks.md](../adapters/vendor-drift-checks.md)); run it on a Claude Code update. Its first run
(2026-10-12, haiku, `CC_SLEEP_AFTER_MS=20000`, 120 s more of quiet): asleep after 23 s, the woken turn read 99.7% of
26,198 input tokens from cache (the warm turn before it 99.2%), and took 4.6 s from send to end against 2.3 s warm, the
resume and the transcript catch-up included.

**The CLI's own timers count as background work.** `/loop` and scheduled prompts are timers inside the Claude process
(`ScheduleWakeup`, `CronCreate`), which the CLI does not report as tasks; a process put to sleep or restarted loses
them silently. The Claude adapter reads them off the calls and their structured results (`ClaudeSchedules` in
`adapters/claude/schedules.ts`) and lists each pending one with the session's background tasks (kind `other`, not
stoppable on its own), so `sessionIdle` says `background`. A wake-up is pending until its `scheduledFor` (else the
asked delay, else the runtime's one-hour maximum), or until `ScheduleWakeup {stop: true}`; a cron job until
`CronDelete` names it, a `CronList` answer omits it, or it auto-expires after seven days (a one-shot job is kept as
long, conservatively). The adapter looks again a second after the next one is due. A process adopted from a previous
host reads them back from its conversation's last 400 messages (the transcript has no structured results, so a
wake-up counts its asked delay from the adoption). The tool mark's tooltip on the sidebar row lists them (its dot says that some run) and says the session stays
awake until they end. A Codex session is never put to sleep, so its own scheduling needs nothing here.

Not covered: the reconnect recovery still wakes the sessions that were live before a host restart without a keeper.
