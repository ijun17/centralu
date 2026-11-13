# "Always allow", and what the Assistant may change

**"Always allow" on a command** (#838) remembers the command's text, trimmed, and lets through that text only
(`alwaysAllowKey`, `matchesAllowRule` in `protocol/src/always-allow.ts`; both adapters check it before asking). A `*`
is a literal character: a trailing one used to be a wildcard, so "always" on `cat logs/*` allowed every command that
starts `cat logs/`, chained ones included, saved for the project. A command that ends in `*` has no key at all: no "always"
on its card, and a rule an older build saved for one allows nothing now, so it asks again rather than allowing more.
A host from an earlier build, serving the same store during a swap or after a downgrade, would read such a rule as a
prefix, so this build never writes one. A command the card flags (outside the sandbox, network access, input to a running terminal) has no key
either: the card offers no "always", and a rule for the same text does not let it through, since the rule cannot tell
it from the plain command. What the host remembers is its own key for the card, whatever the window sends (see "Always allow" on an agent's own card in [approvals.md](approvals.md)).

**An existing folder becoming a project** (#1220). Before `add_project`, no agent could make Centralu reach a folder
the person had not picked: `create_project` only makes a new one. The Assistant's `add_project` is a new way for an
agent to bring a folder in, on this computer or a linked machine, and the person's card gates it under every preset,
`auto` included (`alwaysAsk`): a project is somewhere the Assistant can start sessions, so this is the person's
choice of reach, not a tool call. The card shows what the folder's own machine found (`projects.inspect`): the machine,
the absolute path, that something is there and is a folder, and whether it is in a git repository with its `origin`
(read from the repository's config with git's untrusted settings, so a planted hook or filter does not run). A path
that is missing, a file, or a folder already a project is refused before the card, with the reason. On Allow the facts
are read again and the folder is registered by the sidebar's own steps (`addProject`, on a linked machine its
`projects.add`): untrusted when new, and the window asks about trust as when the person adds a folder. Deny or a
withdrawn card registers nothing. Only the Assistant has it, as a rare command behind `centralu_run`
(`RARE_COMMANDS`); `list_machines`, beside it, only reads the hub's `machines.list`.

**Linked machines from the Assistant** (#1219). Linking a machine lets this computer, and the agents on it, reach
that machine over the person's own ssh; installing or updating runs Centralu's installer there and, for an update, stops
the Centralu running there; removing one drops its sessions and projects from this computer's lists; start at boot
writes an entry in that machine's own startup. Each of these is the person's choice, so the Assistant's commands for
them wait for a card under every preset, `auto` included, and the card says what will run where. The card offers allow
and deny only and nothing is remembered: a window that knows `machine_change` shows no "always", and an older window's
"always" is read as allow, once. Reconnecting and when a machine connects change no machine and no reach, as the row's
buttons do not ask. Linking connects nowhere before the card (security review of #1238): a probe logs in with the
person's keys, so before the card the host only runs `ssh -G`, which opens no connection and loads no key, and the card
shows where ssh would go (host, user, port, and a ProxyCommand or ProxyJump, which run a command or reach another host
first). The probe comes after Allow, and a target that does not answer is linked nowhere. Before any card the host refuses
what it can tell without connecting: a machine not linked, a target that is no ssh target or that `ssh -G` cannot read,
a target, name or distro with a control or format character (a bidi override would make the card read otherwise than
what runs), a name already linked, and an install this computer cannot make.

**Settings and the session archive from the Assistant** (#1219). `get_preferences` and `set_preferences` change what the
window's Settings changes, through the window's own calls, so the same schemas and handlers decide. The reversible
settings (theme, text size, fonts, line height, idle sleep, update checking, moving idle sessions to a new agent CLI) act
at once. What widens what agents may do (the agent ceiling and depth), trust, approval rules and app
grants have no field: an unknown field is refused by name, and so is `sessionTools`, which is not a setting any more (the
reader set is always on, owner decision 2026-10-20); the trust commands below handle trust, rules, grants and the limits,
each behind its own card where it widens. "Automatic updates" turned on (`autoUpdate`) is a
setting that asks (as is turning off the approval notification, below): with both on, code arrives and the window relaunches without a later question, which is what
`update_centralu` is kept from doing. The card offers allow and deny only (`orchestrator_change`; an older window's "always"
is read as allow, once). Turning off the notification for an approval asks too, and so does turning off the sound while it still
notifies: they are what tells the person a card waits, and the Assistant should not decide that they stop hearing of one.

The session archive is the person's safety net, so deleting from it for good is the one thing there that asks (`delete_archived`, `delete_all_archived`):
the card names what goes (the sessions by name, how many, how large, the tool's conversation files and worktrees that
go with them), and the host deletes exactly what the card named and is still in the archive as the card named it (a session restored and archived again is not), never more. Listing, restoring
and moving a session's subagent steps to the archive lose nothing and ask nothing. A live session cannot be deleted
through these commands: it has to be in the archive first, which `agents.deleteSession` and the sidebar do.

**Trust from the Assistant** (#1219, third slice). Trust is what lets a project's apps run and its setting files
apply, so the Assistant only asks for it, and asks to take it away as well: an untrusted project's sessions read
the person's own settings only, so its own deny rules and the hooks that block tools stop binding its agents (`auto`
sessions included). `set_project_trust` with `trusted: true` raises a card that names the project, its folder and machine, and each app the trust covers with what it can do
(the same wording as the window's trust card, `appCanLines`). What the card named is checked again after Allow, so a
project whose apps changed while the card stood is not trusted on an answer about other apps. Approval rules only
narrow from the Assistant: it may list and remove them, and no command adds one, so a standing "allow" still comes
only from the person's own "always" on a card. An app's remembered allows and the consents between projects can only
be forgotten or revoked from the Assistant, which makes the next attempt ask the person (a forgotten allow: a caller
under `safe` is asked again). Forgetting a deny widens since #2237, as what the app declares then runs unasked, so it
waits for the person on a card like any widening; sharing an app with other projects asks, and an
app's own capability question is still answered by the person alone. Every card quotes what a manifest supplies (an app's
name, description, the background work it declares) with control and format characters escaped, so a line break or a
bidi override in someone's repository cannot make the card say something it does not; a project's folder is named whole.
An app's id, which is its folder's name, is quoted too. A project whose machine cannot be reached is refused before any
card, and so is one whose machine could not list its apps (they are asked of that machine alone, `apps.list` with
`machine`, so a failure is not read as "no app"). The limits on agents
(running agents per project, levels that may start agents) bound the
Assistant's own children too, so every change to them asks, narrowing as well as widening.

A program that is not a window and holds the limited credential (#1405) is asked through none of the cards above: its
irreversible calls raise a **host request**, the host's own card with Allow and Deny only, which only a window holding
the token answers, refused at once with no such window, withdrawn when the program leaves and after 15 minutes ("The card
for a limited call", under "Who holds full power").
