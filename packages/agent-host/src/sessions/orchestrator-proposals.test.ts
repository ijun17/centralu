import { describe, expect, it } from 'vitest'
import { OrchestratorProposals } from './orchestrator-proposals.js'

/** The three lists in app_settings, as another build or a hand edit may have left them (#384) */
function withRows(rows: Record<string, string>, changed: () => void = () => {}) {
  const store = {
    appSetting: (k: string) => rows[k] ?? null,
    setAppSetting: (k: string, v: string) => void (rows[k] = v),
    deleteAppSetting: (k: string) => void delete rows[k],
  }
  return { proposals: new OrchestratorProposals(store, () => undefined, changed), rows }
}

describe('orchestrator proposals read from a row another build wrote', () => {
  it('a row that is not a list reads as empty, and the next proposal still saves', () => {
    const { proposals, rows } = withRows({
      orchestrator_mcp_proposals: '{"name":"x"}',
      orchestrator_skill_proposals: '"text"',
      orchestrator_skills: '{',
    })
    expect(proposals.mcpProposals()).toEqual([])
    expect(proposals.skillProposals()).toEqual([])
    expect(proposals.orchestratorSkills()).toEqual([])
    expect(proposals.proposeSkill({ name: 'tidy', content: 'Keep it short.' }).ok).toBe(true)
    expect(JSON.parse(rows.orchestrator_skill_proposals!)).toEqual([{ name: 'tidy', content: 'Keep it short.' }])
  })

  it('an element without the fields this build needs is skipped; a newer element keeps its extra fields', () => {
    const newer = { name: 'tidy', content: 'Keep it short.', source: 'team' }
    const { proposals } = withRows({
      orchestrator_skills: JSON.stringify([newer, { name: 'broken' }, null, 'text']),
      orchestrator_mcp_proposals: JSON.stringify([{ name: 'db', command: 'node', args: ['s.js'] }, { name: 'bad', command: 'node', args: [1] }]),
    })
    expect(proposals.orchestratorSkills()).toEqual([newer])
    expect(proposals.mcpProposals().map((p) => p.name)).toEqual(['db'])
  })
})

/**
 * A screen re-reads the lists when told one changed (#703), so the tell must come **after** the write: a read made on it
 * has to return the new list. (The screen used to read on the orchestrator's `tool_call`, which comes before any of this.)
 */
describe('a change to a proposal list is announced after it is saved', () => {
  it('a skill proposal, its answer, an MCP proposal and its dismissal each announce once, with the list already saved', () => {
    const rows: Record<string, string> = {}
    const seen: { skills: string[]; mcp: string[] }[] = []
    const { proposals } = withRows(rows, () => seen.push({ skills: proposals.skillProposals().map((p) => p.name), mcp: proposals.mcpProposals().map((p) => p.name) }))

    expect(proposals.proposeSkill({ name: 'tidy', content: 'Keep it short.' }).ok).toBe(true)
    expect(seen).toEqual([{ skills: ['tidy'], mcp: [] }])

    expect(proposals.proposeMcpServer({ name: 'db', command: 'node', args: ['s.js'] }).ok).toBe(true)
    expect(seen.at(-1)).toEqual({ skills: ['tidy'], mcp: ['db'] })

    expect(proposals.resolveSkillProposal('tidy', false).ok).toBe(true)
    expect(seen.at(-1)).toEqual({ skills: [], mcp: ['db'] })

    expect(proposals.resolveMcpProposal('db', false).ok).toBe(true)
    expect(seen.at(-1)).toEqual({ skills: [], mcp: [] })
    expect(seen).toHaveLength(4)
  })

  it('a refused proposal and an answer to nothing announce nothing', () => {
    let told = 0
    const { proposals } = withRows({}, () => told++)
    expect(proposals.proposeSkill({ name: 'bad name!', content: 'x' }).ok).toBe(false)
    expect(proposals.proposeSkill({ name: 'empty', content: ' ' }).ok).toBe(false)
    expect(proposals.resolveSkillProposal('nothing', true).ok).toBe(false)
    expect(proposals.resolveMcpProposal('nothing', true).ok).toBe(false)
    expect(told).toBe(0)
  })
})
