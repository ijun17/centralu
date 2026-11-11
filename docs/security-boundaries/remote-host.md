# The remote host (`centralu serve`, #82)

A host started with `centralu serve` on another machine is reached by the app through an SSH local forward
([agent-host/remote/serve.md](../agent-host/remote/serve.md)). The boundary is the one above, unchanged: loopback binding and the token.

- **Nothing listens on a public interface.** The host binds 127.0.0.1 on the remote; the forward binds 127.0.0.1 on
  the person's computer. Reaching the host takes an SSH login to that machine as that user, so SSH is what
  authenticates the person and encrypts the link. Centralu adds no listener, no TLS and no login of its own.
- **No full credential is written down** (#1405, `serve-files.mjs`, `lifecycle/serve-credentials.ts`).
  `<data folder>/serve.json` (version 2, mode 0600 from the first byte and narrowed back if it drifts) holds the host's
  `key` and one entry per full credential, `{ id, label, verifier, created }`, the verifier being the SHA-256 of the
  credential. The host gets the key as the first line on its stdin (`{"key"}`, a pipe to the launcher: not on the command
  line, which `ps` shows every user, and not in the environment, which every process of the user can read for as long
  as the host runs, measured below in "The front door"), and the file's path in `CC_SERVE_STATE`. It derives what it
  hands out from the key (the limited credential, a bridge's, the proof of a probe) and takes as full only a hello whose
  credential's verifier is in the file, read again at each hello, so a pairing or a revocation applies at once. A hello
  with the key itself is refused. The host takes exactly the entries the launcher lists and `--revoke` takes (an 8-hex
  id and a label `--pair` takes, `isListedEntry` on both sides, one test holding the two rules equal): an entry written
  into the file by hand with no label or another id opens nothing, since one that nobody could see or withdraw would
  undo the listing below, and the launcher's next write leaves it out.
  - **Who gets a full credential.** Whoever runs `serve --connection --pair <label>`: one is made, printed once and
    kept as its verifier, replacing that label's earlier one. A hub pairs as `hub:<its name>-<key>` at each link, the
    key being the 8 hex characters of the hub's own random id (`hubSelfId`, kept in its store), so two hubs of one
    computer name do not replace each other's credential; its own
    credential lives in its memory only, as the token did, and it needs no store change. `serve --window` gets one
    per start (label `window`): the desktop app runs it on Windows, and it runs the same on Linux and macOS, so any
    program of this user there can run it too. The launcher's own hand-over call (`host.handover`, a
    hub's) uses one made for that call and withdrawn after it.
  - **What anyone else gets.** `--connection` without `--pair` prints the limited credential (`limited`) and the
    other full credentials by id, label and date (`others`), never their values; `--stop` and the launcher's probes
    use the limited credential. `--revoke <id>` withdraws one full credential; `--rotate-token` draws a new key and
    withdraws them all. Both act at once on the next hello, and on the sockets already open (#1405 review): the host
    reads `serve.json` at each hello and, while any socket holds a full credential, every second, and closes each
    socket whose credential the file no longer names (4001 "credential withdrawn"; a hub's link then pairs again).
    Before, a socket opened and then revoked within 135 ms kept full rights for as long as it stayed open, while no
    listing named it. A file that is not there (moved aside, as the launcher advises for a bad one) names no full
    credential at all, at once. One that is there but cannot be read (permission denied, as after `chmod 000`, or a
    scanner holding it on Windows) names none for a new hello, at once (#1405 review: a credential paired just before
    kept full rights for 30 s while nothing listed it); a socket already in keeps what the file said at its last read
    for at most 5 s, so one busy moment does not close every link, and is then closed as "credential file unreadable",
    not "credential withdrawn". `host.credentials` then answers the error's code (`unreadable`), and the hub's row
    says the machine's credential file cannot be read; a hub whose link was closed that way says the same, and does not
    take its own credential for withdrawn. The launcher says a file it may not read is a permission problem and how to
    give access back, never to move it aside, which would end every credential it names. Changes to the file take
    `serve.json.lock`: one whose time is more than 10 s from now, ahead or behind (a crashed writer, a clock set back),
    is taken over. A writer reads its lock back before each try of its rename, and tries only within 8 s of taking the
    lock by its own process clock, so neither a stall nor Windows' 5 s of rename retries lets a writer whose lock was
    taken over write. Taking a stale lock over, and removing one's own, move the lock aside first and put back one that
    turns out to be another writer's. Left open: a writer suspended over 2 s between its last read-back and the rename,
    and a system clock set forward by over 10 s while a lock is held.
  - **Moving on.** A version 1 file's token becomes a full credential labelled `legacy` (a hub or window still holding
    it keeps working) and a new key is drawn; the next pairing of a hub or of the window removes `legacy` (a pairing
    under any other label leaves it, so a program's own `--pair` does not cut off a hub that has not paired yet). This
    stays as the update path for a machine below the oldest release still served (#1143): version 2 first shipped in
    0.1.0-beta.45, so updating an older machine runs this launcher on its version 1 file. Every host the launcher starts takes verifiers and its key on
    stdin, so it keeps no single token for an older one; a `legacyHostToken` that release kept goes at the next write.
  - **The honest limit.** A process of this user on that machine can run `--pair` itself, as an agent that ssh-es there
    can. It gets a full credential of its own, which the file names by its label. That is made loud rather than
    prevented (owner, 2026-10-21): the hub's machine row in Settings → Machines lists every full credential the machine
    holds besides the hub's own, by the label its asker gave (shown quoted, never checked) and its date, with Revoke,
    which runs `serve --revoke` there over the machine's ssh without opening its link (`machines.revokeCredential`; the
    hub's own is refused, since its next link would only make it again). The list is the one the machine named when the
    link opened, then what the machine's host says through the link (`host.credentials`, read from `serve.json`) at each
    connect and every 30 seconds: a pairing there while the link is up shows within that. It is shown while connected,
    its labels cleaned to one line. A pairing under a label already there replaces that credential, as the hub's own
    re-pairing at each link does. Each entry keeps how it was asked for (`via`: `pair` for `--connection --pair`,
    `window` for `--window`, `handover` for the launcher's own one-call credential, which a launcher from before #1711 made and a host since takes as limited only), and a pairing is marked `replaced`
    in the file and on the row ("which replaced an earlier one of that name") only when the entry it took the place of
    was asked for another way, or does not say (#1405 review): the window pairing at each start and a hub at each link
    are their own pairer again, and marking them made the flag mean nothing. So `--pair window` in the window's place,
    and the window's next start after it, are a change the person sees. The window's credential, from `serve --window`
    on any OS, is listed on a hub's row as "window" with its date, and its re-pairing at each start is not marked. Two askers of the same way under one label (a
    program's `--pair hub:<name>-<key>` against that hub's own link) cannot be told apart by the launcher: the hub tells
    it itself. One under this hub's own label that this hub did not make says so ("under this computer's own name but
    not made by it"), and the row says when this hub's own was gone from the list or withdrawn while its link held it
    (the host there closes the link then, 4001 "credential withdrawn"); that mark stays for as long as the hub runs,
    since the link pairs again at once. A credential used and then withdrawn before the next 30 s read is listed too
    (#1405 review): the host keeps, while it runs, every full credential a socket said hello with, and `host.credentials`
    adds those no longer in `serve.json` as `gone` (", used, then withdrawn" after its entry, no Revoke; "Full access was used here, then withdrawn" when none other is left, the owner's wording), unless the next
    credential of the same label, the next used there or the one the file names now, was paired the same way (its
    pairer again, as at each window start or hub link; the file's own counts since a review found a hub that had paired
    again but not yet said hello listed as gone on another hub's row for one read). Under any label but a hub's this
    also leaves out one used and then withdrawn when the label was paired the same way again; that new pairing is
    listed itself, with Revoke. Before, `--pair x`, a hello and
    `--revoke` within 135 ms left no trace on any row. The machine's user can get around this at will in two ways:
    - **Kill the host.** Closed while the hub's link is up (#1712). The first time a full credential says hello on a
      host, the host appends its record (id, label, date, verifier, never the credential) to `serve-used.jsonl` beside
      `serve.json`, BEFORE the socket gets its rights, and tells the hubs linked to it at once with a
      `host_credential_used` event over their open links (the sockets in with a `hub:`-labelled credential; the event
      carries a `check` of a nonce of its own, so a hub knows its own credential from one that only reuses its id, and
      never the verifier; a hub's key entry, #1711, has no secret to check and carries its public key instead, which a hub compares with its own, and a hub from before key pairing drops such an event and lists the use at its next read). A hub puts the credential on its row and starts a `host.credentials` read at once (a burst
      of events costs one read in flight and one waiting), whose answer then replaces it, provided that host's record
      holds the credential (`usedIds`; one that started again without it, because the file was removed or could not be
      written, leaves what the hub was told on the row). Until a read has answered, the hub cannot know whether the
      credential is still held, so the row shows it as a held credential is shown, not as "used, then withdrawn" (and
      not at all while the first read the event started is in flight); once a read has answered and does not list it,
      it reads "used, then withdrawn". If the host is stopped first, or the read cannot answer (the file unreadable),
      the use stays on the row as held, also while the link is down, until a read says otherwise. A restarted host
      reads the file back (at most 256 records, the newest; a credential named by more than one line is one record), and
      every report takes in only the lines added since the last read (a byte offset, reset when the file is replaced or
      shorter; one read takes at most 1 MiB of new lines, the newest, and says on stderr when it skips older ones), so a
      program that appends to the file cannot make a report slow, and the file is rewritten (past four times the
      records kept) only from a state that holds all of it, so a fresh use is never rewritten away. A record whose
      line was cut short (a full disk, a power loss) is skipped, and the next record is written on a line of its own. A
      hello reads nothing back: it appends and, when the file was exactly as long as what was read, counts its line
      where it stands; otherwise the next report reads it with whatever else was added (#1715).
      Agents' per-session credentials are not full credentials and are not reported. The owner's constraint
      (2026-10-29) is that this never slows or blocks ordinary work: the hello is not held for the hub (the event is
      queued on the hub's socket, a hub that stopped reading is cut as for any event), with the hub's link down the
      record stays in the file, and a record that cannot be written (a full disk) is said on stderr while the hello
      goes on.
      **Records do not stay for good** (owner decision, 2026-10-30): the first report that finds a recorded
      credential no longer named by `serve.json` writes down when (`goneAt`, a line added to the file) and the host
      drops the record, from memory and at the file's next rewrite, 7 days after (a restart does not renew the clock,
      since it is in the file; a credential still named is never dropped, and one named again loses its note, so a later
      withdrawal starts a new week; while `serve.json` cannot be read nothing is noted or dropped). The date is when the host found it withdrawn, which is the first report after the withdrawal,
      or after a host that was stopped starts and reports again. The hub keeps what the person withdrew from a
      machine's row, by id and time, in its store (`app_settings` `links.revoked.<machine>`, the newest 256, written
      with no migration step; forgotten with the machine, once a read of the machine answers that its host keeps no
      record of the credential (`usedIds`, which is a week after the host's first report after the withdrawal, however
      long no hub read it), and at the latest after 60 days), so a record the machine's host still keeps does not bring
      a withdrawn credential back on the row after the hub restarts. What is left is the same
      user's: drop the hub's link first (the event has nowhere to go; the file is read at the next link), or delete the
      file or make it unwritable, which that user can do as easily as `serve.json` (the hub's event still arrives while
      its link is up, and it keeps it across the restart; with the link down too, nothing is left to show). A swap's
      overlap, two hosts of one folder, may lose a line to the rewrite that shortens a file past four times its bound.
    - **Take the hub's label while its link is down** (end the user's own ssh session, pair under
      `hub:<name>-<key>`, use, withdraw, and let the hub pair again). The host takes the hub's next credential for
      the same pairer again, so its `gone` leaves the taken one out. Closed (#1405 review): `host.credentials` also
      gives every id used under a hub's label, listed or gone, in order of first use (`usedUnderHubLabels`), and the
      hub compares those under its own label with the ids it paired itself while it runs, by id and by secret: the host
      keeps one record per id and verifier, and answers each entry with a `check`, an HMAC under its verifier of a nonce the
      hub chose for that read (never the verifier), which the hub compares with the same HMAC of the secret it holds. An
      entry written into `serve.json` by hand under a reused hub id, with another secret, is not the hub's own then: it
      is listed as used and gone, or, while still listed, as held, and the hub's own is then taken for gone if it is the
      one missing. Any other is listed as used
      and gone ("under this computer's own name but not made by it"); its own are never listed. Left: one used under
      the hub's label before this hub's first link in its present run is not judged, since the hub does not remember
      the ids of its earlier runs. An entry that reuses the hub's own id has no working Revoke: the hub refuses to withdraw its own id, and `serve --revoke <id>` there would take both. The record keeps at most 256 (id, secret) pairs, so whoever can write `serve.json` can still push older ones out, as it could with 256 ids before.

    The row lists 32 and counts the rest ("And N more"), so a flood of entries cannot hide the one after them. A
    process of this user there can also read the key. That gives it the limited credential, a session's credential
    (`ccs1`) for any session it can name, which fakes only the name on a card, and also a bridge credential (`ccb1`)
    for any session it can name, which reaches
    that session's own tool channel (`assistant.tool`, under that session's preset; "The Codex bridge gets a credential of its own" below), as it
    did before #1405 when the file held the token. Any process of this user, on any OS, can run `--window` and get the window's credential, until
    the launcher checks its parent (#1417).
