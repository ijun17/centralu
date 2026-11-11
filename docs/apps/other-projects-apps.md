# Another project's apps, on demand (#371 part A)

Decision 4 keeps a session to its own project's apps. The owner's decision for #371 (2026-10-05)
lets a session reach further only while it needs to: it **finds** an app it could attach,
**attaches** it (the app's tools join this session) and **detaches** it (they leave), so another
project's tools cost no context when they are not in use. Code: `sessions/app-access.ts`, the hub's
`OnDemandApps` port in `session-apps.ts`, the tools in `centralu-tools.ts`.

**What can be attached**, decided when the session asks and again every time the hub counts the
session's apps (and so at every call):

| App | When | Asks the person |
|---|---|---|
| Another project's app | The person shares it (off by default), its project is trusted, and it is not `invalid`, `untrusted` or `failed` | Once per pair of projects, in the calling session: the consent card (Allow once, Always for this pair, Deny). "Always" is kept per (from project, to project, `apps`) in `project_consents` (store v44, shared with part B's `ask_project`) and listed in Settings, where revoking it detaches what it allowed. "Once" lasts for that attachment; a denial is not remembered |
| User-folder app | Not `invalid`, `unconfirmed` or `failed` | Never: the person put it in their own folder to use across projects |
| Another project's root app (#1141) | Its project is trusted (an untrusted project's apps are never attached, under any preset, `auto` included), and it is not `invalid` or `failed`. Found as `<project>/<id>`, and attached by its bare id too when one project's root app has it | Never, as a user-folder app: it took that app's place. It has no share switch: its project's trust decides (owner), and the trust card lists the project's apps (§3) |
| This project's own app | Already attached by decision 4 | — |

A session in an **untrusted** project attaches nothing: its repository's text could be the one
asking, and an untrusted project runs none of its own apps either. A project's ordinary session has
the tools (they ride with the reader set, below), and so does the Assistant (#1205, below); a
coordinator, a builder and an agent an app stood up do not.

**The Assistant** (#1205) is given the user-folder apps and attaches the root apps of trusted
projects here, the one it needs when it needs it, under the same name book (`app-<id>`, a name once
seen stays with its app). Nothing else: a project's inner app, shared or not, is that project's
(`find_apps` does not list it and `attach_app` refuses it, naming `send_to_session`), and no card is
asked, as for any root app. The three are among its rare commands, behind `centralu_run`
(`RARE_COMMANDS` in `tool-seats.ts`): as tools they would not fit its ceiling, and its instructions
name `find_apps` in one line. Each answer names the next call in the form the seat makes it
(`centralu_run(command="attach_app", …)`). The attachment is kept per session like any other, so it
lasts across restarts until `detach_app`; a Codex Assistant's thread restarts when the turn ends,
as a project session's does. `apps.reach` answers `reachable` for a root app it could attach and has
not: its agent attaches it with nothing for the person to do; and `untrusted` for one it attached whose
project has since lost trust (so for a project session's too), since trusting the project again is the fix.
An Assistant that had root apps attached before #1205 reads, once, before its first turn since, that
they are no longer attached by default and how to find them (`rootAppsNotice`, [tool-cost.md](../tool-cost.md) §12). A user-folder app the Assistant had
seen, when its folder becomes a project in place (#1141), stays attached to it as an attachment of its
own, under the name it called it by (`UserAppAdoptionRecords.carry`).

**Sharing** is the person's choice, per project app: "Share with other projects" in Settings → Apps,
or the Share button in the app's header (`apps.setShared`). It is kept in the store's settings table
(`app_shared:<project>/<app>`, absent means off) and reported in the app list (`shared: true`).
Turning it off detaches the app from every session that attached it.
Attachments count only while the session holds the reader set, which every ordinary session in a project does: the
Settings switch that took it away, and with it the attached apps and the ones allowed "once" (#382), is gone (owner
decision 2026-10-20, always on).

**The tools** (a project's ordinary session, beside the reader set; agent-host/tool-profiles.md; the Assistant's as commands):

| Tool | Does | Result names |
|---|---|---|
| `find_apps({ query? })` | Lists what this session could attach: `<project>/<app>` for another project's app, `<app>` for a user-folder app, with the project, the manifest's name and first description line (JSON-quoted: the author's words), and the tool names if the app has listed them since the host started (finding starts no app) | `attach_app` |
| `attach_app({ app })` | Asks for consent if needed, attaches, starts the app to list its tools (within the 15 s cap) | the tools as `mcp__<server>__<tool>`, when they are there, and `detach_app` |
| `detach_app({ app })` | Detaches an app this tool attached (a name from `find_apps`, or the server name). An app decision 4 gives stays | — |

They are counted against their own ceiling (`APP_ACCESS_BUDGET_CHARS`, 900; the set is 874, of
which about 210 per tool is the name and schema envelope), not the reader set's. Claude defers all
three behind tool search, which costs +31 input tokens per request against +263 loaded
(`scripts/probe-reader-tools.mts`; Codex has no deferral and loads them). Measured with haiku (Claude Code
2.1.289, `scripts/smoke-delegation.mjs app-access`: a fresh pair of scratch projects per trial with a shared app,
the consent card answered "always", and a prompt naming neither the tools nor the project): in 5 of
5 sessions the model found `find_apps` through tool search, attached the app, called its tool in the
same turn and detached it, and on the next turn no call reached the app (one model tried the old name
anyway; the CLI answered "No such tool available").

That smoke test ran before `ask_project` (#371 part B) was loaded on the same server. With it loaded, a question about another project's app went to `ask_project` and never to tool search
(#522: 0 of 10 runs called `attach_app`). Since then Claude loads `find_apps` (+75 tokens per request) and
`ask_project`'s description ends "For another project's apps, use find_apps." (+11); `attach_app` and
`detach_app` stay deferred. 9 of 10 runs, and 8 of 10 in a second, then called `attach_app`
([tool-cost.md](../tool-cost.md) §8).

**Attaching and detaching, per agent:**

| | Claude | Codex |
|---|---|---|
| Attach | The hub recounts the live handle; the adapter's `setMcpServers` adds the app's proxy server. The tools are there **in the same turn** (measured above: the model loaded `mcp__app-counter__poke` through tool search right after `attach_app` and called it). They always wait behind tool search: the proxy drops `anthropic/alwaysLoad` from what an app declares (#513), so attaching or detaching changes the deferred names and never the request's tool list, and costs no cache rebuild (measured, [tool-cost.md](../tool-cost.md)) | A thread keeps the servers it started with ([attaching.md](attaching.md#claude-and-codex)), so the manager restarts the session through resume **when the turn ends** (`appsRestartAfterTurn`, beside #164's settings restart), and `mcpConfig` then includes the app. The result says the tools arrive next turn and tells the model to finish the turn. Run for real (codex-cli 0.160.0, `TOOL=codex` in the same script): the model attached the app and said it would finish next turn; after "Go on." it called `poke`, detached the app, and on the following turn no longer had the tool. That is also the first logged-in run showing the MCP configuration sent with `thread/resume` takes effect ([attaching.md](attaching.md#claude-and-codex), S-7) |
| Detach | The proxy server is removed at once | Every call is checked against the current set, so a call by the old name is refused at once; the name leaves the thread with the same end-of-turn restart |

**Names.** The app attaches as `app-<id>`, or `app-<id>-2` (and so on) when that name is taken in
the session, for instance by its own project's app of the same id, or was ever given to another app
of the session, one gone for the moment included (#1141, the session's book `session_app_names`,
`SessionAppsHub.claimAttachName`). The name is written in that book, so it stays with the app for the
session's life, and attaching it again after a detach gives it the same name; an app that later
appears in the session's own project with the same id gets a name of its own (`app-<id>-<project>`).

**Where it runs and what is recorded.** Nothing about the app changes: it runs where it lives, with
its own folder as working directory and its own data folder, one instance per (project, app) shared
with its own project's sessions ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#lifecycle)). Calls go through `ExternalApps.call` with caller `session`
and the calling session's id ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#one-call-path)), so the owner's Runs panel lists them under the calling session's
name, and approval follows the calling session's preset (decision 5).

**How long.** Until `detach_app`, or until the session is deleted. The list is kept per session in
the store's settings table (`session_apps:<session>`), so it survives the host restarting and the
session resuming. It is checked again on every count: sharing turned off, the "always" revoked,
either project untrusted, or the app becoming unusable takes it away (Claude at once; a Codex thread
refuses the call, and the name leaves at its next thread).
