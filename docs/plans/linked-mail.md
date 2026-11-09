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
   it.
2. **The call.** The machine calls `hub.mail` with its own session's id, the text and the send's fields (`needsReply`,
   `urgent`), on each linked hub that offers mail (below), one after another. A hub answers `not_yours` when it did not
   start that session; the first other answer is the result.
3. **The hub** (`mailFromMachine`, mail/from-machine.ts). It qualifies the session id with the machine the call came in
   on (never with anything the call says; a machine id has no dot, so the qualified id names that machine), finds the
   parent in its own record of linked children (`RemoteAgents`, `callerId`), and sends with `MessageService.send` from
   the child's address to the parent's. The parent reads the sender as `<name> on <machine>`. A refusal there (the
   parent gone, a guard) comes back as the answer, with its reason and text, and nothing is written.
4. **The answer.** The child's tool (`MailTool.call`) says `Sent <hub's message id> to your parent "<name>" on <hub>.
   Its answer reaches you as a new turn, not as mail.` Until item 2 the parent answers with `agent_session send`; a
   `mail reply` to the child's message is refused `elsewhere` with the text slice 1 gives, which names that way.

**Which hubs offer mail.** The hub already tells the machine who it is at every connect (`host.hubOffer`, with `on`
for the asks switch). The offer gains `mail: true` (an addition). The machine keeps a hub that offers mail even when
its asks switch is off, and lists or asks its projects only when `on`. A hub that removes the machine while connected
withdraws the offer (`on: false` without `mail`) whatever its switch, so the machine forgets it at once.

**Refusals on the machine**, each before anything is written:

| Case | Refusal |
|---|---|
| No hub known since this host started | `elsewhere`: `your parent is a session on another computer, which is not linked to this one now or runs a Centralu from before mail crossed computers, so nothing was sent. End your turn with the answer: …` |
| A known hub has no live connection, and no other took it | `link_down`: `<hub> is not reachable right now, so nothing was sent. Send it again once the link is back.` |
| The hub answers "Unknown method" (it offered asks, not mail: a release from before this) | `older`: `<hub> runs an older Centralu, which mail does not reach. Update it there; until then your parent hears from you at your turn's end.` |
| Every hub answers `not_yours` | `unknown`: `no computer linked to this one says it started this session, so nothing was sent. End your turn with the answer: …` |
| The call fails (link dropped mid-call, 30 s without an answer) | `link_down`: `the link to <hub> failed during the send (<error>), so it is not known whether the message arrived. If you send it again and it did, <hub> refuses the second one as a repeat.` |
| The hub refuses it (its own rules: the parent gone, `repeat`, a body too long) | The hub's reason and words |

The last case is the one where a resend may meet the `repeat` guard on the hub: the message did arrive. The refusal
says so.

## 4. Older releases

Linked machines run other releases; the hub updates them after itself. Every send is a call that answers, so no
message is dropped without a word:

- **A machine with this, a hub without:** a hub from before this does not offer mail. While its asks switch is on it
  is called and answers "Unknown method": refused `older`, naming the cause. With its switch off it is not known to
  the machine at all: refused `elsewhere` with the text above, which names both causes.
- **A hub with this, a machine without:** the machine drops the offer's `mail` field. Its sessions keep today's
  refusal for `parent` ("on another computer"). Nothing reaches the hub, so nothing is lost there.
- **Item 2 (`host.mail`) to a machine without it:** "Unknown method", refused `older` on the hub with the machine's
  name.

## 5. Trust per direction (#1455)

- **A child to the session that started it** (item 1): always, whatever the asks switch says. The hub decides who the
  parent is from its own record; the machine names only its own session.
- **A hub session to a session it started on a machine** (item 2's first case): always, as `agent_session send`
  already is.
- **Every other pair across a link** (items 2 and 3): one function, `mayReachAcross(from, to)`. Until #1455's setting
  exists, it reads the link's switch for that direction: a machine's session reaches other hub sessions only while
  the hub's asks switch for that machine is on. This needs the owner (question at the end of the report).

The hold for untrusted projects (§7.4) stays the recipient host's: a sender on another machine has no project there,
so mail from it is not held by project, as for a session with no project.

## 6. Receipts (item 2)

The sender's host keeps a copy of a message it sent across, written once the recipient's host has answered with the
message's id: the sender's `waiting` list and its view need it. The recipient's host pushes each change of its
recipient row (delivered, read, answered with the answer's id) to the sender's host over the link: from machine to
hub as an event the hub already watches (the qualifier passes it), from hub to machine as a host method. A copy whose
receipts stopped coming (a link that went down) is brought up to date at the next connect by asking for the rows by
id. A reply is an ordinary send across, back to the sender's address.

## 7. Pull requests

1. **Item 1** (this branch): `HubOffer.mail`, `hub.mail` on the hub, the machine's `LinkedHubs` keeping mail hubs, and
   the tool's `parent`. Tests over two real hosts and a real link.
2. **Item 2:** `host.mail` on the machine, the sender's copy and receipts both ways, replies across, and the hub's
   `elsewhere` refusal for its linked children replaced by delivery.
3. **Item 3:** names on linked hosts in the tool's resolution and in `mail sessions`, with #2066's refusal for an
   ambiguous name.
