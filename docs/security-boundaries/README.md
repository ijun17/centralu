# Security boundaries and residual limits

These controls reduce risks from untrusted repository and agent content. They do not
sandbox an already-executing process with the user's OS privileges. An app's server is such a
process ("App servers"); an app's screen is sandboxed ("App views"). The app model itself is in
[apps/](../apps/README.md).

Each file holds one boundary: what it stops, the code that holds it, and what it leaves open. A change to any of
them is reviewed at the deep tier (`.centralu/tiers.json`, `pnpm tier`).

## The files

| File | What it holds |
|---|---|
| [inter-agent-content.md](inter-agent-content.md) | Text one agent passes to another; Claude's independent-session messaging |
| [start-agent.md](start-agent.md) | Starting other agents in the same project: the child's preset, depth and workspace |
| [ask-project.md](ask-project.md) | Asking another project, and a linked machine's session asking this computer |
| [tool-matrix.md](tool-matrix.md) | What each session's tools can do: the profiles and the profile × tool matrix (`tool-matrix.test.ts` reads it) |
| [mailbox-and-requests.md](mailbox-and-requests.md) | The mailbox's boundaries, the one hold's accepted gaps, a session asking the Assistant |
| [assistant-commands.md](assistant-commands.md) | `create_session`, `start_agent` on a linked machine, the switch, proposals, the rare-commands tier |
| [presets.md](presets.md) | The `edits` preset, and turning things off |
| [approvals.md](approvals.md) | When the person is asked: the table per call and preset, archiving in the window |
| [approvals-from-the-assistant.md](approvals-from-the-assistant.md) | "Always allow"; an existing folder, linked machines, settings and trust from the Assistant |
| [untrusted-text.md](untrusted-text.md) | Tool output in the store, a subagent's steps, text an app sends |
| [project-trust.md](project-trust.md) | Repository configuration and project trust; git before trust |
| [local-data-and-transport.md](local-data-and-transport.md) | The data folder, Antigravity's agent and its token, local transport |
| [credentials.md](credentials.md) | Who holds full power: the full and the limited credential |
| [remote-host.md](remote-host.md) | The remote host (`centralu serve`): what holds it |
| [remote-host-residuals.md](remote-host-residuals.md) | The remote host: what it leaves open |
| [keeper.md](keeper.md) | The keeper's control socket and the front door |
| [signed-content.md](signed-content.md) | Signed content, and local content signing |
| [app-servers.md](app-servers.md) | An app's server: code running as the person |
| [imported-apps.md](imported-apps.md) | Imported apps and app links |
| [app-views.md](app-views.md) | An app's views: the sandbox in layers |
| [desktop.md](desktop.md) | Desktop command permissions, project files and native handoff, images a reply names |
| [windows.md](windows.md) | What differs on Windows, and what holds it |
