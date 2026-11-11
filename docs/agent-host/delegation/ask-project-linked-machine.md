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
exclusions as here), the person's consent is asked for this call, the task goes as `host.send` (recorded
there as sent by the asking session, named with this computer), and the turn is waited on through the
machine's own events, which the hub relays qualified (`observeLinked`). The answer is the session's last
words, read there whole (`host.lastAnswer`, #1186: its text up to 100,000 characters, its length and its first
message's seq there), cut as an answer is cut here, the cut naming `read_session` on that session with that seq and
an offset. The hub used to read it from `host.readSession`'s lines, which the machine cut at 2,000 characters of JSON,
so a long answer came back as an older line or empty. A read that failed is said (the turn ended, the answer could not be read, read it with
`read_session` once the machine answers), here, in start_agent's answers for a child there and in a report's preview,
where it used to come back as an empty answer. It runs on that machine with its own logins, folder and preset.

| Choice | Reason |
|---|---|
| The card names the machine, and "always" is not offered (`ProjectAccess.to.machine`) | A remembered consent is a row tied to two projects of this computer (foreign keys on `projects`); a machine's project has no row. remote-hub.md §12.5 (question 4) recommended the pair's card with the machine named; it asks each time until the owner wants a remembered form |
| Paths in the answer are listed under "outside", none opened | They name the machine's files, not this computer's |
| A session busy with a turn, or `ifBusy`, is refused with a reason; the machine's sessions are read again after the card is answered, and nothing is sent if the session left or started a turn meanwhile. The caller's trust and depth are read again after the card and right before the send (`askGateError`), and the caller's project losing trust withdraws a card still standing | A note or a queue into a session on another machine needs the machine to take them; not built. The card can stand for minutes, and a task sent into a turn the person started there would join it and end the call with their turn |
| A machine's project list is waited for 4 s (`LOOKUP_MS`); one that does not answer is counted as away | The name is looked up on every call, so one half-open link must not hold up the asks that name something else. The name that is on this computer and on a machine is still refused as ambiguous when the machine answers; when it does not, the call goes on with what was heard. `create_session` finds a machine's project through the same list (`projects({ ref })`, #1143; it was `findProjects` until #1547): it was unbounded, and dropped a machine that did not answer, so a stalled link held up a create in a project on this computer and a name also on that machine started the work here. A name it finds only in a mirror is refused as away, and one also here is refused as ambiguous |
| The turn's end is read by `linkedTurnEnd` (`sessions/linked-turn-end.ts`), the same reading the Assistant's report from that machine uses (`LinkedReports`): an approval or a question there is a running turn (as is a working state, `isInTurn`), an error or a usage limit ends the call as not finished, an interruption does once the turn was seen running (before then it ended the turn the task joined, not the task's), and so does the session being deleted there (#428) | A local agent's run reads an interrupted turn as not finished (`AgentRunWait`, #698); the two copies had drifted, so an interrupted turn there answered as done and a deleted session left the call waiting |
| A link that is no longer connected ends the tasks asked of its sessions (`observeLinkLoss`, on `machine_status`) | Their events stop reaching the hub, so the end of the turn would never be seen. The sentence says the task was delivered and may still be running there |
| A turn that **completes** while the session's own background work (timers left out) still runs there is paused, as a local child's is ([start-agent-steps.md](start-agent-steps.md) step 7, #1457): the call answers `done` with the words so far and `paused` naming the work, "its report follows when that work ends and a turn there ends it", the warning that a server left running may make this the final answer, and `read_session` on that session. The asker is then owed the work's last turn end: `LinkedReports.oweAsker` keeps a paused linked report for it on the turn end, before the call is told (`LinkedReports.observe` reads the same event after and finds it paused, so nothing is sent for it), and the later turn there with none of that work left wakes the asker once through the same `reportGate`, person's-turn and loop rules as the Assistant's linked reports ([start-agent-linked-machine.md](start-agent-linked-machine.md) step 7). A failed, stopped or person's turn is not paused; an older machine that does not list background tasks never pauses (today's answer); a report another session is owed there is not replaced. The turn the child's own tool starts when that work ends (a task notification, no message of anyone's) is the asker's work continuing: a note goes into it as into the turn the asker gave (`gateNow`: the report is paused, the hub saw the turn begin and the linked report reads it as the work's), and `status`, `wait` and `answer` read it as that turn; a turn a person's message started, or one another session is owed, is refused with the cause named ("the person may be using it there" only for a person's), and a turn the hub did not see begin (a hub swap in it) or a machine that lists no background work (never paused) keeps today's refusal, said as "a turn it started by itself that this hub cannot tie to the work you gave it" (#1576). Such a turn that this hub's own update of the machine cut, and the host it started there continued while the link was down, is the same turn: a link this update holds keeps the linked report's reading of it (`keepsOverLoss` answers `turn`), so a note still goes in (#2164). So is the turn the machine opens for a compaction's next step after the caller's turn: its `state_change` says `continues: 'compaction'`, and while the child's turn was the caller's with nobody else's since, the hub takes it for the caller's, owes its end and lets a note in (`RemoteAgents.turnOpens`). The asker's new task to the session ends the pause (`releaseAsker`, put back if the send fails), since that ask's own end is what it hears next. A link lost while paused reports as `LinkedReports` does for any paused report ("the link to … dropped before that work ended"), except for a child `start_agent` started, whose report stays owed and is settled when the link is back (#1523). A call that went away first (cancelled, or past its bound) still gets the pause when it collects with no task, while the report is owed; collected after the report went out, the words are plain. Two limits, as for every linked report: it lives in the hub's memory, so a hub swap drops it, and a turn another session or the Assistant gives the session ends the report owed to the asker, since a turn belongs to whoever sent its message (#1377) | The call used to answer at the first turn end, so work started in the background ("I will summarize when it ends", #1457) lost its result: nothing reached the asker, who went on as if the answer were final |
| `trusted` is carried only when the machine says it | An older machine's absence is "not saying" (`ProjectAccess.to.trusted`), not "not trusted" |
| Cancelling the call stops the wait, not the machine's turn | This host asks the machine to run a task but has no interrupt of its own turn there |
| The machine's own cards are answered by the person in the hub's window | `asking` (the caller answering them) is not built across machines; the call says it waits on the person |

**The other way round** (#550, [plans/remote-hub.md](../../plans/remote-hub.md) §12.7). A session on a linked machine asks a
project of a hub that turned the machine's switch on (Settings → Machines there, off by default): the machine's
`ask_project` lists each such hub's projects under the hub's name (`LinkedHubs`, links/linked-hubs.ts; asked with
`hub.projects` on the connection the hub offered on, 4 s each), and hands the whole ask to the hub (`askHubProject` →
`hub.askProject`), which runs it as an ask here would (`MachineAsks`, sessions/machine-asks.ts): this computer's card for
the pair in the session that would get the task, remembered once approved (`machine_ask_consents`), the existing
ordinary session, the task as from `<session> on <machine>` (`MACHINE_ASKER`), one level deeper than the asker, and the
answer cut to size. A cancelled call there withdraws a card still standing here. The hub answers nothing else of the
machine (`reverseCalls`) but mail (`hub.mail`, `hub.mailRows`, `hub.find`; below).

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
