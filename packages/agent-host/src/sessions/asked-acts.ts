import { oneLineText } from '@cc/protocol'

/**
 * What the orchestrator's acts are in a turn a session's request started (#1447, #1739, docs/plans/cited-requests.md): reads and answers in the
 * request's thread (`askedAct` null), and steps that change something. Of those, the ones listed as able to be undone (`UNDOABLE`) run without the
 * request's card, and so does work handed on to a session no looser than the asking one (`HANDS_ON`, decided by `AskedGate`'s host); every other step
 * asks the person first, whatever the orchestrator's own preset (`stepKind`).
 *
 * **Fail closed.** The reading acts and the steps that can be undone are listed; every other tool or command asks the person, so a command added
 * later asks until someone says it only reads or can be undone (`asked-acts.test.ts` holds every definition to one of the lists).
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
  'search_project_files',
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
 * Centralu's commands that can be undone, which a session's request runs without its card (owner, 2026-11-03), each with the way back. The cards a
 * command raises itself still ask, as in the person's own turn: adding a project or a machine, making one, trusting one, sharing an app, the
 * settings that ask (`AskedGate` does not cover them)
 */
const UNDOABLE: ReadonlySet<string> = new Set([
  'add_project', // removed from the list again
  'create_project', // its folder deleted
  'create_app', // removed
  'add_machine', // removed
  'disconnect_machine', // connected again
  'reconnect_machine', // disconnected
  'set_machine_auto_reconnect', // set back
  'set_project_trust', // set back
  'set_preferences', // set back
  'set_agent_limits', // set back
  'update_session_settings', // set back
  'rename_session', // renamed back
  'restore_archived', // archived again
  'attach_app', // detached
  'detach_app', // attached
  'share_app', // stopped
  'restart_app', // it starts again when called
  'check', // restarts the app being built
  'check_app', // the same, for an app
  'propose_mcp_server', // the person decides on the proposal
  'propose_skill', // the same
  // Three that take a remembered answer away, so that step asks again: the person answers it again
  'remove_approval_rule',
  'revoke_project_consent',
  'forget_app_answer',
])

/**
 * Work handed on to a session: run without the request's card unless the session it goes to runs under a looser preset than the asking session's
 * own (`AskedGateHost.noLooser`), the one check about power. Where it goes (another project, a linked machine) is the orchestrator's judgement,
 * recorded as every step is (owner, 2026-11-03)
 */
const HANDS_ON: ReadonlySet<string> = new Set(['create_session', 'send_to_session', 'start_agent', 'ask_project', 'handoff_session'])

/**
 * The steps a session's request never takes without the person's card, cited or not, besides every step no list names: what cannot be undone (a
 * delete, an uninstall, an OS entry, an install, a version put back over the current one, work stopped, an update applied), and an answer given
 * for the person
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
  'update_centralu',
  'answer_question',
])

/** Tools whose kind is read from their arguments (`askedAct`, `stepKind`): an action, or who the mail is for */
const BY_ARGUMENTS: ReadonlySet<string> = new Set(['agent_session', 'mail'])

/** Every list above: the test holds every tool and command definition to exactly one */
export const CLASSIFIED = { reads: READS, undoable: UNDOABLE, handsOn: HANDS_ON, asks: CANNOT_BE_UNDONE, byArguments: BY_ARGUMENTS } as const

/**
 * How a step of a request's turn that changes something is taken (`AskedGate`): `undoable` runs without the request's card, `handsOn` runs without
 * it unless the work goes to a session looser than the asking one, and `asks` puts it to the person first. `asks` is everything else: what cannot be undone, every
 * step of the CLI's own that is not a read, of another MCP server's or of an app's, which nobody here can tell can be undone (a command, a file
 * written or edited, an app's `queue_merge`), and every name no list holds
 */
export function stepKind(name: string, args: Record<string, unknown>): 'undoable' | 'handsOn' | 'asks' {
  if (UNDOABLE.has(name)) return 'undoable'
  if (HANDS_ON.has(name)) return 'handsOn'
  // Work given to a session's turn; stopping one, deleting one or answering its card is not undoable
  if (name === 'agent_session') return args.action === 'send' ? 'handsOn' : 'asks'
  // Mail that is neither an answer in the request's own thread nor to the person (`askedAct`): words to someone, who may act on them
  if (name === 'mail') return args.action === 'send' ? 'handsOn' : 'asks'
  return 'asks'
}

/**
 * The step as the person would be asked about it, or null for a read, which is free and leaves no record. `thread` is the thread of the turn (the
 * reaches someone else (`stepKind`). The thread is compared as the mail tool takes it, trimmed; with none (a turn of two askers) no post is the answer
 * reaches someone else (`stepKind`). The thread is compared as the mail tool takes it, trimmed
 */
export function askedAct(name: string, args: Record<string, unknown>, thread: string | null): AskedStep | null {
  if (READS.has(name)) return null
  if (name === 'update_centralu' && args.action === 'check') return null
  if (name === 'agent_session' && typeof args.action === 'string' && AGENT_READS.has(args.action)) return null
  if (name === 'mail') {
    const action = args.action
    if (action === 'inbox' || action === 'read') return null
    const inThread = thread !== null && typeof args.thread === 'string' && args.thread.trim() === thread
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

type AskerNamed = { name: string; project: string | null; trusted: boolean }

/** The card's question (§9.7): who asked, from the host's record of the session and its project, and what for. With requests of two sessions in the turn, it names each */
export function askedQuestion(asker: AskerNamed & { also?: readonly AskerNamed[] }, act: string): string {
  // JSON-quoted: a session named `x" in project "centralu` cannot pass as another project
  const who = (a: AskerNamed) =>
    `${JSON.stringify(oneLineText(a.name, 80))} ${a.project === null ? 'with no project' : `in project ${JSON.stringify(oneLineText(a.project, 80))}${a.trusted ? '' : ' (not trusted)'}`}`
  if (!asker.also?.length) return `Session ${who(asker)} asked the orchestrator to ${act}. It is the session's request, not yours.`
  const all = [asker, ...asker.also].map(who)
  return `Sessions ${all.slice(0, -1).join(', ')} and ${all.at(-1)} each asked the orchestrator for something in this turn, and Centralu cannot tell which of them this is for: ${act}. It is their request, not yours.`
}
