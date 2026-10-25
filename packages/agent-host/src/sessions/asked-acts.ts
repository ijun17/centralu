import { oneLineText } from '@cc/protocol'

/**
 * Which acts of the orchestrator ask the person when a session asked for them (docs/plans/mailbox.md §9.7, #1447).
 *
 * A turn whose thread a session opened is that session's request, and a session's words are not the person's. So in such a turn every
 * step the orchestrator could not take from an untrusted text alone raises the person's card, whatever the orchestrator's own preset:
 * anything that changes sessions, projects, settings, machines, installations or apps, starts agents, deletes, runs a command or writes a
 * file. Reading, and answering in the thread that asked, need no card.
 *
 * **Fail closed.** The reading acts are listed; every other tool or command asks, so a command added later asks until someone says it only reads.
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
export type AskedStep = { act: string; afterRead?: true } | { tooLong: true }

/**
 * What the person is asked to allow, or null when the call needs no card. `thread` is the thread of the turn (the session's request): a post
 * in it is the answer, and needs no card; a post in another thread, or mail to anyone but the person, reaches someone else and asks.
 * `reached` says what the orchestrator's conversation read that the asking session could not read itself (`AskedGate`): after that every word to a
 * session asks, the answer in the thread included, with its text shown whole, since it could carry what was read to the session. The thread is
 * compared as the mail tool takes it, trimmed
 */
export function askedAct(name: string, args: Record<string, unknown>, thread: string, reached: string | null = null): AskedStep | null {
  if (READS.has(name)) return null
  if (name === 'update_centralu' && args.action === 'check') return null
  if (name === 'agent_session' && typeof args.action === 'string' && AGENT_READS.has(args.action)) return null
  if (name === 'mail') {
    const action = args.action
    if (action === 'inbox' || action === 'read') return null
    const inThread = typeof args.thread === 'string' && args.thread.trim() === thread
    const toPerson = action === 'send' && typeof args.to === 'string' && args.to.trim() === 'person'
    if (reached !== null && !toPerson && (action === 'reply' || action === 'update' || action === 'close' || action === 'send')) {
      const act = `${inThread ? 'answer it' : 'write to a session'}, though the orchestrator has read what this session could not read itself (${reached}): run mail ${argsLine(args, false)}`
      return act.length > CLI_ACT_MAX ? { tooLong: true } : { act, afterRead: true }
    }
    // Answering, and marking handled, in the request's own thread; marking another thread handled would keep the orchestrator from being woken for it
    if ((action === 'reply' || action === 'update' || action === 'close' || action === 'handled') && inThread) return null
    if (toPerson) return null
  }
  // After such a read any step that passes words on shows them whole, as the mail does
  return stepOf(name, args, reached !== null)
}

/** The step as the card shows it, whatever the call is: `run <name> <arguments>`, or that it does not fit */
export function stepOf(name: string, args: Record<string, unknown>, whole = false): AskedStep {
  const cli = isCliTool(name) || whole
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
