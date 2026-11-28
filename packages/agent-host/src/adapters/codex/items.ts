import { asObj, jsonObject, str } from '../../json-value.js'
import { fileChangeTool, type FileChange } from '../file-changes.js'
import type { ToolSummary } from '@cc/protocol'
import { centraluMark, centraluRunCommand, firstLine, isCentraluTool } from '../tool-titles.js'

/**
 * Codex's tool items (generated/v2/ThreadItem.ts), read: what a call was asked to do, how it is titled, what it
 * answered and whether it went through. Pure, like normalize.ts, which turns them into events.
 */


/**
 * What the tool **actually answered** — the body that goes on the card. `aggregatedOutput`/`output` are
 * commandExecution's: **an MCP call carries its answer in `result` and `error`** (generated/v2/ThreadItem.ts), without
 * which a failed MCP call's card is a red line with not a single character of reason (dogfooding 2026-09-08).
 *
 * Order: command output, then error message, then result content. Error comes before result
 * because when both exist, the reason for failure is what a person needs to know first.
 */
export function resultSummary(item: Record<string, unknown>): string {
  const direct = str(item.aggregatedOutput) || str(item.output)
  if (direct) return direct

  const err = str(asObj(item.error).message)
  if (err) return err

  const content = asObj(item.result).content
  if (Array.isArray(content)) {
    const text = content
      .map((c) => str(asObj(c).text))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  const structured = asObj(item.result).structuredContent
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
 * Whether a completed tool item went through (#843). Every status but `completed` says it did not: a command or a
 * file change the person declined ends `declined` (generated v2 `CommandExecutionStatus`, `PatchApplyStatus`), a
 * collab call `interrupted` (`CollabAgentToolCallStatus`), and any of them `failed`. A dynamic tool also says
 * `success: false`. Each of these ends the card failed, never green.
 */
export function codexItemOk(item: Record<string, unknown>): boolean {
  const status = str(item.status)
  return status !== 'failed' && status !== 'declined' && status !== 'interrupted' && item.success !== false
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
export function itemInput(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([k, v]) => !ITEM_OUTCOME.has(k) && v !== null && v !== undefined))
}

/** A tool-call item, into a human-readable line (the conversation card's title) */
export function itemSummary(item: Record<string, unknown>): ToolSummary {
  const type = str(item.type)
  if (type === 'commandExecution') {
    const cmd = str(item.command)
    return { tool: 'Bash', title: cmd, paths: [] }
  }
  if (type === 'fileChange') {
    const changes = fileChangesOf(item)
    const paths = changes.map((c) => c.path).filter(Boolean)
    return { tool: fileChangeTool(changes), title: paths.join(', ') || 'Edit files', paths }
  }
  if (type === 'mcpToolCall') {
    /*
     * The name lives in **the top-level server and tool** (generated/v2/ThreadItem.ts): `invocation.tool` alone
     * collapses every one of Codex's MCP calls into a single 'MCP'.
     */
    const tool = str(item.tool) || str(asObj(item.invocation).tool)
    const server = str(item.server)
    /*
     * A command run through centralu_run (#512) is summarized as the command, the same rule as toolSummary on
     * the claude side, when its arguments are on the item. A call made from inside `exec` carries none and
     * stays centralu_run; the screen re-reads both proposal lists for such a call.
     */
    if (isCentraluTool({ server, tool }, 'centralu_run')) {
      const run = centraluRunCommand(jsonObject(item.arguments ?? asObj(item.invocation).arguments))
      if (run) {
        return itemSummary({ ...item, tool: run.command, arguments: run.args, invocation: { ...asObj(item.invocation), tool: run.command, arguments: run.args } })
      }
    }
    // ask_project (#371) — the project asked is the title, the same rule as toolSummary on the claude side
    if (isCentraluTool({ server, tool }, 'ask_project')) {
      // Arguments that are not JSON name no project: the card still finds the session it asked
      const project = str(jsonObject(item.arguments ?? asObj(item.invocation).arguments).project)
      const mark = centraluMark(server, tool, {})
      return { tool, title: project || tool, paths: [], ...(mark ? { centralu: mark.centralu } : {}) }
    }
    /*
     * **The arguments go on the title too** (dogfooding 2026-09-08): two calls of one tool can differ only in an
     * argument name (`{message: …}` worked, `{query: …}` drew only "An unexpected error occurred"), and by the tool
     * name alone they look identical.
     */
    const args = argsPreview(item.arguments ?? asObj(item.invocation).arguments)
    const name = [server, tool].filter(Boolean).join(': ') || str(item.title) || 'MCP tool'
    // Centralu's own servers (#730): marked, and titled by what the call does. Codex names the server apart, so the
    // screen cannot tell from `tool` alone; a call made from inside `exec` names none and stays unmarked
    const mark = tool ? centraluMark(server, tool, jsonObject(item.arguments ?? asObj(item.invocation).arguments)) : null
    return {
      tool: tool || 'MCP',
      title: mark?.title ?? (args ? `${name} ${args}` : name),
      paths: [],
      ...(mark ? { centralu: mark.centralu } : {}),
    }
  }
  if (type === 'webSearch') {
    return { tool: 'WebSearch', title: str(item.query), paths: [] }
  }
  /*
   * A collab call (generated/v2/ThreadItem.ts `collabAgentToolCall`): spawning a child agent, waiting for it, sending
   * it more work. It is named by the collab tool, not by its type, so a
   * `spawnAgent` card is recognised as the one that launched a subagent (#222, `launchesSubagent`), and it reads as the
   * work handed over: the prompt's first line, as a Claude agent card reads as its description (#98).
   */
  if (type === 'collabAgentToolCall') {
    const tool = str(item.tool) || type
    return { tool, title: firstLine(str(item.prompt)) || tool, paths: [] }
  }
  /*
   * A child agent under multi-agent v2 (codex-cli 0.172.0, recorded, #2553): the item says what happened to a child by its `kind`.
   * `started` is the launch, read as the `spawnAgent` card that launched a subagent (`launchesSubagent`) titled by the child's
   * `agentPath`; `interacted` is a message or follow-up task sent to it. The end of a child's turn has no row (`childEnded`).
   */
  if (type === 'subAgentActivity') {
    const path = str(item.agentPath)
    return str(item.kind) === 'started' ? { tool: 'spawnAgent', title: path || 'Child agent', paths: [] } : { tool: 'sendMessage', title: path ? `Message to ${path}` : 'Message to a child agent', paths: [] }
  }
  return { tool: type || 'tool', title: str(item.title) || type, paths: [] }
}

/** A v2 `subAgentActivity` that says a child's turn ended or was interrupted: the child's own `turn/completed` says it too, so it is no row (#2553) */
export function childEnded(item: Record<string, unknown>): boolean {
  return str(item.type) === 'subAgentActivity' && (str(item.kind) === 'completed' || str(item.kind) === 'interrupted')
}

/** The arguments, into one line on the card title: their **shape** (what was sent under what name), cut short: the full body is on the result card */
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

/**
 * The changes a `fileChange` item carries (generated/v2/ThreadItem.ts: `changes: FileUpdateChange[]`,
 * each `{ path, kind, diff }`). The adapter remembers them per item id, because the approval request
 * for that item does not carry them (see approvalDetailFrom).
 */
export function fileChangesOf(item: Record<string, unknown>): FileChange[] {
  const changes = Array.isArray(item.changes) ? item.changes : []
  return changes.map((c) => ({ path: str(asObj(c).path), diff: str(asObj(c).diff), ...changeKindOf(asObj(asObj(c).kind)) }))
}

/**
 * What a change does to its file (generated v2 `PatchChangeKind`: `{type: 'add'}`, `{type: 'delete'}`,
 * `{type: 'update', move_path}`), kept for the card and the list rows (#683): a delete or a move must not read
 * as an ordinary edit. An update with a `move_path` is a move.
 */
export function changeKindOf(kind: Record<string, unknown>): Pick<FileChange, 'change' | 'movePath'> {
  const type = str(kind.type)
  if (type === 'add' || type === 'delete') return { change: type }
  if (type === 'update') return str(kind.move_path) ? { change: 'move', movePath: str(kind.move_path) } : { change: 'update' }
  return {}
}
