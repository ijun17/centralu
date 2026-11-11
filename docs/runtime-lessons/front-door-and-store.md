# Front door, swap and the store across builds

**SW1. What long-lived clients hold outlives every host.**
Happened: a restart that changed port or token left the UI "disconnected" (M1.5 defect 2, e5d43cd1); a Codex bridge
reads its address once per thread, so a new port or token silently cut every bridge.
Rule: the keeper's front door keeps one port and token for its life and hands the token to every host; bridges and app
views get the front door's address, derived HTTP secret included.
Guard: `scripts/keeper-integration.mjs` check "the host is given the front door’s token, so clients keep one token
across hosts"; `host/keeper-control.test.ts` "under a keeper is the front door, which outlives this host, and not the
host’s own port"; `host/transport/server.test.ts` "is the same for every host given the same keeper token, differs per
token, is a valid secret and is not the token".
Platforms: macOS, Linux.

**SW2. A connection made while no host is ready is held.**
Happened: measured: a client cut by a swap was greeted by the new host 84–86 ms later.
Rule: hold new connections up to 45 s rather than refuse them.
Guard: `keeper/keeper/front_door.rs` `a_connection_made_while_no_host_is_ready_is_held_until_one_is`.
Platforms: macOS, Linux.

**SW3. A relay whose peer stops reading is let go.**
Happened: writes are blocking; a peer that stopped reading held its relay thread and blocked every handoff, since a
freeze waited for each relay (#392; the handoff went with #1895 step 4 PR 4, the limit stays).
Rule: a 30 s write limit on both relay sockets.
Guard: `keeper/keeper/front_door.rs` `a_client_that_stops_reading_is_let_go`.
Platforms: macOS, Linux.

**SW3a. The front door relays at most 1,024 connections, one descriptor per socket.**
Happened: #840 item 3: each relay held four descriptors (its sockets and a copy of each in the door's table), and any
local process could open relays without bound until the keeper, and everything it holds, ran out of descriptors.
Rule: the table shares the relay's sockets, and a connection past `MAX_RELAYS` (1,024) is closed as it is accepted,
logged once per run. A local process can still hold all 1,024 and lock new clients out of the door until it lets go:
a contained lockout of the door alone, instead of descriptor exhaustion for the whole keeper.
Guard: `keeper/keeper/front_door.rs` `a_relay_holds_one_descriptor_per_socket`,
`connections_past_the_cap_are_closed_until_one_ends`.
Platforms: macOS, Linux.

**SW4. The next host checks itself before the running one drains.**
Rule: a `--standby` host opens the store read-only, refuses a store it cannot read before anything stops, takes no lock,
migrates nothing, attaches nothing, and exits untouched if the keeper abandons the swap.
Removed: went with #1895 step 4 PR 5, which removed the host's standby (`swap-control.ts` `standby`, `Store.inspect`).
What is left of the rule: a host started with `--standby`, which only a keeper of an earlier build starts, exits 1
before it touches the data folder, so that keeper's swap fails with its running host untouched
(`host/lifecycle/host-process.test.ts` "a host started to stand by for a swap exits 1 before it touches the data
folder").
Platforms: macOS, Linux.

**SW5. Draining is bounded by what was measured.**
Happened: measured 2026-10-04: Centralu tools took at most 0.2 s and app tools at most 5.6 s over 88 calls; all
tool calls: p99 78 s, longest 4.5 h.
Rule: drain only calls the host serves itself, 10 s, then cut with a retryable error. Since #1895 step 4 PR 5 only
`host.stop {ifIdle}` drains (the swap's drain, and its rule to release the lock even if detach threw, went with it).
Guard: `host/drain.test.ts` "cuts a call still running at the bound with a retryable error, and does not wait for it".
Platforms: macOS, Linux.

**SW7. A host refuses a store from a newer build before writing anything.**
Happened: an older host opened a newer store silently; even running `schema.sql` would recreate, empty, a table the
newer build dropped (#292, b62f5b8f).
Rule: `min_reader_version` is checked before the WAL switch, `schema.sql` or any migration.
Guard: `host/dev-services/store-min-reader.test.ts` "a store a newer Centralu made unreadable to this host is refused,
naming both versions, and left untouched".
Platforms: all.

**SW8. Migrations expand first and contract a release later.**
Happened: of the first 40 steps, v13, v28 and v32 broke the previous build (2026-10-04), and the previous build is the
one a person goes back to, or a linked machine's `serve --switch` puts back (until #1895 step 4 PR 5, also the one still
serving during a swap).
Rule: every step declares `breaksOlderReaders` and `heavy`; drops and renames land one release after the code stopped
using what they remove; a breaking step raises `min_reader_version` before it runs. One step back is the only safe
rollback.
Guard: `host/dev-services/store-min-reader.test.ts` "every step declares whether it breaks older readers; v13, v28,
v32 and v56 do, and v3, v11, v21 and v40 are heavy"; `host/dev-services/store-min-reader.test.ts` "applying a breaking step
raises the record to that step".
Platforms: all.

**SW9. During a swap only what the previous build can read runs.**
Rule: expand steps run at activation; heavy and breaking ones are written to `deferred_migrations` in the same commit
and run after the ready line, one commit at a time.
*Changed by #1895 step 4 PR 5*, which removed the swap's open (`swap: true`, `runDeferred`). What is left: a store a
host of an earlier build left with `deferred_migrations` owed runs them at the next open, in their place in the order,
each crossed off in its own commit.
Guard: `host/dev-services/store-migrations.test.ts` "run at the next open, after the later steps, and the list goes";
`host/dev-services/store-migrations.test.ts` "a breaking step among them raises min_reader_version when it runs, not
before"; `host/dev-services/store-migrations.test.ts` "each is crossed off in its own commit: an open stopped part way
still owes the rest, and the next open runs it".
Platforms: all.

**SW10. A step commits whole, with its version.**
Happened: a start killed between two ALTERs of one step left the first column added, and the next start skipped the
step for good (#396, bda7de5c).
Rule: a step, its floor raise and its `user_version` bump are one transaction; VACUUM runs after the commit, owed
through a marker.
Guard: `host/dev-services/store-durability.test.ts` "a step that fails half way leaves neither its first change nor the
new version"; `host/dev-services/store-durability.test.ts` "the next open vacuums".
Platforms: all.

**SW11. The WAL is bounded and a checkpoint never waits.**
Happened: a 97 MB WAL next to a 91 MB database after a SIGKILL; 146 MB for days after a swap's VACUUM; a TRUNCATE
checkpoint blocked the event loop for the 5 s busy timeout, past the 3 s shutdown budget (1ecb7393).
Rule: set `synchronous=FULL`, `busy_timeout=5000`, `journal_size_limit`; checkpoint on open, after deferred steps and on
close, with `busy_timeout` 0.
Guard: `host/dev-services/store-durability.test.ts` "the settings a file store depends on are set by the store itself";
`host/dev-services/store-durability.test.ts` "a checkpoint with another connection reading reports it did not fold,
without waiting".
Platforms: all.

**SW12. A failed open releases the database file.**
Happened: on Windows an open file cannot be renamed or deleted, so a refused open kept `store.db` locked until the
process ended (#360).
Rule: the store closes its handle on any failure before rethrowing.
Guard: **UNGUARDED**.
Platforms: Windows.

**SW13. A long migration says so.**
Happened: beta.4 reworked a 151k-message store for over 10 s in silence; it looked frozen and the person quit.
Rule: log "migrated vA → vB (n steps, ms)" and the deferred steps to stderr.
Guard: **UNGUARDED**.
Platforms: all.

**SW14. A newer window must read an older host.**
Happened: a newer window crashed on an older host because results skipped the schema defaults (#337, #339).
Rule: every added payload field has a default and the client parses tolerantly.
Guard: `e2e/older-host.spec.ts` "a window on an older host draws its sessions and a conversation without crashing".
Platforms: all.

**SW15. A host names its build from its own code.**
Rule: the commit is the compiled-in one, never the keeper's record; a malformed record is ignored rather than failing
the start.
Guard: `host/keeper-link.test.ts` "keeps its own commit when the record names another"; `host/keeper-link.test.ts`
"starts with what it has when the record is unreadable".
Platforms: all.

**SW16. One idle rule.**
Happened: counting a finished turn (`waiting_input`) as busy kept every session that had ever answered in the way, and
idle exit and automatic updates never fired (f5894d37).
Rule: busy is a working or approval-waiting session, a pending question or background work, an open terminal or a
running command; unknown counts as busy.
Guard: `host/keeper-link.test.ts` "is not busy with a session whose turn finished and waits for the next message
(waiting_input)"; `host/keeper-link.test.ts` "is busy with an open terminal or a running command".
Platforms: all.
