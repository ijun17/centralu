# Renaming the orchestrator role to Assistant (#2133)

> **Status: steps 1 and 2 built (as one change), step 3 built; step 4 design (§3.2 says what it must do).** The owner decided on 2026-11-08 (recorded on #2133):
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
| 4. Write new | send `'assistant'`, `by: 'assistant'` and the new event and approval names; read the new form first; write the new `via` and sender; the `orchestrator.*` methods go once no supported release calls them. Dropping `is_orchestrator` and the old keys, and moving the folders, is a later contract step (§3.2) | none visible; a build older than N can no longer open the store | release N+1 or later |

No alias has two consequences in step 1. A worker the person names "Assistant" is reachable only by its id, since
the role's address wins over a session name. Mail to `orchestrator` falls through to the name lookup, so a role
session still named "Orchestrator" gets it by name: one restored from the trash after the host started, or one the
person renamed back. `renameFromOldName` cannot tell a name an earlier build gave from one the person chose, so a
deliberate "Orchestrator" is renamed too.

Step 4 needs release N to be the previous release on every machine a person can go back to. A hub that updates a
linked machine to N+1 keeps N as its rollback, and N reads the new values.

Step 4 also moves the role's folder. Claude Code keys its saved conversations by the working folder, so renaming
`<data>/orchestrator` would lose the Assistant's past conversation unless that is carried over too. This is to be
measured before step 4 is built.

### 3.1 What step 3 reads, and which calls stay old

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
