# Cards in a session another session gave work (#676)

A card a session raises (a question, an approval) goes to the sessions whose work it has open as well as to the person (owner decision
2026-10-14, the child-question rule of #561 option B). A turn belongs to no one (#1948): the rule reads the session's open tasks, not who started
its turn. The design, what it replaced and what a restart and an older build do are [plans/mailbox.md](../../plans/mailbox.md) §10.6.4.

- **Who is told** (`RoutedCards.routeCard`). Every sender of a task to the session that is delivered, not settled and not released
  (`openTaskParties`): `start_agent`, a `mail` send that is work (plans/mailbox.md §10.6.6), `ask_project`, `send_to_session` with `reportBack`, `create_session`'s first message
  with `reportBack`, the person's own work aside. Each is told once per card. A call of its own that waits on the session (`agent_session` wait,
  `start_agent` waiting, `ask_project` waiting) returns `asking` with the cards; otherwise a Centralu notice (`facts.card`) is its mail, shown
  in its conversation as from the session. Never the card's text: the question, its options and an approval's detail are the session's words,
  so the giver reads them as a **tool result** (`agent_session` status, or `read_session` for a directing seat), fenced as JSON (`cardsText`),
  not in the person's seat. A notice not given yet goes when its card does (answered, or its turn ended or stopped).
- **Answering** (`answerRoutedCard`). A question: `agent_session` `answer` (an ordinary session, also across projects for an `ask_project`
  target: only status and answer there) or `answer_question` (the Assistant; a rare command, so through `centralu_run` in the default tier; a
  coordinator only reads). `text` is the answer, one line per question, `;` between a multi-select's choices, or a JSON array; a choice naming
  an option is that option's label (`answersFrom`). The card stays in the session for the person; the first answer lands, a later one finds
  the card gone. A giver may answer only when it is the one party with work open there and the running turn is its work alone
  (`StopNotices.alone`: work it gave started the turn, not mail the mailbox delivered, and nothing of the person's, an app's or another
  session's entered it); otherwise it is told and only the person answers.
  An approval needs more, read at the answer (`refusal`, the rule of #603/#606): the giver's own preset is `auto` and it is not an app's
  agent, and the session is `normal` or `auto` and not an app's agent (owner decision: an `auto` assistant may approve for a `normal` session).
  A `safe` session's approvals stay the person's whoever gave it the work: the giver's `auto` never raises the session's permissions. Never a
  card the host raised in that session; "always" stays the person's.
- **Which card** (#679 review). The giver reads each card by a handle, `<request id>.<digest>`, the digest over the session's turn (the record
  row it began after) and what the card asks (`cardHandle`), and its answer must name that handle. An adapter numbers its requests again in a
  new process (`req-1`, …), so a request id alone could carry an answer meant for an earlier card onto a new one in the same session, or into
  a later turn; a handle that matches no standing card is refused, and the giver reads the card again. The notice's dedupe key carries the
  handle too, so a new card under a reused id is told.

## Requests to a busy session (#677)

A send to a session that cannot take it now (a `mail` send to a session the sender started, `ask_project` to an existing session, `send_to_session`) is a mail
task that reaches the session as a turn of its own once it is free (a task joins no running turn until #1948 step 3); the call answers
`mailed` with the task's id, and the turn's end is reported to the caller by mail. When it goes, the receiver's conversation shows it as the
sender's message, as a direct send does; the agent reads the mail frame. The rule, what it
replaced (the `note` / `queue` choices and the request queue) and what a restart and an older build do with it are
[plans/mailbox.md](../../plans/mailbox.md) §10.6.2 (#1948 step 2). A fork stays an explicit choice of a `mail` send to a session the caller started (since #1948, which took it from `agent_session`) and of `send_to_session`:

| `ifBusy` | What happens |
|---|---|
| `fork`, `fork_read` | A sub-session from a copy of A's conversation now (`forkFor`): the adapter's `forkConversation` (Claude: the SDK's `forkSession`, which writes the copy beside the original's transcript; Codex: `thread/fork`), resumed with its history on screen (`importHistory`). An adapter without it, a session with no conversation yet, and `ask_project` (which never creates a session in another project) are not offered a fork. start_agent's gates apply: the agent depth (#867), the project's trust (#382; #673's consent rule as `ensureAgentConsent` has it) and the per-project ceiling; once the card is answered the gates are read again and a place is taken before the copy is made (`reservePlace`), and the project losing trust withdraws a card still standing. Once the fork's session exists the gates and the lower of the two presets as they are now are read again with no wait before its delegation; a fork that fails them gets no task and goes to the session archive. The preset is the lowest of B's and A's. `fork` gets a worktree of its own (`agentWorktreeBranch`, branched from A's branch when A is a worktree session; a project with no git repository is refused and pointed at `fork_read`); `fork_read` is read-only work in A's folder under at most `safe`, so two agents never write one folder. Linked to B: `askedBy` B for a same-project ordinary session (the Assistant through the delegation alone), its turn B's delegation (the report, its cards), and `forkedFrom` A (`sessions.forked_from_session_id`, store v52), which the sidebar uses to hang it under A, ahead of `parentSessionId` and `askedBy` (`orderAsTree`, `foldGroupsHiding`). |

**Sizes.** `ifBusy` carries no words in any schema: the `mailed` answer names it. `ask_project` has none since #1948 step 2.
