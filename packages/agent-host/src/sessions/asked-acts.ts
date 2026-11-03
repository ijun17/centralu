import { oneLineText } from '@cc/protocol'

/**
 * What the orchestrator's acts are in a turn a session's request started (#1447, #1739, docs/plans/cited-requests.md): reads and answers in the
 * request's thread (`askedAct` null), steps that change something, and among those the ones that cannot be undone (`cannotBeUndone`), which ask
 * the person first, whatever the orchestrator's own preset.
 *
 * **Fail closed.** The reading acts are listed; every other tool or command counts as a change, which is recorded, so a command added later is recorded until someone says it only reads.
 */

/** Tools and commands that only read, or only change this orchestrator's own turn: no card (§9.7) */
const READS: ReadonlySet<string> = new Set([
  'list_sessions',
  'read_session',
  'recall',
  'usage_history',
  'app_guide',
  'find_apps',
  'compact_self',
  // The commands that only read (#1219)
  'get_preferences',
  'list_machines',
  'machine_activity',
  'list_ssh_hosts',
  'list_archive',
  'list_projects',
  'list_approval_rules',
  'list_app_grants',
  'agent_status',
  'agent_models',
  'project_git_status',
  'list_app_versions',
  'list_app_runs',
  'list_app_errors',
  'app_usage',
  // The three tools that list and run commands: the command that is run is asked about by its own name
  'centralu_commands',
  'centralu_help',
  'centralu_run',
  // The CLI's own tools that only read or only plan: a command, a file written, a page fetched or a subagent started is not among them
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'AskUserQuestion',
  // Looks up the definition of a tool the CLI keeps back; the call of that tool is what is decided
  'ToolSearch',
])

/**
 * The CLI's own tools that start work which goes on after the turn that started it, or start a turn of the CLI's own later: a subagent, a prompt
 * scheduled for later, a stream of events from a watched command. The person's card belongs to the request's turn; what runs on after it would run
 * with no asker and no card (found by the review of #1516: a subagent's later steps, a cron prompt's, ran unasked under auto). So a request's turn is
 * refused them outright, not asked about
 */
const OUTLIVES_THE_TURN: ReadonlySet<string> = new Set(['Agent', 'Task', 'CronCreate', 'ScheduleWakeup', 'Workflow', 'Monitor', 'RemoteTrigger'])

/**
 * Whether the CLI's tool would outlive the turn it is called in (see `OUTLIVES_THE_TURN`). Also a command started in the background: when it ends
 * the CLI starts a turn of its own, which runs the rest of what the request asked for with no asker and no card
 */
export function outlivesTheTurn(name: string, input: Record<string, unknown>): boolean {
  return OUTLIVES_THE_TURN.has(name) || ((name === 'Bash' || name === 'PowerShell') && input.run_in_background === true)
}

/** The CLI's own tools are named in capitals (`Bash`, `Write`) or by their MCP server (`mcp__…`); Centralu's tools and commands in lower case with underscores */
const isCliTool = (name: string): boolean => /^[A-Z]/.test(name) || name.startsWith('mcp__')

/** `agent_session` actions that only look */
const AGENT_READS: ReadonlySet<string> = new Set(['list', 'status', 'wait'])

/**
 * The arguments that are free text, which the card cuts when they are long. Every other argument is shown whole: a machine, a project, a
 * session, a branch, a name, a command, a path or an argument list is what the person decides on, and a card that cut it could hide
 * the one that matters
 */
const FREE_TEXT: ReadonlySet<string> = new Set([
  'text',
  'task',
  'message',
  'body',
  'prompt',
  'firstMessage',
  'description',
  'instructions',
  'content',
  'why',
  'reason',
  'subject',
  'next',
  'blocker',
  'old_string',
  'new_string',
])

/** The most of one free-text argument the card shows */
const FREE_CHARS = 300
/** The most a card shows of a step: past it the step is not asked about and not done, since part of it would be hidden */
const ACT_MAX = 2000
/** The most a card shows of a step of the CLI's own, whose payload is not cut */
const CLI_ACT_MAX = 6000

/**
 * The arguments as one line of JSON. For Centralu's own tools long free text is cut and marked with its length, the rest whole. For the CLI's own tools
 * nothing is cut: what a `Write` puts in a file, an `Edit` swaps in or a message sends is the payload the person decides on, not commentary on it
 */
function argsLine(args: Record<string, unknown>, cut: boolean): string {
  return JSON.stringify(args, (key: string, value: unknown): unknown =>
    cut && key !== '' && FREE_TEXT.has(key) && typeof value === 'string' && value.length > FREE_CHARS ? `${value.slice(0, FREE_CHARS)}… (${value.length} characters)` : value,
  )
}

/** What the person is asked to allow: the step as one line, or that it does not fit a card */
export type AskedStep = { act: string } | { tooLong: true }

/**
 * The steps a session's request never takes without the person's card, cited or not (owner, 2026-11-03): what cannot be undone. A delete, an
 * uninstall, an OS entry, an install, a version put back over the current one, work stopped, an update applied
 */
const CANNOT_BE_UNDONE: ReadonlySet<string> = new Set([
  'delete_session',
  'delete_archived',
  'delete_all_archived',
  'archive_subagent_steps',
  'install_machine',
  'remove_machine',
  'uninstall_machine',
  'rollback_machine',
  'set_machine_autostart',
  'remove_app',
  'restore_app_version',
  'apply_agent_versions',
  'clear_background_tasks',
])

/**
 * Whether a step of a request's turn asks the person first (`AskedGate`): one that cannot be undone, an update installed or applied, and every step
 * of the CLI's own that is not a read, of another MCP server's or of an app's, which nobody here can tell can be undone (a command, a file written
 * or edited, an app's `queue_merge`)
 */
export function cannotBeUndone(name: string, args: Record<string, unknown>): boolean {
  return CANNOT_BE_UNDONE.has(name) || (name === 'update_centralu' && args.action !== 'check') || isCliTool(name) || name.includes('.')
}

/**
 * What the person is asked to allow, or null when the call needs no card. `thread` is the thread of the turn (the session's request): a post
 * in it is the answer, and needs no card; a post in another thread, or mail to anyone but the person, reaches someone else and asks. The thread is
 * compared as the mail tool takes it, trimmed
 */
export function askedAct(name: string, args: Record<string, unknown>, thread: string): AskedStep | null {
  if (READS.has(name)) return null
  if (name === 'update_centralu' && args.action === 'check') return null
  if (name === 'agent_session' && typeof args.action === 'string' && AGENT_READS.has(args.action)) return null
  if (name === 'mail') {
    const action = args.action
    if (action === 'inbox' || action === 'read') return null
    const inThread = typeof args.thread === 'string' && args.thread.trim() === thread
    // Answering, and marking handled, in the request's own thread; marking another thread handled would keep the orchestrator from being woken for it
    if ((action === 'reply' || action === 'update' || action === 'close' || action === 'handled') && inThread) return null
    if (action === 'send' && typeof args.to === 'string' && args.to.trim() === 'person') return null
  }
  return stepOf(name, args)
}

/** The step as the card shows it, whatever the call is: `run <name> <arguments>`, or that it does not fit */
export function stepOf(name: string, args: Record<string, unknown>): AskedStep {
  const cli = isCliTool(name)
  const shown = argsLine(args, !cli)
  const act = `run ${name} ${shown === '{}' ? '' : shown}`.trim()
  return act.length > (cli ? CLI_ACT_MAX : ACT_MAX) ? { tooLong: true } : { act }
}

/** The card's question (§9.7): who asked, from the host's record of the session and its project, and what for */
export function askedQuestion(asker: { name: string; project: string | null; trusted: boolean }, act: string): string {
  // JSON-quoted: a session named `x" in project "centralu` cannot pass as another project
  const where = asker.project === null ? 'with no project' : `in project ${JSON.stringify(oneLineText(asker.project, 80))}${asker.trusted ? '' : ' (not trusted)'}`
  return `Session ${JSON.stringify(oneLineText(asker.name, 80))} ${where} asked the orchestrator to ${act}. It is the session's request, not yours.`
}
