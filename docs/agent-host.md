# Agent Host — the Node sidecar design

A standalone Node process. In dev the developer starts it directly (`pnpm host`); in prod Tauri spawns and watches it. **It has to behave the same whether or not a UI is there** — the UI can be closed and reopened many times (reconnecting) and the host keeps its sessions.

## 1. Internal structure

```
agent-host/src/
├─ main.ts              # CLI (--port --token --dev-services), startup order, and the
│                       #   tool → adapter registry (a Map literal; there is no registry.ts)
├─ rpc.ts               # RPC method dispatch
├─ transport/
│  ├─ server.ts         # ws server, handshake, RPC routing
│  └─ event-log.ts      # assigns seq, ring buffer, afterSeq replay (protocol §1)
├─ adapters/
│  ├─ contract.ts       # AgentAdapter interface + capability types
│  ├─ claude/           # based on the Claude Agent SDK (incl. orchestrator-mcp.ts)
│  └─ codex/            # app-server JSON-RPC client (written here, incl. the stdio bridge)
├─ sessions/            # session lifecycle, orchestrator tools, app guide
├─ dev-services/        # git/fs/store (the store is not dev-only — it is where messages live)
├─ log-file.ts          # tees stderr to ~/.centralu/host.log (stdout is reserved, see below)
├─ env-path.ts          # PATH augmentation — a GUI app inherits no login-shell PATH
├─ data-dir.ts          # locating and migrating the data directory
└─ updates.ts           # update checks
```

Usage parsing and the orchestrator's MCP surface do **not** have their own directories:
per-account usage lives in `adapters/<tool>/usage.ts` (it is a per-tool question), and the
orchestrator's tools are defined once in `sessions/orchestrator-tools.ts` and exposed per
adapter — in-process for claude, over a stdio bridge for codex.

**stdout is reserved.** `main.ts` prints exactly one line to it: the handshake the Tauri
supervisor parses for the port and auth token. Everything else goes to stderr, because that
is what `log-file.ts` tees to `~/.centralu/host.log` — and a `.app` launched from Finder has
no stdout destination at all, so a `console.log` here reaches nobody in production while
looking fine in a terminal. `no-console` in `eslint.config.js` enforces this everywhere in
the package except that one line.

## 2. The AgentAdapter contract (the implementation spec for product spec §6.2)

```ts
interface AgentAdapter {
  readonly tool: ToolName                  // a closed enum in @cc/protocol — see #74
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>          // installed / logged in (FR-19)
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>
  resume(externalId: string, opts): Promise<SessionHandle | null>  // null = resume not possible
}

interface SessionHandle {
  readonly externalId: string
  send(input: UserInput): void
  respondApproval(requestId: string, decision: Decision, scope?: Scope): void
  interrupt(): void
  dispose(): Promise<void>
  events: Emitter<NormalizedEvent>         // emits protocol types only
}

interface AdapterCapabilities {
  approvals: boolean            // can permissions be overridden per session (reflects the M0 result)
  contextUsage: 'exact' | 'estimate' | 'none'
  resume: boolean
  autoTitle: boolean
  attachments: ('image' | 'file')[]
  verbosities: string[]         // response-length steps; empty = the tool has no such knob (#54)
}
```

Implementation rules:

- **External SDK types may not leave adapters/<tool>/** (anti-corruption). The adapter's only output is `NormalizedEvent`.
- Adapters hold no state — tracking session state is done by `sessions/` watching events. The adapter is a converter.
- Process management (spawning the CLI, crash detection) is the adapter's own responsibility. A crash is emitted as an `error` event and the host does not die.
- A capability is not necessarily a static declaration; it can be **decided at detect() time** (e.g. if whether approvals work depends on the Codex version, decide after detecting the version — the C4 response).

## 3. Procedure for adding a new tool (C3 — the reason this document exists)

1. Create `adapters/<tool>/` and implement `AgentAdapter` (event conversion + detect + capability).
2. Add the tool to `ToolName` and give it a `TOOL_META` entry in `@cc/protocol` — display
   name, one-glyph mark, install command, login command. Then register the adapter in the
   `adapters` Map in `main.ts`.
3. Add contract tests: recorded raw response fixtures → NormalizedEvent snapshot verification.
4. Write down the vendor surface you depend on, and give it a drift check (see §3.1) —
   hand-won protocol knowledge rots silently otherwise.
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

### 3.1 Vendor-surface drift checks (run these before any SDK/CLI upgrade)

Everything we know about a vendor's protocol was learned by measuring, and a vendor
upgrade can un-learn it without an error anywhere. Each adapter therefore keeps an
explicit list of every vendor name it touches, and a script that re-verifies the list:

| Tool | Contract | Check | What it catches |
|---|---|---|---|
| Codex | `adapters/codex/protocol-contract.json` — every RPC method and notification we send or read, plus approval enum values | `pnpm codex:bindings --check` (regenerates bindings from the installed CLI, greps for our names) | a method/notification leaving the protocol (change axis C4) |
| Claude | name lists inside `scripts/claude-sdk-drift.mjs` — SDK exports, option keys, response fields, and runtime-only names like `resolvePermissionModeInCli` | `pnpm drift:claude` (installs `@latest` into a temp dir, never the workspace) | a name leaving the `.d.ts` or the runtime **before** an upgrade lands it on us |

Both are name checks, run in both directions: the vendor must still carry every name
we use, and our source must still use every name listed (so the contract cannot
outlive the code). They cannot catch a field that still exists but changed meaning —
that class is guarded by runtime plausibility checks in the adapters (the
`149,084%` context-gauge lesson).

**The rule that keeps them honest:** when adapter code starts depending on a new
vendor name — a new notification, a config key, a field — add it to the contract
**in the same PR**. A new tool (step 4 above) starts by creating its own equivalent
of one of these.

## 4. Session lifecycle and UI reconnection

```
UI disconnects  → the host does nothing (sessions carry on, events accumulate in event-log)
UI reconnects   → hello → subscribe({ afterSeq }) → replay the missed events → restore the screen
host restarts   → session processes die → attempt resume with the externalId from the store
                  (the same path as FR-10)
```

Thanks to this design, half of FR-10 (restore on restart) is the same code path as an ordinary reconnect — it is the default behaviour, not a special case.

## 5. dev-services (despite the name, this is the prod path — corrected 2026-08-15)

When the Node sidecar became the deployment path in M1.5, the plan to "move it to Rust at Tauri step 4 and delete it"
was **put on hold**. This directory is used as is in prod today. The name is a historical remnant.

- **git**: spawn the `git` CLI + parse `--porcelain=v2/-z`. status·diff·log·branches·checkout·stage·commit·push.
  Moving to git2 (Rust) **is not done until measurement confirms a bottleneck** (m2-plan decision 3).
  The port interface is the same, so moving it later leaves the UI unchanged.
- **store**: better-sqlite3 + a `user_version` migration runner. The schema DDL lives in exactly one place,
  `protocol/src/schema/schema.sql`. In the bundle it is copied next to the build output and ships with it (F-0).
- **fs**: lazy readdir listing + `git check-ignore` (once per directory) + path escape blocking.
- **attachments**: saves pasted images to `~/.centralu/attachments/<sessionId>/`.
- The `--dev-services` flag **does not exist** (the document got ahead of itself). Everything is always loaded.

## 6. Usage and limits (FR-9)

**We ask the tool, we do not read its files.** `agents.usage` → `SessionManager.usageFor(tool)`
→ the adapter's optional `listUsage()`, which calls the tool's own API (the Claude SDK for one,
`app-server` for the other). An adapter that cannot answer throws, and the manager degrades
with the reason attached rather than showing a confident wrong number.

Usage is an **account** property, not a session or directory one, which is why `listUsage()`
takes no arguments — the answer is the same whichever folder you ask from. Only subscription
limits are in scope; metered credits are not.

This section used to describe something else entirely: a chokidar watcher parsing
`~/.claude/projects/**` and `~/.codex/sessions/**` incrementally, writing `usage_facts` rows
that a `usage.weekly` RPC would read, with aggregation in `core/usage`. **None of it exists** —
chokidar is not a dependency, `core/usage` is not a directory, there is no `usage.weekly`
method, and while `usage_facts` is still in `schema.sql` no code reads or writes it. It was
also the *opposite* of the rule §8.1 states, and the two sections sat in this file
contradicting each other. Reading a tool's private JSONL is exactly what §8.1 forbids, for
the reason given there: an undocumented format breaks silently on upgrade, and a silent break
in a number is worse than a missing number.

## 8. Importing previous sessions (external sessions)

The path for taking over a conversation started outside Centralu — in a terminal.
`+ → pick a tool → previous conversation list` in the session creation modal is this feature's entrance.

### 8.1 Principle: use only official APIs

Both tools leave transcripts on disk
(`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`).
**We do not parse those files directly.** That format is not a documented contract, so it
breaks silently when the tool is upgraded, and you end up showing the wrong conversation without knowing it broke.

| | List | Read the conversation |
|---|---|---|
| Claude Code | SDK `listSessions({ dir })` | SDK `getSessionMessages(id, { dir })` |
| Codex | app-server `thread/list { cwd }` | app-server `thread/read { threadId, includeTurns }` |

Responsibility for version compatibility sits with the tool — each API reads the storage format its own version wrote.
What we have to maintain is only **the conversion from a response into a conversation**, and that conversion is separated out
as a pure function so it can be verified without starting the tool (`adapters/history.test.ts`).

### 8.2 Compatibility with older tool versions

Not being able to fetch a list and not being able to create a session are different problems.
**Using an old tool version does not also block creating new sessions.**

- Claude: dynamic import + check the function exists. If it does not, 'not supported' instead of the module load blowing up.
- Codex: a server that does not know `thread/list` returns JSON-RPC `-32601`.
  This is treated not as an exception but as a normal negotiation outcome, and the reason is passed upward.
  But a genuine fault (`EACCES` etc.) is not hidden behind 'not supported' — the cause has to be visible.

That is why `agents.listExternalSessions` does not throw but returns `{ supported, reason?, sessions }`.
The UI draws `supported: false` as guidance, not as an error.

### 8.3 Cleaning up the conversation

Both tools inject their own system text into user turns
(`<system-reminder>`, `<ide_opened_file>`, `<system_instruction>`, traces of slash commands).
In practice, a list title came out as `<system_instruction>You are working inside…`
and the first conversation as `<ide_opened_file>…`.

`adapters/history-text.ts` strips only these blocks — it does not throw the whole thing away,
because real user speech often follows an injected block.
Only when nothing is left after stripping is the line dropped.
Tool calls and results are dropped, keeping only the name: the point of importing is to get the conversation back,
not to resurrect the execution log.

### 8.4 The identity of an imported session

- The tool is sent a `resume` → the model's actual context continues.
- The screen restores the last `HISTORY_LIMIT` (200) lines → this is a **snapshot for display**.
- The restored conversation is marked `lastReadSeq = lastSeq`. Do not summon a human for a conversation they have already read.
- Which conversation was taken over is recorded in `sessions.imported_from` (schema v5).
  `external_id` cannot tell you — the tool may **issue a new identifier** when resuming,
  making it differ from the original, at which point the 'already imported' mark in the list is wrong every time.
- If the record cannot be read, the session still lives. Failing to read a record is no reason to block the conversation too.
