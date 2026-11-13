# Idle sessions of every tool sleep (#2027)

> **Status: Codex built (outcome A, §4a), the ACP tools not yet (§6a), 2026-11-13.** The owner decided on #2027 (2026-11-12): idle sessions of every tool sleep,
> not only Claude's; for Codex, measure a resume first (time to first token, cache read on the first request, threads of
> 1, 50 and 500 MB), then choose between a sleep rule and one shared app-server per account. #1895 option C stands: no
> new keeper agent-holding code. The setting stays the one of #568, "Put idle sessions to sleep after" (15 minutes).
> This document gives the measurement (§3), a design for each outcome (§4, §5), what it means for the ACP tools (§6),
> the wake paths (§7), the risks (§8) and the owner's questions (§9). PR 1 adds the measured numbers and the choice (§10).

Marks: **[checked: source]** was read or run; **[guess]** was not. File references are to `origin/main` 4b3be7aa4 and
are under `packages/agent-host/src/` unless named otherwise.

## 1. What is there today

- **One policy, already tool-neutral.** `SessionSleeper` and `sleepDecision` (`sessions/sleep.ts:64-80`) put a live
  session to sleep once it is idle, waits on nobody and has been quiet for the set time; a tool that does not declare
  `capabilities.sleep` gets `unsupported`. The only reader of the flag is `main.ts:547` `canSleep` [checked]. The rule
  and its reasons live in [agent-cli-updates.md "Putting idle sessions to sleep (#568)"](../agent-host/lifecycle/agent-cli-updates.md#putting-idle-sessions-to-sleep-568).
- **Sleep is "dispose the process", wake is "resume in a new process"**: `SessionProcesses.sleepSession`
  (`sessions/session-processes.ts:351-373`) and `resumeSession` (`:93-106`), the same path a session takes after a host
  restart [checked].
- **Codex declares `sleep: false`** (`adapters/codex/index.ts:82-87`): a large thread took 7-13 s to resume, its cache on
  resume is unmeasured, and the comment defers to a shared app-server [checked].
- **ACP declares `sleep: false` and `backgroundTasks: false`** for every ACP tool (`adapters/acp/profile.ts:14-26`; the
  Cursor, OpenCode and Antigravity profiles spread it and override neither) [checked]. With `backgroundTasks` false
  `SessionProcesses.sessionIdle` passes `reportsBackground: false` (`session-processes.ts:315`), and `sessionIdle`
  (`idle.ts:141-154`) then says `background_unknown` for as long as the process lives. **So flipping `sleep: true`
  alone does nothing for an ACP tool**; §6 is about that [checked].
- **The `processModel` capability** (`per-session` | `shared-server`, `packages/protocol/src/entities/tools.ts:194`) is
  set by every adapter and read by no code [checked: grep].
- **Measured before** (#561): Claude wake +0.7 s p50 / +1.8 s p95, cache ~100% as live at 2, 6 and 10 min (E1). Codex
  0.160 (E3): one app-server holding 10 threads 379 MB against 10 app-servers 2,584 MB, no cross-talk, 10 idle small
  threads resumed on a new server in 413 ms after a kill; an idle app-server ~160 MB, 43 MB of it the npm node wrapper.
  ACP (acp-adapter.md §0.2, §1): Cursor 145-153 MB on Windows and 232-264 MB on macOS per session, plus the stdio
  bridge ~49 MB and the person's MCP servers. [checked: #561 and acp-adapter.md as quoted by the research notes]

## 2. The two Codex outcomes, said precisely

- **A, sleep rule.** Codex keeps one app-server per session and the process ends when the session is idle, as Claude's
  does. Idle cost 0 MB, the bridge and the person's MCP servers included. Wake cost: spawn + `thread/resume` + the first
  request's cache.
- **B, one shared app-server per account, Codex does not sleep.** Every Codex session of the account is a thread in one
  process; an idle thread stays loaded. Wake cost 0, cache as live. Idle cost per session: the thread (~24 MB, from E3's
  (379-160)/9) + its bridge (~49 MB, not saved by sharing) + the person's MCP servers if Codex starts them per thread
  [unchecked, M2 d].

Sleeping *inside* B (`thread/unsubscribe`, later `thread/resume`) reads the same rollout as A unless the server keeps
the thread loaded, so "B plus sleep" gains nothing on the wait over A. B is therefore the alternative only when A's
wake is too costly. B is also new lifecycle code with #55's three costs (one crash ends every Codex turn, lease
counting and partial failures, no per-session server log), and after #1895 C a shared server still dies with its host.

**Default A.** The measurement decides by this rule, fixed before it runs:

| Outcome of M1/M1b | Choice |
|---|---|
| The woken turn's cache read is within 5 points of the live control at each idle time (or the live control itself reads < 10% at 16 min, so a sleep at 15 min costs no cache whatever the resume does), **and** the added wait (spawn + resume + TTFT − live TTFT) is ≤ 5 s at 50 MB | A |
| Cache kept, but the added wait > 5 s at 50 MB, or threads of 50 MB+ are common in the measurer's rollouts | Owner (§9 Q1) |
| Cache lost where the live control keeps it | B if every M2 gate passes (§3 M2), else A with the cost stated, to the owner |

## 3. The measurement

**Who and where.** A session the orchestrator starts on the owner's Mac runs M1, M1b and M2: Codex is logged in there
and #561 ran there; **Codex is not installed on the Windows machine this design was written on** [checked: not on PATH].
M3 runs on the Mac and on the Windows machine (opencode 1.19.4, agy 1.5.2 and cursor-agent are installed there
[checked: version commands, research notes]). Not CI: they need real accounts and cost real tokens.

**Isolation.** Every host is a `MeasuredHost` (`packages/agent-host/scripts/measure-tools/host.mts`: `--db
<dataDir>/store.db`, `CC_DATA_DIR=<dataDir>`, :34-42) on a `mkdtemp` folder; never `~/.centralu`. Codex's own home stays
the real `CODEX_HOME` (the login is there): probes only add new or forked threads, never write an existing rollout, and
print the thread ids and files they leave. No product change is needed to measure: a sleep is a dispose, a wake a resume.

**Reading the numbers from the protocol.**

- Time to first token (TTFT): the probe stamps `Date.now()` on every frame or event as it arrives (events carry no time
  in the probe today). Direct: `turn/start` sent → the first agent-message or reasoning delta notification. Through a
  host: `agents.send` returned → the first `message_delta` or `reasoning_delta` event.
- Cache read, direct (Codex app-server): the first `thread/tokenUsage/updated` after the turn starts,
  `tokenUsage.last.cachedInputTokens / tokenUsage.last.inputTokens` (Codex's `inputTokens` includes the cached part,
  `adapters/codex/token-readings.ts`) [checked].
- Cache read, through a host: the woken turn's first `usage_update` that has `request`:
  `request.cacheReadTokens / (request.inputTokens + request.cacheReadTokens)` (the host's `inputTokens` is the uncached
  part) [checked: token-readings.ts maps it so]. ACP: `acp/normalize.ts:240-258` maps `cachedReadTokens`; **Cursor sends
  no usage at all**, so its cache cannot be read from the protocol and only TTFT is compared [checked: acp-adapter.md].

**M1, Codex resume, direct** (new `scripts/probe-codex-resume.mts` on `scripts/codex-probe-kit.mts` `openProbe`).
Sizes 1, 50 and 500 MB of rollout: 1 MB made by probe turns; 50 and 500 MB by `thread/fork` of the measurer's own
largest threads, found by file size under `codexHome()/sessions` (check the fork's rollout size). If none is that
large, pad a fork's rollout [guess: that `thread/resume` accepts a padded rollout must be checked first]. Print the
size distribution of the measurer's rollouts (how common 50 MB+ is). Per size and idle time (2 min, 16 min), 3 runs per
cell, median and worst:

- resumed arm: warm turn; idle; close the app-server (stdin EOF); spawn a new one (time it); `thread/resume` with
  `excludeTurns: true` (time request → response); `turn/start` with a one-word prompt; TTFT and cache read.
- live arm (the control): the same thread shape left running for the same idle time, the same turn, the same two numbers.
- inventory at rest, which decides A's preconditions (§4): after a turn that started a long shell "in the background",
  is a child still under the app-server pid once the turn has ended; with an active goal, does a turn start by itself
  within 5 min.

**M1b, Codex through a host** (generalise `scripts/probe-resume-cache.mts`, today hard-coded to `claude`, with `--tool`
and `--idle`). Warm turn; idle; `agents.restartSession` (dispose + resume, `rpc.ts:394`) or stop the host and start a
second `MeasuredHost` on the same folder then `agents.resumeSession` (`rpc.ts:396`); send; TTFT and cache read as
above, and the `agents.resumeSession` duration. Control: no restart. Once a tool sleeps, the same probe runs with
`CC_SLEEP_AFTER_MS` as it does for Claude, and the [vendor-drift-checks.md](../agent-host/adapters/vendor-drift-checks.md)
row "Claude (resume)" becomes "Every tool that sleeps (resume)".

**M2, one shared app-server, direct** (new `scripts/probe-codex-shared.mts`), N = 1, 2, 5, 10 threads, each with its
own cwd and per-thread `config`. These are B's gates; B is out if (a), (b), (c) or (f) fails:

- (a) two turns at once stream independently;
- (b) every server request (approval, user input) carries `threadId`;
- (c) a shell in each thread prints its own `CC_HOST_CREDENTIAL` (set through per-thread
  `config.shell_environment_policy.set`) and its own pwd: #1405 needs each session's own credential, which today is the
  process env (`adapters/codex/session.ts:165`) [the config key: checked, Codex config reference; that a per-thread
  override applies: guess];
- (d) RSS of the process tree after each added thread, with and without the Centralu bridge and one stdio MCP server of
  the person's per thread (the gate: ≤ ~50 MB per added idle thread, all in);
- (e) kill mid-turn: what the other threads lose;
- (f) `thread/resume` of the 500 MB thread while another thread streams: the gap in the other's deltas;
- (g) `thread/unsubscribe` → `thread/closed`: memory back, writer lock released [the methods exist on openai/codex main's
  app-server README; on the installed CLI: unchecked; not in Centralu's `protocol-contract.json`];
- (h) does anything read the process cwd rather than the thread cwd (a project `.codex/config.toml`, AGENTS.md discovery).

**M3, ACP, per tool** (M1b with `--tool cursor|opencode|antigravity`). `session/load` in a new process after 2 and 16
min idle: load time (the replay), TTFT, cache read where usage exists; the conversation whole (a code word from turn 1
and from the last turn recalled; an edit made earlier is not redone); the load of a conversation with no model turn;
background: ask for a long shell "in the background" and end the turn, then check whether a child is left under the
agent pid and whether it survives the agent's exit; for Cursor, a subagent still running past the turn.

## 3a. Measured (2026-11-13, Mac, codex-cli 0.160.0)

Run by a session on the owner's Mac, `gpt-5.6-luna` at low effort, each Codex run in a `CODEX_HOME` of its own (a copy of
`auth.json` and of the rollout, deleted after; the real `~/.codex` and `~/.centralu` untouched). Scripts:
`packages/agent-host/scripts/probe-codex-resume.mts` (M1), `probe-codex-shared.mts` (M2), `probe-resume-cache.mts`
with `--tool` (M1b, M3). **[checked: the runs; raw lines were in the session's temp folders and are summarised here]**

**Rollouts on this Mac** (814 files in `~/.codex/sessions`): median 112 KB, p90 3.1 MB, 201 are ≥ 1 MB (25%), 25 ≥ 10 MB,
11 ≥ 50 MB (1.4%), 3 ≥ 500 MB. So 50 MB+ is **not** common here.

**M1, direct, 3 runs per cell, real rollouts copied in.** The 1 MB thread (0.9 MB file) is a 67k-token context, the 47 MB
and 513 MB threads resume to 25-35k tokens (compacted), so TTFT differs by thread, not by file size. Cache read = the
last `tokenUsage.last` reading of the woken turn (the first can repeat the previous turn's). Times in ms.

| Rollout | Idle | Arm | TTFT (3 runs, sorted) | Cache read (3 runs) | spawn → `initialize` | `thread/resume` (excludeTurns) |
|---|---|---|---|---|---|---|
| 0.9 MB | 2 min | live | 1033, 1059, 1291 | .966 ×3 | | |
| 0.9 MB | 2 min | woken | 5435, 6754, 7453 | .998 ×3 | 70, 62, 32 | 39, 39, 40 |
| 0.9 MB | 16 min | live | 1214, 1323, 2693 | .966 ×3 | | |
| 0.9 MB | 16 min | woken | 4179, 4233, 4704 | **.238**, .997, .998 | 71, 36, 52 | 43, 40, 39 |
| 47 MB | 2 min | live | 1168, 1595, 1643 | .908, .911, .912 | | |
| 47 MB | 2 min | woken | 4974, 5464, 5869 | .991, .992, .993 | 65, 59, 31 | 34, 35, 33 |
| 47 MB | 16 min | live | 1061, 1167, 1566 | .909, .909, .910 | | |
| 47 MB | 16 min | woken | 4324, 4651, 4814 | .990, .992, .993 | 64, 66, 64 | 34, 36, 35 |
| 513 MB | 2 min | live | 1072, 1333, 1513 | .932, .936, .938 | | |
| 513 MB | 2 min | woken | 4568, 4766, 5457 | .992, .995, .995 | 34, 67, 65 | 63, 64, 73 |
| 513 MB | 16 min | live | 1085, 1260, 3484 | **.194**, .938, .938 | | |
| 513 MB | 16 min | woken | 4221, 5273, 5386 | .995, .995, .996 | 68, 66, 72 | 63, 63, 67 |

Re-run of the 47 MB / 2 min cell with only 6 processes at once (the table above ran 36 at once, several logged
"failed to refresh available models: request timed out"): live TTFT 983, 1072, 1138, woken 4264, 4385, 4539, cache read
.919-.921 live and .990-.993 woken, spawn 32-64, resume 33-35. So the contention did not inflate the woken TTFT.

Readings: **(1)** the live control still reads the cache at 16 min (.91-.97), so OpenAI's lifetime is longer than the idle
times here; the woken turn reads as much as the live one (it is higher, .99 against .91-.97, in all 35 other cells). The
two misses (.194 live, .238 woken) are one per arm: a cache miss that happens now and then, not caused by the resume.
**(2)** The wait is TTFT, not the resume: a new app-server is ready in 30-70 ms and `thread/resume` with `excludeTurns`
(what the adapter sends, `thread-open.ts:80`) takes 33-73 ms even for the 513 MB rollout; the first model request of a
new process takes 4.2-5.9 s to the first token against 1.0-1.6 s live. Added wait = woken TTFT + spawn + resume − live
TTFT, by medians: 1 MB 5.7 s (2 min) / 3.0 s (16 min), **47 MB 3.9 s (2 min) / 3.6 s (16 min)**, 513 MB 3.5 s / 4.0 s;
worst run against best live: 47 MB 4.8 s. **(3)** The first `thread/resume` of the 513 MB rollout without
`excludeTurns` (my probe's first call, not the adapter's) took 28-36 s and 33-35 s of the whole warm turn; the adapter
does not send it that way, and the page cache was warm for every wake here (cold disk: unchecked).

**Inventory at rest** (§3, M1), run in a second pass the same day on the Mac (codex-cli 0.160.0, `gpt-5.6-luna` low, a
`CODEX_HOME` of its own; `probe-codex-background.mts --inventory shell|goal`) **[checked: the RESULT lines, relayed by
the orchestrator]**:

- **A command outlives its turn, and dies with the app-server.** Asked to keep `sleep 23; echo kept-done` running past
  the turn (no `&`; the model ran `/bin/zsh -lc 'sleep 23; echo kept-done'`, source `unifiedExecStartup`), the turn
  ended with its item `inProgress` and the `sleep` alive; its `item/completed` (`completed`, exit 0) came at 28 s,
  **outside any turn**. The same with `sleep 197`: alive 5 s after the turn, **gone 3 s after the app-server closed**.
  So a sleep would end it: guard (a) of §4a stays.
- **A goal starts turns by itself.** `thread/goal/set` on an idle thread (no `turn/start` sent) answered `active`, and a
  turn started 2 ms later, worked the goal, marked it `complete` and ended (12.8 s); nothing more in 5 minutes. A goal
  still active after a turn may start more: guard (b) stays.
- Recorded with the adapter (`scripts/frames-record.mts codex background-kept goal-set`): in `background-kept` turn 1
  ended at 7.1 s with the `sleep 25` item open, and it completed (exit 0) at 31.2 s, inside turn 2.

**M1b, Codex through a host** (`agents.restartSession` as the sleep/wake; `restartMs` = the RPC; 3 runs per arm, 2 min
idle, a small project, 8k-token unique block; the code word from turn 1 recalled in the woken turn):

| Arm | `restartMs` | TTFT (ms) | Cache read |
|---|---|---|---|
| live | | 2582, 3836, 2329 | .990, .991, .992 |
| restarted | 307, 309, 290 | 5651, 6329, 5602 | .950, .979, .951 |

Restarted − live: +3.1 s median TTFT plus 0.3 s restart = **~3.4 s**; cache within 4.2 points of the live one (the
widest, .950 against .992). The code word was recalled in a restarted run (checked in one run's answer text; the 3-run
comparison's detection was wrong and is fixed in the script, so only that run is counted). A first attempt with six
hosts at once on one `CODEX_HOME` failed to start three of them ("codex app-server exited"), the rest were run staggered.

### Rule of §2 applied

- Cache: the woken turn reads within 5 points of the live control at every cell (it reads more), 2 min and 16 min,
  direct (M1) and through a host (M1b, worst 4.2 points).
- Added wait at 50 MB: 3.9 s median, 4.8 s worst run, ≤ 5 s. At 1 MB with a 67k-token context the 2 min cell is 5.7 s
  (above 5 s), which §2 does not make a condition (the rule is at 50 MB).
- 50 MB+ rollouts: 11 of 814 (1.4%): not common.

**Outcome A (Codex sleeps).** B's gates were measured anyway (M2) so the owner can see what B would cost; B is not chosen.
The case is close on the wait (3.4-4.8 s against the 5 s line, and 5.7 s on a large-context thread), and the middle row
(Q1) is the owner's if the line is judged on the 67k-token thread rather than the 50 MB one: the wait is the new process's
first model request, not the resume, so it does not grow with the rollout size.

**M2, one shared app-server** (`probe-codex-shared.mts`, one server, 10 threads, each its own cwd and per-thread `config`):

| Gate | Result |
|---|---|
| (a) two turns at once | pass: both streamed 299 deltas each, overlapping 5.3 s of 5.4 s, both answers right |
| (b) server requests carry `threadId` | pass: `item/commandExecution/requestApproval` had the thread's id |
| (c) own credential and pwd per thread | pass for 5 of 5: `shell_environment_policy: { set: { CC_PROBE_CRED } }` in the thread's `config` printed `cred-i` and the thread's cwd |
| (d) RSS | process tree (wrapper + app-server) 59 MB at 0 threads, 95 / 107 / 127 / 139 MB at 1 / 2 / 5 / 10 threads started and idle, 299 MB at 10 after one turn each (~24 MB per thread, E3 said ~24). With two stdio MCP servers per thread (stand-ins for the bridge and one of the person's, ~45 MB each): 290 → 389 / 482 / 754 / 1212 MB at +1 / +2 / +5 / +10 threads, ~92 MB per added thread: **MCP servers are started per thread, even in one server**, and the ≤ 50 MB gate fails with two of them (not one of the B-out gates) |
| (e) kill mid-turn | one process dies, the exit is reported 37 ms after the kill, no turn completed afterwards: every thread ends with it |
| (f) resume of the 513 MB thread while another streams | pass: the streaming thread kept sending deltas during the resume (184 with `excludeTurns`, 275 without; resume 3.3 s / 5.5 s). Its longest gap (57 s) is the same without any resume (control run), so it is the model's pause, not the resume |
| (g) `thread/unsubscribe` | exists on 0.160.0, answers `unsubscribed`, but **no `thread/closed` notification arrived and memory/processes did not go back** (1212 → 1215 MB, 20 MCP processes still there in 3 s); `thread/resume` of an unsubscribed thread worked |
| (h) cwd | pass: each thread's `AGENTS.md` from its own cwd was answered (5 of 5), the server's own cwd was a neutral folder |

B's gates (a), (b), (c), (f) all pass, so B was possible; under §2 it only applies if the cache is lost, which it is not.
(g) matters for B: an unsubscribe did not give the memory back here, so B's "release" would not free an idle thread's MCP
servers either (3 s of waiting; later not checked).

**M3, ACP tools on this Mac** (via the host, `agents.restartSession` then a code-word question; 2 min and 16 min idle):

| Tool | Installed | Result |
|---|---|---|
| opencode 1.19.4 | yes, logged in | live cache .996 (2 min), .997 (16 min); after the restart **.080 at both times** (input 20,5xx of which 1,792 read: the cache is lost on `session/load`); code word recalled 3 of 3; restart RPC 2.25 s ×2; TTFT live 4140 / 2756 ms, restarted 5515 / 7357 ms (one run each) |
| cursor-agent 2026.10.22 | yes, logged in | **not measured**: with `auto` preset the first warm turns ran 240 s without the host's turn end arriving (Cursor sends no usage; why no `turn_complete` was seen is not investigated), so no wake number. Background check: no child seen either side, but the turn did not finish, so inconclusive |
| agy 1.4.8 (`~/.local/bin/agy`) | the CLI yes; **Centralu's Antigravity adapter says "not installed"** on a temp data dir (it installs its own managed release under the data dir and signs in itself) | not measured |

OpenCode background check (`nohup sleep … &` in the turn): no `sleep` child found before or after the restart; whether the
model ran it at all under the `normal` preset (approvals are denied by the driver) is not known: **inconclusive**.
OpenCode's finding for §6: its load recalled the conversation every time but loses the prompt cache (about 20k input
tokens re-read at full price at each wake), which the plan's §6 assumed was fine.

## 4. Outcome A: Codex sleeps

- `adapters/codex/index.ts:82-87`: `sleep: true`, the comment replaced by the measured numbers and their date.
- **Preconditions from M1's inventory, before the flag flips.** Child agents are reported already (#290). If Codex keeps a
  shell running past a turn, the adapter reports it as a background task (kind `shell`) first, as Claude's timers are
  reported ([agent-cli-updates.md](../agent-host/lifecycle/agent-cli-updates.md), "The CLI's own timers count as
  background work"); Centralu sees no Codex background terminal today [checked: no `unified_exec`/background-terminal
  handling outside recordings]. If an active goal makes the server start turns by itself, an active goal counts as
  background work (kind `other`). Neither is known [unchecked].
- **The writer lock.** Asleep releases Codex's lock on the thread, so `codex` in a terminal can take it; a wake then gets
  `conversation_locked` and the existing fork offer (`sessions/session-start.ts:936-937`), and turns added elsewhere come
  in through the resume's catch-up, as after a host restart. Nothing new.
- **The wait.** The lazy resume already hides most of it: with a conversation to resume, `createSession` waits at most
  3 s (`LAZY_RESUME_WAIT_MS`, `adapters/codex/session.ts:33`) and returns the handle, the send queues behind the resume
  (`adapters/codex/index.ts:203-239`), capped at 150 s (`background-resume.ts`) [checked]. The person sees "Waking
  session…" for at most 3 s, then the first answer comes after the rest of the resume.
- **Tests** (through `SessionManager` with the Codex adapter on a replayed recording, `recordings/codex-0.160.0/`):
  the quiet period passes → `session_live {live: false, reason: 'asleep'}` and the process disposed; a send wakes it and
  the turn runs. Fails with `sleep: false`. One more: a session waiting out a usage limit under auto-continue (§7) sleeps,
  and the continue wakes it and runs.
- **Deletes**: the Codex exception in agent-cli-updates.md (the rule row "Claude yes, Codex no" and "A Codex session is
  never put to sleep…"). No code is deleted; `processModel` stays as it is (a protocol field; removing it is not this work).
- No protocol, store or UI change: the asleep line and "Waking session…" exist; only the comments that explain a slow
  Codex resume (`packages/ui/src/store/connection.ts` ~621, `Composer.tsx:633`) are corrected.

## 4a. As built (Codex, outcome A)

- `adapters/codex/index.ts`: `sleep: true`, its comment the numbers of §3a.
- **Both preconditions are guarded where Codex's background work is already listed**, `CodexChildTracker`
  (`adapters/codex/child-tracker.ts`); the inventory at rest (§3a) showed both kinds of work exist and a sleep would end them:
  - a command item a turn's `turn/completed` leaves `inProgress` is listed (kind `shell`, not stoppable) until its
    `item/completed`, which comes between turns or in a later one. A command's item stays `inProgress` until its process
    exits (`long-command`, `background-kept`), and no other recorded turn, an interrupted one included, ended with one
    open [checked: every 0.160.0 recording scanned]. When the app-server ends, a listed command is ended `stopped`: it
    went with the app-server (§3a);
  - a goal whose status is `active` (from `thread/goal/updated`, and `thread/goal/get` on resume) is listed (kind
    `other`) until it is cleared, completed or paused. The process ending does not end it as a task: it is the thread's.

  Both make `sessionIdle` say `background`, so they also hold off a move to a new CLI, which ends the app-server too.
  Their tests replay `background-kept` and `goal-set` (`adapters/codex/replay.test.ts`): the shell is listed before
  turn 1's end goes out and ended `completed` later; the goal listed while active and gone once cleared. Both fail with
  the tracker's hook taken out.
- Tests: `sessions/sleep.test.ts` "a Codex session, on the recording of a real app-server": the real adapter on
  `resume.jsonl` through `SessionManager`; the sleeper puts it to sleep (`session_live asleep`), and the next message
  resumes the thread in a new process and the turn answers with the code word; every recorded line used, none
  unexpected. Fails with `sleep: false`. `sessions/auto-continue.test.ts`: a session asleep through a usage limit's
  wait is woken by the continue, and the note goes to the new process. The guards' tests replay the two Mac recordings.
- No protocol, store or UI change. The UI comments §4 named describe the old grid wake as history and stay.

## 5. Outcome B: one shared app-server per account

- New `adapters/codex/server-pool.ts`, `CodexServerPool`, keyed by account = `codexHome()` + the binary's identity, so
  a CLI update starts a second server and the old one drains as its sessions restart onto the new CLI. `lease()` returns
  a client view that sees only its thread's frames (child threads included, by `threadId`) and routes server requests
  by `threadId`; `release()` unsubscribes the thread. The server exits when the last lease is released.
- `adapters/codex/session.ts:150-175` takes a lease instead of spawning. The process-level inputs of a Codex session
  today are only the process cwd (`session.ts:158`), the env (`:165`, `hostAccessEnv`, per session since #1405) and the
  binary: the spawn is `codex app-server` and nothing else (`adapters/codex/client.ts:100`), and the launch-settings
  fingerprint (`index.ts:90-95`) holds only thread-level values [checked]. In B the process cwd is a neutral folder, the
  thread carries the cwd (`thread-open.ts:146`), and the credential moves into per-thread
  `config.shell_environment_policy.set` (M2 c). A restart for changed launch settings is unsubscribe + `thread/resume`
  with the new params (M2 g).
- The server's exit sends `session_live {live: false, reason: 'crashed'}` for every leased session; the next message
  resumes each on a new server.
- `processModel: 'shared-server'` (already in the protocol enum); `sleep` stays `false`; the policy is unchanged.
- Tests: new recordings of a two-thread server: interleaved notifications routed, a server request routed, the exit
  fans out to every lease, the last release closes it. Two hosts on one machine have a server each, as today.
- Inside the host, not the keeper: nothing outlives the host (#1895 C, [keeper-removal.md](keeper-removal.md) §2).

## 6. ACP tools (Cursor, OpenCode, Antigravity)

**Can each reopen a session?** All three answer `session/load` (preferred over `session/resume`,
`adapters/acp/session.ts:270-275`, [acp-adapter.md](acp-adapter.md) §4.3): Cursor 2026.10.22 `loadSession: true`;
OpenCode 1.19.4 load ~1 s (resume 45 s), and after a SIGKILL mid-turn a load recalled the code word; Antigravity agent
1.4.3 loads with a replay [checked: acp-adapter.md §1, antigravity-acp.md; not re-run on the installed agy 1.5.2 or the
current cursor-agent]. So sleep means for them what it means for Claude, once M3 shows the load loses nothing.
A future ACP tool that can neither load nor resume gets `capabilities.resume: false` and never sleeps (`unsupported`):
sleeping it would lose the conversation; its memory returns when the person closes it.

**What makes an ACP session idle.** `sleep` is set per profile once that tool is measured, and stays `false` in
`ACP_CAPABILITIES` so a new ACP tool does not sleep by default. The blocker is `background_unknown` (§1). No new field:
a profile whose agent was measured to keep **nothing** past a turn (M3's background checks) sets `backgroundTasks:
true`, because for it silence does mean "none running", which is exactly what the capability says the idle check needs
(`packages/protocol/src/entities/tools.ts:170-175`; the doc comment is reworded to say "reports its background work, or keeps none past a turn,
measured"). The flag is read in one place, `session-processes.ts:315`, plus the mock [checked: grep]. Its side effect is
wanted: such a session also becomes idle for moving to a newly installed CLI. A tool that can keep unreported work past
a turn (a background shell, a Cursor subagent) does not sleep until its adapter reports that work (§9 Q2).
Rejected: the host inspecting the agent's process tree, since the bridge, helpers and MCP servers are always there and
the check would be OS-specific and fragile.

**Cursor's empty conversation (needed before Cursor sleeps).** Cursor keeps a conversation only once a model turn has
run and refuses to load the rest, said as `conversation_gone` (`adapters/acp/session.ts:305-317`, #1676) [checked]; the
wake then fails with "no record of this conversation" (`sessions/session-start.ts:925-930`). Today that happens to a
session never typed to after a host restart; with sleep, every such session hits it 15 minutes after it opened. Fixed at
its owner, the resume's failure path in `session-start.ts`: a session whose store holds no reply from the agent has
nothing to lose, so a `conversation_gone` wake starts a new conversation for it instead of failing. This fixes the
restart case too.

**Order per tool**: OpenCode first (load measured fast and whole), then Antigravity, then Cursor (needs the fix above and
the subagent check). Each tool's PR carries its M3 numbers.

### 6a. OpenCode does not sleep yet (decided with the Codex PR, 2026-11-13)

Two findings of §3a M3 keep it awake. Its background check was inconclusive, and an ACP tool with unreported
background work never sleeps (the orchestrator's rule, §9 Q2). And its `session/load` loses the prompt cache (.08
read after a restart against .996 live): every wake re-reads about 20k input tokens at full price. A rule "sleep only
past the provider's cache lifetime" was not taken: OpenCode runs many providers with lifetimes from minutes to hours,
the host cannot read which one applies, and past that lifetime the live session loses the cache too. What would let it sleep: a
background check that shows nothing kept past a turn (then `backgroundTasks: true` in its profile, as above), and the
owner weighing ~20k tokens per wake against its 150-260 MB idle. Cursor and Antigravity were not measured and stay
awake.

## 7. What wakes a sleeping session, and who waits

| Wake | Path | Who waits |
|---|---|---|
| The person's composer takes the keyboard or gets its first key | `agents.resumeSession`, `rpc.ts:396` | Hidden behind typing: Claude 0.7 s p50; Codex small thread ~0.4 s + spawn [spawn unmeasured]; Codex large: ≤ 3 s "Waking session…", then the first answer waits the rest of the resume (7-13 s measured); OpenCode ~1 s; Cursor, Antigravity: M3 |
| The person's, a script's or an app's message (`send()`) | `sessions/session-events.ts:572-588` | Same as above, without the typing to hide it |
| Mail (a report, a task, a reply), not quiet | `deliverMail`, `session-events.ts:690-712` | Nobody on screen; the turn starts after the wake |
| Quiet mail | Does not wake; read at the next wake (`session-events.ts:697-706`) | Nobody |
| Auto-continue after a network failure or a limit reset (#2239, `sessions/turn-continue.ts`) | The continue is a non-quiet `deliverMail` (`SessionManager`'s `send`), which resumes a session with no process | Nobody; `STAGGER_MS` (5 s per tool) spaces several |
| An update's continue of a cut turn, or its note about ended background work | `deliverMail` (`lifecycle/update-resume.ts`, [continue-after-update.md](../agent-host/lifecycle/continue-after-update.md)) | Nobody |

[checked: the code paths named; whether watches and scheduled deliveries all go through `deliverMail`: unchecked]

**Auto-continue (#2239).** An overloaded wait keeps the turn `working`, so the session is never idle and never slept.
After a network failure or a usage limit the turn has ended, the session is idle and may sleep through a wait of hours;
the continue's mail wakes it. No special rule, one test (§4). TurnContinue restores its own schedule at host start.

**Update restarts.** No agent process outlives its host (#1895 C). After a reconnect the windows revive, one by one,
every session that was live before and that the new host does not hold (`packages/ui/src/store/connection.ts:665-790`
`recoverAfterReconnect`; a linked machine's in `packages/ui/src/store/machines.ts:262-339`); a session already asleep
is left alone, and a turn cut by the update is continued by the host itself [checked]. Today every idle Codex and ACP
session is live, so all of them are resumed after every update (a large Codex thread 7-13 s each, serially); with every
tool asleep after 15 minutes, only those used in the last 15 minutes are. A revived session the person does not use
sleeps again 15 minutes after the new host started (`sleep.ts`: the quiet period counts from host start).

## 8. Risks

| Case | What happens |
|---|---|
| Two hosts on one machine | Each has its own `SessionSleeper`; a Codex thread asleep on one can be taken by the other, and the wake gets `conversation_locked` and the fork offer (existing). In B each host has its own server |
| Host swap or update | No process survives; asleep stays asleep; fewer revivals (§7). No stored shape changes, so a downgrade reads everything |
| Older window, newer host | `session_live {reason: 'asleep'}` exists since #568; nothing new on the wire ([protocol.md](../protocol.md) §4 untouched) |
| Linked machine | Its host runs its own policy with its own setting (`agents.sleepPolicy` routes per machine) |
| Sleep and a send at once | Serialised by `sleeping` and `resuming` (`session-processes.ts:93-106`, `:351-373`), for every tool |
| Windows | The dispose closes stdin and signals the pid the host started; the real-environment check confirms the bridge and the npm wrapper end with the app-server or the ACP agent (no orphan) |
| A wake that fails (logged out, a limit) | Stays asleep with the reason; the next message tries again (existing) |
| Many mails at once | Wake many sessions at once; auto-continue staggers its own, mail does not [unmeasured; noted, not designed for] |
| B: one crash | Ends every Codex turn of the account at once (§5); the reason B is not the default |
| A tool's unreported background work | A sleep would end it silently; held off by `background_unknown` until measured or reported (§4, §6) |

## 9. Questions for the owner

- **Q1, only if the numbers land in the middle row of §2 (cache kept, wait > 5 s at 50 MB).** Options: Codex sleeps
  anyway (memory back; the first message to a large thread waits up to ~13 s); the shared server (no wait; ~70 MB or
  more per idle session; new lifecycle code; one crash ends every Codex turn); Codex sleeps only under a rollout-size
  limit (a second rule to explain). Recommendation: sleep anyway; the lazy resume hides all but the tail, it is the
  least code, and a large thread is the rare case.
- **Q2.** An ACP tool found to keep a shell (or a subagent) past its turn that it does not report: it never sleeps
  (keeps 150-260 MB plus its bridge per session) until its adapter can report that work, or it sleeps and that work is
  lost. Recommendation: never sleeps; silently losing the person's running work is worse than the memory.
- **Q3, a follow-up, not this work.** Once every tool sleeps and wakes on use, drop the windows' revive after a
  reconnect (`recoverAfterReconnect`, `machines.ts`), so after an update sessions stay asleep until typed to: less code
  and no resume burst; the cost is that the first message after an update always pays a wake. Recommendation: yes, in a
  later PR once Codex sleeps.

## 10. Pull requests

1. **Measure** (scripts only): `probe-codex-resume.mts`, `probe-codex-shared.mts`, `probe-resume-cache.mts` with
   `--tool`/`--idle`; their rows in `packages/agent-host/scripts/README.md`; a "Measured" section here with the numbers,
   who ran them on which machine and CLI version, and the choice by §2's rule (or Q1 to the owner).
2. **Codex**, the chosen outcome (§4 or §5), with agent-cli-updates.md's sleep section, the vendor-drift row and the
   two UI comments. Built as §4a (outcome A), with the probe of the inventory at rest; OpenCode stays awake (§6a).
3. **ACP**, per tool as each is measured (§6), with the Cursor empty-conversation fix before Cursor;
   acp-adapter.md §7 (the capability table) and §5.7, antigravity-acp.md:393 (sleep not offered yet). Independent of PR 2.

Every PR's real-environment check: a session of that tool left idle past `CC_SLEEP_AFTER_MS` on a temp data folder
goes asleep (its processes gone, the bridge included), the next message wakes it with the conversation whole, on macOS
and Windows.

## 11. Not checked

After the 2026-11-13 Mac run (§3a):

- The inventory at rest ran once per question, on the Mac only, one model; a command kept by other means (`&`, `nohup`)
  is not seen by the guard, as for Claude. A goal's turn that starts while the session is asleep cannot happen (no
  process); whether a woken thread with an active goal starts one on resume: unchecked.
- Not run: the rest of M2 (g): whether memory returns later than 3 s after `thread/unsubscribe`; a **cold
  page cache** for a 500 MB rollout wake (every wake here had the file in memory); the 1 MB (not 0.9 MB) and 500 MB (513 MB)
  sizes are the nearest real rollouts, no padded ones; M1b ran 2 min only, 3 runs, one account.
- M3: Cursor and Antigravity not measured (above); OpenCode's background check inconclusive; no ACP tool measured at
  runs of 3 (OpenCode one run per cell); Windows not run (this pass was the Mac only).
- The numbers use `gpt-5.6-luna` at low effort and the 15-minute-like idle times 2 and 16 min; other models, and the
  heavier load of the owner's real `config.toml` (its own MCP servers), were not used (the temp `CODEX_HOME` had a minimal config).
- Still unchecked from before: that every scheduled delivery and watch reaches a session through `deliverMail`.
