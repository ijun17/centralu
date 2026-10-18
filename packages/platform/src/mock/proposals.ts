import type { AgentPort } from '../ports/index.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** What the orchestrator proposes (MCP servers, skills) and the skills approved from it (#71, #703) */
export class ProposalsMock {
  /** Proposed MCP servers waiting for approval (filled in by tests) */
  readonly mcpProposalList: { name: string; command: string; args: string[]; why?: string }[] = []
  /** Approved proposal names — the observation point for whether an approval click was actually delivered */
  readonly mcpApproved: string[] = []
  /** Proposed skills waiting for approval (#71 — filled in by tests) */
  readonly skillProposalList: { name: string; content: string; why?: string }[] = []
  /**
   * For tests: what the host does when the orchestrator proposes — saves the proposal, **then** broadcasts that the list
   * changed (#703). Pushing to the lists directly saves without the broadcast, which is the host's order the other way round.
   */
  saveProposal(spec: { mcp: { name: string; command: string; args: string[]; why?: string } } | { skill: { name: string; content: string; why?: string } }): void {
    if ('mcp' in spec) this.mcpProposalList.push(spec.mcp)
    else this.skillProposalList.push(spec.skill)
    this.emit({ type: 'orchestrator_proposals_changed' })
  }
  /** How many times the screen read a proposal list (either) — for tests that say when it reads (#703) */
  proposalReads = 0
  /** Approved skills — the observation point for whether approving/deleting was actually delivered */
  readonly skillList: { name: string; content: string }[] = []
  readonly agents: Pick<AgentPort, 'mcpProposals' | 'resolveMcpProposal' | 'skillProposals' | 'resolveSkillProposal' | 'orchestratorSkills' | 'deleteOrchestratorSkill'> = {
    mcpProposals: async () => {
      this.proposalReads++
      return { proposals: [...this.mcpProposalList] }
    },
    resolveMcpProposal: async (name: string, approve: boolean) => {
      const at = this.mcpProposalList.findIndex((p) => p.name === name)
      if (at === -1) throw mockError(`No pending proposal named "${name}"`)
      const [hit] = this.mcpProposalList.splice(at, 1)
      if (approve) this.mcpApproved.push(hit!.name)
      this.emit({ type: 'orchestrator_proposals_changed' })
    },
    skillProposals: async () => {
      this.proposalReads++
      return { proposals: [...this.skillProposalList] }
    },
    resolveSkillProposal: async (name: string, approve: boolean) => {
      const at = this.skillProposalList.findIndex((p) => p.name === name)
      if (at === -1) throw mockError(`No pending skill proposal named "${name}"`)
      const [hit] = this.skillProposalList.splice(at, 1)
      if (approve) this.skillList.push({ name: hit!.name, content: hit!.content })
      this.emit({ type: 'orchestrator_proposals_changed' })
    },
    orchestratorSkills: async () => ({ skills: [...this.skillList] }),
    deleteOrchestratorSkill: async (name: string) => {
      const at = this.skillList.findIndex((s) => s.name === name)
      if (at === -1) throw mockError(`No skill named "${name}"`)
      this.skillList.splice(at, 1)
    },
  }

  constructor(
    private readonly emit: Emit,
  ) {}
}
