# Starting an agent on a linked machine

**On a linked machine** (#1038, `sessions/remote-agents.ts`). `machine` (a linked machine's id or name) starts the
child on that machine, in its project that is a checkout of the caller's repository: the same `origin` remote on both
sides (`projects.origin`, compared by `gitRemoteKey`, so `git@github.com:me/app.git` and `https://github.com/me/app` are
one repository). No such checkout is refused with that machine's projects and their origins; two checkouts are
refused unless one has the caller's project's name; a machine that cannot be reached is refused as unreachable. The
caller's gates are the same (an ordinary session of a trusted project, above the agent depth) and are read again after
the card. The card is `agent_start` with `machine`: it names the computer, is raised every time, and offers no
"always", as ask_project's card for another machine's project (#700); it is bounded like a local start's setup
(`START_AGENT_SETUP_MS`). An `auto` caller's start raises no card where the machine takes `auto` from this computer
(#1273): the hub asks it first (`host.hubAuto`, its "Allow auto from a linked computer" switch); a machine whose switch is
off gets the card, which says why the child runs under `normal` (`autoWithheld`). The child
is made over the link (`agents.createSession` there) under the caller's preset capped at `normal` (as create_session
over a link, #838, which carries an `auto` one the same way) with the caller's preset carried beside it (`fromHub`), which the machine turns into `auto` only for
an `auto` caller while its switch is on, read again at that start (`presetFromHub`); a child made without a card that
did not get `auto` (the switch went off meanwhile) is deleted before it is given its task. The machine marks it
`startedFromHub`, and its header shows its preset there and on the hub unless it is `auto`, the default (its sidebar row stopped showing it: the tag was noise, owner 2026-11-05; the header too, 2026-11-12, #2213). It is made with the model, effort and worktree
branch asked for (the machine's own rules apply: a worktree needs a project trusted there; `lsp` is not passed, and
the answer says so), and kept one level below the caller in the agent depth on that machine (`agentDepth`, and the
task's turn is sent with that depth too); a machine whose build would drop it is refused, with a line to update it.
Only network remotes match (`gitRemoteKey`), and a refusal names repositories, never the addresses as written. Its
task goes in `remoteAgentFrame`, sent as from the caller ("… on <hub>"), with **the machine's** instructions for agents
started in its copy of the project after it (#1161 item 2), not the hub's: each machine keeps its own, so a Windows
machine's say its paths and its shell. The hub reads them from the machine once the child is made there, after the
card (a machine whose build predates them lists none, and its child starts without them; one that cannot be asked then
gives what it listed before the card); the person edits them in that project's menu on
the hub, which routes the save to the machine (`projects.setAgentInstructions`, by project). A call that waits opens its wait before the
send, so a turn that ends at once is its answer, not a report. The hub records it (`remote_agents`, an app setting) and arms a linked report for the
caller before the send (`LinkedReport`, as the Assistant's `reportBack`), so the end of its turn comes back as a
local child's does, with the same pause over its own background work (#723); a call waiting on it (`wait`,
`agent_session wait`) reads the answer instead (`RemoteAgents.observe`, read before the reports). `agent_session`
works on it through the link: `status` and `wait` (the machine's state and last words), `send`, `stop`
(`agents.interrupt` there; nothing more is owed), `delete` (to that machine's session archive), `answer`,
and `list` names its machine. **`delete` takes the worktree made for it there too** (#1161 item 3,
`agents.deleteAgentChild` on that machine, `WorktreeSessions.deleteHubChild`), when nothing would be lost by it. Only
that one: a worktree Centralu made (`worktree.base`) on the branch the hub's record names, for a session another
session started (its recorded agent depth), so never the project's own folder, a worktree session of the person's, or
one a child started without a worktree.
Only when nothing is lost: nothing uncommitted in it, and every commit of its own (its checkout's `HEAD` and the branch
made for it, which the agent may have left) on a remote-tracking ref or the trunk (`gitUnpublishedCommits`); a branch
pushed from there passes, a commit only there does not. Then it goes as a local child's does (`cleanUpWorktreeChild`:
its recovery snapshot in the session archive, the worktree and the branch removed). Otherwise the session still goes to the session archive,
the worktree stays, and the answer says what was left and why ("it holds 2 uncommitted files", "it has 1 commit that no
remote and not the trunk has: push …", work still running there, another session in its folder). A folder already gone
is said in the cleanup's own words (#715: its branch kept when it holds commits the trunk lacks), never as "nothing was
unpushed"; a delete asked again finds the session gone and says so. A turn the hub just
stopped is waited out for up to 10 s first (`STOPPING_WAIT_MS`), as the cleanup refuses a session still in its turn. A
machine whose build predates it answers "Unknown method": the hub deletes the session there as before and says the
worktree stays because of that build. A local child's worktree was already removed by `delete` (#608); that is
unchanged. The cards of the turn its caller gave it come to the caller as a local child's (#676): a
wait returns them (`asking`), `status` reads them from the machine (`LinkedSessions.cards`), and a card raised while
no call waits is told once (`cardNotice`); each card's handle names that turn (`RemoteAgent.turn`, new with each start
or send at rest). `answer` takes a question card's answer to the machine (`agents.answerQuestion` there). An approval
card stays the person's on that machine, whatever the caller's preset: a caller's `auto`, which alone lets it answer a
local child's approval, never answers one on another computer, even when its child runs under `auto` there. `send`
into the turn the caller gave it goes in as a note (the machine's `host.send` takes it into the running turn, as the
person's message there; nothing is armed again); into a turn the caller did not give it (the person's there, or one the
tool started after the work was reported finished, which nothing on its start ties to the assignment) it is refused, and a fork
does not reach another machine. The note is held instead (mail does not cross links; before #1948 step 2 only with `ifBusy: "queue"`), in the child's record on the hub (`RemoteAgent.queued`), and sent as new
work the caller owns (`sendAtRest`, the send at rest), once the child is in no turn: after a turn's end seen, and when the machine's link is back. The
note stays in the record until the machine has it, so a link that drops as it goes loses none, and a restart in the middle of a send may send it twice,
as the local queue did. Held notes go first: a send at rest meanwhile is held behind them. A note refused at the
time it would go (the caller's trust or depth read again) is told to the caller, with the error's kind for the model.
The caller's stop drops what is held. A send while the caller's deletion of the child is under way is held, and nothing held goes until the deletion
ends (#2114): if it fails, the notes go. A held note is never sent to a child that is gone (deleted, by the caller or on its machine, or its machine
removed): the mailbox writes each as the task it was, never delivered, and releases it `gone` with the child's other mail, so the step-1 stop notice
tells the caller (`MailSessionsView.linkedChildGone`, docs/plans/mailbox.md §10.6.1). Nothing is said when the caller itself is trashed. The held notes
end with the host: once it is leaving, `drain` reads and writes nothing, checked again after each wait. A stop served by the build before this one during a swap leaves the field, so the
note goes once the link resyncs. A note the tool did not read in the turn it went into
runs as a turn of its own once that turn ends, with no message to start it (#1604). The machine's host says which: the tool
names the input a turn began from, and the host reads who sent it from that message's user row, which keeps the id it went
in under (`inputId`) and its sender (`ChildOwnership.turnNamed`, looked up from the oldest turn start kept), so a host that
takes the session over after a swap reads the same. The `state_change` that opens the turn carries `origin: { seq, from }`,
the row of the last named message a hub sent and its sender (additive, `TurnOrigin`). Nothing is kept beside the rows: the
app setting `input_origins:<session>` that held the hub's messages went with #1948 step 3 (docs/plans/turn-starter.md
"After #1948 step 3"). The tool names the input only
on the event that opens the turn, and the host reads it there whether or not it already had the session working: an
instruction sent at rest in the gap between a turn and the one run for a note before it has the session working before
that turn opens. A CLI that runs several notes as one turn names only the last. Claude Code names it as `user_message_uuid` on the turn's first message (the adapter's
`turnStartInputs`; a note sent into a one-reply turn about 2.3 s after its task still reached the turn's end and ran as the next turn, measured); Codex, which merges a message sent while a turn runs into it but starts a turn of its own for one sent
just after a turn ended or queued behind a compact or review (`MidTurnLedger`), gives its `turn/start` the input's id as the
client id and reads it back from the turn's first item (`item/started`, `userMessage`, `clientId`) with a second
`working` for that turn that names it; a message that joined a turn already running shows after the turn's first item and
names nothing. The hub holds the rows of the messages its caller gave the child that the tool may run as a turn of its own
(`RemoteAgent.given`, in the child's record, so a restart of the hub keeps them): its notes into a running turn, and its
instruction sent at rest. A send at rest does not drop the
rows of the notes before it, as the turns run for those can still be to come. The hub takes a turn for the caller's when its
origin names one of those rows from this hub's sender; its end is then owed as the first turn's was, and a note goes into it.
A row goes when a turn is run for it or for a later one, and every row goes with a message of someone else's.
Nothing is guessed from the time between turns. A turn with no origin is refused, and so is everything after the person's
message. A link's loss or a restart of the hub keeps the rows but not whose the turn is (`unknown`): a turn that opens
meanwhile is not taken for the caller's, and the rows stay for the re-read when the link is back (`verify`): if the machine's
last message is the caller's note, the turn that is run for it afterwards is the caller's. The same read says whether the machine lists the child in a turn (`lastUserMessage`'s `atRest`) and the row of that message: at rest, no turn will open for a message before that one, so the rows before that row are dropped, which settles the turns that opened while the hub could not see them. That message's own row stays: the tool opens the turn run for a queued note a moment after the turn before it ended, with the child at rest in between. An older machine sends no origin
and behaves as before this: a note it runs as a turn of its own stays refused. A refusal names the turn by what the hub saw start it: a person's message, another session's, or no message
at all ("which this hub did not see begin"), never the person without a message of theirs.

What the caller reads of such a turn is that turn's words (#1604). `host.lastAnswer` takes `turn: true`: the answer is
that of the last turn that ended, read from the row the machine saw it begin after (`ChildOwnership.noteTurnStart`, in the
app setting `turn_span:<session>`, kept for every session since #1946, which a stop notice reads too, so a host that takes the session over after a swap
reads it), not the last response of the record. A note's row is stored while the turn before it runs, so the last response
joined the two turns' words and clipped them at the report's 600 characters; and a note stored in the middle of a turn's
text ended that text, so a wait read only what followed the note. A caller's notes in a turn (a row that names its sender)
are rows among its text (`turnAnswer`'s `acrossNotes`); the person's message ends it, as it always did. The next turn may
have begun as the hub reads the end of this one: then it is the turn before it that ended, up to where the next began. It
may also have ended (#1812): the event that ends a turn says the row it began after (`TurnWho.since`), and the hub asks for
that turn's words with it (`host.lastAnswer`'s `since`; an `agent_session` wait's read too), up to where the next turn began.
The span keeps the last 8 starts (`starts`, beside `latest` and `previous`); a `since` that is not one of them (older than
those, or a span an older build rewrote) reads as the last turn that ended, as does a machine that does not say or read it. A turn
that ended with nothing to say has no answer, and the report says so; it is never the turn before's. A turn that never sent its end because its process went (a host that starts with the session left mid-turn, a crash) is closed when that is known (`ChildOwnership.noteTurnEnd`): its words are those it said, or none, never the turn before's. A turn the host did not
see begin (before this build) reads as the last response, and so does an older machine.

The person may use the same session on that machine, and nothing of a turn that is not the caller's reaches the
caller (#1038 review, RV13). One gate decides it (`RemoteAgents.gate`), and every path that hands the caller anything
of the child passes it: `status` (in a turn and at rest), `wait` (as it opens, on a card, at the turn's end, and before
owing the turn again when the call is cut short), `answer`, `send` (a start's task, a send at rest, a note into a
turn), a card's notice, and the linked report's text and preview (`LinkedReports` asks `reportGate`: deliver, withhold,
or defer while it cannot tell). The gate reads whose the child's current or last turn is (`Whose`) from this hub's own
evidence: `caller` once the machine recorded the instruction this hub last sent (its `user_message` from this
machine's `HUB_SENDER`, with the text kept as `sent`, not a replay of one seen before) while no other turn ran there
(`busy`, from its events) and nothing else since; `other` once anything else came: the person's message (their words
the same as the caller's included), or the instruction taken into a turn already running (a send that read the child
at rest just before the person's message, a start's task behind the person's first message, a note that arrived after
the caller's turn ended); `unknown` while an instruction is on its way, and from a link's loss or a restart until the
machine's last message is read again (`verify`). Owned, the turn's words are the caller's; live (owned and running,
not held over its background work), its cards, an answer to them and a note into it are too. Not owned, the caller gets
the fact ("a turn you did not give it", "the person is using it there") and the state word: no card, no words, no wait
or report owed for it. Becoming another's ends what the caller was owed: a waiting call returns that fact, and a report
owed is dropped and the caller told, whatever made it another's but the person's own message (#1386, #1377). That one never
closes a report: the linked report reads whose each turn is (`LinkedReports.observe`), so the person's turn at rest is
reported to nobody, their message into the work's running turn is noted and that turn is still reported, and the work's next turn
(the tool ending its background work, the caller's instruction) is reported too (`personHeld`, `reportGate`); the gate still reads
whose the child's turn is from the person's message on, so `status`, `wait` and a note do not hand the caller a turn the person spoke
into. A person's message the hub did not see (a link's loss, a restart) cannot be told from their turn, so it ends what was owed
as above, as does a link that drops while it stands. A turn's end the reports held back while whose it was could not be told is settled once it can
(`settleDeferred`, `caughtUp`). A note that goes in after the caller's turn ended with nothing else running starts a
turn of its own, whose end is owed as a send's is (`tookInstruction`). The table in `remote-agents-boundary.test.ts`
runs every such path against each way the person's turn can come about. When the link drops, a waiting call returns with that
said, and a caller still owed a report, also one paused over the child's background work (`keepsOverLoss`, #1523), is told once
that the child cannot be followed until the link is back; a paused report stays owed, and the link's return reads the machine's
work whole (`LinkedReports.resync`) and reports the end it missed, once; when it
is back, the child is read (`caughtUp`, `verify`): what ran there meanwhile is the caller's only if the last message the child
took is the instruction this hub sent it (its text kept as `sent`, from this machine's `HUB_SENDER` as the link
qualifies it; `LinkedSessions.lastUserMessage`). Then a turn that ended meanwhile is reported, and one still running
reports when it ends. Otherwise another's message came after (the person's on that machine), or the instruction never
went in: the caller is told that what it gave the child ended or was set aside unseen, with nothing the child said
since, rather than handed another's turn as its report. The paths its answer names are that machine's, and none
is made readable here. It counts under the caller's project's ceiling ([start-agent-steps.md](start-agent-steps.md), "How many"), wherever it runs: the
ceiling bounds how much one project's sessions set going at once, and the machine counts nothing for a session the
hub started there; its start holds a place from the card's answer until its wait or report counts it, and a new
`send` turn is checked as a local one. What is owed of it survives a hub restart: its record keeps `owed` (a call
waits on its turn or its report is armed, with the background work a held report waits on), written whenever its
report changes (`ChildOwnership.onLinkedReportChange`). The next host arms the report again for a caller still there
(`RemoteAgents.restore`; a call that waited is gone, so the end is its report now), and once the machine's link is up
reads the child: a turn that ended meanwhile is reported then, one still running when it ends if it is the caller's
(below), and a held report waits for its work once the link's resync has read it (`LinkedReports.resync`), not
before: a link slow to come up would otherwise settle that work as ended. The Assistant's own linked reports still live in memory. A child deleted there, or whose
machine was removed, while the hub could not see it is cleared by `list` and `delete`; the caller's session archive clears its
children's records, and a handoff gives them to the heir. In the sidebar it stands in that machine's project, among
the sessions there and with a way back to its caller in the header's ⋯ menu (#2213), since a project on another machine is a project of its own
(#1416; #1038 first drew it under its caller, in the caller's project). The caller's row carries no pointer to it
(owner, 2026-10-26: the "2 on win-pc" pointer of #1416 was removed); the child keeps its row, its way back and its inbox entry. The hub names the
caller as its `askedBy` in that machine's rows and owner events (`LinkDeps.ownerOf`, `LinkedHost.remoteAgentParent`)
and sends `session_owner` when it records the child, hands it to an heir, or forgets it with its caller; the mark
follows `askedBy`, so it moves with the heir and goes when the caller does.
