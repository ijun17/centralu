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
| The connection line and the answers `serve` prints | ~270 | `ConnectionLine`, `RemoteCredential`, `RemoteInstall`, `RemoteAutostart`, `HostStart`, `parseConnectionLine`, `credentialsOf`, `parseAutostart`, `parseDetachLine`, `parseRevoke`, the two errors `StartedNotServing` and `SwitchUnderWay`, `hubNameForRemote` | `linked-machine-connection`, `autostart`, `update`, `links-registry`, `stored`, tests |
| The command sent to the remote, per shell | ~410 | `RemoteSpec`, `dataDirError`, `wslDistroError`, `powershell`, the stdin framing (~105 lines: `STDIN_*`, `readStdin`, `powershellScript`), `connectionCommand` … `revokeCommand`, `remoteCommand`, `remoteScript`, `MANAGED_SH/PS`, `shimNames`, `npmInstall` | `install`, `update`, `autostart`, `probe`, `links-registry`, `remote-dev`, tests |
| The ssh transport | ~420 | `Tunnel`, `DirectTunnel`, `SshTunnel`, the `SSH_*_MS` bounds, `accepts`, `portFree`, `freePort` | `linked-machine-connection`, `links-registry`, `stored` |
| What ssh said back, as text | ~150 | `lastLine`, CLIXML, `unescapeBytes`, the ANSI code page | `autostart`, `install`, `linked-machine-ops`, `probe`, `ssh-config`, `update` |

The four roles share nothing but types: the command builders do not read the transport, the transport calls the
builders and the parsers, and the text readers are pure but for one `reg.exe` call.

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
| B1 | Which `SystemRoot` a Windows system program starts from | `os.ts` `systemTool` (a drive path, #428) | `links/tunnel.ts` `ansiText`: `win32.isAbsolute` | A `SystemRoot` that is a share (`\\host\share`) or a rooted path with no drive is run from for `reg.exe`, which every other system program refuses | Confirmed | PR 1, with a test that fails before |
| B2 | A call from the window to a machine that is down | `router.ts` `byKey`, `byView`, `byMachine` pass `ctx` to `forward` | `router.ts` `reorderProjects`, `deleteRule`: `forward(m, …)` with no `ctx`; `merge` drops it on the way | `ctx` absent means "an agent's call". The window's `projects.reorder` and `approvals.deleteRule` try to connect a down machine and wait up to 10 s (`CALL_WAIT_MS`), and a refused delete says "ask the person to connect it" to the person | Confirmed | PR 2, with a test that fails before |
| B3 | Say a disconnected machine is not connected | `linked-sessions.ts` `list`: `waitsForPerson ? NOT_CONNECTED : NOT_REACHABLE` | `recall`: `"(not reachable right now)"` always | The model reads "not reachable" for a machine the person disconnected and retries, where `list` tells it to ask the person | Confirmed (wording) | PR 4 |
| B4 | Ask a machine for `host.hubAuto` | `linked-machine-ops.ts` `hubAuto`: never connects, maps "Unknown method" to `'older'` | `linked-sessions.ts` `hubAuto` through `viaMachine`: waits for the link, returns the raw error | An older machine is `older` to the window and "Unknown method: host.hubAuto …" to the model | Confirmed (wording) | PR 5 |
| B5 | What becomes `previous` after an update | `update.ts:316`: `was.current` unless the versions are equal | `dev-build.ts:67`: `isDevVersion(was.current) ? was.previous : was.current` | Updating from a dev build `X.local.2` to `X` keeps the dev build as `previous`, so Rollback leads back to a dev build, which `dev-build.ts` says never happens | Plausible (needs a run on a dev remote) | after a run |
| B6 | Reset the backoff when a host answers | `remote-client.ts:330` `attempt = 0` at every `hello_ok` | `linked-machine-connection.ts` `STABLE_MS` (60 s): "a host that answers and stops again at once reset it every time" | The link learned this lesson and the client did not: a host that says hello and drops at once is redialled every 200 ms for good, each hello repeating the list reads, `offerAsks`, `watchCredentials` and a `machine_resync` | Plausible | after a run |
| B7 | The remote's `dev` flag | `doOpen` → `check({ dev: false })` | `onHello` → `dev: h.build.commit === 'dev'` | Before the hello a dev remote is judged as a release (`older`, `isSupportedVersion`); after, as a dev build. The gate flips only for a dev build below `MIN_SUPPORTED_VERSION`, which `pnpm remote-dev` does not make | Plausible (edge) | none; noted |

### 2.3 Harmless duplication (same result today, could drift)

| # | Job | Places | If merged |
|---|---|---|---|
| D1 | Settling before a call | `linked-sessions.ts` `settle` / `reach` / `attempt`; `router.ts` `forward`; `lastWords` and `read` of `linked-sessions.ts` hand-expand `reach` + `catch { cause(err) }`. The `else if (m.attemptUnderWay) m.settled?.()` fallback is reachable only from test doubles | ~-20 |
| D2 | The sentence `ssh could not reach <target>: …`, which `away.ts` `SSH_FAILED` reads back | `tunnel.ts` ×3, `linked-machine-ops.ts` ×1 | ~-8 |
| D3 | The ssh arguments `-T -o BatchMode=yes -o ConnectTimeout=15 --` | `tunnel.ts` ×3 (`startHost`, `exec`, `connectionLine`); `probe.ts` with 10 s | ~-12 |
| D4 | "Not installed" | `tunnel.ts` ×2: marker or exit 127; `autostart`, `update`, `remote-dev`: marker only | 0 to -10 |
| D5 | The last JSON line of a command's stdout | `tunnel.ts` ×3 (`parseConnectionLine`, `parseDetachLine`, `parseRevoke`), `autostart.ts`, `update.ts` ×2: three filters, three rules for `v` | ~-45 |
| D6 | `Unknown method` | `linked-machine-connection.ts` and `linked-views.ts` (`startsWith('Unknown method: <name>')`), `linked-machine-ops.ts` (`/^Unknown method/`), `linked-hubs.ts` (`/Unknown method/i`, unanchored) | ~-10 |
| D7 | `<machine>.` as a prefix | `Qualifier.owns`, `splitQualified`, `qualifiedWith`, `awayFor`, `orchestrator-seat`, `view-host`: `"m1."` is owned by one and local to another | ~-25 |
| D8 | The lookup a list is read within | `linked-sessions.ts` `boundedAsk` (4 s) and `linked-hubs.ts` `projects` repeat `LOOKUP_MS` and `projectsOf`'s work; the hub path loses the cause | ~-15 |
| D9 | Backoff arithmetic | `remote-client.ts`, `linked-machine-connection.ts`, `update.ts` (a hand-written `setTimeout` promise beside `sleep`). The client and the link are layered by design (`gaveUp` hands over), not two loops | ~-12 |
| D10 | The data folder rule | `data-dir.ts`, `remote-dev.ts` `hubDataDir` (no `CC_DEV`), `MANAGED_SH/PS` and `DATA_SH/PS` in `install.ts`, `remote-install.mjs` (cannot be shared: it runs on the remote) | ~-10 |
| D11 | A hidden session | `hiddenKind`, `linked-host.ts`, `launch-inputs.ts`, `readerFacts`; and the "ordinary session" test of `ask-project-flow.ts`, `machine-asks.ts`, `linked-sessions.ts` | ~-10 |

### 2.4 Dead code in `links/`

The `hidden` set of `LinkedMachineConnection` is written and cleared and never read (`hides()` reads `hiddenKind`);
`retryLater`'s doc sits above `seen()` and the doc of `notPairedHere` above `ownOf`; about 60 `export` keywords name
something used only in their own file (the audit lists them by file; the type-only ones cost nothing and are left).
`DirectTunnel` is used by tests alone, and with it the "absent" branches of `Tunnel.exec` and `startHost` (about 20
lines): it is the fake transport of the link tests, so it stays.

### 2.5 Between `links/` and the rest of the host

- **Two ways to send a request to a machine** are D1: the router's window path and the agent path differ on purpose
  (`ctx`), B2 is where one path forgot it. `sessions/linked-host.ts`, `machine-asks.ts` and the apps code reach a machine
  through `LinkedSessions` and the router, not by their own `call`.
- **Two reconnect loops** are layered, not twice: the client redials the same forward a few times (D9), then the link
  reads the connection line and may start a host. B6 is the one place the layers disagree.
- **Two id tables**: `Qualifier` (ids and events) and `machine-ids.ts` (numbers folded by slot) are different jobs.
  The prefix test is D7.
- **#1987** (a child on a linked computer cannot mail its parent) is not a drift. `mail/tool.ts:141` refuses `parent`
  because the child's host holds no `askedBy` for a session started from the hub; mail does not cross the link at all
  (`mailbox.md` §6.2, #2067). Nothing in `links/` does that job twice, so it is not fixed here.

## 3. The shape it ends in

`LinkedMachineConnection` stays the one object the registry, the router and `LinkedMachine` hold, and keeps the link
itself (the first row of §1.1): about 700 lines, from 1,502. The roles that own their state move to a class of their own
in `links/`, each taking a small host type of what it reads, getters never copies (the `parts()` rule of
`session-manager-split.md`), and the connection holds them as `readonly` fields. `LinkedMachine`'s `protected` seams
become the module's public methods (`this.credentials.revoke(id)`), not new forwards. `tunnel.ts` keeps the transport
(about 420 lines); the other three roles are modules the importers name directly. No re-export from `tunnel.ts`: a
caller imports the module that does the work, and `tsc` proves the move.

Expected size: the deletions of §2 take about 250 lines out of `links/`. The two big files give about 1,450 lines to eight
modules, which add about 25 lines each of their own (host type and imports). The folder ends smaller only if the
deletions land; the moves are for the reader and for merge conflicts, as in `session-manager-split.md` D2.

## 4. The pull requests

Each is a fix with a test that fails without it, a deletion, or a move of code as it was. A move rewrites nothing but
what lint counts as new in a new file (`!` and `as` it counted already in the old one: written as the same thing without
the assertion), and the allowlists (`tooling/lint-allowlist/`, `tooling/os-allowlist.txt`) follow the code.

| # | Pull request | Type | Lines (removed / added, tests apart) |
|---|---|---|---|
| 1 | **This document; B1**: `reg.exe` starts by `systemTool` | fix | 3 / 2 (+59 test, +document) |
| 2 | **B2**: the window's merged writes carry their `ctx` | fix | 8 / 8 (+35 test) |
| 3 | **`ssh-text.ts`** out of `tunnel.ts`; the code page lookup behind `os.ts` | move | 148 / 150 (+ 6 import lines) |
| 4 | **B3**: `recall` names a disconnected machine as such | fix | small |
| 5 | **B4 and D1**: one way to ask `host.hubAuto`; `settle`, `reach` and `attempt` the one path for `lastWords` and `read` | deletion | ~-30 |
| 6 | **`machine-credentials.ts`** out of the connection (§1.1, row 2) | move | ~285 |
| 7 | **`connection-line.ts`** out of `tunnel.ts` (§1.2, row 1) with D5's one reader | move + deletion | ~270, then ~-45 |
| 8 | **`host-starts.ts`**: the limit on starts, pure, with its own test | move | ~75 |
| 9 | **`remote-command.ts`** (and `powershell-stdin.ts`) out of `tunnel.ts` | move | ~410 |
| 10 | **`session-mirror.ts`** (the shown and hidden sessions) and the dead `hidden` set | move + deletion | ~90 |
| 11 | **`call-reach.ts`** and **`machine-offers.ts`** | move | ~130, ~65 |
| 12 | D2, D3, D6, D7, D9, D10, D11 as small deletions, one pull request each | deletion | ~-110 together |

Order: the fixes first (1, 2, 4), the deletions next (5, 12), then the moves from the most separate to the most
entangled. 6 first (it has a single seam, `revokeCredential`), 11 last (it reads the status machine). 1, 2 and 4 are
independent of each other; 3 stacks on 1 (it moves the code 1 changed); 6 to 11 each stack on nothing but main.

### 4.1 Deep tier

`tunnel.ts` is deep (`tooling/tier.test.ts`, "a linked machine's tunnel"), so PRs 1, 3, 7 and 9 are expected to be, and
`pnpm tier` decides each. PRs 2, 4 and 5 touch the router and the link's answers; each says in its description what a
reviewer exercises with two hosts.

### 4.2 Keeping it from growing back

A new role of a linked machine goes into a module of its own; the connection gets a field and one call. A command built
for the remote goes into `remote-command.ts`, a line it prints into `connection-line.ts`. No new `protected` field for
`LinkedMachine` to reach: it asks the module.

## 5. Work in flight and what this leaves for later

- **Nothing open touches `links/`** on 2026-11-07, so moves can land at once (CONTRIBUTING: a move-only pull request lands
  when nothing is in its way).
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
| Reset the client's backoff on `STABLE_MS`, not at the hello (B6) | A host that answers and drops at once is no longer redialled every 200 ms for good | ~-3 | Low; needs a run on a flapping remote |
| Judge the remote as a dev build before the hello when the line says so (B7) | A dev remote below the minimum version connects as it does after the hello | ~+6 | Low; the line does not say it today |
| `Unknown method` anchored the same way in `linked-hubs.ts` (D6) | A hub error that only mentions the phrase is no longer read as "from before" | ~0 | Low |
| Drop `DirectTunnel` and the optional `exec` / `startHost` of `Tunnel` | None; the link tests' fake transport becomes a real fake ssh | ~-30 | Medium: rewrites the test world |

## 7. Decisions for the owner

| # | Question | Default taken until decided |
|---|---|---|
| D1 | Do the moves (PRs 3, 6 to 11) add ~25 lines each for the reader and conflicts, or stop after the deletions? | Fixes and deletions first; the moves stop when PR 6 has landed, until decided |
| D2 | Re-export from `tunnel.ts` for the callers, or migrate them in the same pull request? | Migrate (no compatibility shim); `tsc` proves it |
