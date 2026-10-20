import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ChildReports, type ChildReportsHost } from './child-reports.js'
import { managerWorld } from './manager.test-helpers.js'

/*
 * A notice a session could not be woken for is kept and goes in with its next message (#1186). One for a session that
 * was deleted goes with it (#1186 review): a restore from the session archive brings the same id back, and the notice with it.
 */
describe('notices kept for a session that could not be woken', () => {
  const world = (deliver: ChildReportsHost['deliver']) => {
    const host = { handingOver: false, disposing: false, meta: new Map([['r', {}]]), deliver } as unknown as ChildReportsHost
    return new ChildReports(host)
  }

  it('are delivered once the session takes a message again', async () => {
    let fail = true
    const deliver = vi.fn(async () => { if (fail) throw new Error('the tool would not start') })
    const reports = world(deliver)
    await reports.tellSession('r', 'note', { sessionId: 'c', name: 'C' }, true)
    fail = false
    reports.deliverHeld('r')
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  })

  it('go with the session when it is deleted', async () => {
    let fail = true
    const deliver = vi.fn(async () => { if (fail) throw new Error('the tool would not start') })
    const reports = world(deliver)
    await reports.tellSession('r', 'note', { sessionId: 'c', name: 'C' }, true)
    reports.forgetHeld('r')
    fail = false
    reports.deliverHeld('r')
    await new Promise((r) => setTimeout(r, 10))
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('are forgotten when the session is archived', async () => {
    const { rpc, mgr } = managerWorld()
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const forget = vi.spyOn((mgr as unknown as { reports: ChildReports }).reports, 'forgetHeld')
    await mgr.trashSession(s.id)
    expect(forget).toHaveBeenCalledWith(s.id)
    await mgr.disposeAll()
  })
})
