# The mailbox, and a session asking the Assistant

**The mailbox (#1347, [plans/mailbox.md](../plans/mailbox.md) §9).** The sender of a post is always what the host knows: the session
whose tool called, the person for the window's `mail.*` calls, Centralu for its own; no argument of a call names one. Since M3a (#1684, mailbox.md §7)
mail is messages without threads, and who may write to whom, which project is trusted and what is held is one module, `mail/reach.ts`:
every session may write to every session here, the person and the Assistant; a send is refused only for a receiver whose seat has no `mail`
tool (`no_mailbox`: a coordinator, a builder, an app's agent), one that is gone, `centralu`, one on another computer (`elsewhere`), a request to an
assistant whose tool cannot put each step to the person (`assistant_asks`), and by a guard. **The one hold** (mailbox.md §7.4, D12): a `message`
from a session whose project is untrusted now (read live: no project is trusted, an unknown project is not) to a party outside that project
(another project's session, the Assistant) is held `policy` until the person trusts the project; mail into an untrusted project, within one
project and to the person is not held, and an `auto` receiver no longer holds anything. Held mail is let go in the order sent; a held answer
leaves its question open and tells the asker (S14). **A delegation out of an untrusted project is refused, not held** (`refusesDelegation`,
S15): `start_agent`, `create_session` with a first message, a `mail` send that is work, `send_to_session` with `reportBack`, `ask_project` and the
linked machine paths start nothing; trusting the project tells the caller once which calls it may give again (S16). **Guards** (mailbox.md §7.5):
identical repeats within 10 minutes (`repeat`); 30 posts a minute per session; 5 requests an hour to the Assistant per asker group
(`ask_rate`, no one-open rule any more). **Nothing holds, defers or refuses mail for how much of it there is** (#2014): past 20 mail-started
turns an hour between two sessions with no word from the person, or 120 on the host, Centralu writes the person one warning an hour in the
Inbox and the mail goes on. The accepted risk: a runaway exchange while the person is away keeps spending usage until they act on the warning.
**Accepted gaps of the one hold** (mailbox.md §1.6, D11): what a trusted session read of an untrusted project (a session's words through `read_session`
or `agent_session`, an `ask_project` answer, `recall`, a file, a handoff's note, a fork's copied conversation) it can send on by mail or a task
unheld, and the receiver sees the sender, not the origin; a report's `answer` from a session of an untrusted project that a trusted session
delegated to reaches the owner unheld (reports are never held); the CLI's own file tools reading another project's folder, and folders two
projects share; the person pasting another project's text; MCP servers a CLI loads by itself and outside text a tool fetches; text leaving
through an app, git or the network; and work on a linked machine until mail crosses links (a delegation to one from an untrusted project is
refused, and what comes back is not marked). `find_apps` and `attach_app` offer no app of an untrusted project. A
row held for the person is listed in the Inbox until the person trusts the project, resumes the chain, or releases it. What another party wrote reaches a model only inside the wake frame (`mail/frame.ts`) or the `mail` tool's `read`, both
quoting every line (U+2028, U+2029 and U+0085 included) behind `> `, escaping the frame's tags, and naming the sender by Centralu's
word for how it stands to the reader. The `mail.*` methods are the window's: they are not in the Assistant's window-call list, and
the `mail` tool is the ordinary session's and the Assistant's alone ([tool-matrix.md](tool-matrix.md)), which runs it as a command behind `centralu_run` and is told of mail in that form, because it owns the threads `send_to_session` opens (slice 3); a coordinator, a builder and an app's agent are not parties of the mailbox. The delivery stamps its input as Centralu's channel, and sends it
as the CLI's own input, never as a message of the person's.

**A session asking the Assistant (#1447, #1739, [plans/cited-requests.md](../plans/cited-requests.md), [plans/mailbox.md](../plans/mailbox.md) §7.6).** Any session of this host may send the Assistant a request
(`mail send` with `to: "assistant"`: a message from a session that answers no question or task of the Assistant's, mailbox.md §7.6). The request is a session's text, so it
is not the person's word. The request path's safety is the Assistant's judgement, one floor in code, and a record the person reads afterwards (owner, 2026-11-03:
what matters is what the person intends, which only the Assistant can judge). These follow. (1) **A citation is evidence, checked by the host.** A request may cite the
person's message (`cite: true`). In the send's own transaction the host takes the newest message the person sent in the asking session's own conversation (a transcript
row with `byPerson`, which only the window's path writes: what the person typed in the composer, or the fixed handoff prompt or Continue text the window sends when
the person clicks for it, which the header quotes as it is; a row with no source mark is not enough, since a caught-up CLI transcript, an app's text, a first prompt and a
hub's text have none), and checks that it is at most 30 minutes old, not dated after now, and not cited before by this sender (`dedupe_key` `cite:<seq>` under the
mailbox's `UNIQUE(sender, dedupe_key)`, in the store, so a restart or a swap keeps it). A session cannot name the message: the host finds it. A request that passes stores
`facts.cites` (Centralu writes facts; a session cannot), and its header in `mail read` says, in Centralu's words, that it cites the person's message, verified, when it was
typed, quotes it, and says to judge from it and around it what the person wants. Every other request says it cites nothing the person wrote, so its words are the
session's only. Cited or not, it wakes the Assistant.
(2) Its words never go inline: the wake lists host fields and calls the sender "a session asking you for something", and `mail read` quotes the words under a header
Centralu writes from its own record (the session's name, its project, whether the project is trusted, the citation). The words are read in the turn the request was given in
and in no other (an earlier request of the same session included): read in the person's turn, or in another request's, they would be a session's words in a turn that has no card for them, so `mail read` gives
only who the request is from there, and `mail inbox` lists a request by that header and not by the subject the session wrote. (3) **The floor and the record.** A request's turn is never looser than the
person's own. The steps that can be undone are listed (`UNDOABLE`, `sessions/asked-acts.ts`: a project added or made, a machine added or its link changed, a trust or a
setting changed, a session renamed or restored, an app attached, detached, shared, restarted or checked, a proposal, a remembered answer taken away), and so is work
handed on to a session no looser than the asking one, wherever it is (`create_session`, `start_agent`, `send_to_session`, a `mail` send that is work, `ask_project`, a handoff,
`mail send`; the new or target session's preset after any cap, `AskedGateHost.noLooser`): where the work goes is the Assistant's judgement, recorded like every step. These run without the request's card,
and the cards they raise themselves ask as in the person's turn (the trust card, the project's card, the machine's card, the settings that ask, a start's consent): the
turn never answers them. Every other step raises the person's card first, cited or not, naming the session and its project, under every preset (`alwaysAsk`, so `auto`
does not answer it), Allow or Deny only (`ASSISTANT_CHANGE`): a delete, an archive's steps removed, a machine installed, removed, uninstalled, rolled back or set to
start with the OS, an app removed or put back to an older version, agent versions applied, background work cleared, an update installed or applied, an answer given for
the person, work handed to a session looser than the asking one, or one whose preset this host does not know, every step of the CLI's own that is not a read (a command, a file written or edited), of another MCP server's and of an app's, and every command no list names,
so a command added later asks until it is listed (a test holds every definition to one list). Its Allow covers the cards that same call raises (`HostCards.cover`), so one
step is one card. Every step that changed something, cited or not, the ones the person allowed included, leaves a notice in the asking session once it has run and not
failed (a step of the CLI's own when the CLI says it ran, `PostToolUse`), where the person reads it (label `request record`): what was done, and on which message of
theirs, or that the request cited none. Reading, and answering in the request's own thread, are free. That is three doors, each closed where every call passes through it: Centralu's own tools and commands (`runParsed`, on both CLIs);
an attached app's tools (`SessionApps`' `call`, on both CLIs: a request could otherwise have the Assistant call a project app's `queue_merge`); and the CLI's own
tools, its shell, file edits, fetches and the rest (Claude: a `PreToolUse` hook, `adapters/claude/request-hook.ts`, which the CLI runs before every tool call in every permission mode and whose
decision stands in for its own question, so the person is asked about each step whatever the preset, and an "always" the person once saved for such a step is not consulted. A narrower
permission mode alone was tried and is not enough: a tool that needs no permission never reaches the CLI's permission callback in it, and the review of #1516 ran a subagent and a cron prompt
through it unasked). A request's turn is refused, without a question, the tools that go on after the turn: a subagent, a prompt scheduled for later, a watched command
(`OUTLIVES_THE_TURN`) and a command started in the background, since the person's card belongs to the turn and what they start would run later with no asker. The card shows a step of the CLI's own whole (a
file's content, an edit's text, a message), refusing one over 6,000 characters; only Centralu's own tools have their long free text cut. The Allow is for that one step: the
cards the step would raise itself meanwhile are covered by it (`HostCards.cover`, kept by the call's own async work and ended with the call or its signal), so there is one
card, and no "always" is offered or kept; an Allow that arrives after the turn it was asked in ended (also when the thread's next turn has begun) runs nothing. The card shows every argument whole except long free text of
Centralu's own tools, which is cut and says how long it was; a step too long to show whole is refused, not asked about in part.
Whose request the turn is is read from the store, never kept in memory (docs/plans/turn-owned-by-no-one.md §4.2, `MessageService.requestsIn`): the senders of the requests
whose rows were given in the Assistant's open turn, settled or not, and not held from it. So the request answered mid-turn, the person writing into the turn, the session going
to the trash, a restart or a host swap does not lift the gate, and a held request never joins a turn or shows its words. The words of a request are shown under the same rule,
so they are shown exactly where the gate is that session's. One session's requests a wake, and a request never joining a running turn, keep a turn to one asker; if a turn ever
held requests of two sessions it **fails closed**: every step but a read asks, the answer in a request's own thread and a step that can be undone included, the card names every
asker, a created session is held to the lowest asker's preset, and each step done is recorded in each asking session. A turn that is not a request (the person's,
or a thread the person gave) is as it was. **Where the Assistant's tool cannot put each step of its own to the host** (`gatesSteps`; Codex, whose per-turn approval policy
is not yet measured here), a session cannot ask the Assistant at all, in a thread it opened before as well: the write is refused with a reason, because its shell and edits could not be put to the person.
**Not covered, and named:** the Assistant's judgement is what stands between a request and a step that can be undone, or a read it passes back: a session that read
hostile content can talk it into either. The floor covers the Assistant's own steps; a worker it starts runs under its own preset, as one the asker started itself would,
which is why work handed on without the request's card goes only to a session no looser than the asker; where it goes, another project or a linked machine, is
the Assistant's judgement. What it can pass back that the asker could not read itself is narrow, since a trusted asker reads every session but an
Assistant's, here and on the linked machines (#984, #1941), and under a bypass or `auto` preset reads files with its own shell: the Assistant's own
conversation (not a brief, message or mail it sent another session: that is in the receiving session's conversation, read with it), and files the asker's stricter preset would ask about; for an asker in an untrusted project,
anything outside its own project, though its requests are held until the person trusts the project. A hub's Assistant, which holds this host's token, could send
text through the composer's call and so as the person, and a hub writes the person's answers to its machines' sessions as the person's word (`host.mail` from `person`, #1987,
[plans/linked-mail.md](../plans/linked-mail.md) §7a), which gives it no right it did not have; a request held for an untrusted project keeps its citation until the person trusts the project, since the
window is checked at send;
a turn that a relayed report starts (the old path of a kept process) belongs to no thread, so a request's words do not reach it; an app tool its app marks read-only
(`readOnlyHint`) is not asked about, on the app's word, as for every session; `read_session` and `recall` of the asking session show what it wrote, so the words are reachable by them in any turn
(reading needs no card, mailbox.md §9.7); a step whose card would pass 6,000 characters (a `Write` of more than about 6 KB) is refused, with no way through but smaller parts; a turn that an old build's kept process was already in when this build took it over has no hook until it restarts; the output of a command the person allowed can start a turn of the CLI's own
later, as the output of any command can (a command started in the background is refused in a request's turn, since it would start that turn on purpose). (4) Limits:
a request from an untrusted project is held by the one hold (`policy`, above) until the person trusts the project, and a held row is a phantom to the Assistant: `mail read` shows none of
its words meanwhile, and marking it handled or answering it is refused as for any message it cannot read; there is no one-open rule (#1683), and at most 5 requests an hour (a clarification of a task the Assistant gave is no request), counted over the sessions of the asker's project and under its root session, so starting sessions does not multiply them. The sessions the Assistant itself started are not one group: the walk up to the root stops before the Assistant, so its sessions in
other projects each have their own request and their own five an hour. Nothing moves across with the answer: the asking session gets back only what the Assistant posts in the thread, and the end of the
Assistant's turn is reported in Centralu's words alone, never with the Assistant's last response (which may be addressed to the person) or a pointer to its conversation. A linked machine's sessions asking the hub's Assistant are slice 4's (mailbox.md §9.7, "Linked machines").

`handoff_session` (#694) is the Assistant's alone, and among its commands the one that acts on another session's
place in the person's work: it starts a successor from a note and moves the original's children to it and copies its attached apps. Its
authority is checked before anything moves (`HandoffFlow`; `moveChildren` checks none itself): the central
assistant, a project's ordinary session of this computer in its view, not mid-turn, and the person's card unless the
assistant is `auto` or the handoff guards nothing (#1509, owner 2026-10-24): the session is at rest (the same check) and the
preset the successor takes, the original's, is within the Assistant's own (`HandoffFlow.covered`, read again before anything
starts and where the successor starts, so a preset raised meanwhile, while an agent wrote its note too, is not handed off unasked). The original stays, so nothing is lost, and the
assistant hands over no power it lacks. A session above the Assistant's preset (a `safe` assistant and a `normal`
session, or a `normal` assistant and an `auto` one) still asks. A covered handoff can create a fresh session in an untrusted
project without a card, as `send_to_session` already reaches that project's sessions without one; the successor runs under the
original's preset, and the project's trust gates what it may do as it does for the original. What injected text in the Assistant's context can reach depends on that consent: under
`normal` or `safe`, a card for each handoff, and after the person answered "always" on one, handoffs of any eligible
session without a card for as long as the host serves that Assistant; under `auto`, handoffs of any eligible session
with only a log line (`[permissions] … session_handoff of <id> … allowed`). In every case it cannot reach an ineligible
session, a session mid-turn, a deletion, or a preset above the original's. The receiving tool is checked before the card
(an unknown, uninstalled or signed-out tool is refused without one), every name on the card is JSON-quoted, the
Assistant's extra words are cut at 400 characters with the cut said, and "always" is recorded only once the call has
passed every check after the card. Refusals are logged with the caller and the target, and under `auto` the allowance
is logged once, by the call that holds the session (#797), so a burst of calls logs one "allowed" and the refusals.

The note defaults to the stored record, so a session's own drift does not write it. The record labels every row
another session, an app or a script sent (`from`, `fromApp`, `fromScript`: a child's report, a parent's or Assistant's instruction, an app's
message, a script's first message) with its source and carries its text as one JSON string, as read_session does (#120, #121); only the person's
rows are `[user]`. That holds per line, as the successor reads the file, not only per row (#797): a row starts only at
the start of a line, and every later line of any row's text is indented, so the session's own multi-line reply or
compaction summary cannot make a line that starts with `[user]`. A tool's name and title (a multi-line command, a
heredoc) and paths are kept to one line with control characters escaped, and the predecessor's name is JSON-quoted in
the record's header and instructions and in the successor's opening, since a name can hold a newline. The successor's opening is stored and shown as the Assistant's message (`from`), not the
person's. In agent mode the request goes in as the Assistant's message and the reply is read from the store after
the turn ends. The original is never deleted, and the successor runs under the original's preset, never the
Assistant's.
