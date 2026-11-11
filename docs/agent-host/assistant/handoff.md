# What a handoff carries, and what it leaves (#693, #738, #1475, #1638)

A handoff (`createSession` with `handoff.fromSessionId`, the session handoff of domain-model §1.1) used to leave the
original's children where they were: their reports woke the original, which the person had stopped working in (and
usually deleted next), and the new session could not reach them, since `agent_session` works only for the starter. The
new session now takes the original's children over as it is created, before its first turn reads the note
(`moveChildren`, owner decision on #693), and its attached apps with them (#1638). Everything a handoff does with the
original's things is in this table; the bullets below say how.

| The original's | Carried to the new session | Left with the original |
|---|---|---|
| Children: sessions it started, forked or asked in another project | **Every** one, finished ones too (#738, #1475), with the report, turn and delegation that are theirs | Another project's session keeps its own `askedBy` row. A child the original starts **after** the handoff stays until the original is deleted (below) |
| Requests it queued for a busy child; its standing start_agent requests | Both. A standing card closes in the original and stands in the new session | A request only `auto` let through is dropped when the new session is not `auto` (#606). Both are dropped, not moved, when the original is removed later |
| Mail | The unread mail and watched rows: those from the moved children and Centralu's reports about them when the original stays, all of them when it goes (`MessageService.handOver`, #1574) | The rest of an original that stays, which is still there to read and answer it. A moved child's reply to a message the original sent goes to the original, which still exists |
| Attached apps (`attach_app`) | **Copied**, before the new session's process starts: the same apps with the same consent, except an "Allow once" answer, which is copied only when the original goes (#1638) | Its own copy. A one-time answer the original keeps when it stays: the note says to attach that app again, and the person is asked. The copy goes with the original when it is deleted |
| The note, the name and the preset | The note is the new session's first message; it takes the original's settings and preset | The conversation and its history |
| The original itself | | It stays, unless the window removes it as a last step (`removesOriginal`, the window's default since #1477). `handoff_session` never removes it |

- **What a child's line in the note says**: its state, from what is owed. A session working or waiting on the person
  (approval or question), one whose report to the original is not
  delivered yet, an `ask_project` answer the original never came back for (that tool tells nobody when it ends), and a
  start_agent request still open (its card still standing, #673, or already allowed and queued until memory frees up,
  [../delegation/child-workspace.md](../delegation/child-workspace.md#what-a-child-costs-the-machine-code-intelligence-and-the-memory-gate-686), #686) say so. A child with nothing owed (finished, and reported or read) is "finished; waiting for more work".
  Same-project children (`askedBy` or `parentSessionId` naming the original) and the original's delegations in another
  project both count. A finished child is often still in use (waiting for its Assistant's next instruction). Left
  with an original that goes it belonged to nobody (#738); left with one that stays, the session that carries the work
  on could not list or archive it (#1475). So it moves whether the original goes or stays.
- **What moves**: `askedBy` and `parentSessionId` where they name the original (another project's session keeps its
  own row), the report mark (`report_marks`), the delegated turn's link (`delegated_turns`) and the delegation the
  host holds for it (its key names the caller), and its standing
  start requests (`agent_start_requests`, whose stored request names its caller too). A standing card closes in the
  original and stands in the new session as a card raised between turns, so the new session's first turn hides it and
  its end raises it again; an approval starts the child for the new session (the waiting setup reads the request's
  caller after the card). A start that already made a moved child hands its handle over too.
  - **A handoff that removes the original** (chosen in the window; its default since #1477, and before #694) says so (`handoff.removesOriginal`, an addition to
    `createSession`: scope `goes`, against `kept`), and all its unsettled mail moves. It is the same move in the same transaction.
    The window removes the original as a separate, last step (`store.handoff`, "destruction comes last"), so the host is
    told beforehand rather than finding out: told at creation, the move still happens before the first turn reads the
    note. If that deletion then fails, both sessions stand and the children are with the session the person works in.
  - **An original removed later** (a handoff that kept it, then a delete; or a window that did not say it would
    remove it) gives what it still has to the session that inherited its handoff, in `trashSessionOnce` (`sessions/session-trash.ts`) before the
    teardown lets go of them (scope `removed`): the children it started after the handoff, with the
    reports, turns and delegations that are theirs, since an orphan is worse. What it asked for and the person never
    answered stays behind and goes as before: its standing start_agent cards are withdrawn and the requests it queued
    are dropped, so no card appears in another session because this one was deleted. A call of its own still waiting
    on a moved child ends with a fixed answer (`handedOverReply`), since archiving drops the `handedOver` entries
    before the woken call reads them. The heir is the newest live session whose handoff marker names it
    (`Store.handoffHeirs`, filtered in SQL); successors that were removed, or are being removed at the same time
    (`trashing`), pass on to their own successors, the nearest generation first. Its note was read long ago, so it is
    told in its conversation (a `notice`); the original, about to go, is told nothing. The move is its own transaction ahead of the archive's: a crash between them leaves the children
    on the heir and the original standing. A removed session that never handed over leaves its children on their own,
    as before. Apps are not carried then: the heir has had its own since it started.
- **The apps are copied, not moved, and before the process starts** (#1638). What moves is work owed to one owner (a
  report, a turn, a request), since two owners would deliver twice. An app is a capability, not work: two sessions can
  hold the same one, every call records the session that made it, and an original that stays may still be used, so it
  keeps what it can use. A deleted one forgets its own (`AppAccess.forget`). The copy is the original's stored list
  `session_apps:<id>` (`AppAccess.carry`), so each app keeps its server name and its consent (`always`, `auto`, `none`) as
  it was. **An "Allow once" answer is not copied** unless the original goes (`removesOriginal`, the person's own action,
  so the copy is in effect a move): it was for that attachment only (`dropOnce`), and a second holder without a card would
  outlive the moment it was given for. The successor attaches that app again and the person is asked. What the new
  session may use is read again on every count under **its own** preset, trust and the person's consent, as for any
  session that attached them: `auto` counts only while the new session is `auto`, a revoked "always" takes the app from
  it, and the apps of its own project come from the project as before. The copy runs in `createSession` ahead of the
  adapter's start, not inside `moveChildren`'s transaction: Claude reads its servers as it loads, and a Codex thread
  fixes its servers at `thread/start` (the app server's `config/mcpServer/reload` takes no parameters, so it cannot carry a
  server that only this thread's start config holds, and a thread with no turn yet has no rollout to resume), so what is
  counted at the start is what the session has. The checks of what an app may see (the session's tool profile and preset)
  are read from the host's record of sessions, which does not have the new one until its row is saved: `starting`
  (`SessionAppWiring`) gives them for that time, built from the same profile and preset the row gets. A start that fails
  deletes the copied list again (`sessionGone`), so no row is left for a session that never was.
- **The note**: the note file the opening message points at, and the marker that keeps its original, open with a
  section listing what moved: name, state, handle, and what the new session can actually do with it, which depends on
  what moved (#693 review). A child it now started: `agent_session` works on it, and its report comes when one is owed.
  A finished child of the original's own project has no line of its own: one line counts them and says
  `agent_session(action="list")` lists them with their names, handles and states, and so does the count for the reports they
  had not been read yet (Centralu's mail about them: the mail tool's inbox lists those), so the note stays short however many
  there are; a child with something going (working, waiting, owing a report) and every other piece keeps its line.
  Another project's session: `ask_project` with no task waits for the answer, and the cards of the turn it now owns
  are told to it. A same-project session it did not start (a turn it now owns): the report and the cards, while
  `agent_session` works on it only under `auto`. A standing card: the handle for `agent_session` until the person
  answers. A start queued for memory (`allowed`): no card; it starts on its own as the new session's child when memory
  allows, with the report armed for it, and the handle works meanwhile. An attached app: its name and the server name
  its tools come under, after the rest, as "attached to you too"; one it cannot call (an "Allow once" answer that did not
  carry over, a consent that does not apply to it) is listed as "not attached to you", with the ref `attach_app` takes. Nothing moved, nothing added. The opening message itself is the window's and is not changed (the window
  confirms it by its text).
- **An original that stays** (a handoff that keeps it, #694) is told in its conversation what children, requests and
  mail went to whom (a `notice`; its apps stay with it and are not in it). A child with something going has its line
  there; the finished ones are one count ("30 finished sessions also moved to …"). A call of its own still waiting on one of them (`agent_session` wait or send, `ask_project` with no task,
  a wait on a start request's handle, a `start_agent` call whose card is approved later) ends with where it went, so
  the answer is read once, by the new session; a wait had taken the child's report mark down, so that report is owed to
  the new session, set in the same transaction (`armReports`). Its later `agent_session` or `ask_project` about one of
  them says where it went (`handedOver`) rather than "not a session this session started". The answer for a session is
  also found from the store, so it survives a host restart: a child that is older than the successor, owned by it, when
  the successor's handoff marker names the original (the direct predecessor: an earlier session in the lineage never owned it).
- **A child that does the work the original owes its own giver stays** (#1932, `kept` only). When the original was asked for a task, handed
  the work on to a child and answered `waiting`, that child's report is what finishes the task, and the task (with the report owed
  for it) is the original's. Moved, the report would go to the successor, which does not know the task, and the giver would never be told the end.
  So such a child (`MailboxRecords.carriesUpstream`: a task from the original to it, still open, whose cause is a **task** the original was given,
  still open; a report, notice or message that started the turn is never settled and does not count, as in `handedOnFrom`) keeps answering to the
  original: its report wakes the original, whose turn finishes the task as before. The note lists it as "stays with the previous session", and the
  successor does not follow it; the original's notice names it too ("Still with this session, …"), also when nothing else moved. A child with two open
  tasks, one caused upstream and one not, stays whole. Only local children are looked at: a child on a linked machine moves with its caller
  (`moveCaller`) before this is decided. An original that goes (`goes`) gives its tasks away with the rest, and the answer to the task given
  to it is not finished there either (a separate gap).
- **Who may hand over** is not checked here: `moveChildren` trusts its caller. Two callers reach it through
  `createSession`: the person's handoff (the window's RPC) and the Assistant's `handoff_session`, after
  `HandoffFlow` has checked its authority over the original ([handoff-session-and-projectless.md](handoff-session-and-projectless.md)). Any other agent-facing path must check its
  authority the same way first.
- **Atomic**: everything stored moves in one transaction (`Store.moveChildren`); the host's memory follows after the
  commit, with no await in between. A crash before the commit leaves every link on the original, after it every
  link on the new session, so a host taking over after a swap or a restart reads one owner (`report_marks`,
  `delegated_turns` and `agent_start_requests` are read at startup as before). If the store refuses,
  nothing moves and the note lists nothing. A delegation's end releases its turn by the delegation's owner at that
  time, not the one that started it.
- **Where the state lives**: `ChildOwnership` (`sessions/child-ownership.ts`, #428) holds who owns a child's work:
  report marks and paused reports, delegated turns, delegations, start_agent requests, linked machines' reports, and what a handoff gave away. Each change with a
  store mirror writes it there; the manager reads through read-only maps. The memory side of the move is one call,
  `moveOwner`, which runs the manager's card move for the moving start requests in the middle, in the order above.
  What moves, the store's transaction, and `askedBy` / `parentSessionId` stay with the manager. At startup it reads
  its own rows back (`restoreReports`, `restoreTurns`, `restoreQueued`), as the manager's constructor did; the
  standing start_agent requests are `AgentStartFlow.restoreAgentStarts`, called between the reports and the turns.
- **The windows** hear `session_owner` (the session's `askedBy` and `parentSessionId` now) and hang the child under
  its new owner; a linked machine's event is qualified (`Qualifier.event`) and patched into the hub's mirror.
- **The mail moves too** (#1574, docs/plans/mailbox.md §7.7): `MessageService.handOver`, run last inside the same
  transaction (`moveChildren`'s `then`), so a refusal there leaves the children and the mail on the original. With the
  original kept (scope `kept`), what the moved children sent it and Centralu's mail about them (a finished child's report
  is sent as Centralu, with the child in its `about`, so it goes with the child it reports and does not wake the
  original); a moved child's reply to a message the original sent earlier is addressed to the original, which still
  exists, and goes there; with it removed (`goes`, or `removed` in
  `trashSessionOnce`), every unsettled watched row and unread message it holds. A moved row the original had not read is
  delivered to the successor afresh. The note (and the heir's notice for `removed`) lists each as `mail message "<first
  line>"` with its id as the handle; the archive preview of an original with an heir says what goes to that heir.
  `session_owner` is unchanged, and the Inbox hears the mail change itself. A child on a linked machine has no mail thread yet (mail across machines is slice 4), so only its
  report link moves (`moveCaller`), as before.
