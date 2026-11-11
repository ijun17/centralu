# Vendor-surface drift checks (run these before any SDK/CLI upgrade)

Everything we know about a vendor's protocol was learned by measuring, and a vendor
upgrade can un-learn it without an error anywhere. Each adapter therefore keeps an
explicit list of every vendor name it touches, and a script that re-verifies the list:

| Tool | Contract | Check | What it catches |
|---|---|---|---|
| Codex | `adapters/codex/protocol-contract.json` — every RPC method and notification we send or read, plus approval enum values; and `adapters/codex/generated/`, the types the host imports from it and what those import, which the adapter is compiled against (#1339) | `pnpm codex:bindings --check` (regenerates bindings from the installed CLI, greps for our names, and compares generated/ with what it makes) | a method/notification leaving the protocol (change axis C4), and a type the adapter reads changing |
| Claude | name lists inside `scripts/claude-sdk-drift.mjs` — SDK exports, option keys, response fields — plus a runtime argument probe: every explicit `permissionMode` must reach the CLI unchanged, accepting both `--permission-mode value` and `--permission-mode=value`; spawn is intercepted so no CLI runs (#578) | `pnpm drift:claude [version]` (installs `@latest`, or the given version, into a temp dir, never the workspace) | a name leaving the `.d.ts`, or the SDK dropping, rewriting or bypassing an explicit mode, **before** an upgrade lands it on us |
| Claude (resume) | that a resumed process reads the prompt cache as a live one (#568, [../lifecycle/agent-cli-updates.md](../lifecycle/agent-cli-updates.md#putting-idle-sessions-to-sleep-568)): what makes putting idle sessions to sleep free | `pnpm exec tsx packages/agent-host/scripts/probe-resume-cache.mts` (live, haiku, a temporary data folder; exits 1 when the woken turn reads under 90% from cache) | a CLI whose resume rebuilds the request differently: sessions would still wake, only slower and dearer, and nothing else would say so |
| Every adapter (the other direction, #270) | the contract's `surface` (`adapters/contract/surface.ts`): a reader of what the installed tool offers (Claude: the SDK's stdout message union, its `Options` keys and `Query` methods, and the CLI's `--help`; Codex: the generated client request, notification and server request methods, and its `--help`), the adapter's `limitations` (what it blocks, drops or works around, each with its measurement), and `adapters/<tool>/surface-baseline.ts` (what was last reviewed) | `pnpm drift:surface` (reads the latest published tools without a session or a turn; `--record` rewrites the baselines, `--file-issue` is the weekly job) | a command, message type or capability the tool now offers that nobody reviewed, a limitation whose reason may be gone (`/goal` stayed refused for weeks after the CLI ran it headless), or one on a name the tool dropped. Filed as one issue per tool; the job stays green |

The surface check is news, not a break, so it files an issue instead of going red. What was reviewed is
accounted for by test: every message type in an adapter's baseline is mapped, ignored on purpose, or a
limitation (`claude/surface.test.ts`, `codex/surface.test.ts`), and a `dropped` one stays out of the known
set so `UnmappedTypes` still logs its first instance. Claude's slash commands are listed only by a running
CLI, so they are compared at run time instead: the init message's `slash_commands` against the command
limitations, one host.log line each (`initSurfaceLines`); a limitation the adapter already follows by
itself (`followsOffer`, `/goal`) says nothing.

Claude's `normal` preset resolves `permissions.defaultMode` with the SDK's `resolveSettings` and
`filterEscalatingDefaultMode`, using the same settings sources as the session, then sends it explicitly.
With no valid mode, or a failed read, it sends `default` so tool calls needing permission still reach
`canUseTool`. A session reading no settings files carries only the person's user-tier mode (#382).
A configured bypass still bypasses the callback; neither an absent mode nor an escalating mode in a
committed project file selects bypass. Normal's launch fingerprint is now v2: after a keeper handoff,
the host refresh restarts retained v1 processes, immediately when idle or after the current turn finishes
(#589). The resumed process receives the explicit mode. Safe's derived flags did not change, so its
fingerprint stays at v1. Auto's is v3 since the cross-session controls reached it (the mailbox plan's slice 0): a kept `auto`
process from before them is restarted the same way, once.

Released betas since beta.1 sent no `--permission-mode` under `normal`. With the person's Claude Code
CLI >= 2.1.285 and a third-party provider or telemetry off, headless sessions start in auto mode when
no configured settings mode overrides that default: a classifier, rather than Centralu's approval,
decided tool use. The exposure depends on the person's installed CLI, not just the pinned SDK.

The [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
records two separate changes: 0.3.286 leaves an omitted mode to the CLI, which can choose its automatic
classifier without a configured mode; 0.3.295 encodes named options as `--flag=value`. The latter broke
our old minified-source regex in 0.3.296. Both 0.3.263 (the lockfile pin) and 0.3.296 preserve explicit
modes in the spawn probe. This verifies argument building, not live CLI approval decisions.

Both are name checks (Claude's argument probe aside), run in both directions: the vendor must still carry every name
we use, and our source must still use every name listed (so the contract cannot
outlive the code). They cannot catch a field that still exists but changed meaning —
that class is guarded by runtime plausibility checks in the adapters (the
`149,084%` context-gauge lesson). Nor can they catch a notification that keeps its name but
stops arriving: the Codex compaction marker came only from `thread/compacted`, which stays in
the bindings (marked deprecated in favour of the `contextCompaction` item) while no measured
CLI sends it, so no Codex compaction left a marker ([#303](https://github.com/ijun17/centralu/issues/303)).
A probe against the real binary (`scripts/probe-codex-*.mts`) is the check for that class.

**The rule that keeps them honest:** when adapter code starts depending on a new
vendor name — a new notification, a config key, a field — add it to the contract
**in the same PR**. A new tool (step 4 above) starts by creating its own equivalent
of one of these.

**The other direction, at runtime: unmapped types** ([#58](https://github.com/ijun17/centralu/issues/58),
[#270](https://github.com/ijun17/centralu/issues/270)). The checks above notice a name we use leaving the vendor's
surface. They cannot notice a type we do not use *arriving*, and protocol.md §4 makes an adapter drop what it does not
know. So each adapter keeps a second list, of every type it maps or leaves out on purpose
(`CLAUDE_KNOWN_TYPES` and `CODEX_KNOWN_NOTIFICATIONS`, grouped as in the #58 survey). The first time a session
receives a type outside that list, `adapters/unmapped.ts` writes one host.log line:
`[claude] 1a2b3c4d unmapped message type: system/permission_denied`. Nothing on screen changes. Types the survey wants shown
but nobody has wired yet stay off the list on purpose, so their first real instance is a grep away. When you wire one,
or decide it is noise, move it onto the list in the same PR. Server *requests* need no list: the Codex adapter already
logs every request it answers with `{}`. The weekly counterpart, which hears of a type before any session receives
it, is the surface check in the table above: a `dropped` limitation there is exactly a type kept off this list.
