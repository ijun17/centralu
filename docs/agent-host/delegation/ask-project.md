# Asking another project (`ask_project`, #371 part B)

The one reach an ordinary session has outside its project. `ask_project({ project, session?, task? })`
gives a task to an **existing ordinary session** in another registered project and returns its answer.
It never creates a session in another project (#614, owner decision 2026-10-13). Creation remains the
person's action in that project; `start_agent` creates only within its caller's own project. The global
assistant, which belongs to no project, retains its own create-session tool.

What one call does (`SessionManager.askProject`, which runs `AskProjectFlow` in `sessions/ask-project-flow.ts`, #428):

1. **The project.** Name or id of another registered project, on this computer or on a linked machine
   ([ask-project-linked-machine.md](ask-project-linked-machine.md)). Its own project is refused; an unknown name lists the other projects, each with the machine
   it is on once a machine is linked. Under `safe`/`normal`, an untrusted caller cannot ask; under `auto`
   (#603), the caller's own preset opens and logs that boundary. Under every preset, a session at the agent depth
   cannot delegate (#867, `agentDepthRefusal`): at the default of 1, a child started by another session or a
   session currently handling a cross-project task.
2. **The session.** `session` names an ordinary session by name or id. Assistants, builders and
   app agents are excluded. Without it, exactly one ordinary session is selected; otherwise the call
   lists the candidates with id, name, state and last activity and asks the caller to name one.
   Duplicate names require an id. No ordinary session means a refusal telling the person to open
   one there. Selection never creates, renames or takes ownership of a session, and the task's
   text never auto-names a "New session" (#646): only the person's own words do, as with an app's
   message. Old `Asked by <project> · HH:MM` sessions remain ordinary sessions; their former cross-project `askedBy` mark is removed (#614), and
   their name and history are kept.
3. **Consent.** `ensureProjectAccess` (`delegate`) raises a card in the caller's session naming
   `<caller project> asks <project> / <session>` and the task. Allow once, always for this project
   pair, or deny; only always is stored in `project_consents` and revoked in Settings → Permissions.
   The card states the target's trust, including in conversation and notification text. Under `auto`
   the card is skipped and logged without saving consent. The selected session keeps its own tool,
   model, effort, preset, project trust and approvals. Availability, the caller's trust and depth, and the target
   project are checked again after consent (`askGateError`). The caller's project losing trust or being removed, or
   the target project being removed, withdraws a card still standing (`withdrawReaches`).
4. **Delivery.** The task travels in `askFrame`, explaining the caller and how the answer comes
   back (the caller's project name a one-line field, `frameField`, as the parent's name in `agentFrame` and
   `agentNoteFrame` is, #428), and names the asking session by its name (one line, written as a JSON string so a quote in it cannot close it) and id (#1186: the model
   read the project only; `from`, which identifies the session, is in the store and on screen, not in the input). It
   appears in the target conversation with `from` identifying the asking session. An idle
   session resumes as needed, and once it is awake (a wake or a deferred restart takes seconds) the caller's trust and
   depth and the target project are read once more before the task is written (`deliver`'s `stillAllowed`): an `auto`
   caller's untrusted project still lets it through (#606); its depth and a removed project still refuse. A session that cannot take it now (in a turn, on a card, at a limit) is sent the task as mail
   instead, which reaches it as a turn of its own once it is free ([delegated-turns.md](delegated-turns.md#requests-to-a-busy-session-677), [mailbox.md](../../plans/mailbox.md) §10.6.2); no
   fork across projects. No interrupt or CLI-specific logic is added to the manager, and another
   delegation's watcher is never replaced. `AgentRunWait` holds until the delivered input's receipt completes,
   even if the CLI queues it into a later turn; an earlier turn's answer cannot finish this call.
5. **The answer.** Final text is JSON-quoted as another session's words and clipped after 6,000
   characters: the first 4,500 and the last 1,200 are kept, and the cut names the read that shows the rest,
   `read_session(sessionId, around=<the answer's first seq>, offset=4500)` (#1186; `clipAnswer`, `answerAt`). Where
   that session cannot be read from the caller (a hub's), the cut names the session as before. `read_session` shows
   at most 2,000 characters of a line's text; a longer line says which characters it shows (`shown`) and the read that
   goes on (`readOn`: the same call with `around` at the line's first seq and `offset`), and a read with `offset`
   shows up to 8,000 characters of that one line (`sessions/session-lines.ts`). `offset` is in no tool definition:
   the cut and the line spell out the call, as recall's hit does `around`. It also goes to a linked machine
   (`host.readSession`'s `offset`; a read from an offset always says what it shows). The cut used to send the caller
   to the session by name, and read_session cut every line at 2,000 characters of its JSON with no word of it, so
   the middle of a long answer could not be read back at all. **A read has a total, too (#1480)**: 40 lines of 2,000 characters
   were about 80,000 characters in one call, all read again on every later request of the reader. The lines of one call, notes
   included, come to at most `maxChars` (12,000 by default, brought to 2,000-40,000), and the first line always comes. A plain read
   fills from the newest line back; one around a spot, outward from it a side at a time; one `from` a line, forward. One line shows
   2,000 characters at the default and a sixth of `maxChars` above it, up to 8,000 (`lineCutOf`). When a side is left out a note
   line says how many lines and the call that reads on from where the read stopped: `before=<seq of the oldest line shown>` back, or
   `from=<seq of the first line not shown>` forward, so following it shows nothing twice (`around` centres, and showed half of it
   again). `tools` is `none` (tool calls left out, and the texts a call separated stay separate lines, so the end of a turn is a line of
   its own), `titles` (one line each, the default, `false`) or `full` (`true`). For a linked machine, `host.readSession` takes
   `maxChars`, `toolLines`, `before` and `from` (additive) and answers the
   `maxChars` it held. The hub bounds every answer itself (`fitMachineLines`): tool lines out for `none`, then the budget, keeping the
   lines nearest the spot of an `around` read (the machine centres its window on it) and the newest otherwise, a machine's own notes
   counted. A note's call repeats the `tools` (when not `titles`) and `maxChars` the reader gave, so
   following it reads the same way, and a read answered to a hub (`hubView`) adds that a hub from before `before` and `from` strips them from the call
   (its schema lacks them, so the newest lines would come back again): "the hub needs an update to read on", and `around=<seq>` reads near the same spot (`ReadOn`
   in `sessions/session-lines.ts`, #1487). **A session reads and recalls its handoff lineage (#1487)**: its predecessor by its newest handoff marker, that one's
   predecessor, and so on (`HandoffMarkers.lineage`, up to 12 generations), in the session archive too. A handoff stays inside a project: `createSession`
   takes `handoff.fromSessionId` only for a live session of the same project, and `lineage` ends at a marker naming a session of another project (the archived
   row's project is in its trash record, `projectOf`), so a marker written another way reads nothing of the archive. `recall` keeps a quarter of its limit
   for these hits, nearest predecessor first. `read_session` reads these and `recall` searches
   them (by their messages: the archive's search index is dropped, `searchSessions`), and nothing else of the archive; a session deleted for good takes its
   own marker with it and ends the chain. The lines are the predecessor's: `role: predecessor` for the assistant's words, `predecessor: <id>` on every
   line, an opening sentence in the answer, and in `recall` the label "(your predecessor, archived)" with `[predecessor]` in the snippet. The note's
   header lists the lineage ids (`lineageLine`; the record's header, and the first line of an agent's note) and stays the only thing handed over. Named files and folders inside the target project, resolved through symlinks, become
   readable to the caller for this host's lifetime (`readGrants`); the project root is never granted.
   A grant and each read are compared in one spelling (`canonicalPath`, `isInside` in `dev-services/path-guard.ts`,
   #428), so a short name, another case or a link to the root reads as the place it names.
   Outside paths are listed without grants. Claude checks grants on each read through `mayRead`;
   Codex's reads are already unrestricted.
   A turn that **completes** while the asked session's own background work (timers left out) still runs is a pause, as a
   `start_agent` child's is ([start-agent-steps.md](start-agent-steps.md) step 7, #1460; it used to come back as the final answer, with no report owed, so the
   result of the turn the work's ending started reached no one): the call answers `done` with the words so far and
   `paused` ("its turn ended while its own background work is still running (…); a final report follows when that work
   ends and a turn ends it; if it is a server or watcher it leaves running this answer may be the final one;
   `read_session`"), with no `agent_session stop`, which an asked session does not have. It is decided where the delegation's
   turn ends (`DelegationFlow.startDelegation`), whether or not a call is still waiting, so a turn that ends after the
   call's bound is paused too and the next call reads the pause. The report is marked owed and paused (`markReport` +
   `pauseReport`: the store's `report_marks` and `report_paused:<session>`, so a host swap keeps both and the next host
   delivers the final report once), and the rest is [start-agent-steps.md](start-agent-steps.md) step 7's: the report comes when a turn ends with that work gone,
   or `PAUSED_REPORT_SETTLE_MS` after the work ended with no turn, a turn the person starts there is theirs and not
   reported (#1377), and a new task from the same caller ends the pause. Like a child's, work the person left running there (a dev server) holds the
   report until it ends.

**Long work.** A call waits up to `ASK_WAIT_MS` (240 s), below the Codex MCP ceiling of 300 s and
bridge wait of 280 s. It then answers still working, naming the session and how to call again with
`project`, `session` and no task, and where the turn is (`progress`, #1186): how long the session has recorded
nothing and its last step (a tool call's title on one line, quoted as JSON), as start_agent's and agent_session's
`working` do; a session at work and one stuck read the same before. Without `session`, one outstanding call in that project is enough
to continue waiting, even if another session was opened meanwhile. Multiple outstanding tasks need
an explicit session. A new task cannot replace unfinished work in the same session.

Every bounded wait (ask_project's, start_agent's and agent_session's, a start request's, a handoff's) is one race,
`raceBound` in `timing.ts` (#428): the outcome, the bound, the call's cancellation (also one that came
before the wait) and the wait's own wakes. Unlike `withTimeout` it never rejects: the bound is an answer.

**Stop.** Stop on the caller reaches delegated work only while that caller is actually waiting
(`waiters > 0`), as for `start_agent`; after a bounded call returns still working, the target keeps
running. A send to a busy session is mail and starts no wait (§1.2.3). Its receipt watcher, other observers and report-back
continue until the input finishes. A task assigned to an idle target can still be interrupted while
the caller waits. An explicit Stop on the target remains available. A failed turn or deleting the
target returns an error naming the session. Deleting the caller drops the wait and grants while the
target keeps its turn. Tracked notes cannot report an intermediate turn's completion.

**Size.** Historical baseline before the optional session selector (#614). Measured like the reader set (haiku, `scripts/probe-reader-tools.mts`): `ask_project`
is 350 characters (`DELEGATE_BUDGET_CHARS` 400) and costs **+103 tokens** loaded (the set: +192 →
+295), +10 deferred. It is loaded: asked "Have the toolkit project export the sprites again, then
tell me where the files are", the model called it for that project 7 times in 10 loaded and 0 in 5
deferred — deferred, it searched past conversations and its own folder instead, the failure #320
measured for `recall`. A miss is an answer saying it has no such project, and the person can name
the tool. One of five unrelated how-to questions drew a call naming a project that does not exist
(refused, no card). The description says "a job", not "a task": the two read the same to the model
(7 in 10 each), and the guide, which lists every seat's tools, keeps no word of the removed
control rail's tasks (#372). Two other wordings did no better (0 and 3 in 5).

`packages/agent-host/scripts/smoke-delegation.mjs ask-project` runs it end to end on a temp store and data folder: a haiku session
in one scratch project has the other write a file with a number only it knows and reads it back
(`CALLER`/`CALLEE` = `claude` or `codex`).
