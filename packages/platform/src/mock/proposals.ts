import type { AgentPort } from '../ports/index.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** What the Assistant proposes (MCP servers, skills) and the skills approved from it (#71, #703) */
export class ProposalsMock {
  readonly mcpProposalList: { name: string; command: string; args: string[]; why?: string }[] = []
  readonly mcpApproved: string[] = []
  readonly skillProposalList: { name: string; content: string; why?: string }[] = []
  /** As the host (#703): saves, then broadcasts; pushing to the lists directly skips the broadcast */
  saveProposal(spec: { mcp: { name: string; command: string; args: string[]; why?: string } } | { skill: { name: string; content: string; why?: string } }): void {
    if ('mcp' in spec) this.mcpProposalList.push(spec.mcp)
    else this.skillProposalList.push(spec.skill)
    this.emit({ type: 'assistant_proposals_changed' })
  }
  /** Reads of either list (#703) */
  proposalReads = 0
  readonly skillList: { name: string; content: string }[] = []
  readonly agents: Pick<AgentPort, 'mcpProposals' | 'resolveMcpProposal' | 'skillProposals' | 'resolveSkillProposal' | 'assistantSkills' | 'deleteAssistantSkill'> = {
    mcpProposals: async () => {
      this.proposalReads++
      return { proposals: [...this.mcpProposalList] }
    },
    resolveMcpProposal: async (name: string, approve: boolean) => {
      const at = this.mcpProposalList.findIndex((p) => p.name === name)
      if (at === -1) throw mockError(`No pending proposal named "${name}"`)
      const [hit] = this.mcpProposalList.splice(at, 1)
      if (approve && hit) this.mcpApproved.push(hit.name)
      this.emit({ type: 'assistant_proposals_changed' })
    },
    skillProposals: async () => {
      this.proposalReads++
      return { proposals: [...this.skillProposalList] }
    },
    resolveSkillProposal: async (name: string, approve: boolean) => {
      const at = this.skillProposalList.findIndex((p) => p.name === name)
      if (at === -1) throw mockError(`No pending skill proposal named "${name}"`)
      const [hit] = this.skillProposalList.splice(at, 1)
      if (approve && hit) this.skillList.push({ name: hit.name, content: hit.content })
      this.emit({ type: 'assistant_proposals_changed' })
    },
    assistantSkills: async () => ({ skills: [...this.skillList] }),
    deleteAssistantSkill: async (name: string) => {
      const at = this.skillList.findIndex((s) => s.name === name)
      if (at === -1) throw mockError(`No skill named "${name}"`)
      this.skillList.splice(at, 1)
    },
  }

  constructor(
    private readonly emit: Emit,
  ) {}
}
