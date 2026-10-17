import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { orchestratorChildren } from './OrchestratorButton.jsx'

// #853: the orchestrator's children have no project to hang in, so they hang under its row
describe("the orchestrator's children in the sidebar", () => {
  const row = (id: string, over: Partial<SessionSummary> = {}) => ({ id, kind: 'worker', projectId: null, appId: null, askedBy: null, ...over }) as SessionSummary
  const sessions = Object.fromEntries(
    [
      row('orc', { kind: 'orchestrator' }),
      row('child', { askedBy: 'orc' }),
      row('in-project', { askedBy: 'orc', projectId: 'p1' }),
      row('app-agent', { askedBy: 'orc', appId: 'notes' }),
      row('elsewhere', { askedBy: 'orc', machine: 'm1' }),
      row('stray'),
      row('someone', { projectId: 'p1' }),
      row('other-child', { askedBy: 'someone' }),
    ].map((s) => [s.id, s]),
  )

  const ids = (r: { current: SessionSummary[]; earlier: SessionSummary[] }) => ({ current: r.current.map((s) => s.id), earlier: r.earlier.map((s) => s.id) })

  it('are the sessions with no project and no app the orchestrator started on this machine', () => {
    expect(ids(orchestratorChildren(sessions, null))).toEqual({ current: ['child'], earlier: [] })
    expect(ids(orchestratorChildren(sessions, 'orc'))).toEqual({ current: ['child'], earlier: [] })
  })

  it('are found by the id the store holds when the listed row is not there yet', () => {
    const { orc: _, ...without } = sessions
    expect(ids(orchestratorChildren(without, 'orc'))).toEqual({ current: ['child'], earlier: [] })
  })

  // #994 review: a child whose orchestrator was replaced had no row at all
  it('keep a row for a child whose orchestrator is gone, among the earlier ones', () => {
    const { orc: _, ...without } = sessions
    const withNew = { ...without, orc2: row('orc2', { kind: 'orchestrator' }) }
    expect(ids(orchestratorChildren(withNew, 'orc2'))).toEqual({ current: [], earlier: ['child'] })
    // A child of a session still here is that session's, not an earlier orchestrator's
    expect(orchestratorChildren(withNew, 'orc2').earlier.map((s) => s.id)).not.toContain('other-child')
  })
})
