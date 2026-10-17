# Scripts — seeing what automated tests do not

What is here is **verification against the real thing**. Unit tests face the fakes we built,
but a good share of this project's defects only showed up against a real CLI, a real PTY, a real packaged app.

The ones that actually call `claude` and `codex` **cost a small amount of money.** So they are
not wired into CI, and are run by hand when the related area changes.

## Wired into the build (automatic)

| Script | When it runs |
|---|---|
| `fix-pty-permissions.mjs` | `postinstall` — sets the execute permission on node-pty's spawn-helper |
| `bundle.mjs` | `pnpm bundle:host` — builds the host bundle for distribution (esbuild, target node22); `CC_BUNDLE_OUT` names another (absolute) output folder |
| `codex-bindings.mjs` | `pnpm codex:bindings` — generates codex protocol types and refreshes the dependent contract |

## Verification wired through npm scripts

```bash
pnpm smoke               # exercises the host end-to-end with a real Claude session
pnpm smoke:resume        # does resume actually continue
pnpm smoke:codex         # exercises the Codex adapter end-to-end
pnpm smoke:orchestrator  # orchestrator + MCP tools
pnpm smoke:schemas       # does the protocol schema match the real thing
pnpm smoke:question      # AskUserQuestion round trip
pnpm smoke:perm          # does the permission preset actually load onto the session
pnpm smoke:usage         # does usage have the same shape across both tools
pnpm smoke:context       # does the context gauge produce a sensible value
pnpm smoke:models        # do both tools give a model list
pnpm smoke:terminal      # exercises the terminal with a real PTY
pnpm smoke:orphan        # behavior when the session disappears on the tool's side
pnpm perf:idle           # idle performance (host process only, against the §7.1 target)
pnpm measure:tools       # what Centralu's MCP tools cost (#513): dry by default, --live for real models
pnpm remote-dev <machine> --ref <commit> --repo <path there>  # a dev build of the host on a linked machine (#1036)
```

`remote-dev.mts` builds the host on a linked machine from one commit of a working copy there and swaps to it
(docs/plans/remote-hub.md §10.11); Settings → Machines' "Roll back" returns to the release. It spends nothing.

`measure-tools.mts` is the one to run before and after a change to how tools are exposed: dry it
spends nothing (the real Claude CLI talks to a fake API), `--live` measures tokens, cache rebuilds,
tool selection and result growth, and `--compare a.json b.json` sets two runs side by side. `--rare`
starts the host with the orchestrator's rare commands behind `centralu_run` (the default), resident or
deferred (#512, with `measure-tools/prompts-512.json`); `--reader-instructions` and `--preamble` (`on` or
`off`) start it with or without the rule of #564 on each seat (with `measure-tools/prompts-564.json`). How to
read it, and the baseline:
[docs/tool-cost.md](../../../docs/tool-cost.md).

## Probes — kept as the basis for a decision

These are not throwaway scripts; they are **the record that code comments point to as their basis**.
They are kept so that whoever asks "why was it built this way" can run them again.

| Script | What it measured, and what it decided |
|---|---|
| `probe-askuserquestion.mts` | how AskUserQuestion is actually received, and which of four answers (`--mode A\|B\|C\|D\|all`) reaches the model → `adapters/claude/index.ts` answers with `updatedInput.answers` (mode D, #241) |
| `probe-codex-message-boundary.mts` | two Codex agent messages with nothing recorded between them: a `write_stdin` poll arrives as `item/commandExecution/terminalInteraction`, not an item (#212) → `adapters/codex/normalize.ts` names each chunk's message, and `sessions/manager.ts` starts a new row when it changes |
| `probe-permission-mode.mts` | can the permission mode override the global setting on a per-session basis (M0's top-priority premise) |
| `probe-subagent-stream.mts` | how a subagent's messages get mixed into the parent stream (#98) → `adapters/claude/normalize.ts` splits them by parent_tool_use_id, and closes the background agent card on task_notification |
| `probe-codex-subagent.mts` | what a Codex child agent sends on the parent's connection: its items with its own `threadId`, no `thread/started`, and the first of them before the `spawnAgent` `item/completed` that names it in `receiverThreadIds` (#222) → `adapters/codex/index.ts` holds a child's items until the link, then tags them with that card |
| `probe-subagent-record.mts` | `claude` or `codex`: one real turn that launches one subagent, through the adapter, `SessionManager` and a file store under `CC_DATA_DIR`; prints the conversation and the steps under each launch card (#222) |
| `probe-codex-file-approval.mts` | what `item/fileChange/requestApproval` carries (only `itemId`, no change) and that the `fileChange` item with the diff starts 1ms before it (#169) → `adapters/codex/index.ts` remembers each item's changes by id for the card |
| `probe-background-tasks.mts` | `--mode interrupt\|stop`: what a Claude turn's interrupt and `stopTask` do to a background subagent and a backgrounded shell (#290) → interrupt stops the subagent (`task_notification` stopped) and leaves the shell running; `adapters/claude/background-tracker.ts` marks each task with `stopsWithTurn`, and the session's Stop says which stop and which continue |
| `probe-reader-tools.mts` | what each shape of the ordinary sessions' reader set costs in first-request input tokens, and whether a deferred tool is still called (#320) → `sessions/orchestrator-tools.ts` merges listing into `read_session` and defers only `app_guide`; `smoke-reader.mts` runs the shipped set end to end through a host (`TOOL=codex` for Codex) |
| `probe-codex-mcp-instructions.mts` | whether a Codex model sees an MCP server's `initialize` `instructions` (no) or the thread's `developerInstructions` (yes), whether `thread/resume` takes new developer instructions (no), and that a thread cannot be resumed before its first turn (#524, #525) → `sessions/orchestrator-tools.ts` `codexToolInstructionsFor` rides in the thread's developer instructions at start, and `adapters/codex/index.ts` names a started thread only at its first turn |
| `probe-codex-background.mts` | `--mode interrupt\|stop`: what `turn/interrupt` on the parent, and on the child's own turn, does to a Codex child agent (#290) → the parent's interrupt leaves the child running; interrupting the child's turn stops it, which is the per-task stop `adapters/codex/index.ts` offers |
| `probe-resume-cache.mts` | whether a Claude session the host put to sleep reads the prompt cache when a message wakes it (#568), through a real host with `CC_SLEEP_AFTER_MS` → `capabilities.sleep` on the Claude adapter rests on it. Run it on a Claude Code update, beside `pnpm drift:claude`; it exits 1 under 90% read |

## Fixtures

| Script | What it writes |
|---|---|
| `write-store-fixture.mts` | a store written through the `Store` API of an older checkout, printed as SQL, for `src/dev-services/store-older-builds.test.ts` (#845). The steps to run it against an older commit are in its header; it costs nothing and starts no model |
