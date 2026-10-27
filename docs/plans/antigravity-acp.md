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
| The sign-in action sits where the "needs a login" line is; the header donut shows a tool installed but signed out (owner 2026-10-27, both, wording on screenshots) | One shared piece for the new-session dialog, the first-run orchestrator card and the new-app dialog (§12). The host side gives the state and the actions; the screens are drawn in the stacked pull request |
| The header shows a signed-out donut (a solid ring in the signal ink, no red) for **every** tool installed but signed out: Claude Code, Codex, Cursor, and OpenCode where its detection can tell (owner 2026-10-27) | Every tool reports one shape, `ToolStatus.setup` (§8); OpenCode reports `signIn: none` (its free models need no account, so it is never signed out) |
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
| `agent-files.ts` | The OS layer's part for this tool (`tooling/os-layer.js`): platform key, folder layout, what is on disk, the install's disk work, each process's private folder and `BROWSER` helper (a sign-in's and a session's), the browser opener |
| `launch.ts` | The environment and command every process starts with |
| `setup.ts` | The install and sign-in state machine (`ToolSetupControl`) |
| `sign-in.ts` | The sign-in flow over ACP |
| `shape.ts` | Where its ACP differs from the common shape: field names, questions, Centralu's tools, the viewers switched off, stderr kept out of logs |
| `index.ts` | The profile, its capabilities and `AntigravityAdapter` |
| `surface.ts` | What the installed agent offers (#270), with a baseline from the spike's `initialize` |

**Shown to everyone.** The registry adds the adapter always: the screens for its install and sign-in exist (§12). While
they did not, a `CC_ANTIGRAVITY=1` switch kept it out of every picker.

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
  surrounding quotes, with `%VAR%`, `$VAR`, `${VAR}` and PowerShell's `$env:VAR`, `${env:VAR}` filled in from the agent's environment (`GEMINI_HOME` included), and
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
  A WSL share (`\wsl$<distro>…`, `\wsl.localhost<distro>…`, any case, either slash, `\?UNCwsl…` too) is another
  volume, but its `mnt<letter>…` (or `<letter>…`, where a distro mounts drives at its root) is this machine's `<letter>:`:
  that path is judged as well, however it was reached (a relative path or a `\foo` from a session folder that is itself on
  a WSL share included), by text (tested without WSL). The share's root, a distro's root and its `mnt` are parents of every
  drive, so a search from them is refused like one from a drive's root. A distro whose mount point is set to something else
  (`/etc/wsl.conf`), or a link inside a distro that leads to `/mnt/<letter>`, is not known and is not judged.
- Then every line and every word (split at spaces, `=`, `,`, `;`, quotes, brackets, `|`, `@` and `&`) of every string,
  multi-line ones and a shell command included, and each word also from every place a path can start in it (`~`, a
  separator, a drive), read the same way by its text only (no links, no parent rule): a path in a list, an argument
  (`--out=<path>`, `-o<path>`, `key:<path>`, `@<path>`), a command that names the token.

Work this declines that it need not (accepted, since each is rare and the person can still do it with a shell command,
which asks): a search or listing over the home folder, the data folder or a drive's root, including a session whose
folder is the home folder searching `.`; an edit whose one-line text is `/`, `~`, `..` or a glob from a parent (it
reads as a path); text that names a path in the folder (a note or a command quoting the token's path); a path through
a dangling link; a file on a network share of the data folder's own volume (a loopback share); a request with more
than 1024 strings, 32 levels or 64 brace alternatives (so a whole-file write of a large JSON such as `package-lock.json`, with
more than 1024 distinct strings, and one line of text with seven or more `{a,b}` groups, such as minified JSON or a
regular expression with `{1,3}` quantifiers, are declined and have to be done with a shell command, which asks); a listing of the plan folder itself (only files in it are let
through).

One folder is let through, the conversation's own plan folder
`gemini-home/antigravity-acp/brain/<session id>/`: `/plan` writes its plan there as an edit it asks for (measured on
1.4.3: `plan.md`, or a name of its choosing, and `<name>.metadata.json`; the harness itself keeps the MCP schemas it
reads and its logs beside them). The token, `settings.json`, the conversations' databases, other conversations' folders,
the MCP config and skills under `gemini-home/config/` and the programs stay refused; a link in the plan folder is judged
by where it leads, a plan folder that is itself a link lets nothing through, and a file in it with a second name
(`stat().nlink > 1`: a hardlink to the token, which `realpath` cannot see) is refused. A hardlink made elsewhere (in the
project) needs a shell command to make, the class below.

What still reaches the token: a shell command that does not name its path (a variable, `cd` then a relative name). It
asks in `default` mode, so under Normal, Safe and Edits the person sees it; under Auto it runs, as any command does for
Claude or Codex under Auto (said in [security-boundaries.md](../security-boundaries.md)). Measured in the review: the tool list loses the viewers, reads
come as `fs/read_text_file`, and every path into the agent's folder is refused there.

### 4.3 The sign-in

`agents.signIn { tool }` (no `machine` parameter; route `hub`: this host's machine only) starts one agent process with the
isolation environment, tied to no session: `initialize`, then `authenticate {methodId: "oauth-personal"}` with a 330 s
bound, past the agent's own 300 s, and the process kept until it answers.

The agent never starts a browser itself, on any OS, and the address reaches the host and never `host.log`. Every
Antigravity process (a sign-in, and each session, §4.4) gets its own private folder (`.sign-in-<owner>-<random>`, 0700)
and `BROWSER` set to a helper there that writes its one argument to a file through a temporary name; the host reads it
(and removes it, so each address is told once). `BROWSER` is always Centralu's, so one from the person's environment
never reaches the agent (review of #1685, follow-up 8).

- **The agent's launcher** is CPython 3.14's `webbrowser` (the binary is a PyInstaller build; its credential manager
  calls `webbrowser.open` and prints the address on stderr). It tries each `BROWSER` entry (split at `os.pathsep`)
  before its own defaults, and goes on to the defaults when the command exits non-zero. An entry holding `%s` is split
  with `shlex` and run with no shell, the address put for `%s`.
- **macOS and Linux**: `BROWSER` is a `sh` script's path. Measured on macOS: the launcher runs it, and no browser opened
  by itself (spike §4).
- **Windows**: a batch helper would hand the address to `cmd`, which splits it at `&`. So `BROWSER` is a command line,
  `'<node>' '<folder>/open-url.mjs' %s` (the host's own node, each path in `shlex` single quotes): a real program, given
  the address whole, that exits 0. Before this, `BROWSER` was unset on Windows and the agent's launcher started the
  browser as its own child, inside the host's job object (`lifecycle/work-job.ts`), so a Stop, the sign-in's end or the
  host's exit ended the person's browser with every tab (review of #1685, B2, measured).
- **The host opens it outside its work.** On Windows the terminal broker (`dev-services/broker-pty.ts`), which the host
  starts before it joins the job, starts it (`{op:'open', url}`, `rundll32 url.dll,FileProtocolHandler`, detached, so
  in no job of the broker's either); with no broker there is no job, or the host opens it itself. On macOS and Linux
  the host runs `open` / `xdg-open` as before.
- **Every OS**: the agent's stderr line `Open the following link to authenticate the ACP server: <url>` is a second
  source of the same address, read by the sign-in and left out of the log.
- The helper writes each address to a file of its own (`url-<run>`, through `part-<run>`) and exits 0 whatever
  happens: a non-zero exit would send the launcher on to its own default browser, inside the job.
- Where no helper can be written (a path holding the separator `BROWSER` is split at, `;` on Windows and `:` elsewhere,
  or `%s`, e.g. a data folder named `100%s`), the sign-in and every session refuse to start the agent, with a line in
  `host.log` and an error that names why (`NO_HELPER`). Letting it start with no `BROWSER` was the other choice: its
  launcher would then start the default browser itself, on Windows inside the host's job (the browser Stop ends), and a
  sign-in that stopped working would hang the session start for two minutes again. A path Centralu can still use is
  worth less than that, and the error says what to change (deep review of #1687, follow-up 4).
- An address is opened once, and only the agent's own login request (`agentSignInUrl`, `sign-in.ts`): `https`,
  `accounts.google.com/o/oauth2/v2/auth`, `response_type=code`, the agent's OAuth client
  (`1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`, public, measured in 1.4.3's login
  address on Windows and Linux) and a `redirect_uri` on the loopback, each named once. The folder is under the data
  folder, where an agent of another session could write, so a Google page planted there is not opened either (deep
  review of #1687, follow-up 5). The client is pinned in the release entry (`AGY_RELEASE.oauthClient`, `release.ts`) beside
  the version and the sha256s, so a bump measures it again; a test fails on an entry without one.

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

`-32000` comes only when `settings.json` names no `auth.type`. With `auth.type` set and a token the agent cannot use (a
refresh Google refuses, a damaged file, `{}`), 1.4.3 starts its own interactive login inside `session/new` (and
`session/load`, and a prompt whose access token runs out: all go through the same `get_access_token`), logs
`Credentials missing or invalid. Launching browser login flow...`, and waits up to 300 s (review of #1685, B1,
measured: a browser nobody asked for, then "No response for session/new" after 128 s, with the line still ready).
There is no switch to make it answer instead: `AGY_ACP_ENABLE_OAUTH` and env-based auth selection were removed in this
build (its own warning says so), and only an explicit logout makes `session/new` answer `auth_required` (read in the
binary). So the signal is structural: **the session's `BROWSER` helper running is the agent asking for a sign-in**
(`SignInWanted`, `acp/profile.ts`), when what it hands over is the agent's own login request (`agentSignInUrl`, §4.3).
`BROWSER` reaches every command the agent runs, so a Google address alone says nothing: `gcloud auth login` opens
Google's authorize page with gcloud's own client and a localhost redirect, and a script may open a Google Doc. Taking
those for a sign-in ended a working session and marked the tool signed out (deep review of #1687, blocker). The
agent's browser subagent drives a Chrome of its own over CDP, not `webbrowser`, so it is not affected.

**What a command the agent runs can no longer open.** Any other address handed to a session's helper is dropped: not
opened, not taken for a sign-in, and logged as one line without the address (`a command in a session asked for a
browser; not opened`). So under Antigravity, `python -m webbrowser`, `gcloud auth login` (which then waits on its
localhost port), `gh browse` or `gh auth login --web` (`gh` appends the address after `BROWSER`, so the helper is handed
the literal `%s`) open nothing, and the command believes it did. Opening them would widen what opens without a person's
action: an agent in the person's default mode could open any page in the person's browser. No per-session "the person
allowed it" exists to tie it to yet (`agents.signIn` is the only opener, and it is `'asks'`), so it is left closed; a
notice in the conversation, or opening through the broker after a yes, is the follow-up if people need it.

The session then fails what it had asked (`session/new`, `session/load` or the
prompt) with the `not_logged_in` error above, which notes the tool `signed_out`; it does not open the address. While
the conversation opens, the failed open ends the process; once open, the session ends the process itself and sleeps,
and the next message opens the conversation again in a new process (`session/load`), which asks again if the sign-in
is still needed and fails the same way. Where no helper could be written (§4.3) the session does not start at all. The session start's RPC
error keeps the code `not_logged_in` (it was sent as `internal`). Measured on Windows with the real agent: a
refresh-refused token and a `{}` token each failed `agents.createSession` with `not_logged_in` in about 8.5 s (the
agent's own start is most of it), the line went `signed_out`, and no agent process or browser was left. Measured
again with the strict match: the same, in 8.5 s; and the address 1.4.3 handed the helper with `{}` was
`accounts.google.com/o/oauth2/v2/auth` with the client above and `redirect_uri=http://127.0.0.1:<port>/`.

Other ACP clients: the protocol's authentication page (agentclientprotocol.com, "Authentication") has the agent block
a gated request with `auth_required` and the client answer with `authenticate` on one of the advertised `authMethods`,
and asks clients to expect such failures mid-session and prompt for a sign-in again. Nothing found there or in a
search covers an agent that starts its own browser flow inside `session/new` instead; how Zed handles it was not read.
So the helper is the signal, and the code it gives the session is the protocol's own `not_logged_in` path.

The agent logs, at every start, its onboarding answer, whose upgrade address names the account's email (spike stderr),
and its sign-in address. A line with an address, an email, `loadCodeAssist`, `oauth` or `token` is left out of
`host.log` and of a crash message's stderr tail (`AcpToolShape.stderrLine`, applied in `startToolProcess` to
`stderrTail` and in `AcpConnection` to the log).

### 4.5 A linked machine

`agents.installTool` and `agents.detect` route to the machine; `agents.signIn` does not (route `hub`, no parameter). A
linked machine's `setup` says `signed_out` with `signIn: centralu`; the screen, which knows the line is a linked
machine's, says to sign in on that machine (§12).

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
6. Windows: the sha256 and install of the x64 archive end to end (done in the review of #1685). The agent's own
   browser is gone (§4.3): checked on Windows 11 with the real host in a temporary data folder. A sign-in's `BROWSER`
   helper handed the address to the host, the broker started the browser (its parent the broker, no process of the
   agent above it), and the browser outlived Stop and the host's exit. That host ran in a network logon, where
   `rundll32 url.dll,FileProtocolHandler` opens nothing (nor does any shell association), so for that check the broker
   started Chrome with a temporary profile directly, a local change not in the pull request; the `rundll32` step
   itself is unexercised in a desktop logon.

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
| Registered for everyone (the `CC_ANTIGRAVITY=1` switch is gone) | `replay.test.ts` registry |
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

## 12. The screens (#59, owner 2026-10-27)

One piece, `ToolSetupLine` (`packages/ui/src/features/tools/`), draws a tool's setup where its "needs a login" line was:
the new-session dialog's tool line, the first-run orchestrator card (Antigravity's card carries it; the others keep the
command to run) and the new-app dialog. It reads the tool's `ToolStatus.setup`, with this computer's live `tool_setup`
events over it (`withLiveSetups`), so Start enables the moment a sign-in succeeds. `setupView` (`setupLine.ts`) is the one
mapping from a setup to a line:

| Setup | The line |
|---|---|
| `not_installed`, `install: centralu` | "Antigravity is not installed." and **Install** |
| `installing` | "Installing Antigravity… 40%" (the size received when the total is not known), **Cancel**, a progress bar |
| `not_installed` with a failure (not a cancel) | "Could not install Antigravity: <reason>" and **Retry** |
| `not_installed`, no build for the system | said, no action |
| `signed_out`, `signIn: centralu`, this machine | "Antigravity needs a Google sign-in." and **Sign in** |
| `signing_in` | "Waiting for the browser…" and **Stop** (not Cancel, so it is not mistaken for the dialog's own Cancel) |
| `signed_out` after `timed_out` or `failed` | "Sign-in timed out." / "Sign-in did not finish: <reason>" and **Retry** |
| `signed_out`, a linked machine | "Antigravity needs a Google sign-in. Sign in on <machine>." No button (pasting the address is a follow-up, §11) |
| `signed_out` or `not_installed`, `terminal` | The terminal hint of each place, as before (Claude Code, Codex, Cursor) |
| `ready`, `unknown`, `signIn: none` (OpenCode) | no line |

On success the line folds and fades out (`Fold`) while Start is already enabled. A cancel is the person's own act: the line
goes back to Install or Sign in with nothing said. An action the host refuses prints its reason under the line.

**The top bar.** Every tool that is installed but signed out (`signedOutTools`) gets a donut with a solid ring and the
tool's letter in the signal ink (`ink-signal`), where a reading's ring would be (`data-signed-out`). It is not red:
design-system §1 keeps `danger` for what destroys something or failed to go through, and a signed-out tool waits on the
person, which is the signal's white. Its tooltip says "Not signed in"; pressing it opens the panel with the same line:
**Sign in** for Antigravity, the terminal command for Claude Code, Codex and Cursor. The panel's heading is the agent's
name for every tool, signed in or not (no "Usage" title). A tool that is signed out is not "no agent": the "No agent
connected" mark shows only when no tool has a donut at all. A donut fades and grows in and fades out when a tool comes
or goes after the bar was first drawn.

**The first-run card.** Antigravity's card says it once: the setup line, with no grey "Not connected" above it. The card
is dimmed only before the tool is installed (not installed, installing, install failed); installed and waiting for a
sign-in it is not dimmed, since its action is the person's next step.

**Not eligible (owner 2026-10-28).** `failure.reason = ineligible` with `verifyUri` (Google's page): "Google needs to
verify this account." with **Verify account** (opens the address in the browser) and **Sign in again**, both on one line.
Without an address: "Google did not set up Antigravity for this account." and **Sign in again**. Only an `https`
address is opened.

**Motion.** Every change is animated, about 150 to 200 ms (design-system §9): the line folds in (180 ms) and out (140 ms, as every fold closes), its words change in place
(`.cc-setup-swap`, 170 ms), the bar's width is a transition (`.cc-progress`, 180 ms), a donut comes and goes
(`.cc-donut-in`, 170 ms, `.cc-donut-out`, 150 ms). Under reduced motion nothing travels: a 100 ms change of opacity.

Tests: `setupLine.test.ts` (the mapping, the live setups, the donut rule) and `e2e/fixtures/tool-setup.ts` (each state in
the dialogs, the first-run card and the panel; Chromium and WebKit).
