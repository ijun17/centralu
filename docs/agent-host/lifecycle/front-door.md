# The front door and the swap, seen from the host (#280, option C step 3)

The design is in [architecture.md](../../architecture.md) §4.2. What the host does:

**Token and address from the keeper.** Under the keeper the host gets the front door's token (the same for every
host the keeper runs) as the first line on its stdin, `{"token":…}`, told by `CC_HOST_TOKEN_ON_STDIN=1` (#538,
`lifecycle/handed-token.ts`), and `CC_FRONT_DOOR` (`ws://127.0.0.1:<door>`) in its environment, which it deletes
once read, so terminals, agents and commands do not inherit it. The token is read before the control channel takes
stdin; a host told to expect it that gets no such line within 10 s ends its start with a line saying why.

A host not told to expect the token on stdin (`CC_HOST_TOKEN_ON_STDIN`) reads `CC_HOST_TOKEN`, as one started by hand from a shell does (CONTRIBUTING.md).

The Codex bridge is started with the front door's address (`keeper-control.ts`, `bridgeAddress`): a running codex
keeps its bridge, and only an address that outlives this host survives its restart (the `front-door` scenario of
`keeper-integration.mjs` kills the host and checks the bridge reaches the next run). Without a keeper the bridge gets the host's own port, as before.

**The bridge's credential** (#382). The bridge is not given the token. It gets `CC_BRIDGE_TOKEN`, an HMAC of its
session id keyed by the host's token (`transport/bridge-token.ts`), because any process of the same user can read
the environment the bridge started with ([security-boundaries/keeper.md](../../security-boundaries/keeper.md#the-front-door)). A
connection that says hello with one is not a client: it gets `hello_ok` and nothing else (no replay, no broadcast,
no terminal output), and it may call only `assistant.tools` and `assistant.tool` (or their old names `orchestrator.*`;
`apps.sessionTools` and `apps.sessionCall` too until #2231), each naming the session the credential was made for. Under a keeper the key is the front door's
token, so the next host accepts a running bridge's credential without anything being handed over.

**Control lines on stdin** (`keeper-control.ts`). The keeper's pipe, and the desktop window's when it started the
host, also carries one JSON object per line. The host parses nothing else the parent sends.

| parent → host | what the host does |
|---|---|
| `{"op":"stop"}` | stops; from the keeper it first notes that the person quit (#1143) |
| `{"op":"stop","forUpdate":true}` | stops for an update ([updates.md](updates.md)) |
| `{"op":"system-ending"}`, `{"op":"system-ending","cancelled":true}` | notes that the system is ending, or no longer is ([turn-endings-and-mail.md](turn-endings-and-mail.md), #1397) |

Under a keeper the host says once per start, after its ready line, `{"swap":{"keepsAgents":false,"stopsForUpdate":true}}`:
that it takes the keeper's stop lines. This build's keeper reads any `swap` line as that; keepers of earlier builds
read `stopsForUpdate`, and windows of beta.40 to 52 still read `keepsAgents`.

**No swap** (#1895 step 4). No keeper starts a second host with `--standby`. A host started with `--standby`, which only a keeper of an earlier
build starts, says it does not stand by (on stdout as well as stderr, where that keeper reads it) and exits 1 before it touches the data folder, so
that keeper's swap fails and its running host serves on (`lifecycle/host-process.test.ts`). `activate` and `drain` get no answer. Quitting
Centralu completely ends it (`lifecycle/keeper-held.ts`, [updates.md](updates.md)).

**Drain** (`drain.ts`). Every WebSocket RPC and every in-process MCP tool call (the Centralu tools, the
app-tool proxy) runs through one tracker. It is begun only by `host.stop {ifIdle}`
(`lifecycle/stop-gate.ts`, #1224): once the host is found idle, new calls are refused, answered with an error saying
the host is restarting and to call again (RPC errors carry `retryable: true`), and a call still running past the
bound is cut with one saying it may or may not have finished. `updateAtRest` and a hub's automatic updates of its
machines wait while it drains.

**Open app views** (#280 step 4). A view's frame address names the front door's port (`keeper-control.ts`, `viewPort`)
and a secret derived from the keeper's token (`transport/http.ts`, `deriveHttpSecret`), so every host one keeper
runs (one it restarts after a crash) gives out the same address for the same instance; without a keeper both stay as
before (the host's port, a random secret). The instances themselves live in memory, so a stop for an update ([updates.md](updates.md))
writes each open one's id, app and `ui://` address to `app_settings` (`views.handover`, `view-handover.ts`), first
thing in its stop plan; any other stop writes nothing. The next host on the data folder, whoever started it, reads
the record before it listens, deletes it, and if it is at most ten minutes old reopens them under the same ids:
each holds its app again as `open()` does, an app that no longer exists is skipped, and a view in a conversation
is re-bound to its card (`InlineViews.adopt`) so its messages still go only there. What a conversation's view does
not keep is its call's input and result (never written down), so once closed it offers "open app", as after any
restart. A crash writes nothing and its views are lost, as before. Per-app origin ports are bound lazily by the new
host the first time `apps.viewFrame` or the proxy page needs them. On the UI side, every open `AppFrame` asks for
its address again after a resync (`hostResyncs` in the store): the same address leaves the view and its state
alone, another one is loaded, a failure takes the first load's failure path. After an update the address is another
one (a new keeper, so a new front door and secret; or a new window's host with a new random secret), so each open
view loads once more, under its old id and card. A view a window leased waits `LEASE_GRACE_MS` for a window to claim
it and is then closed; a conversation's view is closed by its own layer (the person, the session's deletion, its app
going), not by a window being away, so one that no window comes back for stays open as it was before the stop.
