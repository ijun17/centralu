import { APP_SLUG, frameField, oneLineText, type AgentDifficulty, type AgentModels, type PermissionPreset, type ToolDefaults } from '@cc/protocol'

/**
 * start_agent and agent_session (#561) — an ordinary session starts another agent (Claude or Codex) in its own
 * project and works with it: gives it a task, waits for its answer, sends it more, stops it.
 *
 * Standing the child up, the consent, the ceiling and the waits are the manager's (`SessionManager.startAgent`,
 * `agentSession`), on ask_project's machinery (`Delegation`, `AgentRunWait`). What lives here is the pure part: the
 * ceiling, the preset rule and the frame the task travels in.
 */

/**
 * The default ceiling under safe/normal (auto has none; prefs.agentCeiling overrides either).
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
 * child cannot see its parent, and its final text is all the parent reads; so the answer waits for the child's own
 * background work rather than ending the turn on "waiting for it" (#729). It directs nothing else (product-spec.md
 * §1.2): the task is the parent's words, and the child works under its own approvals.
 */
export function agentFrame(parentName: string, task: string): string {
  return [
    `[Another session in this project, "${frameField(parentName)}", gives you this task through Centralu's start_agent. ` +
      'Your final message goes back to it as the answer: keep it short, and name the files it should read by their absolute paths. ' +
      // #729: children that backgrounded their verify and ended the turn "waiting for it" left the parent unanswered (#721)
      'Wait for your own background work that ends (a test run, a build) inside your turn before you answer.]',
    '',
    task,
  ].join('\n')
}

/**
 * The model and effort a child starts on (#107, #729), in order:
 *
 *   1. A model the caller named. Its effort is the one named, else the project's remembered one when it is the
 *      remembered model (an effort belongs to its model), else the model's default.
 *   2. A difficulty the caller named, with a model the person chose for it and this tool in Settings
 *      (`prefs.agentModels`): that model, and the effort named or the one chosen with it. `difficulty` is returned
 *      only then, so the card says the person's setting picked the model.
 *   3. The project's remembered choice for the tool, as a session the person opens there gets.
 *
 * A model empty in all three is the tool's own default.
 */
export function agentChoice(
  asked: { model?: string; effort?: string; difficulty?: AgentDifficulty },
  remembered: ToolDefaults | undefined,
  byDifficulty: AgentModels[string] | undefined,
): { model?: string; effort?: string; difficulty?: AgentDifficulty } {
  const picked = !asked.model && asked.difficulty ? byDifficulty?.[asked.difficulty] : undefined
  if (picked) {
    const effort = asked.effort ?? picked.effort
    return { model: picked.model, ...(effort ? { effort } : {}), difficulty: asked.difficulty }
  }
  const model = asked.model ?? remembered?.model ?? undefined
  const effort = asked.effort ?? (!asked.model || asked.model === remembered?.model ? (remembered?.effort ?? undefined) : undefined)
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** A follow-up carries the parent's words without replacing the task or promising an independent answer. */
export function agentNoteFrame(parentName: string, text: string): string {
  return `[A note from the parent session "${frameField(parentName)}" through Centralu's agent_session. These are the parent's words about your ongoing work.]\n\n${text}`
}

/**
 * The branch of a child's new worktree when the caller names none (#561 part 2): the job's first words as a slug under
 * Centralu's prefix, so the branch says what it is for, with a few characters of the session's id so two children
 * on the same job never collide. `centralu/write-the-parser-1a2b`.
 */
export function agentBranch(task: string, id: string, max = 40): string {
  const slug = task
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return `${APP_SLUG}/${slug || 'agent'}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase()}`
}

/** The name a child starts with: its task's first words, like a session the person starts with a message */
export function agentName(task: string, max = 48): string {
  return oneLineText(task, max) || 'Agent'
}
