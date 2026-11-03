# A session's request, the person's message it cites, and the orchestrator's judgement (#1739, replacing #1926's reply cards)

Proposed 2026-11-03, on the owner's decisions of that day (#1739's decision comment, and the owner's direction after the deep review of #1940;
#1933 closed unmerged). [security-boundaries.md](../security-boundaries.md) ("A session asking the orchestrator") and [mailbox.md](mailbox.md)
§7.6 describe the result.

## 1. Why

A session asks the orchestrator by mail (`mail send to: "orchestrator"`, a *request*, mailbox §7.6). Until now each step the orchestrator
took in a request's turn raised the person's card (#1447), and once the orchestrator's conversation had read anything the asker could not read
itself, every word it wrote back raised one too (#1926's "reply card"). The cards came on nearly every reply, the person could not tell what
they approved, and after two Denies the orchestrator stopped answering that session; the request cards asked again what the person had just told
the session (#1739's run: three cards for one "set it up on the laptop").

The owner's direction: keep anything from going to the person as far as possible. What matters is what the person intends, and only the
orchestrator can judge that; Centralu cannot block it deterministically. So the request path's safety is the orchestrator's judgement, one floor
in code, and a record the person can read afterwards. And a request's turn is never looser than the person's own: it drops only the request's
own card, for a step that can be undone, and never answers a card the step raises itself (the second deep review of #1940).

## 2. The rules

1. **Every request wakes the orchestrator**, as before, cited or not. Nothing is rerouted.
2. **A citation is evidence, checked by the host.** `mail send` (or `reply`) to the orchestrator with `cite: true` names the person's newest
   message in the asking session's own conversation. The host checks it in code (§3). The request's header in `mail read` then says, in
   Centralu's words, that it cites the person's message *seq* of that session, verified, typed *n* ago, quotes that message, and says to judge
   from it and around it (`read_session` `around`) what the person wants. A request with no citation, or one that failed the check, says it
   cites nothing the person wrote: these are the session's words only. The orchestrator's instructions say to do only what the person's message
   covers.
3. **The floor, listed the safe way round.** The steps that can be undone are listed (`UNDOABLE` in `sessions/asked-acts.ts`, each with its
   way back): a project added or made, an app made, a machine added, disconnected or reconnected, a trust or a setting changed, a session
   renamed or brought back from the archive, an app attached, detached, shared, restarted or checked, a proposal, a remembered answer taken
   away. These run in a request's turn without the request's card, cited or not; the cards they raise themselves ask as they do in the
   person's own turn (the trust card, the project's card, the machine's card, the settings that ask), under the orchestrator's own preset.
   Work handed on to a session runs without the request's card only within the asking session's own reach (§4). Every other step raises the
   person's card first, under every preset (`alwaysAsk`): a delete, an archive's steps removed, a machine installed, removed, uninstalled,
   rolled back or set to start with the OS, an app removed or put back to an older version, agent versions applied, background work cleared,
   an update installed or applied, an answer to a session's card given for the person, a subagent of the orchestrator's own, another
   project's session asked, a handoff, every step of the CLI's own that is not a read (a command, a file written or edited), of another MCP
   server's and of an app's, and every command no list names: a command added later asks until someone lists it (`asked-acts.test.ts` holds
   every tool and command definition to exactly one list). The person's Allow on that card covers the cards the same call raises itself, so
   one step is one card. A step that would outlive the turn (a subagent, a scheduled prompt, a background command, a workflow, a monitor) is
   refused, as before.
4. **The record.** Every step that changed something in a request's turn, cited or not, leaves a notice in the asking session once it has run
   and not failed, where the person reads it: what was done, and on which message of theirs, or that the request cited none (§5).

## 3. The check (`personWord`, `MessageService.send`)

In the send's own transaction:

| Check | How |
|---|---|
| The person sent it | The newest transcript row of the asking session that is `role: user`, `kind: text`, with `byPerson: true` in its payload and none of `from`, `fromApp`, `fromScript`. `byPerson` is written only on the window's path (`fromPerson`, `rpc.ts` `agents.send` on the full credential): what the person typed in the composer, and two fixed texts the window sends when the person clicks for them, the handoff prompt (`ui/store/sessions/handoff.ts`) and the Continue button's text (`SessionNotes.tsx`). Those are the person's clicks, not their words, and the header quotes the text, so the orchestrator sees which it is. A row with no mark reads as the person's elsewhere (`authorOf`), so that is not enough here: a caught-up CLI transcript, an app's text, a first prompt and a hub's text have none. Rows an older build wrote have none, so they never pass |
| It is in the asking session's conversation | The host looks only there: a session cannot name another session's message or a seq of its choosing |
| It is recent, and not from the future | `ts` at most 30 minutes before the send (owner's bound, `CITE_MS`), and not after it (a clock set back) |
| It is used once | The request is stored with `dedupe_key = cite:<seq>`; `mail` has `UNIQUE(sender, dedupe_key)`, so a second request of the same sender citing the same message is found before insert. Retention keeps a message 30 days at least, far past 30 minutes; it is in the store, so a restart or a swap keeps it |

A request that passes stores `facts.cites = { seq, at }` (Centralu writes facts; a session cannot). A request whose citation fails is sent
all the same, with no `cites`, and the sender's result says why. The 5-an-hour limit on requests is unchanged.

## 4. What an asker can be handed

**Work handed on.** The floor covers the orchestrator's own steps; a worker it starts runs under its own preset, as one the asker started
itself would. So work handed on in a request's turn runs without the request's card only where the asking session could have handed it on
itself with no card (`AskedGateHost.inReach`, `sessions/manager.ts`):

| The orchestrator's step | Without the request's card when | What the asking session itself could do |
|---|---|---|
| `create_session` | in the asking session's own project on this computer, the new session's preset (`normal` at most, never above the orchestrator's: `createdPreset`) no looser than the asking session's, and the asking session would start an agent there with no card (`AgentConsents.startsWithoutCard`: a remembered consent, the project's trust under `normal` or `edits`, or `auto`) | `start_agent` there: its child runs under the asking session's own preset (`start-agent-flow.ts`), behind the same consent |
| `send_to_session`, `agent_session` `send` | to a worker of the asking session's own project on this computer, under no looser preset than the asking session's | `agent_session` `send` gives work only to a session no looser than itself (`agent-session-actions.ts`) |
| `mail` `send` | to a session of the asking session's own project on this computer | `mail` there itself; the recipient acts under its own preset |

Anywhere else (another project, a linked machine, a session under a looser preset, a name the host cannot resolve) it asks: there the asking
session would have met a consent card, or could not have done it at all. `start_agent` (its child runs under the orchestrator's own preset, in
the orchestrator's place), `ask_project`, `handoff_session`, `answer_question` and `agent_session` `stop`, `delete` and `answer` always ask.

**Reads.** The reads of a request's turn are free, and the answer goes back to the asker, so the orchestrator can pass on what it read. What
that adds is narrow. Under #984 a trusted project's ordinary session already reads every project's ordinary sessions, on this computer and the linked
machines, and under a bypass or `auto` preset it reads files with its own shell. What the orchestrator reads that such an asker cannot: the
orchestrator's own conversation, coordinators' and app sessions' conversations, sessions with no project, and files the asker's stricter
preset would ask about. For an asker in an untrusted project, anything outside its own project; but its requests are held until the person
trusts the project, so its request turn comes only once it is trusted.

That is the residual risk, named: a session that read hostile content can talk the orchestrator into reversible steps, or into reading
those few things and passing them back. The floor covers the orchestrator's own steps; a worker it starts runs under its own preset, as one
the asker started itself would. The orchestrator's judgement is what stands against it, with the citation as evidence of what the
person asked for, the floor for what cannot be undone, and the record for the person to see afterwards. The earlier designs of this pull
request (no turn without a citation, then a read gate on the cited path) were dropped for this by the owner.

## 5. The record (the owner's call: wording and place)

A notice in the asking session, from Centralu, label `request record`:

> On your message from 4 min ago ("set it up on the laptop, register the …"), the orchestrator did this for this session's request: run add_project {"path":"…","machine":"…"}

> For this session's request, which cites no message of yours, the orchestrator did this: run add_project {"path":"…"}

It is written once the step has run and not failed: a Centralu or app step when its result comes back, a step of the CLI's own when the
CLI says it ran (`PostToolUse`; a failed one, a command that exits non-zero included, gets `PostToolUseFailure` instead: measured with the real CLI). A step the person
allowed on a card is recorded too. A read, an answer in the thread, and a step that failed or was refused are not. Other places the owner
may prefer: the orchestrator's own conversation; the person's Inbox; a mark on the cited message (needs a UI change).

## 6. Older builds and swaps

- `byPerson` is one more key in a transcript row's payload, and `cites` one more key in `mail.facts` (`MailFacts` is loose): an older build
  reads past both. Nothing is migrated.
- An older build serving the mail tool drops `cite` from the direct tool (its schema is loose), so the request reaches this build uncited,
  which the header says. Through `centralu_run`, which parses the arguments strictly (`orchestrator-tools.ts`), it refuses the call with
  `Wrong arguments`: nothing is sent, which fails safe.
- An older build serving a request's turn still has its own cards: no silent pass.
- Rows an older build wrote have no `byPerson`, so a message the person typed under it cannot be cited.

## 7. What goes

`sessions/asked-reach.ts` and its tests; the gate's read tracking (`reads`, `begun`, `noteRead`, `readIn`, `beginConversation`, `seen`); the reply
cards (`afterRead`, `reached`); the request card for steps that can be undone and for work handed on within the asker's reach; the host's card
for a read the CLI asks about in a request's turn (`askCliRead`, `RequestTurn.askRead`, `requestRead`: the CLI's own card stands, as in the
person's own turn); the `newConversation` and `seen` wiring. Kept: `HostCards.cover`, now only behind the person's Allow on a request card.

## 8. Not in this change

- #1739's step 3: the project session starting the session on the linked machine itself, so its reports come back to it.
- A reply in a thread waking the session that waits on it; Codex sessions missing the Centralu-first guidance (#1739, "Also seen").
- The record's wording and place (§5) and every visible text the pull request lists: the owner's.
