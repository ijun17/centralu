import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CreateSessionOpts, EventSink } from '../adapters/contract.js'
import { CrossHandle, crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * A start_agent request stopped while its child is being made (#839, item 8). Once the person allows it, the request
 * stays open until the child exists; `agent_session` stop on the request's handle in that window answered "stopped",
 * and the child was made and given the task all the same.
 */
describe('a start request withdrawn while its child is made (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const childrenOf = (id: string) => w.mgr.listSessions().filter((s) => s.askedBy === id)
  const agentCard = (id: string) => {
    const p = w.mgr.listSessions().find((s) => s.id === id)?.pendingApproval
    return p?.detail.kind === 'agent_start' ? p : undefined
  }

  it('gives the child no task, and the call reads that it was withdrawn', async () => {
    const s = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'safe' })).id
    const call = w.mgr.startAgent(s, { task: 'write the parser' })
    await w.until(() => !!agentCard(s))
    const requestId = agentCard(s)!.requestId
    // The child's process comes up only when the test lets it
    const adapter = w.adapters.get('claude')!
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let starting = false
    adapter.createSession = async (opts: CreateSessionOpts, emit: EventSink) => {
      starting = true
      await gate
      const h = new CrossHandle(opts.sessionId, opts, emit)
      adapter.handles.set(opts.sessionId, h)
      return h
    }
    w.mgr.respondApproval(s, requestId, 'allow')
    await w.until(() => starting)
    expect(await w.mgr.agentSession(s, { sessionId: requestId, action: 'stop' })).toMatchObject({ ok: true, state: 'stopped' })
    release()
    let settled = false
    void call.then(() => (settled = true))
    const made = () => [...adapter.handles.values()].find((h) => h.sessionId !== s)
    // The call answers, or the task went in
    await w.until(() => settled || !!made()?.sent.length)
    expect(made()!.sent).toEqual([])
    const r = await call
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('withdrawn')
    expect(childrenOf(s)).toEqual([])
  })
})
