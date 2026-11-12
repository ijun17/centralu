# The Assistant's commands: sessions, linked machines, proposals and the rare-commands tier

**`create_session`** (#838) starts the session under the preset it names, or else under the default a new session
gets (`defaultPresetFor`: `auto` in a trusted project, `normal` in an untrusted one, owner decision 2026-11-05), never
above the Assistant's own preset and never above `normal` in an untrusted project, named or not: a default above a
cap is held to it, and a preset named above one is refused with nothing made (`createdPreset`). In a turn a session's
request started (#1739), the default is also held to the asking session's preset, so the work it hands on takes no
request card; a preset named above the asker's still does. There is no card for the caps, as there was none before:
the cap is the rule. So an `auto` assistant may create `auto` sessions in trusted projects, and a `safe` one only
`safe` ones. On a linked machine the request carries `normal` at most, and an `auto` one goes as the caller's preset
(`fromHub`), so it runs `auto` there only while that machine's own "Allow auto from a linked computer" switch is on
and the project there is trusted (`presetFromHub` reads its trust), as `start_agent`'s child there. Its first message is
stored and shown as the Assistant's (`from`), not the person's. It was `normal` at most whatever was asked (and
before #838 `normal` whatever the Assistant ran under, with the instruction recorded as the person's, so a `safe`
assistant that read a planted instruction could start a `normal` session carrying it without a card).

**`start_agent` on a linked machine** (#1038) runs the child there under the caller's preset. A `normal` or `safe`
caller's is carried as it is, behind the card naming the machine, raised every time (`askHost`'s `alwaysAsk`) with no
"always": nothing is remembered for another machine's project.

An `auto` caller's child runs under `auto` there too (#1273, owner decision 2026-10-19), and then no card is raised: the
person let that session act without asking, and the Assistant's own remote work otherwise went back to a
hand-written script that made `auto` sessions there directly. What is carried is the caller's preset only, as
`agents.createSession`'s `fromHub: { callerPreset }`; the machine decides. It takes `auto` that way only while its own
Settings → "Allow auto from a linked computer" switch is on (`UiPreferences.hubAuto`, on by default, so a person can
refuse it on a machine they share; a record that cannot be read, or a value that is not true or false, reads as off,
#1273 review); it reads the switch at each start (`presetFromHub`), and anything else sent with
`fromHub` runs `normal` at most there. The machine does not tell the hub's call from any other holder of its token:
whoever holds the token could already ask for `auto` outright (`permissionPreset`), so `fromHub` gives no one more. The hub asks the
machine first (`host.hubAuto`): a machine whose switch is off keeps the card, which says the child runs under `normal`
and why (`autoWithheld: "machine_off"`; a hub of 0.1.0-beta.45 also sent `"older"` for a machine from before #1273, which
a window still reads); the start's answer to the caller says the same, never silently. A switch turned off between the
hub's question and the start starts nothing there: the child made without a card is given no task and goes to that
machine's session archive. The child is never above its caller (#1273 review): the preset is decided from the caller as it is once
the machine has answered, so the card states the preset the child will get; the caller is read again after the card
(a caller lowered while it stood starts nothing) and once the machine has made the child (one made above the caller as
it is then is given no task and goes to that machine's session archive); and more work by `mail` send is refused to a child whose
preset (kept in the hub's record, `RemoteAgent.preset`) is above the caller's, as a local child's send does. The child's session header shows its preset on both machines (`SessionInfo.startedFromHub`).
**Turning the switch on asks nothing** (owner decision 2026-11-05, #1988): neither `prefs.set` here nor
`machines.hubAuto` for a linked machine raises a card, with the limited credential too. So an `auto` agent on the hub
can turn a linked machine's switch on and then start `auto` sessions there through `start_agent` with no card. The
caller's preset still holds: only an `auto` caller's child runs `auto` there, never above the caller, and only in a
project that machine trusts (`presetFromHub`; the hub asks the machine about `auto` only for a project it lists as
trusted, and otherwise starts a `normal` child behind the card).
**Residual:** the hub holds the machine's token, so the switch is the person's say over what Centralu's own
start_agent carries, not a wall against a hub that is not Centralu. An `auto` child there runs as `auto` runs on that
computer (Codex's `auto` is `danger-full-access` there), with that computer's logins, and an `auto` caller's starts
there are bounded only as its local ones are (the project's ceiling, unlimited under `auto` unless the person set one,
and the agent depth), no longer by a card each. A missing switch reads as on (the default); a damaged one as off. The hub's Settings → Machines sets the switch of
each linked machine over the link (`host.setHubAuto`), so a machine with no window of its own (`centralu serve`) can be
set too, and so the hub can also turn back on a switch a person turned off at that machine; the machine still reads it at each start, and setting it from the hub is no boundary against the hub (any
holder of the token could ask for `auto` outright). A start interrupted between the machine making the child and its
task (a hub restart, a link drop) leaves an idle session there under the child's preset, with no task, which nothing
on the hub follows; nothing runs in it until a person types into it.

The machine keeps the child one level below the caller in the agent
depth (`agentDepth`); a machine whose build would drop it (it has no `projects.origin`) is refused, so two machines
linked both ways cannot start each other's sessions past the setting. The checkout is matched by its origin's
repository (`gitRemoteKey`): a local-path remote never matches across machines, and answers show the repository,
never the address as written, which can carry a token. Its caller may answer a question card of the turn it gave it
(`agent_session answer`), never an approval card there, `auto` or not: what that computer runs is allowed there. A
turn is the one it gave only on evidence: the machine's record of this hub's own instruction, taken while no other
turn ran there, with no other message since and not since the hub last lost sight of the child (a link drop, a
restart). One gate (`RemoteAgents.gate`) stands between the child and every path to its caller (status, wait, answer,
send, a card's notice, the linked report's text and preview), so the person's own turn there is never read, answered
or reported as the caller's: the caller gets only the fact and the state word.

**Proposals** (`propose_mcp_server`, `propose_skill`, #838) are approved by name, and approval installs or saves what
is stored when the person presses it. A proposal under the name of one still waiting is refused, never replaced: a
second one used to swap the command or text the person was reading for one they never saw. The person dismisses the
first to free the name.

Names reach the model's text on one line (#838): `list_sessions` keeps a session's, project's and machine's name to
one line, a session's new name is made one line when it is set, and a builder's role prompt quotes its app's manifest
name, so a name with a line break cannot add a row or a rule of its own.

A reader's `read_session` without an id lists its project's sessions; that is why it has no
`list_sessions`. Its read tools see only its own project (`centraluToolsFor(…, ownProject)` in `sessions/assistant-seat.ts`), and
the object behind them refuses directing calls (`readerToolsFor`).

An ordinary reader's `update_centralu` reaches the host's existing update service only after a host-owned consent card. “Always”
lasts for that session while this host runs; it is not a project grant and it never changes the person's
automatic-update preference. In the commands tier the Assistant reaches it through `centralu_run`, while the
reader is offered its compact definition, deferred behind tool search on Claude because updates are rare.
Its `apply` action (#665) relaunches the person's window into the installed build, and is decided by the caller's own
preset in every profile, assistant included: `auto` applies, `normal` asks on every call until "always" (kept
apart from check and install), `safe` and app agents are refused. The window still makes every check its "Apply now"
makes, so an agent can only ask for what the person could click. `normal` asks no card while the person's Automatic updates are
on and nothing but the caller's own turn is running (#1509, `UpdatesAsked.updateAtRest`, main.ts `updateAtRest`): the window's own
auto-apply would relaunch at that moment. It is judged after a window said it is ready and again right before the relaunch (`update_apply_go.unasked`, on which the window also waits
out someone typing, as its own auto-apply does), and remembers nothing, except that a card-free relaunch that failed brings the card back for that installed version, for every session, so an agent cannot retry it in a loop with no one asked.

**The rare-commands tier** (#512, the default since 2026-10-12). The matrix is drawn as if every command were a tool.
The host takes the Assistant's
`create_app`, `propose_skill` and `propose_mcp_server` out of its tool list
and gives it `centralu_commands`, `centralu_help` and `centralu_run` instead; no other seat changes. Who
may run what does not change: `centralu_run` lists and runs only the commands `profileAllows` gives the
seat (`commandsFor`), a command's own name is refused like any tool the seat was not shown, and a run is
checked against the command's own schema before it goes through the same runner, so each command keeps
its gates and its card (the screen re-reads both proposal lists on a `centralu_run` it cannot name). The
three are Centralu tools (`mcp__centralu__*`), allowed under every preset like the rest.
`sessions/command-tier.test.ts` checks, profile by profile, that the tier changes how a seat reaches a
command and never which commands it reaches. The measurement is in
[tool-cost.md](../tool-cost.md) §9.

Apps are separate from this profile. Decision 4 ([apps/attaching.md](../apps/attaching.md#which-session-gets-which-apps-decision-4)) gives the Assistant the
user-folder apps, a project's sessions that project's apps, and a builder its own app (`givesApp` in
`sessions/session-apps.ts`); a reader adds others with `attach_app` ([apps/other-projects-apps.md](../apps/other-projects-apps.md)), and the Assistant adds the
root apps of trusted projects the same way (#1141: a project whose folder holds the manifest is an app, and
its trust is the project's; #1205: as commands behind `centralu_run`, and never a project's inner app). An
agent an app started gets none (`appsFor`). **An untrusted project's apps attach nowhere** (owner,
#1141): its root app and the apps inside it, to no session, its own project's included, under every
preset, `auto` too; #603's opening no longer applies to apps, and the runtime refuses them for every
caller (`blocker` in `apps/external/runtime.ts`). The project's sessions still run and read its code.
A name a session has seen an app under (`app-<id>`) stays bound to that app for the session's life
(`session_app_names:<session>`), so a later app of the same id, a repository's included, cannot take
calls meant for another (`SessionAppsHub.named`).
