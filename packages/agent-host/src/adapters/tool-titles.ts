import type { ToolSummary } from '@cc/protocol'
import { ORCHESTRATOR_MCP_NAME } from '../apps/contract.js'
import { jsonObject, str, type Obj } from '../json-value.js'

/**
 * Whether an MCP call is one of Centralu's own tools (#843): Claude names it `mcp__centralu__<tool>`, Codex by its
 * server and tool, where an item with no server named is taken as Centralu's (a call made from inside `exec`). The
 * two used to differ: Claude took `ask_project` and `centralu_run` from any server, so another server's tool of the
 * same name was titled and re-read as Centralu's.
 */
export function isCentraluTool(call: { name: string } | { server: string; tool: string }, tool: string): boolean {
  if ('name' in call) return call.name === `mcp__${ORCHESTRATOR_MCP_NAME}__${tool}`
  return call.tool === tool && (!call.server || call.server === ORCHESTRATOR_MCP_NAME)
}

/**
 * The command a `centralu_run` call runs (#512, the `commands` tier) and its arguments, from the call's arguments
 * `{command, args}`, where `args` is an object or JSON text of one. A card is titled as the command it stands for, by
 * the same rule for a Claude call and a Codex item (each kept a copy of it). Null when it names no command, which
 * leaves the card as the call.
 */
export function centraluRunCommand(args: Obj): { command: string; args: Obj } | null {
  const command = str(args.command).trim()
  if (!/^[a-z]+(?:_[a-z]+)*$/.test(command)) return null
  return { command, args: jsonObject(args.args) }
}

/**
 * The first line of a text, cut at `max` characters with ` …` when anything was left out: an agent card's title from
 * its prompt (#98, #222), a subagent's step, a child agent's description.
 */
export function firstLine(text: string, max = 200): string {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  return first.slice(0, max) + (lines.length > 1 || first.length > max ? ' …' : '')
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
  const head = firstLine(s.title)
  return head === s.tool || head.startsWith(`${s.tool}:`) ? head : `${s.tool}: ${head}`
}
