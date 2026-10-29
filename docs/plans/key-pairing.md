# Pairing a hub and a linked machine with keys (#1711)

> **Status: proposed (2026-10-30), design only.** Nothing here is built. The first pull request is this document; each
> later one updates it with what it built and measured. It closes the residual in
> [security-boundaries.md](../security-boundaries.md), "The remote host", **Residual: the proof under a stored
> verifier** (#1405 review, held for the owner; owner decision 2026-10-29: do it after the #1405 stack).
>
> **Short version.**
> 1. The hub has one Ed25519 key pair (`node:crypto`); the private key stays on the hub's computer. A linked machine's
>    `serve.json` holds the hub's **public** key in place of a verifier. Nothing a reader of that file finds opens the
>    machine's host whole, and nothing that crosses the link can be used again.
> 2. The machine's host has an Ed25519 key too, derived from the `key` `serve.json` already holds, so it needs no new
>    secret, survives a host swap and changes with `--rotate-token`.
> 3. Before hello, the two sign one transcript: both nonces, both public keys and the loopback address the hub forwards
>    to, each under its own role label. The host's nonce is fresh per socket and used once. A captured signature is
>    worth nothing on any other socket, at any other address or against any other key.
> 4. Pairing rides the ssh command the hub already runs at each link (`serve --connection`), which the person's own
>    ssh authenticates: `--pair-key <label> <public key>` in place of `--pair <label>`. No trust on first use of
>    Centralu's own port, and no prompt.
> 5. Old builds on either side keep pairing by verifier, as today, until both sides are new. Agents keep
>    `CC_HOST_CREDENTIAL` (#1438) and never see a key.

## 1. What is wrong today

A hub links a machine by running, over the person's ssh, `centralu serve --connection --pair hub:<name>-<key>`
(`tunnel.ts` `connectionLine`). The launcher there mints a full credential, writes its SHA-256 (the verifier) into
`serve.json` (`serve-files.mjs` `pairServe`) and prints the credential once, on the ssh channel. The hub keeps it in
memory, opens the ssh local forward, and on each socket:

1. sends `prove { nonce, credential: <id> }` (`remote-client.ts`);
2. the host answers `proof { mac }`, an HMAC of the nonce under the **verifier** (`host-proof.ts` `credentialProof`);
3. the hub checks it with `verifierOf(credential)` and then sends `hello { token: <credential> }`;
4. the host takes the hello as full when the credential's verifier is in `serve.json` (`serve-credentials.ts`
   `isFullCredential`).

The proof is keyed by something the file holds. A process of the same user on the machine reads `serve.json`, stops
the host (`host.stop` is everyday, or `kill`), listens on its port, answers step 2 from the file, and receives the hub's
full credential in step 3. That credential is the hub's own, so no row lists it as an "other" one: full, unconfirmed
power on that machine, one file read and one port away. Hiding or encrypting the file does not help; the same user can
read whatever the host can.

## 2. Threat model

**Who.** As in #1405 ("Who holds full power"): a process of the person's own user that is not the person's click in
a window. Here, one on the **linked machine**: an agent the machine's host started (it has `CC_HOST_CREDENTIAL`, the
limited rights), a script it wrote, a tool or MCP server there, or anything else running as that user. Also, as before,
**another account** on either computer (#838).

**What it can already do, and keeps doing.** Anything the user can do on that machine: delete or edit `store.db`,
read process memory where the OS lets it, replace the installed host's code, run `serve --pair` (loud: the hub's row
lists it, with Revoke), read the `key` (the limited credential, a session's and a bridge's credential). None of that is
closed here. The aim is the one #1405 set: no file and no documented interface gives full, unlisted power.

| Attack | Today | With keys |
|---|---|---|
| **Stolen `serve.json`** | the key, and the verifiers: the proof of step 2 for any paired hub | the key (as today: the limited credential, and now also the host's signing key), the hubs' **public** keys. No full credential follows from any of it |
| **Impersonating the machine's port** (stop the host, listen on its port) | receives the hub's full credential in the hello | receives a signature over a nonce it chose and its own transcript; it opens nothing elsewhere (§4.3). It can still stand in for the machine's host toward the hub, which the same user can do anyway by replacing the host's code; what a machine may ask a hub is bounded by the hub's reverse allowlist (#550), unchanged |
| **Replay** of anything seen on the link | the credential is a bearer: reusable until the next pairing | each signature covers a host nonce minted for one socket and dropped at its hello or its 10 s hello timeout |
| **Relay** (sit between the hub and a real host, passing each frame on) | not needed: the bearer is enough | the transcript names the address the hub forwards to and the host's own key; a real host elsewhere refuses it (§4.3) |
| **Another account on the hub's computer** taking the forward's local port first (#838) | gets a nonce, never the credential | the same: it cannot sign as the machine (it cannot read the 0600 file there), so the hub never sends its signature |
| **Another account on the machine** | stopped by the 0600 file | the same |

**What this does not defend.** A process of the user on the hub's own computer can do whatever the hub can (ssh to the
machine with the person's key, read the hub's key file); the keychain option in §6 narrows only the reading of files.
A same-user program on the machine that starts a host of its own with forged start parameters, or patches the host's
code, can relay or act as it likes: that is at the level of editing `store.db`, not one request away.

## 3. Prior art

Read on 2026-10-30. Two local probes ran on Node 22 with its bundled OpenSSL 3.5 on Windows. Nothing was copied from
any project. None of the projects read is under the AGPL.

**Noise** ([noiseprotocol.org/noise.html](https://noiseprotocol.org/noise.html)).
- XX is `-> e` / `<- e, ee, s, es` / `-> s, se`; IK is `<- s ... -> e, es, s, ss` / `<- e, ee, se` (§7.5).
- IK's first message is the zero-RTT one (§10.4). The spec says it "can also be replayed, since there's no ephemeral
  contribution from the recipient" (§7.7, destination property 2), so it must carry nothing with an effect.
- The handshake hash `h` identifies the session and is what channel binding should use (§11.2, §14).
- What to take from it: both sides sign over something only this session has, and the responder adds fresh randomness
  before anything is accepted. That is the host's `Ns` in §4.3.
- `node:crypto` has everything `Noise_XX_25519_ChaChaPoly_SHA256` needs: `crypto.diffieHellman` on X25519 KeyObjects,
  `chacha20-poly1305` with AAD and tags, and `sha256`/`blake2s256`. The probe confirmed all of them.
- The maintained JavaScript implementations are each tied to a stack. One is libp2p's XX-only handshake, which runs on
  `node:crypto` in Node. One is a generic-pattern library on a native sodium binding. One is a beta npm package with no
  release in three years.
- Cost: a handshake written by hand or a dependency, plus framing that encrypts every message.

**Mutual TLS with pinned keys.**
- Ed25519 certificates work for mutual TLS 1.3 in Node. The probe used `requestCert`, `rejectUnauthorized: false`, then
  pinned `getPeerX509Certificate().fingerprint256` on both ends, and the handshake completed.
- The pin is then the whole authentication: the peer reports `DEPTH_ZERO_SELF_SIGNED_CERT`.
- TLS 1.3's CertificateVerify signs the transcript (RFC 8446 §4.4.3). `tlsSocket.exportKeyingMaterial` gives the
  RFC 9266 `tls-exporter` binding.
- Node cannot make a certificate. `X509Certificate` "provides read-only access to its information" (Node `crypto`
  docs). So the options are the `openssl` CLI, a dependency, or DER written by hand and signed with `crypto.sign`.
- Cost: that, a second layer of encryption inside ssh, and certificates to renew.

**ssh's own keys.**
- A client needs prior knowledge of the host key, and skipping the check exposes it to an active man in the middle
  (RFC 4251 §4.1). `StrictHostKeyChecking accept-new` takes new keys and refuses changed ones (ssh_config(5)).
- A user-auth signature covers the session identifier, which is the exchange hash H of the first key exchange
  (RFC 4252 §7, RFC 4253 §7.2). So a signature verifies only in the session that produced it.
- ssh-agent's `session-bind@openssh.com` binds an agent connection to that identifier and the host key (OpenSSH
  `PROTOCOL.agent`).
- What to take from it: sign over what names this session (§4.3's transcript), and install keys over a channel that is
  already authenticated (§4.2). Here that channel is ssh, so there is no first use to trust.

**Tools that link a local app to remote hosts over ssh.**

| Tool (licence) | Channel | What a same-user process on the remote can take | Evidence |
|---|---|---|---|
| VS Code's server (the MIT part) | a loopback port through ssh, with a connection token | the token: a bearer, in a 0600 file under the user-data folder; the client does not authenticate the server by key | `microsoft/vscode` `src/vs/server/node/serverConnectionToken.ts` (`parseServerConnectionToken`, `determineServerConnectionToken`, `requestHasValidConnectionToken`). The extra `sign` step is closed-source (`vsda`), so unconfirmed |
| Mutagen (MIT) | the ssh process's stdio | nothing secret: ssh is the authentication | `mutagen-io/mutagen` `pkg/agent/dial.go` `connect`, `pkg/agent/handshake.go` (magic bytes only) |
| distant (MIT/Apache-2.0) | a key printed on the ssh exec's stdout, then a direct-tcpip channel to 127.0.0.1 | the key is made per launch and kept in memory, but the key exchange is unauthenticated and the static-key method sends the key itself. Whoever holds the port receives it, which is today's weakness here | `chipsenkbeil/distant` `distant-ssh/src/lib.rs` `launch_impl`, `distant-core/src/credentials.rs`, the transport's `framed/exchange.rs`, `StaticKeyAuthMethodHandler::on_challenge` |
| mosh (GPL-3) | `mosh-server` prints `MOSH CONNECT <port> <key>` over ssh; the client reads `MOSH_KEY` and unsets it | a per-session key in memory only; a port squatter cannot answer without it | `mobile-shell/mosh` `src/frontend/mosh-server.cc`, `scripts/mosh.pl`, `src/frontend/mosh-client.cc` |
| Zed's remote server (GPL-3.0-or-later) | ssh stdio proxied to Unix sockets in a per-user state folder | nothing secret, only file ownership: a same-user process can stop the server (`server.pid`) and bind the sockets | `zed-industries/zed` remote server `server.rs` (`execute_proxy`, `ServerPaths::new`) |

Unconfirmed, read once each: how the closed Remote-SSH extension carries the token, and whether Mutagen's installed
agent can be swapped by a same-user process.

What carries over:
- No tool here keeps a long-lived daemon that outlives the ssh session behind a port and also authenticates the client
  by key. The ones that resist a port squatter either use ssh's stdio or deliver a per-launch secret over ssh's stdout.
- Centralu's host outlives the ssh session (it is detached, and soon behind a keeper), and the hub redials it without
  ssh after a swap. So the per-launch secret becomes a key installed over ssh (§4.2) plus a per-socket nonce (§4.3).

**Key storage from Node** (§6).
- Node has no keychain, DPAPI or Secret Service API. That was checked three ways: the 70 `doc/api` pages, which mention
  keychains only for `--use-system-ca`, and code searches of `nodejs/node` for `CryptProtectData` and `SecKeychain`,
  with no hits.
- On Windows, `fs.chmod` changes only the write bit (Node `fs` docs, "Caveats"), so the user profile's ACL is the
  protection there.
- DPAPI cannot unlock under an ssh key logon. Win32-OpenSSH issues #1935 and #1950 say so, and #1224 here measured it;
  there is no first-party Microsoft statement.
- macOS `security add-generic-password -w <password>` puts the secret on a command line that `ps` shows (security(1)).
- libsecret needs the session bus (`libsecret/secret-service.c`). Headless or over ssh there is often none, or the
  keyring is locked.

## 4. The design

### 4.1 Keys

- **The hub's link key.** One Ed25519 key pair per hub (per data folder), drawn once with
  `crypto.generateKeyPairSync('ed25519')`. Its public key, as 32 raw bytes in base64url (43 characters), is what
  machines store. One key for every machine, as an ssh user key is: the label (`hub:<name>-<key>`, `pairLabel`) stays
  per hub and machine, so revoke stays per machine. Where the private key lives: §6.
- **The machine's host key.** Ed25519, derived from the `key` `serve.json` already holds (32 random bytes, base64url):
  `seed = HMAC-SHA256(key, "centralu host key v1")`, wrapped as PKCS#8 (`302e020100300506032b657004220420 ‖ seed`) and
  read with `crypto.createPrivateKey({ format: 'der', type: 'pkcs8' })`; the public key from
  `crypto.createPublicKey`. The host gets the key on stdin today, so it derives the signing key with nothing new handed
  over; the launcher derives the public key to print it. It is the same across host swaps (the front door keeps the
  port, the next host the key) and changes with `--rotate-token`. A same-user reader of `serve.json` can derive it: that
  lets it stand in for the host toward the hub (the residual above), never receive anything that opens a host.

  Considered: a key in the host's memory only, drawn per start. It forces a memory read instead of a file read, but
  the hub redials the same forward after a swap without asking ssh again (`LINK_REDIALS`), so every swap would need a
  new connection line, and it closes nothing the derived key leaves open (§4.3).

### 4.2 Pairing, over the ssh the hub already runs

At each link the hub runs, as today, one ssh command; it changes from `--pair <label>` to

    centralu serve --connection --pair-key <label> <hub public key>

- The launcher writes `keys: [{ id, label, publicKey, created, via: 'pair-key' }]` into `serve.json` (still version 2,
  §7), one entry per label across `full` and `keys` together: a key pairing under a label removes that label's verifier
  entry, and a verifier pairing (an older hub of the same label, after a rollback) removes its key entry. An unchanged key
  under the same label keeps its entry and id (not `replaced`).
- It prints, in the connection line: `hostKey` (the machine's public key), `keyId` (the entry's 8-hex id), and `pairKey`
  in `takes`. It prints no `token` and no `credential` for a key pairing.
- Both public keys cross the ssh exec channel, which the person's ssh authenticates in both directions (their
  `known_hosts`, their user key). So the first pairing is **the hub installing its key over ssh**, as it already installs
  Centralu itself, not trust on first use of Centralu's port. The command line carries only public values.
- The hub takes `hostKey` from each connection line. It does not pin it across links in the first slices: the line
  comes over the person's ssh, and a same-user program that could change it can derive the real key anyway, so a pin
  adds nothing against the threat above. The hub records it on the machine (store, additive) for the row and the logs;
  whether a change is shown is open decision D3.

### 4.3 The handshake

Before hello, on every socket, reusing the `prove` frame additively:

1. **Hub → host:** `prove { nonce: Nh, key: <keyId> }`. `Nh` is 24 random bytes (`proofNonce`).
2. **Host → hub:** `proof { nonce: Nh, mac, hostNonce: Ns, hostKey: Pm, sig: Sign(Km, "centralu link host v1\0" ‖ T) }`.
   `Ns` is 24 fresh random bytes, kept on that socket only, used once. `mac` stays as today (the HMAC under the key),
   so the frame still parses everywhere; it proves nothing to a new hub.
3. **Hub:** checks that `Pm` is the `hostKey` of this link's connection line, that the address in `T` is the one it
   forwards to, and the signature. Anything else: the socket is dropped and nothing more is sent.
4. **Hub → host:** `hello { …, auth: { key: <keyId>, sig: Sign(Kh, "centralu link hub v1\0" ‖ T) } }`. The `token`
   field carries a fixed, non-secret marker (the field is required by the schema; slice 1 settles the marker).
5. **Host:** reads `serve.json` (as at every hello today), finds `keyId` in `keys`, rebuilds `T` from what it holds for
   this socket (its own `Ns`, `Pm` and address, the entry's public key) and verifies. Then `Ns` is gone. The socket is
   full, under that entry's id: the per-second sweep closes it (4001 "credential withdrawn") once the entry goes, as it
   does for a verifier entry today.

The transcript is length-prefixed fields, so no two field lists give the same bytes:

    T = "centralu link v1" ‖ Nh ‖ Ns ‖ Pm ‖ Ph ‖ "127.0.0.1:<port>"

`Ph` is the hub's public key as the host's entry names it; `<port>` is the port the hub's forward ends at on the
machine: the port the host itself listens on, or, once a keeper holds the machine's front door
([remote-keeper.md](remote-keeper.md)), the door's port, which the keeper hands each host it starts. Signing and
verifying are `crypto.sign(null, data, key)` and `crypto.verify(null, data, key, sig)`.

What each part buys:

- **Replay.** `Ns` is minted per socket and dropped at the hello, its timeout or the socket's close: a hub signature
  seen once is refused on every other socket. `Nh` is per dial: a host proof seen once is refused by the hub's next dial.
- **Reflection.** The two signatures carry different role labels: a host signature is never a hub's.
- **Relay.** A program that listens on the port the hub forwards to, and passes `Nh`, `Ns` and the signatures between
  the hub and a real host, needs that real host to accept a transcript naming `127.0.0.1:<port>` and its own key. A
  real host listens elsewhere then (the port is taken by the relay), so it refuses. Two listeners on one address and
  port need `SO_REUSEPORT` on both (Linux, macOS), which the host never sets; on Windows, whether a same-user socket can
  take a bound port with `SO_REUSEADDR` against libuv's default is **unconfirmed** and is measured in the acceptance run
  (§10). If it can, slice 5 adds a key-confirmed channel (§9).
- **No clock.** Nothing in the handshake reads the time, so clock skew between the two computers cannot break a link.

Considered and not taken: ssh-style signing of a whole key exchange with every later frame protected by the derived key
(Noise, TLS). It also stops a relay where two listeners share a port, and costs a cipher or a MAC over every frame (up to
100 MiB each), a framing change in the transport, and a handshake library or a
hand-written one. Against the user the threat is about, it adds nothing more: that user can replace the host. §3 has
the comparison.

### 4.4 Who checks what, unchanged

- The **window** on a machine (`serve --window`) and the launcher's one-call hand-over credential stay verifier
  credentials: they are local to that machine, and a same-user program there already has the host's code.
- The **limited credential**, a session's (`ccs1`, `CC_HOST_CREDENTIAL`, #1438) and a bridge's (`ccb1`) stay derived
  from the key, as today. Agents and scripts see no key and no signature.
- The **method rights** (`method-rights.ts`) do not change: a key hello is full, as a hub's verifier hello is.
- The **row's listing** keeps working, and gets simpler: a key entry under the hub's label is the hub's own exactly when
  its public key is the hub's, so `credentialCheck`'s HMAC is not needed for key entries. `host.credentials` adds
  `publicKey` to key entries (public), `UsedCredentials` keys them by id and public key.

## 5. Old builds on either side

Every step is additive; `serve.json` stays version 2, since a host that reads another version names no credential at
all and would cut every link while a swap serves the older host.

| Hub | Machine | What happens |
|---|---|---|
| new | new | key pairing (§4.2) and the key handshake. The hub's verifier entry under its label is removed by the key pairing, so the residual ends at the first new link |
| new | old launcher (no `pairKey` in `takes`) | verifier pairing as today (`--pair`), and the residual stays for that machine until it is updated; a hub with "Automatic updates" on brings it to its own version (#1508) |
| new | new launcher, old host still running (updated without restart) | the host ignores `prove.key` and answers with `mac` only: the hub sends nothing more and gives the reason it gives today ("runs an older Centralu host than the one installed there", restart). It does not fall back to a verifier |
| old | new | the old hub runs `--pair <label>`; the new launcher still takes it (verifier pairing), and removes that label's key entry. When to stop taking `--pair` for hub labels is open decision D4 |
| new, rolled back to old | new | as the row above; the key entry under its label is replaced by the verifier one. The key file stays; the next new run installs the key again |
| new | new, rolled back to old | the old launcher's next write drops the `keys` it does not know (it keeps only entries of its shape, as today), and its line has no `pairKey`: the hub pairs by verifier when it rolled the machine back itself (`machines.rollback`); otherwise open decision D2 |
| any | a swap on the machine, either direction | the older host reads `full` and ignores `keys`; the newer reads both. A key hello reaches only a host that signed its proof |

**The hub's store.** Additive only (`Store.migrate()`, add first, remove later): per machine, the last `hostKey` and
whether it has paired by key (for D2). The private key is not in `store.db` (§6), so copies of the store (a dev build's
copy, a backup) do not carry it.

## 6. Where the hub's private key lives

The hub runs on the person's computer in an interactive logon. Options, with what each costs:

| Where | Protects against | Cost |
|---|---|---|
| **A file in the hub's data folder** (`link-key.pem`, PKCS#8), created 0600 from the first byte as `serve.json` is (`writePrivate`) | other accounts (mode 0600 on macOS and Linux; on Windows the user profile's ACL, since Node's `chmod` sets only the read-only bit there); copies of `store.db` | none: `node:crypto` reads and writes it. A same-user reader gets it |
| **macOS Keychain**, from the keeper (Rust, Security framework), signing for its own host over the child channel | a same-user program that reads files: the keychain item's access list names the app, so another program's read asks the person | a keeper op and a host-to-keeper call per signature; the dev host (`pnpm dev`, no keeper) falls back to the file. The `security` CLI from Node would put the secret on a command line |
| **Windows**: DPAPI (`CryptProtectData`, current user) over the file, or Credential Manager, from the keeper | a copy of the file onto another computer or account; not a same-user process, which can call `CryptUnprotectData` too | as above; Node has no binding. Over an ssh key logon DPAPI cannot unlock (measured, #1224), which a hub never runs in |
| **Linux** Secret Service (`secret-tool`, D-Bus) | as macOS where a keyring runs | needs a session bus; absent headless, so the file again |

**Proposed:** the file first (slices 2 and 3). The key is cheap to replace: a hub that cannot read its key draws a new
one in memory for that run, logs it, and installs it at each machine's next link, which replaces the old entry under
its label; nothing needs the person. Moving it behind the keeper and the OS store is slice 6, open decision D1, since
against the user this is about (who can ssh to the machine with the person's key anyway) it guards only reads of files.

## 7. Rotation and revoke

- **The machine.** `serve --revoke <id>` takes a key entry by id, as it takes a verifier entry. `--rotate-token` draws a
  new key, so a new host key, and withdraws every full credential and every key entry; each hub installs its key again
  at its next link over ssh. The row's Revoke (`machines.revokeCredential`) works on key entries; the hub's own is
  refused there as today, since its next link installs it again.
- **The hub.** A new key pair replaces the file and is installed at each machine's next link (the entry under its label
  is replaced); sockets open under the old key are closed by the sweep once the entry is replaced. What starts a rotation
  (a command, the person, a schedule) is open decision D5; nothing in the first slices rotates by itself except a key the
  hub could not read.
- **Unlinking a machine.** The hub withdraws its own entry there (`serve --revoke`) when the machine is reachable; slice 3
  checks what unlinking does today and keeps it consistent.

## 8. Failure modes, and what the person sees

No new visible text without the owner's decision. Where a reason exists today, it is reused; where none fits, the
situation is listed as an open decision with the text it would need.

| Situation | What happens | What the person sees |
|---|---|---|
| The host's proof is missing, or signed by another key, or names another address | the hub drops the socket and sends nothing more | today's reason: "the machine's host did not prove it holds this computer's credential: it may be a host from before an update there, still running (restart Centralu there), or another program on the forward's port" |
| The host refuses the hub's signature (its entry gone, or `serve.json` unreadable) | the host refuses or closes with today's codes | today's: credential withdrawn (the link pairs again), or the machine's credential file cannot be read |
| The hub cannot read its key file | a key in memory for this run, installed at the next link | nothing; a line in the host's log |
| A machine that paired by key now offers only verifier pairing, and the hub did not roll it back | D2 | D2 needs a sentence if the link refuses |
| The machine's host key changed between two links | taken, recorded | nothing in the first slices; D3 |
| Two machines' clocks differ | nothing reads time | nothing |

## 9. Slices, as pull requests

Each is reviewed at the deep tier (security); each says in **Not exercised** what only the real run shows.

1. **This document.**
2. **Keys and the transcript, no behaviour change.** `transport/link-keys.ts`: the host key derived from the key, the
   transcript, sign and verify with role labels; the additive protocol fields (`prove.key`; `proof.hostNonce`,
   `hostKey`, `sig`; `hello.auth`), parsed but not yet used. Unit tests for every binding (§10).
3. **The machine side.** The launcher's `--pair-key`, `keys` in `serve.json`, one label across both arrays, `hostKey`,
   `keyId` and `pairKey` in the line; the host signs its proof when asked by key and takes a key hello; the sweep and
   `host.credentials` cover key entries. An old hub sees no change.
4. **The hub side.** The key file; `--pair-key` at each link when the line takes it; the key handshake in
   `RemoteClient`; the hub-label verifier entry removed by the key pairing; its own entry recognised by public key; the
   additive store fields; D2 as decided. `security-boundaries.md`: the residual rewritten as closed, with what stays.
5. **Only if the Windows measurement in §10 finds a shared port:** a key-confirmed channel (an X25519 exchange inside the
   signed transcript, then an HMAC per frame under the derived key) for the hub's link.
6. **Only if the owner chooses (D1):** the hub's key behind the keeper and the OS store.
7. **Later (D4):** stop taking verifier pairing under a hub's label, from a release floor.

## 10. Tests

Each fails without its fix.

- **Impersonation** (integration, agent-host): a real host on a port with a `serve.json` paired by key; a test
  "attacker" reads the whole file, stops the host, listens on the port with the derived host key and answers as the host.
  The hub links to it. Then a real host is started again; the attacker tries every value it holds or received (the
  key, every field of the file, the hub's signature, its own transcript) as a hello: none is taken as full. The same
  scenario on the verifier path shows today's leak (the attacker's hello with the received credential is full), which
  is what the slice-4 change must turn red into green.
- **Replay:** a valid key hello recorded and sent again on a new socket, and on the same socket after a second `prove`,
  is refused; a host proof recorded and answered to a later `prove` is refused by the hub.
- **Relay:** a relay passing `Nh`, `Ns` and both signatures between a hub forwarding to one port and a real host on
  another is refused by the host. A transcript with the host's key swapped, with the hub's key of another entry, or with
  a host signature presented as the hub's, is refused.
- **Nothing in the file opens the host:** for every string in a key-paired `serve.json` and every public key, a hello
  using it as `token` or `auth` is not full.
- **Old builds:** the previous release's `parseServeState` (a fixture of it) reads a file with `keys` and keeps `full`;
  a host without key support answering a key `prove` gets no hello; a line without `pairKey` gets `--pair`; a line with it
  gets `--pair-key`; one label across both arrays.
- **Acceptance, a real run over ssh between two machines:** a hub and a linked machine on new builds; `serve.json`
  there holds the hub's public key and no verifier under the hub's label; the attack above run by hand there as the same
  user ends with no full socket on the restarted host and the hub's row unchanged; the same with an old hub and a new
  machine and with a new hub and an old machine; `--revoke`, `--rotate-token` and the hub's key file removed, each
  followed by a link that pairs again by itself. Measured on a linked Windows PC as well: whether a second same-user
  listener can take `127.0.0.1:<port>` while the host holds it (decides slice 5), and the key file's ACL on a Windows hub.

## 11. Open decisions for the owner

- **D1. Where the hub's private key lives.** Proposed: a 0600 file in the hub's data folder now; the OS keychain behind
  the keeper later, or never. The keychain guards against reading files only, not against a same-user program that can
  ssh to the machine anyway.
- **D2. A machine that paired by key and then offers only verifier pairing**, when the hub did not roll it back itself
  (the person installed an older build there by hand, or a same-user program put an old launcher in place). Either pair
  by verifier silently (the residual is back for that machine), or refuse and say so on the machine's row, which needs a
  sentence, for example: "This machine now runs a Centralu that pairs the older way. Update it, or link it again." The
  wording is the owner's.
- **D3. A machine's host key that changed between links.** Proposed: recorded, not shown (ssh already authenticates
  the line, and a same-user program can derive the real key). Showing it would need a sentence on the row.
- **D4. When a machine stops taking verifier pairing for a hub's label.** It is what keeps an older hub linking; the
  proposal is a release floor chosen later, as for Node.
- **D5. What rotates the hub's key.** Proposed: nothing yet besides a key that cannot be read. A Rotate button would need
  its text and a place in Settings → Machines.
