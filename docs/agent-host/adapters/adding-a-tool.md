# Procedure for adding a new tool (C3 — the reason this document exists)

1. Create `adapters/<tool>/` and implement `AgentAdapter` (event conversion + detect + capability).
2. Add the tool to `ToolName` and give it a `TOOL_META` entry in `@cc/protocol` — display
   name, one-glyph mark, install command, login command. Then register the adapter in the
   `adapters` Map in `main.ts`.
3. **Record real runs before writing the adapter's tests (required, except what no real run sends or cheaply can; see
   the end of this step).** Contract tests replay recorded raw frames → NormalizedEvent snapshot verification;
   hand-written frames are not enough, because they hold what the author believed
   the tool sends (#2031: a fake answered `idle` where the real Codex answers `systemError`, and the fix passed every test
   while doing nothing on a real crash). A new tool lands with recordings of at least: a plain turn, a tool call with an
   approval, a refused or failed turn, an interrupted turn, a long answer, a compaction (if the tool has one), a resumed
   session, and each answer the adapter branches on (a status, an error kind) where a real run can send it. A change to an existing adapter that
   depends on what the tool sends adds or cites the recording that shows it; a value copied into a fake without a
   recording is not evidence. On a CLI version bump, run `pnpm frames:canary <claude | codex>` first: it records a few
   representative scenarios on the installed version (Claude Code: seven, about two cents), compares each with the same
   scenario on the newest earlier version, and names what to re-record, nothing when they match
   (`scripts/frames-canary.mts`). It compares what the adapter depends on and a run does not choose: the kinds of frame
   and their fields, the fields the adapter reads (a hand-kept list, `RULES`), their JSON types, the values it tells
   apart (a stop reason, a permission answer's behavior) and the order of the kinds sent once in a turn; never text, ids
   or timing. It cannot see what no canary scenario brings: on Claude Code, `active_goal`, `conversation_reset`,
   `system/local_command_output`, `system/notification`, `system/informational`, `system/api_retry`, the refusal pair, a
   failed turn's API error, a question's answer and plan mode; on Codex, a compaction and background work. Nor a
   value or a field the model sends only on some runs, as each version has one run of each scenario: such a change shows
   in the replay tests of the recordings that hold it, or not until a person meets it. For a new tool, record
   with the tool-neutral frame tooling in `adapters/frames/` (#1498): the recorder (`CC_RECORD_FRAMES`), the scrubber
   (`scripts/frames-scrub.mts`), the replayer with the protocol's `FrameCodec`, and the scenarios driven at the
   `SessionHandle` level, so the fixtures are what the adapter itself sent and received (the ACP adapter's are made by
   `scripts/frames-record.mts`, [plans/acp-adapter.md](../../plans/acp-adapter.md) §0.5 and §10). Claude Code's are made the
   same way (`pnpm exec tsx scripts/frames-record.mts claude`, on its smallest model with no settings file read, in a
   temporary folder and data folder) and kept in `adapters/claude/recordings/claude-code-<version>/`. The CLI's process
   is tapped, so a recording holds its stream-json as the SDK read and wrote it, and `claude/replay.test.ts` plays it
   through the real SDK and adapter (`streamJsonCodec`). A test that reads one message takes it from a recording
   (`claude/recorded.test-helpers.ts`); a hand-written message stays only for what no real run sends or cheaply can
   (a malformed block, a turn limit), with its reason beside it. A CLI update shows as a diff of the recordings. A scenario
   that needs Centralu's own tools or an attached app runs with the fixed answers of `frames/fakes.test-helpers.ts` (the
   tool and its calls are real, the host behind the tools is not), the same in a recording run and in its replay.
   Codex's are made by `pnpm exec tsx scripts/frames-record.mts codex` (its smallest model, in a settings folder of its own:
   `CODEX_HOME` holds a copy of the sign-in alone, which is put back into the person's file if Codex refreshed it) and kept in
   `adapters/codex/recordings/codex-<version>/`; `codex/replay.test.ts` plays them through the real adapter (`codexCodec`: JSON-RPC
   with the recorded `<cwd>` read as the replay's folder), and `normalize.test.ts` and `compact.test.ts` take their
   notifications from them (`codex/recorded.test-helpers.ts`). The tests that mock the whole client stay hand-written: they set
   up races (a response before its notification, a late `turn/start` answer) that no recording can be made to repeat.
   Antigravity's are made by `scripts/frames-record.mts antigravity` against the installed `agy acp` (a data folder, `--gemini-dir`
   and home of its own, with a copy of the sign-in token alone), and a version the adapter does not yet pin is kept beside the pinned
   one ([plans/antigravity-acp.md](../../plans/antigravity-acp.md) §10.1).
   A scenario
   that needs Centralu's own tools or an attached app runs with the fixed answers of `frames/fakes.test-helpers.ts` (the
   tool and its calls are real, the host behind the tools is not), the same in a recording run and in its replay.
   A conversation whose app-server outlives a host (a swap under the keeper) is recorded from the swap on
   (`codex/swap-scenarios.test-helpers.ts`, `adopt-running` and `adopt-failed`) and replayed by `codex/adopt.test.ts`: the second
   `initialize` is refused, `thread/resume` answers `active` for a running turn and `systemError` for a failed one. A scenario with
   `settings: 'mcp'` runs against an MCP server of its own in the private `CODEX_HOME`. Codex 0.160's default tool set offers no
   plan tool, so no plan update is recorded.
   Codex's calls to Centralu's own tools need a real host behind the bridge, so they are recorded through one
   (`scripts/frames-record-host.mts`: the host from source in a temporary data folder, its own `HOME` and `CODEX_HOME`, driven over
   its WebSocket like a window; `codex/centralu-scenarios.test-helpers.ts`) and replayed by `codex/centralu.test.ts`, which does
   not compare a thread's `config` and tool instructions (the bridge's address and credential, words that change with the build).
   Past the host's own rules, the same script records the situations a host creates around a session: a context filled past
   `COMPACT_FLOOR_TOKENS` by four commands' output so `compact_self` really compacts (`centralu-compact-real`: the nudge steered into a
   running turn, refused by the app-server when the turn was ending, then `thread/compact/start` and the context falling from 124k to 6k;
   a bulky output is cut in the recording, `cutText`; the recording goes on past the compaction turn's own end into one more short turn,
   `after`, which shows the context read again from the summary); a session woken by mail (`centralu-wake`); `agent_session` send (recorded before
   #1948 made more work mail: replayed now, it is refused with the pointer to mail) and wait, and stop then delete of a child that is still working (`centralu-agent-stop`); and `ask_project` to a second project, refused
   while the project is untrusted and answered once trusted and once the other project has a session. `codex/centralu.test.ts` plays
   the host's part at the point of the recording where it acted.
   **Codex's own automatic compaction is not recordable on 0.160.0 with the limits tried:** the run reached 233k of the 258,400-token
   window, with `model_auto_compact_token_limit` set to 155,040, and Codex never compacted by itself. Only Centralu's compaction
   (`trigger: manual`) is recorded. The adapter's `auto` trigger is only checked by the hand-written frames in `codex/compact.test.ts`,
   which model an automatic compaction as a turn of its own where a real one may run inside a regular turn, until a run on a later
   version triggers it.
   Claude Code's are recorded the same way (`frames-record-host.mts claude`; `claude/centralu-scenarios.test-helpers.ts`: start_agent,
   agent_session, ask_project into a second, trusted project, and a refused call) with a `CLAUDE_CONFIG_DIR` holding a copy of the
   sign-in alone, put back if the CLI refreshed it. Its Centralu tools are an in-process MCP server, so `claude/centralu.test.ts`
   does not compare the host's answers to the CLI's `mcp_message` calls (`streamJsonCodec`'s `hostAnswers`). A Claude scenario's own
   settings are flags of its process (`settings: 'mcp'`: `--mcp-config` to the probe server; `'tasks'`: `--tools TaskCreate,...`,
   since a non-interactive CLI 2.1.296 offers no task-list tool by default), as its settings sources are off. Thinking has no
   setting: `thinking` is recorded as a session runs, with no flag for it (the model decides; the adapter asks for the text, #2062).
   The recordings also drive the UI's e2e scenarios (#1498): `adapters/frames/replay-agent.test-helpers.ts` makes a
   recorded session the agent of a running host (`--agent replay` of `e2e/fixtures/linked-host-main.ts`), the real
   adapter on a recording in place of the tool's process, and a session replays the scenario its working folder is
   named after. `e2e/replay.spec.ts` plays each entry of `REPLAYS` (`e2e/fixtures/replay-scenarios.ts`) through the real
   UI: it types the prompts the recording holds, presses Stop and restarts the agent where it holds them, and checks
   against what the recording holds the bubbles in their order, the tool calls (their number and names, and that they fold
   into lines), the Centralu call marks and the compaction marks, and that the adapter sent the tool nothing the
   recording does not hold. The spec is a Playwright project of its own (`replay` in `e2e/playwright.config.ts`: a shard is a run of
   tests in the order of the projects, so as part of one cut it fell all in one shard, and its single worker was a floor under that shard's time; CI plays
   it on its own, cut across every shard, `.github/scripts/e2e-shard.sh`), and the tests of its worker share
   one host, each reading only what the host says from the moment its run began and deleting its session when it is done. What the recording cannot say is in the entry: how an approval card is answered, what is on screen when
   Stop is pressed, and what the scenario draws of its own (the card log, the text of a folded line); a question card is
   answered with the option the recording holds. A test fails for a
   recording that has no entry and no reason in `NOT_PLAYED`. A new recording of a tool already in `REPLAYED` is one entry
   of `REPLAYS`; a new tool is one row of `REPLAYED` (its adapter, its `FrameCodec`, the options its session is given, its
   recordings folder) and one reader of its frames in `HELD`. A check that a tool's new version sends frames the recordings lack would read the same table: the
   version folder `newestVersion` picks against the installed tool's version, and the kinds of frame the host logs as
   unmapped (`unmapped message type`) against those the recordings hold.
   Claude and Codex are both rows of `REPLAYED`. Codex's recordings of the adapter alone (not made through a host) name no
   message, which a host does, so `codexCodec(cwd, { host: true })` accepts the name and gives it back on the app-server's echo of
   the message; a recording made through a host holds the names its host gave and is compared as it is. The host asks for the
   command list (`skills/list`) when it likes, so that is a probe (`skills`): answered from the recording if it holds an answer, else with the
   result an app-server answered a host with. The recordings of a kept
   app-server (`adopt-running`, `adopt-failed`) are not played: a replay host starts its processes itself and has no keeper to hold one;
   nor is `centralu-compact-real`, whose compaction the host starts after `compact_self`, a call a replay host never serves.

   **What a replay compares (#2068).** Every line the adapter sends the tool is compared with the recorded one, and a difference
   fails the run at once, naming the recording, its line and the JSON path (`claude-code-2.1.296/centralu-mail.jsonl line 26: the
   adapter's answer: first difference at response.behavior: the recording has "deny", the adapter sent "allow"`), not as a step that
   waits out its timeout (`ReplayState.failed`, raced by `drive`). Only what Centralu itself writes into the stream, from code in
   this repository, is checked against that code instead of the recorded bytes: Claude's `centralu` MCP server answers the CLI's
   `initialize` with instructions and `tools/list` with tool definitions, and the replay compares the instructions with
   `instructionsFor` and each tool's name, description and parameter names with `toolDefsFor` (`OwnAnswers`, `centraluAnswers` in
   `claude/replay.test.ts`). A change to a Centralu tool's words or parameters then needs no re-record, and the recorded
   `instructions` and `tools` may be anything that parses. The rest of those two answers (protocol version, capabilities, server
   info, the envelope) and every other line, the answers to the CLI's `tools/call` and to its approval requests included, are
   still compared byte for byte; a tool's parameter types, `required` and `_meta` are the SDK's rendering of the definition and
   are not compared. That keeps the recording honest: it shows what really went over the wire, and the replay still fails when
   the adapter stops answering the CLI as the CLI was answered. Codex and ACP recordings hold no
   such copy (Codex's `config` and tool instructions are skipped, `codex/centralu.test.ts`). A recording is scrubbed with a streamed
   text read joined (ACP and Claude chunks, Codex's item deltas), so a value cut across pieces, such as the random suffix of a
   recorder's temporary folder, is replaced whole; `frames/recordings-private.test.ts` fails when one survives in any frame.
4. Write down the vendor surface you depend on, and give it a drift check (see [vendor-drift-checks.md](vendor-drift-checks.md)) —
   hand-won protocol knowledge rots silently otherwise. Fill in the contract's `surface`
   (`adapters/contract/surface.ts`, #270) too: how to read what the tool offers without a turn,
   what the adapter blocks, drops or works around (each with its measurement), and a recorded
   baseline. The weekly drift run then watches the new tool in the other direction as well.
   An ACP tool is a profile on `adapters/acp/`; where its ACP differs from the common shape (its field names, a
   question sent as a permission request, a permitted call that runs under another id, a sign-in of its own, a log line
   that must not reach host.log), it fills `AcpProfile.shape`
   (`AcpToolShape`) rather than branching the core ([plans/antigravity-acp.md](../../plans/antigravity-acp.md) §2).
   A tool Centralu installs or signs in itself carries `AgentAdapter.setup` (`ToolSetupControl`): the host answers
   `agents.installTool` and `agents.signIn` through it and pushes its changes as `tool_setup` events. Every tool
   reports `DetectResult.setup` or gets one from its two booleans, so the screens read one shape for all
   ([plans/antigravity-acp.md](../../plans/antigravity-acp.md) §8).
5. Done. **ui, core and platform are unchanged**, and protocol changes only by the two
   entries in step 2. (If more was needed, that is not the adapter's fault but the protocol
   lacking a concept — consider extending the protocol first)

This claim used to be stronger and untrue: it said protocol was unchanged too, while in
practice a third tool meant editing roughly twenty hard-coded sites across eleven files —
three separate `TOOL_LABEL` maps, inline `tool === 'codex' ? … : …` ternaries in the sidebar
and the host, the badge letter, the install and login commands, and four literal
`['claude', 'codex']` arrays. The behavioural half of the boundary was always clean; the
presentational half leaked, which is the wrong way round, because it meant the cost of a new
tool was paid in small edits that this directory gave no hint about. `TOOL_META` exists so
that the sentence above can be true (#74).

**Capability never goes in `TOOL_META`.** What a tool *can do* is declared by its adapter
(`AdapterCapabilities`, `ModelOption`) and discovered at runtime; `TOOL_META` holds only how
to present it. Mixing the two is how a knob ends up having to be taught to the UI twice.

**A model's id is stored as given (#1989).** A full id such as `claude-opus-5-5` is a pin: Claude's list names it by the alias
`opus`, which may later name another model, so the host never rewrites one. The CLI's list says which model each alias names
(`resolvedModel`, carried as `ModelOption.resolved`); the screen reads a stored id as the one entry that names it
(`listedModel`, skipping `default`) and start_agent's check accepts it. Matching is exact, as the SDK defines `resolvedModel`: a 1M variant (`claude-opus-5[1m]`) and its base id are different
models, so an id nothing names reads "not in list" (and says nothing when no row of the tool carries `resolved`, as from an
older host).
