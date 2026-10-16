import { NO_PATH, type ApprovalDetail, type ToolSummary } from '@cc/protocol'
import { str, type Json } from './json.js'

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

/**
 * The command a `centralu_run` call runs (#512, the `commands` tier), as the call it stands for: the
 * command's full name and its arguments. Null when it names no command, which leaves the card as the call.
 */
function commandRunOf(name: string, input: Json): { name: string; input: Json } | null {
  if (!name.endsWith('__centralu_run')) return null
  const command = str(input.command).trim()
  if (!/^[a-z]+(?:_[a-z]+)*$/.test(command)) return null
  let args: unknown = input.args ?? {}
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = {}
    }
  }
  return { name: name.slice(0, -'centralu_run'.length) + command, input: typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Json) : {} }
}

export function toolSummary(name: string, input: Json): ToolSummary {
  /*
   * A command run through centralu_run is summarized as the command (#512): the screen reacts to a call by
   * its name (a skill or MCP proposal card is re-read, a worktree window takes the branch from the title),
   * and the command keeps that reaction behind the tier. The record keeps the call as made (`input`).
   */
  const run = commandRunOf(name, input)
  if (run) return toolSummary(run.name, run.input)
  const paths: string[] = []
  let title = name
  if (name === 'Bash') title = str(input.command, name)
  else if (FILE_EDIT_TOOLS.has(name) || name === 'Read') {
    const p = str(input.file_path ?? input.notebook_path)
    if (p) paths.push(p)
    title = `${name}: ${p || '?'}`
  } else if (name === 'Grep' || name === 'Glob') title = `${name}: ${str(input.pattern)}`
  // The only channel through which a proposal card can pre-fill a branch name (#69) — carried in the title.
  else if (name.endsWith('propose_worktree_session')) title = str(input.branch, name)
  // The project asked (#371) — the caller's card names it, and finds the delegated session by it before the answer
  else if (name.endsWith('__ask_project')) title = str(input.project, name)
  /*
   * An agent card's title is the work handed to it (#98). While it was just the name, every card
   * said "Agent Agent", and launching three agents side by side left no way to tell which card was
   * which (a dogfooding session: all three showed the same line).
   */
  else if (name === 'Agent' || name === 'Task') title = str(input.description, name)
  return { tool: name, title, paths }
}

/**
 * The paths reported through `files_touched` — only from tools that **changed** a file (#185).
 *
 * `toolSummary`'s `paths` also include Read's own path (a handoff record uses it as "what was
 * looked at"). Emitting that as-is would tag a file the agent only read with "Edited by agent" in
 * the tree.
 */
export function editedPaths(s: ToolSummary): string[] {
  return FILE_EDIT_TOOLS.has(s.tool) ? s.paths : []
}

/**
 * One line of a subagent's step — appended to that agent card's live output (#98).
 *
 * Uses the same title rule as the parent's own card (`toolSummary`), but with the tool name
 * prepended: Bash's title is the full command text, so without the name what remains is what was
 * typed, not what it actually did. A multi-line command (a heredoc) only keeps its first line —
 * the card's tail is three lines, so a single command would otherwise take up the whole thing.
 */
export function stepLine(s: ToolSummary): string {
  const lines = s.title.split('\n')
  const first = lines[0] ?? ''
  const head = first.slice(0, 200) + (lines.length > 1 || first.length > 200 ? ' …' : '')
  return head === s.tool || head.startsWith(`${s.tool}:`) ? head : `${s.tool}: ${head}`
}

/** "34 tool uses · 2m 13s" — the opening of an agent card's result (#98). */
export function agentStats(toolUses: unknown, durationMs: unknown, status?: string): string {
  const parts: string[] = []
  if (status && status !== 'completed') parts.push(status)
  if (typeof toolUses === 'number') parts.push(`${toolUses} tool use${toolUses === 1 ? '' : 's'}`)
  if (typeof durationMs === 'number') {
    const s = Math.round(durationMs / 1000)
    parts.push(s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)
  }
  return parts.join(' · ')
}

/**
 * An agent card's result body — the step count plus the opening of the report.
 *
 * A card's result is cut at 300 characters for every tool (see `tool_result` below). An agent's
 * report routinely runs to tens of thousands of characters (dogfooding: 15-24KB), so only the
 * opening lands on the card, while the parent receives the full text and writes it in its own
 * words — if the card rendered the full text too, that is exactly what "the answer appears
 * twice" means.
 *
 * This returns the report uncut: its first 300 characters are the card's `summary`, and the whole of it is the
 * result's `output`, the record (#221).
 */
export function agentReport(report: string, stats: string): string {
  return stats ? `${stats}\n\n${report}` : report
}

/**
 * The whole text of a `tool_result` block — its `output` (#221): the string itself, or the blocks' text joined.
 *
 * Images are left out: they are saved as attachments (#40), and base64 would make the row as large as the picture.
 * So is any other block that carries base64 (a document, say). Other blocks are kept as their JSON, which is how the
 * card's summary has always shown them. Measured on this machine's transcripts (2026-09-30), a result is a string
 * (25,150), text blocks (3,167), an image (493), image and text (26) or a `tool_reference` from ToolSearch (235);
 * joining only the text would leave a ToolSearch result empty.
 */
export function resultOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return (content as Json[])
    .filter((b) => str(b?.type) !== 'image' && str((b?.source as Json | undefined)?.type) !== 'base64')
    .map((b) => (str(b?.type) === 'text' ? str(b.text) : JSON.stringify(b)))
    .join('\n')
}

/** Normalizes an approval request into one of 3 kinds the banner can judge (core/approval decides based on `kind` alone). */
export function approvalDetail(name: string, input: Json, cwd: string): ApprovalDetail {
  // Running outside the sandbox is part of what is asked (#683 review): the card says so, and no list row answers it
  if (name === 'Bash') return { kind: 'command', command: str(input.command), cwd, ...(input.dangerouslyDisableSandbox === true ? { unsandboxed: true } : {}) }
  if (FILE_EDIT_TOOLS.has(name)) {
    const path = str(input.file_path ?? input.notebook_path, NO_PATH)
    const preview =
      str(input.new_string) || str(input.content) || str(input.new_source) || JSON.stringify(input).slice(0, 400)
    return { kind: 'file_edit', path, diffPreview: preview.slice(0, 400), multi: false }
  }
  return { kind: 'other', raw: `${name} ${JSON.stringify(input).slice(0, 300)}` }
}
