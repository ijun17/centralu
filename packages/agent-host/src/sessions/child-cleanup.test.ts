import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import type { SessionInfo } from '@cc/protocol'
import { agentListText, agentRunText } from './tool-answers.js'
import { runOrchestratorTool } from './orchestrator-tools.js'
import { agentState, cleanUpDue, ownAgents, type OwnAgentsHost } from './own-agents.js'

/**
 * Finished children left behind (#690): on 2026-10-14 a parent used fourteen children's answers and deleted none until
 * the person said it could. It had the delete all along and forgot the last step; nothing it read named it. What it
 * reads now names the delete where it uses the result, and agent_session list shows what it left.
 */
describe('a parent is told to clean up the children whose answers it used (#690)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
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
      .messages.loadMessages(parent, 50)
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
    // And when to keep it instead (#1482)
    expect(first).toContain('Keep it only if more work on the same thing is coming soon')
    // The other child still works: nothing else is at rest
    expect(first).not.toContain('other finished session')

    handleOf(two)!.answer('second done')
    await w.until(() => reportOf(s, two).length === 1)
    const second = reportOf(s, two)[0]!
    expect(second).toContain(`agent_session(sessionId="${two}", action="delete")`)
    expect(second).toContain('1 other finished session you started remains: agent_session(action="list") shows them.')
  })

  it("an orchestrator's report names the delete and the list as it calls them: through centralu_run (#850)", async () => {
    const orch = (await w.mgr.createSession({ projectId: null, cwd: w.caller.path, tool: 'claude', permissionPreset: 'auto', kind: 'orchestrator' })).id
    const one = await startRunning(orch, 'first job')
    const two = await startRunning(orch, 'second job')
    handleOf(one)!.answer('first done')
    await w.until(() => reportOf(orch, one).length === 1)
    handleOf(two)!.answer('second done')
    await w.until(() => reportOf(orch, two).length === 1)
    const told = reportOf(orch, two)[0]!
    // The bare agent_session(...) is refused there as "Not a tool of this session"
    expect(told).not.toContain('agent_session(')
    expect(told).toContain(`Archive it once its answer is used: centralu_run(command="agent_session", args={sessionId: "${two}", action: "delete"}).`)
    expect(told).toContain('remains: centralu_run(command="agent_session", args={action: "list"}) shows them.')
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

  it("status under auto names the delete only on the caller's own child, never on the person's session or its own", async () => {
    const s = await session()
    const mine = await startRunning(s, 'my job')
    handleOf(mine)!.answer('done')
    await w.until(() => reportOf(s, mine).length === 1)
    const persons = await session()
    await w.mgr.updateSettings(s, { permissionPreset: 'auto' })
    const del = (id: string) => `agent_session(sessionId="${id}", action="delete")`
    expect(agentRunText(await w.mgr.agentSession(s, { sessionId: mine, action: 'status' })).text).toContain(del(mine))
    const other = agentRunText(await w.mgr.agentSession(s, { sessionId: persons, action: 'status' }))
    expect(other.text).toContain('is not working on anything')
    expect(other.text).not.toContain('action="delete"')
    expect(agentRunText(await w.mgr.agentSession(s, { sessionId: s, action: 'status' })).text).not.toContain('action="delete"')
  })

  it('list keeps answering after an older window sent the session tools off: they are always on (2026-10-20)', async () => {
    const s = await session()
    await startRunning(s, 'a job')
    const tools = handleOf(s)!.opts.orchestratorTools!
    w.mgr.setUiPreferences({ sessionTools: false })
    const r = await runOrchestratorTool(tools, 'agent_session', { action: 'list' }, { sessionId: s, profile: 'reader' })
    expect(r.isError).toBeFalsy()
    expect(r.text).not.toContain('Turned off in Settings')
  })
})

describe('the answers that hand a child back (#690)', () => {
  const base = { ok: true as const, sessionId: 'c1', sessionName: 'job', tool: 'claude' }
  it('done and at_rest end with the delete only when it is due; working, stopped and deleted never', () => {
    const del = 'agent_session(sessionId="c1", action="delete")'
    expect(agentRunText({ ...base, state: 'done', answer: 'x', readable: [], outside: [], cleanUp: true }).text).toContain(del)
    // The wait/status/start_agent answer says when to keep the child instead (#1482)
    expect(agentRunText({ ...base, state: 'done', answer: 'x', readable: [], outside: [], cleanUp: true }).text).toContain('Keep it only if more work on the same thing is coming soon')
    expect(agentRunText({ ...base, state: 'done', answer: 'x', readable: [], outside: [] }).text).not.toContain('Keep it only if')
    expect(agentRunText({ ...base, state: 'at_rest', answer: 'x', sessionState: 'idle', cleanUp: true }).text).toContain(del)
    expect(agentRunText({ ...base, state: 'done', answer: 'x', readable: [], outside: [] }).text).not.toContain(del)
    expect(agentRunText({ ...base, state: 'at_rest', answer: 'x', sessionState: 'idle' }).text).not.toContain(del)
    expect(agentRunText({ ...base, state: 'working', reported: true }).text).not.toContain(del)
    expect(agentRunText({ ...base, state: 'stopped' }).text).not.toContain(del)
    expect(agentRunText({ ...base, state: 'deleted' }).text).not.toContain(del)
  })

  it('is due only for its own child whose work is over: not cut short, limited, failed, or owing a report', () => {
    const child = (over: Partial<SessionInfo> = {}) => ({ id: 'c', askedBy: 'p', state: 'idle', interruption: null, ...over }) as unknown as SessionInfo
    expect(cleanUpDue(child(), 'p')).toBe(true)
    expect(cleanUpDue(child(), 'someone else')).toBe(false)
    expect(cleanUpDue(child({ askedBy: null }), 'p')).toBe(false)
    expect(cleanUpDue(child({ interruption: { reason: 'network' } as SessionInfo['interruption'] }), 'p')).toBe(false)
    expect(cleanUpDue(child({ state: 'error' }), 'p')).toBe(false)
    expect(cleanUpDue(child({ state: 'limited' }), 'p')).toBe(false)
    expect(cleanUpDue(child(), 'p', 'Its own background work is still running')).toBe(false)
  })

  it("list names an unmerged worktree branch as work a delete keeps in the session archive, and a sleeping child as asleep", () => {
    const text = agentListText({ ok: true, agents: [
      { sessionId: 'a', name: 'wt job', tool: 'codex', state: 'finished', asleep: true, worktree: { branch: 'agent/wt', unmerged: true } },
      { sessionId: 'b', name: 'merged job', tool: 'claude', state: 'finished', asleep: false, worktree: { branch: 'agent/m', unmerged: false } },
    ] }).text
    expect(text).toContain('[a] · codex · finished (asleep) · worktree branch agent/wt, not merged: a delete keeps its work in the session archive')
    expect(text).toContain('[b] · claude · finished · worktree branch agent/m, merged')
  })
})

describe("whose agents list shows, and where each stands (#690 review)", () => {
  const info = (id: string, over: Partial<SessionInfo> = {}) =>
    ({ id, projectId: 'p1', askedBy: 'parent', parentSessionId: null, state: 'idle', interruption: null, pendingApproval: null, pendingQuestions: [], createdAt: 1, ...over }) as unknown as SessionInfo
  const hostWith = (sessions: SessionInfo[], opts: { trashing?: string[]; running?: string[] } = {}): OwnAgentsHost =>
    ({
      meta: new Map(sessions.map((s) => [s.id, s])),
      trashing: new Map((opts.trashing ?? []).map((id) => [id, Promise.resolve()])),
      children: { delegations: new Map((opts.running ?? []).map((id) => [`parent>${id}`, { sessionId: id, settled: false }])) },
    }) as unknown as OwnAgentsHost

  it("takes the caller's own children in its project, oldest first; not another project's, one being trashed, or a parentSessionId-only link", () => {
    const host = hostWith(
      [
        info('parent', { askedBy: null }),
        info('late', { createdAt: 3 }),
        info('early', { createdAt: 2 }),
        info('elsewhere', { projectId: 'p2' }),
        info('leaving'),
        info('legacy', { askedBy: null, parentSessionId: 'parent' }),
        info('theirs', { askedBy: 'sibling' }),
      ],
      { trashing: ['leaving'] },
    )
    expect(ownAgents(host, 'parent').map((s) => s.id)).toEqual(['early', 'late'])
  })

  it('a delegation still running reads as working, a stopped turn as stopped, a card as waiting', () => {
    const host = hostWith([info('parent', { askedBy: null })], { running: ['busy'] })
    expect(agentState(host, info('busy'))).toBe('working')
    expect(agentState(host, info('idle'))).toBe('finished')
    expect(agentState(host, info('cut', { interruption: { reason: 'network' } as SessionInfo['interruption'] }))).toBe('stopped')
    expect(agentState(host, info('limited', { state: 'limited' }))).toBe('stopped')
    expect(agentState(host, info('asks', { pendingQuestions: [{}] as unknown as SessionInfo['pendingQuestions'] }))).toBe('waiting')
  })
})
