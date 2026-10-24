import { oneLineText } from '@cc/protocol'

/**
 * Which acts of the orchestrator ask the person when a session asked for them (docs/plans/mailbox.md §9.7, #1447).
 *
 * A turn whose thread a session opened is that session's request, and a session's words are not the person's. So in such a turn every
 * step the orchestrator could not take from an untrusted text alone raises the person's card, whatever the orchestrator's own preset:
 * anything that changes sessions, projects, settings, machines, installations or apps, starts agents, or deletes. Reading, and
 * answering in the thread that asked, need no card.
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
  'search_project_files',
  'list_app_versions',
  'check_app',
  'list_app_runs',
  'list_app_errors',
  'app_usage',
  'check',
  // The three tools that list and run commands: the command that is run is asked about by its own name
  'centralu_commands',
  'centralu_help',
  'centralu_run',
])

/** `agent_session` actions that only look */
const AGENT_READS: ReadonlySet<string> = new Set(['list', 'status', 'wait'])

const ARG_CHARS = 200
const ACT_CHARS = 500

/** The arguments as one short line of JSON: a long string is cut, so a card stays a card and not the model's whole message */
function argsLine(args: Record<string, unknown>): string {
  const cut = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' && v.length > ARG_CHARS ? `${v.slice(0, ARG_CHARS)}…` : v]))
  return JSON.stringify(cut)
}

/**
 * What the person is asked to allow, or null when the call needs no card. `thread` is the thread of the turn (the session's request): a post
 * in it is the answer, and needs no card; a post in another thread, or mail to anyone but the person, reaches someone else and asks
 */
export function askedAct(name: string, args: Record<string, unknown>, thread: string): string | null {
  if (READS.has(name)) return null
  if (name === 'update_centralu' && args.action === 'check') return null
  if (name === 'agent_session' && typeof args.action === 'string' && AGENT_READS.has(args.action)) return null
  if (name === 'mail') {
    const action = args.action
    if (action === 'inbox' || action === 'read' || action === 'handled') return null
    if ((action === 'reply' || action === 'update' || action === 'close') && args.thread === thread) return null
    if (action === 'send' && typeof args.to === 'string' && args.to.trim() === 'person') return null
  }
  const shown = argsLine(args)
  return oneLineText(`run ${name} ${shown === '{}' ? '' : shown}`.trim(), ACT_CHARS)
}

/** The card's question (§9.7): who asked, from the host's record of the session and its project, and what for */
export function askedQuestion(asker: { name: string; project: string | null; trusted: boolean }, act: string): string {
  const where = asker.project === null ? 'with no project' : `in project "${oneLineText(asker.project, 80)}"${asker.trusted ? '' : ' (not trusted)'}`
  return `Session "${oneLineText(asker.name, 80)}" ${where} asked the orchestrator to ${act}. It is the session's request, not yours.`
}
