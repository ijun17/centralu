# The `edits` preset (#1525, owner 2026-10-24)

A fourth preset, between `normal` and `auto` (`safe` < `normal` < `edits` < `auto`). **`edits` is `normal` plus one
grant**: a file edit inside the session's project folder (or its worktree) raises no card. Everything else is
`normal`'s, in every row of the table below: commands, deletes, paths outside the folder, network access and runs
outside the sandbox ask; the person's own bypass applies as under `normal`, and `edits` never asks more than `normal`
would. `normal` keeps its meaning (the person approves each step).

- **Preset, not a hidden default.** A default that made `normal` accept edits in a trusted project would put a word
  on the picker that is not true of the session, and an explicit `normal` could not be told from the default. So the
  picker lists `edits` ("No card in project"). The **default** moved on since (owner decision 2026-11-05): the window
  names the preset when the person starts a session without choosing one, `auto` in a **trusted** project, on this
  computer or a linked one, and `normal` in an untrusted one (`defaultPresetFor`, `@cc/protocol`, read in `createSession` of
  the store; #1525 made it `edits` in a trusted local project). A preset named in the start, the settings menu, a handoff
  or a fork always wins and is never raised, and a session that exists keeps its preset. The host's own default for a
  client that names none stays `normal` (`CreateSessionParams`): the window and a hub always name one, and a script's
  start with the limited credential runs unasked (owner, 2026-10-21), so it must not get `auto` from a default; naming
  `auto` or `edits` there asks first (`presetAbove`, `transport/method-rights.ts`). A linked machine's project gets `auto` as well: every linked build knows `auto` (`edits`
  stays off the link, since a build from before it refuses a value it does not know). The stored and shown preset is the
  one the session runs under. There is no per-project default preset to override (the per-project choice is the
  project's trust).
- **Mapping to Claude.** Not `acceptEdits`. The SDK's mode also approves `rm`, `rmdir`, `mv`, `cp`, `sed`, `mkdir` and
  `touch` inside the working directory (Claude Code's documentation, "acceptEdits"), which would let deletes and
  commands through. `edits` launches exactly as `normal` does (the trusted settings mode, else `default`) and `canUseTool`
  allows `Edit`, `MultiEdit`, `Write` and `NotebookEdit` whose target is inside the session's folder
  (`adapters/edit-grant.ts`, the shape of the read grant, #371). A person's `acceptEdits` or bypass setting stays as it is
  (it decides before `canUseTool`). **The person's own `ask` rules win**: when their settings (the sources the session
  reads, the policy tier included) have an `ask` rule for `Edit`, `Write`, `MultiEdit` or `NotebookEdit`, or the settings
  cannot be read, the session has no grant at all (`editAskRuleExists`; the rule's path pattern is the CLI's syntax and is
  not matched, so `ask: ["Write(secret/**)"]` leaves every edit of that session asking). An ask the CLI says a rule forced
  (`matchedAskRule`) is a card too, and so is an ask whose `decisionReason` is anything but empty or the permission mode asking: the SDK documents it as free text, so only a short allowlist of known benign reasons
  grants (`benignAskReason`) and an unknown or reworded reason fails closed. These two options are a second line: measured on Claude Code 2.1.296, an `ask` rule reached `canUseTool` with
  both undefined, so the card for a plain ask rule comes only from `editAskRuleExists`.
- **Mapping to Codex.** Codex has no mode that accepts patches and asks for commands: its approval policies gate the
  sandbox boundary, not the kind of action (`on-request` runs sandboxed commands without a card). So `edits` is
  `normal`'s launch (the person's own policy and sandbox, network off) and the adapter answers an
  `item/fileChange/requestApproval` (or the older `applyPatchApproval`) with accept when every change of the patch is an add or an update inside the folder
  (`adapters/codex/server-requests.ts`, `adapters/edit-grant.ts`). A delete, a move, a request that names extra access
  (`grantRoot`, a `reason`), or a path outside asks. Under Codex's default
  config (workspace-write, on-request) in-folder patches already ran without a card, so there `edits` and `normal`
  differ only where the person's config asks.
- **What is never granted.** The folder is the session's `cwd` after symlinks are resolved (a link out of it is
  outside, and so is a link whose target does not exist yet), compared by path segment (`/proj-other` is not inside
  `/proj`). A folder that is the person's home folder, holds it, or is the root of any disk gets no grant. Inside the folder, the names that
  decide what runs or what is allowed still ask, at any depth and in any case: `.git`, `.gitconfig`, `.gitmodules`,
  `.githooks`, `.husky`, `.pre-commit-config.yaml`, `.github/workflows`, `.claude`, `.claude.json`, `.codex`, `.agents`,
  `.mcp.json`, `.vscode`, `.idea`, `.devcontainer`, `.centralu`, the shell startup files (`.bashrc`, `.zshrc`, `.profile`,
  ...), `.envrc`, `.ripgreprc`, the package managers' config (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`,
  `.cargo/config`, `.cargo/config.toml`) and `node_modules` (a hard link there reaches other projects). `CLAUDE.md` and `AGENTS.md` stay
  editable. A segment with a `:` asks (a Windows stream such as
  `.mcp.json::$DATA` writes the file it names). A path that cannot be resolved asks. The check reads the disk once,
  before the write: another process that swaps a link in between is not stopped by it. A person who picks `edits` in an
  untrusted project gets the grant too (their choice wins); only the default is tied to trust. The preset is read at each call: changing between `normal` and `edits` replaces no
  process (`launchPreset`, `SessionHandle.setPermissionPreset`) and takes effect in the next call, while a change that alters
  the launch (to or from `safe` or `auto`) still restarts at the end of the turn.
  **What the grant is not:** edits to project files are code the person later runs. Under `edits`, an `allow` rule (or the
  person's bypass) for a command that runs project code (`npm test`, `make`, a script) amounts to running anything the agent
  wrote into the project, with no card for it. The protected names narrow where that starts; they do not close it.
- **Agent-started sessions.** The default applies only to a session the person's window starts. `start_agent`'s child
  gets the caller's preset, never above it (`presetWithin`, rank updated), so a `normal` caller's child is `normal`
  in a trusted project and an `edits` caller's is `edits`. `edits` is treated as `normal` by the consent (the project's
  trust is a `normal` or `edits` caller's consent, #673), the ceiling (4, `auto` has none), `ask_project`, the answer
  rules and `update_centralu`. A linked machine's child (`start_agent` with `machine`, `create_session`, `normal` at
  most on the link) is `normal` for an `edits` caller, and the caller's preset that `fromHub` carries goes as `normal` too
  (`carriedPreset`, `makeChild`): `edits` is never put on the link, so an older machine never sees a value it does not know. A build since #1171 reads a stored `edits` as `safe` (its store parses unknown presets
  to `safe`), and an earlier one passes it through as an unknown preset that asks like `normal`: neither asks less.

## Turning things off

The table describes `safe`/`normal`. Under `auto`, project trust and revoked remembered
consents do not close delegation or attachment; the session's preset is checked on each call.
Auto attachments are recorded separately from consent grants and stop counting after a preset
downgrade. The app-sharing switch still applies to every preset. The session-tools switch is gone (always on,
2026-10-20).

| Change | assistant | scoped | builder | reader |
|---|---|---|---|---|
| "Let sessions look at other sessions" off (an older window sending it, or a record an earlier build stored) | — | — | — | No change: the reader set is always on (owner decision 2026-10-20). The host reads the switch as on (`UiPreferencesCommands.uiPreferences`), does not store an "off" (`setUiPreferences`), and neither the profile rule (`toolProfileFor`) nor the reader set (`readerToolsFor`) reads it, so its calls, the bridge's `toolProfileOf` and apps it attached are unaffected |
| Its project loses trust | No change (reads no project files) | No change (reads no project files) | Its app stops, so `check` cannot start it | Settings files at the next start; its project's apps stop and leave at once; `find_apps` and `attach_app` refused; apps it attached leave at once. `ask_project` and `start_agent` refused (#382, #561); its standing `start_agent` cards, its sessions' `ask_project` and fork cards, and its queued `ask_project` requests are withdrawn and their callers told (#673); those of an `auto` session stay, and are read again at delivery |
| The other project loses trust | — | — | — | Apps attached from it leave at once; `ask_project` to it still runs, its card says it is not trusted, and the existing target session follows its trust |
| The person revokes a pair in Settings | — | — | — | Apps attached under "always" leave at once; the next `ask_project` or `attach_app` asks again, and an `ask_project` request for the pair still queued is withdrawn (one an `auto` session queued stays, and is read again at delivery); for a project's `agents` row, the next `start_agent` of a `safe` session asks again (a child already running is left to finish; a `normal` session needs no row in a trusted project, #673) |
| Sharing of an app turned off | — | — | — | Leaves every session that attached it |
