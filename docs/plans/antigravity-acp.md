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
| `GEMINI_HOME` relocates the server's state; without it the agent shares `~/.gemini` and loads its global MCP servers, hooks and skills (§3) | Every process sets `GEMINI_HOME` to Centralu's folder | `launch.ts` `agyEnv` |
| Not all of it: the harness writes `webm_encoder` under `$HOME/.gemini/antigravity/bin` at the first prompt (deep review, measured) | Accepted (owner, [#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6446873429)): the agent keeps the person's `HOME`; this one file is the only thing it writes under `~/.gemini` | §4.1 |
| Sign-in is an ACP call that blocks up to 300 s on a loopback redirect (§4) | A dedicated process, `authenticate` with a 330 s bound | `sign-in.ts` |
| Commands run in their own process group; a group SIGTERM orphans a running command (§9) | The tree is noted while an `execute` call runs, so its groups are ended with the agent | ACP core `watchCommands` (`kind: execute` reads as `Bash`) |
| The agent reads its own token without asking (§6) | Option (b): its file viewers and its subagents off, reads through Centralu, which refuses the agent's folder | §4.2 |
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
   1 MB. A broken or short download ends `network`; ENOSPC midway ends `disk_space`. The archive is asked for as stored
   (`accept-encoding: identity`): `fetch` asks for gzip by itself, and `dl.google.com` then answers gzipped with a
   `content-length` of the gzipped size, which the decoded bytes never matched, so every install ended `network` (deep
   review, measured). A length is compared only when the answer names no encoding; the sha256 decides either way.
3. **Check** the sha256 against the pinned one; a mismatch ends `checksum` and nothing of it is unpacked.
4. **Unpack** exactly the files the release names, as plain files with plain names (no folder, link or path), each to the
   size it declares (inflated no further: a zip bomb stops there), marked runnable. Anything else ends `unpack`. Streamed
   from the file entry by entry: only the zip's directory is held in memory, not the 110 MB archive or a 280 MB entry
   (reading it whole raised the host's memory by about 400 MB in the review).
5. **Put in place** with one rename of the unpacked folder to `<version>/`, its marker (`install.json`, naming the
   archive's sha256) written last inside it. The launcher reads the folder only when the marker names the pinned archive
   and every file is there, so a folder is whole or absent.
6. **Tidy**: the temporary folder always; older version folders best effort (a running session may hold them on
   Windows). A stale `.install-*` or `.sign-in-*` an earlier host left (one killed mid-install) is removed when the next
   host starts; an install or sign-in waits for that. Only when its owner is provably gone: each such folder's name
   records the host process that made it (`.install-<pid>-<start>-<random>`, the start a hash of when that process
   began, `0` where `ps` cannot say, as on Windows), and a folder goes only when no process has that pid or the one that
   has it started at another time. The keeper's next host starts while the last one drains, and a second host on the
   same data folder with another `--db` holds its own lock but shares `tools/` (re-review: such a host's start removed a
   live sign-in), so a folder of a host still running is kept, and so is one whose owner cannot be told.

`agents.cancelInstallTool` aborts it: the download stops and nothing is left. A second `installTool` while one runs
joins it.

### 3.3 Where it lives

Under Centralu's data folder (`dataRoot()`, so `CC_DATA_DIR` in tests), `tools/antigravity/`: `<version>/` (the server
and `localharness_external` side by side, as they must be, spike §1), `gemini-home/` (not versioned), and the temporary
folders. The server never reads or writes the person's `~/.gemini`; the harness writes one file there (§4.1).

## 4. Isolation and sign-in

### 4.1 One home, stable across updates

Every process (each session's and the sign-in's) starts with `GEMINI_HOME=<data>/tools/antigravity/gemini-home`. It is
not under the version folder: a session created under one `GEMINI_HOME` cannot be loaded under another (`-32002 "Session
not found in the current GEMINI_HOME"`, spike §3), so a Centralu update that moves the agent to a new version still
opens every conversation. `HOME` is left as it is, since a changed `HOME` would change what the agent's commands see (git
config, ssh, npm).

**Not every path follows `GEMINI_HOME`; the owner accepted the one that does not
([#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6446873429)).** The spike's claim that every path did
held for the server, not the harness (`localharness_external`): Google's harness extracts its screencast encoder, a 12.7
MB `webm_encoder`, into `$HOME/.gemini/antigravity/bin/` at the first prompt of a process (not at `session/new`;
measured with a temporary `HOME`, and in the review on the person's real folder). The harness takes the folder from the
home directory alone (binary: its browser subagent's encoder path joins the home directory and `.gemini`, with no
variable read); `ANTIGRAVITY_GEMINI_DIR` set to `GEMINI_HOME` changes nothing, and switching the subagents off (below)
does not either. Other things do follow `GEMINI_HOME`: an MCP config under `GEMINI_HOME/config` is loaded, one under
`$HOME/.gemini/config` is not, and the harness's children (commands, MCP servers) inherit the agent's environment,
`HOME` included. So only a different `HOME` for the agent's processes would move the file, and that would take the
person's git, ssh and npm settings out of reach of the commands the agent runs for them.

The owner chose to accept the file: **the agent keeps the person's `HOME`**, and the encoder under
`~/.gemini/antigravity/bin/` is the one thing it writes there. Nothing else under `~/.gemini` was read or written in the
measured runs (with a temporary `HOME`, that file was the only entry under it after a prompt, and an MCP config placed
under `$HOME/.gemini/config` was not loaded). Development and review runs use a temporary `HOME`, so they leave the
person's `~/.gemini` as it was. The rejected choices were a `HOME` of Centralu's for the agent (the settings above) and
holding Antigravity until Google's harness honours `GEMINI_HOME` there; the bug is to be reported upstream, and once
fixed the file follows `GEMINI_HOME` with no change here.

### 4.2 Where the token lives: the file, and the agent kept from reading it

The spike's options (§6): (a) the Keychain backend, (b) reads through Centralu with the viewer off and the agent's home
refused, (c) never `yolo`. Decided: **(b), with (c), and the file backend forced** (`AGY_ACP_FORCE_FILE_STORAGE=1`).

- (a) is not taken: whether a Keychain write, and every update that re-signs the binary, raises a macOS dialog was not
  measured, and such a dialog would ask in Centralu's name. On Windows and Linux the backend's behaviour is unknown. The
  file keeps one behaviour on every OS, inside Centralu's folder (mode 0600, spike §3).
- (b): the client advertises `fs.readTextFile` (not `writeTextFile`, not `terminal`). Every session's `session/new`,
  `session/load` and `session/resume` carry `_meta.antigravity.disabledTools`, in the server's canonical names
  (`BuiltinTools`; a name it does not know is logged "Unknown tool name in disabledTools" and skipped): `view_file` and
  `search_directory` (the content readers: the search prints matching lines) and `invoke_subagent` and `run_workflow`
  (the subagents). The first list here named `view_file_outline`, `view_code_item` and `grep_search`, which are the
  harness's internal names: the server dropped all three, so only `view_file` was off (measured in the review's logs).
  `list_directory` and `find_file` say names only and stay. **Subagents** kept the built-in `view_file`, which
  `disabledTools` does not reach: in the review one allowed "Run invoke_subagent?" card let a subagent read a canary file
  in `GEMINI_HOME/antigravity-acp/` with no Centralu read and no card. With `invoke_subagent` off the server turns its
  subagents off (`subagents_enabled`, binary), and the tool declarations lose `invoke_subagent`, `define_subagent`,
  `run_workflow` and `send_message` (measured). A permission request titled `Run invoke_subagent?`, `Run
  start_subagent?`, `Run define_subagent?` or `Run run_workflow?` arriving anyway is refused under every preset and rule,
  Auto and an "Always" rule included (`AcpToolShape.neverAllowed`). Centralu answers `fs/read_text_file` inside the session's folder only, by real
  path (a link out is refused like its target), and never under `<data>/tools/antigravity/` (its token, settings and
  binaries), even when the project folder holds it. Spike §7 measured that reads inside the folder go through
  `fs/read_text_file` once it is advertised.
- (c): the agent stays in `default`; `session/set_mode` is never sent (§5.1).

**Requests that name the agent's folder are refused.** Centralu answers every request the agent asks, and under Auto it
allows them: the re-review measured `replace_file_content` running on a file in `antigravity-acp/`, which the harness
counts as part of its workspace (with `gemini-home/config/skills`). So any permission request (an edit, a read by
address, an MCP call, a command's folder) with a path in `<data>/tools/antigravity/` is refused under every preset and
every saved rule (`AcpToolShape.neverAllowed`, `reachesAgentFolder`). The guard fails closed: what it cannot judge is
refused (recheck of #1680). Exactly what it checks:

- Every string of the request, object keys too, and the strings inside a string that holds JSON (pretty-printed too).
  A request nested deeper than 32 levels, or with more than 1024 distinct one-line strings, is refused whole without
  being read (`SCAN_LIMITS`); so is one that throws while read.
- Each one-line string (up to 32767 characters, the longest path an OS takes) as written, without one pair of
  surrounding quotes, with `%VAR%`, `$VAR`, `${VAR}` filled in from the agent's environment (`GEMINI_HOME` included), and
  with each `{a,b}` alternative spelled out (more than 64 are refused). Each is then read as a path: a `file:` address as
  a URL parser reads it (`file:C:/x` too; a `file:/` address that does not parse is refused), `~`, absolute,
  drive-relative `C:foo` (judged from the drive's root, the session's folder and the host's own folder on that drive),
  `\foo` on Windows, or relative to the session's folder. A glob (`*`, `?`, `[`, `{` in a segment) is judged by its
  fixed prefix as well; a `..` after a glob segment is refused.
- Each path as written (on Windows without its `\\?\` or `\\.\` prefix, and with trailing dots and spaces dropped from
  each name, as the OS does) and as it resolves: segment by segment through links and junctions, a `..` taken after
  the link before it as the kernel does, 8.3 names and case as the file system has them. A name that exists but does
  not resolve (a dangling link, a loop) is refused. Case is also folded.
- It is refused when it is inside the folder, or is the folder or a parent of it (`<data>`, `<data>/tools`, the home
  folder, a drive's root): a listing or a recursive search from a parent reaches inside. A shell call's own folder is
  exempt from the parent rule only.
- On Windows a network path (`\\host\share\…`, `\\?\UNC\…`, a mapped drive, a volume or device path) is refused when
  its volume is the folder's volume, or cannot be read. Its host's name proves nothing: `localhost`, `127.0.0.1`, the
  machine's own names and addresses, a hosts-file entry, and any share of any folder lead to the same file (measured:
  the admin share by each of those names gave the token's volume serial and file id). The volume, read with `stat`, does.
- Then every line and every word (split at spaces, `=`, `,`, `;`, quotes, brackets, `|`, `@` and `&`) of every string,
  multi-line ones and a shell command included, and each word also from every place a path can start in it (`~`, a
  separator, a drive), read the same way by its text only (no links, no parent rule): a path in a list, an argument
  (`--out=<path>`, `-o<path>`, `key:<path>`, `@<path>`), a command that names the token.

Work this declines that it need not (accepted, since each is rare and the person can still do it with a shell command,
which asks): a search or listing over the home folder, the data folder or a drive's root, including a session whose
folder is the home folder searching `.`; an edit whose one-line text is `/`, `~`, `..` or a glob from a parent (it
reads as a path); text that names a path in the folder (a note or a command quoting the token's path); a path through
a dangling link; a file on a network share of the data folder's own volume (a loopback share); a request with more
than 1024 strings, 32 levels or 64 brace alternatives; a listing of the plan folder itself (only files in it are let
through).

One folder is let through, the conversation's own plan folder
`gemini-home/antigravity-acp/brain/<session id>/`: `/plan` writes its plan there as an edit it asks for (measured on
1.4.3: `plan.md`, or a name of its choosing, and `<name>.metadata.json`; the harness itself keeps the MCP schemas it
reads and its logs beside them). The token, `settings.json`, the conversations' databases, other conversations' folders,
the MCP config and skills under `gemini-home/config/` and the programs stay refused; a link in the plan folder is judged
by where it leads, and a plan folder that is itself a link lets nothing through.

What still reaches the token: a shell command that does not name its path (a variable, `cd` then a relative name). It
asks in `default` mode, so under Normal, Safe and Edits the person sees it; under Auto it runs, as any command does for
Claude or Codex under Auto (said in [security-boundaries.md](../security-boundaries.md)). Measured in the review: the tool list loses the viewers, reads
come as `fs/read_text_file`, and every path into the agent's folder is refused there.

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
success reads `_meta.antigravity.tier` (`{name, upgradeUri}`: the plan name, offered as `ToolSetup.plan`) and the line
is ready; the agent's "Timed out…" or our bound is `timed_out`; `-32000` with `data.reason = "onboarding_failed"` is
`ineligible` (the token is cleared by the agent, binary); a cancel is `cancelled`; anything else `failed`. The agent
answers a timeout with the same code and reason ("Onboarding failed: Timed out waiting for the authentication flow to
complete.", measured at 300 s), so the timeout's words are read first (only those words, and Centralu's own bound on the
call: any other error that says "timed out" keeps its reason); the review found a timeout reported as `ineligible`. An
ineligible answer names the account's verification page ("Verification URL: …", measured): it is carried as
`failure.verifyUri` (only `https` on a Google host, with no user part and no port; the parsed address, not the agent's
string) for the screens' pull request to offer, never in `message` or the log, and this pull request adds no wording for
it. The agent's words in a `failed` message lose any address or email. Success without `auth.type` on disk is said as
`failed`, not taken for ready. The sign-in's stderr is filtered like a session's (§4.4).

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
- Resume: `session/load` (replays, dropped by the core); `session/resume` is not used. Replayed. The commands the agent
  advertises during the replay are kept (they are the process's, not the conversation's).
- **No compaction.** The agent advertises `plan`, `logout` and `usage`, no `compact`; a bare `/compact` would only be a
  prompt to its model. So Centralu never compacts an Antigravity session at a break and `compact_self` answers that it
  cannot (`AcpSession.compactCommand` is null, [acp-adapter.md](acp-adapter.md) §5.6). What the agent does near the end
  of its window (1,048,576 tokens) is its own, not measured.
- **An exhausted quota is plain text.** The turn ends `end_turn` with the agent's message "Usage Limit Reached … Your
  limit will reset in N days" and no other frame, so no `limit_reached` is said. Read in the server: on the harness's
  quota error (`429 RESOURCE_EXHAUSTED`, reason `QUOTA_EXHAUSTED`) it writes that text as an `agent_message_chunk` and
  ends the turn `end_turn`, by design ("This surface does not upsell"). Its only structured path is the harness's own
  `QUOTA_EXHAUSTED` stop reason, mapped to ACP `refusal`, which the 1.4.3 run did not take and which ACP also uses for a
  model's refusal; the core already ends a `refusal` turn as failed. Text is not matched; a follow-up if Google adds a
  frame.

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
  `progress`, `failure {reason, message, verifyUri?}`, `plan`. Tools with no setup of their own get `setupOfDetection(installed,
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

Measured after the deep review's fixes (macOS arm64, agent 1.4.3, a temporary data folder and a temporary `HOME`):

- 1: `agents.installTool` took about 30 s; progress counted up to the archive's stored size (114,147,623 bytes); the
  marker names the pinned sha256; no `.install-*` left; no quarantine attribute (provenance only).
- `HOME`: nothing under it at `session/new`; after the first prompt `.gemini/antigravity/bin/webm_encoder` (12.7 MB)
  was there (§4.1, accepted).
- 2: asked, under Auto, to read a canary file in `GEMINI_HOME/antigravity-acp/` through a subagent, the agent said it
  has no subagent tool and made no call. `read_url_content` with a `file://` address to that file failed in the
  harness ("unsupported protocol scheme").
- 4: a Stop during `sleep 97` (its own process group, a child of the harness) ended it within a second.
- Edits: two edits of one file, each allowed, each card ended as its edit did, with no stray failed call (§5.3).
- Centralu's tools: `compact_self` was called through the bridge without a card and answered that the tool has no
  compact command. Before calling it the agent asked to `cat` the tool's schema file, which the harness keeps under
  `GEMINI_HOME/antigravity-acp/brain/<conversation>/mcp/`: under Normal that is a command card; under Auto it runs.
- Under Normal a shell command asked (kind `command`), as in the spike.
- After the re-review (Auto, a temporary `HOME`): asked to edit a file in `antigravity-acp/` with its edit tool, the
  agent's request (`Run edit_file?`) was declined with no card, the file unchanged; `/plan` in the same session then
  wrote its plan to `brain/<session id>/`, also with no card.
- 5: no question came. `/plan` wrote its plan to `GEMINI_HOME/antigravity-acp/brain/<conversation>/plan.md` (an edit
  card under Normal) and ended the turn asking the person to "click Proceed", with no `interaction_*` request.

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
| Deep review: the archive asked for as stored, a gzipped answer's length not compared | `agent-files.test.ts` the real download (a local server that answers gzip) |
| Deep review: the unpack streamed, memory bounded | `agent-files.test.ts` |
| Deep review: an earlier host's `.install-*` removed at the start | `setup.test.ts` |
| Re-review: only a folder whose owner has ended is removed; a live host's install and sign-in are kept | `setup.test.ts` (another host as a child process) |
| Re-review: the setup's tests step only after the start-up cleanup has ended (it is slowed there, as on a busy Windows disk) | `setup.test.ts` |
| Re-review: a verification page with a user part or a port is refused; what is passed on is the parsed address | `sign-in.test.ts` |
| Re-review: only the authenticate call's own timeout is `timed_out` | `sign-in.test.ts` |
| Re-review: an edit or read naming the agent's folder refused under every preset and rule; the conversation's plan let through, a link in it not | `shape.test.ts` |
| Re-review: a zip bomb stopped before more than its declared size reaches the disk | `agent-files.test.ts` |
| Deep review: a sign-in timeout is `timed_out`, an ineligible answer carries its page, no address in the message | `sign-in.test.ts` (the agent's real frames) |
| Deep review: the readers and subagents off by their canonical names; a subagent's request refused under every preset | `shape.test.ts` |
| Deep review: no compaction for an agent that advertises none; `compact_self` says so; the commands of a load's replay kept | `acp/session.test.ts`, `sessions/self-compaction.test.ts` |

## 11. Open questions and follow-ups

1. Role text through `_meta.antigravity.systemPrompt.append`, which would let Antigravity be the orchestrator or an
   app's agent: measure, then decide.
2. The model and effort menus (`configOptions`): `set_config_option` unmeasured; does it persist like Cursor's?
3. Forwarding the sign-in redirect for a linked machine (owner: follow-up).
4. The other sign-in methods (`gemini-api-key`, `agent-platform`, `oauth-business`) take keys or project settings, not a
   browser: a screen of their own, later.
5. Sign-out (`auth.logout`), once there is a place for it.
6. The harness's write under `~/.gemini` (§4.1): accepted
   ([#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6446873429)); report upstream that the harness
   resolves its `bin` folder from the home directory instead of `GEMINI_HOME`.
7. An exhausted quota as a `limit_reached` (§5.6), once the agent says it in a frame.
