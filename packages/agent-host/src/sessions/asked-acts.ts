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
const OUTLIVES_THE_TURN: ReadonlySet<string> = new Set(['Agent', 'Task', 'CronCreate', 'ScheduleWakeup', 'Workflow', 'Monitor'])

/** Whether the CLI's tool would outlive the turn it is called in (see `OUTLIVES_THE_TURN`) */
export function outlivesTheTurn(name: string): boolean {
  return OUTLIVES_THE_TURN.has(name)
}

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

/** The arguments as one line of JSON, free text cut and marked with its length, the rest whole */
function argsLine(args: Record<string, unknown>): string {
  return JSON.stringify(args, (key: string, value: unknown): unknown =>
    key !== '' && FREE_TEXT.has(key) && typeof value === 'string' && value.length > FREE_CHARS ? `${value.slice(0, FREE_CHARS)}… (${value.length} characters)` : value,
  )
}

/** What the person is asked to allow: the step as one line, or that it does not fit a card */
export type AskedStep = { act: string } | { tooLong: true }

/**
 * What the person is asked to allow, or null when the call needs no card. `thread` is the thread of the turn (the session's request): a post
 * in it is the answer, and needs no card; a post in another thread, or mail to anyone but the person, reaches someone else and asks
 */
export function askedAct(name: string, args: Record<string, unknown>, thread: string): AskedStep | null {
  if (READS.has(name)) return null
  if (name === 'update_centralu' && args.action === 'check') return null
  if (name === 'agent_session' && typeof args.action === 'string' && AGENT_READS.has(args.action)) return null
  if (name === 'mail') {
    const action = args.action
    if (action === 'inbox' || action === 'read') return null
    // Answering, and marking handled, in the request's own thread; marking another thread handled would keep the orchestrator from being woken for it
    if ((action === 'reply' || action === 'update' || action === 'close' || action === 'handled') && args.thread === thread) return null
    if (action === 'send' && typeof args.to === 'string' && args.to.trim() === 'person') return null
  }
  const shown = argsLine(args)
  const act = `run ${name} ${shown === '{}' ? '' : shown}`.trim()
  return act.length > ACT_MAX ? { tooLong: true } : { act }
}

/** The card's question (§9.7): who asked, from the host's record of the session and its project, and what for */
export function askedQuestion(asker: { name: string; project: string | null; trusted: boolean }, act: string): string {
  // JSON-quoted: a session named `x" in project "centralu` cannot pass as another project
  const where = asker.project === null ? 'with no project' : `in project ${JSON.stringify(oneLineText(asker.project, 80))}${asker.trusted ? '' : ' (not trusted)'}`
  return `Session ${JSON.stringify(oneLineText(asker.name, 80))} ${where} asked the orchestrator to ${act}. It is the session's request, not yours.`
}
