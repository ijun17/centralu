import type { ApprovalDetail, NormalizedEvent, SessionGoal, SubagentStep } from '@cc/protocol'

/**
 * Codex protocol to NormalizedEvent conversion (based on the method names confirmed in M0).
 *
 * This is the anti-corruption boundary. No Codex type leaves this file.
 * Kept as pure functions so contract tests can run without a process.
 */

type Notification = { method: string; params?: unknown }
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/**
 * What the tool **actually answered** — the body that goes on the card.
 *
 * This used to read only `aggregatedOutput`/`output`, but those are fields of commandExecution.
 * **An MCP call carries its answer in a different place** (generated/v2/ThreadItem.ts: `result`
 * and `error`). So when an MCP call failed, the screen showed only a red line with not a single
 * character of reason — during dogfooding, "why does this skill only fail in this session" had to
 * be figured out by asking the agent itself (measured 2026-09-08: the same tool had succeeded in
 * another session 90 seconds earlier, while the failed one's card was blank).
 *
 * Order: command output, then error message, then result content. Error comes before result
 * because when both exist, the reason for failure is what a person needs to know first.
 */
function resultSummary(item: Record<string, unknown>): string {
  const direct = str(item.aggregatedOutput) || str(item.output)
  if (direct) return direct

  const err = str(obj(item.error).message)
  if (err) return err

  const content = obj(item.result).content
  if (Array.isArray(content)) {
    const text = content
      .map((c) => str(obj(c).text))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  const structured = obj(item.result).structuredContent
  // Some servers only give a structured answer — one line of JSON beats an empty card
  if (structured && typeof structured === 'object') {
    try {
      return JSON.stringify(structured)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * The fields of a thread item that say how it went rather than what was asked (generated/v2/ThreadItem.ts): the
 * status, a command's output, exit code and PTY, an MCP call's result and error, a dynamic tool's content, a search's
 * results, a generated image (base64) and where it was saved. On `item/started` they are empty or null; they are
 * listed so that a started item never carries half a result.
 */
const ITEM_OUTCOME = new Set([
  'id', 'type', 'status', 'aggregatedOutput', 'output', 'exitCode', 'processId',
  'result', 'error', 'contentItems', 'success', 'results', 'agentsStates', 'failure', 'savedPath',
])

/**
 * What the tool was asked to do, whole — the call's `input` (#221): everything on the started item but its identity,
 * its outcome and the fields it has no value for yet (a command's `durationMs` is null until it ends; a sleep's is
 * what it was asked for). That is a command with its working directory, a file change with each file's diff (the
 * title keeps only the paths), an MCP call's server, tool and arguments. Picking fields per item type would drop
 * whatever a new Codex adds; this keeps it.
 */
function itemInput(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([k, v]) => !ITEM_OUTCOME.has(k) && v !== null && v !== undefined))
}

/** A tool-call item, into a human-readable line (the conversation card's title) */
function itemSummary(item: Record<string, unknown>): { tool: string; title: string; readOnly: boolean; paths: string[] } {
  const type = str(item.type)
  if (type === 'commandExecution') {
    const cmd = str(item.command)
    return { tool: 'Bash', title: cmd, readOnly: isReadOnlyCommand(cmd), paths: [] }
  }
  if (type === 'fileChange') {
    const paths = fileChangesOf(item).map((c) => c.path).filter(Boolean)
    return { tool: 'Edit', title: paths.join(', ') || 'Edit files', readOnly: false, paths }
  }
  if (type === 'mcpToolCall') {
    /*
     * The name lives in **the top-level server and tool** (generated/v2/ThreadItem.ts). We used
     * to read invocation.tool, which made every one of Codex's MCP calls collapse into a single
     * 'MCP' — this surfaced while running the orchestrator on Codex.
     */
    const tool = str(item.tool) || str(obj(item.invocation).tool)
    const server = str(item.server)
    // The proposal card (#63) uses the reason as its title — same rule as toolSummary on the claude side
    if (tool.endsWith('propose_project')) {
      const rawArgs = obj(item.invocation).arguments
      let reason = ''
      try {
        const parsed = typeof rawArgs === 'string' ? (JSON.parse(rawArgs) as unknown) : rawArgs
        reason = str(obj(parsed).reason)
      } catch {
        /* If the arguments are not JSON, the card just shows up with no reason — the button still works */
      }
      return { tool, title: reason || tool, readOnly: false, paths: [] }
    }
    // Worktree proposal (#69) — the branch name is the title, and that title is the only channel for the UI's prefill
    if (tool.endsWith('propose_worktree_session')) {
      const rawArgs = obj(item.invocation).arguments
      let branch = ''
      try {
        const parsed = typeof rawArgs === 'string' ? (JSON.parse(rawArgs) as unknown) : rawArgs
        branch = str(obj(parsed).branch)
      } catch {
        /* If the arguments are not JSON, the card just shows up with no name — the window opens with a blank name */
      }
      return { tool, title: branch || tool, readOnly: false, paths: [] }
    }
    /*
     * **The arguments go on the title too** (dogfooding 2026-09-08).
     *
     * There was a case where the same tool kept failing in only one session. The cause was a single
     * argument name — the call that worked used `{message: …}`, the one that failed used
     * `{query: …}`, and the server answered that difference with nothing more than "An unexpected
     * error occurred". Since the screen only showed the tool name, the two calls looked identical,
     * and a person had to open the rollout file to find out. With arguments on the card, that
     * difference is visible at a glance.
     */
    const args = argsPreview(item.arguments ?? obj(item.invocation).arguments)
    const name = [server, tool].filter(Boolean).join(': ') || str(item.title) || 'MCP tool'
    return {
      tool: tool || 'MCP',
      title: args ? `${name} ${args}` : name,
      readOnly: false,
      paths: [],
    }
  }
  if (type === 'webSearch') {
    return { tool: 'WebSearch', title: str(item.query), readOnly: true, paths: [] }
  }
  /*
   * A collab call (generated/v2/ThreadItem.ts `collabAgentToolCall`): spawning a child agent, waiting for it, sending
   * it more work. The card used to say "collabAgentToolCall" twice. It is named by the collab tool now, so a
   * `spawnAgent` card is recognised as the one that launched a subagent (#222, `launchesSubagent`), and it reads as the
   * work handed over: the prompt's first line, as a Claude agent card reads as its description (#98).
   */
  if (type === 'collabAgentToolCall') {
    const tool = str(item.tool) || type
    const line = str(item.prompt).split('\n')[0] ?? ''
    return { tool, title: line.length > 200 ? `${line.slice(0, 200)} …` : line || tool, readOnly: true, paths: [] }
  }
  return { tool: type || 'tool', title: str(item.title) || type, readOnly: true, paths: [] }
}

/**
 * The arguments, into one line (a tag on the card title).
 *
 * The goal is to show the **shape**, not the exact value, so it is cut short — it is enough to
 * see what was sent under what name, and the full body is on the result card anyway.
 */
function argsPreview(raw: unknown): string {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return raw.slice(0, 80)
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return ''
  const body = entries
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
  return `{${body.length > 80 ? `${body.slice(0, 79)}…` : body}}`
}

/** A read-only command collapses its card (same intent as core's policy — this only supplies the hint) */
function isReadOnlyCommand(cmd: string): boolean {
  const head = cmd.replace(/^\/bin\/\w*sh\s+-l?c\s+'?/, '').trimStart().split(/\s+/)[0] ?? ''
  return ['ls', 'cat', 'pwd', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'git'].includes(head)
}

/**
 * The changes a `fileChange` item carries (generated/v2/ThreadItem.ts: `changes: FileUpdateChange[]`,
 * each `{ path, kind, diff }`). The adapter remembers them per item id, because the approval request
 * for that item does not carry them (see approvalDetailFrom).
 */
export function fileChangesOf(item: Record<string, unknown>): { path: string; diff: string }[] {
  const changes = Array.isArray(item.changes) ? item.changes : []
  return changes.map((c) => ({ path: str(obj(c).path), diff: str(obj(c).diff) }))
}

/**
 * Turns a server's approval request into the card's detail.
 *
 * **A file-change request carries no change** (#169). Measured against codex-cli 0.153.4
 * (scripts/probe-codex-file-approval.mts, preset safe, one edit of one file):
 *
 *   item/started  {item: {type: 'fileChange', id: 'exec-4d7c…', status: 'inProgress',
 *                  changes: [{path: '/…/notes.txt', kind: {type: 'update', move_path: null},
 *                             diff: '@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n'}]}, threadId, turnId, startedAtMs}
 *   request       item/fileChange/requestApproval {threadId, turnId, itemId: 'exec-4d7c…',
 *                  startedAtMs, reason: null, grantRoot: null}            — 1ms after item/started
 *   item/completed the same item, status 'completed', the same changes
 *
 * The request names the item and nothing else. This read `params.item.changes`, which no version of the
 * request has, so every card had an empty path and an empty diff and the person approved blind. The changes
 * come from the item instead, which the adapter remembers by id and passes in as `itemChanges`.
 *
 * The older `applyPatchApproval` carries its own changes, keyed by path (generated/ApplyPatchApprovalParams.ts:
 * `fileChanges: { [path]: FileChange }`, where an update has `unified_diff` and an add or a delete `content`).
 * Not measured: app-server 0.153.4 sent the v2 request above.
 *
 * A command request carries its command and cwd at the top level (measured in the same run); `item` is
 * read first only because older versions were written against it.
 */
export function approvalDetailFrom(
  method: string,
  params: Record<string, unknown>,
  itemChanges?: readonly { path: string; diff: string }[],
): ApprovalDetail {
  if (method === 'item/commandExecution/requestApproval') {
    const item = obj(params.item)
    return { kind: 'command', command: str(item.command) || str(params.command), cwd: str(item.cwd) || str(params.cwd) }
  }
  if (method === 'item/fileChange/requestApproval') return fileEditDetail(itemChanges ?? [])
  if (method === 'applyPatchApproval') {
    const changes = Object.entries(obj(params.fileChanges)).map(([path, c]) => ({
      path,
      diff: str(obj(c).unified_diff) || str(obj(c).content),
    }))
    return fileEditDetail(changes)
  }
  return { kind: 'other', raw: JSON.stringify(params).slice(0, 2000) }
}

/**
 * The card for one or more file changes. The card prints the path and then the preview, so a single file's
 * preview is its diff alone; with several files each diff is headed by its own path, or the hunks of two files
 * would read as one. `(no path)` when nothing names a file — an empty string looks like a card that failed to
 * draw rather than a request that did not say.
 */
function fileEditDetail(changes: readonly { path: string; diff: string }[]): ApprovalDetail {
  const named = changes.filter((c) => c.path)
  const diff =
    named.length > 1
      ? named.map((c) => `${c.path}\n${c.diff}`).join('\n\n')
      : changes.map((c) => c.diff).filter(Boolean).join('\n')
  return {
    kind: 'file_edit',
    path: named[0]?.path || '(no path)',
    diffPreview: diff.slice(0, 4000),
    multi: named.length > 1,
  }
}

/**
 * Converts one notification into zero or more NormalizedEvents.
 * An unknown notification is **dropped silently** — this must not break as the protocol grows
 * (protocol.md §4).
 */
/**
 * codex ThreadGoal to protocol SessionGoal (2026-09-07).
 * The updated notification and the thread/goal/get called right after resume share this same
 * conversion — two copies would drift apart.
 *
 * **Complete means cleared** (dogfooding: the complete badge stayed forever). codex sends
 * updated(status:complete) rather than cleared when a goal is achieved, but an achieved goal is
 * an ending, not a state, and an ending is not the badge's job — the same convention as claude
 * (achieved -> a null notification). paused, blocked, usageLimited and budgetLimited survive:
 * those are states where action is still possible.
 */
export function goalFromCodex(g: Record<string, unknown>): SessionGoal | null {
  if (str(g.status) === 'complete') return null
  return {
    objective: str(g.objective),
    status: str(g.status) || 'active',
    ...(typeof g.tokenBudget === 'number' ? { tokenBudget: g.tokenBudget } : {}),
    ...(typeof g.tokensUsed === 'number' ? { tokensUsed: g.tokensUsed } : {}),
  }
}

/**
 * Every notification method the adapter handles or leaves out on purpose. Anything else is said once per session in
 * host.log (`UnmappedTypes`, #58). The groups follow the #58 survey (2026-10-04, codex-cli 0.160.0, 85 methods):
 *
 *   - mapped: a case below, or read in index.ts (`patchUpdated`)
 *   - ignored by #58: the git panel covers the diff, and the rest is internal detail
 *   - correctly ignored: features Centralu does not use (Codex app projects, realtime voice, client-run processes,
 *     fs/watch, fuzzy search, OAuth and login flows), the server's own bookkeeping (`thread/started`, `account/updated`,
 *     `serverRequest/resolved`), deprecated or unstable shapes, and Windows-only notices
 *
 * The methods the survey would show or store stay out on purpose: `warning`, `configWarning`, `deprecationNotice`,
 * `model/rerouted` and `thread/settings/updated` among them. Their log line is how a real instance gets noticed.
 */
export const CODEX_KNOWN_NOTIFICATIONS: ReadonlySet<string> = new Set([
  // mapped
  'error', 'thread/name/updated', 'thread/goal/updated', 'thread/goal/cleared', 'thread/tokenUsage/updated',
  'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'thread/compacted', 'account/rateLimits/updated',
  // ignored by #58
  'turn/diff/updated', 'thread/status/changed', 'mcpServer/startupStatus/updated', 'hook/started', 'hook/completed',
  'rawResponseItem/completed', 'rawResponse/completed',
  // correctly ignored
  'serverRequest/resolved', 'thread/started', 'thread/archived', 'thread/unarchived', 'thread/deleted', 'thread/closed',
  'account/updated', 'remoteControl/status/changed', 'item/fileChange/outputDelta', 'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed', 'autoApprovalReview/strictReviewRequired', 'item/plan/delta',
  'thread/attachment/updated', 'thread/queue/changed', 'project/changed', 'thread/project/updated',
  'thread/environment/connected', 'thread/environment/disconnected', 'command/exec/outputDelta', 'process/outputDelta',
  'process/exited', 'fs/changed', 'fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted',
  'mcpServer/oauthLogin/completed', 'mcpServer/event/stream/notification', 'account/gatewayOAuth/changed',
  'account/login/completed', 'app/list/updated', 'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed', 'turn/moderationMetadata', 'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted', 'thread/realtime/started', 'thread/realtime/itemAdded',
  'thread/realtime/item/started', 'thread/realtime/item/transcript/delta', 'thread/realtime/item/completed',
  'thread/realtime/transcript/delta', 'thread/realtime/transcript/done', 'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp', 'thread/realtime/error', 'thread/realtime/closed',
])

/** The message a chunk belongs to — left out rather than empty, since absent means "the same message as before" */
const messageIdOf = (id: unknown): { messageId?: string } => (typeof id === 'string' && id ? { messageId: id } : {})

export function normalizeNotification(sessionId: string, n: Notification): NormalizedEvent[] {
  const p = obj(n.params)

  switch (n.method) {
    /*
     * Each chunk names its agentMessage item (generated/v2/AgentMessageDeltaNotification.ts: `itemId`), and the
     * host starts a new row when that changes (#212). Without it, two messages with nothing recorded between
     * them were stored as one row. Measured (scripts/probe-codex-message-boundary.mts, codex-cli 0.153.4): two
     * commentary messages with a `write_stdin` poll of a running command between them. The poll arrives as
     * `item/commandExecution/terminalInteraction`, which is not an item, and the reasoning items between them
     * had no summary text. The row read "It is still running; I'm polling it now.It is still running; I'm
     * polling it again."
     */
    case 'item/agentMessage/delta':
      return [{ type: 'message_delta', sessionId, role: 'assistant', text: str(p.delta) || str(p.text), ...messageIdOf(p.itemId) }]

    /*
     * Reasoning summary (measured for #58). This stream only arrives if model_reasoning_summary
     * is turned on in the thread settings — index.ts turns it on. Measured shape:
     *   item/reasoning/summaryPartAdded {itemId, summaryIndex}         — a new paragraph
     *   item/reasoning/summaryTextDelta {itemId, delta, summaryIndex}  — a chunk of text
     * The completed reasoning item also carries the full summary text, but we do not emit it —
     * it already streamed through the deltas, so emitting it again would append the same text
     * twice (the same rule as agentMessage).
     */
    case 'item/reasoning/summaryTextDelta': {
      const text = str(p.delta)
      return text ? [{ type: 'reasoning_delta', sessionId, text }] : []
    }
    case 'item/reasoning/summaryPartAdded':
      // A paragraph boundary. There must be nothing before the first paragraph
      return typeof p.summaryIndex === 'number' && p.summaryIndex > 0
        ? [{ type: 'reasoning_delta', sessionId, text: '\n\n' }]
        : []

    /*
     * Plan progress (measured for #58). The measured shape:
     *   turn/plan/updated {threadId, turnId, explanation: null,
     *                      plan: [{step, status: 'pending'|'inProgress'|'completed'}]}
     * It is a full snapshot every time. A plan **never arrives** as an item — dropping this
     * notification would leave codex's use of the plan tool invisible everywhere on screen
     * (measured: this turn's items were only userMessage, reasoning, agentMessage and
     * commandExecution).
     */
    case 'turn/plan/updated': {
      const steps = (Array.isArray(p.plan) ? p.plan : []).map((raw) => {
        const it = obj(raw)
        const raw_ = str(it.status)
        // An unknown status falls back to pending — progress display must not die outright over one new status value
        const status: 'pending' | 'inProgress' | 'completed' =
          raw_ === 'inProgress' || raw_ === 'completed' ? raw_ : 'pending'
        return { text: str(it.step), status }
      })
      return steps.length > 0 ? [{ type: 'plan_update', sessionId, steps }] : []
    }

    /*
     * Output while a command is running (measured for #58): {threadId, turnId, itemId, delta}.
     * On completion, aggregatedOutput carries the whole thing again, so this is display-only.
     * (Measured: the first chunk can be consumed before the stream attaches and get dropped —
     * the assumption that summing the deltas equals the full output does not hold.)
     */
    case 'item/commandExecution/outputDelta': {
      const text = str(p.delta)
      return text ? [{ type: 'tool_output_delta', sessionId, callId: str(p.itemId), text }] : []
    }

    case 'item/started': {
      const item = obj(p.item)
      const type = str(item.type)
      if (type === 'userMessage' || type === 'reasoning' || type === 'agentMessage') return []
      /*
       * Compaction is not a tool call. Without filtering this out, the conversation gets an
       * unidentifiable tool line named 'contextCompaction' — and the "compacting now" indicator
       * that is actually needed is nowhere to be found.
       */
      if (type === 'contextCompaction') return [{ type: 'activity', sessionId, activity: 'compacting' }]
      /*
       * The start of a review (/review -> the review/start RPC). For the same reason as
       * compaction, this is an activity, not a tool line — the review body streams separately as
       * agentMessage, so making a tool line here would leave an unidentifiable call named
       * "enteredReviewMode" in the conversation (the measured shape).
       */
      if (type === 'enteredReviewMode') return [{ type: 'activity', sessionId, activity: 'reviewing' }]
      if (type === 'exitedReviewMode') return [{ type: 'activity', sessionId, activity: null }]
      // The start of viewing an image is not a tool line — the image itself is emitted at completion (#40)
      if (type === 'imageView') return []
      const s = itemSummary(item)
      return [{ type: 'tool_call', sessionId, callId: str(item.id), summary: s, input: itemInput(item) }]
    }

    case 'item/completed': {
      const item = obj(p.item)
      const type = str(item.type)
      if (type === 'agentMessage') {
        // A fallback for when the streamed deltas were missed (empty when deltas already arrived, to avoid duplicating)
        return str(item.text) ? [{ type: 'message_delta', sessionId, role: 'assistant', text: '', ...messageIdOf(item.id) }] : []
      }
      if (type === 'userMessage' || type === 'reasoning') return []
      // The marker is emitted by thread/compacted — emitting it again here would put two lines in the same spot
      if (type === 'contextCompaction') return [{ type: 'activity', sessionId, activity: null }]
      /*
       * The end of a review. item.review carries the full result text, but we do not emit it —
       * the same text has already streamed as agentMessage (measured). Emitting it again here
       * would append the result twice. (The start/end items only ever surface as activity,
       * whether they arrive via started or completed.)
       */
      if (type === 'exitedReviewMode') return [{ type: 'activity', sessionId, activity: null }]
      if (type === 'enteredReviewMode') return []
      /*
       * The agent viewed an image (#40). Measured shape: {type:'imageView', id, path} — only the
       * path is carried. Reading the file is IO, which this pure function cannot do: it is
       * emitted with data left empty, and the adapter (index.ts) reads and fills it in right
       * before emitting. The mime type is also decided there, from the extension. (imageGeneration
       * has not been measured yet — it will be wired up once observed, the same rule as #58.)
       */
      if (type === 'imageView') {
        const path = str(item.path)
        return path ? [{ type: 'message_image', sessionId, mime: '', data: '', path }] : []
      }
      const s = itemSummary(item)
      // The card shows the first 2,000 characters; the result's record is all of it (#221)
      const output = resultSummary(item)
      const out: NormalizedEvent[] = [
        {
          type: 'tool_result',
          sessionId,
          callId: str(item.id),
          ok: str(item.status) !== 'failed',
          summary: output.slice(0, 2000),
          ...(output ? { output } : {}),
        },
      ]
      // If a file was actually changed, announce it for conflict detection and highlighting (FR-2, FR-5)
      if (s.paths.length > 0) out.push({ type: 'files_touched', sessionId, paths: s.paths })
      return out
    }

    /*
     * The turn ended — **read how it ended, too** (#107).
     *
     * `turn/completed` also carries a failed turn (generated/v2/Turn.ts: `status` is "completed" |
     * "interrupted" | "failed", and `error` is only filled in when failed). We used to drop
     * `turn.*` wholesale here, so a turn that errored with a 400 still went out as nothing more
     * than a single `turn_complete`, same as a successful one — the screen was left with an
     * **empty answer** while the state flipped to `waiting_input`. A real incident: the rollout
     * had the full text of `The 'opus[1m]' model …`, but not a single character of it reached the
     * app, and there was no adapter error in the host log either. Nowhere did anything say it had
     * failed.
     *
     * A failure is emitted as `error` — **not together with `turn_complete`.** If both events go
     * out, the state machine's last word ends up being "waiting for the person", which repeats
     * exactly the lie we are trying to fix. The same rule the Claude adapter uses for `result`.
     */
    case 'turn/completed': {
      const turn = obj(p.turn)
      const failure = obj(turn.error)
      if (str(turn.status) !== 'failed' && !failure.message) return [{ type: 'turn_complete', sessionId }]
      const detail = str(failure.additionalDetails)
      return [
        {
          type: 'error',
          sessionId,
          error: {
            code: 'internal',
            message: [str(failure.message) || 'The turn failed', detail].filter(Boolean).join('\n'),
            retryable: true,
          },
        },
      ]
    }

    case 'turn/started':
      return [{ type: 'state_change', sessionId, state: 'working' }]

    case 'thread/tokenUsage/updated': {
      const usage = obj(obj(p.tokenUsage).total)
      /*
       * Context occupancy comes from `last`, not `total`.
       *
       * `ThreadTokenUsage` carries both (generated/v2/ThreadTokenUsage.ts): `total` is what
       * the thread has spent since it began, `last` is the most recent turn. Reading `total`
       * put a running sum against a fixed window, so the gauge climbed forever — it reached
       * **149,084%** on a real session (1,235,017,921 against a 828,400 window) before this
       * was noticed. Cumulative spend is a billing number and stays with `usage_update`;
       * how full the window is describes one request.
       */
      const lastTurn = obj(obj(p.tokenUsage).last)
      const input = num(usage.inputTokens) ?? 0
      const output = num(usage.outputTokens) ?? 0
      const cached = num(usage.cachedInputTokens) ?? 0
      /*
       * The field is `modelContextWindow`, on the tokenUsage object — see
       * generated/v2/ThreadTokenUsage.ts. We read `contextWindow` for a long time, found
       * nothing, and skipped the event: `usage_update` still went out, so tokens worked
       * and only the percentage was missing. The adapter meanwhile declared
       * `contextUsage: 'exact'`, so the app promised a number it never sent.
       *
       * The older names stay in the chain because a running Codex may predate the rename,
       * and reading a field that isn't there costs nothing.
       */
      const usageObj = obj(p.tokenUsage)
      const window =
        num(usageObj.modelContextWindow) ?? num(p.contextWindow) ?? num(usageObj.contextWindow)
      const events: NormalizedEvent[] = [
        /*
         * Codex counts cached input inside `inputTokens` (its `totalTokens` is input + output). The protocol's
         * TokenUsage keeps the two apart, as Anthropic does, so the uncached part is what goes in `inputTokens`.
         */
        { type: 'usage_update', sessionId, tokens: { inputTokens: Math.max(0, input - cached), outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0 } },
      ]
      const occupied = num(lastTurn.totalTokens)
      if (window && occupied !== undefined && occupied <= window) {
        events.push({ type: 'context_update', sessionId, used: occupied, window, exactness: 'exact' })
      } else if (window && occupied !== undefined) {
        /*
         * More tokens than the window holds is not a reading, it is a misread field — the
         * shape this bug took the first time. Emit nothing and say so: a blank gauge is
         * honest, and 149,084% was not.
         */
        warnImpossibleContext(occupied, window)
      } else {
        // Say it out loud. A silent skip here is what let a renamed field hide for weeks.
        warnMissingContextWindow(usageObj)
      }
      return events
    }

    /*
     * A usage update is **not the same as hitting a limit.**
     *
     * Without a condition here, a codex session flipped to 'limited' right after its very first
     * tool call — even when the measured usedPercent was only 27%. That freezes and dims the
     * spinning icon and slaps on a "Limit 27%" label that does not actually apply (dogfooding:
     * "the loading spinner does not spin while bash is running").
     *
     * The tool tells us directly whether the limit was hit — `rateLimitReachedType` being null
     * means it was not hit (the Claude adapter also only emits this when `status !== 'allowed'`;
     * both must follow the same rule). No usage information is lost by this: the usage panel
     * reads it separately through `agents.usage`.
     */
    case 'account/rateLimits/updated': {
      const snapshot = obj(p.rateLimits)
      const reached = str(snapshot.rateLimitReachedType) !== '' || snapshot.spendControlReached === true
      if (!reached) return []

      const primary = obj(snapshot.primary)
      const resetsAt = num(primary.resetsAt)
      return [
        {
          type: 'limit_reached',
          sessionId,
          usedPercent: num(primary.usedPercent),
          windowMins: num(primary.windowDurationMins),
          resumeAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined,
        },
      ]
    }

    case 'thread/name/updated':
      // This is a name the tool made up on its own -> auto:true. A name the person set is not overwritten by this (issue #5)
      return [{ type: 'session_title', sessionId, title: str(p.name), auto: true }]

    case 'thread/compacted':
      return [{ type: 'compaction', sessionId, failed: false }]

    /*
     * Goal notifications (2026-09-07 — ThreadGoalUpdated/ClearedNotification). codex treats a goal
     * as a first-class thing: objective, status (active | paused | blocked | usageLimited |
     * budgetLimited | complete), and token budget/usage all arrive over the protocol. We carry
     * the vocabulary through unchanged — the judgment belongs to the tool, and we only carry the
     * basis for the badge.
     */
    case 'thread/goal/updated':
      return [{ type: 'goal', sessionId, goal: goalFromCodex(obj(p.goal)) }]

    case 'thread/goal/cleared':
      return [{ type: 'goal', sessionId, goal: null }]

    /*
     * The `error` notification has the shape `{ error, willRetry, threadId, turnId }` (generated
     * binding ErrorNotification, codex-cli 0.153.4). Two cases are not left as a failure marker
     * (#168):
     *  - **an error that will be retried** (willRetry) — Codex continues on its own, e.g. by
     *    reconnecting. Leaving a marker here would leave "this turn did not finish" in the
     *    conversation even when the turn eventually succeeds. If it does fail for good, the
     *    turn/completed(failed) below reports it. It shows as the `retrying` activity while
     *    it lasts (the adapter puts the previous activity back once output resumes) and goes
     *    to host.log with Codex's reason.
     *  - **an error that belongs to a turn** — that turn ends with a turn/completed(failed)
     *    carrying the same sentence. Emitting both would leave two lines of marker (measured: one
     *    token-refresh failure left the same sentence three times across two lines within the same
     *    second). We treat the turn's own outcome as the source of truth.
     *
     * Measured with codex-cli 0.153.4 (2026-10-03, a provider whose stream closed before
     * `response.completed`, stream_max_retries=2): `error{message:"Reconnecting... 1/2",
     * additionalDetails:<the reason>, willRetry:true, turnId}`, the same for 2/2, then
     * `error{message:<the reason>, willRetry:false, turnId}` and `turn/completed{status:"failed",
     * error:{message:<the same reason>}}`. A real 400 (an unsupported model) skipped the retries
     * and sent the last two only.
     */
    case 'error': {
      const message = str(obj(p.error).message) || str(p.message) || 'Unknown error'
      if (p.willRetry === true) {
        const why = str(obj(p.error).additionalDetails)
        console.error(`[codex] ${sessionId.slice(0, 8)} retrying after: ${message}${why ? ` (${why})` : ''}`)
        return [{ type: 'activity', sessionId, activity: 'retrying' }]
      }
      if (str(p.turnId)) return []
      return [{ type: 'error', sessionId, error: { code: 'internal', message, retryable: true } }]
    }

    default:
      return []
  }
}

/**
 * A child thread's notification, as steps of the subagent a `spawnAgent` call launched (#222).
 *
 * Measured live (scripts/probe-codex-subagent.mts, codex-cli 0.160.0 and 0.153.4 in #222): the child's
 * `item/started` and `item/completed` arrive on the parent's connection with the child's `threadId`, for its prompt
 * (`userMessage`), its reasoning, its commands and its `agentMessage`. Steps are read from them alone:
 *
 *   - text and reasoning from the **completed** item (`text`, `summary`), whole. The child's deltas are not read:
 *     a step is one row (see `SubagentStep`), and the completed item carries the same text again
 *   - a tool call when its item starts, its result when it completes, exactly as the parent's own (`input` and
 *     `output` included, #221)
 *   - its prompt is not a step: it is the launch call's own `prompt`, already on the parent's card
 *
 * A file a child changed is still a file changed in this session's folder, so `files_touched` goes out as the
 * parent's, as Claude's subagents do (#98). Everything else a child sends (its turn and status, usage, images) is
 * not part of its record here.
 */
export function childSteps(sessionId: string, parentCallId: string, n: Notification): NormalizedEvent[] {
  if (n.method !== 'item/started' && n.method !== 'item/completed') return []
  const item = obj(obj(n.params).item)
  const type = str(item.type)
  const step = (s: SubagentStep): NormalizedEvent => ({ type: 'subagent_event', sessionId, parentCallId, step: s })
  if (type === 'agentMessage') {
    const text = n.method === 'item/completed' ? str(item.text) : ''
    return text ? [step({ type: 'message_delta', sessionId, role: 'assistant', text, ...messageIdOf(item.id) })] : []
  }
  if (type === 'reasoning') {
    const parts = n.method === 'item/completed' && Array.isArray(item.summary) ? item.summary.map(str).filter(Boolean) : []
    return parts.length ? [step({ type: 'reasoning_delta', sessionId, text: parts.join('\n\n') })] : []
  }
  const out: NormalizedEvent[] = []
  for (const e of normalizeNotification(sessionId, n)) {
    if (e.type === 'tool_call' || e.type === 'tool_result') out.push(step(e))
    else if (e.type === 'files_touched') out.push(e)
  }
  return out
}

/** Converts an approval response into a Codex decision (only the ones we use, out of the six) */
export function toCodexDecision(decision: 'allow' | 'deny' | 'always'): string {
  if (decision === 'deny') return 'decline'
  if (decision === 'always') return 'acceptForSession' // Maps exactly to "always allow, this session" (confirmed in M0)
  return 'accept'
}

/*
 * Warn once per process: this fires on every token update of every Codex session, and a
 * repeating line would be noise rather than a signal.
 */
let warnedContextWindow = false
function warnMissingContextWindow(usage: Record<string, unknown>): void {
  if (warnedContextWindow) return
  warnedContextWindow = true
  console.error(
    '[codex] token usage carried no context window — the context gauge will stay empty. ' +
      `Fields present: ${Object.keys(usage).join(', ') || '(none)'}`,
  )
}

/** Warn once per process — this would otherwise repeat on every turn of every session. */
let warnedImpossible = false
function warnImpossibleContext(used: number, window: number): void {
  if (warnedImpossible) return
  warnedImpossible = true
  console.error(
    `[codex] context reading exceeds the window (${used} of ${window}) — gauge left empty. ` +
      'A used-vs-window ratio above 1 means the wrong field was read, not a full context.',
  )
}

/**
 * Reset the warn-once flags. Tests only.
 *
 * The flags exist so a misread field doesn't print on every turn of every session, but that
 * makes them process state: the second test to check for a warning would find it already
 * spent and pass for the wrong reason. Same shape as `__setSessionApiForTest` in the Claude
 * adapter — production keeps the behaviour, tests get a way to start clean.
 */
export function __resetWarningsForTest(): void {
  warnedContextWindow = false
  warnedImpossible = false
}
