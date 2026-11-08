# Renaming the orchestrator role to Assistant (#2133)

> **Status: steps 1 and 2 built (as one change); steps 3 and 4 design.** The owner decided on 2026-11-08 (recorded on #2133):
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
| Values on the wire | protocol methods `orchestrator.get/peek/configure/tools/tool`; `SessionKind` `'orchestrator'`; `by: 'orchestrator'` on a settings change from a hub (`session-params.ts`, `events.ts`); events `orchestrator_proposals_changed`; approval kind `orchestrator_change` | a window of the same bundle, and **linked machines, which run other releases** (a hub updates them after itself, and a machine can stay behind when the update fails or is off) |
| Values stored | `sessions.is_orchestrator`; `app_settings` keys `orchestrator_tool`, `orchestrator_skills`, `orchestrator_skill_proposals`, `orchestrator_mcp_proposals` (and the legacy `orchestrator_mcp_servers`); mail rows' `via = 'orchestrator'`; the hub's sender id `_hub-orchestrator` (`HUB_SENDER`) in mail rows; the mail rule name `orchestrator_asks`; folders `<data>/orchestrator` and `<data>/orchestrator-agents` | **the previous release**, which a person can go back to and which a linked machine's rollback starts again |

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
| 3. Read both | protocol: `assistant.*` methods added beside `orchestrator.*` (the host answers both, the window calls the new ones); `SessionKind` gains `'assistant'`, `by` accepts `'assistant'`, and every reader treats the two values alike; stored: an expand step adds `sessions.is_assistant` and copies `is_orchestrator`, the `app_settings` keys are read under the new name first and the old one second, `via` and the hub sender read both; folders: `<data>/assistant` is used if present, else `<data>/orchestrator` | none; every value written and sent is still the old one | release N |
| 4. Write new | send `'assistant'`, `by: 'assistant'` and the new event and approval names; write the new keys, `via` and sender; a contract step rewrites old values, drops `is_orchestrator` (`breaksOlderReaders: true`) and renames the folders; the `orchestrator.*` methods go | none visible; a build older than N can no longer open the store | release N+1 or later |

Step 4 needs release N to be the previous release on every machine a person can go back to. A hub that updates a
linked machine to N+1 keeps N as its rollback, and N reads the new values.

Step 4 also moves the role's folder. Claude Code keys its saved conversations by the working folder, so renaming
`<data>/orchestrator` would lose the Assistant's past conversation unless that is carried over too. This is to be
measured before step 4 is built.

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
