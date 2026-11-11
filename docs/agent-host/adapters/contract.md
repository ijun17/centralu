# The AgentAdapter contract (the implementation spec for product spec §6.2)

```ts
interface AgentAdapter {
  readonly tool: ToolName                  // a closed enum in @cc/protocol — see #74
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>          // installed / logged in (FR-19)
  installedVersion?(): Promise<string | null>  // #297: the CLI installed now, read without a session (../lifecycle/agent-cli-updates.md)
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>
  resume(externalId: string, opts): Promise<SessionHandle | null>  // null = resume not possible
}

interface SessionHandle {
  readonly externalId: string
  send(input: UserInput, opts?: { origin?: InputOrigin }): void  // origin: only { kind: 'human' }, for the person's own typing
  sendTracked?(text: string, observer?: InputObserver): Promise<void> // host-only completion receipt (#592)
  respondApproval(requestId: string, decision: Decision, scope?: Scope): void
  interrupt(): void
  stopBackgroundTask?(taskId: string): Promise<void>  // #290: stop one background task alone
  dispose(): Promise<void>
  events: Emitter<NormalizedEvent>         // emits protocol types only
}

interface AdapterCapabilities {
  approvals: boolean            // can permissions be overridden per session (reflects the M0 result)
  contextUsage: 'exact' | 'estimate' | 'none'
  resume: boolean
  autoTitle: boolean
  attachments: ('image' | 'file')[]
  verbosities: string[]         // response-length steps; empty = the tool has no such knob (#54)
  exclusiveWriter: boolean      // nobody else can write the conversation while we hold it
  backgroundTasks: boolean      // reports its background work as `background_tasks` (#290)
  toolDeferral: boolean         // can individual Centralu definitions wait behind tool search
  instructionChannel: 'server' | 'developer' // where Centralu's tool instructions reach the model (#525)
  processModel: 'per-session' | 'shared-server' // whether one CLI process owns one or several conversations
  builtInSubagents: boolean     // child-agent events are normalized by this adapter
  subagentTool?: string         // what the model calls the CLI's own subagent tool; the reader's `start_agent` line names it (#1587)
  peerMessaging: boolean        // the CLI has a direct session-to-session path (#575)
  midTurnInput?: boolean         // send accepts a message during a running turn without interrupting it (#592)
  sleep?: boolean               // #568: an idle session may be put to sleep (resume measured to keep the cache); ../lifecycle/agent-cli-updates.md "Putting idle sessions to sleep"
  presets?: PermissionPreset[]  // the presets it can keep; absent: all (Cursor keeps `auto` only, plans/acp-adapter.md §0.1)
  keepsRepoFilesOut?: boolean   // can be kept from a project's own files when untrusted (#92); absent: true
  roleText?: boolean            // takes Centralu's role text (`systemPromptAppend`); absent: true
}
```

Implementation rules:

- **External SDK types may not leave adapters/<tool>/** (anti-corruption). The adapter's only output is `NormalizedEvent`.
- **A tool call carries its card and its record** (#221). `summary` is what the card shows and may be cut short;
  `tool_call.input` is the input the tool received, as it received it, and `tool_result.output` is the whole text it
  answered, uncut, with images left out (they go out as `message_image`, #40). The host keeps the record in the store
  and strips it from everything it sends ([protocol.md](../../protocol.md) §2), so an adapter never has to choose between a
  small card and a complete record.
- **Claude's thinking arrives as text** (#2062). Current models send thinking blocks with no text unless asked for a
  summary, so every session starts the CLI with `--thinking-display summarized` (`extraArgs` in `sdk-query.ts`; not the SDK's
  `thinking` option, which would also pass `--thinking adaptive` and decide whether the model thinks). It changes what is
  shown, not what is thought or billed: measured on CLI 2.1.316, the output tokens of a turn stay the same. The CLI takes
  the flag since 2.1.100 at least; an older one refuses the unknown option and the session does not start. A CLI an older
  host started and this one adopts keeps the arguments it started with, so its thinking stays empty until it restarts.
- **A native subagent's steps go out wrapped, tagged with the launching call** (#222). Never as the parent's own events
  (#98): a `subagent_event` whose `step` is a text, reasoning, tool call or tool result, and whose `parentCallId` is the
  call that started the subagent. Claude: the subagent's messages carry `parent_tool_use_id`, and `forwardSubagentText`
  makes its text and thinking arrive, not only its tool blocks; the normalizer reads them as the parent's and wraps them.
  Codex: a child thread's `item/*` notifications arrive on the parent's connection with the child's `threadId`; the
  parent's `spawnAgent` item names the child in `receiverThreadIds` on `item/completed`, and a child's items that arrive
  before that (measured: the child's first notification came in the same millisecond, before the link) are held and
  replayed. Only official routes are used — the SDK's stream and the app-server's notifications, never the tools'
  transcript files. The manager stores the steps in `subagent_messages`, apart from the conversation, and sends them on
  as cards. A file a subagent changed is still reported as the session's (`files_touched`), and a commit it made is
  attributed to the session (#50).
- **Background work is reported as one level, `background_tasks`** (#290): every live task after a change (REPLACE
  semantics, so a missed message cannot leave a task "running"), and the tasks that just ended with their status
  (`completed`, `failed`, `stopped`). Each task carries `{ id, kind: agent | shell | mcp | other, description,
  parentCallId?, ambient?, stopsWithTurn?, stoppable?, timer? }` (`timer`: a timer the tool holds, not work, #721). `stopsWithTurn` is what interrupting the turn does to it,
  **as measured for that tool**, and absent where it was not measured; it is what the session's Stop control says
  before it is pressed. An adapter that cannot see its background work declares `capabilities.backgroundTasks: false`
  and sends nothing rather than guessing. An adapter that reports it also releases it: when its process goes away it
  sends the live set empty, with what it held ended as `stopped`.
  - **Claude** reads `system/background_tasks_changed` (the level; no tool_use_id), `task_started` (the launching
    call, `owned_by_subagent`), `task_updated` and `task_notification` (the ending). Measured
    (`scripts/probe-background-tasks.mts`, CLI 2.1.282, SDK 0.3.263): `interrupt()` mid-turn stops a background
    subagent (`task_notification` stopped, in the same millisecond) and **leaves a backgrounded shell running**;
    `stopTask(id)` stops one task with the same three messages; `close()` kills what is left and emits nothing.
  - **Codex** lists each child thread a `spawnAgent` item named while the thread is active, and ends it with the
    child's `turn/completed` status. Measured (`scripts/probe-codex-background.mts`, codex-cli 0.160.0):
    `turn/interrupt` on the parent's turn **leaves the child running**; `turn/interrupt` on the child's own turn stops
    it, which is the per-task stop. Codex's interrupt does not kill a command the child was running.
  - The manager keeps the list per session (`SessionInfo.backgroundTasks`, live-only like `goal`), applying each
    event with `applyBackgroundTasks` — the same function the UI's reducer and the mock run. `sessionIdle()` says
    whether a session's process can be swapped without losing work (#297): no turn, no pending approval or question,
    no running task that is not ambient, and never idle while a tool that cannot report background work holds a
    process. The rule itself is `sessionIdle` in `idle.ts`, next to `hostBusy` ([../lifecycle/updates.md](../lifecycle/updates.md)).
  - **The running tasks survive a host swap** (#648). The tool lists its level only when it changes and says nothing
    at startup, so a host that adopted a kept process read every session as idle, and the sleeper or a definitions
    refresh closed the process over a running dev server. The manager writes the running set to the store on every
    change and when a process starts (`background_tasks:<id>`, empty for a new process); the host that adopts the
    process lists the session from that record and hands it to the adapter (`ProcessSource.adopt.backgroundTasks`),
    whose tracker is seeded with it so the tasks' endings are reported (timers excepted: they are read back from the
    transcript). A session whose record is missing (the previous host predates it) is `background_unknown`, so it is
    not put to sleep, until the tool's own full list arrives (`background_tasks` with `snapshot`, Claude's
    `background_tasks_changed`), or until it has been quiet for two hours, which is logged and recorded as none. A level
    built from an ending or a timer neither settles it nor is recorded. The record goes when the session is deleted.
  - **Restarts and background work** (#648). A restart that changes safety (the permission preset, the launch
    settings, the tool definitions a profile serves) waits only for the turn: an idle session restarts at once, and a
    mid-turn change applies when the turn ends, whatever runs in the background or is unknown. Any other deferred
    restart (a model, an app set) also waits while listed background work runs, at most one hour
    (`applyDeferredRestart`, in `RestartPolicy`, `sessions/restart-policy.ts`). A restart that ends background work, or work that is unknown, says so in the
    conversation first (a `restart` notice naming the tasks).
- **The CLI version a process runs is reported once per process, as `agent_version`** (#297). Claude: the init
  message's `claude_code_version` (init comes again with every query; only a change is sent). Codex: the `initialize`
  answer's `userAgent`, `<client name>/<server version> (<os>) …` (measured, codex-cli 0.160.0:
  `centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)`); `protocol-contract.json` lists the
  field so a rename fails the drift check. An adopted process says nothing again, so its version comes from the
  keeper tag ([../lifecycle/agent-cli-updates.md](../lifecycle/agent-cli-updates.md)).
- **What the tool tells its own user goes out, in its own words** (#304): a fresh conversation as
  `conversation_reset`, text meant to be read as `notice`, a setting the tool switched by itself as `settings_changed`
  with `by: 'tool'` (its snapshot is what the process was launched with plus the switched field; the host applies only
  what differs), a retry as the `retrying` activity until output flows again. Measured payloads (CLI 2.1.289 through SDK
  0.3.263, codex-cli 0.160.0, 2026-10-04) unless marked otherwise:

  | Tool | Message | Becomes |
  |---|---|---|
  | Claude | `conversation_reset {new_conversation_id, trigger: 'clear'}` on `/clear`; then an `init` with a new `session_id` | `conversation_reset` |
  | Claude | `system/informational {content, level}` — a `UserPromptSubmit` hook's block reason arrived as level `warning`, `prevent_continuation: true` | `notice`; level `info` is left out (the CLI shows it only in transcript mode) |
  | Claude | `system/notification {key, text, priority, color}` (not exercised) | `notice` at a level folded from colour and priority; "Error compacting conversation" is left to the failed-compaction marker |
  | Claude | `system/api_retry {attempt, max_retries, retry_delay_ms, error_status, error}` — a 529 answered twice, then a synthetic "API Error" message and an error result | `retrying` once per episode plus a host.log line per attempt; the previous activity comes back on the next stream event or assistant message |
  | Claude | `system/model_refusal_fallback` (not exercised; sdk.d.ts) | scope `session` or absent: a notice and a `settings_changed` with the fallback model. Scope `local` (a subagent): host.log only. `retracted_message_uuids` is not acted on |
  | Claude | `system/model_refusal_no_fallback` (not exercised; the CLI sends `content: ""` on its main-thread paths) | held until the result: the failed turn's error message, or a notice if the turn did not fail. Text: `content`, else the refusal's explanation, else its category |
  | Claude | an `assistant` message with `error` set (model `<synthetic>`): the CLI writes a failed request's words as if the model said them, e.g. `error: 'model_not_found'` before an error result with the same `result` (CLI 2.1.296, #2050) | no bubble: held like the refusal above, so a failed turn shows its words once, as the error line; a turn that goes on after one gets a notice labelled `api-error` (not recorded) |
  | Codex | `configWarning {summary, details}` while `thread/start` is answered, then `warning {threadId, message}` with the same text, on every start and resume | `notice` with `oncePerSession`; the unknown-key text becomes "Codex ignored N settings in `~/.codex/config.toml`", the keys one per line, `for you` |
  | Codex | `deprecationNotice {summary, details}`: the owner saw "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`…" (#342). `guardianWarning {threadId, message}` (not exercised) | `notice` (the first once per session). The full-history one becomes "Codex says Centralu loads thread history in an outdated way", `for Centralu` |
  | Codex | `mcpServer/startupStatus/updated` — a failing server goes `starting` → `failed {error}` twice on one thread start | one `notice` per server in Codex's words (`MCP client for \`x\` failed to start: …`), again only after it started in between |
  | Codex | `model/rerouted {turnId, fromModel, toModel, reason}` (not exercised) | `notice` only: it names a turn, and the thread's settings do not change with it |
  | Codex | `thread/settings/updated {threadSettings}` (not exercised) | measured against what `thread/start`/`thread/resume` answered (Codex answers a default with a concrete model), and only a real difference becomes a notice and a `settings_changed` |
  | Codex | `thread/resume` answers `model` and `reasoningEffort` of the thread; a failed turn's `error.message` is the provider's body, e.g. `{"status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."}}` (#1369) | The session's model is sent with every `thread/resume` and `turn/start` (`TurnStartParams.model`: "this turn and subsequent turns"). What the resume answers is compared with what the session shows: no model recorded, or another one answered, and the thread's model (and effort) become the session's, taken by the host as it registers the handle (`SessionHandle.takeOpenedSettings`, `sessions/opened-settings.ts`; a resume that answers later sends a `settings_changed` the tool made), with a warning notice for the second. A recorded model that the thread answers alike changes nothing, and a session started here on the default stays on it (Codex answers a default with a concrete value, which nobody chose); only a conversation taken over from elsewhere adopts the thread's values when its record is on the default. Turns ask for the thread's model only after a mismatch with a recorded one, and again after a switch made outside Centralu (`thread/settings/updated`), so no turn undoes what the screen shows. So the screen never names a model other than the one running. A refused model is an `error` with `retryable: false` and `data: {reason: 'model_rejected', model}` (`code` stays `internal`, so an older window shows it as any failed turn); the window adds "Pick another model", which opens the session's model menu. Not exercised against a live account: the PC it was written on had no Codex login |

  A child thread's notifications stay out of the parent's conversation, as before.

  Every notice also carries who is speaking and what kind it is (`from`, `label`), and where the adapter can tell, who
  has to act (`audience`, #342). Codex's are worded in `adapters/codex/notices.ts`:

  | Codex notice | Line | Whose |
  |---|---|---|
  | unknown `config.toml` keys (`configWarning`, its `warning` twin) | "Codex ignored 2 settings in `~/.codex/config.toml`", keys one per line, "Codex already runs without them; removing them from the file only silences this notice." | `you` |
  | other `configWarning` | Codex's text | `you` |
  | full-history hydration (`deprecationNotice`, both wordings in the 0.160.0 binary) | "Codex says Centralu loads thread history in an outdated way", "Nothing to do on your side; Centralu will switch to the paginated API (#342)." | `centralu` |
  | other `deprecationNotice` | Codex's text | `centralu` if it names an app-server method (`thread/…`, `turn/…`, `review/…`), `you` if it names `config.toml` or `[features…]`, else unsaid |
  | MCP start failure | Codex's text | `centralu` for Centralu's Centralu tools bridge, unsaid for an app's bridge (`app-<id>`, it may fail for the app's reasons), `you` for any other server |
  | `warning`, `guardianWarning`, `model/rerouted`, thread settings changed | Codex's text (or ours, for the last two) | unsaid |

  Claude Code's notices carry `from: 'Claude Code'` and a label (`hook` — `for you`, `notice`, `model switch`,
  `refusal`). The explanation is the host's because recognizing a notice means knowing the tool's wording; the screen
  only draws what it is given, and Codex's own words stay one click away.
- **A turn the provider ends for want of capacity is retried by the host** (#1693, `sessions/overload-retry.ts`). Codex ends
  a turn with `TurnError.codexErrorInfo: "serverOverloaded"` ("Selected model is at capacity"; the turns of the issue had run
  14 to 44 minutes) with no `Reconnecting…` of its own first, and the adapter marks that error alone with
  `data: {reason: 'server_overloaded'}` (never a usage limit or any other error; the marker comes from Codex's kind, not from
  the sentence). The host does not let it end the turn: the session stays `working` (so whoever gave the turn is told nothing
  yet), a `notice` (label `retry`) says "in 30 s (retry 1 of 4)", and after the wait the turn is continued through Centralu's
  channel (`deliverMail`: no message of the person's, as an update's continue). The waits are 30 s, 2, 5 and 10 minutes. A
  fifth failure ends the turn as before, with "Centralu retried this turn 4 times" added. The count starts over when the turn
  finishes, the person sends a message or stops it, or it ends any other way. **Stop** cancels the wait and ends the turn as
  a Stop does, also while the note is on its way (it is handed to the tool only if the retry still stands). Once the note is
  handed to the tool the turn is the tool's: a Stop stops that turn like any, and a message joins it like any message into a running
  turn. **A message of the person's** before that takes the retry away first, so theirs goes in and the note does not; if
  theirs is refused, the error the retry stood in for ends the turn. The note asks the agent to check what already happened before repeating a step, and is
  Centralu's own in the history read-back (`isCentraluNote`: the catch-up never stores it as the person's message). **The
  host leaving** (a quit, an update or a swap): the wait lives in that host only and nothing is stored. The turn's end was the error the
  host swallowed, which no later process replays, so the leaving host ends the turn with that error now ("Centralu was
  going to retry this turn, but it restarted first. Send a message to go on."); no later host sends anything. It says so before the host is marked as leaving, so the
  end is the provider's error and not a quit's stop; a note already handed to the tool leaves as any running turn does. A session with
  no process when the time comes ends the same way. **A hub's `ask_project` task** marks its depth for the input (`hub_ask_depth:`), and Codex fails the tracked input when the turn
  fails, before the host sees the error: the failure takes the mark down only when no retry stands once the error was seen
  (`OverloadRetry.stands`); the end the turn reaches later takes it, so the continued turn keeps the depth (#2015). Other observers of a
  tracked input's failure (`start_agent` or `ask_project` notes into a running turn) still read a held error as a refusal (#2029).
  **A crash of the host** during the wait ends the process with it: the next start finds the session `working` with no
  process and marks the turn stopped, as any crash's ([../lifecycle/turn-endings-and-mail.md](../lifecycle/turn-endings-and-mail.md)). The retry is not resumed (it lived in the dead host).
  Before #1895 step 4 PR 1 a keeper kept the process, and the next host that took it over idle ended the turn as one a
  swap could not continue (Codex's `adoptedIdle()`, #2020). **Claude** is not covered: its CLI retries a 529 itself
  ten times with a growing delay (`api_retry`, the `retrying` activity) before it ends the turn, so a retry here would stack
  on that.
- Adapters hold no state — tracking session state is done by `sessions/` watching events. The adapter is a converter.
- **What both adapters do the same way is written once, in `adapters/session-kit.ts`** (#428), since copies of it
  drifted into bugs. A line Centralu itself says in a chat (a `/goal` confirmation or refusal) is `adapterNotice`: an
  assistant message with its own `messageId` (`centralu-notice-<n>`, counted across the host), so the record never
  joins it onto the model's open reply. Codex's `/goal` replies named no message and were glued onto it mid-turn.
  A message the person sent that the CLI will never read is said with `undeliveredError` / `undeliveredText` ("N
  message(s) were still queued when the session closed and were not delivered — please resend"), never dropped: the
  screen already shows it as sent. Codex closed while a lazy resume was still waking used to drop the messages sent
  meanwhile without a word (both places that spoke for them stood aside for each other); `dispose` now says them, and a
  resume that fails or outlives its cap names them inside the one error that retires the handle.
  Open cards are a `PendingCards`: every way a card goes (answered, withdrawn by the CLI, the turn stopped, the handle
  closed) goes through `take` or `release`, which removes it before it is closed, and the adapter says
  `approval_resolved` / `question_resolved` there. A turn is said stopped only once the tool confirms the
  stop by ending the turn: Codex's `turn/completed`, Claude's result (owner decision on #1654: the answer to the
  interrupt only accepts it). Claude used to say it at once, so a rejected interrupt showed the turn stopped while the
  CLI kept working. A Stop that has not taken effect (either tool refuses the interrupt, or the turn has not ended
  within `stopConfirmMs`, 10 s, for every tool: "<tool> has not confirmed the stop; the turn may still be running.")
  leaves the turn running, and is said as a notice (`stopNotConfirmed`, label
  `STOP_NOT_CONFIRMED_LABEL`), not an error: an error moves the session to `error`, which the manager takes as the
  turn's end (delegation waits settle, queued requests go in), and the turn's own ending (`waiting_input`) is not a
  move `error` allows. The notice also clears the wait's `stoppedByPerson` (`AgentRunWait`), so a child that then
  finishes hands its answer to the one waiting. A second Stop joins the first one's wait and bound; one pressed after
  the bound was said starts the bound again on the same wait. A turn's end after the bound still ends it as
  stopped. A turn that fails or hits a limit while a Stop waits ends as it did: nothing says it stopped after that.
  Only an idle Claude session's refused interrupt is still `couldNotStop`, after it was said stopped. The window's
  Stop button says "Stopping…" from the click until the turn ends, through an approval in it, and shows the notice's
  text when there is one (`stopping`, ActivityRow). Cards are still answered with a refusal before the stop is known
  to work, so a tool whose card was denied stays denied when the stop is refused.
- **"Always allow" adds the matcher the answer carried, and nothing without one** (`always-allow.ts`, both adapters).
  The UI computes and shows the matcher and the manager saves exactly it, so the live rule, the saved rule and the
  screen agree. Claude used to fall back to the command text: a rule nobody saved or named, gone at the next restart.
  The key and the match are written once, in protocol (`alwaysAllowKey`, `matchesAllowRule`), and core's suggestion
  and preview, the UI's matcher and both adapters read them: a command trimmed, a file edit's path, nothing for an
  edit with no path (the card offers no "always" for it and the manager saves no "(no path)" rule), none for a command
  flagged outside the sandbox, for the network or as terminal input or ending in `*`, and an exact match with `*` a
  literal character (#838; it was a wildcard at the end, which made "always" on `cat logs/*` a prefix rule). The copies had drifted: a command with surrounding whitespace never matched its own rule,
  and core's preview read a `*` in the middle as a wildcard the host did not honour.
- Process management (spawning the CLI, crash detection) is the adapter's own responsibility. A crash is emitted as an `error` event and the host does not die.
- **A launch a tool declared it cannot keep is refused before any process starts** (`presets`, `keepsRepoFilesOut`,
  `roleText`; `launchRefusal` in protocol, applied by `startFit` in `sessions/session-start.ts` at every start and wake, and through `ToolRegistry.refusal` with
  the session read by `sessionDemands` (`sessions/tool-fit.ts`) to a tool switch, a preset changed on a running session
  and the Assistant's tool).
  The host is the gate whatever path asked; the pickers ask the same rule and grey the tool with the same words.
  Claude and Codex declare none of the three, so nothing changes for them ([plans/acp-adapter.md](../../plans/acp-adapter.md) §0.1).
- A capability is not necessarily a static declaration; it can be **decided at detect() time** (e.g. if whether approvals work depends on the Codex version, decide after detecting the version — the C4 response).
