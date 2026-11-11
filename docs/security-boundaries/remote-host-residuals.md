# The remote host: what it leaves open

- **Other users on the remote machine** can connect to 127.0.0.1 like anyone local, and are stopped by the token, as on
  a desktop. A machine where another user can read your files (root, or a wrong home-folder mode) can read the token;
  the remote mode is for a machine the person trusts, and the spec says so (product-spec.md §1.5).
- **Single trusted user.** One host per data folder (the ownership lock), one person's sign-ins. There is no
  account model and no sharing between people.
- **The reverse direction** (#550). A host calls a hub linked to it only on the connection that hub opened and offered
  on (`host.hubOffer`), with `rpc` frames the hub answers only through its link's allowlist ("A linked machine's session
  asking this computer", above). A window, or anything else holding the token, that offers itself as a hub only makes
  the machine's sessions send it their asks: the token already gives it more than that.
- **An administrator's ssh on Windows runs everything elevated** (#702). Windows OpenSSH gives an account in the
  Administrators group a full token for a network logon, with no UAC split, so a host the hub starts over ssh, every
  agent it starts and every tool call they make run with administrator rights, where the same person at the desktop
  would run them unelevated. Centralu does not refuse it (the person may want it); the host says so in its hello
  (`hello_ok.elevated`, from the token's integrity level) and the machine's row in Settings → Machines says it in one
  sentence with the way out: link the machine through a standard account with its own ssh key. A host running as root
  on Linux or macOS is reported the same way.
- **A host started over ssh on Windows has no access to the person's saved sign-ins** (#1224). A key login is a network
  logon without the password, so DPAPI cannot unlock the user's master key and Credential Manager reads as empty
  (measured: `cmdkey /list` printed `* NONE *` there while the profile held 46 saved credentials). Git Credential
  Manager can neither use nor save a sign-in. Centralu does not work around it (no plaintext store, no token carried
  through Centralu): the host says which logon it runs in (`hello_ok.logon`) and the machine's row says what that means.
- **A dev build on a linked machine** (`pnpm remote-dev`, #1036; [plans/remote-hub.md](../plans/remote-hub.md) §10.11)
  sends nothing new across the link (no file travels but the installer every update sends), but it does run what is
  on that machine: the working copy there, by its own bundler on the pinned Node, at a commit the hub named in full and
  checked there first (HEAD must equal it, no uncommitted changes unless the maintainer allows them, the hub's
  protocol), and the git on that machine's PATH to check it (the installer runs on its own Node and cannot use the
  host's `runGit`, so a repository's own git configuration applies there as when the maintainer runs git in it). It
  is a command on the hub over the link's own ssh, never an RPC, so an agent or a linked machine cannot start one; it
  hands the swap to the machine as an update does (`serve --switch`, remote-hub.md §10.5a), whose lock only makes
  starts wait while a live switcher holds it. The build is marked (`install.json`
  `source: { kind: 'dev' }`, shown on the machine's row), so it is never taken for a release. Going back is not free:
  the dev build runs on the machine's real store and may migrate it past what the release reads; the store is copied
  before the dev build first opens it and put back when the dev build does not answer, or when the release will not
  start on it, which drops what was done on the dev build since. Only the store is copied.
- **Headless.** The host starts without `DISPLAY` / `WAYLAND_DISPLAY`, so nothing it starts can raise a window or a
  keyring prompt on that machine.
- **What the client must not do:** forward with a wildcard bind address (`-L 0.0.0.0:…`) or `GatewayPorts`, which
  would expose the host's port on the client's network with only the token in front of it.
- **Other users on the person's computer** (#838). The forward's local end is a loopback port, and any account there
  can listen on it first: the forward counts as up when something accepts on the port, and the hub's hello carries
  the remote's token. So before the hello the hub asks the host to prove it holds the token (`prove`: an HMAC of a
  fresh nonce under the token, with a label no other derived secret uses, `transport/host-proof.ts`), and sends the
  hello only to a host that does. Something else on the port gets a nonce, never the token, and the link reports
  itself down. The hub asks only when the connection line says the host can (`proof`, which every `serve --connection`
  from 0.1.0-beta.45 on writes, never taken from what answers on the port, which could otherwise make the line say
  no); a remote from before #838 has no `proof` and gets the
  hello as before, so on such a remote this hole stays open until it is updated. A host that refuses the `prove`
  (a machine rolled back to such a build) is a refusal: the hub reads the line again rather than retrying.
- **Residual: the proof under a stored verifier** (#1405 review, held for the owner). A hub that paired proves the
  host with `credentialProof`, keyed by its credential's verifier, which `serve.json` holds. A process of the same user
  on the linked machine that reads the file can therefore stop the host (`host.stop` is everyday, or `kill`), listen on
  its port, answer the hub's `prove { credential }` from the file, and receive the hub's full credential in the hello
  that follows. That credential is never listed as an "other" one. This is no worse than before #1405, when the file
  held the token itself, but a reader of `serve.json` gets more than the limited credential through it. Closing it needs
  an asymmetric pairing (the verifier a public key, the hub signing the host's nonce instead of sending a bearer
  credential); until the owner decides, it stays a stated residual. Another account cannot take this path: it cannot
  read the 0600 file. The design that closes it (#1711, proposed): [plans/key-pairing.md](../plans/key-pairing.md).
- **The same on the linked machine.** `serve --connection`, `serve` and `serve --stop` ask the host on the recorded
  port with the token, and another account there can hold that port while the host is down. They send `prove` first
  and the hello only to a host that proved it (`helloSocket` in `serve-host.mjs`, beside `serve.mjs`).
  Something on the port that does not prove is not this folder's host unless the folder's `host.lock` names a live
  process that started when the lock says (`ps -o lstart`, `lockHolderIsAlive`; on Windows, which has no `ps`, one created
  by the `at` the lock records, read from PowerShell, #1723) and that `serve` started: a host still
  on its old key after `--rotate-token`, which then counts as running and is stopped by its pid. A lock a dead host
  left, whose pid another process now has, or one that gives no start time and no `at`, does not count, so
  `--stop` never signals a stranger.
- **A linked machine updated without a restart** runs an older host than the one installed: its line says `proof`
  (from the installed build), the host refuses the `prove`, and the link says so ("runs an older Centralu host than
  the one installed there") and asks for a restart (`centralu serve --stop`, then start it), rather than reporting a
  token problem. The hub sends it no token meanwhile. A Unix-socket forward
  in a 0700 folder was the other choice; it was not taken because a Windows hub's Node cannot connect to the
  AF_UNIX socket OpenSSH would create there, while the proof works with every hub and every remote.
