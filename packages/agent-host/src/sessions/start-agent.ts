import { APP_SLUG, frameField, oneLineText, type AgentDifficulty, type AgentModels, type PermissionPreset, type ToolDefaults } from '@cc/protocol'
import { worktreeSetupFrame } from './worktree-sessions.js'

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

/** The presets, lowest first (#1525 put `edits` between `normal` and `auto`) */
const PRESET_RANK: Record<PermissionPreset, number> = { safe: 0, normal: 1, edits: 2, auto: 3 }

/** The lowest of these presets (none: `auto`, the identity) */
export function lowestPreset(...presets: readonly PermissionPreset[]): PermissionPreset {
  return presets.reduce<PermissionPreset>((low, p) => (PRESET_RANK[p] < PRESET_RANK[low] ? p : low), 'auto')
}

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
export function agentFrame(parentName: string, task: string, setupProblems: readonly string[] = [], instructions = ''): string {
  return [
    `[Another session in this project, "${frameField(parentName)}", gives you this task through Centralu's start_agent. ` +
      'Your final message goes back to it as the answer: keep it short, and name the files it should read by their absolute paths. ' +
      // #729: children that backgrounded their verify and ended the turn "waiting for it" left the parent unanswered (#721)
      'Wait for your own background work that ends (a test run, a build) inside your turn before you answer.]',
    // #841 item 3: the agent does not read the session's notices, and met a missing `.env` as a failing command
    ...(setupProblems.length ? ['', worktreeSetupFrame(setupProblems)] : []),
    '',
    task,
    ...projectInstructions(instructions),
  ].join('\n')
}

/**
 * The person's instructions for agents started in the project (#1161 item 2, `ProjectInfo.agentInstructions`), after
 * the task: the rules every brief repeated (worktrees, stacking, what never to run), set once in the project's
 * settings. Said to be the person's, from the project's settings on the computer the child runs on, so the child tells
 * them apart from the parent's task. Nothing when none are set.
 */
export function projectInstructions(text: string): string[] {
  const t = text.trim()
  return t ? ['', "[The person's standing instructions for agents started in this project, from the project's settings on this computer:]", '', t] : []
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

/**
 * The task of a child started on a linked machine (#1038): as `agentFrame`, said as from a session of the same
 * repository on another computer, whose name the link already gives as "<name> on <hub>"
 */
export function remoteAgentFrame(parentName: string, task: string, instructions = ''): string {
  return [
    `[A session working on this repository on another computer, "${frameField(parentName)}", gives you this task through Centralu's start_agent. ` +
      "Your final message goes back to it as the answer: keep it short. It cannot read this computer's files, so put what it needs in the answer itself, and commit and push what it should get. " +
      'Wait for your own background work that ends (a test run, a build) inside your turn before you answer.]',
    '',
    task,
    // The machine's own copy of the project's instructions: its paths and its shell, not the parent's (#1161 item 2)
    ...projectInstructions(instructions),
  ].join('\n')
}

/** A follow-up carries the parent's words without replacing the task or promising an independent answer. */
export function agentNoteFrame(parentName: string, text: string): string {
  return `[A note from the parent session "${frameField(parentName)}" through Centralu's agent_session. These are the parent's words about your ongoing work.]\n\n${text}`
}

/**
 * The branch of a child's new worktree when the caller names none (#561 part 2): the job's first words (or the name the
 * caller gave, #861) as a slug under Centralu's prefix, so the branch says what it is for, with a few characters of
 * the session's id so two children on the same job never collide. `centralu/write-the-parser-1a2b`.
 *
 * At most 40 characters after the prefix, the id included, cut at a word (#861): six branches cut at 40 characters of
 * slug read the same in the sidebar, stopping inside the word that told them apart.
 */
export function agentBranch(task: string, id: string, max = 35): string {
  const full = task
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  let slug = full.slice(0, max)
  // Not inside a word, unless the first word is longer than the whole
  if (full.length > max && full[max] !== '-' && slug.includes('-')) slug = slug.slice(0, slug.lastIndexOf('-'))
  slug = slug.replace(/-+$/, '')
  return `${APP_SLUG}/${slug || 'agent'}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase()}`
}

/** The name a child starts with: its task's first words, like a session the person starts with a message */
export function agentName(task: string, max = 48): string {
  return oneLineText(task, max) || 'Agent'
}

/** The words two names are compared by (#861): letters and digits, case and width folded */
function nameWords(text: string): { word: string; at: number }[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ word: m[0].normalize('NFKC').toLowerCase(), at: m.index }))
}

/** A sibling's words as its name carries them: one named by its branch loses Centralu's prefix and its id */
function siblingWords(name: string): string[] {
  const words = nameWords(name).map((w) => w.word)
  return name.startsWith(`${APP_SLUG}/`) ? words.slice(1, -1) : words
}

/**
 * A child's task from the first word that tells it apart from its siblings (#861), for its name and branch. A caller
 * starting several children tends to open every task the same way ("Round 4 refactor of Centralu, area C …"), and
 * names made from the first words then all read alike. The leading words a task shares with a sibling's name (the
 * caller's other children, by the name they carry now) are left out when there are at least two of them and
 * something is left. The task stays whole for the child; only its name and branch skip them.
 */
export function distinguishingText(task: string, siblings: readonly string[]): string {
  const text = oneLineText(task)
  const words = nameWords(text)
  let shared = 0
  for (const name of siblings) {
    const theirs = siblingWords(name)
    let n = 0
    while (n < words.length && n < theirs.length && words[n]!.word === theirs[n]) n++
    shared = Math.max(shared, n)
  }
  if (shared < 2 || shared >= words.length) return text
  return text.slice(words[shared]!.at)
}

/** The short name a caller gave (#861), on one line and at most 40 characters; absent when it gave none */
export function givenAgentName(name: string | undefined): string | undefined {
  const flat = oneLineText(name ?? '')
  return flat ? oneLineText(flat, 40) : undefined
}
