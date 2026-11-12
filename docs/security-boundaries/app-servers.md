# App servers

An app's server is code running as the user, with the user's files, network and processes. The
sandbox described under "App views" covers only its screens, and there is no process sandbox for
the server (out of scope for M4). So for a server the boundary is **whether it runs at all**, and
then who may call it:

- A project's apps start only in a trusted project (previous section). A cloned repository's
  `.centralu/apps/` does nothing until the user trusts the project, and an app that arrives later
  with `git pull` is governed by that same trust: there is no second gate for it. User-folder apps,
  approved MCP servers included, are trusted because the user put them there. An app **imported**
  into the user folder from elsewhere is not: see [imported-apps.md](imported-apps.md).
- The host withholds its own environment: every `CC_*` and `CENTRALU_*` variable is removed (the
  WebSocket token is one; with it an app could call every RPC). The app receives its declared
  secrets, `CENTRALU_APP_ID` and `CENTRALU_APP_DATA` (`app-start-env.ts` `spawnSpec`; test "receives its
  data folder (created for it) and only its declared secrets, never the host's own variables").
- Secret values live in `app-secrets.json` (0600) and are replaced by their names in the app's log,
  run records (arguments, errors, kept failures), error bundles and the text of a failed start, which the list, a check
  and a caller's refusal carry, and the app's own error text a check report or a failed resource read quotes (`#1142`:
  `app-check.ts`, `app-resources.ts` `maskedError`; tests "a check report quotes …", "a resource read that fails …") (`secrets.ts` `redactor`, `app-process.ts` `AppLog` and `AppProcess.start`; tests "stderr
  goes to the app's own log, with secret values masked by name", "an app that fails to start with the value in its
  error leaves only the name in the list, the bundles, the check and the refusal"). Each value is also replaced in its JSON-escaped form (#838), since run records keep
  arguments as JSON, where a multi-line key or one with quotes is spelled differently, and each line of a
  multi-line value of 16 characters or more on its own, since the app's log is masked a line at a time. A run record's
  arguments and kept result are masked string by string before they become JSON, then as JSON (`runs.ts`
  `maskedJson`): a value holding the secret already JSON-escaped (JSON passed as text) was escaped a second time,
  a spelling neither form matched (`redactor.test.ts`). Arguments are hashed only after redaction. The person enters values through
  `apps.setSecret`, which accepts only names the manifest declares and never returns a value: the
  app list carries only whether each declared name is set, and refusals never quote the value. A
  test looks for the value, as a string, in the app log, run records, kept failures, error bundles,
  the list, broadcasts, the host console and the RPC replies, with an app that leaks it on purpose
  (`app-secrets.test.ts` "even when the app leaks the value into stderr, a failure message, or an
  argument, only the name remains in the log, run record, error bundles, list, broadcasts,
  console, and RPC answer"). In the UI the field is a
  password field that is emptied once sent (`e2e/app-share.spec.ts`).
- Every call goes through the host, which enforces tool visibility in both directions: views reach
  only `app` tools, agents only `model` tools, and a refused call never reaches the app
  (`runtime.ts` `call`; `mediation.test.ts` "a screen cannot call a model-only tool, and a session
  cannot call an app-only tool — the call never even reaches the app"; with third-party apps,
  `e2e/public-apps.spec.ts`). The
  session side re-checks decision 4 at every call, so a detached app cannot be reached by a stale
  tool name.
- A session reaches its apps through one Centralu tool, `app` (#2231, [apps/attaching.md](../apps/attaching.md#apps-through-one-centralu-tool-2231)),
  never through an MCP server of the app's: the CLI sees no app tool, so no rule or mode of the CLI's decides one. The
  host decides at the call, with the call's arguments: `list` only reads and never asks; `call` checks the arguments
  against the tool's schema, then runs a tool that only reads (or is declared `local`, or `routine` in the session's
  own project) unasked, and otherwise asks per the session's preset (`safe` always; `normal` and `edits` unless the
  person's own CLI setting bypasses approvals; `auto` never) with the host's card (`Attachment.approve`,
  `sessions/session-apps.ts`; the rows in [approvals.md](approvals.md)). **ACP agents get apps** with this change, a
  trust change: until #2231 an ACP session had none (`appAttachment` answered `failed`). They get the same host gate
  and the same presets as Claude and Codex, through the same bridge credential as Centralu's other tools (it names the
  session, and the host counts that session's apps). An ACP agent's own permission requests
  (`session/request_permission`) cover its own tools only, and its adapter reads no bypass of the person's
  (`bypassesApprovals` absent), so under `normal` and `edits` every app tool that does not only read asks. The request
  gate (`whenAsked`, #1447) applies to an app call as to any step when the session is the Assistant in a turn another
  session's request started, whatever its CLI (`bridge-apps.test.ts` "under normal, its write raises the host card and
  runs only on Allow; a Deny runs nothing"). Its Stop cancels the session's app calls and withdraws a card standing for
  one, with or without a turn running, and closing the session closes its apps, as on Claude and Codex
  (`acp/session.test.ts` "the Stop cancels the session's app calls…").
- A project's session reaches another project's app only by attaching it (#371 part A, apps/other-projects-apps.md),
  and only when three things hold, each read again at every count of the session's apps and
  so at every call: the person shares that app (off by default, per app), the person allowed this
  pair of projects (a consent card in the calling session; "always" kept per pair and revocable in
  Settings, "once" for that attachment, a denial not kept), and both projects are trusted. A session
  in an untrusted project attaches nothing, so a planted AGENTS.md cannot pull another project's
  tools into it. User-folder apps attach without a card, as they are the person's own, and so does
  another trusted project's root app (#1141), which its project's trust covers (the trust card lists
  each app with what it declares it may ask for, and the inbox says once when a trusted project gains
  one); that does not widen what the session could already run, since the calls follow the session's
  preset. An untrusted project's apps attach to no session, under any preset. The app
  still runs in its own folder with its own data, and its calls are recorded with the calling
  session (`app-access.test.ts`, `app-access-manager.test.ts`).
- The broker pipe (fd 3) is handed only to that process, so there is no token to steal. A broker
  call must carry the run id of a call the same app is handling on the same pipe; no id, an
  invented id, a finished run's id and another app's live id are all refused, logged and recorded
  without a parent, so an app cannot put rows into another app's chain (`broker.ts`;
  `mediation.test.ts` "a broker call with no run id is refused (an app waking itself up on its
  own)", "a made-up id, a finished run's id, and another app's live id are all refused";
  `broker-records.test.ts`). Broker work is
  cancelled with the call it serves, down to an agent session it started. The one exception is
  `busy` (#1236): an app says it is busy with background work, or no longer, without a run id. It
  asks for nothing outside the app: it only keeps the app's own process from the idle rule, and only
  when the manifest declares `uses.background` (in `uses`, so an imported app adding it is reviewed
  again and the trust card lists it). The hold shows on the app's sidebar row as its Stop icon button,
  whose tooltip and label carry the reason ("Running: <reason>. Stop it; …"; the row writes no busy
  text, #1928). It ends with the process, and the person stops it from that button, its row in Settings or its view
  (`app-lifecycle.ts` `setBusy`; `busy.test.ts`, `e2e/apps.spec.ts`). A host that starts again
  starts the apps that held busy when the last one stopped (`app-busy.json`), but only one still
  allowed to run (trusted, enabled, not failed) and still declaring `uses.background`; the person's
  Stop and a crash remove its record (`busy-book.ts`, `ExternalApps.resumeBusy`).
  The other is `notify` (#1161 item 1): an app that declares `uses.notices` posts a
  notice into a session that called it, from a timer, without a run id. It can reach only those
  sessions: a call a session's chain started carries an address for that session, the session id
  with a MAC over (app, session) under a key kept in the data folder (0600), so a session id read
  from `sessions.list`, another app's address or a made-up one opens nothing. The text reaches the
  agent in the app-text frame, every line quoted ("Text an app sends"); at most 10 a minute and 4000
  characters each; every notice, delivered or refused, is a run record naming the session
  (`notices.ts`, `desk.ts` `notice`; `notices.test.ts`, `app-notice.test.ts`).
- What an app may ask the broker for is declared in its manifest's `uses`, and the person allows
  each capability once (an agent tool, another app, a host data name), asked where the chain
  started; the answer is kept until `uses` changes and can be forgotten. Undeclared or unanswered
  requests never run (`desk.ts`; `capabilities.test.ts`, `app-capabilities.test.ts`,
  `host-data.test.ts`, `call-app.test.ts`).
- An agent an app asks for runs in a new session the person can see, under `auto`, the default
  every new session gets, never above any session with a call open into the app (owner decision
  2026-11-05; it was `safe`; the rule and its residual under "An agent an app started" in [approvals.md](approvals.md)), with no apps attached, and receives the prompt framed as the app's text ("Text an app
  sends"; `app-agents.test.ts` "the agent stands up under auto, the default every new session gets
  (owner decision 2026-11-05), the app's text is framed as the app's text, and the session that
  hands back an answer goes idle"). Its text may carry what the app fetched from elsewhere, and
  under `auto` nothing it does waits for the person (the residual under "An agent an app started" in [approvals.md](approvals.md)). Its settings files
  follow the project's trust like a worker's; a user-folder app's agent, which runs in the
  Assistant's folder, reads only the person's own settings, never that folder's files
  (`settingFilesFor`; `setting-files.test.ts`).
- Runaway limits: a chain holds at most 3 app calls and never calls the same app tool again on its
  own path, and an app runs one agent at a time and at most 5 a minute. Every request, refusals
  included, is a run record under the call that caused it (`limits.test.ts`,
  `broker-records.test.ts`, `app-chain.test.ts`).
- Stopping an app closes stdin and fd 3 together. An app still running after the grace has its
  whole process tree ended, SIGTERM then SIGKILL, descendants that outlive their parent included
  (`app-process.ts` `stop`, `kill-tree.ts`, #149). An app that exits by itself has its own process
  group ended the same way, SIGTERM then SIGKILL after the grace (`stopGroup`), and disposing the
  runtime stops every process it started, including ones a restart replaced
  (`lifecycle.test.ts`).

Limits:

- Nothing confines what a running app server does with the user's privileges. Trust is a decision
  about code, not a sandbox.
- A session that called an app with `uses.notices` once can be told by it for as long as the session
  exists: an address does not expire, and nothing but the rate limit bounds how often the app speaks.
  The text is the app's, framed as such, and grants nothing; the person reads it in the conversation.
- An app that declares `uses.background` decides when it is busy: one that never releases keeps
  running until the person stops it or Centralu quits. The row shows the hold the whole time; nothing
  limits how long it lasts.
- The data folder is outside the repository so that runtime files are never committed. It is not
  an isolation boundary between apps: they all run as the same user.
- Redaction is literal string replacement. Values shorter than 4 characters, and values the app
  transforms (encodes, splits), are not caught. Neither are JSON spellings other than the raw value, its
  `JSON.stringify` form and one more level of escaping: a value escaped with `\uXXXX` where JSON.stringify writes
  the character itself (.NET writes `+` as `+`), or JSON nested two levels deep in text, keeps the secret in a
  run record.
- Visibility decides who may call a tool, not what the tool does.
- Sharing an app and allowing a pair of projects are about which sessions may call it, not what it
  does with what they send: an attached app receives whatever the calling session's agent passes it,
  which can include that project's files or conversation. "Always for this pair" covers every app
  the other project shares, including ones shared later.
- A permission is per capability, not per request: once an app may run an agent, the app decides
  what to ask it. The agent runs under `auto` held to every session with a call open into the app (owner decision
  2026-11-05; its writes and commands stopped at an approval card under `safe` before), and what it may read is whatever its session can read.
- `sessions.list` gives session names, and an automatically named session is named after the first
  words of its first message. It never lists a session in the session archive (FR-22), and no app capability or
  agent tool restores or deletes one for good — only the person, in Settings.
- fd 3 on Windows is an overlapped pipe (apps/broker-and-rpcs.md "The broker: agents, other apps, host data"). The broker suites pass in the Windows CI
  job with Node apps; nobody has run a Python app or the packaged app on Windows.
