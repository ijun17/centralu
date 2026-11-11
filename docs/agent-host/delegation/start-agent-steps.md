# What one `start_agent` call does

What one `start_agent` call does (`SessionManager.startAgent`, also `AgentStartFlow` in start-agent-flow.ts), with the refusal/card rules
below retained for `safe` and `normal`:

1. **Who may.** An ordinary session (`reader` profile) of a trusted project (#382's rule), above the agent depth
   (#867, `sessions/agent-depth.ts`). Settings → Agents → How deep agents may start agents, a slider from 1 to 3,
   persists `prefs.agentDepth`; a record without it reads as 1 (`agentDepthOf`), so it needs no store migration. A
   session the person started is depth 0; one marked `askedBy`, or working on a task another session gave it (an
   unsettled delegation: ask_project, a fork, agent_session), is one deeper than that session, the deepest link
   counting, and a fork whose requester is gone is at least 1. Two consequences beyond `auto`: a fork the Assistant
   made has `forkedFrom` but no `askedBy`, so it counts 1 for good and cannot start agents at the default (it could
   before); a session an `auto` caller reaches through agent_session counts one deeper while that delegation is
   unsettled. A child or fork records the depth it was started at (`agent_depth:<id>` in `app_settings`, an app
   setting rather than a column, so an older build leaves it alone; `purgeSession` deletes it), and its depth is never
   less than that: deleting the middle of a chain does not make the rest of it shallower. Sessions made before this
   build have no record and count by their links alone. A caller at the setting's depth or deeper is refused
   under every preset, `auto` included, with an error that names the setting and where it is; at 1, a child cannot
   start agents, and neither can a session handling an active ask_project task. The setting is read at each call
   (and again after the card, below), so lowering it applies to the next start. Forks and ask_project read the same.
2. **How many.** Settings → Agents → Running agents per project persists `prefs.agentCeiling`,
   read at call time. Empty/null means no ceiling under `auto`, `AGENT_CEILING` (4) otherwise;
   zero is unlimited, and a positive integer sets a ceiling per project over all its sessions.
   A child counts while a delegated turn runs; a child on a linked machine (#1038) counts under its parent's project
   while a call waits on its turn or its report is owed (`RemoteAgents.workingIn`); a removed machine's child holds no place,
   and one deleted there while the link was down is forgotten when the link is back (`caughtUp`). Checked before the card and again after it,
   and for a new `agent_session send` turn. The check after the card also takes the place (#673 review,
   `agentStartReserved`): one synchronous step, held through `createSession` until the child's delegation counts it,
   given back if the start fails, so calls at once cannot pass the ceiling together. A fork takes its place the same way
   (`reservePlace`). Once the child's session exists, the caller's gates (`agentStartGateError`) and the preset rule
   are read again with no wait before its delegation; a session that fails them gets no task and goes to the session archive. A request still waiting on the
   person's card holds no place: it may stand for hours, and is counted when it is approved.
3. **Choice.** `tool` defaults to the project's tool; `model` and `effort` to that tool's remembered choice for the
   project (#107). A model or effort the tool's list does not have is refused with the list (`agentChoiceError`;
   an alias the ids or labels contain passes, and a tool that cannot list passes all). The check never holds the call
   (#660): it uses the cached list (one read at a time, kept whenever it arrives, a failed read not retried for a
   minute) and waits at most `START_AGENT_MODEL_CHECK_MS` (3 s) for a missing one; without a list in time the child
   starts on the name as given and the answer says it was not checked (an empty list is said to be empty). A name the
   cached list lacks is refused only after a fresh read (the CLI may have been updated).

   **By difficulty** (#729). A `difficulty` with no `model` takes the person's model and effort for that tool and
   difficulty instead, from Settings → Agents → Models for the agents a session starts (`prefs.agentModels`, the
   whole map in one patch; nothing chosen for it falls back to the remembered choice). A model named still wins
   (`agentChoice` in `sessions/start-agent.ts`). The card names a model the setting chose, "(gpt-6, your choice for
   heavy work)". The setting's model and effort are checked as named ones are: a retired one is refused with the list,
   and the refusal adds "That is the person's choice for heavy work …: tell them, or name a model" only when the
   setting's own model or effort is at fault, not an effort the caller named; one that could not be checked says to
   name a model if the first turn fails, not to start again without it, since the caller never named it.

   The words on `difficulty` and `worktree` are the loose guidance #729 asked for (an agent may ignore them, and a
   project's AGENTS.md wins): light for lookups, small fixes and reviews, heavy for design, security and data loss; a
   worktree for edits that end in a pull request, none for research or edits the person watches live. They are in the
   schema, not in an answer, because a caller needs them before its first call. The child's frame (`agentFrame`) asks
   it to wait for its own background work that ends (a test run, a build) inside its turn before it answers (step 7 below).
4. **Consent** (`ensureAgentConsent`). **The project's trust is the consent for a `normal` caller** (#673, owner
   decision 2026-10-14): trusting the project (#655) was already the person's decision about it, and a card in a
   session they were not looking at only made the session work alone. Read at each call, nothing remembered; no
   setting. A `safe` caller gets a card in its
   approval slot, detail `agent_start` (the tool, model, preset and task): allow once, always for this session
   (`always`, kept in memory while this host serves the session), always for this project (`always` with scope
   `project`, the card's ⌥; stored as the project's `project_consents` row of kind `agents`, from and to the same
   project, listed and revoked in Settings → Permissions), deny. `auto` opens it, as before.
   Everything before the child exists (check, card, start) has one bound, `START_AGENT_SETUP_MS` (200 s, under the Codex
   bridge's 280 s): past it the answer says whether a session was created. Refusals and this answer tell the calling
   model to ask the person rather than do the work with its own CLI's subagents (#660).
   **A card is not withdrawn at the bound** (#673). The call answers `pending` with the request id (`ag-…`) as a
   handle, and the setup goes on in the background: the card stays until the person answers. An approval then starts
   the child with its report armed (the caller is told when its turn ends, as with `wait: false`); a refusal, or a
   start that fails after the approval, is told to the caller as a message from Centralu (`HOST_SENDER`). The card
   lives in the caller's single approval slot, which the caller's own next events clear while its turn goes on; it is
   raised again (`raiseHostAsks` in `sessions/host-cards.ts`, not recorded twice) when that turn ends, unless it ended in an error.
   Every way such a card closes (the person's answer, a withdrawal, an aborted call, a handoff moving it) goes through
   `HostCards.closeAsk`, which returns a session to the rest the card was raised from (#428). While it stands
   the request is in the store's `agent_start_requests` (v50): a host swap or restart leaves the row (the leaving
   host's call answers `pending`), and the next host raises the card again (`resumeAgentStart`) and starts the child
   when it is approved. An approval (here or there) first reads again what the start rests on (#673 review): the
   caller is still here, its project still trusted, it is still above the agent depth (it may have begun handling an
   ask_project task meanwhile), and its preset is no higher than the one on the card; otherwise no child starts and the
   caller is told why. Turning trust off withdraws the project's standing cards at once and tells their callers. The
   same caller asking the same task (and tool, when named) while its card stands gets the existing handle back, not a
   second card: a drain before a stop tells a cut call to call again, and that call never read its `pending`. A
   request ends when it is answered,
   when the caller withdraws it (`agent_session stop`), when its call is cancelled while the card stands, or when the
   caller is deleted; each end without a child leaves a notice in the caller's session for the person
   (`Centralu · agent request`), apart from a denial on a card the call was still waiting on, which the card shows.
   In the window, a card raised in a session off screen leaves a card in the top right (`Notices`, kind
   `agent_start`) even while the app is in front, and clicking it opens that session.
   The wait of `wait: true` is cut to what is left of `START_AGENT_CALL_MS` (270 s), so setup and wait together stay
   inside the bridge's bound; past it the answer is `working`, with the report armed.
5. **The child.** A visible session in the caller's own folder (a worktree session's worktree), named from the task,
   marked `askedBy` the caller (drawn indented under it in the sidebar, owner decision 2026-10-12; its header links
   back: "Started by …"), under **the caller's permission preset**:
   never more, and no argument or tool of the caller changes it. The task goes in a frame (`agentFrame`: who asks,
   and that the final message is the answer) recorded as sent by the caller (`from`). After the task come the
   project's **instructions for agents started here** (#1161 item 2, `ProjectInfo.agentInstructions`), when the
   person set any: the rules a parent otherwise repeats in every brief (its own worktree, stacked pull requests, never
   `git stash`), written once in the dialog of the project's menu, "Instructions for agents…", and said in the frame
   to be the person's, from the project's settings on that computer. They are read when the task is delivered, so a
   card that stood a while or a start queued for memory carries what is set then; the Assistant's children (no
   project) get none, and nothing else (`agent_session send`, ask_project, a fork, which carries the conversation)
   carries them. They are kept as an app
   setting of the project (`agent_instructions:<projectId>`, at most 8,000 characters, gone with the project), not a
   column, so no store step: an older build serving the same store during a swap ignores the key, and its children
   start without them.
6. **The answer.** Waited for by the same wait as ask_project's (`DelegationWaits.awaitTurn`, #428, each wording its own result; paths an answer names are granted by `grantReads`), up to 240 s; past it, or with `wait: false` at once, the answer is
   `working` and the caller is told when the turn ends through the report the Assistant's `reportBack` uses
   (`awaitingReport` → `deliverReport`). What reaches the model is the part Centralu wrote (#1186): how the work
   ended (the turn ended, failed, paused on its own background work, a usage limit, cut short; a completed turn is
   never called the work finished, since whether it is done is the session's own word, #1902), the session's id, the
   kind of its tool's error (`errorKind`: overloaded, usage limit, network, refused, other), how to go on, and
   `read_session(sessionId, around=<its last response's seq>)`, which shows the last response and the error, an error
   row being one `role: "error"` line; the last response itself, the error's words, the session's and project's names
   and its tasks' descriptions stay in the stored report and the screen (#120: nothing the reported session, its tool,
   its machine or a name could write goes into the receiver's input; a CLI's error can carry a hook's output, and a
   linked machine's is whatever it sends). A `Reason:` built from an error's text (a note held for a linked child that was
   not delivered) reaches the model by its kind too; one Centralu wrote is quoted as JSON. The model used
   to read "intersession message available" and an id alone, for every such notice. A report or notice that cannot
   be delivered (the receiver cannot be woken: its tool fails to start) is logged and kept in memory, and goes in
   once that session takes a message again (`deliverHeld`); it used to be dropped without a word. A call waiting at that moment takes the answer instead, so it does not arrive twice. The marker
   is written to `report_marks` (store v49, #646) as well as kept in memory, so an update's stop (#1618) does not
   lose it: the next host restores the marks of the sessions whose cut turn it continues, which ends under it. It
   drops every other mark (that turn died with the old host), so a later turn the person starts there is never
   reported as the assigned work (#166); that answer stays readable through `agent_session`. Before #1895 step 4
   PR 1 a host swap kept the marks of the sessions the keeper kept, and told a caller whose child ended its turn
   during the swap (`tellTurnEndedInSwap`, #1186); no process outlives its host now. Paths the
   answer names inside the child's folder become readable to the caller, as ask_project's do.
   Each answer that promises the notice (`working` with the report armed, `pending`) says not to check with `status`
   meanwhile, and that `wait` is the one call that blocks until the end; `pending` no longer names `status`. Each that
   names `send` (`done`, `at_rest`) says to start a new agent for another kind of work, with the task written in full,
   since it starts without the old one's context and the old one's name and role came from its first task (#747: a parent
   called `status` more than ten times in a row, and sent read-only research children the editing). In the answers,
   not the descriptions: an answer costs nothing until it is shown.
7. **Work that waits on its own background tasks** (#721). The caller hears of the work's last turn end, not its
   first. On 2026-10-15 six children backgrounded `pnpm verify` and ended a turn "waiting for verify to finish"; that
   turn used up the report, the turn the verify's completion started finished the work and told no one, and the
   caller, asleep, heard nothing for an hour. Now:

   | Rule | Why |
   |---|---|
   | A turn that **completes** while background work the session's tool lists as running (`liveBackgroundTasks`, timers left out) is still going is a pause: the caller is told once, "The assigned work paused: its turn ended while its own background work is still running (…). If that work is a server or watcher it leaves running, the answer below may be its final one. A final report follows only if that work ends; agent_session(action="stop") on it stops that work and ends the wait", with the last response. The report stays owed (`pausedReports`, with the tasks it paused on; the app setting `report_paused:<session>`). Task descriptions are framed fields (`frameField`): the stored report and the screen name each running task; the model reads them counted (#1186) and, where the caller started the child, is told that `agent_session(action="status")` names each of them (#1540) | The caller reads why the child stopped talking, and is not promised an end that a dev server left running never brings |
   | A timer the tool holds (`BackgroundTask.timer`: Claude's `/loop` wake-ups and scheduled prompts) does not hold a report | A loop or a seven-day cron job would hold it for good; the timer keeps the process awake all the same |
   | `agent_session stop` on a paused child stops the tasks it paused on that still run, where the tool can stop one on its own (`stopBackgroundTask`), takes the report down, and names what it could not stop | The caller of a child that left a server running had no way out: it was not kept awake, and `stop` said nothing was running |
   | A turn belongs to whoever started it (#1377). `ChildOwnership` records whose a turn is when it starts (`noteMessage` at each message, `turnStarted` when the session goes busy: the oldest message given before it, else the CLI's own; the app setting `report_turn:<session>` while the turn runs, which the next start reads for a turn a quit cut, so the person's is told to nobody there either, #1946), decides it again when the tool names the input the turn opened from (`turnNamed`, `SessionHandle.turnStartInputs`, #1639, docs/plans/turn-starter.md), and `ChildReports.reportBackIfAwaited` decides at its end: the person's message at rest (no source: what the composer sends, `/compact` and other slash commands included; a caller's, another session's, an app's or Centralu's message always has one) makes the next turn theirs, and it is reported to nobody; the caller's message, an app's or Centralu's, and the CLI starting a turn when the work's background tasks end, make it the work's, and it is reported. Every message goes in named (`SessionHandle.send` `opts.id`, kept on its user row as `inputId`, with `intent` and `relayed`; the rows after `turn_inputs:<session>`'s `spent` are the messages no turn has taken yet, and the key also keeps the running turn's state (opening named, taken over, which held messages joined it), all read back by a host that takes the session over mid-turn). Whether a turn took in a message given while it ran is decided at its end by the inputs the tool says it took (`SessionHandle.turnInputs`; Claude's result names them, `user_message_uuids`, because it folds a queued input in only at a tool round): taken, it joined the work's turn and the report says so ("The person wrote in this session during this turn."); not taken, it starts the next turn, which is the person's. A tool that takes every message into the turn (Codex steers an active turn) has no `turnInputs`: a message given while the turn ran counts as taken in, unless the next turn opens for it (it is carried to that turn's opening, then done with); a CLI that cannot name them (before 2.1.289) takes none in, and its end is done with every message given before it, so none claims the CLI's own next turn. The host says whose each turn was on the event that ends it (`turn` on `turn_complete`, `error`, `limit_reached`, `state_change`) | A person's message never closes a report (it did, #1340/#1344): asking something mid-way no longer costs the caller the work's result; their own failed turn is still never reported as the work's. The report closes only as before (a work turn ends with no paused work, the caller stops or reads it) or when the person chooses |
   | The person's choice (`agents.send` `intent`; the composer shows "Working for <caller>", `agents.reportOwed`): **Just asking** (default) as above; **Add to the task** (`task`): the message makes the turn the work's, reported as "The person added an instruction to this task during this turn."; **Take it over** (`takeover`): the report closes, the running turn becomes theirs, and the caller is told once ("The person took this session over; its later turns are theirs, and none of them will be reported to you") | The person decides what their message means to the work; the host only keeps the rule |
   | The limits of that rule (#1639). **A CLI before 2.1.289** cannot say what a turn took in at its end, and names the input a turn opened from only when its stream carries `user_message_uuid`; without it a turn is the oldest held message's sender's and is never corrected, so a person's message the CLI folded into the work's turn at a tool round is not noted on it (the report does not say the person wrote), and a turn a compact or a mail wake starts while a person's message is held reads as the person's (its report waits for the next work turn). **A host swap** still loses whose the last turn was (`lastBy`, memory only), so a report the settle wait sends right after a swap can carry the person's last answer as the work's last response. The other cases and which way each errs: docs/plans/turn-starter.md §3 | Rare and bounded: the report stays owed, not lost, and the next work turn or the settle wait (`PAUSED_REPORT_SETTLE_MS`) sends it |
   | With no report paused and no turn of the caller's running, `stop` on a child whose own background work still runs (timers left out) stops that work the same way (#718), only when the caller started it (`askedBy`), it is at rest with no card standing, no delegation or wait of anyone is on it, and no report paused over that work is owed to another session (`restingWork`). Work an earlier, finished turn of the person's left running there cannot be told apart from the caller's: `stop` and then `delete` end it too. When nothing could be stopped (only work its tool cannot stop on its own), `stop` fails, naming that work. It waits up to `STOP_REPORTED_MS` (3 s) for the tool to report the end of what it stopped (Claude reports it after `stopTask` returns), so a `delete` right after it is not refused, and says so when the end was not reported yet. Worktree cleanup (`delete`) refused by that work names it, and points to `stop` only for the tasks the tool can stop. A timer does not hold the cleanup, and the delete's `note` names the timers that ended with the process | `delete` refused "still working" while `stop` said nothing was running, so a child at rest with a polling loop left could not be deleted. A turn the person or another session runs there is theirs, and so is the work it starts. A timer is out of `stop`'s reach (`stoppable: false`) and goes with the process |
   | A later turn of the work that ends with a new answer while the work still runs is an **update**, delivered at once (#1540, `ChildReports.reportPauseUpdate`): "An update on the assigned work, which is still paused: a later turn ended with a new answer while its own background work is still running (…)", then the same sentences as the pause, with that turn's answer. It wakes the caller (as mail: a `paused` report keyed by where the turn that ended began in the conversation, read where its end was seen, `TurnReport.update`, so it is not the quiet "same pause again"; the same turn's end told twice, or an older turn's, is the update stored). **One wake until it is read:** while the caller has not read the pause's last update, a newer one is written over it (the newest answer and task count) and wakes nobody; once read, the next update wakes again. A later turn that said nothing (a Monitor's look), Centralu's compaction turn, a turn a message no session sent went into, and every turn after the person wrote to the session while it owed the report (their turn cannot always be told from the work's, docs/plans/turn-starter.md §3, and their words are not the caller's; read from the store, so a host after an update reads it too) say nothing: one rule, `isPauseUpdate` (`sessions/pause-update.ts`), for this host's children and a linked machine's. The first turn end with none of the work left delivers the owed report ("The session ended its turn", the answer of that turn) and wakes the caller through `deliver`'s resume | On 2026-10-25 a review child wrote its full verdict a quarter of an hour after its pause, and its caller never heard it: one task ran on. A Monitor that fires every few minutes with words of its own woke the caller at each look; it now wakes it once until the caller reads the update (#1540 review). The turns that keep the report are the child's own work, never a loop: a report does not start the reporting session's turn |
   | The work ends with no turn running and none starts within `PAUSED_REPORT_SETTLE_MS` (60 s): the report goes out with the last answer and how each task ended ("background work ended (pnpm verify: stopped) and no turn followed, so the work may not have finished"; "…: completed …" when all completed) | Claude starts the turn within a second (its task-notification); a task the person stopped by hand starts none. Each change of the work starts the wait again, and a turn running when it is up reports at its own end |
   | A failed or stopped turn (error, usage limit, the person's Stop, the #698 reasons) is reported as it ended, work running or not | Those need the caller now; the next turn is not the work's own |
   | A turn that stops without answering (an error, a usage limit, the network, its tool's interrupt, a Stop, a quit or shutdown found at the next start, a cut turn Centralu could not continue) releases the questions delivered into the cut turn and not answered (`needsReply` messages; the person's too) and tells each sender once, in one notice (`StopNotices.sessionStopped`, [plans/turn-owned-by-no-one.md](../../plans/turn-owned-by-no-one.md) §4.1, #1948). It says what happened and what the reader can do, never the tool's own words. It wakes only a sender that is at rest and waits on the session (an open task it gave, or a wait), is written quiet for every other, and for a quit or shutdown wakes no one. The person is told in the Inbox in plain words, never of their own Stop or delete; a sender the older report path tells of the same stop is not told twice. The rows stay open, so a reply after the session is continued still answers them. Tasks are not here: the report above tells a task's owner. A request to the Assistant is (owner: its sender always learns it will not be answered): the report of the request's turn tells the asker that turn was owed to, and the notice tells the asker that report misses (one the same quit cut) | A question asked of a session that then failed, hit its limit or was stopped was never heard of again by its asker; only a deleted session, or a turn a restart lost, told it. An asker whose request a quit cut, with the asker cut by the same quit, heard nothing either |
   | A call waiting on the turn (`wait: true`, `agent_session wait`) takes the paused answer, with a notice that the work is not over, and the report is held for the end without a separate pause notice. `status` and `wait` on a paused child read the answer and the same notice and leave the report owed | A read of the paused answer used to take the report down, and with it the end |
   | The turn the child's own tool starts when the paused work ends (no message began it, no person wrote into it) is the caller's work (the same reading `reportBackIfAwaited` reports it by), and its end is reported to the caller (#1576). Since #1948 step 2 a send while it runs is mail, a turn of its own after it (plans/mailbox.md §10.6.2) | The note was refused "busy with something else (the person may be using it)" during the turn whose end the caller was owed |
| A paused child at rest does not keep its caller awake (`waitsOn`); in a turn it does | The work may run for minutes or for good (a dev server); the report wakes the caller when it comes |
   | The person talking to a paused child: their turn ends by the same rules, so the caller hears the end once the work is over | The work the caller gave is still the child's; the person's turn does not end it |
   | New work from the same caller (`agent_session send`, a note) ends the pause: that run's own wait or report tells its end. Archiving either session takes the report down | A pause belongs to the work it was told for; held on, it would report the new work a second time |
   | Across a host restart, an update or a swap the child's process ends, and with it the work it paused on: the next host drops the pause with the mark (an update tells the agent of the background tasks it ended, [../lifecycle/continue-after-update.md](../lifecycle/continue-after-update.md)). **Except after an update's stop** (#1912): a child at rest whose report is paused keeps the mark and the pause (`restoreReports`, `StoppedByUpdate`, memory only). The turn the update's note wakes it for is the work's, and its end is reported with "An update of Centralu stopped the background work this work had paused on before that work ended; the session was told which, and this turn came after." (a pause again, or an update, if it starts new work). When no such turn comes (the note could not go in, or the stop listed nothing of it), the caller is told at once (`reportStoppedByUpdate`): "An update of Centralu stopped the background work the assigned work had paused on (…) before that work ended, and no turn of the session followed, so the work may not have finished; its last answer is below." A person's turn after the wake is theirs; the settle wait then sends that note | The work went with a process that is gone; after an update the caller was promised a final report and waited for good |
   | A handoff moves a paused child with its report; the note says "paused on its own background work; its report comes when that work ends" | Not "finished; its report has not been delivered yet": the new session would wait for a report that is not late |
   | Only a turn the delegation's own wait saw end is judged: the delegation's outcome path reports only a wait that failed with no ending event, or one notes held (`tracksInputs`) | Judged again a microtask later, the pause could read as the end once the work had ended |

   A linked machine's session the hub's Assistant asked to hear about (`reportBack`) pauses the same way (#723,
   `sessions/linked-reports.ts`). The hub keeps each linked session's task list for every session a machine relays,
   so work started before the Assistant asked is known: read whole from the machine's `sessions.list`
   (`LinkedSessions.backgroundTasks`) each time its link comes up (`machine_resync`: the first link, after a drop, after
   the hub's start), since a machine resends its work only when it changes, and then changed by the relayed
   `background_tasks` (the same `applyBackgroundTasks`). A change relayed while that read is out is newer and kept. A
   completed turn there with its own work running (timers left out) sends the paused notice once and keeps the linked
   report (`LinkedReport.paused`); a later turn end with none of that work left sends the final report; the work ending
   with no turn after it settles the report after `PAUSED_REPORT_SETTLE_MS`, saying how each task ended; a failed turn
   is reported as it ended. The Assistant has no `agent_session`, so the notice offers no stop, as for its own
   sessions here; a new `send_to_session` to that session replaces the report, as before. While that send is out, the
   session's events go to the new wait; a send that fails puts the paused report back and starts its settle wait again.
   The machine's link dropping while the report is paused sends it at once, saying the link dropped before the work
   ended and to read the session once it is back (the hub would not see the end; the report carries the last response
   the hub read there, marked as read before the machine went out of reach, #1186), or as settled when the work had
   already ended and only the settle wait was running. A dropped link forgets that machine's task lists until it is
   back. A turn in progress keeps its wait across a drop, as before. The same report is kept for an `ask_project` task there
   whose turn ended on its own background work (`oweAsker`, [ask-project-linked-machine.md](ask-project-linked-machine.md), #1457): the asking session is its owner, and the call
   was told of the pause when it returned. A turn there belongs to whoever started it, as here (#1377): the hub reads the machine's relayed `user_message`
   (no source: the person's; the hub's instruction, another session's and an app's are the work's) and the turn's events
   (`LinkedReport.next` / `turn`), and the person's own turn is reported to nobody and changes nothing of the wait. A
   person's message into a running turn of the work is noted in its report. The relayed message carries the person's choice
   (`intent`: `task`, `takeover`); `takeover` closes the wait and tells the Assistant once, with the same line, without
   the machine's words. The machine's host says whose each turn was on the event that ends it (`turn`), and the hub reads that; a host that does
   not say (an older one) is read from the messages the hub saw, taking a message seen while a turn runs as joining it. The
   hub also applies the choice itself as it routes the call (`Router` `forwarding`, `LinkedReports.choosing`): an older
   machine strips the `intent` it does not know, so "Take it over" closes the wait once the machine took the message, and
   "Add to the task" marks the next relayed message. A child `start_agent` started keeps the rule of #1038
   (`RemoteAgents`, which reads the event first): the person's turn there is not the caller's to read, and the caller is
   told. A machine removed from Centralu reports every wait
   on it, paused or mid-turn ("…was removed from Centralu before …, so its end will not be reported"), named as the hub
   last knew the session. A session deleted there drops its report. Linked reports live in the hub's memory: a hub swap
   drops them, as before.

   Codex lists child threads as background work, so a Codex parent thread that ends with a child thread running is
   paused the same way; a tool that cannot report its background work (`capabilities.backgroundTasks` off) never
   pauses a report.
