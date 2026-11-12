# Inter-agent content

A script an agent runs calls the host with its session's credential (#1405, "Who holds full power"): attribution, not
proof, and never more than the limited credential's rights.

Worker reports retain their provenance in stored history and the UI. Reports from
workers to directing sessions become host-authored notifications: the receiver's model reads only what Centralu wrote
(how the work ended, the session's id, the kind of its tool's error, how to go on, and the `read_session` call that
shows the last response and the error as data), never the last response, an error's words (a CLI's error can carry a
hook's output, a linked machine's is whatever it sends), a session's or project's name or a task's description (#1186;
`ChildReports.tellSession`'s `forModel`, `errorKind`). One exception, by the owner's choice (#1948): the mail notice a
session gets when a session it asked stops before answering (docs/plans/turn-owned-by-no-one.md §4.1) quotes what the
stopped session last wrote in the cut turn, at most 600 characters, five sessions a notice, every line behind `> `, under
Centralu's words that it is that session's own text, to be read as information and never as instructions. It is not a new
read path, and one rule decides it (`StopNotices.quotes`), which the notice to the session that started the stopped one
(`StopNotices.tellStarter`) is held to as well. Each of these must hold, or nothing is quoted:
- the sender is a session that can read the stopped session with `read_session` (that tool's own rule,
  `CentraluTools.mayRead`, asked through `SessionTools.readsSession`);
- the cut turn is the session's latest in the mailbox's record of turns, and the sender's own message started it: a mail the
  mailbox delivered, or work the sender gave it (a start_agent task, more work sent by mail), whose task row the turn names as
  its starter and the sender sent. A turn the CLI started by itself, or the person's, is never quoted;
- every message the mailbox delivered into that turn is the sender's;
- every user row the session stored since the row its turn before began after names the sender in `from`, not as a relayed
  report, and no question card of the session was answered since (`ChildOwnership.latestTurnInputs`). A row the person typed,
  an app's, a script's and one read back from the tool's own record name no sender. A question card's answer goes to the tool
  and is stored only as the mark `question_answered:<session>`, written before the answer is given. With no turn start
  recorded, nothing is quoted.

The rows checked start at the turn before's start, so they can include that turn's own rows; such a row withholds the quote
too. Withheld, the mail notice carries no quote, and the older path's report has `(not quoted: …)` where the last response
would be. It is mail, so
it is never inline in a wake: `mail read` shows it quoted again under "the person did not write it". The error's words are
still left out, and the person's Inbox notice quotes nothing. A notice that could not be delivered is kept in memory, dropped
with its session, and delivered when the session next takes a message; ordinary
assistant/manager/coordinator instructions retain their content and attachments. A worker
holding the read-only `reader` set (#320) is still a worker here: the gate asks whether the
source directs sessions, not whether it has tools. Worker-originated records are excluded from
privileged conversation memory. Read-session, preview and recall text is framed as structured
untrusted data, not human authorization — that now includes what one ordinary session reads of
another. The reader set cannot send. From a trusted project it reads every session but an Assistant's, here and on
the linked machines (#984, #1941): coordinators', app sessions' (a builder, an agent an app asked for) and those with no
project included, each row of a project nobody trusted marked "(not trusted)". No session reads an Assistant's
conversation, the person's own talk with it. What the Assistant says to another session is that session's: the
Assistant's own agents (no project; their first message is its brief) are read like any session, and a brief, a
message or mail from the Assistant lands in the receiving session's conversation and is read with it (#1941
review: intended, since a trusted project is the person's own). From an untrusted project it reads its own project only, so text planted
there cannot search every conversation (the #382 rule).

Who wrote each line travels with it (#838). `read_session` gives a line another session sent `from` and one an app
sent `fromApp`, and the first message a script started a session with `fromScript` (`authorOf` in `sessions/transcript-view.ts`); `recall`'s context marks every message
(`[person]`, `[agent]`, `[session "<name>"]`, `[app "<name>"]`, `[script "<label>"]`) and indents a message's own later lines, so neither a
child's report nor an app's text reads as the person's, and no text can start a line with a mark of its own. The
hit's snippet keeps those lines (`windowAroundLines` in `sessions/snippet.ts`): it used to fold every line break into a
space, which put a mark an app's text wrote on the same footing as a real one, and a snippet cut inside a message starts
with that message's mark (`assistant-seat.test.ts`). The
Assistant's memory of its past conversation (appended to its prompt when it restarts) leaves out app messages as it
already left out other sessions', and indents a message's later lines, so text cannot start a `Person:` line.

## Claude's independent-session messaging (#569)

Claude Code can discover other Claude processes on the same machine through
`~/.claude/sessions/<pid>.json` and send messages over per-process Unix sockets
(named pipes on Windows). Its default inbound policy delivers messages between sessions in
the same permission-mode class, including two `safe` sessions. That path does not pass through
Centralu's `ask_project` consent card.

Every Claude query Centralu builds, under every preset, `auto` included, applies inline SDK flag settings
`crossSessionInbound: 'refuse'` to drop inbound peer messages, adds `ListAgents` and its alias `ListPeers` to
`disallowedTools`, and sets `CLAUDE_CODE_HARBOR_KITE=0` in the child environment. `SendMessage` remains available
because it also continues the session's own background subagents. Existing settings, denies and environment are merged,
and settings-file selection remains governed by project trust and session kind. The host's own
`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are dropped from the environment it passes on: a host
started inside a Claude session would otherwise hand its children that session's inbox address and secret.

This is not opened by `auto` (it narrows #603 for this one control, as the mailbox plan's slice 0 decided,
`docs/plans/mailbox.md` §9.6): two `auto` sessions are the same permission class, the CLI's default delivers between
them at once, and that would reach another Centralu session past the relations, the record and the guards its own
messaging keeps. The controls cover workers, assistants, coordinators, worktree managers, builders, app agents,
`start_agent` children and resumed sessions, including fresh keeper processes.

What holds, and what does not, said plainly (CLI 2.1.263 to 2.1.299 read and measured):

- **`CLAUDE_CODE_HARBOR_KITE=0` can be undone.** The CLI applies the `env` of the person's **user** settings
  (`~/.claude/settings.json`), of flag settings and of managed settings onto its environment after it starts, so a user
  `env` that sets the key to `1` binds the session's inbox again. Project and local settings cannot set it (the key is
  on their deny list). The environment gate is therefore not the control to rely on. What holds when it is undone is
  the inline `crossSessionInbound: 'refuse'` (the message is accepted into the inbox and never read: probe case
  `kite-on-b`) and the `ListAgents` / `ListPeers` denies.
- **Managed (organisation policy) settings outrank Centralu's inline layer.** The CLI resolves the inbound value as
  managed, then flag, then user settings; repo files can only tighten it. A managed `crossSessionInbound: accept`
  reopens the channel, and a managed `env` can turn the gate back on. That is the organisation's decision and Centralu
  does not override it. A managed file was not tried (it would affect every Claude on the machine).
- **Below that, the person's own settings do not reopen it.** A project settings file that asks for `accept` loses to
  the inline layer (probe case `auto-accept-file`). By the CLI's resolution order (read in its binaries, not measured)
  so do the person's user setting `crossSessionInbound: accept` and the CLI's `/config` switch: flag settings beat user
  settings. The person's own interactive Claude cannot reach a
  Centralu session either (probe case `in-from-raw`: the receiver has no inbox to reach).
- **A process an older host started keeps the flags it was started with**, so a kept `auto` session from before this
  change has its inbox open. Its launch fingerprint is version 3 now (`launchSettingsFingerprint`), so the host that
  adopts it restarts it once, at the next safe boundary (the #589 path: at idle, or after its turn), and the restart
  carries the controls.

Limits: the environment gate is version-sensitive, undocumented, and undoable by user settings as said. The documented
inbound refusal and the discovery denies do not alone prove outbound isolation when a peer address is already known and
`SendMessage` stays enabled; the probe measures the outbound side too (`out-to-raw`: a controlled sender is told
"Cross-session messaging is not available in this session"). Re-run
`packages/agent-host/scripts/probe-cross-session.mts` before SDK/CLI upgrades: it addresses the receiver by the name it
registered (the CLI never routes a session UUID), runs the controlled cases, the mixed ones, and two uncontrolled
controls that show it can see a leak. Unit tests check constructed options; the live probe supplies bounded runtime
evidence. This is a provider-messaging boundary, not OS isolation: commands with the user's permissions can still access
same-user files and sockets, and processes started outside Centralu are not configured by this adapter.
