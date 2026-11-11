# The broker, RPCs and events

## The broker: agents, other apps, host data

An app asks for things outside itself (run the person's agent, call another app, read host data)
through a **broker**. The host starts every app with a fourth pipe, fd 3. On it the host is an MCP
server and the app its client. Only the process holding the pipe can call, so there is no token,
and the pipe says which app is calling (spike S-5).

On Windows fd 3 is created `overlapped` (#14). A plain pipe reaches the child as a synchronous
handle, and Windows serialises I/O on one: the app's read waiting on fd 3 held back its own write
of the request, so every broker call timed out on the first Windows test run. stdin and stdout go
one way each and are unaffected.

A request passes, in order: the gate (run id), the manifest's declaration, the person's permission,
the runaway limits, then the work, and it leaves a run record however it ends. All of it after the
gate happens in one place, the broker desk (`desk.ts`).

- **Admission by run id.** Every call the host sends an app carries `_meta["centralu/runId"]`. A
  broker call must carry the run id of a call **that app is handling now, on that same pipe**. A call
  without a run id (an app waking up by itself, out of scope), with an invented id, with a finished
  run's id or another app's id is refused, and the refusal goes to the app's log and its runs.
- **`busy { busy, reason? }`, the one request without a run id (#1236).** The app tells the host
  about itself (busy with background work, or no longer), so it asks for nothing outside the app and
  reaches only its own lifecycle ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#lifecycle), its "Busy" row). Refused unless the manifest declares
  `uses.background`; a refusal goes to the app's log. Not a run: it leaves no run record. The
  template's `centralu.busy(reason)` sends only changes, in order, and resolves false (said once on
  stderr) when Centralu did not take it.
- **`notify { to, text }`, the other request without a run id (#1161 item 1).** A notice into a
  session that called the app, posted later from a timer or a queue: "merged #77", "#78 needs
  attention". With `uses.notices: true`, every call a session's chain started carries that session's
  address in `_meta["centralu/notice"]` (`centralu.noticeAddress()` in a tool handler). The address is
  the session id with a MAC over (app, session) under a key in the data folder (`app-notice.key`,
  0600; `notices.ts`): the app can name only sessions that called it, never one it read from a list,
  another app's address does not open for it, and it still opens after the host restarts. The session
  receives it as a report arrives: recorded as the app's message, handed to the agent in the app-text
  frame (`appMessageFrame` `notice`: every line quoted, "the person did not write or read it"), and
  an idle or asleep session wakes. Refused, with a reason the app reads, when undeclared, for an
  address it was not given, when empty or over 4000 characters, past 10 a minute, while the host
  hands over or quits (the app tries again), and once the session is gone. Every notice is a run
  record with no parent, its session and text in the arguments, delivered or refused, so the Runs
  panel shows what the app told which session. `centralu.notify(address, text)` resolves true once
  delivered.
- **Declared in `uses`.** The manifest says what the app may ask for: `"agent": true` (the person's
  default agent) or a list of tools (`["codex"]`), `"apps": [ids]`, `"host": [names]`. Anything
  undeclared is refused before anything runs. Declaring is not permission.
- **`run_agent { prompt, tool?, schema? }`.** Each request starts a new, visible session under the
  app: a project app's in its project (working folder: the project root), a user-folder app's like
  a coordinator (no project, the Assistant's empty folder). The preset is `auto`, the default
  every new session gets, never above the lowest preset among the sessions with a call open into
  the app now, whatever run id the app cites: while a `safe` session's call is open (directly, through
  `call_app`, or from a view inline in its conversation) every agent the app starts is `safe`. Only a
  view opened in the window, with no session's call open, gives `auto`; a chain that can no longer be
  followed gives `safe` (owner decision 2026-11-05; it was always `safe`, so writes and commands
  stopped at an approval card). Nothing it does waits for the
  person, though its text is the app's; the person may lower its preset in the session. Settings files: a project app's agent follows the
  project's trust like a worker; a user-folder app's agent reads only the person's own settings,
  never the Assistant folder's files. The tool is `tool` if declared, else the default (the
  project's default tool; for a user-folder app, the Assistant's). A tool that is not installed
  or not logged in is refused before a session is created, in the tool's words. The prompt reaches
  the agent framed as the app's text (security-boundaries/untrusted-text.md "Text an app sends"). The request
  waits for the turn and returns the final answer: the agent's text after its last tool call. With
  `schema` (a JSON Schema whose top level is an object), Claude receives it as `outputFormat` when
  the query starts and Codex as the turn's `outputSchema`; the host validates the answer against
  the same schema and returns it as `structuredContent`. A finished session is left `idle`, so it
  does not wait in the inbox; an agent session gets no apps. **Once the run ends cleanly it is
  deleted (#378)** and its record kept in the session archive ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#run-records)): an app that calls `run_agent` a few dozen
  times a day filled the sidebar with sessions nobody would talk to. It stays in the list, as before,
  when the run failed, was stopped or cancelled (the person needs to see what went wrong, a schema
  mismatch included), when a card was shown during it (the person took part), when the person
  opened it (its pane shown, with nothing unread too) or wrote to it from the run until the delete is
  final, its process's close included (it has become theirs), when it woke again, is waking or
  restarting, or holds something sent to it, or when it has attachments (the record copies no
  files). The delete is decided at the moment the session leaves the lists, with nothing awaited
  after, so a message sent meanwhile either keeps the session or is told the session is gone; a
  waking session is never deleted by withdrawing its wake. A delete the person asks for while the
  host's is under way is theirs: the session stays in the session archive, its conversation file too unless
  they chose otherwise. A draft the person had written in a session that goes is kept on screen, to
  be copied. While it runs it is visible as any
  session: its approval cards appear there. The app has its answer once the session is gone, so a
  screen that reads `sessions.list` after its call sees it as it stays.
- **`call_app { app, tool, args }`.** Only apps listed in `uses.apps` and only their `model` tools,
  through `ExternalApps.call` with caller `app` and the parent run id ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#one-call-path)): visibility, trust, the
  record, the change notification (the cause is the asking run) and cancellation are the same as
  for any other caller. A project app reaches its own project's app of that id first, then the user
  folder's, then the root app of that id (#1141) when exactly one trusted project is an app of that id; a
  user-folder app or a root app reaches the user folder's, then that root app. Another project's inner
  app is never reached.
- **`host_data { name }`.** A closed list, read-only, deny by default: `sessions.list` (the names
  shown in the sidebar and each session's kind, tool, state and times, never the conversations; the
  project's sessions for a project app, a root app included as its permission card says (#1141), every session for a user-folder app; never those in the session archive, FR-22) and `git.status` (the
  project's branch and changed files; project apps only). Only names declared in `uses.host`.
- **Asked once.** The first time an app uses a capability (an agent tool, another app, a host name),
  the person is asked where the chain started: on the approval card of the session whose agent
  started it, or on the app's pinned view (with a mark on its sidebar row) when a view started it.
  The answer, allow or deny, is kept per app and capability in the store, used until the manifest's
  `uses` changes, and listed in the Runs panel, where it can be forgotten. While the person decides
  (up to 5 minutes; no answer is a refusal that is not remembered), the request is kept alive with a
  progress notification every 10 s.
- **Runaway limits.** A chain holds at most 3 app calls (the view's or session's app is the first),
  and the same app tool cannot be called again inside its own chain; both are checked before the
  person is asked. An app runs one agent at a time (a second request is refused, not queued) and at
  most 5 a minute.
- **Records and cancellation.** Every request is a run record (kind `broker`) under the run that
  caused it, however it ends: done, failed (with its input kept like other failures), refused,
  cancelled. Requests the gate did not admit are recorded with no parent: the id they presented
  could belong to another app's chain. A `call_app` that reaches the other app is recorded by that
  app's own row. A request is cancelled when the app cancels it or when the call it serves ends or is
  cancelled, even if the app never passes the signal on; a cancelled `run_agent` interrupts its
  session.
- **Template helpers.** `centralu.agent(prompt, { schema, tool })`, `centralu.callApp(app, tool,
  args)` and `centralu.host(name)` carry the current run id for the author (AsyncLocalStorage), so a
  tool handler asks in one line. They pass the broker's progress up to the call they serve, so a long
  agent run does not time it out, and give up only when Centralu says nothing for 60 s or the request
  runs past 60 minutes. Outside a tool handler, or with no fd 3, they throw an error that says why.
  A progress message the broker sends ("waiting for the person to allow …", "waiting for the person
  to approve a step in …") travels up with it: when a session's agent made the call, the host shows
  the message as live output under that call's tool card (Claude and Codex alike). A view's own call
  does not get the message yet; its keep-alive ([attaching.md](attaching.md#long-calls-and-cancellation)) is unchanged.

## RPCs and events

The schemas are in `packages/protocol/src/commands/methods/apps.ts` (the `apps.*` methods), `entities/apps.ts` and `events.ts`.

| RPC | What |
|---|---|
| `apps.list` | Every discovered app, with status and reason |
| `apps.invoke` | A view's tool call (`projectId` absent or null means a user-folder app) |
| `apps.viewFrame`, `apps.readResource` | The frame address of a view instance; a resource of the frame's own app |
| `apps.viewDocument` | An open instance's app, origin method and raw document, for a hub that serves this host's view in its own window (#82, [plans/remote-hub.md](../plans/remote-hub.md) §11) |
| `apps.openView`, `apps.recoverView`, `apps.closeView`, `apps.holdViews` | Open a pinned view (calls `home`; a client `openKey` shares/reclaims one instance and its original outcome across a planned host swap; recovery queries that key and never calls home again, even when a crash lost the reservation; `machine` names a linked machine's user-folder app); close any view instance; claim a window's pinned views after a reconnect. A view of this host opened with `lease` belongs to the window's connection: once that ends, the host waits five minutes for a claim and then closes it, so a reloaded or closed window does not hold its apps open for good (#392). A linked machine's view is opened without one |
| `apps.inlineViews`, `apps.inlineReopen`, `apps.viewMessage` | The inline views a conversation still holds; reopen one without calling again; deliver a view's message once the person agreed (an inline view's to its conversation, a pinned view's to the session picked) |
| `apps.runs`, `apps.errors` | Run records with their chains; the latest error bundles |
| `apps.reach` | Whether a session can use one app's tools now, and if not why ([view-theme-layout-drag.md](view-theme-layout-drag.md#dragging-an-item-out-of-a-view-308)) |
| `apps.questions`, `apps.answerQuestion` | Capability questions waiting on a pinned view (chains a view started); answer one |
| `apps.permissions`, `apps.forgetPermission` | The answers kept for one app; forget one |
| `apps.usage` | One app's agent use over the last day and 30 days |
| `apps.restart`, `apps.remove` | Clear a stopped app's failures and stop it (the next need starts it; a view's Stop for a busy app, [trust-lifecycle-calls.md](trust-lifecycle-calls.md#lifecycle)); remove a user-folder app |
| `apps.create`, `apps.builder`, `apps.createBuilder`, `apps.check`, `apps.askBuilder`, `apps.sendError` | The build loop ([build-loop.md](build-loop.md)) |
| `apps.setSecret` | Set, replace or clear one declared secret ([what-an-app-is.md](what-an-app-is.md#where-apps-live)); the value is never returned |
| `apps.setShared` | Share a project app with the person's other projects, or stop ([other-projects-apps.md](other-projects-apps.md)) |
| `apps.importPrepare`, `apps.importCommit`, `apps.importCancel` | Stage an import and return the review; bring it in, turned off or enabled with the review's key; drop the staging ([handing-over.md](handing-over.md)) |
| `apps.review`, `apps.enable` | The review of an imported app waiting for the person; enable it with that review's key ([handing-over.md](handing-over.md)) |
| `apps.versions`, `apps.restoreVersion` | Kept versions of a user-folder app, or the git commits that touched a project app; restore a kept version ([handing-over.md](handing-over.md)) |
| `apps.sessionTools`, `apps.sessionCall` | Used by the Codex bridge |
| `projects.setTrusted` | Trust ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#trust)) |

Events: `external_apps_changed` (the list or an app's status changed: read `apps.list` again),
`external_app_state_changed` ([views.md](views.md#keeping-open-views-current-centralu-extension)), `external_app_runs_changed` (a row this app's Runs panel shows
began or ended: read `apps.runs` again, [trust-lifecycle-calls.md](trust-lifecycle-calls.md#run-records)), `external_app_questions_changed` (a capability question
opened or closed: read `apps.questions` again), and `app_view` (an inline view opened, got its
result, was cancelled, closed or refused; stored without bodies, so a reopened UI can draw
placeholders). A capability question a session's chain raised is that session's
`approval_request` with `detail.kind: "capability"`.
