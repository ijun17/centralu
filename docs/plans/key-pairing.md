# Pairing a hub and a linked machine with keys (#1711)

> **Status: slices 2 and 3 built (2026-10-30); revised after the adversarial review and its recheck on #1714.** Slice 2
> (the keys, the transcript and the protocol fields) and slice 3 (the machine side: `--pair-key`, the host's signed
> proof and key hello, the hand-over with limited rights) are built (§9); no hub pairs by key until slice 4. The
> first pull request carries this document with slice 2; each later one updates it with what it built and measured. It closes
> the residual in [security-boundaries.md](../security-boundaries.md), "The remote host", **Residual: the proof under a
> stored verifier** (#1405 review, held for the owner; owner decision 2026-10-29: do it after the #1405 stack).
>
> **Short version.**
> 1. The hub has one Ed25519 key pair (`node:crypto`); the private key stays on the hub's computer. A linked machine's
>    `serve.json` holds the hub's **public** key in place of a verifier. Nothing a reader of that file finds opens the
>    machine's host whole, and nothing that crosses the link can be used again.
> 2. The machine's host has an Ed25519 key too, derived from the `key` the host was started with, so it needs no new
>    secret and survives a host swap. The connection line reports the key the **running** host signs with (§4.2).
> 3. Before hello, the two sign one transcript, encoded byte for byte (§4.3): both nonces, both public keys, the hub's
>    entry id and the loopback address the hub forwards to, each signature under its own role label. The host's nonce
>    is fresh per socket and used once.
> 4. Pairing rides the ssh command the hub already runs at each link (`serve --connection`), which the person's own
>    ssh authenticates: `--pair-key <label> <public key>` in place of `--pair <label>`. No trust on first use of
>    Centralu's own port, and no prompt.
> 5. Whether the hub may pair by verifier with a machine depends **only on the hub's own record**: once it has paired
>    by key with that machine, it refuses a verifier pairing there, whatever the remote prints (§5.1). Before that, old
>    builds on either side keep pairing by verifier, as today.
> 6. The launcher's hand-over call (`host.handover`) moves to limited rights, so no full credential crosses a port on
>    the machine for it any more (§4.4). Agents keep `CC_HOST_CREDENTIAL` (#1438) and never see a key.

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

The same shape exists once more on the machine itself. On Windows, the launcher's move into the person's sign-in
(`serve-handover.mjs` `moveIntoSignIn` → `sayHandover`) makes a full credential (`via: 'handover'`) for one
`host.handover` call and sends it after a proof under `serve.json`'s `key`. A squatter answers that proof from the file
and receives a bearer full credential. `UsedCredentials.saw` never lists it, and it is withdrawn only after the call
ends (up to the call's 5 s timeout and the 1 s sweep). §4.4 removes it.

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
| **Impersonating the port during a hand-over** (Windows, `moveIntoSignIn`) | receives a full `via: 'handover'` credential, unlisted | receives the limited credential, which the file already holds (§4.4) |
| **Downgrade** (point `<data>/remote/current` at an older installed release: the launcher then refuses `--pair-key`, or the running host is old) | nothing to downgrade from | closed **from the machine's first key link**: from then on the hub refuses a verifier pairing with that machine, whatever the remote prints (§5.1), and sends no credential. Before it (a machine never linked by key, or a hub with no record of it: a new hub, a restored store, a machine removed and linked again) the first link is today's residual, no worse |
| **Replay** of anything seen on the link | the credential is a bearer: reusable until the next pairing | each signature covers a host nonce minted for one socket and dropped at its hello or its 10 s hello timeout |
| **Relay** (sit between the hub and a real host, passing each frame on) | not needed: the bearer is enough | the transcript names the address the hub forwards to and the host's own key; a real host elsewhere refuses it, and no second listener can share the held port (§4.3, measured) |
| **A forged public key** (a small-order or malformed Ed25519 key in `keys`, by `--pair-key` or by hand) | no keys | refused by the launcher and ignored by the host (§4.1); unchecked, on Node 22 a small-order key verifies a forged signature over every message (Node 24 refuses it itself, §4.1) |
| **Another account on the hub's computer** taking the forward's local port first (#838) | gets a nonce, never the credential | the same: it cannot sign as the machine (it cannot read the 0600 file there), so the hub never sends its signature |
| **Another account on the machine** | stopped by the 0600 file | the same |

**What this does not defend.**
- A process of the user on the hub's own computer can do whatever the hub can (ssh to the machine with the person's
  key, read the hub's key file); the keychain option in §6 narrows only the reading of files.
- A same-user program on the machine that **starts the installed host with environment of its choosing**
  (`CC_FRONT_DOOR` naming a port of its own, or `CC_SERVE_STATE` pointing at a file of its own with a key on stdin), or
  patches the host's code, can relay or act as it likes. That already gives it full power with no relay at all: it is
  at the level of editing `store.db`, not one request away.
- A same-user program that makes the machine run an **older release** (the managed launcher runs whatever version
  `<data>/remote/current` names, and older ones stay in `versions/`) brings back that release's own residuals on the
  machine's host. What this design guarantees is that the hub takes no part in it (§5.1), and that a new host takes no
  `via: 'handover'` entry as full (§4.4).
- `serve --window` (#1417): the full credential the window on a Windows machine gets at each start stays a verifier
  credential, and any same-user process can run `--window` until #1417 checks the parent. Not closed here.

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
- **The machine's host key.** Ed25519, derived from the `key` the host was started with (32 random bytes,
  base64url, which the host gets on stdin today): `seed = HMAC-SHA256(key, "centralu host key v1")`, wrapped as PKCS#8
  (`302e020100300506032b657004220420 ‖ seed`) and read with `crypto.createPrivateKey({ format: 'der', type: 'pkcs8' })`;
  the public key from `crypto.createPublicKey`. So the host derives its signing key with nothing new handed over. It is
  the same across host swaps (the front door keeps the port, the next host the key). After `--rotate-token` it changes
  at the host's next start, not before: a running host keeps the key it was started with, and under a keeper every host
  the keeper starts gets the keeper's copy (§7). That is why the connection line reports the key the running host signs
  with, not one derived from the file (§4.2). A same-user reader of `serve.json` can derive it: that lets it stand in
  for the host toward the hub (the residual above), never receive anything that opens a host.

  Considered: a key in the host's memory only, drawn per start. It forces a memory read instead of a file read, but
  the hub redials the same forward after a swap without asking ssh again (`LINK_REDIALS`), so every swap would need a
  new connection line, and it closes nothing the derived key leaves open (§4.3).
- **Which public keys are taken.** `node:crypto` on Node 22 verifies against a small-order public key without
  complaint: measured on Node 22.23.4 (OpenSSL 3.5), the identity point (`01` then 31 zero bytes) as the public key with
  the signature R = identity, S = 0 (`01` then 63 zero bytes) passes `crypto.verify(null, m, key, sig)` for every
  message `m` tried. **Node 24.22.1 (the remote runtime, `packaging/remote-runtime.json`) refuses these itself**: over
  256 messages per key, every small-order key and y = p and p + 1 verify 0 times, on Windows and on Linux. The repository
  allows Node 22.14 and up, and dev and CI run 22, so the hazard is real where it runs and the check below stays; the
  tests assert the plain hazard only on a Node that has it (§9), and the module's own refusal on every Node.
  So every public key, wherever it is read (the launcher's `--pair-key`, the host reading `keys`, the hub reading
  `hostKey` from a line), goes through one check, `parseLinkPublicKey` (slice 2), and is refused unless all of these
  hold:
  1. it is exactly 43 characters of `[A-Za-z0-9_-]`, and decoding it to bytes and encoding them again gives the same
     string (Node's `base64url` decoding skips other characters and ignores the last character's two spare bits, so
     without this several strings name one key);
  2. the 32 bytes, read as a little-endian number with the top bit (the sign of x) cleared, give a y below
     p = 2^255 − 19 (a canonical encoding; this also refuses the encodings of p and p + 1);
  3. that y is none of the y-coordinates of the eight small-order points: 0, 1, p − 1, and the two y of the points of
     order 8 (the encodings `26e8958f…6d53fc05` and `c7176a70…92ac037a`, as libsodium's `ge25519_has_small_order`
     lists them), with either sign bit;
  4. `crypto.createPublicKey` takes it as SPKI DER (`302a300506032b6570032100 ‖ key`).

  This is a check of the decoded point, not a test signature: a forged signature verifies under a small-order key of
  order 8 for only some messages, so one test signature would catch the identity point but not every small-order key.
  The launcher exits with an error for a refused key and writes nothing; the host treats a `keys` entry with a refused
  key as absent (it makes no socket full and is not listed as the hub's); the hub drops a line whose `hostKey` is
  refused.

### 4.2 Pairing, over the ssh the hub already runs

At each link the hub runs, as today, one ssh command; it changes from `--pair <label>` to

    centralu serve --connection --pair-key <label> <hub public key> [--key-paired]

`--key-paired` is added when the hub's own record says it has paired by key with this machine before (§5.1). The
launcher then:

1. **Checks the public key** (§4.1). A refused key: an error, nothing written.
2. **Writes the key entry** into `serve.json`: `keys: [{ id, label, publicKey, created, via: 'pair-key' }]` (still
   version 2, §5). At most one key entry and one verifier entry per label. The same public key under the same label
   keeps its entry and id (not `replaced`). Another public key under that label is a new entry with a **new id**,
   `replaced: true`, and the old key entry goes. This step never touches the label's verifier entry.
3. **Asks the running host to sign**, as the hub would (§4.3): a `prove` naming the new entry, with a nonce of its own,
   and checks the answer's signature against the `Pm` it carries and the address it forwards to.
   - **The running host signs** (it takes key hellos): the line carries `hostKey` (that `Pm`: the key the running host
     signs with, which after `--rotate-token` is still the old one until a restart), `keyId` (the entry's 8-hex id) and
     `pairKey` in `takes`. No `token` and no `credential`. With `--key-paired`, the label's verifier entry is removed
     now.
   - **A host answers without a signature** (an older host still running, the machine updated but not restarted): a
     verifier pairing under the label, as `--pair <label>` does today. The line carries `token` and `credential` and no
     `pairKey`. The key entry stays: it is public and is used once a new host runs.
   - **No host answers** (the connection to the host's port is refused: nothing listens there) **and no keeper runs
     there:** `hostKey` is derived from the file's key (the host started next gets that key on stdin), and `pairKey` is
     in `takes` when the installed host takes key hellos (`bundle-info.json`, as `takesVerifiers` reads `verifiers`);
     otherwise as the previous case. With `--key-paired` and `pairKey`, the label's verifier entry is removed now.
   - **Unknown:** the probe times out (`probeHost`'s 2 s), the socket closes before a proof, the proof is malformed, or
     nothing listens but a keeper runs there (the keeper hands every host it starts its own copy of the key, which after
     `--rotate-token` is not the file's, §7, so a key derived from the file could be wrong). Treated as a host that
     answers without a signature: a verifier pairing, no `pairKey`, no `hostKey`, and the label's verifier entry is not
     removed, even with `--key-paired`. A hub with a record refuses that line for this attempt (§5.1) and asks again at
     its usual backoff, by when the host has answered or started. So a slow old host never gets `pairKey`, and no line
     reports a key derived from a file the running host does not sign with.

So the hub's verifier entry under its label is removed only once the hub has paired by key with a running new host:
the hub records that at its first accepted key hello and then runs the same command once more with `--key-paired`
(one more ssh command, once per machine), which removes it without waiting for the next link. A machine updated but
not restarted keeps linking by verifier until its host restarts.

**How the hub learns which pairing it got.** It does not choose beforehand. It always asks with `--pair-key`, and the
answer says what the launcher made: a line with `pairKey` and `hostKey` (key), a line with `credential` and no
`pairKey` (verifier), or "unknown option for serve: --pair-key" on stderr (a launcher from before). Whether the hub
accepts a verifier answer depends only on its own record (§5.1), never on what the remote printed.

- Both public keys cross the ssh exec channel, which the person's ssh authenticates in both directions (their
  `known_hosts`, their user key). So the first pairing is **the hub installing its key over ssh**, as it already installs
  Centralu itself, not trust on first use of Centralu's port. The command line carries only public values.
- The hub takes `hostKey` from each connection line. It does not pin it across links: the line comes over the person's
  ssh, and a same-user program that could change it can derive the real key anyway, so a pin adds nothing against the
  threat above. The hub records it on the machine (store, additive) for the row and the logs; a change is recorded and
  not shown (D3, decided).

### 4.3 The handshake

Before hello, on every socket, reusing the `prove` frame additively:

1. **Hub → host:** `prove { nonce: Nh, key: <keyId> }`. `Nh` is 24 random bytes (`proofNonce`).
2. **Host → hub:** `proof { nonce: Nh, mac, hostNonce: Ns, hostKey: Pm, sig: Sign(Km, field("centralu link host v1") ‖ T) }`.
   `Ns` is 24 fresh random bytes, kept on that socket only, used once. The host stores `Nh` and `keyId` from this
   `prove` on the socket (it already takes one `prove` per socket). `mac` stays as today (the HMAC under the key), so the
   frame still parses everywhere; it proves nothing to a new hub. A `key` that names no entry (or one with a refused
   public key): the host closes with today's 4001 "credential withdrawn", and the hub pairs anew as it does for that.
3. **Hub:** checks that `Pm` is the `hostKey` of this link's connection line and verifies the signature over the `T` it
   builds itself. Anything else: the socket is dropped and nothing more is sent. One case reads the line again first:
   a signature that verifies under a `Pm` other than the line's (a host restarted with its new key after
   `--rotate-token`, which a redial without ssh meets). The hub then runs its connection line once more and drops the
   socket with the reason only if the new line's `hostKey` still differs. "Once more" is once per dial cycle (the run
   of up to `LINK_REDIALS` redials between two ssh runs of the line), not once per socket: a squatter answering every
   redial with another key costs the hub one extra ssh run per cycle, not one per socket.
4. **Hub → host:** `hello { …, auth: { key: <keyId>, sig: Sign(Kh, field("centralu link hub v1") ‖ T) } }`. The `token`
   field carries a fixed, non-secret marker (the field is required by the schema), settled in slice 2 as
   `LINK_AUTH_MARKER`, the string `centralu link auth v1`. It has spaces, so it is never a key or credential the
   launcher draws (43 base64url characters) and never a derived one (`ccl1:`, `ccs1:`, `ccb1:`); a test pins that
   `sameSecret` against a drawn key and the limited, session and bridge paths refuse it. A host refuses a hello carrying
   the marker without a valid `auth`; an older host reads only `token` and answers "bad token".
5. **Host:** refuses an `auth.key` other than the `keyId` its `prove` carried; reads `serve.json` (as at every hello
   today), finds that entry in `keys`, rebuilds `T` from what it holds for this socket and verifies. Then `Ns` is gone.
   The socket is full, under that entry's `(id, publicKey)`: the per-second sweep closes it (4001 "credential
   withdrawn") once no entry with that id **and** that public key is listed (§4.4).

**The bytes.** Every field is length-prefixed with its length in bytes as a 4-byte unsigned big-endian integer:

    field(b) = u32be(len(b)) ‖ b
    T        = field("centralu link v1") ‖ field(Nh) ‖ field(Ns) ‖ field(Pm) ‖ field(Ph) ‖ field(keyId) ‖ field(addr)
    hub's    = Sign(Kh, field("centralu link hub v1")  ‖ T)
    host's   = Sign(Km, field("centralu link host v1") ‖ T)

| Field | In `T` | On the wire |
|---|---|---|
| the context and role labels | their ASCII bytes | not sent |
| `Nh`, `Ns` | the 24 raw bytes | base64url, no padding, exactly 32 characters |
| `Pm`, `Ph` | the 32 raw bytes | base64url, exactly 43 characters, checked as §4.1 says |
| `keyId` | the 8 ASCII bytes of the entry's id (lowercase hex, as `CREDENTIAL_ID_RE`) | as is |
| `addr` | the ASCII bytes of `127.0.0.1:<port>`, the port in decimal with no leading zero, 1 to 65535 | not sent; each side builds it |
| signatures | | base64url, exactly 86 characters (64 bytes) |

Decoding is strict on both sides: the exact length above, only `[A-Za-z0-9_-]`, and encoding the bytes again must give
the same string. A frame with a field that fails is refused (the host closes as for a malformed `prove`; the hub drops
the socket). Slice 2 pins a test vector: fixed inputs, the exact bytes of `T` in hex, and both signatures.

**Where each side takes each value.**

| Value | Hub | Host |
|---|---|---|
| `Nh` | the one it drew for this dial | the one this socket's `prove` carried, stored at `prove` time; never from the hello |
| `Ns` | the proof's | its own, for this socket |
| `Pm` | the proof's, which must equal the line's `hostKey` | its own |
| `Ph` | its own public key | the entry's, read at hello |
| `keyId` | the line's | the `prove`'s; the hello's `auth.key` must be the same |
| `addr` | `127.0.0.1:` and the `port` of this link's connection line, the remote end of its ssh forward; never a socket's | **without a keeper:** the accepted socket's `localAddress:localPort` (an IPv4-mapped `::ffff:127.0.0.1` is read as `127.0.0.1`; any other local address gives no key path, so the socket cannot be full). **Under a keeper** (`CC_FRONT_DOOR` set): the door's address from `CC_FRONT_DOOR`, which must be `ws://127.0.0.1:<port>` (anything else gives no key path), since the host's socket then comes from the door's relay and its `localPort` is the inner one ([remote-keeper.md](remote-keeper.md)) |

Signing and verifying are `crypto.sign(null, data, key)` and `crypto.verify(null, data, key, sig)`.

**What is not signed.** The hello's other fields (`afterSeq`, `shows`, `client`, `label`, the `token` marker) and every
frame after it. That is acceptable only because a relay is excluded (below): whoever could change them would have to sit
between the hub's forward and the host. The path is ssh up to the machine's loopback, and the loopback hop is what the
address binding covers.

What each part buys:

- **Replay.** `Ns` is minted per socket and dropped at the hello, its timeout or the socket's close: a hub signature
  seen once is refused on every other socket. `Nh` is per dial: a host proof seen once is refused by the hub's next dial.
- **Reflection.** The two signatures carry different role labels: a host signature is never a hub's.
- **One hub key on many machines.** `T` carries `Pm` and `Ns`: a hub signature for one machine is refused by another.
- **Relay.** A program that listens on the port the hub forwards to, and passes `Nh`, `Ns` and the signatures between
  the hub and a real host, needs that real host to accept a transcript naming `127.0.0.1:<port>` and its own key. A
  real host then listens elsewhere (the relay holds the port), so it refuses. Two listeners cannot share a held
  `127.0.0.1:<port>`, measured on Windows 11 and WSL2 (Node 22.23.4; the holder a plain `net.createServer().listen` on
  `127.0.0.1:P`, the second a same-user process):

  | Second listener | Windows 11 | WSL2 Linux 5.15 |
  |---|---|---|
  | Node `127.0.0.1` plain / `exclusive: true` / `exclusive: false` | EADDRINUSE | EADDRINUSE |
  | Node `127.0.0.1` `reusePort: true` | ENOTSUP | EADDRINUSE |
  | Python `SO_REUSEADDR` on `127.0.0.1` | WSAEACCES (10013) | EADDRINUSE (also with `SO_REUSEPORT`, and with both) |
  | Python `SO_REUSEADDR` bound **first**, then the Node host | the host gets EADDRINUSE | the host gets EADDRINUSE |
  | Node `0.0.0.0` / `::` | binds, but all 20 of 20 connects to `127.0.0.1` go to the specific listener, in either order | EADDRINUSE (wildcard first: the host cannot bind) |
  | Node `::1` | binds (another address; the forward targets the literal `127.0.0.1`, so harmless) | binds (the same) |
  | A WSL listener on the same port | Windows host first: it keeps 10 of 10 connects. WSL first: wslrelay holds the port and the host gets EADDRINUSE (squatting, not sharing) | n/a |

  So a squatter can only take the port while the host is down, which the design already assumes. macOS was not
  measured: BSD lets a wildcard bind sit beside `127.0.0.1` with `SO_REUSEADDR`, but the specific bind still wins.
  Slice 3's acceptance run measures it on a Mac; a second listener that takes connections there is filed as its own
  issue.
- **No clock.** Nothing in the handshake reads the time, so clock skew between the two computers cannot break a link.

Considered and not taken: ssh-style signing of a whole key exchange with every later frame protected by the derived key
(Noise, TLS). It would also stop a relay where two listeners share a port, which the measurement above rules out, and
costs a cipher or a MAC over every frame (up to 100 MiB each), a framing change in the transport, and a handshake
library or a hand-written one. Against the user the threat is about, it adds nothing more: that user can replace the
host. §3 has the comparison.

### 4.4 Who checks what

- **The hand-over call becomes limited.** `host.handover` moves from `link` to `everyday` in `method-rights.ts`. Its
  parameters are a state (`waiting` or `gave_up`) and a time (`HostHandover`), no text. A limited caller gains more
  than running the launcher gives: any agent (it holds `CC_HOST_CREDENTIAL`, a session's credential) can post or clear
  the hand-over note, which the host broadcasts as `host_handover` to every client, without moving or stopping
  anything. That is accepted because it is cosmetic and bounded: a note of a fixed shape on the machine's row, with no
  text of the caller's, that opens and stops nothing. `host.stop` set the precedent: a limited caller may already call
  it, and it does far more (it ends the host). `sayHandover` then
  says it with the credentials the launcher already holds for its own host (`ownCredentials`: the limited credential,
  proved under the key) and makes no credential: no `pairServe(…, 'handover')`, no revoke after. A squatter answering
  that proof receives the limited credential, which the file already holds. By build:
  - a host from slice 3 on takes it under limited rights;
  - a host from #1405 to slice 3 refuses it (`link`); the new launcher ignores the refusal, the row shows no hand-over
    note during that wait, and the move happens as before;
  - a host from before verifiers gets the one token it knows (`legacyHostToken`), as today: that token is in the file;
  - an older launcher with a new host still makes a `via: 'handover'` entry; a new host takes such an entry as
    **limited**, never full, which is enough for the call now. `UsedCredentials.saw` keeps skipping them while a reader
    can still meet one, and **only** them: a verifier entry. A key entry carries no `via` for the host (`readKeyEntries`
    keeps none), so nothing a file says of a key entry can hide a full hello from `UsedCredentials` (the #1717 review, M1:
    `via: "handover"` on a hand-written key entry gave full rights that no listing ever showed). The launcher still
    writes `via: 'pair-key'`, which only a reader of the file sees.
- The **window** on a machine (`serve --window`) stays a verifier credential; its residual is #1417's (§2).
- The **limited credential**, a session's (`ccs1`, `CC_HOST_CREDENTIAL`, #1438) and a bridge's (`ccb1`) stay derived
  from the key, as today. Agents and scripts see no key and no signature.
- The **method rights** otherwise do not change: a key hello is full, as a hub's verifier hello is.
- **The row's listing.** A key entry under the hub's label is the hub's own exactly when its public key is the hub's,
  so `credentialCheck`'s HMAC is not needed for key entries. `host.credentials` adds `publicKey` to key entries
  (public), and `UsedCredentials` keys them by id and public key. Once the hub's record says it has paired by key with
  the machine, a **verifier** entry under its own label is never its own (it holds no credential to `check` it, and it
  removed its own with `--key-paired`): the hub shows it among the other credentials, with Revoke, as it shows any other
  credential today. So someone else's `serve --pair hub:<label>` between two links is judged like any other. It gets no
  sentence of its own (D6, decided).
- **The sweep compares `(id, publicKey)`** for key sockets (`sweepWithdrawn`, `fullBy`): a socket stays full only while
  an entry with its id and its public key is listed. With a new id for a changed key under a label (§4.2), an entry that
  reuses an id under another key does not keep a socket full.

## 5. Old builds on either side

Every step is additive; `serve.json` stays version 2, since a host that reads another version names no credential at
all and would cut every link while a swap serves the older host.

| Hub | Machine | What happens |
|---|---|---|
| new | new | key pairing (§4.2) and the key handshake; at the first accepted key hello the hub records it and runs the line once more with `--key-paired`, which removes its verifier entry there. The residual ends then |
| new | old launcher ("unknown option for serve: --pair-key") | no record: `--pair <label>` as today (and the fallback before #1405 after it), and the residual stays for that machine until it is updated; a hub with "Automatic updates" on brings it to its own version (#1508). With a record: refused (§5.1) |
| new | new launcher, old host still running (updated without restart) | the launcher's probe finds a host that does not sign and pairs by verifier (§4.2): no record, the link works as today and its next link after a restart pairs by key. With a record: refused (§5.1) |
| old | new | the old hub runs `--pair <label>`; the new launcher takes it (a verifier pairing) and leaves the label's key entry alone. Verifier pairing for hub labels stops only after every machine the hub links has paired by key once and two releases have shipped with key pairing, from a floor chosen then in its own issue (D4, decided) |
| new, rolled back to old | new | as the row above. When it is new again, its record is still there (the store keeps additive fields), so its next link carries `--key-paired` and removes the verifier entry the old build made |
| new | new, rolled back to old | the old launcher's next write drops the `keys` it does not know (it keeps only entries of its shape, as today), and it refuses `--pair-key`. When the hub rolled the machine back itself (`machines.rollback`) to a version without key pairing, it clears its own record first and pairs by verifier. Otherwise refused (§5.1) |
| any | a swap on the machine, either direction | the older host reads `full` and ignores `keys`; the newer reads both. A key hello reaches only a host that signed its proof. A redial that reaches an older host for a moment gets a proof without a signature: the hub drops the socket and redials by its usual backoff. A link (ssh) in that moment makes the launcher pair by verifier, which a hub with a record refuses for that attempt only; its next attempt asks again |

### 5.1 The hub's own record decides, never the remote's output

Pointing `<data>/remote/current` at an older installed release is a one-line write by a same-user program, and the code
it selects is a genuine release. So the remote's answer can never be what turns a key pairing back into a verifier one.

- **The record.** Per machine in the hub's store (additive, `Store.migrate()`, add first and remove later): when the
  hub first had a key hello accepted there, and the last `hostKey`. It is set only by that accepted key hello. It is
  cleared only by the hub's own acts: its `machines.rollback` of that machine to a version without key pairing, and
  removing the machine. Nothing a remote prints sets or clears it.
- **With a record**, the hub never runs `--pair` there and never uses a `token` or `credential` from a line. An
  "unknown option for serve: --pair-key", or a line without `pairKey`, fails this link attempt; when the line made a
  verifier credential the hub withdraws it there at once (`serve --revoke <id>`, which every launcher since #1405
  takes). The machine's row says why, in D2's sentence (§11, decided). The next attempt, at the usual backoff, asks
  again.
- **Without a record**, as today: the fallback to `--pair <label>` on "unknown option for serve: --pair-key", then to
  no pairing on "unknown option for serve: --pair". The window before the first key link is today's residual, no worse.
- Considered: "a version the hub itself installed there takes keys" as the trigger, which would also close the window
  before the first key link. Not taken: a machine the hub updated may still run an older host until it restarts (§4.2)
  and would be refused where it links today, and an accepted key hello is the only thing that shows a key-capable host
  really ran there. A narrower trigger escapes that objection: a machine the hub installed **fresh in this same link**
  runs no older host. Slice 4 takes it if the install step can tell a fresh install from an update, and its pull request
  says which it did; until then the first-link window stays today's residual (§2).

**The hub's store.** Besides the record, nothing: the private key is not in `store.db` (§6), so copies of the store (a
dev build's copy, a backup) do not carry it.

## 6. Where the hub's private key lives

The hub runs on the person's computer in an interactive logon. Options, with what each costs:

| Where | Protects against | Cost |
|---|---|---|
| **A file in the hub's data folder** (`link-key.pem`, PKCS#8), created 0600 from the first byte as `serve.json` is (`writePrivate`) | other accounts (mode 0600 on macOS and Linux; on Windows the user profile's ACL, since Node's `chmod` sets only the read-only bit there); copies of `store.db` | none: `node:crypto` reads and writes it. A same-user reader gets it |
| **macOS Keychain**, from the keeper (Rust, Security framework), signing for its own host over the child channel | a same-user program that reads files: the keychain item's access list names the app, so another program's read asks the person | a keeper op and a host-to-keeper call per signature; the dev host (`pnpm dev`, no keeper) falls back to the file. The `security` CLI from Node would put the secret on a command line |
| **Windows**: DPAPI (`CryptProtectData`, current user) over the file, or Credential Manager, from the keeper | a copy of the file onto another computer or account; not a same-user process, which can call `CryptUnprotectData` too | as above; Node has no binding. Over an ssh key logon DPAPI cannot unlock (measured, #1224), which a hub never runs in |
| **Linux** Secret Service (`secret-tool`, D-Bus) | as macOS where a keyring runs | needs a session bus; absent headless, so the file again |

**Decided (D1):** the file now (slices 2 to 4). The key is cheap to replace: a hub that cannot read its key draws a
new one in memory for that run, logs it, and installs it at each machine's next link, which replaces the old entry
under its label with a new id; nothing needs the person. The OS store behind the keeper stays slice 6, optional, since
against the user this is about (who can ssh to the machine with the person's key anyway) it guards only reads of files.

## 7. Rotation and revoke

- **The machine.** `serve --revoke <id>` takes a key entry by id, as it takes a verifier entry. `--rotate-token` draws a
  new key and withdraws every full credential and every key entry. The running host keeps the key it was started with
  until it restarts (as `--rotate-token` already says of the limited credential), and under a keeper every host the
  keeper starts gets the keeper's copy until the keeper starts again. So, with a host running:
  1. the sweep closes the hub's socket (4001 "credential withdrawn": its entry is gone);
  2. the hub runs its connection line again; `--pair-key` writes a new key entry, and the launcher's probe of the
     running host reports the `Pm` it signs with, the old one (§4.2);
  3. the hub's key handshake against the running host succeeds, at once.

  The host's key changes at its next start: the hub's next redial meets a `Pm` other than its line's, reads the line
  again (§4.3, step 3), and the line reports the new one. No restart is needed for the link,
  and no step compares against a key derived from the file while another runs. The row's Revoke
  (`machines.revokeCredential`) works on key entries; the hub's own is refused there as today, since its next link
  installs it again.
- **The hub.** A new key pair replaces the file and is installed at each machine's next link (the entry under its label
  is replaced, with a new id); sockets open under the old key are closed by the sweep, which compares `(id, publicKey)`.
  What starts a rotation is D5 (decided): no button and no new text; the key rotates on its own, on revoke and when the
  key file cannot be read. Slice 4 settles which revoke starts it and writes it here.
- **Unlinking a machine.** The hub withdraws its own entry there (`serve --revoke`) when the machine is reachable, and
  drops its record with the machine; slice 4 checks what unlinking does today and keeps it consistent.

## 8. Failure modes, and what the person sees

No new visible text without the owner's decision. Where a reason exists today, it is reused; where none fits, the
situation is listed as an open decision with the text it would need.

| Situation | What happens | What the person sees |
|---|---|---|
| The host's proof is missing, malformed, or signed by another key, or the hub's `T` does not verify | the hub drops the socket and sends nothing more | today's reason: "the machine's host did not prove it holds this computer's credential: it may be a host from before an update there, still running (restart Centralu there), or another program on the forward's port" |
| The host refuses the hub's signature (its entry gone, a refused public key, `serve.json` unreadable) | the host refuses or closes with today's codes | today's: credential withdrawn (the link pairs again), or the machine's credential file cannot be read |
| `--rotate-token` there with a host running | the link pairs again at once against the running host (§7) | nothing new |
| A machine updated but not restarted | verifier pairing, as today, until a restart; no record yet | nothing new |
| The hub cannot read its key file | a key in memory for this run, installed at the next link | nothing; a line in the host's log |
| A machine the hub paired by key with now offers only verifier pairing, and the hub did not roll it back | refused; a verifier credential the line made is withdrawn there | D2's sentence on the machine's row (§11) |
| A verifier entry under the hub's label after it paired by key | listed among the other credentials | today's listing of other credentials, with Revoke; no sentence of its own (D6) |
| `host.handover` refused by a host from before slice 3 | the launcher goes on moving the host | no hand-over note on the row during that wait |
| The machine's host key changed between two links | taken, recorded | nothing (D3, decided) |
| Two machines' clocks differ | nothing reads time | nothing |

## 9. Slices, as pull requests

Each is reviewed at the deep tier (security); each says in **Not exercised** what only the real run shows.

1. **This document.**
2. **Keys and the transcript, no behaviour change.** `transport/link-keys.ts`: `parseLinkPublicKey` (§4.1), strict
   base64url decoding, the host key derived from the key, the transcript's bytes (§4.3) with its test vector, sign and
   verify with role labels; the additive protocol fields (`prove.key`; `proof.hostNonce`, `hostKey`, `sig`;
   `hello.auth`), parsed but not yet used. Unit tests for every binding (§10).

   **Built.** `link-keys.ts` and its tests in `packages/agent-host/src/transport`; the fields in `@cc/protocol`
   (`client-frames.ts`, `envelope.ts`). What it settled:
   - The schema checks only each field's shape (8 hex characters, or base64url of the exact length) and reads a
     malformed one as absent (`.catch(undefined)`), as `prove.credential` does, so no frame is refused for them. The
     strict decoding, the key checks and the signatures are `link-keys.ts`'s, which slice 3 calls.
   - Strict decoding is one rule: the bytes are the given length and encode back to the same string. The exact length
     and the alphabet follow from it, so a separate test for either refuses nothing more (measured by removing each).
   - A public key is used only as a `LinkPublicKey`, which only `parseLinkPublicKey` makes, so nothing verifies against
     an unchecked key: by type, and at run time too, since `verifyLink` refuses any object that does not pass
     `LinkPublicKey.is` (a private field's presence, which a cast or a copy does not carry). Rule 4 of §4.1 (`createPublicKey` takes it) refused none of 2,000 random 32-byte values that pass
     rules 1 to 3: off-curve bytes import and verify nothing. It stays as a guard; no test isolates it.
   - The small-order y values are derived in the test from the curve equation, not copied, and match the two encodings
     libsodium lists. Under raw `node:crypto` on Node 22.23.4, the forged signature R = identity, S = 0 verified for some
     of 256 messages under each of the ten small-order encodings and under y = p and y = p + 1; the tests pin that on a
     Node that has it. **Node 24.22.1 verifies 0 of 256 under each of them** (it refuses a small-order key itself), so those
     assertions are skipped there with the reason in the test's name, probed once at test time; every refusal by
     `parseLinkPublicKey`, all ten encodings and all 38 of y from p to 2^255 − 1 (19 values, two sign bits), is asserted
     on both. The check stays because the repository allows Node 22.14 and up. The slice's tests run on Node 22 and on
     Node 24.22.1.
   - The token marker is `LINK_AUTH_MARKER`, `centralu link auth v1` (§4.3 step 4).
   - The pinned vector was produced by `tooling/key-pairing-vector.mjs`, written apart from `link-keys.ts`: its own RFC 8032
     Ed25519 on BigInt, using `node:crypto` only for SHA-256, SHA-512 and HMAC. `tooling/key-pairing-vector.test.ts` runs it
     against the module on every test run. Another implementation (pure Python, own Ed25519) matched it byte for byte in
     the review.
   - The wire lengths (24, 32 and 64 bytes) are defined once, in `@cc/protocol` (`link-wire.ts`), which the frame schemas
     and `link-keys.ts` both use; the address form is written once, in `linkAddress`, and read by building it again
     (`readLinkAddress`), so the transcript and the door URL accept the one form. `encodeFields` takes a string as ASCII
     and throws on any other character. `hostLinkKey` refuses an empty key; slice 3 calls it only with a key it has
     already checked.
   - **What slices 3 and 4 must check**, because a malformed field reads as absent:
     1. *Hub.* Once it has sent `prove.key`, the hub requires `hostNonce`, `hostKey` and `sig` all present and valid. A
        proof with a mac only is dropped, with or without a record; the hub never falls back to a `token` other than the
        marker for that line.
     2. *Host, at `prove`.* When `key` is present, `nonce` must pass `decodeBase64url(nonce, 24)` (the schema still
        allows 22 to 128 characters); otherwise close as malformed, and never answer with the mac path.
     3. *Host, at hello.* A `token === LINK_AUTH_MARKER` with `auth` absent (a malformed one included) is refused. An
        `auth` beside any other token is ignored or refused, and the choice is written down here. `auth` never upgrades a
        limited or verifier hello. *Chosen in slice 3: ignored* (below).
     4. *Host, after any hello attempt.* `Ns` and the stored `Nh` and `keyId` are dropped after any hello attempt, failed
        ones included.
     5. *Hub.* A line whose `hostKey` fails `parseLinkPublicKey` is dropped. `Pm` is compared as the parsed text, which
        strict decoding makes equal to a comparison of the bytes.
     6. *CI.* The slice 3 and slice 4 tests run on Node 24.22.1 as well as on 22, since the two differ in `node:crypto`
        (§4.1).
   - The repository has no property-testing library; the property checks use a small seeded generator in the test, so
     each run sees the same cases.
3. **The machine side.** The launcher's `--pair-key` and `--key-paired` (§4.2, with the probe of the running host),
   `keys` in `serve.json`, at most one key and one verifier entry per label, a new id for a changed key, `hostKey`,
   `keyId` and `pairKey` in the line; the host signs its proof when asked by key, takes the address from its socket or
   from `CC_FRONT_DOOR`, and takes a key hello; the sweep compares `(id, publicKey)`; `host.credentials` covers key
   entries. The hand-over call: `host.handover` limited, the launcher makes no hand-over credential, a host takes a
   `via: 'handover'` entry as limited (§4.4). An old hub sees no change. The acceptance run measures macOS port sharing.

   **Built.** The host's side in `transport/link-proof.ts` (called from `server.ts`), the key entries in
   `lifecycle/serve-credentials.ts`, `host.handover` everyday in `method-rights.ts`; the launcher's side in
   `serve-keys.mjs` (its own copy of the key check, the derived host key and the proof check, held to the host's answers
   and to the pinned vector by `tooling/launcher-keys.test.ts`), `serve-args.mjs`, `serve-files.mjs`, `serve-host.mjs`
   (`probeKeyProof`, `takesKeyHellos`), `serve-run.mjs` and `serve-handover.mjs`; `keyPairing: 1` in the bundle's
   `bundle-info.json`. What it settled:
   - *Item 2.* The nonce is checked first: with `key`, a nonce that is not exactly 24 bytes, or no address to sign (a
     `CC_FRONT_DOOR` of another form), closes the socket (4001, "not a hello") with no proof, before any entry is looked
     up. Only then does an id naming no key entry, or one whose public key is refused, close it as "credential
     withdrawn", which tells a hub to pair anew.
   - *Item 3, the choice: an `auth` beside any other token is ignored.* The hello is judged by its token alone, as if no
     `auth` came: the limited, a session's and a bridge's credential stay what they are, and a verifier credential stays
     a verifier credential. Ignoring cannot raise any rights, and a hub never sends both, so refusing would only add a
     way to fail. The marker with `auth` absent, malformed or not verifying is refused (4001) before the limited paths
     are tried, so it is neither full nor limited. The marker is never compared with a verifier entry.
   - *The #1717 review* (M1, L2): a key entry has no `via` for the host, and `saw` skips only an older launcher's
     one-call verifier entry, so every full hello, by key or by verifier, is recorded and its removal listed as `gone`.
     The key `prove` answers from the entries a socket in may keep (`openKeys`), so a file that cannot be read yet is
     not "credential withdrawn". `--pair-key` gives the hub's entry a new id (reported in the line) when another key entry
     shares its id, since the host takes the first entry of an id; a file with such a twin written by hand is otherwise
     left as it is (both are listed). Not changed: the CLI's sentence for `--revoke <key id>`.
   - *Item 4.* What a key `prove` left is taken off the socket at its first hello attempt, before that hello is judged.
   - *The probe* (§4.2): `signed` (the running host signs, and the line reports its key), `unsigned` (a proof with none
     of the three fields: a host from before key pairing), `none` (the connection is refused) and `unknown` (anything
     else: no answer in 2 s, a socket closed first, a proof with some of the fields or one that does not verify). Only
     `none`, with no live holder of `host.lock` and an installed host that says `keyPairing`, reports the key derived
     from the file; every other outcome pairs by verifier, with no `pairKey` and no verifier entry removed, so a slow old
     host never gets a key line and a keeper's host with an old copy of the key never gets a derived one.
   - A key entry's id is drawn apart from every verifier entry's and key entry's id, so `--revoke <id>` names one entry.
     `--rotate-token` clears `keys`; a hand-written key entry whose public key is refused is not listed, makes no socket
     full and is dropped at the launcher's next write.
   - *Measured with a real `centralu serve`*: `--pair-key` reports the key the running host signs with, the key hello is
     full, `host.credentials` lists the entry with its public key, and none of the file's values (the key, the limited
     credential, the hub's public key, the entry id) is a full hello. After `--rotate-token` the socket is closed (4001)
     by the sweep, the next `--pair-key` reports the running host's old key under a new id, and the hub links at once.
   - *Mixed builds, measured* (WSL, Node 22.23.4 and 24.22.1): main's hub code (`links/` is unchanged here) running
     `--pair` against this machine side pairs by verifier and links as before, with `takes` of
     `["from", "window", "pair"]` and the key entries untouched; with main's host still running under this launcher,
     `--pair-key ... --key-paired` gives a verifier line (no `pairKey`) and keeps the verifier entry, and a hub links to
     that host by verifier with that line as with one from `--pair`.
   - *Mutation check.* 52 rules of this slice were removed one at a time (23 in the host, 29 in the launcher and the
     bundle). Each now turns a test red but four. Two are hidden by the socket's own handling: dropping what a `prove`
     left at the first hello (a failed hello closes the socket and a second hello after `hello_ok` is ignored, so no
     hello is ever judged on the same nonces twice) and refusing the marker before the limited paths (none of them
     takes the marker, slice 2). Both stay as guards. One is random: a new entry id that avoids the key entries' ids
     (a 32-bit draw). One changes nothing a reader sees: removing the verifier entry also on a verifier line, which
     `--pair` then makes again under the label. `keyPairing: 1` in the bundle has no unit test, as `verifiers` and
     `hostProof` have none: a host bundled into a temporary folder was paired by key, on Node 22.23.4 and 24.22.1.
   - The tests run on Node 22.23.4 and on Node 24.22.1, on Windows and in WSL (§9 item 6); CI's remote-Node job runs
     `tooling/key-pairing-vector` too. macOS port sharing was not measured in this slice: it stays for an acceptance run
     on a Mac.
4. **The hub side, with D2's sentence.** The key file; `--pair-key` at every link and `--key-paired` from the
   record; the record (§5.1) and the refusal, with the made credential withdrawn; the key handshake in `RemoteClient`;
   its own entry recognised by public key, and a verifier entry under its label shown as another's; the additive store
   fields. `security-boundaries.md`: the residual rewritten as closed **from the machine's first key link**, with what
   stays (§2), the first-link window among it.
5. **Dropped.** It was a key-confirmed channel in case two listeners could share the host's port on Windows. The
   measurement in §4.3 shows they cannot, on Windows or WSL.
6. **Optional (D1):** the hub's key behind the keeper and the OS store.
7. **Later (D4):** stop taking verifier pairing under a hub's label, from a floor chosen in its own issue.

## 10. Tests

Each fails without its fix.

- **Impersonation** (integration, agent-host): a real host on a port with a `serve.json` paired by key; a test
  "attacker" reads the whole file, stops the host, listens on the port with the derived host key and answers as the host.
  The hub links to it. Then a real host is started again; the attacker tries every value it holds or received (the
  key, every field of the file, the hub's signature, its own transcript) as a hello: none is taken as full. The same
  scenario on the verifier path shows today's leak (the attacker's hello with the received credential is full), which
  is what the slice-4 change must turn red into green.
- **Downgrade** (hub, with a fake ssh runner): with a record, a launcher answering "unknown option for serve:
  --pair-key" gets no `--pair` command and no hello, and a line with `credential` and no `pairKey` gets no hello and a
  `serve --revoke <id>`; without a record, both fall back as today; after the hub's own `machines.rollback` to a version
  without key pairing, the fallback is taken again. The ssh commands run are asserted, not only the outcome.
- **Hand-over** (launcher, `tooling/launcher-serve.test.ts`, and the host): `moveIntoSignIn` leaves `serve.json`'s
  `full` unchanged from start to end; a squatter answering the hand-over's proof receives only the limited credential;
  a new host takes `host.handover` from the limited credential and takes a `via: 'handover'` entry as limited, not
  full.
- **Mixed states:** `--rotate-token` with a host running, then the next link pairs by key at once and reports the
  running host's `Pm`; that host restarted with the new key, then a redial reads the line again and links; a launcher whose running host does not sign pairs by verifier, keeps the label's verifier entry
  and has no `pairKey` in `takes`; `--key-paired` removes the label's verifier entry only on a key line.
- **Public keys:** `parseLinkPublicKey` refuses each small-order encoding (both sign bits), the encodings of y ≥ p, a
  42- or 44-character string, one with a character outside base64url, and one whose last character has a spare bit set;
  the identity key with the forged signature above passes raw `crypto.verify` on Node 22 (the hazard, pinned there and
  skipped on Node 24.22.1, which refuses it itself, §4.1) and is refused by the check on both; a `serve.json` entry holding it plus
  that forged hello is not full; the launcher refuses it at
  `--pair-key` and writes nothing.
- **Transcript:** the test vector's bytes of `T` and both signatures; each field changed by one byte, and two adjacent
  fields with a byte moved between them, fail to verify; non-canonical base64url for a nonce, key or signature is
  refused; a hub signature over a `T` with an `Nh` other than the one its `prove` carried is refused; an `auth.key` other
  than the `prove`'s is refused; a host behind a front door verifies with the door's port from `CC_FRONT_DOOR` and
  fails with its socket's inner port; a host without one uses the socket's local address.
- **Replay:** a valid key hello recorded and sent again on a new socket, and on the same socket after a second `prove`,
  is refused; a host proof recorded and answered to a later `prove` is refused by the hub.
- **Order:** a hello with `auth` on a socket that sent no `prove`, and one after a `prove` without `key` (so no `Nh` and
  no `keyId` are stored), is refused, and never checked against values taken from the hello itself.
- **The marker:** `LINK_AUTH_MARKER` is refused by `sameSecret` against a drawn key and by the limited, session and
  bridge paths (slice 2), and as a full credential of a file paired by `--pair` (slice 3); a hello with the marker and
  no `auth`, or a wrong one, is neither full nor limited (slice 3).
- **Relay:** a relay passing `Nh`, `Ns` and both signatures between a hub forwarding to one port and a real host on
  another is refused by the host. A transcript with the host's key swapped, with the hub's key of another entry, or with
  a host signature presented as the hub's, is refused.
- **Sweep:** a socket full under a key entry is closed when the entry's public key changes under the same id.
- **The row:** with a record, a verifier entry under the hub's label is listed among the others.
- **Nothing in the file opens the host:** for every string in a key-paired `serve.json` and every public key, a hello
  using it as `token` or `auth` is not full.
- **Old builds:** the previous release's `parseServeState` (a fixture of it) reads a file with `keys` and keeps `full`;
  a host without key support answering a key `prove` gets no hello; at most one key and one verifier entry per label.
- **Acceptance, a real run over ssh between two machines:** a hub and a linked machine on new builds; `serve.json`
  there holds the hub's public key and no verifier under the hub's label after the first link; the attack above run by
  hand there as the same user ends with no full socket on the restarted host and the hub's row unchanged; the same with
  an old hub and a new machine and with a new hub and an old machine; the machine updated without a restart links by
  verifier and pairs by key after its restart; `<data>/remote/current` pointed at the previous release by hand ends in
  a refused link and no full credential under the hub's label; `--revoke`, `--rotate-token` with the host running, and
  the hub's key file removed, each followed by a link that pairs again by itself; on a Windows machine, the hand-over
  into the sign-in with no `via: 'handover'` entry written. On a Mac: whether a second same-user listener can take
  `127.0.0.1:<port>` while the host holds it; on a Windows hub, the key file's ACL.

## 11. Decisions

Decided by the orchestrator (2026-10-29, on #1714):

- **D1. Where the hub's private key lives:** a 0600 file in the hub's data folder now; the OS keychain behind the
  keeper stays slice 6, optional.
- **D3. A machine's host key that changed between links:** recorded, not shown.
- **D4. When verifier pairing stops for a hub's label:** not before every machine the hub links has paired by key at
  least once and two releases have shipped with key pairing; the floor is decided then, in its own issue.

Decided by the owner (2026-10-30, on #1714). No decision is open.

- **D2. The sentence on the row when a machine the hub paired by key with offers only verifier pairing.** The
  behaviour is refuse (§5.1), and the sentence is the one proposed: "This machine now offers only the older way of
  pairing, which this computer no longer accepts from it. Update Centralu there, or remove the machine and link it
  again." The reason given: a beta, and a rare case, so the wording is not tuned further now. Slice 4 may use it.
- **D5. What rotates the hub's key.** No button. The key rotates on its own, on revoke and when the key file cannot be
  read, with no new text (§7).
- **D6. A verifier entry under the hub's own label after it paired by key.** No sentence of its own: it is listed with
  the other credentials, with Revoke, in today's text (§4.4).
