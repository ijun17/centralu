# Antigravity through Google's ACP agent (#59)

Proposed 2026-10-27, with the host side built in the same pull request; the screens come in the next one and are the
owner's call. Replaces the `agy -p` design ([antigravity-adapter.md](antigravity-adapter.md), whose hook path is being
retired in its own pull request). A record like the rest of `plans/`, so not mirrored in Korean; [agent-host.md](../agent-host.md)
and [protocol.md](../protocol.md) gain the lasting parts.

Evidence: a spike on macOS against the agent (ACP registry `antigravity-acp` 1.4.3, `darwin-aarch64`, 2026-10-27), with
a throwaway client that recorded every frame. "Spike §n" points at its sections; "(binary)" marks what the spike read in
the shipped program rather than measured; "(live)" marks what still has to be measured on the real agent (§9). The
frames this pull request replays are committed, scrubbed, as `adapters/antigravity/recordings/antigravity-1.4.3/`.

## 0. Decisions

| Decision (#59) | Reasoning |
|---|---|
| Antigravity runs as Google's ACP agent on Centralu's ACP adapter, not `agy -p` with a `PreToolUse` hook (owner 2026-10-27) | The hook path is fail-open: an empty hook answer allows, the hook file is writable by the agent's own commands, and command rules depend on parsing shell text. Over ACP an unanswered, cancelled or unknown answer denies (spike §5), turns, cancel and resume are the ACP core's, and Windows has an official build |
| Sign-in happens inside Centralu (owner 2026-10-27) | The agent has no terminal sign-in; it signs in through ACP `authenticate` with a browser and a loopback redirect. Its state folder is Centralu's own, so a CLI sign-in does not carry over; sharing the CLI's folder would bring the person's global hooks and MCP servers in and move the token into the Keychain |
| The sign-in action sits where the "needs a login" line is; the header donut shows a tool installed but signed out (owner 2026-10-27, both, wording on screenshots) | One shared piece for the new-session dialog, the first-run orchestrator card and the new-app dialog. This pull request gives the host the state and the actions; nothing is drawn |
| The header shows an error donut for **every** tool installed but signed out: Claude Code, Codex, Cursor, and OpenCode where its detection can tell (owner 2026-10-27) | Every tool reports one shape, `ToolStatus.setup` (§8); OpenCode reports `signIn: none` (its free models need no account, so it is never signed out) |
| Install inside Centralu: one pinned version, sha256, atomic, progress, cancel (owner 2026-10-27) | §3 |
| Centralu's tools (the MCP bridge) ship in this beta, at parity with Cursor and OpenCode (owner 2026-10-27, replacing "next beta") | §7 |
| First beta signs in on the host's machine only; a linked machine's line says to sign in there (owner 2026-10-27) | The redirect goes to `127.0.0.1` of the machine the agent runs on (spike §4); a person elsewhere can open the address but their browser's redirect reaches their own loopback. Forwarding the redirect is a follow-up |
| No Settings row for account or sign-out in the first beta (owner 2026-10-27) | `auth.logout` is offered by the agent and not called (`AGY_SURFACE`) |

## 1. What the spike found, and what each finding asks of the adapter

| Finding (spike §0) | What the adapter does | Where |
|---|---|---|
| `GEMINI_HOME` relocates all of the agent's state; without it the agent shares `~/.gemini` and loads its global MCP servers, hooks and skills (§3) | Every process sets `GEMINI_HOME` to Centralu's folder | `launch.ts` `agyEnv` |
| Sign-in is an ACP call that blocks up to 300 s on a loopback redirect (§4) | A dedicated process, `authenticate` with a 330 s bound | `sign-in.ts` |
| Commands run in their own process group; a group SIGTERM orphans a running command (§9) | The tree is noted while an `execute` call runs, so its groups are ended with the agent | ACP core `watchCommands` (`kind: execute` reads as `Bash`) |
| The agent reads its own token without asking (§6) | Option (b): its file viewers off, reads through Centralu, which refuses the agent's folder | §4.2 |
| The shell's input is `CommandLine`/`Cwd`, then `command_line`/`working_dir` (§5) | A per-profile reading of `rawInput`/`rawOutput` | `shape.ts` `readAgyCall` |
| A permitted edit runs under another id; the asked one ends `failed` though the edit ran (§5) | The run is folded into the asked call | ACP core `foldEdit`, `editRunsAsNewCall` |
| Questions come as `session/request_permission`, one option per answer; the core would answer them with the first `allow_once` (binary) | Asked as Centralu's question card, under every preset | ACP core `ask`, `isAgyQuestion` |
| Unanswered, cancelled and unknown answers deny; `session/cancel` ends a turn within ~20 ms (§5, §8) | The core's Stop and card release already rely on it | as is |

## 2. Where it goes

`packages/agent-host/src/adapters/antigravity/` is a profile on the generic ACP adapter (`adapters/acp/`, the session
ledger `core/ledger.ts`), like `cursor-agent/` and `opencode/`. Nothing of the `agy -p` adapter (`adapters/agy/`) is used;
its label and mark (Antigravity, `A`) are carried over.

| File | What |
|---|---|
| `release.ts` | The pinned registry entry: version, per-platform URL, sha256, command, files (§3.1) |
| `agent-files.ts` | The OS layer's part for this tool (`tooling/os-layer.js`): platform key, folder layout, what is on disk, the install's disk work, the sign-in's private folder and `BROWSER` helper, the browser opener |
| `launch.ts` | The environment and command every process starts with |
| `setup.ts` | The install and sign-in state machine (`ToolSetupControl`) |
| `sign-in.ts` | The sign-in flow over ACP |
| `shape.ts` | Where its ACP differs from the common shape: field names, questions, Centralu's tools, the viewers switched off, stderr kept out of logs |
| `index.ts` | The profile, its capabilities and `AntigravityAdapter` |
| `surface.ts` | What the installed agent offers (#270), with a baseline from the spike's `initialize` |

**Not shown yet.** The registry adds the adapter only with `CC_ANTIGRAVITY=1` (the live checks set it): registered,
every tool picker would draw Antigravity's line, and the screens and their words are the next pull request's. That one
removes the switch.

The ACP core gains one optional profile part, `AcpToolShape` (`acp/profile.ts`): hooks at fixed points, each absent for
Cursor and OpenCode, so their behaviour is unchanged (their replays pass as before).

## 3. Install

### 3.1 One pinned version per Centralu release

`AGY_RELEASE` holds registry entry `antigravity-acp` 1.4.3, copied by hand when a release moves on: macOS arm64 and x64,
Linux x64 and arm64 (`--uid=` as the registry's argument), Windows x64 and arm64 (`agy_acp_server.exe`). Each has its
URL on `dl.google.com` and the registry's sha256. A build downloads the archive its tests and review saw, never a newer
one by itself. The Windows x64 archive was downloaded for this pull request: its sha256 matched, and the in-repo zip
reader lists it (two deflated files, 87 MB and 148 MB, no ZIP64), so the installer can read Google's archives.

Windows is enabled now (owner): there is an official build, and nothing in the path differs but the file names and the
`BROWSER` helper (§4.3).

### 3.2 The install

`agents.installTool { tool, machine? }`, only when the person asks; nothing downloads at startup. Routed to the machine
that will run the agent, and `asks` for the limited credential (it brings in a program that later runs).

1. **Room first.** The folder's free space is read (`statfs`); under 700 MB (110 MB zipped and 405 MB unpacked on
   macOS, side by side until the archive goes) it ends `disk_space` before a byte arrives.
2. **Download** into a fresh `.install-<random>` folder beside the install, hashed as it arrives; progress at most every
   1 MB. A broken or short download ends `network`; ENOSPC midway ends `disk_space`.
3. **Check** the sha256 against the pinned one; a mismatch ends `checksum` and nothing of it is unpacked.
4. **Unpack** exactly the files the release names, as plain files with plain names (no folder, link or path), each to the
   size it declares (inflated no further: a zip bomb stops there), marked runnable. Anything else ends `unpack`.
5. **Put in place** with one rename of the unpacked folder to `<version>/`, its marker (`install.json`, naming the
   archive's sha256) written last inside it. The launcher reads the folder only when the marker names the pinned archive
   and every file is there, so a folder is whole or absent.
6. **Tidy**: the temporary folder always; older version folders best effort (a running session may hold them on
   Windows). A stale `.install-*` an earlier host left is removed at the next start.

`agents.cancelInstallTool` aborts it: the download stops and nothing is left. A second `installTool` while one runs
joins it.

### 3.3 Where it lives

Under Centralu's data folder (`dataRoot()`, so `CC_DATA_DIR` in tests), `tools/antigravity/`: `<version>/` (the server
and `localharness_external` side by side, as they must be, spike §1), `gemini-home/` (not versioned), and the temporary
folders. The person's `~/.gemini` is never read or written.

## 4. Isolation and sign-in

### 4.1 One home, stable across updates

Every process (each session's and the sign-in's) starts with `GEMINI_HOME=<data>/tools/antigravity/gemini-home`. It is
not under the version folder: a session created under one `GEMINI_HOME` cannot be loaded under another (`-32002 "Session
not found in the current GEMINI_HOME"`, spike §3), so a Centralu update that moves the agent to a new version still
opens every conversation. `HOME` is left as it is: every path the agent used followed `GEMINI_HOME` (spike §3), and a
changed `HOME` would change what the person's own commands see (git config, ssh).

### 4.2 Where the token lives: the file, and the agent kept from reading it

The spike's options (§6): (a) the Keychain backend, (b) reads through Centralu with the viewer off and the agent's home
refused, (c) never `yolo`. Decided: **(b), with (c), and the file backend forced** (`AGY_ACP_FORCE_FILE_STORAGE=1`).

- (a) is not taken: whether a Keychain write, and every update that re-signs the binary, raises a macOS dialog was not
  measured, and such a dialog would ask in Centralu's name. On Windows and Linux the backend's behaviour is unknown. The
  file keeps one behaviour on every OS, inside Centralu's folder (mode 0600, spike §3).
- (b): the client advertises `fs.readTextFile` (not `writeTextFile`, not `terminal`). Every session's `session/new`,
  `session/load` and `session/resume` carry `_meta.antigravity.disabledTools` with the harness's content readers:
  `view_file`, `view_file_outline`, `view_code_item`, `grep_search` (names read in the harness binary; `list_dir` and
  `find_by_name` say names only and stay). Centralu answers `fs/read_text_file` inside the session's folder only, by real
  path (a link out is refused like its target), and never under `<data>/tools/antigravity/` (its token, settings and
  binaries), even when the project folder holds it. Spike §7 measured that reads inside the folder go through
  `fs/read_text_file` once it is advertised.
- (c): the agent stays in `default`; `session/set_mode` is never sent (§5.1).

What still reaches the token: a shell command (`cat`), which asks in `default` mode, so under Normal, Safe and Edits the
person sees it; under Auto it runs, as any command does for Claude or Codex under Auto. **(live)** Whether
`disabledTools` removes those tools, whether the agent then reads through `fs/read_text_file` (also outside the folder),
and whether any remaining tool reads `GEMINI_HOME` without asking.

### 4.3 The sign-in

`agents.signIn { tool }` (no `machine` parameter; route `hub`: this host's machine only) starts one agent process with the
isolation environment, tied to no session: `initialize`, then `authenticate {methodId: "oauth-personal"}` with a 330 s
bound, past the agent's own 300 s, and the process kept until it answers.

The address reaches the host and never `host.log`:

- **macOS and Linux**: `BROWSER` names a script in a private folder (`.sign-in-<random>`, 0700) that writes its one
  argument to a file there through a temporary name; the host reads it and opens the browser (`open`, `xdg-open`).
  Measured on macOS: the agent's launcher honours `BROWSER`, and no browser opened by itself (spike §4).
- **Every OS**: the agent's stderr line `Open the following link to authenticate the ACP server: <url>` is read by the
  sign-in and left out of the log. On Windows it is the only source: a batch helper would hand its argument to `cmd`,
  which splits an address at `&` (the launcher gives the address as the program's one argument, as measured on
  macOS, and a `.cmd` is run through `cmd`). So on Windows `BROWSER` is not set and the agent's own launcher opens the browser; the host opens
  nothing there. **(live, Windows)** that it does.
- An address is opened once, and only `https` on a Google host.

`agents.cancelSignIn` ends the process, and with it the one-shot listener (ACP cannot cancel `authenticate`). Endings:
success reads `_meta.antigravity.tier` (`{name, upgradeUri}`: the plan name, offered as `ToolSetup.plan`) and the line is
ready; the agent's "Timed out…" or our bound is `timed_out`; `-32000` with `data.reason = "onboarding_failed"` is
`ineligible` (the token is cleared by the agent, binary); a cancel is `cancelled`; anything else `failed`. Success
without `auth.type` on disk is said as `failed`, not taken for ready. The sign-in's stderr is filtered like a session's
(§4.4).

### 4.4 Signed out, and what reaches the logs

Signed in means `auth.type` in `<home>/antigravity-acp/settings.json` and the token file beside it (looked at, never
opened). A session whose `session/new` or `session/load` answers `-32000` is a `not_logged_in` error that says to sign
in with Google from the tool's line in Centralu (not "Log in from a terminal"), and the setup turns `signed_out`
(a `tool_setup` event), whatever is on disk, until the next sign-in.

The agent logs, at every start, its onboarding answer, whose upgrade address names the account's email (spike stderr),
and its sign-in address. A line with an address, an email, `loadCodeAssist`, `oauth` or `token` is left out of
`host.log` and of a crash message's stderr tail (`AcpToolShape.stderrLine`, applied in `startToolProcess` to
`stderrTail` and in `AcpConnection` to the log).

### 4.5 A linked machine

`agents.installTool` and `agents.detect` route to the machine; `agents.signIn` does not (route `hub`, no parameter). A
linked machine's `setup` says `signed_out` with `signIn: centralu`; the screen, which knows the line is a linked
machine's, says to sign in on that machine (next pull request).

## 5. Behaviour in a session

### 5.1 Presets: Centralu answers; the agent stays in `default`

In `default` the agent asks for shell, edits, web fetch and MCP calls, not reads or searches (spike §5), as Claude's Safe
asks. Centralu's preset answers each request as it does for the other ACP tools, so all four presets are kept
(`presets` absent). The agent's `auto_edit` and `yolo` would skip Centralu and are never set; `allow_always` (which the
agent keeps as its own rule per command, spike §5) is never sent: "Always" stays Centralu's rule.

### 5.2 Field names (`readAgyCall`)

| Call | Agent's fields | Read as |
|---|---|---|
| shell, asked | `rawInput {CommandLine, Cwd, WaitMsBeforeAsync}` | `command`, `cwd` |
| shell, running | `rawInput {command_line, working_dir}` | `command`, `cwd` |
| shell, ended | `rawOutput {exitCode, combinedOutput, …}` | `output` (and `exitCode` as it is) |
| edit, asked | `rawInput {TargetFile, CodeContent, …}` and a `diff` content | `file_path`, `content` |
| edit, run | `rawInput {file_path}` under a new id | folded into the asked call (§5.3) |
| client write | `rawInput {target_file, code_content}` | `file_path`, `content` |
| read | `rawInput {absolute_path}` | `file_path` |
| replay (`session/load`) | `rawInput` as a JSON string | parsed first |

The agent's own fields stay beside the added ones.

### 5.3 The edit's two ids

After `allow` the edit runs as a new call (`<session>:<n>`, "Running edit_file") and the asked call ends `failed`
("Tool call was approved but never executed") when the turn ends, though the file changed (spike §5). The core keeps the
edits allowed in the turn, with their files; a new `edit` call whose file one of them names is said under that call's
id, so the card the person answered ends as the edit did; the asked call's own late `failed` then finds it ended and is
dropped (the normalizer drops any update of a call that ended this turn). A `pending` call is never taken for a run
(it is the next edit about to be asked), and an allowed edit that ends with no run of its own waits for none, so a
later edit of the same file folds into its own card. Replayed on the spike's frames; the two edge cases are scripted.

### 5.4 Questions

A `session/request_permission` whose `toolCallId` starts `interaction_` (binary: no `kind`, empty input, one option per
answer, `reject_once` only for an answer named deny, `dont_trust` or `block`) is a question, not an approval: it is
Centralu's existing question card (`question_request`, answered with `agents.answerQuestion`), under every preset, Auto
included. The answer picks the option of that name; any other answer, a Stop, the turn's end or the close answer
`cancelled`, which the agent takes as no answer. No question came up in the spike, so the frames in the test are written
by hand in the binary's shape. **(live)** A real question's text field (title or content).

### 5.5 Commands' processes

A command runs in its own process group (spike §9). The ACP core notes the agent's tree while an `execute` call runs
(as for Cursor), so a Stop or a host's end reaches the command's group. Replayed: the tree is noted during the spike's
shell call. **(live)** That a Stop under Centralu ends a `sleep` the agent started, on macOS.

### 5.6 What is accepted as it is

- A read the harness refuses (outside the folder) ends `completed`; the agent says the refusal in its text (spike §5).
- Context: `usage_update {used, size: 1048576}`, exact, no cost; the prompt result's `usage` gives the turn's tokens.
- One prompt at a time: a second `session/prompt` mid-turn breaks the connection (spike §8); the core never overlaps.
- Resume: `session/load` (replays, dropped by the core); `session/resume` is not used. Replayed.

## 6. Capabilities

`approvals`, `contextUsage: exact`, `resume`, every preset. Not offered yet: role text (`roleText: false`; the agent
offers `_meta.antigravity.systemPrompt.append`, untried), untrusted projects (`keepsRepoFilesOut: false`: it reads the
project's own instruction files, as the other ACP tools), images in the prompt, the model and effort menus (the agent
offers `configOptions` `model` and `thinking_level`; `set_config_option` unmeasured), sleep, apps (`appAttachment`
answers `failed`, as for every ACP tool).

## 7. Centralu's tools

At parity with Cursor and OpenCode: the stdio bridge in `session/new` `mcpServers` when the session takes Centralu's
tools, and a call to it answered without a card (`centraluToolOf`): the agent names the server in `_meta.mcp.server` and
the tool in `_meta.mcp.tool`, and asks for every MCP call (kind `other`, spike §5). Only kind `other` is read, so a call of
another kind with the same names is not taken for Centralu's. Replayed on the spike's MCP frames with the server renamed
as the bridge's. The bridge's credential is the one the other ACP tools get: `CC_BRIDGE_TOKEN` in the
`mcpServers` entry, which the agent passes to the bridge it starts (so the agent's process holds it, as Cursor's and
OpenCode's do). The session-scoped key over HTTP (#1677) is a follow-up for all of them.

## 8. Protocol additions

All additive; a window that predates them reads `installed`/`loggedIn` as before.

- `ToolSetup` on `ToolStatus.setup` for every tool: `state` (`not_installed`, `installing`, `signed_out`,
  `signing_in`, `ready`, `unknown`), `install` (`centralu` | `terminal`), `signIn` (`centralu` | `terminal` | `none`),
  `progress`, `failure {reason, message}`, `plan`. Tools with no setup of their own get `setupOfDetection(installed,
  loggedIn)`; OpenCode says `signIn: none`.
- `agents.installTool`, `agents.cancelInstallTool` (`machine` routed; `asks` / `everyday`), `agents.signIn`,
  `agents.cancelSignIn` (hub only; `asks` / `everyday`), each answering the `ToolSetup` as it stands. A tool with no setup
  of its own is refused (`refused`, "installed and signed in from a terminal").
- `tool_setup { tool, setup }`, app-wide: an install's progress and end, a sign-in's start and end, a session that found
  the tool signed out. It never carries the sign-in address.

## 9. What needs the live check on macOS

The orchestrator runs these on macOS against the real agent after this pull request; nothing here raised an OS dialog
or ran the agent.

1. Install through `agents.installTool` on a clean data folder: progress events, the folder in place, no Gatekeeper
   dialog (the spike saw none for a `curl` download; Node's `fetch` sets no quarantine attribute either), first session
   starts.
2. `disabledTools` takes the four readers away; reads in the folder come as `fs/read_text_file`; a prompt asking to read
   the token file (`<data>/tools/antigravity/gemini-home/antigravity-acp/acp_token.json`) is refused, by any tool that
   does not ask; whether reads outside the folder now come to Centralu (refused) or fail inside the agent.
3. Sign-in from `agents.signIn`: the browser opens once from the helper's file, the line goes `signing_in` → `ready`
   with the plan; a cancel mid-way ends the listener; a 5-minute wait ends `timed_out`; `host.log` holds no address
   and no email.
4. A Stop during `sleep 60` ends the command's process group; a host killed mid-command leaves no `sleep` behind.
5. A question from the agent (`interaction_*`), if one can be provoked (its `/plan` command asks before it executes,
   binary): the card's text and the answer's effect.
6. Windows (this machine or another): the agent opens the browser itself with `BROWSER` unset; the sha256 and install of
   the x64 archive end to end.

## 10. Tests

Recordings (scrubbed by `scripts/frames-scrub.mts`'s `scrub()` after the spike's own folders were named; outgoing
parameters are the spike client's, so the replay matches methods and answers): `permissions` (shell and edit allowed,
a read refused), `deny`, `load`, `mcp`, `signed-out`, `sign-in`. Every test below fails with its fix reverted (checked
one by one on Windows):

| Fix | Test |
|---|---|
| Edit run folded into the asked call; ended calls' updates dropped | `replay.test.ts` permissions |
| A pending edit never taken for a run; an allowed edit that ended with no run no longer waits | `shape.test.ts` |
| Stderr judged line by line (a split address never reaches the log) | `shape.test.ts` |
| Registered only with `CC_ANTIGRAVITY=1` | `replay.test.ts` registry |
| Field names read (`Cwd`, `combinedOutput`) | `replay.test.ts` permissions |
| Viewers off, never `set_mode`, never `allow_always` | `replay.test.ts` default mode |
| `-32000` is a Centralu sign-in; the line turns signed out | `replay.test.ts` signed out |
| Centralu's own MCP tool without a card | `replay.test.ts` mcp renamed |
| Questions are question cards, under Normal and Auto; other answers and a Stop cancel | `shape.test.ts` |
| Reads: the folder only, never the agent's folder, through links | `shape.test.ts` |
| Stderr kept out of the crash message's tail | `shape.test.ts` |
| sha256, plain files, free space, cancel, short download, older version replaced | `agent-files.test.ts` |
| Sign-in: process, environment, helper, address opened once (Google only), cancel, endings | `sign-in.test.ts` |
| The setup as a state machine, against a model, seeded random runs | `setup.test.ts` |
| Every tool's setup in `agents.detect`; the actions passed or refused | `rpc.test.ts` |

## 11. Open questions and follow-ups

1. Role text through `_meta.antigravity.systemPrompt.append`, which would let Antigravity be the orchestrator or an
   app's agent: measure, then decide.
2. The model and effort menus (`configOptions`): `set_config_option` unmeasured; does it persist like Cursor's?
3. Forwarding the sign-in redirect for a linked machine (owner: follow-up).
4. The other sign-in methods (`gemini-api-key`, `agent-platform`, `oauth-business`) take keys or project settings, not a
   browser: a screen of their own, later.
5. Sign-out (`auth.logout`), once there is a place for it.
