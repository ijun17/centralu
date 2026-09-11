# Architecture vocabulary

Centralu remains a single-user agent control application. A **host** is the execution
machine's Agent Host process, not the browser or SSH tunnel. A **project path** is local
to that host. A **session** belongs to one host and its local data directory.

- **Module / depth:** a module owns a policy behind a small interface, not just a folder.
  `RpcCalls` owns admission/deadlines/delivery uncertainty; `EventLog` owns bounded replay;
  the instance-lock adapter owns exclusive local process authority.
- **Interface / seam:** the platform ports separate UI intent from execution; HTTP and
  WebSocket transport are adapters at that seam, not a second domain model.
- **Adapter:** SSH forwards an existing loopback endpoint. Claude/Codex adapters still
  execute on the host that owns the session. SSH does not own their lifecycle.
- **Leverage / locality:** recovery changes belong in the connection module; streaming
  durability belongs in the message journal, not in views or provider adapters.
- **Epoch:** identifies one host lifetime. A sequence is meaningful only within its epoch.
- **Uncertain command:** sent, but no response observed. It is not automatically retried.
- **Ownership:** one process per local data directory. It is not a distributed lease.

Deletion test: removing the remote web/tunnel adapter leaves the local desktop intact;
removing the recovery/ownership modules removes named invariants rather than leaving
callers to recreate them. See [ADR 001](docs/adr/001-trusted-remote-runtime.md).
