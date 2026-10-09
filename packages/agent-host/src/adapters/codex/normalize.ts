import type { ApprovalDetail, BackgroundTask, NormalizedEvent, SessionGoal, SubagentStep } from '@cc/protocol'
import { noticeWords } from './notices.js'

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
    // ask_project (#371) — the project asked is the title, the same rule as toolSummary on the claude side
    if (tool === 'ask_project' && (!server || server === 'centralu')) {
      const rawArgs = item.arguments ?? obj(item.invocation).arguments
      let project = ''
      try {
        const parsed = typeof rawArgs === 'string' ? (JSON.parse(rawArgs) as unknown) : rawArgs
        project = str(obj(parsed).project)
      } catch {
        /* If the arguments are not JSON, the card names no project — it still finds the session it asked */
      }
      return { tool, title: project || tool, readOnly: false, paths: [] }
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
 *   - mapped: a case below, or read in index.ts (`patchUpdated`, `serverRequest/resolved`)
 *   - ignored by #58: the git panel covers the diff, and the rest is internal detail
 *   - correctly ignored: features Centralu does not use (Codex app projects, realtime voice, client-run processes,
 *     fs/watch, fuzzy search, OAuth and login flows), the server's own bookkeeping (`thread/started`, `account/updated`),
 *     deprecated or unstable shapes, and Windows-only notices
 *
 * The methods the survey would show or store but nobody has wired yet stay out on purpose: `item/reasoning/textDelta`,
 * `item/mcpToolCall/progress`, `skills/changed` and `thread/reverted` among them. Their log line is how a real instance
 * gets noticed.
 */
export const CODEX_KNOWN_NOTIFICATIONS: ReadonlySet<string> = new Set([
  // mapped
  'error', 'thread/name/updated', 'thread/goal/updated', 'thread/goal/cleared', 'thread/tokenUsage/updated',
  'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'thread/compacted', 'account/rateLimits/updated',
  // read in index.ts: closes the approval card of a request Codex ended without our answer
  'serverRequest/resolved',
  // mapped by #290 for a child thread (CodexChildTracker); the parent's own status is still not read
  'thread/status/changed',
  // mapped by #304: notices, model switches and MCP servers that failed to start (thread/settings/updated in index.ts)
  'warning', 'configWarning', 'deprecationNotice', 'guardianWarning', 'model/rerouted', 'thread/settings/updated',
  'mcpServer/startupStatus/updated',
  // ignored by #58
  'turn/diff/updated', 'hook/started', 'hook/completed',
  'rawResponseItem/completed', 'rawResponse/completed',
  // correctly ignored
  'thread/started', 'thread/archived', 'thread/unarchived', 'thread/deleted', 'thread/closed',
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

/**
 * One marker per compaction, whichever of its two signs arrive (#303).
 *
 * A compaction can be announced twice: by the completed `contextCompaction` item and by the deprecated
 * `thread/compacted` notification, both carrying the turn they belong to. Every measured CLI (0.147.0, 0.153.4,
 * 0.160.0) sent only the item, but the adapter's own notes from earlier dogfooding record the sequence "item, then
 * `thread/compacted`", so a CLI that sends both must not leave two markers in the same spot. Pairing is per turn and
 * does not depend on order: a sign is admitted unless the other kind of sign for the same turn is still waiting for
 * its partner, in which case the two are one compaction. Two compactions in one turn that each send only the item
 * still leave two markers.
 */
export class CompactionMarks {
  /** Per turn: which kind of sign was admitted without a partner yet, and how many */
  private readonly open = new Map<string, { kind: 'item' | 'notice'; count: number }>()

  /** Whether this notification's compaction marker should be emitted */
  admit(n: Notification): boolean {
    const kind = n.method === 'thread/compacted' ? 'notice' : 'item'
    const turn = str(obj(n.params).turnId)
    const waiting = this.open.get(turn)
    if (waiting && waiting.kind !== kind) {
      if (--waiting.count === 0) this.open.delete(turn)
      return false
    }
    this.open.delete(turn) // re-inserted last, so the oldest turn is the one let go below
    this.open.set(turn, { kind, count: (waiting?.count ?? 0) + 1 })
    // A CLI that sends only one kind leaves every turn open; the partner of an old turn is not coming
    if (this.open.size > 32) this.open.delete(this.open.keys().next().value!)
    return true
  }
}

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
      /*
       * The compaction marker (FR-14, #303). The completed item is the only sign of a finished compaction that Codex
       * still sends: measured with gpt-5.6-luna on codex-cli 0.147.0, 0.153.4 and 0.160.0 (2026-10-04,
       * scripts/probe-codex-compaction.mts), a manual compaction (`thread/compact/start`) and an automatic one both
       * arrive as `item/started` then `item/completed` of `{ type: 'contextCompaction', id }`, with no
       * `thread/compacted` at all; 0.160.0's binding marks that notification deprecated in favour of this item. The
       * marker used to come only from `thread/compacted`, so no Codex compaction left one. That notification is still
       * mapped below for a CLI that sends it, and the adapter pairs the two (`CompactionMarks`) so that one compaction
       * is one marker either way.
       */
      if (type === 'contextCompaction') {
        return [
          { type: 'activity', sessionId, activity: null },
          { type: 'compaction', sessionId, failed: false },
        ]
      }
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

    // Deprecated (0.160.0's binding) and not sent in any measured run — kept for a CLI that still does (#303)
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
     * Text Codex wants the person to read (#304). Measured (codex-cli 0.160.0, 2026-10-04): with two keys in
     * `~/.codex/config.toml` the CLI ignores, `configWarning {summary: "Codex is ignoring 2 unrecognized configuration
     * settings. Check for typos or deprecated settings.\n  user (…/config.toml): \`mcp_servers.plane.type\` is
     * ignored.\n…", details: null}` arrived while `thread/start` was answered, then `warning {threadId, message: <the
     * same text>}` for the thread. Both come again on every app-server start and every thread start or resume, saying the
     * same thing each time: `oncePerSession` lets the host keep one line per session. `deprecationNotice` has the
     * `configWarning` shape (generated/v2/DeprecationNoticeNotification.ts); the owner saw the full-history one (#342).
     * Each also carries who is speaking, what kind it is and who has to act, and a plain explanation for the ones we know
     * (`noticeWords`, #342).
     */
    case 'warning': {
      const text = str(p.message).trim()
      return text ? [{ type: 'notice', sessionId, level: 'warning', text, oncePerSession: true, ...noticeWords('warning', text) }] : []
    }
    case 'configWarning':
    case 'deprecationNotice': {
      const text = [str(p.summary).trim(), str(p.details).trim()].filter(Boolean).join('\n')
      return text ? [{ type: 'notice', sessionId, level: 'warning', text, oncePerSession: true, ...noticeWords(n.method, text) }] : []
    }
    // The auto-review guardian's warning about an action (generated/v2/GuardianWarningNotification.ts); not exercised
    case 'guardianWarning': {
      const text = str(p.message).trim()
      return text ? [{ type: 'notice', sessionId, level: 'warning', text, ...noticeWords('guardianWarning', text) }] : []
    }

    /*
     * Codex answered a turn with another model than the thread's (#304, not exercised): `{threadId, turnId, fromModel,
     * toModel, reason}`, where the only reason the bindings know is `highRiskCyberActivity`. It names a turn, and the
     * thread's own settings do not change with it (that would be `thread/settings/updated`), so this says so in the
     * conversation and leaves the model the person picked alone.
     */
    case 'model/rerouted': {
      const to = str(p.toModel)
      if (!to) return []
      const reason = str(p.reason) === 'highRiskCyberActivity' ? 'it was flagged as high-risk cyber activity' : str(p.reason)
      const text = `Codex answered this turn with ${to} instead of ${str(p.fromModel) || 'the selected model'}${reason ? ` because ${reason}` : ''}`
      return [{ type: 'notice', sessionId, level: 'warning', text, ...noticeWords('model/rerouted', text) }]
    }

    /*
     * An MCP server that failed to start (#304). Measured (codex-cli 0.160.0): every server reports `starting`, then
     * `ready` or `failed {error: "MCP client for \`<name>\` failed to start: MCP startup failed: No such file or
     * directory (os error 2)"}`, and a failing one goes through `starting` → `failed` **twice** on one thread start.
     * Centralu's own orchestrator and app bridges are MCP servers too, and a failed start used to be silent: the model
     * simply had no such tools. The adapter keeps one line per server until it starts again (index.ts).
     */
    case 'mcpServer/startupStatus/updated': {
      if (str(p.status) !== 'failed') return []
      const name = str(p.name) || 'an MCP server'
      const reauth = str(p.failureReason) === 'reauthenticationRequired' ? ' (it needs you to sign in again)' : ''
      const text = `${str(p.error).trim() || `MCP server \`${name}\` failed to start`}${reauth}`
      return [{ type: 'notice', sessionId, level: 'warning', text, ...noticeWords('mcpStartup', text, str(p.name)) }]
    }

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

/** The thread settings a Codex model switch is measured against (#304) — Codex's own words for them. */
export type CodexThreadSettings = { model: string | null; effort: string | null; serviceTier: string | null }

/** The settings a `thread/start` or `thread/resume` answer says the thread runs with (top level, as answered on 0.160.0). */
export function threadSettingsOf(res: Record<string, unknown> | undefined): CodexThreadSettings | null {
  if (!res) return null
  const thread = obj(res.thread)
  const model = str(res.model) || str(thread.model)
  if (!model) return null
  return {
    model,
    effort: str(res.reasoningEffort) || str(thread.reasoningEffort) || null,
    serviceTier: str(res.serviceTier) || null,
  }
}

/**
 * A thread whose settings changed under it (#304, not exercised: Centralu's own effort override per turn did not send
 * it in #58's survey). `thread/settings/updated {threadId, threadSettings}` carries the whole of them
 * (generated/v2/ThreadSettings.ts). They are compared with what the thread said it runs with, not with what Centralu
 * asked for: Codex answers a default with a concrete value (no model asked → `gpt-5.6-luna`), and comparing with the
 * request would call that a change. Only a real difference becomes a notice and a `settings_changed` the tool made,
 * whose other fields are what the process was launched with (`launched`) — the host applies only what differs from
 * those.
 */
export function threadSettingsChanged(
  sessionId: string,
  before: CodexThreadSettings | null,
  params: unknown,
  launched: { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null },
): { next: CodexThreadSettings | null; events: NormalizedEvent[] } {
  const s = obj(obj(params).threadSettings)
  const next: CodexThreadSettings = {
    model: str(s.model) || null,
    effort: str(s.effort) || null,
    serviceTier: str(s.serviceTier) || null,
  }
  if (!next.model) return { next: before, events: [] }
  if (!before) return { next, events: [] }
  const words = { model: 'model', effort: 'effort', serviceTier: 'speed' } as const
  const changed = (Object.keys(words) as (keyof CodexThreadSettings)[]).filter((k) => next[k] !== before[k])
  if (changed.length === 0) return { next, events: [] }
  const what = changed.map((k) => `${words[k]} ${before[k] ?? 'default'} → ${next[k] ?? 'default'}`).join(' · ')
  return {
    next,
    events: [
      { type: 'notice', sessionId, level: 'warning', text: `This thread's settings were changed outside Centralu: ${what}`, ...noticeWords('settings', '') },
      {
        type: 'settings_changed',
        sessionId,
        model: changed.includes('model') ? next.model : launched.model,
        effort: changed.includes('effort') ? next.effort : launched.effort,
        verbosity: launched.verbosity,
        serviceTier: changed.includes('serviceTier') ? next.serviceTier : launched.serviceTier,
        by: 'tool',
      },
    ],
  }
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

/**
 * A Codex session's background work: its child agents (#290).
 *
 * A child runs on its own thread, and its notifications arrive on the parent's connection (#222). It is live while
 * its thread is active. Measured (scripts/probe-codex-background.mts, codex-cli 0.160.0, gpt-5.6-luna, 2026-10-04):
 *
 *   - the child's `thread/status/changed {active}` and `turn/started` arrive in the same millisecond as the parent's
 *     `spawnAgent` `item/completed` that names it, and sometimes before it — so a thread's state is kept from its
 *     first notification, and it is listed once a launch call names it (the same link #222 keys its steps by)
 *   - it ends with `{idle}` and `turn/completed`, in either order within a millisecond; the turn's `status`
 *     (`completed`, `interrupted`, `failed`) is how it ended. `{systemError}` is a failure
 *   - **interrupting the parent's turn does not stop it** (it went on reasoning, still active 20 s later), so every
 *     child says `stopsWithTurn: false`
 *   - `turn/interrupt` on the child's own turn stops it (`turn/completed {interrupted}`), which is the per-task stop.
 *     It needs the child's turn id, so a child is stoppable only while one is known
 *
 * Nested children (a child's own `spawnAgent`) are linked the same way and listed alongside. A child that started
 * before this process (a resumed thread's) is never named by a launch call here, so it is not listed.
 */
export class CodexChildTracker {
  private readonly threads = new Map<string, { active: boolean; turnId: string | null }>()
  /** Linked children: thread to its launch call and description. Only these are listed. */
  private readonly linked = new Map<string, { callId: string; description: string }>()
  private lastLive = '[]'

  constructor(private readonly sessionId: string) {}

  /** A `spawnAgent` call named this thread. */
  link(thread: string, callId: string, prompt: string): NormalizedEvent[] {
    if (this.linked.has(thread)) return []
    const line = prompt.split('\n')[0]?.trim() ?? ''
    this.linked.set(thread, { callId, description: line.length > 200 ? `${line.slice(0, 200)} …` : line || 'Child agent' })
    return this.changed()
  }

  /** A notification from a thread that is not the parent's. */
  push(thread: string, n: Notification): NormalizedEvent[] {
    const p = obj(n.params)
    const t = this.threads.get(thread) ?? { active: false, turnId: null }
    this.threads.set(thread, t)
    if (n.method === 'thread/status/changed') {
      const type = str(obj(p.status).type)
      if (type === 'active') t.active = true
      else if (type === 'systemError') {
        const was = t.active
        t.active = false
        t.turnId = null
        return was ? this.changed([this.ended(thread, 'failed', 'The child thread hit a system error')]) : []
      } else t.active = false
      return this.changed()
    }
    if (n.method === 'turn/started') {
      t.active = true
      t.turnId = str(obj(p.turn).id) || t.turnId
      return this.changed()
    }
    if (n.method === 'turn/completed') {
      const raw = str(obj(p.turn).status)
      t.active = false
      t.turnId = null
      const status = raw === 'interrupted' ? 'stopped' : raw === 'failed' ? 'failed' : 'completed'
      const message = str(obj(obj(p.turn).error).message)
      return this.changed([this.ended(thread, status, message || undefined)])
    }
    return []
  }

  /** The turn to interrupt to stop this child, if one is running. */
  turnOf(thread: string): string | null {
    return this.threads.get(thread)?.turnId ?? null
  }

  /** The app-server went away and its child threads with it. */
  release(why: string): NormalizedEvent[] {
    const live = this.live()
    for (const t of this.threads.values()) {
      t.active = false
      t.turnId = null
    }
    if (live.length === 0) return []
    return this.changed(live.map((task) => ({ ...task, status: 'stopped' as const, summary: why })))
  }

  private ended(thread: string, status: 'completed' | 'failed' | 'stopped', summary?: string): BackgroundTask | null {
    const task = this.task(thread)
    return task ? { ...task, status, ...(summary ? { summary } : {}) } : null
  }

  private task(thread: string): BackgroundTask | null {
    const link = this.linked.get(thread)
    if (!link) return null
    const t = this.threads.get(thread)
    return {
      id: thread,
      kind: 'agent',
      description: link.description,
      parentCallId: link.callId,
      stopsWithTurn: false,
      stoppable: !!t?.turnId,
      status: 'running',
    }
  }

  private live(): BackgroundTask[] {
    const out: BackgroundTask[] = []
    for (const [thread, t] of this.threads) {
      const task = t.active ? this.task(thread) : null
      if (task) out.push(task)
    }
    return out
  }

  /** The event when the live set or an ending moved; nothing when neither did. */
  private changed(ended: (BackgroundTask | null)[] = []): NormalizedEvent[] {
    const live = this.live()
    const done = ended.filter((t): t is BackgroundTask => t !== null)
    const key = JSON.stringify(live)
    if (key === this.lastLive && done.length === 0) return []
    this.lastLive = key
    return [{ type: 'background_tasks', sessionId: this.sessionId, live, ...(done.length ? { ended: done } : {}) }]
  }
}
