# The data folder and local transport

## The data folder (#838)

The data folder (`~/.centralu`, or `CC_DATA_DIR`) holds every conversation (`store.db`), the remembered consents and
the host's log. It was `0755` with `store.db` and `host.log` `0644`, readable by every account on the machine. At each
start the host makes it its owner's only (`keepDataFolderPrivate` in `data-dir.ts`, before the store or the log opens):
the folder `0700`, and `store.db`, its WAL and SHM files and the host's logs `0600` when they are wider; a new
`host.log` is created `0600`. Only what the owner owns and what is not a link is changed, only for the data folder
itself (a `--db` elsewhere is left alone), and not on Windows, whose profile folder's ACL is already per user.

The folder's own mode is what protects the rest: a file written later with the default mode (an older build serving
during a swap, an app's data, SQLite) is still behind a folder only its owner can enter, and an older build never
widens the folder again. The host's `umask` is not changed: it is every agent's and every terminal's, and the files
they write in the person's projects keep the person's own modes.

### Antigravity's agent and its token (#59)

Centralu installs Google's Antigravity agent itself and keeps all of its state under the data folder
(`tools/antigravity/`, [plans/antigravity-acp.md](../plans/antigravity-acp.md) §3, §4), so it sits behind the folder's
`0700`. The rules that hold it:

- **Only the pinned build runs.** `agents.installTool` downloads the one archive this Centralu pins and refuses it unless
  its sha256 is the pinned one, before anything is unpacked; only the files the release names, as plain files, are
  written, and the folder is put in place by one rename. The method `asks` for the limited credential: it brings in a
  program that later runs.
- **The agent's home is Centralu's.** Every process starts with `GEMINI_HOME` there, never the person's `~/.gemini`, so
  none of their global MCP servers, hooks or skills load into a Centralu session, and Centralu never reads the CLI's
  sign-in. The agent keeps the person's `HOME`, so its commands see their git, ssh and npm settings; one thing escapes
  `GEMINI_HOME` because of it: Google's harness extracts its screencast encoder (`webm_encoder`) into
  `$HOME/.gemini/antigravity/bin/` at the first prompt. Nothing else under `~/.gemini` was read or written in the
  measured runs, and development and review runs use a temporary `HOME`. The owner accepted this
  ([#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6446873429);
  [plans/antigravity-acp.md](../plans/antigravity-acp.md) §4.1).
- **The token is in the agent's own store, as Google ships it.** Centralu sets no store (owner 2026-10-28,
  [#59](https://github.com/ijun17/centralu/issues/59#issuecomment-6461617566)). Agent 1.4.3 uses the macOS Keychain when
  a probe of it works (service `gemini`, account `antigravity-acp`; the program is signed with Google's Developer ID, so
  a Keychain prompt, if any, names Google's `agy_acp_server`, not Centralu), and otherwise the file
  `gemini-home/antigravity-acp/acp_token.json` (mode 0600): always on Windows and Linux. Centralu never reads the
  Keychain and never opens or looks for the file; signed in is read from `auth.type` in the agent's `settings.json`
  alone, and a sign-in that no longer works is told when a session's process asks for the agent's own login (below).
  **What Auto still reaches**, and more: nothing in Centralu keeps the agent from its own folder. Its viewer and search
  read the token file without asking under every preset where the file is the store (Windows, Linux), as Codex reads
  its `auth.json`; no built-in tool is switched off (no `_meta.antigravity.disabledTools`), no client read is offered
  (`fs.readTextFile` false), and a permission request naming that folder is answered as any other of its kind (a card
  under Safe, Normal and Edits, unasked under Auto or a saved rule). A subagent's request (`Run invoke_subagent?`, kind
  `other`) runs unasked under Auto and asks with a card every time under the other presets: a call of kind `other` has
  no rule key, so no saved "always" rule allows it. The guard of the first
  build, which refused such requests under every preset, is gone, so a request is never refused for the path it names
  ([plans/antigravity-acp.md](../plans/antigravity-acp.md) §4.2 says why).
- **The sign-in address stays out of logs and events.** It reaches the host through a private folder (`0700`) and the
  agent's stderr, is opened once and only when it is the agent's own login request (its OAuth client on Google's
  authorize page, a loopback redirect), and no `tool_setup` event carries it.
- **The agent never starts a browser, and the person's `BROWSER` never reaches it.** Every Antigravity process gets
  `BROWSER` set to Centralu's helper in that private folder (on Windows a `node` command line run with no shell, since
  `cmd` would split the address at `&`). The host opens the address, on Windows through the terminal broker, outside
  the host's job object, so a Stop, a finished sign-in or the host's exit cannot end the person's browser and its tabs
  ([plans/antigravity-acp.md](../plans/antigravity-acp.md) §4.3). In a session, the helper handed the agent's own login
  request means the stored sign-in stopped working: the session fails as `not_logged_in` and its process ends. Commands
  the agent runs inherit `BROWSER`, so any other address they hand it is dropped and logged without the address, never
  opened and never taken for a sign-in: nothing is opened that the person did not ask for (antigravity-acp.md §4.4). Where the data
  folder's path cannot be put in `BROWSER` (it holds `;` on Windows, `:` elsewhere, or `%s`), the helper's private
  folder is made in a folder of the person's own instead, built from the home folder alone
  (`~\AppData\Local\centralu-antigravity`, `~/Library/Caches/centralu-antigravity`, `~/.cache/centralu-antigravity`;
  no variable such as `TEMP`, `LOCALAPPDATA` or `XDG_CACHE_HOME`, which may name a shared folder): per user by the OS's
  defaults (on Windows its ACL is the profile's; elsewhere it is made 0700 and used only as a real folder, not a link,
  owned by the person and writable by no one else, below folders only the person or root can change, sticky ones such
  as `/tmp` aside; a `~/.cache` that is a link is followed and judged where it leads), not a folder a cleaner empties
  by age, and every path given to `BROWSER` is absolute. A host that crashes leaves its helper folder there until the next
  helper is made there (it holds no token). Where no helper can be written even so, the
  agent is not started, and the error names the path and the character. Lines of
  the agent's stderr that hold an address, an email or a token's name never reach `host.log` or a crash message.
- **The agent never decides alone.** It stays in its `default` mode, where it asks; `allow_always` is never sent, so no
  rule of its own outlives Centralu's preset; a question it asks is the person's to answer under every preset.

## Local transport

The host listens on loopback and requires a token that is not blank — whitespace-only is
refused at construction, matching the trim the browser entry point already applies.
Browser/WebView connections must additionally match the explicit origin allowlist, which
`CC_HOST_ALLOWED_ORIGINS` (comma-separated) replaces when set. A client without an Origin
header still needs the token; Origin is a browser defense, not native-client identity.
Literal `Origin: null` is rejected. A rejected upgrade is logged by the host, because the
browser does not hand the 403 to the page. Development tokens should be generated per launch and shared
only with the intended local client. Mock/demo modes do not connect to the host.

A socket that has not sent a valid hello within 10 seconds is closed, and a socket whose undrained
outbound backlog passes 64 MiB is cut, so a connection cannot make the host hold unbounded memory or
an endless slot (#82; `transport/server.ts`, `TRANSPORT_LIMITS`). Before its hello a socket may send
one frame of at most 64 KiB and it must be a hello: anything else closes it (4001), and bytes are
counted as they are read, so a socket that sends more than that before hello is cut without the frame
having to arrive. At most 16 sockets may wait for their hello at once; a further upgrade is refused
with a 503. A slot is given back only when its socket is gone: a socket that times out or is refused
gets its close frame, and is cut if the peer does not answer within a quarter of a second. After hello
a frame may be up to 100 MiB (the library's default, set explicitly); a bigger one closes the socket
(1009). The token is compared in constant time. An authenticated socket's hello is
answered once; a repeat is ignored. A hello may carry a Codex bridge's credential instead of the token
(#382, "The front door" in [keeper.md](keeper.md#the-front-door)); that socket receives no events and may call only its own session's
bridge RPCs. It may also carry the limited credential, which calls only the everyday methods (credentials.md "Who holds full power").

`pnpm dev:live` (#739) is the one script that puts a host credential into a browser page. It reads the running
app's front door port and credential from the keeper's `status` and gives them to the Vite it starts, as
`VITE_HOST_URL` and `VITE_HOST_TOKEN` in that child's environment only (not printed, not written anywhere). Since
#1405 the script is not a window to the keeper, so the credential is the limited one (owner, 2026-10-21): the page
reads every conversation and does the everyday things, and what cannot be undone raises a card in the app's own
window (or, for the person's own answers, is refused). Vite bundles `VITE_*` values into the page, so the page it
serves, on `http://127.0.0.1:5173` or `:5174`, holds that credential. That page does **not** have the protection of the keeper
socket ([keeper.md](keeper.md): `0600`, peer uid checked). A loopback TCP port is not per user:
on a machine with other users, any of them can fetch `http://127.0.0.1:5173/` and read the token from the
served bundle, and then connect to the front door and read every conversation. So `dev:live` is for single-user
machines, and it prints a warning saying so. The dev server listens on `127.0.0.1` only (never `0.0.0.0`): do not expose it (no
`--host` other than `127.0.0.1`, no tunnel). The credential is derived from the front door's token, which the keeper makes once per
keeper lifetime and keeps across the host's restarts (`front_door.rs`); it changes only when the
keeper restarts, that is, when the app is fully quit and opened again, and the script is run again then.
