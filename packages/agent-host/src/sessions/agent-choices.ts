import { randomUUID } from 'node:crypto'
import type { ModelOption } from '@cc/protocol'
import type { StartAgentOpts } from '../adapters/contract.js'
import { gitSummary } from '../dev-services/git.js'
import { gitValidBranchName } from '../dev-services/git-worktree.js'
import type { DelegationHost } from './delegation-host.js'
import { agentBranch } from './start-agent.js'
import { START_AGENT_MODEL_CHECK_MS } from './start-agent-terms.js'

/**
 * What a started agent is made with, checked before it starts (#561, #660): the worktree branch it gets, and a model
 * or effort the caller named, against what its tool offers. Moved out of `AgentStartFlow` as it was (#428); what it
 * reaches of the manager is `DelegationHost`.
 */
export class AgentChoices {
  constructor(private readonly host: DelegationHost) {}

  /**
   * The branch a child's new worktree goes on (#561 part 2): the one asked for, checked by git's own rule, or one
   * named from the job (`agentBranch`). Refused before the card when the project is no git repository, so the person
   * is never asked about a worktree that cannot be made.
   */
  async agentWorktreeBranch(project: { id: string; path: string }, opts: StartAgentOpts, basis = opts.task): Promise<{ branch: string } | { error: string }> {
    const summary = await gitSummary(project.path, this.host.gitTrust(project.id))
    if (!summary.isRepo) return { error: 'This project is not a git repository, so it has no worktrees. Start the agent without one.' }
    const asked = opts.branch?.trim()
    if (asked) return (await gitValidBranchName(asked)) ? { branch: asked } : { error: `Not a valid branch name: ${asked}` }
    return { branch: agentBranch(basis, randomUUID()) }
  }

  /**
   * A model or effort the caller named that the tool does not offer, as a refusal listing what it does (#561), so a
   * wrong name costs one call rather than a child whose first turn fails. Lenient where the list is: a name the
   * list's ids or labels contain (an alias such as "sonnet") passes, and a tool that cannot list its models passes all.
   */
  async agentChoiceError(
    tool: string,
    askedModel: string | undefined,
    askedEffort: string | undefined,
    model: string | undefined,
    /** What to do if the first turn fails on a name that could not be checked; the caller's own names can be left out */
    remedy = 'start again without it',
  ): Promise<{ error: string | null; on?: 'model' | 'effort'; unchecked?: string }> {
    if (!askedModel && !askedEffort) return { error: null }
    /*
     * **A bounded wait on a cached list (#660).** The check helps a caller that misspelled a model; it must never
     * hold the call, so with no list in time the child starts on the name as given, and the answer says it was not
     * checked. A tool that cannot list its models passes silently, as it always did.
     */
    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listModels) return { error: null }
    const what = [askedModel && `model "${askedModel}"`, askedEffort && `effort "${askedEffort}"`].filter(Boolean).join(' and ')
    const notChecked = (why: string) => ({ error: null, unchecked: `${what} not checked: ${why}. If the session's first turn fails on it, ${remedy}` })
    const mismatch = (models: ModelOption[]): { error: string; on: 'model' | 'effort' } | null => {
      const find = (name: string) => {
        const n = name.toLowerCase()
        return models.find((m) => m.id.toLowerCase() === n) ?? models.find((m) => m.id.toLowerCase().includes(n) || m.label.toLowerCase().includes(n))
      }
      if (askedModel && !find(askedModel)) return { error: `${tool} has no model "${askedModel}". Its models: ${models.map((m) => m.id).join(', ')}.`, on: 'model' }
      if (askedEffort) {
        const m = model ? find(model) : models[0]
        if (m && m.efforts.length > 0 && !m.efforts.includes(askedEffort)) return { error: `${m.id} has no effort "${askedEffort}". Its efforts: ${m.efforts.join(', ')}.`, on: 'effort' }
      }
      return null
    }
    let got = await this.host.modelsWithin(tool, START_AGENT_MODEL_CHECK_MS)
    if (!got) return notChecked(`${tool}'s model list was not available in time`)
    if (got.models.length === 0) return notChecked(`${tool} listed no models`)
    let wrong = mismatch(got.models)
    if (wrong && got.cached) {
      // The CLI may have been updated since the list was read: a refusal waits on a fresh one
      got = await this.host.modelsWithin(tool, START_AGENT_MODEL_CHECK_MS, true)
      if (!got) return notChecked(`${tool}'s saved model list lacks it and a new one was not available in time`)
      if (got.models.length === 0) return notChecked(`${tool} listed no models`)
      wrong = mismatch(got.models)
    }
    return wrong ?? { error: null }
  }
}
