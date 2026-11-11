# Making a new project (`projects.create`, `create_project`, #515)

A project used to need a folder that already existed (`projects.add` refuses one that does not). Now
the host can make one: `projects.create { name, parent?, machine? }` makes an **empty** folder (no
`git init`, no template) and registers it as `projects.add` does, but trusted (#655): nothing in it came from outside. A clone (`source`) is
registered untrusted, and registering a path that is already a project never changes its trust. `projects.createPreview` answers
where it would go and why it would be refused, without making anything; the dialog asks it as the
person types. Both route by `machine` like `projects.add` (remote-hub.md §5), so the folder is made
by the host of the machine the project lives on, with that machine's own path rules.

| Rule | Where |
|---|---|
| The name is one folder: no `/` or `\`, not `.` or `..`, no control characters, at most 255 bytes, no Windows device name (`CON`, `nul.txt`, `COM1`) on any machine; on Windows also none of `< > : " \| ? *` and no trailing dot or space | `folderNameError` (protocol, shared with the dialog and the mock) |
| Nothing there is reused: a folder, a file or a broken link of that name refuses the call, and `mkdir` is never recursive for the folder itself, so a name taken after the check is refused too | `projectFolderTarget`, `makeProjectFolder` (`dev-services/project-folder.ts`) |
| A given `parent` is a full path to a folder that exists; it is never made | same |
| No `parent`: the machine's `~/Centralu`, made if missing | `projectsHome` |

**The default location is `~/Centralu`** on every machine: `~/Centralu` on macOS and Linux (WSL included),
`%USERPROFILE%\Centralu` on Windows (`projectsHome`, a platform module; the name is `PROJECTS_DIR` in protocol, which
the mock shows too). It is made on first use.

| Decision | Why |
|---|---|
| `~/Centralu`, not the Desktop (owner, 2026-10-12; the first build of #515 used the Desktop) | No permission prompt: on macOS the Desktop is a protected folder, and the first look into it (typing a name in the dialog) asked for access in Centralu's name; a folder of the home is not protected. Visible: it is found in Finder or Explorer, where a person looks for their work. One rule everywhere: no Desktop known-folder lookup (PowerShell on Windows, XDG on Linux), and a WSL distro or a server, which have no Desktop, get the same folder as a laptop |
| Apart from the data folder (`~/.centralu`) | The data folder is the app's and an uninstall may remove it; projects are the person's work and must not go with it |

The host only has a default location when `main.ts` wires one in (`ProjectCreation.useProjectsHome`); without it a
call with no `parent` is refused. That is what keeps tests and the linked-hosts e2e (which give a temporary `HOME`'s
`Centralu`) out of the home of whoever runs them.

**A clone instead of an empty folder** (`source: { git, branch? }`; the owner's addition on #515). The folder is made
empty first, by the same rules, and then `git clone -- <url> <folder>` runs into it (`dev-services/project-clone.ts`):

| Rule | How |
|---|---|
| The machine's own git and sign-ins | the clone runs on the host of the machine the project lives on, through `runGit`, with the person's git configuration (a fresh clone has no configuration or hooks of its own, so nothing the repository chose can run) |
| Never asks for a sign-in | `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=` and `SSH_ASKPASS=` (empty, which git skips), `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never` (Git Credential Manager uses what it has saved, no window), and `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` unless the person set their own ssh command. A repository that needs a sign-in the machine has not saved fails at once with one sentence |
| Addresses | `https://`, `ssh://` and scp-like `user@host:path` only (`gitSourceError`, protocol). Refused: `ext::` and every `<transport>::`, `file://` and local paths (an agent could otherwise have a folder of the person's copied into a project it reads), `git://` and `http://` (unauthenticated, unencrypted), an address or host starting with `-`, and a password written into the address (it would be kept in `.git/config` and shown on the card). `protocol.ext.allow=never` and `protocol.file.allow=never` are also passed, for a redirect |
| No submodules | no `--recurse-submodules`: their addresses are the repository's to choose, past the one the person approved |
| Name | an empty `name` is the repository's own (`repoNameOf`: the last path segment without `.git`) |
| Failure leaves nothing | the folder made for it is removed and no project is registered; each failure is one sentence (`cloneFailure`: a missing sign-in, branch, host or repository, no git, or over the 10-minute limit) |
| Time | the host stops a clone after 10 minutes. The window's call waits 180 s (`LONG_CALLS`) and a linked machine's hop 200 s; past that the dialog says it is still cloning, and the project joins the list when it lands (`projects_changed`) |

Tested end to end against a local bare repository served over https (git's dumb protocol from a static server, a
self-signed certificate trusted through `GIT_SSL_CAINFO`, the person's git configuration left out), including a
path that answers 401 for a repository that needs a sign-in (`sessions/clone-project.test.ts`).

**The Assistant's `create_project { name?, parent?, git?, branch? }`** replaced `propose_project`, which only lit
up the sidebar's Add project button. It raises a card in the Assistant's own approval slot
(`project_create`: the name, the full path and, for a clone, the repository and branch), and the call waits for the answer, as `ask_project`'s
consent card does (`askHost`). Nothing is made until the person chooses Create; "always" is read as
allow and nothing is remembered; deny, or the call stopping, makes nothing. The target is checked
before the card (a refusal costs the person nothing) and again after it. A project made this way is
announced with `projects_changed`, which every window answers by re-reading the project list. It is
the Assistant's alone (security-boundaries/tool-matrix.md), and it makes projects on this computer only: the
hub's Assistant does not see the linked machines; their projects are made from Add project, by picking the machine. A
clone also says "Cloning … into …" in the Assistant's conversation once Create is chosen, while the call runs. The
swap left the Assistant's resident set smaller than before (`residentCost`, Claude: 11,798 → 11,620 characters, and
11,770 with the clone's arguments; docs/tool-cost.md).

**Adding a folder that already exists** (`add_project { path, machine? }` and `list_machines`, #1220, the first slice of
#1219). The person linked a laptop and asked for two folders on its desktop as projects; `create_project` never reuses
a folder, and nothing named the machines. Both are rare commands of the Assistant (`RARE_COMMANDS`, reached through
`centralu_run`, #1205), the Assistant's alone:

1. The folder's machine reads it, changing nothing: `projects.inspect { path, machine? }` (additive, routed by `machine`)
   answers the absolute path in that machine's terms (a leading `~` is its home; any other relative path is refused),
   whether something is there and is a folder, whether it is in a git repository and that repository's `origin` (git's
   config only, with the untrusted-project settings), and the project already kept for it (`ProjectCreation.inspectFolder`).
2. A missing path, a file or a folder already a project is refused with that reason, before any card.
3. The card (`project_add`, raised by `askHost` with `alwaysAsk`, so `auto` asks too) shows the machine, the path, that it
   exists and is a folder, and the git facts; `text` carries the whole question for a window that does not know the kind
   (#844). Allow or deny; "always" is read as allow and nothing is remembered.
4. On Allow the folder is registered as the sidebar's Add project registers it: on this computer the facts are read again
   (a folder gone or added meanwhile is refused) and `addProject` registers it, then the apps list is read again
   (`ProjectCreation.registerFolder`, the steps of `projects.add`); on a linked machine, that machine's `projects.add`
   through the router, which checks again there. New, it is untrusted. The host then sends `projects_changed` with
   `added` (additive), and a window asks about the project's trust as it does for a folder the person added.

A machine on a Centralu from before `projects.inspect` is named as too old, before any card. `list_machines` answers one
line per machine from what `machines.list` answers (`SessionManager.useMachineList`, wired to `links.list()` in
`main.ts`): its name, status, OS and shell (from the shell the hub reaches it with), and whether it reconnects by itself
(Auto reconnect, `MachineInfo.autoReconnect`, #1341).

**Managing the linked machines** (#1219, second slice). The Assistant's rare commands `add_machine { sshTarget, name?,
wslDistro? }`, `install_machine { machine, action: install | update }`, `remove_machine`, `reconnect_machine`,
`set_machine_auto_reconnect { on }` and `set_machine_autostart { on }` make the calls the Machines screen makes on the
hub's links (`MachineFlow`, `sessions/machine-flow.ts`, wired by `SessionManager.useMachineOps(links)` in main.ts).
`add_machine` connects nowhere before the person's card (security review of #1238): the target is resolved with `ssh -G`
(`Links.resolve`; no connection, no key loaded) and the card shows the host, user and port ssh would use, and its
ProxyCommand or ProxyJump when one is set. After Allow one BatchMode ssh probes what runs there (`machines.probe`); a
target that does not answer or runs nothing it can link is linked nowhere, and the answer says why, with no second card.
The shell follows the probe as the Add machine dialog's rows do: a Unix shell, Windows through PowerShell, or a WSL
distro of it when one is named. A target, name or distro with a control or format character (Unicode Cc, Cf, bidi
overrides among them) is refused before anything runs. Linking, installing,
updating, removing and start at boot wait for a card in the Assistant's slot under every preset (an `other` card,
`about: "machine_change"`, the question whole in `raw`, so any window reads it; allow or deny, nothing remembered).
Reconnecting and Auto reconnect act at once, as the row's buttons do, except that undoing what the person chose asks (#1341):
`reconnect_machine` on a machine they disconnected or whose Auto reconnect is off, and `set_machine_auto_reconnect` turning the
switch back on, wait for a card (`about: "machine_change"`); a machine away on its own with the switch on is reconnected with no card, and one already connected is answered as connected (nothing is done). Refused before any card: a machine not linked,
a target that is no ssh target or that `ssh -G` cannot read, a name already linked, and an install or update
this computer cannot make (`LinkedMachine.operationRefusal`, the same sentences `operate` refuses with). Every answer
ends with the machine as it is after the change (`machineLine`). An install or update runs while the tool call waits.
