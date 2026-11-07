# Splitting the linked-machine code by role (#1143 part 2)

Proposed 2026-11-07. The owner's rule for this round (2026-10-31, 11-06): the same behaviour with less code comes before
new features, and a change of behaviour is a proposal for the owner, not part of a refactor. This document is the
second half of `session-manager-split.md`, for `packages/agent-host/src/links/`. It measures the two big files and says what role each part has (§1), audits the folder for one job done in
two places (§2), gives the shape they end in (§3) and the pull requests that get there (§4). Changes of behaviour are
listed for the owner (§6) and are in no pull request here. A
record like the rest of `plans/`, so not mirrored in Korean. Nothing on screen changes.

Measured on main at `15df9318b` (2026-11-07). Paths are under `packages/agent-host/src/` unless they say otherwise. Line
numbers are those of that commit.

## 1. What is in the two files

`links/linked-machine-connection.ts` (1,502 lines) is one linked machine's link: `LinkedMachine` (`linked-machine-ops.ts`,
667 lines) extends it with install, update, autostart and the activity probe. `links/tunnel.ts` (1,343 lines) is the way to the
machine's host: the lines it prints, the commands sent, the ssh transport and what ssh says back.

### 1.1 `linked-machine-connection.ts` by role

The class holds 91 fields and about 70 methods. Grouped by the state a method reads and writes:

| Role | Lines | Owns (fields) | Reads of the rest |
|---|---|---|---|
| The link itself: open, retry, connect, disconnect, the client's `down` / `gaveUp` / `refused`, the hello | ~600 | `status`, `error`, `client`, `gaveUp`, `endpoint`, `opening`, `stopped`, `parked`, `held`, `attempt`, `retryTimer`, `readsOnly`, `quietRetry`, `refusedOnce` | everything below |
| The machine's full credentials as the row shows them (#1405, #1712) | ~285 | `credentials`, `pairedHere`, `usedUnderHubLabels`, `reportedUsed`, `reportSeq`, `reportRead(Again)`, `revokedHere`, `revokedAt`, `ownCredentialTaken`, `fileUnreadable`, `readCredentials`, `credentialsTimer` | `endpoint.line`, `client`, `status`, `stopped`, `info()`, `deps.broadcast`, `deps.registry.setRevoked` |
| A call that needs a machine which is down (#1532): `reachForCall`, `settled`, `whyDown` | ~130 | `statusWaiters`, `lastCallAttemptAt`, `callFailure(At)` | `status`, `opening`, `held`, `parked`, `stopped`, `redialing`, `connect()` |
| Starting a host there and the limit on starts (#1143) | ~75 | `autoStarts`, `restartsSpent`, `heldBack`, `lastStartFailure`, `startAsked` | `deps.restarts`, `name` |
| The remote's sessions the hub shows or hides; the mirror it keeps (#3.4, #1941) | ~90 | `shown`, `hidden`, `coordinators` | `deps.mirror`, `q`, `id` |
| The reverse direction's offers (#550, #1376): `setAsks`, `offerAsks`, `offerAutoCompact`, `withdrawOffer` | ~65 | `asksNote` | `client`, `reachable`, `record.asks`, `deps.hubSelf`, `deps.autoCompact` |
| Watching another hub's switch there (plan §10.5a) | ~65 | `switchSaid`, `switchWatched`, `switchUnread`, `switchNote`, `switched`, `switchTried`, `switchFailure` | `tunnel.exec`, `record.remote`, `setStatus`, `retryLater` |
| The version gate (`check`, `acceptVersions`) | ~35 | `versions` | `deps.hub`, `record`, `setStatus`, `retryLater` |
| `info()` and the small getters | ~50 | | all |

`LinkedMachine` touches only a few of these by `protected` access: `status`, `versions`, `endpoint`, `client`, `held`,
`operation`, `installed`, `bootStart`, `switched*`, `retryLater`, `clearRetry`, `setStatus`, and from the credentials role
`revokedHere`, `rememberRevoked` and `readCredentials` (`revokeCredential`, ops:413-426). Those are the seams.

### 1.2 `tunnel.ts` by role

| Role | Lines | What | Importers outside the file |
|---|---|---|---|
| The connection line and the answers `serve` prints | ~270 | `ConnectionLine`, `RemoteCredential`, `RemoteInstall`, `RemoteAutostart`, `HostStart`, `parseConnectionLine`, `credentialsOf`, `parseAutostart`, `parseDetachLine`, `parseRevoke`, the two errors `StartedNotServing` and `SwitchUnderWay` | `linked-machine-connection`, `autostart`, `update`, `links-registry`, `stored`, tests |
| The command sent to the remote, per shell | ~410 | `RemoteSpec`, `dataDirError`, `wslDistroError`, `powershell`, the stdin framing (~105 lines: `STDIN_*`, `readStdin`, `powershellScript`), `connectionCommand` … `revokeCommand`, `remoteCommand`, `remoteScript`, `MANAGED_SH/PS`, `shimNames`, `npmInstall`, `hubNameForRemote`, `thisHubName`, `hubKeyOf`, `pairLabel` | `install`, `update`, `autostart`, `probe`, `links-registry`, `remote-dev`, tests |
| The ssh transport | ~420 | `Tunnel`, `Endpoint`, `HostStart`, `RemoteRun`, `DirectTunnel`, `SshTunnel`, the `SSH_*_MS` bounds, `accepts`, `portFree`, `freePort` | `linked-machine-connection`, `links-registry`, `stored` |
| What ssh said back, as text | ~150 | `lastLine`, CLIXML, `unescapeBytes`, the ANSI code page | `autostart`, `install`, `linked-machine-ops`, `probe`, `ssh-config`, `update` |

The roles lean on each other in one direction only, if the names are placed so: `connection-line` reads `shimNames`,
`npmInstall` and the `RemoteSpec` type of the command part (the words it tells the person), and the command part reads
`hubNameForRemote` (for `--from` and the pair label). So `hubNameForRemote`, `thisHubName`, `hubKeyOf` and `pairLabel` go
to the command part, with `RemoteSpec`, `shimNames` and `npmInstall`; the connection line imports them, and the command part
imports nothing of the line. The transport (`Tunnel`, `Endpoint`, `HostStart`, `RemoteRun`, `DirectTunnel`, `SshTunnel`)
imports both and is imported by neither. `parseRevoke` and `parseDetachLine` stay with the line (they read what `serve`
prints), `revokeCommand` and `detachCommand` with the commands. The text readers are pure but for one `reg.exe` call,
which is behind `os.ts`. Order of the moves: text, commands, line, so no two new modules import each other.

## 2. One job done twice

Read on main with the earlier audit of #1143 §2 as the starting point. **Confirmed**: the path was read end to end and a
real input reaches both places. **Plausible**: the code reads that way and a run is needed. **Harmless**: the copies
agree today.

### 2.1 What #1143 §2 listed that is gone

L1 to L5 and these latent items are fixed on main: the project lookup (`findProjects` is gone, `everyProject` is the one
path and bounded), the WSL distro rule (`wslDistroError`), the launcher folder (`$d/bin` of `MANAGED_SH`), the npm command
told to a Windows remote (`npmInstall`), the client redialling for good (`redials` and `gaveUp`), the machine named by a
qualified id (`qualifiedMachine`), and "why a machine is down" (`machine-reach.ts`). The `SystemRoot` rule was still
written twice; it is B1 below.

### 2.2 Bugs (a divergent input reaches both places)

| # | Job | A | B | Difference → situation | Verdict | Fix |
|---|---|---|---|---|---|---|
| B1 | Which `SystemRoot` a Windows system program starts from | `os.ts` `systemTool` (a drive path, #428) | `links/tunnel.ts` `ansiText`: `win32.isAbsolute` | A `SystemRoot` that is a share (`\\host\share`) or a rooted path with no drive is run from for `reg.exe`, which every other system program refuses | Confirmed | #2092, with a test that fails before |
| B2 | A call from the window to a machine that is down | `router.ts` `byKey`, `byView`, `byMachine` pass `ctx` to `forward` | `router.ts` `reorderProjects`, `deleteRule`: `forward(m, …)` with no `ctx`; `merge` drops it on the way | `ctx` absent means "an agent's call". The window's `projects.reorder` and `approvals.deleteRule` try to connect a down machine and wait up to 10 s (`CALL_WAIT_MS`), and a refused delete says "ask the person to connect it" to the person | Confirmed | #2093, with a test that fails before. The stall is a machine that is down with Auto reconnect on (10,006 ms on main, 46 ms with the fix); a disconnected one got the wrong sentence |
| B3 | Say a disconnected machine is not connected | `linked-sessions.ts` `list`: `waitsForPerson ? NOT_CONNECTED : NOT_REACHABLE` | `recall`: `"(not reachable right now)"` always | The model reads "not reachable" for a machine the person disconnected and retries, where `list` tells it to ask the person | Confirmed (wording) | #2095 |
| B4 | Ask a machine for `host.hubAuto` | `linked-machine-ops.ts` `hubAuto`: never connects, maps "Unknown method" to `'older'` | `linked-sessions.ts` `hubAuto` through `viaMachine`: waits for the link, returns the raw error | An older machine is `older` to the window and "Unknown method: host.hubAuto …" to the model | Confirmed (wording) | #2097 (one reading, `hub-auto.ts`) |
| B5 | Reset the backoff when a host answers | `remote-client.ts:330` `attempt = 0` at every `hello_ok` | `linked-machine-connection.ts` `STABLE_MS` (60 s): "a host that answers and stops again at once reset it every time" | A real host behind a proxy that cuts the connection 50 ms after its hello, `redials: 5`, 8 s: 30 connections, 30 hellos, `gaveUp` never. Such a host is redialled every 200 ms for good, the link never reads the connection line again, and each hello repeats the list reads, `offerAsks`, `watchCredentials` and a resync | Confirmed (run) | #2104 |
| B7 | "Not installed" | `tunnel.ts` ×2: the marker **or** exit 127 | `autostart`, `update`, `remote-dev`: the marker only | A POSIX remote whose launcher is there and whose Node is gone exits 127 (`env: node: No such file or directory`) with no marker: the row says "Centralu is not installed … run npm i -g centralu" and hides the remote's words. The lookup already prints the marker when nothing is found | Confirmed (a fake ssh with the launcher's own 127) | #2102 |
| B8 | The data folder rule | `data-dir.ts` `chooseDataDir` (`CC_DATA_DIR`, else `~/.centralu`, `~/.centralu-dev` for `CC_DEV=1`) | `remote-dev.ts` `hubDataDir`: no `CC_DEV` | `CC_DEV=1` without `CC_DATA_DIR`: `pnpm remote-dev` opens the real `~/.centralu` store, not the dev hub's | Confirmed | #2100 |

### 2.3 Harmless duplication (same result today, could drift)

D4 and D10 of the first draft were not harmless: they are B7 and B8.

| # | Job | Places | If merged |
|---|---|---|---|
| D1 | Settling before a call | `linked-sessions.ts` `settle` / `reach` / `attempt`; `router.ts` `forward`; `lastWords` and `read` of `linked-sessions.ts` hand-expand `reach` + `catch { cause(err) }`. The `else if (m.attemptUnderWay) m.settled?.()` fallback is reachable only from test doubles | ~-20 |
| D2 | The sentence `ssh could not reach <target>: …`, which `away.ts` `SSH_FAILED` reads back | `tunnel.ts` ×3, `linked-machine-ops.ts` ×1 | ~-8 |
| D3 | The ssh arguments `-T -o BatchMode=yes -o ConnectTimeout=15 --` | `tunnel.ts` ×3 (`startHost`, `exec`, `connectionLine`); `probe.ts` with 10 s | ~-12 |
| D5 | The last JSON line of a command's stdout | `tunnel.ts` ×3 (`parseConnectionLine`, `parseDetachLine`, `parseRevoke`), `autostart.ts`, `update.ts` ×2: three filters, three rules for `v` | ~-45 |
| D6 | `Unknown method` | `linked-machine-connection.ts` and `linked-views.ts` (`startsWith('Unknown method: <name>')`), `linked-machine-ops.ts` (`/^Unknown method/`, now read once in `hub-auto.ts`), `linked-hubs.ts` (`/Unknown method/i`, unanchored), `transport/method-rights.ts:430` (`Unknown method ${method}`, no colon: a fourth spelling) | ~-10 |
| D7 | `<machine>.` as a prefix | `Qualifier.owns`, `splitQualified`, `qualifiedWith`, `awayFor`, `orchestrator-seat`, `view-host`: `"m1."` is owned by one and local to another | ~-25 |
| D8 | The lookup a list is read within | `linked-sessions.ts` `boundedAsk` (4 s) and `linked-hubs.ts` `projects` repeat `LOOKUP_MS` and `projectsOf`'s work; the hub path loses the cause | ~-15 |
| D9 | Backoff arithmetic | `remote-client.ts`, `linked-machine-connection.ts`, `update.ts` (a hand-written `setTimeout` promise beside `sleep`). The client and the link are layered by design (`gaveUp` hands over), not two loops | ~-12 |
| D11 | A hidden session | `hiddenKind`, `linked-host.ts`, `launch-inputs.ts`, `readerFacts`; and the "ordinary session" test of `ask-project-flow.ts`, `machine-asks.ts`, `linked-sessions.ts` | ~-10 |

### 2.4 Dead code in `links/`

The `hidden` set of `LinkedMachineConnection` is written and cleared and never read (`hides()` reads `hiddenKind`);
`retryLater`'s doc sits above `seen()` and the doc of `notPairedHere` above `ownOf`; about 60 `export` keywords name
something used only in their own file (the audit lists them by file; the type-only ones cost nothing and are left).
`DirectTunnel` is used by tests alone, and with it the "absent" branches of `Tunnel.exec` and `startHost` (about 20
lines): it is the fake transport of the link tests, so it stays.

### 2.4a Checked and not a duplicate

- **What becomes `previous` after an update** (`update.ts` against `dev-build.ts`): the two never see the same input. An update
  runs the switch from the new version and keeps the old `current`; a dev build over a dev build keeps the release before
  both. That an update from a dev build leaves the dev build as the way back is a policy, and an owner question (§6).

- **The remote's `dev` flag, before and after its hello** (B6 of the first draft, #2106, closed): `doOpen` checks the line with
  `dev: false`, `onHello` with `dev: h.build.commit === 'dev'`. Only a host run from source says `commit: 'dev'`, and it has no
  install source on its line, so the line cannot tell it. A `pnpm remote-dev` build is made by `bundle.mjs`, which stamps the git
  sha as the commit: its hello says `dev: false` too, and `versions.ts` compares a local build (`<base>.local.N`) by its base
  release. The two checks agree for every input a link meets. The pull request read the line's install source as `dev`, which no
  real host pairs with a `dev` hello, and made the two disagree the other way; a reviewer reran it with a real sha and it changed
  nothing. Whether a remote-dev build older than the hub should be exempt from that comparison, as a from-source host is, is a
  policy of `versions.ts` and an owner question (§6).

### 2.5 Between `links/` and the rest of the host

- **Two ways to send a request to a machine** are D1: the router's window path and the agent path differ on purpose
  (`ctx`), B2 is where one path forgot it (#2093). `sessions/linked-host.ts`, `machine-asks.ts` and the apps code reach a machine
  through `LinkedSessions` and the router, not by their own `call`.
- **Two reconnect loops** are layered, not twice: the client redials the same forward a few times (D9), then the link
  reads the connection line and may start a host. B5 was the one place the layers disagreed.
- **Two id tables**: `Qualifier` (ids and events) and `machine-ids.ts` (numbers folded by slot) are different jobs.
  The prefix test is D7.
- **#1987** (a child on a linked computer cannot mail its parent) is not a drift. `mail/tool.ts:141` refuses `parent`
  because the child's host holds no `askedBy` for a session started from the hub; mail does not cross the link at all
  (`mailbox.md` §6.2, #2067). Nothing in `links/` does that job twice, so it is not fixed here.

## 3. The shape it ends in

The target, if every role of §1 became a module, is the map: `LinkedMachineConnection` keeps the link itself (the first
row of §1.1), about 700 lines from 1,502, and each role that owns its state is a class of its own in `links/`, taking a
small host type of what it reads, getters never copies (the `parts()` rule of `session-manager-split.md`), held as a
`readonly` field; `LinkedMachine`'s `protected` seams become the module's public methods; `tunnel.ts` keeps the transport
(about 420 lines) and the other three roles are modules the importers name directly, with no re-export from `tunnel.ts`.

**What is done of it** is smaller (§4, decision D1): the deletions of §2 (measured: -6 lines in #2110, not the -250 the first estimate gave; see below), the text
readers out of `tunnel.ts`, and the two roles cross-machine mail needs as modules (`session-mirror`, `call-reach`).
Each module adds about 25 lines of its own (host type and imports), so a move that ends no smaller and serves no feature
is not made; the rest stays a map.

## 4. The pull requests

Each is a fix with a test that fails without it, a deletion, or a move of code as it was. A move rewrites nothing but
what lint counts as new in a new file (`!` and `as` it counted already in the old one: written as the same thing without
the assertion), and the allowlists (`tooling/lint-allowlist/`, `tooling/os-allowlist.txt`) follow the code.

| # | Pull request | State | Type | Lines (removed / added, tests apart) |
|---|---|---|---|---|
| 1 | **This document; B1**: `reg.exe` starts by `systemTool` | #2092 | fix | 3 / 2 (+59 test, +document) |
| 2 | **B2**: the window's merged writes carry their `ctx` | #2093 | fix | 8 / 8 (+35 test) |
| 3 | **B3**: `recall` names a disconnected machine as such | #2095 | fix | 1 / 1 (+5 test) |
| 4 | **B4**: one reading of `host.hubAuto` (`hub-auto.ts`) | #2097 | fix | 6 / 10 (+20 new file, +28 test) |
| 5 | **B8**: `pnpm remote-dev` reads the dev hub's data folder | #2100 | fix | 4 / 4 (+9 test) |
| 6 | **B7**: exit 127 is not "not installed" | #2102 | fix | 2 / 2 (+10 test) |
| 7 | **B5**: the client's redials stop at hellos that drop at once (short-lived hellos counted apart) | #2104 | fix | 1 / 27 (+46 test) |
| 8 | ~~B6~~: a dev remote judged as one before its hello | #2106, closed | dropped | see §2.4a |
| 9 | **`ssh-text.ts`** out of `tunnel.ts`; the code page lookup behind `os.ts` | branch `centralu/links-split-ssh-text`, opened once #2092 lands | move | 148 / 150 (+6 import lines) |
| 10 | **Deletions**: the dead `hidden` set, `lastWords` and `read` through `viaSession` (D1), the update's `sleep` (D9), two doc comments back above their methods | #2110 | deletion | 75 / 69 (-6) |
| 10a | What the deletions of §2.3 would still do, measured and found not to shrink: D2 and D3 as helpers (+4 lines, one source), D5 (a shared reader adds what it saves), D6, D7, D11 (a decision on one spelling each, across files) | not made | | 0 |
| 11 | **`session-mirror.ts`** (the shown and hidden sessions) | after the deletions; #2067 needs it | move | ~90 |
| 12 | **`call-reach.ts`** | after the deletions; #2067 needs it | move | ~130 |
| 13 | **The reverse-calls allowlist** as the one table a machine's calls to the hub pass | with #2067 | move | small |

Decided (D1, §7): the deletions land first. Of the moves, only those that end smaller, or that cross-machine mail (#2067)
needs, are done: 9 (it removes a file's worth of non-transport code from `tunnel.ts` and one OS touch from `links/`), 11, 12
and 13. The rest of the split of §1 (the credentials, `connection-line`, `remote-command`, `host-starts`, `machine-offers`,
`switch-watch`) is **not done**: each adds about 25 lines and would move code with no one to read it differently. They stay
in §1 as the map of the roles, for when a feature needs one of them to be a module.

### 4.1 Deep tier

Everything in `links/` is deep (`.centralu/tiers.json`, "processes"): every pull request above was tiered deep by
`pnpm tier`. Each says in its description what a reviewer runs with two hosts.

### 4.2 Keeping it from growing back

A new role of a linked machine goes into a module of its own; the connection gets a field and one call. A command built
for the remote goes into `remote-command.ts`, a line it prints into `connection-line.ts`. No new `protected` field for
`LinkedMachine` to reach: it asks the module.

## 5. Work in flight and what this leaves for later

- **Open pull requests touching `links/`** on 2026-11-07 are this stack's own and are independent of each other (each is
  based on main), so a move-only pull request can land when they have (CONTRIBUTING: a move-only pull request lands when
  nothing is in its way).
- **#1895, option C**: no keeper holding code. Nothing here touches the keeper or `apps/desktop`.
- **#2067, mail across linked machines**, planned after this cleanup and not built here. Where the split helps:
  `session-mirror.ts` is the one place that says which of a machine's sessions the hub shows, so a mail receipt that comes
  back from a machine is mapped by it and by `Qualifier` and nothing else; `call-reach.ts` is the one answer to "what if the
  link is down" (`reachForCall`, `whyDown`), which is the open question of #2067 (held and sent on reconnect, or
  refused); and `reverse-calls.ts` is the one allowlist a machine's mail to the hub passes (today `hub.projects` and
  `hub.askProject`), so a `hub.mail` method is one line there. The delivery itself is a new job and belongs in a module of
  its own beside `linked-hubs.ts`, not in the connection.
- **#1455, linked machines as peers**, is a proposal and not decided. If it is, the two directions that are separate
  today (`LinkedMachine`, hub to machine, and `LinkedHubs`, machine to hub) meet at `machine-offers.ts`. Nothing here
  assumes it.

## 6. Proposals that change behaviour (the owner decides; in no pull request here)

| Proposal | What changes for the person | Lines saved | Risk |
|---|---|---|---|
| `Unknown method` read one way in `linked-hubs.ts`, `method-rights.ts` and the rest (D6) | A hub error that only mentions the phrase is no longer read as "from before" | ~0 | Low |
| Keep a dev build as the way back after an update from it (`update.ts`), or lead back to the release before it as a dev-over-dev build does (`dev-build.ts`) | Rollback after an update from a dev build goes to the release, not to the dev build | ~-4 | Low; a policy, and the two operations never see the same input |
| Treat a `pnpm remote-dev` build older than the hub as a dev build in the version check (`versions.ts`, today a local build is compared by its base release), on the line and in the hello alike | A remote-dev build at an old base release is let in, with no Update offer, instead of held at `versions_differ` | ~0 | Low; a policy of `versions.ts`; both checks would need the same signal (a field in the hello or the line's install source) |
| Drop `DirectTunnel` and the optional `exec` / `startHost` of `Tunnel` | None; the link tests' fake transport becomes a real fake ssh | ~-30 | Medium: rewrites the test world |

## 7. Decisions for the owner

| # | Question | Default taken until decided |
|---|---|---|
| D1 | The moves of §1 add about 25 lines each | **Decided** (the owner's rule, via the parent session, 2026-11-07): the deletions first; of the moves, only those that end smaller or that #2067 needs; the rest stop |
| D2 | Re-export from `tunnel.ts` for the callers, or migrate them in the same pull request? | Migrate (no compatibility shim); `tsc` proves it |
