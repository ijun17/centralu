# ADR 001: independently owned hosts behind an optional SSH adapter

- Status: proposed for merge in [Issue 82](https://github.com/ijun17/centralu/issues/82)
- Decision date: 2026-09-11

## Context

The desktop's local-only execution contract cannot honestly be described as an MSA.
Moving its SQLite file onto a shared volume or exposing its token WebSocket on a LAN
would not create safe distributed ownership. Recovery also needs an authenticated
readiness boundary and a host-lifetime identity: a URL and sequence alone cannot
distinguish a restarted process.

## Decision

Keep one authoritative runtime per execution machine. Each runtime owns its local
SQLite store, provider credentials, files, approvals and child processes. Add a
source-run, opt-in browser adapter reached through a strict OpenSSH local forward.
The HTTP assets and WebSocket use one loopback-only port. One browser tab/origin
connects to one host; the execution-host label remains visible. The token is entered
at runtime and kept only in browser memory. The tunnel never starts/stops a remote
shell or host process.

```text
viewing machine                         execution machine
browser -> loopback SSH forward ======> loopback HTTP/WS Agent Host
                                        |-- Claude/Codex adapters
                                        |-- local files and child processes
                                        `-- local Store + exclusive ownership
```

The recovery module waits for `hello_ok`, tracks `(streamEpoch, afterSeq)`, suppresses
duplicate events and requests snapshots when retained replay cannot repair a gap.
Already-sent RPCs without a response fail with explicit uncertainty, never blind retry.
Admission, payload and socket-backlog bounds prevent an interrupted/slow observer
from growing unbounded transport work. Event replay uses a fixed-capacity ring.

Local ownership uses the existing SQLite dependency: a separate persistent ownership
file, rollback-journal mode and a lifetime-held `BEGIN EXCLUSIVE`. Crash recovery is
kernel/SQLite mediated, not a racy stale-PID-file deletion protocol. The store schema
is unchanged. Keep this file on a local filesystem and never remove/replace it while
any host may be alive. [SQLite transaction contract](https://www.sqlite.org/lang_transaction.html),
[network filesystem limitations](https://www.sqlite.org/useovernet.html).

## Alternatives rejected

- Hosted MSA/control plane now: introduces tenants, identity, scheduling, replication
  and cross-host command idempotency without a product contract for any of them.
- Shared/network SQLite: file locking is not distributed session ownership.
- Public plaintext WebSocket: exposes a full local-user execution capability.
- Custom SSH library or remote shell launcher: adds dependency/shell-quoting/lifecycle
  complexity; OpenSSH already provides forwarding and host-key authentication.
- File `read/dead/unlink/create` locking: stale contenders can delete a successor's lock.
- Automatic command retry/failover: a lost response does not prove a command did not run.

## Consequences and limits

This is a modular application with independently deployable execution hosts, not a
multi-tenant MSA or HA cluster. No federation, migration, shared storage, scheduler,
leader election or exactly-once command execution is claimed. Stop older hosts before
upgrading; mixed concurrent host versions are unsupported. Reloading a remote browser
requires the token again. SSH trust/keys and remote process supervision are operator
responsibilities. Native desktop reveal/open-in-IDE features remain local desktop
features, not remote operating-system integration.

Follow-up architecture changes need an explicit product decision and measurable
failure/latency requirements before adding services. [Operator guide](../remote-host.md)
contains the supported path and verification commands.
