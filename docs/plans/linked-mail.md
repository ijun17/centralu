# Mail across linked machines (#2067)

Every session reaches every other session by mail, across linked machines too (owner decision, 2026-11-08). Today
mail stops at a link: a child a hub session started on a linked machine (`fromHub`) cannot mail its parent, and a hub
session's mail to that child is refused `elsewhere` (slice 1, on main). This plan replaces the store-and-forward
outline of [mailbox.md §14](mailbox.md#14-linked-machines) where the owner's decisions differ from it: nothing is held
while a link is down, so there is no outbox and no per-link numbering.

## 1. Decisions in force

- **Scope:** all three items of #2067. (1) `parent` from a `fromHub` child reaches the hub session that started it.
  (2) `session:<other host>/<id>` addresses reach a session on a linked host, and the receipts (delivered, read,
  answered) come back. (3) Names of sessions on linked hosts resolve as #2066 resolves this host's, with the same
  refusal for an ambiguous name.
- **Link down:** the send is refused at once, with the reason. Nothing is held.
- **Retry:** a send the link refuses is not written anywhere, so the `repeat` guard never counts it and the sender can
  send the same text again.
- **Guards** (#2014, #2035) warn the person and never block agent mail. They run where the message is written.
- **Protocol:** additions only.
- **Who may mail whom:** every agent every other, both ways, across machines (owner decision, 2026-11-09; §5).
- **Finding the recipient** across machines is the focus of item 3: a search, ranked and capped for a model (§8).

## 2. Who owns what

**The recipient's host owns the message.** It writes the stored message and its recipient row in its own mailbox,
runs its checks and guards there (`MessageService.send`, unchanged), and delivers it with its own delivery loop, as
for mail written on that host. A message is written once, on one host, in the same transaction as its checks.

**The sender's host writes nothing until the recipient's host has answered.** The send is one call over the link,
answered with the stored message's id or with a refusal. Nothing is written on the sender's side when the call is
refused or cannot be made, which is what makes a resend after a refusal pass the `repeat` guard.

**How the other side's session is named on each host.** The hub already names a session it started on a linked machine
`session:<hub host>/<machine id>.<session id>` (its qualified id, the one `agent_session` uses), and slice 1 made that
address known to the hub's mail as a session that is alive and `elsewhere`. A message from such a child is stored on
the hub with that address as its sender: the hub's own rules see an ordinary session of this host as sender
(`mayWrite`, the `repeat` guard by sender, the hold with no project), and a reply to it is addressed back to it.

**The link's direction.** The hub dials the machine. The machine calls the hub back only on the connection the hub
opened (`HostServer.call`, `LinkedHubs`), and the hub answers an allowlist of calls (`reverseCalls`). Mail from a
machine to a hub is such a call (`hub.mail`); mail from a hub to a machine is a host method on the machine
(`host.mail`, item 2).

## 3. Item 1: `parent` from a `fromHub` child

1. **The machine.** The tool resolves `parent` for a `fromHub` session that has no parent of its own (`askedBy`) to
   "the hub session that started it". The machine does not know which session that is, and is never asked to name
   it. It knows which hub: when `agents.createSession` comes with `fromHub`, the machine records the hub that offered on
   the connection the call came in on (`LinkedHubs.on`, never anything the call says), by its id and name, under
   `started_from_hub_by:<session id>` beside the `started_from_hub:` mark. An app setting, as the mark is: no store step,
   an older build reads only the mark, and the purge deletes both with the session.
2. **The call.** The machine calls `hub.mail` with its own session's id, the text and the send's fields (`needsReply`,
   `urgent`) on that hub's connection, and on no other: a hub that did not start the session never reads the text.
   **A session with no record** (started by a build from before it, or by a hub that had not offered on its
   connection: one from before mail with its asks switch off) is refused `elsewhere` and nothing is sent anywhere:
   nothing says which computer started it, and sending the text to every linked hub to find out would show it to
   computers that are not the parent's.
3. **The hub** (`mailFromMachine`, mail/from-machine.ts). It qualifies the session id with the machine the call came in
   on (never with anything the call says; a machine id has no dot, so the qualified id names that machine), finds the
   parent in its own record of linked children (`RemoteAgents`, `callerId`), and sends with `MessageService.send` from
   the child's address to the parent's. The parent reads the sender as `<name> on <machine>`. A refusal there (the
   parent gone, a guard) comes back as the answer, with its reason and text, and nothing is written.
   **Always a note** (`needsReply: false`, whatever the call's `needsReply` says): until item 2 neither a reply nor the
   "no longer watched" notice (`tellUnanswered`) can reach the child on its machine. A watched message would leave
   that notice in the hub's mailbox, addressed to the child and undelivered for good, when the parent stops or goes
   without answering, and would tell the parent that a reply is awaited and reminded, while its `mail reply` is
   refused. A note is never released, told or reminded (`releasedUntold` reads `needsReply` rows only). Item 2 may let
   the call's `needsReply` through once a reply and the notice reach the machine. **Item 2 does (§6).**
4. **The answer.** The child's tool (`MailTool.call`) says `Sent <hub's message id> to your parent "<name>" on <hub>,
   as a note, which asks for no reply there. Its answer reaches you as a new turn, not as mail.` Until item 2 the parent answers with `agent_session send`; a
   `mail reply` to the child's message is refused `elsewhere` with the text slice 1 gives, which names that way.

**Which hubs offer mail.** The hub already tells the machine who it is at every connect (`host.hubOffer`, with `on`
for the asks switch). The offer gains `mail: true` (an addition). The machine keeps a hub that offers mail even when
its asks switch is off, and lists or asks its projects only when `on`. A hub that removes the machine while connected
withdraws the offer (`on: false` without `mail`) whatever its switch, so the machine forgets it at once.

**Refusals on the machine**, each before anything is written:

| Case | Refusal |
|---|---|
| The send has `cite` (the person's message as their word, checked against this computer's record for the Assistant here, docs/plans/cited-requests.md) | `field_not_allowed`: `cite is checked against this computer's record of the person's messages, which your parent on another computer cannot read, so nothing was sent. Send it again without cite, quoting what the person said if it matters.` Refused rather than dropped, so the sender does not think the parent reads the person's word (`MailTool.call`) |
| A body longer than the mailbox takes from a session (`bodyLimit`, 16,000 characters) | `too_long`: `a body from this sender is at most 16000 characters`, the words local mail says (`tooLongText`), and the hub is not called |
| No hub recorded for the session | `elsewhere`: `your parent is a session on another computer, and this session was started before this computer recorded which computer that was, so nothing was sent. End your turn with the answer: …` |
| The recorded hub has not offered since this host started | `link_down`: `<hub>, which started this session, is not linked to this computer right now (or runs a Centralu from before mail crossed computers), so nothing was sent. Send it again once the link is back.` |
| The recorded hub has no live connection | `link_down`: `<hub> is not reachable right now, so nothing was sent. Send it again once the link is back.` |
| The hub answers "Unknown method" (it offered asks, not mail: a release from before this) | `older`: `<hub> runs an older Centralu, which mail does not reach. Update it there; until then your parent hears from you at your turn's end.` |
| The recorded hub answers `not_yours`: it no longer knows the session as its child, as when its parent there was archived or deleted, which forgets the parent's children | `gone`: `<hub> no longer has the session that started this one (it was archived or deleted there, or its record of this session is gone), so nothing was sent. No session there waits for this one's answer.` |
| The hub answers an error of its own (too many calls at once, a call it does not read) | `refused`: `<hub> refused the message: <its words>. Nothing was written there.` The server marks an answered error (`peerAnswer`), so it is told from a lost call, which has the same code |
| The call fails with no answer (link dropped mid-call, 30 s without an answer) | `link_down`: `the link to <hub> failed during the send (<error>), so it is not known whether the message arrived. Send it again with the same words: if it did arrive, it is not written there twice, and this computer keeps its copy then.` |
| The hub refuses it (its own rules: the parent gone, `repeat`, a body too long) | The hub's reason and words |

The last case is the one where a resend may meet the `repeat` guard on the hub: the message did arrive. The refusal
says so.

## 4. Older releases

Linked machines run other releases; the hub updates them after itself. Every send is a call that answers, so no
message is dropped without a word:

- **A machine with this, a hub without:** a hub from before this does not offer mail. While its asks switch is on it
  is called and answers "Unknown method": refused `older`, naming the cause. With its switch off it is not known to
  the machine at all: refused `link_down` with "not linked to this computer right now (or runs a Centralu from before
  mail crossed computers)", which names both causes.
- **A hub with this, a machine without:** the machine drops the offer's `mail` field. Its sessions keep today's
  refusal for `parent` ("on another computer"). Nothing reaches the hub, so nothing is lost there.
- **Item 2 (`host.mail`) to a machine without it:** "Unknown method", refused `older` on the hub with the machine's
  name.

## 5. Who may mail whom across a link

**Every agent may mail every other agent, both ways, whichever machine each runs on** (owner decision, 2026-11-09,
before #1455). Nothing depends on the asks switch or on who started whom: the person experiences their machines as one
place where all their agents are managed. The rule is one function, `mayReachAcross(from, to)` (mail/across.ts), which
allows every pair; #1455's per-direction trust, if it comes, changes that one function. The asks switch keeps gating
only what it gated before: asking a hub's projects to do work (`hub.projects`, `hub.askProject`).

Item 1's `parent` is now a case of the general rule: a hub that offers mail takes `hub.mail` from any session on the
machine, and only the resolution of the word `parent` (the hub's own record of whom it started) stays its own.

The hold for untrusted projects (mailbox.md §7.4) cannot hold across a link, since nothing is held there. A session of
an untrusted project that mails a session on another computer is refused `untrusted_project` at once, with words that
say why and that nothing was sent; the person trusts the project, and the session sends again. Mail from another
computer has no project on the recipient's host and is not held there, as for a session with no project.

## 6. Item 2: delivery both ways, replies and receipts

**Names on the wire are the hub's.** The hub names a machine's session `session:<hub id>/<machine id>.<session id>`,
and its own sessions `session:<hub id>/<session id>`. The hub's id is the one its own mail addresses use
(`hubSelfId`), which the offer already carries. A machine names everything on the hub's side the hub's way, so only
its own sessions need translating: the offer gains `you`, the machine's id at that hub (an addition), and the machine
reads `session:<hub id>/<you>.<x>` as its own `session:<own id>/<x>` and writes it back the same way. Another
machine's session reads `session:<hub id>/<other machine>.<x>` on both sides. A hub that offers no `you` is from
before item 2: it takes `parent` only, and every other address to it is refused `older`.

**Which host a foreign address is on.** On a hub, a session id with a dot is a machine's (a machine id has no dot). On
a machine, an address of another host id is that hub's, routed to the hub that offered under that id.

**The calls** (all additions):

| Call | Direction | What it carries |
|---|---|---|
| `hub.mail` | machine → hub | `sessionId` (the sender, the machine's own; the hub qualifies it with the link's machine). New: `to` (an address, hub naming; none means `parent`), `replyTo`, `name` (the sender's name), `notice` (the machine's notice for `to`, written as the machine's message, §6). `needsReply` is now read |
| `host.mail` | hub → machine | `from` (an address on the hub's side, or `centralu`), `name`, `to` (the machine's own session id), `text`, `needsReply`, `urgent`, `replyTo`, `notice`. Answered only on a connection a hub offered on, and only for a `from` under that hub's id |
| `hub.mailRows`, `host.mailRows` | both | the state of recipient rows of messages that crossed (below) |
| `hub.find` | machine → hub | a search of the hub's directory (§8) |

**A send.** The sender's tool resolves the address. A foreign one is sent by one call to the host it is on (a machine
calls its hub; a hub calls the machine; a machine's message to another machine goes to the hub, which passes it on
unchanged with the sender qualified). The recipient's host runs its normal send (`MessageService.send`, its checks and
guards, the sender being a session that is `elsewhere` and alive) and answers with the message id or a refusal. Only
then does the sender's host write **its copy**: the same message id, the sender's own message, with one recipient row
for the foreign address, written as delivered at hand-over so this host's delivery never tries it
(`MessageService.sentAcross`). A refused or failed call writes nothing, so `repeat` never counts it.

**An answer that was lost.** The sender's host picks the message id (`id`, additive) and keeps the send as unsure until
the other host answers. When the call fails after it may have arrived (the link dropped mid-call, 30 s without an
answer), the other host may have written it and this one has no copy. Then:

- a second send of the same words by the same session goes under the same id, which the recipient's host takes as the
  message it has, answering as for the first; the copy is written then;
- the recipient's row, pushed at the next change or connect, or a reply to it, has the sender's host keep the copy at
  once, so the reply is taken;
- unsure sends are kept in memory, 24 hours and 500 at most. After a restart a reply to such a message is refused
  `unknown_message`, with words that say it most likely arrived while the link failed, and to send the answer again
  as a new message.

A host from before this ignores `id`, and a second send there is refused `repeat` as before.

**A reply** is a send to the original sender, with `replyTo`. The original message is on both hosts under the same id
(the recipient's message and the sender's copy), so the recipient's host of the reply finds it, settles its own row as
answered by the reply, and the replier's copy does the same on its side. `mail reply` from the parent to a linked
child's message, refused `elsewhere` before, is this. With replies reaching the machine, `hub.mail` honours
`needsReply` again: the hub no longer writes every message from a machine as a note.

**Receipts.** Both hosts hold a row for each recipient of a message that crossed: the recipient's host the real one,
the sender's host the copy. Each change to one is pushed to the other side over the link (`*.mailRows`), routed by the
addresses as a send is, and merged there, forward only:

- the recipient's host is the authority on delivered, read, answered (with the answer's id), settled and released;
  the copy takes them;
- the sender's host is the authority on withdrawn (the sender withdrew it or went); the recipient's row takes it.

Which side may tell a row is read off what the host that takes it has stored, never off the row: a receipt only from
the side the copy's recipient is on, a withdrawal only from the side the stored message's sender is on. Mail between
two machines passes through the hub, which keeps no copy: it passes a row on only from the machine the row is about,
and the other machine checks the sender the row names against the message it has.

A push that fails is tried again on the next change and at the next connect: a machine pushes when a hub offers mail
on a connection, a hub when a machine takes its offer. What every linked side was last told in full is kept in the store
as a time (`mail.acrossToldAt`), which a side that is away holds back and one no longer linked does not: a host that
starts again reads every crossing row settled since then, so a row settled while the link was down is told after a
restart however long ago it was. The sender's `inbox` (`waiting`), its
`handled`, and the person's view of the copy read the copy as they read any row.

**Notices.** A Centralu notice the recipient's host writes to a foreign address (the "no longer watched" notice when a
recipient stops or goes without answering, `tellUnanswered`) is passed on and written there by that host. A hub's
notice is written on a machine as the hub's Centralu's, since the hub links the machine. A machine's notice is written
on the hub (and on another machine it is passed to) as that machine's message, from `Centralu on <machine>`, never as
the hub's Centralu, and only to a session that mailed one of that machine's sessions; any other is refused
`not_allowed`. The copy's row is marked released and told by the receipt, so the sender's host never tells it twice. A notice that
cannot be passed on (the link is down) is dropped and said in the host's log: nothing is held. This host's delivery
never tries a foreign address.

## 7. Refusals across (item 2)

Each is said at once, and nothing is written on either side:

| Case | Refusal |
|---|---|
| The link to the host the address is on is down, or that hub never offered since this host started | `link_down`, naming the computer |
| That host runs a release without this (`Unknown method`, or a hub with no `you`) | `older`, naming the computer and saying to update it |
| The other host answered an error of its own | `refused`, with its words and that it may or may not have taken the message (an error raised after it wrote cannot be told apart) |
| The call failed with no answer | `link_down`, saying it is not known whether the message arrived |
| A machine's session addresses a session on its own machine through the hub | `bad_address`, with the session's own id to write to instead |
| The recipient host's own rules (gone, `repeat`, too long, the Assistant's asks) | its reason and words; `gone` names the session by the address the sender used, and the computer it was on |
| `cite` | `field_not_allowed`, as for `parent` |
| The sender's project is not trusted | `untrusted_project` (§5) |
| A hub sends from an address not on its side, or a notice comes from the other side to a session here that never mailed it (§6, Notices) | `not_allowed` |
| A send names an id another computer may not give a message (one of this host's own, or not an id), or the id of another message here | `bad_value` |

**A session created before the hub's offer arrived** on that connection (item 1's open case) is recorded when the
offer arrives: the machine remembers, per connection, the sessions a hub created there with `fromHub` before it
offered, and records each under the hub that then offers on that connection.

**The task a hub gives a child on a machine** says how it reaches its parent from what the machine answered to the
offer: a machine with item 2 answers `host.hubOffer` with `mail: true` (an addition), and the task then says to
`mail` its parent; an older machine's task keeps "Mail does not reach it from here yet".

## 8. Item 3: finding the recipient across machines

With every agent reachable, the candidates grow with every linked machine. A session finds one by a search, and the
answer is cut for a model to read in few tokens.

**What exists today, and what this builds on.** `mail send` resolves `to` against this host's sessions by id or exact
name, refusing a shared name with the candidates (#2066). `agent_session list` and the Assistant's readers list this
host's sessions and, on a hub, each linked machine's from the hub's mirror (`LinkedMachine.lastKnown('sessions')`,
the rows the machine pushed last). `read_session` reads one. There is no second directory: **the hub's directory is
its own session list plus the mirrors it already keeps**, and a machine's is its own list plus each hub's directory,
asked over the link (`hub.find`). The hub leaves the asking machine's own sessions out of its answer; the machine adds
its own from its list, under its own addresses.

**The call.** `mail(action: "find", to: "<words>")`: one more action of the tool, with no new field. The words match,
in any case and any order, a session's name, its project's name, its machine's name and its role (`assistant`,
`coordinator`, `session`, `child` for one another session started). Every word must match one of them; a word that
matches the name counts most, then the project, the machine and the role. Among equal matches, sessions at work come
first, then those that waited or started most recently. An empty query lists the most recently active.

**The answer.** At most 8 lines, one per session, each with the exact address to mail, then the name, project,
machine (absent for this computer), role and state:

    3 of 41 sessions match "review". Mail one by its address.
    session:hub-1a2b/m3.01JD... "PR review" · project centralu · on Desk · session · working
    ...
    38 more: add a word (a project, a machine or a role) to narrow it.

A machine that did not answer is named on one line at the end, with why; its sessions are not listed. At most three are
named so; the rest are counted on one more line. Each part of a line is cut short (a name at 40 characters, a project
and a machine at 30), except the address. A hub that is
down makes a machine's search say so at once and list this computer's sessions only.

**Names in `to`.** `mail send` with a name looks across too: on a hub, the mirrors (no call); on a machine, each hub's
directory, asked for the exact name. A name found once is sent to; a name found more than once, here or elsewhere, is
refused `ambiguous` with the candidates' addresses, as #2066 does on one host. A hub that does not answer the lookup is
left out of it, and the refusal for a name found nowhere says which computers could not be asked (the first three, and how many more).
When a session here has the name, a hub is waited for only as long as a reachable one answers (0.6 s), not the 4 s a
search waits: one that does not answer by then leaves the send to the session here.

**Cost.** The answer is capped, so its size does not grow with the number of sessions, the length of their names or the
number of computers that could not be searched. Measured with the repository's token estimate (characters ÷ 4) on
generated directories, for a query that matches every session:

| Sessions | Names | Computers not searched | Characters | Tokens (estimate) |
|---|---|---|---|---|
| 10 | short | 0 | 996 | 249 |
| 200 | short | 0 | 1,031 | 258 |
| 200 | short | 30 | 1,227 | 307 |
| 200 | 120 characters | 0 | 1,201 | 301 |
| 200 | 120 characters | 30 | 1,397 | 350 |

Before the caps, the last row was 3,412 characters (853 tokens). With every field at its longest (names of 120
characters, projects and machines of 80, 30 computers with long names and reasons) the answer is 1,980 characters
(495 tokens). Tests pin both ceilings (`mail/find.test.ts`).

## 9. Pull requests

1. **Item 1** (#2145, landed): `HubOffer.mail`, `hub.mail` on the hub, the machine's `LinkedHubs` keeping mail hubs,
   and the tool's `parent`.
2. **Items 2 and 3, with the trust decision** (one change on `dev`): `mayReachAcross`, `host.mail` and the extended
   `hub.mail`, the sender's copy and receipts both ways, notices across, replies, `needsReply` honoured, the follow-ups
   of item 1's review, and `mail find` with names resolved across machines.
