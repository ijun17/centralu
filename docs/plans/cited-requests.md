# A session's request on the person's word (#1739, replacing #1926's reply cards)

Proposed 2026-11-03, on the owner's decisions of that day (#1739's decision comment; #1933 closed unmerged). This is
the design section the change is built from. [security-boundaries.md](../security-boundaries.md) ("A session asking
the orchestrator") and [mailbox.md](mailbox.md) §7.6 describe the result.

## 1. Why

A session asks the orchestrator by mail (`mail send to: "orchestrator"`, a *request*, mailbox §7.6). Until now each
step the orchestrator took in a request's turn raised the person's card (#1447), and once the orchestrator's
conversation had read anything the asker could not read itself, every word it wrote back raised one too (#1926's
"reply card"). Two facts changed what that guards:

- Since #984 a session of a trusted project already reads every project's ordinary sessions, and a request from an
  untrusted project is held until the person trusts it. Most of what a reply card held back the asker could read.
- The reply cards came on nearly every reply (the orchestrator reads widely; after a restart it counted as having
  read everything), the person could not tell what they approved, and after two Denies the orchestrator stopped
  answering that session at all. The request cards asked again what the person had just told the session (#1739's
  run: three cards for one "set it up on the laptop").

The owner wants the cards gone and the safety built in: the same behaviour in less code.

## 2. The rules

What stays out of an asker's reach: the conversations of the orchestrator, of coordinators and of app sessions; files
outside its folders; Centralu's settings; machine details.

1. **On the person's word.** A request may cite the person's message: `mail send` (or `reply`) with `cite: true`
   names the person's newest message in the asking session's own conversation. The host checks it in code (§3). If the
   check passes, Centralu, not the session, tells the orchestrator in the request's header that the person wrote
   message *seq* in that session *n* minutes ago, and the orchestrator reads around it (`read_session` `around`)
   to judge whether it covers the request. In that turn the orchestrator works as in the person's own turn:
   - **Reversible steps run with no card**: `add_project` (registering an existing folder, here or on a linked
     machine) and `create_session` (starting a session, here or on a linked machine). The cards these steps raise
     themselves (`project_add`) are covered by the person's word for that call (`HostCards.cover`), as an Allow
     covered them before. Each leaves a record in the asking session (§5).
   - **Every other step that changes something** keeps the request card it raised before, Allow or Deny under every
     preset (`alwaysAsk`): a delete, an overwrite, a clone, a command, a file written, an OS permission, a message to
     another session, an agent started. The list of reversible steps is two names, so a step added later asks
     until someone lists it.
   - Reading and answering in the request's thread are free, as in the person's own turn. The orchestrator judges
     what the person's message covers, its answer included (owner: the orchestrator judges scope).
   - A step that outlives the turn (a subagent, a scheduled prompt, a background command) is refused, as before.
2. **Without it.** A request with no citation, or one whose check fails, is the session's own idea. It does not go to
   the orchestrator: the host sends it to the person instead (the same message, mail to the person, so it is one item
   in their Inbox and no card), and the sender's result says so at once, with the reason, and that it can do itself
   what it reaches and that anything more is the person's. A request that reaches the orchestrator uncited anyway (one
   an older build stored during a swap, one moved from a v61 thread, a reminder's turn) gets a turn where nothing
   leaves it: every step that changes something is refused, and so is every word to a session, the asker's thread
   included. Reading, marking it handled and mail to the person stay free.

## 3. The check (`personSaid`, `MessageService.send`)

All in one store transaction at send:

| Check | How |
|---|---|
| The message exists and the person wrote it | The newest transcript row of the asking session that is `role: user`, `kind: text`, with `byPerson: true` in its payload and none of `from`, `fromApp`, `fromScript`. `byPerson` is new: written only on the composer's path (`fromPerson`, `rpc.ts` `agents.send` without the limited credential). A row with no mark reads as the person's elsewhere (`authorOf`), so it is not enough here: a CLI transcript caught up or imported, an app's `sendError`, a first prompt, a hub's text all have none. Rows an older build wrote have none, so they never pass (fail closed) |
| It is in the asking session's conversation | The host looks only there: a session cannot name another session's message or a seq of its choosing |
| It is recent | `ts` within 30 minutes of the send (owner's bound, `CITE_MS`) |
| It is used once | The request is stored with `dedupe_key = cite:<seq>`; `mail` has `UNIQUE(sender, dedupe_key)`, so a second request of the same sender citing the same message is found before insert and goes the way of rule 2. Retention keeps a message 30 days at least, far past 30 minutes, so the key outlives the window; it is in the store, so a restart or a swap keeps it |

A cited request stores `facts.cites = { seq, at }` (Centralu writes facts; a session cannot). The turn's asker
(`askedBy`) reads it from the turn's work message, so the gate knows the turn is on the person's word. The window is
checked at send only: a cited request queued behind a long turn of the orchestrator, or held for an untrusted project
until the person trusts it, keeps its citation.

## 4. What an asker can be handed (item 3 of the brief)

The question was the least-code way that nothing out of the asker's reach reaches it without the person's word.

| Option | Safe by construction | Code | Tokens per request |
|---|---|---|---|
| Keep the orchestrator's conversation, narrow what it reads in a request's turn | No: the conversation already holds the person's talk with the orchestrator and every earlier read; only a gate on its words stops them, and that gate is the reply card being removed | small | the orchestrator's whole context, read again on every call of the turn (cached reads of tens of thousands of tokens each), and the request stays in that context |
| A fresh one-off conversation per request, with the asker's reach | Yes | large: the host has one process and one conversation per session (`handles`), and one orchestrator by kind (`orchestratorId`); a second conversation is a new kind of session, its process, its turn, its events and its end | a fresh system prompt and tool list (cached) per request, and a process start |
| **No orchestrator turn without the person's word** (chosen) | Yes | negative: the read-scope memory and the reply cards go, and nothing is added for them | none for an uncited request |

The chosen option is the second one taken to its end. A conversation that never had the orchestrator's history and
has exactly the asker's reach has the asker's own tools and data; it lacks only the orchestrator's privileges, which
rule 2 does not use. The asker's own conversation is that conversation, and it exists already. So an uncited request
costs no turn: the asker is told at once what it can do itself, and the person gets the request. A cited request is
answered in the orchestrator's own conversation, because the person's word is there and the orchestrator acts on it as
in the person's own turn.

What this changes beyond the owner's rules, named for the review: a session's question to the orchestrator with no
citation ("which session handles X?") is answered by nobody but the person. A trusted asker reads the sessions itself;
what it cannot read is what the orchestrator was not to pass on.

## 5. The record of a step done on the person's word (the owner's call)

Proposed: a notice in the asking session's conversation, where the person wrote the message, from Centralu, label
`on your word`:

> On your message from 4 min ago ("set it up on the laptop, register the …"), the orchestrator ran add_project
> {"path":"…","machine":"…"} for this session's request without asking you again.

Other places the owner may prefer: the orchestrator's own conversation; the person's Inbox (one item per step); a
mark on the cited message itself (needs a UI change).

## 6. Older builds and swaps

- `byPerson` is one more key in a transcript row's payload, and `cites` one more key in `mail.facts` (`MailFacts` is
  loose): an older build reads past both. Nothing is migrated.
- An older build serving the mail tool stores an uncited request for the orchestrator as before. This build gives it
  the turn where nothing leaves (rule 2).
- An older build serving a request's turn still has its own cards (the reply card included): no silent pass.
- Rows an older build wrote have no `byPerson`, so a message the person typed under it cannot be cited: rule 2.

## 7. What goes

`sessions/asked-reach.ts` and its tests; the gate's read tracking (`reads`, `begun`, `noteRead`, `readIn`,
`beginConversation`, `seen`); the "every word after an out-of-reach read" rule (`afterRead`, `reached`); the host's card
for a read the CLI asks about in a request's turn (`askCliRead`, `requestRead`: a cited turn is the person's own); the
`newConversation` and `seen` wiring.

## 8. Not in this change

- #1739's step 3: the project session starting the session on the linked machine itself, so its reports come back to
  it. Later pull request.
- A reply in a thread waking the session that waits on it; Codex sessions missing the Centralu-first guidance
  (#1739, "Also seen").
- The record's wording and place (§5) and every visible text the pull request lists: the owner's.
