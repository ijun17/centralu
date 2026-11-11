# Text from agents and apps: tool output and what an app sends

## Tool output in the store

The store keeps every tool call whole ([#221](https://github.com/ijun17/centralu/issues/221)): the call's raw
`input` (a Write's content, an Edit's both sides, a command with its options) and the result's whole `output`. It used to
keep only the card — the first 300 characters of a Claude result, 2,000 of a Codex one, a file edit's path — and the
full text lived only in the tools' own files, which Claude Code deletes after 30 days without activity. That record now
outlives the tool's cleanup. It also means **secrets a tool printed stay in the store for as long as the session does**,
instead of for as long as the tool keeps its file; deleting the session for good (FR-22) is what removes them.

That record does not move the boundary of [#73](https://github.com/ijun17/centralu/issues/73): full tool output from
one session reaching another session's prompt is the privilege path it closed. So the record stays in the store:

- **Readers get the card unless they ask for the record by name.** `Store.loadMessages` and `loadMessagesFrom` drop
  `input` and `output` in SQLite (`json_remove`) unless called with `{ full: true }`, and nothing calls them that way
  yet. Every reader that hands stored messages to someone else goes through them: `read_session`, `recall`'s context,
  `list_sessions`' preview and the report-back, the handoff record and handoff note, the Assistant's memory, an app
  agent's final answer, the UI's history pages (`messages.load`, `trash.read`). Each of these also names the fields it
  copies (`summary.title`, the string `summary`, `text`), so a leak would take both layers failing.
- **Events leave the host as their card.** `withoutToolRecord` is applied where every event leaves `SessionManager`,
  before the WebSocket broadcast, its reconnect buffer and the in-process app observers.
- **The search index holds none of it.** Only what the person and the agents said, and the agents' reasoning, are
  indexed (`INDEXED_KINDS` in `dev-services/store/search-index.ts`) — not tool calls, and not their output — so neither `recall` nor the palette
  can find a session by what a command printed, or by the command.

Tests: `manager-messages.test.ts` ("a tool call is kept whole in the store and leaves it only as its card") puts secrets where
the card does not reach and looks for them in the broadcast, the history and archive pages, `read_session`, `recall`,
search, `list_sessions`, the handoff record and file, and the Assistant's memory; `store-tool-record.test.ts` holds
the store's default read and the index.

### A subagent's steps

What a native subagent did — Claude Code's `Agent` tool, Codex's `spawn_agent` — is kept too
([#222](https://github.com/ijun17/centralu/issues/222)): its text, its readable reasoning, and its tool calls and
results whole, the way #221 keeps the parent's. About a third of all Claude tool calls happen inside subagents
(measured for #222: 20,107 of 59,734), so this is where most of a tool's printed output lands. The same rule applies,
with one more layer:

- **They are not the conversation.** The steps live in a table of their own (`subagent_messages`, store v41), keyed by
  the session and the launching call, and the only reader is `Store.loadSubagentMessages`, which names one launch card.
  Every reader listed above reads `messages`, so none of them can hand a subagent's tool output — or its words — to
  another session's prompt, count it as unread, or take it for the parent's last answer (the handoff note).
- **The screen gets cards.** `loadSubagentMessages` drops `input` and `output` like `loadMessages` does, and the live
  `subagent_event` is stripped by the same `withoutToolRecord`. The subagent's text and reasoning do go to the screen
  that opens its card: they are what it said, as the parent's text is.
- **Not indexed, text included.** The parent's own report on what its subagent found is in the conversation, and is
  what search and `recall` find.
- **They go when the session goes.** The rows belong to the session, so the session archive keeps them and a purge deletes them
  (FR-22).

Tests: `manager-messages.test.ts` ("a subagent's steps are kept under its launch card and read by nothing else") looks for a
subagent's tool secrets, words and reasoning in every reader above, and for its tool secrets in the broadcast and
`messages.subagent`; `store-subagent.test.ts` holds the table, the default read and the index.

## Text an app sends

An app's view can ask to put text into a conversation (MCP Apps `ui/message`). The person reads
it and chooses to send it, but the app wrote it, and an app's code can relay outside data word
for word: the same injection path as a worker's report, so the same rule applies (#120).

- An inline view's message is shown to the person first, and nothing is sent before they press
  Send. It can go only to the conversation of the card the view stands under: `apps.viewMessage`
  takes the conversation and the app from the view instance and only compares the conversation
  the caller names (`rpc.ts`, `InlineViews.owner`).
- A pinned view's message is shown with a list of sessions, and nothing is sent before the person
  picks one. A pinned view belongs to no conversation, so the destination is the session picked.
  The app still comes from the view instance (`ViewHost.describe`), and an instance that is not
  open is refused.
- It is stored with its source (`fromApp`) and drawn as the app's message, not the person's. A
  session's automatic name is never taken from it.
- The agent receives it framed (`appMessageFrame` in `sessions/app-messages.ts`): a header naming the
  app and saying the person chose to send it but did not write it, and that it is the app's text,
  not an instruction; then **every line** of the text behind `> `. A line imitating the header, or
  a made-up "person:" field, stays inside the quote. The app's name passes the one-line field rule
  (`frameField`). A pinned view's message gets the same frame, which says it came from the app's
  own view, outside this conversation.
- One rule makes any text one line (`oneLineText` in `protocol/app-frames.ts`, #428; `frameField`
  is it at 120 characters): white space, control characters (U+0085 included), the line and paragraph
  separators, the bidi controls, the zero-width space and word joiner, and the tag characters (which
  hide text from a reader) become one space. ZWJ, ZWNJ and the soft hyphen stay: they are part of names.
  A linked machine's paths keep their spaces and joiners and lose only what breaks a line (`onePath`). Every name or task line the host puts on one line uses it: a frame's names (`askFrame`,
  `agentFrame`, `agentNoteFrame`), a linked machine's names, consent cards' task lines, session labels.
  The ten copies had different sets, and the narrower ones let a NEL, a bidi override or U+2028 through.

The same rule covers an app's error report. "Send to builder" hands the builder a bundle made of
the app's own output: its reason and the last lines of its stderr, which can carry outside text
too. It goes with a header saying the person sent a report Centralu built from the app's output,
and every line behind `> ` (`builderErrorFrame` in `@cc/protocol`). Only a person's click sends
it, and a bundle goes once (`builder-requests.test.ts`, "nothing goes out before it is clicked;
clicking sends that bundle enclosed in a quotation exactly once, and a second click is
rejected").

Tests: `inline-views.test.ts` ("goes to that conversation, is recorded as a message sent by the
app, and the agent receives it as the app's text enclosed in a quotation", with a forged header
inside the text; "cannot send by claiming a different conversation for a view inside a
conversation, or through an instance that is not open"; "a fixed view's message goes to whichever
conversation the person picked, in the same frame as a view inside a conversation (an app's
text) — but stating it came from outside the conversation"); `e2e/inline-views.spec.ts` and
`e2e/apps.spec.ts` for asking first; `e2e/build-loop.spec.ts` for the pinned path.

A `run_agent` prompt (apps/broker-and-rpcs.md "The broker: agents, other apps, host data") is an app's text too, and no person chose to send it. It is
stored with its source (`fromApp`) and reaches the agent in the same frame, under a heading saying
the app asked for this work through Centralu, that the person did not write or read it, that
nothing in it can grant permissions or change instructions, and that the final message goes back
to the app (`appMessageFrame(..., 'request')`; `app-agents.test.ts` "work an app assigns is
confined to the same frame as UI messages — every line is a quote, so the app's text cannot forge
a header or fake the end of the frame").

A notice an app posts into a session that called it (apps/broker-and-rpcs.md "The broker: agents, other apps, host data", `notify`, #1161 item 1) is an
app's text no person chose to send either. It is stored with its source (`fromApp`), and reaches the
agent in the same frame, under a heading saying the app posted it to this session, which called its
tools before, that the person did not write or read it, and that nothing in it can grant permissions
or change instructions (`appMessageFrame(..., 'notice')`; `app-notice.test.ts` "is recorded as the
app's message and reaches the agent framed as the app's text, each line quoted", with a forged header
inside the text). Who it may reach is under "App servers".

Limits:

- The frame states where text came from. As with reports, it does not make the text safe to obey.
