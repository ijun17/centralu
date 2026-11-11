# Claude query options and independent-session messaging (#569)

`ClaudeSession.start` is the single SDK `query({ options })` construction site. Both
`SessionManager.createSession` and the resume/wake path use it, for ordinary sessions,
assistants, coordinators, worktree managers, builders, app agents and `start_agent` children.
The two build the adapter's options in one place (`SessionStarts.launchOptions` in `sessions/session-start.ts`, #428), so an option
added there reaches a new session and a wake alike (`sessions/sleep.test.ts`).
Its `spawnClaudeCodeProcess` callback sends the SDK's flags and environment to either the local
spawn or the keeper; a fresh keeper replacement therefore receives the same options.

`withoutCrossSessionMessaging` wraps the existing options in the Claude adapter, under every preset: `auto` too
(the mailbox plan's slice 0, §9.6; this narrows #603 for this one control). It merges inline SDK flag settings
with `crossSessionInbound: 'refuse'`, appends discovery denies `ListAgents` and `ListPeers`,
and merges `process.env` and any explicit environment with `CLAUDE_CODE_HARBOR_KITE: '0'` last, without `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`.
The Claude launch fingerprint (`launchSettingsFingerprint`) is version 3 for `auto`, so a kept `auto` process started before the controls is restarted once by the #589 path.
The adapter previously selected settings files only through `settingSources`; inline `settings`
are a separate layer and do not replace that selection, permission options, MCP servers or
resume IDs. `SendMessage` is deliberately left available for this query's own subagents.

The environment gate disables peer discovery, cross-session sends and inbox binding in the
inspected CLI versions 2.1.263–2.1.299. It is undocumented, version-sensitive and undoable by the `env` of the person's user settings, so the
documented refusal and discovery denies stay as additional controls. They do not alone block
every outbound send to a known peer if the gate changes. A process started before the controls does not have them.
The `auto` launch fingerprint is version 3, so a host that finds such an `auto` process restarts it once through the
normal launch-settings path (#589): at once when it is idle, after its current turn otherwise. Since #1895 step 4 PR 1
no process outlives its host, so every process a host runs it started itself. Nothing needs to be restarted by hand.
See [security-boundaries/inter-agent-content.md](../../security-boundaries/inter-agent-content.md).

The regression matrix in `sessions/setting-files.test.ts` checks the options for each kind on
start and resume across trust and permission presets; adapter tests check merging and the keeper
spawn path. For runtime validation before SDK/CLI upgrades, run
`pnpm exec tsx packages/agent-host/scripts/probe-cross-session.mts`: two Haiku sessions in
temporary folders, with Centralu's shared controls, test discovery, delivery and `SendMessage`
to its own background subagent. This is a manual billable probe; it requires sockets and Claude sign-in,
sets a temporary `CC_DATA_DIR`, and never starts a host or uses `~/.centralu`.
