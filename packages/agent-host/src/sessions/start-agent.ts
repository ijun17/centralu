import type { PermissionPreset } from '@cc/protocol'

/**
 * start_agent and agent_session (#561) — an ordinary session starts another agent (Claude or Codex) in its own
 * project and works with it: gives it a task, waits for its answer, sends it more, stops it.
 *
 * Standing the child up, the consent, the ceiling and the waits are the manager's (`SessionManager.startAgent`,
 * `agentSession`), on ask_project's machinery (`Delegation`, `AgentRunWait`). What lives here is the pure part: the
 * ceiling, the preset rule and the frame the task travels in.
 */

/**
 * How many children started with start_agent may run at once in one project, counted over every session of the
 * project. A child counts while a turn the parent gave it is running; one the person took over, or one at rest, does
 * not. Four: enough for a parent to fan work out to Claude and Codex side by side, few enough that one runaway
 * parent (or a planted instruction it read) cannot fill the machine and the person's usage before they notice.
 */
export const AGENT_CEILING = 4

const PRESET_RANK: Record<PermissionPreset, number> = { safe: 0, normal: 1, auto: 2 }

/** Whether a session under `child` may act for a session under `parent`: never with more than the parent's own permissions */
export function presetWithin(child: PermissionPreset, parent: PermissionPreset): boolean {
  return PRESET_RANK[child] <= PRESET_RANK[parent]
}

/**
 * The message a child receives. It says who asks and how the answer travels back, as ask_project's frame does: the
 * child cannot see its parent, and its final text is all the parent reads. It directs nothing else (product-spec.md
 * §1.2): the task is the parent's words, and the child works under its own approvals.
 */
export function agentFrame(parentName: string, task: string): string {
  return [
    `[Another session in this project, "${parentName}", gives you this task through Centralu's start_agent. ` +
      'Your final message goes back to it as the answer: keep it short, and name the files it should read by their absolute paths.]',
    '',
    task,
  ].join('\n')
}

/** The name a child starts with: its task's first words, like a session the person starts with a message */
export function agentName(task: string, max = 48): string {
  const one = task.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one || 'Agent'
}
