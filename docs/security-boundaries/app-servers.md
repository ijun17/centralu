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
  `host-data.test.ts`, `call-app.test.ts`). Designed to change (#2237, not built): in a trusted
  project the declared `uses` is the consent, see [Design (#2237)](#design-2237-a-trusted-projects-declared-uses-is-the-consent).
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

## Design (#2237): a trusted project's declared `uses` is the consent

**Status: design, not built.** Everything above this heading describes the code as it is. The pull request
that builds this rewrites the bullets it changes (named under "Changes, by file") and deletes this status line.
Line numbers are those of main at `4b3be7aa4`.

### Why

An app's first use of a capability raises a card (`BrokerDesk.permit`, `desk.ts:682-754`), whatever the
project's trust and whatever the caller's preset. Sessions stopped doing that in #673: a `normal` or `edits`
session in a trusted project starts agents with no card, because "a card in a session they were not looking at
only made the session work alone" (`agent-consents.ts:29-31`, `trustIsAgentConsent` at `:49-53`). On 2026-11-12
an app the Assistant built asked for its first `run_agent`; the card stood in the builder's session, nobody saw
it, and it closed as a refusal after 5 minutes (`questionMs`). The owner asked on 2026-11-13 why the app asks at
all, and whether it can just be allowed (#2237).

The card is not a boundary against the app. An app's server is unconfined code running as the person ("Nothing
confines what a running app server does", Limits above): it can start the CLI itself, read any file, call any
URL. What the person decides is **whether it runs**: a project's apps run only in a trusted project
(`runtime.ts:941`; lost trust halts them at `:991-998`), the trust card lists each app with its `uses`
(`TrustCard.tsx:56-75`), a user-folder app is the person's own (`runtime.ts:304`), and an imported app runs only
after a review that lists its `uses` ([imported-apps.md](imported-apps.md)). So every app that reaches `permit`
is already one the person decided about, with its `uses` shown.

### What was read

- #2237 (no comments; the proposal and its optional `safe` rule), #673 (owner decisions 2026-10-14: no card in a
  trusted project, **no setting**; `safe` keeps it, #606).
- `desk.ts`: `permit` and its three callers (`hostData` `:510`, `runAgent` `:553`, `callApp` `:657`, each after
  the declaration check, `callApp` also after the loop and depth checks `:644-655`); `deniedText` `:281`;
  `permissions` `:761-767`; the limits `CHAIN_DEPTH_MAX`, `AGENT_RUNS_PER_WINDOW` `:240-241`.
- `capabilities.ts` (`capabilityKey`, `usesStamp` `:86`, `CapabilityBook`, `HOST_CAPABILITIES` `:32`),
  `app-calls.ts` (`agentCallers` `:99-114`, `chainOrigin` `:117-124`), `app-sessions.ts` (`appAgentPreset`
  `:641-644`, used at `:439`; a builder session is made under `auto` at `:269`), `session-app-wiring.ts`
  (`brokerHost` `:75-85`), `host-cards.ts` (`askCapability` `:187`, the view questions in `appQuestions`),
  `dev-services/store/permissions.ts` (`app_permissions`), `rpc.ts:655-660`, `trust-flow.ts` (`listAppGrants`, `forgetAnswer`).
- The window: `RunsPanel.tsx:102-149` (Permissions), `ApprovalCard.tsx:225-262` (the capability card),
  `CapabilityAsk.tsx`, `TrustCard.tsx`, `Inbox.tsx:386` and `noteAppArrivals` (`core/src/inbox/inbox.ts:83`).
- PR #2235 (branch `lane-apps-tool`, open; re-read at `788ac801a`): it does not touch `desk.ts`,
  `capabilities.ts`, `askCapability` or the Runs panel, and its edits to this file, `trust-lifecycle-calls.md` and
  `broker-and-rpcs.md` are in other paragraphs than this design's. It adds the session-side gate this design
  leans on: a session's `app` call runs a tool that only reads (or is declared `local`, or `routine` in the
  session's own project) unasked, and otherwise asks per the session's preset (`presetAsks`, `tool-risk.ts`:
  `safe` always, `auto` never), every time, with no "Always".
- `app-access.ts:15-26` and its `gate` (`:300-308`): a session in an untrusted project attaches no app unless
  `trustGate` opens the boundary for it (an `auto` caller, #603).

### The rule

`permit` keeps its place (the one point every broker request passes, after the declaration check) and its
signature. Its decision becomes, in this order:

1. **A remembered deny refuses, at any stamp.** Today a deny given against an older `uses` is asked again
   (`known.stamp === stamp`, `:690`); with no card that would silently become an allow. A deny holds until the
   person forgets it.
2. A remembered allow at the current stamp allows (as today; such rows now come only from rule 4).
3. **Otherwise the request is allowed with no card and nothing remembered**, unless rule 4 applies. The consent
   is the decision that lets the app run, read where it is enforced (an untrusted project's app never gets
   here), so nothing is stored that could outlive it.
4. **A caller under `safe` keeps the card.** When the lowest preset among the calls open into the app is
   `safe`, today's path runs unchanged: one card per (app, capability) where the chain started, the answer
   remembered with the `uses` stamp, 5 minutes without an answer is a refusal that remembers nothing.

"The lowest preset among the calls open into the app" already has an owner: `appAgentPreset(callers, presetOf)`
over `AppCalls.agentCallers(ref)`, the rule of the owner's 2026-11-05 decision ("no session gains through an
app what its own preset withholds"). It reads every open call, whatever run id the app cited, so an app cannot
pick the caller that suits it; a pinned view the person opened counts as `auto`, an inline view as its
conversation's session, a `call_app` chain as its first caller, and a chain that can no longer be followed, a
session whose record is gone, or no open call at all as `safe`. The same function decides the agent's preset
and whether the person is asked, so the two cannot disagree: an agent that would run under `safe` is exactly
the one that asks first.

The callers' own project trust is not read again here. #673's rule is "`normal` or `edits` **in a trusted
project**", and the app's side of that is already enforced: an untrusted project's apps never run, and a session
in an untrusted project attaches no app (`app-access.ts:24-26`, `gate` at `:306`) unless the boundary is open
for it, which happens only under `auto`, where #673 opens the `start_agent` card too. So every session caller
that reaches `permit` is one that could start an agent itself without a card, or is under `safe`.

The desk still knows nothing about sessions or presets. `BrokerHost` gains one member,
`asksPerson(callers: AgentCaller[]): boolean`, and `permit` calls it with `this.apps.agentCallers(app.ref)`.

Why `safe` keeps the card (the issue marks it optional, so it is also open question 1): under `safe`
`start_agent` asks (approvals.md, the `start_agent` rows) and every boundary stays closed (#606). After
PR #2235 a `safe` session runs an app's read-only (or `local`, or own-project `routine`) tool unasked; if that tool's `run_agent` then needed no card,
the session would start an agent through the app that it may not start itself. `normal`, `edits` and `auto`
lose nothing: there the session starts agents without a card already.

### Each capability

All three follow the rule. None keeps a card outside `safe`.

| Capability | Why trust is enough | What still holds it |
|---|---|---|
| `run_agent` (`agent:<tool>`) | The same act as `start_agent`, which trust already covers (#673) | Declared in `uses.agent`; the agent runs in a new visible session under the lowest caller's preset, with no apps and no Centralu tools; one agent per app at a time, 5 a minute; every request is a run record; the Runs panel shows the app's agent use |
| `call_app` (`app:<key>`) | A session attaches a user-folder app or a trusted project's root app with no card too (#1141) | Declared in `uses.apps`; the target is reached through `ExternalApps.call` (trusted, enabled, `model` tools only); no loop, depth 3 |
| `host_data` (`host:<name>`) | Read-only, a closed list (`sessions.list`, `git.status`), scoped to the app's own project; a user-folder app is the person's own. The app's process can read more than this from disk | Declared in `uses.host`; deny by default for an unknown name |

`call_app` and PR #2235: a session's direct call to app B's writing tool asks under `normal`, while app A, called
by that session, reaches the same tool through `call_app` with no card. That is not new (after the first
"Allow" it is today's behavior) and not a gain for the session: the gate #2235 adds is on the session's call
into A, by the risk A's tool declares, and A's code is trusted with its project to do what its tool says,
through B or by itself.

`uses.notices` and `uses.background` never went through `permit` and do not change.

### User-folder and imported apps

The same rule, with no special case. A user-folder app is trusted because the person put it there; one the
Assistant built was built in a session the person asked for; an imported one arrives turned off, runs only
after a review that lists its `uses`, and is reviewed again when its `server` or `uses` changes
([imported-apps.md](imported-apps.md)). A user-folder app's `sessions.list` gives every session's name: that
is what its line on the review and in `usesLines` says, and it is the person's own app.

### A `uses` change, and `manifestVersion`

A changed `uses` no longer asks: in a trusted project it applies with the pull, as the app's server code does.
The stamp stays for one purpose, an allow remembered from a `safe` card (a `safe` caller is asked again when
`uses` changes, as today). Trust given before this change counts, as it did for #673: the person trusted the
project with its apps and what they declare.

No `manifestVersion` bump. The manifest's shape and what each `uses` key lets an app get are the same; what
changed is the host's rule for when it asks the person, which is not something the app's author writes.

### What the person sees and takes back

- **Runs panel** (unchanged): every broker request, allowed or refused, is a row under the call that caused it;
  the app's agent use (count, time, tokens) stands above the list.
- **Runs → Permissions** lists the remembered answers: those from before this change and those from `safe`
  cards. Forget on a deny lets the app use that again; Forget on an allow matters only for callers under `safe`.
  A deny shows "denied" whatever the stamp; "outdated" remains for an allow given against older `uses`.
- **To stop an app using something**: turn the project's trust off (its apps stop at once), remove the app or
  the `uses` line, stop it, or keep a remembered deny. To be asked first: run the calling session under `safe`.
- No list is added to Settings → Permissions. Capability answers are per app and stay with the app; the consent
  itself is the project's trust, which is shown and changed where it is today.
- What trust covers is on screen today only when it is given (the trust card, the "New app" inbox notice, the
  import review). Showing it afterwards is open question 2.

### A linked machine

An app runs under the host of the machine its project is on. That host's desk, store, project trust and
sessions' presets decide; `apps.permissions` and `apps.forgetPermission` already route by `machine`
(`links/routes.ts`). No message changes. A linked host on an older build keeps asking as before, and the window
keeps the card and the view question for it. No path was found where a session on one machine calls an app on
another (`session-apps.ts`, `app-access.ts`, `app-calls.ts` carry no machine).

### Changes, by file

One pull request, deep tier (trust and permissions). No store step, no protocol message.

- `apps/external/desk.ts`
  - `permit`: line 690 becomes rule 1 and rule 2; after the `host` check, `if (!host.asksPerson(this.apps.agentCallers(app.ref))) return null`.
    Nothing else in it moves. With no host (a runtime without sessions) it refuses as today.
  - `BrokerHost`: add `asksPerson`.
  - `permissions()`: `current` is `d.decision === 'deny' || d.stamp === stamp`.
  - `deniedText`: drop "and Centralu asks again when the app's manifest changes what it uses".
  - The header's "A declaration is not a grant" paragraph and `permit`'s comment say the new rule.
- `sessions/app-sessions.ts`: one method, `callersPreset(callers)`, wraps
  `appAgentPreset(callers, (id) => this.host.meta.get(id)?.permissionPreset)`; `runAppAgent` (`:439`) uses it.
  The wiring's `Pick<AppSessions, …>` (`session-app-wiring.ts:42`) gains the name.
- `sessions/session-app-wiring.ts` `brokerHost()`: `asksPerson: (callers) => this.host.appSessions.callersPreset(callers) === 'safe'`.
- `apps/external/test-helpers.ts` `fakeBrokerHost`: `asksPerson: () => false` by default.
- `packages/protocol/src/entities/apps.ts`: the comment on `AppPermission.current` (a deny is always current).
  The shape is unchanged, so no fixture changes ([protocol.md](../protocol.md) §4). An older window shows what a
  newer host sends correctly, and the other way round.
- Words (ux-writing.md §1.12, one wording per state). "May ask to:" is no longer true, and the prefix is written
  three times (`TrustCard.tsx:70`, `Inbox.tsx:386`, `trust-flow.ts:57`). It moves into one function beside
  `usesLines` and reads "Can …" ("Can run your default agent in a new session"); "Asks for nothing beyond its own
  tools" becomes "Uses nothing beyond its own tools".
  - `ApprovalCard.tsx:257`: "Centralu remembers your answer for this app. You can change it later under Runs →
    Permissions."
  - `trust-flow.ts` `listAppGrants` and `forgetAnswer`: say what forgetting does now (a forgotten deny lets the app
    use it again; an allow matters only under `safe`).
  - `RunsPanel.tsx`: the comment on `Permissions`; the markup is unchanged.
- Documents, in the same PR: the "What an app may ask the broker for" bullet and the Limits bullet "A permission is
  per capability" above; a row in approvals.md's table (an app's declared broker request: `safe` asks once per app
  and capability, every other column allowed, a remembered deny refuses under all; enforced in `BrokerDesk.permit`);
  "Asked once." in apps/broker-and-rpcs.md; the user-folder bullet in apps/trust-lifecycle-calls.md "Trust".
  apps/build-loop.md's paragraph on a denied capability stays true (a Deny under `safe`, or one kept from before).

No layout, component or motion changes (design-system.md §9 has nothing to cover here).

### What goes away

With `safe` keeping the card, little: the stamp check on a deny, the "asks again when the manifest changes"
promise in four strings, two of the three copies of the "May ask to:" prefix, and the second copy of the
`presetOf` closure. The card, the view question and the book stay, because `safe` and older linked hosts use
them.

Considered and not taken: asking in the `safe` session instead of where the chain started would let the host
drop the view question (`HostCards.appQuestions`, about 80 lines), but the window must keep `CapabilityAsk` for
older linked hosts, the two RPCs would be retired rather than removed, and a person who clicked in a pinned view
would be asked in another place. Not worth it.

If the owner picks "no card under `safe` either" (question 1, option B), the host loses `asking`, its timers,
`CapabilityQuestion`, `BrokerHost.askCapability`, `HostCards.askCapability` and `appQuestions`, `usesStamp` and
`CapabilityBook.put` (about 300 lines with their tests); the window keeps its side for older linked hosts.

### Tests

Each fails with the change to `permit` reverted.

- `apps/external/capabilities.test.ts` (desk level, `fakeBrokerHost`):
  - callers not under `safe`: `run_agent`, `call_app` and `host_data` each run with an `askCapability` that
    throws, and the book is empty afterwards;
  - `asksPerson` true: the existing card tests, unchanged in what they assert;
  - a deny row written with another stamp refuses, and `askCapability` is not called (fails today: it asks);
  - an allow row with another stamp, callers not under `safe`: allowed, no card; under `safe`: asked;
  - undeclared requests are still refused before anything else (existing tests; they must stay green).
- `sessions/app-capabilities.test.ts` (host level, real session manager):
  - a `normal` session calls a tool whose app asks for an agent: no `approval_request` with
    `detail.kind: 'capability'`, the run is `ok`, `apps.permissions` is empty;
  - the same under `safe`: the card, as today (the existing card tests move to a `safe` session);
  - a pinned view's call alone (`person`): no question in `apps.questions`;
  - a pinned view's call while a `safe` session has a call open into the same app: the question is raised
    (lowest caller), on the view;
  - a `call_app` chain started by a `safe` session: the called app's request asks, in that session.
- `sessions/app-agents.test.ts`: the agent's preset and the card agree (one case per preset, through
  `callersPreset`).
- `e2e/capabilities.spec.ts`: the session-card spec runs its session under `safe`; one new spec, "under the
  default preset an app's first agent runs with no card"; the Permissions/Forget spec seeds its row through a
  `safe` card. The two view-question specs cannot be reached from a view alone any more: they become the
  host-level case above; `CapabilityAsk.test.ts` exists, and whether it covers what those two specs assert
  (the sidebar indicator, opening the view from it) was not read.
- `e2e/app-change-loop.spec.ts` and the suites using `fakeBrokerHost` (`broker-records`, `errors`, `limits`)
  need no change beyond the helper's default.
- The new words: `sessions/trust-commands.test.ts` (`:101-134`, `:176`, `:292-299`) and `e2e/apps.spec.ts`
  (`:875-879`, `:913`) pin "May ask to:" and "Asks for nothing beyond its own tools." Their injection cases
  (a description or app name that imitates the line must not produce it) keep their shape with the new text.

### Real-environment checks

Run by the implementation session's deep review, on a host started with `CC_DATA_DIR` and `--db` in a
temporary folder, with the real CLI:

1. A trusted project with an app declaring `uses.agent`; a session under the default preset calls its tool:
   the agent's session appears, no card anywhere, Runs → Permissions is empty.
2. The same session set to `safe`: the card appears in it; Allow runs the agent under `safe`; the row appears
   under Permissions; a second call asks nothing.
3. Deny under `safe`, then the session back to `normal`: still refused, the refusal names Runs → Permissions;
   Forget, then it runs with no card.
4. The Assistant builds a user-folder app that runs an agent and checks it: no card in the builder's session
   (the 2026-11-12 case).
5. Turn the project's trust off while the app is running: it stops, and a call is refused.
6. A store written by the previous build, holding an allow and a deny: both listed; the deny still refuses
   after the manifest's `uses` is edited.
7. A linked machine, if one is at hand: the same as 1 on its project. Otherwise say it was not run.

### Risks and failure cases

- **An app spends the person's agent use on its own.** Bounded as today: one agent at a time per app, 5 a
  minute, each a visible session and a run record, totals in the Runs panel. The app could do the same today
  after one "Allow", or by starting the CLI itself.
- **Prompt injection through an app's agent** is unchanged: the preset is still held to the lowest caller, and
  the residual is the one under "An agent an app started" in [approvals.md](approvals.md).
- **A caller's preset changes, or a `safe` session calls in, between `permit` and the agent's start.** Both read
  `agentCallers` at their own moment (`:579` for the agent). The later reading can only lower the agent's preset;
  the request was made when nobody under `safe` was calling.
- **Two hosts on one store, a host swap or an update.** The book is one table, written with `INSERT OR REPLACE`
  per (app, capability); the new build writes only from `safe` cards. An older build serving the same store
  finds no allow for an app the new one allowed by trust, and asks, which is its rule. A card standing at a swap
  is lost with the app's call, as today (`asking` lives in memory).
- **An older build after this one** reads deny rows as before (current stamp refuses, older stamp asks). Nothing
  it reads is in a new shape.
- **A linked host on an older build** keeps asking; the window still renders its card and view question.
- **Concurrent requests.** The allow path adds no `await`, so `runAgent`'s count-then-claim of the one-agent
  slot is as atomic as it is today. Two requests under `safe` still share one card (`asking`).
- **A remembered deny the person forgot they gave** now outlives a `uses` change. The refusal text names where to
  forget it, and the row says "denied".
- **Windows**: nothing here touches processes, paths or the pipe.

### Open questions for the owner

1. **Does a caller under `safe` keep the card?**
   - A. Yes (this design). Under `safe` the person is asked once per app and capability, as today; under every
     other preset nothing asks. A `safe` session cannot start an agent through an app without the person.
   - B. No card under any preset. Simpler to explain and about 300 lines less on the host, but a `safe` session
     starts agents through an app's read-only tool with no question, which `start_agent` under `safe` does not
     allow, and the only way to hold an app is the project's trust.
   - Recommendation: **A**. It is #673's own rule (`safe` keeps the card, #606) and the 2026-11-05 decision, and
     the case that hurt (a builder or a default session waiting on an unseen card) is gone either way.
2. **After trust is given, where does the person see what an app can do?** (a layout change)
   - A. Nowhere new. The trust card, the "New app" notice and the import review said it; Permissions lists only
     remembered answers and is empty for most apps.
   - B. Runs → Permissions also lists the app's `uses` lines ("Can run your default agent in a new session"),
     read-only, above the remembered answers. The data is already in the window (`ExternalAppInfo.uses`).
   - C. B, plus a Block control per line that writes a deny without a card (an RPC addition).
   - Recommendation: **B**, in the same PR. With no card, this is the one place that says what the app is
     allowed. C can follow without a migration, since a deny row already wins; #673 chose no setting.
3. **Is the person told when an app in a trusted project starts declaring more?**
   - A. No. The change arrives with the pull, like the app's code, which can do more than any `uses` line.
   - B. An inbox notice once ("<app> can now: …"), by keeping each app's `uses` in the window's snapshot beside
     the keys `noteAppArrivals` keeps.
   - Recommendation: **A** for this change; B as its own issue if wanted. Today a changed `uses` asks again at
     the next use; after this change nothing does, outside `safe`.

### Not in this change

The capability card that remains under `safe` still closes as a refusal after 5 minutes. #673's decisions 2 to 4
(keep the request pending instead of withdrawing it, say so visibly) were made for `start_agent` and are not
applied to it here; that is a follow-up if `safe` cards on apps turn out to be missed.
