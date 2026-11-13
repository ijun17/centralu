# Session lifecycle and UI reconnection

```
UI disconnects  → the host does nothing (sessions carry on, events accumulate in event-log)
UI reconnects   → hello { afterSeq, streamEpoch } → replay the missed events (same lifetime, within budget)
                  or resync (another lifetime, out of the buffer, over budget) → restore the screen
host restarts   → session processes, terminals and commands end with it, under a keeper too (children.md)
                  → a new streamEpoch → UIs resync
                  → attempt resume with the externalId from the store (the same path as FR-10)
                  → a session that was mid-turn is reset to idle with a `quit` marker (turn-endings-and-mail.md)
                → under a keeper, clients reconnect to the same front-door address (front-door.md)
another build   → a keeper runs one build (keeper.md "A keeper runs one build"): the keeper and its host stop, for an update when the
                  host can, and the window starts a keeper of its own build (updates.md)
app quits       → background mode off (default): the keeper stops the host, as above
                → background mode on: nothing happens to the host; a relaunched app re-attaches
app relaunches  → "Apply now" (#352): the host stops for an update and the relaunched window starts
  to update       the new build, whose host continues the turns it ended (updates.md)
```

Thanks to this design, half of FR-10 (restore on restart) is the same code path as an ordinary reconnect — it is the default behaviour, not a special case. The rules for the cursor, the replay budget and the transport bounds are in [protocol.md](../../protocol.md) §1.

**One host per data folder** (`dev-services/instance-lock.ts`). Two hosts on one folder would each hold their own session list and write to the same `store.db`. Ownership is an exclusive SQLite transaction (`BEGIN EXCLUSIVE` on `host-ownership.sqlite`, DELETE journal mode) that the host holds for its whole lifetime (#82): taking it is atomic, a second host is refused at once, and the operating system releases it when the host dies, however it dies, so a crash leaves nothing stale. `host.lock` (pid and start time; since #1223 also `at`, when it took the folder, `by`, who started it — `app`, `keeper` or `serve` — and for serve `from`, the hub whose link asked and the ssh client's address) remains as the description of the owner in the conflict message, and nothing more: until #461 a live, matching `host.lock` also refused the start, for hosts from before #82 that knew only that file. Before #82 ownership was the file alone, checked and then written: 8 hosts started at once produced 2 owners. This is single-machine ownership — not a distributed lease, and not for a data folder on a network filesystem.

## The files

| File | What it holds |
|---|---|
| [start.md](start.md) | How the host starts, on each platform |
| [keeper.md](keeper.md) | The keeper: who starts it, per-build copies, its control socket, when it ends; a keeper runs one build |
| [front-door.md](front-door.md) | The front door, seen from the host: token and address, the bridge's credential, control lines, drain, open app views |
| [children.md](children.md) | The children the host starts: agents, terminals and commands, leaving, a host that crashes |
| [updates.md](updates.md) | Applying an update, seen from the host; agent updates; without a keeper; the `hostBusy` rule |
| [agent-cli-updates.md](agent-cli-updates.md) | Moving sessions to a newly installed agent CLI; putting idle sessions to sleep |
| [turn-endings-and-mail.md](turn-endings-and-mail.md) | Turns that stopped without anyone asking; the mailbox's delivery in the host |
| [continue-after-update.md](continue-after-update.md) | Continuing the turns an update cut |
| [auto-continue.md](auto-continue.md) | Continuing a turn the provider's capacity, the network or a usage limit stopped, once the cause clears |
