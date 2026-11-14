# Continuing the turns an update cut

**Continuing the turns an update cut** (#1618, owner 2026-10-26). An update that does not wait (the person's `now`, and
every update nobody approved) ends the turns running there; the host it starts takes each of them up again, once, the way
the person's Continue would.

- **Which.** One definition, recorded by the host that stops, at the moment it stops: the sessions in a turn as it lets
  its sessions go (`cutTurns` in idle.ts: working, or waiting on an approval or a question, `turnCut`), read in the same
  step as their processes end and after it took its last call (`HostTenure.disposeAll`). So a turn that began after
  the hub read what runs is listed too, and a person's Stop the host took before it stopped leaves its session out.
  Background work alone is not a turn and is not continued, but it is told (below, "What else the stop ended").
- **Told it is an update.** Every stop of the hub's after which a host starts again in that folder (the update's, the
  put-back's after a failed check, a rollback's; not an uninstall's) runs `serve --stop` with `CENTRALU_STOP_FOR=update`
  (`stopCommand`, `stopRemoteHost`), which the launcher passes on as `host.stop { forUpdate: true }` (additive). Once
  the processes are down and their last output written, the host writes those turns as a list of its own,
  `<data>/update-resume.<uuid>.json` (`{ v: 1, turns: [{ id, seq }], stopped: [...] }`, lifecycle/update-resume.ts), each with the last
  row of its conversation then (`seq`). A list is written once, under a new name, beside any an earlier stop left:
  nothing is renamed over a file another process may hold. One that cannot be written is said in the log with the
  folder's own error, and those turns end as a stop's always did. A host the launcher could not ask (it is ended
  instead), a stop of the person's, or a host from before #1618 writes nothing, and its turns end as a stop's always did.
- **Taken once each, and only that turn** (#1626 review). The next host to start in that folder reads all the lists
  before it builds its sessions, without taking them. A listed session is that stop's turn only while its conversation
  still ends at the listed row. That holds because the next start always writes a row for a listed session: the
  Continue's line, or the stopped mark of one that is lost or no longer the listed turn (and an older host's start after a
  rollback writes its own stopped mark), so the conversation is past the row before any later turn. It does not rest
  on "a turn records its input first": a turn the CLI starts itself after a background task, and Centralu's own
  compaction, begin with no row. So a list left behind (one a virus scanner held open when it was to go, one a host from
  before #1618 never read after a rollback) continues no later turn, and a later stop of the person's that cuts one is
  told as a quit's. A list the start cannot read because it is held (`EBUSY`, a virus scanner that opened the file just
  written) is read again by the one policy for held files (os/held.ts: 1.6 s in all), each failure in the log; one still held stays where it is for a
  later start, and the turns of sessions this start finds cut are marked stopped like a quit's (the host cannot tell which
  the list names), with the log saying why. A list goes once each
  turn it names is dealt with (`UpdateResumeLists.done`): its Continue went in, its loss was reported, or the start did
  not find it cut. One that cannot be removed is said in the log, stays harmless, and goes at a later start; one a host
  killed while it wrote is not JSON and goes at the next start. A host that stops before then (its check failed and the
  update puts the old one back, a second update, a rollback) leaves the lists and writes its own with the turns it cuts,
  the continued ones included, so the host after it continues them; a Continue the tool takes while the host is leaving
  is left to that next host, which sends the note, writes the line and tells the requester: a host leaving for a second
  update writes no line of its own for it, so the conversation shows one Continue. A person's quit lists nothing,
  so there the line is written: it is the row that carries the conversation past the mark of the list still standing. Nothing expires: a list is the next start's, whenever it comes,
  on that machine's own clock. A list of another format continues nothing and is left to the host that wrote it.
- **Continued.** A listed session the start finds mid-turn with no process stays `working` (no "stopped" mark, no quit
  notice), its owed report and its delegated turn kept, and once the start is done it is woken
  (by the one continue engine, `TurnContinue.wakeAfterUpdate`, [auto-continue.md](auto-continue.md): a few at a time, below)
  and given Centralu's note through Centralu's channel (`deliverMail`, no message of the person's): "Centralu on this
  machine was updated while your turn was running, which stopped the turn before it finished. Continue where you stopped.
  Check what already happened before repeating a step." Until the note is in, a wake from elsewhere (a window that sees
  the machine back) keeps the turn's state (`RestartPolicy.continuingTurns`), so a hub reading the machine meanwhile does
  not read the turn as ended, and the note goes in once. A window does not wake a session that is in a turn with no
  process at all: the machine continues it, and "<machine> is back, resuming N sessions" counts only what the window
  wakes. The conversation shows "Centralu was updated during this turn, which stopped it; Centralu continued it on the
  new version."
- **The stop keeps what is owed.** A quitting host's failed delegation waits no longer settle the child's report or
  turn (`DelegationFlow`, `closing`): the next start decides, from the marks the store kept, whether the turn is told as
  stopped (a quit) or continued (an update). Work the person owns gets no "stopped" report in their Inbox; its one report
  is the continued turn's end.
- **What else the stop ended** (#1902). Measured on real hosts, an update used to lose three things without a word to the
  agent: a background task of a session whose turn had ended (a dev server, a watcher; the store's record of it was
  overwritten with an empty list at the next start), a question card (the CLI wrote "The user doesn't want to proceed…
  [Request interrupted by user for tool use]" for it, and the agent asked why the person interrupted instead of asking
  again) and an approval card (the same text). The stop now lists, per live session and in the same step as the turns,
  `stopped: [{ id, seq, tasks, approvals, questions }]` (`stoppedAtUpdate`, lifecycle/update-stopped.ts): each running task
  (a timer too; ambient housekeeping is not work) with its kind, description and the command of the tool call that started
  it (`parentCallId`, read whole from the stored call: `MessageRecords.toolCallInput`), whether an approval waits, and the text
  of each open question. The same mark as the turns applies: the next host acts on an entry only while the conversation
  still ends at `seq`. The note is Centralu's (`updateNote`): for a cut turn it is the Continue sentence of #1618 followed by
  a paragraph per thing the stop ended (the tasks to restart or drop, the card the person did not refuse); a session at
  rest whose tasks the stop ended is **woken for the note alone** and told only that. Both go in through `deliverMail`, the
  one door of #1618: the wake of a session at rest is a continue of the update, not a turn a message or mail started
  (mailbox.md §8.2: the mailbox's delivery and `MailTurns.begin` are not involved), the tool starts that turn on its own, so it is recorded as the CLI's own turn of the person's work (`turnStarted`:
  `by: 'work'`, `cli: true`; `beginOther`), with no mail behind it, and counts nothing against a sender's budget. A session the person already woke takes the note into their turn. The
  agent decides what to restart: nothing is rerun by Centralu. The deny text a closed card is released with
  (`Session closed`) does not reach the model (measured: the CLI writes its own result for a tool call whose process
  ended), so the note is the one channel for the card, and it is the same for every tool; an older host reads `turns` only
  and ignores `stopped`. Codex's child agents are tasks of kind `agent` with a description and no command; an ACP tool
  reports no tasks, but its open cards are told the same way.
- **Terminals and Run commands the stop ended** (#1902 part B). Before this, they vanished with no event: `terminal.list` and
  `commands.state` were empty after the restart. They are not a session's, so they have no conversation mark and a list of their
  own (`recordUpdateEnded`, lifecycle/update-resume.ts; the shapes are in lifecycle/update-ended.ts), written by the stopping host in
  its first step (`recordEnded` in `stopPlan`, before the shells are killed: no await comes before the kill; only a stop that was
  asked for an update records, `host.stop { forUpdate }`, or the desktop window's or the keeper's stop line: [updates.md](updates.md)). Only what opening them again needs is kept, and nothing a shell printed or
  a person typed: per terminal its folder and size (`TerminalService.snapshot`); per running Run command its folder and command
  (`CommandRunner.runningSnapshot`), with the time of the stop. The next host takes the list whole, once, before it listens
  (`UpdateResumeLists.takeEnded`, `restartEnded`). **The list is removed first**, by the path the lists of turns are removed by, and
  nothing is brought back when it cannot be (a scanner holds it): it would otherwise open them again at every start. **A list older
  than ten minutes is removed and not used** (`ENDED_MAX_AGE_MS`): a rollback to a host from before this never removes a list that
  names no turn, and a new host started days later must not open terminals and run commands nobody expects. Each terminal comes
  back as a **fresh shell in the same folder** (same size; named by its place, as ever) with an empty screen and nothing typed into
  it, and each Run command that was running **starts again**, its log opening with one line saying why (`RUN_RESTARTED_LINE`; its
  size is measured again when a window attaches). What ran inside a terminal is not run again and not offered, and a Run command is
  started again at once even when it was a one-shot started seconds before the stop: both are the owner's decision (#1908). The
  person sees their terminal tabs back with an empty prompt and their Run commands running again with that log line; there is no
  new element. A folder that is no project's now, or is gone from the disk, is skipped and said in the log. A list is never taken
  twice.
  **The windows read them again.** An update restarts the host of a linked machine while the hub's window stays connected, and the
  new host numbers its terminals from 1 and gives its runs new ids, so a tab kept from before would draw another shell under its
  name. The machine's `machine_resync` therefore counts for that machine's projects (`machineResyncs`, `resyncsOf` in the UI
  store): the terminal pane lists its shells again and mounts every tab fresh, and the run ledger of the machine's projects is read
  again (`reloadCommandRuns`, also on the resync of the connection to this computer's host), so the Run panel shows the run that is
  running now. A Run command a session started is started again too, and that session is not told (the note of the tasks the stop
  ended, above, lists its own background tasks, not these).
- **A few at a time** (#1913, owner 2026-11-12 and 11-14). The wakes go `UPDATE_WAKES_AT_ONCE` (3) at a time, cut turns first and then
  the sessions at rest woken for their tasks, until every one is woken. A slot is held from the send until the woken session's first
  answer (any output of its first model request), or any other end of that wake (its turn ends or errs, the person stops it, it is
  deleted, the note could not be sent or no longer stood). The burst is the first request: after a restart each one re-reads the whole
  conversation uncached, and forty sessions woke as forty such requests at once. Holding a slot for a whole turn would leave the sessions
  at rest waiting behind long jobs for hours. Owner 11-06: no usage cap, so this bounds a burst, not a budget. While a cut turn waits for
  its slot it reads `working` with no process: the person's Stop ends the wait and the turn (it is not continued, and its list entry goes);
  a message of the person's sends the note at once, outside the queue, since the message does not say what the stop ended. A host that
  leaves before the queue drains leaves the rest listed, and the host after it wakes them (a session woken meanwhile and in its wake turn
  is a turn that stop cuts, and is continued as one). There is no setting and no wait in the header: Centralu cut these turns, the person
  did not stop them.
- **Not continued.** A session that is not mid-turn when the host stops: the person stopped it and the host took the
  Stop, it was archived or deleted. A Stop still on its way when the host stops is not taken: that session is listed and
  continued. A session whose turn had ended but whose background work (a dev server, a watcher) still ran loses that
  work with its process and is not continued as a turn, but its agent is told (above). One whose tool cannot take it up again
  ends as a crash's does (`turnLostInSwap`): `quit`, and its report or its requester told it stopped.
- **A swap's cut was continued the same way** (#1966). Between #1895 step 4 PR 1 and PR 5 a swap's drain was a stop for
  an update, so the turns it cut were listed and continued as above, through the same door (`TurnContinue.wakeAfterUpdate`),
  the state kept `working` while the new process comes up (`continuingTurns`). No host is drained for a swap since PR 5
  ([front-door.md](front-door.md)). A turn cut by the person's own quit (`markQuit`, no list) is not continued, as before (#1947).
- **Its caller hears nothing of the cut** (#1966). The update used to send one notice per cut child, each waking the parent's turn
  for no decision. Now the parent is told nothing until the continued turn ends; that report carries one line, "An update of
  Centralu cut this turn and Centralu continued it." (`TurnStarter.cut`, set before the Continue goes in and dropped if it fails, `ChildOwnership.noteContinuedCut`; the machine's host
  says it on the ending event, `TurnWho.cut`, so a hub carries it on that one turn's report whether or not its link caught the turn mid-way).
  Every session whose turn Centralu cut is continued, the person's own sessions too, not only children: Centralu cut it, the person did not stop it (owner, #1966). A turn that cannot be
  continued ends as a stopped turn and is told as such (above): one report for that child, which the parent is owed anyway. A caller on the hub (a child start_agent made there) is not told that the link
  dropped while the hub's own update or rollback holds the link, from its first step until the link is back
  (`RemoteAgents.updateHolds`), when the machine's host is one that continues cut turns. The new host's `hello_ok`
  names the turns it continues from its start on, before it answers any hello, whether or not the Continue is in yet
  (`updateContinued`, with when its start took each up, on its clock; one that turns out lost is no longer named), so
  the order of the Continue and the reconnect does not matter; once the link is back and the child is in
  its turn again and named there, its report is marked as continued (above). An
  update that ends with the machine not back lets the link go, and the drop is told then. Either way the report it is
  owed is the continued turn's end: one report, never "finished" for the cut.
- **What it does not cover.** A child on the machine found at rest when the link is back after it could not be
  continued is reported as at rest, as before: neither `host.sessions` nor the hello carries the loss (one whose
  continued turn ended meanwhile is reported finished, which it is). A machine whose host predates #1618 lists nothing as
  it stops; the hub's sentence then says the turns were lost, and a caller on the hub hears the drop as before.
  `pnpm remote-dev` (`dev-build.ts`) goes through the update's steps, so its stop is for an update too: the turns running
  are listed and the dev build's host continues them like any next host.
