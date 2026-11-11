# Starting other agents in the same project (`start_agent`, `agent_session`, #561)

An ordinary session can start another agent, Claude or Codex, in its own project and work with it: a Claude session
hands implementation to Codex and reviews the result, without a shell `codex exec` the app does not show. Built on
ask_project's machinery (`Delegation`, `AgentRunWait`, `ASK_WAIT_MS`, `turnAnswer`), in the reader set with its
own budget (`AGENT_TOOLS`, `AGENT_BUDGET_CHARS`).

"The turn's answer" has one rule, `turnAnswer` in `sessions/turn-answer.ts` (#428): the text after the turn's last tool
call, reasoning skipped, messages joined as paragraphs, and with `afterSeq` only the rows after the previous answer (a
queued turn has no user row of its own). A delegation's, a child's and an app's agent's answer read it; a preview
(`previewOf`, the report's "Last response") reads `lastResponse`, the same rule at the last text the agent wrote, and
is cut by `clipPreview` (its head and an ellipsis), on this host and for a linked machine's session (`lastWords`) alike.

| Tool | Arguments → what comes back |
|---|---|
| `start_agent` | `{ task, tool?: string, model?, effort?, difficulty?: light\|standard\|heavy, wait?, worktree?, branch?, lsp? }` → the child's id and name, and its answer (`done`) or `working`; or `pending` with a request handle while the person's card stands (#673), or, with `lowMemory`, while an allowed start waits for memory ([child-workspace.md](child-workspace.md#what-a-child-costs-the-machine-code-intelligence-and-the-memory-gate-686), #686). `lsp: true` keeps the child's code intelligence ([child-workspace.md](child-workspace.md#what-a-child-costs-the-machine-code-intelligence-and-the-memory-gate-686)) |
| `agent_session` | `{ sessionId?, action: status\|send\|wait\|stop\|delete\|answer\|list, text?, card?, ifBusy? }` → the same states, plus `at_rest` (nothing the caller gave it runs; its last answer), `asking` and `answered` (a card in the turn the caller gave it, [delegated-turns.md](delegated-turns.md), #676), `mailed` (a send to a session that cannot take it now went as a mail task, [delegated-turns.md](delegated-turns.md#requests-to-a-busy-session-677)), `queued` (a note held for a busy child on a linked machine, below), `stopped` and `deleted` (a child moved to the session archive; worktree cleanup also preserves local work, #608/#637). `list` needs no `sessionId`: the caller's own children (`askedBy`) still here, each as working, waiting, `paused (background work)` (its turn ended while its own background commands or the tool's background subagents run, #2146; `pausedOnBackground`, protocol session-state.ts; the screen shows such a session as waiting with the background dot, not running, 2026-11-10), finished or stopped, asleep or not, its last activity, and a worktree branch not merged yet (#690) |

**Cleaning up after a child (#690).** On 2026-10-14 a parent integrated fourteen children's answers and deleted none of
them until the person said it could; asked why, it said it had forgotten the last step, and nothing it read named it.
Every answer that hands a child's result to the session that started it now ends with one line naming the delete:
`done` and `at_rest` (`cleanUpLine`, `sessions/tool-answers.ts`), and the report of a finished turn
(`ChildReports.cleanUpWords`), which also says how many of its other children have ended their turns and remain, and that `list` shows them.
The line says to archive the child once its answer is used and to keep it only if more work on the same thing is coming soon (#1482).
The line is said only of the caller's own child (`askedBy`; under `auto` agent_session also reads the person's sessions
and siblings) whose work is over: not a turn cut short (`interruption`), failed or limited, nor one owing a report over
its own background work (`cleanUpDue`, `sessions/own-agents.ts`). The report counts with the same rule `list` uses
(`ownAgents`, `agentState` on `agentLook`: a delegation still running is working, a cut-short turn is stopped, one being
archived is gone). `agentLook` (protocol `session-state.ts`) is the one label a linked child's row and the mail directory
read too. Whether a session is busy is one rule beside it (`atRest`, #2158): in a turn, a card open (`needsAnswer`), or its
own background work running; delete, delete_session, handoff, worktree cleanup and the host's idle rule (`sessionBusy`)
refuse or wait on it. `busyWith` is that rule written out once and names the part that holds (a card, a turn, background
work): `atRest` reads it, and so do the checks that say why (handoff's refusal, the window's handoff note, `sessionIdle`). `list` takes `askedBy` only, as status, send, wait and stop do: a `parentSessionId`-only link is the former
worktree manager's, which store step v48 copied into `askedBy`.
The line rides in the answer, not in `start_agent`'s description: it costs nothing until the result is read, which
is the moment it applies. Nothing deletes a child on its own: a delete can drop a branch, and even with the session archive it
stays the parent's or the person's call. Sleep (#568) already frees a finished child's memory.

The optional `tool` is a registry name, accepted as a string by the schema and checked against the
current registry at call time. An unknown name returns an error listing the installed tools; adding
an adapter does not require changing this schema.

Under `auto` (#603), the host's shared `autoBoundaryOpen` decision opens consent,
project trust and same-project ownership gates, with allowances logged; a session still starting counts by the preset
it was created with (#2159). Project trust is one gate, `ProjectRegistry.trustGate`: one refusal (`Project "<name>" is
not trusted, so <what> is refused`) and a log line at each crossing. What only reads trust (whether a card is needed,
how far a seat reads, the preset a created session gets, the mail hold, which stays held under `auto`) reads
`ProjectRegistry.projectTrusted`, through the module's host. It does not open the agent depth (#867):
`auto` children each starting their own once ran twelve sessions at once (#862). Worktree cleanup keeps local work
in the session archive under every preset (#608).
`agent_session` can status, wait, send or stop any session in the same project, and delete
any worktree session there,
including another parent's child or the person's turn; adapter mid-turn support and the
child's own preset still apply. Deleting a session without a worktree still requires the caller to have started it
(`askedBy` or `parentSessionId` equals the caller), even under `auto` (#637). Observing an app agent reuses its completion watcher, so
`run_agent` still receives its answer and the agent keeps its own preset. Cleanup removes an idle worktree and branch even with dirty files or an unproven tip, after setting aside
local work with the conversation in the session archive (#608). `run_agent`
app agents start under `auto`, never above any session with a call open into the app (owner decision 2026-11-05, `AppCalls.agentCallers`), and no session gets a preset above its caller. When auto observes another
caller's unfinished delegation, its wait has its own bound and cancellation and returns
`reported: false` while working. It does not consume the owner's report, key, waiter count
or read grants. A stop leaves the owner's failure report and result available, including
cross-project `ask_project` delegations. An observer's mid-turn note rides on a reader of its
own (#646): its receipt is held, and its failure recorded, there and never on the owner's wait,
so the owner still reads its own answer, not the reply to the note, and a refused note does
not fail the owner's delegation. The observer's later `status` and `wait` read that reader (the
reply to its note, or the refusal), never the owner's delegation; a refusal no wait is reading is
said once in the observer's session, as a report is. Self wait, stop, delete and send are refused in
all presets; self status does not create a delegation. A person's own turn or an app request
without a delegation is also observed without registering ownership: the app's existing
completion watcher is reused, or a temporary event reader watches the person's turn and
is removed when the observation ends. These observations do not add a `waitsOn` dependency,
prevent an idle caller from sleeping, or stop the target when the caller is interrupted.

**Size.** The two definitions are 1,357 characters (`AGENT_BUDGET_CHARS` 1,375; 1,332 before #861's `name`, a bare string; 1,085 before #729's `difficulty` and the words on it and on `worktree`, +247 characters and +68 tokens, measured, in every ordinary Claude request, whose resident Centralu part goes from 2,313 to 2,560 characters; 1,060 before #686's `lsp`, which carries no description; 990 before #677's `ifBusy`, 956 before #676's `answer` action and `card`, 992 before the registry-name schema, 918 before the worktree arguments, 974 before `delete`). Claude loads `start_agent` (a request
made in words, like ask_project's, which deferred was not found) and defers `agent_session`, which every
`start_agent` answer names; Codex reaches both through its `exec` tool. Measured in tool-cost.md §10: +170 tokens per ordinary Claude request (412 → 582); "Have Codex …" reached `start_agent` 3 of 3 on Claude, "another agent" went to each CLI's own sub-agents. `name` (#861) is a short name
the caller gives: the child's name in the sidebar, and what its new worktree's branch is made from. Without one, the
child is named from its task (a worktree child by its branch), skipping the leading words the task shares with a
sibling's name (`distinguishingText`, at least two of them), and the person renames it.
