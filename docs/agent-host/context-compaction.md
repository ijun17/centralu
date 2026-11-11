# When agents compact

- **When agents compact** (#1376) is Centralu's setting, `UiPreferences.autoCompact` `{ controlled, share }` (optional: a record from
  before it reads as on at 60%, `autoCompactOf`; an older host ignores the field). The point is a share of the model's context
  window, for both tools. `launchOptions` (every launch and wake) turns the share and the model's window into tokens
  (`sessions/auto-compact.ts`), `CreateSessionOpts.autoCompactTokens`. **Claude** gets `autoCompactWindow` and `autoCompactEnabled: true` in
  the flag-layer `settings` of the query, next to the code-intelligence plugins (`flagSettings`, no file is touched). The CLI compacts
  at that window minus **33,000 tokens** (measured on CLI 2.1.296 with `getContextUsage()`: `autoCompactThreshold` was `maxTokens - 33,000`
  with the setting and without it, at 200k and at 1M), so the adapter passes the point plus 33,000, kept to the 100k to 1M it accepts: the
  earliest it can compact is 67,000 tokens, and a share under that on a small model lands there. The adapter compares the threshold the CLI
  reports with the one asked for and logs a difference once. The CLI's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` variable still takes precedence,
  and with the setting on Centralu turns auto compact on (`autoCompactEnabled`) even when the person's own Claude settings turned it off
  (Settings says so). **Codex** gets `model_auto_compact_token_limit` in the per-thread `config` of `thread/start` and `thread/resume`,
  which overrides the person's `config.toml` for that thread. Off (`controlled: false`), nothing is passed and each agent's own settings
  decide, untouched.
  The window is the model's own, which a tool reports with its token readings. `ModelWindows` keeps it, with the model the
  tool resolved the name to (`context_update.model`), per tool and model name (a default model per project) in the app settings. Claude's CLI
  reports the smaller of the model's window and the `autoCompactWindow` it was started with (a 1M model started at 153,000 reports 153,000; a
  200k one started at 633,000 reports 200,000), so `AgentAdapter.windowCeilingFor` gives the largest window a process started with the
  setting can report, and a reading is read against it: **below it** is the model's real window and is recorded, whatever was known (a
  record that was too large corrects itself); **at it** is only "at least this": the record stands when the CLI names the same model, and is
  dropped when it names another (the alias, the project default or the person's own setting moved), so the next start passes nothing and
  learns the real window (a record that was too small can rise). The ceiling a process was started with is kept with the session
  (`auto_compact_ceiling:<id>`) and read back when a host swap adopts the process, since the process keeps its original flags whatever the
  setting says by then; one adopted without a kept ceiling (a host from before) can only say "at least". The row is dropped when the session has no process to adopt: when it sleeps, is deleted, or its start fails (a purge of the trash takes any left, by its `<name>:<id>` shape). The adopted process is handed the ceiling (`CreateSessionOpts.autoCompactCeiling`), and the adapter's once-only log of a compaction point that differs from the one asked for compares against it, not against what the setting gives now. Codex reports the model's own window, so its readings always replace the
  known one. A model nobody has read a window from passes nothing at its first start and the value from the next (Settings, and the
  session's own settings menu, say so).
  **One context share (#1553).** The share shown anywhere is used / the model's full window, for Claude and Codex alike: 100% is the whole window
  (a 1M model: 1,000k), and the compaction point is not its end (the tooltip names it; the bar does not draw it, #1572). The reading a tool gives is for learning from (`ModelWindows.note` reads it
  against the ceiling, as above); what leaves the host is made from it once, in `SessionEvents.shareOf`, before the event is applied, stored or sent: the
  `context_update` (and so `SessionInfo.context`) carries `window` = the model's full window (`ModelWindows.shareWindow`: the reading when it is under the
  ceiling or the process has none, else the window kept for the model), `compactAt` = where the process compacts by itself, and `capped: true` when the full
  window is not known (a reading at the ceiling with no record for that model: an adopted process without a kept ceiling, or a model name that moved to another
  model); then `window` is only the tool's reading, a floor under the model's. **`compactAt` is said by the adapter, per reading, for a process Centralu's control
  started** (`claudeCompactAt`: the CLI's own `getContextUsage().autoCompactThreshold`, which is not the tokens asked for when the CLI clamps them to its
  range and the model's window: asked 40k on a 200k model it compacts at 67k; an adopted process counts as controlled only with the ceiling its host kept.
  `codexCompactAt`: the limit the thread was started with, Codex not reporting one; none for an adopted thread). Nothing is stored for it, so a rollback to a build that
  writes no such row cannot leave a stale one, and the point belongs to the process: a new process clears the host's copy at its start (`autoCompactFor`),
  and its first reading says the new one. The host drops a `compactAt` that is not under `window`. A screen or a text for an agent turns the reading into a
  share with `contextShare` (protocol) and divides by nothing else. The nudges and the rest rule take the model's window from `ModelWindows.of`: the record kept for this tool and model, which a floor is never written to (a capped reading drops it). **A stored reading is never one**, because `capped`
  is not stored: after a restart of the host, or a switch to a model nobody has read, they say and do nothing until a reading gives that model's window. The nudges also state the process's point
  (`context.compactAt`), not the setting as it is now (the setting reaches a process at its next start); without one known (just after a start, or a process
  Centralu did not start to compact) only the first share is told, and only when it is under the share of the setting (the old rule), and no compaction point is named.
  What is shown for an unknown full window: the gauge reads "≤N%" (an upper bound) with a tooltip that says the model's full window is not known yet and the real
  share is at most this, until the tool's next reading under a process with no ceiling teaches it (usually the next start). The stored `context_window` is the
  share window; `capped` and `compactAt` are not stored and come back with the next reading (a record from before may still hold the tool's smaller window until then).
  The gauge's bar warns (darker fill) within 10 points of the mark, and at 80% when no mark is known; the mark stands out of the track above and below, so it still shows once the fill has passed it.
  **Compacting at a break (#1451).** The share above stays the in-turn backstop (60%); two things compact a session at a break instead
  (`sessions/self-compaction.ts`, `SelfCompaction`), because a long-lived session's whole context is rewritten into the cache after every
  long wait and a compaction in the middle of work breaks the flow. Both send the tool's own command as a turn of its own (`SessionEvents.sendCompact`:
  Claude `/compact [focus]`, Codex's `thread/compact/start` through its slash handling, which takes the bare command, so a focus line
  reaches Claude only), with no user row, and the conversation gets a line from Centralu when the tool reports it done:
  "Compacted by Centralu (reason)". **Only a tool that has the command:** the session's own `SessionHandle.compactCommand` decides first
  (ACP: `/compact` when the agent advertises `compact` or its profile measured `infersCompaction`, else null, docs/plans/acp-adapter.md §5.6),
  then the adapter's. A null command means the session is never compacted by Centralu, and `compact_self` answers the agent that it cannot
  (Antigravity, which advertises only plan, logout and usage, where a bare `/compact` would only be a prompt to its model).
  - **`compact_self`**, a tool of an ordinary session and the Assistant (loaded, 579 characters; docs/tool-cost.md §15): asks for a compaction
    **after the current turn ends**, never in the middle of one, with an optional `focus` line (one line, 300 characters) and an optional `then` (below). Its description says when:
    work is finished and reported; before waiting more than a few minutes on a child, CI or the person; switching to an unrelated task.
    The request is always accepted: the size of the context known during a turn is the one read at the previous turn's end, so a turn that grew past the floor would have been refused. The **floor** of 100,000 tokens is checked at the turn's end on the size of the turn's last model request of its own conversation (`usage_update.request`, which both tools send), else on the size the tool reads then (Claude reads it just after the turn ends, so the request waits for that `context_update`, at most 5 seconds (its own timer) before it goes by the reading it has, and a reading owed for the turn before that lands in the next turn is not taken for the next turn's; Codex reads it during the turn); under the floor the request is dropped, and so is one with no size read **since the last compaction** (below). One request is pending per
    session; asking again replaces the focus and the `then`. **The person's turn first:** a request is spent at the first turn end after it, so a message the
    person sent into that turn is part of it, and one queued behind it runs before the compact in the tool's own queue, which compacts after
    it; a turn the person interrupts (or that ends in an error or a usage limit) **drops** the request, and a card the host raised at the turn's end holds it: it goes when the card closes with the session still at rest, and is dropped if a turn starts first (the person's answer is theirs; the request is never carried into it). The tool's answer is its confirmation: it does not
    wait for the compaction. The request does not ask whether background work runs: waiting on CI in the background is what it is for.
  - **Going on after the compaction: `then` (#2024, owner decision 2026-11-06).** Before this a session that compacted at its turn's end sat at rest
    until something else started a turn, so a lone worker in the middle of multi-step work stalled. `compact_self({ then })` is the prompt of the
    session's next turn, written by the agent before the compaction ("Continue with step 3 of the plan in docs/x.md: ..."; at most 4,000 characters, longer is refused with
    nothing asked). It is held with the compact Centralu sends and **goes when the compact turn has ended**, after the tool has reported the
    compaction in it (not at the report: the turn is still running then, and a message sent into it would join it): an ordinary turn of the session's own
    (`SessionEvents.deliverMail`: Centralu's channel, no user row, a conversation line that says what happened: "Centralu sent the agent its next step after the
    compaction", or "... its next step: nothing was compacted" for a refused request, or that it was told to go on after a host change), so its end raises the done notice and is the work's. That turn **goes on with the work of the turn that asked** (#2164, `SelfCompaction.stepOpens`): in a child, the turn that asked is not at rest while the step is to go (`SelfCompaction.goesOn`), so the step's turn answers the tasks still open (plans/mailbox.md §10.6.3), and a send to it is mail, a turn of its own after it (plans/mailbox.md §10.6.2); the `state_change` that opens it says `continues: 'compaction'` for a hub that follows the machine. Memory only: after a restart between the two turns the step's turn is the session's own, as before.
    **Only to a session at rest, after what was queued has gone first.** The compact turn's end is not the moment: the person's message typed during it sits in
    the tool's queue and the mailbox delivers mail the moment the session rests, and a step sent beside either is folded into their turn (real run E2: the person's
    message ran inside the `then` turn and the "came first" line was missing). So the host **looks at what waits** (`SelfCompactionHost.queued`, from the manager) when the turn ends:
    the inputs the tool holds that no turn has answered (`SessionHandle.queuedInputs`: Claude counts what it wrote to the CLI and no result has named yet, and what is
    still in its own queue, never a quiet note or a parent note (a result that names a later input clears the ones written before it: the CLI reads in order, and one a result that named nothing answered, a Stop's, would count for ever and hold every later step for the 60 s bound); Codex counts `MidTurnLedger.waiting`, the inputs behind a compact or review turn and the writes not yet answered, which at
    a compact's end are already written when the end is said), and mail that wakes the session and waits for it (`MessageService.wakingFor`, `MailHooks.waiting`: due or still
    in the 2-second debounce, held-out and quiet mail not counted). **Nothing waits: the step goes at once.** Something does: it waits, a turn that begins is theirs, and the
    step follows that turn's end with a line saying their message came first and weighs more. A step goes only when the session can take a turn (`SelfCompactionHost.ready`:
    `mailReceiver` is `ready`: no turn, card or limit, the host not leaving); else the end of the turn that runs, or the sweep, tries again, and the step stays in the store
    meanwhile. The same gate stands in front of the claim, so a step that is not sent is not claimed. A step held for a session that could not take it yet, or kept by a host that found it (`resume`, `sweep`), is looked at the same way: what waits goes first. **Two bounds remain, both named in the code.** A queue the host can see but
    that never starts a turn (mail held back by the mailbox's own rules, a stuck queue) holds the step for `THEN_QUEUE_MAX_MS` (60 s) at most. **The one guess:** a tool that
    cannot say what it holds (`queuedInputs` absent, as an ACP agent) gets `THEN_SETTLE_MS` (3 s) after the compact turn's end for a queued turn to start, which is what the
    first version did for every tool, at the price of 3 s on each step and a wrong order when the queued turn started later than that.
    **A refused request still sends it.** When nothing is compacted (the context under the floor, no size read since the last compaction, the tool refused the compact or
    Centralu could not send it, or the tool never reported it within `COMPACT_STALE_MS`, 30 minutes; the sweep checks that, and a compaction reported after it does not
    bring a second step), the agent was told to end its turn and nothing else would wake it. So `then` goes all the same, as a turn that opens with one line: the
    request did not compact the conversation, why, and that asking again before anything changed gets the same answer. That turn counts as a cycle for the warning below.
    **A repeat costs a tool call, not a turn.** The size of a refusal is remembered (`refusedAt`, per session, in memory). A `compact_self` with a `then` that comes again with the
    context within `REFUSED_AGAIN_TOKENS` (2,000) of it, by the size of the turn's last model request, else the tool's reading (two requests with no size read since a
    compaction are the same), is answered in the tool result: "Not compacted (reason); nothing has changed since your last request, so no new turn is made for it. Continue in
    this turn." Nothing is stored or counted, and the session is never blocked. A step that did real work and grew the context asks the usual way, a request that is over the floor now is never answered with a refusal under it (99k, then 100.5k), and a compaction forgets the
    refusal. This also bounds the loop the context notice could make on Codex, where the context read 43.8k right after a compaction and 119k on the next turn (Codex kept a big
    user message), so the 46% notice fired again at once: a repeat at the same size costs a call. The warning below remains the bound for a context that does change.
    **The person's interrupt sends nothing.** Of the turn that asked, of the compact turn **before or after** the tool reported the compaction in it, or of the turn that ran
    first, or when a turn ends in an error (an errored or rate-limited session is not sent a turn): the session is **told it did not happen**, quietly, with the text
    of its `then` so it can carry on by itself: `SessionHandle.nudge` (Claude: quiet input read with its next input; Codex: steered into a running turn only, so a note
    it cannot take now waits for the next turn's start or request, as the context notices do), and the window gets a line from Centralu. A compaction the tool reported
    as **failed** leaves the context as it was, and the step is still valid, so `then` goes, kept and sent as a refusal (`refused`, "the tool reported the compaction failed: <its reason>"): the turn and the conversation line say nothing was compacted, not that the compaction is done. **Codex:** its compact request takes no focus (`takesFocus` compares the command
    with and without one), so with a `then` the focus line heads the `then` turn ("This tool's compact takes no focus. What you asked the summary to keep: ..."), and with
    none the answer of the tool says the focus line is not applied. A resting session that the sweep compacts has no `then`: it was at rest and stays so.
    **One compaction in flight per session.** A second `compact_self` while one is on its way (its command sent, queued behind a turn of the person's, or running) asks for no second
    command: it joins the first, replaces its `then` (a call with none drops the earlier one) and says so; its focus line is too late. Two `/compact` commands are never queued. A step
    held for the turn that went first is replaced by the next request the same way.
    **A host swap or restart does not lose it.** A `then` is kept in the store from the request on (`sessions/then-keep.ts`, the app setting `compact_then:<session>`, a key an older build serving the same store ignores and the trash's purge takes with the session; no store step) with how far the request came and when it last moved: `asked` (the turn runs), `sent` (the compact command went), `compacted` (the tool reported the compaction), `refused` (it did not compact; `why`), `sending`. The change from `compacted` or `refused` to `sending` is one transaction (`updateAppSetting`, `claim`): of the old host and the new, only the one that makes it sends, so the step goes **at most once**. The leaving host stops its compactor first in the shutdown plan (`stopSelfCompaction`, before the handles are let go of), so it sends nothing in its last moments. **From the claim on the record never goes back** (real run D3: the old host claimed the step, its delivery was refused because the host was leaving, the record went back to `compacted` and the next host sent the step a second time): a step whose delivery is in the air when the host leaves stays `sending`, and the next host only tells the session. A host that starts looks at what is left (`SelfCompaction.recover`, from `startSelfCompaction`): a `compacted` or `refused` record is **sent** (the compaction is known done) if the session can take a turn, through the mailbox's delivery (`deliverMail`: Centralu's channel, no user row, the session woken if it has no process), with the person-came-first line and the Codex focus line it was kept with, and is held for the sweep otherwise (a limit or a card stands); every other stage is a request whose outcome the new host cannot tell (the turn had not ended, the compact was sent and not yet reported done, or the send itself was in progress), so **the session is woken with a turn** that says Centralu changed hosts, that it cannot tell whether the conversation was compacted or the step sent, and to go on by itself, with the text of its `then` (real runs D1 and D2: a note kept in the store left the session idle until someone typed, while the line said it was told). A quiet note goes instead into a session that is in a turn, and is kept for its next input when the tool takes none; the window gets a line that says which of the three happened. Told once: the record is cleared as it is told. **A record is as old as its last move** (`at`) and one older than `THEN_KEEP_MS` (an hour: a compact is stale after 30 minutes and a swap or a restart with a wake takes minutes, so an hour covers a long outage and cuts what a rollback to an older build left for a newer one to find days later) is not sent; the session is told it was too old. The deletion of a session (the trash) clears its record and its notes, so one restored later is sent no old step. A note the tool cannot take yet (no process, or Codex between turns) is kept in the store too (`compact_notes:<session>`) and given at the session's next turn start or request of its running turn. A store that fails to write is logged and the request goes on in memory as before. **The one window left:** a host that dies between the claim and the tool taking the step leaves a `sending` record, which the next host reports to the session as "being sent" rather than sending it again; the agent may then run a step it already ran, which it can tell from its own history. A step that could not be given after a compaction that did happen says so ("The compaction you asked for is done, but the session could not take your `then`"), not that it did not compact.
    **A warning, not a stop.** Each time a `then` has gone (the tool took it), the cycle is counted in the store (`compact_cycles:<session>`, the hour up to now, so a swap does not start it again); past `WARN_COMPACT_CYCLES_PER_HOUR` (6) the person is warned by the mailbox's own warning (`MailHooks.compactCycles`, `docs/plans/mailbox.md` D32, S20, #2014): one Inbox notice naming the session and the count, once per session per clock hour. The session keeps working; nothing is refused or delayed.
    **The floor and its gap.** After a compaction the context is a summary, far under the 100,000-token floor, so a `then` turn that calls
    `compact_self` again at once is refused by the floor (and, since a refused request still sends its step, gets it back with the reason: see above). A step that reads enough to grow back over the floor did real work, and a
    time window would block exactly that. **The gap that guard needed closed:** the floor goes by the last model request of the turn, else by a reading of the context
    taken **in the turn**; the fallbacks (the 5-second timer, a request held for a card) went by `SessionInfo.context`, the tool's last reading, which after a compaction is
    the one from before it when the tool reads none (Codex reports no size after a compaction). A small context could pass as large. Now a compaction that worked
    (any trigger) marks the session `unread` until the tool's next reading, the sizes read before it are forgotten, and a request judged with only the old reading is
    refused ("no size of the context was read since the last compaction"); the rest rule (`due`) leaves such a session alone too. A failed compaction shrank nothing and marks nothing.
    The context notices tell the agent to set `then` to its next step and end its turn (`context-nudges.ts`).
  - **A session at rest** for 10 minutes whose context is over `autoCompact.idleShare` of the model's window (default 30%, 10% to 95%; Settings
    and `set_preferences` offer it) **and** over the floor is compacted by a sweep (every minute; the 10 minutes count from the moment the session is idle by every rule of `sessionIdle`: no turn, card, question or background work. A turn's end starts them only if it leaves the session idle; otherwise the sweep that sees it become idle does, so a card answered or background work stopped late does not bring an immediate compact; the share is read against the model's own window, not the smaller one a Claude process started under the CLI's compaction setting reports) before its next turn. Off with the existing
    `autoCompact.controlled` switch. Never a session in a turn, with an approval or question card open, running background work, or without a
    process (`sessionIdle`, the rule of the sleep sweep; a session that sleeps after 15 minutes is compacted at 10 if it was over the share).
    **The compact turn is marked.** The ending event of a turn Centralu started to compact says `turn.compaction: true` once the tool has reported the compaction in it (`TurnWho`, an addition; a turn of the person's that the tool ran first from its queue is not marked, and a compaction Claude says is its own, `compaction.trigger: 'auto'`, is not taken for Centralu's; a compact turn that is interrupted or fails before the compaction is reported is forgotten, so a `/compact` the person types later is not Centralu's), and the window raises no "done" notice, card or sound for it; a build that does not know the field shows one, as before. The turn is not a turn of the session's own for the rest rule.
    The share is read as `autoCompact.idleShare` but **stored beside the record** (`autoCompactIdleShare` in the screen preferences row), because an older build rewrites `autoCompact` as the two fields it knows and would erase a third inside it; a top-level field of the row survives every build's save (measured on the previous build in the deep review of #1478).
    A session is compacted once per rest: what a compaction leaves is not always read back (Codex reports no size), so it needs a turn of its own
    before the next. A host that starts counts the rest of a session it never saw end a turn from when it first saw it at rest, and a wake from sleep starts the rest again.
    A turn's end is the compact's only after a turn began following the send (Codex's request starts its turn later); a tool that refuses it before that clears the mark. The sweep stops in the shutdown plan with the sleep sweep. Known gap: on Codex a message or mail delivered in the moment between the send and the compact's turn start can take that turn's bookkeeping.
  - **Telling a growing session (#1492).** An agent cannot see how full its context is (Claude Code does not tell the model), so `compact_self`
    alone depends on it thinking of the tool. When a session's context passes a first share (`autoCompact.nudgeFirst`, default 30% of the model's
    window) Centralu tells it **once**, quietly, its size and share and "when this step of the work is done, call `compact_self` with `then` set to what you do next, and end your turn", and tells it
    **once more** at a second share (`nudgeSecond`: default 10 points below the share the tool compacts at, so 50% when that is 60%; **never at or
    above it**, held at least 5 points below, `nudgeShares` in `@cc/protocol`), where the tool's own compaction would otherwise come in the middle
    of work (`sessions/context-nudges.ts`, `ContextNudges`). **Quiet:** the note goes in as `SessionHandle.nudge`, which never starts a turn and never
    interrupts one: Claude takes it as quiet input (`shouldQuery: false`, stamped as Centralu's channel), read with the session's next input or at the
    running turn's next tool round; Codex steers it into the regular turn that is running with `turn/steer`, which names the turn (`expectedTurnId`) and is refused by Codex
    for one that has ended, so a note for the last request of a turn (Codex sends its token count just before `turn/completed`) starts no turn of its own,
    where a `turn/start` did (#1504 review, measured on a real Codex). A Codex session between turns, or in a compact or review turn it cannot steer, takes
    none, and a refused steer is not counted as told (`nudge` answers with a promise): the note waits for a later request of a running turn, the next
    turn's first. A session at rest is the rest rule's job, not this.
    **Once per share per compaction cycle:** a share is told the first time a request is over it (a request over both says it once); a compaction of
    any kind that succeeded (the agent's, Centralu's, the tool's own, the person's `/compact`) or a fresh conversation (`/clear`) starts the cycle again, so
    the shares are told again when the context grows back; a compaction that failed does not. The counters are in memory: a host that starts tells a session
    already over a share again, once. **Only where it can be acted on:** a session that has `compact_self` (an ordinary session and the Assistant,
    `toolProfileOf`), with Centralu's control on (`autoCompact.controlled`) and the notices on (`autoCompact.nudge`), over the 100,000-token floor (a smaller
    context would be refused), and a share under the tool's own (a first share at or above it is never told). The window's conversation says each one as a
    line from Centralu ("Centralu told it its context is 33% full: call compact_self with then set to its next step"). Settings (Compaction) and `set_preferences`
    take `nudge`, `nudgeFirst` and `nudgeSecond` (`null` is back to following the tool's share); a second share at or above the tool's own, or less than
    5 points below it, is refused by the host with the reason, a first share not below a chosen second one is refused too (`refused`, `data.reason` `bad_value`, not `internal`), a patch that moves
    several is judged as the whole setting that results, and a tool's share lowered under a second share chosen before **takes it down** (to 5 points below the
    share; back to the default, null, when it could not then stay above the first), in what is stored and in what `prefs.get` reads (`settledSecond`), so the setting
    as read can always be sent back whole: it is what a hub pushes to every linked machine, and a refusal there would have kept the machine from taking the
    share too. All three are **stored beside the record** like `idleShare`
    (`autoCompactNudge`, `autoCompactNudgeFirst`, `autoCompactNudgeSecond`), so an older build's save of `autoCompact` cannot erase them; a linked machine
    takes the hub's values with the rest of the setting (`offerAutoCompact`).
    **The size during a turn** comes from each model request's input as the stream says it (`usage_update.request`: Claude per assistant message, Codex per
    token count; a subagent's request is not the conversation's), because the tool's own reading comes at a turn's end (Claude reads it just after the turn
    ends). The same figure moves the window's meter (`sessions/context-meter.ts`, `ContextMeter`): each request becomes a `context_update` marked
    `exactness: 'estimate'` (the window draws it like a reading, with no "≈", #1572; a hub and an older window read it as a reading), **at most one per 3 seconds per session**, in the
    window of the session's last reading (`SessionInfo.context.window`, the model's full window when known, #1553, so the meter never changes its denominator in a turn; none until a reading gave one), carrying its `capped` and `compactAt`. **The
    tool's reading stays the authority** at the turn's end whatever the estimates said, and estimates stop for the rest of a turn in which the tool read the
    size. Codex reads it with every request, right after the request's token count (`AgentAdapter.contextAtRequest`), so it gets no estimate at all: the exact
    figure is there at once, and an estimate could only flicker in front of it. **A reading owed for the turn before cannot overwrite this turn's:** a turn that ended with no reading in it owes
    one (Claude's), and when that lands after the next turn's own estimate it is not applied and not sent to the window (the compaction rule still hears it);
    it is applied when the session is at rest or the turn has no estimate yet. The compaction rules ignore estimates (`SelfCompaction`), and an estimate is
    no reading of the model's window (`ModelWindows`).
    **Claude reads it during a turn too (#1526).** Measured on CLI 2.1.296: `getContextUsage()` answers during a turn in 10 to 550 ms and returns the latest top-level request's input + cache read + cache write to the token, as at the turn's end; it also answers before the first turn (system prompt and tools). So after a top-level `assistant` message (`parent_tool_use_id` null; a subagent's is not asked for) the session asks it, at most once per 2 seconds with one trailing read, and the first turn has an exact figure, and the model's window (`ModelWindows`) and `compactAt`, from its first request, which the nudges need. Claude sets `contextAtRequest`, so it gets no estimate; the turn's `result` cancels a trailing read and reads as before. A compaction needs no rule: the next request is smaller and so is the reading. The SDK's `context_usage` field on messages was absent from every message measured (SDK 0.3.263).
    **Follow-ups of #1478 (#1500).** A request held for a card the host raised is judged when any event, or the sweep, finds the card gone and the session
    at rest, not only on the card's own `approval_resolved` / `question_resolved` (a card also closes with the session's stop, a withdrawn card, a host swap, and says
    nothing then); a held request of a session with no process is dropped. The held path goes on `!busy && !cardOpen` even while background work runs, as the rule
    for every request made in a turn does (waiting for CI in the background is what the request is for); `sessionIdle`'s stricter rule is the rest compaction's. Codex
    does not say why it compacted: its adapter says `manual` for a compaction inside the compact turn the session started (`/compact`) and `auto` for any other,
    so the tool's own compaction in the middle of a person's turn that ran first is not taken for Centralu's. A stopped tracker ignores events (`stop()`).
  **Linked machines.** A machine starts and wakes its sessions from its own preferences, and the setting lives on the hub, so the hub tells
  each machine its setting as a change of that machine's preferences (`prefs.set`, at every connect and when the hub changes it,
  `LinkedMachine.offerAutoCompact`): the hub's switch and percentage govern the machines it links, and a value set on the machine itself is
  replaced at the next connect (a machine linked to two hubs takes the last one's). A machine from before it drops the field and applies nothing. The model windows are kept per host, so a
  machine learns its own. `agents.autoCompact { sessionId }` answers `{ controlled, share, tokens }` for the next start from the host
  that runs the session (routed like the session), from the same function the launch uses (`autoCompactPlan`), and the session's settings
  menu shows it; a machine from before it answers "Unknown method", which the menu reads as "this computer's Centralu predates the
  setting".
  A change reaches a session when its process next starts; running sessions are not restarted and are not marked as drifted. The
  patch merges field by field like the notification switches; `set_preferences { autoCompact: { controlled?, share? } }` (no card:
  reversible, and only about when an agent compacts) and `get_preferences` carry it; Settings, agents section, offers the switch
  and the share (20% to 95%).
