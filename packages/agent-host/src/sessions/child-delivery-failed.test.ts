import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CreateSessionOpts, EventSink } from '../adapters/contract.js'
import { CrossHandle, crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * Work given to a child that never reaches it (#839, item 12). The delegation is registered before the work goes in,
 * so a wait of the caller's can join it while the child wakes. When the work then failed to go in, the delegation was
 * dropped but its wait never failed: the joined wait sat until its bound, answered "working", and armed a report that
 * the child's next unrelated turn would answer.
 */
describe('work given to a child that never reaches it (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(async () => {
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!

  it('fails the wait that joined it, with the reason', async () => {
    const s = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    const started = await w.mgr.startAgent(s, { task: 'first job', wait: false })
    if (!started.ok) throw new Error(started.error)
    const c = started.sessionId
    handleOf(c).externalId = 'ext-c'
    handleOf(c).answer('first job done')
    await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    // The child's process goes away; waking it again fails, once the test lets it
    handleOf(c).event({ type: 'error', sessionId: c, error: { code: 'adapter_crashed', message: 'the process exited', retryable: true } })
    const adapter = w.adapters.get('claude')!
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let starting = false
    const start = adapter.createSession.bind(adapter)
    adapter.createSession = async (opts: CreateSessionOpts, emit: EventSink): Promise<CrossHandle> => {
      if (opts.sessionId !== c) return start(opts, emit)
      starting = true
      await gate
      throw new Error('the tool would not start')
    }
    const sent = w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'second job' })
    await w.until(() => starting)
    // While it wakes, the caller waits on the work it just gave
    let waited: Awaited<ReturnType<typeof w.mgr.agentSession>> | undefined
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' }).then((r) => (waited = r))
    release()
    expect(await sent).toMatchObject({ ok: false, error: expect.stringContaining('Could not send it') })
    await w.until(() => waited !== undefined)
    await waiting
    expect(waited).toMatchObject({ ok: false, error: expect.stringContaining('the tool would not start') })
  })
})
