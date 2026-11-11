import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import type { SessionInfo } from '@cc/protocol'
import { agentListText, agentRunText } from './tool-answers.js'
import { runCentraluTool } from './centralu-tools.js'
import { agentState, cleanUpDue, ownAgents, type OwnAgentsHost } from './own-agents.js'
import type { HostMail } from '../mail/host-mail.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'

/**
 * Finished children left behind (#690): on 2026-10-14 a parent used fourteen children's answers and deleted none until
 * the person said it could. It had the delete all along and forgot the last step; nothing it read named it. What it
 * reads now names the delete where it uses the result, and agent_session list shows what it left.
 */
describe('a parent is told to clean up the children whose answers it used (#690)', () => {
  let w: CrossWorld
  let m: HostMail
  beforeEach(async () => {
    w = await crossWorld()
    m = wireHostMail(w.mgr, w.store)
    m.delivery.start()
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(async () => {
    m.delivery.stop()
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
  /** Centralu's reports to the parent on a child's work, as the mailbox keeps them (docs/plans/mailbox.md §10.6.3) */
  const reportOf = (parent: string, child: string) =>
    mailReader(w.store)
      .between('centralu', addressOf(parent), 'report')
      .filter((r) => r.facts.about?.session === addressOf(child))
      .map((r) => r.body)
  const list = async (s: string) => (await w.mgr.runCentraluTool(s, 'agent_session', { action: 'list' })).text

  it("a finished child's report names its delete, and how many of the parent's other children are at rest", async () => {
    const s = await session()
    const one = await startRunning(s, 'first job')
    const two = await startRunning(s, 'second job')

    handleOf(one)!.answer('first done')
    await w.until(() => reportOf(s, one).length === 1)
    const first = reportOf(s, one)[0]!
    expect(first).toContain('[Centralu] The session ended its turn.')
    expect(first).toContain(`agent_session(sessionId="${one}", action="delete")`)
    // And when to keep it instead (#1482)
    expect(first).toContain('Keep it only if more work on the same thing is coming soon')
    // The other child still works: nothing else is at rest
    expect(first).not.toContain('other session you started')

    handleOf(two)!.answer('second done')
    await w.until(() => reportOf(s, two).length === 1)
    const second = reportOf(s, two)[0]!
    expect(second).toContain(`agent_session(sessionId="${two}", action="delete")`)
    expect(second).toContain('1 other session you started has ended its turn and remains: agent_session(action="list") shows them.')
  })

  it("names several other children at rest in the plural", async () => {
    const s = await session()
    const [a, b, c] = [await startRunning(s, 'job a'), await startRunning(s, 'job b'), await startRunning(s, 'job c')]
    for (const [child, text] of [[a, 'a done'], [b, 'b done'], [c, 'c done']] as const) {
      handleOf(child)?.answer(text)
      await w.until(() => reportOf(s, child).length === 1)
    }
    expect(reportOf(s, c)[0]).toContain('2 other sessions you started have ended their turns and remain: agent_session(action="list") shows them.')
  })

  it("an Assistant's report names the delete and the list as it calls them: through centralu_run (#850)", async () => {
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

  it('delete refuses a child at rest in its turn whose own background work runs, and takes it once that work ended (#2158)', async () => {
    const s = await session()
    const child = await startRunning(s, 'job')
    handleOf(child)!.answer('done')
    await w.until(() => reportOf(s, child).length === 1)
    const meta = (w.mgr as unknown as { meta: Map<string, { backgroundTasks: object[] }> }).meta.get(child)!
    meta.backgroundTasks = [{ id: 'dev', kind: 'shell', description: 'npm run dev', status: 'running' }]
    expect(await w.mgr.agentSession(s, { sessionId: child, action: 'delete' })).toMatchObject({ ok: false, error: expect.stringContaining('and its background work to finish') })
    meta.backgroundTasks = [{ id: 'dev', kind: 'shell', description: 'npm run dev', status: 'completed' }]
    expect(await w.mgr.agentSession(s, { sessionId: child, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted' })
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
    // The Assistant gives the same child more work with a report: that report is of a session it did not start
    const directing = await w.mgr.createSession({ projectId: null, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal', kind: 'orchestrator' })
    await handleOf(directing.id)!.opts.centraluTools!.sendToSession(c, 'one more thing', true)
    await w.until(() => handleOf(c)!.sent.length === 2)
    handleOf(c)!.answer('one more thing done')
    await w.until(() => reportOf(directing.id, c).length === 1)
    const told = reportOf(directing.id, c)[0]!
    expect(told).toContain('[Centralu] The session ended its turn.')
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
    const tools = handleOf(s)!.opts.centraluTools!
    w.mgr.prefs.setUiPreferences({ sessionTools: false })
    const r = await runCentraluTool(tools, 'agent_session', { action: 'list' }, { sessionId: s, profile: 'reader' })
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
    // The state says a card stands even where the card is not carried (#2158): waiting, as a card is
    expect(agentState(host, info('approves', { state: 'waiting_approval' }))).toBe('waiting')
  })

  // #2146 (owner decision 2026-11-09): a turn that ended while its own background work runs is not finished
  it('a turn ended while its own background commands or background subagents run reads as paused, and the list says paused (background work)', () => {
    const host = hostWith([info('parent', { askedBy: null })])
    const task = (kind: 'agent' | 'shell', over = {}) => ({ id: `t-${kind}`, kind, description: kind, status: 'running' as const, ...over })
    const at = (state: string, tasks: object[]) => agentState(host, info('c', { state, backgroundTasks: tasks } as unknown as Partial<SessionInfo>))
    expect(at('waiting_input', [task('agent')])).toBe('paused')
    expect(at('idle', [task('shell')])).toBe('paused')
    // A timer a tool holds (`/loop`) or an ambient task is not work; ended work is not running
    expect(at('waiting_input', [task('shell', { timer: true }), task('agent', { ambient: true })])).toBe('finished')
    expect(at('waiting_input', [task('agent', { status: 'completed' })])).toBe('finished')
    // A turn that hit a limit or was cut short says so
    expect(at('limited', [task('agent')])).toBe('stopped')
    expect(agentState(host, info('cut', { backgroundTasks: [task('agent')], interruption: { reason: 'network' } } as unknown as Partial<SessionInfo>))).toBe('stopped')
    const text = agentListText({ ok: true, agents: [
      { sessionId: 'p', name: 'tests', tool: 'claude', state: 'paused', asleep: false },
      { sessionId: 'f', name: 'done', tool: 'claude', state: 'finished', asleep: false },
    ] }).text
    expect(text).toContain('[p] · claude · paused (background work)')
    expect(text).toContain('Sessions you started (2, 1 finished):')
  })
})
