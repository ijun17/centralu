import { describe, expect, it } from 'vitest'
import { OrchestratorProposals } from './orchestrator-proposals.js'

/** The three lists in app_settings, as another build or a hand edit may have left them (#384) */
function withRows(rows: Record<string, string>) {
  const store = {
    appSetting: (k: string) => rows[k] ?? null,
    setAppSetting: (k: string, v: string) => void (rows[k] = v),
    deleteAppSetting: (k: string) => void delete rows[k],
  }
  return { proposals: new OrchestratorProposals(store, () => undefined), rows }
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
