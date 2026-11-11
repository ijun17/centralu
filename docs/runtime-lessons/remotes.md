# Remotes: serve, ssh, PowerShell, WSL

**RE1. ssh never waits for a person.**
Happened: a password or host-key prompt nobody can answer would hang the hub (#410).
Rule: `-T -o BatchMode=yes -o ConnectTimeout=15 -- <target>`; exit 255 is "ssh could not reach"; the forward uses
`ExitOnForwardFailure`, keep-alives and `-L 127.0.0.1:L:127.0.0.1:R`, up only once a TCP connect succeeds.
Guard: `host/links/tunnel.test.ts` "asks the remote for its connection line in batch mode, then forwards on loopback
only".
Platforms: all hubs (tests skip Windows hubs).

**RE2. A target can never be read as an option.**
Rule: refuse an empty target, one starting with `-` or containing whitespace; `--` always comes first.
Guard: `host/links/links.test.ts` "adds and removes a machine through the hub, and removing it takes its sessions and
panels away".
Platforms: all.

**RE3. The fallback is decided on the remote and reported as a word.**
Happened: nvm, fnm, volta and `~/.npm-global` put npm's folder on PATH only in interactive shells; Windows OpenSSH runs
the command under PowerShell, which turns any failure into 1, and a missing command can arrive as 0 (2026-10-05).
Rule: one remote command tries the managed launcher (`<data>/remote/bin/centralu`), then `centralu` on PATH, then
`~/.centralu/bin/centralu`, then prints `CENTRALU-NOT-FOUND`; the hub reads the word, not the exit code; POSIX runs
the lookup under `sh -c` (fish). The installer's steps answer `CENTRALU-PREFLIGHT` and `CENTRALU-INSTALL` words the
same way.
Guard: `host/links/tunnel.test.ts` "says Centralu is not installed when neither answers, whatever exit code the shell
passed on, and that ssh failed when it cannot connect"; `host/links/tunnel.test.ts` "a POSIX remote runs the lookup
under sh, so a login shell like fish runs it too; the person’s own command runs as given";
`host/links/tunnel.test.ts` "runs the managed launcher before centralu on PATH and before the launcher serve keeps
(plan §10.1)" (by a real `sh`); `host/links/tunnel.test.ts` "a Windows remote tries the managed launcher before
centralu on PATH too" (the decoded script only).
Platforms: all remotes. *Changed by phase 3 step 3.*

**RE4. Nothing but plain words crosses PowerShell.**
Happened: PowerShell 5.1 mangles double quotes passed to native programs (#410).
Rule: PowerShell remotes get `-EncodedCommand` (UTF-16LE base64); WSL gets a base64 script piped to `bash -l`; a
distro name must match `^[A-Za-z0-9._-]{1,64}$`; WMI is handed its command line and folder as base64.
Guard: `host/links/tunnel.test.ts` "nothing that is not base64 crosses PowerShell, so no quote is re-parsed on the
way"; `host/links/tunnel.test.ts` "refuses a WSL distro name that could break out of its quotes";
`tooling/launcher-serve.test.ts` "hands WMI the command line and folder as base64, so no quote reaches PowerShell".
Platforms: Windows and WSL remotes. *Changed by #462.*

**RE5. WSL appends Windows' PATH.**
Happened: `command -v centralu` inside WSL found and ran the Windows npm shim under `/mnt/c/…` (#410).
Rule: the WSL lookup removes `/mnt/*` from PATH.
Guard: `host/links/tunnel.test.ts` "reaches a Windows remote through PowerShell, and a WSL distro through wsl.exe,
decoded as the remote would".
Platforms: WSL.

**RE6. WSL stops an idle distro.**
Happened: WSL stops a distro, its services included, about 15 s after its last `wsl.exe` client (a systemd `serve` was
stopped at 19 s), and empties `/tmp` with it (#410, #455).
Rule: something holds a `wsl.exe` for as long as the host must live: the forward runs
`wsl.exe -d <distro> --exec sleep infinity`; a detached host is a WMI-created `wsl.exe -d <distro> --exec <launcher>
serve`; nothing is installed under `/tmp`.
Guard: `host/links/tunnel.test.ts` "reaches a Windows remote through PowerShell, and a WSL distro through wsl.exe,
decoded as the remote would"; `tooling/launcher-serve.test.ts` "detaches with setsid on posix, through WMI on Windows,
and through a WMI-created wsl.exe inside WSL".
Platforms: WSL. *Changed by #462.*

**RE7. Only some starts outlive the ssh session.**
Happened: measured (remote-hub.md §10.4): Windows OpenSSH ends `Start-Process` children with the session; a WMI
`Win32_Process.Create` survives (15 minutes, 13 hub swaps); POSIX survives with `setsid` and a double fork. Defender's
attack surface reduction rule can block WMI.
Rule: one primitive, `centralu serve --detach`; where WMI is blocked, the host runs in the forward's own session and
ends with the link, and the hub says so.
Guard: `tooling/launcher-serve.test.ts` "starts the host in the background and returns once it answers, then stops it in
order on request"; `tooling/launcher-serve.test.ts` "reports a start WMI refused as wmi_blocked";
`host/links/tunnel.test.ts` "where WMI is blocked, runs the host in the forward’s own session instead, and it ends with
the link".
Platforms: all remotes. *Changed by #462.*

**RE8. On Windows, killing the launcher kills the host without its shutdown.**
Happened: killing a WMI-started launcher ended the host 143 ms later with no "shutting down" line: the host sits in
libuv's kill-on-close job object, so its agents die with it (remote-hub.md §10.4).
Rule: `centralu serve --stop` asks the host to stop over its own WebSocket, waits for the port to close, and only then
ends the process; on POSIX, SIGTERM to the launcher.
Guard: `tooling/launcher-serve.test.ts` "starts the host in the background and returns once it answers, then stops it in
order on request" (POSIX); the Windows path is **UNGUARDED** in CI.
Platforms: Windows. *Changed by #462.*

**RE9. Closing a link ends every ssh it started, even mid-open.**
Happened: removing a machine while its link was opening left an `ssh -N` holding a port until the host exited (#410).
Rule: `close()` ends the asking ssh and the forward (TERM, KILL after 2 s); an `open()` closed midway starts nothing
more; ssh stays in the host's process group, so the host's group stop takes it.
Guard: `host/links/links.test.ts` "closes what the tunnel opened when the machine is removed while it was opening";
`host/links/tunnel.test.ts` "closing while the remote is still being asked ends that ssh, and starts no forward after
it". The group placement is **UNGUARDED**.
Platforms: all hubs.

**RE10. The hub's ssh stays the host's child; no ControlPersist.**
Happened: probe 4 (2026-10-08): OpenSSH daemonizes a `ControlPersist` master into its own session, out of the keeper's
tree; it outlived "Quit completely" and kept one forward per swap, so the local port moved each time. The status quo
leaves no ssh behind; the link is away about 1.1 s per hub swap.
Rule: no `ControlMaster`, `ControlPersist` or `ControlPath`; host keys stay the person's own `known_hosts`.
Guard: **UNGUARDED** (the test asserts the options present, not these absent).
Platforms: macOS and Linux hubs.

**RE11. The local port keeps the remote's number when it can.**
Rule: app view addresses carry the port, so use the same number when free, otherwise an OS-picked one; if ssh's bind
fails on the same number (taken in between), retry once on an OS-picked port.
Guard: `host/links/tunnel.test.ts` "uses the same port number here when it is free, and another one when it is taken".
The race retry is **UNGUARDED**.
Platforms: all.

**RE12. The managed launcher never changes; a pointer file does.**
Happened: `cmd.exe` reads a batch file by offset while it runs, so rewriting a running `.cmd` corrupts it; `renameSync`
over an existing file is atomic on Windows; a symlink would be a junction that cannot be replaced atomically; an npm
install's `serve` rewrites `<data>/bin/centralu` on every run (remote-hub.md §10.1).
Rule: `<data>/remote/bin/centralu` reads `current` at every start and sets `CENTRALU_MANAGED=1`; switching versions is
one rename; a managed `serve` leaves `<data>/bin/` alone.
Guard: `tooling/launcher-serve.test.ts` "runs the version current names on its Node, marked managed, and follows current
when it moves"; `tooling/launcher-serve.test.ts` "leaves <data>/bin/centralu alone under the managed launcher, and keeps
it otherwise"; `tooling/launcher-serve.test.ts` "reads current and previous as two plain words, and nothing that could
leave the install". The installer's side: `host/links/install.test.ts` "replaces current by a rename, never by writing
into the file the launcher reads"; `host/links/install.test.ts` "moves the old current to previous before current
changes"; the launcher written once: `host/links/install.test.ts` "keeps current and previous only: a third version
removes the first".
Platforms: all remotes. *Changed by #462 and phase 3 step 3.*

**RE13. A running version on Windows cannot be deleted.**
Happened: removing a running `node.exe` was refused; renaming its folder was allowed (remote-hub.md §10.5).
Rule: install beside, stop, switch, start, check the version that answers, and delete old versions only after the old
host is gone; keep `current` and `previous`. The installer (step 3) switches `current` and prunes to current and
previous only, so the version a running host uses becomes `previous` and stays; a folder that cannot be removed is
reported in `left`, never fatal.
Guard: keeping current and previous: `host/links/install.test.ts` "keeps current and previous only: a third version
removes the first". Stop before switch, and the Windows refusal itself: **UNGUARDED** (phase 3 step 4, not built).
Platforms: Windows remotes. *Changed by phase 3 step 3.*

**RE14. A refused token is asked again once.**
Rule: a 4001 or 4002 refusal re-reads the connection line once; a second refusal in a row is reported and backed off.
Guard: `host/links/links.test.ts` "a refused token asks the remote again once, then reports and backs off instead of
looping".
Platforms: all.

**RE15. A remote checks what it downloads against values that did not travel with it.**
Happened: designed and measured in remote-hub.md §10.3 and §10.7: a `SHASUMS256.txt` fetched beside the archive only
catches corruption, and the remote's old install must not decide how the new one is installed.
Rule: the Node archive's SHA-256 is the one the release pinned (`remote-runtime.json`), sent by the hub; each npm
tarball's sha512 is the `integrity` the hub read from version metadata whose registry signature it checked (a
published, unexpired key, over `<name>@<version>:<integrity>`); a mismatch stops before unpacking and leaves at most
nothing, and what ran before keeps running.
Guard: `host/links/install.test.ts` "refuses a Node archive whose SHA-256 is not the pinned one, and leaves nothing";
`host/links/install.test.ts` "refuses a package whose bytes are not what the signed metadata names, and keeps what
runs"; `host/links/registry.test.ts` "refuses metadata signed by a key the registry does not publish";
`host/links/registry.test.ts` "refuses a signature made with a key that has expired". The PowerShell Node step
(`Get-FileHash`) is checked as text only: `host/links/install.test.ts` "a Windows remote checks the Node zip with
Get-FileHash and unpacks it with System32 tar.exe".
Platforms: all remotes; the Windows path is not run in CI.

**RE16. Refuse a machine the published host cannot run on before downloading anything.**
Happened: both native modules in `@centralu/linux-x64` reference `GLIBC_2.34` symbols, and the bundles carry no musl
build of node-pty (remote-hub.md §10.2): installed anyway, the host would die at its first `require`.
Rule: the preflight refuses glibc below 2.34, musl, an architecture with no package, a missing `tar`, `gzip`,
downloader or SHA-256 tool, and too little space, each in one sentence, and the hub asks the registry nothing until it
passes.
Guard: `host/links/install.test.ts` "refuses, in one sentence each, what the published host cannot run on or the
install cannot do"; `host/links/install.test.ts` "refuses before downloading anything: an old glibc there, or registry
metadata whose signature fails".
Platforms: Linux and Windows remotes.

**RE17. Every installer step fits one Windows command line.**
Happened: CreateProcess takes 32,767 characters, and a WSL script is base64 inside UTF-16LE base64 (about 5.3
characters per byte of script).
Rule: the step-2 `.mjs` travels gzipped; every step's command stays under 30,000 characters in all three shells.
Guard: `host/links/install.test.ts` "fits one Windows command line in every shell, the installer itself included".
Platforms: Windows and WSL remotes.

**RE18. A script on a Windows remote's stdin is read from the stream up to a marker line, and confirmed.**
Happened: the update of a Windows machine stopped at the `centralu` step twice (#1360): the step's PowerShell sat in
`[Console]::In.ReadToEnd()` with no child process until ssh's 30-minute limit. Reproduced on the same PC (Windows 11, OpenSSH
9.5, Windows PowerShell 5.1) through a private sshd on loopback and the installer's real command: `ReadToEnd` never
returned in 2 to 9 runs of 30 one after another and 13 to 18 of 30 ten at a time, at 17,000 characters of stdin, which is
the installer's own size; `[Console]::In.ReadLine()` up to a marker line hung in 1 to 4 runs of 30 to 80 at 100,000
characters; a `StreamReader` over `OpenStandardInput()` hung in 5 of 6; `OpenStandardInput().Read()` into a 64 KB buffer
until the marker did not hang in 200 of 200 runs at 17,000 and at 100,000 characters (and not with a 4 KB buffer, or reading to the
end). Payload size is not the cause; the text readers are. Each hung step leaves its `cmd.exe`, PowerShell and `conhost.exe`
behind on the remote (113 of them after one afternoon of tests, until new sessions failed with 0xC0000142).
Rule: a script goes on stdin as base64 and a line with one dot; the reader prints `CENTRALU-STDIN-READY`, reads bytes until
that line (a CRLF after the dot is taken too), prints `CENTRALU-STDIN-OK`, then runs the script; `exec` waits 60 s for the
first line (ssh's connecting has its own six-attempt allowance inside it; a remote that does not start PowerShell is not one
that lost its input: fail, no second try; a reader whose process is more than 30 s old when it says it runs reads nothing and exits 4,
so a PowerShell that came up after the hub gave up cannot run the step from the input waiting in its pipe) and 30 s after it for the second. The reader ends on its own 20 s after the first line,
checking the time after every read and again before it confirms (exit 4, nothing more printed), so it is gone before the hub's 30 s
are over; the hub then sends the step once more, but only for the reader's own exits (3: the input was cut; 4: its time ran out) or a missing
confirmation after 30 s; ssh's 255 or a signal after READY says nothing of what the remote did next (the confirmation may be on its way
and the step started), so it is "ssh could not reach", not sent again (the script runs only after the confirmation, so a step the
reader gave up on has not started), and
fails saying the remote never confirmed the input when that fails too.
The input is written **with the command, not after PowerShell says it runs** (measured with the final reader, 17,000 characters,
ten at a time): written at once it arrived in 80 of 80 runs (and 80 of 80 at 100,000 characters); written when READY came back,
10 and 7 of 80 and 11 of 40 never arrived within the reader's 20 s; written 100 ms after READY, 0 of 40 did. So a step cannot be
kept from receiving its input by holding the input back; the reader's own deadline is what keeps a late first reader from running
after the hub gave up.
Guard: `host/links/stdin-frame.test.ts` (the reader on Windows PowerShell 5.1 with a 100 KB script and the input never
closed, a cut input, the confirmation wait and the second try).
Platforms: Windows and WSL remotes (a WSL step is read the same way by the PowerShell that starts it).
