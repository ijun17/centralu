# Domain model

The words Centralu's code, documents and screens use, what each one means, how the things they name relate, and
where each is defined and stored. Read this before the other design documents when a name is unfamiliar.

Based on the model drawn by GyuHo123 in [#411](https://github.com/ijun17/centralu/issues/411), checked against the
code on `main` and brought up to date (2026-10-06).

There are two layers:

| Layer | What | Kept how |
|---|---|---|
| Concepts (this document) | Vocabulary, relationships, the session state machine, the process tree, the main flows | By hand, in the same PR as the code that changes a concept |
| Schema ([generated/schema.md](generated/schema.md)) | Every table and column of the store, with keys and the migration step that added it | Generated from a real store by `pnpm docs:schema`; a test fails when it is stale |

This document stays at the level of concepts: no column lists. Two tests hold the layers together
(`packages/agent-host/src/dev-services/schema-doc.test.ts`): the generated file must match what the migrations
produce, and every table in the store must be named in one of the **Where it is stored** lists below.

Diagrams are UML in Mermaid. `<<kind>>` marks what a session is created as; `<<role>>` marks something a session
**is by its relationships**, read off them each time. Paths are relative to the repository root.

## 1. Glossary

### 1.1 Projects and sessions

| Term | Meaning | Defined in | Avoid |
|---|---|---|---|
| Project | A folder registered with Centralu. Sessions, rules, consents, apps, saved commands and commit attribution hang off it. It need not be a git repository | `ProjectInfo`, `packages/protocol/src/commands/projects.ts` | workspace, repo |
| Trusted project | A project the person said yes to. Trust lets its apps run and its repository settings (`.claude/`) apply; a new project starts untrusted, except an empty folder Centralu made itself | `projects.trusted`; [apps.md](apps.md) §3 | |
| Session | One conversation with one agent tool: its own process (when live), state, model and permission preset | `SessionInfo`, `packages/protocol/src/commands/sessions.ts` | chat, thread, agent |
| Agent tool | The CLI a session runs: Claude Code or Codex. A string so a third can be added | `ToolName`, `packages/protocol/src/entities/ids.ts`; adapters in `packages/agent-host/src/adapters/` | model, provider |
| Adapter | The module that wraps one agent tool in the common contract and turns its output into normalized events | `AgentAdapter`, `packages/agent-host/src/adapters/contract.ts` | driver |
| Session kind | What a session is created as: `worker` (every ordinary session), `orchestrator` or `coordinator`. Not stored as such: read from `is_orchestrator` and from whether a coordinator's member list is set | `SessionKind`, `packages/protocol/src/commands/sessions.ts`; derivation in `readSessions`, `packages/agent-host/src/dev-services/store/sessions.ts` | |
| Orchestrator | The one session of the whole app that sees and directs every session. Belongs to no project | `kind: 'orchestrator'`; `packages/agent-host/src/sessions/orchestrator-tools.ts`, `orchestrator-home.ts` | project orchestrator (retired) |
| Ordinary session | A `worker` in a project that is not a builder or an app's agent. Gets the read-only `reader` tools (worktree sessions, started agents and delegated sessions too), unless Settings turns them off | `readsOwnProject`, `packages/agent-host/src/sessions/tool-profiles.ts` | |
| Worktree session (worker) | A session working in its own git worktree and branch. One the person makes stands on its own; one a session started with `start_agent` hangs under that session (`parentSessionId`). The worktree manager that held them is gone (#561 part 3) | `SessionInfo.worktree`, `parentSessionId` | branch session |
| Coordinator | A session with a fixed list of sessions it may see (`scopeSessionIds`) and a role text (`roleAppend`), made only by the control app's tasks. That app was removed in #372 and the RPC that created one (`agents.createCoordinator`) after it, so nothing makes a new one; the kind stays for the ones already in people's stores, which are listed, read, woken and trashed like any session, and carry `appId: 'control'` | `kind: 'coordinator'`; `manager.ts` | sub-orchestrator |
| Builder | `<<role>>` The session building one app. A session carrying `appId` **and** named by that app in the builder map (`apps.builders`) | `builderRefOf` on `AppSessions`, `packages/agent-host/src/sessions/app-sessions.ts`; `packages/agent-host/src/sessions/app-builder.ts` | |
| App-agent session | `<<role>>` A session an app started through `run_agent`: carries `appId`, is not the builder, runs under `safe`, gets no apps and no reader tools, and its answer goes back to the app. Once its run ends cleanly and nobody took part, it is deleted and its record kept in the trash (#378) | `isAppAgent`, `packages/agent-host/src/sessions/tool-profiles.ts`; `runAppAgent`, `packages/agent-host/src/sessions/app-sessions.ts`; `packages/agent-host/src/sessions/app-agents.ts` | |
| Delegated session | `<<role>>` An existing ordinary session that another project's session gave a task through `ask_project`. Centralu never creates a session in another project for it (#614) and puts no mark on it: the asker is the task's `from` in the conversation, and the task runs as a delegated turn. Before #614 `ask_project` started or reused one and marked it with `askedBy`; those marks are removed | `askProject`, `packages/agent-host/src/sessions/ask-project-flow.ts`; `askFrame`, `ask-project.ts`; [agent-host.md](agent-host.md) §1.2 | delegate |
| Started agent (child) | `<<role>>` A session another session of the same project started with `start_agent` (#561), in that session's folder and under its preset; marked with `askedBy`, and the only sessions that one may work with through `agent_session`. One started on a linked machine (#1038) is a session of that machine's checkout; the hub names its parent as `askedBy` in that machine's rows, and the sidebar hangs it under its parent in the parent's project. Deleting it there takes the worktree made for it on that machine too, only when nothing in it is uncommitted or unpushed, and says otherwise what it left and why (#1161). Like a session working on another project's task, it cannot start agents or ask a project | `SessionInfo.askedBy`; `startAgent` in `sessions/start-agent-flow.ts`, `agentSession` in `sessions/delegation-flow.ts` (both reached through `manager.ts`); `packages/agent-host/src/sessions/start-agent.ts`; [agent-host.md](agent-host.md) §1.2.1 | child, worker |
| Instructions for agents | The person's standing text for the agents `start_agent` starts in a project (#1161 item 2), added after every such task: set once in the project's menu ("Instructions for agents…") instead of repeated in each brief. Each machine keeps its own for its copy of the project, so a child on a linked machine reads that machine's (its paths, its shell) | `ProjectInfo.agentInstructions`, app setting `agent_instructions:<project>`; `projectInstructions` in `packages/agent-host/src/sessions/start-agent.ts`; [agent-host.md](agent-host.md) §1.2.1 | project prompt, system prompt |
| Tool profile | Which bundle of Centralu's own tools (`centralu` MCP server) a session gets: `orchestrator`, `scoped`, `builder`, `reader`, or none (the worktree manager's `manager` was folded into ordinary sessions, #561) | `toolProfileFor`, `packages/agent-host/src/sessions/tool-profiles.ts` (asked through `toolProfileOf`, `manager.ts`); [agent-host.md](agent-host.md) §1.1 | |
| Permission preset | How much the agent may do without asking: `safe`, `normal`, `auto` | `PermissionPreset`, `entities/approvals.ts` | mode |
| Live | Whether the session has a process now. A session that is not live is resumed when addressed | `SessionInfo.live` | archived (FR-20 was retired) |
| Asleep | Not live because the host ended an idle session's process (#568, after 15 minutes by default) or nothing has woken it since a restart. Typing to it or sending it a message wakes it; selecting it does not | `session_live`, `sessions/sleep.ts` | dormant, suspended, hibernated |
| Trash | A deleted session kept for a while before it is gone for good | `sessions.deleted_at`, `trash`; product-spec FR-22 | archive |
| Imported session | A session continued from a conversation the tool started outside Centralu | `SessionInfo.importedFrom`; [agent-host.md](agent-host.md) §8 | |
| Handoff | A fresh successor session, on either tool, taking over from a predecessor through a note: built from the stored conversation with no model (#78; the default since #694), or written by the agent itself. The person starts one from the session menu; the central orchestrator with `handoff_session`, behind the person's card unless it is `auto`, never mid-turn, and always keeping the predecessor (#694). The note is a file, `<data>/handoff/<project>/<session>.md`, and the successor's first message points at it. The predecessor's live children (working, waiting, queued, unreported or unread, a start card still standing) become the successor's, listed at the top of the note; settled ones stay only while the predecessor does (#693). The window keeps the predecessor by default (it deleted it by default until #694); when it is deleted, every child goes to the successor, settled ones too, at the handoff or when the predecessor is deleted later (#738) | `handoff` event, `packages/protocol/src/events.ts`; `packages/agent-host/src/dev-services/handoff-notes.ts`, `sessions/handoff-record.ts`, `sessions/handoff-flow.ts` | (not the keeper's handoff, §1.5) |
| Switch tool | Keeping the session (name, order, history, panel) and swapping the agent tool under it. The new tool starts a new thread: the old tool's conversation does not carry over to the agent, though the record stays on screen | `agents.switchTool`, `packages/protocol/src/commands/methods/sessions.ts`; `switchTool`, `manager.ts` | |
| Goal | An objective set on a session, judged by the tool. Live only | `SessionGoal`, `entities/sessions.ts` | |
| Background task | Work the agent left running inside its own process (a subagent, a shell). Live only | `BackgroundTask`, `entities/sessions.ts` | |

### 1.2 The conversation

| Term | Meaning | Defined in | Avoid |
|---|---|---|---|
| Turn | One run of the agent, from a message to `turn_complete` | `turn_complete`, `events.ts` | |
| Interruption | Why the last turn did not run to its end when nobody here chose to stop it: `network` (the model's API could not be reached), `quit` (Centralu quit or the computer restarted mid-turn), `interrupted` (the tool interrupted it), `reconnecting` (still working, but reconnecting for over 5 minutes). Independent of state; cleared when the session works again. The person's own Stop is not one (#698) | `SessionInfo.interruption`, `interruption` event; `sessions.interruption` (store v53); `sessions/interruptions.ts`; [agent-host.md](agent-host.md) §4.6.2 | stopped, stalled |
| Normalized event | What an adapter turns the tool's output into: deltas, tool calls and results, approvals, questions, state changes. The one stream the UI and the store read | `NormalizedEvent`, `packages/protocol/src/events.ts` | |
| Message | One stored row of a conversation, numbered (`seq`) within its session. Kinds: text, tool call, tool result, approval, marker, image, reasoning, app view | `StoredMessage`, `commands/sessions.ts` | |
| Tool call / tool result | The agent using a tool, and what came back. Paired by `callId`; drawn as one tool card | `tool_call`, `tool_result`, `events.ts` | |
| Subagent step | A step of a subagent the agent launched (Claude's Task). Hangs off the launching tool call, never part of the conversation's numbering. A session's steps can go to the trash without it (#418) | `subagent_event`, `events.ts`; `subagent_messages` (store v41, `trashed_at` v58) | |
| Approval | A pending yes/no on something the agent wants to do. At most one per session at a time | `pendingApproval`, `ApprovalDetail`, `entities/approvals.ts` | permission request |
| Approval detail | What is being asked: `command`, `file_edit`, `other` (from an adapter; the host's apply and handoff cards ride on it too, with an `about`), `capability`, `project_access`, `agent_start`, `centralu_update` and `project_create` (raised by the host) | `ApprovalDetail`, `entities/approvals.ts` | |
| Approval rule | A remembered "always allow" for commands, matched by a pattern with `*`, scoped to a session or a project (a session with no project keeps a project-scope answer for itself). Only allows are stored; the adapter checks them before it asks | `ApprovalRule`, `packages/core/src/approval/approval.ts`; `rulesFor`, `sessions/approval-rules.ts` | allowlist |
| Question | A choice the agent asks the person to make (AskUserQuestion), answered with `agents.answerQuestion`. Any number may wait | `Question`, `pendingQuestions`, `entities/sessions.ts` | prompt |
| Project consent | A remembered "always" letting one project reach another: `delegate` (`ask_project`) or `apps` (attach its shared apps); or, from a project to itself, `agents` (its sessions may start agents, #561) | `ProjectConsent`, `entities/approvals.ts`; `project_consents` (store v44) | |
| Read grant | A path inside the target project that a delegated answer named, readable by the caller while this host runs | `readGrants` (held by `manager.ts`, handed to `sessions/delegation-host.ts`), `readableGrants`, `ask-project.ts` | |
| Report mark | "You will be told when it ends": a session that owes a report of its work's end to the session that gave it work (`start_agent` past its wait, `send_to_session` with `reportBack`, `create_session`'s first message unless `reportBack` is false, #1233). One per session. A note into a turn already running never clears a mark, its sender's own included: without `reportBack` it leaves the marks as they are, with it it adds the sender's only where none stands (the answer says when another session is owed that turn's end). Only a new instruction to a session at rest without `reportBack` replaces the sender's earlier mark (#166). Cleared once reported; survives a host swap (#646). A turn that completes while background work the session started still runs **pauses** it (#721): the giver is told once that the work paused, and the report stays owed until a turn ends with none of that work left | `awaitingReport`, `pausedReports`, `sessions/child-ownership.ts`; `report_marks` (store v49), app setting `report_paused:<session>` | |
| Delegated turn | A turn another session's work started in a session (`ask_project`, `start_agent`, `agent_session` send, `send_to_session` to a session at rest, `create_session`'s first message, #1233). Its owner's further words are notes into it, with no busy answer. While it runs, its cards go to that session too: questions it may answer, approvals it is told of (#676). Ends with the turn; survives a host swap | `turnOwners`, `sessions/child-ownership.ts`; `delegated_turns` (store v51) | |
| Queued request | Work one session asked a busy session for and chose to queue (`ifBusy: "queue"`): delivered as a new turn the requester owns when the running one ends. Survives a host swap (#677) | `queued`, `sessions/child-ownership.ts`; `queued_requests` (store v52) | |
| Fork | A sub-session started from a copy of a busy session's conversation for another session's request (`ifBusy: "fork"`): linked to the requester, hung under the original in the sidebar (#677) | `SessionInfo.forkedFrom`; `sessions.forked_from_session_id` (store v52) | |
| Unread | Whether there is content past what the person last saw (`lastReadSeq`). Independent of state | `SessionInfo.lastReadSeq` | |

### 1.3 Apps

| Term | Meaning | Defined in | Avoid |
|---|---|---|---|
| App | A small MCP server with optional views, identified by (project, id). A person uses its views, agents call its tools: one call path | [apps.md](apps.md); `packages/agent-host/src/apps/external/runtime.ts` | plugin, extension, mod |
| Manifest | `centralu.app.json`, the file that makes a folder an app | `packages/agent-host/src/apps/external/manifest.ts` | |
| Root app | A project whose own folder has the manifest at its root: the project is the app. Key `<project id>/<manifest id>`; trust, sessions and state follow the project. Added and removed with the file (#1141) | `root` on `ExternalAppInfo`; `packages/agent-host/src/apps/external/discovery.ts`; [plans/root-apps.md](plans/root-apps.md) | app project |
| Project app | An app in `<project>/.centralu/apps/<id>/`, committed with the repository. Runs only in a trusted project. A root app is also its project's app | `packages/agent-host/src/apps/external/discovery.ts` | |
| User-folder app | An app in `<data>/apps/<id>/` (project null). Since #1141 each is registered as a project in place and becomes a root app; one stays a user-folder app only until that happens, or on a linked machine running an older build | `packages/agent-host/src/apps/external/discovery.ts` | global app |
| Shared app | A project app its project lets other projects' sessions attach | `app_shared:<project>/<app>` setting, `packages/agent-host/src/sessions/app-access.ts` | public |
| Attach | Giving a session an app's tools on demand (`find_apps`, `attach_app`, `detach_app`), beyond the ones it gets by default | `packages/agent-host/src/sessions/app-access.ts`, `session-apps.ts`; [apps.md](apps.md) §9.4 | install |
| App status | Derived each time, first match wins: `invalid`, `untrusted`, `unconfirmed`, `failed`, `running`, `starting`, `crashed`, `stopped` | `ExternalAppStatus`, `entities/apps.ts`; `ExternalApps.status`, `runtime.ts` | |
| Unconfirmed | An imported user-folder app the person has not enabled, or whose `server` or `uses` changed since. An import now lands as a root app, whose project's trust is its enabling | `packages/agent-host/src/apps/external/import-book.ts` | |
| View | An app's screen (an MCP Apps `ui://` resource). An open one is a **view instance** with its own id | `packages/agent-host/src/views/view-host.ts` | iframe |
| Inline view | A view opened under the tool card of the call that produced it | `app_view` event, `events.ts`; `packages/agent-host/src/inline-views.ts` | |
| Pinned view | The view the manifest's `home` tool opens in the app's screen (and reused by the project screen's panel) | `packages/agent-host/src/app-home-view.ts` | home page |
| App panel | An app placed on the grid, with its own view instance and a span | `GridPanel` (`kind: 'app'`), `GridSpan`, `entities/grid.ts`; `packages/core/src/grid/span.ts` | widget |
| Span | How many grid cells (columns × rows, 1–4 each) an app panel takes: the placement, then the person's setting, then the manifest's `view.span`, then 1 × 1 | `GridSpan`, `entities/grid.ts` | size |
| App run | One recorded call: an app tool called by a view, a session or another app (`kind: tool`), or the app asking Centralu for something (`kind: broker`). Chained by `parentRunId` | `AppRun`, `entities/apps.ts`; `packages/agent-host/src/apps/external/runs.ts` | invocation |
| Broker | The MCP server the host offers an app on fd 3: `run_agent`, `call_app`, `host_data` | `packages/agent-host/src/apps/external/broker.ts`, `desk.ts` | |
| Capability | What an app may ask the broker for: `agent:<tool>`, `app:<scope>/<id>`, `host:<name>`. Declared in the manifest's `uses`, granted by the person once per app | `packages/agent-host/src/apps/external/capabilities.ts`; `AppPermission`, `entities/apps.ts` | permission (that is an approval) |
| App secret | A value an app's manifest names; kept on this machine in `<data>/app-secrets.json`, never in the store | `packages/agent-host/src/apps/external/secrets.ts` | |
| App version | A kept copy of a user-folder app or of a root app outside git (5 kept), or the git history of a project app | `packages/agent-host/src/apps/external/versions.ts` | |
| App guide | Centralu's own user guide as a tool (`app_guide`), not a guide to one app | `packages/agent-host/src/sessions/app-guide.ts` | |

### 1.4 Screens

| Term | Meaning | Defined in |
|---|---|---|
| Focus view | The main layout: sidebar plus one session | product-spec §5.1 |
| Inbox | Everything waiting on the person, across projects, most urgent first: sessions, and the orchestrator's MCP-server and skill proposals not yet answered (listed and counted like an approval; they have no session, the jump goes to the orchestrator's screen where the card stands, #703); and an app a trusted project gained since the window last looked, said once (#1141) | `packages/ui/src/features/inbox/`; product-spec FR-15 |
| Grid | Several panels at once: sessions and apps | `packages/ui/src/features/grid/`; product-spec §5.4 |
| Project screen | A project's page: explicitly added session and app panels, plus git; starts empty | `packages/ui/src/features/project/`; product-spec §5.5 |
| Workspace | The UI's own state as one snapshot (layout, open sessions), saved on every change and restored at start | `Store.saveWorkspace`; [state-management.md](state-management.md) §5 |

### 1.5 Processes and builds

| Term | Meaning | Defined in | Avoid |
|---|---|---|---|
| Window | The Tauri shell (Rust) and the webview showing the React UI | `apps/desktop/src-tauri/`, `packages/ui/` | client |
| Host | The Node process that owns sessions, the store and apps. One per data folder (ownership lock) | `packages/agent-host/src/main.ts`; `dev-services/instance-lock.ts` | server, backend, sidecar (only the direct path is) |
| Store | The host's SQLite database, `<data>/store.db`; the only writer is the host | `packages/agent-host/src/dev-services/store.ts`; [generated/schema.md](generated/schema.md) | |
| Data folder | `~/.centralu` (`~/.centralu-dev` in development; `CC_DATA_DIR` overrides, also without `--db`; the legacy folder is moved only into the default one) | `packages/agent-host/src/data-dir.ts` (`chooseDataDir`) | |
| Keeper | Its own executable, `centralu-keeper`, shipped next to the window's and started detached from it (until 0.1.0-beta.11, the window's executable started as `centralu --keeper`, which since #461 refuses unless a debug window asked). Starts and supervises the host, holds its long-lived children, and owns the front door. macOS release builds; Linux and debug builds with `CC_USE_KEEPER=1` | `apps/desktop/src-tauri/keeper/` (crate `centralu-keeper-core`, no Tauri), started by `src-tauri/src/sidecar/`; [architecture.md](architecture.md) §4.1 | daemon |
| Front door | The keeper's one loopback port and token, relaying bytes to whichever host is current, so clients never see a host's own port | `apps/desktop/src-tauri/keeper/src/keeper/front_door.rs`; [architecture.md](architecture.md) §4.2 | proxy |
| Children service | The keeper's `<data>/children.sock`, through which the host asks the keeper to spawn and hold agent CLIs, terminals and command runs, so they outlive a host | `apps/desktop/src-tauri/keeper/src/keeper/children/`; `packages/agent-host/src/keeper/`; [architecture.md](architecture.md) §4.3 | |
| Per-build copy | `<data>/hosts/<build>/`: the copy of a build's host that a keeper runs, so a rebuild cannot mix two builds | `apps/desktop/src-tauri/keeper/src/keeper/source.rs` | |
| Swap | Replacing the running host with another build's, blue-green, behind the front door | `apps/desktop/src-tauri/keeper/src/keeper/swap.rs`; `packages/agent-host/src/swap-control.ts`, `drain.ts` | restart |
| Drain | What the outgoing host does in a swap: refuse new calls, give running ones 10 s, detach, release the lock, exit | `packages/agent-host/src/drain.ts` | |
| Detach / stop | The two ways a host can leave: **detach** leaves the keeper's children running for the next host; **stop** ends them | [architecture.md](architecture.md) §4.3 | |
| Keeper handoff | A keeper replacing itself with a newer keeper, passing every descriptor; nothing reconnects | `apps/desktop/src-tauri/keeper/src/keeper/handoff/`; [architecture.md](architecture.md) §4.4 | (not the session handoff, §1.1) |
| Codex bridge | A small Node MCP server that `codex app-server` starts for a session: one for Centralu's tools and one per attached app. It calls back into the host over the front door (or the host's own port without a keeper). Claude needs none: its servers run inside the host | `packages/agent-host/src/adapters/codex/orchestrator-bridge.mjs` | orchestrator bridge (it carries more) |
| `centralu serve` | The npm launcher running a host headless on `127.0.0.1:17175`, no window and no keeper, for remote mode phase 1 | `packaging/npm/centralu/bin/serve.mjs`; [agent-host.md](agent-host.md) §4.7 | |
| Stream epoch | A random id per host life. A client whose epoch differs after a reconnect resyncs instead of replaying | `packages/agent-host/src/transport/event-log.ts`; [protocol.md](protocol.md) | |
| Machine | A computer running its own host, linked to the others host to host (§6). Ids it hands over read `<machine>.<id>` | `MachineInfo`, `packages/protocol/src/machines.ts`; `packages/agent-host/src/links/`; [agent-host.md](agent-host.md) §4.8 | remote, server |
| Hub | The host a window is attached to, seen from the machines it links to: it routes the window's calls to them and mirrors what they last said | `packages/agent-host/src/links/router.ts`; [plans/remote-hub.md](plans/remote-hub.md) | |

### 1.6 Words that mean two things

| Word | The two meanings |
|---|---|
| Handoff | A session handing its work to a successor (§1.1); a keeper handing itself to a newer keeper (§1.5). Open views passed to the next host in a swap are the **view handover** |
| Manager | `SessionManager`, the host's class that runs every session; before #561 part 3 also the worktree manager, a role folded into ordinary sessions (a session now starts and owns its worktree agents) |
| Delegate | `DELEGATE_TOOLS` and the consent kind `delegate` are the **caller's** side of `ask_project`; the session doing the work is the delegated session |
| Capability | `AdapterCapabilities`: what an agent tool supports; an app's capability: what it may ask the broker for |
| Commands | Slash commands a tool offers (`agents.commands`); a project's saved commands (`projects.commands`), run as **command runs** in a pty |
| Sidecar | Only the host started directly by the Tauri shell; under a keeper the host is the keeper's child |
| Rail | The control rail is gone (#372); the evidence rail and the Settings rail are unrelated parts of the UI |
| `@cc`, `CC_*` | The package scope and environment prefix come from the project's earlier name; the product and data folder are Centralu's (`packages/protocol/src/brand.ts`) |

## 2. Entities and relationships

### 2.1 Projects and sessions

```mermaid
classDiagram
  direction LR
  class Project {
    path
    name
    trusted
    defaultTool, defaultModels
    commands
  }
  class Session {
    kind : worker | orchestrator | coordinator
    tool
    state : SessionState
    live
    permissionPreset : safe | normal | auto
    appId?
    parentSessionId?
    askedBy?
  }
  class Worktree {
    path
    branch
    base
  }
  class Orchestrator {
    <<kind>>
  }
  class Coordinator {
    <<kind>>
    scopeSessionIds
    roleAppend
  }
  class DelegatedSession {
    <<role>>
  }
  class StartedAgent {
    <<role>>
  }
  Project "0..1" o-- "*" Session : runs
  Session "1" --> "0..1" Worktree : works in
  Session <|-- Orchestrator : kind orchestrator, no project
  Session <|-- Coordinator : kind coordinator
  Session <|-- DelegatedSession : askedBy set
  Session "1" --> "*" StartedAgent : parentSessionId, a worktree child in the sidebar
  DelegatedSession "*" --> "1" Session : askedBy, in another project
  Session <|-- StartedAgent : askedBy set, same project
  StartedAgent "*" --> "1" Session : askedBy, start_agent
  Coordinator "*" --> "*" Session : may see
```

- A session belongs to **at most one** project. With no project: the orchestrator, a coordinator, the builder or
  app-agent session of a user-folder app (it stands under that app's row in the sidebar), and a session in the trash
  (its project is kept in the trash record). The inbox and the palette label every session with no project
  "Orchestrator".
- `kind` is all a session is created as. Every other role is read off a relationship each time: a builder is named in the builder map; an app-agent session
  carries an `appId` the builder map does not point back to; a started agent has `askedBy` naming a session of its
  own project. A delegated session is told by the delegated turn it is running, not by a stored relationship (#614). Moving a role into a
  stored flag was avoided on purpose, so the flag cannot drift from the relationship (#13, #80).
- The tool profile follows from these, first match wins: orchestrator, coordinator (`scoped`), builder, ordinary
  session in a project (`reader`, unless Settings turns it off), none (`toolProfileFor`).

Where it is stored:

- `projects`: projects, their trust, defaults, saved commands, worktree setup, and the worktree trunk (in the former manager slot's row, `worktree_manager`).
- `sessions`: sessions, including kind, worktree, parent, app, asked-by and trash marks.
- `command_cache`: the slash commands (skills) a tool offers in a folder, so a session that is not live can list them.

Live only (host memory): `live`, the pending approval and questions, goal, background tasks, agent version.

### 2.2 The conversation and decisions

```mermaid
classDiagram
  direction LR
  class Session
  class Project
  class Message {
    seq
    role : user | assistant | system
    kind
    payload
  }
  class SubagentStep {
    parentCallId
    seq
  }
  class PendingApproval {
    requestId
    detail : ApprovalDetail
  }
  class PendingQuestion {
    requestId
    questions
  }
  class ApprovalRule {
    scope : session | project
    matcher
  }
  class ProjectConsent {
    kind : delegate | apps
    decidedAt
  }
  Session "1" *-- "*" Message : conversation
  Message "1" *-- "*" SubagentStep : launch card
  Session "1" *-- "0..1" PendingApproval : while live
  Session "1" *-- "*" PendingQuestion : while live
  Session "1" o-- "*" ApprovalRule : session scope
  Project "1" o-- "*" ApprovalRule : project scope
  Project "1" --> "*" ProjectConsent : from
  ProjectConsent "*" --> "1" Project : to
```

- A pending approval or question lives in the host's memory while the session's process is alive. What was asked
  and how it was answered is also written into the conversation (message kind `approval`), so it survives.
  It closes when it is answered, when Stop refuses it, or when the agent withdraws it: Claude Code cancelling the
  permission request, Codex ending the request or the turn it was asked in, or the process going away.
- An approval rule only ever matches a `command`, and only "always allow" is stored. Answering "always" on a
  `project_access` card stores a project consent instead; a `capability` card is remembered per app either way
  (§2.3).
- A subagent's steps are stored apart from the conversation so a running subagent never moves the conversation's
  numbering (#222).

Where it is stored:

- `messages`: the conversation, one row per message.
- `messages_fts`: the full-text index over messages (trigram, for conversation search).
- `subagent_messages`: subagent steps, keyed by the tool call that launched them.
- `approval_rules`: "always allow" command rules.
- `project_consents`: one project's remembered consent to reach another.
- `report_marks`: the report a session owes the session that gave it work, until it is delivered.
- `agent_start_requests`: a start_agent card the person has not answered yet, so the next host raises it again (#673); or an allowed start waiting for memory (`allowed`), which the next host starts when memory recovers, without a card (#686).
- `delegated_turns`: the session that gave a session its running turn, and the cards it was told of, until the turn ends.
- `queued_requests`: a request held for a busy session, until it is delivered as a new turn.

### 2.3 Apps

```mermaid
classDiagram
  direction LR
  class Project
  class Session
  class App {
    projectId?
    appId
    status : AppStatus
    shared
  }
  class ViewInstance {
    instanceId
    uri : ui://
  }
  class InlineView {
    sessionId
    callId
  }
  class PinnedView
  class AppPanel {
    span
  }
  class AppRun {
    kind : tool | broker
    callerKind : view | session | app
    status
  }
  class AppPermission {
    capability
    decision : allow | deny
  }
  class Builder {
    <<role>>
  }
  class AppAgentSession {
    <<role>>
  }
  Project "0..1" o-- "*" App : project apps (inner or root), or user folder when null
  App "1" o-- "*" ViewInstance : open
  ViewInstance <|-- InlineView
  ViewInstance <|-- PinnedView
  ViewInstance <|-- AppPanel
  App "1" o-- "*" AppRun : run ledger
  AppRun "0..1" <-- "*" AppRun : parentRunId
  App "1" o-- "*" AppPermission : granted capabilities
  Session "*" --> "*" App : gets tools of
  Session <|-- Builder
  Session <|-- AppAgentSession
  Builder "0..1" --> "1" App : builds
  AppAgentSession "*" --> "1" App : started by run_agent
  AppRun "0..1" --> "0..1" AppAgentSession : run_agent stood up
```

Which apps a session gets (`givesApp`, `session-apps.ts`; `allowed`, `app-access.ts`):

| Session | Gets by default | May attach |
|---|---|---|
| Orchestrator | user-folder apps | the root apps of trusted projects (#1205: its tool list does not grow with every project that is an app) |
| Session in a trusted project (an untrusted project's apps attach nowhere, `auto` included) | that project's apps | user-folder apps and other trusted projects' root apps; another project's inner app if it is shared and the project consent (`apps`) is given |
| Builder | its own app, too | as above |
| App-agent session | none | none |

An app that is `invalid`, `untrusted`, `unconfirmed` or `failed` is given to nobody.

Where it is stored:

- `app_runs`: the run ledger; a `run_agent` row also keeps its request and answer (#378).
- `app_run_records`: the record of a deleted app-agent session in the trash (#378), with what the trash lists.
- `app_run_messages`: that record's copy of the session's whole conversation (#378).
- `app_run_subagent_messages`: that record's copy of the session's subagent steps (#378).
- `app_run_failures`: the raw arguments and result of an app's latest failed calls (20 kept), for its builder.
- `app_permissions`: a person's answer per app and capability, with the `uses` fingerprint it was given for.
- `app_settings`: host-owned settings as key and value; for apps the builder map (`apps.builders`), sharing
  (`app_shared:*`), on-demand attachments (`session_apps:*`), view ports, the view handover and the user-folder apps
  registered as projects (`apps.adoptedUserApps`). Also the store's own
  bookkeeping (`min_reader_version`, deferred migrations) and settings such as updates.

Outside the store: the app's code (its folder), data (`<data>/app-data/`), secrets (`<data>/app-secrets.json`),
import confirmations (`<data>/app-imports.json`), kept versions (`<data>/app-versions/`), logs (`<data>/app-logs/`).

### 2.4 Layout, history and usage

| Concept | Meaning |
|---|---|
| Grid layout | Which panels the grid shows, in order: a session or an app, with an app panel's span |
| Workspace snapshot | The UI's state as one blob, written by the UI, read back at start |
| Commit attribution | Which session made a commit, picked up from the agent's `git commit` output; kept only here, never in the repository (#50) |
| Usage facts | A table for tokens and cost per day, tool, model and project that **nothing reads or writes**: no build ever wrote a row, and releases up to v0.1.0-beta.10 only deleted a deleted project's rows. The usage people see is the account's limits, read live (`UsageSnapshot`, [agent-host.md](agent-host.md) §6) |

Where it is stored:

- `grid_layout`: the grid's panels (sessions and apps, store v42; spans v43; a linked machine's session in a column
  of its own, v46; a linked machine's app in columns of their own, v47).
- `grid_panels`: the grid of session panels as v9 made it, kept for hosts older than v42 (this build copies it once
  and afterwards only removes a trashed session's row); dropped in a later contract step
  ([agent-host.md](agent-host.md) §5.1).
- `workspace`: the UI's snapshot, one row.
- `commit_sessions`: commit attribution.

## 3. Session state

`packages/protocol/src/session-state.ts`, re-exported by `packages/core/src/session/state-machine.ts`. Every change of
state goes through this table; the UI never infers a state with its own conditions. The host keeps the same state for a
reconnecting window and the next host after a swap, and runs the same rules on its copy (`applySessionState`, which the
host's `applyStateHint` and the mock's list run), so a reconnect never hands back a state the window was not showing (#428).

```mermaid
stateDiagram-v2
  direction LR
  [*] --> idle
  idle --> working : output
  working --> waiting_approval : approval or question
  waiting_approval --> working : answered
  waiting_approval --> waiting_input : interrupted
  working --> waiting_input : turn_complete
  waiting_input --> working : next message
  working --> limited : limit_reached
  limited --> working : lifted
  working --> error : error
  error --> working : next message
  working --> idle : process ends
```

The diagram shows the usual moves; the table is the complete list (`ALLOWED`). Every state may also go to `error`
except `error` itself, and every state but `idle` may go to `idle` when the process ends.

| From | Allowed to |
|---|---|
| `idle` | `working`, `error` |
| `working` | `waiting_approval`, `waiting_input`, `limited`, `error`, `idle` |
| `waiting_approval` | `working`, `waiting_input`, `limited`, `error`, `idle` |
| `waiting_input` | `working`, `error`, `idle` |
| `limited` | `working`, `idle`, `error` |
| `error` | `working`, `idle` |

- `waiting_approval` covers both an approval and a question: both block the agent on the person. In a turn
  (`isInTurn`) means `working` or `waiting_approval`.
- `waiting_approval → limited`: a card the host raised between turns closes back into the rest it was raised in
  (`restAfterCard`, #673), and `limited` is one of them. Only that statement takes the edge: a `limit_reached` (Codex
  reports its limits at any time) records the limit but leaves a session on its card.
- A card an adapter raised while no turn ran closes back into the rest it was raised in too (`CardRests`,
  `agent-host/src/sessions/card-rest.ts`); inside a turn, answering the last card means working again. The rest is
  written to the `card_rests` app setting, so a card that stands through a host swap (the keeper keeps the process,
  the next host adopts it) still closes into it; a start that adopts nothing drops it. Input the host delivers counts
  as a turn asked for until the tool next moves the state, at most `ASK_WINDOW_MS`, so a tool that raises a card
  before announcing its turn keeps that card in the turn. Closing into a rest drains a request queued for the session
  (#677), as a turn's end does.
- A `tool_result` moves nothing: it closes a call and starts no turn. Results also arrive after a turn ended (a
  background agent released as its process closes), and read as work they left a session working with nothing to end
  it (#428).
- The host's own statements (a resume, a tool change, a failed re-attach, a card's rest) go out as `state_change` and
  are applied to its copy through the same rules (`settleState`), not written by hand.
- `waiting_input` means the turn ended. It counts as waiting (`isWaiting`), so it stands in the inbox, but its
  urgency is below `error` (`URGENCY`): an approval blocks the agent, a finished turn does not.
- An `approval_request` or `question_request` is applied in **any** state: it is a fact the host received, not an
  inference, and a table that swallowed one would leave the agent blocked unseen. Only inferred moves are checked
  against the table; an illegal one is ignored and logged.
- An `approval_resolved` or `question_resolved` means "answered" only in `waiting_approval`, and only when it closes
  the last open card: with another approval or question still open the session stays `waiting_approval` and keeps
  that card (the reducer). In any other state it moves nothing (`transition`), because the host releases requests
  late: a disposed handle resolves every request it still held, after the turn may already have ended.
- The last state is stored on the session row (`sessions.state`); whether a process is alive (`live`) is not.
- A state at rest does not say whether the turn finished: `error`, `idle` and `waiting_input` look the same after a
  network failure, a quit or an interrupt. That is the interruption's job, beside the state (#698). A start that resets
  `working` or `waiting_approval` to `idle` sets it to `quit` and writes a line in the conversation.

## 4. Process topology

Who starts whom, and who talks to whom over what. The parent/child edges are solid; connections are dashed.

### 4.1 With a keeper (macOS release builds; Linux or a debug build with `CC_USE_KEEPER=1`)

```mermaid
flowchart TD
  app["Window: Tauri shell<br/>(Centralu executable)"]
  web["Webview: React UI"]
  keeper["Keeper<br/>centralu-keeper, own session"]
  host["Host: system Node<br/>&lt;data&gt;/hosts/&lt;build&gt;/main.mjs"]
  claude["claude CLI"]
  codex["codex app-server"]
  bridge["Codex bridge (node)"]
  pty["Terminals, command runs<br/>(pty)"]
  appsrv["App MCP servers"]
  door(("Front door<br/>127.0.0.1:port"))

  app -- "launches detached (setsid)" --> keeper
  app --- web
  keeper -- "spawns, supervises<br/>stdin/stdout pipes, --watch-parent" --> host
  keeper -- "spawns and holds, own session each<br/>(asked over children.sock)" --> claude
  keeper -- "spawns and holds" --> codex
  keeper -- "spawns and holds, owns the pty" --> pty
  host -- "spawns: stdio MCP, broker on fd 3" --> appsrv
  codex -- "spawns: stdio MCP" --> bridge
  keeper --- door

  app -. "keeper.sock: attach, switch" .-> keeper
  web -. "WebSocket, app view HTTP" .-> door
  bridge -. "WebSocket" .-> door
  door -. "bytes relayed" .-> host
  host -. "children.sock: control + one stream per pipe" .-> keeper
```

- The keeper is an executable of its own beside the window's, launched detached so quitting the app sends it nothing. It
  starts the host from the per-build copy, with the front door's token on its stdin (#538), and swaps it blue-green.
  A host dies with its keeper (`--watch-parent` on the keeper's pipe).
- Agent CLIs, terminals and command runs are the **keeper's** children, spawned when the host asks over
  `children.sock`; their bytes reach the host through that socket. A host that restarts or is swapped re-attaches to
  them, so a running turn goes on.
- App MCP servers are the **host's** children and stop with it (owner decision 2, [architecture.md](architecture.md)
  §4.3). The next host starts them again when they are needed.
- Claude's Centralu tools and app proxies run **inside the host** (in-process SDK MCP servers), reached over the
  CLI's own stdio. Codex has no in-process servers, so it starts a bridge per session that calls back over the front
  door.
- App views are served by the host over HTTP through the front door. An app that asks for its own origin
  (`view.origin: app`) gets a port of its own on the host, outside the front door (`views/origin-ports.ts`).
- A keeper hands itself over to a newer keeper (§1.5) by passing every descriptor; the host and every child keep
  running and nothing reconnects.

### 4.2 Without a keeper (Windows, debug builds, `pnpm dev`, `centralu serve`)

```mermaid
flowchart TD
  app["Window: Tauri shell"]
  web["Webview or browser: React UI"]
  launcher["or: centralu serve launcher<br/>or: pnpm host"]
  host["Host: Node<br/>--watch-parent"]
  claude["claude CLI<br/>(spawned by the Agent SDK)"]
  codex["codex app-server"]
  bridge["Codex bridge (node)"]
  pty["Terminals, command runs<br/>(node-pty)"]
  appsrv["App MCP servers"]

  app -- "spawns, supervises" --> host
  launcher -- "spawns" --> host
  host -- "spawns" --> claude
  host -- "spawns" --> codex
  host -- "spawns, holds the pty master" --> pty
  host -- "spawns: stdio MCP, broker on fd 3" --> appsrv
  codex -- "spawns" --> bridge
  web -. "WebSocket to the host's own port" .-> host
  bridge -. "WebSocket" .-> host
```

- The Tauri shell is the host's parent (`sidecar/`, the same `host_proc` supervisor the keeper uses). In browser
  development (`pnpm host` and `pnpm dev`) the browser connects to the host directly with the token from the shell.
- Every child is the host's own, so a host restart ends them.
- `centralu serve` is this mode with no window at all, bound to loopback and reached over an SSH forward.

## 5. Main flows

### 5.1 A turn with an approval, answered "always for this project"

```mermaid
sequenceDiagram
  autonumber
  actor P as Person
  participant UI as Window
  participant M as Session manager
  participant A as Adapter
  participant CLI as Agent CLI
  participant S as Store
  P->>UI: types a message
  UI->>M: agents.send
  M->>S: user message
  M->>A: send
  A->>CLI: the turn
  CLI-->>A: events (deltas, tool calls)
  A-->>M: normalized events, state working
  M->>S: messages
  M-->>UI: events
  CLI->>A: wants to run a command
  A->>A: matches a remembered rule?
  alt rule allows
    A-->>CLI: allow
  else needs a person
    A-->>M: approval_request
    M->>S: approval message
    M-->>UI: approval_request, state waiting_approval
    UI->>P: card, sound, inbox
    P->>UI: Always, this project
    UI->>M: agents.respondApproval(always, project, matcher)
    M->>A: respond
    A-->>CLI: allow
    A-->>M: approval_resolved, state working
    M->>S: approval rule (only once the answer landed)
  end
  CLI-->>A: result
  A-->>M: turn_complete, state waiting_input
```

The rule is stored only after the adapter confirms the answer landed: an answer to a request that is already gone
(the process was replaced) removes the card and stores nothing.

### 5.2 Delegation to another project (`ask_project`)

```mermaid
sequenceDiagram
  autonumber
  participant C as Session in project A
  participant M as Session manager
  actor P as Person
  participant D as Existing session in project B
  C->>M: ask_project(B, session?, task)
  M->>M: B is another registered project, and C is not itself working on another project's task
  M->>M: consent A to B, kind delegate?
  alt not given yet
    M-->>P: project_access card in C's session, naming D and B's trust
    P-->>M: allow once, or always (stored), or deny
  end
  M->>M: the ordinary session of B that C named, or B's only one; never a new one (#614)
  alt D is in a turn that is not C's
    M-->>C: the choices (note for an auto caller, or queue), and nothing is sent
  end
  M->>D: task in a frame, sent as from C
  D-->>P: its own approvals stand in D, where the person sees them
  alt within 240 s
    D-->>M: turn_complete
    M-->>C: final answer, plus read grants for B's paths it named
  else longer
    M-->>C: "still working" with D's name, and a call with no task waits again
  end
```

At the default agent depth of 1 (a setting, up to 3, that no preset crosses, #867), a session working on another project's task cannot ask a third project. A session in a turn that is
not the caller's gets nothing sent; the caller gets the choices instead ([agent-host.md](agent-host.md) §1.2.3). A new
task cannot replace unfinished work in the same session. Read grants live in the host's memory and end with it. Stopping the caller stops the delegated turn.
Detail: [agent-host.md](agent-host.md) §1.2.

### 5.3 An app calling `run_agent`

```mermaid
sequenceDiagram
  autonumber
  participant V as Caller (view, session or app)
  participant R as App runtime
  participant App as App process
  participant B as Broker (fd 3)
  actor P as Person
  participant M as Session manager
  participant AG as App-agent session
  V->>R: call app tool (run row opened)
  R->>App: tools/call with the run id
  App->>B: run_agent(prompt)
  B->>B: open run id? declared in uses.agent? limits (one at a time, 5 a minute)
  alt first use of agent capability
    B-->>P: capability card (in the calling session, or on the pinned view)
    P-->>B: allow or deny, remembered for this app
  end
  B->>M: runAppAgent
  M->>AG: new session, appId set, safe preset, prompt
  AG-->>M: turn_complete
  M-->>B: final answer (validated against a schema if given)
  B->>B: run row closed (request, answer)
  B->>M: agentRunEnded
  opt ok, and nobody took part
    M->>M: keep the record (app_run_records), session to the trash and deleted
  end
  B-->>App: result
  App-->>R: tool result
  R-->>V: result, run row closed
```

Each `run_agent` stands up a new session; nothing is reused. The broker's request gets its own run row under the
tool call's (`parentRunId`), linked to the session it stood up. A clean run takes its session with it before the app
has its answer (#378); the record of what it did stays in the trash.

### 5.4 Switching builds (blue-green swap, with a keeper)

```mermaid
sequenceDiagram
  autonumber
  participant W as Window (build B)
  participant K as Keeper
  participant HA as Host A
  participant HB as Host B
  participant C as Agents, terminals, commands
  W->>K: switch to build B (keeper.sock)
  opt keeper is another build
    K->>K: hand over to build B's keeper, which continues
  end
  K->>K: copy build B to hosts/B
  K->>HB: start --standby
  HB->>HB: load, read the store without writing, refuse one too new
  HB-->>K: standby report (no lock, no listen, no attach)
  K->>K: front door holds new connections
  K->>HA: drain
  HA->>HA: refuse new calls, running ones get 10 s, then cut retryably
  HA->>HA: detach agents, terminals, commands, stop app servers, write the view handover, close the store
  HA-->>K: drained, lock released, exits
  K->>K: close connections still relayed to A
  K->>HB: activate
  HB->>HB: take the lock, expand-only migrations
  HB->>C: re-attach terminals and command runs
  HB-->>K: ready (listening)
  K->>K: front door points at B
  HB->>C: re-attach agents
  W->>K: reconnect, same address and token
  K-->>HB: bytes relayed
  HB-->>W: hello_ok, new stream epoch, window resyncs
  HB->>HB: heavy and breaking migrations, after ready
```

If B fails after A drained, the keeper starts A's build again from its kept copy. Every phase is pushed to windows
(`view.swap`). Detail: [architecture.md](architecture.md) §4.2, [agent-host.md](agent-host.md) §4.2.

## 6. Machines

Remote mode as linked hosts ([plans/remote-hub.md](plans/remote-hub.md), phase 1) adds a **Machine**: a computer
running its own host with its own store, agents and sign-ins. The host a window is attached to is the **hub** for it:
the person links other machines to it, each reached over the person's own ssh, and the hub shows their sessions and
projects next to its own. Hosts talk only to hosts; each machine stays the one writer of its own store.

```mermaid
classDiagram
  class Hub["Hub (host)"]
  class Machine {
    id, name
    ssh target, shell
    status
  }
  class Header["Mirrored header"]
  Hub "1" o-- "*" Machine : links
  Machine "1" *-- "*" Header : last listed sessions and projects
  Machine "1" o-- "*" Session : runs, on its own host
```

- A machine's sessions, projects and terminals keep their ids on their own host; the hub qualifies them as
  `<machine>.<id>` and every row carries an explicit `machine` field, so the UI never parses an id. An approval rule
  id from a machine is folded into a negative number per machine (its `slot`).
- What the hub last heard from a machine is mirrored, so a machine that is away still lists its sessions (marked
  unreachable, last-known `live`, never woken). The remote's orchestrator and coordinators are not shown.
- The link's state (`connecting`, `connected`, `unreachable`, `versions_differ`, ...) is live only and sent as
  `machine_status`; a (re)connect says `machine_resync`. Detail: [agent-host.md](agent-host.md) §4.8,
  [protocol.md](protocol.md) §6.

Where it is stored:

- `linked_machines`: the machines the person linked: id, name, ssh target, remote shell, the slot for folding
  numbers, the version pair accepted (store v46), and whether that machine's sessions may ask this computer's projects
  (`asks`, off by default, store v60, #550).
- `machine_headers`: the mirror: each machine's sessions and projects as it last listed them (store v46).
- `machine_ask_consents`: the pairs the person approved for the reverse direction: a session of a linked machine and a
  project of this computer, so later asks in that pair need no card until withdrawn (store v60, #550). Removed with the
  machine, with the project, and when the machine's switch goes off.

Live only (hub memory): each link's status, its ssh processes and forward, the remote's cursor and epoch. Not stored
anywhere: the remote host's token, asked over ssh at every link start.
