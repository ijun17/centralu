# Run a trusted remote host through SSH

This is an **opt-in, source-run, single-user** path. The desktop remains local by
default. Each execution machine needs Node >=22, the repository's pnpm version,
OpenSSH, and whichever Claude/Codex CLI you use, installed and authenticated **on that
machine**. A browser tab controls one host; use distinct local ports/tabs for more hosts.
There is no account service, shared database, scheduler, migration or automatic failover.

## 1. Start the host on the execution machine

In a source checkout with dependencies installed:

```sh
pnpm install --frozen-lockfile
mkdir -p "$HOME/.centralu-remote"
(umask 077; openssl rand -hex 32 > "$HOME/.centralu-remote/access-token")
pnpm remote:serve -- --port 5175 --host-label build-machine \
  --db "$HOME/.centralu-remote/store.db" \
  --token-file "$HOME/.centralu-remote/access-token"
```

Use a private token file (or `CC_HOST_TOKEN`), never `--token` for remote mode. Do not
paste the token into command arguments, URLs, logs or screenshots. The remote build
must not receive a real `VITE_HOST_TOKEN`; the supported launcher clears build-time
host endpoint/token variables. Browser entry keeps the token only in memory and asks
again after reload. Token length is checked, but **generate random tokens** rather
than memorable passwords. Give it only to a trusted user: it grants the host user's
full Centralu execution capabilities, not a restricted shared workspace.

Keep the host running in a separate terminal, tmux session or your process supervisor.
The tunnel does not start or supervise it. Stopping the host stops its child workloads;
closing a browser or tunnel does not. The listener stays on `127.0.0.1`.

## 2. Establish SSH trust on the viewing machine

Configure an existing SSH alias/key using your normal SSH administration procedure.
Verify the host key out of band before adding it to known_hosts. The launcher requires
preconfigured non-interactive authentication and **StrictHostKeyChecking=yes**. It
never accepts a new/changed host key or disables verification for convenience.

Then, from a checkout on the viewing machine:

```sh
pnpm install --frozen-lockfile
pnpm remote -- --host build-machine --local-port 5176 --remote-port 5175
```

Open `http://127.0.0.1:5176/?remote=1`, check the execution-host label and enter the token.
The label is informational; the verified SSH host key establishes machine identity.
Projects/file paths/terminals/CLI sessions refer to the **execution machine**. Browser
native file selection is not a remote filesystem picker; enter remote project paths
through the existing browser path prompt. Local desktop reveal/open-in-IDE features
are not remote OS integration.

For a second host, use a different local port (for example 5177), its SSH alias and its
own token. Do not reuse one data directory or mount a host's SQLite files over NFS/SMB.

## Failure and recovery contract

- SSH uses `-N -T -L`, explicit client loopback binding, `BatchMode=yes`,
  `StrictHostKeyChecking=yes`, `ExitOnForwardFailure=yes`, and encrypted-channel
  liveness probes (`ServerAliveInterval=15`, `ServerAliveCountMax=3`). No remote shell
  command is assembled or executed. [OpenSSH forwarding](https://man.openbsd.org/ssh.1),
  [configuration semantics](https://man.openbsd.org/ssh_config.5).
- The printed local URL and successful SSH listener setup do **not** prove the remote
  service is reachable. Browser authentication followed by `hello_ok` proves readiness.
- On tunnel loss, the browser reconnects with backoff. Reopen the same forward to
  observe the existing host. Retained events replay; an expired cursor or replacement
  host triggers snapshot recovery. Terminal output uses scrollback, not event replay.
- An already-sent command with no response has an **unknown outcome**. Check the host's
  state before retrying. Centralu never blindly resends it, migrates it or schedules a
  replacement elsewhere. Unsent queued calls are bounded and can expire.
- A slow/oversized peer may be disconnected instead of growing memory without bound.
- Local process ownership is held by SQLite in `host-ownership.sqlite`; crash exit
  releases it automatically. Do not unlink this file while any host may be alive.
  `host.lock` is diagnostic metadata, not a distributed lease. Stop old hosts before
  upgrading; mixed concurrent host versions are unsupported.
- Token rotation requires a host restart and browser re-authentication. Stop a host
  only after accounting for active workloads. SSH host-key errors require actual
  identity verification, not weaker options.

## Validation

```sh
pnpm remote -- --help
pnpm host --help
pnpm verify
pnpm build
pnpm e2e
```

The regression suites cover handshake readiness, replay/epoch changes, uncertainty,
resource bounds, real-socket recovery, atomic cross-process ownership, static asset
containment, runtime auth and strict SSH argument construction. A local SSH fixture can
prove the encrypted forwarding path and independently running host processes; it is
**not evidence of two physical machines or live model-provider execution**. Release
and PR evidence must state which of those surfaces were actually exercised.
