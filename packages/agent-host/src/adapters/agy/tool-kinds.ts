import { asObj, trimmed } from '../../json-value.js'

/**
 * What `agy`'s tools are, by name (docs/plans/antigravity-adapter.md §5.2). The gate reads the kind to decide, and the
 * normalizer reads the name and paths to draw a card. `init.tools` is not the list of what runs (`write_file` ran
 * without being in it), so a name that is not here is `other`, which the gate answers with a card, never an allow.
 */
export type AgyToolKind = 'read' | 'edit' | 'execute' | 'mcp' | 'subagent' | 'other'

const READ = ['view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name']
// `write_file` is not in the CLI's own list but ran in a recording (agy-1.4.7/edit)
const EDIT = ['write_to_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']
const EXECUTE = ['run_command', 'send_command_input', 'notebook_execution']
const SUBAGENT = ['invoke_subagent', 'send_message']

const KINDS = new Map<string, AgyToolKind>([
  ...READ.map((n): [string, AgyToolKind] => [n, 'read']),
  ...EDIT.map((n): [string, AgyToolKind] => [n, 'edit']),
  ...EXECUTE.map((n): [string, AgyToolKind] => [n, 'execute']),
  ...SUBAGENT.map((n): [string, AgyToolKind] => [n, 'subagent']),
  ['call_mcp_tool', 'mcp'],
])

export const toolKind = (name: string): AgyToolKind => KINDS.get(name) ?? 'other'

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

/** The arguments that name a file or folder, as `agy` spells them (measured, and the strings in its binary) */
const PATH_ARGS = ['Path', 'TargetFile', 'AbsolutePath', 'FilePath', 'SearchPath']

/** The paths a call names, in the order of `PATH_ARGS`, each once */
export function pathsOf(args: unknown): string[] {
  const a = asObj(args)
  return [...new Set(PATH_ARGS.flatMap((k) => trimmed(a[k]) ?? []))]
}

/** The MCP server a `call_mcp_tool` names, or '' */
export const mcpServer = (args: unknown): string => trimmed(asObj(args).ServerName) ?? ''

/** What a card's title says of the call: the command, the path, the sub-agent's role, the MCP tool */
export function titleOf(name: string, args: unknown): string {
  const a = asObj(args)
  switch (toolKind(name)) {
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
