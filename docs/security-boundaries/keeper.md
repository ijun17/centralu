# The keeper's control socket

The keeper (`centralu-keeper`, #280, #440) is a new trust boundary: through its socket a process can read the front
door's port and a credential and stop the host. The rule:
**only this user's processes get in, and only a Centralu window gets the token** (#1405).

- **Who is a window** (`keeper/window_peer.rs`). The peer pid the kernel recorded at `connect` (`LOCAL_PEERPID`,
  `SO_PEERCRED`) names an executable (`proc_pidpath`, `/proc/<pid>/exe`) that is, by
  exact resolved path, one of the window executables the keeper accepts (`accepted_windows`): the `centralu` beside
  the keeper's own executable (the macOS bundle's `Contents/MacOS/`, a debug build), unless the keeper runs from
  `<data>/content/`, where a file dropped beside it proves nothing; and the window of each build the keeper names: its
  own `--bundle-path` and the bundle of the current host's and the next launch's build, the keeper's own since #1895 step 4 PR 4 (until
  then a window's `switch` set them) (`<bundle>/Contents/MacOS/centralu` for a macOS bundle, the executable itself elsewhere). What a client says
  about its own build in `attach` counts for nothing. A file named `centralu` anywhere else, a renamed `node` among
  them, is not a window. Linux's ` (deleted)` mark is taken only after an accepted path (an update replaced the
  file). On a keeper signed with a team identifier the executable must also be signed by that team (`codesign
  --display`), and one whose signature cannot be read is not a window; no release is signed with a team today
  (macOS releases are signed ad hoc), so in every build that ships the path decides. A peer whose pid or executable
  the kernel does not name is not a window. The keeper judges before it takes its state lock, logs every refusal with
  the executable, the accepted paths and why, and a window given the limited credential says so in its own log. A test runs
  two copies of the test binary against the socket, one at the accepted path and one named `centralu` elsewhere: only
  the first gets the token (`only_the_accepted_window_executable_gets_the_token`).
- **What a window gets.** `status` and `attach` carry the front door's token (`view.rights: "full"`), and so does
  every status pushed to it. (`switch` and `upgrade` answer `gone` to anyone.)
- **What anything else gets.** The limited credential in the token's place (`view.rights: "limited"`, `limited.rs`,
  derived as the host derives it, so it works behind the door across the host's restarts), on `status`, `attach` and
  every push to it. `stop`, `restart`, `settings`,
  `set_background` and `children` hand out no token and stay open to this user. A test sends every op from a process
  that is not a window and fails if any line it gets back holds the token
  (`no_reply_carries_the_token_to_a_process_that_is_not_a_window`); the ops are listed once (`OPS`) and a second test
  checks the list against the dispatcher.
- **A window an update replaced** (#2117, #2119). `centralu install` swaps the app bundle under the running window
  (`swap.mjs` `swapInto`: the new one copied beside, the old one renamed aside and deleted), and macOS then names no
  executable for the window's pid (`proc_pidpath` fails, every time), where Linux names the aside path with
  ` (deleted)`. A file replaced in place instead keeps its path on macOS, which now names the new file and reads as the
  window for any process started from it. So a path read after an install proves nothing either way, and the stop for
  an update ("Apply now"), which comes from exactly that window, reads none: it is a window's only when the peer is one
  of the windows attached now, each judged by its path as it attached and known since by its pid and when that process
  started (`window_peer::Attached`; a pid used again belongs to a process that started later). Every window sends it
  while attached. The keeper keeps every window it took by its path while that process runs: one whose attach ended (a
  write it missed) and that attaches again with a path that reads as no window's is taken again by its pid and start,
  with the token (`window_peer::judge_attaching`); one whose process ended leaves the list. The pid and start are read
  before the path is judged and again after (`window_peer::judge_path_of`): a window that ends while it is judged, its
  pid taken by another process, is refused, not remembered as that process. Any other pid is refused whatever its path
  reads, a process started from the window's own file that never attached included, so a replaced file widens nothing.
  `system_ending` is a window's by either rule (an attached window, or by its path), so a window the install replaced
  can still tell the host the system is ending. `status` keeps the path rule. A keeper started after the
  install (it restarted or crashed) knows no window from before it: "Apply now" is refused with "only a Centralu window
  attached to this keeper can stop it for an update; if this is Centralu's window and an update was installed while it
  ran, quit Centralu and open it again", which runs the installed build. Tests:
  `a_window_whose_executable_an_update_replaced_can_still_stop_for_the_update` (and `system_ending` from it),
  `a_window_that_attaches_again_after_an_install_can_still_stop_for_the_update`,
  `a_pid_another_process_takes_while_the_path_is_judged_is_neither_taken_nor_remembered`,
  `a_remembered_window_whose_process_ended_is_dropped`.
- **Residuals.** A process of this user can start the app's own executable, which opens a window the person sees, or
  replace the file at an accepted path (an app bundle is the user's to change). A peer can connect and then `exec` the
  window's executable, keeping its pid: the window it starts flashes on screen. A process this keeper took for a window keeps that
  record across an `exec` (its pid and start do not change), so it attaches again as a window and may stop the keeper
  for an update; only code already running in the window can `exec` it, and the window never does. `codesign --display` reads the file
  now at the path, not the code running in the peer; a team-signed keeper should judge the peer's audit token
  (`LOCAL_PEERTOKEN`, `SecCodeCopyGuestWithAttributes`) before releases are signed with a team (#1439). No
  Linux window starts a keeper since #1895 step 4 PR 7. A window there runs from its AppImage's mount, whose path
  changes at every launch, so a keeper would accept only the window that started it; to settle before a Linux keeper
  is ever brought back.
  A debug keeper started with `CC_KEEPER_TEST_WINDOW_EXE=<path>` also accepts that executable, for the integration
  scripts, which pass the `node` that runs them; a release keeper compiles that out. An older keeper (before #1405) still hands the
  token to every process until the app is fully quit or the keeper is updated (its update hands over to a keeper that
  judges windows).

- The socket is `<data>/keeper.sock`, created under `umask 077` so it is born `0600`, with no window before a chmod.
- Every connection's peer uid is read from the kernel (`getpeereid` on macOS, `SO_PEERCRED` on Linux) and the
  connection is dropped unless it is the keeper's own uid.
- A request line is capped at 256 KiB, and a connection that sends nothing in 5 seconds is closed (except an
  attach, which is held open on purpose).
- `keeper.json`, `keeper-settings.json` and `keeper.log` are written `0600` and hold no token. The host's stderr goes
  to `keeper.log` as well as `host.log`; the host never writes its token to stderr.
- Per-build copies live in `<data>/hosts/` (folders created `0700`). A build key is limited to
  `[A-Za-z0-9_-]`, so a commit string cannot name a path outside that folder.

Limits:

- `switch` ran `main.mjs` from whatever host folder the request named, so only a window could ask (#1405); it answers
  `gone` to anyone since #1895 step 4 PR 4. A process of this user can still replace the files of a host folder; that
  is the same-user residual, not a boundary: a host the keeper restarts after it exits runs from its copy as the copy is (`<data>/hosts/<key>/`,
  or `<data>/content/<version>/host/`, not verified again before each launch), so a process that edits the copy and
  then ends the host (its pid is in `status`) has its own code started with the token.
- `children` (#538) lists what the keeper holds (each child's id, pid, kind, tag and state), read-only: the child
  socket that used to answer it now answers only the keeper's hosts.
- The socket is local only. Windows has no keeper yet (named pipes and their ACLs are not written). On Windows the
  host is the window's or `centralu serve`'s child, and gets its token on stdin from `centralu serve` as above; the
  window's host makes its own and says it on its ready line.

## The front door

Under the keeper, clients connect to the keeper's **front door** (#280 step 3), which relays bytes to the current
host. It changes where a client connects, not what it must prove:

- It listens on **loopback only** (`127.0.0.1`), on a port chosen when the keeper starts. Any process on this
  machine can open a TCP connection to it, exactly as it could to a host before. The door adds no authentication of
  its own and checks nothing: every byte goes to the host, which still requires the token in `hello` and still
  applies the `Origin` rule to the browser's own header (the relay passes the upgrade request through unchanged).
- **The token is the keeper's**, 16 random bytes from `/dev/urandom`, one per keeper lifetime. It reaches clients
  only through the user-only control socket, and hosts as the first line on their stdin (#538, owner decision
  2026-10-18): `{"token":…}`, with `CC_HOST_TOKEN_ON_STDIN=1` telling the host to read it there
  (`lifecycle/handed-token.ts`) before the control lines that follow. Not in their environment (below), for every
  host from 0.1.0-beta.45 on reads it there (`server/host.rs`, `prepare_host`, #1143). It is never written to
  `keeper.json`, `keeper.log` or `host.log`.
- **Deleting it hides it from children only, not from other processes of the same user.** Measured on macOS 27.0.1
  (build 26A434, 2026-10-11): a node process started with `CC_PROBE_SECRET=<marker>` deleted it from `process.env`
  at once and set another variable afterwards. From a separate process of the same user, started with an empty
  environment (`env -i`), `ps eww -p <pid>`, `ps -E -ww -p <pid>` and a `sysctl` read of `KERN_PROCARGS2` (2,164
  bytes back) all printed `CC_PROBE_SECRET=<marker>`; the variable set after start appeared in none of them. The
  same `sysctl` for pid 1, a root process, failed with `EINVAL`. So what a process is started with stays readable
  to every process of its user for as long as it runs; on Linux `/proc/<pid>/environ` is the same initial block
  (not measured here). That is why the keeper and `centralu serve` stopped putting the token there (#538): a pipe's
  bytes are read once, by the one process holding its end. What was left: the control socket's `status` and `attach`
  handed the token to any process of this user, since every window needs it and no window is the keeper's child
  (the owner kept that path when deciding #538). Since #1405 they hand it only to a Centralu window, judged by the
  exact path of the executable the kernel names for the peer ("The keeper's control socket" above); any other process gets the limited
  credential. So the token is not one request away any more, though it is still not a wall between processes of the
  same user (the residuals above); it is no longer in any process's start environment for one to read.
- **The Codex bridge gets a credential of its own, not the token** (#382, owner question 4, decided 2026-10-11).
  Codex starts the bridge with the front door's address and `CC_BRIDGE_TOKEN`, an HMAC of the bridge's session id
  keyed by the token (`transport/bridge-token.ts`, `bridgeAddress`). Before this the bridge held the token itself,
  so a command a session ran could take it from the bridge's environment as measured above and call every RPC:
  set its own preset to auto (`agents.updateSettings`), trust a project (`projects.setTrusted`). A socket that says
  hello with a bridge credential is not a client: it gets `hello_ok` and nothing else (no replay, no broadcast, no
  terminal output), and may call only `assistant.tools`, `assistant.tool` (or their old names `orchestrator.*`), `apps.sessionTools` and
  `apps.sessionCall`, each naming the credential's own session (`bridgeRefusal`); everything else is refused before
  it reaches the handler (`server.test.ts`, `app-bridge.test.ts`). Because it is derived from the front door's token,
  the next host after a swap accepts it with nothing handed over or stored, and a running bridge keeps working
  (`scripts/keeper-integration.mjs`, the swap scenario). What it still opens is that session's own Centralu tools and
  attached apps as that session, gated by the session's profile like the session's own calls; a process that reads
  an Assistant's bridge gets the Assistant's set. It is valid for the keeper's lifetime. This takes the token
  out of the one process that held it for a session; per the bullet above, the token itself stays within reach of
  the same user.
- A stable token is a longer-lived secret than a token per host. It lives as long as the keeper, which is as long as
  the agents it serves; a keeper restart makes a new one, and so does an update, which restarts the keeper (until
  #1895 step 4 PR 4 a keeper update passed the same one on over the handoff channel below).
- While no host is ready, the door holds a connection up to 45 s before closing it, so an unauthenticated
  connection costs at most a socket and a thread for that long; after a host is up, the host's own handshake
  timeout (10 s) applies.
