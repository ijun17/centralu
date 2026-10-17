import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { agentListText, agentRunText } from './tool-answers.js'

/**
 * Finished children left behind (#690): on 2026-10-14 a parent used fourteen children's answers and deleted none until
 * the person said it could. It had the delete all along and forgot the last step; nothing it read named it. What it
 * reads now names the delete where it uses the result, and agent_session list shows what it left.
 */
describe('a parent is told to clean up the children whose answers it used (#690)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(async () => {
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  const session = async () => (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
  const startRunning = async (s: string, task: string) => {
    const r = await w.mgr.startAgent(s, { task, wait: false })
    expect(r).toMatchObject({ ok: true, state: 'working' })
    const id = r.ok ? r.sessionId : ''
    await w.until(() => !!handleOf(id)?.sent.length)
    return id
  }
  /** The report the parent was told about a child, as its conversation keeps it */
  const reportOf = (parent: string, child: string) =>
    w.store
      .loadMessages(parent, 50)
      .filter((m) => m.role === 'user' && (m.payload as { from?: { sessionId: string } }).from?.sessionId === child)
      .map((m) => (m.payload as { text: string }).text)
  const list = async (s: string) => (await w.mgr.runOrchestratorTool(s, 'agent_session', { action: 'list' })).text

  it("a finished child's report names its delete, and how many of the parent's other children are at rest", async () => {
    const s = await session()
    const one = await startRunning(s, 'first job')
    const two = await startRunning(s, 'second job')

    handleOf(one)!.answer('first done')
    await w.until(() => reportOf(s, one).length === 1)
    const first = reportOf(s, one)[0]!
    expect(first).toContain('[Centralu] The assigned work finished.')
    expect(first).toContain(`agent_session(sessionId="${one}", action="delete")`)
    // The other child still works: nothing else is at rest
    expect(first).not.toContain('other finished session')

    handleOf(two)!.answer('second done')
    await w.until(() => reportOf(s, two).length === 1)
    const second = reportOf(s, two)[0]!
    expect(second).toContain(`agent_session(sessionId="${two}", action="delete")`)
    expect(second).toContain('1 other finished session you started remains: agent_session(action="list") shows them.')
  })

  it("list shows the caller's own children with their state, and none of another session's", async () => {
    const s = await session()
    const other = await session()
    const done = await startRunning(s, 'finished job')
    const working = await startRunning(s, 'running job')
    const theirs = await startRunning(other, 'their job')
    handleOf(done)!.answer('done')
    await w.until(() => reportOf(s, done).length === 1)

    const text = await list(s)
    expect(text).toContain('Sessions you started (2, 1 finished):')
    expect(text).toMatch(new RegExp(`\\[${done}\\] · claude · finished`))
    expect(text).toMatch(new RegExp(`\\[${working}\\] · claude · working`))
    expect(text).not.toContain(theirs)
    expect(text).toContain('action="delete"')

    // Deleted, it is gone from the list
    expect(await w.mgr.agentSession(s, { sessionId: done, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted' })
    const after = await list(s)
    expect(after).not.toContain(done)
    expect(after).toContain('Sessions you started (1, 0 finished):')
    expect(after).toContain('None is finished yet.')
  })

  it('list says so when nothing is left, and needs no sessionId', async () => {
    const s = await session()
    expect(await list(s)).toBe('No session start_agent started from here is left.')
  })

  it("a report on a session the receiver did not start names no delete (send_to_session's)", async () => {
    const other = await session()
    const c = await startRunning(other, 'their job')
    handleOf(c)!.answer('their job done')
    await w.until(() => reportOf(other, c).length === 1)
    expect(reportOf(other, c)[0]).toContain('action="delete"')
    // The orchestrator gives the same child more work with a report: that report is of a session it did not start
    const directing = await w.mgr.createSession({ projectId: null, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal', kind: 'orchestrator' })
    await handleOf(directing.id)!.opts.orchestratorTools!.sendToSession(c, 'one more thing', true)
    await w.until(() => handleOf(c)!.sent.length === 2)
    handleOf(c)!.answer('one more thing done')
    await w.until(() => reportOf(directing.id, c).length === 1)
    const told = reportOf(directing.id, c)[0]!
    expect(told).toContain('[Centralu] The assigned work finished.')
    expect(told).not.toContain('action="delete"')
  })
})

describe('the answers that hand a child back (#690)', () => {
  const base = { ok: true as const, sessionId: 'c1', sessionName: 'job', tool: 'claude' }
  it('done and at_rest end with the delete; working, stopped and deleted do not', () => {
    const del = 'agent_session(sessionId="c1", action="delete")'
    expect(agentRunText({ ...base, state: 'done', answer: 'x', readable: [], outside: [] }).text).toContain(del)
    expect(agentRunText({ ...base, state: 'at_rest', answer: 'x', sessionState: 'idle' }).text).toContain(del)
    expect(agentRunText({ ...base, state: 'working', reported: true }).text).not.toContain(del)
    expect(agentRunText({ ...base, state: 'stopped' }).text).not.toContain(del)
    expect(agentRunText({ ...base, state: 'deleted' }).text).not.toContain(del)
  })

  it("list names an unmerged worktree branch as work a delete keeps in the trash, and a sleeping child as asleep", () => {
    const text = agentListText([
      { sessionId: 'a', name: 'wt job', tool: 'codex', state: 'finished', asleep: true, worktree: { branch: 'agent/wt', unmerged: true } },
      { sessionId: 'b', name: 'merged job', tool: 'claude', state: 'finished', asleep: false, worktree: { branch: 'agent/m', unmerged: false } },
    ]).text
    expect(text).toContain('[a] · codex · finished (asleep) · worktree branch agent/wt, not merged: a delete keeps its work in the trash')
    expect(text).toContain('[b] · claude · finished · worktree branch agent/m, merged')
  })
})
