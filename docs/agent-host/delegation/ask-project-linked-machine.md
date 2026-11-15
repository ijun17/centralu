# A project on a linked machine (#700)

`ask_project` reaches the projects of linked machines the way the Assistant's `create_session` does
(docs/plans/remote-hub.md §12.6). `SessionManager.askProject` resolves `project` over this computer's
projects and `LinkedSessions.projects()` (each reachable machine's `projects.list`) with `matchProjects`
(`sessions/ask-project.ts`). In order, the first step that finds anything wins:

| Written as | Finds |
|---|---|
| a project id, or a machine-qualified id (`m1.p-12`) | that project, always |
| the name | the project of that name, on this computer or on a machine |
| `<machine>/<name>` (the machine by its id or the name the person gave it) | that machine's project |
| the name, case aside | as above |

The same name on two machines is refused with every choice listed as `name [id] on <machine>`, since
guessing would send the work to the wrong disk. A machine that is not connected is named instead of
leaving its projects out: its projects come from the headers mirror and are refused as "not reachable
right now", a name found nowhere says which machines were not asked, and `<machine>/<name>` for a machine
that is down says so.

For a machine's project the call runs through the links, not the manager's own sessions
(`askLinkedProject`): the machine's ordinary sessions are listed with `sessions.list` there (same
exclusions as here), the person's consent is asked for this call, and the task goes as mail (#1948 step 6,
[plans/linked-mail.md](../../plans/linked-mail.md) §10): a task across the link (`LinkedTasks.send`, `host.mail` with `task`,
origin `ask_project`, the `askFrame` words, from the asking session's address here), which that machine's delivery gives
the session and its engine reports. The call waits for the report up to `ASK_WAIT_MS` (`LinkedTasks.settled`), as
start_agent's does for a child there; past it, it answers `working`, and a call with no task waits again on the caller's
task still open there. The answer is the session's last words, read there whole (`host.lastAnswer`, #1186: its text up
to 100,000 characters, its length and its first message's seq there), cut as an answer is cut here, the cut naming
`read_session` on that session with that seq and an offset. The hub used to read it from `host.readSession`'s lines,
which the machine cut at 2,000 characters of JSON, so a long answer came back as an older line or empty. A read that
fails gives the words the report kept (600 characters); with none either, the call says the turn ended and how to read
it once the machine answers. It runs on that machine with its own logins, folder and preset.

| Choice | Reason |
|---|---|
| The card names the machine, and "always" is not offered (`ProjectAccess.to.machine`) | A remembered consent is a row tied to two projects of this computer (foreign keys on `projects`); a machine's project has no row. remote-hub.md §12.5 (question 4) recommended the pair's card with the machine named; it asks each time until the owner wants a remembered form |
| Paths in the answer are listed under "outside", none opened | They name the machine's files, not this computer's |
| A busy session is not refused: the task is held there until the session can take it, as a busy session's task here is (#1948 step 2), and nothing about busy is read again after the card. The caller's trust and depth are read again after the card (`askGateError`), and the caller's project losing trust withdraws a card still standing. A machine that takes no work from this computer (an older build, or one whose answer to this hub's offer has not come within the bounded wait, as plans/linked-mail.md says under older builds) is refused before the card, naming it to update | One busy rule here and across a link (#1948 step 6). The busy refusal and the mail it named (`busyAcross`, #1186) went with the task across: the machine's own delivery holds the task, or gives it into a running turn whose tool takes input, as it does every task |
| A machine's project list is waited for 4 s (`LOOKUP_MS`); one that does not answer is counted as away | The name is looked up on every call, so one half-open link must not hold up the asks that name something else. The name that is on this computer and on a machine is still refused as ambiguous when the machine answers; when it does not, the call goes on with what was heard. `create_session` finds a machine's project through the same list (`projects({ ref })`, #1143; it was `findProjects` until #1547): it was unbounded, and dropped a machine that did not answer, so a stalled link held up a create in a project on this computer and a name also on that machine started the work here. A name it finds only in a mirror is refused as away, and one also here is refused as ambiguous |
| The turn's end is the machine's report on the task (`TaskStanding`): finished; failed or stopped (not finished, with its error); or the task released there with no report (the session stopped or deleted, the task withdrawn) | The hub no longer reads the machine's events for it (`linkedTurnEnd` and `observeLinkedAsk` are gone): the machine's engine reports the task's turn as it reports a local task's |
| A link that drops does not end the call: it waits up to its bound and answers `working` | The report is owed, not dropped: the machine keeps it and sends it at the next connect (linked-mail.md §10), where it reaches the caller as mail |
| A turn that **completes** while the session's own background work still runs there is paused (the report's `paused`), as a local child's is ([start-agent-steps.md](start-agent-steps.md) step 7, #1457): the call answers `done` with the words so far and `paused` naming the work as the hub last heard it there (`LinkedReports.tasksOf`), and the task stays open; the final report comes as mail when that work ends | The machine's engine owns the pause, as for any task (docs/plans/mailbox.md §10.6.3). The hub's own copy of it (`oweAsker`, `releaseAsker`, its report gate and `keepsOverLoss`) is gone |
| `trusted` is carried only when the machine says it | An older machine's absence is "not saying" (`ProjectAccess.to.trusted`), not "not trusted" |
| Cancelling the call stops the wait, not the machine's turn | This host asks the machine to run a task but has no interrupt of its own turn there |
| The machine's own cards are answered by the person in the hub's window | `asking` (the caller answering them) is not built across machines; the call says it waits on the person |

**The other way round** (#550, [plans/remote-hub.md](../../plans/remote-hub.md) §12.7). A session on a linked machine asks a
project of a hub that turned the machine's switch on (Settings → Machines there, off by default): the machine's
`ask_project` lists each such hub's projects under the hub's name (`LinkedHubs`, links/linked-hubs.ts; asked with
`hub.projects` on the connection the hub offered on, 4 s each), and hands the whole ask to the hub (`askHubProject` →
`hub.askProject`), which runs it as an ask here would (`MachineAsks`, sessions/machine-asks.ts): this computer's card for
the pair in the session that would get the task, remembered once approved (`machine_ask_consents`), the existing
ordinary session, and the task as mail (#1948 step 6): a task from that session's address on the hub (`<machine>.<id>`)
at the depth it sent, held while the session asked is busy. The hub waits for its report up to the bound and answers with
the session's words, cut to size, or `working` with the task's id (`taskId`): the machine then keeps a copy of the task,
which the hub's report answers when it comes (`host.mail` with `report`, taken from that hub only), and a call there with
no task reads that report rather than asking again. A machine that keeps no copy (an older build) asks again, and the hub
answers with the report it kept for it; a hub that gives no `taskId` (an older build) is asked again. The machine's switch
going off withdraws its tasks not given yet, and a cancelled call there withdraws a card still standing here. The hub
answers nothing else of the machine (`reverseCalls`) but mail (`hub.mail`, `hub.mailRows`, `hub.find`; below).

The machine's call waits on the person's card, and its limit is the machine's (`REVERSE_CALL_TIMEOUT_MS`, 30 minutes). The
card can be out of the person's sight while it waits: the person's own turn in that session clears the slot until the
turn ends, which raises it again (#673), and another card can stand in its place. The hub then holds the call's limit
on the machine (`call.hold`, #2271; `HostCards.noteStanding` tells `MachineAsks`), so the ask is not refused while nobody
could answer it. The limit runs on with what it had left once the card stands again. Holding changes nothing else: the
link's end and the machine withdrawing the call still end it, and the machine ends a call held for 4 hours in all
(`CALL_HOLD_MAX_MS`). Option (a) of #2271, the card shown beside the person's turn, would change the layout and was not
taken. A tool's own ceiling on the asking call (Codex's `tool_timeout_sec`, 300 s) is the machine's tool's, and no hold
reaches it.

**Mail across linked machines** (#2067, [plans/linked-mail.md](../../plans/linked-mail.md)). Every session mails every
other, on this computer or on one linked to it, both ways (owner decision 2026-11-09; `mayReachAcross`, mail/across.ts,
allows every pair, and the asks switch is not read). The tool (`MailTool.call`) sends a message for another computer's
session by one call to that computer (`MailAcross.send`): a machine calls the hub (`hub.mail`, on the connection the hub
offered on), a hub calls the machine (`host.mail`), and mail between two machines goes through the hub. The recipient's
host writes it with its own send, its checks and guards, and answers with the message id; only then does the sender's
host keep a copy under the same id (`MessageService.sentAcross`), which its delivery never tries. Each change to a row
of such a message is pushed to the other side (`*.mailRows`, merged forward only: the recipient's host decides
delivered, read, answered and released, the sender's host withdrawn), and a Centralu notice to a session on the other
side (the "no longer watched" notice) is passed on as a notice. Addresses on the wire are the hub's
(`session:<hub id>/<machine id>.<id>` for a machine's session); a machine reads its own by the id the hub's offer gives
it (`you`). `parent` of a session a hub started here goes to the hub recorded when the session was created
(`started_from_hub_by:`, from the connection `agents.createSession` came in on, or from that connection's first offer
when the session came before it), which finds the parent in its own record. A link that is down, a computer from before
it (`older`), an untrusted project (`untrusted_project`: nothing waits for the person across a link), `cite`, a body over
the limit or a refusal of the other computer's rules is said at once and written nowhere, so the same text may be sent
again; only a call that gets no answer says it is not known whether the message arrived. `mail find` searches the
sessions of every computer reached (the hub's own list and its mirrors of its machines; on a machine, each hub's
`hub.find` too), ranked, at most 8 lines, and `mail send` with a name looks across machines as well, refusing a name
found more than once with every candidate's address.
