# Cards in a delegated turn (#676)

When a session works on a turn another session gave it, the cards it raises in that turn go to that session as
well as to the person (owner decision 2026-10-14, the child-question rule of #561 option B, scoped tightly). The turn
is **delegated** when another session's work starts it: `ask_project` into a session at rest, `start_agent`, an
`agent_session` send that starts a turn, `send_to_session` to a session at rest, and `create_session`'s first
message (#1233). Mail that joins a turn already running (the person's, or someone else's; never a task, plans/mailbox.md
§10.6.2) gives no one that turn, and answers no one's task by itself: a task is answered by its reply or the last response (#1233, plans/mailbox.md §10.6.3).

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

A send to a session that cannot take it now (`agent_session` send, `ask_project` to an existing session, `send_to_session`) is a mail
task that reaches the session as a turn of its own once it is free (a task joins no running turn until #1948 step 3); the call answers
`mailed` with the task's id, and the turn's end is reported to the caller by mail. When it goes, the receiver's conversation shows it as the
sender's message, as a direct send does; the agent reads the mail frame. The rule, what it
replaced (the `note` / `queue` choices and the request queue) and what a restart and an older build do with it are
[plans/mailbox.md](../../plans/mailbox.md) §10.6.2 (#1948 step 2). A fork stays an explicit choice of `agent_session` and `send_to_session`:

| `ifBusy` | What happens |
|---|---|
| `fork`, `fork_read` | A sub-session from a copy of A's conversation now (`forkFor`): the adapter's `forkConversation` (Claude: the SDK's `forkSession`, which writes the copy beside the original's transcript; Codex: `thread/fork`), resumed with its history on screen (`importHistory`). An adapter without it, a session with no conversation yet, and `ask_project` (which never creates a session in another project) are not offered a fork. start_agent's gates apply: the agent depth (#867), the project's trust (#382; #673's consent rule as `ensureAgentConsent` has it) and the per-project ceiling; once the card is answered the gates are read again and a place is taken before the copy is made (`reservePlace`), and the project losing trust withdraws a card still standing. Once the fork's session exists the gates and the lower of the two presets as they are now are read again with no wait before its delegation; a fork that fails them gets no task and goes to the session archive. The preset is the lowest of B's and A's. `fork` gets a worktree of its own (`agentWorktreeBranch`, branched from A's branch when A is a worktree session; a project with no git repository is refused and pointed at `fork_read`); `fork_read` is read-only work in A's folder under at most `safe`, so two agents never write one folder. Linked to B: `askedBy` B for a same-project ordinary session (the Assistant through the delegation alone), its turn B's delegation (the report, its cards), and `forkedFrom` A (`sessions.forked_from_session_id`, store v52), which the sidebar uses to hang it under A, ahead of `parentSessionId` and `askedBy` (`orderAsTree`, `foldGroupsHiding`). |

**Sizes.** `ifBusy` carries no words in any schema: the `mailed` answer names it. `ask_project` has none since #1948 step 2.
