# Who holds full power (#1405)

On 2026-10-21 the Assistant misread "empty the trash" (the person meant the Windows Recycle Bin), read the front
door's token from the keeper's `status`, and called `trash.purge` through a script it wrote: the hub relayed it to a
linked machine, and 108 trashed sessions were deleted with no question. The window asks first; the Assistant's own
`delete_trashed` / `empty_trash` raise a card; the raw path asked nothing.

**What this defends against:** a process of the person's own user that is not the person's click in a window (an
agent, a script it wrote, a tool or MCP server, an app server, a `pnpm dev:live` page) getting full host power from a
documented interface and using it without the confirmation the window shows. **The honest limit:** such a process runs
as the same user. It can delete `store.db`, edit it with `sqlite3`, remove the data folder, attach a debugger where the
OS allows it, start the app's own executable, or ssh to a linked machine with the person's key. None of that is closed.
What is removed is the path where full, unconfirmed power is one request away; it is not a wall between processes of one
user, and where it cannot prevent it prefers to be loud.

**Two rights at hello**, besides the Codex bridge's credential ([local-data-and-transport.md](local-data-and-transport.md#local-transport)) (`transport/server.ts`): the token, which a window and a hub linked to this host hold, calls
everything; the **limited credential** (`ccl1:<mac>`, an HMAC of a label of its own keyed by the token,
`transport/limited-token.ts`) calls the everyday methods only. It is derived, not stored, as the bridge's is: the next
host after a swap accepts it with nothing handed over, and holding it gives nothing toward the token. A socket holding it
is a client like a window (it gets the event stream: owner, 2026-10-21, to revisit once the Assistant's tooling no
longer needs it), but none of its `res` frames answers the host's own calls, which are a hub's.

**A session's credential** (`ccs1:<sessionId>:<mac>`, `transport/session-token.ts`, slice 6) has the limited
credential's rights and names a session. Every agent the host starts finds it in its environment, with the host's
address (`CC_HOST_URL`, `CC_HOST_CREDENTIAL`; `hostAccessEnv`, in the Claude CLI's and the Codex app-server's
environment, and so in what they run), so a script an agent writes calls the host the sanctioned way instead of reading
a token from somewhere. One naming a session this host does not have is refused at hello. It is **attribution, not
proof**: an agent's environment is readable by every process of the same user for as long as it runs ("The front door" in [keeper.md](keeper.md#the-front-door)), so a process can present another session's credential. Its rights are the same either way; all it can fake is
the session a card names, which says "which says it runs under the session". The name is weak in two more ways: a
session's name can be changed by any limited caller (`sessions.rename` is everyday), and on a serve host whoever reads
`serve.json`'s key can derive a session credential for any session ([remote-host.md](remote-host.md)). Beside it, a Codex
session's bridge process holds `CC_BRIDGE_TOKEN` (`ccb1`) in its environment, readable the same way, and that one gives
more than the session credential: the session's own tool channel as that session, under its preset ("The Codex bridge gets a credential of its own" in [keeper.md](keeper.md); the rare commands still raise a card in every preset). Derived like the bridge's, so the next
host after a swap, and a keeper's adopted agent, keep it working. An agent started by a build from before slice 6 and
adopted after an update has none (a process's environment is fixed when it starts) until its next start. A host started
inside an agent takes both variables out of its own environment at start (`LAUNCH_VARIABLES`), so its agents get only
its own. The Assistant's instructions do not mention it:
their resident budget had no room, and `keeper.sock` hands out only the limited credential anyway.

**Where it is judged:** in the transport, before the router, on the host where the call starts. A limited call naming a
linked machine's session is refused on the hub and never relayed; the machine does not judge again, since it cannot tell
a relayed call's origin.

**What it may call** (`transport/method-rights.ts`, keyed by every RPC method with no default, so a method added to the
protocol does not compile until someone classifies it, and a test compares its keys with the protocol's):

| Class | With the limited credential | Which methods |
|---|---|---|
| everyday | runs | reading, creating and messaging sessions (a preset of `normal` or below), renaming, sleep policy, the trash's list, read and restore, git, files, terminals, commands, stopping a process, app upkeep that keeps what it replaces. What the user could do by hand anyway is not held back |
| asks | waits for the person's card in the window and runs once allowed ("The card for a limited call" below); refused at once when no window that shows the card holds the token | deleting for good (`trash.purge`, `trash.purgeRuns`, `trash.purgeSubagentSteps`, `trash.empty`); deleting a session (#1371: not fully undoable); deleting or adding a project, its trust either way, its commands, worktree setup and agent instructions; removing, enabling, importing apps, sharing one; adding, removing, installing, updating (save the catch-up below), rolling back, uninstalling a machine, its autostart, its versions, letting it ask here; installing an update (save the idle one below) or turning automatic updates on; a session created above `normal` or carrying a hub's preset (`fromHub`: an `auto` one starts it under `auto` while the hub-auto switch is on, and only a hub, which holds the token, sends it), or set to any preset but `safe` (the parameters do not say what it was); a preference that sets the agent ceiling or depth, or turns approval notifications or their sound off. The hub-auto switch, here (`prefs.set`) or on a linked machine (`machines.hubAuto`), turns on and off with no card (owner decision 2026-11-05) |
| window | refused, never a card | the person's own answers (approval cards, questions, an update's apply and its report, whose ticket every client hears, MCP and skill proposals), the window's layout written whole, an app's secret, an import's preparing and cancelling, an app view's own calls |
| link | refused | a hub's `host.*` calls (`host.stop` and `host.activity` are everyday: stopping is what `kill` does) |
| bridge | refused | `assistant.tool(s)` and `orchestrator.tool(s)` (`apps.sessionTools`, `apps.sessionCall` until #2231): through them a caller would act as an `auto` session, whose own cards are skipped |

The full list, method by method, is [generated/method-rights.md](../generated/method-rights.md), written from the table by
`pnpm docs:rights` and checked by a test. A method whose answer depends on its parameters reads them as sent, before they
are parsed, and asks when it cannot read them. One reads the host's state too, through `RightsHost`, which main.ts
gives the server (a server given none asks): `machines.update` runs without a card when the hub's automatic updates are
on, `when` is `idle` or absent, and the machine runs an older release of the hub's channel that the update brings to the
hub's own version (#1508, owner 2026-10-24; `LinkedMachine.followsHub`, the one place the condition lives, which the
Assistant's `install_machine` reads too). The person already chose that with "Automatic updates", which brings the
hub itself to that version unasked, and the hub runs the same update by itself (agent-host/remote/install-and-update.md). Such an update
waits for the turns there and for its terminals and project commands (it closes none of them; after 30 minutes it gives
up), stops no host it cannot ask what runs (found out before anything is installed), and gives up once automatic updates
go off. Once spent for a version (the person cancelled it, or its two tries failed) `followsHub` is false, so an agent's
update of that machine asks again. `machines.cancelUpdate` stays everyday: a limited caller can end the hub's own
catch-up of a machine while it waits, and that stops it until the hub's next version (the person's Update still works).
Stopping an update is what the person's Cancel does and changes nothing there, so it is not held back. `now`,
`machines.rollback`, `machines.uninstall`, `machines.install` and `machines.acceptVersions` still ask. `updates.apply` reads the
host's state in the same way (`RightsHost.updateAtRest`, #1509, owner 2026-10-24): it runs without a card while the person's
Automatic updates are on and nothing is running (`hostBusy`: no turn, no card waiting, no background work, no terminal or command, and
not draining to stop), since the host installs the known update by itself then (`UpdateService.setAutoApply`). Anything else, and a
server given no state, asks. Turning the setting on stays an ask. The rule for `asks`: it deletes beyond what the trash brings back, moves out of reach what the trash does not fully
restore, widens what agents, apps or machines may do without the person, or brings in code that later runs unasked;
and everything the Centralu tools card in every preset is `asks` too. A test reads the Assistant's flows
(`sessions/*-flow.ts`) and fails when a window method they call after their card (in the same block) is everyday here,
unless it is a read made again after Allow; a card raised only in some branches (restoring a session whose project was
deleted) is not seen by it. A refusal is `ok: false` with
`data: { refused: 'rights', rights }` and a line in the host's log naming the method; the socket stays open.

**The card for a limited call** (`host-requests.ts`, slice 3). An `asks` call is held, and the host raises a
**host request**: not a session's card (the program holds no session's rights, and a card in the Assistant's slot
would read as the Assistant's doing) but the host's own, shown over the lanes of every window that said in its hello
that it shows them (`hello.shows`), one at a time, oldest first.

- **What it names.** The trash's deletes ask through the Assistant's own trash flow with this card in place of
  the Assistant's: the same question, naming each session (quoted on one line), its machine, its size and what goes
  with it, and the same reading of the trash again after Allow: a session restored meanwhile is not deleted, and
  `trash.empty` deletes only the rows its card listed, never what arrived while it stood. Any other method's call is
  parsed by the method's own schema first (`host-request-targets.ts`): a field the method does not take is dropped, so
  a caller cannot put text on the card that would not run, and a call the method would refuse is refused before it
  asks. The card names the method, what it acts on by name as the window's lists name it (the session, project, app or
  linked machine, with the machine it lives on), what a delete loses, and the parsed parameters, quoted on one line with
  format characters escaped; the call runs with those parameters. An id that names nothing is refused, and after Allow
  the names are read again: a call whose target was renamed, deleted or unlinked while the card stood does not run.
  Parameters too long to show whole (over 2,000 characters) are refused rather than cut, since what runs is what the
  card shows. The card wraps a line anywhere, so a long one is not clipped.
  The program's own name (`hello.client`) is shown quoted, cut to 60 characters, and said to be what it calls itself:
  nothing checks it.
- **Who answers.** Only a window holding the token (`requests.answer` is `window`): never the program, another
  limited socket, a bridge or an agent. Allow and Deny only, no "always" (owner, 2026-10-21), and no key: a y meant for
  the composer must not delete something for good. A card's buttons take a click only once it has stood half a second,
  and one click: the next card appears where the last one was, and the program hears each answer and can ask again.
- **When it is refused at once.** No window that shows host requests holds the token (owner, 2026-10-21: refused,
  not left standing): an older window, a hub's link and the limited credential count for nothing. Or 8 already wait,
  counted again when the card is raised (a trash delete reads the trash first, so many at once cannot pass the bound).
- **When it ends unanswered.** The program's socket closes, 15 minutes pass (owner, 2026-10-21: the one card with a
  timer, since a raw call has no turn to end it), no window shows requests for 30 seconds (a window that reloads comes
  back within it and keeps its cards), or the host stops (its sockets close with it). Nothing is kept across a restart: the caller asks the
  next host again. An allowed call runs as a call the host serves, so a drain before a stop refuses or cuts it like any other.
- **Linked machines.** The card is raised on the host where the call started, before the router, so a call naming a
  linked machine's session asks on the hub and is relayed only once allowed (with the hub's link, which holds that
  machine's token). A linked machine's own limited callers are refused there: no window there shows host requests, and
  the hub does not show a machine's (`requests.*` are never forwarded).
- **Residual.** A window built with `dev:live` holds the limited credential and is a window all the same: it shows
  the card, and its Allow is refused (`window`), so the person answers in the app's own window.

**Who holds what, today.** Built so far: the credential, the classification (slices 1 and 2), the card (slice 3), and
the keeper handing the token to windows only (slice 4, [keeper.md](keeper.md)): a script that asks
`keeper.sock` gets the limited credential, and a serve host's `serve.json` (slice 5, [remote-host.md](remote-host.md)) holds no
full credential: a script that reads it, or runs `--connection`, gets the limited one. Every agent's process has its
session's credential (slice 6). The direct host on Windows gives its token only to the window that started it.
