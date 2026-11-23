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
the answer says so), and kept one level below the caller in the agent depth on that machine (`agentDepth`); a machine
whose build would drop it is refused, with a line to update it.
Only network remotes match (`gitRemoteKey`), and a refusal names repositories, never the addresses as written. Its
task goes in `remoteAgentFrame`, with **the machine's** instructions for agents
started in its copy of the project after it (#1161 item 2), not the hub's: each machine keeps its own, so a Windows
machine's say its paths and its shell. The hub reads them from the machine once the child is made there, after the
card (a machine whose build predates them lists none, and its child starts without them; one that cannot be asked then
gives what it listed before the card); the person edits them in that project's menu on
the hub, which routes the save to the machine (`projects.setAgentInstructions`, by project).

**Its work is mail** (#1948 step 6, docs/plans/mailbox.md §10.6). The start's task, and each later `send` (agent_session's, or the caller's
`mail` to the child, which is work), goes as a task across the link (`LinkedTasks.send`, `MailAcross.sendTask`): written on the machine under
the id the hub picked, from the caller's address, and given to the child by that machine's own delivery, held while the child is busy (the
person's turn there, a card, another task) and given once it is free, as mail to a busy session here waits. The hub keeps its copy of the task
under the same id. The child's turn end is reported by the machine's own engine, as a local child's is (its last response answers the task,
§10.6.3), and that report crosses back (`hub.mail` with `report`, taken only from the machine the task went to) and is written here as
Centralu's report replying to the copy, which settles it `reported`: the caller reads a `kind="report"` mail, as from a local child. A pause
(`paused`, `waiting`) settles nothing. A machine whose Centralu takes no tasks from this hub (its answer to `host.hubOffer` says `tasks`) is
refused before the card, with a line to update it there; a start whose task the machine did not take keeps the child it made and says so. The hub
records the child (`remote_agents`, an app setting: the machine's session, its caller, machine, name, tool, project, worktree branch, preset). A
call that waits (`wait`, `agent_session wait`) waits for that report, bounded as a local child's wait (`ASK_WAIT_MS`): the report answers it with
the child's last words, read there (or the answer the report kept when the machine cannot be read), and is marked read for the caller, so it does
not wake it again; past the bound the child is `working` and the report comes as mail. A deletion there ends the wait at once. `agent_session`
works on it through the link: `status` (the machine's state word; `working` while a task of the caller's is open; at rest, the answer the last
report on its tasks kept, never words of a turn that was not the caller's), `wait`, `send`, `stop` (the caller's open tasks to it withdrawn, the
withdrawal crossing by the receipts, and `agents.interrupt` there), `delete` (to that machine's session archive), `answer`, and `list` names its
machine. **`delete` takes the worktree made for it there too** (#1161 item 3,
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
unchanged. `answer` takes a question card's answer to the machine (`agents.answerQuestion` there) while a task of the caller's is open there;
the card's handle names that task. An approval card stays the person's on that machine, whatever the caller's preset: a caller's `auto`, which
alone lets it answer a local child's approval, never answers one on another computer, even when its child runs under `auto` there. A card raised
in the turn of a task is told to that task's giver by the machine's own mail, as for any task (§10.6.4).

The person may use the same session on that machine (#1038 review, RV13). Whose a turn there is, is that machine's to say: its delivery gives
the caller's task as a turn of its own only when the child is free, and its engine reports that turn alone. Nothing on the hub reads whose a
turn is from the machine's events any more, and nothing of a turn that is not the caller's reaches the caller: `status` gives the state word,
and an at-rest answer is the one a report of the caller's task kept. A link that drops loses nothing: a report the machine could not pass on
stays undelivered there and goes at the next connect. The paths its answer names are that machine's, and none is made readable here.

It counts under the caller's project's ceiling ([start-agent-steps.md](start-agent-steps.md), "How many"), wherever it runs, while a task of
its caller's to it is open (`workingIn`): the ceiling bounds how much one project's sessions set going at once, and the machine counts nothing
for a session the hub started there; its start holds a place from the card's answer until its task is open, and a `send` to a child with no open
task is checked as a local one. A hub restart loses nothing of it: the tasks and their copies are in the two mailboxes. A record a build before
#1948 step 6 kept (`owed`, and its own reading of whose a turn was) is read once at startup (`RemoteAgents.restore`): a caller still owed a report
by the old path is told once where the child stands, and the old fields go. A handoff gives the child to the heir, and the tasks its caller gave
it with the caller's other mail (`Handoffs.handOver`); the machine is told whose they are now (`host.mailMove`), so the report goes to the
heir. A child deleted there, or whose
machine was removed, while the hub could not see it is cleared by `list` and `delete`; the caller's session archive clears its
children's records, and a handoff gives them to the heir. In the sidebar it stands in that machine's project, among
the sessions there and with a way back to its caller in the header's ⋯ menu (#2213), since a project on another machine is a project of its own
(#1416; #1038 first drew it under its caller, in the caller's project). The caller's row carries no pointer to it
(owner, 2026-10-26: the "2 on win-pc" pointer of #1416 was removed); the child keeps its row, its way back and its inbox entry. The hub names the
caller as its `askedBy` in that machine's rows and owner events (`LinkDeps.ownerOf`, `LinkedHost.remoteAgentParent`)
and sends `session_owner` when it records the child, hands it to an heir, or forgets it with its caller; the mark
follows `askedBy`, so it moves with the heir and goes when the caller does.
