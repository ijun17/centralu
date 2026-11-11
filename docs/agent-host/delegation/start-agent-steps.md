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
   the child with its task written (its answer comes back as with `wait: false`); a refusal, or a
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
   inside the bridge's bound; past it the answer is `working`, the task written.
5. **The child.** A visible session in the caller's own folder (a worktree session's worktree), named from the task,
   marked `askedBy` the caller (drawn indented under it in the sidebar, owner decision 2026-10-12; its header links
   back: "Started by …"), under **the caller's permission preset**:
   never more, and no argument or tool of the caller changes it. The task goes in a frame (`agentFrame`: who asks,
   and that the final message is the answer) recorded as sent by the caller (`from`). The caller's task is written to the
   mailbox before the frame goes in (`ChildOwnership.delegated`): handing it over can outlast the call's bound, and a host that
   goes in that gap leaves the task to the next one, whose start answers it; a hand-over that fails withdraws it. After the task come the
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
   `working` and the task stays open: the child's reply to it marked as the answer (`kind: "answer"`) answers it, or its last response once it is at rest
   ([plans/mailbox.md](../../plans/mailbox.md) §10.6.3). A turn that ended asking to compact with a next step (`compact_self`'s
   `then`, `SelfCompaction.goesOn`, #2164) is not the answer either: the call answers `working`, and the step's turn answers the
   task. What reaches the model is the part Centralu wrote (#1186): how the work
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
   once that session takes a message again (`deliverHeld`); it used to be dropped without a word. A call waiting at that moment takes the answer instead, so it does not arrive twice. The open
   task is the record of what is owed: it is a row of the mailbox, so a restart or an update's stop (#1618) keeps it, and the
   next host answers it with the session's last response once the session is at rest. The report marks that recorded it
   before #1948 step 3 (`report_marks`, store v49, #646) are read once at the start and cleared (`takeOverFromEarlierBuild`),
   and written again only for an earlier build that may take over (`leaveForEarlierBuild`). Paths the
   answer names inside the child's folder become readable to the caller, as ask_project's do.
   Each answer that promises the notice (`working` with the task written, `pending`) says not to check with `status`
   meanwhile, and that `wait` is the one call that blocks until the end; `pending` no longer names `status`. Each that
   names `send` (`done`, `at_rest`) says to start a new agent for another kind of work, with the task written in full,
   since it starts without the old one's context and the old one's name and role came from its first task (#747: a parent
   called `status` more than ten times in a row, and sent read-only research children the editing). In the answers,
   not the descriptions: an answer costs nothing until it is shown.
7. **Work that waits on its own background tasks** (#721). The caller hears of the work's last turn end, not its
   first. On 2026-10-15 six children backgrounded `pnpm verify` and ended a turn "waiting for verify to finish"; that
   turn used up the report, the turn the verify's completion started finished the work and told no one, and the
   caller, asleep, heard nothing for an hour. Since #1948 step 3 a task is answered by the session's reply to it or by
   its last response once it is at rest ([plans/mailbox.md](../../plans/mailbox.md) §10.6.3); report marks, a caller's paused
   report and its updates are gone. Now:

   | Rule | Why |
   |---|---|
   | A turn that **completes** while background work the session's tool lists as running (`liveBackgroundTasks`, timers left out) is still going answers nothing: the session is not at rest (`agentLook`), its tasks stay open, and nothing is sent while that work runs. Its last response answers them when a turn ends with none of that work left (`ChildReports.turnEndedAtRest`), or `OWN_WORK_SETTLE_MS` (60 s) after the work ended with no turn running (`ChildReports.settleAtRest`, armed again at every start) | The caller reads the work's end, not a turn that only waited on it; a Monitor that fires every few minutes wakes no one. Claude starts the turn for a task's end within a second (its task-notification); a task the person stopped by hand starts none |
   | A timer the tool holds (`BackgroundTask.timer`: Claude's `/loop` wake-ups and scheduled prompts) does not keep the session from rest | A loop or a seven-day cron job would hold the answer for good; the timer keeps the process awake all the same |
   | `agent_session stop` on a child paused on its own background work stops the tasks that still run, where the tool can stop one on its own (`stopBackgroundTask`), and names what it could not stop | The caller of a child that left a server running had no way out: it was not kept awake, and `stop` said nothing was running |
   | Whose a turn is (#1377) is read from the store's rows and kept nowhere (docs/plans/turn-starter.md "After #1948 step 3"). Every message goes in named (`SessionHandle.send` `opts.id`, kept on its user row as `inputId`, with `relayed`). `ChildOwnership` guesses it as the session goes busy (`turnStarted`: the newest row, when it is a message given at rest, else the CLI's own), decides it when the tool names the inputs the turn opened from (`turnNamed`, `SessionHandle.turnStartInputs`, #1639): the person's when the rows named are only the person's (no source: what the composer sends, `/compact` and other slash commands included; a caller's, another session's, an app's or Centralu's message always has one), the work's when any other is, the CLI's own when none is; a turn whose opening was not named is decided at its end by the inputs the tool says it took (`SessionHandle.turnInputs`). A person's message the work's turn took in is noted on it (`wrote`): one the tool names as taken, or, for a tool that takes every message into the running turn (Codex, no `turnInputs`), one given after the turn began. Memory only: a host that takes a session over mid-turn reads that turn as the work's, unless its end names its inputs. It is said on the event that ends the turn (`turn` on `turn_complete`, `error`, `limit_reached`, `state_change`), for a hub that follows the machine, and to the mailbox (`mail_turns.started_by`, the pair's warning count) | A turn belongs to no one (#1948): a request has the answer, so nothing here reports by whose a turn is. The person's own work keeps its Inbox report, which skips the person's turn. The composer's choice of what a message meant to the work ("Working for <caller>": Just asking, Add to the task, Take it over; `agents.reportOwed`, `intent`) went with #1948: the person's message is just a message |
   | The limits of that reading (#1639). **A CLI before 2.1.289** cannot say what a turn took in at its end, and names the input a turn opened from only when its stream carries `user_message_uuid`; without it a turn keeps its first guess, so a person's message the CLI folded into the work's turn at a tool round is not noted on it, and a turn run for a message held from the turn before reads as the CLI's own. A tool that runs several messages as one turn and names only the last is read by that one. The other cases and which way each errs: docs/plans/turn-starter.md §3 | Rare and bounded: what it decides is only what a hub is told and the pair's warning count |
   | With no turn of the caller's running, `stop` on a child whose own background work still runs (timers left out) stops that work the same way (#718), only when the caller started it (`askedBy`), it is at rest with no card standing, and no delegation or wait of anyone is on it (`restingWork`). Work an earlier, finished turn of the person's left running there cannot be told apart from the caller's: `stop` and then `delete` end it too. When nothing could be stopped (only work its tool cannot stop on its own), `stop` fails, naming that work. It waits up to `STOP_REPORTED_MS` (3 s) for the tool to report the end of what it stopped (Claude reports it after `stopTask` returns), so a `delete` right after it is not refused, and says so when the end was not reported yet. Worktree cleanup (`delete`) refused by that work names it, and points to `stop` only for the tasks the tool can stop. A timer does not hold the cleanup, and the delete's `note` names the timers that ended with the process | `delete` refused "still working" while `stop` said nothing was running, so a child at rest with a polling loop left could not be deleted. A turn the person or another session runs there is theirs, and so is the work it starts. A timer is out of `stop`'s reach (`stoppable: false`) and goes with the process |
   | A turn that stops without answering (an error, a usage limit, the network, its tool's interrupt, a Stop, a quit or shutdown found at the next start, a cut turn Centralu could not continue) releases what the session owes and tells each sender once, in one notice (`StopNotices.sessionsStopped`, [plans/mailbox.md](../../plans/mailbox.md) §10.6.1, [plans/turn-owned-by-no-one.md](../../plans/turn-owned-by-no-one.md) §4.1, #1948): the questions delivered into the cut turn and not answered (`needsReply` messages; the person's too), and its open tasks (a Stop only those of the turn it stopped). It says what happened and what the reader can do, never the tool's own words. It wakes only a sender that is at rest and waits on the session (an open task it gave, or a wait), is written quiet for every other, and for a quit or shutdown wakes no one. The person is told in the Inbox in plain words, never of their own Stop or delete. The rows stay open, so a reply after the session is continued still answers them | A question asked of a session that then failed, hit its limit or was stopped was never heard of again by its asker; only a deleted session, or a turn a restart lost, told it. An asker whose request a quit cut, with the asker cut by the same quit, heard nothing either |
   | A call waiting on the turn (`wait: true`, `agent_session wait`) reads the answer itself and marks that report read (`answerRecorder`), unless the child's own background work still runs or work it handed on is open: then the task stays open, the call says so, and the last response answers it later | A read of the paused answer used to take the report down, and with it the end |
   | A paused child at rest does not keep its caller awake (`waitsOn`); in a turn it does | The work may run for minutes or for good (a dev server); its last response wakes the caller when it comes |
   | The person talking to a paused child: their turn ends by the same rules, so the caller's task is answered once the work is over; the answer says when the person wrote in the session after the task was given (`facts.personSince`) | The work the caller gave is still the child's; the person's turn does not end it |
   | Across a host restart, an update or a swap the child's process ends, and with it the work it paused on; the next host answers its open tasks once it is at rest, as above (an update tells the agent of the background tasks it ended, [../lifecycle/continue-after-update.md](../lifecycle/continue-after-update.md)) | No process outlives its host |
   | A handoff moves a paused child with its open task (`MessageService.repointTasks`); the note says "paused on its own background work; its report comes when that work ends" | Not "finished; its report has not been delivered yet": the new session would wait for a report that is not late |

   A linked machine's session the hub's Assistant asked to hear about (`reportBack`) still pauses, as this host's children did before #1948 step 3, until mail crosses links (#723,
   `sessions/linked-reports.ts`). The hub keeps each linked session's task list for every session a machine relays,
   so work started before the Assistant asked is known: read whole from the machine's `sessions.list`
   (`LinkedSessions.backgroundTasks`) each time its link comes up (`machine_resync`: the first link, after a drop, after
   the hub's start), since a machine resends its work only when it changes, and then changed by the relayed
   `background_tasks` (the same `applyBackgroundTasks`). A change relayed while that read is out is newer and kept. A
   completed turn there with its own work running (timers left out) sends the paused notice once and keeps the linked
   report (`LinkedReport.paused`); a later turn end with none of that work left sends the final report; the work ending
   with no turn after it settles the report after `OWN_WORK_SETTLE_MS`, saying how each task ended; a failed turn
   is reported as it ended. The Assistant has no `agent_session`, so the notice offers no stop, as for its own
   sessions here; a new `send_to_session` to that session replaces the report, as before. While that send is out, the
   session's events go to the new wait; a send that fails puts the paused report back and starts its settle wait again.
   The machine's link dropping while the report is paused sends it at once, saying the link dropped before the work
   ended and to read the session once it is back (the hub would not see the end; the report carries the last response
   the hub read there, marked as read before the machine went out of reach, #1186), or as settled when the work had
   already ended and only the settle wait was running. A dropped link forgets that machine's task lists until it is
   back. A turn in progress keeps its wait across a drop, as before. The same report is kept for an `ask_project` task there
   whose turn ended on its own background work (`oweAsker`, [ask-project-linked-machine.md](ask-project-linked-machine.md), #1457): the asking session is its owner, and the call
   was told of the pause when it returned. Whose a turn there is (#1377), the hub reads from the machine's relayed `user_message`
   (no source: the person's; the hub's instruction, another session's and an app's are the work's) and the turn's events
   (`LinkedReport.next` / `turn`), and the person's own turn is reported to nobody and changes nothing of the wait. A
   person's message into a running turn of the work is noted in its report. A machine before #1948 may still relay the
   composer's choice on it (`intent`), and say `added` on a turn's end; the hub reads neither. The machine's host says whose each turn was on the event that ends it (`turn`), and the hub reads that; a host that does
   not say (an older one) is read from the messages the hub saw, taking a message seen while a turn runs as joining it. A child `start_agent` started keeps the rule of #1038
   (`RemoteAgents`, which reads the event first): the person's turn there is not the caller's to read, and the caller is
   told. A machine removed from Centralu reports every wait
   on it, paused or mid-turn ("…was removed from Centralu before …, so its end will not be reported"), named as the hub
   last knew the session. A session deleted there drops its report. Linked reports live in the hub's memory: a hub swap
   drops them, as before.

   Codex lists child threads as background work, so a Codex parent thread that ends with a child thread running is
   paused the same way; a tool that cannot report its background work (`capabilities.backgroundTasks` off) never
   pauses a report.
