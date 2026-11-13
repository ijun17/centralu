# Idle sessions of every tool sleep (#2027)

> **Status: design, not built (2026-11-13).** The owner decided on #2027 (2026-11-12): idle sessions of every tool sleep,
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

## 7. What wakes a sleeping session, and who waits

| Wake | Path | Who waits |
|---|---|---|
| The person's composer takes the keyboard or gets its first key | `agents.resumeSession`, `rpc.ts:396` | Hidden behind typing: Claude 0.7 s p50; Codex small thread ~0.4 s + spawn [spawn unmeasured]; Codex large: ≤ 3 s "Waking session…", then the first answer waits the rest of the resume (7-13 s measured); OpenCode ~1 s; Cursor, Antigravity: M3 |
| The person's, a script's or an app's message (`send()`) | `sessions/session-events.ts:572-588` | Same as above, without the typing to hide it |
| Mail (a report, a task, a reply), not quiet | `deliverMail`, `session-events.ts:690-712` | Nobody on screen; the turn starts after the wake |
| Quiet mail | Does not wake; read at the next wake (`session-events.ts:697-706`) | Nobody |
| Auto-continue after a network failure or a limit reset (#2239, branch `auto-continue`) | The continue is a non-quiet `deliverMail` | Nobody; `STAGGER_MS` (5 s per tool) spaces several |
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
   two UI comments.
3. **ACP**, per tool as each is measured (§6), with the Cursor empty-conversation fix before Cursor;
   acp-adapter.md §7 (the capability table) and §5.7, antigravity-acp.md:393 (sleep not offered yet). Independent of PR 2.

Every PR's real-environment check: a session of that tool left idle past `CC_SLEEP_AFTER_MS` on a temp data folder
goes asleep (its processes gone, the bridge included), the next message wakes it with the conversation whole, on macOS
and Windows.

## 11. Not checked

- Codex: cache read after a resume; resume time by size on the current CLI; spawn time; background shells and goals at
  rest; per-thread `shell_environment_policy`; `thread/unsubscribe` on the installed CLI; whether MCP servers are per
  thread in one server. All are M1/M2.
- ACP: `session/load` on the installed versions; cache after a load; background shells past a turn for all three;
  Cursor subagents past a turn. All are M3.
- OpenAI's prompt-cache lifetime (from memory, not fetched: minutes of inactivity, longer off-peak) [guess]; the 16 min
  live control in M1 measures it instead.
- That every scheduled delivery and watch reaches a session through `deliverMail`.
