import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { ASK_WAIT_MS } from './ask-project.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { AGENT_CEILING, presetWithin } from './start-agent.js'

/**
 * start_agent and agent_session (#561): an ordinary session starts another agent in its own project — behind the
 * person's consent, never with more permissions than its own, one level deep, a few at a time — and works only with
 * the children it started.
 */

describe('the preset rule', () => {
  it('a child may have the parent\'s preset or less, never more', () => {
    const order: PermissionPreset[] = ['safe', 'normal', 'auto']
    for (const [i, parent] of order.entries()) {
      for (const [j, child] of order.entries()) expect(presetWithin(child, parent)).toBe(j <= i)
    }
  })
})

describe('starting another agent in the same project', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  const childrenOf = (id: string) => w.mgr.listSessions().filter((s) => s.askedBy === id)
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  const agentCard = (id: string) => {
    const p = w.mgr.listSessions().find((s) => s.id === id)?.pendingApproval
    return p?.detail.kind === 'agent_start' ? p : undefined
  }
  const allowProject = () => w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  /** Starts a child that keeps running, and returns its id */
  const startRunning = async (s: string, task = 'write it') => {
    const before = childrenOf(s).length
    const r = await w.mgr.startAgent(s, { task, wait: false })
    expect(r).toMatchObject({ ok: true, state: 'working' })
    await w.until(() => childrenOf(s).length === before + 1)
    return r.ok ? r.sessionId : ''
  }

  it('asks the person first; denied, nothing is started and the model reads a refusal', async () => {
    const s = await session()
    const p = w.mgr.startAgent(s, { task: 'implement the parser', tool: 'codex' })
    await w.until(() => !!agentCard(s))
    expect(agentCard(s)!.detail).toMatchObject({ kind: 'agent_start', project: { id: w.caller.id }, tool: 'Codex', preset: 'normal', text: 'implement the parser' })
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'deny')
    const r = await p
    expect(!r.ok && r.error).toContain('did not allow')
    expect(childrenOf(s)).toEqual([])
  })

  it('opens a visible child in the same folder on the tool asked for, framed and recorded as sent by the parent, and returns its answer', async () => {
    const s = await session()
    const p = w.mgr.startAgent(s, { task: 'implement the parser', tool: 'codex' })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
    await w.until(() => childrenOf(s).length === 1 && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
    const c = childrenOf(s)[0]!
    expect([c.projectId, c.tool, c.name]).toEqual([w.caller.id, 'codex', 'implement the parser'])
    const h = handleOf(c.id)!
    expect(h.opts.cwd).toBe(w.caller.path)
    expect(h.sent[0]).toContain("through Centralu's start_agent")
    expect(h.sent[0]).toContain('implement the parser')
    const sent = w.store.loadMessages(c.id, 10).find((m) => m.role === 'user')
    expect((sent?.payload as { from?: { sessionId: string } }).from?.sessionId).toBe(s)
    h.answer('Parser done.')
    expect(await p).toMatchObject({ ok: true, state: 'done', sessionId: c.id, tool: 'codex', answer: 'Parser done.' })
  })

  it('"always for this session" stops asking that session only; "always for this project" every session there, until revoked', async () => {
    const s = await session()
    const first = w.mgr.startAgent(s, { task: 'one', wait: false })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'always', 'session')
    expect(await first).toMatchObject({ ok: true })
    expect(await w.mgr.startAgent(s, { task: 'two', wait: false })).toMatchObject({ ok: true })
    expect(agentCard(s)).toBeUndefined()

    const other = await session()
    const third = w.mgr.startAgent(other, { task: 'three', wait: false })
    await w.until(() => !!agentCard(other))
    w.mgr.respondApproval(other, agentCard(other)!.requestId, 'always', 'project')
    expect(await third).toMatchObject({ ok: true })
    expect(w.mgr.projectConsents()).toEqual([expect.objectContaining({ fromProjectId: w.caller.id, toProjectId: w.caller.id, kind: 'agents' })])
    const fresh = await session()
    expect(await w.mgr.startAgent(fresh, { task: 'four', wait: false })).toMatchObject({ ok: true })

    // Four children run now, the ceiling: two of them finish, so the next start reaches the card
    for (const c of [...childrenOf(s), ...childrenOf(other)]) handleOf(c.id)!.answer('done')
    await new Promise((r) => setTimeout(r, 0))
    w.mgr.revokeProjectConsent(w.caller.id, w.caller.id, 'agents')
    const fifth = w.mgr.startAgent(fresh, { task: 'five', wait: false })
    await w.until(() => !!agentCard(fresh))
    w.mgr.respondApproval(fresh, agentCard(fresh)!.requestId, 'deny')
    expect((await fifth).ok).toBe(false)
  })

  it('the child gets the parent\'s preset, whatever it is, and the parent cannot use a child the person later raised above it', async () => {
    allowProject()
    for (const preset of ['safe', 'normal', 'auto'] as const) {
      const s = await session(preset)
      const c = await startRunning(s)
      expect(w.mgr.listSessions().find((x) => x.id === c)?.permissionPreset).toBe(preset)
      expect(handleOf(c)!.opts.permissionPreset).toBe(preset)
    }
    const s = await session('normal')
    const p = w.mgr.startAgent(s, { task: 'first' })
    await w.until(() => !!childrenOf(s)[0] && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
    const c = childrenOf(s)[0]!.id
    handleOf(c)!.answer('ok')
    await p
    await w.mgr.updateSettings(c, { permissionPreset: 'auto' })
    const r = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'now delete the build folder' })
    expect(!r.ok && r.error).toContain('more permissions (auto) than this session (normal)')
    expect(handleOf(c)?.sent ?? []).toHaveLength(1)
  })

  it('depth one: a child cannot start agents or ask another project', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const r = await w.mgr.startAgent(c, { task: 'and another', wait: false })
    expect(!r.ok && r.error).toContain('cannot start agents')
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const q = await w.mgr.askProject(c, { project: w.target.name, task: 'x' })
    expect(!q.ok && q.error).toContain('cannot ask a project')
    expect(childrenOf(c)).toEqual([])
  })

  it('a session acts only on the children it started', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const other = await session()
    for (const action of ['status', 'wait', 'stop', 'send'] as const) {
      const r = await w.mgr.agentSession(other, { sessionId: c, action, text: 'x' })
      expect(!r.ok && r.error).toContain('is not a session this session started')
    }
    // Nor on a session the person opened, even in the same project
    const r = await w.mgr.agentSession(s, { sessionId: other, action: 'stop' })
    expect(!r.ok && r.error).toContain('is not a session this session started')
    expect(handleOf(c)!.interrupted).toBe(0)
  })

  it(`at most ${AGENT_CEILING} children run at once in a project, counted over all its sessions; a finished one frees a place`, async () => {
    allowProject()
    const a = await session()
    const b = await session()
    const ids: string[] = []
    for (let i = 0; i < AGENT_CEILING; i++) ids.push(await startRunning(i % 2 ? a : b, `task ${i}`))
    const over = await w.mgr.startAgent(a, { task: 'one too many', wait: false })
    expect(!over.ok && over.error).toContain('already working')
    expect(childrenOf(a).length + childrenOf(b).length).toBe(AGENT_CEILING)
    handleOf(ids[0]!)!.answer('done')
    await w.until(() => w.mgr.listSessions().find((x) => x.id === ids[0])?.state === 'waiting_input')
    // The wait settles a few microtasks after the turn's last event
    await new Promise((r) => setTimeout(r, 0))
    expect(await w.mgr.startAgent(a, { task: 'now there is room', wait: false })).toMatchObject({ ok: true })
  })

  it('past the bound it answers "working", tells the parent when the turn ends, and a later wait reads the answer', async () => {
    allowProject()
    const s = await session()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = w.mgr.startAgent(s, { task: 'long job' })
    for (let i = 0; i < 50 && !childrenOf(s)[0]; i++) await vi.advanceTimersByTimeAsync(0)
    const c = childrenOf(s)[0]!.id
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await first).toMatchObject({ ok: true, state: 'working', sessionId: c, reported: true })
    // More work while it runs is refused, naming the way to wait
    const busy = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'also this' })
    expect(!busy.ok && busy.error).toContain('still working')
    vi.useRealTimers()
    handleOf(c)!.answer('long job done')
    // The parent hears about it through the report path, as another session's message
    await w.until(() => (handleOf(s)?.sent ?? []).some((t) => t.includes(`sourceSessionId: ${c}`)))
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, state: 'done', answer: 'long job done' })
  })

  it('a wait in progress takes the answer, with no report on top of it', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await new Promise((r) => setTimeout(r, 10))
    handleOf(c)!.answer('done')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'done' })
    await new Promise((r) => setTimeout(r, 20))
    expect((handleOf(s)?.sent ?? []).some((t) => t.includes('sourceSessionId'))).toBe(false)
  })

  it('stop ends the turn the parent gave; Stop on the parent stops a child it waits on, not one left running', async () => {
    allowProject()
    const s = await session()
    const left = await startRunning(s, 'left running')
    const stopped = await w.mgr.agentSession(s, { sessionId: left, action: 'stop' })
    expect(stopped).toMatchObject({ ok: true, state: 'stopped' })
    expect(handleOf(left)!.interrupted).toBe(1)
    expect((await w.mgr.agentSession(s, { sessionId: left, action: 'stop' })).ok).toBe(false)

    const background = await startRunning(s, 'background')
    const waited = w.mgr.startAgent(s, { task: 'waited on' })
    await w.until(() => childrenOf(s).length === 3 && !!handleOf(childrenOf(s).find((x) => x.name === 'waited on')!.id)?.sent.length)
    const waitedId = childrenOf(s).find((x) => x.name === 'waited on')!.id
    w.mgr.interrupt(s)
    const r = await waited
    expect(!r.ok && r.error).toContain('the person stopped the session that asked')
    expect(handleOf(waitedId)!.interrupted).toBe(1)
    expect(handleOf(background)!.interrupted).toBe(0)
  })

  it('the parent deleted, the child keeps its turn and its link', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    await w.mgr.trashSession(s)
    expect(handleOf(c)!.interrupted).toBe(0)
    expect(w.mgr.listSessions().find((x) => x.id === c)?.askedBy).toBe(s)
  })

  it('a session of an untrusted project cannot start agents: no card, nothing started', async () => {
    w.mgr.setProjectTrusted(w.caller.id, false)
    const s = await session()
    const r = await w.mgr.startAgent(s, { task: 'x' })
    expect(!r.ok && r.error).toContain('not trusted')
    expect(agentCard(s)).toBeUndefined()
    expect(childrenOf(s)).toEqual([])
  })
})
