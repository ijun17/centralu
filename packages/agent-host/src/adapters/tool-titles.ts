import { appServerName, centraluServer, type NormalizedEvent, type ToolSummary } from '@cc/protocol'
import { CENTRALU_MCP_NAME } from '../apps/contract.js'
import { jsonObject, str, trimmed, type Obj } from '../json-value.js'

/**
 * Whether an MCP call is one of Centralu's own tools (#843): Claude names it `mcp__centralu__<tool>`, Codex by its
 * server and tool, where an item with no server named is taken as Centralu's (a call made from inside `exec`). The
 * two used to differ: Claude took `ask_project` and `centralu_run` from any server, so another server's tool of the
 * same name was titled and re-read as Centralu's.
 */
export function isCentraluTool(call: { name: string } | { server: string; tool: string }, tool: string): boolean {
  if ('name' in call) return call.name === `mcp__${CENTRALU_MCP_NAME}__${tool}`
  return call.tool === tool && (!call.server || call.server === CENTRALU_MCP_NAME)
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

/** What agent_session's actions do, in words (#730) */
const AGENT_ACTIONS: Record<string, string> = {
  status: 'Checked on an agent',
  send: 'Sent more to an agent',
  wait: 'Waited for an agent',
  stop: 'Stopped an agent',
  delete: 'Deleted an agent',
  answer: "Answered an agent's card",
  list: 'Listed its agents',
}

/** What Centralu's own tools do, in words (#730); one not named here reads as its name (`centraluCallLabel`) */
const CENTRALU_LABELS: Record<string, string> = {
  start_agent: 'Started an agent',
  ask_project: 'Asked a project',
  send_to_session: 'Sent to a session',
  read_session: 'Read a session',
  list_sessions: 'Listed sessions',
  answer_question: 'Answered a card',
  create_session: 'Started a session',
  update_centralu: 'Centralu update',
  compact_self: 'Asked to compact',
  recall: 'Searched past conversations',
  find_apps: 'Looked for apps',
  attach_app: 'Attached an app',
  detach_app: 'Detached an app',
  app_guide: 'Read the app guide',
  handoff_session: 'Handed the session over',
  create_project: 'Asked to add a project',
  add_project: 'Asked to add a folder as a project',
  list_machines: 'Listed linked machines',
  add_machine: 'Asked to link a machine',
  install_machine: 'Asked to install Centralu on a machine',
  remove_machine: 'Asked to remove a machine',
  reconnect_machine: 'Reconnected a machine',
  set_machine_auto_reconnect: 'Set whether a machine reconnects by itself',
  set_machine_autostart: 'Asked to change a machine starting at boot',
  disconnect_machine: 'Disconnected a machine',
  rollback_machine: 'Asked to roll a machine back',
  uninstall_machine: 'Asked to uninstall Centralu from a machine',
  machine_activity: 'Read what a machine is running',
  list_ssh_hosts: 'Listed the ssh config hosts',
  get_preferences: 'Read the preferences',
  set_preferences: 'Changed preferences',
  apply_agent_versions: 'Moved idle sessions to the new agent CLI',
  list_archive: 'Listed the session archive',
  restore_archived: 'Restored from the session archive',
  archive_subagent_steps: 'Moved subagent steps to the session archive',
  delete_session: 'Moved a session to the session archive',
  rename_session: 'Renamed a session',
  clear_background_tasks: 'Cleared the ended background tasks of a session',
  agent_status: 'Read the state of the agent CLIs',
  agent_models: 'Listed the models of an agent CLI',
  project_git_status: 'Read the git state of a project',
  search_project_files: 'Searched the files of a project',
  list_app_versions: 'Listed the versions of an app',
  restore_app_version: 'Restored an app to a version',
  restart_app: 'Restarted an app',
  check_app: 'Checked an app',
  list_app_runs: 'Listed the runs of an app',
  list_app_errors: 'Listed the errors of an app',
  app_usage: 'Read the agent use of an app',
  remove_app: 'Asked to remove an app',
  delete_archived: 'Asked to delete from the session archive for good',
  delete_all_archived: 'Asked to delete all archived sessions',
  propose_mcp_server: 'Proposed an MCP server',
  propose_skill: 'Proposed a skill',
  centralu_commands: 'Listed Centralu commands',
  centralu_help: 'Read a Centralu command',
}

/**
 * A call to one of Centralu's own servers, as its card shows it (#730): the mark (`ToolSummary.centralu`), what the
 * call does in words, and a title that reads as the argument a person follows the call by (the job an agent was
 * given, the project asked, the text sent) rather than its raw arguments. The session it names rides apart, so the
 * card can open it. A tool with nothing to say keeps the title it has. Null for any other server.
 */
export function centraluMark(server: string, tool: string, args: Record<string, unknown>): { centralu: NonNullable<ToolSummary['centralu']>; title?: string } | null {
  const origin = centraluServer(server)
  // An `app-<id>` server is never ours since #2231: apps are reached through the `app` tool, so such a server is the
  // repository's or the person's own, and its calls are not marked as an app's
  if (!origin || origin.app) return null
  if (tool === 'app') return appMark(args)
  const sessionId = trimmed(args.sessionId)
  const base = { tool, ...(sessionId ? { sessionId } : {}) }
  const text = (v: unknown) => {
    const t = trimmed(v)
    return t ? firstLine(t, 160) : undefined
  }
  const action = trimmed(args.action)
  let label = tool === 'agent_session' ? (action && AGENT_ACTIONS[action]) : CENTRALU_LABELS[tool]
  let title: string | undefined
  switch (tool) {
    case 'start_agent': {
      const how = [trimmed(args.tool), trimmed(args.model) ?? trimmed(args.difficulty)].filter(Boolean).join(', ')
      const job = text(args.task)
      title = job && how ? `${job} (${how})` : job
      break
    }
    case 'agent_session':
    case 'send_to_session':
    case 'answer_question':
      title = text(args.text)
      break
    case 'read_session':
      if (!sessionId) label = 'Listed sessions'
      break
    case 'ask_project':
      title = trimmed(args.project)
      break
    case 'update_centralu':
      title = action
      break
    case 'recall':
    case 'find_apps':
      title = trimmed(args.query)
      break
    case 'attach_app':
    case 'detach_app':
      title = trimmed(args.app)
      break
  }
  /*
   * With no argument to show, the title is the words: a raw `mcp__centralu__agent_session` said nothing, and a title
   * is never empty, since read_session lists a call by it
   */
  // Not ask_project's: its own row reads the title as the project, and a blank one as "another project"
  if (tool !== 'ask_project') title ??= label
  return { centralu: { ...base, ...(label ? { label } : {}) }, ...(title ? { title } : {}) }
}

/**
 * The app call an `app` tool call stands for (#2231): the app, the tool and the arguments inside it, read the same way for
 * a Claude call and a Codex item; null for any other call and for a listing. The one reading of an `app` call's arguments
 * for its card (`centraluMark`) and for matching its card to the call (`SessionApps.noteCall`).
 */
export function appCallOf(call: { name: string } | { server: string; tool: string }, input: unknown): { app: string; tool: string; args: Obj } | null {
  if (!isCentraluTool(call, 'app')) return null
  const a = jsonObject(input)
  const app = trimmed(a.app)
  const tool = trimmed(a.tool)
  return a.action === 'call' && app && tool ? { app, tool, args: jsonObject(a.args) } : null
}

/**
 * An `app` call's card (#2231): a call is drawn as the app's tool was before (the mark names the app and its tool, titled by
 * its arguments), a listing as what it read
 */
function appMark(args: Obj): { centralu: NonNullable<ToolSummary['centralu']>; title?: string } {
  const call = appCallOf({ server: CENTRALU_MCP_NAME, tool: 'app' }, args)
  if (call) {
    const shown = Object.keys(call.args).length ? firstLine(JSON.stringify(call.args), 160) : undefined
    return { centralu: { tool: call.tool, app: call.app }, ...(shown ? { title: shown } : {}) }
  }
  const app = trimmed(args.app)
  const label = app ? `Read the tools of ${app}` : 'Listed its apps'
  return { centralu: { tool: 'app', label }, title: app ?? label }
}

/**
 * An app's mark stays only on an `app` call naming an app this session has (#730 review, #2231): the agent may name one it
 * does not have, and that call is refused, not the app's. `attached` is the session's app server names. Applied where each
 * session emits, on its own calls and its subagents' steps; `attached` is read only for a marked app call.
 */
export function keepAttachedAppMarks(e: NormalizedEvent, attached: () => Iterable<string>): NormalizedEvent {
  const stray = (s: ToolSummary): ToolSummary | null => {
    if (!s.centralu?.app) return null
    // The name the agent wrote, or the server name earlier turns used (`namedApp`)
    const server = appServerName(s.centralu.app)
    for (const a of attached()) if (a === server || a === s.centralu.app) return null
    const { centralu: _gone, ...rest } = s
    return rest as ToolSummary
  }
  if (e.type === 'tool_call') {
    const s = stray(e.summary)
    return s ? { ...e, summary: s } : e
  }
  if (e.type === 'subagent_event' && e.step.type === 'tool_call') {
    const s = stray(e.step.summary)
    return s ? { ...e, step: { ...e.step, summary: s } } : e
  }
  return e
}
