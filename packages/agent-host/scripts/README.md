# Scripts — seeing what automated tests do not

What is here is **verification against the real thing**. Unit tests face the fakes we built,
but a good share of this project's defects only showed up against a real CLI, a real PTY, a real packaged app.

The ones that actually call `claude` and `codex` **cost a small amount of money.** So they are
not wired into CI, and are run by hand when the related area changes.

## Wired into the build (automatic)

| Script | When it runs |
|---|---|
| `fix-pty-permissions.mjs` | `postinstall` — sets the execute permission on node-pty's spawn-helper |
| `bundle.mjs` | `pnpm bundle:host` — builds the host bundle for distribution (esbuild, target node22) |
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
```

## Probes — kept as the basis for a decision

These are not throwaway scripts; they are **the record that code comments point to as their basis**.
They are kept so that whoever asks "why was it built this way" can run them again.

| Script | What it measured, and what it decided |
|---|---|
| `probe-askuserquestion.mts` | how AskUserQuestion is actually received, and which of four answers (`--mode A\|B\|C\|D\|all`) reaches the model → `adapters/claude/index.ts` answers with `updatedInput.answers` (mode D, #241) |
| `probe-permission-mode.mts` | can the permission mode override the global setting on a per-session basis (M0's top-priority premise) |
| `probe-subagent-stream.mts` | how a subagent's messages get mixed into the parent stream (#98) → `adapters/claude/normalize.ts` splits them by parent_tool_use_id, and closes the background agent card on task_notification |
| `probe-codex-file-approval.mts` | what `item/fileChange/requestApproval` carries (only `itemId`, no change) and that the `fileChange` item with the diff starts 1ms before it (#169) → `adapters/codex/index.ts` remembers each item's changes by id for the card |
