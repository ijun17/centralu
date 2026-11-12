# The Assistant hands a session off (`handoff_session`, #694)

Handoff was the session menu's alone (⋯ → Hand off to a fresh session…). The Assistant now has it as a tool,
so it can replace a session that has drifted, or move its work to the other CLI, the way the person does. The note is
**from the record by default**, in the tool and in the window alike (owner decision on #694; the window archives
the original by default since #1477, having kept it from #694 to then): the session being
replaced is the one least likely to summarize correctly (repeated compaction, stale state, a summary carrying injected
text), and the record mode asks it nothing (`exportHandoffRecord`, `sessions/handoff-record.ts`; since #1481 the note opens with a contents section built without a model: the
the reply that ended each of its last turns in full, the sessions the predecessor started by state with ids, its running background work and a table of the note's
parts with line numbers; the name of the note the predecessor itself took over from is in the header; and a tool result is cut to
its first 500 characters with a marker, every call keeping its input). Asking
the session to write it (`mode: "agent"`) stays an option in both.

- **Arguments**: the target session, the receiving tool (the same by default), the note mode (`record` by default),
  and extra words for the new session, which its opening message gives after the note's opening as the
  Assistant's (`handoffOpening` in `packages/protocol/src/handoff.ts`, the window's own opening, now shared).
- **Who may hand off what** (`HandoffFlow` in `sessions/handoff-flow.ts`, the seat's checks in
  `sessions/assistant-seat.ts`):
  - Only the Assistant has the tool (`profileAllows`): a lead (`scoped`), an ordinary session (`reader`),
    a builder and an app's agent do not, and the seat refuses it for any view but the central one.
  - The target is a session of this computer the Assistant sees, and of those only a project's ordinary session:
    never the Assistant itself, an Assistant or coordinator, an app's session (its builder or an agent an app
    started: the successor would not carry the tie to the app), a linked machine's session (handed off there), or a
    worktree session (refused with the window's reason).
  - A target mid-turn (working, waiting on an approval or a question) is refused, without a card: a handoff never cuts
    a running turn. A target in an error state cannot write a note, so `agent` is refused there with a pointer to the
    record.
  - The receiving tool is checked first (`toolProblem`: an adapter, installed and signed in): a tool that cannot start
    a session is refused before any card, so a name the model made up never reaches the person's eyes.
  - A handoff that guards nothing asks no one (#1509, owner 2026-10-24): the target is at rest (the check above) and the
    preset the successor takes, which is the original's, is within the Assistant's own (`HandoffFlow.covered`). The original
    stays and the Assistant hands over no power it lacks. It is read again where the successor starts, after an agent's note too. A target above the
    Assistant's preset takes the card below.
  - Otherwise the person's consent is a card in the Assistant's own session for each handoff (`askHost`, an `other` card with
    `about: "session_handoff"`), naming the target, the receiving tool, where the note comes from, the preset the new
    session runs under and the extra words. Every name on it is someone else's text and is JSON-quoted; the extra words
    are cut at 400 characters and the card says so and gives the full length. Under the Assistant's own `auto` the
    boundary is open (#603) and logged as `session_handoff of <target>`. "Always" lasts for that Assistant while this
    host serves it, never for a project (`sessionOnlyAlways`), as an update's does, and is recorded only for a call that
    passed every check after the card. Every check runs again after the card: a turn started while the card stood is
    not cut short. Every refusal is logged with the caller and the target.
- **What it does** is the window's handoff without the deletion: the note is written to the same file
  (`<data>/handoff/<project>/<session>.md`), the successor is created with the original's settings (none of the
  tool-specific ones when the tool changes), the original's preset and name, and the note as its marker. Its opening
  message is stored and shown as the Assistant's (`from`, the internal `initialFrom` of `createSession`), not the
  person's. The record labels every row another session or an app sent with its source and carries its text as one JSON
  string, as read_session does; only the person's rows are `[user]`, so a child's report cannot read as the person's
  instruction in the successor's note. A row starts only at the start of a line and its later lines are indented,
  tool titles and paths stay on one line, and the predecessor's name is JSON-quoted (#797), so no line of the
  session's own text can start a row either. Creating it
  moves the original's children ([handoff.md](handoff.md), scope `kept`): **the original always stays**, and is told in its
  conversation who took over. The person removes it.
- **Agent mode** sends the window's prompt (`handoffPrompt`, now in the protocol) as the Assistant's message, waits
  for the turn to end and reads the note from the store (`exportHandoffNote`). The turn's end is read as start_agent
  reads a child's (`AgentRunWait` among `turnObservers`, #428): a turn that fails, hits a limit or is stopped, or ends
  with no note, answers at once and says which, instead of the bound's "wrote no note". The call waits up to 240 seconds, under
  the Codex bridge's 280; past that it answers "still running" with a handle, the handoff goes on, and calling again
  with `waitFor` set to that handle waits on that run. The handle's result is read once and kept at most ten minutes;
  a run nobody waits on frees its session when it ends, so a later call on that session is a new handoff. One handoff
  per session at a time: the session is claimed before anything is awaited and freed when the whole run ends, and a
  call that finds it claimed is refused. The note may take ten minutes, as in the window.
- **Not done**: the grid slot is not swapped (the window does that for its own handoff), and a host swap while an agent
  is writing its note drops the handoff (the request and the note stay in that session's conversation; call again).
  The card waits like `create_project`'s, so on Codex a card left standing past the bridge's bound ends the call there
  while the card stays.

## The Assistant starts sessions outside any project (#853)

Handing off light work unrelated to any project (a web search, a lookup), the Assistant reached for its CLI's own
subagent, which never appears in Centralu: the person could neither watch it nor step in. It now has `start_agent` and
`agent_session` too, as commands of the `commands` tier (`RARE_COMMANDS`, reached through `centralu_run`; a direct
tool in the other tiers), and one line of its instructions says to use them rather than its Agent tool. The flow is
[../delegation/start-agent-steps.md](../delegation/start-agent-steps.md)'s (`AgentStartFlow`) with the Assistant as the caller and no project as the place
(`ASSISTANT_PLACE`, an empty id):

- **The child** has no project (`projectId: null`), is marked `askedBy` the Assistant, and works in a folder of its
  own, `<data>/orchestrator-agents/<uuid>` (`newAssistantAgentFolder`), never the Assistant's: a file a child
  left in the Assistant's folder (Codex loads `.agents/skills` from it whatever the trust) would reach the session
  that directs every other one, and children sharing one folder wrote over each other (#994 review). The folder goes
  when the child is deleted for good (`purgeSession`), and with a start that fails. It runs under the Assistant's
  preset and gets no Centralu tools and only the person's own settings (no project to trust). There is no worktree,
  and a busy child is not forked: there is no repository to fork from. In the sidebar it hangs under the
  Assistant's row (`assistantChildren`), folded until the mouse rests on its button (#1591), with a ⋯ menu to stop or delete it; a child whose assistant was
  replaced stays there under "Started by an earlier assistant".
- **The consent**: a card under `safe` and `normal` (no project's trust stands in for it), naming no project
  ("Start Codex in a folder of its own, outside any project, …") and offering no "Always for this project"; ⌥a, or that
  answer from an older window, is kept as always for the Assistant while this host serves it, which the card says
  ("lasts until Centralu restarts"). `auto` opens it. The depth binds as for any caller; the Assistant is at 0, so
  its child starts none.
- **The rest is the same**: the per-place ceiling (`agentCeilingError`, counted over the Assistant's children that
  are still here, and worded as "agents you started"), the
  finish notice through the report path, a request kept across a swap (its `projectId` is the empty place id), and
  `agent_session` status, wait, stop and delete, and more work by `mail` send, on a child whose `askedBy` is the Assistant and no other
  session in any preset. Its answers name `centralu_run(command="agent_session", …)` for the Assistant.

Characters: the Assistant's instructions grow by the one line (Claude 8,744 → 8,893 resident, Codex 8,796 →
8,945, under its 9,500); the two tools' definitions ride in no request in the default tier. Not measured live:
whether the Assistant then reaches for `start_agent` rather than its Agent tool. Not done: a read-only research
preset for such a child (the issue's suggestion); it runs under the Assistant's preset as any child does.
