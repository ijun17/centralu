import { ORCHESTRATOR_MCP_NAME } from '../../apps/contract.js'
import { asObj } from '../../json-value.js'
import type { RequestPermission, ToolCallFields } from '../acp/wire.js'

/**
 * How Antigravity's ACP agent (1.4.3) names what a call does, read into the shape the ACP core reads
 * (docs/plans/antigravity-adapter.md §5; every shape below is from the spike's recorded frames unless said):
 *
 * | Call | Asked (`session/request_permission`) | Running | Ended |
 * |---|---|---|---|
 * | shell (`execute`) | `rawInput {CommandLine, Cwd, WaitMsBeforeAsync}` | `rawInput {command_line, working_dir}` | `rawOutput {exitCode, combinedOutput, …}` |
 * | edit (`edit`) | `rawInput {TargetFile, CodeContent, …}`, a `diff` content | a new call `<session>:<n>`, `rawInput {file_path}` | `rawOutput` a sentence |
 * | client write (`edit`) | `rawInput {target_file, code_content}` | the same id | — |
 * | MCP (`other`) | title `<server>_<tool>`, `_meta {mcp: {server, tool}}` | the same | `rawOutput` the text |
 * | replayed by `session/load` | `rawInput` as a JSON string | | |
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** A `rawInput` the agent replays as a JSON string (`session/load`, measured), read as the object it says */
function inputOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return asObj(JSON.parse(raw))
    } catch {
      return {}
    }
  }
  return asObj(raw)
}

/** The call's fields with the core's names added (`AcpToolShape.readCall`); the agent's own stay beside them */
export function readAgyCall(call: ToolCallFields): Partial<ToolCallFields> {
  const out: Partial<ToolCallFields> = {}
  if (call.rawInput !== undefined) {
    const input = inputOf(call.rawInput)
    const command = str(input.command) ?? str(input.CommandLine) ?? str(input.command_line)
    const cwd = str(input.cwd) ?? str(input.Cwd) ?? str(input.working_dir)
    const file = str(input.file_path) ?? str(input.TargetFile) ?? str(input.target_file) ?? str(input.absolute_path)
    const content = str(input.content) ?? str(input.CodeContent) ?? str(input.code_content)
    out.rawInput = {
      ...input,
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(file ? { file_path: file } : {}),
      ...(content ? { content } : {}),
    }
  }
  if (call.rawOutput !== undefined && typeof call.rawOutput === 'object' && call.rawOutput !== null) {
    const o = asObj(call.rawOutput)
    const output = str(o.output) ?? (typeof o.combinedOutput === 'string' ? o.combinedOutput : undefined)
    if (output !== undefined) out.rawOutput = { ...o, output }
  }
  return out
}

/**
 * A question to the person (from the agent's binary; none came up in the spike): `toolCallId` `interaction_<hex>`, no
 * `kind`, one option per answer. Never an approval: picking its first `allow_once` would answer it silently (spike §0.7)
 */
export function isAgyQuestion(req: Pick<RequestPermission, 'toolCall'>): boolean {
  return req.toolCall.toolCallId.startsWith('interaction_')
}

/**
 * Which of Centralu's own tools an MCP call is: the agent names the server in `_meta.mcp.server` and the tool in
 * `_meta.mcp.tool` (measured, s8), and asks for each MCP call (kind `other`). Only that kind, so a call of another kind
 * carrying the same names is never taken for Centralu's
 */
export function agyCentraluTool(call: ToolCallFields): string | null {
  if (call.kind !== 'other') return null
  const mcp = asObj(asObj(Reflect.get(call, '_meta')).mcp)
  return mcp.server === ORCHESTRATOR_MCP_NAME && typeof mcp.tool === 'string' && mcp.tool ? mcp.tool : null
}

/**
 * The agent's built-in tools switched off for every session (`_meta.antigravity.disabledTools` on `session/new`, `load` and
 * `resume`), by the names its server accepts: the `BuiltinTools` values of 1.4.3, read in its server. Any other name is
 * dropped there with "Unknown tool name in disabledTools" (measured: `grep_search`, `view_file_outline` and `view_code_item`
 * were, deep review of #1680), so only these spellings take effect:
 * - `view_file`, `search_directory` (its grep, which prints matching lines): read a file's content without asking. Reads
 *   come to Centralu instead (`fs/read_text_file`, inside the project folder only, never the agent's home)
 * - `invoke_subagent`: a subagent keeps the built-in viewer whatever the filter says, and read a file inside `GEMINI_HOME`
 *   in the review. With it off the server sets `enable_subagents: false`, and the model's tools lose `invoke_subagent`,
 *   `define_subagent`, `run_workflow` and `send_message` (measured in the session's recorded tool list)
 * - `run_workflow`: a multi-agent script, subagents by another door
 * `list_directory` and `find_file` say names only, and are off by the server's default anyway.
 */
export const AGY_DISABLED_TOOLS: readonly string[] = ['view_file', 'search_directory', 'invoke_subagent', 'run_workflow']

/**
 * A permission request for a subagent or a workflow, refused under every preset and rule (`AcpToolShape.neverAllowed`):
 * the tools are switched off (`AGY_DISABLED_TOOLS`), so one arriving means the filter did not hold, and a subagent reads
 * the agent's home with no card. The agent titles a built-in's request `Run <tool>?` (its server; recorded in the review:
 * `Run invoke_subagent?`, kind `other`)
 */
export function isAgySubagentCall(req: Pick<RequestPermission, 'toolCall'>): boolean {
  return /^Run (invoke_subagent|start_subagent|define_subagent|run_workflow)\?$/.test(req.toolCall.title ?? '')
}

export function agySessionMeta(): Record<string, unknown> {
  return { antigravity: { disabledTools: [...AGY_DISABLED_TOOLS] } }
}

/**
 * A stderr line as host.log and a crash message may carry it. The agent logs its account's onboarding answer (which names
 * the account's email in an address), its sign-in address and its home's path at every start (spike stderr): a line
 * with an address in it is left out, and so is one with an email.
 */
export function agyStderrLine(line: string): string | null {
  if (/https?:\/\//i.test(line)) return null
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(line)) return null
  if (/loadCodeAssist|oauth|token/i.test(line)) return null
  return line
}
