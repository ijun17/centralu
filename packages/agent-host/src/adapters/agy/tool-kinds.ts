import { asObj, trimmed } from '../../json-value.js'

/**
 * What `agy`'s tools are, by name (docs/plans/antigravity-adapter.md §5.2). The gate reads the kind to decide, and the
 * normalizer reads the name and paths to draw a card. `init.tools` is not the list of what runs (`write_file` ran
 * without being in it), so a name that is not here is `other`, which the gate answers with a card, never an allow.
 *
 * The names: the twelve tools `agy` 1.4.8 gives its model (asked of the model, 2026-10-27: `read_file`, `write_file`,
 * `edit_file`, `run_command`, `manage_task`, `send_message`, `schedule`, `invoke_subagent`, `define_subagent`,
 * `manage_subagents`, `search_web`, `ask_question`), `call_mcp_tool`, and the older names its binary still holds.
 */
export type AgyToolKind = 'read' | 'edit' | 'execute' | 'mcp' | 'subagent' | 'web' | 'other'

const READ = ['view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name']
// `write_file` is not in the CLI's own list but ran in a recording (agy-1.4.7/edit); `edit_file` is 1.4.8's edit tool
const EDIT = ['write_to_file', 'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']
const EXECUTE = ['run_command', 'send_command_input', 'notebook_execution']
/**
 * The agent's own conversation: sub-agents, messages to them, its background tasks and timers, a question to the
 * person. None touches a file or runs a command itself; what a sub-agent or a timer's turn does passes the gate call by
 * call. `manage_task` sending input to a running task is an execute call (`toolKind`)
 */
const SUBAGENT = ['invoke_subagent', 'send_message', 'define_subagent', 'manage_subagents', 'manage_task', 'schedule', 'ask_question']
const WEB = ['search_web', 'read_url_content']

const KINDS = new Map<string, AgyToolKind>([
  ...READ.map((n): [string, AgyToolKind] => [n, 'read']),
  ...EDIT.map((n): [string, AgyToolKind] => [n, 'edit']),
  ...EXECUTE.map((n): [string, AgyToolKind] => [n, 'execute']),
  ...SUBAGENT.map((n): [string, AgyToolKind] => [n, 'subagent']),
  ...WEB.map((n): [string, AgyToolKind] => [n, 'web']),
  ['call_mcp_tool', 'mcp'],
])

/** A tool's kind; `manage_task` that sends input to a running task (`send_input`, or any call with `Input`) executes */
export function toolKind(name: string, args?: unknown): AgyToolKind {
  if (name === 'manage_task') {
    const a = asObj(args)
    if (a.Action === 'send_input' || trimmed(a.Input) !== undefined) return 'execute'
  }
  return KINDS.get(name) ?? 'other'
}

/** The names a card gives the tool, the same ones the other adapters use; a tool without one reads as its own name */
const CARD_NAMES: Record<string, string> = {
  run_command: 'Bash',
  send_command_input: 'Bash',
  view_file: 'Read',
  read_file: 'Read',
  grep_search: 'Grep',
  find_by_name: 'Grep',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
}

export const cardName = (name: string): string => (toolKind(name) === 'edit' ? 'Edit' : (CARD_NAMES[name] ?? name))

/**
 * The arguments that name a file or folder: the names `agy` uses (measured, and its binary: `DirectoryPath`,
 * `SearchDirectory`, `NotebookPath`, `FilePaths`, `TargetFiles`, `OutputPath`, `ImagePaths`, …) and any argument named
 * like them, so a name the gate has not seen is read too. `Cwd` is where a command runs
 */
const PATH_ARG = /(^|[a-z])(Path|Paths|File|Files|Directory|Directories|Dir|Dirs|Folder|Folders|Uri|Uris)$|^(Cwd|Workdir|WorkingDirectory)$/

/** Arguments that are text, never a path, whatever they start with */
const TEXT_ARGS = new Set([
  'CommandLine', 'Command', 'command', 'Input', 'Content', 'CodeContent', 'ReplacementContent', 'Replacement', 'Target',
  'TargetContent', 'Query', 'query', 'Prompt', 'Message', 'SystemPrompt', 'Description', 'Instruction', 'toolSummary',
  'SedScript', 'Role', 'TypeName', 'Name', 'Url', 'URL', 'url', 'domain', 'CronExpression', 'Summary', 'Explanation',
])

/** A value that reads as a path on its own: absolute, from home, a drive, a share, a file URL; one line */
const PATH_LIKE = /^(\/|~|[A-Za-z]:[\\/]|\\\\|file:)/

const stringsOf = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/**
 * The paths a call names, each once: every argument named like a path (`PATH_ARG`, a list too), then any other
 * argument's value that reads as a path (`PATH_LIKE`), so a path under an argument name nobody listed is still checked
 */
export function pathsOf(args: unknown): string[] {
  const a = asObj(args)
  const named: string[] = []
  const stray: string[] = []
  for (const [k, v] of Object.entries(a)) {
    if (TEXT_ARGS.has(k)) continue
    const values = stringsOf(v).map((x) => x.trim()).filter(Boolean)
    if (PATH_ARG.test(k)) named.push(...values)
    else stray.push(...values.filter((x) => !x.includes('\n') && PATH_LIKE.test(x)))
  }
  return [...new Set([...named, ...stray])]
}

/** The MCP server a `call_mcp_tool` names, or '' */
export const mcpServer = (args: unknown): string => trimmed(asObj(args).ServerName) ?? ''

/** What a card's title says of the call: the command, the path, the sub-agent's role, the MCP tool */
export function titleOf(name: string, args: unknown): string {
  const a = asObj(args)
  switch (toolKind(name, a)) {
    case 'execute':
      return trimmed(a.CommandLine) ?? name
    case 'mcp':
      return [trimmed(a.ServerName), trimmed(a.ToolName)].filter(Boolean).join(' · ') || name
    case 'subagent':
      return trimmed(a.Role) ?? trimmed(a.TypeName) ?? name
    default:
      return pathsOf(a)[0] ?? trimmed(a.Url) ?? trimmed(a.Query) ?? name
  }
}
