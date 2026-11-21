# A session's request, the person's message it cites, and the orchestrator's judgement (#1739, replacing #1926's reply cards)

Proposed 2026-11-03, on the owner's decisions of that day (#1739's decision comment, and the owner's direction after the deep review of #1940;
#1933 closed unmerged). Revised 2026-11-21 on the owner's decision on #2411, which took the floor in code and the record out (§1, §2, §4,
§5, §7). [security-boundaries/mailbox-and-requests.md](../security-boundaries/mailbox-and-requests.md) ("A session asking the Assistant") and
[mailbox.md](mailbox.md) §7.6 describe the result.

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

The owner's decision on #2411 (2026-11-21) went the rest of the way: the floor in code goes too, and the safety of a request's turn is the
orchestrator's judgement alone. The floor's rules kept raising cards on harmless steps: a read-only `cat` in a request's turn raised the
person's card, because a shell command is never parsed to prove it only reads, and the list of the CLI's own read tools fitted one CLI only. The
owner prefers judgement by intent: the orchestrator checks each request against what the person wants and the asking session's own project and
purpose (§2). The owner also weighed a ceiling at the asking session's preset and chose the instruction alone: with every session on `auto`, the
ceiling would bind nothing. **The trade-off, recorded:** a `safe` or `normal` session, or an app, can have the orchestrator take a step it could
not take itself; only the orchestrator's judgement stands in the way.

## 2. The rules

1. **Every request wakes the orchestrator**, as before, cited or not. Nothing is rerouted.
2. **A citation is evidence, checked by the host.** `mail send` (or `reply`) to the orchestrator with `cite: true` names the person's newest
   message in the asking session's own conversation. The host checks it in code (§3). The request's header in `mail read` then says, in
   Centralu's words, that it cites the person's message *seq* of that session, verified, typed *n* ago, quotes that message, and says to judge
   from it and around it (`read_session` `around`) what the person wants. A request with no citation, or one that failed the check, says it
   cites nothing the person wrote: these are the session's words only.
3. **The judgement asked of the orchestrator rides with the words.** On its own line under those, before the quoted words, the header
   carries `JUDGE_REQUEST` (`mail/tool.ts`, the one copy of its wording): check the request adversarially against what the person wants
   and the asking session's own project and purpose; take only the steps that fit and refuse the rest in the thread, saying why; ask the
   person by mail (kind `question`) when unsure or before a step that cannot be undone; nothing else checks the steps it takes for the
   request. It is shown only where the words are (the request's own turn), so it costs one tool result per request read, not every model call;
   the orchestrator's role line says only to read a request with the mail command, judge it as its header says, and answer in its thread.
   The owner's 11-04 rule, that the person steps in where intent is unclear or a step cannot be undone, is this instruction's.
4. **No floor of the request's own.** In a request's turn the orchestrator's steps run as in the person's own turn, whatever tool it runs on:
   its preset decides the CLI's own steps (a command, a file written, a page fetched), and each Centralu command's own card asks as it does
   there (a delete, a trust, a project added, a machine's change, an app removed, an update: the cards that ask in every preset still do).
   No step is classified, none raises a card naming the asking session, and work that goes on after the turn (a subagent, a scheduled
   prompt, a background command) is not refused: a subagent gets the prompt the orchestrator wrote after judging, as `start_agent` does. A
   list of Centralu's commands that cannot be undone would not be a coherent line either: a shell `rm` was never on it.
5. **No record in the asking session** (§5).

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

**Anything the orchestrator does in the person's own turn** (§2 rule 4). Work handed on goes where the orchestrator judges, to a session under
any preset; a session `create_session` makes gets the project's default within the orchestrator's own preset (`createdPreset`), not the
asking session's. A worker it starts runs under its own preset.

**Reads.** The reads of a request's turn are free, and the answer goes back to the asker, so the orchestrator can pass on what it read. What
that adds is narrow. A trusted project's ordinary session already reads every session but an orchestrator's, on this computer and the linked
machines (#984, #1941), and under a bypass or `auto` preset it reads files with its own shell. What the orchestrator reads that such an asker
cannot: the orchestrator's own conversation (a brief, message or mail it sent another session is not part of it: that lands in the
receiving session's conversation and is read with it, its own agents' included), and files the asker's stricter preset would ask about. For an asker in an untrusted project, anything outside its own project; but its requests are held until the person
trusts the project, so its request turn comes only once it is trusted.

That is the risk, named: a session that read hostile content can talk the orchestrator into any step it takes in the person's own turn, or
into reading those few things and passing them back. The orchestrator's judgement is what stands against it, with the citation as evidence of
what the person asked for and the instruction in the header (§2 rule 3); the cards a step raises itself ask as in the person's own turn. The
earlier designs of this pull request (no turn without a citation, then a read gate on the cited path) were dropped for this by the owner, and
#2411 dropped the floor and the record.

## 5. The record (dropped by #2411)

No notice is left in the asking session. The person reads every step in the orchestrator's own conversation, and the asking session is told
when the turn ends (mailbox.md §7.6, S12). A notice per step needed every step caught on its way (Centralu's tools, an app's, and a hook in
front of the CLI's own), a list of the CLI's own read tools outside `adapters/` so reads were not recorded, and it existed on Claude only.

## 6. Older builds and swaps

- `byPerson` is one more key in a transcript row's payload, and `cites` one more key in `mail.facts` (`MailFacts` is loose): an older build
  reads past both. Nothing is migrated.
- An older build serving the mail tool drops `cite` from the direct tool (its schema is loose), so the request reaches this build uncited,
  which the header says. Through `centralu_run`, which parses the arguments strictly (`orchestrator-tools.ts`), it refuses the call with
  `Wrong arguments`: nothing is sent, which fails safe.
- An older build serving a request's turn still has its own cards, which are stricter than this build's turn, never looser.
- Rows an older build wrote have no `byPerson`, so a message the person typed under it cannot be cited.
- Capabilities keep the optional `gatesSteps` field an older host sends; nothing reads it, and removing a field is a version increment
  (protocol.md §4). The mail refusal word `assistant_asks` is no longer sent.

## 7. What goes

With #1739: `sessions/asked-reach.ts` and the gate's read tracking, the reply cards, and the host's card for a read the CLI asks about.
With #2411: `sessions/asked-acts.ts` (the lists `READS`, `UNDOABLE`, `HANDS_ON`, `CANNOT_BE_UNDONE`, `OUTLIVES_THE_TURN`), `sessions/asked-gate.ts`,
`adapters/claude/request-hook.ts` (the `PreToolUse` and `PostToolUse` hooks), `mail/asked-by.ts`, the adapters' `requestTurn` option, the
tools' `whenAsked`, `HostCards.cover`, the `request record` notice, the asking session's cap on `createdPreset`, and the `assistant_asks`
refusal, so an Assistant on any tool takes requests (#1530, a gate for a Codex Assistant's steps, has nothing left to gate).

## 8. Not in this change

- #1739's step 3: the project session starting the session on the linked machine itself, so its reports come back to it.
- A reply in a thread waking the session that waits on it; Codex sessions missing the Centralu-first guidance (#1739, "Also seen").
- The instruction's wording (§2 rule 3) and every visible text the pull request lists: the owner's.
