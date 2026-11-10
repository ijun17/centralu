# Renaming the orchestrator role to Assistant (#2133)

> **Status: steps 1 and 2 built (as one change), step 3 built (both shipped in beta.54); step 4 built for the release after
> beta.55 (§3.3 says what it switched and what it left); the contract step (N+2: drops, folder move) not started.** The owner decided on 2026-11-08 (recorded on #2133):
> - the orchestrator role becomes **Assistant** everywhere it is named, internal identifiers and stored values included;
> - the mail address `orchestrator` becomes `assistant`, with no alias period;
> - the current icon stays.
>
> This document says in what order that can land without breaking a build that meets this one.

## 1. What "orchestrator" names today

Measured on 2026-11-09 at 05e8f7a: 5,751 occurrences in about 530 files (327 in `packages/agent-host`, 85 in
`packages/ui`, 30 in `packages/protocol`). They fall into five groups. The groups differ in who else reads the word.

| Group | Examples | Who else reads it |
|---|---|---|
| Words people read | Settings section and its "Orchestrator agent" field, the row label for a session with no project (`selectors.ts`), `MessageAsk`, docs | nobody: one build's screen |
| Words agents read | the mail address `orchestrator` (`mail/tool.ts` `party()`), the role prompt, tool descriptions, the `centralu` help topic `orchestrator` | the model only; recordings keep old descriptions, which replay does not compare (`replay.test-helpers.ts` `hostAnswers`) |
| Code identifiers | `orchestrator-*.ts` files (about 30), `OrchestratorView`, `orchestratorId()`, `OrchestratorTools` / `orchestratorToolsFor` (the Centralu tool set many sessions get, not the role's) | nobody: one build's code |
| Values on the wire | protocol methods `orchestrator.get/peek/configure/tools/tool`; `SessionKind` `'orchestrator'`; `by: 'orchestrator'` on a settings change from a hub (`session-params.ts`, `events.ts`); events `orchestrator_proposals_changed`; approval kind `orchestrator_change`; the skill methods `agents.orchestratorSkills` and `agents.deleteOrchestratorSkill` | a window of the same bundle, and **linked machines, which run other releases** (a hub updates them after itself, and a machine can stay behind when the update fails or is off) |
| Values stored | `sessions.is_orchestrator`; `app_settings` keys `orchestrator_tool`, `orchestrator_skills`, `orchestrator_skill_proposals`, `orchestrator_mcp_proposals` (and the legacy `orchestrator_mcp_servers`); mail rows' `via = 'orchestrator'`; the hub's sender id `_hub-orchestrator` (`HUB_SENDER`) in message rows; folders `<data>/orchestrator` and `<data>/orchestrator-agents` | **the previous release**, which a person can go back to and which a linked machine's rollback starts again |

## 2. The rule this follows

- **Stored values.** A rename of a column, key or stored value is a contract step: it lands one release after the
  code stopped reading and writing the old form ([agent-host.md](../agent-host.md) §5.1). Before that, an expand step can
  add the new form. The code reads both forms and keeps writing the old one, so the previous release still finds
  what it knows.
- **Wire values.** The protocol takes additions only. A linked machine of an earlier release parses `SessionKind` with
  a closed enum, so a new value sent to it fails its parse. This build therefore accepts both values and sends the
  old one. Once no supported release lacks the new value, a later build sends the new value.

So the rename lands in two releases. The first changes everything nobody else reads, and teaches this build to read
the new wire and stored values. The second writes and sends only the new values.

## 3. Steps

Each step is one PR on `dev`, landing with the next dev → main PR.

| Step | What | Behaviour change | Lands |
|---|---|---|---|
| 1 and 2. Words and code (built) | The screen, docs, the role prompt, tool descriptions and the help topic say Assistant. The mail address is `assistant`, and `orchestrator` is refused as an unknown name is, with the role's address in the refusal. File, type and function names follow. `OrchestratorTools` and its family become `CentraluTools`, since it is the tool set every session with Centralu tools gets. Two values that never leave one build take the new name now: the tool profile (`ToolProfile` `'assistant'`) and the screen's view (`'assistant'`). A workspace an earlier build saved with view `'orchestrator'` still opens the Assistant's screen. The role's session an earlier build named "Orchestrator" is renamed "Assistant" once at the host's start (`AssistantSlot.renameFromOldName`), unless the person renamed it. Otherwise mail to `orchestrator` would still reach it by name | The address `orchestrator` stops working at once (owner: no alias). The previous release, going back, shows the role's session as "Assistant" and does not reopen the Assistant's screen from a workspace this build saved | release N |
| 3. Read both (built) | protocol: `assistant.*` methods added beside `orchestrator.*`, answered alike under the same rights, routes and bridge token; every caller keeps the old ones (§3.1); `SessionKind` gains `'assistant'`, `by` accepts `'assistant'`, the event `assistant_proposals_changed` and the approval `about: 'assistant_change'` are read beside the old ones, and every reader of the kind goes through `isAssistantKind` (lint `guard/assistant-kind`); stored: an expand step (68) adds `sessions.is_assistant`, copied from `is_orchestrator` and written beside it, the `app_settings` keys are written and deleted under both names and read under the old one, `via` and the hub sender read both; folders: `<data>/assistant` is used if present, else `<data>/orchestrator`. The mail refusal reason `orchestrator_asks` became `assistant_asks` outright: it is not stored or sent to another host | none; every value written and sent is still the old one | release N |
| 4. Read new (built) | store step v69 copies the old forms once and raises the floor to 68; the new form is read first and both are still written; the Codex bridge calls `assistant.*`; mail rows' `via` is written `'assistant'`; `agents.assistantSkills` and `agents.deleteAssistantSkill` are added beside the old ones. What reaches a linked machine or a window of another release stays old (§3.3) | none visible; a build older than N can no longer open the store | release N+1 |
| 5. Contract (not started) | drop `is_orchestrator` and the old keys, the old `via` and sender; send `'assistant'` where §3.3 kept the old value; move the folders, carrying the saved conversation (below); the `orchestrator.*` methods go once no supported release calls them | a build older than N+1 can no longer open the store | release N+2 or later |

No alias has two consequences in step 1. A worker the person names "Assistant" is reachable only by its id, since
the role's address wins over a session name. Mail to `orchestrator` falls through to the name lookup, so a role
session still named "Orchestrator" gets it by name: one restored from the trash after the host started, or one the
person renamed back. `renameFromOldName` cannot tell a name an earlier build gave from one the person chose, so a
deliberate "Orchestrator" is renamed too.

Step 4 needs release N to be the previous release on every machine a person can go back to. A hub that updates a
linked machine to N+1 keeps N as its rollback, and N reads the new values.

The contract step also moves the role's folder. Claude Code keys its saved conversations by the working folder
(`~/.claude/projects/<folder with every character that is not a letter or digit made '-'>/<id>.jsonl`), so renaming
`<data>/orchestrator` could lose the Assistant's past conversation.

**Measured on 2026-11-10 with Claude Code 2.1.296 on Windows**, in a scratch config folder (`CLAUDE_CONFIG_DIR`), with a
conversation file saved under the folder of `<scratch>/data/orchestrator` and the CLI run from `<scratch>/data/assistant`:
- `claude -p --resume <id>` from the new folder **finds the conversation** saved under the old folder's key: it went on
  to the API call (stopped there by an invalid key), as it does from the old folder. A made-up id from the new folder
  answers `No conversation found with session ID: <id>` at once, so the lookup by id is not limited to the folder's key.
- The new folder gets its own key folder (`…-data-assistant/memory`), empty: Claude Code's per-folder memory and the
  folder-scoped `--continue` do not follow the move, and the conversation file stays under the old key.
- Not measured: whether a resumed turn appends to the old file or writes a new one under the new key, other platforms,
  and Codex (its rollouts are found by thread id under `~/.codex/sessions`, not by folder; to be checked the same way).

So the contract step can move the folder without losing the conversation for `--resume` by id (which the host uses,
`externalId`), on this CLI version. It should still move the key folder (`projects/<old key>` to `projects/<new key>`)
when the new one does not exist, so the memory and `--continue` follow, and it must measure the CLI version it ships
with again, since an older CLI looked only under the folder's own key.

### 3.1 What step 3 reads, and which calls stay old (superseded by §3.3 for the release after beta.55)

| Value | Written | Read |
|---|---|---|
| `sessions.is_orchestrator` / `is_assistant` | both, equal (`upsertSession`) | `is_orchestrator` only |
| `app_settings` `orchestrator_tool`, `_skills`, `_skill_proposals`, `_mcp_proposals` / `assistant_*` | both, equal; a delete removes both (`RENAMED_SETTINGS`, `store/settings.ts`) | the old key only |
| `app_settings` `orchestrator_mcp_servers` | nothing writes it since M4 A-7 | the old key, only to move it into apps; it keeps its name |
| mail rows' `via` | `'orchestrator'` (`ROLE_VIA`) | `'orchestrator'` or `'assistant'` (`isRoleVia`) |
| the hub's sender in message rows and relayed events | `_hub-orchestrator` | either, also qualified with a machine's id (`isHubSender`, `isQualifiedHubSender`) |
| `SessionKind`, `by`, the proposals event, the approval's `about` | the old value | either (`isAssistantKind`, `isAssistantChange`) |
| folders | the old one, made when missing | the new one when a later build made it, else the old one; never made or renamed here. A session keeps the folder it started in (`cwdFor`) |

**Why the old form is the one read.** Every build that can open the store writes the old form; only builds from N on
write the new one too. Reading the new form goes wrong when a person goes back and forward: N writes both, N−1 then
changes only the old key (another Assistant tool, an approved skill), and N reading the new key would show the value
from before. Falling back to the new key when the old one is missing goes wrong too: N−1 deletes only the old key when
a list empties (`listSetting`), and the new key it leaves would bring back the skill the person removed. No build that
can open a store N opens writes the new form alone (step 4 writes both, §3.2), so N reads the old form only. This
differs from the brief for step 3, which had the new key read first; the measurement is
`store-renamed-settings.test.ts`. A row value (`via`, the sender) holds one form per row, so it is read as either. `is_assistant` is copied once by step 68 and then written beside `is_orchestrator`; the
same N−1 that moves the role writes only `is_orchestrator`, which is why it is the one read
(`store-assistant-marker.test.ts`).

**Which calls stay old.** None switches to `assistant.*` in this release:
- the window calls `orchestrator.*`. Under the keeper a window can stay attached to an older host (#280,
  `e2e/older-host.spec.ts`), which does not know the new methods;
- the hub's calls to a linked machine (`links/routes.ts`) reach machines of other releases, so they stay old until no
  supported release lacks the new names;
- the Codex bridge (`centralu-bridge.mjs`) runs from the host's own bundle and could switch, but sends nothing new
  before step 4 either;
- the host sends `kind: 'orchestrator'`, `by: 'orchestrator'`, `orchestrator_proposals_changed` and
  `orchestrator_change`: a linked machine or window of an earlier release parses them with closed enums.

### 3.2 What step 4 must do

- **Copy the old form into the new one once,** at its first open, then read the new form first. Until then the new
  form can be stale after N−1 served the store, also where N−1 deleted the old form: N−1 deletes `orchestrator_tool`,
  the last skill and the last MCP proposal under the old key only, and leaves `assistant_tool`, `assistant_skills` and
  `assistant_mcp_proposals` as they were. So the copy sets `is_assistant` from `is_orchestrator` on every row, sets
  each new key from its old key, and **deletes each new key whose old key is absent**. A copy that only fills new keys
  from old ones that exist would bring back what the person removed.
- **Keep N−1 out, and only N−1.** Reading the new form first is right only when every build that can open the store
  writes it. Step 4's copy therefore raises `min_reader_version` to 68, step 3's own version: N opens the store
  (it writes both forms), N−1 does not. The gate raises a breaking step's floor to that step's own `to`
  (`migrate-runner.ts`), which would keep N out too, so step 4 needs a step that can name a lower floor.
  A floor of 68 also admits a build of step 68 alone (a7eb7e2ef on `dev`), which writes only the old settings keys;
  it was never released, so it is not a supported rollback.
- **Keep writing and deleting both forms** while N is a release a person can go back to: N reads only the old form.
- **Drop the old forms one release later (N+2):** `is_orchestrator`, the old keys, the old `via` and sender. A drop
  of `is_orchestrator` in N+1 with `breaksOlderReaders: true` would raise the floor past N, which this plan keeps as
  the rollback. The folders move then too, carrying the Assistant's saved conversation (above).
- `agents.orchestratorSkills` and `agents.deleteOrchestratorSkill` have no `assistant` twin yet: step 4 adds one as
  step 3 did for `orchestrator.*`, and a later build drops the old names.

### 3.3 What step 4 built (the release after beta.55)

Every machine's previous release is beta.54 or later (owner, recorded on #2133), so every build a person can go back to
reads the new forms (step 3). A linked machine is another matter: the hub connects to any machine of the same protocol
version (`PROTOCOL_VERSION` is 1 for every release, `linked-machine-connection.ts` `check`), so a machine that stayed
behind can run a release before step 3. What reaches a linked machine therefore keeps the old value.

**Store.** Step v69 (`store/migrations/v65.ts`) sets `is_assistant` from `is_orchestrator` on every row, sets each new
`app_settings` key from its old key, and deletes each new key whose old key is absent. It declares `breaksOlderReaders:
true` with `minReader: 68`: `MigrationStep.minReader` lets a breaking step name a floor below its own `to`
(`migrate-runner.ts` `floorOfStep`; a floor already higher is never lowered, and a store without a record works its
floor out the same way). Then:

| Value | Written | Read |
|---|---|---|
| `sessions.is_orchestrator` / `is_assistant` | both, equal | `is_assistant` (`SessionRecords`, `user-app-adoption.ts`); the one-time move of old thread mail (`mailbox-adopt.ts`) keeps `is_orchestrator`, which it also meets on stores from before v68 and which every build that opens a v69 store writes equal |
| the four renamed `app_settings` keys | both, equal; a delete removes both | the new key, else the old one (`SettingsRecords.appSetting`) |
| mail rows' `via` | `'assistant'` (`ROLE_VIA`): the row stays on this machine and every build that opens the store reads both words | either |
| the hub's sender `_hub-orchestrator` | unchanged: a linked machine records it and the hub reads it back, and the hub can be of another release | either |

Tests: `store-assistant-step4.test.ts` (a new key whose old key a build deleted alone stays deleted; a stale new key is
replaced; the step runs once; the build of v68 opens the store and the build of v67 is refused),
`store-assistant-marker.test.ts`, `store-renamed-settings.test.ts`, `store-min-reader.test.ts` (the floor is 68).

**Wire, name by name.**

| Name | Switched? | Why |
|---|---|---|
| `orchestrator.get`, `.peek`, `.configure` (the window) | no (`platform/src/web/index.ts`) | the window can reach a host older than step 3 that the store's floor does not keep out: a keeper of an earlier release it attaches to (#280), and on Windows the data folder's `centralu serve` behind `serve --window`, which the hub installed at whatever version (`sidecar/mod.rs`) and which a store at v68 or below does not refuse. The host answers both names, so switching gains nothing yet. The window switches once no supported keeper or `serve` lacks `assistant.*` |
| `orchestrator.tools`, `.tool` (the Codex bridge) | yes, to `assistant.*` (`centralu-bridge.mjs`) | the bridge runs from the host's own bundle |
| the old methods, answered by the host | kept | a hub of another release calls them on a linked machine (`links/routes.ts`) |
| `agents.orchestratorSkills`, `agents.deleteOrchestratorSkill` | twins added (`agents.assistantSkills`, `agents.deleteAssistantSkill`), same rights and routes; the window keeps the old names | the previous host lacks the twins; the window switches in the release after this one |
| `SessionKind` `'orchestrator'` (`ASSISTANT_KIND`) | kept | sessions reach the hub from a linked machine, and the hub may be of a release before step 3, which parses a closed enum |
| `by: 'orchestrator'` | kept | sent by the hub's Assistant to a linked machine |
| `orchestrator_proposals_changed` | kept | relayed from a linked machine to the hub (`links/qualifier.ts`) |
| approval `about: 'orchestrator_change'` (`ASSISTANT_CHANGE`) | kept | a linked machine's cards are shown by the hub |

## 4. What is not renamed

- Recorded frames under `adapters/*/recordings`. They are what a real CLI sent and received, and replay does not
  compare the tool descriptions in them. A scenario whose model mails `orchestrator` is re-recorded or its expectation
  changed in step 1. A real run is needed to re-record.
- Historical plans and results in `docs/plans/` (m1 to m2, remote-hub and others). They describe what was decided at the time.
  The live documents (agent-host, domain-model, architecture, product-spec, the Korean mirrors) are renamed in step 1.
- The word "orchestrate" used as a verb for what the role does.

## 5. Open points

- **The "Coordinator" role** (`SessionKind` `'coordinator'`) is not named in the decision and stays.
- **The icon** stays (owner).
