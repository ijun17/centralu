import { launchesSubagent, mcpNameParts, type ApprovalDetail, type ToolSummary } from '@cc/protocol'
import { diffLines, fileEditDetail, type FileChange } from '../file-changes.js'
import { centraluMark, isCentraluTool } from '../tool-titles.js'
import { str, type Json } from './json.js'

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

/**
 * The command a `centralu_run` call runs (#512, the `commands` tier), as the call it stands for: the
 * command's full name and its arguments. Null when it names no command, which leaves the card as the call.
 */
function commandRunOf(name: string, input: Json): { name: string; input: Json } | null {
  if (!isCentraluTool({ name }, 'centralu_run')) return null
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
  // The project asked (#371) — the caller's card names it, and finds the delegated session by it before the answer
  // A blank project is the name, as no project is (#730 review): the card then says "another project"
  else if (isCentraluTool({ name }, 'ask_project')) title = str(input.project).trim() || name
  /*
   * An agent card's title is the work handed to it (#98). While it was just the name, every card
   * said "Agent Agent", and launching three agents side by side left no way to tell which card was
   * which (a dogfooding session: all three showed the same line).
   */
  else if (launchesSubagent(name)) title = str(input.description, name)
  // Centralu's own servers (#730): marked, and titled by what the call does
  const parts = mcpNameParts(name)
  const mark = parts ? centraluMark(parts.server, parts.tool, input) : null
  return { tool: name, title: mark?.title ?? title, paths, ...(mark ? { centralu: mark.centralu } : {}) }
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
 * A card's result is cut at `RESULT_SUMMARY_CHARS` for every tool (adapters/tool-result.ts). An agent's
 * report routinely runs to tens of thousands of characters (dogfooding: 15-24KB), so only the
 * opening lands on the card, while the parent receives the full text and writes it in its own
 * words — if the card rendered the full text too, that is exactly what "the answer appears
 * twice" means.
 *
 * This returns the report uncut: its opening is the card's `summary`, and the whole of it is the
 * result's `output`, the record (#221).
 */
export function agentReport(report: string, stats: string): string {
  return stats ? `${stats}\n\n${report}` : report
}

/**
 * The whole text of a `tool_result` block — its `output` (#221): the string itself, or the blocks' text joined.
 *
 * Images are left out: they are saved as attachments (#40), and base64 would make the row as large as the picture.
 * So is any other block that carries base64 (a document, say). Other blocks are kept as their JSON. The card's
 * summary is the opening of this text too (#843). Measured on this machine's transcripts (2026-09-30), a result is a string
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

/**
 * What an Edit, Write or NotebookEdit call would do to its file, as Codex's file changes are read (#843). The card
 * showed only the new text, cut at 400 characters: an edit read the same whatever it replaced, and a Write that makes
 * a file the same as one that overwrites it. An Edit is its removed and its added lines; a notebook cell is its new
 * source. A Write is its content: as added lines when it makes a new file (`isNew`, which the adapter finds out, since
 * it knows the working folder), under a line saying it replaces the whole file when one is there, and under a line
 * saying it writes the whole file when that is not known. A Write's content is not marked as added to a file it
 * replaces, since nothing says which of its lines are new.
 */
export function claudeFileChange(name: string, input: Json, isNew?: boolean): FileChange {
  const path = str(input.file_path ?? input.notebook_path)
  if (name === 'Edit') {
    const diff = [diffLines('-', str(input.old_string)), diffLines('+', str(input.new_string))].filter(Boolean).join('\n')
    return { path, diff: input.replace_all === true && diff ? `(every occurrence)\n${diff}` : diff }
  }
  if (name === 'Write') {
    const content = str(input.content)
    if (isNew === true) return { path, diff: diffLines('+', content), change: 'add' }
    const head = isNew === false ? '(replaces the whole file)' : '(writes the whole file)'
    return { path, diff: content ? `${head}\n${content.replace(/\n$/, '')}` : '' }
  }
  const mode = str(input.edit_mode)
  const diff = diffLines('+', str(input.new_source))
  return { path, diff: mode === 'delete' ? `(deletes cell ${str(input.cell_id) || '?'})` : mode === 'insert' ? `(inserts a cell)\n${diff}` : diff }
}

/**
 * Normalizes an approval request into one of 3 kinds the banner can judge (core/approval decides based on `kind` alone).
 * `isNew` says whether a Write makes its file (`claudeFileChange`); absent when not known.
 */
export function approvalDetail(name: string, input: Json, cwd: string, isNew?: boolean): ApprovalDetail {
  // Running outside the sandbox is part of what is asked (#683 review): the card says so, and no list row answers it
  if (name === 'Bash') return { kind: 'command', command: str(input.command), cwd, ...(input.dangerouslyDisableSandbox === true ? { unsandboxed: true } : {}) }
  if (FILE_EDIT_TOOLS.has(name)) {
    const change = claudeFileChange(name, input, isNew)
    // A call that carries none of the fields read is shown as it came, rather than as an empty card
    return fileEditDetail([change.diff ? change : { ...change, diff: JSON.stringify(input) }])
  }
  return { kind: 'other', raw: `${name} ${JSON.stringify(input).slice(0, 300)}` }
}
