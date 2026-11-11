# Remote mode: linked machines

**What phase 1 does not cover yet.** Installing and updating the remote over ssh is phase 3 ([plans/remote-hub.md](../../plans/remote-hub.md) §10), of which the
link starting a host it finds not running is in. `processes.strays/stop` and the quit dialog still ask this computer
only.

| File | What it holds |
|---|---|
| [serve.md](serve.md) | `centralu serve`: the remote machine's host, its commands, `--detach` and `--stop`, the Node floor, the managed launcher, boot |
| [hub-links.md](hub-links.md) | The hub's links: the pieces, the ssh transport, starting a machine's host, the Node floor, the transport's decisions |
| [install-and-update.md](install-and-update.md) | Picking a machine from the ssh config; installing, updating, rolling back, uninstalling; following the hub; starting at boot |
| [link-states.md](link-states.md) | The link's states, auto reconnect, versions, after connecting, the Assistant across machines, the window's side |
