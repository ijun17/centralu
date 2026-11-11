# Cards in a delegated turn (#676)

When a session works on a turn another session gave it, the cards it raises in that turn go to that session as
well as to the person (owner decision 2026-10-14, the child-question rule of #561 option B, scoped tightly). The turn
is **delegated** when another session's work starts it: `ask_project` into a session at rest, `start_agent`, an
`agent_session` send that starts a turn, `send_to_session` to a session at rest, and `create_session`'s first
message (#1233). A task or note that joins a turn already running (the person's, or someone else's) gives no one that
turn, and never clears a report mark someone is owed of it (#1233, `domain-model.md` Report mark).

- **The link** (`turnOwners`, `ownTurn` / `releaseTurn`): session → the session that gave it the turn. It ends with
  the delegation's outcome (`startDelegation`), or with the turn for `send_to_session` and `create_session`. A card from a later turn the
  person starts there never goes to the caller. Written to `delegated_turns` (store v51) as well as kept in memory:
  the next host restores the links of the sessions whose cut turn it continues after an update, ending each with
  that turn; any other row is dropped. The continued turn may ask its caller again; `told_cards` stops a second
  notice for a card already told.
- **Delivery** (`routeCard`). A wait of the caller on that turn (`agent_session` wait, `start_agent` waiting,
  `ask_project` waiting) returns `asking` with the cards. With no wait, one notice goes into the caller's
  conversation, marked as from the session, as a report is (`tellCardRaised`): host-written words naming the
  session's id and the call that reads the card. Never the card's text: the question, its options and an approval's
  detail are the target's words, so the caller reads them as a **tool result** (`agent_session` status, or
  `read_session` for a directing seat), fenced as JSON (`cardsText`), not in the person's seat.
- **Answering** (`answerRoutedCard`). A question: `agent_session` `answer` (an ordinary session, also across
  projects for an `ask_project` target: only status and answer there) or `answer_question` (the Assistant; a rare
  command, so through `centralu_run` in the default tier; a coordinator only reads). `text` is the answer, one line
  per question, `;` between a multi-select's choices, or a JSON array; a choice naming an option is that option's
  label (`answersFrom`). The card stays in the session for the person; the first answer lands, a later one finds the
  card gone. An approval: the caller is told, and may allow or deny only when **both** hold at the answer
  (`answersApproval`, the rule of #603/#606): the caller's own preset is `auto` and it is not an app's agent, and the
  session running the turn is `normal` or `auto` and not an app's agent (owner decision: an `auto` assistant may
  approve for a `normal` session). A `safe` session's approvals stay the person's whoever gave it the work: the
  caller's `auto` never raises the target's permissions. Never a card the host raised in that session; "always" stays
  the person's.
- **Which card** (#679 review). The caller reads each card by a handle, `<request id>.<digest>`, the digest over the
  delegated turn (`turnId`, stored with the link) and what the card asks (`cardHandle`), and its answer must name
  that handle. An adapter numbers its requests again in a new process (`req-1`, …), so a request id alone could carry
  an answer meant for an earlier card onto a new one in the same session, or into a later turn; a handle that matches
  no standing card is refused, and the caller reads the card again. `told_cards` keeps handles too, so a new card
  under a reused id is told.

## Requests to a busy session (#677)

When session B asks session A for work (`agent_session` send, `ask_project` to an existing session, `send_to_session`)
while A runs a turn that is not B's (the person's, another session's delegation, an app's), or while requests are
queued ahead, Centralu does not decide for B (owner decision 2026-10-14). The request tool returns `busy` with the
choices, each marked available or not and why (`busyChoices`), and sends nothing; B calls again with `ifBusy`, or
passes it up front. The answer also says where A's turn is and how many requests are queued there already (`progress`,
`ahead`, #1186), so B can choose knowing what it waits behind. Queueing by default, as #1186 proposed, is not done:
the owner's decision above leaves the choice to B. B's own running turn there is not busy for B: a note into its own work goes on as before. Messages
the person sends are unchanged. The answer says which choice ran and its handle.

| `ifBusy` | What happens |
|---|---|
| `note` | Today's mid-turn note (#594/#606/#653): only when B's own preset is `auto`, and only on a CLI that takes input mid-turn (`send_to_session` sends as before). The turn's answer stays its owner's; B reads the reply to its note on its own reader. Not into another caller's `ask_project` task. |
| `queue` | Held (`queued`, `enqueue`) and delivered as a new turn B owns when A's running turn ends (`drainQueue`, from the turn's end and the boundaries that free a session): B's delegation for `agent_session` and `ask_project`, its turn for `send_to_session`, each framed as that tool frames its work, with the report when it ends and its cards ([Cards in a delegated turn](#cards-in-a-delegated-turn-676)). One at a time, oldest first. The answer is a handle (`qr-…`) and the place in the queue; `agent_session` status (or `ask_project` with no task) says where it stands, `stop` withdraws it. Written to `queued_requests` (store v52): a leaving host delivers nothing (`disposing`), and the next host delivers a request when the session's turn ends there (a cut turn it continues), or soon after start for a session at rest, so its input never starts a second process. A request whose session or requester is gone is dropped, as are those of an archived session. Before it goes in, the request tool's gates are read again with the requester's preset as it is then (`queuedGateError`): for ask_project its trust and depth, the target project, and the pair's remembered consent when only `auto` let the request pass without one (`openedByAuto`, stored as `queued_requests.opened_by_auto`, store v54, so a swap keeps it; a row an older build wrote is read as marked when the pair has no remembered consent); for agent_session the ownership a requester that is not `auto` needs and the preset rule. A request that fails them is dropped with its requester told. A requester moved off `auto`, or handing off to a successor that is not `auto` (`moveChildren`, the original is told), drops at once what only `auto` let through (`dropOpenedByAuto`: a marked ask whose pair still has no remembered consent, a send to a session it did not start); one being delivered at that moment is left to the delivery gate, which reads the stored mark if a swap delivers it again. Its caller's project losing trust or being removed, and the person revoking the pair, withdraw queued `ask_project` requests the same way (`withdrawReaches`); trust and a revoked pair leave an `auto` requester's requests, which the delivery gate reads again. **Delivery** (#684 review): one drain per session at a time (`delivering`), which reserves the session before its first await, so waking a sleeping session counts as busy and lets no second request in; the request stays first in the queue and its row stays, marked `delivering_at`, until the session's turn actually starts, and only then is it taken off. A swap or crash in between leaves the row, and the next host delivers it again: at least once, with one duplicate possible when the old process took the input without a word before the swap. A deferred restart is not waited out by the drain (`deliver` waits for it), and its end schedules the drain again. A row being delivered is left out of `withdrawReaches` and `dropOpenedByAuto`, so its gate (`queuedGateError`, for every tool) is read once more after that wait and any wake, before the task is written (`stillAllowed`). A remembered pair consent revoked in that window does not stop it: being delivered counts as running, as a delegation already running is left to finish (`revokeProjectConsent`). A retry of the same request (requester, tool and words) returns the handle already held instead of a second entry. |
| `fork`, `fork_read` | A sub-session from a copy of A's conversation now (`forkFor`): the adapter's `forkConversation` (Claude: the SDK's `forkSession`, which writes the copy beside the original's transcript; Codex: `thread/fork`), resumed with its history on screen (`importHistory`). An adapter without it, a session with no conversation yet, and `ask_project` (which never creates a session in another project) are not offered a fork. start_agent's gates apply: the agent depth (#867), the project's trust (#382; #673's consent rule as `ensureAgentConsent` has it) and the per-project ceiling; once the card is answered the gates are read again and a place is taken before the copy is made (`reservePlace`), and the project losing trust withdraws a card still standing. Once the fork's session exists the gates and the lower of the two presets as they are now are read again with no wait before its delegation; a fork that fails them gets no task and goes to the session archive. The preset is the lowest of B's and A's. `fork` gets a worktree of its own (`agentWorktreeBranch`, branched from A's branch when A is a worktree session; a project with no git repository is refused and pointed at `fork_read`); `fork_read` is read-only work in A's folder under at most `safe`, so two agents never write one folder. Linked to B: `askedBy` B for a same-project ordinary session (the Assistant through the delegation alone), its turn B's delegation (the report, its cards), and `forkedFrom` A (`sessions.forked_from_session_id`, store v52), which the sidebar uses to hang it under A, ahead of `parentSessionId` and `askedBy` (`orderAsTree`, `foldGroupsHiding`). |

**Sizes.** `ifBusy` carries no words in any schema: the `busy` answer names it and its values. `ask_project`'s is a
bare string (the enum would put the reader's Claude request over its 2,300), and the runner refuses other values;
`DELEGATE_BUDGET_CHARS` rises from 400 to 450, `AGENT_BUDGET_CHARS` from 1,000 to 1,100 (the agent set is 1,060 with
#676's `answer` and `card`), and the scoped seat's from 2,350 to 2,400 for `send_to_session`'s.
